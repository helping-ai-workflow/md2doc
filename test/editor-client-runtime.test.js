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
//   a dismissible banner instead.
// Finding 3: a save() failure outside 200/409 must surface a dismissible
//   banner and must NOT clear the dirty dot (no silent data-loss illusion).
// Finding 4: only one raw-edit editor may be open at a time; opening a
//   second block while one is open is refused, and the open one is not
//   silently discarded.
// Finding 4 regression (post-review round 2): undo()/redo() replace the
//   ENTIRE .content subtree without checking whether some block's editor is
//   still open. That swap detaches the open textarea without ever running
//   its own restore() (the only place `activeEditor` used to get cleared),
//   so `activeEditor` was left pointing at a node no longer in the
//   document — every later attempt to open a block's editor, on ANY block,
//   then hit the "a different editor is open" refusal forever. Silent total lockout,
//   recoverable only by reloading the page.

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
      await page.waitForFunction(
        (s) => !document.querySelector(s + ' textarea.ed-raw'), { timeout: 5000 }, sel
      );

      await page.click('.ed-conflict button[aria-label="Dismiss"]');
      assert.ok(
        await page.evaluate(() => !document.querySelector('.ed-conflict')),
        'FIX 2: the render-failure banner must be dismissible'
      );

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

    // ── Finding 4: only one editor open at a time ─────────────────────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block')).map((el) => el.getAttribute('data-block-id')));
      assert.ok(ids.length >= 2, 'fixture must have at least 2 blocks');
      const selA = '.ed-block[data-block-id="' + ids[0] + '"]';
      const selB = '.ed-block[data-block-id="' + ids[1] + '"]';

      await openBlockEditor(page, selA);
      await page.waitForSelector(selA + ' textarea.ed-raw');
      await page.evaluate((s) => {
        const ta = document.querySelector(s + ' textarea.ed-raw');
        ta.value = 'UNCOMMITTED-A-TEXT';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }, selA);

      // Try to open B's editor while A is still open.
      await openBlockEditor(page, selB);
      await new Promise((r) => setTimeout(r, 200));

      assert.strictEqual(
        await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), selB),
        false,
        'FIX 4: opening a second block editor while one is open must be refused'
      );
      assert.strictEqual(
        await page.evaluate((s) => {
          const ta = document.querySelector(s + ' textarea.ed-raw');
          return ta ? ta.value : null;
        }, selA),
        'UNCOMMITTED-A-TEXT',
        'FIX 4: block A\'s uncommitted text must survive the refused second-open attempt'
      );
      assert.ok(
        await page.evaluate((s) => document.querySelector(s).classList.contains('ed-attn'), selA),
        'FIX 4: the already-open editor should get a visible refusal cue'
      );

      await page.close();
      console.log('fix 4: single-editor-at-a-time policy enforced — OK');
    }

    // ── Finding 4 regression: undo() must resolve an open editor first,
    //    not silently detach it and lock every block's editor forever ─────
    // Exact repro from review: commit an edit on A, open B's editor
    // (leave it UNMODIFIED), blur out of the textarea (so the keydown
    // handler's `inTextarea` gate lets Ctrl+Z through), then Ctrl+Z.
    // Whatever the fix does with B (auto-cancel since it has no unsaved
    // keystrokes, per the chosen policy — or refuse+flash, the other
    // policy branch), the hard requirement either way is: no lockout —
    // block C must still be able to open its editor afterward.
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      assert.ok(ids.length >= 3, 'fixture must have at least 3 paragraph blocks for this repro');
      const selA = '.ed-block[data-block-id="' + ids[0] + '"]';
      const selB = '.ed-block[data-block-id="' + ids[1] + '"]';
      const selC = '.ed-block[data-block-id="' + ids[2] + '"]';

      // commit an edit on A
      await openBlockEditor(page, selA);
      await page.waitForSelector(selA + ' textarea.ed-raw');
      await page.evaluate((s) => {
        const ta = document.querySelector(s + ' textarea.ed-raw');
        ta.value = 'A-COMMITTED-EDIT';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }, selA);
      await page.keyboard.down('Control');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Control');
      await page.waitForFunction(
        () => document.querySelector('.content').innerHTML.includes('A-COMMITTED-EDIT'),
        { timeout: 5000 }
      );

      // open B's editor and leave it untouched, then blur off the textarea
      await openBlockEditor(page, selB);
      await page.waitForSelector(selB + ' textarea.ed-raw');
      await page.click('body'); // focus leaves the textarea -> Ctrl+Z gate passes

      // global Ctrl+Z
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyZ');
      await page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 300)); // let any async render settle

      // Whichever policy branch fired, B must not be left dangling: either
      // it was auto-cancelled (no textarea, block clickable again) or it's still open
      // WITH the refusal flash visible (never neither).
      const bStillOpen = await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), selB);
      if (bStillOpen) {
        assert.ok(
          await page.evaluate((s) => document.querySelector(s).classList.contains('ed-attn'), selB),
          'if undo was refused because B looked modified, B must carry the visible refusal cue'
        );
      }

      // The hard requirement regardless of branch: NO LOCKOUT. Block C
      // must still be able to open its editor.
      await openBlockEditor(page, selC);
      await page.waitForSelector(selC + ' textarea.ed-raw', { timeout: 3000 });
      assert.ok(
        await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), selC),
        'FIX 4-REGRESSION: undo() must not permanently lock out every block\'s editor ' +
        '(activeEditor left dangling on a detached node)'
      );
      await page.keyboard.press('Escape');

      await page.close();
      console.log('fix 4-regression: undo() does not lock out other editors (unmodified B) — OK');
    }

    // ── Same repro, but B HAS unsaved keystrokes: undo must be refused
    //    (not silently discard B's typed text), while still not locking
    //    out block C afterward.
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      const selA = '.ed-block[data-block-id="' + ids[0] + '"]';
      const selB = '.ed-block[data-block-id="' + ids[1] + '"]';
      const selC = '.ed-block[data-block-id="' + ids[2] + '"]';

      await openBlockEditor(page, selA);
      await page.waitForSelector(selA + ' textarea.ed-raw');
      await page.evaluate((s) => {
        const ta = document.querySelector(s + ' textarea.ed-raw');
        ta.value = 'A-COMMITTED-EDIT-2';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }, selA);
      await page.keyboard.down('Control');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Control');
      await page.waitForFunction(
        () => document.querySelector('.content').innerHTML.includes('A-COMMITTED-EDIT-2'),
        { timeout: 5000 }
      );

      // open B and actually type something (unsaved modification)
      await openBlockEditor(page, selB);
      await page.waitForSelector(selB + ' textarea.ed-raw');
      await page.evaluate((s) => {
        const ta = document.querySelector(s + ' textarea.ed-raw');
        ta.value = ta.value + ' UNSAVED-B-KEYSTROKES';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }, selB);
      await page.click('body');

      await page.keyboard.down('Control');
      await page.keyboard.press('KeyZ');
      await page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 300));

      // B's unsaved text must survive — undo must have been refused, not
      // silently discarded B's keystrokes.
      const bTextareaValue = await page.evaluate((s) => {
        const ta = document.querySelector(s + ' textarea.ed-raw');
        return ta ? ta.value : null;
      }, selB);
      assert.ok(
        bTextareaValue && bTextareaValue.includes('UNSAVED-B-KEYSTROKES'),
        'FIX 4-REGRESSION: undo() must not silently discard an open editor\'s unsaved keystrokes'
      );

      // B is still legitimately open (undo refused rather than discarding
      // it) — the pre-existing Finding-4 single-editor policy correctly
      // still refuses to open C's editor while B remains open. This is expected,
      // RECOVERABLE state, not the lockout bug: cancelling B (Esc) must
      // free the editor back up immediately, proving `activeEditor` is
      // still a live, resolvable reference and not a detached node.
      await openBlockEditor(page, selC);
      await new Promise((r) => setTimeout(r, 150));
      assert.strictEqual(
        await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), selC),
        false,
        'C should still be correctly refused while B (unsaved) remains open — this is the existing ' +
        'single-editor policy working as intended, not the lockout bug'
      );

      // Cancel B via its ✕ button — Esc is wired on the textarea itself and
      // focus is currently on `body` (blurred earlier), so the button is
      // the reliable way to close it here.
      await page.click(selB + ' .ed-cancel');
      await page.waitForFunction((s) => !document.querySelector(s + ' textarea.ed-raw'), { timeout: 3000 }, selB);

      // Now that B is closed, the editor slot is free again — the hard
      // "no permanent lockout" requirement: C's editor must open normally.
      await openBlockEditor(page, selC);
      await page.waitForSelector(selC + ' textarea.ed-raw', { timeout: 3000 });
      assert.ok(
        await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), selC),
        'FIX 4-REGRESSION: once B is resolved, block C must be editable again — no permanent lockout'
      );

      await page.close();
      console.log('fix 4-regression: undo() refuses (does not discard) a modified open editor, recoverable — OK');
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
