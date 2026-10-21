#!/usr/bin/env node
'use strict';

// Reader click-through checks: every interactive control of the reading view,
// clicked for real in Chromium and WebKit (the engine of iPhone Safari / Files /
// LINE previews) at a desktop (1440x900) and a phone (390x844) viewport.
// Geometry and state come from the DOM, never from screenshots, so fonts and CI
// machines do not move the thresholds. Modelled on tripwork's tests_browser/.
//
// Run:   npm run test:browser          (after: npx playwright install chromium webkit)
// One engine:  MD2DOC_ENGINES=webkit node test/reader-click.test.js
// A subset:    node test/reader-click.test.js "phone:"

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const playwright = require('playwright');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'lib', 'md2doc.js');
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const ACTIVE = { color: 'rgb(5, 80, 174)', bg: 'rgb(219, 230, 243)' };
const HIT_BG = 'rgb(255, 245, 194)';
const RING = 'solid 2px rgb(9, 105, 218)';

// ── Fixture: shaped like a real spec (metadata block, numbered sections with
// children, a long title, a wide table, a diagram, a searchable word) ──────────
function filler(s, n) {
  return Array.from({ length: n }, (_, i) =>
    ('Paragraph ' + i + ' of section ' + s + '. The transmit path forwards each beat and keeps the sideband aligned. ').repeat(3)
  ).join('\n\n');
}
const md = ['# Reader Fixture Spec', '', '**Document Type:** Module spec', '**Version:** 0.1', '**Owner:** QA', ''];
for (let s = 1; s <= 8; s++) {
  md.push('## ' + s + '. Section ' + s, '', filler(s, 4), '');
  if (s === 5 || s === 7) md.push('The zebrafinch handshake is defined here.', '');
  md.push('### ' + s + '.1 Child of ' + s, '', filler(s + '.1', 3), '');
  if (s === 3) md.push('### 3.3 A deliberately long subsection title that overflows the sidebar width by a wide margin', '', filler('3.3', 2), '');
  if (s === 4) {
    md.push('| Signal | Dir | Width | Clock | Description |', '|---|---|---|---|---|');
    for (const sig of ['rg_verify_status[2:0]', 'rcv_v', 'rcv_r', 'rg_preempt_active']) {
      md.push('| `' + sig + '` | Out | 3 | `clk_tx` | Verify state reported to the host after every handshake attempt, including retries and the final verdict |');
    }
    md.push('');
  }
  // The last section needs room to scroll to the top, or a TOC jump to it cannot land there.
  if (s === 8) md.push(filler('8.tail', 14), '');
  if (s === 6) md.push('\x60\x60\x60dot', 'digraph { a -> b [label="go"]; }', '\x60\x60\x60', '');
}
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-click-'));
const mdPath = path.join(tmpDir, 'fixture.md');
const htmlPath = path.join(tmpDir, 'fixture.html');
fs.writeFileSync(mdPath, md.join('\n'), 'utf8');
const run = spawnSync(process.execPath, [LIB, mdPath, htmlPath], { cwd: REPO, encoding: 'utf8' });
assert.strictEqual(run.status, 0, 'fixture renders: ' + run.stderr);
const URL = 'file://' + htmlPath;

// ── Theme fixture (v3.9.0): every diagram kind plus an image ───────────────
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
fs.writeFileSync(path.join(tmpDir, 'dot.png'), Buffer.from(PNG_1PX, 'base64'));
const themeMd = ['# Theme Fixture', '', '## 1. Alpha', '', 'Prose with `inline_code`, a [link](https://example.com) and zebrafinch.', '',
  '![dot](dot.png)', '',
  '\x60\x60\x60mermaid', 'graph LR', '  A[Start] --> B[End]', '\x60\x60\x60', '',
  '\x60\x60\x60dot', 'digraph { node [shape=box, style=filled, fillcolor="#90caf9"]; a -> b [label="go"]; }', '\x60\x60\x60', '',
  '\x60\x60\x60wavedrom', '{ "signal": [ { "name": "clk", "wave": "p...." }, { "name": "d", "wave": "x3.4x", "data": ["A", "B"] } ] }', '\x60\x60\x60', '',
  '## 2. Beta', '', filler(2, 6), ''];
const themeMdPath = path.join(tmpDir, 'theme.md');
const themeHtmlPath = path.join(tmpDir, 'theme.html');
fs.writeFileSync(themeMdPath, themeMd.join('\n'), 'utf8');
const themeRun = spawnSync(process.execPath, [LIB, themeMdPath, themeHtmlPath], { cwd: REPO, encoding: 'utf8' });
assert.strictEqual(themeRun.status, 0, 'theme fixture renders: ' + themeRun.stderr);
const THEME_URL = 'file://' + themeHtmlPath;
const plainMdPath = path.join(tmpDir, 'plain.md');
const plainHtmlPath = path.join(tmpDir, 'plain.html');
fs.writeFileSync(plainMdPath, 'Just a paragraph with no heading and no diagram.\n', 'utf8');
assert.strictEqual(spawnSync(process.execPath, [LIB, plainMdPath, plainHtmlPath], { cwd: REPO, encoding: 'utf8' }).status, 0);
const PLAIN_URL = 'file://' + plainHtmlPath;
// Per-check fixtures live in their own files so the shared theme fixture stays unchanged.
function fixtureUrl(name, mdLines) {
  const mdFile = path.join(tmpDir, name + '.md');
  const htmlFile = path.join(tmpDir, name + '.html');
  fs.writeFileSync(mdFile, mdLines.join('\n'), 'utf8');
  const r = spawnSync(process.execPath, [LIB, mdFile, htmlFile], { cwd: REPO, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, name + ' renders: ' + r.stderr);
  return 'file://' + htmlFile;
}

// ── Follow-up fixture (v3.13.1): the main fixture's shape, plus phrases that
// cross text nodes (a heading's number span, inline code, a soft line break,
// bold) and three short trailing sections ─────────────────────────────────────
const FOLLOWUP_MD = ['# Reader Fixture Spec', ''];
for (let s = 1; s <= 8; s++) {
  FOLLOWUP_MD.push('## ' + s + '. Section ' + s, '', filler(s, 4), '');
  if (s === 5) FOLLOWUP_MD.push('The zebrafinch handshake is defined here.', '');
  FOLLOWUP_MD.push('### ' + s + '.1 Child of ' + s, '', filler(s + '.1', 3), '');
  if (s === 4) {
    FOLLOWUP_MD.push('### 4.2 Assumptions', '', 'The link partner keeps its clock.', '');
    FOLLOWUP_MD.push('A `rcv_v` beat crosses an inline code boundary.', '');
    FOLLOWUP_MD.push('alpha line', 'bravo line wraps by a soft break.', '');
    FOLLOWUP_MD.push('Words **bold kiwi** run on.', '');
  }
}
FOLLOWUP_MD.push('## 9. Short nine', '', 'One line.', '', '## 10. Short ten', '', 'One line.', '', '## 11. Short eleven', '', 'One line.', '');
const FOLLOWUP_URL = fixtureUrl('followup', FOLLOWUP_MD);
// Search across nodes, its own file so FOLLOWUP_MD stays as Tasks 11–13 expect:
// a phrase whose only separator is a whitespace-only text node between two
// inline elements, and one multi-node phrase found in two different sections.
const SEARCH_NODES_URL = fixtureUrl('search-nodes', [
  '# Search Nodes', '',
  '## 1. First', '', filler(1, 2), '',
  'Run **bold** *italic* here.', '',
  'The `tx_ready` flag rises.', '',
  '## 2. Second', '', filler(2, 6), '',
  'Later the `tx_ready` flag falls.', '',
  '## 3. Third', '', filler(3, 6), '',
]);
// T9b: the shapes whose text the results list and the in-text marks used to
// read differently — inline and display math (list: TeX; DOM: MathML + glyphs),
// a fenced code block (never indexed) and a hard break (words fused).
const SECTION_TEXT_URL = fixtureUrl('section-text', [
  '# Section Text', '',
  '## 1. Shapes', '', filler(1, 2), '',
  'Inline math $x^2 + y$ inside sentence.', '',
  '$$', 'E = mc^2', '$$', '',
  '> quoted line inside blockquote.', '',
  '\x60\x60\x60js', 'const codeblock = 42; // code comment words', '\x60\x60\x60', '',
  'Para after code block.', '',
  '\x60\x60\x60math', '\\alpha + \\beta', '\x60\x60\x60', '',
  'hard line one  ', 'hard line two after a br.', '',
  // Fix round 1: a list item's text after its block child (a code block, a
  // nested list) is indexed where it reads, not ahead of the child.
  '- alpha item', '  \x60\x60\x60', '  codeline inside', '  \x60\x60\x60', '  after code tail', '',
  'Between lists.', '',
  '- loose first', '', '  - nested bee', '', '  loose tail words', '',
  '## 2. Next', '', filler(2, 6), '',
]);

// ── Helpers ─────────────────────────────────────────────────────────────────
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function overflowX(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}
async function activeRows(page) {
  return page.$$eval('.toc a.is-active', (as) => as.map((a) => ({
    href: a.getAttribute('href'), color: getComputedStyle(a).color, bg: getComputedStyle(a).backgroundColor,
  })));
}
async function topOf(page, id) {
  return page.evaluate((i) => document.getElementById(i).getBoundingClientRect().top, id);
}
async function onScreen(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.left >= -0.5 && r.top >= -0.5 &&
      r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5;
  }, selector);
}
// The focused element's outline, and every ancestor that clips it.
async function focusRing(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    const cs = getComputedStyle(el);
    const extent = Math.max(0, parseFloat(cs.outlineWidth) + parseFloat(cs.outlineOffset));
    const r = el.getBoundingClientRect();
    const box = { l: r.left - extent, t: r.top - extent, r: r.right + extent, b: r.bottom + extent };
    const clippers = [];
    for (let a = el.parentElement; a; a = a.parentElement) {
      // The root's border box is the whole scrolled document, not the viewport
      // window that clips, so measuring it reports a false clip once the page
      // has scrolled. The viewport edge is not what this helper is for.
      if (a === document.documentElement) continue;
      const s = getComputedStyle(a);
      if ([s.overflowX, s.overflowY].some((v) => v !== 'visible')) {
        const ar = a.getBoundingClientRect();
        const bl = parseFloat(s.borderLeftWidth), bt = parseFloat(s.borderTopWidth);
        const inner = { l: ar.left + bl, t: ar.top + bt, r: ar.left + bl + a.clientWidth, b: ar.top + bt + a.clientHeight };
        if (box.l < inner.l - 0.5 || box.t < inner.t - 0.5 || box.r > inner.r + 0.5 || box.b > inner.b + 0.5) {
          clippers.push(a.className || a.tagName);
        }
      }
    }
    return { id: el.id || el.getAttribute('href') || el.tagName, outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor, clippers };
  });
}

// What a scroll-and-stitch full-page capture (FireShot and the like) repeats on
// every slice: visible elements whose place on screen does not move when the
// page scrolls by dy. Measured, not read from CSS, so a sticky table column
// (it moves vertically) is not reported and a new floating control is.
async function stuckWhileScrolling(page, dy) {
  return page.evaluate(async (dy) => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const pinned = [...document.querySelectorAll('body *')].filter((e) => {
      const p = getComputedStyle(e).position;
      return p === 'fixed' || p === 'sticky';
    });
    const shown = (r) => r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
    const y0 = scrollY;
    const before = pinned.map((e) => e.getBoundingClientRect());
    window.scrollBy(0, dy);
    await frame();
    const moved = scrollY - y0;
    if (moved < dy - 1) throw new Error('the page did not scroll by ' + dy + ' (moved ' + moved + ')');
    return pinned.filter((e, i) => {
      const a = before[i];
      const b = e.getBoundingClientRect();
      return shown(a) && shown(b) && getComputedStyle(e).visibility !== 'hidden' && Math.abs(b.top - a.top) < moved / 2;
    }).map((e) => e.id || String(e.className));
  }, dy);
}

const checks = [];
// opts.engines: run only on these engines. opts.launch: launch options for a
// browser of the check's own (launched and closed around it), e.g. to turn the
// classic scrollbars back on that the default headless launch hides.
function check(name, viewport, fn, ctx, opts) { checks.push({ name, viewport, fn, ctx, opts: opts || {} }); }

