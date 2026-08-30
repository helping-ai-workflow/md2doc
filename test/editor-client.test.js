'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { extractBlockSource, commitEdit, commitListBlockRemoval, commitBlockInsertion, withHeadingDepth, commitRangeEdit, commitRangeRemoval, rollbackFailedRender } = require('../lib/editor/client.js');
const { UndoStack } = require('../lib/editor/lineops.js');
const { marked } = require('marked');

// -- pure state transition --------------------------------------------------
const lines = ['# T', '', 'para', '', '| A |', '|---|', '| 1 |'];
const blocks = [
  { id: 0, type: 'heading',   startLine: 1, endLine: 1 },
  { id: 1, type: 'paragraph', startLine: 3, endLine: 3 },
  { id: 2, type: 'table',     startLine: 5, endLine: 7 },
];

assert.strictEqual(extractBlockSource(lines, blocks[2]), '| A |\n|---|\n| 1 |');

const stack = new UndoStack();
const st1 = commitEdit({ lines, blocks, stack }, 1, 'para v2\n\nextra para');
assert.deepStrictEqual(st1.lines,
  ['# T', '', 'para v2', '', 'extra para', '', '| A |', '|---|', '| 1 |']);
// table block shifted by +2
assert.strictEqual(st1.blocks.find((b) => b.id === 2).startLine, 7);
// untouched lines byte-identical
assert.strictEqual(st1.lines[0], '# T');
assert.strictEqual(st1.lines.slice(-3).join('\n'), '| A |\n|---|\n| 1 |');
// undo restores exactly
const u = stack.undo(st1.lines);
assert.deepStrictEqual(u.lines, lines);

// no-change commit is a no-op (no undo entry)
const st2 = commitEdit({ lines, blocks, stack: new UndoStack() }, 1, 'para');
assert.strictEqual(st2.op, null, 'identical text → no op pushed');

// -- Task 4 fix (review, Important): commitListBlockRemoval() line math -----
// Reviewer's exact probe shape: heading, blank, a ONE-item list, blank,
// trailer — removing the list must absorb exactly ONE of its two blank
// separators, not leave a doubled (or zero) blank line.
{
  const rLines = ['# Doc', '', '- Only item', '', 'Trailer'];
  const rBlocks = [
    { id: 0, type: 'heading',   startLine: 1, endLine: 1 },
    { id: 1, type: 'list',      startLine: 3, endLine: 3 },
    { id: 2, type: 'paragraph', startLine: 5, endLine: 5 },
  ];
  const rStack = new UndoStack();
  const r1 = commitListBlockRemoval({ lines: rLines, blocks: rBlocks, stack: rStack }, 1);
  assert.deepStrictEqual(r1.lines, ['# Doc', '', 'Trailer'],
    'removing the only item of a one-item list must delete the block AND absorb ' +
    'exactly one blank separator, not leave a stray blank line');
  assert.strictEqual(r1.lines.join('\n'), '# Doc\n\nTrailer',
    'exact byte contract: "# Doc\\n\\n- Only\\n\\nTrailer" -> "# Doc\\n\\nTrailer"');
  // trailing block (id 2) shifts up by 2 lines (one for the removed list
  // line itself, one for the absorbed trailing blank).
  assert.strictEqual(r1.blocks.find((b) => b.id === 2).startLine, 3);
  // undo restores the ORIGINAL file exactly, including both blank lines.
  const rUndo = rStack.undo(r1.lines);
  assert.deepStrictEqual(rUndo.lines, rLines, 'undo must restore the exact original bytes');

  // No blank neighbor on EITHER side (list is the entire file) -> nothing
  // to absorb, just the block's own line(s) removed.
  const soloLines = ['- Only item'];
  const soloBlocks = [{ id: 0, type: 'list', startLine: 1, endLine: 1 }];
  const soloStack = new UndoStack();
  const r2 = commitListBlockRemoval({ lines: soloLines, blocks: soloBlocks, stack: soloStack }, 0);
  assert.deepStrictEqual(r2.lines, [], 'a list with no blank neighbors on either side leaves an empty file');
  assert.deepStrictEqual(soloStack.undo(r2.lines).lines, soloLines, 'undo restores the solo-list file exactly');

  // No TRAILING blank (list is the LAST block, EOF right after) -> falls
  // back to absorbing the LEADING blank instead.
  const eofLines = ['# Doc', '', '- Only item'];
  const eofBlocks = [
    { id: 0, type: 'heading', startLine: 1, endLine: 1 },
    { id: 1, type: 'list',    startLine: 3, endLine: 3 },
  ];
  const eofStack = new UndoStack();
  const r3 = commitListBlockRemoval({ lines: eofLines, blocks: eofBlocks, stack: eofStack }, 1);
  assert.deepStrictEqual(r3.lines, ['# Doc'],
    'no trailing blank to absorb (EOF) must fall back to absorbing the leading blank');
  assert.deepStrictEqual(eofStack.undo(r3.lines).lines, eofLines, 'undo restores the EOF-list file exactly');
}

