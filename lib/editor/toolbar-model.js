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
  { id: 'undo', group: 'history', label: 'Undo', icon: '↶', title: '復原 (Ctrl+Z)', toggle: false },
  { id: 'redo', group: 'history', label: 'Redo', icon: '↷', title: '重做 (Ctrl+Y)', toggle: false },

  // block
  { id: 'headings', group: 'block', label: 'H', icon: 'H', title: '標題', toggle: true },
  { id: 'quote', group: 'block', label: '❝', icon: '❝', title: '引用', toggle: true },
  { id: 'code', group: 'block', label: '</>', icon: '</>', title: '程式碼區塊', toggle: true },
  { id: 'list', group: 'block', label: '•', icon: '•', title: '項目符號列表', toggle: true },
  { id: 'ordered-list', group: 'block', label: '1.', icon: '1.', title: '編號列表', toggle: true },
  { id: 'check', group: 'block', label: '☑', icon: '☑', title: '待辦清單', toggle: false },

  // inline
  { id: 'bold', group: 'inline', label: 'B', icon: 'B', title: '粗體', toggle: false },
  { id: 'italic', group: 'inline', label: 'I', icon: 'I', title: '斜體', toggle: false },
  { id: 'strike', group: 'inline', label: 'S', icon: 'S', title: '刪除線', toggle: false },
  { id: 'inline-code', group: 'inline', label: '`', icon: '`', title: '行內程式碼', toggle: false },
  { id: 'link', group: 'inline', label: '🔗', icon: '🔗', title: '連結', toggle: false },

  // indent
  { id: 'outdent', group: 'indent', label: '⇤', icon: '⇤', title: '減少縮排', toggle: false },
  { id: 'indent', group: 'indent', label: '⇥', icon: '⇥', title: '增加縮排', toggle: false },

  // insert
  { id: 'table', group: 'insert', label: '⊞', icon: '⊞', title: '插入表格', toggle: false },
  { id: 'insert-before', group: 'insert', label: '⬆', icon: '⬆', title: '在上方插入區塊', toggle: false },
  { id: 'insert-after', group: 'insert', label: '⬇', icon: '⬇', title: '在下方插入區塊', toggle: false },
  { id: 'line', group: 'insert', label: '―', icon: '―', title: '插入分隔線', toggle: false },
  { id: 'image', group: 'insert', label: '🖼', icon: '🖼', title: '插入圖片', toggle: false },

  // view
  { id: 'outline', group: 'view', label: '☰', icon: '☰', title: '大綱', toggle: false },
  // v3.2.1: 這顆是 edit <-> source 的兩態切換（preview 模式已移除）。id 保留
  // 為 'preview' 是刻意的 —— 每一支選擇器、journey 案例與 runtime 測試都指名
  // 它，改名只換得一個更好聽的字串。label / title 不是烘死值：deriveState()
  // 每次都依當前 mode 覆寫成【下一個】狀態的名字，這裡的值只是 edit 模式的
  // 起始值。toggle: false —— 兩態下 aria-pressed 講不出真話（按鈕講的是去處，
  // 不是目前所在），真話由會變的 label / title 承擔。
  { id: 'preview', group: 'view', label: 'M↓', icon: 'M↓', title: '切換到原始碼模式', toggle: false },
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

  // v3.2.1: the mode button names the NEXT state, never the current one.
  // Under the old tri-state cycle it was permanently labelled 「預覽」 and
  // reported aria-pressed=true in BOTH non-edit modes, so pressing it twice
  // landed in source with no grips and an interface that said nothing about
  // where you were — the reported "stuck" defect. It carries no `active`
  // now: with two states the honest signal is the label, and the current
  // mode is spelled out in .ed-toolbar-status by the client.
  // It stays enabled in source mode via the mode==='source' override below
  // (do not gate this on inList/hasBlock — it is the escape hatch OUT of
  // those states).
  state.preview.label = mode === 'source' ? '✎' : 'M↓';
  state.preview.title = mode === 'source' ? '切換到編輯模式' : '切換到原始碼模式';

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

  // check is a `block`-group conversion target, same as quote/code/list/
  // ordered-list: it turns the CURRENT block into a task-list item, so it is
  // not gated on already being in a list — a bare paragraph is exactly the
  // primary case (spec review ruling: gating it on inList made it dead for
  // that case).

  // No block at all (rerenderAll's zeroed state): everything disabled except
  // the handful of buttons that don't depend on having a focused block.
  if (!hasBlock) {
    for (const b of BUTTONS) {
      if (!NO_BLOCK_ALLOWED.has(b.id)) state[b.id].disabled = true;
    }
  }

  // v3.2.0: the five inline-format buttons are dead unless there is a
  // non-collapsed selection INSIDE the burst's own edit surface.
  // applyMarkToggle() (client.js, `function applyMarkToggle`) and
  // applyLinkToggle() (just below it) both return immediately when the root
  // is null, when there is no range, when the range is collapsed, or when
  // either of its containers lies outside that root — `link` included (it
  // does not even open the prompt).
  //
  // `hasSelection` is that whole four-part refusal test, computed once on the
  // client as hasFormattableSelection() and handed in here — so "no button is
  // enabled that the action would silently refuse" holds for these five. It
  // is NOT a claim about the model as a whole: every other enablement rule
  // below is derived from the block record, and a runtime action can still
  // refuse for reasons this ctx does not carry (a structural list gate, a
  // block that owns no source line).
  if (!c.hasSelection) {
    for (const id of ['bold', 'italic', 'strike', 'inline-code', 'link']) {
      state[id].disabled = true;
    }
  }

  // mode 'source' is the full-document raw-source escape hatch: everything
  // is disabled except the mode button that got you there (id 'preview',
  // which in v3.2.1 is the edit <-> source toggle). This overrides every
  // disabled flag computed above, and is the ONLY way back out — do not
  // narrow it.
  if (mode === 'source') {
    for (const b of BUTTONS) {
      state[b.id].disabled = b.id !== 'preview';
    }
  }

  return state;
}

return { BUTTONS, GROUPS, deriveState };
});
