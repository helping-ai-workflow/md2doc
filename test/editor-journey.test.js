'use strict';
// v3.2.1 journey tier — 斷言「一個人感知到什麼」，不斷言內部不變量。
// 四個感知軸：游標在哪 / 還能點什麼 / 磁碟上是什麼 / 螢幕上寫什麼。
// 刻意與 test/editor-client-runtime.test.js（機制層）分開：那一層綠著
// 而這六個缺陷全部出貨，就是分層的理由。
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const puppeteer = require('puppeteer');
const { createEditorServer } = require('../lib/editor/server.js');

const CLIENT_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'client.js'), 'utf8');

let browser;

async function boot(mdText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-journey-'));
  const mdPath = path.join(dir, 'doc.md');
  fs.writeFileSync(mdPath, mdText, 'utf8');
  // createEditorServer() takes a single options object ({ files, clientJs,
  // idleTimeoutMs, listenPort }), not the (paths, opts) shape the original
  // sketch assumed — see lib/editor/server.js. It returns
  // { server, port, urlFor(absPath), close() }, no bare `.url`/`.port`
  // shortcut on the caller's side; the URL for a given file comes from
  // urlFor(), which maps the resolved path back to its /edit/:id index.
  const srv = await createEditorServer({ files: [mdPath], clientJs: CLIENT_SRC });
  const url = srv.urlFor(mdPath);
  return { srv, url, mdPath };
}

async function newPage(mdText) {
  const b = await boot(mdText);
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(b.url, { waitUntil: 'networkidle0' });
  return Object.assign({ page, errs }, b);
}

async function saveAndRead(ctx) {
  await ctx.page.keyboard.down('Control');
  await ctx.page.keyboard.press('KeyS');
  await ctx.page.keyboard.up('Control');
  await new Promise((r) => setTimeout(r, 400));
  return fs.readFileSync(ctx.mdPath, 'utf8');
}

