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
  const s = await page.evaluate(() => {
    const p = document.querySelector('.ed-wave-panel');
    const label = document.querySelector('.ed-wave-lane-label, .ed-wave-section-title');
    return { bg: getComputedStyle(p).backgroundColor, fg: getComputedStyle(label).color };
  });
  assert.notStrictEqual(s.bg, 'rgb(255, 255, 255)', 'panel is not white in dark');
  assert.ok(contrast(s.fg, s.bg) >= 4.5, 'wave label contrast ' + JSON.stringify(s));
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
