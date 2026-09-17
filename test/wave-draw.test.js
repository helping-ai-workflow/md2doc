'use strict';
const assert = require('assert');
const G = require('../lib/editor/wave-geometry.js');
const codec = require('../lib/editor/wave-codec.js');
const D = require('../lib/editor/wave-draw.js');

// This layer only produces strings and node descriptions, not pixels, so a
// fake `document` that just records what was asked for is enough — no
// browser needed, matching every other test in this file.
function fakeDoc() {
  return {
    createElementNS: function (ns, tag) {
      return {
        ns: ns, tag: tag, attrs: {}, children: [],
        setAttribute: function (k, v) { this.attrs[k] = String(v); },
        getAttribute: function (k) { return this.attrs[k]; },
        appendChild: function (c) { this.children.push(c); return c; },
        // v3.6.0 Task 8: `renderCanvas` (unlike the per-lane helpers this
        // file already exercised) wires up a real event listener on the
        // canvas it returns — needed once the new test below calls
        // `renderCanvas` itself rather than `drawLane`/`renderEdges` in
        // isolation.
        addEventListener: function () {},
      };
    },
    // `drawNames` builds its label text the same way `renderEdges`'s own
    // `.ed-wave-edge-label` does elsewhere in this file: a plain text node
    // child, not `.textContent`, so the walk below can read `t.children[0].text`.
    createTextNode: function (text) { return { text: text }; },
  };
}

/**
 * A minimal but complete `state` for `renderCanvas` — the brief's own
 * snippet passes `{}`, which crashes before reaching any assertion:
 * `renderCanvas` unconditionally reads `state.dataEdit`, `state.canvasWrap`,
 * `state.overlay` and calls `canvas.addEventListener`, none of which exist on
 * `{}`. MEASURED by running the brief's literal call first — it throws
 * `Cannot read properties of undefined (reading 'retire')` before the `clk`
 * assertion is ever reached, which is not the RED this task's Step 2 expects.
 * This fixture supplies just enough state for `renderCanvas` to complete a
 * paint with no cursor, no selection and no in-flight drag — the same "quiet"
 * state `render()` starts from in `wave-ui.js`.
 */
function fakeCanvasState() {
  return {
    dataEdit: null,
    cursor: null,
    selection: null,
    canvasWrap: { textContent: '', appendChild: function () {} },
    overlay: { setAttribute: function () {} },
    onCanvasDown: function () {},
    endpointDrag: null,
    pendingFrom: null,
  };
}

function makeDrawer() {
  return D.createDrawer({
    d: fakeDoc(),
    geometry: G,
    codec: codec,
    SIZES: { laneHeight: 34, cycleWidth: 48, nameColWidth: 120 },
    SVGNS: 'http://www.w3.org/2000/svg',
    BRUSHES: ['0', '1', 'x', 'z', 'p', 'n', 'P', 'N', 'h', 'l', 'u', 'd',
      '=', '2', '3', '4', '5', '6', '7', '8', '9', '|'],
    labelsOf: function () { return []; },
  });
}