// -- §10-gap fix: commitBlockInsertion() line math ---------------------------
// Mirrors commitListBlockRemoval()'s own three-case coverage above, in
// reverse: mid-doc (reuse the existing trailing blank as the separator to
// whatever follows), EOF (no trailing content to separate from — no trailing
// blank added), and a non-blank neighbor (no blank line to reuse — a fresh
// trailing separator is added so the new block doesn't merge into the next
// one when re-lexed).
{
  // mid-doc: hovered block already has a blank line after it (the normal
  // case) — that existing blank is REUSED as NEWBLOCK's own trailing
  // separator, not doubled up.
  const mLines = ['# Doc', '', 'Para1', '', 'Para2'];
  const mBlocks = [
    { id: 0, type: 'heading',   startLine: 1, endLine: 1 },
    { id: 1, type: 'paragraph', startLine: 3, endLine: 3 },
    { id: 2, type: 'paragraph', startLine: 5, endLine: 5 },
  ];
  const mStack = new UndoStack();
  const m1 = commitBlockInsertion({ lines: mLines, blocks: mBlocks, stack: mStack }, 1, ['NEWBLOCK']);
  assert.deepStrictEqual(m1.lines, ['# Doc', '', 'Para1', '', 'NEWBLOCK', '', 'Para2']);
  assert.strictEqual(m1.lines.join('\n'), '# Doc\n\nPara1\n\nNEWBLOCK\n\nPara2',
    'exact byte contract: one fresh leading blank, existing trailing blank reused');
  assert.strictEqual(m1.newStartLine, 5, 'new block content starts at line 5 (1-indexed)');
  // trailing block (id 2) shifts down by 2 lines (blank + NEWBLOCK).
  assert.strictEqual(m1.blocks.find((b) => b.id === 2).startLine, 7);
  assert.deepStrictEqual(mStack.undo(m1.lines).lines, mLines, 'undo restores the exact original bytes');

  // EOF: hovered block is the LAST block in the file — no trailing blank is
  // added (nothing follows to separate from).
  const eLines = ['# Doc', '', 'Para1'];
  const eBlocks = [
    { id: 0, type: 'heading',   startLine: 1, endLine: 1 },
    { id: 1, type: 'paragraph', startLine: 3, endLine: 3 },
  ];
  const eStack = new UndoStack();
  const m2 = commitBlockInsertion({ lines: eLines, blocks: eBlocks, stack: eStack }, 1, ['NEWBLOCK']);
  assert.deepStrictEqual(m2.lines, ['# Doc', '', 'Para1', '', 'NEWBLOCK']);
  assert.strictEqual(m2.lines.join('\n'), '# Doc\n\nPara1\n\nNEWBLOCK',
    'EOF: no trailing blank line appended after the new block');
  assert.strictEqual(m2.newStartLine, 5);
  assert.deepStrictEqual(eStack.undo(m2.lines).lines, eLines, 'undo restores the exact original (EOF) bytes');

  // non-blank neighbor: the hovered block is immediately followed by
  // another block's content with NO blank line between them (malformed/
  // edge-case input) — a fresh trailing blank is added so NEWBLOCK doesn't
  // merge into what follows when the document is re-lexed.
  const nLines = ['Para1', 'Para2'];
  const nBlocks = [
    { id: 0, type: 'paragraph', startLine: 1, endLine: 1 },
    { id: 1, type: 'paragraph', startLine: 2, endLine: 2 },
  ];
  const nStack = new UndoStack();
  const m3 = commitBlockInsertion({ lines: nLines, blocks: nBlocks, stack: nStack }, 0, ['NEWBLOCK']);
  assert.deepStrictEqual(m3.lines, ['Para1', '', 'NEWBLOCK', '', 'Para2']);
  assert.strictEqual(m3.lines.join('\n'), 'Para1\n\nNEWBLOCK\n\nPara2',
    'no pre-existing blank to reuse: a fresh trailing blank is added too');
  assert.strictEqual(m3.newStartLine, 3);
  assert.deepStrictEqual(nStack.undo(m3.lines).lines, nLines, 'undo restores the exact original bytes');

  // Multi-line new block (e.g. the table skeleton) round-trips too.
  const tLines = ['Para1', '', 'Para2'];
  const tBlocks = [
    { id: 0, type: 'paragraph', startLine: 1, endLine: 1 },
    { id: 1, type: 'paragraph', startLine: 3, endLine: 3 },
  ];
  const tStack = new UndoStack();
  const m4 = commitBlockInsertion({ lines: tLines, blocks: tBlocks, stack: tStack }, 0,
    ['| A | B |', '|---|---|', '|  |  |']);
  assert.strictEqual(m4.lines.join('\n'), 'Para1\n\n| A | B |\n|---|---|\n|  |  |\n\nPara2');
  assert.strictEqual(m4.newStartLine, 3);
  assert.deepStrictEqual(tStack.undo(m4.lines).lines, tLines, 'undo restores exactly, multi-line insert included');
}

// -- Finding 5: empty heading emits no trailing space ------------------------
// withHeadingDepth(): normal (non-empty) heading text still keeps its single
// space separator, unchanged.
assert.strictEqual(withHeadingDepth('## hello', 3), '### hello');
// An emptied-out heading (all text deleted) must NOT carry a trailing space
// with nothing after it (spec §4 no-trailing-whitespace).
assert.strictEqual(withHeadingDepth('## hello', 2), '## hello');
assert.strictEqual(withHeadingDepth('##', 3), '###');
assert.strictEqual(withHeadingDepth('## ', 4), '####');
for (const line of ['###', '####']) {
  assert.strictEqual(line, line.replace(/\s+$/, ''), `withHeadingDepth output must have no trailing whitespace: ${JSON.stringify(line)}`);
}
// marked must still lex the no-space empty heading as a genuine heading
// token (not silently degrade to a paragraph) — the fix's core assumption.
{
  const tokens = marked.lexer('###');
  assert.strictEqual(tokens[0].type, 'heading');
  assert.strictEqual(tokens[0].depth, 3);
  assert.strictEqual(tokens[0].text, '');
}

