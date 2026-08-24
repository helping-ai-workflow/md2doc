#!/usr/bin/env node
'use strict';

// Regression coverage for window.__md2docInitDiagrams's WaveDrom path.
//
// WaveDrom.ProcessAll() (node_modules/wavedrom/lib/process-all.js) has no
// concept of "already processed" and keys its DOM lookups purely off
// id/type attributes it reuses starting at 0 on every call — calling it
// more than once, naively, either duplicates every previously-rendered
// diagram or (worse) silently overwrites one diagram's rendered content
// with another's. lib/md2doc.js's diagramInitHookScript works around this
// by reclaiming ids before each call and tagging every display div with a
// stable `wavedrom-diagram` class so it survives that id reclaim — this
// test exercises both properties directly in a real browser, the same way
// test/lightbox.test.js does for the lightbox itself.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const puppeteer = require('puppeteer');
const { renderMarkdown } = require('../lib/md2doc.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-editmode-wavedrom-'));

(async () => {
  const md = [
    '# W', '',
    '```wavedrom',
    '{ "signal": [{ "name": "clk", "wave": "p......" }] }',
    '```', '',
  ].join('\n');
  const fake = path.join(tmpDir, 'fixture.md'); // path only used for SRC_DIR
  const edit = await renderMarkdown(md, fake, { editMode: true });
  const htmlPath = path.join(tmpDir, 'fixture-edit.html');
  fs.writeFileSync(htmlPath, edit.html, 'utf8');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.goto('file://' + htmlPath, { waitUntil: 'load' });
    // Let the hook's own DOMContentLoaded-triggered call settle.
    await new Promise((r) => setTimeout(r, 500));

    // A DIV display container is a rendered diagram; the (possibly renamed)
    // source <script> node picks up the same id prefixes and must not be
    // counted as a diagram.
    const countDiagramDivs = () => document.querySelectorAll(
      'div[id^="WaveDrom_Display_"], div[id^="md2doc-wavedrom-done-"]'
    ).length;

    const baseline = await page.evaluate(countDiagramDivs);
    assert.strictEqual(baseline, 1, 'exactly one diagram rendered on initial load');

    // (1) Calling the hook repeatedly with nothing new to process must not
    // grow the diagram count — this is the idempotency defect from the
    // first review round (repeat calls used to duplicate every diagram).
    const counts = [];
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.__md2docInitDiagrams(document));
      counts.push(await page.evaluate(countDiagramDivs));
    }
    assert.deepStrictEqual(counts, [1, 1, 1],
      '3x repeat hook calls: WaveDrom display count stays flat at 1, got ' + JSON.stringify(counts));

    // Tag the original diagram's div with a marker attribute so it can be
    // re-found by OBJECT identity later, regardless of what id it ends up
    // carrying — the reclaim step is about to rename WaveDrom_Display_0 to
    // something else, and that freed id string gets reassigned to the NEXT
    // diagram ProcessAll() creates, so tracking "the element that currently
    // has id X" would silently start tracking the wrong element.
    const tagged = await page.evaluate(() => {
      const divs = document.querySelectorAll(
        'div[id^="WaveDrom_Display_"], div[id^="md2doc-wavedrom-done-"]'
      );
      if (divs.length !== 1) return false;
      divs[0].setAttribute('data-md2doc-test-original', '1');
      return true;
    });
    assert.ok(tagged, 'original diagram div identifiable and taggable before reclaim');

    // (2) Inject a brand-new, unprocessed WaveDrom script (simulating a
    // Task-7-style body swap) and re-invoke the hook.
    await page.evaluate(() => {
      const div = document.createElement('div');
      div.className = 'ed-block';
      div.innerHTML = '<script type="WaveDrom">{ "signal": [{ "name": "d", "wave": "0101" }] }</script>';
      document.querySelector('main.content').appendChild(div);
    });
    await page.evaluate(() => window.__md2docInitDiagrams(document));

    const afterNew = await page.evaluate(countDiagramDivs);
    assert.strictEqual(afterNew, 2, 'new diagram rendered alongside the original (count 1 -> 2)');

    const renderedSvgCount = await page.evaluate(() => document.querySelectorAll(
      'div[id^="WaveDrom_Display_"] svg, div[id^="md2doc-wavedrom-done-"] svg'
    ).length);
    assert.strictEqual(renderedSvgCount, 2,
      'both diagrams have their own distinct rendered <svg> (no content overwrite)');

    // The original diagram's id was reclaimed (renamed away from
    // WaveDrom_Display_*) by this second call — confirm that happened, so
    // the next assertions are actually exercising the reclaim-survival
    // behavior and not a no-op. Re-found by the marker attribute, not by
    // id (the freed WaveDrom_Display_0 id string is now owned by the NEW
    // diagram's div).
    const originalDivIdAfter = await page.evaluate(() => {
      const el = document.querySelector('[data-md2doc-test-original="1"]');
      return el ? el.id : null;
    });
    assert.ok(/^md2doc-wavedrom-done-/.test(originalDivIdAfter || ''),
      'original diagram\'s id was reclaimed away from the WaveDrom_Display_ prefix ' +
      '(sanity check that this test is exercising the reclaim path): got ' + originalDivIdAfter);

    // The regression under test: even though its id no longer matches
    // [id^="WaveDrom_Display_"], the original diagram must still be a
    // lightbox click target AND keep its zoom-in cursor affordance — both
    // are keyed off the stable `wavedrom-diagram` class applied at process
    // time (lib/md2doc.js LIGHTBOX_TARGETS and the `.content` CSS rule).
    const originalStillTarget = await page.evaluate(() => {
      const el = document.querySelector('[data-md2doc-test-original="1"]');
      if (!el) return null;
      const LIGHTBOX_TARGETS = 'img, .mermaid, .graphviz, [id^="WaveDrom_Display_"], .wavedrom-diagram';
      const matchesTarget = el.matches(LIGHTBOX_TARGETS);
      const cursor = getComputedStyle(el).cursor;
      return { matchesTarget, cursor, hasClass: el.classList.contains('wavedrom-diagram') };
    });
    assert.ok(originalStillTarget, 'original diagram div still present');
    assert.ok(originalStillTarget.hasClass,
      'original diagram div carries the stable wavedrom-diagram class');
    assert.strictEqual(originalStillTarget.matchesTarget, true,
      'original diagram still matches the lightbox click-target selector after id reclaim');
    assert.strictEqual(originalStillTarget.cursor, 'zoom-in',
      'original diagram keeps its zoom-in cursor affordance after id reclaim, got "' +
      originalStillTarget.cursor + '"');

    // The new diagram (still carrying its fresh WaveDrom_Display_ id, not
    // yet reclaimed) must also be a valid lightbox target.
    const newDivMatches = await page.evaluate(() => {
      const divs = document.querySelectorAll('div[id^="WaveDrom_Display_"]');
      const newDiv = divs.length ? divs[divs.length - 1] : null;
      if (!newDiv) return null;
      const LIGHTBOX_TARGETS = 'img, .mermaid, .graphviz, [id^="WaveDrom_Display_"], .wavedrom-diagram';
      return {
        matchesTarget: newDiv.matches(LIGHTBOX_TARGETS),
        cursor: getComputedStyle(newDiv).cursor,
      };
    });
    assert.ok(newDivMatches, 'new diagram div present');
    assert.strictEqual(newDivMatches.matchesTarget, true, 'new diagram matches the lightbox click-target selector');
    assert.strictEqual(newDivMatches.cursor, 'zoom-in', 'new diagram has the zoom-in cursor affordance');

    // One more repeat call after the new node was processed must stay flat.
    await page.evaluate(() => window.__md2docInitDiagrams(document));
    const stableAfterNew = await page.evaluate(countDiagramDivs);
    assert.strictEqual(stableAfterNew, 2, 'idempotent again after the new diagram was processed');

    console.log('editmode-wavedrom-reinit.test.js OK');
  } finally {
    await browser.close();
  }
})().catch((err) => { console.error((err && err.stack) || err); process.exit(1); });
