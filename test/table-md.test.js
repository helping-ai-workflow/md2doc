'use strict';
const assert = require('assert');
const { marked } = require('marked');
const { serializeTable } = require('../lib/editor/table-md.js');

marked.setOptions({ gfm: true, breaks: false });

// ── T8 item 5: this file used to assert STRINGS and never re-read them ────
// Every case below states the exact bytes serializeTable() should emit and
// stops there. That shape is how a column-width defect in the sibling
// serializer survived three reviews: the expected string was written by
// reading the implementation, so implementation and expectation agreed with
// each other and neither was checked against marked. list-md.test.js and
// inline-md.test.js already re-lex their own output; this file did not (zero
// references to marked before this change).
//
// assertTableRoundTrips() closes that: it feeds the emitted markdown back
// through marked.lexer() and asserts the table that comes out is the table
// that went in — column count, alignment, and every cell's TEXT after inline
// rendering. The string assertions stay: they pin the exact bytes (padding,
// separator spelling) the paperwork gate reads, which a round-trip cannot see.
//
// ENTITY DECODING is part of the oracle, not a convenience. A literal '|' in
// a cell is emitted as '&#124;' — marked's lexer leaves it as those six
// characters and marked.parseInline() leaves it too, because decoding a
// numeric character reference is the HTML parser's job, i.e. the browser's.
// Comparing the raw token text would therefore "prove" the round-trip while
// the cell still reads 'a&#124;b' on screen. The decode below is the missing
// half of that trip.
function decodeEntities(html) {
  return html
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
function cellText(md) { return decodeEntities(marked.parseInline(md)); }
// `expected`: { header: [text...], align: [...|null], rows: [[text...], ...] }
// Cell texts are compared AFTER inline rendering, so a cell containing a real
// <br> is written here the way it renders ('a<br>b'), not the way its DOM
// spelled it.
function assertTableRoundTrips(md, expected, label) {
  const toks = marked.lexer(md);
  assert.strictEqual(toks.length, 1,
    label + ': emitted markdown must re-lex as exactly ONE top-level token, got ' +
    JSON.stringify(toks.map((t) => t.type)) + ' — md:\n' + md);
  assert.strictEqual(toks[0].type, 'table',
    label + ': and that token must still be a table, got ' + toks[0].type + ' — md:\n' + md);
  const t = toks[0];
  assert.deepStrictEqual(t.header.map((h) => cellText(h.text)), expected.header,
    label + ': header cells did not survive the round trip — md:\n' + md);
  if (expected.align) {
    assert.deepStrictEqual(t.align, expected.align,
      label + ': alignment did not survive the round trip — md:\n' + md);
  }
  assert.deepStrictEqual(t.rows.map((r) => r.map((c) => cellText(c.text))), expected.rows,
    label + ': body cells did not survive the round trip — md:\n' + md);
}

// minimal element stub — same pattern as test/inline-md.test.js
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
// Models exactly what renderer.table (lib/md2doc.js) actually emits:
// <table><colgroup>...</colgroup><thead><tr>...</tr></thead><tbody>...</tbody></table>
function table(headerRow, bodyRows) {
  return el('table', {},
    el('colgroup', {}),
    el('thead', {}, headerRow),
    el('tbody', {}, ...bodyRows)
  );
}

// 1. minimal emission: single-space padding, unpadded '|---|' separator
{
  const t = table(
    tr(th({}, 'Col A'), th({}, 'Col B')),
    [tr(td({}, '1'), td({}, '2')), tr(td({}, '3'), td({}, '4'))]
  );
  const { md, unsupported } = serializeTable(t);
  assert.deepStrictEqual(unsupported, []);
  assert.strictEqual(md, [
    '| Col A | Col B |',
    '|---|---|',
    '| 1 | 2 |',
    '| 3 | 4 |',
  ].join('\n'));
  assertTableRoundTrips(md, {
    header: ['Col A', 'Col B'], rows: [['1', '2'], ['3', '4']],
  }, 'minimal emission');
}

// 2. literal '|' in a cell -> '&#124;'
{
  const t = table(tr(th({}, 'H')), [tr(td({}, 'a|b'))]);
  const { md } = serializeTable(t);
  assert.strictEqual(md, ['| H |', '|---|', '| a&#124;b |'].join('\n'));
  // THE case this file could not previously see: the string assertion above is
  // satisfied by any escape spelling; only the round trip proves the cell still
  // holds one column reading 'a|b' rather than two columns reading 'a' and 'b'.
  assertTableRoundTrips(md, { header: ['H'], rows: [['a|b']] }, 'literal pipe in cell');
}

// 3. <br> cell — a real <br> node inside a cell; inline-md.js already
// verifies BR -> '<br>', table-md.js does no extra handling for it.
{
  const t = table(tr(th({}, 'H')), [tr(td({}, 'a', el('br', {}), 'b'))]);
  const { md } = serializeTable(t);
  assert.strictEqual(md, ['| H |', '|---|', '| a<br>b |'].join('\n'));
  assertTableRoundTrips(md, { header: ['H'], rows: [['a<br>b']] }, 'br cell');
}

// 4. alignment variants: left / right / center / default(no style)
{
  const t = table(
    tr(
      th({ style: 'text-align:left' }, 'L'),
      th({ style: 'text-align:right' }, 'R'),
      th({ style: 'text-align:center' }, 'C'),
      th({}, 'D')
    ),
    [tr(td({}, '1'), td({}, '2'), td({}, '3'), td({}, '4'))]
  );
  const { md } = serializeTable(t);
  const lines = md.split('\n');
  assert.strictEqual(lines[1], '|:---|---:|:---:|---|');
  assertTableRoundTrips(md, {
    header: ['L', 'R', 'C', 'D'],
    align: ['left', 'right', 'center', null],
    rows: [['1', '2', '3', '4']],
  }, 'alignment variants');
}

// 5. no line ends in whitespace (rows are always '|'-terminated by
// construction; this guards a future regression that adds trailing padding)
{
  const t = table(tr(th({}, 'H ')), [tr(td({}, 'x '))]);
  const { md } = serializeTable(t);
  md.split('\n').forEach((line) => {
    assert.strictEqual(line, line.replace(/\s+$/, ''),
      'line has trailing whitespace: ' + JSON.stringify(line));
  });
}

// 6. unsupported cell detection, aggregated across all cells
{
  const withImg = table(
    tr(th({}, 'H')),
    [tr(td({}, 'a', el('img', { src: 'x.png' })))]
  );
  const { unsupported } = serializeTable(withImg);
  assert.deepStrictEqual(unsupported, ['IMG']);
}

// every emitted line is ONE physical row starting with '|' (gate-compat
// precondition — see task-6 brief's gate-compat.test.js)
{
  const t = table(tr(th({}, 'H')), [tr(td({}, '1')), tr(td({}, '2'))]);
  const { md } = serializeTable(t);
  md.split('\n').forEach((line) => assert.ok(line.startsWith('|'), 'row must start with |: ' + line));
}

// header-only table (no body rows) still emits header + separator, no
// trailing empty row
{
  const t = table(tr(th({}, 'Only')), []);
  const { md } = serializeTable(t);
  assert.strictEqual(md, ['| Only |', '|---|'].join('\n'));
  assertTableRoundTrips(md, { header: ['Only'], rows: [] }, 'header-only table');
}

// Finding 1 defense-in-depth: a cell whose TEXT NODE contains a literal
// '\n' (e.g. from a paste that bypassed the client.js insertTextAtCaret()
// segmentation, or any other path that lands raw newline chars in a text
// node) must still emit as ONE physical table row — the embedded newline
// is converted to the literal '<br>' token, same as a real <br> element.
{
  const t = table(tr(th({}, 'H')), [tr(td({}, 'line one\nline two'))]);
  const { md } = serializeTable(t);
  assert.strictEqual(md, ['| H |', '|---|', '| line one<br>line two |'].join('\n'));
  md.split('\n').forEach((line) => assert.ok(line.startsWith('|'), 'row must start with |: ' + line));
  assertTableRoundTrips(md, { header: ['H'], rows: [['line one<br>line two']] },
    'raw newline in a text node');
}

// \r\n and bare \r variants also collapse to a single '<br>' (never a raw
// '\r' surviving into the emitted line).
{
  const t = table(tr(th({}, 'H')), [tr(td({}, 'a\r\nb\rc'))]);
  const { md } = serializeTable(t);
  assert.strictEqual(md, ['| H |', '|---|', '| a<br>b<br>c |'].join('\n'));
}

// v3.17.6: a '|' inside a <code> span in a cell is written as `\|`. GFM
// strips that escape when it splits the row into cells, BEFORE the cell is
// parsed inline, so the code span shows a bare '|' (the &#124; entity would
// not do: it is never decoded inside a code span). paperwork's quality gate
// (G-MD-TABLE-PIPE, `scan_table_rows_for_unescaped_pipe_in_backtick` in
// scripts/gate/shared.py, 10.4.0) asks for exactly this form, and the
// paperwork-workspace-rtk design-docs are written in it. Until v3.17.5 such a
// cell reported 'CODE' and the whole table fell back to raw-edit.
//
// CODE_PIPE_FIXTURE is the downstream shape, byte for byte: the mac-tx-ctrl
// design-doc rows the defect report quotes. Minimal-form separator, so the
// round trip has to reproduce the author's own bytes with or without
// `originalMd`.
const CODE_PIPE_FIXTURE = [
  '| 判斷 | 條件 | 來源 |',
  '|---|---|---|',
  '| 送出 PAUSE 的水位判斷 | 以 RX 側 `rxc_fc_inbw \\| rxc_flowctrl` 為滿 | 外部 |',
  '| PFC 期望狀態 | `cur_pfc[n] = (rg_pfc_req[n] \\| pfc_req[n]) & rg_pfc_pri_en[n]` | 內部 |',
].join('\n');
// The DOM renderMarkdown() actually produces for it (measured: the code
// element's text carries the bare '|', `&` decoded from `&amp;`).
function codePipeFixtureTable(thirdCell) {
  return table(
    tr(th({}, '判斷'), th({}, '條件'), th({}, '來源')),
    [
      tr(td({}, '送出 PAUSE 的水位判斷'),
        td({}, '以 RX 側 ', el('code', {}, 'rxc_fc_inbw | rxc_flowctrl'), ' 為滿'),
        td({}, thirdCell || '外部')),
      tr(td({}, 'PFC 期望狀態'),
        td({}, el('code', {}, 'cur_pfc[n] = (rg_pfc_req[n] | pfc_req[n]) & rg_pfc_pri_en[n]')),
        td({}, '內部')),
    ]
  );
}
const CODE_PIPE_TEXT = {
  header: ['判斷', '條件', '來源'],
  rows: [
    ['送出 PAUSE 的水位判斷', '以 RX 側 <code>rxc_fc_inbw | rxc_flowctrl</code> 為滿', '外部'],
    ['PFC 期望狀態', '<code>cur_pfc[n] = (rg_pfc_req[n] | pfc_req[n]) & rg_pfc_pri_en[n]</code>', '內部'],
  ],
};
// (a) untouched: byte-identical, with and without the original source
{
  for (const original of [CODE_PIPE_FIXTURE, undefined]) {
    const label = 'code-pipe fixture, ' + (original ? 'with' : 'without') + ' originalMd';
    const { md, unsupported } = serializeTable(codePipeFixtureTable(), original);
    assert.deepStrictEqual(unsupported, [], label + ': must stay WYSIWYG-editable');
    assert.strictEqual(md, CODE_PIPE_FIXTURE, label + ': must reproduce the source bytes');
    assertTableRoundTrips(md, CODE_PIPE_TEXT, label);
  }
}
// (b) another cell edited: the code spans keep their `\|`, nothing else moves
{
  const { md, unsupported } = serializeTable(codePipeFixtureTable('外部 SoC'), CODE_PIPE_FIXTURE);
  assert.deepStrictEqual(unsupported, []);
  assert.strictEqual(md, CODE_PIPE_FIXTURE.replace('| 外部 |', '| 外部 SoC |'));
}
// (c) code pipe and plain-text pipe in one cell: each gets its own escape
{
  const t = table(tr(th({}, 'H')), [tr(td({}, 'x|y ', el('code', {}, 'a|b')))]);
  const { md, unsupported } = serializeTable(t);
  assert.deepStrictEqual(unsupported, []);
  assert.strictEqual(md, ['| H |', '|---|', '| x&#124;y `a\\|b` |'].join('\n'));
  assertTableRoundTrips(md, { header: ['H'], rows: [['x|y <code>a|b</code>']] }, 'mixed pipes');
}
// (d) a code span that needs a longer fence keeps it, and its pipe escape
{
  const t = table(tr(th({}, 'H')), [tr(td({}, el('code', {}, 'a`|b')))]);
  const { md, unsupported } = serializeTable(t);
  assert.deepStrictEqual(unsupported, []);
  assert.strictEqual(md, ['| H |', '|---|', '| `` a`\\|b `` |'].join('\n'));
  assertTableRoundTrips(md, { header: ['H'], rows: [['<code>a`|b</code>']] }, 'fenced code pipe');
}
// (e) backslashes before the pipe. marked's splitCells() treats a pipe after
// an ODD run of backslashes as escaped, then deletes one backslash. So code
// text with an EVEN run before its '|' (0, 2, …) is written with one more
// backslash and comes back exact; an ODD run cannot be written at all — one
// more backslash makes the run even and the pipe a cell boundary. That one
// keeps the pre-v3.17.6 refusal ('CODE', whole table to raw-edit).
{
  const t = table(tr(th({}, 'H')), [tr(td({}, el('code', {}, 'a\\\\|b')))]);
  const { md, unsupported } = serializeTable(t);
  assert.deepStrictEqual(unsupported, [], 'two backslashes before the pipe are writable');
  assert.strictEqual(md, ['| H |', '|---|', '| `a\\\\\\|b` |'].join('\n'));
  assertTableRoundTrips(md, { header: ['H'], rows: [['<code>a\\\\|b</code>']] }, 'even backslash run');
}
{
  const t = table(tr(th({}, 'H')), [tr(td({}, el('code', {}, 'a\\|b')))]);
  const { unsupported } = serializeTable(t);
  assert.ok(unsupported.includes('CODE'),
    'code text with ONE backslash before its pipe has no table spelling and must refuse');
}

// Plain (non-code) pipe-in-text still works exactly as before — Finding 4
// must not regress the existing &#124; escape path.
{
  const t = table(tr(th({}, 'H')), [tr(td({}, 'a|b'))]);
  const { md, unsupported } = serializeTable(t);
  assert.strictEqual(md, ['| H |', '|---|', '| a&#124;b |'].join('\n'));
  assert.deepStrictEqual(unsupported, []);
}

// 空 thead：現行會輸出 "|  |" + "||"，re-lex 成 paragraph，整張表消失
{
  const t = el('table', {},
    el('colgroup', {}),
    el('thead', {}),
    el('tbody', {}, tr(td({}, 'A')), tr(td({}, '1')))
  );
  const res = serializeTable(t);
  assert.ok(res.unsupported.includes('TABLE_NO_HEADER'),
    'a table with no header row must degrade, got: ' + JSON.stringify(res));
  assert.strictEqual(res.md, '', 'a degraded table must not emit broken rows');
}

// 非矩形：body 列比表頭寬，序列化後重讀會靜默丟欄
{
  const t = table(tr(th({}, 'A')), [tr(td({}, '1'), td({}, '2'))]);
  const res = serializeTable(t);
  assert.ok(res.unsupported.includes('TABLE_RAGGED'),
    'a non-rectangular table must degrade, got: ' + JSON.stringify(res));
  assert.strictEqual(res.md, '');
}

// 迴歸：正常表格不受影響
{
  const t = table(tr(th({}, 'A'), th({}, 'B')), [tr(td({}, '1'), td({}, '2'))]);
  const res = serializeTable(t);
  assert.deepStrictEqual(res.unsupported, []);
  assert.strictEqual(res.md, '| A | B |\n|---|---|\n| 1 | 2 |');
}

// T8 item 5: the round-trip oracle must BITE. Three hand-written emissions,
// each one a way a table silently stops being a table, and each must be
// rejected — otherwise the assertions added above are decoration.
{
  const rejects = (md, expected, why) => {
    assert.throws(() => assertTableRoundTrips(md, expected, 'negative'), /round trip|table|ONE top-level/,
      'assertTableRoundTrips must reject ' + why + ': ' + JSON.stringify(md));
  };
  // an unescaped '|' splits one cell into two columns
  rejects('| H |\n|---|\n| a|b |', { header: ['H'], rows: [['a|b']] },
    'an unescaped pipe splitting a cell in two');
  // the backslash spelling round-trips through marked too, yet the serializer
  // writes plain-text pipes as '&#124;' — a round trip cannot tell the two
  // spellings apart, which is why the byte assertions above stay. (This line
  // used to call the form "gate-illegal"; paperwork 10.4.0 has no such rule —
  // its G-MD-TABLE-PIPE check asks for '\|' inside code spans, see the
  // v3.17.6 code-pipe cases above.)
  assertTableRoundTrips('| H |\n|---|\n| a\\|b |', { header: ['H'], rows: [['a|b']] },
    'positive control: the backslash form round-trips');
  // an empty header row: re-lexes as a paragraph, the whole table disappears
  rejects('|  |\n||\n| A |', { header: [''], rows: [['A']] },
    'an empty header row that re-lexes as a paragraph');
  // a body row wider than the header: the extra column is silently dropped
  rejects('| A |\n|---|\n| 1 | 2 |', { header: ['A'], rows: [['1', '2']] },
    'a ragged row whose extra column is dropped on re-lex');
}

// ── v3.17.8 F1: a table edit keeps the bytes of every cell it did not change ──
// Before this, any edit re-serialized every cell from the DOM, so a cell
// nobody touched came back respelled: '[' as '\[', a plain-text '\|' as
// '&#124;'. Same meaning, but a git diff full of rows the user never edited.
// Now a current cell reuses the ORIGINAL field's bytes when a private plain
// Marked reads both spellings the same (setCellParser() swaps it for these
// rows), and a row whose cells are all reused, in the original columns, with
// no column widened, is the original line itself.
//
// Every row runs, then the failures are reported together, so a red run names
// each row instead of stopping at the first.
const tableMdLib = require('../lib/editor/table-md.js');
const L = (...l) => l.join('\n');
function cellsOf(row, tag) {
  return row.map((c) => (tag === 'th' ? th : td)({}, ...(Array.isArray(c) ? c : [c])));
}
function domTable(head, rows) {
  return table(tr(...cellsOf(head, 'th')), rows.map((r) => tr(...cellsOf(r, 'td'))));
}
const plainText = (c) => (Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x.textContent)).join('') : c);
// Each fixture: the file's table, the DOM the editor shows after the gesture,
// the bytes it must now write, and `base` — what the serializer wrote before
// v3.17.8, which is what it must still write with no parser (row 9).
const F1_FIXTURES = [
  {
    name: 'F1-1 one cell edited, untouched [ and _ keep their bytes',
    orig: L('| a | b |', '|---|---|', '| x [y] | p _q |', '| r | s |'),
    head: ['a', 'b'], rows: [['x [y]', 'p _q'], ['R', 's']],
    expect: L('| a | b |', '|---|---|', '| x [y] | p _q |', '| R | s |'),
    base: L('| a | b |', '|---|---|', '| x \\[y\\] | p \\_q |', '| R | s |'),
  },
  {
    name: 'F1-2 a plain-text \\| in an untouched row stays \\|',
    orig: L('| a | b |', '|---|---|', '| p \\| q | k |', '| r | s |'),
    head: ['a', 'b'], rows: [['p | q', 'k'], ['R', 's']],
    expect: L('| a | b |', '|---|---|', '| p \\| q | k |', '| R | s |'),
    base: L('| a | b |', '|---|---|', '| p &#124; q | k |', '| R | s |'),
  },
  {
    // Regression guard, green before the fix too: the edited cell itself is
    // never reused (its original reads differently), so it takes the
    // canonical spelling; its neighbour in the same row keeps its bytes.
    name: 'F1-3 the edited cell gets the canonical spelling',
    orig: L('| a | b |', '|---|---|', '| [q] | y_ |'),
    head: ['a', 'b'], rows: [['[q]_w*', 'y_']],
    expect: L('| a | b |', '|---|---|', '| \\[q\\]\\_w\\* | y_ |'),
    base: L('| a | b |', '|---|---|', '| \\[q\\]\\_w\\* | y\\_ |'),
  },
  {
    name: 'F1-4a row inserted above untouched rows',
    orig: L('| a | b |', '|---|---|', '| x [1] | k [1] |', '| y [2] | m |', '| z [3] | n |'),
    head: ['a', 'b'], rows: [['x [1]', 'k [1]'], ['', ''], ['y [2]', 'm'], ['z [3]', 'n']],
    expect: L('| a | b |', '|---|---|', '| x [1] | k [1] |', '|  |  |', '| y [2] | m |', '| z [3] | n |'),
    base: L('| a | b |', '|---|---|', '| x \\[1\\] | k \\[1\\] |', '|  |  |', '| y \\[2\\] | m |', '| z \\[3\\] | n |'),
  },
  {
    name: 'F1-4b row deleted',
    orig: L('| a | b |', '|---|---|', '| x [1] | k [1] |', '| y [2] | m |', '| z [3] | n |'),
    head: ['a', 'b'], rows: [['x [1]', 'k [1]'], ['z [3]', 'n']],
    expect: L('| a | b |', '|---|---|', '| x [1] | k [1] |', '| z [3] | n |'),
    base: L('| a | b |', '|---|---|', '| x \\[1\\] | k \\[1\\] |', '| z \\[3\\] | n |'),
  },
  {
    name: 'F1-4c row moved to the top',
    orig: L('| a | b |', '|---|---|', '| x [1] | k [1] |', '| y [2] | m |', '| z [3] | n |'),
    head: ['a', 'b'], rows: [['z [3]', 'n'], ['x [1]', 'k [1]'], ['y [2]', 'm']],
    expect: L('| a | b |', '|---|---|', '| z [3] | n |', '| x [1] | k [1] |', '| y [2] | m |'),
    base: L('| a | b |', '|---|---|', '| z \\[3\\] | n |', '| x \\[1\\] | k \\[1\\] |', '| y \\[2\\] | m |'),
  },
  {
    name: 'F1-4d row moved down, another row edited',
    orig: L('| a | b |', '|---|---|', '| x [1] | k [1] |', '| y [2] | m |', '| z [3] | n |'),
    head: ['a', 'b'], rows: [['y [2]', 'M'], ['z [3]', 'n'], ['x [1]', 'k [1]']],
    expect: L('| a | b |', '|---|---|', '| y [2] | M |', '| z [3] | n |', '| x [1] | k [1] |'),
    base: L('| a | b |', '|---|---|', '| y \\[2\\] | M |', '| z \\[3\\] | n |', '| x \\[1\\] | k \\[1\\] |'),
  },
  {
    name: 'F1-5a column inserted in the middle',
    orig: L('| a | b |', '|---|---|', '| x [1] | y [2] |'),
    head: ['a', '', 'b'], rows: [['x [1]', '', 'y [2]']],
    expect: L('| a |  | b |', '|---|---|---|', '| x [1] |  | y [2] |'),
    base: L('| a |  | b |', '|---|---|---|', '| x \\[1\\] |  | y \\[2\\] |'),
  },
  {
    name: 'F1-5b column deleted',
    orig: L('| a | b |', '|---|---|', '| x [1] | y [2] |'),
    head: ['b'], rows: [['y [2]']],
    expect: L('| b |', '|---|', '| y [2] |'),
    base: L('| b |', '|---|', '| y \\[2\\] |'),
  },
  {
    name: 'R5 an unescaped ~ is reused only byte-equal; its neighbour is reused',
    orig: L('| a | b |', '|---|---|', '| p~q | [k] |', '| $5 | m |', '| r | s |'),
    head: ['a', 'b'], rows: [['p~q', '[k]'], ['$5', 'm'], ['R', 's']],
    expect: L('| a | b |', '|---|---|', '| p\\~q | [k] |', '| $5 | m |', '| R | s |'),
    base: L('| a | b |', '|---|---|', '| p\\~q | \\[k\\] |', '| $5 | m |', '| R | s |'),
  },
];
const f1Failures = [];
function f1Row(name, fn) {
  try { fn(); } catch (e) { f1Failures.push(name + '\n    ' + String(e.message).split('\n').join('\n    ')); }
}
for (const f of F1_FIXTURES) {
  f1Row(f.name, () => {
    const { md, unsupported } = serializeTable(domTable(f.head, f.rows), f.orig);
    assert.deepStrictEqual(unsupported, []);
    assert.strictEqual(md, f.expect, 'got:\n' + md);
    assertTableRoundTrips(md, { header: f.head.map(plainText), rows: f.rows.map((r) => r.map(plainText)) }, f.name);
  });
}
// F1-5c a column MOVE: the width memory is still refused; no throw, content right.
f1Row('F1-5c column moved', () => {
  const orig = L('| a | b |', '|---|---|', '| x [1] | y [2] |', '| z | w |');
  const { md, unsupported } = serializeTable(domTable(['b', 'a'], [['y [2]', 'x [1]'], ['W', 'z']]), orig);
  assert.deepStrictEqual(unsupported, []);
  assertTableRoundTrips(md, { header: ['b', 'a'], rows: [['y [2]', 'x [1]'], ['W', 'z']] }, 'column moved');
});
// Reuse never hides an unsupported cell: a SUB in an untouched-looking cell
// still reports, so the table falls back to raw-edit as before.
f1Row('F1 unsupported still reported', () => {
  const orig = L('| a | b |', '|---|---|', '| H~2~O | k |');
  const res = serializeTable(table(tr(th({}, 'a'), th({}, 'b')),
    [tr(td({}, 'H', el('sub', {}, '2'), 'O'), td({}, 'K'))]), orig);
  assert.deepStrictEqual(res.unsupported, ['SUB']);
});
// An HTML comment in an untouched cell (paperwork's hwe1 tables carry
// `<!-- [[source, Cl.x]] -->` citation anchors) is invisible, so the DOM walk
// drops it; the cell still reads the same, and it keeps its comment.
f1Row('F1 untouched cell keeps its HTML comment', () => {
  const orig = L('| id | src |', '|---|---|', '| [R-1] | Cl.2<!-- [[ieee, Cl.2]] --><br>quote |', '| r | s |');
  const t = table(tr(th({}, 'id'), th({}, 'src')), [
    tr(td({}, '[R-1]'), td({}, 'Cl.2', { nodeType: 8, nodeName: '#comment', textContent: ' [[ieee, Cl.2]] ' }, el('br', {}), 'quote')),
    tr(td({}, 'R'), td({}, 's'))]);
  const { md, unsupported } = serializeTable(t, orig);
  assert.deepStrictEqual(unsupported, []);
  assert.strictEqual(md, L('| id | src |', '|---|---|', '| [R-1] | Cl.2<!-- [[ieee, Cl.2]] --><br>quote |', '| R | s |'), 'got:\n' + md);
});
// Row 9: no parser → every fixture writes exactly what it wrote before v3.17.8.
f1Row('F1-9 parser off: pre-v3.17.8 bytes', () => {
  tableMdLib.setCellParser(null);
  try {
    for (const f of F1_FIXTURES) {
      const { md } = serializeTable(domTable(f.head, f.rows), f.orig);
      assert.strictEqual(md, f.base, f.name + ' with no parser, got:\n' + md);
    }
  } finally {
    tableMdLib.setCellParser();
  }
});

