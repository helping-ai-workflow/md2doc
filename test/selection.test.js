'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../lib/editor/selection.js');

let checks = 0;
function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg + '\n  actual:   ' + JSON.stringify(actual) +
    '\n  expected: ' + JSON.stringify(expected));
  checks += 1;
}

// A small document: heading(1), para(3), li(5), li(6), li(7), para(9).
// Not authored from reasoning — this is the literal buildBlockMap() output for
// '# H\n\npara\n\n- a\n  - b\n- c\n\ntail\n' (measured 2026-08-30), minus the
// listType/task fields nothing here reads.
const BLOCKS = [
  { id: 0, type: 'heading', startLine: 1, endLine: 1 },
  { id: 1, type: 'paragraph', startLine: 3, endLine: 3 },
  { id: 2, type: 'li', startLine: 5, endLine: 5, indent: 0 },
  { id: 3, type: 'li', startLine: 6, endLine: 6, indent: 1 },
  { id: 4, type: 'li', startLine: 7, endLine: 7, indent: 0 },
  { id: 5, type: 'paragraph', startLine: 9, endLine: 9 },
];

// --- normalize ---------------------------------------------------------
eq(S.normalize({ anchorLine: 3, focusLine: 7 }), { startLine: 3, endLine: 7 }, 'forward');
eq(S.normalize({ anchorLine: 7, focusLine: 3 }), { startLine: 3, endLine: 7 }, 'backward keeps order');
eq(S.normalize({ anchorLine: 5, focusLine: 5 }), { startLine: 5, endLine: 5 }, 'single line');
eq(S.normalize(null), null, 'no selection normalizes to null, never a NaN range');

// --- membership --------------------------------------------------------
eq(S.membersOf({ anchorLine: 5, focusLine: 7 }, BLOCKS).map((b) => b.id), [2, 3, 4],
  'three list items');
eq(S.membersOf({ anchorLine: 7, focusLine: 5 }, BLOCKS).map((b) => b.id), [2, 3, 4],
  'backward selects the same set');
eq(S.membersOf({ anchorLine: 3, focusLine: 3 }, BLOCKS).map((b) => b.id), [1],
  'one block');
eq(S.membersOf({ anchorLine: 1, focusLine: 9 }, BLOCKS).map((b) => b.id), [0, 1, 2, 3, 4, 5],
  'the whole document');
eq(S.membersOf(null, BLOCKS).map((b) => b.id), [], 'no selection has no members');
// A line that belongs to no block (a blank separator) selects nothing on its own.
eq(S.membersOf({ anchorLine: 4, focusLine: 4 }, BLOCKS).map((b) => b.id), [],
  'a blank separator line owns no block');
// A block is a member if ANY of its lines is in range, so a partially covered
// multi-line block is fully selected — block selection has no partial state.
const MULTI = [{ id: 0, type: 'code', startLine: 1, endLine: 5 }];
eq(S.membersOf({ anchorLine: 3, focusLine: 3 }, MULTI).map((b) => b.id), [0],
  'a multi-line block touched anywhere is wholly selected');

// A block that owns no source line (endLine < startLine — the outer of a
// same-line nest like "- - a") can never be a member: it has no line to touch.
// Shape measured from buildBlockMap('# D\n\n- - a\n') -> outer {3,2}, inner {3,3};
// re-based to line 5 here so it matches the rest of this fixture family.
const NOLINE = [{ id: 0, type: 'li', startLine: 5, endLine: 4, indent: 0 },
                { id: 1, type: 'li', startLine: 5, endLine: 5, indent: 1 }];
eq(S.membersOf({ anchorLine: 5, focusLine: 5 }, NOLINE).map((b) => b.id), [1],
  'a block owning no line is never a member (blockOwnsNoLine, endLine < startLine)');
// The same exclusion, driven over a WIDER range than the phantom's own line, so
// the test cannot pass merely because the range happened to be one line long.
eq(S.membersOf({ anchorLine: 1, focusLine: 99 }, NOLINE).map((b) => b.id), [1],
  'the no-line exclusion holds for a range that spans the whole document too');

// `isSelected` was REMOVED on 2026-08-31 (review recommendation 4). It had no
// production caller in `lib/` and every one of its four assertions used a
// SINGLE-line block, so intersection-vs-containment — the one rule it did not
// share trivially with membersOf() — was never pinned through it; the MULTI
// fixture above is what actually holds that rule down. This guard keeps it from
// coming back as an untested export: a re-added `isSelected` must arrive with a
// production caller AND a multi-line fixture, at which point this line is
// deleted deliberately rather than silently satisfied.
assert.strictEqual(typeof S.isSelected, 'undefined',
  'selection.js must not export a per-block isSelected() with no production caller — '
  + 're-add it together with the caller and a MULTI-line fixture, and delete this guard '
  + 'in the same commit');
