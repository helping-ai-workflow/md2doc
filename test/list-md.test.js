'use strict';
const assert = require('assert');
const { marked } = require('marked');
const { serializeList, serializeBlocks } = require('../lib/editor/list-md.js');

// minimal element stub — same pattern as test/table-md.test.js / test/inline-md.test.js
function el(name, attrs, ...children) {
  const a = attrs || {};
  const classes = (a.class || '').split(/\s+/).filter(Boolean);
  return {
    nodeType: 1, nodeName: name.toUpperCase(),
    childNodes: children.map(c => typeof c === 'string' ? { nodeType: 3, textContent: c } : c),
    getAttribute: (k) => a[k] !== undefined ? a[k] : null,
    classList: { contains: (c) => classes.indexOf(c) !== -1 },
    get textContent() {
      return this.childNodes.map(c => c.textContent).join('');
    },
  };
}
function text(s) { return { nodeType: 3, textContent: s }; }
function li(...children) { return el('li', {}, ...children); }
function ul(...children) { return el('ul', {}, ...children); }
function ol(...children) { return el('ol', {}, ...children); }

// flat block helpers — the shape lib/md2doc.js will emit in Task 3
function liBlock({ id = '0', type = 'ul', task = false, checked = null, indent = 0, armed = false }, ...inner) {
  const kids = [el('span', { class: 'ed-li-marker' }, '\u2022')];
  if (task) kids.push(el('span', { class: 'ed-li-check', 'data-checked': checked ? '1' : '0' }));
  kids.push(el('div', { class: armed ? 'ed-li-text ed-wys-armed' : 'ed-li-text' }, ...inner));
  return el('div', {
    class: 'ed-block', 'data-block-id': id, 'data-block-type': 'li',
    'data-list-type': type, 'data-task': task ? '1' : '0', 'data-indent': String(indent),
  }, ...kids);
}

marked.setOptions({ gfm: true, breaks: false });

// ── structural round-trip helper ──────────────────────────────────────────
// Extracts a minimal (ordered / item-count / nesting-depth / nesting-type)
// structure tree, once from the hand-built DOM stub (the actual source of
// truth for a test case) and once from marked.lexer()'s re-parse of the
// REAL emitted md — never a hand-authored parallel markdown string (that
// was test 3b's earlier mistake: it re-typed an "expected" markdown string
// instead of round-tripping the md serializeList() actually produced,
// which cannot catch a de-nesting bug in the emitted indent).

function elementChildren(node) {
  const out = [];
  for (let i = 0; i < node.childNodes.length; i++) {
    const c = node.childNodes[i];
    if (c.nodeType === 1) out.push(c);
  }
  return out;
}

function domListStructure(listEl) {
  return {
    ordered: listEl.nodeName === 'OL',
    items: elementChildren(listEl).filter((c) => c.nodeName === 'LI').map((liEl) => {
      const nested = elementChildren(liEl).filter((c) => c.nodeName === 'UL' || c.nodeName === 'OL');
      return { nested: nested.map(domListStructure) };
    }),
  };
}

function lexListStructure(token) {
  return {
    ordered: !!token.ordered,
    items: (token.items || []).map((item) => {
      const nestedTokens = (item.tokens || []).filter((t) => t.type === 'list');
      return { nested: nestedTokens.map(lexListStructure) };
    }),
  };
}

// Serializes listEl, asserts no unsupported flags, then re-lexes the REAL
// emitted md with marked.lexer() and asserts the re-parsed structure
// (ordered/item-count/nesting depth/nesting type — text content excluded
// on purpose, this is a structural check) matches the DOM this test built.
// Returns the emitted md for callers that also want to assert its exact
// text.
function assertRoundTrips(listEl, label) {
  const { md, unsupported } = serializeList(listEl);
  assert.deepStrictEqual(unsupported, [], label + ': expected no unsupported, got ' + JSON.stringify(unsupported) + '\nmd:\n' + md);
  const lexed = marked.lexer(md);
  assert.strictEqual(lexed.length, 1, label + ': expected exactly ONE top-level list token after re-lex (a de-nesting bug splits this), got ' + lexed.length + ' top-level tokens — md:\n' + md);
  assert.strictEqual(lexed[0].type, 'list', label + ': expected the sole top-level token to be a list, got ' + lexed[0].type + ' — md:\n' + md);
  assert.deepStrictEqual(lexListStructure(lexed[0]), domListStructure(listEl),
    label + ': round-trip structure mismatch (ordered/item-count/nesting) — md:\n' + md);
  return md;
}

