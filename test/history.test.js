'use strict';
const assert = require('assert');
const { createBurstHistory } = require('../lib/editor/history.js');

// Basic start/snap/undo/redo flow
let state = 'v0';
const capture = () => state;

let h = createBurstHistory(capture);
h.start();
assert.strictEqual(h.size(), 1, 'size after start');

state = 'v1';
h.snap('edit');
assert.strictEqual(h.size(), 2);
assert.strictEqual(h.atBottom(), false, 'not at bottom after snap');

state = 'v2';
h.snap('edit');
assert.strictEqual(h.size(), 3);

let u = h.undo();
assert.strictEqual(u, 'v1', 'undo returns state');
assert.strictEqual(h.size(), 2, 'size decreases after undo');

u = h.undo();
assert.strictEqual(u, 'v0');

u = h.undo();
assert.strictEqual(u, null, 'undo returns null at bottom');
assert.strictEqual(h.atBottom(), true, 'at bottom now');

let r = h.redo();
assert.strictEqual(r, 'v1', 'redo returns state (first redo step)');

r = h.redo();
assert.strictEqual(r, 'v2', 'redo returns v2');

r = h.redo();
assert.strictEqual(r, null, 'redo returns null at top');

// Redo clears on new snap
h.undo();
h.undo();
assert.strictEqual(h.redo(), 'v1', 'redo works');
assert.strictEqual(h.redo(), 'v2', 'second redo returns v2');

state = 'v2-alt';
h.snap('edit');
assert.strictEqual(h.redo(), null, 'redo tail cleared after snap');
assert.strictEqual(h.size(), 4, 'size 4: v0, v1, v2, v2-alt (snap added v2-alt)');

// Dedupe: snap only if different from top
state = 'v2-alt';
h.snap('edit');
assert.strictEqual(h.size(), 4, 'size unchanged on duplicate snap');

state = 'v3';
h.snap('edit');
assert.strictEqual(h.size(), 5, 'size increased on unique snap');

// Typing debounce coalesces multiple notes
let t = 0;
h = createBurstHistory(capture, { now: () => t });
state = 'v0';
h.start();
assert.strictEqual(h.size(), 1);

state = 'v0.1';
h.noteTyping();
assert.strictEqual(h.size(), 1, 'noteTyping does not snap immediately');

state = 'v0.2';
h.noteTyping();
assert.strictEqual(h.size(), 1, 'multiple noteTyping still 1 (debounced)');

// After time elapses, next noteTyping forces snap
t = 401;
h.noteTyping();
assert.strictEqual(h.size(), 2, 'noteTyping at 401ms snaps');

state = 'v0.3';
t = 500;
h.noteTyping();
assert.strictEqual(h.size(), 2, 'within 400ms window, no snap');

t = 902;
h.noteTyping();
assert.strictEqual(h.size(), 3, 'at 902ms (>401+500), snap');

// flushTyping forces snapshot now
t = 0;
h = createBurstHistory(capture, { now: () => t });
state = 'v0';
h.start();

state = 'v0.1';
h.noteTyping();
assert.strictEqual(h.size(), 1, 'pending debounce not snapped');

h.flushTyping();
assert.strictEqual(h.size(), 2, 'flushTyping forces snapshot');

state = 'v0.2';
h.noteTyping();
h.flushTyping();
assert.strictEqual(h.size(), 3);

// undo() flushes pending typing debounce before stepping
t = 0;
h = createBurstHistory(capture, { now: () => t });
state = 'v0';
h.start();

state = 'v1';
h.snap('edit');

state = 'v1.1';
h.noteTyping();
assert.strictEqual(h.size(), 2, 'pending typing not snapped yet');

let undoState = h.undo();
assert.strictEqual(undoState, 'v1', 'undo returned v1 (after flushing v1.1 and stepping back)');
assert.strictEqual(h.size(), 2, 'size is 2 after undo (v1.1 moved to redo tail)');

// redo does not have pending state, so no flush needed
h = createBurstHistory(capture, { now: () => 0 });
state = 'v0';
h.start();

state = 'v1';
h.snap('edit');

state = 'v2';
h.snap('edit');

h.undo();
h.undo();

state = 'vX';
let redoState = h.redo();
assert.strictEqual(redoState, 'v1', 'redo returned v1 (first step forward)');

