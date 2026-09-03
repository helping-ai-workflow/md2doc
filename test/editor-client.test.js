'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { extractBlockSource, commitEdit, commitListBlockRemoval, commitBlockInsertion, planBlockMove, commitBlockMove, reorderSpanRange, spanMoveRange, spanIndentsAreAnchored, blockMoveSeamRefusal, withHeadingDepth, commitRangeEdit, commitRangeRemoval, rollbackFailedRender } = require('../lib/editor/client.js');
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
                      'ed-wys-cell', 'ed-tb-insert', 'wireBlockSelection',
                      // S3 Task 2: 'ed-selected' is BACK, and it is a
                      // different feature wearing a recycled name. It used to
                      // be the retired click-select edit bar's single-block
                      // blue OUTLINE (`.ed-block.ed-selected { outline: 2px
                      // solid #3b82f6 }`, commit 4bfafd5) and was on the
                      // must-NOT-reference list below for that reason. Spec
                      // §4.4 names the same class for block MULTI-select's
                      // semi-transparent tint, so the guard had to move sides
                      // rather than be deleted — see the note on that list.
                      'ed-selected', 'md2docSelection']) {
  assert.ok(src.includes(needle), `client.js must reference ${needle}`);
}
// The old hover-gutter DOM wiring must be gone (replaced by the click-bar,
// itself later retired in favor of always-on arming — see Task 5).
assert.ok(!/ed-gutter/.test(src), 'client.js must not reference the removed .ed-gutter');
assert.ok(!/attachGutters/.test(src), 'client.js must not reference the removed attachGutters()');
// Task 5: the click-select edit bar (its last consumer, tables, is retired
// in this task — T2 already retired it for paragraph/heading) must be
// fully gone, not just unused.
// 'ed-selected' was on this list until S3 Task 2 and is now on the
// must-reference list above: the retired bar owned that class name, and the
// block multi-select tint (spec §4.4) now owns it. The retirement guarantee is
// unweakened — it never rested on the CSS class alone. Every piece of the
// bar's actual WIRING is still named here ('selectedBlockEl' held the one
// selected element, 'showBarFor'/'dismissBar'/'updateBarButtons' were its
// whole lifecycle, 'ed-bar' its own root class), so resurrecting the bar
// without tripping this list is not possible.
for (const needle of ['ed-bar', 'openTableEditor', 'runTableStructureOp',
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

  // Verify that client.js contains the two delimiter escape sequences in
  // tableIdentityOf. They are written as '\\x01' and '\\x00' in the source
  // (not as literal control bytes), which keeps the file as text so grep can
  // search it without needing -a. The runtime value is identical.
  assert.ok(/tableIdentityOf[\s\S]*?'\\x01'[\s\S]*?'\\x00'/.test(src),
    'client.js is expected to contain the escape sequences \\x01 and \\x00 in ' +
    'tableIdentityOf to keep the file text');
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
// WHAT THE TWO COUNTS BELOW PROVE, AND WHAT THEY DO NOT. Both are
// SOURCE-TEXT PRESENCE checks over client.js, never REACHABILITY checks:
// they prove the helper is still WRITTEN at N places, not that any of those
// places is still on a live path. MEASURED 2026-08-30 - delete the
// `await convertListItemAway(liveBlockEl, liRun, rec, target);` dispatch
// inside convertBlockViaMenu() and that function, together with the
// rollbackFailedRender() site it owns, is unreachable; this block still
// counts 12 and passes. The runtime scenarios in
// test/editor-client-runtime.test.js are what catch that, because they drive
// the real gesture. Read these two numbers as "nobody re-inlined the idiom
// or grew an unreviewed commit site", and nothing more.
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
  // and reuses ITS site, so 建立副本 adds exactly one). The expected total is
  // therefore DECLARED once + EXPORTED once + 10 uses = 12.
  //
  // S2 Task 7 (li ＋) adds NONE, and that was checked rather than assumed:
  // its 清單 path splices the new item into the run and commits through
  // commitListStructure() — the same site 建立副本's li path already reuses —
  // and every other kind goes down insertBlockBelow()'s existing
  // commitBlockInsertion() tail, which was already one of the ten. If a
  // future task grows an eleventh, migrate this number WITH the reason;
  // never relax the assertion.
  //
  // MIGRATED by S3 Task 7 (12 -> 13), with the reason: §3.5's batch Tab over a
  // span of NON-list blocks (changeHeadingDepthsInSpan()) is a genuinely NEW
  // commit-then-render site — it rewrites the heading lines inside the span's
  // own range with commitRangeEdit() and renders, which is neither
  // commitListStructure()'s site nor commitBlockInsertion()'s. S3 Tasks 1-6
  // added NONE, and that was checked rather than assumed: Task 6 generalized
  // every batch operation IN PLACE (Task 6 carry 12), and Task 7's LIST half
  // reuses commitListStructure()'s existing site the way every other list
  // structural edit does. The expected total is therefore DECLARED once +
  // EXPORTED once + 11 uses = 13.
  //
  // MIGRATED by S4 Task 3 (13 -> 14), with the reason: performBlockDrop() —
  // the ⠿ drag's drop — is a genuinely NEW commit-then-render site. It commits
  // ONE relocated line range through commitBlockMove()/commitRangeEdit() and
  // renders, which is neither commitListStructure()'s site nor
  // commitBlockInsertion()'s nor changeHeadingDepthsInSpan()'s. S4 Tasks 1, 2
  // and 2b added NONE and that was checked rather than assumed: Task 1 is
  // geometry, and Tasks 2/2b are chrome that deliberately write no bytes at
  // all. The expected total is therefore DECLARED once + EXPORTED once +
  // 12 uses = 14.
  //
  // ⚠ THE ACCOUNTING SENTENCE ABOVE WAS WRONG FOR SEVERAL VERSIONS, and is
  // corrected here rather than carried forward again. The probe is
  // countInCode(src, 'rollbackFailedRender(') — WITH the open paren — so the
  // `module.exports = { …, rollbackFailedRender, … }` line CANNOT match it:
  // that name appears there bare. The real breakdown has always been
  // 1 DECLARATION + N CALL SITES, never "declared + exported + N". Every
  // "+ EXPORTED once" in the migration notes above is off by one in the
  // narrative only; the numbers themselves were, and are, correct.
  //
  // MIGRATED by v3.1.0 Task E (14 -> 16). TWO genuinely new
  // commit-then-render sites, both of which own their range outright and so
  // cannot borrow another site's rollback:
  //   * leaveSourceMode() — 追加 4's whole-document source escape hatch.
  //     Replaces the ENTIRE document through one commitRangeEdit(1,
  //     lines.length, …). Its rollback matters more than most: the range is
  //     the whole file, so a failed render that left `lines` holding the new
  //     text while the server still had the old would desynchronise every
  //     later edit.
  //   * insertParagraphAtTop() — the toolbar's ⬆ on the document's FIRST
  //     block, which has no predecessor to insert below. It splices
  //     [skeleton, '', line] over that block's own first line with
  //     commitRangeEdit(), so it is neither commitBlockInsertion()'s site nor
  //     any of the others.
  // The rest of v3.1.0 adds NONE, and that was checked rather than assumed:
  // indentCaretLi() commits through commitListStructure()'s existing site,
  // the toolbar's convert/heading buttons call functions that already owned
  // theirs, and the image/paste paths go through insertBlockBelow()'s.
  // The expected total is therefore 1 declaration + 15 call sites = 16.
  assert.strictEqual(helperCalls, 16,
    'the helper must be DECLARED once and used at all fifteen ' +
    'commit-then-render sites; found ' + helperCalls + ' code lines mentioning it');
}

// -- S4 Task 3: planBlockMove() / commitBlockMove() --------------------------
// The pure half of the ⠿ drag's drop. The RUNTIME scenarios in
// test/editor-client-runtime.test.js drive the gesture and pin the saved
// bytes; what lives here is the one property a gesture scenario CANNOT
// discriminate, plus the byte table those scenarios' expectations were
// measured from.
//
// WHY THE HOME-POSITION GUARD NEEDS ITS OWN TEST — measured, and it is the
// vacuity shape this plan's own constraints name ("an assertion that holds
// under a refusal"): narrowing the guard from `ins >= ds && ins <= de + 1` to
// `ins === ds` left EVERY runtime scenario green, the "released where it
// started" ones included. The narrowed guard lets the `de + 1` seam through,
// the branch arithmetic then produces an INVERTED range, and
// refuseInvertedRange() catches it and writes nothing — so the file is
// byte-identical for the wrong reason and no gesture-level assertion can see
// the difference. This one can: it reads the plan, not the file.
{
  const mv = (md, srcIdx, destIdx) => {
    const l = md.split('\n');
    const bm = require('../lib/editor/blockmap.js').buildBlockMap(md).blocks;
    const plan = planBlockMove(l, bm, bm[srcIdx], destIdx === null ? null : bm[destIdx]);
    if (!plan) return null;
    return l.slice(0, plan.startLine - 1).concat(plan.after, l.slice(plan.endLine)).join('\n');
  };
  const DOC = '# Doc\n\nalpha\n\nbravo\n\ncharlie\n\ndelta\n';

  // ── the two home positions ────────────────────────────────────────────
  assert.strictEqual(mv(DOC, 1, 1), null,
    'a block released on its OWN top edge (before-block = itself) is a no-op');
  assert.strictEqual(mv(DOC, 1, 2), null,
    'a block released on the seam immediately BELOW itself is the SAME position on '
    + 'screen and must also be a no-op. This is the assertion a gesture scenario cannot '
    + 'make: with this case let through, the range comes out INVERTED, '
    + 'refuseInvertedRange() swallows it, and the file is unchanged for the wrong reason');
  assert.strictEqual(mv(DOC, 4, null), null,
    'the LAST block released on the append target is already there');

  // ── the partner: the very next seam in each direction IS a move ───────
  // Without these, "it returned null" is satisfied by a function that always
  // returns null.
  assert.strictEqual(mv(DOC, 1, 3), '# Doc\n\nbravo\n\nalpha\n\ncharlie\n\ndelta\n',
    'ONE seam further down is a real move — the partner proving the no-ops above are '
    + 'about the POSITION and not about the function');
  assert.strictEqual(mv(DOC, 1, 0), 'alpha\n\n# Doc\n\nbravo\n\ncharlie\n\ndelta\n',
    'one seam further UP is a real move too');

  // ── the byte table (every entry verified against marked.lexer and
  //    blockmap.buildBlockMap before it was pinned) ────────────────────────
  assert.strictEqual(mv(DOC, 1, 4), '# Doc\n\nbravo\n\ncharlie\n\nalpha\n\ndelta\n',
    'down past two blocks');
  assert.strictEqual(mv(DOC, 3, 0), 'charlie\n\n# Doc\n\nalpha\n\nbravo\n\ndelta\n',
    'up to the very top: no leading blank is invented, there is no neighbour above');
  assert.strictEqual(mv(DOC, 1, null), '# Doc\n\nbravo\n\ncharlie\n\ndelta\n\nalpha\n',
    'appended: the separator lands ABOVE the block, and the file keeps its trailing '
    + 'newline rather than absorbing it as a blank');
  assert.strictEqual(
    mv('# Doc\n\nalpha\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nbravo\n', 2, 0),
    '```js\nconst a = 1;\n\nconst b = 2;\n```\n\n# Doc\n\nalpha\n\nbravo\n',
    'a fenced block moves whole — the blank INSIDE the fence is part of the block\'s '
    + 'line range and is never mistaken for a separator');
  assert.strictEqual(mv('# A\n# B\n# C\n', 0, 2), '# B\n\n# A\n\n# C\n',
    'the ONE documented case where the blank count moves: the landing seam had none to '
    + 'carry, so rule 3 emits the ones it needs');

  // ── every move above is a PERMUTATION of the file's lines ─────────────
  // The rule's headline property, asserted rather than asserted-in-prose.
  [[DOC, 1, 4], [DOC, 3, 0], [DOC, 1, null]].forEach(([md, a, b]) => {
    const out = mv(md, a, b);
    assert.deepStrictEqual(out.split('\n').slice().sort(), md.split('\n').slice().sort(),
      'a move in a normally-separated document is a PERMUTATION of its lines — same '
      + 'lines, same count, same separators. Got:\n' + JSON.stringify(out));
  });

  // ── ONE op on the stack, and undo restores the file ──────────────────
  // §3.4: one gesture, one undo. commitBlockMove() is the only thing between
  // the gesture and the stack, so this is where "exactly one op" is provable
  // by COUNTING rather than by pressing Ctrl+Z once and hoping.
  {
    const l = DOC.split('\n');
    const bm = require('../lib/editor/blockmap.js').buildBlockMap(DOC).blocks;
    const st = new UndoStack();
    const r = commitBlockMove({ lines: l, blocks: bm, stack: st }, bm[1], bm[4]);
    assert.ok(r.op, 'PRECONDITION: this fixture must actually move — a stack with zero '
      + 'ops also satisfies "not more than one"');
    assert.strictEqual(r.lines.join('\n'), '# Doc\n\nbravo\n\ncharlie\n\nalpha\n\ndelta\n',
      'PRECONDITION: ...and move to the right place');
    const back = st.undo(r.lines);
    assert.strictEqual(back.lines.join('\n'), DOC,
      'ONE undo op restores the file: the move is a single contiguous range edit, never '
      + 'a removal plus an insertion');
    assert.strictEqual(st.undo(back.lines), null,
      'and there is no SECOND op behind it — that is the whole reason the move is '
      + 'written as one commitRangeEdit over min(source, destination)..max(...)');
  }
}

// -- S4 Task 4/6: reorderSpanRange() / spanMoveRange() / spanIndentsAreAnchored()
// The pure half of a LIST ITEM's ⠿ drop. The runtime scenarios drive the
// gesture and pin the saved bytes; these two answer the questions a gesture
// scenario cannot discriminate.
//
// reorderSpanRange() is the arithmetic that turns "the `count` members at `from` go
// before the item at `insertAt`" into the span array serializeBlocks() emits
// in. It is not the obvious `splice(from,1); splice(insertAt,0,…)`: `insertAt`
// names a slot in the array BEFORE the removal, so a downward move has to be
// decremented — off by one there moves the item to the wrong side of its
// destination, which on a two-item run is invisible (there is only one other
// slot) and on a three-item run is a wrong document.
//
// spanIndentsAreAnchored() is §4.5's INDENT SEAM, and the reason Task 4 has
// one at all: `serializeBlocks()` rebuilds its width stack per span, so a span
// whose first block claims `data-indent="1"` emits it at column 0 — the DOM
// and the file then disagree about the nesting, which is the "looks right on
// screen, cannot be saved" class indent-clamp.js exists for. Task 7 replaces
// the refusal this predicate drives with `applyIndentClamp()`; until then the
// predicate is what stops the move from writing a document the user did not
// ask for. Its bound is deliberately the SAME one indent-clamp.js's own
// `boundAt()` computes (previous li's indent + 1, and 0 when there is no
// previous li or the previous block is not a li), so the two cannot drift.
{
  const li = (n) => ({ type: 'li', indent: n });
  const other = () => ({ type: 'paragraph', indent: 0 });

  // ── reorderSpanRange ────────────────────────────────────
  // MIGRATED by S4 Task 6 from `reorderSpanIndices(length, from, insertAt)`,
  // which could only express a ONE-member move. §4.5's 「grip 在選取集合內
  // → 整批搬」 needs N, and two implementations of the same off-by-one would be
  // the 「不得另寫一條」 shape this plan has already refused twice. Every
  // assertion below is the ORIGINAL one with `count` pinned to 1, so the
  // single-item arithmetic is still covered by exactly the cases that covered
  // it before; the count > 1 rows underneath are new.
  assert.strictEqual(reorderSpanRange(3, 0, 1, 0), null,
    'MIGRATED (was reorderSpanIndices(3, 0, 0)): inserting before yourself is the home '
    + 'position, not a move');
  assert.strictEqual(reorderSpanRange(3, 0, 1, 1), null,
    'MIGRATED (was reorderSpanIndices(3, 0, 1)): inserting before the block immediately '
    + 'BELOW you is the same place on screen — the byte no-op the drag\'s '
    + 'release-where-you-started case depends on');
  // The partner: without it, "it returned null" is satisfied by a function
  // that always returns null.
  assert.deepStrictEqual(reorderSpanRange(3, 0, 1, 2), [1, 0, 2],
    'MIGRATED: one slot further down IS a move, and the moved item lands AFTER the block '
    + 'whose slot was named — the decrement that a downward move needs');
  assert.deepStrictEqual(reorderSpanRange(3, 0, 1, 3), [1, 2, 0],
    'MIGRATED: insertAt === length is "at the very end of the run"');
  assert.deepStrictEqual(reorderSpanRange(3, 2, 1, 0), [2, 0, 1],
    'MIGRATED: an UPWARD move is not decremented — the same insertAt means a different '
    + 'slot depending on the direction, which is the whole reason this is a named function');
  assert.deepStrictEqual(reorderSpanRange(4, 3, 1, 1), [0, 3, 1, 2],
    'MIGRATED: up past two blocks');
  assert.deepStrictEqual(reorderSpanRange(4, 1, 1, 4), [0, 2, 3, 1],
    'MIGRATED: down to the end past two blocks');
  assert.strictEqual(reorderSpanRange(3, 3, 1, 0), null,
    'MIGRATED: a `from` outside the span is refused');
  assert.strictEqual(reorderSpanRange(3, 0, 1, 4), null,
    'MIGRATED: an `insertAt` past the end is refused');

  // ── count > 1: the whole point of Task 6 ────────────────────
  // THE MUTATION THIS BLOCK EXISTS TO KILL is "the operand set one short":
  // `count - 1` here leaves the set's LAST member standing where it was while
  // the rest travel, which on a gesture-level assertion looks like an ordinary
  // wrong-order document and on a two-member set is invisible (moving one of
  // two members past the other produces the same array as moving both, in the
  // one direction). The rows below are all >= 2 members in a >= 4 slot span
  // for exactly that reason.
  assert.deepStrictEqual(reorderSpanRange(4, 0, 2, 4), [2, 3, 0, 1],
    'a two-member set moved to the end keeps the members\' OWN order — the set travels '
    + 'as a block, it is not reversed and it is not interleaved');
  assert.deepStrictEqual(reorderSpanRange(4, 2, 2, 0), [2, 3, 0, 1],
    'and the same set moved UP to the head, from the other side');
  assert.deepStrictEqual(reorderSpanRange(5, 1, 3, 5), [0, 4, 1, 2, 3],
    'THREE members down past the tail: `insertAt` names a slot in the array BEFORE the '
    + 'removal, so a downward move is decremented by the WHOLE count and not by one — '
    + 'decrementing by 1 here answers [0,4,1,2,3] for insertAt 5 and 4 alike, i.e. two '
    + 'different gestures collapse onto one document');
  assert.deepStrictEqual(reorderSpanRange(5, 1, 3, 0), [1, 2, 3, 0, 4],
    'three members up to the head');
  // The home positions, for a SET. `insertAt` anywhere from `from` to
  // `from + count` inclusive is the set's own footprint: the same place on
  // screen, and the byte no-op a release-where-you-started gesture depends on.
  [0, 1, 2].forEach((a) => {
    assert.strictEqual(reorderSpanRange(4, 0, 2, a), null,
      'insertAt=' + a + ' is inside (or on either edge of) a 2-member set starting at 0 '
      + '— every one of those is the set\'s own position and must be a byte no-op, not '
      + 'a reorder that shuffles members WITHIN the set');
  });
  assert.deepStrictEqual(reorderSpanRange(4, 0, 2, 3), [2, 0, 1, 3],
    'and the partner one slot further on IS a move — without it the three nulls above '
    + 'are satisfied by a function that refuses every set');
  assert.strictEqual(reorderSpanRange(4, 3, 2, 0), null,
    'a set that runs off the end of the span is refused');
  assert.strictEqual(reorderSpanRange(4, 0, 0, 2), null,
    'an EMPTY set names no move');
  // Every answer is a PERMUTATION of the span — nothing may be dropped or
  // duplicated. Asserted, because a splice off by one silently can do both.
  [[3, 0, 1, 2], [3, 0, 1, 3], [3, 2, 1, 0], [4, 3, 1, 1], [4, 1, 1, 4],
    [4, 0, 2, 4], [4, 2, 2, 0], [5, 1, 3, 5], [5, 1, 3, 0], [4, 0, 2, 3]].forEach(([n, f, c, a]) => {
    const got = reorderSpanRange(n, f, c, a);
    assert.deepStrictEqual(got.slice().sort((x, y) => x - y),
      Array.from({ length: n }, (_, i) => i),
      'a reorder is a PERMUTATION of the span: same members, same count. Got '
      + JSON.stringify(got));
    // ...and the moved members stay CONSECUTIVE and in their own order. A
    // `count`-off-by-one shows up here as a member left behind in place.
    const moved = Array.from({ length: c }, (_, i) => f + i);
    const at = got.indexOf(moved[0]);
    assert.deepStrictEqual(got.slice(at, at + c), moved,
      'the operand set travels WHOLE and in order — got ' + JSON.stringify(got)
      + ' for (length ' + n + ', from ' + f + ', count ' + c + ', insertAt ' + a + ')');
  });

  // ── spanMoveRange ───────────────────────────────────
  // The non-li half of "the operand set one short", and the reason it is a
  // named function rather than an object literal at the call site: the set is
  // the ONLY thing that reaches planBlockMove(), so an endLine taken from any
  // member but the LAST silently relocates a prefix of the set and leaves the
  // rest behind — which writes the set's own text into the file twice over
  // once the blank runs are re-emitted. `recs[0].endLine` is the mutation that
  // looks most like a typo and it is caught here in milliseconds.
  {
    const r = (a, b) => ({ startLine: a, endLine: b });
    assert.deepStrictEqual(spanMoveRange([r(3, 3)]), { startLine: 3, endLine: 3 },
      'one block: the block\'s own range');
    assert.deepStrictEqual(spanMoveRange([r(3, 3), r(5, 5), r(7, 7)]),
      { startLine: 3, endLine: 7 },
      'THREE blocks: first member\'s startLine to the LAST member\'s endLine. The '
      + 'separators between them are inside that range and travel verbatim, which is '
      + 'what makes a batch move the same single commitRangeEdit a one-block move is');
    assert.deepStrictEqual(spanMoveRange([r(3, 3), r(5, 9)]), { startLine: 3, endLine: 9 },
      'the last member\'s endLine, not its startLine — a fence or a table owns several '
      + 'lines and a set that ends in one must carry all of them');
    assert.strictEqual(spanMoveRange([]), null, 'an empty operand set names no range');
    assert.strictEqual(spanMoveRange(null), null, 'and neither does a missing one');
  }

  // ── spanIndentsAreAnchored ────────────────────────────────────────────
  assert.strictEqual(spanIndentsAreAnchored([li(0), li(0), li(0)]), true,
    'a flat run is anchored');
  assert.strictEqual(spanIndentsAreAnchored([li(0), li(1), li(0)]), true,
    'a child directly under its parent is anchored');
  assert.strictEqual(spanIndentsAreAnchored([li(1), li(0)]), false,
    'a span that OPENS at indent 1 has nothing to hang that column off — this is the '
    + 'case a move creates by lifting a parent out from above its own child, and it is '
    + 'exactly what serializeBlocks() would silently emit at column 0');
  assert.strictEqual(spanIndentsAreAnchored([li(0), li(2)]), false,
    'a jump of two columns has no anchor for the second one either');
  assert.strictEqual(spanIndentsAreAnchored([li(0), li(1), li(2), li(1), li(0)]), true,
    'coming back UP is always anchored — only going deeper needs a parent');
  assert.strictEqual(spanIndentsAreAnchored([li(0), other(), li(1)]), false,
    'a NON-li block breaks the chain: indent-clamp.js\'s anchorBefore() stops at the '
    + 'first non-li and answers null, so the block after it may sit at 0 and no deeper');
  assert.strictEqual(spanIndentsAreAnchored([li(0), other(), li(0)]), true,
    'and the partner — the same shape at a legal indent is anchored, so the assertion '
    + 'above is about the INDENT and not about the paragraph');
  assert.strictEqual(spanIndentsAreAnchored([]), true, 'an empty span is vacuously anchored');
}

// -- S4 Task 7: THE SWEEP the clamp decision rests on -------------------------
// Not a feature test — a MEASUREMENT PIN, and it is labelled as one because it
// was green before Task 7 wrote a line of production code. It re-runs, on every
// `npm test`, the exhaustive sweep that decided between "extend the clamp" and
// "keep Task 4's refusal and narrow it", so that a future change to
// clampIndents() or reorderSpanRange() cannot quietly invalidate the decision
// without a test saying so.
//
// The model is performListItemDrop()'s own gates, re-expressed on indent
// arrays: `run` is a legal indent array (each entry at most one deeper than the
// one above); the operand set is `count` CONSECUTIVE slots starting at `from`;
// the legal destinations are the slots of the FIRST member's §3.8 sibling group
// plus the slot past the last sibling's whole subtree (§4.5's 2026-09-01
// ruling); `reorderSpanRange()` answers the span order and `null` for a home
// position. The clamp under test is the one performListItemDrop() performs:
// clampIndents(run in DOCUMENT order, the set's indices, the set's SMALLEST old
// indent, { removed: true }) — the removal half of the move, at the OLD index.
//
// Three numbers come out, and all three are load-bearing:
//   * 0 drops leave the MOVED set's own first member illegal at its
//     destination, which is why §4.5's 「落點使其非法時夾到合法值」 has no
//     reachable case while the destination gate stands;
//   * every remaining unanchored span is a `count > 1` set whose break is the
//     block immediately AFTER the landed set — the DESTINATION side, which no
//     removal-clamp reaches. That family is what BLOCK_MOVE_ORPHAN_MESSAGE
//     still refuses;
//   * and the refusal it replaced fired on 1425 of the 4067, i.e. the gate was
//     over-wide by 1411 drops. If that number ever collapses toward zero the
//     clamp has stopped being called and the sweep has gone vacuous.
{
  const { clampIndents } = require('../lib/editor/indent-clamp.js');
  const li = (n) => ({ type: 'li', indent: n });
  const legalShapes = (n) => {
    const out = [];
    (function rec(a) {
      if (a.length === n) { out.push(a.slice()); return; }
      for (let d = 0; d <= Math.min(3, a[a.length - 1] + 1); d++) rec(a.concat(d));
    })([0]);
    return out;
  };
  // The §3.8 sibling group of slot `i`: the same-depth members reachable
  // without stepping outside the subtree that contains it.
  const sibsOf = (ds, i) => {
    const d = ds[i]; const out = [];
    for (let j = i; j >= 0; j--) { if (ds[j] < d) break; if (ds[j] === d) out.unshift(j); }
    for (let j = i + 1; j < ds.length; j++) { if (ds[j] < d) break; if (ds[j] === d) out.push(j); }
    return out;
  };
  const subtreeEnd = (ds, j) => {
    let k = j; while (k + 1 < ds.length && ds[k + 1] > ds[j]) k++; return k;
  };
  const firstBreak = (arr) => {
    let prev = null;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] > (prev === null ? 0 : prev + 1)) return i;
      prev = arr[i];
    }
    return -1;
  };
  let total = 0, refusedByThePredicate = 0, movedIllegal = 0;
  const residual = [];
  for (let n = 2; n <= 6; n++) {
    legalShapes(n).forEach((ds) => {
      for (let from = 0; from < n; from++) {
        for (let count = 1; from + count <= n; count++) {
          const sibs = sibsOf(ds, from);
          const dests = sibs.concat([subtreeEnd(ds, sibs[sibs.length - 1]) + 1]);
          dests.forEach((insertAt) => {
            const order = reorderSpanRange(n, from, count, insertAt);
            if (!order) return; // a home position: no reorder, no bytes
            total++;
            if (!spanIndentsAreAnchored(order.map((k) => li(ds[k])))) refusedByThePredicate++;
            const idxs = [];
            for (let k = from; k < from + count; k++) idxs.push(k);
            const opOld = Math.min.apply(null, idxs.map((k) => ds[k]));
            const after = ds.slice();
            clampIndents(ds.map((d, k) => ({ id: k, type: 'li', indent: d })),
              idxs, opOld, { removed: true }).forEach((r) => { after[r.blockId] = r.indent; });
            const span = order.map((k) => after[k]);
            const setPos = order.indexOf(from);
            const bound = setPos === 0 ? 0 : span[setPos - 1] + 1;
            if (after[from] > bound) movedIllegal++;
            const br = firstBreak(span);
            if (br >= 0) residual.push({ ds: ds.join(''), from, count, insertAt, br,
              afterSet: br === setPos + count });
          });
        }
      }
    });
  }
  assert.strictEqual(total, 4067,
    'ANTI-VACUITY: the sweep must be enumerating the whole space it claims to. 4067 '
    + 'legal drops over every legal indent array of length 2..6 and depth 0..3, every '
    + 'operand-set size, every legal destination. Got ' + total);
  assert.ok(refusedByThePredicate > 1000,
    'ANTI-VACUITY: Task 4\'s predicate must still be firing on a large fraction of the '
    + 'space — that is what makes "the clamp answers almost all of it" a claim worth '
    + 'pinning. Got ' + refusedByThePredicate);
  assert.strictEqual(movedIllegal, 0,
    'THE MOVED BLOCK IS NEVER ILLEGAL AT ITS DESTINATION. §4.5 says it is clamped when '
    + 'the destination makes it so, and the 2026-09-01 destination ruling means that '
    + 'cannot happen: the only legal slots are among its own same-depth siblings, whose '
    + 'predecessor can always parent it. If this ever fires, the destination gate has '
    + 'been widened and performListItemDrop() now owes a clamp for the moved block '
    + 'itself. Got ' + movedIllegal + ' counterexamples');
  assert.ok(residual.every((r) => r.count > 1),
    'every span the removal-clamp cannot anchor comes from a MULTI-BLOCK set — a single '
    + 'item\'s move is fully answered by { removed: true } at its old index. Got '
    + JSON.stringify(residual.filter((r) => r.count === 1).slice(0, 3)));
  assert.ok(residual.every((r) => r.afterSet),
    'and in every one of them the break is the block immediately AFTER the landed set, '
    + 'i.e. the INSERTION half — which no removal-clamp reaches and for which §3.4 has '
    + 'no rule. That is exactly the family BLOCK_MOVE_ORPHAN_MESSAGE still refuses. Got '
    + JSON.stringify(residual.filter((r) => !r.afterSet).slice(0, 3)));
  assert.strictEqual(residual.length, 14,
    'and it is 14 of the 4067 — the number the narrowing was decided on. A DIFFERENT '
    + 'number is not a failing test on its own, but it means clampIndents() or '
    + 'reorderSpanRange() changed answer and Task 7\'s ruling has to be re-measured '
    + 'before it is re-pinned. Got ' + residual.length);
}