// 1. flat ul
{
  const md = assertRoundTrips(ul(li('item one'), li('item two'), li('item three')), 'flat ul');
  assert.strictEqual(md, [
    '- item one',
    '- item two',
    '- item three',
  ].join('\n'));
}

// 2. ordered list renumbers 1..n regardless of any DOM `start`
{
  const md = assertRoundTrips(ol(li('three'), li('four'), li('five')), 'renumbered ol');
  assert.strictEqual(md, [
    '1. three',
    '2. four',
    '3. five',
  ].join('\n'));
}

// 3. 3-deep nesting indent — verified against marked's real DOM shape
// (nested <ul>/<ol> is a trailing child of the parent <li>, not a sibling).
// All ancestor markers here are UL's fixed-width '- ' (2 columns), so the
// accumulated-marker-width indent and the old flat-2-space indent happen
// to coincide — this case does not by itself exercise the OL-parent fix,
// see the ol>li>ul / ol>li>ol / 3-deep-mixed / two-digit cases below for
// that.
{
  const list = ul(
    li('item one'),
    li('item two', ul(
      li('nested a'),
      li('nested b', ol(
        li('deep 1'),
        li('deep 2')
      ))
    )),
    li('item three')
  );
  const md = assertRoundTrips(list, '3-deep nesting (ul>li>ul>li>ol)');
  assert.strictEqual(md, [
    '- item one',
    '- item two',
    '  - nested a',
    '  - nested b',
    '    1. deep 1',
    '    2. deep 2',
    '- item three',
  ].join('\n'));
}

// 4. item with <br> and inline marks
{
  const list = ul(li('a ', el('strong', {}, 'bold'), ' ', el('br', {}), 'line two'));
  const { md, unsupported } = serializeList(list);
  assert.deepStrictEqual(unsupported, []);
  assert.strictEqual(md, '- a **bold** <br>line two');
}

// 5. mixed ol-in-ul — nested OL's own markers indent by the UL parent's
// fixed 2-column '- ' width.
{
  const md = assertRoundTrips(ul(li('a', ol(li('b'), li('c')))), 'ol-in-ul');
  assert.strictEqual(md, ['- a', '  1. b', '  2. c'].join('\n'));
}

// 5b. CRITICAL fix — ol>li>ul: a nested UL under an OL item must be
// indented by the OL item's OWN marker width ('1. ' = 3 columns), not a
// flat 2. Under the old flat-2-space scheme this de-nests on re-parse
// (verified directly against marked.lexer(): '1. a\n  - b' re-lexes as
// TWO separate top-level list tokens instead of one nested structure) —
// assertRoundTrips() below is exactly the regression guard for that.
{
  const md = assertRoundTrips(ol(li('a', ul(li('b'), li('c')))), 'ol>li>ul');
  assert.strictEqual(md, ['1. a', '   - b', '   - c'].join('\n'));
}

// 5c. CRITICAL fix — ol>li>ol: same de-nesting risk, nested list is
// itself ordered too.
{
  const md = assertRoundTrips(ol(li('a', ol(li('b'), li('c')))), 'ol>li>ol');
  assert.strictEqual(md, ['1. a', '   1. b', '   2. c'].join('\n'));
}

// 5d. CRITICAL fix — 3-deep mixed ul>li>ol>li>ul: indent must accumulate
// through EVERY ancestor's own marker width, not just the immediate
// parent's (2 for the outer '- ', then +3 for the '1. ' OL item, giving a
// 5-column indent for the innermost UL — not a flat 4).
{
  const list = ul(li('a', ol(li('b', ul(li('c'), li('d'))))));
  const md = assertRoundTrips(list, '3-deep mixed (ul>li>ol>li>ul)');
  assert.strictEqual(md, [
    '- a',
    '  1. b',
    '     - c',
    '     - d',
  ].join('\n'));
}

