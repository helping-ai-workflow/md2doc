'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../lib/editor/wave-codec.js');
const S = require('../lib/editor/wave-store.js');

// ---------------------------------------------------------------------------
// fixtures
//
// SRC 是 brief 逐字給的那一份。GSRC 帶 group —— 這批的沉默 bug 全都住在「攤平的
// 顯示編號」與「容器路徑」不一致的那道縫裡，而沒有 group 的 fixture 上兩套編號
// 剛好重合，測不出來（wave-codec.test.js Task 3 fix round 2 的教訓）。所以除了
// brief 那一段之外，每一段都站在 GSRC 上。
// ---------------------------------------------------------------------------
const SRC = [
  '{ signal: [',
  '  { name: "clk",  wave: "p......" },   // 主時脈',
  "  { name: 'data', wave: 'x.34.5x', data: ['a','b','c'] },",
  ']}',
].join('\n');

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

// 比的是整棵樹的形狀，不是攤平的名字順序：插在 group 前面與插在 group 裡第一條
// lane 前面，攤平之後長得一模一樣。（copy 自 wave-codec.test.js 的同名 helper）
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

const clone = function (doc) { return JSON.parse(JSON.stringify(doc)); };

// ---------------------------------------------------------------------------
// T1：brief 那一段，逐字。外加一條「patch 真的算過」的斷言——只回原文的 store
// 也能讓上面四行 isDirty 與那條註解斷言全綠，那樣的 fixture 等於沒測。
// ---------------------------------------------------------------------------
{
  const s = S.createStore(SRC);
  assert.strictEqual(s.isDirty(), false, '剛開的 store 不是髒的');
  s.apply('set-cell', (d) => C.setCell(d, 0, 2, '1'));
  assert.strictEqual(s.isDirty(), true);
  s.undo();
  assert.strictEqual(s.isDirty(), false, 'undo 回到原點就不再是髒的');
  s.redo();
  assert.strictEqual(s.isDirty(), true);

  const patch = s.toPatch();
  assert.strictEqual(patch.ok, true);
  assert.ok(patch.text.includes('// 主時脈'), '註解必須存活到 patch 產出');

  // 這一條才是 T1 的牙齒：改過的值必須真的寫進去，而且沿用原本的雙引號
  assert.ok(patch.text.includes('wave: "p.1p..."'),
    'patch 必須真的寫回改過的 wave。Got ' + JSON.stringify(patch.text));
  assert.strictEqual(C.parseSource(patch.text).doc.signal[0].wave, 'p.1p...');
  // 其餘位元組逐字不動
  assert.strictEqual(patch.text, SRC.replace('"p......"', '"p.1p..."'),
    '除了那一個值，整份來源必須逐字不動');
}

// ---------------------------------------------------------------------------
// T2：lane 編號是 codec 的攤平顯示順序。編號 2 是 group 裡的 c，naive 的
// ['signal',2] 指到的是 d —— 兩條都存在，所以指錯了不會有人拒絕。
// ---------------------------------------------------------------------------
{
  const s = S.createStore(GSRC);
  assert.strictEqual(s.apply('set-cell', (d) => C.setCell(d, 2, 1, 'x')), true,
    'apply 有改到東西時要回 true');
  const patch = s.toPatch();
  assert.strictEqual(patch.ok, true, 'Got ' + JSON.stringify(patch));
  const back = C.parseSource(patch.text);
  assert.strictEqual(back.ok, true, 'patch 出來的文字必須還讀得回來');
  assert.strictEqual(back.doc.signal[1][2].wave, '0x', '改的必須是 group 裡的 c');
  assert.strictEqual(back.doc.signal[2].wave, '01', 'd 不准被碰');
  assert.strictEqual(back.doc.signal[1][1].wave, '01', 'b 不准被碰');
  assert.ok(patch.text.includes('// lane c') && patch.text.includes('// lane d'),
    '四條註解都要留著');
  assert.strictEqual(patch.text, GSRC.replace('{ name: "c", wave: "01" }',
    '{ name: "c", wave: "0x" }'), '其餘位元組逐字不動');
}

// ---------------------------------------------------------------------------
// T3：isDirty 比的是文件，不是堆疊。改走再改回來 —— 堆疊上有兩筆，文件卻跟原點
// 一模一樣，檔案寫回去會是同一份位元組，所以那不是髒的。
// 用 `doc !== baseDoc` 的實作在這裡會紅。
// ---------------------------------------------------------------------------
{
  const s = S.createStore(GSRC);
  s.apply('rename', (d) => C.renameLane(d, 1, 'Z'));
  assert.strictEqual(s.isDirty(), true);
  s.apply('rename', (d) => C.renameLane(d, 1, 'b'));
  assert.notStrictEqual(s.doc, C.parseSource(GSRC).doc, '確實是另一個物件');
  assert.strictEqual(s.isDirty(), false,
    '改走再改回來，文件跟原點等值，就不是髒的');
  assert.strictEqual(s.canUndo(), true, '而堆疊上確實還有兩筆可以 undo');

  const patch = s.toPatch();
  assert.strictEqual(patch.ok, true, 'Got ' + JSON.stringify(patch));
  assert.strictEqual(patch.text, GSRC, '沒有差異就不該有任何位元組被動到');

  s.undo();
  s.undo();
  assert.strictEqual(s.isDirty(), false);
  assert.strictEqual(s.canUndo(), false);
}

// ---------------------------------------------------------------------------
// T4：rename 的兩條 recipe。有 name 走 set，沒有 name 走 insert —— 這是 codec
// 唯一有分支的 recipe，挑錯邊會被拒絕（不會靜默寫錯），所以兩邊都要釘。
// ---------------------------------------------------------------------------
{
  const s = S.createStore(GSRC);
  s.apply('rename', (d) => C.renameLane(d, 2, 'C2'));
  const patch = s.toPatch();
  assert.strictEqual(patch.ok, true, 'Got ' + JSON.stringify(patch));
  assert.deepStrictEqual(laneShape(C.parseSource(patch.text).doc), laneShape(s.doc),
    'rename：doc 與 patch 必須改到同一條 lane');
  assert.ok(patch.text.includes('// lane c'), '被改名那條旁邊的註解要留著');
}
{
  const NSRC = [
    '{ signal: [',
    '  { wave: "01" },   // spacer',
    '  ["grp",',
    '    { name: "b", wave: "01" },',
    '  ],',
    ']}',
  ].join('\n');
  const s = S.createStore(NSRC);
  s.apply('rename', (d) => C.renameLane(d, 0, 'S'));
  const patch = s.toPatch();
  assert.strictEqual(patch.ok, true,
    '沒有 name 的 lane 要走 insert，不是 set。Got ' + JSON.stringify(patch));
  assert.ok(patch.text.includes('// spacer'), '整條 lane 沒有被重寫，註解還在');
  const back = C.parseSource(patch.text);
  assert.strictEqual(back.ok, true);
  assert.strictEqual(back.doc.signal[0].name, 'S');
  assert.strictEqual(back.doc.signal[0].wave, '01');
}
{
  // 欄位被拿掉 —— 走 codec 的 remove（member 層），不是把整條 lane 重寫
  const s = S.createStore(GSRC);
  s.apply('drop-name', (d) => {
    const next = clone(d);
    delete next.signal[1][1].name;
    return next;
  });
  const patch = s.toPatch();
  assert.strictEqual(patch.ok, true, 'Got ' + JSON.stringify(patch));
  const back = C.parseSource(patch.text);
  assert.strictEqual(back.ok, true);
  assert.strictEqual('name' in back.doc.signal[1][1], false, 'name 必須真的不見');
  assert.strictEqual(back.doc.signal[1][1].wave, '01', '同一條 lane 的其他欄位不准動');
  assert.ok(patch.text.includes('// lane b'), '旁邊的註解要留著');
}

