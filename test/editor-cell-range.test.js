'use strict';
// Table cell-range selection.
// Spec: docs/superpowers/specs/2026-09-24-editor-cell-range-design.md
//
// Every scenario asserts WHERE the caret landed (surface text + offset), not
// merely that focus moved: "focus moved somewhere" is what a wrong landing
// also satisfies.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const puppeteer = require('puppeteer');
const { createEditorServer } = require('../lib/editor/server.js');

const CLIENT_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'client.js'), 'utf8');

let browser;

// Same in-flight instrumentation as editor-client-runtime.test.js's
// newPage(): counts /api/render + /api/save so settle() can wait for the
// editor to be quiescent, and records landed saves for saveAndRead().
async function newPage() {
  const page = await browser.newPage();
  page.on('dialog', (d) => d.accept());
  await page.evaluateOnNewDocument(() => {
    window.__edInflight = 0;
    window.__edSaveSeq = 0;
    window.__edSaveLanded = [];
    window.__edRenderCount = 0;
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = String(typeof input === 'string' ? input : (input && input.url) || '');
      if (!/\/api\/(render|save)\b/.test(url)) return origFetch.call(this, input, init);
      const isSave = /\/api\/save\b/.test(url);
      if (!isSave) window.__edRenderCount++;
      const saveId = isSave ? ++window.__edSaveSeq : 0;
      window.__edInflight++;
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        window.__edInflight--;
        if (isSave) window.__edSaveLanded.push(saveId);
      };
      return origFetch.call(this, input, init).then(
        (res) => { res.clone().arrayBuffer().then(() => setTimeout(fin, 0), () => setTimeout(fin, 0)); return res; },
        (err) => { fin(); throw err; });
    };
  });
  return page;
}