// ── Desktop ─────────────────────────────────────────────────────────────────
check('desktop: TOC links jump and light exactly one blue row, path bold', DESKTOP, async (page) => {
  for (const id of ['2-section-2', '3-3-a-deliberately-long-subsection-title-that-overflows-the-sidebar-width-by-a-wide-margin', '5-1-child-of-5', '8-section-8']) {
    // The TOC keeps one path open, so every jump closes the sections expanded for the last one: expand again each time.
    await page.click('#toc-expand-all');
    await page.click('.toc-list a[href="#' + id + '"]');
    await wait(400);
    const top = await topOf(page, id);
    assert.ok(top >= -1 && top <= 130, id + ' lands near the top, top=' + top);
    const rows = await activeRows(page);
    assert.strictEqual(rows.length, 1, id + ': exactly one active row, got ' + JSON.stringify(rows));
    assert.strictEqual(rows[0].href, '#' + id);
    assert.strictEqual(rows[0].color, ACTIVE.color, id + ' active colour');
    assert.strictEqual(rows[0].bg, ACTIVE.bg, id + ' active background');
    if (id === '5-1-child-of-5') {
      // Only the active row's own ancestors are bold, so this is read while 5.1 is active.
      const parentWeight = await page.$eval('.toc-list a[href="#5-section-5"]', (a) => getComputedStyle(a).fontWeight);
      assert.strictEqual(parentWeight, '600', 'parent of the active row is bold');
    }
  }
  assert.ok((await overflowX(page)) <= 0, 'no horizontal page scroll');
});
check('desktop: clicking a section caret toggles it without navigating', DESKTOP, async (page) => {
  const hash = await page.evaluate(() => location.hash);
  const box = await page.$eval('.toc-list a[href="#4-section-4"]', (a) => { const s = a.closest('summary').getBoundingClientRect(); return { x: s.left + 4, y: s.top + s.height / 2 }; });
  const open = () => page.$eval('.toc-list a[href="#4-section-4"]', (a) => a.closest('details').open);
  const before = await open();
  await page.mouse.click(box.x, box.y);
  await wait(150);
  assert.strictEqual(await open(), !before, 'caret click toggles the section');
  await page.mouse.click(box.x, box.y);
  await wait(150);
  assert.strictEqual(await open(), before, 'second click toggles it back');
  assert.strictEqual(await page.evaluate(() => location.hash), hash, 'caret click does not navigate');
});
check('desktop: Expand all / Collapse all', DESKTOP, async (page) => {
  await page.click('#toc-expand-all');
  const allOpen = await page.$$eval('.toc details', (ds) => ds.every((d) => d.open));
  assert.ok(allOpen, 'every section open');
  await page.click('#toc-collapse-all');
  await wait(150);
  const top = await page.$$eval('.toc > .toc-list > li > details > summary > a, .toc > .toc-list > li > a',
    (as) => as.filter((a) => a.getBoundingClientRect().height > 0).length);
  assert.strictEqual(top, 8, 'the eight top-level sections stay visible');
});
check('desktop: hide the sidebar and bring it back', DESKTOP, async (page) => {
  const wide = await page.$eval('.reader-sidebar', (s) => s.getBoundingClientRect().width);
  await page.click('#toc-collapse-toggle');
  await wait(250);
  const rail = await page.$eval('.reader-sidebar', (s) => s.getBoundingClientRect().width);
  assert.ok(Math.abs(rail - 36) <= 1, 'collapsed to the 36px rail, got ' + rail);
  assert.ok(await onScreen(page, '#toc-collapse-toggle'), 'toggle still on screen');
  const hit = await page.evaluate(() => { const r = document.getElementById('toc-collapse-toggle').getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!(e && e.closest('#toc-collapse-toggle')); });
  assert.ok(hit, 'nothing covers the toggle in the rail');
  await page.click('#toc-collapse-toggle');
  await wait(250);
  const back = await page.$eval('.reader-sidebar', (s) => s.getBoundingClientRect().width);
  assert.ok(Math.abs(back - wide) <= 1, 'restored to ' + wide + ', got ' + back);
});
check('desktop: search — Enter, step, pick a result, clear', DESKTOP, async (page) => {
  await page.fill('#doc-search-input', 'zebrafinch');
  await page.press('#doc-search-input', 'Enter');
  await wait(300);
  assert.ok(await onScreen(page, '#search-results'), 'results panel shown');
  const count = () => page.$eval('#search-result-count', (e) => e.textContent.trim());
  const n = Number((await count()).split('/')[1]);
  assert.strictEqual(await count(), '1/' + n);
  assert.ok(n >= 2, 'both sections with the word are found, n=' + n);
  assert.ok(await onScreen(page, 'mark.search-hit.is-selected'), 'first hit scrolled into view');
  await page.click('#search-next');
  await wait(300);
  assert.strictEqual(await count(), '2/' + n);
  assert.ok(await onScreen(page, 'mark.search-hit.is-selected'), 'next hit on screen');
  await page.click('#search-prev');
  await wait(300);
  assert.strictEqual(await count(), '1/' + n);
  await page.click('.search-result-item >> nth=1');
  await wait(300);
  assert.strictEqual(await page.$eval('.search-result-item >> nth=1', (b) => b.classList.contains('is-active')), true);
  const hits = await page.$$eval('.toc a.is-match', (as) => as.map((a) => getComputedStyle(a).backgroundColor));
  assert.ok(hits.length >= 1 && hits.every((c) => c === HIT_BG), 'TOC hits are yellow: ' + JSON.stringify(hits));
  assert.ok(await onScreen(page, '#doc-search-clear'), 'clear button shown while there is text');
  await page.click('#doc-search-clear');
  await wait(200);
  const after = await page.evaluate(() => ({ value: document.getElementById('doc-search-input').value, hidden: document.getElementById('search-results').hidden, matches: document.querySelectorAll('.toc a.is-match').length, marks: document.querySelectorAll('mark.search-hit').length }));
  assert.deepStrictEqual(after, { value: '', hidden: true, matches: 0, marks: 0 });
});
check('desktop: Tab through the sidebar — every control shows a full blue ring', DESKTOP, async (page) => {
  await page.focus('#doc-search-input');
  let r = await focusRing(page);
  assert.strictEqual(r.outline, RING, 'search box ring');
  assert.deepStrictEqual(r.clippers, [], 'search box ring not clipped');
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    r = await focusRing(page);
    assert.strictEqual(r.outline, RING, 'ring on ' + r.id);
    assert.deepStrictEqual(r.clippers, [], 'ring on ' + r.id + ' clipped by ' + r.clippers.join(', '));
  }
});
check('desktop: heading anchor appears on hover and puts the hash in the URL', DESKTOP, async (page) => {
  await page.hover('[id="5-section-5"]');
  await wait(250);
  assert.strictEqual(await page.$eval('[id="5-section-5"] .heading-anchor', (a) => getComputedStyle(a).opacity), '1');
  await page.click('[id="5-section-5"] .heading-anchor');
  await wait(300);
  assert.strictEqual(await page.evaluate(() => location.hash), '#5-section-5');
  const top = await topOf(page, '5-section-5');
  assert.ok(top >= -1 && top <= 130, 'heading near the top, top=' + top);
});
check('desktop: a diagram opens in the lightbox; ✕ and Esc close it', DESKTOP, async (page) => {
  const isOpen = () => page.evaluate(() => { const b = document.querySelector('.lightbox'); return !!b && !b.hidden; });
  await page.click('main.content .graphviz svg');
  await wait(250);
  assert.ok(await isOpen(), 'lightbox opens');
  const close = await page.evaluateHandle(() => [...document.querySelectorAll('.lightbox-bar button')].find((b) => b.textContent.trim() === '✕'));
  const box = await close.boundingBox();
  assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= DESKTOP.width && box.y + box.height <= DESKTOP.height, 'close button inside the screen');
  await close.click();
  await wait(200);
  assert.ok(!(await isOpen()), '✕ closes');
  await page.click('main.content .graphviz svg');
  await wait(250);
  await page.keyboard.press('Escape');
  await wait(200);
  assert.ok(!(await isOpen()), 'Esc closes');
});
// Screenshot mode (v3.14.2): the reader minus everything a scroll-and-stitch
// capture would repeat, the document kept at the width it was read at.
async function readerShape(page) {
  return page.evaluate(() => {
    const vis = (sel) => { const e = document.querySelector(sel); return !!e && e.getClientRects().length > 0; };
    const r = document.querySelector('main.content').getBoundingClientRect();
    const toast = document.querySelector('.capture-toast');
    return {
      w: Math.round(r.width), left: Math.round(r.left), right: Math.round(document.documentElement.clientWidth - r.right),
      y: Math.round(scrollY), sidebar: vis('.reader-sidebar'), splitter: vis('#sidebar-splitter'), bar: vis('#mobile-bar'),
      theme: vis('#md2doc-theme-toggle'), toast: toast && toast.getClientRects().length ? toast.textContent : null,
    };
  });
}
check('desktop: screenshot mode leaves only the document at its reading width; Esc brings the reader back', DESKTOP, async (page) => {
  assert.ok((await stuckWhileScrolling(page, 600)).includes('reader-sidebar'), 'the probe sees the sticky sidebar outside the mode');
  await page.evaluate(() => window.scrollTo(0, 1500)); await wait(300);
  const before = await readerShape(page);
  await page.click('#capture-mode-toggle'); await wait(300);
  const s = await readerShape(page);
  assert.strictEqual(s.sidebar, false, 'sidebar hidden, ' + JSON.stringify(s));
  assert.strictEqual(s.splitter, false, 'splitter hidden, ' + JSON.stringify(s));
  assert.strictEqual(s.theme, false, 'theme bubble hidden, ' + JSON.stringify(s));
  assert.ok(Math.abs(s.w - before.w) <= 1, 'reading width kept: ' + before.w + ' -> ' + s.w);
  assert.ok(Math.abs(s.left - s.right) <= 1, 'centred, ' + JSON.stringify(s));
  assert.ok(Math.abs(s.y - before.y) <= 1, 'reading position kept: ' + before.y + ' -> ' + s.y);
  assert.match(String(s.toast), /Esc/, 'the toast says how to leave');
  await wait(2600);
  assert.deepStrictEqual(await stuckWhileScrolling(page, 600), [], 'nothing stays put while the page scrolls (toast gone too)');
  const y = (await readerShape(page)).y;
  await page.keyboard.press('Escape'); await wait(300);
  const back = await readerShape(page);
  assert.strictEqual(back.sidebar, true, 'sidebar back, ' + JSON.stringify(back));
  assert.strictEqual(back.theme, true, 'theme bubble back, ' + JSON.stringify(back));
  assert.ok(Math.abs(back.w - before.w) <= 1, 'width back: ' + before.w + ' -> ' + back.w);
  assert.ok(Math.abs(back.y - y) <= 1, 'Esc keeps the reading position: ' + y + ' -> ' + back.y);
});
check('desktop: the screenshot button sits between Collapse all and the sidebar toggle; the rail hides it', DESKTOP, async (page) => {
  const shown = () => page.$$eval('.toc-header-actions button', (bs) => bs.filter((b) => b.getClientRects().length > 0).map((b) => b.id));
  assert.deepStrictEqual(await shown(), ['toc-expand-all', 'toc-collapse-all', 'capture-mode-toggle', 'toc-collapse-toggle']);
  await page.click('#toc-collapse-toggle'); await wait(250);
  assert.deepStrictEqual(await shown(), ['toc-collapse-toggle'], 'the 36px rail keeps only its restore toggle');
});
check('desktop: in screenshot mode Esc closes an open diagram first and stays in the mode', DESKTOP, async (page) => {
  await page.click('#capture-mode-toggle'); await wait(300);
  await page.click('main.content .graphviz svg'); await wait(250);
  await page.keyboard.press('Escape'); await wait(250);
  const s = await page.evaluate(() => ({ lightbox: !document.querySelector('.lightbox').hidden, sidebar: document.querySelector('.reader-sidebar').getClientRects().length > 0 }));
  assert.deepStrictEqual(s, { lightbox: false, sidebar: false }, 'first Esc closes the diagram only');
  await page.keyboard.press('Escape'); await wait(250);
  assert.ok(await page.evaluate(() => document.querySelector('.reader-sidebar').getClientRects().length > 0), 'second Esc leaves the mode');
});

// ── Phone ───────────────────────────────────────────────────────────────────
check('phone: top bar holds the menu and the title; no sideways scroll; no edge shadow', PHONE, async (page) => {
  const bar = await page.$eval('#mobile-bar', (b) => { const r = b.getBoundingClientRect(); return { top: r.top, h: r.height, pos: getComputedStyle(b).position }; });
  assert.deepStrictEqual(bar, { top: 0, h: 44, pos: 'fixed' });
  assert.strictEqual(await page.$eval('#mobile-bar-title', (t) => t.textContent.trim()), 'Reader Fixture Spec');
  assert.ok((await overflowX(page)) <= 0, 'no horizontal page scroll');
  const side = await page.$eval('.reader-sidebar', (s) => ({ shadow: getComputedStyle(s).boxShadow, right: s.getBoundingClientRect().right }));
  assert.strictEqual(side.shadow, 'none', 'closed drawer casts no shadow onto the page edge');
  assert.ok(side.right <= 0, 'closed drawer is fully off screen');
});
check('phone: ☰ opens the drawer below the bar; ☰, the scrim and Esc close it', PHONE, async (page) => {
  const opened = () => page.evaluate(() => document.body.hasAttribute('data-sidebar-open'));
  await page.click('#sidebar-toggle');
  await wait(300);
  assert.ok(await opened(), 'menu opens the drawer');
  const r = await page.$eval('.reader-sidebar', (s) => { const b = s.getBoundingClientRect(); return { top: b.top, left: b.left }; });
  assert.deepStrictEqual(r, { top: 44, left: 0 });
  await page.click('#sidebar-toggle');
  await wait(300);
  assert.ok(!(await opened()), 'menu closes it again');
  await page.click('#sidebar-toggle');
  await wait(300);
  await page.mouse.click(PHONE.width - 10, PHONE.height - 100);
  await wait(300);
  assert.ok(!(await opened()), 'tapping the scrim closes it');
  await page.click('#sidebar-toggle');
  await wait(300);
  await page.keyboard.press('Escape');
  await wait(300);
  assert.ok(!(await opened()), 'Esc closes it');
});
check('phone: screenshot mode from the drawer closes it and hides the bar; Esc brings the bar back', PHONE, async (page) => {
  await page.evaluate(() => window.scrollTo(0, 1200)); await wait(300);
  const before = await readerShape(page);
  await page.click('#sidebar-toggle'); await wait(300);
  await page.click('#capture-mode-toggle'); await wait(300);
  const s = await readerShape(page);
  const lock = await page.evaluate(() => document.body.hasAttribute('data-sidebar-open') || document.documentElement.hasAttribute('data-sidebar-open'));
  assert.strictEqual(lock, false, 'the drawer and its scroll lock are released');
  assert.strictEqual(s.bar, false, 'top bar hidden, ' + JSON.stringify(s));
  assert.strictEqual(s.sidebar, false, 'drawer hidden, ' + JSON.stringify(s));
  assert.ok(Math.abs(s.w - before.w) <= 1, 'reading width kept: ' + before.w + ' -> ' + s.w);
  assert.ok(Math.abs(s.y - before.y) <= 1, 'reading position kept: ' + before.y + ' -> ' + s.y);
  assert.ok((await overflowX(page)) <= 0, 'no horizontal page scroll');
  await wait(2600);
  assert.deepStrictEqual(await stuckWhileScrolling(page, 400), [], 'nothing stays put while the page scrolls');
  await page.keyboard.press('Escape'); await wait(300);
  assert.strictEqual((await readerShape(page)).bar, true, 'Esc brings the bar back');
});
check('phone: a TOC jump closes the drawer, lands below the bar and renames the bar', PHONE, async (page) => {
  await page.click('#sidebar-toggle');
  await wait(300);
  await page.click('.toc-list a[href="#6-section-6"]');
  await wait(500);
  assert.ok(!(await page.evaluate(() => document.body.hasAttribute('data-sidebar-open'))), 'drawer closed');
  const top = await topOf(page, '6-section-6');
  assert.ok(top >= 44 && top <= 200, 'heading below the 44px bar, top=' + top);
  assert.strictEqual(await page.$eval('#mobile-bar-title', (t) => t.textContent.trim()), '6. Section 6');
});
check('phone: the wide table scrolls sideways and keeps the signal column', PHONE, async (page) => {
  await page.$eval('.content table', (t) => t.scrollIntoView({ block: 'center' }));
  await wait(200);
  const s = await page.$eval('.content table', (t) => ({ scrolls: t.scrollWidth > t.clientWidth, prose: t.querySelector('tbody td:last-child').getBoundingClientRect().width }));
  assert.ok(s.scrolls, 'table scrolls inside itself');
  assert.ok(s.prose >= 15 * 13.5 - 1, 'prose column >= 15em, got ' + s.prose);
  const stuck = await page.$eval('.content table', (t) => { t.scrollLeft = 200; const c = t.querySelector('tbody td:first-child').getBoundingClientRect(); return Math.abs(c.left - t.getBoundingClientRect().left); });
  assert.ok(stuck <= 1, 'first column stays at the left edge while scrolled, off by ' + stuck);
  assert.ok((await overflowX(page)) <= 0, 'the page itself does not scroll sideways');
});
check('phone: heading anchors stay hidden', PHONE, async (page) => {
  assert.strictEqual(await page.$eval('[id="5-section-5"] .heading-anchor', (a) => getComputedStyle(a).opacity), '0');
});
check('phone: search from the drawer; picking a result closes it and shows the hit below the bar', PHONE, async (page) => {
  await page.click('#sidebar-toggle');
  await wait(300);
  await page.fill('#doc-search-input', 'zebrafinch');
  await page.press('#doc-search-input', 'Enter');
  await wait(300);
  await page.click('.search-result-item >> nth=0');
  await wait(400);
  assert.ok(!(await page.evaluate(() => document.body.hasAttribute('data-sidebar-open'))), 'drawer closed');
  const hit = await page.$eval('mark.search-hit.is-selected', (m) => { const r = m.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
  assert.ok(hit.top >= 44 && hit.bottom <= PHONE.height, 'hit visible below the bar: ' + JSON.stringify(hit));
});

// ── Search marks across text nodes (R2) ─────────────────────────────────────
// A phrase that crosses a heading's .sec span, inline code, a soft line break or
// bold used to get no mark at all, and the reader fell back to the heading.
// Plain values only: the joined mark text, the mark count, and whether the
// first mark is fully inside the viewport.
async function selectedMarks(page) {
  return page.evaluate(() => {
    const marks = Array.from(document.querySelectorAll('mark.search-hit.is-selected'));
    let onScreen = false;
    if (marks.length) {
      const r = marks[0].getBoundingClientRect();
      onScreen = r.width > 0 && r.height > 0 && r.left >= -0.5 && r.top >= -0.5 &&
        r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5;
    }
    return {
      text: marks.map((m) => m.textContent).join('').replace(/\s+/g, ' ').toLowerCase(),
      count: marks.length,
      onScreen,
      top: marks.length ? Math.round(marks[0].getBoundingClientRect().top) : null,
    };
  });
}
async function searchFor(page, q) {
  await page.fill('#doc-search-input', q);
  await page.press('#doc-search-input', 'Enter');
  await wait(300);
  return selectedMarks(page);
}
check('search: a phrase across a heading number and its title', DESKTOP, async (page) => {
  await page.goto(FOLLOWUP_URL, { waitUntil: 'load' }); await wait(400);
  const r = await searchFor(page, '4.2 assumptions');
  assert.strictEqual(r.text, '4.2 assumptions', 'joined mark text, count=' + r.count);
  assert.ok(r.count >= 1, 'at least one mark, count=' + r.count);
  assert.strictEqual(r.onScreen, true, 'first mark on screen, top=' + r.top);
});
check('search: a phrase across inline code, a soft break and bold', DESKTOP, async (page) => {
  await page.goto(FOLLOWUP_URL, { waitUntil: 'load' }); await wait(400);
  for (const q of ['a rcv_v beat', 'alpha line bravo', 'words bold kiwi']) {
    const r = await searchFor(page, q);
    assert.strictEqual(r.text, q, q + ': joined mark text, count=' + r.count);
    assert.strictEqual(r.onScreen, true, q + ': first mark on screen, top=' + r.top);
  }
});
check('search: multi-node hits clear cleanly after next/prev', DESKTOP, async (page) => {
  await page.goto(FOLLOWUP_URL, { waitUntil: 'load' }); await wait(400);
  const before = await page.evaluate(() => document.querySelector('main.content').innerHTML);
  const q = 'a rcv_v beat';
  // Marks must exist before the clear, or a clean innerHTML proves nothing.
  const first = await searchFor(page, q);
  assert.strictEqual(first.text, q, 'searched: joined mark text, count=' + first.count);
  assert.ok(first.count > 1, 'the hit spans several marks, count=' + first.count);
  await page.click('#search-next'); await wait(300);
  const next = await selectedMarks(page);
  assert.strictEqual(next.text, q, 'after next: joined mark text, count=' + next.count);
  assert.ok(next.count > 1, 'after next: several marks, count=' + next.count);
  await page.click('#search-prev'); await wait(300);
  const prev = await selectedMarks(page);
  assert.strictEqual(prev.text, q, 'after prev: joined mark text, count=' + prev.count);
  assert.ok(prev.count > 1, 'after prev: several marks, count=' + prev.count);
  await page.click('#doc-search-clear'); await wait(200);
  const after = await page.evaluate(() => ({ html: document.querySelector('main.content').innerHTML, marks: document.querySelectorAll('mark').length }));
  assert.strictEqual(after.marks, 0, 'no mark left');
  assert.strictEqual(after.html === before, true, 'main.content innerHTML restored byte for byte (lengths ' + before.length + ' / ' + after.html.length + ')');
});
check('phone: a multi-node search from the drawer lands on screen', PHONE, async (page) => {
  await page.goto(FOLLOWUP_URL, { waitUntil: 'load' }); await wait(400);
  await page.click('#sidebar-toggle'); await wait(350);
  await searchFor(page, 'a rcv_v beat');
  await page.click('.search-result-item >> nth=0'); await wait(400);
  const r = await selectedMarks(page);
  assert.strictEqual(r.text, 'a rcv_v beat', 'joined mark text, count=' + r.count);
  assert.strictEqual(r.onScreen, true, 'first mark on screen, top=' + r.top);
  assert.ok(r.top >= 44, 'first mark below the bar, top=' + r.top);
});
check('search: a space that is its own text node between inline elements', DESKTOP, async (page) => {
  await page.goto(SEARCH_NODES_URL, { waitUntil: 'load' }); await wait(400);
  const before = await page.evaluate(() => document.querySelector('main.content').innerHTML);
  const r = await searchFor(page, 'bold italic');
  assert.strictEqual(r.text, 'bold italic', 'joined mark text, count=' + r.count);
  assert.strictEqual(r.onScreen, true, 'first mark on screen, top=' + r.top);
  await page.click('#doc-search-clear'); await wait(200);
  const after = await page.evaluate(() => ({ html: document.querySelector('main.content').innerHTML, marks: document.querySelectorAll('mark').length }));
  assert.strictEqual(after.marks, 0, 'no mark left');
  assert.strictEqual(after.html === before, true, 'main.content innerHTML restored byte for byte (lengths ' + before.length + ' / ' + after.html.length + ')');
});
check('search: next/prev move a multi-node hit between two sections, then clear', DESKTOP, async (page) => {
  await page.goto(SEARCH_NODES_URL, { waitUntil: 'load' }); await wait(400);
  const before = await page.evaluate(() => document.querySelector('main.content').innerHTML);
  const q = 'the tx_ready flag';
  // Which paragraph holds the selected hit, how many marks the whole page has,
  // and the result counter, as plain values.
  const where = () => page.evaluate(() => {
    const m = document.querySelector('mark.search-hit.is-selected');
    return {
      block: m ? m.closest('p').textContent : null,
      allMarks: document.querySelectorAll('main.content mark').length, // the results list has snippet marks of its own
      status: document.getElementById('search-result-count').textContent.trim(),
    };
  });
  const FIRST = 'The tx_ready flag rises.';
  const SECOND = 'Later the tx_ready flag falls.';
  const first = await searchFor(page, q);
  assert.strictEqual(first.text, q, 'searched: joined mark text, count=' + first.count);
  assert.strictEqual(first.count, 3, 'searched: one mark per node');
  const w1 = await where();
  assert.strictEqual(w1.block, FIRST, 'searched: the hit is in section 1');
  assert.strictEqual(w1.allMarks, 3, 'searched: only this hit is marked');
  const n = Number(w1.status.split('/')[1]);
  assert.strictEqual(w1.status, '1/' + n);
  assert.ok(n >= 2, 'the phrase is found in two sections, n=' + n);
  await page.click('#search-next'); await wait(300);
  const next = await selectedMarks(page);
  const w2 = await where();
  assert.strictEqual(next.text, q, 'after next: joined mark text, count=' + next.count);
  assert.strictEqual(w2.status, '2/' + n);
  assert.strictEqual(w2.block, SECOND, 'after next: the hit moved to section 2');
  assert.strictEqual(w2.allMarks, 3, 'after next: the old hit is unmarked');
  assert.strictEqual(next.onScreen, true, 'after next: first mark on screen, top=' + next.top);
  await page.click('#search-prev'); await wait(300);
  const prev = await selectedMarks(page);
  const w3 = await where();
  assert.strictEqual(prev.text, q, 'after prev: joined mark text, count=' + prev.count);
  assert.strictEqual(w3.status, '1/' + n);
  assert.strictEqual(w3.block, FIRST, 'after prev: the hit is back in section 1');
  assert.strictEqual(w3.allMarks, 3, 'after prev: the old hit is unmarked');
  assert.strictEqual(prev.onScreen, true, 'after prev: first mark on screen, top=' + prev.top);
  await page.click('#doc-search-clear'); await wait(200);
  const after = await page.evaluate(() => ({ html: document.querySelector('main.content').innerHTML, marks: document.querySelectorAll('mark').length }));
  assert.strictEqual(after.marks, 0, 'no mark left');
  assert.strictEqual(after.html === before, true, 'main.content innerHTML restored byte for byte (lengths ' + before.length + ' / ' + after.html.length + ')');
});

// T9b: the selected marks as a reader reads them. A formula reads as its TeX
// source (the rule the results list and the marks now share; its mark wraps the
// whole formula). Two consecutive marks in different blocks, or with a <br>
// between them, read with a space: the space a line or block break stands for
// is in no text node, so no mark can carry it. Plain values only.
async function markReading(page) {
  return page.evaluate(() => {
    const BLOCK = 'p, li, td, th, h1, h2, h3, h4, h5, h6, pre, blockquote, dt, dd, figcaption';
    const blockOf = (m) => m.querySelector('.katex-display') || m.closest(BLOCK);
    const marks = Array.from(document.querySelectorAll('main.content mark.search-hit.is-selected'));
    let reading = '';
    marks.forEach((m, i) => {
      if (i) {
        const gap = document.createRange();
        gap.setStartAfter(marks[i - 1]);
        gap.setEndBefore(m);
        if (gap.cloneContents().querySelector('br') || blockOf(marks[i - 1]) !== blockOf(m)) reading += ' ';
      }
      const tex = m.querySelector('annotation[encoding="application/x-tex"]');
      reading += tex ? tex.textContent : m.textContent;
    });
    let onScreen = false;
    let top = null;
    if (marks.length) {
      const r = marks[0].getBoundingClientRect();
      onScreen = r.width > 0 && r.height > 0 && r.left >= -0.5 && r.top >= -0.5 &&
        r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5;
      top = Math.round(r.top);
    }
    return {
      reading: reading.replace(/\s+/g, ' ').trim().toLowerCase(),
      count: marks.length,
      onScreen,
      top,
      status: document.getElementById('search-result-count').textContent.trim(),
    };
  });
}
check('search: math, a fenced code block and a hard break are marked wherever the list finds them', DESKTOP, async (page) => {
  await page.goto(SECTION_TEXT_URL, { waitUntil: 'load' }); await wait(400);
  const before = await page.evaluate(() => document.querySelector('main.content').innerHTML);
  // [query, results the list must report]. Collected, not thrown one by one,
  // so a red run names every shape that disagrees.
  const cases = [
    ['math x^2 + y inside', 1], // inline math, read as its TeX
    ['inside sentence. e = mc^2', 1], // into display math
    ['\\alpha + \\beta', 1], // a math fence
    ['const codeblock = 42', 1], // a name that only a code block holds
    ['inside blockquote. const codeblock', 1], // into a code block
    ['code comment words para after', 1], // out of a code block
    ['line one hard', 1], // across a hard break
    ['inside blockquote. para after', 0], // a code block sits between them on both sides
    ['oneh', 0], // a hard break reads as a space, never as nothing
    ['codeline inside after code tail', 1], // a list item's text after its code block
    ['alpha item after code tail', 0], // the code block sits between them on both sides
    ['nested bee loose tail words', 1], // a loose item's paragraph after its nested list
  ];
  const problems = [];
  for (const [q, n] of cases) {
    await searchFor(page, q);
    let r = await markReading(page);
    const results = r.status === '0' ? 0 : Number(r.status.split('/')[1]);
    if (results !== n) problems.push(q + ': ' + results + ' results, want ' + n);
    for (let i = 0; i < results; i++) {
      if (i) { await page.click('#search-next'); await wait(300); r = await markReading(page); }
      if (r.reading !== q) problems.push(q + ' #' + (i + 1) + ': marks read ' + JSON.stringify(r.reading) + ', count=' + r.count);
      else if (!r.onScreen) problems.push(q + ' #' + (i + 1) + ': first mark off screen, top=' + r.top);
    }
    await page.click('#doc-search-clear'); await wait(200);
    const after = await page.evaluate(() => ({ html: document.querySelector('main.content').innerHTML, marks: document.querySelectorAll('main.content mark').length }));
    if (after.marks !== 0 || after.html !== before) {
      problems.push(q + ': after clear ' + after.marks + ' marks, innerHTML ' + (after.html === before ? 'restored' : 'changed (lengths ' + before.length + ' / ' + after.html.length + ')'));
    }
  }
  assert.deepStrictEqual(problems, []);
});
// Fix round 1: a display formula's mark is a direct child of main.content, so
// the zoom/resize anchor could pin the mark itself; clearing the search then
// removed the anchor, and the next resize lost the reading position.
check('search: clearing a display-formula hit keeps the resize anchor', DESKTOP, async (page) => {
  await page.goto(SECTION_TEXT_URL, { waitUntil: 'load' }); await wait(400);
  const formulaTop = () => page.evaluate(() => {
    const ann = Array.from(document.querySelectorAll('annotation')).find((a) => a.textContent.trim() === 'E = mc^2');
    return ann.closest('.katex').getBoundingClientRect().top;
  });
  await searchFor(page, 'e = mc^2');
  const marked = await page.evaluate(() => {
    const m = document.querySelector('main.content mark.search-hit.is-selected');
    return m ? m.parentElement.tagName + '>' + m.className : null;
  });
  assert.strictEqual(marked, 'MAIN>search-hit is-selected search-hit-math search-hit-block', 'the display formula is marked as a block child of the column');
  // Put the marked formula on the anchor line (80px), let the scroll capture it, then clear.
  await page.evaluate(() => {
    const ann = Array.from(document.querySelectorAll('annotation')).find((a) => a.textContent.trim() === 'E = mc^2');
    window.scrollTo(0, window.scrollY + ann.closest('.katex').getBoundingClientRect().top - 70);
  });
  await wait(300);
  await page.click('#doc-search-clear'); await wait(300);
  const top0 = await formulaTop();
  await page.setViewportSize({ width: 900, height: 900 }); await wait(500);
  const top1 = await formulaTop();
  assert.ok(Math.abs(top1 - top0) <= 1, 'the formula stays put across the resize: ' + top0.toFixed(1) + ' -> ' + top1.toFixed(1));
});
check('phone: a math hit from the drawer lands on screen', PHONE, async (page) => {
  await page.goto(SECTION_TEXT_URL, { waitUntil: 'load' }); await wait(400);
  await page.click('#sidebar-toggle'); await wait(350);
  await searchFor(page, 'math x^2 + y inside');
  await page.click('.search-result-item >> nth=0'); await wait(400);
  const r = await markReading(page);
  assert.strictEqual(r.reading, 'math x^2 + y inside', 'marks read as the query, count=' + r.count);
  assert.strictEqual(r.onScreen, true, 'first mark on screen, top=' + r.top);
  assert.ok(r.top >= 44, 'first mark below the bar, top=' + r.top);
});

// Tab (keyboard modality, so :focus-visible matches) until the focused element
// satisfies `sel`; returns false when it is not reached within `max` presses.
async function tabUntil(page, sel, max) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate((q) => !!document.activeElement.closest(q), sel)) return true;
  }
  return false;
}
check('desktop: a focused search result shows its full ring (not clipped by the list)', DESKTOP, async (page) => {
  await page.fill('#doc-search-input', 'zebrafinch');
  await page.press('#doc-search-input', 'Enter');
  await wait(300);
  assert.ok(await tabUntil(page, '.search-result-item', 14), 'Tab reaches a search result');
  const r = await focusRing(page);
  assert.strictEqual(r.outline.split(' ').slice(0, 2).join(' '), 'solid 2px', 'result ring is drawn');
  assert.deepStrictEqual(r.clippers, [], 'result ring clipped by ' + r.clippers.join(', '));
});
check('desktop: a focused TOC row lifts the edge fade so its ring is whole', DESKTOP, async (page) => {
  const mask = () => page.$eval('.toc > .toc-list', (e) => { const c = getComputedStyle(e); return { m: c.maskImage, w: c.webkitMaskImage }; });
  const rest = await mask();
  assert.ok((rest.m || rest.w) !== 'none', 'guard: the fade exists while nothing is focused ' + JSON.stringify(rest));
  await page.focus('#doc-search-input');
  assert.ok(await tabUntil(page, '.toc-list', 14), 'Tab reaches a TOC row');
  const on = await mask();
  assert.ok(on.m === 'none' || on.m === undefined || on.m === '', 'mask-image lifted: ' + JSON.stringify(on));
  assert.ok(on.w === 'none' || on.w === undefined || on.w === '', 'webkit mask lifted: ' + JSON.stringify(on));
});
check('desktop: the long 3.3 title overflows the TOC list so it can peek sideways', DESKTOP, async (page) => {
  // The 3.3 row sits inside a collapsed section until the tree is expanded.
  await page.click('#toc-expand-all');
  await wait(200);
  const d = await page.$eval('.toc > .toc-list', (e) => ({ sw: e.scrollWidth, cw: e.clientWidth }));
  assert.ok(d.sw > d.cw, 'toc-list scrollWidth ' + d.sw + ' should exceed clientWidth ' + d.cw);
  const link = await page.$$eval('.toc a', (as) => {
    const a = as.find((x) => x.textContent.includes('3.3'));
    return a ? a.getBoundingClientRect().width : 0;
  });
  assert.ok(link > d.cw, 'the 3.3 link is ' + link + 'px wide, which should exceed the list clientWidth ' + d.cw);
});

