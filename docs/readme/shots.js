#!/usr/bin/env node
'use strict';

// Regenerates the README screenshots in docs/images/readme/ from
// docs/readme/demo.md (a made-up document, so no real spec ever shows up).
// Headless Chromium through the repo's Playwright devDependency; nothing opens
// on the desktop.
//
//   node docs/readme/shots.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const playwright = require('playwright');
const { execFileSync } = require('child_process');
const { createEditorServer } = require('../../lib/editor/server.js');

const repo = path.resolve(__dirname, '..', '..');
const demo = path.join(__dirname, 'demo.md');
const outDir = path.join(repo, 'docs', 'images', 'readme');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const DESKTOP = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5 };
const PHONE = { viewport: { width: 390, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

// caret: 'initial' — Playwright hides the caret by injecting a <style>, and the
// edit page counts that DOM change as an edit (the status turns to unsaved).
async function shot(page, name, clip) {
  await page.screenshot({ path: path.join(outDir, name), type: 'jpeg', quality: 82, clip, caret: 'initial' });
  console.log('wrote docs/images/readme/' + name);
}

// Puts a heading's top `offset` px below the top of the window.
async function scrollTo(page, text, offset) {
  await page.evaluate(({ text, offset }) => {
    const h = [...document.querySelectorAll('h2, h3')].find((e) => e.textContent.includes(text));
    window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY - offset);
  }, { text, offset });
  await wait(500);
}

async function setDark(page) {
  await page.click('#md2doc-theme-toggle');
  await wait(1200);
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-shots-'));
  const html = path.join(tmp, 'demo.html');
  const md = fs.readFileSync(demo, 'utf8');
  execFileSync(process.execPath, [path.join(repo, 'bin', 'md2doc.js'), demo, '--out', html, '--quiet']);
  const url = 'file://' + html;

  const browser = await playwright.chromium.launch();
  const open = async (ctxOpts, target) => {
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    await page.goto(target || url);
    await wait(1500);
    return page;
  };

  // Reading view, light: table and block diagram.
  let page = await open(DESKTOP);
  await scrollTo(page, '2. 介面訊號', 24);
  await shot(page, 'reader.jpg');

  // Search: the hits are marked in the text.
  await page.fill('#doc-search-input', 'tx_ready');
  await page.press('#doc-search-input', 'Enter');
  await wait(800);
  await shot(page, 'search.jpg');
  await page.context().close();

  // Dark: timing diagram and state machine.
  page = await open(DESKTOP);
  await setDark(page);
  await scrollTo(page, '5. 時序', 24);
  await shot(page, 'dark.jpg');
  await page.context().close();

  // Lightbox on the block diagram.
  page = await open(DESKTOP);
  await scrollTo(page, '3. 方塊圖', 24);
  await page.click('main.content .graphviz svg');
  await wait(800);
  await shot(page, 'lightbox.jpg', { x: 0, y: 0, width: 1280, height: 380 });
  await page.context().close();

  // Phone: page and drawer.
  page = await open(PHONE);
  await shot(page, 'phone.jpg');
  await page.click('#sidebar-toggle');
  await wait(600);
  await shot(page, 'phone-toc.jpg');
  await page.context().close();

  // Edit mode on a scratch copy, so the screenshots never write to demo.md.
  const editMd = path.join(tmp, 'demo.md');
  fs.writeFileSync(editMd, md);
  const clientJs = fs.readFileSync(path.join(repo, 'lib', 'editor', 'client.js'), 'utf8');
  const srv = await createEditorServer({ files: [editMd], clientJs });
  page = await open(DESKTOP, srv.urlFor(editMd));
  await scrollTo(page, '2. 介面訊號', 70);
  const cell = page.locator('main table tbody tr').nth(2).locator('td').nth(3);
  const box = await cell.boundingBox();
  await page.mouse.click(box.x + box.width - 6, box.y + box.height / 2);
  await wait(400);
  await page.keyboard.down('Shift');
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
  await wait(500);
  await shot(page, 'editor.jpg');

  // Waveform editor.
  await page.keyboard.press('Escape');
  const d = page.locator('.wavedrom-diagram').first();
  await d.scrollIntoViewIfNeeded(); await wait(300);
  const wb = await d.boundingBox();
  await page.mouse.move(wb.x + 10, wb.y + wb.height / 2);
  await page.mouse.move(wb.x + wb.width / 2, wb.y + wb.height / 2, { steps: 5 });
  await wait(300);
  await page.locator('.ed-wave-edit-btn').click();
  await wait(1200);
  await shot(page, 'wave-editor.jpg', { x: 0, y: 0, width: 1280, height: 440 });
  await page.context().close();

  await browser.close();
  await srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
