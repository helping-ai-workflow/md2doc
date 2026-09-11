'use strict';
// ensureTableBurstOpen() 的「表格在手勢途中被 detach」復原分支：它必須認回
// 使用者真正操作的那張表，或者什麼都不動——絕不准落在鄰居身上。
//
// 三個情境都是【實際用瀏覽器驅動出來的】，共用同一條手勢鏈：表格上方的段落
// 開著髒的 raw 編輯器（⠿ →「MD 原始碼」），然後直接拉表格的列。grip 的
// pointerdown 會 preventDefault()，textarea 不會失焦，所以那份髒編輯是在
// drop 自己的 ensureTableBurstOpen() 裡才被提交的——本 session 的第一次
// render，走整片 .content 重寫，表格因此真的被 detach。
//
//   A 提交後少 5 行、block 數不變，而兩張表相隔正好 5 行
//     → 捕捉到的 startLine 在新文件裡名到【第二張表】。修正前：拉第一張表
//       的列，被重排的是第二張表（螢幕與磁碟都是）。修正後：data-block-id
//       這個 handle 認得回自己，手勢照常完成。
//   B 提交後同時少 5 行【而且】多一個 block（一個段落被拆成兩個）
//     → id 被重編號、startLine 名到鄰居，兩個 handle 都答不出來 → 丟手勢
//       並出 banner，兩張表都不准動。
//   C 兩張【逐字相同】的表格，手勢在第二張上
//     → identity 再強也分不出雙胞胎，捕捉到的 id 落在第一張身上，於是拉第
//       二張表的列、被重排的是第一張。⚠ C 對 v3.3.0 出貨版是【綠的】——那
//       一版只有 startLine 這一個 handle，在這個形狀上它什麼都名不到，於是
//       誤打誤撞地丟掉手勢。C 紅的是【A 的修正自己帶進來的】新危害：多了
//       data-block-id 這個 handle 就多一次猜錯的機會。所以它釘的是「文件裡
//       有兩張候選時一律拒絕猜」這條規則，沒有它，A 的修正是淨負的。

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const puppeteer = require('puppeteer');
const { createEditorServer } = require('../lib/editor/server.js');

const CLIENT_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'client.js'), 'utf8');

async function newPage(browser) {
  const page = await browser.newPage();
  page.on('dialog', (d) => d.accept());
  await page.evaluateOnNewDocument(() => {
    window.__edInflight = 0;
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = String(typeof input === 'string' ? input : (input && input.url) || '');
      if (!/\/api\/(render|save)\b/.test(url)) return origFetch.call(this, input, init);
      window.__edInflight++;
      let settled = false;
      const settle = () => { if (!settled) { settled = true; window.__edInflight--; } };
      return origFetch.call(this, input, init).then(
        (res) => {
          let asked = false;
          ['json', 'text', 'arrayBuffer', 'blob', 'formData'].forEach((m) => {
            if (typeof res[m] !== 'function') return;
            const orig = res[m].bind(res);
            res[m] = function () {
              asked = true;
              return orig().then((v) => { settle(); return v; }, (e) => { settle(); throw e; });
            };
          });
          try {
            const arm = () => { if (!asked) settle(); };
            res.clone().arrayBuffer().then(() => setTimeout(arm, 0), () => setTimeout(arm, 0));
          } catch (e) { settle(); }
          return res;
        },
        (err) => { settle(); throw err; }
      );
    };
  });
  return page;
}

