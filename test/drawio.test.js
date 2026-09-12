'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const D = require('../lib/drawio.js');

const twoPages = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'drawio-two-pages.drawio'), 'utf8');
const notDrawio = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'not-drawio.xml'), 'utf8');

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

console.log('drawio.test.js OK');
