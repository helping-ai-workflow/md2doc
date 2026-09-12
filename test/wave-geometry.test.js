'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/editor/wave-geometry.js');
const C = require('../lib/editor/wave-codec.js');

// ---------------------------------------------------------------------------
// Task 4 brief 的骨架：值逐字照抄，它們就是驗收條件
// ---------------------------------------------------------------------------
{
  const doc = { signal: [{ name: 'clk', wave: '0101' }, { name: 'd', wave: 'xx01' }] };
  const L = G.layoutOf(doc, { laneHeight: 40, cycleWidth: 20, nameColWidth: 60 });

  assert.strictEqual(L.lanes.length, 2);
  assert.strictEqual(L.width, 60 + 4 * 20, '寬 = 名稱欄 + cycle 數 × cycle 寬');
  assert.strictEqual(L.height, 2 * 40);

  // 往返：每一格的中心點必須 hit 回同一格
  for (let lane = 0; lane < 2; lane++) {
    for (let cyc = 0; cyc < 4; cyc++) {
      const r = G.cellRect(L, lane, cyc);
      const hit = G.cellAt(L, r.x + r.width / 2, r.y + r.height / 2);
      assert.deepStrictEqual(hit, { laneIndex: lane, cycle: cyc },
        '中心點必須 hit 回同一格：lane=' + lane + ' cycle=' + cyc);
    }
  }

  // 名稱欄不是格子
  assert.strictEqual(G.cellAt(L, 10, 20), null, '名稱欄不得回傳格子');
  // 超出範圍
  assert.strictEqual(G.cellAt(L, L.width + 5, 20), null);
  assert.strictEqual(G.cellAt(L, 70, L.height + 5), null);

  // 邊界：格子的左緣屬於自己，右緣屬於下一格
  {
    const r = G.cellRect(L, 0, 1);
    assert.deepStrictEqual(G.cellAt(L, r.x, r.y + 1), { laneIndex: 0, cycle: 1 },
      '左緣屬於自己');
    assert.deepStrictEqual(G.cellAt(L, r.x + r.width, r.y + 1),
      { laneIndex: 0, cycle: 2 }, '右緣屬於下一格');
  }
}

// ---------------------------------------------------------------------------
// group：lane index 是「攤平後的顯示順序」，group 標題不佔一列
//
// 量到的（node_modules/wavedrom@3.5.0，renderAny + waveSkin，本 session 跑的）：
//   {signal:[{a},{b},{c},{d}]}              svg height=120，wavelane y = 5/35/65/95
//   {signal:[{a},['grp',{b},{c}],{d}]}      svg height=120，wavelane y = 5/35/65/95
// 兩者逐格相同 —— group 標題吃的是**橫向**的名稱欄（lanes_0 的 translate 從 40.5
// 變成 60.5，巢狀再變 80.5），不是一列高度。所以 lane 的 y 只跟攤平序號有關。
// ---------------------------------------------------------------------------
const GROUPED = {
  signal: [
    { name: 'a', wave: '0101' },
    ['grp', { name: 'b', wave: '0101' }, { name: 'c', wave: '0101' }],
    { name: 'd', wave: '0101' },
  ],
};
const FLAT = {
  signal: [
    { name: 'a', wave: '0101' },
    { name: 'b', wave: '0101' },
    { name: 'c', wave: '0101' },
    { name: 'd', wave: '0101' },
  ],
};

