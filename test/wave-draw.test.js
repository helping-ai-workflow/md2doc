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

console.log('wave-draw.test.js OK');
