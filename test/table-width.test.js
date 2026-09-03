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

// ── 2026-09-02 review round 1: cases 9-16 ───────────────────────────────
// The 8 cases above are the brief's, written against the brief's own
// never-executed Step 3-5 code. Every divergence from that code — the
// uniform-AND->3 width gate, header-TEXT matching instead of index,
// the all-or-nothing match rule, sepFallbackNatural, and the matchedSep
// separator fallback — was previously exercised only indirectly, through
// a Puppeteer file this worktree cannot run fast. These cases pin each of
// those divergences directly, in pure node, sub-millisecond and
// contention-immune.

// 9. A NON-uniform original column (real per-row content widths differ —
//    v3.0.0's own un-padded minimal form, not a hand-aligned one) is NOT a
//    width source: editing one cell must not pad the header, the
//    separator, or an untouched row out to some borrowed width.
{
  const original = [
    '| Name | Note |',
    '|---|---|',
    '| Alice | hello |',
    '| Bob | world |',
  ].join('\n');
  const t = table(tr(th({}, 'Name'), th({}, 'Note')),
    [tr(td({}, 'Alice!'), td({}, 'hello')), tr(td({}, 'Bob'), td({}, 'world'))]);
  const { md } = serializeTable(t, original);
  assert.strictEqual(md, [
    '| Name | Note |',
    '|---|---|',
    '| Alice! | hello |',
    '| Bob | world |',
  ].join('\n'), 'a non-uniform column must stay minimal-form on every row, got:\n' + md);
}

// 10. A UNIFORM width of exactly 3 is what this serializer's OWN minimal
//     form always produces (' a ' and '---' are both 3 chars) — it is not
//     evidence of deliberate hand-alignment (C2, review round 1). Growing
//     one cell must not re-widen the header, separator, or an untouched
//     row: v3.0.0 left all three byte-identical, and this must too.
{
  const original = [
    '| A | B |',
    '|---|---|',
    '| 1 | 2 |',
    '| 3 | 4 |',
  ].join('\n');
  const t = table(tr(th({}, 'A'), th({}, 'B')),
    [tr(td({}, 'longer'), td({}, '2')), tr(td({}, '3'), td({}, '4'))]);
  const { md } = serializeTable(t, original);
  assert.strictEqual(md, [
    '| A | B |',
    '|---|---|',
    '| longer | 2 |',
    '| 3 | 4 |',
  ].join('\n'), 'a uniform-3 column is minimal form, not alignment — header/separator/untouched row must not re-widen, got:\n' + md);
}

// 11. A deliberately BLANK, hand-padded cell (width > 3) must survive an
//     edit ELSEWHERE in the table byte-identical — padField() must reproduce
//     its full original width, never collapse it to a bare 2-char field.
{
  const original = [
    '| Name  | Age |',
    '|-------|-----|',
    '| Alice |     |',
    '| Bob   | 25  |',
  ].join('\n');
  const t = table(tr(th({}, 'Name'), th({}, 'Age')),
    [tr(td({}, 'Alice'), td({}, '')), tr(td({}, 'Bob'), td({}, '26'))]);
  const { md } = serializeTable(t, original);
  assert.strictEqual(md, [
    '| Name  | Age |',
    '|-------|-----|',
    '| Alice |     |',
    '| Bob   | 26  |',
  ].join('\n'), 'a blank hand-aligned cell must keep its own width untouched, got:\n' + md);
}

// 12. DUPLICATE header text ('X' twice) must not cross-contaminate: the
//     greedy walk's monotonic pointer pairs each CURRENT 'X' with the
//     NEXT unconsumed original 'X', by position, never both with the
//     first. Growing column 0's cell must widen ONLY column 0.
{
  const original = [
    '| X   | X     |',
    '|-----|-------|',
    '| a   | bb    |',
  ].join('\n');
  const t = table(tr(th({}, 'X'), th({}, 'X')),
    [tr(td({}, 'abcd'), td({}, 'bb'))]);
  const { md } = serializeTable(t, original);
  assert.strictEqual(md, [
    '| X    | X     |',
    '|------|-------|',
    '| abcd | bb    |',
  ].join('\n'), 'duplicate headers must not swap widths with each other, got:\n' + md);
}

