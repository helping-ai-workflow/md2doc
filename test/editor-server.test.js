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
        res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
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
    assert.ok(page.body.includes('md2docInlineMd'), 'Task 3: inline-md runtime inlined');
    assert.ok(page.body.includes('md2docTableMd'), 'Task 5: table-md runtime inlined');
    assert.ok(page.body.indexOf('md2docInlineMd') < page.body.indexOf('md2docTableMd'),
      'inline-md must be injected before table-md (table-md require()s it in node / reads it off window in the browser)');
    assert.ok(page.body.indexOf('md2docTableMd') < page.body.indexOf('/*client*/'),
      'table-md must be injected before the client runtime (client depends on window.md2docTableMd)');
    assert.ok(page.body.includes('/*client*/'), 'client runtime inlined');
    assert.strictEqual(page.headers['cache-control'], 'no-store',
      'edit page must never be cached — it embeds a code+mtime snapshot');

    // injection must land at the DOCUMENT's closing </body>, not the first
    // literal "</body>" in the page — a mermaid-bearing doc inlines the
    // mermaid bundle whose DOMPurify source contains "</body>" inside a JS
    // string; replacing the first occurrence splices __ED__ into the middle
    // of that bundle and kills every script on the page.
    {
      const mermaidMd = path.join(dir, 'mermaid-doc.md');
      fs.writeFileSync(mermaidMd,
        '# M\n\n```mermaid\ngraph TD; a-->b;\n```\n\ntail paragraph\n', 'utf8');
      const srv2 = await createEditorServer({ files: [mermaidMd], clientJs: '/*client*/' });
      try {
        const p2 = await req(srv2.port, 'GET', '/edit/0');
        assert.strictEqual(p2.status, 200);
        const edAt = p2.body.indexOf('window.__ED__');
        assert.ok(edAt !== -1, 'payload injected');
        const lastEngine = p2.body.lastIndexOf('data-md2doc-diagram-engine=');
        assert.ok(edAt > lastEngine,
          '__ED__ must be injected after the last inlined diagram bundle, ' +
          'not spliced into it (first-"</body>"-occurrence bug)');
        // and the real closing tag still follows the injection
        assert.ok(p2.body.lastIndexOf('</body>') > edAt, 'real </body> after inject');
      } finally {
        srv2.close();
      }
    }

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

    // ping (needs a body so the `req` helper sends content-type — see
    // Finding 3: /api/ping now requires application/json like the other
    // state-changing POST routes)
    assert.strictEqual((await req(srv.port, 'POST', '/api/ping', {})).status, 204);

    // Finding 3(a): missing/wrong content-type on a state-changing POST → 415
    for (const p of ['/api/render', '/api/save', '/api/ping']) {
      const bare = await new Promise((resolve, reject) => {
        const r = http.request(
          { host: '127.0.0.1', port: srv.port, method: 'POST', path: p, headers: {} },
          (res) => {
            let buf = '';
            res.on('data', (c) => (buf += c));
            res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
          });
        r.on('error', reject);
        r.end();
      });
      assert.strictEqual(bare.status, 415, p + ' without content-type must 415');
    }
    const wrongCt = await new Promise((resolve, reject) => {
      const r = http.request(
        { host: '127.0.0.1', port: srv.port, method: 'POST', path: '/api/render',
          headers: { 'content-type': 'text/plain' } },
        (res) => {
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
        });
      r.on('error', reject);
      r.write(JSON.stringify({ fileId: 0, content: 'x' }));
      r.end();
    });
    assert.strictEqual(wrongCt.status, 415, 'wrong content-type must also 415');

    // Finding 3(b): /api/save without baseMtimeMs → 400, file left untouched
    const beforeMissing = fs.readFileSync(mdPath, 'utf8');
    const missingBase = await req(srv.port, 'POST', '/api/save',
      { fileId: 0, content: '# should not land\n' });
    assert.strictEqual(missingBase.status, 400, 'save without baseMtimeMs must 400');
    assert.strictEqual(fs.readFileSync(mdPath, 'utf8'), beforeMissing,
      'save without baseMtimeMs must not touch the file');
  } finally {
    srv.close();
  }

  // Finding 2: createEditorServer with a listenPort already occupied by
  // another server must REJECT the returned promise (a catchable rejection,
  // the same shape bin's --edit `.catch` handles), not crash the process
  // with an uncaught 'error' event.
  {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-srv2-'));
    const mdPath2 = path.join(dir2, 'doc2.md');
    fs.writeFileSync(mdPath2, '# pinned\n', 'utf8');

    const srvA = await createEditorServer({ files: [mdPath2], clientJs: '' });
    try {
      let rejected = null;
      try {
        await createEditorServer({ files: [mdPath2], clientJs: '', listenPort: srvA.port });
      } catch (e) {
        rejected = e;
      }
      assert.ok(rejected, 'listenPort collision must reject, not throw uncaught');
      assert.strictEqual(rejected.code, 'EADDRINUSE');
      // server A must still be alive/serving — the collision must not have
      // taken down the process or the first server.
      const stillAlive = await req(srvA.port, 'GET', '/edit/0');
      assert.strictEqual(stillAlive.status, 200);
    } finally {
      srvA.close();
    }
  }

  console.log('editor-server.test.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
