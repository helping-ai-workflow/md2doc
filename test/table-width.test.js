'use strict';
// v3.0.1: serializeTable() must reuse the ORIGINAL column widths.
//
// Why this file exists: the emitter's minimal form ('| a | b |', '|---|')
// rewrites every line of a hand-aligned table the moment one cell changes.
// With v3.1.0's debounce autosave that goes from occasional to constant, so
// "touch one cell, dirty the whole table" becomes the dominant diff source.
//
// Mutation-kill level, per the project's test bar: this path changes the
// BYTES written to the user's file, so each case pins exact output rather
// than a property. A mutation that pads by one space too many, or that
// truncates a grown cell, or that silently drops alignment, must fail here.
const assert = require('assert');
const { marked } = require('marked');
const { serializeTable } = require('../lib/editor/table-md.js');

marked.setOptions({ gfm: true, breaks: false });

// Same minimal element stub as test/table-md.test.js — table-md.js is
// constrained to childNodes/nodeType/nodeName/textContent/getAttribute.
function el(name, attrs, ...children) {
  return {
    nodeType: 1, nodeName: name.toUpperCase(),
    childNodes: children.map((c) => typeof c === 'string' ? { nodeType: 3, textContent: c } : c),
    getAttribute: (k) => (attrs || {})[k] !== undefined ? attrs[k] : null,
    get textContent() { return this.childNodes.map((c) => c.textContent).join(''); },
  };
}
function th(attrs, ...children) { return el('th', attrs, ...children); }
function td(attrs, ...children) { return el('td', attrs, ...children); }
function tr(...children) { return el('tr', {}, ...children); }
function table(headerRow, bodyRows) {
  return el('table', {}, el('colgroup', {}), el('thead', {}, headerRow), el('tbody', {}, ...bodyRows));
}

// 1. No original given → byte-identical to v3.0.0's minimal form.
{
  const t = table(tr(th({}, 'Col A'), th({}, 'Col B')),
    [tr(td({}, '1'), td({}, '2'))]);
  const { md, unsupported } = serializeTable(t);
  assert.deepStrictEqual(unsupported, []);
  assert.strictEqual(md, ['| Col A | Col B |', '|---|---|', '| 1 | 2 |'].join('\n'),
    'no original must still emit minimal form');
}

// 2. Hand-aligned original, NOTHING changed → byte-identical round trip.
{
  const original = [
    '| Name  | Age |',
    '|-------|-----|',
    '| Alice | 30  |',
  ].join('\n');
  const t = table(tr(th({}, 'Name'), th({}, 'Age')),
    [tr(td({}, 'Alice'), td({}, '30'))]);
  const { md } = serializeTable(t, original);
  assert.strictEqual(md, original,
    'an unchanged aligned table must round-trip byte-identical, got:\n' + md);
}

// 3. Hand-aligned original, ONE cell changed → only that cell's text moves.
{
  const original = [
    '| Name  | Age |',
    '|-------|-----|',
    '| Alice | 30  |',
  ].join('\n');
  const t = table(tr(th({}, 'Name'), th({}, 'Age')),
    [tr(td({}, 'Alice'), td({}, '31'))]);
  const { md } = serializeTable(t, original);
  assert.strictEqual(md, [
    '| Name  | Age |',
    '|-------|-----|',
    '| Alice | 31  |',
  ].join('\n'), 'changing one cell must leave every other byte alone, got:\n' + md);
}

// 4. Alignment colons are preserved AND keep the original width.
{
  const original = [
    '| Left    | Right   | Center  |',
    '|:--------|--------:|:-------:|',
    '| a       | b       | c       |',
  ].join('\n');
  const t = table(
    tr(th({ style: 'text-align:left' }, 'Left'),
       th({ style: 'text-align:right' }, 'Right'),
       th({ style: 'text-align:center' }, 'Center')),
    [tr(td({ style: 'text-align:left' }, 'a'),
        td({ style: 'text-align:right' }, 'b'),
        td({ style: 'text-align:center' }, 'c'))]);
  const { md } = serializeTable(t, original);
  assert.strictEqual(md, original,
    'aligned separators must keep both their colons and their width, got:\n' + md);
}

// 5. A cell that GREW past the original column widens that field — never
//    truncates. Padding is a minimum, not a maximum.
{
  const original = [
    '| Name  | Age |',
    '|-------|-----|',
    '| Alice | 30  |',
  ].join('\n');
  const t = table(tr(th({}, 'Name'), th({}, 'Age')),
    [tr(td({}, 'Bartholomew'), td({}, '30'))]);
  const { md } = serializeTable(t, original);
  assert.strictEqual(md, [
    '| Name        | Age |',
    '|-------------|-----|',
    '| Bartholomew | 30  |',
  ].join('\n'), 'a grown cell must widen its column, never be truncated, got:\n' + md);
}

// 6. A NEW column has no original width and falls back to minimal form.
{
  const original = [
    '| Name  | Age |',
    '|-------|-----|',
    '| Alice | 30  |',
  ].join('\n');
  const t = table(tr(th({}, 'Name'), th({}, 'Age'), th({}, 'City')),
    [tr(td({}, 'Alice'), td({}, '30'), td({}, 'NY'))]);
  const { md } = serializeTable(t, original);
  assert.strictEqual(md, [
    '| Name  | Age | City |',
    '|-------|-----|------|',
    '| Alice | 30  | NY |',
  ].join('\n'), 'a new column takes minimal form, existing ones keep their width, got:\n' + md);
}

// 7. A RAGGED or unparseable original is not a width source — fall back to
//    minimal form rather than guess.
{
  const t = table(tr(th({}, 'A'), th({}, 'B')), [tr(td({}, '1'), td({}, '2'))]);
  const { md } = serializeTable(t, 'not a table at all\njust prose\n');
  assert.strictEqual(md, ['| A | B |', '|---|---|', '| 1 | 2 |'].join('\n'),
    'an unparseable original must fall back to minimal form, got:\n' + md);
}

// 8. The emitted markdown still re-lexes as exactly one table token — the
//    padding must never break the GFM table shape.
{
  const original = [
    '| Name  | Age |',
    '|-------|-----|',
    '| Alice | 30  |',
  ].join('\n');
  const t = table(tr(th({}, 'Name'), th({}, 'Age')),
    [tr(td({}, 'Alice'), td({}, '31'))]);
  const { md } = serializeTable(t, original);
  const toks = marked.lexer(md);
  assert.strictEqual(toks.length, 1, 'padded output must re-lex as one token');
  assert.strictEqual(toks[0].type, 'table', 'and that token must be a table');
  assert.deepStrictEqual(toks[0].header.map((h) => h.text), ['Name', 'Age']);
  assert.deepStrictEqual(toks[0].rows.map((r) => r.map((c) => c.text)), [['Alice', '31']]);
}

console.log('table-width: all cases OK');