// 5e. CRITICAL fix — two-digit marker width: item 10's marker is '10. '
// (4 columns, one wider than every single-digit item above it), so ITS
// OWN nested list must indent by 4, not the 3 that would suffice for
// items 1-9.
{
  const items = [];
  for (let i = 1; i <= 9; i++) items.push(li('item' + i));
  items.push(li('item10', ul(li('x'))));
  const md = assertRoundTrips(ol(...items), 'two-digit marker width (10.)');
  const lines = md.split('\n');
  assert.strictEqual(lines[9], '10. item10');
  assert.strictEqual(lines[10], '    - x');
}

// 6. unsupported: checkbox input (task list) — flagged via inline-md.js's
// own default unhandled-element branch, no special-case in list-md.js.
// The dropped <input>'s leading whitespace is trimmed from the item text
// (minor fix), so the emitted line has exactly one space after the
// marker, not two.
{
  const list = ul(li(el('input', { type: 'checkbox', disabled: '' }), ' todo'));
  const { md, unsupported } = serializeList(list);
  assert.ok(unsupported.includes('INPUT'), 'checkbox input must be reported unsupported');
  assert.strictEqual(md, '- todo', 'dropped checkbox must not leave a stray double space');
}

// 6b. unsupported: non-LI child of a UL/OL
{
  const list = ul(el('div', {}, 'stray'));
  const { unsupported } = serializeList(list);
  assert.ok(unsupported.includes('DIV'), 'non-LI child must be reported unsupported');
}

// 6c. IMPORTANT fix — stray NON-whitespace text node directly between two
// <li>s (not marked's own insignificant "\n" artifact) must be flagged,
// not silently dropped.
{
  const list = ul(li('a'), text('stray'), li('b'));
  const { unsupported } = serializeList(list);
  assert.ok(unsupported.includes('TEXT'), 'stray non-blank text node between <li>s must be reported unsupported');
}

// 6d. regression guard: a genuinely blank (whitespace-only, containing a
// newline) text node directly between two <li>s is still silently
// skipped — this is the same marked pretty-print artifact isBlankText()
// already recognizes inside an <li>, just here at the list level.
{
  const list = ul(li('a'), text('\n'), li('b'));
  const { md, unsupported } = serializeList(list);
  assert.deepStrictEqual(unsupported, []);
  assert.strictEqual(md, ['- a', '- b'].join('\n'));
}

// 7. no trailing whitespace on any line, even when item text itself
// carries a trailing space.
{
  const list = ul(li('trailing space '), li('normal'));
  const { md } = serializeList(list);
  md.split('\n').forEach((line) => {
    assert.strictEqual(line, line.replace(/[ \t]+$/, ''),
      'line has trailing whitespace: ' + JSON.stringify(line));
  });
}

// 8. loose list (marked's <p>-wrapped item, per real renderer finding —
// this task's decision: degrade to unsupported 'P', item text still
// best-effort serialized).
{
  // models marked's real loose-list DOM shape:
  // <li><p>item one</p></li>  (trailing insignificant whitespace text
  // node included, mirroring what a real DOM parser produces — see
  // module header)
  const list = ul(
    li(el('p', {}, 'item one'), text('\n')),
    li(el('p', {}, 'item two'), text('\n'), ul(li('nested a')))
  );
  const { md, unsupported } = serializeList(list);
  assert.ok(unsupported.includes('P'), 'loose list item must be reported unsupported');
  assert.strictEqual(md, ['- item one', '- item two', '  - nested a'].join('\n'));
  // no blank line anywhere, and no leaked literal newline from the dropped
  // insignificant whitespace text node
  assert.ok(!md.includes('\n\n'), 'no blank line inside emitted block');
  md.split('\n').forEach((line) => assert.strictEqual(line, line.replace(/[ \t]+$/, '')));
}