// ---------------------------------------------------------------------------
// T5：add 的 recipe。編號 1 = 插進 group 裡、在 b 前面；naive 的 ['signal',1]
// 會插在整個 group 前面，攤平之後看起來一樣，只有比樹形才看得出來。
// ---------------------------------------------------------------------------
{
  for (const k of [0, 1, 2, 3, 4]) {
    const s = S.createStore(GSRC);
    s.apply('add-lane', (d) => C.addLane(d, k, { name: 'N', wave: '00' }));
    const patch = s.toPatch();
    assert.strictEqual(patch.ok, true, 'add ' + k + ' Got ' + JSON.stringify(patch));
    assert.deepStrictEqual(laneShape(C.parseSource(patch.text).doc), laneShape(s.doc),
      'add ' + k + '：doc 與 patch 必須插在同一個位置');
    for (const note of ['// lane a', '// lane b', '// lane c', '// lane d']) {
      assert.ok(patch.text.includes(note), 'add ' + k + ' 之後 ' + note + ' 要還在');
    }
  }
}

// ---------------------------------------------------------------------------
// T6：remove 的 recipe，以及「group 被掏空就跟著走」。兩條 lane 分兩次刪，
// patch 這一側必須算出「刪掉整個 group」，不是留一個空殼在檔案裡。
// ---------------------------------------------------------------------------
{
  const s = S.createStore(GSRC);
  s.apply('remove-lane', (d) => C.removeLane(d, 1));
  const one = s.toPatch();
  assert.strictEqual(one.ok, true, 'Got ' + JSON.stringify(one));
  assert.deepStrictEqual(laneShape(C.parseSource(one.text).doc), laneShape(s.doc));
  assert.ok(one.text.includes('// lane c'), 'c 的註解要留著');
  assert.ok(!one.text.includes('// lane b'), 'b 的註解要跟著 b 走');

  s.apply('remove-lane', (d) => C.removeLane(d, 1));
  const both = s.toPatch();
  assert.strictEqual(both.ok, true, 'Got ' + JSON.stringify(both));
  assert.deepStrictEqual(laneShape(s.doc), ['a', 'd'], 'doc 這一側 group 已經沒了');
  assert.deepStrictEqual(laneShape(C.parseSource(both.text).doc), ['a', 'd'],
    '被掏空的 group 必須跟著最後一條 lane 一起消失');
  assert.ok(!both.text.includes('grp'), '空的 group 不准留在檔案裡');
  assert.ok(both.text.includes('// lane a') && both.text.includes('// lane d'));
}

// ---------------------------------------------------------------------------
// T7：move 的 recipe。搬進 group 裡，而且註解要跟著搬（remove + insert 做不到，
// 因為 insert 寫的是值，值不帶註解）。
// ---------------------------------------------------------------------------
{
  // [1,0] / [0,1] / [2,1] / [1,2] 是**相鄰對調**，而且跨 group 邊界：fix1 之前
  // 這四個全部靜默搬錯 lane（LIS 在相鄰對調上永遠有兩個等長解）。
  for (const pair of [[3, 1], [0, 3], [3, 0], [1, 0], [0, 1], [2, 1], [1, 2], [2, 3], [3, 2]]) {
    const s = S.createStore(GSRC);
    s.apply('move-lane', (d) => C.moveLane(d, pair[0], pair[1]));
    const patch = s.toPatch();
    assert.strictEqual(patch.ok, true,
      'move ' + pair + ' Got ' + JSON.stringify(patch));
    assert.deepStrictEqual(laneShape(C.parseSource(patch.text).doc), laneShape(s.doc),
      'move ' + pair + '：doc 與 patch 必須排出同一個順序');
    for (const note of ['// lane a', '// lane b', '// lane c', '// lane d']) {
      assert.ok(patch.text.includes(note), 'move ' + pair + ' 之後 ' + note + ' 要還在');
    }
  }
}

// ---------------------------------------------------------------------------
// T8：一次 patch 只表達得出一個 move。兩條 lane 都離開原本的相對順序時，
// 兩個 move 的目的地都算在同一份來源上，誰先落地沒有定義 —— 所以這裡拒絕，
// 用 codec 的拒絕形狀回報，而不是猜一個順序。
// ---------------------------------------------------------------------------
{
  const s = S.createStore(GSRC);
  s.apply('move-lane', (d) => C.moveLane(d, 0, 3));
  s.apply('move-lane', (d) => C.moveLane(d, 0, 3));
  assert.deepStrictEqual(laneShape(s.doc), [['grp', 'c'], 'd', 'a', 'b'],
    '先確認 fixture 真的把兩條 lane 都搬離原本的相對順序');
  const patch = s.toPatch();
  assert.strictEqual(patch.ok, false, '兩個 move 必須被拒絕，不是猜一個順序');
  assert.strictEqual(typeof patch.reason, 'string');
  assert.ok(patch.reason.length > 0, '拒絕要說得出理由');
  assert.strictEqual(patch.text, undefined, '拒絕就不准附一份重寫過的文字');
}