// ---------------------------------------------------------------------------
// v3.6.0 Task 7 fix round 1 (ruling R23): every level transition draws a
// ramp, `|` and same-level runs draw a flat line, and the ramp's end is
// `SKIN_METRICS.slewEndRatio` directly — repinned to the measured 0.225 (was
// wrongly 0.15) in `wave-geometry.js`, so `brickPath` below now reads it
// straight off `SKIN_METRICS` instead of recomputing it.
//
// MEASURED against `node_modules/wavedrom` 3.5.0 (`waveSkin.default`), dumped
// directly in node rather than recalled: the SAME-level blip `0m0` is
// `m0,20 3,0 3,-10 3,10 11,0` (a down-and-back-up notch peaking at local
// x=6 = 20-10 half height), which is what `wave-geometry.js`'s
// `SKIN_METRICS` comment and `wave-geometry.test.js` originally (wrongly)
// measured `slewEndRatio` from. That brick never changes level, so it is
// not a transition at all — the brief for this task explicitly warns not
// to copy its shape.
//
// The bricks that actually change level are different:
//   0m1 (0->1): `M0,20 3,20 9,0 20,0`            -> (0,20)(3,20)(9,0)(20,0)
//   1m0 (1->0): `m0,0 3,0 6,20 11,0` (relative)  -> (0,0)(3,0)(9,20)(20,20)
// Both put the diagonal segment from local x=3 to local x=9 out of a
// 40-wide cycle — `slewStartRatio` (0.075) to `slewEndRatio` (0.225).
// Cross-checked against a real node/edge render
// (`{signal:[{wave:'0.1.0...',node:'a.b.c...'}],edge:['a-b']}`): the
// engine's own `gmark_a_b` endpoints sit at `cycle*40 + 6`, i.e. exactly the
// ramp's MIDPOINT ((3+9)/2 = 6), not its top — `anchorRatio` (0.15) is that
// midpoint, `(slewStartRatio + slewEndRatio) / 2`, and is a genuinely
// different quantity from "where the visual ramp finishes" despite the two
// having shared a value (0.15) before this fix. See `wave-geometry.js`'s
// `SKIN_METRICS` comment for the full derivation.
{
  const drawer = makeDrawer();
  const W = 40;
  const H = 20;
  const s = G.SKIN_METRICS;
  const rampStart = s.slewStartRatio * W; // 3
  const rampEnd = s.slewEndRatio * W; // 9, since R23 repinned slewEndRatio to 0.225

  // 0 -> 1: flat at the old level until rampStart, ramp to rampEnd, then
  // flat at the new level.
  const rise = drawer.brickPath('1', '0', W, H);
  assert.ok(rise.indexOf(String(rampStart)) !== -1,
    '上升沿的斜坡起點必須是 slewStartRatio × 寬：' + rise);
  assert.ok(rise.indexOf(String(rampEnd)) !== -1,
    '上升沿的斜坡終點必須是 slewEndRatio × 寬（R23 已重新量成 0.225）：' + rise);
  assert.strictEqual(rise.indexOf('6'), -1,
    '斜坡終點不得停在 anchorRatio(0.15 -> local 6)，那是錨點的中點落點，不是磚的終點：' + rise);

  // 1 -> 0 mirrors 0 -> 1.
  const fall = drawer.brickPath('0', '1', W, H);
  assert.ok(fall.indexOf(String(rampStart)) !== -1, '下降沿也要有斜坡起點：' + fall);
  assert.ok(fall.indexOf(String(rampEnd)) !== -1, '下降沿也要有斜坡終點：' + fall);

  // Same level (any brick that maps to the same y): flat line only.
  const flat = drawer.brickPath('1', '1', W, H);
  assert.strictEqual(flat.indexOf(String(rampStart)), -1, '同電位不得有斜坡：' + flat);

  // `|` is a gap, not a transition — brickPath must refuse to ramp it even
  // if handed a real previous level.
  const gap = drawer.brickPath('|', '0', W, H);
  assert.strictEqual(gap.indexOf(String(rampStart)), -1, 'gap 不得畫斜坡：' + gap);

  // The very first cell of a lane has no previous level.
  const first = drawer.brickPath('0', null, W, H);
  assert.strictEqual(first.indexOf(String(rampStart)), -1,
    '沒有前一格（lane 的第一格）不得畫斜坡：' + first);

  console.log('wave-draw: brickPath 的斜坡比例跟真的變態磚（0m1/1m0）量測一致 — OK');
}

