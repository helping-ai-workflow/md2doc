#!/usr/bin/env node
'use strict';

// Regression coverage for the 4 review findings against lib/editor/client.js
// that pure-function / source-presence assertions (test/editor-client.test.js)
// cannot reach — these are real DOM/network runtime behaviors, so this file
// drives an actual editor server + headless page with Puppeteer (already a
// project dependency; same pattern as test/editor-server.test.js +
// test/scroll-anchor.test.js).
//
// Finding 1: cancel (Esc/✕) or a no-change Ctrl+Enter commit must not leave
//   the block unable to open its editor again (dead click-bar wiring).
// Finding 2: a failed /api/render must not wipe .content, and must surface
//   a dismissible banner instead. A failed COMMIT (whether manually
//   triggered via Ctrl+Enter or auto-triggered by switchAwayFrom()) now
//   leaves the editor OPEN with the user's text intact — see the Phase-2
//   Task-1 click-to-switch scenarios below for why: state consistency over
//   convenience means a switch is refused rather than silently discarding
//   either block's content.
// Finding 3: a save() failure outside 200/409 must surface a dismissible
//   banner and must NOT clear the dirty dot (no silent data-loss illusion).
//
// Phase-2 Task 1 (click-to-switch substrate, replaces the old Finding-4
// "refuse second open" policy and its undo/redo lockout regression):
// clicking a different block's editor open, or clicking outside any block,
// or invoking undo/redo, while some block's raw editor is open with
// modifications now auto-COMMITS that editor (or silently cancels it if
// unmodified) via switchAwayFrom(), instead of refusing outright. See the
// switch-commits / switch-cancels / undo-with-modified-open-editor /
// switch-commit-failure scenarios below.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const puppeteer = require('puppeteer');
const { createEditorServer } = require('../lib/editor/server.js');

const REPO = path.resolve(__dirname, '..');
const CLIENT_SRC = fs.readFileSync(path.join(REPO, 'lib', 'editor', 'client.js'), 'utf8');

// 1x1 transparent PNG (same fixture image as test/images.test.js) — used by
// the click-bar tests below to exercise the "lightbox targets stay excluded
// from the edit bar" rule. Appended as a NEW, trailing paragraph block so it
// never shifts the block indices the other scenarios below rely on.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-editor-rt-'));
  const mdPath = path.join(dir, 'doc.md');
  fs.writeFileSync(path.join(dir, 'block.png'), Buffer.from(PNG_B64, 'base64'));
  const original = [
    '# Heading', '', 'First paragraph.', '', 'Second paragraph.', '', 'Third paragraph.', '',
    // Kept BEFORE the trailing image block so `blockIds[blockIds.length - 1]`
    // (relied on by the click-bar scenario below) still resolves to the
    // image paragraph. Inserting more paragraphs HERE (after this one, still
    // before the image) is safe for both index-based conventions used
    // throughout this file: `ids[0..3]` above stay First/Second/Third/Bold,
    // and the image paragraph stays LAST regardless of how many more
    // paragraphs are added in between.
    'Bold paragraph with **bold** text.', '',
    // Task 4 (selection toolbar) fixtures — each dedicated to one scenario
    // below so none of those scenarios depend on state left by another.
    'Bold toggle target word here.', '',
    'Bold commit target word here.', '',
    'Backtick target has a \\` mark inside.', '',
    'Link target paragraph text.', '',
    'A [existing link](https://example.com) here.', '',
    'Rerender reset target word here.', '',
    // FIX 2 (strikethrough/underline selection-toolbar marks) fixtures.
    'Strike toggle target word here.', '',
    'Strike commit target word here.', '',
    'Underline commit target word here.', '',
    // Phase 3 Task 2 (burst undo) fixtures — dedicated paragraphs so the
    // burst-undo scenarios below never depend on state left by another.
    'Burst undo target text here.', '',
    'Burst bold undo target word here.', '',
    'Blur commit target text here.', '',
    'Burst failure target text here.', '',
    '![blur degrade fixture](block.png)', '',
    '![a figure](block.png)', '',
  ].join('\n');
  fs.writeFileSync(mdPath, original, 'utf8');
  const srv = await createEditorServer({ files: [mdPath], clientJs: CLIENT_SRC });
  return { dir, mdPath, srv, url: srv.urlFor(mdPath) };
}

async function newPage(browser) {
  const page = await browser.newPage();
  // beforeunload fires legitimately once a block is dirty; auto-accept so
  // navigations/tests don't hang on a dialog Puppeteer won't dismiss itself.
  page.on('dialog', (d) => d.accept());
  return page;
}

// Opens a block's RAW editor. Phase 3 Task 2 (always-on editing retires the
// Phase-2 click-select-then-✎ bar for paragraph/heading blocks): a
// WYSIWYG-eligible block is already contenteditable the moment it renders,
// so this now clicks the block (focus starts a burst) and, if it landed in
// WYSIWYG mode, forces the switch to raw-edit via the ⠿ handle's "MD 原始碼"
// menu item — the direct migration of the old bar's MD escape hatch. A
// DEGRADED block (canWysiwyg false) opens the raw textarea immediately on
// click, with no extra step. The many pre-existing scenarios below
// (Finding 1-3, switch-*, single-flight, …) are specifically exercising
// RAW-TEXTAREA mechanics (Ctrl+Enter, textarea.value, network failure
// banners) and don't care which route got them there.
async function openBlockEditor(page, sel) {
  await page.click(sel);
  // page.click() only waits for the click EVENT to be dispatched, not for
  // client.js's own async focus handling (which may itself be awaiting an
  // in-flight switchAwayFrom() resolving a DIFFERENT block first — see
  // startBurst()'s comment) to settle. Wait for that to actually land
  // (either this block is now the focused burst, or — a degraded block —
  // its raw textarea already opened) before touching the DOM further, or a
  // race can hand back a soon-to-be-detached node (a commit's rerenderAll()
  // swap landing mid-hover/click).
  await page.waitForFunction(
    (s) => !!document.querySelector(s + ' textarea.ed-raw') ||
      document.activeElement === document.querySelector(s + ' > *'),
    {}, sel
  );
  const hasRaw = await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), sel);
  if (!hasRaw) {
    await clickGutterMenuItem(page, sel, 'MD 原始碼');
    await page.waitForSelector(sel + ' textarea.ed-raw');
  }
}

// Hovers a block to reveal its ⠿ handle, opens its small menu, and clicks
// the menu item whose exact textContent is `label` ('−' / '+' /
// 'MD 原始碼' / '✕'). Mirrors the old clickBarButton() helper's role for
// the retired paragraph/heading bar buttons.
async function clickGutterMenuItem(page, sel, label) {
  await page.hover(sel);
  await page.click(sel + ' .ed-handle');
  await page.waitForFunction(
    (s) => document.querySelectorAll(s + ' .ed-handle-menu-btn').length > 0,
    {}, sel
  );
  await page.evaluate((s, l) => {
    const btn = Array.from(document.querySelectorAll(s + ' .ed-handle-menu-btn'))
      .find((b) => b.textContent === l && !b.hidden);
    if (!btn) throw new Error('gutter menu item not found: ' + l);
    btn.click();
  }, sel, label);
}

// Opens the WYSIWYG editor on a block — Phase 3 Task 2: paragraph/heading
// blocks are always-on contenteditable, so "opening" is just a click
// (native focus places the caret and starts a burst — see client.js's
// startBurst()). Kept as its own helper (rather than inlining page.click()
// at every call site) purely so the many pre-existing Task 3/4 scenarios
// below read the same way they did before the migration.
async function openWysiwyg(page, sel) {
  // Task 8 (per-li arch geometry): a li block's box ENCLOSES its nested
  // sublist, so page.click()'s center-of-box coordinate for a parent item
  // lands on a CHILD item's surface (or the gap between them) rather than on
  // the parent's own .ed-li-text — the burst then opens on the wrong li and
  // the wait below never settles. Click the surface itself for li blocks;
  // identical target for a li with no sublist, and every non-li caller keeps
  // clicking the block box exactly as before.
  // The li check is deliberately made against the SELECTOR STRING
  // (listBlockSel() / liBlockSelByText() both return 'li.ed-block[...]') rather
  // than by asking the page: an extra CDP round-trip here would shift EVERY
  // caller's click one round-trip later, which is enough to lose a
  // stale-handle race against a commit's .content swap in the scenarios that
  // click immediately after a commit.
  const isLi = sel.indexOf('li.ed-block') === 0;
  await page.click(isLi ? sel + ' > .ed-li-text' : sel);
  // Wait for the burst to actually have started (native focus landed AND
  // client.js's own async focusin handling settled — see openBlockEditor()'s
  // comment for why a plain contenteditable-true check alone isn't enough:
  // that's already true before the click for an always-on armed block).
  await page.waitForFunction(
    (s) => document.activeElement === document.querySelector(s + ' > *'),
    {}, sel
  );
}

// Task 8: re-opens a burst on `sel` when that surface may ALREADY hold native
// focus. A Ctrl+S resolves the open burst (client.js's resolveBurst()) and
// ends it, but deliberately does NOT blur — so page.click() on the same
// surface fires no focusin and no NEW burst starts, leaving the next keystroke
// unowned. Blur explicitly first, then open the normal way.
async function reopenWysiwyg(page, sel) {
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  await page.waitForFunction(() => document.activeElement === document.body, { timeout: 5000 });
  await openWysiwyg(page, sel);
}

// Task 8: waits until the node currently matching `sel` has actually been
// REPLACED by a commit's rerenderAll() .content swap. Capture the handle BEFORE
// the keystroke that commits, then await its detachment.
//
// Needed wherever a commit's only other observable signal is text that was
// ALREADY on screen before the commit (anything typed into a burst): a
// waitForFunction on that text returns immediately, so the steps that follow
// resolve their element handles against the still-live PRE-commit DOM and the
// swap then tears those nodes out mid-hover/click ("Node is detached from
// document"). Deterministic, unlike a fixed settle timeout: the captured node
// is guaranteed to be the pre-commit one.
async function nodeHandleFor(page, sel) {
  return page.evaluateHandle((s) => document.querySelector(s), sel);
}
async function awaitContentSwap(page, staleHandle) {
  await page.waitForFunction((old) => !!old && !old.isConnected, { timeout: 5000 }, staleHandle);
  await staleHandle.dispose();
}

// Task 4 (selection toolbar) helpers: select a specific word (or the whole
// contents) of an element via document.createRange()/getSelection(), then
// manually dispatch selectionchange — same pattern as the brief describes.
// A manual dispatch is used (rather than relying on the native async
// selectionchange Chrome fires after addRange()) so the toolbar's
// show/position logic runs synchronously, deterministically, before the next
// Puppeteer action.
async function selectWordInEl(page, elSelector, word) {
  await page.evaluate((sel, w) => {
    const el = document.querySelector(sel);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = null, idx = -1;
    let cur;
    while ((cur = walker.nextNode())) {
      idx = cur.textContent.indexOf(w);
      if (idx !== -1) { node = cur; break; }
    }
    if (!node) throw new Error('word not found: ' + w);
    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, idx + w.length);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }, elSelector, word);
}

async function selectAllInEl(page, elSelector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const range = document.createRange();
    range.selectNodeContents(el);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }, elSelector);
}

// Locates a paragraph block by a distinctive TEXT PREFIX rather than array
// position — the Task 4 fixture paragraphs below are looked up this way so
// none of these scenarios depend on the exact index position other
// scenarios in this file rely on (ids[0..3] etc.).
async function paragraphSelByText(page, prefix) {
  const id = await page.evaluate((p) => {
    const el = Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
      .find((b) => b.textContent.trim().startsWith(p));
    return el ? el.getAttribute('data-block-id') : null;
  }, prefix);
  assert.ok(id, 'fixture paragraph not found for prefix: ' + prefix);
  return '.ed-block[data-block-id="' + id + '"]';
}

// ── Phase-2 Task 5 (table cell WYSIWYG) helpers ──────────────────────────
// Table scenarios use their OWN isolated doc/server (via setupTableDoc()
// below) rather than the shared `original` fixture above: the shared doc's
// many scenarios locate paragraph blocks by fixed array index (ids[0..3])
// or by relying on the trailing image block staying LAST — inserting table
// fixtures anywhere in that doc risks disturbing one of those invariants.
// Isolation also means each table scenario's undo stack / save state can
// never leak into another.
async function setupTableDoc(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-editor-table-'));
  const mdPath = path.join(dir, 'doc.md');
  const original = rows.join('\n');
  fs.writeFileSync(mdPath, original, 'utf8');
  const srv = await createEditorServer({ files: [mdPath], clientJs: CLIENT_SRC });
  return { dir, mdPath, srv, url: srv.urlFor(mdPath), original };
}

// Locates a table block by its 0-based position among ALL table blocks in
// document order — mirrors paragraphSelByText()'s role for tables (fixture
// docs below deliberately have >1 table so the "second, untouched table
// stays byte-identical" requirement is actually exercised).
async function tableBlockSel(page, index) {
  const id = await page.evaluate((i) => {
    const els = document.querySelectorAll('.ed-block[data-block-type="table"]');
    return els[i] ? els[i].getAttribute('data-block-id') : null;
  }, index);
  assert.ok(id, 'table block not found at index ' + index);
  return '.ed-block[data-block-id="' + id + '"]';
}

// ── Phase-3 Task 4 (list WYSIWYG) helpers ────────────────────────────────
// Same isolation reasoning as setupTableDoc() above: list scenarios get
// their own doc/server so undo-stack / save state never leaks between them.
async function setupListDoc(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-editor-list-'));
  const mdPath = path.join(dir, 'doc.md');
  const original = rows.join('\n');
  fs.writeFileSync(mdPath, original, 'utf8');
  const srv = await createEditorServer({ files: [mdPath], clientJs: CLIENT_SRC });
  return { dir, mdPath, srv, url: srv.urlFor(mdPath), original };
}

// Locates a list run by its 0-based position among ALL list runs in document
// order and returns a CSS selector for the FIRST li of that run. Per-li arch
// (Task 3+): each <li> is its own .ed-block[data-block-type="li"]; runs are
// identified by grouping li blocks under the same outermost UL/OL root (whose
// parent is NOT a <li>). Mirrors tableBlockSel()'s role for lists (fixture
// docs below deliberately have >1 list so the "untouched sibling list stays
// byte-identical" requirement is actually exercised).
async function listBlockSel(page, index) {
  const id = await page.evaluate((i) => {
    const liEls = Array.prototype.slice.call(
      document.querySelectorAll('li.ed-block[data-block-type="li"]'));
    const seenRoots = [];
    liEls.forEach((li) => {
      let cur = li.parentElement;
      let root = null;
      while (cur) {
        if ((cur.nodeName === 'UL' || cur.nodeName === 'OL') &&
            (!cur.parentElement || cur.parentElement.nodeName !== 'LI')) {
          root = cur;
        }
        cur = cur.parentElement;
      }
      if (root && seenRoots.indexOf(root) === -1) seenRoots.push(root);
    });
    const targetRoot = seenRoots[i];
    if (!targetRoot) return null;
    const firstLi = targetRoot.querySelector('li.ed-block[data-block-type="li"]');
    return firstLi ? firstLi.getAttribute('data-block-id') : null;
  }, index);
  assert.ok(id, 'list block not found at index ' + index);
  return 'li.ed-block[data-block-id="' + id + '"]';
}

// Task 8: selector for the li.ed-block whose OWN text (its .ed-li-text
// surface, excluding any nested sublist) trims to exactly `text` — needed by
// the row-3/5/6 scenarios, which act on a NESTED item that listBlockSel()
// (first li of a run) cannot address.
async function liBlockSelByText(page, text) {
  const id = await page.evaluate((t) => {
    const lis = Array.prototype.slice.call(
      document.querySelectorAll('li.ed-block[data-block-type="li"]'));
    const hit = lis.find((li) => {
      const surface = li.querySelector(':scope > .ed-li-text');
      return surface && surface.textContent.trim() === t;
    });
    return hit ? hit.getAttribute('data-block-id') : null;
  }, text);
  assert.ok(id, 'li block with own text "' + text + '" not found');
  return 'li.ed-block[data-block-id="' + id + '"]';
}

// Task 8: the run's li lines in document order, read back from the SERVER-
// rendered DOM — `data-indent` and `data-block-id` are produced by
// blockmap.js from the committed markdown, so this is a faithful (and
// commit-proving) projection of what actually landed in `lines`.
async function runShapeOf(page, listSel) {
  return page.evaluate((sel) => {
    const liEl = document.querySelector(sel);
    let root = null;
    let cur = liEl && liEl.parentElement;
    while (cur) {
      if ((cur.nodeName === 'UL' || cur.nodeName === 'OL') &&
          (!cur.parentElement || cur.parentElement.nodeName !== 'LI')) {
        root = cur;
      }
      cur = cur.parentElement;
    }
    if (!root) return null;
    return Array.prototype.slice.call(root.querySelectorAll('li.ed-block')).map((li) => {
      const surface = li.querySelector(':scope > .ed-li-text');
      return li.getAttribute('data-indent') + ':' + (surface ? surface.textContent.trim() : '');
    }).join(' | ');
  }, listSel);
}

// Task 8: true iff the caret is COLLAPSED at the very start of `el` (no text
// between the surface's start and the caret) — row 1's "caret to new block
// start" assertion. Container-shape agnostic (the caret may sit on the
// surface element itself at offset 0, or inside its first text node).
async function caretIsAtStartOf(page, elSel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    const sel = window.getSelection();
    if (!el || !sel.rangeCount || !sel.isCollapsed) return false;
    const r = sel.getRangeAt(0);
    if (!el.contains(r.startContainer) && r.startContainer !== el) return false;
    const probe = document.createRange();
    probe.selectNodeContents(el);
    probe.setEnd(r.startContainer, r.startOffset);
    return probe.toString().length === 0;
  }, elSel);
}

// Places a COLLAPSED caret just before (`atStart: true`) or just after
// (`atStart: false`, default) the first occurrence of `text` found in any
// text node under the outermost UL/OL that `listSel`'s li belongs to —
// the list-editing equivalent of selectWordInEl(), used to drive
// Enter-split/Tab/Shift+Tab at a specific, deterministic position.
// Per-li arch: `listSel` points at a specific li.ed-block; the root for
// tree-walking is the outermost UL/OL ancestor (whose parent is NOT a <li>).
async function placeCaretInListText(page, listSel, text, atStart) {
  await page.evaluate((sel, t, start) => {
    const liEl = document.querySelector(sel);
    let root = null;
    let cur = liEl && liEl.parentElement;
    while (cur) {
      if ((cur.nodeName === 'UL' || cur.nodeName === 'OL') &&
          (!cur.parentElement || cur.parentElement.nodeName !== 'LI')) {
        root = cur;
      }
      cur = cur.parentElement;
    }
    if (!root) throw new Error('list run root not found for: ' + sel);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = null, idx = -1, wCur;
    while ((wCur = walker.nextNode())) {
      idx = wCur.textContent.indexOf(t);
      if (idx !== -1) { node = wCur; break; }
    }
    if (!node) throw new Error('list text not found: ' + t);
    const offset = start ? idx : idx + t.length;
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
  }, listSel, text, !!atStart);
}

// Selects the ENTIRE text node whose trimmed content is exactly `text` (a
// whole list item's own text, no nested sublist) and deletes it via a real
// Backspace keystroke — used by the empty-Enter scenario below to produce a
// genuinely-empty <li> through the same native-deletion path a real user
// would use, rather than mutating textContent directly.
// Per-li arch: tree-walks from the outermost UL/OL root (same as
// placeCaretInListText above) so nested items are reachable.
async function emptyListItemText(page, listSel, text) {
  const ownerSel = await page.evaluate((sel, t) => {
    const liEl = document.querySelector(sel);
    let root = null;
    let cur = liEl && liEl.parentElement;
    while (cur) {
      if ((cur.nodeName === 'UL' || cur.nodeName === 'OL') &&
          (!cur.parentElement || cur.parentElement.nodeName !== 'LI')) {
        root = cur;
      }
      cur = cur.parentElement;
    }
    if (!root) throw new Error('list run root not found for: ' + sel);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = null, wCur;
    while ((wCur = walker.nextNode())) {
      if (wCur.textContent.trim() === t) { node = wCur; break; }
    }
    if (!node) throw new Error('list item text not found: ' + t);
    // Task 8 (per-li arch): every <li> has its OWN contenteditable
    // .ed-li-text surface, so the native Backspace below is only delivered to
    // the editing host that actually owns `node` if that host has focus. The
    // caller may have opened the burst on a DIFFERENT li of the same run
    // (openWysiwyg() always focuses the run's FIRST li), in which case the
    // keystroke would land there and the selection would not be deleted at
    // all. Focus the owning surface first — which is also exactly where a
    // real user's caret would already be.
    let owner = node.parentNode;
    while (owner && !(owner.classList && owner.classList.contains('ed-li-text'))) {
      owner = owner.parentNode;
    }
    if (owner) owner.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    const ownerLi = owner && owner.closest && owner.closest('li.ed-block');
    return ownerLi
      ? 'li.ed-block[data-block-id="' + ownerLi.getAttribute('data-block-id') + '"] > .ed-li-text'
      : null;
  }, listSel, text);
  if (ownerSel) {
    await page.waitForFunction((s) => document.activeElement === document.querySelector(s), {}, ownerSel);
  }
  await page.keyboard.press('Backspace');
}

// Task 4 fix (review, Critical) helper: selects from the first occurrence of
// `fromText` (start of match) through the first-found-at-or-after occurrence
// of `toText` (end of match) — used to reproduce the reviewer's exact
// cross-item probe (a selection whose two boundary points land in two
// DIFFERENT <li> elements) deterministically, without relying on click
// coordinates.
// Per-li arch: tree-walks from the outermost UL/OL root (same as the other
// list helpers above).
async function selectAcrossListItems(page, listSel, fromText, toText) {
  await page.evaluate((sel, fromT, toT) => {
    const liEl = document.querySelector(sel);
    let root = null;
    let cur = liEl && liEl.parentElement;
    while (cur) {
      if ((cur.nodeName === 'UL' || cur.nodeName === 'OL') &&
          (!cur.parentElement || cur.parentElement.nodeName !== 'LI')) {
        root = cur;
      }
      cur = cur.parentElement;
    }
    if (!root) throw new Error('list run root not found for: ' + sel);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let fromNode = null, fromIdx = -1, toNode = null, toIdx = -1, wCur;
    while ((wCur = walker.nextNode())) {
      if (!fromNode) {
        const i = wCur.textContent.indexOf(fromT);
        if (i !== -1) { fromNode = wCur; fromIdx = i; }
      }
      if (fromNode && !toNode) {
        const searchFrom = (wCur === fromNode) ? fromIdx : 0;
        const j = wCur.textContent.indexOf(toT, searchFrom);
        if (j !== -1) { toNode = wCur; toIdx = j; }
      }
      if (fromNode && toNode) break;
    }
    if (!fromNode || !toNode) throw new Error('selectAcrossListItems: text not found');
    const range = document.createRange();
    range.setStart(fromNode, fromIdx);
    range.setEnd(toNode, toIdx + toT.length);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
  }, listSel, fromText, toText);
}

