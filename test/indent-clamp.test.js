#!/usr/bin/env node
'use strict';

// Pure-function coverage for spec §3.4 ("位移後再夾取" — shift, then clamp).
//
// `clampIndents()` is the data-only half of every structural list operation:
// the caller mutates `data-indent` on the blocks it is moving, hands the whole
// commit span here as plain objects, and gets back the indent each surviving
// list block must carry so the markdown it serializes to still nests the way
// the model says. No DOM, no `lines`, no `blocks` — the same reason
// lib/editor/lineops.js is its own module.
//
// Result shape: one `{ blockId, indent }` per block that is STILL a list item
// after the operation, in document order — so a `removed` or `operatedBecomes`
// block is absent, and every other block (including ones ahead of the
// operation, which never move) is present.

const assert = require('assert');
const { clampIndents } = require('../lib/editor/indent-clamp.js');

const li = (indent) => ({ type: 'li', indent });
const other = () => ({ type: 'paragraph' });
const withIds = (arr) => arr.map((b, i) => Object.assign({}, b, { id: i }));

// 1. converting a parent away: the whole subtree shifts left by one, relative
//    depths preserved (spec §3.4 rule 2's segment definition)
{
  const blocks = withIds([li(0), li(1), li(2), li(1)]);
  const out = clampIndents(blocks, 0, 0, { operatedBecomes: other() });
  assert.deepStrictEqual(out.map((b) => b.indent), [1, 2, 1].map((x) => x - 1),
    'the subtree shifts left as one unit, keeping relative depth');
  assert.deepStrictEqual(out.map((b) => b.blockId), [1, 2, 3],
    'the converted block is no longer a list item, so it has no indent to report');
}
// 2. deleting a parent that still has a legal anchor: children do NOT move
{
  const blocks = withIds([li(0), li(0), li(1), li(1)]);
  const out = clampIndents(blocks, 1, 0, { removed: true });
  assert.deepStrictEqual(out.map((b) => b.indent), [0, 1, 1],
    'with an indent-0 li still above them, the children stay put');
  assert.deepStrictEqual(out.map((b) => b.blockId), [0, 2, 3]);
}
// 3. siblings are never adopted by one another
{
  const blocks = withIds([li(0), li(1), li(1)]);
  const out = clampIndents(blocks, 0, 0, { removed: true });
  assert.deepStrictEqual(out.map((b) => b.indent), [0, 0],
    'both former children land at 0 — the second must not become a child of the first');
}
// 4. lower bound: indent never goes negative
{
  const blocks = withIds([li(0), li(1)]);
  const out = clampIndents(blocks, 0, 0, { removed: true });
  assert.ok(out.every((b) => b.indent >= 0));
}

// 5. spec §3.5 row "清單項 / Tab": the operated item goes one deeper and its
//    children DO NOT follow — they keep their own indent and so become its
//    siblings. Clamping must not undo that by dragging them along.
{
  //  - a / - b / (2sp)- b1 / (2sp)- b2 / - c   with Tab pressed on 'b'
  const blocks = withIds([li(0), li(1), li(1), li(1), li(0)]);
  const out = clampIndents(blocks, 1, 0, {});
  assert.deepStrictEqual(out.map((b) => b.indent), [0, 1, 1, 1, 0],
    'Tab: b1/b2 stay at 1 (now b\'s siblings) and c is untouched');
}

// 6. Tab's own upper bound (rule 1): an item can never land deeper than
//    "previous block's indent + 1", however deep the caller set it.
{
  const blocks = withIds([li(0), li(3)]);
  const out = clampIndents(blocks, 1, 0, {});
  assert.deepStrictEqual(out.map((b) => b.indent), [0, 1],
    'rule 1 clamps the operated block itself to prev.indent + 1');
}

