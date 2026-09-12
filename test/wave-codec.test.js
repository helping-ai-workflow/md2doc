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

// 不得用 eval / new Function
{
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../lib/editor/wave-codec.js'), 'utf8');
  assert.ok(!/\beval\s*\(/.test(src), '不得使用 eval');
  assert.ok(!/new\s+Function\b/.test(src), '不得使用 new Function');
}

console.log('wave-codec.test.js OK');
