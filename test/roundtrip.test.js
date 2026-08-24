'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { createEditorServer } = require('../lib/editor/server.js');
const { extractBlockSource, commitEdit } = require('../lib/editor/client.js');
const { UndoStack } = require('../lib/editor/lineops.js');

function post(port, p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: p,
      headers: { 'content-type': 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') }));
    });
    r.on('error', reject); r.write(data); r.end();
  });
}

(async () => {
  const fixture = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'roundtrip.md'), 'utf8');
  assert.ok(!fixture.endsWith('\n'), 'fixture must lack trailing newline');
  assert.ok(/ {2}\n/.test(fixture), 'fixture must contain trailing spaces');
  assert.ok(/\|-{4,}/.test(fixture), 'fixture must contain a padded table');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-rt-'));
  const mdPath = path.join(dir, 'doc.md');
  fs.writeFileSync(mdPath, fixture, 'utf8');
  const srv = await createEditorServer({ files: [mdPath], clientJs: '' });
  try {
    // 1) zero-edit round trip: client state → save → byte-identical
    const lines = fixture.split('\n');
    const mtime0 = fs.statSync(mdPath).mtimeMs;
    let r = await post(srv.port, '/api/save',
      { fileId: 0, content: lines.join('\n'), baseMtimeMs: mtime0 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(fs.readFileSync(mdPath, 'utf8'), fixture,
      'zero-edit save must be byte-identical (padded table, trailing spaces, no-EOF-newline all preserved)');

    // 2) one-block edit: diff confined to that block's line range
    const rr = await post(srv.port, '/api/render', { fileId: 0, content: fixture });
    const blocks = rr.json.blocks;
    const quote = blocks.find((b) => b.type === 'blockquote');
    const st = commitEdit({ lines, blocks, stack: new UndoStack() },
      quote.id, '> quote line EDITED');
    r = await post(srv.port, '/api/save',
      { fileId: 0, content: st.lines.join('\n'), baseMtimeMs: r.json.mtimeMs });
    assert.strictEqual(r.status, 200);
    const now = fs.readFileSync(mdPath, 'utf8').split('\n');
    const orig = fixture.split('\n');
    assert.strictEqual(now.length, orig.length);
    now.forEach((ln, i) => {
      if (i === quote.startLine - 1) {
        assert.strictEqual(ln, '> quote line EDITED');
      } else {
        assert.strictEqual(ln, orig[i], `line ${i + 1} must be untouched`);
      }
    });
  } finally {
    srv.close();
  }
  console.log('roundtrip.test.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
