#!/usr/bin/env node
'use strict';

// Editor click-through checks: the --edit page clicked for real in Chromium and
// WebKit at a desktop (1440x900) and a phone (390x844) viewport. Assertions read
// DOM geometry and computed style, never screenshots. Companion of
// test/reader-click.test.js; same runner shape.
//
// Run:   npm run test:browser
// One engine:  MD2DOC_ENGINES=webkit node test/editor-click.test.js
// A subset:    node test/editor-click.test.js "theme:"

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const playwright = require('playwright');
const { createEditorServer } = require('../lib/editor/server.js');

const CLIENT_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'client.js'), 'utf8');
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const FIXTURE = [
  '# Editor Fixture', '',
  '## 1. Alpha', '',
  'First paragraph with **bold** text and a [link](https://example.com).', '',
  '- one', '  - two', '    - three', '',
  '- [x] done item', '  - [ ] open child', '- [ ] open item', '',
  '| Signal | Width |', '|---|---|', '| `clk_tx` | 1 |', '| `rst_n` | 1 |', '',
  '\x60\x60\x60verilog', 'module a; assign x = 1\'b0; // c', 'endmodule', '\x60\x60\x60', '',
  '\x60\x60\x60mermaid', 'graph LR', '  A[Start] --> B[End]', '\x60\x60\x60', '',
  '## 2. Beta', '', 'Second paragraph.', '',
].join('\n');

const servers = [];
async function bootEditor(mdText, opts, assets) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-edclick-'));
  const mdPath = path.join(dir, 'doc.md');
  fs.writeFileSync(mdPath, mdText === undefined ? FIXTURE : mdText, 'utf8');
  // v3.17.0 T7 (R34): files the document refers to, written next to doc.md
  // before the server starts -- { 'assets/a.png': <base64> }.
  Object.keys(assets || {}).forEach((rel) => {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.from(assets[rel], 'base64'));
  });
  const srv = await createEditorServer(Object.assign({ files: [mdPath], clientJs: CLIENT_SRC }, opts || {}));
  servers.push(srv);
  return { url: srv.urlFor(mdPath), mdPath, srv };
}

function lum(rgb) {
  const m = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => {
    v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
}
function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

const checks = [];
function check(name, viewport, fn, opts) { checks.push({ name, viewport, fn, opts: opts || {} }); }

// `/api/render` requests in flight per page, counted in node from the page's
// own request events. The runner installs the listeners before goto, so a
// render the page starts on its own is never missed.
const renderCounters = new WeakMap();
function trackRenders(page) {
  const c = { n: 0, total: 0 };
  renderCounters.set(page, c);
  const isRender = (r) => { try { return new URL(r.url()).pathname === '/api/render'; } catch (e) { return false; } };
  page.on('request', (r) => { if (isRender(r)) { c.n++; c.total++; } });
  page.on('requestfinished', (r) => { if (isRender(r)) c.n--; });
  page.on('requestfailed', (r) => { if (isRender(r)) c.n--; });
}
// Waits until no `/api/render` is outstanding, then lets the page run one
// macrotask and two frames — the landing render's own continuation, and any
// replay it schedules. Repeats while that settling started another render (a
// replayed Enter is a new commit). Throws with the count, never a bare timeout.
async function renderIdle(page) {
  const c = renderCounters.get(page);
  const deadline = Date.now() + 20000;
  for (;;) {
    while (c.n > 0) {
      if (Date.now() > deadline) throw new Error('renderIdle: ' + c.n + ' /api/render still outstanding after 20s');
      await wait(25);
    }
    await page.evaluate(() => new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 0)));
    if (c.n === 0) return;
  }
}
// Every `/api/render` request the page has made so far (never decremented).
function renderTotal(page) { return renderCounters.get(page).total; }
// Holds every `/api/render` for `ms` before letting it through: the window in
// which a commit is in flight, made wide enough that no keystroke can miss it.
async function delayRender(page, ms) {
  await page.route('**/api/render', async (route) => { await wait(ms); await route.continue(); });
}

check('theme: the edit page has a theme toggle and it turns the toolbar dark', DESKTOP, async (page) => {
  const btn = page.locator('#md2doc-theme-toggle');
  assert.ok(await btn.isVisible(), 'toggle visible in edit mode');
  await btn.click(); await wait(300);
  const r = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-md2doc-theme'),
    bodyBg: getComputedStyle(document.body).backgroundColor,
  }));
  assert.strictEqual(r.attr, 'dark');
  assert.strictEqual(r.bodyBg, 'rgb(27, 27, 29)');
});
check('theme: on a phone the toggle stays visible in edit mode', PHONE, async (page) => {
  const box = await page.locator('#md2doc-theme-toggle').boundingBox();
  assert.ok(box && box.width > 0 && box.y + box.height <= 844, 'toggle on screen: ' + JSON.stringify(box));
});

check('chrome: light toolbar is paper white with no dark pill', DESKTOP, async (page) => {
  const s = await page.evaluate(() => {
    const bar = getComputedStyle(document.querySelector('.ed-toolbar'));
    const btn = getComputedStyle(document.querySelector('.ed-toolbar-btn'));
    return { bg: bar.backgroundColor, btnBorder: btn.borderTopWidth, btnBg: btn.backgroundColor };
  });
  assert.strictEqual(s.bg, 'rgb(255, 255, 255)');
  assert.strictEqual(s.btnBorder, '0px');
  assert.strictEqual(s.btnBg, 'rgba(0, 0, 0, 0)');
});
check('chrome: block hover draws no dashed outline', DESKTOP, async (page) => {
  const p = page.locator('.ed-block[data-block-type="paragraph"]').first();
  await p.hover(); await wait(200);
  const o = await p.evaluate((e) => getComputedStyle(e).outlineStyle);
  assert.notStrictEqual(o, 'dashed');
});
check('chrome: dark menus and selection toolbar are readable', DESKTOP, async (page) => {
  await page.locator('#md2doc-theme-toggle').click(); await wait(300);
  const para = page.locator('.ed-block[data-block-type="paragraph"]').first();
  await para.hover(); await wait(200);
  await para.locator('.ed-handle').click(); await wait(300);
  const menu = await page.evaluate(() => {
    const m = document.querySelector('.ed-handle-menu');
    const b = m.querySelector('.ed-handle-menu-btn');
    return { bg: getComputedStyle(m).backgroundColor, fg: getComputedStyle(b).color };
  });
  assert.strictEqual(menu.bg, 'rgb(42, 42, 45)');
  assert.ok(contrast(menu.fg, menu.bg) >= 4.5, 'menu text contrast ' + JSON.stringify(menu));
  await page.keyboard.press('Escape');
  // dblclick on the first word, not the element centre: the paragraph is a
  // full-width block, so its centre is usually empty space that selects nothing.
  const box = await para.locator('.ed-wys-armed').boundingBox();
  await page.mouse.dblclick(box.x + 12, box.y + box.height / 2); await wait(400);
  const tb = await page.evaluate(() => {
    const t = document.querySelector('.ed-seltb');
    return { bg: getComputedStyle(t).backgroundColor, fg: getComputedStyle(t.querySelector('.ed-seltb-btn')).color };
  });
  assert.strictEqual(tb.bg, 'rgb(42, 42, 45)');
  assert.ok(contrast(tb.fg, tb.bg) >= 4.5, 'seltb contrast ' + JSON.stringify(tb));
});
check('chrome: focus ring and selection tint use the reader accent', DESKTOP, async (page) => {
  const ed = page.locator('.ed-block[data-block-type="paragraph"] .ed-wys-armed').first();
  await ed.click(); await wait(200);
  const ring = await ed.evaluate((e) => getComputedStyle(e).outlineColor);
  assert.strictEqual(ring, 'rgb(9, 105, 218)');
});

check('wave: the waveform editor panel follows dark', DESKTOP, async (page) => {
  await page.locator('#md2doc-theme-toggle').click(); await wait(300);
  const d = page.locator('.wavedrom-diagram').first();
  await d.scrollIntoViewIfNeeded(); await wait(300);
  const box = await d.boundingBox();
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await wait(300);
  await page.locator('.ed-wave-edit-btn').click(); await wait(800);
  // The lane name is drawn by the engine on the canvas now (Task 6a), so
  // the label is the canvas svg's own name text and its colour is `fill`.
  const s = await page.evaluate(() => {
    const p = document.querySelector('.ed-wave-panel');
    const label = document.querySelector('.ed-wave-stage svg[id^="svgcontent"] g[id^="wavelane_0_"] > text');
    return { bg: getComputedStyle(p).backgroundColor, fg: label ? getComputedStyle(label).fill : null };
  });
  assert.notStrictEqual(s.bg, 'rgb(255, 255, 255)', 'panel is not white in dark');
  assert.ok(s.fg !== null, 'guard: the canvas draws the lane name');
  assert.ok(contrast(s.fg, s.bg) >= 4.5, 'wave label contrast ' + JSON.stringify(s));
}, { md: FIXTURE + '\n\x60\x60\x60wavedrom\n{ "signal": [ { "name": "clk", "wave": "p...." } ] }\n\x60\x60\x60\n' });

// ── wave canvas (Task 6a): the editor draws with the WaveDrom engine ──
async function openWave(page) {
  const d = page.locator('.wavedrom-diagram').first();
  await d.scrollIntoViewIfNeeded(); await wait(300);
  const box = await d.boundingBox();
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await wait(300);
  await page.locator('.ed-wave-edit-btn').click(); await wait(800);
  assert.strictEqual(!!(await page.$('.ed-wave-panel')), true, 'guard: the waveform editor is open');
}
const LONG_NAME = 'a_very_long_signal_name_33_chars_'; // 33 characters
const WAVE_CANVAS_MD = '# W\n\n\x60\x60\x60wavedrom\n' + JSON.stringify({ signal: [
  { name: LONG_NAME, wave: 'p.....' },
  { name: 'bus', wave: 'x333x.', data: ['A', 'B', 'C'] },
] }) + '\n\x60\x60\x60\n\nTail.\n';
check('wave canvas: the editor draws with the engine', DESKTOP, async (page) => {
  assert.strictEqual(LONG_NAME.length, 33, 'guard: the fixture name is 33 characters');
  await openWave(page);
  const r = await page.evaluate(() => {
    const wrap = document.querySelector('.ed-wave-overlay .ed-wave-stage');
    const svg = wrap && wrap.querySelector('svg[id^="svgcontent"]');
    if (!svg) return { svg: false };
    const labels = [...svg.querySelectorAll('g[id^="wavelane_draw_1_"] > text')].map((t) => t.textContent);
    const name = svg.querySelector('g[id^="wavelane_0_"] > text');
    const wr = wrap.getBoundingClientRect();
    const sr = svg.getBoundingClientRect();
    const nr = name.getBoundingClientRect();
    return { svg: true, labels, nameText: name.textContent, nameLeft: nr.left, wrapLeft: wr.left, svgLeft: sr.left,
      clientWidth: sr.width, widthAttr: Number(svg.getAttribute('width')) };
  });
  assert.strictEqual(r.svg, true, 'the engine svg is inside the canvas wrap');
  assert.deepStrictEqual(r.labels, ['A', 'B', 'C'], 'x333x. draws three labels, one per segment (spec 5-1)');
  assert.strictEqual(r.nameText, LONG_NAME);
  assert.ok(r.nameLeft >= r.wrapLeft && r.nameLeft >= r.svgLeft,
    'the 33-character name is not clipped on the left (spec 5-2) ' + JSON.stringify(r));
  assert.ok(Math.abs(r.clientWidth - r.widthAttr) < 0.5,
    'svg client width equals its width attribute (the client conversion divides by the fixed scale) ' + JSON.stringify(r));
}, { md: WAVE_CANVAS_MD });
check('wave canvas: a click paints the cycle under the pointer', DESKTOP, async (page) => {
  await openWave(page);
  await page.locator('.ed-wave-brush[data-brush="1"]').click(); await wait(100);
  const pt = await page.evaluate(() => {
    const p = typeof window.__edWaveCellPoint === 'function' ? window.__edWaveCellPoint(1, 2) : null;
    if (!p) return null;
    const hit = document.elementFromPoint(p.x, p.y);
    const layer = document.querySelector('.ed-wave-overlay .ed-wave-layer');
    return { x: p.x, y: p.y, onLayer: !!(hit && layer && (hit === layer || layer.contains(hit))) };
  });
  assert.ok(pt !== null, 'guard: lane 1 cycle 2 has a point on screen');
  assert.strictEqual(pt.onLayer, true, 'guard: the press lands on the interaction layer ' + JSON.stringify(pt));
  await page.mouse.click(pt.x, pt.y); await wait(300);
  const src = await page.evaluate(() => window.__edWaveSourceProbe());
  const m = /"name":"a","wave":"([^"]*)"/.exec(src);
  assert.ok(m !== null, 'guard: lane a is in the source ' + src);
  assert.strictEqual(m[1][2], '1', 'cycle 2 of lane a is painted 1: ' + m[1]);
  assert.strictEqual(m[1][0], '0', 'cycle 0 is untouched: ' + m[1]);
}, { md: '# W\n\n\x60\x60\x60wavedrom\n{"signal":[{"name":"clk","wave":"p...."},{"name":"a","wave":"0...."}]}\n\x60\x60\x60\n\nTail.\n' });
check('wave canvas: SVG export is the engine drawing at the engine size', DESKTOP, async (page) => {
  // Task 10: export comes from a clean offscreen render, not the canvas. The
  // canvas is drawn at 1.5x; the exported file must be the engine's own
  // size (width/height = viewBox) and carry the skin it draws with.
  await openWave(page);
  // Task 6b: the export buttons live in the 匯出 menu now.
  await page.locator('[data-focus-key="ed-wave-export-menu"]').click(); await wait(100);
  const [dl] = await Promise.all([page.waitForEvent('download'),
    page.locator('[data-focus-key="ed-wave-export-svg"]').click()]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  const root = /<svg\b[^>]*>/.exec(text)[0];
  const attr = (k) => { const m = new RegExp('\\s' + k + '="([^"]*)"').exec(root); return m ? m[1] : null; };
  const vb = attr('viewBox').split(/[\s,]+/).map(Number);
  assert.deepStrictEqual([Number(attr('width')), Number(attr('height'))], [vb[2], vb[3]],
    'exported width/height equal the viewBox: ' + root.slice(0, 200));
  assert.ok(/<defs[\s>]/.test(text) && /<style[\s>]/.test(text), 'the export carries the skin defs and style');
  assert.ok(text.includes('>A<') && text.includes('>C<'), 'the export is this diagram (its labels are in it)');
}, { md: WAVE_CANVAS_MD, ctx: { acceptDownloads: true } });
check('wave canvas: dark mode recolours the canvas', DESKTOP, async (page) => {
  await page.locator('#md2doc-theme-toggle').click(); await wait(300);
  await openWave(page);
  const fill = await page.evaluate(() => {
    const t = document.querySelector('.ed-wave-stage svg[id^="svgcontent"] g[id^="wavelane_0_"] > text');
    return t ? getComputedStyle(t).fill : null;
  });
  assert.ok(fill !== null, 'guard: the canvas draws the lane name');
  assert.ok(lum(fill) >= 0.35, 'lane name is light on the dark canvas: ' + fill + ' lum ' + lum(fill).toFixed(3));
}, { md: WAVE_CANVAS_MD });

// ── wave shell (Task 6b): title bar, toolbar, messages, no side rail ──
const WAVE_TOOLBAR_KEYS = ['ed-wave-undo', 'ed-wave-redo',
  'brush-0', 'brush-1', 'brush-x', 'brush-=', 'brush-3', 'brush-p', 'ed-wave-brush-more',
  'ed-wave-cycle-insert', 'ed-wave-cycle-delete', 'ed-wave-signal-menu', 'ed-wave-edge-arm',
  'ed-wave-settings', 'ed-wave-export-menu', 'ed-wave-done'];
const WAVE_SHELL_MD = '# W\n\n\x60\x60\x60wavedrom\n{"signal":[{"name":"clk","wave":"p...."},{"name":"a","wave":"0...."}]}\n\x60\x60\x60\n\nTail.\n';
check('wave shell: no side rail, canvas uses the full width', DESKTOP, async (page) => {
  await openWave(page);
  const r = await page.evaluate(() => {
    const panel = document.querySelector('.ed-wave-panel');
    const stage = document.querySelector('.ed-wave-overlay .ed-wave-stage');
    return {
      side: document.querySelectorAll('.ed-wave-side').length,
      panelW: panel.getBoundingClientRect().width,
      stageW: stage ? stage.getBoundingClientRect().width : null,
      keys: [...document.querySelectorAll('.ed-wave-toolbar [data-focus-key]')].map((b) => b.getAttribute('data-focus-key')),
      title: (document.querySelector('.ed-wave-head .ed-wave-title') || {}).textContent || null,
      statusLine: document.querySelectorAll('.ed-wave-status').length,
      hint: !!document.querySelector('.ed-wave-panel .ed-wave-hint'),
      live: (() => { const l = document.querySelector('.ed-wave-panel .ed-wave-live'); return l ? l.getAttribute('role') : null; })(),
    };
  });
  assert.strictEqual(r.side, 0, 'no right-hand side rail');
  assert.ok(r.stageW !== null && r.stageW >= r.panelW - 40, 'the stage takes the full width ' + JSON.stringify(r));
  assert.deepStrictEqual(r.keys, WAVE_TOOLBAR_KEYS, 'toolbar order (spec 4.2)');
  assert.strictEqual(r.title, '編輯波形');
  assert.strictEqual(r.statusLine, 0, 'no visible status line');
  assert.strictEqual(r.hint, true, 'the bottom hint bar is there');
  assert.strictEqual(r.live, 'status', 'the hidden live region is role=status');
}, { md: WAVE_SHELL_MD });
check('wave shell: title bar shows the save status', DESKTOP, async (page) => {
  await openWave(page);
  const read = () => page.evaluate(() => {
    const s = document.querySelector('.ed-wave-head .ed-wave-save');
    return s ? { dirty: s.getAttribute('data-dirty'), text: s.textContent } : null;
  });
  const before = await read();
  assert.ok(before !== null, 'guard: the save status is in the title bar');
  assert.strictEqual(before.dirty, '0', 'a freshly opened clean document reads saved ' + JSON.stringify(before));
  assert.ok(before.text.includes('已儲存'), before.text);
  await page.locator('[data-focus-key="brush-1"]').click(); await wait(100);
  const pt = await page.evaluate(() => window.__edWaveCellPoint(1, 2));
  assert.ok(pt !== null, 'guard: lane 1 cycle 2 has a point');
  await page.mouse.click(pt.x, pt.y); await wait(400);
  const dirty = await read();
  assert.strictEqual(dirty.dirty, '1', 'a paint makes it dirty ' + JSON.stringify(dirty));
  assert.ok(dirty.text.includes('有未儲存的變更'), dirty.text);
  await page.keyboard.press('Control+s'); await wait(900);
  const saved = await read();
  assert.strictEqual(saved.dirty, '0', 'Ctrl+S makes it clean ' + JSON.stringify(saved));
  assert.ok(saved.text.includes('已儲存'), saved.text);
  assert.strictEqual(await page.evaluate(() => (document.querySelector('.ed-conflict[data-level="notice"] .ed-msg-text') || {}).textContent || null),
    '已儲存', 'Ctrl+S says 已儲存 at the bottom (spec 4.8)');
  assert.strictEqual(!!(await page.$('.ed-wave-overlay')), true, 'the editor stays open after Ctrl+S');
}, { md: WAVE_SHELL_MD });
check('wave shell: refusals go to the notice toast', DESKTOP, async (page) => {
  await openWave(page);
  await page.locator('[data-focus-key="ed-wave-cycle-delete"]').click(); await wait(200);
  const r = await page.evaluate(() => {
    const n = document.querySelector('.ed-conflict[data-level="notice"] .ed-msg-text');
    return { text: n ? n.textContent : null, errors: document.querySelectorAll('.ed-conflict[data-level="error"]').length,
      status: document.querySelector('.ed-wave-overlay').getAttribute('data-wave-status') };
  });
  assert.strictEqual(r.text, '先選一段 cycle 再刪', 'the refusal is a notice toast ' + JSON.stringify(r));
  assert.strictEqual(r.errors, 0, 'a refusal is not an error card');
  assert.strictEqual(r.status, '先選一段 cycle 再刪', 'data-wave-status carries the last message');
}, { md: WAVE_SHELL_MD });
check('wave shell: a notice never replaces an error card', DESKTOP, async (page) => {
  // A real error path: the save request fails, so client.js raises its red
  // card. A wave notice after that must not take the card's place (spec E2:
  // a card about lost work stays until the user closes it).
  await page.route('**/api/save', (route) => route.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' }));
  await openWave(page);
  await page.locator('[data-focus-key="brush-1"]').click(); await wait(100);
  const pt = await page.evaluate(() => window.__edWaveCellPoint(1, 2));
  await page.mouse.click(pt.x, pt.y); await wait(300);
  await page.keyboard.press('Control+s'); await wait(900);
  const card = await page.evaluate(() => (document.querySelector('.ed-conflict[data-level="error"] .ed-msg-text') || {}).textContent || null);
  assert.ok(card !== null && card.includes('無法儲存'), 'guard: the failed save raised the error card ' + card);
  // A refusal that changes nothing: Alt+→ while no dots are up (no A pick, 關聯線 off).
  await page.locator('.ed-wave-overlay .ed-wave-layer').focus();
  await page.keyboard.press('Alt+ArrowRight'); await wait(200);
  const r = await page.evaluate(() => ({
    banners: [...document.querySelectorAll('.ed-conflict')].map((b) => b.getAttribute('data-level') + ':' + b.querySelector('.ed-msg-text').textContent),
    status: document.querySelector('.ed-wave-overlay').getAttribute('data-wave-status'),
  }));
  assert.deepStrictEqual(r.banners, ['error:' + card], 'the error card is still the one on screen ' + JSON.stringify(r));
  assert.strictEqual(r.status, '先按 A 從游標拉關聯線，或按「關聯線」讓圓點一直顯示，Alt+←／→ 才有轉態點可以跳', 'the editor still records the notice');
}, { md: WAVE_SHELL_MD });
check('wave shell: canvas is the engine drawing', DESKTOP, async (page) => {
  await openWave(page);
  const r = await page.evaluate(() => {
    const stage = document.querySelector('.ed-wave-overlay .ed-wave-stage');
    const svg = stage && stage.querySelector('svg[id^="svgcontent"]');
    if (!svg) return { svg: false };
    const name = svg.querySelector('g[id^="wavelane_0_"] > text');
    return { svg: true,
      labels: [...svg.querySelectorAll('g[id^="wavelane_draw_1_"] > text')].map((t) => t.textContent),
      nameText: name.textContent, nameLeft: name.getBoundingClientRect().left, stageLeft: stage.getBoundingClientRect().left };
  });
  assert.strictEqual(r.svg, true, 'the engine svg is inside the stage');
  assert.deepStrictEqual(r.labels, ['A', 'B', 'C'], 'x333x. draws three labels (spec 5-1)');
  assert.strictEqual(r.nameText, LONG_NAME);
  assert.ok(r.nameLeft >= r.stageLeft, 'the 33-character name is whole (spec 5-2) ' + JSON.stringify(r));
}, { md: WAVE_CANVAS_MD });
check('wave shell: more opens the grouped brush grid', DESKTOP, async (page) => {
  await openWave(page);
  assert.strictEqual(await page.$$eval('.ed-wave-brush-grid', (g) => g.length), 0, 'guard: the grid is closed at first');
  await page.locator('[data-focus-key="ed-wave-brush-more"]').click(); await wait(150);
  const r = await page.evaluate(() => {
    const grid = document.querySelector('.ed-wave-overlay .ed-wave-brush-grid');
    if (!grid) return null;
    return {
      titles: [...grid.querySelectorAll('.ed-wave-brush-group-title')].map((t) => t.textContent),
      groups: [...grid.querySelectorAll('.ed-wave-brush-group')].map((g) =>
        [...g.querySelectorAll('.ed-wave-brush')].map((b) => b.getAttribute('data-brush')).join(' ')),
      count: grid.querySelectorAll('.ed-wave-brush').length,
    };
  });
  assert.ok(r !== null, 'the grid opens');
  assert.strictEqual(r.count, 16);
  assert.deepStrictEqual(r.titles, ['電位', '時脈', '資料', '其他']);
  assert.deepStrictEqual(r.groups, ['z h l u d', 'n P N', '2 4 5 6 7 8 9', '|']);
  await page.locator('[data-focus-key="brush-z"]').click(); await wait(150);
  const after = await page.evaluate(() => ({
    brush: document.querySelector('.ed-wave-overlay').getAttribute('data-wave-brush'),
    more: document.querySelector('[data-focus-key="ed-wave-brush-more"]').classList.contains('is-on'),
  }));
  assert.deepStrictEqual(after, { brush: 'z', more: true }, 'z is picked and 更多 shows a brush from it is on');
}, { md: WAVE_SHELL_MD });
check('wave shell: undrawable edges show in the notice card', DESKTOP, async (page) => {
  await openWave(page);
  const r = await page.evaluate(() => {
    const n = document.querySelector('.ed-wave-overlay .ed-wave-notice');
    return n ? { visible: !n.hidden && n.getClientRects().length > 0, text: n.textContent,
      skipped: document.querySelector('.ed-wave-overlay').getAttribute('data-wave-skipped-edges') } : null;
  });
  assert.ok(r !== null, 'the notice card exists');
  assert.strictEqual(r.visible, true, 'the notice card is on screen ' + JSON.stringify(r));
  assert.ok(r.text.includes('MD 原始碼'), 'it says the next step ' + r.text);
  assert.ok(r.text.includes('q'), 'it names the missing anchor ' + r.text);
  assert.strictEqual(r.skipped, '1', 'the point note e is drawable and not listed (spec 5-3)');
}, { md: '# W\n\n\x60\x60\x60wavedrom\n' + JSON.stringify({ signal: [{ name: 'a', wave: '0.1.0', node: '.a..e' }],
  edge: ['a~>q x', 'e note'] }) + '\n\x60\x60\x60\n\nTail.\n' });
check('wave shell: missing engine shows an error card', DESKTOP, async (page) => {
  const d = page.locator('.wavedrom-diagram').first();
  await d.scrollIntoViewIfNeeded(); await wait(300);
  const box = await d.boundingBox();
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await wait(300);
  const gone = await page.evaluate(() => { delete window.WaveDrom; if (window.WaveDrom) window.WaveDrom = undefined; return typeof WaveDrom; });
  assert.strictEqual(gone, 'undefined', 'guard: the engine is gone');
  await page.locator('.ed-wave-edit-btn').click(); await wait(800);
  const r = await page.evaluate(() => ({
    error: (document.querySelector('.ed-conflict[data-level="error"] .ed-msg-text') || {}).textContent || null,
    overlay: document.querySelectorAll('.ed-wave-overlay').length,
  }));
  assert.ok(r.error !== null && r.error.includes('波形引擎沒有載入'), 'an error card says so ' + JSON.stringify(r));
  assert.strictEqual(r.overlay, 0, 'no blank canvas is opened');
}, { md: WAVE_SHELL_MD });
check('wave shell: Tab cycles through the toolbar and the canvas', DESKTOP, async (page) => {
  await openWave(page);
  await page.locator('.ed-wave-close').focus();
  // The bound is derived from the dialog's own focusable count (same selector and
  // filters as wave-ui.js focusables()), never a number: a toolbar change must
  // not leave the walk too short to come back round.
  const plan = await page.evaluate(() => {
    const SEL = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';
    const roots = [document.querySelector('.ed-wave-overlay'), ...document.querySelectorAll('.ed-conflict')];
    const all = [];
    for (const root of roots) for (const el of root.querySelectorAll(SEL)) {
      if (el.disabled === true || el.hidden === true || el.getClientRects().length === 0) continue;
      all.push(el.getAttribute('data-focus-key'));
    }
    const toolbar = [...document.querySelectorAll('.ed-wave-toolbar [data-focus-key]')]
      .filter((b) => !b.disabled).map((b) => b.getAttribute('data-focus-key'));
    return { count: all.length, toolbar, start: document.activeElement.getAttribute('data-focus-key') };
  });
  assert.strictEqual(plan.start, 'ed-wave-close', 'guard: the walk starts on ✕');
  const seen = [];
  for (let i = 0; i < plan.count; i++) {
    await page.keyboard.press('Tab'); await wait(30);
    seen.push(await page.evaluate(() => document.activeElement.getAttribute('data-focus-key')));
  }
  for (const k of plan.toolbar.concat(['canvas'])) {
    assert.ok(seen.includes(k), 'Tab reaches ' + k + ': ' + JSON.stringify(seen));
  }
  assert.strictEqual(seen[seen.length - 1], 'ed-wave-close', 'the walk comes back to ✕ ' + JSON.stringify(seen));
}, { md: WAVE_SHELL_MD });
check('wave shell: no dots on open, every dot while 關聯線 is on', DESKTOP, async (page) => {
  await openWave(page);
  const dots = () => page.evaluate(() => document.querySelectorAll('.ed-wave-overlay .ed-wave-dot').length);
  assert.strictEqual(await dots(), 0, 'no dots on open');
  await page.locator('[data-focus-key="ed-wave-edge-arm"]').click(); await wait(200);
  const n = await dots();
  assert.ok(n > 0, '關聯線 keeps every dot shown: ' + n);
}, { md: WAVE_SHELL_MD });
check('wave shell: the cursor mark sits on the clicked cell', DESKTOP, async (page) => {
  await openWave(page);
  const pt = await page.evaluate(() => window.__edWaveCellPoint(1, 2));
  assert.ok(pt !== null, 'guard: lane 1 cycle 2 has a point');
  await page.mouse.click(pt.x, pt.y); await wait(300);
  const r = await page.evaluate(() => {
    const cell = typeof window.__edWaveCellRect === 'function' ? window.__edWaveCellRect(1, 2) : null;
    const cur = document.querySelector('.ed-wave-overlay rect.ed-wave-cursor');
    if (cell === null || cur === null) return { cell: cell !== null, cur: cur !== null };
    const c = cur.getBoundingClientRect();
    return { cell: [cell.left, cell.top, cell.width, cell.height], cur: [c.left, c.top, c.width, c.height] };
  });
  assert.ok(Array.isArray(r.cell) && Array.isArray(r.cur), 'guard: both rects exist ' + JSON.stringify(r));
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(r.cell[i] - r.cur[i]) <= 1, 'cursor rect equals the cell rect ' + JSON.stringify(r));
  }
}, { md: WAVE_SHELL_MD });

// ── wave draw (Task 7): drawing straight on the engine canvas (spec 4.3) ──
const waveMd = (signal) => '# W\n\n\x60\x60\x60wavedrom\n' + JSON.stringify({ signal }) + '\n\x60\x60\x60\n\nTail.\n';
const WAVE_DRAW_MD = waveMd([{ name: 'clk', wave: 'p....' }, { name: 'a', wave: '0....' }]);
const WAVE_RANGE_MD = waveMd([{ name: 'clk', wave: 'p.......' }, { name: 'a', wave: '01xz01xz' }]);
const WAVE_DATA_MD = waveMd([{ name: 'clk', wave: 'p......' }, { name: 'bus', wave: 'x3.4.5x', data: ['D1', 'D2', 'D3'] }]);
/** One lane of the block as it is written back right now. */
async function laneNamed(page, name) {
  const doc = JSON.parse(await page.evaluate(() => window.__edWaveSourceProbe()));
  return doc.signal.find((l) => l && l.name === name);
}
/** A cell's centre, asserting a press there lands on the interaction layer. */
async function cellPress(page, lane, cycle) {
  const p = await page.evaluate(([l, c]) => {
    const pt = window.__edWaveCellPoint(l, c);
    if (!pt) return null;
    const hit = document.elementFromPoint(pt.x, pt.y);
    const layer = document.querySelector('.ed-wave-overlay .ed-wave-layer');
    return { x: pt.x, y: pt.y, onLayer: !!(hit && layer && (hit === layer || layer.contains(hit))) };
  }, [lane, cycle]);
  assert.ok(p !== null && p.onLayer, 'guard: a press on lane ' + lane + ' cycle ' + cycle + ' lands on the layer ' + JSON.stringify(p));
  return p;
}
/** The selection mark's client rect against the union of the cells it should cover. */
async function selectionVs(page, lane, from, to) {
  return page.evaluate(([l, a, b]) => {
    const sel = document.querySelector('.ed-wave-overlay rect.ed-wave-selection');
    const ra = window.__edWaveCellRect(l, a);
    const rb = window.__edWaveCellRect(l, b);
    const s = sel ? sel.getBoundingClientRect() : null;
    return { sel: s && [s.left, s.top, s.width, s.height], want: [ra.left, ra.top, rb.left + rb.width - ra.left, ra.height] };
  }, [lane, from, to]);
}
function sameRect(r, msg) {
  assert.ok(Array.isArray(r.sel), 'the selection is drawn ' + msg + ' ' + JSON.stringify(r));
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(r.sel[i] - r.want[i]) <= 1, msg + ' ' + JSON.stringify(r));
}
/** The floating range toolbar, as plain values. */
function rangeBar(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('.ed-wave-overlay .ed-wave-range');
    if (!bar || bar.getClientRects().length === 0) return null;
    const del = bar.querySelector('[data-focus-key="ed-wave-range-delete"]');
    const r = bar.getBoundingClientRect();
    return { keys: [...bar.querySelectorAll('[data-focus-key]')].map((b) => b.getAttribute('data-focus-key')),
      deleteText: del ? del.textContent : null, top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  });
}
/** Click lane `lane` cycle `from` (its value must equal the brush, so the click paints nothing) and Shift+→ to `to`. */
async function selectRun(page, lane, from, to) {
  const p = await cellPress(page, lane, from);
  await page.mouse.click(p.x, p.y); await wait(150);
  for (let c = from; c < to; c++) { await page.keyboard.press('Shift+ArrowRight'); await wait(60); }
}
check('wave draw: click paints one cycle and selects it', DESKTOP, async (page) => {
  await openWave(page);
  await page.locator('[data-focus-key="brush-1"]').click(); await wait(100);
  const p = await cellPress(page, 1, 2);
  await page.mouse.click(p.x, p.y); await wait(300);
  assert.strictEqual((await laneNamed(page, 'a')).wave, '0.10.', 'cycle 2 painted 1, the cycle after it written out');
  assert.strictEqual(await page.evaluate(() => document.querySelector('.ed-wave-overlay').getAttribute('data-wave-cursor')), '1,2');
  sameRect(await selectionVs(page, 1, 2, 2), 'the clicked cycle is selected');
  assert.strictEqual(await rangeBar(page), null, 'one cycle is not a range: no floating toolbar');
}, { md: WAVE_DRAW_MD });
check('wave draw: hover lights the whole cycle and its ruler number', DESKTOP, async (page) => {
  await openWave(page);
  const p = await cellPress(page, 1, 2);
  await page.mouse.move(p.x, p.y, { steps: 3 }); await wait(150);
  const r = await page.evaluate(() => {
    const col = document.querySelector('.ed-wave-overlay rect.ed-wave-hover-col');
    const top = window.__edWaveCellRect(0, 2);
    const bottom = window.__edWaveCellRect(1, 2);
    const c = col ? col.getBoundingClientRect() : null;
    return { col: c && [c.left, c.width, c.top, c.bottom], cell: [top.left, top.width, top.top, bottom.top + bottom.height],
      on: [...document.querySelectorAll('.ed-wave-overlay .ed-wave-ruler-num.is-on')].map((t) => t.getAttribute('data-cycle')) };
  });
  assert.ok(Array.isArray(r.col), 'a hover column is drawn ' + JSON.stringify(r));
  assert.ok(Math.abs(r.col[0] - r.cell[0]) <= 1 && Math.abs(r.col[1] - r.cell[1]) <= 1, 'it is cycle 2 wide ' + JSON.stringify(r));
  assert.ok(r.col[2] <= r.cell[2] + 1 && r.col[3] >= r.cell[3] - 1, 'it covers every lane ' + JSON.stringify(r));
  assert.deepStrictEqual(r.on, ['2'], 'ruler number 2 lights up');
  assert.strictEqual((await laneNamed(page, 'a')).wave, '0....', 'hovering writes nothing');
}, { md: WAVE_DRAW_MD });
check('wave draw: drag paints a run', DESKTOP, async (page) => {
  await openWave(page);
  await page.locator('[data-focus-key="brush-1"]').click(); await wait(100);
  const a = await cellPress(page, 1, 1);
  const b = await cellPress(page, 1, 3);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 }); await page.mouse.up(); await wait(300);
  assert.strictEqual((await laneNamed(page, 'a')).wave, '01..0', 'one run of 1 over cycles 1-3');
  sameRect(await selectionVs(page, 1, 1, 3), 'the dragged run is selected');
  const bar = await rangeBar(page);
  assert.ok(bar !== null, 'a run selection raises the floating toolbar');
  assert.ok(bar.deleteText.includes('3'), 'it offers to delete 3 cycles: ' + bar.deleteText);
  // It floats beside the run, never over it, and every cell of the run still takes a press.
  const run = await page.evaluate(() => { const a = window.__edWaveCellRect(1, 1); const b = window.__edWaveCellRect(1, 3);
    return { top: a.top, bottom: a.top + a.height }; });
  assert.ok(bar.bottom <= run.top + 0.5 || bar.top >= run.bottom - 0.5, 'the toolbar does not cover the run ' + JSON.stringify({ bar, run }));
  for (const c of [1, 2, 3]) await cellPress(page, 1, c);
}, { md: WAVE_DRAW_MD });
// Final review I1 (spec 3.2「拖曳塗色時每跨進一格重畫一次」): while the button is down the ENGINE
// canvas already shows the painted run — drawn from a document that is never committed — and the
// release writes it once. Esc mid-drag puts the drawing back and writes nothing.
check('wave draw: a paint drag redraws the engine canvas live and writes once on release', DESKTOP, async (page) => {
  await openWave(page);
  await page.locator('[data-focus-key="brush-1"]').click(); await wait(100);
  /** Lane a as the engine drew it, the source as written back, and the gesture count. */
  const state = () => page.evaluate(() => {
    const svg = document.querySelector('.ed-wave-stage svg[id^="svgcontent"]');
    const lane = svg && svg.querySelector('g[id^="wavelane_draw_1_"]');
    return { lane: lane ? lane.innerHTML : null, src: window.__edWaveSourceProbe(),
      gestures: document.querySelector('.ed-wave-overlay').getAttribute('data-wave-gestures') };
  });
  const before = await state();
  assert.ok(before.lane !== null && before.lane.length > 0, 'guard: lane a is drawn by the engine');
  const a = await cellPress(page, 1, 1);
  const b = await cellPress(page, 1, 3);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 }); await wait(200);
  const mid = await state();
  assert.notStrictEqual(mid.lane, before.lane, 'mid-drag, the engine has already redrawn lane a');
  assert.strictEqual(mid.src, before.src, 'and nothing is written yet');
  assert.strictEqual(mid.gestures, before.gestures, 'nor counted as a gesture');
  assert.strictEqual(await page.evaluate(() => document.querySelector('.ed-wave-overlay').getAttribute('data-wave-canvas')), 'ok');
  // The pointer is still read against the drawing on screen: the run's end cell still takes it.
  await cellPress(page, 1, 3);
  await page.mouse.up(); await wait(300);
  const after = await state();
  assert.strictEqual((await laneNamed(page, 'a')).wave, '01..0', 'the release writes the run');
  assert.strictEqual(after.lane, mid.lane, 'what the drag showed is exactly what was committed');
  assert.strictEqual(Number(after.gestures), Number(before.gestures) + 1, 'one gesture, one write-back');
  await page.keyboard.press('Control+z'); await wait(300);
  assert.strictEqual((await laneNamed(page, 'a')).wave, '0....', 'one undo takes the whole run back');
  assert.strictEqual((await state()).lane, before.lane, 'and the drawing with it');
  // Esc mid-drag: the drawing goes back and the release writes nothing.
  const base = await state();
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 }); await wait(200);
  assert.notStrictEqual((await state()).lane, base.lane, 'guard: the second drag is drawn live too');
  await page.keyboard.press('Escape'); await wait(200);
  const cancelled = await state();
  assert.strictEqual(cancelled.lane, base.lane, 'Esc redraws the committed document');
  await page.mouse.up(); await wait(300);
  const released = await state();
  assert.strictEqual(released.src, base.src, 'the release after Esc writes nothing');
  assert.strictEqual(released.gestures, base.gestures, 'and counts no gesture');
  assert.strictEqual(released.lane, base.lane, 'and the drawing stays as it was');
  assert.strictEqual(await page.evaluate(() => !!document.querySelector('.ed-wave-overlay')), true, 'Esc took the drag, not the editor');
}, { md: WAVE_DRAW_MD });
check('wave draw: ruler plus inserts a cycle at that boundary', DESKTOP, async (page) => {
  await openWave(page);
  // The boundary between cycles 1 and 2, at the height of the ruler numbers.
  const at = await page.evaluate(() => {
    const num = document.querySelector('.ed-wave-overlay .ed-wave-ruler-num[data-cycle="2"]');
    const n = num.getBoundingClientRect();
    return { x: window.__edWaveCellRect(0, 2).left, y: n.top + n.height / 2 };
  });
  await page.mouse.move(at.x, at.y, { steps: 3 }); await wait(150);
  const plus = await page.evaluate(() => {
    const g = document.querySelector('.ed-wave-overlay .ed-wave-ruler-plus');
    const hit = g && g.querySelector('.ed-wave-ruler-plus-hit');
    if (!hit) return { cycle: g ? g.getAttribute('data-cycle') : null };
    const r = hit.getBoundingClientRect();
    const x = r.left + r.width / 2; const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return { cycle: g.getAttribute('data-cycle'), x, y, onPlus: !!(top && top.closest && top.closest('.ed-wave-ruler-plus') === g) };
  });
  assert.strictEqual(plus.cycle, '2', 'the plus shows at boundary 2 ' + JSON.stringify(plus));
  assert.strictEqual(plus.onPlus, true, 'guard: the plus is what a press there hits ' + JSON.stringify(plus));
  assert.strictEqual(await page.evaluate(() => document.querySelector('.ed-wave-overlay').getAttribute('data-wave-cycles')), '5');
  await page.mouse.click(plus.x, plus.y); await wait(300);
  assert.strictEqual(await page.evaluate(() => document.querySelector('.ed-wave-overlay').getAttribute('data-wave-cycles')), '6', 'one cycle more');
  assert.strictEqual((await laneNamed(page, 'a')).wave, '01.010', 'the new cycle continues cycle 1, in front of cycle 2');
  assert.strictEqual((await laneNamed(page, 'clk')).wave, 'p.....', 'every lane widens');
}, { md: waveMd([{ name: 'clk', wave: 'p....' }, { name: 'a', wave: '01010' }]) });
check('wave draw: range toolbar buttons', DESKTOP, async (page) => {
  await openWave(page);
  const a = async () => (await laneNamed(page, 'a')).wave;
  const undo = async () => { await page.keyboard.press('Control+z'); await wait(250); assert.strictEqual(await a(), '01xz01xz', 'guard: undo restores'); };
  await selectRun(page, 1, 1, 3);
  const bar = await rangeBar(page);
  assert.ok(bar !== null, 'selecting 3 cycles raises the floating toolbar');
  assert.deepStrictEqual(bar.keys, ['ed-wave-range-level', 'ed-wave-range-copy', 'ed-wave-range-delete',
    'ed-wave-range-before', 'ed-wave-range-after', 'ed-wave-range-edge', 'ed-wave-range-note'], 'the buttons, in spec 4.3 order');
  assert.ok(bar.deleteText.includes('3'), bar.deleteText);
  await page.locator('[data-focus-key="ed-wave-range-delete"]').click(); await wait(300);
  assert.strictEqual(await a(), '001xz', '刪除 3 拍');
  await undo();
  await selectRun(page, 1, 1, 3);
  await page.locator('[data-focus-key="ed-wave-range-before"]').click(); await wait(300);
  assert.strictEqual(await a(), '0.1xz01xz', '前插: one cycle in front of the run');
  await undo();
  await selectRun(page, 1, 1, 3);
  await page.locator('[data-focus-key="ed-wave-range-after"]').click(); await wait(300);
  assert.strictEqual(await a(), '01xz.01xz', '後插: one cycle after the run');
  await undo();
  await selectRun(page, 1, 1, 3);
  await page.locator('[data-focus-key="ed-wave-range-level"]').click(); await wait(150);
  await page.locator('[data-focus-key="range-level-z"]').click(); await wait(300);
  assert.strictEqual(await a(), '0z..01xz', '電位: the run becomes one z run');
  assert.strictEqual(await page.evaluate(() => document.querySelector('.ed-wave-overlay').getAttribute('data-wave-brush')), '1',
    'picking a level for the run does not change the brush');
  await undo();
  await selectRun(page, 1, 1, 3);
  await page.locator('[data-focus-key="ed-wave-range-copy"]').click(); await wait(200);
  assert.strictEqual(await a(), '01xz01xz', '複製 writes nothing');
  await page.locator('.ed-wave-overlay .ed-wave-layer').focus();
  await page.keyboard.press('Control+v'); await wait(300);
  assert.strictEqual(await a(), '01xz1xz01xz', 'Ctrl+V on the canvas pastes the copied cycles in front of the selection');
  await undo();
  // 關聯線 (A) and 標註 (T), Task 9: an edge picked from the run's live end, a note field there.
  const ov = (k) => page.evaluate((k) => document.querySelector('.ed-wave-overlay').getAttribute(k), k);
  await selectRun(page, 1, 1, 3);
  await page.locator('[data-focus-key="ed-wave-range-edge"]').click(); await wait(150);
  assert.strictEqual(await ov('data-wave-edgemode'), 'picking', '關聯線 starts an edge');
  assert.strictEqual(await ov('data-wave-edge-pending'), '1,3', 'from the cell the run ends on');
  await page.keyboard.press('Escape'); await wait(150);
  assert.strictEqual(await ov('data-wave-edgemode'), 'idle', 'Esc drops it');
  await selectRun(page, 1, 1, 3);
  await page.locator('[data-focus-key="ed-wave-range-note"]').click(); await wait(150);
  assert.strictEqual(await page.evaluate(() => (document.querySelector('.ed-wave-edge-input') || {}).getAttribute
    ? document.querySelector('.ed-wave-edge-input').getAttribute('data-kind') : null), 'note', '標註 opens the note field');
  await page.keyboard.press('Escape'); await wait(150);
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.ed-wave-edge-input').length), 0, 'Esc closes it');
  assert.strictEqual(await a(), '01xz01xz', 'neither wrote anything');
}, { md: WAVE_RANGE_MD });
check('wave draw: data label edits in place', DESKTOP, async (page) => {
  await openWave(page);
  const label = await page.evaluate(() => {
    const t = [...document.querySelectorAll('.ed-wave-stage svg[id^="svgcontent"] g[id^="wavelane_draw_1_"] > text')]
      .find((x) => x.textContent === 'D1');
    if (!t) return null;
    const r = t.getBoundingClientRect();
    const x = r.left + r.width / 2; const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const layer = document.querySelector('.ed-wave-overlay .ed-wave-layer');
    return { x, y, onLayer: !!(hit && layer && (hit === layer || layer.contains(hit))) };
  });
  assert.ok(label !== null && label.onLayer, 'guard: the engine draws D1 and a press on it lands on the layer ' + JSON.stringify(label));
  await page.mouse.click(label.x, label.y); await wait(300);
  const field = await page.evaluate(([x, y]) => {
    const input = document.querySelector('.ed-wave-overlay .ed-wave-data-input');
    return input ? { value: input.value, focused: document.activeElement === input, atLabel: document.elementFromPoint(x, y) === input } : null;
  }, [label.x, label.y]);
  assert.ok(field !== null, 'a press on the label opens its field');
  assert.deepStrictEqual(field, { value: 'D1', focused: true, atLabel: true }, 'the field sits over the label and holds its text');
  assert.strictEqual((await laneNamed(page, 'bus')).wave, 'x3.4.5x', 'the press painted nothing');
  await page.keyboard.type('Q9'); await page.keyboard.press('Enter'); await wait(300);
  assert.deepStrictEqual((await laneNamed(page, 'bus')).data, ['Q9', 'D2', 'D3'], 'Enter writes the label');
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.ed-wave-data-input').length), 0, 'the field closes');
  assert.strictEqual(await page.evaluate(() => document.activeElement.getAttribute('data-focus-key')), 'canvas', 'the keyboard is back on the canvas');
  // Enter on the data cell opens the same field; Tab goes on to the next segment's.
  await page.keyboard.press('Enter'); await wait(200);
  assert.strictEqual(await page.evaluate(() => (document.querySelector('.ed-wave-data-input') || {}).value), 'Q9', 'Enter on the cell reopens it');
  await page.keyboard.press('Tab'); await wait(300);
  assert.strictEqual(await page.evaluate(() => (document.querySelector('.ed-wave-data-input') || {}).value), 'D2', 'Tab moves to the next segment');
  // Esc cancels the field only (spec 4.3): the editor stays open, nothing changes.
  await page.keyboard.type('zz'); await page.keyboard.press('Escape'); await wait(200);
  const after = await page.evaluate(() => ({ fields: document.querySelectorAll('.ed-wave-data-input').length,
    open: !!document.querySelector('.ed-wave-overlay') }));
  assert.deepStrictEqual(after, { fields: 0, open: true }, 'Esc closes the field and not the editor');
  assert.deepStrictEqual((await laneNamed(page, 'bus')).data, ['Q9', 'D2', 'D3'], 'Esc wrote nothing');
}, { md: WAVE_DATA_MD });
check('wave draw: IME composition does not commit the label', DESKTOP, async (page) => {
  await openWave(page);
  // Keyboard route to D2's cell (bus lane, cycle 3): onto the canvas, down a lane, right three.
  await page.locator('.ed-wave-overlay .ed-wave-layer').focus(); await wait(100);
  await page.keyboard.press('ArrowDown');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter'); await wait(200);
  assert.strictEqual(await page.evaluate(() => (document.querySelector('.ed-wave-data-input') || {}).value), 'D2', 'guard: the D2 field is open');
  const during = await page.evaluate(() => {
    const input = document.querySelector('.ed-wave-data-input');
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    input.value = '組字';
    for (const key of ['Enter', 'Escape', 'Tab']) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: true }));
    }
    const still = document.querySelector('.ed-wave-data-input');
    return { field: still === input, focused: document.activeElement === input, open: !!document.querySelector('.ed-wave-overlay') };
  });
  assert.deepStrictEqual(during, { field: true, focused: true, open: true }, 'Enter / Esc / Tab while composing leave the field alone');
  assert.deepStrictEqual((await laneNamed(page, 'bus')).data, ['D1', 'D2', 'D3'], 'nothing is written while composing');
  await page.evaluate(() => {
    document.querySelector('.ed-wave-data-input').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '組字' }));
  });
  await page.keyboard.press('Enter'); await wait(300);
  assert.deepStrictEqual((await laneNamed(page, 'bus')).data, ['D1', '組字', 'D3'], 'the Enter after composition commits');
}, { md: WAVE_DATA_MD });
check('wave draw: Del deletes cycles when cycles are selected', DESKTOP, async (page) => {
  await openWave(page);
  await selectRun(page, 1, 1, 3);
  await page.keyboard.press('Delete'); await wait(300);
  assert.strictEqual((await laneNamed(page, 'a')).wave, '001xz', 'Del removes the three selected cycles');
  assert.strictEqual((await laneNamed(page, 'clk')).wave.length, 5, 'from every lane');
  assert.strictEqual(await page.evaluate(() => document.querySelector('.ed-wave-overlay').getAttribute('data-wave-cycles')), '5');
  assert.strictEqual(await page.evaluate(() => document.activeElement.getAttribute('data-focus-key')), 'canvas', 'the keyboard stays on the canvas');
  // What is left selected is the one cycle at the cut; Del again removes just it.
  await page.keyboard.press('Delete'); await wait(300);
  assert.strictEqual((await laneNamed(page, 'a')).wave, '01xz', 'Del on a single selected cycle removes that cycle');
}, { md: WAVE_RANGE_MD });

// ── wave lanes (Task 8): managing signals from the name column (spec 4.4) ──
const WAVE_LANES_MD = waveMd([{ name: 'a', wave: '01..' }, { name: 'b', wave: '1.0.' },
  { name: 'c', wave: 'x=..', data: ['D'] }, { name: 'd', wave: '0...' }]);
const WAVE_GROUP_MD = waveMd([{ name: 'a', wave: '01..' },
  ['grp', { name: 'b', wave: '1.0.' }, { name: 'c', wave: '0.1.' }], { name: 'd', wave: '0...' }]);
/** The block's `signal` as it is written back right now, read with the codec's own
 *  reader: a patched source is relaxed WaveJSON (a removal can leave a trailing comma). */
async function signalNow(page) {
  const r = await page.evaluate(() => {
    const src = window.__edWaveSourceProbe();
    const parsed = window.__md2docWave['wave-codec.js'].parseSource(src);
    return parsed.ok ? { doc: JSON.parse(JSON.stringify(parsed.doc)) } : { src };
  });
  assert.ok(r.doc !== undefined, 'the block is written back as readable WaveJSON: ' + r.src);
  return r.doc.signal;
}
/** The block's `signal` as the editor shows it (the store's document), whether or not it can
 *  be written back. */
async function signalShown(page) {
  return JSON.parse(await page.evaluate(() => window.__edWaveDocProbe())).signal;
}
/** What the last gesture's write-back came to: 'ok', 'refused' or 'none'. */
const patchState = (page) => page.evaluate(() => document.querySelector('.ed-wave-overlay').getAttribute('data-wave-patch'));
/** The block's source exactly as it is written back right now. */
const sourceNow = (page) => page.evaluate(() => window.__edWaveSourceProbe());
/**
 * The gesture was written back (Task 8b, Ruling R15: group changes are local patches now):
 * the patch is 'ok' and no red card is on screen.
 */
async function expectWritten(page, what) {
  assert.strictEqual(await patchState(page), 'ok', what + ': the store writes it back');
  const card = await page.evaluate(() => {
    const c = document.querySelector('.ed-conflict[data-level="error"]');
    return c && c.getClientRects().length > 0 ? c.querySelector('.ed-msg-text').textContent : null;
  });
  assert.strictEqual(card, null, what + ': no red card');
  assert.deepStrictEqual(await signalNow(page), await signalShown(page),
    what + ': the written source says what the editor shows');
}
/** Every lane's name in display order (groups flattened, a spacer is '{}'). */
function namesOf(signal) {
  const out = [];
  (function walk(arr) {
    for (const x of arr) {
      if (Array.isArray(x)) walk(x.slice(typeof x[0] === 'string' ? 1 : 0));
      else if (x && typeof x === 'object') out.push(x.name === undefined && x.wave === undefined ? '{}' : x.name);
    }
  })(signal);
  return out;
}
/** The centre of lane `i`'s name as the ENGINE drew it, asserting that a press there lands on the layer. */
async function namePoint(page, i) {
  const p = await page.evaluate((i) => {
    const t = document.querySelector('.ed-wave-stage svg[id^="svgcontent"] g[id^="wavelane_' + i + '_"] > text');
    if (!t) return null;
    const r = t.getBoundingClientRect();
    const x = r.left + r.width / 2; const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const layer = document.querySelector('.ed-wave-overlay .ed-wave-layer');
    return { x, y, left: r.left, onLayer: !!(hit && layer && (hit === layer || layer.contains(hit))) };
  }, i);
  assert.ok(p !== null && p.onLayer, 'guard: lane ' + i + '\'s name is drawn and a press on it lands on the layer ' + JSON.stringify(p));
  return p;
}
/** The grip of lane `i` (or of the group, `sel`), as plain values. */
function gripOf(page, sel) {
  return page.evaluate((sel) => {
    const g = document.querySelector('.ed-wave-overlay ' + sel);
    if (!g) return null;
    const r = g.getBoundingClientRect();
    const x = r.left + r.width / 2; const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return { x, y, left: r.left, right: r.right, top: r.top, bottom: r.bottom,
      shown: getComputedStyle(g).opacity === '1', onTop: top === g || (!!top && g.contains(top)),
      key: g.getAttribute('data-focus-key') };
  }, sel);
}
/** Hover lane `i`'s name; its grip has to come up beside it and take a press. */
async function hoverLane(page, i) {
  const n = await namePoint(page, i);
  await page.mouse.move(n.x, n.y, { steps: 3 }); await wait(150);
  const g = await gripOf(page, '.ed-wave-grip[data-lane="' + i + '"]');
  assert.ok(g !== null && g.shown && g.onTop, 'hovering lane ' + i + '\'s name shows its grip on top ' + JSON.stringify(g));
  return { name: n, grip: g };
}
/** The open lane menu: its items' focus keys, labels, shortcut hints. */
function laneMenu(page) {
  return page.evaluate(() => {
    const m = document.querySelector('.ed-wave-overlay .ed-wave-lane-menu');
    if (!m) return null;
    const items = [...m.querySelectorAll('.ed-wave-menu-item')];
    return { keys: items.map((b) => b.getAttribute('data-focus-key')),
      labels: items.map((b) => (b.querySelector('.ed-wave-menu-label') || b).textContent),
      hints: items.map((b) => (b.querySelector('.ed-wave-menu-key') || { textContent: '' }).textContent) };
  });
}
/** Hover lane `i`, press its grip, and pick `key` from the menu. */
async function laneAction(page, i, key) {
  const h = await hoverLane(page, i);
  await page.mouse.move(h.grip.x, h.grip.y, { steps: 2 }); await page.mouse.click(h.grip.x, h.grip.y); await wait(200);
  assert.ok((await laneMenu(page)) !== null, 'guard: lane ' + i + '\'s menu is open');
  await page.locator('.ed-wave-lane-menu [data-focus-key="' + key + '"]').click(); await wait(300);
}
const LANE_MENU_KEYS = ['ed-wave-lane-rename', 'ed-wave-lane-copy', 'ed-wave-lane-add-below', 'ed-wave-lane-blank-below',
  'ed-wave-lane-up', 'ed-wave-lane-down', 'ed-wave-lane-group', 'ed-wave-lane-period', 'ed-wave-lane-delete'];
check('wave lanes: hover shows the grip and the menu lists every action', DESKTOP, async (page) => {
  await openWave(page);
  const hidden = await gripOf(page, '.ed-wave-grip[data-lane="1"]');
  assert.ok(hidden !== null && !hidden.shown, 'no grip shows before the pointer is over the row ' + JSON.stringify(hidden));
  const h = await hoverLane(page, 1);
  assert.ok(h.grip.right <= h.name.left + 1, 'the grip sits left of the name ' + JSON.stringify(h));
  assert.ok(Math.abs(h.grip.y - h.name.y) <= 3, 'the grip is level with the name ' + JSON.stringify(h));
  const row = await page.evaluate(() => {
    const r = document.querySelector('.ed-wave-overlay rect.ed-wave-row-hover');
    const cell = window.__edWaveCellRect(1, 0);
    const b = r ? r.getBoundingClientRect() : null;
    return { row: b && [b.top, b.height], want: [cell.top, cell.height],
      others: [0, 2, 3].map((i) => getComputedStyle(document.querySelector('.ed-wave-grip[data-lane="' + i + '"]')).opacity) };
  });
  assert.ok(Array.isArray(row.row) && Math.abs(row.row[0] - row.want[0]) <= 1 && Math.abs(row.row[1] - row.want[1]) <= 1,
    'the whole row is lit ' + JSON.stringify(row));
  assert.deepStrictEqual(row.others, ['0', '0', '0'], 'only the hovered row shows its grip');
  await page.mouse.move(h.grip.x, h.grip.y, { steps: 2 }); await wait(100);
  assert.ok((await gripOf(page, '.ed-wave-grip[data-lane="1"]')).shown, 'the grip stays up while the pointer is on it');
  await page.mouse.click(h.grip.x, h.grip.y); await wait(200);
  const m = await laneMenu(page);
  assert.ok(m !== null, 'pressing the grip opens its menu');
  assert.deepStrictEqual(m.keys, LANE_MENU_KEYS, 'the items, in spec 4.4 order');
  assert.deepStrictEqual(m.labels, ['改名', '建立副本', '在下方新增訊號', '在下方新增空白列', '上移', '下移',
    '和下一條組成群組', '週期與相位…', '刪除'], 'the item labels');
  assert.deepStrictEqual(m.hints, ['F2', 'Ctrl+D', '', '', 'Alt+↑', 'Alt+↓', '', '', 'Del'], 'the shortcut each item says');
  const red = await page.evaluate(() => ({
    del: getComputedStyle(document.querySelector('.ed-wave-lane-menu [data-focus-key="ed-wave-lane-delete"]')).color,
    other: getComputedStyle(document.querySelector('.ed-wave-lane-menu [data-focus-key="ed-wave-lane-copy"]')).color }));
  assert.strictEqual(red.del, 'rgb(207, 34, 46)', '刪除 is red ' + JSON.stringify(red));
  assert.notStrictEqual(red.other, red.del, 'the other items are not ' + JSON.stringify(red));
  // Esc closes the menu only; the keyboard goes back to the grip.
  await page.keyboard.press('Escape'); await wait(200);
  const after = await page.evaluate(() => ({ menu: !!document.querySelector('.ed-wave-lane-menu'),
    open: !!document.querySelector('.ed-wave-overlay'), focus: document.activeElement.getAttribute('data-focus-key') }));
  assert.deepStrictEqual(after, { menu: false, open: true, focus: 'grip-1' }, 'Esc closes the menu and not the editor');
}, { md: WAVE_LANES_MD });
check('wave lanes: drag the grip reorders lanes', DESKTOP, async (page) => {
  await openWave(page);
  const h = await hoverLane(page, 3);
  const row1 = await page.evaluate(() => window.__edWaveCellRect(1, 0));
  await page.mouse.move(h.grip.x, h.grip.y, { steps: 2 }); await page.mouse.down();
  await page.mouse.move(h.grip.x, row1.top + 3, { steps: 8 }); await wait(100);
  const line = await page.evaluate(() => {
    const l = document.querySelector('.ed-wave-overlay .ed-wave-drop-line');
    if (!l) return null;
    const r = l.getBoundingClientRect();
    return { y: r.top + r.height / 2, width: r.width };
  });
  assert.ok(line !== null, 'a drop line marks where the lane will land');
  assert.ok(Math.abs(line.y - row1.top) <= 2 && line.width > 100, 'it is on the top edge of row 1 ' + JSON.stringify({ line, row1 }));
  assert.deepStrictEqual(namesOf(await signalNow(page)), ['a', 'b', 'c', 'd'], 'nothing is written while dragging');
  await page.mouse.up(); await wait(300);
  assert.deepStrictEqual(namesOf(await signalNow(page)), ['a', 'd', 'b', 'c'], 'd lands above the second row');
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.ed-wave-drop-line').length), 0, 'the line goes on drop');
  // Dropping on the start position changes nothing.
  const before = await page.evaluate(() => document.querySelector('.ed-wave-overlay').getAttribute('data-wave-gestures'));
  const g = await hoverLane(page, 1);
  await page.mouse.move(g.grip.x, g.grip.y, { steps: 2 }); await page.mouse.down();
  await page.mouse.move(g.grip.x, g.grip.y + 9, { steps: 4 }); await page.mouse.up(); await wait(300);
  assert.deepStrictEqual(namesOf(await signalNow(page)), ['a', 'd', 'b', 'c'], 'a drop on the start position is a no-op');
  assert.strictEqual(await page.evaluate(() => document.querySelector('.ed-wave-overlay').getAttribute('data-wave-gestures')), before,
    'and costs no undo step');
}, { md: WAVE_LANES_MD });
check('wave lanes: F2 renames in place', DESKTOP, async (page) => {
  await openWave(page);
  const n = await namePoint(page, 1);
  await page.locator('.ed-wave-overlay [data-focus-key="grip-1"]').focus(); await wait(100);
  await page.keyboard.press('F2'); await wait(200);
  const field = await page.evaluate(([x, y]) => {
    const input = document.querySelector('.ed-wave-overlay .ed-wave-rename');
    if (!input) return null;
    const r = input.getBoundingClientRect();
    const st = document.querySelector('.ed-wave-stage').getBoundingClientRect();
    return { value: input.value, focused: document.activeElement === input, overName: document.elementFromPoint(x, y) === input,
      inStage: r.left >= st.left && r.right <= st.right };
  }, [n.x, n.y]);
  assert.deepStrictEqual(field, { value: 'b', focused: true, overName: true, inStage: true },
    'F2 opens a field over the name, holding it, all of it on screen');
  await page.keyboard.type('bus_ack'); await page.keyboard.press('Enter'); await wait(300);
  assert.deepStrictEqual(namesOf(await signalNow(page)), ['a', 'bus_ack', 'c', 'd'], 'Enter writes the name');
  const done = await page.evaluate(() => ({ fields: document.querySelectorAll('.ed-wave-rename').length,
    focus: document.activeElement.getAttribute('data-focus-key') }));
  assert.deepStrictEqual(done, { fields: 0, focus: 'grip-1' }, 'the field closes and the keyboard is on the signal\'s name');
  // A click on a name opens the same field; Esc cancels the field only.
  const a = await namePoint(page, 0);
  await page.mouse.click(a.x, a.y); await wait(200);
  assert.strictEqual(await page.evaluate(() => (document.querySelector('.ed-wave-rename') || {}).value), 'a', 'clicking a name opens its field');
  await page.keyboard.type('zz'); await page.keyboard.press('Escape'); await wait(200);
  const esc = await page.evaluate(() => ({ fields: document.querySelectorAll('.ed-wave-rename').length,
    open: !!document.querySelector('.ed-wave-overlay') }));
  assert.deepStrictEqual(esc, { fields: 0, open: true }, 'Esc closes the field and not the editor');
  assert.deepStrictEqual(namesOf(await signalNow(page)), ['a', 'bus_ack', 'c', 'd'], 'Esc wrote nothing');
  // F2 on the canvas renames the cursor's lane.
  const p = await cellPress(page, 2, 1);
  await page.mouse.click(p.x, p.y); await wait(200);
  await page.keyboard.press('F2'); await wait(200);
  assert.strictEqual(await page.evaluate(() => (document.querySelector('.ed-wave-rename') || {}).value), 'c', 'F2 on the canvas renames the cursor\'s lane');
}, { md: WAVE_LANES_MD });
check('wave lanes: IME composition does not commit the rename', DESKTOP, async (page) => {
  await openWave(page);
  await page.locator('.ed-wave-overlay [data-focus-key="grip-0"]').focus(); await wait(100);
  await page.keyboard.press('F2'); await wait(200);
  assert.strictEqual(await page.evaluate(() => (document.querySelector('.ed-wave-rename') || {}).value), 'a', 'guard: the rename field is open');
  const during = await page.evaluate(() => {
    const input = document.querySelector('.ed-wave-rename');
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    input.value = '時脈';
    for (const key of ['Enter', 'Escape', 'Tab']) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: true }));
    }
    const still = document.querySelector('.ed-wave-rename');
    return { field: still === input, focused: document.activeElement === input, open: !!document.querySelector('.ed-wave-overlay') };
  });
  assert.deepStrictEqual(during, { field: true, focused: true, open: true }, 'Enter / Esc / Tab while composing leave the field alone');
  assert.deepStrictEqual(namesOf(await signalNow(page)), ['a', 'b', 'c', 'd'], 'nothing is written while composing');
  await page.evaluate(() => {
    document.querySelector('.ed-wave-rename').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '時脈' }));
  });
  await page.keyboard.press('Enter'); await wait(300);
  assert.deepStrictEqual(namesOf(await signalNow(page)), ['時脈', 'b', 'c', 'd'], 'the Enter after composition commits');
}, { md: WAVE_LANES_MD });
check('wave lanes: menu actions', DESKTOP, async (page) => {
  await openWave(page);
  const base = await signalNow(page);
  const [a, b, c, d] = base;
  const undo = async () => {
    await page.keyboard.press('Control+z'); await wait(300);
    assert.deepStrictEqual(await signalNow(page), base, 'guard: undo restores');
  };
  await laneAction(page, 1, 'ed-wave-lane-copy');
  assert.deepStrictEqual(await signalNow(page), [a, b, b, c, d], '建立副本: a copy right below');
  await undo();
  await laneAction(page, 0, 'ed-wave-lane-add-below');
  // v3.17.1: a new signal spans the diagram (4 cycles here), not one cycle.
  assert.deepStrictEqual(await signalNow(page), [a, { name: '', wave: 'x...' }, b, c, d], '在下方新增訊號');
  await undo();
  await laneAction(page, 0, 'ed-wave-lane-blank-below');
  assert.deepStrictEqual(await signalNow(page), [a, {}, b, c, d], '在下方新增空白列');
  // A blank row has a grip and a menu too, without 改名.
  const h = await hoverLane(page, 1);
  await page.mouse.move(h.grip.x, h.grip.y, { steps: 2 }); await page.mouse.click(h.grip.x, h.grip.y); await wait(200);
  assert.deepStrictEqual((await laneMenu(page)).keys, LANE_MENU_KEYS.filter((k) => k !== 'ed-wave-lane-rename'),
    'a blank row\'s menu has everything but 改名');
  await page.keyboard.press('Escape'); await wait(150);
  await undo();
  await laneAction(page, 1, 'ed-wave-lane-up');
  assert.deepStrictEqual(await signalNow(page), [b, a, c, d], '上移');
  await undo();
  await laneAction(page, 1, 'ed-wave-lane-down');
  assert.deepStrictEqual(await signalNow(page), [a, c, b, d], '下移');
  await undo();
  // A new group is written back as a local patch: only the group's own syntax goes in,
  // so on this compact one-line source the written text is exactly the compact JSON of
  // the new document.
  await laneAction(page, 1, 'ed-wave-lane-group');
  assert.deepStrictEqual(await signalNow(page), [a, ['', b, c], d], '和下一條組成群組 is written back');
  await expectWritten(page, '和下一條組成群組');
  assert.strictEqual(await page.evaluate(() => (document.querySelector('.ed-wave-rename') || {}).value), '',
    'the new group\'s name field opens');
  await page.keyboard.type('grp'); await page.keyboard.press('Enter'); await wait(300);
  assert.deepStrictEqual(await signalNow(page), [a, ['grp', b, c], d], 'and names the group');
  await expectWritten(page, '和下一條組成群組 + 改名');
  assert.strictEqual(await sourceNow(page), JSON.stringify({ signal: [a, ['grp', b, c], d] }),
    '和下一條組成群組 + 改名: the written source adds only the group\'s own bytes');
  await page.keyboard.press('Control+z'); await wait(300);
  await undo();
  await laneAction(page, 1, 'ed-wave-lane-period');
  const pop = await page.evaluate(() => {
    const p = document.querySelector('.ed-wave-overlay .ed-wave-period-pop');
    return p ? { period: p.querySelector('[data-focus-key="ed-wave-lane-period-input"]').value,
      phase: p.querySelector('[data-focus-key="ed-wave-lane-phase-input"]').value,
      focus: document.activeElement.getAttribute('data-focus-key') } : null;
  });
  assert.deepStrictEqual(pop, { period: '', phase: '', focus: 'ed-wave-lane-period-input' }, '週期與相位… opens its fields');
  await page.keyboard.type('2'); await page.keyboard.press('Enter'); await wait(300);
  assert.deepStrictEqual(await signalNow(page), [a, Object.assign({}, b, { period: 2 }), c, d], 'period: 2, as a number');
  await page.keyboard.press('Escape'); await wait(150);
  assert.strictEqual(await page.evaluate(() => !!document.querySelector('.ed-wave-period-pop')), false, 'Esc closes the panel');
  await undo();
  await laneAction(page, 2, 'ed-wave-lane-delete');
  assert.deepStrictEqual(await signalNow(page), [a, b, d], '刪除');
  await undo();
}, { md: WAVE_LANES_MD });
// Final review I3 (Ruling R22 extended to every popover with text fields): what is typed in
// 週期與相位… is written when Esc or a press outside closes it — in BOTH engines. WebKit fires
// no `change` for a focused field taken out of the page, so before the fix it lost the text
// while Chromium wrote it.
check('wave lanes: 週期與相位 keeps typed text when Esc or an outside press closes it', DESKTOP, async (page) => {
  await openWave(page);
  const base = await signalNow(page);
  const [a, b, c, d] = base;
  const popOpen = () => page.evaluate(() => !!document.querySelector('.ed-wave-overlay .ed-wave-period-pop'));
  await laneAction(page, 1, 'ed-wave-lane-period');
  assert.strictEqual(await popOpen(), true, 'guard: 週期與相位… is open');
  await page.keyboard.type('2'); await wait(100);
  await page.keyboard.press('Escape'); await wait(300);
  assert.strictEqual(await popOpen(), false, 'Esc closes the panel');
  assert.deepStrictEqual(await signalNow(page), [a, Object.assign({}, b, { period: 2 }), c, d],
    'Esc keeps the typed period (written once, as a number)');
  await laneAction(page, 1, 'ed-wave-lane-period');
  await page.locator('[data-focus-key="ed-wave-lane-phase-input"]').click(); await wait(100);
  await page.keyboard.type('0.5'); await wait(100);
  const title = await page.locator('.ed-wave-overlay .ed-wave-title').boundingBox();
  await page.mouse.click(title.x + 5, title.y + 5); await wait(300);
  assert.strictEqual(await popOpen(), false, 'the outside press closes the panel');
  assert.deepStrictEqual(await signalNow(page), [a, Object.assign({}, b, { period: 2, phase: 0.5 }), c, d],
    'the outside press keeps the typed phase');
  // Two gestures, one store step each: the close wrote once, not once per close path.
  await page.locator('.ed-wave-overlay .ed-wave-layer').focus();
  await page.keyboard.press('Control+z'); await wait(300);
  assert.deepStrictEqual(await signalNow(page), [a, Object.assign({}, b, { period: 2 }), c, d], 'one undo takes the phase back');
  await page.keyboard.press('Control+z'); await wait(300);
  assert.deepStrictEqual(await signalNow(page), base, 'a second undo takes the period back');
  // Mid-composition the field's text is the IME's, not a value: the close does not write it.
  await laneAction(page, 1, 'ed-wave-lane-period');
  await page.evaluate(() => {
    document.querySelector('[data-focus-key="ed-wave-lane-period-input"]')
      .dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
  });
  await page.keyboard.type('7'); await wait(100);
  await page.mouse.click(title.x + 5, title.y + 5); await wait(300);
  assert.strictEqual(await popOpen(), false, 'guard: the outside press closes the panel');
  assert.deepStrictEqual(await signalNow(page), base, 'nothing typed mid-composition is written by the close');
}, { md: WAVE_LANES_MD });
check('wave lanes: 和下一條組成群組 then 下移 are both written back', DESKTOP, async (page) => {
  // Ruling R16: the editor keeps one store for the session, and each landed write-back
  // becomes its new base, so a second structural gesture is planned on its own instead of
  // together with the first (which used to refuse every two-step group flow).
  await openWave(page);
  const [a, b, c, d] = await signalNow(page);
  const J = JSON.stringify;
  await laneAction(page, 1, 'ed-wave-lane-group');
  await expectWritten(page, '和下一條組成群組');
  await page.keyboard.type('grp'); await page.keyboard.press('Enter'); await wait(300);
  await expectWritten(page, '改名');
  assert.strictEqual(await sourceNow(page), J({ signal: [a, ['grp', b, c], d] }), 'the group and its name are in the source');
  await page.locator('.ed-wave-overlay [data-focus-key="group-grip-signal.1"]').focus(); await wait(100);
  await page.keyboard.press('Alt+ArrowDown'); await wait(300);
  await expectWritten(page, '下移');
  assert.deepStrictEqual(await signalNow(page), [a, d, ['grp', b, c]], '下移 is written back after the group was');
  // The move carries the group's own bytes, comma and all (a legal trailing comma).
  assert.strictEqual(await sourceNow(page),
    '{"signal":[' + J(a) + ',' + J(d) + ', ["grp",' + J(b) + ',' + J(c) + '],]}', 'the written source');
  // Undo is the one reverse gesture against the new base, and it lands too.
  await page.keyboard.press('Control+z'); await wait(300);
  await expectWritten(page, 'undo 下移');
  assert.deepStrictEqual(await signalNow(page), [a, ['grp', b, c], d], 'undo puts the group back');
}, { md: WAVE_LANES_MD });
check('wave lanes: Del deletes the signal whose name has the keyboard', DESKTOP, async (page) => {
  await openWave(page);
  const [a, b, c, d] = await signalNow(page);
  await page.locator('.ed-wave-overlay [data-focus-key="grip-1"]').focus(); await wait(100);
  await page.keyboard.press('Delete'); await wait(300);
  assert.deepStrictEqual(await signalNow(page), [a, c, d], 'Del on a focused name deletes that signal');
  assert.strictEqual(await page.evaluate(() => document.activeElement.getAttribute('data-focus-key')), 'grip-1',
    'the keyboard lands on the name that took its place');
  // With the menu open, Del means the same signal.
  const h = await hoverLane(page, 2);
  await page.mouse.move(h.grip.x, h.grip.y, { steps: 2 }); await page.mouse.click(h.grip.x, h.grip.y); await wait(200);
  assert.ok((await laneMenu(page)) !== null, 'guard: the menu is open');
  await page.keyboard.press('Delete'); await wait(300);
  assert.deepStrictEqual(await signalNow(page), [a, c], 'Del with the menu open deletes the menu\'s signal');
  assert.strictEqual(await laneMenu(page), null, 'and the menu goes');
}, { md: WAVE_LANES_MD });
check('wave lanes: group row menu renames and ungroups', DESKTOP, async (page) => {
  await openWave(page);
  const base = await signalNow(page);
  // The group title as the engine drew it, rotated beside its rows.
  const t = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.ed-wave-stage svg[id^="svgcontent"] g[id^="groups_"] text')]
      .find((x) => x.textContent === 'grp');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2; const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const layer = document.querySelector('.ed-wave-overlay .ed-wave-layer');
    return { x, y, onLayer: !!(hit && layer && (hit === layer || layer.contains(hit))) };
  });
  assert.ok(t !== null && t.onLayer, 'guard: the engine draws the title and a press on it lands on the layer ' + JSON.stringify(t));
  const openGroupMenu = async () => {
    await page.mouse.move(t.x, t.y, { steps: 3 }); await wait(150);
    const g = await gripOf(page, '.ed-wave-grip[data-group]');
    assert.ok(g !== null && g.shown && g.onTop, 'hovering the group title shows the group\'s grip ' + JSON.stringify(g));
    await page.mouse.move(g.x, g.y, { steps: 2 }); await page.mouse.click(g.x, g.y); await wait(200);
    const m = await laneMenu(page);
    assert.ok(m !== null, 'the group grip opens a menu');
    return m;
  };
  const m = await openGroupMenu();
  assert.deepStrictEqual(m.keys, ['ed-wave-lane-rename', 'ed-wave-lane-ungroup', 'ed-wave-lane-up', 'ed-wave-lane-down'], 'the group items');
  assert.deepStrictEqual(m.labels, ['改名', '解散群組', '上移', '下移']);
  const lit = await page.evaluate(() => {
    const r = document.querySelector('.ed-wave-overlay rect.ed-wave-row-hover');
    const b1 = window.__edWaveCellRect(1, 0); const b2 = window.__edWaveCellRect(2, 0);
    const b = r ? r.getBoundingClientRect() : null;
    return { row: b && [b.top, b.bottom], want: [b1.top, b2.top + b2.height] };
  });
  assert.ok(Array.isArray(lit.row) && Math.abs(lit.row[0] - lit.want[0]) <= 1 && Math.abs(lit.row[1] - lit.want[1]) <= 1,
    'the group\'s rows are lit ' + JSON.stringify(lit));
  await page.locator('.ed-wave-lane-menu [data-focus-key="ed-wave-lane-rename"]').click(); await wait(200);
  assert.strictEqual(await page.evaluate(() => (document.querySelector('.ed-wave-rename') || {}).value), 'grp', '改名 opens the title\'s field');
  await page.keyboard.type('bus'); await page.keyboard.press('Enter'); await wait(300);
  const renamed = await signalNow(page);
  assert.deepStrictEqual(renamed, [base[0], ['bus', base[1][1], base[1][2]], base[2]], '改名 writes the title');
  await page.keyboard.press('Control+z'); await wait(300);
  await openGroupMenu();
  await page.locator('.ed-wave-lane-menu [data-focus-key="ed-wave-lane-ungroup"]').click(); await wait(300);
  assert.deepStrictEqual(await signalNow(page), [base[0], base[1][1], base[1][2], base[2]], '解散群組 keeps the lanes, drops the group');
  await expectWritten(page, '解散群組');
  assert.strictEqual(await sourceNow(page), JSON.stringify({ signal: [base[0], base[1][1], base[1][2], base[2]] }),
    '解散群組: the written source loses only the group\'s own bytes');
  await page.keyboard.press('Control+z'); await wait(300);
  await openGroupMenu();
  await page.locator('.ed-wave-lane-menu [data-focus-key="ed-wave-lane-up"]').click(); await wait(300);
  assert.deepStrictEqual(await signalNow(page), [base[1], base[0], base[2]], '上移 swaps the group with the lane above it');
  await page.keyboard.press('Control+z'); await wait(300);
  assert.deepStrictEqual(await signalNow(page), base, 'guard: undo restores');
  // 下移: the group trades places with the lane below it, written back as one move of the
  // whole group (Task 8b).
  await openGroupMenu();
  await page.locator('.ed-wave-lane-menu [data-focus-key="ed-wave-lane-down"]').click(); await wait(300);
  assert.deepStrictEqual(await signalNow(page), [base[0], base[2], base[1]], '下移 swaps the group with the lane below it');
  await expectWritten(page, '群組下移');
}, { md: WAVE_GROUP_MD });
check('wave lanes: Alt+arrows on a group grip move the group', DESKTOP, async (page) => {
  await openWave(page);
  const base = await signalNow(page);
  // A canvas selection on d: a fall-through to the canvas's own Alt+↑ would move d.
  const p = await cellPress(page, 3, 0);
  await page.mouse.click(p.x, p.y); await wait(200);
  const before = await signalNow(page);
  await page.locator('.ed-wave-overlay [data-focus-key="group-grip-signal.1"]').focus(); await wait(100);
  await page.keyboard.press('Alt+ArrowUp'); await wait(300);
  assert.deepStrictEqual(await signalNow(page), [before[1], before[0], before[2]], 'Alt+↑ on the group grip moves the group, not the selected lane');
  assert.strictEqual(await page.evaluate(() => document.activeElement.getAttribute('data-focus-key')), 'group-grip-signal.0',
    'the keyboard follows the group');
  // From the group's menu, Alt+↓ moves it back (which is the document as written).
  await page.keyboard.press('Enter'); await wait(200);
  assert.ok((await laneMenu(page)) !== null, 'guard: Enter on the grip opens its menu');
  await page.keyboard.press('Alt+ArrowDown'); await wait(300);
  assert.deepStrictEqual(await signalNow(page), before, 'Alt+↓ with the group menu open moves the group down, written back');
  await expectWritten(page, 'Alt+↓ on the group');
  assert.strictEqual(await laneMenu(page), null, 'and the menu goes');
  assert.strictEqual(base[0].wave, '01..', 'guard: fixture');
}, { md: WAVE_GROUP_MD });
check('wave lanes: Ctrl+D inside a text field is claimed and copies nothing', DESKTOP, async (page) => {
  await openWave(page);
  const base = await signalNow(page);
  const ctrlD = () => page.evaluate(() => {
    const ev = new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented, on: document.activeElement.className };
  });
  await page.locator('.ed-wave-overlay [data-focus-key="grip-0"]').focus(); await wait(100);
  await page.keyboard.press('F2'); await wait(200);
  const inName = await ctrlD();
  assert.deepStrictEqual(inName, { prevented: true, on: 'ed-wave-rename' }, 'Ctrl+D in the name field: the browser does not get it');
  await page.keyboard.press('Escape'); await wait(200);
  // The data-label field of c (lane 2, cycle 1), from the keyboard.
  await page.locator('.ed-wave-overlay .ed-wave-layer').focus(); await wait(100);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter'); await wait(200);
  const inData = await ctrlD();
  assert.deepStrictEqual(inData, { prevented: true, on: 'ed-wave-data-input' }, 'Ctrl+D in the data-label field: the browser does not get it');
  await page.keyboard.press('Escape'); await wait(200);
  assert.deepStrictEqual(await signalNow(page), base, 'and no lane was copied');
}, { md: WAVE_LANES_MD });
check('wave lanes: add lane button', DESKTOP, async (page) => {
  await openWave(page);
  const b = await page.evaluate(() => {
    const btn = document.querySelector('.ed-wave-overlay button.ed-wave-add-lane');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    const last = window.__edWaveCellRect(3, 0);
    const x = r.left + r.width / 2; const y = r.top + r.height / 2;
    return { text: btn.textContent, x, y, top: r.top, lastBottom: last.top + last.height,
      nameCol: document.querySelector('.ed-wave-stage svg[id^="svgcontent"]').getBoundingClientRect().left,
      left: r.left, onTop: document.elementFromPoint(x, y) === btn };
  });
  assert.ok(b !== null, 'there is a 新增訊號 row');
  assert.strictEqual(b.text, '＋ 新增訊號');
  assert.ok(b.top >= b.lastBottom - 1, 'it sits under the last row ' + JSON.stringify(b));
  assert.ok(Math.abs(b.left - b.nameCol) <= 12, 'at the name column ' + JSON.stringify(b));
  assert.ok(b.onTop, 'and takes a press');
  const base = await signalNow(page);
  await page.mouse.click(b.x, b.y); await wait(300);
  assert.deepStrictEqual(await signalNow(page), base.concat([{ name: '', wave: 'x...' }]), 'a new signal at the end, as long as the diagram');
  assert.strictEqual(await page.evaluate(() => document.querySelector('.ed-wave-overlay').getAttribute('data-wave-lanes')), '5');
}, { md: WAVE_LANES_MD });
// User report (2026-10-28): after 新增訊號 the new lane had a signal on its
// first cycle only, and no click on the blank cycles after it changed them.
// Two halves: the new signal now spans the diagram, and painting past the end
// of any shorter lane grows it (the codec used to refuse those cells).
check('wave lanes: a new signal spans the diagram and takes a paint anywhere', DESKTOP, async (page) => {
  await openWave(page);
  await page.locator('.ed-wave-overlay button.ed-wave-add-lane').click(); await wait(300);
  assert.deepStrictEqual((await signalNow(page))[4], { name: '', wave: 'x...' }, 'the new signal is lane 4, four cycles of x');
  await page.locator('[data-focus-key="brush-1"]').click(); await wait(100);
  const p = await cellPress(page, 4, 2);
  await page.mouse.click(p.x, p.y); await wait(300);
  assert.strictEqual((await signalNow(page))[4].wave, 'x.1x', 'cycle 2 of the new signal painted 1');
}, { md: WAVE_LANES_MD });
check('wave draw: painting past a short lane\'s end grows the lane', DESKTOP, async (page) => {
  await openWave(page);
  await page.locator('[data-focus-key="brush-1"]').click(); await wait(100);
  const p = await cellPress(page, 1, 3);
  await page.mouse.click(p.x, p.y); await wait(300);
  assert.strictEqual((await laneNamed(page, 'b')).wave, '0..1', 'a click on cycle 3 of the one-cycle lane b');
  // The keyboard paints through the same codec call: lane c, cycle 4.
  await page.locator('.ed-wave-overlay .ed-wave-layer').focus(); await wait(100);
  await page.keyboard.press('ArrowDown');
  for (let i = 0; i < 1; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('0'); await wait(300);
  assert.strictEqual((await laneNamed(page, 'c')).wave, '10..0', 'the key 0 on cycle 4 of the two-cycle lane c');
}, { md: waveMd([{ name: 'a', wave: '01...' }, { name: 'b', wave: '0' }, { name: 'c', wave: '10' }]) });

// ── wave edges (Task 9): edges and point notes on the engine canvas (spec 4.5) ──
const waveDoc = (doc) => '# W\n\n\x60\x60\x60wavedrom\n' + JSON.stringify(doc) + '\n\x60\x60\x60\n\nTail.\n';
// Transitions: clk [0], a [0, 2, 4], b [0, 1, 4]. Lane a already carries a
// hand-written lowercase anchor `a` on cell 0.
const WAVE_EDGES_MD = waveDoc({ signal: [{ name: 'clk', wave: 'p.....' },
  { name: 'a', wave: '0.1.0.', node: 'a' }, { name: 'b', wave: '01..0.' }] });
// One existing edge, a (lane a cell 2) to b (lane b cell 4), labelled.
const WAVE_EDGE_SEL_MD = waveDoc({ signal: [{ name: 'clk', wave: 'p.....' },
  { name: 'a', wave: '0.1.0.', node: '..a' }, { name: 'b', wave: '01..0.', node: '....b' }], edge: ['a~>b lbl'] });
/** The block's document as it is written back right now (the codec's reader). */
async function docNow(page) {
  const r = await page.evaluate(() => {
    const p = window.__md2docWave['wave-codec.js'].parseSource(window.__edWaveSourceProbe());
    return p.ok ? JSON.stringify(p.doc) : null;
  });
  assert.ok(r !== null, 'the block reads back as WaveJSON');
  return JSON.parse(r);
}
const edgesNow = async (page) => (await docNow(page)).edge || [];
const laneNow = async (page, name) => (await docNow(page)).signal.find((l) => l && l.name === name);
const nodeOf = async (page, name) => (await laneNow(page, name)).node;
const overlayAttr = (page, k) => page.evaluate((k) => document.querySelector('.ed-wave-overlay').getAttribute(k), k);
/** Anchor (lane, cell) in client px, from the canvas's own geometry. */
async function anchorPoint(page, lane, cell) {
  const a = await page.evaluate(([l, c]) => (typeof window.__edWaveAnchorPoint === 'function'
    ? window.__edWaveAnchorPoint(l, c) : null), [lane, cell]);
  assert.ok(a !== null, 'guard: anchor ' + lane + ',' + cell + ' has a point on screen');
  return a;
}
/** What a press at (x, y) would hit: the dot's "lane,cell", an edge hit's index, or the layer. */
function hitAt(page, x, y) {
  return page.evaluate(([x, y]) => {
    const t = document.elementFromPoint(x, y);
    if (!t || !t.closest) return null;
    const dot = t.closest('.ed-wave-dot');
    if (dot) return 'dot:' + dot.getAttribute('data-lane') + ',' + dot.getAttribute('data-cell');
    const end = t.closest('.ed-wave-edge-end-hit, .ed-wave-edge-end');
    if (end) return 'end:' + end.getAttribute('data-end');
    const e = t.closest('.ed-wave-edge-hit');
    if (e) return 'edge:' + e.getAttribute('data-edge-index');
    return t.closest('.ed-wave-layer') ? 'layer' : 'other';
  }, [x, y]);
}
/** Hover the anchor of (lane, cell): a transition shows its dot there, and a press hits it. */
async function hoverDot(page, lane, cell) {
  const a = await anchorPoint(page, lane, cell);
  await page.mouse.move(a.x, a.y, { steps: 3 }); await wait(150);
  assert.strictEqual(await hitAt(page, a.x, a.y), 'dot:' + lane + ',' + cell,
    'hovering the transition at ' + lane + ',' + cell + ' brings up its dot and a press there hits it');
  return a;
}
/** Press the dot at (lane, cell) and drag to client point `to`, releasing there. */
async function dragFromDot(page, lane, cell, to) {
  await hoverDot(page, lane, cell);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 }); await wait(120);
  const mid = await page.evaluate(() => ({ dots: document.querySelectorAll('.ed-wave-overlay .ed-wave-dot').length,
    pending: !!document.querySelector('.ed-wave-overlay .ed-wave-pending') }));
  await page.mouse.up(); await wait(300);
  return mid;
}
/** The inline edge-label / note field, as plain values. */
function edgeField(page) {
  return page.evaluate(() => {
    const f = document.querySelector('.ed-wave-overlay .ed-wave-edge-input');
    return f ? { kind: f.getAttribute('data-kind'), value: f.value, focused: document.activeElement === f } : null;
  });
}
/** The floating edge / note toolbar, as plain values. */
function edgeBar(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('.ed-wave-overlay .ed-wave-edge-bar');
    if (!bar || bar.getClientRects().length === 0) return null;
    const r = bar.getBoundingClientRect();
    return { keys: [...bar.querySelectorAll(':scope > [data-focus-key], :scope > .ed-wave-edge-group > [data-focus-key]')]
      .map((b) => b.getAttribute('data-focus-key')),
    pressed: [...bar.querySelectorAll('[aria-pressed="true"]')].map((b) => b.getAttribute('data-focus-key')),
    left: r.left, top: r.top, bottom: r.bottom };
  });
}
/** The centre of the engine's label box for edge `a~>b` (the g right after its path). */
function engineLabelBox(page, id) {
  return page.evaluate((id) => {
    const path = document.querySelector('.ed-wave-stage svg[id^="svgcontent"] path[id="' + id + '"]');
    const g = path && path.nextElementSibling;
    const rect = g && g.querySelector('rect');
    if (!rect) return null;
    const r = rect.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, right: r.right, top: r.top, bottom: r.bottom };
  }, id);
}
/** Click the label of edge `id` and assert that selects edge `index`. */
async function selectEdgeByLabel(page, id, index) {
  const box = await engineLabelBox(page, id);
  assert.ok(box !== null, 'guard: the engine drew the label of ' + id);
  await page.mouse.move(box.x, box.y, { steps: 2 }); await wait(100);
  assert.strictEqual(await hitAt(page, box.x, box.y), 'edge:' + index, 'a press on the label hits the edge');
  await page.mouse.click(box.x, box.y); await wait(250);
  assert.strictEqual(await overlayAttr(page, 'data-wave-selected-edge'), String(index), 'the press selects it');
  return box;
}
check('wave edges: drag from a dot creates a curve and opens the label', DESKTOP, async (page) => {
  await openWave(page);
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.ed-wave-overlay .ed-wave-dot').length), 0,
    'guard: no dot before the pointer is near a transition');
  const to = await anchorPoint(page, 2, 4);
  const mid = await dragFromDot(page, 1, 2, to);
  assert.ok(mid.dots > 3, 'while dragging every transition shows its dot ' + JSON.stringify(mid));
  assert.strictEqual(mid.pending, true, 'and a line follows the drag');
  assert.deepStrictEqual(await edgesNow(page), ['A~>B'], 'one new curve with an arrow, default ~>');
  assert.strictEqual(await nodeOf(page, 'a'), 'a.A', 'the start anchor on lane a cell 2');
  assert.strictEqual(await nodeOf(page, 'b'), '....B', 'the end anchor on lane b cell 4');
  const f = await edgeField(page);
  assert.deepStrictEqual(f, { kind: 'label', value: '', focused: true }, 'the label field opens with the keyboard in it');
  await page.keyboard.type('setup'); await page.keyboard.press('Enter'); await wait(300);
  assert.deepStrictEqual(await edgesNow(page), ['A~>B setup'], 'Enter writes the label');
  assert.strictEqual(await edgeField(page), null, 'the field closes');
}, { md: WAVE_EDGES_MD });
check('wave edges: Esc in the new label removes the edge, Ctrl+Y brings it back', DESKTOP, async (page) => {
  await openWave(page);
  await dragFromDot(page, 1, 2, await anchorPoint(page, 2, 4));
  assert.deepStrictEqual(await edgesNow(page), ['A~>B'], 'guard: the edge is in the document');
  assert.ok((await edgeField(page)) !== null, 'guard: its label field is open');
  await page.keyboard.press('Escape'); await wait(300);
  assert.deepStrictEqual(await edgesNow(page), [], 'Esc takes the new edge back off');
  assert.strictEqual(await nodeOf(page, 'a'), 'a', 'and its anchors; the old lowercase one stays');
  assert.strictEqual(await edgeField(page), null, 'the field is gone');
  assert.strictEqual(!!(await page.$('.ed-wave-overlay')), true, 'the editor stays open');
  await page.keyboard.press('Control+y'); await wait(300);
  assert.deepStrictEqual(await edgesNow(page), ['A~>B'], 'Ctrl+Y brings the edge back');
}, { md: WAVE_EDGES_MD });
check('wave edges: drop off any dot lands on that cycle start', DESKTOP, async (page) => {
  await openWave(page);
  // Lane b cycle 2 is a continuation (01..0.): no dot there.
  const c = await page.evaluate(() => window.__edWaveCellPoint(2, 2));
  await hoverDot(page, 1, 2);
  await page.mouse.down();
  await page.mouse.move(c.x, c.y, { steps: 8 }); await wait(120);
  assert.strictEqual(await hitAt(page, c.x, c.y), 'layer', 'guard: the drop point is off every dot');
  await page.mouse.up(); await wait(300);
  assert.deepStrictEqual(await edgesNow(page), ['A~>B']);
  assert.strictEqual(await nodeOf(page, 'b'), '..B', 'the end lands on the start of the cycle under the pointer');
}, { md: WAVE_EDGES_MD });
check('wave edges: a click on a dot selects that cycle and draws nothing', DESKTOP, async (page) => {
  await openWave(page);
  const a = await hoverDot(page, 2, 4);
  await page.mouse.down(); await page.mouse.up(); await wait(300);
  assert.deepStrictEqual(await edgesNow(page), [], 'no edge');
  assert.strictEqual(await edgeField(page), null, 'no field');
  assert.strictEqual(await overlayAttr(page, 'data-wave-cursor'), '2,4', 'the dot\'s cycle is selected');
  assert.strictEqual((await laneNow(page, 'b')).wave, '01..0.', 'and nothing was painted');
  // Dropped back on its own start: the same, a cancel.
  await page.mouse.down(); await page.mouse.move(a.x + 3, a.y + 2, { steps: 3 }); await page.mouse.up(); await wait(300);
  assert.deepStrictEqual(await edgesNow(page), [], 'a drop back on the start draws nothing');
}, { md: WAVE_EDGES_MD });
// Final review I2 (spec 4.5「選一拍後浮動工具列」): a cycle selected WITHOUT painting — a click on
// a transition dot (Ruling R19) — raises the range toolbar for that one cycle, so a mouse can add
// a note or start an edge there without changing the waveform. A click that paints keeps having
// no toolbar ('wave draw: click paints one cycle and selects it').
check('wave edges: a dot click raises the range toolbar for that cycle, and 標註 there paints nothing', DESKTOP, async (page) => {
  await openWave(page);
  const dotClick = async () => {
    await hoverDot(page, 2, 4);
    await page.mouse.down(); await page.mouse.up(); await wait(300);
    assert.strictEqual(await overlayAttr(page, 'data-wave-cursor'), '2,4', 'guard: the dot\'s cycle is selected');
  };
  await dotClick();
  const bar = await rangeBar(page);
  assert.ok(bar !== null, 'the dot click raises the range toolbar');
  assert.ok(bar.keys.includes('ed-wave-range-edge') && bar.keys.includes('ed-wave-range-note'),
    'with its 關聯線 and 標註 ' + JSON.stringify(bar.keys));
  assert.ok(bar.deleteText.includes('1'), 'for one cycle: ' + bar.deleteText);
  sameRect(await selectionVs(page, 2, 4, 4), 'the selection is that one cycle');
  // 關聯線 from there picks an end, starting on the dot's cycle.
  await page.locator('[data-focus-key="ed-wave-range-edge"]').click(); await wait(150);
  assert.strictEqual(await overlayAttr(page, 'data-wave-edgemode'), 'picking', '關聯線 starts an edge');
  assert.strictEqual(await overlayAttr(page, 'data-wave-edge-pending'), '2,4', 'from the dot\'s cycle');
  await page.keyboard.press('Escape'); await wait(150);
  assert.strictEqual(await overlayAttr(page, 'data-wave-edgemode'), 'idle', 'guard: Esc drops the pick');
  // Esc peels the toolbar before it would close the editor.
  await dotClick();
  assert.ok((await rangeBar(page)) !== null, 'guard: the toolbar is up again');
  await page.locator('.ed-wave-overlay .ed-wave-layer').focus();
  await page.keyboard.press('Escape'); await wait(200);
  assert.strictEqual(await rangeBar(page), null, 'Esc takes the one-cycle toolbar down');
  assert.strictEqual(await page.evaluate(() => !!document.querySelector('.ed-wave-overlay')), true, 'and leaves the editor open');
  // 標註 opens the note field at that cell; the note is written, the wave is not.
  await dotClick();
  await page.locator('[data-focus-key="ed-wave-range-note"]').click(); await wait(150);
  assert.deepStrictEqual(await edgeField(page), { kind: 'note', value: '', focused: true }, '標註 opens the note field');
  await page.keyboard.type('note'); await page.keyboard.press('Enter'); await wait(300);
  assert.deepStrictEqual(await edgesNow(page), ['A note'], 'a point note');
  assert.strictEqual(await nodeOf(page, 'b'), '....A', 'anchored on lane b cycle 4, the dot\'s cycle');
  assert.strictEqual((await laneNow(page, 'b')).wave, '01..0.', 'and nothing was painted');
  // A click that paints still raises no toolbar for its one cycle.
  await page.locator('[data-focus-key="brush-1"]').click(); await wait(100);
  const p = await cellPress(page, 1, 1);
  await page.mouse.click(p.x, p.y); await wait(300);
  assert.strictEqual((await laneNow(page, 'a')).wave, '011.0.', 'guard: the click painted cycle 1');
  assert.strictEqual(await rangeBar(page), null, 'a painted cycle has no toolbar');
}, { md: WAVE_EDGES_MD });
check('wave edges: press inside a cell still paints', DESKTOP, async (page) => {
  await openWave(page);
  await page.locator('[data-focus-key="brush-x"]').click(); await wait(100);
  const p = await page.evaluate(() => window.__edWaveCellPoint(2, 2));
  const q = await page.evaluate(() => window.__edWaveCellPoint(2, 3));
  await page.mouse.move(p.x, p.y, { steps: 3 }); await wait(120);
  assert.strictEqual(await hitAt(page, p.x, p.y), 'layer', 'guard: the press is outside every dot\'s ring');
  await page.mouse.down(); await page.mouse.move(q.x, q.y, { steps: 5 }); await page.mouse.up(); await wait(300);
  assert.strictEqual((await laneNow(page, 'b')).wave, '01x.0.', 'the drag paints cycles 2-3');
  assert.deepStrictEqual(await edgesNow(page), [], 'and draws no edge');
}, { md: WAVE_EDGES_MD });
check('wave edges: toolbar line x head buttons map to the nine shapes', DESKTOP, async (page) => {
  await openWave(page);
  // Selected by its LINE (the 6a regression): a point a quarter of the way along the engine's path.
  const p = await page.evaluate(() => {
    const path = document.querySelector('.ed-wave-stage svg[id^="svgcontent"] path[id="gmark_a_b"]');
    const q = path.getPointAtLength(path.getTotalLength() * 0.25);
    const m = path.getScreenCTM();
    return { x: m.a * q.x + m.c * q.y + m.e, y: m.b * q.x + m.d * q.y + m.f };
  });
  await page.mouse.move(p.x, p.y, { steps: 2 }); await wait(100);
  assert.strictEqual(await hitAt(page, p.x, p.y), 'edge:0', 'guard: a press on the line hits the edge');
  await page.mouse.click(p.x, p.y); await wait(250);
  assert.strictEqual(await overlayAttr(page, 'data-wave-selected-edge'), '0', 'a press on the line selects the edge');
  const bar = await edgeBar(page);
  assert.ok(bar !== null, 'the edge toolbar floats up');
  assert.deepStrictEqual(bar.keys, ['ed-wave-edge-line-straight', 'ed-wave-edge-line-curve', 'ed-wave-edge-line-elbow',
    'ed-wave-edge-head-none', 'ed-wave-edge-head-end', 'ed-wave-edge-head-both',
    'ed-wave-edge-more', 'ed-wave-edge-label', 'ed-wave-edge-delete'], 'line x head, more, label, delete (spec 4.5)');
  assert.deepStrictEqual(bar.pressed, ['ed-wave-edge-line-curve', 'ed-wave-edge-head-end'], '~> reads as curve + one arrow');
  const label = await engineLabelBox(page, 'gmark_a_b');
  assert.ok(bar.left >= label.right - 1, 'the toolbar sits right of the label ' + JSON.stringify({ bar, label }));
  const steps = [['line-straight', 'head-none', '-'], [null, 'head-end', '->'], [null, 'head-both', '<->'],
    ['line-curve', null, '<~>'], [null, 'head-none', '~'], [null, 'head-end', '~>'],
    ['line-elbow', null, '-|>'], [null, 'head-none', '-|'], [null, 'head-both', '<-|>']];
  const seen = new Set();
  for (const [line, head, shape] of steps) {
    if (line) { await page.locator('.ed-wave-edge-bar [data-focus-key="ed-wave-edge-' + line + '"]').click(); await wait(200); }
    if (head) { await page.locator('.ed-wave-edge-bar [data-focus-key="ed-wave-edge-' + head + '"]').click(); await wait(200); }
    assert.deepStrictEqual(await edgesNow(page), ['a' + shape + 'b lbl'], (line || '') + ' ' + (head || '') + ' gives ' + shape);
    seen.add(shape);
  }
  assert.strictEqual(seen.size, 9, 'all nine line x head shapes');
  await page.locator('.ed-wave-edge-bar [data-focus-key="ed-wave-edge-more"]').click(); await wait(150);
  const more = await page.evaluate(() => [...document.querySelectorAll('.ed-wave-overlay .ed-wave-edge-more-list [data-shape]')]
    .map((b) => b.getAttribute('data-shape')));
  assert.deepStrictEqual(more.slice().sort(), ['+', '-|-', '-|->', '-~', '-~>', '<-|->', '<-~>', '|-', '|->', '~-', '~->'].sort(),
    '更多 lists the other eleven shapes');
  await page.locator('.ed-wave-edge-more-list [data-shape="-|-"]').click(); await wait(250);
  assert.deepStrictEqual(await edgesNow(page), ['a-|-b lbl'], 'a shape from 更多');
}, { md: WAVE_EDGE_SEL_MD });
check('wave edges: drag an end moves it', DESKTOP, async (page) => {
  await openWave(page);
  await selectEdgeByLabel(page, 'gmark_a_b', 0);
  const end = await page.evaluate(() => {
    const c = document.querySelector('.ed-wave-overlay .ed-wave-edge-end[data-end="to"]');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  assert.ok(end !== null, 'the selected edge shows its end handles');
  await page.mouse.move(end.x, end.y, { steps: 2 }); await wait(100);
  assert.strictEqual(await hitAt(page, end.x, end.y), 'end:to', 'guard: a press there takes the end');
  const to = await anchorPoint(page, 2, 1);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 }); await wait(120);
  const dots = await page.evaluate(() => document.querySelectorAll('.ed-wave-overlay .ed-wave-dot').length);
  assert.ok(dots > 3, 'dragging an end shows every dot: ' + dots);
  assert.deepStrictEqual(await edgesNow(page), ['a~>b lbl'], 'nothing is written mid-drag');
  await page.mouse.up(); await wait(300);
  assert.deepStrictEqual(await edgesNow(page), ['a~>b lbl'], 'the entry keeps its letters');
  assert.strictEqual(await nodeOf(page, 'b'), '.b', 'the anchor moved to lane b cycle 1');
  assert.strictEqual(await nodeOf(page, 'a'), '..a', 'the other end stayed');
}, { md: WAVE_EDGE_SEL_MD });
check('wave edges: delete', DESKTOP, async (page) => {
  await openWave(page);
  await selectEdgeByLabel(page, 'gmark_a_b', 0);
  await page.locator('.ed-wave-edge-bar [data-focus-key="ed-wave-edge-delete"]').click(); await wait(300);
  assert.deepStrictEqual(await edgesNow(page), [], '刪除 removes the edge');
  assert.strictEqual(await nodeOf(page, 'b'), undefined, 'and the anchors nothing else uses');
  assert.strictEqual(await overlayAttr(page, 'data-wave-selected-edge'), '', 'nothing is selected');
  assert.strictEqual(await edgeBar(page), null, 'the toolbar goes');
  await page.keyboard.press('Control+z'); await wait(300);
  assert.deepStrictEqual(await edgesNow(page), ['a~>b lbl'], 'guard: Ctrl+Z brings it back');
  await selectEdgeByLabel(page, 'gmark_a_b', 0);
  assert.strictEqual(await page.evaluate(() => document.activeElement.getAttribute('data-focus-key')), 'canvas',
    'guard: the keyboard is on the canvas');
  const wave = (await laneNow(page, 'a')).wave;
  await page.keyboard.press('Delete'); await wait(300);
  assert.deepStrictEqual(await edgesNow(page), [], 'Del deletes the selected edge');
  assert.strictEqual((await laneNow(page, 'a')).wave, wave, 'and no cycles');
}, { md: WAVE_EDGE_SEL_MD });
check('wave edges: A then arrow then Enter creates an edge from the keyboard', DESKTOP, async (page) => {
  await openWave(page);
  await page.locator('.ed-wave-overlay .ed-wave-layer').focus(); await wait(100);
  await page.keyboard.press('ArrowDown');
  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowRight');
  await wait(100);
  assert.strictEqual(await overlayAttr(page, 'data-wave-cursor'), '1,2', 'guard: the cursor is on lane a cycle 2');
  await page.keyboard.press('A'); await wait(150);
  assert.strictEqual(await overlayAttr(page, 'data-wave-edgemode'), 'picking', 'A starts an edge from the cursor');
  assert.ok(await page.evaluate(() => document.querySelectorAll('.ed-wave-overlay .ed-wave-dot').length) > 3, 'with every dot shown');
  await page.keyboard.press('ArrowDown');
  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowRight');
  await wait(150);
  assert.strictEqual(await overlayAttr(page, 'data-wave-edge-pending'), '1,2', 'the start is marked while the arrows pick the end');
  assert.strictEqual(!!(await page.$('.ed-wave-overlay .ed-wave-pending')), true, 'a line shows where it will go');
  assert.deepStrictEqual(await edgesNow(page), [], 'nothing is written before Enter');
  await page.keyboard.press('Enter'); await wait(300);
  assert.deepStrictEqual(await edgesNow(page), ['A~>B'], 'Enter creates it');
  assert.strictEqual(await nodeOf(page, 'b'), '....B');
  assert.deepStrictEqual(await edgeField(page), { kind: 'label', value: '', focused: true }, 'and opens its label');
  await page.keyboard.press('Enter'); await wait(250);
  assert.strictEqual(await edgeField(page), null, 'an empty Enter closes the field');
  assert.deepStrictEqual(await edgesNow(page), ['A~>B'], 'the edge stays, unlabelled');
  assert.strictEqual(await overlayAttr(page, 'data-wave-edgemode'), 'idle');
}, { md: WAVE_EDGES_MD });
check('wave edges: T adds a point note', DESKTOP, async (page) => {
  await openWave(page);
  await page.locator('.ed-wave-overlay .ed-wave-layer').focus(); await wait(100);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowRight');
  await wait(100);
  assert.strictEqual(await overlayAttr(page, 'data-wave-cursor'), '2,2', 'guard: lane b cycle 2');
  await page.keyboard.press('T'); await wait(150);
  assert.deepStrictEqual(await edgeField(page), { kind: 'note', value: '', focused: true }, 'T opens the note field there');
  await page.keyboard.type('量測'); await page.keyboard.press('Enter'); await wait(300);
  assert.deepStrictEqual(await edgesNow(page), ['A 量測'], 'a point note: <letter> <text>');
  assert.strictEqual(await nodeOf(page, 'b'), '..A', 'its anchor on lane b cycle 2');
  // Its toolbar: 改文字 / 拉成關聯線 / 刪除.
  await selectEdgeByLabel(page, 'gmark_A_A', 0);
  const bar = await edgeBar(page);
  assert.ok(bar !== null, 'a selected note has its toolbar');
  assert.deepStrictEqual(bar.keys, ['ed-wave-note-text', 'ed-wave-note-to-edge', 'ed-wave-note-delete']);
  await page.locator('.ed-wave-edge-bar [data-focus-key="ed-wave-note-to-edge"]').click(); await wait(200);
  assert.strictEqual(await overlayAttr(page, 'data-wave-edgemode'), 'picking', '拉成關聯線 starts an edge from the note');
  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter'); await wait(300);
  assert.deepStrictEqual(await edgesNow(page), ['A~>B 量測'], 'the note becomes an edge that keeps its text');
  await page.keyboard.press('Control+z'); await wait(300);
  assert.deepStrictEqual(await edgesNow(page), ['A 量測'], 'guard: Ctrl+Z gives the note back');
  await selectEdgeByLabel(page, 'gmark_A_A', 0);
  await page.locator('.ed-wave-edge-bar [data-focus-key="ed-wave-note-delete"]').click(); await wait(300);
  assert.deepStrictEqual(await edgesNow(page), [], '刪除 removes the note');
  assert.strictEqual(await nodeOf(page, 'b'), undefined, 'and its anchor');
}, { md: WAVE_EDGES_MD });
check('wave edges: new anchors are uppercase, existing lowercase untouched', DESKTOP, async (page) => {
  await openWave(page);
  await dragFromDot(page, 1, 0, await anchorPoint(page, 2, 1));
  assert.deepStrictEqual(await edgesNow(page), ['a~>A'], 'the existing lowercase a is reused, the new anchor is A');
  assert.strictEqual(await nodeOf(page, 'a'), 'a', 'lane a keeps its node string byte for byte');
  assert.strictEqual(await nodeOf(page, 'b'), '.A');
}, { md: WAVE_EDGES_MD });
check('wave edges: an unlabelled self-loop is selectable at its anchor', DESKTOP, async (page) => {
  // A zero-length path has no hit area at all; a ring at its anchor stands in for it.
  await openWave(page);
  const a = await anchorPoint(page, 1, 2);
  await page.mouse.move(a.x, a.y, { steps: 3 }); await wait(150);
  assert.strictEqual(await hitAt(page, a.x, a.y), 'edge:0', 'a press on the anchor hits the self-loop');
  await page.mouse.click(a.x, a.y); await wait(250);
  assert.strictEqual(await overlayAttr(page, 'data-wave-selected-edge'), '0', 'it selects it');
  assert.strictEqual(await hitAt(page, a.x, a.y), 'end:to', 'selected, its end handle takes the press');
  assert.ok((await edgeBar(page)) !== null, 'with its toolbar');
  await page.keyboard.press('Delete'); await wait(300);
  assert.deepStrictEqual(await edgesNow(page), [], 'and Del deletes it');
}, { md: waveDoc({ signal: [{ name: 'clk', wave: 'p.....' }, { name: 'a', wave: '0.1.0.', node: '..a' }], edge: ['a~>a'] }) });
const PICK_NOTICE = '正在選關聯線的終點：方向鍵移動、Enter 確定、Esc 取消';
check('wave edges: a same-lane edge\'s toolbar never covers its ends', DESKTOP, async (page) => {
  await openWave(page);
  await selectEdgeByLabel(page, 'gmark_a_b', 0);
  const ends = () => page.evaluate(() => [...document.querySelectorAll('.ed-wave-overlay .ed-wave-edge-end-hit')].map((c) => {
    const r = c.getBoundingClientRect();
    return { end: c.getAttribute('data-end'), x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }));
  const pts = await ends();
  assert.strictEqual(pts.length, 2, 'guard: both end rings are drawn');
  assert.ok((await edgeBar(page)) !== null, 'guard: the toolbar is up');
  for (const p of pts) assert.strictEqual(await hitAt(page, p.x, p.y), 'end:' + p.end, '更多 folded: the ' + p.end + ' end takes a press');
  await page.locator('.ed-wave-edge-bar [data-focus-key="ed-wave-edge-more"]').click(); await wait(200);
  assert.ok(await page.evaluate(() => !document.querySelector('.ed-wave-edge-more-list').hidden), 'guard: 更多 is open');
  for (const p of await ends()) assert.strictEqual(await hitAt(page, p.x, p.y), 'end:' + p.end, '更多 open: the ' + p.end + ' end takes a press');
}, { md: waveDoc({ signal: [{ name: 'clk', wave: 'p.......' }, { name: 'a', wave: '0.1.0.1.', node: '..a...b' }], edge: ['a~>b lbl'] }) });
check('wave edges: picking an end is modal', DESKTOP, async (page) => {
  await openWave(page);
  await page.locator('.ed-wave-overlay .ed-wave-layer').focus(); await wait(100);
  await page.keyboard.press('ArrowDown');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('A'); await wait(150);
  assert.strictEqual(await overlayAttr(page, 'data-wave-edge-pending'), '1,4', 'guard: the start is lane a cycle 4');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
  await wait(100);
  const before = await docNow(page);
  for (const key of [' ', 'Delete', 'Backspace', '1', 'x', 'Control+v', 'Control+z', 'Alt+ArrowUp']) {
    await page.keyboard.press(key); await wait(120);
    assert.deepStrictEqual(await docNow(page), before, key + ' while picking changes nothing');
    assert.strictEqual(await overlayAttr(page, 'data-wave-edgemode'), 'picking', key + ' leaves the pick standing');
  }
  assert.strictEqual(await overlayAttr(page, 'data-wave-status'), PICK_NOTICE, 'a swallowed key says what the keys do now');
  assert.strictEqual(await overlayAttr(page, 'data-wave-edge-pending'), '1,4', 'the start has not moved');
  await page.keyboard.press('Enter'); await wait(300);
  assert.deepStrictEqual(await edgesNow(page), ['A~>B']);
  assert.strictEqual(await nodeOf(page, 'a'), 'aB..A', 'both anchors exactly where they were marked');
  // T while picking ends the pick and opens the note field.
  await page.keyboard.press('Enter'); await wait(200);
  await page.keyboard.press('A'); await wait(150);
  await page.keyboard.press('T'); await wait(150);
  assert.strictEqual(await overlayAttr(page, 'data-wave-edgemode'), 'idle', 'T ends the pick');
  assert.strictEqual((await edgeField(page) || {}).kind, 'note', 'and opens the note field');
}, { md: WAVE_EDGES_MD });
check('wave edges: a toolbar press while picking ends the pick first', DESKTOP, async (page) => {
  await openWave(page);
  await page.locator('.ed-wave-overlay .ed-wave-layer').focus(); await wait(100);
  await page.keyboard.press('ArrowDown');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('A'); await wait(150);
  assert.strictEqual(await overlayAttr(page, 'data-wave-edgemode'), 'picking', 'guard: picking');
  await page.locator('[data-focus-key="ed-wave-cycle-insert"]').click(); await wait(300);
  assert.strictEqual(await overlayAttr(page, 'data-wave-edgemode'), 'idle', 'the press ends the pick');
  assert.strictEqual(await overlayAttr(page, 'data-wave-edge-pending'), '', 'nothing is pending');
  assert.strictEqual(await overlayAttr(page, 'data-wave-cycles'), '7', 'and the button still does its job');
}, { md: WAVE_EDGES_MD });
check('wave edges: a pick that adds nothing says so', DESKTOP, async (page) => {
  await openWave(page);
  await page.locator('.ed-wave-overlay .ed-wave-layer').focus(); await wait(100);
  const pick = async () => {
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); // lane a cycle 2
    await page.keyboard.press('A'); await wait(120);
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter'); await wait(300);
  };
  await page.keyboard.press('ArrowDown');
  await pick();
  assert.deepStrictEqual(await edgesNow(page), ['A~>B'], 'guard: the first pick adds the edge');
  await page.keyboard.press('Enter'); await wait(200);
  await page.keyboard.press('ArrowUp');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
  await pick();
  assert.deepStrictEqual(await edgesNow(page), ['A~>B'], 'the same edge again is not added');
  assert.strictEqual(await overlayAttr(page, 'data-wave-edgemode'), 'picking', 'the pick stays');
  const status = await overlayAttr(page, 'data-wave-status');
  assert.ok(status.includes('沒有加上關聯線'), 'and says why it added nothing: ' + status);
}, { md: WAVE_EDGES_MD });
check('wave edges: IME composition does not commit the edge label', DESKTOP, async (page) => {
  await openWave(page);
  await dragFromDot(page, 1, 2, await anchorPoint(page, 2, 4));
  assert.deepStrictEqual(await edgeField(page), { kind: 'label', value: '', focused: true }, 'guard: the label field is open');
  const during = await page.evaluate(() => {
    const input = document.querySelector('.ed-wave-edge-input');
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    input.value = '組字';
    for (const key of ['Enter', 'Escape', 'Tab']) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: true }));
    }
    return { field: document.querySelector('.ed-wave-edge-input') === input, focused: document.activeElement === input };
  });
  assert.deepStrictEqual(during, { field: true, focused: true }, 'Enter / Esc / Tab while composing leave the field alone');
  assert.deepStrictEqual(await edgesNow(page), ['A~>B'], 'the composing Esc did not take the edge back, Enter wrote nothing');
  await page.evaluate(() => {
    document.querySelector('.ed-wave-edge-input').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '組字' }));
  });
  await page.keyboard.press('Enter'); await wait(300);
  assert.deepStrictEqual(await edgesNow(page), ['A~>B 組字'], 'the Enter after composition commits');
}, { md: WAVE_EDGES_MD });

// ── wave settings and export (Task 10, spec 4.6 W6) ──
const WAVE_SETTINGS_MD = waveDoc({ signal: [{ name: 'clk', wave: 'p.....' }, { name: 'a', wave: '01.0..' }] });
// One label wider than its segment: `3.` is two cycles (80 engine units), FFFFFFFFFFFF is ~108 wide.
const WAVE_OVERFLOW_MD = waveDoc({ signal: [{ name: 'clk', wave: 'p......' },
  { name: 'bus', wave: 'x.3.x..', data: ['FFFFFFFFFFFF'] }] });
const SET_ADVANCED_KEYS = ['ed-wave-set-head-tick', 'ed-wave-set-head-tock', 'ed-wave-set-head-every',
  'ed-wave-set-foot-text', 'ed-wave-set-foot-tick', 'ed-wave-set-foot-tock', 'ed-wave-set-foot-every'];
const focusKey = (page) => page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-focus-key'));
/** The settings popover as plain values: which fields are on screen, their values, the pressed scale. */
function settingsPop(page) {
  return page.evaluate(() => {
    const p = document.querySelector('.ed-wave-overlay .ed-wave-settings-pop');
    if (!p) return null;
    const shown = (el) => !!el && el.getClientRects().length > 0;
    const fields = {};
    for (const el of p.querySelectorAll('input, textarea')) {
      fields[el.getAttribute('data-focus-key')] = { value: el.value, shown: shown(el) };
    }
    const pressed = [...p.querySelectorAll('[data-focus-key^="ed-wave-set-scale-"]')]
      .filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-focus-key'));
    const fix = p.querySelector('[data-focus-key="ed-wave-set-fix"]');
    const card = p.querySelector('.ed-wave-set-overflow');
    const adv = p.querySelector('[data-focus-key="ed-wave-set-advanced"]');
    return { fields, pressed, fix: shown(fix) ? fix.textContent : null,
      card: shown(card) ? card.textContent : null, advanced: adv ? adv.getAttribute('aria-expanded') : null };
  });
}
async function openSettings(page) {
  await page.locator('[data-focus-key="ed-wave-settings"]').click(); await wait(200);
  const s = await settingsPop(page);
  assert.ok(s !== null, 'guard: ⚙ opens the settings popover');
  return s;
}
/** Type `value` into the settings field `key` and press Enter. */
async function setField(page, key, value) {
  const f = page.locator('.ed-wave-settings-pop [data-focus-key="' + key + '"]');
  await f.fill(value); await f.press('Enter'); await wait(250);
}
check('wave settings: every field writes its key', DESKTOP, async (page) => {
  await openWave(page);
  const s0 = await openSettings(page);
  assert.strictEqual(await focusKey(page), 'ed-wave-set-head', 'the keyboard lands on 標題');
  assert.strictEqual(await page.evaluate(() => document.querySelector('[data-focus-key="ed-wave-settings"]').getAttribute('aria-expanded')), 'true');
  assert.strictEqual(s0.fields['ed-wave-set-head'].shown, true, '標題 is on the top level');
  assert.strictEqual(await page.evaluate(() => document.querySelector('[data-focus-key="ed-wave-set-head"]').tagName), 'TEXTAREA', '標題 is a multi-line box');
  assert.deepStrictEqual(s0.pressed, ['ed-wave-set-scale-1'], 'no hscale reads as 1×');
  assert.strictEqual(s0.advanced, 'false', '進階 starts folded');
  for (const k of SET_ADVANCED_KEYS) assert.strictEqual(s0.fields[k].shown, false, k + ' is folded under 進階');
  assert.strictEqual(s0.card, null, 'no overflow card when every label fits');
  // Tab walks the top level in order.
  const walk = [];
  for (let i = 0; i < 5; i++) { await page.keyboard.press('Tab'); await wait(30); walk.push(await focusKey(page)); }
  assert.deepStrictEqual(walk, ['ed-wave-set-scale-1', 'ed-wave-set-scale-2', 'ed-wave-set-scale-3', 'ed-wave-set-scale-4',
    'ed-wave-set-advanced'], 'Tab order of the top level');

  await setField(page, 'ed-wave-set-head', 'Title');
  assert.deepStrictEqual((await docNow(page)).head, { text: 'Title' }, '標題 writes head.text');
  await page.locator('[data-focus-key="ed-wave-set-scale-3"]').click(); await wait(250);
  assert.deepStrictEqual((await docNow(page)).config, { hscale: 3 }, '3× writes config.hscale = 3');
  assert.deepStrictEqual((await settingsPop(page)).pressed, ['ed-wave-set-scale-3'], '3× is the pressed one');
  await page.locator('[data-focus-key="ed-wave-set-scale-1"]').click(); await wait(250);
  assert.strictEqual((await docNow(page)).config, undefined, '1× deletes hscale (and the emptied config)');

  await page.locator('[data-focus-key="ed-wave-set-advanced"]').click(); await wait(150);
  const s1 = await settingsPop(page);
  assert.strictEqual(s1.advanced, 'true', '進階 unfolds');
  for (const k of SET_ADVANCED_KEYS) assert.strictEqual(s1.fields[k].shown, true, k + ' is on screen under 進階');
  await page.locator('[data-focus-key="ed-wave-set-advanced"]').focus();
  const walk2 = [];
  for (let i = 0; i < SET_ADVANCED_KEYS.length; i++) { await page.keyboard.press('Tab'); await wait(30); walk2.push(await focusKey(page)); }
  assert.deepStrictEqual(walk2, SET_ADVANCED_KEYS, 'Tab order under 進階');

  const values = [['ed-wave-set-head-tick', '0'], ['ed-wave-set-head-tock', '1'], ['ed-wave-set-head-every', '2'],
    ['ed-wave-set-foot-text', 'Foot'], ['ed-wave-set-foot-tick', '5'], ['ed-wave-set-foot-tock', 'a b c'],
    ['ed-wave-set-foot-every', '3']];
  for (const [k, v] of values) await setField(page, k, v);
  await page.locator('[data-focus-key="ed-wave-set-scale-2"]').click(); await wait(250);
  const doc = await docNow(page);
  assert.deepStrictEqual(doc, {
    signal: [{ name: 'clk', wave: 'p.....' }, { name: 'a', wave: '01.0..' }],
    head: { text: 'Title', tick: 0, tock: 1, every: 2 },
    foot: { text: 'Foot', tick: 5, tock: 'a b c', every: 3 },
    config: { hscale: 2 },
  }, 'every field wrote its own key; a numeral is a number (the engine adds the hbounds offset to tick/tock)');
  assert.strictEqual(await patchState(page), 'ok', 'every settings write is written back');

  // Clearing a field deletes the key, never writes '' (the engine reads '' as a 0-based ruler).
  await setField(page, 'ed-wave-set-foot-every', '');
  const foot = (await docNow(page)).foot;
  assert.deepStrictEqual(foot, { text: 'Foot', tick: 5, tock: 'a b c' }, 'a cleared field deletes its key');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(foot, 'every'), false, 'no empty string left behind');

  // IME: the Enter that picks a candidate is not a commit.
  const during = await page.evaluate(() => {
    const t = document.querySelector('[data-focus-key="ed-wave-set-head"]');
    t.focus();
    t.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    t.value = '組字';
    for (const key of ['Enter', 'Escape', 'Tab']) {
      t.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: true }));
    }
    return { open: !!document.querySelector('.ed-wave-settings-pop'), focused: document.activeElement === t };
  });
  assert.deepStrictEqual(during, { open: true, focused: true }, 'Enter / Esc / Tab while composing leave the popover alone');
  assert.strictEqual((await docNow(page)).head.text, 'Title', 'nothing written mid-composition');
  await page.evaluate(() => {
    document.querySelector('[data-focus-key="ed-wave-set-head"]').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '組字' }));
  });
  await page.keyboard.press('Enter'); await wait(250);
  assert.strictEqual((await docNow(page)).head.text, '組字', 'the Enter after composition commits');

  // What is typed counts even when the popover closes by a press elsewhere.
  await page.locator('[data-focus-key="ed-wave-set-foot-text"]').fill('Foot 2'); await wait(50);
  const title = await page.locator('.ed-wave-title').boundingBox();
  await page.mouse.click(title.x + 5, title.y + title.height / 2); await wait(250);
  assert.strictEqual(await settingsPop(page), null, 'a press outside closes the popover');
  assert.strictEqual((await docNow(page)).foot.text, 'Foot 2', 'the typed value was written when it closed');

  // Esc closes the popover only, and the keyboard goes back to ⚙.
  await openSettings(page);
  await page.keyboard.press('Escape'); await wait(200);
  assert.strictEqual(await settingsPop(page), null, 'Esc closes the popover');
  assert.strictEqual(!!(await page.$('.ed-wave-overlay')), true, 'and not the editor');
  assert.strictEqual(await focusKey(page), 'ed-wave-settings', 'the keyboard is back on ⚙');
  const s2 = await openSettings(page);
  assert.strictEqual(s2.fields['ed-wave-set-head'].value, '組字', 'the popover shows the document');
  assert.strictEqual(s2.fields['ed-wave-set-foot-tick'].value, '5', 'a number reads back as its numeral');
}, { md: WAVE_SETTINGS_MD });
/** The overflow marks on the canvas and the chip beside them, as plain values. */
function overflowMarks(page) {
  return page.evaluate(() => {
    const ov = document.querySelector('.ed-wave-overlay');
    const chip = ov.querySelector('.ed-wave-overflow-chip');
    let c = null;
    if (chip && chip.getClientRects().length > 0) {
      const r = chip.getBoundingClientRect();
      const x = r.left + r.width / 2; const y = r.top + r.height / 2;
      const top = document.elementFromPoint(x, y);
      c = { text: chip.textContent, x, y, onTop: top === chip || (!!top && chip.contains(top)) };
    }
    return { marks: ov.querySelectorAll('.ed-wave-overflow').length, chip: c };
  });
}
check('wave settings: overflow chip and one-click fix', DESKTOP, async (page) => {
  await openWave(page);
  const m0 = await overflowMarks(page);
  assert.strictEqual(m0.marks, 1, 'the one label wider than its segment is marked');
  assert.ok(m0.chip !== null && m0.chip.text.includes('改每拍 2×'), 'a chip beside it offers 2× ' + JSON.stringify(m0));
  assert.strictEqual(m0.chip.onTop, true, 'the chip takes a press');
  const s = await openSettings(page);
  assert.ok(s.card !== null && s.card.includes('1 個資料標籤比它那一段寬'), 'the popover says how many labels overflow ' + JSON.stringify(s));
  assert.strictEqual(s.fix, '改成每拍 2×', 'and offers the smallest scale that fits');
  const walk = [];
  await page.locator('[data-focus-key="ed-wave-set-scale-4"]').focus();
  for (let i = 0; i < 2; i++) { await page.keyboard.press('Tab'); await wait(30); walk.push(await focusKey(page)); }
  assert.deepStrictEqual(walk, ['ed-wave-set-fix', 'ed-wave-set-advanced'], 'the fix sits between 4× and 進階 in Tab order');
  await page.locator('[data-focus-key="ed-wave-set-fix"]').click(); await wait(300);
  assert.deepStrictEqual((await docNow(page)).config, { hscale: 2 }, 'the fix writes config.hscale = 2');
  const m1 = await overflowMarks(page);
  assert.deepStrictEqual(m1, { marks: 0, chip: null }, 'after the re-render nothing is marked and the chip is gone');
  const s1 = await settingsPop(page);
  assert.ok(s1 !== null, 'the popover stays open');
  assert.strictEqual(s1.card, null, 'its overflow card is gone');
  assert.deepStrictEqual(s1.pressed, ['ed-wave-set-scale-2'], '2× is pressed now');
  assert.strictEqual(await focusKey(page), 'ed-wave-set-scale-2', 'the keyboard lands on the scale the fix chose');
  // The chip on the canvas does the same.
  await page.keyboard.press('Escape'); await wait(150);
  await page.keyboard.press('Control+z'); await wait(300);
  assert.strictEqual((await docNow(page)).config, undefined, 'guard: undone');
  const m2 = await overflowMarks(page);
  assert.ok(m2.chip !== null && m2.chip.onTop, 'guard: the chip is back');
  await page.mouse.click(m2.chip.x, m2.chip.y); await wait(300);
  assert.deepStrictEqual((await docNow(page)).config, { hscale: 2 }, 'the chip writes config.hscale = 2');
  assert.deepStrictEqual(await overflowMarks(page), { marks: 0, chip: null }, 'and the marks go');
}, { md: WAVE_OVERFLOW_MD });
check('wave settings: a scale above 4x is offered and says the drawing will shrink', DESKTOP, async (page) => {
  await openWave(page);
  const s = await openSettings(page);
  assert.ok(s.card !== null && s.card.includes('需要每拍 6×') && s.card.includes('縮小'), 'K > 4 says so ' + JSON.stringify(s));
  assert.strictEqual(s.fix, '改成每拍 6×', 'the button is still there');
  await page.locator('[data-focus-key="ed-wave-set-fix"]').click(); await wait(300);
  assert.deepStrictEqual((await docNow(page)).config, { hscale: 6 }, 'and it writes 6');
  assert.deepStrictEqual((await settingsPop(page)).pressed, [], 'no 1×–4× button is pressed at 6×');
}, { md: waveDoc({ signal: [{ name: 'bus', wave: '3x..', data: ['F'.repeat(24)] }] }) });

/** Pick `key` from the 匯出 menu; resolves with the download when one is expected. */
async function exportPick(page, key, download) {
  await page.locator('[data-focus-key="ed-wave-export-menu"]').click(); await wait(150);
  if (!download) { await page.locator('[data-focus-key="' + key + '"]').click(); await wait(400); return null; }
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('[data-focus-key="' + key + '"]').click()]);
  return dl;
}
function svgSize(text) {
  const root = /<svg\b[^>]*>/.exec(text)[0];
  const attr = (k) => { const m = new RegExp('\\s' + k + '="([^"]*)"').exec(root); return m ? Number(m[1]) : null; };
  return { w: attr('width'), h: attr('height') };
}
/** IHDR width/height of a PNG: bytes 16–23, big-endian. */
function pngSize(buf) {
  assert.strictEqual(buf.slice(1, 4).toString('latin1'), 'PNG', 'the file is a PNG');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
/** The canvas's engine svg at the engine's own size (its viewBox). */
async function engineViewBox(page) {
  const vb = await page.evaluate(() => {
    const svg = document.querySelector('.ed-wave-stage svg[id^="svgcontent"]');
    return svg ? svg.getAttribute('viewBox') : null;
  });
  const n = vb.split(/[\s,]+/).map(Number);
  return { w: n[2], h: n[3] };
}
/** Share of a PNG's pixels that are dark (luminance < 0.25), decoded by the page. */
function darkShare(page, buf) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
    const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
    const px = cx.getImageData(0, 0, cv.width, cv.height).data;
    let dark = 0;
    for (let i = 0; i < px.length; i += 4) {
      const l = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
      if (l < 0.25) dark++;
    }
    return dark / (px.length / 4);
  }, buf.toString('base64'));
}
check('wave export: the menu lists the four exports and says they are light', DESKTOP, async (page) => {
  await openWave(page);
  await page.locator('[data-focus-key="ed-wave-export-menu"]').click(); await wait(150);
  const m = await page.evaluate(() => {
    const p = document.querySelector('.ed-wave-overlay .ed-wave-export-pop');
    if (!p) return null;
    return { keys: [...p.querySelectorAll('.ed-wave-menu-item')].map((b) => b.getAttribute('data-focus-key')),
      labels: [...p.querySelectorAll('.ed-wave-menu-label')].map((b) => b.textContent),
      note: (p.querySelector('.ed-wave-export-note') || { textContent: null }).textContent,
      focus: document.activeElement.getAttribute('data-focus-key') };
  });
  assert.deepStrictEqual(m, { keys: ['ed-wave-export-copyimg', 'ed-wave-export-png', 'ed-wave-export-svg', 'ed-wave-export-json'],
    labels: ['複製為圖片', '下載 PNG', '下載 SVG', '複製 WaveJSON'], note: '匯出一律是淺色、白底', focus: 'ed-wave-export-copyimg' });
}, { md: WAVE_CANVAS_MD });
check('wave export: dark mode exports a light svg', DESKTOP, async (page) => {
  await page.locator('#md2doc-theme-toggle').click(); await wait(300);
  await openWave(page);
  const dark = await page.evaluate(() => {
    const t = document.querySelector('.ed-wave-stage svg[id^="svgcontent"] [style*="important"]');
    return !!t;
  });
  assert.strictEqual(dark, true, 'guard: the canvas itself is recoloured');
  const dl = await exportPick(page, 'ed-wave-export-svg', true);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  assert.strictEqual(text.includes('!important'), false, 'no dark recolour in the exported svg');
  assert.ok(/<style[\s>]/.test(text) && /<defs[\s>]/.test(text), 'it carries the skin\'s own style and defs');
  assert.ok(text.includes('>A<') && text.includes(LONG_NAME), 'it is this diagram');
  const png = fs.readFileSync(await (await exportPick(page, 'ed-wave-export-png', true)).path());
  const share = await darkShare(page, png);
  assert.ok(share > 0.02, 'the PNG is drawn dark-on-white like a light page (dark pixel share ' + share.toFixed(4) + ')');
  assert.strictEqual(await page.evaluate(() => document.documentElement.getAttribute('data-md2doc-theme')), 'dark', 'guard: still dark');
}, { md: WAVE_CANVAS_MD, ctx: { acceptDownloads: true } });
check('wave export: png is 2x', DESKTOP, async (page) => {
  await openWave(page);
  const vb = await engineViewBox(page);
  const svg = svgSize(fs.readFileSync(await (await exportPick(page, 'ed-wave-export-svg', true)).path(), 'utf8'));
  assert.deepStrictEqual(svg, vb, 'the clean render is the engine size');
  const dl = await exportPick(page, 'ed-wave-export-png', true);
  assert.ok(/-wave-\d+\.png$/.test(dl.suggestedFilename()), 'png filename ' + dl.suggestedFilename());
  const png = pngSize(fs.readFileSync(await dl.path()));
  assert.deepStrictEqual(png, { w: svg.w * 2, h: svg.h * 2 }, 'decoded size is twice the engine svg');
}, { md: WAVE_CANVAS_MD, ctx: { acceptDownloads: true } });
check('wave export: copy image', DESKTOP, async (page) => {
  const engine = page.context().browser().browserType().name();
  // Chromium lets a test read the clipboard back; WebKit has no such permission.
  if (engine === 'chromium') await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openWave(page);
  const vb = await engineViewBox(page);
  await exportPick(page, 'ed-wave-export-copyimg', false);
  // The write settles once the PNG is made and the browser has taken it (measured
  // in Chromium: over a second). Settle on the status changing, then read it.
  for (let i = 0; i < 50 && (await overlayAttr(page, 'data-wave-status')) === null; i++) await wait(100);
  const notice = () => page.evaluate(() => {
    const n = document.querySelector('.ed-conflict[data-level="notice"] .ed-msg-text');
    return n ? n.textContent : null;
  });
  assert.strictEqual(await notice(), '已複製圖片（PNG，2 倍大小）',
    'the copy says it worked (status: ' + await overlayAttr(page, 'data-wave-status') + ')');
  if (engine === 'chromium') {
    const got = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const item = items.find((i) => i.types.includes('image/png'));
      if (!item) return null;
      const bytes = new Uint8Array(await (await item.getType('image/png')).arrayBuffer());
      return Array.from(bytes.slice(0, 24));
    });
    assert.ok(got !== null, 'the clipboard holds a PNG');
    assert.deepStrictEqual(pngSize(Buffer.from(got)), { w: vb.w * 2, h: vb.h * 2 }, 'at twice the engine size');
  }
  // A browser without ClipboardItem: a notice, not a throw.
  await page.evaluate(() => { window.ClipboardItem = undefined; });
  await exportPick(page, 'ed-wave-export-copyimg', false);
  assert.strictEqual(await notice(), '這個瀏覽器不能複製圖片，請改用下載 PNG', 'unsupported says what to do instead');
}, { md: WAVE_CANVAS_MD });
check('wave export: json copy', DESKTOP, async (page) => {
  const engine = page.context().browser().browserType().name();
  if (engine === 'chromium') await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openWave(page);
  await page.evaluate(() => {
    const clip = navigator.clipboard;
    const real = clip.writeText.bind(clip);
    window.__copied = [];
    clip.writeText = (t) => { window.__copied.push(t); return real(t); };
  });
  await exportPick(page, 'ed-wave-export-json', false);
  const r = await page.evaluate(() => ({ copied: window.__copied, source: window.__edWaveSourceProbe(),
    notice: (document.querySelector('.ed-conflict[data-level="notice"] .ed-msg-text') || { textContent: null }).textContent }));
  assert.deepStrictEqual(r.copied, [r.source], 'the block\'s WaveJSON, exactly as written back, is what is copied');
  assert.strictEqual(r.notice, 'WaveJSON 已複製到剪貼簿');
  if (engine === 'chromium') {
    assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), r.source, 'and it is on the clipboard');
  }
}, { md: WAVE_CANVAS_MD });

// ── wave close / help (Task 11, spec 4.8): closing keeps, Ctrl+Z reverts the session,
// layered Esc, the hint bar and the shortcut card ──
/** The wavedrom block's fence BODY in the DOCUMENT (client.js `lines`), not the editor's
 *  store: the same text `__edWaveSourceProbe()` reports while the editor is open. */
function waveBlockText(page) {
  return page.evaluate(() => {
    const b = [...document.querySelectorAll('.ed-block')].find((x) => x.querySelector('.wavedrom-diagram, [id^="WaveDrom_Display_"]'));
    if (!b) return null;
    const s = window.__edTestBlockSpan(Number(b.getAttribute('data-block-id')));
    return s === null ? null : s.text.split('\n').slice(1, -1).join('\n');
  });
}
const waveOpen = (page) => page.evaluate(() => !!document.querySelector('.ed-wave-overlay'));
/** The notice toast as plain values, or null. */
function noticeToast(page) {
  return page.evaluate(() => {
    const n = document.querySelector('.ed-conflict[data-level="notice"]');
    if (!n) return null;
    const b = n.querySelector('button:not(.ed-msg-x)');
    return { text: n.querySelector('.ed-msg-text').textContent, action: b ? b.textContent : null };
  });
}
/** Pick `brushKey` on the toolbar and click lane `lane` cycle `cycle` (a paint). */
async function paintCell(page, brushKey, lane, cycle) {
  await page.locator('[data-focus-key="brush-' + brushKey + '"]').click(); await wait(100);
  const p = await cellPress(page, lane, cycle);
  await page.mouse.click(p.x, p.y); await wait(250);
}
const hintText = (page) => page.evaluate(() => {
  const t = document.querySelector('.ed-wave-overlay .ed-wave-hint-text');
  return t ? t.textContent : null;
});
/** The shortcut card as plain values, or null when it is not on screen. */
function shortcutCard(page) {
  return page.evaluate(() => {
    const c = document.querySelector('.ed-wave-overlay .ed-wave-shortcuts');
    if (!c || c.getClientRects().length === 0) return null;
    const r = c.getBoundingClientRect();
    const p = document.querySelector('.ed-wave-panel').getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      groups: [...c.querySelectorAll('.ed-wave-shortcut-group')].map((g) => ({
        title: g.querySelector('.ed-wave-shortcut-title').textContent,
        keys: [...g.querySelectorAll('kbd')].map((k) => k.textContent),
      })),
      dx: Math.abs((r.left + r.width / 2) - (p.left + p.width / 2)),
      dy: Math.abs((r.top + r.height / 2) - (p.top + p.height / 2)),
      onTop: !!hit && c.contains(hit),
      focusIn: c.contains(document.activeElement),
    };
  });
}
check('wave close: Esc closes and keeps the change', DESKTOP, async (page) => {
  const before = await waveBlockText(page);
  await openWave(page);
  await paintCell(page, '1', 1, 2);
  const written = await sourceNow(page);
  assert.notStrictEqual(written, before, 'guard: the paint changed the block');
  // The click left one cell selected and the keyboard on the canvas: nothing to peel, so Esc closes.
  await page.keyboard.press('Escape'); await wait(1000);
  assert.strictEqual(await waveOpen(page), false, 'Esc closed the editor');
  assert.strictEqual(await waveBlockText(page), written, 'and the change stayed in the document');
  assert.strictEqual(await page.evaluate(() => window.__edTestWaveState().dirty), true, 'the file reads unsaved');
  assert.deepStrictEqual(await noticeToast(page), { text: '波形已更新（1 處修改）· Ctrl+Z 整段復原', action: '整段復原' },
    'the close says what changed and how to take it back');
}, { md: WAVE_SHELL_MD });
// Final review M3: the canvas subscribes to the theme once per open. A subscription left
// behind holds the closed canvas — and through its host the whole overlay and the store's
// history — for the life of the page, one more per open.
check('wave close: closing the editor drops its theme subscription', DESKTOP, async (page) => {
  const count = () => page.evaluate(() => window.md2docTheme.__listenerCount());
  const base = await count();
  for (let i = 0; i < 3; i++) {
    await openWave(page);
    assert.strictEqual(await count(), base + 1, 'open #' + (i + 1) + ' subscribes once');
    await page.keyboard.press('Escape'); await wait(600);
    assert.strictEqual(await waveOpen(page), false, 'guard: Esc closed the editor (#' + (i + 1) + ')');
    assert.strictEqual(await count(), base, 'close #' + (i + 1) + ' unsubscribes: the listener count is back to ' + base);
  }
}, { md: WAVE_SHELL_MD });
check('wave close: Ctrl+Z right after closing reverts the whole session as one step', DESKTOP, async (page) => {
  const before = await waveBlockText(page);
  await openWave(page);
  await paintCell(page, '1', 1, 1);
  await paintCell(page, 'x', 1, 3);
  await paintCell(page, '1', 1, 4);
  assert.strictEqual(await page.evaluate(() => window.__edTestWaveState().seam.ops), 3, 'guard: three gestures were written');
  const painted = await sourceNow(page);
  await page.locator('.ed-wave-close').click(); await wait(1000);
  assert.strictEqual(await waveOpen(page), false, 'guard: ✕ closed it');
  assert.strictEqual(await waveBlockText(page), painted, 'guard: the drawing is in the document');
  assert.strictEqual((await noticeToast(page) || {}).text, '波形已更新（3 處修改）· Ctrl+Z 整段復原');
  await page.keyboard.press('Control+z'); await wait(1000);
  assert.strictEqual(await waveBlockText(page), before, 'ONE Ctrl+Z puts the whole session back');
  assert.strictEqual((await noticeToast(page) || {}).text, '已退回這次的波形修改');
  await page.keyboard.press('Control+y'); await wait(1000);
  assert.strictEqual(await waveBlockText(page), painted, 'Ctrl+Y brings the session back');
  await page.keyboard.press('Control+y'); await wait(800);
  assert.strictEqual(await waveBlockText(page), painted, 'a second Ctrl+Y has nothing left to redo');
  // Back at the closed state, the offer stands again: Ctrl+Z reverts the session once more.
  await page.keyboard.press('Control+z'); await wait(1000);
  assert.strictEqual(await waveBlockText(page), before, 'Ctrl+Z after Ctrl+Y reverts the session again');
}, { md: WAVE_SHELL_MD });
check('wave close: the toast button reverts the whole session too', DESKTOP, async (page) => {
  const before = await waveBlockText(page);
  await openWave(page);
  await paintCell(page, '1', 1, 1);
  await paintCell(page, 'x', 1, 3);
  await page.locator('[data-focus-key="ed-wave-done"]').click(); await wait(1000);
  const btn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.ed-conflict[data-level="notice"] button')].find((x) => x.textContent === '整段復原');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const x = r.left + r.width / 2; const y = r.top + r.height / 2;
    return { x, y, onTop: document.elementFromPoint(x, y) === b };
  });
  assert.ok(btn !== null && btn.onTop, 'the toast offers 整段復原 and it takes a press ' + JSON.stringify(btn));
  await page.mouse.click(btn.x, btn.y); await wait(1000);
  assert.strictEqual(await waveBlockText(page), before, '整段復原 puts the whole session back');
}, { md: WAVE_SHELL_MD });
check('wave close: an edit elsewhere disables the whole-session undo', DESKTOP, async (page) => {
  await openWave(page);
  await paintCell(page, '1', 1, 1);
  const one = await sourceNow(page);
  await paintCell(page, 'x', 1, 3);
  const two = await sourceNow(page);
  await page.locator('.ed-wave-close').click(); await wait(1000);
  assert.strictEqual((await noticeToast(page) || {}).text, '波形已更新（2 處修改）· Ctrl+Z 整段復原', 'guard: the offer was made');
  // Typing in another block is the next change to the document.
  const tail = page.locator('.ed-block[data-block-type="paragraph"]', { hasText: 'Tail.' });
  await tail.click(); await page.keyboard.press('End'); await page.keyboard.type('X'); await wait(100);
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await wait(800);
  assert.strictEqual(await page.evaluate(() => document.body.textContent.includes('Tail.X')), true, 'guard: the typing landed');
  await page.keyboard.press('Escape'); await wait(200);
  await page.keyboard.press('Control+z'); await wait(1000);
  assert.strictEqual(await page.evaluate(() => document.body.textContent.includes('Tail.X')), false, 'Ctrl+Z takes back only the typing');
  assert.strictEqual(await waveBlockText(page), two, 'and leaves the waveform alone');
  await page.keyboard.press('Control+z'); await wait(1000);
  assert.strictEqual(await waveBlockText(page), one, 'from there Ctrl+Z steps back one gesture at a time');
}, { md: WAVE_SHELL_MD });
check('wave close: Esc peels layers before closing', DESKTOP, async (page) => {
  await openWave(page);
  const pops = () => page.evaluate(() => document.querySelectorAll('.ed-wave-overlay .ed-wave-pop').length);
  const esc = async (what) => {
    await page.keyboard.press('Escape'); await wait(200);
    assert.strictEqual(await waveOpen(page), true, 'Esc on ' + what + ' leaves the editor open');
  };
  for (const key of ['ed-wave-settings', 'ed-wave-brush-more', 'ed-wave-signal-menu', 'ed-wave-export-menu']) {
    await page.locator('[data-focus-key="' + key + '"]').click(); await wait(200);
    assert.strictEqual(await pops(), 1, 'guard: ' + key + ' opened its popover');
    await esc(key);
    assert.strictEqual(await pops(), 0, 'Esc closes ' + key + '\'s popover');
    assert.strictEqual(await focusKey(page), key, 'and the keyboard goes back to ' + key);
  }
  // A run of cycles: its toolbar, and the 電位 grid on it.
  await page.locator('.ed-wave-overlay .ed-wave-layer').focus();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowRight'); await wait(200);
  assert.ok((await rangeBar(page)) !== null, 'guard: the run raised its toolbar');
  await page.locator('[data-focus-key="ed-wave-range-level"]').click(); await wait(200);
  assert.strictEqual(await pops(), 1, 'guard: 電位 opened its grid');
  await esc('the 電位 grid');
  assert.strictEqual(await pops(), 0, 'Esc closes the 電位 grid first');
  assert.ok((await rangeBar(page)) !== null, 'and leaves the range toolbar');
  await esc('the range toolbar');
  assert.strictEqual(await rangeBar(page), null, 'Esc drops the range toolbar');
  assert.strictEqual(await overlayAttr(page, 'data-wave-lane-range'), '1,1', 'the cursor cell stays selected');
  assert.strictEqual(await focusKey(page), 'canvas', 'with the keyboard on the canvas');
  // The shortcut card.
  await page.keyboard.press('?'); await wait(200);
  assert.ok((await shortcutCard(page)) !== null, 'guard: ? opened the card');
  await esc('the shortcut card');
  assert.strictEqual(await shortcutCard(page), null, 'Esc closes the card');
  // A pick started with A, then the resident dots.
  await page.keyboard.press('a'); await wait(150);
  assert.strictEqual(await overlayAttr(page, 'data-wave-edgemode'), 'picking', 'guard: A started a pick');
  await esc('a pick');
  assert.strictEqual(await overlayAttr(page, 'data-wave-edgemode'), 'idle', 'Esc drops the pick');
  await page.locator('[data-focus-key="ed-wave-edge-arm"]').click(); await wait(150);
  assert.strictEqual(await overlayAttr(page, 'data-wave-dots'), 'all', 'guard: 關聯線 keeps the dots up');
  await esc('the resident dots');
  assert.strictEqual(await overlayAttr(page, 'data-wave-dots'), 'near', 'Esc turns them off');
  // Nothing left: Esc closes.
  await page.keyboard.press('Escape'); await wait(600);
  assert.strictEqual(await waveOpen(page), false, 'with nothing open, Esc closes the editor');
}, { md: WAVE_RANGE_MD });
check('wave help: ? opens the shortcut card and Esc closes it', DESKTOP, async (page) => {
  await openWave(page);
  await page.locator('.ed-wave-overlay .ed-wave-layer').focus();
  await page.keyboard.press('?'); await wait(200);
  const card = await shortcutCard(page);
  assert.ok(card !== null, '? on the canvas opens the shortcut card');
  assert.deepStrictEqual(card.groups.map((g) => g.title), ['畫波形', '訊號', '關聯線與標註', '整張圖與檔案'], 'four groups (spec 4.8)');
  const keys = (i) => card.groups[i].keys.join(' ');
  for (const k of ['Shift+←→', 'Enter', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+C', 'Ctrl+V']) {
    assert.ok(keys(0).includes(k), '畫波形 lists ' + k + ' (Ruling R14 for Ctrl+C / Ctrl+V): ' + keys(0));
  }
  for (const k of ['F2', 'Ctrl+D', 'Alt+↑↓', 'Del']) assert.ok(keys(1).includes(k), '訊號 lists ' + k + ': ' + keys(1));
  for (const k of ['A', 'T', 'Alt+←→']) assert.ok(card.groups[2].keys.includes(k), '關聯線與標註 lists ' + k + ': ' + keys(2));
  for (const k of ['Ctrl+S', 'Esc', '?']) assert.ok(card.groups[3].keys.includes(k), '整張圖與檔案 lists ' + k + ': ' + keys(3));
  assert.ok(card.dx <= 2 && card.dy <= 2, 'the card sits in the middle of the editor ' + JSON.stringify(card));
  assert.strictEqual(card.onTop, true, 'nothing covers it');
  assert.strictEqual(card.focusIn, true, 'the keyboard is in the card');
  await page.keyboard.press('Escape'); await wait(200);
  assert.strictEqual(await shortcutCard(page), null, 'Esc closes the card');
  assert.strictEqual(await waveOpen(page), true, 'and only the card');
  assert.strictEqual(await focusKey(page), 'canvas', 'the keyboard goes back to the canvas');
  // The hint bar's 「? 全部快捷鍵」 opens the same card; Esc gives the keyboard back to it.
  const help = await page.evaluate(() => {
    const b = document.querySelector('.ed-wave-overlay .ed-wave-hint .ed-wave-hint-help');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const x = r.left + r.width / 2; const y = r.top + r.height / 2;
    return { x, y, text: b.textContent, onTop: document.elementFromPoint(x, y) === b };
  });
  assert.ok(help !== null && help.onTop, 'the hint bar has its help button and it takes a press ' + JSON.stringify(help));
  assert.strictEqual(help.text, '? 全部快捷鍵');
  await page.mouse.click(help.x, help.y); await wait(200);
  assert.ok((await shortcutCard(page)) !== null, 'the help button opens the card');
  await page.keyboard.press('Escape'); await wait(200);
  assert.strictEqual(await shortcutCard(page), null, 'Esc closes it');
  assert.strictEqual(await focusKey(page), 'ed-wave-hint-help', 'and the keyboard is back on the help button');
  // Not while composing, and not in a text field.
  await page.locator('.ed-wave-overlay .ed-wave-layer').focus();
  await page.evaluate(() => {
    const layer = document.querySelector('.ed-wave-overlay .ed-wave-layer');
    layer.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true, isComposing: true }));
  });
  await wait(150);
  assert.strictEqual(await shortcutCard(page), null, '? while composing opens nothing');
  await page.locator('[data-focus-key="ed-wave-settings"]').click(); await wait(200);
  await page.keyboard.type('?'); await wait(150);
  assert.strictEqual(await shortcutCard(page), null, '? typed in a text field opens nothing');
  assert.strictEqual(await page.evaluate(() => document.querySelector('[data-focus-key="ed-wave-set-head"]').value), '?', 'it is typed');
}, { md: WAVE_SHELL_MD });
check('wave help: hint follows the selection', DESKTOP, async (page) => {
  await openWave(page);
  assert.strictEqual(await hintText(page), '點一拍改電位、按住拖曳塗一段', 'nothing selected');
  await page.locator('.ed-wave-overlay .ed-wave-layer').focus();
  await page.keyboard.press('ArrowDown'); await wait(150);
  assert.strictEqual(await overlayAttr(page, 'data-wave-cursor'), '1,0', 'guard: the cursor is on bus cycle 0 (x)');
  assert.strictEqual(await hintText(page), 'Shift+←→ 選一段 · 按電位字元改電位', 'an ordinary cell');
  await page.keyboard.press('ArrowRight'); await wait(150);
  assert.strictEqual(await hintText(page), 'Enter 改標籤 · Shift+←→ 選一段', 'a data cell (3 of x3.4.5x)');
  await page.keyboard.press('ArrowRight'); await wait(150);
  assert.strictEqual(await hintText(page), 'Enter 改標籤 · Shift+←→ 選一段', 'the cell continuing that data value');
  await page.keyboard.press('Shift+ArrowRight'); await wait(150);
  assert.strictEqual(await hintText(page), '用浮動工具列改這一段 · Shift+←→ 調整範圍 · Esc 取消選取', 'a run');
  await page.keyboard.press('Escape'); await wait(150);
  await page.keyboard.press('a'); await wait(150);
  assert.strictEqual(await hintText(page), '方向鍵選終點（Alt+←→ 跳到轉換處）、Enter 建立；Esc 取消', 'picking an end');
  await page.keyboard.press('Escape'); await wait(150);
  // The help button sits at the right end of the bar, clear of the sentence.
  const g = await page.evaluate(() => {
    const bar = document.querySelector('.ed-wave-overlay .ed-wave-hint').getBoundingClientRect();
    const t = document.querySelector('.ed-wave-overlay .ed-wave-hint-text').getBoundingClientRect();
    const b = document.querySelector('.ed-wave-overlay .ed-wave-hint-help').getBoundingClientRect();
    return { barRight: bar.right, helpRight: b.right, textRight: t.right, helpLeft: b.left };
  });
  assert.ok(g.barRight - g.helpRight <= 16, 'the help button is at the right end ' + JSON.stringify(g));
  assert.ok(g.textRight <= g.helpLeft, 'the sentence never runs under it ' + JSON.stringify(g));
}, { md: WAVE_DATA_MD });
check('wave help: the notice toast never covers the hint bar', { width: 1366, height: 768 }, async (page) => {
  await openWave(page);
  await page.locator('[data-focus-key="ed-wave-cycle-delete"]').click(); await wait(250);
  const r = await page.evaluate(() => {
    const toast = document.querySelector('.ed-conflict[data-level="notice"]');
    const bar = document.querySelector('.ed-wave-overlay .ed-wave-hint');
    const help = bar.querySelector('.ed-wave-hint-help');
    if (!toast) return { toast: false };
    const t = toast.getBoundingClientRect(); const h = bar.getBoundingClientRect();
    const at = (x, y) => document.elementFromPoint(x, y);
    const mid = at(h.left + h.width / 2, h.top + h.height / 2);
    let helpOnTop = null;
    if (help) { const b = help.getBoundingClientRect(); helpOnTop = at(b.left + b.width / 2, b.top + b.height / 2) === help; }
    return { toast: true, text: toast.querySelector('.ed-msg-text').textContent,
      toastBottom: t.bottom, barTop: h.top, middleInBar: !!mid && bar.contains(mid), helpOnTop };
  });
  assert.strictEqual(r.toast, true, 'guard: a notice is up');
  assert.strictEqual(r.text, '先選一段 cycle 再刪', 'guard: it is the refusal');
  assert.ok(r.toastBottom <= r.barTop, 'the toast sits above the hint bar ' + JSON.stringify(r));
  assert.strictEqual(r.middleInBar, true, 'the middle of the hint bar is the hint bar, not the toast ' + JSON.stringify(r));
  assert.strictEqual(r.helpOnTop, true, '「? 全部快捷鍵」 takes a press ' + JSON.stringify(r));
}, { md: WAVE_SHELL_MD });
check('wave close: the whole-session undo is one step either way, and the stack stays linear', DESKTOP, async (page) => {
  // T: an ordinary edit made BEFORE the session.
  const tail = page.locator('.ed-block[data-block-type="paragraph"]', { hasText: 'Tail.' });
  await tail.click(); await page.keyboard.press('End'); await page.keyboard.type('X'); await wait(100);
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await wait(800);
  await page.keyboard.press('Escape'); await wait(200);
  const hasT = () => page.evaluate(() => document.body.textContent.includes('Tail.X'));
  assert.strictEqual(await hasT(), true, 'guard: T landed');
  const before = await waveBlockText(page);
  await openWave(page);
  await paintCell(page, '1', 1, 1);
  await paintCell(page, 'x', 1, 3);
  await paintCell(page, '1', 1, 4);
  const painted = await sourceNow(page);
  await page.locator('.ed-wave-close').click(); await wait(1000);
  await page.keyboard.press('Control+z'); await wait(1000);
  assert.strictEqual(await waveBlockText(page), before, 'Ctrl+Z: the original drawing');
  assert.strictEqual(await hasT(), true, 'and T is still there');
  await page.keyboard.press('Control+z'); await wait(1000);
  assert.strictEqual(await hasT(), false, 'Ctrl+Z again: T is undone');
  assert.strictEqual(await waveBlockText(page), before, 'and the drawing stays reverted (no ping-pong)');
  // Disk now holds neither T nor the drawing; from here every redo is unsaved work.
  await page.keyboard.press('Control+s'); await wait(900);
  assert.strictEqual(await page.evaluate(() => window.__edTestWaveState().dirty), false, 'guard: saved');
  await page.keyboard.press('Control+y'); await wait(1000);
  assert.strictEqual(await hasT(), true, 'Ctrl+Y: T is back');
  assert.strictEqual(await waveBlockText(page), before, 'and only T');
  await page.keyboard.press('Control+y'); await wait(1000);
  assert.strictEqual(await waveBlockText(page), painted, 'Ctrl+Y again: the whole drawing, as one step');
  assert.strictEqual(await hasT(), true, 'T stays');
  assert.strictEqual(await page.evaluate(() => window.__edTestWaveState().dirty), true,
    'the file reads unsaved: disk holds neither T nor the drawing');
}, { md: WAVE_SHELL_MD });
check('wave close: an open raw editor\'s typing is committed before the whole-session undo is asked', DESKTOP, async (page) => {
  await openWave(page);
  await paintCell(page, '1', 1, 1);
  await paintCell(page, 'x', 1, 3);
  const painted = await sourceNow(page);
  await page.locator('.ed-wave-close').click(); await wait(1000);
  assert.strictEqual((await noticeToast(page) || {}).text, '波形已更新（2 處修改）· Ctrl+Z 整段復原', 'guard: the offer was made');
  const para = page.locator('.ed-block[data-block-type="paragraph"]').last();
  await para.hover(); await wait(200);
  await para.locator('.ed-handle').click(); await wait(300);
  await page.evaluate(() => [...document.querySelectorAll('.ed-handle-menu-btn')].find((b) => b.textContent.trim() === 'MD 原始碼').click());
  await page.waitForSelector('textarea.ed-raw');
  await page.locator('textarea.ed-raw').press('End'); await page.keyboard.type(' RAW'); await wait(100);
  await page.locator('.ed-toolbar [data-ed-tb="undo"]').click(); await wait(1200);
  assert.strictEqual(await waveBlockText(page), painted,
    '↶ with uncommitted raw typing: the typing is the newer change, so the drawing stays');
}, { md: WAVE_SHELL_MD });
check('wave help: a paint drag has its own hint, and Esc cancels it', DESKTOP, async (page) => {
  await openWave(page);
  const a = await cellPress(page, 1, 1);
  const b = await cellPress(page, 1, 3);
  const lanes0 = await sourceNow(page);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 4 }); await wait(150);
  assert.strictEqual(await hintText(page), '放開就塗上這一段；Esc 取消', 'mid-drag');
  await page.keyboard.press('Escape'); await wait(150);
  await page.mouse.up(); await wait(300);
  assert.strictEqual(await waveOpen(page), true, 'Esc cancelled the drag, not the editor');
  assert.strictEqual(await sourceNow(page), lanes0, 'and nothing was painted');
}, { md: WAVE_SHELL_MD });
check('wave menus: arrow keys move within a menu', DESKTOP, async (page) => {
  await openWave(page);
  await page.locator('[data-focus-key="ed-wave-export-menu"]').click(); await wait(200);
  assert.strictEqual(await focusKey(page), 'ed-wave-export-copyimg', 'guard: the menu opens on its first item');
  const steps = [['ArrowDown', 'ed-wave-export-png'], ['ArrowDown', 'ed-wave-export-svg'], ['End', 'ed-wave-export-json'],
    ['ArrowDown', 'ed-wave-export-copyimg'], ['ArrowUp', 'ed-wave-export-json'], ['Home', 'ed-wave-export-copyimg']];
  for (const [key, want] of steps) {
    await page.keyboard.press(key); await wait(60);
    assert.strictEqual(await focusKey(page), want, key + ' in the 匯出 menu');
  }
  assert.strictEqual(await waveOpen(page), true, 'the keys moved focus and nothing else');
  await page.keyboard.press('Escape'); await wait(150);
  await page.locator('[data-focus-key="ed-wave-signal-menu"]').click(); await wait(200);
  assert.strictEqual(await focusKey(page), 'ed-wave-signal-add', 'guard: 訊號 opens on 新增訊號');
  await page.keyboard.press('ArrowDown'); await wait(60);
  assert.strictEqual(await focusKey(page), 'ed-wave-signal-blank', 'ArrowDown in the 訊號 menu');
  await page.keyboard.press('ArrowDown'); await wait(60);
  assert.strictEqual(await focusKey(page), 'ed-wave-signal-add', 'and it wraps');
}, { md: WAVE_SHELL_MD });
// Four lanes, so wherever the title pushes the drawing, the press still lands on some lane.
const WAVE_FLUSH_MD = waveDoc({ signal: [{ name: 'clk', wave: 'p.....' }, { name: 'a', wave: '01.0..' },
  { name: 'b', wave: '0.....' }, { name: 'c', wave: '0.....' }] });
check('wave settings: a press that closes the popover and writes a field does not paint', DESKTOP, async (page) => {
  await openWave(page);
  const lanes0 = JSON.stringify((await docNow(page)).signal);
  await openSettings(page);
  // 標題 has the keyboard; the text is typed but not written yet (no Enter).
  await page.keyboard.type('Title'); await wait(100);
  // A press on lane c cycle 4 (the brush, 1, would change any lane there) closes the popover,
  // which writes the title, and a title moves the whole drawing down under the pointer.
  const p = await cellPress(page, 3, 4);
  await page.mouse.click(p.x, p.y); await wait(400);
  const doc = await docNow(page);
  assert.strictEqual(await settingsPop(page), null, 'the press closed the popover');
  assert.strictEqual(doc.head && doc.head.text, 'Title', 'and wrote what was typed');
  const moved = await page.evaluate(() => window.__edWaveCellPoint(3, 4));
  assert.ok(moved.y > p.y + 10, 'guard: the title moved the drawing under the pointer ' + JSON.stringify([p.y, moved.y]));
  assert.strictEqual(JSON.stringify(doc.signal), lanes0, 'that same press painted nothing');
}, { md: WAVE_FLUSH_MD });

check('theme api: md2docTheme.recolourSvg recolours a detached wave svg with the given label backing', DESKTOP, async (page) => {
  await page.locator('#md2doc-theme-toggle').click(); await wait(300);
  const r = await page.evaluate(() => {
    const out = { api: typeof window.md2docTheme };
    if (!window.md2docTheme) return out;
    const host = document.createElement('div');
    host.id = 'md2doc-theme-api-test-0';
    document.body.appendChild(host);
    const src = { signal: [{ name: 'a', wave: 'p...', node: '.a.b' }], edge: ['a~>b lbl'] };
    const notFirst = document.querySelector('svg.WaveDrom defs #socket') !== null;
    WaveDrom.RenderWaveForm(0, src, 'md2doc-theme-api-test-', notFirst);
    const svg = host.querySelector('svg');
    const el = svg.querySelector('[id^="wavearcs"] g > rect');
    out.found = !!el;
    if (!el) return out;
    out.before = el.getAttribute('style');
    out.dark = window.md2docTheme.isDark();
    window.md2docTheme.recolourSvg(svg, true, { backing: 'rgb(1, 2, 3)' });
    out.fill = getComputedStyle(el).fill;
    window.md2docTheme.recolourSvg(svg, false);
    out.after = el.getAttribute('style');
    host.remove();
    return out;
  });
  assert.strictEqual(r.api, 'object', 'md2docTheme is exposed');
  assert.strictEqual(r.found, true, 'label backing rect exists');
  assert.strictEqual(r.dark, true);
  assert.strictEqual(r.fill, 'rgb(1, 2, 3)');
  assert.strictEqual(r.after, r.before, 'light restores the original style');
}, { md: FIXTURE + '\n\x60\x60\x60wavedrom\n{ "signal": [ { "name": "clk", "wave": "p...." } ] }\n\x60\x60\x60\n' });

check('icons: every toolbar button draws an svg and no emoji', DESKTOP, async (page) => {
  const r = await page.evaluate(() => [].map.call(document.querySelectorAll('.ed-toolbar-btn'), (b) => ({
    id: b.getAttribute('data-ed-tb'), svg: !!b.querySelector('svg'), text: b.textContent.trim(),
    vis: (() => { const q = b.getBoundingClientRect(); return q.right <= innerWidth && q.width > 0; })(),
  })));
  assert.ok(r.length >= 22, 'guard: toolbar present ' + r.length);
  assert.deepStrictEqual(r.filter((x) => !x.svg || x.text), [], 'buttons without svg or with glyph text');
  assert.deepStrictEqual(r.filter((x) => !x.vis).map((x) => x.id), [], 'buttons off screen at 1440');
});
check('icons: selection toolbar has six icon buttons and a divider before link', DESKTOP, async (page) => {
  const ed = page.locator('.ed-block[data-block-type="paragraph"] .ed-wys-armed').first();
  // dblclick on the first word, not the element centre (see the chrome: check).
  const box = await ed.boundingBox();
  await page.mouse.dblclick(box.x + 12, box.y + box.height / 2); await wait(400);
  const r = await page.evaluate(() => {
    const t = document.querySelector('.ed-seltb');
    const kids = [].map.call(t.children, (c) => c.classList.contains('ed-seltb-sep') ? '|' : (c.querySelector('svg') ? 'svg' : 'text'));
    return kids.join(',');
  });
  assert.strictEqual(r, 'svg,svg,svg,svg,svg,|,svg');
});
check('icons: gutter handle and plus are svg', DESKTOP, async (page) => {
  const p = page.locator('.ed-block[data-block-type="paragraph"]').first();
  await p.hover(); await wait(200);
  const r = await p.evaluate((e) => ({ h: !!e.querySelector('.ed-handle svg'), i: !!e.querySelector('.ed-insert svg') }));
  assert.deepStrictEqual(r, { h: true, i: true });
});

check('gutter: handle and plus are 24px and centred on the first text line', DESKTOP, async (page) => {
  // spec §9.2-3: a paragraph, an H1, an H2 and a list item.
  const kinds = ['h1', 'h2', 'paragraph', 'li'];
  for (const k of kinds) {
    const sel = /^h\d$/.test(k) ? '.ed-block[data-block-type="heading"]:has(> ' + k + ')' : '.ed-block[data-block-type="' + k + '"]';
    const blk = page.locator(sel).first();
    await blk.scrollIntoViewIfNeeded(); await blk.hover(); await wait(200);
    const r = await blk.evaluate((b) => {
      const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT, { acceptNode: (n) =>
        n.data.trim() && !n.parentElement.closest('.ed-handle, .ed-insert, .ed-li-marker') ? 1 : 3 });
      const t = walker.nextNode(); const rg = document.createRange(); rg.selectNodeContents(t);
      const line = rg.getClientRects()[0];
      const h = b.querySelector('.ed-handle').getBoundingClientRect();
      const i = b.querySelector('.ed-insert').getBoundingClientRect();
      const hit = document.elementFromPoint(h.left + h.width / 2, h.top + h.height / 2);
      return { lineMid: line.top + line.height / 2, hMid: h.top + h.height / 2, iMid: i.top + i.height / 2,
        hw: h.width, hh: h.height, hit: !!(hit && hit.closest('.ed-handle')) };
    });
    assert.strictEqual(r.hw, 24, k + ' handle width'); assert.strictEqual(r.hh, 24, k + ' handle height');
    assert.ok(Math.abs(r.hMid - r.lineMid) <= 2, k + ' handle off the first line ' + JSON.stringify(r));
    assert.ok(Math.abs(r.iMid - r.lineMid) <= 2, k + ' plus off the first line ' + JSON.stringify(r));
    assert.ok(r.hit, k + ' handle centre hits the handle');
  }
});

check('source mode: gone from the page', DESKTOP, async (page) => {
  const r = await page.evaluate(() => ({
    btn: !!document.querySelector('[data-ed-tb="preview"]'),
    attr: document.body.hasAttribute('data-ed-mode'),
    ta: !!document.querySelector('textarea.ed-source'),
    count: document.querySelectorAll('.ed-toolbar-btn').length,
  }));
  assert.deepStrictEqual(r, { btn: false, attr: false, ta: false, count: 22 });
});

check('save status: clean, dirty with save lit, then saved after Ctrl+S', DESKTOP, async (page, boot) => {
  const st = () => page.evaluate(() => {
    const s = document.querySelector('.ed-toolbar-status');
    const b = document.querySelector('[data-ed-tb="save"]');
    return { state: s.getAttribute('data-state'), text: s.textContent.trim(), pressed: b.getAttribute('aria-pressed'), role: s.getAttribute('role') };
  });
  let s = await st();
  assert.strictEqual(s.state, 'clean'); assert.ok(s.text.includes('已儲存'), s.text); assert.strictEqual(s.role, 'status');
  const ed = page.locator('.ed-block[data-block-type="paragraph"] .ed-wys-armed').first();
  await ed.click(); await page.keyboard.press('End'); await page.keyboard.type(' more');
  await page.locator('.ed-block[data-block-type="heading"]').last().click(); await wait(600);
  s = await st();
  assert.strictEqual(s.state, 'dirty'); assert.ok(s.text.includes('有未儲存的變更'), s.text); assert.strictEqual(s.pressed, 'true');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s'); await wait(800);
  s = await st();
  assert.strictEqual(s.state, 'clean');
  assert.ok(fs.readFileSync(boot.mdPath, 'utf8').includes('(https://example.com). more'), 'file saved');
});

check('messages: a failed save is a sticky error card under the toolbar', DESKTOP, async (page) => {
  await page.route('**/api/save', (r) => r.fulfill({ status: 500, body: 'boom' }));
  const ed = page.locator('.ed-block[data-block-type="paragraph"] .ed-wys-armed').first();
  await ed.click(); await page.keyboard.press('End'); await page.keyboard.type(' x');
  await page.locator('.ed-block[data-block-type="heading"]').last().click(); await wait(500);
  await page.keyboard.press('Control+s'); await wait(600);
  const err = await page.evaluate(() => {
    const e = document.querySelector('.ed-conflict[data-level="error"]');
    if (!e) return null;
    const r = e.getBoundingClientRect(); const tb = document.querySelector('.ed-toolbar').getBoundingClientRect();
    return { text: e.textContent, role: e.getAttribute('role'), belowBar: r.top >= tb.bottom, centred: Math.abs((r.left + r.right) / 2 - innerWidth / 2) < 4 };
  });
  assert.ok(err, 'error card present');
  assert.ok(err.text.includes('無法儲存'), err.text);
  assert.strictEqual(err.role, 'alert'); assert.ok(err.belowBar && err.centred, JSON.stringify(err));
  await wait(4500);
  assert.ok(!!(await page.$('.ed-conflict[data-level="error"]')), 'error card does not fade');
});
// Table edge menus, driven the way a person does: hover the row (or the
// header cell), press the grip that appears, press the menu entry.
const tableMenu = async (page, kind, target, label) => {
  await page.evaluate(() => document.querySelector('.ed-block[data-block-type="table"]').scrollIntoView({ block: 'center' }));
  const box = await target.boundingBox();
  await page.mouse.move(box.x + 12, box.y + box.height / 2); await wait(300);
  const g = await page.evaluate((k) => { const e = document.querySelector('.ed-te-grip-' + k); if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, kind);
  assert.ok(g, 'guard: the ' + kind + ' grip is showing');
  await page.mouse.click(g.x, g.y); await wait(300);
  await page.locator('.ed-te-menu button', { hasText: label }).click(); await wait(800);
};
// v3.11: deleting the LAST column is the one table delete that still refuses
// (a table needs a column; the table itself goes through ⠿ → 刪除), so it is
// the notice these message checks raise.
const refuseLastColumn = async (page) => {
  for (let i = 0; i < 2; i++) {
    await tableMenu(page, 'col', page.locator('.ed-block[data-block-type="table"] thead th').first(), '刪除欄');
  }
};
check('messages: a notice sits at the bottom and goes away by itself', DESKTOP, async (page) => {
  await refuseLastColumn(page);
  const n = await page.evaluate(() => {
    const e = document.querySelector('.ed-conflict[data-level="notice"]');
    if (!e) return null; const r = e.getBoundingClientRect();
    return { text: e.textContent, role: e.getAttribute('role'), bottom: innerHeight - r.bottom };
  });
  assert.ok(n, 'notice present'); assert.ok(n.text.includes('最後一欄'), n.text);
  assert.strictEqual(n.role, 'status'); assert.ok(n.bottom >= 16 && n.bottom <= 48, 'near the bottom ' + JSON.stringify(n));
  await wait(4600);
  assert.strictEqual(!!(await page.$('.ed-conflict[data-level="notice"]')), false, 'notice faded');
  await page.keyboard.press('Escape');
});
check('messages: after a notice fades, Esc still clears a block selection', DESKTOP, async (page) => {
  await refuseLastColumn(page);
  assert.ok(!!(await page.$('.ed-conflict[data-level="notice"]')), 'guard: the refusal notice appeared');
  await page.keyboard.press('Escape'); await wait(200);   // closes the table menu if still open
  await wait(4600);
  assert.strictEqual(!!(await page.$('.ed-conflict')), false, 'notice gone');
  const paras = page.locator('.ed-block[data-block-type="paragraph"]');
  await paras.nth(0).click({ modifiers: ['Shift'] }); await paras.nth(1).click({ modifiers: ['Shift'] }); await wait(300);
  const before = await page.evaluate(() => document.querySelectorAll('.ed-block.ed-selected').length);
  assert.ok(before >= 1, 'guard: a block selection exists ' + before);
  await page.keyboard.press('Escape'); await wait(300);
  const after = await page.evaluate(() => document.querySelectorAll('.ed-block.ed-selected').length);
  assert.strictEqual(after, 0, 'Esc cleared the selection after the notice faded');
});

check('external edit: a clean page reloads itself, a dirty one raises the conflict card', DESKTOP, async (page, boot) => {
  const t0 = Date.now();
  fs.writeFileSync(boot.mdPath, fs.readFileSync(boot.mdPath, 'utf8').replace('Second paragraph.', 'Second paragraph, edited outside.'));
  await page.waitForFunction(() => document.body.textContent.includes('edited outside'), null, { timeout: 15000 });
  assert.ok(Date.now() - t0 <= 13000, 'picked up within one ping');
  // The reload replaced the page: wait for the new one's editor before typing.
  await page.waitForSelector('.ed-toolbar'); await wait(400);
  const ed = page.locator('.ed-block[data-block-type="paragraph"] .ed-wys-armed').first();
  await ed.click(); await page.keyboard.press('End'); await page.keyboard.type(' local');
  fs.writeFileSync(boot.mdPath, fs.readFileSync(boot.mdPath, 'utf8') + '\nAppended outside.\n');
  await page.waitForSelector('.ed-conflict[data-level="error"]', { timeout: 15000 });
  const r = await page.evaluate(() => ({ text: document.querySelector('.ed-conflict').textContent, mine: document.body.textContent.includes(' local') }));
  assert.ok(r.text.includes('這個檔案剛在別處被修改'), r.text);
  assert.ok(r.mine, 'the unsaved edit is still on the page');
});

check('lists: bullets change by depth, checked items are struck, children are not', DESKTOP, async (page) => {
  const marks = await page.evaluate(() => [].map.call(document.querySelectorAll('.ed-block[data-list-type="ul"][data-task="0"] > .ed-li-marker'),
    (m) => getComputedStyle(m, '::before').content).slice(0, 3));
  assert.deepStrictEqual(marks, ['"•"', '"◦"', '"▪"']);
  const r = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.ed-block[data-task="1"]')];
    const done = items.find((b) => b.textContent.includes('done item'));
    const child = items.find((b) => b.textContent.includes('open child'));
    const box = done.querySelector('.ed-li-check');
    return { doneDeco: getComputedStyle(done.querySelector('.ed-li-text')).textDecorationLine,
      childDeco: getComputedStyle(child.querySelector('.ed-li-text')).textDecorationLine,
      boxW: box.getBoundingClientRect().width, boxBg: getComputedStyle(box).backgroundImage };
  });
  assert.strictEqual(r.doneDeco, 'line-through'); assert.strictEqual(r.childDeco, 'none');
  assert.strictEqual(Math.round(r.boxW), 16); assert.ok(r.boxBg.includes('svg'), 'check mark drawn');
});

check('mermaid: stays dark after an unrelated block is edited', DESKTOP, async (page) => {
  await page.locator('#md2doc-theme-toggle').click(); await wait(1200);
  const fill = () => page.evaluate(() => {
    const r = document.querySelector('.mermaid svg .node rect, .mermaid svg .node polygon');
    return r ? getComputedStyle(r).fill : null;
  });
  const before = await fill();
  assert.ok(before && before !== 'rgb(234, 242, 253)', 'guard: mermaid drawn dark ' + before);
  const ed = page.locator('.ed-block[data-block-type="paragraph"] .ed-wys-armed').last();
  await ed.click(); await page.keyboard.press('End'); await page.keyboard.type(' z');
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await wait(1500);
  assert.strictEqual(await fill(), before, 'mermaid kept its dark fill after a re-render');
});

check('lists: clicking a checkbox checks the item and strikes its text', DESKTOP, async (page) => {
  const item = page.locator('.ed-block[data-task="1"]', { hasText: 'open item' });
  const before = await item.evaluate((b) => b.querySelector('.ed-li-check').getAttribute('data-checked'));
  assert.strictEqual(before, '0', 'guard: the item starts unchecked');
  await item.locator('.ed-li-check').click(); await wait(800);
  const r = await page.locator('.ed-block[data-task="1"]', { hasText: 'open item' }).evaluate((b) => ({
    checked: b.querySelector('.ed-li-check').getAttribute('data-checked'),
    deco: getComputedStyle(b.querySelector('.ed-li-text')).textDecorationLine,
  }));
  assert.deepStrictEqual(r, { checked: '1', deco: 'line-through' });
  // Its own document: FIXTURE's two lists are separated by a blank line, which
  // marked reads as ONE loose list, and a loose run refuses structural edits
  // (batch 2 opens them) — a checkbox click there answers with that refusal.
}, { md: '# Tasks\n\n- [ ] open item\n- [ ] other item\n' });
check('external edit: not while the waveform editor is open, then right after it closes', DESKTOP, async (page, boot) => {
  const d = page.locator('.wavedrom-diagram').first();
  await d.scrollIntoViewIfNeeded(); await wait(300);
  const box = await d.boundingBox();
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await wait(300);
  await page.locator('.ed-wave-edit-btn').click(); await wait(800);
  assert.ok(!!(await page.$('.ed-wave-panel')), 'guard: the waveform editor is open');
  fs.writeFileSync(boot.mdPath, fs.readFileSync(boot.mdPath, 'utf8').replace('Second paragraph.', 'Second paragraph, edited outside.'));
  await wait(12500);   // more than one 10s ping
  const during = await page.evaluate(() => ({ open: !!document.querySelector('.ed-wave-panel'), seen: document.body.textContent.includes('edited outside') }));
  assert.deepStrictEqual(during, { open: true, seen: false }, 'no reload while the waveform editor is open');
  await page.locator('.ed-wave-close').click();
  const t0 = Date.now();
  await page.waitForFunction(() => document.body.textContent.includes('edited outside'), null, { timeout: 15000 });
  assert.ok(Date.now() - t0 <= 13000, 'picked up by the first ping after closing');
}, { md: FIXTURE + '\n\x60\x60\x60wavedrom\n{ "signal": [ { "name": "clk", "wave": "p...." } ] }\n\x60\x60\x60\n' });

check('external edit: typing in an open MD 原始碼 box counts as unsaved work', DESKTOP, async (page, boot) => {
  const para = page.locator('.ed-block[data-block-type="paragraph"]').last();
  await para.hover(); await wait(200);
  await para.locator('.ed-handle').click(); await wait(300);
  await page.evaluate(() => [...document.querySelectorAll('.ed-handle-menu-btn')].find((b) => b.textContent.trim() === 'MD 原始碼').click());
  await page.waitForSelector('textarea.ed-raw');
  await page.locator('textarea.ed-raw').press('End'); await page.keyboard.type(' RAWTYPED');
  fs.writeFileSync(boot.mdPath, fs.readFileSync(boot.mdPath, 'utf8') + '\nAppended outside.\n');
  await page.waitForSelector('.ed-conflict[data-level="error"]', { timeout: 15000 });
  const r = await page.evaluate(() => ({ ta: (document.querySelector('textarea.ed-raw') || {}).value || '' }));
  assert.ok(r.ta.includes('RAWTYPED'), 'the typed text is still in the box, not reloaded away: ' + JSON.stringify(r));
});

check('messages: a long error card uses the full 760px before it wraps', { width: 800, height: 600 }, async (page) => {
  // Regression guard: centring with left: 50% + translateX(-50%) capped a
  // fixed card at half the viewport, so a long message wrapped into a tall
  // card that covered the waveform editor's buttons.
  // Breakable text (CJK wraps anywhere): an unbreakable run would force the
  // card wide under either centring and prove nothing.
  const long = '伺服器拒絕了這次寫入，原因說明很長。'.repeat(12);
  await page.route('**/api/save', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: long }) }));
  const ed = page.locator('.ed-block[data-block-type="paragraph"] .ed-wys-armed').first();
  await ed.click(); await page.keyboard.press('End'); await page.keyboard.type(' x');
  await page.locator('.ed-block[data-block-type="heading"]').last().click(); await wait(500);
  await page.keyboard.press('Control+s'); await wait(600);
  const r = await page.evaluate(() => { const e = document.querySelector('.ed-conflict[data-level="error"]'); const q = e.getBoundingClientRect(); return { w: Math.round(q.width), mid: Math.round((q.left + q.right) / 2) }; });
  assert.strictEqual(r.w, 760, 'card width ' + JSON.stringify(r));
  assert.ok(Math.abs(r.mid - 400) <= 2, 'card centred ' + JSON.stringify(r));
});

const saveAndRead = async (page, boot) => { await page.keyboard.press('Control+s'); await wait(900); return fs.readFileSync(boot.mdPath, 'utf8'); };
check('tables: deleting every body row leaves a header-only table', DESKTOP, async (page, boot) => {
  for (let i = 0; i < 2; i++) await tableMenu(page, 'row', page.locator('.ed-block[data-block-type="table"] tbody tr').first(), '刪除列');
  const r = await page.evaluate(() => ({ rows: document.querySelectorAll('.ed-block[data-block-type="table"] tbody tr').length, notice: !!document.querySelector('.ed-conflict') }));
  assert.deepStrictEqual(r, { rows: 0, notice: false });
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await wait(500);
  const disk = await saveAndRead(page, boot);
  assert.ok(/\| *Signal *\| *Width *\|\n\|[-: |]+\|\n\n/.test(disk) && disk.indexOf('clk_tx') === -1, 'header-only table on disk: ' + disk);
});
check('tables: deleting the header row promotes the first body row', DESKTOP, async (page, boot) => {
  await tableMenu(page, 'row', page.locator('.ed-block[data-block-type="table"] thead tr'), '刪除列');
  const r = await page.evaluate(() => ({ head: [...document.querySelectorAll('.ed-block[data-block-type="table"] thead th')].map((c) => c.textContent.trim()), rows: document.querySelectorAll('.ed-block[data-block-type="table"] tbody tr').length, notice: !!document.querySelector('.ed-conflict') }));
  assert.deepStrictEqual(r, { head: ['clk_tx', '1'], rows: 1, notice: false });
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await wait(500);
  const disk = await saveAndRead(page, boot);
  assert.ok(/\| *`clk_tx` *\| *1 *\|\n\|[-: |]+\|\n\| *`rst_n` *\| *1 *\|/.test(disk) && disk.indexOf('Signal') === -1, 'promoted header on disk: ' + disk);
});
check('tables: deleting the header of a header-only table removes the table', DESKTOP, async (page, boot) => {
  await tableMenu(page, 'row', page.locator('.ed-block[data-block-type="table"] thead tr'), '刪除列');
  await wait(500);
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.ed-block[data-block-type="table"]').length), 0, 'table gone');
  const disk = await saveAndRead(page, boot);
  assert.strictEqual(disk, '# T\n\nBefore.\n\nAfter.\n');
}, { md: '# T\n\nBefore.\n\n| a | b |\n|---|---|\n\nAfter.\n' });
check('tables: the last column still refuses, and says how to remove the table', DESKTOP, async (page) => {
  await tableMenu(page, 'col', page.locator('.ed-block[data-block-type="table"] thead th').first(), '刪除欄');
  const t = await page.evaluate(() => (document.querySelector('.ed-conflict .ed-msg-text') || {}).textContent || '');
  assert.ok(t.includes('最後一欄') && t.includes('⠿'), t);
}, { md: '# T\n\n| a |\n|---|\n| 1 |\n' });

// ── table-menu (v3.15.0 T7) ──
// The tableMenu() sequence without the item press: hover the cell, press the
// grip that comes up. openColMenu() takes a header column index,
// openRowMenu() a row selector inside the first table.
const openTeMenuByGrip = async (page, kind, target) => {
  await page.evaluate(() => document.querySelector('.ed-block[data-block-type="table"]').scrollIntoView({ block: 'center' }));
  const box = await target.boundingBox();
  await page.mouse.move(box.x + 12, box.y + box.height / 2); await wait(300);
  const g = await page.evaluate((k) => { const e = document.querySelector('.ed-te-grip-' + k); if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, kind);
  assert.ok(g, 'guard: the ' + kind + ' grip is showing');
  await page.mouse.click(g.x, g.y); await wait(300);
};
const openColMenu = (page, colIndex) =>
  openTeMenuByGrip(page, 'col', page.locator('.ed-block[data-block-type="table"] thead th').nth(colIndex));
const openRowMenu = (page, rowSelector) =>
  openTeMenuByGrip(page, 'row', page.locator('.ed-block[data-block-type="table"] ' + rowSelector).first());
// The open menu as plain values: the visible items in order (a button's text,
// the alignment row as its three aria-labels joined by '|', separators left
// out), the pressed alignment, the keyboard cursor's label, and the boxes.
const teMenu = (page) => page.evaluate(() => {
  const m = document.querySelector('.ed-te-menu');
  const t = document.querySelector('.ed-block[data-block-type="table"] table');
  const shown = (el) => !!el && el.getClientRects().length > 0;
  const label = (el) => (el ? (el.getAttribute('aria-label') || el.textContent.trim()) : null);
  const open = !!m && !m.hidden && shown(m);
  const items = [];
  if (open) {
    for (const c of m.children) {
      if (!shown(c) || c.classList.contains('ed-te-menu-sep')) continue;
      if (c.classList.contains('ed-te-menu-align')) items.push([...c.querySelectorAll('button')].map(label).join('|'));
      else items.push(c.textContent.trim());
    }
  }
  const pressed = open ? [...m.querySelectorAll('[aria-pressed="true"]')].filter(shown) : [];
  const cur = open ? m.querySelector('[data-ed-te-cursor]') : null;
  const r = m ? m.getBoundingClientRect() : { left: 0, top: 0, right: 0, bottom: 0 };
  const tr = t ? t.getBoundingClientRect() : { left: 0, right: 0 };
  return {
    open, items, pressed: pressed.length ? label(pressed[0]) : null, cursor: label(cur),
    rect: { l: r.left, t: r.top, r: r.right, b: r.bottom }, tableRect: { l: tr.left, r: tr.right },
    vw: innerWidth, vh: innerHeight,
  };
});
const TBL_MD = '# D\n\n| A | B |\n|---|---|\n| a1 | b1 |\n| a2 | b2 |\n\nAfter.\n';
const tbodyRowCount = (page) => page.evaluate(() => document.querySelectorAll('.ed-block[data-block-type="table"] tbody tr').length);
check('table-menu: the column menu is a vertical list inside the table and the viewport', DESKTOP, async (page) => {
  await openColMenu(page, 1);
  const m = await teMenu(page);
  assert.deepStrictEqual(m.items, ['左側插入欄', '右側插入欄', '靠左|置中|靠右', '刪除欄']);
  assert.ok(m.rect.l >= m.tableRect.l - 1 && m.rect.r <= m.tableRect.r + 1, 'inside the table box horizontally (the table element is a full-width scroll box)');
  assert.ok(m.rect.t >= 0 && m.rect.b <= m.vh && m.rect.l >= 0 && m.rect.r <= m.vw, 'inside the viewport');
}, { md: TBL_MD });
check('table-menu: the column menu opens under the column grip at the column\'s left edge; the row menu right of the row grip at the row\'s top', DESKTOP, async (page) => {
  await openColMenu(page, 1);
  const c = await page.evaluate(() => {
    const m = document.querySelector('.ed-te-menu').getBoundingClientRect();
    const g = document.querySelector('.ed-te-grip-col').getBoundingClientRect();
    const th = document.querySelectorAll('.ed-block[data-block-type="table"] thead th')[1].getBoundingClientRect();
    return { dl: Math.round(m.left - th.left), below: m.top >= g.bottom - 0.5, near: m.top - g.bottom < 12 };
  });
  assert.deepStrictEqual(c, { dl: 0, below: true, near: true });
  await page.keyboard.press('Escape');
  await openRowMenu(page, 'tbody tr:nth-child(2)');
  const r = await page.evaluate(() => {
    const m = document.querySelector('.ed-te-menu').getBoundingClientRect();
    const g = document.querySelector('.ed-te-grip-row').getBoundingClientRect();
    const tr = document.querySelectorAll('.ed-block[data-block-type="table"] tbody tr')[1].getBoundingClientRect();
    return { dt: Math.round(m.top - tr.top), right: m.left >= g.right - 0.5, near: m.left - g.right < 12 };
  });
  assert.deepStrictEqual(r, { dt: 0, right: true, near: true });
}, { md: TBL_MD });
check('table-menu: 右側插入欄 / 左側插入欄 add a column at the right place', DESKTOP, async (page, boot) => {
  await openColMenu(page, 0); await page.locator('.ed-te-menu button', { hasText: '右側插入欄' }).click(); await wait(300);
  await openColMenu(page, 0); await page.locator('.ed-te-menu button', { hasText: '左側插入欄' }).click(); await wait(300);
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await renderIdle(page);
  const disk = await saveAndRead(page, boot);
  assert.ok(/\|\s*\|\s*A\s*\|\s*\|\s*B\s*\|\n/.test(disk), 'header order: new, A, new, B — ' + disk);
}, { md: TBL_MD });
check('table-menu: alignment is set directly and the menu stays open', DESKTOP, async (page, boot) => {
  await openColMenu(page, 1);
  await page.locator('.ed-te-menu button[aria-label="置中"]').click(); await wait(200);
  const m = await teMenu(page);
  assert.deepStrictEqual([m.open, m.pressed], [true, '置中']);
  await page.locator('.ed-te-menu button[aria-label="靠右"]').click(); await wait(200);
  const m2 = await teMenu(page);
  assert.deepStrictEqual([m2.open, m2.pressed], [true, '靠右']);
  await page.locator('.ed-te-menu button[aria-label="置中"]').click(); await wait(200);
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await renderIdle(page);
  assert.ok(/\|[-:]+\|:-+:\|/.test(await saveAndRead(page, boot)), 'column B centred');
}, { md: TBL_MD });
check('table-menu: the row menu inserts above and below; the header row has no 上方插入列', DESKTOP, async (page, boot) => {
  await openRowMenu(page, 'thead tr');
  assert.deepStrictEqual((await teMenu(page)).items, ['下方插入列', '刪除列']);
  await page.keyboard.press('Escape');
  await openRowMenu(page, 'tbody tr:nth-child(2)');
  assert.deepStrictEqual((await teMenu(page)).items, ['上方插入列', '下方插入列', '刪除列']);
  await page.locator('.ed-te-menu button', { hasText: '上方插入列' }).click(); await wait(300);
  assert.strictEqual(await tbodyRowCount(page), 3);
  await openRowMenu(page, 'thead tr');
  await page.locator('.ed-te-menu button', { hasText: '下方插入列' }).click(); await wait(300);
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await renderIdle(page);
  const disk = await saveAndRead(page, boot);
  assert.ok(/\| *A *\| *B *\|\n\|[-: |]+\|\n\| *\| *\|\n\| *a1 *\| *b1 *\|\n\| *\| *\|\n\| *a2 *\| *b2 *\|\n/.test(disk),
    'header, new, a1, new, a2 — ' + disk);
}, { md: TBL_MD });
check('table-menu: ↑↓ move, Enter runs, Esc closes', DESKTOP, async (page, boot) => {
  await openRowMenu(page, 'tbody tr:nth-child(1)');
  await page.keyboard.press('ArrowDown');
  assert.strictEqual((await teMenu(page)).cursor, '上方插入列');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await wait(300);   // 下方插入列
  assert.strictEqual(await tbodyRowCount(page), 3);
  await openRowMenu(page, 'tbody tr:nth-child(1)'); await page.keyboard.press('Escape');
  assert.strictEqual((await teMenu(page)).open, false);
}, { md: TBL_MD });
check('table-menu: the alignment row is three keyboard stops; ←→ move within it and Enter sets it', DESKTOP, async (page, boot) => {
  await openColMenu(page, 1);
  const cursors = [];
  for (let i = 0; i < 5; i++) { await page.keyboard.press('ArrowDown'); cursors.push((await teMenu(page)).cursor); }
  assert.deepStrictEqual(cursors, ['左側插入欄', '右側插入欄', '靠左', '置中', '靠右']);
  await page.keyboard.press('ArrowLeft');
  assert.strictEqual((await teMenu(page)).cursor, '置中');
  await page.keyboard.press('Enter'); await wait(200);
  const m = await teMenu(page);
  assert.deepStrictEqual([m.open, m.pressed, m.cursor], [true, '置中', '置中']);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  assert.strictEqual((await teMenu(page)).cursor, '刪除欄');
  await page.keyboard.press('Escape');
  assert.strictEqual((await teMenu(page)).open, false);
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await renderIdle(page);
  assert.ok(/\|[-:]+\|:-+:\|/.test(await saveAndRead(page, boot)), 'column B centred by the keyboard');
}, { md: TBL_MD });
check('table-menu: one menu insert is one undo step', DESKTOP, async (page) => {
  await openRowMenu(page, 'tbody tr:nth-child(1)');
  await page.locator('.ed-te-menu button', { hasText: '下方插入列' }).click(); await wait(300);
  assert.strictEqual(await tbodyRowCount(page), 3);
  await page.keyboard.press('Control+z'); await wait(300);
  assert.strictEqual(await tbodyRowCount(page), 2);
}, { md: TBL_MD });
check('table-menu: 刪除欄 is red', DESKTOP, async (page) => {
  await openColMenu(page, 1);
  const c = await page.evaluate(() => { const p = document.createElement('span'); p.style.color = 'var(--md-ed-err)'; document.body.appendChild(p); const w = getComputedStyle(p).color; p.remove(); return getComputedStyle(document.querySelector('.ed-te-menu-delete')).color === w; });
  assert.strictEqual(c, true);
}, { md: TBL_MD });
check('table-menu: on a phone the row menu stays inside the viewport and the table', PHONE, async (page) => {
  await openRowMenu(page, 'tbody tr:nth-child(1)');
  const m = await teMenu(page);
  assert.deepStrictEqual(m.items, ['上方插入列', '下方插入列', '刪除列']);
  assert.ok(m.rect.t >= 0 && m.rect.b <= m.vh && m.rect.l >= 0 && m.rect.r <= m.vw, 'inside the viewport ' + JSON.stringify(m));
  assert.ok(m.rect.l >= m.tableRect.l - 1 && m.rect.r <= m.tableRect.r + 1, 'inside the table box ' + JSON.stringify(m));
}, { md: TBL_MD });

// ── table-bar / table-tab (v3.15.0 T8) ──
// Both trailing bars and the grid as plain values. The grid is the header
// row's left/right/top and the last row's bottom (the table element itself is
// a full-width display:block scroll box).
const addBars = (page) => page.evaluate(() => {
  const box = (sel) => {
    const e = document.querySelector(sel);
    if (!e || e.hidden || !e.getClientRects().length) return { shown: false };
    const r = e.getBoundingClientRect();
    return { shown: true, l: r.left, r: r.right, t: r.top, b: r.bottom, h: r.height, w: r.width };
  };
  const t = document.querySelector('.ed-block[data-block-type="table"] table');
  const rows = t.querySelectorAll('tr');
  const hr = t.tHead.rows[0].getBoundingClientRect();
  const lr = rows[rows.length - 1].getBoundingClientRect();
  return { row: box('.ed-tb-addrow'), col: box('.ed-tb-addcol'), grid: { l: hr.left, r: hr.right, t: hr.top, b: lr.bottom }, tableRight: t.getBoundingClientRect().right };
});
const hoverFirstBodyCell = async (page) => {
  const box = await page.locator('.ed-block[data-block-type="table"] tbody td').first().boundingBox();
  await page.mouse.move(box.x + 5, box.y + 5); await wait(150);
};
// A real click at a bar's centre, after asserting the browser's own hit test
// answers the bar there.
const clickAddBar = async (page, kind) => {
  const sel = kind === 'row' ? '.ed-tb-addrow' : '.ed-tb-addcol';
  const p = await page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e || e.hidden) return null;
    const r = e.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, hit: !!hit && e.contains(hit) };
  }, sel);
  assert.ok(p && p.hit, 'guard: ' + sel + ' is up and answers its own centre ' + JSON.stringify(p));
  await page.mouse.click(p.x, p.y); await wait(300);
};
check('table-bar: hovering the table shows both bars along the grid', DESKTOP, async (page) => {
  await hoverFirstBodyCell(page);
  const b = await addBars(page);
  assert.deepStrictEqual([b.row.shown, b.col.shown], [true, true]);
  // R97: the bottom bar's height is the gap above the block under the table,
  // floored and kept within 8–22 px (22 with nothing below: its own check).
  const nextTop = await page.evaluate(() => [...document.querySelectorAll('.ed-block')].find((x) => x.textContent.trim() === 'After.').getBoundingClientRect().top);
  assert.strictEqual(b.row.h, Math.max(8, Math.min(22, Math.floor(nextTop - b.row.t))), 'row bar height ' + JSON.stringify({ row: b.row, nextTop }));
  assert.ok(b.row.b <= nextTop, 'row bar ends above the next block');
  assert.strictEqual(b.col.w, 22);
  assert.ok(Math.abs(b.row.l - b.grid.l) <= 1 && Math.abs(b.row.r - b.grid.r) <= 1 && b.row.t >= b.grid.b, 'row bar under the grid, same width ' + JSON.stringify(b));
  assert.ok(b.col.l >= b.grid.r - 1 && Math.abs(b.col.t - b.grid.t) <= 1 && Math.abs(b.col.b - b.grid.b) <= 1, 'col bar right of the grid, same height ' + JSON.stringify(b));
}, { md: TBL_MD });
check('table-bar: bars hide 300 ms after the pointer leaves', DESKTOP, async (page) => {
  await hoverFirstBodyCell(page);
  await page.mouse.move(5, 5); await wait(100);
  assert.strictEqual((await addBars(page)).row.shown, true, 'still shown at 100 ms');
  await wait(350);
  const b = await addBars(page);
  assert.deepStrictEqual([b.row.shown, b.col.shown], [false, false]);
}, { md: TBL_MD });
check('table-bar: the bottom bar adds a row with the caret in its first cell', DESKTOP, async (page, boot) => {
  await hoverFirstBodyCell(page);
  await clickAddBar(page, 'row');
  assert.strictEqual(await tbodyRowCount(page), 3);
  await page.keyboard.type('z');
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await renderIdle(page);
  const disk = await saveAndRead(page, boot);
  assert.ok(/\| *a2 *\| *b2 *\|\n\| *z *\| *\|\n\nAfter\./.test(disk), 'a third body row starting with z — ' + disk);
}, { md: TBL_MD });
check('table-bar: the right bar adds a column with the caret in its header cell', DESKTOP, async (page, boot) => {
  await hoverFirstBodyCell(page);
  await clickAddBar(page, 'col');
  await page.keyboard.type('C');
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await renderIdle(page);
  const disk = await saveAndRead(page, boot);
  assert.ok(/\| *A *\| *B *\| *C *\|\n/.test(disk), 'header row reads | A | B | C | — ' + disk);
  assert.ok(/\| *a1 *\| *b1 *\| *\|\n\| *a2 *\| *b2 *\| *\|\n/.test(disk), 'every body row gained an empty cell — ' + disk);
}, { md: TBL_MD });
check('table-bar: one bar click is one undo step', DESKTOP, async (page) => {
  await hoverFirstBodyCell(page);
  await clickAddBar(page, 'row');
  await hoverFirstBodyCell(page);
  await clickAddBar(page, 'row');
  assert.strictEqual(await tbodyRowCount(page), 4);
  await page.keyboard.press('Control+z'); await wait(300);
  assert.strictEqual(await tbodyRowCount(page), 3);
}, { md: TBL_MD });
check('table-bar: on a wide scrolled table the right bar sits at the visible right edge', DESKTOP, async (page) => {
  const wide = await page.evaluate(() => { const t = document.querySelector('.ed-block[data-block-type="table"] table'); return t.scrollWidth > t.clientWidth + 50; });
  assert.strictEqual(wide, true, 'guard: the table scrolls horizontally');
  await hoverFirstBodyCell(page);
  const b = await addBars(page);
  assert.strictEqual(b.col.shown, true);
  assert.ok(b.col.l <= b.tableRight + 1 && b.col.r <= await page.evaluate(() => innerWidth), 'col bar at the visible right edge ' + JSON.stringify(b));
  assert.ok(b.row.r <= b.tableRight + 1, 'row bar clipped to the visible box ' + JSON.stringify(b));
}, { md: '# D\n\n' + '| ' + Array.from({ length: 14 }, (_, i) => 'column_header_' + i).join(' | ') + ' |\n|' + '---|'.repeat(14) + '\n| ' + Array.from({ length: 14 }, () => 'cell_value_long').join(' | ') + ' |\n' });
check('table-tab: Tab in the last cell adds a row; Shift+Tab in the first cell still leaves', DESKTOP, async (page, boot) => {
  await page.locator('.ed-block[data-block-type="table"] tbody tr:last-child td:last-child').click();
  await page.keyboard.press('Tab'); await wait(200);
  assert.strictEqual(await tbodyRowCount(page), 3);
  await page.keyboard.type('n');
  await page.locator('.ed-block[data-block-type="table"] thead th').first().click();
  await page.keyboard.press('Shift+Tab'); await renderIdle(page);
  assert.strictEqual(await page.evaluate(() => document.activeElement.closest('.ed-block').getAttribute('data-block-type')), 'heading');
  assert.ok(/\| *n *\| *\|\n\nAfter\./.test(await saveAndRead(page, boot)));
}, { md: TBL_MD });
check('table-tab: the row Tab adds is one undo step', DESKTOP, async (page) => {
  await page.locator('.ed-block[data-block-type="table"] tbody tr:last-child td:last-child').click();
  await page.keyboard.press('Tab'); await wait(200);
  const r = await page.evaluate(() => ({ rows: document.querySelectorAll('.ed-block[data-block-type="table"] tbody tr').length, inNewFirstCell: document.activeElement === document.querySelector('.ed-block[data-block-type="table"] tbody tr:last-child td:first-child') }));
  assert.deepStrictEqual(r, { rows: 3, inNewFirstCell: true });
  await page.keyboard.press('Control+z'); await wait(300);
  assert.strictEqual(await tbodyRowCount(page), 2);
}, { md: TBL_MD });

// ⠿ menu, the way a person drives it. `path` is the menu entry, or
// ['轉換成', '<target>'] for the convert submenu.
const blockByText = (page, text) => page.evaluate((t) => {
  const b = [...document.querySelectorAll('.ed-block')].find((x) => (x.textContent || '').includes(t));
  return b ? '.ed-block[data-block-id="' + b.getAttribute('data-block-id') + '"]' : null;
}, text);
const gutterMenu = async (page, sel, path) => {
  await page.hover(sel); await wait(150);
  await page.click(sel + ' > .ed-handle'); await wait(300);
  const steps = Array.isArray(path) ? path : [path];
  for (const label of steps) {
    await page.evaluate((l) => [...document.querySelectorAll('.ed-handle-menu-btn')].find((b) => b.textContent.trim() === l || b.textContent.trim().startsWith(l + ' ')).click(), label);
    await wait(500);
  }
};
const noticeText = (page) => page.evaluate(() => (document.querySelector('.ed-conflict .ed-msg-text') || {}).textContent || null);
const WRAP_MD = '# D\n\n- alpha is a long item\n  that wraps onto a second line\n- bravo\n';
check('wrapped items: ⠿ 刪除 removes a hard-wrapped item', DESKTOP, async (page, boot) => {
  await gutterMenu(page, await blockByText(page, 'alpha'), '刪除');
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- bravo\n');
}, { md: WRAP_MD });
check('wrapped items: ⠿ 建立副本 copies a hard-wrapped item byte for byte', DESKTOP, async (page, boot) => {
  await gutterMenu(page, await blockByText(page, 'alpha'), '建立副本');
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot),
    '# D\n\n- alpha is a long item\n  that wraps onto a second line\n- alpha is a long item\n  that wraps onto a second line\n- bravo\n');
}, { md: WRAP_MD });
check('wrapped items: 轉換成 文字 keeps both lines', DESKTOP, async (page, boot) => {
  await gutterMenu(page, await blockByText(page, 'alpha'), ['轉換成', '文字']);
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nalpha is a long item\nthat wraps onto a second line\n\n- bravo\n');
}, { md: WRAP_MD });
check('wrapped items: 轉換成 編號列表 re-indents the continuation', DESKTOP, async (page, boot) => {
  await gutterMenu(page, await blockByText(page, 'alpha'), ['轉換成', '編號列表']);
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n1. alpha is a long item\n   that wraps onto a second line\n- bravo\n');
}, { md: WRAP_MD });

// Shift-click two blocks: everything between them becomes the block selection.
const selectBlocks = async (page, fromText, toText) => {
  for (const t of [fromText, toText]) {
    const sel = await blockByText(page, t);
    const r = await page.evaluate((q) => { const e = document.querySelector(q); e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.left + Math.min(40, b.width / 2), y: b.top + b.height / 2 }; }, sel);
    await page.keyboard.down('Shift'); await page.mouse.click(r.x, r.y); await page.keyboard.up('Shift');
    await wait(200);
  }
  return page.evaluate(() => document.querySelectorAll('.ed-block.ed-selected').length);
};
const MIX_MD = '# D\n\nIntro.\n\n- alpha\n- bravo\n- charlie\n\nOutro.\n';
check('mixed delete: a paragraph plus the top of a list', DESKTOP, async (page, boot) => {
  assert.strictEqual(await selectBlocks(page, 'Intro', 'bravo'), 3, 'guard: three blocks selected');
  await gutterMenu(page, await blockByText(page, 'Intro'), '刪除');
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- charlie\n\nOutro.\n');
}, { md: MIX_MD });
check('mixed delete: the bottom of a list plus a paragraph', DESKTOP, async (page, boot) => {
  assert.strictEqual(await selectBlocks(page, 'bravo', 'Outro'), 3, 'guard: three blocks selected');
  await gutterMenu(page, await blockByText(page, 'Outro'), '刪除');
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nIntro.\n\n- alpha\n');
}, { md: MIX_MD });
check('mixed delete: across two lists, the survivors join', DESKTOP, async (page, boot) => {
  assert.strictEqual(await selectBlocks(page, 'a2', 'b1'), 3, 'guard: three blocks selected');
  await gutterMenu(page, await blockByText(page, 'Mid'), '刪除');
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- a1\n- b2\n');
  await page.keyboard.press('Control+z'); await wait(600);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- a1\n- a2\n\nMid.\n\n- b1\n- b2\n', 'one undo step restores it all');
}, { md: '# D\n\n- a1\n- a2\n\nMid.\n\n- b1\n- b2\n' });
check('mixed delete: items of two adjacent lists', DESKTOP, async (page, boot) => {
  assert.strictEqual(await selectBlocks(page, 'a2', 'b1'), 2, 'guard: two items selected');
  await gutterMenu(page, await blockByText(page, 'a2'), '刪除');
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- a1\n1. b2\n');
}, { md: '# D\n\n- a1\n- a2\n1. b1\n2. b2\n' });

check('mixed duplicate: a paragraph plus the top of a list', DESKTOP, async (page, boot) => {
  assert.strictEqual(await selectBlocks(page, 'Intro', 'bravo'), 3, 'guard: three blocks selected');
  await gutterMenu(page, await blockByText(page, 'Intro'), '建立副本');
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot),
    '# D\n\nIntro.\n\n- alpha\n- bravo\n\nIntro.\n\n- alpha\n- bravo\n- charlie\n\nOutro.\n');
}, { md: MIX_MD });
check('mixed duplicate: the bottom of a list plus a paragraph', DESKTOP, async (page, boot) => {
  assert.strictEqual(await selectBlocks(page, 'bravo', 'Outro'), 3, 'guard: three blocks selected');
  await gutterMenu(page, await blockByText(page, 'Outro'), '建立副本');
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot),
    '# D\n\nIntro.\n\n- alpha\n- bravo\n- charlie\n\nOutro.\n\n- bravo\n- charlie\n\nOutro.\n');
}, { md: MIX_MD });
check('mixed duplicate: items of two adjacent lists', DESKTOP, async (page, boot) => {
  assert.strictEqual(await selectBlocks(page, 'a2', 'b1'), 2, 'guard: two items selected');
  await gutterMenu(page, await blockByText(page, 'a2'), '建立副本');
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- a1\n- a2\n1. b1\n- a2\n1. b1\n2. b2\n');
}, { md: '# D\n\n- a1\n- a2\n1. b1\n2. b2\n' });

check('mixed convert: a paragraph plus list items to 文字', DESKTOP, async (page, boot) => {
  assert.strictEqual(await selectBlocks(page, 'Intro', 'bravo'), 3, 'guard: three blocks selected');
  await gutterMenu(page, await blockByText(page, 'Intro'), ['轉換成', '文字']);
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nIntro.\n\nalpha\n\nbravo\n\n- charlie\n\nOutro.\n');
}, { md: MIX_MD });
check('mixed convert: a paragraph plus list items to 編號列表', DESKTOP, async (page, boot) => {
  assert.strictEqual(await selectBlocks(page, 'Intro', 'bravo'), 3, 'guard: three blocks selected');
  await gutterMenu(page, await blockByText(page, 'Intro'), ['轉換成', '編號列表']);
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n1. Intro.\n2. alpha\n3. bravo\n- charlie\n\nOutro.\n');
}, { md: MIX_MD });
check('mixed convert: a table in the selection is skipped, the rest converts', DESKTOP, async (page, boot) => {
  assert.strictEqual(await selectBlocks(page, 'alpha', 'bravo'), 3, 'guard: three blocks selected');
  await gutterMenu(page, await blockByText(page, 'alpha'), ['轉換成', '引用']);
  const n = await noticeText(page);
  assert.ok(n && n.includes('略過') && n.includes('表格'), 'a notice says the table was skipped: ' + n);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n> alpha\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> bravo\n');
}, { md: '# D\n\nalpha\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nbravo\n' });
check('mixed convert: items of two adjacent lists', DESKTOP, async (page, boot) => {
  assert.strictEqual(await selectBlocks(page, 'a2', 'b1'), 2, 'guard: two items selected');
  await gutterMenu(page, await blockByText(page, 'a2'), ['轉換成', '項目符號列表']);
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- a1\n- a2\n- b1\n1. b2\n');
}, { md: '# D\n\n- a1\n- a2\n1. b1\n2. b2\n' });

check('mixed convert: nested items keep their nesting in a list target', DESKTOP, async (page, boot) => {
  assert.strictEqual(await selectBlocks(page, 'Intro', 'a1'), 3, 'guard: three blocks selected');
  await gutterMenu(page, await blockByText(page, 'Intro'), ['轉換成', '項目符號列表']);
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- Intro.\n- a\n  - a1\n- b\n');
}, { md: '# D\n\nIntro.\n\n- a\n  - a1\n- b\n' });

check('mixed Tab: list items indent and the heading goes one level deeper, one undo step', DESKTOP, async (page, boot) => {
  assert.strictEqual(await selectBlocks(page, 'b', 'Sec'), 2, 'guard: two blocks selected');
  await page.keyboard.press('Tab'); await wait(600);
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- a\n  - b\n\n### Sec\n');
  await page.keyboard.press('Escape'); await wait(200);
  await page.keyboard.press('Control+z'); await wait(600);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- a\n- b\n\n## Sec\n', 'one undo step');
}, { md: '# D\n\n- a\n- b\n\n## Sec\n' });
check('mixed Tab: items of two adjacent lists indent together', DESKTOP, async (page, boot) => {
  assert.strictEqual(await selectBlocks(page, 'b', 'c'), 2, 'guard: two items selected');
  await page.keyboard.press('Tab'); await wait(600);
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  // v3.17.3 A9 (R5): c keeps its `*`. It was a list of its own beside b's
  // and stays one, now nested under a beside b's (before, it was rewritten
  // `- c` and the two merged into one list).
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- a\n  - b\n  * c\n');
  await renderIdle(page);
  assert.deepStrictEqual(await page.evaluate(() => [...document.querySelectorAll('.ed-block[data-block-type="li"]')]
    .map((x) => x.getAttribute('data-indent') + ':' + x.querySelector('.ed-li-text').textContent)), ['0:a', '1:b', '1:c'],
  'both items are nested under a');
}, { md: '# D\n\n- a\n- b\n* c\n' });

// Press a block's ⠿ and drop it before the block holding `destText`, or
// below the last block when `destText` is null.
const dragBlock = async (page, srcText, destText) => {
  const src = await blockByText(page, srcText);
  await page.hover(src); await wait(150);
  const h = await page.evaluate((q) => { const b = document.querySelector(q + ' > .ed-handle').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, src);
  let y;
  if (destText === null) {
    y = await page.evaluate(() => { const all = document.querySelectorAll('.content .ed-block'); return all[all.length - 1].getBoundingClientRect().bottom - 2; });
  } else {
    const dst = await blockByText(page, destText);
    y = await page.evaluate((q) => document.querySelector(q).getBoundingClientRect().top + 3, dst);
  }
  await page.mouse.move(h.x, h.y); await page.mouse.down();
  await page.mouse.move(h.x, (h.y + y) / 2, { steps: 6 });
  await page.mouse.move(h.x, y, { steps: 6 }); await wait(150);
  await page.mouse.up(); await wait(700);
};
check('drag: a paragraph dropped into the middle of a list splits it', DESKTOP, async (page, boot) => {
  await dragBlock(page, 'Para', 'b');
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- a\n\nPara.\n\n- b\n- c\n');
}, { md: '# D\n\nPara.\n\n- a\n- b\n- c\n' });
check('drag: a list item dragged out of its list', DESKTOP, async (page, boot) => {
  await dragBlock(page, 'a', null);
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- b\n\nEnd.\n\n- a\n');
}, { md: '# D\n\n- a\n- b\n\nEnd.\n' });
check('drag: moving the paragraph between two lists joins them', DESKTOP, async (page, boot) => {
  await dragBlock(page, 'Mid', null);
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- a\n- b\n\nEnd.\n\nMid.\n');
  await page.keyboard.press('Control+z'); await wait(600);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- a\n\nMid.\n\n- b\n\nEnd.\n', 'one undo step');
}, { md: '# D\n\n- a\n\nMid.\n\n- b\n\nEnd.\n' });
check('drag: a list item dropped into another list joins it', DESKTOP, async (page, boot) => {
  await dragBlock(page, 'a1', 'b2');
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- a2\n\nMid.\n\n- b1\n- a1\n- b2\n');
}, { md: '# D\n\n- a1\n- a2\n\nMid.\n\n- b1\n- b2\n' });
check('drag: a paragraph plus a list item move together', DESKTOP, async (page, boot) => {
  assert.strictEqual(await selectBlocks(page, 'Para', 'alpha'), 2, 'guard: two blocks selected');
  await dragBlock(page, 'Para', null);
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- bravo\n\nEnd.\n\nPara.\n\n- alpha\n');
}, { md: '# D\n\nPara.\n\n- alpha\n- bravo\n\nEnd.\n' });
check('drag: a parent item takes its children along', DESKTOP, async (page, boot) => {
  await dragBlock(page, 'p', null);
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- q\n\nEnd.\n\n- p\n  - c\n');
}, { md: '# D\n\n- p\n  - c\n- q\n\nEnd.\n' });

// A loose list: a blank line between every item.
const LOOSE_MD = '# D\n\n- alpha\n\n- bravo\n\n- charlie\n';
const liText = (page, t) => page.locator('.ed-block[data-block-type="li"]', { hasText: t }).locator('.ed-li-text');
check('loose lists: an item is typed into in place, the blank lines stay', DESKTOP, async (page, boot) => {
  await liText(page, 'bravo').click(); await page.keyboard.press('End'); await page.keyboard.type('X');
  // A boolean, never the handle itself: a failing assert inspects `actual`,
  // and inspecting a Playwright ElementHandle walked its whole object graph
  // until node ran the machine out of memory (measured: 20 GB, global OOM).
  assert.strictEqual(!!(await page.$('textarea.ed-raw')), false, 'no source box');
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await wait(600);
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- alpha\n\n- bravoX\n\n- charlie\n');
}, { md: LOOSE_MD });
check('loose lists: a checkbox toggles', DESKTOP, async (page, boot) => {
  await page.locator('.ed-block[data-task="1"]', { hasText: 'bravo' }).locator('.ed-li-check').click(); await wait(800);
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- [ ] alpha\n\n- [x] bravo\n\n- [ ] charlie\n');
}, { md: '# D\n\n- [ ] alpha\n\n- [ ] bravo\n\n- [ ] charlie\n' });
// v3.17.0 T10 (N2): the press leaves focus where it was, and the toggle's
// resolution used to drop it on BODY. Measured at 4b2e86e: BODY.
check('lists: a checkbox click keeps the caret where it was (N2)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 3);
  await page.locator('.ed-block[data-task="1"]', { hasText: 'two' }).locator('.ed-li-check').click();
  await renderIdle(page); await wait(300);
  assert.deepStrictEqual(await caretNow(page), { text: 'Alpha.', offset: 3, transient: false }, 'the caret is where it was');
  await page.keyboard.type('z');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpzha.\n\n- [ ] one\n- [x] two\n');
}, { md: '# D\n\nAlpha.\n\n- [ ] one\n- [ ] two\n' });
check('loose lists: ⠿ 刪除 removes an item and its blank line', DESKTOP, async (page, boot) => {
  await gutterMenu(page, await blockByText(page, 'bravo'), '刪除');
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- alpha\n\n- charlie\n');
}, { md: LOOSE_MD });
check('loose lists: Enter starts a new item that keeps the spacing', DESKTOP, async (page, boot) => {
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('new'); await renderIdle(page);
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await wait(600);
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- alpha\n\n- bravo\n\n- new\n\n- charlie\n');
}, { md: LOOSE_MD });
check('loose lists: Tab nests an item', DESKTOP, async (page, boot) => {
  await liText(page, 'charlie').click(); await page.keyboard.press('End');
  await page.keyboard.press('Tab'); await wait(400);
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await wait(600);
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- alpha\n\n- bravo\n\n  - charlie\n');
}, { md: LOOSE_MD });

// ── enter-type (v3.13.1 T1): keys typed while a list commit renders ──
// None of these waits between the structural key and the first character:
// that gap is exactly what a person typing at speed leaves. `delayRender`
// widens the commit's in-flight window to 800 ms so every keystroke is
// guaranteed to fall inside it.
const TIGHT_MD = '# D\n\n- alpha\n- bravo\n- charlie\n';
async function commitAndRead(page, boot) {
  await renderIdle(page);
  await page.locator('.ed-block[data-block-type="heading"]').first().click();
  await renderIdle(page);
  return saveAndRead(page, boot);
}
check('enter-type: tight list, type right after Enter', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('new');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- new\n- charlie\n');
  assert.strictEqual(await noticeText(page), null, 'no notice');
}, { md: TIGHT_MD });
check('enter-type: loose list, type right after Enter', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('new');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n\n- bravo\n\n- new\n\n- charlie\n');
  assert.strictEqual(await noticeText(page), null, 'no notice');
}, { md: LOOSE_MD });
check('enter-type: a mid-item split puts the typed text before the tail', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click();
  const placed = await page.evaluate(() => {
    const s = [...document.querySelectorAll('.ed-li-text')].find((e) => e.textContent === 'bravo');
    const n = s && s.firstChild;
    if (!n || n.nodeType !== 3) return false;
    getSelection().setBaseAndExtent(n, 3, n, 3);
    return true;
  });
  assert.strictEqual(placed, true, 'guard: caret placed after "bra"');
  await page.keyboard.press('Enter'); await page.keyboard.type('X');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bra\n- Xvo\n- charlie\n');
  assert.strictEqual(await noticeText(page), null, 'no notice');
}, { md: TIGHT_MD });
check('enter-type: two Enters and two words with no waits', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('x');
  await page.keyboard.press('Enter'); await page.keyboard.type('y');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- x\n- y\n- charlie\n');
  assert.strictEqual(await noticeText(page), null, 'no notice');
}, { md: TIGHT_MD });
check('enter-type: Tab then type lands in the indented item', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Tab'); await page.keyboard.type('Z');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n  - bravoZ\n- charlie\n');
  assert.strictEqual(await noticeText(page), null, 'no notice');
}, { md: TIGHT_MD });
const BIG_PARAS = [];
for (let i = 0; i < 400; i++) BIG_PARAS.push('Para ' + i + ' ' + 'lorem ipsum dolor sit amet '.repeat(6));
const BIG_LIST_MD = '# D\n\n' + BIG_PARAS.join('\n\n') + '\n\n- alpha\n- bravo\n- charlie\n';
check('enter-type: a large document without an artificial delay', DESKTOP, async (page, boot) => {
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('new');
  const disk = await commitAndRead(page, boot);
  const want = BIG_LIST_MD.replace('- bravo\n', '- bravo\n- new\n');
  const tailAt = (s) => s.slice(s.lastIndexOf('Para 399 '));
  assert.strictEqual(tailAt(disk), tailAt(want));
  assert.strictEqual(disk.length, want.length, 'nothing else in the file moved');
  assert.strictEqual(await noticeText(page), null, 'no notice');
}, { md: BIG_LIST_MD });
check('enter-type: an IME character composed during the render lands in the new item', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'ㄋ', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.insertText', { text: '你' });
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- 你\n- charlie\n');
  assert.strictEqual(await noticeText(page), null, 'no notice');
}, { md: TIGHT_MD, engines: ['chromium'] });
check('enter-type: a failed render still shows the buffered characters', DESKTOP, async (page) => {
  let first = true;
  await page.route('**/api/render', async (route) => {
    if (!first) { await route.continue(); return; }
    first = false;
    await wait(800);
    await route.fulfill({ status: 500, body: '{}' });
  });
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('new');
  await renderIdle(page);
  const texts = await page.evaluate(() => [...document.querySelectorAll('.ed-li-text')].map((e) => e.textContent));
  assert.deepStrictEqual(texts, ['alpha', 'bravo', 'new', 'charlie'], 'the buffered characters are on screen');
}, { md: TIGHT_MD });
// A composition's text is in the DOM before compositionend can hold it. A
// failed render keeps that DOM, so unless the guard takes it back out, the
// replay shows it a second time.
check('enter-type: a character composed during a failed render shows once', DESKTOP, async (page) => {
  let first = true;
  await page.route('**/api/render', async (route) => {
    if (!first) { await route.continue(); return; }
    first = false;
    await wait(800);
    await route.fulfill({ status: 500, body: '{}' });
  });
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'ㄋ', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.insertText', { text: '你' });
  await renderIdle(page);
  const texts = await page.evaluate(() => [...document.querySelectorAll('.ed-li-text')].map((e) => e.textContent));
  assert.deepStrictEqual(texts, ['alpha', 'bravo', '你', 'charlie']);
}, { md: TIGHT_MD, engines: ['chromium'] });

// ── enter-type, fix round 1: held keys go where they were typed ──
// Clicks the character at `offset` of the surface whose text is exactly
// `text`, on its left half, so the caret lands BEFORE that character — a real
// pointer press, which is what moves focus mid-flight.
async function clickChar(page, text, offset) {
  const pt = await page.evaluate(([t, o]) => {
    const s = [...document.querySelectorAll('.ed-wys-armed, .ed-wys-cell')].find((e) => e.textContent === t);
    if (!s) return null;
    const w = document.createTreeWalker(s, NodeFilter.SHOW_TEXT);
    let left = o;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (left < n.data.length) {
        const r = document.createRange(); r.setStart(n, left); r.setEnd(n, left + 1);
        const b = r.getBoundingClientRect();
        return [b.left + 1, b.top + b.height / 2];
      }
      left -= n.data.length;
    }
    return null;
  }, [text, offset]);
  assert.ok(pt, 'clickChar: no surface with text ' + JSON.stringify(text));
  await page.mouse.click(pt[0], pt[1]);
}
const LIST_PARA_MD = '# D\n\n- alpha\n- bravo\n- charlie\n\nOmega.\n';
const P3_MD = '# D\n\nAlpha para one.\n\nBravo paragraph text.\n\nOmega.\n';
const liTexts = (page) => page.evaluate(() => [...document.querySelectorAll('.ed-li-text')].map((e) => e.textContent));
check('enter-type: keys typed after clicking another paragraph mid-render go to that paragraph', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('ab');
  await clickChar(page, 'Omega.', 2); await page.keyboard.type('c');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- ab\n- charlie\n\nOmcega.\n');
  assert.strictEqual(await noticeText(page), null, 'no notice');
}, { md: LIST_PARA_MD });
check('enter-type: a click into another paragraph mid-render keeps the caret there', DESKTOP, async (page) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('ab');
  await clickChar(page, 'Omega.', 2);
  await renderIdle(page);
  const where = await page.evaluate(() => {
    const s = getSelection();
    const surf = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement).closest('.ed-wys-armed');
    return surf ? [surf.textContent, s.anchorOffset] : null;
  });
  assert.deepStrictEqual(where, ['Omega.', 2], 'the caret stays where the click put it');
}, { md: LIST_PARA_MD });
check('caret: a click mid-paragraph after editing another lands at the click', DESKTOP, async (page, boot) => {
  await clickChar(page, 'Alpha para one.', 14); await page.keyboard.press('End');
  await page.keyboard.type('1');
  await clickChar(page, 'Bravo paragraph text.', 5);
  await renderIdle(page); await wait(300);
  await page.keyboard.type('ZZ');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha para one.1\n\nBravoZZ paragraph text.\n\nOmega.\n');
}, { md: P3_MD });
check('caret: keys typed right after that click land at the click', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await clickChar(page, 'Alpha para one.', 14); await page.keyboard.press('End');
  await page.keyboard.type('1');
  await clickChar(page, 'Bravo paragraph text.', 5);
  await page.keyboard.type('ZZ');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha para one.1\n\nBravoZZ paragraph text.\n\nOmega.\n');
}, { md: P3_MD });
check('enter-type: an arrow key mid-render moves within the held text', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await clickChar(page, 'Alpha para one.', 14); await page.keyboard.press('End');
  await page.keyboard.type('1');
  await clickChar(page, 'Bravo paragraph text.', 5);
  await page.keyboard.type('ab'); await page.keyboard.press('ArrowLeft'); await page.keyboard.type('c');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha para one.1\n\nBravoacb paragraph text.\n\nOmega.\n');
}, { md: P3_MD });
// ── fix round 2: a held key belongs to the surface, the selection and the
// navigation it was typed after (ruling R13) ──
const engineOf = (page) => page.context().browser().browserType().name();
// Double-clicks the word that holds character `offset` of the surface whose
// text is exactly `text`.
async function dblclickChar(page, text, offset) {
  const pt = await page.evaluate(([t, o]) => {
    const s = [...document.querySelectorAll('.ed-wys-armed')].find((e) => e.textContent === t);
    if (!s) return null;
    const r = document.createRange(); r.setStart(s.firstChild, o); r.setEnd(s.firstChild, o + 1);
    const b = r.getBoundingClientRect();
    return [b.left + 1, b.top + b.height / 2];
  }, [text, offset]);
  assert.ok(pt, 'dblclickChar: no surface with text ' + JSON.stringify(text));
  await page.mouse.dblclick(pt[0], pt[1]);
}
check('enter-type: a click on the next item of the same list mid-render takes the keys typed after it', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('ab');
  await clickChar(page, 'charlie', 2); await page.keyboard.type('Z');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- ab\n- chZarlie\n\nOmega.\n');
  assert.strictEqual(await noticeText(page), null, 'no notice');
}, { md: LIST_PARA_MD });
check('enter-type: a click on an earlier item of the same list mid-render takes the keys typed after it', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('ab');
  await clickChar(page, 'alpha', 2); await page.keyboard.type('Z');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- ab\n- charlie\n\nOmega.\n'.replace('- alpha', '- alZpha'));
  assert.strictEqual(await noticeText(page), null, 'no notice');
}, { md: LIST_PARA_MD });
check('enter-type: a click on another item mid-render, typing after the render, lands at the click', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await clickChar(page, 'charlie', 2);
  await renderIdle(page); await wait(300);
  await page.keyboard.type('Z');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n-\n- chZarlie\n\nOmega.\n');
}, { md: LIST_PARA_MD });
check('enter-type: ArrowDown out of a just-edited paragraph, then type, lands in the next one', DESKTOP, async (page, boot) => {
  await clickChar(page, 'Alpha para one.', 3); await page.keyboard.press('End');
  await page.keyboard.type('1'); await page.keyboard.press('ArrowDown'); await page.keyboard.type('Z');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha para one.1\n\nBravo paragraph Ztext.\n\nOmega.\n');
  assert.strictEqual(await noticeText(page), null, 'no notice');
}, { md: P3_MD });
check('enter-type: ArrowDown out of a just-edited paragraph mid-render', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await clickChar(page, 'Alpha para one.', 3); await page.keyboard.press('End');
  await page.keyboard.type('1'); await page.keyboard.press('ArrowDown'); await page.keyboard.type('Z');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha para one.1\n\nBravo paragraph Ztext.\n\nOmega.\n');
  assert.strictEqual(await noticeText(page), null, 'no notice');
}, { md: P3_MD });
check('enter-type: ArrowDown after typing in a new item crosses to the next item', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('ab'); await renderIdle(page);
  await page.keyboard.press('ArrowDown'); await page.keyboard.type('Z');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- ab\n- chZarlie\n\nOmega.\n');
  assert.strictEqual(await noticeText(page), null, 'no notice');
}, { md: LIST_PARA_MD });
check('enter-type: ArrowDown held in a new item mid-render crosses to the next item on replay', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('ab');
  await page.keyboard.press('ArrowDown'); await page.keyboard.type('Z');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- ab\n- chZarlie\n\nOmega.\n');
  assert.strictEqual(await noticeText(page), null, 'no notice');
}, { md: LIST_PARA_MD });
check('enter-type: a word double-clicked mid-render is replaced by what is typed', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await clickChar(page, 'Omega.', 2); await page.keyboard.type('o');
  await dblclickChar(page, 'Bravo paragraph text.', 8);
  await page.keyboard.type('Q');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha para one.\n\nBravo Q text.\n\nOmoega.\n');
}, { md: P3_MD });
check('enter-type: a word double-clicked mid-render is deleted by Backspace', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await clickChar(page, 'Omega.', 2); await page.keyboard.type('o');
  await dblclickChar(page, 'Bravo paragraph text.', 8);
  await page.keyboard.press('Backspace');
  // Chromium: byte-identical to the same gesture with no render in flight
  // (measured: `Bravo` NBSP space `text.`). WebKit: with no render in flight
  // its smart delete also removes one space (`Bravo text.`); a replayed
  // deletion runs on a restored selection, which carries no word granularity,
  // so it deletes the word only. Same rendering, one more space on disk.
  const bravo = engineOf(page) === 'webkit' ? 'Bravo \u00a0text.' : 'Bravo\u00a0 text.';
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha para one.\n\n' + bravo + '\n\nOmoega.\n');
}, { md: P3_MD });
check('caret: a word double-clicked while another block renders stays selected', DESKTOP, async (page, boot) => {
  await clickChar(page, 'Alpha para one.', 14); await page.keyboard.press('End');
  await page.keyboard.type('1');
  await dblclickChar(page, 'Bravo paragraph text.', 8);
  await renderIdle(page); await wait(300);
  assert.strictEqual(await page.evaluate(() => String(getSelection())), 'paragraph');
  await page.keyboard.type('Q');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha para one.1\n\nBravo Q text.\n\nOmega.\n');
}, { md: P3_MD });
check('caret: a drag selection made while another block renders stays selected', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await clickChar(page, 'Alpha para one.', 14); await page.keyboard.press('End');
  await page.keyboard.type('1');
  const pts = await page.evaluate(() => {
    const s = [...document.querySelectorAll('.ed-wys-armed')].find((e) => e.textContent === 'Bravo paragraph text.');
    const f = (o) => { const r = document.createRange(); r.setStart(s.firstChild, o); r.setEnd(s.firstChild, o + 1); const b = r.getBoundingClientRect(); return [b.left + 1, b.top + b.height / 2]; };
    return [f(6), f(15)];
  });
  await page.mouse.move(pts[0][0], pts[0][1]); await page.mouse.down();
  await page.mouse.move(pts[1][0], pts[1][1], { steps: 5 }); await page.mouse.up();
  await renderIdle(page); await wait(300);
  assert.strictEqual(await page.evaluate(() => String(getSelection())), 'paragraph');
  await page.keyboard.type('Q');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha para one.1\n\nBravo Q text.\n\nOmega.\n');
}, { md: P3_MD });
check('enter-type: a toolbar press mid-render does not take focus away from the new item', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  const bb = await page.locator('.ed-toolbar').boundingBox();
  await page.mouse.click(bb.x + bb.width - 3, bb.y + bb.height / 2);
  await renderIdle(page); await wait(300);
  await page.keyboard.type('x');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- x\n- charlie\n\nOmega.\n');
}, { md: LIST_PARA_MD });
check('enter-type: Ctrl+Z mid-render undoes the held typing, not the Enter under it', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('ab');
  await page.keyboard.press('Control+z'); await page.keyboard.type('c');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- c\n- charlie\n\nOmega.\n');
  assert.strictEqual(await noticeText(page), null, 'no notice');
}, { md: LIST_PARA_MD });
// ── fix round 3: a later click must not move keys held before it, and a
// failed render keeps every key where it was typed ──
const failFirstRender = async (page) => {
  let first = true;
  await page.route('**/api/render', async (route) => {
    if (!first) { await route.continue(); return; }
    first = false;
    await wait(800);
    await route.fulfill({ status: 500, body: '{}' });
  });
  // R51 flake (v3.17.0 probe, 7 reds in ~600 runs): `await page.route()` returns
  // before the browser starts intercepting. A fetch the page makes in that gap
  // goes straight to the server (HTTP 200, no request event on the node side),
  // so the render the check meant to fail succeeds and no card ever comes. The
  // product was right every time. A probe request proves interception is live.
  let live = false;
  await page.route('**/__route-live', (route) => { live = true; return route.fulfill({ status: 204, body: '' }); });
  for (let i = 0; i < 100 && !live; i++) {
    await page.evaluate(() => fetch('/__route-live').catch(() => {}));
    if (!live) await wait(20);
  }
  assert.ok(live, 'failFirstRender: route interception never went live');
};
check('enter-type: keys typed before a second click stay where they were typed', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await clickChar(page, 'Alpha para one.', 14); await page.keyboard.press('End');
  await page.keyboard.type('1');
  await clickChar(page, 'Bravo paragraph text.', 5); await page.keyboard.type('xy');
  await clickChar(page, 'Omega.', 2); await page.keyboard.type('Z');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha para one.1\n\nBravoxy paragraph text.\n\nOmZega.\n');
}, { md: P3_MD });
check('enter-type: an item edit, then two clicks, each with keys after it', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.type('X');
  await clickChar(page, 'Omega.', 2); await page.keyboard.type('c');
  await clickChar(page, 'alpha', 2); await page.keyboard.type('Z');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alZpha\n- bravoX\n- charlie\n\nOmcega.\n');
}, { md: LIST_PARA_MD });
for (const ms of [0, 800]) {
  check('enter-type: click, type, click, type with no pauses (' + ms + ' ms render delay)', DESKTOP, async (page, boot) => {
    if (ms) await delayRender(page, ms);
    await clickChar(page, 'Alpha para one.', 14); await page.keyboard.type('1');
    await clickChar(page, 'Bravo paragraph text.', 5); await page.keyboard.type('Z');
    await clickChar(page, 'Omega.', 2); await page.keyboard.type('Y');
    assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha para one1.\n\nBravoZ paragraph text.\n\nOmYega.\n');
  }, { md: P3_MD });
}
check('enter-type: a second click later in the same paragraph lands past the held text', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await clickChar(page, 'Alpha para one.', 14); await page.keyboard.press('End');
  await page.keyboard.type('1');
  await clickChar(page, 'Bravo paragraph text.', 5); await page.keyboard.type('ab');
  await clickChar(page, 'Bravo paragraph text.', 10); await page.keyboard.type('c');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha para one.1\n\nBravoab paracgraph text.\n\nOmega.\n');
}, { md: P3_MD });
check('enter-type: a second click later in the same item lands past the held text', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('ab');
  await clickChar(page, 'charlie', 1); await page.keyboard.type('X');
  await clickChar(page, 'charlie', 4); await page.keyboard.type('Y');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- ab\n- cXharYlie\n\nOmega.\n');
}, { md: LIST_PARA_MD });
check('enter-type: a failed render keeps keys typed after a click in the clicked paragraph', DESKTOP, async (page, boot) => {
  await failFirstRender(page);
  await clickChar(page, 'Alpha para one.', 14); await page.keyboard.press('End');
  await page.keyboard.type('1');
  await clickChar(page, 'Bravo paragraph text.', 5); await page.keyboard.type('ZZ');
  await renderIdle(page);
  const texts = await page.evaluate(() => [...document.querySelectorAll('.ed-wys-armed')].map((e) => e.textContent));
  assert.deepStrictEqual(texts, ['D', 'Alpha para one.1', 'BravoZZ paragraph text.', 'Omega.']);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha para one.1\n\nBravoZZ paragraph text.\n\nOmega.\n');
}, { md: P3_MD });
// R98 (ledger L213): the WebKit flake. The failed render's retry starts only
// after the held click's focus lands, which WebKit makes asynchronous, so a
// renderIdle right after the keys can see no render out yet and read the
// screen before the retry. The check waits 1500 ms more, then reads the
// screen AND the file (40/40 isolated in the final review; the file was
// never read before).
check('enter-type: a failed render keeps the new item\'s keys and the clicked item\'s keys apart', DESKTOP, async (page, boot) => {
  await failFirstRender(page);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('ab');
  await clickChar(page, 'charlie', 2); await page.keyboard.type('Z');
  await renderIdle(page); await wait(1500); await renderIdle(page);
  assert.deepStrictEqual(await liTexts(page), ['alpha', 'bravo', 'ab', 'chZarlie']);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- ab\n- chZarlie\n\nOmega.\n');
}, { md: LIST_PARA_MD });
check('enter-type: Ctrl+Z mid-render drops held typing but keeps a held arrow', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('ab');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Control+z'); await page.keyboard.type('c');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n-\n- ccharlie\n\nOmega.\n');
}, { md: LIST_PARA_MD });
check('enter-type: Delete during another block\'s render deletes the next character', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await clickChar(page, 'Alpha para one.', 14); await page.keyboard.press('End');
  await page.keyboard.type('1');
  await clickChar(page, 'Bravo paragraph text.', 5);
  await page.keyboard.press('Delete'); await page.keyboard.type('Q');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha para one.1\n\nBravoQparagraph text.\n\nOmega.\n');
}, { md: P3_MD });
check('enter-type: a word deleted mid-render stays deleted', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('ab cd');
  await page.keyboard.press('Control+Backspace');
  await page.keyboard.type('e');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- ab e\n- charlie\n');
}, { md: TIGHT_MD });
check('enter-type: a paste mid-render is kept, in order', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('ab');
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', 'PP');
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.keyboard.type('c');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- abPPc\n- charlie\n');
}, { md: TIGHT_MD });
check('enter-type: Escape mid-render discards the held keys', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('ab');
  await page.keyboard.press('Escape'); await page.keyboard.type('c');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- c\n- charlie\n');
}, { md: TIGHT_MD });
check('enter-type: one Ctrl+Z undoes a replayed word', DESKTOP, async (page) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('new');
  await renderIdle(page);
  assert.deepStrictEqual(await liTexts(page), ['alpha', 'bravo', 'new', 'charlie'], 'guard: the word was replayed');
  await page.keyboard.press('Control+z'); await wait(300);
  assert.deepStrictEqual(await liTexts(page), ['alpha', 'bravo', '', 'charlie']);
}, { md: TIGHT_MD });

// ── f1 (v3.13.1 T2): a block marker typed at the start of a paragraph or
// list-item line is saved escaped, so the block stays what it was ──
const BASE_MD = '# D\n\nAlpha.\n\nOmega.\n';
// Clicks the surface (.ed-wys-armed or .ed-wys-cell) whose textContent is
// exactly `text`, then puts a collapsed caret `offset` characters in — the
// click opens the burst, the caret is placed afterwards. Same shape as
// focusText() in test/editor-cell-range.test.js.
async function focusSurface(page, text, offset) {
  const sel = await page.evaluate((t) => {
    const s = [...document.querySelectorAll('.ed-wys-armed, .ed-wys-cell')].find((el) => el.textContent === t);
    if (!s) return null;
    s.setAttribute('data-f1-probe', '1');
    return '[data-f1-probe="1"]';
  }, text);
  assert.ok(sel, 'focusSurface: no surface with text ' + JSON.stringify(text));
  await page.click(sel); await wait(150);
  const placed = await page.evaluate((off) => {
    const s = document.querySelector('[data-f1-probe="1"]');
    s.removeAttribute('data-f1-probe');
    const walker = document.createTreeWalker(s, NodeFilter.SHOW_TEXT);
    let left = off;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (left <= n.data.length) { getSelection().setBaseAndExtent(n, left, n, left); return true; }
      left -= n.data.length;
    }
    return false;
  }, offset);
  assert.strictEqual(placed, true, 'focusSurface: offset ' + offset + ' is inside ' + JSON.stringify(text));
}
// MIGRATED by v3.15.0 T3 (R18): `f1: "## " at a paragraph start saves escaped
// and stays a paragraph` -> `…converts; Ctrl+Z gives the escaped literal`. The
// marker is now a shortcut (spec §3.3): the paragraph becomes a heading, and
// one Ctrl+Z gives back exactly what the old check pinned — a paragraph
// reading "## Alpha.", saved as `\## Alpha.`, no notice.
check('f1: "## " at a paragraph start converts; Ctrl+Z gives the escaped literal', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 0);
  await page.keyboard.type('## ');
  await renderIdle(page);
  const typeOf = (text) => page.evaluate((t) => {
    const s = [...document.querySelectorAll('.ed-wys-armed')].find((el) => el.textContent === t);
    const b = s && s.closest('.ed-block');
    return b ? b.getAttribute('data-block-type') : null;
  }, text);
  assert.strictEqual(await typeOf('Alpha.'), 'heading', 'typing converts');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await typeOf('## Alpha.'), 'paragraph', 'the block reads "## Alpha." and is a paragraph again');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n\\## Alpha.\n\nOmega.\n');
  assert.strictEqual(await noticeText(page), null, 'no notice');
}, { md: BASE_MD });
check('f1: "> " at a list item start', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'bravo', 0);
  await page.keyboard.type('> ');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- \\> bravo\n');
  assert.strictEqual(await noticeText(page), null, 'no notice');
}, { md: '# D\n\n- bravo\n' });
// MIGRATED by v3.15.0 T3 (R18): `f1: "1. " at a paragraph start` -> `…converts;
// Ctrl+Z gives the escaped literal`, same reason as the "## " row above.
check('f1: "1. " at a paragraph start converts; Ctrl+Z gives the escaped literal', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 0);
  await page.keyboard.type('1. ');
  await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'li:Alpha.', 'paragraph:Omega.'], 'typing converts');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n1\\. Alpha.\n\nOmega.\n');
  assert.strictEqual(await noticeText(page), null, 'no notice');
}, { md: BASE_MD });
check('f1: an already escaped paragraph is byte-stable after an unrelated edit', DESKTOP, async (page, boot) => {
  await focusSurface(page, '## Alpha.', 9);
  await page.keyboard.type('X');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n\\## Alpha.X\n');
  assert.strictEqual(await noticeText(page), null, 'no notice');
}, { md: '# D\n\n\\## Alpha.\n' });

// ── baseline (v3.13.1 T3–T7): WebKit coverage for editor behaviour the
// release does not change. These are guards: green by design on both engines.
// ── T3: undo/redo of a text edit, Shift+Enter ──
check('baseline history: Ctrl+Z inside the burst reverts the typing', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.type('X');
  await page.keyboard.press('Control+z');
  assert.strictEqual(await page.evaluate(() => ([...document.querySelectorAll('.ed-wys-armed')].find((e) => e.textContent.indexOf('Alpha') === 0) || {}).textContent), 'Alpha.');
  assert.strictEqual(await commitAndRead(page, boot), BASE_MD);
}, { md: BASE_MD });
check('baseline history: Ctrl+Z / Ctrl+Y after the commit, then the toolbar buttons', DESKTOP, async (page, boot) => {
  const WITH = '# D\n\nAlpha.X\n\nOmega.\n';
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.type('X');
  assert.strictEqual(await commitAndRead(page, boot), WITH, 'guard: committed');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD, 'Ctrl+Z');
  await page.keyboard.press('Control+y'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), WITH, 'Ctrl+Y');
  await page.click('[data-ed-tb="undo"]'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD, 'toolbar undo');
  await page.click('[data-ed-tb="redo"]'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), WITH, 'toolbar redo');
}, { md: BASE_MD });
check('baseline history: Shift+Enter in a paragraph is a <br> inside the same block', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 2);
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('Z');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAl<br>Zpha.\n\nOmega.\n');
  await page.reload(); await page.waitForSelector('.ed-toolbar'); await wait(400);
  assert.deepStrictEqual(await page.evaluate(() => ({
    blocks: document.querySelectorAll('.ed-block[data-block-type="paragraph"]').length,
    brs: document.querySelectorAll('.content p br').length,
  })), { blocks: 2, brs: 1 });
}, { md: BASE_MD });


// ── T4: paste ──
async function clipboardEvent(page, type, text, html) {
  const got = await page.evaluate(([ty, t, h]) => {
    const dt = new DataTransfer();
    if (t !== null) dt.setData('text/plain', t);
    if (h !== null) dt.setData('text/html', h);
    const ev = new ClipboardEvent(ty, { clipboardData: dt, bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(ev);
    return { plain: dt.getData('text/plain'), html: dt.getData('text/html'), prevented: ev.defaultPrevented };
  }, [type, text === undefined ? null : text, html === undefined ? null : html]);
  await renderIdle(page);
  return got;
}
check('baseline paste: plain text lands at the caret', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await clipboardEvent(page, 'paste', 'zz', null);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.zz\n\nOmega.\n');
}, { md: BASE_MD });
check('baseline paste: HTML becomes a markdown block below', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await clipboardEvent(page, 'paste', 'evil', '<b>evil</b>');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n**evil**\n\nOmega.\n');
  assert.deepStrictEqual(await page.evaluate(() => [document.querySelectorAll('.content b').length, (document.querySelector('.content strong') || {}).textContent]), [0, 'evil']);
}, { md: BASE_MD });
check('baseline paste: Ctrl+Shift+V pastes the plain flavour verbatim', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  // The user path: a real Ctrl+C puts both flavours on the clipboard (a
  // temporary capture-phase copy listener supplies them, so the clipboard does
  // not depend on earlier checks), then a real Ctrl+Shift+V arms the plain
  // paste and the browser's native paste consumes it.
  await page.evaluate(() => {
    window.__seedCopy = (e) => {
      e.clipboardData.setData('text/plain', 'PASTED<b>RICH</b>TEXT');
      e.clipboardData.setData('text/html', '<b>evil</b>');
      e.preventDefault(); e.stopImmediatePropagation();
    };
    window.addEventListener('copy', window.__seedCopy, true);
  });
  await page.keyboard.press('Control+c');
  await page.evaluate(() => window.removeEventListener('copy', window.__seedCopy, true));
  await page.keyboard.press('Control+Shift+V');
  await renderIdle(page);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.PASTED&lt;b>RICH&lt;/b>TEXT\n\nOmega.\n');
}, { md: BASE_MD });

// Chromium and WebKit strip text/html from a native Ctrl+Shift+V paste, so the
// check above cannot tell plainOnly from a normal paste. This one arms with the
// keydown the product listens to (dispatched, so no native paste follows and
// consumes the arming) and then pastes both flavours synthetically.
check('baseline paste: an armed plain paste ignores the html flavour', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'V', ctrlKey: true, shiftKey: true, bubbles: true })));
  await clipboardEvent(page, 'paste', 'PASTED<b>RICH</b>TEXT', '<b>evil</b>');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.PASTED&lt;b>RICH&lt;/b>TEXT\n\nOmega.\n');
}, { md: BASE_MD });

// ── T5: inline formatting ──
async function selectInSurface(page, text, from, to) {
  const sel = await page.evaluate((t) => {
    const s = [...document.querySelectorAll('.ed-wys-armed, .ed-wys-cell')].find((el) => el.textContent === t);
    if (!s) return null;
    s.setAttribute('data-sel-probe', '1');
    return '[data-sel-probe="1"]';
  }, text);
  assert.ok(sel, 'selectInSurface: no surface with text ' + JSON.stringify(text));
  await page.click(sel); await wait(150);
  const ok = await page.evaluate(([a, b]) => {
    const s = document.querySelector('[data-sel-probe="1"]');
    s.removeAttribute('data-sel-probe');
    const pos = (off) => {
      const w = document.createTreeWalker(s, NodeFilter.SHOW_TEXT);
      let left = off;
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (left <= n.data.length) return [n, left];
        left -= n.data.length;
      }
      return null;
    };
    const p = pos(a), q = pos(b);
    if (!p || !q) return false;
    getSelection().setBaseAndExtent(p[0], p[1], q[0], q[1]);
    return true;
  }, [from, to]);
  assert.strictEqual(ok, true, 'selectInSurface: range inside ' + JSON.stringify(text));
  await wait(150);
}
for (const [label, act, want] of [
  ['toolbar bold', (p) => p.click('[data-ed-tb="bold"]'), '**Alpha**.'],
  ['toolbar italic', (p) => p.click('[data-ed-tb="italic"]'), '*Alpha*.'],
  ['toolbar strike', (p) => p.click('[data-ed-tb="strike"]'), '~~Alpha~~.'],
  ['toolbar inline-code', (p) => p.click('[data-ed-tb="inline-code"]'), '`Alpha`.'],
  ['Ctrl+B', (p) => p.keyboard.press('Control+b'), '**Alpha**.'],
  ['Ctrl+I', (p) => p.keyboard.press('Control+i'), '*Alpha*.'],
  ['Ctrl+U', (p) => p.keyboard.press('Control+u'), '<u>Alpha</u>.'],
]) {
  check('baseline format: ' + label, DESKTOP, async (page, boot) => {
    await selectInSurface(page, 'Alpha.', 0, 5);
    await act(page);
    assert.strictEqual(await commitAndRead(page, boot), '# D\n\n' + want + '\n\nOmega.\n');
  }, { md: BASE_MD });
}


// ── T6: table cells ──
const TBL2_MD = '# D\n\n| A | B |\n|---|---|\n| a1 | b1 |\n| a2 | b2 |\n\nafter\n';
function mdTable(md) {
  return md.split('\n').filter((l) => /^\|/.test(l) && !/^\|\s*:?-/.test(l))
    .map((l) => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim()));
}
async function shiftClickCell(page, text) {
  const p = await page.evaluate((t) => {
    const c = [...document.querySelectorAll('.ed-wys-cell')].find((el) => el.textContent === t);
    if (!c) return null;
    c.scrollIntoView({ block: 'center' });
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, text);
  assert.ok(p, 'shiftClickCell: no cell with text ' + JSON.stringify(text));
  assert.strictEqual(await page.evaluate((q) => { const e = document.elementFromPoint(q.x, q.y); return !!(e && e.closest('.ed-wys-cell')); }, p), true, 'shiftClickCell: the press point is on a cell');
  await page.keyboard.down('Shift'); await page.mouse.click(p.x, p.y); await page.keyboard.up('Shift');
  await renderIdle(page);
}
check('baseline table: typing in a cell', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'b1', 2);
  await page.keyboard.type('X');
  assert.deepStrictEqual(mdTable(await commitAndRead(page, boot)), [['A', 'B'], ['a1', 'b1X'], ['a2', 'b2']]);
}, { md: TBL2_MD });
check('baseline table: Tab selects the next whole cell and typing replaces it', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'a1', 2);
  await page.keyboard.press('Tab');
  await page.keyboard.type('Q');
  assert.deepStrictEqual(mdTable(await commitAndRead(page, boot)), [['A', 'B'], ['a1', 'Q'], ['a2', 'b2']]);
}, { md: TBL2_MD });
check('baseline table: ArrowDown and ArrowUp move between rows', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'a1', 0);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('Z');
  await focusSurface(page, 'b2', 0);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.type('Y');
  const t = mdTable(await commitAndRead(page, boot));
  assert.deepStrictEqual(t, [['A', 'B'], ['a1', 'Yb1'], ['Za2', 'b2']]);
}, { md: TBL2_MD });
check('baseline table: a cell range copies as TSV and HTML', DESKTOP, async (page) => {
  await focusSurface(page, 'a1', 0);
  await shiftClickCell(page, 'b2');
  const got = await clipboardEvent(page, 'copy', null, null);
  assert.strictEqual(got.plain, 'a1\tb1\na2\tb2');
  assert.strictEqual(got.prevented, true);
  assert.strictEqual(/<td>a1<\/td><td>b1<\/td>[\s\S]*<td>a2<\/td><td>b2<\/td>/.test(got.html), true, 'html: ' + got.html);
}, { md: TBL2_MD });
check('baseline table: a TSV paste fills from the caret cell', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'a1', 0);
  await clipboardEvent(page, 'paste', 'x\ty\nz\tw', null);
  assert.deepStrictEqual(mdTable(await commitAndRead(page, boot)), [['A', 'B'], ['x', 'y'], ['z', 'w']]);
}, { md: TBL2_MD });

// ── T7: image insertion and the raw box ──
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
check('baseline image: the toolbar inserts a picked png below the block', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-ed-tb="image"]')]);
  await chooser.setFiles({ name: 'dot.png', mimeType: 'image/png', buffer: Buffer.from(PNG_1PX, 'base64') });
  await renderIdle(page);
  const disk = await saveAndRead(page, boot);
  const m = /^# D\n\nAlpha\.\n\n!\[\]\((assets\/dot(-\d+)?\.png)\)\n\nOmega\.\n$/.exec(disk);
  assert.ok(m, 'file: ' + JSON.stringify(disk));
  assert.strictEqual(fs.existsSync(path.join(path.dirname(boot.mdPath), m[1])), true, 'asset exists: ' + m[1]);
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.content img').length), 1);
}, { md: BASE_MD });
async function openRawBox(page) {
  await gutterMenu(page, await blockByText(page, 'Alpha.'), 'MD 原始碼');
  assert.strictEqual(await page.evaluate(() => !!document.querySelector('textarea.ed-raw')), true, 'raw box open');
  await page.focus('textarea.ed-raw');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Beta **b**.');
}
check('baseline raw: MD 原始碼 commits with Ctrl+Enter', DESKTOP, async (page, boot) => {
  await openRawBox(page);
  await page.keyboard.press('Control+Enter');
  await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nBeta **b**.\n\nOmega.\n');
  assert.strictEqual(await page.evaluate(() => (document.querySelector('.content strong') || {}).textContent), 'b');
}, { md: BASE_MD });
check('baseline raw: Esc cancels the raw box', DESKTOP, async (page, boot) => {
  await openRawBox(page);
  await page.keyboard.press('Escape');
  await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD);
  assert.strictEqual(await page.evaluate(() => !!document.querySelector('textarea.ed-raw')), false, 'raw box gone');
}, { md: BASE_MD });

// ── v3.14.0 helpers (T1), used by every later v3.14.0 check ──
// One entry per `.content .ed-block` in DOM order: '~' for a transient, the
// block type, and its surface's text (the armed surface, else the li text,
// else the block's own text without the gutter chrome).
async function blockList(page) {
  return page.evaluate(() => [...document.querySelectorAll('.content .ed-block')].map((b) => {
    let s = b.querySelector('.ed-wys-armed') || b.querySelector('.ed-li-text');
    let text;
    if (s) text = s.textContent;
    else {
      const c = b.cloneNode(true);
      c.querySelectorAll('.ed-handle, .ed-insert').forEach((x) => x.remove());
      text = c.textContent.trim();
    }
    return (b.hasAttribute('data-ed-transient') ? '~' : '') + b.getAttribute('data-block-type') + ':' + text;
  }));
}
// The focused surface's text, the caret's character offset in it, and
// whether it is a transient; null when no armed surface has focus.
async function caretNow(page) {
  return page.evaluate(() => {
    const a = document.activeElement;
    const s = a && a.closest ? a.closest('.ed-wys-armed') : null;
    const sel = getSelection();
    if (!s || !sel.rangeCount || !s.contains(sel.focusNode)) return null;
    const r = document.createRange();
    r.setStart(s, 0); r.setEnd(sel.focusNode, sel.focusOffset);
    return { text: s.textContent, offset: r.toString().length, transient: !!s.closest('[data-ed-transient]') };
  });
}
const transientCount = (page) => page.evaluate(() => document.querySelectorAll('[data-ed-transient]').length);
async function tb(page, id) {
  await page.click('[data-ed-tb="' + id + '"]');
  await renderIdle(page);
}

// ── transient-model (v3.14.0 T1) ──
check('transient-model: 在下方插入 opens a focused empty paragraph that writes nothing', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await tb(page, 'insert-after');
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', '~paragraph:', 'paragraph:Omega.']);
  assert.deepStrictEqual(await caretNow(page), { text: '', offset: 0, transient: true });
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', 'paragraph:Omega.']);
  const disk = await saveAndRead(page, boot);
  assert.strictEqual(disk, BASE_MD);
  assert.strictEqual(disk.indexOf('​'), -1, 'no ZWSP');
}, { md: BASE_MD });
check('transient-model: typing then leaving commits one paragraph, one undo step', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await tb(page, 'insert-after');
  await page.keyboard.type('New.');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\nNew.\n\nOmega.\n');
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD);
}, { md: BASE_MD });
// v3.17.0 T10 (L95b): the toolbar button steps the open burst like Ctrl+Z
// does. Before, it committed the paragraph and then undid the whole commit
// (a transient typed into vanished entirely), closing the burst either way.
check('transient-model: toolbar 復原 inside an open paragraph undoes the last typing only (L95b)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.type('X'); await wait(600); await page.keyboard.type('Y');
  const before = renderTotal(page);
  await page.click('[data-ed-tb="undo"]'); await wait(300);
  assert.deepStrictEqual({ caret: await caretNow(page), renders: renderTotal(page) - before, disk: fs.readFileSync(boot.mdPath, 'utf8') },
    { caret: { text: 'Alpha.', offset: 6, transient: false }, renders: 0, disk: BASE_MD });
  // The burst is still open (Ctrl+Z's own step, typing grouped as the burst
  // history groups it): the next key lands in the paragraph, and nothing
  // before the burst was undone.
  await page.keyboard.type('Q');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.Q\n\nOmega.\n', 'only the typing went');
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD, 'the committed typing is the one document step');
}, { md: BASE_MD });
check('transient-model: toolbar 復原 inside a transient with typing keeps the transient (L95b)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await tb(page, 'insert-after');
  await page.keyboard.type('New.'); await wait(100);
  await page.click('[data-ed-tb="undo"]'); await wait(300);
  assert.deepStrictEqual({ caret: await caretNow(page), list: await blockList(page) },
    { caret: { text: '', offset: 0, transient: true }, list: ['heading:D', 'paragraph:Alpha.', '~paragraph:', 'paragraph:Omega.'] });
  assert.strictEqual(fs.readFileSync(boot.mdPath, 'utf8'), BASE_MD);
}, { md: BASE_MD });
check('transient-model: 在上方插入 on the first block puts it at the top', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'D', 1);
  await tb(page, 'insert-before');
  assert.deepStrictEqual(await blockList(page), ['~paragraph:', 'heading:D', 'paragraph:Alpha.', 'paragraph:Omega.']);
  await page.keyboard.type('Top.');
  assert.strictEqual(await commitAndRead(page, boot), 'Top.\n\n# D\n\nAlpha.\n\nOmega.\n');
}, { md: BASE_MD });
check('transient-model: ＋ 段落 opens a transient and abandoning it leaves the file alone', DESKTOP, async (page, boot) => {
  // v3.15.0 T2: ＋ opens the "/" menu on the transient; 段落 is its 文字.
  await plusClick(page, 'Alpha.');
  await slashPick(page, '文字');
  assert.strictEqual((await slashMenu(page)).open, false);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', '~paragraph:', 'paragraph:Omega.']);
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD);
}, { md: BASE_MD });
check('transient-model: at most one, and 在下方插入 inside it keeps it', DESKTOP, async (page) => {
  await focusSurface(page, 'Alpha.', 6);
  await tb(page, 'insert-after'); await tb(page, 'insert-after');
  assert.strictEqual(await transientCount(page), 1);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', '~paragraph:', 'paragraph:Omega.']);
}, { md: BASE_MD });
check('transient-model: Ctrl+S with an empty transient focused keeps it and writes nothing', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await tb(page, 'insert-after');
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD);
  assert.strictEqual(await transientCount(page), 1);
  assert.deepStrictEqual(await caretNow(page), { text: '', offset: 0, transient: true });
}, { md: BASE_MD });
check('transient-model: Enter on an empty last item ends the list with a transient, one undo step', DESKTOP, async (page, boot) => {
  await liText(page, 'charlie').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'li:alpha', 'li:bravo', 'li:charlie', '~paragraph:', 'paragraph:Omega.']);
  await page.keyboard.type('Para.');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- charlie\n\nPara.\n\nOmega.\n');
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), LIST_PARA_MD);
}, { md: LIST_PARA_MD });
// The press that blurs an empty transient removes it, and the blocks below it
// move up. The press must still open the block it landed on: the transient
// stays until the press is over, so the click lands on the same block.
check('transient-model: a press on the paragraph below an empty transient opens that paragraph', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await tb(page, 'insert-after');
  await page.locator('.ed-block[data-block-type="paragraph"]', { hasText: 'Omega.' }).click(); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', 'paragraph:Omega.']);
  await page.keyboard.press('End'); await page.keyboard.type('X');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\nOmega.X\n');
}, { md: BASE_MD });
// ── transient-model, fix round 1 (I1): keys typed after a press that
// commits a transient go to the block that was pressed. The commit inserts
// lines, so every block below the landing line is renumbered by the render.
check('transient-model: typing after a click below a committing transient lands in the clicked block', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await tb(page, 'insert-after');
  await page.keyboard.type('New.');
  await delayRender(page, 800);
  await clickChar(page, 'Omega.', 3); await page.keyboard.type('X');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\nNew.\n\nOmeXga.\n');
}, { md: BASE_MD });
check('transient-model: typing after a click on the heading below a committing top transient lands in the heading', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'D', 1);
  await tb(page, 'insert-before');
  await page.keyboard.type('Top.');
  await delayRender(page, 800);
  // 'D' has no middle: the press lands on its right half, so the caret is at
  // offset 1, not at the offset 0 a bare focus() would give.
  const dEnd = await page.evaluate(() => {
    const s = [...document.querySelectorAll('.ed-wys-armed')].find((e) => e.textContent === 'D');
    const r = document.createRange(); r.setStart(s.firstChild, 0); r.setEnd(s.firstChild, 1);
    const b = r.getBoundingClientRect();
    return [b.right - 1, b.top + b.height / 2];
  });
  await page.mouse.click(dEnd[0], dEnd[1]); await page.keyboard.type('X');
  assert.strictEqual(await commitAndRead(page, boot), 'Top.\n\n# DX\n\nAlpha.\n\nOmega.\n');
}, { md: BASE_MD });
check('transient-model: typing after a click two blocks below a committing top transient lands in that block', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'D', 1);
  await tb(page, 'insert-before');
  await page.keyboard.type('Top.');
  await delayRender(page, 800);
  await clickChar(page, 'Alpha.', 3); await page.keyboard.type('X');
  assert.strictEqual(await commitAndRead(page, boot), 'Top.\n\n# D\n\nAlpXha.\n\nOmega.\n');
}, { md: BASE_MD });
// I2: a ⠿ / ＋ gesture on a block below a typed transient. The gesture's
// switchAwayFrom() commits the transient, which moves the target down.
check('transient-model: ＋ 段落 on the block below a typed transient commits it and opens the new one below', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await tb(page, 'insert-after');
  await page.keyboard.type('New.');
  // v3.15.0 T2: ＋ opens the "/" menu on the transient; 段落 is its 文字.
  await plusClick(page, 'Omega.');
  await slashPick(page, '文字');
  assert.strictEqual((await slashMenu(page)).open, false);
  assert.strictEqual(await noticeText(page), null, 'no 文件已更新 notice');
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', 'paragraph:New.', 'paragraph:Omega.', '~paragraph:']);
  assert.deepStrictEqual(await caretNow(page), { text: '', offset: 0, transient: true });
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\nNew.\n\nOmega.\n');
}, { md: BASE_MD });
check('failed-render: a transient whose commit fails keeps its text and commits on the next try', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await tb(page, 'insert-after');
  await failFirstRender(page);
  await page.keyboard.type('New.');
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', '~paragraph:New.', 'paragraph:Omega.'], 'the text stays on screen');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\nNew.\n\nOmega.\n');
}, { md: BASE_MD });

// ── para-enter (v3.14.0 T2) ──
const HEAD_MD = '# D\n\n## Head text\n\nOmega.\n';
const LINK_MD = '# D\n\nSee [link](https://e.com) now.\n';
const BOLD_MD = '# D\n\nAl **bold** x\n';
const paragraphs = (page) => page.evaluate(() => [...document.querySelectorAll('.content .ed-block[data-block-type="paragraph"] .ed-wys-armed')].map((e) => e.textContent));
check('para-enter: Enter mid-paragraph splits at the caret, caret at the new paragraph start', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Bravo paragraph text.', 3);
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await paragraphs(page), ['Alpha para one.', 'Bra', 'vo paragraph text.', 'Omega.']);
  assert.deepStrictEqual(await caretNow(page), { text: 'vo paragraph text.', offset: 0, transient: false });
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha para one.\n\nBra\n\nvo paragraph text.\n\nOmega.\n');
}, { md: P3_MD });
check('para-enter: the space at the split point is dropped from both halves', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Bravo paragraph text.', 5);
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha para one.\n\nBravo\n\nparagraph text.\n\nOmega.\n');
}, { md: P3_MD });
check('para-enter: Enter at the end opens a focused transient below and writes nothing', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', '~paragraph:', 'paragraph:Omega.']);
  assert.deepStrictEqual(await caretNow(page), { text: '', offset: 0, transient: true });
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD);
}, { md: BASE_MD });
check('para-enter: Enter at the start opens a transient above and the caret stays', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Omega.', 0);
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', '~paragraph:', 'paragraph:Omega.']);
  assert.deepStrictEqual(await caretNow(page), { text: 'Omega.', offset: 0, transient: false });
  await page.keyboard.type('X');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\nXOmega.\n');
}, { md: BASE_MD });
check('para-enter: a heading splits into the heading and a paragraph', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Head text', 4);
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'heading:Head', 'paragraph:text', 'paragraph:Omega.']);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n## Head\n\ntext\n\nOmega.\n');
}, { md: HEAD_MD });
check('para-enter: Enter at the end of a heading opens a transient below', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Head text', 9);
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('P');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n## Head text\n\nP\n\nOmega.\n');
}, { md: HEAD_MD });
check('para-enter: across bold both halves close their marks', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Al bold x', 5);
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAl **bo**\n\n**ld** x\n');
}, { md: BOLD_MD });
// Review Focus 3
check('para-enter: at the end of a link the link stays whole on the left', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'See link now.', 8);
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nSee [link](https://e.com)\n\nnow.\n');
}, { md: LINK_MD });
check('para-enter: inside a link both halves keep the link', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'See link now.', 6);
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nSee [li](https://e.com)\n\n[nk](https://e.com) now.\n');
}, { md: LINK_MD });
check('para-enter: Enter with a word selected replaces it with the split', DESKTOP, async (page, boot) => {
  await dblclickChar(page, 'Bravo paragraph text.', 8);
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha para one.\n\nBravo\n\ntext.\n\nOmega.\n');
}, { md: P3_MD });
// R10: the split is asserted on disk first, so the undo cannot pass by
// undoing nothing.
check('para-enter: one Ctrl+Z undoes a mid-paragraph Enter', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Bravo paragraph text.', 3);
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha para one.\n\nBra\n\nvo paragraph text.\n\nOmega.\n', 'the split is on disk');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), P3_MD);
}, { md: P3_MD });
check('para-enter: typing, Enter, Ctrl+Z keeps the typing', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Bravo paragraph text.', 3);
  await page.keyboard.type('Z'); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha para one.\n\nBraZvo paragraph text.\n\nOmega.\n');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), P3_MD);
}, { md: P3_MD });
check('para-enter: one Ctrl+Z after Enter at the end removes the empty paragraph', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await transientCount(page), 0);
  assert.deepStrictEqual(await caretNow(page), { text: 'Alpha.', offset: 6, transient: false });
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD);
}, { md: BASE_MD });
check('para-enter: Enter in a transient with text commits it and opens the next one', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.press('Enter'); await page.keyboard.type('abc');
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', 'paragraph:abc', '~paragraph:', 'paragraph:Omega.']);
  await page.keyboard.type('def');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\nabc\n\ndef\n\nOmega.\n');
}, { md: BASE_MD });
check('para-enter: Enter in an empty transient does nothing', DESKTOP, async (page) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', '~paragraph:', 'paragraph:Omega.']);
}, { md: BASE_MD });
// Review Focus 1
check('para-enter: typing right after a mid-paragraph Enter on a slow render lands in the new paragraph', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await focusSurface(page, 'Bravo paragraph text.', 6);
  await page.keyboard.press('Enter'); await page.keyboard.type('New ');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha para one.\n\nBravo\n\nNew paragraph text.\n\nOmega.\n');
  assert.strictEqual(await noticeText(page), null, 'no notice');
}, { md: P3_MD });
check('para-enter: typing right after Enter at the end of an edited paragraph lands in the new paragraph', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.type('X'); await page.keyboard.press('Enter'); await page.keyboard.type('Next');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.X\n\nNext\n\nOmega.\n');
  assert.strictEqual(await noticeText(page), null, 'no notice');
}, { md: BASE_MD });
// Review Focus 4
check('para-enter: an IME character then Enter splits after it', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Bravo paragraph text.', 3);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'ㄋ', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.insertText', { text: '你' });
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha para one.\n\nBra你\n\nvo paragraph text.\n\nOmega.\n');
}, { md: P3_MD, engines: ['chromium'] });
// Guard: may be green before the change (an IME's confirming Enter is not a
// split); it pins that the split never takes it.
check('para-enter: an IME confirming Enter does not split', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Bravo paragraph text.', 3);
  const prevented = await page.evaluate(() => {
    const ev = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(ev); return ev.defaultPrevented;
  });
  await renderIdle(page);
  assert.strictEqual(prevented, false, 'the IME keeps its Enter');
  assert.deepStrictEqual(await paragraphs(page), ['Alpha para one.', 'Bravo paragraph text.', 'Omega.']);
  assert.strictEqual(await saveAndRead(page, boot), P3_MD);
}, { md: P3_MD });
// Added (not in the brief): the transient's own middle case — its two halves
// are its one commit.
check('para-enter: Enter in the middle of a transient commits both halves as one step', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.press('Enter'); await page.keyboard.type('abc def');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', 'paragraph:abc', 'paragraph:def', 'paragraph:Omega.']);
  assert.deepStrictEqual(await caretNow(page), { text: 'def', offset: 0, transient: false });
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\nabc\n\ndef\n\nOmega.\n');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD);
}, { md: BASE_MD });
// Added (R6, the slot this task introduces): a structural key while a failed
// split is pending re-commits it first, then acts.
check('failed-render: Enter after a failed split re-commits it, then splits again', DESKTOP, async (page, boot) => {
  await failFirstRender(page);
  await focusSurface(page, 'Bravo paragraph text.', 3);
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await paragraphs(page), ['Alpha para one.', 'Bra', 'vo paragraph text.', 'Omega.'], 'the screen keeps the split');
  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await paragraphs(page), ['Alpha para one.', 'Bra', 'vo', 'paragraph text.', 'Omega.']);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha para one.\n\nBra\n\nvo\n\nparagraph text.\n\nOmega.\n');
}, { md: P3_MD });
// Fix (found by ER 'burst undo: … cascades to the previous commit'): an
// Enter transient the user has already clicked away from is not the next
// Ctrl+Z's step in another block — that block's own undo is.
check('para-enter: Ctrl+Z in another block right after leaving an Enter transient undoes that block', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.type('X'); await page.keyboard.press('Enter'); await renderIdle(page);
  assert.strictEqual(await transientCount(page), 1, 'guard: the Enter transient is on screen');
  await clickChar(page, 'Alpha.X', 2);
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD);
}, { md: BASE_MD });
check('failed-render: a paragraph split whose render fails is written by the next commit', DESKTOP, async (page, boot) => {
  await failFirstRender(page);
  await focusSurface(page, 'Bravo paragraph text.', 3);
  await page.keyboard.press('Enter'); await page.keyboard.type('X'); await renderIdle(page);
  const screen = await paragraphs(page);
  assert.deepStrictEqual(screen, ['Alpha para one.', 'Bra', 'Xvo paragraph text.', 'Omega.'], 'the screen keeps the split');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha para one.\n\nBra\n\nXvo paragraph text.\n\nOmega.\n');
  assert.deepStrictEqual(await paragraphs(page), screen, 'DOM equals file');
}, { md: P3_MD });

// ── merge (v3.14.0 T3) ──
const TBL_AFTER_MD = '# D\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter.\n';
check('merge: Enter then Backspace at the split restores the file byte for byte', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Bravo paragraph text.', 3);
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.deepStrictEqual(await paragraphs(page), ['Alpha para one.', 'Bravo paragraph text.', 'Omega.']);
  assert.deepStrictEqual(await caretNow(page), { text: 'Bravo paragraph text.', offset: 3, transient: false });
  assert.strictEqual(await saveAndRead(page, boot), P3_MD);
}, { md: P3_MD });
check('merge: Backspace at a paragraph start under a heading joins into the heading', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 0);
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# DAlpha.\n\nOmega.\n');
}, { md: BASE_MD });
check('merge: Backspace at a heading start makes it a paragraph', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Head text', 0);
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nHead text\n\nOmega.\n');
}, { md: HEAD_MD });
check('merge: a heading whose text reads as a list marker stays a paragraph', DESKTOP, async (page, boot) => {
  await focusSurface(page, '1. Alpha', 0);
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n1\\. Alpha\n');
}, { md: '# D\n\n## 1. Alpha\n' });
check('merge: Backspace at a top-level item start converts it like ⠿ 轉換成 文字', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'bravo', 0);
  await page.keyboard.press('Backspace'); await renderIdle(page);
  // Final review I1: the caret stays at the start of the text, as in Notion.
  assert.deepStrictEqual(await caretNow(page), { text: 'bravo', offset: 0, transient: false });
  const viaKey = await saveAndRead(page, boot);
  fs.writeFileSync(boot.mdPath, TIGHT_MD); await page.reload(); await page.waitForSelector('.ed-toolbar'); await wait(400);
  await gutterMenu(page, await blockByText(page, 'bravo'), ['轉換成', '文字']);
  assert.strictEqual(viaKey, await saveAndRead(page, boot), 'the ⠿ path is the oracle');
}, { md: TIGHT_MD });
check('merge: Backspace at a nested item start outdents it', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'bravo', 0);
  await page.keyboard.press('Backspace'); await renderIdle(page);
  // Final review I1: the caret stays at the start of the text.
  assert.deepStrictEqual(await caretNow(page), { text: 'bravo', offset: 0, transient: false });
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- alpha\n- bravo\n');
}, { md: '# D\n\n- alpha\n  - bravo\n' });
// Final review I1: Backspace, Backspace, Backspace climbs out of a list —
// outdent, then a paragraph, then a join into the item above. No press
// deletes a character.
check('merge: Backspace three times climbs out of a nested item and keeps every character', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'bravo', 0);
  const steps = [];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Backspace'); await renderIdle(page);
    steps.push({ blocks: await blockList(page), caret: await caretNow(page) });
  }
  assert.deepStrictEqual(steps, [
    { blocks: ['heading:D', 'li:alpha', 'li:bravo'], caret: { text: 'bravo', offset: 0, transient: false } },
    { blocks: ['heading:D', 'li:alpha', 'paragraph:bravo'], caret: { text: 'bravo', offset: 0, transient: false } },
    { blocks: ['heading:D', 'li:alphabravo'], caret: { text: 'alphabravo', offset: 5, transient: false } },
  ]);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- alphabravo\n');
}, { md: '# D\n\n- alpha\n  - bravo\n' });
check('merge: Backspace on an empty top-level item removes it and leaves a transient', DESKTOP, async (page, boot) => {
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'li:alpha', 'li:bravo', '~paragraph:', 'li:charlie']);
  assert.strictEqual(await saveAndRead(page, boot), TIGHT_MD);
}, { md: TIGHT_MD });
// Review Focus 2
check('merge: Backspace across bold joins the marks', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'ld x', 0);
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAl **bold** x\n');
}, { md: '# D\n\nAl **bo**\n\n**ld** x\n' });
check('merge: a link at the end of the line above stays one link', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'tail', 0);
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nSee [link](https://e.com)tail\n');
}, { md: '# D\n\nSee [link](https://e.com)\n\ntail\n' });
// R13: the seam merge of two links with the same href — Review Focus 2's
// "a link at the seam stays one link", with a link on both sides.
check('merge: a link split by Enter joins back into one link', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'See link now.', 6);
  await page.keyboard.press('Enter'); await renderIdle(page);
  // On screen, not via Ctrl+S: a save ends the burst without blurring, and
  // reopening a burst on the next key is Task 8's (ensureBurst, D8).
  assert.deepStrictEqual(await page.evaluate(() => [...document.querySelectorAll('.content .ed-block[data-block-type="paragraph"] .ed-wys-armed')]
    .map((p) => [p.textContent, p.querySelectorAll('a').length])), [['See li', 1], ['nk now.', 1]], 'guard: split, a link in each half');
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.content a[href="https://e.com"]').length), 1, 'one link on screen');
  assert.strictEqual(await saveAndRead(page, boot), LINK_MD);
}, { md: LINK_MD });
check('merge: Backspace into a paragraph after a list joins the last item', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Omega.', 0);
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- charlieOmega.\n');
}, { md: LIST_PARA_MD });
check('merge: Backspace below a table selects it, a second Backspace deletes it', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'After.', 0);
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.deepStrictEqual(await page.evaluate(() => [...document.querySelectorAll('.ed-block.ed-selected')].map((b) => b.getAttribute('data-block-type'))), ['table']);
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAfter.\n');
}, { md: TBL_AFTER_MD });
// R12 (spec §3.2): an EMPTY block below a table is removed and the caret
// lands at the table's end, rather than the table being selected.
check('merge: Backspace in an empty paragraph below a table removes it and lands in the table', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'After.', 0);
  await tb(page, 'insert-before');
  assert.deepStrictEqual(await caretNow(page), { text: '', offset: 0, transient: true }, 'guard: the caret is in the empty paragraph below the table');
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.strictEqual(await transientCount(page), 0);
  assert.deepStrictEqual(await page.evaluate(() => {
    const a = document.activeElement;
    return { cell: !!(a && a.classList && a.classList.contains('ed-wys-cell')), text: a ? a.textContent : null,
      selected: document.querySelectorAll('.ed-block.ed-selected').length };
  }), { cell: true, text: '1', selected: 0 });
  assert.strictEqual(await saveAndRead(page, boot), TBL_AFTER_MD);
}, { md: TBL_AFTER_MD });
// R12, the real-block half: a paragraph emptied by typing is removed (one op)
// and the caret lands at the table's end.
check('merge: Backspace in an emptied paragraph below a table removes it and lands in the table', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'After.', 0, 6);
  await page.keyboard.press('Backspace');
  assert.strictEqual(await page.evaluate(() => document.activeElement.textContent), '', 'guard: the paragraph is empty');
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.deepStrictEqual(await page.evaluate(() => {
    const a = document.activeElement;
    return { cell: !!(a && a.classList && a.classList.contains('ed-wys-cell')), text: a ? a.textContent : null,
      blocks: document.querySelectorAll('.content .ed-block').length };
  }), { cell: true, text: '1', blocks: 2 });
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), TBL_AFTER_MD, 'one undo step');
}, { md: TBL_AFTER_MD });
// Final review I2: the emptying of a block that a join then removes is not
// an undo step of its own. Measured before: one Ctrl+Z left a `<br>` block
// on screen, and saving there wrote it to the file.
for (const [label, md, text, key, merged] of [
  ['Backspace removing an emptied paragraph', BASE_MD, 'Omega.', 'Backspace', ['heading:D', 'paragraph:Alpha.']],
  ['Delete in an emptied paragraph', BASE_MD, 'Alpha.', 'Delete', ['heading:D', 'paragraph:Omega.']],
  ['Delete in an emptied heading', HEAD_MD, 'Head text', 'Delete', ['heading:D', 'heading:Omega.']],
]) {
  check('merge: ' + label + ' is one Ctrl+Z step back to the file before it', DESKTOP, async (page, boot) => {
    const before = await blockList(page);
    await selectInSurface(page, text, 0, text.length);
    await page.keyboard.press('Backspace');
    assert.strictEqual(await page.evaluate(() => document.activeElement.textContent), '', 'guard: the block is empty');
    await page.keyboard.press(key); await renderIdle(page);
    assert.deepStrictEqual(await blockList(page), merged, 'guard: joined');
    await page.keyboard.press('Control+z'); await renderIdle(page);
    assert.deepStrictEqual(await blockList(page), before, 'no <br> block on screen');
    assert.strictEqual(await saveAndRead(page, boot), md);
  }, { md });
}
check('merge: Backspace in an empty transient removes it and returns to the end above', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.strictEqual(await transientCount(page), 0);
  assert.deepStrictEqual(await caretNow(page), { text: 'Alpha.', offset: 6, transient: false });
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD);
}, { md: BASE_MD });
check('merge: Delete at a paragraph end pulls the next one up', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.press('Delete'); await renderIdle(page);
  assert.deepStrictEqual(await caretNow(page), { text: 'Alpha.Omega.', offset: 6, transient: false });
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.Omega.\n');
}, { md: BASE_MD });
// Guard: may be green before the change (native Delete at the end of the last
// block deletes nothing).
check('merge: Delete at the end of the last block changes nothing', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Omega.', 6);
  await page.keyboard.press('Delete'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD);
}, { md: BASE_MD });
// R12: nothing after it, so nothing happens. Guard: green before the change
// too (a native Delete in an empty surface deletes nothing).
check('merge: Delete in an empty transient with nothing after it does nothing', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Omega.', 6);
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.press('Delete'); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', 'paragraph:Omega.', '~paragraph:']);
  assert.deepStrictEqual(await caretNow(page), { text: '', offset: 0, transient: true });
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD);
}, { md: BASE_MD });
check('merge: Delete above a table selects it', DESKTOP, async (page) => {
  await focusSurface(page, 'D', 1);
  await page.keyboard.press('Delete'); await renderIdle(page);
  assert.deepStrictEqual(await page.evaluate(() => [...document.querySelectorAll('.ed-block.ed-selected')].map((b) => b.getAttribute('data-block-type'))), ['table']);
}, { md: TBL_AFTER_MD });
check('merge: one Ctrl+Z undoes the merge and keeps the typing before it', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Omega.', 0);
  await page.keyboard.type('X'); await page.keyboard.press('Home');
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.XOmega.\n');
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\nXOmega.\n');
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD);
}, { md: BASE_MD });
// Review Focus 5
check('merge: undo and redo walk back and forth across a split and a merge', DESKTOP, async (page, boot) => {
  const SPLIT = '# D\n\nAlpha para one.\n\nBra\n\nvo paragraph text.\n\nOmega.\n';
  await focusSurface(page, 'Bravo paragraph text.', 3);
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.press('Backspace'); await renderIdle(page);
  const seen = [await saveAndRead(page, boot)];
  for (const id of ['undo', 'undo', 'redo', 'redo']) { await tb(page, id); seen.push(await saveAndRead(page, boot)); }
  assert.deepStrictEqual(seen, [P3_MD, SPLIT, P3_MD, SPLIT, P3_MD]);
}, { md: P3_MD });
check('merge: Backspace held during another block\'s render merges once it lands', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await clickChar(page, 'Alpha para one.', 14); await page.keyboard.press('End'); await page.keyboard.type('1');
  await clickChar(page, 'Bravo paragraph text.', 0);
  await page.keyboard.press('Backspace');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha para one.1Bravo paragraph text.\n\nOmega.\n');
}, { md: P3_MD });
check('failed-render: a merge whose render fails is written by the next commit', DESKTOP, async (page, boot) => {
  await failFirstRender(page);
  await focusSurface(page, 'Omega.', 0);
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.Omega.'], 'the screen keeps the merge');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.Omega.\n');
}, { md: BASE_MD });

// ── v3.14.0 T2+T3 fix round 1 ──
// The surface whose text starts with `prefix`, clicked, caret at `offset`
// counted over its text nodes (for surfaces whose exact text holds a break).
async function focusSurfaceStarting(page, prefix, offset) {
  const sel = await page.evaluate((t) => {
    const s = [...document.querySelectorAll('.ed-wys-armed')].find((el) => el.textContent.indexOf(t) === 0);
    if (!s) return null;
    s.setAttribute('data-fr-probe', '1');
    return '[data-fr-probe="1"]';
  }, prefix);
  assert.ok(sel, 'focusSurfaceStarting: no surface starting ' + JSON.stringify(prefix));
  await page.click(sel); await wait(150);
  assert.strictEqual(await page.evaluate((off) => {
    const s = document.querySelector('[data-fr-probe="1"]');
    s.removeAttribute('data-fr-probe');
    const w = document.createTreeWalker(s, NodeFilter.SHOW_TEXT);
    let left = off;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (left <= n.data.length) { getSelection().setBaseAndExtent(n, left, n, left); return true; }
      left -= n.data.length;
    }
    return false;
  }, offset), true, 'focusSurfaceStarting: offset ' + offset);
}
// C1
check('para-enter: Enter in a paragraph emptied by a selection removes it and opens a transient there', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'Bravo paragraph text.', 0, 21);
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha para one.', '~paragraph:', 'paragraph:Omega.']);
  assert.deepStrictEqual(await caretNow(page), { text: '', offset: 0, transient: true });
  await page.keyboard.type('new');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha para one.\n\nnew\n\nOmega.\n');
  assert.strictEqual(await noticeText(page), null, 'no notice');
}, { md: P3_MD });
check('para-enter: typing right after Enter in an emptied paragraph on a slow render lands there', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await selectInSurface(page, 'Bravo paragraph text.', 0, 21);
  await page.keyboard.press('Enter'); await page.keyboard.type('new');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha para one.\n\nnew\n\nOmega.\n');
  assert.strictEqual(await noticeText(page), null, 'no notice');
}, { md: P3_MD });
check('para-enter: a paragraph erased by Backspace, then Enter, never writes a <br> block', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Omega.', 6);
  for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('Z');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\nZ\n');
}, { md: BASE_MD });
// C2
const WRAP_P_MD = '# D\n\nAlpha one\nbravo two.\n\nOmega.\n';
check('para-enter: Enter right before a soft wrap drops the newline and the next key lands', DESKTOP, async (page, boot) => {
  await focusSurfaceStarting(page, 'Alpha one', 9);
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await caretNow(page), { text: 'bravo two.', offset: 0, transient: false });
  await page.keyboard.type('Z');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha one\n\nZbravo two.\n\nOmega.\n');
}, { md: WRAP_P_MD });
check('para-enter: Enter right after a soft wrap drops the newline and the next key lands', DESKTOP, async (page, boot) => {
  await focusSurfaceStarting(page, 'Alpha one', 10);
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('Z');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha one\n\nZbravo two.\n\nOmega.\n');
}, { md: WRAP_P_MD });
// C3 (R30)
check('merge: Backspace into a heading flattens a hard break to one space', DESKTOP, async (page, boot) => {
  await focusSurfaceStarting(page, 'first', 0);
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# Dfirst second\n');
}, { md: '# D\n\nfirst\\\nsecond\n' });
check('merge: Backspace into a heading flattens a soft wrap to one space', DESKTOP, async (page, boot) => {
  await focusSurfaceStarting(page, 'first', 0);
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# Dfirst second\n');
}, { md: '# D\n\nfirst\nsecond\n' });
check('merge: Delete at a heading end flattens the pulled-up hard break', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'D', 1);
  await page.keyboard.press('Delete'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# Dfirst second\n');
}, { md: '# D\n\nfirst\\\nsecond\n' });
// I1 (R29)
check('merge: Backspace at a nested item start after typing is two undo steps', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'bravo', 5);
  await page.keyboard.type('X'); await page.keyboard.press('Home');
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- alpha\n- bravoX\n');
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- alpha\n  - bravoX\n');
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- alpha\n  - bravo\n');
}, { md: '# D\n\n- alpha\n  - bravo\n' });
// Guard: may be green before (the ⠿ path already resolves the burst first);
// it pins R29 for D14's conversion.
check('merge: Backspace at a top-level item start after typing is two undo steps', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'bravo', 5);
  await page.keyboard.type('X'); await page.keyboard.press('Home');
  await page.keyboard.press('Backspace'); await renderIdle(page);
  const converted = await saveAndRead(page, boot);
  assert.ok(converted.indexOf('bravoX') !== -1 && converted.indexOf('- bravoX') === -1, 'converted: ' + JSON.stringify(converted));
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- alpha\n- bravoX\n- charlie\n');
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), TIGHT_MD);
}, { md: TIGHT_MD });
// R31 (guard for the reachable half: implemented in Task 3 already)
check('merge: Backspace at the start of a transient with text joins it to the block above', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.press('Enter'); await page.keyboard.type('abc'); await page.keyboard.press('Home');
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.deepStrictEqual(await caretNow(page), { text: 'Alpha.abc', offset: 6, transient: false });
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.abc\n\nOmega.\n');
}, { md: BASE_MD });
// R32
check('failed-render: a structural key that throws shows the error card and typing still works', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Bravo paragraph text.', 3);
  await page.evaluate(() => {
    const im = window.md2docInlineMd; const orig = im.serializeInline;
    im.serializeInline = function () { im.serializeInline = orig; throw new Error('probe'); };
  });
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.ok(/未預期/.test(await noticeText(page) || ''), 'the error card: ' + await noticeText(page));
  await page.keyboard.type('Q');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha para one.\n\nBraQvo paragraph text.\n\nOmega.\n');
}, { md: P3_MD });

// ── v3.14.0 T2+T3 fix round 2: a join into a heading adds no stray space ──
check('merge: Backspace removing an emptied paragraph under a heading leaves the heading as it was', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'first', 5);
  for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');
  assert.strictEqual(await page.evaluate(() => document.activeElement.textContent), '', 'guard: the paragraph is empty');
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.deepStrictEqual(await caretNow(page), { text: 'D', offset: 1, transient: false });
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nOmega.\n');
}, { md: '# D\n\nfirst\n\nOmega.\n' });
check('merge: text ending in a line break joins a heading with no trailing space', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'first', 5);
  await page.keyboard.press('Shift+Enter');
  assert.strictEqual(await page.evaluate(() => document.activeElement.querySelectorAll('br').length > 0), true, 'guard: the surface ends in a <br>');
  await focusSurface(page, 'first', 0);
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# Dfirst\n\nOmega.\n');
}, { md: '# D\n\nfirst\n\nOmega.\n' });

// ── empty-doc / click-below / placeholder / toolbar-transient (v3.14.0 T4) ──
const hintOf = (page) => page.evaluate(() => {
  const s = document.querySelector('[data-ed-transient] .ed-wys-armed') || document.activeElement;
  const cs = getComputedStyle(s, '::before');
  const probe = document.createElement('span'); probe.style.color = 'var(--md-muted-2)'; document.body.appendChild(probe);
  const want = getComputedStyle(probe).color; probe.remove();
  return { content: cs.content, colourIsMuted2: cs.color === want };
});
check('empty-doc: opens with one focused transient and its hint', DESKTOP, async (page, boot) => {
  assert.deepStrictEqual(await blockList(page), ['~paragraph:']);
  assert.deepStrictEqual(await caretNow(page), { text: '', offset: 0, transient: true });
  assert.deepStrictEqual(await hintOf(page), { content: '"輸入文字，或按「/」選擇區塊"', colourIsMuted2: true });
  await page.keyboard.type('Hello');
  assert.strictEqual((await hintOf(page)).content, 'none');
  assert.strictEqual(await saveAndRead(page, boot), 'Hello\n');
}, { md: '' });
check('empty-doc: a whitespace-only file is an empty document', DESKTOP, async (page, boot) => {
  await page.keyboard.type('Hi');
  assert.strictEqual(await saveAndRead(page, boot), 'Hi\n');
}, { md: '\n\n' });
check('empty-doc: typing and erasing everything writes nothing and keeps the paragraph', DESKTOP, async (page, boot) => {
  await page.keyboard.type('ab'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
  assert.strictEqual(await saveAndRead(page, boot), '');
  assert.strictEqual(await transientCount(page), 1);
}, { md: '' });
check('empty-doc: in dark mode the hint keeps the muted token', DESKTOP, async (page) => {
  await page.locator('#md2doc-theme-toggle').click(); await wait(300);
  assert.deepStrictEqual(await hintOf(page), { content: '"輸入文字，或按「/」選擇區塊"', colourIsMuted2: true });
}, { md: '' });
check('empty-doc: the table button inserts a table at the top', DESKTOP, async (page, boot) => {
  await tb(page, 'table');
  await page.keyboard.type('x');
  await page.keyboard.press('Control+s'); await renderIdle(page);
  assert.deepStrictEqual(mdTable(fs.readFileSync(boot.mdPath, 'utf8')), [['A', 'B', 'C'], ['x', '', ''], ['', '', '']]);
}, { md: '' });
check('click-below: a click under the last block opens a transient at the end', DESKTOP, async (page, boot) => {
  const pt = await page.evaluate(() => { const bs = document.querySelectorAll('.content .ed-block'); const r = bs[bs.length - 1].getBoundingClientRect(); return [r.left + 40, r.bottom + 60]; });
  await page.mouse.click(pt[0], pt[1]); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', 'paragraph:Omega.', '~paragraph:']);
  assert.deepStrictEqual(await caretNow(page), { text: '', offset: 0, transient: true });
  await page.mouse.click(pt[0], pt[1] + 20); await renderIdle(page);
  assert.strictEqual(await transientCount(page), 1, 'a second click reuses it');
  await page.keyboard.type('Tail.');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\nOmega.\n\nTail.\n');
}, { md: BASE_MD });
// Final review M6: a press below a last transient that holds typed text puts
// the caret at the end of that text, not its start. Reached without a failed
// commit: the caret is still in the transient, so the mousedown only moves
// the caret; the click that follows commits the transient (the click
// delegator's switchAwayFrom), and keys typed during that render are held and
// replayed where the caret was put.
check('click-below: a click under a transient with text puts the caret at the end of its text', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Omega.', 6);
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('new');
  await delayRender(page, 800);
  const pt = await page.evaluate(() => { const bs = document.querySelectorAll('.content .ed-block'); const r = bs[bs.length - 1].getBoundingClientRect(); return [r.left + 40, r.bottom + 60]; });
  await page.mouse.move(pt[0], pt[1]); await page.mouse.down();
  assert.deepStrictEqual(await caretNow(page), { text: 'new', offset: 3, transient: true });
  await page.mouse.up(); await page.keyboard.type('X');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\nOmega.\n\nnewX\n');
}, { md: BASE_MD });
check('click-below: a click between two blocks opens nothing', DESKTOP, async (page) => {
  const pt = await page.evaluate(() => { const a = [...document.querySelectorAll('.content .ed-block')][1].getBoundingClientRect(); return [a.left + 40, a.bottom + 4]; });
  await page.mouse.click(pt[0], pt[1]); await renderIdle(page);
  assert.strictEqual(await transientCount(page), 0);
}, { md: BASE_MD });
check('placeholder: a transient made by Enter at a paragraph start shows its hint unfocused', DESKTOP, async (page) => {
  await focusSurface(page, 'Omega.', 0);
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await hintOf(page), { content: '"輸入文字，或按「/」選擇區塊"', colourIsMuted2: true });
}, { md: BASE_MD });
// v3.15.0 T2 (D11, R25): migrated from "…are off while it is empty" — on an
// empty transient the three now insert their skeleton.
check('toolbar-transient: quote, numbered and check are on while it is empty and insert their skeleton', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  const st = () => page.evaluate(() => ['quote', 'ordered-list', 'check'].map((id) => document.querySelector('[data-ed-tb="' + id + '"]').disabled));
  assert.deepStrictEqual(await st(), [false, false, false]);
  await page.keyboard.type('x'); await wait(200);
  assert.deepStrictEqual(await st(), [false, false, false]);
  await page.keyboard.press('Backspace'); await wait(200);
  assert.deepStrictEqual(await st(), [false, false, false], 'empty again');
  await tb(page, 'ordered-list'); await page.keyboard.type('n');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n1. n\n\nOmega.\n');
}, { md: BASE_MD });
check('toolbar-transient: 引用 on an empty paragraph opens the raw box seeded "> "', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await tb(page, 'quote');
  assert.deepStrictEqual(await rawBox(page), { value: '> ', caret: 2, focused: true });
  await page.keyboard.type('Q'); await page.keyboard.press('Control+Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n> Q\n\nOmega.\n');
}, { md: BASE_MD });
check('toolbar-transient: 清單 on a transient with text commits it as a list item', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('Item');
  await tb(page, 'list');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n- Item\n\nOmega.\n');
}, { md: BASE_MD });

check('toolbar-transient: an empty one keeps a line of height', DESKTOP, async (page) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  assert.strictEqual(await page.evaluate(() => document.querySelector('[data-ed-transient] .ed-wys-armed').offsetHeight >= 20), true);
}, { md: BASE_MD });
check('toolbar-transient: 分隔線 on an empty one writes a rule and leaves a focused transient after it', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await tb(page, 'line');
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', 'hr:', '~paragraph:', 'paragraph:Omega.']);
  assert.deepStrictEqual(await caretNow(page), { text: '', offset: 0, transient: true });
  await page.keyboard.type('Z');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n---\n\nZ\n\nOmega.\n');
}, { md: BASE_MD });
check('toolbar-transient: 標題 2 on an empty one inserts a heading and typing fills it', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.click('[data-ed-tb="headings"]');
  await page.locator('.ed-toolbar-menu-btn', { hasText: '標題 2' }).click(); await renderIdle(page);
  await page.keyboard.type('Sub');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n## Sub\n\nOmega.\n');
}, { md: BASE_MD });
check('toolbar-transient: 清單 on an empty one inserts a list item at its position', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await tb(page, 'list');
  await page.keyboard.type('One');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n- One\n\nOmega.\n');
}, { md: BASE_MD });
check('toolbar-transient: 清單 on an empty one right below a list continues that list', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await tb(page, 'list');
  await page.keyboard.type('One'); await commitAndRead(page, boot);
  await liText(page, 'One').click(); await page.keyboard.press('End');
  await tb(page, 'insert-after');
  await tb(page, 'list');
  await page.keyboard.type('Two');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n- One\n- Two\n\nOmega.\n');
}, { md: BASE_MD });
check('toolbar-transient: 圖片 on an empty one replaces it with the picked image', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-ed-tb="image"]')]);
  // MIGRATED by v3.15.0 T10 (R41): setFiles + renderIdle -> pickImage(), which
  // also waits for the /api/asset upload renderIdle does not count.
  await pickImage(page, chooser);
  assert.strictEqual(await transientCount(page), 0);
  const disk = await saveAndRead(page, boot);
  assert.ok(/^# D\n\nAlpha\.\n\n!\[\]\(assets\/dot(-\d+)?\.png\)\n\nOmega\.\n$/.test(disk), 'file: ' + JSON.stringify(disk));
}, { md: BASE_MD });
check('empty-doc: the code button inserts a fenced block at the top', DESKTOP, async (page, boot) => {
  await tb(page, 'code');
  // v3.17.0 T2: the in-place code edit, on the skeleton's empty body.
  assert.deepStrictEqual({ edit: await codeEdit(page), raw: await rawBox(page) },
    { edit: { text: '', caret: 0, focused: true }, raw: null }, 'the code edit is open on the empty body');
  await page.keyboard.type('x');
  await page.keyboard.press('Control+Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '```\nx\n```\n');
}, { md: '' });
check('empty-doc: erasing the last block leaves a transient to type into', DESKTOP, async (page, boot) => {
  await tb(page, 'insert-after');
  assert.strictEqual(await transientCount(page), 1);
  await page.keyboard.type('a'); await page.keyboard.press('Backspace');
  assert.strictEqual(await saveAndRead(page, boot), '');
}, { md: '' });

// ── arrow-transient / paste-transient (v3.14.0 T5) ──
check('arrow-transient: ↑ out of an empty transient removes it and lands above', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.press('ArrowUp'); await renderIdle(page);
  assert.strictEqual(await transientCount(page), 0);
  assert.strictEqual((await caretNow(page)).text, 'Alpha.');
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD);
}, { md: BASE_MD });
check('arrow-transient: ↓ out of a transient with text commits it and lands below', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await page.keyboard.type('New');
  await page.keyboard.press('ArrowDown'); await renderIdle(page);
  assert.strictEqual((await caretNow(page)).text, 'Omega.');
  assert.strictEqual(await noticeText(page), null);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\nNew\n\nOmega.\n');
}, { md: BASE_MD });
// guard (green before the change): the arrow already lands in a transient
check('arrow-transient: ↑ walks into a transient left by Enter at a paragraph start', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Omega.', 0); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.press('ArrowUp'); await renderIdle(page);
  assert.deepStrictEqual(await caretNow(page), { text: '', offset: 0, transient: true });
  assert.strictEqual(await noticeText(page), null);
  await page.keyboard.type('Mid'); await page.keyboard.press('ArrowDown'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\nMid\n\nOmega.\n');
}, { md: BASE_MD });
// guard (green before the change)
check('arrow-transient: ↑ from the first paragraph into a transient at the top', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 0); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.press('ArrowUp');
  assert.strictEqual(await noticeText(page), null);
  await page.keyboard.type('Top'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), 'Top\n\nAlpha.\n');
}, { md: 'Alpha.\n' });
check('paste-transient: plain text lands in it', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await clipboardEvent(page, 'paste', 'pasted', null);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\npasted\n\nOmega.\n');
}, { md: BASE_MD });
check('paste-transient: two paragraphs replace it in one undo step', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await clipboardEvent(page, 'paste', 'P1\n\nP2', '<p>P1</p><p>P2</p>');
  assert.strictEqual(await transientCount(page), 0);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\nP1\n\nP2\n\nOmega.\n');
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD);
}, { md: BASE_MD });
check('paste-transient: an image replaces it', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  // MIGRATED by v3.15.0 T10 (R41): the paste is also waited out through its
  // /api/asset upload, which renderIdle alone does not count.
  await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/asset'),
    page.evaluate((b64) => {
      const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const dt = new DataTransfer(); dt.items.add(new File([u], 'dot.png', { type: 'image/png' }));
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, PNG_1PX),
  ]);
  await renderIdle(page);
  const disk = await saveAndRead(page, boot);
  assert.ok(/^# D\n\nAlpha\.\n\n!\[\]\(assets\/dot(-\d+)?\.png\)\n\nOmega\.\n$/.test(disk), 'file: ' + JSON.stringify(disk));
}, { md: BASE_MD });
check('paste-transient: blocks pasted after typed text keep the text first', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await page.keyboard.type('Lead');
  await clipboardEvent(page, 'paste', 'H\n\nP2', '<h2>H</h2><p>P2</p>');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\nLead\n\n## H\n\nP2\n\nOmega.\n');
  assert.deepStrictEqual(await caretNow(page), { text: 'P2', offset: 2, transient: false });
}, { md: BASE_MD });

// ── v3.14.0 B3 fix round 1 ──
const throwOnceInSerialize = (page) => page.evaluate(() => {
  const im = window.md2docInlineMd; const orig = im.serializeInline;
  im.serializeInline = function () { im.serializeInline = orig; throw new Error('probe'); };
});
check('paste-transient: a paste commit that throws shows the error card and keeps the typed text', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await page.keyboard.type('Lead');
  await throwOnceInSerialize(page);
  await clipboardEvent(page, 'paste', 'H\n\nP2', '<h2>H</h2><p>P2</p>');
  assert.ok(/未預期/.test(await noticeText(page) || ''), 'the error card: ' + await noticeText(page));
  assert.strictEqual(await page.evaluate(() => document.querySelector('[data-ed-transient] .ed-wys-armed').textContent), 'Lead');
  await page.keyboard.type('X');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\nLeadX\n\nOmega.\n');
}, { md: BASE_MD });
check('click-below: a rejection while resolving shows the error card and the next click works', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Omega.', 6); await page.keyboard.type('Z');
  await throwOnceInSerialize(page);
  const pt = await page.evaluate(() => { const bs = document.querySelectorAll('.content .ed-block'); const r = bs[bs.length - 1].getBoundingClientRect(); return [r.left + 40, r.bottom + 60]; });
  await page.mouse.click(pt[0], pt[1]); await renderIdle(page);
  assert.ok(/未預期/.test(await noticeText(page) || ''), 'the error card: ' + await noticeText(page));
  await page.mouse.click(pt[0], pt[1]); await renderIdle(page);
  await page.keyboard.type('Tail.');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\nOmega.Z\n\nTail.\n');
}, { md: BASE_MD });
check('toolbar-transient: 圖片 on an empty one survives a window blur while the file dialog is open', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-ed-tb="image"]')]);
  await page.evaluate(() => {
    document.activeElement.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    window.dispatchEvent(new Event('blur'));
  });
  await wait(300);
  assert.strictEqual(await transientCount(page), 1, 'the transient is still there');
  // MIGRATED by v3.15.0 T10 (R41): setFiles + renderIdle -> pickImage().
  await pickImage(page, chooser);
  const disk = await saveAndRead(page, boot);
  assert.ok(/^# D\n\nAlpha\.\n\n!\[\]\(assets\/dot(-\d+)?\.png\)\n\nOmega\.\n$/.test(disk), 'file: ' + JSON.stringify(disk));
}, { md: BASE_MD });

// ── failed-render, lists (v3.14.0 T6; R14 widened) ──
// The first `n` renders are held 800 ms and then fail.
const failRenders = async (page, n) => {
  let left = n;
  await page.route('**/api/render', async (route) => {
    if (left <= 0) { await route.continue(); return; }
    left--;
    await wait(800);
    await route.fulfill({ status: 500, body: '{}' });
  });
};
for (const [kind, md, want] of [
  ['tight', TIGHT_MD, '# D\n\n- alpha\n- bravo\n- new\n- charlie\n'],
  ['loose', LOOSE_MD, '# D\n\n- alpha\n\n- bravo\n\n- new\n\n- charlie\n'],
]) {
  check('failed-render: ' + kind + ' list Enter, the file matches the screen', DESKTOP, async (page, boot) => {
    await failFirstRender(page);
    await liText(page, 'bravo').click(); await page.keyboard.press('End');
    await page.keyboard.press('Enter'); await page.keyboard.type('new');
    await renderIdle(page);
    const screen = await liTexts(page);
    assert.deepStrictEqual(screen, ['alpha', 'bravo', 'new', 'charlie'], 'guard: the screen keeps the new item');
    assert.strictEqual(await commitAndRead(page, boot), want);
    assert.deepStrictEqual(await liTexts(page), screen, 'DOM equals file');
  }, { md });
}
// R11: clickChar + End rather than focusSurface (its click lands mid-word).
check('failed-render: a later edit elsewhere also writes the pending list first', DESKTOP, async (page, boot) => {
  await failFirstRender(page);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('new'); await renderIdle(page);
  await clickChar(page, 'Omega.', 5); await page.keyboard.press('End'); await page.keyboard.type('!');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- new\n- charlie\n\nOmega.!\n');
}, { md: LIST_PARA_MD });
// R6, the list half: a structural key while a failed list Enter is pending
// re-commits it first, then acts — the caret stays in the new item.
check('failed-render: Enter after a failed list Enter re-commits it, then adds another item', DESKTOP, async (page, boot) => {
  await failFirstRender(page);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('new'); await renderIdle(page);
  await page.keyboard.press('Enter'); await page.keyboard.type('x'); await renderIdle(page);
  // renderIdle can return between the retry's render and the replayed Enter's
  // render, before the held x is replayed (measured: 8/48 under load read '').
  // Wait the held render out, as the R51 checks do, then read.
  await wait(1500); await renderIdle(page);
  assert.deepStrictEqual(await liTexts(page), ['alpha', 'bravo', 'new', 'x', 'charlie']);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- new\n- x\n- charlie\n');
}, { md: TIGHT_MD });
// Ctrl+S right after a failed list Enter writes it and keeps the caret.
check('failed-render: Ctrl+S after a failed list Enter saves it and the caret stays in the new item', DESKTOP, async (page, boot) => {
  await failFirstRender(page);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('new'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- new\n- charlie\n');
  assert.deepStrictEqual(await caretNow(page), { text: 'new', offset: 3, transient: false });
}, { md: TIGHT_MD });
// R28: the split's render fails, the retry a click into another block makes
// fails too, and the user types there. The next commit writes both.
check('failed-render: typing in another block after a failed split and a failed retry is kept', DESKTOP, async (page, boot) => {
  await failRenders(page, 2);
  await focusSurface(page, 'Bravo paragraph text.', 3);
  await page.keyboard.press('Enter'); await renderIdle(page);
  await clickChar(page, 'Omega.', 5); await renderIdle(page);
  assert.deepStrictEqual(await paragraphs(page), ['Alpha para one.', 'Bra', 'vo paragraph text.', 'Omega.'], 'guard: the screen keeps the split');
  await page.keyboard.type('X');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha para one.\n\nBra\n\nvo paragraph text.\n\nOmegaX.\n');
  assert.deepStrictEqual(await paragraphs(page), ['Alpha para one.', 'Bra', 'vo paragraph text.', 'OmegaX.'], 'DOM equals file');
  // One undo step each, newest first: the typing, then the split.
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await renderIdle(page);
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.deepStrictEqual(await paragraphs(page), ['Alpha para one.', 'Bra', 'vo paragraph text.', 'Omega.'], 'first undo: the typing');
}, { md: P3_MD });
check('failed-render: typing in another block after a failed list Enter and a failed retry is kept', DESKTOP, async (page, boot) => {
  await failRenders(page, 2);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('new'); await renderIdle(page);
  await clickChar(page, 'Omega.', 5); await renderIdle(page);
  assert.deepStrictEqual(await liTexts(page), ['alpha', 'bravo', 'new', 'charlie'], 'guard: the screen keeps the new item');
  await page.keyboard.type('X');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- new\n- charlie\n\nOmegaX.\n');
}, { md: LIST_PARA_MD });
// R34: a pending structure is unsaved work — the title says so, and an edit
// made outside raises the conflict card instead of reloading it away.
check('failed-render: a pending split counts as unsaved work', DESKTOP, async (page, boot) => {
  await failFirstRender(page);
  await focusSurface(page, 'Bravo paragraph text.', 3);
  await page.keyboard.press('Enter'); await renderIdle(page);
  const split = ['Alpha para one.', 'Bra', 'vo paragraph text.', 'Omega.'];
  assert.deepStrictEqual(await paragraphs(page), split, 'guard: the screen keeps the split');
  assert.strictEqual((await page.title()).indexOf('● '), 0, 'the title shows unsaved work');
  await page.evaluate(() => { window.__r34Probe = 1; });
  fs.writeFileSync(boot.mdPath, P3_MD + '\nAppended outside.\n');
  const read = () => page.evaluate(() => ({ samePage: window.__r34Probe === 1,
    conflict: [...document.querySelectorAll('.ed-conflict')].some((c) => c.textContent.includes('這個檔案剛在別處被修改')) }));
  let r = null;
  for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
    await wait(250);
    try { r = await read(); } catch (e) { r = { samePage: false, conflict: false }; }
    if (r.conflict || !r.samePage) break;
  }
  assert.deepStrictEqual(r, { samePage: true, conflict: true });
  assert.deepStrictEqual(await paragraphs(page), split, 'the split is still on screen');
}, { md: P3_MD });

// ── enter-type (v3.14.0 T7): formatting chords and repeated clicks in one surface mid-render ──
const editAlphaThenFlight = async (page) => {
  await delayRender(page, 800);
  await clickChar(page, 'Alpha para one.', 14); await page.keyboard.press('End'); await page.keyboard.type('1');
};
const P3_HEAD = '# D\n\nAlpha para one.1\n\n';
check('enter-type: Ctrl+B mid-render bolds what is typed next', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.press('Control+b'); await page.keyboard.type('x');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- **x**\n- charlie\n');
}, { md: TIGHT_MD });
check('enter-type: Ctrl+I on a word double-clicked mid-render', DESKTOP, async (page, boot) => {
  await editAlphaThenFlight(page);
  await dblclickChar(page, 'Bravo paragraph text.', 8); await page.keyboard.press('Control+i');
  assert.strictEqual(await commitAndRead(page, boot), P3_HEAD + 'Bravo *paragraph* text.\n\nOmega.\n');
}, { md: P3_MD });
check('enter-type: Ctrl+U mid-render underlines what is typed next', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.press('Control+u'); await page.keyboard.type('x');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- <u>x</u>\n- charlie\n');
}, { md: TIGHT_MD });
check('enter-type: a Backspace before a second click in the same paragraph shifts the click back', DESKTOP, async (page, boot) => {
  await editAlphaThenFlight(page);
  await clickChar(page, 'Bravo paragraph text.', 5); await page.keyboard.press('Backspace');
  await clickChar(page, 'Bravo paragraph text.', 15); await page.keyboard.type('Z');
  assert.strictEqual(await commitAndRead(page, boot), P3_HEAD + 'Brav paragraphZ text.\n\nOmega.\n');
}, { md: P3_MD });
check('enter-type: a paste before a second click in the same paragraph shifts the click', DESKTOP, async (page, boot) => {
  await editAlphaThenFlight(page);
  await clickChar(page, 'Bravo paragraph text.', 5);
  await page.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'PP'); document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
  await clickChar(page, 'Bravo paragraph text.', 15); await page.keyboard.type('Z');
  assert.strictEqual(await commitAndRead(page, boot), P3_HEAD + 'BravoPP paragraphZ text.\n\nOmega.\n');
}, { md: P3_MD });
check('enter-type: a word replaced before a second click shifts the click by the difference', DESKTOP, async (page, boot) => {
  await editAlphaThenFlight(page);
  await dblclickChar(page, 'Bravo paragraph text.', 8); await page.keyboard.type('Q');
  await clickChar(page, 'Bravo paragraph text.', 20); await page.keyboard.type('Z');
  assert.strictEqual(await commitAndRead(page, boot), P3_HEAD + 'Bravo Q textZ.\n\nOmega.\n');
}, { md: P3_MD });
check('enter-type: two clicks at the same spot keep their typing in order', DESKTOP, async (page, boot) => {
  await editAlphaThenFlight(page);
  await clickChar(page, 'Bravo paragraph text.', 5); await page.keyboard.type('X');
  await clickChar(page, 'Bravo paragraph text.', 7); await page.keyboard.type('Y');
  await clickChar(page, 'Bravo paragraph text.', 7); await page.keyboard.type('Z');
  assert.strictEqual(await commitAndRead(page, boot), P3_HEAD + 'BravoX pYZaragraph text.\n\nOmega.\n');
}, { md: P3_MD });

// ── shift-enter / escape (v3.14.0 T8) ──
check('shift-enter: a character typed after Shift+Enter at a paragraph end lands after the break', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.press('Shift+Enter'); await page.keyboard.type('Z');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.<br>Z\n\nOmega.\n');
}, { md: BASE_MD });
check('shift-enter: the same in a list item', DESKTOP, async (page, boot) => {
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Shift+Enter'); await page.keyboard.type('Z');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo<br>Z\n- charlie\n');
}, { md: TIGHT_MD });
check('shift-enter: the same for Enter in a table cell', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'a1', 2);
  await page.keyboard.press('Enter'); await page.keyboard.type('Z');
  assert.deepStrictEqual(mdTable(await commitAndRead(page, boot))[1], ['a1<br>Z', 'b1']);
}, { md: TBL2_MD });
check('shift-enter: the same while a list commit renders', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('ab');
  await page.keyboard.press('Shift+Enter'); await page.keyboard.type('c');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- ab<br>c\n- charlie\n');
}, { md: TIGHT_MD });
// Guard (may be green before T8): T8 must keep these bytes.
check('shift-enter: Shift+Enter then leaving writes the same bytes as before', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.press('Shift+Enter');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.<br>\n\nOmega.\n');
}, { md: BASE_MD });
check('escape: a character typed right after Escape is kept', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.type('X'); await page.keyboard.press('Escape');
  assert.deepStrictEqual(await caretNow(page), { text: 'Alpha.', offset: 6, transient: false });
  await page.keyboard.type('Y');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.Y\n\nOmega.\n');
}, { md: BASE_MD });
check('escape: in a new list item, Escape then typing keeps the typing', DESKTOP, async (page, boot) => {
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('ab'); await page.keyboard.press('Escape'); await page.keyboard.type('c');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- c\n- charlie\n');
}, { md: TIGHT_MD });
// Guard (may be green before T8): the T21 one-Ctrl+Z restore must survive
// the caret staying put.
check('escape: Ctrl+Z right after Escape still brings the discarded typing back', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.type('X'); await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.X\n\nOmega.\n');
}, { md: BASE_MD });
check('escape: typing after Ctrl+S on an untouched paragraph is saved', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.press('Control+s'); await renderIdle(page);
  await page.keyboard.type('Q');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.Q\n\nOmega.\n');
}, { md: BASE_MD });
// Added: Ctrl+S, then a structural key in the same surface (dead before
// ensureBurst — the T2/T3 note).
check('escape: Enter after Ctrl+S on an untouched paragraph splits it', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 3);
  await page.keyboard.press('Control+s'); await renderIdle(page);
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlp\n\nha.\n\nOmega.\n');
}, { md: BASE_MD });
// Final review I3: a format chord into a focused surface with no burst opens
// one, so the formatting is written. Measured before: the bold showed on
// screen and the file kept `Alpha.`. The selection is made without a click,
// which would not open a burst either (the surface already has focus).
async function selectInFocused(page, from, to) {
  assert.strictEqual(await page.evaluate(([a, b]) => {
    const s = document.activeElement;
    const n = s && s.firstChild;
    if (!n || n.nodeType !== 3 || n.data.length < b) return false;
    getSelection().setBaseAndExtent(n, a, n, b);
    return true;
  }, [from, to]), true, 'selectInFocused: a text node in the focused surface');
}
for (const [chord, want] of [['Control+b', '**Alpha**.'], ['Control+i', '*Alpha*.'], ['Control+u', '<u>Alpha</u>.']]) {
  check('escape: ' + chord + ' on a selection right after Escape is saved', DESKTOP, async (page, boot) => {
    await focusSurface(page, 'Alpha.', 6);
    await page.keyboard.type('X'); await page.keyboard.press('Escape');
    assert.deepStrictEqual(await caretNow(page), { text: 'Alpha.', offset: 6, transient: false }, 'guard: reverted, caret kept');
    await selectInFocused(page, 0, 5);
    await page.keyboard.press(chord);
    assert.strictEqual(await page.evaluate(() => !!document.activeElement.querySelector('b, strong, i, em, u')), true, 'guard: formatted on screen');
    assert.strictEqual(await commitAndRead(page, boot), '# D\n\n' + want + '\n\nOmega.\n');
  }, { md: BASE_MD });
}
check('escape: Control+b on a selection after Ctrl+S on an untouched paragraph is saved', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.press('Control+s'); await renderIdle(page);
  await selectInFocused(page, 0, 5);
  await page.keyboard.press('Control+b');
  assert.strictEqual(await page.evaluate(() => !!document.activeElement.querySelector('b, strong')), true, 'guard: bold on screen');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n**Alpha**.\n\nOmega.\n');
}, { md: BASE_MD });
// Added (D8 for a transient): Escape in a transient with text abandons it and
// the caret goes back where Enter was pressed, so the next key is kept.
check('escape: Escape in a typed-into transient puts the caret back and the next key is kept', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('new'); await page.keyboard.press('Escape');
  assert.strictEqual(await transientCount(page), 0, 'the transient is gone');
  assert.deepStrictEqual(await caretNow(page), { text: 'Alpha.', offset: 6, transient: false });
  await page.keyboard.type('Y');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.Y\n\nOmega.\n');
}, { md: BASE_MD });

// ── v3.14.0 B4 fix round 1 ──
// I1: a replay into one paragraph, then into another (which commits the
// first and replaces its surface), then a later click in the first.
check('enter-type: a click in another paragraph between two clicks in the same one keeps the later click in place', DESKTOP, async (page, boot) => {
  await editAlphaThenFlight(page);
  await clickChar(page, 'Bravo paragraph text.', 5); await page.keyboard.type('X');
  await clickChar(page, 'Omega.', 3); await page.keyboard.type('Y');
  await clickChar(page, 'Bravo paragraph text.', 10); await page.keyboard.type('Z');
  assert.strictEqual(await commitAndRead(page, boot), P3_HEAD + 'BravoX paraZgraph text.\n\nOmeYga.\n');
}, { md: P3_MD });
// I1, second half: a click made during a LATER render, in a surface whose
// earlier replayed edit survived a failed render, was taken in that
// surface's current text — it must not be shifted by that edit again. The
// first render lands (800 ms), the second is held 1.5 s and fails.
check('enter-type: a click during a later render, in a surface an earlier replay edited, lands where it was made', DESKTOP, async (page, boot) => {
  let n = 0;
  await page.route('**/api/render', async (route) => {
    n++;
    if (n === 1) { await wait(800); await route.continue(); return; }
    if (n === 2) { await wait(1500); await route.fulfill({ status: 500, body: '{}' }); return; }
    await route.continue();
  });
  await clickChar(page, 'Alpha para one.', 14); await page.keyboard.press('End'); await page.keyboard.type('1');
  await clickChar(page, 'Omega.', 2); await page.keyboard.type('X');
  await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.type('Q');
  // Bounded: until X has replayed and the replayed Enter's commit is out.
  let seen = false;
  for (const deadline = Date.now() + 5000; Date.now() < deadline && !seen;) {
    await wait(25);
    seen = n === 2 && await page.evaluate(() => [...document.querySelectorAll('.ed-wys-armed')].some((e) => e.textContent === 'OmXega.'));
  }
  assert.strictEqual(seen, true, 'guard: X replayed into Omega and the second render is out');
  await clickChar(page, 'OmXega.', 5); await page.keyboard.type('W');
  assert.strictEqual(renderCounters.get(page).n > 0 && n === 2, true, 'guard: the click and W fell inside the second render');
  await renderIdle(page); await wait(300); await renderIdle(page);
  const omega = await page.evaluate(() => [...document.querySelectorAll('.ed-wys-armed')].map((e) => e.textContent).find((t) => t.indexOf('Om') === 0));
  assert.strictEqual(omega, 'OmXegWa.Q');
}, { md: P3_MD });
// I2: an item typed into after a failed retry, whose own retry fails too.
check('failed-render: typing in a list item survives a retry that fails again', DESKTOP, async (page, boot) => {
  await failRenders(page, 3);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('new'); await renderIdle(page);
  await liText(page, 'charlie').click(); await renderIdle(page);
  await page.keyboard.press('End'); await page.keyboard.type('Q');
  await clickChar(page, 'Omega.', 5); await renderIdle(page);
  assert.deepStrictEqual(await liTexts(page), ['alpha', 'bravo', 'new', 'charlieQ'], 'guard: the screen after three failed renders');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- new\n- charlieQ\n\nOmega.\n');
  assert.deepStrictEqual(await liTexts(page), ['alpha', 'bravo', 'new', 'charlieQ'], 'DOM equals file');
}, { md: LIST_PARA_MD });
// I3 (R35): IME text into a focused surface with no burst.
const imeType = async (page, ch) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'ㄋ', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.insertText', { text: ch });
};
check('escape: an IME character typed right after Escape is kept', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.type('X'); await page.keyboard.press('Escape');
  await imeType(page, '你');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.你\n\nOmega.\n');
}, { md: BASE_MD, engines: ['chromium'] });
check('escape: an IME character after Ctrl+S on an untouched paragraph is saved', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.press('Control+s'); await renderIdle(page);
  await imeType(page, '你');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.你\n\nOmega.\n');
}, { md: BASE_MD, engines: ['chromium'] });
// Escape then IME composition, then Ctrl+Z steps back over the composed text
// only (one burst, opened once).
check('escape: after Escape an IME character is one undo step', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.press('Escape');
  await imeType(page, '你'); await wait(500);
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await page.evaluate(() => [...document.querySelectorAll('.ed-wys-armed')].map((e) => e.textContent)[1]), 'Alpha.');
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD);
}, { md: BASE_MD, engines: ['chromium'] });

// ── edit-search (v3.14.0 T9) ──
const SEARCH_MD = '# D\n\n## One\n\nAlpha bravo.\n\n- item one\n\n## Two\n\nCharlie delta.\n';
const SEARCH2_MD = '# D\n\n## Part\n\n- item one\n- item two\n\n## Rest\n\nCharlie delta.\n';
const editMarks = (page) => page.evaluate(() => {
  const ms = [...document.querySelectorAll('.content mark.search-hit')];
  return { text: ms.map((m) => m.textContent).join('').toLowerCase(), types: ms.map((m) => m.closest('.ed-block').getAttribute('data-block-type')) };
});
const editMarksInSurface = (page) => page.evaluate(() => document.querySelectorAll('.ed-wys-armed mark.search-hit').length);
const editSearch = async (page, q) => { await page.fill('#doc-search-input', q); await page.press('#doc-search-input', 'Enter'); await wait(300); };
check('edit-search: a hit in a section paragraph is marked', DESKTOP, async (page) => {
  await editSearch(page, 'charlie');
  assert.deepStrictEqual(await editMarks(page), { text: 'charlie', types: ['paragraph'] });
}, { md: SEARCH_MD });
check('edit-search: a phrase across two blocks of a section is marked', DESKTOP, async (page) => {
  await editSearch(page, 'bravo. item');
  assert.deepStrictEqual(await editMarks(page), { text: 'bravo.item', types: ['paragraph', 'li'] });
}, { md: SEARCH_MD });
check('edit-search: a phrase across two adjacent list items is marked', DESKTOP, async (page) => {
  await editSearch(page, 'one item');
  assert.deepStrictEqual(await editMarks(page), { text: 'oneitem', types: ['li', 'li'] });
}, { md: SEARCH2_MD });
check('edit-search: clearing restores the edit DOM', DESKTOP, async (page) => {
  const before = await page.evaluate(() => document.querySelector('.content').innerHTML);
  await editSearch(page, 'charlie');
  assert.strictEqual((await editMarks(page)).text, 'charlie', 'the mark exists before clearing');
  await page.fill('#doc-search-input', ''); await page.press('#doc-search-input', 'Enter'); await wait(300);
  assert.strictEqual(await page.evaluate(() => document.querySelector('.content').innerHTML), before);
}, { md: SEARCH_MD });
check('edit-search: typing into a marked paragraph saves plain text', DESKTOP, async (page, boot) => {
  await editSearch(page, 'bravo');
  assert.ok(await editMarksInSurface(page) > 0, 'a mark stands inside the paragraph surface');
  await focusSurface(page, 'Alpha bravo.', 12); await page.keyboard.type('X');
  assert.strictEqual(await commitAndRead(page, boot), SEARCH_MD.replace('Alpha bravo.', 'Alpha bravo.X'));
  assert.strictEqual(await page.evaluate(() => !!document.querySelector('textarea.ed-raw')), false, 'no source box');
  assert.strictEqual(await noticeText(page), null);
}, { md: SEARCH_MD });
// R36 (v3.15.0 T10, R76): a heading inside a blockquote does not end the
// section above it, and the section index lists the text after the quote under
// that heading's own section (B). Its hit is marked: sectionBoundary() walks
// from the top-level block that holds the heading (here a block wrapper; in
// the reader the blockquote itself), so it reaches the paragraph after the
// quote. The reader pins the same fixture (`search: a hit after a blockquote
// heading is marked`).
const BQ_HEADING_MD = '# D\n\n## A\n\ntext a\n\n> ## B\n\nmatch here\n';
check('edit-search: a hit after a blockquote heading is marked (R36)', DESKTOP, async (page) => {
  await editSearch(page, 'match');
  assert.deepStrictEqual(await editMarks(page), { text: 'match', types: ['paragraph'] });
}, { md: BQ_HEADING_MD });
check('edit-search: an untouched marked paragraph stays byte-identical', DESKTOP, async (page, boot) => {
  await editSearch(page, 'bravo');
  assert.ok(await editMarksInSurface(page) > 0, 'a mark stands inside the paragraph surface');
  await focusSurface(page, 'Alpha bravo.', 0);
  await page.fill('#doc-search-input', ''); await page.press('#doc-search-input', 'Enter'); await wait(300);
  assert.strictEqual(await commitAndRead(page, boot), SEARCH_MD);
}, { md: SEARCH_MD });

// ── svg-plate (v3.14.0 T10) ──
const SVG_MD = '# D\n\n<svg width="40" height="20"><text x="2" y="14">S</text></svg>\n\nTail.\n';
check('svg-plate: an inline svg on the edit page sits on a white plate in dark only', DESKTOP, async (page, boot) => {
  const read = () => page.evaluate(() => { const s = document.querySelector('.content .ed-block > p > svg, .content .ed-block > svg'); const cs = getComputedStyle(s); return { bg: cs.backgroundColor, ink: cs.color }; });
  assert.strictEqual((await read()).bg, 'rgba(0, 0, 0, 0)', 'light: no plate');
  await page.locator('#md2doc-theme-toggle').click(); await wait(300);
  assert.deepStrictEqual(await read(), { bg: 'rgb(255, 255, 255)', ink: 'rgb(31, 35, 40)' });
  assert.strictEqual(await saveAndRead(page, boot), SVG_MD, 'no byte changes');
}, { md: SVG_MD });

// ── slash (v3.15.0 T1): the "/" block menu ──
// The menu as the user sees it: the labels of its items in order, the item
// under the keyboard cursor, the 「沒有符合的區塊」 line, and where it sits —
// `below` = its top is at or under the caret's bottom, `inView` = it is inside
// the viewport. The caret rect is the collapsed selection's own client rect.
async function slashMenu(page) {
  return page.evaluate(() => {
    const m = document.querySelector('.ed-slash-menu');
    if (!m || !m.isConnected || m.hidden) return { open: false, labels: [], cursor: null, empty: null, below: null, inView: null };
    const labelOf = (b) => b.querySelector('.ed-slash-label').textContent;
    const items = [...m.querySelectorAll('.ed-slash-item')].filter((b) => b.getClientRects().length > 0);
    const cur = m.querySelector('.ed-slash-item[data-ed-slash-cursor]');
    const emptyEl = m.querySelector('.ed-slash-empty');
    const r = m.getBoundingClientRect();
    let below = null;
    const sel = getSelection();
    if (sel.rangeCount) {
      const range = sel.getRangeAt(0).cloneRange(); range.collapse(false);
      const rects = range.getClientRects();
      const c = rects.length ? rects[rects.length - 1] : null;
      if (c) below = r.top >= c.bottom - 0.5;
    }
    return { open: true, labels: items.map(labelOf), cursor: cur ? labelOf(cur) : null,
      empty: emptyEl && emptyEl.getClientRects().length ? emptyEl.textContent : null,
      below, inView: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth };
  });
}
// A real mouse click on the visible item labelled `label`, then the render.
async function slashPick(page, label) {
  const pt = await page.evaluate((l) => {
    const b = [...document.querySelectorAll('.ed-slash-menu .ed-slash-item')]
      .find((x) => x.querySelector('.ed-slash-label').textContent === l && x.getClientRects().length > 0);
    if (!b) return null;
    b.scrollIntoView({ block: 'nearest' });
    const r = b.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  }, label);
  assert.ok(pt, 'slashPick: no visible item ' + JSON.stringify(label));
  await page.mouse.click(pt[0], pt[1]);
  await renderIdle(page);
}
// The raw source box, when one is open: its value, caret and focus.
const rawBox = (page) => page.evaluate(() => {
  const t = document.querySelector('textarea.ed-raw');
  return t ? { value: t.value, caret: t.selectionStart, focused: document.activeElement === t } : null;
});
// The open in-place code edit: its text, the caret's character offset in it
// (null when the selection is elsewhere) and whether it has focus; null when
// no code block is being edited.
const codeEdit = (page) => page.evaluate(() => {
  const h = document.querySelector('pre[data-ed-code-edit]');
  if (!h) return null;
  const sel = getSelection();
  let caret = null;
  if (sel.rangeCount && h.contains(sel.focusNode)) {
    const r = document.createRange(); r.setStart(h, 0); r.setEnd(sel.focusNode, sel.focusOffset);
    caret = r.toString().length;
  }
  return { text: h.textContent, caret, focused: document.activeElement === h };
});
const inBase = (block) => '# D\n\nAlpha.\n\n' + block + '\n\nOmega.\n';
const TABLE_3X2_X = '| A | B | C |\n|---|---|---|\n| x |  |  |\n|  |  |  |';
const TABLE_3X2 = '| A | B | C |\n|---|---|---|\n|  |  |  |\n|  |  |  |';
// R19: an untouched pristine insert is discarded on save by design, so a
// check that saves a fresh table types into its first body cell first.
async function typeInFirstBodyCell(page, text) {
  await page.locator('.ed-block[data-block-type="table"] tbody tr').first().locator('td').first().click();
  await wait(150);
  await page.keyboard.type(text);
}
check('slash: "/" in an empty paragraph opens 16 items under the caret', DESKTOP, async (page) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('/');
  const m = await slashMenu(page);
  assert.strictEqual(m.labels.length, 16);
  assert.deepStrictEqual(m.labels, ['文字', '標題 1', '標題 2', '標題 3', '項目符號列表', '編號列表', '待辦清單', '引用', '程式碼', '分隔線', '表格', '圖片', 'Mermaid 圖', 'Graphviz 圖', 'WaveDrom 波形', '數學公式']);
  assert.strictEqual(m.cursor, '文字');
  assert.deepStrictEqual([m.below, m.inView], [true, true]);
  assert.deepStrictEqual(await caretNow(page), { text: '/', offset: 1, transient: true }, 'focus stays in the paragraph');
}, { md: BASE_MD });
check('slash: "/表" filters to 表格 and Enter inserts a 3×2 table in place of the empty paragraph', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('/表');
  assert.deepStrictEqual((await slashMenu(page)).labels, ['表格']);
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.strictEqual((await slashMenu(page)).open, false);
  assert.strictEqual(await transientCount(page), 0, 'the table took the empty paragraph\'s place');
  await typeInFirstBodyCell(page, 'x');
  assert.strictEqual(await saveAndRead(page, boot), inBase(TABLE_3X2_X));
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), inBase(TABLE_3X2), 'the typing is its own step');
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD, 'the insertion is one undo step');
}, { md: BASE_MD });
check('slash: with text before it, the item goes below and the "/query" is removed', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.type(' /h2');
  assert.deepStrictEqual((await slashMenu(page)).labels, ['標題 2']);
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('Sub');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n## Sub\n\nOmega.\n');
  // R43 M6: the "/query" removal left Alpha. as it was (no op), so the steps
  // are the insert and the typing.
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n##\n\nOmega.\n', 'the typing is one step');
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD, 'the insertion is one step');
}, { md: BASE_MD });
check('slash: ↑↓ cycle, Esc closes and keeps the text, Enter after Esc splits normally', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('/');
  await page.keyboard.press('ArrowUp');
  assert.strictEqual((await slashMenu(page)).cursor, '數學公式', 'wraps to the last');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  assert.strictEqual((await slashMenu(page)).cursor, '標題 1');
  await page.keyboard.press('Escape');
  assert.strictEqual((await slashMenu(page)).open, false);
  assert.deepStrictEqual(await caretNow(page), { text: '/', offset: 1, transient: true }, 'Esc did not revert the paragraph');
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', 'paragraph:/', '~paragraph:', 'paragraph:Omega.'], 'Enter split as usual');
  assert.strictEqual((await slashMenu(page)).open, false);
  assert.strictEqual(await saveAndRead(page, boot), inBase('/'));
}, { md: BASE_MD });
check('slash: no match shows the empty line; a space closes and keeps the text', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('/zz');
  const m = await slashMenu(page);
  assert.deepStrictEqual([m.empty, m.labels], ['沒有符合的區塊', []]);
  await page.keyboard.type(' x');
  assert.strictEqual((await slashMenu(page)).open, false);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n/zz x\n\nOmega.\n');
}, { md: BASE_MD });
// v3.17.0 T10 (M-a, R42): the empty line stays for two characters past the
// last query that matched ('u' matched 項目符號列表; 's' and 'r' keep it), and
// the third ('/') closes it. The text is plain paragraph text throughout.
check('slash: no match closes after three more characters and keeps the text (M-a)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  const seen = {};
  for (const [label, chars] of [['/u', '/u'], ['/us', 's'], ['/usr', 'r'], ['/usr/', '/']]) {
    await page.keyboard.type(chars);
    const m = await slashMenu(page);
    seen[label] = [m.open, m.labels.length];
  }
  assert.deepStrictEqual(seen, { '/u': [true, 1], '/us': [true, 0], '/usr': [true, 0], '/usr/': [false, 0] });
  await page.keyboard.type('bin');
  assert.strictEqual((await slashMenu(page)).open, false, 'it stays closed');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n/usr/bin\n\nOmega.\n');
}, { md: BASE_MD });
check('slash: Enter with no match closes the menu and splits', DESKTOP, async (page) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('/zz');
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.strictEqual((await slashMenu(page)).open, false);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', 'paragraph:/zz', '~paragraph:', 'paragraph:Omega.']);
}, { md: BASE_MD });
check('slash: a slash inside a word or URL opens nothing', DESKTOP, async (page) => {
  await focusSurface(page, 'Alpha.', 6);
  for (const s of ['src/lib', ' https://x.y/a', ' and/or']) { await page.keyboard.type(s); assert.strictEqual((await slashMenu(page)).open, false, s); }
}, { md: BASE_MD });
check('slash: a mouse click on an item inserts it (Graphviz renders, raw box not forced open)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('/');
  await slashPick(page, 'Graphviz 圖');
  assert.strictEqual((await slashMenu(page)).open, false);
  assert.strictEqual(await rawBox(page), null, 'no raw box');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n```dot\ndigraph { a -> b }\n```\n\nOmega.\n');
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.graphviz svg').length), 1);
}, { md: BASE_MD });
// One check per item: Enter at the end of Alpha., "/" + the item's first
// keyword, Enter. A pristine skeleton (heading, list, table, code, quote) is
// typed into before it is saved (R19); its block is asserted on screen first.
const SLASH_EVERY = [
  ['text', 'text', null],
  ['h1', 'h1', 'heading'], ['h2', 'h2', 'heading'], ['h3', 'h3', 'heading'],
  ['ul', 'bullet', 'li'], ['ol', 'ordered', 'li'], ['task', 'todo', 'li'],
  ['quote', 'quote', 'raw'], ['code', 'code', 'code-edit'],
  ['divider', 'divider', null], ['table', 'table', 'table'],
  ['mermaid', 'mermaid', null], ['graphviz', 'graphviz', null], ['wavedrom', 'wavedrom', null], ['math', 'math', null],
];
const SLASH_EVERY_LABEL = { text: '文字', h1: '標題 1', h2: '標題 2', h3: '標題 3', ul: '項目符號列表', ol: '編號列表', task: '待辦清單',
  quote: '引用', code: '程式碼', divider: '分隔線', table: '表格', mermaid: 'Mermaid 圖', graphviz: 'Graphviz 圖', wavedrom: 'WaveDrom 波形', math: '數學公式' };
for (const [id, kw] of SLASH_EVERY) {
  check('slash: every item writes its skeleton (text…math): ' + id, DESKTOP, async (page, boot) => {
    await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
    await page.keyboard.type('/' + kw);
    assert.strictEqual((await slashMenu(page)).cursor, SLASH_EVERY_LABEL[id], 'the keyword puts the cursor on the item');
    await page.keyboard.press('Enter'); await renderIdle(page);
    assert.strictEqual((await slashMenu(page)).open, false, 'the menu closed');
    const list = await blockList(page);
    if (id === 'text') {
      assert.deepStrictEqual(await caretNow(page), { text: '', offset: 0, transient: true }, '文字 on an empty paragraph leaves it empty');
      assert.strictEqual(await saveAndRead(page, boot), BASE_MD);
    } else if (id === 'h1' || id === 'h2' || id === 'h3') {
      assert.strictEqual(list[2], 'heading:');
      await page.keyboard.type('T');
      assert.strictEqual(await commitAndRead(page, boot), inBase('#'.repeat(Number(id.slice(1))) + ' T'));
    } else if (id === 'ul' || id === 'ol' || id === 'task') {
      assert.strictEqual(list[2], 'li:');
      await page.keyboard.type('T');
      assert.strictEqual(await commitAndRead(page, boot), inBase({ ul: '- T', ol: '1. T', task: '- [ ] T' }[id]));
    } else if (id === 'quote') {
      assert.deepStrictEqual(await rawBox(page), { value: '> ', caret: 2, focused: true });
      await page.keyboard.type('T'); await page.keyboard.press('Control+Enter'); await renderIdle(page);
      assert.strictEqual(await saveAndRead(page, boot), inBase('> T'));
    } else if (id === 'code') {
      // v3.17.0 T2: the in-place code edit on the empty body, not the raw box.
      assert.deepStrictEqual({ edit: await codeEdit(page), raw: await rawBox(page) },
        { edit: { text: '', caret: 0, focused: true }, raw: null });
      await page.keyboard.type('x'); await page.keyboard.press('Control+Enter'); await renderIdle(page);
      assert.strictEqual(await saveAndRead(page, boot), inBase('```\nx\n```'));
    } else if (id === 'divider') {
      assert.deepStrictEqual(await caretNow(page), { text: '', offset: 0, transient: true }, 'a paragraph below the rule takes the caret');
      assert.strictEqual(await saveAndRead(page, boot), inBase('---'));
    } else if (id === 'table') {
      assert.strictEqual(list[2], 'table:ABC');
      await typeInFirstBodyCell(page, 'x');
      assert.strictEqual(await saveAndRead(page, boot), inBase(TABLE_3X2_X));
    } else {
      assert.strictEqual(await rawBox(page), null, 'a diagram inserts rendered, no raw box');
      assert.deepStrictEqual(await caretNow(page), { text: '', offset: 0, transient: true }, 'a paragraph below the diagram takes the caret');
      assert.strictEqual(await saveAndRead(page, boot), inBase({
        mermaid: '```mermaid\ngraph TD\n  A --> B\n```',
        graphviz: '```dot\ndigraph { a -> b }\n```',
        wavedrom: "```wavedrom\n{ signal: [{ name: 'clk', wave: 'p....' }] }\n```",
        math: '$$\nx^2\n$$',
      }[id]));
    }
  }, { md: BASE_MD });
}
check('slash: "/表" then Enter during a slow render inserts the table', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.type(' x');
  await delayRender(page, 800);
  await page.keyboard.press('End'); await page.keyboard.press('Enter');   // a commit is now in flight
  await page.keyboard.type('/表'); await page.keyboard.press('Enter');
  await renderIdle(page);
  assert.strictEqual((await slashMenu(page)).open, false);
  assert.strictEqual(await transientCount(page), 0);
  await typeInFirstBodyCell(page, 'x');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha. x\n\n' + TABLE_3X2_X + '\n\nOmega.\n');
}, { md: BASE_MD });
check('slash: Tab inserts the cursor item', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('/h1');
  await page.keyboard.press('Tab'); await renderIdle(page);
  await page.keyboard.type('T');
  assert.strictEqual(await commitAndRead(page, boot), inBase('# T'));
}, { md: BASE_MD });
const TALL_MD = '# D\n\n' + Array.from({ length: 40 }, (_, i) => 'Filler ' + i + '.').join('\n\n') + '\n\nTarget.\n\n' +
  Array.from({ length: 40 }, (_, i) => 'Tail ' + i + '.').join('\n\n') + '\n';
check('slash: near the viewport bottom the menu opens above the caret', DESKTOP, async (page) => {
  await page.evaluate(() => {
    const s = [...document.querySelectorAll('.ed-wys-armed')].find((el) => el.textContent === 'Target.');
    window.scrollBy(0, s.getBoundingClientRect().bottom - (innerHeight - 60));
  });
  await wait(200);
  const y = await page.evaluate(() => [...document.querySelectorAll('.ed-wys-armed')].find((el) => el.textContent === 'Target.').getBoundingClientRect().bottom);
  assert.ok(y > 900 - 120 && y <= 900, 'the paragraph sits in the last 120px: ' + y);
  await focusSurface(page, 'Target.', 7);
  await page.keyboard.type(' /');
  const m = await slashMenu(page);
  assert.strictEqual(m.open, true);
  const g = await page.evaluate(() => {
    const r = getSelection().getRangeAt(0).getClientRects();
    const c = r[r.length - 1];
    const mr = document.querySelector('.ed-slash-menu').getBoundingClientRect();
    return { menuBottom: mr.bottom, caretTop: c.top, menuTop: mr.top };
  });
  assert.ok(g.menuBottom <= g.caretTop + 0.5, 'menu above the caret: ' + JSON.stringify(g));
  assert.deepStrictEqual([m.below, m.inView], [false, true]);
}, { md: TALL_MD });
check('slash: the placeholder names "/"', DESKTOP, async (page) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  assert.strictEqual((await hintOf(page)).content, '"輸入文字，或按「/」選擇區塊"');
}, { md: BASE_MD });
check('slash: the menu is readable in dark mode', DESKTOP, async (page) => {
  await page.locator('#md2doc-theme-toggle').click(); await wait(300);
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('/');
  const s = await page.evaluate(() => {
    const m = document.querySelector('.ed-slash-menu');
    const l = m.querySelector('.ed-slash-label');
    return { bg: getComputedStyle(m).backgroundColor, fg: getComputedStyle(l).color };
  });
  assert.strictEqual(s.bg, 'rgb(42, 42, 45)');
  assert.notStrictEqual(s.fg, s.bg);
  assert.ok(contrast(s.fg, s.bg) >= 4.5, 'label contrast ' + JSON.stringify(s));
}, { md: BASE_MD });
check('slash: scrolling closes the menu', DESKTOP, async (page) => {
  await focusSurface(page, 'Target.', 7); await page.keyboard.type(' /');
  assert.strictEqual((await slashMenu(page)).open, true);
  await page.mouse.wheel(0, 300); await wait(300);
  assert.strictEqual((await slashMenu(page)).open, false);
}, { md: TALL_MD });

// ── plus (v3.15.0 T2): ＋ and the toolbar's insert buttons open the "/" menu ──
// Hovers the block whose surface text is `text`, clicks its ＋ with the real
// mouse (holding Alt when asked), then waits for the renders.
async function plusClick(page, text, opts) {
  const o = opts || {};
  const sel = await blockByText(page, text);
  await page.hover(sel); await wait(150);
  const box = await page.locator(sel + ' > .ed-insert').boundingBox();
  assert.ok(box, 'plusClick: no ＋ on ' + JSON.stringify(text));
  if (o.alt) await page.keyboard.down('Alt');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  if (o.alt) await page.keyboard.up('Alt');
  await renderIdle(page);
}
// Answers a file chooser with the 1px PNG and waits for its upload and the
// render that follows (R41: renderIdle alone does not wait for /api/asset).
async function pickImage(page, chooser, base64) {
  await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/asset'),
    chooser.setFiles({ name: 'dot.png', mimeType: 'image/png', buffer: Buffer.from(base64 || PNG_1PX, 'base64') }),
  ]);
  await renderIdle(page);
}
check('plus: ＋ opens an empty paragraph below with the menu on it', DESKTOP, async (page) => {
  await plusClick(page, 'Alpha.');
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', '~paragraph:', 'paragraph:Omega.']);
  const m = await slashMenu(page);
  assert.deepStrictEqual([m.open, m.labels.length, m.cursor, m.inView], [true, 16, '文字', true]);
  assert.deepStrictEqual(await caretNow(page), { text: '', offset: 0, transient: true });
}, { md: BASE_MD });
check('plus: typing after ＋ filters, Enter inserts', DESKTOP, async (page, boot) => {
  await plusClick(page, 'Alpha.');
  await page.keyboard.type('h2');
  assert.deepStrictEqual((await slashMenu(page)).labels, ['標題 2']);
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('Sub');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n## Sub\n\nOmega.\n');
}, { md: BASE_MD });
check('plus: text that matches no block closes the menu and stays text', DESKTOP, async (page, boot) => {
  await plusClick(page, 'Alpha.');
  await page.keyboard.type('N');
  assert.deepStrictEqual((await slashMenu(page)).labels, ['編號列表'], '"N" still matches (number)');
  await page.keyboard.type('ew.');
  assert.strictEqual((await slashMenu(page)).open, false, 'nothing matches "Ne": plain text, no empty panel');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\nNew.\n\nOmega.\n');
}, { md: BASE_MD });
check('plus: Alt+＋ inserts above', DESKTOP, async (page) => {
  await plusClick(page, 'Omega.', { alt: true });
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', '~paragraph:', 'paragraph:Omega.']);
  assert.strictEqual((await slashMenu(page)).open, true);
  assert.deepStrictEqual(await caretNow(page), { text: '', offset: 0, transient: true });
}, { md: BASE_MD });
check('plus: Esc closes the menu and leaving the empty paragraph writes nothing', DESKTOP, async (page, boot) => {
  await plusClick(page, 'Alpha.');
  await page.keyboard.press('Escape');
  assert.strictEqual((await slashMenu(page)).open, false);
  assert.deepStrictEqual(await caretNow(page), { text: '', offset: 0, transient: true }, 'Esc keeps the paragraph and the caret');
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', 'paragraph:Omega.']);
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD);
}, { md: BASE_MD });
check('plus: toolbar 在下方插入 / 在上方插入 open the menu too', DESKTOP, async (page) => {
  await focusSurface(page, 'Alpha.', 3);
  await tb(page, 'insert-after');
  assert.deepStrictEqual([(await slashMenu(page)).open, await transientCount(page)], [true, 1]);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', '~paragraph:', 'paragraph:Omega.']);
  await page.keyboard.press('Escape');
  await focusSurface(page, 'Omega.', 3);
  await tb(page, 'insert-before');
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', '~paragraph:', 'paragraph:Omega.']);
  assert.strictEqual((await slashMenu(page)).open, true);
}, { md: BASE_MD });
check('plus: the pill menu is gone', DESKTOP, async (page) => {
  await plusClick(page, 'Alpha.');
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.ed-insert-menu, .ed-insert-menu-btn').length), 0);
  assert.strictEqual((await slashMenu(page)).open, true, 'the "/" menu is what ＋ opens');
}, { md: BASE_MD });
check('plus: 圖片 from the menu replaces the empty paragraph with the picked image', DESKTOP, async (page, boot) => {
  await plusClick(page, 'Alpha.');
  // Armed before the keys, not in a Promise.all with the Enter. Measured
  // (Chromium): armed alongside the Enter, the event never came when this
  // check ran after the other plus: checks in one browser, yet came every
  // time alone; armed here it comes in both. Likely Playwright turning
  // interception on asynchronously while a bare keypress, unlike page.click,
  // has no actionability wait in front of it.
  const chooserP = page.waitForEvent('filechooser');
  await page.keyboard.type('圖片');
  assert.deepStrictEqual((await slashMenu(page)).labels, ['圖片']);
  await page.keyboard.press('Enter');
  const chooser = await chooserP;
  await pickImage(page, chooser);
  assert.strictEqual(await transientCount(page), 0);
  assert.ok(/^# D\n\nAlpha\.\n\n!\[\]\(assets\/dot(-\d+)?\.png\)\n\nOmega\.\n$/.test(await saveAndRead(page, boot)));
}, { md: BASE_MD });
check('plus: on an empty paragraph 引用 / 編號 / 核取 are enabled and insert their block', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  const dis = await page.evaluate(() => ['quote', 'ordered-list', 'check', 'indent', 'outdent'].map((id) => document.querySelector('[data-ed-tb="' + id + '"]').disabled));
  assert.deepStrictEqual(dis, [false, false, false, true, true]);
  await tb(page, 'check'); await page.keyboard.type('todo');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n- [ ] todo\n\nOmega.\n');
}, { md: BASE_MD });

// ── B1 fix round 1 (review I1–I5, rulings R41–R43) ──
// A real (non-transient) paragraph emptied down to `typed` — the D8 branch
// where the paragraph itself becomes the item.
async function emptyAlphaTo(page, typed) {
  await focusSurface(page, 'Alpha.', 6);
  for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type(typed);
}
const errorCardUp = (page) => page.evaluate(() => !!document.querySelector('.ed-conflict[data-level="error"]'));
check('failed-render: a real paragraph emptied to "/h2" whose render fails keeps the keys typed after it, after it', DESKTOP, async (page, boot) => {
  await emptyAlphaTo(page, '/h2');
  await failFirstRender(page);
  await page.keyboard.press('Enter'); await page.keyboard.type('Sub');
  await wait(1500); await renderIdle(page);
  assert.strictEqual(await errorCardUp(page), true, 'the failure is shown');
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:/h2Sub', 'paragraph:Omega.'], 'the screen keeps what was typed, in order');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n/h2Sub\n\nOmega.\n', 'screen = file, nothing typed inside Alpha.');
}, { md: BASE_MD });
check('slash: a real paragraph emptied to "/h2" becomes the heading, one undo step', DESKTOP, async (page, boot) => {
  await emptyAlphaTo(page, '/h2');
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'heading:', 'paragraph:Omega.']);
  await page.keyboard.type('T');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n## T\n\nOmega.\n');
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n##\n\nOmega.\n', 'the typing is its own step');
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD, 'the paragraph -> heading is one step back to the original text');
}, { md: BASE_MD });
check('slash: a real paragraph emptied to "/圖片" becomes the picked image', DESKTOP, async (page, boot) => {
  const chooserP = page.waitForEvent('filechooser');
  await emptyAlphaTo(page, '/圖片');
  assert.deepStrictEqual((await slashMenu(page)).labels, ['圖片']);
  await page.keyboard.press('Enter');
  const chooser = await chooserP;
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:/圖片', 'paragraph:Omega.'], 'nothing changes while the picker is open');
  await pickImage(page, chooser);
  assert.strictEqual(await errorCardUp(page), false);
  assert.ok(/^# D\n\n!\[\]\(assets\/dot(-\d+)?\.png\)\n\nOmega\.\n$/.test(await saveAndRead(page, boot)), 'the paragraph became the image');
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD, 'one undo step back to the original paragraph');
}, { md: BASE_MD });
check('slash: a mouse pick of 文字 in a real paragraph does what Enter does', DESKTOP, async (page) => {
  await emptyAlphaTo(page, '/');
  await slashPick(page, '文字');
  assert.strictEqual((await slashMenu(page)).open, false);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:', 'paragraph:Omega.']);
  assert.deepStrictEqual(await caretNow(page), { text: '', offset: 0, transient: false }, 'the caret stays in the paragraph');
}, { md: BASE_MD });
check('slash: Enter on 文字 in a real paragraph keeps it, caret in it (control for the mouse pick)', DESKTOP, async (page) => {
  await emptyAlphaTo(page, '/');
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:', 'paragraph:Omega.']);
  assert.deepStrictEqual(await caretNow(page), { text: '', offset: 0, transient: false });
}, { md: BASE_MD });
check('plus: 文字 keeps what was typed after ＋ (R41)', DESKTOP, async (page, boot) => {
  await plusClick(page, 'Alpha.');
  await page.keyboard.type('Text');
  assert.deepStrictEqual((await slashMenu(page)).labels, ['文字']);
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.strictEqual((await slashMenu(page)).open, false);
  assert.deepStrictEqual(await caretNow(page), { text: 'Text', offset: 4, transient: true });
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\nText\n\nOmega.\n');
}, { md: BASE_MD });
// R42: an existing list's looseness never changes.
const TIGHT2_MD = '# D\n\n- alpha\n- bravo\n\nOmega.\n';
// Enter at the end of bravo, Enter on the empty item: a transient below the list.
async function transientBelowList(page) {
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'li:alpha', 'li:bravo', '~paragraph:', 'paragraph:Omega.'], 'a transient below the list');
}
const TIGHT_TODO = '# D\n\n- alpha\n- bravo\n- [ ] x\n\nOmega.\n';
const TIGHT_THEN_OL = '# D\n\n- alpha\n- bravo\n\n1. x\n\nOmega.\n';
check('list-keep: ＋ on a tight item then 待辦清單 continues the list tight', DESKTOP, async (page, boot) => {
  await plusClick(page, 'bravo');
  await page.keyboard.type('todo'); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('x');
  assert.strictEqual(await commitAndRead(page, boot), TIGHT_TODO);
}, { md: TIGHT2_MD });
check('list-keep: ＋ on a tight item then 編號列表 starts its own list after a blank line', DESKTOP, async (page, boot) => {
  await plusClick(page, 'bravo');
  await page.keyboard.type('ordered'); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('x');
  assert.strictEqual(await commitAndRead(page, boot), TIGHT_THEN_OL);
}, { md: TIGHT2_MD });
check('list-keep: "/todo" in the paragraph an empty item\'s Enter left continues the list tight', DESKTOP, async (page, boot) => {
  await transientBelowList(page);
  await page.keyboard.type('/todo'); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('x');
  assert.strictEqual(await commitAndRead(page, boot), TIGHT_TODO);
}, { md: TIGHT2_MD });
check('list-keep: "/bullet" there continues the list tight', DESKTOP, async (page, boot) => {
  await transientBelowList(page);
  await page.keyboard.type('/bullet'); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('x');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- x\n\nOmega.\n');
}, { md: TIGHT2_MD });
check('list-keep: "/ordered" there starts its own list after a blank line', DESKTOP, async (page, boot) => {
  await transientBelowList(page);
  await page.keyboard.type('/ordered'); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('x');
  assert.strictEqual(await commitAndRead(page, boot), TIGHT_THEN_OL);
}, { md: TIGHT2_MD });
check('list-keep: toolbar 核取 on that paragraph continues the list tight', DESKTOP, async (page, boot) => {
  await transientBelowList(page);
  await tb(page, 'check'); await page.keyboard.type('x');
  assert.strictEqual(await commitAndRead(page, boot), TIGHT_TODO);
}, { md: TIGHT2_MD });
check('list-keep: toolbar 編號 on that paragraph starts its own list after a blank line', DESKTOP, async (page, boot) => {
  await transientBelowList(page);
  await tb(page, 'ordered-list'); await page.keyboard.type('x');
  assert.strictEqual(await commitAndRead(page, boot), TIGHT_THEN_OL);
}, { md: TIGHT2_MD });
check('list-keep: 待辦清單 from ＋ on a nested item lands at that item\'s depth, after its subtree', DESKTOP, async (page, boot) => {
  await plusClick(page, 'child');
  await page.keyboard.type('todo'); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('x');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n  - child\n    - grand\n  - [ ] x\n- bravo\n\nOmega.\n');
}, { md: '# D\n\n- alpha\n  - child\n    - grand\n- bravo\n\nOmega.\n' });
check('list-keep: an untouched 待辦清單 from ＋ is removed again when left', DESKTOP, async (page, boot) => {
  await plusClick(page, 'bravo');
  await page.keyboard.type('todo'); await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'li:alpha', 'li:bravo', 'li:', 'paragraph:Omega.']);
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), TIGHT2_MD);
}, { md: TIGHT2_MD });
check('list-keep: under an ordered list, 編號列表 continues it tight', DESKTOP, async (page, boot) => {
  await plusClick(page, 'bravo');
  await page.keyboard.type('ordered'); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('x');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n1. alpha\n2. bravo\n3. x\n\nOmega.\n');
}, { md: '# D\n\n1. alpha\n2. bravo\n\nOmega.\n' });
check('slash: with no match ↑↓ move the caret', DESKTOP, async (page) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('/zz');
  assert.strictEqual((await slashMenu(page)).empty, '沒有符合的區塊');
  await page.keyboard.press('ArrowUp'); await renderIdle(page);
  assert.strictEqual((await slashMenu(page)).open, false);
  assert.strictEqual(((await caretNow(page)) || {}).text, 'Alpha.', 'the caret went up a line');
}, { md: BASE_MD });
check('slash: Shift+Enter closes the menu and breaks the line', DESKTOP, async (page) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('/');
  await page.keyboard.press('Shift+Enter'); await renderIdle(page);
  assert.strictEqual((await slashMenu(page)).open, false);
  assert.strictEqual(await page.evaluate(() => document.activeElement.innerHTML.indexOf('<br') !== -1), true, 'a soft break went in');
}, { md: BASE_MD });
check('slash: with text before it, one undo removes the block and a second the paragraph\'s own edit', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.type(' x /math');
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha. x\n\n$$\nx^2\n$$\n\nOmega.\n');
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha. x\n\nOmega.\n');
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD);
}, { md: BASE_MD });

// ── B1 fix round 2 (R47, R48) ──
check('list-keep: 待辦清單 under a nested ordered item starts its own list at that depth, tight (R47)', DESKTOP, async (page, boot) => {
  await plusClick(page, 'child');
  await page.keyboard.type('todo'); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('x');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n  1. child\n  - [ ] x\n- bravo\n\nOmega.\n');
}, { md: '# D\n\n- alpha\n  1. child\n- bravo\n\nOmega.\n' });
check('list-keep: 編號列表 under a nested bullet item starts its own list at that depth, tight (R47)', DESKTOP, async (page, boot) => {
  await plusClick(page, 'child');
  await page.keyboard.type('ordered'); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('x');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n1. alpha\n   - child\n   1. x\n2. bravo\n\nOmega.\n');
}, { md: '# D\n\n1. alpha\n   - child\n2. bravo\n\nOmega.\n' });
// R48: keys typed straight after Enter, while the continuation renders, land
// in the new item.
for (const [q, md, want] of [
  ['todo', '# D\n\n- alpha\n- bravo\n\nOmega.\n', '# D\n\n- alpha\n- bravo\n- [ ] xy\n\nOmega.\n'],
  ['ordered', '# D\n\n1. alpha\n2. bravo\n\nOmega.\n', '# D\n\n1. alpha\n2. bravo\n3. xy\n\nOmega.\n'],
  ['bullet', '# D\n\n- alpha\n- bravo\n\nOmega.\n', '# D\n\n- alpha\n- bravo\n- xy\n\nOmega.\n'],
]) {
  check('list-keep: keys typed while "' + q + '" continues a list land in the new item (R48)', DESKTOP, async (page, boot) => {
    await delayRender(page, 800);
    await plusClick(page, 'bravo');
    await page.keyboard.type(q); await page.keyboard.press('Enter'); await page.keyboard.type('xy');
    await renderIdle(page);
    assert.strictEqual(await noticeText(page), null, 'nothing dropped');
    assert.strictEqual(await commitAndRead(page, boot), want);
  }, { md });
}
// ＋ on a MIDDLE item: the transient sits inside the run while it renders.
// The insert's own commit renumbers the items after it (saved before any
// typing: a later edit of the item re-serializes the run and would hide it).
check('list-keep: 編號列表 from ＋ on a middle item renumbers the items after it in its own commit', DESKTOP, async (page, boot) => {
  await plusClick(page, 'alpha');
  await page.keyboard.type('ordered'); await page.keyboard.press('Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n1. alpha\n2.\n3. bravo\n\nOmega.\n');
}, { md: '# D\n\n1. alpha\n2. bravo\n\nOmega.\n' });
check('list-keep: 編號列表 from ＋ on a middle item, keys typed meanwhile land in it (R48)', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await plusClick(page, 'alpha');
  await page.keyboard.type('ordered'); await page.keyboard.press('Enter'); await page.keyboard.type('xy');
  await renderIdle(page);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n1. alpha\n2. xy\n3. bravo\n\nOmega.\n');
}, { md: '# D\n\n1. alpha\n2. bravo\n\nOmega.\n' });
check('list-keep: 項目符號列表 from ＋ on a middle item, keys typed meanwhile land in it (R48)', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await plusClick(page, 'alpha');
  await page.keyboard.type('bullet'); await page.keyboard.press('Enter'); await page.keyboard.type('xy');
  await renderIdle(page);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- xy\n- bravo\n\nOmega.\n');
}, { md: '# D\n\n- alpha\n- bravo\n\nOmega.\n' });
check('failed-render: ＋ 待辦清單 under a list item keeps the paragraph and its text (R48)', DESKTOP, async (page, boot) => {
  await plusClick(page, 'bravo');
  await page.keyboard.type('todo');
  await failFirstRender(page);
  await page.keyboard.press('Enter'); await page.keyboard.type('x');
  await wait(1500); await renderIdle(page);
  assert.strictEqual(await errorCardUp(page), true, 'the failure is shown');
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'li:alpha', 'li:bravo', '~paragraph:todox', 'paragraph:Omega.'], 'the paragraph and what was typed stay');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n\ntodox\n\nOmega.\n', 'screen = file');
}, { md: '# D\n\n- alpha\n- bravo\n\nOmega.\n' });

// ── B1 fix round 3 (R51) ──
// A run-re-serializing insert (編號列表 / 項目符號列表 continuing the list)
// whose render fails drops its provisional item: only the paragraph and its
// text stay, where ＋ put it, and leaving it writes that paragraph between the
// items. Measured before: on a middle item the retry wrote the run up to the
// paragraph over the whole run, and the item below was gone from the file.
for (const [label, q, n1, n2] of [
  ['編號列表', 'ordered', '1. ', '2. '],
  ['項目符號列表', 'bullet', '- ', '- '],
]) {
  const md = '# D\n\n' + n1 + 'alpha\n' + n2 + 'bravo\n\nOmega.\n';
  check('failed-render: ＋ ' + label + ' on a middle item keeps every item (R51)', DESKTOP, async (page, boot) => {
    await plusClick(page, 'alpha');
    await page.keyboard.type(q);
    await failFirstRender(page);
    await page.keyboard.press('Enter'); await page.keyboard.type('x');
    await wait(1500); await renderIdle(page);
    assert.strictEqual(await errorCardUp(page), true, 'the failure is shown');
    assert.deepStrictEqual(await blockList(page), ['heading:D', 'li:alpha', '~paragraph:' + q + 'x', 'li:bravo', 'paragraph:Omega.'],
      'no provisional item: the paragraph and its text, between the items');
    assert.strictEqual(await commitAndRead(page, boot), '# D\n\n' + n1 + 'alpha\n\n' + q + 'x\n\n' + n2 + 'bravo\n\nOmega.\n', 'every item kept');
    assert.deepStrictEqual(await blockList(page), ['heading:D', 'li:alpha', 'paragraph:' + q + 'x', 'li:bravo', 'paragraph:Omega.'], 'screen = file');
  }, { md });
  check('failed-render: ＋ ' + label + ' on the last item keeps screen = file (R51)', DESKTOP, async (page, boot) => {
    await plusClick(page, 'bravo');
    await page.keyboard.type(q);
    await failFirstRender(page);
    await page.keyboard.press('Enter'); await page.keyboard.type('x');
    await wait(1500); await renderIdle(page);
    assert.strictEqual(await errorCardUp(page), true, 'the failure is shown');
    assert.deepStrictEqual(await blockList(page), ['heading:D', 'li:alpha', 'li:bravo', '~paragraph:' + q + 'x', 'paragraph:Omega.'],
      'no provisional item: the paragraph and its text, below the list');
    assert.strictEqual(await commitAndRead(page, boot), '# D\n\n' + n1 + 'alpha\n' + n2 + 'bravo\n\n' + q + 'x\n\nOmega.\n', 'the screen\'s order');
    assert.deepStrictEqual(await blockList(page), ['heading:D', 'li:alpha', 'li:bravo', 'paragraph:' + q + 'x', 'paragraph:Omega.'], 'screen = file');
  }, { md });
}

// ── shortcut (v3.15.0 T3): a Markdown marker typed at the start of a
// paragraph converts it (spec §3.3, D1–D5) ──
for (const [typed, file, kind] of [
  ['# ', '# D\n\nAlpha.\n\n# T\n\nOmega.\n', 'heading'], ['### ', '# D\n\nAlpha.\n\n### T\n\nOmega.\n', 'heading'],
  ['- ', '# D\n\nAlpha.\n\n- T\n\nOmega.\n', 'li'], ['* ', '# D\n\nAlpha.\n\n- T\n\nOmega.\n', 'li'],
  ['1. ', '# D\n\nAlpha.\n\n1. T\n\nOmega.\n', 'li'], ['[] ', '# D\n\nAlpha.\n\n- [ ] T\n\nOmega.\n', 'li'], ['[ ] ', '# D\n\nAlpha.\n\n- [ ] T\n\nOmega.\n', 'li'],
]) {
  check('shortcut: "' + typed + '" in a new paragraph converts, and typing goes into the block', DESKTOP, async (page, boot) => {
    await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
    await page.keyboard.type(typed); await renderIdle(page);
    assert.strictEqual((await caretNow(page)).offset, 0);
    await page.keyboard.type('T');
    assert.strictEqual(await page.evaluate(() => document.activeElement.closest('.ed-block').getAttribute('data-block-type')), kind);
    assert.strictEqual(await commitAndRead(page, boot), file);
  }, { md: BASE_MD });
}
// D3 keeps the typed start number in the conversion. (Typing into the item
// afterwards renumbers it to 1: the list re-serializer discards a list's start
// number, §3.8 — measured the same at 2fb4ac3 on '3. alpha' + a typed key,
// before this task. Not changed here.)
check('shortcut: "3. " keeps its start number in the conversion', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('3. '); await renderIdle(page);
  assert.strictEqual(await page.evaluate(() => document.activeElement.closest('.ed-block').getAttribute('data-block-type')), 'li');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n3.\n\nOmega.\n');
}, { md: BASE_MD });
// R20: the literal is serialized like any paragraph — `\##`, its trailing
// space dropped — so the screen shows `##` with the caret after it.
check('shortcut: Ctrl+Z right after shows the literal, caret after it, and it stays literal', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('## '); await renderIdle(page);
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.deepStrictEqual(await caretNow(page), { text: '##', offset: 2, transient: false });
  await page.keyboard.type('x');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n##x\n\nOmega.\n');
}, { md: BASE_MD });
check('shortcut: after Ctrl+Z the paragraph does not convert again while the caret stays in it (R20)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('## '); await renderIdle(page);
  await page.keyboard.press('Control+z'); await renderIdle(page);
  await page.keyboard.type(' x'); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', 'paragraph:## x', 'paragraph:Omega.']);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n\\## x\n\nOmega.\n');
}, { md: BASE_MD });
check('shortcut: at the start of an existing paragraph the text after the caret becomes the heading', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Omega.', 0); await page.keyboard.type('## '); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n## Omega.\n');
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n\\## Omega.\n');
}, { md: BASE_MD });
// v3.17.0 T2 (R21): ``` opens the in-place code edit on the empty body (the
// language is the chip's, no longer typed on the fence line); Enter is a
// newline in the body, and Ctrl+Enter commits (D3).
check('shortcut: "```" opens the code edit in place with the caret on the empty body', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('```'); await renderIdle(page);
  assert.deepStrictEqual({ edit: await codeEdit(page), raw: await rawBox(page) },
    { edit: { text: '', caret: 0, focused: true }, raw: null });
  await page.keyboard.type('x = 1'); await page.keyboard.press('Enter'); await page.keyboard.type('y');
  assert.deepStrictEqual(await codeEdit(page), { text: 'x = 1\ny', caret: 7, focused: true });
  await page.keyboard.press('Control+Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n```\nx = 1\ny\n```\n\nOmega.\n');
}, { md: BASE_MD });
check('shortcut: "---" writes a divider and opens a paragraph below it', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('---'); await renderIdle(page);
  await page.keyboard.type('After');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n---\n\nAfter\n\nOmega.\n');
}, { md: BASE_MD });
check('shortcut: "> " opens the quote box with the caret after "> "', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('> '); await renderIdle(page);
  const r = await page.evaluate(() => { const t = document.querySelector('textarea.ed-raw'); return t && { v: t.value, s: t.selectionStart }; });
  assert.deepStrictEqual(r, { v: '> ', s: 2 });
  await page.keyboard.type('Q'); await page.keyboard.press('Control+Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n> Q\n\nOmega.\n');
}, { md: BASE_MD });
// Guard (green before T3): a marker that is not the whole text before the
// caret, or one typed into a list item, a heading or a table cell, is text.
check('shortcut: mid-paragraph nothing converts', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.type(' ## x');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha. ## x\n\nOmega.\n');
}, { md: BASE_MD });
const NOCONV_MD = '# D\n\n## Head\n\n- alpha\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
check('shortcut: in a list item, a heading and a table cell nothing converts', DESKTOP, async (page, boot) => {
  const leave = async () => { await page.locator('.ed-block[data-block-type="heading"]').first().click(); await renderIdle(page); };
  await focusSurface(page, 'alpha', 0); await page.keyboard.type('## '); await leave();
  await focusSurface(page, 'Head', 0); await page.keyboard.type('- '); await leave();
  await focusSurface(page, '1', 0); await page.keyboard.type('> '); await leave();
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'heading:- Head', 'li:## alpha', 'table:ab\n> 12']);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n## - Head\n\n- \\## alpha\n\n| a | b |\n|---|---|\n| > 1 | 2 |\n');
}, { md: NOCONV_MD });
check('shortcut: typing straight on after "## " on a slow render lands in the heading', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await delayRender(page, 800);
  await page.keyboard.type('## Title');
  await renderIdle(page);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n## Title\n\nOmega.\n');
}, { md: BASE_MD });
check('shortcut: typing straight on after "- " on a slow render lands in the item', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await delayRender(page, 800);
  await page.keyboard.type('- item');
  await renderIdle(page);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n- item\n\nOmega.\n');
}, { md: BASE_MD });
// R15 / R17: "## T" is held while the Enter renders and replayed one
// character at a time; the replayed space starts the shortcut's commit and
// the "T" after it waits for that render, then lands in the heading.
check('shortcut: "## T" typed during an Enter\'s slow render still converts', DESKTOP, async (page, boot) => {
  await delayRender(page, 800);
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.type(' x'); await page.keyboard.press('Enter');
  await page.keyboard.type('## T');
  await renderIdle(page);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha. x\n\n## T\n\nOmega.\n');
}, { md: BASE_MD });
check('failed-render: a shortcut whose render fails keeps the literal and the keys after it', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await failFirstRender(page);
  // The failing render's request can reach node after renderIdle() looked
  // (measured once in a full run: the card was not up yet), so the 800 ms the
  // route holds it is waited out first, as the R51 checks below do.
  await page.keyboard.type('## Ti'); await wait(1500); await renderIdle(page);
  assert.strictEqual(await errorCardUp(page), true, 'the conversion was tried and its render failed');
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', '~paragraph:## Ti', 'paragraph:Omega.']);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n\\## Ti\n\nOmega.\n');
}, { md: BASE_MD });
check('failed-render: a shortcut at the start of a real paragraph whose render fails keeps it as typed', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Omega.', 0);
  await failFirstRender(page);
  // The failing render's request can reach node after renderIdle() looked
  // (measured once in a full run: the card was not up yet), so the 800 ms the
  // route holds it is waited out first, as the R51 checks below do.
  await page.keyboard.type('## Ti'); await wait(1500); await renderIdle(page);
  assert.strictEqual(await errorCardUp(page), true, 'the conversion was tried and its render failed');
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', 'paragraph:## TiOmega.']);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n\\## TiOmega.\n');
}, { md: BASE_MD });
// R46 (carries R42): below a tight list the shortcut gives the same answer as
// the "/" menu — a bullet or a to-do continues the list tight, an ordered
// item starts its own list after a blank line.
check('shortcut: "- " on a paragraph below a tight list continues it tight', DESKTOP, async (page, boot) => {
  await transientBelowList(page);
  await page.keyboard.type('- x');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- x\n\nOmega.\n');
}, { md: TIGHT2_MD });
check('shortcut: "[] " on a paragraph below a tight list continues it tight', DESKTOP, async (page, boot) => {
  await transientBelowList(page);
  await page.keyboard.type('[] x');
  assert.strictEqual(await commitAndRead(page, boot), TIGHT_TODO);
}, { md: TIGHT2_MD });
check('shortcut: "1. " on a paragraph below a tight list starts its own list after a blank line', DESKTOP, async (page, boot) => {
  await transientBelowList(page);
  await page.keyboard.type('1. x');
  assert.strictEqual(await commitAndRead(page, boot), TIGHT_THEN_OL);
}, { md: TIGHT2_MD });
// R44: the run re-serializer writes an empty to-do item as `- [ ] ` (with
// its space), so it reads back as a to-do and the next key lands in it.
check('shortcut: Enter at the end of a to-do item then typing keeps it a to-do (R44)', DESKTOP, async (page, boot) => {
  await liText(page, 'alpha').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('x');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- [ ] alpha\n- [ ] x\n\nOmega.\n');
}, { md: '# D\n\n- [ ] alpha\n\nOmega.\n' });

// ── diagram-lib (v3.15.0 T4, D12): a document that had no diagram of a kind
// at load gets that engine on demand the first time one is inserted. The
// three items insert rendered, with no raw box (R23), so there is no Escape.
check('diagram-lib: a Mermaid block inserted into a document without one renders', DESKTOP, async (page) => {
  assert.strictEqual(await page.evaluate(() => typeof window.mermaid), 'undefined', 'guard: not loaded at start');
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('/mer'); await page.keyboard.press('Enter'); await renderIdle(page);
  await wait(1500);
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.mermaid svg').length), 1);
}, { md: BASE_MD });
check('diagram-lib: a WaveDrom block inserted into a document without one renders', DESKTOP, async (page) => {
  assert.strictEqual(await page.evaluate(() => typeof window.WaveDrom), 'undefined', 'guard: not loaded at start');
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('/wave'); await page.keyboard.press('Enter'); await renderIdle(page);
  await wait(1500);
  assert.strictEqual(await page.evaluate(() =>
    document.querySelectorAll('.content [id^="WaveDrom_Display_"] svg, .content .wavedrom-diagram svg').length), 1);
}, { md: BASE_MD });
check('diagram-lib: a math block inserted into a document without one is styled', DESKTOP, async (page) => {
  assert.strictEqual(await page.evaluate(() => !!document.querySelector('style[data-md2doc-math]')), false, 'guard: no KaTeX css at start');
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('/公式'); await page.keyboard.press('Enter'); await renderIdle(page);
  await wait(1500);
  const ff = await page.evaluate(() => { const k = document.querySelector('.katex'); return k ? getComputedStyle(k).fontFamily : null; });
  assert.ok(ff && ff.indexOf('KaTeX') !== -1, 'font-family ' + JSON.stringify(ff));
}, { md: BASE_MD });
check('diagram-lib: a second Mermaid block loads nothing again and renders too', DESKTOP, async (page) => {
  const libLoads = [];
  page.on('request', (r) => { if (/\/api\/lib\//.test(r.url())) libLoads.push(new URL(r.url()).pathname); });
  for (let i = 0; i < 2; i++) {
    await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
    await page.keyboard.type('/mer'); await page.keyboard.press('Enter'); await renderIdle(page);
    await wait(1500);
  }
  assert.deepStrictEqual(libLoads, ['/api/lib/mermaid.js']);
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.mermaid svg').length), 2);
}, { md: BASE_MD });

// ── B2 fix round 1 (R56–R61) ──
const newParaBelowAlpha = async (page) => { await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page); };
// R58: a list marker next to a list of the same family joins it tight — above
// or below, a real paragraph or a transient, with text or without.
check('shortcut: "- " at the start of a paragraph below a tight list joins it tight (R58)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Omega.', 0); await page.keyboard.type('- '); await renderIdle(page);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- Omega.\n');
}, { md: TIGHT2_MD });
check('shortcut: "- " at the start of a paragraph above a tight list joins it as its first item (R58)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 0); await page.keyboard.type('- '); await renderIdle(page);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- Alpha.\n- a\n- b\n');
}, { md: '# D\n\nAlpha.\n\n- a\n- b\n' });
check('shortcut: "- x" in a paragraph inserted above a tight list joins it as its first item (R58)', DESKTOP, async (page, boot) => {
  await liText(page, 'alpha').click(); await renderIdle(page);
  await tb(page, 'insert-before');
  assert.deepStrictEqual(await blockList(page), ['heading:D', '~paragraph:', 'li:alpha', 'li:bravo', 'paragraph:Omega.']);
  await page.keyboard.type('- x'); await renderIdle(page);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- x\n- alpha\n- bravo\n\nOmega.\n');
}, { md: TIGHT2_MD });
check('shortcut: "- " before text in a paragraph below a tight list joins it tight (R58)', DESKTOP, async (page, boot) => {
  await transientBelowList(page);
  await page.keyboard.type('x'); await page.keyboard.press('Home'); await page.keyboard.type('- '); await renderIdle(page);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- x\n\nOmega.\n');
}, { md: TIGHT2_MD });
// MIGRATED by B2 fix round 1b (R62 supersedes R58's both-sides clause):
// `…joins the one above and keeps the blank line to the one below` ->
// `…joins both tight`. Once the paragraph between them is an item, markdown
// cannot keep the two lists apart; a kept blank line made them one LOOSE list
// (R42). Now one tight list, and the screen reads exactly the file.
check('shortcut: "- " between two tight lists joins both tight (R62)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Mid.', 0); await page.keyboard.type('- '); await renderIdle(page);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- a\n- b\n- Mid.\n- c\n- d\n');
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'li:a', 'li:b', 'li:Mid.', 'li:c', 'li:d'], 'screen = file');
}, { md: '# D\n\n- a\n- b\n\nMid.\n\n- c\n- d\n' });
check('slash: "/bullet" in an emptied paragraph between two tight lists joins both tight (R62)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Z', 1); await page.keyboard.press('Backspace');
  await page.keyboard.type('/bullet'); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('x');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- a\n- x\n- c\n');
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'li:a', 'li:x', 'li:c'], 'screen = file');
}, { md: '# D\n\n- a\n\nZ\n\n- c\n' });
check('shortcut: "1. " below a tight ordered list continues its numbering (R58)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Omega.', 0); await page.keyboard.type('1. '); await renderIdle(page);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n1. alpha\n2. bravo\n3. Omega.\n');
}, { md: '# D\n\n1. alpha\n2. bravo\n\nOmega.\n' });
check('slash: "/bullet" in an emptied paragraph below a tight list joins it tight (R58)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Z', 1); await page.keyboard.press('Backspace');
  await page.keyboard.type('/bullet'); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('x');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- x\n\nOmega.\n');
}, { md: '# D\n\n- alpha\n- bravo\n\nZ\n\nOmega.\n' });
// R57: a bullet continues only a bullet (or to-do) list, a number only an
// ordered one; the other family starts its own list.
const OL2_MD = '# D\n\n1. alpha\n2. bravo\n\nOmega.\n';
async function transientBelowOl(page) {
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'li:alpha', 'li:bravo', '~paragraph:', 'paragraph:Omega.'], 'a transient below the list');
}
check('shortcut: "- " below a tight ordered list starts its own list after a blank line (R57)', DESKTOP, async (page, boot) => {
  await transientBelowOl(page);
  await page.keyboard.type('- x');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n1. alpha\n2. bravo\n\n- x\n\nOmega.\n');
}, { md: OL2_MD });
check('list-keep: "/bullet" below a tight ordered list starts its own list after a blank line (R57)', DESKTOP, async (page, boot) => {
  await transientBelowOl(page);
  await page.keyboard.type('/bullet'); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('x');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n1. alpha\n2. bravo\n\n- x\n\nOmega.\n');
}, { md: OL2_MD });
check('shortcut: "1. " below a tight ordered list continues it (R57)', DESKTOP, async (page, boot) => {
  await transientBelowOl(page);
  await page.keyboard.type('1. x');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n1. alpha\n2. bravo\n3. x\n\nOmega.\n');
}, { md: OL2_MD });
// R56: an empty to-do that is the last item of a nested list stays a to-do.
check('shortcut: Enter at the end of a nested last to-do then typing keeps it a to-do (R56)', DESKTOP, async (page, boot) => {
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('x');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n  - [ ] bravo\n  - [ ] x\n\nOmega.\n');
}, { md: '# D\n\n- alpha\n  - [ ] bravo\n\nOmega.\n' });
// R59: keys typed while the render that opens the raw box is out land in it.
// v3.17.0 T2 (R28): for ``` that is the in-place code edit, and everything
// typed after the marker is body text — "js" included.
check('shortcut: "```js", Enter, "x = 1" typed straight on during a slow render land in the code body (R59, R28)', DESKTOP, async (page, boot) => {
  await newParaBelowAlpha(page);
  await delayRender(page, 800);
  await page.keyboard.type('```js'); await page.keyboard.press('Enter'); await page.keyboard.type('x = 1');
  await renderIdle(page);
  assert.deepStrictEqual({ edit: await codeEdit(page), raw: await rawBox(page) },
    { edit: { text: 'js\nx = 1', caret: 8, focused: true }, raw: null });
  assert.strictEqual(await noticeText(page), null, 'nothing dropped');
  await page.keyboard.press('Control+Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n```\njs\nx = 1\n```\n\nOmega.\n');
}, { md: BASE_MD });
check('shortcut: "> quote" typed straight on during a slow render lands in the quote box (R59)', DESKTOP, async (page, boot) => {
  await newParaBelowAlpha(page);
  await delayRender(page, 800);
  await page.keyboard.type('> quote');
  await renderIdle(page);
  assert.deepStrictEqual(await rawBox(page), { value: '> quote', caret: 7, focused: true });
  assert.strictEqual(await noticeText(page), null, 'nothing dropped');
  await page.keyboard.press('Control+Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n> quote\n\nOmega.\n');
}, { md: BASE_MD });
// R60 / D1: per kind, one Ctrl+Z gives the escaped literal with the caret
// after it, a second the paragraph as it was. (A raw box, or since v3.17.0
// the in-place code edit, is left with Escape first.)
for (const [typed, literal, caret] of [
  ['## ', '\\##', { text: '##', offset: 2, transient: false }],
  ['- ', '\\-', { text: '-', offset: 1, transient: false }],
  ['[] ', '\\[\\]', { text: '[]', offset: 2, transient: false }],
  ['1. ', '1\\.', { text: '1.', offset: 2, transient: false }],
  ['```', '\\`\\`\\`', { text: '```', offset: 3, transient: false }],
  ['> ', '\\>', { text: '>', offset: 1, transient: false }],
  ['---', '\\---', { text: '---', offset: 3, transient: false }],
]) {
  check('shortcut: "' + typed + '" one Ctrl+Z gives the literal, a second the paragraph as it was (R60)', DESKTOP, async (page, boot) => {
    await newParaBelowAlpha(page);
    await page.keyboard.type(typed); await renderIdle(page);
    if (await rawBox(page) || await codeEdit(page)) { await page.keyboard.press('Escape'); await renderIdle(page); }
    await page.keyboard.press('Control+z'); await renderIdle(page);
    assert.deepStrictEqual(await caretNow(page), caret);
    assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n' + literal + '\n\nOmega.\n');
    await page.keyboard.press('Control+z'); await renderIdle(page);
    assert.strictEqual(await saveAndRead(page, boot), BASE_MD);
  }, { md: BASE_MD });
}
// R61: an IME composition never triggers a shortcut (D3). Chromium only: the
// composition is driven through CDP.
check('shortcut: a composed "## " does not convert', DESKTOP, async (page) => {
  await newParaBelowAlpha(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '##', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.imeSetComposition', { text: '## ', selectionStart: 3, selectionEnd: 3 });
  await cdp.send('Input.insertText', { text: '## ' });
  await wait(300); await renderIdle(page);
  const bl = await blockList(page);
  assert.deepStrictEqual(bl.map((b) => b.replace(/ /g, ' ')), ['heading:D', 'paragraph:Alpha.', '~paragraph:## ', 'paragraph:Omega.']);
}, { md: BASE_MD, engines: ['chromium'] });
// R61: failed renders for the raw-box kinds and a list item.
for (const [typed, shown, file] of [
  ['```js', '```js', '\\`\\`\\`js'],
  ['> quote', '> quote', '\\> quote'],
  ['- item', '- item', '\\- item'],
]) {
  check('failed-render: a "' + typed + '" shortcut whose render fails keeps the literal and the keys after it', DESKTOP, async (page, boot) => {
    await newParaBelowAlpha(page);
    await failFirstRender(page);
    await page.keyboard.type(typed); await wait(1500); await renderIdle(page);
    assert.strictEqual(await errorCardUp(page), true, 'the conversion was tried and its render failed');
    assert.strictEqual(await rawBox(page), null, 'no raw box');
    assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', '~paragraph:' + shown, 'paragraph:Omega.']);
    assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n' + file + '\n\nOmega.\n');
  }, { md: BASE_MD });
}

// R61: an engine that fails to load is asked for once per page, not once per
// render.
check('diagram-lib: an engine that fails to load is not asked for again on the next render', DESKTOP, async (page) => {
  const libLoads = [];
  await page.route('**/api/lib/mermaid.js', (route) => { libLoads.push('mermaid.js'); route.fulfill({ status: 404, body: '{}' }); });
  for (let i = 0; i < 2; i++) {
    await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
    await page.keyboard.type('/mer'); await page.keyboard.press('Enter'); await renderIdle(page);
    await wait(800);
  }
  assert.deepStrictEqual(libLoads, ['mermaid.js']);
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.mermaid').length), 2, 'both blocks are there, as their source');
}, { md: BASE_MD });

// ── B2 fix round 2 (R64, R66, R67) ──
// R64: decided by the FILE. Enter in the emptied paragraph between two lists
// commits its removal, which leaves ONE loose list (`- a\n\n- c`, R65). The
// transient it leaves sits inside that list, so every path inserts the item
// into it keeping its looseness — with or without text first.
const R64_MD = '# D\n\n- a\n\nZ\n\n- c\n';
const R64_WANT = '# D\n\n- a\n\n- x\n\n- c\n';
async function transientInLooseRun(page) {
  await focusSurface(page, 'Z', 1); await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'li:a', '~paragraph:', 'li:c'], 'a transient between the items');
}
check('list-keep: "/bullet" on the paragraph Enter left inside a loose list keeps it loose (R64)', DESKTOP, async (page, boot) => {
  await transientInLooseRun(page);
  await page.keyboard.type('/bullet'); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('x');
  assert.strictEqual(await commitAndRead(page, boot), R64_WANT);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'li:a', 'li:x', 'li:c'], 'screen = file');
}, { md: R64_MD });
check('shortcut: "- x" on the paragraph Enter left inside a loose list keeps it loose (R64)', DESKTOP, async (page, boot) => {
  await transientInLooseRun(page);
  await page.keyboard.type('- x');
  assert.strictEqual(await commitAndRead(page, boot), R64_WANT);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'li:a', 'li:x', 'li:c'], 'screen = file');
}, { md: R64_MD });
check('shortcut: "x", Home, "- " on the paragraph Enter left inside a loose list keeps it loose (R64)', DESKTOP, async (page, boot) => {
  await transientInLooseRun(page);
  await page.keyboard.type('x'); await page.keyboard.press('Home'); await page.keyboard.type('- '); await renderIdle(page);
  assert.strictEqual(await commitAndRead(page, boot), R64_WANT);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'li:a', 'li:x', 'li:c'], 'screen = file');
}, { md: R64_MD });
// Restored from B2 fix round 1b (it was dropped there as unreachable; it is
// the same file shape as the three above): 在上方插入 inside a loose list.
check('list-keep: "/bullet" in a paragraph inserted inside a loose list keeps it loose (R64)', DESKTOP, async (page, boot) => {
  await liText(page, 'c').click(); await renderIdle(page);
  await tb(page, 'insert-before');
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'li:a', '~paragraph:', 'li:c']);
  await page.keyboard.type('/bullet'); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('x');
  assert.strictEqual(await commitAndRead(page, boot), R64_WANT);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'li:a', 'li:x', 'li:c'], 'screen = file');
}, { md: '# D\n\n- a\n\n- c\n' });
// R66: a held key the raw box's drain does not take is never dropped
// silently.
check('shortcut: "> quote" then Escape held during a slow render: the box keeps the text and the notice says what was dropped (R66)', DESKTOP, async (page) => {
  await newParaBelowAlpha(page);
  await delayRender(page, 800);
  await page.keyboard.type('> quote'); await page.keyboard.press('Escape');
  await renderIdle(page);
  assert.deepStrictEqual(await rawBox(page), { value: '> quote', caret: 7, focused: true });
  assert.strictEqual(await noticeText(page), '重新整理期間打的字沒有地方放，已略過');
}, { md: BASE_MD });
// R67: the cross-type insert on a MIDDLE item splits the run (lossless).
check('list-keep: ＋ on a middle ordered item then 項目符號列表 splits the run around the bullet (R67)', DESKTOP, async (page, boot) => {
  await plusClick(page, 'alpha');
  await page.keyboard.type('bullet'); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('x');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n1. alpha\n\n- x\n\n2. bravo\n\nOmega.\n');
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'li:alpha', 'li:x', 'li:bravo', 'paragraph:Omega.'], 'screen = file');
}, { md: OL2_MD });

// ── B2 fix round 3 (R68): a held Escape / Ctrl+Enter is for the raw box's
// drain only; anywhere else it is dropped with the notice, never replayed ──
check('raw-box: a held Escape whose box never takes focus is dropped, and text typed in the clicked paragraph is saved (R68)', DESKTOP, async (page, boot) => {
  await newParaBelowAlpha(page);
  await delayRender(page, 800);
  await page.keyboard.type('> quote'); await page.keyboard.press('Escape');
  await page.locator('.ed-block', { hasText: 'Omega.' }).last().click();
  await page.keyboard.press('End'); await page.keyboard.type('Q');
  await renderIdle(page); await wait(500); await renderIdle(page);
  assert.strictEqual(await noticeText(page), '重新整理期間打的字沒有地方放，已略過');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n>\n\nOmega.Q\n');
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', 'blockquote:', 'paragraph:Omega.Q'], 'screen = file');
}, { md: BASE_MD });
for (const [typed, after, shown, file] of [
  ['> quote', 'zz', '> quotezz', '\\> quotezz'],
  ['```', '', '```', '\\`\\`\\`'],
]) {
  check('failed-render: a held Escape after "' + typed + '" keeps the literal (R68)', DESKTOP, async (page, boot) => {
    await newParaBelowAlpha(page);
    await failFirstRender(page);
    await page.keyboard.type(typed); await page.keyboard.press('Escape');
    if (after) await page.keyboard.type(after);
    await wait(1500); await renderIdle(page);
    // The held Escape is dropped, not replayed (the literal and the keys
    // after it stay). Its dropped-keys notice does not replace the failed
    // render's red card, which stays up as the record of the failure.
    assert.strictEqual(await errorCardUp(page), true, 'the conversion was tried and its render failed; the card stays');
    assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', '~paragraph:' + shown, 'paragraph:Omega.']);
    assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n' + file + '\n\nOmega.\n');
  }, { md: BASE_MD });
}


// ── link-field / link-paste (v3.15.0 T5) ──
const LINKS_MD = '# D\n\nPlain words here.\n\nSee [docs](https://a.example/) now.\n\n| A | B |\n|---|---|\n| alpha | bravo |\n';
// Where `.ed-seltb` is right now, remembered so linkField() can say whether the
// URL field opened over it.
const rememberSeltb = (page) => page.evaluate(() => {
  const t = document.querySelector('.ed-seltb');
  const r = t && t.isConnected ? t.getBoundingClientRect() : null;
  window.__seltbRect = r ? { top: r.top, left: r.left } : null;
});
const linkField = (page) => page.evaluate(() => {
  const b = document.querySelector('.ed-linkbar');
  if (!b || !b.isConnected) return { open: false, value: null, placeholder: null, overToolbar: false };
  const i = b.querySelector('input');
  const r = b.getBoundingClientRect();
  const w = window.__seltbRect;
  return { open: true, value: i.value, placeholder: i.placeholder,
    overToolbar: !!w && Math.abs(r.top - w.top) <= 2 && Math.abs(r.left - w.left) <= 2 };
});
check('link-field: the link button turns the selection toolbar into the URL field; Enter links', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'Plain words here.', 6, 11);
  await rememberSeltb(page);
  await page.click('.ed-seltb-link');
  const f = await linkField(page);
  assert.deepStrictEqual([f.open, f.value, f.placeholder, f.overToolbar], [true, '', '貼上或輸入網址', true]);
  assert.strictEqual(await page.evaluate(() => !!document.querySelector('.ed-seltb') && document.querySelector('.ed-seltb').isConnected), false, 'the selection toolbar is hidden under the field');
  await page.keyboard.type('example.com'); await page.keyboard.press('Enter');
  assert.strictEqual((await linkField(page)).open, false);
  assert.strictEqual(await commitAndRead(page, boot), LINKS_MD.replace('Plain words here.', 'Plain [words](https://example.com) here.'));
}, { md: LINKS_MD });
check('link-field: the 套用 button applies like Enter', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'Plain words here.', 6, 11);
  await page.keyboard.press('Control+k');
  await page.keyboard.type('apply.example/a b');
  await page.click('.ed-linkbar button');
  assert.strictEqual((await linkField(page)).open, false);
  assert.strictEqual(await commitAndRead(page, boot), LINKS_MD.replace('Plain words here.', 'Plain [words](https://apply.example/a%20b) here.'));
}, { md: LINKS_MD });
check('link-field: Ctrl+K opens it; Esc returns to the toolbar with the selection kept', DESKTOP, async (page) => {
  await selectInSurface(page, 'Plain words here.', 6, 11);
  await page.keyboard.press('Control+k');
  assert.strictEqual((await linkField(page)).open, true);
  await page.keyboard.press('Escape');
  const r = await page.evaluate(() => ({ sel: String(window.getSelection()), bar: !!document.querySelector('.ed-seltb') && document.querySelector('.ed-seltb').isConnected, focus: document.activeElement.className.indexOf('ed-wys-armed') !== -1 }));
  assert.deepStrictEqual([r.sel, r.bar, r.focus, (await linkField(page)).open], ['words', true, true, false]);
}, { md: LINKS_MD });
check('link-field: on an existing link it is pre-filled; emptied + Enter removes the link', DESKTOP, async (page, boot) => {
  // 5..8, not 4..8: selectInSurface puts an offset on a text-node boundary at
  // the END of the earlier node, so 4 would start outside the link (a partial
  // overlap, which unwraps). A real keyboard or double-click selection of
  // exactly "docs" starts inside the link and opens this same pre-filled field.
  await selectInSurface(page, 'See docs now.', 5, 8);
  await page.keyboard.press('Control+k');
  assert.strictEqual((await linkField(page)).value, 'https://a.example/');
  await page.keyboard.press('Control+a'); await page.keyboard.press('Backspace'); await page.keyboard.press('Enter');
  assert.strictEqual(await commitAndRead(page, boot), LINKS_MD.replace('[docs](https://a.example/)', 'docs'));
}, { md: LINKS_MD });
check('link-field: Ctrl+K on a caret inside a link edits the whole link', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'See docs now.', 6);
  await page.keyboard.press('Control+k');
  assert.deepStrictEqual([(await linkField(page)).value, await page.evaluate(() => document.activeElement.tagName)], ['https://a.example/', 'INPUT']);
  // Esc hands back the selection Ctrl+K made over the whole link text.
  await page.keyboard.press('Escape');
  assert.strictEqual(await page.evaluate(() => String(getSelection())), 'docs');
  await page.keyboard.press('Control+k');
  await page.keyboard.press('Control+a'); await page.keyboard.type('https://b.example/'); await page.keyboard.press('Enter');
  assert.strictEqual(await commitAndRead(page, boot), LINKS_MD.replace('https://a.example/', 'https://b.example/'));
}, { md: LINKS_MD });
check('link-field: Ctrl+K with a caret outside any link does nothing', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Plain words here.', 3);
  await page.keyboard.press('Control+k');
  assert.strictEqual((await linkField(page)).open, false);
  assert.strictEqual(await commitAndRead(page, boot), LINKS_MD);
}, { md: LINKS_MD });
check('link-field: an edited href lights the unsaved dot before the burst ends', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'See docs now.', 5, 8);
  await page.keyboard.press('Control+k');
  await page.keyboard.press('Control+a'); await page.keyboard.type('https://dot.example/'); await page.keyboard.press('Enter');
  await wait(200);
  assert.strictEqual(await page.evaluate(() => document.title.charAt(0)), '\u25cf', 'the title carries the unsaved dot');
  assert.strictEqual(await commitAndRead(page, boot), LINKS_MD.replace('https://a.example/', 'https://dot.example/'));
}, { md: LINKS_MD });
check('link-field: works in a table cell', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'bravo', 0, 5);
  await page.keyboard.press('Control+k');
  assert.strictEqual((await linkField(page)).open, true);
  await page.keyboard.type('https://c.example'); await page.keyboard.press('Enter');
  assert.strictEqual((await linkField(page)).open, false);
  assert.strictEqual(await commitAndRead(page, boot), LINKS_MD.replace('| bravo |', '| [bravo](https://c.example) |'));
}, { md: LINKS_MD });
check('link-field: Ctrl+Z in the field leaves the document alone', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Plain words here.', 17); await page.keyboard.type(' typed');
  await selectInSurface(page, 'Plain words here. typed', 6, 11);
  await page.keyboard.press('Control+k'); await page.keyboard.type('abc'); await page.keyboard.press('Control+z');
  const f = await linkField(page);
  assert.deepStrictEqual([f.open, f.value], [true, '']);
  await page.keyboard.press('Escape');
  assert.strictEqual(await commitAndRead(page, boot), LINKS_MD.replace('Plain words here.', 'Plain words here. typed'));
}, { md: LINKS_MD });
check('link-field: focusing the field commits nothing and leaves no render behind', DESKTOP, async (page) => {
  await selectInSurface(page, 'Plain words here.', 6, 11);
  await renderIdle(page);
  const before = renderTotal(page);
  await page.keyboard.press('Control+k'); await renderIdle(page);
  assert.strictEqual(renderTotal(page) - before, 0, 'no /api/render while the field opens');
  assert.strictEqual((await linkField(page)).open, true);
}, { md: LINKS_MD });
check('link-field: a click elsewhere closes it and the typed edit survives', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Plain words here.', 17); await page.keyboard.type('!');
  await selectInSurface(page, 'Plain words here.!', 6, 11);
  await page.keyboard.press('Control+k'); await page.keyboard.type('x.example');
  await page.locator('.content p', { hasText: 'See' }).click();
  await renderIdle(page);
  assert.strictEqual((await linkField(page)).open, false);
  assert.strictEqual(await commitAndRead(page, boot), LINKS_MD.replace('Plain words here.', 'Plain words here.!'));
}, { md: LINKS_MD });
// v3.17.0 T10 (M-c): a scroll moves the field with its selection and keeps
// its text; only the selection leaving the view closes it. Migrated from
// 'link-field: a scroll closes it' (old: closed on any scroll event; new:
// open, text kept, same offset to the selection).
async function tallPage(page) {
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.id = 'spacer-t10'; d.style.cssText = 'height:4000px;width:1px;';
    document.body.appendChild(d);
  });
}
const wordsBottom = (page) => page.evaluate(() => {
  const p = [...document.querySelectorAll('.ed-wys-armed')].find((e) => e.textContent === 'Plain words here.');
  const t = p.firstChild;
  const r = document.createRange(); r.setStart(t, 6); r.setEnd(t, 11);
  return r.getBoundingClientRect().bottom;
});
check('link-field: a scroll keeps it with its text and follows the selection (M-c)', DESKTOP, async (page) => {
  await tallPage(page);
  await selectInSurface(page, 'Plain words here.', 6, 11);
  await page.keyboard.press('Control+k');
  await page.keyboard.type('abc');
  const gap = async () => {
    const f = await page.evaluate(() => { const b = document.querySelector('.ed-linkbar'); return b && b.isConnected ? b.getBoundingClientRect().top : null; });
    return f === null ? null : Math.round((f - await wordsBottom(page)) * 10) / 10;
  };
  const before = await gap();
  assert.notStrictEqual(before, null, 'guard: the field is open');
  const y0 = await wordsBottom(page);
  await page.evaluate(() => window.scrollTo(0, 40)); await wait(150);
  const y1 = await wordsBottom(page);
  assert.ok(Math.abs((y0 - y1) - 40) <= 1, 'guard: the page really scrolled by 40: ' + (y0 - y1));
  const f = await linkField(page);
  const after = await gap();
  assert.deepStrictEqual({ open: f.open, value: f.value, moved: after !== null && Math.abs(after - before) <= 2 },
    { open: true, value: 'abc', moved: true });
}, { md: LINKS_MD });
check('link-field: scrolling the selection out of view closes it', DESKTOP, async (page) => {
  await tallPage(page);
  await selectInSurface(page, 'Plain words here.', 6, 11);
  await page.keyboard.press('Control+k');
  assert.strictEqual((await linkField(page)).open, true);
  await page.evaluate(() => window.scrollTo(0, 3000)); await wait(150);
  assert.strictEqual((await linkField(page)).open, false);
  // Closed by a scroll means back to the toolbar with the selection kept.
  const sel = await page.evaluate(() => String(getSelection()));
  assert.strictEqual(sel, 'words');
  await page.evaluate(() => window.scrollTo(0, 0)); await wait(200);
  const bar = await page.evaluate(() => !!document.querySelector('.ed-seltb') && document.querySelector('.ed-seltb').isConnected);
  assert.strictEqual(bar, true, 'the toolbar comes back when the selection does');
}, { md: LINKS_MD });
check('link-paste: a URL over a selection makes a link', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'Plain words here.', 6, 11);
  await clipboardEvent(page, 'paste', 'https://p.example/', null);
  assert.strictEqual(await commitAndRead(page, boot), LINKS_MD.replace('Plain words here.', 'Plain [words](https://p.example/) here.'));
}, { md: LINKS_MD });
check('link-paste: a URL with html and a trailing newline over a selection makes a link', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'Plain words here.', 6, 11);
  await clipboardEvent(page, 'paste', 'https://p.example/\n', '<a href="https://p.example/">https://p.example/</a>');
  assert.strictEqual(await commitAndRead(page, boot), LINKS_MD.replace('Plain words here.', 'Plain [words](https://p.example/) here.'));
}, { md: LINKS_MD });
check('link-paste: a URL over a selection in a table cell makes a link', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'bravo', 0, 5);
  await clipboardEvent(page, 'paste', 'https://p.example/', null);
  assert.strictEqual(await commitAndRead(page, boot), LINKS_MD.replace('| bravo |', '| [bravo](https://p.example/) |'));
}, { md: LINKS_MD });
check('link-paste: a URL with no selection and other text over a selection paste as text', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Plain words here.', 17);
  await clipboardEvent(page, 'paste', 'https://p.example/', null);
  await selectInSurface(page, 'Plain words here.https://p.example/', 6, 11);
  await clipboardEvent(page, 'paste', 'not a url', null);
  assert.strictEqual(await commitAndRead(page, boot), LINKS_MD.replace('Plain words here.', 'Plain not a url here.https://p.example/'));
}, { md: LINKS_MD });
check('link-paste: Ctrl+Shift+V keeps a URL over a selection as plain text', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'Plain words here.', 6, 11);
  await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'V', ctrlKey: true, shiftKey: true, bubbles: true })));
  await clipboardEvent(page, 'paste', 'https://p.example/', null);
  assert.strictEqual(await commitAndRead(page, boot), LINKS_MD.replace('Plain words here.', 'Plain https://p.example/ here.'));
}, { md: LINKS_MD });


// ── link-card (v3.15.0 T6) ──
// The card as the user sees it: open, the href it shows, and whether it sits
// below the link it names.
const linkCard = (page) => page.evaluate(() => {
  const c = document.querySelector('.ed-linkcard');
  if (!c || !c.isConnected) return { open: false, href: null, belowLink: null };
  const href = c.querySelector('.ed-linkcard-href').textContent;
  const a = [...document.querySelectorAll('.content a')].find((x) => x.getAttribute('href') === href);
  const r = c.getBoundingClientRect();
  return { open: true, href, belowLink: !!a && r.top >= a.getBoundingClientRect().bottom - 0.5 };
});
check('link-card: a caret resting in a link for 300 ms shows its card under the link', DESKTOP, async (page) => {
  await focusSurface(page, 'See docs now.', 6);
  assert.strictEqual((await linkCard(page)).open, false, 'not before 300 ms');
  await wait(450);
  assert.deepStrictEqual(await linkCard(page), { open: true, href: 'https://a.example/', belowLink: true });
}, { md: LINKS_MD });
// GUARD (green before the change): hovering never shows a card.
check('link-card: hovering a link shows nothing', DESKTOP, async (page) => {
  const box = await page.locator('.content a[href="https://a.example/"]').boundingBox();
  await page.mouse.move(box.x + 5, box.y + 5); await wait(600);
  assert.strictEqual((await linkCard(page)).open, false);
}, { md: LINKS_MD });
check('link-card: leaving the link or Esc hides it, and Esc does not revert typing', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'See docs now.', 6); await wait(450);
  assert.strictEqual((await linkCard(page)).open, true, 'precondition: the card is up');
  await page.keyboard.press('End'); await wait(100);
  assert.strictEqual((await linkCard(page)).open, false);
  await page.keyboard.type('!'); await focusSurface(page, 'See docs now.!', 6); await wait(450);
  assert.strictEqual((await linkCard(page)).open, true, 'precondition: the card is up again');
  await page.keyboard.press('Escape');
  assert.strictEqual((await linkCard(page)).open, false);
  assert.strictEqual(await commitAndRead(page, boot), LINKS_MD.replace('now.', 'now.!'));
}, { md: LINKS_MD });
check('link-card: a caret at the edge of a link shows nothing', DESKTOP, async (page) => {
  await focusSurface(page, 'See docs now.', 4); await wait(450);
  assert.strictEqual((await linkCard(page)).open, false, 'caret just before the link');
  await focusSurface(page, 'See docs now.', 8); await wait(450);
  assert.strictEqual((await linkCard(page)).open, false, 'caret just after the link');
}, { md: LINKS_MD });
check('link-card: a scroll closes it', DESKTOP, async (page) => {
  await focusSurface(page, 'See docs now.', 6); await wait(450);
  assert.strictEqual((await linkCard(page)).open, true);
  await page.evaluate(() => { document.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('scroll')); });
  await wait(100);
  assert.strictEqual((await linkCard(page)).open, false);
}, { md: LINKS_MD });
check('link-card: 開啟 opens a new tab', DESKTOP, async (page) => {
  await page.context().route('https://a.example/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>' }));
  await focusSurface(page, 'See docs now.', 6); await wait(450);
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('.ed-linkcard button:has-text("開啟")')]);
  await popup.waitForLoadState().catch(() => {});
  assert.strictEqual(popup.url(), 'https://a.example/');
  await popup.close();
}, { md: LINKS_MD });
check('link-card: 編輯 opens the URL field on the link', DESKTOP, async (page) => {
  await focusSurface(page, 'See docs now.', 6); await wait(450);
  await page.click('.ed-linkcard button:has-text("編輯")');
  const f = await linkField(page);
  assert.deepStrictEqual([f.open, f.value, (await linkCard(page)).open], [true, 'https://a.example/', false]);
}, { md: LINKS_MD });
check('link-card: 移除 unwraps the link', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'See docs now.', 6); await wait(450);
  await page.click('.ed-linkcard button:has-text("移除")');
  assert.strictEqual((await linkCard(page)).open, false);
  assert.strictEqual(await commitAndRead(page, boot), LINKS_MD.replace('[docs](https://a.example/)', 'docs'));
}, { md: LINKS_MD });


// ── link-field long URLs / click-back / plain paste in a cell (v3.15.0 B3 fix round 1) ──
const LONG_URL = 'https://example.com/' + 'a'.repeat(60);
check('link-field: a URL longer than the field, typed, links on disk (R71)', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'Plain words here.', 6, 11);
  await page.keyboard.press('Control+k');
  await page.keyboard.type(LONG_URL);
  assert.deepStrictEqual([(await linkField(page)).open, (await linkField(page)).value], [true, LONG_URL]);
  await page.keyboard.press('Enter');
  assert.strictEqual(await commitAndRead(page, boot), LINKS_MD.replace('Plain words here.', 'Plain [words](' + LONG_URL + ') here.'));
}, { md: LINKS_MD });
check('link-field: a long URL pasted into the field links on disk (R71)', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'Plain words here.', 6, 11);
  await page.keyboard.press('Control+k');
  await page.keyboard.insertText(LONG_URL);
  await wait(100);
  assert.deepStrictEqual([(await linkField(page)).open, (await linkField(page)).value], [true, LONG_URL]);
  await page.keyboard.press('Enter');
  assert.strictEqual(await commitAndRead(page, boot), LINKS_MD.replace('Plain words here.', 'Plain [words](' + LONG_URL + ') here.'));
}, { md: LINKS_MD });
const LONG_LINK_MD = '# D\n\nSee [docs](' + LONG_URL + ') now.\n';
check('link-field: Ctrl+K on a link with a long href, End, edit, Enter (R71)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'See docs now.', 6);
  await page.keyboard.press('Control+k');
  assert.strictEqual((await linkField(page)).value, LONG_URL);
  await page.keyboard.press('End'); await page.keyboard.type('Z');
  await wait(100);
  assert.deepStrictEqual([(await linkField(page)).open, (await linkField(page)).value], [true, LONG_URL + 'Z']);
  await page.keyboard.press('Enter');
  assert.strictEqual(await commitAndRead(page, boot), LONG_LINK_MD.replace(LONG_URL, LONG_URL + 'Z'));
}, { md: LONG_LINK_MD });
check('link-field: a click back into the same paragraph keeps the burst, renders nothing, and the next key lands (R72)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Plain words here.', 17); await page.keyboard.type('!');
  await selectInSurface(page, 'Plain words here.!', 6, 11);
  await renderIdle(page);
  const before = renderTotal(page);
  await page.keyboard.press('Control+k'); await page.keyboard.type('x.ex');
  await focusSurface(page, 'Plain words here.!', 18);
  await page.keyboard.type('Q');
  await renderIdle(page);
  assert.strictEqual((await linkField(page)).open, false);
  assert.strictEqual(renderTotal(page) - before, 0, 'no /api/render for the click back');
  assert.strictEqual(await page.evaluate(() => document.activeElement.className.indexOf('ed-wys-armed') !== -1), true, 'focus stays on the surface');
  assert.strictEqual(await commitAndRead(page, boot), LINKS_MD.replace('Plain words here.', 'Plain words here.!Q'));
}, { md: LINKS_MD });
// The system clipboard is shared by every page of one browser, and an earlier
// check (baseline paste: Ctrl+Shift+V) leaves 'PASTED<b>RICH</b>TEXT' on it.
// A real Ctrl+Shift+V keystroke pastes whatever is there, so a check that
// presses it must set the clipboard itself first.
async function seedClipboard(page, plain) {
  await page.evaluate((t) => {
    window.__seedCopy = (e) => {
      e.clipboardData.setData('text/plain', t === null ? '' : t);
      e.preventDefault(); e.stopImmediatePropagation();
    };
    window.addEventListener('copy', window.__seedCopy, true);
  }, plain);
  await page.keyboard.press('Control+c');
  await page.evaluate(() => window.removeEventListener('copy', window.__seedCopy, true));
}
check('link-paste: a real Ctrl+Shift+V keystroke in a cell keeps a URL plain even after the keystroke\'s empty paste', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'bravo', 0, 5);
  // Something on the clipboard first, then emptied, so the keystroke's own
  // paste is the empty one whatever ran before.
  await seedClipboard(page, 'JUNK');
  await seedClipboard(page, null);
  await page.evaluate(() => { window.__pastes = []; document.addEventListener('paste', (e) => window.__pastes.push(e.clipboardData.getData('text/plain')), true); });
  await page.keyboard.press('Control+Shift+V');
  await renderIdle(page);
  // The keystroke pasted nothing, and nothing was done with it: the selection
  // is still there. (Treating it as a paste deleted "bravo" and used up the
  // plain-paste arming.)
  const r = await page.evaluate(() => ({ pastes: window.__pastes.slice(), sel: String(getSelection()) }));
  assert.deepStrictEqual([r.pastes, r.sel], [[''], 'bravo']);
  await clipboardEvent(page, 'paste', 'https://p.example/', null);
  assert.strictEqual(await commitAndRead(page, boot), LINKS_MD.replace('| bravo |', '| https://p.example/ |'));
}, { md: LINKS_MD });

check('link-paste: a real Ctrl+Shift+V of a copied URL over a cell selection pastes it as plain text', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'bravo', 0, 5);
  await seedClipboard(page, 'https://p.example/');
  await page.keyboard.press('Control+Shift+V');
  await renderIdle(page);
  assert.strictEqual(await commitAndRead(page, boot), LINKS_MD.replace('| bravo |', '| https://p.example/ |'));
}, { md: LINKS_MD });

// ── render-guard (v3.15.0 T9) ──
// R28: the FIRST /api/render is held ~1500 ms and every later one ~100 ms, so
// a response to an older request lands after the response to a newer one.
const slowFirstRender = async (page) => {
  let n = 0;
  await page.route('**/api/render', async (route) => { await wait(n++ === 0 ? 1500 : 100); await route.continue(); });
};
check('render-guard: Ctrl+Z during a slow split render leaves screen = file = original', DESKTOP, async (page, boot) => {
  await slowFirstRender(page);
  await focusSurface(page, 'Bravo paragraph text.', 5); await page.keyboard.press('Enter');
  await page.keyboard.press('Control+z');
  await renderIdle(page);
  assert.deepStrictEqual(await paragraphs(page), ['Alpha para one.', 'Bravo paragraph text.', 'Omega.']);
  assert.strictEqual(await saveAndRead(page, boot), P3_MD);
}, { md: P3_MD });
check('render-guard: a failed render card goes away once a later commit lands', DESKTOP, async (page, boot) => {
  await failFirstRender(page);
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.type(' x');
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await renderIdle(page);
  assert.strictEqual(await page.evaluate(() => !!document.querySelector('.ed-conflict[data-level="error"]')), true, 'guard: card shown');
  await focusSurface(page, 'Alpha. x', 8); await page.keyboard.type('y');
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await renderIdle(page);
  assert.strictEqual(await page.evaluate(() => !!document.querySelector('.ed-conflict[data-level="error"]')), false);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha. xy\n\nOmega.\n');
}, { md: BASE_MD });
// The probe lets the first serializeInline() through (blockEdgeDelete()'s own
// unsupported-format check, before anything moves) and throws on the second —
// joinIntoPrevious()'s serialize(), after joinSeam() has merged the two
// paragraphs on screen and before anything was committed.
// R78 (m1): the probe records what the screen held when it threw, and the
// check asserts the throw really came after the merge — so a later change that
// adds a serializeInline() call before joinSeam() fails here instead of
// passing with nothing merged.
check('failed-render: a structural key that throws after the merge re-renders to the file', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Bravo paragraph text.', 0);
  await page.evaluate(() => {
    const im = window.md2docInlineMd; const orig = im.serializeInline; let n = 0;
    window.__probeAtThrow = null;
    im.serializeInline = function () {
      if (++n === 2) {
        im.serializeInline = orig;
        window.__probeAtThrow = [...document.querySelectorAll('.content .ed-block[data-block-type="paragraph"] .ed-wys-armed')].map((e) => e.textContent);
        throw new Error('probe');
      }
      return orig.apply(this, arguments);
    };
  });
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.deepStrictEqual(await page.evaluate(() => window.__probeAtThrow),
    ['Alpha para one.Bravo paragraph text.', 'Omega.'], 'guard: the probe threw, after the merge');
  assert.ok(/未預期/.test(await noticeText(page) || ''), 'the error card: ' + await noticeText(page));
  assert.deepStrictEqual(await paragraphs(page), ['Alpha para one.', 'Bravo paragraph text.', 'Omega.']);
  await focusSurface(page, 'Bravo paragraph text.', 0); await page.keyboard.type('Q');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha para one.\n\nQBravo paragraph text.\n\nOmega.\n');
}, { md: P3_MD });

// ── render-guard, fix round 1 (R77): after the last render settles, the
// screen equals `lines` — even when the response that was dropped as
// superseded was the last one that could have drawn them ──
// Render k (0-based) is held holds[k] ms and answers with fails[k] ? 500 : the
// real response; renders past the list go straight through.
const scriptRenders = async (page, holds, fails) => {
  let n = 0;
  await page.route('**/api/render', async (route) => {
    const k = n++;
    if (k >= holds.length) { await route.continue(); return; }
    await wait(holds[k]);
    if (fails[k]) await route.fulfill({ status: 500, body: '{}' });
    else await route.continue();
  });
};
const allBlocksHaveIds = (page) => page.evaluate(() => [...document.querySelectorAll('.content .ed-block')].every((b) => b.getAttribute('data-block-id') !== null));
// The reviewer's probe (review-b5 C1): the split's render lands but is
// superseded by the undo's, and the undo's fails, so undo() puts the split
// back into `lines` — which no render ever drew.
check('render-guard: a superseded split whose undo fails is drawn, and the next commit keeps every line (R77)', DESKTOP, async (page, boot) => {
  await scriptRenders(page, [1500, 2500], [false, true]);
  await focusSurface(page, 'Bravo paragraph text.', 5); await page.keyboard.press('Enter');
  await page.keyboard.press('Control+z');
  await renderIdle(page);
  assert.deepStrictEqual(await paragraphs(page), ['Alpha para one.', 'Bravo', 'paragraph text.', 'Omega.']);
  assert.strictEqual(await allBlocksHaveIds(page), true, 'every block is a rendered one');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha para one.\n\nBravo\n\nparagraph text.\n\nOmega.\n');
  await focusSurface(page, 'Omega.', 6); await page.keyboard.type('X');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha para one.\n\nBravo\n\nparagraph text.\n\nOmega.X\n');
  assert.deepStrictEqual(await paragraphs(page), ['Alpha para one.', 'Bravo', 'paragraph text.', 'Omega.X'], 'DOM equals file');
}, { md: P3_MD });
// Both fail: the split's render (superseded, so ignored) and the undo's. The
// rollback then covers the split too — no render of it ever landed — and the
// screen is drawn from `lines` again.
check('render-guard: a superseded split that fails and an undo that fails too leave screen = file (R77)', DESKTOP, async (page, boot) => {
  await scriptRenders(page, [1500, 2500], [true, true]);
  await focusSurface(page, 'Bravo paragraph text.', 5); await page.keyboard.press('Enter');
  await page.keyboard.press('Control+z');
  await renderIdle(page);
  assert.deepStrictEqual(await paragraphs(page), ['Alpha para one.', 'Bravo paragraph text.', 'Omega.']);
  assert.strictEqual(await allBlocksHaveIds(page), true, 'every block is a rendered one');
  assert.strictEqual(await saveAndRead(page, boot), P3_MD);
  await focusSurface(page, 'Omega.', 6); await page.keyboard.type('X');
  assert.strictEqual(await commitAndRead(page, boot), P3_MD.replace('Omega.', 'Omega.X'));
  assert.deepStrictEqual(await paragraphs(page), ['Alpha para one.', 'Bravo paragraph text.', 'Omega.X'], 'DOM equals file');
}, { md: P3_MD });
// The raw box: its Ctrl+Enter render is superseded by a toolbar undo whose
// render fails. undo() puts the raw edit back into `lines`; the screen must
// show it, not the block as it was before the raw box opened. What makes it so
// is the reconciliation redraw (R79): the toolbar undo resolves the box first
// (switchAwayFrom()), so the raw commit's own superseded branch is not reached
// here with the box still open (re-review b5 r1, measured). R81: the card the
// undo's failure raised is still up after that redraw (R80).
check('render-guard: a raw-box commit superseded by an undo that fails shows what the file holds (R77)', DESKTOP, async (page, boot) => {
  await scriptRenders(page, [1500, 2500], [false, true]);
  await openRawBox(page);
  await page.keyboard.press('Control+Enter');
  await wait(200);
  await tb(page, 'undo');
  await renderIdle(page);
  const disk = await saveAndRead(page, boot);
  const screen = await page.evaluate(() => ({
    raw: !!document.querySelector('textarea.ed-raw'),
    paras: [...document.querySelectorAll('.content .ed-block[data-block-type="paragraph"]')].map((b) => b.textContent.trim()),
  }));
  // The undo failed, so its rollback put the raw edit back: the file holds it,
  // and so must the screen.
  assert.strictEqual(disk, '# D\n\nBeta **b**.\n\nOmega.\n');
  assert.deepStrictEqual(screen, { raw: false, paras: ['Beta b.', 'Omega.'] }, 'screen = file');
  assert.strictEqual(await allBlocksHaveIds(page), true, 'every block is a rendered one');
  assert.strictEqual(await noticeText(page), '這次修改沒有套用：HTTP 500。文件維持修改前的樣子。', 'the failure card stays up');
  await focusSurface(page, 'Omega.', 6); await page.keyboard.type('X');
  const after = await commitAndRead(page, boot);
  assert.strictEqual(after, disk.replace('Omega.', 'Omega.X'));
}, { md: BASE_MD });

// ── render-guard, fix round 2 (R79, R80): whenever the last render in
// flight has answered — applied, dropped or failed and rolled back — a
// screen that may differ from `lines` is drawn again from `lines` ──
// re-review b5 r1 H1: a committed edit, then Enter at Bravo| (its render A
// dropped), then two Ctrl+Z whose renders both fail. `lines` ends where the
// last applied render left it, while the split's id-less right half is still
// on screen; the next commit used to drop `paragraph text.` from the file.
// H2 is the same keys with A answering last (2600 ms), dropped.
for (const [label, holds, fails] of [
  ['H1, A lands first', [1500, 2000, 2500], [false, true, true]],
  ['H1, A fails first', [1500, 2000, 2500], [true, true, true]],
  ['H2, A lands last', [2600, 1500, 1500], [false, true, true]],
]) {
  check('render-guard: a dropped split, then two failing undos, leave screen = file and lose no line (R79 ' + label + ')', DESKTOP, async (page, boot) => {
    await focusSurface(page, 'Omega.', 6); await page.keyboard.type('Z');
    const f0 = await commitAndRead(page, boot);
    assert.strictEqual(f0, P3_MD.replace('Omega.', 'Omega.Z'), 'guard: the first commit');
    await scriptRenders(page, holds, fails);
    await focusSurface(page, 'Bravo paragraph text.', 5); await page.keyboard.press('Enter');
    await page.keyboard.press('Control+z');
    await wait(100);
    await page.keyboard.press('Control+z');
    await renderIdle(page); await wait(300); await renderIdle(page);
    const disk = await saveAndRead(page, boot);
    assert.strictEqual(await allBlocksHaveIds(page), true, 'every block is a rendered one: ' + JSON.stringify(await paragraphs(page)));
    const fileParas = disk.split('\n\n').slice(1).map((p) => p.replace(/\n$/, ''));
    assert.deepStrictEqual(await paragraphs(page), fileParas, 'screen = file');
    assert.strictEqual(disk.indexOf('paragraph text.') !== -1, true, 'the file keeps the text: ' + JSON.stringify(disk));
    await focusSurface(page, 'Alpha para one.', 15); await page.keyboard.type('Q');
    const after = await commitAndRead(page, boot);
    assert.strictEqual(after, disk.replace('Alpha para one.', 'Alpha para one.Q'));
    assert.deepStrictEqual(await paragraphs(page), fileParas.map((p) => p === 'Alpha para one.' ? 'Alpha para one.Q' : p), 'DOM equals file');
  }, { md: P3_MD });
}
// v3.15.0 final fix wave, follow-up round (R100): no gesture opens a raw box
// while a commit renders any more — ⠿ MD 原始碼 (R94) and the click on a
// degraded block (R100) both wait for it, and the keys of the ``` / `> `
// shortcuts and the "/" items are held until the flight ends. So the R80 and
// R83 states (a box open while a render is dropped, or while a
// reconciliation redraw is out) are no longer reachable, and these checks pin
// the gate instead: the click opens nothing while a render is out; once it
// lands, the click is refused when that render replaced the block (it does
// here: the split's render and the reconciliation redraw both replace the
// quote) or opens it on the block's own lines; and what is typed into the box
// the next click opens is written. The R86 guard below still reaches its
// state (a box opened on the screen a failed reconciliation left) and keeps
// pinning it. History: 95ba1a9 moved these from ⠿ MD 原始碼 to this quote
// click when R94 gated the former.
const Q3_MD = P3_MD.replace('Alpha para one.', '> Alpha para one.');
async function openQuoteBox(page) {
  const box = await page.locator('.ed-block[data-block-type="blockquote"]').first().boundingBox();
  assert.ok(box, 'openQuoteBox: no blockquote');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await wait(200);
}
const rawOpen = (page) => page.evaluate(() => !!document.querySelector('textarea.ed-raw'));
// R80 (re-review b5 r1, risk a), as gated by R100: a raw box whose commit
// fails keeps its text and the failure card, and the next save writes the
// text. Was: the box opened during the split's render and committed while
// that render was dropped.
check('render-guard: a quote clicked during a split\'s render is refused once it lands; the box the next click opens keeps its text and the card when its commit fails (R80, R100)', DESKTOP, async (page, boot) => {
  await scriptRenders(page, [1500, 2500], [false, true]);
  await focusSurface(page, 'Bravo paragraph text.', 5); await page.keyboard.press('Enter');
  await openQuoteBox(page);
  assert.strictEqual(await rawOpen(page), false, 'no box opens while the split renders');
  await renderIdle(page); await wait(300); await renderIdle(page);
  assert.deepStrictEqual({ box: await rawOpen(page), notice: await noticeText(page), ids: await allBlocksHaveIds(page) },
    { box: false, notice: '文件已更新，請重試這個操作', ids: true }, 'refused once the render replaced the quote');
  await openQuoteBox(page);
  assert.strictEqual(await rawOpen(page), true, 'guard: raw box open');
  await page.focus('textarea.ed-raw');
  await page.keyboard.press('End');
  await page.keyboard.type(' typed');
  await page.keyboard.press('Control+Enter');
  await renderIdle(page); await wait(300); await renderIdle(page);
  const box = await rawBox(page);
  assert.deepStrictEqual(box && box.value, '> Alpha para one. typed', 'the box keeps its text after the failed commit: ' + JSON.stringify(box));
  assert.strictEqual(await noticeText(page), '這次修改沒有套用：HTTP 500。文件維持修改前的樣子。', 'the failure card stays up');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n> Alpha para one. typed\n\nBravo\n\nparagraph text.\n\nOmega.\n');
  assert.strictEqual(await allBlocksHaveIds(page), true, 'every block is a rendered one');
}, { md: Q3_MD });

// ── render-guard, fix round 3 (R83, R84) ──
// R83: a response that arrives late but was REQUESTED before the render
// already on screen is no reason to redraw. Here the split's render (A) is
// held 2000 ms and the undo's (B) 300 ms, both succeed: B lands first, A
// arrives late and is dropped. Measured before the fix: a third, full render
// that closed the raw box opened meanwhile (and lost what was typed in it).
// As gated by R100: the click made while A is out opens the box only once A
// has landed — on the quote's own lines, with no redraw after it.
for (const typed of ['', ' ab']) {
  check('render-guard: responses that all succeed out of order cost no extra render, and a quote clicked meanwhile opens once they land (R83, R100, typed=' + JSON.stringify(typed) + ')', DESKTOP, async (page, boot) => {
    await scriptRenders(page, [2000, 300], [false, false]);
    const t0 = renderTotal(page);
    await focusSurface(page, 'Bravo paragraph text.', 5); await page.keyboard.press('Enter');
    await wait(100); await page.keyboard.press('Control+z');
    await wait(500);
    await openQuoteBox(page);
    assert.strictEqual(await rawOpen(page), false, 'no box opens while the late render is out');
    await renderIdle(page); await wait(300); await renderIdle(page);
    assert.strictEqual(renderTotal(page) - t0, 2, 'two renders, no redraw');
    assert.strictEqual((await rawBox(page) || {}).value, '> Alpha para one.', 'the box opened on the quote\'s own lines');
    await page.focus('textarea.ed-raw'); await page.keyboard.press('End');
    if (typed) await page.keyboard.type(typed);
    const box = await rawBox(page);
    assert.strictEqual(box && box.value, '> Alpha para one.' + typed, 'the box is open as typed: ' + JSON.stringify(box));
    await page.focus('textarea.ed-raw'); await page.keyboard.type('!'); await page.keyboard.press('Control+Enter');
    await renderIdle(page);
    assert.strictEqual(renderTotal(page) - t0, 3, 'the commit is the only render after them');
    assert.strictEqual(await saveAndRead(page, boot), Q3_MD.replace('> Alpha para one.', '> Alpha para one.' + typed + '!'));
  }, { md: Q3_MD });
}
// R83, as gated by R100. Order: the split's render (A, 300 ms, ok) is
// dropped by the undo; the undo's (B, 2000 ms) fails, undo() puts the split
// back, and the reconciliation redraw (1000 ms, ok) draws it. Was: ' cd'
// typed into a box opened before the redraw survived it (the box was stashed
// at apply time). Now the click made before the redraw opens nothing until
// it has landed and is then refused (the redraw replaced the quote); the
// box the next click opens holds the quote's lines from the redrawn screen,
// and what is typed into it is written.
for (const before of ['', ' ab']) {
  check('render-guard: a quote clicked before a reconciliation redraw opens nothing until it lands, then is refused; the next box writes what is typed (R83, R100, before=' + JSON.stringify(before) + ')', DESKTOP, async (page, boot) => {
    await scriptRenders(page, [300, 2000, 1000], [false, true, false]);
    const t0 = renderTotal(page);
    await focusSurface(page, 'Bravo paragraph text.', 5); await page.keyboard.press('Enter');
    await wait(100); await page.keyboard.press('Control+z');
    await wait(600);
    await openQuoteBox(page);
    assert.strictEqual(await rawOpen(page), false, 'no box opens while the undo renders');
    const deadline = Date.now() + 8000;
    while (renderTotal(page) - t0 < 3 && Date.now() < deadline) await wait(10);
    assert.strictEqual(renderTotal(page) - t0, 3, 'guard: the reconciliation redraw is out');
    await wait(150);
    assert.deepStrictEqual({ box: await rawOpen(page), notice: await noticeText(page) },
      { box: false, notice: '這次修改沒有套用：HTTP 500。文件維持修改前的樣子。' }, 'no box during the redraw; the failure card is up');
    await renderIdle(page); await wait(300); await renderIdle(page);
    assert.deepStrictEqual({ box: await rawOpen(page), notice: await noticeText(page), ids: await allBlocksHaveIds(page) },
      { box: false, notice: '文件已更新，請重試這個操作', ids: true }, 'refused once the redraw replaced the quote');
    await openQuoteBox(page);
    assert.strictEqual((await rawBox(page) || {}).value, '> Alpha para one.', 'the next click opens the quote\'s own lines');
    await page.focus('textarea.ed-raw'); await page.keyboard.press('End');
    await page.keyboard.type(before + ' cd');
    const box = await rawBox(page);
    assert.strictEqual(box && box.value, '> Alpha para one.' + before + ' cd', 'the box holds everything typed: ' + JSON.stringify(box));
    assert.strictEqual(await allBlocksHaveIds(page), true, 'every block is a rendered one');
    await page.focus('textarea.ed-raw'); await page.keyboard.press('Control+Enter');
    await renderIdle(page);
    assert.strictEqual(await saveAndRead(page, boot), '# D\n\n> Alpha para one.' + before + ' cd\n\nBravo\n\nparagraph text.\n\nOmega.\n');
  }, { md: Q3_MD });
}
// R84: the reconciliation redraw itself fails (the server is down), so the
// split's id-less right half stays on screen and `blocks` is stale. When the
// server is back, the next press into a surface runs the owed reconciliation
// before anything can commit; the commit then writes the right line, and the
// card stays up until a commit lands. Measured before the fix: Q typed into
// Omega committed over `paragraph text.`.
for (const [target, offset] of [['Omega.', 6], ['Bravo', 5]]) {
  check('render-guard: after a failed reconciliation, the next commit waits for the screen to match and writes the right line (R84, ' + target + ')', DESKTOP, async (page, boot) => {
    await scriptRenders(page, [1500, 2000, 300], [false, true, true]);
    const t0 = renderTotal(page);
    await focusSurface(page, 'Bravo paragraph text.', 5); await page.keyboard.press('Enter');
    await page.keyboard.press('Control+z');
    await renderIdle(page); await wait(300); await renderIdle(page);
    assert.strictEqual(renderTotal(page) - t0, 3, 'guard: split, undo, and the reconciliation that failed');
    assert.strictEqual(await noticeText(page), '這次修改沒有套用：HTTP 500。文件維持修改前的樣子。', 'guard: the card is up');
    // The server is back (renders past the script go through).
    await clickChar(page, target, 2); await renderIdle(page); await wait(300); await renderIdle(page);
    assert.strictEqual(await allBlocksHaveIds(page), true, 'the screen was drawn again before anything committed');
    assert.deepStrictEqual(await paragraphs(page), ['Alpha para one.', 'Bravo', 'paragraph text.', 'Omega.'], 'screen = lines');
    assert.strictEqual(await noticeText(page), '這次修改沒有套用：HTTP 500。文件維持修改前的樣子。', 'the card stays until a commit lands');
    await focusSurface(page, target, offset); await page.keyboard.type('Q');
    const want = '# D\n\nAlpha para one.\n\nBravo\n\nparagraph text.\n\nOmega.\n'.replace('\n' + target + '\n', '\n' + target + 'Q\n');
    assert.strictEqual(await commitAndRead(page, boot), want);
    assert.deepStrictEqual(await paragraphs(page), ['Alpha para one.', 'Bravo', 'paragraph text.', 'Omega.'].map((p) => p === target ? p + 'Q' : p), 'DOM equals file');
    assert.strictEqual(await noticeText(page), null, 'the commit that landed took the card away');
  }, { md: P3_MD });
}

// R84, the gutter: a ⠿ gesture picked on the stale screen (its block found
// by id and line in the last drawn document) runs the owed reconciliation
// first, and then must not re-find "its" block by a line that now holds a
// different one. It deletes the block that was picked, or is refused with the
// notice; `paragraph text.` is never the one deleted.
check('render-guard: a ⠿ delete picked after a failed reconciliation never deletes another block (R84)', DESKTOP, async (page, boot) => {
  await scriptRenders(page, [1500, 2000, 300], [false, true, true]);
  const t0 = renderTotal(page);
  await focusSurface(page, 'Bravo paragraph text.', 5); await page.keyboard.press('Enter');
  await page.keyboard.press('Control+z');
  await renderIdle(page); await wait(300); await renderIdle(page);
  assert.strictEqual(renderTotal(page) - t0, 3, 'guard: split, undo, and the reconciliation that failed');
  await gutterMenu(page, await blockByText(page, 'Omega.'), '刪除');
  await renderIdle(page); await wait(300); await renderIdle(page);
  const r = { disk: await saveAndRead(page, boot), notice: await noticeText(page), ids: await allBlocksHaveIds(page) };
  const deleted = r.disk === '# D\n\nAlpha para one.\n\nBravo\n\nparagraph text.\n';
  const refused = r.disk === '# D\n\nAlpha para one.\n\nBravo\n\nparagraph text.\n\nOmega.\n' && r.notice === '文件已更新，請重試這個操作';
  assert.strictEqual(deleted || refused, true, 'Omega. deleted, or the gesture refused with the notice: ' + JSON.stringify(r));
  assert.strictEqual(r.ids, true, 'every block is a rendered one');
}, { md: P3_MD });

// ── render-guard, fix round 4 (R86) ──
// The R84 order again: the split lands, its undo fails, and the
// reconciliation that would draw `lines` fails too, so the split's id-less
// right half is on screen and `blocks` is stale. Renders past the script go
// through (the server is back).
const R86_CARD = '這次修改沒有套用：HTTP 500。文件維持修改前的樣子。';
const R86_SPLIT_MD = '# D\n\nAlpha para one.\n\nBravo\n\nparagraph text.\n\nOmega.\n';
const R86_SPLIT_PARAS = ['Alpha para one.', 'Bravo', 'paragraph text.', 'Omega.'];
const R86_TASK_MD = '# D\n\nAlpha para one.\n\nBravo paragraph text.\n\n- [ ] one\n- [ ] two\n- [ ] three\n';
const settleR86 = async (page) => { await renderIdle(page); await wait(300); await renderIdle(page); };
async function staleAfterFailedReconcile(page, holds, fails) {
  await scriptRenders(page, holds, fails);
  const t0 = renderTotal(page);
  await focusSurface(page, 'Bravo paragraph text.', 5); await page.keyboard.press('Enter');
  await page.keyboard.press('Control+z');
  await settleR86(page);
  assert.strictEqual(renderTotal(page) - t0, 3, 'guard: split, undo, and the reconciliation that failed');
  assert.strictEqual(await noticeText(page), R86_CARD, 'guard: the card is up');
  return t0;
}
// R86 (1): the item a checkbox click toggles is the one clicked, taken from
// the clicked node after the gate, never re-found by an id read before the
// reconciliation moved every id below the split. The reconciliation is a full
// redraw, so the clicked node is gone and the click is refused; the next one
// toggles `two`. Measured before the fix: `one` was checked.
check('render-guard: a task checkbox clicked after a failed reconciliation never toggles another item (R86)', DESKTOP, async (page, boot) => {
  await staleAfterFailedReconcile(page, [1500, 2000, 300], [false, true, true]);
  const checkPt = () => page.evaluate(() => {
    const li = [...document.querySelectorAll('.ed-block[data-block-type="li"]')].find((b) => b.textContent.indexOf('two') !== -1);
    const c = li && li.querySelector(':scope > .ed-li-check');
    if (!c) return null;
    const b = c.getBoundingClientRect();
    return [b.left + b.width / 2, b.top + b.height / 2];
  });
  let pt = await checkPt();
  assert.ok(pt, 'guard: two has a checkbox');
  await page.mouse.click(pt[0], pt[1]);
  await settleR86(page);
  assert.strictEqual(await allBlocksHaveIds(page), true, 'the screen was drawn again before anything committed');
  const notice = await noticeText(page);
  const tasks = (two) => R86_SPLIT_MD.replace('Omega.\n', '- [ ] one\n- [' + two + '] two\n- [ ] three\n');
  assert.deepStrictEqual({ disk: await saveAndRead(page, boot), notice },
    { disk: tasks(' '), notice: '文件已更新，請重試這個操作' }, 'the click on the stale screen is refused');
  pt = await checkPt();
  assert.ok(pt, 'guard: two still has a checkbox');
  await page.mouse.click(pt[0], pt[1]);
  await settleR86(page);
  assert.strictEqual(await saveAndRead(page, boot), tasks('x'), 'the next click toggles the item clicked');
}, { md: R86_TASK_MD });
// R86 (1) guards: the everyday case, no failure anywhere. A checkbox clicked
// while another block holds uncommitted typing commits that typing first and
// still toggles the item clicked: from a paragraph above the list, and from
// an item of the same list.
for (const [label, surface, offset, from, to] of [
  ['a paragraph above', 'Bravo paragraph text.', 15, 'Bravo paragraph text.', 'Bravo paragraphX text.'],
  ['an item of the same list', 'one', 3, '[ ] one', '[ ] oneX']]) {
  check('render-guard: a task checkbox clicked while ' + label + ' holds typing toggles the item clicked (R86 guard)', DESKTOP, async (page, boot) => {
    await focusSurface(page, surface, offset); await page.keyboard.type('X');
    const pt = await page.evaluate(() => {
      const li = [...document.querySelectorAll('.ed-block[data-block-type="li"]')].find((b) => b.textContent.indexOf('two') !== -1);
      const c = li && li.querySelector(':scope > .ed-li-check');
      if (!c) return null;
      const b = c.getBoundingClientRect();
      return [b.left + b.width / 2, b.top + b.height / 2];
    });
    assert.ok(pt, 'guard: two has a checkbox');
    await page.mouse.click(pt[0], pt[1]);
    await settleR86(page);
    const notice = await noticeText(page);
    assert.deepStrictEqual({ notice, disk: await saveAndRead(page, boot) },
      { notice: null, disk: R86_TASK_MD.replace(from, to).replace('[ ] two', '[x] two') });
  }, { md: R86_TASK_MD });
}
// R89 (re-review b5 r4 N1): the paragraph above is hard-wrapped, so the commit
// of the typing in it (started by the press's own blur) joins it into one line
// and every item moves up a line. The item clicked is the one toggled. Measured
// at 5caa780: an identity mixing the old start line with the new source
// re-found the item below — `three` (A5), or item 3 of three identical ones (A2).
for (const [label, items, idx, want] of [
  ['A5, distinct items', ['one', 'two', 'three'], 1, ['one', 'two', 'three']],
  ['A2, three identical items', ['a', 'a', 'a'], 1, ['a', 'a', 'a']]]) {
  check('render-guard: a task checkbox clicked after typing in a hard-wrapped paragraph above toggles the item clicked (R89, ' + label + ')', DESKTOP, async (page, boot) => {
    const list = (marks) => items.map((t, i) => '- [' + marks[i] + '] ' + t + '\n').join('');
    await focusSurface(page, 'Bravo\nparagraph text.', 5); await page.keyboard.type('X');
    const pt = await page.evaluate((i) => {
      const li = [...document.querySelectorAll('.ed-block[data-block-type="li"]')][i];
      const c = li && li.querySelector(':scope > .ed-li-check');
      if (!c) return null;
      const b = c.getBoundingClientRect();
      return [b.left + b.width / 2, b.top + b.height / 2];
    }, idx);
    assert.ok(pt, 'guard: item ' + (idx + 1) + ' has a checkbox');
    await page.mouse.click(pt[0], pt[1]);
    await settleR86(page);
    const notice = await noticeText(page);
    assert.deepStrictEqual({ notice, disk: await saveAndRead(page, boot) },
      { notice: null, disk: '# D\n\nAlpha para one.\n\nBravoX paragraph text.\n\n' + list(want.map((t, i) => i === idx ? 'x' : ' ')) });
  }, { md: '# D\n\nAlpha para one.\n\nBravo\nparagraph text.\n\n' + items.map((t) => '- [ ] ' + t + '\n').join('') });
}
// R86 (2): the press into `Omega.` runs the owed reconciliation and it fails
// as well. No burst opens on that stale screen, and what is typed there is
// dropped, so a shortcut has nothing to convert. Measured before the fix: the
// burst opened, `# ` committed through the stale `blocks`, and the file got
// `# Omega.` in place of `paragraph text.`.
check('render-guard: "# " typed where the reconciliation failed again writes nothing, and converts once the screen is drawn (R86)', DESKTOP, async (page, boot) => {
  const t0 = await staleAfterFailedReconcile(page, [1500, 2000, 300, 300], [false, true, true, true]);
  await focusSurface(page, 'Omega.', 0); await settleR86(page);
  assert.strictEqual(renderTotal(page) - t0, 4, 'guard: the press ran the owed reconciliation, and it failed too');
  await page.keyboard.type('# '); await settleR86(page);
  assert.strictEqual(renderTotal(page) - t0, 4, 'nothing was committed');
  assert.deepStrictEqual(await paragraphs(page), R86_SPLIT_PARAS, 'the keys did not reach the stale screen');
  assert.strictEqual(await noticeText(page), R86_CARD, 'the card stays up');
  assert.strictEqual(await saveAndRead(page, boot), R86_SPLIT_MD, 'paragraph text. is kept');
  assert.strictEqual(await allBlocksHaveIds(page), true, 'Ctrl+S ran the reconciliation');
  await focusSurface(page, 'Omega.', 0); await page.keyboard.type('# '); await settleR86(page);
  assert.strictEqual(await saveAndRead(page, boot), R86_SPLIT_MD.replace('\nOmega.\n', '\n# Omega.\n'));
}, { md: P3_MD });
// R86 (2): the "/" menu on a paragraph that holds nothing but the query.
// Measured before the fix: the pick replaced `paragraph text.`.
check('render-guard: "/表" on an emptied surface where the reconciliation failed again writes nothing (R86)', DESKTOP, async (page, boot) => {
  const t0 = await staleAfterFailedReconcile(page, [1500, 2000, 300, 300], [false, true, true, true]);
  await focusSurface(page, 'Omega.', 6); await settleR86(page);
  assert.strictEqual(renderTotal(page) - t0, 4, 'guard: the press ran the owed reconciliation, and it failed too');
  for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('/表'); await wait(300);
  const menu = await page.evaluate(() => !!document.querySelector('.ed-slash-menu'));
  const paras = await paragraphs(page);
  await page.keyboard.press('Enter'); await settleR86(page);
  const r = { menu, paras,
    tables: await page.evaluate(() => document.querySelectorAll('.content .ed-block[data-block-type="table"]').length),
    disk: await saveAndRead(page, boot) };
  assert.deepStrictEqual(r, { menu: false, paras: R86_SPLIT_PARAS, tables: 0, disk: R86_SPLIT_MD });
}, { md: P3_MD });
// R86 (2): a plain key typed there is dropped too, not kept for later and
// never written on another line; a press into the same (focused) surface runs
// the reconciliation again, and typing then lands. Measured before the fix:
// the key went into the stale burst and was carried to `Omega.Q` (the
// re-review r3 "carry" gesture, which therefore no longer reaches the carry).
check('render-guard: a key typed where the reconciliation failed again is dropped, and a press into that surface draws the screen (R86)', DESKTOP, async (page, boot) => {
  const t0 = await staleAfterFailedReconcile(page, [1500, 2000, 300, 300], [false, true, true, true]);
  await focusSurface(page, 'Omega.', 6); await settleR86(page);
  assert.strictEqual(renderTotal(page) - t0, 4, 'guard: the press ran the owed reconciliation, and it failed too');
  await page.keyboard.type('Q'); await settleR86(page);
  assert.deepStrictEqual(await paragraphs(page), R86_SPLIT_PARAS, 'the key did not reach the stale screen');
  assert.strictEqual(await noticeText(page), R86_CARD, 'the card stays up');
  await clickChar(page, 'Omega.', 3); await settleR86(page);
  assert.strictEqual(renderTotal(page) - t0, 5, 'the press ran the reconciliation');
  assert.strictEqual(await allBlocksHaveIds(page), true, 'the screen was drawn');
  assert.deepStrictEqual(await paragraphs(page), R86_SPLIT_PARAS, 'screen = lines');
  await focusSurface(page, 'Omega.', 6); await page.keyboard.type('Q');
  assert.strictEqual(await commitAndRead(page, boot), R86_SPLIT_MD.replace('Omega.', 'Omega.Q'));
}, { md: P3_MD });
// Guard (green before R86; the re-review r3 found the gesture): a raw box
// opened while the undo renders, its commit tried after the reconciliation
// failed. The commit is refused, the reconciliation runs, the box comes back
// on its text, and the next Ctrl+Enter writes the right line.
check('render-guard: a raw-box commit after a failed reconciliation waits for the redraw and writes the right line (R86 guard)', DESKTOP, async (page, boot) => {
  await scriptRenders(page, [300, 2000, 1000], [false, true, true]);
  const t0 = renderTotal(page);
  await focusSurface(page, 'Bravo paragraph text.', 5); await page.keyboard.press('Enter');
  await wait(100); await page.keyboard.press('Control+z');
  await wait(600);
  await openQuoteBox(page);
  await page.focus('textarea.ed-raw'); await page.keyboard.press('End');
  await page.keyboard.type(' ab');
  await settleR86(page);
  assert.strictEqual(renderTotal(page) - t0, 3, 'guard: split, undo, and the reconciliation that failed');
  assert.strictEqual(await noticeText(page), R86_CARD, 'guard: the card is up');
  assert.strictEqual((await rawBox(page) || {}).value, '> Alpha para one. ab', 'guard: the box is open');
  await page.focus('textarea.ed-raw'); await page.keyboard.press('Control+Enter');
  await settleR86(page);
  assert.strictEqual(renderTotal(page) - t0, 4, 'the commit was refused and ran the reconciliation');
  assert.strictEqual((await rawBox(page) || {}).value, '> Alpha para one. ab', 'the box is back on its text');
  assert.strictEqual(await allBlocksHaveIds(page), true, 'every block is a rendered one');
  assert.strictEqual(await noticeText(page), R86_CARD, 'the card stays up');
  await page.focus('textarea.ed-raw'); await page.keyboard.press('Control+Enter');
  await settleR86(page);
  assert.strictEqual(await rawBox(page), null, 'the second commit closed the box');
  assert.strictEqual(await saveAndRead(page, boot), R86_SPLIT_MD.replace('Alpha para one.', '> Alpha para one. ab'));
}, { md: Q3_MD });

// ── followup (v3.15.0 T10) ──
// R29: no check for joinTransientIntoBlock()'s `empty` — no gesture reaches it.
check('failed-render: after a failed split the retry keeps typing and split as two undo steps', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.type(' x');
  await failFirstRender(page);
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Enter'); await renderIdle(page);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\nx\n\nOmega.\n');
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha. x\n\nOmega.\n', 'first undo removes only the split');
}, { md: BASE_MD });
// R28 (D22): the first `nFail` renders are held 800 ms and fail; every later
// one is held 800 ms and goes through.
const failThenHold = async (page, nFail) => {
  let left = nFail;
  await page.route('**/api/render', async (route) => {
    await wait(800);
    if (left > 0) { left--; await route.fulfill({ status: 500, body: '{}' }); return; }
    await route.continue();
  });
};
const TWO_LISTS_MD = '# D\n\n- alpha\n- bravo\n- charlie\n\nMid.\n\n- xray\n- yank\n';
// The other block is a list item, so its commit adds its own run's line map
// (resolveBurst()'s list branch). The key is held after a click into the new
// item DURING that commit's render: it carries the new item's tag, found again
// only through the structure's half of the map.
check('failed-render: a key typed into the new item while another list commits lands in it (R28 merge)', DESKTOP, async (page, boot) => {
  await failThenHold(page, 2);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('new'); await renderIdle(page);
  await clickChar(page, 'xray', 2); await renderIdle(page);
  assert.deepStrictEqual(await liTexts(page), ['alpha', 'bravo', 'new', 'charlie', 'xray', 'yank'], 'guard: the screen keeps the new item');
  await page.keyboard.press('End'); await page.keyboard.type('X');
  await page.keyboard.press('Control+s');
  await wait(100);
  await clickChar(page, 'new', 2); await page.keyboard.type('Q');
  await renderIdle(page); await wait(300); await renderIdle(page);
  assert.deepStrictEqual(await liTexts(page), ['alpha', 'bravo', 'neQw', 'charlie', 'xrayX', 'yank']);
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n- bravo\n- neQw\n- charlie\n\nMid.\n\n- xrayX\n- yank\n');
}, { md: TWO_LISTS_MD });
// The other block sits ABOVE the list and its commit changes the number of
// lines (its source holds a soft line break, and replacing its text writes one
// line), so every line the structure's map names is one off. The held key
// lands in the new item or is dropped with the notice; it never lands on the
// line the stale map names (`charlie`, one below). (A Shift+Enter
// break would not do: it is written as an inline `<br>` on the same
// line, measured.)
check('failed-render: a key held for the new item while a block above changes its line count never lands on a wrong line (R28)', DESKTOP, async (page, boot) => {
  await failThenHold(page, 2);
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('new'); await renderIdle(page);
  await clickChar(page, 'Top.\nsecond', 2); await renderIdle(page);
  assert.deepStrictEqual(await liTexts(page), ['alpha', 'bravo', 'new', 'charlie'], 'guard: the screen keeps the new item');
  const selected = await page.evaluate(() => {
    const s = document.activeElement;
    if (!s || s.textContent !== 'Top.\nsecond') return false;
    getSelection().selectAllChildren(s);
    return true;
  });
  assert.strictEqual(selected, true, 'guard: the paragraph above is focused');
  await page.keyboard.type('Z');
  await page.keyboard.press('Control+s');
  await wait(100);
  await clickChar(page, 'new', 2); await page.keyboard.type('Q');
  await renderIdle(page); await wait(300); await renderIdle(page);
  const r = { items: await liTexts(page), notice: await noticeText(page) };
  const landed = JSON.stringify(r.items) === JSON.stringify(['alpha', 'bravo', 'neQw', 'charlie']);
  const dropped = JSON.stringify(r.items) === JSON.stringify(['alpha', 'bravo', 'new', 'charlie']) && /略過/.test(r.notice || '');
  assert.strictEqual(landed || dropped, true, 'the key is in the new item, or dropped with the notice: ' + JSON.stringify(r));
  assert.strictEqual(await commitAndRead(page, boot),
    '# D\n\nZ\n\n- alpha\n- bravo\n- ' + (landed ? 'neQw' : 'new') + '\n- charlie\n');
}, { md: '# D\n\nTop.\nsecond\n\n- alpha\n- bravo\n- charlie\n' });
// R54: a transient left holding `#` + NBSP commits the escaped literal, not a
// heading. Composed through CDP, so the shortcut (never during an IME
// composition, D3) stays out of it. Chromium only.
check('transient-model: a composed "#" + NBSP left in a transient saves escaped (R54)', DESKTOP, async (page, boot) => {
  await newParaBelowAlpha(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '#', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.imeSetComposition', { text: '#\u00a0', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.insertText', { text: '#\u00a0' });
  await wait(300); await renderIdle(page);
  assert.strictEqual(await page.evaluate(() => document.querySelector('[data-ed-transient] .ed-wys-armed').textContent), '#\u00a0', 'guard: the transient holds # and an NBSP');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n\\#\n\nOmega.\n');
}, { md: BASE_MD, engines: ['chromium'] });

// ── v3.15.0 final fix wave (R93–R98) ──
// R93 (C1, I1/R90): a task checkbox resolves nothing until every commit in
// flight has landed. Then the pressed item itself when its node is still on
// screen, else (an edit sat above it at the press) the same position counted
// from the end, else its id; and only if that item still reads as it did at
// the press. Measured at ffbdd7c: T, P1b and P1c checked `one`; P1 deleted
// `para one.` and wrote the list twice.
const FF_TASK_MD = '# D\n\nAlpha para one.\n\n- [ ] one\n- [ ] two\n- [ ] three\n';
const ffTasks = (head, two) => '# D\n\n' + head + '- [ ] one\n- [' + two + '] two\n- [ ] three\n';
async function ffClickCheck(page, text) {
  const pt = await page.evaluate((t) => {
    const li = [...document.querySelectorAll('.ed-block[data-block-type="li"]')].find((b) => b.textContent.trim() === t);
    const c = li && li.querySelector(':scope > .ed-li-check');
    if (!c) return null;
    const b = c.getBoundingClientRect();
    return [b.left + b.width / 2, b.top + b.height / 2];
  }, text);
  assert.ok(pt, 'guard: ' + text + ' has a checkbox');
  await page.mouse.click(pt[0], pt[1]);
}
const ffChecks = (page) => page.evaluate(() => [...document.querySelectorAll('.ed-block[data-block-type="li"]')].map((b) => b.textContent.trim() + ':' + b.querySelector(':scope > .ed-li-check').getAttribute('data-checked')));
check('checkbox-settle: a checkbox clicked right after typing into a new paragraph above the list toggles the item clicked (R93, T)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha para one.', 15); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('new');
  await ffClickCheck(page, 'two');
  await settleR86(page);
  assert.deepStrictEqual(await ffChecks(page), ['one:0', 'two:1', 'three:0'], 'screen');
  assert.deepStrictEqual({ notice: await noticeText(page), disk: await saveAndRead(page, boot) },
    { notice: null, disk: ffTasks('Alpha para one.\n\nnew\n\n', 'x') });
}, { md: FF_TASK_MD });
check('checkbox-settle: a checkbox clicked while a split above the list renders toggles the item clicked and writes nothing else (R93, C1)', DESKTOP, async (page, boot) => {
  await delayRender(page, 1500);
  await focusSurface(page, 'Alpha para one.', 5); await page.keyboard.press('Enter'); await wait(100);
  await ffClickCheck(page, 'two');
  await wait(2000); await settleR86(page); await wait(1600); await settleR86(page);
  await page.unroute('**/api/render');
  assert.deepStrictEqual(await ffChecks(page), ['one:0', 'two:1', 'three:0'], 'screen');
  assert.deepStrictEqual({ notice: await noticeText(page), disk: await saveAndRead(page, boot) },
    { notice: null, disk: ffTasks('Alpha\n\npara one.\n\n', 'x') });
}, { md: FF_TASK_MD });
check('checkbox-settle: a checkbox clicked while a new paragraph above the list commits toggles the item clicked (R93, P1b)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha para one.', 15); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('new');
  await delayRender(page, 1500);
  await page.keyboard.press('Enter'); await wait(100);
  await ffClickCheck(page, 'two');
  await wait(2000); await settleR86(page); await wait(1600); await settleR86(page);
  await page.unroute('**/api/render');
  assert.deepStrictEqual(await ffChecks(page), ['one:0', 'two:1', 'three:0'], 'screen');
  assert.deepStrictEqual({ notice: await noticeText(page), disk: await saveAndRead(page, boot) },
    { notice: null, disk: ffTasks('Alpha para one.\n\nnew\n\n', 'x') });
}, { md: FF_TASK_MD });
check('checkbox-settle: a checkbox clicked after typing into a new paragraph above the list on a slow render toggles the item clicked (R93, P1c)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha para one.', 15); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('new');
  await delayRender(page, 1200);
  await ffClickCheck(page, 'two');
  await wait(1600); await settleR86(page); await wait(1300); await settleR86(page);
  await page.unroute('**/api/render');
  assert.deepStrictEqual(await ffChecks(page), ['one:0', 'two:1', 'three:0'], 'screen');
  assert.deepStrictEqual({ notice: await noticeText(page), disk: await saveAndRead(page, boot) },
    { notice: null, disk: ffTasks('Alpha para one.\n\nnew\n\n', 'x') });
}, { md: FF_TASK_MD });

// R93, a press as long as a person's: the mouse is held 100 ms. The press's
// blur used to start the new paragraph's commit, whose render replaced the
// checkbox before the button came up, and the browser then sent no click at
// all (both engines; measured with a 25–200 ms hold after the settle fix:
// nothing toggled, no notice). The instant Playwright click above never
// showed it.
for (const hold of [100, 250]) {
  check('checkbox-settle: a ' + hold + ' ms press on a checkbox right after typing into a new paragraph above the list toggles the item clicked (R93, T)', DESKTOP, async (page, boot) => {
    await focusSurface(page, 'Alpha para one.', 15); await page.keyboard.press('Enter'); await renderIdle(page);
    await page.keyboard.type('new');
    const pt = await page.evaluate(() => {
      const li = [...document.querySelectorAll('.ed-block[data-block-type="li"]')].find((b) => b.textContent.trim() === 'two');
      const b = li.querySelector(':scope > .ed-li-check').getBoundingClientRect();
      return [b.left + b.width / 2, b.top + b.height / 2];
    });
    await page.mouse.move(pt[0], pt[1]); await page.mouse.down(); await wait(hold); await page.mouse.up();
    await settleR86(page);
    assert.deepStrictEqual(await ffChecks(page), ['one:0', 'two:1', 'three:0'], 'screen');
    assert.deepStrictEqual({ notice: await noticeText(page), disk: await saveAndRead(page, boot) },
      { notice: null, disk: ffTasks('Alpha para one.\n\nnew\n\n', 'x') });
  }, { md: FF_TASK_MD });
}

// R94 (I2, L208b): a ⠿ gesture picked while another commit renders waits for
// it, then acts on the block it was opened on. Never on the block one
// paragraph up. Measured at ffbdd7c: ⠿ 刪除 on `Omega.` deleted `Middle.`.
const FF_GUTTER_MD = '# D\n\nAlpha para one.\n\nMiddle.\n\nOmega.\n';
const FF_SPLIT = '# D\n\nAlpha\n\npara one.\n\nMiddle.\n';
// Final re-review N3: the split's render replaces every block below it, so
// the pressed `Omega.` node is gone once the render lands. Until v3.17.3 that
// branch refused with the notice and these checks pinned the refusal;
// v3.17.3 B4 (R17) finds the block again by what it read on screen
// (settledGestureBlock()), so they pin that it is acted on, once, and the
// twin check below pins the refusal that remains (a block that cannot be
// told from another one).
check('gutter-settle: ⠿ 刪除 picked while a split above renders waits for it and deletes the block it was opened on (R94, R17)', DESKTOP, async (page, boot) => {
  await delayRender(page, 2500);
  await focusSurface(page, 'Alpha para one.', 5); await page.keyboard.press('Enter'); await wait(100);
  await gutterMenu(page, await blockByText(page, 'Omega.'), '刪除');
  await wait(2500); await settleR86(page); await wait(2600); await settleR86(page);
  await page.unroute('**/api/render');
  assert.deepStrictEqual({ notice: await noticeText(page), disk: await saveAndRead(page, boot) },
    { notice: null, disk: FF_SPLIT }, 'deleted once the split landed, no notice');
  await tb(page, 'undo'); await wait(300);
  assert.strictEqual(await saveAndRead(page, boot), FF_SPLIT + '\nOmega.\n', 'one 復原 brings it back: the delete was one step');
}, { md: FF_GUTTER_MD });
check('gutter-settle: ⠿ MD 原始碼 picked while a split above renders waits for it and opens the box on the block it was opened on (R94, L208b, R17)', DESKTOP, async (page, boot) => {
  await delayRender(page, 2500);
  await focusSurface(page, 'Alpha para one.', 5); await page.keyboard.press('Enter'); await wait(100);
  await gutterMenu(page, await blockByText(page, 'Omega.'), 'MD 原始碼');
  await wait(2500); await settleR86(page); await wait(2600); await settleR86(page);
  await page.unroute('**/api/render');
  const rawValue = () => page.evaluate(() => { const t = document.querySelector('textarea.ed-raw'); return t ? t.value : null; });
  // Read before any save: Ctrl+S would resolve the untouched box. The bytes
  // at the end prove nothing else was written.
  assert.deepStrictEqual({ box: await rawValue(), notice: await noticeText(page) },
    { box: 'Omega.', notice: null }, 'the box holds the block it was opened on');
  await page.focus('textarea.ed-raw'); await page.keyboard.press('Control+End'); await page.keyboard.type('X');
  await page.keyboard.press('Control+Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), FF_SPLIT + '\nOmega.X\n');
}, { md: FF_GUTTER_MD });
check('gutter-settle: ⠿ 刪除 picked while a split above renders, on the first of two identical paragraphs, is refused with the notice and deletes nothing; the next 刪除 deletes it (R94, R17, R35)', DESKTOP, async (page, boot) => {
  const SPLIT_TWINS = '# D\n\nAlpha\n\npara one.\n\nTwin.\n\nTwin.\n';
  await delayRender(page, 2500);
  await focusSurface(page, 'Alpha para one.', 5); await page.keyboard.press('Enter'); await wait(100);
  await gutterMenu(page, await guMark(page, 'Twin.'), '刪除');
  await wait(2500); await settleR86(page); await wait(2600); await settleR86(page);
  await page.unroute('**/api/render');
  assert.deepStrictEqual({ notice: await noticeText(page), disk: await saveAndRead(page, boot) },
    { notice: '文件已更新，請重試這個操作', disk: SPLIT_TWINS }, 'refused, nothing deleted');
  await gutterMenu(page, await guMark(page, 'Twin.'), '刪除'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha\n\npara one.\n\nTwin.\n', 'the next 刪除 deletes one of them');
}, { md: '# D\n\nAlpha para one.\n\nTwin.\n\nTwin.\n' });

// R100 (final re-review, named risk (a)): a degraded block (blockquote,
// fenced code) clicked while a split above it renders. The click opened the
// raw box at once, seeded from the stale `blocks` against the new `lines`:
// the box held `Middle.` and its commit wrote over it (measured at a13af72,
// both engines; identical at ffbdd7c). Now the click waits for the render;
// the split's render replaces every block below it, so the click is refused
// with the notice, and the next click opens the block's own lines.
// v3.17.0 T2 (R21): a code block's click opens the in-place edit on its body
// (`seed` is that body), a quote's the raw box; `opened` reads whichever is
// open, so "no box" also means "no code edit".
const openedEditorText = (page) => page.evaluate(() => {
  const t = document.querySelector('textarea.ed-raw');
  if (t) return t.value;
  const h = document.querySelector('pre[data-ed-code-edit]');
  return h ? h.textContent : null;
});
const openedEditorSel = (type) => (type === 'code' ? 'pre[data-ed-code-edit]' : 'textarea.ed-raw');
for (const [label, md, type, seed, typed, want] of [
  ['a quote', '# D\n\nAlpha para one.\n\nMiddle.\n\n> Omega.\n', 'blockquote', '> Omega.', '> NEW', '> NEW'],
  ['a code block', '# D\n\nAlpha para one.\n\nMiddle.\n\n\x60\x60\x60\ncode\n\x60\x60\x60\n', 'code', 'code', 'NEW', '\x60\x60\x60\nNEW\n\x60\x60\x60']]) {
  check('raw-box: ' + label + ' clicked below a split that is still rendering is refused, and the next click edits its own lines (R100)', DESKTOP, async (page, boot) => {
    const clickBlock = async () => {
      const box = await page.locator('.ed-block[data-block-type="' + type + '"]').first().boundingBox();
      assert.ok(box, 'guard: the ' + type + ' block is on screen');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };
    const rawValue = () => openedEditorText(page);
    await delayRender(page, 2500);
    await focusSurface(page, 'Alpha para one.', 5); await page.keyboard.press('Enter'); await wait(100);
    await clickBlock(); await wait(300);
    assert.strictEqual(await rawValue(), null, 'no box opens while the split renders');
    await wait(2500); await settleR86(page);
    assert.deepStrictEqual({ box: await rawValue(), notice: await noticeText(page) },
      { box: null, notice: '文件已更新，請重試這個操作' }, 'the click is refused once the render lands');
    await clickBlock(); await wait(300);
    assert.strictEqual(await rawValue(), seed, 'the next click opens the block\'s own lines');
    await page.focus(openedEditorSel(type)); await page.keyboard.press('Control+a'); await page.keyboard.type(typed);
    await page.keyboard.press('Control+Enter'); await renderIdle(page);
    await page.unroute('**/api/render');
    assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha\n\npara one.\n\nMiddle.\n\n' + want + '\n');
  }, { md });
}

// R102 (final re-review 2, I-R1): the R100 settle let a degraded-block click
// through when the flight ended with a reconciliation owed (the undo's render
// failed and so did the redraw). The quote below the split was still on
// screen, so the box opened seeded from the stale `blocks` against the new
// `lines` — `paragraph text.` — and its second Ctrl+Enter deleted that
// paragraph (measured at 6208f4c, both engines). Now that click is refused;
// the next clicks run the owed redraw and then open the quote's own lines.
check('raw-box: a quote below a split clicked while the undo renders, whose redraw then fails, is refused and writes nothing over another block (R102, I-R1)', DESKTOP, async (page, boot) => {
  const MD = '# D\n\nAlpha para one.\n\nBravo paragraph text.\n\n> Omega.\n';
  const SPLIT = '# D\n\nAlpha para one.\n\nBravo\n\nparagraph text.\n\n';
  const rawValue = () => page.evaluate(() => { const t = document.querySelector('textarea.ed-raw'); return t ? t.value : null; });
  const clickQuote = async () => {
    const box = await page.locator('.ed-block[data-block-type="blockquote"]').first().boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };
  await scriptRenders(page, [300, 2000, 1000], [false, true, true]);
  const t0 = renderTotal(page);
  await focusSurface(page, 'Bravo paragraph text.', 5); await page.keyboard.press('Enter');
  await wait(100); await page.keyboard.press('Control+z');
  await wait(600);
  await clickQuote(); await wait(200);
  await settleR86(page); await wait(300); await settleR86(page);
  assert.strictEqual(renderTotal(page) - t0, 3, 'guard: split, undo, and the redraw that failed');
  assert.deepStrictEqual({ box: await rawValue(), notice: await noticeText(page) },
    { box: null, notice: '文件已更新，請重試這個操作' }, 'refused: no box on the stale screen');
  assert.strictEqual(await saveAndRead(page, boot), SPLIT + '> Omega.\n', 'nothing written');
  let opened = null;
  for (let k = 0; k < 3 && opened === null; k++) { await clickQuote(); await settleR86(page); opened = await rawValue(); }
  assert.strictEqual(opened, '> Omega.', 'a later click opens the quote\'s own lines');
  await page.focus('textarea.ed-raw'); await page.keyboard.press('Control+a'); await page.keyboard.type('> NEW');
  await page.keyboard.press('Control+Enter'); await settleR86(page);
  if (await rawValue() !== null) { await page.focus('textarea.ed-raw'); await page.keyboard.press('Control+Enter'); await settleR86(page); }
  assert.strictEqual(await saveAndRead(page, boot), SPLIT + '> NEW\n', 'the quote is written; paragraph text. survives');
}, { md: '# D\n\nAlpha para one.\n\nBravo paragraph text.\n\n> Omega.\n' });
// R102 (M-R2): the everyday click. Typing in a paragraph and then clicking
// a quote or code block: the paragraph's own commit render replaces the
// block before the click is resolved. With nothing in flight at the press,
// the block's identity is taken then and the block is found again by it, so
// the first click opens it. Measured at 6208f4c: no box, the retry notice.
// v3.17.0 T2: the code block's click opens the in-place edit on its body
// (`seed`), and `want` is what its commit writes.
for (const [label, md, type, seed, typed, want] of [
  ['a quote', '# D\n\nAlpha para one.\n\nMiddle.\n\n> Omega.\n', 'blockquote', '> Omega.', '> NEW', '> NEW'],
  ['a code block', '# D\n\nAlpha para one.\n\nMiddle.\n\n\x60\x60\x60\ncode\n\x60\x60\x60\n', 'code', 'code', 'NEW', '\x60\x60\x60\nNEW\n\x60\x60\x60']]) {
  check('raw-box: ' + label + ' clicked right after typing in a paragraph opens on the first click (R102, M-R2)', DESKTOP, async (page, boot) => {
    await focusSurface(page, 'Alpha para one.', 2); await page.keyboard.type('X');
    const box = await page.locator('.ed-block[data-block-type="' + type + '"]').first().boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await renderIdle(page); await wait(300);
    const raw = await openedEditorText(page);
    assert.deepStrictEqual({ box: raw, notice: await noticeText(page) }, { box: seed, notice: null }, 'the box opened on the first click');
    await page.focus(openedEditorSel(type)); await page.keyboard.press('Control+a'); await page.keyboard.type(typed);
    await page.keyboard.press('Control+Enter'); await renderIdle(page);
    assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlXpha para one.\n\nMiddle.\n\n' + want + '\n');
  }, { md });
}
// R102 (M-R2), the ⠿ entry: the same everyday shape — typing in a paragraph,
// then ⠿ MD 原始碼 on a quote. The paragraph's commit (run by the gesture's
// own switchAwayFrom()) redrew the quote, and R94's settle then refused.
// Measured at 6208f4c: no box, the retry notice, both engines.
check('gutter-settle: ⠿ MD 原始碼 right after typing in another paragraph opens on the first click (R102, M-R2)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha para one.', 2); await page.keyboard.type('X');
  await gutterMenu(page, await blockByText(page, 'Omega.'), 'MD 原始碼');
  await renderIdle(page); await wait(300);
  const raw = await page.evaluate(() => { const t = document.querySelector('textarea.ed-raw'); return t ? t.value : null; });
  assert.deepStrictEqual({ box: raw, notice: await noticeText(page) }, { box: '> Omega.', notice: null }, 'the box opened on the first gesture');
  await page.focus('textarea.ed-raw'); await page.keyboard.press('Control+a'); await page.keyboard.type('> NEW');
  await page.keyboard.press('Control+Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlXpha para one.\n\nMiddle.\n\n> NEW\n');
}, { md: '# D\n\nAlpha para one.\n\nMiddle.\n\n> Omega.\n' });
// R102 (M-R1): the R83 apply-time stash, on the R86 path where it is still
// reachable: the quote above the split opens on the screen a failed
// reconciliation left (its lines read the same there and in `lines`); its
// commit runs the owed redraw (held 1500 ms), and what is typed into the box
// while that redraw is out survives it and is written.
check('render-guard: text typed into a raw box while the redraw its commit started is out survives it (R83, R86 path, R102)', DESKTOP, async (page, boot) => {
  await scriptRenders(page, [300, 2000, 1000, 1500], [false, true, true, false]);
  const t0 = renderTotal(page);
  const rawValue = () => page.evaluate(() => { const t = document.querySelector('textarea.ed-raw'); return t ? t.value : null; });
  await focusSurface(page, 'Bravo paragraph text.', 5); await page.keyboard.press('Enter');
  await wait(100); await page.keyboard.press('Control+z');
  await wait(600);
  await openQuoteBox(page);
  await page.waitForSelector('textarea.ed-raw', { timeout: 10000 });
  await page.focus('textarea.ed-raw'); await page.keyboard.press('End'); await page.keyboard.type(' ab');
  await settleR86(page);
  assert.strictEqual(await rawValue(), '> Alpha para one. ab', 'guard: the box is open on the stale screen');
  await page.focus('textarea.ed-raw'); await page.keyboard.press('Control+Enter');
  const deadline = Date.now() + 8000;
  while (renderTotal(page) - t0 < 4 && Date.now() < deadline) await wait(10);
  assert.strictEqual(renderTotal(page) - t0, 4, 'guard: the redraw the commit started is out');
  await wait(200);
  assert.deepStrictEqual({ box: await rawValue(), focused: await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('ed-raw')) },
    { box: '> Alpha para one. ab', focused: true }, 'guard: the box is open and focused while the redraw is out');
  await page.keyboard.press('End'); await page.keyboard.type(' cd');
  await settleR86(page); await wait(300); await settleR86(page);
  assert.strictEqual(await rawValue(), '> Alpha para one. ab cd', 'what was typed during the redraw survives it');
  assert.strictEqual(await allBlocksHaveIds(page), true, 'every block is a rendered one');
  await page.focus('textarea.ed-raw'); await page.keyboard.press('Control+Enter'); await settleR86(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n> Alpha para one. ab cd\n\nBravo\n\nparagraph text.\n\nOmega.\n');
}, { md: Q3_MD });

// R104 (final re-review 3, I-R2 / M-R4): R102's re-locate matched start line
// + type + source, and R95's removal of an emptied paragraph shifts the
// lines without the shift being logged, so the second of two identical
// quotes landed on the first one's start line and was opened and written
// instead (measured at 63d1bcb, both engines; ⠿ MD 原始碼 there opened
// nothing and said nothing). Now a block found again by content must be the
// ONLY block of its type with that source: uniqueness is the proof of
// position. Two identical quotes → refused with the notice; one → it opens.
const ffNthBox = async (page, type, nth) => {
  const box = await page.locator('.ed-block[data-block-type="' + type + '"]').nth(nth).boundingBox();
  assert.ok(box, 'guard: ' + type + ' #' + nth);
  return box;
};
const ffRaw = (page) => page.evaluate(() => { const t = document.querySelector('textarea.ed-raw'); return t ? t.value : null; });
const ffGutterNth = async (page, type, nth, label) => {
  const sel = await page.evaluate(([t, n]) => {
    const q = document.querySelectorAll('.content .ed-block[data-block-type="' + t + '"]')[n];
    q.setAttribute('data-ff-gut', '1'); return '[data-ff-gut="1"]';
  }, [type, nth]);
  await gutterMenu(page, sel, label);
};
for (const via of ['click', '⠿ MD 原始碼']) {
  check('raw-box: after emptying the paragraph above, ' + via + ' on the first of two identical quotes is refused and writes nothing (R104, I-R2)', DESKTOP, async (page, boot) => {
    await focusSurface(page, 'Alpha.', 6);
    for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
    if (via === 'click') { const b = await ffNthBox(page, 'blockquote', 0); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); }
    else await ffGutterNth(page, 'blockquote', 0, 'MD 原始碼');
    await settleR86(page);
    assert.deepStrictEqual({ box: await ffRaw(page), notice: await noticeText(page), disk: await saveAndRead(page, boot) },
      { box: null, notice: '文件已更新，請重試這個操作', disk: '# D\n\n> Q\n\n> Q\n\nEnd.\n' });
  }, { md: '# D\n\nAlpha.\n\n> Q\n\n> Q\n\nEnd.\n' });
  check('raw-box: after emptying the paragraph above, ' + via + ' on a quote that is the only one opens it on the first try (R104, I-R2)', DESKTOP, async (page, boot) => {
    await focusSurface(page, 'Alpha.', 6);
    for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
    if (via === 'click') { const b = await ffNthBox(page, 'blockquote', 0); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); }
    else await ffGutterNth(page, 'blockquote', 0, 'MD 原始碼');
    await settleR86(page);
    assert.deepStrictEqual({ box: await ffRaw(page), notice: await noticeText(page) }, { box: '> Q', notice: null }, 'the box opened on the quote');
    await page.focus('textarea.ed-raw'); await page.keyboard.press('Control+a'); await page.keyboard.type('> NEW');
    await page.keyboard.press('Control+Enter'); await settleR86(page);
    assert.strictEqual(await saveAndRead(page, boot), '# D\n\n> NEW\n\nEnd.\n');
  }, { md: '# D\n\nAlpha.\n\n> Q\n\nEnd.\n' });
}
// v3.17.0 T9a (M-R5, R35): the ⠿ actions take R104's rule too. Their
// re-find matched start line + type + source, so after R95's unlogged
// removal of the emptied paragraph above, the SECOND `Twin.` sat on the
// first one's start line and was the one deleted, converted or copied; and
// a paragraph that is the only one with its text was refused, its start line
// having moved. Now a block whose node was redrawn is found again only when
// it is the one block of its type with that source: two identical paragraphs
// → refused with the notice, nothing written but the emptied paragraph's own
// removal; one → acted on the first try. (R35 states the cost: a gesture on
// a block with an identical twin needs a second try.)
const guMark = (page, text) => page.evaluate((t) => {
  const p = [...document.querySelectorAll('.content .ed-block[data-block-type="paragraph"]')].find((b) => b.textContent.trim() === t);
  p.setAttribute('data-gu', '1'); return '[data-gu="1"]';
}, text);
for (const [op, path, oneWant] of [
  ['刪除', '刪除', '# D\n\nEnd.\n'],
  ['轉換 標題 1', ['轉換成', '標題 1'], '# D\n\n# Only.\n\nEnd.\n'],
  ['建立副本', '建立副本', '# D\n\nOnly.\n\nOnly.\n\nEnd.\n'],
]) {
  check('gutter-unique: after emptying the paragraph above, ⠿ ' + op + ' on the first of two identical paragraphs is refused and writes nothing (M-R5)', DESKTOP, async (page, boot) => {
    await focusSurface(page, 'Alpha.', 6);
    for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
    await gutterMenu(page, await guMark(page, 'Twin.'), path);
    await settleR86(page);
    assert.deepStrictEqual({ notice: await noticeText(page), disk: await saveAndRead(page, boot) },
      { notice: '文件已更新，請重試這個操作', disk: '# D\n\nTwin.\n\nTwin.\n\nEnd.\n' });
  }, { md: '# D\n\nAlpha.\n\nTwin.\n\nTwin.\n\nEnd.\n' });
  check('gutter-unique: after emptying the paragraph above, ⠿ ' + op + ' on a unique paragraph acts on the first try (M-R5)', DESKTOP, async (page, boot) => {
    await focusSurface(page, 'Alpha.', 6);
    for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
    await gutterMenu(page, await guMark(page, 'Only.'), path);
    await settleR86(page);
    assert.deepStrictEqual({ notice: await noticeText(page), disk: await saveAndRead(page, boot) },
      { notice: null, disk: oneWant });
  }, { md: '# D\n\nAlpha.\n\nOnly.\n\nEnd.\n' });
}
// v3.17.0 T9a (M-f, L146): a raw box left with its own key put its node back
// and focus went to BODY with it, so the next key landed nowhere. The caret
// now goes on to the block right below (here `Omega.`, at its start). Read in
// the page: what holds focus, and its text when it sits in a block.
const focusAfterLeave = (page) => page.evaluate(() => {
  const a = document.activeElement;
  const b = a && a.closest ? a.closest('.ed-block') : null;
  return { tag: a ? a.tagName : null, armed: !!a && !!a.classList && a.classList.contains('ed-wys-armed'),
    transient: !!b && b.hasAttribute('data-ed-transient'), text: b ? a.textContent : null };
});
for (const [key, want] of [['Escape', '>'], ['Control+Enter', '> Q']]) {
  check('raw-box: ' + (key === 'Escape' ? 'Esc' : 'Ctrl+Enter') + ' out of a quote box leaves the caret in the next paragraph (M-f)', DESKTOP, async (page, boot) => {
    await newParaBelowAlpha(page);
    await page.keyboard.type('> '); await renderIdle(page);
    assert.deepStrictEqual(await rawBox(page), { value: '> ', caret: 2, focused: true }, 'guard: the quote box is open');
    await page.keyboard.type('Q'); await page.keyboard.press(key); await renderIdle(page);
    assert.deepStrictEqual(await focusAfterLeave(page), { tag: 'P', armed: true, transient: false, text: 'Omega.' });
    await page.keyboard.type('z');
    assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n' + want + '\n\nzOmega.\n');
  }, { md: BASE_MD });
}
// T9a fix round 1 (C1): the gesture's own commit rewrites the block it names
// (typed into, then ⠿ / ＋ / 🖼 / a drop onto it), so its identity's source
// can only belong to ANOTHER block afterwards. A content match then found the
// identical twin and acted on it (the review's chain). In that self session
// the block is the one at its start line (reresolveBlockElAfterSelfCommit()),
// never a content match. Each row asserts the exact file: the twin `Twin.`
// is untouched.
const GU_SELF_MD = '# D\n\nTwin.\n\nTwin.\n\nEnd.\n';
for (const [op, path, want] of [
  ['刪除', '刪除', '# D\n\nTwin.\n\nEnd.\n'],
  ['轉換 標題 1', ['轉換成', '標題 1'], '# D\n\n# Twin.X\n\nTwin.\n\nEnd.\n'],
  ['建立副本', '建立副本', '# D\n\nTwin.X\n\nTwin.X\n\nTwin.\n\nEnd.\n'],
]) {
  check('gutter-unique: after typing into the first of two identical paragraphs, ⠿ ' + op + ' acts on that paragraph, not its twin (M-R5, C1)', DESKTOP, async (page, boot) => {
    await focusSurface(page, 'Twin.', 5); await page.keyboard.type('X');
    await gutterMenu(page, await guMark(page, 'Twin.X'), path);
    await settleR86(page);
    assert.deepStrictEqual({ notice: await noticeText(page), disk: await saveAndRead(page, boot) }, { notice: null, disk: want });
  }, { md: GU_SELF_MD });
}
check('gutter-unique: after typing into the first of two identical paragraphs, ＋ on it opens the new paragraph below it, not below its twin (M-R5, C1)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Twin.', 5); await page.keyboard.type('X');
  await plusClick(page, 'Twin.X'); await settleR86(page);
  await page.keyboard.type('new');
  assert.strictEqual(await noticeText(page), null, 'no notice');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nTwin.X\n\nnew\n\nTwin.\n\nEnd.\n');
}, { md: GU_SELF_MD });
check('gutter-unique: after typing into the first of two identical paragraphs, the toolbar 🖼 inserts below it, not below its twin (M-R5, C1)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Twin.', 5); await page.keyboard.type('X');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-ed-tb="image"]')]);
  await pickImage(page, chooser); await settleR86(page);
  assert.strictEqual(await noticeText(page), null, 'no notice');
  const disk = await saveAndRead(page, boot);
  assert.ok(/^# D\n\nTwin\.X\n\n!\[\]\(assets\/dot(-\d+)?\.png\)\n\nTwin\.\n\nEnd\.\n$/.test(disk), 'file: ' + JSON.stringify(disk));
}, { md: GU_SELF_MD });
check('gutter-unique: after typing into the first of two identical paragraphs, a block dropped onto it lands above it, not above its twin (M-R5, C1)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Twin.', 5); await page.keyboard.type('X');
  await dragBlock(page, 'End.', 'Twin.X'); await settleR86(page);
  assert.strictEqual(await noticeText(page), null, 'no notice');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nEnd.\n\nTwin.X\n\nTwin.\n');
}, { md: GU_SELF_MD });
// T9a fix round 2 (R64): the gesture's own commit is R95's removal of the
// emptied paragraph, so the block is gone; its start line now names `Beta.`,
// which the self-commit re-find (start line + type) used to act on (measured
// at 22a60e5 and 219754b: ⠿ 刪除 left `# D\n\nEnd.\n`). Now that re-find
// answers "removed": 刪除 is already done (nothing more, no notice); every
// other gesture writes nothing more and shows the retry notice.
const GONE_MD = '# D\n\nAlpha.\n\nBeta.\n\nEnd.\n';
const r64Empty = async (page) => {
  await focusSurface(page, 'Alpha.', 6);
  for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
  return page.evaluate(() => { const b = document.activeElement.closest('.ed-block'); b.setAttribute('data-r64', '1'); return '[data-r64="1"]'; });
};
check('gutter-unique: ⠿ 刪除 on a paragraph just emptied removes only it, and says nothing (T9a R64)', DESKTOP, async (page, boot) => {
  await gutterMenu(page, await r64Empty(page), '刪除'); await settleR86(page);
  assert.deepStrictEqual({ notice: await noticeText(page), disk: await saveAndRead(page, boot) },
    { notice: null, disk: '# D\n\nBeta.\n\nEnd.\n' });
}, { md: GONE_MD });
for (const [op, path] of [['轉換 標題 1', ['轉換成', '標題 1']], ['建立副本', '建立副本']]) {
  check('gutter-unique: ⠿ ' + op + ' on a paragraph just emptied is refused with the notice and touches the paragraph below nothing (T9a R64)', DESKTOP, async (page, boot) => {
    await gutterMenu(page, await r64Empty(page), path); await settleR86(page);
    assert.deepStrictEqual({ notice: await noticeText(page), disk: await saveAndRead(page, boot) },
      { notice: '文件已更新，請重試這個操作', disk: '# D\n\nBeta.\n\nEnd.\n' });
  }, { md: GONE_MD });
}
check('gutter-unique: ＋ on a paragraph just emptied is refused with the notice and opens nothing below the paragraph below (T9a R64)', DESKTOP, async (page, boot) => {
  const sel = await r64Empty(page);
  await page.hover(sel); await wait(150);
  const box = await page.locator(sel + ' > .ed-insert').boundingBox();
  assert.ok(box, 'guard: the emptied paragraph has its ＋');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await settleR86(page);
  // The one transient is where `Alpha.` was: its emptied paragraph, which R95
  // keeps as a transient while focus stays in it (the ＋ press keeps focus).
  // None opened below `Beta.`.
  assert.deepStrictEqual({ notice: await noticeText(page), blocks: await blockList(page), disk: await saveAndRead(page, boot) },
    { notice: '文件已更新，請重試這個操作', blocks: ['heading:D', '~paragraph:', 'paragraph:Beta.', 'paragraph:End.'], disk: '# D\n\nBeta.\n\nEnd.\n' });
}, { md: GONE_MD });
// T9a fix round 1 (I1, R35): an image insert whose anchor a render replaced
// while the picker was open, with an identical twin, is refused with the
// retry notice (it used to say there was nowhere to insert), and nothing is
// uploaded or written but what the render itself committed.
check('gutter-unique: the toolbar 🖼 whose anchor was redrawn while the picker was open, with an identical twin, is refused with the retry notice (M-R5, I1)', DESKTOP, async (page, boot) => {
  let uploads = 0;
  page.on('request', (r) => { try { if (new URL(r.url()).pathname === '/api/asset') uploads++; } catch (e) { /* ignore */ } });
  await focusSurface(page, 'Twin.', 5);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-ed-tb="image"]')]);
  await focusSurface(page, 'Alpha.', 6);
  for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await settleR86(page);
  assert.strictEqual(await saveAndRead(page, boot), GU_SELF_MD, 'guard: the emptied paragraph is gone');
  await chooser.setFiles({ name: 'dot.png', mimeType: 'image/png', buffer: Buffer.from(PNG_1PX, 'base64') });
  await wait(600); await settleR86(page);
  assert.deepStrictEqual({ notice: await noticeText(page), uploads, disk: await saveAndRead(page, boot) },
    { notice: '文件已更新，請重試這個操作', uploads: 0, disk: GU_SELF_MD });
}, { md: '# D\n\nAlpha.\n\nTwin.\n\nTwin.\n\nEnd.\n' });
// T9a fix round 1 (M2): handCaretOnBelow()'s other two branches. (a) The
// block below takes no caret (a code block): the caret goes into a new
// paragraph between the two, which writes nothing until typed into. (b) A
// leave that discards an untouched insert: the span it ends is gone, and the
// caret goes to what follows it (`Omega.`); the file is unchanged.
check('raw-box: Ctrl+Enter out of a quote box above a code block leaves the caret in a new paragraph between them (M-f, M2)', DESKTOP, async (page, boot) => {
  await newParaBelowAlpha(page);
  await page.keyboard.type('> '); await renderIdle(page);
  await page.keyboard.type('Q'); await page.keyboard.press('Control+Enter'); await renderIdle(page);
  assert.deepStrictEqual(await focusAfterLeave(page), { tag: 'P', armed: true, transient: true, text: '' });
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', 'blockquote:Q', '~paragraph:', 'code:code'], 'the new paragraph sits between the quote and the code');
  await page.keyboard.type('z');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n> Q\n\nz\n\n```\ncode\n```\n');
}, { md: '# D\n\nAlpha.\n\n```\ncode\n```\n' });
check('code-edit: Esc out of an untouched "/" 程式碼 insert discards it and hands the caret to the paragraph below (M-f, M2)', DESKTOP, async (page, boot) => {
  await newParaBelowAlpha(page);
  await page.keyboard.type('/code'); await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await codeEdit(page), { text: '', caret: 0, focused: true }, 'guard: the insert opened the edit');
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.content .ed-block[data-block-type="code"]').length), 0, 'the insert is gone');
  assert.strictEqual(fs.readFileSync(boot.mdPath, 'utf8'), BASE_MD, 'the file is unchanged');
  assert.deepStrictEqual(await focusAfterLeave(page), { tag: 'P', armed: true, transient: false, text: 'Omega.' });
  await page.keyboard.type('z');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\nzOmega.\n');
}, { md: BASE_MD });
// R104 (I-R3): the R80 stash reopen after a forced redraw, with two identical
// quotes in the R86 failure order. The click on the SECOND quote opens (its
// lines read the same on screen and in `lines`, by coincidence); its commit
// runs the owed redraw, and the box was reopened on the FIRST quote (same id,
// start line and source) and its next commit wrote there (measured at
// 63d1bcb, identical back to a13af72). Now the reopen needs a unique match:
// with two `> Q`, no box reopens and the text goes to the failure card.
check('render-guard: a raw box reopened after a forced redraw needs a unique block; two identical quotes put its text on the card, not on the other quote (R104, I-R3)', DESKTOP, async (page, boot) => {
  await scriptRenders(page, [300, 2000, 1000], [false, true, true]);
  await focusSurface(page, 'Bravo para.', 5); await page.keyboard.press('Enter');
  await wait(100); await page.keyboard.press('Control+z');
  await wait(600);
  const b = await ffNthBox(page, 'blockquote', 1); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await wait(200);
  await settleR86(page); await wait(300); await settleR86(page);
  assert.strictEqual(await ffRaw(page), '> Q', 'guard: the box opened on the stale screen');
  await page.focus('textarea.ed-raw'); await page.keyboard.press('Control+a'); await page.keyboard.type('> NEW');
  await page.keyboard.press('Control+Enter'); await settleR86(page);
  const notice = await noticeText(page);
  assert.deepStrictEqual({ box: await ffRaw(page), textOnCard: !!notice && notice.indexOf('「> NEW」') !== -1 },
    { box: null, textOnCard: true }, 'no box reopened on a guessed quote; the text is on the card: ' + notice);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha para one.\n\nBravo\n\npara.\n\n> Q\n\n> Q\n', 'nothing written to either quote');
}, { md: '# D\n\nAlpha para one.\n\nBravo para.\n\n> Q\n\n> Q\n' });

// R95 (I3, L130): a real paragraph emptied and left commits as its removal
// (one op), never as a `<br>` line. Measured at ffbdd7c: `<br>` on disk.
const FF_EMPTY_MD = '# D\n\nAlpha.\n\nOmega.\n\nZulu.\n';
const ffEmptyOmega = {
  'Backspace ×6': async (page) => { for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace'); },
  'Shift+Home then Delete': async (page) => {
    await page.keyboard.down('Shift'); await page.keyboard.press('Home'); await page.keyboard.up('Shift');
    await page.keyboard.press('Delete');
  },
};
for (const [how, act] of Object.entries(ffEmptyOmega)) {
  check('emptied-para: a paragraph emptied by ' + how + ' and left is removed, no <br>, one undo step (R95)', DESKTOP, async (page, boot) => {
    await focusSurface(page, 'Omega.', 6);
    await act(page); await wait(200);
    assert.strictEqual(await page.evaluate(() => document.activeElement.textContent), '', 'guard: the surface is empty');
    await page.locator('.ed-block[data-block-type="heading"] .ed-wys-armed').click(); await renderIdle(page);
    assert.deepStrictEqual(await paragraphs(page), ['Alpha.', 'Zulu.'], 'screen = file');
    assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\nZulu.\n');
    await page.evaluate(() => document.activeElement && document.activeElement.blur()); await renderIdle(page);
    await page.keyboard.press('Control+z'); await renderIdle(page);
    assert.strictEqual(await saveAndRead(page, boot), FF_EMPTY_MD, 'one Ctrl+Z brings it back');
  }, { md: FF_EMPTY_MD });
}
check('emptied-para: Ctrl+S in an emptied paragraph writes no <br> and keeps the caret there (R95)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Omega.', 6);
  for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
  await wait(200);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\nZulu.\n');
  await renderIdle(page);
  await page.keyboard.type('Q');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\nQ\n\nZulu.\n');
}, { md: FF_EMPTY_MD });
// v3.17.0 T10 (N4): the transient Ctrl+S leaves in an emptied paragraph's
// place belongs to the removal, so the first Ctrl+Z brings the paragraph back
// (it used to drop the transient and change nothing; the second Ctrl+Z then
// restored it).
check('emptied-para: the first Ctrl+Z after an emptied paragraph is removed brings it back (N4)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Omega.', 6);
  for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
  await wait(200);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\nZulu.\n', 'guard: the removal is saved');
  await renderIdle(page);
  assert.strictEqual(await transientCount(page), 1, 'guard: the transient is up');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.deepStrictEqual({ paras: await paragraphs(page), transients: await transientCount(page) },
    { paras: ['Alpha.', 'Omega.', 'Zulu.'], transients: 0 });
  assert.strictEqual(await saveAndRead(page, boot), FF_EMPTY_MD);
}, { md: FF_EMPTY_MD });

// R96 (I4): the "/" menu is not re-filtered while an IME composes; the
// committed text filters it. Measured at ffbdd7c: ＋'s menu closed at the
// first composition keystroke. Chromium only (CDP drives the composition).
check('slash: ＋\'s menu stays open through an IME composition and filters on its commit (R96)', DESKTOP, async (page) => {
  await plusClick(page, 'Alpha.'); await wait(200);
  const m0 = await slashMenu(page);
  assert.deepStrictEqual([m0.open, m0.labels.length], [true, 16], 'guard: the menu is open on all 16 items');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'ㄅ', selectionStart: 1, selectionEnd: 1 });
  await wait(150);
  const m1 = await slashMenu(page);
  await cdp.send('Input.imeSetComposition', { text: 'ㄅㄧㄠˇ', selectionStart: 4, selectionEnd: 4 });
  await wait(150);
  const m2 = await slashMenu(page);
  await cdp.send('Input.insertText', { text: '表' });
  await wait(300);
  const m3 = await slashMenu(page);
  assert.deepStrictEqual({ m1: [m1.open, m1.labels.length], m2: [m2.open, m2.labels.length], m3: [m3.open, m3.labels] },
    { m1: [true, 16], m2: [true, 16], m3: [true, ['表格']] });
}, { md: '# D\n\nAlpha.\n\nOmega.\n', engines: ['chromium'] });
check('slash: after "/" an IME composition keeps the list until its commit, which filters it (R96)', DESKTOP, async (page) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('/'); await wait(150);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'ㄅ', selectionStart: 1, selectionEnd: 1 });
  await wait(150);
  const m1 = await slashMenu(page);
  await cdp.send('Input.insertText', { text: '表' });
  await wait(300);
  const m2 = await slashMenu(page);
  assert.deepStrictEqual({ m1: [m1.open, m1.labels.length, m1.empty], m2: [m2.open, m2.labels] },
    { m1: [true, 16, null], m2: [true, ['表格']] });
}, { md: '# D\n\nAlpha.\n\nOmega.\n', engines: ['chromium'] });

// R97 (I5, R75): the bottom add bar stops above the block under the table:
// its height is the gap, clamped to 8–22 px, and 22 px with nothing below.
// Measured at ffbdd7c: the 22 px bar covered the next paragraph's first text
// line, so a click there added a row.
const ffNextLineHits = (page) => page.evaluate(() => {
  const next = [...document.querySelectorAll('.ed-block')].find((b) => b.textContent.trim() === 'After.');
  const surf = next.querySelector('.ed-wys-armed');
  const range = document.createRange(); range.selectNodeContents(surf);
  const line = range.getClientRects()[0];
  const x = line.left + 3;
  return [line.top + 0.5, (line.top + line.bottom) / 2, line.bottom - 0.5].map((y) => {
    const hit = document.elementFromPoint(x, y);
    return !!hit && !!hit.closest && hit.closest('.ed-block') === next;
  });
});
check('table-bar: the bottom bar never covers the first line of the block under the table (R97)', DESKTOP, async (page) => {
  await hoverFirstBodyCell(page);
  const b = await addBars(page);
  assert.strictEqual(b.row.shown, true, 'guard: the bar is up');
  const nextTop = await page.evaluate(() => [...document.querySelectorAll('.ed-block')].find((x) => x.textContent.trim() === 'After.').getBoundingClientRect().top);
  assert.ok(b.row.b <= nextTop, 'the bar ends above the next block ' + JSON.stringify({ row: b.row, nextTop }));
  assert.deepStrictEqual(await ffNextLineHits(page), [true, true, true], 'the next paragraph answers its first text line');
  await clickAddBar(page, 'row');
  assert.strictEqual(await tbodyRowCount(page), 3, 'the bar still adds a row');
}, { md: TBL_MD });
check('table-bar: with nothing under the table the bottom bar is 22 px (R97)', DESKTOP, async (page) => {
  await hoverFirstBodyCell(page);
  const b = await addBars(page);
  assert.deepStrictEqual([b.row.shown, b.row.h], [true, 22]);
}, { md: '# D\n\n| A | B |\n|---|---|\n| a1 | b1 |\n| a2 | b2 |\n' });

// R98 (M-b): 開啟 opens http(s) and mailto only; `#…` scrolls in place;
// anything else (a relative path, javascript:) gets a notice and never
// reaches window.open.
const FF_OPEN_MD = '# D\n\nGo [web](https://a.example/) now.\n\nRun [js](javascript:alert(1)) now.\n\nSee [rel](./x.md) now.\n\nJump [sec](#far) now.\n\n' + Array.from({ length: 40 }, (_, i) => 'Filler ' + i + '.\n\n').join('') + '## Far\n\n' + Array.from({ length: 30 }, (_, i) => 'Tail ' + i + '.\n\n').join('') + 'End.\n';
for (const [label, surface, wantOpen] of [
  ['https opens', 'Go web now.', 'https://a.example/'],
  ['javascript: never reaches window.open', 'Run js now.', null],
  ['a relative path does not open', 'See rel now.', null],
  ['#… does not open a tab', 'Jump sec now.', null]]) {
  check('link-card: 開啟 — ' + label + ' (R98)', DESKTOP, async (page) => {
    await page.evaluate(() => { window.__ffOpened = []; window.open = (u) => { window.__ffOpened.push(String(u)); return null; }; });
    const href = await page.evaluate((s) => { const el = [...document.querySelectorAll('.ed-wys-armed')].find((e) => e.textContent === s); const a = el && el.querySelector('a'); return a ? a.getAttribute('href') : null; }, surface);
    assert.ok(href, 'guard: the link is on screen with an href');
    await focusSurface(page, surface, surface.indexOf(' ') + 2); await wait(450);
    assert.strictEqual((await linkCard(page)).open, true, 'guard: the card is up');
    await page.click('.ed-linkcard button:has-text("開啟")'); await wait(300);
    const opened = await page.evaluate(() => window.__ffOpened);
    assert.deepStrictEqual(opened, wantOpen ? [wantOpen] : []);
    if (!wantOpen && href.charAt(0) !== '#') assert.ok(await noticeText(page), 'a notice says why nothing opened');
    if (href.charAt(0) === '#') {
      const top = await page.evaluate(() => { const h = document.getElementById('far'); return h ? h.getBoundingClientRect().top : null; });
      assert.ok(top !== null && top >= -1 && top < 300, 'the page scrolled to #far: ' + top);
    }
  }, { md: FF_OPEN_MD });
}

// ── code-edit (v3.17.0 T2): a fenced code block edits in place ──
const CODE_MD = '# D\n\nAlpha.\n\n```verilog\nmodule m;\nendmodule\n```\n\nOmega.\n';
// Clicks the start or the end of `text`, which must sit inside one text node
// under `.content`: the point is read from a Range over its first or last
// character, and the element the browser hit-tests there must belong to the
// same block (never a rectangle guess about what was pressed).
async function clickText(page, text, where = 'end') {
  const pt = await page.evaluate(([t, w]) => {
    const root = document.querySelector('.content');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.indexOf(t);
      if (i === -1) continue;
      n.parentElement.scrollIntoView({ block: 'center' });
      const r = document.createRange();
      const at = w === 'start' ? i : i + t.length - 1;
      r.setStart(n, at); r.setEnd(n, at + 1);
      const b = r.getBoundingClientRect();
      const x = w === 'start' ? b.left + 1 : b.right - 1;
      const y = b.top + b.height / 2;
      const block = n.parentElement.closest('.ed-block');
      const hit = document.elementFromPoint(x, y);
      return { x, y, same: !!(block && hit && block.contains(hit)), hit: hit ? hit.nodeName + '.' + hit.className : null };
    }
    return null;
  }, [text, where]);
  assert.ok(pt, 'clickText: no text node holds ' + JSON.stringify(text));
  assert.ok(pt.same, 'clickText: the point over ' + JSON.stringify(text) + ' hits ' + pt.hit + ', not its block');
  await page.mouse.click(pt.x, pt.y);
}
check('code-edit: a click edits in place with no fence on screen', DESKTOP, async (page) => {
  await clickText(page, 'endmodule');
  const s = await page.evaluate(() => {
    const h = document.querySelector('pre[data-ed-code-edit]');
    return {
      raw: document.querySelectorAll('textarea.ed-raw').length,
      ce: h ? h.getAttribute('contenteditable') : null,
      text: h ? h.textContent : null,
      active: !!(document.activeElement && document.activeElement.matches('pre[data-ed-code-edit]')),
      fence: document.querySelector('.content').textContent.indexOf('```') !== -1,
    };
  });
  assert.ok(['plaintext-only', 'true'].includes(s.ce), 'editable: ' + s.ce);
  assert.deepStrictEqual({ raw: s.raw, text: s.text, active: s.active, fence: s.fence },
    { raw: 0, text: 'module m;\nendmodule', active: true, fence: false });
  assert.deepStrictEqual(await codeEdit(page), { text: 'module m;\nendmodule', caret: 19, focused: true }, 'the caret is where the click was');
}, { md: CODE_MD });
check('code-edit: typing re-colours within 300 ms and Esc writes the file', DESKTOP, async (page, boot) => {
  await clickText(page, 'endmodule');
  // A re-colour rewrites the host's own children, never the host: no focus
  // event at all (the detach census row for it rests on this).
  await page.evaluate(() => { window.__codeFocusouts = 0; document.addEventListener('focusout', () => { window.__codeFocusouts++; }, true); });
  await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.type('wire w;');
  await wait(450);
  const s = await page.evaluate(() => {
    const h = document.querySelector('pre[data-ed-code-edit]');
    return { wire: !!h && [...h.querySelectorAll('.hljs-keyword')].some((k) => k.textContent === 'wire'),
      active: !!h && document.activeElement === h, focusouts: window.__codeFocusouts, text: h ? h.textContent : null };
  });
  assert.deepStrictEqual(s, { wire: true, active: true, focusouts: 0, text: 'module m;\nendmodule\nwire w;' });
  assert.strictEqual((await codeEdit(page)).caret, 27, 'the caret stays at the end across the re-colour');
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.strictEqual(await codeEdit(page), null, 'Esc closed the edit');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n```verilog\nmodule m;\nendmodule\nwire w;\n```\n\nOmega.\n');
}, { md: CODE_MD });
check('code-edit: Enter keeps the indent, Tab and Shift+Tab indent the selected lines', DESKTOP, async (page, boot) => {
  await clickText(page, 'module', 'start');
  assert.strictEqual((await codeEdit(page) || {}).caret, 0, 'guard: the caret is at the start');
  await page.keyboard.press('Tab');
  assert.deepStrictEqual(await codeEdit(page), { text: '  module m;\nendmodule', caret: 2, focused: true });
  await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.type('x');
  assert.deepStrictEqual(await codeEdit(page), { text: '  module m;\n  x\nendmodule', caret: 15, focused: true });
  await page.keyboard.press('Control+a'); await page.keyboard.press('Tab');
  assert.strictEqual((await codeEdit(page)).text, '    module m;\n    x\n  endmodule');
  await page.keyboard.press('Shift+Tab');
  assert.strictEqual((await codeEdit(page)).text, '  module m;\n  x\nendmodule');
  await page.keyboard.press('Shift+Tab');
  assert.strictEqual((await codeEdit(page)).text, 'module m;\nx\nendmodule');
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n```verilog\nmodule m;\nx\nendmodule\n```\n\nOmega.\n');
}, { md: CODE_MD });
// Polls the open code edit until it is open and focused (or 5 s pass) and
// returns what it last read; the caller asserts it (diskUntil's shape).
// T9b, measured: after typing in a paragraph, the click on the code block
// opens the edit only once the paragraph's commit has settled — about 60 ms
// after that render's response at 6x CPU throttling, later than
// renderIdle()'s one macrotask and two frames. A single read after
// renderIdle() then saw no edit: this check's red under suite load (T7, T9a),
// 29 of 30 repeats at 6x throttling and 0 of 10 once the read waited.
async function codeEditUntil(page) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const s = await codeEdit(page);
    if ((s && s.focused) || Date.now() > deadline) return s;
    await wait(50);
  }
}
check('code-edit: Ctrl+Z inside the edit steps its own typing and never touches the file', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.type('X');
  await clickText(page, 'endmodule'); await renderIdle(page);
  assert.strictEqual((await codeEditUntil(page) || {}).focused, true, 'guard: the edit is open');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('x'); await wait(400); await page.keyboard.type('y'); await wait(400);
  const text = async () => (await codeEdit(page)).text;
  assert.strictEqual(await text(), 'module m;\nendmodulexy');
  await page.keyboard.press('Control+z');
  assert.strictEqual(await text(), 'module m;\nendmodulex');
  await page.keyboard.press('Control+z');
  assert.strictEqual(await text(), 'module m;\nendmodule');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await text(), 'module m;\nendmodule', 'nothing left inside: the text stays');
  assert.strictEqual(await page.evaluate(() => [...document.querySelectorAll('.ed-wys-armed')].some((e) => e.textContent === 'Alpha.X')),
    true, 'the paragraph keeps its edit: the document stack was not touched');
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.X\n\n```verilog\nmodule m;\nendmodule\n```\n\nOmega.\n');
}, { md: CODE_MD });
check('code-edit: one Ctrl+Z after leaving restores the block', DESKTOP, async (page, boot) => {
  await clickText(page, 'endmodule');
  await page.keyboard.type('zz'); await wait(400); await page.keyboard.press('Enter'); await page.keyboard.type('q');
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), CODE_MD.replace('endmodule', 'endmodulezz\nq'), 'guard: the edit landed');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), CODE_MD);
}, { md: CODE_MD });
// v3.17.0 T10 (L95b): the toolbar button inside an open code edit is the
// edit's own Ctrl+Z, never a commit followed by an undo of the whole edit.
check('code-edit: toolbar 復原 steps the edit\'s own typing and never commits (L95b)', DESKTOP, async (page, boot) => {
  await clickText(page, 'endmodule'); await page.keyboard.press('Control+End');
  await page.keyboard.type('x'); await wait(400); await page.keyboard.type('y'); await wait(400);
  const before = renderTotal(page);
  await page.click('[data-ed-tb="undo"]'); await wait(300);
  assert.deepStrictEqual({ edit: await codeEdit(page), renders: renderTotal(page) - before, disk: fs.readFileSync(boot.mdPath, 'utf8') },
    { edit: { text: 'module m;\nendmodulex', caret: 20, focused: true }, renders: 0, disk: CODE_MD });
  await page.click('[data-ed-tb="undo"]'); await wait(300);
  assert.strictEqual((await codeEdit(page) || {}).text, 'module m;\nendmodule', 'a second press steps once more');
  await page.click('[data-ed-tb="undo"]'); await wait(300);
  assert.deepStrictEqual({ text: (await codeEdit(page) || {}).text, renders: renderTotal(page) - before }, { text: 'module m;\nendmodule', renders: 0 },
    'nothing left inside: the edit stays open and the file is not reached');
}, { md: CODE_MD });
check('code-edit: leaving unchanged writes nothing and adds no undo step', DESKTOP, async (page, boot) => {
  const before = renderTotal(page);
  await clickText(page, 'endmodule'); await page.keyboard.press('Escape'); await renderIdle(page);
  const s = await page.evaluate(() => ({
    editable: !!document.querySelector('pre[data-ed-code-edit], pre[contenteditable]'),
    status: document.querySelector('.ed-toolbar-status').getAttribute('data-state'),
    title: document.title.charAt(0) === '●',
  }));
  assert.deepStrictEqual(Object.assign(s, { renders: renderTotal(page) - before }), { editable: false, status: 'clean', title: false, renders: 0 });
  assert.strictEqual(fs.readFileSync(boot.mdPath, 'utf8'), CODE_MD);
  // The next Ctrl+Z undoes the edit made before the visit, so the visit
  // pushed nothing on top of it. The paragraph is committed by Ctrl+S first
  // rather than by the press on the code block: a press whose blur-commit
  // render lands before the button comes up used to lose its click (the race
  // wireBlockSelection()'s comment measures) — measured once here under a
  // full-suite load, never in six isolated runs. T9b (R50) fixed that race
  // (pinned by the degraded-press: checks); the Ctrl+S step stays as the T2
  // pin, per R50.
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.type('X');
  await page.keyboard.press('Control+s'); await renderIdle(page);
  assert.strictEqual(await saveStateUntil(page, 'clean'), 'clean', 'guard: the paragraph edit is committed and saved');
  await clickText(page, 'endmodule'); await renderIdle(page);
  assert.strictEqual((await codeEdit(page) || {}).focused, true, 'guard: the edit is open');
  await page.keyboard.press('Escape'); await renderIdle(page);
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), CODE_MD);
}, { md: CODE_MD });
// v3.17.0 T9a (M-f, Task 2 deferral): leaving the edit with its own key took
// the editing attributes off the focused host, and focus went to BODY. The
// caret goes on to the paragraph below (at its start), for every leave: Esc
// and Ctrl+Enter after typing, and Esc with nothing changed (the cancel path).
for (const [name, typed, key] of [['Esc', 'x', 'Escape'], ['Ctrl+Enter', 'x', 'Control+Enter'], ['an unchanged Esc', '', 'Escape']]) {
  check('code-edit: ' + name + ' out of the edit hands the caret on to the paragraph below (M-f)', DESKTOP, async (page, boot) => {
    await clickText(page, 'endmodule');
    if (typed) await page.keyboard.type(typed);
    await page.keyboard.press(key); await renderIdle(page);
    assert.strictEqual(await codeEdit(page), null, 'guard: the edit is closed');
    assert.deepStrictEqual(await focusAfterLeave(page), { tag: 'P', armed: true, transient: false, text: 'Omega.' });
    await page.keyboard.type('z');
    assert.strictEqual(await commitAndRead(page, boot), CODE_MD.replace('endmodule', 'endmodule' + typed).replace('Omega.', 'zOmega.'));
  }, { md: CODE_MD });
}
// The last block: nothing below takes a caret, so it goes into a new empty
// paragraph there (a transient), which writes nothing until typed into.
check('code-edit: Esc out of the last block hands the caret to a new paragraph below it (M-f)', DESKTOP, async (page, boot) => {
  await clickText(page, 'endmodule'); await page.keyboard.press('Escape'); await renderIdle(page);
  assert.deepStrictEqual(await focusAfterLeave(page), { tag: 'P', armed: true, transient: true, text: '' });
  assert.strictEqual(fs.readFileSync(boot.mdPath, 'utf8'), '# D\n\n```\nendmodule\n```\n', 'nothing written');
  await page.keyboard.type('z');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n```\nendmodule\n```\n\nz\n');
}, { md: '# D\n\n```\nendmodule\n```\n' });
// Fix round 1 (R49 M6): waits are on what the page and the disk say, never a
// fixed sleep. `diskUntil` polls the file until it reads `want` (or 10 s
// pass) and returns what it last read; `saveStateUntil` does the same for the
// toolbar's save status. The caller asserts the returned value.
async function diskUntil(boot, want) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const d = fs.readFileSync(boot.mdPath, 'utf8');
    if (d === want || Date.now() > deadline) return d;
    await wait(50);
  }
}
async function saveStateUntil(page, want) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const st = await page.evaluate(() => document.querySelector('.ed-toolbar-status').getAttribute('data-state'));
    if (st === want || Date.now() > deadline) return st;
    await wait(50);
  }
}
// R48: Ctrl+S commits and saves, and the edit stays open where the caret was.
check('code-edit: Ctrl+S commits the edit and saves', DESKTOP, async (page, boot) => {
  await clickText(page, 'endmodule'); await page.keyboard.type('q');
  await page.keyboard.press('Control+s'); await renderIdle(page);
  assert.strictEqual(await saveStateUntil(page, 'clean'), 'clean', 'the save landed');
  assert.strictEqual(fs.readFileSync(boot.mdPath, 'utf8'), CODE_MD.replace('endmodule', 'endmoduleq'));
  assert.deepStrictEqual(await codeEdit(page), { text: 'module m;\nendmoduleq', caret: 20, focused: true },
    'the edit is open again at the same caret');
}, { md: CODE_MD });
// R48: keys typed while the Ctrl+S render is out land in the code, in order.
check('code-edit: typing straight on after Ctrl+S lands in the code', DESKTOP, async (page, boot) => {
  await clickText(page, 'endmodule'); await page.keyboard.type('q');
  await delayRender(page, 800);
  await page.keyboard.press('Control+s');
  await page.keyboard.type('rs'); await page.keyboard.press('Enter'); await page.keyboard.type('t');
  await renderIdle(page);
  assert.strictEqual(await diskUntil(boot, CODE_MD.replace('endmodule', 'endmoduleq')), CODE_MD.replace('endmodule', 'endmoduleq'),
    'the first save wrote what was there at Ctrl+S');
  assert.deepStrictEqual({ edit: await codeEdit(page), notice: await noticeText(page) },
    { edit: { text: 'module m;\nendmoduleqrs\nt', caret: 24, focused: true }, notice: null });
  await page.keyboard.press('Control+s'); await renderIdle(page);
  assert.strictEqual(await diskUntil(boot, CODE_MD.replace('endmodule', 'endmoduleqrs\nt')), CODE_MD.replace('endmodule', 'endmoduleqrs\nt'));
  assert.strictEqual(await saveStateUntil(page, 'clean'), 'clean');
}, { md: CODE_MD });
// R47: typed code that has not left the edit is unsaved work — the dot, the
// status and the beforeunload guard all say so; back to the opened text, all
// clean again.
check('code-edit: typing in the open edit marks the document unsaved (R47)', DESKTOP, async (page) => {
  const state = () => page.evaluate(() => {
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    return { title: document.title.charAt(0) === '●', status: document.querySelector('.ed-toolbar-status').getAttribute('data-state'),
      guard: ev.defaultPrevented };
  });
  await clickText(page, 'endmodule');
  assert.deepStrictEqual(await state(), { title: false, status: 'clean', guard: false }, 'guard: clean on open');
  await page.keyboard.type('q');
  assert.deepStrictEqual(await state(), { title: true, status: 'dirty', guard: true }, 'typed, not left');
  assert.strictEqual((await codeEdit(page) || {}).focused, true, 'guard: still editing');
  await page.keyboard.press('Backspace');
  assert.deepStrictEqual(await state(), { title: false, status: 'clean', guard: false }, 'back to the opened text');
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.deepStrictEqual(await state(), { title: false, status: 'clean', guard: false }, 'left unchanged');
}, { md: CODE_MD });
// R49 (M5a): an unterminated fence on the in-place path — an untouched visit
// writes nothing, an edit writes the closing fence (R37's repair).
check('code-edit: an unterminated fence: an untouched visit writes nothing, an edit closes it (R37)', DESKTOP, async (page, boot) => {
  const MD = '# D\n\nAlpha.\n\n```\ncode\n';
  const before = renderTotal(page);
  await clickText(page, 'code');
  assert.strictEqual((await codeEdit(page) || {}).focused, true, 'guard: the in-place edit opened');
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.deepStrictEqual({ renders: renderTotal(page) - before, disk: await saveAndRead(page, boot) }, { renders: 0, disk: MD });
  await clickText(page, 'code'); await page.keyboard.type('x');
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n```\ncodex\n```\n');
}, { md: '# D\n\nAlpha.\n\n```\ncode\n' });
// R49 (M5b) / R27 (8): an untouched "/" 程式碼 insert left by a click
// elsewhere is taken away again — file unchanged, no undo step left.
check('code-edit: an untouched "/" 程式碼 insert abandoned by a click elsewhere is discarded (R27)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('/code'); await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await codeEdit(page), { text: '', caret: 0, focused: true }, 'guard: the insert opened the edit');
  await clickText(page, 'Omega.'); await renderIdle(page);
  const s = await page.evaluate(() => ({ status: document.querySelector('.ed-toolbar-status').getAttribute('data-state'),
    codeBlocks: document.querySelectorAll('.content .ed-block[data-block-type="code"]').length }));
  assert.deepStrictEqual(s, { status: 'clean', codeBlocks: 0 });
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD);
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD, 'no undo step was left behind');
}, { md: BASE_MD });
// R49 (M4) / R23: a reconciliation that lands while the code edit is open
// reopens the block as a raw box holding the fences and the typed text. The
// R83 / R86 order: the split renders, its undo's render fails and so does
// the redraw (a reconciliation is owed); the code block above the split
// reads the same on screen and in `lines`, so it opens; its commit runs the
// owed redraw, which captures the edit's snapshot and reopens it.
check('code-edit: a reconciliation that lands while the edit is open reopens it as a raw box with the fences and the typed text (R23)', DESKTOP, async (page, boot) => {
  await scriptRenders(page, [300, 2000, 1000, 1500], [false, true, true, false]);
  const t0 = renderTotal(page);
  await focusSurface(page, 'Bravo paragraph text.', 5); await page.keyboard.press('Enter');
  await wait(100); await page.keyboard.press('Control+z');
  await wait(600);
  // Clicked while the undo renders, as R83's quote is: the click settles
  // first, and the block opens once the redraw has failed too.
  await clickText(page, 'code');
  await settleR86(page); await wait(300); await settleR86(page);
  assert.strictEqual(renderTotal(page) - t0, 3, 'guard: split, undo, and the redraw that failed');
  await page.keyboard.press('End'); await page.keyboard.type(' ab');
  assert.deepStrictEqual(await codeEdit(page), { text: 'code ab', caret: 7, focused: true }, 'guard: the edit is open on the stale screen');
  await page.keyboard.press('Escape');
  await settleR86(page); await wait(300); await settleR86(page);
  assert.strictEqual(renderTotal(page) - t0, 4, 'guard: the commit ran the owed redraw');
  assert.deepStrictEqual({ raw: await rawBox(page), edit: await codeEdit(page) },
    { raw: { value: '```\ncode ab\n```', caret: 11, focused: true }, edit: null });
  await page.keyboard.press('Control+Enter'); await settleR86(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n```\ncode ab\n```\n\nBravo\n\nparagraph text.\n\nOmega.\n');
}, { md: '# D\n\n```\ncode\n```\n\nBravo paragraph text.\n\nOmega.\n' });
check('code-edit: keys typed right after the click land at the click point', DESKTOP, async (page) => {
  await clickText(page, 'endmodule', 'start'); await page.keyboard.type('zz');
  assert.deepStrictEqual(await codeEdit(page), { text: 'module m;\nzzendmodule', caret: 12, focused: true });
}, { md: CODE_MD });
check('code-edit: a body holding ``` saves with a longer fence and renders as one block', DESKTOP, async (page, boot) => {
  await clickText(page, 'endmodule'); await page.keyboard.press('Enter'); await page.keyboard.type('```');
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n````verilog\nmodule m;\nendmodule\n```\n````\n\nOmega.\n');
  assert.deepStrictEqual(await page.evaluate(() => [...document.querySelectorAll('.content .ed-block')].map((b) => b.getAttribute('data-block-type'))),
    ['heading', 'paragraph', 'code', 'paragraph']);
}, { md: CODE_MD });
check('code-edit: a ~~~ fence keeps its fence', DESKTOP, async (page, boot) => {
  await clickText(page, 'print'); await page.keyboard.type('(1)');
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n~~~python\nprint(1)\n~~~\n\nOmega.\n');
}, { md: '# D\n\nAlpha.\n\n~~~python\nprint\n~~~\n\nOmega.\n' });
check('code-edit: "/" 程式碼 and the ``` shortcut open the edit in place', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('/code'); await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await codeEdit(page), { text: '', caret: 0, focused: true }, '"/" 程式碼 opens the edit on the empty body');
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('textarea.ed-raw').length), 0, 'no raw box');
  await page.keyboard.type('x'); await page.keyboard.press('Escape'); await renderIdle(page);
  await focusSurface(page, 'Omega.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('```'); await renderIdle(page);
  assert.deepStrictEqual(await codeEdit(page), { text: '', caret: 0, focused: true }, 'the ``` shortcut opens the edit on the empty body');
  await page.keyboard.type('y'); await page.keyboard.press('Escape'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n```\nx\n```\n\nOmega.\n\n```\ny\n```\n');
}, { md: BASE_MD });
check('code-edit: an IME composition survives the re-colour tick', DESKTOP, async (page) => {
  await clickText(page, 'endmodule');
  const cdp = await page.context().newCDPSession(page);
  await page.keyboard.type('a');
  await cdp.send('Input.imeSetComposition', { text: 'ㄋ', selectionStart: 1, selectionEnd: 1 });
  await wait(450); // the tick the "a" started falls inside the composition
  const mid = (await codeEdit(page)).text;
  await cdp.send('Input.insertText', { text: '你' });
  await wait(450);
  assert.deepStrictEqual({ mid, end: await codeEdit(page) },
    { mid: 'module m;\nendmoduleaㄋ', end: { text: 'module m;\nendmodulea你', caret: 21, focused: true } });
}, { md: CODE_MD, engines: ['chromium'] });
check('code-edit: ⠿ MD 原始碼 still opens the whole block with its fence', DESKTOP, async (page) => {
  await gutterMenu(page, '.ed-block[data-block-type="code"]', 'MD 原始碼');
  assert.deepStrictEqual({ raw: await rawBox(page), edit: await codeEdit(page) },
    { raw: { value: '```verilog\nmodule m;\nendmodule\n```', caret: 11, focused: true }, edit: null });
}, { md: CODE_MD });
// R24: a click inside the open edit is a caret move — no commit, no render.
check('code-edit: a click inside the open edit keeps it and writes nothing (R24)', DESKTOP, async (page) => {
  await clickText(page, 'endmodule'); await page.keyboard.type('a');
  const before = renderTotal(page);
  await clickText(page, 'module', 'start'); await wait(300);
  assert.deepStrictEqual({ edit: await codeEdit(page), renders: renderTotal(page) - before },
    { edit: { text: 'module m;\nendmodulea', caret: 0, focused: true }, renders: 0 });
}, { md: CODE_MD });
// R26: the pre is the host, so a click in its blank area and a click on an
// empty body both open the edit.
check('code-edit: a click in the blank area right of a line, and on an empty body, opens the edit (R26)', DESKTOP, async (page, boot) => {
  const pt = await page.evaluate(() => {
    const pre = document.querySelector('.ed-block[data-block-type="code"] > pre');
    // The last line: the first line's right end is under the chips (v3.17.0 T3).
    const kw = [...pre.querySelectorAll('.hljs-keyword')].pop();
    const p = pre.getBoundingClientRect(); const k = kw.getBoundingClientRect();
    const x = p.right - 30; const y = k.top + k.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, inPre: !!hit && pre.contains(hit) };
  });
  assert.strictEqual(pt.inPre, true, 'guard: the point is inside the pre');
  await page.mouse.click(pt.x, pt.y);
  assert.deepStrictEqual(await codeEdit(page), { text: 'module m;\nendmodule', caret: 19, focused: true }, 'blank area: the end of that line');
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.strictEqual(fs.readFileSync(boot.mdPath, 'utf8'), CODE_MD);
}, { md: CODE_MD });
check('code-edit: an empty body opens on a click and takes typing (R26)', DESKTOP, async (page, boot) => {
  const box = await page.evaluate(() => {
    const pre = document.querySelector('.ed-block[data-block-type="code"] > pre');
    const r = pre.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, inPre: !!hit && pre.contains(hit), h: r.height };
  });
  assert.strictEqual(box.inPre, true, 'guard: the centre of the empty pre is the pre: ' + JSON.stringify(box));
  await page.mouse.click(box.x, box.y);
  assert.deepStrictEqual(await codeEdit(page), { text: '', caret: 0, focused: true });
  await page.keyboard.type('k'); await page.keyboard.press('Escape'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n```\nk\n```\n\nOmega.\n');
}, { md: '# D\n\nAlpha.\n\n```\n```\n\nOmega.\n' });
// R27 (3): a commit whose render fails is rolled back and the edit stays
// open on what was typed; the next commit lands it.
check('code-edit: a commit whose render fails keeps the edit open with its text (R27)', DESKTOP, async (page, boot) => {
  await clickText(page, 'endmodule'); await page.keyboard.type('q');
  await failFirstRender(page);
  await page.keyboard.press('Escape'); await wait(1200); await renderIdle(page);
  assert.deepStrictEqual({ card: await errorCardUp(page), edit: await codeEdit(page) },
    { card: true, edit: { text: 'module m;\nendmoduleq', caret: 20, focused: true } });
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), CODE_MD.replace('endmodule', 'endmoduleq'));
}, { md: CODE_MD });
// R28: keys held while the ``` shortcut renders land in the body, and a held
// Escape commits the edit.
check('code-edit: "```js" and an Escape held during a slow render land in the body and commit (R28)', DESKTOP, async (page, boot) => {
  await newParaBelowAlpha(page);
  await delayRender(page, 800);
  await page.keyboard.type('```js'); await page.keyboard.press('Escape');
  await renderIdle(page); await wait(300); await renderIdle(page);
  assert.deepStrictEqual({ edit: await codeEdit(page), notice: await noticeText(page) }, { edit: null, notice: null });
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n```\njs\n```\n\nOmega.\n');
}, { md: BASE_MD });

// ── code-chips (v3.17.0 T3): the language chip and the copy chip ──
const CODE_PRE = '.ed-block[data-block-type="code"] > pre';
// Same recorder / refuser as reader-click's stubClipboard (R34): both engines,
// and the assertion reads what was handed over.
async function stubClipboard(page, refuse) {
  await page.evaluate((no) => {
    window.__copied = null;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: (t) => { if (no) return Promise.reject(new Error('denied')); window.__copied = t; return Promise.resolve(); },
    } });
    if (no) document.execCommand = () => false;
  }, !!refuse);
}
const chipsState = (page) => page.evaluate(() => {
  const c = document.querySelector('.ed-code-chips');
  const pre = document.querySelector('.ed-block[data-block-type="code"] > pre');
  if (!c || c.hidden) return null;
  const r = c.getBoundingClientRect(), p = pre.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const lang = c.querySelector('.ed-code-lang'), copy = c.querySelector('.ed-code-copy');
  return {
    right: Math.round(p.right - r.right), top: Math.round(r.top - p.top), h: Math.round(r.height),
    label: lang.textContent.trim(), copyLabel: copy.getAttribute('aria-label'), copyText: copy.textContent.trim(),
    hit: !!hit && !!hit.closest('.ed-code-chips'), copied: window.__copied,
  };
});
const langMenu = (page) => page.evaluate(() => {
  const m = document.querySelector('.ed-code-langmenu');
  if (!m) return null;
  const f = m.querySelector('input');
  return { items: [...m.querySelectorAll('.ed-code-langitem')].map((b) => b.textContent.trim()),
    focused: document.activeElement === f, w: Math.round(m.getBoundingClientRect().width),
    cursor: (m.querySelector('[data-ed-lang-cursor]') || {}).textContent || null };
});
const hoverCodeBlock = async (page) => { await page.hover(CODE_PRE); await wait(200); };
check('code-chips: hovering a code block shows Verilog and copy at its top-right', DESKTOP, async (page) => {
  assert.strictEqual(await chipsState(page), null, 'guard: no chips while the pointer is elsewhere');
  await hoverCodeBlock(page);
  const s = await chipsState(page);
  assert.ok(s, 'chips shown');
  assert.ok(s.right >= 4 && s.right <= 10, 'right inset: ' + s.right);
  assert.ok(s.top >= 4 && s.top <= 10, 'top inset: ' + s.top);
  assert.deepStrictEqual({ label: s.label, h: s.h, hit: s.hit, copyLabel: s.copyLabel }, { label: 'Verilog', h: 24, hit: true, copyLabel: 'Copy code' });
  await page.mouse.move(5, 5); await wait(200);
  assert.strictEqual(await chipsState(page), null, 'hidden again when the pointer leaves');
}, { md: CODE_MD });
check('code-chips: picking Python rewrites only the fence word, one undo step', DESKTOP, async (page, boot) => {
  await hoverCodeBlock(page);
  await page.click('.ed-code-lang'); await wait(200);
  // R40: the chip opened the edit (caret at 0) and then the menu, whose filter holds focus.
  const m = await langMenu(page);
  assert.deepStrictEqual({ n: m.items.length, first: m.items[0], last: m.items[11], focused: m.focused, w: m.w, cursor: m.cursor },
    { n: 12, first: 'Verilog', last: '純文字', focused: true, w: 220, cursor: 'Verilog' });
  assert.strictEqual(await page.evaluate(() => { const h = document.querySelector('pre[data-ed-code-edit]'); return h ? h.textContent : null; }), 'module m;\nendmodule', 'the chip opened the edit');
  await page.click('.ed-code-langitem:has-text("Python")'); await renderIdle(page);
  assert.strictEqual(await langMenu(page), null, 'the menu closed');
  assert.deepStrictEqual(await codeEdit(page), { text: 'module m;\nendmodule', caret: 0, focused: true }, 'the edit is open again');
  assert.strictEqual((await chipsState(page)).label, 'Python');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n```python\nmodule m;\nendmodule\n```\n\nOmega.\n');
  await page.keyboard.press('Escape'); await renderIdle(page);
  await page.keyboard.press('Control+z'); await wait(900); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), CODE_MD, 'one undo restores the old language');
}, { md: CODE_MD });
check('code-chips: picking while editing keeps the typing and the caret', DESKTOP, async (page, boot) => {
  await clickText(page, 'module', 'start');
  await page.keyboard.press('End'); await page.keyboard.type('x');
  await page.click('.ed-code-lang'); await wait(200);
  await page.click('.ed-code-langitem:has-text("Python")'); await renderIdle(page);
  assert.deepStrictEqual(await codeEdit(page), { text: 'module m;x\nendmodule', caret: 10, focused: true });
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n```python\nmodule m;x\nendmodule\n```\n\nOmega.\n');
}, { md: CODE_MD });
check('code-chips: the language filter takes 「py」 and Enter picks', DESKTOP, async (page, boot) => {
  await hoverCodeBlock(page);
  await page.click('.ed-code-lang'); await wait(200);
  await page.keyboard.type('py'); await wait(100);
  assert.deepStrictEqual((await langMenu(page)).items, ['Python']);
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n```python\nmodule m;\nendmodule\n```\n\nOmega.\n');
}, { md: CODE_MD });
// v3.17.0 T10 (R54c): the filter input pointed at an option the empty list no
// longer holds.
check('code-chips: an empty filtered list clears aria-activedescendant (R54c)', DESKTOP, async (page) => {
  await hoverCodeBlock(page);
  await page.click('.ed-code-lang'); await wait(200);
  const ad = () => page.evaluate(() => document.querySelector('.ed-code-langmenu input').getAttribute('aria-activedescendant'));
  await page.keyboard.type('py'); await wait(100);
  assert.strictEqual(await ad(), 'ed-code-lang-python', 'guard: a match is current');
  await page.keyboard.type('zz'); await wait(100);
  assert.deepStrictEqual({ items: (await langMenu(page)).items, ad: await ad() }, { items: [], ad: null });
}, { md: CODE_MD });
check('code-chips: the arrow keys move the cursor, Esc closes the menu and keeps the edit', DESKTOP, async (page, boot) => {
  await clickText(page, 'endmodule'); await page.keyboard.type('q');
  await page.click('.ed-code-lang'); await wait(200);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  assert.strictEqual((await langMenu(page)).cursor, 'Bash');
  await page.keyboard.press('Escape'); await wait(200);
  assert.strictEqual(await langMenu(page), null, 'Esc closed the menu');
  assert.deepStrictEqual(await codeEdit(page), { text: 'module m;\nendmoduleq', caret: 20, focused: true }, 'focus is back in the edit, typing kept');
  assert.strictEqual(fs.readFileSync(boot.mdPath, 'utf8'), CODE_MD, 'nothing was written');
  await page.keyboard.type('r');
  assert.strictEqual((await codeEdit(page)).text, 'module m;\nendmoduleqr', 'typing goes on in the code');
}, { md: CODE_MD });
check('code-chips: 純文字 removes the language word', DESKTOP, async (page, boot) => {
  await hoverCodeBlock(page);
  await page.click('.ed-code-lang'); await wait(200);
  await page.click('.ed-code-langitem:has-text("純文字")'); await renderIdle(page);
  assert.strictEqual((await chipsState(page)).label, '純文字');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n```\nmodule m;\nendmodule\n```\n\nOmega.\n');
}, { md: CODE_MD });
// v3.17.2 A2 (R53): the words after the first are kept as written, and a
// first word holding `=` is an attribute, not a language: the chip reads
// 純文字 and a language picked next goes in front of it. Before: the chip read
// `title="a"` and Python replaced it, losing the attribute.
check('code-chips: 純文字 keeps the words after the first, and a language picked next goes in front of them (v3.17.2 A2, R53)', DESKTOP, async (page, boot) => {
  await hoverCodeBlock(page);
  await page.click('.ed-code-lang'); await wait(200);
  await page.click('.ed-code-langitem:has-text("純文字")'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n```title="a  b"\nmodule m;\nendmodule\n```\n\nOmega.\n');
  await page.mouse.move(5, 5); await hoverCodeBlock(page);
  assert.strictEqual((await chipsState(page) || {}).label, '純文字', 'an attribute is not a language');
  await page.click('.ed-code-lang'); await wait(200);
  assert.strictEqual((await langMenu(page) || {}).cursor, '純文字', 'the menu marks 純文字 as the current one');
  await page.click('.ed-code-langitem:has-text("Python")'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n```python title="a  b"\nmodule m;\nendmodule\n```\n\nOmega.\n');
}, { md: CODE_MD.replace('```verilog', '```verilog title="a  b"') });
check('code-chips: copy writes the edit text, uncommitted typing included, and shows Copied', DESKTOP, async (page) => {
  await stubClipboard(page);
  await clickText(page, 'endmodule'); await page.keyboard.type('q');
  await page.click('.ed-code-copy'); await wait(150);
  const s = await chipsState(page);
  assert.deepStrictEqual({ copied: s.copied, label: s.copyLabel, text: s.copyText },
    { copied: 'module m;\nendmoduleq', label: 'Copied', text: 'Copied' });
  assert.deepStrictEqual(await codeEdit(page), { text: 'module m;\nendmoduleq', caret: 20, focused: true }, 'the edit keeps focus and text');
  await wait(2200);
  const back = await chipsState(page);
  assert.deepStrictEqual([back.copyLabel, back.copyText], ['Copy code', ''], 'reverts after two seconds');
}, { md: CODE_MD });
check('code-chips: copy on a block that is not being edited copies its code', DESKTOP, async (page) => {
  await stubClipboard(page);
  await hoverCodeBlock(page);
  await page.click('.ed-code-copy'); await wait(150);
  assert.strictEqual((await chipsState(page)).copied, 'module m;\nendmodule');
  assert.strictEqual(await codeEdit(page), null, 'copying does not open the edit');
}, { md: CODE_MD });
check('code-chips: a refused clipboard selects the code and says Press Ctrl+C', DESKTOP, async (page) => {
  await stubClipboard(page, true);
  await clickText(page, 'endmodule'); await page.keyboard.type('q');
  await page.click('.ed-code-copy'); await wait(200);
  const r = await page.evaluate(() => ({ sel: String(window.getSelection()), label: document.querySelector('.ed-code-copy').getAttribute('aria-label'),
    want: /Mac|iPhone|iPad/.test(navigator.platform || '') ? 'Press Cmd+C' : 'Press Ctrl+C' }));
  assert.strictEqual(r.sel.replace(/\n$/, ''), 'module m;\nendmoduleq', 'the whole code is selected');
  assert.strictEqual(r.label, r.want);
  assert.strictEqual((await codeEdit(page)).text, 'module m;\nendmoduleq', 'the edit is untouched');
}, { md: CODE_MD });

check('code-chips: the language chip right after typing in a paragraph opens the menu', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.type('x');
  await hoverCodeBlock(page);
  await page.click('.ed-code-lang'); await renderIdle(page); await wait(300);
  const m = await langMenu(page);
  assert.ok(m, 'the menu opened (notice: ' + (await noticeText(page)) + ')');
  assert.strictEqual(m.focused, true, 'the filter holds focus');
  assert.strictEqual(await page.evaluate(() => { const h = document.querySelector('pre[data-ed-code-edit]'); return h ? h.textContent : null; }),
    'module m;\nendmodule', 'the edit is open');
  await page.click('.ed-code-langitem:has-text("Python")'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), CODE_MD.replace('Alpha.', 'Alpha.x').replace('```verilog', '```python'));
}, { md: CODE_MD });
// v3.17.0 T9a (R54a): the language chip opens the edit through the click
// router's own guards. (1) Its block redrawn by the removal of the emptied
// paragraph above, with an identical twin: found again by content only when
// it is the one such block (R104), so it is refused with the notice.
check('code-chips: after emptying the paragraph above, the language chip on the first of two identical code blocks is refused and opens nothing (R54a, R104)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
  await hoverCodeBlock(page);
  await page.click('.ed-code-lang'); await settleR86(page);
  assert.deepStrictEqual({ edit: await codeEdit(page), menu: await langMenu(page), notice: await noticeText(page) },
    { edit: null, menu: null, notice: '文件已更新，請重試這個操作' });
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n```\nx\n```\n\n```\nx\n```\n\nEnd.\n', 'nothing written but the removal');
}, { md: '# D\n\nAlpha.\n\n```\nx\n```\n\n```\nx\n```\n\nEnd.\n' });
// (2) The R102 (I-R1) shape: a split above, its undo's render fails and so
// does the redraw, so the flight ends with a reconciliation owed and the
// code block's node still on screen over stale `blocks`. The chip used to
// open the edit there, seeded from lines that are not the block's; now it is
// refused like the click on the block itself, and nothing is written.
check('code-chips: the language chip on a code block below a split whose undo and redraw failed is refused and writes nothing (R54a, R102)', DESKTOP, async (page, boot) => {
  const SPLIT = '# D\n\nAlpha para one.\n\nBravo\n\nparagraph text.\n\n';
  await scriptRenders(page, [300, 2000, 1000], [false, true, true]);
  const t0 = renderTotal(page);
  await focusSurface(page, 'Bravo paragraph text.', 5); await page.keyboard.press('Enter');
  await wait(100); await page.keyboard.press('Control+z');
  await wait(600);
  await hoverCodeBlock(page);
  await page.click('.ed-code-lang'); await wait(200);
  await settleR86(page); await wait(300); await settleR86(page);
  assert.strictEqual(renderTotal(page) - t0, 3, 'guard: split, undo, and the redraw that failed');
  assert.deepStrictEqual({ edit: await codeEdit(page), menu: await langMenu(page), notice: await noticeText(page) },
    { edit: null, menu: null, notice: '文件已更新，請重試這個操作' }, 'refused: no edit on the stale screen');
  assert.strictEqual(await saveAndRead(page, boot), SPLIT + '```\ncode\n```\n', 'nothing written');
}, { md: '# D\n\nAlpha para one.\n\nBravo paragraph text.\n\n```\ncode\n```\n' });
check('code-chips: a typed filter starts on its first match, not on the current language (M3)', DESKTOP, async (page, boot) => {
  await hoverCodeBlock(page);
  await page.click('.ed-code-lang'); await wait(200);
  await page.keyboard.type('j'); await wait(100);
  const m = await langMenu(page);
  assert.deepStrictEqual({ items: m.items, cursor: m.cursor }, { items: ['JSON', 'JavaScript'], cursor: 'JSON' });
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), CODE_MD.replace('```verilog', '```json'));
}, { md: CODE_MD.replace('```verilog', '```javascript') });
check('code-chips: the chips come back when an edit ends with the pointer still over the block (M6)', DESKTOP, async (page) => {
  await clickText(page, 'endmodule');
  await page.keyboard.press('Escape'); await renderIdle(page); await wait(400);
  assert.strictEqual(await codeEdit(page), null, 'guard: the edit ended');
  assert.ok(await chipsState(page), 'chips shown again');
}, { md: CODE_MD });
check('code-chips: scrolling the block sideways keeps its chips (M1)', DESKTOP, async (page) => {
  await hoverCodeBlock(page);
  assert.ok(await chipsState(page), 'guard: shown');
  const sc = await page.evaluate(() => { const p = document.querySelector('.ed-block[data-block-type="code"] > pre'); p.scrollLeft = 200; return p.scrollLeft; });
  assert.ok(sc > 0, 'guard: the block scrolled sideways: ' + sc);
  await wait(300);
  assert.ok(await chipsState(page), 'still shown');
}, { md: CODE_MD.replace('module m;', 'module m; // ' + 'x'.repeat(400)) });
const CODE_SCROLL_MD = '# D\n\n' + Array.from({ length: 30 }, (_, i) => 'Filler ' + i + '.').join('\n\n') +
  '\n\n```verilog\nmodule m;\nendmodule\n```\n\n' + Array.from({ length: 30 }, (_, i) => 'Tail ' + i + '.').join('\n\n') + '\n';
check('code-chips: a scroll hides the chips of a block that is not edited and moves an edit\'s with it', DESKTOP, async (page) => {
  await page.evaluate(() => document.querySelector('.ed-block[data-block-type="code"]').scrollIntoView({ block: 'center' }));
  await wait(200);
  await hoverCodeBlock(page);
  assert.ok(await chipsState(page), 'guard: chips shown on hover');
  await page.evaluate(() => window.scrollBy(0, 40)); await wait(300);
  assert.strictEqual(await chipsState(page), null, 'hidden by the scroll');
  await clickText(page, 'endmodule');
  const before = await chipsState(page);
  assert.ok(before, 'chips shown while editing');
  await page.evaluate(() => window.scrollBy(0, 60)); await wait(300);
  const after = await chipsState(page);
  assert.ok(after, 'chips still shown while editing');
  assert.ok(after.top >= 4 && after.top <= 10 && after.right >= 4 && after.right <= 10, 'still at the block corner: ' + JSON.stringify(after));
  assert.strictEqual(after.hit, true, 'and hit-testable');
}, { md: CODE_SCROLL_MD });

// v3.17.0 T4: the 編輯圖表 button on Graphviz and Mermaid blocks (D6/E8).
const DIAG_MD = '# D\n\n```dot\ndigraph { a -> b }\n```\n\n```mermaid\ngraph TD\n  A --> B\n```\n\nOmega.\n';
const DIAG_MIX_MD = '# D\n\n```js\nvar a = 1;\n```\n\n```wavedrom\n{ signal: [{ name: "a", wave: "01" }] }\n```\n\nOmega.\n';
const diagBtnState = (page, sel) => page.evaluate((s) => {
  const b = document.querySelector('.ed-diagram-edit-btn');
  const d = document.querySelector(s);
  if (!b || b.hidden || !d) return null;
  const r = b.getBoundingClientRect(), p = d.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return {
    text: b.textContent.trim(), right: Math.round(p.right - r.right), top: Math.round(r.top - p.top),
    hit: !!hit && !!hit.closest('.ed-diagram-edit-btn'), icon: !!b.querySelector('svg'),
    inContent: !!b.closest('.content'),
  };
}, sel);
check('diagram-btn: hovering a Graphviz block shows 編輯圖表 at its top-right; Mermaid too', DESKTOP, async (page) => {
  await page.waitForSelector('.ed-block .mermaid svg', { timeout: 20000 });
  assert.strictEqual(await diagBtnState(page, '.graphviz'), null, 'guard: no button while the pointer is elsewhere');
  await page.hover('.graphviz svg'); await wait(250);
  const g = await diagBtnState(page, '.graphviz');
  assert.ok(g, 'button shown over the Graphviz block');
  assert.ok(g.right >= 4 && g.right <= 10 && g.top >= 4 && g.top <= 10, 'inset from the diagram corner: ' + JSON.stringify(g));
  assert.deepStrictEqual({ text: g.text, hit: g.hit, icon: g.icon, inContent: g.inContent }, { text: '編輯圖表', hit: true, icon: true, inContent: false });
  assert.strictEqual(await page.evaluate(() => { const c = document.querySelector('.ed-code-chips'); return !c || c.hidden; }), true, 'no code chips on a diagram block');
  await page.mouse.move(5, 5); await wait(250);
  assert.strictEqual(await diagBtnState(page, '.graphviz'), null, 'hidden again when the pointer leaves');
  await page.hover('.ed-block .mermaid svg'); await wait(250);
  const m = await diagBtnState(page, '.mermaid');
  assert.ok(m, 'button shown over the Mermaid block');
  assert.ok(m.right >= 4 && m.right <= 10 && m.top >= 4 && m.top <= 10, 'inset from the diagram corner: ' + JSON.stringify(m));
  assert.strictEqual(m.text, '編輯圖表');
  assert.strictEqual(await page.evaluate(() => { const c = document.querySelector('.ed-code-chips'); return !c || c.hidden; }), true, 'no code chips on a Mermaid block');
  // The button itself keeps the pointer: moving onto it does not hide it.
  const box = await page.locator('.ed-diagram-edit-btn').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await wait(250);
  assert.ok(await diagBtnState(page, '.mermaid'), 'still shown with the pointer on it');
}, { md: DIAG_MD });
check('diagram-btn: a click on the diagram itself still opens the lightbox', DESKTOP, async (page) => {
  await page.hover('.graphviz svg'); await wait(250);
  await page.click('.graphviz svg'); await wait(300);
  const s = await page.evaluate(() => {
    const l = document.querySelector('.lightbox');
    return { open: !!l && !l.hidden, raw: document.querySelectorAll('.ed-raw').length };
  });
  assert.deepStrictEqual(s, { open: true, raw: 0 }, 'lightbox open, no raw box');
}, { md: DIAG_MD });
check('diagram-btn: a plain code block and a WaveDrom block show no 編輯圖表', DESKTOP, async (page) => {
  await page.hover(CODE_PRE); await wait(250);
  assert.strictEqual(await diagBtnState(page, CODE_PRE), null, 'no button on a plain code block');
  await page.waitForSelector('.wavedrom-diagram, [id^="WaveDrom_Display_"]', { timeout: 20000 });
  await page.hover('[id^="WaveDrom_Display_"] svg, .wavedrom-diagram svg'); await wait(250);
  assert.strictEqual(await diagBtnState(page, '[id^="WaveDrom_Display_"], .wavedrom-diagram'), null, 'no button on a WaveDrom block');
  assert.strictEqual(await page.evaluate(() => { const b = document.querySelector('.ed-wave-edit-btn'); return !!b && !b.hidden; }), true, 'guard: the wave button is the one shown');
}, { md: DIAG_MIX_MD });
// T5 (R56 (b)): the click opens the panel in place, with no raw box.
check('diagram-btn: clicking the button opens the diagram panel in place', DESKTOP, async (page) => {
  await page.hover('.graphviz svg'); await wait(250);
  await page.locator('.ed-diagram-edit-btn').click(); await wait(300);
  const s = await page.evaluate(() => {
    const p = document.querySelector('.ed-diagram-panel');
    const b = document.querySelector('.ed-diagram-edit-btn');
    return { raw: document.querySelectorAll('.ed-raw').length, panel: document.querySelectorAll('.ed-diagram-panel').length,
      inBlock: !!p && !!p.closest('.content .ed-block[data-block-type="code"]'), btnHidden: !b || b.hidden,
      graphvizLeft: document.querySelectorAll('.content .graphviz').length };
  });
  assert.deepStrictEqual(s, { raw: 0, panel: 1, inBlock: true, btnHidden: true, graphvizLeft: 0 },
    'one panel inside the block, the diagram replaced by it, no raw box');
}, { md: DIAG_MD });

// T6 (D14): Enter on ONE selected diagram block opens the panel, not MD 原始碼.
const shiftClickBlock = async (page, sel) => {
  const r = await page.evaluate((q) => { const e = document.querySelector(q); e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 }; }, sel);
  await page.keyboard.down('Shift'); await page.mouse.click(r.x, r.y); await page.keyboard.up('Shift');
  await wait(250);
  return page.evaluate(() => document.querySelectorAll('.ed-block.ed-selected').length);
};
const enterState = (page) => page.evaluate(() => ({ raw: document.querySelectorAll('textarea.ed-raw').length, panel: document.querySelectorAll('.ed-diagram-panel').length }));
check('diagram-btn: Enter on a selected Graphviz block opens the panel', DESKTOP, async (page) => {
  await page.waitForSelector('.ed-block .mermaid svg', { timeout: 20000 });
  assert.strictEqual(await shiftClickBlock(page, '.ed-block:has(.graphviz)'), 1, 'guard: the Graphviz block is the one selected block');
  await page.keyboard.press('Enter'); await wait(400);
  assert.deepStrictEqual(await enterState(page), { raw: 0, panel: 1 }, 'panel open, no raw box');
}, { md: DIAG_MD });
check('diagram-btn: Enter on a selected Mermaid block opens the panel', DESKTOP, async (page) => {
  await page.waitForSelector('.ed-block .mermaid svg', { timeout: 20000 });
  assert.strictEqual(await shiftClickBlock(page, '.ed-block:has(.mermaid)'), 1, 'guard: the Mermaid block is the one selected block');
  await page.keyboard.press('Enter'); await wait(400);
  assert.deepStrictEqual(await enterState(page), { raw: 0, panel: 1 }, 'panel open, no raw box');
}, { md: DIAG_MD });
// v3.17.0 T9a (R60 (2)): the Enter that opens the panel is not typed into
// it — the source is focused and holds the block's body as it is, with no
// newline from that Enter, the caret at its start.
for (const [kind, sel, body] of [['Graphviz', '.ed-block:has(.graphviz)', 'digraph { a -> b }'], ['Mermaid', '.ed-block:has(.mermaid)', 'graph TD\n  A --> B']]) {
  check('diagram-btn: Enter on a selected ' + kind + ' block focuses the panel source holding the block source unchanged (R60)', DESKTOP, async (page) => {
    await page.waitForSelector('.ed-block .mermaid svg', { timeout: 20000 });
    assert.strictEqual(await shiftClickBlock(page, sel), 1, 'guard: the ' + kind + ' block is the one selected block');
    await page.keyboard.press('Enter'); await wait(400);
    const s = await page.evaluate(() => {
      const t = document.querySelector('.ed-diagram-panel textarea.ed-diagram-src');
      return t ? { focused: document.activeElement === t, value: t.value, sel: [t.selectionStart, t.selectionEnd] } : null;
    });
    assert.deepStrictEqual(s, { focused: true, value: body, sel: [0, 0] });
  }, { md: DIAG_MD });
}
check('diagram-btn: Enter on a selected plain code block still opens MD 原始碼', DESKTOP, async (page) => {
  assert.strictEqual(await shiftClickBlock(page, '.ed-block[data-block-type="code"]'), 1, 'guard: the code block is selected');
  await page.keyboard.press('Enter'); await wait(400);
  assert.deepStrictEqual(await enterState(page), { raw: 1, panel: 0 }, 'raw box, no panel');
}, { md: DIAG_MIX_MD });
check('diagram-btn: Enter on a selected Graphviz block with a syntax error opens MD 原始碼 (an ordinary code block)', DESKTOP, async (page) => {
  await page.waitForSelector('.ed-block pre code.language-dot', { timeout: 20000 });
  assert.strictEqual(await shiftClickBlock(page, '.ed-block[data-block-type="code"]'), 1, 'guard: the broken dot block is selected');
  await page.keyboard.press('Enter'); await wait(400);
  assert.deepStrictEqual(await enterState(page), { raw: 1, panel: 0 }, 'raw box, no panel');
}, { md: '# D\n\n```dot\ndigraph { a -> \n```\n\nOmega.\n' });

// ── diagram-panel (v3.17.0 T5, D15): the source and a live preview in place ──
// The open panel, read in the page: the textarea's value / selection / focus,
// the preview's svg text, whether it is stale, the message line (and its
// kind), and the header text. null when no panel is open.
const diagPanel = (page) => page.evaluate(() => {
  const p = document.querySelector('.ed-diagram-panel');
  if (!p) return null;
  const ta = p.querySelector('textarea.ed-diagram-src');
  const pv = p.querySelector('.ed-diagram-preview');
  const er = p.querySelector('.ed-diagram-error');
  const svg = pv ? pv.querySelector('svg') : null;
  return {
    value: ta ? ta.value : null, caret: ta ? ta.selectionStart : null, focused: !!ta && document.activeElement === ta,
    // The drawn labels only (a Mermaid svg also holds its <style> text).
    svg: svg ? [...svg.querySelectorAll('text, foreignObject')].map((t) => t.textContent.trim()).filter(Boolean).join(' ') : null, stale: !!pv && pv.classList.contains('is-stale'),
    error: er && !er.hidden ? er.textContent : null, errorKind: er && !er.hidden ? er.getAttribute('data-kind') : null,
    head: (p.querySelector('.ed-diagram-head') || {}).textContent || null,
  };
});
// Polls the panel until `pred` holds (or 6 s pass) and returns what it last
// read; the caller asserts the value (diskUntil's shape).
async function diagPanelUntil(page, pred) {
  const deadline = Date.now() + 6000;
  for (;;) {
    const s = await diagPanel(page);
    if ((s && pred(s)) || Date.now() > deadline) return s;
    await wait(50);
  }
}
async function openDiagPanel(page, sel) {
  if (sel === '.mermaid svg') await page.waitForSelector('.ed-block .mermaid svg', { timeout: 20000 });
  await page.hover(sel); await wait(250);
  await page.locator('.ed-diagram-edit-btn').click();
  return diagPanelUntil(page, (s) => s.svg !== null);
}
// Selects [from, to) of the panel's source (to defaults to from).
const diagSelect = (page, from, to) => page.evaluate(([a, b]) => {
  const ta = document.querySelector('textarea.ed-diagram-src');
  ta.focus(); ta.setSelectionRange(a, b === undefined ? a : b);
}, [from, to]);
const DOT_SRC = 'digraph { a -> b }';
const DOT_B = DOT_SRC.lastIndexOf('b');
check('diagram-panel: 編輯圖表 opens source and preview in place', DESKTOP, async (page) => {
  const s = await openDiagPanel(page, '.graphviz svg');
  assert.ok(s, 'a panel opened');
  assert.deepStrictEqual({ value: s.value, focused: s.focused, svg: !!s.svg && /\ba\b/.test(s.svg) && /\bb\b/.test(s.svg), stale: s.stale, error: s.error },
    { value: DOT_SRC, focused: true, svg: true, stale: false, error: null });
  assert.ok(s.head.indexOf('Graphviz') !== -1 && s.head.indexOf('預覽在停止輸入 0.5 秒後更新') !== -1 && s.head.indexOf('完成') !== -1,
    'header: ' + JSON.stringify(s.head));
  const g = await page.evaluate(() => {
    const p = document.querySelector('.ed-diagram-panel');
    const pv = p.querySelector('.ed-diagram-preview');
    return { inBlock: !!p.closest('.content .ed-block[data-block-type="code"]'), position: getComputedStyle(p).position,
      border: getComputedStyle(p).borderTopWidth, previewTab: pv.getAttribute('tabindex'),
      previewClass: pv.matches('.graphviz, .mermaid') || !!pv.closest('.graphviz, .mermaid'),
      lightbox: (() => { const l = document.querySelector('.lightbox'); return !!l && !l.hidden; })() };
  });
  assert.deepStrictEqual(g, { inBlock: true, position: 'static', border: '2px', previewTab: '-1', previewClass: false, lightbox: false });
  // A click on the preview does not open the lightbox, and the panel stays.
  await page.click('.ed-diagram-preview svg'); await wait(300);
  assert.deepStrictEqual({ lightbox: await page.evaluate(() => { const l = document.querySelector('.lightbox'); return !!l && !l.hidden; }),
    open: !!(await diagPanel(page)) }, { lightbox: false, open: true });
}, { md: DIAG_MD });
check('diagram-panel: renaming a node updates the preview within 1.5 s', DESKTOP, async (page) => {
  await openDiagPanel(page, '.graphviz svg');
  await diagSelect(page, DOT_B, DOT_B + 1); await page.keyboard.type('zeta');
  await wait(1500);
  const s = await diagPanel(page);
  assert.deepStrictEqual({ value: s.value, zeta: /\bzeta\b/.test(s.svg || ''), stale: s.stale, error: s.error },
    { value: 'digraph { a -> zeta }', zeta: true, stale: false, error: null });
}, { md: DIAG_MD });
check('diagram-panel: a syntax error keeps the last preview and shows the first error line', DESKTOP, async (page) => {
  await openDiagPanel(page, '.graphviz svg');
  await diagSelect(page, DOT_SRC.length); await page.keyboard.press('Backspace');
  await wait(1500);
  const bad = await diagPanel(page);
  assert.strictEqual(bad.value, 'digraph { a -> b ', 'guard: the brace is gone');
  assert.ok(/syntax error/.test(bad.error || ''), 'error line: ' + JSON.stringify(bad.error));
  assert.strictEqual(bad.error.indexOf('\n'), -1, 'one line only');
  assert.deepStrictEqual({ stale: bad.stale, kept: !!bad.svg && /\bb\b/.test(bad.svg), kind: bad.errorKind }, { stale: true, kept: true, kind: 'error' });
  await page.keyboard.type('}');
  await wait(1500);
  const fixed = await diagPanel(page);
  assert.deepStrictEqual({ value: fixed.value, error: fixed.error, stale: fixed.stale, svg: !!fixed.svg },
    { value: DOT_SRC, error: null, stale: false, svg: true });
}, { md: DIAG_MD });
check('diagram-panel: 完成 writes the file in one undo step; Esc discards', DESKTOP, async (page, boot) => {
  await openDiagPanel(page, '.graphviz svg');
  await diagSelect(page, DOT_B, DOT_B + 1); await page.keyboard.type('zeta');
  await page.click('.ed-diagram-done'); await renderIdle(page);
  const after = await page.evaluate(() => ({ panel: document.querySelectorAll('.ed-diagram-panel').length,
    svg: (document.querySelector('.content .graphviz svg') || {}).textContent || '' }));
  assert.deepStrictEqual({ panel: after.panel, zeta: /zeta/.test(after.svg) }, { panel: 0, zeta: true });
  assert.strictEqual(await saveAndRead(page, boot), DIAG_MD.replace('a -> b', 'a -> zeta'));
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), DIAG_MD, 'one Ctrl+Z takes the whole panel edit back');
  // Esc: nothing written, no render, the diagram back as it was, no theme
  // listener left behind.
  const listeners = await page.evaluate(() => window.md2docTheme.__listenerCount());
  await openDiagPanel(page, '.graphviz svg');
  await diagSelect(page, DOT_B, DOT_B + 1); await page.keyboard.type('omega');
  const before = renderTotal(page);
  await page.keyboard.press('Escape'); await renderIdle(page);
  const esc = await page.evaluate(() => ({ panel: document.querySelectorAll('.ed-diagram-panel').length,
    svg: (document.querySelector('.content .graphviz svg') || {}).textContent || '',
    status: document.querySelector('.ed-toolbar-status').getAttribute('data-state'),
    listeners: window.md2docTheme.__listenerCount() }));
  assert.deepStrictEqual({ panel: esc.panel, b: /\bb\b/.test(esc.svg), omega: /omega/.test(esc.svg), status: esc.status,
    listeners: esc.listeners, renders: renderTotal(page) - before },
  { panel: 0, b: true, omega: false, status: 'clean', listeners, renders: 0 });
  assert.strictEqual(fs.readFileSync(boot.mdPath, 'utf8'), DIAG_MD);
}, { md: DIAG_MD });
// v3.17.0 final review I2 (Esc then Ctrl+Z brings the typed source back) is
// the v3.17.2 B3 check near the end of this file: the panel opens again now,
// not the raw box.
check('diagram-panel: a click elsewhere commits', DESKTOP, async (page, boot) => {
  await openDiagPanel(page, '.graphviz svg');
  await diagSelect(page, DOT_B, DOT_B + 1); await page.keyboard.type('zeta');
  await clickText(page, 'Omega.'); await renderIdle(page);
  assert.strictEqual(await diagPanel(page), null, 'the panel closed');
  assert.strictEqual(await saveAndRead(page, boot), DIAG_MD.replace('a -> b', 'a -> zeta'));
}, { md: DIAG_MD });
// Review Focus 4: the first preview request is held 1200 ms, every later one
// answers at once; the slow older answer lands after the newer one and must
// not replace it.
check('diagram-panel: a slow older preview never replaces a newer one', DESKTOP, async (page) => {
  await openDiagPanel(page, '.graphviz svg');
  let n = 0;
  await page.route('**/api/preview', async (route) => {
    if (n++ === 0) await wait(1200);
    await route.continue();
  });
  await diagSelect(page, DOT_B + 1);
  await page.keyboard.type('x'); await wait(600); await page.keyboard.type('y');
  await wait(2000);
  const s = await diagPanel(page);
  assert.deepStrictEqual({ value: s.value, requests: n, newest: /\bbxy\b/.test(s.svg || ''), stale: s.stale, error: s.error },
    { value: 'digraph { a -> bxy }', requests: 2, newest: true, stale: false, error: null });
}, { md: DIAG_MD });
check('diagram-panel: Mermaid previews in the browser and commits', DESKTOP, async (page, boot) => {
  const previews = [];
  page.on('request', (r) => { if (/\/api\/preview$/.test(r.url())) previews.push(r.url()); });
  const s = await openDiagPanel(page, '.mermaid svg');
  assert.ok(s, 'a panel opened');
  assert.deepStrictEqual({ value: s.value, svg: !!s.svg && /\bA\b/.test(s.svg) && /\bB\b/.test(s.svg), head: s.head.indexOf('Mermaid') !== -1 },
    { value: 'graph TD\n  A --> B', svg: true, head: true });
  await diagSelect(page, s.value.length - 1, s.value.length); await page.keyboard.type('Zed');
  await wait(1500);
  const t = await diagPanel(page);
  assert.deepStrictEqual({ value: t.value, zed: /Zed/.test(t.svg || ''), stale: t.stale, error: t.error },
    { value: 'graph TD\n  A --> Zed', zed: true, stale: false, error: null });
  assert.deepStrictEqual(previews, [], 'Mermaid never asks the server');
  // A Mermaid syntax error keeps the preview too.
  await page.keyboard.type(' -->'); await wait(1500);
  const bad = await diagPanel(page);
  assert.deepStrictEqual({ stale: bad.stale, kept: /Zed/.test(bad.svg || ''), error: !!bad.error && bad.error.indexOf('\n') === -1 },
    { stale: true, kept: true, error: true });
  await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
  await page.click('.ed-diagram-done'); await renderIdle(page);
  assert.strictEqual(await diagPanel(page), null, 'the panel closed');
  assert.strictEqual(await saveAndRead(page, boot), DIAG_MD.replace('A --> B', 'A --> Zed'));
}, { md: DIAG_MD });
check('diagram-panel: the preview follows dark mode', DESKTOP, async (page) => {
  // A real press on the toggle: it keeps focus where it is and its click is
  // not "outside any block", so the panel stays open across the switch.
  const toggle = () => page.locator('#md2doc-theme-toggle').click();
  await openDiagPanel(page, '.graphviz svg');
  await toggle(); await wait(400);
  assert.deepStrictEqual(await diagPanel(page).then((s) => s && s.focused), true, 'guard: the panel is open and keeps focus');
  const g = await page.evaluate(() => {
    const svg = document.querySelector('.ed-diagram-preview svg');
    return { dark: document.documentElement.getAttribute('data-md2doc-theme'), recoloured: !!svg && svg.hasAttribute('data-md2doc-recoloured') };
  });
  assert.deepStrictEqual(g, { dark: 'dark', recoloured: true });
  await toggle(); await wait(400);
  assert.strictEqual(await page.evaluate(() => document.querySelector('.ed-diagram-preview svg').hasAttribute('data-md2doc-recoloured')), false,
    'back to light: the recolour is taken off');
  await page.keyboard.press('Escape'); await renderIdle(page);
  // Mermaid: drawn again in the new theme (a new svg node), with focus left
  // on the preview itself: the redraw writes its children, never the
  // preview, so no focus event at all (detach census row).
  await openDiagPanel(page, '.mermaid svg');
  await page.evaluate(() => {
    const pv = document.querySelector('.ed-diagram-preview');
    pv.querySelector('svg').__old = true;
    pv.focus();
    window.__diagFocusouts = 0;
    document.addEventListener('focusout', () => { window.__diagFocusouts++; }, true);
  });
  await toggle(); await wait(1500);
  const m = await page.evaluate(() => {
    const pv = document.querySelector('.ed-diagram-preview');
    const svg = pv && pv.querySelector('svg');
    return { svg: !!svg, replaced: !!svg && !svg.__old, focusouts: window.__diagFocusouts, active: document.activeElement === pv };
  });
  assert.deepStrictEqual(m, { svg: true, replaced: true, focusouts: 0, active: true });
  assert.ok(await diagPanel(page), 'the panel is still open');
}, { md: DIAG_MD });
// R56 (a): an empty answer is "nothing to show": the last preview stays,
// marked stale, and the line says so — never a blank success.
check('diagram-panel: an empty source or an empty svg answer keeps the last preview', DESKTOP, async (page) => {
  await openDiagPanel(page, '.graphviz svg');
  await page.route('**/api/preview', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"svg":""}' }));
  await diagSelect(page, DOT_B, DOT_B + 1); await page.keyboard.type('c');
  await wait(1500);
  const a = await diagPanel(page);
  assert.deepStrictEqual({ kept: !!a.svg && /\bb\b/.test(a.svg), stale: a.stale, error: a.error, kind: a.errorKind },
    { kept: true, stale: true, error: '沒有可預覽的內容', kind: 'empty' });
  await page.unroute('**/api/preview');
  await page.keyboard.press('Control+a'); await page.keyboard.press('Backspace');
  await wait(1500);
  const b = await diagPanel(page);
  assert.deepStrictEqual({ value: b.value, kept: !!b.svg, stale: b.stale, error: b.error, kind: b.errorKind },
    { value: '', kept: true, stale: true, error: '沒有可預覽的內容', kind: 'empty' });
  // Any other answer is the generic line (R31).
  await page.route('**/api/preview', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  await page.keyboard.type(DOT_SRC); await wait(1500);
  const c = await diagPanel(page);
  assert.deepStrictEqual({ error: c.error, kind: c.errorKind, stale: c.stale }, { error: '預覽失敗（伺服器沒有回應）', kind: 'error', stale: true });
}, { md: DIAG_MD });
// R56 (c) / R48: Ctrl+S saves and the panel stays open where the caret was;
// keys typed while that render is out land in the source in order.
check('diagram-panel: Ctrl+S saves and keeps the panel open; typing on lands in the source', DESKTOP, async (page, boot) => {
  await openDiagPanel(page, '.graphviz svg');
  await diagSelect(page, DOT_B, DOT_B + 1); await page.keyboard.type('zeta');
  await page.keyboard.press('Control+s'); await renderIdle(page);
  assert.strictEqual(await saveStateUntil(page, 'clean'), 'clean', 'the save landed');
  assert.strictEqual(fs.readFileSync(boot.mdPath, 'utf8'), DIAG_MD.replace('a -> b', 'a -> zeta'));
  const s = await diagPanel(page);
  assert.deepStrictEqual({ value: s.value, caret: s.caret, focused: s.focused }, { value: 'digraph { a -> zeta }', caret: 19, focused: true },
    'the panel is open again at the same caret');
  await delayRender(page, 800);
  await page.keyboard.press('Control+s');
  await page.keyboard.type('rs'); await page.keyboard.press('Enter'); await page.keyboard.type('t');
  await renderIdle(page);
  const t = await diagPanel(page);
  assert.deepStrictEqual({ value: t.value, caret: t.caret, focused: t.focused, notice: await noticeText(page) },
    { value: 'digraph { a -> zetars\nt }', caret: 23, focused: true, notice: null });
  await page.keyboard.press('Control+s'); await renderIdle(page);
  assert.strictEqual(await diskUntil(boot, DIAG_MD.replace('a -> b', 'a -> zetars\nt')), DIAG_MD.replace('a -> b', 'a -> zetars\nt'));
  assert.strictEqual(await saveStateUntil(page, 'clean'), 'clean');
}, { md: DIAG_MD });
// R56 (d) / R47: typed source not yet committed is unsaved work.
check('diagram-panel: typing in the open panel marks the document unsaved (R47)', DESKTOP, async (page) => {
  const state = () => page.evaluate(() => {
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    return { title: document.title.charAt(0) === '●', status: document.querySelector('.ed-toolbar-status').getAttribute('data-state'),
      guard: ev.defaultPrevented };
  });
  await openDiagPanel(page, '.graphviz svg');
  assert.deepStrictEqual(await state(), { title: false, status: 'clean', guard: false }, 'guard: clean on open');
  await diagSelect(page, DOT_SRC.length); await page.keyboard.type('q');
  assert.deepStrictEqual(await state(), { title: true, status: 'dirty', guard: true }, 'typed, not left');
  await page.keyboard.press('Backspace');
  assert.deepStrictEqual(await state(), { title: false, status: 'clean', guard: false }, 'back to the opened text');
  await page.keyboard.type('q');
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.deepStrictEqual(await state(), { title: false, status: 'clean', guard: false }, 'Esc discarded it');
}, { md: DIAG_MD });
// R36 / R25: Tab inserts two spaces; Ctrl+Z steps the textarea's own text and
// never the document; a press on the header keeps the panel open.
check('diagram-panel: Tab inserts two spaces and Ctrl+Z never reaches the document', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Omega.', 6); await page.keyboard.type('X');
  await openDiagPanel(page, '.graphviz svg');
  await diagSelect(page, DOT_SRC.length - 1);
  await page.keyboard.press('Tab');
  assert.deepStrictEqual(await diagPanel(page).then((s) => ({ value: s.value, caret: s.caret, focused: s.focused })),
    { value: 'digraph { a -> b   }', caret: DOT_SRC.length + 1, focused: true });
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual((await diagPanel(page)).value, DOT_SRC, 'the textarea stepped its own text');
  assert.strictEqual(await page.evaluate(() => [...document.querySelectorAll('.ed-wys-armed')].some((e) => e.textContent === 'Omega.X')),
    true, 'the paragraph keeps its edit: the document stack was not touched');
  await page.click('.ed-diagram-hint'); await wait(200);
  assert.deepStrictEqual(await diagPanel(page).then((s) => ({ open: true, focused: s.focused })), { open: true, focused: true },
    'a press on the header keeps the panel and its focus');
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), DIAG_MD.replace('Omega.', 'Omega.X'));
}, { md: DIAG_MD });
// R27 (3): a commit whose render fails keeps the panel open on its text.
check('diagram-panel: a commit whose render fails keeps the panel open with its text (R27)', DESKTOP, async (page, boot) => {
  await openDiagPanel(page, '.graphviz svg');
  await diagSelect(page, DOT_B, DOT_B + 1); await page.keyboard.type('zeta');
  await failFirstRender(page);
  await page.click('.ed-diagram-done'); await wait(1200); await renderIdle(page);
  const s = await diagPanel(page);
  assert.deepStrictEqual({ card: await errorCardUp(page), value: s && s.value }, { card: true, value: 'digraph { a -> zeta }' });
  await page.click('.ed-diagram-done'); await renderIdle(page);
  assert.strictEqual(await diagPanel(page), null);
  assert.strictEqual(await saveAndRead(page, boot), DIAG_MD.replace('a -> b', 'a -> zeta'));
}, { md: DIAG_MD });
// Fix round 1 (I1): Ctrl+S on a Graphviz source that does not parse. The
// saved block renders as plain code, not a diagram; the panel still opens
// again on it, with what was typed while the save was out, and the preview
// keeps saying what is wrong.
check('diagram-panel: Ctrl+S on a source with a syntax error keeps the panel open with the typing', DESKTOP, async (page, boot) => {
  await openDiagPanel(page, '.graphviz svg');
  await diagSelect(page, DOT_SRC.length); await page.keyboard.press('Backspace');
  await delayRender(page, 800);
  await page.keyboard.press('Control+s');
  await page.keyboard.type('cd');
  await renderIdle(page);
  const BROKEN = DIAG_MD.replace(DOT_SRC, 'digraph { a -> b ');
  assert.strictEqual(await diskUntil(boot, BROKEN), BROKEN, 'the save wrote the source as it was at Ctrl+S');
  await wait(1500);
  const s = await diagPanel(page);
  assert.ok(s, 'the panel is open again');
  assert.deepStrictEqual({ value: s.value, caret: s.caret, focused: s.focused, notice: await noticeText(page) },
    { value: 'digraph { a -> b cd', caret: 19, focused: true, notice: null });
  assert.ok(/syntax error/.test(s.error || ''), 'the error line: ' + JSON.stringify(s.error));
  assert.strictEqual(s.head.indexOf('Graphviz') !== -1, true, 'still the Graphviz panel');
  // Fixed and left, it renders as a diagram again.
  await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await page.keyboard.type('}');
  await page.click('.ed-diagram-done'); await renderIdle(page);
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.content .graphviz svg').length), 1);
  assert.strictEqual(await saveAndRead(page, boot), DIAG_MD);
}, { md: DIAG_MD });
// R58 (fix round 1, M2): switching the theme is not leaving what is being
// edited — a code edit and a paragraph keep their focus and their typing.
check('theme: the toggle keeps an open code edit and a paragraph edit open with their typing (R58)', DESKTOP, async (page, boot) => {
  const toggle = () => page.locator('#md2doc-theme-toggle').click();
  await clickText(page, 'endmodule'); await page.keyboard.type('q');
  await toggle(); await wait(300);
  assert.strictEqual(await page.evaluate(() => document.documentElement.getAttribute('data-md2doc-theme')), 'dark', 'guard: dark');
  assert.deepStrictEqual(await codeEdit(page), { text: 'module m;\nendmoduleq', caret: 20, focused: true }, 'the code edit is open, typing kept');
  await page.keyboard.type('r');
  assert.strictEqual((await codeEdit(page)).text, 'module m;\nendmoduleqr', 'typing goes on in the code');
  await page.keyboard.press('Escape'); await renderIdle(page);
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.type('X');
  const before = renderTotal(page);
  await toggle(); await wait(300);
  const p = await page.evaluate(() => {
    const a = document.activeElement;
    return { focused: !!a && a.classList.contains('ed-wys-armed'), text: a ? a.textContent : null };
  });
  assert.deepStrictEqual(Object.assign(p, { renders: renderTotal(page) - before }), { focused: true, text: 'Alpha.X', renders: 0 },
    'the paragraph keeps focus and its typing, nothing committed by the toggle');
  await page.keyboard.type('Y');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.XY\n\n```verilog\nmodule m;\nendmoduleqr\n```\n\nOmega.\n');
}, { md: CODE_MD });
// Fix round 1 (M4): Esc puts the diagram back drawn for the theme on screen.
// A Mermaid host is drawn again once (the runtime adopts the restored node),
// and the next toggle redraws it; a Graphviz svg opened in dark and closed in
// light loses the dark recolour.
check('diagram-panel: Esc puts the diagram back drawn for the theme now on screen', DESKTOP, async (page) => {
  const toggle = () => page.locator('#md2doc-theme-toggle').click();
  await openDiagPanel(page, '.mermaid svg');
  await toggle(); await wait(1500);
  await page.evaluate(() => {
    window.__mmRenders = 0;
    const orig = window.mermaid.render.bind(window.mermaid);
    window.mermaid.render = (...a) => { window.__mmRenders++; return orig(...a); };
  });
  await page.keyboard.press('Escape'); await wait(1500);
  const read = () => page.evaluate(() => {
    const svg = document.querySelector('.content .mermaid svg');
    const r = svg ? svg.getBoundingClientRect() : null;
    return { panel: document.querySelectorAll('.ed-diagram-panel').length, visible: !!r && r.width > 0 && r.height > 0,
      live: !!svg && svg.hasAttribute('data-md2doc-live'), renders: window.__mmRenders };
  });
  assert.deepStrictEqual(await read(), { panel: 0, visible: true, live: true, renders: 1 }, 'drawn once, dark');
  await toggle(); await wait(1500);
  const light = await read();
  assert.deepStrictEqual({ visible: light.visible, live: light.live }, { visible: true, live: false }, 'the next toggle redraws it light');
  // Graphviz: opened in dark, closed in light.
  await toggle(); await wait(400);
  await openDiagPanel(page, '.graphviz svg');
  await toggle(); await wait(400);
  assert.strictEqual(await page.evaluate(() => document.documentElement.getAttribute('data-md2doc-theme')), null, 'guard: light');
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.deepStrictEqual(await page.evaluate(() => {
    const svg = document.querySelector('.content .graphviz svg');
    return { svg: !!svg, recoloured: !!svg && svg.hasAttribute('data-md2doc-recoloured') };
  }), { svg: true, recoloured: false });
}, { md: DIAG_MD });
// R44: a page with no Mermaid at load: the engine arrives with the first
// inserted block, and the panel previews through it.
check('diagram-panel: a Mermaid block added to a page without Mermaid previews in the panel', DESKTOP, async (page) => {
  assert.strictEqual(await page.evaluate(() => typeof window.mermaid), 'undefined', 'guard: not loaded at start');
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('/mer'); await page.keyboard.press('Enter'); await renderIdle(page);
  const s = await openDiagPanel(page, '.mermaid svg');
  assert.ok(s && s.svg && s.error === null && !s.stale, 'previewed: ' + JSON.stringify(s));
  assert.ok(s.head.indexOf('Mermaid') !== -1);
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.strictEqual(await diagPanel(page), null);
}, { md: BASE_MD });

// ── v3.17.0 T7: the image toolbar (D16–D18) ──
// A real 160x100 PNG, so the hover geometry has a picture to be inside of.
const PNG_160 = (() => {
  const zlib = require('zlib');
  const w = 160, h = 100;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 200; raw[o + 1] = 80 + (x % 60); raw[o + 2] = 90; }
  }
  const crcTable = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
})();
const IMG_MD = '# D\n\nAlpha.\n\n![chip top](assets/a.png "T")\n\nOmega.\n';
const IMG_OPTS = { md: IMG_MD, assets: { 'assets/a.png': PNG_160 } };
const IMG_SEL = '.content .ed-block[data-block-type="paragraph"] img';
const imgTbState = (page) => page.evaluate(() => {
  const t = document.querySelector('.ed-imgtb');
  if (!t || t.hidden) return null;
  const img = document.querySelector('.content .ed-block img');
  const r = t.getBoundingClientRect(), p = img.getBoundingClientRect();
  const probe = document.createElement('span');
  probe.style.color = 'var(--md-ed-err)';
  document.body.appendChild(probe);
  const errColour = getComputedStyle(probe).color;
  probe.remove();
  const btns = [...t.querySelectorAll('.ed-imgtb-btn')];
  const del = btns.find((b) => b.textContent === '刪除');
  const hit = document.elementFromPoint(r.left + 4, r.top + 4);
  return {
    left: Math.round(r.left - p.left), top: Math.round(r.top - p.top), texts: btns.map((b) => b.textContent),
    delErr: !!del && getComputedStyle(del).color === errColour, inContent: !!t.closest('.content'),
    hit: !!hit && !!hit.closest('.ed-imgtb'), imgW: Math.round(p.width), imgH: Math.round(p.height),
    inputShown: !!t.querySelector('.ed-imgtb-input') && !t.querySelector('.ed-imgtb-input').hidden,
  };
});
const hoverImg = async (page) => { await page.hover(IMG_SEL); await wait(250); };
const imgTbBtn = (page, label) => page.locator('.ed-imgtb-btn', { hasText: label });
const openAlt = async (page) => {
  await hoverImg(page);
  await imgTbBtn(page, '替代文字').click(); await wait(300);
  assert.strictEqual((await imgTbState(page)).inputShown, true, 'guard: the alt input is showing');
};
check('image-toolbar: hovering an image shows 替換 替代文字 刪除 at its top-left', DESKTOP, async (page) => {
  assert.strictEqual(await imgTbState(page), null, 'guard: no toolbar while the pointer is elsewhere');
  await hoverImg(page);
  const s = await imgTbState(page);
  assert.ok(s, 'toolbar shown');
  assert.ok(s.left >= 6 && s.left <= 10 && s.top >= 6 && s.top <= 10, 'inset from the image corner: ' + JSON.stringify(s));
  assert.deepStrictEqual({ texts: s.texts, delErr: s.delErr, inContent: s.inContent, hit: s.hit, size: [s.imgW, s.imgH] },
    { texts: ['替換', '替代文字', '刪除'], delErr: true, inContent: false, hit: true, size: [160, 100] });
  // The toolbar itself keeps the pointer; leaving both hides it after a moment.
  const box = await page.locator('.ed-imgtb').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await wait(450);
  assert.ok(await imgTbState(page), 'still shown with the pointer on it');
  await page.mouse.move(5, 5); await wait(150);
  assert.ok(await imgTbState(page), 'not yet hidden 150 ms after leaving');
  await wait(450);
  assert.strictEqual(await imgTbState(page), null, 'hidden after the pointer left both');
}, IMG_OPTS);
check('image-toolbar: 替代文字 rewrites only the brackets, one undo step', DESKTOP, async (page, boot) => {
  await openAlt(page);
  assert.strictEqual(await page.evaluate(() => document.querySelector('.ed-imgtb-input').value), 'chip top');
  assert.strictEqual(await page.evaluate(() => document.activeElement === document.querySelector('.ed-imgtb-input')), true, 'the input has focus');
  await page.keyboard.type('new words'); await page.keyboard.press('Enter'); await renderIdle(page);
  // (A pointer left over the re-rendered picture may bring the toolbar back: that is the hover rule.)
  await page.mouse.move(5, 5); await wait(450);
  assert.strictEqual(await imgTbState(page), null, 'toolbar gone after applying');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n![new words](assets/a.png "T")\n\nOmega.\n');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), IMG_MD, 'one Ctrl+Z restores the block');
}, IMG_OPTS);
check('image-toolbar: alt with brackets round-trips', DESKTOP, async (page, boot) => {
  await openAlt(page);
  await page.keyboard.type('p [q]'); await page.keyboard.press('Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n![p \\[q\\]](assets/a.png "T")\n\nOmega.\n');
  assert.strictEqual(await page.evaluate(() => document.querySelector('.content img').getAttribute('alt')), 'p [q]', 'renders back to the typed text');
  await openAlt(page);
  assert.strictEqual(await page.evaluate(() => document.querySelector('.ed-imgtb-input').value), 'p [q]', 'reopened: the input shows the typed text');
}, IMG_OPTS);
check('image-toolbar: Esc in the alt field changes nothing', DESKTOP, async (page, boot) => {
  await openAlt(page);
  await page.keyboard.type('zzz'); await page.keyboard.press('Escape'); await wait(300);
  const s = await imgTbState(page);
  assert.ok(!s || s.inputShown === false, 'the input is gone');
  assert.strictEqual(await saveAndRead(page, boot), IMG_MD);
  // Enter with the text unchanged writes nothing either: one Ctrl+Z has nothing to undo.
  await openAlt(page);
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), IMG_MD);
  assert.strictEqual(await page.evaluate(() => !!document.querySelector('.ed-conflict')), false, 'no message');
}, IMG_OPTS);
check('image-toolbar: Ctrl+Z in the alt field leaves the document alone', DESKTOP, async (page, boot) => {
  await openAlt(page);
  await page.keyboard.type('first'); await page.keyboard.press('Enter'); await renderIdle(page);
  await openAlt(page);
  await page.keyboard.type(' more');
  await page.keyboard.press('Control+z'); await wait(300);
  const s = await page.evaluate(() => ({ alt: document.querySelector('.content img').getAttribute('alt'),
    input: !document.querySelector('.ed-imgtb-input').hidden }));
  assert.deepStrictEqual(s, { alt: 'first', input: true }, 'the field undid its own text; the document did not move');
  await page.keyboard.press('Escape'); await wait(200);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n![first](assets/a.png "T")\n\nOmega.\n');
}, IMG_OPTS);
check('image-toolbar: 替換 rewrites only the path and keeps alt and title', DESKTOP, async (page, boot) => {
  await hoverImg(page);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), imgTbBtn(page, '替換').click()]);
  assert.strictEqual(chooser.isMultiple(), false, 'a single-file picker');
  await pickImage(page, chooser, PNG_160);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n![chip top](assets/dot.png "T")\n\nOmega.\n');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), IMG_MD, 'one Ctrl+Z restores the path');
}, IMG_OPTS);
check('image-toolbar: 替換 with a file that is not a picture writes nothing', DESKTOP, async (page, boot) => {
  let uploads = 0;
  page.on('request', (r) => { try { if (new URL(r.url()).pathname === '/api/asset') uploads++; } catch (e) { /* ignore */ } });
  await hoverImg(page);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), imgTbBtn(page, '替換').click()]);
  await chooser.setFiles({ name: 'x.drawio', mimeType: '', buffer: Buffer.from('<mxfile/>') });
  await wait(600);
  const notice = await page.evaluate(() => { const b = document.querySelector('.ed-conflict'); return b ? b.textContent : ''; });
  assert.ok(notice.indexOf('只能用圖片檔替換') !== -1, 'notice: ' + JSON.stringify(notice));
  assert.strictEqual(uploads, 0, 'nothing uploaded');
  assert.strictEqual(await saveAndRead(page, boot), IMG_MD);
}, IMG_OPTS);
// v3.17.0 final review I1: 替換 used to read the block id from the node it
// held across the file dialog. A render meanwhile replaced that node, and a
// commit above it moved every id by one, so the stale id named the picture
// above: the wrong picture was replaced, with no notice. Both renders are
// forced while the chooser is pending (the window blur a real dialog raises
// can commit a dirty paragraph elsewhere in the same way).
const IMG2_ASSETS = { 'assets/a.png': PNG_160, 'assets/b.png': PNG_160 };
const IMG2_MD = '# D\n\nAlpha.\n\n![one](assets/a.png)\n\n![two](assets/b.png)\n\nOmega.\n';
const imgConflictText = (page) => page.evaluate(() => { const b = document.querySelector('.ed-conflict'); return b ? b.textContent : ''; });
check('image-toolbar: 替換 across a render that moved the block ids replaces the picture that was pointed at (final I1)', DESKTOP, async (page, boot) => {
  await page.locator(IMG_SEL).nth(1).hover(); await wait(250);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), imgTbBtn(page, '替換').click()]);
  assert.strictEqual(await page.evaluate(() => window.__edTestForceRerender()), true, 'guard: the forced render ran');
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await page.keyboard.type('New.');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\nNew.\n\n![one](assets/a.png)\n\n![two](assets/b.png)\n\nOmega.\n',
    'guard: a paragraph landed above both pictures while the dialog was open');
  await pickImage(page, chooser, PNG_160);
  assert.strictEqual(await imgConflictText(page), '', 'no notice, no error');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\nNew.\n\n![one](assets/a.png)\n\n![two](assets/dot.png)\n\nOmega.\n');
}, { md: IMG2_MD, assets: IMG2_ASSETS });
// The same window, with a picture that has an identical twin: after the
// render it cannot be told apart, so the pick is refused with the retry
// notice, BEFORE anything is uploaded (no orphan file in assets/).
const IMG_TWIN_MD = '# D\n\nAlpha.\n\n![x](assets/a.png)\n\n![x](assets/a.png)\n\nOmega.\n';
check('image-toolbar: 替換 refuses, uploading nothing, when the picture cannot be found again after a render (final I1)', DESKTOP, async (page, boot) => {
  let uploads = 0;
  page.on('request', (r) => { try { if (new URL(r.url()).pathname === '/api/asset') uploads++; } catch (e) { /* ignore */ } });
  await page.locator(IMG_SEL).nth(1).hover(); await wait(250);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), imgTbBtn(page, '替換').click()]);
  assert.strictEqual(await page.evaluate(() => window.__edTestForceRerender()), true, 'guard: the forced render ran');
  await chooser.setFiles({ name: 'dot.png', mimeType: 'image/png', buffer: Buffer.from(PNG_160, 'base64') });
  await wait(600); await renderIdle(page);
  const notice = await imgConflictText(page);
  assert.ok(notice.indexOf('文件已更新，請重試這個操作') !== -1, 'the retry notice: ' + JSON.stringify(notice));
  assert.strictEqual(uploads, 0, 'nothing uploaded');
  assert.strictEqual(await saveAndRead(page, boot), IMG_TWIN_MD, 'nothing written');
}, { md: IMG_TWIN_MD, assets: { 'assets/a.png': PNG_160 } });
check('image-toolbar: 刪除 removes the paragraph, one undo step', DESKTOP, async (page, boot) => {
  await hoverImg(page);
  await imgTbBtn(page, '刪除').click(); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', 'paragraph:Omega.']);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\nOmega.\n');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), IMG_MD, 'one Ctrl+Z puts the image back');
}, IMG_OPTS);
check('image-toolbar: a click on the image still opens the lightbox', DESKTOP, async (page) => {
  await hoverImg(page);
  const box = await page.locator(IMG_SEL).boundingBox();
  await page.mouse.click(box.x + box.width - 20, box.y + box.height - 20); await wait(300);
  const s = await page.evaluate(() => { const l = document.querySelector('.lightbox'); return { open: !!l && !l.hidden, raw: document.querySelectorAll('.ed-raw').length }; });
  assert.deepStrictEqual(s, { open: true, raw: 0 }, 'lightbox open, no raw box');
}, IMG_OPTS);
check('image-toolbar: a paragraph with text around an image shows no toolbar', DESKTOP, async (page) => {
  const n = await page.locator('.content .ed-block img').count();
  assert.strictEqual(n, 4, 'guard: four pictures on the page');
  for (let i = 0; i < n; i++) {
    await page.locator('.content .ed-block img').nth(i).hover(); await wait(250);
    assert.strictEqual(await imgTbState(page), null, 'no toolbar over picture ' + i);
  }
}, { md: '# D\n\nSee ![a](assets/a.png) here.\n\n[![b](assets/a.png)](http://example.com)\n\n![c](assets/a.png) ![d](assets/a.png)\n', assets: { 'assets/a.png': PNG_160 } });

// ── v3.17.0 T8: a dropped picture on a picture replaces it ──
const dropPngOn = (page, selector, b64) => page.evaluate(({ sel, b64 }) => {
  const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const dt = new DataTransfer(); dt.items.add(new File([u], 'dot.png', { type: 'image/png' }));
  const target = document.querySelector(sel);
  target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
}, { sel: selector, b64 });
check('image-drop: a PNG dropped on an image replaces its path', DESKTOP, async (page, boot) => {
  const before = await blockList(page);
  await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/asset'),
    dropPngOn(page, IMG_SEL, PNG_160),
  ]);
  await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n![chip top](assets/dot.png "T")\n\nOmega.\n');
  assert.strictEqual((await blockList(page)).length, before.length, 'block count unchanged');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), IMG_MD, 'one Ctrl+Z restores the path');
}, IMG_OPTS);
check('image-drop: a PNG dropped on a paragraph still inserts below it', DESKTOP, async (page, boot) => {
  await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/asset'),
    dropPngOn(page, '.content .ed-block[data-block-type="paragraph"]', PNG_160),
  ]);
  await renderIdle(page);
  const disk = await saveAndRead(page, boot);
  assert.ok(/^# D\n\nAlpha\.\n\n!\[\]\(assets\/dot(-\d+)?\.png\)\n\n!\[chip top\]\(assets\/a\.png "T"\)\n\nOmega\.\n$/.test(disk), 'file: ' + JSON.stringify(disk));
}, IMG_OPTS);
// v3.17.0 T9a (R61, D18): only a raster picture replaces; a .drawio dropped
// on a picture is inserted below it, and the picture keeps its path.
check('image-drop: a .drawio dropped on an image still inserts below it', DESKTOP, async (page, boot) => {
  const MX = '<mxfile host="app.diagrams.net"><diagram name="Page-1"><mxGraphModel dx="1" dy="1"><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
  await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/asset'),
    page.evaluate(({ sel, text }) => {
      const dt = new DataTransfer(); dt.items.add(new File([text], 'flow.drawio', { type: '' }));
      document.querySelector(sel).dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, { sel: IMG_SEL, text: MX }),
  ]);
  await renderIdle(page);
  assert.strictEqual(await noticeText(page), null, 'no notice');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n![chip top](assets/a.png "T")\n\n![](assets/flow.drawio)\n\nOmega.\n');
}, IMG_OPTS);

// ── v3.17.0 T9b: timing races around commit renders ──
// R50: a press on a degraded block right after typing in a paragraph blurs
// the paragraph, and that paragraph's commit render can land before the
// button comes up. When it replaced the pressed block, no click followed
// (wireBlockSelection()'s trace) and nothing opened. The button is held down
// here until the pressed block has left the document, so the render lands
// inside the press by construction, not by load; the helper returns whether
// it did (the checks' guard).
async function pressTextAcrossRender(page, text) {
  const pt = await page.evaluate((t) => {
    const root = document.querySelector('.content');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.indexOf(t);
      if (i === -1) continue;
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + t.length);
      const b = r.getBoundingClientRect();
      const x = b.left + b.width / 2, y = b.top + b.height / 2;
      const block = n.parentElement.closest('.ed-block');
      const hit = document.elementFromPoint(x, y);
      window.__t9bPressed = block;
      return { x, y, same: !!(block && hit && block.contains(hit)) };
    }
    return null;
  }, text);
  assert.ok(pt && pt.same, 'pressTextAcrossRender: the point over ' + JSON.stringify(text) + ' hits its block');
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  let gone = false;
  for (let i = 0; i < 100 && !gone; i++) {
    gone = await page.evaluate(() => !window.__t9bPressed.isConnected);
    if (!gone) await wait(50);
  }
  await page.mouse.up();
  return gone;
}
check('degraded-press: a click on a code block straight after typing in a paragraph opens the code edit (R50)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.type('X');
  assert.strictEqual(await pressTextAcrossRender(page, 'endmodule'), true, 'guard: the paragraph\'s commit render replaced the pressed block before the release');
  await renderIdle(page); await wait(300);
  assert.deepStrictEqual({ edit: await codeEdit(page), notice: await noticeText(page) },
    { edit: { text: 'module m;\nendmodule', caret: 0, focused: true }, notice: null }, 'the press opened the code edit');
  await page.keyboard.type('q'); await page.keyboard.press('Escape'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), CODE_MD.replace('Alpha.', 'Alpha.X').replace('module m;', 'qmodule m;'));
}, { md: CODE_MD });
check('degraded-press: a click on a quote straight after typing in a paragraph opens its box (R50)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.type('X');
  assert.strictEqual(await pressTextAcrossRender(page, 'Quote line.'), true, 'guard: the paragraph\'s commit render replaced the pressed block before the release');
  await renderIdle(page); await wait(300);
  const box = await page.evaluate(() => { const t = document.querySelector('textarea.ed-raw'); return t ? { value: t.value, focused: document.activeElement === t } : null; });
  assert.deepStrictEqual({ box, notice: await noticeText(page) }, { box: { value: '> Quote line.', focused: true }, notice: null }, 'the press opened the box');
  await page.keyboard.press('Control+a'); await page.keyboard.type('> NEW');
  await page.keyboard.press('Control+Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.X\n\n> NEW\n\nOmega.\n');
}, { md: '# D\n\nAlpha.\n\n> Quote line.\n\nOmega.\n' });
// The re-find is R104's: with an identical twin the press cannot tell which
// one it was on, so it opens neither and says so (it used to say nothing).
check('degraded-press: a lost click on the first of two identical code blocks opens neither and shows the retry notice (R50, R104)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.type('X');
  assert.strictEqual(await pressTextAcrossRender(page, 'twin'), true, 'guard: the paragraph\'s commit render replaced the pressed block before the release');
  await renderIdle(page); await wait(300);
  assert.deepStrictEqual({ edit: await codeEdit(page), raw: await page.evaluate(() => document.querySelectorAll('textarea.ed-raw').length), notice: await noticeText(page) },
    { edit: null, raw: 0, notice: '文件已更新，請重試這個操作' });
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.X\n\n```\ntwin\n```\n\n```\ntwin\n```\n', 'only the paragraph\'s commit is written');
}, { md: '# D\n\nAlpha.\n\n```\ntwin\n```\n\n```\ntwin\n```\n' });

// v3.17.0 T10 (ER 'Esc out of a raw editor is recoverable', surfaced by T9a's
// hand-on): the caret an Esc hands to a transient above a code block must not
// swallow the Ctrl+Z that restores the discarded text.
check('raw-box: Ctrl+Z after Esc out of a quote box above a code block restores the discarded text (M-f, T10)', DESKTOP, async (page, boot) => {
  await page.locator('blockquote').click(); await renderIdle(page);
  assert.strictEqual((await rawBox(page) || {}).focused, true, 'guard: the box is open');
  await page.keyboard.type(' DROPPED'); await page.keyboard.press('Escape'); await renderIdle(page);
  assert.deepStrictEqual({ box: await rawBox(page), transients: await transientCount(page) }, { box: null, transients: 1 }, 'guard: Esc left a transient with the caret');
  await page.keyboard.press('Control+z'); await renderIdle(page); await wait(300);
  const box = await rawBox(page);
  assert.ok(box && box.value.indexOf('DROPPED') !== -1, 'the box is back with the text: ' + JSON.stringify(box));
  assert.strictEqual(await transientCount(page), 0, 'the transient went');
  assert.strictEqual(fs.readFileSync(boot.mdPath, 'utf8'), '# D\n\nAlpha.\n\n> Quote line.\n\n```\nc\n```\n\nOmega.\n', 'nothing written');
}, { md: '# D\n\nAlpha.\n\n> Quote line.\n\n```\nc\n```\n\nOmega.\n' });
// v3.17.0 T10 (M1): the release path takes the click router's gutter-band
// rule. The press is in the band left of the code block (the block's own
// box), held until the paragraph's commit render replaced the block, released
// over the new block's band: nothing opens, as a click there never did.
async function pressBandAcrossRender(page, text) {
  const pt = await page.evaluate((t) => {
    const pre = [...document.querySelectorAll('.ed-block[data-block-type="code"]')].find((b) => b.textContent.indexOf(t) !== -1);
    const r = pre.getBoundingClientRect();
    const bs = getComputedStyle(pre, '::before');
    // Low in the band: the ＋ / ⠿ pair sits at its top.
    const x = r.left + parseFloat(bs.left) + parseFloat(bs.width) / 2, y = r.bottom - 4;
    window.__t10Pressed = pre;
    const hit = document.elementFromPoint(x, y);
    return { x, y, same: hit === pre, hit: hit ? hit.tagName + '.' + hit.className : null, band: [bs.left, bs.width] };
  }, text);
  assert.ok(pt.same, 'pressBandAcrossRender: the lower middle of the ::before band hits the block itself: ' + JSON.stringify(pt));
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  let gone = false;
  for (let i = 0; i < 100 && !gone; i++) {
    gone = await page.evaluate(() => !window.__t10Pressed.isConnected);
    if (!gone) await wait(50);
  }
  await page.mouse.up();
  return gone;
}
check('degraded-press: a release in the gutter band of a code block opens nothing (R50, M1)', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.type('X');
  assert.strictEqual(await pressBandAcrossRender(page, 'endmodule'), true, 'guard: the paragraph\'s commit render replaced the pressed block before the release');
  await renderIdle(page); await wait(300);
  assert.deepStrictEqual({ edit: await codeEdit(page), raw: await page.evaluate(() => document.querySelectorAll('textarea.ed-raw').length), notice: await noticeText(page) },
    { edit: null, raw: 0, notice: null });
  assert.strictEqual(await saveAndRead(page, boot), CODE_MD.replace('Alpha.', 'Alpha.X'));
}, { md: CODE_MD });
// v3.17.0 T10 (M2): the release that opened the block answers its own click
// only. A click with no press of its own (a keyboard activation, a script)
// came next and was swallowed once.
check('degraded-press: a click with no press after a release that opened the edit is not swallowed (R50, M2)', DESKTOP, async (page) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.type('X');
  assert.strictEqual(await pressTextAcrossRender(page, 'endmodule'), true, 'guard: the paragraph\'s commit render replaced the pressed block before the release');
  await renderIdle(page); await wait(300);
  assert.strictEqual((await codeEditUntil(page) || {}).focused, true, 'guard: the release opened the code edit');
  await page.evaluate(() => document.querySelector('blockquote').click());
  await renderIdle(page); await wait(300);
  assert.deepStrictEqual({ box: await rawBox(page) && (await rawBox(page)).value, edit: await codeEdit(page) },
    { box: '> Quote line.', edit: null }, 'the programmatic click opened the quote');
}, { md: '# D\n\nAlpha.\n\n```verilog\nmodule m;\nendmodule\n```\n\n> Quote line.\n\nOmega.\n' });

// The /api/save answers, in the order they arrived (node side), for the
// checks below; `slowSaves` holds every save 300 ms before it reaches the
// server, so two that overlap overlap by construction.
function recordSaves(page) {
  const statuses = [];
  page.on('response', (r) => { try { if (new URL(r.url()).pathname === '/api/save') statuses.push(r.status()); } catch (e) { /* ignore */ } });
  return statuses;
}
async function slowSaves(page) {
  await page.route('**/api/save', async (route) => { await wait(300); await route.continue(); });
}
async function savesUntil(statuses, n) {
  const deadline = Date.now() + 10000;
  while (statuses.length < n && Date.now() < deadline) await wait(50);
  await wait(400); // and any later one
  return statuses.slice();
}
// The focused surface's text and whether a code edit / diagram panel is open.
const t9bFocus = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return { tag: a ? a.tagName : null, text: a && a.matches && a.matches('.ed-wys-armed') ? a.textContent : null,
    code: !!document.querySelector('pre[data-ed-code-edit]'), panel: !!document.querySelector('.ed-diagram-panel') };
});

// T9b item 2 (Task 2 re-review; T5 M6): keys are held while the Ctrl+S
// re-enter render is out and replayed into the reopened edit. A click that
// put the caret in another paragraph meanwhile stops that: what is typed
// after it goes there (the v3.13.1 rule: an entry a click positioned
// elsewhere is not the edit's), and the edit is not opened again over it.
check('code-edit: a click on another paragraph during the Ctrl+S render takes the typing there and keeps focus there (T9b)', DESKTOP, async (page, boot) => {
  await clickText(page, 'endmodule'); await page.keyboard.type('q');
  await delayRender(page, 800);
  await page.keyboard.press('Control+s'); await wait(100);
  await clickText(page, 'Omega.'); await page.keyboard.type('z');
  await renderIdle(page); await wait(300); await renderIdle(page);
  assert.strictEqual(await diskUntil(boot, CODE_MD.replace('endmodule', 'endmoduleq')), CODE_MD.replace('endmodule', 'endmoduleq'), 'the save wrote the code edit');
  assert.deepStrictEqual({ focus: await t9bFocus(page), notice: await noticeText(page) },
    { focus: { tag: 'P', text: 'Omega.z', code: false, panel: false }, notice: null });
  assert.strictEqual(await commitAndRead(page, boot), CODE_MD.replace('endmodule', 'endmoduleq').replace('Omega.', 'Omega.z'));
}, { md: CODE_MD });
check('diagram-panel: a click on a paragraph during the Ctrl+S render takes the typing there and keeps focus there (T9b, T5 M6)', DESKTOP, async (page, boot) => {
  await openDiagPanel(page, '.graphviz svg');
  await diagSelect(page, DOT_B, DOT_B + 1); await page.keyboard.type('zeta');
  await delayRender(page, 800);
  await page.keyboard.press('Control+s'); await wait(100);
  await clickText(page, 'Omega.'); await page.keyboard.type('z');
  await renderIdle(page); await wait(300); await renderIdle(page);
  assert.strictEqual(await diskUntil(boot, DIAG_MD.replace('a -> b', 'a -> zeta')), DIAG_MD.replace('a -> b', 'a -> zeta'), 'the save wrote the panel');
  assert.deepStrictEqual({ focus: await t9bFocus(page), notice: await noticeText(page) },
    { focus: { tag: 'P', text: 'Omega.z', code: false, panel: false }, notice: null });
  assert.strictEqual(await commitAndRead(page, boot), DIAG_MD.replace('a -> b', 'a -> zeta').replace('Omega.', 'Omega.z'));
}, { md: DIAG_MD });

// T9b item 3: a second Ctrl+S inside the hold used to send its save while
// the first was still out; the server 409s the stale baseline and the page
// showed the conflict card over a correctly saved file. It waits now.
check('code-edit: a second Ctrl+S during the Ctrl+S render saves after the first, no 409 and no conflict card (T9b)', DESKTOP, async (page, boot) => {
  const statuses = recordSaves(page);
  await clickText(page, 'endmodule'); await page.keyboard.type('q');
  await delayRender(page, 800); await slowSaves(page);
  await page.keyboard.press('Control+s'); await page.keyboard.press('Control+s');
  await renderIdle(page);
  assert.deepStrictEqual({ saves: await savesUntil(statuses, 2), status: await saveStateUntil(page, 'clean'), notice: await noticeText(page), edit: await codeEdit(page) },
    { saves: [200, 200], status: 'clean', notice: null, edit: { text: 'module m;\nendmoduleq', caret: 20, focused: true } });
  assert.strictEqual(fs.readFileSync(boot.mdPath, 'utf8'), CODE_MD.replace('endmodule', 'endmoduleq'));
}, { md: CODE_MD });
check('code-edit: Esc and a second Ctrl+S during the Ctrl+S render leave the edit and save, never reopening it (T9b)', DESKTOP, async (page, boot) => {
  const statuses = recordSaves(page);
  await clickText(page, 'endmodule'); await page.keyboard.type('q');
  await delayRender(page, 800); await slowSaves(page);
  // Every time a host becomes the code edit (the attribute added, not removed):
  // the end state alone cannot tell, because a reopen after the Esc is closed
  // again by the leave's own caret hand-on.
  await page.evaluate(() => {
    window.__t9bOpens = 0;
    new MutationObserver((ms) => ms.forEach((m) => { if (m.oldValue === null) window.__t9bOpens++; }))
      .observe(document.querySelector('.content'), { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-ed-code-edit'] });
  });
  await page.keyboard.press('Control+s'); await page.keyboard.press('Escape'); await page.keyboard.press('Control+s');
  await renderIdle(page); await wait(300); await renderIdle(page);
  assert.deepStrictEqual({ saves: await savesUntil(statuses, 2), status: await saveStateUntil(page, 'clean'), notice: await noticeText(page), edit: await codeEdit(page),
    opens: await page.evaluate(() => window.__t9bOpens) },
  { saves: [200, 200], status: 'clean', notice: null, edit: null, opens: 1 }, 'opened once (the Ctrl+S re-entry), never again after the Esc');
  assert.deepStrictEqual(await focusAfterLeave(page), { tag: 'P', armed: true, transient: false, text: 'Omega.' }, 'the leave handed the caret on');
  assert.strictEqual(fs.readFileSync(boot.mdPath, 'utf8'), CODE_MD.replace('endmodule', 'endmoduleq'));
}, { md: CODE_MD });
check('diagram-panel: a second Ctrl+S during the Ctrl+S render saves after the first, no 409 and no conflict card (T9b)', DESKTOP, async (page, boot) => {
  const statuses = recordSaves(page);
  await openDiagPanel(page, '.graphviz svg');
  await diagSelect(page, DOT_B, DOT_B + 1); await page.keyboard.type('zeta');
  await delayRender(page, 800); await slowSaves(page);
  await page.keyboard.press('Control+s'); await page.keyboard.press('Control+s');
  await renderIdle(page); await wait(300); await renderIdle(page);
  const p = await diagPanel(page);
  assert.deepStrictEqual({ saves: await savesUntil(statuses, 2), status: await saveStateUntil(page, 'clean'), notice: await noticeText(page), panel: p && { value: p.value, focused: p.focused } },
    { saves: [200, 200], status: 'clean', notice: null, panel: { value: 'digraph { a -> zeta }', focused: true } });
  assert.strictEqual(fs.readFileSync(boot.mdPath, 'utf8'), DIAG_MD.replace('a -> b', 'a -> zeta'));
}, { md: DIAG_MD });
// The document-level variant: two Ctrl+S while a paragraph's commit renders
// share one resolution (`switching`) and used to run two save()s back to back.
check('save: two Ctrl+S during a paragraph\'s commit render save one after the other, no 409 and no conflict card (T9b)', DESKTOP, async (page, boot) => {
  const statuses = recordSaves(page);
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.type('X');
  await delayRender(page, 800); await slowSaves(page);
  await page.keyboard.press('Control+s'); await page.keyboard.press('Control+s');
  await renderIdle(page);
  assert.deepStrictEqual({ saves: await savesUntil(statuses, 2), status: await saveStateUntil(page, 'clean'), notice: await noticeText(page) },
    { saves: [200, 200], status: 'clean', notice: null });
  assert.strictEqual(fs.readFileSync(boot.mdPath, 'utf8'), '# D\n\nAlpha.X\n\nOmega.\n');
}, { md: BASE_MD });

// T9b item 4 (R57, T5 M5): the language chip pressed while the caret sits in
// an empty new paragraph (a transient). The chip keeps focus there, so the
// transient opened its burst again after the gesture's resolution, and its
// focusout when the code host took focus resolved the brand-new edit, closing
// it in the gesture that opened it (the shape T5 fixed in openDiagramPanel()).
check('code-chips: the language chip pressed from an empty new paragraph opens the edit and its menu, and keeps them (R57, T5 M5)', DESKTOP, async (page, boot) => {
  await newParaBelowAlpha(page);
  assert.deepStrictEqual(await focusAfterLeave(page), { tag: 'P', armed: true, transient: true, text: '' }, 'guard: the caret is in a new empty paragraph');
  await hoverCodeBlock(page);
  await page.click('.ed-code-lang'); await renderIdle(page); await wait(300); await renderIdle(page);
  const m = await langMenu(page);
  assert.deepStrictEqual({ menu: m && m.focused, edit: await page.evaluate(() => { const h = document.querySelector('pre[data-ed-code-edit]'); return h ? h.textContent : null; }), notice: await noticeText(page) },
    { menu: true, edit: 'module m;\nendmodule', notice: null });
  await page.click('.ed-code-langitem:has-text("Python")'); await renderIdle(page);
  assert.deepStrictEqual(await codeEdit(page), { text: 'module m;\nendmodule', caret: 0, focused: true }, 'the edit is open again after the pick');
  assert.strictEqual(await saveAndRead(page, boot), CODE_MD.replace('```verilog', '```python'));
}, { md: CODE_MD });

// ── v3.17.2: the dirty mark, saves, and re-entries ──
// The toolbar's save state, the title's dot, and whether the unload guard
// would fire (a dispatched beforeunload, read off defaultPrevented).
const dirtyMarks = (page) => page.evaluate(() => {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return { status: document.querySelector('.ed-toolbar-status').getAttribute('data-state'),
    dot: document.title.indexOf('●') === 0, guard: e.defaultPrevented };
});
const QUOTE_MD = '# D\n\nAlpha.\n\n> Quote line.\n\nOmega.\n';
// B1 (v3.17.0 final review T2 L74): text typed into an open raw box is
// unsaved work. Before: clean status, no dot and no unload guard, so closing
// the tab threw it away without a word.
check('dirty (v3.17.2 B1): typing in a raw box marks the document unsaved; Esc makes it clean again', DESKTOP, async (page, boot) => {
  await page.click('blockquote'); await renderIdle(page);
  assert.deepStrictEqual(await rawBox(page), { value: '> Quote line.', caret: 13, focused: true }, 'guard: the quote opened in the raw box');
  assert.deepStrictEqual(await dirtyMarks(page), { status: 'clean', dot: false, guard: false }, 'guard: an opened box is not an edit');
  await page.keyboard.type('Z'); await wait(100);
  assert.deepStrictEqual(await dirtyMarks(page), { status: 'dirty', dot: true, guard: true }, 'typed text is unsaved');
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.deepStrictEqual(await dirtyMarks(page), { status: 'clean', dot: false, guard: false }, 'Esc put the file back');
  assert.strictEqual(fs.readFileSync(boot.mdPath, 'utf8'), QUOTE_MD);
}, { md: QUOTE_MD });
// A6: markup a page script or extension adds to the editable surfaces is not
// an edit. MEASURED before: Playwright's screenshot (caret 'hide') writes
// `style="caret-color: transparent !important;"` on every editable element
// and empties it after; with the caret in a table cell the table burst read
// that as typing, the status went dirty, and leaving the cell committed the
// table through its serializer, rewriting `|a|b|` as `| a | b |`.
const A6_TABLE_MD = '# D\n\nAlpha.\n\n|a|b|\n|-|-|\n|x|y|\n\nOmega.\n';
// A click, not focusSurface(): its selector probe is an attribute on the cell,
// written before the click and removed after it, and only an inline style is
// what this release stops counting (other attributes still do).
const clickCell = async (page, text) => { await page.locator('.content td.ed-wys-cell').filter({ hasText: new RegExp('^' + text + '$') }).click(); await wait(150); };
check('dirty (v3.17.2 A6): a screenshot\'s caret style on a table being edited is not an edit, and leaving writes nothing', DESKTOP, async (page, boot) => {
  await clickCell(page, 'y');
  assert.deepStrictEqual(await dirtyMarks(page), { status: 'clean', dot: false, guard: false }, 'guard: clean with the caret in a cell');
  await page.screenshot({ caret: 'hide' }); await wait(200);
  assert.deepStrictEqual(await dirtyMarks(page), { status: 'clean', dot: false, guard: false }, 'the screenshot is not an edit');
  const before = renderTotal(page);
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await renderIdle(page);
  assert.deepStrictEqual({ renders: renderTotal(page) - before, marks: await dirtyMarks(page) },
    { renders: 0, marks: { status: 'clean', dot: false, guard: false } }, 'leaving the cell commits nothing');
  assert.strictEqual(await saveAndRead(page, boot), A6_TABLE_MD, 'the table keeps its bytes');
}, { md: A6_TABLE_MD });
// The same for any inline style another script puts on a cell, while a real
// alignment change (the one style the editor writes) still counts.
check('dirty (v3.17.2 A6): a foreign inline style on a cell is not an edit; a column alignment still is', DESKTOP, async (page, boot) => {
  await clickCell(page, 'y');
  await page.evaluate(() => document.querySelectorAll('.content td, .content th').forEach((c) => c.setAttribute('style', 'outline: 1px solid red')));
  await wait(200);
  assert.deepStrictEqual(await dirtyMarks(page), { status: 'clean', dot: false, guard: false }, 'a foreign style is not an edit');
  await page.evaluate(() => { const c = [...document.querySelectorAll('.content td')].find((td) => td.textContent === 'y'); c.setAttribute('style', 'outline: 1px solid red; text-align: center'); });
  await wait(200);
  assert.strictEqual((await dirtyMarks(page)).status, 'dirty', 'an alignment is an edit');
}, { md: A6_TABLE_MD });
// B2 (R66): a second Ctrl+S while the first save's reply is still on its way
// waits for it. Before: it went out at once with the baseline the first
// reply was about to replace, the server answered 409 and the conflict card
// went up over a file this page had just saved.
check('save (v3.17.2 B2): two Ctrl+S while a slow save is out save one after the other, no 409 and no conflict card (R66)', DESKTOP, async (page, boot) => {
  const statuses = recordSaves(page);
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.type('X');
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await renderIdle(page);
  await slowSaves(page);
  await page.keyboard.press('Control+s'); await wait(50); await page.keyboard.press('Control+s');
  assert.deepStrictEqual({ saves: await savesUntil(statuses, 2), status: await saveStateUntil(page, 'clean'), notice: await noticeText(page) },
    { saves: [200, 200], status: 'clean', notice: null });
  assert.strictEqual(fs.readFileSync(boot.mdPath, 'utf8'), '# D\n\nAlpha.X\n\nOmega.\n');
}, { md: BASE_MD });
// B3 (R75): Ctrl+Z after an Esc in the diagram panel opens the panel again
// with what was typed and its preview, not the raw box (final review I2's
// first fix brought the text back through the raw box only).
check('diagram-panel (v3.17.2 B3): Ctrl+Z after Esc reopens the panel with the discarded source and its preview (R75)', DESKTOP, async (page, boot) => {
  await openDiagPanel(page, '.graphviz svg');
  await diagSelect(page, DOT_B, DOT_B + 1); await page.keyboard.type('omega');
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.deepStrictEqual({ panel: await diagPanel(page), box: await rawBox(page) }, { panel: null, box: null }, 'guard: Esc closed the panel');
  assert.strictEqual(fs.readFileSync(boot.mdPath, 'utf8'), DIAG_MD, 'guard: nothing written by the Esc');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  const p = await diagPanelUntil(page, (s) => !!s.svg && /omega/.test(s.svg));
  assert.deepStrictEqual({ box: await rawBox(page), panel: p && { value: p.value, focused: p.focused, omega: !!p.svg && /omega/.test(p.svg) } },
    { box: null, panel: { value: 'digraph { a -> omega }', focused: true, omega: true } }, 'the panel is back with the typed source');
  assert.strictEqual(fs.readFileSync(boot.mdPath, 'utf8'), DIAG_MD, 'restoring writes nothing');
  await page.click('.ed-diagram-done'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), DIAG_MD.replace('a -> b', 'a -> omega'), 'and 完成 writes it');
}, { md: DIAG_MD });
// B4 (final review M1): Ctrl+S reopens the code edit on the saved block, and
// its own Ctrl+Z still steps back over what was typed before the save.
check('code-edit (v3.17.2 B4): Ctrl+Z inside the edit after Ctrl+S steps back over the typing from before the save (M1)', DESKTOP, async (page, boot) => {
  await clickText(page, 'endmodule'); await page.keyboard.type('q');
  await page.keyboard.press('Control+s');
  const saved = CODE_MD.replace('endmodule', 'endmoduleq');
  assert.strictEqual(await diskUntil(boot, saved), saved, 'guard: the save wrote the typing');
  await renderIdle(page);
  assert.deepStrictEqual(await codeEditUntil(page), { text: 'module m;\nendmoduleq', caret: 20, focused: true }, 'guard: the edit is open again');
  await page.keyboard.press('Control+z'); await wait(100);
  assert.strictEqual((await codeEdit(page) || {}).text, 'module m;\nendmodule', 'Ctrl+Z took the q back inside the edit');
  assert.strictEqual(fs.readFileSync(boot.mdPath, 'utf8'), saved, 'and wrote nothing');
  await page.keyboard.press('Control+Shift+z'); await wait(100);
  assert.strictEqual((await codeEdit(page) || {}).text, 'module m;\nendmoduleq', 'redo brings it back');
}, { md: CODE_MD });
// B5 (final review M2): Ctrl+S on an untouched "/" 程式碼 insert discards it
// (R19) and saves. Before: the edit then reopened on whatever block took the
// insert's start line, here the code block below, and the next keys went
// into it.
check('code-edit (v3.17.2 B5): Ctrl+S on an untouched "/" 程式碼 insert does not open the code block below (M2)', DESKTOP, async (page, boot) => {
  await newParaBelowAlpha(page);
  await page.keyboard.type('/code'); await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await codeEdit(page), { text: '', caret: 0, focused: true }, 'guard: the insert opened the edit');
  await page.keyboard.press('Control+s'); await renderIdle(page); await wait(400); await renderIdle(page);
  assert.strictEqual(await diskUntil(boot, CODE_MD), CODE_MD, 'the file is unchanged');
  assert.deepStrictEqual({ edit: await codeEdit(page), code: await page.evaluate(() => document.querySelectorAll('.content .ed-block[data-block-type="code"]').length) },
    { edit: null, code: 1 }, 'the insert is gone and nothing else opened');
  await page.keyboard.type('z'); await wait(300);
  assert.strictEqual(await saveAndRead(page, boot), CODE_MD, 'the keys went into no code block');
}, { md: CODE_MD });
// A3 (R65 / v3.15.0 N5): emptying the paragraph between two lists of the
// same kind joins them TIGHT, as Notion does. Before: the blank line between
// them stayed and the joined list was loose.
const A3_MD = '# D\n\n- a\n\nMid.\n\n- b\n';
async function emptyAndLeave(page, text) {
  await focusSurface(page, text, text.length);
  for (let i = 0; i < text.length; i++) await page.keyboard.press('Backspace');
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await renderIdle(page);
}
check('lists (v3.17.2 A3): emptying the paragraph between two lists of the same kind joins them into one tight list (R65)', DESKTOP, async (page, boot) => {
  await emptyAndLeave(page, 'Mid.');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- a\n- b\n');
  assert.deepStrictEqual(await page.evaluate(() => [...document.querySelectorAll('.content .ed-block[data-block-type="li"]')].map((b) => b.getAttribute('data-list-loose'))),
    [null, null], 'the joined list is tight');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), A3_MD, 'one Ctrl+Z brings the paragraph back');
}, { md: A3_MD });
check('lists (v3.17.2 A3): ordered lists join tight too; different markers and a loose list keep the blank line (R65)', DESKTOP, async (page, boot) => {
  await emptyAndLeave(page, 'One.');
  await emptyAndLeave(page, 'Two.');
  await emptyAndLeave(page, 'Three.');
  assert.strictEqual(await saveAndRead(page, boot),
    '# D\n\n1. a\n2. b\n\n- c\n\n* d\n\n- e\n\n- f\n\n- g\n');
}, { md: '# D\n\n1. a\n\nOne.\n\n2. b\n\n- c\n\nTwo.\n\n* d\n\n- e\n\n- f\n\nThree.\n\n- g\n' });

// ── v3.17.3 Task 1: the image toolbar (A1–A6, C8) ──
const statusNow = (page) => page.evaluate(() => ({
  state: document.querySelector('.ed-toolbar-status').getAttribute('data-state'),
  dot: document.title.indexOf('●') === 0,
}));
const imgTbFocusLabel = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return a && a.closest && a.closest('.ed-imgtb') ? a.textContent : null;
});
check('v3173 A1: Enter on a selected image block shows the toolbar and Tab reaches 替換/替代文字/刪除', DESKTOP, async (page) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.press('ArrowDown'); await wait(250);
  const sel = await page.evaluate(() => [...document.querySelectorAll('.ed-block.ed-selected')].map((b) => (b.querySelector('img') ? 'img' : b.textContent.trim())));
  assert.deepStrictEqual(sel, ['img'], 'guard: the image block is the one selected block');
  await page.keyboard.press('Enter'); await wait(300);
  const s = await imgTbState(page);
  assert.ok(s, 'the toolbar is shown after Enter');
  assert.strictEqual(await imgTbFocusLabel(page), '替換', 'focus is on the first button');
  await page.keyboard.press('Tab');
  assert.strictEqual(await imgTbFocusLabel(page), '替代文字', 'Tab: second button');
  await page.keyboard.press('Tab');
  assert.strictEqual(await imgTbFocusLabel(page), '刪除', 'Tab: third button');
  // Esc goes back to the block selection.
  await page.keyboard.press('Escape'); await wait(250);
  assert.strictEqual(await imgTbState(page), null, 'Esc hides the toolbar');
  const back = await page.evaluate(() => ({
    sel: [...document.querySelectorAll('.ed-block.ed-selected')].map((b) => (b.querySelector('img') ? 'img' : b.textContent.trim())),
    focusSelected: !!document.activeElement.classList && document.activeElement.classList.contains('ed-selected'),
  }));
  assert.deepStrictEqual(back, { sel: ['img'], focusSelected: true }, 'back on the block selection');
}, IMG_OPTS);
const IMG_LONG_MD = '# D\n\n' + Array.from({ length: 12 }, (_, i) => 'Filler ' + i + '.\n\n').join('') +
  '![chip top](assets/a.png "T")\n\n' + Array.from({ length: 40 }, (_, i) => 'After ' + i + '.\n\n').join('');
check('v3173 A2: typing half an alt text survives a 300px scroll', DESKTOP, async (page, boot) => {
  await page.evaluate(() => { document.querySelector('.content img').scrollIntoView({ block: 'center' }); });
  await wait(200);
  await openAlt(page);
  await page.keyboard.type('half');
  await page.mouse.move(700, 300);
  const y0 = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 300); await wait(500);
  const y1 = await page.evaluate(() => window.scrollY);
  assert.ok(y1 - y0 >= 250, 'guard: the page scrolled ' + (y1 - y0) + 'px');
  const s = await page.evaluate(() => {
    const i = document.querySelector('.ed-imgtb-input');
    const t = document.querySelector('.ed-imgtb');
    const r = i.getBoundingClientRect();
    return { shown: !t.hidden && !i.hidden, value: i.value, onScreen: r.top >= 0 && r.bottom <= innerHeight };
  });
  assert.deepStrictEqual(s, { shown: true, value: 'half', onScreen: true }, 'the field is still there with the typed text');
  await page.keyboard.press('Enter'); await renderIdle(page);
  const disk = await saveAndRead(page, boot);
  assert.ok(disk.indexOf('![half](assets/a.png "T")\n') !== -1, 'saved: ' + JSON.stringify(disk.slice(0, 40) + '...' + disk.slice(disk.indexOf('![') , disk.indexOf('![') + 40)));
}, { md: IMG_LONG_MD, assets: { 'assets/a.png': PNG_160 } });
check('v3173 A3: an alt with a single backtick still saves an image', DESKTOP, async (page, boot) => {
  await openAlt(page);
  await page.keyboard.type('a`b'); await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await page.evaluate(() => [...document.querySelectorAll('.content img')].map((i) => i.getAttribute('alt'))), ['a`b'], 'one image whose alt is as typed');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n![a&#96;b](assets/a.png "T")\n\nOmega.\n');
  await openAlt(page);
  assert.strictEqual(await page.evaluate(() => document.querySelector('.ed-imgtb-input').value), 'a`b', 'reopened: the field shows the typed text');
}, IMG_OPTS);
check('v3173 A4: a replace refused during the upload leaves no file in assets/', DESKTOP, async (page, boot) => {
  const assetsDir = path.join(path.dirname(boot.mdPath), 'assets');
  const before = fs.readdirSync(assetsDir).sort();
  await page.route('**/api/asset', async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    await wait(2000); await route.continue();
  });
  await hoverImg(page);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), imgTbBtn(page, '替換').click()]);
  const posted = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/asset' && r.request().method() === 'POST');
  await chooser.setFiles({ name: 'dot.png', mimeType: 'image/png', buffer: Buffer.from(PNG_160, 'base64') });
  // While the upload is held, the picture's own paragraph changes.
  await wait(300);
  await openAlt(page);
  await page.keyboard.type('moved'); await page.keyboard.press('Enter'); await renderIdle(page);
  await posted;
  let now = null;
  for (let i = 0; i < 20; i++) {
    now = fs.readdirSync(assetsDir).sort();
    if (JSON.stringify(now) === JSON.stringify(before)) break;
    await wait(150);
  }
  assert.deepStrictEqual(now, before, 'assets/ holds what it held before the replace');
  const notice = await imgConflictText(page);
  assert.ok(notice.indexOf('文件已更新，請重試這個操作') !== -1, 'the retry notice: ' + JSON.stringify(notice));
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n![moved](assets/a.png "T")\n\nOmega.\n', 'the alt edit stands, the path did not move');
}, IMG_OPTS);
check('v3173 A5: Esc during an IME composition in the alt field keeps the field open', DESKTOP, async (page) => {
  await openAlt(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'ㄋ', selectionStart: 1, selectionEnd: 1 });
  await page.keyboard.press('Escape'); await wait(300);
  const s = await page.evaluate(() => {
    const i = document.querySelector('.ed-imgtb-input');
    return { shown: !!i && !i.hidden && !document.querySelector('.ed-imgtb').hidden, focused: document.activeElement === i };
  });
  assert.deepStrictEqual(s, { shown: true, focused: true }, 'the composition owns the Esc');
}, { md: IMG_MD, assets: { 'assets/a.png': PNG_160 }, engines: ['chromium'] });
check('v3173 A6: cancelling the 「/圖片」 picker removes the 「/圖片」 text', DESKTOP, async (page, boot) => {
  const chooserP = page.waitForEvent('filechooser');
  await emptyAlphaTo(page, '/圖片');
  await page.keyboard.press('Enter');
  await chooserP; await wait(300);
  // Migrated from 'slash: a picker left unanswered from a real "/圖片" leaves the paragraph as typed':
  // while the dialog is open nothing changes, on screen or on disk.
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:/圖片', 'paragraph:Omega.']);
  assert.strictEqual(fs.readFileSync(boot.mdPath, 'utf8'), BASE_MD, 'nothing written');
  // Playwright cannot press Cancel; the browser raises this event on the input.
  await page.evaluate(() => { document.querySelector('body > input[type="file"]').dispatchEvent(new Event('cancel')); });
  await renderIdle(page); await wait(200);
  const bl = await blockList(page);
  assert.ok(bl.indexOf('paragraph:/圖片') === -1, 'no 圖片 paragraph on screen: ' + JSON.stringify(bl));
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('body > input[type="file"]').length), 0, 'the picker input is gone');
  const disk = await saveAndRead(page, boot);
  assert.strictEqual(disk, '# D\n\nOmega.\n', 'the consumed text is not in the file');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  const afterUndo = await saveAndRead(page, boot);
  assert.strictEqual(afterUndo.indexOf('/圖片'), -1, 'one Ctrl+Z never brings the text back: ' + JSON.stringify(afterUndo));
  assert.strictEqual(afterUndo, BASE_MD, 'one Ctrl+Z restores the pre-slash bytes');
}, { md: BASE_MD });
check('v3173 C8: typed-but-unapplied alt text marks the document unsaved', DESKTOP, async (page) => {
  assert.deepStrictEqual(await statusNow(page), { state: 'clean', dot: false }, 'guard: clean first');
  await openAlt(page);
  assert.deepStrictEqual(await statusNow(page), { state: 'clean', dot: false }, 'guard: opening the field changes nothing');
  await page.keyboard.type('new words'); await wait(150);
  assert.deepStrictEqual(await statusNow(page), { state: 'dirty', dot: true }, 'typed text is unsaved work');
  await page.keyboard.press('Escape'); await wait(300);
  assert.deepStrictEqual(await statusNow(page), { state: 'clean', dot: false }, 'Esc discards it');
}, IMG_OPTS);

// ── v3.17.3 Task 2 (C1, C7): toolbar 復原/重做 step the open code edit's and
// diagram panel's own histories, and the panel's history survives Ctrl+S ──
// Whether a paragraph reads `text`, in the page: did the document stack move.
const paraIs = (page, text) => page.evaluate((t) => [...document.querySelectorAll('.ed-wys-armed')].some((e) => e.textContent === t), text);
check('v3173 C1: toolbar 重做 in the code edit redoes the edit\'s own typing', DESKTOP, async (page, boot) => {
  // A document redo waiting on the stack, so a press that reaches the
  // document stack is seen (triage: the edit closed and "Alpha.X" came back).
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.type('X');
  await clickText(page, 'Omega.'); await renderIdle(page);
  await page.click('[data-ed-tb="undo"]'); await renderIdle(page);
  assert.strictEqual(await paraIs(page, 'Alpha.'), true, 'guard: the document undo took "X" back');
  await clickText(page, 'endmodule'); await renderIdle(page);
  assert.strictEqual((await codeEditUntil(page) || {}).focused, true, 'guard: the edit is open');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('ab');
  await page.keyboard.press('Control+z');
  assert.strictEqual((await codeEdit(page) || {}).text, 'module m;\nendmodule', 'guard: Ctrl+Z stepped the edit back');
  const before = renderTotal(page);
  await page.click('[data-ed-tb="redo"]'); await wait(300); await renderIdle(page);
  assert.deepStrictEqual({ edit: await codeEdit(page), renders: renderTotal(page) - before, alpha: await paraIs(page, 'Alpha.'),
    disk: fs.readFileSync(boot.mdPath, 'utf8') },
  { edit: { text: 'module m;\nendmoduleab', caret: 21, focused: true }, renders: 0, alpha: true, disk: CODE_MD });
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), CODE_MD.replace('endmodule', 'endmoduleab'));
}, { md: CODE_MD });
check('v3173 C1: toolbar 復原/重做 in the diagram panel step the panel\'s text and keep it open', DESKTOP, async (page, boot) => {
  // A document step on the stack (Omega.Y), so a press that reaches the
  // document stack is seen.
  await focusSurface(page, 'Omega.', 6); await page.keyboard.type('Y');
  await openDiagPanel(page, '.graphviz svg'); await renderIdle(page);
  assert.strictEqual(await paraIs(page, 'Omega.Y'), true, 'guard: the paragraph committed');
  await diagSelect(page, DOT_B + 1); await page.keyboard.type('X');
  const typed = await diagPanelUntil(page, (s) => /\bbX\b/.test(s.svg || ''));
  assert.deepStrictEqual({ value: typed.value, svg: /\bbX\b/.test(typed.svg || '') }, { value: 'digraph { a -> bX }', svg: true },
    'guard: typed, and the preview drew it');
  const before = renderTotal(page);
  await page.click('[data-ed-tb="undo"]'); await wait(300); await renderIdle(page);
  const u = await diagPanel(page);
  assert.deepStrictEqual({ open: !!u, value: u && u.value, focused: u && u.focused, renders: renderTotal(page) - before,
    omega: await paraIs(page, 'Omega.Y'), disk: fs.readFileSync(boot.mdPath, 'utf8') },
  { open: true, value: DOT_SRC, focused: true, renders: 0, omega: true, disk: DIAG_MD });
  // The preview follows through the panel's own debounce.
  const up = await diagPanelUntil(page, (s) => !/\bbX\b/.test(s.svg || ''));
  assert.deepStrictEqual({ bX: /\bbX\b/.test(up.svg || ''), b: /\bb\b/.test(up.svg || '') }, { bX: false, b: true }, 'the preview drew the step');
  await page.click('[data-ed-tb="redo"]'); await wait(300); await renderIdle(page);
  const r = await diagPanel(page);
  assert.deepStrictEqual({ open: !!r, value: r && r.value, focused: r && r.focused, renders: renderTotal(page) - before,
    omega: await paraIs(page, 'Omega.Y'), disk: fs.readFileSync(boot.mdPath, 'utf8') },
  { open: true, value: 'digraph { a -> bX }', focused: true, renders: 0, omega: true, disk: DIAG_MD });
  await page.click('.ed-diagram-done'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), DIAG_MD.replace('a -> b', 'a -> bX').replace('Omega.', 'Omega.Y'));
}, { md: DIAG_MD });
check('v3173 C7: Ctrl+Z in the diagram source still undoes typing from before Ctrl+S', DESKTOP, async (page, boot) => {
  await openDiagPanel(page, '.graphviz svg');
  await diagSelect(page, DOT_B + 1); await page.keyboard.type('X');
  await page.keyboard.press('Control+s'); await renderIdle(page);
  assert.strictEqual(await saveStateUntil(page, 'clean'), 'clean', 'guard: the save landed');
  const saved = DIAG_MD.replace('a -> b', 'a -> bX');
  assert.strictEqual(fs.readFileSync(boot.mdPath, 'utf8'), saved, 'guard: X is on disk');
  assert.strictEqual((await diagPanel(page) || {}).value, 'digraph { a -> bX }', 'guard: the panel opened again on X');
  const before = renderTotal(page);
  await page.keyboard.press('Control+z'); await renderIdle(page);
  const u = await diagPanel(page);
  assert.deepStrictEqual({ open: !!u, value: u && u.value, focused: u && u.focused, renders: renderTotal(page) - before,
    disk: fs.readFileSync(boot.mdPath, 'utf8') },
  { open: true, value: DOT_SRC, focused: true, renders: 0, disk: saved });
  await page.keyboard.press('Control+y'); await renderIdle(page);
  assert.strictEqual((await diagPanel(page) || {}).value, 'digraph { a -> bX }', 'Ctrl+Y brings it back');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  await page.click('.ed-diagram-done'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), DIAG_MD, 'the undone text commits as one step');
}, { md: DIAG_MD });

// ── v3.17.3 Task 3 (C2, C3, C4, C6, C9): small editor fixes ──
// C3 is a unit row in test/code-edit.test.js; C4 is a code-read fix with no browser repro.
const fenceMd = (indent) => '# D\n\nAlpha.\n\n' + indent + '```verilog\n' + indent + 'module m;\n' + indent + 'endmodule\n' + indent + '```\n\nOmega.\n';
for (const indent of ['  ', '   ']) {
  check('v3173 C2: a click at the end of endmodule in a ' + indent.length + '-space-indented fence puts the caret after it', DESKTOP, async (page) => {
    await clickText(page, 'endmodule'); await renderIdle(page);
    const e = await codeEditUntil(page);
    const text = indent + 'module m;\n' + indent + 'endmodule';
    assert.deepStrictEqual({ text: e && e.text, caret: e && e.caret }, { text, caret: text.length });
  }, { md: fenceMd(indent) });
}
const C6_MD = '# D\n\n' + 'Filler line.\n\n'.repeat(60) + 'Plain words here.\n\n' + 'Filler line.\n\n'.repeat(60);
check('v3173 C6: the link field stays inside the viewport when its selection nears the bottom', DESKTOP, async (page) => {
  await selectInSurface(page, 'Plain words here.', 6, 11);
  // Near the top of the viewport there is no room above the selection, so the
  // field opens below it (triage C6).
  await page.evaluate(() => {
    const p = [...document.querySelectorAll('.ed-wys-armed')].find((e) => e.textContent === 'Plain words here.');
    const r = document.createRange(); r.setStart(p.firstChild, 6); r.setEnd(p.firstChild, 11);
    window.scrollBy(0, r.getBoundingClientRect().top - 40);
  });
  await wait(250);
  await page.keyboard.press('Control+k');
  assert.strictEqual((await linkField(page)).open, true, 'guard: the field is open');
  assert.ok(await page.evaluate(() => { const b = document.querySelector('.ed-linkbar'); return b.getBoundingClientRect().top > 40; }), 'guard: the field opened below the selection');
  await page.evaluate(() => {
    const p = [...document.querySelectorAll('.ed-wys-armed')].find((e) => e.textContent === 'Plain words here.');
    const r = document.createRange(); r.setStart(p.firstChild, 6); r.setEnd(p.firstChild, 11);
    window.scrollBy(0, r.getBoundingClientRect().bottom - (innerHeight - 8));
  });
  await wait(250);
  const f = await page.evaluate(() => { const b = document.querySelector('.ed-linkbar'); if (!b || !b.isConnected) return null; const r = b.getBoundingClientRect(); return { bottom: r.bottom, vh: innerHeight }; });
  assert.ok(f, 'the field is still open (the selection is in view)');
  assert.ok(f.bottom <= f.vh, 'field bottom ' + f.bottom + ' <= viewport ' + f.vh);
}, { md: C6_MD });
const GRAMMARLY = ['data-gramm', 'data-gramm_editor', 'data-enable-grammarly'];
check('v3173 C9: Grammarly attributes on a table cell do not mark the document unsaved, and Ctrl+S leaves the table bytes alone', DESKTOP, async (page, boot) => {
  await clickCell(page, 'y');
  assert.deepStrictEqual(await dirtyMarks(page), { status: 'clean', dot: false, guard: false }, 'guard: clean with the caret in a cell');
  for (const a of GRAMMARLY) {
    await page.evaluate((n) => { const c = [...document.querySelectorAll('.content td')].find((td) => td.textContent === 'y'); c.setAttribute(n, 'false'); }, a);
    await wait(200);
    assert.deepStrictEqual(await dirtyMarks(page), { status: 'clean', dot: false, guard: false }, a + ' is not an edit');
  }
  assert.strictEqual(await saveAndRead(page, boot), A6_TABLE_MD, 'the table keeps its bytes');
}, { md: A6_TABLE_MD });
check('v3173 C9: a column alignment set through the menu still marks the table edited with extension attributes present', DESKTOP, async (page, boot) => {
  await clickCell(page, 'y');
  await page.evaluate((names) => document.querySelectorAll('.content td, .content th').forEach((c) => names.forEach((n) => c.setAttribute(n, 'false'))), GRAMMARLY);
  await wait(200);
  assert.deepStrictEqual(await dirtyMarks(page), { status: 'clean', dot: false, guard: false }, 'guard: the attributes alone are clean');
  await openColMenu(page, 1);
  await page.locator('.ed-te-menu button[aria-label="置中"]').click(); await wait(250);
  assert.strictEqual((await dirtyMarks(page)).status, 'dirty', 'an alignment is an edit');
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), A6_TABLE_MD.replace('|-|-|', '|-|:-:|').replace('|a|b|', '| a | b |').replace('|x|y|', '| x | y |'),
    'the alignment reached the file');
}, { md: A6_TABLE_MD });

// ── v3173 Task 4: transient and Enter paths (B3, B10, B11, A8) ──
// B3: an Enter at a paragraph's edge whose commit of the typing before it
// failed is kept (pendingStructure) and opens its paragraph once a retry
// lands. Ctrl+S is the retry here: a second Enter would open the paragraph
// on its own and prove nothing.
check('v3173 B3: Enter after a failed first write still opens the new paragraph once the write succeeds', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await failFirstRender(page);
  await page.keyboard.type('X');
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.ok(await page.evaluate(() => !!document.querySelector('.ed-conflict')), 'the failed write shows its card');
  assert.strictEqual(fs.readFileSync(boot.mdPath, 'utf8'), BASE_MD, 'nothing written yet');
  await page.keyboard.press('Control+s'); await renderIdle(page); await wait(900);
  assert.deepStrictEqual({ list: await blockList(page), caret: await caretNow(page) },
    { list: ['heading:D', 'paragraph:Alpha.X', '~paragraph:', 'paragraph:Omega.'], caret: { text: '', offset: 0, transient: true } },
    'the retry landed and the Enter opened its paragraph');
  assert.strictEqual(fs.readFileSync(boot.mdPath, 'utf8'), '# D\n\nAlpha.X\n\nOmega.\n', 'the retry wrote the typing');
  await page.keyboard.type('x');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.X\n\nx\n\nOmega.\n');
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.content .ed-block').length), 4, 'exactly one extra block');
}, { md: BASE_MD });
check('v3173 B3: Enter at a paragraph\'s start after a failed first write opens the paragraph above once the write succeeds', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Omega.', 0);
  await failFirstRender(page);
  await page.keyboard.type('X');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.ok(await page.evaluate(() => !!document.querySelector('.ed-conflict')), 'the failed write shows its card');
  await page.keyboard.press('Control+s'); await renderIdle(page); await wait(900);
  assert.deepStrictEqual({ list: await blockList(page), caret: await caretNow(page) },
    { list: ['heading:D', 'paragraph:Alpha.', '~paragraph:', 'paragraph:XOmega.'], caret: { text: 'XOmega.', offset: 0, transient: false } });
  await page.keyboard.press('ArrowUp'); await renderIdle(page);
  await page.keyboard.type('y');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\ny\n\nXOmega.\n');
}, { md: BASE_MD });
check('v3173 B3: a second Enter after the failed one opens one paragraph, not two', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await failFirstRender(page);
  await page.keyboard.type('X');
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual({ list: await blockList(page), caret: await caretNow(page) },
    { list: ['heading:D', 'paragraph:Alpha.X', '~paragraph:', 'paragraph:Omega.'], caret: { text: '', offset: 0, transient: true } });
  await page.keyboard.type('x');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.X\n\nx\n\nOmega.\n');
}, { md: BASE_MD });
// B10: the commit of the block below an empty transient does not take the
// transient away (applyFullRender() keeps it, transientKeptThroughRender()).
check('v3173 B10: the empty paragraph opened by Enter at a paragraph\'s start survives typing below and ArrowUp', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Omega.', 0);
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('X');
  await page.keyboard.press('ArrowUp'); await renderIdle(page);
  assert.deepStrictEqual({ list: await blockList(page), caret: await caretNow(page) },
    { list: ['heading:D', 'paragraph:Alpha.', '~paragraph:', 'paragraph:XOmega.'], caret: { text: '', offset: 0, transient: true } });
  await page.keyboard.type('Q');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\nQ\n\nXOmega.\n');
}, { md: BASE_MD });
check('v3173 B10: the empty paragraph opened by Enter at a paragraph\'s start survives typing below and a click on it', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Omega.', 0);
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('X');
  await page.locator('[data-ed-transient] .ed-wys-armed').click(); await renderIdle(page);
  assert.deepStrictEqual({ list: await blockList(page), caret: await caretNow(page) },
    { list: ['heading:D', 'paragraph:Alpha.', '~paragraph:', 'paragraph:XOmega.'], caret: { text: '', offset: 0, transient: true } });
  await page.keyboard.type('Q');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\nQ\n\nXOmega.\n');
}, { md: BASE_MD });
check('v3173 B10: keys typed after ArrowUp while the commit below renders land in the empty paragraph', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Omega.', 0);
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('X');
  await delayRender(page, 800);
  await page.keyboard.press('ArrowUp'); await page.keyboard.type('Q');
  await renderIdle(page);
  assert.deepStrictEqual({ list: await blockList(page), caret: await caretNow(page) },
    { list: ['heading:D', 'paragraph:Alpha.', '~paragraph:Q', 'paragraph:XOmega.'], caret: { text: 'Q', offset: 1, transient: true } });
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\nQ\n\nXOmega.\n');
}, { md: BASE_MD });
// R29 (fix round 1): a transient the user has left is not kept through the
// render of a commit below it.
check('v3173 B10: the empty paragraph is not kept once the user has left it for a block further below', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Omega.', 0);
  await page.keyboard.press('Enter'); await renderIdle(page);
  await clickChar(page, 'Tail.', 1); await page.keyboard.type('Z');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\nOmega.\n\nTZail.\n');
  await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', 'paragraph:Omega.', 'paragraph:TZail.'],
    'the left transient is gone after the render');
  assert.strictEqual(await transientCount(page), 0);
}, { md: '# D\n\nAlpha.\n\nOmega.\n\nTail.\n' });
// B11 (R10): Esc in a new paragraph with text commits it, as leaving does;
// that commit is one undo step.
check('v3173 B11: Esc in a new paragraph with typed text keeps the text', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('hello');
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.deepStrictEqual({ list: await blockList(page), caret: await caretNow(page) },
    { list: ['heading:D', 'paragraph:Alpha.', 'paragraph:hello', 'paragraph:Omega.'], caret: { text: 'hello', offset: 5, transient: false } });
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\nhello\n\nOmega.\n');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD, 'one Ctrl+Z takes the Esc commit back');
}, { md: BASE_MD });
check('v3173 B11: Esc in a table cell with typed text behaves as before', DESKTOP, async (page, boot) => {
  await clickCell(page, 'y');
  await page.keyboard.press('End'); await page.keyboard.type('Z');
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.strictEqual(await commitAndRead(page, boot), A6_TABLE_MD, 'Esc reverts the cell; nothing written');
}, { md: A6_TABLE_MD });
// A8 (R9): an empty 「/待辦」 item survives Ctrl+S as `- [ ] `, caret in it.
check('v3173 A8: an empty 「/待辦」 item survives Ctrl+S with the caret in it', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('/待辦'); await page.keyboard.press('Enter'); await renderIdle(page);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', 'li:', 'paragraph:Omega.']);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n- [ ] \n\nOmega.\n');
  await renderIdle(page);
  assert.deepStrictEqual(await page.evaluate(() => {
    const a = document.activeElement;
    const li = a && a.closest ? a.closest('.ed-block[data-block-type="li"]') : null;
    return { inItem: !!li, text: li ? li.textContent.trim() : null, list: [...document.querySelectorAll('.content .ed-block')].length };
  }), { inItem: true, text: '', list: 4 });
  await page.keyboard.type('buy');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n- [ ] buy\n\nOmega.\n');
}, { md: BASE_MD });
// M3 (fix round 1, R28): every untouched empty list item from the "/" menu.
for (const [query, label, skel] of [['/項目符號', '項目符號', '-'], ['/編號', '編號', '1.']]) {
  check('v3173 A8: an empty 「/' + label + '」 item survives Ctrl+S with the caret in it', DESKTOP, async (page, boot) => {
    await focusSurface(page, 'Alpha.', 6);
    await page.keyboard.press('Enter'); await renderIdle(page);
    await page.keyboard.type(query); await page.keyboard.press('Enter'); await renderIdle(page);
    assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:Alpha.', 'li:', 'paragraph:Omega.']);
    assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n' + skel + '\n\nOmega.\n');
    await renderIdle(page);
    assert.deepStrictEqual(await page.evaluate(() => {
      const a = document.activeElement;
      const li = a && a.closest ? a.closest('.ed-block[data-block-type="li"]') : null;
      const surface = li ? li.querySelector('.ed-li-text') : null;
      return { inItem: !!li, text: surface ? surface.textContent : null, list: [...document.querySelectorAll('.content .ed-block')].length };
    }), { inItem: true, text: '', list: 4 });
    await page.keyboard.type('buy');
    assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.\n\n' + skel + ' buy\n\nOmega.\n');
  }, { md: BASE_MD });
}
// Review Focus 5: under a slow server one Enter still gives one paragraph —
// the B3 replay must not open a second one beside the Enter's own.
check('v3173 B4/B3 slow server: one Enter gives one paragraph with render delayed 1500 ms', DESKTOP, async (page, boot) => {
  await delayRender(page, 1500);
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.type('X');
  await page.keyboard.press('Enter'); await page.keyboard.type('y');
  await renderIdle(page);
  assert.deepStrictEqual({ list: await blockList(page), caret: await caretNow(page) },
    { list: ['heading:D', 'paragraph:Alpha.X', '~paragraph:y', 'paragraph:Omega.'], caret: { text: 'y', offset: 1, transient: true } });
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\nAlpha.X\n\ny\n\nOmega.\n');
}, { md: BASE_MD });

// ── v3173 Task 5: Delete at a block's end (B9, R11) ──
// Notion's Delete, the mirror of Backspace: at the end of a paragraph or
// heading it pulls the next list item's text up (an item with children is
// still selected first); at the end of a list item it pulls the next item,
// or the paragraph after the list, up. One op, one Ctrl+Z.
const selectedBlocks = (page) => page.evaluate(() => [...document.querySelectorAll('.ed-block.ed-selected')].map((b) => {
  const s = b.querySelector('.ed-li-text') || b.querySelector('.ed-wys-armed');
  return b.getAttribute('data-block-type') + ':' + (s ? s.textContent : '');
}));
check('v3173 B9: Delete at a paragraph\'s end pulls the next list item\'s text up', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'P.', 2);
  await page.keyboard.press('Delete'); await renderIdle(page);
  assert.deepStrictEqual({ selected: await selectedBlocks(page), caret: await caretNow(page) },
    { selected: [], caret: { text: 'P.a', offset: 2, transient: false } });
  assert.strictEqual(await saveAndRead(page, boot), 'P.a\n\n- b\n');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), 'P.\n\n- a\n- b\n', 'one Ctrl+Z restores the file');
}, { md: 'P.\n\n- a\n- b\n' });
check('v3173 B9: Delete at a heading\'s end pulls the next list item\'s text up', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'H', 1);
  await page.keyboard.press('Delete'); await renderIdle(page);
  assert.deepStrictEqual(await caretNow(page), { text: 'Ha', offset: 1, transient: false });
  assert.strictEqual(await saveAndRead(page, boot), '# Ha\n');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# H\n\n- a\n', 'one Ctrl+Z restores the file');
}, { md: '# H\n\n- a\n' });
for (const [label, md, text, merged, caret] of [
  ['the next item', '- a\n- b\n', 'a', '- ab\n', 'ab'],
  ['the paragraph after the list', '- a\n\nP.\n', 'a', '- aP.\n', 'aP.'],
  ['its own first child', '- a\n  - b\n- c\n', 'a', '- ab\n- c\n', 'ab'],
  ['the parent\'s next sibling', '- a\n  - b\n- c\n', 'b', '- a\n  - bc\n', 'bc'],
]) {
  check('v3173 B9: Delete at a list item\'s end pulls ' + label + ' up', DESKTOP, async (page, boot) => {
    await focusSurface(page, text, text.length);
    await page.keyboard.press('Delete'); await renderIdle(page);
    assert.deepStrictEqual(await caretNow(page), { text: caret, offset: text.length, transient: false });
    assert.strictEqual(await saveAndRead(page, boot), merged);
    await page.keyboard.press('Control+z'); await renderIdle(page);
    assert.strictEqual(await saveAndRead(page, boot), md, 'one Ctrl+Z restores the file');
  }, { md });
}
// A loose item's text sits in a <p> inside its surface. Found by probing
// (not in the triage): the first cut appended a second <p> and wrote `-`.
for (const [label, md, text, merged, caret] of [
  ['a loose list\'s next item', '- a\n\n- b\n\n- c\n', 'a', '- ab\n\n- c\n', 'ab'],
  ['the paragraph after a loose list', '- a\n\n- b\n\nP.\n', 'b', '- a\n\n- bP.\n', 'bP.'],
  ['a loose list\'s first item into a paragraph', 'P.\n\n- a\n\n- b\n', 'P.', 'P.a\n\n- b\n', 'P.a'],
]) {
  check('v3173 B9: Delete pulls ' + label + ' up', DESKTOP, async (page, boot) => {
    await focusSurface(page, text, text.length);
    await page.keyboard.press('Delete'); await renderIdle(page);
    assert.deepStrictEqual(await caretNow(page), { text: caret, offset: text.length, transient: false });
    assert.strictEqual(await saveAndRead(page, boot), merged);
    await page.keyboard.press('Control+z'); await renderIdle(page);
    assert.strictEqual(await saveAndRead(page, boot), md, 'one Ctrl+Z restores the file');
  }, { md });
}
// D7: a join whose render fails stays on screen and the next commit writes it.
for (const [label, md, text, merged] of [
  ['a list item', '# D\n\n- a\n- b\n\nP.\n', 'a', '# D\n\n- ab\n\nP.\n'],
  ['a paragraph', '# D\n\nP.\n\n- a\n- b\n', 'P.', '# D\n\nP.a\n\n- b\n'],
]) {
  check('v3173 B9: a Delete join at ' + label + '\'s end whose render fails is written by the next commit', DESKTOP, async (page, boot) => {
    await failFirstRender(page);
    await focusSurface(page, text, text.length);
    await page.keyboard.press('Delete'); await renderIdle(page);
    const screen = await blockList(page);
    assert.strictEqual(screen.length, 3, 'the screen keeps the join: ' + JSON.stringify(screen));
    assert.strictEqual(await commitAndRead(page, boot), merged);
  }, { md });
}
// D4, as for the paragraph merge: the typing before the key is its own step.
check('v3173 B9: Delete at a list item\'s end after typing is two undo steps', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'a', 1);
  await page.keyboard.type('X');
  await page.keyboard.press('Delete'); await renderIdle(page);
  assert.deepStrictEqual(await caretNow(page), { text: 'aXb', offset: 2, transient: false });
  assert.strictEqual(await saveAndRead(page, boot), '- aXb\n');
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), '- aX\n- b\n');
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), '- a\n- b\n');
}, { md: '- a\n- b\n' });
// Guard (R11): may be green before. An item that owns children is selected
// first, as today; Delete at the end of the last item changes nothing.
check('v3173 B9: Delete before an item with children keeps today\'s select-first', DESKTOP, async (page, boot) => {
  const MD = 'P.\n\n- a\n  - c\n- b\n';
  await focusSurface(page, 'P.', 2);
  await page.keyboard.press('Delete'); await renderIdle(page);
  assert.deepStrictEqual(await selectedBlocks(page), ['li:a']);
  assert.strictEqual(await saveAndRead(page, boot), MD);
  await page.keyboard.press('Escape'); await renderIdle(page);
  await focusSurface(page, 'b', 1);
  await page.keyboard.press('Delete'); await renderIdle(page);
  assert.deepStrictEqual({ selected: await selectedBlocks(page), caret: await caretNow(page) },
    { selected: [], caret: { text: 'b', offset: 1, transient: false } });
  assert.strictEqual(await saveAndRead(page, boot), MD, 'nothing after the last item');
}, { md: 'P.\n\n- a\n  - c\n- b\n' });
// Guard: may be green before. A list item's Delete before an item that owns
// children changes nothing, as today (its children would have no parent).
check('v3173 B9: Delete at a list item\'s end before an item with children changes nothing', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'x', 1);
  await page.keyboard.press('Delete'); await renderIdle(page);
  assert.deepStrictEqual({ selected: await selectedBlocks(page), caret: await caretNow(page) },
    { selected: [], caret: { text: 'x', offset: 1, transient: false } });
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- x\n- a\n  - c\n');
}, { md: '# D\n\n- x\n- a\n  - c\n' });
// Review Focus 2. Guard: may be green before.
check('v3173 B9: Delete at a table cell\'s end changes nothing outside it', DESKTOP, async (page, boot) => {
  const before = await blockList(page);
  for (const cell of ['x', 'y']) {
    await clickCell(page, cell);
    await page.keyboard.press('End');
    await page.keyboard.press('Delete'); await renderIdle(page);
    assert.deepStrictEqual(await blockList(page), before, cell);
    assert.strictEqual(await page.evaluate(() => document.activeElement.textContent), cell, 'the caret stays in ' + cell);
  }
  assert.strictEqual(await commitAndRead(page, boot), A6_TABLE_MD);
}, { md: A6_TABLE_MD });
// Scope pin (R11): a block with no text to pull up keeps today's behaviour —
// a code block below a paragraph is selected, below a list item nothing.
check('v3173 B9: Delete before a code block keeps today\'s behaviour', DESKTOP, async (page, boot) => {
  const MD = 'P.\n\n```\ncode\n```\n\n- a\n\n```\nmore\n```\n';
  await focusSurface(page, 'P.', 2);
  await page.keyboard.press('Delete'); await renderIdle(page);
  assert.deepStrictEqual((await selectedBlocks(page)).map((s) => s.split(':')[0]), ['code']);
  assert.strictEqual(await saveAndRead(page, boot), MD);
  await page.keyboard.press('Escape'); await renderIdle(page);
  await focusSurface(page, 'a', 1);
  await page.keyboard.press('Delete'); await renderIdle(page);
  assert.deepStrictEqual({ selected: await selectedBlocks(page), caret: await caretNow(page) },
    { selected: [], caret: { text: 'a', offset: 1, transient: false } });
  assert.strictEqual(await saveAndRead(page, boot), MD);
}, { md: 'P.\n\n```\ncode\n```\n\n- a\n\n```\nmore\n```\n' });
// Fix round 1, R34: an item over several source lines counts as one with
// children. Below a paragraph it is selected, as before B9; at or below a
// list item's end the browser's own Delete changes nothing. Never the
// refusal notice. Measured before: the notice, and nothing selected.
for (const [label, md, selected] of [
  ['a hard-wrapped item', 'P.\n\n- a\n  wrapped\n- b\n', 'li:a\nwrapped'],
  ['an item with a continuation paragraph', 'P.\n\n- a\n\n  more\n- b\n', 'li:a\nmore'],
]) {
  check('v3173 B9: Delete at a paragraph\'s end before ' + label + ' selects it', DESKTOP, async (page, boot) => {
    await focusSurface(page, 'P.', 2);
    await page.keyboard.press('Delete'); await renderIdle(page);
    assert.deepStrictEqual({ selected: await selectedBlocks(page), notice: await noticeText(page) },
      { selected: [selected], notice: null });
    assert.strictEqual(await saveAndRead(page, boot), md);
  }, { md });
}
for (const [label, md, prefix] of [
  ['at the end of a hard-wrapped item', '- a\n  wrapped\n- b\n', 'a'],
  ['before a hard-wrapped item', '- x\n- a\n  wrapped\n', 'x'],
]) {
  check('v3173 B9: Delete ' + label + ' changes nothing and shows no notice', DESKTOP, async (page, boot) => {
    const text = await page.evaluate((p) => [...document.querySelectorAll('.ed-li-text')].find((s) => s.textContent.indexOf(p) === 0).textContent, prefix);
    await focusSurfaceStarting(page, prefix, text.length);
    await page.keyboard.press('Delete'); await renderIdle(page);
    assert.deepStrictEqual({ selected: await selectedBlocks(page), notice: await noticeText(page), caret: await caretNow(page) },
      { selected: [], notice: null, caret: { text, offset: text.length, transient: false } });
    assert.strictEqual(await saveAndRead(page, boot), md);
  }, { md });
}
// Fix round 1, M1: inline marks across the seam. Guards: green before the
// round (the join already merges same marks and keeps a link whole).
for (const [label, md, text, merged] of [
  ['bold meets bold', '- **a**\n- **b**\n', 'a', '- **ab**\n'],
  ['a link comes up whole', 'P.\n\n- [x](u) b\n', 'P.', 'P.[x](u) b\n'],
]) {
  check('v3173 B9: Delete join marks — ' + label, DESKTOP, async (page, boot) => {
    await focusSurface(page, text, text.length);
    await page.keyboard.press('Delete'); await renderIdle(page);
    assert.strictEqual(await saveAndRead(page, boot), merged);
    await page.keyboard.press('Control+z'); await renderIdle(page);
    assert.strictEqual(await saveAndRead(page, boot), md, 'one Ctrl+Z restores the file');
  }, { md });
}
// Fix round 1, M2: a Shift+Enter typed before the Delete is `<br>` on the
// item's own line; the typing is still its own step. Guard: green before.
check('v3173 B9: Delete after Shift+Enter in a list item is two undo steps', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'a', 1);
  await page.keyboard.press('Shift+Enter'); await page.keyboard.type('x');
  await page.keyboard.press('Delete'); await renderIdle(page);
  assert.deepStrictEqual(await caretNow(page), { text: 'axb', offset: 2, transient: false });
  assert.strictEqual(await saveAndRead(page, boot), '- a<br>xb\n');
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), '- a<br>x\n- b\n');
  await tb(page, 'undo');
  assert.strictEqual(await saveAndRead(page, boot), '- a\n- b\n');
}, { md: '- a\n- b\n' });
// Fix round 1, M3 (R35, accepted): a list that was loose only by the blank
// line around its first item turns tight once that item is pulled up.
check('v3173 B9: pulling the first item out of a list loose only around it leaves the list tight', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'P.', 2);
  await page.keyboard.press('Delete'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), 'P.a\n\n- b\n- c\n');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), 'P.\n\n- a\n\n- b\n- c\n', 'one Ctrl+Z restores the file');
}, { md: 'P.\n\n- a\n\n- b\n- c\n' });

// ── v3173 N1 (R33): Backspace into a loose list's last item ──
// Found during Task 5: joinIntoPrevious() appended beside the loose item's
// <p> and the item's text was lost (`- a\n\n- P.\n`).
check('v3173 N1: Backspace at a paragraph\'s start after a loose list joins the last item', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'P.', 0);
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.deepStrictEqual(await caretNow(page), { text: 'bP.', offset: 1, transient: false });
  assert.strictEqual(await saveAndRead(page, boot), '- a\n\n- bP.\n');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '- a\n\n- b\n\nP.\n', 'one Ctrl+Z restores the file');
}, { md: '- a\n\n- b\n\nP.\n' });
// Guard: green before — the tight list joins as it always has.
check('v3173 N1: Backspace at a paragraph\'s start after a tight list joins as before', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'P.', 0);
  await page.keyboard.press('Backspace'); await renderIdle(page);
  assert.deepStrictEqual(await caretNow(page), { text: 'bP.', offset: 1, transient: false });
  assert.strictEqual(await saveAndRead(page, boot), '- a\n- bP.\n');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '- a\n- b\n\nP.\n', 'one Ctrl+Z restores the file');
}, { md: '- a\n- b\n\nP.\n' });

// ── v3.17.3 Task 6 (B2, R12): selected text dragged to another block moves
// in ONE op. Before, the source's deleteByDrag committed and re-rendered over
// the target's insertFromDrop, so the text was gone from both blocks. A real
// native drag: the selection is pressed in its middle, moved in steps to the
// left edge (+1px) of character `destOffset` of the element matching
// `destSel` whose trimmed text is `destText`, and released. Returns the
// browser's own caret offset at the release point (caretPositionFromPoint /
// caretRangeFromPoint, measured before the press), so each check pins where
// the browser puts the drop. ──
async function dragSelectionTo(page, destSel, destText, destOffset) {
  const pts = await page.evaluate(([sel, t, o]) => {
    const s = getSelection();
    if (!s.rangeCount || s.isCollapsed) return null;
    const r = s.getRangeAt(0).getBoundingClientRect();
    const host = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === t);
    if (!host) return null;
    const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let left = o; let b = null;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (left < n.data.length) {
        const cr = document.createRange(); cr.setStart(n, left); cr.setEnd(n, left + 1);
        b = cr.getBoundingClientRect(); break;
      }
      left -= n.data.length;
    }
    if (!b) return null;
    const x = b.left + 1; const y = b.top + b.height / 2;
    let node = null; let off = 0;
    if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (p) { node = p.offsetNode; off = p.offset; } }
    else if (document.caretRangeFromPoint) { const p = document.caretRangeFromPoint(x, y); if (p) { node = p.startContainer; off = p.startOffset; } }
    let caret = null;
    if (node && host.contains(node)) { const m = document.createRange(); m.setStart(host, 0); m.setEnd(node, off); caret = m.toString().length; }
    return { from: [r.left + r.width / 2, r.top + r.height / 2], to: [x, y], caret };
  }, [destSel, destText, destOffset]);
  assert.ok(pts, 'dragSelectionTo: no selection, or no ' + destSel + ' with text ' + JSON.stringify(destText));
  await page.mouse.move(pts.from[0], pts.from[1]);
  await page.mouse.down();
  await page.mouse.move(pts.to[0], pts.to[1], { steps: 12 });
  await page.mouse.up();
  await wait(300); await renderIdle(page); await wait(200); await renderIdle(page);
  return pts.caret;
}
const SURFACE_SEL = '.ed-wys-armed, .ed-wys-cell';
const surfaceTexts = (page) => page.evaluate(() => [...document.querySelectorAll('.content .ed-wys-armed')].map((e) => e.textContent));
const shownNotice = (page) => page.evaluate(() => {
  const n = document.querySelector('.ed-conflict[data-level="notice"]');
  return n ? n.querySelector('.ed-msg-text').textContent : null;
});
const B2_MD = 'Alpha bravo charlie.\n\nOmega delta.\n';
check('v3173 B2: dragging a word to another paragraph moves it', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'Alpha bravo charlie.', 6, 11);
  assert.strictEqual(await dragSelectionTo(page, SURFACE_SEL, 'Omega delta.', 7), 7, 'the browser drops before the 8th character');
  assert.deepStrictEqual(await surfaceTexts(page), ['Alpha  charlie.', 'Omega dbravoelta.']);
  assert.strictEqual(await saveAndRead(page, boot), 'Alpha  charlie.\n\nOmega dbravoelta.\n');
  assert.strictEqual(await shownNotice(page), null, 'no notice');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), B2_MD, 'one Ctrl+Z restores the file');
}, { md: B2_MD });
check('v3173 B2: a dragged CJK word moves intact', DESKTOP, async (page, boot) => {
  await selectInSurface(page, '甲乙丙丁戊。', 1, 3);
  assert.strictEqual(await dragSelectionTo(page, SURFACE_SEL, '子丑寅卯。', 2), 2);
  assert.strictEqual(await saveAndRead(page, boot), '甲丁戊。\n\n子丑乙丙寅卯。\n');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '甲乙丙丁戊。\n\n子丑寅卯。\n', 'one Ctrl+Z restores the file');
}, { md: '甲乙丙丁戊。\n\n子丑寅卯。\n' });
// Marks: the selection's own Markdown moves, so a bold word stays bold and
// part of a link keeps its link.
check('v3173 B2: a dragged bold word stays bold', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'Alpha bravo charlie.', 6, 11);
  assert.strictEqual(await dragSelectionTo(page, SURFACE_SEL, 'Omega delta.', 7), 7);
  assert.strictEqual(await saveAndRead(page, boot), 'Alpha  charlie.\n\nOmega d**bravo**elta.\n');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), 'Alpha **bravo** charlie.\n\nOmega delta.\n', 'one Ctrl+Z restores the file');
}, { md: 'Alpha **bravo** charlie.\n\nOmega delta.\n' });
check('v3173 B2: a dragged link keeps its link', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'See the docs here.', 4, 12);
  assert.strictEqual(await dragSelectionTo(page, SURFACE_SEL, 'Omega delta.', 6), 6);
  assert.strictEqual(await saveAndRead(page, boot), 'See  here.\n\nOmega [the docs](https://example.com/)delta.\n');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), 'See [the docs](https://example.com/) here.\n\nOmega delta.\n', 'one Ctrl+Z restores the file');
}, { md: 'See [the docs](https://example.com/) here.\n\nOmega delta.\n' });
check('v3173 B2: a word dragged from a paragraph into a list item moves', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'Alpha bravo charlie.', 6, 11);
  assert.strictEqual(await dragSelectionTo(page, SURFACE_SEL, 'two', 1), 1);
  assert.strictEqual(await saveAndRead(page, boot), 'Alpha  charlie.\n\n- one\n- tbravowo\n- three\n');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), 'Alpha bravo charlie.\n\n- one\n- two\n- three\n', 'one Ctrl+Z restores the file');
}, { md: 'Alpha bravo charlie.\n\n- one\n- two\n- three\n' });
check('v3173 B2: text dragged between two items of one list moves', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'alpha', 1, 4);
  assert.strictEqual(await dragSelectionTo(page, SURFACE_SEL, 'charlie', 1), 1);
  assert.strictEqual(await saveAndRead(page, boot), '# H\n\n- aa\n- bravo\n- clphharlie\n');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# H\n\n- alpha\n- bravo\n- charlie\n', 'one Ctrl+Z restores the file');
}, { md: '# H\n\n- alpha\n- bravo\n- charlie\n' });
check('v3173 B2: a word dragged up into a heading moves', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'Alpha bravo charlie.', 6, 12);
  assert.strictEqual(await dragSelectionTo(page, SURFACE_SEL, 'Title', 0), 0);
  assert.strictEqual(await saveAndRead(page, boot), '# bravo Title\n\nAlpha charlie.\n');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# Title\n\nAlpha bravo charlie.\n', 'one Ctrl+Z restores the file');
}, { md: '# Title\n\nAlpha bravo charlie.\n' });
// A paragraph whose whole text is dragged away is removed, as an emptied
// paragraph is (R95), in the same op.
check('v3173 B2: dragging a paragraph\'s whole text away removes the paragraph', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'Mid.', 0, 4);
  assert.strictEqual(await dragSelectionTo(page, SURFACE_SEL, 'Omega delta.', 6), 6);
  assert.strictEqual(await saveAndRead(page, boot), 'Alpha.\n\nOmega Mid.delta.\n');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), 'Alpha.\n\nMid.\n\nOmega delta.\n', 'one Ctrl+Z restores the file');
}, { md: 'Alpha.\n\nMid.\n\nOmega delta.\n' });
// D4: typing in the source before the drag is its own, earlier undo step.
check('v3173 B2: a drag after typing in the source is two undo steps', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha bravo charlie.', 20); await page.keyboard.type('X');
  await selectInSurface(page, 'Alpha bravo charlie.X', 6, 11);
  assert.strictEqual(await dragSelectionTo(page, SURFACE_SEL, 'Omega delta.', 7), 7);
  assert.strictEqual(await saveAndRead(page, boot), 'Alpha  charlie.X\n\nOmega dbravoelta.\n');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), 'Alpha bravo charlie.X\n\nOmega delta.\n', 'the first Ctrl+Z takes the move back');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), B2_MD, 'the second takes the typing back');
}, { md: B2_MD });
// D7: a move whose render fails stays on screen and the next commit writes it.
check('v3173 B2: a move whose render fails is written by the next commit', DESKTOP, async (page, boot) => {
  await failFirstRender(page);
  await selectInSurface(page, 'Alpha bravo charlie.', 6, 11);
  await dragSelectionTo(page, SURFACE_SEL, 'Omega delta.', 7);
  assert.deepStrictEqual(await surfaceTexts(page), ['Alpha  charlie.', 'Omega dbravoelta.'], 'the screen keeps the move');
  assert.strictEqual(await saveAndRead(page, boot), 'Alpha  charlie.\n\nOmega dbravoelta.\n');
}, { md: B2_MD });
const B2_REFUSE_MD = 'Alpha bravo charlie.\n\n| A | B |\n|---|---|\n| a1 | b1 |\n\n```js\nlet x = 1;\n```\n';
for (const [label, sel, text, off] of [
  ['a table cell', '.ed-wys-cell', 'a1', 1],
  ['a code block', CODE_PRE, 'let x = 1;', 4],
]) {
  check('v3173 B2: a drop into ' + label + ' is refused with a notice and nothing changes', DESKTOP, async (page, boot) => {
    await selectInSurface(page, 'Alpha bravo charlie.', 6, 11);
    await dragSelectionTo(page, sel, text, off);
    assert.ok(await shownNotice(page), 'a notice says why');
    assert.strictEqual((await surfaceTexts(page))[0], 'Alpha bravo charlie.', 'the source keeps its text on screen');
    assert.strictEqual(await saveAndRead(page, boot), B2_REFUSE_MD);
  }, { md: B2_REFUSE_MD });
}
check('v3173 B2: text dragged out of a table cell into a paragraph is refused with a notice', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'a1', 0, 2);
  await dragSelectionTo(page, SURFACE_SEL, 'Alpha bravo charlie.', 6);
  assert.ok(await shownNotice(page), 'a notice says why');
  assert.strictEqual(await saveAndRead(page, boot), B2_REFUSE_MD);
}, { md: B2_REFUSE_MD });
// Scope pin (green before the fix): a drop inside the same block is the
// browser's own move and commits through the burst; no text is lost. It pins
// known defect N3 (R39, deferred): Chromium's own move writes a U+00A0. The
// spacing and the landing point are each engine's own (measured before the
// fix: Chromium keeps both spaces, the first as a no-break space (U+00A0),
// and drops before the `.`; WebKit's smart delete takes one space and its
// drop point, past the deleted word, lands after the `.`).
check('v3173 B2: same-block drag is the browser\'s own move (pins known defect N3: Chromium writes U+00A0)', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'Alpha bravo charlie.', 6, 11);
  assert.strictEqual(await dragSelectionTo(page, SURFACE_SEL, 'Alpha bravo charlie.', 19), 19);
  const want = engineOf(page) === 'webkit' ? 'Alpha charlie.bravo\n\nOmega delta.\n' : 'Alpha\u00a0 charliebravo.\n\nOmega delta.\n';
  assert.strictEqual(await saveAndRead(page, boot), want);
  assert.strictEqual(await shownNotice(page), null, 'no notice');
}, { md: B2_MD });
// A drop that did not start in the editor (another app, the reader) is not
// this handler's: it is left to the browser, never cancelled.
// Dispatches a text drop that no in-document drag started on the surface
// whose text is exactly `onText`; returns whether anything cancelled it.
const externalTextDrop = (page, onText) => page.evaluate((t) => {
  const s = [...document.querySelectorAll('.ed-wys-armed')].find((e) => e.textContent === t);
  const dt = new DataTransfer(); dt.setData('text/plain', 'zulu');
  const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 1, clientY: 1 });
  s.dispatchEvent(ev);
  return ev.defaultPrevented;
}, onText);
check('v3173 B2: a text drop from outside the editor is left to the browser', DESKTOP, async (page) => {
  assert.strictEqual(await externalTextDrop(page, 'Omega delta.'), false);
  assert.strictEqual(await shownNotice(page), null, 'no notice');
}, { md: B2_MD });
// ── fix round 1 ──
// I1: the drag's state ends with the drag even when the move detached the
// node it started on (a whole marked word, a whole paragraph's text).
// Before, the next external drop was cancelled with the refusal notice.
check('v3173 B2: after a whole bold word moves, a PNG file dropped on a paragraph is still inserted', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'Alpha bravo charlie.', 6, 11);
  await dragSelectionTo(page, SURFACE_SEL, 'Omega delta.', 7);
  await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/asset'),
    dropPngOn(page, '.content .ed-block[data-block-type="paragraph"]', PNG_160),
  ]);
  await renderIdle(page);
  assert.strictEqual(await shownNotice(page), null, 'no notice');
  assert.strictEqual(await saveAndRead(page, boot), 'Alpha  charlie.\n\n![](assets/dot.png)\n\nOmega d**bravo**elta.\n');
}, { md: 'Alpha **bravo** charlie.\n\nOmega delta.\n' });
check('v3173 B2: after a whole paragraph\'s text moves, a text drop from outside is left to the browser', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'Mid.', 0, 4);
  await dragSelectionTo(page, SURFACE_SEL, 'Omega delta.', 6);
  assert.strictEqual(await saveAndRead(page, boot), 'Alpha.\n\nOmega Mid.delta.\n');
  assert.strictEqual(await externalTextDrop(page, 'Omega Mid.delta.'), false);
  assert.strictEqual(await shownNotice(page), null, 'no notice');
}, { md: 'Alpha.\n\nMid.\n\nOmega delta.\n' });
// I2 (R37): a mark the drop point already sits inside is unwrapped, and a
// moved mark meeting one of its kind becomes one mark; a link into a link has
// no Markdown and is refused.
check('v3173 B2: a bold word dropped inside a bold word joins it', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'Alpha bravo charlie.', 6, 11);
  assert.strictEqual(await dragSelectionTo(page, SURFACE_SEL, 'Omega delta.', 8), 8);
  assert.strictEqual(await saveAndRead(page, boot), 'Alpha  charlie.\n\nOmega **debravolta**.\n');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), 'Alpha **bravo** charlie.\n\nOmega **delta**.\n', 'one Ctrl+Z restores the file');
}, { md: 'Alpha **bravo** charlie.\n\nOmega **delta**.\n' });
check('v3173 B2: a bold word dropped against a bold word becomes one bold run', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'Alpha bravo charlie.', 6, 11);
  assert.strictEqual(await dragSelectionTo(page, SURFACE_SEL, 'Omega delta.', 6), 6);
  assert.strictEqual(await saveAndRead(page, boot), 'Alpha  charlie.\n\nOmega **bravodelta**.\n');
}, { md: 'Alpha **bravo** charlie.\n\nOmega **delta**.\n' });
const B2_LINK_MD = 'See [the docs](https://example.com/) here.\n\nOmega [delta](https://x.org/).\n';
check('v3173 B2: a link dropped inside a link is refused with a notice and nothing changes', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'See the docs here.', 4, 12);
  assert.strictEqual(await dragSelectionTo(page, SURFACE_SEL, 'Omega delta.', 8), 8);
  assert.ok(await shownNotice(page), 'a notice says why');
  assert.deepStrictEqual(await surfaceTexts(page), ['See the docs here.', 'Omega delta.'], 'the screen is unchanged');
  assert.strictEqual(await saveAndRead(page, boot), B2_LINK_MD);
}, { md: B2_LINK_MD });
// M4 (R38): a drop outside every block (here the search box) is refused; it
// used to take the text out of the document into the box. (The sidebar and
// its search box are drawn only for a document with a table of contents.)
const B2_SEARCH_MD = '# D\n\n## One\n\nAlpha bravo charlie.\n\n## Two\n\nOmega delta.\n';
check('v3173 B2: text dropped on the search box is refused with a notice and stays in the document', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'Alpha bravo charlie.', 6, 11);
  const pts = await page.evaluate(() => {
    const r = getSelection().getRangeAt(0).getBoundingClientRect();
    const b = document.querySelector('#doc-search-input').getBoundingClientRect();
    return { from: [r.left + r.width / 2, r.top + r.height / 2], to: [b.left + b.width / 2, b.top + b.height / 2] };
  });
  await page.mouse.move(pts.from[0], pts.from[1]); await page.mouse.down();
  await page.mouse.move(pts.to[0], pts.to[1], { steps: 12 }); await page.mouse.up();
  await wait(300); await renderIdle(page);
  assert.ok(await shownNotice(page), 'a notice says why');
  assert.strictEqual(await page.inputValue('#doc-search-input'), '', 'the box took nothing');
  assert.strictEqual(await surfaceTexts(page).then((t) => t[2]), 'Alpha bravo charlie.', 'the source keeps its text on screen');
  assert.strictEqual(await saveAndRead(page, boot), B2_SEARCH_MD);
}, { md: B2_SEARCH_MD });
// M5: a transient at either end is refused (R12); its text stays and is
// written by the next commit, as always.
check('v3173 B2: text dragged out of a new (transient) paragraph is refused with a notice', DESKTOP, async (page, boot) => {
  await newParaBelowAlpha(page); await page.keyboard.type('new text');
  await selectInSurface(page, 'new text', 0, 3);
  await dragSelectionTo(page, SURFACE_SEL, 'Omega.', 2);
  assert.ok(await shownNotice(page), 'a notice says why');
  assert.deepStrictEqual(await surfaceTexts(page), ['D', 'Alpha.', 'new text', 'Omega.'], 'the screen is unchanged');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\nnew text\n\nOmega.\n');
}, { md: BASE_MD });
// M5: a heading whose whole text is moved away stays, empty (Notion keeps an
// emptied block); the empty heading is written as its bare `#`.
check('v3173 B2: moving a heading\'s whole text away leaves the heading empty', DESKTOP, async (page, boot) => {
  await selectInSurface(page, 'Title', 0, 5);
  assert.strictEqual(await dragSelectionTo(page, SURFACE_SEL, 'Alpha.', 0), 0);
  assert.strictEqual(await saveAndRead(page, boot), '#\n\nTitleAlpha.\n');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# Title\n\nAlpha.\n', 'one Ctrl+Z restores the file');
}, { md: '# Title\n\nAlpha.\n' });

// ── v3173 Task 7: lists (A9, A7) ──
// A9 (R5): a list keeps its own markers when it is written back — the item
// typed into, the untouched items around it, and an item Enter makes.
check('v3173 A9: editing one item of a * list keeps * on every item', DESKTOP, async (page, boot) => {
  await liText(page, 'bravo').click(); await page.keyboard.press('End'); await page.keyboard.type('X');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n* alpha\n* bravoX\n* charlie\n');
}, { md: '# D\n\n* alpha\n* bravo\n* charlie\n' });
check('v3173 A9: Enter in a * list makes a * item', DESKTOP, async (page, boot) => {
  await liText(page, 'bravo').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await renderIdle(page); await page.keyboard.type('new');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n* alpha\n* bravo\n* new\n* charlie\n');
}, { md: '# D\n\n* alpha\n* bravo\n* charlie\n' });
check('v3173 A9: editing one item of a 1) list keeps 1) on every item', DESKTOP, async (page, boot) => {
  await liText(page, 'bravo').click(); await page.keyboard.press('End'); await page.keyboard.type('X');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n1) alpha\n2) bravoX\n3) charlie\n');
}, { md: '# D\n\n1) alpha\n2) bravo\n3) charlie\n' });
check('v3173 A9: editing a nested * item under a - parent keeps both markers', DESKTOP, async (page, boot) => {
  await liText(page, 'kid').click(); await page.keyboard.press('End'); await page.keyboard.type('X');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- parent\n  * kidX\n- tail\n');
}, { md: '# D\n\n- parent\n  * kid\n- tail\n' });
check('v3173 A9: editing the only item of a + list keeps +', DESKTOP, async (page, boot) => {
  await liText(page, 'alpha').click(); await page.keyboard.press('End'); await page.keyboard.type('X');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n+ alphaX\n');
}, { md: '# D\n\n+ alpha\n' });
// Review Focus 3: `- a` and `* c` side by side are two lists; each keeps its own.
check('v3173 A9: two adjacent lists with different bullets keep their own', DESKTOP, async (page, boot) => {
  await liText(page, 'charlie').click(); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await renderIdle(page); await page.keyboard.type('new');
  assert.strictEqual(await commitAndRead(page, boot), '# D\n\n- alpha\n* charlie\n* new\n');
}, { md: '# D\n\n- alpha\n* charlie\n' });
// Review I1: an item moved into a list takes that list's marker — the list's
// own items decide, never the moved item's old marker (it used to win a 1:1
// tie and rewrite the untouched `- alpha`).
check('v3173 A9: an item dragged into a one-item list takes that list\'s marker', DESKTOP, async (page, boot) => {
  await dragBlock(page, 'moved', 'alpha');
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nPara\n\n- moved\n- alpha\n');
}, { md: '# D\n\n* moved\n\nPara\n\n- alpha\n' });
check('v3173 A9: two * items dragged into a one-item - list take its marker', DESKTOP, async (page, boot) => {
  assert.strictEqual(await selectBlocks(page, 'm1', 'm2'), 2, 'guard: two items selected');
  await dragBlock(page, 'm1', 'alpha');
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nPara\n\n- m1\n- m2\n- alpha\n');
}, { md: '# D\n\n* m1\n* m2\n\nPara\n\n- alpha\n' });
// A7 (R6): converting a paragraph into the ordered list below renumbers that
// list, as one undo step.
check('v3173 A7: converting a paragraph into the ordered list below renumbers it', DESKTOP, async (page, boot) => {
  await gutterMenu(page, await blockByText(page, 'Intro'), ['轉換成', '編號列表']);
  await renderIdle(page);
  assert.strictEqual(await noticeText(page), null, 'no refusal');
  assert.strictEqual(await saveAndRead(page, boot), '1. Intro\n2. a\n3. b\n');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), 'Intro\n\n1. a\n2. b\n', 'one Ctrl+Z restores the file');
}, { md: 'Intro\n\n1. a\n2. b\n' });
check('v3173 A7: converting a paragraph right above an all-ones list renumbers it', DESKTOP, async (page, boot) => {
  await gutterMenu(page, await blockByText(page, 'Intro'), ['轉換成', '編號列表']);
  await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n1. Intro\n2. a\n3. b\n');
}, { md: '# D\n\nIntro\n1. a\n1. b\n' });
check('v3173 A7: converting a paragraph between two ordered lists numbers it and the list below', DESKTOP, async (page, boot) => {
  await gutterMenu(page, await blockByText(page, 'Mid'), ['轉換成', '編號列表']);
  await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n1) a\n2) b\n3) Mid\n4) c\n');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n1) a\n2) b\n\nMid\n\n1) c\n', 'one Ctrl+Z restores the file');
}, { md: '# D\n\n1) a\n2) b\n\nMid\n\n1) c\n' });
check('v3173 A7: converting a paragraph below a * list joins it with *', DESKTOP, async (page, boot) => {
  await gutterMenu(page, await blockByText(page, 'Tail'), ['轉換成', '項目符號列表']);
  await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n* a\n* b\n* Tail\n');
}, { md: '# D\n\n* a\n* b\n\nTail\n' });

// N4 (R41): the typed `1. ` shortcut at the start of a paragraph with text
// joins the ordered list below and renumbers it in the same op (op 2). The
// shortcut keeps its two undo steps (D1): the first Ctrl+Z shows the typed
// literal with the list's old numbers, the second the original paragraph.
const typeAtStart = async (page, text, typed) => {
  await focusSurface(page, text, 0); await page.keyboard.type(typed); await renderIdle(page);
};
check('v3173 N4: typing 1. at the start of a paragraph above an ordered list renumbers it', DESKTOP, async (page, boot) => {
  await typeAtStart(page, 'Intro', '1. ');
  assert.strictEqual(await saveAndRead(page, boot), '1. Intro\n2. a\n3. b\n');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '1\\. Intro\n\n1. a\n2. b\n', 'one Ctrl+Z takes the conversion and the renumbering back');
  await page.keyboard.press('Control+z'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), 'Intro\n\n1. a\n2. b\n', 'the second restores the file');
}, { md: 'Intro\n\n1. a\n2. b\n' });
check('v3173 N4: typing 1. at the start of a one-letter paragraph above an ordered list renumbers it', DESKTOP, async (page, boot) => {
  await typeAtStart(page, 'x', '1. ');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n1. x\n2. a\n3. b\n');
}, { md: '# D\n\nx\n\n1. a\n2. b\n' });
check('v3173 N4: typing 1. between two ordered lists numbers the item and the list below', DESKTOP, async (page, boot) => {
  await typeAtStart(page, 'Mid', '1. ');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n1. a\n2. b\n3. Mid\n4. c\n5. d\n');
}, { md: '# D\n\n1. a\n2. b\n\nMid\n\n1. c\n2. d\n' });
check('v3173 N4: typing 1. above a 1) list joins it with 1) and renumbers it', DESKTOP, async (page, boot) => {
  await typeAtStart(page, 'Intro', '1. ');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n1) Intro\n2) a\n3) b\n');
}, { md: '# D\n\nIntro\n\n1) a\n2) b\n' });

// ── v3173 Task 8: actions during an in-flight write (B4, A12, A13) ──
// `/api/render` requests outstanding right now (the commit in flight).
const rendersOut = (page) => renderCounters.get(page).n;
const conflictShown = (page) => page.evaluate(() => !!document.querySelector('.ed-conflict'));
// Until no render has been out for 300 ms: a gesture that waited for the
// write starts its own render a poll after that write lands, which a bare
// renderIdle() can return just before.
async function rendersQuiet(page) {
  for (let i = 0; i < 8; i++) {
    await renderIdle(page); await wait(300);
    if (!rendersOut(page)) return;
  }
  throw new Error('rendersQuiet: still rendering after 8 rounds (' + rendersOut(page) + ' out)');
}
// ⠿ → `label` on the block holding `text`, reporting how many renders were
// out at the moment of the menu press (the guard that the press really fell
// inside the flight).
async function gutterPressDuringFlight(page, text, label) {
  const sel = await blockByText(page, text);
  await page.hover(sel); await wait(150);
  await page.click(sel + ' > .ed-handle'); await wait(200);
  const out = rendersOut(page);
  await page.evaluate((l) => [...document.querySelectorAll('.ed-handle-menu-btn')].find((b) => b.textContent.trim() === l).click(), label);
  return out;
}
const B4_MD = '# D\n\nAlpha.\n\nOmega.\n\nZeta.\n';
// R17: the ⠿ action waits for the write and then acts on the block it named;
// Zeta. below proves it was not some other block, and one 復原 restoring it
// proves the delete was one step.
check('v3173 B4: ⠿ 刪除 on another block during a 1500 ms render deletes it once the render lands', DESKTOP, async (page, boot) => {
  await delayRender(page, 1500);
  const t0 = renderTotal(page);
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.type('X');
  await page.locator('.ed-block[data-block-type="heading"]').first().click();
  await wait(100);
  const out = await gutterPressDuringFlight(page, 'Omega.', '刪除');
  assert.ok(out > 0, 'guard: the press fell inside the render (' + out + ' out)');
  await rendersQuiet(page);
  assert.deepStrictEqual({ list: await blockList(page), conflict: await conflictShown(page), notice: await noticeText(page),
    renders: renderTotal(page) - t0 },
  { list: ['heading:D', 'paragraph:Alpha.X', 'paragraph:Zeta.'], conflict: false, notice: null, renders: 2 },
  'the typing\'s write, then the delete\'s');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.X\n\nZeta.\n');
  await tb(page, 'undo'); await wait(300);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.X\n\nOmega.\n\nZeta.\n', 'one 復原 brings the block back');
}, { md: B4_MD });
// Review Focus 5: a second ⠿ action pressed while the first one waits gives
// its own one step, after it.
check('v3173 B4: two ⠿ 刪除 pressed during one 1500 ms render each delete their own block', DESKTOP, async (page, boot) => {
  await delayRender(page, 1500);
  const t0 = renderTotal(page);
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.type('X');
  await page.locator('.ed-block[data-block-type="heading"]').first().click();
  await wait(100);
  const out1 = await gutterPressDuringFlight(page, 'Omega.', '刪除');
  await wait(100);
  const out2 = await gutterPressDuringFlight(page, 'Zeta.', '刪除');
  assert.ok(out1 > 0 && out2 > 0, 'guard: both presses fell inside the render (' + out1 + ', ' + out2 + ')');
  await rendersQuiet(page);
  assert.deepStrictEqual({ list: await blockList(page), conflict: await conflictShown(page), renders: renderTotal(page) - t0 },
    { list: ['heading:D', 'paragraph:Alpha.X'], conflict: false, renders: 3 }, 'the typing\'s write, then one per delete');
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.X\n');
  await tb(page, 'undo'); await wait(300);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.X\n\nZeta.\n', 'one 復原 brings back the last delete only');
}, { md: B4_MD });
// Fix round 1 (R46): the re-find acts only when the block read uniquely at
// the press AND after the write, and the write was not an undo or redo (whose
// result is not on screen at the press). Otherwise the notice, as before.
// (a) The reviewer's case: two `Omega.` on screen, the in-flight undo turns
// the first back into `Alpha.`; ⠿ 刪除 on the first used to delete the
// second, silently (measured: `# D\n\nAlpha.\n`).
check('v3173 B4: ⠿ 刪除 on the first of two identical paragraphs while an undo renders is refused and deletes nothing', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6);
  await page.keyboard.press('Shift+Home');
  await page.keyboard.type('Omega.');
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await renderIdle(page); await wait(300);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nOmega.\n\nOmega.\n', 'guard: two identical paragraphs');
  await delayRender(page, 1500);
  await page.click('[data-ed-tb="undo"]'); await wait(100);
  const out = await gutterPressDuringFlight(page, 'Omega.', '刪除');
  assert.ok(out > 0, 'guard: the press fell inside the undo\'s render (' + out + ' out)');
  await rendersQuiet(page);
  await page.unroute('**/api/render');
  assert.deepStrictEqual({ list: await blockList(page), notice: await noticeText(page) },
    { list: ['heading:D', 'paragraph:Alpha.', 'paragraph:Omega.'], notice: '文件已更新，請重試這個操作' });
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\nOmega.\n');
}, { md: BASE_MD });
// (b) Two identical paragraphs at the press, a write that is not an undo in
// flight (the second one converted to a heading), so after it lands the
// first is the only paragraph reading `Twin.`: refused all the same — the
// press could not tell which one it named.
check('v3173 B4: ⠿ 刪除 on one of two identical paragraphs while another write renders is refused and deletes nothing', DESKTOP, async (page, boot) => {
  // 3000 ms: the two-step ⠿ menu takes about 1.3 s before the press.
  await delayRender(page, 3000);
  const second = await page.evaluate(() => {
    const p = [...document.querySelectorAll('.content .ed-block[data-block-type="paragraph"]')].filter((b) => b.textContent.trim() === 'Twin.')[1];
    p.setAttribute('data-b4-second', '1'); return '[data-b4-second="1"]';
  });
  await gutterMenu(page, second, ['轉換成', '標題 1']);
  const atPress = await blockList(page);
  const first = await guMark(page, 'Twin.');
  const out = await gutterPressDuringFlight(page, 'Twin.', '刪除');
  assert.ok(first && out > 0, 'guard: the press fell inside the conversion\'s render (' + out + ' out)');
  assert.deepStrictEqual(atPress, ['heading:D', 'paragraph:Twin.', 'paragraph:Twin.', 'paragraph:End.'], 'guard: two identical paragraphs on screen at the press');
  await rendersQuiet(page);
  await page.unroute('**/api/render');
  assert.deepStrictEqual({ list: await blockList(page), notice: await noticeText(page) },
    { list: ['heading:D', 'paragraph:Twin.', 'heading:Twin.', 'paragraph:End.'], notice: '文件已更新，請重試這個操作' });
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nTwin.\n\n# Twin.\n\nEnd.\n');
}, { md: '# D\n\nTwin.\n\nTwin.\n\nEnd.\n' });

// A12: the toolbar 復原 pressed while the raw box's commit renders undoes that
// commit once it lands — one press, one step. Omega.Y underneath is the step
// a press that undid twice would also take back.
for (const ms of [50, 500]) {
  check('v3173 A12: one toolbar 復原 during the render after a raw-box Ctrl+Enter restores the file (pressed at ' + ms + ' ms)', DESKTOP, async (page, boot) => {
    await focusSurface(page, 'Omega.', 6); await page.keyboard.type('Y');
    await page.locator('.ed-block[data-block-type="heading"]').first().click(); await renderIdle(page);
    await delayRender(page, 1500);
    await gutterMenu(page, await blockByText(page, 'Alpha.'), 'MD 原始碼');
    assert.strictEqual(await page.evaluate(() => !!document.querySelector('textarea.ed-raw')), true, 'guard: raw box open');
    await page.focus('textarea.ed-raw');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Beta\n\nGamma');
    const t0 = renderTotal(page);
    await page.keyboard.press('Control+Enter');
    await wait(ms);
    const out = rendersOut(page);
    await page.click('[data-ed-tb="undo"]');
    assert.ok(out > 0, 'guard: the press fell inside the render (' + out + ' out)');
    await rendersQuiet(page);
    assert.deepStrictEqual({ list: await blockList(page), conflict: await conflictShown(page), renders: renderTotal(page) - t0 },
      { list: ['heading:D', 'paragraph:Alpha.', 'paragraph:Omega.Y'], conflict: false, renders: 2 }, 'the raw commit\'s write, then the undo\'s');
    assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\nOmega.Y\n', 'one press undid the raw commit only');
    await tb(page, 'redo'); await wait(300);
    assert.strictEqual(await saveAndRead(page, boot), '# D\n\nBeta\n\nGamma\n\nOmega.Y\n', 'and 重做 brings it back in one step');
  }, { md: BASE_MD });
}
// Fix round 1 (R47): the same with the keyboard's Ctrl+Z / Ctrl+Y.
for (const ms of [50, 500]) {
  check('v3173 A12: one Ctrl+Z during the render after a raw-box Ctrl+Enter restores the file (pressed at ' + ms + ' ms)', DESKTOP, async (page, boot) => {
    await focusSurface(page, 'Omega.', 6); await page.keyboard.type('Y');
    await page.locator('.ed-block[data-block-type="heading"]').first().click(); await renderIdle(page);
    await delayRender(page, 1500);
    await gutterMenu(page, await blockByText(page, 'Alpha.'), 'MD 原始碼');
    await page.focus('textarea.ed-raw');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Beta\n\nGamma');
    const t0 = renderTotal(page);
    await page.keyboard.press('Control+Enter');
    await wait(ms);
    const out = rendersOut(page);
    const focusAtPress = await page.evaluate(() => { const a = document.activeElement; return a ? a.tagName + '.' + a.className : null; });
    await page.keyboard.press('Control+z');
    assert.ok(out > 0, 'guard: the press fell inside the render (' + out + ' out)');
    await rendersQuiet(page);
    // Measured before the fix: the press went to the box (focus is still in
    // it) and undid nothing — `Beta` / `Gamma` stayed, one render.
    assert.deepStrictEqual({ focusAtPress, list: await blockList(page), renders: renderTotal(page) - t0, disk: await saveAndRead(page, boot) },
      { focusAtPress: 'TEXTAREA.ed-raw', list: ['heading:D', 'paragraph:Alpha.', 'paragraph:Omega.Y'], renders: 2, disk: '# D\n\nAlpha.\n\nOmega.Y\n' });
    await page.keyboard.press('Control+y'); await rendersQuiet(page);
    assert.strictEqual(await saveAndRead(page, boot), '# D\n\nBeta\n\nGamma\n\nOmega.Y\n', 'and Ctrl+Y brings it back in one step');
  }, { md: BASE_MD });
}
// Review Focus 5: two presses during the render are two steps — the raw
// commit, then Omega.Y — never one, never three.
check('v3173 A12: two toolbar 復原 during the render after a raw-box Ctrl+Enter undo two steps', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Omega.', 6); await page.keyboard.type('Y');
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await renderIdle(page);
  await delayRender(page, 1500);
  await gutterMenu(page, await blockByText(page, 'Alpha.'), 'MD 原始碼');
  await page.focus('textarea.ed-raw');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Beta\n\nGamma');
  const t0 = renderTotal(page);
  await page.keyboard.press('Control+Enter');
  await wait(50); await page.click('[data-ed-tb="undo"]');
  await wait(300); await page.click('[data-ed-tb="undo"]');
  assert.ok(rendersOut(page) > 0, 'guard: both presses fell inside the render');
  await rendersQuiet(page);
  assert.deepStrictEqual({ list: await blockList(page), conflict: await conflictShown(page), renders: renderTotal(page) - t0 },
    { list: ['heading:D', 'paragraph:Alpha.', 'paragraph:Omega.'], conflict: false, renders: 3 }, 'the raw commit, then one render per undo');
  assert.strictEqual(await saveAndRead(page, boot), BASE_MD);
}, { md: BASE_MD });

// A13: a press in the diagram source (or the in-place code edit) is that
// editor's own text selection — never a block-selection drag, never a click
// that resolves the editor.
const A13_MD = '# D\n\nAlpha.\n\nBravo.\n\n```dot\ndigraph { a -> b }\n```\n\nOmega.\n';
const A13_SRC = 'textarea.ed-diagram-src';
const A13_CODE = 'pre[data-ed-code-edit]';
// A point inside the editor `sel` a few characters into its first line, so a
// drag upward from it has text to select (from the very first character
// there is none: the selection stops at the editor's start). A textarea's
// characters have no rectangles: 24 px in on its first line is its third
// character in both engines (measured: selectionStart 2).
const ownEditorPoint = (page, sel) => page.evaluate((q) => {
  const ed = document.querySelector(q);
  let x; let y;
  if (ed.tagName === 'TEXTAREA') {
    const r = ed.getBoundingClientRect();
    x = r.left + 24; y = r.top + 12;
  } else {
    const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    let n = w.nextNode();
    while (n && n.data.length < 4) n = w.nextNode();
    const rg = document.createRange(); rg.setStart(n, 3); rg.setEnd(n, 4);
    const b = rg.getBoundingClientRect();
    x = b.left + b.width / 2; y = b.top + b.height / 2;
  }
  const hit = document.elementFromPoint(x, y);
  return { x, y, inside: !!(hit && hit.closest && hit.closest(q)) };
}, sel);
const textPoint = (page, t) => page.evaluate((s) => {
  const walker = document.createTreeWalker(document.querySelector('.content'), NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = n.data.indexOf(s);
    if (i === -1) continue;
    const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + s.length);
    const b = r.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }
  return null;
}, t);
// Whether blocks are selected, the editor `sel` is still open and focused,
// and it holds a non-empty text selection (the textarea's own range, or the
// document selection inside the code edit).
const a13State = (page, sel) => page.evaluate((q) => {
  const ed = document.querySelector(q);
  let textSelected = false;
  if (ed && ed.tagName === 'TEXTAREA') textSelected = ed.selectionEnd > ed.selectionStart;
  else if (ed) { const s = getSelection(); textSelected = !!s.rangeCount && !s.isCollapsed && ed.contains(s.anchorNode); }
  return { selected: document.querySelectorAll('.ed-block.ed-selected').length, open: !!ed,
    focused: !!ed && document.activeElement === ed, textSelected };
}, sel);
// Press in the editor `sel`, move to `to` in steps, read the state at the
// end of the move (before the release) and again after it.
async function dragFromOwnEditor(page, sel, to) {
  const from = await ownEditorPoint(page, sel);
  assert.strictEqual(from.inside, true, 'guard: the press lands in ' + sel);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
    await wait(30);
  }
  const mid = await a13State(page, sel);
  await page.mouse.up(); await wait(400);
  return { mid, after: await a13State(page, sel) };
}
// A point on the page margin left of the content, level with `sel`, that
// is outside every block.
const marginPoint = (page, sel) => page.evaluate((q) => {
  const r = document.querySelector(q).getBoundingClientRect();
  const c = document.querySelector('.content').getBoundingClientRect();
  const x = Math.max(4, c.left - 60); const y = r.top + 12;
  const hit = document.elementFromPoint(x, y);
  return { x, y, inBlock: !!(hit && hit.closest && hit.closest('.ed-block')) };
}, sel);
const A13_WANT = { selected: 0, open: true, focused: true, textSelected: true };
check('v3173 A13: a drag that starts in the diagram source textarea selects text, not blocks', DESKTOP, async (page, boot) => {
  await openDiagPanel(page, '.graphviz svg'); await renderIdle(page);
  const to = await textPoint(page, 'Alpha.');
  assert.ok(to, 'guard: Alpha. is on screen');
  assert.deepStrictEqual(await dragFromOwnEditor(page, A13_SRC, to), { mid: A13_WANT, after: A13_WANT });
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), A13_MD, 'nothing written');
}, { md: A13_MD });
check('v3173 A13: a drag from the diagram source out to the page margin keeps the panel open', DESKTOP, async (page, boot) => {
  await openDiagPanel(page, '.graphviz svg'); await renderIdle(page);
  const to = await marginPoint(page, A13_SRC);
  assert.strictEqual(to.inBlock, false, 'guard: the release point is outside every block');
  assert.deepStrictEqual(await dragFromOwnEditor(page, A13_SRC, to), { mid: A13_WANT, after: A13_WANT });
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), A13_MD, 'nothing written');
}, { md: A13_MD });
check('v3173 A13: a drag that starts in an open code edit selects text, not blocks', DESKTOP, async (page, boot) => {
  await clickText(page, 'endmodule'); await renderIdle(page);
  assert.strictEqual((await codeEditUntil(page) || {}).focused, true, 'guard: the edit is open');
  const to = await textPoint(page, 'Alpha.');
  assert.deepStrictEqual(await dragFromOwnEditor(page, A13_CODE, to), { mid: A13_WANT, after: A13_WANT });
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), CODE_MD, 'nothing written');
}, { md: CODE_MD });
check('v3173 A13: a drag from an open code edit out to the page margin keeps the edit open', DESKTOP, async (page, boot) => {
  await clickText(page, 'endmodule'); await renderIdle(page);
  assert.strictEqual((await codeEditUntil(page) || {}).focused, true, 'guard: the edit is open');
  const to = await marginPoint(page, A13_CODE);
  assert.strictEqual(to.inBlock, false, 'guard: the release point is outside every block');
  assert.deepStrictEqual(await dragFromOwnEditor(page, A13_CODE, to), { mid: A13_WANT, after: A13_WANT });
  await page.keyboard.press('Escape'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), CODE_MD, 'nothing written');
}, { md: CODE_MD });
// Fix round 1 (R47 M2): a native drag of selected source text inside the
// textarea ends without a pointerup (Chromium sends pointercancel), so the
// press's mark used to stay set and swallowed the next click that came with
// no press of its own — here a synthetic click outside every block, which
// resolves (commits) the panel.
check('v3173 A13: after dragging selected source text inside the panel, a click outside every block still commits the panel', DESKTOP, async (page, boot) => {
  await openDiagPanel(page, '.graphviz svg'); await renderIdle(page);
  await diagSelect(page, 0, 7);
  const from = await ownEditorPoint(page, A13_SRC);
  const end = await page.evaluate(() => { const r = document.querySelector('textarea.ed-diagram-src').getBoundingClientRect(); return { x: r.right - 40, y: r.top + 12 }; });
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(from.x + (end.x - from.x) * i / 10, end.y); await wait(30); }
  await page.mouse.up(); await wait(400);
  const moved = await diagPanel(page);
  assert.ok(moved && moved.value !== DOT_SRC && moved.value.replace(/\s/g, '').length === DOT_SRC.replace(/\s/g, '').length,
    'guard: the drag moved text inside the source: ' + JSON.stringify(moved && moved.value));
  const t0 = renderTotal(page);
  await page.evaluate(() => document.querySelector('.content').click());
  await rendersQuiet(page);
  assert.deepStrictEqual({ panel: !!(await diagPanel(page)), renders: renderTotal(page) - t0 }, { panel: false, renders: 1 },
    'the click resolved the panel and wrote it');
  assert.strictEqual(await saveAndRead(page, boot), A13_MD.replace(DOT_SRC, moved.value));
}, { md: A13_MD });

(async () => {
  const engines = (process.env.MD2DOC_ENGINES || 'chromium,webkit').split(',').map((s) => s.trim()).filter(Boolean);
  const only = process.argv[2];
  let failed = 0; let ran = 0;
  for (const engine of engines) {
    const browser = await playwright[engine].launch();
    try {
      for (const c of checks) {
        if (only && !c.name.includes(only)) continue;
        if (c.opts.engines && c.opts.engines.indexOf(engine) === -1) continue;
        ran++;
        const boot = await bootEditor(c.opts.md, c.opts.srv, c.opts.assets);
        const context = await browser.newContext(Object.assign({ viewport: c.viewport }, c.opts.ctx));
        const page = await context.newPage();
        const errs = [];
        page.on('pageerror', (e) => errs.push(String(e)));
        trackRenders(page);
        try {
          await page.goto(boot.url, { waitUntil: 'load' });
          await page.waitForSelector('.ed-toolbar');
          await wait(400);
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
  if (failed) { console.error(failed + ' of ' + ran + ' editor click check(s) failed'); process.exit(1); }
  console.log('editor-click: ' + ran + ' checks passed');
  process.exit(0);
})();
