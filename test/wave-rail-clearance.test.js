#!/usr/bin/env node
'use strict';

// v3.6.0 final fix, M2 — `clearSelectedEdgeOfSide` (lib/editor/wave-ui.js)
// must measure the selected edge's handles as they are actually PAINTED,
// not as `getBoundingClientRect()` reports them.
//
// Why this file exists at all, rather than another row in
// test/editor-journey.test.js: every existing row that selects an edge runs
// `EDGE_FORK_MD`, a 5-cycle document, at 600x400. Five cycles is 120 + 5*48 =
// 360px of drawn content — NARROWER than `.ed-wave-canvas-wrap`'s own clip at
// any viewport this suite uses, so no handle is ever clipped and the whole
// defect class is unreachable from that fixture. The defect needs a document
// wide enough to OVERFLOW the wrap, which is exactly the use case that opened
// v3.6.0 (a wide waveform), so it gets its own fixture and its own file.
//
// The defect: `.ed-wave-canvas-wrap` is `overflow: auto`. A handle scrolled
// out of it still reports a full viewport rect from
// `getBoundingClientRect()` — this repo's own documented trap, written into
// CLAUDE.md during this batch and applied to the test helper `pointInCanvas`
// but not to this production function. Below 1100px
// `.ed-wave-side[data-expanded]` is `position: absolute`, so `flex-basis` does
// not apply and the inline width WINS: a handle painted nowhere collapsed the
// 關聯線 panel from 340px to its 160px floor, rendering the edge-label
// `<input>` at 23px.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const { createEditorServer } = require('../lib/editor/server.js');

const CLIENT_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'editor', 'client.js'), 'utf8');

// `cycleWidth: 48`, `nameColWidth: 120` (wave-ui.js's own SIZES), so N cycles
// draw 120 + N*48 px. 24 cycles = 1272px, comfortably past the wrap's clip at
// a 1000px viewport; the edge's `to` end sits at cycle 20, far outside it.
const WIDE_MD = [
  '# W', '',
  '```wavedrom',
  '{ signal: [',
  "  { name: 'clk', wave: 'p.......................', node: '.a......................' },",
  "  { name: 'req', wave: '0...................1...', node: '....................b...' },",
  '],',
  "edge: ['a~>b']",
  '}',
  '```', '',
  'Tail.', '',
].join('\n');

// 12 cycles = 120 + 576 = 696px: NO overflow, so the `to` handle at cycle 11
// is genuinely painted and genuinely sits under the expanded rail. This is
// the case round 4 wrote the function for, and it must keep working.
const MEDIUM_MD = [
  '# W', '',
  '```wavedrom',
  '{ signal: [',
  "  { name: 'clk', wave: 'p...........', node: '.a..........' },",
  "  { name: 'req', wave: '0..........1', node: '...........b' },",
  '],',
  "edge: ['a~>b']",
  '}',
  '```', '',
  'Tail.', '',
].join('\n');

let browser;

async function boot(mdText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-rail-'));
  const mdPath = path.join(dir, 'doc.md');
  fs.writeFileSync(mdPath, mdText, 'utf8');
  const srv = await createEditorServer({ files: [mdPath], clientJs: CLIENT_SRC });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.setViewport({ width: 1000, height: 900 });
  await page.goto(srv.urlFor(mdPath), { waitUntil: 'load' });
  return { srv, page, errs };
}

