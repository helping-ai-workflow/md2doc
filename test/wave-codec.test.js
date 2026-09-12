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
  // 這個陣列只收「連 require 都沒有」的檔案。wave-geometry.js 已經落地，但它
  // **不能**加進來：它正當地 require 了本檔（lane 的順序只能有一份），會撞到
  // 下面的 `require(`。它由 test/wave-geometry.test.js 用同一份 BANNED 減掉
  // `require(`、外加一條 DOM 樣式與一份 require 白名單來守。wave-store / wave-ui
  // 之後也會有正當的 require / setTimeout，同樣各自用較窄的清單守，別加到這裡。
  const PURE = ['../lib/editor/wave-codec.js'];
  for (const rel of PURE) {
    const src = fs.readFileSync(require.resolve(rel), 'utf8');
    for (const bad of BANNED) {
      assert.strictEqual(src.indexOf(bad), -1,
        rel + ' 不得出現 ' + JSON.stringify(bad) + '（會執行程式碼的拼法一律擋）');
    }
  }
}

// ---- 以下為 Task 2 釘住的合約（最小 patch 寫回、member span、結構性操作） ----

// 最小 patch：只有目標區間變，其餘逐字不動
{
  const r = C.parseSource(SRC);
  const out = C.patchSource(SRC, r, [{ path: ['signal', 0, 'wave'], value: 'p..x...' }]);
  assert.strictEqual(out.ok, true, 'Got ' + JSON.stringify(out));
  assert.ok(out.text.includes('// 主時脈'), '註解必須原樣留著');
  assert.ok(out.text.includes("'data'"), '單引號風格必須原樣留著');
  assert.ok(out.text.includes('wave: "p..x..."'),
    '目標必須被換掉，而且沿用原本的雙引號。Got ' + JSON.stringify(out.text));

  // 逐字比對：除了那一段，其他位元組完全相同
  const span = r.spans.get(JSON.stringify(['signal', 0, 'wave']));
  assert.strictEqual(out.text.slice(0, span[0]), SRC.slice(0, span[0]),
    '目標區間之前的位元組必須完全不變');
  assert.strictEqual(out.text.slice(out.text.length - (SRC.length - span[1])),
    SRC.slice(span[1]),
    '目標區間之後的位元組必須完全不變');
}

// 多筆編輯（由後往前套，才不會讓前面的區間位移）
{
  const r = C.parseSource(SRC);
  const out = C.patchSource(SRC, r, [
    { path: ['signal', 0, 'wave'], value: '0101010' },
    { path: ['signal', 1, 'name'], value: 'DATA' },
  ]);
  assert.strictEqual(out.ok, true, 'Got ' + JSON.stringify(out));
  assert.ok(out.text.includes('wave: "0101010"'));
  assert.ok(out.text.includes("name: 'DATA'"), '第二筆必須沿用它自己的單引號風格');
  assert.ok(out.text.includes('// 主時脈'), '註解仍在');
}

// 結構性改變（新增一個 lane）無法只做局部替換 → 誠實回報
{
  const r = C.parseSource(SRC);
  const out = C.patchSource(SRC, r, [
    { path: ['signal', 2], value: { name: 'new', wave: '01' } },
  ]);
  assert.strictEqual(out.ok, false,
    '插入新元素不是局部替換，必須誠實回報而不是靜默重寫');
  assert.ok(out.rewroteRange, '必須說明它想動哪一段');
  const sig = r.spans.get(JSON.stringify(['signal']));
  assert.strictEqual(out.rewroteRange.start, sig[0],
    '找不到自己的 span 時要回報最近的祖先區間');
  assert.strictEqual(out.rewroteRange.end, sig[1]);
}

// 型別改變（字串 → 陣列）也是結構性改變
{
  const r = C.parseSource(SRC);
  const out = C.patchSource(SRC, r, [{ path: ['signal', 0, 'wave'], value: ['0', '1'] }]);
  assert.strictEqual(out.ok, false, '型別換掉不是局部替換');
  assert.ok(/type|型別/i.test(out.reason), 'reason 要說明是型別。Got ' + out.reason);
  const span = r.spans.get(JSON.stringify(['signal', 0, 'wave']));
  assert.strictEqual(out.rewroteRange.start, span[0]);
  assert.strictEqual(out.rewroteRange.end, span[1]);
}

// 0..0 與 0... 在 wavedrom 是不同的波形：寫回必須逐位元組忠實，不得整理
{
  const r = C.parseSource(SRC);
  for (const w of ['0..0', '0...', 'p.n.', 'x.=.2.']) {
    const out = C.patchSource(SRC, r, [{ path: ['signal', 0, 'wave'], value: w }]);
    assert.strictEqual(out.ok, true, 'Got ' + JSON.stringify(out));
    assert.ok(out.text.includes('wave: "' + w + '"'),
      '波形字串必須逐字寫回。Got ' + JSON.stringify(out.text));
    const again = C.parseSource(out.text);
    assert.strictEqual(again.ok, true, '寫回的結果必須還能解析');
    assert.strictEqual(again.doc.signal[0].wave, w, '來回一趟不得改變波形');
    assert.strictEqual(again.doc.signal[1].wave, 'x.34.5x', '別條 lane 不得被動到');
  }
}

// member span：框住鍵、冒號、值與尾逗號，但不含前導縮排與上一行的註解
{
  const M = [
    '{',
    '  // lead comment: not part of the member',
    '  name: "clk", // tail',
    '  wave: "p..",',
    '}',
  ].join('\n');
  const r = C.parseSource(M);
  assert.strictEqual(r.ok, true, 'Got ' + JSON.stringify(r));
  assert.ok(r.members instanceof Map, 'parseSource 必須回傳 member span 表');

  const mName = r.members.get(JSON.stringify(['name']));
  assert.ok(mName, "members 必須含 ['name']");
  assert.strictEqual(M.slice(mName[0], mName[1]), 'name: "clk",',
    'member span 含鍵、冒號、值與尾逗號。Got ' + JSON.stringify(M.slice(mName[0], mName[1])));

  const mWave = r.members.get(JSON.stringify(['wave']));
  assert.strictEqual(M.slice(mWave[0], mWave[1]), 'wave: "p..",');

  // 沒有尾逗號時，member 在值的最後一個字元收尾
  const N = '{ a: 1, b: 2 }';
  const rn = C.parseSource(N);
  assert.strictEqual(N.slice(...rn.members.get(JSON.stringify(['a']))), 'a: 1,');
  assert.strictEqual(N.slice(...rn.members.get(JSON.stringify(['b']))), 'b: 2');

  // 值與逗號之間的註解在 member span 裡面（它跟著那一筆走）
  const P = '{ a: 1 /* keep */, b: 2 }';
  const rp = C.parseSource(P);
  assert.strictEqual(P.slice(...rp.members.get(JSON.stringify(['a']))), 'a: 1 /* keep */,');

  // 陣列元素也有 member span，而且逗號寫在註解裡不會被當成分隔符
  const Q = "['a' /* , keep me */, 'b']";
  const rq = C.parseSource(Q);
  assert.deepStrictEqual(rq.doc, ['a', 'b'], 'Got ' + JSON.stringify(rq));
  assert.strictEqual(Q.slice(...rq.members.get(JSON.stringify([0]))), "'a' /* , keep me */,");
  assert.strictEqual(Q.slice(...rq.members.get(JSON.stringify([1]))), "'b'");
}

// 插入一條 lane 是局部 splice，不是整份重寫
{
  const r = C.parseSource(SRC);
  const out = C.patchSource(SRC, r, [
    { op: 'insert', path: ['signal', 1], value: { name: 'mid', wave: '01' } },
  ]);
  assert.strictEqual(out.ok, true, 'Got ' + JSON.stringify(out));
  assert.ok(out.text.includes('// 主時脈'), '插入不得動到別人的註解');
  assert.ok(out.text.includes("{ name: 'data', wave: 'x.34.5x', data: ['a','b','c'] },"),
    '被推後的那一筆必須逐字不動。Got ' + JSON.stringify(out.text));
  const again = C.parseSource(out.text);
  assert.strictEqual(again.ok, true, '插入後必須還能解析。Got ' + JSON.stringify(again));
  assert.strictEqual(again.doc.signal.length, 3);
  assert.strictEqual(again.doc.signal[1].name, 'mid');
  assert.strictEqual(again.doc.signal[2].name, 'data', '原本的第二筆被推到第三筆');
  assert.strictEqual(again.doc.signal[0].wave, 'p......', '第一筆不得被動到');

  // 插在尾端
  const tail = C.patchSource(SRC, r, [
    { op: 'insert', path: ['signal', 2], value: { name: 'last', wave: '10' } },
  ]);
  assert.strictEqual(tail.ok, true, 'Got ' + JSON.stringify(tail));
  const t2 = C.parseSource(tail.text);
  assert.strictEqual(t2.ok, true, 'Got ' + JSON.stringify(t2));
  assert.deepStrictEqual(t2.doc.signal.map((s) => s.name), ['clk', 'data', 'last']);
  assert.ok(tail.text.includes('// 主時脈'), '尾端插入也不得動到註解');

  // 插進空陣列
  const E = '{ signal: [] }';
  const re = C.parseSource(E);
  const eo = C.patchSource(E, re, [
    { op: 'insert', path: ['signal', 0], value: { name: 'only', wave: '0' } },
  ]);
  assert.strictEqual(eo.ok, true, 'Got ' + JSON.stringify(eo));
  const e2 = C.parseSource(eo.text);
  assert.strictEqual(e2.ok, true, 'Got ' + JSON.stringify(e2));
  assert.deepStrictEqual(e2.doc.signal.map((s) => s.name), ['only']);

  // 索引超出範圍：拒絕，不是往後補洞
  const bad = C.patchSource(SRC, r, [
    { op: 'insert', path: ['signal', 9], value: { name: 'x', wave: '0' } },
  ]);
  assert.strictEqual(bad.ok, false, '索引超出範圍必須拒絕');
  assert.ok(bad.rewroteRange, '必須說明它想動哪一段');
}

// 尾端插入：行尾的註解留在原本那條 lane 身上，不得漂到新的那條
{
  const A = ['{ signal: [', '  { name: "clk", wave: "p." },  // 主時脈', ']}'].join('\n');
  const ra = C.parseSource(A);
  const oa = C.patchSource(A, ra, [
    { op: 'insert', path: ['signal', 1], value: { name: 'x', wave: '0' } },
  ]);
  assert.strictEqual(oa.ok, true, 'Got ' + JSON.stringify(oa));
  assert.ok(oa.text.includes('{ name: "clk", wave: "p." },  // 主時脈'),
    '原本那一行必須逐字不動。Got ' + JSON.stringify(oa.text));
  const pa = C.parseSource(oa.text);
  assert.strictEqual(pa.ok, true, 'Got ' + JSON.stringify(pa));
  assert.deepStrictEqual(pa.doc.signal.map((x) => x.name), ['clk', 'x']);

  // 沒有尾逗號時，逗號要補在註解前面（補在後面會被註解吃掉，整段就解析不了）
  const B = ['{ signal: [', '  { name: "clk", wave: "p." }  // 主時脈', ']}'].join('\n');
  const rb = C.parseSource(B);
  const ob = C.patchSource(B, rb, [
    { op: 'insert', path: ['signal', 1], value: { name: 'x', wave: '0' } },
  ]);
  assert.strictEqual(ob.ok, true, 'Got ' + JSON.stringify(ob));
  const pb = C.parseSource(ob.text);
  assert.strictEqual(pb.ok, true,
    '補逗號之後必須還能解析。Got ' + JSON.stringify(pb) + ' from ' + JSON.stringify(ob.text));
  assert.deepStrictEqual(pb.doc.signal.map((x) => x.name), ['clk', 'x']);
  assert.ok(ob.text.includes('// 主時脈'), '註解必須逐字留著');
  assert.ok(ob.text.indexOf('// 主時脈,') === -1, '逗號不得被塞進註解裡');
}

// 刪除一條 lane 是局部 splice
{
  const r = C.parseSource(SRC);
  const out = C.patchSource(SRC, r, [{ op: 'remove', path: ['signal', 1] }]);
  assert.strictEqual(out.ok, true, 'Got ' + JSON.stringify(out));
  assert.ok(out.text.includes('// 主時脈'), '刪除不得動到別人的註解');
  assert.ok(out.text.indexOf("'x.34.5x'") === -1, '被刪的那一筆必須真的不見了');
  const again = C.parseSource(out.text);
  assert.strictEqual(again.ok, true, '刪除後必須還能解析。Got ' + JSON.stringify(again));
  assert.strictEqual(again.doc.signal.length, 1);
  assert.strictEqual(again.doc.signal[0].wave, 'p......', '留下的那一筆逐字不動');

  // 刪掉第一筆時，寫在它同一行的註解跟著它一起走（詳細情況見 F4 那一塊）
  const first = C.patchSource(SRC, r, [{ op: 'remove', path: ['signal', 0] }]);
  assert.strictEqual(first.ok, true, 'Got ' + JSON.stringify(first));
  const f2 = C.parseSource(first.text);
  assert.strictEqual(f2.ok, true, 'Got ' + JSON.stringify(f2));
  assert.deepStrictEqual(f2.doc.signal.map((s) => s.name), ['data']);
  assert.ok(first.text.indexOf('// 主時脈') === -1,
    '那條 lane 自己那一行的註解不得被留下來描述別人。Got ' + JSON.stringify(first.text));

  // 刪掉一個物件成員
  const ro = C.parseSource(SRC);
  const dm = C.patchSource(SRC, ro, [{ op: 'remove', path: ['signal', 1, 'data'] }]);
  assert.strictEqual(dm.ok, true, 'Got ' + JSON.stringify(dm));
  const d2 = C.parseSource(dm.text);
  assert.strictEqual(d2.ok, true, 'Got ' + JSON.stringify(d2));
  assert.strictEqual(d2.doc.signal[1].data, undefined);
  assert.strictEqual(d2.doc.signal[1].wave, 'x.34.5x', '同一個物件裡的別人不得被動到');
}

// 重複鍵：set 仍可用（span 與 doc 指的是同一個），但 member 級刪除必須拒絕
{
  const D = '{ a: {b: 1}, a: 2 }';
  const r = C.parseSource(D);
  assert.strictEqual(r.ok, true, 'Got ' + JSON.stringify(r));
  assert.strictEqual(r.doc.a, 2, '後寫的贏');

  const setOk = C.patchSource(D, r, [{ path: ['a'], value: 3 }]);
  assert.strictEqual(setOk.ok, true, '重複鍵不擋 set。Got ' + JSON.stringify(setOk));
  assert.strictEqual(C.parseSource(setOk.text).doc.a, 3);

  const del = C.patchSource(D, r, [{ op: 'remove', path: ['a'] }]);
  assert.strictEqual(del.ok, false, '重複鍵的 member 級刪除必須拒絕，不得亂切');
  assert.ok(/duplicate|重複/i.test(del.reason), 'reason 要說明原因。Got ' + del.reason);
  assert.ok(del.rewroteRange, '必須說明它想動哪一段');

  // 祖先是重複鍵時，底下的路徑一樣不安全
  const inner = C.patchSource(D, r, [{ op: 'remove', path: ['a', 'b'] }]);
  assert.strictEqual(inner.ok, false, '祖先重複時底下的 member 也不得被切掉');
}

// 新值不得是 undefined：寧可拒絕也不寫出去
{
  const r = C.parseSource(SRC);
  // 對照組：同一條路徑給一個真的值必須成功，否則下面的「拒絕」只是因為它什麼都拒絕
  assert.strictEqual(
    C.patchSource(SRC, r, [{ path: ['signal', 0, 'name'], value: 'CLK' }]).ok, true,
    '對照組：一般的 set 必須成功');

  const out = C.patchSource(SRC, r, [{ path: ['signal', 0, 'name'], value: undefined }]);
  assert.strictEqual(out.ok, false, 'undefined 不得被寫進來源');
  assert.ok(out.text === undefined, '拒絕時不得回傳 text');

  const ins = C.patchSource(SRC, r, [
    { op: 'insert', path: ['signal', 2], value: { name: 'x', wave: undefined } },
  ]);
  assert.strictEqual(ins.ok, false, '巢狀的 undefined 也不得被寫出去');
}

