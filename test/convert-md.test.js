'use strict';
const assert = require('assert');
const cm = require('../lib/editor/convert-md.js');

let checks = 0;
function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg + '\n  actual:   ' + JSON.stringify(actual) +
    '\n  expected: ' + JSON.stringify(expected));
  checks += 1;
}

// --- stripMarker: every kind the menu can be opened on -----------------------

eq(cm.stripMarker(['- alpha'], 'li').content, ['alpha'], 'ul item');
eq(cm.stripMarker(['  - alpha'], 'li').content, ['alpha'], 'indented ul item keeps no indent');
eq(cm.stripMarker(['1. alpha'], 'li').content, ['alpha'], 'ol item');
eq(cm.stripMarker(['10. alpha'], 'li').content, ['alpha'], 'two-digit ol item');
eq(cm.stripMarker(['- [ ] alpha'], 'li').content, ['alpha'], 'unchecked task');
eq(cm.stripMarker(['- [x] alpha'], 'li').content, ['alpha'], 'checked task');
eq(cm.stripMarker(['1. [X] alpha'], 'li').content, ['alpha'], 'ordered checked task, capital X');
eq(cm.stripMarker(['* alpha'], 'li').content, ['alpha'], 'asterisk bullet');
eq(cm.stripMarker(['+ alpha'], 'li').content, ['alpha'], 'plus bullet');
eq(cm.stripMarker(['1) alpha'], 'li').content, ['alpha'], 'paren-delimited ordinal');

eq(cm.stripMarker(['## alpha'], 'heading').content, ['alpha'], 'atx heading');
eq(cm.stripMarker(['###### alpha'], 'heading').content, ['alpha'], 'h6');
eq(cm.stripMarker(['## alpha ##'], 'heading').content, ['alpha'], 'closed atx heading');

eq(cm.stripMarker(['> alpha'], 'blockquote').content, ['alpha'], 'blockquote');
eq(cm.stripMarker(['> alpha', '> beta'], 'blockquote').content, ['alpha', 'beta'], 'two-line quote');
eq(cm.stripMarker(['>alpha'], 'blockquote').content, ['alpha'], 'quote with no space');

eq(cm.stripMarker(['```js', 'const a = 1;', '```'], 'code').content, ['const a = 1;'],
  'fenced code drops both fences and the info string');
eq(cm.stripMarker(['```', 'a', 'b', '```'], 'code').content, ['a', 'b'], 'multi-line fenced code');
eq(cm.stripMarker(['~~~', 'a', '~~~'], 'code').content, ['a'], 'tilde fence');

eq(cm.stripMarker(['alpha'], 'paragraph').content, ['alpha'], 'paragraph is its own content');
eq(cm.stripMarker(['alpha', 'beta'], 'paragraph').content, ['alpha', 'beta'], 'two-line paragraph');

// A shape we cannot strip must say so rather than guess.
eq(cm.stripMarker(['    indented code'], 'code').ok, false, 'indented code block is not strippable');
eq(cm.stripMarker([], 'paragraph').ok, false, 'no source lines is not strippable');

// --- emitAs: every target the submenu offers --------------------------------

eq(cm.emitAs(['alpha'], 'text', {}), ['alpha'], 'to text');
eq(cm.emitAs(['alpha'], 'h1', {}), ['# alpha'], 'to h1');
eq(cm.emitAs(['alpha'], 'h6', {}), ['###### alpha'], 'to h6');
eq(cm.emitAs(['alpha'], 'ul', {}), ['- alpha'], 'to bullet list');
eq(cm.emitAs(['alpha'], 'ol', {}), ['1. alpha'], 'to ordered list');
eq(cm.emitAs(['alpha'], 'task', {}), ['- [ ] alpha'], 'to task list');
eq(cm.emitAs(['alpha'], 'quote', {}), ['> alpha'], 'to quote');
eq(cm.emitAs(['alpha'], 'code', {}), ['```', 'alpha', '```'], 'to code');

eq(cm.emitAs(['alpha', 'beta'], 'quote', {}), ['> alpha', '> beta'], 'multi-line to quote');
eq(cm.emitAs(['alpha', 'beta'], 'code', {}), ['```', 'alpha', 'beta', '```'], 'multi-line to code');

// indentPrefix is supplied by the caller, which owns the marker-width stack.
eq(cm.emitAs(['alpha'], 'ul', { indentPrefix: '  ' }), ['  - alpha'], 'indented bullet');
eq(cm.emitAs(['alpha'], 'ol', { indentPrefix: '   ', ordinal: 3 }), ['   3. alpha'], 'indented ordinal');
eq(cm.emitAs(['alpha'], 'task', { checked: true }), ['- [x] alpha'], 'checked task preserved');

// A heading cannot hold more than one line: the rest is dropped by the caller,
// so emitAs must refuse to invent a shape that re-lexes as two blocks.
eq(cm.emitAs(['alpha', 'beta'], 'h2', {}), ['## alpha beta'], 'multi-line to heading joins with a space');

// --- the target list the submenu renders ------------------------------------

eq(cm.CONVERT_TARGETS.map((t) => t.id),
  ['text', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'task', 'code', 'quote'],
  'submenu order, spec 3.2 v1 — no collapsible list in this version');
eq(cm.CONVERT_TARGETS.map((t) => t.label),
  ['文字', '標題 1', '標題 2', '標題 3', '標題 4', '標題 5', '標題 6',
   '項目符號列表', '編號列表', '待辦清單', '程式碼', '引用'],
  'submenu labels');

eq(cm.targetIsList('ul'), true, 'ul is a list target');
eq(cm.targetIsList('task'), true, 'task is a list target');
eq(cm.targetIsList('h3'), false, 'a heading is not a list target');
eq(cm.listAttrsFor('task'), { listType: 'ul', task: true }, 'task is ul x task, spec 4.1 orthogonality');
eq(cm.listAttrsFor('ol'), { listType: 'ol', task: false }, 'ol is not a task');
eq(cm.listAttrsFor('text'), null, 'text has no list attrs');

// --- round trip: strip then re-emit is identity for the same shape ----------

for (const [line, kind, target] of [
  ['- alpha', 'li', 'ul'],
  ['1. alpha', 'li', 'ol'],
  ['- [x] alpha', 'li', 'task'],
  ['## alpha', 'heading', 'h2'],
  ['> alpha', 'blockquote', 'quote'],
]) {
  const s = cm.stripMarker([line], kind);
  const opts = kind === 'li' && /\[x\]/i.test(line) ? { checked: true } : {};
  eq(cm.emitAs(s.content, target, opts), [line], 'round trip ' + line);
}

console.log('convert-md.test.js OK (' + checks + ' checks)');