// -- page wiring presence ---------------------------------------------------
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'client.js'), 'utf8');
for (const needle of ['__ED__', 'Ctrl', 'beforeunload', '/api/save',
                      '/api/render', '/api/ping', '409',
                      '__md2docInitDiagrams', 'ed-raw',
                      'ed-wys-cell', 'ed-tb-insert', 'wireBlockSelection']) {
  assert.ok(src.includes(needle), `client.js must reference ${needle}`);
}
// The old hover-gutter DOM wiring must be gone (replaced by the click-bar,
// itself later retired in favor of always-on arming — see Task 5).
assert.ok(!/ed-gutter/.test(src), 'client.js must not reference the removed .ed-gutter');
assert.ok(!/attachGutters/.test(src), 'client.js must not reference the removed attachGutters()');
// Task 5: the click-select edit bar (its last consumer, tables, is retired
// in this task — T2 already retired it for paragraph/heading) must be
// fully gone, not just unused.
for (const needle of ['ed-bar', 'ed-selected', 'openTableEditor', 'runTableStructureOp',
                      'selectedBlockEl', 'dismissBar', 'showBarFor', 'updateBarButtons']) {
  assert.ok(!src.includes(needle), `client.js must NOT reference the retired ${needle}`);
}

// -- Task 5 review fix: suppressTableFocusout must be exception-safe -------
// The flag is checked at the TOP of the document-level `focusout` listener
// (before any block-type branch), so a bare `suppressTableFocusout = true;
// tableEl.innerHTML = state; suppressTableFocusout = false;` that throws
// mid-assignment would latch the flag true FOREVER — silently disabling
// blur-commits for EVERY block type (not just tables) until reload, not
// just breaking the table burst it was guarding. Every set-to-true site
// must wrap the guarded statement in try/finally so the flag is cleared
// even on a throw. Structural (regex) check, same idiom as
// shortcutOrderChecks below: locate every `= true;` site, then confirm
// each one is immediately followed by a try/finally block that clears it
// back to false in the finally — counts must match exactly (a mismatch
// means some site got the assignment but not the try/finally).
{
  const setTrueSites = src.match(/suppressTableFocusout = true;/g) || [];
  assert.strictEqual(setTrueSites.length, 4,
    'expected exactly 4 suppressTableFocusout = true sites: tableBurstUndo and tableBurstRedo ' +
    '(each guarding `tableEl.innerHTML = state`), performRowDrop\'s rebuildTableSections() ' +
    'call (Task 6 — a row drop is a pure move, so the thead/tbody rebuild detaches the cell that ' +
    'currently holds focus and Chromium fires a synchronous focusout mid-mutation, exactly the ' +
    'quirk the other two guard), plus performColDrop\'s per-row cell-reorder loop (Task 8 — a ' +
    'column drop appends every row\'s moved cell back via appendChild(), which detaches the ' +
    'currently-focused cell the same way) — if a new site is ever added, update this count ' +
    'deliberately and audit it for the same guard');
  const guardedSites = src.match(
    /suppressTableFocusout = true;\s*try\s*\{[\s\S]*?\}\s*finally\s*\{\s*suppressTableFocusout = false;\s*\}/g
  ) || [];
  assert.strictEqual(guardedSites.length, setTrueSites.length,
    'every `suppressTableFocusout = true` must be immediately wrapped in a try/finally that clears it back to ' +
    'false in the finally block — an unguarded assignment latches the flag true forever if the guarded ' +
    'statement throws, silently disabling blur-commits for every block type until reload');
}

// -- Ctrl+S / Ctrl+Z / Ctrl+Y / Ctrl+Enter: preventDefault() must fire
// BEFORE any async work (save()/undo()/redo()/commit() all kick off a
// fetch()), or the browser's native shortcut (e.g. the save-page dialog on
// Ctrl+S) fires alongside ours. Each regex below pins preventDefault()
// as the FIRST statement in its branch, immediately followed by the call —
// so a future edit that reorders them, or inserts awaited work first,
// breaks this assertion instead of silently regressing.
const shortcutOrderChecks = [
  // Final-review Finding 1: Ctrl+S no longer calls save() directly — it
  // resolves whatever burst/editor is open FIRST (switchAwayFrom()) so
  // `lines` reflects a mid-burst keystroke before save() reads it (a
  // block-comment explaining why sits between preventDefault() and the
  // call now, hence the `[\s\S]*?` — the invariant this check pins is
  // still "preventDefault() is the very FIRST statement in the branch,
  // nothing awaited ahead of it", not "save() is the very next token").
  [/key === 's'\)\s*\{\s*e\.preventDefault\(\);[\s\S]*?switchAwayFrom\(\)\.then\(\(ok\) => \{ if \(ok\) save\(\); \}\);/,
    'Ctrl+S must preventDefault() before resolving the open burst and saving'],
  [/key === 'z'\)\s*\{\s*e\.preventDefault\(\);\s*undo\(\);/, 'Ctrl+Z must preventDefault() before undo()'],
  [/\(e\.key === 'y' \|\| \(e\.shiftKey && e\.key === 'Z'\)\)\)\s*\{\s*e\.preventDefault\(\);\s*redo\(\);/,
    'Ctrl+Y / Ctrl+Shift+Z must preventDefault() before redo()'],
  [/e\.key === 'Enter' && \(e\.ctrlKey \|\| e\.metaKey\)\)\s*\{\s*e\.preventDefault\(\);\s*commit\(\);/,
    'Ctrl+Enter (raw-editor commit) must preventDefault() before commit()'],
  // §10-gap fix (review): Esc inside the raw editor now goes through
  // cancelAndMaybeDiscard() (restore() + the pristine-insert auto-remove
  // check) instead of calling restore() directly — deliberate, not a
  // regression (see cancelAndMaybeDiscard()'s own comment).
  [/e\.key === 'Escape'\)\s*\{\s*e\.preventDefault\(\);\s*cancelAndMaybeDiscard\(\);/,
    'Esc inside the raw editor must preventDefault() before cancelAndMaybeDiscard()'],
  [/e\.key === 'Escape'\)\s*\{\s*e\.preventDefault\(\);\s*closeGutterMenu\(\);/,
    'Esc (global, ⠿ menu dismiss) must preventDefault() before closeGutterMenu()'],
];
for (const [re, msg] of shortcutOrderChecks) {
  assert.ok(re.test(src), msg);
}

