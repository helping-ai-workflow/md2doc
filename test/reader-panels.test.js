#!/usr/bin/env node
'use strict';

// Reader panel ergonomics: compact search results with the hit highlighted,
// a hover-revealed draggable splitter between sidebar and content, and
// shift+wheel horizontal peek inside the TOC (titles no longer ellipsized).

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const puppeteer = require('puppeteer');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'lib', 'md2doc.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-panels-'));
const mdPath = path.join(tmpDir, 'doc.md');
const htmlPath = path.join(tmpDir, 'doc.html');

const longBefore = Array.from({ length: 40 }, (_, i) => 'lead' + i).join(' ');
const longAfter = Array.from({ length: 40 }, (_, i) => 'tail' + i).join(' ');

fs.writeFileSync(mdPath, [
  '# Alpha Root',
  '',
  'Intro paragraph.',
  '',
  '## Beta Chapter',
  '',
  longBefore + ' Zebrafinch ' + longAfter,
  '',
  '### Gamma Section',
  '',
  '#### Delta Subsection With An Extremely Long Title That Overflows The Sidebar Width Completely And Then Some More Words',
  '',
  'Deep body text.',
  '',
].join('\n'), 'utf8');

const run = spawnSync(process.execPath, [LIB, mdPath, htmlPath], { cwd: REPO, encoding: 'utf8' });
assert.strictEqual(run.status, 0, 'panels fixture renders: ' + run.stderr);

const html = fs.readFileSync(htmlPath, 'utf8');

// ── Static markup / CSS assertions ──────────────────────────────────────────
assert.match(html, />Search<\/label>/, 'search label is just "Search"');
assert.doesNotMatch(html, /Search this spec/, 'old verbose label removed');
assert.match(html, /id="sidebar-splitter"/, 'splitter element present');
assert.match(html, /\.toc a \{[^}]*white-space: nowrap;[^}]*\}/, 'TOC links stay single-line');
assert.doesNotMatch(html, /\.toc a \{[^}]*text-overflow: ellipsis;[^}]*\}/, 'TOC ellipsis removed so horizontal peek can reveal full titles');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 800 });
    await page.goto('file://' + htmlPath, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 300));

    // ── 1. Search: compact snippet with highlighted hit ────────────────────
    await page.type('#doc-search-input', 'zebrafinch');
    await page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 200));

    const snippet = await page.evaluate(() => {
      const el = document.querySelector('.search-result-snippet');
      if (!el) return null;
      const mark = el.querySelector('mark');
      return {
        text: el.textContent,
        markText: mark ? mark.textContent : null,
        lineClamp: getComputedStyle(el).webkitLineClamp,
      };
    });
    assert.ok(snippet, 'a search result snippet renders');
    assert.strictEqual(snippet.markText, 'Zebrafinch', 'the hit keyword is wrapped in <mark> (original casing)');
    assert.ok(snippet.text.length <= 95,
      'snippet is compact (' + snippet.text.length + ' chars <= 95)');
    assert.strictEqual(snippet.lineClamp, '2', 'snippet clamps to 2 lines');

    await page.click('#doc-search-clear');
    await new Promise((r) => setTimeout(r, 100));

    // ── 2. Splitter: hover affordance + drag resizes + persists ────────────
    const splitterBox = await page.$eval('#sidebar-splitter', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + Math.min(300, r.height / 2), cursor: getComputedStyle(el).cursor };
    });
    assert.strictEqual(splitterBox.cursor, 'col-resize', 'splitter shows a col-resize cursor');

    const widthBefore = await page.$eval('.reader-sidebar', (el) => el.offsetWidth);
    await page.mouse.move(splitterBox.x, splitterBox.y);
    await page.mouse.down();
    await page.mouse.move(splitterBox.x + 120, splitterBox.y, { steps: 5 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 100));

    const widthAfter = await page.$eval('.reader-sidebar', (el) => el.offsetWidth);
    assert.ok(Math.abs(widthAfter - (widthBefore + 120)) <= 3,
      'dragging the splitter widens the sidebar (' + widthBefore + ' -> ' + widthAfter + ')');

    const stored = await page.evaluate(() => localStorage.getItem('md2doc.sidebar.width'));
    assert.ok(stored && Math.abs(Number(stored) - widthAfter) <= 3, 'width persisted to localStorage');

    await page.reload({ waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 300));
    const widthReloaded = await page.$eval('.reader-sidebar', (el) => el.offsetWidth);
    assert.ok(Math.abs(widthReloaded - widthAfter) <= 3,
      'width survives reload (' + widthReloaded + ' vs ' + widthAfter + ')');

    // Double-click resets to the default width.
    const box2 = await page.$eval('#sidebar-splitter', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + Math.min(300, r.height / 2) };
    });
    await page.mouse.click(box2.x, box2.y, { clickCount: 2 });
    await new Promise((r) => setTimeout(r, 100));
    const widthReset = await page.$eval('.reader-sidebar', (el) => el.offsetWidth);
    assert.ok(Math.abs(widthReset - widthBefore) <= 3,
      'double-click resets width (' + widthReset + ' vs default ' + widthBefore + ')');
    const storedAfterReset = await page.evaluate(() => localStorage.getItem('md2doc.sidebar.width'));
    assert.strictEqual(storedAfterReset, null, 'reset clears the stored width');

    // ── 3. TOC: shift+wheel horizontal peek ─────────────────────────────────
    await page.click('#toc-expand-all');
    await new Promise((r) => setTimeout(r, 100));

    const tocState = await page.evaluate(() => {
      const list = document.querySelector('.toc > .toc-list');
      return {
        overflows: list.scrollWidth > list.clientWidth,
        scrollLeft: list.scrollLeft,
        overflowX: getComputedStyle(list).overflowX,
      };
    });
    assert.ok(tocState.overflows, 'long deep title makes the TOC horizontally overflow');
    assert.strictEqual(tocState.scrollLeft, 0, 'TOC starts anchored at the left');
    assert.strictEqual(tocState.overflowX, 'hidden', 'no horizontal scrollbar (overflow-x hidden)');

    const afterShiftWheel = await page.evaluate(() => {
      const list = document.querySelector('.toc > .toc-list');
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, shiftKey: true, bubbles: true, cancelable: true }));
      return list.scrollLeft;
    });
    assert.ok(afterShiftWheel > 0, 'shift+wheel scrolls the TOC horizontally (' + afterShiftWheel + ')');

    const afterPlainWheel = await page.evaluate(() => {
      const list = document.querySelector('.toc > .toc-list');
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
      return list.scrollLeft;
    });
    assert.strictEqual(afterPlainWheel, afterShiftWheel, 'plain wheel leaves horizontal position untouched');

    console.log('md2doc reader-panels test passed');
  } finally {
    await browser.close();
  }
})().catch((err) => { console.error((err && err.stack) || err); process.exit(1); });
