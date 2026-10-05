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
  // v3.10.0 editor chrome. `direct`: referenced only as var(--md-<name>) in
  // the editor CSS, never by literal, so a light value that happens to equal a
  // reader literal ('#ffffff') cannot steal it — see LITERAL_TO_TOKEN below.
  { name: 'ed-chrome', light: ['#ffffff'], dark: '#1b1b1d', direct: true },
  { name: 'ed-surface', light: ['#ffffff'], dark: '#2a2a2d', direct: true },
  { name: 'ed-ring', light: ['rgba(31, 35, 40, 0.12)'], dark: 'rgba(255, 255, 255, 0.10)', direct: true },
  { name: 'ed-shadow', light: ['rgba(31, 35, 40, 0.10)'], dark: 'rgba(0, 0, 0, 0.55)', direct: true },
  { name: 'ed-hover', light: ['#f3f5f7'], dark: '#303134', direct: true },
  { name: 'ed-glyph', light: ['#8c959f'], dark: '#7d8086', direct: true },
  { name: 'ed-field', light: ['#f6f8fa'], dark: '#232325', direct: true },
  { name: 'ed-sel', light: ['rgba(9, 105, 218, 0.10)'], dark: 'rgba(110, 168, 245, 0.16)', direct: true },
  { name: 'ed-range', light: ['rgba(9, 105, 218, 0.14)'], dark: 'rgba(110, 168, 245, 0.20)', direct: true },
  { name: 'ed-err', light: ['#cf222e'], dark: '#ff8a8a', direct: true },
  { name: 'ed-err-bg', light: ['#ffebe9'], dark: '#3a2224', direct: true },
  { name: 'ed-err-ink', light: ['#82071e'], dark: '#ffc9c9', direct: true },
  { name: 'ed-ok', light: ['#1a7f37'], dark: '#6fdd8b', direct: true },
  { name: 'ed-dirty', light: ['#9a6700'], dark: '#e3b341', direct: true },
  // v3.10.0 fenced-code syntax colour (lib/highlight.js; .hljs-* rules), the
  // GitHub palette. Direct: written as var(--md-syn-*) in the CSS.
  { name: 'syn-keyword', light: ['#cf222e'], dark: '#ff7b72', direct: true },
  { name: 'syn-number', light: ['#0550ae'], dark: '#79c0ff', direct: true },
  { name: 'syn-comment', light: ['#656d76'], dark: '#8b949e', direct: true },
  { name: 'syn-string', light: ['#0a3069'], dark: '#a5d6ff', direct: true },
  { name: 'syn-type', light: ['#953800'], dark: '#ffa657', direct: true },
  { name: 'syn-title', light: ['#8250df'], dark: '#d2a8ff', direct: true },
  // v3.10.0 waveform editor (editModeLayoutCss .ed-wave-*). Literal roles: the
  // wave CSS keeps its literals and applyThemeTokens rewrites them. Every one
  // of these literals is used by no reader rule (measured 2026-10-04).
  { name: 'wave-accent', light: ['#1a73e8'], dark: '#6ea8f5' },
  { name: 'wave-rule', light: ['#e2e2e2'], dark: '#38393c' },
  { name: 'wave-ink', light: ['#111'], dark: '#e3e3e3' },
  { name: 'wave-mut', light: ['#555'], dark: '#a3a6ab' },
  { name: 'wave-edge', light: ['#0041c4'], dark: '#79b0f6' },
  { name: 'wave-strong', light: ['#222'], dark: '#f5f6f7' },
  { name: 'wave-grid', light: ['#ececec'], dark: '#303134' },
  { name: 'wave-faint', light: ['#aaa'], dark: '#7d8086' },
  { name: 'wave-text', light: ['#333'], dark: '#e3e3e3' },
  { name: 'wave-border', light: ['#bbb'], dark: '#505257' },
  { name: 'wave-border-2', light: ['#888'], dark: '#7d8086' },
  { name: 'wave-field', light: ['#f6f6f6'], dark: '#232325' },
  { name: 'wave-warn-ink', light: ['#7a4b00'], dark: '#e3b341' },
  { name: 'wave-panel', light: ['#fafafa'], dark: '#232325' },
  { name: 'wave-control', light: ['#c4c4c4'], dark: '#46484c' },
  { name: 'wave-mut-2', light: ['#666'], dark: '#a3a6ab' },
  { name: 'wave-warn-bg', light: ['#fff6e0'], dark: '#3a3020' },
  { name: 'wave-warn-line', light: ['#e8c987'], dark: '#6e5e14' },
  { name: 'wave-err-ink', light: ['#7a1f00'], dark: '#ffb4a0' },
  { name: 'wave-err-bg', light: ['#ffe9e0'], dark: '#3a2420' },
  { name: 'wave-err-line', light: ['#e8a987'], dark: '#7a3b2a' },
  { name: 'wave-sel-bg', light: ['#eaf2fe'], dark: '#24364f' },
  { name: 'wave-group-line', light: ['#d8d8d8'], dark: '#46484c' },
  { name: 'wave-group-bg', light: ['#f2f2f2'], dark: '#2a2a2d' },
  { name: 'wave-x', light: ['#d9d9d9'], dark: '#505257' },
  { name: 'wave-bus', light: ['#f5e9c8'], dark: '#4a4128' },
  { name: 'wave-bus-3', light: ['#d8ead3'], dark: '#2f4a2b' },
  { name: 'wave-bus-4', light: ['#d6e4f7'], dark: '#26384f' },
  { name: 'wave-bus-5', light: ['#f7d6e4'], dark: '#4a2c3a' },
  { name: 'wave-cursor', light: ['#d93025'], dark: '#ff8a8a' },
  { name: 'wave-status', light: ['#444'], dark: '#a3a6ab' },
  { name: 'wave-caption', light: ['#8a8a8a'], dark: '#a3a6ab' },
  // .ed-wave-parse-message's red (the .ed-conflict banner used it too until
  // v3.10.0 moved the banner onto the direct ed-err-* roles).
  { name: 'wave-err', light: ['#b00020'], dark: '#ff8a8a' },
];