// -- structural guard: these sources get inlined into a `<script>...</script>`
// tag by lib/editor/server.js (see LINEOPS_SRC / INLINE_MD_SRC / TABLE_MD_SRC
// and clientJs in the GET /edit/:id handler). A literal `</script` substring
// anywhere in ANY of these sources — even inside a string literal or comment
// — would prematurely close that tag in the served HTML and break the page.
// Final-review Finding 2: server.js now ALSO inlines inline-md.js and
// table-md.js (Phase-2 Tasks 2/5) — the guard below only covered
// client.js + lineops.js and missed those two.
const lineopsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'lineops.js'), 'utf8');
const inlineMdSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'inline-md.js'), 'utf8');
const tableMdSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'table-md.js'), 'utf8');
// Phase 3 Task 4: list-md.js is now ALSO inlined by server.js (injected
// after table-md, before history — see test/editor-server.test.js) — same
// literal-</script> exposure as the other sources, so it gets the same
// guard (this was missing from Task 4's own commit — added here as part of
// the review fix pass, same class of gap as table-md/history already had).
const listMdSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'list-md.js'), 'utf8');
// Phase 3 Task 1/2: history.js is now ALSO inlined by server.js (injected
// after table-md, before client — see test/editor-server.test.js) — same
// literal-</script> exposure as the other three, so it gets the same guard.
const historySrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'history.js'), 'utf8');
assert.ok(!/<\/script/i.test(src), 'client.js must not contain a literal </script sequence');
assert.ok(!/<\/script/i.test(lineopsSrc), 'lineops.js must not contain a literal </script sequence');
assert.ok(!/<\/script/i.test(inlineMdSrc), 'inline-md.js must not contain a literal </script sequence');
assert.ok(!/<\/script/i.test(tableMdSrc), 'table-md.js must not contain a literal </script sequence');
assert.ok(!/<\/script/i.test(listMdSrc), 'list-md.js must not contain a literal </script sequence');
assert.ok(!/<\/script/i.test(historySrc), 'history.js must not contain a literal </script sequence');

// -- commitRangeEdit: explicit range, same op shape -------------------------
// Asserted values (startLine/endLine/before/after and the null no-op) are
// law from the task brief; helper spelling is ours (no mkState helper exists).
{
  const cLines = ['- a', '- b', '- c'];
  const cBlocks = [
    { id: 0, type: 'li', startLine: 1, endLine: 1 },
    { id: 1, type: 'li', startLine: 2, endLine: 2 },
    { id: 2, type: 'li', startLine: 3, endLine: 3 },
  ];
  const cStack = new UndoStack();
  const r = commitRangeEdit({ lines: cLines, blocks: cBlocks, stack: cStack }, 1, 3, '- a\n- B\n- c');
  assert.deepStrictEqual(r.op, {
    startLine: 1, endLine: 3,
    before: ['- a', '- b', '- c'],
    after: ['- a', '- B', '- c'],
  });
  // no-op: committing identical text to an already-updated state returns
  // op===null AND must not push onto the SAME stack that the real edit above
  // used. (A fresh UndoStack here would make the "does not push" claim
  // untestable — the depth would trivially be 0 either way.) UndoStack exposes
  // no `undoOps` array; the real op count lives in `_done` (raw) / `dirtyDepth`.
  const depthBefore = cStack._done.length;
  assert.strictEqual(depthBefore, 1, 'sanity: the real range edit pushed exactly one op');
  const noOp = commitRangeEdit({ lines: r.lines, blocks: r.blocks, stack: cStack }, 1, 3, r.lines.slice(0, 3).join('\n'));
  assert.strictEqual(noOp.op, null, 'committing unchanged text must return op===null');
  assert.strictEqual(cStack._done.length, depthBefore,
    'a no-op commit must NOT push onto the undo stack (depth unchanged)');
}

// -- T7 fix round 1 (LOW-2): insertBlockBelow() must refuse a zero-line block --
// The SOURCE-GREP version of this check lived here and has been REPLACED by a
// runtime scenario in test/editor-client-runtime.test.js ("T8: Enter on an
// emptied item after a same-line nest ..."). It was written on the premise
// that no gesture could reach the branch, so only the guard's spelling could
// be asserted. The premise was wrong: row 3's top-level Enter reaches it
// through convertEmptyTopLevelLiToParagraph() ->
// blockElAtLine(precedingBlock.startLine), which returns the FIRST block
// starting at that line — the zero-line outer item of a same-line nest. A
// grep test cannot tell a guard that works from one that is merely present;
// the runtime one measures the ghost paragraph the unguarded path inserts.
//
// commitBlockInsertion() now refuses an inverted anchor range itself as well
// (see the T8 item 1 block above), so this is guarded twice on purpose: the
// call site because it can show the user a banner, the helper because the next
// call site will not remember to.

