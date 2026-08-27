'use strict';
const assert = require('assert');
const { marked } = require('marked');
const { serializeList } = require('../lib/editor/list-md.js');

// minimal element stub — same pattern as test/table-md.test.js / test/inline-md.test.js
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
function text(s) { return { nodeType: 3, textContent: s }; }
function li(...children) { return el('li', {}, ...children); }
function ul(...children) { return el('ul', {}, ...children); }
function ol(...children) { return el('ol', {}, ...children); }

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

// 11. task child indent = 6 columns ('- [ ] ' is 6 chars wide; childIndentPrefix
// derives from marker.length, so the nested item indents by exactly 6 spaces)
{
  const pli = el('LI', { 'data-block-id': '0' },
    el('SPAN', { class: 'ed-li-check', 'data-checked': '0' }),
    el('DIV', { class: 'ed-li-text' }, text('parent')),
    el('UL', {},
      el('LI', { 'data-block-id': '1' }, el('DIV', { class: 'ed-li-text' }, text('kid')))
    )
  );
  assert.strictEqual(serializeList(el('UL', {}, pli)).md, '- [ ] parent\n      - kid');
}

// 11b. ORDERED task child indent = 7 columns ('1. [x] ' is 7 chars wide) —
// the ordered branch must combine BOTH the '1. ' bullet width and the '[x] '
// checkbox width when deriving childIndentPrefix, not just one of them.
{
  const pli = el('LI', { 'data-block-id': '0' },
    el('SPAN', { class: 'ed-li-check', 'data-checked': '1' }),
    el('DIV', { class: 'ed-li-text' }, text('parent')),
    el('UL', {},
      el('LI', { 'data-block-id': '1' }, el('DIV', { class: 'ed-li-text' }, text('kid')))
    )
  );
  assert.strictEqual(serializeList(el('OL', {}, pli)).md, '1. [x] parent\n       - kid');
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

console.log('list-md.test.js OK');
