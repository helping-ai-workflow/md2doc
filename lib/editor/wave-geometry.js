'use strict';

/**
 * wave-geometry — where every cycle of a WaveJSON document sits, and which
 * cycle a point lands in. Pure arithmetic: no DOM, no measuring, no mutation.
 * Every size arrives as a parameter, so the layer above can hand in whatever
 * the rendered SVG actually measures and this file stays testable in
 * milliseconds.
 *
 * It lives on its own for one reason: the hit test's boundary rule — a cell's
 * LEFT edge belongs to it, its RIGHT edge belongs to the next cell — is the
 * single easiest thing in a wave GUI to get wrong by one pixel, and the single
 * easiest thing to pin exactly if it is arithmetic instead of a click handler.
 * Buried in the SVG editor it would need a browser to check; here it needs
 * `node test/wave-geometry.test.js`.
 *
 * Two facts about the engine this file is shaped around, both measured against
 * the pinned `wavedrom@3.5.0` in `node_modules` rather than assumed:
 *
 *   1. A GROUP TITLE DOES NOT OCCUPY A ROW. `{signal:[{a},['grp',{b},{c}],{d}]}`
 *      and the same four lanes with no group render to the identical height
 *      (120) with lanes at the identical y (5/35/65/95). What a group costs is
 *      horizontal: the name column widens (the `lanes_0` translate goes 40.5 →
 *      60.5 for one named group, 80.5 nested). So a row is exactly
 *      `index * laneHeight`, and no row model richer than that is needed.
 *
 *   2. A REPEATER IS A CYCLE. `0...`, `0.0.` and `0000` all render 4 cycles
 *      wide (220px), `0|0` 3 (180px), `0||0` 4. So cycle counts come from the
 *      codec's `levelsOf`, which models what the engine draws, rather than from
 *      counting value characters.
 *
 * The lane index this file speaks is the codec's: the flattened, depth-first
 * display order over real lanes, skipping the strings a group uses for its
 * title. It is not re-derived here — `wave-codec.lanePath` is asked for each
 * one in turn, so the two files cannot drift into two index spaces that agree
 * today. Two disagreeing lane orders inside one module was the most expensive
 * defect in this batch, and it was silent; a caller that hit-tests here and
 * edits through the codec must be pointing at the same lane.
 *
 * Coordinates are layout-local: (0, 0) is the top-left of the whole diagram,
 * name column included. Translating a pointer event into that space belongs to
 * the caller, which is the only layer that knows about scroll and scale.
 */

const codec = require('./wave-codec.js');

/**
 * MEASURED against `node_modules/wavedrom` 3.5.0 (`node_modules/wavedrom/package.json`
 * `"version"`), by reading its `waveSkin` object directly in Node:
 *
 *   - socket: `["g",{"id":"socket"},["rect",{"y":"15","x":"6","height":"20","width":"20"}]]`.
 *     A brick is `width` wide (20), a cycle is two bricks (40), and the engine
 *     anchors a `node` marker at the socket rect's `x` — so `anchorRatio` is
 *     `6 / 40 = 0.15`. `slewEndRatio` is the same point: the transition ramp
 *     finishes exactly where the anchor sits.
 *   - transition brick `0m0`: `["g",{"id":"0m0"},["path",{"d":"m0,20 3,0 3,-10 3,10 11,0", …}]]`.
 *     The path's first segment (`3,0`, i.e. length 3 along x) is the ramp's
 *     start offset, so `slewStartRatio` is `3 / 40 = 0.075`.
 *   - Cross-checked end-to-end: rendering `{signal:[{wave:'0.1.0...',node:'a.b.c...'}],
 *     edge:['a-b']}` through `wavedrom.renderAny` puts the `gmark_a_b` path's
 *     endpoints at `cycle * 40 + 0.15 * 40` for both cycle 0 (`a`) and cycle 2
 *     (`b`) — see `test/wave-geometry.test.js`'s SKIN_METRICS block, which
 *     re-derives these same three ratios from `waveSkin` and re-runs this exact
 *     render, so a wavedrom bump that moves the skin turns that test red and
 *     names the number to re-pin.
 *
 * Pinned rather than derived at module load: this file cannot pull in the
 * `wavedrom` package itself. In the browser, `lib/editor/server.js`'s CommonJS
 * shim resolves that same import against a page-global registry keyed by module
 * basename, and the shipped `wavedrom.min.js` bundle only attaches `ProcessAll` /
 * `RenderWaveForm` / `EditorRefresh` / `eva` / `version` to that page global — no
 * `waveSkin` — so a page-time derivation would read `undefined` on every real
 * page, not just as a rare fallback. The tests, which run in Node against the
 * real npm package, are where the derivation actually happens and where a
 * version bump would be caught.
 */
