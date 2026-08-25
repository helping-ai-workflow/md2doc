'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { renderMarkdown } = require('../md2doc.js');

const LINEOPS_SRC = fs.readFileSync(path.join(__dirname, 'lineops.js'), 'utf8');

function readJson(req, limitBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > limitBytes) { reject(new Error('payload too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
    });
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
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
        const { html, blocks } = await renderMarkdown(mdText, file, { editMode: true });
        const payload = JSON.stringify({
          fileId, mtimeMs, lines: mdText.split('\n'), blocks,
        });
        const inject =
          `<script>window.__ED__ = ${payload.replace(/</g, '\\u003c')}</script>\n` +
          `<script>${LINEOPS_SRC}</script>\n` +
          `<script>${clientJs}</script>\n`;
        const out = html.includes('</body>')
          ? html.replace('</body>', inject + '</body>')
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

module.exports = { createEditorServer };
