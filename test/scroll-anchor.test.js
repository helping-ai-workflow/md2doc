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

// WaveDrom variant: every wavedrom fence leaves a <script type="WaveDrom">
// child in main.content whose rect is all zeros. The gap fallback's binary
// search over the column's children used to read that as "top 0 < line" and
// walk off to the wrong block, so reading position jumped by thousands of px.
const wdPath = path.join(tmpDir, 'wd.md');
const wdHtml = path.join(tmpDir, 'wd.html');
const wdLines = ['# Wave Document', ''];
for (let s = 1; s <= 12; s++) {
  wdLines.push('## Section ' + s, '');
  for (let p = 0; p < 3; p++) {
    wdLines.push(('Paragraph ' + p + ' of section ' + s + '. The quick brown fox jumps over the lazy dog and keeps running. ').repeat(6), '');
  }
  wdLines.push('```wavedrom', '{ signal: [ { name: "clk", wave: "p...." }, { name: "d", wave: "01.0." } ] }', '```', '');
}
fs.writeFileSync(wdPath, wdLines.join('\n'), 'utf8');
const wdRun = spawnSync('node', [LIB, wdPath, wdHtml], { cwd: REPO, encoding: 'utf8' });
assert.strictEqual(wdRun.status, 0, 'wavedrom fixture renders: ' + wdRun.stderr);