const SKIN_METRICS = Object.freeze({
  anchorRatio: 0.15,
  slewStartRatio: 0.075,
  slewEndRatio: 0.15,
});

/**
 * Sizes to use when the caller has nothing better, read out of the engine's own
 * `lane` module after a render rather than inferred: `lane.yo` (row pitch) is
 * 30, `lane.xs` (brick width) is 20 and a cycle is two bricks, so 40, and
 * `lane.xg` (name column) is 40 for a short-named, ungrouped diagram. The
 * measured `lanes_0` translate of 40.5 is `lane.xg + 0.5` — the engine's own
 * half-pixel stroke alignment, added in `insert-svg-template.js` — not a name
 * column of 40.5, so 40 is the exact number and not a rounded one.
 *
 * These are a fallback. A caller that has the rendered SVG in front of it
 * should measure and pass its own; under browser zoom those measurements are
 * fractional, which the hit test below is built to survive.
 */
const DEFAULTS = { laneHeight: 30, cycleWidth: 40, nameColWidth: 40 };

/**
 * How many lanes are laid out before the rest are dropped.
 *
 * This is a ceiling on the RESULT, not a cure for a cost. The enumeration below
 * asks the codec once for the whole list, so laying a document out is one walk
 * of it: measured through `layoutOf`, 1024 lanes 4ms, 20000 lanes 6ms, 50000
 * lanes 8ms, and a 508900-byte fence of 20000 lanes goes from `parseSource`
 * (98ms) to a layout in 2ms. The earlier shape of this file asked position by
 * position, which walked the whole document once per lane: enumerating the same
 * 1024 lanes cost 100ms in a 1024-lane document, 2089ms in a 20000-lane one and
 * 3630ms in a 50000-lane one. No ceiling on the result could bound that, because
 * the cost followed the document and not the ceiling.
 *
 * What the ceiling is still for: a diagram with more rows than this is not a
 * diagram, and the layer above would be drawing them. Past it the layout is
 * truncated and says so on the way out. Truncating rather than raising is
 * deliberate: the source is the user's markdown, and a fence the codec's parser
 * accepts must never take the editor down. A broken document lays out as best
 * it can; only a broken SIZE raises, because that is caller code.
 */
const MAX_LANES = 1024;

/**
 * A size the caller passed. Absent means "use the default"; present but not a
 * usable number is a programming error and says so. Quietly substituting a
 * default there would not fail — it would lay the diagram out at the wrong
 * scale and paint cycles into the wrong place, which is the whole class of
 * defect this file exists to make impossible.
 */
function size(value, fallback, name, allowZero) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !isFinite(value) || value < 0 ||
      (value === 0 && !allowZero)) {
    throw new TypeError('wave-geometry: ' + name + ' must be a finite ' +
      (allowZero ? 'non-negative' : 'positive') + ' number, got ' + String(value));
  }
  return value;
}

/**
 * The options bag itself. `undefined` and `null` mean "no options"; anything
 * else that is not a plain options object — a number, a string, an array, a
 * callable — is the same programming error as a bad size, and by the same
 * argument: `layoutOf(doc, 42)` laying the diagram out at default sizes is a
 * plausible-looking layout at the wrong scale with no complaint anywhere.
 */
function options(opts) {
  if (opts === undefined || opts === null) return {};
  const proto = typeof opts === 'object' ? Object.getPrototypeOf(opts) : false;
  if (proto !== null && proto !== Object.prototype) {
    throw new TypeError('wave-geometry: opts must be a plain object, got ' +
      (typeof opts === 'object' ? Object.prototype.toString.call(opts) : typeof opts));
  }
  return opts;
}

/** The value at `path` in `doc`, or `undefined` if the path does not land. */
function valueAt(doc, path) {
  let node = doc;
  for (const step of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[step];
  }
  return node;
}

