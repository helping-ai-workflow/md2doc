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
  let seed = 20260912;
  const rnd = function () {
    seed ^= seed << 13; seed |= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed |= 0;
    return ((seed >>> 0) % 1000000) / 1000000;
  };
  const doc = { signal: [] };
  for (let i = 0; i < 6; i++) doc.signal.push({ name: 'l' + i, wave: '01010101' });

  let cells = 0, centreMiss = 0, leftEdgeMiss = 0, topEdgeMiss = 0, nextMiss = 0, farMiss = 0;
  let firstBad = null;
  for (let t = 0; t < 200; t++) {
    const opts = {
      laneHeight: 1 + rnd() * 40,
      cycleWidth: 1 + rnd() * 40,
      nameColWidth: 1 + rnd() * 40,
    };
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
  assert.strictEqual(over.height, 1024 * over.laneHeight);
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
    assert.deepStrictEqual(G.cellAt(L, 60, 0), { laneIndex: 0, cycle: 0 },
      '空文件也要有一個座標可以放第一拍');
    assert.deepStrictEqual(G.cellRect(L, 0, 0), { x: 60, y: 0, width: 20, height: 40 });
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
{
  const L = G.layoutOf(FLAT, { laneHeight: 40, cycleWidth: 20, nameColWidth: 0 });
  const hit = G.cellAt(L, -0, -0);
  assert.deepStrictEqual(hit, { laneIndex: 0, cycle: 0 });
  assert.strictEqual(Object.is(hit.laneIndex, -0), false, 'laneIndex 不准是 -0');
  assert.strictEqual(Object.is(hit.cycle, -0), false, 'cycle 不准是 -0');
  const hit2 = G.cellAt(G.layoutOf(FLAT, { laneHeight: 40, cycleWidth: 20, nameColWidth: 60 }),
    60, -0);
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

console.log('wave-geometry.test.js OK');