// 13. An EMPTY header field ('' in both original and current) must still
//     match by text (both trim to '') and keep its column's width; editing
//     a DIFFERENT cell must leave the empty-header column untouched.
{
  const original = [
    '|      | B   |',
    '|------|-----|',
    '| a    | bb  |',
  ].join('\n');
  const t = table(tr(th({}, ''), th({}, 'B')),
    [tr(td({}, 'a'), td({}, 'bbb'))]);
  const { md } = serializeTable(t, original);
  assert.strictEqual(md, [
    '|      | B   |',
    '|------|-----|',
    '| a    | bbb |',
  ].join('\n'), 'an empty header must still match by text and keep its column width, got:\n' + md);
}

// 14. v3.0.2: a RENAMED header no longer discards the whole table's width
//     memory. The forward-scan match below lines each current column up
//     with the original column of the same name, skipping over originals
//     that no longer appear; a name that is absent from the original
//     entirely (a rename, or an insert) is simply unmatched and falls to
//     independent per-row minimal form, while its NEIGHBOURS keep theirs.
//     Superseded the 2026-09-02 review round-1 ruling, deliberately.
{
  const original = [
    '| Name  | Age |',
    '|-------|-----|',
    '| Alice | 30  |',
  ].join('\n');
  const t = table(tr(th({}, 'Full Name'), th({}, 'Age')),
    [tr(td({}, 'Alice'), td({}, '30'))]);
  const { md } = serializeTable(t, original);
  assert.strictEqual(md, [
    '| Full Name | Age |',
    '|---|-----|',
    '| Alice | 30  |',
  ].join('\n'), 'a renamed header must keep the OTHER columns\' widths, got:\n' + md);
}

// 15. v3.0.2: a DELETED column no longer discards the whole table's width
//     memory either. The forward-scan skips the deleted original outright;
//     every surviving column keeps the width it had. This is the defect
//     PR #25 named as "do it before autosave lands, not after".
{
  const original = [
    '| Name  | Age | City |',
    '|-------|-----|------|',
    '| Alice | 30  | NY   |',
  ].join('\n');
  const t = table(tr(th({}, 'Name'), th({}, 'Age')),
    [tr(td({}, 'Alice'), td({}, '30'))]);
  const { md } = serializeTable(t, original);
  assert.strictEqual(md, [
    '| Name  | Age |',
    '|-------|-----|',
    '| Alice | 30  |',
  ].join('\n'), 'a deleted column must leave the survivors\' widths alone, got:\n' + md);
}

// 16. C1 (review round 1, Critical): a NARROW hand-aligned separator
//     (center-align width < 5, e.g. ':--:' at width 4, or ':-:' at width 3)
//     must NOT be floored up to the old unconditional 3-dash minimum. With
//     nothing changed at all, the output must be byte-identical — the
//     reviewer's exact regression: this table used to get silently
//     rewritten on every click-in/click-away, which meant `commitEdit()`
//     wrote the file and pushed an undo entry with nothing actually
//     touched. marked.lexer() confirms ':-:' (width 3) is legal GFM,
//     lexing as one table token with `align === 'center'`.
{
  const original = ['| ID | OK |', '|:--:|:--:|', '| 1  | y  |'].join('\n');
  const t = table(
    tr(th({ style: 'text-align:center' }, 'ID'), th({ style: 'text-align:center' }, 'OK')),
    [tr(td({ style: 'text-align:center' }, '1'), td({ style: 'text-align:center' }, 'y'))]);
  const { md } = serializeTable(t, original);
  assert.strictEqual(md, original,
    'an unchanged narrow aligned separator must stay byte-identical, not be floored to 3 dashes, got:\n' + md);

  // The 1-dash form is legal GFM too (reviewer-verified) — pin it directly.
  const toks = marked.lexer('| ID | OK |\n|:-:|:-:|\n| 1  | y  |');
  assert.strictEqual(toks.length, 1);
  assert.strictEqual(toks[0].type, 'table');
  assert.deepStrictEqual(toks[0].align, ['center', 'center']);
}

