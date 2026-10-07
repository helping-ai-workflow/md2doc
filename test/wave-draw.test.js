'use strict';
const assert = require('assert');
const G = require('../lib/editor/wave-geometry.js');
const D = require('../lib/editor/wave-draw.js');
// v3.6.0 final review L2: the brush roster is IMPORTED, never re-typed.
// `test/wave-codec.test.js` already set this precedent (`waveUi.BRUSHES`);
// this file carried two separate 22-entry literal copies — one in
// `makeDrawer`'s deps bag, one at the head of the icon block — guarded only
// by `assert.strictEqual(BRUSHES.length, 22, ...)`, which cannot see a
// roster whose CONTENTS diverged while its length did not.
//
// What the import buys, stated as MEASURED rather than as hoped: the icon
// block below now walks the roster production actually uses, instead of a
// transcription of it. It does NOT buy a new red, and saying it did would be
// this branch's own most-repeated defect. Flipping `lib/editor/wave-ui.js`'s
// `BRUSHES` from 'z' to 'Z' and rerunning this file prints OK — before AND
// after this change — because `levelIcon` returns an `<svg>` for ANY single
// character ('Z', 'Q' and '~' all measured), so a drifted roster cannot
// redden the icon assertions from either side.
//
// So this is a fix to the CLAIM, not to the detection power: a file whose
// own log line says 「22 個電位圖示全部由同一批 brick 繪製函式產生」 should be
// reading the roster production uses, not a copy that can quietly stop being
// it. Removing the second opinion is strictly better than adding a third
// assertion about it.
const waveUi = require('../lib/editor/wave-ui.js');
const BRUSHES = waveUi.BRUSHES;

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
      };
    },
    // Text is a plain text-node child, so a walk can read `t.children[0].text`.
    createTextNode: function (text) { return { text: text }; },
  };
}

