const fs = require("fs");
const ico = (n) => fs.readFileSync(__dirname + "/lucide/" + n + ".svg", "utf8").replace(/<!--[^>]*-->/, "").trim();
const ITEMS = [
  ['基本', [['type', '文字', '一般段落', ''], ['heading-1', '標題 1', '章節大標', '#'], ['heading-2', '標題 2', '小節標題', '##'], ['heading-3', '標題 3', '更小的標題', '###']]],
  ['清單', [['list', '項目符號列表', '不分先後的條列', '-'], ['list-ordered', '編號列表', '有順序的步驟', '1.'], ['square-check', '待辦清單', '可勾選的項目', '[]']]],
  ['區塊', [['quote', '引用', '引述或備註', '>'], ['square-code', '程式碼', '等寬程式碼區塊', '```'], ['minus', '分隔線', '水平分隔', '---'], ['table', '表格', '3 欄 × 2 列', ''], ['image', '圖片', '上傳或貼上圖片', '']]],
  ['圖表', [['workflow', 'Mermaid 圖', '流程圖、時序圖', ''], ['git-fork', 'Graphviz 圖', 'dot 有向圖', ''], ['activity', 'WaveDrom 波形', '時序波形，可視覺編輯', ''], ['sigma', '數學公式', 'KaTeX 區塊公式', '$$']]],
];
const svg = {}; ITEMS.forEach(([, l]) => l.forEach(([i]) => { svg[i] = ico(i); }));
const E3CSS = `
.e-slash{position:absolute;z-index:200;width:280px;max-height:372px;overflow:auto;padding:6px;border-radius:8px;background:var(--e-surface);color:var(--e-ink);box-shadow:var(--e-ring);font-size:14px}
.e-slash .grp{font-size:12px;font-weight:600;color:var(--e-mut);padding:8px 8px 4px}
.e-slash .it{display:flex;align-items:center;gap:10px;height:32px;padding:0 8px;border-radius:6px}
.e-slash .it.on{background:var(--e-hover)}
.e-slash .it svg{width:16px;height:16px;flex:none;color:var(--e-mut);stroke-width:1.75}
.e-slash .it .nm{flex:1}
.e-slash .it kbd{font:12px ui-monospace,Consolas,monospace;color:var(--e-mut)}
.e-slash.m2{width:320px}
.e-slash.m2 .it{height:48px}
.e-slash.m2 .tile{width:32px;height:32px;border-radius:6px;display:grid;place-items:center;box-shadow:0 0 0 1px var(--e-rule);background:var(--e-bar)}
.e-slash.m2 .tx{display:grid;line-height:1.3;flex:1}.e-slash.m2 .ds{font-size:12px;color:var(--e-mut)}
.e-slash .foot{border-top:1px solid var(--e-rule);margin:6px -6px -6px;padding:6px 14px;font-size:12px;color:var(--e-mut)}
.e-ph::before{content:attr(data-ph);color:var(--e-glyph);pointer-events:none}
`;
function menuHtml(kind, filter) {
  let h = '';
  for (const [g, list] of ITEMS) {
    const items = list.filter((x) => !filter || x[1].includes(filter) || x[2].includes(filter));
    if (!items.length) continue;
    h += `<div class="grp">${g}</div>`;
    for (const [i, nm, ds, k] of items) {
      h += kind === 'm1'
        ? `<div class="it">${svg[i]}<span class="nm">${nm}</span><kbd>${k}</kbd></div>`
        : `<div class="it"><span class="tile">${svg[i]}</span><span class="tx"><span>${nm}</span><span class="ds">${ds}</span></span><kbd>${k}</kbd></div>`;
    }
  }
  return h + '<div class="foot">↑↓ 選擇　Enter 插入　Esc 關閉</div>';
}
module.exports = { E3CSS, menuHtml };