// -- T8 item 1: the range helpers refuse an INVERTED range themselves -------
// ROOT CAUSE, five call sites deep. A block that owns no source line has
// endLine === startLine - 1 (blockOwnsNoLine()), and both range helpers were
// written assuming endLine >= startLine. Handed an inverted range they do not
// fail — they do something plausible and WRONG:
//   - commitRangeEdit(): `lines.slice(startLine-1, endLine)` is [], so the
//     "unchanged?" test compares '' against the new text, and
//     ops.replaceLines() splices at startLine-1 without removing anything —
//     an INSERT where the caller asked for a replace.
//   - commitRangeRemoval(): the blank-line absorption reads `lines[el]`,
//     which for an inverted range is the range's OWN first line, and
//     `lines[sl-2]`, which is a line belonging to whatever precedes — so it
//     deletes a separator nobody asked it to touch.
// Both were fixed five times at five call sites (T3 arming, T3 same-line
// child commit, T4 gutter delete, T4 raw edit, T7 insertBlockBelow). The
// helpers now refuse, and the call-site guards stay as the first line of
// defence. Refusal shape = the existing "nothing changed" shape (`op: null`,
// state handed straight back), because every call site already has a correct
// abort path for it; a throw would have to be caught in five async handlers
// that today have none.
{
  // The refusal is meant to be FINDABLE in a real session, so it logs. Capture
  // the log here rather than letting it scroll past: it keeps the suite's
  // output clean AND turns "it logged" into an assertion instead of a hope.
  const logged = [];
  const realError = console.error;
  console.error = (...a) => { logged.push(a.join(' ')); };
  const invLines = ['# Doc', '', '- a', '', '- - b', ''];
  const invBlocks = [
    { id: 0, type: 'heading', startLine: 1, endLine: 1 },
    { id: 1, type: 'li', startLine: 3, endLine: 3 },
    // the same-line nest: the OUTER item owns no line of its own
    { id: 2, type: 'li', startLine: 5, endLine: 4 },
    { id: 3, type: 'li', startLine: 5, endLine: 5 },
  ];
  // --- commitRangeEdit ---
  {
    const st = new UndoStack();
    const state = { lines: invLines.slice(), blocks: invBlocks.slice(), stack: st };
    const before = state.lines.slice();
    const r = commitRangeEdit(state, 5, 4, 'ZZZ');
    assert.strictEqual(r.op, null,
      'an inverted range must be refused with the same op===null shape a no-op commit uses');
    assert.strictEqual(r.refused, 'inverted-range',
      'the refusal must be identifiable, not indistinguishable from "text unchanged"');
    // T8 review LOW-2: `refused` has NO production consumer today, and that is
    // deliberate. Every call site's correct reaction to a refusal is the same
    // as its reaction to "nothing changed" — abort, or (via
    // rollbackFailedRender) decline to roll back — so branching on the tag
    // would add a path with no distinct behaviour behind it. The tag exists so
    // a TEST can tell the two apart, and so console.error has something to
    // name. If a caller ever does need to react differently, this is the hook;
    // until then, do not add a branch just to consume it.
    assert.deepStrictEqual(r.lines, before,
      'MEASURED pre-guard symptom: commitRangeEdit(5, 4, "ZZZ") INSERTED a line — ' +
      "'# Doc\\n\\n- a\\n\\n- - b\\n' + 'ZZZ' -> '# Doc\\n\\n- a\\n\\nZZZ\\n- - b\\n'");
    assert.strictEqual(r.lines, state.lines, 'the caller\'s own array is handed back untouched');
    assert.strictEqual(r.blocks, state.blocks, 'and so is the block array');
    assert.strictEqual(st._done.length, 0, 'a refused range must never push an undo op');
  }
  // --- commitRangeRemoval ---
  {
    const st = new UndoStack();
    const state = { lines: invLines.slice(), blocks: invBlocks.slice(), stack: st };
    const before = state.lines.slice();
    const r = commitRangeRemoval(state, 5, 4);
    assert.strictEqual(r.op, null, 'inverted range: refused, no op');
    assert.strictEqual(r.refused, 'inverted-range', 'and identifiably so');
    assert.deepStrictEqual(r.lines, before,
      'MEASURED pre-guard symptom: commitRangeRemoval(5, 4) absorbed the blank line at ' +
      "index sl-2 — '# Doc\\n\\n- a\\n\\n- - b\\n' -> '# Doc\\n\\n- a\\n- - b\\n', a separator " +
      'belonging to a DIFFERENT block, with nothing visible on screen to show for it');
    assert.strictEqual(st._done.length, 0, 'a refused range must never push an undo op');
  }
  // --- the wrappers inherit the refusal (they are the real call sites) ---
  {
    const st = new UndoStack();
    const state = { lines: invLines.slice(), blocks: invBlocks.slice(), stack: st };
    const before = state.lines.slice();
    const e = commitEdit(state, 2, 'ZZZ');           // block id 2 owns no line
    assert.strictEqual(e.refused, 'inverted-range', 'commitEdit() inherits the refusal');
    assert.deepStrictEqual(e.lines, before, 'and changes nothing');
    const d = commitListBlockRemoval(state, 2);
    assert.strictEqual(d.refused, 'inverted-range', 'commitListBlockRemoval() inherits it too');
    assert.deepStrictEqual(d.lines, before, 'and changes nothing');
    assert.strictEqual(st._done.length, 0, 'neither wrapper pushed an undo op');
  }
  // --- commitBlockInsertion(): SAME root cause, third helper. It inserts at
  //     `block.endLine + 1` and samples `state.lines[block.endLine]` to decide
  //     the trailing blank — for an inverted range both address a line inside
  //     whatever PRECEDES the block, so the new block lands ABOVE the one it
  //     was anchored to. insertBlockBelow() guards this at its call site
  //     (test below), and now the helper refuses it as well. Enumerated by the
  //     same cross-axis pass that produced the two above: it is the only other
  //     helper in this file that reads a block's line range as an interval.
  {
    const st = new UndoStack();
    const state = { lines: invLines.slice(), blocks: invBlocks.slice(), stack: st };
    const before = state.lines.slice();
    const r = commitBlockInsertion(state, 2, ['NEW']);
    assert.strictEqual(r.op, null, 'inverted anchor: refused, no op');
    assert.strictEqual(r.refused, 'inverted-range', 'and identifiably so');
    assert.deepStrictEqual(r.lines, before,
      'MEASURED pre-guard symptom: anchoring an insert to a block that owns no source ' +
      'line put the new block ABOVE it — the paragraph appeared before the list');
    assert.strictEqual(st._done.length, 0, 'a refused insertion must never push an undo op');
    // A well-formed anchor still inserts, so the guard is not a blanket veto.
    const ok = commitBlockInsertion(state, 1, ['NEW']);
    assert.strictEqual(ok.refused, undefined, 'a block that owns its line is a valid anchor');
    assert.deepStrictEqual(ok.lines, ['# Doc', '', '- a', '', 'NEW', '', '- - b', '']);
  }
  // --- a WELL-FORMED range is completely unaffected (the guard must not
  //     also refuse endLine === startLine, the single-line case that is 90%
  //     of every commit in this file) ---
  {
    const st = new UndoStack();
    const state = { lines: invLines.slice(), blocks: invBlocks.slice(), stack: st };
    const r = commitRangeEdit(state, 3, 3, '- A');
    assert.strictEqual(r.refused, undefined, 'a single-line range is not inverted');
    assert.deepStrictEqual(r.lines, ['# Doc', '', '- A', '', '- - b', '']);
    assert.strictEqual(st._done.length, 1);
  }
  console.error = realError;
  // Every refusal announced itself, and nothing else did.
  // 5 = commitRangeEdit + commitRangeRemoval direct, the two wrappers that
  // delegate to them, and commitBlockInsertion. The well-formed calls must
  // contribute nothing, which is what makes this a count and not a >0 check.
  assert.strictEqual(logged.length, 5,
    'each of the 5 refusals above must log exactly once; got ' + logged.length + ':\n' +
    logged.join('\n'));
  assert.ok(logged.every((l) => /refused an inverted line range/.test(l)),
    'the log must name the refusal, got:\n' + logged.join('\n'));
  assert.ok(logged.some((l) => /commitRangeEdit/.test(l)) &&
            logged.some((l) => /commitRangeRemoval/.test(l)) &&
            logged.some((l) => /commitBlockInsertion/.test(l)),
    'all three helpers must identify themselves by name in the log, got:\n' + logged.join('\n'));
}

