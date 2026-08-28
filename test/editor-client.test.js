'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { extractBlockSource, commitEdit, commitListBlockRemoval, commitBlockInsertion, withHeadingDepth, commitRangeEdit } = require('../lib/editor/client.js');
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
  assert.strictEqual(setTrueSites.length, 3,
    'expected exactly 3 suppressTableFocusout = true sites: tableBurstUndo and tableBurstRedo ' +
    '(each guarding `tableEl.innerHTML = state`), plus performRowDrop\'s rebuildTableSections() ' +
    'call (Task 6 — a row drop is a pure move, so the thead/tbody rebuild detaches the cell that ' +
    'currently holds focus and Chromium fires a synchronous focusout mid-mutation, exactly the ' +
    'quirk the other two guard) — if a new site is ever added, update this count deliberately and ' +
    'audit it for the same guard');
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

console.log('editor-client.test.js OK');
