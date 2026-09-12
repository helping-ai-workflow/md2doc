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
  for (const pair of [[3, 1], [0, 3], [3, 0]]) {
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