// 引號風格：沿用原區間的引號，另一種引號不得被跳脫
{
  const r = C.parseSource(SRC);
  const out = C.patchSource(SRC, r, [{ path: ['signal', 1, 'name'], value: 'he said "hi"' }]);
  assert.strictEqual(out.ok, true, 'Got ' + JSON.stringify(out));
  assert.ok(out.text.includes("name: 'he said \"hi\"'"),
    '單引號區間要沿用單引號，裡面的雙引號不必跳脫。Got ' + JSON.stringify(out.text));
  assert.strictEqual(C.parseSource(out.text).doc.signal[1].name, 'he said "hi"');

  // 同一種引號與反斜線要跳脫
  const q = C.patchSource(SRC, r, [{ path: ['signal', 0, 'name'], value: 'a"b\\c\nd' }]);
  assert.strictEqual(q.ok, true, 'Got ' + JSON.stringify(q));
  assert.strictEqual(C.parseSource(q.text).doc.signal[0].name, 'a"b\\c\nd',
    '來回一趟必須還原成同一個字串');
}

// 交疊的編輯必須拒絕（刪掉一整筆、又去改它裡面的欄位）
{
  const r = C.parseSource(SRC);
  const out = C.patchSource(SRC, r, [
    { op: 'remove', path: ['signal', 0] },
    { path: ['signal', 0, 'wave'], value: '1' },
  ]);
  assert.strictEqual(out.ok, false, '兩筆編輯蓋到同一段，必須拒絕');
  assert.ok(/overlap|交疊/i.test(out.reason), 'reason 要說明是交疊。Got ' + out.reason);
  assert.ok(out.rewroteRange, '必須說明它想動哪一段');
}

// 壞掉的 parse 結果、壞掉的 edits：拒絕而不是丟例外
{
  const bad = C.parseSource('{ signal: [ {name: } ] }');
  const out = C.patchSource('{ signal: [ {name: } ] }', bad, [
    { path: ['signal', 0, 'name'], value: 'x' },
  ]);
  assert.strictEqual(out.ok, false, '沒解析成功就不能 patch');

  const r = C.parseSource(SRC);
  assert.strictEqual(C.patchSource(SRC, r, 'nope').ok, false, 'edits 必須是陣列');
  assert.strictEqual(C.patchSource(SRC, r, [{ path: 'signal', value: 1 }]).ok, false,
    'path 必須是陣列');
  assert.strictEqual(C.patchSource(SRC, r, [{ op: 'nope', path: ['signal'] }]).ok, false,
    '不認得的 op 必須拒絕');

  const empty = C.patchSource(SRC, r, []);
  assert.strictEqual(empty.ok, true, '空的 edits 是合法的');
  assert.strictEqual(empty.text, SRC, '空的 edits 必須逐字回傳原文');
}

// ---- 以下為 fix round 1（review F1-F12 + Q1）釘住的合約 ----

// F1：值太深、或值自我循環時必須拒絕，不得丟 RangeError
{
  const r = C.parseSource(SRC);

  const circ = { name: 'x', wave: '0' };
  circ.self = circ;
  const cy = C.patchSource(SRC, r, [{ op: 'insert', path: ['signal', 2], value: circ }]);
  assert.strictEqual(cy.ok, false, '自我循環必須被拒絕，不得丟例外');
  assert.ok(/cycle|循環/i.test(cy.reason), 'reason 要說明是循環。Got ' + cy.reason);
  assert.ok(cy.rewroteRange, '必須說明它想動哪一段');

  // 間接循環（繞一圈回來）也一樣
  const a = { name: 'a', wave: '0' };
  a.child = { back: a };
  assert.strictEqual(C.patchSource(SRC, r, [{ op: 'insert', path: ['signal', 2], value: a }]).ok,
    false, '間接循環也必須被拒絕');

  // 共用同一個子物件但沒有循環的值，不得被誤判
  const shared = { wave: '0' };
  const dag = { name: 'd', one: shared, two: shared };
  assert.strictEqual(C.patchSource(SRC, r, [{ op: 'insert', path: ['signal', 2], value: dag }]).ok,
    true, '共用子物件不是循環，不得誤殺');

  // 深度：寫回去的東西必須是這個 parser 讀得回來的東西，所以上限跟 parser 同一個
  const nest = (depth) => { let v = 'leaf'; for (let i = 0; i < depth; i++) v = [v]; return v; };
  const deep = C.patchSource(SRC, r, [{ op: 'insert', path: ['signal', 2], value: nest(6000) }]);
  assert.strictEqual(deep.ok, false, '太深的值必須被拒絕，不得丟 RangeError');
  assert.ok(/deep|深/i.test(deep.reason), 'reason 要說明是太深。Got ' + deep.reason);

  // 邊界：path 有 2 層，所以值還剩 62 層額度
  const fit = C.patchSource(SRC, r, [{ op: 'insert', path: ['signal', 2], value: nest(62) }]);
  assert.strictEqual(fit.ok, true, '剛好塞得下的深度必須成功。Got ' + JSON.stringify(fit.reason));
  assert.strictEqual(C.parseSource(fit.text).ok, true,
    '寫回去的東西必須是這個 parser 讀得回來的');
  const over = C.patchSource(SRC, r, [{ op: 'insert', path: ['signal', 2], value: nest(63) }]);
  assert.strictEqual(over.ok, false, '多一層就必須拒絕（否則寫出來的檔案自己讀不回來）');

  // set 也吃同一套（陣列值，型別與原本相同）
  const setDeep = C.patchSource(SRC, r,
    [{ path: ['signal', 1, 'data'], value: nest(6000) }]);
  assert.strictEqual(setDeep.ok, false, 'set 的值太深也必須拒絕');
}

// F2：parsed 必須來自這一份 text；拿舊的 parse 結果去 patch 新的 text 必須拒絕
{
  const r = C.parseSource(SRC);
  const o1 = C.patchSource(SRC, r, [{ path: ['signal', 0, 'wave'], value: 'p..x..x..' }]);
  assert.strictEqual(o1.ok, true, 'Got ' + JSON.stringify(o1));

  const o2 = C.patchSource(o1.text, r, [{ path: ['signal', 1, 'name'], value: 'DATA' }]);
  assert.strictEqual(o2.ok, false,
    '拿上一輪的 parse 結果去 patch 已經變長的 text，必須拒絕而不是寫出壞檔案');
  assert.ok(o2.text === undefined, '拒絕時不得回傳 text');

  // 正確用法：重新 parse
  const r2 = C.parseSource(o1.text);
  const o3 = C.patchSource(o1.text, r2, [{ path: ['signal', 1, 'name'], value: 'DATA' }]);
  assert.strictEqual(o3.ok, true, 'Got ' + JSON.stringify(o3));
  assert.strictEqual(C.parseSource(o3.text).ok, true, '重新 parse 之後寫出來的必須還能解析');
  assert.strictEqual(C.parseSource(o3.text).doc.signal[1].name, 'DATA');

  // 長度一樣但內容不同，也必須抓得到
  const twin = SRC.replace('p......', 'n......');
  assert.strictEqual(twin.length, SRC.length, '這個對照組要等長才有意義');
  assert.strictEqual(C.patchSource(twin, r, [{ path: ['signal', 0, 'wave'], value: '0' }]).ok,
    false, '等長但不同的來源也必須被拒絕');
}

// F3：CRLF 來源插入的新行必須也是 CRLF，不得混進一個裸 LF
{
  const CR = ['{ signal: [', '  { name: "clk", wave: "p." },', ']}'].join('\r\n');
  const rc = C.parseSource(CR);
  assert.strictEqual(rc.ok, true, 'Got ' + JSON.stringify(rc));
  const countLF = (t) => (t.match(/\n/g) || []).length;
  const countCRLF = (t) => (t.match(/\r\n/g) || []).length;

  const app = C.patchSource(CR, rc, [
    { op: 'insert', path: ['signal', 1], value: { name: 'x', wave: '0' } },
  ]);
  assert.strictEqual(app.ok, true, 'Got ' + JSON.stringify(app));
  assert.strictEqual(countLF(app.text), countCRLF(app.text),
    '尾端插入不得留下裸 LF。LF=' + countLF(app.text) + ' CRLF=' + countCRLF(app.text));

  const mid = C.patchSource(CR, rc, [
    { op: 'insert', path: ['signal', 0], value: { name: 'y', wave: '1' } },
  ]);
  assert.strictEqual(mid.ok, true, 'Got ' + JSON.stringify(mid));
  assert.strictEqual(countLF(mid.text), countCRLF(mid.text),
    '中間插入不得留下裸 LF。LF=' + countLF(mid.text) + ' CRLF=' + countCRLF(mid.text));
  assert.strictEqual(C.parseSource(mid.text).ok, true);

  // LF 來源不得反過來長出 CR
  const LF = ['{ signal: [', '  { name: "clk", wave: "p." },', ']}'].join('\n');
  const rl = C.parseSource(LF);
  const lo = C.patchSource(LF, rl, [
    { op: 'insert', path: ['signal', 1], value: { name: 'x', wave: '0' } },
  ]);
  assert.strictEqual(lo.text.indexOf('\r'), -1, 'LF 來源不得長出 CR');
}

// F4：刪除一條 lane 時，屬於它的註解跟著它走，不得留下孤兒縮排或改去描述別人
{
  // (a) 同一行行尾的註解
  const A = ['{ signal: [',
             '    { name: "clk", wave: "p.." },  // 主時脈',
             '    { name: "d", wave: "01" },',
             ']}'].join('\n');
  const ra = C.parseSource(A);
  const oa = C.patchSource(A, ra, [{ op: 'remove', path: ['signal', 0] }]);
  assert.strictEqual(oa.ok, true, 'Got ' + JSON.stringify(oa));
  assert.strictEqual(oa.text.indexOf('// 主時脈'), -1,
    '行尾註解不得被留下來變成別人的註解。Got ' + JSON.stringify(oa.text));
  assert.strictEqual(oa.text.indexOf('      '), -1,
    '不得留下一行孤兒縮排。Got ' + JSON.stringify(oa.text));
  const pa = C.parseSource(oa.text);
  assert.strictEqual(pa.ok, true, 'Got ' + JSON.stringify(pa));
  assert.deepStrictEqual(pa.doc.signal.map((x) => x.name), ['d']);

  // (b) 寫在上一行的註解
  const B = ['{ signal: [',
             '  // 主時脈',
             '  { name: "clk", wave: "p.." },',
             '  { name: "d", wave: "01" },',
             ']}'].join('\n');
  const rb = C.parseSource(B);
  const ob = C.patchSource(B, rb, [{ op: 'remove', path: ['signal', 0] }]);
  assert.strictEqual(ob.ok, true, 'Got ' + JSON.stringify(ob));
  assert.strictEqual(ob.text.indexOf('// 主時脈'), -1,
    '上一行的註解不得被留下來壓在下一條 lane 頭上。Got ' + JSON.stringify(ob.text));
  const pb = C.parseSource(ob.text);
  assert.strictEqual(pb.ok, true, 'Got ' + JSON.stringify(pb));
  assert.deepStrictEqual(pb.doc.signal.map((x) => x.name), ['d']);

  // (c) 別人的註解一個字都不能少：刪第二條時，第一條的兩種註解都要留著
  const oc = C.patchSource(B, rb, [{ op: 'remove', path: ['signal', 1] }]);
  assert.strictEqual(oc.ok, true, 'Got ' + JSON.stringify(oc));
  assert.ok(oc.text.indexOf('// 主時脈') !== -1, '別人的註解不得被牽連');
  assert.deepStrictEqual(C.parseSource(oc.text).doc.signal.map((x) => x.name), ['clk']);

  // (d) 中間隔了一行空行的註解不屬於這條 lane，必須留著
  const D = ['{ signal: [',
             '  // 這段是講整張圖的',
             '',
             '  { name: "clk", wave: "p.." },',
             '  { name: "d", wave: "01" },',
             ']}'].join('\n');
  const rd = C.parseSource(D);
  const od = C.patchSource(D, rd, [{ op: 'remove', path: ['signal', 0] }]);
  assert.strictEqual(od.ok, true, 'Got ' + JSON.stringify(od));
  assert.ok(od.text.indexOf('// 這段是講整張圖的') !== -1,
    '隔著空行的註解不算這條 lane 的，必須留著。Got ' + JSON.stringify(od.text));
}

// F5：插入時不得偷走下一條 lane 上方的註解
{
  const A = ['{ signal: [',
             '  // 主時脈',
             '  { name: "clk", wave: "p.." },',
             '  { name: "d", wave: "01" },',
             ']}'].join('\n');
  const ra = C.parseSource(A);
  const oa = C.patchSource(A, ra, [
    { op: 'insert', path: ['signal', 0], value: { name: 'new', wave: '0' } },
  ]);
  assert.strictEqual(oa.ok, true, 'Got ' + JSON.stringify(oa));
  const pa = C.parseSource(oa.text);
  assert.strictEqual(pa.ok, true, 'Got ' + JSON.stringify(pa));
  assert.deepStrictEqual(pa.doc.signal.map((x) => x.name), ['new', 'clk', 'd']);
  const lines = oa.text.split('\n');
  const cmt = lines.findIndex((l) => l.indexOf('// 主時脈') !== -1);
  assert.ok(cmt !== -1, '註解必須還在');
  assert.ok(lines[cmt + 1].indexOf('"clk"') !== -1,
    '註解必須還貼在 clk 上面，不得變成新 lane 的註解。Got ' + JSON.stringify(oa.text));

  // 插在中間也一樣：第二條上面的註解屬於第二條
  const B = ['{ signal: [',
             '  { name: "clk", wave: "p.." },',
             '  // 資料',
             '  { name: "d", wave: "01" },',
             ']}'].join('\n');
  const rb = C.parseSource(B);
  const ob = C.patchSource(B, rb, [
    { op: 'insert', path: ['signal', 1], value: { name: 'mid', wave: '0' } },
  ]);
  assert.strictEqual(ob.ok, true, 'Got ' + JSON.stringify(ob));
  const lb = ob.text.split('\n');
  const cb = lb.findIndex((l) => l.indexOf('// 資料') !== -1);
  assert.ok(lb[cb + 1].indexOf('"d"') !== -1,
    '註解必須還貼在 d 上面。Got ' + JSON.stringify(ob.text));
  assert.deepStrictEqual(C.parseSource(ob.text).doc.signal.map((x) => x.name),
    ['clk', 'mid', 'd']);
}

// F6：最後一筆後面的跨行區塊註解屬於最後一筆，新元素要落在它後面
{
  const A = ['{ signal: [',
             '  { name: "clk", wave: "p.." },  /* 這段註解',
             '     跨了兩行 */',
             ']}'].join('\n');
  const ra = C.parseSource(A);
  assert.strictEqual(ra.ok, true, 'Got ' + JSON.stringify(ra));
  const oa = C.patchSource(A, ra, [
    { op: 'insert', path: ['signal', 1], value: { name: 'x', wave: '0' } },
  ]);
  assert.strictEqual(oa.ok, true, 'Got ' + JSON.stringify(oa));
  assert.ok(oa.text.indexOf('跨了兩行 */') < oa.text.indexOf('"x"'),
    '新元素要落在跨行註解後面。Got ' + JSON.stringify(oa.text));
  const pa = C.parseSource(oa.text);
  assert.strictEqual(pa.ok, true, 'Got ' + JSON.stringify(pa));
  assert.deepStrictEqual(pa.doc.signal.map((x) => x.name), ['clk', 'x']);
}

