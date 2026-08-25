#!/usr/bin/env node
'use strict';

// Regression coverage for the 4 review findings against lib/editor/client.js
// that pure-function / source-presence assertions (test/editor-client.test.js)
// cannot reach — these are real DOM/network runtime behaviors, so this file
// drives an actual editor server + headless page with Puppeteer (already a
// project dependency; same pattern as test/editor-server.test.js +
// test/scroll-anchor.test.js).
//
// Finding 1: cancel (Esc/✕) or a no-change Ctrl+Enter commit must not leave
//   the block unable to open its editor again (dead click-bar wiring).
// Finding 2: a failed /api/render must not wipe .content, and must surface
//   a dismissible banner instead. A failed COMMIT (whether manually
//   triggered via Ctrl+Enter or auto-triggered by switchAwayFrom()) now
//   leaves the editor OPEN with the user's text intact — see the Phase-2
//   Task-1 click-to-switch scenarios below for why: state consistency over
//   convenience means a switch is refused rather than silently discarding
//   either block's content.
// Finding 3: a save() failure outside 200/409 must surface a dismissible
//   banner and must NOT clear the dirty dot (no silent data-loss illusion).
//
// Phase-2 Task 1 (click-to-switch substrate, replaces the old Finding-4
// "refuse second open" policy and its undo/redo lockout regression):
// clicking a different block's editor open, or clicking outside any block,
// or invoking undo/redo, while some block's raw editor is open with
// modifications now auto-COMMITS that editor (or silently cancels it if
// unmodified) via switchAwayFrom(), instead of refusing outright. See the
// switch-commits / switch-cancels / undo-with-modified-open-editor /
// switch-commit-failure scenarios below.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const puppeteer = require('puppeteer');
const { createEditorServer } = require('../lib/editor/server.js');

const REPO = path.resolve(__dirname, '..');
const CLIENT_SRC = fs.readFileSync(path.join(REPO, 'lib', 'editor', 'client.js'), 'utf8');

// 1x1 transparent PNG (same fixture image as test/images.test.js) — used by
// the click-bar tests below to exercise the "lightbox targets stay excluded
// from the edit bar" rule. Appended as a NEW, trailing paragraph block so it
// never shifts the block indices the other scenarios below rely on.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-editor-rt-'));
  const mdPath = path.join(dir, 'doc.md');
  fs.writeFileSync(path.join(dir, 'block.png'), Buffer.from(PNG_B64, 'base64'));
  const original = [
    '# Heading', '', 'First paragraph.', '', 'Second paragraph.', '', 'Third paragraph.', '',
    // Kept BEFORE the trailing image block so `blockIds[blockIds.length - 1]`
    // (relied on by the click-bar scenario below) still resolves to the
    // image paragraph. Inserting more paragraphs HERE (after this one, still
    // before the image) is safe for both index-based conventions used
    // throughout this file: `ids[0..3]` above stay First/Second/Third/Bold,
    // and the image paragraph stays LAST regardless of how many more
    // paragraphs are added in between.
    'Bold paragraph with **bold** text.', '',
    // Task 4 (selection toolbar) fixtures — each dedicated to one scenario
    // below so none of those scenarios depend on state left by another.
    'Bold toggle target word here.', '',
    'Bold commit target word here.', '',
    'Backtick target has a \\` mark inside.', '',
    'Link target paragraph text.', '',
    'A [existing link](https://example.com) here.', '',
    '![a figure](block.png)', '',
  ].join('\n');
  fs.writeFileSync(mdPath, original, 'utf8');
  const srv = await createEditorServer({ files: [mdPath], clientJs: CLIENT_SRC });
  return { dir, mdPath, srv, url: srv.urlFor(mdPath) };
}

async function newPage(browser) {
  const page = await browser.newPage();
  // beforeunload fires legitimately once a block is dirty; auto-accept so
  // navigations/tests don't hang on a dialog Puppeteer won't dismiss itself.
  page.on('dialog', (d) => d.accept());
  return page;
}

// Opens a block's RAW editor via the click-invoked edit bar (replaces the
// old per-block hover gutter): click the block to select it (shows the
// floating bar anchored above it), then click the bar's ✎ 編輯 button.
//
// Task 3: ✎ now routes WYSIWYG-eligible paragraph/heading blocks (plain text
// like "First paragraph." round-trips through the inline serializer) to the
// in-place WYSIWYG editor instead of the raw textarea. The many pre-existing
// scenarios below (Finding 1-3, switch-*, single-flight, …) are specifically
// exercising RAW-TEXTAREA mechanics (Ctrl+Enter, textarea.value, network
// failure banners) and don't care which route got them there — so when ✎
// lands on WYSIWYG instead, this helper uses the bar's MD escape-hatch
// button to force raw-edit, exactly like a real user would, then proceeds
// exactly as before.
async function openBlockEditor(page, sel) {
  await page.click(sel);
  await page.waitForSelector(sel + ' .ed-bar-edit');
  await page.click(sel + ' .ed-bar-edit');
  await page.waitForFunction(
    (s) => !!document.querySelector(s + ' textarea.ed-raw') || !!document.querySelector(s + ' .ed-bar-md'),
    {}, sel
  );
  const hasRaw = await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), sel);
  if (!hasRaw) {
    await page.click(sel + ' .ed-bar-md');
    await page.waitForSelector(sel + ' textarea.ed-raw');
  }
}

// Task 4 (selection toolbar) helpers: select a specific word (or the whole
// contents) of an element via document.createRange()/getSelection(), then
// manually dispatch selectionchange — same pattern as the brief describes.
// A manual dispatch is used (rather than relying on the native async
// selectionchange Chrome fires after addRange()) so the toolbar's
// show/position logic runs synchronously, deterministically, before the next
// Puppeteer action.
async function selectWordInEl(page, elSelector, word) {
  await page.evaluate((sel, w) => {
    const el = document.querySelector(sel);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = null, idx = -1;
    let cur;
    while ((cur = walker.nextNode())) {
      idx = cur.textContent.indexOf(w);
      if (idx !== -1) { node = cur; break; }
    }
    if (!node) throw new Error('word not found: ' + w);
    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, idx + w.length);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }, elSelector, word);
}

async function selectAllInEl(page, elSelector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const range = document.createRange();
    range.selectNodeContents(el);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }, elSelector);
}

// Opens the WYSIWYG editor on a block via the click-bar (assumes the block
// IS WYSIWYG-eligible — plain-text paragraphs/headings that round-trip
// through the inline serializer, per Task 3's routing).
async function openWysiwyg(page, sel) {
  await page.click(sel);
  await page.waitForSelector(sel + ' .ed-bar-edit');
  await page.click(sel + ' .ed-bar-edit');
  await page.waitForSelector(sel + ' .ed-bar-md');
}

// Locates a paragraph block by a distinctive TEXT PREFIX rather than array
// position — the Task 4 fixture paragraphs below are looked up this way so
// none of these scenarios depend on the exact index position other
// scenarios in this file rely on (ids[0..3] etc.).
async function paragraphSelByText(page, prefix) {
  const id = await page.evaluate((p) => {
    const el = Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
      .find((b) => b.textContent.trim().startsWith(p));
    return el ? el.getAttribute('data-block-id') : null;
  }, prefix);
  assert.ok(id, 'fixture paragraph not found for prefix: ' + prefix);
  return '.ed-block[data-block-id="' + id + '"]';
}