function makeDrawer() {
  return D.createDrawer({
    d: fakeDoc(),
    geometry: G,
    SVGNS: 'http://www.w3.org/2000/svg',
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
// wave redesign Task 6b：工具列常駐 6 個電位，其餘 16 個在「更多」的分組格子
// （spec §4.2）。兩邊合起來正好是 BRUSHES，每個字元出現一次——新增一個筆刷
// 卻忘了放進任何一邊，它就從滑鼠那一側消失了（鍵盤仍可用 isBrushKey 選到）。
// ---------------------------------------------------------------------------
{
  const resident = waveUi.BRUSH_RESIDENT;
  const groups = waveUi.BRUSH_MORE;
  assert.deepStrictEqual(resident, ['0', '1', 'x', '=', '3', 'p'], '常駐順序照 spec §4.2');
  assert.deepStrictEqual(groups.map(function (g) { return g[0]; }), ['電位', '時脈', '資料', '其他']);
  const placed = resident.concat.apply(resident, groups.map(function (g) { return g[1]; }));
  assert.strictEqual(placed.length, BRUSHES.length, '每個筆刷只放一處：' + placed.join(''));
  assert.deepStrictEqual(placed.slice().sort(), BRUSHES.slice().sort(), '常駐＋更多＝BRUSHES');
  console.log('wave-draw: 常駐 6 個＋更多 16 個＝BRUSHES — OK');
}

// ---------------------------------------------------------------------------
// v3.6.0 Task 10：電位圖示重用 brick 繪製，不是第二套實作
//
// `BRUSHES` 是 22 個，而且是從 wave-ui.js `require` 進來的那一份本人，
// 不是抄寫的同一份字面值（final review L2）。每個都要有圖示，而且圖示的
// 線條必須來自同一批 brick 函式（brickPath 等）—— 不是每個圖示各寫一套。（Task 6a 起畫布由引擎畫。）
// ---------------------------------------------------------------------------
{
  const drawer = makeDrawer();
  // 數量仍然釘住：這條擋的不是「拷貝分歧」（import 之後已經不可能），
  // 而是「roster 自己被無聲改大改小」。內容的正確性由上面的 import 負責。
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

  console.log('wave-draw: 22 個電位圖示全部由同一批 brick 繪製函式產生 — OK');
}

// ---- Task 5: the interaction layer (createLayer) ----
{
  const SVGNS = 'http://www.w3.org/2000/svg';
  const layerDoc = fakeDoc();
  const layerApi = D.createLayer({ d: layerDoc, SVGNS: SVGNS });
  assert.strictEqual(typeof layerApi.paint, 'function', 'createLayer returns { paint }');
  const CW = 60, LH = 30, OX = 100, RY = 0;
  const view = {
    scale: 1.5,
    cells: [{ laneIndex: 0, cycles: 4, transitions: [1, 3] }, { laneIndex: 1, cycles: 4, transitions: [2] }],
    cellRect: function (li, c) { return { x: OX + c * CW, y: 20 + li * LH, width: CW, height: LH }; },
    anchor: function (li, c) { return { x: OX + c * CW + 5, y: 20 + li * LH + 15 }; },
    rulerY: RY, width: 400, height: 80,
  };
  const quiet = function () {
    return { hover: null, rowHover: null, selection: null, cursor: null, rulerPlus: null,
      dots: 'off', hotDot: null, pending: null, selectedEdge: null, overflow: [] };
  };
  const make = function () { return layerDoc.createElementNS(SVGNS, 'svg'); };
  const all = function (root, cls) {
    const out = [];
    (function walk(n) {
      if (n.attrs && n.attrs.class !== undefined && n.attrs.class.split(' ').indexOf(cls) !== -1) out.push(n);
      (n.children || []).forEach(walk);
    })(root);
    return out;
  };
  const num = function (n, k) { return Number(n.attrs[k]); };

  // quiet state: ruler numbers only (one per cycle), nothing interactive
  {
    const layer = make();
    layerApi.paint(layer, view, quiet());
    assert.strictEqual(all(layer, 'ed-wave-ruler-num').length, 4, 'one ruler number per cycle');
    assert.strictEqual(all(layer, 'ed-wave-ruler-num').map(function (n) { return n.children[0].text; }).join(','), '0,1,2,3');
    ['ed-wave-hover-col', 'ed-wave-row-hover', 'ed-wave-selection', 'ed-wave-cursor', 'ed-wave-dot',
      'ed-wave-pending', 'ed-wave-edge-sel', 'ed-wave-edge-end', 'ed-wave-overflow', 'ed-wave-ruler-plus'].forEach(function (c) {
      assert.strictEqual(all(layer, c).length, 0, 'quiet state draws no ' + c);
    });
    // idempotent: painting again replaces children
    const before = layer.children.length;
    layerApi.paint(layer, view, quiet());
    assert.strictEqual(layer.children.length, before, 'paint replaces children rather than appending');
  }

  // hover column + ruler number is-on
  {
    const layer = make();
    const st = quiet(); st.hover = { laneIndex: 1, cycle: 2 };
    layerApi.paint(layer, view, st);
    const col = all(layer, 'ed-wave-hover-col');
    assert.strictEqual(col.length, 1);
    assert.strictEqual(num(col[0], 'x'), OX + 2 * CW);
    assert.strictEqual(num(col[0], 'width'), CW);
    const on = all(layer, 'ed-wave-ruler-num').filter(function (n) { return n.attrs.class.indexOf('is-on') !== -1; });
    assert.strictEqual(on.length, 1, 'exactly the hovered cycle number is on');
    assert.strictEqual(on[0].children[0].text, '2');
  }

  // row hover
  {
    const layer = make();
    const st = quiet(); st.rowHover = 1;
    layerApi.paint(layer, view, st);
    const r = all(layer, 'ed-wave-row-hover');
    assert.strictEqual(r.length, 1);
    assert.strictEqual(num(r[0], 'y'), 20 + LH);
    assert.strictEqual(num(r[0], 'height'), LH);
  }

  // selection = union of cellRect(from) and cellRect(to), either order
  {
    const layer = make();
    const st = quiet(); st.selection = { laneIndex: 1, from: 3, to: 1 };
    layerApi.paint(layer, view, st);
    const s = all(layer, 'ed-wave-selection');
    assert.strictEqual(s.length, 1);
    assert.strictEqual(num(s[0], 'x'), OX + 1 * CW);
    assert.strictEqual(num(s[0], 'y'), 20 + LH);
    assert.strictEqual(num(s[0], 'width'), 3 * CW);
    assert.strictEqual(num(s[0], 'height'), LH);
  }

  // cursor
  {
    const layer = make();
    const st = quiet(); st.cursor = { laneIndex: 0, cycle: 2 };
    layerApi.paint(layer, view, st);
    const c = all(layer, 'ed-wave-cursor');
    assert.strictEqual(c.length, 1);
    assert.notStrictEqual(c[0].attrs['data-ed-wave-cursor'], undefined);
    assert.strictEqual(c[0].attrs['data-cell'], '0,2');
    assert.strictEqual(num(c[0], 'x'), OX + 2 * CW);
    assert.strictEqual(num(c[0], 'y'), 20);
  }

  // ruler plus sits on the left edge of the given cycle
  {
    const layer = make();
    const st = quiet(); st.rulerPlus = 3;
    layerApi.paint(layer, view, st);
    const p = all(layer, 'ed-wave-ruler-plus');
    assert.strictEqual(p.length, 1);
    // A `<g>` ignores x/y attributes: it is placed by its transform, and it
    // has to carry something to see (Task 5 review, fixed in Task 6a).
    assert.strictEqual(p[0].attrs.transform, 'translate(' + (OX + 3 * CW) + ',' + RY + ')',
      'plus sits on the cycle 3 left edge, on the ruler line');
    assert.strictEqual(p[0].attrs['data-cycle'], '3');
    assert.strictEqual(p[0].attrs.x, undefined, 'no inert x attribute on the group');
    const glyph = p[0].children.filter(function (n) { return n.tag === 'text'; });
    assert.strictEqual(glyph.length, 1, 'the plus has one visible glyph');
    assert.strictEqual(glyph[0].children[0].text, '+');
    // Task 7: the plus is a press target of its own (the layer CSS gives
    // this ring `pointer-events: all`), centred on the glyph.
    const hit = p[0].children.filter(function (n) { return n.attrs.class === 'ed-wave-ruler-plus-hit'; });
    assert.strictEqual(hit.length, 1, 'the plus carries one hit ring');
    assert.strictEqual(hit[0].tag, 'circle');
    assert.strictEqual(hit[0].attrs.cx, '0', 'the ring is centred on the boundary');
    assert.ok(Number(hit[0].attrs.r) >= 8, 'the ring is at least the dot hit radius: ' + hit[0].attrs.r);
  }

  // dots: 'all' = one per transition, at the anchor, each with data-lane/data-cell and a hit circle
  {
    const layer = make();
    const st = quiet(); st.dots = 'all'; st.hotDot = { laneIndex: 1, cell: 2 };
    layerApi.paint(layer, view, st);
    const dots = all(layer, 'ed-wave-dot');
    assert.strictEqual(dots.length, 3, 'one dot per transition (2 + 1)');
    const keys = dots.map(function (n) { return n.attrs['data-lane'] + ',' + n.attrs['data-cell']; }).sort();
    assert.strictEqual(keys.join(' '), '0,1 0,3 1,2');
    const hot = dots.filter(function (n) { return n.attrs.class.indexOf('is-hot') !== -1; });
    assert.strictEqual(hot.length, 1);
    assert.strictEqual(hot[0].attrs['data-lane'] + ',' + hot[0].attrs['data-cell'], '1,2');
    const g = dots.filter(function (n) { return n.attrs['data-lane'] === '0' && n.attrs['data-cell'] === '1'; })[0];
    const circles = g.children.filter(function (c) { return c.tag === 'circle'; });
    assert.strictEqual(circles.length, 2, 'invisible hit circle + visible dot');
    assert.ok(circles.some(function (c) { return num(c, 'r') === 8; }), 'hit circle radius 8');
    assert.ok(circles.every(function (c) { return num(c, 'cx') === OX + 1 * CW + 5 && num(c, 'cy') === 35; }), 'on the anchor');
  }
  // dots: 'hover' = only the hovered lane; 'off' = none
  {
    const layer = make();
    const st = quiet(); st.dots = 'hover'; st.hover = { laneIndex: 0, cycle: 0 };
    layerApi.paint(layer, view, st);
    assert.strictEqual(all(layer, 'ed-wave-dot').length, 2, 'hover mode shows only the hovered lane');
    st.hover = null; st.rowHover = 1;
    layerApi.paint(layer, view, st);
    assert.strictEqual(all(layer, 'ed-wave-dot').length, 1, 'row hover also counts');
    st.rowHover = null;
    layerApi.paint(layer, view, st);
    assert.strictEqual(all(layer, 'ed-wave-dot').length, 0);
  }

  // pending edge, selected edge with its two ends, overflow boxes
  {
    const layer = make();
    const st = quiet();
    st.pending = { from: { x: 10, y: 20 }, to: { x: 50, y: 60 } };
    st.selectedEdge = { d: 'M 1 2 L 3 4', from: { x: 7, y: 8 }, to: { x: 9, y: 10 } };
    st.overflow = [{ left: 1, top: 2, width: 3, height: 4 }, { left: 5, top: 6, width: 7, height: 8 }];
    layerApi.paint(layer, view, st);
    const pend = all(layer, 'ed-wave-pending');
    assert.strictEqual(pend.length, 1);
    assert.deepStrictEqual([pend[0].attrs.x1, pend[0].attrs.y1, pend[0].attrs.x2, pend[0].attrs.y2], ['10', '20', '50', '60']);
    assert.strictEqual(all(layer, 'ed-wave-edge-sel')[0].attrs.d, 'M 1 2 L 3 4');
    const ends = all(layer, 'ed-wave-edge-end');
    assert.strictEqual(ends.map(function (n) { return n.attrs['data-end']; }).sort().join(), 'from,to');
    const to = ends.filter(function (n) { return n.attrs['data-end'] === 'to'; })[0];
    assert.deepStrictEqual([to.attrs.cx, to.attrs.cy], ['9', '10']);
    const ov = all(layer, 'ed-wave-overflow');
    assert.strictEqual(ov.length, 2);
    assert.deepStrictEqual([ov[1].attrs.x, ov[1].attrs.y, ov[1].attrs.width, ov[1].attrs.height], ['5', '6', '7', '8']);
  }
  console.log('wave-draw: createLayer 互動層（尺規／懸停／選取／游標／轉態點／待連線／溢出框）— OK');
}

console.log('wave-draw.test.js OK');
