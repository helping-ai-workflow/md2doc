const fs = require('fs');
const ico = (n) => fs.readFileSync(__dirname + '/lucide/' + n + '.svg', 'utf8').replace(/<!--[^>]*-->/, '').trim();
const ICONS = { save: 'save', undo: 'undo-2', redo: 'redo-2', headings: 'heading', quote: 'quote', code: 'code', list: 'list',
  'ordered-list': 'list-ordered', check: 'list-checks', bold: 'bold', italic: 'italic', strike: 'strikethrough', 'inline-code': 'code',
  link: 'link', outdent: 'indent-decrease', indent: 'indent-increase', table: 'table', 'insert-before': 'arrow-up-to-line',
  'insert-after': 'arrow-down-to-line', line: 'minus', image: 'image', outline: 'panel-left', preview: 'file-code-2' };
const svgMap = {}; for (const k in ICONS) svgMap[k] = ico(ICONS[k]);
const extra = { grip: ico('grip-vertical'), plus: ico('plus'), sun: ico('sun'), moon: ico('moon') };
const CSS = `
:root{--e-bar:#ffffff;--e-surface:#ffffff;--e-ring:0 0 0 1px rgba(31,35,40,.12),0 8px 24px rgba(31,35,40,.10);--e-ink:#1f2328;--e-mut:#57606a;
  --e-hover:#f3f5f7;--e-active-bg:#dbe6f3;--e-active-fg:#0550ae;--e-accent:#0969da;--e-rule:#d8dee4;--e-sel:rgba(9,105,218,.10);--e-glyph:#8c959f;--e-field:#f6f8fa}
html[data-md2doc-theme="dark"]{--e-bar:#1b1b1d;--e-surface:#2a2a2d;--e-ring:0 0 0 1px rgba(255,255,255,.10),0 8px 24px rgba(0,0,0,.55);--e-ink:#e3e3e3;--e-mut:#a3a6ab;
  --e-hover:#303134;--e-active-bg:#24364f;--e-active-fg:#a5c9f8;--e-accent:#6ea8f5;--e-rule:#38393c;--e-sel:rgba(110,168,245,.16);--e-glyph:#7d8086;--e-field:#232325}
.ed-toolbar{background:var(--e-bar)!important;border-bottom:1px solid var(--e-rule)!important;box-shadow:none!important;border-radius:0!important}
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
.ed-handle,.ed-insert{background:transparent!important;color:var(--e-glyph)!important;border-radius:4px!important}
.ed-handle:hover,.ed-insert:hover{background:var(--e-hover)!important;color:var(--e-ink)!important}
.ed-block:hover{outline:none!important}
.ed-wys-armed:focus{outline:2px solid var(--e-accent)!important;outline-offset:2px;caret-color:var(--e-accent)!important}
.ed-selected{background:var(--e-sel)!important}
.e-theme-btn svg{width:18px;height:18px;stroke-width:1.75}
`;
const FIXES = `
.ed-raw,.ed-raw textarea,textarea.ed-source{background:var(--e-field)!important;color:var(--e-ink)!important;border-color:var(--e-rule)!important}
.ed-te-grip-row,.ed-te-grip-col{background:var(--e-surface)!important;box-shadow:var(--e-ring)!important;border:0!important;color:var(--e-glyph)!important}
.ed-tb-insert{background:var(--e-surface)!important;border-color:var(--e-accent)!important;color:var(--e-accent)!important}
.ed-li-check{border-color:var(--e-glyph)!important}
`;
module.exports = { CSS, FIXES, svgMap, extra };
module.exports = { CSS, FIXES, svgMap, extra };
