'use strict';
/* UMD, same shape as convert-md.js / lineops.js: `require`-able in node for
   the unit tests, and injected into the editor page as
   `window.md2docToolbarModel` (lib/editor/server.js). client.js is inlined
   into the page as a plain <script>, not bundled, so a bare require(...) at
   the factory's top level would be an undefined identifier in the browser.
   This module is pure button-model arithmetic: no `document`, `window`, or
   `navigator` reference anywhere below. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.md2docToolbarModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {

// The 22-button roster, spec §4 table (`export▾` moved out of scope — no
// browser-reachable export path). Six groups, in render order; group order
// here doubles as separator placement for the caller (a separator sits
// between consecutive groups).
const BUTTON_DEFS = [
  // history
  { id: 'undo', group: 'history', label: 'Undo', icon: '↶', title: '復原 (Ctrl+Z)' },
  { id: 'redo', group: 'history', label: 'Redo', icon: '↷', title: '重做 (Ctrl+Y)' },

  // block
  { id: 'headings', group: 'block', label: 'H', icon: 'H', title: '標題' },
  { id: 'quote', group: 'block', label: '❝', icon: '❝', title: '引用' },
  { id: 'code', group: 'block', label: '</>', icon: '</>', title: '程式碼區塊' },
  { id: 'list', group: 'block', label: '•', icon: '•', title: '項目符號列表' },
  { id: 'ordered-list', group: 'block', label: '1.', icon: '1.', title: '編號列表' },
  { id: 'check', group: 'block', label: '☑', icon: '☑', title: '待辦清單' },

  // inline
  { id: 'bold', group: 'inline', label: 'B', icon: 'B', title: '粗體 (Ctrl+B)' },
  { id: 'italic', group: 'inline', label: 'I', icon: 'I', title: '斜體 (Ctrl+I)' },
  { id: 'strike', group: 'inline', label: 'S', icon: 'S', title: '刪除線' },
  { id: 'inline-code', group: 'inline', label: '`', icon: '`', title: '行內程式碼' },
  { id: 'link', group: 'inline', label: '🔗', icon: '🔗', title: '連結' },

  // indent
  { id: 'outdent', group: 'indent', label: '⇤', icon: '⇤', title: '減少縮排' },
  { id: 'indent', group: 'indent', label: '⇥', icon: '⇥', title: '增加縮排' },

  // insert
  { id: 'table', group: 'insert', label: '⊞', icon: '⊞', title: '插入表格' },
  { id: 'insert-before', group: 'insert', label: '⬆', icon: '⬆', title: '在上方插入區塊' },
  { id: 'insert-after', group: 'insert', label: '⬇', icon: '⬇', title: '在下方插入區塊' },
  { id: 'line', group: 'insert', label: '―', icon: '―', title: '插入分隔線' },
  { id: 'image', group: 'insert', label: '🖼', icon: '🖼', title: '插入圖片' },

  // view
  { id: 'outline', group: 'view', label: '☰', icon: '☰', title: '大綱' },
  { id: 'preview', group: 'view', label: '👁', icon: '👁', title: '預覽' },
];

const BUTTONS = Object.freeze(BUTTON_DEFS.map((b) => Object.freeze(Object.assign({}, b))));

const GROUPS = Object.freeze(['history', 'block', 'inline', 'indent', 'insert', 'view']);

// Buttons that stay enabled even when there is no block at all (the zeroed
// state right after rerenderAll, before any block gets focus/selection).
const NO_BLOCK_ALLOWED = new Set(['undo', 'redo', 'outline', 'preview']);

// ctx: {blockType, indent, headingDepth, inList, listOrdered, hasSelection, mode}
// -> { [id]: {active: bool, disabled: bool, label?: string} }
function deriveState(ctx) {
  const c = ctx || {};
  const blockType = c.blockType;
  const indent = c.indent;
  const headingDepth = c.headingDepth;
  const inList = !!c.inList;
  const listOrdered = !!c.listOrdered;
  const mode = c.mode;
  const hasBlock = blockType !== null && blockType !== undefined;

  const state = {};
  for (const b of BUTTONS) {
    state[b.id] = { active: false, disabled: false };
  }

  // headings: dropdown whose label tracks the current heading depth.
  state.headings.label = blockType === 'heading' ? 'H' + headingDepth : 'H';
  state.headings.active = blockType === 'heading';

  // other block-type-driven active flags
  state.quote.active = blockType === 'blockquote';
  state.code.active = blockType === 'code';

  // list vs ordered-list are mutually exclusive by construction: exactly one
  // reflects the current list's ordered-ness, the other stays inactive.
  if (inList && listOrdered) {
    state['ordered-list'].active = true;
    state.list.active = false;
  } else if (inList && !listOrdered) {
    state.list.active = true;
    state['ordered-list'].active = false;
  }

  // outdent/indent guard on list membership and current depth.
  if (!inList) {
    state.outdent.disabled = true;
    state.indent.disabled = true;
  }
  if (indent === 0) {
    state.outdent.disabled = true;
  }

  // check (task-list toggle) only makes sense inside a list item.
  if (!inList) {
    state.check.disabled = true;
  }

  // No block at all (rerenderAll's zeroed state): everything disabled except
  // the handful of buttons that don't depend on having a focused block.
  if (!hasBlock) {
    for (const b of BUTTONS) {
      if (!NO_BLOCK_ALLOWED.has(b.id)) state[b.id].disabled = true;
    }
  }

  // mode 'source' is the full-document raw-source escape hatch: everything
  // is disabled except the toggle that got you there (preview). This
  // overrides every disabled flag computed above.
  if (mode === 'source') {
    for (const b of BUTTONS) {
      state[b.id].disabled = b.id !== 'preview';
    }
  }

  return state;
}

return { BUTTONS, GROUPS, deriveState };
});