// -- S4 review round: WHY writeIndentClamp()'s WRITE needs a BATCH fixture ---
// The review measured that `writeIndentClamp(clamp);` could be deleted from
// performListItemDrop() with all 39 S4 scenarios still green — the four T7 ones
// named after the clamp included — and concluded the write might be inert.
//
// It is not. This re-runs the sweep above with the REAL serializeBlocks() on
// both sides, once with the clamp's answer written back into `data-indent` and
// once without, and counts the drops whose emitted BYTES differ. Two numbers
// come out and both are load-bearing:
//
//   * `count === 1` never differs, on either list type. serializeBlocks()
//     rebuilds its width stack as it walks (`widths.length = indent + 1` after
//     every block), so an over-deep `data-indent` is emitted at its anchor's
//     own column anyway — which is the column the clamp would have written.
//     THAT is why every single-item T7 fixture stayed green, and why any test
//     for the write has to be a BATCH one.
//   * `count > 1` differs on 53 `ul` drops and 123 `ol` ones. If either falls
//     to zero the write really has become inert and RV2 has gone vacuous —
//     re-measure before deleting anything.
{
  const { serializeBlocks } = require('../lib/editor/list-md.js');
  const { clampIndents } = require('../lib/editor/indent-clamp.js');
  const stub = (name, attrs, kids) => ({
    nodeType: 1, nodeName: name.toUpperCase(), childNodes: kids || [],
    getAttribute: (k) => (attrs[k] !== undefined ? attrs[k] : null),
    classList: { contains: (c) => (attrs.class || '').split(/\s+/).indexOf(c) !== -1 },
    get textContent() { return this.childNodes.map((c) => c.textContent).join(''); },
  });
  const liStub = (id, listType, indent, listStart) => stub('div', {
    class: 'ed-block', 'data-block-id': String(id), 'data-block-type': 'li',
    'data-list-type': listType, 'data-task': '0', 'data-indent': String(indent),
    'data-list-start': listStart ? '1' : null,
  }, [
    stub('span', { class: 'ed-li-marker' }, [{ nodeType: 3, textContent: '\u2022' }]),
    stub('div', { class: 'ed-li-text' }, [{ nodeType: 3, textContent: 'x' + id }]),
  ]);
  const legalShapes = (n) => {
    const out = [];
    (function rec(a) {
      if (a.length === n) { out.push(a.slice()); return; }
      for (let d = 0; d <= Math.min(3, a[a.length - 1] + 1); d++) rec(a.concat(d));
    })([0]);
    return out;
  };
  const sibsOf = (ds, i) => {
    const d = ds[i]; const out = [];
    for (let j = i; j >= 0; j--) { if (ds[j] < d) break; if (ds[j] === d) out.unshift(j); }
    for (let j = i + 1; j < ds.length; j++) { if (ds[j] < d) break; if (ds[j] === d) out.push(j); }
    return out;
  };
  const subtreeEnd = (ds, j) => { let k = j; while (k + 1 < ds.length && ds[k + 1] > ds[j]) k++; return k; };
  const counts = {};
  ['ul', 'ol'].forEach((listType) => {
    let single = 0, batch = 0, admitted = 0;
    for (let n = 2; n <= 6; n++) {
      legalShapes(n).forEach((ds) => {
        for (let from = 0; from < n; from++) {
          for (let count = 1; from + count <= n; count++) {
            const sibs = sibsOf(ds, from);
            const dests = sibs.concat([subtreeEnd(ds, sibs[sibs.length - 1]) + 1]);
            dests.forEach((insertAt) => {
              const order = reorderSpanRange(n, from, count, insertAt);
              if (!order) return;
              const idxs = [];
              for (let k = from; k < from + count; k++) idxs.push(k);
              const opOld = Math.min.apply(null, idxs.map((k) => ds[k]));
              const after = ds.slice();
              clampIndents(ds.map((d, k) => ({ id: k, type: 'li', indent: d })),
                idxs, opOld, { removed: true }).forEach((r) => { after[r.blockId] = r.indent; });
              // performListItemDrop() asks its predicate on the CLAMPED span,
              // so a drop it refuses never reaches the write at all.
              if (!spanIndentsAreAnchored(order.map((k) => ({ type: 'li', indent: after[k] })))) return;
              admitted++;
              // `data-list-start` follows the run's first SIBLING across the
              // reorder — the transfer performListItemDrop() performs.
              const head = order.filter((k) => sibs.indexOf(k) !== -1)[0];
              const emit = (ind) => serializeBlocks(
                order.map((k) => liStub(k, listType, ind[k], k === head)), {}).md;
              if (emit(after) === emit(ds)) return;
              if (count === 1) single++; else batch++;
            });
          }
        }
      });
    }
    counts[listType] = { admitted, single, batch };
  });
  assert.strictEqual(counts.ul.admitted, 4053,
    'ANTI-VACUITY: the same space the sweep above enumerates, minus the 14 the orphan '
    + 'predicate refuses. Got ' + counts.ul.admitted);
  assert.strictEqual(counts.ul.single, 0,
    'a SINGLE-item move never needs the write — serializeBlocks() bounds the emitted '
    + 'column at the anchor\'s own depth whatever data-indent says. This is why the T7 '
    + 'fixtures could not see the write, and why RV2 is a batch. Got ' + counts.ul.single);
  assert.strictEqual(counts.ol.single, 0, 'and the same on an ordered list. Got ' + counts.ol.single);
  assert.strictEqual(counts.ul.batch, 53,
    'THE WRITE IS LOAD-BEARING: 53 batch drops on a `ul` emit different bytes without it '
    + '(the smallest is indents 0,0,1,2,1 moving {1,2} — the orphan that kept its depth '
    + 'gets ADOPTED by a block the user never touched). If this reaches 0 the write has '
    + 'become inert and RV2 has gone vacuous. Got ' + counts.ul.batch);
  assert.strictEqual(counts.ol.batch, 123,
    'and 123 on an `ol`, where the ordinal moves too. Got ' + counts.ol.batch);
}