/**
 * Every lane of the document, in display order, each with the codec's own path
 * to it — from the codec's single walk, not from a second one here. There is
 * only one lane order in this batch, and asking for it rather than deriving it
 * is what keeps that true.
 */
function enumerateLanes(doc) {
  const paths = codec.lanePaths(doc);
  const out = [];
  const n = paths.length < MAX_LANES ? paths.length : MAX_LANES;
  for (let i = 0; i < n; i++) {
    out.push({ path: paths[i], lane: valueAt(doc, paths[i]) });
  }
  return { lanes: out, truncated: paths.length > MAX_LANES };
}

/** How many cycles a lane is: what the engine draws, which is what the codec models. */
function cyclesOf(lane) {
  if (lane === null || typeof lane !== 'object') return 0;
  if (typeof lane.wave !== 'string') return 0;
  return codec.levelsOf(lane.wave).length;
}

/**
 * Where everything is.
 *
 * `lanes[i]` carries the row (`y`, `height`), the codec's `path` to that lane
 * and the lane object itself, so a caller that hit-tests here can hand the
 * index straight to a codec document op without looking the lane up again. It
 * also carries `cycles` — that lane's own length, which can be shorter than the
 * diagram's — and `depth`, the group nesting read off the path rather than
 * walked for a second time.
 *
 * `cycles` is the longest lane, floored at one whenever there is a lane at all.
 * The engine does the same: a lane whose wave is empty still renders 100px wide
 * with `lane.xmax` 2, exactly as `wave: '0'` does — one cycle's worth of space
 * reserved — while a document with no lanes renders 40 wide and reserves none.
 * Without that floor a fresh diagram has no coordinate anywhere at which to
 * place its first cycle, and the layer above would have to invent one, which
 * would put two different beliefs about the width of an empty diagram in two
 * different files.
 *
 * `width` and `height` span the hit-testable extent: the name column plus every
 * cycle, and every row. They are not the engine's canvas — the engine adds
 * about half a cycle of right margin (four cycles render 220 wide where this
 * reports 200 at the default sizes). That margin is not a cell and must not be
 * hit-testable, so a caller sizing an overlay from these should add its own.
 *
 * `truncated` is true when the document had more lanes than `MAX_LANES` and the
 * rest were dropped.
 *
 * The domain this file claims is sizes a rendered SVG can actually produce:
 * positive, finite, and within a few orders of magnitude of each other. Outside
 * it the arithmetic stops being able to represent the answer rather than
 * computing it wrongly, and the round trip goes with it — measured, a
 * `cycleWidth` of 1e-13 against a `nameColWidth` of 1e6 is absorbed entirely, so
 * `width` collapses onto `nameColWidth` and every point misses; sizes at 1e308
 * overflow `width` to Infinity. Both are outside anything `getBoundingClientRect`
 * can report, and neither is defended against here.
 */
