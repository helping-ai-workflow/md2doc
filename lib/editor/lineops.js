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
  /**
   * A receipt for "these are the bytes I am about to write to disk".
   *
   * Taken BEFORE the save request leaves, and handed back to `markSaved()` when
   * the response lands. See markSaved() for the measured race this closes.
   *
   * The receipt is a depth plus the IDENTITY of the op at that depth's
   * boundary. The depth alone is not enough: the user can undo and re-edit
   * during a round trip, and the stack is then back at the same depth holding a
   * different op — measured, that combination marked bytes as saved that disk
   * had never held. Op objects are created fresh by each commit, so identity is
   * an exact fingerprint and costs a reference.
   *
   * ── Why ONE boundary op is enough (fix 4 / R5) ─────────────────────────
   *
   * It looks like an under-check: the receipt fingerprints a single op, yet it
   * is trusted to mean "the whole prefix `_done[0 .. depth-1]` is unchanged".
   * It holds, and the argument is worth having in one place rather than
   * reconstructed from four:
   *
   *   1. The timeline is only ever edited at its TOP. `push()` appends,
   *      `undo()` moves the top entry onto `_undone`, `redo()` moves it back,
   *      and `discardTop()` drops it. Nothing in this file writes at an
   *      interior index — there is no splice, no sort, no assignment to
   *      `_done[i]`. So a prefix can only change by first being exposed, i.e.
   *      by everything above it coming off.
   *   2. Therefore, if the op at index `depth-1` is still that same object,
   *      nothing ever popped BELOW `depth-1` in between — had it, that op would
   *      have come off too, and the only way an identical object returns is
   *      `redo()`, which also restores every entry below it unchanged (it pops
   *      `_undone` in the exact reverse order `undo()` pushed it).
   *   3. Identity, not equality: a commit builds a fresh `{startLine, endLine,
   *      before, after}` literal every time, so two different edits can never
   *      share an object, and a re-edit that happens to produce the same bytes
   *      is still a different object — which is the conservative direction.
   *   4. `setRedoTail()` is the one place `_undone` is replaced wholesale, and
   *      it is handed back exactly the array `redoTail()` copied out, so the
   *      objects in it are the same objects. A wave session's withdrawal
   *      therefore restores the timeline, it does not fabricate one.
   *
   * The check is conservative where it is imperfect: anything it cannot prove
   * unchanged reads as changed, and a refused receipt leaves the document
   * DIRTY. Its failure direction is over-warning.
   */
  UndoStack.prototype.saveToken = function () {
    return {
      depth: this._done.length,
      op: this._done.length === 0 ? null : this._done[this._done.length - 1],
    };
  };

  /**
   * Where on the timeline `token.depth - 1` now lives, whether it has since been
   * undone or not — `undefined` when that index is off the end of both stacks.
   *
   * An op that was undone during a save round trip is still the same op and can
   * still be redone back into place, so it must NOT read as a divergence; it
   * has merely moved from `_done` onto `_undone`, which is a LIFO, hence the
   * mirrored index.
   */
  function timelineOpAt(stack, index) {
    if (index < 0) return null;
    if (index < stack._done.length) return stack._done[index];
    const j = stack._done.length + stack._undone.length - 1 - index;
    if (j < 0 || j >= stack._undone.length) return undefined;
    return stack._undone[j];
  }

  /**
   * Record that disk now holds the bytes the given receipt describes.
   *
   * MEASURED before the receipt existed, with no wave editor involved: type,
   * commit, Ctrl+S, then press Ctrl+Z while the request is still in flight. The
   * 200 arrived and marked whatever depth happened to exist AT THAT MOMENT —
   * the post-undo one — as the saved point, so `isDirty()` answered false over a
   * document that differs from disk. All three nets failed together there: the
   * title dot, the unload guard, AND the conflict check (the response had just
   * advanced `mtimeMs`, so the next save would not 409 either). Closing the tab
   * left on disk an edit the user had explicitly undone.
   *
   * With a receipt the marker is established against the depth the bytes were
   * taken from, not the depth the reply happened to find — and only if the
   * timeline at that boundary is still the same one. Where it is not, the saved
   * state is not reachable on this stack at all and the marker is invalidated,
   * which is the same answer `push()` gives for the same reason.
   *
   * No argument still means "right here, right now", which is what every
   * synchronous caller and every test wants.
   */
  UndoStack.prototype.markSaved = function (token) {
    if (token === undefined || token === null) {
      this._savedDepth = this._done.length;
      return true;
    }
    if (timelineOpAt(this, token.depth - 1) !== token.op) {
      this._savedDepth = null;
      return false;
    }
    this._savedDepth = token.depth;
    return true;
  };

  return { replaceLines, insertLines, shiftBlocks, UndoStack };
});
