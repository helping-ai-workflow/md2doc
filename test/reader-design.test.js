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

// ── Task 2: tables ─────────────────────────────────────────────────────────
const TABLE_MD = [
  '# T', '',
  '| Signal | Dir | Width | Description |',
  '|---|---|---|---|',
  '| `rg_verify_status[2:0]` | Out | 3 | Cl.99.4.7 verify 6-enum state reported to the host after every handshake attempt, including retries and the final verdict |',
  '| `rcv_v` | In | 1 | event indicator |',
  '| `rcv_r` | In | 1 | event indicator |',
  '',
];
check('table: cells align to the top and digits are tabular', async () => {
  const { htmlPath } = render(TABLE_MD);
  const page = await openPage(htmlPath);
  const s = await page.evaluate(() => {
    const td = document.querySelector('.content table tbody td');
    return { va: getComputedStyle(td).verticalAlign, num: getComputedStyle(document.querySelector('.content table')).fontVariantNumeric };
  });
  await page.close();
  assert.strictEqual(s.va, 'top');
  assert.strictEqual(s.num, 'tabular-nums');
});
check('table: horizontal rules only, no zebra, no grey header', async () => {
  const { htmlPath } = render(TABLE_MD);
  const page = await openPage(htmlPath);
  const s = await page.evaluate(() => {
    const cs = (sel) => getComputedStyle(document.querySelector(sel));
    return {
      tdLeft: cs('.content tbody td:nth-child(2)').borderLeftWidth,
      tdBottom: cs('.content tbody td:nth-child(2)').borderBottomWidth,
      thBottom: cs('.content thead th:nth-child(2)').borderBottomWidth,
      thBg: cs('.content thead th:nth-child(2)').backgroundColor,
      evenBg: cs('.content tbody tr:nth-child(2)').backgroundColor,
      evenFirstBg: cs('.content tbody tr:nth-child(2) td:first-child').backgroundColor,
    };
  });
  await page.close();
  assert.strictEqual(s.tdLeft, '0px', 'no vertical rules');
  assert.strictEqual(s.tdBottom, '1px');
  assert.strictEqual(s.thBottom, '2px');
  assert.ok(['rgba(0, 0, 0, 0)', 'rgb(255, 255, 255)'].includes(s.thBg), 'header not grey: ' + s.thBg);
  assert.ok(['rgba(0, 0, 0, 0)', 'rgb(255, 255, 255)'].includes(s.evenBg), 'no zebra row: ' + s.evenBg);
  assert.strictEqual(s.evenFirstBg, 'rgb(255, 255, 255)', 'sticky first column stays opaque white');
});
check('table: on a phone the prose column keeps 15em and the table scrolls', async () => {
  const { htmlPath } = render(TABLE_MD);
  const page = await openPage(htmlPath, 390, 844);
  const s = await page.evaluate(() => {
    const t = document.querySelector('.content table');
    const prose = t.querySelector('tbody td:last-child');
    return { proseW: prose.getBoundingClientRect().width, scrolls: t.scrollWidth > t.clientWidth, rowH: t.querySelector('tbody tr').getBoundingClientRect().height };
  });
  await page.close();
  assert.ok(s.proseW >= 15 * 13.5 - 1, 'prose column >= 15em of the 13.5px table font, got ' + s.proseW);
  assert.ok(s.scrolls, 'table scrolls horizontally instead of squeezing');
  assert.ok(s.rowH < 140, 'row is no longer a tall column of wrapped text, got ' + s.rowH);
});