// F7：同一條路徑在一次呼叫裡出現兩次必須拒絕（insert 與 set 一致）
{
  const r = C.parseSource(SRC);
  const two = C.patchSource(SRC, r, [
    { op: 'insert', path: ['signal', 1], value: { name: 'X', wave: '0' } },
    { op: 'insert', path: ['signal', 1], value: { name: 'Y', wave: '1' } },
  ]);
  assert.strictEqual(two.ok, false,
    '同一個索引插兩次，順序無法交代清楚，必須拒絕而不是靜默倒過來套');
  assert.ok(/same path|同一條路徑/i.test(two.reason), 'reason 要說明原因。Got ' + two.reason);
  assert.ok(two.rewroteRange, '必須說明它想動哪一段');

  const sets = C.patchSource(SRC, r, [
    { path: ['signal', 0, 'wave'], value: '0' },
    { path: ['signal', 0, 'wave'], value: '1' },
  ]);
  assert.strictEqual(sets.ok, false, '同一條路徑 set 兩次也必須拒絕');
  assert.ok(/same path|同一條路徑/i.test(sets.reason), 'reason 要一致。Got ' + sets.reason);

  // 不同索引插兩次是合法的
  const okTwo = C.patchSource(SRC, r, [
    { op: 'insert', path: ['signal', 0], value: { name: 'X', wave: '0' } },
    { op: 'insert', path: ['signal', 1], value: { name: 'Y', wave: '1' } },
  ]);
  assert.strictEqual(okTwo.ok, true, 'Got ' + JSON.stringify(okTwo));
  assert.deepStrictEqual(C.parseSource(okTwo.text).doc.signal.map((x) => x.name),
    ['X', 'clk', 'Y', 'data']);
}

// F8：容器值的 set 會把整棵子樹連同註解重寫，必須拒絕
{
  const A = ['{ signal: [',
             '  { name: "clk", // 這行註解在 lane 物件裡面',
             '    wave: "p.." },',
             ']}'].join('\n');
  const ra = C.parseSource(A);
  const oa = C.patchSource(A, ra, [
    { path: ['signal', 0], value: { name: 'z', wave: '0' } },
  ]);
  assert.strictEqual(oa.ok, false,
    '整個 lane 物件的 set 會吃掉裡面的註解，必須拒絕');
  assert.ok(/container|subtree|子樹|容器/i.test(oa.reason),
    'reason 要說明是容器。Got ' + oa.reason);
  const span = ra.spans.get(JSON.stringify(['signal', 0]));
  assert.strictEqual(oa.rewroteRange.start, span[0], 'rewroteRange 要指出那棵子樹');
  assert.strictEqual(oa.rewroteRange.end, span[1]);
  assert.ok(A.indexOf('// 這行註解在 lane 物件裡面') !== -1, 'fixture 本身要有註解才有意義');

  // 陣列值一樣
  const ob = C.patchSource(SRC, C.parseSource(SRC),
    [{ path: ['signal', 1, 'data'], value: ['x', 'y', 'z'] }]);
  assert.strictEqual(ob.ok, false, '陣列值的 set 也必須拒絕');

  // 但用 insert / remove 對同一個陣列做局部改動仍然可以
  const rc = C.parseSource(SRC);
  const oc = C.patchSource(SRC, rc, [{ op: 'remove', path: ['signal', 1, 'data', 1] }]);
  assert.strictEqual(oc.ok, true, 'Got ' + JSON.stringify(oc));
  assert.deepStrictEqual(C.parseSource(oc.text).doc.signal[1].data, ['a', 'c']);
}

// F9：值沒變的 edit 一個位元組都不寫（不得把 0xff 正規化成 255）
{
  const H = '{ config: { hscale: 0xff }, signal: [] }';
  const rh = C.parseSource(H);
  assert.strictEqual(rh.doc.config.hscale, 255);
  const oh = C.patchSource(H, rh, [{ path: ['config', 'hscale'], value: 255 }]);
  assert.strictEqual(oh.ok, true, 'Got ' + JSON.stringify(oh));
  assert.strictEqual(oh.text, H,
    '值沒變就不該重寫作者的字面值。Got ' + JSON.stringify(oh.text));

  // 字串也一樣
  const r = C.parseSource(SRC);
  const same = C.patchSource(SRC, r, [{ path: ['signal', 0, 'wave'], value: 'p......' }]);
  assert.strictEqual(same.ok, true, 'Got ' + JSON.stringify(same));
  assert.strictEqual(same.text, SRC, '一樣的字串不得重寫');

  // 混合：一筆沒變、一筆有變，只有變的那筆會動
  const mix = C.patchSource(SRC, r, [
    { path: ['signal', 0, 'wave'], value: 'p......' },
    { path: ['signal', 1, 'name'], value: 'DATA' },
  ]);
  assert.strictEqual(mix.ok, true, 'Got ' + JSON.stringify(mix));
  assert.ok(mix.text.includes('wave: "p......"'), '沒變的那筆保持原樣');
  assert.ok(mix.text.includes("name: 'DATA'"), '有變的那筆要寫進去');

  // 真的改成別的值當然還是要寫
  const diff = C.patchSource(H, rh, [{ path: ['config', 'hscale'], value: 2 }]);
  assert.strictEqual(diff.ok, true, 'Got ' + JSON.stringify(diff));
  assert.ok(diff.text.includes('hscale: 2'), 'Got ' + JSON.stringify(diff.text));
}

// F10：落單的 surrogate 必須跳脫，輸出才是合法 UTF-8
{
  const r = C.parseSource(SRC);
  const lone = 'a' + String.fromCharCode(0xd800) + 'b';
  const out = C.patchSource(SRC, r, [{ path: ['signal', 0, 'name'], value: lone }]);
  assert.strictEqual(out.ok, true, 'Got ' + JSON.stringify(out));
  assert.strictEqual(out.text.indexOf(String.fromCharCode(0xd800)), -1,
    '落單的 surrogate 不得原樣寫出去');
  assert.strictEqual(Buffer.from(out.text, 'utf8').toString('utf8'), out.text,
    '輸出寫成 UTF-8 再讀回來必須一模一樣');
  assert.strictEqual(C.parseSource(out.text).doc.signal[0].name, lone,
    '來回一趟必須還原成同一個字串');

  // 成對的 surrogate（真的字）不得被拆開或跳脫
  const pair = C.patchSource(SRC, r, [{ path: ['signal', 0, 'name'], value: '𝄞ok' }]);
  assert.strictEqual(pair.ok, true, 'Got ' + JSON.stringify(pair));
  assert.ok(pair.text.includes('𝄞ok'), '成對的 surrogate 必須原樣寫出。Got ' +
    JSON.stringify(pair.text));
}

// F12：插進多行的空陣列要跟著它自己的排版，不得黏在中括號上
{
  const E = ['{', '  signal: [', '  ]', '}'].join('\n');
  const re = C.parseSource(E);
  assert.strictEqual(re.ok, true, 'Got ' + JSON.stringify(re));
  const oe = C.patchSource(E, re, [
    { op: 'insert', path: ['signal', 0], value: { name: 'N', wave: '0' } },
  ]);
  assert.strictEqual(oe.ok, true, 'Got ' + JSON.stringify(oe));
  const el = oe.text.split('\n');
  assert.strictEqual(el.length, 5, '新元素要自己佔一行。Got ' + JSON.stringify(oe.text));
  assert.ok(/^ +\{ name: "N", wave: "0" \}$/.test(el[2]),
    '新元素要縮排、獨佔一行。Got ' + JSON.stringify(el[2]));
  assert.strictEqual(C.parseSource(oe.text).ok, true);
  assert.deepStrictEqual(C.parseSource(oe.text).doc.signal.map((x) => x.name), ['N']);

  // 單行的空陣列維持單行
  const F = '{ signal: [] }';
  const rf = C.parseSource(F);
  const of2 = C.patchSource(F, rf, [
    { op: 'insert', path: ['signal', 0], value: { name: 'N', wave: '0' } },
  ]);
  assert.strictEqual(of2.ok, true, 'Got ' + JSON.stringify(of2));
  assert.strictEqual(of2.text.indexOf('\n'), -1, '單行來源不得長出換行。Got ' +
    JSON.stringify(of2.text));
}

// Q1：單行陣列刪掉中間一筆，不得留下雙空格
// （wavedrom 3.5.0 的 loader 是 eval('(' + text + ')')，實測雙空格與尾逗號都吃得下，
//  所以這不是相容性問題；但那段空白是我們自己切出來的，該收乾淨。）
{
  const S = "{ signal: [ { name: 'a', wave: '0' }, { name: 'b', wave: '1' } ] }";
  const r = C.parseSource(S);
  const last = C.patchSource(S, r, [{ op: 'remove', path: ['signal', 1] }]);
  assert.strictEqual(last.ok, true, 'Got ' + JSON.stringify(last));
  assert.strictEqual(last.text.indexOf('  ]'), -1,
    '不得留下雙空格。Got ' + JSON.stringify(last.text));
  assert.deepStrictEqual(C.parseSource(last.text).doc.signal.map((x) => x.name), ['a']);

  const firstOne = C.patchSource(S, r, [{ op: 'remove', path: ['signal', 0] }]);
  assert.strictEqual(firstOne.ok, true, 'Got ' + JSON.stringify(firstOne));
  assert.strictEqual(firstOne.text.indexOf('[  '), -1,
    '刪掉第一筆也不得留下雙空格。Got ' + JSON.stringify(firstOne.text));
  assert.deepStrictEqual(C.parseSource(firstOne.text).doc.signal.map((x) => x.name), ['b']);
}

// ---- 以下為 fix round 2（re-review N1-N7）釘住的合約 ----

// N1：註解歸屬的邊界對兩種註解寫法、兩個方向都要一樣
//
// 邊界（程式與測試共用的那一句）：一則註解屬於「它在同一行上所接續的那個成員」；
// 當它自己獨佔一行或數行時，屬於「緊接在它下面的那個成員」，中間沒有空行為限。
{
  const LINE = ['{ signal: [',
                '  // 這段',
                '  // 說明',
                '  { name: "a", wave: "0" },',
                '  { name: "b", wave: "1" },',
                ']}'].join('\n');
  const BLOCK = ['{ signal: [',
                 '  /* 這段',
                 '     說明 */',
                 '  { name: "a", wave: "0" },',
                 '  { name: "b", wave: "1" },',
                 ']}'].join('\n');
  const MARK = '說明';

  for (const [style, SRCX] of [['line', LINE], ['block', BLOCK]]) {
    const r = C.parseSource(SRCX);
    assert.strictEqual(r.ok, true, style + ' fixture 必須解析得出來。Got ' + JSON.stringify(r));

    // 方向一：刪掉 a，它的註解要跟著走，不得留下來壓在 b 頭上
    const rm = C.patchSource(SRCX, r, [{ op: 'remove', path: ['signal', 0] }]);
    assert.strictEqual(rm.ok, true, style + ' remove: Got ' + JSON.stringify(rm));
    assert.strictEqual(rm.text.indexOf(MARK), -1,
      style + ' 樣式：上方註解必須跟著被刪的 lane 走。Got ' + JSON.stringify(rm.text));
    const rmp = C.parseSource(rm.text);
    assert.strictEqual(rmp.ok, true, style + ' remove 後必須還能解析。Got ' + JSON.stringify(rmp));
    assert.deepStrictEqual(rmp.doc.signal.map((x) => x.name), ['b']);

    // 方向二：插在 a 前面，新 lane 不得偷走 a 的註解
    const ins = C.patchSource(SRCX, r, [
      { op: 'insert', path: ['signal', 0], value: { name: 'N', wave: '1' } },
    ]);
    assert.strictEqual(ins.ok, true, style + ' insert: Got ' + JSON.stringify(ins));
    const insp = C.parseSource(ins.text);
    assert.strictEqual(insp.ok, true, style + ' insert 後必須還能解析。Got ' + JSON.stringify(insp));
    assert.deepStrictEqual(insp.doc.signal.map((x) => x.name), ['N', 'a', 'b']);
    const lines = ins.text.split('\n');
    const mark = lines.findIndex((l) => l.indexOf(MARK) !== -1);
    assert.ok(mark !== -1, style + ' 樣式：註解必須還在');
    assert.ok(lines[mark + 1].indexOf('"a"') !== -1,
      style + ' 樣式：註解必須還貼在 a 上面，不得變成新 lane 的。Got ' + JSON.stringify(ins.text));
    assert.ok(ins.text.indexOf('{ name: "N"') < ins.text.indexOf(MARK),
      style + ' 樣式：新 lane 要落在那串註解之前。Got ' + JSON.stringify(ins.text));
  }

  // 空行照樣切斷歸屬，兩種寫法都一樣
  for (const [style, head] of [['line', '  // 整張圖的標題'], ['block', '  /* 整張圖\n     的標題 */']]) {
    const SRCX = ['{ signal: [', head, '',
                  '  { name: "a", wave: "0" },',
                  '  { name: "b", wave: "1" },',
                  ']}'].join('\n');
    const r = C.parseSource(SRCX);
    assert.strictEqual(r.ok, true, style + ' Got ' + JSON.stringify(r));
    const rm = C.patchSource(SRCX, r, [{ op: 'remove', path: ['signal', 0] }]);
    assert.strictEqual(rm.ok, true, 'Got ' + JSON.stringify(rm));
    assert.ok(rm.text.indexOf('標題') !== -1,
      style + ' 樣式：隔著空行的標題不屬於任何 lane，必須留著。Got ' + JSON.stringify(rm.text));
  }

  // 同一行上接續某個成員的註解屬於那個成員 —— 跨行的區塊註解也是
  {
    const T = ['{ signal: [',
               '  { name: "a", wave: "0" },  /* 這條的',
               '     長註解 */',
               '  { name: "b", wave: "1" },',
               ']}'].join('\n');
    const r = C.parseSource(T);
    assert.strictEqual(r.ok, true, 'Got ' + JSON.stringify(r));

    const rm = C.patchSource(T, r, [{ op: 'remove', path: ['signal', 0] }]);
    assert.strictEqual(rm.ok, true, 'Got ' + JSON.stringify(rm));
    assert.strictEqual(rm.text.indexOf('長註解'), -1,
      '接在 a 後面的跨行註解屬於 a，刪 a 要一起帶走。Got ' + JSON.stringify(rm.text));
    assert.deepStrictEqual(C.parseSource(rm.text).doc.signal.map((x) => x.name), ['b']);

    // 刪 b 不得動到 a 的註解
    const rb = C.patchSource(T, r, [{ op: 'remove', path: ['signal', 1] }]);
    assert.strictEqual(rb.ok, true, 'Got ' + JSON.stringify(rb));
    assert.ok(rb.text.indexOf('長註解') !== -1, '別人的註解不得被牽連');

    // 插在 b 前面也不得偷走那段跨行註解
    const ins = C.patchSource(T, r, [
      { op: 'insert', path: ['signal', 1], value: { name: 'N', wave: '1' } },
    ]);
    assert.strictEqual(ins.ok, true, 'Got ' + JSON.stringify(ins));
    assert.ok(ins.text.indexOf('長註解') < ins.text.indexOf('{ name: "N"'),
      '新 lane 要落在 a 的跨行註解之後。Got ' + JSON.stringify(ins.text));
    assert.deepStrictEqual(C.parseSource(ins.text).doc.signal.map((x) => x.name),
      ['a', 'N', 'b']);
  }

  // 寫在中括號那一行的註解不屬於第一個成員（它接續的是中括號）
  {
    const T = ['{ signal: [ // 整個 signal 的說明',
               '  { name: "a", wave: "0" },',
               ']}'].join('\n');
    const r = C.parseSource(T);
    const rm = C.patchSource(T, r, [{ op: 'remove', path: ['signal', 0] }]);
    assert.strictEqual(rm.ok, true, 'Got ' + JSON.stringify(rm));
    assert.ok(rm.text.indexOf('整個 signal 的說明') !== -1,
      '中括號那一行的註解不屬於第一個成員。Got ' + JSON.stringify(rm.text));
  }
}

