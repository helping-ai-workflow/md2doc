'use strict';
const fs = require('fs');
const path = require('path');
// v3.9.0 dark mode: the reader's colour table and the CSS that applies it.
// Spec: docs/superpowers/specs/2026-10-02-dark-mode-design.md
//
// applyReaderTheme() (added in Task 2) hands the reader <style> block to
// applyThemeTokens(). Every colour literal that has a role below becomes
// var(--md-<name>), and :root defines each var as that SAME literal, so light
// rendering is exactly what it was. Dark redefines the vars inside
// @media screen only, which is what keeps print light.

const THEME_TOKENS = [
  { name: 'bg', light: ['#ffffff', '#fff'], dark: '#1b1b1d' },
  { name: 'panel', light: ['#f3f5f7'], dark: '#232325' },
  { name: 'surface', light: ['#f6f8fa'], dark: '#2a2a2d' },
  { name: 'surface-2', light: ['#fafbfc'], dark: '#2a2a2d' },
  { name: 'fg', light: ['#24292e'], dark: '#e3e3e3' },
  { name: 'strong', light: ['#1f2328'], dark: '#f5f6f7' },
  { name: 'muted', light: ['#57606a'], dark: '#a3a6ab' },
  { name: 'muted-2', light: ['#59636e'], dark: '#a3a6ab' },
  { name: 'subtle', light: ['#6a737d'], dark: '#a3a6ab' },
  { name: 'rule', light: ['#e1e4e8'], dark: '#38393c' },
  { name: 'rule-2', light: ['#d8dee4'], dark: '#38393c' },
  { name: 'rule-3', light: ['#dfe2e5'], dark: '#38393c' },
  { name: 'rule-strong', light: ['#c9ced4'], dark: '#505257' },
  { name: 'border', light: ['#d0d7de'], dark: '#46484c' },
  { name: 'hover', light: ['#e3e8ee'], dark: '#303134' },
  { name: 'hover-2', light: ['#e8edf2'], dark: '#303134' },
  { name: 'hover-3', light: ['#eef2f6'], dark: '#303134' },
  { name: 'accent', light: ['#0969da'], dark: '#6ea8f5' },
  { name: 'active-fg', light: ['#0550ae'], dark: '#a5c9f8' },
  { name: 'active-fg-2', light: ['#0b57d0'], dark: '#a5c9f8' },
  { name: 'active-bg', light: ['#dbe6f3'], dark: '#24364f' },
  { name: 'hit-bg', light: ['#fff5c2'], dark: '#4d4417' },
  { name: 'mark-bg', light: ['#fde68a'], dark: '#6e5e14' },
  { name: 'code', light: ['#b93a0c'], dark: '#ff9f70' },
  { name: 'accent-soft', light: ['#93c5fd'], dark: '#6ea8f5' },
  { name: 'error', light: ['#b91c1c'], dark: '#ff8a8a' },
];

// Literals in reader rules that deliberately stay literal. Measured on real
// output (mac-tx-core design doc, 2026-10-02): '#000' is the TOC edge-fade
// mask (alpha only, never painted); '#dbeafe' is the draw.io sheet-bar
// pressed button, which sits inside the white draw.io plate in dark.
const KEEP_LITERALS = ['#000', '#dbeafe'];

// Content links: today they use the browser default, which stays in light.
const LINK_DARK = '#79b0f6';

// Rules whose literals stay literal: the editor's own UI (edit mode is light
// only) and the lightbox, which is a dark overlay already.
const SKIP_SELECTOR = /(^|[\s,>+~(])(html\.ed-|\.ed-|\.lightbox)/;

const MERMAID_LIGHT_VARS = {
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, "Microsoft JhengHei", sans-serif',
  primaryColor: '#eaf2fd', primaryBorderColor: '#0969da', primaryTextColor: '#1f2328', lineColor: '#57606a',
  secondaryColor: '#f6f8fa', tertiaryColor: '#ffffff', edgeLabelBackground: '#ffffff',
};
const MERMAID_DARK_VARS = Object.assign({}, MERMAID_LIGHT_VARS, {
  primaryColor: '#24364f', primaryBorderColor: '#6ea8f5', primaryTextColor: '#f5f6f7', lineColor: '#a3a6ab',
  secondaryColor: '#2a2a2d', tertiaryColor: '#1b1b1d', edgeLabelBackground: '#1b1b1d',
});

const LITERAL_TO_TOKEN = new Map();
for (const t of THEME_TOKENS) for (const l of t.light) LITERAL_TO_TOKEN.set(l, t.name);

// Line-based on purpose: the reader CSS is one declaration per line or one
// rule per line, and a line-based pass leaves comment prose (which names
// colours) alone. `selector` is the text before the last '{' seen.
function applyThemeTokens(css) {
  let selector = '';
  return css.split('\n').map((line) => {
    const brace = line.indexOf('{');
    if (brace !== -1) selector = line.slice(0, brace);
    if (/^\s*(\/\*|\*)/.test(line)) return line;
    if (SKIP_SELECTOR.test(selector)) return line;
    return line.replace(/#[0-9a-fA-F]{3,6}\b/g, (m) => {
      const name = LITERAL_TO_TOKEN.get(m.toLowerCase());
      return name ? 'var(--md-' + name + ')' : m;
    });
  }).join('\n');
}