// ---------------------------------------------------------------------------
// v3.6.0 Task 7 fix round 2 (ruling R24): `drawLane` must actually CALL
// `brickPath` for a real level change, positioned at the cell that changed
// (not the cell before it) — a `<path class="ed-wave-edge">`, not the old
// vertical `<line class="ed-wave-edge">`. But ONLY for `000`<->`111`: bus,
// `xxx` and clock stay out of scope as before, and `zzz`/`uuu`/`ddd` are
// ALSO excluded now (R24) — `isRampPair` is an allow-list of the one pair
// actually measured to be a straight ramp, not a deny-list that silently
// opts every other brick into that same shape by default.
// ---------------------------------------------------------------------------
{
  const drawer = makeDrawer();
  const sizes = { laneHeight: 34, cycleWidth: 48, nameColWidth: 120 };

  // -- rising edge: 0 -> 1 ---------------------------------------------------
  const doc1 = { signal: [{ name: 'a', wave: '01' }] };
  const layout1 = G.layoutOf(doc1, sizes);
  const svg1 = fakeDoc().createElementNS('svg', 'svg');
  drawer.drawLane(svg1, layout1, 0);

  const edges1 = svg1.children.filter(function (c) { return c.attrs.class === 'ed-wave-edge'; });
  assert.strictEqual(edges1.length, 1, '0->1 只有一個轉態邊界：' + JSON.stringify(edges1.map(function (e) { return e.tag; })));
  assert.strictEqual(edges1[0].tag, 'path',
    '真的電位轉態必須畫成 path（斜坡），不是 line（垂直瞬變）：' + JSON.stringify(edges1[0]));

  const row1 = layout1.lanes[0];
  const hi = row1.y + 7;
  const lo = row1.y + row1.height - 9;
  const cw = row1.cycleWidth;
  const x0 = row1.originX + 1 * cw; // cycle 1 is where the value becomes '1'
  const s = G.SKIN_METRICS;
  const rampStartAbs = x0 + s.slewStartRatio * cw;
  const rampEndAbs = x0 + s.slewEndRatio * cw;
  const d1 = edges1[0].attrs.d;
  assert.ok(d1.indexOf(String(rampStartAbs)) !== -1,
    '斜坡起點必須落在新 run（cycle 1）自己的 originX 上，不是畫布原點：' + d1);
  assert.ok(d1.indexOf(String(rampEndAbs)) !== -1,
    '斜坡終點也必須落在新 run 的座標系裡：' + d1);
  assert.ok(d1.indexOf(String(hi)) !== -1 && d1.indexOf(String(lo)) !== -1,
    '斜坡必須真的連接 hi 跟 lo 這兩個電位高度：' + d1);

  // -- bus boundary keeps the old vertical edge -----------------------------
  const doc2 = { signal: [{ name: 'b', wave: '0=' }] };
  const layout2 = G.layoutOf(doc2, sizes);
  const svg2 = fakeDoc().createElementNS('svg', 'svg');
  drawer.drawLane(svg2, layout2, 0);
  const edges2 = svg2.children.filter(function (c) { return c.attrs.class === 'ed-wave-edge'; });
  assert.strictEqual(edges2.length, 1, '0->bus 也只有一個邊界：' + JSON.stringify(edges2));
  assert.strictEqual(edges2[0].tag, 'line',
    'bus 邊界不在這個 task 的範圍內，必須維持原本的垂直 line：' + JSON.stringify(edges2[0]));

  // -- R24: z/u/d boundaries keep the old vertical edge too ------------------
  //
  // Each case names the real engine brick that makes "no ramp, for now" the
  // honest answer — MEASURED against `node_modules/wavedrom` 3.5.0's
  // `waveSkin`, dumped directly, not recalled.
  function assertNoRamp(wave, why) {
    const doc = { signal: [{ name: 'x', wave: wave }] };
    const layout = G.layoutOf(doc, sizes);
    const svg = fakeDoc().createElementNS('svg', 'svg');
    drawer.drawLane(svg, layout, 0);
    const edges = svg.children.filter(function (c) { return c.attrs.class === 'ed-wave-edge'; });
    assert.strictEqual(edges.length, 1, wave + ' 只有一個邊界：' + JSON.stringify(edges));
    assert.strictEqual(edges[0].tag, 'line',
      wave + ' 還不得畫斜坡（' + why + '）：' + JSON.stringify(edges[0]));
  }

  // 0->z: engine brick `0mz` is "m0,20 3,0 C 10,10 15,10 20,10" — a CURVE
  // that only reaches mid-height at x=20 (ratio 0.5), not our straight
  // 3-to-9 ramp.
  assertNoRamp('0z', '0mz 是曲線，到 ratio 0.5 才到中電位');

  // z->1: engine brick `zm1` is "M0,10 6,10 9,0 20,0" — the ramp starts at
  // x=6 (ratio 0.15), not x=3 (ratio 0.075) like `0m1`.
  assertNoRamp('z1', 'zm1 的斜坡從 x=6 開始，不是 x=3');

  // 0->u: engine brick `0mu` is "m0,20 3,0 C 7,10 10.107603,0 20,0" — a
  // curve, not a straight line.
  assertNoRamp('0u', '0mu 是曲線');

  // 1->d: engine brick `1md` is "m0,0 3,0 c 4,10 7,20 17,20" — a curve that
  // does not reach the low level until the very end of the cell (x=20).
  // (The reverse direction, d->1, happens to use `dm1` = "M0,20 3,20 9,0
  // 20,0" — identical to `0m1`, a straight ramp, by the same y-coincidence
  // as `um0` above — but `isRampPair` checks brick NAMES, not directions,
  // so both directions of every `z`/`u`/`d` pair are excluded uniformly.)
  assertNoRamp('1d', '1md 是曲線，直到格尾才到低電位');

  console.log('wave-draw: drawLane 只在真的電位轉態呼叫 brickPath，bus/z/u/d 邊界維持原狀 — OK');
}

// ---------------------------------------------------------------------------
// v3.6.0 Task 8：畫布自己畫得出 lane 名稱
// ---------------------------------------------------------------------------
{
  const drawer = makeDrawer();
  const doc = { signal: [
    { name: 'clk', wave: '01' },
    ['read path', { name: 'rd_en', wave: '01' }],
  ] };
  const L = G.layoutOf(doc, { laneHeight: 34, cycleWidth: 48, nameColWidth: 120 });
  const svg = fakeDoc().createElementNS('http://www.w3.org/2000/svg', 'svg');
  // `renderCanvas` REPLACES the canvas it is handed — it builds and returns
  // a brand new `<svg>` rather than mutating `svg` in place (see its own
  // "v3.5.0 Task 11" comment) — so the walk below has to read the RETURN
  // VALUE, not the `svg` that was passed in.
  const rendered = drawer.renderCanvas(svg, doc, L, fakeCanvasState());

  const texts = [];
  (function walk(n) {
    if (n.tag === 'text') texts.push(n);
    (n.children || []).forEach(walk);
  })(rendered);

  const names = texts.map(function (t) {
    return (t.children[0] && t.children[0].text) || t.text || '';
  });
  assert.ok(names.indexOf('clk') !== -1, '畫布上必須有 clk：' + JSON.stringify(names));
  assert.ok(names.indexOf('rd_en') !== -1, '畫布上必須有 rd_en');
  assert.ok(names.indexOf('read path') !== -1, '群組名也要在畫布上');

  // 名稱靠右對齊，右緣留 nameGap = 10
  const clk = texts.find(function (t) {
    return ((t.children[0] && t.children[0].text) || t.text) === 'clk';
  });
  assert.strictEqual(clk.attrs['text-anchor'], 'end', '名稱靠右對齊');
  assert.strictEqual(Number(clk.attrs.x), 120 - 10, '右緣留 10px 的 nameGap');

  console.log('wave-draw: 畫布自己畫出 lane 與群組名稱 — OK');
}