// Cursors: hover each drag / zoom target for real and read the cursor of the
// element actually under the pointer. The banned set is the ten keywords that
// Chromium on Windows draws from its own bitmaps, ignoring the user's pointer
// size and colour (see the matching scan in reader-design.test.js).
const BITMAP_CURSORS = ['col-resize', 'row-resize', 'grab', 'grabbing', 'zoom-in', 'zoom-out', 'cell', 'alias', 'copy', 'vertical-text'];
async function cursorAt(page, x, y) {
  return page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py);
    return el ? { cursor: getComputedStyle(el).cursor, el: el.className && el.className.baseVal !== undefined ? el.tagName : (el.id || el.className || el.tagName) } : null;
  }, [x, y]);
}
async function centreOf(page, sel) {
  return page.$eval(sel, (e) => { e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
}
check('desktop: drag and zoom targets use cursors that follow the system pointer settings', DESKTOP, async (page) => {
  const seen = {};
  const split = await centreOf(page, '.sidebar-splitter');
  await page.mouse.move(split.x, split.y);
  seen.splitter = await cursorAt(page, split.x, split.y);
  assert.strictEqual(seen.splitter.cursor, 'ew-resize', 'sidebar splitter ' + JSON.stringify(seen.splitter));
  const fig = await centreOf(page, '.content .graphviz');
  await page.mouse.move(fig.x, fig.y);
  seen.diagram = await cursorAt(page, fig.x, fig.y);
  assert.strictEqual(seen.diagram.cursor, 'pointer', 'diagram ' + JSON.stringify(seen.diagram));
  await page.mouse.click(fig.x, fig.y);
  await wait(400);
  const stage = await page.$eval('.lightbox-stage', (s) => { const r = s.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(stage.x, stage.y);
  seen.stage = await cursorAt(page, stage.x, stage.y);
  await page.mouse.down();
  await page.mouse.move(stage.x + 30, stage.y + 20, { steps: 4 });
  seen.panning = await cursorAt(page, stage.x + 30, stage.y + 20);
  const panningAttr = await page.$eval('.lightbox-stage', (s) => s.hasAttribute('data-panning'));
  await page.mouse.up();
  assert.ok(panningAttr, 'guard: the press really started a pan');
  for (const k of ['stage', 'panning']) {
    assert.strictEqual(seen[k].cursor, 'move', 'lightbox ' + k + ' ' + JSON.stringify(seen[k]));
  }
  for (const k of Object.keys(seen)) {
    assert.ok(BITMAP_CURSORS.indexOf(seen[k].cursor) === -1, k + ' uses a browser-bitmap cursor: ' + seen[k].cursor);
  }
});

// ── Theme (v3.9.0) ──────────────────────────────────────────────────────────
async function themeState(page) {
  return page.evaluate(() => {
    const b = document.getElementById('md2doc-theme-toggle');
    return { attr: document.documentElement.getAttribute('data-md2doc-theme'), bg: getComputedStyle(document.body).backgroundColor,
      icon: b.textContent, label: b.getAttribute('aria-label'), cursor: getComputedStyle(b).cursor };
  });
}
async function gotoTheme(page, url) { await page.goto(url || THEME_URL, { waitUntil: 'load' }); await wait(800); }

check('desktop: theme starts light even when the OS asks for dark', DESKTOP, async (page) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await gotoTheme(page);
  const s = await themeState(page);
  assert.deepStrictEqual([s.attr, s.bg, s.icon], [null, 'rgb(255, 255, 255)', '☀']);
  assert.strictEqual(s.label, 'Light theme (click for dark)');
  assert.strictEqual(s.cursor, 'pointer');
});
check('desktop: the bubble toggles dark and back, bottom-right', DESKTOP, async (page) => {
  await gotoTheme(page);
  const r = await page.$eval('#md2doc-theme-toggle', (b) => { const x = b.getBoundingClientRect(); const d = document.documentElement; return { right: d.clientWidth - x.right, bottom: d.clientHeight - x.bottom, w: x.width }; });
  assert.deepStrictEqual(r, { right: 20, bottom: 20, w: 40 });
  await page.click('#md2doc-theme-toggle'); await wait(300);
  let s = await themeState(page);
  assert.deepStrictEqual([s.attr, s.bg, s.icon, s.label], ['dark', 'rgb(27, 27, 29)', '☾', 'Dark theme (click for light)']);
  await page.click('#md2doc-theme-toggle'); await wait(300);
  s = await themeState(page);
  assert.deepStrictEqual([s.attr, s.bg, s.icon], [null, 'rgb(255, 255, 255)', '☀']);
});
check('desktop: the dark choice survives a reload and is set before first paint', DESKTOP, async (page) => {
  await gotoTheme(page);
  await page.click('#md2doc-theme-toggle'); await wait(200);
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => { window.__attrAtDcl = document.documentElement.getAttribute('data-md2doc-theme'); });
  });
  await page.reload({ waitUntil: 'load' }); await wait(500);
  const s = await themeState(page);
  assert.strictEqual(s.attr, 'dark');
  assert.strictEqual(await page.evaluate(() => window.__attrAtDcl), 'dark', 'attribute already set at DOMContentLoaded');
});
check('desktop: blocked storage keeps the page light and the toggle still works', DESKTOP, async (page) => {
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });
  });
  await gotoTheme(page);
  assert.strictEqual((await themeState(page)).attr, null);
  await page.click('#md2doc-theme-toggle'); await wait(300);
  assert.strictEqual((await themeState(page)).attr, 'dark');
  assert.deepStrictEqual(errs, []);
});
// ── R8 (v3.13.1): contrast with alpha. The older checks took rgba(0,0,0,0.8) as opaque black.
// Injected as a string so every check shares one definition of "colour as drawn".
const CONTRAST_ALPHA_JS = `(() => {
  function rgba(s) { const n = (s.match(/[\\d.]+/g) || []).map(Number); return [n[0], n[1], n[2], n.length > 3 ? n[3] : 1]; }
  function over(fg, bg) { const a = fg[3]; return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1]; }
  function bgOf(el) {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const c = rgba(getComputedStyle(e).backgroundColor);
      if (c[3] === 0) continue;
      layers.push(c);
      if (c[3] === 1) break;
    }
    let base = [255, 255, 255, 1];
    if (layers.length && layers[layers.length - 1][3] === 1) base = layers.pop();
    while (layers.length) base = over(layers.pop(), base);
    return base;
  }
  function lum(c) { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }
  function ratio(fgCss, el) {
    const bg = bgOf(el); const fg = over(rgba(fgCss), bg);
    const x = lum(fg), y = lum(bg);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  window.__c = { rgba, over, bgOf, ratio };
})();`;
check('desktop: dark text meets WCAG AA where it is actually drawn', DESKTOP, async (page) => {
  await gotoTheme(page);
  await page.click('#md2doc-theme-toggle'); await wait(500);
  const on = await themeState(page);
  assert.deepStrictEqual([on.attr, on.bg], ['dark', 'rgb(27, 27, 29)'], 'dark is actually on before measuring');
  await page.fill('#doc-search-input', 'zebrafinch'); await page.press('#doc-search-input', 'Enter'); await wait(400);
  await page.addScriptTag({ content: CONTRAST_ALPHA_JS });
  const pairs = await page.evaluate(() => {
    const sel = { body: '.content p', code: '.content :not(pre) > code', link: '.content a', toc: '.toc-list a', active: '.toc a.is-active', mark: 'mark.search-hit.is-selected', snippet: '.search-result-snippet' };
    const out = {};
    for (const k in sel) { const e = document.querySelector(sel[k]); if (e) out[k] = +window.__c.ratio(getComputedStyle(e).color, e).toFixed(2); }
    return out;
  });
  for (const k of ['body', 'code', 'link', 'toc', 'active', 'mark', 'snippet']) {
    assert.ok(typeof pairs[k] === 'number', k + ' was not measured: ' + JSON.stringify(pairs));
    assert.ok(pairs[k] >= 4.5, k + ' ' + pairs[k] + ' ' + JSON.stringify(pairs));
  }
});
check('phone: the toggle sits at the right end of the top bar, not floating', PHONE, async (page) => {
  await gotoTheme(page);
  const r = await page.evaluate(() => {
    const b = document.getElementById('md2doc-theme-toggle'); const bar = document.getElementById('mobile-bar');
    const x = b.getBoundingClientRect(); const y = bar.getBoundingClientRect();
    const cx = x.left + x.width / 2; const cy = x.top + x.height / 2;
    return { inBar: b.parentNode === bar, centreInBar: cx > y.left && cx < y.right && cy > y.top && cy < y.bottom,
      hit: document.elementFromPoint(cx, cy) === b, rightGap: Math.round(y.right - x.right), count: document.querySelectorAll('.md2doc-theme-toggle').length };
  });
  assert.deepStrictEqual(r, { inBar: true, centreInBar: true, hit: true, rightGap: 12, count: 1 });
  await page.click('#md2doc-theme-toggle'); await wait(300);
  assert.strictEqual((await themeState(page)).attr, 'dark');
});
check('phone: top bar text meets WCAG AA in light and dark, alpha included', PHONE, async (page) => {
  await gotoTheme(page);
  await page.addScriptTag({ content: CONTRAST_ALPHA_JS });
  // Self-test: black at 0.8 alpha over white is #333, ratio 12.63. An alpha-blind helper reads 21.
  const self = await page.evaluate(() => { const d = document.createElement('div'); d.style.background = '#fff'; document.body.appendChild(d); const r = window.__c.ratio('rgba(0, 0, 0, 0.8)', d); d.remove(); return +r.toFixed(2); });
  assert.strictEqual(self, 12.63, 'helper blends alpha');
  const ids = ['sidebar-toggle', 'mobile-bar-title', 'md2doc-theme-toggle'];
  const measure = () => page.evaluate((list) => list.map((id) => { const e = document.getElementById(id); return { id, ratio: +window.__c.ratio(getComputedStyle(e).color, e).toFixed(2) }; }), ids);
  const light = await measure();
  await page.click('#md2doc-theme-toggle'); await wait(500);
  assert.strictEqual((await themeState(page)).attr, 'dark', 'dark is on before measuring');
  const dark = await measure();
  for (const r of light.concat(dark)) assert.ok(r.ratio >= 4.5, r.id + ' ' + r.ratio + ' ' + JSON.stringify({ light, dark }));
});
check('desktop: resizing across 1080px moves the toggle between bubble and bar', DESKTOP, async (page) => {
  await gotoTheme(page);
  const where = () => page.evaluate(() => document.getElementById('md2doc-theme-toggle').parentNode.id || document.getElementById('md2doc-theme-toggle').parentNode.tagName);
  assert.strictEqual(await where(), 'BODY');
  await page.setViewportSize({ width: 900, height: 900 }); await wait(300);
  assert.strictEqual(await where(), 'mobile-bar');
  await page.setViewportSize({ width: 1440, height: 900 }); await wait(300);
  assert.strictEqual(await where(), 'BODY');
});
check('phone: a heading-less document keeps the toggle floating and raises no error', PHONE, async (page) => {
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await gotoTheme(page, PLAIN_URL);
  const r = await page.$eval('#md2doc-theme-toggle', (b) => { const x = b.getBoundingClientRect(); const d = document.documentElement; return { pos: getComputedStyle(b).position, right: d.clientWidth - x.right, bottom: d.clientHeight - x.bottom }; });
  assert.deepStrictEqual(r, { pos: 'fixed', right: 20, bottom: 20 });
  await page.click('#md2doc-theme-toggle'); await wait(300);
  assert.strictEqual((await themeState(page)).attr, 'dark');
  assert.deepStrictEqual(errs, []);
});

