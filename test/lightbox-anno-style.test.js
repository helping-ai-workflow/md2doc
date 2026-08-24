#!/usr/bin/env node
'use strict';

// Annotation round 2: (1) closing the lightbox leaves the drawings on the
// inline figure (in-memory, gone on reload), (2) right-click copy on a raster
// image includes the drawings because the shown clone is re-baked on every
// committed op (+ a Copy button composites any artwork type), (3) stroke color
// and width are pickable, and restyling a selected shape is undoable.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const puppeteer = require('puppeteer');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'lib', 'md2doc.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-anno2-'));
const assetDir = path.join(tmpDir, 'assets');
fs.mkdirSync(assetDir, { recursive: true });

// 400x300 gradient PNG (same generator as lightbox.test.js).
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
fs.writeFileSync(path.join(assetDir, 'photo.png'), png.stdout);

const mdPath = path.join(tmpDir, 'doc.md');
const htmlPath = path.join(tmpDir, 'doc.html');
fs.writeFileSync(mdPath, [
  '# Anno 2',
  '',
  '![photo](assets/photo.png)',
  '',
  '```dot',
  'digraph { rankdir=LR; alpha -> beta -> gamma; }',
  '```',
  '',
].join('\n'), 'utf8');

const run = spawnSync(process.execPath, [LIB, mdPath, htmlPath], { cwd: REPO, encoding: 'utf8' });
assert.strictEqual(run.status, 0, 'anno2 fixture renders: ' + run.stderr);

async function drag(page, x1, y1, x2, y2) {
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 6 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 100));
}

