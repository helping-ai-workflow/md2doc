'use strict';

/**
 * The editor's own marks, and the brush glyphs.
 *
 * Since the wave redesign (spec §3) the WaveDrom engine draws the waveform
 * itself (lib/editor/wave-canvas.js). This module draws only what sits on
 * top of it — `createLayer`, the interaction layer — plus the toolbar's
 * per-brush glyphs (`createDrawer().levelIcon`) and the small brick model
 * those glyphs and wave-ui.js's bus test share (`brickOf`, `isBus`,
 * `isClock`, `brickPath`). The hand-drawn canvas that used to live here
 * (renderCanvas and its lane, name, ruler, band and edge painters) was
 * removed in Task 6a: four of the seven defects in spec §5 were that second
 * picture disagreeing with the engine's.
 *
 * Every dependency is handed in (the document, geometry, the SVG namespace);
 * this module names no global and requires nothing.
 */

function createDrawer(deps) {
  const d = deps.d;
  const geometry = deps.geometry;
  const SVGNS = deps.SVGNS;

  /**
   * What wavedrom 3.5.0 actually draws for one level, by its own brick id.
   *
   * Every row was MEASURED in this session against the pinned engine, by
   * rendering `wave: 'z' + c + c` (the `z` anchors the char so it is never at
   * cycle 0) and reading the second half-brick of each cycle out of the
   * rendered SVG's `<use xlink:href="#…">` list:
   *
   *     0 000   1 111   x xxx   z zzz   u uuu   d ddd
   *     h 111   l 000   H 111   L 000
   *     p nclk  P nclk  n pclk  N pclk
   *     = vvv-2  2 vvv-2  3 vvv-3 … 9 vvv-9
   *     anything else  xxx      (measured with 'Q' and 'ä')
   *
   * So this is not a re-implementation of the engine's level model — `levelsOf`
   * is that, and it lives in the codec. This is the last step: which PICTURE
   * the engine paints for a level it has already decided. Keeping it in
   * production code rather than in the test is deliberate: the drawing has to
   * make exactly this decision anyway (an `h` lane is drawn high, an `=` lane
   * is drawn as a bus), and a copy of it living only in a test would be a
   * second belief about the engine with nothing pinning it to the first.
   */
  function brickOf(level) {
    if (typeof level !== 'string' || level.length === 0) return 'xxx';
    if (level === '0' || level === 'l' || level === 'L') return '000';
    if (level === '1' || level === 'h' || level === 'H') return '111';
    if (level === 'z') return 'zzz';
    if (level === 'u') return 'uuu';
    if (level === 'd') return 'ddd';
    if (level === 'p' || level === 'P') return 'nclk';
    if (level === 'n' || level === 'N') return 'pclk';
    if (level === '=') return 'vvv-2';
    if (level >= '2' && level <= '9') return 'vvv-' + level;
    return 'xxx';
  }

  /** A brick that draws a whole clock period and therefore never merges with
   *  its neighbour: two `p` cycles are two clock periods, not one long one. */
  function isClock(brick) {
    return brick === 'nclk' || brick === 'pclk';
  }

  function isBus(brick) {
    return brick.slice(0, 4) === 'vvv-';
  }

  /**
   * The SVG path for one cell's picture, in LOCAL coordinates (0,0 is the
   * cell's own top-left). Its one production caller since Task 6a is
   * `levelIcon`, which only ever asks for the flat case; the ramp case is
   * kept because test/wave-draw.test.js pins it against the engine's skin.
   *
   * A real level change is not a vertical line: the engine holds the OLD
   * level until `slewStartRatio` into the cell, ramps to the NEW level, and
   * holds it for the rest of the cell — `node`/edge anchors (`anchorRatio`,
   * `wave-geometry.js`) land partway up that ramp, not at a vertical jump
   * that has nothing under it. `|` (gap) and a cell with no previous level
   * (the first cell of a lane) are not transitions and get a flat line.
   *
   * MEASURED against `node_modules/wavedrom` 3.5.0's `waveSkin`, dumped
   * directly (not recalled) — and specifically against the bricks that
   * actually CHANGE level, `0m1`/`1m0`, not the same-level `0m0` blip
   * `wave-geometry.js`'s own `SKIN_METRICS` comment originally (wrongly)
   * measured `slewEndRatio` from:
   *
   *     0m1  "M0,20 3,20 9,0 20,0"                 -> (0,20)(3,20)(9,0)(20,0)
   *     1m0  "m0,0 3,0 6,20 11,0" (relative)        -> (0,0)(3,0)(9,20)(20,20)
   *
   * Both put the diagonal from local x=3 to local x=9 out of a 40-wide cycle
   * — `slewStartRatio` (0.075) to `slewEndRatio` (0.225, repinned by R23;
   * see `wave-geometry.js`'s `SKIN_METRICS` comment for the full
   * derivation and why `anchorRatio` is the ramp's MIDPOINT rather than its
   * end). `slewEndRatio` is used directly below rather than recomputed from
   * `anchorRatio`/`slewStartRatio` — now that the constant itself is
   * correct, a second formula for the same point is exactly the "one fact,
   * two definitions" failure this repo keeps paying for, not a safeguard.
   */
  function brickPath(level, prevLevel, width, height) {
    const s = geometry.SKIN_METRICS;
    const rampStart = s.slewStartRatio * width;
    const rampEnd = s.slewEndRatio * width;
    const yFor = function (ch) {
      if (ch === '1' || ch === 'P' || ch === 'h') return 0;
      if (ch === '0' || ch === 'n' || ch === 'l') return height;
      return height / 2;
    };
    const yNow = yFor(level);
    if (level === '|' || prevLevel === null || prevLevel === level) {
      return 'M0,' + yNow + ' L' + width + ',' + yNow;
    }
    const yPrev = yFor(prevLevel);
    return 'M0,' + yPrev +
      ' L' + rampStart + ',' + yPrev +
      ' L' + rampEnd + ',' + yNow +
      ' L' + width + ',' + yNow;
  }

  /**
   * Which vertical band a brick's own flat run sits at, in PIXELS. Lifted
   * out of the old hand-drawn lane painter (v3.6.0 Task 10) to drive `levelIcon`'s
   * height decision — `uuu`/`ddd` painting at the SAME height as `111`/`000`
   * (not at mid, which is `brickPath`'s own `yFor` default for any char it
   * does not explicitly recognise) is a fact this function already owns,
   * and Task 10's own brief warns against a second belief about it.
   */
  function bandOf(brick, hi, lo, mid) {
    if (brick === '111' || brick === 'uuu') return [hi, hi];
    if (brick === '000' || brick === 'ddd') return [lo, lo];
    if (brick === 'zzz') return [mid, mid];
    return [hi, lo];
  }

  /** The bus hexagon's point list (v3.6.0 Task 10), `levelIcon`'s bus glyph. */
  function busPolygonPoints(x0, x1, hi, lo, mid, s) {
    return (x0 + s) + ',' + hi + ' ' + (x1 - s) + ',' + hi + ' ' +
      x1 + ',' + mid + ' ' + (x1 - s) + ',' + lo + ' ' +
      (x0 + s) + ',' + lo + ' ' + x0 + ',' + mid;
  }

  /** The clock brick's stepped edge (v3.6.0 Task 10), `levelIcon`'s clock glyph. */
  function clockStepPath(brick, x0, x1, hi, lo) {
    const xm = (x0 + x1) / 2;
    return brick === 'nclk'
      ? 'M' + x0 + ',' + lo + ' L' + x0 + ',' + hi + ' L' + xm + ',' + hi +
        ' L' + xm + ',' + lo + ' L' + x1 + ',' + lo
      : 'M' + x0 + ',' + hi + ' L' + x0 + ',' + lo + ' L' + xm + ',' + lo +
        ' L' + xm + ',' + hi + ' L' + x1 + ',' + hi;
  }

  /** The `P`/`N` explicit-edge arrowhead (v3.6.0 Task 10). `null` for any
   *  other level char. */
  function clockArrowPath(edgeLevel, x0, xm, hi, lo) {
    if (edgeLevel !== 'P' && edgeLevel !== 'N') return null;
    const sx = (xm - x0) / 20;
    const sy = (lo - hi) / 20;
    const apexY = edgeLevel === 'P' ? hi + 3 * sy : hi + 17 * sy;
    const baseY = edgeLevel === 'P' ? hi + 12 * sy : hi + 8 * sy;
    return 'M' + (x0 - 3 * sx) + ',' + baseY +
      ' L' + x0 + ',' + apexY +
      ' L' + (x0 + 3 * sx) + ',' + baseY + ' Z';
  }

  /** The gap `|` marker's double chevron (v3.6.0 Task 10), `levelIcon`'s gap glyph. */
  function gapMarkPath(xm, hi, lo, mid) {
    return 'M' + (xm - 5) + ',' + (lo + 3) + ' L' + (xm + 1) + ',' + mid +
      ' L' + (xm - 5) + ',' + (hi - 3) +
      ' M' + (xm - 1) + ',' + (lo + 3) + ' L' + (xm + 5) + ',' + mid +
      ' L' + (xm - 1) + ',' + (hi - 3);
  }

  /**
   * The toolbar's per-brush glyph — v3.6.0 Task 10.
   *
   * Every shape below is built from the brick helpers above (`brickOf`,
   * `bandOf`, `brickPath`, `isBus`, `isClock`, `busPolygonPoints`,
   * `clockStepPath`, `clockArrowPath`, `gapMarkPath`). They were the old
   * hand-drawn canvas's painters; since Task 6a the engine draws the canvas,
   * so these glyphs are a simplified picture of each brush, not a copy of
   * what the canvas shows.
   *
   * A glyph is a single cell with no previous level, so `brickPath` is only
   * called here with the SAME char as both `level` and `prevLevel` — its
   * flat-line case, never the ramp. That flat line is the RIGHT picture for
   * a plain level (`0`/`1`/`h`/`l`/`z`/`u`/`d`): that is genuinely what the
   * engine paints for one of those. It is the WRONG picture for a bus, a
   * clock, `xxx` or a gap — those are not flat lines on canvas, so drawing
   * one for them would be exactly the "worse than the bare character"
   * failure the brief warns about; those five get their own shape instead,
   * built from the same lane-drawing helpers, with no flat line underneath.
   *
   * `uuu`/`ddd` are the landmine `brickPath` on its own does not resolve:
   * its own `yFor` only recognises the 000/111 ramp endpoints (R24) and
   * silently drops any other char — `u`/`d` included — at mid, which
   * disagrees with `bandOf`'s `uuu -> hi`, `ddd -> lo` on the real canvas.
   * So the level handed to `brickPath` here is redirected through `bandOf`
   * first (via `brick`), not passed through raw. MEASURED (see
   * task-10-report.md): calling `brickPath(ch, ch, 24, 16)` for the raw
   * character of all 22 brushes — the brief's own sketch — puts 13 of them
   * (`x`, `z`, `p`, `N`, `u`, `d`, and every bus digit) on the exact SAME
   * `M0,8 L24,8` mid line, and gets `P`/`n` backwards relative to which
   * half of their clock cycle actually starts low vs. high.
   */
  function levelIcon(level) {
    const W = 24;
    const H = 16;
    const hi = 0;
    const lo = H;
    const mid = H / 2;
    const brick = brickOf(level);

    const svg = d.createElementNS(SVGNS, 'svg');
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('class', 'ed-wave-level-icon');

    if (level === '|') {
      // `brickOf('|')` itself falls through to its own `'xxx'` default (it
      // has no case for `|` — production code never asks it: `levelsOf`
      // erases `|` before `brickOf` ever sees it). So this has to be checked ahead of the
      // `brick === 'xxx'` branch below, or the gap brush would silently
      // draw the `x` hatch instead of its own chevron marker.
      const gap = d.createElementNS(SVGNS, 'path');
      gap.setAttribute('class', 'ed-wave-gap');
      gap.setAttribute('d', gapMarkPath(W / 2, hi, lo, mid));
      svg.appendChild(gap);
    } else if (isBus(brick)) {
      const s = Math.min(6, W / 4);
      const poly = d.createElementNS(SVGNS, 'path');
      poly.setAttribute('class', 'ed-wave-bus ed-wave-bus-' + brick.slice(4));
      poly.setAttribute('d', 'M' + busPolygonPoints(0, W, hi, lo, mid, s).split(' ').join(' L') + ' Z');
      svg.appendChild(poly);
    } else if (brick === 'xxx') {
      const rect = d.createElementNS(SVGNS, 'path');
      rect.setAttribute('class', 'ed-wave-x');
      rect.setAttribute('d', 'M' + 0 + ',' + hi + ' L' + W + ',' + hi +
        ' L' + W + ',' + lo + ' L' + 0 + ',' + lo + ' Z');
      svg.appendChild(rect);
    } else if (isClock(brick)) {
      const step = d.createElementNS(SVGNS, 'path');
      step.setAttribute('class', 'ed-wave-line ed-wave-clock');
      step.setAttribute('d', clockStepPath(brick, 0, W, hi, lo));
      svg.appendChild(step);
      const arrowD = clockArrowPath(level, 0, W / 2, hi, lo);
      if (arrowD !== null) {
        const arrow = d.createElementNS(SVGNS, 'path');
        arrow.setAttribute('class', 'ed-wave-clock-arrow');
        arrow.setAttribute('d', arrowD);
        svg.appendChild(arrow);
      }
    } else {
      // Plain levels only: 0/1/h/l/z/u/d. `bandOf` says which single height
      // this brick paints at; `brickPath` is only asked to draw a flat line
      // AT that height, via whichever `yFor`-recognised char reaches it —
      // '1' and '0' for the top/bottom bands (covers 1/h and uuu, 0/l and
      // ddd alike), the level itself for mid (z already lands there through
      // `yFor`'s own default, same as `bandOf`'s zzz case).
      const band = bandOf(brick, hi, lo, mid);
      const repLevel = band[0] === hi ? '1' : band[0] === lo ? '0' : level;
      const line = d.createElementNS(SVGNS, 'path');
      line.setAttribute('class', (brick === 'uuu' || brick === 'ddd')
        ? 'ed-wave-line ed-wave-weak ed-wave-level-icon-path'
        : 'ed-wave-line ed-wave-level-icon-path');
      line.setAttribute('d', brickPath(repLevel, repLevel, W, H));
      svg.appendChild(line);
    }

    return svg;
  }

  return {
    brickOf: brickOf,
    isClock: isClock,
    isBus: isBus,
    brickPath: brickPath,
    levelIcon: levelIcon,
  };
}