// Real (trusted-ish, coordinate-based) mouse click on whichever TH/TD in
// `tableSel` has EXACT trimmed text `text` — a genuine bubbling click event,
// same as an actual user click, unlike calling .click() on the DOM node
// directly (which drives the same production code path but skips real
// mouse/focus semantics entirely).
async function clickCellWithText(page, tableSel, text) {
  const box = await page.evaluate((ts, t) => {
    const table = document.querySelector(ts);
    const cells = table.querySelectorAll('th, td');
    for (const c of cells) {
      if (c.textContent.trim() === t) {
        const r = c.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
    return null;
  }, tableSel, text);
  assert.ok(box, 'cell not found with text: ' + text);
  await page.mouse.click(box.x, box.y);
}

// Task 5 (hover-edge insert bubbles) helpers: compute the pixel coordinates
// of a column or row insert boundary from the table's LIVE cell rects — the
// SAME geometry client.js's own updateTableInsertBubbles() computes, so
// hovering exactly there is guaranteed to land within its TB_EDGE_PX
// tolerance (both use the exact boundary coordinate, not an approximation).
// `tableSel` is a block selector (e.g. from tableBlockSel()); the actual
// <table> is a descendant of it.
async function colBoundaryCoords(page, tableSel, colIndex) {
  return page.evaluate((ts, ci) => {
    const table = document.querySelector(ts + ' table');
    const r = table.tHead.rows[0].cells[ci].getBoundingClientRect();
    return { x: r.right, y: table.getBoundingClientRect().top };
  }, tableSel, colIndex);
}
async function rowBoundaryCoords(page, tableSel, afterRowIndex) {
  return page.evaluate((ts, ari) => {
    const table = document.querySelector(ts + ' table');
    const y = ari < 0
      ? table.tHead.rows[0].getBoundingClientRect().bottom
      : table.tBodies[0].rows[ari].getBoundingClientRect().bottom;
    return { x: table.getBoundingClientRect().left, y };
  }, tableSel, afterRowIndex);
}
// Moves the REAL mouse to a boundary (driving client.js's own throttled
// mousemove listener, exactly like a real user hovering there), waits for
// the corresponding singleton bubble to become visible, then clicks it.
async function hoverAndClickColInsert(page, tableSel, colIndex) {
  const { x, y } = await colBoundaryCoords(page, tableSel, colIndex);
  await page.mouse.move(x, y);
  await page.waitForSelector('.ed-tb-insert-col:not([hidden])', { timeout: 3000 });
  await page.click('.ed-tb-insert-col');
}
async function hoverAndClickRowInsert(page, tableSel, afterRowIndex) {
  const { x, y } = await rowBoundaryCoords(page, tableSel, afterRowIndex);
  await page.mouse.move(x, y);
  await page.waitForSelector('.ed-tb-insert-row:not([hidden])', { timeout: 3000 });
  await page.click('.ed-tb-insert-row');
}

// ── Task 6 (edge-click menus + row drag-reorder) helpers ────────────────
// The invisible TE_EDGE_PX pixel-hunting zones the ORIGINAL Task 6 design
// used are retired — user-acceptance feedback found them unusably small
// with no visible affordance. Interaction now goes through two Notion-style
// grip handles (.ed-te-grip-row / .ed-te-grip-col): hovering a cell reveals
// the corresponding grip (client.js's own rAF-throttled mousemove listener,
// same one that drives the hover-insert bubbles), and the grip itself —
// not raw table-edge geometry — is the click/drag target below.
//
// hoverColumnCell()/hoverBodyRowCell() hover a real cell (driving that
// listener exactly like a real user) and wait for the matching grip to
// appear; gripCenter() reads back that grip's own on-screen center so a
// caller can press/drag AT it.
async function hoverColumnCell(page, tableSel, colIndex) {
  const box = await page.evaluate((ts, ci) => {
    const table = document.querySelector(ts + ' table');
    const r = table.tHead.rows[0].cells[ci].getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, tableSel, colIndex);
  await page.mouse.move(box.x, box.y);
  await page.waitForSelector('.ed-te-grip-col:not([hidden])', { timeout: 3000 });
}
async function hoverBodyRowCell(page, tableSel, bodyIndex) {
  const box = await page.evaluate((ts, bi) => {
    const table = document.querySelector(ts + ' table');
    const r = table.tBodies[0].rows[bi].cells[0].getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, tableSel, bodyIndex);
  await page.mouse.move(box.x, box.y);
  await page.waitForSelector('.ed-te-grip-row:not([hidden])', { timeout: 3000 });
}
// Hovers the HEADER row's first cell WITHOUT waiting for a row grip — used
// by the "header row shows no grip" scenario below, where none must appear.
async function hoverHeaderRowCell(page, tableSel) {
  const box = await page.evaluate((ts) => {
    const table = document.querySelector(ts + ' table');
    const r = table.tHead.rows[0].cells[0].getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, tableSel);
  await page.mouse.move(box.x, box.y);
}
async function gripCenter(page, gripSel) {
  return page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, gripSel);
}
// Reads back a live element's client rect as a plain {left, right, top,
// bottom} object — used by the grip/insert-bubble non-intersection scenario
// below to compare two overlay elements' hit boxes.
async function elementRect(page, sel) {
  return page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }, sel);
}
// Plain axis-aligned-rectangle intersection test (Node-side, no page
// involved) — two rects that merely TOUCH at an edge (e.g. `a.right ===
// b.left`) do NOT count as intersecting, matching the strict '<'/'>'
// comparisons a real overlapping-hit-area bug would need to trigger.
function rectsIntersect(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
// Pixel-approximate equality assertion (Node-side): passes if |actual −
// expected| <= 1, accounting for subpixel rounding in getBoundingClientRect.
// Used by grip-position scenarios to assert the new border-centred geometry
// without being brittle against fractional pixel differences across platforms.
function expectApprox(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= 1,
    (label ? label + ': ' : '') + 'expected ≈' + expected.toFixed(2) +
    ', got ' + actual.toFixed(2) + ' (diff=' + (actual - expected).toFixed(2) + ')');
}
// Convenience wrappers: hover the cell, then read back the grip's own
// center — the coordinates every menu-open/drag scenario below presses at.
async function colGripCoords(page, tableSel, colIndex) {
  await hoverColumnCell(page, tableSel, colIndex);
  return gripCenter(page, '.ed-te-grip-col');
}
async function rowGripCoords(page, tableSel, bodyIndex) {
  await hoverBodyRowCell(page, tableSel, bodyIndex);
  return gripCenter(page, '.ed-te-grip-row');
}
// A real press+release with NO intermediate movement AT the grip's own
// coordinates — same primitive a plain click on a grip drives (client.js's
// drag-threshold check never trips), reused by both the menu-open scenarios
// and (with actual movement injected between down/up) the drag scenarios
// below.
async function pressReleaseAt(page, x, y) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}
// Presses at `from` (the row grip's own coordinates), moves through a
// midpoint (so the drag crosses client.js's TE_DRAG_THRESHOLD_PX before
// landing), and releases at `to` (a drop-boundary coordinate from
// rowBoundaryCoords() above — unrelated to the grips, still plain table-row
// geometry).
async function dragRowTo(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + (to.x - from.x) / 2, from.y + (to.y - from.y) / 2, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
}

// Ctrl+S then re-read the file from disk — used by the Task 5/6 scenarios
// below to assert the committed source after a structure op, same
// keyboard-save mechanic the pre-existing table WYSIWYG scenarios use.
async function saveAndRead(page, mdPath) {
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyS');
  await page.keyboard.up('Control');
  await new Promise((r) => setTimeout(r, 300));
  return fs.readFileSync(mdPath, 'utf8');
}

// Dispatches one real mousemove and waits for client.js's rAF-throttled
// mousemove listener to actually PROCESS it before returning — a double
// requestAnimationFrame, same "settle window" idiom the header-row-shows-
// no-grip scenario above already uses. Necessary because Puppeteer's own
// `page.mouse.move(x, y, {steps: N})` fires all N synthetic events with no
// delay between them; client.js's listener only reads the LATEST
// tbMoveX/Y/Target once per animation frame (see its "coalesced to at most
// once per animation frame" comment), so a `{steps}` move would collapse an
// entire multi-point travel into a single recompute at the FINAL point —
// silently skipping over the exact mid-corridor point the grip-reachability
// bug lives at. Dispatching one move and settling one frame at a time is
// what actually exercises each intermediate point.
async function movePointerAndSettle(page, x, y) {
  await page.mouse.move(x, y);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

// Steps the pointer from `from` to `to` in `steps` increments, settling one
// animation frame at a time (movePointerAndSettle() above) — simulating a
// REAL pointer travelling from inside a table cell, across the
// TE_GRIP_GAP_PX corridor OUTSIDE the table, to a grip. Used by the
// grip-reachability regression scenario below; every other grip-targeting
// helper in this file (pressReleaseAt/dragRowTo/gripCenter) teleports
// straight to the target and never crosses this corridor at all.
async function travelPointer(page, from, to, steps) {
  for (let i = 1; i <= steps; i++) {
    const x = from.x + (to.x - from.x) * (i / steps);
    const y = from.y + (to.y - from.y) * (i / steps);
    await movePointerAndSettle(page, x, y);
  }
}

// ── §10-gap fix (block-level insert/delete) helpers ─────────────────────
// Own isolated doc/server per scenario group, same isolation reasoning as
// setupTableDoc()/setupListDoc() above.
async function setupBlockOpsDoc(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-editor-blockops-'));
  const mdPath = path.join(dir, 'doc.md');
  const original = rows.join('\n');
  fs.writeFileSync(mdPath, original, 'utf8');
  const srv = await createEditorServer({ files: [mdPath], clientJs: CLIENT_SRC });
  return { dir, mdPath, srv, url: srv.urlFor(mdPath), original };
}

// Hovers a block to reveal its ＋ button, opens its small insert menu, and
// clicks the menu item whose exact textContent is `label` (段落/標題/清單/
// 表格/程式碼). Mirrors clickGutterMenuItem()'s role for the ⠿ menu.
async function clickInsertMenuItem(page, sel, label) {
  await page.hover(sel);
  await page.click(sel + ' .ed-insert');
  await page.waitForFunction(
    (s) => document.querySelectorAll(s + ' .ed-insert-menu-btn').length > 0,
    {}, sel
  );
  await page.evaluate((s, l) => {
    const btn = Array.from(document.querySelectorAll(s + ' .ed-insert-menu-btn'))
      .find((b) => b.textContent === l);
    if (!btn) throw new Error('insert menu item not found: ' + l);
    btn.click();
  }, sel, label);
}

(async () => {
  const { srv, url, mdPath } = await setup();
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    // ── Finding 1: the block must stay click-to-edit-able after cancel AND
    //    no-op commit (the click-bar equivalent of "the gutter must not go
    //    dead") ────────────────────────────────────────────────────────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });
      const blockId = await page.evaluate(() =>
        document.querySelector('.ed-block[data-block-type="paragraph"]').getAttribute('data-block-id'));
      const sel = '.ed-block[data-block-id="' + blockId + '"]';

      // open -> Esc cancel -> block must still be LIVE (clickable, not just present)
      await openBlockEditor(page, sel);
      await page.waitForSelector(sel + ' textarea.ed-raw');
      await page.keyboard.press('Escape');
      await page.waitForFunction((s) => !document.querySelector(s + ' textarea.ed-raw'), {}, sel);
      assert.ok(
        await page.evaluate((s) => !document.querySelector(s + ' textarea.ed-raw') &&
          document.querySelector(s + ' > *').getAttribute('contenteditable') === 'true' &&
          !document.querySelector('.ed-handle-menu'), sel),
        'the block must be back to its normal always-on editable state (no textarea, no leftover ⠿ menu) after an Esc cancel'
      );
      await openBlockEditor(page, sel);
      await page.waitForSelector(sel + ' textarea.ed-raw', { timeout: 3000 });
      assert.ok(
        await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), sel),
        'FIX 1: the block must reopen its editor after an Esc cancel (was dead before the fix)'
      );
      await page.keyboard.press('Escape');
      await page.waitForFunction((s) => !document.querySelector(s + ' textarea.ed-raw'), {}, sel);

      // open -> no-change Ctrl+Enter (identical text) -> block must still be LIVE
      await openBlockEditor(page, sel);
      await page.waitForSelector(sel + ' textarea.ed-raw');
      await page.keyboard.down('Control');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Control');
      await page.waitForFunction((s) => !document.querySelector(s + ' textarea.ed-raw'), {}, sel);
      await openBlockEditor(page, sel);
      await page.waitForSelector(sel + ' textarea.ed-raw', { timeout: 3000 });
      assert.ok(
        await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), sel),
        'FIX 1: the block must reopen its editor after a no-change Ctrl+Enter commit (was dead before the fix)'
      );
      await page.keyboard.press('Escape');

      await page.close();
      console.log('fix 1: block edit-bar revives after cancel / no-op commit — OK');
    }

    // ── Finding 2: failed /api/render must not wipe .content ─────────────
    {
      const page = await newPage(browser);
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.method() === 'POST' && req.url().endsWith('/api/render')) {
          req.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
        } else {
          req.continue();
        }
      });
      await page.goto(url, { waitUntil: 'networkidle0' });

      const blockId = await page.evaluate(() =>
        document.querySelector('.ed-block[data-block-type="paragraph"]').getAttribute('data-block-id'));
      const sel = '.ed-block[data-block-id="' + blockId + '"]';

      await openBlockEditor(page, sel);
      await page.waitForSelector(sel + ' textarea.ed-raw');
      await page.evaluate((s) => {
        const ta = document.querySelector(s + ' textarea.ed-raw');
        ta.value = 'CHANGED-BUT-RENDER-WILL-FAIL';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }, sel);
      await page.keyboard.down('Control');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Control');

      await page.waitForSelector('.ed-conflict', { timeout: 5000 });
      const bannerText = await page.evaluate(() => document.querySelector('.ed-conflict').textContent);
      assert.ok(/render failed/i.test(bannerText),
        'FIX 2: banner must explain the render failure, got: ' + bannerText);

      const contentHtml = await page.evaluate(() => document.querySelector('.content').innerHTML);
      assert.ok(!contentHtml.includes('CHANGED-BUT-RENDER-WILL-FAIL'),
        'FIX 2: a failed render must NEVER apply the edit to the DOM (no "undefined" wipe either)');
      assert.ok(!contentHtml.includes('undefined'),
        'FIX 2: a failed render must not stringify `undefined` into innerHTML');
      // Phase-2 Task 1: a failed commit keeps the editor OPEN with the
      // user's text intact (state consistency over convenience) instead of
      // silently discarding it via restore().
      assert.strictEqual(
        await page.evaluate((s) => {
          const ta = document.querySelector(s + ' textarea.ed-raw');
          return ta ? ta.value : null;
        }, sel),
        'CHANGED-BUT-RENDER-WILL-FAIL',
        'FIX 2 (Phase-2): a failed commit must keep the editor open with the unsaved text, not discard it'
      );

      await page.click('.ed-conflict button[aria-label="Dismiss"]');
      assert.ok(
        await page.evaluate(() => !document.querySelector('.ed-conflict')),
        'FIX 2: the render-failure banner must be dismissible'
      );
      // Cleanup: cancel the still-open editor via its ✕ button (Esc is
      // wired on the textarea itself, and focus is currently on the
      // banner's Dismiss button, not the textarea).
      await page.click(sel + ' .ed-cancel');
      await page.waitForFunction((s) => !document.querySelector(s + ' textarea.ed-raw'), {}, sel);

      await page.close();
      console.log('fix 2: render failure leaves DOM untouched + dismissible banner — OK');
    }

    // ── Finding 3: save() failure outside 200/409 must not be silent ─────
    {
      const page = await newPage(browser);
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.method() === 'POST' && req.url().endsWith('/api/save')) {
          req.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'disk full' }) });
        } else {
          req.continue();
        }
      });
      await page.goto(url, { waitUntil: 'networkidle0' });

      const blockId = await page.evaluate(() =>
        document.querySelector('.ed-block[data-block-type="paragraph"]').getAttribute('data-block-id'));
      const sel = '.ed-block[data-block-id="' + blockId + '"]';

      await openBlockEditor(page, sel);
      await page.waitForSelector(sel + ' textarea.ed-raw');
      await page.evaluate((s) => {
        const ta = document.querySelector(s + ' textarea.ed-raw');
        ta.value = 'SAVE-TEST-EDIT';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }, sel);
      await page.keyboard.down('Control');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Control');
      await page.waitForFunction(
        () => document.querySelector('.content').innerHTML.includes('SAVE-TEST-EDIT'),
        { timeout: 5000 }
      );
      const dirtyBeforeSave = await page.title();
      assert.ok(dirtyBeforeSave.startsWith('●'), 'sanity: title is dirty after a successful commit');

      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');

      await page.waitForSelector('.ed-conflict', { timeout: 5000 });
      const bannerText = await page.evaluate(() => document.querySelector('.ed-conflict').textContent);
      assert.ok(/save failed/i.test(bannerText),
        'FIX 3: banner must explain the save failure, got: ' + bannerText);
      assert.ok(/not saved/i.test(bannerText),
        'FIX 3: banner must make clear changes were NOT saved, got: ' + bannerText);

      const titleAfterFailedSave = await page.title();
      assert.ok(titleAfterFailedSave.startsWith('●'),
        'FIX 3: dirty dot must remain set after a failed save (no false "saved" state)');

      await page.close();
      console.log('fix 3: save failure surfaces a banner and keeps dirty state — OK');
    }

    // ── switch-commits: A open with modifications, click B's block ────────
    // A's new text must be committed (visible in the rendered page), B's
    // editor must open, and a Ctrl+Z after closing B must revert A's
    // just-committed change (it is the newest op on the undo stack).
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      assert.ok(ids.length >= 2, 'fixture must have at least 2 paragraph blocks');
      const selA = '.ed-block[data-block-id="' + ids[0] + '"]';
      const selB = '.ed-block[data-block-id="' + ids[1] + '"]';

      await openBlockEditor(page, selA);
      await page.waitForSelector(selA + ' textarea.ed-raw');
      await page.evaluate((s) => {
        const ta = document.querySelector(s + ' textarea.ed-raw');
        ta.value = 'SWITCH-COMMIT-A-TEXT';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }, selA);

      // Click B's block while A is open with modifications: A must
      // auto-commit, then B's editor opens.
      await openBlockEditor(page, selB);
      await page.waitForSelector(selB + ' textarea.ed-raw', { timeout: 5000 });

      assert.ok(
        await page.evaluate(() => document.querySelector('.content').innerHTML.includes('SWITCH-COMMIT-A-TEXT')),
        'switch-commits: A\'s modified text must be committed (visible in rendered content) when switching to B'
      );
      assert.ok(
        await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), selB),
        'switch-commits: B\'s editor must open after the switch'
      );

      // Close B (unmodified) and undo: the newest op is A's just-committed
      // switch-triggered edit, so Ctrl+Z must revert THAT.
      await page.keyboard.press('Escape');
      await page.waitForFunction((s) => !document.querySelector(s + ' textarea.ed-raw'), {}, selB);
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyZ');
      await page.keyboard.up('Control');
      await page.waitForFunction(
        () => !document.querySelector('.content').innerHTML.includes('SWITCH-COMMIT-A-TEXT'),
        { timeout: 5000 }
      );
      assert.ok(
        await page.evaluate(() => document.querySelector('.content').innerHTML.includes('First paragraph.')),
        'switch-commits: Ctrl+Z after closing B must revert A\'s committed switch-triggered edit'
      );

      await page.close();
      console.log('switch-commits: A auto-commits on switch to B, undo reverts A\'s edit — OK');
    }

    // ── switch-cancels: A open UNMODIFIED, click B: A closes silently,
    //    B opens ─────────────────────────────────────────────────────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      const selA = '.ed-block[data-block-id="' + ids[0] + '"]';
      const selB = '.ed-block[data-block-id="' + ids[1] + '"]';

      await openBlockEditor(page, selA);
      await page.waitForSelector(selA + ' textarea.ed-raw');
      // A is left untouched — no modification.

      await openBlockEditor(page, selB);
      await page.waitForSelector(selB + ' textarea.ed-raw', { timeout: 5000 });

      assert.strictEqual(
        await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), selA),
        false,
        'switch-cancels: A\'s unmodified editor must close silently when switching to B'
      );
      assert.ok(
        await page.evaluate(() => document.querySelector('.content').innerHTML.includes('First paragraph.')),
        'switch-cancels: A\'s original content must be restored (no accidental commit)'
      );
      assert.ok(
        await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), selB),
        'switch-cancels: B\'s editor must open'
      );

      await page.keyboard.press('Escape');
      await page.close();
      console.log('switch-cancels: A closes silently (unmodified), B opens — OK');
    }

    // ── undo-with-modified-open-editor: A open with modifications, blur,
    //    Ctrl+Z ──────────────────────────────────────────────────────────
    // A must auto-commit first (the pre-check's switchAwayFrom call), then
    // the undo reverts A's just-committed edit — it is the newest op — and
    // there is no lockout: clicking C afterward must still open an editor.
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      assert.ok(ids.length >= 3, 'fixture must have at least 3 paragraph blocks for this repro');
      const selA = '.ed-block[data-block-id="' + ids[0] + '"]';
      const selC = '.ed-block[data-block-id="' + ids[2] + '"]';

      await openBlockEditor(page, selA);
      await page.waitForSelector(selA + ' textarea.ed-raw');
      await page.evaluate((s) => {
        const ta = document.querySelector(s + ' textarea.ed-raw');
        ta.value = 'UNDO-SWITCH-A-TEXT';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }, selA);
      // Blur out of the textarea via JS (not a real click — a real click
      // would ALSO be a "clicked outside a block" switchAwayFrom() trigger
      // in its own right, racing the in-flight /api/render call against
      // undo()'s own pre-check below). This purely moves focus off the
      // textarea so the global keydown handler's `inTextarea` gate lets
      // Ctrl+Z through to undo().
      await page.evaluate(() => document.activeElement && document.activeElement.blur());

      await page.keyboard.down('Control');
      await page.keyboard.press('KeyZ');
      await page.keyboard.up('Control');

      // undo()'s own switchAwayFrom() pre-check auto-commits A first, THEN
      // the undo proceeds and reverts that just-committed op (it's the
      // newest on the stack) — both must be true by the end.
      await page.waitForFunction(
        () => document.querySelector('.content').innerHTML.includes('First paragraph.') &&
          !document.querySelector('.content').innerHTML.includes('UNDO-SWITCH-A-TEXT'),
        { timeout: 5000 }
      );

      // No lockout: block C must still be able to open its editor.
      await openBlockEditor(page, selC);
      await page.waitForSelector(selC + ' textarea.ed-raw', { timeout: 3000 });
      assert.ok(
        await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), selC),
        'undo-with-modified-open-editor: no lockout — block C must open its editor after the undo'
      );
      await page.keyboard.press('Escape');

      await page.close();
      console.log('undo-with-modified-open-editor: A auto-commits then undo reverts it, no lockout — OK');
    }

    // ── switch-commit-failure: force /api/render 500 while A is modified,
    //    click B ──────────────────────────────────────────────────────────
    // Banner shows, A's editor stays open with its unsaved text, and B does
    // NOT open (state consistency over convenience).
    {
      const page = await newPage(browser);
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.method() === 'POST' && req.url().endsWith('/api/render')) {
          req.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'switch-commit-boom' }) });
        } else {
          req.continue();
        }
      });
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      const selA = '.ed-block[data-block-id="' + ids[0] + '"]';
      const selB = '.ed-block[data-block-id="' + ids[1] + '"]';

      await openBlockEditor(page, selA);
      await page.waitForSelector(selA + ' textarea.ed-raw');
      await page.evaluate((s) => {
        const ta = document.querySelector(s + ' textarea.ed-raw');
        ta.value = 'SWITCH-FAIL-A-TEXT';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }, selA);

      // Click B's block while /api/render is forced to fail — the
      // switch's auto-commit must fail, leaving A open and B unopened.
      await page.click(selB);
      await page.waitForSelector('.ed-conflict', { timeout: 5000 });
      const bannerText = await page.evaluate(() => document.querySelector('.ed-conflict').textContent);
      assert.ok(/render failed/i.test(bannerText),
        'switch-commit-failure: banner must explain the render failure, got: ' + bannerText);

      assert.strictEqual(
        await page.evaluate((s) => {
          const ta = document.querySelector(s + ' textarea.ed-raw');
          return ta ? ta.value : null;
        }, selA),
        'SWITCH-FAIL-A-TEXT',
        'switch-commit-failure: A\'s editor must stay open with its unsaved text when the auto-commit fails'
      );
      assert.strictEqual(
        await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), selB),
        false,
        'switch-commit-failure: B must NOT open when A\'s auto-commit failed'
      );

      await page.click('.ed-conflict button[aria-label="Dismiss"]');
      // Cleanup: cancel A's still-open editor via its ✕ button (same reason
      // as above — focus is on the banner's Dismiss button, not the
      // textarea, so Esc's per-textarea handler wouldn't fire).
      await page.click(selA + ' .ed-cancel');
      await page.waitForFunction((s) => !document.querySelector(s + ' textarea.ed-raw'), {}, selA);

      await page.close();
      console.log('switch-commit-failure: commit failure keeps A open, blocks B from opening — OK');
    }

    // ── single-flight switchAwayFrom(): two independent triggers firing
    //    near-simultaneously (an outside click, immediately followed by
    //    the global Ctrl+Z) must share ONE in-flight commit instead of each
    //    firing their own independent commit() — otherwise two concurrent
    //    /api/render calls can race, with the DOM ending up reflecting
    //    whichever response resolves last while `lines` reflects the
    //    other (silent save/DOM divergence). /api/render is held (not
    //    answered) so the race window is observable via the request count
    //    before either response is allowed to land.
    {
      const page = await newPage(browser);
      const heldRenderRequests = [];
      let renderRequestCount = 0;
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.method() === 'POST' && req.url().endsWith('/api/render')) {
          renderRequestCount++;
          heldRenderRequests.push(req); // held — answered explicitly below
        } else {
          req.continue();
        }
      });
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      const selA = '.ed-block[data-block-id="' + ids[0] + '"]';

      await openBlockEditor(page, selA);
      await page.waitForSelector(selA + ' textarea.ed-raw');
      await page.evaluate((s) => {
        const ta = document.querySelector(s + ' textarea.ed-raw');
        ta.value = 'SINGLE-FLIGHT-A-TEXT';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }, selA);

      // Fire an outside click (dispatched directly via the DOM .click()
      // API, not coordinate-based, so it unambiguously targets <body>) and
      // the global Ctrl+Z back-to-back, with no synchronization between
      // them — both are independent switchAwayFrom() trigger points that
      // see the SAME still-modified activeEditor. Blur first: a synthetic
      // .click() does NOT itself move focus off the still-focused textarea
      // (unlike a real pointer click), and without the blur, Ctrl+Z would
      // be swallowed by the keydown handler's own `inTextarea` gate before
      // ever reaching undo() at all.
      await page.evaluate(() => { document.activeElement && document.activeElement.blur(); document.body.click(); });
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyZ');
      await page.keyboard.up('Control');

      // Give both triggers' synchronous JS a moment to run and reach
      // /api/render. The request is held, not answered, so this window is
      // exactly where a duplicate commit request (if the guard were
      // missing) would show up as a second held request.
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(renderRequestCount, 1,
        'single-flight: exactly one /api/render request for the auto-commit — concurrent ' +
        'switchAwayFrom() triggers must share it, not each fire their own');

      // Release the held commit request; let it resolve for real.
      heldRenderRequests.shift().continue();

      // Once switchAwayFrom() resolves, undo() proceeds with its OWN
      // legitimate, SEQUENCED render request (never concurrent with the
      // commit's) — wait for it to arrive.
      const deadline = Date.now() + 5000;
      while (heldRenderRequests.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.strictEqual(renderRequestCount, 2,
        'single-flight: after the auto-commit resolves, undo() fires its own sequenced render — ' +
        'total 2, never overlapping with the commit\'s');
      heldRenderRequests.shift().continue();

      // Final DOM/state must be consistent: the undo reverted the
      // just-committed edit, not left dangling on whichever response
      // happened to resolve last.
      await page.waitForFunction(
        () => document.querySelector('.content').innerHTML.includes('First paragraph.') &&
          !document.querySelector('.content').innerHTML.includes('SINGLE-FLIGHT-A-TEXT'),
        { timeout: 5000 }
      );

      await page.close();
      console.log('single-flight switchAwayFrom: concurrent triggers share one commit, no request race — OK');
    }

    // ── Migrated from "Click-invoked edit bar" (Phase 2): always-on click =
    //    caret / focus-moves-between-blocks / lightbox-exempt / ⠿ handle
    //    opens a menu / MD escape hatch — same assertion intent as the
    //    retired click-select-then-bar flow, re-expressed as focus ─────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const blockIds = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block')).map((el) => el.getAttribute('data-block-id')));
      assert.ok(blockIds.length >= 5, 'fixture must have heading + 3 paragraphs + a trailing image paragraph');
      const selHeading = '.ed-block[data-block-id="' + blockIds[0] + '"]';
      const selA = '.ed-block[data-block-id="' + blockIds[1] + '"]';
      const selB = '.ed-block[data-block-id="' + blockIds[2] + '"]';
      const selImgBlock = '.ed-block[data-block-id="' + blockIds[blockIds.length - 1] + '"]';

      // Click block A -> no bar, no ed-selected outline (both retired for
      // paragraph/heading) — native focus lands on its content element,
      // which starts a burst (contenteditable, already armed at render time).
      await page.click(selA);
      await page.waitForFunction(
        (s) => document.activeElement === document.querySelector(s + ' > *'), {}, selA
      );
      assert.strictEqual(
        await page.evaluate((s) => document.querySelector(s + ' > *').getAttribute('contenteditable'), selA),
        'true',
        'clicking a WYSIWYG-eligible block must place native focus on its (already-armed) content element'
      );
      assert.strictEqual(
        await page.evaluate(() => !document.querySelector('.ed-bar')),
        true,
        'no .ed-bar for a paragraph/heading block — retired along with click-select'
      );

      // Click a DIFFERENT block -> focus moves there; A's (unmodified) burst
      // is silently dropped, same "switch-cancels" intent as before.
      await page.click(selB);
      await page.waitForFunction(
        (s) => document.activeElement === document.querySelector(s + ' > *'), {}, selB
      );
      assert.strictEqual(
        await page.evaluate((s) => document.activeElement === document.querySelector(s + ' > *'), selA),
        false,
        'focus must have moved off A once B is clicked'
      );

      // Click outside any block -> B's burst ends (unmodified -> silent
      // drop), nothing left focused inside a block. A synthetic .click()
      // alone does not itself move focus (unlike a real pointer click) —
      // blur explicitly first, same technique the single-flight scenario
      // below uses.
      await page.evaluate(() => { document.activeElement && document.activeElement.blur(); document.body.click(); });
      await page.waitForFunction((s) => document.activeElement !== document.querySelector(s + ' > *'), {}, selB);
      assert.strictEqual(
        await page.evaluate((s) => document.activeElement === document.querySelector(s + ' > *'), selB),
        false,
        'clicking outside any block must move focus away from it'
      );

      // Esc reverts the burst to its pre-focus baseline and ends it (blurs)
      // — the always-on replacement for the old "Esc dismisses the bar".
      await page.click(selHeading);
      await page.waitForFunction(
        (s) => document.activeElement === document.querySelector(s + ' > *'), {}, selHeading
      );
      await page.keyboard.press('Escape');
      await page.waitForFunction(
        (s) => document.activeElement !== document.querySelector(s + ' > *'), {}, selHeading
      );

      // Clicking a lightbox target (an image) must open the lightbox, NOT
      // start editing — img/.mermaid/.graphviz/wavedrom stay excluded, same
      // as before.
      await page.click(selImgBlock + ' img');
      await page.waitForFunction(() => {
        const lb = document.querySelector('.lightbox');
        return !!lb && !lb.hidden;
      }, { timeout: 3000 });
      assert.strictEqual(
        await page.evaluate(() => !document.querySelector('.ed-bar')),
        true,
        'clicking a lightbox target must not show any bar'
      );
      // Close the lightbox so it doesn't interfere with the assertions below.
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => {
        const lb = document.querySelector('.lightbox');
        return !lb || lb.hidden;
      }, { timeout: 3000 });

      // ⠿ handle: hover reveals it, click opens the small menu (heading ±
      // for a heading, MD 原始碼, close) — replaces the old bar's ✎/MD combo.
      await page.hover(selHeading);
      await page.click(selHeading + ' .ed-handle');
      await page.waitForSelector('.ed-handle-menu');
      assert.strictEqual(
        await page.evaluate(() => Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
          .filter((b) => !b.hidden).map((b) => b.textContent).sort().join(',')),
        // §10-gap fix: the ⠿ menu also gained a 刪除 (delete block) item.
        '+,MD 原始碼,−,✕,刪除'.split(',').sort().join(','),
        'the ⠿ menu on a heading must show ± / MD 原始碼 / 刪除 / ✕'
      );
      // The MD escape hatch forces raw-edit even on a WYSIWYG-eligible block
      // — the direct migration of the old bar's MD button.
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
          .find((b) => b.textContent === 'MD 原始碼');
        btn.click();
      });
      await page.waitForSelector(selHeading + ' textarea.ed-raw');
      assert.strictEqual(
        await page.evaluate(() => !document.querySelector('.ed-handle-menu')),
        true,
        'the ⠿ menu must close once the raw editor opens'
      );
      await page.keyboard.press('Escape');
      await page.waitForFunction((s) => !document.querySelector(s + ' textarea.ed-raw'), {}, selHeading);

      // A non-heading block's ⠿ menu must hide ± (only MD 原始碼 / ✕ visible).
      await page.hover(selA);
      await page.click(selA + ' .ed-handle');
      await page.waitForSelector('.ed-handle-menu');
      assert.strictEqual(
        await page.evaluate(() => {
          const minus = Array.from(document.querySelectorAll('.ed-handle-menu-btn')).find((b) => b.textContent === '−');
          return minus ? minus.hidden : null;
        }),
        true,
        'a non-heading block\'s ⠿ menu must hide the heading ± buttons'
      );
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('.ed-handle-menu-btn')).find((b) => b.textContent === '✕');
        btn.click();
      });
      await page.waitForFunction(() => !document.querySelector('.ed-handle-menu'));

      await page.close();
      console.log('always-on: click = caret/focus, lightbox-exempt, ⠿ handle opens menu + MD escape hatch — OK');
    }

    // ── Task 3 WYSIWYG: click paragraph -> contenteditable, no textarea;
    //    type + Enter commits; file line updated on save ──────────────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      const sel = '.ed-block[data-block-id="' + ids[0] + '"]'; // "First paragraph."
      const editEl = sel + ' > *';

      await openWysiwyg(page, sel);
      assert.strictEqual(
        await page.evaluate((s) => !document.querySelector(s + ' textarea.ed-raw'), sel),
        true,
        'WYSIWYG: clicking a paragraph must show NO textarea'
      );
      assert.strictEqual(
        await page.evaluate((s) => document.querySelector(s).getAttribute('contenteditable'), editEl),
        'true',
        'WYSIWYG: the content element must be contenteditable (always-on — already true before the click)'
      );

      await page.evaluate((s) => document.querySelector(s).focus(), editEl);
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.type('WYSIWYG-EDITED-TEXT');
      await page.keyboard.press('Enter');

      await page.waitForFunction(
        () => document.querySelector('.content').innerHTML.includes('WYSIWYG-EDITED-TEXT'),
        { timeout: 5000 }
      );
      assert.ok(
        await page.evaluate(() => !document.querySelector('.content').innerHTML.includes('undefined')),
        'commit must not stringify undefined into the DOM'
      );

      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 300));
      const fileText1 = fs.readFileSync(mdPath, 'utf8');
      assert.ok(fileText1.includes('WYSIWYG-EDITED-TEXT'),
        'WYSIWYG: Enter-commit + save must update the file on disk');

      await page.close();
      console.log('wysiwyg: paragraph edit commits via Enter and persists to file — OK');
    }

    // ── Task 3 WYSIWYG: **bold** shows <strong> while editing (no literal
    //    ** visible in the edit root's text); Esc reverts exactly ─────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const boldId = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .find((b) => b.querySelector('strong'));
        return el ? el.getAttribute('data-block-id') : null;
      });
      assert.ok(boldId, 'fixture must have a paragraph with **bold** text');
      const sel = '.ed-block[data-block-id="' + boldId + '"]';
      const editEl = sel + ' > *';
      // Captured BEFORE any editing interaction — the bar itself is a CHILD
      // of `sel` once selected, so comparing `sel`'s innerHTML post-edit
      // would spuriously include/exclude the bar. `editEl` (the <p> tag
      // alone) is what cancel() actually restores.
      const originalHtml = await page.evaluate((s) => document.querySelector(s).innerHTML, editEl);

      await openWysiwyg(page, sel);

      assert.strictEqual(
        await page.evaluate((s) => !!document.querySelector(s + ' strong'), editEl),
        true,
        'WYSIWYG: bold text must render as <strong> while editing'
      );
      assert.strictEqual(
        await page.evaluate((s) => document.querySelector(s).innerText.includes('**'), editEl),
        false,
        'WYSIWYG: no literal ** must be visible in the edit root\'s text'
      );

      await page.keyboard.press('Escape');
      await page.waitForFunction(
        (s) => document.activeElement !== document.querySelector(s), {}, editEl
      );
      assert.strictEqual(
        await page.evaluate((s) => document.querySelector(s).innerHTML, editEl),
        originalHtml,
        'WYSIWYG: Esc must revert to the exact pre-edit HTML'
      );

      await page.close();
      console.log('wysiwyg: bold shows <strong> while editing, Esc reverts exactly — OK');
    }

    // ── Migrated + Phase 3 Task 2 RED scenario "degrade block click ->
    //    textarea": a paragraph containing an image (not WYSIWYG-eligible)
    //    is a DEGRADED block — clicking it opens the raw-edit textarea
    //    IMMEDIATELY, no ⠿ menu / MD step needed at all (brief: "click
    //    swaps in the in-place monospace textarea immediately") ───────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const blockIds = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      const selImg = '.ed-block[data-block-id="' + blockIds[blockIds.length - 1] + '"]';

      assert.strictEqual(
        await page.evaluate((s) => {
          const el = document.querySelector(s + ' > *');
          return el.getAttribute('contenteditable');
        }, selImg),
        null,
        'sanity: a degraded (image-containing) block must NOT be armed contenteditable'
      );

      // Dispatch the click on the block itself (bubbles to the delegated
      // document listener) rather than a coordinate-based page.click(), which
      // could land ON the <img> — a lightbox target excluded from selection.
      await page.evaluate((s) => {
        document.querySelector(s).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }, selImg);
      await page.waitForSelector(selImg + ' textarea.ed-raw');
      assert.strictEqual(
        await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), selImg),
        true,
        'a degraded block (image-containing paragraph) must open the raw-edit textarea on a SINGLE click, no menu step'
      );

      await page.keyboard.press('Escape');
      await page.close();
      console.log('degrade block click->textarea: image paragraph opens raw-edit immediately on click — OK');
    }

    // ── Migrated + Phase 3 Task 2 RED scenario "⠿ menu heading ±": the ⠿
    //    handle's small menu shows ± only for heading blocks; clicking +
    //    changes the '#' count in the source after commit ────────────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const headingId = await page.evaluate(() =>
        document.querySelector('.ed-block[data-block-type="heading"]').getAttribute('data-block-id'));
      const sel = '.ed-block[data-block-id="' + headingId + '"]';

      await page.hover(sel);
      await page.click(sel + ' .ed-handle');
      await page.waitForSelector('.ed-handle-menu');
      assert.strictEqual(
        await page.evaluate(() => {
          const plus = Array.from(document.querySelectorAll('.ed-handle-menu-btn')).find((b) => b.textContent === '+');
          return plus ? plus.hidden : null;
        }),
        false,
        'heading block: the ⠿ menu\'s + button must be visible'
      );
      assert.strictEqual(
        await page.evaluate(() => {
          const minus = Array.from(document.querySelectorAll('.ed-handle-menu-btn')).find((b) => b.textContent === '−');
          return minus ? minus.hidden : null;
        }),
        false,
        'heading block: the ⠿ menu\'s − button must be visible'
      );
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('.ed-handle-menu-btn')).find((b) => b.textContent === '✕');
        btn.click();
      });
      await page.waitForFunction(() => !document.querySelector('.ed-handle-menu'));

      const nonHeadingId = await page.evaluate(() =>
        document.querySelector('.ed-block[data-block-type="paragraph"]').getAttribute('data-block-id'));
      const selPara = '.ed-block[data-block-id="' + nonHeadingId + '"]';
      await page.hover(selPara);
      await page.click(selPara + ' .ed-handle');
      await page.waitForSelector('.ed-handle-menu');
      assert.strictEqual(
        await page.evaluate(() => {
          const plus = Array.from(document.querySelectorAll('.ed-handle-menu-btn')).find((b) => b.textContent === '+');
          return plus ? plus.hidden : null;
        }),
        true,
        'non-heading block: the ⠿ menu\'s + button must stay hidden'
      );
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('.ed-handle-menu-btn')).find((b) => b.textContent === '✕');
        btn.click();
      });
      await page.waitForFunction(() => !document.querySelector('.ed-handle-menu'));

      await page.hover(sel);
      await page.click(sel + ' .ed-handle');
      await page.waitForSelector('.ed-handle-menu');
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('.ed-handle-menu-btn')).find((b) => b.textContent === '+');
        btn.click();
      });
      await page.waitForFunction(
        (s) => { const h = document.querySelector(s + ' > *'); return h && h.tagName === 'H2'; },
        {}, sel
      );
      assert.strictEqual(
        await page.evaluate(() => !document.querySelector('.ed-handle-menu')),
        true,
        'the ⠿ menu must close itself once a heading-depth op is clicked'
      );
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 300));
      const fileText2 = fs.readFileSync(mdPath, 'utf8');
      assert.ok(/^## Heading/m.test(fileText2),
        'heading ±: clicking + must increase the heading depth in the source (# -> ##)');

      await page.close();
      console.log('⠿ menu heading ±: shown only for headings, + increases depth and persists to file — OK');
    }

    // ── Task 3: Shift+Enter inserts <br> instead of committing; a later
    //    plain Enter commits it and it round-trips to the saved source ────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      const sel = '.ed-block[data-block-id="' + ids[1] + '"]'; // "Second paragraph."
      const editEl = sel + ' > *';

      await openWysiwyg(page, sel);

      await page.evaluate((s) => {
        const el = document.querySelector(s);
        el.focus();
        const r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false);
        const sel2 = window.getSelection();
        sel2.removeAllRanges();
        sel2.addRange(r);
      }, editEl);
      await page.keyboard.down('Shift');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Shift');
      await page.keyboard.type('SECOND-LINE');

      assert.strictEqual(
        await page.evaluate((s) => !!document.querySelector(s + ' br'), editEl),
        true,
        'Shift+Enter must insert a <br> instead of committing'
      );
      assert.strictEqual(
        await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), sel),
        false,
        'Shift+Enter must NOT commit (no textarea, editor still open)'
      );

      await page.keyboard.press('Enter'); // plain Enter now commits
      await page.waitForFunction(
        () => document.querySelector('.content').innerHTML.includes('SECOND-LINE'),
        { timeout: 5000 }
      );
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 300));
      const fileText3 = fs.readFileSync(mdPath, 'utf8');
      assert.ok(fileText3.includes('<br>') && fileText3.includes('SECOND-LINE'),
        'Shift+Enter\'s <br> must round-trip into the saved markdown source');

      await page.close();
      console.log('wysiwyg: Shift+Enter inserts <br>, later Enter commits it — OK');
    }

    // ── Task 3: paste inserts clipboard text as plain text only — no rich
    //    markup (e.g. a real <b>) ever survives into the DOM ──────────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      const sel = '.ed-block[data-block-id="' + ids[2] + '"]'; // "Third paragraph."
      const editEl = sel + ' > *';

      await openWysiwyg(page, sel);

      await page.evaluate((s) => {
        const el = document.querySelector(s);
        el.focus();
        const r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false);
        const sel2 = window.getSelection();
        sel2.removeAllRanges();
        sel2.addRange(r);
        const dt = new DataTransfer();
        dt.setData('text/plain', 'PASTED<b>RICH</b>TEXT');
        dt.setData('text/html', '<b>evil</b>');
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
      }, editEl);

      assert.strictEqual(
        await page.evaluate((s) => !document.querySelector(s + ' b'), editEl),
        true,
        'paste must never introduce a real <b> element — only plain text'
      );
      assert.ok(
        await page.evaluate((s) => document.querySelector(s).textContent.includes('PASTED<b>RICH</b>TEXT'), editEl),
        'paste must insert the clipboard\'s plain-text form verbatim as text'
      );

      await page.keyboard.press('Escape');
      await page.close();
      console.log('wysiwyg: paste inserts plain text only, rich markup discarded — OK');
    }

    // ── Task 3: unsupported content landing mid-session (drag/drop or any
    //    path other than our own plain-text paste handler) must degrade to
    //    raw-edit prefilled with the ORIGINAL source on commit, never
    //    corrupt it — degrade-never-lose ─────────────────────────────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      // ids[0] ("First paragraph.") and ids[1] ("Second paragraph.") were
      // already committed to different text by earlier scenarios in this
      // same run (the editor server persists real edits across page loads,
      // by design) — ids[2] ("Third paragraph.") is the first one none of
      // the prior scenarios ever committed (the paste scenario above used it
      // but only cancelled via Esc), so its on-disk source is still known.
      const sel = '.ed-block[data-block-id="' + ids[2] + '"]'; // "Third paragraph."
      const editEl = sel + ' > *';

      await openWysiwyg(page, sel);

      // Simulate content our own paste handler would never itself produce
      // (a styled <span>) landing directly in the DOM — a real drag-drop
      // takes exactly this kind of uncontrolled path.
      await page.evaluate((s) => {
        document.querySelector(s).innerHTML += '<span style="color:red">unsupported</span>';
      }, editEl);
      await page.evaluate((s) => document.querySelector(s).focus(), editEl);
      await page.keyboard.press('Enter'); // commit

      await page.waitForSelector(sel + ' textarea.ed-raw', { timeout: 5000 });
      assert.strictEqual(
        await page.evaluate((s) => document.querySelector(s + ' textarea.ed-raw').value, sel),
        'Third paragraph.',
        'unsupported commit must open raw-edit prefilled with the ORIGINAL source, not the corrupted DOM'
      );
      await page.waitForSelector('.ed-conflict');
      const bannerText = await page.evaluate(() => document.querySelector('.ed-conflict').textContent);
      assert.ok(bannerText.includes('不支援'), 'unsupported commit must show the fallback banner');

      await page.click('.ed-conflict button[aria-label="Dismiss"]');
      await page.click(sel + ' .ed-cancel');
      await page.close();
      console.log('wysiwyg: unsupported mid-session content degrades to raw-edit with original source — OK');
    }

    // ── Migrated regression (CRITICAL): originally proved that
    //    openWysiwygEditor()'s per-session keydown/paste listeners were
    //    removed on cancel() (a PERSISTENT content element re-opened N times
    //    without removing the previous session's listeners would stack N
    //    live sets, and a stale cancel() closure firing on a later commit
    //    produced an uncommanded second /api/render). Phase 3 Task 2 makes
    //    the underlying bug class structurally impossible (armEditables()
    //    never attaches anything per-block at all — everything routes
    //    through the ONE delegated focusin/focusout/keydown/paste/input set
    //    installed once at module load), but the OBSERVABLE property this
    //    test proves — repeated focus/Esc cycles on the same block never
    //    cause a later real commit to fire more than one /api/render — is
    //    still exactly the right thing to keep verifying.
    {
      const page = await newPage(browser);
      let renderRequestCount = 0;
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.method() === 'POST' && req.url().endsWith('/api/render')) renderRequestCount++;
        req.continue();
      });
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      const sel = '.ed-block[data-block-id="' + ids[3] + '"]'; // "Bold paragraph..." — untouched so far
      const editEl = sel + ' > *';

      for (let i = 0; i < 3; i++) {
        await openWysiwyg(page, sel);
        await page.keyboard.press('Escape');
        await page.waitForFunction((s) => document.activeElement !== document.querySelector(s), {}, editEl);
      }

      renderRequestCount = 0; // only the real commit below is under test
      await openWysiwyg(page, sel);
      await page.evaluate((s) => document.querySelector(s).focus(), editEl);
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.type('LISTENER-LEAK-REGRESSION-TEXT');
      await page.keyboard.press('Enter');

      await page.waitForFunction(
        () => document.querySelector('.content').innerHTML.includes('LISTENER-LEAK-REGRESSION-TEXT'),
        { timeout: 5000 }
      );
      // Give any stray duplicate request from a stale listener a moment to
      // land before counting — the bug's second POST fires asynchronously,
      // not synchronously with the first.
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(renderRequestCount, 1,
        'CRITICAL regression: exactly ONE /api/render request for the commit — stale cancel() ' +
        'listeners from earlier open/Esc cycles must not fire a second one');

      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 300));
      const fileTextLeak = fs.readFileSync(mdPath, 'utf8');
      assert.ok(fileTextLeak.includes('LISTENER-LEAK-REGRESSION-TEXT'),
        'CRITICAL regression: the typed text must persist to disk, not be silently reverted ' +
        'by a stale listener\'s duplicate commit');

      await page.close();
      console.log('wysiwyg: listener-leak regression — 3x open/Esc then commit fires exactly one render — OK');
    }

    // ── Migrated regression (IMPORTANT): originally proved that the
    //    unsupported-degrade path firing INSIDE switchAwayFrom() (clicking a
    //    DIFFERENT block C while block A had unsupported content injected)
    //    aborted the whole click so the OLD single-slot `activeEditor`
    //    (which could only ever track ONE thing) never ended up split
    //    between A and C at once. Phase 3 Task 2 changes what's actually
    //    being proved: `activeEditor` (raw/table) and `currentBurst`
    //    (always-on WYSIWYG) are now two INDEPENDENT slots, so A degrading
    //    to raw-edit (activeEditor) and C's native focus starting its own
    //    burst (currentBurst) can safely coexist — there is no shared state
    //    left to corrupt. What must still hold, and what this now proves:
    //    A's degrade is byte-for-byte correct (original source, never the
    //    corrupted DOM) regardless of C's focus racing it, and C's own burst
    //    starts cleanly and independently — neither leaks into the other.
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .map((el) => el.getAttribute('data-block-id')));
      const selA = '.ed-block[data-block-id="' + ids[2] + '"]'; // "Third paragraph." — untouched
      const editElA = selA + ' > *';
      const headingId = await page.evaluate(() =>
        document.querySelector('.ed-block[data-block-type="heading"]').getAttribute('data-block-id'));
      const selC = '.ed-block[data-block-id="' + headingId + '"]';

      await openWysiwyg(page, selA);

      // Inject a real text change (so hasChanges() is true and
      // switchAwayFrom() actually attempts a commit below, not a silent
      // cancel) ALONGSIDE unsupported content our own paste handler would
      // never itself produce — same technique as the degrade-never-lose
      // scenario above, but this time triggered via a focus switch instead
      // of a direct Enter.
      await page.evaluate((s) => {
        document.querySelector(s).innerHTML += 'EXTRA<span style="color:red">unsupported</span>';
      }, editElA);

      // Click block C while A is modified: A's focusout resolves via
      // switchAwayFrom(), hits the unsupported branch, and degrades A to
      // raw-edit — independently of C's own focusin starting its own burst.
      await page.click(selC);

      await page.waitForSelector(selA + ' textarea.ed-raw', { timeout: 5000 });
      assert.strictEqual(
        await page.evaluate((s) => document.querySelector(s + ' textarea.ed-raw').value, selA),
        'Third paragraph.',
        'IMPORTANT regression: A must degrade to raw-edit prefilled with its ORIGINAL source'
      );
      assert.strictEqual(
        await page.evaluate((s) => document.querySelector(s + ' > *').getAttribute('contenteditable'), selC),
        'true',
        'C\'s own burst must start cleanly (native focus is independent of A\'s degrade)'
      );
      assert.strictEqual(
        await page.evaluate((s) => document.querySelector(s + ' textarea.ed-raw').value, selA),
        'Third paragraph.',
        'A\'s degraded raw-edit content must stay exactly as degraded — unaffected by C\'s independent burst'
      );

      await page.click('.ed-conflict button[aria-label="Dismiss"]');
      await page.click(selA + ' .ed-cancel');
      await page.keyboard.press('Escape'); // end C's burst too
      await page.close();
      console.log('wysiwyg: unsupported-degrade on A and C\'s independent burst coexist cleanly (no shared-state split) — OK');
    }

    // ── Phase 3 Task 2 RED scenario: Ctrl+Z mid-burst reverts typing; a
    //    SECOND Ctrl+Z (now at the burst's local bottom) cascades to the
    //    document-level undo stack, reverting the PREVIOUS committed edit —
    //    lib/editor/history.js's createBurstHistory() driving the whole
    //    thing, not the browser's native contenteditable undo (Ctrl+Z is
    //    intercepted with preventDefault() before either branch runs) ─────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const sel = await paragraphSelByText(page, 'Burst undo target');
      const editEl = sel + ' > *';
      const originalText = await page.evaluate((s) => document.querySelector(s).textContent, editEl);

      // A first, real, COMMITTED edit — the "previous committed edit" the
      // second Ctrl+Z below must cascade to.
      await openWysiwyg(page, sel);
      await page.evaluate((s) => document.querySelector(s).focus(), editEl);
      await page.keyboard.type(' EDIT-ONE');
      const staleEditEl = await nodeHandleFor(page, editEl);
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        (s, t) => document.querySelector(s).textContent === t,
        {}, editEl, originalText + ' EDIT-ONE'
      );
      // ' EDIT-ONE' is already on screen (it was typed), so the wait above can
      // pass BEFORE the commit's re-render — see awaitContentSwap()'s comment.
      await awaitContentSwap(page, staleEditEl);

      // A second burst on the SAME (now re-armed) block: type more text
      // (never explicitly flushed — the debounce coalesces every keystroke
      // into ONE pending snapshot) then a single Ctrl+Z.
      const sel2 = await paragraphSelByText(page, 'Burst undo target');
      const editEl2 = sel2 + ' > *';
      await openWysiwyg(page, sel2);
      await page.evaluate((s) => document.querySelector(s).focus(), editEl2);
      await page.keyboard.type(' EDIT-TWO');
      assert.strictEqual(
        await page.evaluate((s) => document.querySelector(s).textContent, editEl2),
        originalText + ' EDIT-ONE EDIT-TWO',
        'sanity: the second burst\'s typing must be visible before any undo'
      );

      await page.keyboard.down('Control');
      await page.keyboard.press('KeyZ');
      await page.keyboard.up('Control');
      assert.strictEqual(
        await page.evaluate((s) => document.querySelector(s).textContent, editEl2),
        originalText + ' EDIT-ONE',
        'Ctrl+Z mid-burst must revert the typed text back to the burst\'s pre-focus snapshot'
      );
      assert.strictEqual(
        await page.evaluate((s) => document.activeElement === document.querySelector(s), editEl2),
        true,
        'the burst must stay OPEN (still focused) after a mid-burst undo — nothing was committed'
      );

      // Second Ctrl+Z: local history is now exhausted (back to snapshot 0,
      // nothing pending) -> commits the burst (a no-op, unchanged) then
      // cascades to the document-level undo() stack, reverting EDIT-ONE.
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyZ');
      await page.keyboard.up('Control');
      // originalText ("Burst undo target text here.") is a PREFIX of the
      // EDIT-ONE-committed text, so a plain .includes(originalText) check is
      // satisfied even BEFORE this cascade-undo lands (it was already true
      // from the earlier commit) — wait for the discriminating signal
      // instead: EDIT-ONE's own text must be GONE.
      await page.waitForFunction(
        () => !document.querySelector('.content').textContent.includes('EDIT-ONE'),
        { timeout: 5000 }
      );
      const finalText = await page.evaluate(() => {
        const blocks = Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'));
        const b = blocks.find((el) => el.textContent.trim().startsWith('Burst undo target'));
        // b.firstElementChild is the <p> content itself — b.textContent
        // would also include the ⠿ handle's own textContent ("⠿").
        return b ? b.firstElementChild.textContent.trim() : null;
      });
      assert.strictEqual(finalText, originalText,
        'Ctrl+Z past the burst\'s local bottom must cascade to the document undo stack and revert EDIT-ONE too');

      await page.close();
      console.log('burst undo: Ctrl+Z mid-burst reverts typing; a second Ctrl+Z cascades to the previous commit — OK');
    }

    // ── Phase 3 Task 2 RED scenario: bold -> Ctrl+Z reverts the bold
    //    (native-undo replacement proof) — the toolbar's mark toggle calls
    //    history.snap() after applying (brief: "Programmatic mutations ...
    //    call snap() after applying"), and Ctrl+Z inside the burst reverts
    //    it via OUR history, never committing to the server (no /api/render
    //    at all) — proof this isn't the browser's own native contenteditable
    //    undo doing the work (which this file's preventDefault() blocks) ──
    {
      const page = await newPage(browser);
      let renderRequestCount = 0;
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.method() === 'POST' && req.url().endsWith('/api/render')) renderRequestCount++;
        req.continue();
      });
      await page.goto(url, { waitUntil: 'networkidle0' });

      const sel = await paragraphSelByText(page, 'Burst bold undo target');
      const editEl = sel + ' > *';
      await openWysiwyg(page, sel);
      await selectWordInEl(page, editEl, 'target');
      await page.waitForSelector('.ed-seltb');
      await page.click('.ed-seltb-b');
      assert.strictEqual(
        await page.evaluate((s) => {
          const st = document.querySelector(s + ' strong');
          return st ? st.textContent : null;
        }, editEl),
        'target',
        'sanity: Bold must wrap "target" in <strong> before the undo'
      );

      await page.keyboard.down('Control');
      await page.keyboard.press('KeyZ');
      await page.keyboard.up('Control');
      assert.strictEqual(
        await page.evaluate((s) => !document.querySelector(s + ' strong'), editEl),
        true,
        'Ctrl+Z right after a toolbar Bold must revert the <strong> wrap'
      );
      assert.ok(
        await page.evaluate((s) => document.querySelector(s).textContent.includes('Burst bold undo target word here.'), editEl),
        'the text content must be back to plain (unbolded) after the undo'
      );
      assert.strictEqual(
        await page.evaluate((s) => document.activeElement === document.querySelector(s), editEl),
        true,
        'the burst must stay open (still focused) — the undo is purely local, nothing was committed'
      );
      assert.strictEqual(renderRequestCount, 0,
        'the mark-toggle-then-undo round trip must never hit /api/render — proof this is OUR burst ' +
        'history reverting locally, not a server round trip (and not the browser\'s blocked native undo)');

      await page.keyboard.press('Escape'); // end the burst, discard (never committed)
      await page.close();
      console.log('burst undo: bold via toolbar then Ctrl+Z reverts it locally, no server round trip — OK');
    }

    // ── Phase 3 Task 2 RED scenario "focus-edit-blur commits to disk": no
    //    Enter, no Ctrl+Enter, no button — just focus a WYSIWYG-eligible
    //    paragraph, type, and click a DIFFERENT block (a real blur, not a
    //    keyboard commit) — the burst must commit and the edit must persist
    //    to the file on save ──────────────────────────────────────────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const sel = await paragraphSelByText(page, 'Blur commit target');
      const editEl = sel + ' > *';
      const otherSel = await paragraphSelByText(page, 'Burst bold undo target');

      await openWysiwyg(page, sel);
      await page.evaluate((s) => document.querySelector(s).focus(), editEl);
      await page.keyboard.type(' BLUR-COMMITTED');

      // Click a DIFFERENT block — a real blur, no Enter/Ctrl+Enter/button
      // involved at all.
      await page.click(otherSel);
      await page.waitForFunction(
        () => document.querySelector('.content').innerHTML.includes('BLUR-COMMITTED'),
        { timeout: 5000 }
      );
      assert.strictEqual(
        await page.evaluate((s) => document.activeElement === document.querySelector(s), editEl),
        false,
        'sanity: the original edit surface must no longer be the live focused element post-commit'
      );

      await page.keyboard.press('Escape'); // end the OTHER block's own burst (never committed)
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 300));
      const fileText = fs.readFileSync(mdPath, 'utf8');
      assert.ok(fileText.includes('Blur commit target text here. BLUR-COMMITTED'),
        'focus-edit-blur must commit to `lines` and persist to disk on save, got:\n' + fileText);

      await page.close();
      console.log('always-on: focus + type + blur (no Enter) commits and persists to disk — OK');
    }

    // ── Global Constraint: burst commit-failure carries over the SAME
    //    rollback + single-flight semantics raw-edit/table sessions have
    //    always had — a failed /api/render leaves the burst OPEN (DOM/typed
    //    text untouched, focus returned to it) with a dismissible banner,
    //    never silently discarding what was typed ─────────────────────────
    {
      const page = await newPage(browser);
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.method() === 'POST' && req.url().endsWith('/api/render')) {
          req.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'burst-boom' }) });
        } else {
          req.continue();
        }
      });
      await page.goto(url, { waitUntil: 'networkidle0' });

      const sel = await paragraphSelByText(page, 'Burst failure target');
      const editEl = sel + ' > *';

      await openWysiwyg(page, sel);
      await page.evaluate((s) => document.querySelector(s).focus(), editEl);
      await page.keyboard.type(' UNSAVED-BURST-TEXT');
      await page.evaluate((s) => document.querySelector(s).blur(), editEl);

      await page.waitForSelector('.ed-conflict', { timeout: 5000 });
      const bannerText = await page.evaluate(() => document.querySelector('.ed-conflict').textContent);
      assert.ok(/render failed/i.test(bannerText),
        'burst commit-failure: banner must explain the render failure, got: ' + bannerText);
      assert.strictEqual(
        await page.evaluate((s) => document.querySelector(s).textContent.includes('UNSAVED-BURST-TEXT'), editEl),
        true,
        'burst commit-failure: the typed text must stay in the DOM, never silently discarded'
      );
      assert.strictEqual(
        await page.evaluate((s) => document.activeElement === document.querySelector(s), editEl),
        true,
        'burst commit-failure: the burst must stay open — focus returns to the surface after the failed blur-commit'
      );

      await page.click('.ed-conflict button[aria-label="Dismiss"]');
      await page.keyboard.press('Escape'); // discard the still-open burst
      await page.close();
      console.log('burst commit-failure: stays open with typed text intact, banner dismissible — OK');
    }

    // ── Phase 3 Task 2: degraded block "blur commits (changed) or restores
    //    (unchanged)" — the raw-edit textarea a degraded block opens
    //    immediately on click now ALSO commits/restores on blur, not just
    //    via Ctrl+Enter/Esc/✓/✕ (which keep working unchanged) ────────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      // Located by its distinctive <img alt> (an image-only paragraph's
      // textContent is empty, so paragraphSelByText()'s prefix match can't
      // find it — this fixture's alt text is unique instead).
      const blockId = await page.evaluate(() => {
        const img = Array.from(document.querySelectorAll('img'))
          .find((i) => i.getAttribute('alt') === 'blur degrade fixture');
        const block = img && img.closest('.ed-block');
        return block ? block.getAttribute('data-block-id') : null;
      });
      assert.ok(blockId, 'fixture paragraph not found: ![blur degrade fixture]');
      const selDegraded = '.ed-block[data-block-id="' + blockId + '"]';
      const otherSel = await paragraphSelByText(page, 'Third paragraph');

      // click swaps in the textarea immediately — no menu step.
      await page.evaluate((s) => {
        document.querySelector(s).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }, selDegraded);
      await page.waitForSelector(selDegraded + ' textarea.ed-raw');

      // Unchanged -> blur restores (no textarea left, no server round trip).
      await page.click(otherSel);
      await page.waitForFunction((s) => !document.querySelector(s + ' textarea.ed-raw'), {}, selDegraded);
      await page.keyboard.press('Escape'); // end otherSel's own burst, never committed

      // Changed -> blur commits.
      await page.evaluate((s) => {
        document.querySelector(s).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }, selDegraded);
      await page.waitForSelector(selDegraded + ' textarea.ed-raw');
      await page.evaluate((s) => {
        const ta = document.querySelector(s + ' textarea.ed-raw');
        ta.value = '![blur degrade fixture EDITED](block.png)';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }, selDegraded);
      await page.click(otherSel);
      await page.waitForFunction(
        () => document.querySelector('.content').innerHTML.includes('blur degrade fixture EDITED'),
        { timeout: 5000 }
      );
      await page.keyboard.press('Escape'); // end otherSel's own burst, never committed

      await page.close();
      console.log('degrade block: blur restores when unchanged, commits when changed — OK');
    }

    // ── Task 4: floating selection toolbar appears over a non-collapsed
    //    selection inside an active WYSIWYG session; hidden while the
    //    selection is collapsed; hidden once the session ends (Esc) ───────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const sel = await paragraphSelByText(page, 'Bold toggle target');
      const editEl = sel + ' > *';

      assert.strictEqual(
        await page.evaluate(() => !!document.querySelector('.ed-seltb')),
        false,
        'the selection toolbar must not exist before any WYSIWYG session is open'
      );

      await openWysiwyg(page, sel);
      assert.strictEqual(
        await page.evaluate(() => !!document.querySelector('.ed-seltb')),
        false,
        'the toolbar must stay hidden while the selection is still collapsed (caret at end)'
      );

      await selectWordInEl(page, editEl, 'toggle');
      await page.waitForSelector('.ed-seltb');
      assert.strictEqual(
        await page.evaluate(() => document.querySelectorAll('.ed-seltb-btn').length),
        6,
        'the toolbar must show exactly 6 buttons: B / I / S / U / <> / link'
      );

      // Positioned ABOVE the selection by default — plenty of room above
      // this paragraph, which isn't near the top of the viewport.
      const rects = await page.evaluate(() => {
        const r = document.querySelector('.ed-seltb').getBoundingClientRect();
        const range = window.getSelection().getRangeAt(0).getBoundingClientRect();
        return { tbTop: r.top, tbBottom: r.bottom, selTop: range.top };
      });
      assert.ok(rects.tbBottom <= rects.selTop + 1,
        'the toolbar must be positioned above the selection when there is room, got: ' + JSON.stringify(rects));
      assert.ok(rects.tbTop >= 0, 'the toolbar must stay clamped within the viewport (top >= 0)');

      // Collapsing the selection hides the toolbar.
      await page.evaluate((s) => {
        const el = document.querySelector(s);
        const r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false);
        const sl = window.getSelection();
        sl.removeAllRanges();
        sl.addRange(r);
        document.dispatchEvent(new Event('selectionchange'));
      }, editEl);
      await page.waitForFunction(() => !document.querySelector('.ed-seltb'), { timeout: 3000 });

      // Re-select, then cancel the session (Esc) — the toolbar must not
      // survive past the session's end.
      await selectWordInEl(page, editEl, 'toggle');
      await page.waitForSelector('.ed-seltb');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.ed-seltb'), { timeout: 3000 });

      await page.close();
      console.log('sel-toolbar: shows on selection, hides on collapse and on session end — OK');
    }

    // ── Task 4: clicking Bold wraps the selection in <strong>; clicking
    //    Bold AGAIN on the (now re-selected) same content unwraps it — the
    //    toggle policy's "whole selection inside one mark of that type ->
    //    unwrap" branch ───────────────────────────────────────────────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const sel = await paragraphSelByText(page, 'Bold toggle target');
      const editEl = sel + ' > *';
      await openWysiwyg(page, sel);
      await selectWordInEl(page, editEl, 'toggle');
      await page.waitForSelector('.ed-seltb');

      await page.click('.ed-seltb-b');
      assert.strictEqual(
        await page.evaluate((s) => {
          const strong = document.querySelector(s + ' strong');
          return strong ? strong.textContent : null;
        }, editEl),
        'toggle',
        'clicking Bold must wrap the selected word in <strong>'
      );

      await page.click('.ed-seltb-b');
      assert.strictEqual(
        await page.evaluate((s) => !document.querySelector(s + ' strong'), editEl),
        true,
        'clicking Bold again on the same (now re-selected) content must unwrap it'
      );
      assert.ok(
        await page.evaluate((s) => document.querySelector(s).textContent.includes('Bold toggle target word here.'), editEl),
        'the text content must be back to plain after the round-trip toggle'
      );

      await page.keyboard.press('Escape'); // discard — never committed
      await page.close();
      console.log('sel-toolbar: Bold toggles ON then OFF on the same selection — OK');
    }

    // ── Task 4: Bold applied once, Enter to commit -> the source line
    //    gains **word**, and the re-rendered page shows <strong> ─────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const sel = await paragraphSelByText(page, 'Bold commit target');
      const editEl = sel + ' > *';
      await openWysiwyg(page, sel);
      await selectWordInEl(page, editEl, 'commit');
      await page.waitForSelector('.ed-seltb');
      await page.click('.ed-seltb-b');
      assert.strictEqual(
        await page.evaluate((s) => {
          const st = document.querySelector(s + ' strong');
          return st ? st.textContent : null;
        }, editEl),
        'commit',
        'Bold must wrap "commit" in <strong> before commit'
      );

      await page.keyboard.press('Enter'); // burst commit (Enter -> blur -> resolveBurst)
      // Enter -> blur() -> the delegated focusout handler -> switchAwayFrom()
      // is an async chain now (one more hop than Phase 2's direct commit()
      // call from the keydown handler itself) — waiting on innerHTML alone
      // is not a reliable "commit landed" signal here: applyMarkToggle()
      // already wrote <strong>commit</strong> into the LIVE (still
      // uncommitted) DOM the moment Bold was clicked, so that predicate can
      // already be true before Enter is even pressed. Wait for the ACTUAL
      // commit-completion signal (the toolbar torn down by
      // resetSelToolbarState(), which only runs once rerenderAll() has
      // actually swapped .content) instead.
      await page.waitForFunction(() => !document.querySelector('.ed-seltb'), { timeout: 5000 });
      await page.waitForFunction(
        () => document.querySelector('.content').innerHTML.includes('<strong>commit</strong>'),
        { timeout: 5000 }
      );
      assert.strictEqual(
        await page.evaluate(() => !!document.querySelector('.ed-seltb')),
        false,
        'the selection toolbar must be gone after commit'
      );

      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 300));
      const fileTextBold = fs.readFileSync(mdPath, 'utf8');
      assert.ok(/Bold \*\*commit\*\* target word here\./.test(fileTextBold),
        'sel-toolbar Bold commit: the saved source must contain **commit**, got: ' + fileTextBold);

      await page.close();
      console.log('sel-toolbar: Bold + Enter commits **word** to source and <strong> to render — OK');
    }

    // ── FIX 2: clicking S (刪除線/strikethrough) wraps the selection in
    //    <del>; clicking it AGAIN on the (now re-selected) same content
    //    unwraps it — same toggle-policy branch the Bold scenario above
    //    exercises, applied to applyMarkToggle('DEL') via closestMarkAncestor
    //    ─────────────────────────────────────────────────────────────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const sel = await paragraphSelByText(page, 'Strike toggle target');
      const editEl = sel + ' > *';
      await openWysiwyg(page, sel);
      await selectWordInEl(page, editEl, 'toggle');
      await page.waitForSelector('.ed-seltb');

      await page.click('.ed-seltb-s');
      assert.strictEqual(
        await page.evaluate((s) => {
          const del = document.querySelector(s + ' del');
          return del ? del.textContent : null;
        }, editEl),
        'toggle',
        'clicking S must wrap the selected word in <del>'
      );

      await page.click('.ed-seltb-s');
      assert.strictEqual(
        await page.evaluate((s) => !document.querySelector(s + ' del'), editEl),
        true,
        'clicking S again on the same (now re-selected) content must unwrap it'
      );
      assert.ok(
        await page.evaluate((s) => document.querySelector(s).textContent.includes('Strike toggle target word here.'), editEl),
        'the text content must be back to plain after the round-trip toggle'
      );

      await page.keyboard.press('Escape'); // discard — never committed
      await page.close();
      console.log('sel-toolbar: S (strikethrough) toggles ON then OFF on the same selection — OK');
    }

    // ── FIX 2: S applied once, Enter to commit -> the source line gains
    //    ~~word~~, and the re-rendered page shows <del> ──────────────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const sel = await paragraphSelByText(page, 'Strike commit target');
      const editEl = sel + ' > *';
      await openWysiwyg(page, sel);
      await selectWordInEl(page, editEl, 'commit');
      await page.waitForSelector('.ed-seltb');
      await page.click('.ed-seltb-s');
      assert.strictEqual(
        await page.evaluate((s) => {
          const del = document.querySelector(s + ' del');
          return del ? del.textContent : null;
        }, editEl),
        'commit',
        'S must wrap "commit" in <del> before commit'
      );

      await page.keyboard.press('Enter');
      await page.waitForFunction(() => !document.querySelector('.ed-seltb'), { timeout: 5000 });
      await page.waitForFunction(
        () => document.querySelector('.content').innerHTML.includes('<del>commit</del>'),
        { timeout: 5000 }
      );

      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 300));
      const fileTextStrike = fs.readFileSync(mdPath, 'utf8');
      assert.ok(fileTextStrike.includes('Strike ~~commit~~ target word here.'),
        'sel-toolbar S commit: the saved source must contain ~~commit~~, got: ' + fileTextStrike);

      await page.close();
      console.log('sel-toolbar: S + Enter commits ~~word~~ to source and <del> to render — OK');
    }

    // ── FIX 2: U applied once, Enter to commit -> the source line gains the
    //    literal <u>word</u>, and the re-rendered page shows an underline
    //    (marked passes raw inline <u> through untouched, by design) ─────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const sel = await paragraphSelByText(page, 'Underline commit target');
      const editEl = sel + ' > *';
      await openWysiwyg(page, sel);
      await selectWordInEl(page, editEl, 'commit');
      await page.waitForSelector('.ed-seltb');
      await page.click('.ed-seltb-u');
      assert.strictEqual(
        await page.evaluate((s) => {
          const u = document.querySelector(s + ' u');
          return u ? u.textContent : null;
        }, editEl),
        'commit',
        'U must wrap "commit" in <u> before commit'
      );

      await page.keyboard.press('Enter');
      await page.waitForFunction(() => !document.querySelector('.ed-seltb'), { timeout: 5000 });
      await page.waitForFunction(
        () => document.querySelector('.content').innerHTML.includes('<u>commit</u>'),
        { timeout: 5000 }
      );

      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 300));
      const fileTextU = fs.readFileSync(mdPath, 'utf8');
      assert.ok(fileTextU.includes('Underline <u>commit</u> target word here.'),
        'sel-toolbar U commit: the saved source must contain the literal <u>commit</u>, got: ' + fileTextU);

      await page.close();
      console.log('sel-toolbar: U + Enter commits <u>word</u> to source and renders underlined — OK');
    }

    // ── Task 4: the code button wraps the WHOLE paragraph (which contains a
    //    literal backtick) in <code>; committing must emit the
    //    double-backtick fence form the serializer uses whenever the
    //    content itself contains a backtick (see inline-md.js's
    //    serializeCode()) ───────────────────────────────────────────────
    {
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: 'networkidle0' });

      const sel = await paragraphSelByText(page, 'Backtick target');
      const editEl = sel + ' > *';
      await openWysiwyg(page, sel);

      // Fixture sanity: the literal backtick made it into the DOM as plain
      // text (an escaped \` in the source, not a real pre-existing code span).
      assert.ok(
        await page.evaluate((s) => document.querySelector(s).textContent.includes('`'), editEl),
        'fixture sanity: the paragraph must contain a literal backtick character'
      );
      assert.strictEqual(
        await page.evaluate((s) => !document.querySelector(s + ' code'), editEl),
        true,
        'fixture sanity: the backtick must be plain text, not already inside a <code> span'
      );

      await selectAllInEl(page, editEl);
      await page.waitForSelector('.ed-seltb');
      await page.click('.ed-seltb-code');
      assert.strictEqual(
        await page.evaluate((s) => !!document.querySelector(s + ' code'), editEl),
        true,
        'the code button must wrap the selection in <code>'
      );

      await page.keyboard.press('Enter');
      await page.waitForFunction((s) => !!document.querySelector(s + ' code'), {}, sel);
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 300));
      const fileTextCode = fs.readFileSync(mdPath, 'utf8');
      const expectedFence = '`` Backtick target has a ` mark inside. ``';
      assert.ok(fileTextCode.includes(expectedFence),
        'sel-toolbar code: the saved source must use the double-backtick fence form, got: ' + fileTextCode);

      await page.close();
      console.log('sel-toolbar: code button on backtick-containing text emits the double-backtick fence — OK');
    }

    // ── Task 4: the link button prompts for a URL and wraps the selection
    //    in <a href>; Enter commits it to `[text](url)` in the source.
    //    window.prompt is stubbed via evaluateOnNewDocument (installed
    //    before client.js's own script runs) rather than relying on a real
    //    dialog, which is unreliable in some headless configs ────────────
    {
      const page = await newPage(browser);
      await page.evaluateOnNewDocument(() => {
        window.prompt = () => 'https://example.org';
      });
      await page.goto(url, { waitUntil: 'networkidle0' });

      const sel = await paragraphSelByText(page, 'Link target paragraph');
      const editEl = sel + ' > *';
      await openWysiwyg(page, sel);
      await selectWordInEl(page, editEl, 'target');
      await page.waitForSelector('.ed-seltb');
      await page.click('.ed-seltb-link');
      assert.strictEqual(
        await page.evaluate((s) => {
          const a = document.querySelector(s + ' a');
          return a ? a.getAttribute('href') + '|' + a.textContent : null;
        }, editEl),
        'https://example.org|target',
        'the link button must wrap the selection in <a href> using the (stubbed) prompt result'
      );

      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () => document.querySelector('.content').innerHTML.includes('href="https://example.org"'),
        { timeout: 5000 }
      );
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 300));
      const fileTextLink = fs.readFileSync(mdPath, 'utf8');
      assert.ok(fileTextLink.includes('[target](https://example.org)'),
        'sel-toolbar link: the saved source must contain [target](https://example.org), got: ' + fileTextLink);

      await page.close();
      console.log('sel-toolbar: link button wraps selection in <a href>, commits to [text](url) — OK');
    }

    // ── Task 4: the link button on a selection fully inside an EXISTING <a>
    //    edits (new href), then — reselecting the same text and clicking
    //    again with an empty URL — clears (unwraps) it. Matches the brief:
    //    "if the selection is inside an existing link, the button
    //    edits/clears it" ──────────────────────────────────────────────
    {
      const page = await newPage(browser);
      await page.evaluateOnNewDocument(() => {
        window.__promptQueue = ['https://edited.example', ''];
        window.prompt = () => window.__promptQueue.shift();
      });
      await page.goto(url, { waitUntil: 'networkidle0' });

      const sel = await paragraphSelByText(page, 'A existing link');
      const editEl = sel + ' > *';
      await openWysiwyg(page, sel);

      assert.strictEqual(
        await page.evaluate((s) => {
          const a = document.querySelector(s + ' a');
          return a ? a.getAttribute('href') : null;
        }, editEl),
        'https://example.com',
        'fixture sanity: the paragraph must already contain an <a href="https://example.com">'
      );

      await selectWordInEl(page, editEl, 'existing link');
      await page.waitForSelector('.ed-seltb');

      // First click: the whole selection is inside the existing <a> -> the
      // prompt (pre-filled with its href) supplies a NEW url -> EDIT.
      await page.click('.ed-seltb-link');
      assert.strictEqual(
        await page.evaluate((s) => {
          const a = document.querySelector(s + ' a');
          return a ? a.getAttribute('href') : null;
        }, editEl),
        'https://edited.example',
        'the link button on a selection inside an existing link must EDIT its href'
      );

      // Re-select the same text (still inside the now-edited <a>) and click
      // again: an empty prompt result CLEARS (unwraps) the link.
      await selectWordInEl(page, editEl, 'existing link');
      await page.click('.ed-seltb-link');
      assert.strictEqual(
        await page.evaluate((s) => !document.querySelector(s + ' a'), editEl),
        true,
        'the link button with an empty URL must CLEAR (unwrap) the existing link'
      );
      assert.ok(
        await page.evaluate((s) => document.querySelector(s).textContent.includes('existing link'), editEl),
        'the link text itself must survive the clear (unwrap keeps the content)'
      );

      await page.keyboard.press('Escape');
      await page.close();
      console.log('sel-toolbar: link button on an existing link edits then clears it — OK');
    }

    // ── Task 4 regression fix (review finding): rerenderAll()'s
    //    unconditional belt-and-braces reset (activeEditor = null;
    //    dismissBar();) must ALSO cover the selection-toolbar state,
    //    including removing its document-level selectionchange listener —
    //    not just relying on cancel()/commit() to have done it. Verified two
    //    ways: (a) an instrumented count of currently-attached
    //    'selectionchange' listeners must return to 0 after a commit-
    //    triggered swap (proving the listener was actually removed, not
    //    just that the toolbar node was hidden) and go back to exactly 1 —
    //    never 2 — once a NEW session opens afterward (proving no stale
    //    listener survived to stack a duplicate); (b) no .ed-seltb node is
    //    visible immediately after the swap ─────────────────────────────
    {
      const page = await newPage(browser);
      // Instrument document.addEventListener/removeEventListener for the
      // 'selectionchange' type specifically — installed via
      // evaluateOnNewDocument so it wraps the real methods BEFORE client.js's
      // own script (which attaches the toolbar's listener) ever runs.
      await page.evaluateOnNewDocument(() => {
        window.__selCount = 0;
        const origAdd = document.addEventListener.bind(document);
        const origRemove = document.removeEventListener.bind(document);
        document.addEventListener = function (type, listener, opts) {
          if (type === 'selectionchange') window.__selCount++;
          return origAdd(type, listener, opts);
        };
        document.removeEventListener = function (type, listener, opts) {
          if (type === 'selectionchange') window.__selCount--;
          return origRemove(type, listener, opts);
        };
      });
      await page.goto(url, { waitUntil: 'networkidle0' });

      const sel = await paragraphSelByText(page, 'Rerender reset target');
      const editEl = sel + ' > *';

      await openWysiwyg(page, sel);
      assert.strictEqual(
        await page.evaluate(() => window.__selCount), 1,
        'opening a WYSIWYG session must attach exactly one selectionchange listener'
      );
      await selectWordInEl(page, editEl, 'reset');
      await page.waitForSelector('.ed-seltb');

      // Collapse the selection to the end before typing — typing over the
      // still-selected "reset" word would REPLACE it instead of appending,
      // which isn't what this scenario needs (it only needed a non-collapsed
      // selection a moment ago to prove the toolbar's listener was live).
      await page.evaluate((s) => {
        const el = document.querySelector(s);
        const r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false);
        const sl = window.getSelection();
        sl.removeAllRanges();
        sl.addRange(r);
      }, editEl);

      // Commit via plain Enter (no mark toggle needed — any text-changing
      // commit triggers the same rerenderAll() body swap this fix targets).
      await page.evaluate((s) => document.querySelector(s).focus(), editEl);
      await page.keyboard.type('-EDITED');
      await page.keyboard.press('Enter');
      // Enter -> blur() -> the delegated focusout handler -> switchAwayFrom()
      // is an async chain (see the sel-toolbar Bold+Enter scenario's comment
      // above for why an innerHTML-only wait races the actual commit) — wait
      // for __selCount to actually settle at 0 before asserting on it.
      await page.waitForFunction(() => window.__selCount === 0, { timeout: 5000 });
      await page.waitForFunction(
        () => document.querySelector('.content').innerHTML.includes('-EDITED'),
        { timeout: 5000 }
      );

      assert.strictEqual(
        await page.evaluate(() => window.__selCount), 0,
        'REVIEW FIX: rerenderAll()\'s swap must actually REMOVE the selectionchange ' +
        'listener (not just hide the toolbar node) — a leaked listener would leave this at 1'
      );
      assert.strictEqual(
        await page.evaluate(() => !document.querySelector('.ed-seltb')),
        true,
        'REVIEW FIX: no .ed-seltb must survive a commit-triggered .content swap'
      );

      // A brand-new session on the now-rerendered block must attach exactly
      // ONE more listener (not two) — proving the old session's listener
      // really was removed rather than merely being shadowed.
      // Same prefix as before (the paragraph now ends with the appended
      // "-EDITED" text, but the start is unchanged) — startsWith() still
      // correctly resolves to the post-swap block.
      const sel2 = await paragraphSelByText(page, 'Rerender reset target');
      const editEl2 = sel2 + ' > *';
      await openWysiwyg(page, sel2);
      assert.strictEqual(
        await page.evaluate(() => window.__selCount), 1,
        'REVIEW FIX: a new session after the swap must have exactly ONE selectionchange ' +
        'listener attached, never 2 (which would mean the old one leaked)'
      );
      await selectWordInEl(page, editEl2, 'reset');
      await page.waitForSelector('.ed-seltb');
      assert.strictEqual(
        await page.evaluate(() => document.querySelectorAll('.ed-seltb').length),
        1,
        'exactly one .ed-seltb node backs the (singleton, moved-not-recreated) toolbar'
      );

      await page.keyboard.press('Escape');
      assert.strictEqual(
        await page.evaluate(() => window.__selCount), 0,
        'the new session\'s own cancel() must remove its listener too'
      );

      await page.close();
      console.log('sel-toolbar regression: rerenderAll() resets toolbar state, no leaked listener — OK');
    }

    // ── Task 5 (Phase 3): table always-on WYSIWYG editing ────────────────
    // Migrated from Phase-2 Task 5's click-select-then-session model: every
    // cell of an eligible table is permanently contenteditable (class
    // 'ed-wys-cell') the moment the page renders — a click is native caret
    // placement (the delegated focusin listener starts the burst), not an
    // "open" step. click cell -> type -> Tab to next cell -> type -> blur
    // (focus leaves the TABLE) still commits the WHOLE burst as ONE
    // line-range replacement: both edits land in minimal form, and a
    // SECOND, untouched table in the same doc stays byte-identical (no
    // burst touched it -> no rewrite).
    {
      const { srv: tsrv, url: turl, mdPath: tmdPath, original: torig } = await setupTableDoc([
        '# Tables', '',
        '| Name | Note |',
        '|---|---|',
        '| Alice | hello |',
        '| Bob | world |',
        '',
        '| X | Y |',
        '|---|---|',
        '| 1 | 2 |',
        '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(turl, { waitUntil: 'networkidle0' });

        const tableCount = await page.evaluate(
          () => document.querySelectorAll('.ed-block[data-block-type="table"]').length);
        assert.strictEqual(tableCount, 2, 'fixture sanity: two table blocks');

        const table0 = await tableBlockSel(page, 0);
        // Every cell is armed BEFORE any click — sanity-check the whole
        // table's cells are already permanently contenteditable.
        assert.strictEqual(
          await page.evaluate((s) =>
            Array.from(document.querySelectorAll(s + ' th, ' + s + ' td'))
              .every((c) => c.classList.contains('ed-wys-cell') && c.getAttribute('contenteditable') === 'true'),
            table0),
          true,
          'Task 5: every cell of an eligible table must be permanently contenteditable, not just the clicked one'
        );

        await clickCellWithText(page, table0, 'Alice');
        assert.strictEqual(
          await page.evaluate(() => {
            const ae = document.activeElement;
            return !!ae && ae.classList.contains('ed-wys-cell') && ae.textContent.trim() === 'Alice';
          }),
          true,
          'clicking a cell must start the table burst with that cell focused'
        );
        await page.keyboard.type('!'); // caret placed at end -> appends

        await page.keyboard.press('Tab');
        assert.strictEqual(
          await page.evaluate(() => {
            const ae = document.activeElement;
            return ae && ae.classList.contains('ed-wys-cell') ? ae.textContent.trim() : null;
          }),
          'hello',
          'Tab must move the active cell to the next cell in row order, WITHOUT ending the burst'
        );
        await page.keyboard.type('!!');

        // Focus leaving the TABLE entirely commits the burst — Tab above,
        // by contrast, stayed inside it and must NOT have committed.
        await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
        await page.waitForFunction(
          () => document.querySelector('.content').textContent.includes('Alice!'),
          { timeout: 5000 }
        );
        assert.strictEqual(
          await page.evaluate(() => document.activeElement === document.body),
          true,
          'no cell must remain focused after the burst commits (cells stay permanently contenteditable, just not focused)'
        );

        await page.keyboard.down('Control');
        await page.keyboard.press('KeyS');
        await page.keyboard.up('Control');
        await new Promise((r) => setTimeout(r, 300));
        const fileText = fs.readFileSync(tmdPath, 'utf8');

        assert.ok(fileText.includes('| Name | Note |'), 'header row unchanged, got:\n' + fileText);
        assert.ok(fileText.includes('|---|---|'), 'unpadded separator row, got:\n' + fileText);
        assert.ok(fileText.includes('| Alice! | hello!! |'),
          'both cell edits land in ONE minimal-form row, got:\n' + fileText);
        assert.ok(fileText.includes('| Bob | world |'),
          'the untouched row of the EDITED table stays byte-identical, got:\n' + fileText);

        const table2Src = torig.split('\n').slice(7, 10).join('\n'); // '| X | Y |\n|---|---|\n| 1 | 2 |'
        assert.ok(fileText.includes(table2Src),
          'a second, untouched table in the same doc must stay byte-identical (no burst -> no rewrite), got:\n' + fileText);

        await page.close();
        console.log('table WYSIWYG: click cell -> type -> Tab -> type -> blur commits minimal form as ONE burst; other table untouched — OK');
      } finally {
        tsrv.close();
      }
    }

    // Enter inside a cell inserts a literal <br> — not a burst commit (a
    // table burst has no Enter-commits gesture at all, only leaving the
    // TABLE or Esc ends it). The caret is placed MID-TEXT (via a Range, not
    // a click) before pressing Enter — a deterministic split, unlike
    // positioning at the very end of a cell's content, where Chrome's
    // contenteditable caret-after-a-trailing-node placement is itself
    // ambiguous (the SAME reason the pre-existing Shift+Enter scenario
    // above only checks presence, not exact ordering, of its two text
    // segments). Reads via `document.activeElement`, not a `.ed-wys-cell`
    // selector — Task 5 arms EVERY cell of an eligible table permanently, so
    // a bare class selector would just find whichever cell happens to be
    // first in document order, not the one under edit.
    {
      const { srv: tsrv, url: turl, mdPath: tmdPath } = await setupTableDoc([
        '| Col |',
        '|---|',
        '| onetwo |',
        '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(turl, { waitUntil: 'networkidle0' });

        const table0 = await tableBlockSel(page, 0);
        await clickCellWithText(page, table0, 'onetwo');
        await page.evaluate(() => {
          const cell = document.activeElement;
          const textNode = cell.firstChild;
          const r = document.createRange();
          r.setStart(textNode, 3); // between "one" and "two"
          r.setEnd(textNode, 3);
          const sel2 = window.getSelection();
          sel2.removeAllRanges();
          sel2.addRange(r);
        });
        await page.keyboard.press('Enter');
        assert.strictEqual(
          await page.evaluate(() => {
            const cell = document.activeElement;
            return cell && cell.classList.contains('ed-wys-cell') ? cell.innerHTML : null;
          }),
          'one<br>two',
          'Enter must insert a <br> node splitting the cell exactly at the caret, not commit the burst'
        );
        assert.strictEqual(
          await page.evaluate(() => !!document.querySelector('textarea.ed-raw')),
          false,
          'Enter must NOT commit (no raw editor, the table burst stays open)'
        );

        await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
        await page.waitForFunction(
          () => document.querySelector('.content').innerHTML.includes('one<br>two'),
          { timeout: 5000 }
        );

        await page.keyboard.down('Control');
        await page.keyboard.press('KeyS');
        await page.keyboard.up('Control');
        await new Promise((r) => setTimeout(r, 300));
        const fileText = fs.readFileSync(tmdPath, 'utf8');
        assert.ok(fileText.includes('| one<br>two |'),
          'a cell newline must be emitted as the literal <br>, got:\n' + fileText);

        await page.close();
        console.log('table WYSIWYG: Enter in a cell emits literal <br> in the saved source — OK');
      } finally {
        tsrv.close();
      }
    }

    // Final-review Finding 1: pasting text containing a newline into a
    // table cell must NOT emit a multi-line row (a spec-forbidden orphan
    // cell line). insertTextAtCaret() now splits pasted text on newlines
    // and inserts a real <br> between segments — same mechanism as the
    // "Enter inside a cell" scenario just above, just reached via paste
    // instead of a keypress.
    {
      const { srv: tsrv, url: turl, mdPath: tmdPath } = await setupTableDoc([
        '| Col |',
        '|---|',
        '| x |',
        '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(turl, { waitUntil: 'networkidle0' });

        const table0 = await tableBlockSel(page, 0);
        await clickCellWithText(page, table0, 'x');
        await page.evaluate(() => {
          const cell = document.activeElement;
          const r = document.createRange();
          r.selectNodeContents(cell);
          r.collapse(false);
          const sel2 = window.getSelection();
          sel2.removeAllRanges();
          sel2.addRange(r);
          const dt = new DataTransfer();
          dt.setData('text/plain', 'line1\nline2');
          const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
          cell.dispatchEvent(ev);
        });

        assert.strictEqual(
          await page.evaluate(() => {
            const cell = document.activeElement;
            return cell && cell.classList.contains('ed-wys-cell') ? cell.innerHTML : null;
          }),
          'xline1<br>line2',
          'a multi-line paste must insert a real <br> between segments, not a raw newline text node'
        );

        await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
        await page.waitForFunction(
          () => document.querySelector('.content').innerHTML.includes('line1<br>line2'),
          { timeout: 5000 }
        );

        await page.keyboard.down('Control');
        await page.keyboard.press('KeyS');
        await page.keyboard.up('Control');
        await new Promise((r) => setTimeout(r, 300));
        const fileText = fs.readFileSync(tmdPath, 'utf8');
        assert.ok(fileText.includes('| xline1<br>line2 |'),
          'the pasted multi-line cell must commit as ONE physical row containing <br>, got:\n' + fileText);
        fileText.split('\n').forEach((line) => {
          if (line.trim() === '') return;
          assert.ok(!/^line2/.test(line.trim()),
            'no orphan cell-line starting with the pasted second segment, got:\n' + fileText);
        });

        await page.close();
        console.log('table WYSIWYG: pasting multi-line text into a cell commits as ONE row with <br> — OK');
      } finally {
        tsrv.close();
      }
    }

    // Esc reverts the WHOLE burst (every cell touched this burst, not just
    // the active one) — deliberately different from the paragraph editor's
    // per-block Esc. Cells stay permanently contenteditable after Esc (Task
    // 5 arms them once at load, not per-burst), so "the burst ended" is
    // checked via focus (no cell left FOCUSED), not via the 'ed-wys-cell'
    // class itself — see revertTableBurstAndEnd()'s comment in client.js.
    {
      const { srv: tsrv, url: turl, mdPath: tmdPath, original: torig } = await setupTableDoc([
        '| A | B |',
        '|---|---|',
        '| 1 | 2 |',
        '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(turl, { waitUntil: 'networkidle0' });

        const table0 = await tableBlockSel(page, 0);
        await clickCellWithText(page, table0, '1');
        await page.keyboard.type('CHANGED');
        assert.strictEqual(
          await page.evaluate(() => document.activeElement.textContent.trim()),
          '1CHANGED',
          'sanity: the cell shows the in-progress edit before Esc'
        );

        await page.keyboard.press('Escape');
        assert.strictEqual(
          await page.evaluate(() => document.activeElement === document.body),
          true,
          'Esc must end the burst (no cell left focused)'
        );
        assert.strictEqual(
          await page.evaluate(() => document.querySelector('.content').textContent.includes('CHANGED')),
          false,
          'Esc must discard the typed edit — the original cell text must be back'
        );
        assert.strictEqual(
          await page.evaluate((s) =>
            document.querySelectorAll(s + ' th, ' + s + ' td')
              .length === document.querySelectorAll(s + ' .ed-wys-cell').length,
            table0),
          true,
          'every cell must still be contenteditable after Esc — Task 5 arms the whole table once, a burst reverting is not un-arming it'
        );

        await page.keyboard.down('Control');
        await page.keyboard.press('KeyS');
        await page.keyboard.up('Control');
        await new Promise((r) => setTimeout(r, 300));
        const fileText = fs.readFileSync(tmdPath, 'utf8');
        assert.strictEqual(fileText, torig,
          'Esc must never have touched `lines` — the saved file must be byte-identical to the original, got:\n' + fileText);

        await page.close();
        console.log('table WYSIWYG: Esc mid-burst reverts the whole burst (cells stay armed); file unchanged after save — OK');
      } finally {
        tsrv.close();
      }
    }

    // Task 5 Global Constraint: a table with ANY unsupported cell degrades
    // to raw-edit at ARM time — never a half-armed table. A degraded table
    // gets NO 'ed-wys-cell'/'ed-wys-table' classes at all (armEditables()'s
    // 'table' branch never fires when canWysiwygForTable() is false), so it
    // falls straight through to the same generic "click opens in-place
    // source editor" path every other degraded block already has — no bar,
    // no extra step (this migrates the old ✎-button scenario, since ✎/the
    // bar no longer exist).
    {
      const { srv: tsrv, url: turl } = await setupTableDoc([
        '| Col |',
        '|---|',
        '| ![img](https://example.com/x.png) |',
        '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(turl, { waitUntil: 'networkidle0' });

        const table0 = await tableBlockSel(page, 0);
        assert.strictEqual(
          await page.evaluate((s) => !!document.querySelector(s + ' .ed-wys-cell'), table0),
          false,
          'an unsupported table must have NO cell armed at all'
        );

        await page.click(table0 + ' tbody td');
        await page.waitForSelector(table0 + ' textarea.ed-raw');
        const rawValue = await page.evaluate(
          (s) => document.querySelector(s + ' textarea.ed-raw').value, table0);
        assert.ok(rawValue.includes('![img](https://example.com/x.png)'),
          'a click on an unsupported table must degrade straight to raw-edit prefilled with its source, got:\n' + rawValue);

        await page.close();
        console.log('table WYSIWYG: any unsupported cell degrades the whole table to raw-edit on click, no bar step — OK');
      } finally {
        tsrv.close();
      }
    }

    // ── Task 5: hover-edge column/row insert bubbles ────────────────────
    // Migration note (see the task-5 report's migration table): the OLD
    // Phase-2 Task 6 ed-bar row/col-op buttons are RETIRED along with the
    // rest of the click-select bar (this task's Global Constraint — the
    // bar's last consumer, tables, loses its bar here). insertRow()/
    // insertColumn() get NEW UI below (hover-edge bubbles); deleteRow()/
    // deleteColumn()/cycleColumnAlign() get NO UI in this task — they stay
    // exactly as they were (verified in test/editor-client.test.js's
    // dead-code grep — the FUNCTIONS remain even though their old ed-bar
    // wiring doesn't) for T6's future edge-menus to reuse unchanged. There
    // is deliberately no test here exercising a UI trigger for those three,
    // since none exists yet; adding their edge-menu UI + tests is T6's job.

    // A degraded (unsupported-cell) table gets NO hover-insert affordance at
    // all — armEditables() never adds 'ed-wys-table' to it, and
    // updateTableInsertBubbles() gates on exactly that class.
    {
      const { srv: tsrv, url: turl } = await setupTableDoc([
        '| Col |', '|---|', '| ![img](https://example.com/x.png) |', '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(turl, { waitUntil: 'networkidle0' });

        const table0 = await tableBlockSel(page, 0);
        const { x, y } = await colBoundaryCoords(page, table0, 0);
        await page.mouse.move(x, y);
        // Give the throttled mousemove handler a couple of animation frames
        // to run, then assert the bubble never became visible (there is no
        // positive event to waitFor here — proving an ABSENCE needs a
        // fixed settle window instead of a waitForSelector).
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        assert.strictEqual(
          await page.evaluate(() => document.querySelector('.ed-tb-insert-col').hidden),
          true,
          'an unsupported table must show NO hover-insert bubble at all'
        );

        await page.close();
        console.log('table hover-insert: an unsupported table shows no insert bubble — OK');
      } finally {
        tsrv.close();
      }
    }

    // ＋: hovering a column boundary's top edge reveals the bubble; clicking
    // it inserts an empty column directly after that boundary's column, in
    // the header AND every body row — committed once focus leaves the TABLE.
    {
      const { srv: tsrv, url: turl, mdPath: tmdPath } = await setupTableDoc([
        '| A | B | C |', '|---|---|---|', '| 1 | 2 | 3 |', '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(turl, { waitUntil: 'networkidle0' });

        const table0 = await tableBlockSel(page, 0);
        await hoverAndClickColInsert(page, table0, 1); // boundary after column B (index 1)
        await page.waitForFunction(
          (s) => document.querySelector(s + ' thead th').parentElement.children.length === 4,
          {}, table0
        );
        // The insert is a burst mutation, not yet committed to `lines` —
        // leaving the table (blur) is what commits it as ONE line-range
        // replacement, same as any other table edit.
        await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });

        const fileText = await saveAndRead(page, tmdPath);
        assert.ok(fileText.includes('| A | B |  | C |'),
          'hover-insert ＋ must insert an empty header cell after the hovered column, got:\n' + fileText);
        assert.ok(fileText.includes('| 1 | 2 |  | 3 |'),
          'hover-insert ＋ must insert an empty body cell in every row at the same column, got:\n' + fileText);
        assert.ok(fileText.includes('|---|---|---|---|'),
          'hover-insert ＋ must add a 4th unaligned separator cell, got:\n' + fileText);

        await page.close();
        console.log('table hover-insert: ＋ column bubble inserts an empty column after the hovered boundary — OK');
      } finally {
        tsrv.close();
      }
    }

    // ＋: hovering a row boundary's left edge reveals the bubble; clicking it
    // inserts an empty row directly after that boundary's row (the header's
    // OWN bottom edge is boundary -1, per insertRow()'s "header counts as
    // the first boundary" contract).
    {
      const { srv: tsrv, url: turl, mdPath: tmdPath } = await setupTableDoc([
        '| A | B |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |', '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(turl, { waitUntil: 'networkidle0' });

        const table0 = await tableBlockSel(page, 0);
        await hoverAndClickRowInsert(page, table0, 0); // boundary after the FIRST body row (1 | 2)
        await page.waitForFunction(
          (s) => document.querySelector(s).querySelectorAll('tbody tr').length === 3,
          {}, table0
        );
        await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });

        const fileText = await saveAndRead(page, tmdPath);
        assert.ok(fileText.includes(
          ['| A | B |', '|---|---|', '| 1 | 2 |', '|  |  |', '| 3 | 4 |'].join('\n')),
          'hover-insert ＋ must insert an empty row directly after the hovered boundary, got:\n' + fileText);

        await page.close();
        console.log('table hover-insert: ＋ row bubble inserts an empty row after the hovered boundary — OK');
      } finally {
        tsrv.close();
      }
    }

    // Overlay clicks must NOT end the burst (Global Constraint: exclusion
    // pattern like .ed-conflict/.ed-seltb) — a hover-insert click auto-starts
    // a burst (brief: "auto-start a burst if none open") that stays OPEN
    // afterward, and Ctrl+Z on the still-focused cell reverts the insert
    // IN-BURST (client-side undo, no commit/rerender) rather than cascading
    // out to the document-level undo stack.
    {
      const { srv: tsrv, url: turl, mdPath: tmdPath, original: torig } = await setupTableDoc([
        '| A | B |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |', '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(turl, { waitUntil: 'networkidle0' });

        const table0 = await tableBlockSel(page, 0);
        assert.strictEqual(
          await page.evaluate(() => document.activeElement === document.body),
          true, 'sanity: no burst open yet (nothing focused)'
        );

        await hoverAndClickRowInsert(page, table0, 0);
        await page.waitForFunction(
          (s) => document.querySelector(s).querySelectorAll('tbody tr').length === 3,
          {}, table0
        );
        // The bubble click must have auto-started (and kept open) a table
        // burst — a cell is now focused, and no commit has happened.
        assert.strictEqual(
          await page.evaluate(() => !!document.activeElement && document.activeElement.classList.contains('ed-wys-cell')),
          true, 'a hover-insert click must auto-start a table burst (a cell must now be focused)'
        );

        await page.keyboard.down('Control');
        await page.keyboard.press('KeyZ');
        await page.keyboard.up('Control');
        await page.waitForFunction(
          (s) => document.querySelector(s).querySelectorAll('tbody tr').length === 2,
          {}, table0
        );
        // Still in-burst — undo did NOT cascade to a full commit/rerender:
        // the cell is still focused and the burst is still open.
        assert.strictEqual(
          await page.evaluate(() => !!document.activeElement && document.activeElement.classList.contains('ed-wys-cell')),
          true, 'Ctrl+Z must revert the insert IN-BURST, not commit/end the burst'
        );

        await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
        const fileText = await saveAndRead(page, tmdPath);
        assert.strictEqual(fileText, torig,
          'the reverted insert must never have reached `lines` — file must be byte-identical to the original, got:\n' + fileText);

        await page.close();
        console.log('table hover-insert: bubble click auto-starts a burst; Ctrl+Z reverts the insert in-burst — OK');
      } finally {
        tsrv.close();
      }
    }

    // ── Task 6: table edge-click menus (delete/align) + row drag-reorder ────
    // Restores the delete-row / delete-column / cycle-align capability
    // retired with the click-select ed-bar (see the Task-5 migration note
    // above) in Notion form: click a column's TOP edge (or a row's LEFT
    // edge) to select it and show a floating menu.

    // Column menu: click shows the menu (highlighted column, 刪除欄/對齊
    // buttons), 對齊 cycles left->center->right without closing the menu,
    // 刪除欄 removes the column and closes the menu, and deleting the LAST
    // remaining column is refused with a banner (column untouched).
    {
      const { srv: tsrv, url: turl, mdPath: tmdPath } = await setupTableDoc([
        '| A | B |', '|---|---|', '| 1 | 2 |', '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(turl, { waitUntil: 'networkidle0' });
        const table0 = await tableBlockSel(page, 0);

        const colB = await colGripCoords(page, table0, 1);
        await pressReleaseAt(page, colB.x, colB.y);
        await page.waitForSelector('.ed-te-menu:not([hidden])', { timeout: 3000 });
        assert.strictEqual(
          await page.evaluate(() => document.querySelector('.ed-te-menu-delete').textContent), '刪除欄',
          'the column menu\'s delete button must read 刪除欄');
        assert.strictEqual(
          await page.evaluate(() => document.querySelector('.ed-te-menu-align').hidden), false,
          'the column menu must show the 對齊 button');
        assert.strictEqual(
          await page.evaluate((s) => {
            const cells = document.querySelectorAll(s + ' thead th, ' + s + ' tbody td');
            return Array.from(cells).filter((c) => c.classList.contains('ed-te-hl'))
              .map((c) => c.textContent).sort().join(',');
          }, table0),
          '2,B',
          'clicking column B\'s top edge must highlight exactly column B\'s cells (header+body)');

        // 對齊: cycle left -> center -> right, each click keeping the menu
        // (an overlay element) open and NOT ending the burst — the menu
        // button's own mousedown preventDefault() must keep whatever cell
        // was focused (none, here) from stealing/losing focus.
        await page.click('.ed-te-menu-align');
        await page.waitForFunction(
          (s) => /text-align:\s*left/.test(document.querySelector(s + ' thead th:nth-child(2)').getAttribute('style') || ''),
          {}, table0
        );
        assert.strictEqual(
          await page.evaluate(() => document.querySelector('.ed-te-menu').hidden), false,
          'clicking 對齊 must NOT close the menu (repeated clicks keep cycling)');
        await page.click('.ed-te-menu-align');
        await page.waitForFunction(
          (s) => /text-align:\s*center/.test(document.querySelector(s + ' thead th:nth-child(2)').getAttribute('style') || ''),
          {}, table0
        );

        // 刪除欄: removes column B entirely (header + body cell) and closes
        // the menu; committed to the file once the table burst is left.
        await page.click('.ed-te-menu-delete');
        await page.waitForFunction(
          (s) => document.querySelector(s + ' thead tr').children.length === 1, {}, table0
        );
        assert.strictEqual(
          await page.evaluate(() => document.querySelector('.ed-te-menu').hidden), true,
          '刪除欄 must close the menu (its target column no longer exists)');
        await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
        const afterDelete = await saveAndRead(page, tmdPath);
        assert.strictEqual(afterDelete, ['| A |', '|---|', '| 1 |', ''].join('\n'),
          '刪除欄 must remove the column from every row, minimal form, got:\n' + afterDelete);

        // Refusal: the LAST remaining column refuses with a banner and stays.
        const colA = await colGripCoords(page, table0, 0);
        await pressReleaseAt(page, colA.x, colA.y);
        await page.waitForSelector('.ed-te-menu:not([hidden])', { timeout: 3000 });
        await page.click('.ed-te-menu-delete');
        await page.waitForSelector('.ed-conflict', { timeout: 3000 });
        assert.strictEqual(
          await page.evaluate((s) => document.querySelector(s + ' thead tr').children.length, table0), 1,
          'refusing to delete the last column must leave it in place');
        await page.close();
        console.log('table edge menus: column menu highlights/aligns/deletes; last column refuses — OK');
      } finally {
        tsrv.close();
      }
    }

    // Row menu: click shows the menu (刪除列 only, row highlighted),
    // deleting a body row removes it; the LAST body row refuses with a
    // banner. The header row is covered separately below (it never gets a
    // row grip at all, so there is no click path left to reach its old
    // refusal banner through).
    {
      const { srv: tsrv, url: turl, mdPath: tmdPath } = await setupTableDoc([
        '| A | B |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |', '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(turl, { waitUntil: 'networkidle0' });
        const table0 = await tableBlockSel(page, 0);

        const row0 = await rowGripCoords(page, table0, 0);
        await pressReleaseAt(page, row0.x, row0.y);
        await page.waitForSelector('.ed-te-menu:not([hidden])', { timeout: 3000 });
        assert.strictEqual(
          await page.evaluate(() => document.querySelector('.ed-te-menu-delete').textContent), '刪除列',
          'the row menu\'s delete button must read 刪除列');
        assert.strictEqual(
          await page.evaluate(() => document.querySelector('.ed-te-menu-align').hidden), true,
          'the row menu must NOT show the 對齊 button');
        assert.strictEqual(
          await page.evaluate((s) => document.querySelector(s + ' tbody tr:first-child').classList.contains('ed-te-hl'), table0),
          true, 'clicking row 0\'s left edge must highlight that row');

        await page.click('.ed-te-menu-delete');
        await page.waitForFunction(
          (s) => document.querySelectorAll(s + ' tbody tr').length === 1, {}, table0
        );
        await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
        const afterDelete = await saveAndRead(page, tmdPath);
        assert.strictEqual(afterDelete, ['| A | B |', '|---|---|', '| 3 | 4 |', ''].join('\n'),
          '刪除列 must remove exactly that row, got:\n' + afterDelete);

        // Refusal: the LAST body row refuses.
        const lastRow = await rowGripCoords(page, table0, 0);
        await pressReleaseAt(page, lastRow.x, lastRow.y);
        await page.waitForSelector('.ed-te-menu:not([hidden])', { timeout: 3000 });
        await page.click('.ed-te-menu-delete');
        await page.waitForSelector('.ed-conflict', { timeout: 3000 });
        assert.strictEqual(
          await page.evaluate((s) => document.querySelectorAll(s + ' tbody tr').length, table0), 1,
          'refusing to delete the last body row must leave it in place');
        await page.evaluate(() => document.querySelector('.ed-conflict button[aria-label="Dismiss"]').click());

        await page.close();
        console.log('table edge menus: row menu highlights/deletes; last-body-row refuses — OK');
      } finally {
        tsrv.close();
      }
    }

    // Grip handles: hovering a body row/column reveals an adequately-sized
    // (>=18x24px) grip; the header row (never deletable/draggable) never
    // gets a row grip at all, even while hovered.
    {
      const { srv: tsrv, url: turl } = await setupTableDoc([
        '| A | B |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |', '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(turl, { waitUntil: 'networkidle0' });
        const table0 = await tableBlockSel(page, 0);

        await hoverColumnCell(page, table0, 0);
        const colBox = await page.evaluate(() => {
          const r = document.querySelector('.ed-te-grip-col').getBoundingClientRect();
          return { width: r.width, height: r.height };
        });
        assert.ok(colBox.width >= 18 && colBox.height >= 24,
          'the column grip must be at least 18x24px, got ' + colBox.width + 'x' + colBox.height);

        await hoverBodyRowCell(page, table0, 0);
        const rowBox = await page.evaluate(() => {
          const r = document.querySelector('.ed-te-grip-row').getBoundingClientRect();
          return { width: r.width, height: r.height };
        });
        assert.ok(rowBox.width >= 18 && rowBox.height >= 24,
          'the row grip must be at least 18x24px, got ' + rowBox.width + 'x' + rowBox.height);

        // Header row: hovering it must never reveal a row grip (it isn't
        // deletable/draggable) — give the throttled mousemove/rAF handler a
        // couple of frames to settle, same "proving an absence needs a
        // settle window" idiom Task 5's own degraded-table hover-insert test
        // uses, then assert the row grip stayed hidden.
        await hoverHeaderRowCell(page, table0);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        assert.strictEqual(
          await page.evaluate(() => document.querySelector('.ed-te-grip-row').hidden), true,
          'hovering the header row must never reveal a row grip');
        // The column grip must still work over the header row's own cells
        // (columns include the header — delete/align both apply to it).
        assert.strictEqual(
          await page.evaluate(() => document.querySelector('.ed-te-grip-col').hidden), false,
          'hovering the header row must still reveal the COLUMN grip for that column');

        // Position (P0-a): row grip centerline ON the table's left border,
        // centered on its row — expectApprox(actual, expected) allows ±1px for
        // subpixel rounding. Re-hover body row 0 first (the header hover above
        // hides the row grip).
        await hoverBodyRowCell(page, table0, 0);
        const rowGripPos = await page.evaluate((ts) => {
          const table = document.querySelector(ts + ' table');
          const tableRect = table.getBoundingClientRect();
          const row = table.tBodies[0].rows[0];
          const rowRect = row.getBoundingClientRect();
          const grip = document.querySelector('.ed-te-grip-row');
          const gr = grip.getBoundingClientRect();
          return {
            gripLeft: gr.left, gripTop: gr.top,
            expectedLeft: tableRect.left - gr.width / 2,
            expectedTop: rowRect.top + rowRect.height / 2 - gr.height / 2,
          };
        }, table0);
        expectApprox(rowGripPos.gripLeft, rowGripPos.expectedLeft, 'row grip left (centerline on table left border)');
        expectApprox(rowGripPos.gripTop, rowGripPos.expectedTop, 'row grip top (centered on row)');

        // Position (P0-a): col grip centerline ON the table's top border,
        // centered on its column.
        await hoverColumnCell(page, table0, 0);
        const colGripPos = await page.evaluate((ts) => {
          const table = document.querySelector(ts + ' table');
          const tableRect = table.getBoundingClientRect();
          const cell = table.tHead.rows[0].cells[0];
          const cellRect = cell.getBoundingClientRect();
          const grip = document.querySelector('.ed-te-grip-col');
          const gc = grip.getBoundingClientRect();
          return {
            gripLeft: gc.left, gripTop: gc.top,
            expectedLeft: cellRect.left + cellRect.width / 2 - gc.width / 2,
            expectedTop: tableRect.top - gc.height / 2,
          };
        }, table0);
        expectApprox(colGripPos.gripLeft, colGripPos.expectedLeft, 'col grip left (centered on column)');
        expectApprox(colGripPos.gripTop, colGripPos.expectedTop, 'col grip top (centerline on table top border)');

        await page.close();
        console.log('table grip handles: adequately sized (>=18x24px); header row shows no row grip; border-centred position — OK');
      } finally {
        tsrv.close();
      }
    }

    // Review fix (Important): a click aimed at the hover-insert ＋ bubble must
    // NOT be silently eaten by the row/col grip at the same location.
    //
    // ORIGINAL BUG (TE_GRIP_GAP_PX=4): the grip and bubble had intersecting
    // hit rects at this corner; the grip's higher z-index (9 vs the bubble's
    // 8) swallowed the click. The old fix (TE_GRIP_GAP_PX=14) separated the
    // rects by moving the grips 14px outside the table — but that 14px gap
    // conflicted with the upcoming left-gutter chrome (P0-a).
    //
    // NEW MECHANISM (P0-a border-centred geometry): both grips now sit ON the
    // table border (their centerline coincides with the table edge), so their
    // hit rects DO overlap the bubble's hit rect — separated rects are no
    // longer guaranteed and the old !rectsIntersect() assertion would FAIL.
    // The invariant "insert-bubble click is never eaten by the grip" is now
    // maintained by z-index ordering alone: .ed-te-grip-row/.ed-te-grip-col
    // get z-index:7 (below the bubble's z-index:8), so even though the rects
    // overlap, the browser's hit-test gives the click to the BUBBLE, not the
    // grip.
    //
    // This scenario still reproduces the EXACT reported overlap corners (same
    // coordinates as before), but now asserts the invariant via the browser's
    // own stacking order rather than a rect-separation check, which is
    // strictly stronger evidence. The console.log reflects the new mechanism.
    {
      const { srv: tsrv, url: turl } = await setupTableDoc([
        '| A | B |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |', '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(turl, { waitUntil: 'networkidle0' });
        const table0 = await tableBlockSel(page, 0);

        const rowCorner = await page.evaluate((ts) => {
          const table = document.querySelector(ts + ' table');
          const tableRect = table.getBoundingClientRect();
          // Same boundary Y client.js's own updateTableInsertBubbles() uses
          // for "insert after the header" (afterRowIndex: -1): the HEADER
          // row's own bottom edge, not row 0's top (kept as two separate
          // reads rather than assumed-equal, in case thead/tbody ever grow
          // a border/spacing gap between them).
          const boundaryY = table.tHead.rows[0].getBoundingClientRect().bottom;
          return { x: tableRect.left + 3, y: boundaryY + 3 };
        }, table0);
        await page.mouse.move(rowCorner.x, rowCorner.y);
        await page.waitForSelector('.ed-te-grip-row:not([hidden])', { timeout: 3000 });
        await page.waitForSelector('.ed-tb-insert-row:not([hidden])', { timeout: 3000 });
        // Assert the bubble wins the browser hit-test at the exact corner
        // (strictly stronger than a rect-separation check: the browser itself
        // is the arbiter of which element receives the click).
        const rowHitResult = await page.evaluate((cx, cy) => {
          const el = document.elementFromPoint(cx, cy);
          const bubble = document.querySelector('.ed-tb-insert-row');
          const grip = document.querySelector('.ed-te-grip-row');
          const hitsBubble = el === bubble || (bubble && bubble.contains(el));
          return {
            hitsBubble,
            hitsGrip: el === grip || (grip && grip.contains(el)),
            tagName: el ? el.tagName : null,
            className: el ? el.className : null,
            bubbleZ: bubble ? getComputedStyle(bubble).zIndex : null,
            gripZ: grip ? getComputedStyle(grip).zIndex : null,
          };
        }, rowCorner.x, rowCorner.y);
        console.log('row corner hit-test:', JSON.stringify(rowHitResult));
        assert.ok(rowHitResult.hitsBubble,
          'elementFromPoint at the row overlap corner must resolve to the insert bubble, not the grip — ' +
          'got tagName=' + rowHitResult.tagName + ' className=' + rowHitResult.className);
        assert.ok(
          parseInt(rowHitResult.bubbleZ, 10) > parseInt(rowHitResult.gripZ, 10),
          'row insert bubble z-index (' + rowHitResult.bubbleZ + ') must be numerically greater than ' +
          'row grip z-index (' + rowHitResult.gripZ + ')');

        const colCorner = await page.evaluate((ts) => {
          const table = document.querySelector(ts + ' table');
          const tableRect = table.getBoundingClientRect();
          // Same boundary X client.js's own updateTableInsertBubbles() uses
          // for "insert after column 0": that header cell's own right edge.
          const boundaryX = table.tHead.rows[0].cells[0].getBoundingClientRect().right;
          return { x: boundaryX + 3, y: tableRect.top + 3 };
        }, table0);
        await page.mouse.move(colCorner.x, colCorner.y);
        await page.waitForSelector('.ed-te-grip-col:not([hidden])', { timeout: 3000 });
        await page.waitForSelector('.ed-tb-insert-col:not([hidden])', { timeout: 3000 });
        // Same bubble-wins-hit-test assertion for the column pair.
        const colHitResult = await page.evaluate((cx, cy) => {
          const el = document.elementFromPoint(cx, cy);
          const bubble = document.querySelector('.ed-tb-insert-col');
          const grip = document.querySelector('.ed-te-grip-col');
          const hitsBubble = el === bubble || (bubble && bubble.contains(el));
          return {
            hitsBubble,
            hitsGrip: el === grip || (grip && grip.contains(el)),
            tagName: el ? el.tagName : null,
            className: el ? el.className : null,
            bubbleZ: bubble ? getComputedStyle(bubble).zIndex : null,
            gripZ: grip ? getComputedStyle(grip).zIndex : null,
          };
        }, colCorner.x, colCorner.y);
        console.log('col corner hit-test:', JSON.stringify(colHitResult));
        assert.ok(colHitResult.hitsBubble,
          'elementFromPoint at the col overlap corner must resolve to the insert bubble, not the grip — ' +
          'got tagName=' + colHitResult.tagName + ' className=' + colHitResult.className);
        assert.ok(
          parseInt(colHitResult.bubbleZ, 10) > parseInt(colHitResult.gripZ, 10),
          'col insert bubble z-index (' + colHitResult.bubbleZ + ') must be numerically greater than ' +
          'col grip z-index (' + colHitResult.gripZ + ')');

        await page.close();
        console.log('table grip/bubble click priority: bubble wins hit-test at the overlap corner (z-index ordering) — OK');
      } finally {
        tsrv.close();
      }
    }

    // Grip reachability by a REAL (non-teleporting) pointer: the grips now
    // sit ON the table border (P0-a border-centred geometry), straddling it
    // by ~10px on each side. A pointer travelling from inside a cell toward
    // the grip crosses the ~10px corridor OUTSIDE the table (the grip's own
    // left/top half) on the way there. The original updateTableEdgeGrips()
    // hid the grip the instant `target` left the table/cell, before the
    // pointer ever reached the grip itself, so a human moving the mouse
    // (rather than teleport-clicking, as every OTHER scenario in this file
    // does via pressReleaseAt/gripCenter) could never actually arrive at it.
    // travelPointer() above drives a genuine multi-step mousemove sequence,
    // settling client.js's rAF-throttled hit-test once per intermediate
    // point, to actually exercise the corridor crossing.
    {
      const { srv: tsrv, url: turl } = await setupTableDoc([
        '| A | B |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |', '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(turl, { waitUntil: 'networkidle0' });
        const table0 = await tableBlockSel(page, 0);

        // Row grip: start just INSIDE the table's own left edge (5px in, at
        // row 0's vertical center) rather than at the cell's geometric
        // center — a plain 2-column test table stretches to fill the whole
        // content width (each cell hundreds of px wide), so starting from
        // the cell's center and interpolating in only 5-10 steps toward the
        // grip would stride clean OVER the narrow (~10px) corridor without
        // ever sampling a point inside it, silently passing on a table this
        // wide regardless of the bug. Starting right at the boundary the
        // pointer is about to cross keeps the whole travelled distance
        // commensurate with the corridor itself, so every step actually
        // samples it — matching how a real user would approach the edge.
        const rowEdgeStart = await page.evaluate((ts) => {
          const table = document.querySelector(ts + ' table');
          const tableRect = table.getBoundingClientRect();
          const row = table.tBodies[0].rows[0];
          const r = row.getBoundingClientRect();
          return { x: tableRect.left + 5, y: r.top + r.height / 2 };
        }, table0);
        await page.mouse.move(rowEdgeStart.x, rowEdgeStart.y);
        await page.waitForSelector('.ed-te-grip-row:not([hidden])', { timeout: 3000 });
        const rowGripTarget = await gripCenter(page, '.ed-te-grip-row');
        await travelPointer(page, rowEdgeStart, rowGripTarget, 8);
        assert.strictEqual(
          await page.evaluate(() => document.querySelector('.ed-te-grip-row').hidden), false,
          'the row grip must still be visible once a REAL travelling pointer reaches it across the ' +
          'hover corridor (a teleporting click would never catch this)');

        // Column grip: same shape, starting just inside the table's own top
        // edge (5px down, at column 0's horizontal center) and travelling
        // up to the column grip's own on-screen center.
        const colEdgeStart = await page.evaluate((ts) => {
          const table = document.querySelector(ts + ' table');
          const tableRect = table.getBoundingClientRect();
          const th = table.tHead.rows[0].cells[0];
          const r = th.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: tableRect.top + 5 };
        }, table0);
        await page.mouse.move(colEdgeStart.x, colEdgeStart.y);
        await page.waitForSelector('.ed-te-grip-col:not([hidden])', { timeout: 3000 });
        const colGripTarget = await gripCenter(page, '.ed-te-grip-col');
        await travelPointer(page, colEdgeStart, colGripTarget, 8);
        assert.strictEqual(
          await page.evaluate(() => document.querySelector('.ed-te-grip-col').hidden), false,
          'the column grip must still be visible once a REAL travelling pointer reaches it across the ' +
          'hover corridor (a teleporting click would never catch this)');

        // The click-priority guarantee (bubble wins browser hit-test at the
        // overlap corner, enforced by z-index ordering rather than rect
        // separation) is unaffected by this fix — only the grip's
        // VISIBILITY-persistence logic changed, never its position/z-index
        // — and stays covered by the dedicated scenario immediately above
        // this one.

        await page.close();
        console.log('table grips: survive a REAL pointer travelling across the hover corridor — OK');
      } finally {
        tsrv.close();
      }
    }

    // Review fix (Important): the FIRST version of the corridor fix above
    // was over-permissive — it kept a grip visible anywhere within the
    // table's expanded rect, along the table's FULL height/width, not just
    // near the row/column the grip is actually anchored to. On a tall
    // table, hovering row 1 then moving the pointer to the left margin at
    // the LAST row's height (far below row 1's own grip) used to keep row
    // 1's grip visible at its now-stale position instead of hiding it
    // (reviewer live-reproduced). pointInRowGripZone()/pointInColGripZone()
    // fix this by gating the keep-zone on the specific shown grip's own
    // anchor row/column extent — this is that repro turned into a permanent
    // regression test: a genuine exit (same corridor x, unrelated row's
    // height) must still hide the grip.
    {
      const rows10 = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
      const { srv: tsrv, url: turl } = await setupTableDoc([
        '| A |', '|---|', ...rows10.map((n) => '| ' + n + ' |'), '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(turl, { waitUntil: 'networkidle0' });
        const table0 = await tableBlockSel(page, 0);

        // Hover row 1 (body index 0) to arm its row grip.
        await hoverBodyRowCell(page, table0, 0);
        assert.strictEqual(
          await page.evaluate(() => document.querySelector('.ed-te-grip-row').hidden), false,
          'fixture sanity: hovering row 1 must arm the row grip');

        // Move to the SAME corridor x (just left of the table, where the
        // grip lives) but at the LAST row's (body index 9) vertical
        // center — far from row 1's own grip, a genuine exit, not travel
        // toward it.
        const target = await page.evaluate((ts) => {
          const table = document.querySelector(ts + ' table');
          const tableRect = table.getBoundingClientRect();
          const lastRow = table.tBodies[0].rows[9];
          const r = lastRow.getBoundingClientRect();
          return { x: tableRect.left - 5, y: r.top + r.height / 2 };
        }, table0);
        await page.mouse.move(target.x, target.y);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

        assert.strictEqual(
          await page.evaluate(() => document.querySelector('.ed-te-grip-row').hidden), true,
          'moving to the left margin at a DIFFERENT row\'s height must hide row 1\'s grip, ' +
          'not keep it visible at its stale position');

        await page.close();
        console.log('table grips: hover corridor is anchored to its own row, not the whole table — OK');
      } finally {
        tsrv.close();
      }
    }

    // Row drag-reorder: press-and-drag from the LAST body row's left edge to
    // ABOVE the first body row -> a drop indicator tracks the pointer, and
    // dropping reorders the actual <tr> (never a clone) once committed.
    {
      const { srv: tsrv, url: turl, mdPath: tmdPath, original: torig } = await setupTableDoc([
        '| A |', '|---|', '| 1 |', '| 2 |', '| 3 |', '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(turl, { waitUntil: 'networkidle0' });
        const table0 = await tableBlockSel(page, 0);

        const from = await rowGripCoords(page, table0, 2); // row "3"
        const to = await rowBoundaryCoords(page, table0, -1); // boundary just above row "1"
        await dragRowTo(page, from, to);
        await page.waitForFunction(
          (s) => Array.from(document.querySelectorAll(s + ' tbody td')).map((c) => c.textContent).join(',') === '3,1,2',
          {}, table0
        );
        // The drag must have auto-started (and kept open) a table burst.
        assert.strictEqual(
          await page.evaluate(() => !!document.activeElement && document.activeElement.classList.contains('ed-wys-cell')),
          true, 'a row drop must auto-start a table burst (a cell must now be focused)'
        );

        // Ctrl+Z mid-burst reverts the drag IN-BURST (no commit/rerender —
        // same "revert without ending the burst" contract Task 5's own
        // insert-bubble Ctrl+Z scenario asserts).
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyZ');
        await page.keyboard.up('Control');
        await page.waitForFunction(
          (s) => Array.from(document.querySelectorAll(s + ' tbody td')).map((c) => c.textContent).join(',') === '1,2,3',
          {}, table0
        );
        assert.strictEqual(
          await page.evaluate(() => !!document.activeElement && document.activeElement.classList.contains('ed-wys-cell')),
          true, 'Ctrl+Z must revert the drag IN-BURST, not commit/end the burst'
        );
        await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
        const afterUndo = await saveAndRead(page, tmdPath);
        assert.strictEqual(afterUndo, torig,
          'the reverted drag must never have reached the file — byte-identical to the original, got:\n' + afterUndo);

        await page.close();
        console.log('table row drag: drop reorders the row; Ctrl+Z reverts it in-burst — OK');
      } finally {
        tsrv.close();
      }
    }

    // Row drag lands on disk once actually committed (no undo this time),
    // and Esc DURING a drag cancels it with NO mutation at all — distinct
    // from Esc-reverts-burst (which this must NOT trigger: the previously-
    // focused surface, if any, is untouched, and the row never moves).
    {
      const { srv: tsrv, url: turl, mdPath: tmdPath, original: torig } = await setupTableDoc([
        '| A |', '|---|', '| 1 |', '| 2 |', '| 3 |', '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(turl, { waitUntil: 'networkidle0' });
        const table0 = await tableBlockSel(page, 0);

        const from = await rowGripCoords(page, table0, 2);
        const to = await rowBoundaryCoords(page, table0, -1);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 8 }); // cross the drag threshold, mid-drag
        await page.waitForSelector('.ed-te-drop-indicator:not([hidden])', { timeout: 3000 });
        await page.keyboard.press('Escape');
        await page.mouse.up(); // the drag state is already gone — this must be an inert no-op
        await new Promise((r) => setTimeout(r, 150));
        assert.strictEqual(
          await page.evaluate((s) => Array.from(document.querySelectorAll(s + ' tbody td')).map((c) => c.textContent).join(','), table0),
          '1,2,3', 'Esc during a drag must cancel it with NO row reorder at all'
        );
        assert.strictEqual(
          await page.evaluate(() => document.querySelector('.ed-te-drop-indicator').hidden), true,
          'Esc during a drag must hide the drop indicator'
        );
        assert.strictEqual(
          await page.evaluate(() => document.querySelector('.ed-te-grip-row').classList.contains('ed-te-grip-dragging')),
          false, 'Esc during a drag must strip the row grip\'s "dragging" visual too'
        );
        const fileText = await saveAndRead(page, tmdPath);
        assert.strictEqual(fileText, torig, 'a cancelled drag must never touch the file, got:\n' + fileText);

        await page.close();
        console.log('table row drag: Esc mid-drag cancels with no mutation — OK');
      } finally {
        tsrv.close();
      }
    }

    // Review fix (Important): the hover-insert bubbles' and grips' own
    // (independent) throttled mousemove listener must not repaint itself on
    // top of the drop indicator during an active drag — a drag that starts
    // at the row grip (outside the table) and moves across cells/boundaries
    // inside it passes right through the exact hover positions that would
    // otherwise trigger the ＋ bubbles and the column grip, so without the
    // drag gate (see the mousemove listener's `tePointer.dragging` branch
    // near the bottom of client.js) this reliably reproduces on any real
    // drag from the row grip.
    {
      const { srv: tsrv, url: turl, mdPath: tmdPath } = await setupTableDoc([
        '| A |', '|---|', '| 1 |', '| 2 |', '| 3 |', '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(turl, { waitUntil: 'networkidle0' });
        const table0 = await tableBlockSel(page, 0);

        const from = await rowGripCoords(page, table0, 2);
        const to = await rowBoundaryCoords(page, table0, -1);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 8 }); // cross the drag threshold, mid-drag
        await page.waitForSelector('.ed-te-drop-indicator:not([hidden])', { timeout: 3000 });
        // Give the throttled mousemove/rAF handler a couple of frames to
        // run — same "proving an absence needs a settle window" idiom
        // Task 5's own degraded-table hover-insert test uses.
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        assert.strictEqual(
          await page.evaluate(() => document.querySelector('.ed-tb-insert-row').hidden), true,
          'the hover-insert row bubble must stay hidden while a real drag is in flight'
        );
        assert.strictEqual(
          await page.evaluate(() => document.querySelector('.ed-tb-insert-col').hidden), true,
          'the hover-insert column bubble must stay hidden while a real drag is in flight'
        );
        // Same reasoning applies to the column GRIP (it isn't meaningful
        // mid row-drag); the ROW grip is the opposite — it must stay
        // visible and switch to its "dragging" visual, since it IS the
        // handle the user is holding (brief: "the active grip may stay as
        // the drag handle visual").
        assert.strictEqual(
          await page.evaluate(() => document.querySelector('.ed-te-grip-col').hidden), true,
          'the column grip must stay hidden while a real row drag is in flight'
        );
        assert.strictEqual(
          await page.evaluate(() => document.querySelector('.ed-te-grip-row').hidden), false,
          'the row grip (the active drag handle) must stay visible during its own drag'
        );
        assert.strictEqual(
          await page.evaluate(() => document.querySelector('.ed-te-grip-row').classList.contains('ed-te-grip-dragging')),
          true, 'the row grip must wear its "dragging" visual while its own drag is in flight'
        );

        await page.mouse.up();
        await page.waitForFunction(
          (s) => Array.from(document.querySelectorAll(s + ' tbody td')).map((c) => c.textContent).join(',') === '3,1,2',
          {}, table0
        );
        assert.strictEqual(
          await page.evaluate(() => document.querySelector('.ed-te-grip-row').classList.contains('ed-te-grip-dragging')),
          false, 'the row grip must drop its "dragging" visual once the drag ends'
        );
        await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
        const fileText = await saveAndRead(page, tmdPath);
        assert.strictEqual(fileText, ['| A |', '|---|', '| 3 |', '| 1 |', '| 2 |', ''].join('\n'),
          'the drag must still commit normally after the mid-drag bubble check, got:\n' + fileText);

        await page.close();
        console.log('table row drag: hover-insert bubbles + grips hide/switch correctly during an active drag — OK');
      } finally {
        tsrv.close();
      }
    }

    // Review fix (Critical): a pointercancel (the browser/OS aborting the
    // gesture — palm rejection, the captured element being removed, ...)
    // must clean up exactly like Esc-during-drag: row un-dimmed, indicator
    // hidden, NO mutation — and, critically, the NEXT drag must still work
    // cleanly afterward. The original bug: with no pointercancel/blur
    // handling and no setPointerCapture(), a gesture that never delivered a
    // real pointerup (release over browser chrome / the window edge) left
    // `tePointer` latched forever — the dragged row stuck dimmed, the
    // indicator frozen, and the NEXT pointerdown overwriting `tePointer`
    // without ever cleaning up the old row/indicator.
    {
      const { srv: tsrv, url: turl, mdPath: tmdPath } = await setupTableDoc([
        '| A |', '|---|', '| 1 |', '| 2 |', '| 3 |', '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(turl, { waitUntil: 'networkidle0' });
        const table0 = await tableBlockSel(page, 0);

        const from = await rowGripCoords(page, table0, 2); // row "3"
        const to = await rowBoundaryCoords(page, table0, -1);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 8 });
        await page.waitForSelector('.ed-te-drop-indicator:not([hidden])', { timeout: 3000 });
        assert.strictEqual(
          await page.evaluate((s) => document.querySelector(s + ' tbody tr:nth-child(3)').classList.contains('ed-te-row-dragging'), table0),
          true, 'sanity: the dragged row must be dimmed while the drag is in flight'
        );

        // Simulate the browser/OS aborting the gesture — dispatched
        // directly (Puppeteer has no API to trigger a REAL OS-level
        // cancellation), but this exercises the exact same document-level
        // listener client.js wires for a genuine pointercancel.
        await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true })));
        // The real mouse button release now arrives AFTER the cancel —
        // must be a fully inert no-op (tePointer is already null).
        await page.mouse.up();

        assert.strictEqual(
          await page.evaluate((s) => document.querySelector(s + ' tbody tr:nth-child(3)').classList.contains('ed-te-row-dragging'), table0),
          false, 'pointercancel must un-dim the dragged row'
        );
        assert.strictEqual(
          await page.evaluate(() => document.querySelector('.ed-te-grip-row').classList.contains('ed-te-grip-dragging')),
          false, 'pointercancel must strip the row grip\'s "dragging" visual too'
        );
        assert.strictEqual(
          await page.evaluate(() => document.querySelector('.ed-te-drop-indicator').hidden), true,
          'pointercancel must hide the drop indicator'
        );
        assert.strictEqual(
          await page.evaluate((s) => Array.from(document.querySelectorAll(s + ' tbody td')).map((c) => c.textContent).join(','), table0),
          '1,2,3', 'pointercancel must apply NO mutation at all — the row must not have moved'
        );

        // The next drag must still work cleanly — the original latch bug
        // left this permanently broken (the overwritten `tePointer` piled
        // state on top of the still-dimmed, never-cleaned-up prior row).
        const from2 = await rowGripCoords(page, table0, 0); // row "1"
        const to2 = await rowBoundaryCoords(page, table0, 2); // boundary after the last body row
        await dragRowTo(page, from2, to2);
        await page.waitForFunction(
          (s) => Array.from(document.querySelectorAll(s + ' tbody td')).map((c) => c.textContent).join(',') === '2,3,1',
          {}, table0
        );

        await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
        const fileText = await saveAndRead(page, tmdPath);
        assert.strictEqual(fileText, ['| A |', '|---|', '| 2 |', '| 3 |', '| 1 |', ''].join('\n'),
          'the drag AFTER a pointercancel must commit normally, got:\n' + fileText);

        await page.close();
        console.log('table row drag: pointercancel mid-drag cleans up fully; the next drag still works — OK');
      } finally {
        tsrv.close();
      }
    }

    // ── Task 7: one end-to-end flow — open a doc, type in a paragraph, bold
    //    a word via the selection toolbar, edit a table cell, Ctrl+S — all
    //    three edits land on disk, and the saved file matches the ORIGINAL
    //    doc with ONLY those two lines (paragraph, Alice's row) replaced —
    //    a full-string reconstruction + assert.strictEqual (review fix: a
    //    prior version used .includes() substring checks for "untouched",
    //    which cannot catch reordering, dropped/inserted blank lines, or
    //    block-boundary drift across this multi-edit chain; only a
    //    reconstructed full-string comparison actually proves that). Own
    //    isolated doc (setupTableDoc() is generic — not table-only despite
    //    its name), same reasoning as every other table scenario above.
    {
      const { srv: tsrv, url: turl, mdPath: tmdPath, original: torig } = await setupTableDoc([
        '# E2E Doc', '',
        'Type target paragraph text here.', '',
        '| Name | Note |',
        '|---|---|',
        '| Alice | hello |',
        '| Bob | world |', '',
        'Untouched paragraph should stay identical.', '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(turl, { waitUntil: 'networkidle0' });

        // 1) type in the paragraph — append text via the WYSIWYG editor
        // (caret starts at the end, per openWysiwygEditor()'s placeCaretAtEnd()).
        const paraSel = await paragraphSelByText(page, 'Type target paragraph');
        const paraEditEl = paraSel + ' > *';
        await openWysiwyg(page, paraSel);
        await page.keyboard.type(' EXTRA');

        // 2) bold a word via the floating selection toolbar.
        await selectWordInEl(page, paraEditEl, 'target');
        await page.waitForSelector('.ed-seltb');
        await page.click('.ed-seltb-b');
        assert.strictEqual(
          await page.evaluate((s) => {
            const st = document.querySelector(s + ' strong');
            return st ? st.textContent : null;
          }, paraEditEl),
          'target',
          'e2e: Bold via the toolbar must wrap the selected word in <strong>'
        );

        // Commit the paragraph session (plain Enter — mousedown preventDefault
        // on the toolbar button kept focus/selection on paraEditEl).
        await page.keyboard.press('Enter');
        await page.waitForFunction(
          () => document.querySelector('.content').innerHTML.includes('<strong>target</strong>'),
          { timeout: 5000 }
        );

        // 3) edit a table cell.
        const table0 = await tableBlockSel(page, 0);
        await clickCellWithText(page, table0, 'Alice');
        await page.keyboard.type('!');
        await page.evaluate(() => { document.activeElement && document.activeElement.blur(); }); // focus leaving the TABLE commits the burst
        await page.waitForFunction(
          () => document.querySelector('.content').textContent.includes('Alice!'),
          { timeout: 5000 }
        );

        // 4) Ctrl+S.
        const fileText = await saveAndRead(page, tmdPath);

        // Full-string reconstruction (review fix): the original doc's lines
        // with ONLY the two edited lines (paragraph at index 2, Alice's row
        // at index 6 — see the setupTableDoc() array above) replaced by
        // their expected post-edit content. assert.strictEqual on the whole
        // joined text implicitly checks line COUNT (no dropped/inserted
        // blank lines) and every untouched line byte-for-byte (no
        // reordering, no block-boundary drift) — a substring .includes()
        // check cannot prove either of those.
        const expectedLines = torig.split('\n');
        assert.strictEqual(expectedLines[2], 'Type target paragraph text here.',
          'sanity: expected-lines index 2 must be the paragraph line');
        assert.strictEqual(expectedLines[6], '| Alice | hello |',
          'sanity: expected-lines index 6 must be Alice\'s row');
        expectedLines[2] = 'Type **target** paragraph text here. EXTRA';
        expectedLines[6] = '| Alice! | hello |';
        const expectedFull = expectedLines.join('\n');

        assert.strictEqual(fileText, expectedFull,
          'e2e: the saved file must equal the original doc with ONLY the paragraph and table-cell ' +
          'edits applied — every other line (including blank-line spacing) byte-identical, got:\n' + fileText);

        await page.close();
        console.log('e2e: type paragraph + bold via toolbar + edit table cell + Ctrl+S — OK');
      } finally {
        tsrv.close();
      }
    }

    // ── Phase 3 Task 4: list WYSIWYG editing (Enter split / Tab indent /
    //    Shift+Tab outdent / empty-Enter removes) ──────────────────────────
    // Each scenario below gets its own isolated setupListDoc() server/doc,
    // same isolation reasoning as the Phase-2 Task 5/6 table scenarios above
    // (undo-stack / save state must never leak between scenarios).

    // Typing inside one li then blurring commits the WHOLE run but changes
    // only the edited item's line — every other line (including the second,
    // untouched list block) stays byte-identical. Per-li burst: opens on the
    // FIRST li of list 0, types ' EDIT', blurs, verifies file.
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath, original: lorig } =
        await setupListDoc([
          '# List doc', '',
          '- Alpha item', '- Bravo item', '- Charlie item', '',
          // A DIFFERENT bullet marker ('*' vs '-') so CommonMark parses this
          // as a genuinely SEPARATE second list block — same marker with
          // just a blank line between would still merge into ONE (loose)
          // list token, which would defeat the "untouched sibling list"
          // half of this scenario.
          '* Second one', '* Second two', '',
        ]);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });
        const list0 = await listBlockSel(page, 0);

        // Open burst on the first li of list 0 (Alpha item) and type.
        await openWysiwyg(page, list0);
        await page.keyboard.type(' EDIT');

        // Blur by direct JS blur — commits the li burst.
        await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
        await page.waitForFunction(
          () => document.querySelector('.content').textContent.includes('Alpha item EDIT'),
          { timeout: 5000 }
        );

        const fileText = await saveAndRead(page, lmdPath);
        const expectedLines = lorig.split('\n');
        assert.strictEqual(expectedLines[2], '- Alpha item', 'sanity: line 2 is Alpha\'s line');
        expectedLines[2] = '- Alpha item EDIT';
        assert.strictEqual(fileText, expectedLines.join('\n'),
          'typing inside one li then blurring must change ONLY that item\'s line — every other ' +
          'line (including the whole second, untouched list) must stay byte-identical, got:\n' + fileText);

        await page.close();
        console.log('list WYSIWYG: type in item -> blur -> only that line changes, sibling list untouched — OK');
      } finally {
        lsrv.close();
      }
    }

    // Caret hop li→li with no edit commits nothing (no-op guard): the
    // unchanged-innerHTML check fires and no commit reaches the file.
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath, original: lorig } =
        await setupListDoc(['# List doc', '', '- Alpha item', '- Bravo item', '']);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });

        const alphaLi = await listBlockSel(page, 0);
        await openWysiwyg(page, alphaLi);

        // Click Bravo item (different li in the same run) without typing —
        // switchAwayFrom() sees unchanged innerHTML and no-ops.
        const bravoSel = await page.evaluate(() => {
          const lis = document.querySelectorAll('li.ed-block[data-block-type="li"]');
          for (let i = 0; i < lis.length; i++) {
            if (lis[i].textContent.includes('Bravo item')) {
              return 'li.ed-block[data-block-id="' + lis[i].getAttribute('data-block-id') + '"]';
            }
          }
          return null;
        });
        assert.ok(bravoSel, 'Bravo item li not found');
        await openWysiwyg(page, bravoSel);
        await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });

        const fileText = await saveAndRead(page, lmdPath);
        assert.strictEqual(fileText, lorig,
          'caret hop li→li with no edit must commit nothing — file must be byte-identical, got:\n' +
          fileText);

        await page.close();
        console.log('list WYSIWYG: caret hop li→li with no edit commits nothing (no-op guard) — OK');
      } finally {
        lsrv.close();
      }
    }

    // ── Task 8: Notion key semantics (spec §4 / §11 rows 1, 3, 5, 6, 7, 8) ──
    // Row 1: Enter splits the current item into a new sibling at the caret.
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath, original: lorig } =
        await setupListDoc([
          '# List doc', '',
          '- Split target text', '- Bravo item', '- Charlie item', '',
        ]);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });
        const list0 = await listBlockSel(page, 0);

        await openWysiwyg(page, list0);
        // Caret right after "Split" (before " target text").
        await placeCaretInListText(page, list0, 'Split', false);
        await page.keyboard.press('Enter');
        // Enter must NOT end the burst — it's a structural mutation inside
        // the SAME sustained editing session (only empty-Enter ends it).
        assert.strictEqual(
          await page.evaluate((s) => {
            // Per-li: check that ANY li in the same run still has its .ed-li-text focused
            const li = document.querySelector(s);
            const root = li && li.parentElement;
            return root && root.contains(document.activeElement) &&
              document.activeElement.classList.contains('ed-li-text');
          }, list0),
          true,
          'Enter (non-empty item) must keep the burst open, not commit/blur it'
        );
        await page.waitForFunction(
          (s) => {
            // Per-li: count li.ed-block elements within the same parent UL/OL
            const li = document.querySelector(s);
            return li && li.parentElement &&
              li.parentElement.querySelectorAll('li.ed-block').length === 4;
          }, {}, list0
        );

        // Blur (click the heading) to commit, then save.
        const heading = '.ed-block[data-block-type="heading"]';
        await page.click(heading + ' > *');
        await page.waitForFunction(
          () => document.querySelector('.content').innerHTML.includes('target text'),
          { timeout: 5000 }
        );
        await page.keyboard.press('Escape'); // end the heading's own (unmodified) burst

        const fileText = await saveAndRead(page, lmdPath);
        const expectedLines = lorig.split('\n');
        assert.strictEqual(expectedLines[2], '- Split target text', 'sanity: line 2 is the split target');
        expectedLines.splice(2, 1, '- Split', '- target text');
        assert.strictEqual(fileText, expectedLines.join('\n'),
          'Enter must split the item at the caret into two sibling lines, got:\n' + fileText);

        await page.close();
        console.log('list WYSIWYG: Enter splits item into a new sibling at the caret — OK');
      } finally {
        lsrv.close();
      }
    }

    // Tab indents the item as a child of its previous sibling — the
    // indent is the ACCUMULATED width of the parent's own marker ("- " is 2
    // columns), matching list-md.js's documented indent ruling.
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath, original: lorig } =
        await setupListDoc([
          '# List doc', '',
          '- Alpha item', '- Bravo item', '- Charlie item', '',
        ]);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });
        const list0 = await listBlockSel(page, 0);

        await openWysiwyg(page, list0);
        await placeCaretInListText(page, list0, 'Bravo item', true);
        await page.keyboard.press('Tab');
        // Task 8: wait for the COMMITTED structure. data-indent is written by
        // blockmap.js from the markdown, so requiring "1" here means the run's
        // line-range replace and its re-render have both landed. Waiting on the
        // bare DOM shape instead would be satisfied by the pre-commit LOCAL
        // mutation, and the very next page.click() would then race the commit's
        // .content swap ("Node is detached from document").
        await page.waitForFunction(
          (s) => {
            // Per-li: count top-level items in the run's parent UL/OL
            const li = document.querySelector(s);
            if (!li || !li.parentElement) return false;
            const topItems = li.parentElement.querySelectorAll(':scope > li.ed-block');
            const nested = topItems[0] && topItems[0].querySelector('li.ed-block');
            return topItems.length === 2 && !!nested &&
              nested.getAttribute('data-indent') === '1' &&
              nested.textContent.trim() === 'Bravo item';
          }, {}, list0
        );

        const heading = '.ed-block[data-block-type="heading"]';
        await page.click(heading + ' > *');
        await page.keyboard.press('Escape');

        const fileText = await saveAndRead(page, lmdPath);
        const expectedLines = lorig.split('\n');
        assert.strictEqual(expectedLines[3], '- Bravo item', 'sanity: line 3 is Bravo\'s line');
        expectedLines[3] = '  - Bravo item';
        assert.strictEqual(fileText, expectedLines.join('\n'),
          'Tab must indent the item as a child of the previous sibling, 2-space (marker-width) indent, got:\n' + fileText);

        await page.close();
        console.log('list WYSIWYG: Tab indents item as child of previous sibling (2-space) — OK');
      } finally {
        lsrv.close();
      }
    }

    // Row 7: Tab with NO previous sibling is a no-op (first item can't indent).
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath, original: lorig } =
        await setupListDoc([
          '# List doc', '',
          '- Alpha item', '- Bravo item', '',
        ]);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });
        const list0 = await listBlockSel(page, 0);

        await openWysiwyg(page, list0);
        await placeCaretInListText(page, list0, 'Alpha item', true);
        await page.keyboard.press('Tab');
        // Give any (incorrect) mutation a moment to land before asserting
        // the DOM is unchanged.
        await new Promise((r) => setTimeout(r, 150));
        assert.strictEqual(
          await page.evaluate((s) => {
            // Per-li: count li.ed-block in the run's parent UL/OL
            const li = document.querySelector(s);
            return li && li.parentElement ? li.parentElement.querySelectorAll('li.ed-block').length : 0;
          }, list0),
          2,
          'Tab on the first item (no previous sibling) must be a no-op — item count unchanged'
        );

        const heading = '.ed-block[data-block-type="heading"]';
        await page.click(heading + ' > *');
        await page.keyboard.press('Escape');

        const fileText = await saveAndRead(page, lmdPath);
        assert.strictEqual(fileText, lorig,
          'Tab no-op on the first item must leave the file byte-identical, got:\n' + fileText);

        await page.close();
        console.log('list WYSIWYG: Tab on first item (no previous sibling) is a no-op — OK');
      } finally {
        lsrv.close();
      }
    }

    // Shift+Tab outdents a nested item to sit right after its parent. NOTE
    // (Task 8): this fixture's nested item has NO following same-level
    // sibling, so the Notion adoption rule (row 6) is not exercised here —
    // see the dedicated "Shift+Tab adoption" scenario further below for it.
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath, original: lorig } =
        await setupListDoc([
          '# List doc', '',
          '- Alpha item', '  - Bravo item', '- Charlie item', '',
        ]);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });
        const list0 = await listBlockSel(page, 0);

        // sanity: Bravo starts out nested under Alpha.
        assert.strictEqual(
          await page.evaluate((s) => {
            // Per-li: 2 top-level items in the run, first item has a nested li.ed-block
            const li = document.querySelector(s);
            if (!li || !li.parentElement) return false;
            const topItems = li.parentElement.querySelectorAll(':scope > li.ed-block');
            return topItems.length === 2 && !!topItems[0].querySelector('li.ed-block');
          }, list0),
          true,
          'sanity: Bravo must start out nested under Alpha'
        );

        await openWysiwyg(page, list0);
        await placeCaretInListText(page, list0, 'Bravo item', true);
        await page.keyboard.down('Shift');
        await page.keyboard.press('Tab');
        await page.keyboard.up('Shift');
        // Task 8: data-indent === '0' on all three is what proves the run's
        // line-range replace COMMITTED and re-rendered (the pre-commit local
        // mutation already produces three top-level <li>s, and clicking during
        // that window races the .content swap).
        await page.waitForFunction(
          (s) => {
            // Per-li: 3 flat items after Shift+Tab outdents Bravo
            const li = document.querySelector(s);
            if (!li || !li.parentElement) return false;
            const topItems = li.parentElement.querySelectorAll(':scope > li.ed-block');
            return topItems.length === 3 && Array.prototype.every.call(topItems,
              (t) => t.getAttribute('data-indent') === '0');
          }, {}, list0
        );

        const heading = '.ed-block[data-block-type="heading"]';
        await page.click(heading + ' > *');
        await page.keyboard.press('Escape');

        const fileText = await saveAndRead(page, lmdPath);
        const expectedLines = lorig.split('\n');
        assert.strictEqual(expectedLines[3], '  - Bravo item', 'sanity: line 3 is the nested Bravo line');
        expectedLines[3] = '- Bravo item';
        assert.strictEqual(fileText, expectedLines.join('\n'),
          'Shift+Tab must outdent the item to sit right after its former parent, flush left, got:\n' + fileText);

        await page.close();
        console.log('list WYSIWYG: Shift+Tab outdents nested item after its parent — OK');
      } finally {
        lsrv.close();
      }
    }

    // Row 8: Shift+Tab at TOP LEVEL is a no-op.
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath, original: lorig } =
        await setupListDoc([
          '# List doc', '',
          '- Alpha item', '- Bravo item', '',
        ]);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });
        const list0 = await listBlockSel(page, 0);

        await openWysiwyg(page, list0);
        await placeCaretInListText(page, list0, 'Bravo item', true);
        await page.keyboard.down('Shift');
        await page.keyboard.press('Tab');
        await page.keyboard.up('Shift');
        await new Promise((r) => setTimeout(r, 150));
        assert.strictEqual(
          await page.evaluate((s) => {
            // Per-li: count li.ed-block in the run's parent UL/OL
            const li = document.querySelector(s);
            return li && li.parentElement ? li.parentElement.querySelectorAll('li.ed-block').length : 0;
          }, list0),
          2,
          'Shift+Tab at top level must be a no-op — item count unchanged'
        );

        const heading = '.ed-block[data-block-type="heading"]';
        await page.click(heading + ' > *');
        await page.keyboard.press('Escape');

        const fileText = await saveAndRead(page, lmdPath);
        assert.strictEqual(fileText, lorig,
          'Shift+Tab no-op at top level must leave the file byte-identical, got:\n' + fileText);

        await page.close();
        console.log('list WYSIWYG: Shift+Tab at top level is a no-op — OK');
      } finally {
        lsrv.close();
      }
    }

    // Row 3 (top-level press): Enter on an EMPTY top-level item removes it
    // AND ends the burst (commits). Spec §4 converts the block to a
    // paragraph; markdown cannot persist an empty paragraph, so the existing
    // §10 pristine-insert machinery supplies a self-removing provisional
    // paragraph — abandoning it (here: never typing into it before Ctrl+S)
    // leaves the file byte-identical to "the li was just deleted", which is
    // exactly what this scenario asserts. See the dedicated row-3 scenario
    // below for the two-press outdent-then-paragraph flow and its undo
    // granularity.
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath, original: lorig } =
        await setupListDoc([
          '# List doc', '',
          '- Alpha item', '- Delete me', '- Charlie item', '',
        ]);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });
        const list0 = await listBlockSel(page, 0);

        await openWysiwyg(page, list0);
        await emptyListItemText(page, list0, 'Delete me');
        await page.keyboard.press('Enter');
        // Enter-on-empty ends the burst itself (no separate blur needed).
        await page.waitForFunction(
          (s) => document.activeElement !== document.querySelector(s + ' > *'),
          {}, list0
        );
        await page.waitForFunction(
          () => !document.querySelector('.content').textContent.includes('Delete me'),
          { timeout: 5000 }
        );
        // Task 8: the top-level press ALSO hands the user a focused provisional
        // paragraph (spec §4's "converts to a paragraph") — a second commit
        // that lands strictly after the removal's own re-render. Wait for it to
        // be established before saving, so this scenario measures the settled
        // state instead of racing the second half of the flow (a Ctrl+S that
        // arrives in between would persist the paragraph's placeholder line,
        // because resolveBurst() has not had a chance to recognise the insert
        // as abandoned yet).
        await page.waitForFunction(
          () => !!document.activeElement && !!document.activeElement.closest &&
            !!document.activeElement.closest('.ed-block[data-block-type="paragraph"]'),
          { timeout: 5000 }
        );

        const fileText = await saveAndRead(page, lmdPath);
        const expectedLines = lorig.split('\n').filter((l) => l !== '- Delete me');
        assert.strictEqual(fileText, expectedLines.join('\n'),
          'Enter on an empty item must remove it and commit, got:\n' + fileText);

        await page.close();
        console.log('list WYSIWYG: Enter on empty item removes it and commits (ends burst) — OK');
      } finally {
        lsrv.close();
      }
    }

    // ONE Ctrl+Z reverts a Tab-indent completely (single-undo granularity).
    //
    // TASK-8 CORRECTION (documented deviation from this body's pre-migration
    // assertions): before Task 8, Tab was a burst-LOCAL DOM mutation whose
    // commit was deferred to focusout, so this scenario asserted
    // `renderRequestCount === 0` ("no server round trip") and "the burst
    // stays open". Spec §3 makes a structural change a line-range replace of
    // the whole run, and the Task-8 plan spells the pipeline out as
    // serialize run → commitRangeEdit → rerenderAll → focusBlockAtLine — i.e.
    // Tab COMMITS immediately (it must: the same pipeline is what turns the
    // provisional <li> an Enter-split creates into a real, armed, id-bearing
    // block). A committing key cannot also be a zero-round-trip local edit,
    // so those two assertions were inverted against the shipped design. The
    // VALUE this scenario carries — "one Ctrl+Z puts the list back exactly
    // how it was" — is preserved and in fact strengthened: the file is now
    // asserted byte-identical after the undo, which the old in-burst version
    // could not check at all (nothing had reached `lines`).
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath, original: lorig } =
        await setupListDoc([
          '# List doc', '',
          '- Alpha item', '- Bravo item', '- Charlie item', '',
        ]);
      try {
        const page = await newPage(browser);
        let renderRequestCount = 0;
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          if (req.method() === 'POST' && req.url().endsWith('/api/render')) renderRequestCount++;
          req.continue();
        });
        await page.goto(lurl, { waitUntil: 'networkidle0' });
        const list0 = await listBlockSel(page, 0);

        await openWysiwyg(page, list0);
        await placeCaretInListText(page, list0, 'Bravo item', true);
        const rendersBeforeTab = renderRequestCount;
        await page.keyboard.press('Tab');
        // The COMMITTED structure (server-rendered): Bravo is a nested
        // li.ed-block — i.e. it carries a server-assigned data-block-id and
        // data-indent="1", which only a real /api/render round trip produces.
        await page.waitForFunction(
          (s) => {
            const li = document.querySelector(s);
            if (!li || !li.parentElement) return false;
            const topItems = li.parentElement.querySelectorAll(':scope > li.ed-block');
            if (topItems.length !== 2) return false;
            const nested = topItems[0].querySelector('li.ed-block');
            return !!nested && nested.getAttribute('data-indent') === '1' &&
              nested.textContent.trim() === 'Bravo item';
          }, {}, list0
        );
        assert.ok(renderRequestCount > rendersBeforeTab,
          'Tab must COMMIT the structural change (spec §3: one line-range replace of the run), ' +
          'which necessarily round-trips /api/render');

        await page.keyboard.down('Control');
        await page.keyboard.press('KeyZ');
        await page.keyboard.up('Control');
        await page.waitForFunction(
          (s) => {
            // 3 flat items again after ONE Ctrl+Z reverts the whole Tab-indent
            const li = document.querySelector(s);
            if (!li || !li.parentElement) return false;
            const topItems = li.parentElement.querySelectorAll(':scope > li.ed-block');
            return topItems.length === 3 && !topItems[0].querySelector('li.ed-block');
          }, {}, list0
        );

        const fileText = await saveAndRead(page, lmdPath);
        assert.strictEqual(fileText, lorig,
          'ONE Ctrl+Z after a Tab-indent must restore the pre-key lines exactly — a structural key is ' +
          'a SINGLE undo op, got:\n' + fileText);

        await page.close();
        console.log('list WYSIWYG: ONE Ctrl+Z reverts a Tab-indent completely (single undo op) — OK');
      } finally {
        lsrv.close();
      }
    }

    // ── Task 8 rows 1 / 5 / 6 / 3: the DISTINGUISHING cases ────────────────
    // The migrated bodies above cover the shapes where the old (pre-Task-8)
    // rules and the Notion rules happen to agree. These four scenarios use
    // the spec's own fixtures, where they DISAGREE, so they are what actually
    // pins row 1 (caret/focus target), row 5 (Tab moves the subtree, later
    // siblings untouched), row 6 (Shift+Tab adopts the former following
    // siblings) and row 3 (empty-li Enter = outdent per press, then paragraph).

    // Row 1: '- ab' with the caret between 'a' and 'b' -> ['- a', '- b'],
    // focus on the NEW block (run startLine + 1) with the caret at its start;
    // ONE Ctrl+Z restores the pre-key line.
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath, original: lorig } =
        await setupListDoc(['# List doc', '', '- ab', '']);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });
        const list0 = await listBlockSel(page, 0);

        await openWysiwyg(page, list0);
        await placeCaretInListText(page, list0, 'a', false); // caret between a|b
        await page.keyboard.press('Enter');
        // Both halves must be REAL blocks (server-assigned data-block-id) —
        // the provisional <li> the split creates only becomes one via the
        // structural commit + re-render.
        await page.waitForFunction(
          (s) => {
            const li = document.querySelector(s);
            if (!li || !li.parentElement) return false;
            const items = li.parentElement.querySelectorAll(':scope > li.ed-block');
            return items.length === 2 &&
              items[0].textContent.trim() === 'a' && items[1].textContent.trim() === 'b';
          }, {}, list0
        );

        // Focus target: the SECOND li of the run — the run starts at line 3
        // and the serializer emits exactly one line per li in document order,
        // so that li is line 4 = range.startLine + indexOfNewLiInRun.
        const newLiSel = await liBlockSelByText(page, 'b');
        assert.strictEqual(
          await page.evaluate((s) => document.activeElement === document.querySelector(s + ' > .ed-li-text'), newLiSel),
          true,
          'Enter must focus the NEW block (the tail half), not the original li'
        );
        assert.strictEqual(await caretIsAtStartOf(page, newLiSel + ' > .ed-li-text'), true,
          'the caret must sit at the START of the new block (spec §11 row 1)');

        const fileText = await saveAndRead(page, lmdPath);
        assert.strictEqual(fileText, '# List doc\n\n- a\n- b\n',
          'Enter mid-text must split the item at the caret into two sibling lines, got:\n' +
          JSON.stringify(fileText));

        // ONE Ctrl+Z restores the pre-key lines. The Ctrl+S above resolved
        // (and thereby ENDED) the burst focusBlockAtLine had re-opened, so
        // re-arm one first — a keystroke with no burst open is not ours.
        await reopenWysiwyg(page, newLiSel);
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyZ');
        await page.keyboard.up('Control');
        await page.waitForFunction(
          () => document.querySelectorAll('li.ed-block').length === 1, { timeout: 5000 });
        const undoneText = await saveAndRead(page, lmdPath);
        assert.strictEqual(undoneText, lorig,
          'ONE Ctrl+Z after an Enter-split must restore the pre-key lines exactly, got:\n' +
          JSON.stringify(undoneText));

        await page.close();
        console.log('list WYSIWYG (row 1): Enter splits at the caret, focus+caret on the new block, ' +
          'one undo op — OK');
      } finally {
        lsrv.close();
      }
    }

    // Row 5: Tab indents the caret item AND its whole subtree; the following
    // same-level sibling ('- c') is untouched.
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath, original: lorig } =
        await setupListDoc([
          '# List doc', '',
          '- a', '- b', '  - b1', '  - b2', '- c', '',
        ]);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });
        const list0 = await listBlockSel(page, 0);

        assert.strictEqual(await runShapeOf(page, list0), '0:a | 0:b | 1:b1 | 1:b2 | 0:c',
          'sanity: the fixture must start as a / b(+b1,b2) / c');

        await openWysiwyg(page, list0);
        await placeCaretInListText(page, list0, 'b', true); // caret in 'b' (start)
        await page.keyboard.press('Tab');
        await page.waitForFunction(
          () => document.querySelectorAll('li.ed-block[data-indent="2"]').length === 2,
          { timeout: 5000 }
        );
        assert.strictEqual(await runShapeOf(page, list0), '0:a | 1:b | 2:b1 | 2:b2 | 0:c',
          'Tab must indent the caret item AND its whole subtree, leaving later siblings alone');

        const fileText = await saveAndRead(page, lmdPath);
        assert.strictEqual(fileText, '# List doc\n\n- a\n  - b\n    - b1\n    - b2\n- c\n',
          'row 5: Tab must move b + its subtree one level in (accumulated marker-width indent) and ' +
          'leave c untouched, got:\n' + JSON.stringify(fileText));

        await reopenWysiwyg(page, await liBlockSelByText(page, 'b'));
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyZ');
        await page.keyboard.up('Control');
        await page.waitForFunction(
          () => document.querySelectorAll('li.ed-block[data-indent="2"]').length === 0,
          { timeout: 5000 }
        );
        const undoneText = await saveAndRead(page, lmdPath);
        assert.strictEqual(undoneText, lorig,
          'ONE Ctrl+Z after a Tab must restore the pre-key lines exactly, got:\n' +
          JSON.stringify(undoneText));

        await page.close();
        console.log('list WYSIWYG (row 5): Tab moves the item + its subtree only, one undo op — OK');
      } finally {
        lsrv.close();
      }
    }

    // Row 6: Shift+Tab on 'b1' raises it one level AND ADOPTS its former
    // following same-level sibling 'b2' as its child (Notion's asymmetric
    // outdent — b2's own visual indent is unchanged, which is what makes it
    // look right). This is the case the migrated Shift+Tab body above cannot
    // express (its nested item has no following sibling), and the one that
    // replaces the old "siblings stay" rule.
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath, original: lorig } =
        await setupListDoc([
          '# List doc', '',
          '- a', '- b', '  - b1', '  - b2', '- c', '',
        ]);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });
        const list0 = await listBlockSel(page, 0);

        await openWysiwyg(page, list0);
        await placeCaretInListText(page, list0, 'b1', true);
        await page.keyboard.down('Shift');
        await page.keyboard.press('Tab');
        await page.keyboard.up('Shift');
        await page.waitForFunction(
          () => document.querySelectorAll('li.ed-block').length === 5 &&
            document.querySelectorAll('li.ed-block[data-indent="0"]').length === 4,
          { timeout: 5000 }
        );
        assert.strictEqual(await runShapeOf(page, list0), '0:a | 0:b | 0:b1 | 1:b2 | 0:c',
          'row 6: b1 must rise one level and b2 (its former following same-level sibling) must ' +
          'become b1\'s child');

        const fileText = await saveAndRead(page, lmdPath);
        assert.strictEqual(fileText, '# List doc\n\n- a\n- b\n- b1\n  - b2\n- c\n',
          'row 6: Shift+Tab must emit b1 at top level with b2 adopted underneath it (b2\'s own ' +
          'indent column unchanged), got:\n' + JSON.stringify(fileText));

        await reopenWysiwyg(page, await liBlockSelByText(page, 'b1'));
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyZ');
        await page.keyboard.up('Control');
        await page.waitForFunction(
          () => document.querySelectorAll('li.ed-block[data-indent="0"]').length === 3,
          { timeout: 5000 }
        );
        const undoneText = await saveAndRead(page, lmdPath);
        assert.strictEqual(undoneText, lorig,
          'ONE Ctrl+Z after a Shift+Tab must restore the pre-key lines exactly, got:\n' +
          JSON.stringify(undoneText));

        await page.close();
        console.log('list WYSIWYG (row 6): Shift+Tab raises the item and adopts its former following ' +
          'siblings, one undo op — OK');
      } finally {
        lsrv.close();
      }
    }

    // Row 3: an EMPTY li + Enter outdents ONE level per press; at top level
    // the next press converts the block to a paragraph. Markdown cannot
    // persist an empty paragraph, so the top-level press reuses the existing
    // §10 pristine-insert flow: the user gets a focused provisional paragraph
    // that self-removes if abandoned, and becomes a real paragraph as soon as
    // anything is typed into it.
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath } =
        await setupListDoc(['# List doc', '', '- alpha', '  - nested item', '']);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });
        const list0 = await listBlockSel(page, 0);
        const nestedSel = await liBlockSelByText(page, 'nested item');

        await openWysiwyg(page, nestedSel);
        await emptyListItemText(page, list0, 'nested item');

        // Press 1 — nested empty li: outdent one level, still a li. The
        // committed markdown is proven by the SERVER-rendered data-indent.
        await page.keyboard.press('Enter');
        await page.waitForFunction(
          () => document.querySelectorAll('li.ed-block[data-indent="0"]').length === 2,
          { timeout: 5000 }
        );
        assert.strictEqual(await runShapeOf(page, list0), '0:alpha | 0:',
          'row 3 press 1: the empty nested li must outdent one level and STAY a li (spec §4)');

        // Press 2 — now top level: the li becomes a paragraph. No Ctrl+S in
        // between: Ctrl+S resolves (and ends) the burst focusBlockAtLine
        // re-opened, after which Enter would no longer be ours.
        await page.keyboard.press('Enter');
        await page.waitForFunction(
          () => document.querySelectorAll('li.ed-block').length === 1 &&
            document.querySelectorAll('.ed-block[data-block-type="paragraph"]').length === 1,
          { timeout: 5000 }
        );
        assert.strictEqual(
          await page.evaluate(() => {
            const ae = document.activeElement;
            const blockEl = ae && ae.closest && ae.closest('.ed-block');
            return !!blockEl && blockEl.getAttribute('data-block-type') === 'paragraph';
          }),
          true,
          'row 3 press 2 (top level): the user must end up in a focused provisional PARAGRAPH block'
        );

        // Typing into it makes it real; blur commits it.
        await page.keyboard.type('PARA');
        await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
        await page.waitForFunction(
          () => document.querySelector('.content').textContent.includes('PARA'), { timeout: 5000 });
        const fileText = await saveAndRead(page, lmdPath);
        assert.strictEqual(fileText, '# List doc\n\n- alpha\n\nPARA\n',
          'row 3: two Enter presses must leave the list with only "alpha" and a real paragraph where ' +
          'the emptied item was, got:\n' + JSON.stringify(fileText));

        await page.close();
        console.log('list WYSIWYG (row 3): empty-li Enter outdents per press, then converts to a ' +
          'paragraph — OK');
      } finally {
        lsrv.close();
      }
    }

    // Row 3, top-level press — UNDO GRANULARITY (RULING F-J).
    // Every other structural key is ONE undo op. This press is not: markdown
    // cannot hold an empty paragraph, so it is li-removal (commit #1) followed
    // by the §10 pristine paragraph insert (commit #2). The repo's existing
    // pristine machinery makes an ABANDONED insert cost zero NET undo ops
    // (UndoStack.discardTop(), see "abandoned inserts (all 5 kinds)
    // auto-remove" and "Ctrl+Z on a pristine insert removes ONLY the insert"
    // above), so the OBSERVED granularity — asserted below rather than forced
    // — is: Ctrl+Z #1 removes the provisional paragraph and pushes nothing;
    // Ctrl+Z #2 is the first one that touches the stack, and it reverts the
    // li removal. Two presses to get back to the pre-key lines.
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath, original: lorig } =
        await setupListDoc(['# List doc', '', '- alpha', '- beta', '']);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });
        const list0 = await listBlockSel(page, 0);

        await openWysiwyg(page, list0);
        await emptyListItemText(page, list0, 'beta');
        await page.keyboard.press('Enter');
        await page.waitForFunction(
          () => document.querySelectorAll('li.ed-block').length === 1 &&
            document.querySelectorAll('.ed-block[data-block-type="paragraph"]').length === 1,
          { timeout: 5000 }
        );

        // Ctrl+Z #1: the provisional paragraph is still untouched, so this is
        // the pristine auto-remove — the li removal is NOT reverted with it.
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyZ');
        await page.keyboard.up('Control');
        await page.waitForFunction(
          () => document.querySelectorAll('.ed-block[data-block-type="paragraph"]').length === 0,
          { timeout: 5000 }
        );
        assert.strictEqual(await runShapeOf(page, list0), '0:alpha',
          'Ctrl+Z #1 must remove ONLY the provisional paragraph — the li removal stays applied');

        // Ctrl+Z #2: the first press that pops the undo stack — the emptied
        // li comes back.
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyZ');
        await page.keyboard.up('Control');
        await page.waitForFunction(
          () => document.querySelectorAll('li.ed-block').length === 2, { timeout: 5000 });
        // The emptying itself was an UNCOMMITTED burst edit (nothing had
        // reached `lines` before Enter), and the removal's undo op restores the
        // run's ON-DISK "before" — so 'beta' comes back with its text, not as
        // an empty item. That is the correct single-op inverse of the commit
        // that was actually made.
        assert.strictEqual(await runShapeOf(page, list0), '0:alpha | 0:beta',
          'Ctrl+Z #2 must revert the li removal — the run returns to its last committed state');

        const fileText = await saveAndRead(page, lmdPath);
        assert.strictEqual(fileText, lorig,
          'after both undos the file must be byte-identical to the original, got:\n' +
          JSON.stringify(fileText));

        await page.close();
        console.log('list WYSIWYG (row 3 / F-J): top-level empty-Enter granularity = pristine-insert ' +
          'auto-remove + ONE stack op — OK');
      } finally {
        lsrv.close();
      }
    }

    // Row 3's OUTDENT press is bound by RULING F-J's single-undo rule (only the
    // TOP-LEVEL press is exempt): ONE Ctrl+Z must restore the pre-key lines.
    // The emptying itself was an uncommitted burst edit, so "pre-key lines" is
    // the original file.
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath, original: lorig } =
        await setupListDoc(['# List doc', '', '- alpha', '  - nested item', '']);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });
        const list0 = await listBlockSel(page, 0);

        await openWysiwyg(page, await liBlockSelByText(page, 'nested item'));
        await emptyListItemText(page, list0, 'nested item');
        await page.keyboard.press('Enter');
        await page.waitForFunction(
          () => document.querySelectorAll('li.ed-block[data-indent="0"]').length === 2,
          { timeout: 5000 }
        );
        assert.strictEqual(await runShapeOf(page, list0), '0:alpha | 0:',
          'sanity: the outdent press committed');

        // The burst focusBlockAtLine re-opened is still live, so this Ctrl+Z is
        // ours: burst-local history is at its bottom, so it cascades to the
        // document-level undo and pops the outdent's single op.
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyZ');
        await page.keyboard.up('Control');
        await page.waitForFunction(
          () => document.querySelectorAll('li.ed-block[data-indent="1"]').length === 1,
          { timeout: 5000 }
        );
        assert.strictEqual(await runShapeOf(page, list0), '0:alpha | 1:nested item',
          'ONE Ctrl+Z must put the nested item back exactly where it was');
        const undoneText = await saveAndRead(page, lmdPath);
        assert.strictEqual(undoneText, lorig,
          'ONE Ctrl+Z after row 3\'s outdent press must restore the pre-key lines exactly (F-J binds ' +
          'this press, unlike the top-level one), got:\n' + JSON.stringify(undoneText));

        await page.close();
        console.log('list WYSIWYG (row 3 / F-J): the OUTDENT press is a single undo op — OK');
      } finally {
        lsrv.close();
      }
    }

    // RULING F-Q, both halves. Spec §11 row 3 says "empty indented li + Enter =
    // outdent one level per press" with NO carve-out for an item that owns a
    // sublist: the subtree travels with the item, so nothing is orphaned.
    // (Before F-Q this fell through to the row-1 SPLIT and produced two empty
    // items with the subtree re-parented under the second.) The top-level →
    // paragraph step is the one case that still refuses, because a paragraph
    // cannot own list children.
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath } =
        await setupListDoc(['# List doc', '', '- a', '  - b', '    - x', '']);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });
        const list0 = await listBlockSel(page, 0);
        assert.strictEqual(await runShapeOf(page, list0), '0:a | 1:b | 2:x',
          'sanity: the fixture must start as a > b > x');

        await openWysiwyg(page, await liBlockSelByText(page, 'b'));
        await emptyListItemText(page, list0, 'b');

        // Half A: empty li that OWNS a sublist, at data-indent > 0 -> outdents,
        // subtree in tow.
        await page.keyboard.press('Enter');
        await page.waitForFunction(
          () => document.querySelectorAll('li.ed-block[data-indent="0"]').length === 2,
          { timeout: 5000 }
        );
        assert.strictEqual(await runShapeOf(page, list0), '0:a | 0: | 1:x',
          'F-Q half A: an EMPTY item that owns a sublist must outdent like any other empty item, ' +
          'carrying its subtree — not split into two empty items');
        const afterOutdent = await saveAndRead(page, lmdPath);
        assert.strictEqual(afterOutdent, '# List doc\n\n- a\n-\n  - x\n',
          'F-Q half A: file bytes after the outdent, got:\n' + JSON.stringify(afterOutdent));

        // Half B: the same item is now EMPTY, TOP-LEVEL and still owns a
        // sublist -> the paragraph step must refuse (complete no-op).
        await reopenWysiwyg(page, await liBlockSelByText(page, ''));
        await page.keyboard.press('Enter');
        await new Promise((r) => setTimeout(r, 250)); // let any (incorrect) commit land
        assert.strictEqual(await runShapeOf(page, list0), '0:a | 0: | 1:x',
          'F-Q half B: converting an empty TOP-LEVEL item that owns a sublist to a paragraph would ' +
          'orphan its children, so the press must be a complete no-op');
        assert.strictEqual(
          await page.evaluate(() =>
            document.querySelectorAll('.ed-block[data-block-type="paragraph"]').length),
          0,
          'F-Q half B: no provisional paragraph may be inserted for the refused press'
        );
        const afterRefusal = await saveAndRead(page, lmdPath);
        assert.strictEqual(afterRefusal, afterOutdent,
          'F-Q half B: the refused press must leave the file byte-identical, got:\n' +
          JSON.stringify(afterRefusal));

        await page.close();
        console.log('list WYSIWYG (row 3 / F-Q): empty item owning a sublist outdents; at top level ' +
          'the paragraph step refuses — OK');
      } finally {
        lsrv.close();
      }
    }

    // Row 6 adoption must not RETYPE the adopted items. `b1` already owns an
    // ORDERED sublist, and `b2` is a bullet: appending b2 into b1's <ol> would
    // emit it as '2. b2' — a marker change to an item the user never touched.
    // The adopted followers go into a type-MATCHED sublist (created if b1 has
    // none), which list-md.js emits as a second nested list of that item.
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath, original: lorig } =
        await setupListDoc([
          '# List doc', '',
          '- b', '  - b1', '    1. x', '  - b2', '',
        ]);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });
        const list0 = await listBlockSel(page, 0);
        assert.strictEqual(await runShapeOf(page, list0), '0:b | 1:b1 | 2:x | 1:b2',
          'sanity: the fixture must start as b > (b1 > ol:x, b2)');

        await openWysiwyg(page, await liBlockSelByText(page, 'b1'));
        await page.keyboard.down('Shift');
        await page.keyboard.press('Tab');
        await page.keyboard.up('Shift');
        await page.waitForFunction(
          () => document.querySelectorAll('li.ed-block[data-indent="0"]').length === 2,
          { timeout: 5000 }
        );
        assert.strictEqual(await runShapeOf(page, list0), '0:b | 0:b1 | 1:x | 1:b2',
          'b1 rises one level; x stays its child and b2 is adopted as a child too');
        assert.strictEqual(
          await page.evaluate(() => {
            const lis = Array.from(document.querySelectorAll('li.ed-block'));
            const b2 = lis.find((l) => {
              const s = l.querySelector(':scope > .ed-li-text');
              return s && s.textContent.trim() === 'b2';
            });
            return b2 ? b2.parentElement.nodeName : null;
          }),
          'UL',
          'the adopted item must land in an UNORDERED list — the type of the list it came from'
        );
        const fileText = await saveAndRead(page, lmdPath);
        assert.strictEqual(fileText, '# List doc\n\n- b\n- b1\n  1. x\n  - b2\n',
          'the adopted bullet must still be emitted as a bullet (never renumbered into b1\'s ' +
          'ordered sublist), got:\n' + JSON.stringify(fileText));

        await reopenWysiwyg(page, await liBlockSelByText(page, 'b1'));
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyZ');
        await page.keyboard.up('Control');
        await page.waitForFunction(
          () => document.querySelectorAll('li.ed-block[data-indent="2"]').length === 1,
          { timeout: 5000 }
        );
        const undoneText = await saveAndRead(page, lmdPath);
        assert.strictEqual(undoneText, lorig,
          'ONE Ctrl+Z must restore the mixed-type nesting exactly, got:\n' + JSON.stringify(undoneText));

        await page.close();
        console.log('list WYSIWYG (row 6): adopted followers keep their own list type across a ' +
          'mixed-type sublist — OK');
      } finally {
        lsrv.close();
      }
    }

    // REGRESSION GUARD for the reason suppressLiFocusout exists (client.js).
    // Chromium runs its unfocus step — firing a synchronous focusout — BEFORE it
    // detaches a node, so a structural key that moves the li whose .ed-li-text
    // has focus reaches resolveBurst() with the run still in its PRE-mutation
    // shape and the burst still live; resolveBurst()'s li branch then serializes
    // and commits that stale run BEFORE commitListStructure() commits the real
    // one. Two ops for one keystroke.
    // resolveBurst()'s byte-identical guard hides it whenever the burst is
    // pristine, which is why rows 5/6 (caret moved into another li, nothing
    // typed) cannot detect it: this scenario TYPES into the very li it then
    // Tabs, so the guard does not fire and the stale commit is reachable. With
    // the suppression in place there is exactly ONE op, whose `before` is the
    // pre-typing file; without it, one Ctrl+Z leaves the typed character behind
    // in a still-flat list.
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath, original: lorig } =
        await setupListDoc(['# List doc', '', '- Alpha item', '- Bravo item', '']);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });
        const list0 = await listBlockSel(page, 0);
        const bravoSel = await liBlockSelByText(page, 'Bravo item');

        // Focus the li that is ABOUT TO MOVE (not a sibling), and dirty it.
        await openWysiwyg(page, bravoSel);
        await page.keyboard.press('End');
        await page.keyboard.type('X');
        await page.keyboard.press('Tab');
        await page.waitForFunction(
          () => document.querySelectorAll('li.ed-block[data-indent="1"]').length === 1,
          { timeout: 5000 }
        );
        // The typed character must survive: the suppression drops the focusout,
        // not the DOM, and commitListStructure() re-serializes the LIVE run.
        const fileText = await saveAndRead(page, lmdPath);
        assert.strictEqual(fileText, '# List doc\n\n- Alpha item\n  - Bravo itemX\n',
          'the indent AND the typed character must land in ONE commit, got:\n' +
          JSON.stringify(fileText));

        await reopenWysiwyg(page, await liBlockSelByText(page, 'Bravo itemX'));
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyZ');
        await page.keyboard.up('Control');
        await page.waitForFunction(
          () => document.querySelectorAll('li.ed-block[data-indent="1"]').length === 0,
          { timeout: 5000 }
        );
        const undoneText = await saveAndRead(page, lmdPath);
        assert.strictEqual(undoneText, lorig,
          'ONE Ctrl+Z after "type then Tab" must restore the PRE-TYPING bytes — a second, stale ' +
          'commit from the mid-mutation focusout would leave "- Bravo itemX" flat instead, got:\n' +
          JSON.stringify(undoneText));

        await page.close();
        console.log('list WYSIWYG: type-then-Tab is ONE undo op (mid-mutation focusout suppressed) — OK');
      } finally {
        lsrv.close();
      }
    }

    // RULING F-R: a structural key is refused RUN-WIDE when any li in the run is
    // unsupported, because spec §3 makes the commit unit the whole run (an
    // indent rewrites other lines' indent prefixes and ordinals) and
    // re-serializing a run that holds an unsupported li strips that li's
    // content. Spec §8's per-li narrowing applies to TYPING, not to this.
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath, original: lorig } =
        await setupListDoc([
          '# List doc', '',
          '- ok item',
          '- bad <video src="x"></video>',
          '- also ok',
          '',
        ]);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });
        const list0 = await listBlockSel(page, 0);
        const beforeShape = await runShapeOf(page, list0);

        // "also ok" IS armed (§8 degrades only the <video> li), so a burst opens
        // normally — and Tab would indent it under the unsupported li.
        await openWysiwyg(page, await liBlockSelByText(page, 'also ok'));
        await page.keyboard.press('Tab');
        await new Promise((r) => setTimeout(r, 250)); // let any (incorrect) commit land

        assert.ok(
          await page.evaluate(() => !!document.querySelector('.ed-conflict')),
          'the refused structural key must surface a banner explaining why nothing happened'
        );
        assert.ok(
          (await page.evaluate(() => document.querySelector('.ed-conflict').textContent))
            .includes('無法調整結構'),
          'the banner must be the structural-refusal message (繁體中文)'
        );
        assert.strictEqual(await runShapeOf(page, list0), beforeShape,
          'the refused key must leave the run structurally untouched');
        const fileText = await saveAndRead(page, lmdPath);
        assert.strictEqual(fileText, lorig,
          'the refused key must leave the file byte-identical — including the <video> li\'s own ' +
          'source line, got:\n' + JSON.stringify(fileText));

        await page.close();
        console.log('list WYSIWYG (F-R): a structural key inside a run holding an unsupported li is ' +
          'refused run-wide with a banner, file untouched — OK');
      } finally {
        lsrv.close();
      }
    }

    // RULING F-T: Tab must not RETYPE the item it moves. `a` already owns an
    // ORDERED sublist and `b` is a bullet, so appending b into a's <ol> would
    // emit it as '2. b' — list-md.js derives an item's marker from its list node,
    // not from anything on the item. The indent target is therefore `a`'s
    // sublist of the SAME type as the list b is LEAVING (created here, since a
    // has no unordered sublist). Same root cause as row 6's adoption target, and
    // runShapeOf() cannot see it — the file bytes are the assertion.
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath, original: lorig } =
        await setupListDoc([
          '# List doc', '',
          '- a', '  1. x', '- b', '',
        ]);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });
        const list0 = await listBlockSel(page, 0);
        assert.strictEqual(await runShapeOf(page, list0), '0:a | 1:x | 0:b',
          'sanity: the fixture must start as a > (ol:x) and a sibling bullet b');

        await openWysiwyg(page, await liBlockSelByText(page, 'b'));
        await page.keyboard.press('Tab');
        await page.waitForFunction(
          () => document.querySelectorAll('li.ed-block[data-indent="1"]').length === 2,
          { timeout: 5000 }
        );
        assert.strictEqual(await runShapeOf(page, list0), '0:a | 1:x | 1:b',
          'b must become a child of a, alongside the pre-existing ordered sublist');
        assert.strictEqual(
          await page.evaluate(() => {
            const lis = Array.from(document.querySelectorAll('li.ed-block'));
            const b = lis.find((l) => {
              const surface = l.querySelector(':scope > .ed-li-text');
              return surface && surface.textContent.trim() === 'b';
            });
            return b ? b.parentElement.nodeName : null;
          }),
          'UL',
          'the indented item must land in an UNORDERED list — the type of the list it came from'
        );
        const fileText = await saveAndRead(page, lmdPath);
        assert.strictEqual(fileText, '# List doc\n\n- a\n  1. x\n  - b\n',
          'the indented bullet must still be emitted as a bullet (never renumbered into a\'s ' +
          'ordered sublist), got:\n' + JSON.stringify(fileText));

        await reopenWysiwyg(page, await liBlockSelByText(page, 'b'));
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyZ');
        await page.keyboard.up('Control');
        await page.waitForFunction(
          () => document.querySelectorAll('li.ed-block[data-indent="1"]').length === 1,
          { timeout: 5000 }
        );
        const undoneText = await saveAndRead(page, lmdPath);
        assert.strictEqual(undoneText, lorig,
          'ONE Ctrl+Z must restore the mixed-type shape exactly, got:\n' + JSON.stringify(undoneText));

        await page.close();
        console.log('list WYSIWYG (row 5 / F-T): Tab keeps the moved item\'s own list type across a ' +
          'mixed-type previous sibling — OK');
      } finally {
        lsrv.close();
      }
    }

    // RULING F-U: liOwnTextIsBlank() treats an NBSP-only surface as blank (so the
    // press outdents), but the placeholder clear used to fire only on
    // textContent === '' — so that item committed as '- ' + a stray NBSP instead
    // of a bare '-'. A real user reaches this state by emptying an item and then
    // pressing Space: Chromium stores the space as &nbsp; in a contenteditable.
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath } =
        await setupListDoc(['# List doc', '', '- a', '  - b', '']);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });
        const list0 = await listBlockSel(page, 0);

        await openWysiwyg(page, await liBlockSelByText(page, 'b'));
        await emptyListItemText(page, list0, 'b');
        await page.keyboard.press('Space');
        assert.strictEqual(
          await page.evaluate(() => document.activeElement.innerHTML), '&nbsp;',
          'sanity: Chromium must have stored the typed space as an NBSP — the whole point of F-U'
        );

        await page.keyboard.press('Enter');
        await page.waitForFunction(
          () => document.querySelectorAll('li.ed-block[data-indent="0"]').length === 2,
          { timeout: 5000 }
        );
        const fileText = await saveAndRead(page, lmdPath);
        assert.strictEqual(fileText, '# List doc\n\n- a\n-\n',
          'an NBSP-only item must outdent to a BARE "-" — list-md.js only trims trailing space/tab, ' +
          'so an unhandled NBSP would survive into the line, got:\n' + JSON.stringify(fileText));
        assert.ok(fileText.indexOf('\u00a0') === -1,
          'no NBSP may survive anywhere in the committed file');

        await page.close();
        console.log('list WYSIWYG (row 3 / F-U): an NBSP-only item outdents to a bare "-" — OK');
      } finally {
        lsrv.close();
      }
    }

    // Per-li arch: each li is armed independently via canWysiwygForLi().
    // Checkbox (task-list) lis are armed — the .ed-li-check span is handled
    // by serializeList() directly and produces no `unsupported` entries.
    // Assert that all lis in a checkbox list are armed and that editing a
    // normal item in the same list commits correctly.
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath } =
        await setupListDoc([
          '# List doc', '',
          '- [ ] todo item', '- normal item', '',
        ]);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });

        // Per-li arch: canWysiwygForLi() handles .ed-li-check spans correctly
        // (serializeList() consumes them without flagging unsupported), so
        // BOTH lis must be individually armed.
        const armedCount = await page.evaluate(() => {
          return document.querySelectorAll(
            'li.ed-block[data-block-type="li"] > div.ed-li-text[contenteditable="true"]'
          ).length;
        });
        assert.strictEqual(armedCount, 2,
          'both lis (checkbox and normal) must be individually armed in the per-li arch');

        // Editing the normal item commits correctly.
        const normalLiSel = await page.evaluate(() => {
          const lis = document.querySelectorAll('li.ed-block[data-block-type="li"]');
          for (let i = 0; i < lis.length; i++) {
            if (lis[i].textContent.includes('normal item')) {
              return 'li.ed-block[data-block-id="' + lis[i].getAttribute('data-block-id') + '"]';
            }
          }
          return null;
        });
        assert.ok(normalLiSel, 'normal item li not found');
        await openWysiwyg(page, normalLiSel);
        await page.keyboard.type(' EDITED');
        await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
        await page.waitForFunction(
          () => document.querySelector('.content').textContent.includes('normal item EDITED'),
          { timeout: 5000 }
        );
        const fileText = await saveAndRead(page, lmdPath);
        assert.ok(fileText.includes('- normal item EDITED'),
          'editing a normal li in a checkbox list must commit, got:\n' + fileText);

        await page.close();
        console.log('per-li WYSIWYG: checkbox lis individually armed, normal-item edit commits — OK');
      } finally {
        lsrv.close();
      }
    }

    // Per-li arch §8 degrade: a run where ONE li has unsupported inline content
    // (<video>) must NOT degrade its siblings. The supported lis remain armed
    // and editable; the unsupported one is permanently unarmed. When the user
    // edits an armed li and blurs, the partial-run commit path (client.js:1560)
    // commits only that li's own line range — the unsupported li's source line
    // is left byte-identical. This sub-block gives the only test coverage for
    // that path (commitMd = edited li's slice of runMd, commitStart/End = edited
    // li's own startLine/endLine).
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath, original: lorig } =
        await setupListDoc([
          '# List doc', '',
          '- ok item',
          '- bad <video src="x"></video>',
          '- also ok',
          '',
        ]);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });

        // (i) The unsupported li (contains <video>) must NOT be armed.
        const badLiArmed = await page.evaluate(() => {
          const lis = Array.from(document.querySelectorAll('li.ed-block[data-block-type="li"]'));
          const bad = lis.find((li) => li.querySelector('video'));
          if (!bad) return 'bad li not found';
          const surface = bad.querySelector('.ed-li-text');
          return surface ? surface.getAttribute('contenteditable') : 'no surface';
        });
        assert.ok(badLiArmed !== 'true',
          'the li containing <video> must NOT be armed (contenteditable must not be "true"), got: ' + badLiArmed);

        // (ii) The two supported lis must both be individually armed.
        const armedSel = 'li.ed-block[data-block-type="li"] > div.ed-li-text[contenteditable="true"]';
        const armedCount = await page.evaluate((s) => document.querySelectorAll(s).length, armedSel);
        assert.strictEqual(armedCount, 2,
          '"ok item" and "also ok" must both be individually armed; expected 2, got ' + armedCount);

        // (iii) Edit "ok item", blur, verify partial-run commit: edited line
        //       changes, <video> line stays byte-identical to original.
        const okLiSel = await page.evaluate(() => {
          const lis = Array.from(document.querySelectorAll('li.ed-block[data-block-type="li"]'));
          const ok = lis.find((li) => !li.querySelector('video') && li.textContent.trim() === 'ok item');
          return ok ? 'li.ed-block[data-block-id="' + ok.getAttribute('data-block-id') + '"]' : null;
        });
        assert.ok(okLiSel, '"ok item" li not found');
        await openWysiwyg(page, okLiSel);
        await page.keyboard.type(' EDITED');
        await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
        await page.waitForFunction(
          () => document.querySelector('.content').textContent.includes('ok item EDITED'),
          { timeout: 5000 }
        );
        const fileText = await saveAndRead(page, lmdPath);
        assert.ok(fileText.includes('- ok item EDITED'),
          'partial-run commit must update the edited li line, got:\n' + fileText);
        const videoLine = lorig.split('\n').find((l) => l.includes('<video'));
        assert.ok(videoLine && fileText.includes(videoLine),
          'the <video> li line must be byte-identical to the original after a partial-run commit, got:\n' + fileText);

        await page.close();
        console.log('per-li WYSIWYG: §8 degrade — unarmed li stays intact, armed sibling commits correctly — OK');
      } finally {
        lsrv.close();
      }
    }

    // cross-item Enter no-op (CRITICAL): a selection spanning MULTIPLE <li>s must
    // NOT silently delete the spanned content on Enter — reviewer's exact
    // probe (select mid-"Alpha item" through mid-"Bravo item", Enter) must
    // be a complete no-op: no mutation, no banner, no history snap.
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath, original: lorig } =
        await setupListDoc([
          '# List doc', '',
          '- Alpha item', '- Bravo item', '- Charlie item', '',
        ]);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });
        const list0 = await listBlockSel(page, 0);

        await openWysiwyg(page, list0);
        // Per-li: capture the whole UL's innerHTML (parent of all lis in the run)
        // so the no-op assertion covers all items, not just the first li's surface.
        const beforeHtml = await page.evaluate((s) => document.querySelector(s).parentElement.innerHTML, list0);

        // Mid-"Alpha item" through mid-"Bravo item" — the reviewer's exact
        // probe shape, spanning two different <li> elements.
        await selectAcrossListItems(page, list0, 'ha item', 'Bra');
        await page.keyboard.press('Enter');
        // No banner (no failed-commit path was even reached).
        assert.strictEqual(
          await page.evaluate(() => !!document.querySelector('.ed-conflict')), false,
          'a cross-item Enter no-op must never surface a banner'
        );
        assert.strictEqual(
          await page.evaluate((s) => document.querySelector(s).parentElement.innerHTML, list0),
          beforeHtml,
          'a selection spanning multiple <li>s must leave the DOM byte-for-byte unchanged on Enter — ' +
          'no partial deletion of the spanned content'
        );
        assert.strictEqual(
          await page.evaluate((s) => document.querySelector(s).parentElement.querySelectorAll('li.ed-block').length, list0),
          3,
          'item count must stay unchanged (no split, no merge, no item lost)'
        );

        // Blur (unmodified -> silently cancels) and confirm the FILE is
        // also byte-identical — the guard never even reached commitEdit().
        const heading = '.ed-block[data-block-type="heading"]';
        await page.click(heading + ' > *');
        await page.keyboard.press('Escape');
        const fileText = await saveAndRead(page, lmdPath);
        assert.strictEqual(fileText, lorig,
          'cross-item Enter no-op must leave the saved file byte-identical, got:\n' + fileText);

        await page.close();
        console.log('list WYSIWYG: Enter with a selection spanning multiple <li>s is a no-op (no data loss) — OK');
      } finally {
        lsrv.close();
      }
    }

    // empty-Enter on the ONLY item of a list
    // must delete the WHOLE block cleanly (zero lines), absorbing exactly
    // one adjacent blank-line separator — not leave a stray blank line.
    // Reviewer's exact byte probe: "# Doc\n\n- Only item\n\nTrailer" ->
    // "# Doc\n\nTrailer". Also verifies a FOLLOW-UP edit after the removal
    // still maps to the right block (blockmap/shiftBlocks integrity).
    // Task 8: the provisional paragraph the top-level press inserts is
    // abandoned (never typed into) here, so it self-removes on the Ctrl+S
    // resolution and leaves no trace — see the row-3 scenario below.
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath } =
        await setupListDoc(['# Doc', '', '- Only item', '', 'Trailer']);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });
        const list0 = await listBlockSel(page, 0);

        await openWysiwyg(page, list0);
        await emptyListItemText(page, list0, 'Only item');
        await page.keyboard.press('Enter');
        await page.waitForFunction(
          (s) => document.activeElement !== document.querySelector(s + ' > *'),
          {}, list0
        );
        await page.waitForFunction(
          () => !document.querySelector('.content').textContent.includes('Only item'),
          { timeout: 5000 }
        );
        // Task 8: the top-level press ALSO hands the user a focused provisional
        // paragraph (spec §4's "converts to a paragraph") — a second commit
        // that lands strictly after the removal's own re-render. Wait for it to
        // be established before saving, so this scenario measures the settled
        // state instead of racing the second half of the flow (a Ctrl+S that
        // arrives in between would persist the paragraph's placeholder line,
        // because resolveBurst() has not had a chance to recognise the insert
        // as abandoned yet).
        await page.waitForFunction(
          () => !!document.activeElement && !!document.activeElement.closest &&
            !!document.activeElement.closest('.ed-block[data-block-type="paragraph"]'),
          { timeout: 5000 }
        );

        const fileText = await saveAndRead(page, lmdPath);
        assert.strictEqual(fileText, '# Doc\n\nTrailer',
          'removing the only item of a one-item list must delete the whole block and absorb ' +
          'exactly one blank separator, got:\n' + JSON.stringify(fileText));

        // Follow-up edit after the removal: the trailing paragraph must
        // still be reachable and commit to the right place — proof the
        // block map stayed consistent after the block-deleting commit.
        const trailerSel = await paragraphSelByText(page, 'Trailer');
        await openWysiwyg(page, trailerSel);
        await page.evaluate((s) => document.querySelector(s).focus(), trailerSel + ' > *');
        await page.keyboard.type(' EDITED');
        await page.evaluate((s) => document.querySelector(s).blur(), trailerSel + ' > *');
        await page.waitForFunction(
          () => document.querySelector('.content').textContent.includes('Trailer EDITED'),
          { timeout: 5000 }
        );
        const fileText2 = await saveAndRead(page, lmdPath);
        assert.strictEqual(fileText2, '# Doc\n\nTrailer EDITED',
          'a follow-up edit after the block-removal commit must still land in the right place, got:\n' +
          JSON.stringify(fileText2));

        await page.close();
        console.log('list WYSIWYG: empty-Enter on the only item deletes the whole block cleanly, ' +
          'follow-up edits still map correctly — OK');
      } finally {
        lsrv.close();
      }
    }

    // full integration mega-e2e ───────────────────────────────────────────
    // One flow exercising every Phase-3 editing surface in sequence, ending
    // in a full-string reconstruction (same pattern as the "Task 7: one
    // end-to-end flow" scenario above, extended per the task-7 brief):
    //   paragraph edit -> heading ± via ⠿ -> list Tab-indent -> table cell
    //   edit -> hover-＋ column insert -> row drag -> Ctrl+Z twice -> Ctrl+S.
    //
    // Ctrl+Z-twice design (documented per the task-7 brief's requirement to
    // spell out the exact expected state after EACH Z): the row drop
    // auto-starts a FRESH table burst (the table had no burst open — the
    // preceding column-insert already committed and ended its own burst via
    // blur, same as every step below). A fresh burst's local history is
    // exactly [pre-drag snapshot, post-drag snapshot] (2 entries):
    //   - Ctrl+Z #1: burst-local undo pops to the pre-drag snapshot — the
    //     row order reverts IN-BURST (no commit, no rerender; the cell stays
    //     focused, same contract as the "table row drag: drop reorders the
    //     row; Ctrl+Z reverts it in-burst" scenario above).
    //   - Ctrl+Z #2: burst-local history is now exhausted (back to the ONE
    //     remaining snapshot) -> tableBurstUndo() commits the burst first
    //     (a no-op: the live DOM now textually matches what's already
    //     committed, so commitEdit() returns op:null and pushes nothing new)
    //     -> cascades to the document-level undo() stack, which pops its
    //     TOPMOST entry: the column-insert commit (the last REAL commit
    //     before the drag's burst started) — reverting it and ending the
    //     burst entirely (rerenderAll() unconditionally nulls currentBurst).
    // Net effect after both Z's: the column insert is gone, the row order is
    // back to original (it was reverted in-burst before ever reaching
    // `lines`), and the EARLIER table-cell edit survives untouched (it was
    // committed BEFORE the column-insert entry, so the single cascaded undo
    // never reaches it) — exactly "reverting the drag then cascading to the
    // previous commit".
    {
      const { srv: msrv, url: murl, mdPath: mmdPath, original: morig } = await setupTableDoc([
        '# Heading One', '',
        'Paragraph text here for editing.', '',
        '- Alpha item', '- Bravo item', '- Charlie item', '',
        '| Name | Note |', '|---|---|', '| Row1 | 2 |', '| Row2 | 4 |', '| Row3 | 6 |', '',
        'Trailing untouched paragraph.', '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(murl, { waitUntil: 'networkidle0' });

        // 1) paragraph edit (Ctrl+A -> type -> Enter commits and ends the burst).
        const paraSel = await paragraphSelByText(page, 'Paragraph text here for editing.');
        const paraEditEl = paraSel + ' > *';
        await openWysiwyg(page, paraSel);
        await page.evaluate((s) => document.querySelector(s).focus(), paraEditEl);
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('Control');
        await page.keyboard.type('Paragraph text EDITED for the mega e2e.');
        await page.keyboard.press('Enter');
        await page.waitForFunction(
          () => document.querySelector('.content').textContent.includes('Paragraph text EDITED for the mega e2e.'),
          { timeout: 5000 }
        );
        await page.waitForFunction(() => document.activeElement === document.body, { timeout: 5000 });
        // Settle window (same idiom as the row-drag Esc scenario above):
        // the burst's own rerenderAll() swap has already landed by this
        // point (both waits above are strictly downstream of it), but give
        // any trailing reader-rebind/diagram-reinit work inside that same
        // commit a moment to finish before the next hover/click resolves a
        // FRESH element handle against this DOM — reduces (does not need to
        // eliminate) the window for a stale-handle race in what follows.
        await new Promise((r) => setTimeout(r, 150));

        // 2) heading ± via the ⠿ handle menu's '+' — a direct commitEdit(),
        // never a burst (see changeHeadingDepth()'s own comment).
        const selHeading = '.ed-block[data-block-type="heading"]';
        await clickGutterMenuItem(page, selHeading, '+');
        await page.waitForFunction(
          (s) => { const h = document.querySelector(s + ' > *'); return h && h.tagName === 'H2'; },
          {}, selHeading
        );

        // 3) list Tab-indent: "Bravo item" becomes a child of "Alpha item"
        // (marker-width indent), then blur commits it.
        const list0 = await listBlockSel(page, 0);
        await openWysiwyg(page, list0);
        await placeCaretInListText(page, list0, 'Bravo item', true);
        await page.keyboard.press('Tab');
        // Task 8: wait for the COMMITTED structure, not merely the local DOM
        // mutation — data-indent is written by blockmap.js from the markdown, so
        // requiring it to be "1" means the run's line-range replace AND its
        // re-render have both landed (and therefore that the structural op's own
        // focus restoration has already run, which is what makes the blur below
        // deterministic).
        await page.waitForFunction(
          (s) => {
            // Per-li: 2 top-level items after Tab-indent, first item has Bravo nested
            const li = document.querySelector(s);
            if (!li || !li.parentElement) return false;
            const topItems = li.parentElement.querySelectorAll(':scope > li.ed-block');
            const nested = topItems[0] && topItems[0].querySelector('li.ed-block');
            return topItems.length === 2 && !!nested &&
              nested.getAttribute('data-indent') === '1' &&
              nested.textContent.trim() === 'Bravo item';
          }, {}, list0
        );
        await page.evaluate(() => {
          // Per-li: blur whatever .ed-li-text is currently focused (may be Bravo, not Alpha)
          const ae = document.activeElement;
          if (ae && ae.classList.contains('ed-li-text')) ae.blur();
        });
        await page.waitForFunction(() => document.activeElement === document.body, { timeout: 5000 });
        await new Promise((r) => setTimeout(r, 150)); // settle window, see step 1's comment

        // 4) table cell edit: click "Row1", type '!', blur commits.
        const table0 = await tableBlockSel(page, 0);
        await clickCellWithText(page, table0, 'Row1');
        await page.keyboard.type('!');
        await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
        await page.waitForFunction(() => document.activeElement === document.body, { timeout: 5000 });
        await page.waitForFunction(
          () => document.querySelector('.content').textContent.includes('Row1!'),
          { timeout: 5000 }
        );
        await new Promise((r) => setTimeout(r, 150)); // settle window, see step 1's comment

        // 5) hover-＋ column insert after "Name" (boundary index 0) — auto-
        // starts a table burst; blur commits it (3 columns on disk).
        await hoverAndClickColInsert(page, table0, 0);
        await page.waitForFunction(
          (s) => document.querySelector(s + ' thead th').parentElement.children.length === 3,
          {}, table0
        );
        await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
        await page.waitForFunction(() => document.activeElement === document.body, { timeout: 5000 });
        await new Promise((r) => setTimeout(r, 150)); // settle window, see step 1's comment

        // 6) row drag: drag "Row3" (last body row) up above "Row1!" — no
        // burst is open yet, so the drop auto-starts a FRESH one (2-entry
        // local history: pre-drag, post-drag — see header comment).
        const from = await rowGripCoords(page, table0, 2); // "Row3"
        const to = await rowBoundaryCoords(page, table0, -1); // boundary just above "Row1!"
        await dragRowTo(page, from, to);
        await page.waitForFunction(
          (s) => Array.from(document.querySelectorAll(s + ' tbody td:first-child'))
            .map((c) => c.textContent.trim()).join(',') === 'Row3,Row1!,Row2',
          {}, table0
        );
        assert.strictEqual(
          await page.evaluate(() => !!document.activeElement && document.activeElement.classList.contains('ed-wys-cell')),
          true, 'the row drop must auto-start a table burst (a cell must now be focused)'
        );

        // 7) Ctrl+Z #1: reverts the drag IN-BURST — row order back to
        // Row1!,Row2,Row3; the burst stays open (cell still focused).
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyZ');
        await page.keyboard.up('Control');
        await page.waitForFunction(
          (s) => Array.from(document.querySelectorAll(s + ' tbody td:first-child'))
            .map((c) => c.textContent.trim()).join(',') === 'Row1!,Row2,Row3',
          {}, table0
        );
        assert.strictEqual(
          await page.evaluate(() => !!document.activeElement && document.activeElement.classList.contains('ed-wys-cell')),
          true, 'Ctrl+Z #1 must revert the drag IN-BURST, not commit/end the burst'
        );

        // 8) Ctrl+Z #2: local history exhausted -> commits the (now no-op)
        // burst -> cascades to the document-level undo stack, reverting the
        // column-insert commit (the topmost entry, pushed in step 5) — the
        // burst ends entirely (rerenderAll() nulls currentBurst).
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyZ');
        await page.keyboard.up('Control');
        await page.waitForFunction(
          (s) => document.querySelector(s + ' thead th').parentElement.children.length === 2,
          {}, table0
        );
        assert.strictEqual(
          await page.evaluate(() => document.activeElement === document.body),
          true, 'Ctrl+Z #2 must cascade to the document-level undo and end the burst entirely'
        );
        assert.strictEqual(
          await page.evaluate((s) =>
            Array.from(document.querySelectorAll(s + ' tbody td:first-child')).map((c) => c.textContent.trim()).join(','),
            table0),
          'Row1!,Row2,Row3',
          'row order must be back to original — the drag was reverted in-burst before it ever reached `lines`'
        );

        // 9) Ctrl+S -> full-text reconstruction: original lines with ONLY
        // the paragraph, heading, list, and table-cell edits applied — the
        // column insert and row drag left NO trace (both undone before
        // ever landing in `lines`), and every other line (including the
        // trailing untouched paragraph) stays byte-identical.
        const fileText = await saveAndRead(page, mmdPath);
        const expectedLines = morig.split('\n');
        assert.strictEqual(expectedLines[0], '# Heading One', 'sanity: expected-lines index 0 is the heading');
        assert.strictEqual(expectedLines[2], 'Paragraph text here for editing.', 'sanity: expected-lines index 2 is the paragraph');
        assert.strictEqual(expectedLines[5], '- Bravo item', 'sanity: expected-lines index 5 is Bravo\'s line');
        assert.strictEqual(expectedLines[10], '| Row1 | 2 |', 'sanity: expected-lines index 10 is Row1\'s line');
        expectedLines[0] = '## Heading One';
        expectedLines[2] = 'Paragraph text EDITED for the mega e2e.';
        expectedLines[5] = '  - Bravo item';
        expectedLines[10] = '| Row1! | 2 |';
        const expectedFull = expectedLines.join('\n');
        assert.strictEqual(fileText, expectedFull,
          'the saved file must equal the original doc with ONLY the paragraph/heading/list/table-cell edits ' +
          'applied — the column insert and row reorder must leave NO trace, and every other line (including ' +
          'the trailing untouched paragraph) must stay byte-identical, got:\n' + fileText);

        await page.close();
        console.log('e2e (Phase 3): paragraph + heading± + list Tab-indent + table cell + col-insert + ' +
          'row drag + Ctrl+Z x2 (revert drag, cascade col-insert) + Ctrl+S — full reconstruction OK');
      } finally {
        msrv.close();
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // Final whole-branch review (2026-08): Findings 1-6 regression coverage.
    // Each isolated doc below uses setupTableDoc() (generic despite the
    // name — writes `rows` verbatim and boots a fresh server) so none of
    // these depend on — or can leak into — the shared fixture doc above.
    // ══════════════════════════════════════════════════════════════════════

    // ── Finding 1 (Critical): mid-burst Ctrl+S must resolve the open burst
    //    FIRST (via switchAwayFrom()) so `lines` reflects the just-typed
    //    edit before save() reads it — never save stale content and clear
    //    the dirty dot on top of it ─────────────────────────────────────────
    {
      const { srv: f1srv, url: f1url, mdPath: f1mdPath } = await setupTableDoc([
        'Mid-burst save target text here.', '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(f1url, { waitUntil: 'networkidle0' });

        const sel = await paragraphSelByText(page, 'Mid-burst save target text here.');
        const editEl = sel + ' > *';
        await openWysiwyg(page, sel);
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('Control');
        await page.keyboard.type('EDITED without a blur.');
        assert.strictEqual(
          await page.evaluate((s) => document.activeElement === document.querySelector(s), editEl),
          true,
          'sanity: the burst must still be open (never blurred) right before Ctrl+S'
        );

        await page.keyboard.down('Control');
        await page.keyboard.press('KeyS');
        await page.keyboard.up('Control');
        await new Promise((r) => setTimeout(r, 400));

        const fileText = fs.readFileSync(f1mdPath, 'utf8');
        assert.ok(fileText.includes('EDITED without a blur.'),
          'Ctrl+S while a burst is open (never blurred) must resolve it first and save the just-typed ' +
          'text — the file must contain it, got:\n' + fileText);
        const title = await page.title();
        assert.ok(!title.startsWith('●'),
          'after a REAL mid-burst save, the dirty dot must be cleared (a genuine save happened, not the ' +
          'stale-content-then-clear-dirty bug), got title: ' + title);

        await page.close();
        console.log('Finding 1: Ctrl+S mid-burst resolves the open burst before saving — OK');
      } finally {
        f1srv.close();
      }
    }

    // ── Finding 2 (Critical): a zero-edit burst must not canonicalize
    //    non-canonical (hand-padded) source — resolveBurst()'s DOM-unchanged
    //    fast path skips the serializer entirely when nothing was typed ────
    {
      const { srv: f2srv, url: f2url, mdPath: f2mdPath, original: f2orig } = await setupTableDoc([
        '| Name     | Note |',
        '|----------|------|',
        '| Row1     | 2    |',
        '',
        'Trailing paragraph text.', '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(f2url, { waitUntil: 'networkidle0' });

        const table0 = await tableBlockSel(page, 0);
        await clickCellWithText(page, table0, 'Row1');
        // Selecting the cell's own text is a real user interaction that
        // never mutates the DOM — it must NOT count as an edit.
        await page.evaluate(() => {
          const el = document.activeElement;
          const range = document.createRange();
          range.selectNodeContents(el);
          const s = window.getSelection();
          s.removeAllRanges();
          s.addRange(range);
        });

        const otherSel = await paragraphSelByText(page, 'Trailing paragraph text.');
        await page.click(otherSel); // click OUT of the table — a real blur, no typing anywhere

        await page.keyboard.down('Control');
        await page.keyboard.press('KeyS');
        await page.keyboard.up('Control');
        await new Promise((r) => setTimeout(r, 400));

        const fileText = fs.readFileSync(f2mdPath, 'utf8');
        assert.strictEqual(fileText, f2orig,
          'a zero-edit burst (click into a cell, select its text, click out) must leave the saved file ' +
          'BYTE-IDENTICAL to the padded/non-canonical original — no serializer rewrite, no dirty commit, got:\n' +
          fileText);
        const title = await page.title();
        assert.ok(!title.startsWith('●'), 'a zero-edit burst must never leave the document dirty, got title: ' + title);

        await page.close();
        console.log('Finding 2: zero-edit burst never canonicalizes non-canonical source — OK');
      } finally {
        f2srv.close();
      }
    }

    // ── Finding 3 (Important): a sel-toolbar mark toggle applied INSIDE a
    //    table cell must snap the table burst's local history —
    //    snapBurstIfActive() now matches when `currentBurst.editEl` (the
    //    whole <table>) CONTAINS `root` (the individual cell), not only when
    //    strictly equal ───────────────────────────────────────────────────
    {
      const { srv: f3srv, url: f3url } = await setupTableDoc([
        '| A | B |',
        '|---|---|',
        '| bold target word here | 2 |',
        '',
      ]);
      try {
        const page = await newPage(browser);
        let renderRequestCount = 0;
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          if (req.method() === 'POST' && req.url().endsWith('/api/render')) renderRequestCount++;
          req.continue();
        });
        await page.goto(f3url, { waitUntil: 'networkidle0' });

        const table0 = await tableBlockSel(page, 0);
        await clickCellWithText(page, table0, 'bold target word here');
        await page.evaluate((word) => {
          const el = document.activeElement;
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let node = null, idx = -1, cur;
          while ((cur = walker.nextNode())) {
            idx = cur.textContent.indexOf(word);
            if (idx !== -1) { node = cur; break; }
          }
          if (!node) throw new Error('word not found: ' + word);
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + word.length);
          const s = window.getSelection();
          s.removeAllRanges();
          s.addRange(range);
          document.dispatchEvent(new Event('selectionchange'));
        }, 'target');

        await page.waitForSelector('.ed-seltb');
        await page.click('.ed-seltb-b');
        assert.strictEqual(
          await page.evaluate(() => {
            const st = document.activeElement.closest('td, th').querySelector('strong');
            return st ? st.textContent : null;
          }),
          'target',
          'sanity: toolbar Bold must wrap "target" in <strong> inside the cell before the undo'
        );

        await page.keyboard.down('Control');
        await page.keyboard.press('KeyZ');
        await page.keyboard.up('Control');

        assert.strictEqual(
          await page.evaluate((s) => !document.querySelector(s + ' strong'), table0),
          true,
          'Ctrl+Z right after a toolbar Bold inside a cell must revert JUST the <strong> wrap'
        );
        assert.ok(
          await page.evaluate((s) => document.querySelector(s).textContent.includes('bold target word here'), table0),
          'the cell text content must be back to plain (unbolded) after the undo'
        );
        assert.strictEqual(
          await page.evaluate(() => !!document.activeElement && document.activeElement.classList.contains('ed-wys-cell')),
          true,
          'the table burst must stay open (a cell still focused) — the undo is purely local, nothing was committed'
        );
        assert.strictEqual(renderRequestCount, 0,
          'the mark-toggle-then-undo round trip inside a table cell must never hit /api/render — proof the ' +
          'mark toggle was snapped into the BURST-LOCAL history (this reversion happened purely client-side), ' +
          'not committed-then-cascade-undone over the network');

        await page.keyboard.press('Escape'); // end the burst, discard (never committed)
        await page.close();
        console.log('Finding 3: sel-toolbar Bold inside a table cell snaps the table burst\'s local history — OK');
      } finally {
        f3srv.close();
      }
    }

    // ── Finding 4 (Important): the ⠿ menu's "MD 原始碼" escape hatch must
    //    DISCARD an in-progress burst (restore editEl.innerHTML from
    //    burst.original) before opening the raw editor — otherwise the
    //    un-committed typing survives inside the detached-but-still-
    //    referenced DOM and resurrects itself the next time that block is
    //    focused/blurred ───────────────────────────────────────────────────
    {
      const { srv: f4srv, url: f4url, mdPath: f4mdPath, original: f4orig } = await setupTableDoc([
        'Discard resurrection target text here.', '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(f4url, { waitUntil: 'networkidle0' });

        const sel = await paragraphSelByText(page, 'Discard resurrection target text here.');
        const editEl = sel + ' > *';
        await openWysiwyg(page, sel);
        await page.keyboard.type(' DISCARDED_TYPING');
        assert.ok(
          await page.evaluate((s) => document.querySelector(s).textContent.includes('DISCARDED_TYPING'), editEl),
          'sanity: the in-progress typing must be visible in the DOM before the MD 原始碼 escape hatch'
        );

        await clickGutterMenuItem(page, sel, 'MD 原始碼');
        await page.waitForSelector(sel + ' textarea.ed-raw');
        const rawValue = await page.evaluate((s) => document.querySelector(s + ' textarea.ed-raw').value, sel);
        assert.ok(!rawValue.includes('DISCARDED_TYPING'),
          'the raw editor must seed from the committed source (`lines`), never the discarded burst DOM, got: ' + rawValue);

        // Esc cancels the raw editor -> restore() sets blockEl.innerHTML back
        // to whatever was captured as `original` at openRawEditor() time.
        await page.evaluate((s) => document.querySelector(s + ' textarea.ed-raw').focus(), sel);
        await page.keyboard.press('Escape');
        await page.waitForFunction((s) => !document.querySelector(s + ' textarea.ed-raw'), {}, sel);

        assert.ok(
          !(await page.evaluate((s) => document.querySelector(s).textContent.includes('DISCARDED_TYPING'), sel)),
          'the block must NOT show the discarded typing after Esc-ing the raw editor — that DOM must have ' +
          'been reverted to the pre-edit snapshot BEFORE the raw editor ever captured its own restore-state'
        );

        // Click back into the block, then click away — a real focus/blur
        // cycle on whatever DOM the raw editor's Esc left behind.
        await page.click(sel);
        await page.waitForFunction(
          (s) => document.activeElement === document.querySelector(s + ' > *'),
          {}, sel
        );
        await page.evaluate(() => document.activeElement && document.activeElement.blur());
        await page.waitForFunction(() => document.activeElement === document.body, { timeout: 5000 });

        await page.keyboard.down('Control');
        await page.keyboard.press('KeyS');
        await page.keyboard.up('Control');
        await new Promise((r) => setTimeout(r, 400));

        const fileText = fs.readFileSync(f4mdPath, 'utf8');
        assert.ok(!fileText.includes('DISCARDED_TYPING'), 'the discarded typing must never reach the saved file, got:\n' + fileText);
        assert.strictEqual(fileText, f4orig,
          'a click-in-click-out with nothing further typed must leave the file byte-identical to the ' +
          'original — the discard-then-click-cycle must never resurrect the abandoned edit, got:\n' + fileText);

        await page.close();
        console.log('Finding 4: MD 原始碼 escape hatch discards the burst\'s DOM before opening the raw editor — OK');
      } finally {
        f4srv.close();
      }
    }

    // ── Finding 5 (Important): the ⠿ handle must not eat the first
    //    human-speed click when its OWN block has a dirty burst open (5a:
    //    delegated mousedown preventDefault keeps the burst from blurring
    //    mid-gesture), and changeHeadingDepth() must re-resolve the LIVE
    //    block by id after switchAwayFrom() commits that same dirty burst
    //    (5c) — otherwise 5a's fix alone would make ± silently no-op on a
    //    dirty heading (the commit that used to already have happened
    //    earlier — via the OLD unguarded mousedown blur — now happens
    //    inside changeHeadingDepth()'s own switchAwayFrom() instead, and
    //    that path's stale-blockEl guard used to just bail out). (5b —
    //    rerenderAll() also resetting the gutter-menu-open flag — is a
    //    belt-and-braces hygiene fix mirroring every other overlay reset in
    //    rerenderAll(); it has no independently observable black-box
    //    symptom through the paths this file exposes, so it isn't asserted
    //    by a dedicated scenario here — see the final report.) ────────────
    {
      const { srv: f5srv, url: f5url, mdPath: f5mdPath } = await setupTableDoc([
        '# Heading depth target text', '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(f5url, { waitUntil: 'networkidle0' });

        const sel = '.ed-block[data-block-type="heading"]';
        const editEl = sel + ' > *';
        await openWysiwyg(page, sel);
        await page.keyboard.type(' EDITED');
        assert.strictEqual(
          await page.evaluate((s) => document.activeElement === document.querySelector(s), editEl),
          true,
          'sanity: the heading burst must be open (dirty, never blurred) before clicking the handle'
        );

        await page.hover(sel);
        const box = await page.evaluate((s) => {
          const el = document.querySelector(s + ' .ed-handle');
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }, sel);
        // A real "human speed" press: an actual gap between mousedown and
        // mouseup, long enough for the async commit round trip the OLD,
        // unguarded mousedown would have kicked off to land mid-gesture.
        // Post-fix, the burst never blurs at all, so this gap is inert
        // either way — it's what makes the PRE-fix bug reproduce
        // deterministically instead of racily.
        await page.mouse.move(box.x, box.y);
        await page.mouse.down();
        await new Promise((r) => setTimeout(r, 250));
        assert.strictEqual(
          await page.evaluate((s) => document.activeElement === document.querySelector(s), editEl),
          true,
          '5a: the mousedown on ⠿ must NOT blur the still-open dirty heading burst'
        );
        await page.mouse.up();

        await page.waitForFunction(
          (s) => document.querySelectorAll(s + ' .ed-handle-menu-btn').length > 0,
          { timeout: 2000 }, sel
        );

        // Click the menu's '+' — resolves (commits) the dirty burst via
        // switchAwayFrom() first, THEN bumps the heading depth.
        await page.evaluate((s) => {
          const btn = Array.from(document.querySelectorAll(s + ' .ed-handle-menu-btn'))
            .find((b) => b.textContent === '+' && !b.hidden);
          if (!btn) throw new Error('+ button not found');
          btn.click();
        }, sel);

        await page.waitForFunction(
          (s) => { const h = document.querySelector(s + ' > *'); return h && h.tagName === 'H2'; },
          { timeout: 5000 }, sel
        );

        await page.keyboard.down('Control');
        await page.keyboard.press('KeyS');
        await page.keyboard.up('Control');
        await new Promise((r) => setTimeout(r, 400));

        const fileText = fs.readFileSync(f5mdPath, 'utf8');
        assert.strictEqual(fileText, '## Heading depth target text EDITED\n',
          'both the typed edit and the heading-depth bump must land in the saved file, got:\n' + fileText);

        await page.close();
        console.log('Finding 5: dirty-heading ⠿->+ works end to end (first-click menu, live blockEl re-query) — OK');
      } finally {
        f5srv.close();
      }
    }

    // ── Finding 6 (Important): with a dirty burst open ELSEWHERE, a table
    //    ＋ bubble / edge-menu op / row drop must not silently discard the
    //    operation — ensureTableBurstOpen() now re-resolves the LIVE table
    //    by block id (mirroring the focusin listener's own stale-node
    //    recovery) instead of bailing out on a `tableEl` reference the
    //    OTHER block's commit just detached ───────────────────────────────
    {
      const { srv: f6aSrv, url: f6aUrl, mdPath: f6aMdPath } = await setupTableDoc([
        'Dirty paragraph target text here.', '',
        '| A | B |',
        '|---|---|',
        '| 1 | 2 |',
        '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(f6aUrl, { waitUntil: 'networkidle0' });

        const pSel = await paragraphSelByText(page, 'Dirty paragraph target text here.');
        const pEditEl = pSel + ' > *';
        const table0 = await tableBlockSel(page, 0);

        await openWysiwyg(page, pSel);
        await page.keyboard.type(' EDITED');
        assert.strictEqual(
          await page.evaluate((s) => document.activeElement === document.querySelector(s), pEditEl),
          true,
          'sanity: the paragraph burst must be dirty and open (never blurred) before the table op'
        );

        // Click the table's ＋ column-insert bubble WITHOUT ever blurring
        // the dirty paragraph burst first — ensureTableBurstOpen()'s own
        // switchAwayFrom() must resolve it.
        await hoverAndClickColInsert(page, table0, 0);

        await page.waitForFunction(
          (s) => document.querySelector(s + ' thead th') &&
            document.querySelector(s + ' thead th').parentElement.children.length === 3,
          { timeout: 5000 }, table0
        );
        assert.ok(
          await page.evaluate(() =>
            document.querySelector('.content').textContent.includes('Dirty paragraph target text here. EDITED')),
          'the dirty paragraph burst elsewhere must have been COMMITTED (not silently discarded) by the table op'
        );

        await page.keyboard.down('Control');
        await page.keyboard.press('KeyS');
        await page.keyboard.up('Control');
        await new Promise((r) => setTimeout(r, 400));

        const fileText = fs.readFileSync(f6aMdPath, 'utf8');
        assert.ok(fileText.includes('Dirty paragraph target text here. EDITED'),
          'the paragraph edit must be saved, got:\n' + fileText);
        const headerLine = fileText.split('\n').find((l) => l.trim().startsWith('|') && l.includes('A'));
        assert.ok(headerLine, 'header line not found in saved file:\n' + fileText);
        assert.strictEqual(headerLine.split('|').length - 2, 3,
          'the column insert must have actually landed in the saved file (3 columns), got header line: ' + headerLine);

        await page.close();
        console.log('Finding 6a: table ＋ column insert with a dirty burst open elsewhere commits BOTH — OK');
      } finally {
        f6aSrv.close();
      }
    }
    {
      const { srv: f6bSrv, url: f6bUrl, mdPath: f6bMdPath } = await setupTableDoc([
        'Dirty paragraph target text here.', '',
        '| Name | Note |',
        '|---|---|',
        '| Row1 | 1 |',
        '| Row2 | 2 |',
        '| Row3 | 3 |',
        '',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(f6bUrl, { waitUntil: 'networkidle0' });

        const pSel = await paragraphSelByText(page, 'Dirty paragraph target text here.');
        const pEditEl = pSel + ' > *';
        const table0 = await tableBlockSel(page, 0);

        await openWysiwyg(page, pSel);
        await page.keyboard.type(' EDITED');
        assert.strictEqual(
          await page.evaluate((s) => document.activeElement === document.querySelector(s), pEditEl),
          true,
          'sanity: the paragraph burst must be dirty and open (never blurred) before the row drag'
        );

        const from = await rowGripCoords(page, table0, 2); // "Row3"
        const to = await rowBoundaryCoords(page, table0, -1); // boundary just above "Row1"
        await dragRowTo(page, from, to);

        await page.waitForFunction(
          (s) => Array.from(document.querySelectorAll(s + ' tbody td:first-child'))
            .map((c) => c.textContent.trim()).join(',') === 'Row3,Row1,Row2',
          { timeout: 5000 }, table0
        );
        assert.ok(
          await page.evaluate(() =>
            document.querySelector('.content').textContent.includes('Dirty paragraph target text here. EDITED')),
          'the dirty paragraph burst elsewhere must have been COMMITTED (not silently discarded) by the row drop'
        );

        await page.keyboard.down('Control');
        await page.keyboard.press('KeyS');
        await page.keyboard.up('Control');
        await new Promise((r) => setTimeout(r, 400));

        const fileText = fs.readFileSync(f6bMdPath, 'utf8');
        assert.ok(fileText.includes('Dirty paragraph target text here. EDITED'),
          'the paragraph edit must be saved, got:\n' + fileText);
        const rowLines = fileText.split('\n').filter((l) => l.startsWith('| Row'));
        assert.deepStrictEqual(rowLines.map((l) => l.split('|')[1].trim()), ['Row3', 'Row1', 'Row2'],
          'the row reorder must have actually landed in the saved file, got rows:\n' + rowLines.join('\n'));

        await page.close();
        console.log('Finding 6b: table row drop with a dirty burst open elsewhere commits BOTH — OK');
      } finally {
        f6bSrv.close();
      }
    }

    // ── §10-gap fix: block-level INSERT (＋) and DELETE (⠿ menu) ───────────

    // ── ＋ menu appears, with the 5 expected items ──────────────────────────
    {
      const { srv: biSrv, url: biUrl } = await setupBlockOpsDoc(
        ['# Doc', '', 'Para one.', '', 'Para two.']);
      try {
        const page = await newPage(browser);
        await page.goto(biUrl, { waitUntil: 'networkidle0' });
        const sel = await paragraphSelByText(page, 'Para one.');
        await page.hover(sel);
        await page.click(sel + ' .ed-insert');
        await page.waitForFunction(
          (s) => document.querySelectorAll(s + ' .ed-insert-menu-btn').length > 0,
          {}, sel
        );
        const labels = await page.evaluate((s) =>
          Array.from(document.querySelectorAll(s + ' .ed-insert-menu-btn')).map((b) => b.textContent),
          sel);
        assert.deepStrictEqual(labels, ['段落', '標題', '清單', '表格', '程式碼'],
          '＋ menu must offer exactly the 5 block kinds, in order');
        await page.close();
        console.log('§10: ＋ menu appears with 5 items — OK');
      } finally {
        biSrv.close();
      }
    }

    // ── insert paragraph → type → saved file exact ──────────────────────────
    {
      const { srv: biSrv, url: biUrl, mdPath: biMdPath } = await setupBlockOpsDoc(
        ['# Doc', '', 'Para one.', '', 'Para two.']);
      try {
        const page = await newPage(browser);
        await page.goto(biUrl, { waitUntil: 'networkidle0' });
        const sel = await paragraphSelByText(page, 'Para one.');
        const beforeCount = await page.evaluate(() =>
          document.querySelectorAll('.ed-block[data-block-type="paragraph"]').length);
        await clickInsertMenuItem(page, sel, '段落');
        await page.waitForFunction(
          (n) => document.querySelectorAll('.ed-block[data-block-type="paragraph"]').length === n,
          {}, beforeCount + 1
        );
        // Caret must land in the new block's own edit surface, focused and
        // ready to type — the "select-all placeholder" contract means the
        // very first keystroke replaces the ZWSP placeholder, not appends
        // next to it.
        await page.keyboard.type('Hello inserted');
        const savedText = await saveAndRead(page, biMdPath);
        assert.strictEqual(savedText, '# Doc\n\nPara one.\n\nHello inserted\n\nPara two.',
          'exact byte contract for a paragraph insert immediately typed into, got:\n' + savedText);
        await page.close();
        console.log('§10: insert paragraph -> type -> saved file exact — OK');
      } finally {
        biSrv.close();
      }
    }

    // ── insert table → skeleton in file, caret in first (body) cell, then
    //    TYPE into it (positive control — review fix: an UNTOUCHED insert
    //    now auto-removes itself on save/blur, see the dedicated abandon
    //    scenario below, so this table's skeleton only survives to disk
    //    once genuinely edited, same contract as every other kind) ────────
    {
      const { srv: biSrv, url: biUrl, mdPath: biMdPath } = await setupBlockOpsDoc(
        ['# Doc', '', 'Para one.', '', 'Para two.']);
      try {
        const page = await newPage(browser);
        await page.goto(biUrl, { waitUntil: 'networkidle0' });
        const sel = await paragraphSelByText(page, 'Para one.');
        await clickInsertMenuItem(page, sel, '表格');
        await page.waitForSelector('.ed-block[data-block-type="table"] td');
        const caretInFirstBodyCell = await page.evaluate(() => {
          const table = document.querySelector('.ed-block[data-block-type="table"] table');
          const firstBodyCell = table && table.tBodies[0] && table.tBodies[0].rows[0] &&
            table.tBodies[0].rows[0].cells[0];
          return !!firstBodyCell && document.activeElement === firstBodyCell;
        });
        assert.ok(caretInFirstBodyCell, 'caret must land in the new table\'s first BODY cell, not the header');
        await page.keyboard.type('hi');
        const savedText = await saveAndRead(page, biMdPath);
        assert.strictEqual(
          savedText,
          '# Doc\n\nPara one.\n\n| A | B |\n|---|---|\n| hi |  |\n\nPara two.',
          'exact byte contract for the table skeleton once typed into, got:\n' + savedText
        );
        await page.close();
        console.log('§10: insert table -> skeleton in file, caret in first cell, typed content lands — OK');
      } finally {
        biSrv.close();
      }
    }

    // ── delete block via ⠿ → file exact (blank line absorbed) ──────────────
    {
      const { srv: biSrv, url: biUrl, mdPath: biMdPath } = await setupBlockOpsDoc(
        ['# Doc', '', 'ParaA.', '', 'ParaB.', '', 'ParaC.']);
      try {
        const page = await newPage(browser);
        await page.goto(biUrl, { waitUntil: 'networkidle0' });
        const sel = await paragraphSelByText(page, 'ParaB.');
        await clickGutterMenuItem(page, sel, '刪除');
        await page.waitForFunction(
          () => !Array.from(document.querySelectorAll('.ed-block'))
            .some((b) => b.textContent.includes('ParaB.'))
        );
        const savedText = await saveAndRead(page, biMdPath);
        assert.strictEqual(savedText, '# Doc\n\nParaA.\n\nParaC.',
          'delete must absorb exactly one blank-line separator, got:\n' + savedText);
        await page.close();
        console.log('§10: delete block via ⠿ -> file exact (blank absorbed) — OK');
      } finally {
        biSrv.close();
      }
    }

    // ── Ctrl+Z restores delete ───────────────────────────────────────────────
    {
      const { srv: biSrv, url: biUrl, mdPath: biMdPath, original } = await setupBlockOpsDoc(
        ['# Doc', '', 'ParaA.', '', 'ParaB.', '', 'ParaC.']);
      try {
        const page = await newPage(browser);
        await page.goto(biUrl, { waitUntil: 'networkidle0' });
        const sel = await paragraphSelByText(page, 'ParaB.');
        await clickGutterMenuItem(page, sel, '刪除');
        await page.waitForFunction(
          () => !Array.from(document.querySelectorAll('.ed-block'))
            .some((b) => b.textContent.includes('ParaB.'))
        );
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyZ');
        await page.keyboard.up('Control');
        await page.waitForFunction(
          () => Array.from(document.querySelectorAll('.ed-block'))
            .some((b) => b.textContent.includes('ParaB.'))
        );
        const savedText = await saveAndRead(page, biMdPath);
        assert.strictEqual(savedText, original,
          'Ctrl+Z after a block delete must restore the ORIGINAL bytes exactly, got:\n' + savedText);
        await page.close();
        console.log('§10: Ctrl+Z restores delete — OK');
      } finally {
        biSrv.close();
      }
    }

    // ── Ctrl+Z removes insert ────────────────────────────────────────────────
    {
      const { srv: biSrv, url: biUrl, mdPath: biMdPath, original } = await setupBlockOpsDoc(
        ['# Doc', '', 'Para one.', '', 'Para two.']);
      try {
        const page = await newPage(browser);
        await page.goto(biUrl, { waitUntil: 'networkidle0' });
        const sel = await paragraphSelByText(page, 'Para one.');
        const beforeCount = await page.evaluate(() =>
          document.querySelectorAll('.ed-block[data-block-type="paragraph"]').length);
        await clickInsertMenuItem(page, sel, '段落');
        await page.waitForFunction(
          (n) => document.querySelectorAll('.ed-block[data-block-type="paragraph"]').length === n,
          {}, beforeCount + 1
        );
        // No typing — Ctrl+Z immediately: the fresh burst on the new block
        // is already at its history bottom (untouched), so this cascades
        // straight out to the document-level undo() stack, which must
        // remove the whole inserted block in ONE step.
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyZ');
        await page.keyboard.up('Control');
        await page.waitForFunction(
          (n) => document.querySelectorAll('.ed-block[data-block-type="paragraph"]').length === n,
          {}, beforeCount
        );
        const savedText = await saveAndRead(page, biMdPath);
        assert.strictEqual(savedText, original,
          'Ctrl+Z after a block insert must remove it entirely (ONE undo op), got:\n' + savedText);
        await page.close();
        console.log('§10: Ctrl+Z removes insert — OK');
      } finally {
        biSrv.close();
      }
    }

    // ── insert with a dirty burst open elsewhere → burst committed AND
    //    insert lands ────────────────────────────────────────────────────────
    {
      const { srv: biSrv, url: biUrl, mdPath: biMdPath } = await setupBlockOpsDoc([
        '# Doc', '', 'Dirty target text here.', '', 'Insert target text here.', '', 'Trailer text here.',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(biUrl, { waitUntil: 'networkidle0' });

        const dirtySel = await paragraphSelByText(page, 'Dirty target text here.');
        await openWysiwyg(page, dirtySel);
        await page.keyboard.type(' EDITED');
        assert.strictEqual(
          await page.evaluate((s) => document.activeElement === document.querySelector(s + ' > *'), dirtySel),
          true,
          'sanity: the dirty burst must still be open (never blurred) before the insert'
        );

        const beforeCount = await page.evaluate(() =>
          document.querySelectorAll('.ed-block[data-block-type="paragraph"]').length);
        const insertSel = await paragraphSelByText(page, 'Insert target text here.');
        await clickInsertMenuItem(page, insertSel, '段落');
        assert.ok(
          await page.evaluate(() =>
            document.querySelector('.content').textContent.includes('Dirty target text here. EDITED')),
          'the dirty burst elsewhere must have been COMMITTED (not silently discarded) by the insert'
        );
        // Two rerenderAll()s happen inside insertBlockBelow() here — one
        // resolving the dirty burst (switchAwayFrom(), already asserted
        // above), a SEPARATE one for the insert itself — so waiting for
        // the "EDITED" text (the FIRST one's effect) is not enough: it can
        // be true before the second has even started, and typing before
        // focus actually lands on the new block drops keystrokes into
        // whatever's briefly focused (or nothing) in between. Wait for the
        // new block to actually exist AND be focused first.
        await page.waitForFunction(
          (n) => document.querySelectorAll('.ed-block[data-block-type="paragraph"]').length === n,
          {}, beforeCount + 1
        );
        await page.waitForFunction(() => {
          const paras = document.querySelectorAll('.ed-block[data-block-type="paragraph"] > *');
          return Array.from(paras).some((p) => p === document.activeElement);
        });
        // Review fix: an UNTOUCHED insert now auto-removes itself on save
        // (see the dedicated abandon scenario below) — type into it so
        // "the insert lands" is actually what this scenario exercises.
        await page.keyboard.type('New inserted text');

        const savedText = await saveAndRead(page, biMdPath);
        assert.strictEqual(
          savedText,
          '# Doc\n\nDirty target text here. EDITED\n\nInsert target text here.\n\nNew inserted text\n\nTrailer text here.',
          'both the dirty burst commit AND the typed insert must land, got:\n' + savedText
        );
        await page.close();
        console.log('§10: insert with a dirty burst open elsewhere commits BOTH — OK');
      } finally {
        biSrv.close();
      }
    }

    // ── extra coverage: 標題/清單/程式碼 insert kinds also land correctly
    //    (段落/表格 already covered above) — three sequential inserts on the
    //    same doc, each typed into and committed via the NEXT insert's own
    //    switchAwayFrom() (structural ops resolve whatever's open first —
    //    same requirement as the dirty-burst-elsewhere scenario above), the
    //    last one (the code fence) committed by the final Ctrl+S. ──────────
    {
      // No pre-existing heading block in this fixture (unlike the other
      // scenarios' '# Doc' title) — the single '.ed-block[data-block-type=
      // "heading"]' this doc will ever contain is the one inserted below,
      // so it can be located unambiguously without an index/text lookup.
      const { srv: biSrv, url: biUrl, mdPath: biMdPath } = await setupBlockOpsDoc([
        'Heading anchor.', '', 'List anchor.', '', 'Code anchor.', '', 'Trailer.',
      ]);
      try {
        const page = await newPage(browser);
        await page.goto(biUrl, { waitUntil: 'networkidle0' });

        const hSel = await paragraphSelByText(page, 'Heading anchor.');
        await clickInsertMenuItem(page, hSel, '標題');
        await page.waitForSelector('.ed-block[data-block-type="heading"]');
        assert.strictEqual(
          await page.evaluate(() =>
            document.activeElement === document.querySelector('.ed-block[data-block-type="heading"] > *')),
          true, 'caret must land in the freshly-inserted heading'
        );
        await page.keyboard.type('New Heading');

        const lSel = await paragraphSelByText(page, 'List anchor.');
        await clickInsertMenuItem(page, lSel, '清單');
        await page.waitForSelector('li.ed-block[data-block-type="li"]');
        assert.ok(
          await page.evaluate(() =>
            document.querySelector('.ed-block[data-block-type="heading"] > *').textContent === 'New Heading'),
          'the heading insert must have been committed by the list insert\'s own switchAwayFrom()'
        );
        assert.strictEqual(
          await page.evaluate(() => {
            const liTexts = document.querySelectorAll(
              'li.ed-block[data-block-type="li"] > div.ed-li-text[contenteditable="true"]');
            return Array.from(liTexts).some((t) => t === document.activeElement);
          }),
          true, 'caret must land in the freshly-inserted list item'
        );
        await page.keyboard.type('New item text');

        const cSel = await paragraphSelByText(page, 'Code anchor.');
        await clickInsertMenuItem(page, cSel, '程式碼');
        await page.waitForSelector('.ed-block[data-block-type="code"] textarea.ed-raw');
        assert.ok(
          await page.evaluate(() =>
            document.querySelector('li.ed-block[data-block-type="li"]').textContent === 'New item text'),
          'the list insert must have been committed by the code insert\'s own switchAwayFrom()'
        );
        // Caret must sit on the blank BODY line between the two fences, not
        // after the closing fence — otherwise typing would land outside
        // (or merge onto the same line as) the code block.
        const taState = await page.evaluate(() => {
          const ta = document.querySelector('.ed-block[data-block-type="code"] textarea.ed-raw');
          return { value: ta.value, start: ta.selectionStart, end: ta.selectionEnd };
        });
        assert.strictEqual(taState.value, '```\n\n```', 'the code skeleton is a fence pair with one empty body line');
        assert.strictEqual(taState.start, 4, 'caret must sit on the blank body line, not at the end');
        assert.strictEqual(taState.end, 4);
        await page.keyboard.type('console.log(1);');

        const savedText = await saveAndRead(page, biMdPath);
        assert.strictEqual(
          savedText,
          'Heading anchor.\n\n## New Heading\n\nList anchor.\n\n- New item text\n\n' +
          'Code anchor.\n\n```\nconsole.log(1);\n```\n\nTrailer.',
          'all three inserts (標題/清單/程式碼) must land with their typed content, got:\n' + savedText
        );
        await page.close();
        console.log('§10: 標題/清單/程式碼 inserts all land correctly — OK');
      } finally {
        biSrv.close();
      }
    }

    // ── review fix: abandoned (never-edited) inserts must not pollute the
    //    file — "insert ＋, click away without typing" is an ordinary
    //    changed-my-mind action. For EACH of the 5 block kinds: insert,
    //    click a DIFFERENT existing block (blur away, never typing a single
    //    character), then confirm (a) the block is gone from the DOM, (b)
    //    the document title carries no dirty marker (zero net undo ops —
    //    checked BEFORE any save), and (c) the saved file is byte-identical
    //    to the pre-insert original. All five reuse the SAME original
    //    doc/page sequentially — each abandon must leave the doc back at
    //    the exact same baseline for the next one to start from. ─────────
    {
      const rows = [
        'Away target.', '', 'Paragraph anchor.', '', 'Heading anchor.', '',
        'List anchor.', '', 'Table anchor.', '', 'Code anchor.',
      ];
      const { srv: biSrv, url: biUrl, mdPath: biMdPath, original } = await setupBlockOpsDoc(rows);
      try {
        const page = await newPage(browser);
        await page.goto(biUrl, { waitUntil: 'networkidle0' });
        const baseTitle = await page.evaluate(() => document.title);
        assert.ok(!baseTitle.startsWith('●'), 'sanity: freshly-loaded page must not start dirty');

        async function abandonAndVerify(anchorText, kind, countSel, waitExtra) {
          const anchorSel = await paragraphSelByText(page, anchorText);
          const beforeCount = await page.evaluate(
            (s) => document.querySelectorAll(s).length, countSel);
          await clickInsertMenuItem(page, anchorSel, kind);
          await page.waitForFunction(
            (s, n) => document.querySelectorAll(s).length === n,
            {}, countSel, beforeCount + 1
          );
          if (waitExtra) await page.waitForSelector(waitExtra);
          // Click a DIFFERENT, untouched block — a real blur, no typing.
          const awaySel = await paragraphSelByText(page, 'Away target.');
          await page.click(awaySel);
          await page.waitForFunction(
            (s, n) => document.querySelectorAll(s).length === n,
            {}, countSel, beforeCount
          );
          const title = await page.evaluate(() => document.title);
          assert.strictEqual(title, baseTitle,
            kind + ': title must show no dirty marker immediately after an untouched abandon (zero net undo ops), got ' +
            JSON.stringify(title));
          const savedText = await saveAndRead(page, biMdPath);
          assert.strictEqual(savedText, original,
            kind + ': an untouched abandoned insert must leave the saved file byte-identical to the pre-insert original, got:\n' + savedText);
        }

        await abandonAndVerify('Paragraph anchor.', '段落', '.ed-block[data-block-type="paragraph"]');
        await abandonAndVerify('Heading anchor.', '標題', '.ed-block[data-block-type="heading"]');
        await abandonAndVerify('List anchor.', '清單', 'li.ed-block[data-block-type="li"]');
        await abandonAndVerify('Table anchor.', '表格', '.ed-block[data-block-type="table"]');
        await abandonAndVerify('Code anchor.', '程式碼', '.ed-block[data-block-type="code"]',
          '.ed-block[data-block-type="code"] textarea.ed-raw');

        await page.close();
        console.log('§10 review fix: abandoned inserts (all 5 kinds) auto-remove, zero net undo ops, byte-identical file — OK');
      } finally {
        biSrv.close();
      }
    }

    // ── review fix: Ctrl+Z on an untouched pristine insert must still
    //    remove it in exactly ONE step (not clobber the doc by cascading a
    //    SECOND undo past it) — the auto-remove-on-blur IS the undo. ──────
    {
      const { srv: biSrv, url: biUrl, mdPath: biMdPath, original } = await setupBlockOpsDoc(
        ['# Doc', '', 'Earlier edit target.', '', 'Insert anchor.']);
      try {
        const page = await newPage(browser);
        await page.goto(biUrl, { waitUntil: 'networkidle0' });

        // An EARLIER, real, committed edit — the op a wrongly-double-cascaded
        // Ctrl+Z would incorrectly reach past the insert and revert too.
        const earlierSel = await paragraphSelByText(page, 'Earlier edit target.');
        await openWysiwyg(page, earlierSel);
        await page.keyboard.type(' EDITED');
        const staleEarlier = await nodeHandleFor(page, earlierSel);
        await page.keyboard.press('Enter');
        await page.waitForFunction(
          () => document.querySelector('.content').textContent.includes('Earlier edit target. EDITED')
        );
        // ' EDITED' is already on screen (it was typed), so the wait above can
        // pass BEFORE the commit's re-render — see awaitContentSwap()'s comment.
        await awaitContentSwap(page, staleEarlier);

        const anchorSel = await paragraphSelByText(page, 'Insert anchor.');
        const beforeCount = await page.evaluate(() =>
          document.querySelectorAll('.ed-block[data-block-type="paragraph"]').length);
        await clickInsertMenuItem(page, anchorSel, '段落');
        await page.waitForFunction(
          (n) => document.querySelectorAll('.ed-block[data-block-type="paragraph"]').length === n,
          {}, beforeCount + 1
        );
        // No typing — Ctrl+Z immediately.
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyZ');
        await page.keyboard.up('Control');
        await page.waitForFunction(
          (n) => document.querySelectorAll('.ed-block[data-block-type="paragraph"]').length === n,
          {}, beforeCount
        );
        assert.ok(
          await page.evaluate(() =>
            document.querySelector('.content').textContent.includes('Earlier edit target. EDITED')),
          'ONE Ctrl+Z on a pristine insert must remove ONLY the insert — the earlier real edit must survive untouched'
        );
        const savedText = await saveAndRead(page, biMdPath);
        assert.strictEqual(savedText, '# Doc\n\nEarlier edit target. EDITED\n\nInsert anchor.',
          'the earlier edit must still be saved; the insert must be fully gone, got:\n' + savedText);
        await page.close();
        console.log('§10 review fix: Ctrl+Z on a pristine insert removes ONLY the insert (no double-cascade) — OK');
      } finally {
        biSrv.close();
      }
    }

    // ── Task 9: clickable task-list checkboxes ────────────────────────────

    // T9-1: basic toggle — unordered task list.
    // '- [ ] todo' → click .ed-li-check → file: '- [x] todo';
    // click again → '- [ ] todo'; Ctrl+Z steps back one toggle.
    // Asserts FILE BYTES (not just DOM attribute) at each step.
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath } =
        await setupListDoc(['# Task doc', '', '- [ ] todo', '']);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });

        // Locate the checkbox span.
        const checkSel = 'li.ed-block[data-block-type="li"] .ed-li-check';
        await page.waitForSelector(checkSel);

        // Click once — should flip unchecked→checked and commit.
        // Capture the li (a CHILD of .content) as the stale handle: when
        // rerenderAll() replaces contentEl.innerHTML the li is detached.
        const staleHandle1 = await page.evaluateHandle(() =>
          document.querySelector('li.ed-block[data-block-type="li"]'));
        await page.click(checkSel);
        await page.waitForFunction((old) => !!old && !old.isConnected, { timeout: 5000 }, staleHandle1);
        await staleHandle1.dispose();

        let fileText = await saveAndRead(page, lmdPath);
        assert.ok(fileText.includes('- [x] todo'),
          'click #1: file must contain "- [x] todo", got:\n' + fileText);
        assert.ok(!fileText.includes('- [ ] todo'),
          'click #1: "- [ ] todo" must be gone from the file, got:\n' + fileText);

        // Click again — should flip checked→unchecked.
        const staleHandle2 = await page.evaluateHandle(() =>
          document.querySelector('li.ed-block[data-block-type="li"]'));
        await page.click(checkSel);
        await page.waitForFunction((old) => !!old && !old.isConnected, { timeout: 5000 }, staleHandle2);
        await staleHandle2.dispose();

        fileText = await saveAndRead(page, lmdPath);
        assert.ok(fileText.includes('- [ ] todo'),
          'click #2: file must contain "- [ ] todo", got:\n' + fileText);
        assert.ok(!fileText.includes('- [x] todo'),
          'click #2: "- [x] todo" must be gone from the file, got:\n' + fileText);

        // Ctrl+Z — should revert the second toggle (file back to "- [x] todo").
        const staleHandle3 = await page.evaluateHandle(() =>
          document.querySelector('li.ed-block[data-block-type="li"]'));
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyZ');
        await page.keyboard.up('Control');
        // Wait for the re-render triggered by undo (li is re-created).
        await page.waitForFunction((old) => !!old && !old.isConnected, { timeout: 5000 }, staleHandle3);
        await staleHandle3.dispose();
        fileText = await saveAndRead(page, lmdPath);
        assert.ok(fileText.includes('- [x] todo'),
          'Ctrl+Z: undo of second toggle must restore "- [x] todo", got:\n' + fileText);

        await page.close();
        console.log('Task 9: checkbox toggle (unordered) — unchecked→checked→unchecked, Ctrl+Z reverts — OK');
      } finally {
        lsrv.close();
      }
    }

    // T9-2: ordered task list — '1. [ ] todo' → toggle → '1. [x] todo'.
    // The ordered bullet must survive the toggle (marker stays '1. ').
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath } =
        await setupListDoc(['# Task doc', '', '1. [ ] todo', '']);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });

        const checkSel = 'li.ed-block[data-block-type="li"] .ed-li-check';
        await page.waitForSelector(checkSel);

        // Capture the li (child of .content) as stale handle — see T9-1 comment.
        const staleHandle = await page.evaluateHandle(() =>
          document.querySelector('li.ed-block[data-block-type="li"]'));
        await page.click(checkSel);
        await page.waitForFunction((old) => !!old && !old.isConnected, { timeout: 5000 }, staleHandle);
        await staleHandle.dispose();

        const fileText = await saveAndRead(page, lmdPath);
        assert.ok(fileText.includes('1. [x] todo'),
          'ordered task list toggle must produce "1. [x] todo", got:\n' + fileText);
        assert.ok(!fileText.includes('1. [ ] todo'),
          'ordered task list: "1. [ ] todo" must be gone, got:\n' + fileText);

        await page.close();
        console.log('Task 9: checkbox toggle (ordered list) — marker kept, state flipped — OK');
      } finally {
        lsrv.close();
      }
    }

    // T9-3: structural gate — a run containing an unsupported li (with <video>)
    // must refuse the toggle: banner appears, DOM shape unchanged (the checkbox
    // data-checked attribute stays the same), file bytes unchanged.
    {
      const { srv: lsrv, url: lurl, mdPath: lmdPath, original: lorig } =
        await setupListDoc([
          '# Task doc', '',
          '- [ ] todo',
          '- bad <video src="x"></video>',
          '- [x] done',
          '',
        ]);
      try {
        const page = await newPage(browser);
        await page.goto(lurl, { waitUntil: 'networkidle0' });

        // Find the first checkbox (the '- [ ] todo' item).
        const todoCheckSel = await page.evaluate(() => {
          const lis = Array.from(document.querySelectorAll('li.ed-block[data-block-type="li"]'));
          const todoLi = lis.find((li) => {
            const check = li.querySelector(':scope > .ed-li-check');
            return check && check.getAttribute('data-checked') === '0' &&
                   li.querySelector(':scope > .ed-li-text') &&
                   li.querySelector(':scope > .ed-li-text').textContent.trim() === 'todo';
          });
          if (!todoLi) return null;
          const check = todoLi.querySelector(':scope > .ed-li-check');
          const id = todoLi.getAttribute('data-block-id');
          return id ? 'li.ed-block[data-block-id="' + id + '"] > .ed-li-check' : null;
        });
        assert.ok(todoCheckSel, '"todo" li checkbox not found');

        const beforeChecked = await page.evaluate((s) =>
          document.querySelector(s) && document.querySelector(s).getAttribute('data-checked'), todoCheckSel);
        assert.strictEqual(beforeChecked, '0', 'sanity: checkbox must start unchecked');

        // Click the checkbox — must be refused.
        await page.click(todoCheckSel);
        // Give any async handler time to settle.
        await new Promise((r) => setTimeout(r, 400));

        // Banner must have appeared.
        const bannerVisible = await page.evaluate(() => !!document.querySelector('.ed-conflict'));
        assert.ok(bannerVisible, 'clicking a checkbox in a run with unsupported li must show the refusal banner');

        // DOM attribute must be unchanged.
        const afterChecked = await page.evaluate((s) =>
          document.querySelector(s) && document.querySelector(s).getAttribute('data-checked'), todoCheckSel);
        assert.strictEqual(afterChecked, '0',
          'the checkbox data-checked must remain "0" after a refused toggle, got: ' + afterChecked);

        // File must be byte-identical — nothing was committed.
        const fileText = await saveAndRead(page, lmdPath);
        assert.strictEqual(fileText, lorig,
          'refused toggle must leave the file byte-identical, got:\n' + fileText);

        await page.close();
        console.log('Task 9: checkbox toggle refused on run with unsupported li — banner shown, DOM and file intact — OK');
      } finally {
        lsrv.close();
      }
    }

    console.log('editor-client-runtime.test.js OK');
  } finally {
    await browser.close();
    srv.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