// ── v3.1.0: the debounce BOUNDARY and the snapshot VALUES ──────────────────
//
// The tests above pin the debounce by stack SIZE. These pin the arithmetic by
// the VALUES that go on the stack and come back off it, because that is what
// actually bit: test/editor-client-runtime.test.js's "Ctrl+Z mid-burst" e2e
// typed ' EDIT-TWO' with page.keyboard.type() and asserted the undo landed on
// the burst's pre-focus snapshot. Whenever a >= debounceMs stall happened to
// fall between two of those nine keystrokes — a loaded CI box, a GC pause —
// noteTyping() pushed the HALF-TYPED text as a real snapshot, and the undo
// landed there instead. Measured symptom: '... EDIT-ONE EDIT-TW', exactly one
// character short, intermittently.
//
// That e2e is now driven by ONE synthetic input event so it cannot straddle
// the window at all, which removes its (accidental) coverage of the
// multi-keystroke debounce. This section replaces that coverage, deliberately
// better than it was: it states the boundary condition and the exact
// three-step sequence in a second, deterministically, instead of once every
// twenty minutes and only when the machine happened to stall.
{
  // A miniature of the real burst: `buf` is the editable surface's text and
  // `capture` is burstBaselineHtml(). Time is explicit, so "the machine
  // stalled" becomes a parameter instead of a coin flip.
  const CHARS = ' EDIT-TWO'.split('');
  const BASE = 'Burst undo target text here. EDIT-ONE';

  // Types CHARS one keystroke at a time, advancing the clock by `stepMs`
  // between them and inserting one `stallMs` pause BEFORE the character at
  // index `stallBefore` (use -1 for no stall at all). Mirrors client.js's
  // delegated `input` listener, which calls noteTyping() once per keystroke
  // AFTER the character has landed in the DOM.
  function typeBurst({ stallBefore, stallMs = 600, stepMs = 5 }) {
    let clock = 0;
    let buf = BASE;
    const hist = createBurstHistory(() => buf, { now: () => clock });
    hist.start();
    CHARS.forEach((ch, i) => {
      clock += (i === stallBefore) ? stallMs : stepMs;
      buf += ch;
      hist.noteTyping();
    });
    return { hist, typed: buf };
  }

  // 1. No stall: every keystroke coalesces into ONE pending snapshot, so
  //    undo() lands on snapshot 0 — the pre-typing baseline. This is the
  //    property the e2e asserts, now pinned where no timing can reach it.
  {
    const { hist, typed } = typeBurst({ stallBefore: -1 });
    assert.strictEqual(typed, BASE + ' EDIT-TWO', 'fixture sanity: all nine keystrokes landed');
    assert.strictEqual(hist.size(), 1, 'an unstalled burst pushes no intermediate snapshot');
    assert.strictEqual(hist.undo(), BASE,
      'undo() on an unstalled burst returns the pre-typing snapshot, not a partial word');
  }

  // 2. THE REPORTED FAILURE, as pure arithmetic. The stall sits before the
  //    EIGHTH character ('W', index 7), so the noteTyping() that follows it
  //    snaps the text as it stands at that moment — including that eighth
  //    character. '... EDIT-TW' becomes a real stack entry; the ninth
  //    keystroke then leaves a pending snap which undo()'s own flushTyping()
  //    pushes on top; and the pop therefore returns the half-typed word.
  {
    const { hist } = typeBurst({ stallBefore: 7 });
    assert.strictEqual(hist.size(), 2,
      'a stall before the eighth keystroke pushes the half-typed text as a snapshot');
    assert.strictEqual(hist.undo(), BASE + ' EDIT-TW',
      'undo() after a mid-word stall lands on the half-typed snapshot — this exact value, ' +
      "'... EDIT-TW', is what the e2e reported intermittently before it was hardened");
    // ...and the tail really was pushed rather than dropped: redo() can reach
    // the fully typed text, which is only possible if undo()'s flushTyping()
    // snapped it first.
    assert.strictEqual(hist.redo(), BASE + ' EDIT-TWO',
      "undo()'s own flushTyping() must push the pending tail, so redo() can reach it");
  }

  // 3. A stall before the LAST character is harmless, and that asymmetry is
  //    the whole reason the failure looked random: the snap it triggers
  //    captures the COMPLETE text, which flushTyping() then finds unchanged
  //    and does not duplicate, so the single pop still reaches snapshot 0.
  {
    const { hist } = typeBurst({ stallBefore: 8 });
    assert.strictEqual(hist.undo(), BASE,
      'a stall before the FINAL keystroke still lands undo() on snapshot 0 — only a stall ' +
      'before an INTERIOR keystroke strands a partial word on the stack');
  }

  // 4. The boundary is `>=`, not `>`. A gap of exactly debounceMs snaps; one
  //    millisecond under it does not. Written as two mirrored cases so a
  //    mutation of that comparison cannot pass by satisfying only one side.
  {
    let clock = 0;
    let buf = 'a';
    const exact = createBurstHistory(() => buf, { now: () => clock, debounceMs: 400 });
    exact.start();
    buf = 'ab'; exact.noteTyping();          // arms the pending snapshot
    clock = 400; buf = 'abc'; exact.noteTyping();
    assert.strictEqual(exact.size(), 2, 'a gap of EXACTLY debounceMs snaps (the test is >=)');
  }
  {
    let clock = 0;
    let buf = 'a';
    const under = createBurstHistory(() => buf, { now: () => clock, debounceMs: 400 });
    under.start();
    buf = 'ab'; under.noteTyping();
    clock = 399; buf = 'abc'; under.noteTyping();
    assert.strictEqual(under.size(), 1, 'a gap one millisecond UNDER debounceMs does not snap');
  }

  // 5. debounceMs is honoured as an option, not hard-coded — the e2e's whole
  //    fragility was a function of this number, so the number has to be real.
  {
    let clock = 0;
    let buf = 'a';
    const fast = createBurstHistory(() => buf, { now: () => clock, debounceMs: 10 });
    fast.start();
    buf = 'ab'; fast.noteTyping();
    clock = 12; buf = 'abc'; fast.noteTyping();
    assert.strictEqual(fast.size(), 2, 'a custom debounceMs of 10 snaps after a 12ms gap');
    // One more keystroke inside the window, so the pending tail DIFFERS from
    // what the gap snapped. That is what makes the next assertion meaningful:
    // the snapshot the gap pushed is the text as it stood ON that keystroke
    // ('abc'), not the baseline and not the final text.
    clock = 13; buf = 'abcd'; fast.noteTyping();
    assert.strictEqual(fast.undo(), 'abc',
      'the snapshot the gap pushed is the text as it stood on THAT keystroke — the ' +
      'snap runs after the character has landed, which is precisely why an interior ' +
      'stall strands a partial word and a final-keystroke stall does not');
  }
}

// dispose
h = createBurstHistory(capture);
h.start();
h.dispose();
// After dispose, should not crash but behavior is undefined
// Just testing that it doesn't throw

console.log('history.test.js OK');