// 7. the first block of a span has no previous block at all: its bound is 0.
{
  const blocks = withIds([li(2), li(3)]);
  const out = clampIndents(blocks, 0, 2, {});
  assert.deepStrictEqual(out.map((b) => b.indent), [0, 1],
    'no previous block ⇒ upper bound 0, and the child follows the clamp down');
}

// 8. Shift+Tab's adoption (spec §3.5 clauses 2/3) survives the clamp: the
//    operated item rises, its own subtree rises with it, and its FORMER
//    following same-level siblings keep their indent — which is what makes
//    them its children.
{
  //  - a / - b / (2sp)- b1 / (2sp)- b2 / - c , Shift+Tab on b1 (indent 1 -> 0)
  const blocks = withIds([li(0), li(0), li(0), li(1), li(0)]);
  const out = clampIndents(blocks, 2, 1, {});
  assert.deepStrictEqual(out.map((b) => b.indent), [0, 0, 0, 1, 0],
    'b2 keeps indent 1 and is thereby adopted by the outdented b1');
}

// 9. a NON-list block ends the scope (rule 2), and everything after it is left
//    exactly as it was — the clamp never reaches across a paragraph.
{
  const blocks = withIds([li(0), li(1), other(), li(2)]);
  const out = clampIndents(blocks, 0, 0, { removed: true });
  assert.deepStrictEqual(out.map((b) => b.indent), [0, 2],
    'the li after the paragraph is out of scope and keeps its own indent');
  assert.deepStrictEqual(out.map((b) => b.blockId), [1, 3]);
}

// 10. rule 2's scope stops at the first block SHALLOWER than the operated
//     block's OLD indent — a later, shallower run is not this operation's
//     business.
{
  //  - a / (2sp)- b / (4sp)- b1 / - c / (2sp)- c1 , delete b (old indent 1)
  const blocks = withIds([li(0), li(1), li(2), li(0), li(1)]);
  const out = clampIndents(blocks, 1, 1, { removed: true });
  assert.deepStrictEqual(out.map((b) => b.indent), [0, 1, 0, 1],
    'b1 rises to 1 (b is gone); c and c1 are past the scope end and do not move');
}

// 11. multi-block anchor (spec §3.4 rule 3): the delta is computed from the
//     SMALLEST old indent in the operated set, not from its first member.
{
  //  {a(0), b(1)} both deleted, leaving c(2) and d(1) to be re-anchored.
  const blocks = withIds([li(0), li(1), li(2), li(1)]);
  const out = clampIndents(blocks, [0, 1], 0, { removed: true });
  assert.deepStrictEqual(out.map((b) => b.indent), [0, 0],
    'anchoring on the set minimum keeps d at 0 instead of driving it to -1');
  assert.ok(out.every((b) => b.indent >= 0), 'no negative indent');
}

// 12. an already-legal document is a fixed point: clamping changes nothing.
{
  const blocks = withIds([li(0), li(1), li(2), li(1), li(0), li(1)]);
  const out = clampIndents(blocks, 5, 1, {});
  assert.deepStrictEqual(out.map((b) => b.indent), [0, 1, 2, 1, 0, 1],
    'a legal shape is unchanged — the clamp is a safety net, not a rewriter');
}

