#!/usr/bin/env node
'use strict';

// The wave editor's engine canvas (lib/editor/wave-canvas.js), checked in a
// real edit page in Chromium and WebKit: the canvas is drawn by the WaveDrom
// engine itself, so every coordinate the editor hands out has to land on what
// the engine drew. Assertions read DOM geometry (getScreenCTM, computed style)
// and compare plain numbers returned from page.evaluate, never handles.
//
// Run:   npm run test:browser
// One engine:  MD2DOC_ENGINES=webkit node test/wave-canvas.test.js
// A subset:    node test/wave-canvas.test.js "budget"

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const playwright = require('playwright');
const { createEditorServer } = require('../lib/editor/server.js');

const CLIENT_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'client.js'), 'utf8');
const DESKTOP = { width: 1440, height: 900 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The page needs one wavedrom fence of its own: that is what puts the engine,
// its skin and the wave modules on the edit page.
const PAGE_MD = [
  '# Wave canvas', '',
  '\x60\x60\x60wavedrom',
  '{ "signal": [ { "name": "clk", "wave": "p...." } ] }',
  '\x60\x60\x60', '',
].join('\n');

// ── fixtures (WaveJSON as plain objects) ─────────────────────────────────
const FX = {
  plain: {
    signal: [
      { name: 'clk', wave: 'p.....', node: '.a....' },
      { name: 'dat', wave: 'x.34.x', data: ['A', 'B'], node: '..b..c' },
      { name: 'req', wave: '0.1..0', node: '...d.e' },
    ],
    edge: ['a~>b', 'c-|>d t1', 'b-e'],
  },
  head: {
    signal: [
      { name: 'clk', wave: 'p.....', node: '.a....' },
      { name: 'dat', wave: 'x.34.x', data: ['A', 'B'], node: '..b..c' },
    ],
    edge: ['a->b', 'b-c'],
    head: { text: 'Title', tick: 0 },
  },
  periodPhase: {
    signal: [
      { name: 'slow', wave: 'p..', period: 2, node: '.a.' },
      { name: 'ph', wave: '01.0', phase: 0.5, node: '.b.c' },
      { name: 'n', wave: '010101', node: 'd...e.' },
    ],
    edge: ['a-b', 'c-d', 'd-e'],
  },
  noMarks: {
    signal: [
      { name: 'a', wave: '01.0', node: '.a..' },
      { name: 'b', wave: '0.1.', node: '..b.' },
      { name: 'c', wave: '1.0.', node: '...c' },
    ],
    edge: ['a~b', 'b-c'],
    config: { marks: false },
  },
  groups: {
    signal: [
      { name: 'a', wave: '01.0', node: '.a..' },
      {},
      ['grp',
        { name: 'b', wave: '0.1.', node: '..b.' },
        ['sub', { name: 'c', wave: '1.0.', node: '...c' }]],
    ],
    edge: ['a-b', 'b-c'],
  },
};

const LABELS = {
  signal: [
    { name: 'frame', wave: '3.4.....5...6.....',
      data: ['FFFFFFFFFFFF', 'D2 (client FCS last 4B)', 'verdict', 'D7+FCS'] },
    { name: 'tight', wave: '=.=', data: ['D2 (client FCS last 4B)', 'x'] },
    { name: 'three', wave: '333', data: ['a', 'b', 'c'] },
  ],
};

function bigDoc() {
  const signal = [];
  for (let i = 0; i < 15; i++) {
    if (i % 3 === 0) signal.push({ name: 'clk' + i, wave: 'p.................' });
    else if (i % 3 === 1) {
      signal.push({ name: 'bus' + i, wave: 'x3.4.5.6.7.8.9.x..',
        data: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] });
    } else signal.push({ name: 'sig' + i, wave: '01.0.1.0.1.0.1.0.1' });
  }
  signal[0].node = '..a...............';
  signal[2].node = '.......b..........';
  return { signal: signal, edge: ['a~>b setup'] };
}

const servers = [];
async function bootEditor() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-wavecanvas-'));
  const mdPath = path.join(dir, 'doc.md');
  fs.writeFileSync(mdPath, PAGE_MD, 'utf8');
  const srv = await createEditorServer({ files: [mdPath], clientJs: CLIENT_SRC });
  servers.push(srv);
  return { url: srv.urlFor(mdPath), mdPath, srv };
}

