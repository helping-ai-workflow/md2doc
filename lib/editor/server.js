'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { renderMarkdown } = require('../md2doc.js');

const LINEOPS_SRC = fs.readFileSync(path.join(__dirname, 'lineops.js'), 'utf8');
const INLINE_MD_SRC = fs.readFileSync(path.join(__dirname, 'inline-md.js'), 'utf8');
const TABLE_MD_SRC = fs.readFileSync(path.join(__dirname, 'table-md.js'), 'utf8');
// Task 4 (Phase 3): list-md.js's browser factory reads `root.md2docInlineMd`
// directly (same pattern table-md.js uses) — must land after inline-md.js,
// same as table-md.js above. Order relative to table-md.js itself doesn't
// matter (list-md.js never reads window.md2docTableMd), but it's injected
// right after it to keep the two sibling serializers grouped together.
const LIST_MD_SRC = fs.readFileSync(path.join(__dirname, 'list-md.js'), 'utf8');
const HISTORY_SRC = fs.readFileSync(path.join(__dirname, 'history.js'), 'utf8');
// Task 6: spec §3.4's shift-then-clamp, a pure data transform with no
// dependency on any other editor module — order among these is irrelevant, it
// only has to land before client.js reads window.md2docIndentClamp.
const INDENT_CLAMP_SRC = fs.readFileSync(path.join(__dirname, 'indent-clamp.js'), 'utf8');
// S2 spec §3.2/§4.3: the pure marker stripper/emitter behind the 轉換成
// submenu. Same "no dependency on any other editor module" property as
// indent-clamp.js above — it only has to land before client.js reads
// window.md2docConvertMd.
const CONVERT_MD_SRC = fs.readFileSync(path.join(__dirname, 'convert-md.js'), 'utf8');
// v3.2.0: the pure string-diff module behind incremental DOM patching —
// stripBlockId()/patchmap() compare oldParts[i] against newParts[j] with only
// data-block-id normalized (see the global constraint on that). Same "no
// dependency on any other editor module" property as indent-clamp.js and
// convert-md.js above; it only has to land before client.js reads
// window.md2docPatchmap.
const PATCHMAP_SRC = fs.readFileSync(path.join(__dirname, 'patchmap.js'), 'utf8');
// S3 spec §3.3/§3.6/§4.4: the pure block multi-select model — line-range
// normalization, membership, Shift+arrow stepping, the §3.3 grip rule and the
// post-operation collapse. Same "no dependency on any other editor module"
// property as indent-clamp.js and convert-md.js above; it only has to land
// before client.js reads window.md2docSelection.
const SELECTION_SRC = fs.readFileSync(path.join(__dirname, 'selection.js'), 'utf8');
// v3.1.0 Task E: the four Phase-1 modules behind the visible toolbar, the
// paste pipeline, the image-drop asset endpoint and the whole-document
// source escape hatch. Same "pure module, no dependency on any other editor
// module" property as indent-clamp.js / convert-md.js / selection.js above —
// each only has to land before client.js reads its window global.
const TOOLBAR_MODEL_SRC = fs.readFileSync(path.join(__dirname, 'toolbar-model.js'), 'utf8');
const DOCSOURCE_SRC = fs.readFileSync(path.join(__dirname, 'docsource.js'), 'utf8');
const ASSET_SRC = fs.readFileSync(path.join(__dirname, 'asset.js'), 'utf8');
// turndown's BROWSER build. node's `require('turndown')` resolves to
// lib/turndown.cjs.js, which is not loadable as a plain <script> tag — the
// UMD build is, and it defines the global `TurndownService` that
// paste-md.js's getTurndownService() reads at CALL time (not factory time,
// so this tag's position relative to paste-md.js's is not load-bearing;
// it is injected first anyway, to keep the dependency reading left-to-right).
const TURNDOWN_SRC = fs.readFileSync(
  require.resolve('turndown/lib/turndown.browser.umd.js'), 'utf8');
const PASTE_MD_SRC = fs.readFileSync(path.join(__dirname, 'paste-md.js'), 'utf8');

// The SAME pure module the page gets, required here for the node side of
// /api/asset. asset.js is deliberately free of `require('fs')`/`require('path')`
// (it is plain string arithmetic), so every filesystem decision below is made
// here — including the '/'-normalization isWithin's contract demands.
const assetLib = require('./asset.js');

// asset.js's isWithin() is POSIX-only BY CONTRACT (see its own comment): it
// does not understand '\\' as a separator and fails CLOSED on a native-Windows
// path, refusing every legitimate write. Normalizing at this boundary is the
// caller's job, and this is that boundary.
function toPosixPath(p) {
  return String(p === null || p === undefined ? '' : p).split('\\').join('/');
}

