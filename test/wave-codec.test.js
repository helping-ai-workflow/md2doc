'use strict';
const assert = require('assert');
const C = require('../lib/editor/wave-codec.js');

const SRC = [
  '{ signal: [',
  '  { name: "clk",  wave: "p......" },   // 主時脈',
  "  { name: 'data', wave: 'x.34.5x', data: ['a','b','c'] },",
  ']}',
].join('\n');

// 解析
{
  const r = C.parseSource(SRC);
  assert.strictEqual(r.ok, true, '寬鬆語法必須解析得出來。Got ' + JSON.stringify(r));
  assert.strictEqual(r.doc.signal.length, 2);
  assert.strictEqual(r.doc.signal[0].name, 'clk');
  assert.strictEqual(r.doc.signal[0].wave, 'p......');
  assert.strictEqual(r.doc.signal[1].name, 'data', '單引號字串');
  assert.deepStrictEqual(r.doc.signal[1].data, ['a', 'b', 'c']);
}

// 尾逗號
assert.strictEqual(C.parseSource('{ signal: [ {name:"a",wave:"01"}, ] }').ok, true,
  '尾逗號必須被接受');

// 區塊註解
assert.strictEqual(C.parseSource('{ /* hi */ signal: [] }').ok, true,
  '區塊註解必須被接受');

// 區間
{
  const r = C.parseSource(SRC);
  const span = r.spans.get(JSON.stringify(['signal', 0, 'wave']));
  assert.ok(span, "spans 必須含 ['signal',0,'wave']");
  assert.strictEqual(SRC.slice(span[0], span[1]), '"p......"',
    '區間必須框住整個字串字面值（含引號）。Got ' +
    JSON.stringify(SRC.slice(span[0], span[1])));
}

// 壞掉的來源：回報而不是丟例外
{
  const r = C.parseSource('{ signal: [ {name: } ] }');
  assert.strictEqual(r.ok, false, '壞掉的來源不得回 ok');
  assert.strictEqual(typeof r.offset, 'number', '必須指出位置');
  assert.ok(r.message, '必須有訊息');
}

// ---- 以下為 Task 1 額外釘住的合約（每個值都要有 span、索引用數字） ----

// 每一種值都要有 span，不是只有今天測到的那幾個
{
  const r = C.parseSource(SRC);
  const at = (p) => {
    const s = r.spans.get(JSON.stringify(p));
    assert.ok(s, 'spans 必須含 ' + JSON.stringify(p));
    return SRC.slice(s[0], s[1]);
  };
  assert.strictEqual(at(['signal', 1, 'name']), "'data'", '單引號要原樣框住');
  assert.strictEqual(at(['signal', 1, 'data', 0]), "'a'", '陣列元素也要有 span');
  assert.strictEqual(at(['signal', 1, 'data']), "['a','b','c']", '陣列本身也要有 span');
  assert.strictEqual(at([]), SRC, '根物件的 span 是整份來源');

  const sigSpan = at(['signal']);
  assert.ok(sigSpan.startsWith('[') && sigSpan.endsWith(']'),
    '陣列 span 要含頭尾括號。Got ' + JSON.stringify(sigSpan));
  assert.ok(sigSpan.indexOf('// 主時脈') !== -1,
    'span 內的註解逐字保留（解析器不得改寫來源）');
}

// 陣列索引是數字，不是字串——Task 2 靠這個組同一把鑰匙
{
  const r = C.parseSource(SRC);
  assert.ok(r.spans.get(JSON.stringify(['signal', 0, 'wave'])), '數字索引是規範鍵');
  assert.strictEqual(r.spans.get(JSON.stringify(['signal', '0', 'wave'])), undefined,
    '字串索引不得同時存在，否則兩種鍵會分裂');
}

// 數字、布林、null、巢狀 head/foot/config
{
  const S2 = '{ config: { hscale: 2 }, head: { text: "T" }, foot: null, ok: true }';
  const r = C.parseSource(S2);
  assert.strictEqual(r.ok, true, 'Got ' + JSON.stringify(r));
  assert.strictEqual(r.doc.config.hscale, 2);
  assert.strictEqual(r.doc.head.text, 'T');
  assert.strictEqual(r.doc.foot, null);
  assert.strictEqual(r.doc.ok, true);
  const num = r.spans.get(JSON.stringify(['config', 'hscale']));
  assert.ok(num, "spans 必須含 ['config','hscale']");
  assert.strictEqual(S2.slice(num[0], num[1]), '2', '數字的 span 只框住字面值');
  const nul = r.spans.get(JSON.stringify(['foot']));
  assert.ok(nul, "spans 必須含 ['foot']");
  assert.strictEqual(S2.slice(nul[0], nul[1]), 'null');
}

