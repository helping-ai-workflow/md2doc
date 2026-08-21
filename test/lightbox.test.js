#!/usr/bin/env node
'use strict';

// Diagrams and images open in a zoomable, scrollable overlay. The load-bearing
// property is that zooming grows the SCROLL AREA — a CSS transform would scale
// the pixels but leave the scroll extent at the original size, so the enlarged
// edges become unreachable.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const puppeteer = require('puppeteer');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'lib', 'md2doc.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-lightbox-'));
const assetDir = path.join(tmpDir, 'assets');
fs.mkdirSync(assetDir, { recursive: true });

// 400x300 solid PNG — big enough that a fit-to-stage zoom is meaningful.
const png = spawnSync(process.execPath, ['-e', `
  const zlib = require('zlib');
  const W = 400, H = 300;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    const row = y * (W * 3 + 1);
    for (let x = 0; x < W; x++) {
      raw[row + 1 + x * 3] = (x * 255 / W) | 0;
      raw[row + 2 + x * 3] = (y * 255 / H) | 0;
      raw[row + 3 + x * 3] = 128;
    }
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcTable = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
    let crc = 0xffffffff;
    for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  process.stdout.write(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
`], { encoding: 'buffer', maxBuffer: 1 << 24 });
assert.strictEqual(png.status, 0, 'png fixture generated');
fs.writeFileSync(path.join(assetDir, 'wide.png'), png.stdout);

const mdPath = path.join(tmpDir, 'doc.md');
const htmlPath = path.join(tmpDir, 'doc.html');
fs.writeFileSync(mdPath, [
  '# Lightbox',
  '',
  '![wide diagram](assets/wide.png)',
  '',
  '```dot',
  'digraph { rankdir=LR; alpha -> beta -> gamma -> delta; }',
  '```',
  '',
  '[![linked](assets/wide.png)](https://example.com/target)',
  '',
].join('\n'), 'utf8');

const run = spawnSync(process.execPath, [LIB, mdPath, htmlPath], { cwd: REPO, encoding: 'utf8' });
assert.strictEqual(run.status, 0, 'lightbox fixture renders: ' + run.stderr);

const state = `(() => {
  const box = document.querySelector('.lightbox');
  if (!box) return { present: false };
  const stage = box.querySelector('.lightbox-stage');
  const canvas = box.querySelector('.lightbox-canvas');
  return {
    present: true,
    open: !box.hidden,
    canvasWidth: canvas ? canvas.offsetWidth : 0,
    scrollWidth: stage ? stage.scrollWidth : 0,
    clientWidth: stage ? stage.clientWidth : 0,
    scrollLeft: stage ? stage.scrollLeft : 0,
    childTag: canvas && canvas.firstElementChild ? canvas.firstElementChild.tagName.toLowerCase() : null,
    label: box.querySelector('[data-lightbox-zoom-value]') ? box.querySelector('[data-lightbox-zoom-value]').textContent : '',
    pageY: window.scrollY,
  };
})()`;

