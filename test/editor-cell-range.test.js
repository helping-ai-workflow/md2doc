'use strict';
// Table cell-range selection.
// Spec: docs/superpowers/specs/2026-09-24-editor-cell-range-design.md
//
// Scenarios assert the painted cells (rangeTexts) and the SAVED markdown
// (mdTable), not merely that a class was toggled: a range that paints but
// acts on the wrong cells is exactly what a paint-only check would pass.
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

// Dispatches a synthetic ClipboardEvent at the focused element and returns
// what the page's handlers left in its DataTransfer. `text`/`html` seed a
// paste; copy/cut start empty.
async function clipboardEvent(page, type, text, html) {
  const got = await page.evaluate((ty, t, h) => {
    const dt = new DataTransfer();
    if (t !== null) dt.setData('text/plain', t);
    if (h !== null) dt.setData('text/html', h);
    const ev = new ClipboardEvent(ty, { clipboardData: dt, bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(ev);
    return { plain: dt.getData('text/plain'), html: dt.getData('text/html'),
      prevented: ev.defaultPrevented };
  }, type, text === undefined ? null : text, html === undefined ? null : html);
  await settle(page);
  return got;
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

    // ── Task 4: Shift+Arrow ──────────────────────────────────────────────
    await scenario('Shift+→ at a cell end starts a range with the next cell', TBL,
      async (page) => {
        await focusText(page, 'b1', 2);
        await page.keyboard.down('Shift');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.up('Shift');
        await settle(page);
        assert.deepStrictEqual(await rangeTexts(page), ['b1', 'c1']);
      });

    await scenario('Shift+→ mid-text stays a text selection', TBL, async (page) => {
      await focusText(page, 'b1', 0);
      await page.keyboard.down('Shift');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.up('Shift');
      await settle(page);
      assert.deepStrictEqual(await rangeTexts(page), []);
    });

    await scenario('Shift+Arrow grows and shrinks the range, clamped to the table', TBL,
      async (page) => {
        await focusText(page, 'b1', 2);
        await page.keyboard.down('Shift');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.up('Shift');
        await settle(page);
        assert.deepStrictEqual(await rangeTexts(page), ['b1', 'c1', 'b2', 'c2']);
        await page.keyboard.down('Shift');
        await page.keyboard.press('ArrowDown');   // already the last row: clamped
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.up('Shift');
        await settle(page);
        assert.deepStrictEqual(await rangeTexts(page), ['b1', 'b2']);
      });

    // ── Task 5: Delete, typing, copy, cut ────────────────────────────────
    await scenario('Delete clears the range; one Ctrl+Z restores it and keeps the paint', TBL,
      async (page, mdPath) => {
        await focusText(page, 'b1', 0);
        await shiftClick(page, 'c2');
        await press(page, 'Delete');
        assert.deepStrictEqual(await rangeTexts(page), ['', '', '', ''], 'cleared, still painted');
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyZ');
        await page.keyboard.up('Control');
        await settle(page);
        assert.deepStrictEqual(await rangeTexts(page), ['b1', 'c1', 'b2', 'c2'],
          'Review Focus 1: undo swapped innerHTML, the range was re-painted');
        await press(page, 'Delete');
        assert.deepStrictEqual(mdTable(await saveAndRead(page, mdPath)),
          [['A', 'B', 'C'], ['a1', '', ''], ['a2', '', '']]);
      });

    await scenario('typing clears the range and lands in the focus cell', TBL,
      async (page, mdPath) => {
        await focusText(page, 'b1', 0);
        await shiftClick(page, 'c2');
        await page.keyboard.type('Z');
        await settle(page);
        assert.deepStrictEqual(await rangeTexts(page), [], 'the range is gone');
        assert.deepStrictEqual(mdTable(await saveAndRead(page, mdPath)),
          [['A', 'B', 'C'], ['a1', '', ''], ['a2', '', 'Z']]);
      });

    await scenario('copy writes TSV and an HTML table of the range', TBL, async (page) => {
      await focusText(page, 'b1', 0);
      await shiftClick(page, 'c2');
      const got = await clipboardEvent(page, 'copy');
      assert.strictEqual(got.prevented, true);
      assert.strictEqual(got.plain, 'b1\tc1\nb2\tc2');
      assert.ok(/<table>[\s\S]*<td>b1<\/td><td>c1<\/td>[\s\S]*<td>b2<\/td><td>c2<\/td>/.test(got.html),
        'html: ' + got.html);
    });

    await scenario('cut copies, then clears the range', TBL, async (page, mdPath) => {
      await focusText(page, 'a1', 0);
      await shiftClick(page, 'a2');
      const got = await clipboardEvent(page, 'cut');
      assert.strictEqual(got.plain, 'a1\na2');
      assert.deepStrictEqual(mdTable(await saveAndRead(page, mdPath)),
        [['A', 'B', 'C'], ['', 'b1', 'c1'], ['', 'b2', 'c2']]);
    });

    // ── Task 6: grid paste ───────────────────────────────────────────────
    await scenario('TSV paste fills from the caret cell and selects the pasted block', TBL,
      async (page, mdPath) => {
        await focusText(page, 'b1', 0);
        await clipboardEvent(page, 'paste', 'x\ty\nz\tw');
        assert.deepStrictEqual(await rangeTexts(page), ['x', 'y', 'z', 'w']);
        assert.deepStrictEqual(mdTable(await saveAndRead(page, mdPath)),
          [['A', 'B', 'C'], ['a1', 'x', 'y'], ['a2', 'z', 'w']]);
      });

    await scenario('a paste larger than the table grows it (one undo)', TBL,
      async (page, mdPath) => {
        await focusText(page, 'c2', 0);
        await clipboardEvent(page, 'paste', 'p\tq\nr\ts\n');
        assert.deepStrictEqual(mdTable(await saveAndRead(page, mdPath)),
          [['A', 'B', 'C', ''], ['a1', 'b1', 'c1', ''], ['a2', 'b2', 'p', 'q'], ['', '', 'r', 's']]);
        await focusText(page, 'p', 0);
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyZ');
        await page.keyboard.up('Control');
        await settle(page);
        assert.deepStrictEqual(mdTable(await saveAndRead(page, mdPath)),
          [['A', 'B', 'C'], ['a1', 'b1', 'c1'], ['a2', 'b2', 'c2']]);
      });

    await scenario('an HTML <table> paste uses its cells', TBL, async (page, mdPath) => {
      await focusText(page, 'a1', 0);
      await clipboardEvent(page, 'paste', 'ignored',
        '<table><tr><td>h1</td><td><b>h2</b></td></tr></table>');
      assert.deepStrictEqual(mdTable(await saveAndRead(page, mdPath))[1], ['h1', 'h2', 'c1']);
    });

    await scenario('multi-line text without a TAB keeps the single-cell paste', TBL,
      async (page, mdPath) => {
        await focusText(page, 'a1', 2);
        await clipboardEvent(page, 'paste', 'L1\nL2');
        assert.deepStrictEqual(await rangeTexts(page), []);
        const row = mdTable(await saveAndRead(page, mdPath))[1];
        assert.ok(/^a1L1.*L2$/.test(row[0]), 'one cell, got ' + JSON.stringify(row));
      });

    // Review Focus 3. The renderer emits an EMPTY <tbody> for a header-only
    // table (measured), so growth appends into it; this pins that shape.
    await scenario('grid paste into a header-only table creates its body rows',
      '# Doc\n\n| A | B |\n|---|---|\n\nafter\n', async (page, mdPath) => {
        await focusText(page, 'A', 0);
        await clipboardEvent(page, 'paste', 'x\ty\n1\t2');
        assert.deepStrictEqual(mdTable(await saveAndRead(page, mdPath)), [['x', 'y'], ['1', '2']]);
      });

    await scenario('a paste over the size bound is refused with a banner', TBL,
      async (page, mdPath) => {
        const original = fs.readFileSync(mdPath, 'utf8');
        await focusText(page, 'a1', 0);
        await clipboardEvent(page, 'paste', Array.from({ length: 501 }, () => 'a\tb').join('\n'));
        assert.strictEqual(await page.evaluate(() => {
          const b = document.querySelector('.ed-conflict');
          return b ? b.textContent.indexOf('貼上的表格太大') !== -1 : false;
        }), true);
        assert.strictEqual(await saveAndRead(page, mdPath), original);
      });

    // ── Task 7: formatting ───────────────────────────────────────────────
    // Review Focus 5: the toolbar press must not clear the range first.
    await scenario('toolbar B bolds every cell, a second press unbolds them', TBL,
      async (page, mdPath) => {
        await focusText(page, 'b1', 0);
        await shiftClick(page, 'c2');
        await page.waitForSelector('.ed-seltb-b', { timeout: 3000 });
        await page.click('.ed-seltb-b');
        await settle(page);
        assert.deepStrictEqual(await rangeTexts(page), ['b1', 'c1', 'b2', 'c2'], 'range kept');
        assert.deepStrictEqual(mdTable(await saveAndRead(page, mdPath)).slice(1),
          [['a1', '**b1**', '**c1**'], ['a2', '**b2**', '**c2**']]);
        await focusText(page, 'b1', 0);
        await shiftClick(page, 'c2');
        await page.waitForSelector('.ed-seltb-b', { timeout: 3000 });
        await page.click('.ed-seltb-b');
        await settle(page);
        assert.deepStrictEqual(mdTable(await saveAndRead(page, mdPath)).slice(1),
          [['a1', 'b1', 'c1'], ['a2', 'b2', 'c2']]);
      });

    await scenario('Ctrl+B with a range bolds every non-empty cell', TBL,
      async (page, mdPath) => {
        await focusText(page, 'a1', 0);
        await shiftClick(page, 'b1');
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyB');
        await page.keyboard.up('Control');
        await settle(page);
        assert.deepStrictEqual(mdTable(await saveAndRead(page, mdPath))[1], ['**a1**', '**b1**', 'c1']);
      });

    // ── Final review ─────────────────────────────────────────────────────
    // I1: Tab moves the caret to another cell; a range left standing would
    // make the next keystroke clear the RANGE and land in its focus cell.
    await scenario('Tab with a range clears it; typing lands in the Tab target only', TBL,
      async (page, mdPath) => {
        await focusText(page, 'b1', 0);
        await shiftClick(page, 'b2');
        await press(page, 'Tab');
        assert.deepStrictEqual(await rangeTexts(page), [], 'Tab cleared the range');
        await page.keyboard.type('x');
        await settle(page);
        assert.deepStrictEqual(mdTable(await saveAndRead(page, mdPath)),
          [['A', 'B', 'C'], ['a1', 'b1', 'c1'], ['a2', 'b2', 'x']]);
      });

    // Edge-menu structural op: the range's indices would point at shifted
    // cells, and the next Delete would clear cells nobody selected.
    await scenario('an edge-menu row delete clears a standing range', TBL, async (page) => {
      await focusText(page, 'b1', 2);
      const g = await page.evaluate(() => {
        const t = document.querySelector('.ed-block table');
        const r = t.tBodies[0].rows[0].cells[0].getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.move(g.x, g.y);
      await page.waitForSelector('.ed-te-grip-row:not([hidden])', { timeout: 3000 });
      const grip = await page.evaluate(() => {
        const r = document.querySelector('.ed-te-grip-row').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.move(grip.x, grip.y);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForSelector('.ed-te-menu:not([hidden])', { timeout: 3000 });
      await page.keyboard.down('Shift');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.up('Shift');
      await settle(page);
      assert.deepStrictEqual(await rangeTexts(page), ['b1', 'b2'], 'precondition: range + menu');
      await page.click('.ed-te-menu-delete');
      await settle(page);
      assert.deepStrictEqual(await rangeTexts(page), [], 'the structural op cleared the range');
    });

    // I2: a mark over a cell with trailing whitespace must not close after
    // the space (`**a1 **` renders literal asterisks).
    await scenario('bolding a range trims each cell to its text', TBL, async (page, mdPath) => {
      await focusText(page, 'a1', 2);
      await page.keyboard.type(' ');
      await shiftClick(page, 'b1');
      await page.waitForSelector('.ed-seltb-b', { timeout: 3000 });
      await page.click('.ed-seltb-b');
      await settle(page);
      const row = mdTable(await saveAndRead(page, mdPath))[1];
      assert.ok(/^\*\*a1\*\*/.test(row[0]) && !/[\s ]\*\*/.test(row[0]),
        'a1 bold closes at the text, got ' + JSON.stringify(row[0]));
      assert.strictEqual(row[1], '**b1**');
    });

    // I3: Excel puts TSV AND formatted HTML on the clipboard; the TSV wins.
    await scenario('a TSV-bearing paste ignores the formatted HTML beside it', TBL,
      async (page, mdPath) => {
        await focusText(page, 'a1', 0);
        await clipboardEvent(page, 'paste', 'x\ty',
          '<table>\r\n <tr>\r\n  <td>x</td>\r\n  <td>long\r\n  junk</td>\r\n </tr>\r\n</table>');
        assert.deepStrictEqual(mdTable(await saveAndRead(page, mdPath))[1], ['x', 'y', 'c1']);
      });

    await scenario('an HTML-only table paste collapses whitespace and expands colspan', TBL,
      async (page, mdPath) => {
        await focusText(page, 'a1', 0);
        await clipboardEvent(page, 'paste', 'wide c',
          '<table><tr><td colspan="2">\n   wide\n  </td><td>c<br>d</td></tr></table>');
        const row = mdTable(await saveAndRead(page, mdPath))[1];
        assert.strictEqual(row[0], 'wide');
        assert.strictEqual(row[1], '');
        assert.ok(/^c(<br>|\\?\s*)d$|^c<br\s*\/?>d$/.test(row[2]) || row[2].replace(/<br\s*\/?>/, '|') === 'c|d',
          'the <br> survives as a line break, got ' + JSON.stringify(row[2]));
      });

    // A grid paste that cannot land must fall back to the single-cell paste,
    // never swallow the clipboard.
    await scenario('a grid paste with no open burst falls back to the single-cell paste', TBL,
      async (page) => {
        await focusText(page, 'a1', 2);
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyS');
        await page.keyboard.up('Control');
        await settle(page);
        await clipboardEvent(page, 'paste', 'x\ty');
        assert.ok(await page.evaluate(() => [...document.querySelectorAll('.ed-wys-cell')]
          .some((c) => c.textContent.indexOf('x') !== -1)), 'the pasted text landed somewhere');
      });

    // Spec: every mutating range operation is ONE undo op.
    for (const op of ['typing', 'cut', 'bold', 'paste']) {
      await scenario('one Ctrl+Z undoes a range ' + op, TBL, async (page, mdPath) => {
        const original = mdTable(fs.readFileSync(mdPath, 'utf8'));
        // Read the DOM, not the file: a save would commit the burst, and a
        // Ctrl+Z after that is the document-level undo (always one op),
        // which is not the granularity under test. innerHTML, not text, so a
        // format-only change counts.
        const domTable = () => page.evaluate(() => [...document.querySelectorAll('.ed-block table tr')]
          .map((tr) => [...tr.cells].map((td) => td.innerHTML)));
        const pristine = await domTable();
        await focusText(page, 'b1', 0);
        await shiftClick(page, 'c2');
        if (op === 'typing') await page.keyboard.type('Z');
        if (op === 'cut') await clipboardEvent(page, 'cut');
        if (op === 'bold') {
          await page.waitForSelector('.ed-seltb-b', { timeout: 3000 });
          await page.click('.ed-seltb-b');
        }
        if (op === 'paste') await clipboardEvent(page, 'paste', 'p\tq\nr\ts');
        await settle(page);
        assert.notDeepStrictEqual(await domTable(), pristine, 'precondition: the op changed the table');
        await focusText(page, 'a1', 0);
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyZ');
        await page.keyboard.up('Control');
        await settle(page);
        assert.deepStrictEqual(mdTable(await saveAndRead(page, mdPath)), original,
          'one Ctrl+Z restores after a range ' + op);
      });
    }

    console.log('editor-cell-range.test.js OK');
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