// ---------------------------------------------------------------------------
// v3.6.0 Task 9：8 個 banner 欄位都畫得出來
// ---------------------------------------------------------------------------
{
  const drawer = makeDrawer();
  const doc = {
    signal: [{ name: 'a', wave: '0101' }],
    head: { text: 'title', tick: 0 },
    foot: { tock: 5, every: 2 },
  };
  const L = G.layoutOf(doc, { laneHeight: 34, cycleWidth: 48, nameColWidth: 120 });
  const svg = fakeDoc().createElementNS('http://www.w3.org/2000/svg', 'svg');
  // The brief's own snippet passes `{}` for state, which `renderCanvas` (see
  // Task 8's own fixture above) crashes on before any assertion is reached —
  // same fix, `fakeCanvasState()` instead of `{}`.
  const rendered = drawer.renderCanvas(svg, doc, L, fakeCanvasState());

  const byClass = {};
  (function walk(n) {
    const c = n.attrs && n.attrs.class;
    if (c) { byClass[c] = byClass[c] || []; byClass[c].push(n); }
    (n.children || []).forEach(walk);
  })(rendered);

  assert.strictEqual((byClass['ed-wave-head-text'] || []).length, 1, 'head.text 一個');
  // tick 落在邊界，cycleCount + 1 個
  assert.strictEqual((byClass['ed-wave-ruler-tick'] || []).length, 5,
    'head.tick 是 cycles + 1 個邊界刻度');
  // foot.tock 落在格中心，every 2 → 每兩格一個
  assert.strictEqual((byClass['ed-wave-ruler-tock'] || []).length, 2,
    'foot.tock 配 every=2 → 4 格畫 2 個');

  // 邊界刻度的 x 必須在 cell 左緣，不是中心
  const t0 = byClass['ed-wave-ruler-tick'][0];
  assert.strictEqual(Number(t0.attrs.x), G.cellRect(L, 0, 0).x, 'tick 對齊邊界');

  console.log('wave-draw: 尺規的 tick/tock/every 與 head/foot 文字 — OK');
}

// ---------------------------------------------------------------------------
// v3.6.0 Task 9 fix round 1: `every` 錨在 (index + base)，不是裸 index
//
// MEASURED against `node_modules/wavedrom` 3.5.0's `render-marks.js`
// `ticktock()`: the filter is `(i + offset) % cxt[ref1].every`, where
// `offset` is the SAME base the label values themselves are built from
// (`Number(val)` off `head.tick`/`head.tock`) — not a bare `i % every`. Live
// render, `{signal:[{name:'a',wave:'0101'}],head:{tick:3,every:2}}`, dumped
// `gmarks_0`: only two `<text>` nodes survive, `"4"` at x=40 and `"6"` at
// x=120 (i.e. i=1 and i=3 — `(1+3)%2===0`, `(3+3)%2===0`; i=0,2,4 all drop,
// `(0+3)%2===1` etc). A `c % every` implementation keeps i=0,2,4 instead —
// three ticks, values 3/5/7, not two ticks, values 4/6 — same COUNT as this
// fixture's `tock` case above happens to hide (every=2 splits either
// parity into exactly half when `len` is a multiple of `every`), but a
// different actual answer, which is why this needs its own case pinned on
// VALUES, not just a count.
// ---------------------------------------------------------------------------
{
  const drawer = makeDrawer();
  const doc = {
    signal: [{ name: 'a', wave: '0101' }],
    head: { tick: 3, every: 2 },
  };
  const L = G.layoutOf(doc, { laneHeight: 34, cycleWidth: 48, nameColWidth: 120 });
  const svg = fakeDoc().createElementNS('http://www.w3.org/2000/svg', 'svg');
  const rendered = drawer.renderCanvas(svg, doc, L, fakeCanvasState());

  const ticks = [];
  (function walk(n) {
    if (n.attrs && n.attrs.class === 'ed-wave-ruler-tick') ticks.push(n);
    (n.children || []).forEach(walk);
  })(rendered);

  const values = ticks.map(function (t) {
    return (t.children[0] && t.children[0].text) || '';
  });
  assert.deepStrictEqual(values, ['4', '6'],
    'every 要錨在 (index+base)，跟引擎的 gmarks_0 量到的一致：' + JSON.stringify(values));

  console.log('wave-draw: every 錨在 (index+base)，不是裸 index — OK');
}