checks += 1;

// --- extendTo / stepFocus ---------------------------------------------
eq(S.extendTo({ anchorLine: 3, focusLine: 3 }, 7), { anchorLine: 3, focusLine: 7 },
  'Shift+Click keeps the anchor');
eq(S.extendTo({ anchorLine: 7, focusLine: 7 }, 3), { anchorLine: 7, focusLine: 3 },
  'extending upward keeps the anchor too');
eq(S.extendTo(null, 5), { anchorLine: 5, focusLine: 5 },
  'extending with no prior selection starts one collapsed at that line');

eq(S.stepFocus({ anchorLine: 3, focusLine: 3 }, BLOCKS, 1), { anchorLine: 3, focusLine: 5 },
  'Shift+Down moves focus to the next BLOCK start, not the next line');
eq(S.stepFocus({ anchorLine: 5, focusLine: 7 }, BLOCKS, 1), { anchorLine: 5, focusLine: 9 },
  'Shift+Down again');
eq(S.stepFocus({ anchorLine: 5, focusLine: 9 }, BLOCKS, 1), { anchorLine: 5, focusLine: 9 },
  'Shift+Down at the last block is a no-op, not an error');
eq(S.stepFocus({ anchorLine: 5, focusLine: 7 }, BLOCKS, -1), { anchorLine: 5, focusLine: 6 },
  'Shift+Up shrinks toward the anchor');
eq(S.stepFocus({ anchorLine: 5, focusLine: 5 }, BLOCKS, -1), { anchorLine: 5, focusLine: 3 },
  'Shift+Up past the anchor inverts the selection');
eq(S.stepFocus({ anchorLine: 1, focusLine: 1 }, BLOCKS, -1), { anchorLine: 1, focusLine: 1 },
  'Shift+Up at the first block is a no-op');
// Stepping is by BLOCK, and the gap between block 1 (line 3) and block 2 (line 5)
// is two lines wide, so a per-line implementation lands on 4 and this bites.
eq(S.stepFocus({ anchorLine: 1, focusLine: 1 }, BLOCKS, 1), { anchorLine: 1, focusLine: 3 },
  'Shift+Down from the heading skips the blank line to the next block start');
// A no-line block is not a stepping stop: it has no line to focus and can never
// be a member, so landing on it would leave a selection with no members.
const NOLINE_MID = [
  { id: 0, type: 'li', startLine: 1, endLine: 1, indent: 0 },
  { id: 1, type: 'li', startLine: 2, endLine: 1, indent: 0 },   // phantom
  { id: 2, type: 'li', startLine: 2, endLine: 2, indent: 1 },
  { id: 3, type: 'li', startLine: 3, endLine: 3, indent: 0 },
];
// ⚠ ONE step does not discriminate, and the version of this test that shipped
// with Task 1 took exactly one (review recommendation 2, 2026-08-31). The
// phantom is {startLine: 2, endLine: 1} and the real block behind it is
// {startLine: 2, endLine: 2} — the SAME startLine — so a build with
// `.filter(ownsALine)` deleted from stepFocus() lands on the phantom and still
// answers focusLine 2. The mutant only separates from the shipped code on the
// step AFTER that: it re-finds index 1 (the phantom, whose startLine is 2),
// steps to index 2 — the real {2,2} block — and answers 2 again, FOREVER, while
// the shipped code walks 1 -> 2 -> 3. So the chain is driven three times and
// every intermediate answer is asserted.
const nlStep1 = S.stepFocus({ anchorLine: 1, focusLine: 1 }, NOLINE_MID, 1);
eq(nlStep1, { anchorLine: 1, focusLine: 2 },
  'stepping skips a block that owns no source line');
const nlStep2 = S.stepFocus(nlStep1, NOLINE_MID, 1);
eq(nlStep2, { anchorLine: 1, focusLine: 3 },
  'MUTATION GUARD: the second step is the one that bites. Without the ownsALine '
  + 'filter the phantom {2,1} is index 1, so this step lands on the real {2,2} and '
  + 'answers 2 again — the focus never leaves line 2 however many times Shift+Down is '
  + 'pressed. With the filter, nav is [{1,1},{2,2},{3,3}] and the focus reaches 3');
const nlStep3 = S.stepFocus(nlStep2, NOLINE_MID, 1);
eq(nlStep3, { anchorLine: 1, focusLine: 3 },
  'and the third step clamps at the last block rather than wrapping — an ANTI-VACUITY '
  + 'partner for the two above: a stepFocus() that simply refused to move would satisfy '
  + 'neither of them');