function readJson(req, limitBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    // Accumulate raw Buffers and decode ONCE at the end. Per-chunk string
    // concatenation (`buf += chunk`) decodes each chunk independently, so a
    // multi-byte UTF-8 character straddling a TCP chunk boundary becomes
    // U+FFFD — on a multi-MB CJK document that silently corrupts one
    // character per unlucky chunk boundary (seen in the wild: 9 mangled
    // chars in one zero-edit save).
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      chunks.push(c);
      total += c.length;
      if (total > limitBytes) { reject(new Error('payload too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
    });
  });
}

// DNS-rebinding defense. The content-type gate below stops a cross-site
// "simple" POST, but it cannot stop a request the browser believes is
// SAME-origin: a page on evil.com served with a 1-second-TTL A record can
// rebind that name to 127.0.0.1 and then POST to http://evil.com:PORT/... with
// a real application/json body. No preflight fires, the content-type check is
// satisfied, and the attacker is inside.
//
// What made that reachable is that a route needs no unguessable precondition.
// /api/save happens to have one — `baseMtimeMs` must equal the file's actual
// mtimeMs, a float an attacker cannot guess — but /api/asset needs only a
// `fileId` inside [0, absFiles.length), which is guessable in one try, and it
// WRITES FILES. So the check belongs at the front door rather than on the one
// route that happened to lack a second lock: the Host header is attacker-
// controlled in name only, since a rebinding attack must send the name it
// rebound, and that name is never a loopback literal.
//
// A missing Host is rejected too (HTTP/1.0 clients): this server is only ever
// addressed by lib/editor/open.js and a browser, both of which send one.
function hostIsLoopback(hostHeader, port) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return false;
  const h = hostHeader.toLowerCase();
  const names = ['127.0.0.1', 'localhost', '[::1]'];
  for (const n of names) {
    if (h === n + ':' + port) return true;
    // A bare Host (no ':port') means the scheme's default port. Only accept it
    // when that is genuinely the port we are listening on.
    if (port === 80 && h === n) return true;
  }
  return false;
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

// The one invariant that ties the two halves of the payload together: every
// block's line range must address a line that actually EXISTS in `lines`.
// blockmap.js derives ranges from marked's own tokenisation while `lines`
// comes from a regex split here, so the two can only agree while both use the
// SAME definition of a line terminator — and when they disagree the failure is
// silent and destructive (lineops.replaceLines() splices past the end of the
// array, deleting every line the block map thought was there). Throwing here
// turns that into the server route's 500 + the client's error banner, which is
// a document that will not open rather than a document that opens and then
// eats its own tail.
function assertBlockRangesFit(blocks, lines) {
  let maxEnd = 0;
  for (const b of blocks || []) if (b.endLine > maxEnd) maxEnd = b.endLine;
  if (maxEnd > lines.length) {
    throw new Error('block map is out of range: endLine ' + maxEnd +
      ' > ' + lines.length + ' lines (line-terminator handling disagrees with marked)');
  }
}

