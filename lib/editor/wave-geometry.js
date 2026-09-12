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
 * Sizes to use when the caller has nothing better, taken from the same
 * measurement: the engine's row pitch is 30 (lanes at y 5, 35, 65, 95), a cycle
 * is 40 wide (svg width grows 40 per cycle), and the name column of a
 * short-named, ungrouped diagram comes out 40.
 */
const DEFAULTS = { laneHeight: 30, cycleWidth: 40, nameColWidth: 40 };

/** How far the lane walk is allowed to run before it is a bug, not a document. */
const MAX_LANES = 4096;
/** How deep a group nest is worth walking while sizing that bound. */
const MAX_DEPTH = 64;

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
 * An upper bound on how many lanes the document can hold: every non-array
 * object reachable through the lane arrays. This is a loop bound only — which
 * lane is which, and in what order, is still the codec's answer alone.
 */
function laneBound(node, depth) {
  if (depth > MAX_DEPTH || !Array.isArray(node)) return 0;
  let n = 0;
  for (const member of node) {
    if (Array.isArray(member)) n += laneBound(member, depth + 1);
    else if (member !== null && typeof member === 'object') n += 1;
  }
  return n;
}

/**
 * Every lane of the document, in display order, each with the codec's own path
 * to it. The codec is asked position by position and stops the walk itself, so
 * there is no second enumeration to disagree with. The bound is a guard against
 * a caller-built document that answers forever, and reaching it is reported
 * rather than silently truncated.
 */
function enumerateLanes(doc) {
  const out = [];
  const bound = Math.min(laneBound(doc && doc.signal, 0), MAX_LANES);
  for (let i = 0; ; i++) {
    const path = codec.lanePath(doc, i);
    if (path === null) return out;
    if (i >= bound) {
      throw new Error('wave-geometry: lane enumeration ran past ' + bound + ' lanes');
    }
    out.push({ path: path, lane: valueAt(doc, path) });
  }
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
 * `width` spans the whole diagram, name column included; `cycles` is the
 * longest lane, which is how the engine sizes itself too.
 */
function layoutOf(doc, opts) {
  const o = opts || {};
  const laneHeight = size(o.laneHeight, DEFAULTS.laneHeight, 'laneHeight', false);
  const cycleWidth = size(o.cycleWidth, DEFAULTS.cycleWidth, 'cycleWidth', false);
  const nameColWidth = size(o.nameColWidth, DEFAULTS.nameColWidth, 'nameColWidth', true);

  const found = enumerateLanes(doc);
  const lanes = [];
  let cycles = 0;
  for (let i = 0; i < found.length; i++) {
    const laneCycles = cyclesOf(found[i].lane);
    if (laneCycles > cycles) cycles = laneCycles;
    lanes.push({
      index: i,
      y: i * laneHeight,
      height: laneHeight,
      cycles: laneCycles,
      depth: found[i].path.length - 2,
      path: found[i].path,
      lane: found[i].lane,
    });
  }

  return {
    laneHeight: laneHeight,
    cycleWidth: cycleWidth,
    nameColWidth: nameColWidth,
    lanes: lanes,
    cycles: cycles,
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
 * Which cell a point is in, or `null` for the name column, outside the diagram,
 * or a coordinate that is not a number.
 *
 * The boundary rule is the whole point of this function: every edge belongs to
 * the cell on its RIGHT, and every row line to the row BELOW it. That falls out
 * of flooring a half-open interval `[start, start + width)` and nothing else —
 * no rounding, no epsilon. The two ends follow from the same rule rather than
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

  const laneIndex = Math.floor(y / layout.laneHeight);
  if (laneIndex < 0 || laneIndex >= layout.lanes.length) return null;
  const cycle = Math.floor((x - layout.nameColWidth) / layout.cycleWidth);
  if (cycle < 0 || cycle >= layout.cycles) return null;

  return { laneIndex: laneIndex, cycle: cycle };
}

/**
 * The box one cell occupies, or `null` if that cell is not in the diagram.
 *
 * The inverse of `cellAt` in the only sense that matters: the centre of what
 * this returns hit-tests back to the cell that was asked for. A cycle past the
 * diagram's width has no box, so extending a lane is an edit the caller makes
 * and then lays out again, not a rectangle it can ask for in advance.
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
};
