'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

// Finding 1 regression: renderMarkdown() used to end with a `catch (e) {
// console.error(...); process.exit(1); }` wrapping ~700 lines of render
// logic. That meant ANY render-time throw (e.g. marked/katex choking on
// pathological input) killed the whole long-lived editor server process —
// bypassing the server route's own try/catch→500 and the client's error
// banner entirely. The fix removed that in-function catch so the throw
// bubbles up to the caller instead (the server route's try/catch, or the
// CLI's outer `(async () => {...})().catch(...)`).
//
// We can't reliably provoke marked/katex into throwing from ordinary or even
// pathological markdown content (they're defensive by design), so this test
// mocks the module boundary server.js relies on (`require('../md2doc.js')`)
// via Node's own module cache, installed BEFORE requiring server.js. This is
// an honest black-box substitution of the dependency at its real require()
// seam — not a test-only hook added to production code.
const md2docPath = require.resolve('../lib/md2doc.js');
require.cache[md2docPath] = {
  id: md2docPath,
  filename: md2docPath,
  loaded: true,
  exports: {
    renderMarkdown: async () => {
      throw new Error('injected render failure (Finding 1 regression test)');
    },
  },
};

const { createEditorServer } = require('../lib/editor/server.js');

function post(port, p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: p,
        headers: { 'content-type': 'application/json' } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: p }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
    r.on('error', reject);
    r.end();
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-throw-'));
  const mdPath = path.join(dir, 'doc.md');
  fs.writeFileSync(mdPath, '# H\n', 'utf8');

  const srv = await createEditorServer({ files: [mdPath], clientJs: '' });
  try {
    // POST /api/render hits the mocked renderMarkdown and throws.
    const r1 = await post(srv.port, '/api/render', { fileId: 0, content: 'x' });
    assert.strictEqual(r1.status, 500, 'a renderMarkdown throw must surface as 500, not crash the process');
    const j1 = JSON.parse(r1.body);
    assert.ok(/injected render failure/.test(j1.error), 'the 500 body must carry the real error');

    // The server process must SURVIVE: a follow-up request is still served
    // (also 500, since the mock always throws, but critically the process
    // is still alive and listening — the old process.exit(1) would have
    // already killed it after the first request above).
    const r2 = await post(srv.port, '/api/render', { fileId: 0, content: 'y' });
    assert.strictEqual(r2.status, 500, 'server must still be alive and serving after the throw');

    // GET /edit/0 also calls renderMarkdown — same guarantee applies there.
    const r3 = await get(srv.port, '/edit/0');
    assert.strictEqual(r3.status, 500, 'GET /edit/:id must also surface the throw as 500, not crash');

    // And the server is STILL alive after that too.
    const r4 = await post(srv.port, '/api/render', { fileId: 0, content: 'z' });
    assert.strictEqual(r4.status, 500);
  } finally {
    srv.close();
  }
  console.log('editor-server-throw.test.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