async function settle(page) {
  await page.waitForFunction(() => !window.__edInflight, { timeout: 15000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function scenario(label, md, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-cellrange-'));
  const mdPath = path.join(dir, 'doc.md');
  fs.writeFileSync(mdPath, md, 'utf8');
  const srv = await createEditorServer({ files: [mdPath], clientJs: CLIENT_SRC });
  const page = await newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  try {
    await page.setViewport({ width: 1200, height: 800 });
    await page.goto(srv.urlFor(mdPath), { waitUntil: 'networkidle2' });
    await settle(page);
    await fn(page, mdPath);
    assert.deepStrictEqual(errs, [], label + ': no page errors');
    console.log('cell-range: ' + label + ' — OK');
  } finally {
    await page.close();
    srv.close();
  }
}

// Clicks the surface (.ed-wys-armed or .ed-wys-cell) whose textContent is
// exactly `text`, then puts a collapsed caret `offset` characters in. The
// click is what opens the burst (focusin); the caret is set afterwards.
async function focusText(page, text, offset) {
  const sel = await page.evaluate((t) => {
    const s = [...document.querySelectorAll('.ed-wys-armed, .ed-wys-cell')]
      .find((el) => el.textContent === t);
    if (!s) return null;
    s.setAttribute('data-arrow-probe', '1');
    return '[data-arrow-probe="1"]';
  }, text);
  assert.ok(sel, 'focusText: no surface with text ' + JSON.stringify(text));
  await page.click(sel);
  await settle(page);
  await page.evaluate((t, off) => {
    const s = document.querySelector('[data-arrow-probe="1"]');
    s.removeAttribute('data-arrow-probe');
    const walker = document.createTreeWalker(s, NodeFilter.SHOW_TEXT);
    let left = off;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (left <= n.data.length) { getSelection().setBaseAndExtent(n, left, n, left); return; }
      left -= n.data.length;
    }
    getSelection().setBaseAndExtent(s, s.childNodes.length, s, s.childNodes.length);
  }, text, offset);
}

// Where the caret is: the focused surface's text and the caret's character
// offset in it, plus the block-selection lines when a wrapper holds focus.
async function caret(page) {
  return page.evaluate(() => {
    const a = document.activeElement;
    const surface = a && a.closest && a.closest('.ed-wys-armed, .ed-wys-cell');
    const selLines = window.__edTestGetSelection ? window.__edTestGetSelection() : null;
    if (!surface) {
      return { text: null, offset: null, selected: selLines ? selLines.memberLines : null };
    }
    const s = getSelection();
    const r = document.createRange();
    r.setStart(surface, 0);
    r.setEnd(s.focusNode, s.focusOffset);
    return { text: surface.textContent, offset: r.toString().length,
      selected: selLines ? selLines.memberLines : null };
  });
}

async function press(page, key) {
  await page.keyboard.press(key);
  await settle(page);
}

async function saveAndRead(page, mdPath) {
  const before = await page.evaluate(() => window.__edSaveSeq);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyS');
  await page.keyboard.up('Control');
  await page.waitForFunction((n) => window.__edSaveLanded.some((id) => id > n),
    { timeout: 15000 }, before);
  await settle(page);
  return fs.readFileSync(mdPath, 'utf8');
}

const TBL = '# Doc\n\n| A | B | C |\n|---|---|---|\n| a1 | b1 | c1 |\n| a2 | b2 | c2 |\n\nafter\n';

// The cells currently painted as the range, by their text, row-major.
function rangeTexts(page) {
  return page.evaluate(() => [...document.querySelectorAll('.ed-cell-range')]
    .map((el) => el.textContent));
}

async function cellCenter(page, text) {
  const p = await page.evaluate((t) => {
    const c = [...document.querySelectorAll('.ed-wys-cell')].find((el) => el.textContent === t);
    if (!c) return null;
    c.scrollIntoView({ block: 'center' });
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, text);
  assert.ok(p, 'no cell with text ' + JSON.stringify(text));
  return p;
}

async function shiftClick(page, text) {
  const p = await cellCenter(page, text);
  await page.keyboard.down('Shift');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Shift');
  await settle(page);
}

// The saved file's table as trimmed cell text, separator row dropped.
function mdTable(md) {
  return md.split('\n').filter((l) => /^\|/.test(l) && !/^\|\s*:?-/.test(l))
    .map((l) => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim()));
}

async function drag(page, fromText, toText) {
  const a = await cellCenter(page, fromText);
  const b = await cellCenter(page, toText);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
  await settle(page);
}

async function main() {
  browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  try {
    // ── Task 2: state, paint, Shift+click, exits ─────────────────────────
    await scenario('Shift+click paints the rectangle', TBL, async (page) => {
      await focusText(page, 'b1', 0);
      await shiftClick(page, 'c2');
      assert.deepStrictEqual(await rangeTexts(page), ['b1', 'c1', 'b2', 'c2']);
      assert.strictEqual(await page.evaluate(() =>
        document.querySelector('.ed-block table').classList.contains('ed-cell-range-active')), true);
    });

    await scenario('Shift+click grows from the same anchor', TBL, async (page) => {
      await focusText(page, 'b1', 0);
      await shiftClick(page, 'c1');
      await shiftClick(page, 'a2');
      assert.deepStrictEqual(await rangeTexts(page), ['a1', 'b1', 'a2', 'b2']);
    });

    await scenario('Shift+click inside the active cell stays a text selection', TBL,
      async (page) => {
        await focusText(page, 'b1', 0);
        await shiftClick(page, 'b1');
        assert.deepStrictEqual(await rangeTexts(page), []);
      });

    await scenario('Escape, a plain arrow and a plain click each clear the range', TBL,
      async (page) => {
        for (const exit of ['Escape', 'ArrowLeft', 'click']) {
          await focusText(page, 'b1', 0);
          await shiftClick(page, 'c2');
          assert.strictEqual((await rangeTexts(page)).length, 4, exit + ': precondition');
          if (exit === 'click') {
            const p = await cellCenter(page, 'a1');
            await page.mouse.click(p.x, p.y);
            await settle(page);
          } else {
            await press(page, exit);
          }
          assert.deepStrictEqual(await rangeTexts(page), [], exit + ' clears the range');
          assert.strictEqual(await page.evaluate(() =>
            !!document.querySelector('.ed-cell-range-active')), false, exit + ': table class gone');
        }
      });

    // Review Focus 2. Ctrl+S resolves the burst while the range still stands
    // (every plain press would clear the range first and hide the hook), so
    // this is the row that proves resolveBurst() clears the paint.
    await scenario('the burst ends with an untouched range: no paint left, no change on disk',
      TBL, async (page, mdPath) => {
        const original = fs.readFileSync(mdPath, 'utf8');
        await focusText(page, 'b1', 0);
        await shiftClick(page, 'c2');
        assert.strictEqual((await rangeTexts(page)).length, 4, 'precondition: range stands');
        assert.strictEqual(await saveAndRead(page, mdPath), original);
        assert.deepStrictEqual(await rangeTexts(page), []);
        assert.strictEqual(await page.evaluate(() =>
          !!document.querySelector('.ed-cell-range-active')), false);
      });

    // ── Task 3: drag ─────────────────────────────────────────────────────
    await scenario('dragging from one cell to another paints the rectangle', TBL,
      async (page) => {
        await focusText(page, 'a1', 0);
        await drag(page, 'a1', 'b2');
        assert.deepStrictEqual(await rangeTexts(page), ['a1', 'b1', 'a2', 'b2']);
      });

    await scenario('a drag inside one cell stays a text selection', TBL, async (page) => {
      await focusText(page, 'b1', 0);
      const c = await cellCenter(page, 'b1');
      await page.mouse.move(c.x - 6, c.y);
      await page.mouse.down();
      await page.mouse.move(c.x + 6, c.y, { steps: 3 });
      await page.mouse.up();
      await settle(page);
      assert.deepStrictEqual(await rangeTexts(page), []);
    });

    // Review Focus 4: out of the table is still a block selection.
    await scenario('a drag out of the table still becomes a block selection', TBL,
      async (page) => {
        await focusText(page, 'a1', 0);
        const a = await cellCenter(page, 'b2');
        const out = await page.evaluate(() => {
          const s = [...document.querySelectorAll('.ed-wys-armed')].find((el) => el.textContent === 'after');
          const r = s.getBoundingClientRect();
          return { x: r.left + 5, y: r.top + r.height / 2 };
        });
        await page.mouse.move(a.x, a.y);
        await page.mouse.down();
        await page.mouse.move(out.x, out.y, { steps: 6 });
        await page.mouse.up();
        await settle(page);
        const sel = await page.evaluate(() => window.__edTestGetSelection());
        assert.ok(sel && sel.memberLines.length >= 2, 'block selection stands, got ' + JSON.stringify(sel));
        assert.deepStrictEqual(await rangeTexts(page), [], 'and no cell range is left painted');
      });

    console.log('editor-cell-range.test.js OK');
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