async function mermaidFill(page) {
  return page.$eval('.content .mermaid svg .node rect, .content .mermaid svg .node polygon', (r) => getComputedStyle(r).fill);
}
check('desktop: mermaid redraws dark and swaps back to the same light render', DESKTOP, async (page) => {
  await gotoTheme(page); await wait(1200);
  const light = await mermaidFill(page);
  assert.strictEqual(light, 'rgb(234, 242, 253)', 'light primaryColor');
  await page.evaluate(() => { window.__runs = 0; const render = mermaid.render.bind(mermaid); mermaid.render = (a, b) => { window.__runs++; return render(a, b); }; });
  await page.click('#md2doc-theme-toggle'); await wait(1500);
  assert.strictEqual(await mermaidFill(page), 'rgb(36, 54, 79)', 'dark primaryColor');
  assert.strictEqual(await page.$eval('.content .mermaid svg', (s) => s.hasAttribute('data-md2doc-recoloured')), true);
  await page.click('#md2doc-theme-toggle'); await wait(500);
  assert.strictEqual(await mermaidFill(page), light);
  await page.click('#md2doc-theme-toggle'); await wait(500);
  assert.strictEqual(await mermaidFill(page), 'rgb(36, 54, 79)');
  assert.strictEqual(await page.evaluate(() => window.__runs), 1, 'dark drawn once, then cached');
});
check('desktop: a saved dark choice draws mermaid dark on load', DESKTOP, async (page) => {
  await page.addInitScript(() => { try { localStorage.setItem('md2doc-theme', 'dark'); } catch (e) {} });
  await gotoTheme(page); await wait(1500);
  assert.strictEqual(await mermaidFill(page), 'rgb(36, 54, 79)');
});
check('desktop: two quick toggles while dark is still drawing end light', DESKTOP, async (page) => {
  await gotoTheme(page); await wait(1200);
  await page.evaluate(() => { window.__runs = 0; const render = mermaid.render.bind(mermaid); mermaid.render = (a, b) => { window.__runs++; return new Promise((r) => setTimeout(r, 600)).then(() => render(a, b)); }; });
  await page.click('#md2doc-theme-toggle'); await page.click('#md2doc-theme-toggle');
  await wait(2500);
  assert.strictEqual((await themeState(page)).attr, null);
  assert.strictEqual(await mermaidFill(page), 'rgb(234, 242, 253)');
  assert.strictEqual(await page.evaluate(() => window.__runs), 1, 'one dark draw, then light from cache');
});
check('desktop: printing while dark shows the light mermaid render, then restores dark', DESKTOP, async (page) => {
  await gotoTheme(page); await wait(1200);
  await page.click('#md2doc-theme-toggle'); await wait(1500);
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  assert.strictEqual(await mermaidFill(page), 'rgb(234, 242, 253)', 'light while printing');
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  assert.strictEqual(await mermaidFill(page), 'rgb(36, 54, 79)', 'dark again after print');
});

async function gvState(page) {
  return page.$eval('.content .graphviz svg', (svg) => {
    const node = svg.querySelector('g.node polygon'); const text = svg.querySelector('g.node text'); const edge = svg.querySelector('g.edge path');
    return { node: getComputedStyle(node).fill, text: getComputedStyle(text).fill, edge: getComputedStyle(edge).stroke, flagged: svg.hasAttribute('data-md2doc-recoloured') };
  });
}
check('desktop: graphviz follows dark and restores its own colours exactly', DESKTOP, async (page) => {
  await gotoTheme(page); await wait(800);
  const light = await gvState(page);
  assert.deepStrictEqual(light, { node: 'rgb(144, 202, 249)', text: 'rgb(0, 0, 0)', edge: 'rgb(0, 0, 0)', flagged: false });
  const before = await page.$$eval('.content .graphviz svg *', (els) => els.map((e) => e.getAttribute('style')));
  await page.click('#md2doc-theme-toggle'); await wait(500);
  const dark = await gvState(page);
  assert.strictEqual(dark.text, 'rgb(227, 227, 227)', 'black label text becomes #e3e3e3');
  assert.strictEqual(dark.edge, 'rgb(196, 199, 204)', 'black edge becomes ink #c4c7cc');
  assert.notStrictEqual(dark.node, light.node, 'light blue fill is darkened');
  assert.ok(dark.flagged);
  await page.click('#md2doc-theme-toggle'); await wait(500);
  assert.deepStrictEqual(await gvState(page), light);
  const after = await page.$$eval('.content .graphviz svg *', (els) => els.map((e) => e.getAttribute('style')));
  assert.deepStrictEqual(after, before, 'every style attribute restored');
});
// ── R8 (v3.13.1): print restore for graphviz and WaveDrom, like the mermaid one above.
// GUARD: pins existing behaviour, expected green when written (R3); can-fail evidence is in the task report.
async function printState(page) {
  return page.evaluate(() => {
    const gv = document.querySelector('.content .graphviz svg');
    const wd = document.querySelector('[id^="WaveDrom_Display_"] svg');
    return { gvText: getComputedStyle(gv.querySelector('g.node text')).fill, gvEdge: getComputedStyle(gv.querySelector('g.edge path')).stroke,
      gvFlag: gv.hasAttribute('data-md2doc-recoloured'), wdText: getComputedStyle(wd.querySelector('text')).fill, wdFlag: wd.hasAttribute('data-md2doc-recoloured'),
      styles: [].slice.call(gv.querySelectorAll('*')).concat([].slice.call(wd.querySelectorAll('*'))).map((e) => e.getAttribute('style')) };
  });
}
check('desktop: printing while dark shows light graphviz and WaveDrom, then restores dark', DESKTOP, async (page) => {
  await gotoTheme(page); await wait(1200);
  const light = await printState(page);
  await page.click('#md2doc-theme-toggle'); await wait(1500);
  const dark = await printState(page);
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  const printing = await printState(page);
  assert.deepStrictEqual(printing, light, 'light while printing');
  assert.deepStrictEqual({ gvText: light.gvText, gvEdge: light.gvEdge, gvFlag: light.gvFlag, wdText: light.wdText, wdFlag: light.wdFlag }, { gvText: 'rgb(0, 0, 0)', gvEdge: 'rgb(0, 0, 0)', gvFlag: false, wdText: 'rgb(0, 65, 196)', wdFlag: false });
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  const back = await printState(page);
  assert.deepStrictEqual(back, dark, 'dark again after print');
  assert.strictEqual(dark.wdText, 'rgb(160, 186, 238)');
  assert.strictEqual(dark.gvText, 'rgb(227, 227, 227)');
});
// ── R7 (v3.13.1): a text picks between its author colour and the dark rule's
// replacement, whichever reads better on the FINAL dark fill of its own shape.
// One fixture, shared with the inline-svg plate check below (which appends a line).
const D10_MD = ['# D10 fills', '', '## 1. Graphviz', '',
  '\x60\x60\x60dot', 'digraph { node [shape=box, style=filled];',
  '  mid [label="MID888", fillcolor="#888888", fontcolor="#222222"];',
  '  mid2 [label="MID777", fillcolor="#777777", fontcolor="#000000"];',
  '  blue [label="BLUE", fillcolor="#4a90d9", fontcolor="#111111"];',
  '  light [label="LIGHT", fillcolor="#e0e0e0"];',
  '  mid -> light; mid2 -> blue; }', '\x60\x60\x60', '',
  // Fix round 1: a text sits on whatever shape is painted under it, not on its
  // node's first shape — register tables (a polygon per cell), a white node in a
  // filled cluster, saturated author text on a toned fill.
  '\x60\x60\x60dot', 'digraph { node [shape=plaintext];',
  '  reg1 [label=<<table border="0" cellborder="1" cellspacing="0"><tr><td bgcolor="#4a90d9">REGHDR</td></tr><tr><td>BODYDEF</td></tr>' +
    '<tr><td bgcolor="white">BODYWHITE</td></tr><tr><td bgcolor="lightgrey">BODYLG</td></tr></table>>];',
  '  reg2 [label=<<table border="0" cellborder="1" cellspacing="0"><tr><td bgcolor="#888888">HDR888</td></tr><tr><td>BODY2</td></tr></table>>];',
  '  htm [label=<<table bgcolor="#888888"><tr><td><font color="#222222">HTMLT</font></td><td bgcolor="#e0e0e0"><font color="#222222">HTMLC</font></td></tr></table>>];',
  '  amber [shape=box, style=filled, label="AMBERBLUE", fillcolor="#ffd54f", fontcolor="#1565c0"];',
  '  greyblue [shape=box, style=filled, label="GREYBLUE", fillcolor="#c0c0c0", fontcolor="#0000cc"];',
  '  subgraph cluster_x { label="CLUS"; style=filled; fillcolor="#888888"; fontcolor="#222222"; inner [shape=box, style=filled, label="INNER", fillcolor="#ffffff"]; }',
  // Fix round 2: semi-transparent fills (graphviz #RRGGBBAA → fill-opacity) are composited.
  '  alpha [shape=box, style=filled, label="ALPHA", fillcolor="#88888833", fontcolor="#222222"];',
  '  alpha2 [shape=box, style=filled, label="ALPHA2", fillcolor="#4a90d940", fontcolor="#111111"];',
  '  talpha [label=<<table border="0" cellborder="1" cellspacing="0"><tr><td bgcolor="#88888833">TALPHA</td></tr></table>>];',
  '  reg1 -> reg2 -> htm; amber -> greyblue -> inner; alpha -> alpha2 -> talpha; }', '\x60\x60\x60', '',
  '## 2. Mermaid', '',
  '\x60\x60\x60mermaid', 'graph LR', '  A[MIDM] --> B[Plain]', '  C((MCIRC)) --> F[MBOX]', '  style A fill:#888888,color:#222222',
  '  style C fill:#888888,color:#222222', '  style F fill:#ffd54f,color:#1565c0', '\x60\x60\x60', ''];