// gate-compat: every emitted line matches /^ *(-|\d+\.) / (indent is
// ancestor-marker-width accumulated, not a fixed multiple of 2 — see
// module header's INDENT note).
{
  const list = ul(
    li('a', ul(li('b', ol(li('c'), li('d')))))
  );
  const { md } = serializeList(list);
  md.split('\n').forEach((line) => {
    assert.ok(/^ *(-|\d+\.) /.test(line), 'line fails gate marker regex: ' + JSON.stringify(line));
  });
}

// gate-compat: no blank lines inside the emitted block for a deep mixed list
{
  const list = ul(
    li('a', ul(li('b'), li('c', ol(li('d'), li('e'))))),
    li('f')
  );
  const { md } = serializeList(list);
  assert.ok(!md.includes('\n\n'), 'no blank line inside emitted block');
}

// 9. ed-li-text wrapper is unwrapped, not flagged as unsupported
{
  const liEl = el('LI', { 'data-block-id': '0' }, el('DIV', { class: 'ed-li-text' }, text('hi')));
  const r = serializeList(el('UL', {}, liEl));
  assert.strictEqual(r.md, '- hi');
  assert.deepStrictEqual(r.unsupported, []);
}

// 10. checkbox span is consumed into the task marker, not flagged unsupported
{
  const cli = el('LI', { 'data-block-id': '0' },
    el('SPAN', { class: 'ed-li-check', 'data-checked': '1' }),
    el('DIV', { class: 'ed-li-text' }, text('done'))
  );
  const r10 = serializeList(el('UL', {}, cli));
  assert.strictEqual(r10.md, '- [x] done');
  assert.deepStrictEqual(r10.unsupported, [],
    'the consumed checkbox span must NOT be reported unsupported');
}

// 11 / 11b. MIGRATED (2026-08-29). These two used to assert a 6-column
// ('- [ ] ') and 7-column ('1. [x] ') child indent, i.e. the full marker
// width. That was wrong and shipped: the checkbox is a GFM construct parsed
// from the item's CONTENT, not part of the CommonMark list marker, so the
// child's content column is where the BULLET ends (2 and 3). Emitting 6/7 put
// the child outside marked's acceptance window ('- [ ] ' accepts 2..5,
// '1. [ ] ' 3..6) and the child list was absorbed into the parent item as
// literal text — silent data corruption on one commit.
//
// These cases are the reason the bug survived three reviews: they asserted
// the emitted STRING and never fed it back through marked, so they could only
// ever confirm whatever the serializer already did. The migration therefore
// keeps both shapes, corrects the expectations, and adds the round-trip
// assertion that would have caught it. Spec §3.4 carries the matching errata.
function assertTaskChildNests(listName, pliChecked, expectedMd, label) {
  const pli = el('LI', { 'data-block-id': '0' },
    el('SPAN', { class: 'ed-li-check', 'data-checked': pliChecked }),
    el('DIV', { class: 'ed-li-text' }, text('parent')),
    el('UL', {},
      el('LI', { 'data-block-id': '1' }, el('DIV', { class: 'ed-li-text' }, text('kid')))
    )
  );
  const md = serializeList(el(listName, {}, pli)).md;
  assert.strictEqual(md, expectedMd, label);
  const item = marked.lexer(md)[0].items[0];
  assert.strictEqual((item.tokens || []).filter((t) => t.type === 'list').length, 1,
    label + ' — the child must re-lex as a NESTED list token, got item text:\n' +
    JSON.stringify(item.text));
  assert.ok(!/^ {4}/m.test(item.text || ''),
    label + ' — the child must never come back as an indented code block');
}

// 11. unordered task child indent = the BULLET width (2), not the marker's 6
{
  assertTaskChildNests('UL', '0', '- [ ] parent\n  - kid',
    "a child under '- [ ] ' indents 2, not 6");
}

// 11b. ordered task child indent = the BULLET width (3), not the marker's 7
{
  assertTaskChildNests('OL', '1', '1. [x] parent\n   - kid',
    "a child under '1. [x] ' indents 3, not 7");
}