// -- S4 Task 5: blockMoveSeamRefusal() ---------------------------------------
// The cross-boundary enumeration's whole ruling, as one pure predicate. Every
// row below is a MEASURED marked.lexer answer, not a reasoned one — the
// measurement script's outputs are quoted in each assertion message, because
// this is the function that decides whether a list gets corrupted and a
// corrupted list is not undoable.
//
// TWO SEAMS, and they get DIFFERENT rules. That asymmetry is the finding:
//
//   * the DESTINATION seam is where the block LANDS. An insertion can only
//     ever SPLIT — it cannot merge two lists — so two adjacent li that are
//     already in DIFFERENT runs stay two lists whatever is put between them.
//     MEASURED: '# Doc\n\n- a\n\n1. b\n\ntail\n' with a paragraph spliced at
//     the seam is heading | ul(1,tight) | paragraph | ol(1,tight) |
//     paragraph. So the destination narrows to SAME RUN.
//
//   * the SOURCE seam is where the block LEAVES, and a removal MERGES. It
//     cannot be narrowed at all with what the block model carries:
//       - '- a' / para / '- b'      -> '- a\n\n- b\n'     = ONE list, loose
//       - '1. a' / para / '2. b'    -> '1. a\n\n2. b\n'   = ONE list, loose
//       - '- [ ] a' / para / '- [x] b'                    = ONE list, loose
//       - '- a' / para / '  1. a1'  -> '- a\n\n  1. a1\n' = ONE list, loose
//         — and THAT one is the killer: blockmap reports BOTH items at
//         indent 0 with listType 'ul' and 'ol', i.e. different runs AND
//         different types, so every discriminator the model exposes says
//         "safe" while the file says loose === true. The 2-space prefix that
//         decides it is a RAW BYTE the block model does not carry, and the
//         client has no lexer to ask.
//     Narrowing the source seam therefore needs the run/non-run blank-line
//     rule §4.5 defers to 3.1.0. It stays wide: two li neighbours = refused.
{
  const li = (runKey) => ({ runKey: runKey });
  const none = null;
  const seam = (prev, next) => ({ prev: prev, next: next });

  // ── the source seam: WIDE, and every narrowing is refused with it ──────
  assert.strictEqual(blockMoveSeamRefusal(seam(li('r1'), li('r1')), seam(none, none)), 'source',
    'a block whose removal leaves two members of ONE run adjacent is refused');
  assert.strictEqual(blockMoveSeamRefusal(seam(li('r1'), li('r2')), seam(none, none)), 'source',
    'DIFFERENT runs at the SOURCE seam are refused TOO, and this is the assertion the '
    + 'obvious narrowing fails: measured, "- a" / para / "- b" is two runs in the model '
    + 'and ONE loose list in the file the moment the paragraph leaves');
  // The partner, on the same predicate: a source seam with only ONE li
  // neighbour is NOT refused. Without it "it returned 'source'" is satisfied
  // by a predicate that refuses everything.
  assert.strictEqual(blockMoveSeamRefusal(seam(li('r1'), none), seam(none, none)), null,
    'one li neighbour cannot merge with anything — a block at the end of the document, '
    + 'or with a paragraph on its other side, moves freely');
  assert.strictEqual(blockMoveSeamRefusal(seam(none, li('r1')), seam(none, none)), null,
    'and the mirror image');
  assert.strictEqual(blockMoveSeamRefusal(seam(none, none), seam(none, none)), null,
    'no li neighbour at either seam is the ordinary move Task 3 ships');

  // ── the destination seam: NARROWED to same-run ────────────────────────
  assert.strictEqual(blockMoveSeamRefusal(seam(none, none), seam(li('r1'), li('r1'))), 'destination',
    'splicing a foreign block between two members of ONE run turns it into two runs '
    + 'with §4.3\'s looseness trap either side of the intruder');
  assert.strictEqual(blockMoveSeamRefusal(seam(none, none), seam(li('r1'), li('r2'))), null,
    'THE NARROWING: two adjacent li of DIFFERENT runs are already two lists, and an '
    + 'insertion cannot merge them. Measured on "# Doc\\n\\n- a\\n\\n1. b\\n\\ntail\\n" '
    + '— every list tight before and after. Task 3 refused this case on purpose and '
    + 'said so; this is where it is paid back');
  assert.strictEqual(blockMoveSeamRefusal(seam(none, none), seam(li(null), li('r2'))), 'destination',
    'a runKey the DOM could not answer is treated as "same run" — an unknown seam '
    + 'refuses rather than guesses, because the guess that goes wrong is not undoable');
  assert.strictEqual(blockMoveSeamRefusal(seam(none, none), seam(li('r1'), li(null))), 'destination',
    'and the mirror image');
  assert.strictEqual(blockMoveSeamRefusal(seam(none, none), seam(li('r1'), none)), null,
    'a destination at the HEAD or the TAIL of a run has one li neighbour only — the '
    + 'block lands beside the run, not inside it');

  // ── both seams at once: the SOURCE answer wins ────────────────────────
  // The block cannot leave AT ALL, so telling the user about the destination
  // would send them to move it somewhere else — which fails the same way.
  assert.strictEqual(blockMoveSeamRefusal(seam(li('r1'), li('r2')), seam(li('r3'), li('r3'))), 'source',
    'when both seams object, the SOURCE one is reported: it is the objection that '
    + 'holds wherever the user aims next');

  // Shape tolerance — the call site builds these from possibly-absent DOM
  // neighbours, and an undefined seam must not throw on a drag.
  assert.strictEqual(blockMoveSeamRefusal(null, null), null, 'a missing seam pair is not a refusal');
  assert.strictEqual(blockMoveSeamRefusal(undefined, seam(li('r1'), li('r1'))), 'destination',
    'and a missing SOURCE seam still lets the destination be judged');
}

