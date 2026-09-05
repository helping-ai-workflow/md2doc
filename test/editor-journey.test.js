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

  await browser.close();
}

main().then(() => console.log('editor-journey.test.js OK'))
  .catch((e) => { console.error(e); process.exit(1); });
