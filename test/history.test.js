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
h = createBurstHistory(capture, { now: () => 0 });
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
h.noteTyping({ now: () => 401 });
assert.strictEqual(h.size(), 2, 'noteTyping at 401ms snaps');

state = 'v0.3';
h.noteTyping({ now: () => 500 });
assert.strictEqual(h.size(), 2, 'within 400ms window, no snap');

h.noteTyping({ now: () => 902 });
assert.strictEqual(h.size(), 3, 'at 902ms (>401+500), snap');

// flushTyping forces snapshot now
h = createBurstHistory(capture, { now: () => 0 });
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
h = createBurstHistory(capture, { now: () => 0 });
state = 'v0';
h.start();

state = 'v1';
h.snap('edit');

state = 'v1.1';
h.noteTyping({ now: () => 0 });
assert.strictEqual(h.size(), 2, 'pending typing not snapped yet');

let undoState = h.undo({ now: () => 100 });
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

// dispose
h = createBurstHistory(capture);
h.start();
h.dispose();
// After dispose, should not crash but behavior is undefined
// Just testing that it doesn't throw

console.log('history.test.js OK');
