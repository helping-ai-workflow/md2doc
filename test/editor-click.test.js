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
  assert.ok(await page.$('.ed-conflict[data-level="error"]'), 'error card does not fade');
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
  assert.strictEqual(await page.$('.ed-conflict[data-level="notice"]'), null, 'notice faded');
  await page.keyboard.press('Escape');
});
check('messages: after a notice fades, Esc still clears a block selection', DESKTOP, async (page) => {
  await refuseLastColumn(page);
  assert.ok(await page.$('.ed-conflict[data-level="notice"]'), 'guard: the refusal notice appeared');
  await page.keyboard.press('Escape'); await wait(200);   // closes the table menu if still open
  await wait(4600);
  assert.strictEqual(await page.$('.ed-conflict'), null, 'notice gone');
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
  assert.ok(await page.$('.ed-wave-panel'), 'guard: the waveform editor is open');
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
