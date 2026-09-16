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
  // v3.6.0 Task 6 re-pin: 舊值 80（2*40，無尺規帶）→ 新值 102
  // （L.originY(22) + 2*40）— 尺規帶把 lane 0 往下推，高度多出 originY。
  assert.strictEqual(L.height, L.originY + 2 * 40);

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
    // v3.6.0 Task 6 re-pin: 舊值 160（4*40）→ 新值 182（Ln.originY(22) + 4*40）
    assert.strictEqual(Ln.height, Ln.originY + 4 * opts.laneHeight, '巢狀 group 一樣不佔列');
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
  // v3.6.0 Task 6 re-pin: 整個區塊的 y 都要加上 L.originY（22，無 head）——
  // lane 0 的列不再從 y=0 開始，凡是「落在 lane 0 列中」的 y 一律改成
  // `L.originY + <舊值>`；凡是「列與列之間的分界」（`lane * 40`）一律改成
  // `L.originY + lane * 40`。x 軸（名稱欄／格線）完全不受影響。
  const y0 = L.originY + 20;   // lane 0 列中央（舊值 20）

  // 名稱欄那一刀：59.999 還在名稱欄，60 已經是第 0 格
  assert.strictEqual(G.cellAt(L, 59.999, y0), null, '名稱欄的最後一畫素不是格子');
  assert.deepStrictEqual(G.cellAt(L, 60, y0), { laneIndex: 0, cycle: 0 },
    '名稱欄右緣屬於第 0 格');

  // 每一條格線：左邊屬於前一格，格線本身屬於後一格
  for (let cyc = 1; cyc < 4; cyc++) {
    const edge = 60 + cyc * 20;
    assert.deepStrictEqual(G.cellAt(L, edge - 0.001, y0), { laneIndex: 0, cycle: cyc - 1 },
      '格線左邊一點點屬於 cycle ' + (cyc - 1));
    assert.deepStrictEqual(G.cellAt(L, edge, y0), { laneIndex: 0, cycle: cyc },
      '格線本身屬於 cycle ' + cyc);
  }

  // 最後一格的右緣沒有下一格可以給，就是外面
  assert.deepStrictEqual(G.cellAt(L, L.width - 0.001, y0), { laneIndex: 0, cycle: 3 });
  assert.strictEqual(G.cellAt(L, L.width, y0), null, '最右緣已經在圖外');

  // 同一條規則套在列上：上緣屬於自己，下緣屬於下一列
  for (let lane = 1; lane < 4; lane++) {
    const edge = L.originY + lane * 40;
    assert.deepStrictEqual(G.cellAt(L, 70, edge - 0.001), { laneIndex: lane - 1, cycle: 0 },
      '列線上面一點點屬於 lane ' + (lane - 1));
    assert.deepStrictEqual(G.cellAt(L, 70, edge), { laneIndex: lane, cycle: 0 },
      '列線本身屬於 lane ' + lane);
  }
  assert.strictEqual(G.cellAt(L, 70, L.height), null, '最下緣已經在圖外');
  assert.strictEqual(G.cellAt(L, 70, -0.001), null, '負的 y 不是格子');
  assert.strictEqual(G.cellAt(L, -1, y0), null, '負的 x 不是格子');
  // 尺規帶本身：originY 之前的 y 不是格子（v3.6.0 Task 6 新增）
  assert.strictEqual(G.cellAt(L, 70, L.originY - 0.001), null, '尺規帶的最後一畫素仍不是格子');
  assert.deepStrictEqual(G.cellAt(L, 70, L.originY), { laneIndex: 0, cycle: 0 },
    'originY 本身屬於 lane 0');
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
  // v3.6.0 Task 6 re-pin: 舊值 40（4*10）→ 新值 62（L.originY(22) + 4*10）
  assert.strictEqual(L.height, L.originY + 4 * 10, '沒有 wave 的 lane 一樣佔一列');

  for (let i = 0; i < L.lanes.length; i++) {
    assert.strictEqual(L.lanes[i].cycles,
      C.levelsOf(doc.signal[i].wave).length,
      'lane ' + i + ' 的拍數必須就是 codec 的 levelsOf 長度');
  }

  // 短 lane 的尾巴後面仍然是格子（往那裡畫 = 把 wave 拉長），呼叫端靠 lanes[i].cycles
  // 判斷有沒有超過；這裡不回 null，否則 Task 6 沒辦法往後畫。
  // v3.6.0 Task 6 re-pin: y 舊值 2*10+5=25 → 新值 L.originY + 2*10+5（lane 2 的列
  // 因為尺規帶往下推了 L.originY）。
  assert.deepStrictEqual(G.cellAt(L, 30 + 3 * 8 + 4, L.originY + 2 * 10 + 5),
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
  // v3.6.0 Task 6 re-pin: 舊值 90 → 新值 112（L.originY(22) + 90）
  assert.strictEqual(L.height, L.originY + 90);
  // v3.6.0 Task 6 re-pin: 舊值 [0,30,60] → 新值各加 L.originY
  assert.deepStrictEqual(L.lanes.map(function (l) { return l.y; }),
    [L.originY, L.originY + 30, L.originY + 60]);
  // v3.6.0 Task 6 re-pin: y 舊值 65 → 新值 L.originY + 65
  assert.deepStrictEqual(G.cellAt(L, 50, L.originY + 65), { laneIndex: 2, cycle: 0 },
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
  // v3.6.0 Task 6 re-pin: 引擎量到的 120（4*30）是「沒有尺規帶」的舊世界；
  // 這個畫布多了 L.originY(22) 的尺規帶，新值 142。
  assert.strictEqual(L.height, L.originY + 4 * 30,
    '四條 lane 的高度 = 引擎量到的 120 + 尺規帶 originY');
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
  // v3.6.0 Task 6 re-pin: 舊值 0 → 新值 22（尺規帶不論有沒有 lane 都保留）
  assert.strictEqual(E.height, 22, '沒有 lane 仍保留尺規帶的高度');
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
// F2：守衛要有牙齒 —— 不碰 DOM、不執行字串
//
// repo 的判例（`test/editor-client.test.js` 那段「不要為了散文去放寬守衛」）是：
// 散文讓路給守衛，不是反過來。所以這條樣式往寬的方向站：屬性存取可以夾空白、可以
// 換行、可以是 optional chaining，`typeof` 偵測、`window["x"]` 下標、以及
// `const { devicePixelRatio } = window;` 這種「把全域物件當值傳出去」的寫法都抓。
// 上一輪為了自己散文裡的 `document` 把它收窄，re-review 量過：收窄換來的誤傷是 0
// （這個檔案沒有任何一行以 `document.` 結尾），代價卻是換行與 optional chaining
// 兩種寫法逃掉。**如果將來它誤傷了散文，去改散文，不要改這條樣式。**
// 守衛自己的牙齒也在下面釘住，不然它壞了沒人知道。
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'wave-geometry.js'),
    'utf8');

  const HOSTS = 'document|window|navigator|globalThis|screen|location|self';
  const DOM = new RegExp(
    '\\b(?:' + HOSTS + ')\\s*\\??\\s*(?:\\.\\s*[A-Za-z_$]|\\[)' +   // 屬性存取（可夾空白／換行／?.）
    '|\\btypeof\\s+(?:' + HOSTS + ')\\b' +                          // 特性偵測
    '|[=(,]\\s*(?:' + HOSTS + ')\\s*[;,)]');                        // 當成值傳出去／解構來源
  assert.strictEqual(DOM.test(src), false,
    'wave-geometry.js 不得碰 DOM。Got ' + JSON.stringify((DOM.exec(src) || [])[0]));

  // 守衛的牙齒：review 那三個插入，逐一必須被抓到
  const BITES = [
    'if (depth > MAX_DEPTH) { return document.body.clientWidth; }',
    "const SCALE = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;",
    'const w = window["innerWidth"];',
    'navigator.userAgent',
    // re-review 量到會從舊樣式底下溜過去的四種：
    'const w = window?.innerWidth;',
    'const { devicePixelRatio } = window;',
    'const x = window\n  .innerWidth;',
    'const dpr = self.devicePixelRatio;',
    'if (typeof self !== "undefined") {}',
  ];
  for (const bite of BITES) {
    assert.strictEqual(DOM.test(bite), true, '守衛必須抓到 ' + JSON.stringify(bite));
  }
  // 而散文抓不到 —— 這是放寬守衛的那個藉口，現在它不成立了
  for (const prose of [
    ' * WaveJSON document, not strict JSON.',
    ' * a broken document comes back as an empty layout.',
    ' * Every size arrives as a parameter. The document is user data.',
  ]) {
    assert.strictEqual(DOM.test(prose), false, '散文不得誤傷：' + JSON.stringify(prose));
  }

  // 會執行字串的拼法：跟 wave-codec.test.js 的 BANNED 同一份，只少掉 `require(`
  const BANNED = ['eval', 'Function', 'constructor', 'runInNewContext',
    'setTimeout', 'setInterval', 'import('];
  for (const bad of BANNED) {
    assert.strictEqual(src.indexOf(bad), -1,
      'wave-geometry.js 不得出現 ' + JSON.stringify(bad));
  }
  // 這份清單也要有牙齒：review 的第三個插入必須被它抓到
  for (const bite of ["const SNEAK = Function('return 40')();",
    "({}).constructor.constructor('return 30')()"]) {
    assert.ok(BANNED.some(function (bad) { return bite.indexOf(bad) !== -1; }),
      'BANNED 必須抓到 ' + JSON.stringify(bite));
  }

  // `require(` 只准有一個，而且只准是 codec：lane 的順序只能有一份
  const requires = src.match(/require\(([^)]*)\)/g) || [];
  assert.deepStrictEqual(requires, ["require('./wave-codec.js')"],
    '只准 require codec 一個：lane 的順序只能有一份');
}

