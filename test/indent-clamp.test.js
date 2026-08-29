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
// INSURANCE, NOT COVERAGE. Every case above is a unit test of a pure
// function. None of them proves that any USER GESTURE reaches the behaviour
// being asserted, and in S1 none does: clampIndents() is a provable no-op for
// every gesture the editor can currently produce. Tab/Shift+Tab move exactly
// one item by exactly one level and re-anchor it themselves, so the span they
// hand the clamp is already legal and case 12's fixed-point result is the
// answer every time (measured over an exhaustive item x gesture simulation of
// this plan's fixtures: 1091 gestures, zero indent changed by the clamp).
//
// The two option branches — `removed` and `operatedBecomes` — have NO
// production caller at all. That is asserted mechanically below rather than
// asserted in prose, because the whole point of writing it down is to be told
// when it stops being true: S2's §3.3 conversion is what wires them up, and
// on the day it does, this check fails and whoever is holding the branch has
// to come back and re-read this note instead of inheriting a stale one.
{
  const fs = require('fs');
  const path = require('path');
  const clientSrc = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'editor', 'client.js'), 'utf8');
  const calls = clientSrc.match(/clampIndents\(/g) || [];
  assert.strictEqual(calls.length, 1,
    'S1 has exactly ONE production call into clampIndents(); found ' + calls.length +
    '. If S2 added another, update this note — do not just bump the number.');
  const at = clientSrc.indexOf('clampIndents(');
  const call = clientSrc.slice(at, clientSrc.indexOf('\n', at));
  assert.ok(/clampIndents\([^\n]*,\s*\{\s*\}\s*\)/.test(call),
    'that call passes an EMPTY options object, which is what makes `removed` and ' +
    '`operatedBecomes` unreachable in production and this file insurance rather than ' +
    'coverage; got: ' + JSON.stringify(call));
}

console.log('indent-clamp: spec §3.4 shift-then-clamp — OK');
