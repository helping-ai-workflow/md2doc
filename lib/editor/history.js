'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.md2docHistory = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  function createBurstHistory(captureFn, options = {}) {
    const debounceMs = options?.debounceMs ?? 400;
    const getNow = options?.now ?? (() => Date.now());

    let stack = [];
    let redoTail = [];
    let lastNoteTime = null;
    let isPendingSnap = false;

    return {
      start() {
        stack = [captureFn()];
        redoTail = [];
        lastNoteTime = null;
        isPendingSnap = false;
      },

      snap(reason) {
        const current = captureFn();
        const top = stack[stack.length - 1];

        if (current !== top) {
          stack.push(current);
          redoTail = [];
        }

        isPendingSnap = false;
      },

      noteTyping(noteOptions = {}) {
        const nowTime = noteOptions?.now?.() ?? getNow();

        if (isPendingSnap && lastNoteTime !== null && nowTime - lastNoteTime >= debounceMs) {
          // Debounce interval has elapsed, snap the pending capture
          this.snap('typing');
        }

        // Mark/update pending snapshot
        isPendingSnap = true;
        lastNoteTime = nowTime;
      },

      flushTyping() {
        if (isPendingSnap) {
          this.snap('typing');
        }
      },

      undo(undoOptions = {}) {
        // First flush any pending typing debounce
        this.flushTyping();

        // Then step back
        if (stack.length <= 1) return null;

        redoTail.push(stack.pop());
        return stack[stack.length - 1];
      },

      redo() {
        if (redoTail.length === 0) return null;

        stack.push(redoTail.pop());
        return stack[stack.length - 1];
      },

      atBottom() {
        return stack.length === 1;
      },

      size() {
        return stack.length;
      },

      dispose() {
        stack = [];
        redoTail = [];
        isPendingSnap = false;
        lastNoteTime = null;
      }
    };
  }

  return { createBurstHistory };
});