// ---------------------------------------------------------------------------
// F1：邊界規則在**小數**尺寸底下也必須精確
//
// `cellRect` 算的是 `nameColWidth + cycle*cycleWidth`，`cellAt` 用
// `floor((x - nameColWidth)/cycleWidth)` 反推。減法與除法各自會捨入，兩邊捨到
// 不同的地方，格子自己的左緣就會掉進左邊那一格。整數尺寸看不到這件事（乘加與
// 除法都是精確的），所以上一輪 40/20/60、30/40/40、10/8/30 三組整數 fixture
// 結構上就表達不出這個缺陷 —— 這裡改用小數。
//
// Task 6 的尺寸是從渲染結果量的，`getBoundingClientRect()` 在瀏覽器縮放下回的
// 就是小數 CSS px，所以這不是刻意construct 出來的輸入。
// ---------------------------------------------------------------------------
{
  // review 點名的那一組：cellRect(L,0,1).x === 49.199999999999996
  const L = G.layoutOf(FLAT, { laneHeight: 13.7, cycleWidth: 7.3, nameColWidth: 41.9 });
  const r = G.cellRect(L, 0, 1);
  assert.strictEqual(r.x, 49.199999999999996, '浮點數本身沒有變，變的是 hit test');
  assert.deepStrictEqual(G.cellAt(L, r.x, r.y), { laneIndex: 0, cycle: 1 },
    '小數尺寸下，格子的左緣仍然屬於自己');
  assert.deepStrictEqual(G.cellAt(L, r.x, r.y + r.height / 2), { laneIndex: 0, cycle: 1 });

  // 列的方向同理：lane 2 的上緣
  const r2 = G.cellRect(L, 2, 0);
  assert.deepStrictEqual(G.cellAt(L, r2.x + r2.width / 2, r2.y), { laneIndex: 2, cycle: 0 },
    '小數尺寸下，列的上緣仍然屬於自己');
}
{
  // 決定性的小數 fuzz：6 lane × 8 cycle × 200 組尺寸 = 9600 格，
  // 每一格都檢查中心、左上角、以及右緣屬於下一格。
  //
  // v3.6.0 Task 4 fix round 1（Important）：每條 lane 現在都額外帶非 1 的
  // fractional period、非 0 的正負 phase，每組尺寸也各自帶一個 config.hscale
  // ——`originX = nameColWidth - cycleWidth*phase` 是全新的減法，减法與除法
  // 在小數尺寸下捨入的方向不同，這個 fuzz 存在的理由正是要抓這個，不能讓它
  // 繼續只測 period=1/phase=0/hscale=1 的舊路徑。phase 的範圍刻意按這條 lane
  // 自己的 cycleWidth 與 nameColWidth 換算，保證 originX 不會被推成負值 ——
  // 「originX 是負的」是刻意的另一種情境，R14 矩陣那組測試已經專門測過，這裡
  // 的職責只是替既有的邊界精度檢查換上非 1/0/1 的算式，兩者不混在一起。
  // lane 數、trial 數、每個 lane 的 cycle 數（wave 字串長度，不受 period 影響）
  // 都維持原樣，所以下面 `cells === 9600` 這個釘住的數字不必重新量。
  let seed = 20260912;
  const rnd = function () {
    seed ^= seed << 13; seed |= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed |= 0;
    return ((seed >>> 0) % 1000000) / 1000000;
  };

  let cells = 0, centreMiss = 0, leftEdgeMiss = 0, topEdgeMiss = 0, nextMiss = 0, farMiss = 0;
  let firstBad = null;
  for (let t = 0; t < 200; t++) {
    const opts = {
      laneHeight: 1 + rnd() * 40,
      cycleWidth: 1 + rnd() * 40,
      nameColWidth: 1 + rnd() * 40,
    };
    const rawHscale = 0.5 + rnd() * 4;
    // 保守估計引擎正規化後的 hscale 上界（R15 是 round 再 clamp，這裡故意抓
    // 得比真正的結果更大），只用來把 phase 的安全範圍算得夠窄，不是在複製
    // production 的正規化邏輯。
    const hscaleBound = Math.ceil(rawHscale) + 1;
    const doc = { signal: [], config: { hscale: rawHscale } };
    for (let i = 0; i < 6; i++) {
      const period = 0.4 + rnd() * 3.6;
      const laneCycleWidthBound = opts.cycleWidth * period * hscaleBound;
      const maxPhase = opts.nameColWidth / laneCycleWidthBound;
      const phase = (rnd() * 2 - 1) * maxPhase;
      doc.signal.push({ name: 'l' + i, wave: '01010101', period: period, phase: phase });
    }
    const L = G.layoutOf(doc, opts);
    for (let lane = 0; lane < L.lanes.length; lane++) {
      for (let cyc = 0; cyc < L.cycles; cyc++) {
        cells++;
        const r = G.cellRect(L, lane, cyc);
        const centre = G.cellAt(L, r.x + r.width / 2, r.y + r.height / 2);
        const left = G.cellAt(L, r.x, r.y + r.height / 2);
        const top = G.cellAt(L, r.x + r.width / 2, r.y);
        const bad = function (hit, wantLane, wantCycle) {
          return !hit || hit.laneIndex !== wantLane || hit.cycle !== wantCycle;
        };
        if (bad(centre, lane, cyc)) centreMiss++;
        if (bad(left, lane, cyc)) leftEdgeMiss++;
        if (bad(top, lane, cyc)) topEdgeMiss++;
        if (cyc + 1 < L.cycles) {
          // 「右緣屬於下一格」的標準說法：下一格自己的左緣。`r.x + r.width` 是
          // 另一個算式（先乘再加 vs 先加再乘），在小數尺寸下可能差最後一個 ulp，
          // 落在邊界的左邊一點點 —— 那時候它**真的**還在這一格裡，回這一格才對。
          // 所以那個點只釘「不准差到第三格去」。
          const nextX = G.cellRect(L, lane, cyc + 1).x;
          const nxt = G.cellAt(L, nextX, r.y + r.height / 2);
          if (bad(nxt, lane, cyc + 1)) nextMiss++;
          // `r.x + r.width` 落在下一格左緣的左邊時答案就是**這一格**，否則是下一格。
          // 上一輪這裡寫成「cyc 或 cyc+1 都算對」，等於兩個答案都收——那個寬容剛好
          // 把 indexAt 的**往下貼齊**那一圈變成測不到的死碼（它只改這個點的答案）。
          // 這裡改成照算式判定，兩邊都是精確值。
          const want = (r.x + r.width < nextX) ? cyc : cyc + 1;
          const far = G.cellAt(L, r.x + r.width, r.y + r.height / 2);
          if (bad(far, lane, want)) farMiss++;
        }
        if (firstBad === null && (bad(centre, lane, cyc) || bad(left, lane, cyc))) {
          firstBad = { opts: opts, lane: lane, cyc: cyc, rect: r, left: left, centre: centre };
        }
      }
    }
  }
  assert.strictEqual(cells, 9600, 'fuzz 的規模本身也釘住，免得它悄悄縮水');
  assert.strictEqual(centreMiss, 0, '小數尺寸：中心必須 hit 回同一格。' + JSON.stringify(firstBad));
  assert.strictEqual(leftEdgeMiss, 0, '小數尺寸：左緣必須屬於自己。' + JSON.stringify(firstBad));
  assert.strictEqual(topEdgeMiss, 0, '小數尺寸：上緣必須屬於自己。' + JSON.stringify(firstBad));
  assert.strictEqual(nextMiss, 0, '小數尺寸：下一格的左緣必須屬於下一格');
  assert.strictEqual(farMiss, 0, '小數尺寸：rect 的右緣要落在算式說的那一格（沒到下一格的左緣就還是這一格）');
}