// -- T8 item 4: mechanical duplicate-function-declaration check ------------
// WHY THIS EXISTS. `grep` classifies lib/editor/client.js as BINARY (it
// carries two literal control bytes, U+0001 and U+0000, as table-fingerprint
// separators — asserted below so the reason stays visible), so a plain
// `grep pattern lib/editor/client.js` prints "Binary file matches" or, with
// the wrong flags, nothing at all. That false negative has already shipped one
// defect on this plan: a reviewer grepped for a helper, saw no match, and
// wrote a SECOND function of the same name into the same closure. JavaScript
// function declarations do not collide loudly the way `const` does — the later
// declaration silently wins — and the result was 46 lines of dead code and a
// banner showing the wrong text. The rule "always grep -a" is a thing a human
// has to remember; this check is not.
//
// SCOPE PROXY: leading indentation. Every file below is ONE IIFE with a
// two-space house style, so "same indent" is "same nesting level" there.
//
// LIMITS — read these before extending the file list (T8 review MEDIUM-2).
//   * It is NOT a scope analysis. Indentation is a proxy, and it is only sound
//     where one indent level really is one scope. It holds for lib/editor/*.js
//     (single IIFE each). It does NOT hold for lib/md2doc.js, which embeds the
//     whole reader runtime inside a template literal: its indent-2 bucket
//     holds 77 declarations from unrelated scopes — isExternalRef() inside
//     renderMarkdown() and openLightbox() inside the template string sit in
//     the same bucket. That file is therefore scanned at INDENT 0 ONLY, which
//     is genuinely one scope (module top level). An earlier revision of this
//     comment claimed the proxy "cannot be fooled" the way a brace counter
//     can; that was wrong in the direction that matters, and the correction is
//     the scoping above.
//   * KNOWN FALSE POSITIVE: two same-named nested helpers in DIFFERENT parent
//     functions at the same indent are reported as a duplicate. There are none
//     in the scanned set today (this file is green), and the failure message
//     names line numbers, so the reader can see in one look whether the two
//     share a parent. If a legitimate pair ever appears, rename one or narrow
//     the scan — do not delete the check.
//   * It only looks at `function name(` / `async function name(` at the START
//     of a line, so a mention inside a comment or a string is not a
//     declaration. Deliberately not extended to `const name = ...`: a
//     duplicate `const` in one scope is a SyntaxError at load, already loud.
function duplicateFunctionDeclarations(source, onlyIndent) {
  const seen = new Map();
  const dups = [];
  source.split('\n').forEach((line, i) => {
    const m = /^(\s*)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    if (!m) return;
    if (onlyIndent !== undefined && m[1].length !== onlyIndent) return;
    const key = m[1].length + ':' + m[2];
    if (seen.has(key)) {
      dups.push(m[2] + '() declared at line ' + seen.get(key) + ' and again at line ' +
        (i + 1) + ' (same nesting level) — the second silently replaces the first');
    } else {
      seen.set(key, i + 1);
    }
  });
  return dups;
}
{
  // (a) The detector must FIRE. Two same-name declarations in one closure —
  //     the exact shape of the shipped defect.
  const bad = [
    '(function () {',
    '  function refuse(msg) { return 1; }',
    '  function other() { return 2; }',
    '  function refuse(msg) { return 3; }',
    '})();',
  ].join('\n');
  const hits = duplicateFunctionDeclarations(bad);
  assert.strictEqual(hits.length, 1, 'the detector must find the duplicate, got: ' + hits.join('; '));
  assert.ok(/refuse\(\) declared at line 2 and again at line 4/.test(hits[0]), hits[0]);

  // (b) It must NOT fire on the three shapes that are legitimate and common
  //     in these files, or it would be turned off within a week.
  const good = [
    '(function () {',
    '  function outer() {',
    '    function helper() { return 1; }',
    '  }',
    '  function helper() { return 2; }',
    '  // function helper() {}  <- a comment, not a declaration',
    "  const s = 'function helper(';",
    '})();',
  ].join('\n');
  assert.deepStrictEqual(duplicateFunctionDeclarations(good), [],
    'the detector must not fire on nested / commented / quoted look-alikes');

  // (b2) The KNOWN false positive, asserted rather than described: two nested
  //      helpers of the same name in DIFFERENT parents share an indent and are
  //      reported. Pinning it means the next person to hit it recognises it
  //      from this test instead of rediscovering it from a confusing failure.
  const falsePositive = [
    '(function () {',
    '  function first() {',
    '    function pick() { return 1; }',
    '  }',
    '  function second() {',
    '    function pick() { return 2; }',
    '  }',
    '})();',
  ].join('\n');
  assert.strictEqual(duplicateFunctionDeclarations(falsePositive).length, 1,
    'KNOWN LIMIT: same-named nested helpers under different parents are reported. ' +
    'Indentation is a proxy for scope, not a scope analysis.');

  // (c) The real sources. `src` (client.js) is already read above; the rest
  //     are the other files server.js inlines into the same page, plus the
  //     renderer, because the hazard is the language's, not this file's.
  const scanned = {
    'client.js': src,
    'lineops.js': lineopsSrc,
    'inline-md.js': inlineMdSrc,
    'table-md.js': tableMdSrc,
    'list-md.js': listMdSrc,
    'history.js': historySrc,
    'blockmap.js': fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'blockmap.js'), 'utf8'),
    'indent-clamp.js': fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'indent-clamp.js'), 'utf8'),
    'convert-md.js': fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'convert-md.js'), 'utf8'),
    'server.js': fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'server.js'), 'utf8'),
  };
  Object.keys(scanned).forEach((name) => {
    const found = duplicateFunctionDeclarations(scanned[name]);
    assert.deepStrictEqual(found, [],
      name + ' declares the same function twice at the same nesting level:\n  ' +
      found.join('\n  '));
  });
  // lib/md2doc.js at TOP LEVEL ONLY — see the LIMITS note above for why its
  // indented buckets are not one scope and must not be scanned.
  {
    const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'md2doc.js'), 'utf8');
    const found = duplicateFunctionDeclarations(rendererSrc, 0);
    assert.deepStrictEqual(found, [],
      'md2doc.js declares the same top-level function twice:\n  ' + found.join('\n  '));
    // The scoping is load-bearing, so the fact it rests on is pinned: that file
    // really does mix scopes at indent 2, and an unscoped scan there would be
    // green by luck rather than by construction.
    const allTwo = rendererSrc.split('\n')
      .filter((l) => /^ {2}(?:async )?function [A-Za-z_$]/.test(l)).length;
    assert.ok(allTwo > 40,
      'md2doc.js is expected to hold many indent-2 declarations across UNRELATED ' +
      'scopes (renderMarkdown\'s body and the reader-runtime template literal); found ' +
      allTwo + '. If this collapsed, re-check whether the exclusion is still needed.');
  }

  // The premise of all of the above: client.js really does contain the control
  // bytes that make grep call it binary. If a future edit removes them the
  // "always grep -a" rule stops being load-bearing — and this comment stops
  // being true — so the fact is pinned rather than described. Written with
  // charCodeAt rather than a literal, so this test file itself stays text.
  const ctrl = [];
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c < 32 && c !== 10 && c !== 9 && c !== 13) ctrl.push(c);
  }
  assert.ok(ctrl.length > 0,
    'client.js is expected to contain literal control bytes (the table fingerprint ' +
    'separators) — that is WHY grep needs -a on it and why this check exists');
}

