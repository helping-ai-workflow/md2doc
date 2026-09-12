'use strict';
const assert = require('assert');
const { replaceLines, insertLines, shiftBlocks, UndoStack } =
  require('../lib/editor/lineops.js');

const src = ['a', 'b', 'c', 'd', 'e'];

// replace lines 2-3 with one line
let r = replaceLines(src, 2, 3, ['B']);
assert.deepStrictEqual(r.lines, ['a', 'B', 'd', 'e']);
assert.strictEqual(r.delta, -1);
assert.deepStrictEqual(src, ['a', 'b', 'c', 'd', 'e'], 'input not mutated');

// insert after line 0 (prepend)
r = insertLines(src, 0, ['top']);
assert.deepStrictEqual(r.lines, ['top', 'a', 'b', 'c', 'd', 'e']);
assert.strictEqual(r.delta, 1);

// shiftBlocks moves only later blocks
const blocks = [
  { id: 0, startLine: 1, endLine: 1 },
  { id: 1, startLine: 3, endLine: 5 },
  { id: 2, startLine: 7, endLine: 9 },
];
const shifted = shiftBlocks(blocks, 1, -2);
assert.deepStrictEqual(shifted.map((b) => [b.startLine, b.endLine]),
  [[1, 1], [3, 5], [5, 7]]);
assert.notStrictEqual(shifted, blocks, 'new array');

// undo/redo round-trip
const st = new UndoStack();
let cur = ['x', 'y', 'z'];
const op = { startLine: 2, endLine: 2, before: ['y'], after: ['Y', 'Y2'] };
cur = replaceLines(cur, 2, 2, op.after).lines;
st.push(op);
assert.strictEqual(st.dirtyDepth, 1);

let u = st.undo(cur);
assert.deepStrictEqual(u.lines, ['x', 'y', 'z']);
assert.strictEqual(st.dirtyDepth, 0);
assert.strictEqual(st.undo(u.lines), null, 'stack empty');

let rd = st.redo(u.lines);
assert.deepStrictEqual(rd.lines, ['x', 'Y', 'Y2', 'z']);
assert.strictEqual(st.redo(rd.lines), null, 'nothing to redo');

// markSaved: dirtyDepth counts from save point, undo below it goes negative→dirty again
st.markSaved();
assert.strictEqual(st.dirtyDepth, 0);
u = st.undo(rd.lines);
assert.strictEqual(st.dirtyDepth, -1, 'undo past save point re-dirties');

// §10-gap fix (review): discardTop() — reverses the top op like undo()
// does, but leaves NO redo trail behind (contrast with the undo/redo
// round-trip above, where the same op comes back via redo()).
{
  const dst = new UndoStack();
  let dcur = ['p', 'q', 'r'];
  const dop = { startLine: 2, endLine: 2, before: ['q'], after: ['Q'] };
  dcur = replaceLines(dcur, 2, 2, dop.after).lines; // ['p', 'Q', 'r']
  dst.push(dop);
  assert.strictEqual(dst.dirtyDepth, 1);

  const d = dst.discardTop(dcur);
  assert.deepStrictEqual(d.lines, ['p', 'q', 'r'], 'discardTop reverses the op exactly like undo would');
  assert.strictEqual(dst.dirtyDepth, 0, 'the discarded op no longer counts toward dirtiness');
  assert.strictEqual(dst.redo(d.lines), null,
    'discardTop must leave NO redo trail — this is what distinguishes it from undo()');
  assert.strictEqual(dst.undo(d.lines), null, 'the stack is genuinely empty, not just redo-less');
  assert.strictEqual(dst.discardTop(d.lines), null, 'discardTop on an empty stack is a no-op, same contract as undo()/redo()');
}

// v3.2.0: undo/discardTop 套用時反轉 op，回傳的卻是正向 op。
// 增量 render 的 editRange 必須用「套用後的 span」，不是 op 自己的。
{
  const stack = new UndoStack();
  const before = ['para one'];
  const after = ['a', '', 'b'];
  const op = { startLine: 3, endLine: 3, before, after };
  stack.push(op);
  const lines = ['# H', '', 'a', '', 'b', '', 'tail'];
  const r = stack.undo(lines);
  // 套用後真正被換掉的是 3..5（3 行 -> 1 行），delta -2
  const applied = {
    startLine: r.op.startLine,
    endLine: r.op.startLine + r.op.after.length - 1,
    delta: r.op.before.length - r.op.after.length,
  };
  assert.deepStrictEqual(applied, { startLine: 3, endLine: 5, delta: -2 },
    'undo 的 editRange 必須由 op.after 的長度推導，不是 op.endLine');
  assert.strictEqual(r.op.endLine, 3,
    '回傳的 op 本身仍是正向的——直接拿它當 editRange 會算出相反的方向');
}

// ---------------------------------------------------------------------------
// v3.4.0 batch3 Task 7 fix 1 (F3): the redo tail is a value a caller can take
// and hand back.
//
// `push()` clears `_undone` — correct for an edit the document keeps, wrong for
// one that is later withdrawn as if it had never happened. `discardTop()` puts
// the bytes and the depth back and CANNOT put the branch back, so without these
// two accessors a caller that discards its own ops silently eats a redo the
// user had before it started.
// ---------------------------------------------------------------------------
{
  const stack = new UndoStack();
  let lines = ['# H', '', 'para'];
  // One ordinary edit, then undo it: there is now a redo branch.
  stack.push({ startLine: 3, endLine: 3, before: ['para'], after: ['para EDITED'] });
  lines = ['# H', '', 'para EDITED'];
  lines = stack.undo(lines).lines;
  assert.deepStrictEqual(lines, ['# H', '', 'para'], 'fixture: the undo landed');
  assert.strictEqual(stack.redoTail().length, 1, 'fixture: there is a redo branch');
  const saved = stack.redoTail();

  // A session that commits and then withdraws its own commits.
  stack.push({ startLine: 3, endLine: 3, before: ['para'], after: ['para WAVE'] });
  lines = ['# H', '', 'para WAVE'];
  assert.strictEqual(stack.redoTail().length, 0,
    'fixture: pushing cleared the branch, which is exactly the defect');
  lines = stack.discardTop(lines).lines;
  assert.deepStrictEqual(lines, ['# H', '', 'para'],
    'discardTop put the bytes back');
  assert.strictEqual(stack.redoTail().length, 0,
    'discardTop CANNOT put the branch back on its own — that is why these exist');

  stack.setRedoTail(saved);
  const r = stack.redo(lines);
  assert.notStrictEqual(r, null,
    'after setRedoTail the pre-session redo must be reachable again');
  assert.deepStrictEqual(r.lines, ['# H', '', 'para EDITED'],
    'and it must redo the edit the user actually had. Got ' + JSON.stringify(r.lines));
}
{
  // The copies are copies: a caller holding a tail cannot be mutated from under
  // it, and handing one back cannot alias the stack's own array.
  const stack = new UndoStack();
  stack.push({ startLine: 1, endLine: 1, before: ['a'], after: ['b'] });
  stack.undo(['b']);
  const tail = stack.redoTail();
  stack.setRedoTail(tail);
  tail.length = 0;
  assert.strictEqual(stack.redoTail().length, 1,
    'setRedoTail must copy — a caller clearing its own array may not empty the stack');
  stack.setRedoTail(undefined);
  assert.strictEqual(stack.redoTail().length, 0, 'a non-array reads as no branch');
}

console.log('lineops.test.js OK');
