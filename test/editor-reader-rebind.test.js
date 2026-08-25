#!/usr/bin/env node
'use strict';

// Finding 4 (final whole-branch review): reader-runtime features — TOC
// highlight via IntersectionObserver, breadcrumb tracking, the zoom-resize
// scroll anchor's heading binary search — all read a `headingNodes` array
// captured ONCE at initial page load (lib/md2doc.js's reader-runtime
// <script>). Edit mode's rerenderAll() (lib/editor/client.js) replaces
// .content's innerHTML wholesale on every commit, which detaches every node
// headingNodes points at; the IntersectionObserver keeps watching those now
// -permanently-invisible nodes, so TOC highlighting silently stops updating
// after the FIRST edit of a session, for the rest of the session.
//
// The fix adds window.__md2docRebindReader(), a sibling to the pre-existing
// window.__md2docInitDiagrams() re-init hook, called from rerenderAll()
// right after the innerHTML swap. This test proves the observer keeps
// tracking scroll position across a commit: scroll to a heading BEFORE any
// edit (sanity: TOC highlight works), commit a harmless edit elsewhere,
// then scroll to a DIFFERENT heading and assert the TOC highlight/breadcrumb
// moves there too — which is only possible if the observer is watching live,
// not detached, nodes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const puppeteer = require('puppeteer');
const { createEditorServer } = require('../lib/editor/server.js');

const REPO = path.resolve(__dirname, '..');
const CLIENT_SRC = fs.readFileSync(path.join(REPO, 'lib', 'editor', 'client.js'), 'utf8');

// Filler tall enough that each section occupies well more than a viewport's
// worth of scroll, so the IntersectionObserver's rootMargin-trimmed viewport
// only ever intersects one heading's section at a time.
function fillerParagraph(label) {
  return Array.from({ length: 14 }, (_, i) => `${label} filler line ${i}.`).join('  \n') + '  ';
}

function buildFixture() {
  const sections = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
  const parts = [];
  for (const s of sections) {
    parts.push(`## Section ${s}`, '', fillerParagraph(s), '');
  }
  return parts.join('\n');
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-rebind-'));
  const mdPath = path.join(dir, 'doc.md');
  fs.writeFileSync(mdPath, buildFixture(), 'utf8');
  const srv = await createEditorServer({ files: [mdPath], clientJs: CLIENT_SRC });
  return { dir, mdPath, srv, url: srv.urlFor(mdPath) };
}

(async () => {
  const { srv, url } = await setup();
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    page.on('dialog', (d) => d.accept());
    await page.goto(url, { waitUntil: 'networkidle0' });

    const headingIds = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-reader-heading]')).map((n) => n.id));
    assert.strictEqual(headingIds.length, 4, 'fixture must produce 4 headings');

    // ── Sanity, BEFORE any edit: scrolling to a heading updates the active
    //    section / TOC highlight. Proves the harness and assertions work.
    await page.evaluate((id) => {
      document.getElementById(id).scrollIntoView({ block: 'start' });
    }, headingIds[1]);
    await page.waitForFunction(
      (id) => window.__readerState && window.__readerState.activeSectionId === id,
      { timeout: 5000 }, headingIds[1]
    );
    let activeLinkHref = await page.evaluate(() => {
      const a = document.querySelector('.toc a.is-active');
      return a && a.getAttribute('href');
    });
    assert.strictEqual(activeLinkHref, '#' + headingIds[1],
      'sanity: TOC highlight tracks scroll before any edit');

    // ── Commit a harmless edit on a non-heading paragraph block. This
    //    triggers rerenderAll()'s .content innerHTML swap, detaching every
    //    node the pre-fix code would have kept using forever.
    const paraBlockId = await page.evaluate(() =>
      document.querySelector('.ed-block[data-block-type="paragraph"]').getAttribute('data-block-id'));
    const paraSel = '.ed-block[data-block-id="' + paraBlockId + '"]';
    // Click the block to select it (shows the floating edit bar), then its
    // ✎ 編輯 button — the click-bar equivalent of the old hover-gutter click.
    await page.click(paraSel);
    await page.waitForSelector(paraSel + ' .ed-bar-edit');
    await page.click(paraSel + ' .ed-bar-edit');
    await page.waitForSelector(paraSel + ' textarea.ed-raw');
    await page.evaluate((s) => {
      const ta = document.querySelector(s + ' textarea.ed-raw');
      ta.value = ta.value + '  \nEDITED-BY-REBIND-TEST.  ';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, paraSel);
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
    await page.waitForFunction(
      () => document.querySelector('.content').innerHTML.includes('EDITED-BY-REBIND-TEST'),
      { timeout: 5000 }
    );

    // Re-query heading nodes post-commit: same ids, but must be DIFFERENT
    // DOM node objects than before (proof the innerHTML swap really
    // happened, i.e. this test isn't accidentally a no-op).
    const headingIdsAfter = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-reader-heading]')).map((n) => n.id));
    assert.deepStrictEqual(headingIdsAfter, headingIds, 'heading ids must survive the commit unchanged');

    // ── The real assertion: scroll to a DIFFERENT heading than the one
    //    already active, and confirm the TOC highlight / activeSectionId
    //    moves there. Without FIX 4 (rebind hook), the observer is still
    //    watching the pre-commit (now detached) heading nodes, so this
    //    scroll produces NO intersection callbacks at all and
    //    activeSectionId stays stuck on headingIds[1] forever.
    await page.evaluate((id) => {
      document.getElementById(id).scrollIntoView({ block: 'start' });
    }, headingIds[3]);
    await page.waitForFunction(
      (id) => window.__readerState && window.__readerState.activeSectionId === id,
      { timeout: 5000 }, headingIds[3]
    );
    activeLinkHref = await page.evaluate(() => {
      const a = document.querySelector('.toc a.is-active');
      return a && a.getAttribute('href');
    });
    assert.strictEqual(activeLinkHref, '#' + headingIds[3],
      'FIX 4: TOC highlight must keep tracking scroll after a commit ' +
      '(observer must be rebound onto live post-edit heading nodes)');

    // Breadcrumb should also reflect the new active section.
    const breadcrumbText = await page.evaluate(() => {
      const el = document.querySelector('[data-toc-breadcrumb] a.breadcrumb-current');
      return el && el.textContent;
    });
    assert.ok(breadcrumbText && breadcrumbText.includes('Delta'),
      'FIX 4: breadcrumb must also update after a commit, got: ' + breadcrumbText);

    await page.close();
    console.log('editor-reader-rebind.test.js OK');
  } finally {
    await browser.close();
    srv.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
