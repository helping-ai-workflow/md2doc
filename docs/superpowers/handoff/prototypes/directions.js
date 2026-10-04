// Prototype-only: CSS + icon swaps for E1 directions, injected into the live editor page.
const fs = require('fs');
const ico = (n) => fs.readFileSync(__dirname + '/lucide/' + n + '.svg', 'utf8').replace(/<!--[^>]*-->/, '').trim();
const ICONS = { save: 'save', undo: 'undo-2', redo: 'redo-2', headings: 'heading', quote: 'quote', code: 'code', list: 'list',
  'ordered-list': 'list-ordered', check: 'list-checks', bold: 'bold', italic: 'italic', strike: 'strikethrough', 'inline-code': 'code',
  link: 'link', outdent: 'indent-decrease', indent: 'indent-increase', table: 'table', 'insert-before': 'arrow-up-to-line',
  'insert-after': 'arrow-down-to-line', line: 'minus', image: 'image', outline: 'panel-left', preview: 'file-code-2' };
const svgMap = {}; for (const k in ICONS) svgMap[k] = ico(ICONS[k]);
const extra = { grip: ico('grip-vertical'), plus: ico('plus'), check: ico('check') };
const PAPER = `
:root{--e-surface:#ffffff;--e-ring:0 0 0 1px rgba(31,35,40,.12),0 8px 24px rgba(31,35,40,.10);--e-ink:#1f2328;--e-mut:#57606a;
  --e-hover:#f3f5f7;--e-active-bg:#dbe6f3;--e-active-fg:#0550ae;--e-accent:#0969da;--e-rule:#d8dee4}
.ed-toolbar{background:var(--e-surface)!important;border-bottom:1px solid var(--e-rule)!important;box-shadow:none!important;border-radius:0!important}
.ed-toolbar-btn{background:transparent!important;border:0!important;color:var(--e-mut)!important;width:32px!important;height:32px!important;border-radius:6px!important;display:inline-grid!important;place-items:center!important;padding:0!important}
.ed-toolbar-btn:hover{background:var(--e-hover)!important;color:var(--e-ink)!important}
.ed-toolbar-btn[aria-pressed="true"]{background:var(--e-active-bg)!important;color:var(--e-active-fg)!important}
.ed-toolbar-btn svg{width:18px;height:18px;stroke-width:1.75}
.ed-toolbar-sep{background:var(--e-rule)!important;height:20px!important;width:1px!important;margin:0 8px!important}
.ed-toolbar-status{color:var(--e-mut)!important;background:transparent!important}
.ed-handle-menu,.ed-insert-menu,.ed-seltb,.ed-te-menu,.ed-toolbar-menu{background:var(--e-surface)!important;color:var(--e-ink)!important;box-shadow:var(--e-ring)!important;border:0!important;border-radius:8px!important;backdrop-filter:none!important}
.ed-handle-menu-btn,.ed-insert-menu-btn,.ed-seltb-btn,.ed-toolbar-menu-btn,.ed-te-menu button{background:transparent!important;color:var(--e-ink)!important;border:0!important;border-radius:6px!important}
.ed-handle-menu-btn:hover,.ed-insert-menu-btn:hover,.ed-seltb-btn:hover,.ed-toolbar-menu-btn:hover,.ed-te-menu button:hover{background:var(--e-hover)!important}
.ed-seltb-btn[aria-pressed="true"]{background:var(--e-active-bg)!important;color:var(--e-active-fg)!important}
.ed-handle-menu svg,.ed-insert-menu svg{color:var(--e-mut)!important}
.ed-handle,.ed-insert{background:transparent!important;color:#8c959f!important;border-radius:4px!important}
.ed-handle:hover,.ed-insert:hover{background:#e8edf2!important;color:var(--e-ink)!important}
.ed-block:hover{outline:none!important}
.ed-wys-armed:focus{outline:2px solid var(--e-accent)!important;outline-offset:2px}
.ed-selected{background:rgba(9,105,218,.10)!important}
`;
const IMMERSIVE = PAPER + `
.ed-toolbar{left:auto!important;right:16px!important;top:12px!important;width:auto!important;height:40px!important;border:0!important;border-radius:10px!important;box-shadow:var(--e-ring)!important;padding:0 4px!important}
.ed-toolbar .ed-toolbar-btn:not([data-ed-tb="undo"]):not([data-ed-tb="redo"]):not([data-ed-tb="preview"]):not([data-ed-tb="outline"]){display:none!important}
.ed-toolbar .ed-toolbar-sep{display:none!important}
.ed-toolbar-status{position:static!important}
`;
const DARK_ICONS = `
.ed-toolbar-btn{display:inline-grid!important;place-items:center!important;padding:0!important;width:30px!important}
.ed-toolbar-btn svg{width:16px;height:16px;stroke-width:1.75}
.ed-handle,.ed-insert{color:#8c959f!important}
.ed-block:hover{outline:none!important}
`;
function apply(dir) {
  return [dir === 'A' ? DARK_ICONS : dir === 'B' ? PAPER : IMMERSIVE, svgMap, extra];
}
module.exports = { apply };
