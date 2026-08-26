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
  Object.defineProperty(UndoStack.prototype, 'dirtyDepth', {
    get() { return this._done.length - this._savedDepth; },
  });
  UndoStack.prototype.markSaved = function () {
    this._savedDepth = this._done.length;
  };

  return { replaceLines, insertLines, shiftBlocks, UndoStack };
});
