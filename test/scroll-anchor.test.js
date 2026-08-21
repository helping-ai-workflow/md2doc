#!/usr/bin/env node
'use strict';

// Zoom / window resize: the browser keeps the pixel scroll offset, so a
// reflowed document slides the section the reader was looking at out of view.
// The reader runtime must pin the content that was at the top of the viewport.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const puppeteer = require('puppeteer');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'lib', 'md2doc.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-anchor-'));
const mdPath = path.join(tmpDir, 'long.md');
const htmlPath = path.join(tmpDir, 'long.html');

// Long prose under every heading: the point is that a width change reflows the
// paragraphs, which is exactly what moves the reading position.
const lines = ['# Long Document', ''];
for (let s = 1; s <= 40; s++) {
  lines.push('## Section ' + s, '');
  for (let p = 0; p < 6; p++) {
    lines.push(
      ('Paragraph ' + p + ' of section ' + s + '. ' +
        'The quick brown fox jumps over the lazy dog and keeps running for a while. ').repeat(6),
      ''
    );
  }
}
fs.writeFileSync(mdPath, lines.join('\n'), 'utf8');

const run = spawnSync('node', [LIB, mdPath, htmlPath], { cwd: REPO, encoding: 'utf8' });
assert.strictEqual(run.status, 0, 'long fixture renders: ' + run.stderr);

// Tags the element sitting at the top of the reading column and reports its
// viewport offset, so the same node can be re-measured after the resize.
const PROBE = `(() => {
  const content = document.querySelector('main.content');
  const rect = content.getBoundingClientRect();
  const el = document.elementFromPoint(rect.left + rect.width / 2, 80);
  const target = el && el.closest('main.content > *') ? el.closest('main.content > *') : el;
  if (!target) return null;
  target.setAttribute('data-probe', '1');
  return { top: target.getBoundingClientRect().top, y: window.scrollY };
})()`;

const REMEASURE = `(() => {
  const target = document.querySelector('[data-probe]');
  return target ? { top: target.getBoundingClientRect().top, y: window.scrollY } : null;
})()`;

async function drift(page, from, to) {
  await page.setViewport(from);
  await page.evaluate(() => window.scrollTo(0, Math.round(document.documentElement.scrollHeight * 0.55)));
  await new Promise((r) => setTimeout(r, 250));
  await page.evaluate(() => document.querySelectorAll('[data-probe]').forEach((n) => n.removeAttribute('data-probe')));
  const before = await page.evaluate(PROBE);
  assert.ok(before, 'probe element found before resize');
  await page.setViewport(to);
  await new Promise((r) => setTimeout(r, 400));
  const after = await page.evaluate(REMEASURE);
  assert.ok(after, 'probe element still present after resize');
  return { px: Math.round(after.top - before.top), before, after };
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.goto('file://' + htmlPath, { waitUntil: 'load' });

    // Zoom in: a narrower layout viewport, the same window.
    const zin = await drift(page, { width: 1280, height: 900 }, { width: 1024, height: 720 });
    assert.ok(Math.abs(zin.px) <= 4, 'zoom-in keeps the reading position (drifted ' + zin.px + 'px)');

    // Zoom out: a wider layout viewport.
    const zout = await drift(page, { width: 1024, height: 720 }, { width: 1440, height: 980 });
    assert.ok(Math.abs(zout.px) <= 4, 'zoom-out keeps the reading position (drifted ' + zout.px + 'px)');

    // Height-only change (a mobile browser hiding its toolbar) must NOT move the
    // page — nothing reflowed, so any scroll correction would be a visible jerk.
    await page.setViewport({ width: 1280, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 4000));
    await new Promise((r) => setTimeout(r, 250));
    const yBefore = await page.evaluate(() => window.scrollY);
    await page.setViewport({ width: 1280, height: 740 });
    await new Promise((r) => setTimeout(r, 400));
    const yAfter = await page.evaluate(() => window.scrollY);
    assert.strictEqual(yAfter, yBefore, 'height-only resize leaves the scroll offset alone');

    console.log('md2doc scroll-anchor test passed');
  } finally {
    await browser.close();
  }
})().catch((err) => { console.error((err && err.stack) || err); process.exit(1); });