// N2：一個 doc block 上面不得再疊一個 doc block（F11 與 N2 是同一個形狀，這條擋掉第三次）
{
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../lib/editor/wave-codec.js'), 'utf8');
  const srcLines = src.split('\n');
  // Collect every doc block. The first one is the file's own header, which is
  // allowed to be followed by another — it documents the module, not a function.
  const blocks = [];
  for (let i = 0; i < srcLines.length; i++) {
    if (srcLines[i].trim() !== '/**') continue;
    let j = i;
    while (j < srcLines.length && srcLines[j].trim() !== '*/') j++;
    blocks.push([i, j]);
    i = j;
  }
  assert.ok(blocks.length > 5, '應該找得到好幾個 doc block，否則這條守衛是空的');
  const stacked = [];
  for (const [openLine, closeLine] of blocks.slice(1)) {
    let j = closeLine + 1;
    while (j < srcLines.length && srcLines[j].trim() === '') j++;
    if (j < srcLines.length && srcLines[j].trim().startsWith('/**')) {
      stacked.push('block opening at line ' + (openLine + 1) + ' is followed at line ' +
        (j + 1) + ' by another doc block，所以它底下那個東西穿的是別人的說明');
    }
  }
  assert.deepStrictEqual(stacked, [],
    '有 doc block 直接疊在另一個 doc block 上面，代表某個函式穿著別人的說明：\n  ' +
    stacked.join('\n  '));
}

// N4：深度拒絕的訊息要講「這個位置真正剩下的額度」，不是講總上限
{
  const r = C.parseSource(SRC);
  const nest = (depth) => { let v = 'leaf'; for (let i = 0; i < depth; i++) v = [v]; return v; };

  const over = C.patchSource(SRC, r, [{ op: 'insert', path: ['signal', 2], value: nest(63) }]);
  assert.strictEqual(over.ok, false, '63 層在這個位置必須被拒絕');
  assert.ok(over.reason.indexOf('62') !== -1,
    '訊息要講這個位置剩下的 62，而不是只講 64。Got ' + JSON.stringify(over.reason));

  // 路徑更深，訊息裡的數字要跟著變
  const deeper = C.patchSource(SRC, r,
    [{ op: 'insert', path: ['signal', 1, 'data', 3], value: nest(61) }]);
  assert.strictEqual(deeper.ok, false, '這個位置只剩 60 層');
  assert.ok(deeper.reason.indexOf('60') !== -1,
    '訊息裡的額度要跟著路徑深度走。Got ' + JSON.stringify(deeper.reason));
}

// N5：一批 edit 會不會因為交疊而被拒絕，只能看這批的「形狀」，不得看值剛好等不等
{
  const r = C.parseSource(SRC);
  const differs = C.patchSource(SRC, r, [
    { op: 'remove', path: ['signal', 0] },
    { path: ['signal', 0, 'wave'], value: '1' },
  ]);
  assert.strictEqual(differs.ok, false, '值不同時是交疊，必須拒絕');

  const equal = C.patchSource(SRC, r, [
    { op: 'remove', path: ['signal', 0] },
    { path: ['signal', 0, 'wave'], value: 'p......' },   // 與原值相同
  ]);
  assert.strictEqual(equal.ok, false,
    '值剛好相同不該讓同一批 edit 從「被拒絕」變成「通過」。Got ' + JSON.stringify(equal));
  assert.ok(/overlap|交疊/i.test(equal.reason), 'reason 要說明是交疊。Got ' + equal.reason);

  // 值相同的 edit 單獨送仍然是合法的，而且逐位元組不變
  const alone = C.patchSource(SRC, r, [{ path: ['signal', 0, 'wave'], value: 'p......' }]);
  assert.strictEqual(alone.ok, true, 'Got ' + JSON.stringify(alone));
  assert.strictEqual(alone.text, SRC);
}

// N6：不是 plain object 的值（Date / Map / Set / RegExp / class 實例）必須拒絕，
//     不得靜默寫成 {}
{
  const r = C.parseSource(SRC);
  class Lane { constructor() { this.name = 'x'; } }
  const cases = [
    ['Date', new Date(0)],
    ['Map', new Map([['a', 1]])],
    ['Set', new Set([1])],
    ['RegExp', /x/g],
    ['class instance', new Lane()],
  ];
  for (const [label, value] of cases) {
    const out = C.patchSource(SRC, r, [
      { op: 'insert', path: ['signal', 2], value: { name: 'n', extra: value } },
    ]);
    assert.strictEqual(out.ok, false,
      label + ' 沒有 WaveJSON 寫法，必須拒絕而不是靜默寫成 {}。Got ' + JSON.stringify(out));
    assert.ok(/plain object|WaveJSON/i.test(out.reason),
      label + ' 的 reason 要說明原因。Got ' + out.reason);
  }

  // 值本身就是這種東西的時候也一樣
  assert.strictEqual(C.patchSource(SRC, r,
    [{ op: 'insert', path: ['signal', 2], value: new Date(0) }]).ok, false);

  // 普通的物件與陣列不得被誤殺
  const ok = C.patchSource(SRC, r, [
    { op: 'insert', path: ['signal', 2],
      value: { name: 'n', wave: '0', data: ['a', 'b'], node: null, n: 1, b: true } },
  ]);
  assert.strictEqual(ok.ok, true, '普通的值不得被誤殺。Got ' + JSON.stringify(ok));
  assert.strictEqual(C.parseSource(ok.text).ok, true);

  // Object.create(null) 做出來的裸物件也算 plain
  const bare = Object.create(null);
  bare.name = 'bare';
  bare.wave = '0';
  assert.strictEqual(C.patchSource(SRC, r, [
    { op: 'insert', path: ['signal', 2], value: bare },
  ]).ok, true, 'Object.create(null) 也是 plain object');
}

// ---- 以下為 Task 3 釘住的合約（wave 字元 op 與文件 op） ----

// 這一段的前提是量出來的，不是推出來的。對 pin 住的 wavedrom 3.5.0 渲染
// '01xzpnhlud=23456789' 這 19 個 level 字元的 `ch..ch` 與 `ch...`：只有 p 與 n
// 兩個時脈字元渲染相同，其餘 17 個都不同（`ch..ch` 在那一拍多一個 transition
// marker，例如 #0m0 對 #000；h/l 是 #pclk/#nclk 對 #111/#000）。
// 所以 `.` 不是「重複前一個字元」，expandWave 必須無損：每一拍都記著它是
// 「延續」還是「明寫」，否則 collapse(expand(w)) 對每一個 level 字元都會走樣。

// expandWave 無損：{ch, held}，ch 是這一拍解析出來的 level，held 說它是不是寫成 `.`
assert.deepStrictEqual(C.expandWave('p...'), [
  { ch: 'p', held: false }, { ch: 'p', held: true },
  { ch: 'p', held: true }, { ch: 'p', held: true },
], '`.` 要記成 held，而且帶著它延續的 level');

assert.deepStrictEqual(C.expandWave('01.x'), [
  { ch: '0', held: false }, { ch: '1', held: false },
  { ch: '1', held: true }, { ch: 'x', held: false },
]);

// collapse 絕不自己長出 `.`：只有 model 說是延續的地方才寫 `.`
assert.strictEqual(C.collapseWave(['p', 'p', 'p', 'p']), 'pppp',
  'collapse 不得把重複的字元擅自收成 `.`——那兩者渲染不同');
assert.strictEqual(C.collapseWave(C.expandWave('p...')), 'p...');

// 往返一致：所有合法字元，加上 `|`、空字串與開頭就是 `.` 的退化輸入
{
  const LEVELS = '01xzpnhlud=23456789'.split('');
  const corpus = ['', '.', '..0', '0|.', '|', '0.1.', '0.10'];
  for (const ch of LEVELS) {
    corpus.push(ch + '..' + ch, ch + '...', ch + ch + ch + ch, ch, ch + '|' + ch);
  }
  for (const w of corpus) {
    assert.strictEqual(C.collapseWave(C.expandWave(w)), w,
      '往返必須一致：' + JSON.stringify(w));
  }
}

// levelsOf 回答「這一拍畫的是什麼 level」——`.` 與 `|` 都延續前一個
assert.deepStrictEqual(C.levelsOf('0.1.'), ['0', '0', '1', '1']);
assert.deepStrictEqual(C.levelsOf('0|.'), ['0', '0', '0'], '| 是缺口，不是自己的 level');
assert.deepStrictEqual(C.levelsOf('..0'), ['x', 'x', 'x'],
  '開頭的 repeater：那一段與它後面第一個明碼都畫成 x（見下方對引擎的釘子）');

// setCell：後面沒有延續的時候
{
  const doc = { signal: [{ name: 'a', wave: '0000' }] };
  const next = C.setCell(doc, 0, 2, '1');
  assert.strictEqual(next.signal[0].wave, '0010', 'setCell 之後的 wave');
  assert.strictEqual(doc.signal[0].wave, '0000', '原本的 doc 不得被改到');
}

// setCell：後面的延續必須先被寫成明碼，否則會動到使用者沒碰的那一拍
{
  const doc = { signal: [{ name: 'a', wave: '0...' }] };
  const next = C.setCell(doc, 0, 2, '1');
  assert.strictEqual(next.signal[0].wave, '0.10',
    '第 3 拍原本畫的是 0，要先被寫出來，否則它會跟著第 2 拍變成 1');
  assert.deepStrictEqual(C.levelsOf(next.signal[0].wave), ['0', '0', '1', '0']);
  assert.strictEqual(C.levelsOf('0.1.')[3], '1',
    '天真的做法（直接把第 2 拍改掉）確實會把第 3 拍一起改掉');
}

// setCell：`|` 沒有自己的 level，所以要跨過它去釘後面的延續
{
  const doc = { signal: [{ name: 'a', wave: '0|.' }] };
  const next = C.setCell(doc, 0, 0, '1');
  assert.strictEqual(next.signal[0].wave, '1|0', '延續在 | 後面，也要被釘住');
  assert.deepStrictEqual(C.levelsOf(next.signal[0].wave), ['1', '1', '0']);
}

// setCell 也可以寫 `.`：把這一拍變成延續
assert.strictEqual(
  C.setCell({ signal: [{ name: 'a', wave: '0101' }] }, 0, 1, '.').signal[0].wave, '0.01');

// 開頭的 `.` 沒有東西可以延續。實測 wavedrom 3.5.0 把 "..0" 整條畫成 x
// （連那個 0 都不畫），而 "x.0" 畫的是 x x 0——所以要釘住它只能寫 x，
// 因為 x 就是那一拍本來畫出來的東西。
{
  const doc = { signal: [{ name: 'a', wave: '..0' }] };
  assert.strictEqual(C.setCell(doc, 0, 0, '1').signal[0].wave, '1x0');
}

// setCellRange：一段是一個 run（一個明碼加延續），末端後面那一拍一樣要先釘住
{
  const doc = { signal: [{ name: 'a', wave: '0...' }] };
  assert.strictEqual(C.setCellRange(doc, 0, 1, 2, '1').signal[0].wave, '01.0',
    '一段填成一個 run，而不是每一拍各寫一次');
  assert.strictEqual(C.setCellRange(doc, 0, 2, 1, '1').signal[0].wave, '01.0',
    'from/to 反過來拖是同一段');
  assert.strictEqual(doc.signal[0].wave, '0...', '原本的 doc 不得被改到');
}

// data 格：實測只有 = 與 2..9 會吃掉一個 data 格，其餘 level 字元與 `.`、`|` 都不會
{
  const doc = { signal: [{ name: 'a', wave: '0230', data: ['A', 'B'] }] };
  const next = C.setCell(doc, 0, 1, '1');
  assert.strictEqual(next.signal[0].wave, '0130');
  assert.deepStrictEqual(next.signal[0].data, ['B'], '被蓋掉的值字元要連它的 data 一起走');
  assert.deepStrictEqual(doc.signal[0].data, ['A', 'B'], '原本的 data 陣列不得被改到');
}

// 釘住延續的時候，那個 run 的標籤要跟著複製過去，否則畫面上的字會掉
{
  const doc = { signal: [{ name: 'a', wave: '2...', data: ['A'] }] };
  const next = C.setCell(doc, 0, 2, '1');
  assert.strictEqual(next.signal[0].wave, '2.12');
  assert.deepStrictEqual(next.signal[0].data, ['A', 'A'],
    '第 3 拍被寫成明碼的 2，它顯示的還是同一個標籤');
  assert.deepStrictEqual(C.levelsOf(next.signal[0].wave), ['2', '2', '1', '2']);
}

// data 寫成字串的時候要還它一個字串（wavedrom 3.5.0 兩種都吃）
{
  const doc = { signal: [{ name: 'a', wave: '2.3.', data: 'AA BB' }] };
  const next = C.setCell(doc, 0, 3, '0');
  assert.strictEqual(next.signal[0].wave, '2.30');
  assert.strictEqual(next.signal[0].data, 'AA BB', 'data 原本的寫法要保住');
}

// insert / delete cycles 對每一條 lane 都要作用
{
  const doc = { signal: [{ name: 'a', wave: '0011' }, { name: 'b', wave: 'xxzz' }] };
  const ins = C.insertCycles(doc, 2, 1);
  assert.strictEqual(C.expandWave(ins.signal[0].wave).length, 5);
  assert.strictEqual(C.expandWave(ins.signal[1].wave).length, 5,
    '插入 cycle 必須對每一條 lane 同時作用，否則波形會錯位');
  assert.strictEqual(ins.signal[0].wave, '00.11', '插進去的是延續，原本的 level 不變');
  assert.deepStrictEqual(C.levelsOf(ins.signal[0].wave), ['0', '0', '0', '1', '1']);
}

// insert 在第 0 拍：沒有東西可以延續，所以把第一拍複製一份出來
{
  const doc = { signal: [{ name: 'a', wave: '0011' }] };
  const ins = C.insertCycles(doc, 0, 2);
  assert.strictEqual(ins.signal[0].wave, '0.0011');
  assert.deepStrictEqual(C.levelsOf(ins.signal[0].wave),
    ['0', '0', '0', '0', '1', '1']);
}

// delete：被刪掉那一段後面的延續會改指向別人，所以要先釘住
{
  const doc = { signal: [{ name: 'a', wave: '0.11' }] };
  const del = C.deleteCycles(doc, 0, 1);
  assert.strictEqual(del.signal[0].wave, '011', '刪掉第 0 拍不得留下一個沒有依靠的 `.`');
  assert.deepStrictEqual(C.levelsOf(del.signal[0].wave), ['0', '1', '1']);
}

// copy / paste
{
  const doc = { signal: [{ name: 'a', wave: '0101' }] };
  const clip = C.copyCycles(doc, 1, 2);
  assert.strictEqual(clip.kind, 'cycles');
  assert.strictEqual(clip.count, 2);
  assert.deepStrictEqual(clip.lanes[0].chars,
    [{ ch: '1', held: false }, { ch: '0', held: false }]);
  const pasted = C.pasteCycles(doc, 3, clip, 'insert');
  assert.strictEqual(C.expandWave(pasted.signal[0].wave).length, 6);
  assert.strictEqual(pasted.signal[0].wave, '010101');
  assert.strictEqual(doc.signal[0].wave, '0101', '原本的 doc 不得被改到');
}

// clip 的第一拍如果是延續，要先被寫成明碼，否則貼到別的地方會去延續別人
{
  const doc = { signal: [{ name: 'a', wave: '0...' }] };
  const clip = C.copyCycles(doc, 2, 2);
  assert.deepStrictEqual(clip.lanes[0].chars,
    [{ ch: '0', held: false }, { ch: '0', held: true }]);
}

// copy 要把值字元的標籤一起帶走
{
  const doc = { signal: [{ name: 'a', wave: '02.3', data: ['A', 'B'] }] };
  assert.deepStrictEqual(C.copyCycles(doc, 1, 2).lanes[0].data, ['A']);
}

