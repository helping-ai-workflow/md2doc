'use strict';
// Byte-stability regression for the per-li list architecture.
//
// The entire per-li segmentation rests on ONE invariant: a document loaded
// into the editor and saved with NO edit produces a byte-identical file.
// roundtrip.test.js already guards this, but its fixture's only list is a
// single "- outer / - inner" nest — it does not exercise the per-li matrix.
// This fixture spans every list variety the per-li segmenter must round-trip:
//   - an ordered list
//   - a task list (a checked [x] AND an unchecked [ ] item)
//   - an ordered task list (1. [ ] / 1. [x])
//   - a loose list (blank line between items)
//   - mixed-depth type switching (a bullet with a nested ORDERED sublist,
//     and an ordered item with a nested BULLET sublist)
// plus a no-EOF-newline ending and a trailing-space line, so whitespace
// preservation is guarded alongside the list matrix.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { createEditorServer } = require('../lib/editor/server.js');

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
    path.join(__dirname, 'fixtures', 'roundtrip-lists.md'), 'utf8');
  // The fixture must carry both whitespace hazards it claims to guard.
  assert.ok(!fixture.endsWith('\n'), 'fixture must lack a trailing EOF newline');
  assert.ok(/ {2}\n/.test(fixture), 'fixture must contain a trailing-space line');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-bytes-'));
  const mdPath = path.join(dir, 'lists.md');
  fs.writeFileSync(mdPath, fixture, 'utf8');
  const srv = await createEditorServer({ files: [mdPath], clientJs: '' });
  try {
    // Precondition: the fixture really does exercise the per-li matrix. If a
    // future change breaks per-li segmentation this fails loudly rather than
    // letting the (trivially byte-identical) zero-edit save pass vacuously.
    const rr = await post(srv.port, '/api/render', { fileId: 0, content: fixture });
    const lis = rr.json.blocks.filter((b) => b.type === 'li');
    const listTypes = new Set(lis.map((b) => b.listType));
    assert.ok(listTypes.has('ul'), 'fixture must render bullet lis');
    assert.ok(listTypes.has('ol'), 'fixture must render ordered lis');
    assert.ok(lis.some((b) => b.task === true), 'fixture must render task lis');
    // both a checked and an unchecked task li present
    const taskChecked = lis.filter((b) => b.task === true).map((b) => b.checked);
    assert.ok(taskChecked.includes(true), 'fixture must render a checked task li');
    assert.ok(taskChecked.includes(false), 'fixture must render an unchecked task li');
    // nested lis (indent > 0) prove the mixed-depth type switches segmented
    assert.ok(lis.some((b) => b.indent > 0), 'fixture must render nested (indented) lis');

    // The regression itself: zero-edit save must reproduce the fixture bytes.
    const lines = fixture.split('\n');
    const mtime0 = fs.statSync(mdPath).mtimeMs;
    const r = await post(srv.port, '/api/save',
      { fileId: 0, content: lines.join('\n'), baseMtimeMs: mtime0 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(fs.readFileSync(mdPath, 'utf8'), fixture,
      'zero-edit save over a per-li-heavy document (ordered / task / ordered-task / ' +
      'loose / mixed-depth-type-switch lists) must be byte-identical, including the ' +
      'trailing-space line and the no-EOF-newline ending');
  } finally {
    srv.close();
  }

  console.log('byte-stability.test.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