// -- T8 review MEDIUM-1: a REFUSED commit must not roll back somebody else --
// The refusal added above returns `op: null` and pushes nothing. Two of the
// five call sites — insertBlockBelow() and deleteBlockViaGutter() — never
// inspected `result.op`; they assigned `lines = result.lines` (harmless, it is
// the same array back) and, on a render failure, ran `stack.undo(lines)`.
// UndoStack.undo() pops `_done` UNCONDITIONALLY (lib/editor/lineops.js), and
// before the refusal existed an op was always pushed, so that rollback was
// correct. After it, a refusal followed by a failed render pops and reverses
// the user's PREVIOUS, UNRELATED edit. Latent today only because the
// blockOwnsNoLine() guard returns before the commit at both sites; S2 gives li
// blocks a ＋ and it goes live.
//
// The fix is one shared helper rather than two `if (result.op === null) return;`
// lines, because the "optimistically assign, roll back if the render failed"
// idiom is copy-pasted at six sites and the next one added will not remember
// either. It lives in the pure core (above the node module.exports) precisely
// so it can be tested here: the branch is unreachable through a gesture today,
// which is exactly the situation that produced a source-grep test last round.
{
  const mkState = () => {
    const st = new UndoStack();
    // the user's previous, unrelated edit — already committed and on the stack
    const prevOp = { startLine: 1, endLine: 1, before: ['a'], after: ['A'] };
    const ln = ['A', 'b', 'c'];
    st.push(prevOp);
    return { lines: ln, stack: st };
  };
  // (a) THE HAZARD, stated as a fact about UndoStack rather than as prose:
  //     undo() pops whatever is on top, and does not care that the thing that
  //     just "failed" never pushed anything.
  {
    const s0 = mkState();
    const popped = s0.stack.undo(s0.lines);
    assert.deepStrictEqual(popped.lines, ['a', 'b', 'c'],
      "UndoStack.undo() pops unconditionally — this is the user's earlier edit being " +
      'reversed by a rollback that had nothing of its own to reverse');
    assert.strictEqual(s0.stack._done.length, 0);
  }
  // (b) The helper declines to roll back a commit that pushed nothing.
  {
    const s1 = mkState();
    const prevLines = s1.lines;
    const refused = { lines: s1.lines, blocks: [], op: null, refused: 'inverted-range' };
    const out = rollbackFailedRender(s1, refused, prevLines);
    assert.deepStrictEqual(out, ['A', 'b', 'c'],
      "a refused commit's failed render must leave the user's earlier edit standing");
    assert.strictEqual(s1.stack._done.length, 1,
      'and must leave the undo stack exactly as it found it');
  }
  // (c) …and still rolls back a commit that DID push, or it would be a
  //     regression in the other direction — the optimistic `lines` would keep
  //     an edit the server never rendered.
  {
    const s2 = mkState();
    const prevLines = s2.lines;
    const real = commitRangeEdit(
      { lines: s2.lines, blocks: [{ id: 0, startLine: 2, endLine: 2 }], stack: s2.stack },
      2, 2, 'B');
    assert.notStrictEqual(real.op, null, 'sanity: this commit really did push');
    s2.lines = real.lines;
    assert.strictEqual(s2.stack._done.length, 2);
    const out = rollbackFailedRender(s2, real, prevLines);
    assert.deepStrictEqual(out, ['A', 'b', 'c'], 'the failed render is reversed');
    assert.strictEqual(s2.stack._done.length, 1,
      "and only the failed op is popped — the user's earlier edit stays on the stack");
  }
  // (d) An exhausted stack falls back to the caller's snapshot, same contract
  //     the inlined idiom had (`rollback ? rollback.lines : prevLines`).
  {
    const s3 = { lines: ['x'], stack: new UndoStack() };
    assert.deepStrictEqual(
      rollbackFailedRender(s3, { op: { startLine: 1, endLine: 1 } }, ['snapshot']),
      ['snapshot'], 'nothing left to undo -> the caller\'s prevLines');
  }
}

