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

// Opens a block's raw editor via the click-invoked edit bar (replaces the
// old per-block hover gutter): click the block to select it (shows the
// floating bar anchored above it), then click the bar's ✎ 編輯 button.
async function openBlockEditor(page, sel) {
  await page.click(sel);
  await page.waitForSelector(sel + ' .ed-bar-edit');
  await page.click(sel + ' .ed-bar-edit');
}

(async () => {
  const { srv, url } = await setup();
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

      // ✎ opens the raw textarea editor, hiding the bar while editing; the
      // bar stays gone (block deselected) once the editor is cancelled.
      await page.click(selA);
      await page.waitForSelector(selA + ' .ed-bar-edit');
      await page.click(selA + ' .ed-bar-edit');
      await page.waitForSelector(selA + ' textarea.ed-raw');
      assert.strictEqual(
        await page.evaluate(() => !document.querySelector('.ed-bar')),
        true,
        'the bar must hide once the raw editor opens'
      );
      await page.keyboard.press('Escape');
      await page.waitForFunction((s) => !document.querySelector(s + ' textarea.ed-raw'), {}, selA);
      assert.strictEqual(
        await page.evaluate(() => !document.querySelector('.ed-bar')),
        true,
        'the bar must stay gone (block deselected) after cancelling the raw editor'
      );

      await page.close();
      console.log('click-bar: select / move / dismiss / lightbox-exempt / ✎-opens-editor — OK');
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
