#!/usr/bin/env node
'use strict';

// Lightbox annotation layer: f/e/r draw freehand/ellipse/rect in IMAGE
// coordinates (they scale with zoom), m selects/moves/deletes, ctrl+z/y
// undo/redo, Clear wipes all as one undoable op. Shapes survive close/reopen
// of the same image within the page visit, and vanish on reload.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const puppeteer = require('puppeteer');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'lib', 'md2doc.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-anno-'));
const mdPath = path.join(tmpDir, 'doc.md');
const htmlPath = path.join(tmpDir, 'doc.html');
fs.writeFileSync(mdPath, [
  '# Anno',
  '',
  '```dot',
  'digraph { rankdir=LR; alpha -> beta -> gamma -> delta; }',
  '```',
  '',
].join('\n'), 'utf8');

const run = spawnSync(process.execPath, [LIB, mdPath, htmlPath], { cwd: REPO, encoding: 'utf8' });
assert.strictEqual(run.status, 0, 'anno fixture renders: ' + run.stderr);

// Image-coordinate scale: canvasRect.width / naturalW.
const annoState = `(() => {
  const svg = document.querySelector('.lightbox-anno');
  if (!svg) return { present: false };
  const canvas = document.querySelector('.lightbox-canvas');
  const r = canvas.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  const shapes = Array.from(svg.querySelectorAll('g[data-anno-id]')).map((g) => {
    const el = g.querySelector('rect, ellipse, path, line');
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    const cr = el.getBoundingClientRect();
    return { tag: el.tagName.toLowerCase(), attrs, clientWidth: cr.width };
  });
  return {
    present: true,
    scale: r.width / vb.width,
    canvasLeft: r.left,
    canvasTop: r.top,
    shapes,
  };
})()`;