// ── T8 item 5: what this module's coverage IS, and what it is NOT ────────
//
// PARTLY INSURANCE, PARTLY COVERAGE — and the line between the two moved on
// 2026-08-30, so read this before trusting either half.
//
// Every case above is a unit test of a pure function. For the INDENT KEYS,
// none of them proves that a user gesture reaches the behaviour being
// asserted, and none does: Tab/Shift+Tab move exactly one item by exactly one
// level and re-anchor it themselves, so the span they hand the clamp is
// already legal and case 12's fixed-point result is the answer every time
// (measured over an exhaustive item x gesture simulation of this plan's
// fixtures: 1091 gestures, zero indent changed by the clamp).
//
// `opts.removed` HAS a production caller as of the whole-branch review's
// BLOCKING 1: the ⠿ menu's 刪除 on a list item routes through
// deleteListItemViaGutter() -> applyIndentClamp(run, li, oldIndent,
// { removed: true }). What that caller's end-to-end coverage PROVES, though,
// is narrower than this note used to claim, and the correction was MEASURED
// on 2026-08-30 rather than reasoned about:
//
//   * the note used to point at "the B1 cases" in
//     test/editor-client-runtime.test.js, naming
//     '# T\n\n- a\n    - deep\n- b\n' (B1 case (b)) as the measured shape.
//     Those cases prove nothing about the clamp. MEASURED twice, directly:
//     drop `{ removed: true }` from that call and all six stay GREEN;
//     replace applyIndentClamp()'s body with an immediate `return` and all
//     six stay GREEN again. (The whole-file measurement that first found
//     this — the runtime suite exit 0 under the first mutation — was taken
//     BEFORE the guard named below existed. That guard is what makes the
//     same mutation red today, so do not expect a green suite from it now.)
//   * the mechanism is the one the `operatedBecomes` note below already
//     records honestly: list-md.js rebuilds its marker-width `widths` stack
//     from EMPTY for every serialized span, so the FIRST li of a span emits
//     at column 0 whatever its data-indent says. Every B1 case that asserts
//     an indent deletes the run's FIRST member, so the orphan-avoidance they
//     show comes from the span RE-SERIALIZATION — exactly what the pre-fix
//     line-range splice never did — and not from the clamp.
//
// The end-to-end guard that does bite is 'B1 follow-up: the §3.4 `removed`
// deltas survive the delete commit' in test/editor-client-runtime.test.js,
// added 2026-08-30 with the shape the `operatedBecomes` guard already had
// and B1 lacks: the deleted item is NOT the run's head, and rule 3's scope
// holds TWO segments with DIFFERENT deltas ('1. alpha / (3sp)1. beta /
// (6sp)1. gamma / (3sp)2. delta / (6sp)1. epsilon / 2. zeta', delete beta).
// It goes red under BOTH mutations above.
//
// ⚠ MEASURED, and it is why that guard reads the way it does: the byte the
// clamp moves on a delete is an ORDINAL, not an indent. Over every legal
// li-only span of up to 7 blocks with mixed ul/ol markers, and again over
// 400k randomised spans of up to 19 blocks (long enough for an ordinal to
// reach the 4-column '10. ' marker width), the clamped and the unclamped
// span NEVER emit different indent COLUMNS — 4778 of the randomised deletes
// moved a byte and not one of them moved a column, because the width stack
// collapses an orphaned data-indent onto the very column the clamp would
// have picked. list-md.js keys `counters[]` /
// `types[]` on the RAW data-indent, so the clamp's whole observable
// contribution on this path is WHICH ITEMS COUNT AS SIBLINGS: unclamped,
// that fixture comes back '1. gamma / 1. delta' at the same three columns
// the screen renders as 1, 2.
//
// What is asserted HERE is unchanged, and stays modest: that the wiring still
// exists, so removing it cannot go unnoticed.
//
// `opts.operatedBecomes` was wired up on the same terms by S2 Task 4: the ⠿
// menu's 轉換成 to a NON-list target routes through convertListItemAway() ->
// applyIndentClamp(run, li, oldIndent, { operatedBecomes: { type } }), which
// is what tells the pure function that the operated block is still there but
// can no longer anchor anything (§3.3 / §3.4 rule 2).
//
// ⚠ MEASURED, and worth knowing before trusting the assertion below to mean
// more than it says: on the SIMPLE orphan shape ('- alpha / (2sp)- child /
// (4sp)- grandchild', convert alpha away) the clamp changes NO emitted byte.
// convertListItemAway() serializes the survivors as their own span, and
// list-md.js rebuilds its marker-width stack from EMPTY per span, so the
// first survivor emits at column 0 whatever its data-indent says — the same
// answer the clamp computes. The option earns its place one shape further
// out, where §3.4 rule 3's scope holds TWO segments with DIFFERENT deltas
// ('- alpha / (2sp)- beta / (4sp)- gamma / (2sp)- delta / (4sp)- epsilon /
// - zeta', convert beta away): without it the three survivors come back flat.
// That end-to-end proof is the 'the §3.4 segment deltas survive the split
// commit' scenario in test/editor-client-runtime.test.js; what is asserted
// here is that the wiring still exists, so removing it cannot go unnoticed.
{
  const fs = require('fs');
  const path = require('path');
  const clientSrc = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'editor', 'client.js'), 'utf8');
  // T8 review LOW-1: comment lines are dropped BEFORE counting, and the line
  // that is checked for the options object is the matched CALL line — not
  // `indexOf`'s first textual hit, which a mention in a comment would win.
  // A source check that counts its own explanation produces a failure message
  // asserting a defect that is not there.
  const codeLines = clientSrc.split('\n').filter((l) => {
    const t = l.trim();
    return !(t === '' || t.indexOf('//') === 0 || t.indexOf('*') === 0);
  });
  // ⚠ WHAT THE THREE COUNTS BELOW PROVE, AND WHAT THEY DO NOT. Every one of
  // them is a SOURCE-TEXT PRESENCE check over client.js, never a
  // REACHABILITY check: they prove the call is still WRITTEN, not that any
  // gesture still reaches it. MEASURED 2026-08-30 — delete the
  // `await deleteListItemViaGutter(liveBlockEl);` dispatch inside
  // deleteBlockViaGutter() and the whole function, `{ removed: true }` call
  // included, becomes dead code while all three counts here stay GREEN. What
  // notices is the runtime file: the B1 group goes red on that same
  // deletion. So read these as "nobody quietly re-inlined, dropped or
  // duplicated the wiring", and read test/editor-client-runtime.test.js for
  // "the wiring is still on a path a user can walk".
  const callLines = codeLines.filter((l) => l.indexOf('clampIndents(') !== -1);
  assert.strictEqual(callLines.length, 1,
    'S1 has exactly ONE production call into clampIndents(); found ' + callLines.length +
    ':\n  ' + callLines.join('\n  ') +
    '\nIf S2 added another, update this note — do not just bump the number.');
  assert.ok(/clampIndents\([^\n]*,\s*opts \|\| \{\s*\}\s*\)/.test(callLines[0]),
    'that one call forwards its caller\'s options (it used to hardcode `{}`, which is ' +
    'what made `removed` unreachable in production); got: ' + JSON.stringify(callLines[0]));
  // `removed` is now reachable, from exactly one gesture. Both halves matter:
  // zero call sites means BLOCKING 1's fix was reverted, and more than one
  // means a second gesture grew a clamp without anyone re-reading this note.
  const removedSites = codeLines.filter((l) => /applyIndentClamp\([^\n]*removed:\s*true/.test(l));
  assert.strictEqual(removedSites.length, 1,
    '`opts.removed` must have exactly ONE production caller — the ⠿ delete of a list ' +
    'item (spec §6, S1 期間的已知危險 item 1). Found ' + removedSites.length + ':\n  ' +
    removedSites.join('\n  '));
  // Same two halves as `removed` above, for the same two reasons: zero call
  // sites means Task 4's clamp was reverted, and more than one means a second
  // gesture grew a conversion clamp without anyone re-reading this note.
  const becomesSites = codeLines.filter(
    (l) => /applyIndentClamp\([^\n]*operatedBecomes/.test(l));
  assert.strictEqual(becomesSites.length, 1,
    '`opts.operatedBecomes` must have exactly ONE production caller — the ⠿ 轉換成 of a ' +
    'list item to a NON-list target (spec §3.3, §4.3 rule 1). Found ' + becomesSites.length +
    ':\n  ' + becomesSites.join('\n  '));
}

console.log('indent-clamp: spec §3.4 shift-then-clamp — OK');
