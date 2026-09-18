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


    // ── 5. A diagram too wide to read gets its natural size and a scroll box ─
    //
    // The bug report behind this section is "the waveform on the reading page
    // is a picture I cannot read". Shrink-to-fit (.content svg { max-width:
    // 100% }) is the right default right up until the aspect ratio makes it
    // wrong: the column is fixed, so the taller the width/height ratio the
    // harder the same rule squeezes the glyphs.
    //
    // MEASURED on this branch, 1280x900 viewport, .content clientWidth 918,
    // WaveSkin's own label text is 11pt = 14.667px, one screenshot per row at
    // deviceScaleFactor 1 and the verdict read off the screenshot:
    //
    //   cycles  natural px  scale  label px  legible?
    //       10         480  1.000     14.67  yes (never shrunk at all)
    //       25        1080  0.850     12.47  yes
    //       30        1280  0.718     10.52  yes
    //       34        1440  0.638      9.35  yes — last comfortable row
    //       36        1520  0.604      8.86  "clk" starts breaking up
    //       38        1600  0.574      8.42  lowercase labels mush together
    //       40        1680  0.547      8.02  no
    //       60        2480  0.370      5.43  no — this is what was reported
    //
    // The floor landed between 8.86 and 9.35 and is declared once, in
    // lib/md2doc.js as DIAGRAM_FONT_FLOOR. This section reads that number out
    // of the rendered page rather than repeating it, so the two cannot drift;
    // the number itself is bracketed by the two assertions that do not
    // mention it — the 60-cycle diagram must scroll (so the floor cannot be
    // lowered to nothing) and the 25-cycle one must not (so it cannot be
    // raised until every diagram scrolls).
    //
    // Everything asserted here is a rendered width, a computed overflow or a
    // measured scroll extent. A regex over the stylesheet would pass on a
    // rule that no element ever matches, which is exactly the failure this
    // section exists to catch.
    const wideMdPath = path.join(tmpDir, 'wide.md');
    const wideHtmlPath = path.join(tmpDir, 'wide.html');
    const waveOf = (n) => JSON.stringify({
      signal: [
        { name: 'clk', wave: 'p'.repeat(n) },
        {
          name: 'data',
          wave: 'x' + '3.'.repeat(Math.floor((n - 1) / 2)).slice(0, n - 1),
          data: Array.from({ length: Math.ceil(n / 2) }, (_, i) => 'D' + i),
        },
      ],
    });
    fs.writeFileSync(wideMdPath, [
      '# Wide',
      '',
      '## Narrow', '', '```wavedrom', waveOf(10), '```', '',
      '## Mid', '', '```wavedrom', waveOf(25), '```', '',
      '## Wide', '', '```wavedrom', waveOf(60), '```', '',
    ].join('\n'), 'utf8');
    const wideRun = spawnSync(process.execPath, [LIB, wideMdPath, wideHtmlPath], { cwd: REPO, encoding: 'utf8' });
    assert.strictEqual(wideRun.status, 0, 'wide-diagram fixture renders: ' + wideRun.stderr);
    const wideHtml = fs.readFileSync(wideHtmlPath, 'utf8');

    const floorMatch = /DIAGRAM_FONT_FLOOR\s*=\s*([0-9.]+)/.exec(wideHtml);
    assert.ok(floorMatch, 'the reader runtime declares a legibility floor (DIAGRAM_FONT_FLOOR)');
    const FLOOR = Number(floorMatch[1]);

    const widePage = await browser.newPage();
    try {
      // WaveDrom's own ProcessAll is scheduled at DOMContentLoaded, load,
      // +250ms and +1000ms (see the wavedrom engine block in lib/md2doc.js),
      // so nothing here may be read before the last of those has landed.
      const settle = async () => { await new Promise((r) => setTimeout(r, 1600)); };
      const readDiagrams = () => widePage.evaluate(() => {
        const content = document.querySelector('.content');
        // Reader mode never adds .wavedrom-diagram (that pass is edit-mode
        // only), so the host is the id-prefixed div — the other half of
        // LIGHTBOX_TARGETS. ProcessAll leaves several empty duplicates of
        // each id behind; only one of them ever holds the svg.
        const rows = [];
        document.querySelectorAll('[id^="WaveDrom_Display_"] > svg').forEach((svg) => {
          const host = svg.parentElement;
          const natural = parseFloat(svg.getAttribute('width'));
          const rect = svg.getBoundingClientRect();
          let minFont = Infinity;
          svg.querySelectorAll('text').forEach((t) => {
            const size = parseFloat(getComputedStyle(t).fontSize);
            if (isFinite(size) && size < minFont) minFont = size;
          });
          rows.push({
            natural,
            rendered: Math.round(rect.width),
            minFont: +minFont.toFixed(2),
            effective: +(minFont * (rect.width / natural)).toFixed(2),
            overflowX: getComputedStyle(host).overflowX,
            scrollWidth: host.scrollWidth,
            clientWidth: host.clientWidth,
            scrolls: host.scrollWidth > host.clientWidth,
          });
        });
        rows.sort((a, b) => a.natural - b.natural);
        return { contentW: Math.round(content.clientWidth), rows };
      });

      await widePage.setViewport({ width: 1280, height: 900 });
      await widePage.goto('file://' + wideHtmlPath, { waitUntil: 'load' });
      await settle();

      const desk = await readDiagrams();
      assert.strictEqual(desk.rows.length, 3,
        'the fixture must render three waveforms, or the rows below are not the ' +
        'ones this section names. got ' + JSON.stringify(desk));
      const [narrow, mid, wide] = desk.rows;

      // Fixture validity. If the widest diagram were not actually in
      // illegible territory when fitted, every assertion after this one could
      // pass with the feature deleted.
      const fittedLabelPx = +(wide.minFont * desk.contentW / wide.natural).toFixed(2);
      assert.ok(fittedLabelPx < 6,
        'precondition: fitted into this column the 60-cycle waveform would draw ' +
        'its labels at ' + fittedLabelPx + 'px, and the sweep above only calls ' +
        'that unreadable below ~9. contentW=' + desk.contentW + ' natural=' + wide.natural);
      assert.ok(narrow.natural < desk.contentW && mid.natural > desk.contentW,
        'precondition: the narrow waveform must fit the column untouched and the ' +
        'mid one must be shrunk by it. got ' + JSON.stringify({ contentW: desk.contentW, narrow: narrow.natural, mid: mid.natural }));

      // The reported diagram: natural size, in a real scroll box.
      assert.strictEqual(wide.rendered, wide.natural,
        'the diagram that cannot survive shrink-to-fit must be drawn at its ' +
        'natural width instead. got ' + JSON.stringify(wide));
      assert.strictEqual(wide.overflowX, 'auto',
        'and its host must be the thing that scrolls, or the page does. got ' + JSON.stringify(wide));
      assert.ok(wide.scrolls,
        'a scroll extent that actually exceeds the box is what makes the rest of ' +
        'the waveform reachable — the same observable test/lightbox.test.js pins ' +
        'for the overlay. got scrollWidth=' + wide.scrollWidth + ' clientWidth=' + wide.clientWidth);
      assert.ok(wide.effective >= FLOOR,
        'and its smallest label must now clear the declared floor of ' + FLOOR +
        'px. got ' + wide.effective + 'px');

      // Shrink-to-fit is still the default for everything that survives it.
      assert.strictEqual(mid.rendered, desk.contentW,
        'a diagram whose labels stay above the floor when fitted must keep ' +
        'fitting — the rule is legibility, not "wavedrom scrolls". got ' + JSON.stringify(mid));
      assert.ok(!mid.scrolls && mid.overflowX === 'visible',
        'so its host must not become a scroll box either. got ' + JSON.stringify(mid));
      assert.ok(mid.effective >= FLOOR,
        'sanity: the mid fixture is only a valid "stays fitted" case while its ' +
        'fitted labels really are above the floor. got ' + mid.effective + ' vs ' + FLOOR);
      assert.ok(narrow.rendered === narrow.natural && !narrow.scrolls && narrow.overflowX === 'visible',
        'a diagram narrower than the column is never shrunk in the first place ' +
        'and must be left alone. got ' + JSON.stringify(narrow));

      // The verdict is a function of the column width, so it has to be
      // recomputed when the column changes. 640px puts the mid diagram below
      // the floor; 1280 puts it back above.
      await widePage.setViewport({ width: 640, height: 900 });
      await new Promise((r) => setTimeout(r, 400));
      const narrowCol = await readDiagrams();
      const midNarrow = narrowCol.rows[1];
      assert.ok(midNarrow.minFont * narrowCol.contentW / midNarrow.natural < FLOOR,
        'precondition: at a ' + narrowCol.contentW + 'px column the mid diagram ' +
        'must really fall below the floor, or the recompute below is vacuous');
      assert.strictEqual(midNarrow.rendered, midNarrow.natural,
        'narrowing the column must re-run the verdict — the mid diagram is now ' +
        'the unreadable one. got ' + JSON.stringify(midNarrow));

      await widePage.setViewport({ width: 1280, height: 900 });
      await new Promise((r) => setTimeout(r, 400));
      const backWide = await readDiagrams();
      const midBack = backWide.rows[1];
      assert.strictEqual(midBack.rendered, backWide.contentW,
        'and widening it back must undo that, not latch. got ' + JSON.stringify(midBack));

      // A scrolling diagram is still a lightbox target.
      const popped = await widePage.evaluate(() => {
        const svg = document.querySelectorAll('[id^="WaveDrom_Display_"] > svg')[2];
        svg.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
        const box = document.querySelector('.lightbox');
        return { open: !!box && !box.hidden };
      });
      assert.ok(popped.open,
        'clicking the wide diagram must still pop the lightbox — the scroll box ' +
        'is added to the same node the click handler resolves to. got ' + JSON.stringify(popped));
      await widePage.keyboard.press('Escape');

      // PDF has no scrollbars: an unscaled 2480px svg there is a diagram with
      // its right-hand half cut off, which is worse than a small one. The
      // print stylesheet has to hand it back to shrink-to-fit.
      await widePage.emulateMediaType('print');
      await new Promise((r) => setTimeout(r, 200));
      const printed = await readDiagrams();
      const widePrint = printed.rows[2];
      assert.strictEqual(widePrint.overflowX, 'visible',
        '@media print must give the host its overflow back, or the export clips ' +
        'instead of scaling. got ' + JSON.stringify(widePrint));
      assert.ok(widePrint.rendered <= printed.contentW,
        'and the svg must fit the printed column again (' + widePrint.rendered +
        ' <= ' + printed.contentW + '). got ' + JSON.stringify(widePrint));
      await widePage.emulateMediaType(null);
    } finally {
      await widePage.close();
    }


    // ── 5b. The same floor, on the other diagram engine ──────────────────────
    //
    // This is not "mermaid too, for symmetry". Every line of the rule that
    // could be engine-specific was wrong for mermaid on the first pass, and
    // each way of being wrong was SILENT — the diagram simply kept shrinking,
    // which is what it did before the feature existed:
    //
    //   * a waveform states width="2480"; mermaid states width="100%" and puts
    //     the real number in the viewBox, so reading the width attribute makes
    //     every mermaid diagram look nine times wider than the space it has,
    //     i.e. "already fits";
    //   * a waveform labels with svg <text>; mermaid labels with an html
    //     <span> inside a <foreignObject> (this 40-node fixture: 79 of them and
    //     zero <text>), so a text-only measurement measures nothing;
    //   * max-width alone frees a diagram whose width is in px and does
    //     nothing for one whose width is a percentage of the box it is trying
    //     to escape;
    //   * and the runtime is emitted from a JS template literal, where "\s"
    //     collapses to "s" — so the viewBox parse really did ship split on
    //     /[s,]+/ once, returning 0 for every diagram, and node --check was
    //     happy with it.
    //
    // MEASURED here, same 918px column, mermaid's labels at 16px:
    //
    //   stages  natural px  fitted label px  outcome
    //        4       626.6            16.00  never shrunk
    //        8      1287.3            11.41  shrunk, stays fitted
    //       10      1617.6             9.08  shrunk, stays fitted (just)
    //       40      6838.3             2.15  natural size + scroll box
    const mermMdPath = path.join(tmpDir, 'merm.md');
    const mermHtmlPath = path.join(tmpDir, 'merm.html');
    const flowOf = (n) => ['```mermaid', 'flowchart LR',
      '  ' + Array.from({ length: n }, (_, i) => 'S' + n + '_' + i + '[Stage ' + i + ']').join(' --> '),
      '```', ''].join('\n');
    fs.writeFileSync(mermMdPath, [
      '# Flow', '',
      '## Narrow', '', flowOf(4),
      '## Mid', '', flowOf(8),
      '## Wide', '', flowOf(40),
    ].join('\n'), 'utf8');
    const mermRun = spawnSync(process.execPath, [LIB, mermMdPath, mermHtmlPath], { cwd: REPO, encoding: 'utf8' });
    assert.strictEqual(mermRun.status, 0, 'mermaid fixture renders: ' + mermRun.stderr);

    const mermPage = await browser.newPage();
    try {
      await mermPage.setViewport({ width: 1280, height: 900 });
      await mermPage.goto('file://' + mermHtmlPath, { waitUntil: 'load' });
      await mermPage.waitForFunction(
        () => document.querySelectorAll('.content .mermaid > svg').length === 3,
        { timeout: 20000 });
      await new Promise((r) => setTimeout(r, 600));

      const flow = await mermPage.evaluate(() => {
        const content = document.querySelector('.content');
        const rows = [];
        document.querySelectorAll('.content .mermaid').forEach((host) => {
          const svg = host.querySelector(':scope > svg');
          if (!svg) return;
          const natural = parseFloat((svg.getAttribute('viewBox') || '').split(/[\s,]+/)[2]);
          const rect = svg.getBoundingClientRect();
          let minFont = Infinity;
          svg.querySelectorAll('text, tspan, foreignObject *').forEach((node) => {
            let carries = false;
            for (let c = node.firstChild; c; c = c.nextSibling) {
              if (c.nodeType === 3 && c.nodeValue.trim()) { carries = true; break; }
            }
            if (!carries) return;
            const size = parseFloat(getComputedStyle(node).fontSize);
            if (isFinite(size) && size > 0 && size < minFont) minFont = size;
          });
          rows.push({
            natural: +natural.toFixed(1),
            rendered: Math.round(rect.width),
            minFont,
            widthAttr: svg.getAttribute('width'),
            effective: +(minFont * (rect.width / natural)).toFixed(2),
            fittedLabel: +(minFont * Math.min(1, content.clientWidth / natural)).toFixed(2),
            scrolls: host.scrollWidth > host.clientWidth,
            overflowX: getComputedStyle(host).overflowX,
          });
        });
        rows.sort((a, b) => a.natural - b.natural);
        return { contentW: Math.round(content.clientWidth), rows };
      });

      assert.strictEqual(flow.rows.length, 3, 'three flowcharts render: ' + JSON.stringify(flow));
      const [fNarrow, fMid, fWide] = flow.rows;

      assert.strictEqual(fWide.widthAttr, '100%',
        'precondition: this whole section is about the engine that does NOT state ' +
        'its width in px. If mermaid ever starts doing so, the viewBox fallback ' +
        'stops being exercised and this section stops proving anything. got ' + fWide.widthAttr);
      assert.ok(fWide.fittedLabel < 6,
        'precondition: fitted, the 40-stage flowchart draws ' + fWide.fittedLabel +
        'px labels, which is far below anything the sweep in section 5 called legible');
      assert.strictEqual(fWide.rendered, Math.round(fWide.natural),
        'the floor is a property of the rendered glyph size, not of the diagram ' +
        'engine, so an unreadable flowchart gets exactly what an unreadable ' +
        'waveform gets. got ' + JSON.stringify(fWide));
      assert.ok(fWide.scrolls && fWide.overflowX === 'auto',
        'including a real horizontal scroll extent. got ' + JSON.stringify(fWide));
      assert.ok(fWide.effective >= FLOOR,
        'and its labels must clear the same declared floor of ' + FLOOR + 'px. got ' + fWide.effective);

      assert.ok(fMid.natural > flow.contentW,
        'precondition: the mid flowchart has to be one that shrink-to-fit really ' +
        'shrinks, or "it stayed fitted" says nothing. got ' + JSON.stringify(fMid));
      assert.strictEqual(fMid.rendered, flow.contentW,
        'a flowchart that is merely wide, not illegible, keeps fitting. got ' + JSON.stringify(fMid));
      assert.ok(!fMid.scrolls && fMid.overflowX === 'visible',
        'so it must not become a scroll box. got ' + JSON.stringify(fMid));
      assert.ok(fNarrow.rendered === Math.round(fNarrow.natural) && !fNarrow.scrolls,
        'and one narrower than the column is untouched. got ' + JSON.stringify(fNarrow));

      // Print, separately from section 5's -- and NOT for symmetry either.
      // Section 5's print row passed while a real PDF built from the same
      // renderer came out with a 16-stage flowchart cut off after Stage 3:
      // mermaid writes style="max-width: <natural>px" onto the svg itself, and
      // an inline declaration beats a stylesheet rule whatever its
      // specificity, so the print block's plain max-width clamped exactly the
      // engine that did not need clamping and left the one that did.
      await mermPage.emulateMediaType('print');
      await new Promise((r) => setTimeout(r, 200));
      const flowPrint = await mermPage.evaluate(() => {
        const content = document.querySelector('.content');
        const host = document.querySelector('.content .mermaid.diagram-scroll');
        const svg = host && host.querySelector(':scope > svg');
        return {
          contentW: Math.round(content.clientWidth),
          found: !!svg,
          inlineMaxWidth: svg ? svg.style.maxWidth : null,
          inlineWidth: svg ? svg.style.width : null,
          rendered: svg ? Math.round(svg.getBoundingClientRect().width) : null,
        };
      });
      assert.ok(flowPrint.found,
        'precondition: the print check needs the flowchart to still be carrying ' +
        'the class, or it proves nothing about the print rules. got ' + JSON.stringify(flowPrint));
      assert.ok(flowPrint.inlineMaxWidth,
        'precondition: this assertion exists because mermaid sets an inline ' +
        'max-width. If it stops doing so the rule below no longer needs to beat ' +
        'anything and this row stops being the thing that caught the clipped PDF. ' +
        'got ' + JSON.stringify(flowPrint));
      assert.ok(flowPrint.rendered <= flowPrint.contentW,
        'in print the flowchart must fit the column, or the PDF is not a small ' +
        'diagram but a cropped one. got ' + JSON.stringify(flowPrint));
      await mermPage.emulateMediaType(null);
    } finally {
      await mermPage.close();
    }

    console.log('md2doc reader-panels test passed');
  } finally {
    await browser.close();
  }
})().catch((err) => { console.error((err && err.stack) || err); process.exit(1); });
