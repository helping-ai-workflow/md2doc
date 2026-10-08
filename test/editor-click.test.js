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
  // Ruling R3: export reads the canvas's engine svg until Task 10. The
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
  // A refusal that changes nothing: Alt+→ while the edge gesture is not armed.
  await page.locator('.ed-wave-overlay .ed-wave-layer').focus();
  await page.keyboard.press('Alt+ArrowRight'); await wait(200);
  const r = await page.evaluate(() => ({
    banners: [...document.querySelectorAll('.ed-conflict')].map((b) => b.getAttribute('data-level') + ':' + b.querySelector('.ed-msg-text').textContent),
    status: document.querySelector('.ed-wave-overlay').getAttribute('data-wave-status'),
  }));
  assert.deepStrictEqual(r.banners, ['error:' + card], 'the error card is still the one on screen ' + JSON.stringify(r));
  assert.strictEqual(r.status, '先按「關聯線」武裝，Alt+←／→ 才有轉態點可以跳', 'the editor still records the notice');
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
check('wave shell: transition dots only while edge arming', DESKTOP, async (page) => {
  await openWave(page);
  const dots = () => page.evaluate(() => document.querySelectorAll('.ed-wave-overlay .ed-wave-dot').length);
  assert.strictEqual(await dots(), 0, 'no dots on open');
  await page.locator('[data-focus-key="ed-wave-edge-arm"]').click(); await wait(200);
  const n = await dots();
  assert.ok(n > 0, 'arming shows the dots: ' + n);
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
  // Wait for the caret to land in the new, empty item. Keys typed while
  // Enter's commit re-renders are lost — on a tight list too (measured), a
  // pre-existing race this check is not about.
  await page.waitForFunction(() => { const li = document.activeElement && document.activeElement.closest('.ed-block[data-block-type="li"]'); return !!li && li.textContent.trim() === ''; }, null, { timeout: 3000 });
  await page.keyboard.type('new'); await wait(200);
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
        const boot = await bootEditor(c.opts.md, c.opts.srv);
        const context = await browser.newContext(Object.assign({ viewport: c.viewport }, c.opts.ctx));
        const page = await context.newPage();
        const errs = [];
        page.on('pageerror', (e) => errs.push(String(e)));
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