async function drag(page, x1, y1, x2, y2) {
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 6 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 100));
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

    await page.click('main.content .graphviz svg');
    await new Promise((r) => setTimeout(r, 200));

    // Toolbar: four tool buttons + Clear, uniform monochrome glyph style.
    const bar = await page.evaluate(() => ({
      tools: Array.from(document.querySelectorAll('.lightbox-bar [data-anno-tool]'))
        .map((b) => b.getAttribute('data-anno-tool')),
      clear: !!document.querySelector('.lightbox-bar [data-anno-clear]'),
    }));
    assert.deepStrictEqual(bar.tools, ['f', 'e', 'r', 'l', 'a', 'm'], 'tool buttons f/e/r/l/a/m present');
    assert.ok(bar.clear, 'Clear button present');

    const base = await page.evaluate(annoState);
    assert.ok(base.present, 'annotation overlay svg present');

    // r: drag draws a rect stored in image coordinates.
    await page.keyboard.press('r');
    const ox = base.canvasLeft;
    const oy = base.canvasTop;
    await drag(page, ox + 40, oy + 30, ox + 140, oy + 90);
    let s = await page.evaluate(annoState);
    assert.strictEqual(s.shapes.length, 1, 'rect drawn');
    assert.strictEqual(s.shapes[0].tag, 'rect', 'shape is a rect');
    const wAttr = Number(s.shapes[0].attrs.width);
    assert.ok(Math.abs(wAttr - 100 / s.scale) <= 3 / s.scale,
      'rect width stored in image coords (' + wAttr + ' vs ' + (100 / s.scale) + ')');

    // Zoom in: attrs unchanged, rendered size grows (anchored to image content).
    const before = s.shapes[0].clientWidth;
    await page.evaluate(() => {
      const stage = document.querySelector('.lightbox-stage');
      const r = stage.getBoundingClientRect();
      for (let i = 0; i < 4; i++) {
        stage.dispatchEvent(new WheelEvent('wheel', {
          deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true,
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        }));
      }
    });
    await new Promise((r) => setTimeout(r, 150));
    s = await page.evaluate(annoState);
    assert.strictEqual(Number(s.shapes[0].attrs.width), wAttr, 'zoom leaves stored geometry untouched');
    assert.ok(s.shapes[0].clientWidth > before * 1.5, 'rendered annotation scales with zoom');
    await page.evaluate(() => {
      const stage = document.querySelector('.lightbox-stage');
      const r = stage.getBoundingClientRect();
      for (let i = 0; i < 4; i++) {
        stage.dispatchEvent(new WheelEvent('wheel', {
          deltaY: 120, ctrlKey: true, bubbles: true, cancelable: true,
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        }));
      }
    });
    await new Promise((r) => setTimeout(r, 150));

    // f: freehand path. e: ellipse. l: line. a: arrow (line + marker head).
    s = await page.evaluate(annoState);
    await page.keyboard.press('f');
    await drag(page, s.canvasLeft + 160, s.canvasTop + 30, s.canvasLeft + 220, s.canvasTop + 80);
    await page.keyboard.press('e');
    await drag(page, s.canvasLeft + 240, s.canvasTop + 30, s.canvasLeft + 320, s.canvasTop + 90);
    await page.keyboard.press('l');
    await drag(page, s.canvasLeft + 40, s.canvasTop + 120, s.canvasLeft + 140, s.canvasTop + 160);
    await page.keyboard.press('a');
    await drag(page, s.canvasLeft + 160, s.canvasTop + 120, s.canvasLeft + 260, s.canvasTop + 160);
    s = await page.evaluate(annoState);
    assert.deepStrictEqual(s.shapes.map((x) => x.tag).sort(),
      ['ellipse', 'line', 'line', 'path', 'rect'],
      'freehand + ellipse + rect + line + arrow all drawn');
    const arrows = s.shapes.filter((x) => x.tag === 'line' && x.attrs['marker-end']);
    assert.strictEqual(arrows.length, 1, 'exactly one line carries the arrow head marker');

    // m: click the rect, drag it, delete it.
    await page.keyboard.press('m');
    const rectClient = await page.evaluate(() => {
      const el = document.querySelector('.lightbox-anno g[data-anno-id] rect');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const xBefore = await page.evaluate(() => Number(document.querySelector('.lightbox-anno rect:not([data-anno-ui])').getAttribute('x')));
    await drag(page, rectClient.x, rectClient.y, rectClient.x + 30, rectClient.y + 20);
    s = await page.evaluate(annoState);
    const moved = s.shapes.find((x) => x.tag === 'rect');
    assert.ok(Math.abs(Number(moved.attrs.x) - (xBefore + 30 / s.scale)) <= 3 / s.scale,
      'm-drag moves the rect in image coords');

    await page.keyboard.press('Delete');
    await new Promise((r) => setTimeout(r, 100));
    s = await page.evaluate(annoState);
    assert.strictEqual(s.shapes.length, 4, 'Delete removes the selected shape');

    // Undo / redo.
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 100));
    s = await page.evaluate(annoState);
    assert.strictEqual(s.shapes.length, 5, 'ctrl+z restores the deleted shape');
    await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 100));
    s = await page.evaluate(annoState);
    assert.strictEqual(s.shapes.length, 4, 'ctrl+y re-applies the delete');
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 100));

    // Clear all is one undoable op.
    await page.click('.lightbox-bar [data-anno-clear]');
    await new Promise((r) => setTimeout(r, 100));
    s = await page.evaluate(annoState);
    assert.strictEqual(s.shapes.length, 0, 'Clear wipes all shapes');
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 100));
    s = await page.evaluate(annoState);
    assert.strictEqual(s.shapes.length, 5, 'ctrl+z restores everything Clear removed');

    // Close, reopen the same image: shapes survive (in-memory store).
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 200));
    const closed = await page.evaluate(() => !document.querySelector('.lightbox') || document.querySelector('.lightbox').hidden);
    assert.strictEqual(closed, true, 'Escape still closes the lightbox');
    await page.click('main.content .graphviz svg');
    await new Promise((r) => setTimeout(r, 200));
    s = await page.evaluate(annoState);
    assert.strictEqual(s.shapes.length, 5, 'annotations survive close/reopen of the same image');

    // Reload: gone.
    await page.reload({ waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 500));
    await page.click('main.content .graphviz svg');
    await new Promise((r) => setTimeout(r, 200));
    s = await page.evaluate(annoState);
    assert.strictEqual(s.shapes.length, 0, 'annotations do not survive a reload');

    console.log('md2doc lightbox-anno test passed');
  } finally {
    await browser.close();
  }
})().catch((err) => { console.error((err && err.stack) || err); process.exit(1); });
