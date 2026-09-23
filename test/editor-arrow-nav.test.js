'use strict';
// Arrow-key navigation across blocks and table cells.
// Spec: docs/superpowers/specs/2026-09-23-editor-arrow-nav-design.md
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-arrow-'));
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
    console.log('arrow-nav: ' + label + ' — OK');
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

async function main() {
  browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  try {
    // ── Task 1: caretAtEdge guard ────────────────────────────────────────
    await scenario('caretAtEdge: mid-text / start / end / empty trailing <br> line',
      '# Doc\n\nalpha bravo\n', async (page) => {
        await focusText(page, 'alpha bravo', 5);
        assert.deepStrictEqual(await page.evaluate(() =>
          ['up', 'down', 'left', 'right'].map((d) => window.__edTestCaretAtEdge(d))),
          [true, true, false, false], 'one-line surface, mid-text: up/down edges only');
        await focusText(page, 'alpha bravo', 0);
        assert.strictEqual(await page.evaluate(() => window.__edTestCaretAtEdge('left')), true);
        await focusText(page, 'alpha bravo', 11);
        assert.strictEqual(await page.evaluate(() => window.__edTestCaretAtEdge('right')), true);
        // Review Focus 3: Shift+Enter at the end makes an empty trailing
        // line whose collapsed range has a zero rect.
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
        assert.deepStrictEqual(await page.evaluate(() =>
          [window.__edTestCaretAtEdge('up'), window.__edTestCaretAtEdge('down')]),
          [false, true], 'empty trailing line: last line, not first');
      });

    // ── Task 2: walking between typing surfaces ──────────────────────────
    const TWO = '# Doc\n\nabcdefghij klm\n\nabcdefghij xyz\n';

    await scenario('↓ on the last line lands in the next block at the same x', TWO,
      async (page) => {
        await focusText(page, 'abcdefghij klm', 5);
        await press(page, 'ArrowDown');
        const c = await caret(page);
        assert.strictEqual(c.text, 'abcdefghij xyz', 'landed in the next paragraph');
        assert.strictEqual(c.offset, 5, 'x-aligned: identical text, so identical offset');
      });

    await scenario('↑ on the first line lands in the previous block at the same x', TWO,
      async (page) => {
        await focusText(page, 'abcdefghij xyz', 7);
        await press(page, 'ArrowUp');
        assert.deepStrictEqual(await caret(page),
          { text: 'abcdefghij klm', offset: 7, selected: null });
      });

    await scenario('↑ from a paragraph lands on the heading above', TWO,
      async (page) => {
        await focusText(page, 'abcdefghij klm', 0);
        await press(page, 'ArrowUp');
        assert.strictEqual((await caret(page)).text, 'Doc');
      });

    await scenario('↓ walks list items one by one',
      '# Doc\n\nlead\n\n- one\n- two\n', async (page) => {
        await focusText(page, 'lead', 2);
        await press(page, 'ArrowDown');
        assert.strictEqual((await caret(page)).text, 'one');
        await press(page, 'ArrowDown');
        assert.strictEqual((await caret(page)).text, 'two');
      });

    // Review Focus 2: a soft-wrapped paragraph's first visual line is not
    // its last line, so ↓ there is the browser's own move.
    const LONG = 'word '.repeat(80).trim();
    await scenario('wrapped first line: ↓ stays in the same block (native)',
      '# Doc\n\n' + LONG + '\n\nnext\n', async (page) => {
        await focusText(page, LONG, 3);
        await press(page, 'ArrowDown');
        const c = await caret(page);
        assert.strictEqual(c.text, LONG, 'still in the wrapped paragraph');
        assert.ok(c.offset > 3, 'the caret moved down a visual line, got ' + c.offset);
      });

    await scenario('wrapped second line: ↑ stays in the same block (native)',
      '# Doc\n\n' + LONG + '\n', async (page) => {
        await focusText(page, LONG, 250);
        await press(page, 'ArrowUp');
        assert.strictEqual((await caret(page)).text, LONG);
      });

    await scenario('a non-collapsed selection on the last line never jumps', TWO,
      async (page) => {
        await focusText(page, 'abcdefghij klm', 2);
        await page.keyboard.down('Shift');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.up('Shift');
        await press(page, 'ArrowDown');
        assert.strictEqual((await caret(page)).text, 'abcdefghij klm');
      });

    await scenario('↓ in the last block is a no-op', TWO, async (page) => {
      await focusText(page, 'abcdefghij xyz', 3);
      await press(page, 'ArrowDown');
      assert.strictEqual((await caret(page)).text, 'abcdefghij xyz');
    });

    await scenario('dirty block: ↓ commits once, and one Ctrl+Z undoes it', TWO,
      async (page, mdPath) => {
        const original = fs.readFileSync(mdPath, 'utf8');
        await focusText(page, 'abcdefghij klm', 14);
        await page.keyboard.type('Q');
        await press(page, 'ArrowDown');
        assert.strictEqual((await caret(page)).text, 'abcdefghij xyz', 'landed below');
        assert.strictEqual(await saveAndRead(page, mdPath),
          '# Doc\n\nabcdefghij klmQ\n\nabcdefghij xyz\n', 'the edit was committed');
        await focusText(page, 'abcdefghij xyz', 0);
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyZ');
        await page.keyboard.up('Control');
        await settle(page);
        assert.strictEqual(await saveAndRead(page, mdPath), original,
          'a pristine burst cascades Ctrl+Z to the document stack: ONE op undoes the edit');
      });

    // Review Focus 3: Shift+Enter mid-text leaves the caret at an ELEMENT
    // offset just after the <br>, where a collapsed range has no rect at
    // all. MEASURED before the fix: the caret stayed put, because the
    // no-rect fallback saw ' klm' after it and answered "not the last line".
    await scenario('Shift+Enter mid-text: ↓ from the new last line lands below', TWO,
      async (page) => {
        await focusText(page, 'abcdefghij klm', 10);
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
        assert.strictEqual(await page.evaluate(() => window.__edTestCaretAtEdge('down')), true,
          'the caret is on the last visual line');
        await press(page, 'ArrowDown');
        assert.strictEqual((await caret(page)).text, 'abcdefghij xyz');
      });

    await scenario('empty trailing line: ↓ lands below', TWO, async (page) => {
      await focusText(page, 'abcdefghij klm', 14);
      await page.keyboard.down('Shift');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Shift');
      await press(page, 'ArrowDown');
      assert.strictEqual((await caret(page)).text, 'abcdefghij xyz');
    });

    // Review Focus 4: caretPositionFromPoint() hit-tests, so a destination
    // below the fold — or under the fixed .ed-toolbar — must be scrolled into
    // reach before the x is resolved, or the landing falls back to the line
    // start. Offset 4 (not 0) is what proves the x was honoured.
    const TALL = '# Doc\n\n' + Array.from({ length: 30 }, (_, i) => 'filler ' + i).join('\n\n') +
      '\n\nabcdefghij klm\n\nabcdefghij xyz\n\n' +
      Array.from({ length: 30 }, (_, i) => 'tail ' + i).join('\n\n') + '\n';
    await scenario('destination below the fold: ↓ still lands at the same x', TALL,
      async (page) => {
        await focusText(page, 'abcdefghij klm', 4);
        await page.evaluate(() => {
          const s = document.activeElement.getBoundingClientRect();
          window.scrollBy(0, s.bottom - window.innerHeight + 2);
        });
        assert.ok(await page.evaluate(() => {
          const d = [...document.querySelectorAll('.ed-wys-armed')]
            .find((el) => el.textContent === 'abcdefghij xyz');
          return d.getBoundingClientRect().top >= window.innerHeight;
        }), 'precondition: the destination starts below the viewport');
        await press(page, 'ArrowDown');
        assert.deepStrictEqual(await caret(page),
          { text: 'abcdefghij xyz', offset: 4, selected: null });
      });

    await scenario('destination under the fixed toolbar: ↑ still lands at the same x', TALL,
      async (page) => {
        await focusText(page, 'abcdefghij xyz', 4);
        await page.evaluate(() => {
          const bar = document.querySelector('.ed-toolbar').getBoundingClientRect();
          const s = document.activeElement.getBoundingClientRect();
          window.scrollBy(0, s.top - bar.bottom - 2);
        });
        assert.ok(await page.evaluate(() => {
          const bar = document.querySelector('.ed-toolbar').getBoundingClientRect();
          const d = [...document.querySelectorAll('.ed-wys-armed')]
            .find((el) => el.textContent === 'abcdefghij klm');
          return d.getBoundingClientRect().bottom <= bar.bottom;
        }), 'precondition: the destination is hidden under the toolbar');
        await press(page, 'ArrowUp');
        assert.deepStrictEqual(await caret(page),
          { text: 'abcdefghij klm', offset: 4, selected: null });
      });

    // Review Focus 5.
    await scenario('an IME-composing ↓ is not intercepted', TWO, async (page) => {
      await focusText(page, 'abcdefghij klm', 5);
      const prevented = await page.evaluate(() => {
        const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true,
          cancelable: true, isComposing: true });
        document.activeElement.dispatchEvent(ev);
        return ev.defaultPrevented;
      });
      await settle(page);
      assert.strictEqual(prevented, false);
      assert.strictEqual((await caret(page)).text, 'abcdefghij klm');
    });

    // ── Task 3: blocks with no typing surface ────────────────────────────
    const CODE = '# Doc\n\nabove\n\n```js\nx = 1\n```\n\nbelow\n';

    await scenario('↓ onto a fenced code block selects it', CODE, async (page) => {
      await focusText(page, 'above', 2);
      await press(page, 'ArrowDown');
      const c = await caret(page);
      assert.strictEqual(c.text, null, 'no typing surface holds focus');
      assert.deepStrictEqual(c.selected, [[5, 7]], 'the code block (lines 5-7) is selected');
    });

    await scenario('from a selected code block, ↓ / ↑ continue the walk', CODE,
      async (page) => {
        await focusText(page, 'above', 2);
        await press(page, 'ArrowDown');
        await press(page, 'ArrowDown');
        let c = await caret(page);
        assert.strictEqual(c.text, 'below');
        assert.strictEqual(c.selected, null, 'the selection is cleared on leaving');
        await press(page, 'ArrowUp');
        assert.deepStrictEqual((await caret(page)).selected, [[5, 7]]);
        await press(page, 'ArrowUp');
        c = await caret(page);
        assert.strictEqual(c.text, 'above');
        assert.strictEqual(c.offset, 2, 'x remembered across the selected block');
      });

    await scenario('Enter on a selected code block opens its MD 原始碼', CODE,
      async (page) => {
        await focusText(page, 'above', 2);
        await press(page, 'ArrowDown');
        await press(page, 'Enter');
        await page.waitForSelector('textarea.ed-raw', { timeout: 5000 });
        assert.strictEqual(await page.evaluate(() =>
          document.querySelector('textarea.ed-raw').value), '```js\nx = 1\n```');
      });

    await scenario('Delete on a selected hr removes it', '# Doc\n\nabove\n\n---\n\nbelow\n',
      async (page, mdPath) => {
        await focusText(page, 'above', 0);
        await press(page, 'ArrowDown');
        assert.deepStrictEqual((await caret(page)).selected, [[5, 5]]);
        await press(page, 'Delete');
        assert.strictEqual(await saveAndRead(page, mdPath), '# Doc\n\nabove\n\nbelow\n');
      });

    // ── Task 4: tables ───────────────────────────────────────────────────
    const TBL = '# Doc\n\nabove\n\n| Aa | Bb | Cc |\n|---|---|---|\n| a1 | b1 | c1 |\n| a2 | b2 | c2 |\n\nbelow\n';

    // The caret's x is MEASURED into column B, never assumed from a font:
    // the offset is the first one in the long paragraph whose caret rect
    // falls inside the Bb header cell's horizontal span.
    const RULER = 'x'.repeat(80);
    const TBL_ENTRY = '# Doc\n\n' + RULER + '\n\n| Aa | Bb | Cc |\n|---|---|---|\n| a1 | b1 | c1 |\n';
    await scenario('↓ into a table lands in the header cell under x', TBL_ENTRY,
      async (page) => {
        const offset = await page.evaluate((t) => {
          const th = [...document.querySelectorAll('.ed-wys-cell')].find((c) => c.textContent === 'Bb');
          const col = th.getBoundingClientRect();
          const p = [...document.querySelectorAll('.ed-wys-armed')].find((el) => el.textContent === t);
          const node = p.firstChild;
          for (let i = 0; i <= node.data.length; i++) {
            const r = document.createRange();
            r.setStart(node, i);
            r.setEnd(node, i);
            const x = r.getBoundingClientRect().left;
            if (x > col.left + 2 && x < col.right - 2) return i;
          }
          return -1;
        }, RULER);
        assert.ok(offset >= 0, 'precondition: some caret offset in the ruler sits over column B');
        await focusText(page, RULER, offset);
        await press(page, 'ArrowDown');
        assert.strictEqual((await caret(page)).text, 'Bb');
      });

    await scenario('↑/↓ inside a table keep the column; the edges leave the table', TBL,
      async (page) => {
        await focusText(page, 'b1', 1);
        await press(page, 'ArrowDown');
        assert.strictEqual((await caret(page)).text, 'b2');
        await press(page, 'ArrowDown');
        assert.strictEqual((await caret(page)).text, 'below', 'last row ↓ leaves the table');
        await focusText(page, 'b1', 1);
        await press(page, 'ArrowUp');
        assert.strictEqual((await caret(page)).text, 'Bb');
        await press(page, 'ArrowUp');
        assert.strictEqual((await caret(page)).text, 'above', 'header ↑ leaves the table');
      });

    await scenario('←/→ move between cells only at the text boundary', TBL,
      async (page) => {
        await focusText(page, 'b1', 1);
        await press(page, 'ArrowRight');
        assert.deepStrictEqual(await caret(page), { text: 'b1', offset: 2, selected: null },
          'mid-text → is native');
        await press(page, 'ArrowRight');
        assert.deepStrictEqual(await caret(page), { text: 'c1', offset: 0, selected: null },
          'at the end → the next cell, caret at its start');
        await press(page, 'ArrowLeft');
        assert.deepStrictEqual(await caret(page), { text: 'b1', offset: 2, selected: null },
          'at the start ← the previous cell, caret at its end');
      });

    await scenario('→ wraps to the next row; first/last cell stay put', TBL, async (page) => {
      await focusText(page, 'Cc', 2);
      await press(page, 'ArrowRight');
      assert.strictEqual((await caret(page)).text, 'a1', 'row-major: header C → a1');
      await focusText(page, 'Aa', 0);
      await press(page, 'ArrowLeft');
      assert.deepStrictEqual(await caret(page), { text: 'Aa', offset: 0, selected: null });
      await focusText(page, 'c2', 2);
      await press(page, 'ArrowRight');
      assert.deepStrictEqual(await caret(page), { text: 'c2', offset: 2, selected: null });
    });

    await scenario('moving between cells commits nothing and keeps the edit', TBL,
      async (page, mdPath) => {
        await focusText(page, 'b1', 2);
        await page.keyboard.type('Z');
        const rendersBefore = await page.evaluate(() => window.__edRenderCount);
        await press(page, 'ArrowDown');
        assert.strictEqual((await caret(page)).text, 'b2');
        assert.strictEqual(await page.evaluate(() => window.__edRenderCount), rendersBefore,
          'no /api/render: a cell move inside the table is not a commit');
        assert.ok((await saveAndRead(page, mdPath)).includes('| a1 | b1Z | c1 |'),
          'the typed Z survived the cell move');
      });

    console.log('editor-arrow-nav.test.js OK');
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