async function settle(page) {
  await page.waitForFunction(() => !window.__edInflight, { timeout: 15000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

// 與 test/editor-client-runtime.test.js 的 openBlockEditor() 同一條路線：
// 點開區塊（起 burst）→ ⠿ 選單 → 「MD 原始碼」。
async function openRaw(page, sel) {
  await page.click(sel);
  await page.waitForFunction(
    (s) => !!document.querySelector(s + ' textarea.ed-raw') ||
      document.activeElement === document.querySelector(s + ' > *'),
    { timeout: 5000 }, sel);
  if (await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), sel)) return;
  await settle(page);
  await page.hover(sel);
  await page.click(sel + ' .ed-handle');
  await page.waitForFunction(
    (s) => document.querySelectorAll(s + ' .ed-handle-menu-btn').length > 0,
    { timeout: 5000 }, sel);
  await page.evaluate((s) => {
    const btn = Array.from(document.querySelectorAll(s + ' .ed-handle-menu-btn'))
      .find((b) => b.textContent === 'MD 原始碼' && !b.hidden);
    if (!btn) throw new Error('MD 原始碼 menu item not found');
    btn.click();
  }, sel);
  await page.waitForSelector(sel + ' textarea.ed-raw', { timeout: 5000 });
}

async function rowGripCoords(page, tableSel, bodyIndex) {
  const box = await page.evaluate((ts, bi) => {
    const r = document.querySelector(ts + ' table').tBodies[0].rows[bi].cells[0].getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, tableSel, bodyIndex);
  await page.mouse.move(box.x, box.y);
  await page.waitForFunction((ts, bi) => {
    const g = document.querySelector('.ed-te-grip-row');
    if (!g || g.hidden) return false;
    const r = document.querySelector(ts + ' table').tBodies[0].rows[bi].getBoundingClientRect();
    const gr = g.getBoundingClientRect();
    return Math.abs((gr.top + gr.height / 2) - (r.top + r.height / 2)) <= 2;
  }, { timeout: 5000 }, tableSel, bodyIndex);
  return page.evaluate(() => {
    const r = document.querySelector('.ed-te-grip-row').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

async function tableTexts(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('.ed-block[data-block-type="table"] table'))
    .map((t) => Array.from(t.rows).map((r) => Array.from(r.cells).map((c) => c.textContent.trim()).join('|'))));
}

// 一次情境：把段落的 raw 編輯器改成 `replacement`（不提交），然後對第
// `tableIndex` 張表格拉一列。回傳兩張表的最終內容、banner 與磁碟內容。
async function runScenario(browser, lines, replacement, tableIndex) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-anchor-'));
  const mdPath = path.join(dir, 'doc.md');
  fs.writeFileSync(mdPath, lines.join('\n'), 'utf8');
  const srv = await createEditorServer({ files: [mdPath], clientJs: CLIENT_SRC });
  try {
    const page = await newPage(browser);
    await page.goto(srv.urlFor(mdPath), { waitUntil: 'networkidle0' });
    const before = await tableTexts(page);

    const pId = await page.evaluate(() =>
      document.querySelector('.ed-block[data-block-type="paragraph"]').getAttribute('data-block-id'));
    const pSel = '.ed-block[data-block-id="' + pId + '"]';
    await openRaw(page, pSel);
    await page.focus(pSel + ' textarea.ed-raw');
    await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
    await page.keyboard.type(replacement);
    assert.strictEqual(
      await page.evaluate((s) => !!document.querySelector(s + ' textarea.ed-raw'), pSel), true,
      'sanity: 拉列之前 raw 編輯器必須還開著而且是髒的');

    const tblSel = await page.evaluate((i) => '.ed-block[data-block-id="' +
      document.querySelectorAll('.ed-block[data-block-type="table"]')[i].getAttribute('data-block-id') + '"]',
      tableIndex);
    const from = await rowGripCoords(page, tblSel, 0);
    const to = await page.evaluate((ts) => {
      const t = document.querySelector(ts + ' table');
      return { x: t.getBoundingClientRect().left, y: t.tBodies[0].rows[1].getBoundingClientRect().bottom };
    }, tblSel);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + (to.x - from.x) / 2, from.y + (to.y - from.y) / 2, { steps: 5 });
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up();
    await settle(page);
    await new Promise((r) => setTimeout(r, 400));

    const after = await tableTexts(page);
    const banner = await page.evaluate(() => {
      const b = document.querySelector('.ed-conflict');
      return b ? b.textContent : null;
    });
    // 證明這次真的走進了「表格已被 detach」的復原分支：只有拉列本身的
    // ensureTableBurstOpen() 會提交那個 raw 編輯器，沒有別的東西被點過。
    assert.ok(await page.evaluate(() => !document.querySelector('textarea.ed-raw')),
      'sanity: 拉列的 ensureTableBurstOpen() 必須已經把 raw 編輯器提交掉');

    await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
    await settle(page);
    await page.keyboard.down('Control'); await page.keyboard.press('KeyS'); await page.keyboard.up('Control');
    await settle(page);
    await new Promise((r) => setTimeout(r, 300));
    const disk = fs.readFileSync(mdPath, 'utf8');
    await page.close();
    return { before, after, banner, disk };
  } finally { srv.close(); }
}

const TWIN = ['| A | B |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |'];
const OTHER = ['| A | B |', '|---|---|', '| 5 | 6 |', '| 7 | 8 |'];

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    // A) 行數位移剛好讓鄰居落在捕捉到的 startLine 上，但 block 數沒變 →
    //    data-block-id 這個 handle 認得回自己，手勢照常完成。
    {
      const r = await runScenario(browser,
        ['P1 line one', 'P1 line two', 'P1 line three', 'P1 line four', 'P1 line five', 'P1 line six', '']
          .concat(TWIN).concat(['']).concat(OTHER).concat(['']),
        'P1 edited', 0);
      assert.deepStrictEqual(r.after[1], ['A|B', '5|6', '7|8'],
        'A: 沒被碰過的鄰居被改寫了（startLine 單獨錨點認錯表）: ' + JSON.stringify(r.after));
      assert.deepStrictEqual(r.after[0], ['A|B', '3|4', '1|2'],
        'A: 被拖的表格沒有完成重排: ' + JSON.stringify(r.after));
      assert.ok(r.disk.includes('| 3 | 4 |\n| 1 | 2 |') && r.disk.includes('| 5 | 6 |\n| 7 | 8 |'),
        'A: 磁碟內容不符: ' + JSON.stringify(r.disk));
      console.log('  A 行數位移（block 數不變）→ 拉列落在自己身上 — OK');
    }
    // B) 提交同時改了行數與 block 數 → 兩個 handle 都認不回來（startLine 落在
    //    鄰居身上，identity 擋下），手勢被丟掉並出 banner，兩張表都不准動。
    {
      const r = await runScenario(browser,
        ['P1 l1', 'P1 l2', 'P1 l3', 'P1 l4', 'P1 l5', 'P1 l6', 'P1 l7', 'P1 l8', '']
          .concat(TWIN).concat(['']).concat(OTHER).concat(['']),
        'a\n\nb', 0);
      assert.deepStrictEqual(r.after, r.before,
        'B: 手勢認錯表格改寫了內容: ' + JSON.stringify(r.after));
      assert.ok(r.banner && r.banner.indexOf('請重試') !== -1,
        'B: 被丟掉的手勢必須出 retry banner, got: ' + JSON.stringify(r.banner));
      console.log('  B 兩個 handle 都認不回來 → 丟手勢 + banner，兩張表不動 — OK');
    }
    // C) 兩張【逐字相同】的表格：identity 再強也分不出雙胞胎，所以 handle
    //    不准替使用者猜——文件裡有兩張候選時一律拒絕。
    {
      const r = await runScenario(browser,
        ['p1 text', 'p2 text', 'p3 text', 'p4 text', '']
          .concat(TWIN).concat(['']).concat(TWIN).concat(['']),
        'q1\n\nq2', 1);
      assert.deepStrictEqual(r.after, r.before,
        'C: 雙胞胎表格之間認錯了: ' + JSON.stringify(r.after));
      assert.ok(r.banner && r.banner.indexOf('請重試') !== -1,
        'C: 無法分辨雙胞胎時必須丟手勢並出 banner, got: ' + JSON.stringify(r.banner));
      console.log('  C 逐字相同的雙胞胎 → 拒絕猜，丟手勢 + banner — OK');
    }
  } finally {
    await browser.close();
  }
  console.log('table-anchor-recovery.test.js: ALL PASS');
}

main().catch((e) => { console.error(e); process.exit(1); });
