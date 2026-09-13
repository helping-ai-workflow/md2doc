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

// The 23-button roster, spec §4 table (`export▾` moved out of scope — no
// browser-reachable export path) plus the v3.4.0 §3 `save` button. Seven
// groups, in render order; group order here doubles as separator placement
// for the caller (a separator sits between consecutive groups).
const BUTTON_DEFS = [
  // file
  { id: 'save', group: 'file', label: '💾', icon: '💾', title: '儲存 (Ctrl+S)', toggle: false },

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
  { id: 'bold', group: 'inline', label: 'B', icon: 'B', title: '粗體', toggle: true },
  { id: 'italic', group: 'inline', label: 'I', icon: 'I', title: '斜體', toggle: true },
  { id: 'strike', group: 'inline', label: 'S', icon: 'S', title: '刪除線', toggle: true },
  { id: 'inline-code', group: 'inline', label: '`', icon: '`', title: '行內程式碼', toggle: true },
  { id: 'link', group: 'inline', label: '🔗', icon: '🔗', title: '連結', toggle: true },

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

const GROUPS = Object.freeze(['file', 'history', 'block', 'inline', 'indent', 'insert', 'view']);

// Buttons that stay enabled even when there is no block at all (the zeroed
// state right after rerenderAll, before any block gets focus/selection).
// v3.4.0 §3: 'save' is here because unsaved changes have nothing to do with
// where the caret is — a document can be dirty with no block focused at all.
// NOTE (ruling P2): this entry does NOT currently change save's behaviour.
// `state.save.disabled = !dirty` below runs AFTER the no-block loop that
// reads this set, so it unconditionally overwrites whatever the no-block
// loop decided for 'save' — today the two never disagree in a way that
// shows through. This entry is kept anyway because it records the intent
// ("save must not be gateable on hasBlock") independently of where the
// `!dirty` line happens to sit; if that line is ever moved above the
// no-block loop, this set becomes the only thing still enforcing it. Do not
// delete it as "dead code" without re-checking that ordering.
const NO_BLOCK_ALLOWED = new Set(['undo', 'redo', 'outline', 'preview', 'save']);

// The mark element each inline button toggles. This module cannot ask the
// DOM which marks a selection sits in, so the client measures that and hands
// the answer in as `ctx.marks` — keyed by TAG, not by button id, because
// .ed-seltb carries a U button with no counterpart in this roster and both
// toolbars are painted from one measurement. The mapping from button to tag
// has to live somewhere, and here is where the button ids are.
const MARK_TAG_BY_ID = Object.freeze({
  bold: 'STRONG',
  italic: 'EM',
  strike: 'DEL',
  'inline-code': 'CODE',
  link: 'A',
});

// The inline-format ids, read off the map above rather than retyped. The
// `hasSelection` rule below used to carry a hand-written copy of this list;
// the marks rule under it would have been a second.
const MARK_IDS = Object.freeze(Object.keys(MARK_TAG_BY_ID));

// The per-tag values `ctx.marks` may carry, and what each one means for the
// button that toggles that tag. The client's selectionMarkStates() is what
// produces them; the names are shared vocabulary, not a re-derivation.
//   'whole'   the selection lies inside one mark of that tag
//   'partial' the selection overlaps marks of that tag without lying in one
//   'none'    no mark of that tag is involved
//   'inert'   pressing the button would do nothing at all

// ctx: {blockType, indent, headingDepth, inList, listOrdered, hasSelection,
//       mode, marks}
// -> { [id]: {active: bool, mixed: bool, disabled: bool, label?: string} }
function deriveState(ctx) {
  const c = ctx || {};
  const blockType = c.blockType;
  const indent = c.indent;
  const headingDepth = c.headingDepth;
  const inList = !!c.inList;
  const listOrdered = !!c.listOrdered;
  const mode = c.mode;
  const dirty = !!c.dirty;
  const hasBlock = blockType !== null && blockType !== undefined;

  const state = {};
  for (const b of BUTTONS) {
    state[b.id] = { active: false, mixed: false, disabled: false };
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
    for (const id of MARK_IDS) {
      state[id].disabled = true;
    }
  }

  // v3.3.0 (F2): what the selection is already marked as. Before this the ctx
  // carried one boolean about the selection and nothing about its identity.
  // MEASURED on the build before this change, reading the fixed toolbar's B
  // over a selection wholly inside a <strong>, one straddling its edge, and one
  // in plain text: aria-pressed came back null on all three — the buttons were
  // `toggle: false`, so the client's aria-pressed write skipped them.
  //
  // `active` and `mixed` are separate booleans rather than one tri-state
  // because `active` is what the toggle-roster test sweeps for and what the
  // rest of this function already speaks. The client turns the pair into
  // aria-pressed true / mixed / false.
  //
  // 'inert' disables. It is NOT the same question as `hasSelection`: that one
  // asks whether the action would refuse the selection outright, this one asks
  // whether the branch the action would actually take is a no-op. A press on
  // an inert button leaves the document exactly as it was.
  const marks = c.marks;
  if (marks) {
    for (const id of MARK_IDS) {
      const m = marks[MARK_TAG_BY_ID[id]];
      state[id].active = m === 'whole';
      state[id].mixed = m === 'partial';
      if (m === 'inert') state[id].disabled = true;
    }
  }

  // v3.4.0 §3: the save button IS the save-state indicator — grey when the
  // document matches disk, lit when it does not. The truth stays
  // single-sourced: client.js's `documentIsDirty()` — since v3.4.0 batch3
  // Task 7 that is `stack.isDirty() || burstHasUncommittedEdit() ||
  // waveUnwrittenEdit` — arrives as ctx.dirty and is not recomputed here.
  // This runs before the source-mode override below so that override can
  // still give save its own exemption.
  state.save.disabled = !dirty;

  // mode 'source' is the full-document raw-source escape hatch: everything
  // is disabled except the mode button that got you there (id 'preview',
  // which in v3.2.1 is the edit <-> source toggle), since T11-2 'outline'
  // (☰), and since v3.4.0 §3 'save'. The mode button is still the ONLY way
  // back to 'edit' — that has not changed. 'outline' stays reachable because
  // it is what opens the sidebar drawer (toggleOutlineSidebar() in
  // lib/editor/client.js), and the fixed `.sidebar-toggle` button that used
  // to reach the drawer another way is hidden in edit mode entirely (see the
  // T11-2 comment in lib/md2doc.js) — a disabled ☰ here would leave source
  // mode with no way to open that drawer at all. 'save' stays reachable
  // because source mode can still hold unsaved changes (the user can type
  // into the source textarea) — see the per-button comment below for the
  // exact shape of the exemption. This override still runs last and still
  // overrides every disabled flag computed above for every other button; do
  // not narrow it for anything but these three ids.
  if (mode === 'source') {
    for (const b of BUTTONS) {
      if (b.id === 'preview' || b.id === 'outline') { state[b.id].disabled = false; continue; }
      // v3.4.0 §3: save is a third exemption, for the same shape of reason
      // outline already had one — source mode can still hold unsaved
      // changes (the user can type into the source textarea), so forcing
      // the only save button grey here would make a mode that holds
      // unsaved work with no way out of it. The exemption is from the MODE
      // forcing it grey, not from being grey — a clean document still shows
      // it disabled in source mode (see the `state.save.disabled = !dirty`
      // line above, which already ran and is left untouched here).
      if (b.id === 'save') continue;
      state[b.id].disabled = true;
    }
  }

  return state;
}

return { BUTTONS, GROUPS, MARK_TAG_BY_ID, deriveState };
});
