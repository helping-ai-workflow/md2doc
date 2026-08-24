'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { extractBlockSource, commitEdit } = require('../lib/editor/client.js');
const { UndoStack } = require('../lib/editor/lineops.js');

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

// -- page wiring presence ---------------------------------------------------
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'client.js'), 'utf8');
for (const needle of ['__ED__', 'Ctrl', 'beforeunload', '/api/save',
                      '/api/render', '/api/ping', '409',
                      '__md2docInitDiagrams', 'ed-raw']) {
  assert.ok(src.includes(needle), `client.js must reference ${needle}`);
}

// -- structural guard: these sources get inlined into a `<script>...</script>`
// tag by lib/editor/server.js (see LINEOPS_SRC and clientJs in the GET
// /edit/:id handler). A literal `</script` substring anywhere in either
// source — even inside a string literal or comment — would prematurely
// close that tag in the served HTML and break the page.
const lineopsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'lineops.js'), 'utf8');
assert.ok(!/<\/script/i.test(src), 'client.js must not contain a literal </script sequence');
assert.ok(!/<\/script/i.test(lineopsSrc), 'lineops.js must not contain a literal </script sequence');

console.log('editor-client.test.js OK');
