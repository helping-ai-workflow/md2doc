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

function get(port, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: p }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    r.on('error', reject); r.end();
  });
}

// The edit page carries its own state in a `window.__ED__ = {...}` script tag —
// the same object the client runtime reads. Pulling it back out is how a
// server-level test gets at `eol` and `lines` without launching a browser.
function readEdState(html) {
  const at = html.indexOf('window.__ED__ = ');
  assert.ok(at > 0, 'the edit page must inject window.__ED__');
  const start = at + 'window.__ED__ = '.length;
  const end = html.indexOf('</script>', start);
  return JSON.parse(html.slice(start, end));
}

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

  // ── T8 item 5: mixed EOL — the minority lines ARE rewritten ─────────────
  //
  // A PINNED KNOWN EXCEPTION, not a guarantee. spec §3.11(4) says lines
  // outside the commit range keep their original bytes; a file with mixed line
  // endings is the one place that does not hold, and it cannot: /api/save
  // rejoins the whole `lines` array with ONE detected EOL. The server takes
  // the majority (see its own comment) precisely to bound the damage — the
  // alternative, "any CRLF means CRLF", rewrote all ten thousand lines of an
  // LF file because one line had a stray \r.
  //
  // This is here so the boundary is a measured fact with a test name on it
  // rather than folklore. If a future change makes save EOL-preserving
  // per-line, this test fails and that is the correct signal: come back, read
  // this comment, and delete it deliberately.
  {
    const cases = [
      {
        name: 'CRLF majority absorbs the one LF line',
        text: '# H\r\n\r\n- a\r\nlf only\n- c\r\n',
        eol: '\r\n',
        saved: '# H\r\n\r\n- a\r\nlf only\r\n- c\r\n',
      },
      {
        name: 'LF majority absorbs the one CRLF line',
        text: '# H\n\n- a\ncrlf only\r\n- c\n',
        eol: '\n',
        saved: '# H\n\n- a\ncrlf only\n- c\n',
      },
    ];
    for (const c of cases) {
      const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-eol-'));
      const p2 = path.join(d2, 'mixed.md');
      fs.writeFileSync(p2, c.text, 'utf8');
      const s2 = await createEditorServer({ files: [p2], clientJs: '' });
      try {
        const page = await get(s2.port, '/edit/0');
        assert.strictEqual(page.status, 200);
        const ed = readEdState(page.body);
        assert.strictEqual(ed.eol, c.eol,
          c.name + ': majority rule must pick ' + JSON.stringify(c.eol) +
          ', got ' + JSON.stringify(ed.eol));
        // A ZERO-EDIT save — the strongest form of the statement. Nothing was
        // typed, and the minority line still changes.
        const r2 = await post(s2.port, '/api/save',
          { fileId: 0, content: ed.lines.join(ed.eol), baseMtimeMs: fs.statSync(p2).mtimeMs });
        assert.strictEqual(r2.status, 200);
        const after = fs.readFileSync(p2, 'utf8');
        assert.strictEqual(after, c.saved,
          c.name + ': the minority line\'s terminator is normalised and every other byte ' +
          'survives; got ' + JSON.stringify(after));
        assert.notStrictEqual(after, c.text,
          c.name + ': fixture sanity — if this were byte-identical the test would be ' +
          'asserting nothing');
      } finally { s2.close(); }
    }
  }

  console.log('byte-stability.test.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