// Row 10: property. Random small tables of plain text drawn from a pool of
// the characters an escape decision turns on; each cell's ORIGINAL is a
// random spelling of the same text (kept only when marked reads it back as
// that text); one random body cell is then edited. Every untouched cell must
// come back byte for byte, and the whole output must read as the DOM.
f1Row('F1-10 property: untouched cells keep their bytes', () => {
  let seed = 0x5eed1781;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const POOL = ['a', 'b', 'x', 'q', '[', ']', '_', '|', '*', '`', '&', '<', ' ', '1'];
  const SPELL = {
    '[': ['[', '\\['], ']': [']', '\\]'], '_': ['_', '\\_'], '|': ['\\|', '&#124;'],
    '*': ['\\*', '&#42;'], '`': ['\\`', '&#96;'], '&': ['&', '&amp;', '\\&'], '<': ['&lt;', '\\<', '<'],
  };
  const text = () => {
    const n = 1 + Math.floor(rnd() * 6);
    let s = '';
    for (let i = 0; i < n; i++) s += pick(POOL);
    s = s.trim();
    return s === '' ? 'a' : s;
  };
  const spell = (s) => s.split('').map((ch) => (SPELL[ch] ? pick(SPELL[ch]) : ch)).join('');
  // the cell's text as marked shows it, from a one-column table
  const readCell = (field) => {
    const toks = marked.lexer('| h |\n|---|\n| ' + field + ' |');
    if (toks.length !== 1 || toks[0].type !== 'table' || toks[0].rows.length !== 1) return null;
    const html = marked.parseInline(toks[0].rows[0][0].text);
    if (/<[a-z/]/i.test(html)) return null;
    return decodeEntities(html);
  };
  const splitRow = (line) => {
    const out = []; let cur = ''; const inner = line.trim().slice(1, -1);
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === '\\' && i + 1 < inner.length) { cur += c + inner[i + 1]; i++; continue; }
      if (c === '|') { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    out.push(cur);
    return out.map((f) => f.trim());
  };
  let reusedChecked = 0;
  for (let iter = 0; iter < 300; iter++) {
    const cols = 1 + Math.floor(rnd() * 3);
    const nRows = 1 + Math.floor(rnd() * 4);
    const head = []; const body = [];
    for (let c = 0; c < cols; c++) head.push('h' + c + pick(['', '_x', ' [k]']));
    for (let r = 0; r < nRows; r++) { const row = []; for (let c = 0; c < cols; c++) row.push(text()); body.push(row); }
    const fieldOf = (s) => {
      for (let k = 0; k < 6; k++) { const v = spell(s); if (readCell(v) === s) return v; }
      return null;
    };
    const origHead = head.map(fieldOf); const origBody = body.map((r) => r.map(fieldOf));
    if (origHead.some((f) => f === null) || origBody.some((r) => r.some((f) => f === null))) continue;
    const pad = () => ' '.repeat(1 + Math.floor(rnd() * 2));
    const line = (fields) => '|' + fields.map((f) => pad() + f + pad()).join('|') + '|';
    const orig = [line(origHead), '|' + head.map(() => '---').join('|') + '|'].concat(origBody.map(line)).join('\n');
    const er = Math.floor(rnd() * nRows); const ec = Math.floor(rnd() * cols);
    const now = body.map((r) => r.slice()); now[er][ec] = now[er][ec] + 'Q';
    const { md, unsupported } = serializeTable(domTable(head, now), orig);
    assert.deepStrictEqual(unsupported, [], 'iter ' + iter);
    assertTableRoundTrips(md, { header: head, rows: now }, 'property iter ' + iter + ' orig:\n' + orig);
    const outLines = md.split('\n');
    assert.deepStrictEqual(splitRow(outLines[0]), origHead, 'iter ' + iter + ' header bytes, orig:\n' + orig + '\nout:\n' + md);
    for (let r = 0; r < nRows; r++) {
      const got = splitRow(outLines[2 + r]);
      for (let c = 0; c < cols; c++) {
        if (r === er && c === ec) continue;
        assert.strictEqual(got[c], origBody[r][c], 'iter ' + iter + ' cell ' + r + ',' + c + ' bytes, orig:\n' + orig + '\nout:\n' + md);
        reusedChecked++;
      }
    }
  }
  assert.ok(reusedChecked > 300, 'the property must reach enough cells, reached ' + reusedChecked);
});
// v3.17.8 final review I3: a named reference the cell oracle cannot decode
// (`&copy;`, `&rarr;`, `&AMP;`) gave the same reading as the typed TEXT
// `\&copy;`, so editing a cell from © to the literal "&copy;" was overwritten
// by the original bytes. Measured before: `| &copy; 2024 | K |`.
f1Row('F1 I3 edited text that spells an unknown reference is written as typed', () => {
  for (const name of ['copy', 'rarr', 'AMP']) {
    const orig = L('| a | b |', '|---|---|', '| &' + name + '; 2024 | k |');
    const { md } = serializeTable(domTable(['a', 'b'], [['&' + name + '; 2024', 'K']]), orig);
    assert.strictEqual(md, L('| a | b |', '|---|---|', '| \\&' + name + '; 2024 | K |'), name + ' got:\n' + md);
  }
  // an untouched cell with such a reference keeps its bytes: they are byte-equal? no —
  // the DOM shows the decoded character, so it is respelled as before v3.17.8.
  const orig = L('| a | b |', '|---|---|', '| &copy; x | k |');
  const { md } = serializeTable(domTable(['a', 'b'], [['© x', 'K']]), orig);
  assert.strictEqual(md, L('| a | b |', '|---|---|', '| © x | K |'), 'untouched reference cell, got:\n' + md);
});
// v3.17.8 re-review N1: a row whose last '|' is escaped (`| q \|`) is not a
// row the reuse can read. Round 1 split it with that '|' as the closing
// delimiter (to keep the width memory, M2), and an edit from `q |` to `q \`
// then read "the same" as the field ` q \` alone and the original line came
// back: the edit was lost. The edited cell must be written.
f1Row('F1 N1 an edit in a row whose last | is escaped is written', () => {
  {
    const { md } = serializeTable(domTable(['a', 'b'], [['p', 'q \\']]), L('| a | b |', '|---|---|', '| p | q \\|'));
    assert.strictEqual(md, L('| a | b |', '|---|---|', '| p | q \\\\ |'), 'body row, got:\n' + md);
  }
  {
    const { md } = serializeTable(domTable(['a', 'b \\'], [['p', 'q']]), L('| a | b \\|', '|---|---|', '| p | q |'));
    assert.strictEqual(md.split('\n')[0], '| a | b \\\\ |', 'header row, got:\n' + md);
  }
});
// v3.17.8 final review M1: pairing is linear. 3000 rows that all differ
// from the original took ~3 s; a 2000 x 8 table with one edit ~600 ms.
f1Row('F1 M1 large tables stay fast', () => {
  const big = (n, cols, f) => {
    const head = Array.from({ length: cols }, (_, c) => 'h' + c);
    const rows = Array.from({ length: n }, (_, r) => head.map((h, c) => f(r, c)));
    return { head, rows };
  };
  const line = (cells) => '| ' + cells.join(' | ') + ' |';
  const sep = (cols) => '|' + Array(cols).fill('---').join('|') + '|';
  {
    const { head, rows } = big(3000, 8, (r, c) => 'v' + r + '_' + c);
    const orig = [line(head), sep(8)].concat(rows.map((row) => line(row.map((x) => x + 'old')))).join('\n');
    const t0 = Date.now();
    serializeTable(domTable(head, rows), orig);
    const ms = Date.now() - t0;
    assert.ok(ms < 2500, '3000 x 8, every row differs: ' + ms + ' ms');
  }
  {
    const { head, rows } = big(2000, 8, (r, c) => 'a [' + r + '] _' + c);
    const orig = [line(head), sep(8)].concat(rows.map((row) => line(row))).join('\n');
    rows[1000][3] = 'edited';
    serializeTable(domTable(head, rows), orig);   // warm the cache
    rows[1000][4] = 'edited too';
    const t0 = Date.now();
    const { md } = serializeTable(domTable(head, rows), orig);
    const ms = Date.now() - t0;
    assert.ok(ms < 400, '2000 x 8, warm, one more edit: ' + ms + ' ms');
    assert.strictEqual(md.split('\n')[2 + 999], line(rows[999]), 'an untouched row keeps its bytes');
  }
});
// v3.17.9 D7: a line with no '|' after a table is a row to marked (GFM: any
// non-blank line continues the table). `</content>` there is a row whose DOM
// cells are empty, because the browser drops a stray end tag; an edit of the
// table wrote it back as `|  |  |` and the text was gone.
const D7_ORIG = L('| a | b |', '|---|---|', '| p | q |', '</content>');
f1Row('D7 lazy </content> row, no-op keeps the file', () => {
  const { md, unsupported } = serializeTable(domTable(['a', 'b'], [['p', 'q'], ['', '']]), D7_ORIG);
  assert.deepStrictEqual(unsupported, []);
  assert.strictEqual(md, D7_ORIG, 'got:\n' + md);
});
f1Row('D7 lazy </content> row, another cell edited', () => {
  const { md } = serializeTable(domTable(['a', 'b'], [['p', 'qX'], ['', '']]), D7_ORIG);
  assert.strictEqual(md, L('| a | b |', '|---|---|', '| p | qX |', '</content>'), 'got:\n' + md);
});
f1Row('D7 lazy row with visible text keeps its line', () => {
  const orig = L('| a | b |', '|---|---|', '| p | q |', 'see above');
  const { md } = serializeTable(domTable(['a', 'b'], [['P', 'q'], ['see above', '']]), orig);
  assert.strictEqual(md, L('| a | b |', '|---|---|', '| P | q |', 'see above'), 'got:\n' + md);
});
f1Row('D7 lazy row edited in its empty cell keeps the stray tag in cell 1', () => {
  const { md } = serializeTable(domTable(['a', 'b'], [['p', 'q'], ['', 'X']]), D7_ORIG);
  assert.strictEqual(md, L('| a | b |', '|---|---|', '| p | q |', '| </content> | X |'), 'got:\n' + md);
});
f1Row('D7 lazy row in a hand-aligned table is still its own line', () => {
  const orig = L('| name | note |', '|------|------|', '| pq   | rs   |', '</content>');
  const { md } = serializeTable(domTable(['name', 'note'], [['pq', 'rsX'], ['', '']]), orig);
  assert.strictEqual(md, L('| name | note |', '|------|------|', '| pq   | rsX  |', '</content>'), 'got:\n' + md);
});
f1Row('D7 a stray end tag in a piped cell keeps its bytes', () => {
  const orig = L('| a | b |', '|---|---|', '| x</span> | y |');
  const { md } = serializeTable(domTable(['a', 'b'], [['x', 'Y']]), orig);
  assert.strictEqual(md, L('| a | b |', '|---|---|', '| x</span> | Y |'), 'got:\n' + md);
});
// Final review #1: a lazy row's text is in the file only, so it must not
// depend on its column keeping its header name. Renaming column 0 left that
// column unmatched and the row came out `|  |  |`.
f1Row('D7 lazy row survives a renamed first header', () => {
  const orig = L('| Name | Note |', '|---|---|', '| p | q |', '</content>');
  const { md } = serializeTable(domTable(['Label', 'Note'], [['p', 'q'], ['', '']]), orig);
  assert.strictEqual(md, L('| Label | Note |', '|---|---|', '| p | q |', '</content>'), 'got:\n' + md);
});
f1Row('D7 lazy row with visible text, header renamed and its cell edited', () => {
  const orig = L('| Name | Note |', '|---|---|', '| p | q |', 'see above');
  const { md } = serializeTable(domTable(['Label', 'Note'], [['p', 'q'], ['see below', '']]), orig);
  assert.strictEqual(md, L('| Label | Note |', '|---|---|', '| p | q |', '| see below |  |'), 'got:\n' + md);
});
// Re-review R2 / R3: a lazy row is paired by position, never through the
// renamed-header column map (every header renamed left nothing to pair on),
// and an ordinary row whose mapped cells happen to match cannot take it.
f1Row('D7 lazy row survives every header renamed', () => {
  const orig = L('| Name | Note |', '|---|---|', '| p | q |', '</content>');
  const { md } = serializeTable(domTable(['A', 'B'], [['p', 'q'], ['', '']]), orig);
  assert.strictEqual(md, L('| A | B |', '|---|---|', '| p | q |', '</content>'), 'got:\n' + md);
});
f1Row('D7 lazy row survives a renamed one-column header', () => {
  const orig = L('| Name |', '|---|', '| p |', '</content>');
  const { md } = serializeTable(domTable(['A'], [['p'], ['']]), orig);
  assert.strictEqual(md, L('| A |', '|---|', '| p |', '</content>'), 'got:\n' + md);
});
f1Row('D7 lazy row is not taken by a deleted look-alike row', () => {
  const orig = L('| Name | Note |', '|---|---|', '| p |  |', '</content>');
  const { md } = serializeTable(domTable(['A', 'Note'], [['', '']]), orig);
  assert.strictEqual(md, L('| A | Note |', '|---|---|', '</content>'), 'got:\n' + md);
});
// Re-review round 3 C1: a lazy row is paired in the file's order. Paired
// before everything else, a lazy line took the first row that read like it,
// so an ordinary row reading the same as a lazy line below it swapped lines
// with it on a no-op.
f1Row('D7 a row reading like the lazy line below it keeps its order (no-op)', () => {
  const orig = L('| A | B |', '|---|---|', '| see below |  |', 'see below');
  const { md } = serializeTable(domTable(['A', 'B'], [['see below', ''], ['see below', '']]), orig);
  assert.strictEqual(md, orig, 'got:\n' + md);
});
f1Row('D7 an empty row above a lazy </content> keeps its order (no-op)', () => {
  const orig = L('| A | B |', '|---|---|', '|  |  |', '</content>');
  const { md } = serializeTable(domTable(['A', 'B'], [['', ''], ['', '']]), orig);
  assert.strictEqual(md, orig, 'got:\n' + md);
});
f1Row('D7 a row reading like the lazy line below it, header renamed', () => {
  const orig = L('| A | B |', '|---|---|', '| see below |  |', 'see below');
  const { md } = serializeTable(domTable(['X', 'B'], [['see below', ''], ['see below', '']]), orig);
  assert.strictEqual(md, L('| X | B |', '|---|---|', '| see below |  |', 'see below'), 'got:\n' + md);
});
// Guards for the exceptions (green before the fix too): `</br>` is a line
// break to the browser and `</p>` an empty paragraph, so a cell whose break
// was deleted must not read the same as the original and get it back.
f1Row('D7 guard: </br> is not dropped from a reading', () => {
  const orig = L('| a | b |', '|---|---|', '| a</br>b | c |');
  const { md } = serializeTable(domTable(['a', 'b'], [['ab', 'c']]), orig);
  assert.strictEqual(md, L('| a | b |', '|---|---|', '| ab | c |'), 'got:\n' + md);
});
f1Row('D7 guard: a matched end tag still reads as markup', () => {
  const orig = L('| a | b |', '|---|---|', '| <b>x</b> | c |');
  const { md } = serializeTable(domTable(['a', 'b'], [['x', 'c']]), orig);
  assert.strictEqual(md, L('| a | b |', '|---|---|', '| x | c |'), 'got:\n' + md);
});
// v3.17.10 D9: the comment in a cell is written back by the DOM walk, so an
// edit to that cell, or to another cell of a row that is then not reused
// whole, keeps it. Measured on c8e6025 in the real editor: `one <!-- keep -->`
// + Z in that cell -> `oneZ`; + Z in the next cell -> `one ` (untouched cell).
{
  const cm = (d) => ({ nodeType: 8, nodeName: '#comment', textContent: d });
  const raw = (r) => cm('md2doc-raw:' + encodeURIComponent(r));
  const orig = L('| a | b |', '|---|---|', '| one <!-- keep --> | two |');
  const head = () => tr(th({}, 'a'), th({}, 'b'));
  f1Row('v31710 D9 typed after the comment in that cell', () => {
    const { md, unsupported } = serializeTable(table(head(), [tr(td({}, 'one ', cm(' keep '), 'Z'), td({}, 'two'))]), orig);
    assert.deepStrictEqual(unsupported, []);
    assert.strictEqual(md, L('| a | b |', '|---|---|', '| one <!-- keep -->Z | two |'), 'got:\n' + md);
  });
  f1Row('v31710 D9 typed before the comment in that cell', () => {
    const { md } = serializeTable(table(head(), [tr(td({}, 'oneZ ', cm(' keep ')), td({}, 'two'))]), orig);
    assert.strictEqual(md, L('| a | b |', '|---|---|', '| oneZ <!-- keep --> | two |'), 'got:\n' + md);
  });
  f1Row('v31710 D9 another cell of the row edited', () => {
    const { md } = serializeTable(table(head(), [tr(td({}, 'one ', cm(' keep ')), td({}, 'twoZ'))]), orig);
    assert.strictEqual(md, L('| a | b |', '|---|---|', '| one <!-- keep --> | twoZ |'), 'got:\n' + md);
  });
  f1Row('v31710 M-a stray end tag in an edited cell', () => {
    const o = L('| a | b |', '|---|---|', '| t</span>wo | k |');
    const { md } = serializeTable(table(head(), [tr(td({}, 't', raw('</span>'), 'woZ'), td({}, 'k'))]), o);
    assert.strictEqual(md, L('| a | b |', '|---|---|', '| t</span>woZ | k |'), 'got:\n' + md);
  });
  f1Row('v31710 guard (green since v3.17.9 R6): stray end tag, other cell edited', () => {
    const o = L('| a | b |', '|---|---|', '| t</span>wo | k |');
    const { md } = serializeTable(table(head(), [tr(td({}, 't', raw('</span>'), 'wo'), td({}, 'kZ'))]), o);
    assert.strictEqual(md, L('| a | b |', '|---|---|', '| t</span>wo | kZ |'), 'got:\n' + md);
  });
}

if (f1Failures.length) {
  throw new Error('v3.17.8 F1 rows failed (' + f1Failures.length + '):\n  ' + f1Failures.join('\n  '));
}

console.log('table-md.test.js OK');