async function canvasOrigin(page) {
  return page.evaluate(() => {
    const r = document.querySelector('.lightbox-canvas').getBoundingClientRect();
    const vb = document.querySelector('.lightbox-anno').viewBox.baseVal;
    return { x: r.left, y: r.top, scale: r.width / vb.width };
  });
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    await page.goto('file://' + htmlPath, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 500));

    // ── (2) raster right-click copy: the shown clone re-bakes with shapes ──
    await page.click('main.content img');
    await new Promise((r) => setTimeout(r, 200));
    const srcBefore = await page.evaluate(() => document.querySelector('.lightbox-canvas img').src);
    const c = await canvasOrigin(page);
    await page.keyboard.press('r');
    await drag(page, c.x + 40, c.y + 40, c.x + 160, c.y + 120);
    await new Promise((r) => setTimeout(r, 400));
    const bake = await page.evaluate(() => {
      const img = document.querySelector('.lightbox-canvas img');
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const rect = document.querySelector('.lightbox-anno g[data-anno-id] rect');
      const x = Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')) / 2;
      const y = Number(rect.getAttribute('y'));
      const px = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
      return { src: img.src, r: px[0], g: px[1], b: px[2] };
    });
    assert.notStrictEqual(bake.src, srcBefore, 'clone src re-baked after drawing');
    assert.ok(bake.src.startsWith('data:image/png'), 'baked clone is a PNG data URI');
    assert.ok(bake.r > 200 && bake.g < 120, 'baked pixel on the rect edge is stroke-red (' + [bake.r, bake.g, bake.b] + ')');

    // Copy button exists and clicking it does not throw.
    let pageError = null;
    page.on('pageerror', (e) => { pageError = e; });
    assert.ok(await page.$('.lightbox-bar [data-anno-copy]'), 'Copy button present');
    await page.click('.lightbox-bar [data-anno-copy]');
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(pageError, null, 'Copy click raises no page error');

    // ── (3) color + width pickers ───────────────────────────────────────────
    // rect mode is still armed from the first draw (same-key press would disarm).
    await page.click('.lightbox-bar [data-anno-color="#3b82f6"]');
    const c2 = await canvasOrigin(page);
    await drag(page, c2.x + 200, c2.y + 40, c2.x + 300, c2.y + 120);
    let styled = await page.evaluate(() => {
      const gs = document.querySelectorAll('.lightbox-anno g[data-anno-id]');
      const el = gs[gs.length - 1].firstChild;
      return { stroke: el.getAttribute('stroke'), width: el.getAttribute('stroke-width') };
    });
    assert.strictEqual(styled.stroke, '#3b82f6', 'new shape uses the picked color');
    const baseWidth = Number(styled.width);

    await page.click('.lightbox-bar [data-anno-width="1.8"]');
    await page.keyboard.press('e');
    await drag(page, c2.x + 40, c2.y + 160, c2.x + 160, c2.y + 240);
    styled = await page.evaluate(() => {
      const gs = document.querySelectorAll('.lightbox-anno g[data-anno-id]');
      const el = gs[gs.length - 1].firstChild;
      return { width: Number(el.getAttribute('stroke-width')) };
    });
    assert.ok(Math.abs(styled.width - baseWidth * 1.8) < 0.11,
      'new shape uses the picked width (' + styled.width + ' vs ' + baseWidth * 1.8 + ')');

    // Restyle a selected shape, undoably: select blue rect, click green.
    await page.keyboard.press('m');
    const blueCenter = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('.lightbox-anno g[data-anno-id] rect'))
        .find((x) => x.getAttribute('stroke') === '#3b82f6');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.click(blueCenter.x, blueCenter.y);
    await new Promise((r) => setTimeout(r, 100));
    await page.click('.lightbox-bar [data-anno-color="#22c55e"]');
    await new Promise((r) => setTimeout(r, 100));
    let strokes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.lightbox-anno g[data-anno-id] rect')).map((x) => x.getAttribute('stroke')));
    assert.ok(strokes.includes('#22c55e') && !strokes.includes('#3b82f6'),
      'clicking a swatch with a selection restyles that shape');
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 100));
    strokes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.lightbox-anno g[data-anno-id] rect')).map((x) => x.getAttribute('stroke')));
    assert.ok(strokes.includes('#3b82f6'), 'restyle is undoable');

    // ── (1) Esc leaves the drawings on the inline figure ────────────────────
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 100));
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 200));
    let inline = await page.evaluate(() => {
      const wrap = document.querySelector('main.content .anno-inline-wrap');
      if (!wrap) return null;
      const overlay = wrap.querySelector('svg.anno-inline');
      return {
        hasImg: !!wrap.querySelector('img'),
        shapeCount: overlay ? Array.from(overlay.children).filter((el) => el.tagName !== 'defs').length : 0,
        pointerEvents: overlay ? getComputedStyle(overlay).pointerEvents : '',
      };
    });
    assert.ok(inline, 'inline wrapper appears after Esc');
    assert.ok(inline.hasImg, 'wrapper contains the original inline img');
    assert.strictEqual(inline.shapeCount, 3, 'all three shapes drawn on the inline figure');
    assert.strictEqual(inline.pointerEvents, 'none', 'inline overlay does not intercept clicks');

    // The wrapped figure still opens the lightbox; drawing on the dot diagram
    // then closing overlays the inline svg too.
    await page.click('main.content .anno-inline-wrap img');
    await new Promise((r) => setTimeout(r, 200));
    const reopened = await page.evaluate(() => !document.querySelector('.lightbox').hidden);
    assert.strictEqual(reopened, true, 'wrapped inline figure still opens the lightbox');
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 200));

    await page.click('main.content .graphviz svg');
    await new Promise((r) => setTimeout(r, 200));
    await page.keyboard.press('a');
    const c3 = await canvasOrigin(page);
    await drag(page, c3.x + 40, c3.y + 40, c3.x + 160, c3.y + 90);
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 200));
    inline = await page.evaluate(() => {
      const wrap = document.querySelector('main.content .graphviz .anno-inline-wrap');
      return wrap ? wrap.querySelectorAll('svg.anno-inline > line').length : -1;
    });
    assert.strictEqual(inline, 1, 'vector diagram gets its inline overlay too');

    // Clearing in the lightbox clears the inline overlay after Esc.
    await page.click('main.content .graphviz svg');
    await new Promise((r) => setTimeout(r, 200));
    await page.click('.lightbox-bar [data-anno-clear]');
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 200));
    inline = await page.evaluate(() => {
      const wrap = document.querySelector('main.content .graphviz .anno-inline-wrap');
      const overlay = wrap && wrap.querySelector('svg.anno-inline');
      return overlay ? Array.from(overlay.children).filter((el) => el.tagName !== 'defs').length : 0;
    });
    assert.strictEqual(inline, 0, 'cleared annotations leave no inline shapes');

    console.log('md2doc lightbox-anno-style test passed');
  } finally {
    await browser.close();
  }
})().catch((err) => { console.error((err && err.stack) || err); process.exit(1); });