// 12. per-li attribution: unsupported names carry the li's blockId
{
  const badLi = el('LI', { 'data-block-id': '2' },
    el('DIV', { class: 'ed-li-text' }, el('VIDEO', {}))
  );
  const rb = serializeList(el('UL', {}, badLi));
  assert.deepStrictEqual(rb.unsupportedByLi, [{ blockId: '2', names: ['VIDEO'] }]);
  // the flat `unsupported` list and the emitted md must agree with the per-li
  // attribution: VIDEO dropped, the now-empty li serialized to a bare marker.
  assert.deepStrictEqual(rb.unsupported, ['VIDEO']);
  assert.strictEqual(rb.md, '-',
    'a li whose only content was a dropped VIDEO serializes to a bare marker');
}

// 13. ordered task item round-trips as task: true (RULING F-N — the ordered
// branch must not swallow the checkbox; bullet '1. ' and checkbox '[x] '
// are independent parts, yielding '1. [x] done', not '1. done')
{
  const otli = el('LI', { 'data-block-id': '3' },
    el('SPAN', { class: 'ed-li-check', 'data-checked': '1' }),
    el('DIV', { class: 'ed-li-text' }, text('done'))
  );
  const otr = serializeList(el('OL', {}, otli));
  assert.strictEqual(otr.md, '1. [x] done');
  const lexedOt = marked.lexer(otr.md);
  assert.strictEqual(lexedOt[0].items[0].task, true, 'ordered task item must re-lex as task: true');
}

// 14. loose item via ed-li-text: .ed-li-text containing a single <p> must
// still trigger loose-item detection (the unwrap feeds the SAME contentNodes
// list — RULING F-M serializer-side test)
{
  const looseLi = el('LI', { 'data-block-id': '4' },
    el('DIV', { class: 'ed-li-text' }, el('P', {}, text('paragraph')))
  );
  const looseR = serializeList(el('UL', {}, looseLi));
  assert.ok(looseR.unsupported.includes('P'), 'loose item via ed-li-text must report P unsupported');
}

// ── S1 Task 2: flat-run serializer (serializeBlocks) ─────────────────────
// The tree serializeList() above is untouched; these drive the additive
// linear serializer that Task 3's flat renderer will feed.

// 15. flat serializer: one line per block, indent by accumulated marker widths
{
  const blocks = [
    liBlock({ id: '0', type: 'ol', indent: 0 }, 'nine'),
    liBlock({ id: '1', type: 'ul', indent: 1 }, 'child'),
  ];
  const { md, unsupported } = serializeBlocks(blocks);
  assert.deepStrictEqual(unsupported, []);
  assert.strictEqual(md, '1. nine\n   - child',
    'a child under a `1. ` marker indents by that marker\'s own width (3), not a flat 2');
}

// 16. '10. ' is 4 columns wide — the child must follow it, or marked re-parses
// the child as a separate top-level list.
{
  const blocks = [];
  for (let i = 0; i < 10; i++) blocks.push(liBlock({ id: String(i), type: 'ol', indent: 0 }, 'item' + i));
  blocks.push(liBlock({ id: '10', type: 'ul', indent: 1 }, 'child'));
  const { md } = serializeBlocks(blocks);
  assert.ok(md.endsWith('10. item9\n    - child'),
    'a child under a two-digit ordinal indents 4 columns, got:\n' + md);
}

// 17. ordered x task keeps both parts of the marker (RULING F-N)
{
  const blocks = [liBlock({ id: '0', type: 'ol', task: true, checked: false }, 'todo')];
  assert.strictEqual(serializeBlocks(blocks).md, '1. [ ] todo');
}

// 18. armed surfaces must serialize identically — the class is a token list
{
  const plain = serializeBlocks([liBlock({ id: '0' }, 'hello')]).md;
  const armed = serializeBlocks([liBlock({ id: '0', armed: true }, 'hello')]).md;
  assert.strictEqual(armed, plain, 'ed-wys-armed on .ed-li-text must not change serialization');
}