// ── Task 3: headings ───────────────────────────────────────────────────────
const HEAD_MD = ['# Doc', '', '## 4. Assumptions', '', 'Intro.', '', '### 4.1 Assumptions', '', '**Decision:** text.', '', '#### 3.4.2 AD-MMTX-002 — layout', '', 'Body.', '', '### IF-TX-04 — Dual slave', '', 'Body.', ''];
check('heading: leading section number is wrapped, text unchanged', async () => {
  const { html, htmlPath } = render(HEAD_MD);
  assert.match(html, /<h3 id="4-1-assumptions"[^>]*><span class="sec">4\.1<\/span> Assumptions<a class="heading-anchor"/);
  assert.match(html, /<h2 id="4-assumptions"[^>]*><span class="sec">4\.<\/span> Assumptions/);
  assert.match(html, /<h3 id="if-tx-04-dual-slave"[^>]*>IF-TX-04 — Dual slave/, 'non-numbered heading untouched');
  const page = await openPage(htmlPath);
  const t = await page.evaluate(() => document.getElementById('4-1-assumptions').firstChild.textContent + document.getElementById('4-1-assumptions').childNodes[1].textContent);
  await page.close();
  assert.strictEqual(t, '4.1 Assumptions', 'number + original space survive in textContent');
});
check('heading: edit mode keeps the plain heading markup', async () => {
  const { bodyHtml } = await renderMarkdown(HEAD_MD.join('\n'), path.join(tmpDir, 'edit.md'), { editMode: true });
  assert.ok(!bodyHtml.includes('class="sec"'), 'no section span in edit mode');
});
check('heading: H3/H4 scale and more space above than below', async () => {
  const { htmlPath } = render(HEAD_MD);
  const page = await openPage(htmlPath);
  const s = await page.evaluate(() => {
    const px = (el, p) => parseFloat(getComputedStyle(el)[p]);
    const body = parseFloat(getComputedStyle(document.body).fontSize);
    const h2 = document.getElementById('4-assumptions');
    const h3 = document.getElementById('4-1-assumptions');
    const h4 = document.querySelector('h4');
    return { h3: px(h3, 'fontSize') / body, h4: px(h4, 'fontSize') / body,
      h2top: px(h2, 'marginTop') / px(h2, 'fontSize'), h2bot: px(h2, 'marginBottom') / px(h2, 'fontSize'),
      h3top: px(h3, 'marginTop') / px(h3, 'fontSize'), h3bot: px(h3, 'marginBottom') / px(h3, 'fontSize'),
      h4top: px(h4, 'marginTop') / px(h4, 'fontSize'), h4bot: px(h4, 'marginBottom') / px(h4, 'fontSize') };
  });
  await page.close();
  const near = (a, b) => Math.abs(a - b) < 0.02;
  assert.ok(near(s.h3, 1.3) && near(s.h4, 1.1), 'sizes ' + JSON.stringify(s));
  assert.ok(near(s.h2top, 2.2) && near(s.h2bot, 0.7), 'h2 margins ' + JSON.stringify(s));
  assert.ok(near(s.h3top, 2.0) && near(s.h3bot, 0.5), 'h3 margins ' + JSON.stringify(s));
  assert.ok(near(s.h4top, 1.8) && near(s.h4bot, 0.4), 'h4 margins ' + JSON.stringify(s));
});

// ── Task 4: inline code ────────────────────────────────────────────────────
check('code: inline code has no chip, #b93a0c text, 0.92em; code blocks untouched', async () => {
  const { htmlPath } = render(['# C', '', 'Signal `rcv_v` here.', '', '| A |', '|---|', '| `clk_tx` |', '', '\x60\x60\x60', 'block()', '\x60\x60\x60', '']);
  const page = await openPage(htmlPath);
  const s = await page.evaluate(() => {
    const st = (el) => { const c = getComputedStyle(el); return { bg: c.backgroundColor, color: c.color, size: parseFloat(c.fontSize), pad: c.paddingLeft }; };
    const p = document.querySelector('.content p code');
    return { p: st(p), pFont: parseFloat(getComputedStyle(p.parentElement).fontSize), td: st(document.querySelector('.content td code')), pre: st(document.querySelector('.content pre code')) };
  });
  await page.close();
  assert.strictEqual(s.p.bg, 'rgba(0, 0, 0, 0)');
  assert.strictEqual(s.p.color, 'rgb(185, 58, 12)');
  assert.strictEqual(s.p.pad, '0px');
  assert.ok(Math.abs(s.p.size / s.pFont - 0.92) < 0.01, 'ratio ' + s.p.size / s.pFont);
  assert.strictEqual(s.td.color, 'rgb(185, 58, 12)', 'table cells too');
  assert.notStrictEqual(s.pre.color, 'rgb(185, 58, 12)', 'code blocks keep their colour');
});