// ---------------------------------------------------------------------------
// F3：parser 接受得了的文件，layoutOf 不准丟
//
// 上一輪 lane 數超過上限是 throw，跟自己寫的「文件壞掉回空版面、只有尺寸壞掉才丟」
// 互相矛盾，而 Task 6 每次 render 都會呼叫 layoutOf。改成截斷並且說出來。
// 上限 1024 的理由是量到的成本：這一層的列舉是 O(N²)（逐一問 codec 的 lanePath），
// 本 session 量到 1000 條 95ms、2000 條 337ms、4096 條 1259ms。
// ---------------------------------------------------------------------------
{
  const mk = function (n) {
    const doc = { signal: [] };
    for (let i = 0; i < n; i++) doc.signal.push({ name: 'l' + i, wave: '01' });
    return doc;
  };
  const full = G.layoutOf(mk(1024));
  assert.strictEqual(full.lanes.length, 1024);
  assert.strictEqual(full.truncated, false, '剛好在上限上不算截斷');

  const big = mk(1025);
  const over = G.layoutOf(big);
  assert.strictEqual(over.lanes.length, 1024, '超過上限就截斷，不丟');
  assert.strictEqual(over.truncated, true, '而且說得出來，讓呼叫端可以顯示警告');
  // v3.6.0 Task 6 re-pin: 舊值 1024*laneHeight（30720）→ 新值再加 over.originY
  assert.strictEqual(over.height, over.originY + 1024 * over.laneHeight);
  assert.deepStrictEqual(over.lanes[1023].path, C.lanePath(big, 1023),
    '截斷後最後一條仍然是 codec 的第 1023 條，不是別的');
  assert.strictEqual(over.lanes[1023].lane.name, 'l1023');

  // 端到端：parser 收得下的來源，幾何層不准炸
  const src = '{signal:[' + Array.from({ length: 1025 }, function (_, i) {
    return '{name:"l' + i + '",wave:"01"}';
  }).join(',') + ']}';
  const parsed = C.parseSource(src);
  assert.strictEqual(parsed.ok, true, 'parser 收得下 1025 條');
  const fromSource = G.layoutOf(parsed.doc);
  assert.strictEqual(fromSource.truncated, true);
  assert.strictEqual(fromSource.lanes.length, 1024);
}

// ---------------------------------------------------------------------------
// F5：opts 不是物件就是呼叫端的程式錯誤，跟 {laneHeight:'40'} 同一類
// ---------------------------------------------------------------------------
{
  for (const bad of [42, '40', [], function () {}, true]) {
    assert.throws(function () { G.layoutOf(FLAT, bad); }, TypeError,
      'opts=' + JSON.stringify(bad) + ' 必須丟，不能默默用預設尺寸畫在錯的比例上');
  }
  // null / undefined 是「沒給」，用預設
  assert.strictEqual(G.layoutOf(FLAT, null).laneHeight, 30);
  assert.strictEqual(G.layoutOf(FLAT, undefined).laneHeight, 30);
}

// ---------------------------------------------------------------------------
// Q1 的裁決：有 lane 的文件，cycles 至少是 1
//
// 量到的（本 session）：`{signal:[{name:'a',wave:''}]}` 的 svg 寬度是 100、
// lane.xmax=2（＝一個 cycle 的兩塊 brick），跟 `wave:'0'` 一模一樣 —— 引擎替空的
// wave 保留了一拍。`{signal:[]}` 則是寬 40、xmax=0，一拍都不保留。
// 所以「有 lane 就至少一拍、沒有 lane 就 0 拍」跟引擎畫的是同一件事。
// ---------------------------------------------------------------------------
{
  const opts = { laneHeight: 40, cycleWidth: 20, nameColWidth: 60 };
  for (const doc of [{ signal: [{ name: 'a', wave: '' }] }, { signal: [{}] },
    { signal: [{ name: 'a' }] }]) {
    const L = G.layoutOf(doc, opts);
    assert.strictEqual(L.cycles, 1, '有 lane 的文件至少要有一拍可以畫：' + JSON.stringify(doc));
    assert.strictEqual(L.lanes[0].cycles, 0, '但那條 lane 自己仍然是 0 拍');
    assert.strictEqual(L.width, 60 + 20);
    // v3.6.0 Task 6 re-pin: y 舊值 0 → 新值 L.originY（lane 0 的上緣，尺規帶之下）
    assert.deepStrictEqual(G.cellAt(L, 60, L.originY), { laneIndex: 0, cycle: 0 },
      '空文件也要有一個座標可以放第一拍');
    assert.deepStrictEqual(G.cellRect(L, 0, 0),
      { x: 60, y: L.originY, width: 20, height: 40 });
    assert.strictEqual(G.cellRect(L, 0, 1), null, '但只有一拍');
  }
  // 沒有 lane 就沒有拍：引擎也一樣（寬 40 vs 100）
  const empty = G.layoutOf({ signal: [] }, opts);
  assert.strictEqual(empty.cycles, 0);
  assert.strictEqual(empty.width, 60);
}

// ---------------------------------------------------------------------------
// MUST-FIX 1：整份文件只問 codec 一次
//
// `lanePath` 每被問一次就走一次樹，所以逐條問是 O(N²)，而且那個成本跟**文件**的
// 長度走、不是跟上限走 —— 上一輪把上限從 4096 降到 1024 並不會擋住它（20000 條
// 的文件照樣要 2 秒以上）。改成問一次 `lanePaths`。
//
// 這裡不用計時來釘（會飄），直接數呼叫次數：geometry 是透過模組物件的屬性呼叫
// codec 的，所以把屬性換掉就數得到。
// ---------------------------------------------------------------------------
{
  const realPaths = C.lanePaths;
  const realPath = C.lanePath;
  let nPaths = 0, nPath = 0;
  C.lanePaths = function (d) { nPaths++; return realPaths.call(C, d); };
  C.lanePath = function (d, i) { nPath++; return realPath.call(C, d, i); };
  let lanes = -1;
  try {
    lanes = G.layoutOf(GROUPED).lanes.length;
  } finally {
    C.lanePaths = realPaths;
    C.lanePath = realPath;
  }
  assert.strictEqual(lanes, 4, '換掉屬性之後答案要不變');
  assert.strictEqual(nPaths, 1, '整份文件只准問一次 lanePaths');
  assert.strictEqual(nPath, 0, '不准再逐條問 lanePath：那是 O(N²)，而且成本跟文件長度走');
}

// ---------------------------------------------------------------------------
// R2：hit test 不准回 -0
//
// `Math.round(-0.2)` 是 -0，呼叫端拿它當座標傳進來，回來的 laneIndex 也會是 -0；
// 數值與索引都沒差，但 `deepStrictEqual(hit, {laneIndex: 0})` 會失敗，下一棒會為了
// 一個算得正確的答案debug 一小時。
// ---------------------------------------------------------------------------
// v3.6.0 Task 6 re-pin: `y = -0` 曾經是 lane 0 的上緣（originY 是 0），拿它探
// laneIndex 的 -0 折疊。`originY` 現在恆為 >=22（尺規帶永遠保留），`pos - origin`
// 不可能再算出 -0（IEEE754：兩個相等的非零有限數相減一律是 +0，不是 -0），所以
// laneIndex 這條路徑的 -0 折疊，經由 `cellAt` 已經量不到了——不是缺陷，是
// Task 6 把「origin 是 0」這個前提本身拿掉了。cycle（x 軸，origin 仍可以是
// nameColWidth=0）完全不受影響，照舊測。y 改用 `L.originY`，繼續驗證輸出契約
// 本身（不准是 -0），即使內部已經不需要那個 `+0` 折疊也要成立。
{
  const L = G.layoutOf(FLAT, { laneHeight: 40, cycleWidth: 20, nameColWidth: 0 });
  const hit = G.cellAt(L, -0, L.originY);
  assert.deepStrictEqual(hit, { laneIndex: 0, cycle: 0 });
  assert.strictEqual(Object.is(hit.laneIndex, -0), false, 'laneIndex 不准是 -0');
  assert.strictEqual(Object.is(hit.cycle, -0), false, 'cycle 不准是 -0');
  const L2 = G.layoutOf(FLAT, { laneHeight: 40, cycleWidth: 20, nameColWidth: 60 });
  const hit2 = G.cellAt(L2, 60, L2.originY);
  assert.strictEqual(Object.is(hit2.laneIndex, -0), false);
}