/**
 * The interaction layer: only the editor's own marks, painted into a separate
 * SVG laid over the engine's drawing. Everything is in LAYER-LOCAL PIXELS;
 * the caller builds `view.cellRect` / `view.anchor` and subtracts the layer's
 * own client rect, so this module needs neither the canvas nor the geometry.
 *
 * view.cells[i] = { laneIndex, cycles, transitions?: number[] } -- `transitions`
 * lists the cell indices (as `view.anchor` takes them) where a dot belongs.
 * state.selection = { laneIndex, from, to } in cycles; state.cursor and
 * state.hover = { laneIndex, cycle }; state.hotDot = { laneIndex, cell }.
 * state.rulerPlus = the cycle boundary (0..cycles) the ruler's ＋ sits on.
 * view.bodyTop (optional, default 0) = where the lanes start in the layer.
 * `paint` replaces the layer's children on every call.
 */
function createLayer(deps) {
  const d = deps.d;
  const SVGNS = deps.SVGNS;
  const DOT_R = 3;
  const DOT_R_HOT = 5;
  const HIT_R = 8;
  const END_R = 4;
  const PLUS_HIT_R = 9;
  const PLUS_LIFT = 5;

  function mk(tag, cls, attrs) {
    const el = d.createElementNS(SVGNS, tag);
    if (cls) el.setAttribute('class', cls);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, String(attrs[k])); });
    return el;
  }

  function paint(layer, view, state) {
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    // Fake DOMs without removeChild/firstChild expose `children` only.
    if (layer.children && layer.children.length) layer.children.length = 0;
    const cells = view.cells || [];
    const first = cells.length > 0 ? cells[0] : null;
    let maxCycles = 0;
    cells.forEach(function (c) { if (c.cycles > maxCycles) maxCycles = c.cycles; });
    const on = new Set();
    if (state.hover) on.add(state.hover.cycle);
    if (state.cursor) on.add(state.cursor.cycle);

    // ruler: one number per cycle, over the first lane's cell columns
    if (first !== null) {
      for (let c = 0; c < maxCycles; c += 1) {
        const r = view.cellRect(first.laneIndex, c);
        const t = mk('text', 'ed-wave-ruler-num' + (on.has(c) ? ' is-on' : ''), {
          x: r.x + r.width / 2, y: view.rulerY, 'text-anchor': 'middle', 'data-cycle': c,
        });
        t.appendChild(d.createTextNode(String(c)));
        layer.appendChild(t);
      }
      if (state.rulerPlus !== null && state.rulerPlus !== undefined) {
        const r = view.cellRect(first.laneIndex, state.rulerPlus);
        // A <g> ignores x/y: it is placed by its transform, and it carries
        // its own visible glyph (styled by .ed-wave-ruler-plus in the CSS).
        const plus = mk('g', 'ed-wave-ruler-plus', {
          transform: 'translate(' + r.x + ',' + view.rulerY + ')', 'data-cycle': state.rulerPlus,
        });
        const glyph = mk('text', 'ed-wave-ruler-plus-glyph', { x: 0, y: 0, 'text-anchor': 'middle' });
        glyph.appendChild(d.createTextNode('+'));
        plus.appendChild(glyph);
        // Task 7: the plus is pressed to insert a cycle, so it carries a
        // transparent ring the size of a dot's hit circle, centred on the
        // glyph (which sits on the ruler baseline, so its middle is
        // PLUS_LIFT above it). The CSS gives only this ring presses.
        plus.appendChild(mk('circle', 'ed-wave-ruler-plus-hit', {
          cx: 0, cy: -PLUS_LIFT, r: PLUS_HIT_R, fill: 'transparent',
        }));
        layer.appendChild(plus);
      }
    }

    if (state.rowHover !== null && state.rowHover !== undefined) {
      const r = view.cellRect(state.rowHover, 0);
      layer.appendChild(mk('rect', 'ed-wave-row-hover', { x: 0, y: r.y, width: view.width, height: r.height }));
    }
    if (state.hover) {
      // The whole column under the lanes; `view.bodyTop` is where the lanes
      // start when the layer also covers the ruler band above them.
      const r = view.cellRect(state.hover.laneIndex, state.hover.cycle);
      const top = typeof view.bodyTop === 'number' ? view.bodyTop : 0;
      layer.appendChild(mk('rect', 'ed-wave-hover-col', { x: r.x, y: top, width: r.width, height: view.height - top }));
    }
    if (state.selection) {
      const a = view.cellRect(state.selection.laneIndex, Math.min(state.selection.from, state.selection.to));
      const b = view.cellRect(state.selection.laneIndex, Math.max(state.selection.from, state.selection.to));
      layer.appendChild(mk('rect', 'ed-wave-selection', {
        x: a.x, y: a.y, width: b.x + b.width - a.x, height: a.height,
      }));
    }
    if (state.dots && state.dots !== 'off') {
      const lit = new Set();
      if (state.hover) lit.add(state.hover.laneIndex);
      if (state.rowHover !== null && state.rowHover !== undefined) lit.add(state.rowHover);
      cells.forEach(function (c) {
        if (state.dots === 'hover' && !lit.has(c.laneIndex)) return;
        (c.transitions || []).forEach(function (cell) {
          const a = view.anchor(c.laneIndex, cell);
          const hot = !!state.hotDot && state.hotDot.laneIndex === c.laneIndex && state.hotDot.cell === cell;
          const g = mk('g', 'ed-wave-dot' + (hot ? ' is-hot' : ''), { 'data-lane': c.laneIndex, 'data-cell': cell });
          g.appendChild(mk('circle', 'ed-wave-dot-hit', { cx: a.x, cy: a.y, r: HIT_R, fill: 'transparent' }));
          g.appendChild(mk('circle', 'ed-wave-dot-mark', { cx: a.x, cy: a.y, r: hot ? DOT_R_HOT : DOT_R }));
          layer.appendChild(g);
        });
      });
    }
    if (state.pending) {
      layer.appendChild(mk('line', 'ed-wave-pending', {
        x1: state.pending.from.x, y1: state.pending.from.y, x2: state.pending.to.x, y2: state.pending.to.y,
      }));
    }
    if (state.selectedEdge) {
      layer.appendChild(mk('path', 'ed-wave-edge-sel', { d: state.selectedEdge.d }));
      layer.appendChild(mk('circle', 'ed-wave-edge-end', {
        'data-end': 'from', cx: state.selectedEdge.from.x, cy: state.selectedEdge.from.y, r: END_R,
      }));
      layer.appendChild(mk('circle', 'ed-wave-edge-end', {
        'data-end': 'to', cx: state.selectedEdge.to.x, cy: state.selectedEdge.to.y, r: END_R,
      }));
    }
    (state.overflow || []).forEach(function (o) {
      layer.appendChild(mk('rect', 'ed-wave-overflow', { x: o.left, y: o.top, width: o.width, height: o.height }));
    });
    // the cursor last, over everything else
    if (state.cursor) {
      const r = view.cellRect(state.cursor.laneIndex, state.cursor.cycle);
      const cur = mk('rect', 'ed-wave-cursor', {
        'data-ed-wave-cursor': '', 'data-cell': state.cursor.laneIndex + ',' + state.cursor.cycle,
        x: r.x, y: r.y, width: r.width, height: r.height,
      });
      layer.appendChild(cur);
    }
  }

  return { paint: paint };
}

module.exports = { createDrawer: createDrawer, createLayer: createLayer };
