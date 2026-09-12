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

// F13: the never-opened grace deadline is deliberately its own constant,
// not idleTimeoutMs reused. idleTimeoutMs governs the gap since the last
// browser ping (client.js pings every 10s; the default 30,000ms tolerates
// a short run of missed pings once a real tab is confirmed present).
// Before the URL is opened there is no ping to measure against — the wait
// is instead for a human to alt-tab to a browser, or, over SSH, copy the
// printed URL across to a local machine and load it there, which routinely
// takes longer than idleTimeoutMs allows. Reusing idleTimeoutMs for that
// wait would close sessions on people still reading the terminal output.
// Five minutes is chosen as a margin generous for that human handoff while
// still finite; test/cli-edit.test.js drives it through a shortened
// override — an unopened session still exits on its own, and a session
// opened partway through the grace window keeps working afterward.
const DEFAULT_NEVER_OPENED_GRACE_MS = 5 * 60 * 1000;

// T21 item 3: closing this server has to mean "stop serving now", not "stop
// serving once every open socket happens to go away". `server.close()` on its
// own does the latter: it stops accepting, then waits for the connections it
// already has. A browser handed the edit URL opens a socket it may never send
// a request on (a speculative preconnect), and such a socket is not one Node
// retires by itself — driven against `md2doc --edit` on this box with a
// viewer stub that opened one TCP connection to the port and sent no bytes,
// SIGINT printed cli.js's line and the process was still alive 10 s later,
// 3 runs of 3 — while the same runs with a viewer stub that connected and
// sent a request, and with `--no-open`, exited in 7-10 ms. The same hang
// reaches the idle and never-opened deadlines below, which have no second
// keystroke to rescue them, so every exit this file owns goes through here.
//
// closeAllConnections() lands the sockets that close() would wait on. It is
// Node >= 18.2 and package.json's engines floor is >= 18, so the call is
// guarded rather than assumed; on an 18.0/18.1 runtime the behaviour is
// exactly what it was before this function existed.
function shutdownServer(server, reason) {
  // F13: name the reason before closing, so cli.js's listener (the process's
  // stdout writer) can print a line distinct from the other exits.
  if (reason) server.emit('md2doc-auto-close', reason);
  server.close();
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
}