{
  const opts = { laneHeight: 40, cycleWidth: 20, nameColWidth: 60 };
  const Lg = G.layoutOf(GROUPED, opts);
  const Lf = G.layoutOf(FLAT, opts);

  assert.strictEqual(Lg.lanes.length, 4, 'group 內的 lane 也要各算一條');
  assert.strictEqual(Lg.height, Lf.height,
    'group 標題不佔一列：同樣四條 lane 的高度必須跟沒有 group 的一樣。Got ' +
    Lg.height + ' vs ' + Lf.height);
  assert.deepStrictEqual(Lg.lanes.map(function (l) { return l.y; }),
    Lf.lanes.map(function (l) { return l.y; }),
    'group 標題不佔一列：每一條 lane 的 y 必須跟沒有 group 的逐格相同');

  // index space 必須跟 codec 是同一個 —— 不是「今天剛好一樣」而是逐條比對
  for (let i = 0; i < Lg.lanes.length; i++) {
    assert.deepStrictEqual(Lg.lanes[i].path, C.lanePath(GROUPED, i),
      'lane ' + i + ' 的 path 必須等於 codec 的 lanePath');
  }
  assert.strictEqual(C.lanePath(GROUPED, Lg.lanes.length), null,
    '攤平後剛好四條，第五條在 codec 眼裡不存在');
  assert.deepStrictEqual(Lg.lanes.map(function (l) { return l.lane.name; }),
    ['a', 'b', 'c', 'd'], '攤平順序：深度優先，跳過 group 標題字串');

  // 有牙齒的地方：把 group 標題算成一列的話，這一格會落在 'c' 上
  {
    const r = G.cellRect(Lg, 3, 0);
    const hit = G.cellAt(Lg, r.x + r.width / 2, r.y + r.height / 2);
    assert.deepStrictEqual(hit, { laneIndex: 3, cycle: 0 });
    assert.strictEqual(Lg.lanes[hit.laneIndex].lane.name, 'd',
      '最後一列是 d；若 group 標題佔了一列，這裡會變成 c');
    assert.deepStrictEqual(C.lanePath(GROUPED, hit.laneIndex), ['signal', 2],
      'hit 回來的序號餵給 codec 必須指到 d 自己的 path');
  }

  // group 裡面那兩條同樣要能往返
  for (let lane = 0; lane < 4; lane++) {
    for (let cyc = 0; cyc < 4; cyc++) {
      const r = G.cellRect(Lg, lane, cyc);
      const hit = G.cellAt(Lg, r.x + r.width / 2, r.y + r.height / 2);
      assert.deepStrictEqual(hit, { laneIndex: lane, cycle: cyc },
        'group 文件的中心點往返：lane=' + lane + ' cycle=' + cyc);
    }
  }

  // 巢狀 group 也是同一個 index space，depth 從 path 推出來（不是第二次走訪）
  {
    const nested = {
      signal: [
        { name: 'a', wave: '01' },
        ['g1', { name: 'b', wave: '01' }, ['g2', { name: 'c', wave: '01' }]],
        { name: 'd', wave: '01' },
      ],
    };
    const Ln = G.layoutOf(nested, opts);
    assert.deepStrictEqual(Ln.lanes.map(function (l) { return l.lane.name; }),
      ['a', 'b', 'c', 'd']);
    assert.deepStrictEqual(Ln.lanes.map(function (l) { return l.depth; }), [0, 1, 2, 0]);
    assert.strictEqual(Ln.height, 4 * opts.laneHeight, '巢狀 group 一樣不佔列');
    for (let i = 0; i < Ln.lanes.length; i++) {
      assert.deepStrictEqual(Ln.lanes[i].path, C.lanePath(nested, i),
        '巢狀：lane ' + i + ' 的 path 必須等於 codec 的 lanePath');
    }
  }
}

// ---------------------------------------------------------------------------
// 邊界規則，用「差一格就會換答案」的座標釘
// ---------------------------------------------------------------------------
{
  const L = G.layoutOf(FLAT, { laneHeight: 40, cycleWidth: 20, nameColWidth: 60 });

  // 名稱欄那一刀：59.999 還在名稱欄，60 已經是第 0 格
  assert.strictEqual(G.cellAt(L, 59.999, 20), null, '名稱欄的最後一畫素不是格子');
  assert.deepStrictEqual(G.cellAt(L, 60, 20), { laneIndex: 0, cycle: 0 },
    '名稱欄右緣屬於第 0 格');

  // 每一條格線：左邊屬於前一格，格線本身屬於後一格
  for (let cyc = 1; cyc < 4; cyc++) {
    const edge = 60 + cyc * 20;
    assert.deepStrictEqual(G.cellAt(L, edge - 0.001, 20), { laneIndex: 0, cycle: cyc - 1 },
      '格線左邊一點點屬於 cycle ' + (cyc - 1));
    assert.deepStrictEqual(G.cellAt(L, edge, 20), { laneIndex: 0, cycle: cyc },
      '格線本身屬於 cycle ' + cyc);
  }

  // 最後一格的右緣沒有下一格可以給，就是外面
  assert.deepStrictEqual(G.cellAt(L, L.width - 0.001, 20), { laneIndex: 0, cycle: 3 });
  assert.strictEqual(G.cellAt(L, L.width, 20), null, '最右緣已經在圖外');

  // 同一條規則套在列上：上緣屬於自己，下緣屬於下一列
  for (let lane = 1; lane < 4; lane++) {
    const edge = lane * 40;
    assert.deepStrictEqual(G.cellAt(L, 70, edge - 0.001), { laneIndex: lane - 1, cycle: 0 },
      '列線上面一點點屬於 lane ' + (lane - 1));
    assert.deepStrictEqual(G.cellAt(L, 70, edge), { laneIndex: lane, cycle: 0 },
      '列線本身屬於 lane ' + lane);
  }
  assert.strictEqual(G.cellAt(L, 70, L.height), null, '最下緣已經在圖外');
  assert.strictEqual(G.cellAt(L, 70, -0.001), null, '負的 y 不是格子');
  assert.strictEqual(G.cellAt(L, -1, 20), null, '負的 x 不是格子');
}