// 行註解、跳脫字元、\u 逸出
{
  const S3 = '{\n  // lead\n  name: "a\\"b\\u0041\\n", // tail\n}';
  const r = C.parseSource(S3);
  assert.strictEqual(r.ok, true, 'Got ' + JSON.stringify(r));
  assert.strictEqual(r.doc.name, 'a"bA\n', '跳脫必須解開。Got ' + JSON.stringify(r.doc.name));
}

// 巢狀深度：超過上限要「回報」，不得丟 RangeError（Task 2-4 有權不包 try 就呼叫）
{
  const deepOk = C.parseSource('['.repeat(64) + ']'.repeat(64));
  assert.strictEqual(deepOk.ok, true,
    '64 層必須解析得出來。Got ' + JSON.stringify(deepOk.message));

  const tooDeep = C.parseSource('['.repeat(65) + ']'.repeat(65));
  assert.strictEqual(tooDeep.ok, false, '65 層必須被拒絕');
  assert.strictEqual(typeof tooDeep.offset, 'number', '深度錯誤也要指出位置');
  assert.ok(/deep/i.test(tooDeep.message),
    '訊息要說明是巢狀太深。Got ' + JSON.stringify(tooDeep.message));

  const runaway = C.parseSource('['.repeat(10000));
  assert.strictEqual(runaway.ok, false, '一萬個左括號必須回報而不是丟例外');
  assert.strictEqual(typeof runaway.offset, 'number');

  const objects = C.parseSource('{"a":'.repeat(300) + '1' + '}'.repeat(300));
  assert.strictEqual(objects.ok, false, '物件巢狀吃同一條上限');
}

// Unicode 空白不得被吃進裸鍵——吃進去的話 Task 2 查不到 span，改名會靜默失敗
{
  const NBSP = '{ name\u00a0: "clk" }';
  const r1 = C.parseSource(NBSP);
  assert.strictEqual(r1.ok, true, 'Got ' + JSON.stringify(r1));
  assert.deepStrictEqual(Object.keys(r1.doc), ['name'],
    'NBSP 不得成為鍵的一部分。Got ' + JSON.stringify(Object.keys(r1.doc)));
  assert.ok(r1.spans.get(JSON.stringify(['name'])), "spans 必須含 ['name']");

  const IDEO = '{ name\u3000: "clk" }';
  const r2 = C.parseSource(IDEO);
  assert.strictEqual(r2.ok, true, 'Got ' + JSON.stringify(r2));
  assert.deepStrictEqual(Object.keys(r2.doc), ['name'],
    'U+3000 不得成為鍵的一部分。Got ' + JSON.stringify(Object.keys(r2.doc)));

  // 值的位置也一樣當空白——JS 自己就是這樣算的
  const r3 = C.parseSource('{ a:\u00a01, b:\u30002 }');
  assert.strictEqual(r3.ok, true, 'Got ' + JSON.stringify(r3));
  assert.strictEqual(r3.doc.a, 1);
  assert.strictEqual(r3.doc.b, 2);

  // zero-width space 既不是 JS 空白也不是識別字：要響亮地失敗
  const r4 = C.parseSource('{ name\u200b: "clk" }');
  assert.strictEqual(r4.ok, false, 'ZWSP 必須被拒絕，不得併進鍵裡');
  assert.strictEqual(typeof r4.offset, 'number');
}

// 不得出現任何會執行程式碼的 API（使用者的 markdown 不可以變成可執行程式碼）
{
  const fs = require('fs');
  const BANNED = ['eval', 'Function', 'constructor', 'runInNewContext',
    'setTimeout', 'setInterval', 'require(', 'import('];
  // 之後 wave-geometry.js 落地時把它加進這個陣列即可；wave-store / wave-ui
  // 會有正當的 require / setTimeout，那兩個檔案要由它們自己的測試用較窄的清單守。
  const PURE = ['../lib/editor/wave-codec.js'];
  for (const rel of PURE) {
    const src = fs.readFileSync(require.resolve(rel), 'utf8');
    for (const bad of BANNED) {
      assert.strictEqual(src.indexOf(bad), -1,
        rel + ' 不得出現 ' + JSON.stringify(bad) + '（會執行程式碼的拼法一律擋）');
    }
  }
}

console.log('wave-codec.test.js OK');
