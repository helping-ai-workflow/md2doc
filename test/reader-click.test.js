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
function check(name, viewport, fn) { checks.push({ name, viewport, fn }); }

// ── Desktop ─────────────────────────────────────────────────────────────────
check('desktop: TOC links jump and light exactly one blue row, path bold', DESKTOP, async (page) => {
  await page.click('#toc-expand-all');
  for (const id of ['2-section-2', '3-3-a-deliberately-long-subsection-title-that-overflows-the-sidebar-width-by-a-wide-margin', '5-1-child-of-5', '8-section-8']) {
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
        const context = await browser.newContext({ viewport: c.viewport });
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