// ---------------------------------------------------------------------------
// cycle 數要跟引擎一致：`.` 與 `|` 各算一拍，而且問的是 codec 不是字串長度
//
// 量到的（同一份 wavedrom）：單條 lane 的 svg 寬度
//   "0"=100  "00"=140  "000"=180  "0000"=220  "0..."=220  "0.0."=220
//   "0|0"=180  "0||0"=220  "01|."=220  ""=100        → 一拍 40px，repeater 照算
// ---------------------------------------------------------------------------
{
  const doc = {
    signal: [
      { name: 'wide', wave: '0...' },   // 四拍，全是 repeater
      { name: 'gap', wave: '01|.' },    // 四拍，含 `|`
      { name: 'short', wave: '01' },    // 兩拍
      { name: 'none' },                 // 沒有 wave：零拍，但佔一列
    ],
  };
  const L = G.layoutOf(doc, { laneHeight: 10, cycleWidth: 8, nameColWidth: 30 });

  assert.deepStrictEqual(L.lanes.map(function (l) { return l.cycles; }), [4, 4, 2, 0],
    '每條 lane 的拍數要跟 levelsOf 一致（跳過 repeater 的天真算法會給 1/2/2/0）');
  assert.strictEqual(L.cycles, 4, '整張圖的拍數 = 最長的那條');
  assert.strictEqual(L.width, 30 + 4 * 8);
  assert.strictEqual(L.height, 4 * 10, '沒有 wave 的 lane 一樣佔一列');

  for (let i = 0; i < L.lanes.length; i++) {
    assert.strictEqual(L.lanes[i].cycles,
      C.levelsOf(doc.signal[i].wave).length,
      'lane ' + i + ' 的拍數必須就是 codec 的 levelsOf 長度');
  }

  // 短 lane 的尾巴後面仍然是格子（往那裡畫 = 把 wave 拉長），呼叫端靠 lanes[i].cycles
  // 判斷有沒有超過；這裡不回 null，否則 Task 6 沒辦法往後畫。
  assert.deepStrictEqual(G.cellAt(L, 30 + 3 * 8 + 4, 2 * 10 + 5),
    { laneIndex: 2, cycle: 3 }, '短 lane 的尾巴後面仍然回得出格子');
  assert.ok(L.lanes[2].cycles <= 3, '而且呼叫端看得出那一拍超過了這條 lane 的長度');
}

// ---------------------------------------------------------------------------
// spacer lane（`{}`）佔一列 —— 量到的：{a},{},{b} 的 svg height=90、y=5/35/65
// ---------------------------------------------------------------------------
{
  const doc = { signal: [{ name: 'a', wave: '01' }, {}, { name: 'b', wave: '01' }] };
  const L = G.layoutOf(doc, { laneHeight: 30, cycleWidth: 40, nameColWidth: 40 });
  assert.strictEqual(L.lanes.length, 3, 'spacer 也是一條 lane');
  assert.strictEqual(L.height, 90);
  assert.deepStrictEqual(L.lanes.map(function (l) { return l.y; }), [0, 30, 60]);
  assert.deepStrictEqual(G.cellAt(L, 50, 65), { laneIndex: 2, cycle: 0 },
    'spacer 下面那條是 b，序號 2');
  assert.strictEqual(L.lanes[2].lane.name, 'b');
}

// ---------------------------------------------------------------------------
// 預設尺寸抄自引擎量到的數字：列距 30、一拍 40、名稱欄 40
// ---------------------------------------------------------------------------
{
  const L = G.layoutOf(FLAT);
  assert.strictEqual(L.laneHeight, 30);
  assert.strictEqual(L.cycleWidth, 40);
  assert.strictEqual(L.nameColWidth, 40);
  assert.strictEqual(L.height, 4 * 30, '四條 lane 的高度 = 引擎量到的 120');
  assert.strictEqual(L.width, 40 + 4 * 40);
}