async function main() {
  browser = await puppeteer.launch({ args: ['--no-sandbox'] });

  // ── R1: Escape in a raw source editor must DISCARD, never commit ──────
  {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n\nBravo paragraph.\n');
    const sel = '.ed-block[data-block-type="paragraph"]';
    const blockId = await ctx.page.evaluate((s) =>
      document.querySelector(s).getAttribute('data-block-id'), sel);
    const one = '.ed-block[data-block-id="' + blockId + '"]';

    // open the raw editor via the ⠿ menu's MD 原始碼 item
    await ctx.page.hover(one);
    await ctx.page.click(one + ' .ed-handle');
    await ctx.page.waitForSelector('.ed-handle-menu-btn');
    await ctx.page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
        .find((x) => x.textContent.indexOf('原始碼') !== -1);
      if (!b) throw new Error('MD 原始碼 item not found');
      b.click();
    });
    await ctx.page.waitForSelector(one + ' textarea.ed-raw');

    await ctx.page.evaluate((s) => {
      const ta = document.querySelector(s + ' textarea.ed-raw');
      ta.value = 'DISCARDME';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, one);
    await ctx.page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 300));

    const disk = await saveAndRead(ctx);
    assert.strictEqual(disk.indexOf('DISCARDME'), -1,
      'R1: Escape 丟棄的文字不得進入磁碟，got:\n' + disk);
    assert.strictEqual(ctx.errs.length, 0, 'R1: 不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: R1 Escape discards, never commits — OK');
  }

  // ── openRawViaGutter: ⠿ → MD 原始碼 on a TABLE burst must discard ─────
  {
    const ctx = await newPage('# Doc\n\nAnchor para.\n\n| A | B |\n| --- | --- |\n| one | two |\n\nTail para.\n');
    await ctx.page.click('.ed-block[data-block-type="table"] .ed-wys-cell');
    await ctx.page.keyboard.type('ZZZ');
    const tsel = '.ed-block[data-block-type="table"]';
    await ctx.page.hover(tsel);
    await ctx.page.click(tsel + ' .ed-handle');
    await ctx.page.waitForSelector('.ed-handle-menu-btn');
    await ctx.page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
        .find((x) => x.textContent.indexOf('原始碼') !== -1);
      if (!b) throw new Error('MD 原始碼 item not found');
      b.click();
    });
    await new Promise((r) => setTimeout(r, 400));

    const raw = await ctx.page.evaluate(() => {
      const ta = document.querySelector('textarea.ed-raw');
      return ta ? ta.value : null;
    });
    assert.strictEqual(raw && raw.indexOf('ZZZ'), -1,
      'openRawViaGutter: raw editor 不得顯示被丟棄的編輯，got: ' + JSON.stringify(raw));

    const disk = await saveAndRead(ctx);
    assert.strictEqual(disk.indexOf('ZZZ'), -1,
      'openRawViaGutter: 被丟棄的編輯不得進入磁碟，got:\n' + disk);
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: ⠿ → MD 原始碼 discards a table burst — OK');
  }

  // ── R2: a raw-editor commit that spawns a new block must commit ONCE ──
  {
    const ctx = await newPage('# Doc\n\n```\ncode one\n```\n\nBravo paragraph.\n');
    const sel = '.ed-block[data-block-type="code"]';
    await ctx.page.hover(sel);
    await ctx.page.click(sel + ' .ed-handle');
    await ctx.page.waitForSelector('.ed-handle-menu-btn');
    await ctx.page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
        .find((x) => x.textContent.indexOf('原始碼') !== -1);
      b.click();
    });
    await ctx.page.waitForSelector('textarea.ed-raw');
    await ctx.page.evaluate(() => {
      const ta = document.querySelector('textarea.ed-raw');
      ta.value = '```\ncode one\n```\n\nSPAWNED tail.';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('Enter');
    await ctx.page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 600));

    const disk = await saveAndRead(ctx);
    const hits = disk.split('SPAWNED tail.').length - 1;
    assert.strictEqual(hits, 1,
      'R2: 衍生新 block 的提交只能發生一次，出現 ' + hits + ' 次:\n' + disk);
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: raw-editor commit that spawns a block commits once — OK');
  }

  // ── 轉換：B 態（無選取）必須還原焦點；A 態（有選取）必須不動 ──────────
  {
    const ctx = await newPage('alpha one\n\nbravo two\n\ncharlie three\n');
    // B 態：純點擊進 block，再按「清單」
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await ctx.page.click('[data-ed-tb="list"]');
    await new Promise((r) => setTimeout(r, 400));
    const b = await ctx.page.evaluate(() => ({
      active: document.activeElement ? document.activeElement.tagName : null,
      enabled: Array.from(document.querySelectorAll('.ed-toolbar-btn')).filter((x) => !x.disabled).length,
    }));
    assert.notStrictEqual(b.active, 'BODY', 'B 態轉換後焦點不得掉到 BODY');
    assert.ok(b.enabled > 4, 'B 態轉換後工具列不得塌成 4 顆，got ' + b.enabled);
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: conversion without a selection restores the caret — OK');
  }
  {
    const ctx = await newPage('alpha one\n\nbravo two\n\ncharlie three\n');
    // A 態：Shift+Click 立一個單塊選取，再按「清單」
    await ctx.page.keyboard.down('Shift');
    await ctx.page.click('.ed-block[data-block-id="1"]');
    await ctx.page.keyboard.up('Shift');
    await ctx.page.click('[data-ed-tb="list"]');
    await new Promise((r) => setTimeout(r, 400));
    const a = await ctx.page.evaluate(() => ({
      activeIsWrapper: !!(document.activeElement &&
        document.activeElement.classList.contains('ed-block')),
      selected: document.querySelectorAll('.ed-selected').length,
    }));
    assert.strictEqual(a.activeIsWrapper, true,
      'A 態轉換後焦點必須留在 .ed-block wrapper（roving focus），不得被搬進編輯面');
    assert.strictEqual(a.selected, 1, 'A 態轉換後選取底色必須還在');
    // Delete 必須仍然刪整個 block，而不是死鍵
    await ctx.page.keyboard.press('Delete');
    await new Promise((r) => setTimeout(r, 400));
    const disk = await saveAndRead(ctx);
    assert.strictEqual(disk.indexOf('bravo two'), -1,
      'A 態轉換後 Delete 必須刪掉整個 block，got:\n' + disk);
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: conversion with a selection leaves the selection intact — OK');
  }

  // ── H▾ on a block that is ALREADY a heading（走 changeHeadingDepth()，
  //    不是 convertBlockViaMenu()）也不得掉焦點 ──────────────────────────
  {
    const ctx = await newPage('## Alpha heading\n\nbravo two\n');
    // 無選取：純點擊進標題本身
    await ctx.page.click('.ed-block[data-block-id="0"] .ed-wys-armed');
    await ctx.page.click('[data-ed-tb="headings"]');
    await ctx.page.waitForSelector('.ed-toolbar-menu-btn');
    await ctx.page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.ed-toolbar-menu-btn'))
        .find((x) => x.textContent.indexOf('標題 4') !== -1);
      if (!b) throw new Error('標題 4 item not found');
      b.click();
    });
    await new Promise((r) => setTimeout(r, 500));
    const h = await ctx.page.evaluate(() => ({
      active: document.activeElement ? document.activeElement.tagName : null,
      enabled: Array.from(document.querySelectorAll('.ed-toolbar-btn')).filter((x) => !x.disabled).length,
    }));
    assert.notStrictEqual(h.active, 'BODY', 'H▾ 改既有標題層級後焦點不得掉到 BODY');
    assert.ok(h.enabled > 4, 'H▾ 改既有標題層級後工具列不得塌成 4 顆，got ' + h.enabled);
    const disk = await saveAndRead(ctx);
    assert.notStrictEqual(disk.indexOf('#### Alpha heading'), -1,
      'H▾ 標題 4 必須真的改寫層級，got:\n' + disk);
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: H▾ on an existing heading keeps the caret — OK');
  }

  // ── undo：游標在被改寫區塊【內】時必須還原，區塊外則不得被動到 ────────
  {
    const ctx = await newPage('# Title\n\nAlpha paragraph.\n\nBravo paragraph.\n\nGolf paragraph.\n');
    // 在 Bravo 打字並提交（產生一個可 undo 的 op）
    await ctx.page.click('.ed-block[data-block-id="2"] .ed-wys-armed');
    await ctx.page.keyboard.type(' TWO');
    await ctx.page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 400));
    // 把游標放回 Bravo（即將被 undo 改寫的那個 block）
    await ctx.page.click('.ed-block[data-block-id="2"] .ed-wys-armed');
    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('KeyZ');
    await ctx.page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 500));
    const st = await ctx.page.evaluate(() => ({
      active: document.activeElement ? document.activeElement.tagName : null,
    }));
    assert.notStrictEqual(st.active, 'BODY',
      'undo：游標落在被改寫區塊內時，焦點不得掉到 BODY');
    // 打字必須真的進得去
    await ctx.page.keyboard.type('QQ');
    await new Promise((r) => setTimeout(r, 200));
    const disk = await saveAndRead(ctx);
    assert.ok(disk.indexOf('QQ') !== -1,
      'undo 之後打的字必須進得了檔案，got:\n' + disk);
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: undo keeps a usable caret in the rewritten block — OK');
  }

  // ── 圖片：髒 block 上插入，必須落在該段落之後而非檔尾 ────────────────
  {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n\nBravo paragraph.\n\nTail paragraph.\n');
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await ctx.page.keyboard.type(' DIRTY');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64');
    const imgPath = path.join(path.dirname(ctx.mdPath), 'one.png');
    fs.writeFileSync(imgPath, png);
    const [chooser] = await Promise.all([
      ctx.page.waitForFileChooser(),
      ctx.page.click('[data-ed-tb="image"]'),
    ]);
    await chooser.accept([imgPath]);
    await new Promise((r) => setTimeout(r, 900));

    const disk = await saveAndRead(ctx);
    const lines = disk.split('\n');
    const imgIdx = lines.findIndex((l) => l.indexOf('![') !== -1);
    const alphaIdx = lines.findIndex((l) => l.indexOf('Alpha paragraph.') !== -1);
    const bravoIdx = lines.findIndex((l) => l.indexOf('Bravo paragraph.') !== -1);
    assert.ok(imgIdx > alphaIdx && imgIdx < bravoIdx,
      '圖片必須落在 Alpha 之後、Bravo 之前，got img@' + imgIdx +
      ' alpha@' + alphaIdx + ' bravo@' + bravoIdx + ':\n' + disk);
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: an image lands after the current block — OK');
  }

  // ── 模式：兩態循環，preview 不可達，按鈕講下一個狀態 ────────────────
  {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n');
    const read = () => ctx.page.evaluate(() => ({
      mode: document.body.getAttribute('data-ed-mode'),
      status: (document.querySelector('.ed-toolbar-status') || {}).textContent || '',
      label: (document.querySelector('[data-ed-tb="preview"]') || {}).title || '',
    }));
    const s0 = await read();
    assert.strictEqual(s0.mode, 'edit', '初始必須是 edit');
    await ctx.page.click('[data-ed-tb="preview"]');
    await new Promise((r) => setTimeout(r, 300));
    const s1 = await read();
    assert.strictEqual(s1.mode, 'source', '第一次按進 source');
    await ctx.page.click('[data-ed-tb="preview"]');
    await new Promise((r) => setTimeout(r, 300));
    const s2 = await read();
    assert.strictEqual(s2.mode, 'edit', '第二次按【必須】回到 edit，preview 已移除');
    assert.ok(s1.status.length > 0 && s2.status.length > 0,
      '狀態槽位必須顯示當前模式');
    assert.notStrictEqual(s1.label, s2.label,
      '按鈕標示必須講【下一個】狀態，兩態下不應相同');
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: the mode button is a truthful two-state toggle — OK');
  }

  // ── 捲動：滯留的浮動選取列不得還能改到文件 ──────────────────────────
  {
    const filler = Array.from({ length: 60 }, (_, i) => 'Filler line ' + i + '.').join('\n\n');
    const ctx = await newPage('# Doc\n\nAlpha target paragraph.\n\n' + filler + '\n');
    await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      el.focus();
      document.dispatchEvent(new Event('selectionchange'));
    });
    await new Promise((r) => setTimeout(r, 300));
    // Fixture note: read the file directly here, NOT via saveAndRead(). Ctrl+S
    // runs switchAwayFrom() first, which resolves the burst this test just
    // opened by focusing the paragraph above — and since nothing was actually
    // edited, that resolution calls resetSelToolbarState() and removes
    // .ed-seltb from the DOM for a reason that has nothing to do with
    // scrolling. Doing a save here would make the "toolbar gone after scroll"
    // assertion below pass even without the scroll-listener fix (verified:
    // it does — the toolbar is confirmed gone by save, before any scroll).
    const before = fs.readFileSync(ctx.mdPath, 'utf8');
    await ctx.page.evaluate(() => window.scrollTo(0, 4000));
    await new Promise((r) => setTimeout(r, 400));
    const visible = await ctx.page.evaluate(() => {
      const tb = document.querySelector('.ed-seltb');
      if (!tb || !tb.parentNode) return null;
      const r = tb.getBoundingClientRect();
      return { top: r.top, clickable: document.elementFromPoint(
        r.left + r.width / 2, r.top + r.height / 2) === tb ||
        tb.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) };
    });
    assert.strictEqual(visible, null,
      '選取捲出視窗後，浮動選取列必須消失，got: ' + JSON.stringify(visible));
    const after = await saveAndRead(ctx);
    assert.strictEqual(after, before, '捲動不得改變磁碟內容');
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: the floating format bar cannot act on off-screen text — OK');
  }

  await browser.close();
}

main().then(() => console.log('editor-journey.test.js OK'))
  .catch((e) => { console.error(e); process.exit(1); });
