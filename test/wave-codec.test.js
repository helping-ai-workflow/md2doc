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

console.log('wave-codec.test.js OK');
