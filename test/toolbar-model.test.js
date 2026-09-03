'use strict';
const assert = require('assert');
const tm = require('../lib/editor/toolbar-model.js');

let checks = 0;
function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg + '\n  actual:   ' + JSON.stringify(actual) +
    '\n  expected: ' + JSON.stringify(expected));
  checks += 1;
}
function ok(cond, msg) {
  assert.ok(cond, msg);
  checks += 1;
}

// --- BUTTONS roster ----------------------------------------------------------

ok(Array.isArray(tm.BUTTONS), 'BUTTONS is an array');
eq(tm.BUTTONS.length, 22, '22 顆按鈕齊全');

const ids = tm.BUTTONS.map((b) => b.id);
eq(new Set(ids).size, ids.length, 'button ids have no duplicates');

for (const b of tm.BUTTONS) {
  ok(typeof b.id === 'string' && b.id.length > 0, 'button has string id: ' + JSON.stringify(b));
  ok(typeof b.group === 'string' && b.group.length > 0, 'button has string group: ' + b.id);
  ok(typeof b.label === 'string', 'button has string label: ' + b.id);
  ok(typeof b.icon === 'string', 'button has string icon: ' + b.id);
  ok(typeof b.title === 'string', 'button has string title: ' + b.id);
}

// BUTTONS is a frozen array, and each entry is frozen too.
ok(Object.isFrozen(tm.BUTTONS), 'BUTTONS array is frozen');
ok(tm.BUTTONS.every((b) => Object.isFrozen(b)), 'every button object is frozen');

// --- GROUPS --------------------------------------------------------------

eq(tm.GROUPS, ['history', 'block', 'inline', 'indent', 'insert', 'view'],
  'six groups, spec render order');

// GROUPS 攤平後（依 GROUPS 順序抓出屬於每個 group 的 button id）等於 BUTTONS 的 id 集合
const flattened = [];
for (const g of tm.GROUPS) {
  for (const b of tm.BUTTONS) {
    if (b.group === g) flattened.push(b.id);
  }
}
eq(new Set(flattened), new Set(ids), 'GROUPS 攤平後的 id 集合等於 BUTTONS 的 id 集合');
eq(flattened.length, ids.length, 'every button belongs to exactly one known group');

// group id set is exactly the six named groups, and every button's group is one of them
for (const b of tm.BUTTONS) {
  ok(tm.GROUPS.includes(b.group), 'button ' + b.id + ' belongs to a known group');
}

// exact roster from spec §4 table, per-group in render order
const expectedByGroup = {
  history: ['undo', 'redo'],
  block: ['headings', 'quote', 'code', 'list', 'ordered-list', 'check'],
  inline: ['bold', 'italic', 'strike', 'inline-code', 'link'],
  indent: ['outdent', 'indent'],
  insert: ['table', 'insert-before', 'insert-after', 'line', 'image'],
  view: ['outline', 'preview'],
};
for (const g of tm.GROUPS) {
  eq(tm.BUTTONS.filter((b) => b.group === g).map((b) => b.id), expectedByGroup[g],
    'group ' + g + ' roster matches spec §4 table');
}

// `export▾` was pulled out of scope (no browser-reachable export path).
ok(!ids.includes('export'), 'export is not part of the 22 (moved out of scope)');

// --- deriveState: every button gets an entry --------------------------------

function baseCtx(overrides) {
  return Object.assign({
    blockType: 'paragraph',
    indent: 0,
    headingDepth: undefined,
    inList: false,
    listOrdered: false,
    hasSelection: false,
    mode: 'edit',
  }, overrides || {});
}

{
  const state = tm.deriveState(baseCtx());
  for (const id of ids) {
    ok(Object.prototype.hasOwnProperty.call(state, id), 'deriveState entry exists for ' + id);
    ok(typeof state[id].active === 'boolean', id + '.active is boolean');
    ok(typeof state[id].disabled === 'boolean', id + '.disabled is boolean');
  }
}

// --- H2 heading block --------------------------------------------------------

{
  const state = tm.deriveState(baseCtx({ blockType: 'heading', headingDepth: 2 }));
  eq(state.headings.active, true, 'H2 block makes headings.active true');
  eq(state.headings.label, 'H2', 'H2 block sets headings.label to H2');
}

// non-heading block: headings not active, label falls back to 'H'
{
  const state = tm.deriveState(baseCtx({ blockType: 'paragraph' }));
  eq(state.headings.active, false, 'paragraph block: headings not active');
  eq(state.headings.label, 'H', 'non-heading label defaults to H');
}

// --- ordered vs unordered list -----------------------------------------------

{
  const state = tm.deriveState(baseCtx({ blockType: 'li', inList: true, listOrdered: true, indent: 1 }));
  eq(state['ordered-list'].active, true, 'ordered list: ordered-list active');
  eq(state.list.active, false, 'ordered list: list not active');
}

{
  const state = tm.deriveState(baseCtx({ blockType: 'li', inList: true, listOrdered: false, indent: 1 }));
  eq(state.list.active, true, 'unordered list: list active');
  eq(state['ordered-list'].active, false, 'unordered list: ordered-list not active');
}

// --- mode: source ------------------------------------------------------------

{
  const state = tm.deriveState(baseCtx({ mode: 'source', blockType: 'heading', headingDepth: 3 }));
  for (const id of ids) {
    if (id === 'preview') {
      eq(state.preview.disabled, false, 'preview stays enabled in source mode');
    } else {
      eq(state[id].disabled, true, id + ' is disabled in source mode');
    }
  }
}

// --- indent / outdent ---------------------------------------------------------

// not in a list: both outdent and indent disabled
{
  const state = tm.deriveState(baseCtx({ inList: false, indent: 2 }));
  eq(state.outdent.disabled, true, 'not in list: outdent disabled');
  eq(state.indent.disabled, true, 'not in list: indent disabled');
}

// in a list, indent 0: outdent disabled, indent enabled
{
  const state = tm.deriveState(baseCtx({ inList: true, indent: 0 }));
  eq(state.outdent.disabled, true, 'indent 0: outdent disabled');
  eq(state.indent.disabled, false, 'indent 0: indent (increase) still enabled');
}

// in a list, indent > 0: neither disabled
{
  const state = tm.deriveState(baseCtx({ inList: true, indent: 1 }));
  eq(state.outdent.disabled, false, 'in list, indent 1: outdent enabled');
  eq(state.indent.disabled, false, 'in list, indent 1: indent enabled');
}

// --- no block (rerenderAll zeroed state) -------------------------------------

{
  const state = tm.deriveState(baseCtx({ blockType: null }));
  const allowed = new Set(['undo', 'redo', 'outline', 'preview']);
  for (const id of ids) {
    if (allowed.has(id)) {
      eq(state[id].disabled, false, id + ' stays enabled with no block');
    } else {
      eq(state[id].disabled, true, id + ' is disabled with no block');
    }
  }
}

{
  const state = tm.deriveState(baseCtx({ blockType: undefined }));
  eq(state.bold.disabled, true, 'undefined blockType is also treated as no-block');
  eq(state.undo.disabled, false, 'undo stays enabled with undefined blockType');
}

// --- purity: no document/window/navigator reference in source --------------

{
  const src = require('fs').readFileSync(require.resolve('../lib/editor/toolbar-model.js'), 'utf8');
  ok(!/\bdocument\./.test(src), 'module source never references document.');
  ok(!/\bnavigator\./.test(src), 'module source never references navigator.');
}

console.log('toolbar-model.test.js OK (' + checks + ' checks)');