// ---------------------------------------------------------------------------
// v3.6.0 Task 9 fix round 1（R29）：foot.text 與 foot.tick 同時存在時，
// 兩者不准疊在同一個 y —— 修之前兩者共用同一條 footHeight 帶，這裡直接
// 斷言兩條帶的 y 不相等，並且 tick 帶比較靠近 lane（比 text 帶的 y 小）。
// ---------------------------------------------------------------------------
{
  const drawer = makeDrawer();
  const doc = {
    signal: [{ name: 'a', wave: '0101' }],
    foot: { text: 'footer', tick: 0 },
  };
  const L = G.layoutOf(doc, { laneHeight: 34, cycleWidth: 48, nameColWidth: 120 });
  assert.strictEqual(L.footTextHeight, 20, '版面必須疊出第二條 foot 帶（R29）');

  const svg = fakeDoc().createElementNS('http://www.w3.org/2000/svg', 'svg');
  const rendered = drawer.renderCanvas(svg, doc, L, fakeCanvasState());

  const byClass = {};
  (function walk(n) {
    const c = n.attrs && n.attrs.class;
    if (c) { byClass[c] = byClass[c] || []; byClass[c].push(n); }
    (n.children || []).forEach(walk);
  })(rendered);

  const footText = (byClass['ed-wave-foot-text'] || [])[0];
  const footTick = (byClass['ed-wave-ruler-tick'] || [])[0];
  assert.ok(footText !== undefined, 'foot.text 必須畫出來');
  assert.ok(footTick !== undefined, 'foot.tick 必須畫出來');
  assert.notStrictEqual(Number(footText.attrs.y), Number(footTick.attrs.y),
    'foot.text 跟 foot.tick 不准疊在同一個 y（R29 之前的缺陷）：' +
    JSON.stringify({ text: footText.attrs.y, tick: footTick.attrs.y }));
  // 帶的疊法是鏡射 head：tick 帶貼著 lane，text 帶在更外側 —— foot 是往下
  // 疊，所以 tick 的 y 必須比 text 的 y 小（更靠近 lane）。
  assert.ok(Number(footTick.attrs.y) < Number(footText.attrs.y),
    'foot 的 tick 帶必須比 text 帶更靠近 lane（y 更小）');

  console.log('wave-draw: foot.text 與 foot.tick 疊成兩條獨立的帶（R29）— OK');
}

// ---------------------------------------------------------------------------
// v3.6.0 Task 9 fix round 2（ruling R30）：尺規跟 grid 的刻度數/間距是
// DIAGRAM 的，不是任何一條 lane 的，也不是 cell 數。
//
// MEASURED against `node_modules/wavedrom` 3.5.0 —— coordinator 給的兩個
// fixture（`period: 4` / `hscale: 2, period: 1`），逐值核對：
//
//   period: 4   引擎：17 個刻度，值 0..16，間距 40px，svg 寬 700
//   hscale: 2   引擎：5 個刻度（跟修之前一樣的數量——這正是「數量相同、
//               間距不同」的那個反例，只算數量的斷言抓不到）
//
// 這裡不斷言引擎自己的像素（那組尺寸是引擎預設值，不是我們的 SIZES），而是
// 用同一顆 fixture 餵我們自己的 layoutOf/renderCanvas，斷言「值」跟「x 間距
// 是同一個 diagramPitch」——結構跟引擎一致，數字換算成我們自己的
// nameColWidth=120／cycleWidth=48 尺寸。
//
// RED 用暫時還原＋重跑驗過（round 2 修正前）：
//   period:4  舊碼畫 5 個刻度（0..4），x 間距 192（lane 0 自己的
//             cycleWidth，被 period 拉寬），grid 也只有 5 條、x 間距 48
//             （對，但條數錯——這是 CLAUDE.md 記過的「cell 當 cycle 用」）。
//   hscale:2  舊碼的 ruler 剛好是對的（lane 0 的 cycleWidth 已經乘了
//             hscale，period=1 時不會被 period 拉開），但 grid 仍然錯——
//             x 間距是沒乘 hscale 的 48，不是 96，條數剛好一樣（5），純粹
//             間距錯，數量抓不到。
// ---------------------------------------------------------------------------
{
  const drawer = makeDrawer();
  const doc = { signal: [{ name: 'a', wave: '0101', period: 4 }], head: { tick: 0 } };
  const L = G.layoutOf(doc, { laneHeight: 34, cycleWidth: 48, nameColWidth: 120 });
  assert.strictEqual(L.width, 888, '前提：period 4 把 width 拉成 888（跟 coordinator 量的一致）');

  const svg = fakeDoc().createElementNS('http://www.w3.org/2000/svg', 'svg');
  const rendered = drawer.renderCanvas(svg, doc, L, fakeCanvasState());

  const ticks = [];
  const grids = [];
  (function walk(n) {
    if (n.attrs && n.attrs.class === 'ed-wave-ruler-tick') ticks.push(n);
    if (n.tag === 'line' && n.attrs && n.attrs.class === 'ed-wave-grid') grids.push(n);
    (n.children || []).forEach(walk);
  })(rendered);

  const values = ticks.map(function (t) { return t.children[0].text; });
  const expectedValues = [];
  for (let i = 0; i <= 16; i += 1) expectedValues.push(String(i));
  assert.deepStrictEqual(values, expectedValues,
    'period:4 必須是 17 個刻度、值 0..16（引擎量到 17，不是 layout.cycles+1 的 5）：' +
    JSON.stringify(values));

  const xs = ticks.map(function (t) { return Number(t.attrs.x); });
  const expectedXs = [];
  for (let i = 0; i <= 16; i += 1) expectedXs.push(120 + i * 48);
  assert.deepStrictEqual(xs, expectedXs,
    'period:4 的刻度間距必須是 diagram pitch（48），不是 lane 0 自己的 cycleWidth（192）：' +
    JSON.stringify(xs));

  assert.strictEqual(grids.length, 17, 'grid 線也要用同一個 diagram 邊界數（17），不是 layout.cycles+1（5）');
  const gridXs = grids.map(function (g) { return Number(g.attrs.x1); });
  assert.deepStrictEqual(gridXs, expectedXs,
    'grid 線的 x 也必須是同一個 diagramPitch（48）派生出來的，跟尺規共用一份算式');

  console.log('wave-draw: period 讓尺規跟 grid 都用 diagram cycle 數，不是 cell 數（R30）— OK');
}