// paste insert 要把 clip 沒蓋到的 lane 一起加寬，否則波形錯位
{
  const doc = { signal: [{ name: 'a', wave: '0101' }, { name: 'b', wave: '1111' }] };
  const clip = C.copyCycles({ signal: [doc.signal[0]] }, 1, 2);
  const pasted = C.pasteCycles(doc, 2, clip, 'insert');
  assert.strictEqual(C.expandWave(pasted.signal[0].wave).length, 6);
  assert.strictEqual(C.expandWave(pasted.signal[1].wave).length, 6,
    'clip 沒蓋到的 lane 也要加寬');
  assert.strictEqual(pasted.signal[1].wave, '11..11', '加寬用的是延續，level 不變');
}

// paste overwrite 不改長度，而且蓋過去之後的那一拍要先被釘住
{
  const doc = { signal: [{ name: 'a', wave: '0...' }] };
  const clip = C.copyCycles({ signal: [{ name: 'c', wave: '11' }] }, 0, 2);
  const over = C.pasteCycles(doc, 1, clip, 'overwrite');
  assert.strictEqual(over.signal[0].wave, '0110');
  assert.deepStrictEqual(C.levelsOf(over.signal[0].wave), ['0', '1', '1', '0']);
}

// lane ops
{
  const doc = { signal: [{ name: 'a', wave: '01' }, { name: 'b', wave: '10' }] };
  assert.strictEqual(C.moveLane(doc, 0, 1).signal[0].name, 'b');
  assert.strictEqual(C.removeLane(doc, 0).signal.length, 1);
  assert.strictEqual(C.renameLane(doc, 1, 'B').signal[1].name, 'B');
  const added = C.addLane(doc, 1, { name: 'c', wave: '00' });
  assert.strictEqual(added.signal[1].name, 'c');
  assert.strictEqual(added.signal.length, 3);
  assert.strictEqual(doc.signal[0].name, 'a', '原本的 doc 不得被改到');
  assert.strictEqual(doc.signal.length, 2, '原本的 signal 陣列不得被改到');
}

// addLane 不得把呼叫端那個物件本人收進 doc 裡
{
  const lane = { name: 'c', wave: '00' };
  const doc = C.addLane({ signal: [] }, 0, lane);
  assert.notStrictEqual(doc.signal[0], lane, '收一份拷貝，否則呼叫端改它就改到 doc');
  assert.deepStrictEqual(doc.signal[0], lane);
}

// group 的標題字串不是 lane，不佔編號；group 裡的 lane 佔
{
  const doc = { signal: [['grp', { name: 'a', wave: '01' }]] };
  assert.strictEqual(C.renameLane(doc, 0, 'X').signal[0][1].name, 'X',
    '編號 0 是 group 裡的那一條 lane，不是 group 本身');
  assert.strictEqual(C.renameLane(doc, 0, 'X').signal[0][0], 'grp', '標題原樣留著');
  assert.strictEqual(C.renameLane(doc, 1, 'X'), doc, '只有一條 lane，編號 1 不存在');
}

// 沒有被碰到的 lane 物件要原封不動地共用，之後才寫得回最小的 patch
{
  const doc = { signal: [{ name: 'a', wave: '01' }, { name: 'b', wave: '10' }] };
  const next = C.setCell(doc, 0, 1, '0');
  assert.strictEqual(next.signal[1], doc.signal[1], '沒碰到的 lane 要是同一個物件');
  assert.notStrictEqual(next.signal[0], doc.signal[0], '碰到的 lane 要是新的物件');
  assert.notStrictEqual(next.signal, doc.signal);
  assert.notStrictEqual(next, doc);
}

// 不合法的位置、字元或 mode 一律原樣回去，不丟例外也不猜
{
  const doc = { signal: [{ name: 'a', wave: '01' }] };
  assert.strictEqual(C.setCell(doc, 0, 9, '1'), doc, '超出範圍就原樣回去');
  assert.strictEqual(C.setCell(doc, 5, 0, '1'), doc);
  assert.strictEqual(C.setCell(doc, 0, 0, '01'), doc, '一次只能寫一個字元');
  assert.strictEqual(C.removeLane(doc, 9), doc);
  assert.strictEqual(C.moveLane(doc, 0, 0), doc);
  assert.strictEqual(C.insertCycles(doc, 0, 0), doc);
  assert.strictEqual(C.pasteCycles(doc, 0, null, 'insert'), doc);
  assert.strictEqual(C.pasteCycles(doc, 0, C.copyCycles(doc, 0, 1), 'nope'), doc,
    '不認得的 mode 不得靜默當成 insert');
}

// 這些 op 的產物要真的寫得回原始碼，而且只動那一個值
{
  const src = '{ signal: [\n  { name: "a", wave: "0..." },   // 說明\n]}';
  const r = C.parseSource(src);
  const next = C.setCell(r.doc, 0, 2, '1');
  const out = C.patchSource(src, r, [
    { path: ['signal', 0, 'wave'], value: next.signal[0].wave },
  ]);
  assert.strictEqual(out.ok, true, 'Got ' + JSON.stringify(out));
  assert.ok(out.text.includes('"0.10"'), 'Got ' + JSON.stringify(out.text));
  assert.ok(out.text.includes('// 說明'), '註解必須原樣留著');
}

// addLane 的產物要走得過 insert 這條路
{
  const src = '{ signal: [\n  { name: "a", wave: "01" },\n  { name: "b", wave: "10" },\n]}';
  const r = C.parseSource(src);
  const next = C.addLane(r.doc, 1, { name: 'c', wave: '00' });
  const out = C.patchSource(src, r,
    [{ op: 'insert', path: ['signal', 1], value: next.signal[1] }]);
  assert.strictEqual(out.ok, true, 'Got ' + JSON.stringify(out));
  const back = C.parseSource(out.text);
  assert.strictEqual(back.ok, true, 'Got ' + JSON.stringify(back));
  assert.deepStrictEqual(back.doc.signal.map(function (l) { return l.name; }),
    ['a', 'c', 'b']);
}

// ---- 以下為 Task 3 fix round 1 釘住的合約 ----
// 這一輪的三個 MAJOR 都是「同一個模組裡兩個部分各信各的」，所以底下的測試釘的是
// **兩邊的一致**，不是各自的行為：span op 對上顯示順序、copy 對上 paste、
// levelsOf 對上 wavedrom 自己畫出來的東西、moveLane 的 doc 對上 patch 的結果。

// levelsOf 必須跟引擎畫出來的一致。這一條直接把兩邊接起來：先用 wavedrom 量出
// 每個 level 字元的 body glyph，再拿 levelsOf 的答案去對同一條 wave 每一拍真的
// 畫出來的 glyph。p / n 不在名單裡，因為時脈的 glyph 隨奇偶拍交替。
{
  const wd = require('wavedrom');
  const bodyOf = function (wave) {
    const s = JSON.stringify(wd.renderAny(0, { signal: [{ name: 'a', wave: wave }] }, wd.waveSkin));
    const all = [];
    const re = /"xlink:href"\s*:\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(s))) {
      if (m[1] !== '#gap') all.push(m[1]);   // 缺口另外畫一個 glyph，不佔一拍
    }
    const per = [];
    for (let i = 1; i < all.length; i += 2) per.push(all[i]);
    return per;
  };
  const glyph = {};
  for (const ch of '01xzhlud=23456789'.split('')) glyph[ch] = bodyOf('x' + ch)[1];
  const corpus = ['0.1.', '0|.', '..0', '.0110', '.0..', '|0.', '.110', '.x0', '.=2',
    '01..', '0..0', '2...', '0|0.', '=.=.', 'x.z.', 'h.l.', 'u.d.', '0101', '.01100'];
  for (const w of corpus) {
    const drawn = bodyOf(w);
    const said = C.levelsOf(w);
    assert.strictEqual(said.length, drawn.length,
      'levelsOf 的拍數要跟引擎畫的一樣：' + JSON.stringify(w));
    for (let k = 0; k < drawn.length; k++) {
      assert.strictEqual(glyph[said[k]], drawn[k],
        JSON.stringify(w) + ' 第 ' + k + ' 拍：levelsOf 說 ' + JSON.stringify(said[k]) +
        '（畫成 ' + glyph[said[k]] + '），引擎畫的是 ' + drawn[k]);
    }
  }
}

// F1：group 裡的 lane 也是 lane。span op 沒走到它們，插一拍就會把畫面錯開。
{
  const doc = { signal: [
    { name: 'a', wave: '0011' },
    ['grp', { name: 'b', wave: '0011' }, ['inner', { name: 'c', wave: '0011' }]],
  ] };
  const ins = C.insertCycles(doc, 2, 1);
  assert.strictEqual(ins.signal[0].wave, '00.11');
  assert.strictEqual(ins.signal[1][1].wave, '00.11', 'group 裡的 lane 也要一起加寬');
  assert.strictEqual(ins.signal[1][2][1].wave, '00.11', '巢狀 group 裡的也要');
  assert.strictEqual(ins.signal[1][0], 'grp', 'group 的標題原樣留著');
  assert.strictEqual(doc.signal[1][1].wave, '0011', '原本的 doc 不得被改到');
  const del = C.deleteCycles(doc, 0, 1);
  assert.strictEqual(del.signal[1][1].wave, '011');
  assert.strictEqual(del.signal[1][2][1].wave, '011');
}

// F1 的一致性釘子：span op 跑完，**每一條** lane 的拍數必須還是一樣長——
// 這正是 spanOp 自己的註解說它存在的理由。
{
  const doc = { signal: [
    { name: 'a', wave: '0011' },
    ['g', { name: 'b', wave: '0011' }],
    { name: 'c', wave: '0011' },
  ] };
  const lens = function (d) {
    return [d.signal[0].wave, d.signal[1][1].wave, d.signal[2].wave]
      .map(function (w) { return C.expandWave(w).length; });
  };
  assert.deepStrictEqual(lens(C.insertCycles(doc, 2, 1)), [5, 5, 5]);
  assert.deepStrictEqual(lens(C.insertCycles(doc, 0, 2)), [6, 6, 6]);
  assert.deepStrictEqual(lens(C.deleteCycles(doc, 1, 1)), [3, 3, 3]);
  assert.deepStrictEqual(lens(C.pasteCycles(doc, 1, C.copyCycles(doc, 0, 2), 'insert')),
    [6, 6, 6]);
}

// F2：copy 與 paste 必須用同一套 lane 編號。把一段原地 copy 再 overwrite 貼回去，
// 結果必須是**同一個 doc 物件**——兩邊只要差一格，這條就紅。
{
  const doc = { signal: [
    ['grp', { name: 'g', wave: '0101' }],
    { name: 'a', wave: '0011' },
    ['g2', { name: 'b', wave: '1100' }, { name: 'c', wave: '0110' }],
  ] };
  for (let at = 0; at <= 2; at++) {
    assert.strictEqual(C.pasteCycles(doc, at, C.copyCycles(doc, at, 2), 'overwrite'), doc,
      'at=' + at + ' 原地貼回去必須完全沒有變化');
  }
}

// F2：而且要貼到對的那一條 lane 上
{
  const doc = { signal: [['grp', { name: 'g', wave: 'xxxx' }], { name: 'a', wave: '0011' }] };
  const clip = C.copyCycles(doc, 1, 2);
  assert.deepStrictEqual(clip.lanes.map(function (l) { return l.chars.length; }), [2, 2],
    'group 裡的 lane 也要在 clip 裡佔一格');
  const out = C.pasteCycles(doc, 2, clip, 'overwrite');
  assert.strictEqual(out.signal[1].wave, '0001', 'a 的第 2、3 拍被 a 自己的第 1、2 拍蓋掉');
  assert.strictEqual(out.signal[0][1].wave, 'xxxx', 'g 貼到的是 g 自己的那一段');
}

// F3：任何 op 都不得把 repeater 留在第 0 拍——引擎會把那一段連同它後面第一個
// 明碼一起畫成 x。
{
  const doc = { signal: [{ name: 'a', wave: '0|0.' }] };
  assert.strictEqual(C.deleteCycles(doc, 0, 1).signal[0].wave, '00.',
    '刪掉第 0 拍不得把 | 留在開頭；它顯示的 level 要被寫出來');
  assert.deepStrictEqual(C.levelsOf(C.deleteCycles(doc, 0, 1).signal[0].wave),
    ['0', '0', '0'], '剩下三拍顯示的東西要跟原本的第 1、2、3 拍一樣');
}

// F3：clip 的第一拍是 | 的話它站不住，copy 的時候就要寫出來
{
  const clip = C.copyCycles({ signal: [{ name: 'a', wave: '0|1' }] }, 1, 2);
  assert.deepStrictEqual(clip.lanes[0].chars,
    [{ ch: '0', held: false }, { ch: '1', held: false }]);
  assert.strictEqual(
    C.pasteCycles({ signal: [{ name: 'b', wave: '111' }] }, 0, clip, 'overwrite').signal[0].wave,
    '011');
}

// F3：手工做出來的 clip 也不得把 repeater 貼到第 0 拍
{
  const clip = { kind: 'cycles', count: 2, lanes: [{ chars: [{ ch: '|', held: false }, { ch: '1', held: false }], data: [] }] };
  const out = C.pasteCycles({ signal: [{ name: 'b', wave: '000' }] }, 0, clip, 'overwrite');
  assert.strictEqual(C.expandWave(out.signal[0].wave)[0].held, false);
  assert.notStrictEqual(C.expandWave(out.signal[0].wave)[0].ch, '|');
}

// F3：畫筆本身也不得在第 0 拍畫 repeater——那兩個字元在那裡沒有意義
{
  const doc = { signal: [{ name: 'a', wave: '0101' }] };
  assert.strictEqual(C.setCell(doc, 0, 0, '.'), doc, '第 0 拍沒有東西可以延續');
  assert.strictEqual(C.setCell(doc, 0, 0, '|'), doc, '第 0 拍沒有東西可以蓋缺口');
  assert.strictEqual(C.setCellRange(doc, 0, 0, 2, '|'), doc);
  assert.strictEqual(C.setCell(doc, 0, 1, '|').signal[0].wave, '0|01', '第 1 拍可以');
}

// F3 的全面掃描：帶 | 的 fixture 走過每一個會動到第 0 拍的 op，
// 結果的第 0 拍一律不得是 repeater
{
  const waves = ['0|0.', '0|1', '|0.', '0.|0', '01|.', '0|.', '2|3.', '0|||'];
  for (const w of waves) {
    const doc = { signal: [{ name: 'a', wave: w }] };
    const outs = [
      C.deleteCycles(doc, 0, 1),
      C.deleteCycles(doc, 0, 2),
      C.pasteCycles(doc, 0, C.copyCycles(doc, 1, 2), 'overwrite'),
      C.pasteCycles(doc, 0, C.copyCycles(doc, 1, 2), 'insert'),
    ];
    for (const out of outs) {
      const head = C.expandWave(out.signal[0].wave)[0];
      if (head === undefined) continue;
      assert.strictEqual(head.held, false, w + ' 的結果 ' +
        JSON.stringify(out.signal[0].wave) + ' 第 0 拍不得是延續');
      assert.notStrictEqual(head.ch, '|', w + ' 的結果 ' +
        JSON.stringify(out.signal[0].wave) + ' 第 0 拍不得是缺口');
    }
  }
}

