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
        scrollbarWidth: getComputedStyle(list).scrollbarWidth,
      };
    });
    assert.ok(tocState.overflows, 'long deep title makes the TOC horizontally overflow');
    assert.strictEqual(tocState.scrollLeft, 0, 'TOC starts anchored at the left');
    assert.strictEqual(tocState.overflowX, 'auto', 'horizontal scrollbar available for mouse drag (overflow-x auto)');
    assert.strictEqual(tocState.scrollbarWidth, 'thin', 'thin scrollbars keep the sidebar quiet');

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

    // ── 4. The mobile hamburger, driven rather than read off the stylesheet ──
    //
    // Two reader-mode behaviours of .sidebar-toggle — that it holds its
    // viewport coordinate across a scroll, and that it is gone above 1080px —
    // used to be driven by a row in test/editor-journey.test.js. That row ran
    // on an EDIT-mode page, but edit mode carried no override of its own at
    // the time, so the reader button's behaviour rode along on it. T11-2 hid
    // the button in edit mode and rewrote the row; what the reader side was
    // left with is a regex over the rendered CSS text, which cannot say
    // whether a rendered element stays put or disappears. Grepped at the HEAD
    // this section was added on: outside this file, `.sidebar-toggle` reaches
    // only test/editor-journey.test.js (edit mode throughout) and a prose
    // mention in test/toolbar-model.test.js, and test/md2doc.test.js's own
    // sidebar row says in as many words that it drives "the rail-collapse
    // path (#toc-collapse-toggle), not the mobile hamburger". So it is driven
    // here, in reader mode, where the button is reachable. The static half
    // stays in test/editor-journey.test.js (reader output must NOT carry the
    // edit-only `display: none` override) — it answers a different question.
    //
    // Every assertion below has its own ablation — one declaration in
    // lib/md2doc.js changed at a time, the whole file re-run, the message
    // quoted from the run rather than predicted:
    //   * base `display: none` -> `inline-flex`
    //     -> "1081px is outside the reader stylesheet's max-width:1080px block
    //        … got flex"
    //   * `@media (max-width: 1080px)` -> `1079px`
    //     -> "max-width: 1080px includes 1080 itself … got none"
    //   * the media block's `.sidebar-toggle { display: inline-flex; … }` deleted
    //     -> "at 1000px wide the reader drawer toggle must be rendered …
    //        {"display":"none","w":0,"h":0,"hitIsToggle":false}"
    //   * `z-index: 100` -> `-1`
    //     -> "the toggle must win the hit test at its own centre …
    //        {"hitIsToggle":false,"hit":"DIV.page-layout"}"
    //   * `position: fixed` -> `static`
    //     -> "must stay at the same viewport coordinate across a scroll …
    //        got top=-400 after scrollY=400, was 0"
    // Not one of those five is visible to a regex over the stylesheet text.
    const tallMdPath = path.join(tmpDir, 'tall.md');
    const tallHtmlPath = path.join(tmpDir, 'tall.html');
    fs.writeFileSync(tallMdPath, [
      '# Tall Root',
      '',
      ...Array.from({ length: 60 }, (_, i) => 'Body paragraph number ' + i + '.\n'),
    ].join('\n'), 'utf8');
    const tallRun = spawnSync(process.execPath, [LIB, tallMdPath, tallHtmlPath], { cwd: REPO, encoding: 'utf8' });
    assert.strictEqual(tallRun.status, 0, 'tall reader fixture renders: ' + tallRun.stderr);

    const togglePage = await browser.newPage();
    try {
      // ≤1080px — the reader stylesheet turns the sidebar into an off-canvas
      // drawer at this width and this button is what opens it, so it has to be
      // present, hit-testable, and immune to the page scrolling out from under
      // it.
      await togglePage.setViewport({ width: 1000, height: 700 });
      await togglePage.goto('file://' + tallHtmlPath, { waitUntil: 'load' });
      await new Promise((r) => setTimeout(r, 250));

      const shown = await togglePage.evaluate(() => {
        const el = document.querySelector('.sidebar-toggle');
        if (!el) return { dom: false };
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          dom: true, display: getComputedStyle(el).display,
          position: getComputedStyle(el).position,
          top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
          hitIsToggle: !!(hit && hit.closest && hit.closest('.sidebar-toggle')),
          hit: hit ? hit.tagName + '.' + String(hit.className || '') : null,
        };
      });
      assert.ok(shown.dom && shown.display !== 'none' && shown.w > 0 && shown.h > 0,
        'at 1000px wide the reader sidebar is an off-canvas drawer and this ' +
        'button is what opens it, so it must be rendered. got ' + JSON.stringify(shown));
      assert.ok(shown.hitIsToggle,
        'the toggle must win the hit test at its own centre, or a real pointer ' +
        'never reaches it. got ' + JSON.stringify(shown));

      // The pin. Precondition first: a page that does not actually scroll would
      // make the "same coordinate afterwards" assertion pass without measuring
      // anything.
      const scrolled = await togglePage.evaluate(async () => {
        window.scrollTo(0, 400);
        await new Promise((r) => requestAnimationFrame(() => r()));
        const el = document.querySelector('.sidebar-toggle');
        return { y: Math.round(window.scrollY), top: Math.round(el.getBoundingClientRect().top) };
      });
      assert.ok(scrolled.y > 100,
        'precondition: the tall fixture must really scroll, otherwise the pin ' +
        'assertion below is vacuous. scrollY=' + scrolled.y);
      assert.strictEqual(scrolled.top, shown.top,
        'the reader drawer toggle must stay at the same viewport coordinate ' +
        'across a scroll (position: fixed) — got top=' + scrolled.top +
        ' after scrollY=' + scrolled.y + ', was ' + shown.top);

      // Above the breakpoint the desktop rail is present, so the hamburger has
      // to be gone rather than floating over the content it duplicates. 1081
      // is the first width outside `@media (max-width: 1080px)`; 1400 is an
      // ordinary desktop window.
      for (const w of [1081, 1400]) {
        await togglePage.setViewport({ width: w, height: 700 });
        await new Promise((r) => setTimeout(r, 200));
        const d = await togglePage.evaluate(() => {
          const el = document.querySelector('.sidebar-toggle');
          return el ? getComputedStyle(el).display : '(absent)';
        });
        assert.strictEqual(d, 'none',
          w + 'px is outside the reader stylesheet\'s max-width:1080px block, so ' +
          '.sidebar-toggle must be display:none there — the sidebar is laid out ' +
          'in flow at this width, so a fixed button over it opens nothing. got ' + d);
      }
      // And the breakpoint itself is inclusive, which is what makes 1081 the
      // right width to test above rather than 1080.
      await togglePage.setViewport({ width: 1080, height: 700 });
      await new Promise((r) => setTimeout(r, 200));
      const at1080 = await togglePage.evaluate(() => getComputedStyle(document.querySelector('.sidebar-toggle')).display);
      assert.notStrictEqual(at1080, 'none',
        'max-width: 1080px includes 1080 itself — the toggle must still be shown ' +
        'there. got ' + at1080);
    } finally {
      await togglePage.close();
    }

    console.log('md2doc reader-panels test passed');
  } finally {
    await browser.close();
  }
})().catch((err) => { console.error((err && err.stack) || err); process.exit(1); });