let d10Url = null;
const d10 = () => d10Url || (d10Url = fixtureUrl('d10', D10_MD));
// Every graphviz and mermaid text, measured the way the browser paints it: the
// filled svg shapes under the text's centre (elementsFromPoint, after scrolling
// it into view), each with its alpha (fill alpha x fill-opacity x opacity),
// composited down to the first opaque one or the body. Plain values only.
function leafContrast(page) {
  return page.evaluate(() => {
    function f(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    function parse(s) { const n = (String(s).match(/[\d.]+/g) || []).map(Number); return n.length < 3 ? null : [n[0], n[1], n[2], n.length > 3 ? n[3] : 1]; }
    function lum(c) { return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }
    const leaves = [];
    document.querySelectorAll('.content .graphviz svg text, .content .mermaid svg text').forEach((t) => { if (t.textContent.trim()) leaves.push([t, 'fill']); });
    document.querySelectorAll('.content .mermaid svg foreignObject *').forEach((e) => {
      if ([].some.call(e.childNodes, (c) => c.nodeType === 3 && c.textContent.trim())) leaves.push([e, 'color']);
    });
    const out = {};
    for (const [el, prop] of leaves) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      const layers = []; let by = 'body';
      for (const s of document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)) {
        if (s === el || el.contains(s) || s.contains(el)) continue;
        if (s.namespaceURI !== 'http://www.w3.org/2000/svg' || !/^(polygon|ellipse|path|rect|circle)$/i.test(s.tagName)) continue;
        const cs = getComputedStyle(s); const fl = parse(cs.fill);
        if (!fl) continue;
        let a = fl[3] * Number(cs.fillOpacity) * Number(cs.opacity);
        for (let p = s.parentElement; p && p.tagName.toLowerCase() !== 'svg'; p = p.parentElement) a *= Number(getComputedStyle(p).opacity);
        if (a <= 0) continue;
        layers.push([fl, a]); by = (by === 'body' ? '' : by + '<') + s.tagName + (a < 1 ? '@' + a.toFixed(2) : '');
        if (a >= 1) break;
      }
      let under = parse(getComputedStyle(document.body).backgroundColor).slice(0, 3);
      for (let i = layers.length - 1; i >= 0; i--) { const [c, a] = layers[i]; under = under.map((v, j) => c[j] * a + v * (1 - a)); }
      const own = getComputedStyle(el)[prop]; const a = lum(parse(own)); const b = lum(under);
      out[el.textContent.trim()] = { own, under: 'rgb(' + under.map(Math.round).join(', ') + ')', by,
        ratio: Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100 };
    }
    return out;
  });
}
// WCAG ratio of each node's text in the FIRST graphviz block against its own
// shape (the body background where the shape is transparent), as plain values.
function pairs(page) {
  return page.evaluate(() => {
    function f(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    function parse(s) { const n = (s.match(/[\d.]+/g) || []).map(Number); return n.length < 3 ? null : [n[0], n[1], n[2], n.length > 3 ? n[3] : 1]; }
    function lum(c) { return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }
    const out = {};
    document.querySelector('.content .graphviz svg').querySelectorAll('g.node').forEach((g) => {
      const t = g.querySelector('text'); const s = g.querySelector('polygon');
      const text = getComputedStyle(t).fill; const shape = getComputedStyle(s).fill;
      let under = parse(shape);
      if (!under || under[3] === 0) under = parse(getComputedStyle(document.body).backgroundColor);
      const a = lum(parse(text)); const b = lum(under);
      out[t.textContent.trim()] = { text, shape, ratio: Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100 };
    });
    return out;
  });
}
function mermaidMid(page) {
  return page.evaluate(() => {
    const n = [].find.call(document.querySelectorAll('.content .mermaid svg g.node'), (g) => /MIDM/.test(g.textContent));
    if (!n) return null;
    const label = [].find.call(n.querySelectorAll('foreignObject *'), (e) => [].some.call(e.childNodes, (c) => c.nodeType === 3 && /MIDM/.test(c.textContent)));
    const shape = [].find.call(n.querySelectorAll('polygon, ellipse, path, rect'), (e) => !e.closest('foreignObject'));
    return { color: label ? getComputedStyle(label).color : null, fill: shape ? getComputedStyle(shape).fill : null,
      live: n.ownerSVGElement.hasAttribute('data-md2doc-live') };
  });
}
for (const [label, vp] of [['desktop', DESKTOP], ['phone', PHONE]]) {
  check(label + ': dark fills: author text on a mid fill keeps its contrast', vp, async (page) => {
    await gotoTheme(page, d10()); await wait(400);
    const light = await pairs(page);
    assert.deepStrictEqual(Object.keys(light).sort(), ['BLUE', 'LIGHT', 'MID777', 'MID888'], 'guard: four graphviz nodes ' + JSON.stringify(light));
    const before = await page.$$eval('.content .graphviz svg *', (els) => els.map((e) => e.getAttribute('style')));
    await page.click('#md2doc-theme-toggle'); await wait(600);
    const dark = await pairs(page);
    const pin = { MID888: 'rgb(34, 34, 34)', MID777: 'rgb(0, 0, 0)', BLUE: 'rgb(17, 17, 17)' };
    for (const k of Object.keys(pin)) {
      assert.ok(dark[k].ratio >= Math.min(4.5, light[k].ratio), k + ' dark ' + JSON.stringify(dark[k]) + ' light ' + JSON.stringify(light[k]));
      assert.strictEqual(dark[k].text, pin[k], k + ' keeps its author text colour ' + JSON.stringify(dark[k]));
    }
    // #e0e0e0 (L≈0.745) is toned dark, not made transparent: the author's black loses to #e3e3e3.
    assert.strictEqual(dark.LIGHT.text, 'rgb(227, 227, 227)', 'LIGHT ' + JSON.stringify(dark.LIGHT));
    assert.ok(dark.LIGHT.ratio >= 4.5, 'LIGHT ' + JSON.stringify(dark.LIGHT));
    await page.click('#md2doc-theme-toggle'); await wait(600);
    const after = await page.$$eval('.content .graphviz svg *', (els) => els.map((e) => e.getAttribute('style')));
    assert.deepStrictEqual(after, before, 'every style attribute restored');
  });
  check(label + ': dark fills: a live mermaid label on a mid fill keeps its author colour', vp, async (page) => {
    await gotoTheme(page, d10()); await wait(1200);
    const light = await mermaidMid(page);
    assert.deepStrictEqual(light && [light.color, light.fill], ['rgb(34, 34, 34)', 'rgb(136, 136, 136)'], 'guard: measured light label/fill ' + JSON.stringify(light));
    await page.click('#md2doc-theme-toggle'); await wait(3000);
    const dark = await mermaidMid(page);
    assert.strictEqual(dark && dark.live, true, 'guard: the live dark render is shown ' + JSON.stringify(dark));
    assert.strictEqual(dark.fill, 'rgb(136, 136, 136)', 'guard: the author fill is untouched ' + JSON.stringify(dark));
    assert.strictEqual(dark.color, 'rgb(34, 34, 34)', 'label keeps #222 ' + JSON.stringify(dark));
  });
  check(label + ': dark fills: every diagram text keeps min(4.5, its light contrast) on what is painted under it', vp, async (page) => {
    await gotoTheme(page, d10()); await wait(1200);
    const light = await leafContrast(page);
    const want = ['MID888', 'MID777', 'BLUE', 'LIGHT', 'REGHDR', 'BODYDEF', 'BODYWHITE', 'BODYLG', 'HDR888', 'BODY2', 'HTMLT', 'HTMLC',
      'AMBERBLUE', 'GREYBLUE', 'CLUS', 'INNER', 'ALPHA', 'ALPHA2', 'TALPHA', 'MIDM', 'Plain', 'MCIRC', 'MBOX'];
    assert.deepStrictEqual(want.filter((k) => !light[k]), [], 'guard: every fixture text is measured ' + JSON.stringify(Object.keys(light)));
    const before = await page.$$eval('.content .graphviz svg *', (els) => els.map((e) => e.getAttribute('style')));
    await page.click('#md2doc-theme-toggle'); await wait(3000);
    const dark = await leafContrast(page);
    const short = Object.keys(light).filter((k) => !dark[k] || dark[k].ratio < Math.min(4.5, light[k].ratio))
      .map((k) => k + ' light ' + JSON.stringify(light[k]) + ' dark ' + JSON.stringify(dark[k]));
    assert.deepStrictEqual(short, [], 'texts below min(4.5, light contrast) in dark');
    await page.click('#md2doc-theme-toggle'); await wait(600);
    const after = await page.$$eval('.content .graphviz svg *', (els) => els.map((e) => e.getAttribute('style')));
    assert.deepStrictEqual(after, before, 'every graphviz style attribute restored');
  });
  // Fix round 2: a diagram that has no geometry while the theme flips (display:none)
  // pairs each text with its own node's shape instead of falling back to #e3e3e3.
  check(label + ': dark fills: a diagram hidden while toggling still pairs text with its node', vp, async (page) => {
    await gotoTheme(page, d10()); await wait(1200);
    const lightAll = await leafContrast(page);
    await page.evaluate(() => { document.querySelectorAll('.content .graphviz').forEach((g) => { g.style.display = 'none'; }); });
    await page.click('#md2doc-theme-toggle'); await wait(600);
    await page.evaluate(() => { document.querySelectorAll('.content .graphviz').forEach((g) => { g.style.display = ''; }); });
    await wait(300);
    const dark = await pairs(page);
    // Fix round 3: a multi-cell table node must not pair every cell's text with its
    // first cell. These rows passed at base (old rule) and must still pass hidden.
    const darkAll = await leafContrast(page);
    const rows = ['BODYDEF', 'BODYWHITE', 'BODYLG', 'BODY2', 'HTMLC'];
    const short = rows.filter((k) => !darkAll[k] || darkAll[k].ratio < Math.min(4.5, lightAll[k].ratio))
      .map((k) => k + ' light ' + JSON.stringify(lightAll[k]) + ' dark ' + JSON.stringify(darkAll[k]));
    assert.deepStrictEqual(short, [], 'hidden table rows below min(4.5, light contrast)');
    assert.strictEqual(dark.MID888.text, 'rgb(34, 34, 34)', 'MID888 keeps #222 on its #888 node ' + JSON.stringify(dark.MID888));
    assert.ok(dark.MID888.ratio >= 4.49, 'MID888 ' + JSON.stringify(dark.MID888));
    assert.strictEqual(dark.LIGHT.text, 'rgb(227, 227, 227)', 'LIGHT ' + JSON.stringify(dark.LIGHT));
  });
  // Fix round 3: the toggle reads its geometry before the theme flips, so no getBBox
  // runs in the click once the dark attribute is set (that read forces a layout of
  // the whole restyled page) — on the first toggle (light-drawn mermaid with an
  // author-styled node) and on a later one (the cached live dark mermaid is swapped in).
  check(label + ': dark fills: the toggle reads no diagram geometry after the theme flips', vp, async (page) => {
    await gotoTheme(page, d10()); await wait(1200);
    const darkClick = () => page.evaluate(() => {
      const st = { post: 0, pre: 0 };
      const o = SVGGraphicsElement.prototype.getBBox;
      SVGGraphicsElement.prototype.getBBox = function () {
        if (document.documentElement.getAttribute('data-md2doc-theme') === 'dark') st.post++; else st.pre++;
        return o.apply(this, arguments);
      };
      try { document.getElementById('md2doc-theme-toggle').click(); } finally { SVGGraphicsElement.prototype.getBBox = o; }
      return Object.assign(st, { dark: document.documentElement.getAttribute('data-md2doc-theme') === 'dark' });
    });
    const first = await darkClick();
    assert.strictEqual(first.dark, true, 'guard: dark after the first click');
    assert.ok(first.pre > 0, 'guard: geometry was read before the flip ' + JSON.stringify(first));
    assert.strictEqual(first.post, 0, 'first toggle: getBBox after the flip ' + JSON.stringify(first));
    await wait(3000);
    assert.strictEqual((await mermaidMid(page)).live, true, 'guard: the live dark mermaid is drawn');
    await page.click('#md2doc-theme-toggle'); await wait(800);
    const second = await darkClick();
    assert.strictEqual(second.dark, true, 'guard: dark after the second click');
    assert.strictEqual(second.post, 0, 'later toggle: getBBox after the flip ' + JSON.stringify(second));
    await wait(600);
    const m = await mermaidMid(page);
    assert.deepStrictEqual([m.live, m.color], [true, 'rgb(34, 34, 34)'], 'the swapped-in live label still keeps #222 ' + JSON.stringify(m));
  });
}
// R7 甲: a Markdown-native inline svg sits on a white plate in dark, inked #1f2328.
const INLINE_SVG = '<svg id="inl" width="200" height="60" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="198" height="58" fill="none" stroke="#000"/>' +
  '<text id="inltext" x="10" y="35" font-size="16">INLINE SVG</text><circle id="inldot" cx="180" cy="30" r="10" fill="currentColor"/></svg>';
let d10InlineUrl = null;
const d10Inline = () => d10InlineUrl || (d10InlineUrl = fixtureUrl('d10-inline', D10_MD.concat(['## 3. Inline', '', INLINE_SVG, ''])));
function inlineState(page) {
  return page.evaluate(() => {
    function f(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    function lum(s) { const c = s.match(/[\d.]+/g).slice(0, 3).map(Number); return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }
    const s = document.getElementById('inl'); const cs = getComputedStyle(s);
    const text = getComputedStyle(document.getElementById('inltext')).fill;
    const a = lum(text); const b = lum(cs.backgroundColor);
    return { wrapped: !!s.parentElement && s.parentElement.classList.contains('inline-svg'),
      backgroundColor: cs.backgroundColor, boxShadow: cs.boxShadow, color: cs.color,
      dot: getComputedStyle(document.getElementById('inldot')).fill, text,
      ratio: Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100 };
  });
}
for (const [label, vp] of [['desktop', DESKTOP], ['phone', PHONE]]) {
  check(label + ': dark fills: inline svg sits on a white plate in dark only', vp, async (page) => {
    await gotoTheme(page, d10Inline());
    const light = await inlineState(page);
    assert.strictEqual(light.wrapped, true, 'the native svg is wrapped in .inline-svg ' + JSON.stringify(light));
    assert.deepStrictEqual([light.backgroundColor, light.boxShadow], ['rgba(0, 0, 0, 0)', 'none'], 'light: no plate ' + JSON.stringify(light));
    await page.click('#md2doc-theme-toggle'); await wait(500);
    const dark = await inlineState(page);
    assert.strictEqual(dark.backgroundColor, 'rgb(255, 255, 255)', 'dark: white plate ' + JSON.stringify(dark));
    assert.strictEqual(dark.color, 'rgb(31, 35, 40)', 'dark: plate ink #1f2328 ' + JSON.stringify(dark));
    assert.strictEqual(dark.dot, 'rgb(31, 35, 40)', 'dark: currentColor follows the plate ink ' + JSON.stringify(dark));
    assert.ok(dark.ratio >= 4.5, 'dark: the text reads on the plate ' + JSON.stringify(dark));
  });
}
check('desktop: WaveDrom stays recoloured through its later redraw passes', DESKTOP, async (page) => {
  await page.addInitScript(() => { try { localStorage.setItem('md2doc-theme', 'dark'); } catch (e) {} });
  await gotoTheme(page); await wait(2000);
  const r = await page.$eval('[id^="WaveDrom_Display_"] svg', (svg) => {
    function f(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    const offenders = [];
    svg.querySelectorAll('text').forEach((t) => {
      const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(t).fill);
      if (!m) return;
      const c = m[1].split(',').map(parseFloat);
      const L = 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
      if (L < 0.35) offenders.push(t.textContent + ' ' + getComputedStyle(t).fill);
    });
    return { flagged: svg.hasAttribute('data-md2doc-recoloured'), text: getComputedStyle(svg.querySelector('text')).fill, offenders };
  });
  // The first <text> is the lane name, WaveDrom blue #0041c4. Spec D10: a
  // saturated colour (HSL s > 0.25) keeps its hue at L 0.78 -> rgb(160, 186, 238).
  assert.deepStrictEqual(r, { flagged: true, text: 'rgb(160, 186, 238)', offenders: [] });
});
// WaveDrom puts a white <rect> under every edge label (render-label.js: g > rect + text, inside
// wavearcs_N). D10 used to make it transparent like any near-white fill, so in dark the edge and
// the waveform ran straight through the label text. It must take the page colour instead; every
// other near-white fill (the graphviz white node here) still goes transparent.
check('desktop: dark WaveDrom edge labels keep a page-coloured backing, other white fills still go transparent', DESKTOP, async (page) => {
  const url = fixtureUrl('wave-label-bg', ['# Wave labels', '', '## 1. A', '',
    '\x60\x60\x60wavedrom',
    '{ "signal": [ { "name": "a", "wave": "01..0.", "node": ".A" }, { "name": "b", "wave": "0..1.0", "node": "...B" }, { "name": "c", "wave": "0...1.", "node": "....E" } ],',
    '  "edge": ["A~>B frame armed", "E re-arm window"] }',
    '\x60\x60\x60', '',
    '\x60\x60\x60dot', 'digraph { node [shape=box, style=filled, fillcolor=white]; w -> v; }', '\x60\x60\x60', '']);
  await gotoTheme(page, url); await wait(1500);
  const read = () => page.evaluate(() => {
    const svg = document.querySelector('.content [id^="WaveDrom_Display_"] svg');
    const backs = [...svg.querySelectorAll('[id^="wavearcs"] rect')].filter((r) => r.nextElementSibling && r.nextElementSibling.tagName === 'text');
    const label = (t) => backs.find((r) => r.nextElementSibling.textContent === t);
    const gvNode = document.querySelector('.content .graphviz svg g.node polygon');
    return { frame: getComputedStyle(label('frame armed')).fill, note: getComputedStyle(label('re-arm window')).fill,
      styles: backs.map((r) => r.getAttribute('style')), gv: getComputedStyle(gvNode).fill };
  });
  const light = await read();
  assert.deepStrictEqual([light.frame, light.note], ['rgb(255, 255, 255)', 'rgb(255, 255, 255)'], JSON.stringify(light));
  await page.click('#md2doc-theme-toggle'); await wait(800);
  const dark = await read();
  assert.deepStrictEqual([dark.frame, dark.note], ['rgb(27, 27, 29)', 'rgb(27, 27, 29)'], 'label backings take the dark page colour ' + JSON.stringify(dark));
  assert.ok(dark.gv === 'rgba(0, 0, 0, 0)' || dark.gv === 'transparent', 'graphviz white node still goes transparent ' + JSON.stringify(dark));
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  assert.strictEqual((await read()).frame, 'rgb(255, 255, 255)', 'printing while dark shows the white backing');
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await page.click('#md2doc-theme-toggle'); await wait(800);
  assert.deepStrictEqual((await read()).styles, light.styles, 'every backing style attribute restored exactly');
});
check('desktop: images sit on a white plate in dark only', DESKTOP, async (page) => {
  await gotoTheme(page);
  const bg = () => page.$eval('.content img', (i) => getComputedStyle(i).backgroundColor);
  assert.strictEqual(await bg(), 'rgba(0, 0, 0, 0)');
  await page.click('#md2doc-theme-toggle'); await wait(300);
  assert.strictEqual(await bg(), 'rgb(255, 255, 255)');
});
check('desktop: the lightbox shows a recoloured diagram on the dark ground and an image on white', DESKTOP, async (page) => {
  await gotoTheme(page);
  await page.click('#md2doc-theme-toggle'); await wait(500);
  await page.click('.content .graphviz'); await wait(400);
  const svgBg = await page.$eval('.lightbox-canvas > svg', (s) => getComputedStyle(s).backgroundColor);
  await page.keyboard.press('Escape'); await wait(300);
  await page.click('.content img'); await wait(400);
  const imgBg = await page.$eval('.lightbox-canvas > img', (s) => getComputedStyle(s).backgroundColor);
  assert.deepStrictEqual({ svgBg, imgBg }, { svgBg: 'rgb(27, 27, 29)', imgBg: 'rgb(255, 255, 255)' });
});
check('desktop: --bake-svg output recolours its baked mermaid in dark', DESKTOP, async (page) => {
  const baked = path.join(tmpDir, 'theme-baked.html');
  const r = spawnSync(process.execPath, [LIB, themeMdPath, baked, '--bake-svg'], { cwd: REPO, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'bake: ' + r.stderr);
  await gotoTheme(page, 'file://' + baked);
  assert.strictEqual(await page.evaluate(() => typeof window.mermaid), 'undefined', 'guard: no mermaid library in baked output');
  await page.click('#md2doc-theme-toggle'); await wait(500);
  const flagged = await page.$eval('.content .mermaid svg', (s) => s.hasAttribute('data-md2doc-recoloured'));
  assert.strictEqual(flagged, true);
  const m = await mermaidLabelState(page);
  assert.ok(m.labels > 0 && m.shapes > 0, 'guard: labels and shapes were found ' + JSON.stringify(m));
  assert.deepStrictEqual([m.darkLabels, m.lightShapes], [[], []], 'baked mermaid labels readable on dark: ' + JSON.stringify(m));
});

// Mermaid flowchart labels are HTML inside foreignObject (coloured by CSS color),
// not svg text; measure those, plus the node shape fills.
async function mermaidLabelState(page, nodeSel) {
  return page.evaluate((sel) => {
    function f(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    function lum(s) { const c = (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number); return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }
    const out = { labels: 0, shapes: 0, darkLabels: [], lightShapes: [] };
    document.querySelectorAll('.content .mermaid svg foreignObject *').forEach((e) => {
      if (![].some.call(e.childNodes, (n) => n.nodeType === 3 && n.textContent.trim())) return;
      out.labels++;
      const col = getComputedStyle(e).color;
      if (lum(col) < 0.35) out.darkLabels.push(e.textContent.trim() + ' ' + col);
    });
    document.querySelectorAll('.content .mermaid svg ' + (sel || '.node rect, .node polygon, .node circle, .node path')).forEach((e) => {
      out.shapes++;
      const fill = getComputedStyle(e).fill;
      if (fill === 'none' || fill === 'transparent' || /rgba\([^)]*,\s*0\)/.test(fill)) return;
      if (lum(fill) > 0.30) out.lightShapes.push(fill);
    });
    return out;
  }, nodeSel);
}
check('desktop: a classDef light fill in a live mermaid keeps a readable label in dark', DESKTOP, async (page) => {
  const url = fixtureUrl('classdef', ['# ClassDef', '', '## 1. A', '',
    '\x60\x60\x60mermaid', 'graph LR', '  A[Hot] --> B[Cold]', '  classDef warm fill:#ffd6a5', '  class A warm', '\x60\x60\x60', '']);
  await page.addInitScript(() => { try { localStorage.setItem('md2doc-theme', 'dark'); } catch (e) {} });
  await gotoTheme(page, url); await wait(2500);
  const r = await page.evaluate(() => {
    function f(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    function lum(s) { const c = s.match(/[\d.]+/g).slice(0, 3).map(Number); return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }
    const node = [].find.call(document.querySelectorAll('.content .mermaid svg .node'), (n) => /Hot/.test(n.textContent));
    const label = [].find.call(node.querySelectorAll('foreignObject *'), (e) => [].some.call(e.childNodes, (n) => n.nodeType === 3 && /Hot/.test(n.textContent)));
    const shape = node.querySelector('rect, polygon, circle, path');
    const fill = getComputedStyle(shape).fill;
    return { labelLum: lum(getComputedStyle(label).color), fill, fillLum: /^rgba?\(/.test(fill) && !/,\s*0\)$/.test(fill) ? lum(fill) : 0 };
  });
  assert.ok(r.labelLum >= 0.35, 'label luminance ' + JSON.stringify(r));
  assert.ok(r.fillLum <= 0.30, 'shape fill luminance ' + JSON.stringify(r));
});

// Live dark mermaid draws arrowheads, markers and start dots in its own theme colours; D10 must
// leave them alone. Method (timing independent): undo D10 on the SAME elements by restoring each
// one's saved original style, and require the computed fill/stroke to be identical either way, and
// never transparent where the undone value was a colour.
check('desktop: live dark mermaid markers and start dots keep mermaid own colours (D10 leaves them)', DESKTOP, async (page) => {
  const url = fixtureUrl('mermaid-own', ['# Own', '', '## 1. A', '',
    '\x60\x60\x60mermaid', 'graph LR', '  A --> B --> C', '\x60\x60\x60', '',
    '\x60\x60\x60mermaid', 'stateDiagram-v2', '  [*] --> S1', '  S1 --> [*]', '\x60\x60\x60', '',
    '\x60\x60\x60mermaid', 'sequenceDiagram', '  A->>B: sync', '  A-)B: async', '\x60\x60\x60', '']);
  await gotoTheme(page, url); await wait(2500);
  await page.click('#md2doc-theme-toggle');
  await page.waitForFunction(() => document.querySelectorAll('.content .mermaid svg[id^="md2doc-mermaid-dark-"]').length === 3, null, { timeout: 20000 });
  await wait(500);
  const r = await page.evaluate(() => {
    const out = { svgs: 0, checked: 0, changed: [], transparent: [], touched: 0 };
    document.querySelectorAll('.content .mermaid svg[id^="md2doc-mermaid-dark-"]').forEach((svg) => {
      out.svgs++;
      const els = [].slice.call(svg.querySelectorAll('marker *, .state-start, .state-start *'));
      const now = els.map((e) => { const c = getComputedStyle(e); return [c.fill, c.stroke]; });
      els.forEach((e) => { if (e.hasAttribute('data-md2doc-style')) out.touched++; });
      const saved = els.map((e) => e.getAttribute('style'));
      els.forEach((e) => { if (e.hasAttribute('data-md2doc-style')) { const o = e.getAttribute('data-md2doc-style'); if (o) e.setAttribute('style', o); else e.removeAttribute('style'); } });
      const undone = els.map((e) => { const c = getComputedStyle(e); return [c.fill, c.stroke]; });
      els.forEach((e, i) => { if (saved[i] === null) e.removeAttribute('style'); else e.setAttribute('style', saved[i]); });
      els.forEach((e, i) => {
        out.checked++;
        if (now[i][0] !== undone[i][0] || now[i][1] !== undone[i][1]) out.changed.push(e.tagName + ' ' + now[i] + ' vs ' + undone[i]);
        const tr = (v) => v === 'transparent' || /rgba\([^)]*,\s*0\)/.test(v);
        if (tr(now[i][0]) && !tr(undone[i][0])) out.transparent.push(e.tagName + ' ' + undone[i][0]);
      });
    });
    return out;
  });
  assert.strictEqual(r.svgs, 3, JSON.stringify(r));
  assert.ok(r.checked >= 6, 'marker elements found ' + JSON.stringify(r));
  assert.deepStrictEqual([r.changed, r.transparent, r.touched], [[], [], 0], JSON.stringify(r));
});

check('desktop: heading anchors keep their own muted colour in dark, links keep the link colour', DESKTOP, async (page) => {
  await gotoTheme(page);
  await page.click('#md2doc-theme-toggle'); await wait(300);
  const r = await page.evaluate(() => ({
    anchor: getComputedStyle(document.querySelector('.heading-anchor')).color,
    link: getComputedStyle(document.querySelector('.content p a')).color,
  }));
  assert.deepStrictEqual(r, { anchor: 'rgb(163, 166, 171)', link: 'rgb(121, 176, 246)' });
});
// Images: the dark white plate must not change layout (a ring painted outside the box).
fs.writeFileSync(path.join(tmpDir, 'wide.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="60"><rect width="3000" height="60" fill="#09f"/></svg>');
const IMAGES_URL = fixtureUrl('images', ['# Images', '', '## 1. Pictures', '',
  '![a](dot.png)', '', '![b](dot.png)', '', '![c](dot.png)', '', '![d](wide.svg)', '', '![e](dot.png)', '', '![f](wide.svg)', '',
  '## 2. Target', '', filler(2, 3), '', '## 3. After', '', filler(3, 14), '']);
check('desktop: without JavaScript the toggle is not shown (no dead button)', DESKTOP, async (page) => {
  await page.goto(THEME_URL, { waitUntil: 'load' }); await wait(300);
  assert.strictEqual(await page.$eval('#md2doc-theme-toggle', (b) => getComputedStyle(b).display), 'none');
}, { javaScriptEnabled: false });
check('desktop: with JavaScript the toggle is shown', DESKTOP, async (page) => {
  await gotoTheme(page);
  assert.deepStrictEqual(await page.$eval('#md2doc-theme-toggle', (b) => [b.hidden, getComputedStyle(b).display]), [false, 'grid']);
});
check('desktop: toggling dark does not move the reading position (images above)', DESKTOP, async (page) => {
  await gotoTheme(page, IMAGES_URL);
  await page.evaluate(() => document.getElementById('2-target').scrollIntoView({ block: 'start' }));
  await wait(400);
  const before = await topOf(page, '2-target');
  await page.click('#md2doc-theme-toggle'); await wait(500);
  const after = await topOf(page, '2-target');
  assert.ok(Math.abs(after - before) <= 2, 'reading position moved: before ' + before + ' after ' + after);
  assert.strictEqual((await themeState(page)).attr, 'dark');
});
for (const [label, vp] of [['desktop', DESKTOP], ['phone', PHONE]]) {
  check(label + ': dark image plate leaves every image border box unchanged', vp, async (page) => {
    await gotoTheme(page, IMAGES_URL);
    const boxes = () => page.$$eval('.content img', (is) => is.map((i) => { const r = i.getBoundingClientRect(); return [r.left, r.top + scrollY, r.width, r.height].map((v) => Math.round(v * 100) / 100); }));
    const light = await boxes();
    assert.strictEqual(light.length, 6, 'guard: six images');
    await page.click('#md2doc-theme-toggle'); await wait(500);
    assert.strictEqual(await page.$eval('.content img', (i) => getComputedStyle(i).backgroundColor), 'rgb(255, 255, 255)', 'guard: the plate is on');
    assert.deepStrictEqual(await boxes(), light);
  });
}
check('desktop: toggling dark does not move the reading position (mermaid-heavy page)', DESKTOP, async (page) => {
  const lines = ['# Long Mermaid', ''];
  for (let k = 1; k <= 6; k++) {
    lines.push('## ' + k + '. Part ' + k, '', filler(k, 1), '',
      '\x60\x60\x60mermaid', 'graph TD', '  A' + k + '[Start] --> B' + k + '[One]', '  B' + k + ' --> C' + k + '[Two]', '  C' + k + ' --> D' + k + '[Three]',
      '  D' + k + ' --> E' + k + '[Four]', '  E' + k + ' --> F' + k + '[Five]', '  F' + k + ' --> G' + k + '[End]', '\x60\x60\x60', '', filler(k + '.b', 2), '');
  }
  await gotoTheme(page, fixtureUrl('mermaid-long', lines));
  await page.waitForFunction(() => document.querySelectorAll('.content .mermaid svg').length === 6, null, { timeout: 15000 });
  await wait(500);
  await page.evaluate(() => document.getElementById('5-part-5').scrollIntoView({ block: 'start' }));
  await wait(400);
  const before = await topOf(page, '5-part-5');
  await page.click('#md2doc-theme-toggle'); await wait(1500);
  const after = await topOf(page, '5-part-5');
  assert.ok(Math.abs(after - before) <= 2, 'reading position moved: before ' + before + ' after ' + after);
  assert.strictEqual((await themeState(page)).attr, 'dark');
});
check('desktop: one broken mermaid block does not defeat the cache', DESKTOP, async (page) => {
  const url = fixtureUrl('mermaid-broken', ['# Broken', '', '## 1. A', '',
    '\x60\x60\x60mermaid', 'graph LR', '  A[ok] --> B[fine]', '\x60\x60\x60', '',
    '\x60\x60\x60mermaid', 'graph LR; A -->', '\x60\x60\x60', '']);
  await gotoTheme(page, url); await wait(1500);
  await page.evaluate(() => {
    window.__draws = 0;
    const run = mermaid.run.bind(mermaid); mermaid.run = (o) => { window.__draws++; return run(o); };
    const render = mermaid.render.bind(mermaid); mermaid.render = (a, b) => { window.__draws++; return render(a, b); };
  });
  await page.click('#md2doc-theme-toggle'); await wait(2000);
  assert.strictEqual(await page.evaluate(() => window.__draws), 2, 'dark pass: one render per host (2 hosts)');
  await page.click('#md2doc-theme-toggle'); await wait(500);
  await page.click('#md2doc-theme-toggle'); await wait(500);
  assert.strictEqual(await page.evaluate(() => window.__draws), 2, 'light and the second dark are pure swaps');
  assert.strictEqual((await themeState(page)).attr, 'dark');
});

// ── TOC tracking (v3.9.0): reading line, one open path, centred row ─────────
const TRACK_VIEW = { width: 1280, height: 650 };
// 30 sections so the TOC overflows its box with one path open; otherwise the row cannot be centred and the check measures nothing.
const trackMd = ['# TOC Track', ''];
for (let s = 1; s <= 30; s++) {
  trackMd.push('## ' + s + '. Section ' + s, '');
  for (let m = 1; m <= 4; m++) trackMd.push('### ' + s + '.' + m + ' Sub ' + s + '.' + m, '', filler(s + '.' + m, 3), '');
}
const TRACK_URL = fixtureUrl('toctrack', trackMd);
check('desktop: the TOC follows the reading line, keeps one path open and the row centred', TRACK_VIEW, async (page) => {
  await page.goto(TRACK_URL, { waitUntil: 'load' }); await wait(500);
  await page.evaluate(() => {
    window.__f = [];
    const sc = document.querySelector('.toc > .toc-list');
    (function t() {
      const a = document.querySelector('.toc-list a.is-active');
      const br = sc.getBoundingClientRect();
      const r = a && a.getBoundingClientRect();
      window.__f.push({ has: !!a, inBox: !r || (r.top >= br.top - 1 && r.bottom <= br.bottom + 1), open: document.querySelectorAll('.toc-list details[open]').length });
      requestAnimationFrame(t);
    })();
  });
  await page.mouse.move(800, 300);
  const atEnd = () => page.evaluate(() => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1);
  let guard = 0;
  while (!(await atEnd()) && guard++ < 600) { await page.mouse.wheel(0, 400); await wait(25); }
  await wait(400);
  const total = await page.evaluate(() => window.scrollY);
  const stops = Array.from({ length: 8 }, (_, i) => Math.round(total * (7 - i) / 8) + 37);
  const samples = [];
  for (const stop of stops) {
    while ((await page.evaluate(() => window.scrollY)) > stop + 200) { await page.mouse.wheel(0, -400); await wait(25); }
    await wait(500);
    // The reading line, the TOC-listed heading and the scroller geometry all come from the page.
    samples.push(await page.evaluate(() => {
      const a = document.querySelector('.toc-list a.is-active');
      let want = null;
      const heads = [].filter.call(document.querySelectorAll('[data-reader-heading]'), (h) => document.querySelector('.toc a[href="#' + h.id + '"]'));
      heads.forEach((h) => { if (h.getBoundingClientRect().top <= window.innerHeight * 0.35) want = h; });
      if (!want) want = heads[0];
      const sc = document.querySelector('.toc > .toc-list');
      const br = sc.getBoundingClientRect();
      const r = a && a.getBoundingClientRect();
      return { href: a && a.getAttribute('href'), want: '#' + want.id, y: window.scrollY,
        mid: r ? ((r.top + r.bottom) / 2 - br.top) / sc.clientHeight : null,
        atEdge: sc.scrollTop <= 1 || sc.scrollTop >= sc.scrollHeight - sc.clientHeight - 1 };
    }));
  }
  const frames = await page.evaluate(() => window.__f);
  assert.ok(frames.length > 100, 'recorder ran ' + frames.length);
  const noRow = frames.filter((f) => !f.has).length;
  assert.strictEqual(noRow, 0, 'frames without an active row: ' + noRow + ' of ' + frames.length);
  const outBox = frames.filter((f) => !f.inBox).length;
  assert.strictEqual(outBox, 0, 'frames with the active row outside the TOC box: ' + outBox);
  const maxOpen = Math.max.apply(null, frames.map((f) => f.open));
  assert.ok(maxOpen <= 1, 'max open details ' + maxOpen);
  samples.forEach((s) => assert.strictEqual(s.href, s.want, 'upward active row ' + JSON.stringify(s)));
  samples.forEach((s) => { if (!s.atEdge) assert.ok(s.mid >= 0.2 && s.mid <= 0.6, 'row centre at ' + s.mid + ' ' + JSON.stringify(s)); });
  assert.ok(samples.some((s) => !s.atEdge), 'at least one settled sample could be centred ' + JSON.stringify(samples));
});

// ── Final fix wave 2: live dark gate, subgraph / linkStyle, baked arrowheads, reduced motion ──
const F3 = '\x60\x60\x60';
async function darkLive(page, name, lines) {
  const url = fixtureUrl(name, ['# ' + name, '', '## 1. A', ''].concat(lines, ['']));
  await page.addInitScript(() => { try { localStorage.setItem('md2doc-theme', 'dark'); } catch (e) {} });
  await gotoTheme(page, url); await wait(3500);
}
// Contrast helpers shared by the checks below (evaluated in the page).
const CONTRAST_JS = 'function f(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);}' +
  'function parse(s){var n=(s.match(/[\\d.]+/g)||[]).map(Number);return n.length<3?null:{r:n[0],g:n[1],b:n[2],a:n.length>3?n[3]:1};}' +
  'function lumC(c){return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b);}' +
  'var GROUND={r:27,g:27,b:29,a:1};' +
  'function over(c,bg){var a=c.a;return {r:c.r*a+bg.r*(1-a),g:c.g*a+bg.g*(1-a),b:c.b*a+bg.b*(1-a),a:1};}' +
  'function ratio(a,b){var x=lumC(a),y=lumC(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);}';
check('desktop: live dark mermaid restyles only author-styled shapes, subgraphs, linkStyle edges and text', DESKTOP, async (page) => {
  await darkLive(page, 'allowlist', [
    F3 + 'mermaid', 'graph LR', '  A[Hot] --> B[Cold]', '  classDef warm fill:#ffd6a5,stroke:#000', '  class A warm',
    '  subgraph S1[Group]', '    C', '  end', '  style S1 fill:#eeeeee', '  linkStyle 0 stroke:#000', F3, '',
    F3 + 'mermaid', 'stateDiagram-v2', '  [*] --> S1', '  S1 --> S2', '  classDef hot fill:#ffd6a5', '  class S2 hot', F3, '',
    F3 + 'mermaid', 'sequenceDiagram', '  autonumber', '  A->>B: sync', '  B-->>A: reply', '  Note over A,B: note', F3, '',
    F3 + 'mermaid', 'classDiagram', '  Animal <|-- Duck', '  style Duck fill:#ffffff', F3]);
  const r = await page.evaluate(() => {
    const live = [].slice.call(document.querySelectorAll('.content .mermaid svg[data-md2doc-live]'));
    const stamped = [];
    const bad = [];
    live.forEach((svg) => {
      [].slice.call(svg.querySelectorAll('[data-md2doc-style]')).forEach((e) => {
        if (e.namespaceURI === 'http://www.w3.org/1999/xhtml') return;
        stamped.push(e.tagName);
        const own = e.getAttribute('data-md2doc-style') || '';
        const ok = !e.closest('marker') && /(^|;)\s*(fill|stroke)\s*:/.test(own) &&
          (e.closest('g.node, g.cluster') || e.matches('.flowchart-link') || /^(text|tspan)$/i.test(e.tagName));
        if (!ok) bad.push(e.tagName + '.' + (e.getAttribute('class') || '') + ' [' + own + ']');
      });
    });
    return { live: live.length, stamped: stamped.length, bad };
  });
  assert.strictEqual(r.live, 4, 'guard: four live dark svgs ' + JSON.stringify(r));
  assert.ok(r.stamped > 0, 'guard: some author-styled element was touched ' + JSON.stringify(r));
  assert.deepStrictEqual(r.bad, [], 'elements outside the allow-list were restyled');
});
check('desktop: a styled subgraph title stays readable in live dark', DESKTOP, async (page) => {
  await darkLive(page, 'subgraph', [F3 + 'mermaid', 'graph LR', '  subgraph S1[Group]', '    A --> B', '  end', '  style S1 fill:#eeeeee', F3]);
  const r = await page.evaluate((js) => {
    eval(js);
    const svg = document.querySelector('.content .mermaid svg');
    const lab = [].find.call(svg.querySelectorAll('.cluster foreignObject *, .cluster text, .cluster-label *'), (e) => e.textContent.trim() === 'Group' && !e.children.length);
    const rect = svg.querySelector('.cluster rect');
    const xh = lab.namespaceURI === 'http://www.w3.org/1999/xhtml';
    const col = parse(xh ? getComputedStyle(lab).color : getComputedStyle(lab).fill);
    const fillS = getComputedStyle(rect).fill;
    const fc = fillS === 'none' ? null : parse(fillS);
    const bg = fc && fc.a > 0 ? over(fc, GROUND) : GROUND;
    return { ratio: ratio(over(col, bg), bg), fill: fillS, col: getComputedStyle(lab).color };
  }, CONTRAST_JS);
  assert.ok(r.ratio >= 4.5, 'subgraph title contrast ' + JSON.stringify(r));
});
check('desktop: a linkStyle stroke stays visible in live dark', DESKTOP, async (page) => {
  await darkLive(page, 'linkstyle', [F3 + 'mermaid', 'graph LR', '  A --> B', '  B --> C', '  linkStyle 1 stroke:#000', F3]);
  const r = await page.evaluate((js) => {
    eval(js);
    const p = document.querySelectorAll('.content .mermaid svg path.flowchart-link')[1];
    const s = getComputedStyle(p).stroke;
    return { ratio: ratio(over(parse(s), GROUND), GROUND), stroke: s };
  }, CONTRAST_JS);
  assert.ok(r.ratio >= 3, 'linkStyle edge contrast ' + JSON.stringify(r));
});
check('desktop: baked sequence arrowheads stay visible in dark', DESKTOP, async (page) => {
  const md = path.join(tmpDir, 'seqbake.md'); const out = path.join(tmpDir, 'seqbake.html');
  fs.writeFileSync(md, ['# Seq', '', '## 1. A', '', F3 + 'mermaid', 'sequenceDiagram', '  autonumber', '  A->>B: sync', '  A-)B: async', '  B-->>A: reply', '  A-xB: cross', F3, ''].join('\n'));
  const b = spawnSync(process.execPath, [LIB, md, out, '--bake-svg'], { cwd: REPO, encoding: 'utf8' });
  assert.strictEqual(b.status, 0, 'bake: ' + b.stderr);
  await gotoTheme(page, 'file://' + out);
  await page.click('#md2doc-theme-toggle'); await wait(600);
  const r = await page.evaluate((js) => {
    eval(js);
    const shapes = [].slice.call(document.querySelectorAll('.content .mermaid svg marker *'));
    const seen = []; const bad = [];
    shapes.forEach((e) => {
      const fs_ = getComputedStyle(e).fill;
      if (fs_ === 'none') return;
      const c = parse(fs_); seen.push(fs_);
      if (!c || c.a === 0 || ratio(over(c, GROUND), GROUND) < 3) bad.push((e.closest('marker').id) + ' ' + e.tagName + ' ' + fs_);
    });
    return { seen: seen.length, bad };
  }, CONTRAST_JS);
  assert.ok(r.seen > 0, 'guard: filled marker shapes were found ' + JSON.stringify(r));
  assert.deepStrictEqual(r.bad, [], 'invisible baked arrowheads');
});
check('desktop: with reduced motion the TOC centres its row at once', TRACK_VIEW, async (page) => {
  await page.goto(TRACK_URL, { waitUntil: 'load' }); await wait(500);
  const head = (n) => page.evaluate((i) => { window.scrollTo(0, document.getElementById(i).getBoundingClientRect().top + window.scrollY - 40); }, n);
  const ids = await page.evaluate(() => [].map.call(document.querySelectorAll('.content h2[id]'), (h) => h.id));
  await head(ids[11]); await wait(1500);
  const before = await page.evaluate(() => document.querySelector('.toc > .toc-list').scrollTop);
  const r = await page.evaluate(async (id) => {
    const sc = document.querySelector('.toc > .toc-list');
    const frame = () => new Promise((res) => requestAnimationFrame(() => res()));
    const start = sc.querySelector('a.is-active').getAttribute('href');
    window.scrollTo(0, document.getElementById(id).getBoundingClientRect().top + window.scrollY - 40);
    let n = 0;
    while (n < 60 && sc.querySelector('a.is-active').getAttribute('href') === start) { await frame(); n++; }
    await frame();
    const a = sc.querySelector('a.is-active');
    const br = sc.getBoundingClientRect(); const lr = a.getBoundingClientRect();
    const target = sc.scrollTop + (lr.top - br.top) - sc.clientHeight * 0.4;
    return { start, now: a.getAttribute('href'), frames: n, off: Math.abs(target - sc.scrollTop), top: sc.scrollTop };
  }, ids[12]);
  assert.notStrictEqual(r.now, r.start, 'guard: the active row changed ' + JSON.stringify(r));
  assert.notStrictEqual(r.top, before, 'guard: the TOC box scrolled ' + JSON.stringify({ r, before }));
  assert.ok(r.off <= 3, 'TOC row is ' + r.off + 'px from its centre target one frame after the change ' + JSON.stringify(r));
}, { reducedMotion: 'reduce' });

// ── Run ─────────────────────────────────────────────────────────────────────
check('desktop: task items have no bullet; a checked one is struck but its child is not', DESKTOP, async (page) => {
  await page.goto(fixtureUrl('tasks', ['# T', '', '- [x] done', '  - [ ] child', '- [ ] open', '']), { waitUntil: 'load' }); await wait(300);
  const r = await page.evaluate(() => {
    const li = [...document.querySelectorAll('.content li.task-item')];
    return { n: li.length, styles: li.map((x) => getComputedStyle(x).listStyleType),
      done: getComputedStyle(li[0].querySelector('.task-text')).textDecorationLine,
      child: getComputedStyle(li[1].querySelector('.task-text')).textDecorationLine };
  });
  assert.strictEqual(r.n, 3);
  assert.deepStrictEqual(r.styles, ['none', 'none', 'none']);
  assert.strictEqual(r.done, 'line-through'); assert.strictEqual(r.child, 'none');
});

check('desktop: an ordered task item keeps its number', DESKTOP, async (page) => {
  await page.goto(fixtureUrl('otasks', ['# T', '', '1. a', '2. [x] b', '3. c', '']), { waitUntil: 'load' }); await wait(300);
  const r = await page.evaluate(() => [...document.querySelectorAll('.content ol > li')].map((x) => getComputedStyle(x).listStyleType));
  assert.deepStrictEqual(r, ['decimal', 'decimal', 'decimal']);
});

// ── Code copy button (v3.12.0) ─────────────────────────────────────────────
// One fixture for every copy check: a highlighted block whose first line is far
// wider than the column (so <pre> scrolls sideways) and holds characters the
// HTML escapes, so "what landed on the clipboard" is a real comparison.
const COPY_SRC = ["const wide = '<tag> & ' + 'x'.repeat(40) + '" + 'y'.repeat(160) + "';", 'if (a < b) { return "ok"; }'];
const copyUrl = () => fixtureUrl('copy', ['# Copy', '', '## 1. Code', '', 'Intro paragraph.', '',
  '\x60\x60\x60js', ...COPY_SRC, '\x60\x60\x60', '', '## 2. Tail', '', filler('copy', 4), '']);
// Replace the clipboard with a recorder (or a refuser). Both engines, file:// or
// not, then answer the same way, and the assertion reads what was handed over.
async function stubClipboard(page, refuse) {
  await page.evaluate((no) => {
    window.__copied = null;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: (t) => { if (no) return Promise.reject(new Error('denied')); window.__copied = t; return Promise.resolve(); },
    } });
    if (no) document.execCommand = () => false;
  }, !!refuse);
}
const copyState = (page) => page.evaluate(() => {
  const b = document.querySelector('.content .code-block .code-copy');
  return { opacity: getComputedStyle(b).opacity, label: b.getAttribute('aria-label'), copied: window.__copied,
    done: !!b.closest('.code-block.is-copied'), text: b.textContent.trim() };
});

check('desktop: the copy button hides at rest, shows on hover, copies the exact code and reverts', DESKTOP, async (page) => {
  await page.goto(copyUrl(), { waitUntil: 'load' }); await wait(300);
  await stubClipboard(page);
  await page.mouse.move(5, 5); await wait(250);
  assert.strictEqual((await copyState(page)).opacity, '0', 'hidden while the pointer is elsewhere');
  await page.hover('.content .code-block pre'); await wait(250);
  assert.strictEqual((await copyState(page)).opacity, '1', 'shown while the pointer is over the block');
  await page.click('.content .code-block .code-copy'); await wait(150);
  const s = await copyState(page);
  assert.strictEqual(s.copied, COPY_SRC.join('\n'), 'clipboard holds the source text, unescaped');
  assert.strictEqual(s.label, 'Copied'); assert.strictEqual(s.done, true); assert.strictEqual(s.text, 'Copied');
  await page.mouse.move(5, 5); await wait(250);
  assert.strictEqual((await copyState(page)).opacity, '1', 'the confirmation stays visible after the pointer leaves');
  await wait(2200);
  const back = await copyState(page);
  assert.deepStrictEqual([back.label, back.done, back.text, back.opacity], ['Copy code', false, '', '0'], 'reverts after two seconds');
});

check('desktop: Tab reaches the copy button and shows it', DESKTOP, async (page) => {
  await page.goto(copyUrl(), { waitUntil: 'load' }); await wait(300);
  // A bound derived from the page, not a number: every tabbable element once.
  const cap = await page.evaluate(() => document.querySelectorAll('a[href], button, input, [tabindex]').length + 2);
  let on = false;
  for (let i = 0; i < cap && !on; i++) {
    await page.keyboard.press('Tab');
    on = await page.evaluate(() => !!document.activeElement && document.activeElement.classList.contains('code-copy'));
  }
  assert.strictEqual(on, true, 'Tab reached .code-copy within ' + cap + ' presses');
  await wait(250);
  assert.strictEqual((await copyState(page)).opacity, '1', 'keyboard focus shows the button');
});

check('desktop: a block scrolled sideways keeps its copy button in the top-right corner', DESKTOP, async (page) => {
  await page.goto(copyUrl(), { waitUntil: 'load' }); await wait(300);
  const at = () => page.evaluate(() => {
    const w = document.querySelector('.content .code-block'), b = w.querySelector('.code-copy');
    const wr = w.getBoundingClientRect(), br = b.getBoundingClientRect();
    return { right: Math.round(wr.right - br.right), top: Math.round(br.top - wr.top) };
  });
  const before = await at();
  const scrolled = await page.evaluate(() => { const p = document.querySelector('.content .code-block pre'); p.scrollLeft = p.scrollWidth; return p.scrollLeft; });
  assert.ok(scrolled > 100, 'guard: the block really scrolls sideways (' + scrolled + ')');
  assert.deepStrictEqual(await at(), before, 'button did not move with the code');
  assert.deepStrictEqual(before, { right: 8, top: 8 }, 'inset 8px from the corner');
  // And it is what a press there actually hits.
  const hit = await page.evaluate(() => {
    const r = document.querySelector('.content .code-block .code-copy').getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!el && !!el.closest('.code-copy');
  });
  assert.strictEqual(hit, true, 'elementFromPoint at the button centre is the button');
});

check('desktop: when the clipboard is refused the code is selected for Ctrl+C', DESKTOP, async (page) => {
  await page.goto(copyUrl(), { waitUntil: 'load' }); await wait(300);
  await stubClipboard(page, true);
  await page.hover('.content .code-block pre'); await wait(250);
  await page.click('.content .code-block .code-copy'); await wait(200);
  const r = await page.evaluate(() => ({ sel: String(window.getSelection()), label: document.querySelector('.content .code-copy').getAttribute('aria-label') }));
  assert.strictEqual(r.sel.replace(/\n$/, ''), COPY_SRC.join('\n'), 'the whole code is selected');
  assert.strictEqual(r.label, 'Press Ctrl+C');
});

check('desktop: the copy button follows dark mode', DESKTOP, async (page) => {
  await page.goto(copyUrl(), { waitUntil: 'load' }); await wait(300);
  await page.evaluate(() => document.documentElement.setAttribute('data-md2doc-theme', 'dark'));
  await page.hover('.content .code-block pre'); await wait(250);
  const r = await page.evaluate(() => {
    const b = document.querySelector('.content .code-copy');
    return { bg: getComputedStyle(b).backgroundColor, page: getComputedStyle(document.body).backgroundColor };
  });
  assert.notStrictEqual(r.bg, 'rgb(255, 255, 255)', 'not a white chip on a dark page');
  assert.strictEqual(r.bg, r.page, 'the chip uses the page ground, as in light mode');
});

check('phone: the copy button is always shown on touch and a tap copies', PHONE, async (page) => {
  await page.goto(copyUrl(), { waitUntil: 'load' }); await wait(300);
  await stubClipboard(page);
  await page.evaluate(() => document.querySelector('.content .code-block').scrollIntoView({ block: 'center' })); await wait(200);
  assert.strictEqual((await copyState(page)).opacity, '1', 'visible with no hover');
  assert.ok(await onScreen(page, '.content .code-copy'), 'on screen');
  await page.tap('.content .code-block .code-copy'); await wait(150);
  assert.strictEqual((await copyState(page)).copied, COPY_SRC.join('\n'));
  assert.ok((await overflowX(page)) <= 0, 'no sideways page scroll');
}, { hasTouch: true, isMobile: true });

// ── Scroll anchoring vs a newer scroll (R1, R9) ─────────────────────────────
// The zoom/resize anchor is captured in the frame after a scroll. A column
// change whose reflow is held in the same task as a scroll (or before that
// scroll's event has dispatched) used to restore the OLD anchor and pull the
// page back over the newer scroll.
check('anchor: a scroll issued in the same task as a column change survives', DESKTOP, async (page) => {
  const t = await page.evaluate(() => {
    document.body.toggleAttribute('data-toc-collapsed');
    const y = document.getElementById('6-section-6').getBoundingClientRect().top + scrollY;
    window.scrollTo(0, y);
    return Math.round(scrollY);
  });
  assert.ok(t > 1000, 'the scroll target is far down the page, t=' + t);
  await wait(400);
  const y = await page.evaluate(() => Math.round(scrollY));
  assert.ok(Math.abs(y - t) <= 2, 'scrollY stays at the target ' + t + ', got ' + y);
});
// <=1080 px opens the TOC as a drawer; with classic (non-overlay) scrollbars the
// drawer hides the page scrollbar, so closing it on a TOC click narrows the
// column by 15 px in the same task as the jump.
check('anchor: a TOC jump from the drawer survives classic scrollbars', { width: 900, height: 800 }, async (page) => {
  for (const id of ['6-section-6', '3-1-child-of-3', '7-1-child-of-7']) {
    await page.goto(URL, { waitUntil: 'load' });
    await wait(400);
    const sb = await page.evaluate(() => innerWidth - document.documentElement.clientWidth);
    assert.strictEqual(sb, 15, 'classic 15 px page scrollbar present');
    await page.click('#sidebar-toggle');
    await wait(400);
    await page.click('#toc-expand-all');
    await page.click('.toc-list a[href="#' + id + '"]');
    await wait(600);
    const r = await page.evaluate((i) => ({ top: Math.round(document.getElementById(i).getBoundingClientRect().top), y: Math.round(scrollY) }), id);
    assert.ok(r.top >= 44 && r.top <= 130, id + ' heading lands below the bar, top=' + r.top + ' scrollY=' + r.y);
  }
}, undefined, { engines: ['chromium'], launch: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

// ── Chapters of a multi-H1 TOC (R3, user decision B) ───────────────────────
// Two or more H1s that the TOC keeps as its top level are chapters: a rule and
// a gap set each one apart from the one above. Font weight does not change.
const CHAPTERS_MD = [];
for (let c = 1; c <= 3; c++) {
  CHAPTERS_MD.push('# ' + c + ' Chapter ' + c, '', filler('c' + c, 1), '');
  for (let s = 1; s <= 3; s++) CHAPTERS_MD.push('## ' + c + '.' + s + ' Section ' + c + '.' + s, '', filler(c + '.' + s, 1), '');
}
const CHAPTERS_URL = fixtureUrl('chapters', CHAPTERS_MD);
async function chapterRows(page) {
  return page.evaluate(() => {
    const lis = [...document.querySelectorAll('nav.toc > .toc-list-level-1 > .toc-item')];
    return { n: lis.length, gap: Math.round(lis[1].querySelector('a').getBoundingClientRect().top - lis[0].getBoundingClientRect().bottom),
      border: getComputedStyle(lis[1]).borderTopWidth + ' ' + getComputedStyle(lis[1]).borderTopColor,
      firstBorder: getComputedStyle(lis[0]).borderTopWidth,
      weight: getComputedStyle(lis[2].querySelector('a')).fontWeight };
  });
}
check('desktop: multi-H1 chapters are separated, weight unchanged', DESKTOP, async (page) => {
  await page.goto(CHAPTERS_URL, { waitUntil: 'load' }); await wait(400);
  // Read before anything scrolls to chapter 3: an active row's ancestors are bold by design.
  const r = await chapterRows(page);
  assert.strictEqual(r.n, 3, 'three chapter rows');
  assert.ok(r.gap >= 16, 'gap between chapter 1 and chapter 2 >= 16 px, got ' + r.gap);
  assert.strictEqual(r.border, '1px rgb(216, 222, 228)', 'rule above chapter 2');
  assert.strictEqual(r.firstBorder, '0px', 'no rule above the first chapter');
  assert.strictEqual(r.weight, '400', 'chapter rows keep their weight');
  await page.click('#md2doc-theme-toggle'); await wait(500);
  const d = await chapterRows(page);
  assert.strictEqual(d.border, '1px rgb(56, 57, 60)', 'dark: the rule follows token rule-2');
});
check('phone: multi-H1 chapters are separated in the drawer, weight unchanged', PHONE, async (page) => {
  await page.goto(CHAPTERS_URL, { waitUntil: 'load' }); await wait(400);
  await page.click('#sidebar-toggle'); await wait(400);
  const r = await chapterRows(page);
  assert.strictEqual(r.n, 3, 'three chapter rows');
  assert.ok(r.gap >= 16, 'gap between chapter 1 and chapter 2 >= 16 px, got ' + r.gap);
  assert.strictEqual(r.border, '1px rgb(216, 222, 228)', 'rule above chapter 2');
  assert.strictEqual(r.firstBorder, '0px', 'no rule above the first chapter');
  assert.strictEqual(r.weight, '400', 'chapter rows keep their weight');
}, { hasTouch: true, isMobile: true });
// Guard (green by design): a flattened single-H1 TOC is untouched.
check('desktop: a single-H1 TOC has no chapter separators', DESKTOP, async (page) => {
  const r = await page.evaluate(() => ({
    marked: document.querySelector('nav.toc').hasAttribute('data-toc-chapters'),
    rows: [...document.querySelectorAll('nav.toc > .toc-list-level-1 > .toc-item')].map((li) => getComputedStyle(li).borderTopWidth + ' ' + getComputedStyle(li).marginTop),
  }));
  assert.strictEqual(r.marked, false, 'no data-toc-chapters');
  assert.ok(r.rows.length > 1, 'several top-level rows, got ' + r.rows.length);
  assert.deepStrictEqual(r.rows.filter((v) => v !== '0px 0px'), [], 'every top-level row: no rule, no margin');
});

// ── The reading line on resizes (R4) ──────────────────────────────────────
// The rule the runtime follows, minus the click pin: the last heading with a
// TOC row whose top is at or above 35% of the viewport, else the first one.
async function readingLine(page) {
  return page.evaluate(() => {
    const line = window.innerHeight * 0.35;
    const rows = new Set([...document.querySelectorAll('.toc a[href^="#"]')].map((a) => a.getAttribute('href').slice(1)));
    let first = null;
    let expected = null;
    for (const h of document.querySelectorAll('[data-reader-heading]')) {
      if (!rows.has(h.id)) continue;
      if (!first) first = h.id;
      if (h.getBoundingClientRect().top <= line) expected = h.id; else break;
    }
    return { expected: expected || first, active: window.__readerState.activeSectionId };
  });
}
async function scrollHeadingTo(page, id, top) {
  await page.evaluate(([i, t]) => window.scrollBy(0, document.getElementById(i).getBoundingClientRect().top - t), [id, top]);
}
check('reading line: a height-only resize moves the highlight', DESKTOP, async (page) => {
  await page.goto(FOLLOWUP_URL, { waitUntil: 'load' }); await wait(400);
  await scrollHeadingTo(page, '6-1-child-of-6', 270); await wait(400);
  await page.setViewportSize({ width: 1440, height: 500 }); await wait(500);
  const r = await readingLine(page);
  assert.strictEqual(r.expected, '6-section-6', 'the shorter viewport puts the line above 6.1, ' + JSON.stringify(r));
  assert.strictEqual(r.active, r.expected, 'the highlight follows the line, ' + JSON.stringify(r));
});
// A column change with no window resize and no scroll: at 1250 px the
// collapse widens the column enough to rewrap section 1's paragraphs, so 1.1
// moves up (621 -> 522 px when measured) while scrollY stays 0 and no scroll
// event fires. The viewport height puts the reading line 12 px above 1.1
// before the click, so only a pass run from the column ResizeObserver moves
// the highlight onto 1.1.
check('reading line: collapsing the sidebar recomputes the highlight', DESKTOP, async (page) => {
  await page.setViewportSize({ width: 1250, height: 900 });
  await page.goto(FOLLOWUP_URL, { waitUntil: 'load' }); await wait(400);
  const t = await topOf(page, '1-1-child-of-1');
  await page.setViewportSize({ width: 1250, height: Math.floor((t - 12) / 0.35) });
  await page.goto(FOLLOWUP_URL, { waitUntil: 'load' }); await wait(400);
  const before = await readingLine(page);
  const t0 = await topOf(page, '1-1-child-of-1');
  assert.notStrictEqual(before.expected, '1-1-child-of-1', 'the line starts above 1.1, top=' + t0 + ' ' + JSON.stringify(before));
  await page.click('#toc-collapse-toggle'); await wait(600);
  const r = await readingLine(page);
  const t1 = await topOf(page, '1-1-child-of-1');
  const y = await page.evaluate(() => Math.round(scrollY));
  assert.strictEqual(y, 0, 'no scroll happened');
  assert.ok(t1 < t0 - 20, 'the wider column pulled 1.1 up, ' + Math.round(t0) + ' -> ' + Math.round(t1));
  assert.strictEqual(r.expected, '1-1-child-of-1', 'the line now sits below 1.1, ' + JSON.stringify(r));
  assert.strictEqual(r.active, r.expected, 'the highlight follows the line, ' + JSON.stringify(r));
});

// ── Short tail sections keep a clicked row lit (R5) ───────────────────────
// The last sections are too short to reach the reading line even at the
// bottom of the page, so a click on one of them used to light 8.1 instead.
const SHORT_TAIL = ['9-short-nine', '10-short-ten', '11-short-eleven'];
for (const [label, viewport, ctx] of [['desktop', DESKTOP, undefined], ['phone', PHONE, { hasTouch: true, isMobile: true }]]) {
  check('short tail: ' + label + ' click on each of the last short sections lights its row', viewport, async (page) => {
    for (const id of SHORT_TAIL) {
      await page.goto(FOLLOWUP_URL, { waitUntil: 'load' }); await wait(400);
      if (label === 'phone') { await page.click('#sidebar-toggle'); await wait(350); }
      await page.click('#toc-expand-all');
      await page.click('.toc-list a[href="#' + id + '"]'); await wait(600);
      const rows = await activeRows(page);
      assert.deepStrictEqual(rows.map((r) => r.href), ['#' + id], id + ': the clicked row is the one lit, got ' + JSON.stringify(rows.map((r) => r.href)));
    }
  }, ctx);
}
// Guard (green by design): only a click pins; a plain scroll to the bottom
// leaves the highlight on the reading line, not on the last row.
check('short tail: a plain scroll to the bottom does not light the last row', DESKTOP, async (page) => {
  await page.goto(FOLLOWUP_URL, { waitUntil: 'load' }); await wait(400);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await wait(500);
  const r = await readingLine(page);
  assert.notStrictEqual(r.expected, '11-short-eleven', 'the line is not on the last row, ' + JSON.stringify(r));
  assert.strictEqual(r.active, r.expected, 'the highlight follows the line, ' + JSON.stringify(r));
});

// ── The search freeze ends on a TOC click or a user scroll (R6, R6b) ──────
// Selecting a search result freezes the highlight on the hit's section so the
// jump does not move it. A TOC click, or a wheel / touch scroll in the content,
// is the reader moving on; a wheel over the sidebar (the results list) is not,
// and neither is a programmatic scroll.
async function frozenOnZebrafinch(page) {
  await page.goto(FOLLOWUP_URL, { waitUntil: 'load' }); await wait(400);
  await page.fill('#doc-search-input', 'zebrafinch');
  await page.press('#doc-search-input', 'Enter'); await wait(400);
  return page.evaluate(() => window.__readerState.activeSectionId);
}
check('frozen: a TOC click moves the highlight', DESKTOP, async (page) => {
  const frozenAt = await frozenOnZebrafinch(page);
  assert.notStrictEqual(frozenAt, '2-section-2', 'the search froze somewhere else, frozenAt=' + frozenAt);
  await page.click('#toc-expand-all');
  await page.click('.toc-list a[href="#2-section-2"]'); await wait(600);
  const rows = await activeRows(page);
  assert.deepStrictEqual(rows.map((r) => r.href), ['#2-section-2'], 'the clicked row is lit, got ' + JSON.stringify(rows.map((r) => r.href)));
});
check('frozen: a wheel in the content follows the reading line again', DESKTOP, async (page) => {
  const frozenAt = await frozenOnZebrafinch(page);
  // The visible middle of the content column (its box is far taller than the viewport).
  const pt = await page.evaluate(() => {
    const r = document.querySelector('main.content').getBoundingClientRect();
    return { x: Math.round((r.left + r.right) / 2), y: Math.round((Math.max(r.top, 0) + Math.min(r.bottom, innerHeight)) / 2) };
  });
  const hit = await page.evaluate(({ x, y }) => !!(document.elementFromPoint(x, y) || document.body).closest('main.content'), pt);
  assert.strictEqual(hit, true, 'the wheel point is over the content, ' + JSON.stringify(pt));
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.wheel(0, 1500); await wait(500);
  const r = await readingLine(page);
  assert.notStrictEqual(r.expected, frozenAt, 'the wheel moved the line off the frozen section, ' + JSON.stringify(r));
  assert.strictEqual(r.active, r.expected, 'the highlight follows the line, frozenAt=' + frozenAt + ' ' + JSON.stringify(r));
});
// Guard (green by design): a wheel over the results list, then a programmatic
// scroll, leaves the highlight frozen.
check('frozen: a wheel over the results list keeps it frozen', DESKTOP, async (page) => {
  const frozenAt = await frozenOnZebrafinch(page);
  const pt = await page.$eval('#search-results-list', (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height, 40) / 2) }; });
  const hit = await page.evaluate(({ x, y }) => !!(document.elementFromPoint(x, y) || document.body).closest('#search-results-list'), pt);
  assert.strictEqual(hit, true, 'the wheel point is over the results list, ' + JSON.stringify(pt));
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.wheel(0, 300); await wait(200);
  await page.evaluate(() => window.scrollBy(0, 1500)); await wait(500);
  const r = await readingLine(page);
  assert.notStrictEqual(r.expected, frozenAt, 'the scroll moved the line off the frozen section, ' + JSON.stringify(r));
  assert.strictEqual(r.active, frozenAt, 'still frozen, ' + JSON.stringify(r));
});
check('frozen: a touchmove in the content unfreezes', DESKTOP, async (page) => {
  const frozenAt = await frozenOnZebrafinch(page);
  await page.evaluate(() => document.querySelector('main.content p').dispatchEvent(new Event('touchmove', { bubbles: true })));
  await page.evaluate(() => window.scrollBy(0, 1500)); await wait(500);
  const r = await readingLine(page);
  assert.notStrictEqual(r.expected, frozenAt, 'the scroll moved the line off the frozen section, ' + JSON.stringify(r));
  assert.strictEqual(r.active, r.expected, 'the highlight follows the line, frozenAt=' + frozenAt + ' ' + JSON.stringify(r));
});

