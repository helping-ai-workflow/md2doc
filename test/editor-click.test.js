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
async function bootEditor(mdText, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-edclick-'));
  const mdPath = path.join(dir, 'doc.md');
  fs.writeFileSync(mdPath, mdText === undefined ? FIXTURE : mdText, 'utf8');
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
  assert.deepStrictEqual(await signalNow(page), [a, { name: '', wave: 'x' }, b, c, d], '在下方新增訊號');
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
  assert.deepStrictEqual(await signalNow(page), base.concat([{ name: '', wave: 'x' }]), 'a new signal at the end');
  assert.strictEqual(await page.evaluate(() => document.querySelector('.ed-wave-overlay').getAttribute('data-wave-lanes')), '5');
}, { md: WAVE_LANES_MD });

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
  // c's `*` comes out as `-`: its indent changed, so it is re-serialized
  // rather than replayed, and both items are now one nested bullet list.
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\n- a\n  - b\n  - c\n');
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
  assert.strictEqual(await page.evaluate(() => !!document.querySelector('textarea.ed-raw')), true, 'raw box open');
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
  ['quote', 'quote', 'raw'], ['code', 'code', 'raw'],
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
      assert.deepStrictEqual(await rawBox(page), { value: '```\n\n```', caret: 4, focused: true });
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
async function pickImage(page, chooser) {
  await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/asset'),
    chooser.setFiles({ name: 'dot.png', mimeType: 'image/png', buffer: Buffer.from(PNG_1PX, 'base64') }),
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
check('slash: a picker left unanswered from a real "/圖片" leaves the paragraph as typed', DESKTOP, async (page, boot) => {
  const chooserP = page.waitForEvent('filechooser');
  await emptyAlphaTo(page, '/圖片');
  await page.keyboard.press('Enter');
  await chooserP; await wait(300);
  assert.deepStrictEqual(await blockList(page), ['heading:D', 'paragraph:/圖片', 'paragraph:Omega.']);
  assert.strictEqual(fs.readFileSync(boot.mdPath, 'utf8'), BASE_MD, 'nothing written');
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
// The raw box commits with Ctrl+Enter (openRawEditor()'s own keydown).
check('shortcut: "```" opens a code box with the caret on the fence line', DESKTOP, async (page, boot) => {
  await focusSurface(page, 'Alpha.', 6); await page.keyboard.press('Enter'); await renderIdle(page);
  await page.keyboard.type('```'); await renderIdle(page);
  assert.deepStrictEqual(await rawBox(page), { value: '```\n\n```', caret: 3, focused: true });
  await page.keyboard.type('js'); await page.keyboard.press('Enter'); await page.keyboard.type('x = 1');
  await page.keyboard.press('Control+Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n```js\nx = 1\n```\n\nOmega.\n');
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
check('shortcut: "```js", Enter, "x = 1" typed straight on during a slow render land in the code box (R59)', DESKTOP, async (page, boot) => {
  await newParaBelowAlpha(page);
  await delayRender(page, 800);
  await page.keyboard.type('```js'); await page.keyboard.press('Enter'); await page.keyboard.type('x = 1');
  await renderIdle(page);
  assert.deepStrictEqual(await rawBox(page), { value: '```js\nx = 1\n```', caret: 11, focused: true });
  assert.strictEqual(await noticeText(page), null, 'nothing dropped');
  await page.keyboard.press('Control+Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlpha.\n\n```js\nx = 1\n```\n\nOmega.\n');
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
// after it, a second the paragraph as it was. (A raw box is left with
// Escape first.)
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
    if (await rawBox(page)) { await page.keyboard.press('Escape'); await renderIdle(page); }
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
check('link-field: a scroll closes it', DESKTOP, async (page) => {
  await selectInSurface(page, 'Plain words here.', 6, 11);
  await page.keyboard.press('Control+k');
  assert.strictEqual((await linkField(page)).open, true);
  await page.evaluate(() => { document.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('scroll')); });
  await wait(100);
  assert.strictEqual((await linkField(page)).open, false);
  // Closed by a scroll means back to the toolbar with the selection kept.
  const r = await page.evaluate(() => ({ sel: String(getSelection()), bar: !!document.querySelector('.ed-seltb') && document.querySelector('.ed-seltb').isConnected }));
  assert.deepStrictEqual([r.sel, r.bar], ['words', true]);
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
// it, then acts on the block it was opened on — or refuses with the notice
// when that block was redrawn. Never on the block one paragraph up. Measured
// at ffbdd7c: ⠿ 刪除 on `Omega.` deleted `Middle.`.
const FF_GUTTER_MD = '# D\n\nAlpha para one.\n\nMiddle.\n\nOmega.\n';
const FF_SPLIT = '# D\n\nAlpha\n\npara one.\n\nMiddle.\n';
// Final re-review N3: the branch that runs is the refusal — the split's
// render replaces every block below it, so the pressed `Omega.` node is gone
// once the render lands — and these checks pin that branch, then show the
// next gesture on the redrawn block acts on it.
check('gutter-settle: ⠿ 刪除 picked while a split above renders is refused with the notice and deletes nothing; the next 刪除 deletes it (R94)', DESKTOP, async (page, boot) => {
  await delayRender(page, 2500);
  await focusSurface(page, 'Alpha para one.', 5); await page.keyboard.press('Enter'); await wait(100);
  await gutterMenu(page, await blockByText(page, 'Omega.'), '刪除');
  await wait(2500); await settleR86(page); await wait(2600); await settleR86(page);
  await page.unroute('**/api/render');
  assert.deepStrictEqual({ notice: await noticeText(page), disk: await saveAndRead(page, boot) },
    { notice: '文件已更新，請重試這個操作', disk: FF_SPLIT + '\nOmega.\n' }, 'refused, nothing deleted');
  await gutterMenu(page, await blockByText(page, 'Omega.'), '刪除'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), FF_SPLIT, 'the next 刪除 deletes the block it was opened on');
}, { md: FF_GUTTER_MD });
check('gutter-settle: ⠿ MD 原始碼 picked while a split above renders is refused with the notice and opens no box; the next one edits the block (R94, L208b)', DESKTOP, async (page, boot) => {
  await delayRender(page, 2500);
  await focusSurface(page, 'Alpha para one.', 5); await page.keyboard.press('Enter'); await wait(100);
  await gutterMenu(page, await blockByText(page, 'Omega.'), 'MD 原始碼');
  await wait(2500); await settleR86(page); await wait(2600); await settleR86(page);
  await page.unroute('**/api/render');
  const rawValue = () => page.evaluate(() => { const t = document.querySelector('textarea.ed-raw'); return t ? t.value : null; });
  assert.deepStrictEqual({ box: await rawValue(), notice: await noticeText(page), disk: await saveAndRead(page, boot) },
    { box: null, notice: '文件已更新，請重試這個操作', disk: FF_SPLIT + '\nOmega.\n' }, 'refused, no box, nothing written');
  await gutterMenu(page, await blockByText(page, 'Omega.'), 'MD 原始碼');
  assert.strictEqual(await rawValue(), 'Omega.', 'the next MD 原始碼 holds the block it was opened on');
  await page.focus('textarea.ed-raw'); await page.keyboard.press('Control+End'); await page.keyboard.type('X');
  await page.keyboard.press('Control+Enter'); await renderIdle(page);
  assert.strictEqual(await saveAndRead(page, boot), FF_SPLIT + '\nOmega.X\n');
}, { md: FF_GUTTER_MD });

// R100 (final re-review, named risk (a)): a degraded block (blockquote,
// fenced code) clicked while a split above it renders. The click opened the
// raw box at once, seeded from the stale `blocks` against the new `lines`:
// the box held `Middle.` and its commit wrote over it (measured at a13af72,
// both engines; identical at ffbdd7c). Now the click waits for the render;
// the split's render replaces every block below it, so the click is refused
// with the notice, and the next click opens the block's own lines.
for (const [label, md, type, seed, typed, want] of [
  ['a quote', '# D\n\nAlpha para one.\n\nMiddle.\n\n> Omega.\n', 'blockquote', '> Omega.', '> NEW', '> NEW'],
  ['a code block', '# D\n\nAlpha para one.\n\nMiddle.\n\n\x60\x60\x60\ncode\n\x60\x60\x60\n', 'code', '\x60\x60\x60\ncode\n\x60\x60\x60', '\x60\x60\x60\nNEW\n\x60\x60\x60', '\x60\x60\x60\nNEW\n\x60\x60\x60']]) {
  check('raw-box: ' + label + ' clicked below a split that is still rendering is refused, and the next click edits its own lines (R100)', DESKTOP, async (page, boot) => {
    const clickBlock = async () => {
      const box = await page.locator('.ed-block[data-block-type="' + type + '"]').first().boundingBox();
      assert.ok(box, 'guard: the ' + type + ' block is on screen');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };
    const rawValue = () => page.evaluate(() => { const t = document.querySelector('textarea.ed-raw'); return t ? t.value : null; });
    await delayRender(page, 2500);
    await focusSurface(page, 'Alpha para one.', 5); await page.keyboard.press('Enter'); await wait(100);
    await clickBlock(); await wait(300);
    assert.strictEqual(await rawValue(), null, 'no box opens while the split renders');
    await wait(2500); await settleR86(page);
    assert.deepStrictEqual({ box: await rawValue(), notice: await noticeText(page) },
      { box: null, notice: '文件已更新，請重試這個操作' }, 'the click is refused once the render lands');
    await clickBlock(); await wait(300);
    assert.strictEqual(await rawValue(), seed, 'the next click opens the block\'s own lines');
    await page.focus('textarea.ed-raw'); await page.keyboard.press('Control+a'); await page.keyboard.type(typed);
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
for (const [label, md, type, seed, typed] of [
  ['a quote', '# D\n\nAlpha para one.\n\nMiddle.\n\n> Omega.\n', 'blockquote', '> Omega.', '> NEW'],
  ['a code block', '# D\n\nAlpha para one.\n\nMiddle.\n\n\x60\x60\x60\ncode\n\x60\x60\x60\n', 'code', '\x60\x60\x60\ncode\n\x60\x60\x60', '\x60\x60\x60\nNEW\n\x60\x60\x60']]) {
  check('raw-box: ' + label + ' clicked right after typing in a paragraph opens on the first click (R102, M-R2)', DESKTOP, async (page, boot) => {
    await focusSurface(page, 'Alpha para one.', 2); await page.keyboard.type('X');
    const box = await page.locator('.ed-block[data-block-type="' + type + '"]').first().boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await renderIdle(page); await wait(300);
    const raw = await page.evaluate(() => { const t = document.querySelector('textarea.ed-raw'); return t ? t.value : null; });
    assert.deepStrictEqual({ box: raw, notice: await noticeText(page) }, { box: seed, notice: null }, 'the box opened on the first click');
    await page.focus('textarea.ed-raw'); await page.keyboard.press('Control+a'); await page.keyboard.type(typed);
    await page.keyboard.press('Control+Enter'); await renderIdle(page);
    assert.strictEqual(await saveAndRead(page, boot), '# D\n\nAlXpha para one.\n\nMiddle.\n\n' + typed + '\n');
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
        const boot = await bootEditor(c.opts.md, c.opts.srv);
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