// -- T8 review MEDIUM-1 (mechanical): every rollback goes through the helper --
// The helper only helps if it is the only route. `stack.undo(lines)` is
// legitimate in exactly two places — undo() itself, and redo()'s reversal of a
// failed redo — and nowhere else. A third occurrence means somebody re-inlined
// the idiom and re-created the hazard above.
// `codeLines()` drops comment-only lines before any source-level count. A
// mechanical check that counts its OWN explanatory comment is a check whose
// failure message asserts a defect that is not there — which is precisely the
// misdirection this round's review flagged in indent-clamp.test.js. It is not
// a full lexer (a `//` inside a string literal on an otherwise-code line still
// counts, as it should — that IS code), just the one distinction that matters.
function codeLines(source) {
  return source.split('\n').filter((l) => {
    const t = l.trim();
    return t !== '' && t.indexOf('//') !== 0 && t.indexOf('*') !== 0 && t.indexOf('/*') !== 0;
  });
}
function countInCode(source, needle) {
  return codeLines(source).filter((l) => l.indexOf(needle) !== -1).length;
}
{
  const undoCalls = countInCode(src, 'stack.undo(lines)');
  assert.strictEqual(undoCalls, 2,
    'stack.undo(lines) may appear on exactly two CODE lines in client.js — inside ' +
    'undo() (the gesture itself) and inside redo()\'s failure path (reversing a ' +
    'redo). Every OTHER rollback must go through rollbackFailedRender(), which ' +
    'declines when the commit pushed nothing; found ' + undoCalls);
  const helperCalls = countInCode(src, 'rollbackFailedRender(');
  // S2 Task 2 added the seventh commit-then-render site (convertBlockViaMenu),
  // S2 Task 4 the eighth (convertListItemAway, which commits its own spliced
  // range instead of going through commitListStructure), S2 Task 5 the ninth
  // (convertBlockIntoList, which commits the block's own range widened over
  // the §4.3 rule 2 separator) and S2 Task 6 the tenth
  // (duplicateBlockViaMenu's NON-li path, which commits through
  // commitBlockInsertion() — the li path goes through commitListStructure()
  // and reuses ITS site, so 複製 adds exactly one). The expected total is
  // therefore DECLARED once + EXPORTED once + 10 uses = 12.
  assert.strictEqual(helperCalls, 12,
    'the helper must be DECLARED once, EXPORTED once, and used at all ten ' +
    'commit-then-render sites; found ' + helperCalls + ' code lines mentioning it');
}

console.log('editor-client.test.js OK');