// F4 / F5 / F10：data 的字串寫法。沒動到標籤就一個位元組都不改；
// 動到而且裝得下就照原本的間隔寫回去；裝不下（空白標籤、含空白的標籤）就轉成陣列。
{
  const doc = { signal: [{ name: 'a', wave: '2.3.', data: 'AA   BB' }] };
  assert.strictEqual(C.setCell(doc, 0, 3, '0').signal[0].data, 'AA   BB',
    '標籤沒變就原樣寫回去，連那三個空白都不動');
}
{
  const doc = { signal: [{ name: 'a', wave: '03', data: 'A' }] };
  const next = C.setCell(doc, 0, 0, '2');
  assert.strictEqual(next.signal[0].wave, '23');
  assert.deepStrictEqual(next.signal[0].data, ['', 'A'],
    '空白標籤在空白分隔的字串裡活不下來，會讓 A 漂到使用者剛畫的那一拍上');
}
{
  const from = { signal: [{ name: 'x', wave: '22', data: ['hello world', 'Z'] }] };
  const clip = C.copyCycles(from, 0, 1);
  const into = { signal: [{ name: 'y', wave: '33', data: 'P Q' }] };
  const out = C.pasteCycles(into, 0, clip, 'overwrite');
  assert.deepStrictEqual(out.signal[0].data, ['hello world', 'Q'],
    '含空白的標籤 join 回字串會裂成兩個，把後面那個擠出去');
}
{
  const doc = { signal: [{ name: 'a', wave: '23', data: 'AA   BB' }] };
  const next = C.setCell(doc, 0, 0, '4');
  assert.strictEqual(next.signal[0].wave, '43');
  assert.strictEqual(next.signal[0].data, 'AA   BB',
    '換掉一個值字元，標籤格數沒變，那三個空白也不該變');
}
// 真的多出一格標籤的時候，作者自己的間隔要留在原地，只有新的位置才補一個空白
{
  const doc = { signal: [{ name: 'a', wave: '2.3.', data: 'AA   BB' }] };
  const next = C.setCell(doc, 0, 0, '4');
  assert.strictEqual(next.signal[0].wave, '423.', '第 1 拍原本延續的 2 要被寫出來');
  assert.strictEqual(next.signal[0].data, 'AA   AA BB',
    '那三個空白原本在 AA 後面，就留在 AA 後面；只有新插進去的那一格用單一空白');
}

// F8：addLane 收的是一份深拷貝，呼叫端之後改它不得改到 doc 裡面
{
  const lane = { name: 'z', wave: '00', data: ['A'] };
  const doc = C.addLane({ signal: [] }, 0, lane);
  lane.data.push('LEAKED');
  assert.deepStrictEqual(doc.signal[0].data, ['A']);
  assert.notStrictEqual(doc.signal[0].data, lane.data);
}

// F9：overwrite 不得把 lane 加長
{
  const doc = { signal: [{ name: 'a', wave: '0000' }, { name: 'b', wave: '01' }] };
  const clip = C.copyCycles(
    { signal: [{ name: 'c', wave: '11' }, { name: 'd', wave: '11' }] }, 0, 2);
  const lens = function (d) {
    return d.signal.map(function (l) { return C.expandWave(l.wave).length; });
  };
  assert.deepStrictEqual(lens(C.pasteCycles(doc, 1, clip, 'overwrite')), [4, 2]);
  assert.deepStrictEqual(lens(C.pasteCycles(doc, 3, clip, 'overwrite')), [4, 2],
    '貼過尾端的部分要被切掉，不是把 lane 撐長');
  assert.strictEqual(C.pasteCycles(doc, 3, clip, 'overwrite').signal[0].wave, '0001');
}

// Q2：扁平的顯示順序編號。group 的標題不佔號，group 裡的 lane 佔。
{
  const doc = { signal: [
    { name: 'a', wave: '01' },
    ['g', { name: 'b', wave: '01' }],
    { name: 'c', wave: '01' },
  ] };
  assert.strictEqual(C.setCell(doc, 1, 0, '1').signal[1][1].wave, '11', '編號 1 是 group 裡的 b');
  assert.strictEqual(C.renameLane(doc, 2, 'C').signal[2].name, 'C', '編號 2 是 c');
  const moved = C.moveLane(doc, 1, 0);
  assert.strictEqual(moved.signal[0].name, 'b', 'group 裡的 lane 可以被搬到最外層');
  assert.deepStrictEqual(moved.signal.map(function (l) { return l.name; }), ['b', 'a', 'c'],
    '搬走之後 group 沒有 lane 了，跟著一起消失（見下方 N3）');
  assert.deepStrictEqual(C.removeLane(doc, 1).signal.map(function (l) { return l.name; }),
    ['a', 'c'], 'removeLane 從它自己的容器裡拿掉，空掉的 group 一起走');
}

// Q2 的邊界：插在 group 的第一個 lane 前面 = 進去；插在最後一個 lane 後面 = 在外面
{
  const doc = { signal: [
    { name: 'a', wave: '01' },
    ['grp', { name: 'b', wave: '01' }, { name: 'c', wave: '01' }],
    { name: 'd', wave: '01' },
  ] };
  const head = C.addLane(doc, 1, { name: 'new', wave: '00' });
  assert.strictEqual(head.signal[1][1].name, 'new', '插在 b 前面 → 進到 group 裡');
  assert.strictEqual(head.signal[1].length, 4);
  const tail = C.addLane(doc, 3, { name: 'new', wave: '00' });
  assert.strictEqual(tail.signal[2].name, 'new', '插在 d 前面 → 落在 group 外面');
  assert.strictEqual(tail.signal[1].length, 3, 'group 沒被動到');
  const end = C.addLane(doc, 4, { name: 'new', wave: '00' });
  assert.strictEqual(end.signal[3].name, 'new', '超過最後一條 lane → 接在最外層的尾端');
  assert.strictEqual(doc.signal[1].length, 3, '原本的 doc 不得被改到');
}

// F6：沒有 name 的 lane 也要改得了名字，而且改完寫得回去
{
  const src = '{ signal: [\n  { wave: "0101" },   // 沒有名字\n]}';
  const r = C.parseSource(src);
  const next = C.renameLane(r.doc, 0, 'clk');
  assert.strictEqual(next.signal[0].name, 'clk');
  const out = C.patchSource(src, r,
    [{ op: 'insert', path: ['signal', 0, 'name'], value: 'clk' }]);
  assert.strictEqual(out.ok, true, 'Got ' + JSON.stringify(out));
  assert.ok(out.text.includes('// 沒有名字'), '註解必須留著');
  const back = C.parseSource(out.text);
  assert.strictEqual(back.ok, true, 'Got ' + JSON.stringify(back));
  assert.strictEqual(back.doc.signal[0].name, 'clk');
  assert.strictEqual(back.doc.signal[0].wave, '0101');
}

// F6：已經有的 key 不得用 insert 再插一次（那是 set 的事）
{
  const r = C.parseSource(SRC);
  const dup = C.patchSource(SRC, r,
    [{ op: 'insert', path: ['signal', 0, 'name'], value: 'x' }]);
  assert.strictEqual(dup.ok, false, '已經有的 member 不得再 insert 一次');
  assert.ok(/already|set/i.test(dup.reason), 'Got ' + dup.reason);
}

// F7：搬一條 lane 不得把它的註解弄丟——member span 就是為了原樣搬位元組而存在的
{
  const src = ['{ signal: [',
    '  { name: "a", wave: "01" },   // first',
    '  { name: "b", wave: "10" },   // second',
    '  { name: "c", wave: "0." },',
    ']}'].join('\n');
  const r = C.parseSource(src);
  const out = C.patchSource(src, r, [
    { op: 'move', path: C.lanePath(r.doc, 0), to: C.laneInsertPath(r.doc, 2) }]);
  assert.strictEqual(out.ok, true, 'Got ' + JSON.stringify(out));
  assert.ok(out.text.includes('// first'), '搬走的 lane 的註解要跟著它');
  assert.ok(out.text.includes('// second'), '別人的註解不得被動到');
  const back = C.parseSource(out.text);
  assert.strictEqual(back.ok, true, 'Got ' + JSON.stringify(back));
  assert.deepStrictEqual(back.doc.signal.map(function (l) { return l.name; }),
    ['b', 'a', 'c']);
  // patch 的結果要跟 moveLane 算出來的 doc 說同一件事
  assert.deepStrictEqual(C.moveLane(r.doc, 0, 1).signal.map(function (l) { return l.name; }),
    ['b', 'a', 'c'],
    'moveLane 與 move patch 必須一致（這個 fixture 沒有 group，兩套編號在它上面重合，' +
    '所以它只釘註解與順序；會紅的那一版在下面 N1 那一段，fixture 帶 group）');
}

// data 陣列改長度的時候，store 要逐格寫回去；整包 set 會被 patch 層擋下來
{
  const src = '{ signal: [\n  { name: "a", wave: "230", data: ["A","B"] },\n]}';
  const r = C.parseSource(src);
  const next = C.setCell(r.doc, 0, 1, '1');
  assert.strictEqual(next.signal[0].wave, '210');
  assert.deepStrictEqual(next.signal[0].data, ['A']);
  const whole = C.patchSource(src, r, [
    { path: ['signal', 0, 'wave'], value: next.signal[0].wave },
    { path: ['signal', 0, 'data'], value: next.signal[0].data },
  ]);
  assert.strictEqual(whole.ok, false, '整包 data 陣列 set 會被擋，這是刻意的');
  const ok = C.patchSource(src, r, [
    { path: ['signal', 0, 'wave'], value: next.signal[0].wave },
    { op: 'remove', path: ['signal', 0, 'data', 1] },
  ]);
  assert.strictEqual(ok.ok, true, 'Got ' + JSON.stringify(ok));
  const back = C.parseSource(ok.text);
  assert.strictEqual(back.doc.signal[0].wave, '210');
  assert.deepStrictEqual(back.doc.signal[0].data, ['A']);
}

// ---- 以下為 Task 3 fix round 2 釘住的合約 ----
// 上一輪學到的教訓寫在這裡：一致性的釘子，fixture 必須是**兩邊會給出不同答案**的
// 那一種。上一輪那條 `moveLane 與 move patch 必須一致` 用的是沒有 group 的 doc，
// 兩套編號在那上面本來就重合，所以它永遠不會紅——等於沒測。底下每一條都帶 group。

// 帶 group 的 fixture：扁平編號 a=0 b=1 c=2 d=3，而 naive 的 ['signal',k] 會是
// a=0、整個 group=1、d=2、以及根本不存在的 3。四個編號沒有一個對得上。
const GSRC = [
  '{ signal: [',
  '  { name: "a", wave: "01" },   // lane a',
  '  ["grp",',
  '    { name: "b", wave: "01" },   // lane b',
  '    { name: "c", wave: "01" },   // lane c',
  '  ],',
  '  { name: "d", wave: "01" },   // lane d',
  ']}',
].join('\n');

// 比的是整棵樹的形狀，不是攤平的名字順序。這一點是量出來的，不是想出來的：
// 用名字順序比的時候，「插在 group 前面」與「插在 group 裡的第一條 lane 前面」
// 會給出同一個順序，於是 add 的編號 1 又會變成一條永遠不會紅的斷言——
// 跟上一輪那條沒有 group 的 fixture 是同一種毛病，只是低一層。
const laneShape = function (doc) {
  const walk = function (arr) {
    const out = [];
    for (const item of arr) {
      if (Array.isArray(item)) out.push(walk(item));
      else if (item !== null && typeof item === 'object') out.push(item.name);
      else out.push(item);
    }
    return out;
  };
  return walk(doc.signal);
};

// N1：doc 層的扁平編號 → patch 層的容器路徑，必須有一座導出的橋
{
  const r = C.parseSource(GSRC);
  assert.deepStrictEqual(C.lanePath(r.doc, 0), ['signal', 0]);
  assert.deepStrictEqual(C.lanePath(r.doc, 1), ['signal', 1, 1],
    '編號 1 是 group 裡的 b；naive 的 ["signal",1] 指到的是整個 group');
  assert.deepStrictEqual(C.lanePath(r.doc, 2), ['signal', 1, 2]);
  assert.deepStrictEqual(C.lanePath(r.doc, 3), ['signal', 2],
    '編號 3 是 d；naive 的 ["signal",3] 根本不存在');
  assert.strictEqual(C.lanePath(r.doc, 4), null, '超出範圍回 null，不是猜一個');
  assert.strictEqual(C.lanePath(r.doc, -1), null);

  // N1b：一次問完所有 lane 的路徑。lanePath 每問一條就走一次樹，逐條問是 O(N²)；
  // 幾何層要的是整份文件的列，所以橋這一側補一個「同一次走訪、同一個順序」的出口。
  // 它不是第二種順序：逐項比對 lanePath，任何一格不一樣都是 bug。
  {
    const all = C.lanePaths(r.doc);
    assert.strictEqual(Array.isArray(all), true, 'lanePaths 必須回陣列');
    assert.strictEqual(all.length, 4, 'GSRC 攤平後是四條 lane');
    for (let i = 0; i < all.length; i++) {
      assert.deepStrictEqual(all[i], C.lanePath(r.doc, i),
        '第 ' + i + ' 條的路徑必須跟 lanePath 一模一樣');
    }
    assert.deepStrictEqual(C.lanePaths({ signal: [] }), [], '沒有 lane 就是空陣列');
    assert.deepStrictEqual(C.lanePaths(null), [], '不是文件也回空陣列，不丟');
    assert.deepStrictEqual(C.lanePaths({}), []);
    // 回的陣列是新的：呼叫端改它不得影響下一次
    const once = C.lanePaths(r.doc);
    once.length = 0;
    assert.strictEqual(C.lanePaths(r.doc).length, 4, '回的是新陣列，不是內部狀態');
  }
  assert.deepStrictEqual(C.laneInsertPath(r.doc, 1), ['signal', 1, 1],
    '插在 b 前面 = 進到 group 裡');
  assert.deepStrictEqual(C.laneInsertPath(r.doc, 3), ['signal', 2],
    '插在 d 前面 = 落在 group 外面');
  assert.deepStrictEqual(C.laneInsertPath(r.doc, 4), ['signal', 3],
    '超過最後一條 lane = 接在最外層尾端');
  assert.strictEqual(C.laneInsertPath(r.doc, 5), null);
}

// N1 一致性：renameLane 與用橋建出來的 set，必須改到同一條 lane
{
  for (let k = 0; k < 4; k++) {
    const r = C.parseSource(GSRC);
    const want = laneShape(C.renameLane(r.doc, k, 'Z'));
    const out = C.patchSource(GSRC, r,
      [{ path: C.lanePath(r.doc, k).concat(['name']), value: 'Z' }]);
    assert.strictEqual(out.ok, true, 'rename ' + k + ' Got ' + JSON.stringify(out));
    assert.deepStrictEqual(laneShape(C.parseSource(out.text).doc), want,
      'rename 編號 ' + k + '：doc 與 patch 必須改到同一條 lane');
  }
}

// N1 一致性：removeLane 與用橋建出來的 remove
{
  for (let k = 0; k < 4; k++) {
    const r = C.parseSource(GSRC);
    const want = laneShape(C.removeLane(r.doc, k));
    const out = C.patchSource(GSRC, r, [{ op: 'remove', path: C.laneRemovePath(r.doc, k) }]);
    assert.strictEqual(out.ok, true, 'remove ' + k + ' Got ' + JSON.stringify(out));
    assert.deepStrictEqual(laneShape(C.parseSource(out.text).doc), want,
      'remove 編號 ' + k + '：doc 與 patch 必須刪掉同一條 lane');
  }
}

// N1 一致性：addLane 與用橋建出來的 insert
{
  for (let k = 0; k <= 4; k++) {
    const r = C.parseSource(GSRC);
    const want = laneShape(C.addLane(r.doc, k, { name: 'N', wave: '00' }));
    const out = C.patchSource(GSRC, r,
      [{ op: 'insert', path: C.laneInsertPath(r.doc, k), value: { name: 'N', wave: '00' } }]);
    assert.strictEqual(out.ok, true, 'add ' + k + ' Got ' + JSON.stringify(out));
    assert.deepStrictEqual(laneShape(C.parseSource(out.text).doc), want,
      'add 編號 ' + k + '：doc 與 patch 必須插在同一個位置');
  }
}

// N1 一致性：moveLane 與用橋建出來的 move，全部 12 種排列
{
  for (let from = 0; from < 4; from++) {
    for (let to = 0; to < 4; to++) {
      if (from === to) continue;
      const r = C.parseSource(GSRC);
      const want = laneShape(C.moveLane(r.doc, from, to));
      const out = C.patchSource(GSRC, r, [{
        op: 'move',
        path: C.lanePath(r.doc, from),
        to: C.laneInsertPath(r.doc, to < from ? to : to + 1),
      }]);
      assert.strictEqual(out.ok, true,
        'move ' + from + '->' + to + ' Got ' + JSON.stringify(out));
      assert.deepStrictEqual(laneShape(C.parseSource(out.text).doc), want,
        'move ' + from + '->' + to + '：doc 與 patch 必須排出同一個順序');
      assert.ok(out.text.includes('// lane a'), 'move ' + from + '->' + to + ' 註解要留著');
      assert.ok(out.text.includes('// lane b'));
      assert.ok(out.text.includes('// lane c'));
      assert.ok(out.text.includes('// lane d'));
    }
  }
}

