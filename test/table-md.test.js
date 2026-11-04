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

console.log('table-md.test.js OK');