{
  const drawer = makeDrawer();
  const doc = {
    signal: [{ name: 'a', wave: '0101' }],
    head: { tick: 0 },
    config: { hscale: 2 },
  };
  const L = G.layoutOf(doc, { laneHeight: 34, cycleWidth: 48, nameColWidth: 120 });
  assert.strictEqual(L.width, 504, '前提：hscale 2 把 width 拉成 504（跟 coordinator 量的一致）');

  const svg = fakeDoc().createElementNS('http://www.w3.org/2000/svg', 'svg');
  const rendered = drawer.renderCanvas(svg, doc, L, fakeCanvasState());

  const ticks = [];
  const grids = [];
  (function walk(n) {
    if (n.attrs && n.attrs.class === 'ed-wave-ruler-tick') ticks.push(n);
    if (n.tag === 'line' && n.attrs && n.attrs.class === 'ed-wave-grid') grids.push(n);
    (n.children || []).forEach(walk);
  })(rendered);

  const values = ticks.map(function (t) { return t.children[0].text; });
  assert.deepStrictEqual(values, ['0', '1', '2', '3', '4'],
    'hscale:2 是 5 個刻度（跟舊碼「碰巧」畫出的數量一樣，這條只釘數量不夠）：' +
    JSON.stringify(values));

  const xs = ticks.map(function (t) { return Number(t.attrs.x); });
  assert.deepStrictEqual(xs, [120, 216, 312, 408, 504],
    'hscale:2 的刻度間距必須是 96（cycleWidth 48 × hscale 2），這條 ruler 舊碼本來就對，' +
    '但下面的 grid 斷言是這個 fixture 真正的 RED：' + JSON.stringify(xs));

  // 這才是這個 fixture 真正抓到的迴歸：grid 舊碼沒乘 hscale，間距停在 48
  // （x 只到 312），跟 ticks 對不上。
  assert.strictEqual(grids.length, 5, 'grid 線數量（5）不是這個 fixture 的問題所在');
  const gridXs = grids.map(function (g) { return Number(g.attrs.x1); });
  assert.deepStrictEqual(gridXs, [120, 216, 312, 408, 504],
    'grid 線的間距必須也乘 hscale（96），不是沒乘 hscale 的 48：' + JSON.stringify(gridXs));

  console.log('wave-draw: hscale 讓 grid 跟尺規共用同一個乘了 hscale 的 pitch（R30）— OK');
}