const ctrlWheel = (deltaY) => `(() => {
  const stage = document.querySelector('.lightbox-stage');
  const rect = stage.getBoundingClientRect();
  stage.dispatchEvent(new WheelEvent('wheel', {
    deltaY: ${deltaY}, ctrlKey: true, bubbles: true, cancelable: true,
    clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
  }));
  return true;
})()`;

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 700 });
    await page.goto('file://' + htmlPath, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 500));

    // Nothing on screen until something is clicked.
    const idle = await page.evaluate(state);
    assert.ok(!idle.present || !idle.open, 'lightbox starts closed');

    // A markdown image opens it, fitted inside the stage.
    await page.click('main.content img');
    await new Promise((r) => setTimeout(r, 200));
    const opened = await page.evaluate(state);
    assert.strictEqual(opened.open, true, 'clicking an image opens the lightbox');
    assert.strictEqual(opened.childTag, 'img', 'the image is cloned into the stage');
    assert.ok(opened.canvasWidth > 0 && opened.canvasWidth <= opened.clientWidth,
      'opens fitted to the stage (' + opened.canvasWidth + ' <= ' + opened.clientWidth + ')');
    assert.match(opened.label, /%/, 'zoom level is shown');
    // A 400px-wide raster stops at actual size — upscaling past 100% is blur.
    assert.strictEqual(opened.canvasWidth, 400, 'a raster image opens at actual size, not upscaled');
    assert.strictEqual(opened.label.trim(), '100%', 'a raster image opens at 100%');

    // Ctrl+wheel zooms IN, and the scroll area grows with it — this is the
    // assertion a transform-based zoom would fail.
    for (let i = 0; i < 6; i++) await page.evaluate(ctrlWheel(-120));
    await new Promise((r) => setTimeout(r, 150));
    const zoomed = await page.evaluate(state);
    assert.ok(zoomed.canvasWidth > opened.canvasWidth, 'ctrl+wheel up enlarges the image');
    assert.ok(zoomed.scrollWidth > zoomed.clientWidth, 'the enlarged image is horizontally scrollable');

    // Horizontal scrolling actually reaches the new area.
    await page.evaluate(() => { document.querySelector('.lightbox-stage').scrollLeft = 99999; });
    const panned = await page.evaluate(state);
    assert.ok(panned.scrollLeft > 0, 'the stage scrolls horizontally (scrollLeft ' + panned.scrollLeft + ')');

    // Ctrl+wheel down zooms back out.
    for (let i = 0; i < 6; i++) await page.evaluate(ctrlWheel(120));
    await new Promise((r) => setTimeout(r, 150));
    const out = await page.evaluate(state);
    assert.ok(out.canvasWidth < zoomed.canvasWidth, 'ctrl+wheel down shrinks the image');

    // Esc closes and hands the page scroll position back untouched.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 200));
    const closed = await page.evaluate(state);
    assert.strictEqual(closed.open, false, 'Escape closes the lightbox');

    // A rendered graphviz diagram opens too, as an SVG.
    await page.click('main.content .graphviz svg');
    await new Promise((r) => setTimeout(r, 200));
    const svgOpen = await page.evaluate(state);
    assert.strictEqual(svgOpen.open, true, 'clicking a graphviz diagram opens the lightbox');
    assert.strictEqual(svgOpen.childTag, 'svg', 'the diagram is cloned as SVG');
    // Vector art fills the window instead: it is the reason to pop it out.
    const svgNatural = await page.evaluate(() => {
      const svg = document.querySelector('main.content .graphviz svg');
      return svg.viewBox.baseVal.width;
    });
    assert.ok(svgOpen.canvasWidth > svgNatural,
      'an SVG smaller than the stage is scaled up to fit (' + svgOpen.canvasWidth + ' > ' + svgNatural + ')');
    assert.ok(svgOpen.canvasWidth <= svgOpen.clientWidth, 'fitted SVG still fits the stage');
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 200));

    // An image wrapped in a link stays a link.
    const navigated = await page.evaluate(() => {
      const link = document.querySelector('main.content a[href="https://example.com/target"]');
      if (!link) return 'no-link';
      let followed = false;
      link.addEventListener('click', (e) => { followed = !e.defaultPrevented; e.preventDefault(); }, { once: true });
      link.querySelector('img').click();
      const box = document.querySelector('.lightbox');
      return { followed, lightboxOpen: box ? !box.hidden : false };
    });
    assert.notStrictEqual(navigated, 'no-link', 'linked image fixture present');
    assert.strictEqual(navigated.lightboxOpen, false, 'a linked image does not open the lightbox');
    assert.strictEqual(navigated.followed, true, 'a linked image still follows its link');

    console.log('md2doc lightbox test passed');
  } finally {
    await browser.close();
  }
})().catch((err) => { console.error((err && err.stack) || err); process.exit(1); });
