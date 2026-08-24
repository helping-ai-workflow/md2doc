'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { createEditorServer } = require('../lib/editor/server.js');

function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      { host: '127.0.0.1', port, method, path: p,
        headers: data ? { 'content-type': 'application/json' } : {} },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-srv-'));
  const mdPath = path.join(dir, 'doc.md');
  const original = '# H\n\n| A |\n|---|\n| 1 |\n';
  fs.writeFileSync(mdPath, original, 'utf8');

  const srv = await createEditorServer({ files: [mdPath], clientJs: '/*client*/' });
  try {
    // page
    const page = await req(srv.port, 'GET', '/edit/0');
    assert.strictEqual(page.status, 200);
    assert.ok(page.body.includes('window.__ED__'));
    assert.ok(page.body.includes('"lines"'));
    assert.ok(page.body.includes('ed-block'));
    assert.ok(page.body.includes('/*client*/'), 'client runtime inlined');

    // whitelist
    assert.strictEqual((await req(srv.port, 'GET', '/edit/1')).status, 404);
    assert.strictEqual((await req(srv.port, 'GET', '/edit/../etc')).status, 404);

    // render
    const rr = await req(srv.port, 'POST', '/api/render',
      { fileId: 0, content: 'just text\n' });
    assert.strictEqual(rr.status, 200);
    const rj = JSON.parse(rr.body);
    assert.ok(rj.bodyHtml.includes('data-block-id="0"'));
    assert.strictEqual(rj.blocks.length, 1);

    // save happy path — byte identity
    const mtime0 = fs.statSync(mdPath).mtimeMs;
    const edited = original.replace('# H', '# H2');
    const sr = await req(srv.port, 'POST', '/api/save',
      { fileId: 0, content: edited, baseMtimeMs: mtime0 });
    assert.strictEqual(sr.status, 200);
    assert.strictEqual(fs.readFileSync(mdPath, 'utf8'), edited);
    const mtime1 = JSON.parse(sr.body).mtimeMs;

    // save conflict — external touch
    fs.writeFileSync(mdPath, edited + '\n<!-- vim was here -->\n');
    const cr = await req(srv.port, 'POST', '/api/save',
      { fileId: 0, content: '# clobber\n', baseMtimeMs: mtime1 });
    assert.strictEqual(cr.status, 409);
    assert.ok(fs.readFileSync(mdPath, 'utf8').includes('vim was here'),
      'conflicting save must not touch the file');

    // no tmp litter
    assert.ok(!fs.readdirSync(dir).some((f) => f.includes('md2doc-tmp')));

    // ping
    assert.strictEqual((await req(srv.port, 'POST', '/api/ping')).status, 204);
  } finally {
    srv.close();
  }
  console.log('editor-server.test.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
