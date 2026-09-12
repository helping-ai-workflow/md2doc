'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const D = require('../lib/drawio.js');
const { renderMarkdown } = require('../lib/md2doc.js');

const twoPages = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'drawio-two-pages.drawio'), 'utf8');
const notDrawio = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'not-drawio.xml'), 'utf8');

// renderMarkdown()'s srcDir is derived from its srcPath argument
// (path.dirname), not an opts field — that path need not itself exist, only
// its directory (SRC_DIR is only ever used to resolve relative asset refs
// against, never read itself).
async function renderMdToHtml(md, opts) {
  opts = opts || {};
  const srcDir = opts.srcDir || __dirname;
  const fakeSrcPath = path.join(srcDir, '__drawio_test__.md');
  const { html } = await renderMarkdown(md, fakeSrcPath, {});
  return html;
}

// A baked `.drawio` block nests N `.drawio-page` divs inside the outer div
// (`<div class="drawio" data-drawio-pages="..."><div class="drawio-page">…
// </div>…</div>`), so a naive non-greedy `<div class="drawio"[\s\S]*?<\/div>`
// stops at the FIRST `</div>` it meets — the close of the first inner page,
// not the outer block — and silently truncates every block to its first
// page. Extract by tracking div-nesting depth instead.
function extractDrawioBlocks(html) {
  const out = [];
  const openRe = /<div class="drawio" data-drawio-pages="[^"]*">/g;
  let m;
  while ((m = openRe.exec(html)) !== null) {
    const tagRe = /<div\b[^>]*>|<\/div>/g;
    tagRe.lastIndex = openRe.lastIndex;
    let depth = 1;
    let end = openRe.lastIndex;
    let t;
    while (depth > 0 && (t = tagRe.exec(html)) !== null) {
      depth += t[0] === '</div>' ? -1 : 1;
      end = tagRe.lastIndex;
    }
    out.push(html.slice(m.index, end));
    openRe.lastIndex = end;
  }
  return out;
}

