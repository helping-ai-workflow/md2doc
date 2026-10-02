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

const checks = [];
function check(name, viewport, fn, ctx) { checks.push({ name, viewport, fn, ctx }); }

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
check('desktop: dark text meets WCAG AA where it is actually drawn', DESKTOP, async (page) => {
  await gotoTheme(page);
  await page.click('#md2doc-theme-toggle'); await wait(500);
  const on = await themeState(page);
  assert.deepStrictEqual([on.attr, on.bg], ['dark', 'rgb(27, 27, 29)'], 'dark is actually on before measuring');
  await page.fill('#doc-search-input', 'zebrafinch'); await page.press('#doc-search-input', 'Enter'); await wait(400);
  const pairs = await page.evaluate(() => {
    function rgb(s) { return s.match(/[\d.]+/g).slice(0, 3).map(Number); }
    function lum(c) { return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); function f(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); } }
    function ratio(a, b) { const x = lum(rgb(a)), y = lum(rgb(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
    function bgOf(e) { for (; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; const n = c.match(/[\d.]+/g) || []; if (c !== 'transparent' && !(n.length > 3 && +n[3] < 1)) return c; } return 'rgb(255, 255, 255)'; }
    const sel = { body: '.content p', code: '.content :not(pre) > code', link: '.content a', toc: '.toc-list a', active: '.toc a.is-active', mark: 'mark.search-hit.is-selected', snippet: '.search-result-snippet' };
    const out = {};
    for (const k in sel) { const e = document.querySelector(sel[k]); if (e) out[k] = +ratio(getComputedStyle(e).color, bgOf(e)).toFixed(2); }
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

// ── Run ─────────────────────────────────────────────────────────────────────
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
        ran++;
        const context = await browser.newContext(Object.assign({ viewport: c.viewport }, c.ctx));
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