// Tags the element sitting at the top of the reading column and reports its
// viewport offset, so the same node can be re-measured after the resize.
// Probing main.content itself measures the container, whose offset moves with
// scrollY by definition, so it can never show a held reading position. v3.8.0's
// larger heading margins (H2 2.2em top) put y=80 inside a margin at this
// fixture's 55% scroll, so in that case probe the block at or just below the line.
const PROBE = `(() => {
  const content = document.querySelector('main.content');
  const rect = content.getBoundingClientRect();
  const el = document.elementFromPoint(rect.left + rect.width / 2, 80);
  let target = el && el.closest('main.content > *') ? el.closest('main.content > *') : el;
  if (target === content) {
    target = Array.from(content.children).find((c) => c.getBoundingClientRect().bottom > 80) || target;
  }
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

    // WaveDrom document: park the reading line in a gap between blocks (the
    // fallback path), well past several wavedrom fences, then resize.
    const wd = await browser.newPage();
    await wd.setViewport({ width: 1400, height: 900 });
    await wd.goto('file://' + wdHtml, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 1500));
    const gapYs = await wd.evaluate(() => {
      const content = document.querySelector('main.content');
      const rect = content.getBoundingClientRect();
      const out = [];
      const scripts = Array.from(content.querySelectorAll(':scope > script[type="WaveDrom"]'));
      const third = scripts[2];
      // The script itself has an all-zero rect; measure its rendered neighbour.
      let nb = third ? third.nextElementSibling : null;
      while (nb && !nb.getClientRects().length) nb = nb.nextElementSibling;
      const minY = nb ? nb.getBoundingClientRect().top + window.scrollY : 0;
      for (let y = 0; y < document.documentElement.scrollHeight; y += 5) {
        window.scrollTo(0, y);
        if (y + 80 > minY && document.elementFromPoint(rect.left + rect.width / 2, 80) === content) out.push(y);
      }
      return { count: scripts.length, ys: out };
    });
    assert.ok(gapYs.count >= 3, 'wavedrom fixture has at least 3 WaveDrom script children, got ' + gapYs.count);
    assert.ok(gapYs.ys.length >= 3, 'found gap positions past the third fence, got ' + gapYs.ys.length);
    for (const y of [gapYs.ys[0], gapYs.ys[Math.floor(gapYs.ys.length / 2)], gapYs.ys[gapYs.ys.length - 1]]) {
      await wd.setViewport({ width: 1400, height: 900 });
      await wd.evaluate((yy) => window.scrollTo(0, yy), y);
      await new Promise((r) => setTimeout(r, 250));
      await wd.evaluate(() => document.querySelectorAll('[data-probe]').forEach((n) => n.removeAttribute('data-probe')));
      const before = await wd.evaluate(PROBE);
      assert.ok(before, 'wavedrom probe found before resize at y=' + y);
      await wd.setViewport({ width: 1100, height: 900 });
      await new Promise((r) => setTimeout(r, 400));
      const after = await wd.evaluate(REMEASURE);
      assert.ok(after, 'wavedrom probe present after resize');
      const px = Math.round(after.top - before.top);
      assert.ok(Math.abs(px) <= 4, 'wavedrom doc keeps the reading position from a gap at y=' + y + ' (drifted ' + px + 'px)');
    }
    await wd.close();

    // Column-width changes WITHOUT a window resize: dragging the sidebar
    // splitter, collapsing the TOC and double-click-resetting the splitter all
    // reflow the reading column while window.innerWidth stays put, so no
    // 'resize' event ever fires. Each must still hold the reading position.
    const col = await browser.newPage();
    await col.setViewport({ width: 1440, height: 900 });
    await col.goto('file://' + htmlPath, { waitUntil: 'load' });
    async function holdAcross(label, act) {
      await col.evaluate(() => window.scrollTo(0, Math.round(document.documentElement.scrollHeight * 0.55)));
      await new Promise((r) => setTimeout(r, 250));
      await col.evaluate(() => document.querySelectorAll('[data-probe]').forEach((n) => n.removeAttribute('data-probe')));
      const w0 = await col.$eval('main.content', (c) => c.clientWidth);
      const h0 = await col.evaluate(() => document.documentElement.scrollHeight);
      const before = await col.evaluate(PROBE);
      assert.ok(before, label + ': probe element found before');
      await act();
      await new Promise((r) => setTimeout(r, 400));
      const w1 = await col.$eval('main.content', (c) => c.clientWidth);
      const h1 = await col.evaluate(() => document.documentElement.scrollHeight);
      // Precondition: a width change that does not change any paragraph's line
      // count reflows nothing and would pass vacuously. Every paragraph in this
      // fixture has the same length, so line counts only step at discrete
      // widths -- require the document height to have actually moved.
      assert.ok(Math.abs(h1 - h0) >= 200, label + ': column reflowed (width ' + w0 + ' -> ' + w1 + ', height ' + h0 + ' -> ' + h1 + ')');
      const after = await col.evaluate(REMEASURE);
      assert.ok(after, label + ': probe element still present');
      const px = Math.round(after.top - before.top);
      assert.ok(Math.abs(px) <= 4, label + ' keeps the reading position (drifted ' + px + 'px, scrollY ' + before.y + ' -> ' + after.y + ')');
    }
    async function splitterCentre() {
      // The splitter runs the full document height, so its geometric centre is
      // usually off-screen: press it at a visible y instead.
      return col.$eval('.sidebar-splitter', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: 400 }; });
    }
    // Many small pointermoves, the way a real drag arrives: a per-step
    // rounding error that re-anchors each frame would accumulate here.
    await holdAcross('splitter drag wider', async () => {
      const s = await splitterCentre();
      await col.mouse.move(s.x, s.y);
      await col.mouse.down();
      await col.mouse.move(s.x + 260, s.y, { steps: 26 });
      await col.mouse.up();
    });
    await holdAcross('splitter drag narrower', async () => {
      const s = await splitterCentre();
      await col.mouse.move(s.x, s.y);
      await col.mouse.down();
      await col.mouse.move(s.x - 200, s.y, { steps: 20 });
      await col.mouse.up();
    });
    await holdAcross('splitter double-click reset', async () => {
      const s = await splitterCentre();
      await col.mouse.click(s.x, s.y, { clickCount: 2 });
    });
    // At 1440 the column only widens from 1060px on collapse, which crosses no
    // line-count step for this fixture; at 1200 it starts narrower and does.
    await col.setViewport({ width: 1200, height: 900 });
    await holdAcross('TOC collapse', async () => {
      await col.click('#toc-collapse-toggle');
    });
    await holdAcross('TOC expand', async () => {
      await col.click('#toc-collapse-toggle');
    });
    await col.evaluate(() => { try { localStorage.clear(); } catch (e) { /* file:// */ } });
    await col.close();

    console.log('md2doc scroll-anchor test passed');
  } finally {
    await browser.close();
  }
})().catch((err) => { console.error((err && err.stack) || err); process.exit(1); });