// Literals in reader rules that deliberately stay literal. Measured on real
// output (mac-tx-core design doc, 2026-10-02): '#000' is the TOC edge-fade
// mask (alpha only, never painted); '#dbeafe' is the draw.io sheet-bar
// pressed button, which sits inside the white draw.io plate in dark.
const KEEP_LITERALS = ['#000', '#dbeafe'];

// Content links: today they use the browser default, which stays in light.
const LINK_DARK = '#79b0f6';

// Rules whose literals stay literal: the lightbox, which is a dark overlay
// already. v3.10.0: the editor's own UI is themed (it used to be skipped).
const SKIP_SELECTOR = /(^|[\s,>+~(])\.lightbox/;

// rgba() literals the editor CSS keeps on purpose (normalised, no spaces).
// Scrims and shadows are translucent black and work on both grounds; the
// wave selection is a translucent blue. Anything else in an .ed- rule must be
// a var() role — test/reader-design.test.js enforces it.
const KEEP_RGBA = ['rgba(0,0,0,.35)', 'rgba(0,0,0,.45)', 'rgba(26,115,232,.18)'];

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
for (const t of THEME_TOKENS) if (!t.direct) for (const l of t.light) LITERAL_TO_TOKEN.set(l, t.name);

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
    '    ' + D + ' .content img { background: #ffffff; border-radius: 4px; box-shadow: 0 0 0 10px #ffffff; }',
    '    ' + D + ' .content .drawio { background: #ffffff; border-radius: 6px; box-shadow: 0 0 0 10px #ffffff; }',
    '    ' + D + ' .lightbox-canvas > svg[data-md2doc-recoloured] { background: var(--md-bg); }',
    '  }',
    '  .md2doc-theme-toggle { position: fixed; right: 20px; bottom: 20px; z-index: 60; width: 40px; height: 40px;',
    '    border-radius: 50%; display: grid; place-items: center; padding: 0; font-size: 18px; line-height: 1;',
    '    cursor: pointer; border: 1px solid var(--md-border); background: var(--md-bg); color: var(--md-strong);',
    '    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18); }',
    '  .md2doc-theme-toggle[hidden] { display: none; }',
    '  .md2doc-theme-toggle:hover { background: var(--md-hover); }',
    '  .md2doc-theme-toggle:focus-visible { outline: 2px solid var(--md-accent); outline-offset: 2px; }',
    '  .mobile-bar .md2doc-theme-toggle { position: static; margin-left: auto; flex: 0 0 auto; width: 36px; height: 36px;',
    '    box-shadow: none; font-size: 17px; }',
    '  @media print { .md2doc-theme-toggle { display: none !important; } }',
  ].join('\n');
}


// Runs before any stylesheet, so a saved dark choice never flashes light.
const EARLY_SCRIPT = "<script>try{if(localStorage.getItem('md2doc-theme')==='dark')document.documentElement.setAttribute('data-md2doc-theme','dark');}catch(e){}</script>";
const TOGGLE_HTML = '<button type="button" class="md2doc-theme-toggle" hidden id="md2doc-theme-toggle" aria-label="Light theme (click for dark)" title="Light theme (click for dark)">☀</button>';
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
  if (head < 0) throw new Error('applyReaderTheme: <head> not found');
  out = out.slice(0, head + 7) + EARLY_SCRIPT + '\n' + out.slice(head + 7);
  // lastIndexOf: inlined diagram libraries carry '</body>' inside strings.
  const bodyEnd = out.lastIndexOf('</body>');
  if (bodyEnd < 0) throw new Error('applyReaderTheme: </body> not found');
  const data = JSON.stringify({ mermaidLight: MERMAID_LIGHT_VARS, mermaidDark: MERMAID_DARK_VARS });
  return out.slice(0, bodyEnd) + TOGGLE_HTML + '\n<script id="md2doc-theme-data" type="application/json">' + data +
    '</script>\n<script>\n' + RUNTIME_JS + '\n</script>\n' + out.slice(bodyEnd);
}

module.exports = {
  THEME_TOKENS, KEEP_LITERALS, KEEP_RGBA, LINK_DARK, MERMAID_LIGHT_VARS, MERMAID_DARK_VARS,
  applyThemeTokens, themeCss, applyReaderTheme,
};