// N2：字串轉陣列的 data 要寫得回去，一次呼叫、註解與位置都留著
{
  const src = ['{ signal: [',
    '  { name: "a", wave: "03", data: "A",   // about data',
    '    phase: 0 },',
    ']}'].join('\n');
  const r = C.parseSource(src);
  const next = C.setCell(r.doc, 0, 0, '2');
  assert.strictEqual(next.signal[0].wave, '23');
  assert.deepStrictEqual(next.signal[0].data, ['', 'A']);
  const out = C.patchSource(src, r, [
    { path: ['signal', 0, 'wave'], value: next.signal[0].wave },
    { op: 'replace', path: ['signal', 0, 'data'], value: next.signal[0].data },
  ]);
  assert.strictEqual(out.ok, true, 'Got ' + JSON.stringify(out));
  assert.ok(out.text.includes('// about data'), 'data 旁邊的註解要留著');
  const back = C.parseSource(out.text);
  assert.strictEqual(back.ok, true, 'Got ' + JSON.stringify(back));
  assert.deepStrictEqual(Object.keys(back.doc.signal[0]), ['name', 'wave', 'data', 'phase'],
    'data 要留在原位，不得被搬到物件尾端');
  assert.deepStrictEqual(back.doc.signal[0].data, ['', 'A']);
  assert.strictEqual(back.doc.signal[0].wave, '23');
}

// replace 與 set 的分工：set 仍然擋住悄悄的型別變更
{
  const r = C.parseSource(SRC);
  assert.strictEqual(C.patchSource(SRC, r,
    [{ path: ['signal', 0, 'wave'], value: ['p'] }]).ok, false,
    'set 不得默默改型別');
  assert.strictEqual(C.patchSource(SRC, r,
    [{ op: 'replace', path: ['signal', 0, 'wave'], value: ['p'] }]).ok, true,
    'replace 的意思就是「我要整個換掉」，型別可以變');
  assert.strictEqual(C.patchSource(SRC, r,
    [{ op: 'replace', path: ['signal', 9, 'wave'], value: 'x' }]).ok, false,
    '沒有解析到的路徑還是拒絕');
}

// N3：把 group 的最後一條 lane 拿掉，group 也要跟著走
{
  const doc = { signal: [['grp', { name: 'b', wave: '01' }], { name: 'd', wave: '01' }] };
  const out = C.removeLane(doc, 0);
  assert.deepStrictEqual(out.signal.map(function (l) { return l.name; }), ['d'],
    '空掉的 group 要一起消失，否則那塊區域永遠再也定位不到');
  assert.strictEqual(doc.signal.length, 2, '原本的 doc 不得被改到');
}
{
  const doc = { signal: [['g1', ['g2', { name: 'x', wave: '01' }]], { name: 'd', wave: '01' }] };
  assert.deepStrictEqual(C.removeLane(doc, 0).signal.map(function (l) { return l.name; }),
    ['d'], '巢狀的空 group 要一路往上收');
}
{
  const doc = { signal: [['grp', { name: 'b', wave: '01' }, { name: 'c', wave: '01' }]] };
  const out = C.removeLane(doc, 0);
  assert.strictEqual(out.signal[0].length, 2, 'grp 還有 c，不得被收掉');
  assert.strictEqual(out.signal[0][1].name, 'c');
}
{
  const src = '{ signal: [\n  ["grp",\n    { name: "b", wave: "01" },   // 只有這一條\n  ],\n  { name: "d", wave: "01" },\n]}';
  const r = C.parseSource(src);
  assert.deepStrictEqual(C.laneRemovePath(r.doc, 0), ['signal', 0],
    '刪掉 b 實際上要刪掉整個 group');
  const out = C.patchSource(src, r, [{ op: 'remove', path: C.laneRemovePath(r.doc, 0) }]);
  assert.strictEqual(out.ok, true, 'Got ' + JSON.stringify(out));
  const back = C.parseSource(out.text);
  assert.deepStrictEqual(back.doc.signal.map(function (l) { return l.name; }), ['d']);
}

// N3：把 group 裡唯一一條 lane 搬出去，group 也要跟著走，而且兩邊要一致
{
  const src = ['{ signal: [',
    '  { name: "a", wave: "01" },   // lane a',
    '  ["grp",',
    '    { name: "b", wave: "01" },   // lane b',
    '  ],',
    ']}'].join('\n');
  const r = C.parseSource(src);
  const want = laneShape(C.moveLane(r.doc, 1, 0));
  assert.deepStrictEqual(want, ['b', 'a'], '搬走之後 group 沒東西了，跟著消失');
  const out = C.patchSource(src, r,
    [{ op: 'move', path: C.lanePath(r.doc, 1), to: C.laneInsertPath(r.doc, 0) }]);
  assert.strictEqual(out.ok, true, 'Got ' + JSON.stringify(out));
  assert.deepStrictEqual(laneShape(C.parseSource(out.text).doc), want);
  assert.ok(out.text.includes('// lane b'), '搬走的 lane 的註解要跟著它');
  assert.strictEqual(out.text.includes('grp'), false, '空掉的 group 要從檔案裡消失');
}

// N4：data 只是比值字元少，不算「裝不下」，不得因此轉成陣列或補出空白標籤
{
  const doc = { signal: [{ name: 'a', wave: '222', data: 'A' }] };
  const next = C.setCell(doc, 0, 2, '3');
  assert.strictEqual(next.signal[0].wave, '223');
  assert.strictEqual(next.signal[0].data, 'A',
    '後面兩拍本來就沒有標籤，不得替使用者補兩個空白標籤出來');
}
{
  const doc = { signal: [{ name: 'a', wave: '222', data: ['A'] }] };
  assert.deepStrictEqual(C.setCell(doc, 0, 2, '3').signal[0].data, ['A'],
    '陣列寫法同理，不得補成 ["A","",""]');
}
{
  const doc = { signal: [{ name: 'a', wave: '2.2.', data: ['A'] }] };
  assert.deepStrictEqual(C.insertCycles(doc, 1, 1).signal[0].data, ['A'],
    '插一拍也不得補出空白標籤');
}

// N5：兩個 insert 落在同一個位置，順序沒有定義——要擋，不是默默倒著寫
{
  const src = '{ signal: [\n  { wave: "01" },\n]}';
  const r = C.parseSource(src);
  const out = C.patchSource(src, r, [
    { op: 'insert', path: ['signal', 0, 'name'], value: 'a' },
    { op: 'insert', path: ['signal', 0, 'phase'], value: 1 },
  ]);
  assert.strictEqual(out.ok, false, '同一個落點的兩個 insert 必須被擋下來');
  assert.ok(/same place|同一個|one place/i.test(out.reason) || /order/i.test(out.reason),
    'reason 要說明原因。Got ' + out.reason);
}
{
  const src = '{ signal: [\n  { wave: "01" },\n]}';
  const r1 = C.parseSource(src);
  const t1 = C.patchSource(src, r1, [{ op: 'insert', path: ['signal', 0, 'name'], value: 'a' }]);
  assert.strictEqual(t1.ok, true, 'Got ' + JSON.stringify(t1));
  const r2 = C.parseSource(t1.text);
  const t2 = C.patchSource(t1.text, r2,
    [{ op: 'insert', path: ['signal', 0, 'phase'], value: 1 }]);
  assert.strictEqual(t2.ok, true, 'Got ' + JSON.stringify(t2));
  assert.deepStrictEqual(Object.keys(C.parseSource(t2.text).doc.signal[0]),
    ['wave', 'name', 'phase'], '分兩次寫，順序就是呼叫端寫的那個');
}

// N6：手工做的 clip，第 0 拍是延續時它自己記得延續的是什麼 level，不得丟掉
{
  const clip = { kind: 'cycles', count: 2,
    lanes: [{ chars: [{ ch: '0', held: true }, { ch: '1', held: false }], data: [] }] };
  const out = C.pasteCycles({ signal: [{ name: 'b', wave: '111' }] }, 0, clip, 'overwrite');
  assert.strictEqual(out.signal[0].wave, '011',
    'clip 的第 0 拍記得它延續的是 0，寫出來就該是 0 而不是 x');
}

// serialize 不得寫出一個 __proto__ 鍵。
// 實測（本 session，node 22）：在 eval 裡 { "__proto__": v }、{ '__proto__': v }
// 與裸寫的 { __proto__: v } 三者效果完全相同，都會改掉載入後那個物件的 prototype
// 而不是存成一個 key——所以「把它加上引號」擋不住任何東西。只有計算鍵
// { ["__proto__"]: v } 才是存成資料，而那個寫法這個檔案自己的 parser 讀不回來。
// 既然沒有一種寫法既存得成資料又讀得回來，就跟其他沒有 WaveJSON 寫法的值一樣拒絕。
// wavedrom 3.5.0 的 loader 用的正是 eval，所以這不是理論問題。
{
  const r = C.parseSource(SRC);
  const evil = { name: 'n', wave: '0' };
  Object.defineProperty(evil, '__proto__',
    { value: { polluted: 1 }, enumerable: true, writable: true, configurable: true });
  const out = C.patchSource(SRC, r, [{ op: 'insert', path: ['signal', 2], value: evil }]);
  assert.strictEqual(out.ok, false, '__proto__ 沒有存得成資料又讀得回來的寫法，必須拒絕');
  assert.ok(/__proto__/.test(out.reason), 'reason 要指出是哪個鍵。Got ' + out.reason);
  const nested = { name: 'n', wave: '0', extra: {} };
  Object.defineProperty(nested.extra, '__proto__',
    { value: { polluted: 1 }, enumerable: true, writable: true, configurable: true });
  assert.strictEqual(C.patchSource(SRC, r,
    [{ op: 'insert', path: ['signal', 2], value: nested }]).ok, false, '巢狀的也要擋');
  assert.strictEqual(C.patchSource(SRC, r,
    [{ op: 'insert', path: ['signal', 2], value: { name: 'n', wave: '0' } }]).ok, true,
    '普通的 lane 不得被誤殺');
}

// ---- 以下為 Task 3 fix round 3 釘住的合約 ----

// R1：五條寫回去的配方，全部做成**會跑的測試**，fixture 帶 group，而且裡面有一條
// 沒有名字的 lane（就在 group 裡）。散文不會紅；這一段會。Tasks 5-8 照抄這裡。
const RSRC = [
  '{ signal: [',
  '  { name: "a", wave: "01" },   // lane a',
  '  ["grp",',
  '    { wave: "01" },   // 沒有名字，而且在 group 裡面',
  '    { name: "c", wave: "01" },   // lane c',
  '  ],',
  '  { name: "d", wave: "01" },   // lane d',
  ']}',
].join('\n');
// 扁平編號：a=0、沒名字的那條=1、c=2、d=3

// 配方 1：改名（lane 本來就有 name）→ set
{
  const r = C.parseSource(RSRC);
  const want = laneShape(C.renameLane(r.doc, 2, 'C'));
  const out = C.patchSource(RSRC, r,
    [{ path: C.lanePath(r.doc, 2).concat(['name']), value: 'C' }]);
  assert.strictEqual(out.ok, true, 'Got ' + JSON.stringify(out));
  assert.deepStrictEqual(laneShape(C.parseSource(out.text).doc), want);
  assert.ok(out.text.includes('// lane c'), '註解要留著');
}

// 配方 2：改名（lane 沒有 name）→ insert。F6 就是為了這一條存在的，
// 而它到現在都還沒有一個帶 group 的測試釘住。
{
  const r = C.parseSource(RSRC);
  const want = laneShape(C.renameLane(r.doc, 1, 'B'));
  const out = C.patchSource(RSRC, r,
    [{ op: 'insert', path: C.lanePath(r.doc, 1).concat(['name']), value: 'B' }]);
  assert.strictEqual(out.ok, true, 'Got ' + JSON.stringify(out));
  assert.deepStrictEqual(laneShape(C.parseSource(out.text).doc), want);
  assert.ok(out.text.includes('// 沒有名字，而且在 group 裡面'), '註解要留著');
  assert.deepStrictEqual(Object.keys(C.parseSource(out.text).doc.signal[1][1]),
    ['wave', 'name'], 'name 接在原有的 key 後面');
}

// 配方 2 的分岔選錯的時候必須**大聲**拒絕，不是默默做錯事——
// 這是「散文不會紅」的補償：兩個方向都拒絕，所以 store 選錯不會沒人發現。
{
  const r = C.parseSource(RSRC);
  const wrongSet = C.patchSource(RSRC, r,
    [{ path: C.lanePath(r.doc, 1).concat(['name']), value: 'B' }]);
  assert.strictEqual(wrongSet.ok, false, '沒有 name 的 lane 用 set 必須被擋');
  const wrongInsert = C.patchSource(RSRC, r,
    [{ op: 'insert', path: C.lanePath(r.doc, 2).concat(['name']), value: 'C' }]);
  assert.strictEqual(wrongInsert.ok, false, '已經有 name 的 lane 用 insert 必須被擋');
}

// 配方 3：新增 lane → insert 到 laneInsertPath
{
  const r = C.parseSource(RSRC);
  const lane = { name: 'N', wave: '00' };
  const want = laneShape(C.addLane(r.doc, 1, lane));
  const out = C.patchSource(RSRC, r,
    [{ op: 'insert', path: C.laneInsertPath(r.doc, 1), value: lane }]);
  assert.strictEqual(out.ok, true, 'Got ' + JSON.stringify(out));
  assert.deepStrictEqual(laneShape(C.parseSource(out.text).doc), want);
}

// 配方 4：刪 lane → remove 到 laneRemovePath
{
  const r = C.parseSource(RSRC);
  const want = laneShape(C.removeLane(r.doc, 2));
  const out = C.patchSource(RSRC, r, [{ op: 'remove', path: C.laneRemovePath(r.doc, 2) }]);
  assert.strictEqual(out.ok, true, 'Got ' + JSON.stringify(out));
  assert.deepStrictEqual(laneShape(C.parseSource(out.text).doc), want);
  assert.ok(out.text.includes('// lane a'), '別人的註解不得被動到');
}

// 配方 5：搬 lane → move，兩端都問橋
{
  const r = C.parseSource(RSRC);
  const want = laneShape(C.moveLane(r.doc, 1, 3));
  const out = C.patchSource(RSRC, r, [{
    op: 'move',
    path: C.lanePath(r.doc, 1),
    to: C.laneInsertPath(r.doc, 3 < 1 ? 3 : 3 + 1),
  }]);
  assert.strictEqual(out.ok, true, 'Got ' + JSON.stringify(out));
  assert.deepStrictEqual(laneShape(C.parseSource(out.text).doc), want);
  assert.ok(out.text.includes('// 沒有名字，而且在 group 裡面'), '搬走的那條的註解跟著它');
}

// R2：replace 的範圍。它是「就地換掉一個值」，不是結構改寫的後門。
{
  const r = C.parseSource(GSRC);
  assert.strictEqual(C.patchSource(GSRC, r,
    [{ op: 'replace', path: ['signal'], value: [{ name: 'x', wave: '0' }] }]).ok, false,
    'replace 不得把整個 lane 清單換掉');
  assert.strictEqual(C.patchSource(GSRC, r,
    [{ op: 'replace', path: ['signal', 1], value: ['grp', { name: 'x', wave: '0' }] }]).ok,
    false, 'replace 不得把一整個 group 換掉');
  assert.strictEqual(C.patchSource(GSRC, r,
    [{ op: 'replace', path: ['signal', 0], value: { name: 'x', wave: '0' } }]).ok, false,
    'replace 不得把一整條 lane 換掉');
}