// ---------------------------------------------------------------------------
// T9：codec 的拒絕原封不動往上傳。決定使用者答案的是 Task 7，不是 store；
// 這裡不准偷偷改寫整個區塊當作退路。
//
// fixture 要挑「codec 真的會拒絕」的那一種。第一版用的是把 name 從字串換成物件，
// 那個 codec 其實寫得出來（replace 看的是**舊**值是不是含物件），於是斷言永遠綠——
// 等於沒測。真正到得了的拒絕是：`data` 寫成跨行、裡面還有註解，而長度變了，
// 一格一格換不掉、整個換又會把那些註解重排掉。
// ---------------------------------------------------------------------------
{
  const DSRC = [
    '{ signal: [',
    '  { name: "a", wave: "2222", data: [',
    "      'A',   // first",
    "      'B',",
    "      'C',",
    "      'D',",
    '  ] },',
    ']}',
  ].join('\n');
  const s = S.createStore(DSRC);
  s.apply('delete-cycles', (d) => C.deleteCycles(d, 0, 1));
  assert.strictEqual(s.doc.signal[0].wave, '222');
  assert.deepStrictEqual(s.doc.signal[0].data, ['B', 'C', 'D'],
    '先確認 fixture 真的讓 data 的長度變了');
  assert.strictEqual(s.isDirty(), true);

  const patch = s.toPatch();
  assert.strictEqual(patch.ok, false, 'codec 拒絕的東西，store 不准說成功');
  assert.strictEqual(typeof patch.reason, 'string', '理由要原封不動帶上來');
  assert.ok(patch.rewroteRange && typeof patch.rewroteRange.start === 'number' &&
    typeof patch.rewroteRange.end === 'number',
    'rewroteRange 也要原封不動帶上來（Task 7 要拿它給使用者看）。Got ' +
    JSON.stringify(patch.rewroteRange));
  assert.strictEqual(patch.text, undefined, '不准有 fallback 的重寫文字');
  assert.ok(DSRC.slice(patch.rewroteRange.start, patch.rewroteRange.end).includes('// first'),
    'rewroteRange 要指到真的那一段，不是隨手填的數字');

  // 被拒絕之後 store 本身不准動：doc 還在，還是髒的，下次再問還是同一個拒絕
  assert.strictEqual(s.isDirty(), true);
  assert.strictEqual(s.toPatch().ok, false);
}
{
  // 另一種拒絕：值自己含著自己，沒有 WaveJSON 的拼法。store 不准自己去序列化。
  const s = S.createStore(GSRC);
  s.apply('hand', (d) => {
    const next = clone(d);
    next.signal[0].loop = next.signal[0];
    return next;
  });
  assert.strictEqual(s.isDirty(), true);
  const patch = s.toPatch();
  assert.strictEqual(patch.ok, false, '寫不出來的值要拒絕，不是寫個空物件進去');
  assert.strictEqual(typeof patch.reason, 'string');
  assert.strictEqual(patch.text, undefined);
}

// ---------------------------------------------------------------------------
// T10：data。改一個 label 是逐格 set（陣列裡的註解與其他格的拼法都不准動）；
// 字串換成陣列是 codec 專門為它開的 replace。
// ---------------------------------------------------------------------------
{
  const s = S.createStore(SRC);
  s.apply('hand', (d) => {
    const next = clone(d);
    next.signal[1].data[1] = 'B';
    return next;
  });
  const patch = s.toPatch();
  assert.strictEqual(patch.ok, true, 'Got ' + JSON.stringify(patch));
  assert.strictEqual(patch.text, SRC.replace("'b'", "'B'"),
    '只有那一格會變，連引號都沿用。Got ' + JSON.stringify(patch.text));
}
{
  const src = ['{ signal: [',
    '  { name: "a", wave: "03", data: "A",   // about data',
    '    phase: 0 },',
    ']}'].join('\n');
  const s = S.createStore(src);
  s.apply('set-cell', (d) => C.setCell(d, 0, 0, '2'));
  assert.deepStrictEqual(s.doc.signal[0].data, ['', 'A'],
    '先確認 fixture 真的逼出字串→陣列的換型');
  const patch = s.toPatch();
  assert.strictEqual(patch.ok, true, '字串換陣列要走 replace。Got ' + JSON.stringify(patch));
  assert.ok(patch.text.includes('// about data'), 'data 旁邊的註解要留著');
  const back = C.parseSource(patch.text);
  assert.strictEqual(back.ok, true);
  assert.strictEqual(back.doc.signal[0].wave, '23');
  assert.deepStrictEqual(back.doc.signal[0].data, ['', 'A']);
  assert.strictEqual(back.doc.signal[0].phase, 0, 'phase 的位置與值都不准動');
}

// ---------------------------------------------------------------------------
// T11：堆疊本身。沒改到東西的 apply 不佔一格（否則使用者要按兩次 undo 才會動），
// 兩端也不准越界。
// ---------------------------------------------------------------------------
{
  const s = S.createStore(GSRC);
  assert.strictEqual(s.undo(), false, '原點上 undo 回 false');
  assert.strictEqual(s.redo(), false, '沒有東西可以 redo');

  assert.strictEqual(s.apply('set-cell', (d) => C.setCell(d, 99, 0, '1')), false,
    '超出範圍的 op：codec 回同一個 doc，store 要當作沒發生');
  assert.strictEqual(s.canUndo(), false, '沒改到東西就不准佔一格堆疊');
  assert.strictEqual(s.isDirty(), false);

  assert.strictEqual(s.apply('set-cell', (d) => C.setCell(d, 0, 1, 'x')), true);
  assert.strictEqual(s.undoName(), 'set-cell', 'op 的名字要留著給 Task 7 併批次用');
  assert.strictEqual(s.undo(), true);
  assert.strictEqual(s.redoName(), 'set-cell');
  assert.strictEqual(s.undo(), false);

  // undo 之後再 apply，被丟掉的那條 redo 不准復活
  assert.strictEqual(s.redo(), true);
  assert.strictEqual(s.undo(), true);
  s.apply('rename', (d) => C.renameLane(d, 0, 'A2'));
  assert.strictEqual(s.canRedo(), false, 'apply 之後 redo 這一支要被截掉');
  assert.strictEqual(s.doc.signal[0].name, 'A2');
  assert.strictEqual(s.doc.signal[0].wave, '01', '被截掉的那一步不准留在文件上');
}

// ---------------------------------------------------------------------------
// T12：讀不回來的來源。store 不丟例外，而且不准假裝乾淨地產出 patch。
// ---------------------------------------------------------------------------
{
  const s = S.createStore('{ signal: [ {name: } ] }');
  assert.strictEqual(s.ok, false, '壞掉的來源要說出來');
  assert.strictEqual(s.doc, null);
  assert.strictEqual(s.isDirty(), false);
  assert.strictEqual(s.apply('set-cell', (d) => C.setCell(d, 0, 0, '1')), false);
  assert.strictEqual(s.undo(), false);
  assert.strictEqual(s.redo(), false);
  const patch = s.toPatch();
  assert.strictEqual(patch.ok, false, '讀不回來的來源不可能有最小 patch');
  assert.strictEqual(typeof patch.reason, 'string');
  assert.strictEqual(patch.text, undefined);
  // 這一格的 rewroteRange 是 null，而且是**刻意**的：沒有 span 表、也沒有任何一筆
  // edit，沒有東西可以框給使用者看；出問題的位置在 s.error.offset。
  assert.strictEqual(patch.rewroteRange, null);
  assert.strictEqual(typeof s.error.offset, 'number');
  assert.ok(s.error.message.length > 0);
}

