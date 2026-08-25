'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { createEditorServer } = require('../lib/editor/server.js');
const { commitEdit } = require('../lib/editor/client.js');
const { UndoStack } = require('../lib/editor/lineops.js');
const { serializeTable } = require('../lib/editor/table-md.js');
const { serializeInline } = require('../lib/editor/inline-md.js');

// minimal element stub — same pattern as test/table-md.test.js /
// test/inline-md.test.js (childNodes/nodeType/nodeName/textContent/
// getAttribute only, no querySelector).
function el(name, attrs, ...children) {
  return {
    nodeType: 1, nodeName: name.toUpperCase(),
    childNodes: children.map(c => typeof c === 'string' ? { nodeType: 3, textContent: c } : c),
    getAttribute: (k) => (attrs || {})[k] !== undefined ? attrs[k] : null,
    get textContent() {
      return this.childNodes.map(c => c.textContent).join('');
    },
  };
}
function th(attrs, ...children) { return el('th', attrs, ...children); }
function td(attrs, ...children) { return el('td', attrs, ...children); }
function tr(...children) { return el('tr', {}, ...children); }
function table(headerRow, bodyRows) {
  return el('table', {},
    el('colgroup', {}),
    el('thead', {}, headerRow),
    el('tbody', {}, ...bodyRows)
  );
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

  // 3) WYSIWYG table edit on the padded fixture table: minimal-form
  // emission via table-md.js from a stubbed DOM equivalent (same el()
  // pattern as test/table-md.test.js), applied through commitEdit and
  // saved — the edited table's lines must be EXACTLY minimal form, and
  // every line outside that range must stay byte-identical to the
  // fixture, including the trailing-space line and the no-EOF-newline
  // hazard. Uses its OWN isolated copy of the fixture (not the file
  // mutated by steps 1/2 above) so "byte-identical outside the range"
  // compares against the pristine fixture bytes.
  {
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-rt-table-'));
    const mdPath3 = path.join(dir3, 'doc.md');
    fs.writeFileSync(mdPath3, fixture, 'utf8');
    const mtime3 = fs.statSync(mdPath3).mtimeMs;
    const srv3 = await createEditorServer({ files: [mdPath3], clientJs: '' });
    try {
      const rr3 = await post(srv3.port, '/api/render', { fileId: 0, content: fixture });
      const tables = rr3.json.blocks.filter((b) => b.type === 'table');
      assert.strictEqual(tables.length, 2, 'fixture must have two table blocks');
      const tbl = tables[0]; // the padded Signal/Width/Description table

      const edited = table(
        tr(th({}, 'Signal'), th({}, 'Width'), th({}, 'Description')),
        [
          tr(td({}, 'pmac_tx_tvalidchk'), td({}, '1'), td({}, 'valid check')),
          tr(td({}, 'clk'), td({}, '2'), td({}, 'clock')), // the WYSIWYG edit: 1 -> 2
        ]
      );
      const { md, unsupported } = serializeTable(edited);
      assert.deepStrictEqual(unsupported, []);
      const expectedLines = [
        '| Signal | Width | Description |',
        '|---|---|---|',
        '| pmac_tx_tvalidchk | 1 | valid check |',
        '| clk | 2 | clock |',
      ];
      assert.strictEqual(md, expectedLines.join('\n'),
        'the stubbed-DOM edit must serialize to the minimal form (unpadded, no alignment colons)');

      const st3 = commitEdit(
        { lines: fixture.split('\n'), blocks: rr3.json.blocks, stack: new UndoStack() },
        tbl.id, md
      );
      assert.strictEqual(st3.lines.length, fixture.split('\n').length,
        'the table edit must not change the total line count');

      const r3 = await post(srv3.port, '/api/save',
        { fileId: 0, content: st3.lines.join('\n'), baseMtimeMs: mtime3 });
      assert.strictEqual(r3.status, 200);

      const fileAfter3 = fs.readFileSync(mdPath3, 'utf8');
      const orig3 = fixture.split('\n');
      const expectedFull = orig3.slice(0, tbl.startLine - 1)
        .concat(expectedLines, orig3.slice(tbl.endLine))
        .join('\n');
      assert.strictEqual(fileAfter3, expectedFull,
        'edited table lines must be exactly minimal form; every other line byte-identical to the fixture');
      assert.ok(!fileAfter3.endsWith('\n'),
        'no-EOF-newline hazard must survive the table edit');
      assert.ok(fileAfter3.split('\n').some((ln) => / {2}$/.test(ln)),
        'trailing-space-line hazard must survive the table edit');
      assert.ok(fileAfter3.includes('§2'),
        'UTF-8 §2 hazard must survive the table edit');
    } finally {
      srv3.close();
    }
  }

  // 4) paragraph commit with snake_case content: the minimal-form
  // emission via inline-md.js from a stubbed DOM paragraph must NOT
  // escape the underscore (word-boundary rule — escaping-bloat guard).
  // Isolated copy again, same reasoning as step 3.
  {
    const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-rt-para-'));
    const mdPath4 = path.join(dir4, 'doc.md');
    fs.writeFileSync(mdPath4, fixture, 'utf8');
    const mtime4 = fs.statSync(mdPath4).mtimeMs;
    const srv4 = await createEditorServer({ files: [mdPath4], clientJs: '' });
    try {
      const rr4 = await post(srv4.port, '/api/render', { fileId: 0, content: fixture });
      const paras = rr4.json.blocks.filter((b) => b.type === 'paragraph');
      assert.ok(paras.length >= 1, 'fixture must have at least one paragraph block');
      const para = paras[0];

      const editedP = el('p', {}, 'See pmac_tx_tvalidchk for details.');
      const { md, unsupported } = serializeInline(editedP);
      assert.deepStrictEqual(unsupported, []);
      assert.strictEqual(md, 'See pmac_tx_tvalidchk for details.',
        'escaping-bloat guard: snake_case must round-trip unescaped');
      assert.ok(!/\\_/.test(md), 'no underscore in the emission may be backslash-escaped');

      const st4 = commitEdit(
        { lines: fixture.split('\n'), blocks: rr4.json.blocks, stack: new UndoStack() },
        para.id, md
      );
      const r4 = await post(srv4.port, '/api/save',
        { fileId: 0, content: st4.lines.join('\n'), baseMtimeMs: mtime4 });
      assert.strictEqual(r4.status, 200);

      const fileAfter4 = fs.readFileSync(mdPath4, 'utf8');
      const emittedLine = fileAfter4.split('\n')[para.startLine - 1];
      assert.strictEqual(emittedLine, 'See pmac_tx_tvalidchk for details.',
        'the emitted line must contain snake_case unescaped');
    } finally {
      srv4.close();
    }
  }

  console.log('roundtrip.test.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
