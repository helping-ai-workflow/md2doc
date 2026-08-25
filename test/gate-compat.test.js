'use strict';
// gate-compat.test.js — Phase-2 Task 6: a PERMANENT tripwire fossilizing the
// paperwork gate's line-level table contract against table-md.js's /
// inline-md.js's actual emission. This is deliberately NOT a normal feature
// test: it doesn't exercise any Task 6 (row/col/alignment) behavior — it
// pins down invariants that Tasks 2 (inline-md.js) and 5 (table-md.js)
// already established, so a FUTURE change to either can never silently
// regress what the paperwork consumer's gate assumes about md2doc's own
// table markdown output:
//
//   1. every emitted table row is ONE physical line, and starts with '|'
//   2. no emitted line ends in whitespace
//   3. a table emission contains ONLY '|'-prefixed lines (no orphan cell
//      lines — i.e. no line inside a table emission is anything other than
//      a full '|'-delimited row)
//   4. a literal '|' inside a cell is emitted as '&#124;', never a bare
//      backslash-escaped '\|' (a different, NOT-supported escaping
//      convention some other markdown table renderers use)
//
// Per the task-6 brief: this file may be GREEN immediately if Tasks 2/5
// were implemented correctly — that's expected and fine, it's a tripwire
// against regression, not a red-first feature test. (It stayed green when
// run against this worktree's Task 2/5 code, unmodified by Task 6.)
const assert = require('assert');
const tableMd = require('../lib/editor/table-md.js');
const inlineMd = require('../lib/editor/inline-md.js');

// same minimal element stub as test/table-md.test.js / test/inline-md.test.js
function el(name, attrs, ...children) {
  return {
    nodeType: 1, nodeName: name.toUpperCase(),
    childNodes: children.map((c) => (typeof c === 'string' ? { nodeType: 3, textContent: c } : c)),
    getAttribute: (k) => ((attrs || {})[k] !== undefined ? attrs[k] : null),
    get textContent() {
      return this.childNodes.map((c) => c.textContent).join('');
    },
  };
}
function th(attrs, ...children) { return el('th', attrs, ...children); }
function td(attrs, ...children) { return el('td', attrs, ...children); }
function tr(...children) { return el('tr', {}, ...children); }
function table(headerRow, bodyRows) {
  return el('table', {}, el('colgroup', {}), el('thead', {}, headerRow), el('tbody', {}, ...bodyRows));
}

// ── gate assertions (the fossilized contract itself) ─────────────────────

function assertNoTrailingWhitespace(text, label) {
  text.split('\n').forEach((line, i) => {
    assert.strictEqual(line, line.replace(/[ \t]+$/, ''),
      label + ': line ' + i + ' ends in whitespace: ' + JSON.stringify(line));
  });
}

// A table emission must consist ENTIRELY of '|'-prefixed physical lines —
// covers both "every row starts with |" and "no orphan cell lines" (a stray
// non-'|' line would mean some cell's content injected a raw line break the
// gate can't parse as a table row).
function assertOnlyPipePrefixedLines(md, label) {
  md.split('\n').forEach((line, i) => {
    assert.ok(line.startsWith('|'),
      label + ': line ' + i + ' of a table emission must start with |: ' + JSON.stringify(line));
  });
}

function assertNoBareEscapedPipe(md, label) {
  assert.ok(!/\\\|/.test(md),
    label + ': a literal pipe must be emitted as &#124;, never the escaped-bar form \\|, got:\n' + md);
}

function assertGateCompatTable(md, label) {
  assertOnlyPipePrefixedLines(md, label);
  assertNoTrailingWhitespace(md, label);
  assertNoBareEscapedPipe(md, label);
}

// ── representative serializeTable() outputs ───────────────────────────────

// 1. plain table, multiple rows/columns — the common case.
{
  const t = table(
    tr(th({}, 'Name'), th({}, 'Note')),
    [tr(td({}, 'Alice'), td({}, 'hello')), tr(td({}, 'Bob'), td({}, 'world'))]
  );
  const { md } = tableMd.serializeTable(t);
  assertGateCompatTable(md, 'plain table');
}