// ---------------------------------------------------------------------------
// v3.6.0 Task 10：電位圖示重用 brick 繪製，不是第二套實作
//
// `BRUSHES` 是 22 個（brief 的 roster，跟 wave-ui.js 自己的常數與
// wave-codec.test.js 的 isBrushKey 斷言同一份字面值）。每個都要有圖示，
// 而且圖示的線條必須來自跟畫布同一批函式 —— 不是為了工具列另外手畫一套。
// ---------------------------------------------------------------------------
{
  const drawer = makeDrawer();
  const BRUSHES = ['0', '1', 'x', 'z', 'p', 'n', 'P', 'N', 'h', 'l', 'u', 'd',
    '=', '2', '3', '4', '5', '6', '7', '8', '9', '|'];
  assert.strictEqual(BRUSHES.length, 22, '筆刷 roster 是 22 個');

  function collectTag(node, tag) {
    const out = [];
    (function walk(n) {
      if (n.tag === tag) out.push(n);
      (n.children || []).forEach(walk);
    })(node);
    return out;
  }

  for (const ch of BRUSHES) {
    const icon = drawer.levelIcon(ch);
    assert.ok(icon !== null && icon.tag === 'svg', ch + ' 必須有圖示');
    assert.strictEqual(icon.attrs.width, '24', ch + ' 寬度必須是 24');
    assert.strictEqual(icon.attrs.height, '16', ch + ' 高度必須是 16');
    const paths = collectTag(icon, 'path');
    assert.ok(paths.length > 0, ch + ' 的圖示必須含至少一個 path');
  }

  // 圖示的 path 必須跟 brickPath 同一個來源：'1' 的平坦圖示應等於
  // brickPath('1','1',24,16) 的形狀 —— brief Step 1 原文釘住的那一條。
  {
    const icon = drawer.levelIcon('1');
    const paths = collectTag(icon, 'path');
    assert.strictEqual(paths[0].attrs.d, drawer.brickPath('1', '1', 24, 16),
      '\'1\' 的圖示必須重用 brickPath，不得另寫一套');
  }

  // `u`/`d` 是這個 task 真正的地雷（brief item 4/5）：brickPath 自己的
  // yFor 只認得 000/111 的兩個端點字元，'u'/'d' 原封不動丟進去會落在
  // yFor 的預設分支（mid），跟畫布上 bandOf 把 uuu 畫在 hi、ddd 畫在 lo
  // 不一致 —— 圖示必須是「跟畫布同一個高度」，不是 brickPath 對生字元的
  // 巧合結果。所以這裡直接釘住：'u' 的圖示必須等於 brickPath('1','1',…)
  // （跟 bandOf('uuu') === [hi,hi] 同一個高度），'d' 必須等於
  // brickPath('0','0',…)（跟 bandOf('ddd') === [lo,lo] 同一個高度）。
  {
    const uIcon = drawer.levelIcon('u');
    const uPaths = collectTag(uIcon, 'path');
    assert.strictEqual(uPaths[0].attrs.d, drawer.brickPath('1', '1', 24, 16),
      'u 的圖示高度必須跟畫布的 bandOf(uuu)=hi 一致，不是 yFor 的預設 mid：' +
      JSON.stringify(uPaths[0].attrs.d));
    assert.strictEqual(uPaths[0].attrs.class.indexOf('ed-wave-weak') !== -1, true,
      'u 在畫布上是虛線（ed-wave-weak），圖示要跟畫布一致');

    const dIcon = drawer.levelIcon('d');
    const dPaths = collectTag(dIcon, 'path');
    assert.strictEqual(dPaths[0].attrs.d, drawer.brickPath('0', '0', 24, 16),
      'd 的圖示高度必須跟畫布的 bandOf(ddd)=lo 一致，不是 yFor 的預設 mid：' +
      JSON.stringify(dPaths[0].attrs.d));
  }

  // bus（'='、'2'-'9'）不是平線 —— 圖示必須帶跟畫布相同的 bus class（六邊形
  // 的來源跟畫布共用），才不會淪為「看起來像平線」的地雷（brief item 6）。
  {
    for (const ch of ['=', '2', '3', '4', '5', '6', '7', '8', '9']) {
      const icon = drawer.levelIcon(ch);
      const busShapes = collectTag(icon, 'path').filter(function (p) {
        return typeof p.attrs.class === 'string' && p.attrs.class.indexOf('ed-wave-bus') !== -1;
      });
      assert.ok(busShapes.length > 0, ch + ' 的圖示必須有 ed-wave-bus 形狀，不是平線');
    }
  }

  // xxx 也不是平線 —— 圖示必須帶 ed-wave-x。
  {
    const icon = drawer.levelIcon('x');
    const xShapes = collectTag(icon, 'path').filter(function (p) {
      return typeof p.attrs.class === 'string' && p.attrs.class.indexOf('ed-wave-x') !== -1;
    });
    assert.ok(xShapes.length > 0, 'x 的圖示必須有 ed-wave-x 形狀，不是平線');
  }

  // clock（p/P/n/N）是方波，不是平線；P/N 額外帶箭頭，p/n 不帶。
  {
    for (const ch of ['p', 'n', 'P', 'N']) {
      const icon = drawer.levelIcon(ch);
      const clockShapes = collectTag(icon, 'path').filter(function (p) {
        return typeof p.attrs.class === 'string' && p.attrs.class.indexOf('ed-wave-clock') !== -1 &&
          p.attrs.class.indexOf('ed-wave-clock-arrow') === -1;
      });
      assert.ok(clockShapes.length > 0, ch + ' 的圖示必須有方波（ed-wave-clock）');
      const arrowShapes = collectTag(icon, 'path').filter(function (p) {
        return typeof p.attrs.class === 'string' && p.attrs.class.indexOf('ed-wave-clock-arrow') !== -1;
      });
      if (ch === 'P' || ch === 'N') {
        assert.ok(arrowShapes.length > 0, ch + ' 是明示邊沿，圖示必須帶箭頭');
      } else {
        assert.strictEqual(arrowShapes.length, 0, ch + ' 不是明示邊沿，圖示不得帶箭頭');
      }
    }
  }

  // `|`（gap）也帶自己的雙箭頭記號，不是平線。
  {
    const icon = drawer.levelIcon('|');
    const gapShapes = collectTag(icon, 'path').filter(function (p) {
      return typeof p.attrs.class === 'string' && p.attrs.class.indexOf('ed-wave-gap') !== -1;
    });
    assert.ok(gapShapes.length > 0, '| 的圖示必須有 ed-wave-gap 形狀');
  }

  console.log('wave-draw: 22 個電位圖示全部由畫布的同一批繪製函式產生 — OK');
}

