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

  // ── 粗體：選取含尾隨空格時，標記不得把空格包進去 ────────────────────
  {
    const ctx = await newPage('# Doc\n\nAlpha bold text here.\n');
    await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const t = el.firstChild;
      const s = el.textContent.indexOf('bold');
      const r = document.createRange();
      r.setStart(t, s);
      r.setEnd(t, s + 5);            // 'bold ' —— 含尾隨空格
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      el.focus();
      document.dispatchEvent(new Event('selectionchange'));
    });
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.click('[data-ed-tb="bold"]');
    await new Promise((r) => setTimeout(r, 250));
    // Fixture note: the brief's original sequence pressed Escape here before
    // clicking away. Measured: with a WYS-armed paragraph burst open, Escape
    // reaches handleBurstKeydown() -> revertBurstAndEnd() and DISCARDS the
    // bold mark just applied, back to the pristine "Alpha bold text here."
    // — the RED run then failed for the wrong reason (no strong element at
    // all, not the predicted `**bold **`), and would still fail after the
    // real fix (a discarded edit stays discarded regardless of what the mark
    // boundary was). Escape here is not "dismiss the selection popup"; it is
    // "abandon this edit". Dropped — clicking a different block's armed
    // surface already ends the burst (via focusout) and commits normally.
    await ctx.page.click('.ed-block[data-block-id="0"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 400));
    const disk = await saveAndRead(ctx);
    assert.ok(disk.indexOf('**bold**') !== -1,
      '標記必須包住修剪後的選取，got:\n' + disk);
    assert.strictEqual(disk.indexOf('\\*'), -1,
      '不得出現跳脫的星號，got:\n' + disk);
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: bolding a selection with a trailing space — OK');
  }

  // ── 表格「對齊」選單：捲動中斷了開啟流程，選單仍要能用 ────────────────
  // v3.2.1 fix round 1 gave runCycleAlign() a scroll-survival fix
  // (suppressEdgeMenuAutoHide + a requestAnimationFrame reposition) for
  // ensureTableBurstOpen()'s cell.focus(), which can scroll the page for
  // real before any table burst exists yet on this table. This locks that
  // fix in: forcing every td/th focus() to also scroll (deterministic
  // stand-in for the real, but timing-fragile, focus-triggered scroll;
  // real off-screen table geometry cannot be engineered reliably from
  // outside the page) with real scroll room on both sides of the table
  // (a doc with filler only BEFORE the table already caused a false pass
  // once — scrollIntoView({block:'center'}) landed exactly at max scroll,
  // making the forced scrollBy() a silent no-op).
  {
    const filler = Array.from({ length: 60 }, (_, i) => 'Filler line ' + i + '.').join('\n\n');
    const b = await boot(filler + '\n\n' + ['| A | B |', '|---|---|', '| 1 | 2 |', ''].join('\n') +
      '\n\n' + filler + '\n');
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      const orig = HTMLElement.prototype.focus;
      HTMLElement.prototype.focus = function (...args) {
        if (this.tagName === 'TD' || this.tagName === 'TH') window.scrollBy(0, 40);
        return orig.apply(this, args);
      };
    });
    await page.goto(b.url, { waitUntil: 'networkidle0' });
    const table0 = await page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-type="table"]');
      el.scrollIntoView({ block: 'center' });
      return '.ed-block[data-block-id="' + el.getAttribute('data-block-id') + '"]';
    });
    await new Promise((r) => setTimeout(r, 100));
    const colB = await page.evaluate((ts) => {
      const table = document.querySelector(ts + ' table');
      const r = table.tHead.rows[0].cells[1].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, table0);
    await page.mouse.move(colB.x, colB.y);
    await page.waitForSelector('.ed-te-grip-col:not([hidden])', { timeout: 3000 });
    const grip = await page.evaluate(() => {
      const r = document.querySelector('.ed-te-grip-col').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down(); await page.mouse.up();
    await page.waitForSelector('.ed-te-menu:not([hidden])', { timeout: 3000 });

    // 1) the forced scroll must have actually moved something — the
    //    vacuous-green trap: a table already sitting at max scroll makes
    //    scrollBy() silently do nothing, and every assertion below would
    //    then be exercising the NO-scroll path instead of the fix.
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await page.click('.ed-te-menu-align');
    await new Promise((r) => setTimeout(r, 300));
    const scrollAfter = await page.evaluate(() => window.scrollY);
    assert.notStrictEqual(scrollAfter, scrollBefore,
      '測試前提失敗：強制捲動沒有真的移動任何東西（scrollY 前後相同），' +
      '後面的斷言就測不到修好的東西，got before=' + scrollBefore + ' after=' + scrollAfter);

    const state1 = await page.evaluate((ts) => {
      const menu = document.querySelector('.ed-te-menu');
      const th = document.querySelector(ts + ' thead th:nth-child(2)');
      return {
        menuHidden: menu.hidden,
        style: th.getAttribute('style'),
        hlCount: document.querySelectorAll('.ed-te-hl').length,
      };
    }, table0);
    // 2) the menu itself must still be showing.
    assert.strictEqual(state1.menuHidden, false,
      '捲動中斷了開啟流程後，對齊選單必須仍然顯示，got: ' + JSON.stringify(state1));
    // 3) highlighted, not just visible — this is what tells a live menu
    //    apart from an inert one sitting on top of the document with no
    //    highlight and no working buttons (see the next scenario below).
    assert.ok(state1.hlCount > 0,
      '選單顯示但沒有欄位高亮，是殭屍選單而非活的選單，got hlCount=' + state1.hlCount);
    assert.ok(/left/.test(state1.style || ''),
      '第一次點擊必須套用 left 對齊，got style=' + state1.style);

    // 4) a second click must actually cycle — not silently no-op on a
    //    detached teMenuColIndex/teMenuKind.
    await page.click('.ed-te-menu-align');
    await new Promise((r) => setTimeout(r, 300));
    const style2 = await page.evaluate((ts) =>
      document.querySelector(ts + ' thead th:nth-child(2)').getAttribute('style'), table0);
    assert.ok(/center/.test(style2 || ''),
      '第二次點擊必須把對齊循環到 center，got style=' + style2);

    await page.close(); b.srv.close();
    console.log('journey: the align menu survives a scroll that interrupts its own opening — OK');
  }

  // ── 表格「對齊」選單：無關 burst 在中途收尾時，選單必須乾淨關閉 ───────
  // v3.2.1 fix round 2 (re-review finding): round 1's requestAnimationFrame
  // reposition above had no guard against a DIFFERENT reason the menu could
  // have closed during the same await — ensureTableBurstOpen()'s
  // switchAwayFrom() resolves whatever OTHER burst is open (here: a
  // paragraph edited but never blurred, since the grip/menu buttons'
  // mousedown preventDefault() never steals focus away from it), and
  // resolveBurst() unconditionally calls hideTableEdgeMenu() as part of its
  // "any burst resolution invalidates whatever the hover overlay was
  // tracking" cleanup — regardless of which block that burst belonged to.
  // Without a guard, the reposition step resurrected the menu anyway:
  // visible, but with zero highlight and a teMenuKind/teMenuColIndex that
  // had already been nulled — a click on it did nothing (verified against a
  // stashed 66727fc build: menu ends hidden:false, hlCount:0, and a second
  // 對齊 click left the alignment at 'left', unchanged). The fix must leave
  // it CLOSED here, matching how it already behaved before round 1 ever
  // touched this function — round 1's own scenario above is unaffected
  // because there resolveBurst() is never reached at all (no other burst is
  // open, so switchAwayFrom() no-ops before ever calling it).
  {
    const b = await boot(['Alpha paragraph text.', '', '| A | B |', '|---|---|', '| 1 | 2 |', ''].join('\n'));
    const page = await browser.newPage();
    await page.goto(b.url, { waitUntil: 'networkidle0' });

    // Leave an uncommitted, unblurred burst open on the PARAGRAPH block —
    // this is the "burst elsewhere" state resolveBurst() will resolve.
    await page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="0"] .ed-wys-armed');
      el.focus();
      document.execCommand('insertText', false, 'EDITED ');
    });
    await new Promise((r) => setTimeout(r, 200));

    const table0 = await page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-type="table"]');
      return '.ed-block[data-block-id="' + el.getAttribute('data-block-id') + '"]';
    });
    const colB = await page.evaluate((ts) => {
      const table = document.querySelector(ts + ' table');
      const r = table.tHead.rows[0].cells[1].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, table0);
    await page.mouse.move(colB.x, colB.y);
    await page.waitForSelector('.ed-te-grip-col:not([hidden])', { timeout: 3000 });
    const grip = await page.evaluate(() => {
      const r = document.querySelector('.ed-te-grip-col').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down(); await page.mouse.up();
    await page.waitForSelector('.ed-te-menu:not([hidden])', { timeout: 3000 });

    // The paragraph is STILL focused here (mousedown preventDefault on the
    // grip/menu never stole it) — clicking 對齊 is what first forces
    // ensureTableBurstOpen()'s switchAwayFrom() to resolve it.
    const stillOnParagraph = await page.evaluate(() =>
      document.activeElement && document.activeElement.classList.contains('ed-wys-armed') &&
      document.activeElement.closest('.ed-block').getAttribute('data-block-id') === '0');
    assert.ok(stillOnParagraph,
      '測試前提失敗：開選單的手勢偷走了段落的焦點，這個場景就沒測到 burst-elsewhere 路徑');

    await page.click('.ed-te-menu-align');
    await new Promise((r) => setTimeout(r, 300));
    // Settle past the guarded requestAnimationFrame tick.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    const state = await page.evaluate((ts) => {
      const menu = document.querySelector('.ed-te-menu');
      const th = document.querySelector(ts + ' thead th:nth-child(2)');
      return {
        menuHidden: menu.hidden,
        hlCount: document.querySelectorAll('.ed-te-hl').length,
        style: th ? th.getAttribute('style') : null,
      };
    }, table0);
    // The align itself still applies (runCycleAlign() captured tableEl/
    // colIndex as locals before the await, same defence
    // runDeleteColumn()/runDeleteRow() already use) — only the MENU's
    // resurrection is what round 2 must prevent.
    assert.ok(/left/.test(state.style || ''),
      '對齊本身必須仍然套用（用呼叫當下捕捉的區域變數），got style=' + state.style);
    assert.strictEqual(state.menuHidden, true,
      '無關的 burst 收尾合法關閉選單後，選單不可被復活成殭屍，got: ' + JSON.stringify(state));
    assert.strictEqual(state.hlCount, 0,
      '選單關閉時不該留著高亮，got hlCount=' + state.hlCount);
    // Never both hidden:false AND hlCount:0 — that exact combination is the
    // zombie the re-reviewer measured on 66727fc.
    assert.ok(!(state.menuHidden === false && state.hlCount === 0),
      '殭屍選單：可見但沒有高亮、也不再回應點擊，got: ' + JSON.stringify(state));

    await page.close(); b.srv.close();
    console.log('journey: an unrelated burst resolving mid-align closes the menu cleanly, no zombie — OK');
  }

  // ══ V2: 工具列 + ⠿ 選單全矩陣 ═════════════════════════════════════════
  // 族群級的網：Task 3 只修了 convertBlockViaMenu() 一條路徑，這一段逐一
  // 真實點擊 22 顆工具列按鈕與 ⠿ 選單的 15 個葉節點，對每一項斷言「使用者
  // 按完之後還有著力點」。
  //
  // 每一列的「必需答案」是量測出來的，不是猜的（量測腳本見 task-11 報告）：
  //
  //   caret     按完之後游標落在一個【真的編輯面】上 —— 不只是「不是 BODY」，
  //             而是 activeElement 的 class 必須含 ed-wys-armed（段落／標題／
  //             清單項）、ed-wys-cell（表格儲存格）或 ed-raw（MD 原始碼
  //             textarea）三者之一；而且工具列沒有塌回「沒有瞄準任何 block」
  //             的 4 顆。
  //   bar-only  目標型別【依設計】沒有可聚焦的編輯面 —— client.js 的
  //             convertBlockViaMenu() 自己就寫著「降級目標（quote / code）
  //             沒有可聚焦編輯面，focusBlockAtLine 會安靜 no-op；把
  //             toolbarBlockEl 指回轉換後的 block，工具列才不會塌成 4 顆」。
  //             所以 BODY 是合法答案，但工具列必須還瞄著那個 block —— 這裡
  //             不只數按鈕數，還真的再按一次「在下方插入區塊」並確認游標落
  //             在新段落上，證明那個「還瞄著」是真的能用而不只是計數好看。
  //   source    離開 edit 模式；游標必須在 .ed-source textarea 裡，工具列
  //             此時合法地只剩模式切換一顆，所以改為斷言再按一次能回到
  //             edit 且工具列復原。
  //   BROKEN    今天實測就是壞的（見下方每一列自己的註解）。Task 11 是
  //             test-only，不能改 lib/，所以這裡把【當下的壞值】釘住：
  //             修好的那天這一列會變紅，逼人把它搬回 caret / bar-only。
  //
  // 「按鈕在該狀態下必須是 enabled」本身也是斷言：少了它，一個被誤停用的
  // 按鈕會讓整列變成點不到任何東西的空跑，而空跑永遠是綠的。
  //
  // 兩種起始狀態，讓每一顆按鈕都在它真的 enabled 的狀態下被按：
  //   sel   段落內一段非空選取（bold 家族在這裡才 enabled）
  //   nest  巢狀清單項目內的游標（outdent / indent 只在這裡 enabled）
  const V2_SEL_MD = '# H\n\nAlpha bravo charlie delta.\n\nBravo paragraph.\n';
  const V2_NEST_MD = '# H\n\n- one item\n- two item\n  - nested item\n- three item\n\nTail para.\n';

  async function v2Boot(state) {
    const ctx = await newPage(state === 'nest' ? V2_NEST_MD : V2_SEL_MD);
    // window.prompt() blocks the page until something answers it, and
    // applyLinkToggle() opens one — measured: without this handler the
    // 'link' row hangs until puppeteer's protocolTimeout kills the run.
    ctx.page.on('dialog', async (d) => { try { await d.accept('https://example.com/'); } catch (e) { /* already gone */ } });
    if (state === 'nest') {
      await ctx.page.evaluate(() => {
        const els = document.querySelectorAll('.ed-li-text');
        els[2].focus();                       // 'nested item' — depth 1
        const r = document.createRange();
        r.selectNodeContents(els[2]); r.collapse(false);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        document.dispatchEvent(new Event('selectionchange'));
      });
    } else {
      await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
      await ctx.page.evaluate(() => {
        const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
        const t = el.firstChild;
        const r = document.createRange();
        r.setStart(t, 0); r.setEnd(t, 5);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        el.focus();
        document.dispatchEvent(new Event('selectionchange'));
      });
    }
    await new Promise((r) => setTimeout(r, 300));
    return ctx;
  }

  const readLeverage = (page) => page.evaluate(() => ({
    active: document.activeElement ? document.activeElement.tagName : null,
    activeClass: document.activeElement ? String(document.activeElement.className) : '',
    enabled: Array.from(document.querySelectorAll('.ed-toolbar-btn')).filter((x) => !x.disabled).length,
    mode: document.body.getAttribute('data-ed-mode'),
  }));

  // 每一列共用的「必需答案」判定。回傳失敗訊息，或 null 表示通過。
  async function checkLeverage(ctx, name, answer) {
    const st = await readLeverage(ctx.page);
    const shown = name + ' → ' + JSON.stringify(st);
    if (answer === 'caret') {
      if (st.active === 'BODY') return shown + '（必需答案 caret：游標不得掉到 BODY）';
      // 「不是 BODY」還不夠 —— 焦點停在某顆按鈕或某個 wrapper 上一樣打不了字。
      if (!/\bed-wys-armed\b|\bed-wys-cell\b|\bed-raw\b/.test(st.activeClass)) {
        return shown + '（必需答案 caret：游標必須落在真的編輯面上' +
          '（ed-wys-armed / ed-wys-cell / ed-raw），不是只要不是 BODY 就好）';
      }
      if (st.enabled <= 4) return shown + '（必需答案 caret：工具列塌成 ' + st.enabled + ' 顆）';
      if (st.mode !== 'edit') return shown + '（必需答案 caret：不該離開 edit 模式）';
      return null;
    }
    if (answer === 'bar-only') {
      if (st.enabled <= 4) return shown + '（必需答案 bar-only：工具列塌成 ' + st.enabled + ' 顆）';
      if (st.mode !== 'edit') return shown + '（必需答案 bar-only：不該離開 edit 模式）';
      // 證明「工具列還瞄著」不是計數好看而已：再按一次「在下方插入區塊」，
      // 游標必須真的落在新段落上。
      await ctx.page.click('[data-ed-tb="insert-after"]').catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
      const after = await readLeverage(ctx.page);
      if (after.active === 'BODY') {
        return shown + '（必需答案 bar-only：工具列數字說還瞄著，但「在下方插入區塊」' +
          '按下去游標仍落在 BODY —— 那個「還瞄著」是假的，got ' + JSON.stringify(after) + '）';
      }
      return null;
    }
    if (answer === 'source') {
      if (st.mode !== 'source') return shown + '（必需答案 source：必須進入 source 模式）';
      if (st.activeClass.indexOf('ed-source') === -1) {
        return shown + '（必需答案 source：游標必須在 .ed-source textarea 裡）';
      }
      await ctx.page.click('[data-ed-tb="preview"]');
      await new Promise((r) => setTimeout(r, 400));
      const back = await readLeverage(ctx.page);
      if (back.mode !== 'edit' || back.enabled <= 4) {
        return shown + '（必需答案 source：再按一次必須回到 edit 且工具列復原，got ' +
          JSON.stringify(back) + '）';
      }
      return null;
    }
    // BROKEN —— 釘住今天量到的壞值。
    if (st.active !== 'BODY' || st.enabled !== 4) {
      return shown + '（這一列被釘成「今天已知是壞的」：BODY + 工具列 4 顆。' +
        '現在量到的不是那個值 —— 如果是修好了，把它從 BROKEN 搬到 caret / bar-only；' +
        '如果是壞成別的樣子，那是新缺陷）';
    }
    return null;
  }

  {
    const ids = await (async () => {
      const ctx = await newPage(V2_SEL_MD);
      const r = await ctx.page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-toolbar-btn'))
          .map((b) => b.getAttribute('data-ed-tb')).filter(Boolean));
      await ctx.page.close(); ctx.srv.close();
      return r;
    })();
    assert.strictEqual(ids.length, 22, '工具列應為 22 顆，got ' + ids.length);

    const TB_ROWS = [
      { id: 'undo',         state: 'sel',  answer: 'caret' },
      { id: 'redo',         state: 'sel',  answer: 'caret' },
      { id: 'headings',     state: 'sel',  answer: 'caret' },   // 只開 H▾ 選單，不轉換
      { id: 'quote',        state: 'sel',  answer: 'bar-only' },
      { id: 'code',         state: 'sel',  answer: 'bar-only' },
      { id: 'list',         state: 'sel',  answer: 'caret' },
      { id: 'ordered-list', state: 'sel',  answer: 'caret' },
      { id: 'check',        state: 'sel',  answer: 'caret' },
      { id: 'bold',         state: 'sel',  answer: 'caret' },
      { id: 'italic',       state: 'sel',  answer: 'caret' },
      { id: 'strike',       state: 'sel',  answer: 'caret' },
      { id: 'inline-code',  state: 'sel',  answer: 'caret' },
      // BROKEN：applyLinkToggle() 走 window.prompt()，那是一個原生 modal，
      // 開啟時瀏覽器會把焦點從 contenteditable 收走 → focusout → burst 收尾
      // → resetToolbarBlock()。convertBlockViaMenu() 在 finally 裡有
      // reaimToolbarBlockAtLine() 補回來，applyLinkToggle() 沒有。實測：連結
      // 本身正確寫進磁碟（[Alpha](https://example.com/)），但游標到 BODY、
      // 工具列剩 undo/redo/outline/preview 四顆；使用者要重新點回文字才能繼續。
      { id: 'link',         state: 'sel',  answer: 'BROKEN' },
      { id: 'outdent',      state: 'nest', answer: 'caret' },
      { id: 'indent',       state: 'nest', answer: 'caret' },
      { id: 'table',        state: 'sel',  answer: 'caret' },
      { id: 'insert-before', state: 'sel', answer: 'caret' },
      { id: 'insert-after', state: 'sel',  answer: 'caret' },
      { id: 'line',         state: 'sel',  answer: 'bar-only' },
      { id: 'image',        state: 'sel',  answer: 'caret' },
      { id: 'outline',      state: 'sel',  answer: 'caret' },
      { id: 'preview',      state: 'sel',  answer: 'source' },
    ];
    assert.deepStrictEqual(TB_ROWS.map((r) => r.id).slice().sort(), ids.slice().sort(),
      'V2 表必須恰好覆蓋工具列上的每一顆按鈕 —— 新增按鈕時必須同時決定它的必需答案');

    const bad = [];
    for (const row of TB_ROWS) {
      const ctx = await v2Boot(row.state);
      const dis = await ctx.page.evaluate((i) =>
        document.querySelector('[data-ed-tb="' + i + '"]').disabled, row.id);
      if (dis) {
        bad.push(row.id + ' → 在 ' + row.state + ' 狀態下是 disabled，這一列什麼都沒點到（空跑的綠燈）');
        await ctx.page.close(); ctx.srv.close();
        continue;
      }
      await ctx.page.click('[data-ed-tb="' + row.id + '"]');
      await new Promise((r) => setTimeout(r, 450));
      const fail = await checkLeverage(ctx, row.id, row.answer);
      if (fail) bad.push(fail);
      await ctx.page.close(); ctx.srv.close();
    }
    assert.deepStrictEqual(bad, [], '這些工具列按鈕的必需答案沒有成立:\n' + bad.join('\n'));
    console.log('journey: V2 toolbar matrix — OK (' + TB_ROWS.length + ' buttons)');
  }

  // ── V2b: ⠿ 選單的每一個葉節點 ────────────────────────────────────────
  {
    const GUTTER_ROWS = [
      // BROKEN：duplicateBlockViaMenu() / deleteBlockViaGutter() 都沒有
      // convertBlockViaMenu() finally 區塊裡的 reaimToolbarBlockAtLine()。
      // 實測：兩者做完之後 activeElement 是 BODY 且工具列剩 4 顆 —— 也就是
      // v3.2.1 CHANGELOG 宣稱已修的「工具列塌成 4 顆」，在這兩條路徑上還在。
      { label: '建立副本',     answer: 'BROKEN' },
      { label: '刪除',        answer: 'BROKEN' },
      { label: 'MD 原始碼',    answer: 'caret' },
      { label: '文字',        answer: 'caret',    convert: true },
      { label: '標題 1',      answer: 'caret',    convert: true },
      { label: '標題 2',      answer: 'caret',    convert: true },
      { label: '標題 3',      answer: 'caret',    convert: true },
      { label: '標題 4',      answer: 'caret',    convert: true },
      { label: '標題 5',      answer: 'caret',    convert: true },
      { label: '標題 6',      answer: 'caret',    convert: true },
      { label: '項目符號列表',  answer: 'caret',    convert: true },
      { label: '編號列表',     answer: 'caret',    convert: true },
      { label: '待辦清單',     answer: 'caret',    convert: true },
      { label: '程式碼',       answer: 'bar-only', convert: true },
      { label: '引用',        answer: 'bar-only', convert: true },
    ];
    // 覆蓋率守衛：⠿ 的葉節點集合必須恰好等於上表。多一項少一項都要有人決定
    // 它的必需答案，而不是安靜地不被測到。
    {
      const ctx = await newPage(V2_SEL_MD);
      await ctx.page.hover('.ed-block[data-block-id="1"]');
      await ctx.page.click('.ed-block[data-block-id="1"] .ed-handle');
      await ctx.page.waitForSelector('.ed-handle-menu-btn');
      const top = await ctx.page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-handle-menu-btn')).map((x) => x.textContent.trim()));
      await ctx.page.evaluate(() => {
        Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
          .find((x) => x.textContent.indexOf('轉換成') !== -1).click();
      });
      await new Promise((r) => setTimeout(r, 350));
      const all = await ctx.page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-handle-menu-btn')).map((x) => x.textContent.trim()));
      // 展開子選單後兩張面板同時在 DOM 裡，所以 `all` 是「頂層 + 子選單」的
      // 串接；葉節點 = all 去掉「轉換成 ›」這個開關本身。
      const leaves = all.filter((t) => t.indexOf('轉換成') === -1);
      await ctx.page.close(); ctx.srv.close();
      assert.ok(top.indexOf('轉換成 ›') !== -1, '⠿ 頂層應有「轉換成 ›」，got ' + JSON.stringify(top));
      assert.deepStrictEqual(leaves.slice().sort(), GUTTER_ROWS.map((r) => r.label).slice().sort(),
        'V2b 表必須恰好覆蓋 ⠿ 的每一個葉節點，got ' + JSON.stringify(leaves));
    }

    const bad = [];
    for (const row of GUTTER_ROWS) {
      const ctx = await newPage(V2_SEL_MD);
      await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
      await new Promise((r) => setTimeout(r, 200));
      await ctx.page.hover('.ed-block[data-block-id="1"]');
      await ctx.page.click('.ed-block[data-block-id="1"] .ed-handle');
      await ctx.page.waitForSelector('.ed-handle-menu-btn');
      if (row.convert) {
        await ctx.page.evaluate(() => {
          Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
            .find((x) => x.textContent.indexOf('轉換成') !== -1).click();
        });
        await new Promise((r) => setTimeout(r, 300));
      }
      // 子選單展開後頂層仍在 DOM 裡，標籤可能重複；取最後一個 = 子選單那顆。
      await ctx.page.evaluate((L) => {
        const hits = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
          .filter((x) => x.textContent.trim() === L);
        if (!hits.length) throw new Error('⠿ item not found: ' + L);
        hits[hits.length - 1].click();
      }, row.label);
      await new Promise((r) => setTimeout(r, 550));
      const fail = await checkLeverage(ctx, '⠿ ' + row.label, row.answer);
      if (fail) bad.push(fail);
      await ctx.page.close(); ctx.srv.close();
    }
    assert.deepStrictEqual(bad, [], '這些 ⠿ 選單項目的必需答案沒有成立:\n' + bad.join('\n'));
    console.log('journey: V2 gutter-menu matrix — OK (' + GUTTER_ROWS.length + ' items)');
  }

  // ══ V3: 十四個 position:fixed 浮層，捲動後的必需答案 ══════════════════
  // lib/md2doc.js 有十四個 `position: fixed` 宣告（另有 9 處是註解裡的散文
  // 提及）。client.js 只有【一個】捲動監聽器（onAnyScroll），所以「捲動之後
  // 每個浮層各自變成什麼」是一個族群，而不是十四個互不相干的問題。
  //
  // 必需答案三種：
  //   live               捲動後仍在、仍可見。這些浮層的幾何是【捲動不變】的
  //                      （top/left/right/inset 定死在視窗邊緣），捲動根本
  //                      不可能把它們留在過期座標上；而且每一個都是使用者
  //                      當下必須還能操作的東西。
  //   gone               捲動後必須消失。這些浮層的座標是從
  //                      getBoundingClientRect() 算出來的視窗座標，捲動之後
  //                      就指向錯的東西 —— 其中 .ed-te-menu 會真的刪掉整欄
  //                      整列資料。
  //   reposition-or-gone .ed-seltb 沒有能把它重新升起來的驅動（捲動不觸發
  //                      selectionchange），純隱藏會讓它永遠回不來；所以選取
  //                      還在視窗內時要跟著移動，整個捲出視窗才消失。
  //   gone-on-drag-end   兩個 drop indicator。兩者在拖曳中的捲動都原地不動
  //                      （實測），但【理由不同，不要混為一談】：
  //                      ．表格列拖曳 —— onAnyScroll() 開頭就是
  //                        `if (tePointer && tePointer.dragging) return;`，
  //                        整個函式體被跳過，是刻意放行。
  //                      ．區塊拖曳 —— 區塊拖曳用的是 `blockDragState`
  //                        （client.js:9108/9136），不是 `tePointer`
  //                        （只在 client.js:9920 由表格 grip 設定），所以那道
  //                        early-return 對它不成立：onAnyScroll() 會整個跑完，
  //                        只是它做的四件事（hideTableGrips /
  //                        hideTableInsertBubbles / hideTableEdgeMenu /
  //                        closeToolbarMenu）與那個 rAF 都【沒有碰到】
  //                        blockDropIndicator。這是比「刻意放行」更弱的前提。
  //                      三個前提都寫成斷言：(1) 捲動後 top 不變（原本這件事
  //                      只活在註解裡）；(2) pointer-events 是 none，所以過期
  //                      的線畫錯位置也點不到、不會動到資料；(3) 拖曳結束後
  //                      必須收乾淨，而且此後的捲動不得讓它復活。
  //
  // 覆蓋率守衛：直接從 lib/md2doc.js 掃出所有 `position: fixed` 宣告並比對
  // 下表的 selector 集合。有人加第十五個浮層時這裡會紅，逼他決定它的必需
  // 答案，而不是安靜地多一個沒人測過的浮層。
  const OVERLAY_RULES = [
    { sel: '.ed-toolbar',              after: 'live' },
    { sel: '.ed-toolbar-status',       after: 'live' },
    { sel: '.sidebar-toggle',          after: 'live' },
    { sel: '.lightbox',                after: 'live' },
    { sel: '.sidebar-scrim',           after: 'live' },
    { sel: '.reader-sidebar',          after: 'live' },
    { sel: '.ed-conflict',             after: 'live' },
    { sel: '.ed-te-grip',              after: 'gone' },
    { sel: '.ed-te-menu',              after: 'gone' },
    { sel: '.ed-tb-insert',            after: 'gone' },
    { sel: '.ed-toolbar-menu',         after: 'gone' },
    { sel: '.ed-te-drop-indicator',    after: 'gone-on-drag-end' },
    { sel: '.ed-block-drop-indicator', after: 'gone-on-drag-end' },
    { sel: '.ed-seltb',                after: 'reposition-or-gone' },
  ];
  {
    // 宣告 vs 散文：先把註解整個抹掉，再找 `position: fixed`。
    //
    // 【不要】改回「行首必須是 position: 且必須以分號結尾」那種寫法。那個寫法
    // 只認得一種書寫風格，實測有三種乾淨插入的規則會讓它靜默漏掉（三種都試過，
    // 舊寫法一律仍回報 14）：
    //   (1) 宣告不在行首   `.x { z-index: 5; position: fixed; }`
    //   (2) 帶 !important  `.x { position: fixed !important; }`  ← `\s*;` 不匹配
    //   (3) 收尾沒有分號   `.x { top: 0; position: fixed }`
    // 也就是說它只在「一顆浮層剛好照著現有 14 個的排版寫」時才紅，而註解卻
    // 宣稱第十五個浮層一定會紅 —— 正是這個分支反覆出過的假註解。
    //
    // 抹註解的方式：`/* … */` 整段（CSS 註解與 JS 區塊註解都在內，含
    // `.sidebar-scrim (position:fixed; inset:0; …)` 這種【帶分號】的散文提及），
    // 加上【整行】以 // 起頭的 JS 行註解。刻意不抹行中的 // ，否則 `https://`
    // 之類的字串會被截斷、把後面的大括號一起吃掉。
    const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'md2doc.js'), 'utf8');
    const stripped = cssSrc
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l)).join('\n');
    const found = [];
    const declRe = /position\s*:\s*fixed\b/g;
    let m;
    while ((m = declRe.exec(stripped))) {
      // selector = 這條宣告所屬規則的 `{` 前面那一段，邊界取最近的
      // } / { / ; / 反引號（template literal 起頭）。
      const open = stripped.lastIndexOf('{', m.index);
      if (open === -1) { found.push(null); continue; }
      let from = 0;
      for (const ch of ['}', '{', ';', '`']) {
        const i = stripped.lastIndexOf(ch, open - 1);
        if (i > from) from = i;
      }
      found.push(stripped.slice(from + 1, open).replace(/\s+/g, ' ').trim());
    }
    assert.deepStrictEqual(found.slice().sort(), OVERLAY_RULES.map((r) => r.sel).slice().sort(),
      'V3 表必須恰好覆蓋 lib/md2doc.js 裡每一個 position:fixed 浮層，got ' + JSON.stringify(found));
  }

  const V3_FILL = Array.from({ length: 40 }, (_, i) => 'Filler line ' + i + '.').join('\n\n');
  const V3_TABLE_MD = V3_FILL + '\n\n' +
    ['| Alpha | Bravo |', '|---|---|', '| one | two |', '| three | four |', ''].join('\n') +
    '\n\n' + V3_FILL + '\n';
  // 一個浮層的可見狀態。`dom:false` = 已從 DOM 移除；`hidden`/`display:none`
  // = 還在 DOM 裡但不畫出來。兩者都算 gone。
  const OVERLAY_STATE = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { dom: false };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      dom: true, hidden: !!el.hidden, display: cs.display, pointerEvents: cs.pointerEvents,
      top: Math.round(r.top), left: Math.round(r.left),
      w: Math.round(r.width), h: Math.round(r.height),
    };
  };
  const overlayState = (page, sel) => page.evaluate(OVERLAY_STATE, sel);
  const isGone = (s) => !s.dom || s.hidden || s.display === 'none' || (s.w === 0 && s.h === 0);
  const isLive = (s) => s.dom && !s.hidden && s.display !== 'none' && s.w > 0 && s.h > 0;
  // 每一列共用的「升起來了嗎」前提檢查。少了它，一個根本沒升起來的浮層在
  // 「捲動後必須消失」的斷言下永遠是綠的 —— 那正是空跑的綠燈。
  const assertRaised = (s, sel) => assert.ok(isLive(s),
    'V3 前提失敗：' + sel + ' 根本沒有升起來，捲動後的斷言就沒測到東西，got ' + JSON.stringify(s));

  async function centreTable(page) {
    const ts = await page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-type="table"]');
      el.scrollIntoView({ block: 'center' });
      return '.ed-block[data-block-id="' + el.getAttribute('data-block-id') + '"]';
    });
    await new Promise((r) => setTimeout(r, 150));
    return ts;
  }
  // 捲動必須真的移動了東西，否則後面每一條斷言都是在測「沒捲動」那條路徑。
  async function scrollBy(page, dy) {
    const before = await page.evaluate(() => window.scrollY);
    await page.evaluate((d) => window.scrollBy(0, d), dy);
    await new Promise((r) => setTimeout(r, 420));
    const after = await page.evaluate(() => window.scrollY);
    assert.notStrictEqual(after, before,
      'V3 前提失敗：捲動沒有真的移動任何東西（scrollY 前後都是 ' + before + '）');
    return after;
  }

  // ── live × 3：.ed-toolbar / .ed-toolbar-status（寬視窗）─────────────
  {
    const ctx = await newPage('# H\n\n' + V3_FILL + '\n');
    await ctx.page.setViewport({ width: 1400, height: 800 });
    for (const sel of ['.ed-toolbar', '.ed-toolbar-status']) {
      const before = await overlayState(ctx.page, sel);
      assertRaised(before, sel);
      await ctx.page.evaluate(() => window.scrollTo(0, 0));
      await scrollBy(ctx.page, 2000);
      const after = await overlayState(ctx.page, sel);
      assert.ok(isLive(after), sel + ' 捲動後必須仍然可見，got ' + JSON.stringify(after));
      assert.strictEqual(after.top, before.top,
        sel + ' 捲動後必須留在同一個視窗座標，got top=' + after.top + ' was ' + before.top);
    }
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: V3 .ed-toolbar / .ed-toolbar-status stay live across a scroll — OK');
  }

  // ── live：.sidebar-toggle ───────────────────────────────────────────
  // 它在 lib/md2doc.js 是 `display: none`，只有 @media (max-width: 1080px)
  // 才變 inline-flex —— 所以視窗寬度在這裡是斷言的一部分，不能沿用預設值。
  {
    const ctx = await newPage('# H\n\n## Sub\n\n' + V3_FILL + '\n');
    await ctx.page.setViewport({ width: 800, height: 800 });
    await new Promise((r) => setTimeout(r, 250));
    const before = await overlayState(ctx.page, '.sidebar-toggle');
    assertRaised(before, '.sidebar-toggle');
    await scrollBy(ctx.page, 2000);
    const after = await overlayState(ctx.page, '.sidebar-toggle');
    assert.ok(isLive(after), '.sidebar-toggle 捲動後必須仍然可見，got ' + JSON.stringify(after));
    assert.strictEqual(after.top, before.top, '.sidebar-toggle 捲動後必須留在同一個視窗座標');
    // 同一頁順帶量寬視窗：這一列依賴視窗寬度，所以把那個依賴也釘住 ——
    // 有人把 @media 斷點改掉時，上面那個 800px 的前提會靜默失效。
    await ctx.page.setViewport({ width: 1400, height: 800 });
    await new Promise((r) => setTimeout(r, 250));
    const wide = await overlayState(ctx.page, '.sidebar-toggle');
    assert.ok(isGone(wide),
      '.sidebar-toggle 在 1080px 以上必須是 display:none（這一列的 800px 前提靠它成立），got ' +
      JSON.stringify(wide));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: V3 .sidebar-toggle stays live across a scroll (≤1080px only) — OK');
  }

  // ── live × 2：.sidebar-scrim / .reader-sidebar（抽屜打開時）──────────
  // 實測：抽屜打開時 body 仍然可以捲（overflow 是 `clip visible`，scrollY
  // 真的從 0 走到 1938），而兩者被捲動會動到的那個軸都定死在視窗上，所以
  // 捲動之後位置一格都沒動：
  //   .sidebar-scrim   `inset: 0` —— 四個邊都定死。
  //   .reader-sidebar  只定死 top / left / bottom 三個邊（lib/md2doc.js
  //                    :2104），寬度是 `width: 85%; max-width: 360px`。
  //                    垂直軸兩端都釘住，所以垂直捲動一樣動不到它。
  // 它們必須留著 —— scrim 是關掉抽屜的唯一點擊目標。
  {
    const ctx = await newPage('# H\n\n## Sub\n\n' + V3_FILL + '\n');
    await ctx.page.setViewport({ width: 800, height: 800 });
    await new Promise((r) => setTimeout(r, 250));
    // .sidebar-toggle 在 edit 模式下被 .ed-toolbar（z-index 101 > 100）蓋住，
    // 滑鼠點不到它 —— 實測 elementFromPoint 回的是 .ed-toolbar-btn。這裡要測
    // 的是抽屜打開之後的捲動行為，不是那個遮擋，所以用 DOM click 繞過。
    await ctx.page.evaluate(() => document.querySelector('.sidebar-toggle').click());
    await new Promise((r) => setTimeout(r, 450));
    const open = await ctx.page.evaluate(() => document.body.getAttribute('data-sidebar-open'));
    assert.notStrictEqual(open, null, 'V3 前提失敗：抽屜沒有打開，scrim/sidebar 就沒升起來');
    for (const sel of ['.sidebar-scrim', '.reader-sidebar']) {
      const before = await overlayState(ctx.page, sel);
      assertRaised(before, sel);
      await ctx.page.evaluate(() => window.scrollTo(0, 0));
      await scrollBy(ctx.page, 1500);
      const after = await overlayState(ctx.page, sel);
      assert.ok(isLive(after), sel + ' 捲動後必須仍然可見，got ' + JSON.stringify(after));
      assert.strictEqual(after.top + '/' + after.left, before.top + '/' + before.left,
        sel + ' 捲動後必須留在同一個視窗座標，got ' + JSON.stringify(after));
    }
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: V3 .sidebar-scrim / .reader-sidebar stay live across a scroll — OK');
  }

  // ── live：.lightbox ─────────────────────────────────────────────────
  // lightbox 開著時 lib/md2doc.js 的 `body[data-lightbox-open] { overflow:
  // hidden; }` 只作用在 <body> 上 —— 捲動的捲動容器是 documentElement，它的
  // overflow 仍是 `clip visible`，所以【文件照樣捲得動】：實測開著 lightbox
  // 時 window.scrollBy(0, 1500) 讓 scrollY 從 0 走到 1048，capture 階段收到
  // 一個 scroll 事件。這一列問的就是「這個捲動不得把 lightbox 拆掉」。
  //
  // ⚠ 不要改回「捲它自己的 .lightbox-stage」：實測 stage 在 zoom 1 下被縮到
  // 剛好容納整張圖（1×1 與 1600×1200 兩種圖都量過：scrollHeight ===
  // clientHeight === 744、scrollWidth === clientWidth === 1400），s.scrollTop
  // = 40 會被夾回 0 且【一個 scroll 事件都不發】。stage 要真的能捲必須先驅動
  // 縮放控制，那是 test/lightbox.test.js 的地盤（它已經斷言縮放後
  // stage.scrollWidth > stage.clientWidth）。
  {
    // boot() (not newPage()) so the png exists BEFORE the first render:
    // md2doc inlines local image srcs at render time and prints
    // "[WARN] image not found, left as-is" when the file is missing yet.
    const b = await boot('# H\n\n![x](one.png)\n\n' + V3_FILL + '\n');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64');
    fs.writeFileSync(path.join(path.dirname(b.mdPath), 'one.png'), png);
    const ctx = Object.assign({ page: await browser.newPage() }, b);
    await ctx.page.setViewport({ width: 1400, height: 800 });
    await ctx.page.goto(b.url, { waitUntil: 'networkidle0' });
    await ctx.page.click('.content img');
    await new Promise((r) => setTimeout(r, 500));
    const before = await overlayState(ctx.page, '.lightbox');
    assertRaised(before, '.lightbox');
    // 和其他每一列一樣走共用的 scrollBy()，它會斷言 scrollY 真的變了 ——
    // 少了這道前提，一個根本沒發生的捲動會讓下面的斷言永遠是綠的。
    await scrollBy(ctx.page, 1500);
    const after = await overlayState(ctx.page, '.lightbox');
    assert.ok(isLive(after), '.lightbox 捲動後必須仍然可見，got ' + JSON.stringify(after));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: V3 .lightbox survives a document scroll — OK');
  }

  // ── live：.ed-conflict ──────────────────────────────────────────────
  // 存檔／render 失敗的橫幅是 z-index 999（全檔最高），而且是使用者唯一能
  // 知道「剛剛那次編輯沒有套用」的東西。幾何是 top/left/right 定死，捲動不
  // 可能讓它過期。升起方式：把 server 關掉再逼一次 render。
  {
    const ctx = await newPage('# H\n\nAlpha paragraph.\n\n' + V3_FILL + '\n');
    await ctx.page.setViewport({ width: 1400, height: 800 });
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await ctx.page.keyboard.type(' X');
    ctx.srv.close();
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.keyboard.press('Enter');
    await ctx.page.waitForSelector('.ed-conflict', { timeout: 8000 });
    const before = await overlayState(ctx.page, '.ed-conflict');
    assertRaised(before, '.ed-conflict');
    await scrollBy(ctx.page, 1200);
    const after = await overlayState(ctx.page, '.ed-conflict');
    assert.ok(isLive(after), '.ed-conflict 捲動後必須仍然可見，got ' + JSON.stringify(after));
    assert.strictEqual(after.top, before.top, '.ed-conflict 捲動後必須留在同一個視窗座標');
    await ctx.page.close();
    console.log('journey: V3 .ed-conflict stays live across a scroll — OK');
  }

  // ── gone × 3：.ed-te-grip / .ed-te-menu / .ed-tb-insert ─────────────
  {
    // grip：把游標移到表頭儲存格中央。
    const ctx = await newPage(V3_TABLE_MD);
    await ctx.page.setViewport({ width: 1400, height: 800 });
    const ts = await centreTable(ctx.page);
    const cell = await ctx.page.evaluate((t) => {
      const r = document.querySelector(t + ' table').tHead.rows[0].cells[1].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, ts);
    await ctx.page.mouse.move(cell.x, cell.y);
    await ctx.page.waitForSelector('.ed-te-grip-col:not([hidden])', { timeout: 4000 });
    const gripBefore = await overlayState(ctx.page, '.ed-te-grip-col');
    assertRaised(gripBefore, '.ed-te-grip');
    // menu：點那顆 grip。
    const g = await ctx.page.evaluate(() => {
      const r = document.querySelector('.ed-te-grip-col').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await ctx.page.mouse.move(g.x, g.y);
    await ctx.page.mouse.down(); await ctx.page.mouse.up();
    await ctx.page.waitForSelector('.ed-te-menu:not([hidden])', { timeout: 4000 });
    const menuBefore = await overlayState(ctx.page, '.ed-te-menu');
    assertRaised(menuBefore, '.ed-te-menu');
    await scrollBy(ctx.page, 200);
    const gripAfter = await overlayState(ctx.page, '.ed-te-grip-col');
    const menuAfter = await overlayState(ctx.page, '.ed-te-menu');
    assert.ok(isGone(gripAfter), '.ed-te-grip 捲動後必須消失，got ' + JSON.stringify(gripAfter));
    assert.ok(isGone(menuAfter),
      '.ed-te-menu 捲動後必須消失（它是唯一會真的刪掉整欄整列的浮層），got ' + JSON.stringify(menuAfter));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: V3 .ed-te-grip / .ed-te-menu vanish on scroll — OK');
  }
  {
    // ＋ 泡泡：只在距離表格邊界 TB_EDGE_PX(10) 內才升起 —— 欄泡泡在表格
    // 【上緣】、對齊某個表頭儲存格的【右緣】。移到儲存格中央是升不起來的。
    const ctx = await newPage(V3_TABLE_MD);
    await ctx.page.setViewport({ width: 1400, height: 800 });
    const ts = await centreTable(ctx.page);
    const p = await ctx.page.evaluate((t) => {
      const tb = document.querySelector(t + ' table');
      const tr = tb.getBoundingClientRect();
      const cr = tb.tHead.rows[0].cells[0].getBoundingClientRect();
      return { x: cr.right, y: tr.top + 3 };
    }, ts);
    await ctx.page.mouse.move(p.x - 60, p.y);
    await ctx.page.mouse.move(p.x, p.y);
    await new Promise((r) => setTimeout(r, 400));
    const before = await overlayState(ctx.page, '.ed-tb-insert-col');
    assertRaised(before, '.ed-tb-insert');
    await scrollBy(ctx.page, 200);
    const after = await overlayState(ctx.page, '.ed-tb-insert-col');
    assert.ok(isGone(after), '.ed-tb-insert 捲動後必須消失，got ' + JSON.stringify(after));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: V3 .ed-tb-insert vanishes on scroll — OK');
  }

  // ── gone：.ed-toolbar-menu（H▾ 下拉）────────────────────────────────
  {
    const ctx = await newPage('# H\n\n' + V3_FILL + '\n');
    await ctx.page.setViewport({ width: 1400, height: 800 });
    await ctx.page.click('.ed-block[data-block-id="0"] .ed-wys-armed');
    await ctx.page.click('[data-ed-tb="headings"]');
    await ctx.page.waitForSelector('.ed-toolbar-menu', { timeout: 4000 });
    const before = await overlayState(ctx.page, '.ed-toolbar-menu');
    assertRaised(before, '.ed-toolbar-menu');
    await scrollBy(ctx.page, 300);
    const after = await overlayState(ctx.page, '.ed-toolbar-menu');
    assert.ok(isGone(after), '.ed-toolbar-menu 捲動後必須消失，got ' + JSON.stringify(after));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: V3 .ed-toolbar-menu vanishes on scroll — OK');
  }

  // ── reposition-or-gone：.ed-seltb ───────────────────────────────────
  // 兩件事：位置行為（捲一點跟著走、整個捲出視窗才消失）＋【資料完整性】
  // （捲動後在那個滯留位置按下去，磁碟不得改變）。
  //
  // 資料完整性那一條上面「the floating format bar cannot act on off-screen
  // text」也在守，但那是【那一個場景】自己的斷言 —— 它哪天被整理掉，這張表
  // 就什麼都不剩了。brief 要求它「列進表以免被拆掉」，所以這裡自己做一次真的
  // 點擊與比對，而不是用註解指向別人。
  {
    for (const dy of [60, 3000]) {
      const ctx = await newPage(V3_TABLE_MD);
      await ctx.page.setViewport({ width: 1400, height: 800 });
      await ctx.page.evaluate(() => {
        const el = document.querySelector('.ed-block[data-block-id="5"] .ed-wys-armed');
        el.scrollIntoView({ block: 'center' });
        const r = document.createRange();
        r.selectNodeContents(el);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        el.focus();
        document.dispatchEvent(new Event('selectionchange'));
      });
      await new Promise((r) => setTimeout(r, 350));
      const before = await overlayState(ctx.page, '.ed-seltb');
      assertRaised(before, '.ed-seltb');
      await scrollBy(ctx.page, dy);
      const after = await overlayState(ctx.page, '.ed-seltb');
      if (dy === 60) {
        assert.ok(isLive(after),
          '.ed-seltb 選取仍在視窗內時必須留著（純隱藏會讓它永遠回不來），got ' + JSON.stringify(after));
        assert.strictEqual(after.top, before.top - dy,
          '.ed-seltb 必須跟著選取一起移動 ' + dy + 'px，got top=' + after.top + ' was ' + before.top);
      } else {
        assert.ok(isGone(after),
          '.ed-seltb 選取整個捲出視窗後必須消失，got ' + JSON.stringify(after));
        // 資料完整性：在浮動列【原本】的位置真的按一下，磁碟不得改變。
        // 磁碟基準直接讀檔、不走 saveAndRead()：Ctrl+S 會先跑
        // switchAwayFrom()，那本身就會收掉這次 burst，基準就不再是「捲動前」
        // 的狀態（同上面那個既有場景的 fixture note）。
        assert.ok(before.top > 60,
          'V3 前提失敗：.ed-seltb 原本的位置落在工具列高度內（top=' + before.top +
          '），等一下那一下會按到工具列而不是滯留的浮動列');
        const diskBefore = fs.readFileSync(ctx.mdPath, 'utf8');
        await ctx.page.mouse.click(before.left + before.w / 2, before.top + before.h / 2);
        await new Promise((r) => setTimeout(r, 300));
        const diskAfter = await saveAndRead(ctx);
        assert.strictEqual(diskAfter, diskBefore,
          '在滯留的 .ed-seltb 位置按下去不得改到文件，got:\n' + diskAfter);
      }
      await ctx.page.close(); ctx.srv.close();
    }
    console.log('journey: V3 .ed-seltb repositions with its selection, then goes — OK');
  }

  // ── gone-on-drag-end × 2：兩個 drop indicator ───────────────────────
  {
    const drags = [
      {
        sel: '.ed-te-drop-indicator',
        why: 'onAnyScroll() 被 tePointer.dragging 的 early-return 整個跳過',
        // 表格列拖曳：從列 grip 起手。
        raise: async (page) => {
          const ts = await centreTable(page);
          const cell = await page.evaluate((t) => {
            const r = document.querySelector(t + ' table').tBodies[0].rows[0].cells[0].getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }, ts);
          await page.mouse.move(cell.x, cell.y);
          await page.waitForSelector('.ed-te-grip-row:not([hidden])', { timeout: 4000 });
          return page.evaluate(() => {
            const r = document.querySelector('.ed-te-grip-row').getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          });
        },
      },
      {
        sel: '.ed-block-drop-indicator',
        why: 'onAnyScroll() 整個跑完，但它做的事都沒有碰到 blockDropIndicator',
        // 區塊拖曳：從 ⠿ 起手。
        raise: async (page) => {
          await page.evaluate(() =>
            document.querySelector('.ed-block[data-block-id="5"]').scrollIntoView({ block: 'center' }));
          await new Promise((r) => setTimeout(r, 150));
          await page.hover('.ed-block[data-block-id="5"]');
          return page.evaluate(() => {
            const r = document.querySelector('.ed-block[data-block-id="5"] .ed-handle').getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          });
        },
      },
    ];
    for (const d of drags) {
      const ctx = await newPage(V3_TABLE_MD);
      await ctx.page.setViewport({ width: 1400, height: 800 });
      const start = await d.raise(ctx.page);
      await ctx.page.mouse.move(start.x, start.y);
      await ctx.page.mouse.down();
      await ctx.page.mouse.move(start.x, start.y + 40);
      await ctx.page.mouse.move(start.x, start.y + 80);
      await new Promise((r) => setTimeout(r, 250));
      const dragging = await overlayState(ctx.page, d.sel);
      assertRaised(dragging, d.sel);
      // 前提 1：原地不動可以被接受的唯一理由是它點不到 —— 把那個理由釘住。
      assert.strictEqual(dragging.pointerEvents, 'none',
        d.sel + ' 必須是 pointer-events:none —— 捲動中它會留在過期座標上，' +
        '能被點到就代表過期的線可以動到資料，got ' + JSON.stringify(dragging));
      // 前提 2：拖曳中的捲動確實不動它（理由見上面表格註解，兩個 indicator
      // 不同）。這件事原本只寫在註解裡、沒有任何斷言看著。
      await scrollBy(ctx.page, 200);
      const midDrag = await overlayState(ctx.page, d.sel);
      assert.ok(isLive(midDrag),
        d.sel + ' 拖曳中的捲動不得讓它消失（它要等放開才收），got ' + JSON.stringify(midDrag));
      assert.strictEqual(midDrag.top, dragging.top,
        d.sel + ' 拖曳中的捲動實測不會移動它（' + d.why + '）—— ' +
        'top 變了代表 onAnyScroll 的行為與這一列的前提不再相符，got top=' +
        midDrag.top + ' was ' + dragging.top);
      // 前提 3：放開之後必須收乾淨。
      await ctx.page.mouse.up();
      await new Promise((r) => setTimeout(r, 600));
      const dropped = await overlayState(ctx.page, d.sel);
      assert.ok(isGone(dropped),
        d.sel + ' 拖曳結束後必須收乾淨，got ' + JSON.stringify(dropped));
      // 前提 4：此後的捲動不得讓它復活。
      await scrollBy(ctx.page, 200);
      const afterScroll = await overlayState(ctx.page, d.sel);
      assert.ok(isGone(afterScroll),
        d.sel + ' 拖曳結束後的捲動不得讓它復活，got ' + JSON.stringify(afterScroll));
      await ctx.page.close(); ctx.srv.close();
    }
    console.log('journey: V3 both drop indicators are inert while stale and gone after the drop — OK');
  }

  // ══ V4: 行內標記的性質測試 ═══════════════════════════════════════════
  // 陳述必須是程式碼【真正擁有】的性質。applyMarkToggle() 是切換不是套用：
  // 選取落在同 tag 既有標記【內】會解包（wholeSelectionMark → unwrapElement），
  // 跨越同 tag 既有標記會擴張並移除（overlappingMarks → extendRangeOverMarks）。
  // 所以性質只對「端點既不在、也不跨越同 tag 既有標記」的選取成立：
  //
  //   套用 → 序列化 → 重新解析，必須產生涵蓋【修剪後】選取的該標記。
  //
  // 推論是另外三個案例，不是這條性質的一部分：全空白 no-op、collapsed
  // no-op、重疊選取移除標記。
  //
  // 生成器涵蓋兩種邊界來源，因為 trimRangeToText() 的字元步進在兩者下走的是
  // 不同的分支（它自己的註解就寫著「實測人類拖曳選取 105 次都不會產生元素
  // 邊界，但編輯器自己的 reselectAndReposition() 會」）：
  //   text     人類拖曳留下的選取 —— startContainer/endContainer 都是 text node
  //   element  reselectAndReposition() 留下的選取 —— 先套斜體，
  //            wrapRangeIn() 回傳的 selectNodeContents(<em>) 讓兩個邊界容器
  //            都變成【元素】。此時端點在 <em> 內、但不在任何 <strong> 內，
  //            所以對 STRONG 而言性質仍然成立。
  //
  // 種子固定，所以失敗永遠可重現；換種子＝換一批案例。
  const V4_SEED = 20261026;
  const v4Rand = (() => {
    let s = V4_SEED;
    return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  })();
  // 只用字母與空白：這條性質測的是【邊界修剪】，不是 markdown 跳脫規則，
  // 而含有 * _ ` [ 的字面文字會讓序列化加上跳脫、把失敗訊息變成另一個題目。
  const V4_TEXT = 'Alpha bravo charlie delta echo foxtrot golf hotel india.';
  const V4_MD = '# H\n\n' + V4_TEXT + '\n\nTail paragraph here.\n';

  async function v4Apply(ctx, start, end, viaItalic) {
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 200));
    const picked = await ctx.page.evaluate((a, z) => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const t = el.firstChild;
      const r = document.createRange();
      r.setStart(t, a); r.setEnd(t, z);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      el.focus();
      document.dispatchEvent(new Event('selectionchange'));
      return { text: r.toString(), startType: r.startContainer.nodeType };
    }, start, end);
    await new Promise((r) => setTimeout(r, 250));
    assert.strictEqual(picked.startType, 3,
      'V4 前提失敗：人類拖曳來源的選取起點必須是 text node，got nodeType ' + picked.startType);
    let boundarySource = 'text';
    if (viaItalic) {
      await ctx.page.click('[data-ed-tb="italic"]');
      await new Promise((r) => setTimeout(r, 350));
      const b = await ctx.page.evaluate(() => {
        const r = window.getSelection().getRangeAt(0);
        return { s: r.startContainer.nodeType, e: r.endContainer.nodeType, text: r.toString() };
      });
      // 這正是這一半案例存在的理由：斷言它真的變成元素邊界。如果哪天
      // reselectAndReposition() 改成留下 text 邊界，這一半就退化成上一半的
      // 重複，而不是安靜地繼續綠著。
      assert.strictEqual(b.s + '/' + b.e, '1/1',
        'V4 前提失敗：套斜體後的選取應是元素邊界（reselectAndReposition），got ' + JSON.stringify(b));
      boundarySource = 'element';
    }
    await ctx.page.click('[data-ed-tb="bold"]');
    await new Promise((r) => setTimeout(r, 350));
    return { picked: picked.text, boundarySource };
  }

  async function v4Commit(ctx) {
    // 點另一個 block 的編輯面就會結束並提交這次 burst（focusout 路徑），
    // 這也是上面「粗體：選取含尾隨空格」案例用的收尾方式。
    await ctx.page.click('.ed-block[data-block-id="0"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 450));
    return saveAndRead(ctx);
  }

  {
    const cases = [];
    for (let i = 0; i < 18; i++) {
      let a, b;
      do {
        a = Math.floor(v4Rand() * V4_TEXT.length);
        b = Math.floor(v4Rand() * V4_TEXT.length);
        if (a > b) { const t = a; a = b; b = t; }
      } while (V4_TEXT.slice(a, b).trim().length === 0);
      cases.push({ a: a, b: b, viaItalic: i >= 12 });
    }
    // 隨機挑出來的切片有沒有真的踩到「前導空白」「尾隨空白」「兩端都有」
    // 「兩端都沒有」四種形狀，是【運氣】—— 第一個試過的種子 (20260905) 的
    // 12 個 text 邊界案例裡一個前導空白都沒有，等於整批都沒考到修剪的那一半。
    // 所以把「四種形狀 × 兩種邊界來源共 8 格都要有人」寫成斷言：換種子的人
    // 會被擋下來，而不是安靜地生出一批不涵蓋修剪的案例。
    const shapeOf = (raw) => ((/^\s/.test(raw) ? 'L' : '') + (/\s$/.test(raw) ? 'T' : '')) || 'N';
    for (const src of [false, true]) {
      const shapes = new Set(cases.filter((c) => c.viaItalic === src)
        .map((c) => shapeOf(V4_TEXT.slice(c.a, c.b))));
      assert.deepStrictEqual(Array.from(shapes).sort(), ['L', 'LT', 'N', 'T'],
        'V4 生成器在 ' + (src ? 'element' : 'text') + ' 邊界來源下必須涵蓋四種空白形狀，got ' +
        JSON.stringify(Array.from(shapes)));
    }
    const bad = [];
    for (const c of cases) {
      const ctx = await newPage(V4_MD);
      const trimmed = V4_TEXT.slice(c.a, c.b).trim();
      const label = '[' + c.a + ',' + c.b + ') ' + JSON.stringify(V4_TEXT.slice(c.a, c.b));
      const r = await v4Apply(ctx, c.a, c.b, c.viaItalic);
      // 序列化：提交把這次 burst 寫回磁碟。
      const disk = await v4Commit(ctx);
      // 重新解析：提交會把 markdown 重新渲染回 DOM，所以【提交之後】的 DOM
      // 才是「序列化 → 重新解析」的結果。這一讀必須在 v4Commit() 之後 ——
      // 提交【之前】讀到的是 applyMarkToggle() 剛剛改過的同一個編輯中節點
      // （用 data-probe 印記量過：提交前印記還在，提交後才變 null，也就是
      // 元素真的被重建了），那個讀法問的是「我剛剛改的 DOM 長什麼樣」，
      // 而磁碟又正是從那個 DOM 序列化出來的 —— 兩者互相蘊含，斷言等於死碼。
      const dom = await ctx.page.evaluate(() => {
        const el = document.querySelector('.ed-block[data-block-id="1"]');
        return el ? Array.from(el.querySelectorAll('strong')).map((s) => s.textContent) : null;
      });
      const marker = c.viaItalic ? '***' : '**';
      const want = marker + trimmed + marker;
      // 三條各自獨立（不是 else if）：磁碟那條沒過的時候，重新解析那條仍然
      // 要有機會自己說話，否則它永遠躲在前一條後面、永遠不會被觀察到。
      if (disk.indexOf(want) === -1) {
        bad.push(label + ' (' + r.boundarySource + ') 序列化缺少 ' + JSON.stringify(want) + '，disk:\n' + disk);
      }
      if (!dom || dom.indexOf(trimmed) === -1) {
        bad.push(label + ' (' + r.boundarySource + ') 重新解析後沒有涵蓋修剪後選取的 <strong>，got ' +
          JSON.stringify(dom));
      }
      if (disk.indexOf('\\*') !== -1) {
        bad.push(label + ' (' + r.boundarySource + ') 出現跳脫的星號，disk:\n' + disk);
      }
      await ctx.page.close(); ctx.srv.close();
    }
    assert.deepStrictEqual(bad, [], 'V4 性質不成立的選取:\n' + bad.join('\n'));
    console.log('journey: V4 mark property holds over ' + cases.length +
      ' generated selections (12 text-boundary, 6 element-boundary) — OK');
  }

  // ── V4 推論 1：全空白選取是 no-op ───────────────────────────────────
  {
    const ctx = await newPage(V4_MD);
    const ws = V4_TEXT.indexOf(' ');
    const r = await v4Apply(ctx, ws, ws + 1, false);
    assert.strictEqual(r.picked, ' ', 'V4 前提失敗：這個案例的選取必須恰好是一個空白');
    const html = await ctx.page.evaluate(() =>
      document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed').innerHTML);
    assert.strictEqual(html.indexOf('<strong>'), -1,
      '全空白選取必須是 no-op（trimRangeToText 回 false），got ' + html);
    const disk = await v4Commit(ctx);
    assert.strictEqual(disk.indexOf('**'), -1, '全空白選取不得寫出任何標記，disk:\n' + disk);
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: V4 corollary — an all-whitespace selection is a no-op — OK');
  }

  // ── V4 推論 2：collapsed 選取是 no-op ───────────────────────────────
  {
    const ctx = await newPage(V4_MD);
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const r = document.createRange();
      r.setStart(el.firstChild, 5); r.collapse(true);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      el.focus();
      document.dispatchEvent(new Event('selectionchange'));
    });
    await new Promise((r) => setTimeout(r, 300));
    const disabled = await ctx.page.evaluate(() =>
      document.querySelector('[data-ed-tb="bold"]').disabled);
    assert.strictEqual(disabled, true, 'collapsed 選取下粗體按鈕必須是 disabled');
    // 上面那條「按鈕必須是 disabled」是【獨立可紅】的一道：把
    // hasFormattableSelection() 的 collapsed 判斷拿掉，它就會紅。
    //
    // 下面用 DOM click 繞過停用狀態，考的是「即使有人硬按下去也不能長出標記」
    // 這個【行為】，而不是任何一道特定的閘門 —— 實測 applyMarkToggle() 裡的
    // `if (range.collapsed) return;` 和它下面的 `if (!trimRangeToText(range))
    // return;` 兩道各自都足以擋下來（把前者拿掉，collapsed 的 range 產不出
    // 任何 parts，trimRangeToText() 回 false，結果一模一樣、仍然沒有
    // <strong>）。所以這段不宣稱它在考前者。
    await ctx.page.evaluate(() => document.querySelector('[data-ed-tb="bold"]').click());
    await new Promise((r) => setTimeout(r, 300));
    const html = await ctx.page.evaluate(() =>
      document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed').innerHTML);
    assert.strictEqual(html.indexOf('<strong>'), -1,
      'collapsed 選取必須是 no-op，got ' + html);
    const disk = await v4Commit(ctx);
    assert.strictEqual(disk.indexOf('**'), -1, 'collapsed 選取不得寫出任何標記，disk:\n' + disk);
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: V4 corollary — a collapsed selection is a no-op — OK');
  }

  // ── V4 推論 3：重疊選取【移除】標記 ─────────────────────────────────
  {
    const ctx = await newPage(V4_MD);
    const start = V4_TEXT.indexOf('bravo');
    await v4Apply(ctx, start, start + 5, false);
    const marked = await ctx.page.evaluate(() =>
      document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed').innerHTML);
    assert.ok(marked.indexOf('<strong>bravo</strong>') !== -1,
      'V4 前提失敗：重疊案例需要先有一個 <strong>bravo</strong>，got ' + marked);
    // 從 <strong> 內部延伸到它【外面】—— 端點跨越既有同 tag 標記，正是性質
    // 明確排除、而推論要求「移除」的那一類。
    const overlapped = await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const st = el.querySelector('strong');
      const r = document.createRange();
      r.setStart(st.firstChild, 2);
      r.setEnd(st.nextSibling, 6);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
      return r.toString();
    });
    assert.ok(overlapped.indexOf('avo') === 0,
      'V4 前提失敗：重疊選取必須真的從 <strong> 內部起頭，got ' + JSON.stringify(overlapped));
    await new Promise((r) => setTimeout(r, 300));
    await ctx.page.click('[data-ed-tb="bold"]');
    await new Promise((r) => setTimeout(r, 350));
    const after = await ctx.page.evaluate(() =>
      document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed').innerHTML);
    assert.strictEqual(after.indexOf('<strong>'), -1,
      '重疊選取必須把整個既有標記移除（extendRangeOverMarks → unwrapElement），got ' + after);
    const disk = await v4Commit(ctx);
    assert.strictEqual(disk.indexOf('**'), -1,
      '重疊選取之後磁碟上不得留下任何 <strong>，disk:\n' + disk);
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: V4 corollary — an overlapping selection removes the mark — OK');
  }

  await browser.close();
}

main().then(() => console.log('editor-journey.test.js OK'))
  .catch((e) => { console.error(e); process.exit(1); });