// ---------------------------------------------------------------------------
// 壞掉的輸入：回 null 而不是丟，尺寸壞掉才丟
// ---------------------------------------------------------------------------
{
  const L = G.layoutOf(FLAT, { laneHeight: 40, cycleWidth: 20, nameColWidth: 60 });

  assert.strictEqual(G.cellAt(L, NaN, 20), null);
  assert.strictEqual(G.cellAt(L, 70, NaN), null);
  assert.strictEqual(G.cellAt(L, Infinity, 20), null);
  assert.strictEqual(G.cellAt(L, '70', 20), null, '字串座標不算數字');
  assert.strictEqual(G.cellAt(null, 70, 20), null);

  assert.strictEqual(G.cellRect(L, 4, 0), null, '沒有第五條 lane');
  assert.strictEqual(G.cellRect(L, -1, 0), null);
  assert.strictEqual(G.cellRect(L, 0, 4), null, '沒有第五拍');
  assert.strictEqual(G.cellRect(L, 0.5, 0), null, '序號必須是整數');
  assert.strictEqual(G.cellRect(L, 0, 1.5), null);
  assert.strictEqual(G.cellRect(null, 0, 0), null);

  // 空文件：沒有 lane 就沒有格子
  const E = G.layoutOf({ signal: [] }, { laneHeight: 40, cycleWidth: 20, nameColWidth: 60 });
  assert.deepStrictEqual(E.lanes, []);
  assert.strictEqual(E.height, 0);
  assert.strictEqual(E.width, 60, '沒有 lane 就只剩名稱欄');
  assert.strictEqual(G.cellAt(E, 70, 0), null);
  assert.strictEqual(G.cellRect(E, 0, 0), null);

  // 不是文件的東西：空版面，不丟
  assert.deepStrictEqual(G.layoutOf(null).lanes, []);
  assert.deepStrictEqual(G.layoutOf({}).lanes, []);
  assert.deepStrictEqual(G.layoutOf({ signal: 'nope' }).lanes, []);

  // 尺寸是呼叫端的程式錯誤：這裡默默套預設值會畫錯格子，所以要吵
  assert.throws(function () { G.layoutOf(FLAT, { laneHeight: 0 }); }, TypeError);
  assert.throws(function () { G.layoutOf(FLAT, { cycleWidth: -1 }); }, TypeError);
  assert.throws(function () { G.layoutOf(FLAT, { nameColWidth: NaN }); }, TypeError);
  assert.throws(function () { G.layoutOf(FLAT, { cycleWidth: '20' }); }, TypeError);
  // 名稱欄可以是 0（沒有名稱欄的畫法），其它兩個不行
  assert.strictEqual(G.layoutOf(FLAT, { nameColWidth: 0 }).nameColWidth, 0);
}

// ---------------------------------------------------------------------------
// 純函式：不改輸入、同樣的輸入給同樣的輸出
// ---------------------------------------------------------------------------
{
  const doc = JSON.parse(JSON.stringify(GROUPED));
  const before = JSON.stringify(doc);
  const opts = { laneHeight: 40, cycleWidth: 20, nameColWidth: 60 };
  const optsBefore = JSON.stringify(opts);
  const a = G.layoutOf(doc, opts);
  G.cellAt(a, 70, 20);
  G.cellRect(a, 1, 1);
  assert.strictEqual(JSON.stringify(doc), before, 'layoutOf 不得改到文件');
  assert.strictEqual(JSON.stringify(opts), optsBefore, 'layoutOf 不得改到 opts');
  const b = G.layoutOf(doc, opts);
  assert.deepStrictEqual(b, a, '同樣的輸入必須給同樣的版面');
  // lane 物件是共用的，不是複製的 —— 呼叫端拿 hit 的結果回去餵 codec 才對得上
  assert.strictEqual(a.lanes[1].lane, doc.signal[1][1]);
}

// ---------------------------------------------------------------------------
// 不執行字串；只 require codec 一個
//
// 「不碰 DOM」這半刻意不用字串 grep：那個 repo 早就被「散文提到某個退休名字就
// 整套變紅」燙過一次，而 `document` 這個字在講 WaveJSON 文件的註解裡本來就會出現。
// 真的碰了 DOM 的話，node 底下第一次呼叫就是 ReferenceError —— 上面每一個測試
// 都在替這件事作證，比 grep 可靠。
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'wave-geometry.js'),
    'utf8');
  for (const bad of ['ev' + 'al(', 'new Function', 'setTimeout(', 'setInterval(']) {
    assert.strictEqual(src.includes(bad), false,
      'wave-geometry.js 不得出現 ' + JSON.stringify(bad));
  }
  const requires = src.match(/require\(([^)]*)\)/g) || [];
  assert.deepStrictEqual(requires, ["require('./wave-codec.js')"],
    '只准 require codec 一個：lane 的順序只能有一份');
}

console.log('wave-geometry.test.js OK');
