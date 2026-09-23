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

    console.log('editor-arrow-nav.test.js OK');
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
