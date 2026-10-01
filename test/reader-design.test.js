#!/usr/bin/env node
'use strict';

// v3.8.0 reader design review — every approved decision is pinned here.
// Spec: docs/superpowers/specs/2026-10-01-reader-design-review-design.md
// Run one check: node test/reader-design.test.js "<substring of its name>"

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const puppeteer = require('puppeteer');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'lib', 'md2doc.js');
const BIN = path.join(REPO, 'bin', 'md2doc.js');
const { renderMarkdown } = require('../lib/md2doc.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-design-'));
let seq = 0;

function writeMd(lines) {
  const md = path.join(tmpDir, 'doc' + (++seq) + '.md');
  fs.writeFileSync(md, Array.isArray(lines) ? lines.join('\n') : lines, 'utf8');
  return md;
}

function render(lines, extraArgs = []) {
  const md = writeMd(lines);
  const out = md.replace(/\.md$/, '.html');
  const r = spawnSync(process.execPath, [LIB, md, out, ...extraArgs], { cwd: REPO, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'render failed: ' + r.stderr);
  return { html: fs.readFileSync(out, 'utf8'), htmlPath: out };
}

// Body of the first CSS rule whose selector text is exactly `selector`
// (rule starts at a line start). Returns null when absent.
function cssRule(html, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = html.match(new RegExp('\\n\\s*' + esc + '\\s*\\{([^}]*)\\}'));
  return m ? m[1] : null;
}

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

let browser;
async function openPage(htmlPath, width = 1440, height = 900) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.goto('file://' + htmlPath, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 300));
  return page;
}

const EN = ['# Spec', '', 'This document describes the transmit path of the block in detail.', ''];
const ZH = ['# 規格', '', '本 IP 不含 internal CSR；safety 欄位的 register-side 容器由 SoC external register file 維護。', ''];

// ── Task 1: fonts and <html lang> ──────────────────────────────────────────
check('lang: Chinese-heavy prose is tagged zh-Hant', async () => {
  assert.match(render(ZH).html, /<html lang="zh-Hant">/);
});
check('lang: English prose stays en', async () => {
  assert.match(render(EN).html, /<html lang="en">/);
});
check('lang: text inside code is not counted', async () => {
  const { html } = render([...EN, '\x60\x60\x60', '中文中文中文中文中文中文中文中文中文中文中文中文中文中文', '\x60\x60\x60', '']);
  assert.match(html, /<html lang="en">/);
});
check('lang: --lang=<tag> overrides detection', async () => {
  assert.match(render(EN, ['--lang=ja']).html, /<html lang="ja">/);
});
check('lang: a malformed --lang never reaches the HTML', async () => {
  const { html } = render(EN, ['--lang="><script>x</script>']);
  assert.match(html, /<html lang="en">/);
  assert.ok(!html.includes('<script>x</script>'), 'hostile tag text leaked into the page');
});
check('cli: md2doc --lang rejects a malformed tag with exit 2', async () => {
  const md = writeMd(EN);
  const r = spawnSync(process.execPath, [BIN, md, '--lang', 'bad tag!', '--out', md.replace(/\.md$/, '.html')], { cwd: REPO, encoding: 'utf8' });
  assert.strictEqual(r.status, 2, 'exit status, stderr=' + r.stderr);
  // Today the flag is unknown, which also exits 2 — the message tells them apart.
  assert.match(r.stderr, /--lang must be a language tag/);
});
check('cli: md2doc --lang reaches the page', async () => {
  const md = writeMd(EN);
  const out = md.replace(/\.md$/, '.html');
  const r = spawnSync(process.execPath, [BIN, md, '--lang', 'zh-Hant', '--out', out], { cwd: REPO, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(out, 'utf8'), /<html lang="zh-Hant">/);
});
check('font: body stack names the Traditional Chinese faces', async () => {
  const body = cssRule(render(EN).html, 'body');
  assert.ok(body, 'body rule found');
  for (const face of ['"PingFang TC"', '"Microsoft JhengHei"', '"Noto Sans CJK TC"', '"Noto Sans TC"']) {
    assert.ok(body.includes(face), 'body font-family lacks ' + face + ': ' + body);
  }
});
check('font: code stack starts with Cascadia Mono and has a CJK fallback', async () => {
  const code = cssRule(render(EN).html, 'code');
  assert.match(code, /font-family: "Cascadia Mono", Consolas, "SFMono-Regular", "Liberation Mono", Menlo, "Microsoft JhengHei", monospace;/);
});

// ── run ──
(async () => {
  const only = process.argv[2];
  browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  let failed = 0;
  let ran = 0;
  try {
    for (const c of checks) {
      if (only && !c.name.includes(only)) continue;
      ran++;
      try {
        await c.fn();
        console.log('ok   ' + c.name);
      } catch (e) {
        failed++;
        console.log('FAIL ' + c.name + '\n     ' + (e && e.message));
      }
    }
  } finally {
    await browser.close();
  }
  if (!ran) { console.error('no check matched ' + JSON.stringify(only)); process.exit(1); }
  if (failed) { console.error(failed + ' of ' + ran + ' check(s) failed'); process.exit(1); }
  console.log('reader-design: ' + ran + ' checks passed');
})();