// ---------------------------------------------------------------------------
// R4：opts 必須是「物件字面值那種物件」
//
// F5 擋掉了 42 / '40' / [] / function / true，但 `new Date()`、`new Map()` 還是
// 默默用預設尺寸畫出來 —— 正是 F5 要擋的那個結果，只是換了一種拼法。
// 判別式跟 codec 的 isPlainObject 同一條：prototype 是 Object.prototype 或 null。
// ---------------------------------------------------------------------------
{
  for (const bad of [new Date(), new Map(), new Set(), /re/, new Error('x')]) {
    assert.throws(function () { G.layoutOf(FLAT, bad); }, TypeError,
      String(bad) + ' 不是設定物件，不能默默用預設尺寸');
  }
  const bare = Object.create(null);
  bare.laneHeight = 7;
  assert.strictEqual(G.layoutOf(FLAT, bare).laneHeight, 7,
    'prototype 是 null 的物件是合法的設定物件（跟 codec 的 isPlainObject 同一條線）');
}

// ── v3.5.0 Task 5: edge 幾何 ─────────────────────────────────────────────
{
  const C = require('../lib/editor/wave-codec.js');
  const doc = C.parseSource(
    '{signal:[{name:"a",wave:"0123",node:".b.."},{name:"z",wave:"0123",node:"...c"}],' +
    'edge:["b~>c setup"]}').doc;
  const layout = G.layoutOf(doc);
  const edges = G.edgeLayout(doc, layout);

  assert.strictEqual(edges.length, 1);
  assert.strictEqual(edges[0].index, 0);
  assert.strictEqual(edges[0].edge.shape, '~>');

  // 端點落在該格的錨點（v3.6.0 Task 5：不是格子正中央，是引擎畫轉態斜坡
  // 結束的那一點）——與 anchorOfCell 同一個運算式算出來的，不另算一份。
  const a0 = G.anchorOfCell(layout, 0, 1);
  assert.strictEqual(edges[0].from.x, a0.x);
  assert.strictEqual(edges[0].from.y, a0.y);

  // fix round 1：上面那兩條只證明 edgeLayoutDetail 把參數傳對了（兩邊都呼叫
  // 同一顆 anchorOfCell，證不出算式本身對不對）。這裡另外手算一次——不透過
  // anchorOfCell／cellRect，只用 DEFAULTS（laneHeight 30、cycleWidth 40、
  // nameColWidth 40）跟 SKIN_METRICS.anchorRatio 這個常數——把數字釘死。
  assert.strictEqual(edges[0].from.x, 40 + 1 * 40 + G.SKIN_METRICS.anchorRatio * 40,
    '手算：nameColWidth(40) + cycle 1 * cycleWidth(40) + anchorRatio(0.15) * cycleWidth(40) = 86');
  // v3.6.0 Task 6 re-pin: 舊值 15（0*30+30/2）→ 新值加上 layout.originY
  // （尺規帶把 lane 0 往下推）。
  assert.strictEqual(edges[0].from.y, layout.originY + 0 * 30 + 30 / 2,
    '手算：originY + lane 0 的列中心 y = originY + 0*laneHeight(30) + laneHeight/2');

  assert.ok(typeof edges[0].d === 'string' && edges[0].d.charAt(0) === 'M',
    'path 必須是 SVG d 字串');

  // 反函數：把手矩形產生的位置，命中要找得回同一個端點。
  for (const end of ['from', 'to']) {
    const rect = G.edgeHandleRect(edges[0][end]);
    const hit = G.edgeHandleAt(edges, rect.x + rect.width / 2, rect.y + rect.height / 2);
    assert.deepStrictEqual(hit, { index: 0, end: end },
      '把手中心點必須命中它自己（' + end + '）');
  }
  assert.strictEqual(G.edgeHandleAt(edges, -999, -999), null, '離很遠不得命中');

  // 引用到不存在字母的 edge 要被跳過，不得丟例外。
  const dangling = C.parseSource('{signal:[{name:"a",wave:"01"}],edge:["q~>r x"]}').doc;
  assert.deepStrictEqual(G.edgeLayout(dangling, G.layoutOf(dangling)), [],
    '字母不存在的 edge 畫不出來，但不得讓整張圖倒掉');

  console.log('wave-geometry: edge 幾何與把手命中互為反函數 — OK');
}

// ── v3.5.0 Task 5 fix round 2 (a)：壞掉的 edge 被跳過，兄弟 edge 照樣畫出來 ──
//
// 舊的 dangling fixture 整份文件沒有一個合法字母，只證明「全壞回 []」——把
// `continue` 誤打成 `break` 那份測試照樣綠。這裡在同一個 `edge` 陣列裡混一條
// 壞掉的、一條合法的，證明兩件事：壞的那條被跳過而不是讓整個陣列提早結束；
// 存活下來那條的 `index` 是它在 `doc.edge` 裡的原始位置（1），不是過濾後輸出
// 陣列裡的位置（0）——這正是要驗證的地方。
// ---------------------------------------------------------------------------
{
  const C = require('../lib/editor/wave-codec.js');
  const doc = C.parseSource(
    '{signal:[{name:"a",wave:"0123",node:".b.."},{name:"z",wave:"0123",node:"...c"}],' +
    'edge:["q~>r x","b~>c setup"]}').doc;
  const layout = G.layoutOf(doc);
  const edges = G.edgeLayout(doc, layout);

  assert.strictEqual(edges.length, 1, '壞掉那條不能讓存活的那條也一起消失');
  assert.strictEqual(edges[0].index, 1,
    'index 必須是 doc.edge 裡的原始位置（1），不是過濾後陣列裡的位置（0）');
  assert.strictEqual(edges[0].edge.shape, '~>');

  const a0 = G.anchorOfCell(layout, 0, 1);
  const a1 = G.anchorOfCell(layout, 1, 3);
  assert.strictEqual(edges[0].from.x, a0.x);
  assert.strictEqual(edges[0].from.y, a0.y);
  assert.strictEqual(edges[0].to.x, a1.x);
  assert.strictEqual(edges[0].to.y, a1.y);

  // fix round 1：同樣手算一次，不透過 anchorOfCell／cellRect。
  assert.strictEqual(edges[0].from.x, 40 + 1 * 40 + G.SKIN_METRICS.anchorRatio * 40,
    '手算：nameColWidth(40) + cycle 1 * cycleWidth(40) + anchorRatio(0.15) * cycleWidth(40) = 86');
  // v3.6.0 Task 6 re-pin: from.y 舊值 15、to.y 舊值 45，兩者都加上 layout.originY
  // （尺規帶把每一列都往下推同樣的距離，兩者的差不變）。
  assert.strictEqual(edges[0].from.y, layout.originY + 0 * 30 + 30 / 2,
    '手算：originY + lane 0 的列中心 y');
  assert.strictEqual(edges[0].to.x, 40 + 3 * 40 + G.SKIN_METRICS.anchorRatio * 40,
    '手算：nameColWidth(40) + cycle 3 * cycleWidth(40) + anchorRatio(0.15) * cycleWidth(40) = 166');
  assert.strictEqual(edges[0].to.y, layout.originY + 1 * 30 + 30 / 2,
    '手算：originY + lane 1 的列中心 y');

  console.log('wave-geometry: 壞掉的 edge 被跳過，兄弟 edge 的原始 index 與端點都還在 — OK');
}

// ── v3.5.0 Task 5 fix round 2 (b)：elbow 家族真的在轉角座標轉彎 ─────────────
//
// `pathFor` 有三族：elbow（`-|` 系）、curve（`~` 系）、straight（`-` 系），先前
// 只有 curve 家族被端到端量過，elbow 轉角座標的 off-by-one 不會被任何既有測試
// 抓到。挑 `-|-` 當代表：它的 `midX` 是 `(from.x+to.x)/2`，跟 `from.x`/`to.x`
// 都不同，能真正證明「有轉」；`-|`／`|-` 的 `midX` 會退化成 `to.x`/`from.x`，
// 看不出跟直線的差別。
// ---------------------------------------------------------------------------
{
  const C = require('../lib/editor/wave-codec.js');
  const doc = C.parseSource(
    '{signal:[{name:"a",wave:"0123",node:".d.."},{name:"z",wave:"0123",node:"...e"}],' +
    'edge:["d-|-e"]}').doc;
  const layout = G.layoutOf(doc);
  const edges = G.edgeLayout(doc, layout);
  assert.strictEqual(edges.length, 1);
  assert.strictEqual(edges[0].edge.shape, '-|-');

  const from = edges[0].from;
  const to = edges[0].to;
  const midX = (from.x + to.x) / 2;
  assert.notStrictEqual(midX, from.x, 'midX 必須跟兩端都不同，才是真的轉彎而不是退化成直線');
  assert.notStrictEqual(midX, to.x);

  const d = edges[0].d;
  assert.strictEqual(d.indexOf('M' + from.x + ',' + from.y), 0,
    'path 必須從起點出發');
  assert.ok(d.indexOf(' L' + midX + ',' + from.y + ' ') !== -1,
    '第一段是水平線：走到轉角的 x，y 仍停在起點的 y');
  assert.ok(d.indexOf(' L' + midX + ',' + to.y) !== -1,
    '第二段是垂直線：x 停在轉角，y 換成終點的 y');
  assert.ok(d.slice(-(' L' + to.x + ',' + to.y).length) === ' L' + to.x + ',' + to.y,
    '最後一段走到終點座標收尾');

  console.log('wave-geometry: elbow 家族真的在轉角座標轉彎 — OK');
}

