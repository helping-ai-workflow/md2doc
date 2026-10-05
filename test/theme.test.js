#!/usr/bin/env node
'use strict';

// v3.9.0 dark mode — the token table and the CSS rewrite, without a browser.
// Spec: docs/superpowers/specs/2026-10-02-dark-mode-design.md

const assert = require('assert');
const T = require('../lib/theme/tokens.js');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const dark = (name) => T.THEME_TOKENS.find((t) => t.name === name).dark;

check('every token has a name and well-formed light/dark values (direct roles may use rgba)', () => {
  const names = new Set();
  for (const t of T.THEME_TOKENS) {
    assert.match(t.name, /^[a-z0-9-]+$/);
    assert.ok(!names.has(t.name), 'duplicate token ' + t.name);
    names.add(t.name);
    assert.ok(t.light.length >= 1);
    const COLOUR = t.direct ? /^(#([0-9a-f]{3}|[0-9a-f]{6})|rgba\(\d+, \d+, \d+, (0|1|0?\.\d+)\))$/ : /^#([0-9a-f]{3}|[0-9a-f]{6})$/;
    for (const l of t.light) assert.match(l, COLOUR, t.name);
    assert.match(t.dark, t.direct ? COLOUR : /^#[0-9a-f]{6}$/, t.name);
  }
});
check('a light literal belongs to one token only', () => {
  const seen = new Map();
  for (const t of T.THEME_TOKENS) if (!t.direct) for (const l of t.light) {
    assert.ok(!seen.has(l), l + ' is in both ' + seen.get(l) + ' and ' + t.name);
    seen.set(l, t.name);
  }
});
check('direct roles never claim a reader literal', () => {
  const direct = T.THEME_TOKENS.filter((t) => t.direct);
  assert.ok(direct.length > 0, 'guard: at least one direct role exists');
  // '#ffffff' is ed-chrome's light value too; it must still rewrite to bg.
  const out = T.applyThemeTokens('  .x {\n    background: #ffffff;\n  }');
  assert.ok(out.includes('var(--md-bg)'), 'reader #ffffff still maps to bg: ' + out);
  for (const t of direct) assert.ok(/^(ed|syn)-/.test(t.name), 'direct role names start ed- or syn-: ' + t.name);
});
check('applyThemeTokens rewrites a role literal and leaves an unknown one alone', () => {
  const out = T.applyThemeTokens('  body {\n    color: #24292e;\n    background: #FFFFFF;\n    border-color: #123456;\n  }');
  assert.match(out, /color: var\(--md-fg\);/);
  assert.match(out, /background: var\(--md-bg\);/);
  assert.match(out, /border-color: #123456;/);
});
check('applyThemeTokens rewrites editor rules and leaves lightbox rules literal', () => {
  const ed = T.applyThemeTokens('  .ed-wave-panel { background: #fff; color: #111; }');
  assert.strictEqual(ed, '  .ed-wave-panel { background: var(--md-bg); color: var(--md-wave-ink); }');
  const lb = '  .lightbox-canvas > * {\n    background: #ffffff;\n  }';
  assert.strictEqual(T.applyThemeTokens(lb), lb);
});
check('applyThemeTokens does not touch comment prose', () => {
  const css = '  /* the old #24292e grey */\n   * #ffffff in a wrapped comment line\n';
  assert.strictEqual(T.applyThemeTokens(css), css);
});
check('themeCss declares every token in light on :root and in dark under @media screen', () => {
  const css = T.themeCss();
  for (const t of T.THEME_TOKENS) {
    assert.ok(css.includes('--md-' + t.name + ': ' + t.light[0] + ';'), 'light ' + t.name);
    assert.ok(css.includes('--md-' + t.name + ': ' + t.dark + ';'), 'dark ' + t.name);
  }
  const screen = css.indexOf('@media screen');
  assert.ok(screen > -1 && css.indexOf(':root[data-md2doc-theme="dark"]') > screen, 'dark block sits inside @media screen');
  assert.ok(!/data-theme=/.test(css.replace(/data-md2doc-theme=/g, '')), 'never data-theme');
});
check('dark palette meets the spec contrast table (text >= 4.5, focus ring >= 3)', () => {
  const pairs = [
    ['fg', 'bg', 4.5], ['fg', 'panel', 4.5], ['strong', 'bg', 4.5], ['muted', 'bg', 4.5], ['muted', 'panel', 4.5],
    ['syn-keyword', 'surface', 4.5], ['syn-number', 'surface', 4.5], ['syn-comment', 'surface', 4.5],
    ['syn-string', 'surface', 4.5], ['syn-type', 'surface', 4.5], ['syn-title', 'surface', 4.5],
    ['code', 'bg', 4.5], ['code', 'surface', 4.5], ['active-fg', 'active-bg', 4.5], ['fg', 'hit-bg', 4.5],
    ['fg', 'mark-bg', 4.5], ['accent', 'panel', 3],
    ['strong', 'ed-surface', 4.5], ['muted', 'ed-chrome', 4.5], ['muted', 'ed-surface', 4.5],
    ['ed-err-ink', 'ed-err-bg', 4.5], ['active-fg', 'active-bg', 4.5],
    ['accent', 'ed-chrome', 3], ['ed-ok', 'ed-chrome', 3], ['ed-dirty', 'ed-chrome', 3], ['ed-glyph', 'ed-chrome', 3],
  ];
  for (const [a, b, min] of pairs) {
    const r = contrast(dark(a), dark(b));
    assert.ok(r >= min, a + ' on ' + b + ' = ' + r.toFixed(2) + ' < ' + min);
  }
  assert.ok(contrast(T.LINK_DARK, dark('bg')) >= 4.5, 'link on bg');
  // v3.10.0: the syntax colours have to read in LIGHT too, on the light code
  // surface the reader's pre uses.
  const lightOf = (n) => T.THEME_TOKENS.find((t) => t.name === n).light[0];
  for (const n of ['syn-keyword', 'syn-number', 'syn-comment', 'syn-string', 'syn-type', 'syn-title']) {
    const r = contrast(lightOf(n), lightOf('surface'));
    assert.ok(r >= 4.5, n + ' on light surface = ' + r.toFixed(2) + ' < 4.5');
  }
});
check('mermaid dark variables are the spec values and keep the light fontFamily', () => {
  assert.deepStrictEqual(T.MERMAID_DARK_VARS, Object.assign({}, T.MERMAID_LIGHT_VARS, {
    primaryColor: '#24364f', primaryBorderColor: '#6ea8f5', primaryTextColor: '#f5f6f7', lineColor: '#a3a6ab',
    secondaryColor: '#2a2a2d', tertiaryColor: '#1b1b1d', edgeLabelBackground: '#1b1b1d',
  }));
});

check('applyReaderTheme throws a clear error when the page has no <head> or no </body>', () => {
  assert.throws(() => T.applyReaderTheme('<html>no head</html>'), /applyReaderTheme/);
  const noHead = '<html><head><title>t</title><style>a{}</style></head><body>x</body></html>';
  assert.throws(() => T.applyReaderTheme(noHead), /applyReaderTheme: <head> not found/);
  const noBody = '<html><head>\n<title>t</title><style>a{}</style></head>x</html>';
  assert.throws(() => T.applyReaderTheme(noBody), /applyReaderTheme: <\/body> not found/);
});

(async () => {
  const only = process.argv[2];
  let failed = 0; let ran = 0;
  for (const c of checks) {
    if (only && !c.name.includes(only)) continue;
    ran++;
    try { await c.fn(); console.log('ok   ' + c.name); } catch (e) { failed++; console.log('FAIL ' + c.name + '\n     ' + e.message); }
  }
  if (!ran) { console.error('no check matched'); process.exit(1); }
  if (failed) { console.error(failed + ' of ' + ran + ' check(s) failed'); process.exit(1); }
  console.log('theme: ' + ran + ' checks passed');
})();