function layoutOf(doc, opts) {
  const o = options(opts);
  const laneHeight = size(o.laneHeight, DEFAULTS.laneHeight, 'laneHeight', false);
  const cycleWidth = size(o.cycleWidth, DEFAULTS.cycleWidth, 'cycleWidth', false);
  const nameColWidth = size(o.nameColWidth, DEFAULTS.nameColWidth, 'nameColWidth', true);

  // `config.hscale` scales every lane's cycle width the same way the engine's
  // own `lane.hscale` does. A missing or unusable value is 1 — the engine's
  // own default — not an error: it comes from the user's document, not from
  // caller code, and a hand-edited `config` with a stray string in it must
  // still lay out rather than take the editor down.
  const cfg = (doc !== null && typeof doc === 'object' &&
    doc.config !== null && typeof doc.config === 'object') ? doc.config : null;
  const hscale = (cfg !== null && typeof cfg.hscale === 'number' &&
    isFinite(cfg.hscale) && cfg.hscale > 0) ? cfg.hscale : 1;

  const found = enumerateLanes(doc);
  const lanes = [];
  let cycles = 0;
  for (let i = 0; i < found.lanes.length; i++) {
    const laneCycles = cyclesOf(found.lanes[i].lane);
    if (laneCycles > cycles) cycles = laneCycles;
    const lane = found.lanes[i].lane;
    // A wave character spans `period` diagram cycles, and the whole lane is
    // then scaled by `hscale`. `phase` only shifts the origin, and by the
    // BASE cycle width, not the effective one — the engine's own expression
    // is `xs * (2*i*period*hscale - phase)`, and that `phase` term is never
    // multiplied by hscale (measured in node_modules/wavedrom/lib/render-arcs.js).
    const laneObj = (lane !== null && typeof lane === 'object') ? lane : {};
    const period = (typeof laneObj.period === 'number' && isFinite(laneObj.period) &&
      laneObj.period > 0) ? laneObj.period : 1;
    const phase = (typeof laneObj.phase === 'number' && isFinite(laneObj.phase)) ?
      laneObj.phase : 0;
    lanes.push({
      index: i,
      y: i * laneHeight,
      height: laneHeight,
      cycles: laneCycles,
      depth: found.lanes[i].path.length - 2,
      path: found.lanes[i].path,
      lane: lane,
      cycleWidth: cycleWidth * period * hscale,
      originX: nameColWidth - cycleWidth * phase,
    });
  }
  if (lanes.length > 0 && cycles === 0) cycles = 1;

  // Each lane can now have its own cycleWidth/originX, so the diagram's width
  // is the widest lane's own right edge, not a single global expression. A
  // lane with zero cycles of its own (an empty or wave-less lane) still
  // reserves the same one-cycle floor documented above `layoutOf` — the
  // engine renders a placeholder cycle for it too, so width must not collapse
  // to the name column just because THAT lane happens to be the widest one.
  let width = nameColWidth;
  for (const row of lanes) {
    const rowCycles = row.cycles > 0 ? row.cycles : 1;
    const right = row.originX + rowCycles * row.cycleWidth;
    if (right > width) width = right;
  }
  if (lanes.length === 0) width = nameColWidth;

  return {
    laneHeight: laneHeight,
    cycleWidth: cycleWidth,
    nameColWidth: nameColWidth,
    hscale: hscale,
    lanes: lanes,
    cycles: cycles,
    truncated: found.truncated,
    width: width,
    height: lanes.length * laneHeight,
  };
}

/**
 * The group titles in the lane tree, each with the span of display rows it
 * covers.
 *
 * A group title occupies NO ROW — measured in Task 2 against the pinned
 * engine, and `wave-geometry` is built on it. What it occupies is horizontal
 * space in the name column, so that is where this puts it: a label in the
 * lane list's rail, spanning its lanes' rows. Drawing it as a row of its own
 * would put the lane list one row out of step with the waveform beside it for
 * every lane below the group, which is exactly the class of silent
 * disagreement this batch keeps producing.
 *
 * The span is derived from the lanes' own paths — `layout.lanes[i].path` is
 * the codec's — so a group with no lanes under it has no span and is not
 * shown here; it is not addressable through the bridge either.
 *
 * v3.6.0 Task 2: moved here from `lib/editor/wave-ui.js` per ruling R9 — both
 * `wave-panels.js` (the lane rail) and `wave-draw.js` (the canvas) need it,
 * and this file is the one place both already depend on. Behaviour
 * unchanged; it now reads this file's own `valueAt` instead of a copy that
 * used to live in `wave-ui.js`.
 */
function groupSpansOf(doc, layout) {
  const byKey = new Map();
  for (let i = 0; i < layout.lanes.length; i++) {
    const path = layout.lanes[i].path;
    // Every proper ancestor between `signal` and the lane itself is a group.
    for (let cut = 2; cut < path.length; cut++) {
      const prefix = path.slice(0, cut);
      const key = JSON.stringify(prefix);
      const seen = byKey.get(key);
      if (seen === undefined) {
        byKey.set(key, { path: prefix, depth: cut - 1, from: i, to: i });
      } else {
        seen.to = i;
      }
    }
  }
  const out = [];
  for (const span of byKey.values()) {
    const container = valueAt(doc, span.path);
    const title = Array.isArray(container) && typeof container[0] === 'string'
      ? container[0] : null;
    if (title === null) continue;   // an untitled group has nothing to show
    out.push({ path: span.path, title: title, depth: span.depth,
      from: span.from, to: span.to });
  }
  out.sort(function (a, b) { return a.from - b.from || a.depth - b.depth; });
  return out;
}

/** A real, finite coordinate — `'70'` and `NaN` are not one. */
function isCoord(n) {
  return typeof n === 'number' && isFinite(n);
}

function isIndex(n) {
  return typeof n === 'number' && isFinite(n) && Math.floor(n) === n;
}