// ── v3.5.0 Task 5 fix round 2 (c)：straight 家族是單一直線，沒有轉角也沒有曲線 ─
//
// straight 家族（`-` 系，這裡用箭頭變體 `->`）該只有一個 `M` 加一個 `L`：沒有
// elbow 的中繼轉角點，也沒有 curve 家族的 `C` 指令。
// ---------------------------------------------------------------------------
{
  const C = require('../lib/editor/wave-codec.js');
  const doc = C.parseSource(
    '{signal:[{name:"a",wave:"0123",node:".f.."},{name:"z",wave:"0123",node:"...g"}],' +
    'edge:["f->g"]}').doc;
  const layout = G.layoutOf(doc);
  const edges = G.edgeLayout(doc, layout);
  assert.strictEqual(edges.length, 1);
  assert.strictEqual(edges[0].edge.shape, '->');

  const from = edges[0].from;
  const to = edges[0].to;
  const d = edges[0].d;
  assert.strictEqual(d.indexOf('C'), -1, 'straight 家族不准出現曲線指令');
  assert.strictEqual((d.match(/L/g) || []).length, 1, 'straight 家族只准有一個 L，沒有轉角中繼點');
  assert.strictEqual(d, 'M' + from.x + ',' + from.y + ' L' + to.x + ',' + to.y,
    '只有起點與終點兩個座標，中間沒有別的東西');

  console.log('wave-geometry: straight 家族是單一直線，沒有轉角也沒有曲線 — OK');
}

// ── final review finding 1：`-|` 與 `|-` 轉角次序不同，不能是同一條 path ─────
//
// 量測對象是 pin 住的 node_modules/wavedrom/lib/arc-shape.js：
//   case '-|' : d = 'm from.x,from.y  dx,0  0,dy'   → 先橫、後直
//   case '|-' : d = 'm from.x,from.y  0,dy  dx,0'   → 先直、後橫
// 兩者不是同一條線的兩種寫法，是兩種不同的轉角次序，這裡用結構斷言（第一段
// 是水平還是垂直）釘住，而不是各自的黃金字串——字串斷言只證明「retype 出同
// 一個 bug」的迴歸沒發生，證不出兩族本來就該不同。
// ---------------------------------------------------------------------------
{
  const C = require('../lib/editor/wave-codec.js');
  const doc = C.parseSource(
    '{signal:[{name:"a",wave:"0123",node:".h.."},{name:"z",wave:"0123",node:"...i"}],' +
    'edge:["h-|i","h|-i"]}').doc;
  const layout = G.layoutOf(doc);
  const edges = G.edgeLayout(doc, layout);
  assert.strictEqual(edges.length, 2);
  assert.strictEqual(edges[0].edge.shape, '-|');
  assert.strictEqual(edges[1].edge.shape, '|-');

  const from = edges[0].from;
  const to = edges[0].to;
  assert.notStrictEqual(from.x, to.x, '起訖點的 x 必須不同，否則轉彎次序測不出差異');
  assert.notStrictEqual(from.y, to.y, '起訖點的 y 必須不同，否則轉彎次序測不出差異');

  const dashPipe = edges[0].d;   // '-|'：先橫後直
  const pipeDash = edges[1].d;   // '|-'：先直後橫

  assert.strictEqual(dashPipe, 'M' + from.x + ',' + from.y +
    ' L' + to.x + ',' + from.y + ' L' + to.x + ',' + to.y,
    '-| 的第一段落在 (to.x, from.y) —— 水平先行');
  assert.strictEqual(pipeDash, 'M' + from.x + ',' + from.y +
    ' L' + from.x + ',' + to.y + ' L' + to.x + ',' + to.y,
    '|- 的第一段落在 (from.x, to.y) —— 垂直先行');

  assert.notStrictEqual(dashPipe, pipeDash, '-| 與 |- 不准畫出同一條 path');

  // 兩條路徑都恰好一個轉角（兩段 L），沒有退化成的零長度收尾段。
  assert.strictEqual((dashPipe.match(/L/g) || []).length, 2);
  assert.strictEqual((pipeDash.match(/L/g) || []).length, 2);

  console.log('wave-geometry: -| 與 |- 的轉角次序不同，各自釘住 — OK');
}