async function openWave(page) {
  await page.waitForSelector('.wavedrom-diagram');
  await page.mouse.move(2, 2);
  await new Promise((r) => setTimeout(r, 60));
  const box = await page.$eval('.wavedrom-diagram', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.waitForSelector('.ed-wave-edit-btn:not([hidden])');
  const btn = await page.$eval('.ed-wave-edit-btn', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(btn.x, btn.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForSelector('.ed-wave-overlay');
  await new Promise((r) => setTimeout(r, 300));
}

/**
 * A point that is genuinely ON the drawn edge stroke, taken from the path's
 * own `getPointAtLength` rather than from a bounding-box centre — a `~>`
 * spline's bbox centre is not on the curve, and a press that misses the
 * 10px `.ed-wave-edge-hit` stroke selects nothing while looking exactly like
 * a product failure. `frac` is a fraction of path length from the `from`
 * end, so a small value stays near the left anchor, which is the end that is
 * on screen even when the document overflows.
 *
 * Asserts the resolved point is inside the wrap's own visible rect before
 * returning it: pressing a clipped coordinate lands on whatever is painted
 * there instead, which is the very confusion this whole file is about.
 */
async function edgePathPoint(page, frac) {
  const pt = await page.evaluate((f) => {
    const hit = document.querySelector('.ed-wave-edge-hit');
    if (hit === null) return null;
    const total = hit.getTotalLength();
    const p = hit.getPointAtLength(total * f);
    const svg = hit.ownerSVGElement;
    const m = hit.getScreenCTM();
    const q = svg.createSVGPoint();
    q.x = p.x; q.y = p.y;
    const s = q.matrixTransform(m);
    const wr = document.querySelector('.ed-wave-canvas-wrap').getBoundingClientRect();
    return { x: s.x, y: s.y,
      inWrap: s.x >= wr.left && s.x <= wr.right && s.y >= wr.top && s.y <= wr.bottom };
  }, frac);
  assert.ok(pt !== null, 'edgePathPoint: 畫布上找不到 .ed-wave-edge-hit');
  assert.strictEqual(pt.inWrap, true,
    'edgePathPoint: 取到的點 (' + Math.round(pt.x) + ',' + Math.round(pt.y) +
    ') 落在 .ed-wave-canvas-wrap 的可視範圍之外，按下去會打到別的東西');
  return pt;
}

// Everything the assertions below read, taken in ONE evaluate so the numbers
// all describe the same frame.
async function railMetrics(page) {
  return page.evaluate(() => {
    const side = document.querySelector('.ed-wave-side');
    const wrap = document.querySelector('.ed-wave-canvas-wrap');
    const wr = wrap.getBoundingClientRect();
    const handles = [];
    for (const h of document.querySelectorAll('.ed-wave-edge-handle')) {
      const r = h.getBoundingClientRect();
      handles.push({
        end: h.getAttribute('data-edge-handle'),
        right: r.right,
        // "Painted" in the wrap's own terms: does the handle's box intersect
        // the wrap's clip at all?
        visible: r.right > wr.left && r.left < wr.right &&
                 r.bottom > wr.top && r.top < wr.bottom,
      });
    }
    const label = document.querySelector('.ed-wave-edge-label');
    return {
      inlineWidth: side.style.width,
      renderedWidth: side.getBoundingClientRect().width,
      expanded: side.hasAttribute('data-expanded'),
      wrapRight: wr.right,
      handles: handles,
      labelWidth: label === null ? null : label.getBoundingClientRect().width,
      selectedEdge: document.querySelector('.ed-wave-overlay')
        .getAttribute('data-wave-selected-edge'),
    };
  });
}

(async () => {
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    // ── 1. the defect: a clipped handle must not narrow anything ─────────
    {
      const ctx = await boot(WIDE_MD);
      await openWave(ctx.page);
      await ctx.page.mouse.move(0, 0);
      const at = await edgePathPoint(ctx.page, 0.08);
      await ctx.page.mouse.move(at.x, at.y);
      await ctx.page.mouse.down();
      await ctx.page.mouse.up();
      await new Promise((r) => setTimeout(r, 300));

      const m = await railMetrics(ctx.page);
      assert.strictEqual(m.selectedEdge, '0',
        'M2 前提失敗：按在 edge path 上必須選到 edge 0。Got ' + JSON.stringify(m.selectedEdge));
      assert.strictEqual(m.expanded, true,
        'M2 前提失敗：<1100px 下選取 edge 必須把右欄展開。Got ' + JSON.stringify(m));
      const clipped = m.handles.filter((h) => h.visible === false);
      assert.ok(clipped.length > 0,
        'M2 前提失敗：這個 fixture 必須寬到讓至少一個把手被 wrap 裁掉，' +
        '否則它測不到這個缺陷。Got ' + JSON.stringify(m.handles) +
        '，wrapRight=' + Math.round(m.wrapRight));

      assert.strictEqual(m.inlineWidth, '',
        'M2：被裁掉的把手不可以驅動任何 inline width —— 它根本沒被畫出來。' +
        'Got style.width=' + JSON.stringify(m.inlineWidth) + '，handles=' +
        JSON.stringify(m.handles) + '，wrapRight=' + Math.round(m.wrapRight));
      assert.strictEqual(Math.round(m.renderedWidth), 340,
        'M2：關聯線面板必須維持 340px。Got ' + Math.round(m.renderedWidth) + 'px');
      assert.ok(m.labelWidth !== null && m.labelWidth > 150,
        'M2：edge-label <input> 必須還是可用寬度（缺陷下量到 23px）。Got ' +
        (m.labelWidth === null ? 'null' : Math.round(m.labelWidth) + 'px'));

      assert.strictEqual(ctx.errs.length, 0,
        'M2: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('wave-rail: 被裁掉的把手不會壓縮關聯線面板 — OK');
    }

    // ── 2. round 4's own behaviour, unchanged ───────────────────────────
    // A handle that IS painted, and DOES sit under the expanded rail, must
    // still narrow it. Without this the "fix" for scenario 1 could simply be
    // "never narrow", which would silently retire the function.
    {
      const ctx = await boot(MEDIUM_MD);
      await openWave(ctx.page);
      await ctx.page.mouse.move(0, 0);
      const at = await edgePathPoint(ctx.page, 0.08);
      await ctx.page.mouse.move(at.x, at.y);
      await ctx.page.mouse.down();
      await ctx.page.mouse.up();
      await new Promise((r) => setTimeout(r, 300));

      const m = await railMetrics(ctx.page);
      assert.strictEqual(m.selectedEdge, '0',
        'M2 guard 前提失敗：必須選到 edge 0。Got ' + JSON.stringify(m.selectedEdge));
      assert.strictEqual(m.expanded, true,
        'M2 guard 前提失敗：右欄必須展開。Got ' + JSON.stringify(m));
      assert.deepStrictEqual(m.handles.map((h) => h.visible), m.handles.map(() => true),
        'M2 guard 前提失敗：這個 fixture 的兩個把手都必須是畫得出來的。Got ' +
        JSON.stringify(m.handles) + '，wrapRight=' + Math.round(m.wrapRight));

      assert.ok(m.renderedWidth < 340 && m.renderedWidth >= 160,
        'M2 guard：真的被畫出來、又壓在展開側欄底下的把手，仍然必須讓側欄變窄。' +
        'Got ' + Math.round(m.renderedWidth) + 'px，handles=' + JSON.stringify(m.handles));

      assert.strictEqual(ctx.errs.length, 0,
        'M2 guard: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('wave-rail: 畫得出來的把手仍然讓側欄讓位 — OK');
    }

    console.log('wave-rail-clearance: ALL PASS');
  } finally {
    if (browser) await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