/**
 * Which index `pos` falls in, given cells that start at `origin + i * step`.
 *
 * The rule is a half-open interval `[start, start + step)`, so every edge
 * belongs to the cell on its far side and there is no rounding and no epsilon
 * anywhere. Dividing gets the answer in real arithmetic; it does not get it in
 * floating point, because the subtraction and the division each round, and when
 * they round down a cell's own left edge lands in the cell before it. Measured
 * on a fractional fuzz of 96000 cells: 15715 of them had that wrong left edge,
 * and 1352 of 2000 size combinations had at least one. Integer sizes never show
 * it, which is why the fixtures that only used integers could not see it.
 *
 * So the division only proposes, and the answer is then snapped against the
 * very expression `cellRect` lays cells out with. Whatever the arithmetic does
 * to `origin + i * step`, it does the same thing on both sides, and the two
 * functions invert each other by construction rather than by algebra. The walk
 * is bounded by `count`, and starts within one of the answer, so it is a step
 * or two in practice.
 */
function indexAt(pos, origin, step, count) {
  let i = Math.floor((pos - origin) / step);
  if (i < 0) i = 0;
  if (i > count - 1) i = count - 1;
  while (i < count - 1 && origin + (i + 1) * step <= pos) i++;
  while (i > 0 && origin + i * step > pos) i--;
  return i + 0;  // `Math.floor(-0.2)` is -0, and -0 fails deepStrictEqual against 0
}

/**
 * Which cell a point is in, or `null` for the name column, outside the diagram,
 * or a coordinate that is not a number.
 *
 * The two ends of the diagram follow from the same half-open rule rather than
 * from special cases: the name column's right edge is the first cell's left
 * edge and hits cycle 0, while the diagram's right edge has no next cell to
 * belong to and is outside.
 *
 * A cycle past the end of that particular lane still hits: the lane is shorter
 * than the diagram, painting there is how a lane gets extended, and the caller
 * can see it went past from `layout.lanes[laneIndex].cycles`.
 */
function cellAt(layout, x, y) {
  if (layout === null || typeof layout !== 'object' || !Array.isArray(layout.lanes)) {
    return null;
  }
  if (!isCoord(x) || !isCoord(y)) return null;
  if (y < 0 || y >= layout.height) return null;
  if (layout.lanes.length === 0 || layout.cycles === 0) return null;

  const laneIndex = indexAt(y, 0, layout.laneHeight, layout.lanes.length);
  const row = layout.lanes[laneIndex];
  if (x < row.originX || x >= row.originX + layout.cycles * row.cycleWidth) return null;

  return {
    laneIndex: laneIndex,
    cycle: indexAt(x, row.originX, row.cycleWidth, layout.cycles),
  };
}

/**
 * The box one cell occupies, or `null` if that cell is not in the diagram.
 *
 * The inverse of `cellAt` in the only sense that matters: the centre of what
 * this returns hit-tests back to the cell that was asked for, and so does its
 * top-left corner. A cycle past the diagram's width has no box, so extending a
 * lane is an edit the caller makes and then lays out again, not a rectangle it
 * can ask for in advance.
 */
function cellRect(layout, laneIndex, cycle) {
  if (layout === null || typeof layout !== 'object' || !Array.isArray(layout.lanes)) {
    return null;
  }
  if (!isIndex(laneIndex) || laneIndex < 0 || laneIndex >= layout.lanes.length) return null;
  if (!isIndex(cycle) || cycle < 0 || cycle >= layout.cycles) return null;

  const row = layout.lanes[laneIndex];
  return {
    x: row.originX + cycle * row.cycleWidth,
    y: row.y,
    width: row.cycleWidth,
    height: row.height,
  };
}

/** 端點把手的邊長（px）。夠大到手指按得到，小到不會蓋住相鄰格。 */
const EDGE_HANDLE = 12;