// Installs `window.__wc(doc)` in the page: a fresh host + canvas each call.
async function installHarness(page) {
  await page.evaluate(() => {
    window.__wc = function (doc, opts) {
      const old = document.getElementById('wc-host');
      if (old) old.remove();
      if (window.__wcCanvas && window.__wcCanvas.destroy) window.__wcCanvas.destroy();
      const host = document.createElement('div');
      host.id = 'wc-host';
      host.style.cssText = 'position:fixed;left:13px;top:17px;z-index:99999;background:var(--md-bg);padding:3px';
      document.body.appendChild(host);
      const W = window.__md2docWave;
      const canvas = W['wave-canvas.js'].createCanvas(Object.assign({
        d: document, engine: window.WaveDrom, theme: window.md2docTheme,
        geometry: W['wave-geometry.js'], codec: W['wave-codec.js'], host: host,
      }, opts || {}));
      window.__wcCanvas = canvas;
      const res = canvas.render(doc);
      return { res: res, canvas: canvas };
    };
  });
}

function lum(rgb) {
  const m = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => {
    v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
}

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// ── layout aligns with the engine ────────────────────────────────────────
check('layout aligns with the engine', async (page) => {
  for (const key of Object.keys(FX)) {
    const r = await page.evaluate((doc) => {
      const { res, canvas } = window.__wc(doc);
      if (!res.ok) return { res: res };
      const svg = canvas.svg;
      const codec = window.__md2docWave['wave-codec.js'];
      const nodes = codec.nodesOf(doc);
      const ends = [];
      for (const p of svg.querySelectorAll('[id^="wavearcs_"] path[id^="gmark_"]')) {
        const m = /^gmark_(.)_(.)$/.exec(p.id);
        const len = p.getTotalLength();
        const ctm = p.getScreenCTM();
        for (const [letter, at] of [[m[1], 0], [m[2], len]]) {
          const q = p.getPointAtLength(at);
          const pt = new DOMPoint(q.x, q.y).matrixTransform(ctm);
          const n = nodes[letter];
          const a = canvas.anchorClient(n.at, n.cell);
          ends.push({ letter, engine: { x: pt.x, y: pt.y }, ours: a });
        }
      }
      const lines = [];
      for (const l of svg.querySelectorAll('[id^="gmarks_"] line')) {
        const pt = new DOMPoint(Number(l.getAttribute('x1')), Number(l.getAttribute('y1')))
          .matrixTransform(l.getScreenCTM());
        lines.push(pt.x);
      }
      const cells = [];
      canvas.layout.lanes.forEach((row, li) => {
        const lane = row.lane || {};
        if (lane.phase) return;                       // a phase lane sits between marks
        const p = lane.period || 1;
        for (let c = 0; c < row.cycles; c++) {
          const rc = canvas.cellRectClient(li, c);
          if (rc && c * p < lines.length) cells.push({ li, c, left: rc.left, mark: lines[c * p] });
        }
      });
      return { res, ends, lines: lines.length, cells };
    }, FX[key]);
    assert.deepStrictEqual(r.res, { ok: true }, key + ': render ok');
    assert.ok(r.ends.length >= 4, key + ': edges measured ' + r.ends.length);
    for (const e of r.ends) {
      assert.ok(e.ours, key + ': anchorClient for ' + e.letter);
      const dx = Math.abs(e.ours.x - e.engine.x); const dy = Math.abs(e.ours.y - e.engine.y);
      assert.ok(dx <= 1 && dy <= 1, key + ': anchor ' + e.letter + ' off by dx=' + dx.toFixed(2) +
        ' dy=' + dy.toFixed(2) + ' ours=' + JSON.stringify(e.ours) + ' engine=' + JSON.stringify(e.engine));
    }
    if (key === 'noMarks') {
      assert.strictEqual(r.lines, 0, 'marks:false draws no grid');
    } else {
      assert.ok(r.cells.length >= 6, key + ': grid cells compared ' + r.cells.length);
      for (const c of r.cells) {
        assert.ok(Math.abs(c.left - c.mark) <= 1, key + ': lane ' + c.li + ' cycle ' + c.c +
          ' left ' + c.left.toFixed(2) + ' vs mark ' + c.mark.toFixed(2));
      }
    }
    console.log('     ' + key + ': ' + r.ends.length + ' anchors, max delta ' +
      Math.max(...r.ends.map((e) => Math.max(Math.abs(e.ours.x - e.engine.x), Math.abs(e.ours.y - e.engine.y)))).toFixed(3) +
      'px; ' + r.cells.length + ' grid cells, max delta ' +
      (r.cells.length ? Math.max(...r.cells.map((c) => Math.abs(c.left - c.mark))).toFixed(3) : '-') + 'px');
  }
});

// ── cellAt round-trips ───────────────────────────────────────────────────
check('cellAt round-trips', async (page) => {
  for (const key of Object.keys(FX)) {
    const r = await page.evaluate((doc) => {
      const { res, canvas } = window.__wc(doc);
      const bad = [];
      let n = 0;
      canvas.layout.lanes.forEach((row, li) => {
        for (let c = 0; c < canvas.layout.cycles + 2; c++) {
          const rc = canvas.cellRectClient(li, c);
          if (!rc) continue;
          n++;
          const hit = canvas.cellAt(rc.left + rc.width / 2, rc.top + rc.height / 2);
          if (!hit || hit.laneIndex !== li || hit.cycle !== c) bad.push({ li, c, hit });
          const a = canvas.anchorClient(li, c);
          const b = canvas.boundaryAt(a.x, a.y);
          if (!b || b.laneIndex !== li || b.cell !== c) bad.push({ li, c, boundary: b });
        }
      });
      const r0 = canvas.svg.getBoundingClientRect();
      return { res, n, bad, outside: canvas.cellAt(r0.left - 50, r0.top - 50) };
    }, FX[key]);
    assert.deepStrictEqual(r.res, { ok: true });
    assert.ok(r.n >= 8, key + ': cells ' + r.n);
    assert.deepStrictEqual(r.bad, [], key + ': every cell centre hits itself');
    assert.strictEqual(r.outside, null, key + ': a point outside the svg is no cell');
  }
  // A host that is not in the document cannot be drawn into.
  const detached = await page.evaluate(() => {
    const W = window.__md2docWave;
    const canvas = W['wave-canvas.js'].createCanvas({
      d: document, engine: window.WaveDrom, theme: window.md2docTheme,
      geometry: W['wave-geometry.js'], codec: W['wave-codec.js'],
      host: document.createElement('div'), index: 9001,
    });
    const res = canvas.render({ signal: [{ name: 'a', wave: '01' }] });
    return { ok: res.ok, error: typeof res.error, cell: canvas.cellAt(10, 10) };
  });
  assert.deepStrictEqual(detached, { ok: false, error: 'string', cell: null });
});

// ── dark canvas ──────────────────────────────────────────────────────────
check('dark canvas', async (page) => {
  const read = () => page.evaluate(() => {
    const svg = window.__wcCanvas.svg;
    const name = svg.querySelector('text.info');
    const backing = svg.querySelector('[id^="wavearcs_"] g > rect');
    return {
      dark: window.md2docTheme.isDark(),
      nameFill: getComputedStyle(name).fill,
      backingFill: getComputedStyle(backing).fill,
      backingStyle: backing.getAttribute('style'),
      hostBg: getComputedStyle(document.getElementById('wc-host')).backgroundColor,
    };
  });
  // Drawn light, then the theme flips under it: the canvas follows by itself.
  await page.evaluate((doc) => { window.__wc(doc); }, FX.plain);
  const light = await read();
  assert.strictEqual(light.dark, false);
  assert.ok(lum(light.nameFill) < 0.35, 'light name is dark ink ' + light.nameFill);
  await page.locator('#md2doc-theme-toggle').click(); await wait(300);
  const flipped = await read();
  assert.strictEqual(flipped.dark, true);
  assert.ok(lum(flipped.nameFill) >= 0.35, 'name readable after flip ' + flipped.nameFill);
  assert.strictEqual(flipped.backingFill, flipped.hostBg, 'label backing = canvas background after flip');
  // Drawn while dark.
  await page.evaluate((doc) => { window.__wc(doc); }, FX.plain);
  const dark = await read();
  assert.ok(lum(dark.nameFill) >= 0.35, 'name readable ' + dark.nameFill);
  assert.notStrictEqual(dark.hostBg, 'rgba(0, 0, 0, 0)', 'host has a real background');
  assert.strictEqual(dark.backingFill, dark.hostBg, 'label backing = canvas background');
  // And back to light: the engine's own styling comes back untouched.
  await page.locator('#md2doc-theme-toggle').click(); await wait(300);
  const back = await read();
  assert.strictEqual(back.dark, false);
  assert.strictEqual(back.nameFill, light.nameFill, 'name fill restored');
  assert.strictEqual(back.backingStyle, light.backingStyle, 'backing style restored byte-exact');
});

// ── estimate agrees with engine ──────────────────────────────────────────
check('estimate agrees with engine', async (page) => {
  const r = await page.evaluate((doc) => {
    const { res, canvas } = window.__wc(doc);
    const est = window.__md2docWave['wave-overflow.js'];
    return {
      res,
      scale: canvas.scale,
      boxes: canvas.labelBoxes().map((b) => Object.assign({ estimate: est.estimateTextWidth(b.text) }, b)),
      measured: canvas.measured.labels.map((l) => ({ laneIndex: l.laneIndex, slot: l.slot, text: l.text })),
      ours: canvas.overflow(),
      theirs: est.overflowOf(doc).map((o) => ({ laneIndex: o.laneIndex, slot: o.slot, label: o.label, needScale: o.needScale })),
    };
  }, LABELS);
  assert.deepStrictEqual(r.res, { ok: true });
  assert.strictEqual(r.scale, 1.5);
  // Pairing: each label belongs to the segment it sits in, `333` is three segments.
  assert.deepStrictEqual(r.measured, [
    { laneIndex: 0, slot: 0, text: 'FFFFFFFFFFFF' },
    { laneIndex: 0, slot: 1, text: 'D2 (client FCS last 4B)' },
    { laneIndex: 0, slot: 2, text: 'verdict' },
    { laneIndex: 0, slot: 3, text: 'D7+FCS' },
    { laneIndex: 1, slot: 0, text: 'D2 (client FCS last 4B)' },
    { laneIndex: 1, slot: 1, text: 'x' },
    { laneIndex: 2, slot: 0, text: 'a' },
    { laneIndex: 2, slot: 1, text: 'b' },
    { laneIndex: 2, slot: 2, text: 'c' },
  ]);
  for (const b of r.boxes) {
    const engineUnits = b.width / r.scale;
    console.log('     ' + JSON.stringify(b.text) + ': engine ' + engineUnits.toFixed(2) +
      ' estimate ' + b.estimate.toFixed(2));
    assert.ok(Math.abs(engineUnits - b.estimate) <= 2, JSON.stringify(b.text) + ' engine ' +
      engineUnits.toFixed(2) + ' vs estimate ' + b.estimate.toFixed(2));
    assert.ok(b.height > 0 && b.left > 0 && b.top > 0, 'box placed ' + JSON.stringify(b));
  }
  // The editor's flag and the CLI's list name the same labels.
  assert.deepStrictEqual(r.ours, r.theirs);
  assert.deepStrictEqual(r.ours.map((o) => [o.laneIndex, o.slot]), [[0, 0], [1, 0]]);
});

// ── redraw budget ────────────────────────────────────────────────────────
check('redraw budget', async (page) => {
  await page.locator('#md2doc-theme-toggle').click(); await wait(300);
  const r = await page.evaluate((doc) => {
    const { res, canvas } = window.__wc(doc);
    const times = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      canvas.render(doc);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return {
      res, dark: window.md2docTheme.isDark(),
      recoloured: canvas.svg.hasAttribute('data-md2doc-recoloured'),
      lanes: canvas.layout.lanes.length, cycles: canvas.layout.cycles,
      median: (times[9] + times[10]) / 2, min: times[0], max: times[19],
    };
  }, bigDoc());
  assert.deepStrictEqual(r.res, { ok: true });
  assert.strictEqual(r.dark, true);
  assert.strictEqual(r.recoloured, true, 'dark render recolours');
  assert.strictEqual(r.lanes, 15); assert.strictEqual(r.cycles, 18);
  console.log('     render median ' + r.median.toFixed(2) + 'ms (min ' + r.min.toFixed(2) +
    ', max ' + r.max.toFixed(2) + ')');
  assert.ok(r.median < 16, 'median ' + r.median.toFixed(2) + 'ms over the 16ms budget');
});

(async () => {
  const engines = (process.env.MD2DOC_ENGINES || 'chromium,webkit').split(',').map((s) => s.trim()).filter(Boolean);
  const only = process.argv[2];
  let failed = 0; let ran = 0;
  for (const engine of engines) {
    const browser = await playwright[engine].launch();
    try {
      for (const c of checks) {
        if (only && !c.name.includes(only)) continue;
        ran++;
        const boot = await bootEditor();
        const context = await browser.newContext({ viewport: DESKTOP });
        const page = await context.newPage();
        const errs = [];
        page.on('pageerror', (e) => errs.push(String(e)));
        try {
          await page.goto(boot.url, { waitUntil: 'load' });
          await page.waitForSelector('.ed-toolbar');
          await wait(400);
          await installHarness(page);
          await c.fn(page, boot);
          assert.deepStrictEqual(errs, [], 'page errors');
          console.log('ok   [' + engine + '] ' + c.name);
        } catch (e) {
          failed++;
          console.log('FAIL [' + engine + '] ' + c.name + '\n     ' + (e && e.message));
        } finally {
          await context.close();
          await boot.srv.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
  if (!ran) { console.error('no check matched ' + JSON.stringify(only)); process.exit(1); }
  if (failed) { console.error(failed + ' of ' + ran + ' wave canvas check(s) failed'); process.exit(1); }
  console.log('wave-canvas: ' + ran + ' checks passed');
  process.exit(0);
})();