// ---------------------------------------------------------------------------
// v3.6.0 Task 11：武裝時才畫轉態標記，且標記落在錨點上
// ---------------------------------------------------------------------------
{
  const drawer = makeDrawer();
  const doc = { signal: [{ name: 'w', wave: '0.1.0...' }] };
  const L = G.layoutOf(doc, { laneHeight: 34, cycleWidth: 48, nameColWidth: 120 });

  const countMarks = function (svg) {
    let marks = 0;
    (function walk(n) {
      if (n.attrs && n.attrs.class === 'ed-wave-transition') marks += 1;
      (n.children || []).forEach(walk);
    })(svg);
    return marks;
  };

  // idle：完全不畫
  {
    const svg = fakeDoc().createElementNS('http://www.w3.org/2000/svg', 'svg');
    const state = fakeCanvasState();
    state.edgeMode = 'idle';
    const rendered = drawer.renderCanvas(svg, doc, L, state);
    assert.strictEqual(countMarks(rendered), 0, 'idle 時完全不畫轉態標記');
  }

  // 未帶 edgeMode（既有呼叫方，如 fakeCanvasState() 本身）也不畫 —— 補齊 idle
  // 之外「這個欄位根本不存在」的那一支，避免 undefined 被誤判成武裝。
  {
    const svg = fakeDoc().createElementNS('http://www.w3.org/2000/svg', 'svg');
    const rendered = drawer.renderCanvas(svg, doc, L, fakeCanvasState());
    assert.strictEqual(countMarks(rendered), 0, '沒有 edgeMode 欄位時視同 idle');
  }

  // armed：畫在 transitionsOf 回報的 cell 0/2/4，落在錨點，不是格中心
  {
    const svg = fakeDoc().createElementNS('http://www.w3.org/2000/svg', 'svg');
    const state = fakeCanvasState();
    state.edgeMode = 'armed';
    const rendered = drawer.renderCanvas(svg, doc, L, state);
    const at = [];
    (function walk(n) {
      if (n.attrs && n.attrs.class === 'ed-wave-transition') at.push(Number(n.attrs.cx));
      (n.children || []).forEach(walk);
    })(rendered);
    assert.deepStrictEqual(at, [0, 2, 4].map(function (c) {
      return G.anchorOfCell(L, 0, c).x;
    }), '標記畫在錨點上，不是格中心：' + JSON.stringify(at));
  }

  // hoverBoundary 命中的那一顆帶 data-hot、半徑變大；其餘不帶
  {
    const svg = fakeDoc().createElementNS('http://www.w3.org/2000/svg', 'svg');
    const state = fakeCanvasState();
    state.edgeMode = 'armed';
    state.hoverBoundary = { laneIndex: 0, cell: 2 };
    const rendered = drawer.renderCanvas(svg, doc, L, state);
    const dots = [];
    (function walk(n) {
      if (n.attrs && n.attrs.class === 'ed-wave-transition') dots.push(n);
      (n.children || []).forEach(walk);
    })(rendered);
    const hot = dots.filter(function (n) { return n.attrs['data-hot'] !== undefined; });
    const cold = dots.filter(function (n) { return n.attrs['data-hot'] === undefined; });
    assert.strictEqual(hot.length, 1, '恰好一顆命中 hoverBoundary 的標記帶 data-hot：' +
      JSON.stringify(dots.map(function (n) { return n.attrs; })));
    assert.strictEqual(cold.length, 2, '其餘標記不帶 data-hot');
    assert.strictEqual(Number(hot[0].attrs.cx), G.anchorOfCell(L, 0, 2).x, 'data-hot 落在 cell 2');
    assert.ok(Number(hot[0].attrs.r) > Number(cold[0].attrs.r),
      '命中的標記半徑必須比一般標記大：hot=' + hot[0].attrs.r + ' cold=' + cold[0].attrs.r);
  }

  console.log('wave-draw: 轉態標記只在武裝時出現且落在錨點上 — OK');
}

console.log('wave-draw.test.js OK');
