'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.md2docLineOps = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  function replaceLines(lines, startLine, endLine, newLines) {
    const out = lines.slice(0, startLine - 1)
      .concat(newLines, lines.slice(endLine));
    return { lines: out, delta: newLines.length - (endLine - startLine + 1) };
  }

  function insertLines(lines, afterLine, newLines) {
    const out = lines.slice(0, afterLine).concat(newLines, lines.slice(afterLine));
    return { lines: out, delta: newLines.length };
  }

  function shiftBlocks(blocks, editedId, delta) {
    return blocks.map((b) =>
      b.id > editedId
        ? Object.assign({}, b, { startLine: b.startLine + delta, endLine: b.endLine + delta })
        : b
    );
  }

  function UndoStack() {
    this._done = [];
    this._undone = [];
    this._savedDepth = 0;
  }
  UndoStack.prototype.push = function (op) {
    this._done.push(op);
    this._undone.length = 0;
  };
  UndoStack.prototype.undo = function (lines) {
    const op = this._done.pop();
    if (!op) return null;
    this._undone.push(op);
    const span = { startLine: op.startLine, endLine: op.startLine + op.after.length - 1 };
    return { lines: replaceLines(lines, span.startLine, span.endLine, op.before).lines, op };
  };
  UndoStack.prototype.redo = function (lines) {
    const op = this._undone.pop();
    if (!op) return null;
    this._done.push(op);
    return { lines: replaceLines(lines, op.startLine, op.endLine, op.after).lines, op };
  };
  // §10-gap fix (review): pops the top of the stack and reverses it
  // directly on `lines`, exactly like undo() — but, UNLIKE undo(), never
  // pushes the popped op onto `_undone`. There is nothing to "redo" back
  // to: as far as the stack's history is concerned this op never
  // happened. Used to collapse an insert-then-immediately-abandon
  // (never edited) block insertion to a true no-op — the file AND the
  // undo stack both end up byte-identical to their pre-insert state,
  // not merely "one undo away from it". Returns null if the stack is
  // empty — same contract as undo()/redo().
  UndoStack.prototype.discardTop = function (lines) {
    const op = this._done.pop();
    if (!op) return null;
    const span = { startLine: op.startLine, endLine: op.startLine + op.after.length - 1 };
    return { lines: replaceLines(lines, span.startLine, span.endLine, op.before).lines, op };
  };
  // v3.4.0 batch3 Task 7 fix 1 (F3) — read and write the REDO tail.
  //
  // `push()` clears `_undone`, and that is correct for an ordinary edit: once
  // the document has moved forward, the branch that was undone is gone. It is
  // NOT correct for an edit that is later withdrawn as if it had never
  // happened — `discardTop()` can put the bytes and the depth back, but it has
  // no way to put the branch back, so a caller that discards its own ops
  // silently consumes a redo the user had before it started. MEASURED on the
  // wave editor: type into a paragraph, commit, Ctrl+Z (the edit is redoable),
  // open the wave editor, paint, Escape — and Ctrl+Y then brings nothing back,
  // over a document that is byte-identical to the one that had the redo.
  //
  // So the tail is a value a caller can take before it starts and hand back
  // when it withdraws. Deliberately two plain accessors rather than a
  // "transaction" API: the only caller is `finishWaveSession()`, the copies
  // keep `_undone` unaliased, and an ordinary push still clears it exactly as
  // before.
  UndoStack.prototype.redoTail = function () {
    return this._undone.slice();
  };
  UndoStack.prototype.setRedoTail = function (tail) {
    this._undone = Array.isArray(tail) ? tail.slice() : [];
  };
  Object.defineProperty(UndoStack.prototype, 'dirtyDepth', {
    get() { return this._done.length - this._savedDepth; },
  });
  UndoStack.prototype.markSaved = function () {
    this._savedDepth = this._done.length;
  };

  return { replaceLines, insertLines, shiftBlocks, UndoStack };
});