// R2 的另一半：多行／帶註解的值也不行——那正是逐格編輯保得住、replace 保不住的東西
{
  const src = ['{ signal: [',
    '  { name: "a", wave: "22",',
    '    data: [',
    '      "A",   // the first label',
    '      "B",   // the second label',
    '    ] },',
    ']}'].join('\n');
  const r = C.parseSource(src);
  const bad = C.patchSource(src, r,
    [{ op: 'replace', path: ['signal', 0, 'data'], value: ['A', '', 'B'] }]);
  assert.strictEqual(bad.ok, false,
    '跨行或帶註解的值不得整包換掉——那會把每個標籤旁邊的註解一起帶走');
  const ok = C.patchSource(src, r,
    [{ op: 'insert', path: ['signal', 0, 'data', 1], value: '' }]);
  assert.strictEqual(ok.ok, true, '逐格才是這種情況對的路。Got ' + JSON.stringify(ok));
  assert.ok(ok.text.includes('// the first label'), '兩個標籤註解都要留著');
  assert.ok(ok.text.includes('// the second label'));
}

// R2 不得誤殺 N2 要的那個用法：單行、沒有註解的值
{
  const src = '{ signal: [\n  { name: "a", wave: "03", data: "A" },   // 旁邊的註解\n]}';
  const r = C.parseSource(src);
  const out = C.patchSource(src, r,
    [{ op: 'replace', path: ['signal', 0, 'data'], value: ['', 'A'] }]);
  assert.strictEqual(out.ok, true, 'Got ' + JSON.stringify(out));
  assert.ok(out.text.includes('// 旁邊的註解'), '值之外的註解本來就不在 span 裡');
  assert.deepStrictEqual(C.parseSource(out.text).doc.signal[0].data, ['', 'A']);
}

// R4：作者自己寫的空 group 是他的內容，不是我們清出來的空位，不得被順手掃掉
{
  const doc = { signal: [['g1', { name: 'b', wave: '01' }, ['g2']], { name: 'd', wave: '01' }] };
  const out = C.removeLane(doc, 0);
  assert.deepStrictEqual(out.signal[0], ['g1', ['g2']],
    'g1 裡還有作者寫的 g2，所以 g1 與 g2 都留著');
  assert.strictEqual(out.signal[1].name, 'd');
}
{
  const doc = { signal: [['grp', { name: 'b', wave: '01' }], { name: 'd', wave: '01' }] };
  assert.deepStrictEqual(C.removeLane(doc, 0).signal.map(function (l) { return l.name; }),
    ['d'], '只剩標題的 group 還是要走（N3 沒變）');
}

// R5-1：巢狀 group 裡的 lane 不得被連坐刪掉
{
  const doc = { signal: [['g1', { name: 'b', wave: '01' }, ['g2', { name: 'c', wave: '01' }]]] };
  const out = C.removeLane(doc, 0);
  assert.deepStrictEqual(out.signal[0], ['g1', ['g2', { name: 'c', wave: '01' }]],
    'g2 裡面的 c 不得被連坐刪掉');
  assert.deepStrictEqual(C.lanePath(out, 0), ['signal', 0, 1, 1], 'c 還定位得到');
}

// R5-2：move 的落點不得掉進它自己要切掉的那段位元組裡
{
  const src = ['{ signal: [', '  ["g1",', '    { name: "b", wave: "01" },', '  ],',
    '  { name: "d", wave: "01" },', ']}'].join('\n');
  const r = C.parseSource(src);
  // 落在 g1 的標題前面：g1 只剩標題，所以切掉的是整個 g1，而落點在它的位元組裡面
  const out = C.patchSource(src, r,
    [{ op: 'move', path: ['signal', 0, 1], to: ['signal', 0, 0] }]);
  assert.strictEqual(out.ok, false, '搬進自己要被切掉的那段裡面，必須拒絕');
  assert.ok(/inside/.test(out.reason), 'Got ' + out.reason);
  // 而搬到它自己後面那一格是貨真價實的原地不動，那個要成功
  const noop = C.patchSource(src, r,
    [{ op: 'move', path: ['signal', 0, 1], to: ['signal', 0, 2] }]);
  assert.strictEqual(noop.ok, true, '原地不動要成功。Got ' + JSON.stringify(noop));
  assert.strictEqual(noop.text, src, '原地不動就一個位元組都不動');
}

// R5-3：落點是一個空陣列
{
  const src = ['{', '  signal: [', '    { name: "a", wave: "01" },   // lane a',
    '    { name: "b", wave: "10" },   // lane b', '  ],', '  spare: [', '  ],', '}'].join('\n');
  const r = C.parseSource(src);
  const out = C.patchSource(src, r, [{ op: 'move', path: ['signal', 1], to: ['spare', 0] }]);
  assert.strictEqual(out.ok, true, 'Got ' + JSON.stringify(out));
  const back = C.parseSource(out.text);
  assert.strictEqual(back.ok, true, 'Got ' + JSON.stringify(back));
  assert.deepStrictEqual(back.doc.signal.map(function (l) { return l.name; }), ['a']);
  assert.deepStrictEqual(back.doc.spare.map(function (l) { return l.name; }), ['b']);
  assert.ok(out.text.includes('// lane b'), '搬進空陣列，註解一樣跟著');
}

// R5-4：落點超出範圍 / 根本不是陣列
{
  const r = C.parseSource(GSRC);
  assert.strictEqual(C.patchSource(GSRC, r,
    [{ op: 'move', path: C.lanePath(r.doc, 0), to: ['signal', 9] }]).ok, false,
    '超出範圍的落點要拒絕');
  assert.strictEqual(C.patchSource(GSRC, r,
    [{ op: 'move', path: C.lanePath(r.doc, 0), to: ['signal', 0, 9] }]).ok, false,
    '落點的父層不是陣列也要拒絕');
}

// R5-5：copyCycles 不得把「沒有標籤」變成一個空字串標籤
{
  const clip = C.copyCycles({ signal: [{ name: 'x', wave: '22', data: ['A'] }] }, 0, 2);
  assert.strictEqual(clip.lanes[0].data.length, 2);
  assert.strictEqual(clip.lanes[0].data[1], undefined, '沒有標籤就是沒有，不是空字串');
  const out = C.pasteCycles({ signal: [{ name: 'y', wave: '00', data: [] }] },
    0, clip, 'overwrite');
  assert.deepStrictEqual(out.signal[0].data, ['A'],
    '第二拍沒有標籤，就不得替它補一個空字串出來');
}
// 順帶把「備用標籤」的行為也釘住：wave 用不到的標籤原樣留著，接在後面
{
  const clip = C.copyCycles({ signal: [{ name: 'x', wave: '22', data: ['A'] }] }, 0, 2);
  const out = C.pasteCycles({ signal: [{ name: 'y', wave: '00', data: 'P' }] },
    0, clip, 'overwrite');
  assert.strictEqual(out.signal[0].data, 'A P',
    'P 是原本那條 lane 用不到的備用標籤，照既有規矩原樣留著；重點是中間沒有空格位');
}

// R8：最後一個標籤離開之後，data 留著空的形狀（不刪 key），而且兩種寫法都寫得回去
{
  const doc = { signal: [{ name: 'a', wave: '23', data: ['A', 'B'] }] };
  const gone = C.setCellRange(doc, 0, 0, 1, '0');
  assert.strictEqual(gone.signal[0].wave, '0.');
  assert.deepStrictEqual(gone.signal[0].data, [],
    '沒有值字元了，data 空掉但 key 留著——刪掉作者寫的 key 比清空它動得更多');
}
{
  const doc = { signal: [{ name: 'a', wave: '23', data: 'A B' }] };
  assert.strictEqual(C.setCellRange(doc, 0, 0, 1, '0').signal[0].data, '',
    '字串寫法就留一個空字串');
}
{
  const src = '{ signal: [\n  { name: "a", wave: "23", data: ["A","B"] },\n]}';
  const r = C.parseSource(src);
  const out = C.patchSource(src, r, [
    { path: ['signal', 0, 'wave'], value: '0.' },
    { op: 'remove', path: ['signal', 0, 'data', 0] },
    { op: 'remove', path: ['signal', 0, 'data', 1] },
  ]);
  assert.strictEqual(out.ok, true, '空掉的陣列走逐格 remove，不需要 replace。Got ' +
    JSON.stringify(out));
  const back = C.parseSource(out.text);
  assert.deepStrictEqual(back.doc.signal[0].data, []);
  assert.strictEqual(back.doc.signal[0].wave, '0.');
}
{
  const src = '{ signal: [\n  { name: "a", wave: "23", data: "A B" },\n]}';
  const r = C.parseSource(src);
  const out = C.patchSource(src, r, [
    { path: ['signal', 0, 'wave'], value: '0.' },
    { path: ['signal', 0, 'data'], value: '' },
  ]);
  assert.strictEqual(out.ok, true, '空掉的字串是一個普通的 set。Got ' + JSON.stringify(out));
  assert.strictEqual(C.parseSource(out.text).doc.signal[0].data, '');
}

// ---- 以下為 Task 5 fix1 釘住的合約（一次刪一組 lane 的 removal path） ----

// N3：整組一起算的刪除。逐條問 laneRemovePath 的答案永遠是「就這條 lane」——因為
// 在那份文件裡同組的另一條還在——於是兩條都刪會在檔案裡留下一個空 group。
{
  const r = C.parseSource(GSRC);

  // 單條時，兩扇門必須給同一個答案。兩套規則只要允許漂移，遲早會漂。
  for (let k = 0; k < 4; k++) {
    assert.deepStrictEqual(C.laneRemovePaths(r.doc, [k]), [C.laneRemovePath(r.doc, k)],
      '單條的集合版必須跟 laneRemovePath 一模一樣（編號 ' + k + '）');
  }

  // 前提本身：逐條問的答案確實是「就這條 lane」
  assert.deepStrictEqual(C.laneRemovePath(r.doc, 1), ['signal', 1, 1]);
  assert.deepStrictEqual(C.laneRemovePath(r.doc, 2), ['signal', 1, 2]);
  // 而整組一起算的時候，group 本身才是要拿掉的東西
  assert.deepStrictEqual(C.laneRemovePaths(r.doc, [1, 2]), [['signal', 1]],
    'group 裡的 lane 全刪 → 拿掉整個 group');
  assert.deepStrictEqual(C.laneRemovePaths(r.doc, [2, 1]), [['signal', 1]],
    '順序不影響答案');
  assert.deepStrictEqual(C.laneRemovePaths(r.doc, [0, 1, 2, 3]),
    [['signal', 0], ['signal', 1], ['signal', 2]],
    '全刪光：signal 自己永遠不是答案');
  assert.deepStrictEqual(C.laneRemovePaths(r.doc, []), [], '空集合什麼都不刪');
  assert.strictEqual(C.laneRemovePaths(r.doc, [4]), null, '超出範圍回 null，不是猜一個');
  assert.strictEqual(C.laneRemovePaths(r.doc, [0, -1]), null);
  assert.strictEqual(C.laneRemovePaths(null, [0]), null);
  assert.strictEqual(C.laneRemovePaths(r.doc, 'nope'), null);

  // 回的路徑互不包含，所以可以一次全部丟給 patchSource
  const out = C.patchSource(GSRC, r,
    C.laneRemovePaths(r.doc, [1, 2]).map(function (p) { return { op: 'remove', path: p }; }));
  assert.strictEqual(out.ok, true, 'Got ' + JSON.stringify(out));
  assert.deepStrictEqual(laneShape(C.parseSource(out.text).doc), ['a', 'd'],
    '兩條一起刪，group 連標題一起走，不留空殼');
  assert.ok(!out.text.includes('grp'), '空 group 不准留在檔案裡');
}

// N3c：防漂移的釘子要蓋過它守的那條規則。單條等價只在 GSRC 的四個位置上比過，
// 而 holdsContent 真正可能分歧的地方是**巢狀**與**作者自己寫的空 group**：那正是
// F2 證明過「漂移很貴」的地形。這裡把每一種形狀的每一條 lane 都比一遍。
{
  const SHAPES = [
    // 巢狀兩層
    ['{ signal: [', '  ["outer",', '    { name: "b", wave: "01" },',
      '    ["inner",', '      { name: "x", wave: "01" },', '    ],', '  ],', ']}'],
    // 巢狀 + 作者自己寫的空 group（同層）
    ['{ signal: [', '  ["outer",', '    { name: "b", wave: "01" },',
      '    ["author-empty"],', '  ],', '  { name: "z", wave: "01" },', ']}'],
    // 最上層就有一個作者自己寫的空 group
    ['{ signal: [', '  ["author-empty"],', '  { name: "a", wave: "01" },',
      '  ["g", { name: "b", wave: "01" }],', ']}'],
    // 三層，最裡面只有一條
    ['{ signal: [', '  ["l1",', '    ["l2",', '      ["l3",',
      '        { name: "deep", wave: "01" },', '      ],', '    ],',
      '    { name: "side", wave: "01" },', '  ],', ']}'],
    // 一個 group 裡兩條、外面兩條
    ['{ signal: [', '  { name: "a", wave: "01" },',
      '  ["g", { name: "b", wave: "01" }, { name: "c", wave: "01" }],',
      '  { name: "d", wave: "01" },', ']}'],
    // 沒有 group
    ['{ signal: [', '  { name: "a", wave: "01" },', '  { name: "b", wave: "01" },', ']}'],
  ];
  for (const lines of SHAPES) {
    const src = lines.join('\n');
    const rr = C.parseSource(src);
    assert.strictEqual(rr.ok, true, 'fixture 必須解析得出來：' + src);
    const n = C.lanePaths(rr.doc).length;
    assert.ok(n > 0, 'fixture 必須有 lane：' + src);
    for (let k = 0; k < n; k++) {
      assert.deepStrictEqual(C.laneRemovePaths(rr.doc, [k]), [C.laneRemovePath(rr.doc, k)],
        '單條的兩扇門必須一致（編號 ' + k + '）於：' + src);
      // 而且兩扇門寫回去之後的樹也要一樣
      const one = C.patchSource(src, C.parseSource(src),
        [{ op: 'remove', path: C.laneRemovePath(rr.doc, k) }]);
      const set = C.patchSource(src, C.parseSource(src),
        C.laneRemovePaths(rr.doc, [k]).map(function (q) { return { op: 'remove', path: q }; }));
      assert.strictEqual(one.ok, true, 'Got ' + JSON.stringify(one));
      assert.strictEqual(set.ok, true, 'Got ' + JSON.stringify(set));
      assert.strictEqual(set.text, one.text,
        '兩扇門寫出來的位元組也要一樣（編號 ' + k + '）於：' + src);
    }
  }
}

// N3b：巢狀與「作者自己寫的空 group」——後者是內容，會撐住父層（Task 3 的裁示）
{
  const src = ['{ signal: [',
    '  ["outer",',
    '    { name: "b", wave: "01" },',
    '    ["inner",',
    '      { name: "x", wave: "01" },',
    '    ],',
    '    ["author-empty"],',
    '  ],',
    ']}'].join('\n');
  const r = C.parseSource(src);
  assert.deepStrictEqual(C.laneRemovePaths(r.doc, [1]), [['signal', 0, 2]],
    '只刪 inner 裡那條 → 收掉 inner');
  assert.deepStrictEqual(C.laneRemovePaths(r.doc, [0, 1]), [['signal', 0, 1], ['signal', 0, 2]],
    '兩層的 lane 都刪光，但 outer 裡還有作者自己寫的空 group，所以 outer 留著');
  const out = C.patchSource(src, r,
    C.laneRemovePaths(r.doc, [0, 1]).map(function (p) { return { op: 'remove', path: p }; }));
  assert.strictEqual(out.ok, true, 'Got ' + JSON.stringify(out));
  assert.deepStrictEqual(C.parseSource(out.text).doc.signal, [['outer', ['author-empty']]],
    '作者自己的空 group 是他的，不准跟著被收掉');
}

console.log('wave-codec.test.js OK');