// The same chain upward. ⚠ These two DO NOT discriminate, and an earlier version
// of this comment claimed they did — measured, filtered and unfiltered agree in
// this direction at every step (3 -> 2 -> 1 both ways). `findIndex(b =>
// b.startLine === focus)` hits the phantom at index 1 when focus is 2, and the
// block above it is {1,1} either way, so the filter changes nothing going up.
//
// They are kept as documentation of the upward chain, NOT as a guard: the only
// assertion that bites the missing filter is nlStep2 above. Nor can a fixture be
// built that discriminates upward — a phantom is the OUTER block of a same-line
// nest (`- - b`), so its startLine always equals its inner child's by
// construction, and "the phantom and the next real block share a startLine" is
// the whole reason the downward step is the discriminating one.
eq(S.stepFocus({ anchorLine: 3, focusLine: 3 }, NOLINE_MID, -1), { anchorLine: 3, focusLine: 2 },
  'Shift+Up from the last block lands on line 2 (documentation, not a mutation guard)');
eq(S.stepFocus({ anchorLine: 3, focusLine: 2 }, NOLINE_MID, -1), { anchorLine: 3, focusLine: 1 },
  'and the step above THAT reaches line 1 (documentation, not a mutation guard — '
  + 'both the filtered and unfiltered navs answer 1 here)');

// --- §3.3 membership rules --------------------------------------------
const sel = { anchorLine: 5, focusLine: 7 };
eq(S.resolveMembership(sel, BLOCKS, BLOCKS[3]).mode, 'batch',
  'spec 3.3: the grip block is IN the set, so the whole set is operated on');
eq(S.resolveMembership(sel, BLOCKS, BLOCKS[3]).members.map((b) => b.id), [2, 3, 4], 'batch members');
eq(S.resolveMembership(sel, BLOCKS, BLOCKS[5]).mode, 'single',
  'spec 3.3: the grip block is OUTSIDE the set, so the set collapses to it');
eq(S.resolveMembership(sel, BLOCKS, BLOCKS[5]).members.map((b) => b.id), [5], 'single member');
eq(S.resolveMembership(null, BLOCKS, BLOCKS[3]).mode, 'single', 'no selection means single');
eq(S.resolveMembership(null, BLOCKS, BLOCKS[3]).members.map((b) => b.id), [3], 'single member');
// A one-block selection ON the grip block is still 'batch' — the set and the
// single block coincide, and the caller must not special-case size 1.
eq(S.resolveMembership({ anchorLine: 6, focusLine: 6 }, BLOCKS, BLOCKS[3]).mode, 'batch',
  'a selection of exactly the grip block is a batch of one, not a fallthrough');
// The grip block sits outside the set even though the set is non-empty and the
// grip block is a perfectly good block: 'single' must not be reachable only
// through the null-selection path.
eq(S.resolveMembership(sel, BLOCKS, BLOCKS[0]).mode, 'single',
  'a grip above the set also collapses the set');
// Task 1 carry 4 says membership is by REFERENCE, "not by id and not by line
// tuple" — and until 2026-08-31 nothing in the suite could tell the difference
// (review recommendation 3). Task 6 carry 10's mutation transcript uses
// `Object.assign({}, rec)`, which carries the id AND the lines across, so it
// does not separate `indexOf` from `some((m) => m.id === opBlock.id)` either.
// This is the fixture that does: a record with a MATCHING id and matching lines
// that is not in `blocks`. By reference it is 'single' (the conservative
// answer); by id it would be 'batch' and would silently operate on all three
// members on behalf of a block the caller never found in the list.
const ID_TWIN = { id: 3, type: 'li', startLine: 6, endLine: 6, indent: 1 };
eq(S.resolveMembership(sel, BLOCKS, ID_TWIN).mode, 'single',
  'MUTATION GUARD: identity is by REFERENCE. A record carrying the same id (3) and the '
  + 'same lines (6,6) as BLOCKS[3] — but not the object in `blocks` — is NOT a member. '
  + '`members.some((m) => m.id === opBlock.id)` answers batch here and is green against '
  + 'every other fixture in this file');
eq(S.resolveMembership(sel, BLOCKS, ID_TWIN).members, [ID_TWIN],
  'and the single member it answers with is the record it was handed, not the '
  + 'same-id record out of `blocks`');
// ANTI-VACUITY for the pair above: the very same LINES, asked with the record
// that really is in `blocks`, must answer 'batch' with all three members. A
// resolveMembership() that had degraded to answering 'single' for everything
// would pass the two assertions above and fail this one.
eq(S.resolveMembership(sel, BLOCKS, BLOCKS[3]).members.map((b) => b.id), [2, 3, 4],
  'ANTI-VACUITY: the identical selection, asked with the record FROM `blocks`, is still '
  + 'a batch of three — so the by-reference guard above is not green merely because this '
  + 'function stopped answering batch at all');