// -- S4 Task 6: NO SILENT RETURN IN THE DRAG PATH (spec §3.6) ---------------
// 「靜默不動作是缺陷」. Task 8 Step 0 verifies by gesture that every drag ends
// in a move or a banner; this is the guard that makes a REGRESSION of that
// invariant fail immediately instead of waiting for someone to think of the
// gesture. It is a source-presence check, and that is a weaker thing than a
// reachability proof — but the failure mode it catches is precisely a future
// task adding `if (…) return;` to one of these two functions, which is how all
// three of the silent shapes this task closed got there in the first place.
//
// EVERY silent exit must be on this list, with the reason it is allowed to be
// silent. Adding one and not listing it fails the test; changing a listed one
// into a banner fails it too and the entry is simply deleted.
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'client.js'), 'utf8');
  const lines = src.split('\n');
  const from = lines.findIndex((l) => l.indexOf('async function performBlockDrop(st)') !== -1);
  const to = lines.findIndex((l) => l.indexOf('function movedLiRangeAfterReorder(') !== -1);
  assert.ok(from > 0 && to > from,
    'PRECONDITION: both drag-path functions must be locatable by content — line numbers '
    + 'have drifted every stage, so nothing here may be pinned to one');
  const BANNER_RE = /showBanner\(|refuseStructuralListEdit\(/;
  const RETURN_RE = /(^|[^\w.])return\s*;/;
  const isCommentLine = (l) => l.trim().indexOf('//') === 0;
  // Does the banner belong to THIS exit? On the return's own line
  // (`{ refuse…; return; }`), or anywhere between it and the `{` that opens
  // the statement it stands in (the three-line block form) — with no OTHER
  // `return;` in between, because a banner above a different exit belongs to
  // that one.
  //
  // MEASURED BLIND SPOT (S4 review round, 2026-09-01). This used to scan a
  // FIXED WINDOW — the return's own line plus the two above it — so a silent
  // `return;` two lines BELOW a bannered exit read as bannered. Proved by
  // planting `const rvProbe = 1;` / `if (rvProbe > 99) return;` immediately
  // under the `if (si < 0 || sj < 0 || di < 0) { showBanner(…); return; }`
  // line: this whole file stayed green. Widening the fixed window does not
  // fix it — the same trick one line lower defeats any width — so the window
  // is the ENCLOSING STATEMENT instead, which has no width to outrun.
  //
  // Comment lines are skipped rather than scanned: they carry both braces and
  // the names of banner helpers, and either would be read as code.
  const raises = (i) => {
    if (BANNER_RE.test(lines[i])) return true;
    let depth = 0;
    for (let k = i - 1; k >= from; k--) {
      const l = lines[k];
      if (isCommentLine(l)) continue;
      depth += (l.match(/\}/g) || []).length - (l.match(/\{/g) || []).length;
      // depth < 0 means THIS line opened the block the return stands in.
      // Reading past it would start attributing somebody else's banner.
      if (depth < 0) return BANNER_RE.test(l);
      if (RETURN_RE.test(l)) return false;
      if (BANNER_RE.test(l)) return true;
    }
    return false;
  };
  const silent = [];
  for (let i = from; i < to; i++) {
    const l = lines[i];
    if (l.trim().indexOf('//') === 0) continue;
    if (!/(^|[^\w.])return\s*;/.test(l)) continue;
    if (/await performListItemDrop\(/.test(lines[i - 1] || '')) continue; // delegation, not an exit
    if (/if \(!operands\) return;/.test(l)) continue;                     // the preamble bannered already
    if (raises(i)) continue;
    silent.push(l.trim().replace(/\s+/g, ' '));
  }
  assert.deepStrictEqual(silent, [
    // Defensive only — nearestBlockDropTarget() has no null answer and
    // updateBlockDropIndicator() assigns dropTarget unconditionally, so no
    // gesture reaches this.
    'if (!target) return; // engaged but never moved onto a target — nothing to do',
    // §4.5 / Task 3's ruling: a drop where the block already is is a BYTE
    // NO-OP, not a refusal. The first home position (the destination is a
    // member of the set) …
    'if (liveDestEl && opEls.indexOf(liveDestEl) !== -1) return;',
    // … and the second (the seam immediately below the set).
    'if (!planBlockMove(lines, blocks, srcRec, destRec)) return;',
    // MEASURED reachable, and correct: two identical adjacent blocks make a
    // real move produce byte-identical text. The document after the gesture
    // IS the document before it, so a banner would report a failure the user
    // can see did not happen.
    'if (!result.op) return;',
    // The li path's own second home position …
    'if (destEl ? destEl === afterSrcEl : all[all.length - 1] === lastLiEl) return;',
    // … and reorderSpanRange()'s order-is-unchanged answer, which the two
    // home positions reach by another road.
    'if (!order) return;',
  ], 'SIX silent exits, every one of them a documented BYTE NO-OP or an '
    + 'unreachable defensive guard. Anything else in this list is §3.6\'s '
    + '「靜默不動作是缺陷」 — a drag that neither moved nor said why. Got:\n'
    + silent.map((x) => '  ' + x).join('\n'));
  // ANTI-VACUITY: the scan must actually be finding returns, or an empty
  // `silent` would pass a list that had been emptied by a broken regex.
  const allReturns = lines.slice(from, to)
    .filter((l) => /(^|[^\w.])return\s*;/.test(l) && l.trim().indexOf('//') !== 0).length;
  assert.ok(allReturns >= 20,
    'the scan must be reading the real functions: expected 20+ `return;` sites across '
    + 'performBlockDrop() and performListItemDrop(), found ' + allReturns);
  assert.ok(allReturns - silent.length >= 14,
    'and most of them must be BANNERED exits — ' + (allReturns - silent.length)
    + ' found. If this drops, the classifier above has stopped recognising banners and '
    + 'the whole guard has gone vacuous');
}

console.log('editor-client.test.js OK');
