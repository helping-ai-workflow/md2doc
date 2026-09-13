'use strict';
const assert = require('assert');
const { replaceLines, insertLines, shiftBlocks, UndoStack } =
  require('../lib/editor/lineops.js');
// The wave editor's own discard predicate, for the agreement sweep at the end
// of this file: a wave session is the one path in the product that replaces the
// redo branch wholesale, so the sweep drives the REAL decision rather than a
// re-implementation of it. `client.js` exports only its pure core in node.
const { waveDiscardIsSafe } = require('../lib/editor/client.js');

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

// ---------------------------------------------------------------------------
// v3.4.0 batch3 Task 7 fix 3 — a save marks the bytes it SENT, not the depth
// its reply happened to find.
//
// Also pre-existing, also nothing to do with the wave editor. `markSaved()` ran
// on the 200 and read `_done.length` at that later moment; a save round trip is
// hundreds of milliseconds, so a Ctrl+Z inside one is ordinary. MEASURED before
// the receipt existed: the reply marked the post-undo depth as saved, and all
// three nets failed together — title dot out, `beforeunload` silent, and
// `mtimeMs` freshly advanced so the conflict check would not catch it either.
//
// The driver below carries the document and a `disk` snapshot alongside the real
// stack, exactly as the fix-2 block does, and models a save as
// `token = saveToken()` → (gestures land here) → `disk = sent; markSaved(token)`,
// which is the order `save()`'s own body executes.
// ---------------------------------------------------------------------------
{
  const mk = () => {
    const st = { stack: new UndoStack(), lines: ['# H', '', 'para'], disk: null };
    st.edit = (text) => {
      st.stack.push({ startLine: 3, endLine: 3, before: [st.lines[2]], after: [text] });
      st.lines = replaceLines(st.lines, 3, 3, [text]).lines;
    };
    st.agree = () => st.disk === st.lines.join('\n');
    return st;
  };

  // THE RACE. Send, undo inside the round trip, then let the reply land.
  {
    const st = mk();
    st.edit('para EDITED');
    const sent = st.lines.join('\n');
    const token = st.stack.saveToken();       // the request leaves here
    st.lines = st.stack.undo(st.lines).lines; // …and Ctrl+S is not debounced
    st.disk = sent;                           // the write really did happen
    const ok = st.stack.markSaved(token);     // …and the 200 lands here
    assert.strictEqual(ok, true,
      'the timeline at the receipt is unchanged — the op was only undone, and a ' +
      'redo puts it straight back — so the marker is established, not refused');
    assert.strictEqual(st.agree(), false,
      'fixture: disk holds the edit and memory does not');
    assert.strictEqual(st.stack.isDirty(), true,
      '存檔途中按 Ctrl+Z：回覆到達時不得把「撤銷之後」的深度當成存檔點 —— ' +
      '修之前這裡三道網同時失效（● 熄掉、beforeunload 不攔、mtimeMs 已經前進' +
      '所以衝突檢查也不會擋），關掉分頁就把使用者親手撤銷掉的編輯留在磁碟上');
    // …and redoing back onto the saved bytes reads clean again, which is what
    // makes the receipt an identity check rather than a blanket refusal.
    st.lines = st.stack.redo(st.lines).lines;
    assert.strictEqual(st.agree(), true, 'fixture: the redo lands back on disk');
    assert.strictEqual(st.stack.isDirty(), false,
      '重做回到存檔的那一份，就必須重新變回乾淨');
  }

  // NEIGHBOUR 1 — undo AND re-edit inside the round trip. Now the timeline at
  // the receipt really has diverged: same depth, different op.
  {
    const st = mk();
    st.edit('para A');
    const sent = st.lines.join('\n');
    const token = st.stack.saveToken();
    st.lines = st.stack.undo(st.lines).lines;
    st.edit('para B');
    assert.strictEqual(st.stack.depth, token.depth,
      'fixture: the DEPTH is identical — which is why a depth-only receipt is ' +
      'not enough and the op identity is load-bearing');
    st.disk = sent;
    const ok = st.stack.markSaved(token);
    assert.strictEqual(ok, false, 'the receipt must be refused');
    assert.strictEqual(st.stack.savedDepth, null,
      'and the marker invalidated — disk holds bytes this stack cannot reach');
    assert.strictEqual(st.agree(), false, 'fixture: memory really is B, disk is A');
    assert.strictEqual(st.stack.isDirty(), true, 'so it is dirty');
  }

  // NEIGHBOUR 2 — a redo inside the round trip, landing ABOVE the sent depth.
  {
    const st = mk();
    st.edit('para A');
    st.edit('para B');
    st.lines = st.stack.undo(st.lines).lines;   // back to A
    const sent = st.lines.join('\n');
    const token = st.stack.saveToken();
    st.lines = st.stack.redo(st.lines).lines;   // forward to B again, mid-flight
    st.disk = sent;
    assert.strictEqual(st.stack.markSaved(token), true, 'the timeline is unchanged');
    assert.strictEqual(st.agree(), false, 'fixture: disk holds A, memory holds B');
    assert.strictEqual(st.stack.isDirty(), true,
      '存檔途中按 Ctrl+Y：磁碟上是送出去的那一份，記憶體已經往前了，所以是髒的');
  }

  // NEIGHBOUR 3 — a 409. `save()` never calls markSaved() on that path, so the
  // marker is whatever the undo left it as, and nothing is claimed about disk.
  {
    const st = mk();
    st.edit('para A');
    st.disk = '# H\n\npara';                 // someone else owns the file
    st.stack.saveToken();                    // sent…
    st.lines = st.stack.undo(st.lines).lines;
    // …409: no markSaved, no mtime update.
    assert.strictEqual(st.stack.savedDepth, 0, 'the marker did not move');
    assert.strictEqual(st.agree(), true,
      'fixture: the undo happens to have put memory back on the disk bytes');
    assert.strictEqual(st.stack.isDirty(), false, 'and it reads clean, correctly');
  }

  // NEIGHBOUR 4 — two saves outstanding. Each carries its own receipt, and a
  // receipt is only ever applied for a reply that actually WROTE (a 200), so
  // the ordering of replies cannot make the document read clean over bytes disk
  // does not hold.
  //
  // fix 4 correction: this row used to end by justifying a supersede guard in
  // `save()` — "the later request's bytes are what disk ends up holding". That
  // premise is false and the guard is gone. The server 409s on any stale
  // `baseMtimeMs`, and the client's `mtimeMs` has exactly one writer (the 200
  // branch), so a second request sent while the first is in flight carries a
  // stale baseline and writes NOTHING. Its reply is a 409, which marks nothing.
  // The full interleaving is swept exhaustively at the end of this file.
  {
    const st = mk();
    st.edit('para A');
    const t1 = st.stack.saveToken();
    st.edit('para B');
    const t2 = st.stack.saveToken();
    assert.notDeepStrictEqual(t1, t2, 'fixture: two distinct receipts');
    st.disk = st.lines.join('\n');
    assert.strictEqual(st.stack.markSaved(t2), true, 'the newer receipt is accepted');
    assert.strictEqual(st.stack.isDirty(), false, 'and memory matches disk');
    // fix 5 / R3: the pin restored, with the message corrected. The EXPECTATION
    // was always right — an older receipt applied after a newer one leaves the
    // document dirty — and it was deleted in fix 4 only because its old message
    // justified the supersede guard, which was wrong. The expectation is the
    // only unit-level pin on "older receipt after newer", and that is precisely
    // the shape the coarse-mtime regime (see the sweep's own note) leaves
    // unguarded, so it is worth keeping on its own terms.
    st.stack.markSaved(t1);
    assert.strictEqual(st.stack.isDirty(), true,
      'an older receipt applied late reads DIRTY, not clean — its depth is ' +
      'behind the stack, so the document is treated as having moved since that ' +
      'save. Over-warning, which is the only direction a late reply may err in');
  }

  // The no-argument form is unchanged: "right here, right now".
  {
    const st = mk();
    st.edit('para A');
    st.stack.markSaved();
    assert.strictEqual(st.stack.savedDepth, 1);
    assert.strictEqual(st.stack.isDirty(), false);
  }
  // A receipt taken on an untouched document has no boundary op, and saving an
  // untouched document must still work.
  {
    const st = mk();
    const token = st.stack.saveToken();
    assert.deepStrictEqual(token, { depth: 0, op: null });
    assert.strictEqual(st.stack.markSaved(token), true);
    assert.strictEqual(st.stack.isDirty(), false);
  }
}

