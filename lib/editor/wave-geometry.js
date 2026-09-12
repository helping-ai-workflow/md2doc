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
 * Enumeration costs O(N²) — each position is a separate question to the codec,
 * which walks the tree to answer — and that is measured, not feared: 95ms at
 * 1000 lanes, 337ms at 2000, 1259ms at 4096. A wave diagram with more lanes
 * than this is not a diagram, and the layer above calls this on every render,
 * so past the ceiling the layout is truncated and says so on the way out.
 * Truncating rather than raising is deliberate: the source is the user's
 * markdown, and a fence the codec's parser accepts must never take the editor
 * down. A broken document lays out as best it can; only a broken SIZE raises,
 * because that is caller code.
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
  if (typeof opts !== 'object' || Array.isArray(opts)) {
    throw new TypeError('wave-geometry: opts must be an object, got ' + typeof opts);
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
 * to it. The codec is asked position by position and stops the walk itself, so
 * there is no second enumeration to disagree with — and no second answer to the
 * question of which lane is the third one.
 */
function enumerateLanes(doc) {
  const out = [];
  for (let i = 0; i < MAX_LANES; i++) {
    const path = codec.lanePath(doc, i);
    if (path === null) return { lanes: out, truncated: false };
    out.push({ path: path, lane: valueAt(doc, path) });
  }
  return { lanes: out, truncated: codec.lanePath(doc, MAX_LANES) !== null };
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
 */
function layoutOf(doc, opts) {
  const o = options(opts);
  const laneHeight = size(o.laneHeight, DEFAULTS.laneHeight, 'laneHeight', false);
  const cycleWidth = size(o.cycleWidth, DEFAULTS.cycleWidth, 'cycleWidth', false);
  const nameColWidth = size(o.nameColWidth, DEFAULTS.nameColWidth, 'nameColWidth', true);

  const found = enumerateLanes(doc);
  const lanes = [];
  let cycles = 0;
  for (let i = 0; i < found.lanes.length; i++) {
    const laneCycles = cyclesOf(found.lanes[i].lane);
    if (laneCycles > cycles) cycles = laneCycles;
    lanes.push({
      index: i,
      y: i * laneHeight,
      height: laneHeight,
      cycles: laneCycles,
      depth: found.lanes[i].path.length - 2,
      path: found.lanes[i].path,
      lane: found.lanes[i].lane,
    });
  }
  if (lanes.length > 0 && cycles === 0) cycles = 1;

  return {
    laneHeight: laneHeight,
    cycleWidth: cycleWidth,
    nameColWidth: nameColWidth,
    lanes: lanes,
    cycles: cycles,
    truncated: found.truncated,
    width: nameColWidth + cycles * cycleWidth,
    height: lanes.length * laneHeight,
  };
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
  return i;
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
  if (x < layout.nameColWidth || x >= layout.width) return null;
  if (y < 0 || y >= layout.height) return null;
  if (layout.lanes.length === 0 || layout.cycles === 0) return null;

  return {
    laneIndex: indexAt(y, 0, layout.laneHeight, layout.lanes.length),
    cycle: indexAt(x, layout.nameColWidth, layout.cycleWidth, layout.cycles),
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
    x: layout.nameColWidth + cycle * layout.cycleWidth,
    y: row.y,
    width: layout.cycleWidth,
    height: row.height,
  };
}

module.exports = {
  layoutOf: layoutOf,
  cellAt: cellAt,
  cellRect: cellRect,
  DEFAULTS: DEFAULTS,
  MAX_LANES: MAX_LANES,
};