// 17. I1 (review round 1): a column that IS matched to its original (same
//     header text) but whose header/body rows are NOT uniform must still
//     fall back to the ORIGINAL SEPARATOR's own field width — not the bare
//     3-dash minimal — when it isn't itself a width source. 'Description'
//     is ragged (body rows differ wildly in length) so widths[1] is
//     undefined, but its original separator was 13 dashes wide; editing a
//     cell that never touches the separator line must still reproduce
//     those 13 dashes, not collapse to 3.
{
  const original = [
    '| Name  | Description |',
    '|-------|-------------|',
    '| Alice | short       |',
    '| Bob   | a much longer description here |',
  ].join('\n');
  const t = table(tr(th({}, 'Name'), th({}, 'Description')),
    [tr(td({}, 'Alice'), td({}, 'short')),
     tr(td({}, 'Bob'), td({}, 'a much longer description here'))]);
  const { md } = serializeTable(t, original);
  const lines = md.split('\n');
  assert.strictEqual(lines[1], '|-------|-------------|',
    'a matched-but-non-uniform column must reproduce its ORIGINAL separator width, not the 3-dash minimal, got:\n' + md);
  assert.strictEqual(lines[0], '| Name  | Description |', 'header untouched, got:\n' + md);
}

// ── 2026-09-02 final whole-branch review: cases 18-19 (F1, Critical) ─────
// A SPACE-PADDED separator row ('| ----- | --- |') is what Prettier,
// prettier-plugin-markdown and VS Code's table formatter all emit — the most
// common machine-aligned markdown table in the wild. Before F1, sepCellFor()
// rebuilt every separator field as a bare dash run of the target width, so
// '| ----- | --- |' came back as '|-------|-----|': same width, different
// bytes. commitRangeEdit() short-circuits only on a byte-identical result, so
// that is a REAL op — undo entry pushed, `lines` replaced, next save writes
// it. Clicking into such a table and clicking away modified the user's file.
//
// The fix reuses the ORIGINAL separator field verbatim when the field already
// expresses the current alignment AND the target width equals that field's
// own length. Any width growth or alignment change still falls through to
// sepCellFor() unchanged (cases 5 and 12 pin that).

// 18. A PADDED PLAIN separator, nothing changed → byte-identical.
{
  const original = [
    '| Name  | Age |',
    '| ----- | --- |',
    '| Alice | 30  |',
  ].join('\n');
  const t = table(tr(th({}, 'Name'), th({}, 'Age')),
    [tr(td({}, 'Alice'), td({}, '30'))]);
  const { md } = serializeTable(t, original);
  assert.strictEqual(md, original,
    'a padded plain separator must survive a no-op byte-identical, got:\n' + md);
}

// 19. A PADDED ALIGNED separator (':----' / '--:' with padding), nothing
//     changed → byte-identical. The colons must be read off the ORIGINAL
//     field, not re-synthesised flush against the delimiters.
{
  const original = [
    '| Name  | Age |',
    '| :---- | --: |',
    '| Alice | 30  |',
  ].join('\n');
  const t = table(
    tr(th({ style: 'text-align:left' }, 'Name'),
       th({ style: 'text-align:right' }, 'Age')),
    [tr(td({ style: 'text-align:left' }, 'Alice'),
        td({ style: 'text-align:right' }, '30'))]);
  const { md } = serializeTable(t, original);
  assert.strictEqual(md, original,
    'a padded aligned separator must survive a no-op byte-identical, got:\n' + md);

  // And the padded aligned form is legal GFM in the first place.
  const toks = marked.lexer(original);
  assert.strictEqual(toks.length, 1);
  assert.strictEqual(toks[0].type, 'table');
  assert.deepStrictEqual(toks[0].align, ['left', 'right']);
}