// ---------------------------------------------------------------------------
// T13：跨 lane 的 op（加 cycle）—— group 裡的 lane 跟外面的一起變，一份 patch
// 裡四筆 set 互不重疊，四條註解全留。
// ---------------------------------------------------------------------------
{
  const s = S.createStore(GSRC);
  s.apply('insert-cycles', (d) => C.insertCycles(d, 1, 2));
  const patch = s.toPatch();
  assert.strictEqual(patch.ok, true, 'Got ' + JSON.stringify(patch));
  const back = C.parseSource(patch.text);
  assert.strictEqual(back.ok, true);
  assert.strictEqual(back.doc.signal[0].wave, '0..1');
  assert.strictEqual(back.doc.signal[1][1].wave, '0..1', 'group 裡的也要一起變寬');
  assert.strictEqual(back.doc.signal[1][2].wave, '0..1');
  assert.strictEqual(back.doc.signal[2].wave, '0..1');
  for (const note of ['// lane a', '// lane b', '// lane c', '// lane d']) {
    assert.ok(patch.text.includes(note), note + ' 要還在');
  }
  assert.strictEqual(patch.text, GSRC.split('wave: "01"').join('wave: "0..1"'),
    '四條 lane 之外的位元組逐字不動');
}

// ---------------------------------------------------------------------------
// T14：group 的標題被改掉、同時又有結構性變動 —— codec 沒有任何 op 會這樣做，
// 只有手寫的 fn 到得了。到不了的事情要拒絕，不准靜默漏掉那次改名。
// ---------------------------------------------------------------------------
{
  const s = S.createStore(GSRC);
  s.apply('hand', (d) => {
    const next = clone(C.removeLane(d, 0));
    next.signal[0][0] = 'GRP';
    return next;
  });
  const patch = s.toPatch();
  assert.strictEqual(patch.ok, false,
    '結構變動與 group 改名同時發生時要拒絕。Got ' + JSON.stringify(patch));
  assert.strictEqual(typeof patch.reason, 'string');
}

// ---------------------------------------------------------------------------
// T16：兩種操作疊在同一次存檔上。這四格是量出來的，不是想出來的：
// 結構性改動與別條 lane 的內容改動可以同一份 patch 寫回去；但是「同一條 lane
// 又搬又改」與「兩條新 lane 插在同一個位置」在同一份來源上沒有定義，由 codec
// 拒絕、store 原封不動往上傳。
// ---------------------------------------------------------------------------
{
  const s = S.createStore(GSRC);
  s.apply('add-lane', (d) => C.addLane(d, 1, { name: 'N', wave: '00' }));
  s.apply('set-cell', (d) => C.setCell(d, 0, 1, 'x'));
  const patch = s.toPatch();
  assert.strictEqual(patch.ok, true, '加一條 lane 加上改別條的內容。Got ' + JSON.stringify(patch));
  const back = C.parseSource(patch.text);
  assert.deepStrictEqual(laneShape(back.doc), laneShape(s.doc));
  assert.strictEqual(back.doc.signal[0].wave, '0x');
  assert.ok(patch.text.includes('// lane b'), '新 lane 不准偷走鄰居的註解');
}
{
  const s = S.createStore(GSRC);
  s.apply('remove-lane', (d) => C.removeLane(d, 0));
  s.apply('set-cell', (d) => C.setCell(d, 2, 1, 'x'));
  const patch = s.toPatch();
  assert.strictEqual(patch.ok, true, '刪一條 lane 加上改別條的內容。Got ' + JSON.stringify(patch));
  const back = C.parseSource(patch.text);
  assert.deepStrictEqual(laneShape(back.doc), laneShape(s.doc));
  assert.strictEqual(back.doc.signal[1].wave, '0x',
    '刪掉之後的編號 2 是 d —— 兩套編號在這裡會給出不同答案');
  assert.strictEqual(back.doc.signal[0][1].wave, '01');
}
{
  const s = S.createStore(GSRC);
  s.apply('move-lane', (d) => C.moveLane(d, 3, 1));
  s.apply('rename', (d) => C.renameLane(d, 1, 'D2'));
  const patch = s.toPatch();
  assert.strictEqual(patch.ok, false,
    '同一條 lane 又搬又改：搬走的位元組裡就含著要改的那個值，不是局部替換');
  assert.strictEqual(typeof patch.reason, 'string');
  assert.strictEqual(patch.text, undefined);
}
{
  const s = S.createStore(GSRC);
  s.apply('add-lane', (d) => C.addLane(d, 1, { name: 'N1', wave: '00' }));
  s.apply('add-lane', (d) => C.addLane(d, 1, { name: 'N2', wave: '00' }));
  const patch = s.toPatch();
  assert.strictEqual(patch.ok, false, '兩條新 lane 插在同一個位置，誰先誰後沒有定義');
  assert.strictEqual(typeof patch.reason, 'string');
  assert.strictEqual(patch.text, undefined);
}

