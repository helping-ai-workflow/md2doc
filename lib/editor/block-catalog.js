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

// v3.15.0 T3: the Markdown shortcuts (spec 3.3, D3). `textBeforeCaret` is the
// paragraph's whole text in front of the caret, which must BE the marker —
// `a## ` or ` ## ` is ordinary text. A spaced marker converts on its space
// (U+0020, or the U+00A0 a contenteditable often types for a trailing one)
// whatever follows the caret; the two fence-like markers only when nothing
// does (`restIsEmpty`), since the text after them has nowhere to go.
const SPACE = '[  ]';
const SHORTCUT_RULES = [
  { re: new RegExp('^(#{1,6})' + SPACE + '$'), make: (m) => ({ kind: 'heading', depth: m[1].length }) },
  { re: new RegExp('^[-*]' + SPACE + '$'), make: () => ({ kind: 'ul' }) },
  { re: new RegExp('^(\\d{1,9})\\.' + SPACE + '$'), make: (m) => ({ kind: 'ol', start: Number(m[1]) }) },
  { re: new RegExp('^\\[ ?\\]' + SPACE + '$'), make: () => ({ kind: 'task' }) },
  { re: new RegExp('^>' + SPACE + '$'), make: () => ({ kind: 'quote' }) },
];
function matchShortcut(textBeforeCaret, restIsEmpty) {
  const t = String(textBeforeCaret);
  for (let i = 0; i < SHORTCUT_RULES.length; i++) {
    const m = SHORTCUT_RULES[i].re.exec(t);
    if (m) return SHORTCUT_RULES[i].make(m);
  }
  if (!restIsEmpty) return null;
  if (t === FENCE) return { kind: 'code' };
  if (t === '---') return { kind: 'divider' };
  return null;
}

// The lines a match writes. With nothing after the caret (`restLines` empty,
// or one empty line) it is the D5 skeleton — the same lines the "/" menu's
// item writes. Otherwise the remainder becomes the block's content, the way
// convert-md.js's emitAs() writes a conversion: a heading joins its lines
// with a space (a heading is one line), a list item puts its continuation
// lines under its marker, a quote prefixes every line.
function shortcutLines(match, restLines) {
  const rest = Array.isArray(restLines) ? restLines : [];
  const empty = rest.length === 0 || (rest.length === 1 && rest[0] === '');
  const k = match.kind;
  if (k === 'heading') {
    const hashes = '#'.repeat(match.depth);
    return [empty ? hashes : hashes + ' ' + rest.map((l) => l.trim()).join(' ').trim()];
  }
  if (k === 'code') return empty ? [FENCE, '', FENCE] : [FENCE].concat(rest, [FENCE]);
  if (k === 'divider') return ['---'];
  if (k === 'quote') return empty ? ['>'] : rest.map((l) => '> ' + l);
  const bullet = k === 'ol' ? String(match.start) + '.' : '-';
  if (empty) return [k === 'task' ? '- [ ] ' : bullet];
  const marker = (k === 'task' ? '- [ ]' : bullet) + ' ';
  const cont = ' '.repeat(bullet.length + 1);
  return [marker + rest[0]].concat(rest.slice(1).map((l) => cont + l));
}

return { SLASH_GROUPS, SLASH_ITEMS, filterSlashItems, itemById, TABLE_SKELETON, matchShortcut, shortcutLines };
});