// 20. v3.0.2: a column deleted from the MIDDLE — the forward scan must skip
//     the vanished original rather than stall on it.
{
  const original = [
    '| Name  | Age | City |',
    '|-------|-----|------|',
    '| Alice | 30  | NY   |',
  ].join('\n');
  const t = table(tr(th({}, 'Name'), th({}, 'City')),
    [tr(td({}, 'Alice'), td({}, 'NY'))]);
  const { md } = serializeTable(t, original);
  assert.strictEqual(md, [
    '| Name  | City |',
    '|-------|------|',
    '| Alice | NY   |',
  ].join('\n'), 'a mid-table column delete must keep the survivors aligned, got:\n' + md);
}

// 21. v3.0.2 GUARD: a column REORDER still discards the whole table. This
//     is the case the `moved` test exists for — two of the three headers
//     are byte-identical to their originals, and keeping their padding
//     would leave it on columns that have moved out from under it.
{
  const original = [
    '| Name  | Age | City |',
    '|-------|-----|------|',
    '| Alice | 30  | NY   |',
  ].join('\n');
  const t = table(tr(th({}, 'City'), th({}, 'Name'), th({}, 'Age')),
    [tr(td({}, 'NY'), td({}, 'Alice'), td({}, '30'))]);
  const { md } = serializeTable(t, original);
  assert.strictEqual(md, [
    '| City | Name | Age |',
    '|---|---|---|',
    '| NY | Alice | 30 |',
  ].join('\n'), 'a column REORDER must still fall back to minimal form, got:\n' + md);
}

// 22. v3.0.2 REGRESSION GUARD: inserting a column mid-table is byte-for-byte
//     what v3.0.1 already emitted. (This case was green before v3.0.2 too —
//     it is here to stay green, not to go red first.)
{
  const original = [
    '| Name  | Age |',
    '|-------|-----|',
    '| Alice | 30  |',
  ].join('\n');
  const t = table(tr(th({}, 'Name'), th({}, ''), th({}, 'Age')),
    [tr(td({}, 'Alice'), td({}, ''), td({}, '30'))]);
  const { md } = serializeTable(t, original);
  assert.strictEqual(md, [
    '| Name  |  | Age |',
    '|-------|---|-----|',
    '| Alice |  | 30  |',
  ].join('\n'), 'a mid-table column INSERT must be unchanged from v3.0.1, got:\n' + md);
}

// 23. v3.0.2 REGRESSION GUARD for the empty-name exemption: a table that
//     ALREADY holds a blank header, with another column inserted next to
//     it. Without the `name !== ''` exemption in the `moved` test, the new
//     column's '' finds the existing blank header in the original, the
//     refusal fires, and every hand-aligned width in the table is lost.
{
  const original = [
    '|      | B   |',
    '|------|-----|',
    '| a    | bb  |',
  ].join('\n');
  const t = table(tr(th({}, ''), th({}, ''), th({}, 'B')),
    [tr(td({}, 'a'), td({}, ''), td({}, 'bb'))]);
  const { md } = serializeTable(t, original);
  assert.strictEqual(md, [
    '|      |  | B   |',
    '|------|---|-----|',
    '| a    |  | bb  |',
  ].join('\n'), 'inserting beside an existing BLANK header must not trip the reorder refusal, got:\n' + md);
}

// 24. v3.0.2 REGRESSION GUARD: a table with DUPLICATE header names, nothing
//     edited, keeps every width. The forward scan's monotonic pointer pairs
//     the second 'X' with the second original 'X', so no name is unmatched
//     and the refusal never fires. (See the CHANGELOG's known issue: after
//     a DELETE such a table can inherit the wrong same-named column's
//     width. Not fixed — text matching cannot tell the instances apart.)
{
  const original = [
    '| X    | Y   | X        |',
    '|------|-----|----------|',
    '| a    | b   | bb       |',
  ].join('\n');
  const t = table(tr(th({}, 'X'), th({}, 'Y'), th({}, 'X')),
    [tr(td({}, 'a'), td({}, 'b'), td({}, 'bb'))]);
  const { md } = serializeTable(t, original);
  assert.strictEqual(md, original,
    'an untouched duplicate-header table must be byte-identical, got:\n' + md);
}

console.log('table-width: all cases OK');