async function createEditorServer({ files, idleTimeoutMs = 30000, clientJs = '', listenPort = 0 }) {
  const absFiles = files.map((f) => path.resolve(f));
  let idleTimer = null;
  let started = false;

  function bumpIdle(server) {
    if (!started) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => server.close(), idleTimeoutMs);
    if (idleTimer.unref) idleTimer.unref();
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');

      // FIRST, ahead of every route including GET /edit/:id — see
      // hostIsLoopback() above for the attack this closes. Placed here rather
      // than on /api/asset alone: that route is merely where it was reachable,
      // not where the hole is.
      const addr = server.address();
      if (!hostIsLoopback(req.headers.host, addr && addr.port)) {
        return send(res, 403, { error: 'forbidden host' });
      }

      const editMatch = url.pathname.match(/^\/edit\/(\d+)$/);

      // Cross-origin defense for every state-changing POST route: a
      // cross-site "simple" POST (form submission, no CORS preflight) cannot
      // set a non-simple content-type header like application/json, so
      // requiring it here means a browser blocks the request before it ever
      // reaches this server — this server never sends CORS headers, so the
      // browser would otherwise let the request fire-and-forget cross-origin.
      // /api/ping is included; lib/editor/client.js's fetch calls already
      // send this header for render, save, and ping.
      // v3.1.0: '/api/asset' is in this set for the same reason the other
      // three are, and more urgently — it is the only route that CREATES a
      // file. A route left out of this set has NO cross-origin defense at
      // all: any page the user happens to be browsing while `md2doc --edit`
      // is running could fire a cross-site "simple" POST at every candidate
      // localhost port and write to disk.
      const STATE_CHANGING_POST_PATHS = new Set(['/api/render', '/api/save', '/api/ping', '/api/asset']);
      if (req.method === 'POST' && STATE_CHANGING_POST_PATHS.has(url.pathname)) {
        const contentType = String(req.headers['content-type'] || '');
        if (!/^application\/json\b/i.test(contentType)) {
          return send(res, 415, { error: 'content-type must be application/json' });
        }
      }

      if (req.method === 'GET' && editMatch) {
        const fileId = Number(editMatch[1]);
        const file = absFiles[fileId];
        if (!file || !fs.existsSync(file)) return send(res, 404, { error: 'unknown file' });
        const mdText = fs.readFileSync(file, 'utf8');
        const mtimeMs = fs.statSync(file).mtimeMs;
        // EOL 偵測與拆行：lines 內部一律不含 \r（spec §3.11）。只有
        // /api/save 會把它接回檔案原本的 EOL；/api/render 一律用 \n。
        //
        // 三種終止符，不是兩種（T7）：marked 的 preprocess 把裸 \r 正規化成
        // \n（實測 marked 14：'# H\rpara\r' → heading + paragraph 兩個
        // token），所以 blockmap 會給出「第 2 行」這種行號；而 /\r\n|\n/
        // 不拆裸 \r，`lines` 只有一個元素。行號與 lines 脫鉤之後，任何
        // commit 的 replaceLines() 都會把 startLine 之後的內容整段吃掉——
        // 實測 '# H\rpara\r' 編輯第一個 block 之後 'para' 直接消失。
        // 拆行規則必須跟 marked 的換行定義一致。
        //
        // 多數決，不是「有 CRLF 就算 CRLF」（final review I3）：save 會把
        // `lines` 全部用同一個 eol 接回去，所以一萬行的 LF 檔裡混進一行
        // CRLF，舊式偵測會在第一次存檔時把一萬行全部改寫成 CRLF ——
        // 直接違反 spec §3.11 第 4 點「commit 範圍以外的行保留原位元組」。
        // 多數決把損害限制在少數派那幾行。平手時取 LF（git / POSIX 預設）。
        // 用「\n 總數 − CRLF 數」算裸 LF，而不是 /(^|[^\r])\n/g：後者是
        // non-overlapping 比對，連續空行的第二個 \n 會被前一次比對吃掉的
        // 字元擋掉而漏數。減法沒有這個誤差。
        //
        // 裸 \r 也進多數決，理由跟上一段同一條：既然現在會拆它，一個純
        // CR 檔（classic Mac）就會在第一次存檔時被整份改寫成 LF——正是
        // §3.11 第 4 點禁止的事。平手一律 LF。
        const lfTotal = (mdText.match(/\n/g) || []).length;
        const crTotal = (mdText.match(/\r/g) || []).length;
        const crlfCount = (mdText.match(/\r\n/g) || []).length;
        const bareLf = lfTotal - crlfCount;
        const bareCr = crTotal - crlfCount;
        // Strict > on every comparison, so ANY tie falls through to LF — which
        // is what the paragraph above promises. `>=` against bareCr handed a
        // CR/CRLF tie to CRLF and contradicted it. Nothing else moves: a
        // pure-CRLF file has bareCr === 0.
        const eol = (crlfCount > bareLf && crlfCount > bareCr) ? '\r\n'
          : (bareCr > bareLf && bareCr > crlfCount) ? '\r'
          : '\n';
        const { html, blocks } = await renderMarkdown(mdText, file, { editMode: true });
        const lines = mdText.split(/\r\n|\r|\n/);
        assertBlockRangesFit(blocks, lines);
        const payload = JSON.stringify({
          fileId, mtimeMs, eol, lines, blocks,
        });
        const inject =
          `<script>window.__ED__ = ${payload.replace(/</g, '\\u003c')}</script>\n` +
          `<script>${LINEOPS_SRC}</script>\n` +
          `<script>${INLINE_MD_SRC}</script>\n` +
          `<script>${TABLE_MD_SRC}</script>\n` +
          `<script>${LIST_MD_SRC}</script>\n` +
          `<script>${HISTORY_SRC}</script>\n` +
          `<script>${INDENT_CLAMP_SRC}</script>\n` +
          `<script>${CONVERT_MD_SRC}</script>\n` +
          `<script>${PATCHMAP_SRC}</script>\n` +
          `<script>${SELECTION_SRC}</script>\n` +
          `<script>${TOOLBAR_MODEL_SRC}</script>\n` +
          `<script>${DOCSOURCE_SRC}</script>\n` +
          `<script>${ASSET_SRC}</script>\n` +
          `<script>${TURNDOWN_SRC}</script>\n` +
          `<script>${PASTE_MD_SRC}</script>\n` +
          `<script>${clientJs}</script>\n`;
        // Splice at the LAST "</body>" — the document's real closing tag.
        // The first occurrence can sit inside an inlined diagram bundle's JS
        // string literal (mermaid's DOMPurify source contains "</body>");
        // String.replace would inject __ED__ mid-bundle and break every
        // script on the page. Also avoids replace()'s "$" substitution rules.
        const bodyAt = html.lastIndexOf('</body>');
        const out = bodyAt !== -1
          ? html.slice(0, bodyAt) + inject + html.slice(bodyAt)
          : html + inject;
        started = true;
        bumpIdle(server);
        // no-store: the page embeds a snapshot of the client runtime AND the
        // file's lines/mtime — a cached copy is stale code + a guaranteed
        // mtime conflict after any external edit.
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        return res.end(out);
      }

      if (req.method === 'POST' && url.pathname === '/api/render') {
        const { fileId, content } = await readJson(req);
        const file = absFiles[fileId];
        if (!file) return send(res, 404, { error: 'unknown file' });
        const { parts, blocks } = await renderMarkdown(content, file, { editMode: true });
        bumpIdle(server);
        return send(res, 200, { parts, blocks });
      }

      if (req.method === 'POST' && url.pathname === '/api/save') {
        const { fileId, content, baseMtimeMs } = await readJson(req);
        const file = absFiles[fileId];
        if (!file) return send(res, 404, { error: 'unknown file' });
        // baseMtimeMs is REQUIRED, not optional: skipping the compare when
        // it's missing would let a stale editor tab silently clobber a
        // newer on-disk edit (the whole point of the mtime guard).
        if (baseMtimeMs === undefined || baseMtimeMs === null) {
          return send(res, 400, { error: 'baseMtimeMs is required' });
        }
        const cur = fs.statSync(file).mtimeMs;
        if (cur !== baseMtimeMs) {
          return send(res, 409, { error: 'mtime-conflict', mtimeMs: cur });
        }
        const tmp = file + '.md2doc-tmp';
        fs.writeFileSync(tmp, content, 'utf8');
        fs.renameSync(tmp, file);
        bumpIdle(server);
        return send(res, 200, { mtimeMs: fs.statSync(file).mtimeMs });
      }

      // v3.1.0 追加 3: the image-drop / image-paste asset endpoint. Writes ONE
      // raster image next to the document under `assets/` and answers with the
      // relative markdown path the client then inserts as source.
      //
      // Six guards, none of them optional:
      //   0. '/api/asset' is in STATE_CHANGING_POST_PATHS above (the CSRF
      //      content-type gate). Without it this is a world-writable file
      //      drop for any page in the user's browser.
      //   1. fileId is type-checked. `/api/save`'s `!file` guard alone lets
      //      `fileId: "length"` through (absFiles.length is a number, so the
      //      lookup succeeds); Number.isInteger + a range check does not.
      //   2. An explicit 8 MB readJson limit, not the 50 MB default.
      //   3. The extension comes ONLY from the MIME whitelist (extFor); a
      //      caller-supplied 'x.html' can never become the name on disk.
      //   4. assets/ is created here — nothing else in this server creates
      //      directories, so the first drop would otherwise be a guaranteed
      //      ENOENT 500.
      //   5. The string-level isWithin() check is followed by a realpath
      //      re-check (a literal comparison cannot see a symlinked assets/,
      //      and writeFileSync FOLLOWS symlinks), and the file itself is
      //      opened 'wx' — which refuses to follow an existing symlink AND
      //      closes uniqueName()'s check-then-write TOCTOU window.
      if (req.method === 'POST' && url.pathname === '/api/asset') {
        const body = await readJson(req, 8 * 1024 * 1024);
        const fileId = body ? body.fileId : undefined;
        if (!Number.isInteger(fileId) || fileId < 0 || fileId >= absFiles.length) {
          return send(res, 400, { error: 'fileId must be an index into the open file list' });
        }
        const file = absFiles[fileId];
        const ext = assetLib.extFor(body.mime);
        if (!ext) return send(res, 400, { error: 'unsupported image type' });
        const b64 = typeof body.data === 'string' ? body.data : '';
        const buf = Buffer.from(b64, 'base64');
        if (buf.length === 0) return send(res, 400, { error: 'empty image payload' });

        const baseDir = path.dirname(file);
        const assetsDir = path.join(baseDir, 'assets');
        fs.mkdirSync(assetsDir, { recursive: true });
        let existing;
        try { existing = fs.readdirSync(assetsDir); } catch (e) { existing = []; }

        // Ruling 10: the candidate is composed as a FULL filename before
        // uniqueName sees it. `existing` is a raw readdir listing whose
        // entries carry extensions, so a bare stem could never match one —
        // a second same-named image would sail past collision detection and
        // then hit the 'wx' flag as a hard EEXIST instead of becoming -2.
        //
        // The comparison is CASE-FOLDED, because the write below is not.
        // macOS and Windows are both supported targets (it is why
        // sanitizeName defends '\\' and ':'), and their filesystems are
        // case-insensitive: `existing.indexOf('Shot.png')` misses an on-disk
        // `shot.png`, so no '-2' is generated, open(..., 'wx') returns EEXIST
        // and the user gets a generic 「圖片上傳失敗」 that repeats identically
        // on every retry. asset.js is reviewed and unchanged — the numbering
        // is still entirely its own; only the SPACE the question is asked in
        // moves. The user's original stem casing is then restored, so a
        // dropped `Shot.png` is still written as `Shot.png`.
        const stem = assetLib.sanitizeName(body.name);
        const desiredLower = (stem + ext).toLowerCase();
        const pickedLower = assetLib.uniqueName(
          desiredLower, existing.map((e) => String(e).toLowerCase()));
        let name;
        if (pickedLower === desiredLower) {
          name = stem + ext;
        } else {
          // uniqueName only ever inserts '-<n>' immediately before the
          // extension, so that suffix is what is lifted back across. Matched
          // rather than sliced by length: toLowerCase() is not guaranteed to
          // preserve length for every code point.
          const m = /(-\d+)$/.exec(pickedLower.slice(0, pickedLower.length - ext.length));
          name = stem + (m ? m[1] : '') + ext;
        }
        const target = path.join(assetsDir, name);
        if (!assetLib.isWithin(toPosixPath(assetsDir), toPosixPath(target))) {
          return send(res, 400, { error: 'refused: asset path escapes the assets directory' });
        }
        // Second boundary, against the filesystem rather than the string: a
        // pre-existing `assets` SYMLINK pointing anywhere at all passes the
        // check above unchanged, because that check only ever saw text.
        let realBase, realAssets;
        try {
          realBase = fs.realpathSync(baseDir);
          realAssets = fs.realpathSync(assetsDir);
        } catch (e) {
          return send(res, 500, { error: 'cannot resolve the assets directory' });
        }
        if (!assetLib.isWithin(toPosixPath(realBase), toPosixPath(realAssets))) {
          return send(res, 400, { error: 'refused: assets directory escapes the document directory' });
        }
        try {
          fs.writeFileSync(path.join(realAssets, name), buf, { flag: 'wx' });
        } catch (e) {
          if (e && e.code === 'EEXIST') {
            return send(res, 409, { error: 'asset already exists: ' + name });
          }
          throw e;
        }
        bumpIdle(server);
        return send(res, 200, { name, path: assetLib.relPath(name) });
      }

      if (req.method === 'POST' && url.pathname === '/api/ping') {
        bumpIdle(server);
        res.writeHead(204);
        return res.end();
      }

      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 500, { error: String((e && e.message) || e) });
    }
  });

  // EADDRINUSE (or any other listen-time error, e.g. a pinned --port that's
  // already taken) previously fired as an uncaught 'error' event on `server`
  // with nothing listening, since a plain `server.listen(..., resolve)`
  // Promise never rejects — it only ever resolves on the 'listening' event.
  // That crashed the whole process, bypassing bin's `.catch`. Listen for
  // 'error' too and reject the promise so the caller gets a normal rejection.
  await new Promise((resolve, reject) => {
    function onError(err) {
      server.removeListener('listening', onListening);
      reject(err);
    }
    function onListening() {
      server.removeListener('error', onError);
      resolve();
    }
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(listenPort, '127.0.0.1');
  });
  const port = server.address().port;
  return {
    server,
    port,
    urlFor(absPath) {
      const i = absFiles.indexOf(path.resolve(absPath));
      return i === -1 ? null : `http://127.0.0.1:${port}/edit/${i}`;
    },
    close() { if (idleTimer) clearTimeout(idleTimer); server.close(); },
  };
}

module.exports = { createEditorServer, assertBlockRangesFit };