// ---------------------------------------------------------------------------
// v3.6.0 Task 3：SKIN_METRICS 是 pin 住的常數（R12：不得在 wave-geometry.js
// 內 require('wavedrom') 推導 —— 瀏覽器的 window.WaveDrom 不帶 waveSkin，見
// production 碼上方註解）。推導與跟引擎對答案的工作移到這裡，測試檔可以自由
// require 任何東西。
// ---------------------------------------------------------------------------
{
  const M = G.SKIN_METRICS;
  assert.ok(M !== undefined, 'SKIN_METRICS 必須匯出');
  assert.ok(Object.isFrozen(M), 'SKIN_METRICS 必須是 frozen 常數');

  const wd = require('wavedrom');
  const skinText = JSON.stringify(wd.waveSkin);

  // MEASURED（node_modules/wavedrom 3.5.0）：skin 的 socket 是
  // ["rect",{"y":"15","x":"6","height":"20","width":"20"}]，半磚寬 20 →
  // 一個 cycle 40，錨點 x=6 → 6/40 = 0.15。
  const sock = skinText.match(/"id":"socket"\},\["rect",\{"y":"\d+","x":"(\d+)","height":"\d+","width":"(\d+)"\}/);
  assert.ok(sock !== null, 'skin 必須有 socket 這個 rect（引擎版本變了才會沒有）');
  const halfBrick = Number(sock[2]);
  const cycleUnit = halfBrick * 2;
  const derivedAnchorRatio = Number(sock[1]) / cycleUnit;
  assert.strictEqual(derivedAnchorRatio, M.anchorRatio,
    'pinned anchorRatio 必須跟 waveSkin 現場推導的一致 —— 不一致代表 wavedrom 換了 skin，要重新 pin');
  assert.strictEqual(M.slewEndRatio, M.anchorRatio, '斜坡終點即錨點');

  // MEASURED：轉態磚 `0m0` 的 path 是 'm0,20 3,0 3,-…'，第一段長 3 → 3/40。
  const ramp = skinText.match(/"id":"0m0"\},\["path",\{"d":"m0,\d+ (\d+),0 /);
  assert.ok(ramp !== null, 'skin 必須有 0m0 這個 path（引擎版本變了才會沒有）');
  const derivedSlewStartRatio = Number(ramp[1]) / cycleUnit;
  assert.strictEqual(derivedSlewStartRatio, M.slewStartRatio,
    'pinned slewStartRatio 必須跟 waveSkin 現場推導的一致');

  assert.ok(M.slewStartRatio < M.slewEndRatio, '斜坡必須有寬度');

  // 直接跟引擎對答案：同一份 doc 的 gmark 端點必須落在 anchorRatio 上。
  const src = { signal: [{ name: 'w', wave: '0.1.0...', node: 'a.b.c...' }], edge: ['a-b'] };
  const out = JSON.stringify(wd.renderAny(0, JSON.parse(JSON.stringify(src)), wd.waveSkin));
  const m = out.match(/gmark_a_b","d":"M (\d+(?:\.\d+)?),\d+ (\d+(?:\.\d+)?),/);
  assert.ok(m !== null, '引擎必須畫出 gmark_a_b');
  const engineFrom = Number(m[1]);
  const engineTo = Number(m[2]);
  const ENGINE_CYCLE = 40;
  assert.strictEqual(engineFrom, 0 * ENGINE_CYCLE + M.anchorRatio * ENGINE_CYCLE,
    'a 在 cycle 0 的錨點上');
  assert.strictEqual(engineTo, 2 * ENGINE_CYCLE + M.anchorRatio * ENGINE_CYCLE,
    'b 在 cycle 2 的錨點上');

  console.log('wave-geometry: SKIN_METRICS 是 pin 住的常數，且跟引擎逐值相符 — OK');
}

// ---------------------------------------------------------------------------
// v3.6.0 Task 4：period / phase / config.hscale 進入 layout
// ---------------------------------------------------------------------------
{
  const doc = {
    signal: [
      { name: 'a', wave: '0101' },
      { name: 'b', wave: '0101', period: 2 },
      { name: 'c', wave: '0101', phase: 0.5 },
    ],
    config: { hscale: 2 },
  };
  const L = G.layoutOf(doc, { laneHeight: 40, cycleWidth: 20, nameColWidth: 60 });

  assert.strictEqual(L.hscale, 2, 'config.hscale 進 layout');

  // base 20 × hscale 2 = 40
  assert.strictEqual(L.lanes[0].cycleWidth, 40, '沒有 period 的 lane 只吃 hscale');
  // base 20 × period 2 × hscale 2 = 80
  assert.strictEqual(L.lanes[1].cycleWidth, 80, 'period 再乘上去');
  assert.strictEqual(L.lanes[2].cycleWidth, 40, 'phase 不改變格寬');

  // phase 不乘 hscale（引擎如此：xs*(2*i*period*hscale - phase)）
  assert.strictEqual(L.lanes[0].originX, 60, '沒有 phase 就是名稱欄右緣');
  assert.strictEqual(L.lanes[2].originX, 60 - 20 * 0.5, 'phase 位移用的是 base，不乘 hscale');

  // cellRect 用該 lane 自己的格寬
  assert.strictEqual(G.cellRect(L, 1, 1).x, 60 + 1 * 80, 'period 2 的 lane 第 1 格在 80 之後');
  assert.strictEqual(G.cellRect(L, 1, 1).width, 80);

  // 往返性質仍成立（既有測試釘住的性質，不得因 per-lane 而破）
  for (let lane = 0; lane < 3; lane++) {
    for (let cyc = 0; cyc < L.lanes[lane].cycles; cyc++) {
      const r = G.cellRect(L, lane, cyc);
      const hit = G.cellAt(L, r.x + r.width / 2, r.y + r.height / 2);
      assert.deepStrictEqual(hit, { laneIndex: lane, cycle: cyc },
        'per-lane 之後往返仍成立：lane=' + lane + ' cycle=' + cyc);
    }
  }

  console.log('wave-geometry: period/phase/hscale 進入 per-lane 幾何 — OK');
}

// ---------------------------------------------------------------------------
// v3.6.0 Task 4 fix round 1 — Critical repro：短 lane 的「往後畫一格」affordance
// 曾經拿「整張圖的 cycle 數」（layout.cycles）乘上「這條 lane 自己的
// cycleWidth」當作右邊界，兩者只有在所有 lane 共用同一個 cycleWidth 時才會
// 恰好一致；period 一旦不同，這條線就會超出 layout.width。逐字照抄 controller
// 的重現。
// ---------------------------------------------------------------------------
{
  const doc = {
    signal: [
      { name: 'a', wave: '01010' },
      { name: 'b', wave: '01', period: 3 },
    ],
  };
  const L = G.layoutOf(doc, { laneHeight: 40, cycleWidth: 20, nameColWidth: 60 });
  assert.strictEqual(L.width, 180);
  assert.strictEqual(L.cycles, 5);

  assert.strictEqual(G.cellRect(L, 1, 4), null,
    'lane 1（period 3）自己的格寬乘上整張圖的 cycle 數會超出 layout.width（180），必須是 null');
  assert.strictEqual(G.cellAt(L, 330, 60), null,
    '330 已經在 layout.width(180) 外面，不准命中任何格子');

  console.log('wave-geometry: fix round 1 Critical 重現已修（period 不再讓格子跑出 layout.width）— OK');
}

// ---------------------------------------------------------------------------
// v3.6.0 Task 4 fix round 1 — R14：控制器給的是不變量，不是算式。
//
//   (a) 每一個非 null 的 cellRect(L,i,c) 都整個落在 [0, layout.width] 之內；
//   (b) cellRect(L,i,c) !== null 若且唯若 cellAt(該格中心) 精確回 {i,c}；
//   (c) 均勻文件（每條 lane period 1 / phase 0 / hscale 1）可觸及的 cycle
//       範圍跟今天一樣，一格不少一格不多；
//   (d)（v3.6.0 Task 5 fix round 1）對任何 `(x, y)`，若 `boundaryAt` 回傳
//       `{laneIndex, cell}`，`cellRect(layout, laneIndex, cell)` 必須不是
//       null——`boundaryAt` 給出的答案不准比 `cellRect` 認得的範圍寬。
//
// 用矩陣而不是單一 fixture 驗證：上一輪正是「只有一組 fixture」才讓 Critical
// 那個缺陷混進來。矩陣涵蓋：均勻／混合 period（含一條每格明顯比別人寬的）／
// 正負 phase（含一個大到把 originX 推成負值的）／hscale≠1（含需要 R15 四捨
// 五入的小數），而且每一種都在整數與小數尺寸下各跑一次。
//
// (d) 本身也是同一個教訓的重複：Task 5 fix round 1 的 Critical 正是
// `boundaryAt` 只顧到 `reachOf` 那一邊（右界），漏掉 `cellRect` 另外還判的
// 左緣（`phase` 把 `originX` 推成負值時）——而第一版的 `boundaryAt` 測試只
// 挑了矩陣裡「混合 period」那組不帶 `phase` 的 fixture，天生碰不到左緣那條
// 路徑。這裡把 (d) 併進 `verifyInvariant` 本身，讓它跟著 (a)(b)(c) 掃過同一份
// 矩陣（含帶 `phase` 的那組、含 `huge` 那條 `originX` 是負的 lane），而不是
// 另外挑一個 fixture——挑 fixture 正是上一輪漏掉這個缺陷的原因。
// ---------------------------------------------------------------------------
{
  function verifyInvariant(L, label, uniformExpectedCycles) {
    for (let lane = 0; lane < L.lanes.length; lane++) {
      const row = L.lanes[lane];
      const probe = (uniformExpectedCycles === undefined ? 0 : uniformExpectedCycles) + 24;
      for (let cyc = 0; cyc < probe; cyc++) {
        const r = G.cellRect(L, lane, cyc);
        if (r !== null) {
          // (a) 整個矩形都要落在 [0, layout.width] 之內
          assert.ok(r.x >= 0, label + '：lane ' + lane + ' cyc ' + cyc +
            ' 的左緣不准是負的 —— ' + JSON.stringify(r));
          assert.ok(r.x + r.width <= L.width, label + '：lane ' + lane + ' cyc ' + cyc +
            ' 的右緣不准超出 layout.width（' + L.width + '）—— ' + JSON.stringify(r));
          // (b) 正向：非 null 的格子，中心點必須 hit 回自己
          const hit = G.cellAt(L, r.x + r.width / 2, r.y + r.height / 2);
          assert.deepStrictEqual(hit, { laneIndex: lane, cycle: cyc },
            label + '：lane ' + lane + ' cyc ' + cyc + ' 中心必須 hit 回自己');
        } else {
          // (b) 反向：cellRect 說沒有這一格，用跟 cellRect 同一條公開算式手算出
          // 它「本來會在哪裡」，那個位置的中心點不准被判成這一格。
          const x = row.originX + cyc * row.cycleWidth;
          const cx = x + row.cycleWidth / 2;
          const cy = row.y + row.height / 2;
          const hit = G.cellAt(L, cx, cy);
          assert.notDeepStrictEqual(hit, { laneIndex: lane, cycle: cyc },
            label + '：lane ' + lane + ' cyc ' + cyc + ' 沒有格子，不准被 hit 到');
        }
      }
      if (uniformExpectedCycles !== undefined) {
        // (c) 均勻文件：0..cycles-1 一格不少
        for (let cyc = 0; cyc < uniformExpectedCycles; cyc++) {
          assert.notStrictEqual(G.cellRect(L, lane, cyc), null,
            label + '：均勻文件的 lane ' + lane + ' cyc ' + cyc + ' 必須可以觸及（今天就可以）');
        }
        // 一格不多：均勻文件下每條 lane 的可觸及範圍跟 layout.cycles 對齊
        assert.strictEqual(G.cellRect(L, lane, uniformExpectedCycles), null,
          label + '：均勻文件超出 layout.cycles 的那一格必須是 null');
      }

      // (d) boundaryAt 的答案不准比 cellRect 寬：掃過畫面外到畫面外，每一個
      // x 都要驗。範圍取 layout.width 左右各加 200px，確保掃得到 phase 造成
      // 的負 originX 那一段，也掃得到 reach 之外的右邊。
      const cy2 = row.y + row.height / 2;
      for (let x = -200; x <= L.width + 200; x += 1) {
        const b = G.boundaryAt(L, x, cy2);
        if (b === null) continue;
        assert.notStrictEqual(G.cellRect(L, b.laneIndex, b.cell), null,
          label + '：lane ' + lane + ' x=' + x + ' boundaryAt 回傳的 cell 必須有 cellRect（' +
          JSON.stringify(b) + '）');
      }
    }
  }

  const SIZE_SETS = [
    { label: '整數尺寸', opts: { laneHeight: 40, cycleWidth: 20, nameColWidth: 60 } },
    { label: '小數尺寸', opts: { laneHeight: 13.7, cycleWidth: 7.3, nameColWidth: 41.9 } },
  ];

  for (const size of SIZE_SETS) {
    // 均勻：period 1 / phase 0 / hscale 1（三個欄位都沒設定）
    {
      const doc = {
        signal: [
          { name: 'a', wave: '01010101' },
          { name: 'b', wave: '01010101' },
          { name: 'c', wave: '01010101' },
        ],
      };
      const L = G.layoutOf(doc, size.opts);
      verifyInvariant(L, size.label + '／均勻', 8);
    }

    // 混合 period：一條每格明顯比別人寬（period 6），一條比別人窄（period 0.5）
    {
      const doc = {
        signal: [
          { name: 'a', wave: '01010101' },
          { name: 'wide', wave: '01', period: 6 },
          { name: 'narrow', wave: '0101010101010101', period: 0.5 },
        ],
      };
      const L = G.layoutOf(doc, size.opts);
      verifyInvariant(L, size.label + '／mixed period');
    }

    // phase：正、負，以及一個大到會把 originX 推成負值的
    {
      const doc = {
        signal: [
          { name: 'a', wave: '01010101' },
          { name: 'pos', wave: '01010101', phase: 1.5 },
          { name: 'neg', wave: '01010101', phase: -1.5 },
          { name: 'huge', wave: '01010101', phase: 10 },
        ],
      };
      const L = G.layoutOf(doc, size.opts);
      verifyInvariant(L, size.label + '／phase');
      // huge 那條：這裡的 nameColWidth 遠小於 cycleWidth*10，originX 必須是
      // 負的 —— 直接斷言，證明左緣的 null 化真的有在跑，不是矩陣裡的死碼。
      const hugeRow = L.lanes[3];
      assert.ok(hugeRow.originX < 0,
        size.label + '／phase：huge 的 originX 必須是負的，矩陣才真的測到左緣');
    }

    // config.hscale ≠ 1，含需要 R15 四捨五入的小數
    {
      const doc = {
        signal: [
          { name: 'a', wave: '01010101' },
          { name: 'b', wave: '01010101', period: 2 },
          { name: 'c', wave: '01010101', phase: 0.5 },
        ],
        config: { hscale: 2.5 },
      };
      const L = G.layoutOf(doc, size.opts);
      verifyInvariant(L, size.label + '／hscale 2.5');
    }

    // v3.6.0 Task 6 fix round 1: 延伸這個矩陣蓋 originY 不是 22（尺規帶單獨一條）
    // 的情形——head.text 疊出 42（尺規帶+標題帶），foot 疊出非零 footHeight。
    // `verifyInvariant` 本身讀的是 `row.y`／`layout.height`，不需要改；把它跑在
    // 一份 originY 更大、且同時帶 mixed period／phase 的文件上，才真的驗到
    // 「originY 改變不會悄悄弄壞既有的 x 軸不變量」，而不是只驗尺規帶單獨存在
    // 那一種（22）。
    {
      const doc = {
        signal: [
          { name: 'a', wave: '01010101' },
          { name: 'wide', wave: '01', period: 6 },
          { name: 'narrow', wave: '0101010101010101', period: 0.5, phase: 1.5 },
        ],
        head: { text: 'T' },
        foot: { tick: 0 },
      };
      const L = G.layoutOf(doc, size.opts);
      assert.strictEqual(L.originY, 42,
        size.label + '／head+foot：originY 必須是 headTextHeight(20) + rulerHeight(22)');
      assert.strictEqual(L.footHeight, 22, size.label + '／head+foot：foot 也要算進去');
      assert.strictEqual(L.height, 42 + L.lanes.length * L.laneHeight + 22,
        size.label + '／head+foot：height 必須含 originY 與 footHeight 兩端');
      verifyInvariant(L, size.label + '／head+foot（originY=42）');
    }
  }

  console.log('wave-geometry: R14 三條不變量在 period/phase/hscale 矩陣下成立 — OK');
}

// ---------------------------------------------------------------------------
// v3.6.0 Task 4 fix round 1 — R15：config.hscale 比照引擎的正規化
// （node_modules/wavedrom/lib/parse-config.js 的 `tonumber` + 再次 round +
// clamp ≤100），否則畫布跟預覽對不上，正是這個版本要清掉的那類缺陷。
// ---------------------------------------------------------------------------
{
  const mk = function (hscale) {
    return {
      signal: [
        { name: 'a', wave: '0101' },
        { name: 'b', wave: '0101', period: 2, phase: 0.5 },
      ],
      config: { hscale: hscale },
    };
  };
  const opts = { laneHeight: 40, cycleWidth: 20, nameColWidth: 60 };

  const L25 = G.layoutOf(mk(2.5), opts);
  const L3 = G.layoutOf(mk(3), opts);
  assert.strictEqual(L25.hscale, 3, 'hscale:2.5 必須跟引擎一樣四捨五入成 3');
  assert.deepStrictEqual(L25.lanes.map(function (l) { return l.cycleWidth; }),
    L3.lanes.map(function (l) { return l.cycleWidth; }),
    'hscale:2.5 產生的幾何必須跟 hscale:3 逐值相同');
  assert.deepStrictEqual(L25.lanes.map(function (l) { return l.originX; }),
    L3.lanes.map(function (l) { return l.originX; }));
  assert.strictEqual(L25.width, L3.width);

  const L250 = G.layoutOf(mk(250), opts);
  assert.strictEqual(L250.hscale, 100, 'hscale:250 必須 clamp 到 100');

  // 邊界：四捨五入後 <=0 的，引擎當成沒設定，用預設 1
  assert.strictEqual(G.layoutOf(mk(0.4), opts).hscale, 1,
    '四捨五入後是 0 的，引擎當作沒設定，用預設 1');
  assert.strictEqual(G.layoutOf(mk(-5), opts).hscale, 1, '負的 hscale 引擎當成 1');
  assert.strictEqual(G.layoutOf(mk(0), opts).hscale, 1);

  console.log('wave-geometry: config.hscale 的四捨五入／clamp 跟引擎逐值一致（R15）— OK');
}

// ---------------------------------------------------------------------------
// v3.6.0 Task 5：錨點落在斜坡終點；命中取最近邊界；轉態點可列舉
//
// 使用者回報「連線應該要頭尾相接」——量到的病因：畫布把 edge 端點畫在格子
// 正中央，引擎卻是畫在轉態磚斜坡結束的那一點，在預設 40px 的 cycle 寬下差了
// 17px，一條標注上升緣的線因此肉眼可見地沒有接上那個緣。`anchorOfCell` 是
// 修法：跟 `cellRect` 一樣問「哪一格」，但回傳的是 `SKIN_METRICS.anchorRatio`
// 那個偏移點，不是格子中心。
// ---------------------------------------------------------------------------
{
  const doc = { signal: [{ name: 'w', wave: '0.1.0...', node: 'a.b.c...' }], edge: ['a-b'] };
  const L = G.layoutOf(doc, { laneHeight: 40, cycleWidth: 40, nameColWidth: 0 });
  const R = G.SKIN_METRICS.anchorRatio;

  // v3.6.0 Task 6 re-pin: y 舊值 20（lane 0 列中心，laneHeight/2）→ 新值
  // L.originY + 20（尺規帶把 lane 0 往下推）。
  const y0 = L.originY + 20;
  assert.deepStrictEqual(G.anchorOfCell(L, 0, 0), { x: 0 * 40 + R * 40, y: y0 });
  assert.deepStrictEqual(G.anchorOfCell(L, 0, 2), { x: 2 * 40 + R * 40, y: y0 });
  assert.strictEqual(G.anchorOfCell(L, 0, 99), null, '超出範圍沒有錨點');

  // edge 端點必須跟著走
  const edges = G.edgeLayout(doc, L);
  assert.strictEqual(edges.length, 1);
  assert.strictEqual(edges[0].from.x, 0 * 40 + R * 40);
  assert.strictEqual(edges[0].to.x, 2 * 40 + R * 40);

  // 命中：最近邊界，不是 floor。cycle 2 的錨點在 x = 86；
  // 從那裡往左 19px（67）與往右 19px（105）都該回到 cell 2。
  const ax = 2 * 40 + R * 40;
  assert.deepStrictEqual(G.boundaryAt(L, ax, y0), { laneIndex: 0, cell: 2 });
  assert.deepStrictEqual(G.boundaryAt(L, ax - 19, y0), { laneIndex: 0, cell: 2 },
    '往左 19px 仍是同一個邊界');
  assert.deepStrictEqual(G.boundaryAt(L, ax + 19, y0), { laneIndex: 0, cell: 2 },
    '往右 19px 仍是同一個邊界');
  assert.deepStrictEqual(G.boundaryAt(L, ax - 21, y0), { laneIndex: 0, cell: 1 },
    '往左 21px 跨到前一個邊界');

  // 轉態：'0.1.0...' → cell 0（起點）、2（上升）、4（下降）
  assert.deepStrictEqual(G.transitionsOf(doc, 0), [0, 2, 4]);

  // `|` 是斷點不是轉態
  const gapDoc = { signal: [{ name: 'g', wave: '0|1' }] };
  assert.deepStrictEqual(G.transitionsOf(gapDoc, 0), [0, 2],
    'gap 本身不算轉態，它後面那格算');

  // 中間斷一次（不是開頭）：斷點後面那格照樣算轉態
  const midGap = { signal: [{ name: 'm', wave: '01|10' }] };
  assert.deepStrictEqual(G.transitionsOf(midGap, 0), [0, 1, 3, 4],
    '斷點在中間：它前後的格子各自照自己的規則算');

  // 斷點正後方立刻接一個 held cell：held 沿用斷點前的電位，一樣不是轉態
  const gapThenHeld = { signal: [{ name: 'h', wave: '0.1|.0' }] };
  assert.deepStrictEqual(G.transitionsOf(gapThenHeld, 0), [0, 2, 5],
    '斷點正後方接著的 held cell 不算轉態，斷點本身也不算');

  console.log('wave-geometry: 錨點/最近邊界/轉態列舉 — OK');
}

// v3.6.0 Task 5 fix round 1：`boundaryAt` 的界不准比 `cellRect` 寬（R14 (d)）
// 這件事，原本只挑了 R14 矩陣裡「混合 period」那組不帶 `phase` 的 fixture，
// 碰不到 `originX` 被 `phase` 推成負值的左緣缺陷（見 Critical 修復紀錄）。
// 現在併進上面 R14 的 `verifyInvariant`（(d) 那一段），對整個矩陣（均勻／
// 混合 period／phase，含 `huge` 那條負 `originX` 的／hscale≠1）逐 x 掃描，
// 不再另外挑一組 fixture——不變量測試禁不起「只測一種輸入形狀」。

// ---------------------------------------------------------------------------
// v3.6.0 Task 5：`boundaryAt` 取最近，`cellAt` 用 floor——兩者故意不同，
// 釘住那個差異本身，免得以後有人「簡化」成同一個函式。
//
// cycleWidth=40、anchorRatio=0.15：cell 1 的錨點在 x=46，cell 2 的錨點在
// x=86，cell 2 的左緣（格線）在 x=80。挑 x=70：
//   - cellAt 用 floor((70-0)/40)=1，還沒到 cell 2 的左緣（80），答案是 cell 1；
//   - boundaryAt 比距離：|70-46|=24 對 |70-86|=16，離 cell 2 的錨點更近，
//     答案是 cell 2。
// 同一個 x，兩個函式故意給出不同答案——這正是它們各自存在的理由：畫面上使用者
// 瞄準的是 86 那條線，不是 80 那條格線。
// ---------------------------------------------------------------------------
{
  const doc = { signal: [{ name: 'w', wave: '0.1.0...', node: 'a.b.c...' }], edge: ['a-b'] };
  const L = G.layoutOf(doc, { laneHeight: 40, cycleWidth: 40, nameColWidth: 0 });
  const x = 70;
  // v3.6.0 Task 6 re-pin: y 舊值 20（lane 0 列中心）→ 新值 L.originY + 20。
  const y0 = L.originY + 20;

  assert.deepStrictEqual(G.cellAt(L, x, y0), { laneIndex: 0, cycle: 1 },
    'cellAt 用 floor：70 還沒到 cell 2 的左緣（80），所以是 cell 1');
  assert.deepStrictEqual(G.boundaryAt(L, x, y0), { laneIndex: 0, cell: 2 },
    'boundaryAt 用最近錨點：70 離 cell 2 的錨點（86）比離 cell 1 的錨點（46）近，所以是 cell 2');

  console.log('wave-geometry: boundaryAt 取最近、cellAt 用 floor，兩者故意不同 — OK');
}

// ---------------------------------------------------------------------------
// v3.6.0 Task 6：尺規帶把 lane 0 往下推
// ---------------------------------------------------------------------------
{
  const plain = { signal: [{ name: 'a', wave: '01' }] };
  const L1 = G.layoutOf(plain, { laneHeight: 40, cycleWidth: 20, nameColWidth: 120 });
  assert.strictEqual(L1.rulerHeight, 22, '尺規帶固定 22px');
  assert.strictEqual(L1.headTextHeight, 0, '沒有 head.text 就沒有標題帶');
  assert.strictEqual(L1.originY, 22, 'lane 0 的上緣 = 尺規帶下緣');
  assert.strictEqual(L1.lanes[0].y, 22, 'lane 0 從 originY 開始');
  assert.strictEqual(L1.height, 22 + 40, '高度含尺規帶');

  const titled = { signal: [{ name: 'a', wave: '01' }], head: { text: 'T' } };
  const L2 = G.layoutOf(titled, { laneHeight: 40, cycleWidth: 20, nameColWidth: 120 });
  assert.strictEqual(L2.headTextHeight, 20, 'head.text 佔一條 20px 的帶');
  assert.strictEqual(L2.originY, 42, '標題帶在尺規帶之上');

  const footed = { signal: [{ name: 'a', wave: '01' }], foot: { tick: 0 } };
  const L3 = G.layoutOf(footed, { laneHeight: 40, cycleWidth: 20, nameColWidth: 120 });
  assert.strictEqual(L3.footHeight, 22, 'foot 刻度佔一條帶');
  assert.strictEqual(L3.height, 22 + 40 + 22);

  // 名稱欄仍然不是格子
  assert.strictEqual(G.cellAt(L1, 10, 30), null, '名稱欄不得回傳格子');
  // 尺規帶也不是格子
  assert.strictEqual(G.cellAt(L1, 130, 5), null, '尺規帶不得回傳格子');

  console.log('wave-geometry: 尺規/標題/foot 帶進入版面 — OK');
}

// ---------------------------------------------------------------------------
// v3.6.0 Task 6 fix round 1：cellAt／boundaryAt 的垂直界線改用 originY，
// 不再是 0 —— 尺規帶／標題帶裡的一按必須是 null，不能落回 lane 0。
// ---------------------------------------------------------------------------
{
  const doc = { signal: [{ name: 'a', wave: '01' }, { name: 'b', wave: '01' }] };
  const opts = { laneHeight: 40, cycleWidth: 20, nameColWidth: 60 };
  const L = G.layoutOf(doc, opts);   // originY 22（無 head），lane0 y=[22,62)

  // 尺規帶正中央：x 落在合法的 cycle 欄位上，但 y 在 originY 之前
  assert.strictEqual(G.cellAt(L, 70, 10), null, '尺規帶（y<originY）不得回傳格子');
  assert.strictEqual(G.boundaryAt(L, 70, 10), null, 'boundaryAt 同理：尺規帶不是任何 cell 的邊界');

  // originY 本身的那一刀：originY-0.001 還在尺規帶，originY 已經是 lane 0
  assert.strictEqual(G.cellAt(L, 70, L.originY - 0.001), null, 'originY 的最後一畫素仍是尺規帶');
  assert.deepStrictEqual(G.cellAt(L, 70, L.originY), { laneIndex: 0, cycle: 0 },
    'originY 本身屬於 lane 0（跟格子左緣屬於自己同一條規則）');

  // 帶標題帶的文件：originY 42，lane 0 的上緣也跟著往下推
  const titledDoc = { signal: [{ name: 'a', wave: '01' }], head: { text: 'T' } };
  const LT = G.layoutOf(titledDoc, opts);
  assert.strictEqual(G.cellAt(LT, 70, 30), null, '標題帶（22~42 之間）也不是格子');
  assert.deepStrictEqual(G.cellAt(LT, 70, LT.originY), { laneIndex: 0, cycle: 0 });

  console.log('wave-geometry: cellAt／boundaryAt 的垂直界線改用 originY — OK');
}

console.log('wave-geometry.test.js OK');