// 2. every alignment variant (left/right/center/default) in one row.
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
  const { md } = tableMd.serializeTable(t);
  assertGateCompatTable(md, 'alignment variants');
}

// 3. a literal '|' inside a cell — must round-trip as '&#124;', never '\|'.
{
  const t = table(tr(th({}, 'H')), [tr(td({}, 'a|b|c'))]);
  const { md } = tableMd.serializeTable(t);
  assertGateCompatTable(md, 'literal pipe in cell');
  assert.ok(md.includes('&#124;'), 'literal pipe in cell: must contain the &#124; escape, got:\n' + md);
}

// 4. a <br> cell (multi-line content represented as the LITERAL '<br>'
// token, never a raw embedded newline) — the mechanism inline-md.js /
// table-md.js actually use for a line break inside one table cell.
{
  const t = table(tr(th({}, 'H')), [tr(td({}, 'line one', el('br', {}), 'line two'))]);
  const { md } = tableMd.serializeTable(t);
  assertGateCompatTable(md, 'br-split cell');
  assert.ok(md.includes('<br>'), 'br-split cell: must contain the literal <br> token, got:\n' + md);
}

// 5. rich inline content (bold/italic/code/link/citation) inside cells —
// representative of what a real table-editing session (Task 5/6) commits.
{
  const t = table(
    tr(th({}, 'H')),
    [tr(td({}, 'a ', el('strong', {}, 'bold'), ' ', el('em', {}, 'em'), ' ',
      el('code', {}, 'code_id'), ' ', el('a', { href: 'http://x' }, 'link'), ' ',
      el('a', { href: '#ref-1' }, '[ref-1, §2]')))]
  );
  const { md } = tableMd.serializeTable(t);
  assertGateCompatTable(md, 'rich inline content in cell');
}

// 6. CJK / multi-byte content — trailing-whitespace and pipe-prefix
// invariants must hold regardless of byte width.
{
  const t = table(tr(th({}, '欄位')), [tr(td({}, '中文內容 with mixed text'))]);
  const { md } = tableMd.serializeTable(t);
  assertGateCompatTable(md, 'CJK content');
}

// 7. header-only table (no body rows) — still a valid, gate-compatible emission.
{
  const t = table(tr(th({}, 'Only')), []);
  const { md } = tableMd.serializeTable(t);
  assertGateCompatTable(md, 'header-only table');
}

// 8. Finding 1 (post-review): a cell whose TEXT NODE contains a literal
// '\n' — e.g. from a paste path that bypassed client.js's <br>-segmentation
// — must still emit as a SINGLE physical row (no orphan cell line). The
// embedded newline becomes the literal '<br>' token, same mechanism as
// case 4 above.
{
  const t = table(tr(th({}, 'H')), [tr(td({}, 'line one\nline two'))]);
  const { md } = tableMd.serializeTable(t);
  assertGateCompatTable(md, 'raw-newline-in-text-node cell');
  assert.ok(md.includes('<br>'), 'raw-newline-in-text-node cell: must contain the literal <br> token, got:\n' + md);
}

// ── representative serializeInline() outputs (non-table context) ─────────
// serializeInline() output becomes ONE line of the emitted document (a
// paragraph/heading's own line, or — via table-md.js's serializeRow() above
// — one '|'-delimited field of a table row); the trailing-whitespace
// invariant applies here too, independent of the table-row-shape rules
// above (which don't apply outside a table emission).

{
  const p = el('p', {}, 'a ', el('strong', {}, 'b'), ' c ', el('code', {}, 'd'), ' ',
    el('a', { href: 'http://x' }, 'e'));
  const { md } = inlineMd.serializeInline(p);
  assertNoTrailingWhitespace(md, 'paragraph inline content');
}

{
  // citation form — exercises the [[...]] round-trip path.
  const p = el('p', {}, el('a', { href: '#ref-1' }, '[ref-1, §2]'));
  const { md } = inlineMd.serializeInline(p);
  assertNoTrailingWhitespace(md, 'citation inline content');
}

console.log('gate-compat.test.js OK');
