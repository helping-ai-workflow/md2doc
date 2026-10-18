'use strict';
/* UMD, same shape as convert-md.js: `require`-able in node for the unit tests
   (test/block-catalog.test.js), and injected into the editor page as
   `window.md2docBlockCatalog` (lib/editor/server.js). Interpolated raw into a
   <script> tag, so it must never contain a closing script tag. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.md2docBlockCatalog = factory();
})(typeof self !== 'undefined' ? self : this, function () {

// v3.15.0 T1: the block catalogue behind the "/" menu (spec 3.4, decision D5).
// Pure data plus the menu's filter: no DOM, no editor state.
//
// `lines` is the source an item writes when it lands in an empty paragraph,
// measured against the renderer (ledger 2026-10-18):
//   * headings carry no trailing space (`##` lexes as an empty h2);
//   * the empty to-do is `- [ ] ` WITH its trailing space — without it the
//     item renders as a plain bullet;
//   * math is `$$` / `x^2` / `$$` — `$$` / blank / `$$` renders as two
//     paragraphs;
//   * the table is 3 columns by 2 body rows, one skeleton for "/", ＋ and the
//     toolbar alike.
// `pristine` is true when the lines carry no sample (an empty skeleton the
// user has not filled in yet; abandoned untouched, it is removed again) and
// false for the four items that insert a working sample.

const SLASH_GROUPS = [
  { id: 'basic', label: '基本' },
  { id: 'list', label: '清單' },
  { id: 'block', label: '區塊' },
  { id: 'diagram', label: '圖表' },
];

const FENCE = '\x60\x60\x60';
const TABLE_SKELETON = ['| A | B | C |', '|---|---|---|', '|  |  |  |', '|  |  |  |'];

function item(id, group, label, hint, icon, keywords, lines, kind) {
  return { id, group, label, hint, icon, keywords, lines, kind, pristine: kind !== 'fence' };
}

const SLASH_ITEMS = [
  item('text', 'basic', '文字', '', 'text', 'text paragraph p 段落', null, 'text'),
  item('h1', 'basic', '標題 1', '#', 'h1', 'h1 heading title', ['#'], 'heading'),
  item('h2', 'basic', '標題 2', '##', 'h2', 'h2 heading', ['##'], 'heading'),
  item('h3', 'basic', '標題 3', '###', 'h3', 'h3 heading', ['###'], 'heading'),
  item('ul', 'list', '項目符號列表', '-', 'ul', 'bullet ul list 清單 項目', ['-'], 'list'),
  item('ol', 'list', '編號列表', '1.', 'ol', 'ordered ol number list 編號 清單', ['1.'], 'list'),
  item('task', 'list', '待辦清單', '[]', 'task', 'todo task check checkbox 待辦', ['- [ ] '], 'list'),
  item('quote', 'block', '引用', '>', 'quote', 'quote blockquote', ['>'], 'quote'),
  item('code', 'block', '程式碼', FENCE, 'code', 'code codeblock 程式', [FENCE, '', FENCE], 'code'),
  item('divider', 'block', '分隔線', '---', 'minus', 'divider hr line rule 分隔', ['---'], 'divider'),
  item('table', 'block', '表格', '', 'table', 'table 表', TABLE_SKELETON.slice(), 'table'),
  item('image', 'block', '圖片', '', 'image', 'image img picture 圖', null, 'image'),
  item('mermaid', 'diagram', 'Mermaid 圖', '', 'mermaid', 'mermaid flowchart diagram 流程 圖',
    [FENCE + 'mermaid', 'graph TD', '  A --> B', FENCE], 'fence'),
  item('graphviz', 'diagram', 'Graphviz 圖', '', 'graphviz', 'graphviz dot graph diagram 圖',
    [FENCE + 'dot', 'digraph { a -> b }', FENCE], 'fence'),
  item('wavedrom', 'diagram', 'WaveDrom 波形', '', 'wavedrom', 'wavedrom wave timing 波形',
    [FENCE + 'wavedrom', "{ signal: [{ name: 'clk', wave: 'p....' }] }", FENCE], 'fence'),
  item('math', 'diagram', '數學公式', '$$', 'math', 'math equation latex tex 公式', ['$$', 'x^2', '$$'], 'fence'),
];

// D7: a case-insensitive PREFIX match against every whitespace-split token of
// the label and the keywords. Prefix, not substring: 「表」 must find only
// 表格, and a substring match would also hit 項目符號列表 and 編號列表.
function tokensOf(it) {
  return (it.label + ' ' + it.keywords).toLowerCase().split(/\s+/).filter(Boolean);
}
function filterSlashItems(query) {
  const q = String(query || '').toLowerCase();
  if (!q) return SLASH_ITEMS.slice();
  return SLASH_ITEMS.filter((it) => tokensOf(it).some((t) => t.indexOf(q) === 0));
}

function itemById(id) {
  for (let i = 0; i < SLASH_ITEMS.length; i++) if (SLASH_ITEMS[i].id === id) return SLASH_ITEMS[i];
  return null;
}

return { SLASH_GROUPS, SLASH_ITEMS, filterSlashItems, itemById, TABLE_SKELETON };
});