function themeCss() {
  const D = ':root[data-md2doc-theme="dark"]';
  const light = THEME_TOKENS.map((t) => '--md-' + t.name + ': ' + t.light[0] + ';').join(' ');
  const dark = THEME_TOKENS.map((t) => '--md-' + t.name + ': ' + t.dark + ';').join(' ');
  return [
    '  /* v3.9.0 dark mode (lib/theme/tokens.js). Light values are the literals they replace. */',
    '  :root { ' + light + ' }',
    '  @media screen {',
    '    ' + D + ' { ' + dark + ' color-scheme: dark; }',
    '    ' + D + ' .content a:not(.heading-anchor), ' + D + ' .content a:not(.heading-anchor):visited { color: ' + LINK_DARK + '; }',
    '    ' + D + ' .content img { background: #ffffff; border-radius: 6px; padding: 10px; box-sizing: content-box; }',
    '    ' + D + ' .content .drawio { background: #ffffff; border-radius: 6px; padding: 10px; box-sizing: border-box; }',
    '    ' + D + ' .lightbox-canvas > svg[data-md2doc-recoloured] { background: var(--md-bg); }',
    '  }',
    '  .md2doc-theme-toggle { position: fixed; right: 20px; bottom: 20px; z-index: 60; width: 40px; height: 40px;',
    '    border-radius: 50%; display: grid; place-items: center; padding: 0; font-size: 18px; line-height: 1;',
    '    cursor: pointer; border: 1px solid var(--md-border); background: var(--md-bg); color: var(--md-strong);',
    '    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18); }',
    '  .md2doc-theme-toggle:hover { background: var(--md-hover); }',
    '  .md2doc-theme-toggle:focus-visible { outline: 2px solid var(--md-accent); outline-offset: 2px; }',
    '  .mobile-bar .md2doc-theme-toggle { position: static; margin-left: auto; flex: 0 0 auto; width: 36px; height: 36px;',
    '    box-shadow: none; font-size: 17px; }',
    '  @media print { .md2doc-theme-toggle { display: none !important; } }',
  ].join('\n');
}


// Runs before any stylesheet, so a saved dark choice never flashes light.
const EARLY_SCRIPT = "<script>try{if(localStorage.getItem('md2doc-theme')==='dark')document.documentElement.setAttribute('data-md2doc-theme','dark');}catch(e){}</script>";
const TOGGLE_HTML = '<button type="button" class="md2doc-theme-toggle" id="md2doc-theme-toggle" aria-label="淺色（點一下切換到深色）" title="淺色（點一下切換到深色）">☀</button>';
const RUNTIME_JS = fs.readFileSync(path.join(__dirname, 'runtime.js'), 'utf8');

// The reader <style> is the first one after </title>; KaTeX's own <style>
// comes after it, so "last </style> before </head>" is the wrong anchor here.
function applyReaderTheme(html) {
  const titleEnd = html.indexOf('</title>');
  const start = titleEnd < 0 ? -1 : html.indexOf('<style>', titleEnd);
  const end = start < 0 ? -1 : html.indexOf('</style>', start);
  if (end < 0) throw new Error('applyReaderTheme: reader <style> block not found');
  let out = html.slice(0, start) + applyThemeTokens(html.slice(start, end)) + '\n' + themeCss() + '\n' + html.slice(end);
  const head = out.indexOf('<head>\n');
  out = out.slice(0, head + 7) + EARLY_SCRIPT + '\n' + out.slice(head + 7);
  // lastIndexOf: inlined diagram libraries carry '</body>' inside strings.
  const bodyEnd = out.lastIndexOf('</body>');
  const data = JSON.stringify({ mermaidLight: MERMAID_LIGHT_VARS, mermaidDark: MERMAID_DARK_VARS });
  return out.slice(0, bodyEnd) + TOGGLE_HTML + '\n<script id="md2doc-theme-data" type="application/json">' + data +
    '</script>\n<script>\n' + RUNTIME_JS + '\n</script>\n' + out.slice(bodyEnd);
}

module.exports = {
  THEME_TOKENS, KEEP_LITERALS, LINK_DARK, MERMAID_LIGHT_VARS, MERMAID_DARK_VARS,
  applyThemeTokens, themeCss, applyReaderTheme,
};