(async () => {

// 判別
assert.strictEqual(D.isDrawioXml(twoPages), true, '<mxfile> 必須被認出來');
assert.strictEqual(D.isDrawioXml(notDrawio), false,
  '根元素是 <catalog> 的 XML 不得被當成 drawio');
assert.strictEqual(D.isDrawioXml('<mxGraphModel><root/></mxGraphModel>'), true,
  '單頁的 <mxGraphModel> 也是 drawio');
assert.strictEqual(D.isDrawioXml(''), false, '空字串不是 drawio');
assert.strictEqual(D.isDrawioXml('not xml at all'), false, '非 XML 不是 drawio');
// 註解與宣告不得干擾判別
assert.strictEqual(
  D.isDrawioXml('<?xml version="1.0"?>\n<!-- hi -->\n<mxfile><diagram/></mxfile>'),
  true, 'XML 宣告與註解在前面時仍須認得出來');

// --- 惡意輸入：前綴相同但不是 drawio 的標籤，不得誤判為真 ---
assert.strictEqual(D.isDrawioXml('<mxfilex></mxfilex>'), false,
  '<mxfilex> 只是前綴撞名，不是 <mxfile>');
assert.strictEqual(D.isDrawioXml('<mxGraphModelFoo/>'), false,
  '<mxGraphModelFoo> 只是前綴撞名，不是 <mxGraphModel>');
assert.strictEqual(D.isDrawioXml('<mxfileWrapper><mxfile/></mxfileWrapper>'), false,
  '真正的根元素是 <mxfileWrapper>，藏在裡面的 <mxfile> 不算數');

// --- 惡意輸入：註解裡藏假的 <mxfile>，根元素其實是別的東西 ---
assert.strictEqual(
  D.isDrawioXml('<!-- pretend this is <mxfile> content --><catalog/>'),
  false, '註解裡出現 <mxfile> 字樣不可以讓判別失準，根元素其實是 <catalog>');
assert.strictEqual(
  D.isDrawioXml('<!-- a --><!-- b: <mxGraphModel> --><!-- c --><mxfile></mxfile>'),
  true, '連續多個註解都要被跳過，真正根元素是最後的 <mxfile>');

// --- 惡意輸入：DOCTYPE / 註解 / 宣告以任意順序混雜在前面 ---
assert.strictEqual(
  D.isDrawioXml('  \n<!DOCTYPE foo>\n<!-- c1 --><?xml version="1.0"?>\n<mxfile></mxfile>'),
  true, 'DOCTYPE、註解、XML 宣告不論出現順序都要能跳過');

// --- 惡意輸入：自我封閉、沒有屬性也沒有子節點的根標籤 ---
assert.strictEqual(D.isDrawioXml('<mxfile/>'), true,
  '沒有屬性、自我封閉的 <mxfile/> 仍然是 drawio');
assert.strictEqual(D.isDrawioXml('<mxGraphModel/>'), true,
  '沒有屬性、自我封閉的 <mxGraphModel/> 仍然是 drawio');

// 頁名
assert.deepStrictEqual(D.pageNamesOf(twoPages), ['Architecture', 'Flow']);
assert.deepStrictEqual(D.pageNamesOf('<mxGraphModel><root/></mxGraphModel>'), [''],
  '單頁檔回一個空名字，代表「有一頁、沒有名字」');

// --- 惡意輸入：<diagram> 沒有 name 屬性，要回空字串而不是 undefined ---
assert.deepStrictEqual(
  D.pageNamesOf('<mxfile><diagram id="p1"><mxGraphModel/></diagram></mxfile>'),
  [''], '<diagram> 缺 name 屬性時要回空字串，之後 resolvePageIndex 用 indexOf 比對才不會炸掉');
assert.strictEqual(
  D.pageNamesOf('<mxfile><diagram id="p1"><mxGraphModel/></diagram></mxfile>')[0],
  '', '缺 name 屬性的頁名必須是空字串，不能是 undefined');

// --- 惡意輸入：mxfile 前面也混雜 DOCTYPE，頁名解析要能穿過去看到 <diagram> ---
assert.deepStrictEqual(
  D.pageNamesOf('<!DOCTYPE foo>\n<mxfile><diagram name="X"/></mxfile>'),
  ['X'], 'DOCTYPE 在 <mxfile> 前面時，頁名解析仍要正確找到 <diagram name>');

// fragment 解析
const names = ['Architecture', 'Flow'];
assert.strictEqual(D.resolvePageIndex(names, 'Flow'), 1, '頁名');
assert.strictEqual(D.resolvePageIndex(names, '2'), 1, '1-based 數字');
assert.strictEqual(D.resolvePageIndex(names, '1'), 0);
assert.strictEqual(D.resolvePageIndex(names, ''), 0, '沒有 fragment 就是第一頁');
assert.strictEqual(D.resolvePageIndex(names, 'Nope'), 0,
  '解不出來的頁名退回第一頁，不丟例外');
assert.strictEqual(D.resolvePageIndex(names, '99'), 0,
  '超出範圍的數字退回第一頁');
assert.strictEqual(D.resolvePageIndex(names, '0'), 0,
  '0 不是合法的 1-based 頁碼，退回第一頁');

// 烤 SVG（需要 Chromium，比上面的純函式慢，放在檔案最後）
{
  const svgs = await D.bakeDrawioSvg(twoPages);
  assert.strictEqual(svgs.length, 2, '兩頁必須各得到一份 SVG');
  assert.ok(/^<svg[\s>]/.test(svgs[0].trim()), '第一頁必須是 <svg> 開頭');
  assert.ok(svgs[0].includes('ARCH_BOX'),
    '第一頁的 SVG 必須含第一頁的內容。Got: ' + svgs[0].slice(0, 200));
  assert.ok(svgs[1].includes('FLOW_BOX'),
    '第二頁的 SVG 必須含第二頁的內容。Got: ' + svgs[1].slice(0, 200));
  assert.ok(!svgs[0].includes('FLOW_BOX'),
    '第一頁不得混進第二頁的內容');

  for (const svg of svgs) {
    assert.ok(!/viewer\.diagrams\.net/.test(svg),
      '烤出來的 SVG 不得含任何 viewer.diagrams.net 的 URL —— 那會讓離線破圖');
    assert.ok(!/<script/i.test(svg),
      '烤出來的 SVG 不得含 <script>');
  }
}

// 壞掉的來源：回報而不是靜默給空白
{
  let threw = null;
  try { await D.bakeDrawioSvg('<mxfile><diagram>NOT XML</diagram></mxfile>'); }
  catch (e) { threw = e; }
  assert.ok(threw, '壞掉的來源必須丟出可辨識的錯誤，不得靜默回空白');
}

// ── Task 4: 端到端 —— renderer.image 判別 + bakeDrawio post-pass ──────────

// 端到端：從 markdown 到 HTML
{
  const html = await renderMdToHtml(
    '# Doc\n\n![arch](drawio-two-pages.drawio)\n\n![flow](drawio-two-pages.drawio#Flow)\n',
    { srcDir: path.join(__dirname, 'fixtures') });

  assert.ok(!html.includes('data-drawio-src'),
    '烤完之後不得留下未處理的佔位元素');
  assert.ok(!html.includes('viewer-static'),
    '輸出的 HTML 不得夾帶 viewer');
  assert.ok(!/viewer\.diagrams\.net/.test(html),
    '輸出的 HTML 不得含任何 diagrams.net 的 URL');

  const blocks = extractDrawioBlocks(html);
  assert.strictEqual(blocks.length, 2, '兩個圖片參照 → 兩個 drawio 區塊');

  // 第一個沒有 fragment → 顯示第一頁
  assert.ok(/<svg[^>]*>(?:(?!hidden)[\s\S])*?ARCH_BOX/.test(blocks[0]) ||
            blocks[0].indexOf('ARCH_BOX') < blocks[0].indexOf('FLOW_BOX'),
    '第一個區塊預設顯示 Architecture');
  assert.strictEqual((blocks[0].match(/<svg/g) || []).length, 2,
    '多頁必須全部烤進去（切頁不需要引擎）');
  assert.strictEqual((blocks[0].match(/hidden/g) || []).length, 1,
    '兩頁中恰好一頁沒有 hidden');

  // #Flow → 第二頁是可見的那一頁。
  // 注意：`hidden` 屬性長在包住每一頁的 `<div class="drawio-page">` 上，不在
  // `<svg>` 標籤本身（產出是 `<div class="drawio-page"[ hidden]><svg>…`）—— 用
  // `.split(/<svg/)` 之後往後找 `hidden` 找不到東西，因為它在 `<svg` 之前，不
  // 是之後。改成切 `<div class="drawio-page"` 本身：沒有 hidden 的那一頁在切
  // 開後緊接著就是 `>`，有 hidden 的則是 ` hidden>`。
  const pageSegments = blocks[1].split('<div class="drawio-page"').slice(1);
  const visibleOfSecond = pageSegments.findIndex((s) => s.startsWith('>'));
  assert.strictEqual(visibleOfSecond, 1,
    '#Flow 必須讓第二頁成為可見的那一頁。Got index ' + visibleOfSecond);
}

// 不是 drawio 的 .xml → 行為與今天完全相同
{
  const html = await renderMdToHtml('![x](not-drawio.xml)\n',
    { srcDir: path.join(__dirname, 'fixtures') });
  assert.ok(!html.includes('class="drawio"'),
    '根元素不是 mxfile 的 XML 不得被當成 drawio');
  assert.ok(html.includes('not-drawio.xml'),
    '它必須維持今天的行為：原樣留著那個參照');
}

// 烤製失敗必須留下看得見的佔位，不能靜默變空白
{
  const badDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'md2doc-drawio-bad-'));
  fs.writeFileSync(path.join(badDir, 'bad.drawio'),
    '<mxfile><diagram name="Bad">NOT XML</diagram></mxfile>', 'utf8');
  const html = await renderMdToHtml('![bad](bad.drawio)\n', { srcDir: badDir });
  assert.ok(!html.includes('data-drawio-src'),
    '失敗也要走過 bake post-pass，不得留下未處理的佔位元素');
  assert.ok(html.includes('drawio-failed'),
    '渲染失敗必須留下帶有 drawio-failed class 的可見佔位元素');
  assert.ok(/<div class="drawio drawio-failed"><p>[^<]+<\/p><\/div>/.test(html),
    '佔位元素必須帶錯誤訊息文字，不能是空白');
  fs.rmSync(badDir, { recursive: true, force: true });
}

// 沒有 drawio 的文件不得因此開瀏覽器：makeLazyBrowserRef().get() 全程不得被呼叫
{
  const md2doc = require('../lib/md2doc.js');
  // 探針：monkey-patch puppeteer.launch 來偵測是否有人嘗試開瀏覽器。
  // bakeDrawio()/makeLazyBrowserRef() 只有在 data-drawio-src 出現時才會
  // require('puppeteer')，所以這裡直接檢查 require.cache 不夠可靠（其他測試
  // 檔可能已經載入過 puppeteer）；改用計數變數配合 monkey-patch launch()。
  const puppeteer = require('puppeteer');
  let launchCount = 0;
  const origLaunch = puppeteer.launch;
  puppeteer.launch = function (...args) {
    launchCount++;
    return origLaunch.apply(this, args);
  };
  try {
    const html = await renderMdToHtml('# No drawio here\n\nJust text and a normal image reference.\n');
    assert.ok(html.includes('No drawio here'));
    assert.strictEqual(launchCount, 0,
      '沒有 drawio 參照的文件渲染不得開啟瀏覽器，got launchCount=' + launchCount);
  } finally {
    puppeteer.launch = origLaunch;
  }
}

console.log('drawio.test.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
