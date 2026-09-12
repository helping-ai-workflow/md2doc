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

  // 刪掉第一筆時，它那一行的註解跟著它走（註解在 member span 之外，所以留下）
  const first = C.patchSource(SRC, r, [{ op: 'remove', path: ['signal', 0] }]);
  assert.strictEqual(first.ok, true, 'Got ' + JSON.stringify(first));
  const f2 = C.parseSource(first.text);
  assert.strictEqual(f2.ok, true, 'Got ' + JSON.stringify(f2));
  assert.deepStrictEqual(f2.doc.signal.map((s) => s.name), ['data']);

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

// 交疊的編輯必須拒絕（容器與它的孩子同時改）
{
  const r = C.parseSource(SRC);
  const out = C.patchSource(SRC, r, [
    { path: ['signal', 0], value: { name: 'z', wave: '0' } },
    { path: ['signal', 0, 'wave'], value: '1' },
  ]);
  assert.strictEqual(out.ok, false, '兩筆編輯蓋到同一段，必須拒絕');
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

console.log('wave-codec.test.js OK');