// 19. chrome is skipped, unknown elements are still flagged
{
  const withChrome = liBlock({ id: '0' }, 'hi');
  withChrome.childNodes.unshift(el('button', { class: 'ed-handle' }, '\u283f'));
  withChrome.childNodes.unshift(el('button', { class: 'ed-insert' }, '\uff0b'));
  assert.deepStrictEqual(serializeBlocks([withChrome]).unsupported, [],
    'gutter chrome must be invisible to the serializer');
  const withAlien = liBlock({ id: '0' }, 'hi');
  withAlien.childNodes.unshift(el('video', {}));
  assert.ok(serializeBlocks([withAlien]).unsupported.indexOf('VIDEO') !== -1,
    'an unknown element must still be flagged, not silently skipped');
}

// 20. run numbering restarts per run: a shallower li breaks the run (spec 3.8)
{
  const blocks = [
    liBlock({ id: '0', type: 'ol', indent: 0 }, 'a'),
    liBlock({ id: '1', type: 'ol', indent: 1 }, 'x'),
    liBlock({ id: '2', type: 'ol', indent: 0 }, 'b'),
    liBlock({ id: '3', type: 'ol', indent: 1 }, 'y'),
  ];
  const { md } = serializeBlocks(blocks);
  assert.strictEqual(md, '1. a\n   1. x\n2. b\n   1. y',
    'each parent starts a fresh nested run at 1, got:\n' + md);
}

// 21. a same-indent list-type change also breaks the run
{
  const blocks = [
    liBlock({ id: '0', type: 'ul', indent: 0 }, 'a'),
    liBlock({ id: '1', type: 'ol', indent: 0 }, 'b'),
    liBlock({ id: '2', type: 'ol', indent: 0 }, 'c'),
  ];
  assert.strictEqual(serializeBlocks(blocks).md, '- a\n1. b\n2. c');
}

// 22. lineMeta carries what 3.4's colDelta needs
{
  const { lineMeta } = serializeBlocks([
    liBlock({ id: '7', type: 'ol', indent: 0 }, 'a'),
    liBlock({ id: '8', type: 'ul', indent: 1 }, 'b'),
  ]);
  assert.deepStrictEqual(lineMeta, [
    { blockId: '7', indentPrefix: '', marker: '1. ' },
    { blockId: '8', indentPrefix: '   ', marker: '- ' },
  ]);
}

// 23. C1 — the task checkbox is GFM CONTENT, not part of the CommonMark list
// marker, so a child's content column is the BULLET's width ('- ' 2, '1. ' 3),
// NOT the full '- [ ] ' 6 / '1. [ ] ' 7. Measured against this repo's marked:
// a '- [ ] ' parent accepts child indents 2..5 and a '1. [ ] ' parent 3..6, so
// emitting 6/7 puts the child OUTSIDE the window — marked then absorbs it into
// the parent item as literal text and the nested list is destroyed on commit.
{
  const nestedCount = (md) => {
    const t = marked.lexer(md);
    if (!t[0] || t[0].type !== 'list') return 'NO-LIST';
    return (t[0].items[0].tokens || []).filter((x) => x.type === 'list').length;
  };

  const ulTask = serializeBlocks([
    liBlock({ id: '0', type: 'ul', task: true, checked: false }, 'todo'),
    liBlock({ id: '1', type: 'ul', indent: 1 }, 'child'),
  ]).md;
  assert.strictEqual(ulTask, '- [ ] todo\n  - child',
    "a child under '- [ ] ' indents by the BULLET width (2), not the marker width (6)");
  assert.strictEqual(nestedCount(ulTask), 1,
    'the child list must survive the round trip as a NESTED token, got:\n' + ulTask);

  const olTask = serializeBlocks([
    liBlock({ id: '0', type: 'ol', task: true, checked: true }, 'todo'),
    liBlock({ id: '1', type: 'ul', indent: 1 }, 'child'),
  ]).md;
  assert.strictEqual(olTask, '1. [x] todo\n   - child',
    "a child under '1. [ ] ' indents by the BULLET width (3), not the marker width (7)");
  assert.strictEqual(nestedCount(olTask), 1,
    'the child list must survive the round trip as a NESTED token, got:\n' + olTask);

  // the checkbox must still be emitted, and still re-lex as a task item
  assert.strictEqual(marked.lexer(olTask)[0].items[0].task, true,
    'narrowing the child indent must not drop the checkbox itself');
}