function centerOfCell(layout, laneIndex, cell) {
  const r = cellRect(layout, laneIndex, cell);
  if (r === null) return null;
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/**
 * 每條 edge 的兩個端點座標、SVG path 與標籤錨點。
 *
 * 字母的位置問 `codec.nodesOf(doc)`，不自己走樹——`layoutOf` 已經立下這個規矩
 * （它問 `codec.lanePaths`），第二份走樹邏輯會跟它漂移。用的是本檔案頂端那顆
 * 模組層級的 `codec`（`enumerateLanes`/`cyclesOf` 也是同一顆）：這個檔案已經
 * 對 `wave-codec.js` 有一份 `require`，purity guard 也只准這一份，injected 參數
 * 不會讓檔案更「純」，只會讓同名綁定的讀者分不清是哪一顆、也讓少傳一個參數的
 * 改動悄悄落回外層而不報錯。
 *
 * 引用到不存在字母的 edge 直接跳過：那是一份使用者手寫壞掉的文件，畫不出那條線
 * 是對的，讓整張圖倒掉不是。
 */
/**
 * `edgeLayout`'s three `continue`s, WITH the reason each one fired —
 * final review finding 3. `edgeLayout` itself stays a thin wrapper around
 * this (`.drawn`), so every existing caller keeps its array-of-drawn-edges
 * shape; a caller that also needs to explain a gap (`renderUnmodelled` in
 * `wave-ui.js`) asks this one instead of re-deriving any of the three checks
 * from scratch — there is exactly one walk of `doc.edge`, and exactly one
 * place that decides whether an entry counts as drawn.
 *
 * `skipped[i].reason` is one of:
 *   - `'unparseable'` — `codec.parseEdge` returned `null` (the shape is not
 *     one of `EDGE_SHAPES`, or the entry does not have `<letter><shape><letter>`
 *     to begin with). `edge` is `null`; there is no `from`/`to` to report.
 *   - `'dangling'` — the shape parsed, but `from` or `to` names a letter
 *     `codec.nodesOf` never placed anywhere in the document (a hand-edited or
 *     half-finished `edge:` array). This is the one case the pinned engine
 *     ALSO refuses to draw — measured against `node_modules/wavedrom`, an
 *     edge naming an absent letter renders nothing, same as here.
 *   - `'out-of-range'` — the shape parsed and both letters resolve to a real
 *     `{lane, cell}`, but that cell has no box in this layout: `centerOfCell`
 *     returned `null`, which happens when a lane's `node` string outlives the
 *     lane itself (`insertCycles`/`deleteCycles` narrow `wave` but do not
 *     reindex `node`, so a deleted cycle can leave an anchor past the lane's
 *     new length). Measured against the pinned engine, THIS case is the
 *     opposite of `'dangling'`: the engine draws a line for it anyway, so a
 *     silent skip here is exactly the canvas/preview divergence this version
 *     exists to prevent.
 *
 * Anything reaching this file only through `doc.edge` being non-empty but
 * `layout` being unusable, or `doc` itself not carrying an `edge` array,
 * still returns `{drawn: [], skipped: []}` — there is nothing to classify,
 * not a fourth reason.
 */
function edgeLayoutDetail(doc, layout) {
  const drawn = [];
  const skipped = [];
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.edge)) {
    return { drawn: drawn, skipped: skipped };
  }
  if (layout === null || typeof layout !== 'object') {
    return { drawn: drawn, skipped: skipped };
  }
  const nodes = codec.nodesOf(doc);
  for (let i = 0; i < doc.edge.length; i += 1) {
    const edge = codec.parseEdge(doc.edge[i]);
    if (edge === null) {
      skipped.push({ index: i, edge: null, reason: 'unparseable' });
      continue;
    }
    const a = nodes[edge.from];
    const b = nodes[edge.to];
    if (a === undefined || b === undefined) {
      skipped.push({ index: i, edge: edge, reason: 'dangling' });
      continue;
    }
    const from = centerOfCell(layout, a.at, a.cell);
    const to = centerOfCell(layout, b.at, b.cell);
    if (from === null || to === null) {
      skipped.push({ index: i, edge: edge, reason: 'out-of-range' });
      continue;
    }
    from.at = a.at; from.cell = a.cell;
    to.at = b.at; to.cell = b.cell;
    drawn.push({
      index: i,
      edge: edge,
      from: from,
      to: to,
      d: pathFor(edge.shape, from, to),
      labelPos: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
    });
  }
  return { drawn: drawn, skipped: skipped };
}

function edgeLayout(doc, layout) {
  return edgeLayoutDetail(doc, layout).drawn;
}