// ── Task 5: diagrams ───────────────────────────────────────────────────────
check('mermaid: base theme with md2doc link blue, in reader and edit mode', async () => {
  // A flowchart, not a state diagram: flowchart nodes take primaryBorderColor
  // directly as their stroke, so the computed colour is unambiguous.
  const { html, htmlPath } = render(['# M', '', '\x60\x60\x60mermaid', 'graph TD', '  A[Start] --> B[End]', '\x60\x60\x60', '']);
  assert.ok(!/theme: 'default'/.test(html), 'default theme gone');
  assert.match(html, /mermaid\.initialize\(\{ startOnLoad: true, theme: 'base', themeVariables: \{[^}]*primaryBorderColor: '#0969da'/);
  const page = await openPage(htmlPath);
  await page.waitForFunction(() => document.querySelector('.mermaid svg .node rect, .mermaid svg rect.basic'), { timeout: 15000 });
  const stroke = await page.evaluate(() => getComputedStyle(document.querySelector('.mermaid svg .node rect, .mermaid svg rect.basic')).stroke);
  await page.close();
  assert.strictEqual(stroke, 'rgb(9, 105, 218)');
  const { html: edit } = await renderMarkdown('# M\n\n\x60\x60\x60mermaid\ngraph TD\nA-->B\n\x60\x60\x60\n', path.join(tmpDir, 'm.md'), { editMode: true });
  assert.match(edit, /mermaid\.initialize\(\{ startOnLoad: false, theme: 'base'/);
});
check('graphviz: default Times is replaced, an author font is kept', async () => {
  const plain = render(['# G', '', '\x60\x60\x60dot', 'digraph { a -> b [label="go"]; }', '\x60\x60\x60', '']).html;
  assert.ok(!plain.includes('font-family="Times,serif"'), 'Times left in the SVG');
  assert.match(plain, /font-family="Helvetica,sans-Serif"/);
  const authored = render(['# G', '', '\x60\x60\x60dot', 'digraph { node [fontname="Courier"]; a -> b; }', '\x60\x60\x60', '']).html;
  assert.match(authored, /font-family="Courier(,monospace)?"/); // graphviz appends its generic fallback
});

// ── Task 6: metadata block ─────────────────────────────────────────────────
const META = ['# Spec', '', '**Document Type:** Module spec (profile `ip-spec`)', '**Version:** 0.19', '**Owner:** Heping Li', '', '## 1. Overview', '', 'Body.', ''];
check('meta: lines after the first H1 become a two-column list', async () => {
  const { html } = render(META);
  assert.match(html, /<dl class="doc-meta"><dt>Document Type<\/dt><dd>Module spec \(profile <code>ip-spec<\/code>\)<\/dd><dt>Version<\/dt><dd>0\.19<\/dd><dt>Owner<\/dt><dd>Heping Li<\/dd><\/dl>/);
});
check('meta: one non-matching line leaves the paragraph alone', async () => {
  const { html } = render(['# Spec', '', '**Version:** 0.19', 'plain sentence', '']);
  assert.ok(!html.includes('class="doc-meta"'));
});
check('meta: only the paragraph right after the FIRST H1', async () => {
  const { html } = render(['# Spec', '', 'Intro first.', '', '# Second', '', '**Version:** 0.19', '**Owner:** X', '', '## A', '', '**Key:** v', '**Other:** w', '']);
  assert.ok(!html.includes('class="doc-meta"'), 'a later H1 or an H2 never triggers it');
});
check('meta: edit mode keeps the paragraph', async () => {
  const { bodyHtml } = await renderMarkdown(META.join('\n'), path.join(tmpDir, 'meta.md'), { editMode: true });
  assert.ok(!bodyHtml.includes('class="doc-meta"'));
});
check('meta: two-column grid on the metadata panel grey', async () => {
  const { htmlPath } = render(META);
  const page = await openPage(htmlPath);
  const s = await page.evaluate(() => { const c = getComputedStyle(document.querySelector('.doc-meta')); return { d: c.display, cols: c.gridTemplateColumns.split(' ').length, bg: c.backgroundColor }; });
  await page.close();
  assert.deepStrictEqual(s, { d: 'grid', cols: 2, bg: 'rgb(246, 248, 250)' });
});

// ── Task 7: sidebar ────────────────────────────────────────────────────────
const SIDE_MD = ['# Doc', '', '## 1. Alpha', '', 'zebrafinch alpha text.', '', '### 1.1 Alpha child', '', 'More zebrafinch.', '', '## 2. Beta', '', 'Beta text.', ''];
check('sidebar: markup — Contents row, icon buttons, labelled clear, keyboard-only submit', async () => {
  const { html } = render(SIDE_MD);
  assert.match(html, /<span class="toc-title">Contents<\/span>/);
  assert.match(html, /placeholder="Search this document"/);
  assert.match(html, />Search<\/label>/, 'label text kept for screen readers');
  assert.match(html, /<button id="doc-search-submit" type="button" tabindex="-1">Search<\/button>/);
  assert.match(html, /<button id="doc-search-clear" type="button" aria-label="Clear search" title="Clear search"><svg/);
  for (const id of ['toc-expand-all', 'toc-collapse-all', 'toc-collapse-toggle', 'search-prev', 'search-next']) {
    assert.match(html, new RegExp('<button id="' + id + '"[^>]*><svg'), id + ' carries an icon');
  }
});
check('sidebar: one grey panel, no inner cards, visually hidden label', async () => {
  const { htmlPath } = render(SIDE_MD);
  const page = await openPage(htmlPath);
  const s = await page.evaluate(() => {
    const c = (sel) => getComputedStyle(document.querySelector(sel));
    return { panel: c('.reader-sidebar').backgroundColor, tocBorder: c('.toc').borderTopWidth, toolsBg: c('.reader-tools').backgroundColor,
      labelW: document.querySelector('.reader-search-label').getBoundingClientRect().width, headerDir: c('.toc-header').flexDirection };
  });
  await page.close();
  assert.strictEqual(s.panel, 'rgb(243, 245, 247)');
  assert.strictEqual(s.tocBorder, '0px');
  assert.strictEqual(s.toolsBg, 'rgba(0, 0, 0, 0)');
  assert.ok(s.labelW <= 1, 'label visually hidden, width ' + s.labelW);
  assert.strictEqual(s.headerDir, 'row');
});
check('sidebar: clear button appears only with text and clears the search', async () => {
  const { htmlPath } = render(SIDE_MD);
  const page = await openPage(htmlPath);
  const hiddenWhenEmpty = await page.$eval('#doc-search-clear', (b) => getComputedStyle(b).display);
  await page.type('#doc-search-input', 'zebrafinch');
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 200));
  const shown = await page.$eval('#doc-search-clear', (b) => getComputedStyle(b).display);
  const resultsRow = await page.$eval('.search-results-header', (h) => getComputedStyle(h).flexDirection);
  const match = await page.$eval('.toc a.is-match', (a) => getComputedStyle(a).backgroundColor);
  await page.click('#doc-search-clear');
  await new Promise((r) => setTimeout(r, 150));
  const after = await page.evaluate(() => ({ value: document.getElementById('doc-search-input').value, results: document.getElementById('search-results').hidden }));
  await page.close();
  assert.strictEqual(hiddenWhenEmpty, 'none');
  assert.notStrictEqual(shown, 'none');
  assert.strictEqual(resultsRow, 'row', 'Results 1/N and the arrows share one row');
  assert.strictEqual(match, 'rgb(255, 245, 194)', 'search hits are yellow');
  assert.deepStrictEqual(after, { value: '', results: true });
});
check('sidebar: current location is blue and its whole path is bold', async () => {
  const { htmlPath } = render(SIDE_MD);
  const page = await openPage(htmlPath);
  await page.evaluate(() => document.getElementById('1-1-alpha-child').scrollIntoView());
  await new Promise((r) => setTimeout(r, 500));
  const s = await page.evaluate(() => {
    const active = document.querySelector('.toc a.is-active');
    const parent = active.closest('li').parentElement.closest('li').querySelector(':scope > details > summary > a');
    return { bg: getComputedStyle(active).backgroundColor, color: getComputedStyle(active).color, parentWeight: getComputedStyle(parent).fontWeight, crumb: getComputedStyle(document.querySelector('.toc-breadcrumb')).display };
  });
  await page.close();
  assert.strictEqual(s.bg, 'rgb(219, 230, 243)');
  assert.strictEqual(s.color, 'rgb(5, 80, 174)');
  assert.strictEqual(s.parentWeight, '600', 'ancestor row bold');
  assert.strictEqual(s.crumb, 'none', 'breadcrumb replaced by the path highlight');
});

check('sidebar: an active PARENT row keeps the active colour', async () => {
  // Filler pads every section so scrolling to a parent heading makes IT the active row.
  const fill = Array.from({ length: 30 }, (_, i) => 'Filler paragraph ' + i + '.\n');
  const md = ['# Doc', '', '## 1. Alpha', '', ...fill, '### 1.1 Alpha child', '', ...fill, '## 2. Beta', '', ...fill].join('\n');
  const { htmlPath } = render(md.split('\n'));
  const page = await openPage(htmlPath);
  await page.evaluate(() => document.getElementById('1-alpha').scrollIntoView());
  await new Promise((r) => setTimeout(r, 500));
  const s = await page.evaluate(() => {
    const a = document.querySelector('.toc a.is-active');
    return { inSummary: a.parentElement.tagName, text: a.textContent.trim(), color: getComputedStyle(a).color, bg: getComputedStyle(a).backgroundColor };
  });
  await page.close();
  assert.strictEqual(s.inSummary, 'SUMMARY', 'active row is a parent row, got ' + JSON.stringify(s));
  assert.strictEqual(s.color, 'rgb(5, 80, 174)');
  assert.strictEqual(s.bg, 'rgb(219, 230, 243)');
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