// Keyboard scrolling is scrolling (R17): with focus on the page, a scroll key
// ends the freeze like a wheel does. Inside the sidebar or an editable field
// the same keys are the reader working that control, and keep it.
for (const [key, times] of [['PageDown', 3], ['Space', 3], ['End', 1], ['ArrowDown', 20]]) {
  check('frozen: ' + (/^[AEIOU]/.test(key) ? 'an ' : 'a ') + key + ' in the content follows the reading line', DESKTOP, async (page) => {
    const frozenAt = await frozenOnZebrafinch(page);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    const focus = await page.evaluate(() => document.activeElement.tagName);
    assert.strictEqual(focus, 'BODY', 'focus is on the page');
    for (let i = 0; i < times; i++) { await page.keyboard.press(key); await wait(120); }
    await wait(500);
    const r = await readingLine(page);
    assert.notStrictEqual(r.expected, frozenAt, key + ' moved the line off the frozen section, ' + JSON.stringify(r));
    assert.strictEqual(r.active, r.expected, key + ': the highlight follows the line, frozenAt=' + frozenAt + ' ' + JSON.stringify(r));
  });
}
// Guard (green by design): the same keys typed into the search box are not a page scroll.
check('frozen: scroll keys inside the search box keep it frozen', DESKTOP, async (page) => {
  const frozenAt = await frozenOnZebrafinch(page);
  const focus = await page.evaluate(() => document.activeElement.id);
  assert.strictEqual(focus, 'doc-search-input', 'focus stays in the search box');
  for (const key of ['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Space']) { await page.keyboard.press(key); await wait(80); }
  await page.evaluate(() => window.scrollBy(0, 1500)); await wait(500);
  const r = await readingLine(page);
  assert.notStrictEqual(r.expected, frozenAt, 'the scroll moved the line off the frozen section, ' + JSON.stringify(r));
  assert.strictEqual(r.active, frozenAt, 'still frozen, ' + JSON.stringify(r));
});
// A sideways wheel (a wide table's swipe) and ctrl+wheel (zoom) do not scroll
// the page, so they keep the freeze.
check('frozen: a sideways wheel or a ctrl+wheel keeps it frozen', DESKTOP, async (page) => {
  const frozenAt = await frozenOnZebrafinch(page);
  const pt = await page.evaluate(() => {
    const r = document.querySelector('main.content').getBoundingClientRect();
    return { x: Math.round((r.left + r.right) / 2), y: Math.round((Math.max(r.top, 0) + Math.min(r.bottom, innerHeight)) / 2) };
  });
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.wheel(120, 0); await wait(200);
  await page.evaluate(() => document.querySelector('main.content p').dispatchEvent(new WheelEvent('wheel', { deltaY: 120, ctrlKey: true, bubbles: true })));
  await page.evaluate(() => window.scrollBy(0, 1500)); await wait(500);
  const r = await readingLine(page);
  assert.notStrictEqual(r.expected, frozenAt, 'the scroll moved the line off the frozen section, ' + JSON.stringify(r));
  assert.strictEqual(r.active, frozenAt, 'still frozen, ' + JSON.stringify(r));
});
// The lightbox is a layer of its own: a wheel there zooms the picture.
check('frozen: a wheel in the lightbox keeps it frozen', DESKTOP, async (page) => {
  await page.click('main.content .graphviz svg'); await wait(300);
  const open = await page.evaluate(() => { const b = document.querySelector('.lightbox'); return !!b && !b.hidden; });
  assert.strictEqual(open, true, 'lightbox open');
  await page.fill('#doc-search-input', 'zebrafinch');
  await page.press('#doc-search-input', 'Enter'); await wait(400);
  const frozenAt = await page.evaluate(() => window.__readerState.activeSectionId);
  const pt = await page.$eval('.lightbox-stage', (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; });
  const hit = await page.evaluate(({ x, y }) => !!(document.elementFromPoint(x, y) || document.body).closest('.lightbox'), pt);
  assert.strictEqual(hit, true, 'the wheel point is in the lightbox, ' + JSON.stringify(pt));
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.wheel(0, 120); await wait(300);
  await page.keyboard.press('Escape'); await wait(300);
  await page.evaluate(() => window.scrollBy(0, 1500)); await wait(500);
  const r = await readingLine(page);
  assert.notStrictEqual(r.expected, frozenAt, 'the scroll moved the line off the frozen section, ' + JSON.stringify(r));
  assert.strictEqual(r.active, frozenAt, 'still frozen, ' + JSON.stringify(r));
});
// The freeze also stopped the TOC from opening the hit's path. When the reader
// scrolls away but stays in the hit's (nested) section, the active id does not
// change, so the row must still be revealed and centred on the way out.
check('frozen: after a small wheel inside a nested hit the row is revealed and centred', TRACK_VIEW, async (page) => {
  await page.goto(TRACK_URL, { waitUntil: 'load' }); await wait(500);
  // Paragraph 2, so the centred hit leaves 20.3's heading well above the line:
  // the line is in the hit's section before the wheel as well as after it.
  await page.fill('#doc-search-input', 'paragraph 2 of section 20.3');
  await page.press('#doc-search-input', 'Enter'); await wait(400);
  const frozenAt = await page.evaluate(() => window.__readerState.activeSectionId);
  assert.strictEqual(frozenAt, '20-3-sub-20-3', 'frozen on the nested hit');
  const r0 = await readingLine(page);
  assert.strictEqual(r0.expected, frozenAt, 'the line is in the hit section before the wheel, ' + JSON.stringify(r0));
  const pt = await page.evaluate(() => {
    const r = document.querySelector('main.content').getBoundingClientRect();
    return { x: Math.round((r.left + r.right) / 2), y: Math.round((Math.max(r.top, 0) + Math.min(r.bottom, innerHeight)) / 2) };
  });
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.wheel(0, 40); await wait(600);
  const r = await readingLine(page);
  assert.strictEqual(r.expected, frozenAt, 'still in the hit section, ' + JSON.stringify(r));
  assert.strictEqual(r.active, frozenAt, 'active row unchanged, ' + JSON.stringify(r));
  const row = await page.evaluate(() => {
    const a = document.querySelector('.toc a.is-active');
    const sc = document.querySelector('.toc > .toc-list');
    const br = sc.getBoundingClientRect();
    const rr = a.getBoundingClientRect();
    const closed = a.closest('details:not([open])');
    return { href: a.getAttribute('href'), underClosed: !!closed && closed.querySelector('summary a') !== a, h: Math.round(rr.height),
      inBox: rr.top >= br.top - 1 && rr.bottom <= br.bottom + 1,
      mid: +(((rr.top + rr.bottom) / 2 - br.top) / sc.clientHeight).toFixed(2),
      atEdge: sc.scrollTop <= 1 || sc.scrollTop >= sc.scrollHeight - sc.clientHeight - 1 };
  });
  assert.strictEqual(row.underClosed, false, 'the row is not inside a closed section, ' + JSON.stringify(row));
  assert.strictEqual(row.inBox, true, 'the row is inside the TOC box, ' + JSON.stringify(row));
  assert.strictEqual(row.atEdge, false, 'the TOC can centre this row, ' + JSON.stringify(row));
  assert.ok(row.mid >= 0.2 && row.mid <= 0.6, 'the row is centred, ' + JSON.stringify(row));
});