/**
 * 折線（`-|` 系）三種轉角次序，抄自 pin 住的
 * node_modules/wavedrom/lib/arc-shape.js 的三組 case（座標系裡的 `m` 相對位移
 * 換成這裡的絕對 `L`）：
 *
 *   - MID：先橫走半程、再直走全程、再橫走半程——轉角在 `(from.x+to.x)/2`。
 *   - VERT_FIRST：先直（`from.x, to.y`）再橫——`|-` 系，垂直先行。
 *   - 其餘（HORIZ_FIRST）：先橫（`to.x, from.y`）再直——`-|` 系，水平先行。
 *
 * 三個陣列各自窮舉 EDGE_SHAPES 裡屬於這族的每個成員（含箭頭與雙箭頭變體），
 * 用精確字串比對而非子字串——shape 一律來自 `codec.parseEdge` 收斂過的
 * EDGE_SHAPES 集合，不會有夾雜字元，子字串比對（舊寫法 `has('|')`）分不出
 * `-|` 與 `|-` 誰先誰後，是這裡曾經量到的缺陷。
 */
const ELBOW_MID = ['-|-', '-|->', '<-|->'];
const ELBOW_VERT_FIRST = ['|-', '|->'];
const ELBOW_HORIZ_FIRST = ['-|', '-|>', '<-|>'];

/**
 * 形狀 → SVG path。
 *
 * 三族：直線（`-` 系）、曲線（`~` 系）、折線（`-|` 系）。箭頭本身不在 path 裡，
 * 由 UI 掛 marker——這裡只負責「線走哪裡」。
 */
function pathFor(shape, from, to) {
  if (ELBOW_MID.indexOf(shape) !== -1) {
    const midX = (from.x + to.x) / 2;
    return 'M' + from.x + ',' + from.y + ' L' + midX + ',' + from.y +
      ' L' + midX + ',' + to.y + ' L' + to.x + ',' + to.y;
  }
  if (ELBOW_VERT_FIRST.indexOf(shape) !== -1) {
    return 'M' + from.x + ',' + from.y + ' L' + from.x + ',' + to.y +
      ' L' + to.x + ',' + to.y;
  }
  if (ELBOW_HORIZ_FIRST.indexOf(shape) !== -1) {
    return 'M' + from.x + ',' + from.y + ' L' + to.x + ',' + from.y +
      ' L' + to.x + ',' + to.y;
  }
  const has = function (s) { return shape.indexOf(s) !== -1; };
  if (has('~')) {
    const dx = (to.x - from.x) / 2;
    return 'M' + from.x + ',' + from.y +
      ' C' + (from.x + dx) + ',' + from.y + ' ' + (to.x - dx) + ',' + to.y +
      ' ' + to.x + ',' + to.y;
  }
  return 'M' + from.x + ',' + from.y + ' L' + to.x + ',' + to.y;
}

/** 端點把手的矩形，以端點為中心。 */
function edgeHandleRect(point) {
  return {
    x: point.x - EDGE_HANDLE / 2,
    y: point.y - EDGE_HANDLE / 2,
    width: EDGE_HANDLE,
    height: EDGE_HANDLE,
  };
}

/**
 * `(x, y)` 命中哪一個端點把手。
 *
 * 用的是 `edgeHandleRect` 產生的同一個矩形——命中與繪製共用一個運算式，
 * 就像 `cellAt` 是 `cellRect` 的構造反函數。另寫一份圓形碰撞會慢慢跟畫面分家。
 */
function edgeHandleAt(edges, x, y) {
  if (!Array.isArray(edges)) return null;
  for (let i = edges.length - 1; i >= 0; i -= 1) {
    for (const end of ['to', 'from']) {
      const r = edgeHandleRect(edges[i][end]);
      if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) {
        return { index: edges[i].index, end: end };
      }
    }
  }
  return null;
}

module.exports = {
  layoutOf: layoutOf,
  valueAt: valueAt,
  groupSpansOf: groupSpansOf,
  cellAt: cellAt,
  cellRect: cellRect,
  edgeLayout: edgeLayout,
  edgeLayoutDetail: edgeLayoutDetail,
  edgeHandleRect: edgeHandleRect,
  edgeHandleAt: edgeHandleAt,
  EDGE_HANDLE: EDGE_HANDLE,
  DEFAULTS: DEFAULTS,
  MAX_LANES: MAX_LANES,
  SKIN_METRICS: SKIN_METRICS,
};
