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

  // ── v3.4.0 batch3 Task 7 fix 2: what "saved" is allowed to mean ──────────
  //
  // `_savedDepth` marks WHERE ON `_done` the bytes that are on disk were
  // reached. It was an unconditional index, and an index into a stack that can
  // be rewound is not a fact about the document — it is a second record of one,
  // and it drifts.
  //
  // MEASURED on the shipped v3.3.0 behaviour, with no wave editor anywhere near
  // it: type into a paragraph, commit, Ctrl+S, Ctrl+Z, then make one more
  // ordinary edit. `_done.length` is 1 again and `_savedDepth` is still 1, so
  // `dirtyDepth` is 0 — `documentIsDirty()` answers false, the title dot goes
  // out, the save button greys, `beforeunload` does not fire, and the conflict
  // banner's Reload discards BOTH the undone save and the new edit without
  // asking. The depth arithmetic said "you are standing where you saved"; the
  // user was standing somewhere else entirely, because the branch that led to
  // the save point had been replaced.
  //
  // The invariant this restores is the only one that is worth anything here:
  // **"not dirty" means what is in memory equals what is on disk.** A counter
  // that can pass through zero from below cannot express it, so the marker is
  // INVALIDATED — set to null — the moment history diverges past it, which is
  // exactly the moment a `push()` happens below it. From then on the saved
  // state is not reachable anywhere on this stack and the honest answer to "are
  // we standing on it" is no, until `markSaved()` establishes a new one.
  //
  // Undo alone does NOT invalidate: undo then redo puts the same ops back and
  // the marker still names the same state, which is why the rewind itself is
  // not the divergence — the push that replaces the rewound branch is.
  function UndoStack() {
    this._done = [];
    this._undone = [];
    // null = "the saved state is not on this stack any more". Callers must not
    // read it as a number; ask `isDirty()`.
    this._savedDepth = 0;
  }
  UndoStack.prototype.push = function (op) {
    if (this._savedDepth !== null && this._done.length < this._savedDepth) {
      // History has been rewound past the save point and is now growing a
      // different branch: the ops that produced the saved bytes are gone from
      // this stack and no sequence of undo/redo can get back to them.
      this._savedDepth = null;
    }
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
  // Does memory differ from disk? The one question the product actually asks,
  // and a boolean rather than a distance precisely because a distance is what
  // walked through zero. `documentIsDirty()` in client.js reads this.
  UndoStack.prototype.isDirty = function () {
    return this._savedDepth === null || this._done.length !== this._savedDepth;
  };
  // How far the stack has moved since the save point, for diagnostics and for
  // tests that want to see the shape of a sequence. When the marker has been
  // invalidated there IS no distance — the state it named is not on the stack —
  // so this answers with a value that is deliberately never 0, and callers that
  // only want the yes/no must ask `isDirty()` instead of comparing this.
  Object.defineProperty(UndoStack.prototype, 'dirtyDepth', {
    get() {
      if (this._savedDepth === null) return this._done.length + 1;
      return this._done.length - this._savedDepth;
    },
  });
  // How many ops are on the done-stack. Exposed so a caller that pushed N ops
  // can check that the top N are still its own — a question about the STACK,
  // with no premise about the save marker, which is what makes it composable
  // with `savedDepth` below rather than entangled with it.
  Object.defineProperty(UndoStack.prototype, 'depth', {
    get() { return this._done.length; },
  });
  // WHERE the marker is, or null when the saved state is not on this stack any
  // more. A caller that needs to reason about a range of the stack — "would
  // removing my own N ops destroy the state disk was written from?" — needs the
  // position, not the distance. It is deliberately nullable rather than a
  // sentinel number: arithmetic on it is exactly the mistake this whole rework
  // is about, and `null` makes that arithmetic loud instead of plausible.
  Object.defineProperty(UndoStack.prototype, 'savedDepth', {
    get() { return this._savedDepth; },
  });
  UndoStack.prototype.markSaved = function () {
    this._savedDepth = this._done.length;
  };

  return { replaceLines, insertLines, shiftBlocks, UndoStack };
});