// ---------------------------------------------------------------------------
// v3.4.0 batch3 Task 7 fix 4/5 — the question the suite never asked, asked
// exhaustively: **does `isDirty()` agree with "memory equals disk"?**
//
// Four consecutive full-suite runs were green while a defect sat on the save
// path — the one path every user takes on every Ctrl+S — because every
// assertion around it watched a shape (does this line appear, is this call
// before that one) and none watched the agreement itself. A source-text guard
// cannot see a wrong premise; this can.
//
// The model is the real one, not a sketch: the real `UndoStack`, the real
// `replaceLines`, the real `waveDiscardIsSafe`, the real server rule
// (`server.js`'s /api/save answers 409 whenever `baseMtimeMs` does not match
// the file, and writes nothing), and the real client rule (`mtimeMs` has
// exactly one writer, the 200 branch).
//
// ── What it does and does not cover (fix 5 / R5) ──────────────────────────
//
// Sweep A resolves the server synchronously at `send`, so request ARRIVAL order
// is fixed at send order; what it varies exhaustively is the order the client
// is TOLD (`replyFIFO`/`replyLIFO`). Sweep B exists because that is not the same
// thing as "every interleaving": it splits `send` from `serveFIFO`/`serveLIFO`
// so the server can process a later request first. Between them, request
// arrival order, service order and reply order are all varied.
//
// ── The axiom, and where it is false (fix 5 / R2) ─────────────────────────
//
// Both sweeps assume every accepted write advances the file's `mtimeMs`, which
// is what makes a second in-flight save a guaranteed 409. **On a real
// filesystem that is not true.** MEASURED this session, 300 back-to-back
// write+rename pairs through the same path `server.js` uses:
//   ext4, the repo directory : 150 of 299 consecutive pairs shared an mtimeMs
//   ext4, /tmp               : 150 of 299
//   smallest non-zero delta  : ~0.23 ms
// In the regime the axiom excludes the shipped code DOES settle-under-warn —
// swept below and recorded rather than asserted away. Reaching it needs two
// saves inside that window: there is no autosave in this product (`save()` has
// exactly two callers, the Ctrl+S keydown and the toolbar button), and a human
// cannot press Ctrl+S twice inside a quarter of a millisecond, so no user
// reaches it today. If an autosave or a retry loop is ever added, this stops
// being theoretical and `baseMtimeMs` needs a stronger fingerprint than an
// mtime.
//
// The invariant is asserted only once a sequence has SETTLED — no request and
// no reply outstanding. While one is in flight the server may already have
// written bytes the client has not been told about, and the client cannot know;
// that window is optimistic by construction, carried as a known issue, and the
// fix-3 receipt is what makes it close correctly.
//
// ── The controls are the load-bearing half ────────────────────────────────
//
// Every assertion of 0 below is paired with the same sweep run against a
// deliberately broken client, asserted to find violations. A sweep that cannot
// fail proves nothing, and both directions are asserted (fix 5 / R6): an
// over-refusing receipt produces no under-warns at all and is caught only by
// the over-warn count.
// ---------------------------------------------------------------------------
{
  const sweep = (o) => {
    const serverAtSend = !o.serverOrdering;
    const deliver = (w, i) => {
      if (w.replies.length === 0) return;
      const r = w.replies.splice(i, 1)[0];
      if (r.status !== 200) return;
      if (o.supersede && r.seq !== w.saveSeq) return;   // the deleted guard
      w.mtimeMs = r.mtimeMs;
      if (o.naiveMark) w.stack.markSaved(); else w.stack.markSaved(r.token);
    };
    const serve = (w, q) => {
      if (q.baseMtimeMs !== w.server.mtime) { w.replies.push({ status: 409, seq: q.seq }); return; }
      w.server.content = q.content;
      if (!o.coarseMtime) w.server.mtime += 1;
      w.replies.push({ status: 200, seq: q.seq, token: q.token, mtimeMs: w.server.mtime });
    };
    const push = (w, text) => {
      w.stack.push({ startLine: 3, endLine: 3, before: [w.lines[2]], after: [text] });
      w.lines = replaceLines(w.lines, 3, 3, [text]).lines;
    };
    const G = {
      edit(w) { w.n++; push(w, 'p' + w.n); },
      undo(w) { const r = w.stack.undo(w.lines); if (r) w.lines = r.lines; },
      redo(w) { const r = w.stack.redo(w.lines); if (r) w.lines = r.lines; },
      send(w) {
        const q = { token: w.stack.saveToken(), seq: ++w.saveSeq,
                    content: w.lines.join('\n'), baseMtimeMs: w.mtimeMs };
        if (serverAtSend) serve(w, q); else w.requests.push(q);
      },
      replyFIFO(w) { deliver(w, 0); },
      replyLIFO(w) { deliver(w, w.replies.length - 1); },
    };
    if (o.serverOrdering) {
      G.serveFIFO = (w) => { if (w.requests.length) serve(w, w.requests.shift()); };
      G.serveLIFO = (w) => { if (w.requests.length) serve(w, w.requests.pop()); };
    }
    if (o.wave) {
      // fix 5 / R7: a wave session is the one path in the product that replaces
      // `_undone` wholesale, so it belongs in the alphabet. Modelled on
      // finishWaveSession()'s escape path verbatim — real `waveDiscardIsSafe`,
      // real `discardTop` loop, real `setRedoTail`, real revert commit — as one
      // atomic gesture, because the overlay owns the keyboard for its whole
      // life and no other gesture can interleave with it.
      G.waveEsc = (w) => {
        const seam = { baseDepth: w.stack.depth, ops: 0 };
        const baseLines = w.lines, baseTail = w.stack.redoTail();
        w.n++; push(w, 'w' + w.n); seam.ops++;
        w.n++; push(w, 'w' + w.n); seam.ops++;
        if (waveDiscardIsSafe(w.stack, seam)) {
          for (let i = 0; i < seam.ops; i++) w.stack.discardTop(w.lines);
          w.lines = baseLines;
        } else { push(w, baseLines[2]); }
        w.stack.setRedoTail(baseTail);
      };
    }
    const names = Object.keys(G);
    const out = { alphabet: names.length, sequences: 0, steps: 0, settledUnder: 0,
                  settledOver: 0, windowUnder: 0,
                  under: null, underLen: Infinity, over: null, overLen: Infinity };
    const run = (path) => {
      const w = { stack: new UndoStack(), lines: ['# H', '', 'p0'], mtimeMs: 1000,
                  server: { content: '# H\n\np0', mtime: 1000 },
                  requests: [], replies: [], n: 0, saveSeq: 0 };
      for (let k = 0; k < path.length; k++) {
        G[path[k]](w);
        out.steps++;
        if (w.requests.length !== 0 || w.replies.length !== 0) {
          if (!w.stack.isDirty() && w.lines.join('\n') !== w.server.content) out.windowUnder++;
          continue;
        }
        const agree = w.lines.join('\n') === w.server.content;
        const dirty = w.stack.isDirty();
        if (!dirty && !agree) {
          out.settledUnder++;
          // fix 5 / R4: the SHORTEST, kept by length — a DFS-first example is
          // whatever the walk order happens to reach and calling it shortest
          // was simply false.
          if (k + 1 < out.underLen) { out.underLen = k + 1; out.under = path.slice(0, k + 1).join(' > '); }
        } else if (dirty && agree) {
          out.settledOver++;
          if (k + 1 < out.overLen) { out.overLen = k + 1; out.over = path.slice(0, k + 1).join(' > '); }
        }
      }
    };
    const walk = (path) => {
      if (path.length > 0) { run(path); out.sequences++; }
      if (path.length === o.depth) return;
      for (const n of names) walk(path.concat([n]));
    };
    walk([]);
    return out;
  };

  // ── Sweep A: reply ordering, depth 7 over 6 gestures ────────────────────
  // 335,922 sequences / 2,284,278 assertion steps, MEASURED at ~0.3 s.
  const A = sweep({ depth: 7 });
  assert.strictEqual(A.sequences, 335922, 'fixture: sweep A must be exhaustive');
  assert.strictEqual(A.steps, 2284278, 'fixture: and every step checked');
  assert.strictEqual(A.settledUnder, 0,
    'isDirty() must never answer false over a document that differs from disk, ' +
    'in ANY settled interleaving of edits, undo, redo and concurrent save ' +
    'replies. Got ' + A.settledUnder + ', shortest: ' + A.under);
  assert.strictEqual(A.settledOver, 0,
    'and it must not answer true over a document that MATCHES disk either — ' +
    'this direction is what catches a receipt that over-refuses (measured: a ' +
    'timelineOpAt() that stops spanning _undone gives 0 under-warns and 654 ' +
    'over-warns here). Got ' + A.settledOver + ', shortest: ' + A.over);

  // Control 1 — the supersede guard `save()` briefly carried.
  const Asup = sweep({ depth: 7, supersede: true });
  assert.strictEqual(Asup.settledUnder, 344,
    'the sweep must SEE the supersede guard. Got ' + Asup.settledUnder);
  assert.strictEqual(Asup.under, 'edit > send > undo > send > replyFIFO > replyFIFO',
    'and its shortest shape is the measured one — a save, an undo, a second ' +
    'save that 409s, and the FIRST reply then discarded as "superseded". Got ' +
    Asup.under);

  // Control 2 — the round-3 defect: mark the moment, not the receipt.
  const Anaive = sweep({ depth: 7, naiveMark: true });
  assert.strictEqual(Anaive.settledUnder, 46520,
    'and it must SEE a markSaved() that ignores its receipt. Got ' + Anaive.settledUnder);
  assert.strictEqual(Anaive.under, 'send > edit > replyFIFO',
    'shortest: a save, an edit inside the round trip, then the reply. Got ' + Anaive.under);

  // ── Sweep B: the SERVER may process a later request first ───────────────
  // Depth 6 over 8 gestures: 299,592 sequences / 1,754,760 steps, ~0.22 s.
  const B = sweep({ depth: 6, serverOrdering: true });
  assert.strictEqual(B.sequences, 299592, 'fixture: sweep B must be exhaustive');
  assert.strictEqual(B.settledUnder, 0,
    'reordering at the SERVER must not produce a false clean either. Got ' +
    B.settledUnder + ', shortest: ' + B.under);
  assert.strictEqual(B.settledOver, 0,
    'nor a false dirty. Got ' + B.settledOver + ', shortest: ' + B.over);
  const Bnaive = sweep({ depth: 6, serverOrdering: true, naiveMark: true });
  assert.strictEqual(Bnaive.settledUnder, 5456,
    'and sweep B must be able to fail too. Got ' + Bnaive.settledUnder);

  // ── Sweep A + a wave session (fix 5 / R7) ───────────────────────────────
  // Depth 7 over 7 gestures: 960,799 sequences / 6,565,468 steps, ~1.3 s.
  const W = sweep({ depth: 7, wave: true });
  assert.strictEqual(W.sequences, 960799, 'fixture: the wave sweep must be exhaustive');
  assert.strictEqual(W.settledUnder, 0,
    'a wave session that is escaped must not make the document read clean over ' +
    'bytes disk does not hold. Got ' + W.settledUnder + ', shortest: ' + W.under);
  // …and this one DOES over-warn, deliberately and documented: an escaped
  // session gives back bytes, depth and the redo branch but cannot give back a
  // save marker that `push()` invalidated. Pinned as the measured count, not
  // asserted to 0, because asserting 0 here would be asserting a lie.
  assert.strictEqual(W.settledOver, 136,
    'the accepted over-warn from an escaped wave session — see unwindWaveOps()’s ' +
    'own docblock. Got ' + W.settledOver);
  assert.strictEqual(W.over, 'edit > send > undo > replyFIFO > waveEsc > redo',
    'and its shortest shape is the documented one: the marker is invalidated ' +
    'inside the session and the redo then lands back on the saved bytes. Got ' + W.over);

  // ── The regime the axiom excludes (fix 5 / R2) ──────────────────────────
  // Same sweep, with writes that do NOT advance the file mtime — which is what
  // this filesystem does for roughly half of all back-to-back saves. RECORDED,
  // not asserted to 0: the shipped code really does under-warn here, and
  // pretending otherwise is what an axiom stated as fact would do.
  const coarse = sweep({ depth: 6, coarseMtime: true });
  assert.strictEqual(coarse.settledUnder, 6,
    'measurement, not a guarantee: with a filesystem whose mtime does not move ' +
    'between two back-to-back writes, a second in-flight save is no longer a ' +
    'guaranteed 409 and the shipped code under-warns. Unreachable today (no ' +
    'autosave; a human cannot press Ctrl+S twice inside ~0.23 ms). Got ' +
    coarse.settledUnder + ', shortest: ' + coarse.under);
  assert.strictEqual(coarse.under, 'send > edit > send > undo > replyLIFO > replyFIFO',
    'and it needs two sends with nothing between them but the edit. Got ' + coarse.under);
}

console.log('lineops.test.js OK');
