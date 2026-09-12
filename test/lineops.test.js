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

// ---------------------------------------------------------------------------
// v3.4.0 batch3 Task 7 fix 2 — "not dirty" must mean "memory equals disk".
//
// This is a PRE-EXISTING defect, live in v3.3.0 and reachable with no wave
// editor anywhere near it. `_savedDepth` was an unconditional index into a
// stack that can be rewound, so once history diverged past the save point the
// depth arithmetic could walk back onto zero from below and report a document
// that differs from disk as clean — title dot out, save button grey,
// `beforeunload` silent, and the conflict banner's Reload discarding the lot.
//
// The fixture carries the DOCUMENT alongside the stack and asserts against
// `memory === disk` at every step, so it cannot agree with a stack that merely
// keeps a tidy-looking counter.
// ---------------------------------------------------------------------------
{
  const stack = new UndoStack();
  let lines = ['# H', '', 'para'];
  let disk = null;                       // what the last save wrote
  const save = () => { disk = lines.join('\n'); stack.markSaved(); };
  const edit = (text) => {
    const op = { startLine: 3, endLine: 3, before: [lines[2]], after: [text] };
    stack.push(op);
    lines = replaceLines(lines, 3, 3, [text]).lines;
  };
  const agree = () => disk === lines.join('\n');

  edit('para EDITED');
  save();
  assert.strictEqual(agree(), true, 'fixture: the save really did land');
  assert.strictEqual(stack.isDirty(), false, '剛存完就是乾淨的');

  lines = stack.undo(lines).lines;        // ordinary Ctrl+Z, past the save point
  assert.strictEqual(agree(), false, 'fixture: the undo moved memory off disk');
  assert.strictEqual(stack.isDirty(), true,
    '撤銷到存檔點之前，記憶體跟磁碟不一樣，就必須是髒的');

  // …and here is the whole defect: ONE more ordinary edit.
  edit('para SOMETHING ELSE');
  assert.strictEqual(agree(), false,
    'fixture: memory still differs from disk — in the undone save AND in this edit');
  assert.strictEqual(stack.isDirty(), true,
    '一筆普通的編輯不得讓文件回報成乾淨的 —— 這就是那個實測到的資料遺失路徑：' +
    '● 熄掉、beforeunload 不再攔、衝突 banner 的 Reload 把兩筆都丟掉');
  // And it must stay that way however many more edits happen: the saved state
  // is not on this stack any more, and no amount of pushing puts it back.
  for (let i = 0; i < 5; i++) {
    edit('para ' + i);
    assert.strictEqual(stack.isDirty(), true,
      'edit ' + i + '：存檔點已經不在這個 stack 上了，之後每一筆都還是髒的');
  }
  // The only thing that makes it clean again is actually saving.
  save();
  assert.strictEqual(stack.isDirty(), false, '真的存檔才會乾淨');
  assert.strictEqual(agree(), true, '而那時候記憶體跟磁碟真的一樣');
}
{
  // The CONTROL, and the reason the invalidation is on `push()` and not on
  // `undo()`: an undo that is redone lands back on the very state that was
  // saved, so the marker still names something real and the document IS clean.
  // An implementation that invalidated on the rewind itself would over-warn
  // here for the rest of the session.
  const stack = new UndoStack();
  let lines = ['# H', '', 'para'];
  stack.push({ startLine: 3, endLine: 3, before: ['para'], after: ['para EDITED'] });
  lines = ['# H', '', 'para EDITED'];
  const disk = lines.join('\n');
  stack.markSaved();
  lines = stack.undo(lines).lines;
  assert.strictEqual(stack.isDirty(), true, 'control: 撤銷之後是髒的');
  lines = stack.redo(lines).lines;
  assert.strictEqual(lines.join('\n'), disk, 'control: redo 把位元組帶回存檔的那一份');
  assert.strictEqual(stack.isDirty(), false,
    'control: 撤銷再重做回到存檔的狀態，就必須重新變回乾淨 —— 失效要綁在' +
    '【分岔的那一發 push】上，不是綁在撤銷上');
  assert.strictEqual(stack.dirtyDepth, 0, 'control: 距離也回到 0');
}
{
  // `savedDepth` is WHERE the marker is, or null once the saved state is not on
  // this stack any more. A caller reasoning about a RANGE of the stack — "would
  // removing my own N ops destroy the state disk was written from?" — needs the
  // position, and needs `null` to be loud rather than a number it can subtract.
  const stack = new UndoStack();
  assert.strictEqual(stack.savedDepth, 0, 'a fresh stack is saved at 0');
  stack.push({ startLine: 1, endLine: 1, before: ['a'], after: ['b'] });
  assert.strictEqual(stack.savedDepth, 0, 'an ordinary push does not move it');
  stack.markSaved();
  assert.strictEqual(stack.savedDepth, 1, 'markSaved does');
  stack.undo(['b']);
  assert.strictEqual(stack.savedDepth, 1,
    'an undo alone does not — the marker still names a state redo can reach');
  stack.push({ startLine: 1, endLine: 1, before: ['a'], after: ['c'] });
  assert.strictEqual(stack.savedDepth, null,
    'a push past the marker does: the state it named is gone from this stack');
  stack.markSaved();
  assert.strictEqual(stack.savedDepth, 1,
    'and saving again establishes a new one — note the VALUE is back to what it ' +
    'was, which is why a caller must compare POSITIONS against its own baseline ' +
    'rather than watch this number for change');
}
{
  // `depth` is the other half — a question about the STACK with no premise
  // about the marker, so a caller that pushed N ops can check the top N are
  // still its own.
  const stack = new UndoStack();
  assert.strictEqual(stack.depth, 0);
  stack.push({ startLine: 1, endLine: 1, before: ['a'], after: ['b'] });
  stack.push({ startLine: 1, endLine: 1, before: ['b'], after: ['c'] });
  assert.strictEqual(stack.depth, 2);
  stack.discardTop(['c']);
  assert.strictEqual(stack.depth, 1, 'discardTop takes one off');
  stack.markSaved();
  assert.strictEqual(stack.depth, 1, 'markSaved moves the marker, not the stack');
}
{
  // `dirtyDepth` keeps working as a distance while there IS one, and is
  // deliberately never 0 once there is not.
  const stack = new UndoStack();
  assert.strictEqual(stack.dirtyDepth, 0, 'a fresh stack is at its save point');
  stack.push({ startLine: 1, endLine: 1, before: ['a'], after: ['b'] });
  assert.strictEqual(stack.dirtyDepth, 1);
  stack.markSaved();
  stack.undo(['b']);
  assert.strictEqual(stack.dirtyDepth, -1, 'below the marker it is still a distance');
  stack.push({ startLine: 1, endLine: 1, before: ['a'], after: ['c'] });
  assert.notStrictEqual(stack.dirtyDepth, 0,
    'and once the marker is gone it must never read 0 — that is the number the ' +
    'old predicate walked onto');
  assert.strictEqual(stack.isDirty(), true, 'which is what isDirty() says outright');
}

console.log('lineops.test.js OK');