// --- collapse after an operation --------------------------------------
eq(S.collapseTo({ startLine: 5, endLine: 8 }), { anchorLine: 5, focusLine: 8 },
  'spec 3.3: the set collapses to the line range the operation produced');
eq(S.collapseTo(null), null, 'an operation that declares no range clears the selection');
eq(S.collapseTo({ startLine: 5, endLine: 4 }), null,
  'spec 4.4: a range that resolves to nothing clears the selection instead of dangling');

// --- contiguity --------------------------------------------------------
eq(S.spanIsContiguous(S.membersOf({ anchorLine: 5, focusLine: 7 }, BLOCKS), BLOCKS), true,
  'adjacent blocks are contiguous');
eq(S.spanIsContiguous([BLOCKS[0], BLOCKS[5]], BLOCKS), false,
  'a set with a gap is not contiguous — batch ops need one index range, not a loop');
eq(S.spanIsContiguous([BLOCKS[3]], BLOCKS), true, 'a single block is trivially contiguous');
// A phantom sitting BETWEEN two members breaks the index range even though the
// two members' lines are adjacent. Measured shape: buildBlockMap('- a\n- - b\n- c\n')
// -> li{1,1} | phantom{2,1} | li{2,2} | li{3,3}. The phantom is never a member,
// so members are blocks[0] and blocks[2] — index 0 and 2, a gap. Batch ops take
// one contiguous index range over a DOM run that still contains the phantom, and
// every structural path already refuses a phantom (blockOwnsNoLine), so this
// must report false rather than hand the caller a range it cannot honour.
const PHANTOM_MID = [
  { id: 0, type: 'li', startLine: 1, endLine: 1, indent: 0 },
  { id: 1, type: 'li', startLine: 2, endLine: 1, indent: 0 },
  { id: 2, type: 'li', startLine: 2, endLine: 2, indent: 1 },
  { id: 3, type: 'li', startLine: 3, endLine: 3, indent: 0 },
];
eq(S.membersOf({ anchorLine: 1, focusLine: 2 }, PHANTOM_MID).map((b) => b.id), [0, 2],
  'the phantom is excluded from the member set');
eq(S.spanIsContiguous(S.membersOf({ anchorLine: 1, focusLine: 2 }, PHANTOM_MID), PHANTOM_MID), false,
  'a phantom inside the span breaks the single index range a batch op needs');
// A block that is not in `blocks` at all cannot be part of an index range.
eq(S.spanIsContiguous([{ id: 99, type: 'li', startLine: 1, endLine: 1 }], BLOCKS), false,
  'a member that is not a record from `blocks` is not contiguous with anything');

// --- the UMD wrapper's BROWSER branch ----------------------------------
// client.js reaches sibling modules as window.md2doc<Name>; server.js injects
// them as <script> tags (INDENT_CLAMP_SRC / CONVERT_MD_SRC). A wrapper that
// only works under require() is an undefined identifier in the browser, and no
// node test would ever notice. Evaluate the source with `module` absent and a
// fake global, exactly as the injected <script> sees it.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'selection.js'), 'utf8');
const fakeRoot = {};
// eslint-disable-next-line no-new-func
new Function('self', 'module', 'exports', SRC).call(fakeRoot, fakeRoot, undefined, undefined);
assert.ok(fakeRoot.md2docSelection,
  'the UMD wrapper must attach to `root` when `module` is absent — server.js injects '
  + 'this file as a plain <script> and client.js reads window.md2docSelection');
checks += 1;
eq(Object.keys(fakeRoot.md2docSelection).sort(), Object.keys(S).sort(),
  'the browser build exports exactly the same surface as the node build');
eq(fakeRoot.md2docSelection.membersOf({ anchorLine: 5, focusLine: 7 }, BLOCKS).map((b) => b.id),
  [2, 3, 4], 'the browser build actually works, not just exists');

// --- the module is pure: no DOM, no mutation ---------------------------
const frozenSel = Object.freeze({ anchorLine: 5, focusLine: 7 });
const frozenBlocks = BLOCKS.map((b) => Object.freeze(Object.assign({}, b)));
S.membersOf(frozenSel, frozenBlocks);
S.stepFocus(frozenSel, frozenBlocks, 1);
S.resolveMembership(frozenSel, frozenBlocks, frozenBlocks[3]);
S.extendTo(frozenSel, 9);
checks += 1; // frozen inputs: any in-place write would have thrown in strict mode
eq(S.normalize(frozenSel), { startLine: 5, endLine: 7 }, 'the input selection is not mutated');

console.log('selection.test.js OK (' + checks + ' checks)');
