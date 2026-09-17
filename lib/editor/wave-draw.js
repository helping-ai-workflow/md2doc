'use strict';

/**
 * The canvas drawing layer.
 *
 * The nine functions moved out of `wave-ui.js`, behaviour unchanged line for
 * line -- this module is a pure move, not a rewrite. The interface is a
 * factory: `wave-ui.js` hands in its own `document`, `geometry`, `codec` and
 * `SIZES` (plus a handful of small helpers/constants the moved functions
 * turned out to depend on -- see task-1-report.md for the exact list), and
 * gets back a set of drawing functions closed over those dependencies.
 *
 * This layer does not require `wave-panels.js` (the dependency direction is
 * one-way, see the plan's File Structure). Any state the drawing functions
 * need from the dialog is passed in per call, either via an explicit
 * parameter (the SVG element being drawn into) or via the `state` parameter,
 * a plain data object the caller builds fresh for each call.
 */

function createDrawer(deps) {
  const d = deps.d;
  const geometry = deps.geometry;
  const codec = deps.codec;
  const SIZES = deps.SIZES;
  const SVGNS = deps.SVGNS;
  const BRUSHES = deps.BRUSHES;
  const labelsOf = deps.labelsOf;

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
   * cell's own top-left; `d.createElementNS` callers translate it onto the
   * real canvas — see `drawLane`'s `translatePath`).
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
   * The set of brick-id PAIRS `brickPath`'s straight ramp applies to.
   *
   * v3.6.0 Task 7 fix round 2 (ruling R24): this used to be a DENY-list
   * (exclude bus/xxx/clock, ramp everything else), which silently opted
   * `zzz`/`uuu`/`ddd` into the same straight-line ramp shape as `000`/`111`
   * even though nobody had measured whether the engine actually draws them
   * that way. It does not. MEASURED against `node_modules/wavedrom` 3.5.0's
   * `waveSkin` — every brick a transition touching `z`/`u`/`d` can produce:
   *
   *     0mz  "m0,20 3,0 C 10,10 15,10 20,10"     curve; reaches mid only at x=20 (ratio 0.5)
   *     1mz  "m0,0 3,0 c 7,10 12,10 17,10"       curve
   *     zm1  "M0,10 6,10 9,0 20,0"               ramp starts at x=6 (0.15), not x=3
   *     zm0  "m0,10 6,0 3,10 11,0"               same: ramp 6->9, not 3->9
   *     0mu  "m0,20 3,0 C 7,10 10.107603,0 20,0" curve
   *     um0  "m0,0 3,0 6,20 11,0"                straight 3->9 -- matches ours by coincidence
   *     0md  "m8,20 10,0"                        a stub, not a ramp at all
   *     1mu  "M0,0 5,0"                          a stub, not a ramp at all
   *
   * Only `0m1`/`1m0` (see `brickPath`'s own comment) are the straight
   * `slewStartRatio`-to-`slewEndRatio` ramp this file draws. Everything
   * else touching `z`/`u`/`d` either curves, starts its ramp at a different
   * ratio, or isn't a ramp at all, so this is now an ALLOW-list of exactly
   * the measured, straight case (`000`<->`111`) rather than a deny-list of
   * the shapes known not to work — a deny-list opts every brick nobody has
   * measured yet INTO unverified new behaviour by default; an allow-list
   * makes the next brush someone adds default back to the pre-existing
   * vertical `<line>` instead. Bus (hexagon) and `xxx` (box) already carry
   * their own slanted/boxed edges and stay out of scope the same way; clock
   * bricks draw a whole period with their own sharp vertical edges built in
   * (MEASURED: `pclk`/`nclk` are plain verticals, `'M0,20 0,0 20,0'`/
   * `'m0,0 0,20 20,0'`, no ramp at all) and never reach here (`drawLane`'s
   * `!isClock` guard on both sides).
   *
   * Deliberately checked on the BRICK ids, not on the level chars
   * `lineLevelOf` returns: `lineLevelOf('uuu') === '1'`, same as `'111'`,
   * so a check written against the level chars would let `uuu` straight
   * back through this allow-list.
   */
  function isRampPair(a, b) {
    return (a === '000' || a === '111') && (b === '000' || b === '111');
  }

  /**
   * `brickPath`'s own `yFor` wants a level char, not a brick id. Now that
   * `isRampPair` (R24) only ever admits `000`/`111`, this only ever sees
   * those two — it does not need to (and must not silently claim to) cover
   * `zzz`/`uuu`/`ddd` any more.
   */
  function lineLevelOf(brick) {
    return brick === '111' ? '1' : '0';
  }

  /**
   * `brickPath` returns LOCAL coordinates (matching how
   * `test/wave-draw.test.js` calls it directly) — every other shape in this
   * file is drawn in absolute canvas coordinates with no `transform`
   * attribute anywhere, so this shifts the returned path onto the cell it
   * is actually drawn at rather than introducing the one `transform` this
   * file would otherwise have.
   */
  function translatePath(pathStr, dx, dy) {
    return pathStr.replace(/(-?[0-9.]+),(-?[0-9.]+)/g, function (_, x, y) {
      return (Number(x) + dx) + ',' + (Number(y) + dy);
    });
  }

  /**
   * The hand-drawn waveform.
   *
   * Every cycle's picture comes from `codec.levelsOf` through `brickOf`, and
   * from nowhere else — constraint 3. The levels and the bricks are both
   * published on the element (`data-levels-N`, `data-bricks-N`) so the
   * agreement with the preview beside it is something a test can measure
   * rather than something this comment can promise: the preview's own SVG
   * names its bricks in its `<use xlink:href="#…">` list.
   *
   * v3.6.0 Task 1: this function WRITES BACK through two of its own
   * parameters, not only through the DOM it builds — `state.cursor` and
   * `state.selection` are clamped in place (a document that got shorter can
   * leave either pointing past the end), and the return value is a brand new
   * `<svg>` that replaces the one `canvas` named on the way in. The caller in
   * wave-ui.js is expected to read `state.cursor`/`state.selection` back into
   * its own locals and reassign its own `canvas` from the return value —
   * see every `wds`/`canvas = drawer.renderCanvas(...)` call site there. The
   * round trip is the price of the split: the alternative is this drawing
   * layer holding a live reference to the dialog's own variables, which is
   * exactly the coupling moving it into its own module is meant to remove.
   */
  /**
   * The name column, drawn on the canvas itself.
   *
   * The lane rail (`wave-panels.js`) already shows every name — this is
   * deliberate duplication, not an oversight. The rail is the OPERATING
   * surface (select, reorder, rename); the canvas is a MIRROR of what the
   * engine's own preview renders. The engine's output has names on it, so a
   * user comparing the hand-drawn canvas against the preview beside it
   * should not have to align two separate columns by eye to know which row
   * is which.
   *
   * v3.6.0 Task 8 (R? — see task-8-report.md): these are flat children of
   * the canvas `<svg>`, appended in the same paint pass as every brick and
   * edge, which is exactly what makes them a landmine for
   * `test/editor-journey.test.js`'s T6b: its `paintedCounts` classifies a
   * shape into a lane's row purely by the shape's vertical center (`cy`),
   * with NO x-bound — so any shape whose `cy` falls inside a lane's row
   * band counts toward that lane's painted-shape total, wherever it sits on
   * the x axis. A lane-name label is drawn at exactly that lane's row
   * center, so without an exclusion it would inflate every lane's count by
   * one and desync `paintedCounts` from `expectedCounts` (the engine's own
   * run count) on every fixture that has named lanes — which is all of
   * them. `.ed-wave-lane-label` / `.ed-wave-group-label` are NOT in T6b's
   * `shapes` exclusion list (`ed-wave-grid` / `-selection` / `-cursor` /
   * `-gap` / `-buslabel` / `-edge`) as of this commit — T6b's filter needs
   * to grow those two classes before that suite can pass. Per this task's
   * brief: "Do not change T6b yourself" — flagged in task-8-report.md
   * instead of edited here.
   */
  const NAME_GAP = 10;
  const GROUP_INDENT = 12;

  function drawNames(svg, doc, layout) {
    for (let i = 0; i < layout.lanes.length; i += 1) {
      const row = layout.lanes[i];
      const name = typeof row.lane.name === 'string' ? row.lane.name : '';
      if (name === '') continue;
      const t = d.createElementNS(SVGNS, 'text');
      t.setAttribute('class', 'ed-wave-lane-label');
      t.setAttribute('x', layout.nameColWidth - NAME_GAP);
      t.setAttribute('y', row.y + row.height / 2);
      t.setAttribute('text-anchor', 'end');
      t.setAttribute('dominant-baseline', 'middle');
      t.appendChild(d.createTextNode(name));
      svg.appendChild(t);
    }
  }

  /**
   * The group titles — v3.5.0 measured against the pinned engine (and
   * `wave-geometry.js`'s own `groupSpansOf` comment repeats it): a group
   * title occupies horizontal space in the name column, never a row of its
   * own. So each title here is one vertical (`writing-mode: vertical-rl`,
   * matching the rail's own `.ed-wave-group` styling in `lib/md2doc.js`)
   * label spanning its lanes' rows, indented from the LEFT edge of the name
   * column by nesting depth — depth 1 (outermost) sits in the leftmost
   * `GROUP_INDENT`-wide strip, each deeper level one strip further right,
   * the same left-to-right order the rail's own tags use. A lane's own name
   * always right-aligns at the same `nameColWidth - NAME_GAP` regardless of
   * depth (see `drawNames`); Task 8's measurement (task-8-report.md) checks
   * the longest fixture name still clears that fixed edge even at the
   * deepest strip a group label reserves.
   */
  function drawGroupLabels(svg, doc, layout) {
    const spans = geometry.groupSpansOf(doc, layout);
    for (let i = 0; i < spans.length; i += 1) {
      const span = spans[i];
      const from = layout.lanes[span.from];
      const to = layout.lanes[span.to];
      const t = d.createElementNS(SVGNS, 'text');
      t.setAttribute('class', 'ed-wave-group-label');
      t.setAttribute('x', (span.depth - 0.5) * GROUP_INDENT);
      t.setAttribute('y', (from.y + to.y + to.height) / 2);
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('dominant-baseline', 'middle');
      t.appendChild(d.createTextNode(span.title));
      svg.appendChild(t);
    }
  }

  /**
   * The cycle ruler and the head/foot bands.
   *
   * v3.5.0 shipped eight WaveJSON banner fields (`head.text`/`tick`/`tock`/
   * `every` and the four `foot.*` equivalents) that the hand-drawn canvas
   * never painted — filling one in changed nothing a user could see without
   * opening the preview. v3.6.0 Task 6 already made room for this (`layout`'s
   * `originY`/`rulerHeight`/`headTextHeight`/`footHeight`); this task paints
   * into that room.
   *
   * v3.6.0 Task 9 fix round 1 (ruling R29): foot gets TWO stacked bands, the
   * same as head — `footHeight` (the tick band, adjacent to the last lane)
   * and `footTextHeight` (the title band, stacked beyond it). Before this
   * fix `footHeight` was the only band and `foot.text`/`foot.tick` shared
   * one y, so a document setting both drew them on top of each other. The
   * engine agrees a document can set both at once (`parse-config.js`'s
   * `yf0`/`yf1`, mirroring `yh0`/`yh1` for head) — see
   * `wave-geometry.js`'s own comment above `FOOT_TEXT_HEIGHT` for why the
   * STRUCTURE (two bands) mirrors the engine while the pixel heights do not.
   *
   * `tick` labels sit ON cycle boundaries (`cycles + 1` of them); `tock`
   * labels sit at cycle CENTRES (`cycles` of them) — MEASURED against
   * `node_modules/wavedrom` 3.5.0's `lib/render-marks.js` `renderMarks()`:
   * `ticktock(lane, 'head', 'tick', 0, mmstep, -5, marks + 1)` vs
   * `ticktock(lane, 'head', 'tock', mmstep / 2, mmstep, -5, marks)` — the
   * `mmstep / 2` starting x and the `marks` (not `marks + 1`) length are the
   * engine's own distinction, not one invented here.
   *
   * `every` is "every N cycles" — but MEASURED against that same
   * `ticktock()`, the engine's own filter is
   * `(i + offset) % cxt[ref1].every != 0`, anchored to the SAME base the
   * label values are built from (`offset = Number(head.tick)`, etc), not a
   * bare `i % every`. Live-rendered check (dumped, not recalled):
   * `{signal:[{name:'a',wave:'0101'}],head:{tick:3,every:2}}` keeps exactly
   * two ticks, `"4"` and `"6"` (`i=1,3`; `(1+3)%2===0`) — `i=0,2,4` all drop
   * (`(0+3)%2===1`). A bare `c % every` would instead keep `i=0,2,4`
   * (values 3/5/7) — three ticks, not two, and the wrong ones. Pinned by
   * `test/wave-draw.test.js`'s "every 錨在 (index+base)" case.
   *
   * Read-only with respect to the document: an absent field means no mark,
   * full stop. `setBannerField` (wave-codec.js) is the only place that
   * writes these keys, and it already deletes the key rather than writing
   * `''` — the engine's own `captext` uses a truthy test while its
   * `ticktock` uses `=== undefined`, so a stray `''` here would make the
   * latter think the field was "set, draw the default ruler". This layer
   * must not "fix" that by normalizing anything itself.
   *
   * v3.6.0 Task 9 fix round 2 (ruling R30): the tick/tock boundary count and
   * pitch come from `diagramCycleCount`/`diagramPitch` below — the DIAGRAM's
   * own extent — never from a lane's own `cycles`/`cycleWidth`/`originX`.
   * See those two functions' own comment for why: `layout.cycles` counts
   * CELLS, not diagram cycles, and a lane's own `cycleWidth`/`originX` are
   * deliberately distorted by THAT lane's `period`/`phase`/`hscale` (Task 4)
   * — right for painting that one lane's bricks, wrong for an overlay drawn
   * once for the whole canvas.
   */
  function drawRuler(svg, doc, layout) {
    drawBand(svg, doc, layout, 'head');
    drawBand(svg, doc, layout, 'foot');
  }

  /**
   * The diagram-wide cycle pitch (px per diagram cycle) and how many
   * boundaries that pitch divides `layout.width` into — shared by the ruler
   * (`drawBand`, below) and the cycle grid (`renderCanvas`'s own "cycle
   * grid" section), so there is exactly one place that computes it rather
   * than two that can drift apart.
   *
   * MEASURED (`period: 4`, `head:{tick:0}`, against `node_modules/wavedrom`
   * 3.5.0): the engine draws 17 ticks, values 0..16, 40px apart, on a 700px
   * canvas — not `layout.cycles + 1` (5), which is what a lane's own CELL
   * count gives. `layout.cycles` is `codec.levelsOf(wave).length`, i.e. a
   * count of CELLS, and with `period: 4` one cell IS four diagram cycles —
   * the same failure family this repo's CLAUDE.md already names ("node
   * string indices are CELLS, while the drawing thinks in CYCLES"),
   * invisible before Task 4 because cells and diagram cycles were the same
   * number for every period-1 document. A per-lane `row.cycleWidth`/
   * `row.originX` does not fix it either (it is a PITCH bug, not just a
   * COUNT bug) — those already carry that same lane's `period`, so reading
   * lane 0's alone is right for lane 0's own bricks and wrong for a ruler
   * drawn once, diagram-wide.
   *
   * Derived from `layout.width` — never a second cycle-count field of its
   * own — so the ruler is structurally incapable of disagreeing with the
   * canvas's own extent: `(width - nameColWidth) / (cycleWidth * hscale)`.
   * Checked against the engine on two fixtures before landing:
   *   `period: 4`             → (888 − 120) / 48        + 1 = 17 ticks (engine: 17)
   *   `hscale: 2, period: 1`  → (504 − 120) / 96         + 1 =  5 ticks (engine: 5)
   * `hscale` scales the PITCH (the engine's own `mmstep = 2 * hscale * xs`),
   * not the count, which is why it multiplies `cycleWidth` here rather than
   * dividing the span by it. `Math.round` absorbs the float noise a
   * fractional `laneHeight`/`cycleWidth`/`nameColWidth` size leaves in
   * `layout.width` (each lane's own `cycleWidth`/`originX` is one
   * multiplication away from exact) — the true count is structurally an
   * integer (`layoutOf` only ever widens `width` by whole `period`-scaled
   * cells), so rounding cannot paper over a real off-by-one the way it
   * would for a value with no reason to land on an integer.
   */
  function diagramPitch(layout) {
    return layout.cycleWidth * layout.hscale;
  }

  function diagramCycleCount(layout) {
    const pitch = diagramPitch(layout);
    if (!(pitch > 0)) return 0;
    const span = layout.width - layout.nameColWidth;
    if (!(span > 0)) return 0;
    return Math.round(span / pitch);
  }

  function drawBand(svg, doc, layout, which) {
    const b = (doc !== null && typeof doc === 'object' &&
      doc[which] !== null && typeof doc[which] === 'object') ? doc[which] : null;
    if (b === null) return;
    const isHead = which === 'head';
    // Head: title band (0..headTextHeight) stacked ABOVE the ruler band
    // (headTextHeight..originY). Foot: tick band (originY+lanes*laneHeight
    // .. that + footHeight) stacked BELOW the title band beyond it (R29) —
    // the mirror image, title band on the outer edge, tick band against the
    // lanes, matching the engine's own captext y (further from the lanes
    // than its ticktock y, both for head and for foot).
    const textY = isHead
      ? layout.headTextHeight / 2
      : layout.height - layout.footTextHeight / 2;
    const scaleY = isHead
      ? layout.headTextHeight + layout.rulerHeight / 2
      : layout.height - layout.footTextHeight - layout.footHeight / 2;

    if (typeof b.text === 'string' && b.text !== '') {
      const t = d.createElementNS(SVGNS, 'text');
      t.setAttribute('class', isHead ? 'ed-wave-head-text' : 'ed-wave-foot-text');
      t.setAttribute('x', layout.width / 2);
      t.setAttribute('y', textY);
      t.setAttribute('text-anchor', 'middle');
      t.appendChild(d.createTextNode(b.text));
      svg.appendChild(t);
    }

    const every = (typeof b.every === 'number' && isFinite(b.every) && b.every > 0)
      ? Math.floor(b.every) : 1;
    // No lanes, no diagram to rule off of — same "draw nothing" this branch
    // already had before round 2 (the guard used to be `row === null`, a
    // per-lane check; the diagram-wide replacement is `layout.lanes.length`
    // itself, since `diagramCycleCount` has no lane to read at all here).
    if (layout.lanes.length === 0) return;
    const pitch = diagramPitch(layout);
    const boundaries = diagramCycleCount(layout);

    if (b.tick !== undefined) {
      const base = Number(b.tick);
      for (let c = 0; c <= boundaries; c += 1) {
        if ((c + base) % every !== 0) continue;
        const t = d.createElementNS(SVGNS, 'text');
        t.setAttribute('class', 'ed-wave-ruler-tick');
        t.setAttribute('x', layout.nameColWidth + c * pitch);
        t.setAttribute('y', scaleY);
        t.setAttribute('text-anchor', 'middle');
        t.appendChild(d.createTextNode(String(base + c)));
        svg.appendChild(t);
      }
    }
    if (b.tock !== undefined) {
      const base = Number(b.tock);
      for (let c = 0; c < boundaries; c += 1) {
        if ((c + base) % every !== 0) continue;
        const t = d.createElementNS(SVGNS, 'text');
        t.setAttribute('class', 'ed-wave-ruler-tock');
        t.setAttribute('x', layout.nameColWidth + (c + 0.5) * pitch);
        t.setAttribute('y', scaleY);
        t.setAttribute('text-anchor', 'middle');
        t.appendChild(d.createTextNode(String(base + c)));
        svg.appendChild(t);
      }
    }
  }

  function renderCanvas(canvas, doc, layout, state) {
    // v3.5.0 Task 11: the data-label field's node sits beside the canvas
    // SVG inside `canvasWrap` (see `openDataEdit`), and the wipe two lines
    // below (`canvasWrap.textContent = ''`) would tear it out from under
    // the user on the very next cursor move if this did not retire it
    // first — every path that reaches this function counts, not only
    // `render()`, which is why this lives HERE and not only next to
    // `groupRename.retire()` in `render()` itself.
    if (state.dataEdit !== null) state.dataEdit.retire();
    // Every repaint REPLACES the canvas element, so a canvas that had the
    // keyboard loses it to `document.body` the instant it is detached —
    // exactly the state F7 and T6h exist to prevent, and here it would fire
    // on every arrow key. `render()`'s own `data-focus-key` restore covers
    // the full-repaint path; this covers the three that call renderCanvas
    // directly (a drag's two, and the keyboard's own), so the property holds
    // for the canvas no matter which road the repaint came down.
    const hadFocus = canvas !== null && d.activeElement === canvas;
    // The cursor is an index pair, and the document under it can get shorter:
    // deleting cycles or removing the bottom lane leaves it pointing past the
    // end. Clamped HERE, where the layout that decides what "past the end"
    // means is already in hand — so nothing downstream ever has to ask.
    if (state.cursor !== null) {
      if (layout.lanes.length === 0 || layout.cycles === 0) {
        state.cursor = null;
      } else {
        state.cursor = {
          laneIndex: Math.max(0, Math.min(state.cursor.laneIndex, layout.lanes.length - 1)),
          cycle: Math.max(0, Math.min(state.cursor.cycle, layout.cycles - 1)),
        };
      }
    }
    // …and `selection` with it, which is the other half of the same fact and
    // was left out of the first cut. Measured before this: Shift-select four
    // cycles, press 刪除 cycle, and a one-cycle document was left with the
    // cursor on cycle 1, no visible box, 複製 reporting「複製了 4 個 cycle」
    // and 貼上（插入）growing the document back to five. The toolbar was
    // acting on a range the drawing no longer had anywhere to put.
    //
    // The two axes are not treated alike, and that is the point: a CYCLE
    // range that overshoots is the same range in a shorter document, so it
    // clamps; a LANE that is gone is not a lane the user can have meant, so
    // the selection goes rather than silently moving to whichever lane
    // inherited the index. (`lane ✕` already nulls it on its own path; this
    // catches the undo/redo of that.)
    //
    // It does NOT catch every route, and the earlier wording here said it
    // did. MEASURED: `＋` at 0, drag-select cycles 1-3 on the new lane 0,
    // then Ctrl+Z — the selection box and the rail highlight both stay on
    // row 0, which is now `clk`. The trace-derived marks above fix the
    // CURSOR for that case; the selection is still carried by row number,
    // so it lands on whoever inherited the row. The cost is confined to the
    // highlight and to where the next Shift+arrow anchors, because every
    // cycle operation is document-wide — but it is a real gap, not a
    // covered one.
    if (state.selection !== null) {
      if (layout.lanes.length === 0 || layout.cycles === 0 ||
          state.selection.laneIndex < 0 || state.selection.laneIndex >= layout.lanes.length) {
        state.selection = null;
      } else {
        state.selection = {
          laneIndex: state.selection.laneIndex,
          from: Math.max(0, Math.min(state.selection.from, layout.cycles - 1)),
          to: Math.max(0, Math.min(state.selection.to, layout.cycles - 1)),
        };
      }
    }
    state.canvasWrap.textContent = '';
    canvas = d.createElementNS(SVGNS, 'svg');
    canvas.setAttribute('class', 'ed-wave-canvas');
    // In the Tab cycle, and therefore in the focus trap, like every other
    // control in here: the drawing is this dialog's main surface and was the
    // one thing in it a keyboard could not reach.
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('data-focus-key', 'canvas');
    canvas.setAttribute('aria-label',
      '波形繪圖區：方向鍵移動游標，Shift+左右鍵選一段 cycle，' +
      '按電位字元（' + BRUSHES.join(' ') + '）塗上去');
    const width = Math.max(layout.width, SIZES.cycleWidth);
    canvas.setAttribute('width', String(width));
    canvas.setAttribute('height', String(Math.max(layout.height, layout.laneHeight)));
    canvas.setAttribute('viewBox', '0 0 ' + width + ' ' +
      Math.max(layout.height, layout.laneHeight));
    canvas.setAttribute('data-lane-count', String(layout.lanes.length));
    canvas.setAttribute('data-cycle-count', String(layout.cycles));
    // v3.6.0 Task 6 (ruling R18): the geometry the layout actually used, so a
    // caller measuring the rendered SVG (a puppeteer test, in particular)
    // reads these rather than re-deriving lane pitch / cycle pitch by
    // dividing `getBoundingClientRect()` by a count — that division silently
    // breaks the moment the canvas carries a ruler band or a name column,
    // because the SVG's total width/height then includes space no lane or
    // cycle occupies. Written straight from `layout`, never recomputed here.
    // `originX`/`cycleWidth` are lane 0's own (Task 4 made both per-lane via
    // `period`/`phase`/`hscale`); a document with no lanes falls back to the
    // layout-level `nameColWidth`/`cycleWidth` so the attributes are still
    // present (and still correct — an empty canvas has no cell to disagree).
    const originRow = layout.lanes.length > 0 ? layout.lanes[0] : null;
    canvas.setAttribute('data-origin-x', String(originRow !== null ? originRow.originX : layout.nameColWidth));
    canvas.setAttribute('data-origin-y', String(layout.originY));
    canvas.setAttribute('data-lane-height', String(layout.laneHeight));
    canvas.setAttribute('data-cycle-width', String(originRow !== null ? originRow.cycleWidth : layout.cycleWidth));

    // cycle grid
    // v3.6.0 Task 6: shifted by `layout.nameColWidth` — this grid is drawn
    // once for the whole canvas at the diagram's default (phase 0) cycle
    // pitch, the same base `layout.cycleWidth` every lane's own `cycleWidth`
    // is derived from, so `nameColWidth` (not a per-lane `originX`) is the
    // matching x origin for it. Left at x=0 this grid would sit under the
    // name column instead of under the cells it is meant to mark — the
    // "make room" the geometry layer already does for hit-testing has to be
    // visible too, or a click on a drawn cell lands in what `cellAt` now
    // calls the name column and does nothing.
    //
    // v3.6.0 Task 9 fix round 2 (R30): the boundary count and pitch now come
    // from `diagramCycleCount`/`diagramPitch` (see their own comment above
    // `drawBand`) instead of `layout.cycles`/`layout.cycleWidth` directly —
    // `layout.cycles` is a CELL count and `layout.cycleWidth` carries no
    // `hscale`, so under `period` or `config.hscale` this grid used to sit
    // at the wrong pitch (and the wrong count, under `period`) while the
    // bricks it is meant to mark painted at the per-lane, `hscale`-scaled
    // one. The engine's own grid (`render-marks.js`'s `gmarkLines`) is the
    // same `marks + 1` diagram-cycle boundary count the ruler uses, not a
    // second definition — sharing `diagramCycleCount` here is not a
    // convenience, it is the two DOM elements agreeing with the one thing
    // the engine agrees with itself.
    const gridPitch = diagramPitch(layout);
    const gridBoundaries = diagramCycleCount(layout);
    for (let c = 0; c <= gridBoundaries; c++) {
      const g = d.createElementNS(SVGNS, 'line');
      g.setAttribute('class', 'ed-wave-grid');
      g.setAttribute('x1', String(layout.nameColWidth + c * gridPitch));
      g.setAttribute('x2', String(layout.nameColWidth + c * gridPitch));
      // v3.6.0 Task 6 fix round 1: `layout.originY` (not `'0'`), bounded to
      // the lane rows' own extent (not `layout.height`, which also carries
      // `footHeight`) — same reasoning as the x-axis fix just above, missed
      // in the first pass. Left at `'0'`/`layout.height` this line bled into
      // the ruler band above lane 0 and the foot band below the last lane;
      // `test/editor-journey.test.js`'s T6b measures this exact line's
      // `y1`/`y2` to find the row band, so a grid starting at 0 made T6b's
      // own row-height arithmetic wrong too (R19, same fix round).
      g.setAttribute('y1', String(layout.originY));
      g.setAttribute('y2', String(layout.originY + layout.lanes.length * layout.laneHeight));
      canvas.appendChild(g);
    }

    // v3.6.0 Task 9: the ruler/head/foot bands sit strictly above `originY`
    // and strictly below the last lane's row (see `drawRuler`'s own
    // comment), so paint order against the name column and the lanes below
    // does not matter — drawn first only because it is the topmost band on
    // screen.
    drawRuler(canvas, doc, layout);

    // v3.6.0 Task 8: names before lanes, so the bricks paint OVER the name
    // column's right edge in the unlikely case a lane's own cell art ever
    // reached that far left — not that it should, but paint order should
    // not be the only thing preventing it.
    drawNames(canvas, doc, layout);
    drawGroupLabels(canvas, doc, layout);

    for (let i = 0; i < layout.lanes.length; i++) {
      drawLane(canvas, layout, i);
    }

    const edges = renderEdges(canvas, doc, layout, state);

    // v3.5.0 Task 8: the in-flight endpoint drag's own preview — UI state
    // only, never a document read (rule 3: nothing is written until
    // `finishEndpointDrag` commits it, and Escape mid-drag never reaches
    // that far). `renderEdges` above already faded the dragged edge's OWN,
    // still-current path (`.is-drag-source`, read from this same
    // `endpointDrag`); this draws the other half — a dashed line from the
    // edge's UNMOVED end to wherever the drag is currently over. Reuses
    // `.ed-wave-edge-pending`, the exact dashed style Task 7's own
    // not-yet-written preview line already uses, for the identical
    // reason: this line is not `doc.edge` either, until the drop.
    //
    // Looked up in `edges` — the SAME array `renderEdges` just built this
    // pass, not a second call to `geometry.edgeLayout` — so the two can
    // never draw from different snapshots of the layout. `render()`'s own
    // clamp guarantees `endpointDrag.index === selectedEdge` whenever
    // `endpointDrag` is non-null, so a lookup miss here would mean that
    // invariant broke, not that the edge is merely unselected — the `!==
    // undefined` check is defensive rather than expected to matter.
    let endpointDragMark = '';
    if (state.endpointDrag !== null) {
      const dragged = edges.filter(function (e) { return e.index === state.endpointDrag.index; })[0];
      if (dragged !== undefined) {
        const otherEnd = state.endpointDrag.end === 'from' ? 'to' : 'from';
        const from = dragged[otherEnd];
        // Falls back to the dragged end's OWN current position — the
        // degenerate "no visible change yet" line — until a `pointermove`
        // has actually landed on a real cell (`endpointDrag.at !== null`).
        let to = dragged[state.endpointDrag.end];
        if (state.endpointDrag.at !== null) {
          const cell = geometry.cellRect(layout, state.endpointDrag.at, state.endpointDrag.cell);
          if (cell !== null) {
            to = { x: cell.x + cell.width / 2, y: cell.y + cell.height / 2 };
            endpointDragMark = state.endpointDrag.index + ':' + state.endpointDrag.end + '@' +
              state.endpointDrag.at + ',' + state.endpointDrag.cell;
          }
        }
        const line = d.createElementNS(SVGNS, 'line');
        line.setAttribute('class', 'ed-wave-edge-pending');
        line.setAttribute('x1', String(from.x));
        line.setAttribute('y1', String(from.y));
        line.setAttribute('x2', String(to.x));
        line.setAttribute('y2', String(to.y));
        canvas.appendChild(line);
      }
    }
    state.overlay.setAttribute('data-wave-endpoint-drag', endpointDragMark);

    if (state.selection !== null) {
      // v3.6.0 Task 6: this lane's OWN row (`originX`/`y`/`cycleWidth`), not
      // `layout.cycleWidth`/`i * layout.laneHeight` from x=0/y=0 — the
      // selection box has to land on the same cell `cellRect` (and the
      // cursor box below, which already asks `cellRect`) says it is, and
      // `state.selection.laneIndex` is guaranteed a valid index into
      // `layout.lanes` by the clamp above this function.
      const selRow = layout.lanes[state.selection.laneIndex];
      const from = Math.min(state.selection.from, state.selection.to);
      const to = Math.max(state.selection.from, state.selection.to);
      const box = d.createElementNS(SVGNS, 'rect');
      box.setAttribute('class', 'ed-wave-selection');
      box.setAttribute('x', String(selRow.originX + from * selRow.cycleWidth));
      box.setAttribute('y', String(selRow.y));
      box.setAttribute('width', String((to - from + 1) * selRow.cycleWidth));
      box.setAttribute('height', String(selRow.height));
      canvas.appendChild(box);
    }

    // v3.5.0 Task 7: the pending edge — `pendingFrom` to wherever `cursor`
    // is now — drawn from UI state alone, never from the document (rule 2:
    // nothing about the doc changes until the drop). `cursor` is shared
    // with the keyboard cell below it in paint order for the same reason
    // the two are drawn from the same variable: a mouse drag and the
    // keyboard's two-Enter version are one gesture wearing two input
    // devices, so there is exactly one line to preview, however it is
    // being aimed at this instant. Skipped once `pendingFrom` is null,
    // which is every state except "armed with a marked start" and
    // "dragging" — see `setEdgeMode`.
    let pendingCell = '';
    if (state.pendingFrom !== null && state.cursor !== null) {
      const from = geometry.cellRect(layout, state.pendingFrom.at, state.pendingFrom.cell);
      const to = geometry.cellRect(layout, state.cursor.laneIndex, state.cursor.cycle);
      if (from !== null && to !== null) {
        pendingCell = state.pendingFrom.at + ',' + state.pendingFrom.cell;
        const line = d.createElementNS(SVGNS, 'line');
        line.setAttribute('class', 'ed-wave-edge-pending');
        line.setAttribute('x1', String(from.x + from.width / 2));
        line.setAttribute('y1', String(from.y + from.height / 2));
        line.setAttribute('x2', String(to.x + to.width / 2));
        line.setAttribute('y2', String(to.y + to.height / 2));
        canvas.appendChild(line);
      }
    }
    state.overlay.setAttribute('data-wave-edge-pending', pendingCell);

    // The keyboard's cell, drawn last so it is over the selection tint and
    // over the trace. Its geometry comes from `wave-geometry.cellRect` — the
    // inverse of the hit test the pointer uses — so the cell the cursor is
    // DRAWN on and the cell an edit lands in cannot drift apart.
    let cursorCell = '';
    if (state.cursor !== null) {
      const cell = geometry.cellRect(layout, state.cursor.laneIndex, state.cursor.cycle);
      if (cell !== null) {
        cursorCell = state.cursor.laneIndex + ',' + state.cursor.cycle;
        const cur = d.createElementNS(SVGNS, 'rect');
        cur.setAttribute('class', 'ed-wave-cursor');
        cur.setAttribute('data-ed-wave-cursor', '');
        cur.setAttribute('data-cell', cursorCell);
        cur.setAttribute('x', String(cell.x));
        cur.setAttribute('y', String(cell.y));
        cur.setAttribute('width', String(cell.width));
        cur.setAttribute('height', String(cell.height));
        canvas.appendChild(cur);
      }
    }
    // The same value on the overlay: what a scenario reads when the rect is
    // not the thing under test. It is assigned INSIDE the branch that draws
    // the rect and defaults to empty, so "there is no rect" and "the overlay
    // says none" are one decision rather than two that happen to agree —
    // they did not, in the first cut: this line read `cursor` directly, so a
    // cursor the clamp had not caught published a cell that `cellRect`
    // refused to give a rectangle to, and a build with the clamp removed
    // reported `{cell: null, published: "5,4"}`.
    state.overlay.setAttribute('data-wave-cursor', cursorCell);

    canvas.addEventListener('mousedown', state.onCanvasDown);
    // Tabbing onto the drawing is an entry like any other, so it puts the
    // cursor on screen rather than leaving a focused surface with no visible
    // cursor in it. Re-entrant only once: `enterDrawing()` repaints, the
    // repaint re-focuses the new canvas and fires this again, and by then
    // `cursor` is set.
    canvas.addEventListener('focus', function () {
      if (state.cursor === null) state.enterDrawing();
    });
    state.canvasWrap.appendChild(canvas);
    if (hadFocus) canvas.focus();
    return canvas;
  }

  function drawLane(svg, layout, i) {
    const row = layout.lanes[i];
    const lane = row.lane;
    // An ABSENT `wave` and an EMPTY one are two different pictures, and
    // collapsing them into one was the regression the previous round shipped
    // on the very axis it was fixing. MEASURED against the pinned engine,
    // second half-brick per cycle:
    //
    //     {name:'a', wave:''}   ["xxx","xxx"]   ONE x cycle
    //     {name:'a'}            []              NOTHING
    //     {}       (spacer)     []              NOTHING
    //     {name:'a', wave:1234} []              NOTHING
    //     {name:'a', wave:null} []              NOTHING
    //
    // and in a mixed diagram the engine simply emits no bricks for that row:
    // `{signal:[{a,'0101'},{},{b,'1010'}]}` is 16 uses, i.e. 2 lanes × 4 × 2.
    // So the rule is exactly "a lane draws cycles only when `wave` is a
    // string"; `''` is a string, which is why it gets its one cycle, and
    // `{}` — the canonical WaveDrom blank-row spacer — gets none.
    //
    // The empty-string case is not a corner either: `deleteCycles` covering
    // every cycle sets every lane's wave to `''`, two clicks away.
    const hasWave = typeof lane.wave === 'string';
    const wave = hasWave ? lane.wave : '';
    const cells = hasWave ? codec.expandWave(wave) : [];
    const levels = !hasWave ? [] : (wave === '' ? ['x'] : codec.levelsOf(cells));
    const bricks = levels.map(brickOf);
    // Which cycles carry the engine's discontinuity marker. `levelsOf`
    // deliberately erases `|` — it answers what a cycle SHOWS, and a gap
    // shows whatever is in front of it — so the marker has to be read off the
    // cells. Measured: `01|10` renders one `<use xlink:href="#gap">` at
    // translate(100), which is the centre of cycle 2, the `|` cycle.
    const gaps = [];
    for (let c = 0; c < cells.length; c++) {
      if (cells[c].held !== true && cells[c].ch === '|') gaps.push(c);
    }
    // v3.5.0 Task 10 fix round 2: which cycles carry the P/N explicit-edge
    // arrow, and which one. Read off `levels` directly rather than off
    // `bricks`, for the same reason `gaps` above reads off `cells` rather
    // than off `bricks`: `brickOf` collapses `P` into the SAME brick id as
    // `p` (that is what makes the arrow the one thing `brickOf`'s own
    // model cannot carry — see its comment, and the measurement above the
    // arrow's own drawing code below), so asking `bricks` here would
    // always come back empty. One entry per cycle that has an arrow,
    // `"<cycle>:<P|N>"`, in the same index-not-one-slot-per-cycle shape
    // `data-gaps-<i>` already uses — an empty lane (no `P`/`N` anywhere,
    // e.g. every existing fixture's plain `p`/`n` clocks) reads as `''`,
    // which is the ABSENCE half of the contract this attribute exists to
    // let a test pin: a `P` lane must show an entry here, a `p` lane must
    // not, and drawing the arrow on every clock (the regression this
    // attribute is for) would make the second half false.
    const clockEdges = [];
    for (let c = 0; c < levels.length; c++) {
      if (levels[c] === 'P' || levels[c] === 'N') clockEdges.push(c + ':' + levels[c]);
    }
    // `data-wave-<i>` cannot carry the difference between "no `wave` key" and
    // `wave: ''` — both are the empty string — and that difference is exactly
    // what the engine draws differently, so it gets its own attribute.
    svg.setAttribute('data-haswave-' + i, hasWave ? '1' : '0');
    // v3.6.0 Task 6 (ruling R18 point 3): this lane's OWN cycle width, not
    // the canvas-level `data-cycle-width` (lane 0's) — Task 4 made
    // `cycleWidth` per lane via `period`/`hscale`, so a caller that wants to
    // trust the single canvas-level attribute has to be able to check every
    // lane actually agrees with it. No journey fixture uses `period` today,
    // so every lane's value here matches lane 0's; a fixture that ever does
    // will disagree here first.
    svg.setAttribute('data-cycle-width-' + i, String(row.cycleWidth));
    svg.setAttribute('data-wave-' + i, wave);
    svg.setAttribute('data-levels-' + i, levels.join(''));
    svg.setAttribute('data-bricks-' + i, bricks.join(' '));
    svg.setAttribute('data-gaps-' + i, gaps.join(' '));
    svg.setAttribute('data-clock-edge-' + i, clockEdges.join(' '));

    const hi = row.y + 7;
    const lo = row.y + row.height - 9;
    const mid = (hi + lo) / 2;
    // v3.6.0 Task 6: this row's OWN `cycleWidth` (Task 4 made it per-lane via
    // `period`/`hscale`), not the diagram-wide `layout.cycleWidth` — and
    // every x built from it below starts at `row.originX`, not 0. Before
    // this task `row.originX` was always exactly 0 (SIZES.nameColWidth was
    // 0 and no fixture set `phase`), so the two were indistinguishable and
    // this file never had to care; `nameColWidth` going to 120 makes the gap
    // between "drawn at x=0" and "hit-tested from `row.originX`" the whole
    // width of the name column — a cell would still LOOK painted, in the
    // wrong 120px, while `cellAt` reported it was in the name column.
    const cw = row.cycleWidth;
    const labels = labelsOf(lane);
    // Which cycles carry a `data` label: the explicit value cycles, in order.
    // `levelsOf` repeats a bus's level through its continuation cycles, so the
    // label belongs to the cycle that STARTS the run, which is what the run
    // grouping below already knows.
    let labelSlot = 0;

    // Runs of one picture. Clock bricks never merge — each `p` cycle is a
    // whole clock period, and a merged run would draw one long one.
    const runs = [];
    for (let c = 0; c < bricks.length; c++) {
      const last = runs.length === 0 ? null : runs[runs.length - 1];
      if (last !== null && last.brick === bricks[c] && !isClock(bricks[c])) last.to = c;
      else runs.push({ brick: bricks[c], from: c, to: c });
    }

    function bandOf(brick) {
      if (brick === '111' || brick === 'uuu') return [hi, hi];
      if (brick === '000' || brick === 'ddd') return [lo, lo];
      if (brick === 'zzz') return [mid, mid];
      return [hi, lo];
    }

    for (let r = 0; r < runs.length; r++) {
      const run = runs[r];
      const x0 = row.originX + run.from * cw;
      const x1 = row.originX + (run.to + 1) * cw;
      const brick = run.brick;
      if (isBus(brick)) {
        const poly = d.createElementNS(SVGNS, 'polygon');
        const s = Math.min(6, cw / 4);
        poly.setAttribute('class', 'ed-wave-bus ed-wave-bus-' + brick.slice(4));
        poly.setAttribute('points',
          (x0 + s) + ',' + hi + ' ' + (x1 - s) + ',' + hi + ' ' +
          x1 + ',' + mid + ' ' + (x1 - s) + ',' + lo + ' ' +
          (x0 + s) + ',' + lo + ' ' + x0 + ',' + mid);
        svg.appendChild(poly);
        const text = labels[labelSlot];
        if (typeof text === 'string' && text !== '') {
          const t = d.createElementNS(SVGNS, 'text');
          t.setAttribute('class', 'ed-wave-buslabel');
          t.setAttribute('x', String((x0 + x1) / 2));
          t.setAttribute('y', String(mid + 4));
          t.setAttribute('text-anchor', 'middle');
          t.textContent = text;
          svg.appendChild(t);
        } else {
          // v3.5.0 Task 11 fix round 3: an UNLABELLED bus run has no
          // `<text>` for a press to land on — fix round 2's own rule
          // ("open the field only on a press that hits the label text")
          // otherwise leaves the single most ordinary flow in this editor
          // (paint a `=`, then name it) mouse-unreachable. This dot is
          // that run's hit target when there is no label yet: same
          // class as the text (`ed-wave-buslabel`, so `onCanvasDown`'s
          // existing hit test needs no change at all — it already asks
          // for that one class, not for an element type) plus
          // `ed-wave-buslabel-empty` for the dim, small styling
          // (`lib/md2doc.js`) that keeps a diagram full of unlabelled
          // buses from turning into a field of marks. Radius bounded by
          // the run's own box on both axes, not a bare constant, so the
          // box stays MOSTLY paintable even at the narrowest cycle width
          // this editor draws, and a press anywhere else in the box still
          // falls through to the ordinary paint dispatch exactly as
          // round 2 established.
          const r = Math.min(3.5, (x1 - x0) / 6, (lo - hi) / 6);
          const dot = d.createElementNS(SVGNS, 'circle');
          dot.setAttribute('class', 'ed-wave-buslabel ed-wave-buslabel-empty');
          dot.setAttribute('cx', String((x0 + x1) / 2));
          dot.setAttribute('cy', String(mid));
          dot.setAttribute('r', String(r));
          svg.appendChild(dot);
        }
        labelSlot++;
      } else if (brick === 'xxx') {
        const rect = d.createElementNS(SVGNS, 'rect');
        rect.setAttribute('class', 'ed-wave-x');
        rect.setAttribute('x', String(x0));
        rect.setAttribute('y', String(hi));
        rect.setAttribute('width', String(x1 - x0));
        rect.setAttribute('height', String(lo - hi));
        svg.appendChild(rect);
      } else if (isClock(brick)) {
        const xm = (x0 + x1) / 2;
        const p = d.createElementNS(SVGNS, 'path');
        p.setAttribute('class', 'ed-wave-line ed-wave-clock');
        p.setAttribute('d', brick === 'nclk'
          ? 'M' + x0 + ',' + lo + ' L' + x0 + ',' + hi + ' L' + xm + ',' + hi +
            ' L' + xm + ',' + lo + ' L' + x1 + ',' + lo
          : 'M' + x0 + ',' + hi + ' L' + x0 + ',' + lo + ' L' + xm + ',' + lo +
            ' L' + xm + ',' + hi + ' L' + x1 + ',' + hi);
        svg.appendChild(p);

        // v3.5.0 Task 10: `P`/`N` are explicit-edge clocks. `brickOf` maps
        // both to the SAME brick id as `p`/`n` (`nclk`/`pclk` — see its own
        // comment), which is correct for the level the engine SHOWS but
        // erases the one thing that makes `P`/`N` look different: an
        // arrowhead. MEASURED against the pinned wavedrom 3.5.0 — rendered
        // `{signal:[{name:'a',wave:'zpp'}]}` next to `{wave:'zPP'}` via
        // `wd.renderAny(0, doc, wd.waveSkin)` and diffed the `<use
        // xlink:href>` list:
        //
        //     p: #zzz #zzz #pclk #nclk #pclk #nclk
        //     P: #zzz #zzz #Pclk #nclk #Pclk #nclk
        //     n: #zzz #zzz #nclk #pclk #nclk #pclk
        //     N: #zzz #zzz #Nclk #pclk #Nclk #pclk
        //
        // — same SECOND half-brick every time (that is what `brickOf`'s own
        // measurement already pins), but the FIRST half-brick gets its own
        // symbol. Read straight out of `node_modules/wavedrom/skins/default.js`:
        //
        //     pclk  'M0,20 0,0 20,0'                                   (just the edge)
        //     Pclk  same edge PLUS 'M-3,12 0,3 3,12 C 1,11 -1,11 -3,12 z'  (filled, class s6)
        //     nclk  'm0,0 0,20 20,0'
        //     Nclk  same edge PLUS 'M-3,8 0,17 3,8 C 1,9 -1,9 -3,8 z'      (filled, class s6)
        //
        // i.e. in the engine's own 20-unit symbol space (y=0 top, y=20
        // bottom, matching this file's hi/lo), a small filled triangle
        // straddling local x=0 — `P`'s apex at local y=3 pointing UP
        // (toward hi), `N`'s apex at local y=17 pointing DOWN (toward lo).
        // Both sit on the FIRST half-brick, which in this drawing's
        // one-brick-per-period model (a whole `p`/`P` cycle is ONE `nclk`
        // path, not two half-bricks — see `isClock`'s own comment) is
        // always the vertical stroke at x0, the edge INTO this cycle. So
        // the level char (not the brick id, which is identical for
        // `p`/`P`) is what has to be read to know an arrow is owed, and
        // `levels[run.from]` is it — clock bricks never merge (the `!
        // isClock` guard below), so `run.from === run.to` and this is
        // exactly the cycle being drawn. `data-clock-edge-<i>`, set above
        // (this function's own top, next to `data-gaps-<i>`) from the same
        // `levels` array, is the one place this fact is exposed for a test
        // to pin — nothing here duplicates it onto the shape itself, so
        // there is one belief about which cycles have an arrow, not two.
        //
        // Reproduced as a plain filled triangle, not the engine's
        // bezier-curved one: every other brick this file draws is already
        // a simplified redraw (the bus is a hexagon, the gap is a pair of
        // chevrons), not a pixel copy of wavedrom's own glyphs. Scaled out
        // of the engine's 20-unit symbol into this cell's own geometry —
        // local x by (xm - x0) / 20, local y by (lo - hi) / 20, both
        // anchored at (x0, hi) — rather than hand-picked pixel offsets, so
        // it tracks `SIZES.cycleWidth`/`laneHeight` if those ever change.
        const edgeLevel = levels[run.from];
        if (edgeLevel === 'P' || edgeLevel === 'N') {
          const sx = (xm - x0) / 20;
          const sy = (lo - hi) / 20;
          const apexY = edgeLevel === 'P' ? hi + 3 * sy : hi + 17 * sy;
          const baseY = edgeLevel === 'P' ? hi + 12 * sy : hi + 8 * sy;
          const arrow = d.createElementNS(SVGNS, 'path');
          arrow.setAttribute('class', 'ed-wave-clock-arrow');
          arrow.setAttribute('d',
            'M' + (x0 - 3 * sx) + ',' + baseY +
            ' L' + x0 + ',' + apexY +
            ' L' + (x0 + 3 * sx) + ',' + baseY + ' Z');
          svg.appendChild(arrow);
        }
      } else {
        const y = bandOf(brick)[0];
        const line = d.createElementNS(SVGNS, 'line');
        line.setAttribute('class', brick === 'uuu' || brick === 'ddd'
          ? 'ed-wave-line ed-wave-weak' : 'ed-wave-line');
        line.setAttribute('x1', String(x0));
        line.setAttribute('x2', String(x1));
        line.setAttribute('y1', String(y));
        line.setAttribute('y2', String(y));
        svg.appendChild(line);
      }

      // The edge into this run. Clock bricks draw their own.
      if (r > 0 && !isClock(brick) && !isClock(runs[r - 1].brick)) {
        const prevBrick = runs[r - 1].brick;
        if (isRampPair(brick, prevBrick)) {
          // v3.6.0 Task 7: a real level change draws the ramp the engine
          // draws, not a vertical instant edge — a vertical edge left
          // Task 5's `anchorOfCell` marker floating `anchorRatio` (0.15) of
          // a cycle to the right of anything painted (48px pitch -> 7.2px)
          // because nothing was drawn there yet. See `brickPath`'s own
          // comment for the measured ramp geometry.
          const local = brickPath(lineLevelOf(brick), lineLevelOf(prevBrick), cw, lo - hi);
          const edge = d.createElementNS(SVGNS, 'path');
          edge.setAttribute('class', 'ed-wave-edge');
          edge.setAttribute('d', translatePath(local, x0, hi));
          svg.appendChild(edge);
        } else {
          const a = bandOf(prevBrick);
          const b = bandOf(brick);
          const top = Math.min(a[0], a[1], b[0], b[1]);
          const bot = Math.max(a[0], a[1], b[0], b[1]);
          if (bot > top) {
            const edge = d.createElementNS(SVGNS, 'line');
            edge.setAttribute('class', 'ed-wave-edge');
            edge.setAttribute('x1', String(x0));
            edge.setAttribute('x2', String(x0));
            edge.setAttribute('y1', String(top));
            edge.setAttribute('y2', String(bot));
            svg.appendChild(edge);
          }
        }
      }
    }

    // The gap marker, last so it sits over the trace it interrupts. The
    // engine draws one per `|`; drawing none made the two pictures disagree
    // on a lane whose levels agreed exactly, which is the quietest form of
    // the disagreement this overlay exists to surface.
    for (const c of gaps) {
      const xm = row.originX + (c + 0.5) * cw;
      const mark = d.createElementNS(SVGNS, 'path');
      mark.setAttribute('class', 'ed-wave-gap');
      mark.setAttribute('d',
        'M' + (xm - 5) + ',' + (lo + 3) + ' L' + (xm + 1) + ',' + (mid) +
        ' L' + (xm - 5) + ',' + (hi - 3) +
        ' M' + (xm - 1) + ',' + (lo + 3) + ' L' + (xm + 5) + ',' + (mid) +
        ' L' + (xm - 1) + ',' + (hi - 3));
      svg.appendChild(mark);
    }
  }

  /**
   * Every `edge` entry, drawn after every lane: one `<path>` (`d` from
   * `geometry.edgeLayout`), a label `<text>` when the entry has one, and —
   * for `selectedEdge` only — two endpoint handles from
   * `geometry.edgeHandleRect`, exactly the rectangles `onCanvasDown` below
   * hit-tests against, so the drawn handle and the clickable one cannot
   * drift apart.
   *
   * A second, invisible, wide-stroke `<path>` (`class="ed-wave-edge-hit"`)
   * is layered over each visible one purely so it can be clicked: the
   * visible path is 1px wide, and `document.elementFromPoint` (what
   * `onCanvasDown` reads to answer "did this press land on a line") would
   * otherwise miss any press that is not on that exact pixel.
   * `lib/md2doc.js`'s `.ed-wave-edge-hit` rule sets `pointer-events: stroke`
   * — what makes a `stroke: transparent` path hit-testable at all, without
   * which a transparent stroke paints nothing and "nothing painted" is what
   * `visiblePainted` (the SVG default) refuses to hit.
   *
   * Arrow markers are picked from the shape string, MEASURED against
   * `node_modules/wavedrom/lib/arc-shape.js`'s own `style` table (every
   * `case` there that sets a `style` string): a shape containing `<` sets
   * `marker-start:url(#arrowtail)`, one containing `>` sets
   * `marker-end:url(#arrowhead)`, and `+` is the one shape that sets BOTH
   * markers, to `url(#tee)` — the seven plain shapes (`-`, `~`, `-~`, `~-`,
   * `-|`, `|-`, `-|-`) set no `style` at all and draw no arrowhead.
   * (`applyEdgeMarkers` below is unaffected by the exact count either way —
   * it tests `indexOf('<')` / `indexOf('>')` rather than enumerating a
   * list — but this comment's own count should still match the pinned
   * engine.) `edgeArrowMarker` below reproduces the head/tail split with
   * ONE shared marker definition rather than two: `orient="auto-start-reverse"`
   * is what flips a `marker-start` 180° from a `marker-end` automatically,
   * so the single triangle already points the right way at both ends.
   */
  function renderEdges(svg, doc, layout, state) {
    const edges = geometry.edgeLayout(doc, layout);
    state.overlay.setAttribute('data-wave-edge-count', String(edges.length));
    if (edges.length === 0) return edges;

    const defs = d.createElementNS(SVGNS, 'defs');
    defs.appendChild(edgeArrowMarker());
    defs.appendChild(edgeTeeMarker());
    svg.appendChild(defs);

    for (const e of edges) {
      const isSelected = e.index === state.selectedEdge;
      // v3.5.0 Task 8: the edge an in-flight endpoint drag is dragging
      // keeps drawing at its ACTUAL (still-committed) position — the
      // document is untouched until the drop (rule 3) — but is faded so
      // it reads as "not where this will end up" once the dashed preview
      // (`renderCanvas`, below `renderEdges`'s own call) is standing next
      // to it. `endpointDrag` can only ever name `selectedEdge` itself
      // (`render()`'s own clamp), so `isSelected` is already true here too
      // and this only ever adds a class, never substitutes for `.is-on`.
      const isDragSource = state.endpointDrag !== null && e.index === state.endpointDrag.index;
      const path = d.createElementNS(SVGNS, 'path');
      // Every visual property (stroke, fill, width) lives in
      // `lib/md2doc.js`'s `.ed-wave-edge-path` / `.is-on` CSS, the same
      // mechanism the rest of this drawing's colours already go through
      // (`.ed-wave-line`, `.ed-wave-selection`, `.ed-wave-cursor`, …) —
      // one place to repaint the editor, not two. Only genuinely geometric
      // attributes (`d`, the marker refs) stay here as attributes.
      path.setAttribute('class', 'ed-wave-edge-path' + (isSelected ? ' is-on' : '') +
        (isDragSource ? ' is-drag-source' : ''));
      path.setAttribute('data-edge-index', String(e.index));
      path.setAttribute('d', e.d);
      applyEdgeMarkers(path, e.edge.shape);
      svg.appendChild(path);

      const hit = d.createElementNS(SVGNS, 'path');
      hit.setAttribute('class', 'ed-wave-edge-hit');
      hit.setAttribute('data-edge-index', String(e.index));
      hit.setAttribute('d', e.d);
      svg.appendChild(hit);

      if (e.edge.label !== '') {
        const t = d.createElementNS(SVGNS, 'text');
        t.setAttribute('class', 'ed-wave-edge-label');
        t.setAttribute('x', String(e.labelPos.x));
        t.setAttribute('y', String(e.labelPos.y - 4));
        // `text-anchor` positions the glyphs against (x, y) — geometry, not
        // colour — so it stays an attribute, exactly as the existing
        // `.ed-wave-buslabel` text already does a few lines up.
        t.setAttribute('text-anchor', 'middle');
        t.textContent = e.edge.label;
        svg.appendChild(t);
      }

      if (isSelected) {
        for (const end of ['from', 'to']) {
          const r = geometry.edgeHandleRect(e[end]);
          const h = d.createElementNS(SVGNS, 'rect');
          h.setAttribute('class', 'ed-wave-edge-handle');
          h.setAttribute('data-edge-handle', end);
          h.setAttribute('data-edge-index', String(e.index));
          h.setAttribute('x', String(r.x));
          h.setAttribute('y', String(r.y));
          h.setAttribute('width', String(r.width));
          h.setAttribute('height', String(r.height));
          svg.appendChild(h);
        }
      }
    }
    return edges;
  }

  /** `marker-start` / `marker-end` for one shape — see `renderEdges`'s own
   *  comment for the measurement behind this split. */
  function applyEdgeMarkers(path, shape) {
    if (shape === '+') {
      path.setAttribute('marker-start', 'url(#ed-wave-tee)');
      path.setAttribute('marker-end', 'url(#ed-wave-tee)');
      return;
    }
    if (shape.indexOf('<') !== -1) path.setAttribute('marker-start', 'url(#ed-wave-arrowhead)');
    if (shape.indexOf('>') !== -1) path.setAttribute('marker-end', 'url(#ed-wave-arrowhead)');
  }

  /** One triangle, reused for both ends via `auto-start-reverse`. */
  function edgeArrowMarker() {
    const m = d.createElementNS(SVGNS, 'marker');
    m.setAttribute('id', 'ed-wave-arrowhead');
    m.setAttribute('viewBox', '0 0 8 8');
    m.setAttribute('markerWidth', '8');
    m.setAttribute('markerHeight', '8');
    m.setAttribute('refX', '7');
    m.setAttribute('refY', '4');
    m.setAttribute('orient', 'auto-start-reverse');
    const poly = d.createElementNS(SVGNS, 'polygon');
    poly.setAttribute('points', '0,0 8,4 0,8');
    poly.setAttribute('class', 'ed-wave-edge-arrow');
    m.appendChild(poly);
    return m;
  }

  /** The `+` shape's tee: a crossbar perpendicular to the path at either
   *  end, symmetric under a 180° flip so `orient="auto"` needs no reverse. */
  function edgeTeeMarker() {
    const m = d.createElementNS(SVGNS, 'marker');
    m.setAttribute('id', 'ed-wave-tee');
    m.setAttribute('viewBox', '0 0 8 8');
    m.setAttribute('markerWidth', '8');
    m.setAttribute('markerHeight', '8');
    m.setAttribute('refX', '4');
    m.setAttribute('refY', '4');
    m.setAttribute('orient', 'auto');
    const line = d.createElementNS(SVGNS, 'line');
    line.setAttribute('x1', '4');
    line.setAttribute('y1', '0');
    line.setAttribute('x2', '4');
    line.setAttribute('y2', '8');
    line.setAttribute('class', 'ed-wave-edge-tee');
    m.appendChild(line);
    return m;
  }


  return {
    renderCanvas: renderCanvas,
    drawLane: drawLane,
    renderEdges: renderEdges,
    brickOf: brickOf,
    isClock: isClock,
    isBus: isBus,
    brickPath: brickPath,
  };
}

module.exports = { createDrawer: createDrawer };
