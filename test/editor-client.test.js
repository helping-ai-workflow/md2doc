'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { extractBlockSource, commitEdit, withHeadingDepth } = require('../lib/editor/client.js');
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
                      'ed-bar', 'ed-selected', 'wireBlockSelection']) {
  assert.ok(src.includes(needle), `client.js must reference ${needle}`);
}
// The old hover-gutter DOM wiring must be gone (replaced by the click-bar).
assert.ok(!/ed-gutter/.test(src), 'client.js must not reference the removed .ed-gutter');
assert.ok(!/attachGutters/.test(src), 'client.js must not reference the removed attachGutters()');

// -- Ctrl+S / Ctrl+Z / Ctrl+Y / Ctrl+Enter: preventDefault() must fire
// BEFORE any async work (save()/undo()/redo()/commit() all kick off a
// fetch()), or the browser's native shortcut (e.g. the save-page dialog on
// Ctrl+S) fires alongside ours. Each regex below pins preventDefault()
// as the FIRST statement in its branch, immediately followed by the call —
// so a future edit that reorders them, or inserts awaited work first,
// breaks this assertion instead of silently regressing.
const shortcutOrderChecks = [
  [/key === 's'\)\s*\{\s*e\.preventDefault\(\);\s*save\(\);/, 'Ctrl+S must preventDefault() before save()'],
  [/key === 'z'\)\s*\{\s*e\.preventDefault\(\);\s*undo\(\);/, 'Ctrl+Z must preventDefault() before undo()'],
  [/\(e\.key === 'y' \|\| \(e\.shiftKey && e\.key === 'Z'\)\)\)\s*\{\s*e\.preventDefault\(\);\s*redo\(\);/,
    'Ctrl+Y / Ctrl+Shift+Z must preventDefault() before redo()'],
  [/e\.key === 'Enter' && \(e\.ctrlKey \|\| e\.metaKey\)\)\s*\{\s*e\.preventDefault\(\);\s*commit\(\);/,
    'Ctrl+Enter (raw-editor commit) must preventDefault() before commit()'],
  [/e\.key === 'Escape'\)\s*\{\s*e\.preventDefault\(\);\s*restore\(\);/,
    'Esc inside the raw editor must preventDefault() before restore()'],
  [/e\.key === 'Escape'\)\s*\{\s*e\.preventDefault\(\);\s*dismissBar\(\);/,
    'Esc (global, edit-bar dismiss) must preventDefault() before dismissBar()'],
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
// Phase 3 Task 1/2: history.js is now ALSO inlined by server.js (injected
// after table-md, before client — see test/editor-server.test.js) — same
// literal-</script> exposure as the other three, so it gets the same guard.
const historySrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'history.js'), 'utf8');
assert.ok(!/<\/script/i.test(src), 'client.js must not contain a literal </script sequence');
assert.ok(!/<\/script/i.test(lineopsSrc), 'lineops.js must not contain a literal </script sequence');
assert.ok(!/<\/script/i.test(inlineMdSrc), 'inline-md.js must not contain a literal </script sequence');
assert.ok(!/<\/script/i.test(tableMdSrc), 'table-md.js must not contain a literal </script sequence');
assert.ok(!/<\/script/i.test(historySrc), 'history.js must not contain a literal </script sequence');

console.log('editor-client.test.js OK');
