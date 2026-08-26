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

console.log('lineops.test.js OK');
