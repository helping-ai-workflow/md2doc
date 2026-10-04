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
