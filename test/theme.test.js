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

check('every token has a name, at least one lowercase #rrggbb or #rgb light literal and a #rrggbb dark value', () => {
  const names = new Set();
  for (const t of T.THEME_TOKENS) {
    assert.match(t.name, /^[a-z0-9-]+$/);
    assert.ok(!names.has(t.name), 'duplicate token ' + t.name);
    names.add(t.name);
    assert.ok(t.light.length >= 1);
    for (const l of t.light) assert.match(l, /^#([0-9a-f]{3}|[0-9a-f]{6})$/);
    assert.match(t.dark, /^#[0-9a-f]{6}$/);
  }
});
check('a light literal belongs to one token only', () => {
  const seen = new Map();
  for (const t of T.THEME_TOKENS) for (const l of t.light) {
    assert.ok(!seen.has(l), l + ' is in both ' + seen.get(l) + ' and ' + t.name);
    seen.set(l, t.name);
  }
});
check('applyThemeTokens rewrites a role literal and leaves an unknown one alone', () => {
  const out = T.applyThemeTokens('  body {\n    color: #24292e;\n    background: #FFFFFF;\n    border-color: #123456;\n  }');
  assert.match(out, /color: var\(--md-fg\);/);
  assert.match(out, /background: var\(--md-bg\);/);
  assert.match(out, /border-color: #123456;/);
});
check('applyThemeTokens leaves editor and lightbox rules literal', () => {
  const css = '  .ed-tb-insert { background: #fff; }\n  html.ed-block-dragging { color: #24292e; }\n  .lightbox-canvas > * {\n    background: #ffffff;\n  }';
  assert.strictEqual(T.applyThemeTokens(css), css);
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
    ['code', 'bg', 4.5], ['code', 'surface', 4.5], ['active-fg', 'active-bg', 4.5], ['fg', 'hit-bg', 4.5],
    ['fg', 'mark-bg', 4.5], ['accent', 'panel', 3],
  ];
  for (const [a, b, min] of pairs) {
    const r = contrast(dark(a), dark(b));
    assert.ok(r >= min, a + ' on ' + b + ' = ' + r.toFixed(2) + ' < ' + min);
  }
  assert.ok(contrast(T.LINK_DARK, dark('bg')) >= 4.5, 'link on bg');
});
check('mermaid dark variables are the spec values and keep the light fontFamily', () => {
  assert.deepStrictEqual(T.MERMAID_DARK_VARS, Object.assign({}, T.MERMAID_LIGHT_VARS, {
    primaryColor: '#24364f', primaryBorderColor: '#6ea8f5', primaryTextColor: '#f5f6f7', lineColor: '#a3a6ab',
    secondaryColor: '#2a2a2d', tertiaryColor: '#1b1b1d', edgeLabelBackground: '#1b1b1d',
  }));
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