// 24. C2 — run rule (b) compares against the last block AT THAT DEPTH, not
// against the immediately previous block. A deeper item sitting between two
// same-depth blocks must not hide a list-type change: without this the ordinal
// fails to restart, the md re-lexes as <ol start="3">, 3.8 discards `start`,
// and the next commit renumbers to 1. — the document oscillates forever.
{
  const { md } = serializeBlocks([
    liBlock({ id: '0', type: 'ol', indent: 0 }, 'a'),
    liBlock({ id: '1', type: 'ol', indent: 1 }, 'x'),
    liBlock({ id: '2', type: 'ul', indent: 0 }, 'b'),
    liBlock({ id: '3', type: 'ol', indent: 1 }, 'y'),
    liBlock({ id: '4', type: 'ol', indent: 0 }, 'c'),
  ]);
  assert.strictEqual(md, '1. a\n   1. x\n- b\n  1. y\n1. c',
    'the ul@0 broke the ol run at depth 0, so the next ol@0 restarts at 1, got:\n' + md);
  const lexed = marked.lexer(md);
  const olTail = lexed[lexed.length - 1];
  assert.ok(!olTail.start || olTail.start === 1,
    'the trailing ol must not re-lex with a start offset, got start=' + olTail.start);
}

// 25. C2 one level down — same bug, depth 1 between depth-2 items
{
  const { md } = serializeBlocks([
    liBlock({ id: '0', type: 'ol', indent: 0 }, 'p'),
    liBlock({ id: '1', type: 'ol', indent: 1 }, 'x'),
    liBlock({ id: '2', type: 'ol', indent: 2 }, 'd'),
    liBlock({ id: '3', type: 'ul', indent: 1 }, 'u'),
    liBlock({ id: '4', type: 'ol', indent: 2 }, 'd2'),
    liBlock({ id: '5', type: 'ol', indent: 1 }, 'z'),
  ]);
  assert.ok(md.endsWith('\n   1. z'),
    'the ul@1 broke the ol run at depth 1, so the trailing ol@1 restarts at 1, got:\n' + md);
}

// 26. Minor 2 — 3.8 rule (c): a non-li block is a run terminator, never a
// silent '- <text>' line. Flag it, never swallow it.
{
  const notLi = el('div', {
    class: 'ed-block', 'data-block-id': '9', 'data-block-type': 'p', 'data-indent': '0',
  }, el('div', { class: 'ed-li-text' }, 'para'));
  const r = serializeBlocks([notLi]);
  assert.deepStrictEqual(r.unsupported, ['P'],
    'a non-li block must be flagged by its block type, got: ' + JSON.stringify(r.unsupported));
  assert.strictEqual(r.md, '', 'a non-li block must emit no line, got: ' + JSON.stringify(r.md));
  assert.deepStrictEqual(r.lineMeta, [], 'a non-li block must contribute no lineMeta');
}