(async () => {
  const { srv, url, mdPath } = await setup();
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    // ── Finding 1: the block must stay click-to-edit-able after cancel AND
    //    no-op commit (the click-bar equivalent of "the gutter must not go
    //    dead") ────────────────────────────────────────────────────────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });
      const blockId = await page.evaluate(() =>
        document.querySelector('.ed-block[data-block-type="paragraph"]').getAttribute('data-block-id'));
      const sel = '.ed-block[data-block-id="' + blockId + '"]';

      // open -> Esc cancel -> block must still be LIVE (clickable, not just present)
      await openBlockEditor(page, sel);
      await page.waitForSelector(sel + ' textarea.ed-raw');
      await page.keyboard.press('Escape');
      await page.waitForFunction((s) => !document.querySelector(s + ' textarea.ed-raw'), {}, sel);
      assert.ok(
        await page.evaluate((s) => !document.querySelector(s + ' .ed-bar') &&
          !document.querySelector(s).classList.contains('ed-selected'), sel),
        'the edit bar must be gone (block deselected) after an Esc cancel'
      );
      await openBlockEditor(page, sel);
      await page.waitForSelector(sel + ' textarea.ed-raw', { timeout: 3000 });
      assert.ok(
        await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), sel),
        'FIX 1: the block must reopen its editor after an Esc cancel (was dead before the fix)'
      );
      await page.keyboard.press('Escape');
      await page.waitForFunction((s) => !document.querySelector(s + ' textarea.ed-raw'), {}, sel);

      // open -> no-change Ctrl+Enter (identical text) -> block must still be LIVE
      await openBlockEditor(page, sel);
      await page.waitForSelector(sel + ' textarea.ed-raw');
      await page.keyboard.down('Control');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Control');
      await page.waitForFunction((s) => !document.querySelector(s + ' textarea.ed-raw'), {}, sel);
      await openBlockEditor(page, sel);
      await page.waitForSelector(sel + ' textarea.ed-raw', { timeout: 3000 });
      assert.ok(
        await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), sel),
        'FIX 1: the block must reopen its editor after a no-change Ctrl+Enter commit (was dead before the fix)'
      );
      await page.keyboard.press('Escape');

      await page.close();
      console.log('fix 1: block edit-bar revives after cancel / no-op commit — OK');
    }

    // ── Finding 2: failed /api/render must not wipe .content ─────────────
    {
      const page = await newPage(browser);
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.method() === 'POST' && req.url().endsWith('/api/render')) {
          req.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
        } else {
          req.continue();
        }
      });
      await page.goto(url, { waitUntil: 'networkidle0' });

      const blockId = await page.evaluate(() =>
        document.querySelector('.ed-block[data-block-type="paragraph"]').getAttribute('data-block-id'));
      const sel = '.ed-block[data-block-id="' + blockId + '"]';

      await openBlockEditor(page, sel);
      await page.waitForSelector(sel + ' textarea.ed-raw');
      await page.evaluate((s) => {
        const ta = document.querySelector(s + ' textarea.ed-raw');
        ta.value = 'CHANGED-BUT-RENDER-WILL-FAIL';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }, sel);
      await page.keyboard.down('Control');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Control');

      await page.waitForSelector('.ed-conflict', { timeout: 5000 });
      const bannerText = await page.evaluate(() => document.querySelector('.ed-conflict').textContent);
      assert.ok(/render failed/i.test(bannerText),
        'FIX 2: banner must explain the render failure, got: ' + bannerText);

      const contentHtml = await page.evaluate(() => document.querySelector('.content').innerHTML);
      assert.ok(!contentHtml.includes('CHANGED-BUT-RENDER-WILL-FAIL'),
        'FIX 2: a failed render must NEVER apply the edit to the DOM (no "undefined" wipe either)');
      assert.ok(!contentHtml.includes('undefined'),
        'FIX 2: a failed render must not stringify `undefined` into innerHTML');
      // Phase-2 Task 1: a failed commit keeps the editor OPEN with the
      // user's text intact (state consistency over convenience) instead of
      // silently discarding it via restore().
      assert.strictEqual(
        await page.evaluate((s) => {
          const ta = document.querySelector(s + ' textarea.ed-raw');
          return ta ? ta.value : null;
        }, sel),
        'CHANGED-BUT-RENDER-WILL-FAIL',
        'FIX 2 (Phase-2): a failed commit must keep the editor open with the unsaved text, not discard it'
      );

      await page.click('.ed-conflict button[aria-label="Dismiss"]');
      assert.ok(
        await page.evaluate(() => !document.querySelector('.ed-conflict')),
        'FIX 2: the render-failure banner must be dismissible'
      );
      // Cleanup: cancel the still-open editor via its ✕ button (Esc is
      // wired on the textarea itself, and focus is currently on the
      // banner's Dismiss button, not the textarea).
      await page.click(sel + ' .ed-cancel');
      await page.waitForFunction((s) => !document.querySelector(s + ' textarea.ed-raw'), {}, sel);

      await page.close();
      console.log('fix 2: render failure leaves DOM untouched + dismissible banner — OK');
    }

    // ── Finding 3: save() failure outside 200/409 must not be silent ─────
    {
      const page = await newPage(browser);
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.method() === 'POST' && req.url().endsWith('/api/save')) {
          req.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'disk full' }) });
        } else {
          req.continue();
        }
      });
      await page.goto(url, { waitUntil: 'networkidle0' });

      const blockId = await page.evaluate(() =>
        document.querySelector('.ed-block[data-block-type="paragraph"]').getAttribute('data-block-id'));
      const sel = '.ed-block[data-block-id="' + blockId + '"]';

      await openBlockEditor(page, sel);
      await page.waitForSelector(sel + ' textarea.ed-raw');
      await page.evaluate((s) => {
        const ta = document.querySelector(s + ' textarea.ed-raw');
        ta.value = 'SAVE-TEST-EDIT';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }, sel);
      await page.keyboard.down('Control');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Control');
      await page.waitForFunction(
        () => document.querySelector('.content').innerHTML.includes('SAVE-TEST-EDIT'),
        { timeout: 5000 }
      );
      const dirtyBeforeSave = await page.title();
      assert.ok(dirtyBeforeSave.startsWith('●'), 'sanity: title is dirty after a successful commit');

      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');

      await page.waitForSelector('.ed-conflict', { timeout: 5000 });
      const bannerText = await page.evaluate(() => document.querySelector('.ed-conflict').textContent);
      assert.ok(/save failed/i.test(bannerText),
        'FIX 3: banner must explain the save failure, got: ' + bannerText);
      assert.ok(/not saved/i.test(bannerText),
        'FIX 3: banner must make clear changes were NOT saved, got: ' + bannerText);

      const titleAfterFailedSave = await page.title();
      assert.ok(titleAfterFailedSave.startsWith('●'),
        'FIX 3: dirty dot must remain set after a failed save (no false "saved" state)');

      await page.close();
      console.log('fix 3: save failure surfaces a banner and keeps dirty state — OK');
    }

    // ── switch-commits: A open with modifications, click B's block ────────
    // A's new text must be committed (visible in the rendered page), B's
    // editor must open, and a Ctrl+Z after closing B must revert A's
    // just-committed change (it is the newest op on the undo stack).
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      assert.ok(ids.length >= 2, 'fixture must have at least 2 paragraph blocks');
      const selA = '.ed-block[data-block-id="' + ids[0] + '"]';
      const selB = '.ed-block[data-block-id="' + ids[1] + '"]';

      await openBlockEditor(page, selA);
      await page.waitForSelector(selA + ' textarea.ed-raw');
      await page.evaluate((s) => {
        const ta = document.querySelector(s + ' textarea.ed-raw');
        ta.value = 'SWITCH-COMMIT-A-TEXT';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }, selA);

      // Click B's block while A is open with modifications: A must
      // auto-commit, then B's editor opens.
      await openBlockEditor(page, selB);
      await page.waitForSelector(selB + ' textarea.ed-raw', { timeout: 5000 });

      assert.ok(
        await page.evaluate(() => document.querySelector('.content').innerHTML.includes('SWITCH-COMMIT-A-TEXT')),
        'switch-commits: A\'s modified text must be committed (visible in rendered content) when switching to B'
      );
      assert.ok(
        await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), selB),
        'switch-commits: B\'s editor must open after the switch'
      );

      // Close B (unmodified) and undo: the newest op is A's just-committed
      // switch-triggered edit, so Ctrl+Z must revert THAT.
      await page.keyboard.press('Escape');
      await page.waitForFunction((s) => !document.querySelector(s + ' textarea.ed-raw'), {}, selB);
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyZ');
      await page.keyboard.up('Control');
      await page.waitForFunction(
        () => !document.querySelector('.content').innerHTML.includes('SWITCH-COMMIT-A-TEXT'),
        { timeout: 5000 }
      );
      assert.ok(
        await page.evaluate(() => document.querySelector('.content').innerHTML.includes('First paragraph.')),
        'switch-commits: Ctrl+Z after closing B must revert A\'s committed switch-triggered edit'
      );

      await page.close();
      console.log('switch-commits: A auto-commits on switch to B, undo reverts A\'s edit — OK');
    }

    // ── switch-cancels: A open UNMODIFIED, click B: A closes silently,
    //    B opens ─────────────────────────────────────────────────────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      const selA = '.ed-block[data-block-id="' + ids[0] + '"]';
      const selB = '.ed-block[data-block-id="' + ids[1] + '"]';

      await openBlockEditor(page, selA);
      await page.waitForSelector(selA + ' textarea.ed-raw');
      // A is left untouched — no modification.

      await openBlockEditor(page, selB);
      await page.waitForSelector(selB + ' textarea.ed-raw', { timeout: 5000 });

      assert.strictEqual(
        await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), selA),
        false,
        'switch-cancels: A\'s unmodified editor must close silently when switching to B'
      );
      assert.ok(
        await page.evaluate(() => document.querySelector('.content').innerHTML.includes('First paragraph.')),
        'switch-cancels: A\'s original content must be restored (no accidental commit)'
      );
      assert.ok(
        await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), selB),
        'switch-cancels: B\'s editor must open'
      );

      await page.keyboard.press('Escape');
      await page.close();
      console.log('switch-cancels: A closes silently (unmodified), B opens — OK');
    }

    // ── undo-with-modified-open-editor: A open with modifications, blur,
    //    Ctrl+Z ──────────────────────────────────────────────────────────
    // A must auto-commit first (the pre-check's switchAwayFrom call), then
    // the undo reverts A's just-committed edit — it is the newest op — and
    // there is no lockout: clicking C afterward must still open an editor.
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      assert.ok(ids.length >= 3, 'fixture must have at least 3 paragraph blocks for this repro');
      const selA = '.ed-block[data-block-id="' + ids[0] + '"]';
      const selC = '.ed-block[data-block-id="' + ids[2] + '"]';

      await openBlockEditor(page, selA);
      await page.waitForSelector(selA + ' textarea.ed-raw');
      await page.evaluate((s) => {
        const ta = document.querySelector(s + ' textarea.ed-raw');
        ta.value = 'UNDO-SWITCH-A-TEXT';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }, selA);
      // Blur out of the textarea via JS (not a real click — a real click
      // would ALSO be a "clicked outside a block" switchAwayFrom() trigger
      // in its own right, racing the in-flight /api/render call against
      // undo()'s own pre-check below). This purely moves focus off the
      // textarea so the global keydown handler's `inTextarea` gate lets
      // Ctrl+Z through to undo().
      await page.evaluate(() => document.activeElement && document.activeElement.blur());

      await page.keyboard.down('Control');
      await page.keyboard.press('KeyZ');
      await page.keyboard.up('Control');

      // undo()'s own switchAwayFrom() pre-check auto-commits A first, THEN
      // the undo proceeds and reverts that just-committed op (it's the
      // newest on the stack) — both must be true by the end.
      await page.waitForFunction(
        () => document.querySelector('.content').innerHTML.includes('First paragraph.') &&
          !document.querySelector('.content').innerHTML.includes('UNDO-SWITCH-A-TEXT'),
        { timeout: 5000 }
      );

      // No lockout: block C must still be able to open its editor.
      await openBlockEditor(page, selC);
      await page.waitForSelector(selC + ' textarea.ed-raw', { timeout: 3000 });
      assert.ok(
        await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), selC),
        'undo-with-modified-open-editor: no lockout — block C must open its editor after the undo'
      );
      await page.keyboard.press('Escape');

      await page.close();
      console.log('undo-with-modified-open-editor: A auto-commits then undo reverts it, no lockout — OK');
    }

    // ── switch-commit-failure: force /api/render 500 while A is modified,
    //    click B ──────────────────────────────────────────────────────────
    // Banner shows, A's editor stays open with its unsaved text, and B does
    // NOT open (state consistency over convenience).
    {
      const page = await newPage(browser);
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.method() === 'POST' && req.url().endsWith('/api/render')) {
          req.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'switch-commit-boom' }) });
        } else {
          req.continue();
        }
      });
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      const selA = '.ed-block[data-block-id="' + ids[0] + '"]';
      const selB = '.ed-block[data-block-id="' + ids[1] + '"]';

      await openBlockEditor(page, selA);
      await page.waitForSelector(selA + ' textarea.ed-raw');
      await page.evaluate((s) => {
        const ta = document.querySelector(s + ' textarea.ed-raw');
        ta.value = 'SWITCH-FAIL-A-TEXT';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }, selA);

      // Click B's block while /api/render is forced to fail — the
      // switch's auto-commit must fail, leaving A open and B unopened.
      await page.click(selB);
      await page.waitForSelector('.ed-conflict', { timeout: 5000 });
      const bannerText = await page.evaluate(() => document.querySelector('.ed-conflict').textContent);
      assert.ok(/render failed/i.test(bannerText),
        'switch-commit-failure: banner must explain the render failure, got: ' + bannerText);

      assert.strictEqual(
        await page.evaluate((s) => {
          const ta = document.querySelector(s + ' textarea.ed-raw');
          return ta ? ta.value : null;
        }, selA),
        'SWITCH-FAIL-A-TEXT',
        'switch-commit-failure: A\'s editor must stay open with its unsaved text when the auto-commit fails'
      );
      assert.strictEqual(
        await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), selB),
        false,
        'switch-commit-failure: B must NOT open when A\'s auto-commit failed'
      );

      await page.click('.ed-conflict button[aria-label="Dismiss"]');
      // Cleanup: cancel A's still-open editor via its ✕ button (same reason
      // as above — focus is on the banner's Dismiss button, not the
      // textarea, so Esc's per-textarea handler wouldn't fire).
      await page.click(selA + ' .ed-cancel');
      await page.waitForFunction((s) => !document.querySelector(s + ' textarea.ed-raw'), {}, selA);

      await page.close();
      console.log('switch-commit-failure: commit failure keeps A open, blocks B from opening — OK');
    }

    // ── single-flight switchAwayFrom(): two independent triggers firing
    //    near-simultaneously (an outside click, immediately followed by
    //    the global Ctrl+Z) must share ONE in-flight commit instead of each
    //    firing their own independent commit() — otherwise two concurrent
    //    /api/render calls can race, with the DOM ending up reflecting
    //    whichever response resolves last while `lines` reflects the
    //    other (silent save/DOM divergence). /api/render is held (not
    //    answered) so the race window is observable via the request count
    //    before either response is allowed to land.
    {
      const page = await newPage(browser);
      const heldRenderRequests = [];
      let renderRequestCount = 0;
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.method() === 'POST' && req.url().endsWith('/api/render')) {
          renderRequestCount++;
          heldRenderRequests.push(req); // held — answered explicitly below
        } else {
          req.continue();
        }
      });
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      const selA = '.ed-block[data-block-id="' + ids[0] + '"]';

      await openBlockEditor(page, selA);
      await page.waitForSelector(selA + ' textarea.ed-raw');
      await page.evaluate((s) => {
        const ta = document.querySelector(s + ' textarea.ed-raw');
        ta.value = 'SINGLE-FLIGHT-A-TEXT';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }, selA);

      // Fire an outside click (dispatched directly via the DOM .click()
      // API, not coordinate-based, so it unambiguously targets <body>) and
      // the global Ctrl+Z back-to-back, with no synchronization between
      // them — both are independent switchAwayFrom() trigger points that
      // see the SAME still-modified activeEditor. Blur first: a synthetic
      // .click() does NOT itself move focus off the still-focused textarea
      // (unlike a real pointer click), and without the blur, Ctrl+Z would
      // be swallowed by the keydown handler's own `inTextarea` gate before
      // ever reaching undo() at all.
      await page.evaluate(() => { document.activeElement && document.activeElement.blur(); document.body.click(); });
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyZ');
      await page.keyboard.up('Control');

      // Give both triggers' synchronous JS a moment to run and reach
      // /api/render. The request is held, not answered, so this window is
      // exactly where a duplicate commit request (if the guard were
      // missing) would show up as a second held request.
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(renderRequestCount, 1,
        'single-flight: exactly one /api/render request for the auto-commit — concurrent ' +
        'switchAwayFrom() triggers must share it, not each fire their own');

      // Release the held commit request; let it resolve for real.
      heldRenderRequests.shift().continue();

      // Once switchAwayFrom() resolves, undo() proceeds with its OWN
      // legitimate, SEQUENCED render request (never concurrent with the
      // commit's) — wait for it to arrive.
      const deadline = Date.now() + 5000;
      while (heldRenderRequests.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.strictEqual(renderRequestCount, 2,
        'single-flight: after the auto-commit resolves, undo() fires its own sequenced render — ' +
        'total 2, never overlapping with the commit\'s');
      heldRenderRequests.shift().continue();

      // Final DOM/state must be consistent: the undo reverted the
      // just-committed edit, not left dangling on whichever response
      // happened to resolve last.
      await page.waitForFunction(
        () => document.querySelector('.content').innerHTML.includes('First paragraph.') &&
          !document.querySelector('.content').innerHTML.includes('SINGLE-FLIGHT-A-TEXT'),
        { timeout: 5000 }
      );

      await page.close();
      console.log('single-flight switchAwayFrom: concurrent triggers share one commit, no request race — OK');
    }

    // ── Click-invoked edit bar: select / move / dismiss / lightbox-exempt /
    //    ✎ opens the raw editor ─────────────────────────────────────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const blockIds = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block')).map((el) => el.getAttribute('data-block-id')));
      assert.ok(blockIds.length >= 5, 'fixture must have heading + 3 paragraphs + a trailing image paragraph');
      const selHeading = '.ed-block[data-block-id="' + blockIds[0] + '"]';
      const selA = '.ed-block[data-block-id="' + blockIds[1] + '"]';
      const selB = '.ed-block[data-block-id="' + blockIds[2] + '"]';
      const selImgBlock = '.ed-block[data-block-id="' + blockIds[blockIds.length - 1] + '"]';

      // Click block A -> bar appears anchored inside it; block gets a solid
      // "selected" outline.
      await page.click(selA);
      await page.waitForSelector(selA + ' .ed-bar');
      assert.ok(
        await page.evaluate((s) => document.querySelector(s).classList.contains('ed-selected'), selA),
        'clicking a block must select it (solid-outline class)'
      );
      assert.ok(
        await page.evaluate((s) => !!document.querySelector(s + ' > .ed-bar'), selA),
        'the edit bar must be anchored as a child of the clicked/selected block'
      );

      // Click a DIFFERENT block -> the bar (there is only ever one) moves
      // there; the previous block is deselected.
      await page.click(selB);
      await page.waitForSelector(selB + ' .ed-bar');
      assert.strictEqual(
        await page.evaluate((s) => document.querySelector(s).classList.contains('ed-selected'), selA),
        false,
        'the previously-selected block must be deselected once the bar moves elsewhere'
      );
      assert.ok(
        await page.evaluate((s) => document.querySelector(s).classList.contains('ed-selected'), selB),
        'the newly-clicked block must be selected'
      );
      assert.strictEqual(
        await page.evaluate((s) => !document.querySelector(s + ' .ed-bar'), selA),
        true,
        'only one bar exists — it must not still be attached to the old block'
      );

      // Click outside any block -> the bar is dismissed entirely.
      await page.evaluate(() => document.body.click());
      await page.waitForFunction(() => !document.querySelector('.ed-bar'));
      assert.strictEqual(
        await page.evaluate((s) => document.querySelector(s).classList.contains('ed-selected'), selB),
        false,
        'clicking outside any block must deselect it'
      );

      // Esc also dismisses the bar (no raw editor open).
      await page.click(selHeading);
      await page.waitForSelector(selHeading + ' .ed-bar');
      await page.keyboard.press('Escape');
      await page.waitForFunction((s) => !document.querySelector(s + ' .ed-bar'), {}, selHeading);
      assert.strictEqual(
        await page.evaluate((s) => document.querySelector(s).classList.contains('ed-selected'), selHeading),
        false,
        'Esc must dismiss the bar / deselect the block'
      );

      // Clicking a lightbox target (an image) must open the lightbox, NOT
      // the edit bar — img/.mermaid/.graphviz/wavedrom stay excluded.
      await page.click(selImgBlock + ' img');
      await page.waitForFunction(() => {
        const lb = document.querySelector('.lightbox');
        return !!lb && !lb.hidden;
      }, { timeout: 3000 });
      assert.strictEqual(
        await page.evaluate(() => !document.querySelector('.ed-bar')),
        true,
        'clicking a lightbox target must NOT show the edit bar'
      );
      assert.strictEqual(
        await page.evaluate((s) => !document.querySelector(s).classList.contains('ed-selected'), selImgBlock),
        true,
        'clicking a lightbox target must NOT select its containing block'
      );
      // Close the lightbox so it doesn't interfere with the assertions below.
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => {
        const lb = document.querySelector('.lightbox');
        return !lb || lb.hidden;
      }, { timeout: 3000 });

      // Task 3: ✎ on a WYSIWYG-eligible paragraph (selA, "First paragraph.")
      // opens the in-place editor — NO textarea, the bar STAYS (with the MD
      // escape hatch replacing ✎), and Esc cancels + deselects (bar gone).
      await page.click(selA);
      await page.waitForSelector(selA + ' .ed-bar-edit');
      await page.click(selA + ' .ed-bar-edit');
      await page.waitForSelector(selA + ' .ed-bar-md');
      assert.strictEqual(
        await page.evaluate((s) => !document.querySelector(s + ' textarea.ed-raw'), selA),
        true,
        'WYSIWYG-eligible ✎ must NOT open the raw textarea'
      );
      assert.strictEqual(
        await page.evaluate((s) => document.querySelector(s + ' > *').getAttribute('contenteditable'), selA),
        'true',
        'the block\'s content element must become contenteditable'
      );
      assert.strictEqual(
        await page.evaluate(() => !document.querySelector('.ed-bar')),
        false,
        'the bar must STAY (with the MD escape hatch) while WYSIWYG editing is active'
      );
      await page.keyboard.press('Escape');
      await page.waitForFunction((s) => !document.querySelector(s).classList.contains('ed-selected'), {}, selA);
      assert.strictEqual(
        await page.evaluate(() => !document.querySelector('.ed-bar')),
        true,
        'the bar must be gone (block deselected) after cancelling the WYSIWYG editor'
      );

      // The raw-editor-hides-the-bar invariant still holds for a block that
      // routes to raw-edit — proven here via the MD escape hatch itself
      // (selHeading is WYSIWYG-eligible too, so ✎ opens WYSIWYG first, then
      // MD forces the switch to raw-edit).
      await page.click(selHeading);
      await page.waitForSelector(selHeading + ' .ed-bar-edit');
      await page.click(selHeading + ' .ed-bar-edit');
      await page.waitForSelector(selHeading + ' .ed-bar-md');
      await page.click(selHeading + ' .ed-bar-md');
      await page.waitForSelector(selHeading + ' textarea.ed-raw');
      assert.strictEqual(
        await page.evaluate(() => !document.querySelector('.ed-bar')),
        true,
        'the bar must hide once the raw editor opens (via the MD escape hatch)'
      );
      await page.keyboard.press('Escape');
      await page.waitForFunction((s) => !document.querySelector(s + ' textarea.ed-raw'), {}, selHeading);
      assert.strictEqual(
        await page.evaluate(() => !document.querySelector('.ed-bar')),
        true,
        'the bar must stay gone (block deselected) after cancelling the raw editor'
      );

      await page.close();
      console.log('click-bar: select / move / dismiss / lightbox-exempt / ✎-opens-editor — OK');
    }

    // ── Task 3 WYSIWYG: click paragraph -> contenteditable, no textarea;
    //    type + Enter commits; file line updated on save ──────────────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      const sel = '.ed-block[data-block-id="' + ids[0] + '"]'; // "First paragraph."
      const editEl = sel + ' > *';

      await page.click(sel);
      await page.waitForSelector(sel + ' .ed-bar-edit');
      await page.click(sel + ' .ed-bar-edit');
      await page.waitForSelector(sel + ' .ed-bar-md');
      assert.strictEqual(
        await page.evaluate((s) => !document.querySelector(s + ' textarea.ed-raw'), sel),
        true,
        'WYSIWYG: clicking a paragraph must show NO textarea'
      );
      assert.strictEqual(
        await page.evaluate((s) => document.querySelector(s).getAttribute('contenteditable'), editEl),
        'true',
        'WYSIWYG: the content element must be contenteditable'
      );

      await page.evaluate((s) => document.querySelector(s).focus(), editEl);
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.type('WYSIWYG-EDITED-TEXT');
      await page.keyboard.press('Enter');

      await page.waitForFunction(
        () => document.querySelector('.content').innerHTML.includes('WYSIWYG-EDITED-TEXT'),
        { timeout: 5000 }
      );
      assert.ok(
        await page.evaluate(() => !document.querySelector('.content').innerHTML.includes('undefined')),
        'commit must not stringify undefined into the DOM'
      );

      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 300));
      const fileText1 = fs.readFileSync(mdPath, 'utf8');
      assert.ok(fileText1.includes('WYSIWYG-EDITED-TEXT'),
        'WYSIWYG: Enter-commit + save must update the file on disk');

      await page.close();
      console.log('wysiwyg: paragraph edit commits via Enter and persists to file — OK');
    }

    // ── Task 3 WYSIWYG: **bold** shows <strong> while editing (no literal
    //    ** visible in the edit root's text); Esc reverts exactly ─────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const boldId = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .find((b) => b.querySelector('strong'));
        return el ? el.getAttribute('data-block-id') : null;
      });
      assert.ok(boldId, 'fixture must have a paragraph with **bold** text');
      const sel = '.ed-block[data-block-id="' + boldId + '"]';
      const editEl = sel + ' > *';
      // Captured BEFORE any editing interaction — the bar itself is a CHILD
      // of `sel` once selected, so comparing `sel`'s innerHTML post-edit
      // would spuriously include/exclude the bar. `editEl` (the <p> tag
      // alone) is what cancel() actually restores.
      const originalHtml = await page.evaluate((s) => document.querySelector(s).innerHTML, editEl);

      await page.click(sel);
      await page.waitForSelector(sel + ' .ed-bar-edit');
      await page.click(sel + ' .ed-bar-edit');
      await page.waitForSelector(sel + ' .ed-bar-md');

      assert.strictEqual(
        await page.evaluate((s) => !!document.querySelector(s + ' strong'), editEl),
        true,
        'WYSIWYG: bold text must render as <strong> while editing'
      );
      assert.strictEqual(
        await page.evaluate((s) => document.querySelector(s).innerText.includes('**'), editEl),
        false,
        'WYSIWYG: no literal ** must be visible in the edit root\'s text'
      );

      await page.keyboard.press('Escape');
      await page.waitForFunction((s) => !document.querySelector(s).classList.contains('ed-selected'), {}, sel);
      assert.strictEqual(
        await page.evaluate((s) => document.querySelector(s).innerHTML, editEl),
        originalHtml,
        'WYSIWYG: Esc must revert to the exact pre-edit HTML'
      );

      await page.close();
      console.log('wysiwyg: bold shows <strong> while editing, Esc reverts exactly — OK');
    }

    // ── Task 3 WYSIWYG: a paragraph containing an image opens the raw-edit
    //    textarea instead (not WYSIWYG-eligible) ───────────────────────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const blockIds = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      const selImg = '.ed-block[data-block-id="' + blockIds[blockIds.length - 1] + '"]';

      // Dispatch the click on the block itself (bubbles to the delegated
      // document listener) rather than a coordinate-based page.click(), which
      // could land ON the <img> — a lightbox target excluded from selection.
      await page.evaluate((s) => {
        document.querySelector(s).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }, selImg);
      await page.waitForSelector(selImg + ' .ed-bar-edit');
      await page.click(selImg + ' .ed-bar-edit');
      await page.waitForSelector(selImg + ' textarea.ed-raw');
      assert.strictEqual(
        await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), selImg),
        true,
        'WYSIWYG: a block containing an image must open the raw-edit textarea instead'
      );

      await page.keyboard.press('Escape');
      await page.close();
      console.log('wysiwyg: image paragraph falls back to raw-edit — OK');
    }

    // ── Task 3: heading block shows ± on the bar; clicking + changes the
    //    '#' count in the source after commit ────────────────────────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const headingId = await page.evaluate(() =>
        document.querySelector('.ed-block[data-block-type="heading"]').getAttribute('data-block-id'));
      const sel = '.ed-block[data-block-id="' + headingId + '"]';

      await page.click(sel);
      await page.waitForSelector(sel + ' .ed-bar');
      assert.strictEqual(
        await page.evaluate((s) => document.querySelector(s + ' .ed-bar-plus').hidden, sel),
        false,
        'heading block: the bar\'s + button must be visible'
      );
      assert.strictEqual(
        await page.evaluate((s) => document.querySelector(s + ' .ed-bar-minus').hidden, sel),
        false,
        'heading block: the bar\'s − button must be visible'
      );
      const nonHeadingId = await page.evaluate(() =>
        document.querySelector('.ed-block[data-block-type="paragraph"]').getAttribute('data-block-id'));
      const selPara = '.ed-block[data-block-id="' + nonHeadingId + '"]';
      await page.click(selPara);
      await page.waitForSelector(selPara + ' .ed-bar');
      assert.strictEqual(
        await page.evaluate((s) => document.querySelector(s + ' .ed-bar-plus').hidden, selPara),
        true,
        'non-heading block: the bar\'s + button must stay hidden'
      );

      await page.click(sel);
      await page.waitForSelector(sel + ' .ed-bar');
      await page.click(sel + ' .ed-bar-plus');
      await page.waitForFunction(
        (s) => { const h = document.querySelector(s + ' > *'); return h && h.tagName === 'H2'; },
        {}, sel
      );
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 300));
      const fileText2 = fs.readFileSync(mdPath, 'utf8');
      assert.ok(/^## Heading/m.test(fileText2),
        'heading ±: clicking + must increase the heading depth in the source (# -> ##)');

      await page.close();
      console.log('wysiwyg: heading ± buttons change depth, persists to file — OK');
    }

    // ── Task 3: Shift+Enter inserts <br> instead of committing; a later
    //    plain Enter commits it and it round-trips to the saved source ────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      const sel = '.ed-block[data-block-id="' + ids[1] + '"]'; // "Second paragraph."
      const editEl = sel + ' > *';

      await page.click(sel);
      await page.waitForSelector(sel + ' .ed-bar-edit');
      await page.click(sel + ' .ed-bar-edit');
      await page.waitForSelector(sel + ' .ed-bar-md');

      await page.evaluate((s) => {
        const el = document.querySelector(s);
        el.focus();
        const r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false);
        const sel2 = window.getSelection();
        sel2.removeAllRanges();
        sel2.addRange(r);
      }, editEl);
      await page.keyboard.down('Shift');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Shift');
      await page.keyboard.type('SECOND-LINE');

      assert.strictEqual(
        await page.evaluate((s) => !!document.querySelector(s + ' br'), editEl),
        true,
        'Shift+Enter must insert a <br> instead of committing'
      );
      assert.strictEqual(
        await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), sel),
        false,
        'Shift+Enter must NOT commit (no textarea, editor still open)'
      );

      await page.keyboard.press('Enter'); // plain Enter now commits
      await page.waitForFunction(
        () => document.querySelector('.content').innerHTML.includes('SECOND-LINE'),
        { timeout: 5000 }
      );
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 300));
      const fileText3 = fs.readFileSync(mdPath, 'utf8');
      assert.ok(fileText3.includes('<br>') && fileText3.includes('SECOND-LINE'),
        'Shift+Enter\'s <br> must round-trip into the saved markdown source');

      await page.close();
      console.log('wysiwyg: Shift+Enter inserts <br>, later Enter commits it — OK');
    }

    // ── Task 3: paste inserts clipboard text as plain text only — no rich
    //    markup (e.g. a real <b>) ever survives into the DOM ──────────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      const sel = '.ed-block[data-block-id="' + ids[2] + '"]'; // "Third paragraph."
      const editEl = sel + ' > *';

      await page.click(sel);
      await page.waitForSelector(sel + ' .ed-bar-edit');
      await page.click(sel + ' .ed-bar-edit');
      await page.waitForSelector(sel + ' .ed-bar-md');

      await page.evaluate((s) => {
        const el = document.querySelector(s);
        el.focus();
        const r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false);
        const sel2 = window.getSelection();
        sel2.removeAllRanges();
        sel2.addRange(r);
        const dt = new DataTransfer();
        dt.setData('text/plain', 'PASTED<b>RICH</b>TEXT');
        dt.setData('text/html', '<b>evil</b>');
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
      }, editEl);

      assert.strictEqual(
        await page.evaluate((s) => !document.querySelector(s + ' b'), editEl),
        true,
        'paste must never introduce a real <b> element — only plain text'
      );
      assert.ok(
        await page.evaluate((s) => document.querySelector(s).textContent.includes('PASTED<b>RICH</b>TEXT'), editEl),
        'paste must insert the clipboard\'s plain-text form verbatim as text'
      );

      await page.keyboard.press('Escape');
      await page.close();
      console.log('wysiwyg: paste inserts plain text only, rich markup discarded — OK');
    }

    // ── Task 3: unsupported content landing mid-session (drag/drop or any
    //    path other than our own plain-text paste handler) must degrade to
    //    raw-edit prefilled with the ORIGINAL source on commit, never
    //    corrupt it — degrade-never-lose ─────────────────────────────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      // ids[0] ("First paragraph.") and ids[1] ("Second paragraph.") were
      // already committed to different text by earlier scenarios in this
      // same run (the editor server persists real edits across page loads,
      // by design) — ids[2] ("Third paragraph.") is the first one none of
      // the prior scenarios ever committed (the paste scenario above used it
      // but only cancelled via Esc), so its on-disk source is still known.
      const sel = '.ed-block[data-block-id="' + ids[2] + '"]'; // "Third paragraph."
      const editEl = sel + ' > *';

      await page.click(sel);
      await page.waitForSelector(sel + ' .ed-bar-edit');
      await page.click(sel + ' .ed-bar-edit');
      await page.waitForSelector(sel + ' .ed-bar-md');

      // Simulate content our own paste handler would never itself produce
      // (a styled <span>) landing directly in the DOM — a real drag-drop
      // takes exactly this kind of uncontrolled path.
      await page.evaluate((s) => {
        document.querySelector(s).innerHTML += '<span style="color:red">unsupported</span>';
      }, editEl);
      await page.evaluate((s) => document.querySelector(s).focus(), editEl);
      await page.keyboard.press('Enter'); // commit

      await page.waitForSelector(sel + ' textarea.ed-raw', { timeout: 5000 });
      assert.strictEqual(
        await page.evaluate((s) => document.querySelector(s + ' textarea.ed-raw').value, sel),
        'Third paragraph.',
        'unsupported commit must open raw-edit prefilled with the ORIGINAL source, not the corrupted DOM'
      );
      await page.waitForSelector('.ed-conflict');
      const bannerText = await page.evaluate(() => document.querySelector('.ed-conflict').textContent);
      assert.ok(bannerText.includes('不支援'), 'unsupported commit must show the fallback banner');

      await page.click('.ed-conflict button[aria-label="Dismiss"]');
      await page.click(sel + ' .ed-cancel');
      await page.close();
      console.log('wysiwyg: unsupported mid-session content degrades to raw-edit with original source — OK');
    }

    // ── Task 3 regression (CRITICAL): openWysiwygEditor()'s keydown/paste
    //    listeners must be removed on cancel() — `editEl` is the block's
    //    PERSISTENT content element (unlike raw-edit's fresh <textarea>,
    //    thrown away with the wrap on every cancel), so re-opening WITHOUT
    //    removing the previous session's listeners stacks N live listener
    //    sets after N open/Esc cycles. A stale set's `cancel()` closure
    //    still fires (on the NEXT session's Esc, or racing its commit),
    //    producing an uncommanded second /api/render that can revert a
    //    just-typed commit out from under the real one, silently, with no
    //    banner. Reproduced live before the fix (reviewer-confirmed): 3x
    //    open/Esc on the same block, then type + Enter -> TWO /api/render
    //    POSTs instead of one, and the typed text vanished from disk.
    {
      const page = await newPage(browser);
      let renderRequestCount = 0;
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.method() === 'POST' && req.url().endsWith('/api/render')) renderRequestCount++;
        req.continue();
      });
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      const sel = '.ed-block[data-block-id="' + ids[3] + '"]'; // "Bold paragraph..." — untouched so far
      const editEl = sel + ' > *';

      for (let i = 0; i < 3; i++) {
        await page.click(sel);
        await page.waitForSelector(sel + ' .ed-bar-edit');
        await page.click(sel + ' .ed-bar-edit');
        await page.waitForSelector(sel + ' .ed-bar-md');
        await page.keyboard.press('Escape');
        await page.waitForFunction((s) => !document.querySelector(s).classList.contains('ed-selected'), {}, sel);
      }

      renderRequestCount = 0; // only the real commit below is under test
      await page.click(sel);
      await page.waitForSelector(sel + ' .ed-bar-edit');
      await page.click(sel + ' .ed-bar-edit');
      await page.waitForSelector(sel + ' .ed-bar-md');
      await page.evaluate((s) => document.querySelector(s).focus(), editEl);
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.type('LISTENER-LEAK-REGRESSION-TEXT');
      await page.keyboard.press('Enter');

      await page.waitForFunction(
        () => document.querySelector('.content').innerHTML.includes('LISTENER-LEAK-REGRESSION-TEXT'),
        { timeout: 5000 }
      );
      // Give any stray duplicate request from a stale listener a moment to
      // land before counting — the bug's second POST fires asynchronously,
      // not synchronously with the first.
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(renderRequestCount, 1,
        'CRITICAL regression: exactly ONE /api/render request for the commit — stale cancel() ' +
        'listeners from earlier open/Esc cycles must not fire a second one');

      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 300));
      const fileTextLeak = fs.readFileSync(mdPath, 'utf8');
      assert.ok(fileTextLeak.includes('LISTENER-LEAK-REGRESSION-TEXT'),
        'CRITICAL regression: the typed text must persist to disk, not be silently reverted ' +
        'by a stale listener\'s duplicate commit');

      await page.close();
      console.log('wysiwyg: listener-leak regression — 3x open/Esc then commit fires exactly one render — OK');
    }

    // ── Task 3 regression (IMPORTANT): the unsupported-degrade path firing
    //    INSIDE switchAwayFrom() (because the user clicked a DIFFERENT
    //    block C while this block A had unsupported content injected) must
    //    ABORT the switch, not let the click handler continue on to
    //    showBarFor(C) — otherwise the bar ends up on C while the
    //    freshly-opened raw editor sits on A, two different blocks visibly
    //    "active" at once.
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      const selA = '.ed-block[data-block-id="' + ids[2] + '"]'; // "Third paragraph." — untouched
      const editElA = selA + ' > *';
      const headingId = await page.evaluate(() =>
        document.querySelector('.ed-block[data-block-type="heading"]').getAttribute('data-block-id'));
      const selC = '.ed-block[data-block-id="' + headingId + '"]';

      await page.click(selA);
      await page.waitForSelector(selA + ' .ed-bar-edit');
      await page.click(selA + ' .ed-bar-edit');
      await page.waitForSelector(selA + ' .ed-bar-md');

      // Inject a real text change (so hasChanges() is true and
      // switchAwayFrom() actually calls commitNow() below, not cancelNow())
      // ALONGSIDE unsupported content our own paste handler would never
      // itself produce — same technique as the degrade-never-lose scenario
      // above, but this time triggered via a switch instead of a direct
      // Enter.
      await page.evaluate((s) => {
        document.querySelector(s).innerHTML += 'EXTRA<span style="color:red">unsupported</span>';
      }, editElA);

      // Click block C while A is modified: switchAwayFrom() must run A's
      // commitNow(), hit the unsupported branch, and — per the fix — return
      // false so THIS click's showBarFor(C) never runs.
      await page.click(selC);

      await page.waitForSelector(selA + ' textarea.ed-raw', { timeout: 5000 });
      assert.strictEqual(
        await page.evaluate((s) => document.querySelector(s + ' textarea.ed-raw').value, selA),
        'Third paragraph.',
        'IMPORTANT regression: A must degrade to raw-edit prefilled with its ORIGINAL source'
      );
      assert.strictEqual(
        await page.evaluate((s) => document.querySelector(s).classList.contains('ed-selected'), selC),
        false,
        'IMPORTANT regression: the aborted switch must NOT select C'
      );
      assert.strictEqual(
        await page.evaluate(() => !!document.querySelector('.ed-bar')),
        false,
        'IMPORTANT regression: the bar must not move to C — A\'s raw editor (which hides the bar) ' +
        'and the (non-existent) selection must agree, not point at two different blocks'
      );

      await page.click('.ed-conflict button[aria-label="Dismiss"]');
      await page.click(selA + ' .ed-cancel');
      await page.close();
      console.log('wysiwyg: unsupported-degrade mid-switch aborts the switch (no bar/editor split) — OK');
    }

    // ── Task 4: floating selection toolbar appears over a non-collapsed
    //    selection inside an active WYSIWYG session; hidden while the
    //    selection is collapsed; hidden once the session ends (Esc) ───────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const sel = await paragraphSelByText(page, 'Bold toggle target');
      const editEl = sel + ' > *';

      assert.strictEqual(
        await page.evaluate(() => !!document.querySelector('.ed-seltb')),
        false,
        'the selection toolbar must not exist before any WYSIWYG session is open'
      );

      await openWysiwyg(page, sel);
      assert.strictEqual(
        await page.evaluate(() => !!document.querySelector('.ed-seltb')),
        false,
        'the toolbar must stay hidden while the selection is still collapsed (caret at end)'
      );

      await selectWordInEl(page, editEl, 'toggle');
      await page.waitForSelector('.ed-seltb');
      assert.strictEqual(
        await page.evaluate(() => document.querySelectorAll('.ed-seltb-btn').length),
        4,
        'the toolbar must show exactly 4 buttons: B / I / <> / link'
      );

      // Positioned ABOVE the selection by default — plenty of room above
      // this paragraph, which isn't near the top of the viewport.
      const rects = await page.evaluate(() => {
        const r = document.querySelector('.ed-seltb').getBoundingClientRect();
        const range = window.getSelection().getRangeAt(0).getBoundingClientRect();
        return { tbTop: r.top, tbBottom: r.bottom, selTop: range.top };
      });
      assert.ok(rects.tbBottom <= rects.selTop + 1,
        'the toolbar must be positioned above the selection when there is room, got: ' + JSON.stringify(rects));
      assert.ok(rects.tbTop >= 0, 'the toolbar must stay clamped within the viewport (top >= 0)');

      // Collapsing the selection hides the toolbar.
      await page.evaluate((s) => {
        const el = document.querySelector(s);
        const r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false);
        const sl = window.getSelection();
        sl.removeAllRanges();
        sl.addRange(r);
        document.dispatchEvent(new Event('selectionchange'));
      }, editEl);
      await page.waitForFunction(() => !document.querySelector('.ed-seltb'), { timeout: 3000 });

      // Re-select, then cancel the session (Esc) — the toolbar must not
      // survive past the session's end.
      await selectWordInEl(page, editEl, 'toggle');
      await page.waitForSelector('.ed-seltb');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.ed-seltb'), { timeout: 3000 });

      await page.close();
      console.log('sel-toolbar: shows on selection, hides on collapse and on session end — OK');
    }

    // ── Task 4: clicking Bold wraps the selection in <strong>; clicking
    //    Bold AGAIN on the (now re-selected) same content unwraps it — the
    //    toggle policy's "whole selection inside one mark of that type ->
    //    unwrap" branch ───────────────────────────────────────────────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const sel = await paragraphSelByText(page, 'Bold toggle target');
      const editEl = sel + ' > *';
      await openWysiwyg(page, sel);
      await selectWordInEl(page, editEl, 'toggle');
      await page.waitForSelector('.ed-seltb');

      await page.click('.ed-seltb-b');
      assert.strictEqual(
        await page.evaluate((s) => {
          const strong = document.querySelector(s + ' strong');
          return strong ? strong.textContent : null;
        }, editEl),
        'toggle',
        'clicking Bold must wrap the selected word in <strong>'
      );

      await page.click('.ed-seltb-b');
      assert.strictEqual(
        await page.evaluate((s) => !document.querySelector(s + ' strong'), editEl),
        true,
        'clicking Bold again on the same (now re-selected) content must unwrap it'
      );
      assert.ok(
        await page.evaluate((s) => document.querySelector(s).textContent.includes('Bold toggle target word here.'), editEl),
        'the text content must be back to plain after the round-trip toggle'
      );

      await page.keyboard.press('Escape'); // discard — never committed
      await page.close();
      console.log('sel-toolbar: Bold toggles ON then OFF on the same selection — OK');
    }

    // ── Task 4: Bold applied once, Enter to commit -> the source line
    //    gains **word**, and the re-rendered page shows <strong> ─────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const sel = await paragraphSelByText(page, 'Bold commit target');
      const editEl = sel + ' > *';
      await openWysiwyg(page, sel);
      await selectWordInEl(page, editEl, 'commit');
      await page.waitForSelector('.ed-seltb');
      await page.click('.ed-seltb-b');
      assert.strictEqual(
        await page.evaluate((s) => {
          const st = document.querySelector(s + ' strong');
          return st ? st.textContent : null;
        }, editEl),
        'commit',
        'Bold must wrap "commit" in <strong> before commit'
      );

      await page.keyboard.press('Enter'); // WYSIWYG commit (Task 3's onKeydown)
      await page.waitForFunction(
        () => document.querySelector('.content').innerHTML.includes('<strong>commit</strong>'),
        { timeout: 5000 }
      );
      assert.strictEqual(
        await page.evaluate(() => !!document.querySelector('.ed-seltb')),
        false,
        'the selection toolbar must be gone after commit'
      );

      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 300));
      const fileTextBold = fs.readFileSync(mdPath, 'utf8');
      assert.ok(/Bold \*\*commit\*\* target word here\./.test(fileTextBold),
        'sel-toolbar Bold commit: the saved source must contain **commit**, got: ' + fileTextBold);

      await page.close();
      console.log('sel-toolbar: Bold + Enter commits **word** to source and <strong> to render — OK');
    }

    // ── Task 4: the code button wraps the WHOLE paragraph (which contains a
    //    literal backtick) in <code>; committing must emit the
    //    double-backtick fence form the serializer uses whenever the
    //    content itself contains a backtick (see inline-md.js's
    //    serializeCode()) ───────────────────────────────────────────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const sel = await paragraphSelByText(page, 'Backtick target');
      const editEl = sel + ' > *';
      await openWysiwyg(page, sel);

      // Fixture sanity: the literal backtick made it into the DOM as plain
      // text (an escaped \` in the source, not a real pre-existing code span).
      assert.ok(
        await page.evaluate((s) => document.querySelector(s).textContent.includes('`'), editEl),
        'fixture sanity: the paragraph must contain a literal backtick character'
      );
      assert.strictEqual(
        await page.evaluate((s) => !document.querySelector(s + ' code'), editEl),
        true,
        'fixture sanity: the backtick must be plain text, not already inside a <code> span'
      );

      await selectAllInEl(page, editEl);
      await page.waitForSelector('.ed-seltb');
      await page.click('.ed-seltb-code');
      assert.strictEqual(
        await page.evaluate((s) => !!document.querySelector(s + ' code'), editEl),
        true,
        'the code button must wrap the selection in <code>'
      );

      await page.keyboard.press('Enter');
      await page.waitForFunction((s) => !!document.querySelector(s + ' code'), {}, sel);
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 300));
      const fileTextCode = fs.readFileSync(mdPath, 'utf8');
      const expectedFence = '`` Backtick target has a ` mark inside. ``';
      assert.ok(fileTextCode.includes(expectedFence),
        'sel-toolbar code: the saved source must use the double-backtick fence form, got: ' + fileTextCode);

      await page.close();
      console.log('sel-toolbar: code button on backtick-containing text emits the double-backtick fence — OK');
    }

    // ── Task 4: the link button prompts for a URL and wraps the selection
    //    in <a href>; Enter commits it to `[text](url)` in the source.
    //    window.prompt is stubbed via evaluateOnNewDocument (installed
    //    before client.js's own script runs) rather than relying on a real
    //    dialog, which is unreliable in some headless configs ────────────
    {
      const page = await newPage(browser);
      await page.evaluateOnNewDocument(() => {
        window.prompt = () => 'https://example.org';
      });
      await page.goto(url, { waitUntil: 'networkidle0' });

      const sel = await paragraphSelByText(page, 'Link target paragraph');
      const editEl = sel + ' > *';
      await openWysiwyg(page, sel);
      await selectWordInEl(page, editEl, 'target');
      await page.waitForSelector('.ed-seltb');
      await page.click('.ed-seltb-link');
      assert.strictEqual(
        await page.evaluate((s) => {
          const a = document.querySelector(s + ' a');
          return a ? a.getAttribute('href') + '|' + a.textContent : null;
        }, editEl),
        'https://example.org|target',
        'the link button must wrap the selection in <a href> using the (stubbed) prompt result'
      );

      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () => document.querySelector('.content').innerHTML.includes('href="https://example.org"'),
        { timeout: 5000 }
      );
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 300));
      const fileTextLink = fs.readFileSync(mdPath, 'utf8');
      assert.ok(fileTextLink.includes('[target](https://example.org)'),
        'sel-toolbar link: the saved source must contain [target](https://example.org), got: ' + fileTextLink);

      await page.close();
      console.log('sel-toolbar: link button wraps selection in <a href>, commits to [text](url) — OK');
    }

    // ── Task 4: the link button on a selection fully inside an EXISTING <a>
    //    edits (new href), then — reselecting the same text and clicking
    //    again with an empty URL — clears (unwraps) it. Matches the brief:
    //    "if the selection is inside an existing link, the button
    //    edits/clears it" ──────────────────────────────────────────────
    {
      const page = await newPage(browser);
      await page.evaluateOnNewDocument(() => {
        window.__promptQueue = ['https://edited.example', ''];
        window.prompt = () => window.__promptQueue.shift();
      });
      await page.goto(url, { waitUntil: 'networkidle0' });

      const sel = await paragraphSelByText(page, 'A existing link');
      const editEl = sel + ' > *';
      await openWysiwyg(page, sel);

      assert.strictEqual(
        await page.evaluate((s) => {
          const a = document.querySelector(s + ' a');
          return a ? a.getAttribute('href') : null;
        }, editEl),
        'https://example.com',
        'fixture sanity: the paragraph must already contain an <a href="https://example.com">'
      );

      await selectWordInEl(page, editEl, 'existing link');
      await page.waitForSelector('.ed-seltb');

      // First click: the whole selection is inside the existing <a> -> the
      // prompt (pre-filled with its href) supplies a NEW url -> EDIT.
      await page.click('.ed-seltb-link');
      assert.strictEqual(
        await page.evaluate((s) => {
          const a = document.querySelector(s + ' a');
          return a ? a.getAttribute('href') : null;
        }, editEl),
        'https://edited.example',
        'the link button on a selection inside an existing link must EDIT its href'
      );

      // Re-select the same text (still inside the now-edited <a>) and click
      // again: an empty prompt result CLEARS (unwraps) the link.
      await selectWordInEl(page, editEl, 'existing link');
      await page.click('.ed-seltb-link');
      assert.strictEqual(
        await page.evaluate((s) => !document.querySelector(s + ' a'), editEl),
        true,
        'the link button with an empty URL must CLEAR (unwrap) the existing link'
      );
      assert.ok(
        await page.evaluate((s) => document.querySelector(s).textContent.includes('existing link'), editEl),
        'the link text itself must survive the clear (unwrap keeps the content)'
      );

      await page.keyboard.press('Escape');
      await page.close();
      console.log('sel-toolbar: link button on an existing link edits then clears it — OK');
    }

    console.log('editor-client-runtime.test.js OK');
  } finally {
    await browser.close();
    srv.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
