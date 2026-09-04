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

// --- preview.active tracks mode (tri-state edit/source/preview) -------------
// Fix round 1, Important: the module threads `mode` into ctx precisely so it
// can answer "which of the three modes is current" for its own button,
// instead of making the integration task re-derive this outside the module.
// Ruling: active is true whenever mode !== 'edit'.

{
  const state = tm.deriveState(baseCtx({ mode: 'edit' }));
  eq(state.preview.active, false, "mode 'edit': preview.active is false");
}
{
  const state = tm.deriveState(baseCtx({ mode: 'preview' }));
  eq(state.preview.active, true, "mode 'preview': preview.active is true");
}
{
  const state = tm.deriveState(baseCtx({ mode: 'source' }));
  eq(state.preview.active, true, "mode 'source': preview.active is true");
  // The pre-existing source-mode rule must not regress: preview stays
  // enabled even though it's now also active.
  eq(state.preview.disabled, false, "mode 'source': preview still stays enabled");
}

// --- fix round 1, Minor: bold/italic tooltips must not promise keybindings --
// that don't exist. client.js only wires Ctrl+Z / Ctrl+Y / Ctrl+Enter /
// Ctrl+S. undo/redo name real bindings and keep them; bold/italic don't.

{
  const bold = tm.BUTTONS.find((b) => b.id === 'bold');
  const italic = tm.BUTTONS.find((b) => b.id === 'italic');
  eq(bold.title, '粗體', 'bold title carries no shortcut hint');
  eq(italic.title, '斜體', 'italic title carries no shortcut hint');
  ok(!/Ctrl/i.test(bold.title), 'bold title never mentions Ctrl');
  ok(!/Ctrl/i.test(italic.title), 'italic title never mentions Ctrl');

  const undo = tm.BUTTONS.find((b) => b.id === 'undo');
  const redo = tm.BUTTONS.find((b) => b.id === 'redo');
  ok(/Ctrl\+Z/i.test(undo.title), 'undo title still names its real Ctrl+Z binding');
  ok(/Ctrl\+Y/i.test(redo.title), 'redo title still names its real Ctrl+Y binding');
}

// --- fix round 1, Minor: check is a block-group conversion target, not -----
// gated on already being in a list (that made it dead for the primary case:
// converting a bare paragraph into a task-list item). It follows the same
// rule as its block-group siblings quote/code/list/ordered-list — no extra
// gate beyond the shared no-block / source-mode rules.

{
  const state = tm.deriveState(baseCtx({ blockType: 'paragraph', inList: false }));
  eq(state.check.disabled, false, 'check is enabled on a bare paragraph, not gated on inList');
  eq(state.quote.disabled, false, "check's block-group sibling quote is enabled too, for comparison");
}
{
  const state = tm.deriveState(baseCtx({ blockType: 'li', inList: true, listOrdered: true, indent: 1 }));
  eq(state.check.disabled, false, 'check stays enabled inside a list too');
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

// v3.2.0: hasSelection 真的被讀取（v3.1.0 只收不讀）
{
  const base = { blockType: 'paragraph', indent: 0, headingDepth: 1,
                 inList: false, listOrdered: false, mode: 'edit' };
  const withSel = tm.deriveState(Object.assign({}, base, { hasSelection: true }));
  const noSel = tm.deriveState(Object.assign({}, base, { hasSelection: false }));
  for (const id of ['bold', 'italic', 'strike', 'inline-code', 'link']) {
    assert.strictEqual(withSel[id].disabled, false, id + ' 有選取時 enabled');
    assert.strictEqual(noSel[id].disabled, true, id + ' 沒選取時 disabled');
  }
  // 非行內格式鈕不受 hasSelection 影響
  assert.strictEqual(withSel.quote.disabled, noSel.quote.disabled,
    'quote 不隨 hasSelection 改變');
}

// v3.2.0: toggle 欄位存在，且恰好標在 deriveState 會設 active 的那些鈕上
{
  const toggles = tm.BUTTONS.filter((b) => b.toggle).map((b) => b.id).sort();
  assert.deepStrictEqual(
    toggles,
    ['code', 'headings', 'list', 'ordered-list', 'preview', 'quote'],
    'toggle 欄位必須與 deriveState 會設 active 的集合一致');
  assert.strictEqual(tm.BUTTONS.every((b) => typeof b.toggle === 'boolean'), true,
    '每顆按鈕都要有 toggle 欄位（不得 undefined）');
}

console.log('toolbar-model.test.js OK (' + checks + ' checks)');
