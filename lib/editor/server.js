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
      const editMatch = url.pathname.match(/^\/edit\/(\d+)$/);

      // Cross-origin defense for every state-changing POST route: a
      // cross-site "simple" POST (form submission, no CORS preflight) cannot
      // set a non-simple content-type header like application/json, so
      // requiring it here means a browser blocks the request before it ever
      // reaches this server — this server never sends CORS headers, so the
      // browser would otherwise let the request fire-and-forget cross-origin.
      // /api/ping is included; lib/editor/client.js's fetch calls already
      // send this header for render, save, and ping.
      const STATE_CHANGING_POST_PATHS = new Set(['/api/render', '/api/save', '/api/ping']);
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
        const eol = (crlfCount > bareLf && crlfCount >= bareCr) ? '\r\n'
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
        const { bodyHtml, blocks } = await renderMarkdown(content, file, { editMode: true });
        bumpIdle(server);
        return send(res, 200, { bodyHtml, blocks });
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