async function createEditorServer({
  files, idleTimeoutMs = 30000, neverOpenedGraceMs = DEFAULT_NEVER_OPENED_GRACE_MS,
  clientJs = '', listenPort = 0,
}) {
  const absFiles = files.map((f) => path.resolve(f));
  let idleTimer = null;
  let neverOpenedTimer = null;
  let started = false;

  // v3.4.0 batch2 Task 6 — Ruling B2-2: watch every `.drawio`/`.xml` file the
  // CURRENTLY OPEN document references, and let /api/ping's already-firing
  // 10s heartbeat (see its own comment below) double as the staleness check,
  // rather than inventing a push transport server.js has never had (no
  // WebSocket/SSE/fs.watch anywhere in this stack — see this task's
  // investigation note). Keyed by fileId; each entry is `{ refs, mtimes }`
  // where `mtimes` is a Map<absPath, mtimeMs-or-null> — null meaning "could
  // not stat it last time we looked" (deleted/unreadable), which is a value
  // like any other for the comparison in checkDrawioStale(), not a special
  // case: a file reappearing (null -> a number) is exactly as much "changed"
  // as one being edited (number -> a different number).
  const drawioWatch = new Map();

  // statOneDrawioRef() never throws — a file the user deleted or renamed
  // OUTSIDE the editor between two heartbeats must degrade to "no longer
  // there", not crash the request handling every open tab shares.
  function statOneDrawioRef(absPath) {
    try { return fs.statSync(absPath).mtimeMs; } catch (e) { return null; }
  }

  // Called after every render that actually re-reads the source markdown
  // (GET /edit/:id and POST /api/render both call renderMarkdown() fresh) —
  // the refs list and the stat baseline are only ever as current as the last
  // bake, which is exactly what "has it changed SINCE we last baked it"
  // needs to mean.
  function trackDrawioRefs(fileId, refs) {
    const list = Array.isArray(refs) ? refs : [];
    const mtimes = new Map();
    for (const p of list) mtimes.set(p, statOneDrawioRef(p));
    drawioWatch.set(fileId, { refs: list, mtimes });
  }

  // (a) requirement: a document with no drawio references must cost this
  // heartbeat NOTHING beyond the Map lookup below — zero fs.statSync calls,
  // same as the bare 204 this replaces. Only a document that actually has
  // `refs.length > 0` pays for the stat loop that follows.
  function checkDrawioStale(fileId) {
    const state = drawioWatch.get(fileId);
    if (!state || state.refs.length === 0) return false;
    let changed = false;
    const nextMtimes = new Map();
    for (const p of state.refs) {
      const m = statOneDrawioRef(p);
      nextMtimes.set(p, m);
      if (state.mtimes.get(p) !== m) changed = true;
    }
    // Baseline advances regardless of whether the client ever follows up
    // with a fetch of the fresh bake: the alternative (only advance once the
    // rebake is confirmed applied) needs a second round trip this task's
    // ruling explicitly ruled out reusing/inventing. A ping that reports
    // stale and is never acted on (client tab closed mid-flight, etc.) simply
    // stops repeating the same signal once the baseline has moved past it.
    state.mtimes = nextMtimes;
    return changed;
  }

  function bumpIdle(server) {
    if (!started) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      shutdownServer(server, 'idle');
    }, idleTimeoutMs);
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
        const { html, blocks, drawioRefs } = await renderMarkdown(mdText, file, { editMode: true });
        trackDrawioRefs(fileId, drawioRefs);
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
        const { parts, blocks, drawioRefs } = await renderMarkdown(content, file, { editMode: true });
        trackDrawioRefs(fileId, drawioRefs);
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
        // v3.4.0 batch2 Task 6: fileId is a NEW, optional field on the body
        // this heartbeat already sent every 10s (old clients / the existing
        // test in test/editor-server.test.js send `{}` with no fileId — that
        // still resolves to "no tracked state for this id", the same
        // zero-cost 204 as before). A body that fails to parse degrades the
        // same way: no staleness check, plain 204 — a malformed ping body
        // must never be the thing that breaks the idle-keepalive contract.
        let fileId;
        try {
          const body = await readJson(req);
          fileId = body ? body.fileId : undefined;
        } catch (e) {
          fileId = undefined;
        }
        if (checkDrawioStale(fileId)) {
          return send(res, 200, { stale: true });
        }
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

  // F13: counts from listen (this point), not from process start — listen
  // is the moment a client could first reach the server, and that is the
  // deadline this timer is measuring against. Unref'd like idleTimer, and
  // for the same reason: the listening socket is what should keep the
  // process alive, not this timer. A timer that held a ref would keep the
  // process up on its own even if the socket already went away, which is
  // backwards for a clock whose only job is to give up and exit.
  neverOpenedTimer = setTimeout(() => {
    // The guard against closing a session that has already been opened —
    // this timer is armed once, at listen time, and left to run; it is
    // not cancelled by the GET /edit/:id handler. Whether the URL was
    // opened by the time the deadline arrives is decided here, by reading
    // `started` fresh at fire time. Proven load-bearing by mutation: with
    // this line removed, an actively-pinged session still gets closed the
    // moment this deadline passes (see test/cli-edit.test.js's "must
    // survive the never-opened grace deadline" case).
    if (started) return;
    shutdownServer(server, 'never-opened');
  }, neverOpenedGraceMs);
  if (neverOpenedTimer.unref) neverOpenedTimer.unref();

  return {
    server,
    port,
    urlFor(absPath) {
      const i = absFiles.indexOf(path.resolve(absPath));
      return i === -1 ? null : `http://127.0.0.1:${port}/edit/${i}`;
    },
    close() {
      if (idleTimer) clearTimeout(idleTimer);
      if (neverOpenedTimer) clearTimeout(neverOpenedTimer);
      shutdownServer(server, null);
    },
  };
}

module.exports = { createEditorServer, assertBlockRangesFit };