// 27. TREE serializer (serializeList, NOT serializeBlocks) — same defect as
// case 23, and this is the path that shipped: a task item's nested child must
// indent by the BULLET's width. With the full marker width ('- [ ] ' = 6) the
// child lands outside marked's 2..5 acceptance window, gets absorbed into the
// parent item as literal text, and its now-4-space indent turns it into an
// indented CODE BLOCK — silent data corruption on a single commit.
{
  const taskParent = el('UL', {},
    el('LI', { 'data-block-id': '0' },
      el('SPAN', { class: 'ed-li-check', 'data-checked': '0' }),
      el('DIV', { class: 'ed-li-text' }, text('todo')),
      ul(li('child'))
    )
  );
  const r = serializeList(taskParent);
  assert.deepStrictEqual(r.unsupported, []);
  assert.strictEqual(r.md, '- [ ] todo\n  - child',
    "a nested child under '- [ ] ' indents by the bullet width (2), not 6");

  const lexed = marked.lexer(r.md);
  const item = lexed[0].items[0];
  assert.strictEqual((item.tokens || []).filter((t) => t.type === 'list').length, 1,
    'the child list must survive as a NESTED list token, got item text:\n' +
    JSON.stringify(item.text));
  assert.ok(!/^ {4}/m.test(item.text || ''),
    'the child must never come back as an indented code block, got:\n' +
    JSON.stringify(item.text));
  assert.strictEqual(item.task, true, 'the checkbox must survive the narrower indent');

  // ordered task parent: bullet '1. ' contributes 3
  const olTaskParent = el('OL', {},
    el('LI', { 'data-block-id': '0' },
      el('SPAN', { class: 'ed-li-check', 'data-checked': '1' }),
      el('DIV', { class: 'ed-li-text' }, text('todo')),
      ul(li('child'))
    )
  );
  const ro = serializeList(olTaskParent);
  assert.strictEqual(ro.md, '1. [x] todo\n   - child',
    "a nested child under '1. [ ] ' indents by the bullet width (3), not 7");
  assert.strictEqual(
    (marked.lexer(ro.md)[0].items[0].tokens || []).filter((t) => t.type === 'list').length, 1,
    'ordered task parent must keep its child nested too');
}

// 28. S1 / Task 3 regression: ONE BLOCK == ONE PHYSICAL LINE, even when the
// .ed-li-text surface carries marked's pretty-print whitespace. A LOOSE item is
// server-rendered as `<div class="ed-li-text">\n<p>text</p>\n</div>`, and
// inline-md.js's escapeText() has no reason to treat a text node's "\n"
// specially — so without the isBlankText() filter at the .ed-li-text unwrap ONE
// item emitted THREE physical lines. That breaks the gate's one-line-per-item
// contract AND desynchronises lineMeta from md.split('\n'), which the per-li
// degrade path in client.js indexes by position: the observed symptom was
// editing the item AFTER a loose blank writing a DIFFERENT item's line into it.
{
  const looseBlock = el('div', {
    class: 'ed-block', 'data-block-id': '0', 'data-block-type': 'li',
    'data-list-type': 'ul', 'data-task': '0', 'data-indent': '0',
  },
    el('span', { class: 'ed-li-marker' }, '\u2022'),
    el('div', { class: 'ed-li-text' }, text('\n'), el('p', {}, 'loose text'), text('\n'))
  );
  const r = serializeBlocks([looseBlock, liBlock({ id: '1' }, 'plain')]);
  assert.strictEqual(r.md.split('\n').length, 2,
    'two blocks must emit exactly two physical lines, got:\n' + JSON.stringify(r.md));
  assert.strictEqual(r.lineMeta.length, 2, 'lineMeta stays parallel to the emitted lines');
  r.md.split('\n').forEach((line, i) => {
    assert.ok(/^ *(-|\d+\.) ?/.test(line),
      'line ' + i + ' must still be a marker line: ' + JSON.stringify(line));
  });
  assert.strictEqual(r.md.split('\n')[1], '- plain',
    'the block AFTER the loose one must still own line index 1');
  assert.ok(r.unsupported.indexOf('P') !== -1,
    'the loose <p> is still reported unsupported (T2-B: as a per-block inline name)');

  // A bare ' ' between inline nodes is NOT the artifact and must survive —
  // this is why isBlankText() (newline-requiring) is the right predicate and
  // isBlankBlockText() is not.
  const spaced = el('div', {
    class: 'ed-block', 'data-block-id': '0', 'data-block-type': 'li',
    'data-list-type': 'ul', 'data-task': '0', 'data-indent': '0',
  },
    el('span', { class: 'ed-li-marker' }, '\u2022'),
    el('div', { class: 'ed-li-text' }, el('strong', {}, 'a'), text(' '), el('em', {}, 'b'))
  );
  assert.strictEqual(serializeBlocks([spaced]).md, '- **a** *b*',
    'meaningful inter-inline spacing must NOT be swallowed by the artifact filter');
}

console.log('list-md.test.js OK');
