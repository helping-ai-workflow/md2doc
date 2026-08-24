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

async function createEditorServer({ files, idleTimeoutMs = 30000, clientJs = '' }) {
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
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
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
        const cur = fs.statSync(file).mtimeMs;
        if (baseMtimeMs !== undefined && cur !== baseMtimeMs) {
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

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
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