// ---------------------------------------------------------------------------
// T17：把所有單一 move 掃過一遍。相鄰對調（t === f-1、t === f+1）是 lane list 上
// 最常見的手勢，而它在攤平的顯示順序上**永遠有兩個等長的解**——「把 f 往上搬一格」
// 與「把 f-1 往下搬一格」順序一模一樣、樹卻不一樣。只靠順序選不出來，所以 fix1
// 改成逐個候選驗證：把 patch 寫出來、讀回去，跟 doc 比。這一段把兩個 fixture 的
// 每一個有序對都釘住。
// ---------------------------------------------------------------------------
{
  const SIX = [
    '{ signal: [',
    '  { name: "a", wave: "01" },   // lane a',
    '  ["g1",',
    '    { name: "b", wave: "01" },   // lane b',
    '    { name: "c", wave: "01" },   // lane c',
    '  ],',
    '  { name: "d", wave: "01" },   // lane d',
    '  ["g2",',
    '    { name: "e", wave: "01" },   // lane e',
    '    { name: "f", wave: "01" },   // lane f',
    '  ],',
    ']}',
  ].join('\n');
  for (const fixture of [{ src: GSRC, n: 4, tag: 'GSRC' }, { src: SIX, n: 6, tag: 'SIX' }]) {
    for (let from = 0; from < fixture.n; from++) {
      for (let to = 0; to < fixture.n; to++) {
        if (from === to) continue;
        const tag = fixture.tag + ' move ' + from + '->' + to;
        const s = S.createStore(fixture.src);
        s.apply('move-lane', (d) => C.moveLane(d, from, to));
        const patch = s.toPatch();
        assert.strictEqual(patch.ok, true, tag + ' 必須寫得回去。Got ' + JSON.stringify(patch));
        const back = C.parseSource(patch.text);
        assert.strictEqual(back.ok, true, tag + ' 寫出來的文字必須讀得回來');
        assert.deepStrictEqual(laneShape(back.doc), laneShape(s.doc),
          tag + '：patch 讀回來的樹必須就是 doc 的樹');
        for (const note of ['// lane a', '// lane b', '// lane c', '// lane d']) {
          assert.ok(patch.text.includes(note), tag + ' 之後 ' + note + ' 要還在');
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// T18：一條 lane 被刪、另一條 lane 搬出同一個 group，兩件事合起來把 group 掏空。
// codec 的 move 只收「在**原文**裡就已經空掉」的容器，刪除那一側也只看得到自己那
// 一條，於是舊版會在檔案裡留下 `["g1",]` —— 正是集合式刪除要防的那個空殼。
// 現在「誰離開了容器」是從整份計畫算的；而這個組合沒有單一份 patch 寫得出來
// （group 的位元組範圍含著要搬走的那條 lane），所以誠實拒絕，不是掉一個殼。
// ---------------------------------------------------------------------------
{
  const ESRC = [
    '{ signal: [',
    '  { name: "a", wave: "01" },   // lane a',
    '  ["g1",',
    '    { name: "b", wave: "01" },   // lane b',
    '    { name: "c", wave: "01" },   // lane c',
    '  ],',
    '  { name: "d", wave: "01" },   // lane d',
    ']}',
  ].join('\n');
  const s = S.createStore(ESRC);
  s.apply('remove-lane', (d) => C.removeLane(d, 2));   // 刪掉 c
  s.apply('move-lane', (d) => C.moveLane(d, 1, 2));    // 把 b 拖到最後
  assert.deepStrictEqual(laneShape(s.doc), ['a', 'd', 'b'],
    '先確認 fixture：doc 這一側 g1 已經整個不見了');
  const patch = s.toPatch();
  assert.strictEqual(patch.ok, false,
    '刪除與搬移聯手掏空的 group，不准留殼、也不准假裝成功。Got ' + JSON.stringify(patch));
  assert.strictEqual(patch.text, undefined, '拒絕就不准附文字');
  assert.strictEqual(typeof patch.reason, 'string');
  assert.ok(patch.reason.includes('deletion and a drag'),
    '這一種要由 store 自己說清楚是哪兩件事撞在一起，不是退回 codec 的「範圍重疊」。' +
    'Got ' + JSON.stringify(patch.reason));
  assert.ok(patch.rewroteRange && typeof patch.rewroteRange.start === 'number',
    '要給呼叫端一段可以框起來給使用者看的範圍');

  // 單獨搬出去、group 因此空掉的那一種**必須照樣寫得出來**（codec 的 move 本來就
  // 收這一種），不可以被上面那條規則誤殺
  const one = S.createStore([
    '{ signal: [',
    '  { name: "a", wave: "01" },   // lane a',
    '  ["solo",',
    '    { name: "b", wave: "01" },   // lane b',
    '  ],',
    '  { name: "d", wave: "01" },   // lane d',
    ']}',
  ].join('\n'));
  one.apply('move-lane', (d) => C.moveLane(d, 1, 2));
  const p2 = one.toPatch();
  assert.strictEqual(p2.ok, true, '只有 move 掏空的 group 要照樣寫得回去。Got ' +
    JSON.stringify(p2));
  assert.deepStrictEqual(laneShape(C.parseSource(p2.text).doc), laneShape(one.doc));
  assert.ok(!p2.text.includes('solo'), '空掉的 group 連標題一起走');
  assert.ok(p2.text.includes('// lane b'), 'move 要把註解一起帶走');
}

// ---------------------------------------------------------------------------
// T19：交出去的文件是唯讀的。堆疊最底下那一份就是 baseDoc 本人，直接寫進去會
// 同時改掉「現況」與「原點」，於是 isDirty() 說不髒、patch 逐字等於原文——編輯
// 靜默蒸發。凍起來，讓它在犯錯的當下大聲壞掉。
// ---------------------------------------------------------------------------
{
  const s = S.createStore(GSRC);
  assert.strictEqual(Object.isFrozen(s.doc), true, 'doc 必須凍住');
  assert.strictEqual(Object.isFrozen(s.doc.signal), true, 'signal 也要凍住');
  assert.strictEqual(Object.isFrozen(s.doc.signal[1]), true, 'group 也要凍住');
  assert.strictEqual(Object.isFrozen(s.doc.signal[1][1]), true, 'group 裡的 lane 也要凍住');
  assert.throws(() => { s.doc.signal[0].name = 'HACKED'; }, TypeError,
    '寫進交出去的文件要當場丟，不是靜默蒸發');
  assert.strictEqual(s.doc.signal[0].name, 'a');
  assert.strictEqual(s.isDirty(), false);
  assert.strictEqual(s.toPatch().text, GSRC);

  // apply 之後那一份也一樣（含 data 陣列這種可變的葉子）
  s.apply('set-cell', (d) => C.setCell(d, 0, 1, 'x'));
  assert.strictEqual(Object.isFrozen(s.doc), true);
  assert.throws(() => { s.doc.signal[0].wave = 'zz'; }, TypeError);
  const t = S.createStore(SRC);
  assert.strictEqual(Object.isFrozen(t.doc.signal[1].data), true, 'data 陣列也要凍住');
  assert.throws(() => { t.doc.signal[1].data.push('d'); }, TypeError);
}

// ---------------------------------------------------------------------------
// T20：apply 收到的東西要像一份 WaveJSON 文件。`{}` 與 `[]` 不是 null、也不是
// 純量，舊版會收下、佔一格堆疊，然後 toPatch() 回一個 ok:true、把整個 block
// 清成 `{ }` 的 patch——對一個以「寧可拒絕也不重寫」為原則的層來說是最壞的形狀。
// ---------------------------------------------------------------------------
{
  for (const junk of [{}, [], { signal: 'nope' }, { signal: null }]) {
    const s = S.createStore(GSRC);
    assert.strictEqual(s.apply('junk', () => junk), false,
      '不像文件的東西不准進堆疊：' + JSON.stringify(junk));
    assert.strictEqual(s.canUndo(), false);
    assert.strictEqual(s.isDirty(), false);
    assert.strictEqual(s.toPatch().text, GSRC);
  }
  // 而原本就沒有 signal 的來源，照樣編輯得動（不是把「有 signal」當成硬性條件）
  const nosig = S.createStore('{ head: { text: "hi" } }');
  assert.strictEqual(nosig.ok, true);
  assert.strictEqual(nosig.apply('hand', (d) => {
    const next = clone(d);
    next.head.text = 'bye';
    return next;
  }), true);
  const p = nosig.toPatch();
  assert.strictEqual(p.ok, true, 'Got ' + JSON.stringify(p));
  assert.strictEqual(p.text, '{ head: { text: "bye" } }');
}

// ---------------------------------------------------------------------------
// T21：apply 的 callback 丟例外時，例外往上走（呼叫端自己的 bug 不該被吞掉），
// 而 store 自己一格都不動。Task 7 要知道這條合約，所以釘住它。
// ---------------------------------------------------------------------------
{
  const s = S.createStore(GSRC);
  s.apply('rename', (d) => C.renameLane(d, 0, 'A2'));
  const before = s.doc;
  assert.throws(() => {
    s.apply('boom', () => { throw new Error('boom'); });
  }, /boom/, '例外要往上傳，不是變成一個安靜的 false');
  assert.strictEqual(s.doc, before, '丟完之後文件必須是同一個物件');
  assert.strictEqual(s.canUndo(), true);
  assert.strictEqual(s.canRedo(), false, '丟掉的那一步不准佔一格');
  assert.strictEqual(s.undoName(), 'rename');
  assert.strictEqual(s.toPatch().ok, true);
}

// ---------------------------------------------------------------------------
// T22：store 自己的拒絕也要帶得出可以給使用者看的範圍，而 codec 的拒絕理由必須
// 逐字就是 codec 說的那一句（控制器的裁示是「原封不動」，不是「意思到了」）。
// ---------------------------------------------------------------------------
{
  const s = S.createStore(GSRC);
  s.apply('move-lane', (d) => C.moveLane(d, 0, 3));
  s.apply('move-lane', (d) => C.moveLane(d, 0, 3));
  const patch = s.toPatch();
  assert.strictEqual(patch.ok, false);
  assert.ok(patch.rewroteRange, '兩個 move 的拒絕要有範圍');
  const r = patch.rewroteRange;
  assert.ok(typeof r.start === 'number' && typeof r.end === 'number' && r.end > r.start);
  assert.ok(GSRC.slice(r.start, r.end).includes('lane a'),
    '範圍要真的框住被拖的那幾條 lane。Got ' + JSON.stringify(GSRC.slice(r.start, r.end)));
  assert.ok(patch.reason.includes('more than one lane'),
    '理由要說出是「不只一條 lane 要搬」，不是最後那道網的通用訊息。Got ' +
    JSON.stringify(patch.reason));
}
{
  const s = S.createStore(GSRC);
  s.apply('hand', (d) => {
    const next = clone(d);
    next.signal[0].loop = next.signal[0];
    return next;
  });
  const patch = s.toPatch();
  assert.strictEqual(patch.ok, false);
  // 逐字比對 codec 自己會說的那一句
  const r = C.parseSource(GSRC);
  const direct = C.patchSource(GSRC, r, [{
    op: 'insert', path: ['signal', 0, 'loop'], value: (function () {
      const o = { name: 'a' }; o.self = o; return o;
    }()),
  }]);
  assert.strictEqual(direct.ok, false);
  assert.strictEqual(patch.reason, direct.reason,
    'codec 的理由必須原封不動，不准換成自己的說法');
}

// ---------------------------------------------------------------------------
// T23：最後一道網 —— 計畫寫出來、讀回去，跟 doc 不一樣就拒絕。
// 手寫的 fn 可以做出結構性改動（這裡是把 group 拆掉、lane 留著），而計畫器只會
// 產生「刪 lane／一個 move／插 lane／存活 lane 的欄位 diff」，表達不出來。
// 舊版對這一種是 ok:true 而 group 原封不動留在檔案裡。
// ---------------------------------------------------------------------------
{
  const s = S.createStore(GSRC);
  s.apply('dissolve', (d) => {
    const next = clone(C.removeLane(d, 3));
    next.signal = [next.signal[0], next.signal[1][1], next.signal[1][2]];
    return next;
  });
  assert.deepStrictEqual(laneShape(s.doc), ['a', 'b', 'c'], '先確認 fixture：group 被拆掉了');
  const patch = s.toPatch();
  assert.strictEqual(patch.ok, false,
    'group 被手動拆掉時要拒絕，不是把 group 原封不動留在檔案裡。Got ' +
    JSON.stringify(patch));
  assert.strictEqual(patch.text, undefined);
  assert.ok(patch.rewroteRange && typeof patch.rewroteRange.start === 'number');
}

// ---------------------------------------------------------------------------
// T24：凍結只有在 strict mode 下才會丟。這個模組自己是 strict，但寫進 store.doc 的
// 那一行在**呼叫端**的檔案裡，所以有牙齒的是呼叫端的 'use strict'。今天帶著這個
// 模組進瀏覽器的是 client.js（第一行就是 prologue），而 server.js 是原樣內嵌它。
// 實測（本 session，non-strict 探針）：對凍住的文件寫五次，四次是**靜默**的，只有
// push 會丟——也就是說這個前提一旦破掉，F3 的症狀會原封不動回來，只是不再連 baseline
// 一起壞掉，所以更難發現。把前提釘住。
// ---------------------------------------------------------------------------
{
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', f), 'utf8');
  // prologue 的定義是「檔案的第一個 statement」，兩種引號都算數
  const prologue = (text) => /^(?:'use strict';|"use strict";)/.test(text);
  for (const f of ['client.js', 'wave-store.js', 'wave-codec.js']) {
    assert.strictEqual(prologue(read(f)), true,
      f + ' 的第一件事必須是 strict prologue（凍結的牙齒靠它）');
  }
  // server 把 client 原樣塞進 <script>，中間不准夾任何東西——夾了就不是 prologue 了
  assert.ok(read('server.js').includes('<script>${clientJs}</script>'),
    'client.js 必須原樣內嵌，prologue 才會留在最前面');

  // 守衛自己的牙齒：這幾種「看起來有 strict、其實不是 prologue」都必須被抓到
  for (const bite of ['/* md2doc */\n\'use strict\';\n',
    '(function () {\n\'use strict\';\n',
    '\n\'use strict\';',
    'const x = 1;\n\'use strict\';']) {
    assert.strictEqual(prologue(bite), false, '守衛必須抓到 ' + JSON.stringify(bite));
  }
  // 而兩種引號的真 prologue 都不准誤傷
  assert.strictEqual(prologue("'use strict';\nconst x = 1;"), true);
  assert.strictEqual(prologue('"use strict";\nconst x = 1;'), true);
}

// ---------------------------------------------------------------------------
// T25：凍結不准蔓延到呼叫端還握著的物件。手寫的 fn 可能把一個重複使用的 lane 範本
// 或剪貼簿的一列直接放進文件裡；如果那個物件被就地凍住，呼叫端下一次 push 會在離
// 現場很遠的地方丟。所以是 copy-on-accept：沒凍住的節點抄一份、凍我們自己的那份，
// 已經凍住的（＝上一版文件裡的）照原樣共用，結構共享與 lane 的物件識別都不受影響。
// ---------------------------------------------------------------------------
{
  const s = S.createStore(GSRC);
  const before = s.doc;
  const clipboard = ['A', 'B'];
  const template = { name: 'T', wave: '23', data: clipboard };
  assert.strictEqual(s.apply('hand', (d) => ({ signal: d.signal.concat([template]) })), true);

  assert.strictEqual(Object.isFrozen(template), false, '交進來的物件不准被凍住');
  assert.strictEqual(Object.isFrozen(clipboard), false, '連裡面的陣列也不准');
  clipboard.push('C');          // 不准丟
  template.name = 'T2';         // 不准丟
  assert.deepStrictEqual(clipboard, ['A', 'B', 'C']);

  const lane = s.doc.signal[s.doc.signal.length - 1];
  assert.notStrictEqual(lane, template, 'store 拿的是自己的副本');
  assert.strictEqual(lane.name, 'T', '呼叫端後來改自己的物件，改不到 store 裡');
  assert.deepStrictEqual(lane.data, ['A', 'B'], 'data 也是自己的副本');
  assert.strictEqual(Object.isFrozen(lane), true);
  assert.strictEqual(Object.isFrozen(lane.data), true);

  // 而沒被碰過的 lane 仍然是**同一個物件**——抄的是新的那些，不是整份文件
  assert.strictEqual(s.doc.signal[0], before.signal[0], '沒動到的 lane 必須原樣共用');
  assert.strictEqual(s.doc.signal[1], before.signal[1], 'group 也是');
  const patch = s.toPatch();
  assert.strictEqual(patch.ok, true, 'Got ' + JSON.stringify(patch));
  assert.ok(patch.text.includes('name: "T"'));

  // 抄的是**結構**不是樹：同一個節點被指到兩次，抄完還是同一個節點（含自己指到自己
  // 的那種——T9/T22 靠它，codec 才會說「這個值含著自己」而不是說「太深了」）
  const shared = ['S'];
  const two = S.createStore(GSRC);
  two.apply('hand', (d) => ({
    signal: d.signal.concat([{ name: 'P', wave: '3', data: shared },
      { name: 'Q', wave: '3', data: shared }]),
  }));
  const lanes = two.doc.signal;
  assert.strictEqual(lanes[lanes.length - 1].data, lanes[lanes.length - 2].data,
    '被指到兩次的節點，抄完還是同一個');
  assert.strictEqual(Object.isFrozen(shared), false, '而呼叫端那一份還是活的');
}

// ---------------------------------------------------------------------------
// T26：兩個候選都重現得出來時，它們必須是**同一份文字**——否則「取第一個」就變成
// 一個沒有人看得到的偏好（T17 比的是樹與註解有沒有活著，比不出註解落在哪一行）。
// 候選是用 codec 直接手搭的，所以 codec 哪天讓兩種寫法的註解落點不一樣，這裡會紅。
// ---------------------------------------------------------------------------
{
  const CSRC = [
    '{ signal: [',
    '  { name: "a", wave: "01" },   // lane a',
    '  { name: "b", wave: "01" },   // lane b',
    '  ["grp",',
    '    { name: "c", wave: "01" },   // lane c',
    '    { name: "d", wave: "01" },   // lane d',
    '    { name: "x", wave: "01" },   // lane x',
    '  ],',
    '  { name: "e", wave: "01" },   // lane e',
    ']}',
  ].join('\n');
  // 每一行上「名字 → 同一行的註解」的對應，用來檢查註解有沒有跟著它的 lane 走
  const notes = function (text) {
    const out = {};
    for (const line of text.split('\n')) {
      const m = /name:\s*"([^"]+)"/.exec(line);
      const c = /\/\/\s*(.+)$/.exec(line);
      if (m) out[m[1]] = c === null ? null : c[1].trim();
    }
    return out;
  };
  const want = notes(CSRC);
  const r0 = C.parseSource(CSRC);
  const n = C.lanePaths(r0.doc).length;
  let bothReproduced = 0;
  for (let f = 0; f + 1 < n; f++) {
    const s = S.createStore(CSRC);
    s.apply('mv', (d) => C.moveLane(d, f, f + 1));
    const patch = s.toPatch();
    assert.strictEqual(patch.ok, true, 'pair ' + f + ' Got ' + JSON.stringify(patch));
    assert.deepStrictEqual(notes(patch.text), want,
      'pair ' + f + '：每一條註解都要留在它自己那條 lane 的那一行');

    // 手搭兩個候選：「上面那條被拖下來」與「下面那條被拖上去」
    const r = C.parseSource(CSRC);
    const shape = (t) => JSON.stringify(C.parseSource(t).doc);
    const built = [
      C.patchSource(CSRC, r, [{ op: 'move', path: C.lanePath(r.doc, f),
        to: C.laneInsertPath(r.doc, f + 2) }]),
      C.patchSource(CSRC, r, [{ op: 'move', path: C.lanePath(r.doc, f + 1),
        to: C.laneInsertPath(r.doc, f) }]),
    ];
    const good = built.filter(function (b) {
      return b.ok === true && shape(b.text) === JSON.stringify(s.doc);
    });
    assert.ok(good.length >= 1, 'pair ' + f + '：至少要有一個候選重現得出 doc');
    assert.strictEqual(patch.text, good[0].text,
      'pair ' + f + '：store 交出來的必須就是重現得出 doc 的那個候選');
    if (good.length === 2) {
      bothReproduced++;
      assert.strictEqual(good[0].text, good[1].text,
        'pair ' + f + '：兩個候選都重現得出來時，它們必須逐字相同——不然「取第一個」' +
        '就是一個沒人看得到的偏好');
    }
  }
  assert.ok(bothReproduced >= 1,
    '這個 fixture 必須真的含有「兩個候選都成立」的那一格，否則上面那條斷言是空的。' +
    'Got ' + bothReproduced);
}

// ---------------------------------------------------------------------------
// T27：拒絕的話要對得起使用者做過的事。相鄰對調有兩個讀法，兩個都寫不出來的時候，
// 贏的那個拒絕**可能**在描述使用者沒做過的那個拖曳——所以訊息要先說「這個重排有
// 不只一個讀法」，再說被拒絕的那個讀法為什麼不行。只有一個讀法時不准加這句。
// ---------------------------------------------------------------------------
{
  // 兩個候選：刪掉 c、把 b 拖到最後（「d 被拖到中間」同樣解釋得了這個順序）
  const ESRC = [
    '{ signal: [',
    '  { name: "a", wave: "01" },   // lane a',
    '  ["g1",',
    '    { name: "b", wave: "01" },   // lane b',
    '    { name: "c", wave: "01" },   // lane c',
    '  ],',
    '  { name: "d", wave: "01" },   // lane d',
    ']}',
  ].join('\n');
  const s = S.createStore(ESRC);
  s.apply('remove-lane', (d) => C.removeLane(d, 2));
  s.apply('move-lane', (d) => C.moveLane(d, 1, 2));
  const patch = s.toPatch();
  assert.strictEqual(patch.ok, false);
  assert.ok(patch.reason.includes('more than one reading'),
    '有兩個讀法時要先說出來。Got ' + JSON.stringify(patch.reason));
  assert.ok(patch.reason.includes('deletion and a drag'),
    '而且還是要說出被拒絕的那個讀法為什麼不行');

  // 只有一個讀法的同一種衝突：訊息不准假裝有歧義
  const LSRC = [
    '{ signal: [',
    '  { name: "a", wave: "01" },   // lane a',
    '  ["g1",',
    '    { name: "b", wave: "01" },   // lane b',
    '    { name: "c", wave: "01" },   // lane c',
    '  ],',
    '  { name: "d", wave: "01" },   // lane d',
    '  { name: "e", wave: "01" },   // lane e',
    ']}',
  ].join('\n');
  const one = S.createStore(LSRC);
  one.apply('remove-lane', (d) => C.removeLane(d, 2));
  one.apply('move-lane', (d) => C.moveLane(d, 1, 3));
  assert.deepStrictEqual(laneShape(one.doc), ['a', 'd', 'e', 'b'],
    '先確認 fixture：只有「b 被拖到最後」解釋得了這個順序');
  const p2 = one.toPatch();
  assert.strictEqual(p2.ok, false);
  assert.ok(p2.reason.includes('deletion and a drag'));
  assert.ok(!p2.reason.includes('more than one reading'),
    '只有一個讀法時不准說有歧義。Got ' + JSON.stringify(p2.reason));
}

// ---------------------------------------------------------------------------
// T28：巢狀有多深才會撞到天花板——量出來釘住。61 層還存得起來，62 層在 parseSource
// 就被擋下，所以 store 自己那條「太深」的拒絕從任何**讀得回來的**來源都到不了；
// fix2 把那條死碼刪掉，這一格是它的依據，將來 codec 的天花板動了這裡會紅。
// ---------------------------------------------------------------------------
{
  const deep = (n) => '{ signal: [\n  { name: "a", wave: "01", deep: ' +
    '['.repeat(n) + '1' + ']'.repeat(n) + ' },\n]}';
  const s = S.createStore(deep(61));
  assert.strictEqual(s.ok, true, '61 層必須讀得回來');
  s.apply('set-cell', (d) => C.setCell(d, 0, 1, 'x'));
  const patch = s.toPatch();
  assert.strictEqual(patch.ok, true, '61 層必須存得起來。Got ' + JSON.stringify(patch));
  assert.ok(patch.text.includes('wave: "0x"'));
  const tooDeep = S.createStore(deep(62));
  assert.strictEqual(tooDeep.ok, false, '62 層在 parseSource 就被擋下');
  assert.strictEqual(tooDeep.toPatch().ok, false);
}

// ---------------------------------------------------------------------------
// T15：守衛要有牙齒 —— 不碰 DOM、不執行字串。
// 清單跟 wave-codec.test.js 同一份，只少掉 `require(`（本檔正當地 require codec）。
// 樣式與咬痕 copy 自 test/wave-geometry.test.js：散文讓路給守衛，不是反過來。
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'wave-store.js'),
    'utf8');

  const HOSTS = 'document|window|navigator|globalThis|screen|location|self';
  const DOM = new RegExp(
    '\\b(?:' + HOSTS + ')\\s*\\??\\s*(?:\\.\\s*[A-Za-z_$]|\\[)' +
    '|\\btypeof\\s+(?:' + HOSTS + ')\\b' +
    '|[=(,]\\s*(?:' + HOSTS + ')\\s*[;,)]');
  assert.strictEqual(DOM.test(src), false,
    'wave-store.js 不得碰 DOM。Got ' + JSON.stringify((DOM.exec(src) || [])[0]));
  for (const bite of [
    'if (at === 0) { return document.body.clientWidth; }',
    "const SCALE = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;",
    'const w = window["innerWidth"];',
    'const w = window?.innerWidth;',
    'const { devicePixelRatio } = window;',
    'const x = window\n  .innerWidth;',
  ]) {
    assert.strictEqual(DOM.test(bite), true, '守衛必須抓到 ' + JSON.stringify(bite));
  }
  for (const prose of [
    ' * the document the GUI is editing, not strict JSON.',
    ' * a broken document comes back as a store that refuses.',
  ]) {
    assert.strictEqual(DOM.test(prose), false, '散文不得誤傷：' + JSON.stringify(prose));
  }

  const BANNED = ['eval', 'Function', 'constructor', 'runInNewContext',
    'setTimeout', 'setInterval', 'import('];
  for (const bad of BANNED) {
    assert.strictEqual(src.indexOf(bad), -1,
      'wave-store.js 不得出現 ' + JSON.stringify(bad) + '（會執行程式碼的拼法一律擋）');
  }
  for (const bite of ["const SNEAK = Function('return 40')();",
    "({}).constructor.constructor('return 30')()",
    "setTimeout('save()', 0)"]) {
    assert.ok(BANNED.some(function (bad) { return bite.indexOf(bad) !== -1; }),
      'BANNED 必須抓到 ' + JSON.stringify(bite));
  }

  // require 只准有一個，而且只准是 codec：lane 的順序只能有一份
  const requires = src.match(/require\(([^)]*)\)/g) || [];
  assert.deepStrictEqual(requires, ["require('./wave-codec.js')"],
    'wave-store.js 只准 require codec 一個。Got ' + JSON.stringify(requires));
}

console.log('wave-store.test.js OK');