(async () => {
  const engines = (process.env.MD2DOC_ENGINES || 'chromium,webkit').split(',').map((s) => s.trim()).filter(Boolean);
  const only = process.argv[2];
  let failed = 0;
  let ran = 0;
  for (const engine of engines) {
    const browser = await playwright[engine].launch();
    try {
      for (const c of checks) {
        if (only && !c.name.includes(only)) continue;
        if (c.opts.engines && !c.opts.engines.includes(engine)) continue;
        ran++;
        const own = c.opts.launch ? await playwright[engine].launch(c.opts.launch) : null;
        const context = await (own || browser).newContext(Object.assign({ viewport: c.viewport }, c.ctx));
        const page = await context.newPage();
        try {
          await page.goto(URL, { waitUntil: 'load' });
          await wait(400);
          await c.fn(page);
          console.log('ok   [' + engine + '] ' + c.name);
        } catch (e) {
          failed++;
          console.log('FAIL [' + engine + '] ' + c.name + '\n     ' + (e && e.message));
        } finally {
          await context.close();
          if (own) await own.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
  if (!ran) { console.error('no check matched ' + JSON.stringify(only)); process.exit(1); }
  if (failed) { console.error(failed + ' of ' + ran + ' click check(s) failed'); process.exit(1); }
  console.log('reader-click: ' + ran + ' checks passed');
})();
