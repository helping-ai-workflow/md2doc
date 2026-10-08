'use strict';
/*
 * wave-ui — the wavedrom editing surface: the overlay, the canvas the WaveDrom
 * engine draws (wave-canvas.js) with the editor's interaction layer over it
 * (wave-draw.js createLayer), the title bar, the toolbar and its popovers,
 * the notice card and the hint bar (spec section 4.1; wave-panels.js builds
 * the plain-DOM pieces).
 *
 * UMD, the same shape convert-md.js / patchmap.js use: require-able in node so
 * the drawing decisions can be checked without a browser, and injected into the
 * edit page as `window.md2docWaveUi` (lib/editor/server.js). client.js is
 * inlined as a plain <script>, not bundled, so a bare require() here would be
 * undefined in the browser — every dependency arrives as a parameter instead
 * (`opts.codec`, `opts.geometry`, `opts.createStore`, `opts.wavedrom`,
 * `opts.document`, `opts.draw`, `opts.panels`, `opts.canvas`, `opts.theme`).
 * That is also why this file
 * names no global of its own: the layer that knows which `document` and which
 * engine build are in play is client.js, and it is the only one that should be
 * deciding.
 *
 * FIVE things this file is not allowed to get wrong, each of them a ruling from
 * Tasks 1-5 rather than a preference:
 *
 *  1. THE OVERLAY MOUNTS ON `document.body`, NEVER INSIDE `.content`.
 *     `.content`'s children are the editor's serialisation surface — client.js
 *     reads them back (`lastParts`) and the WYSIWYG path turns them into
 *     markdown. A panel parked in there ends up in the user's file. `mount()`
 *     takes the host as a parameter and `mountedInsideContent()` below is the
 *     check that a caller can run against its own DOM.
 *
 *  2. LANE NUMBERS ARE THE CODEC'S FLATTENED DISPLAY ORDER, and the only road
 *     from one to a path is the codec's bridge. Nothing here writes
 *     `['signal', k]`. `wave-geometry.cellAt` already answers in that index
 *     space, so a hit test and the edit it triggers are speaking the same
 *     language by construction.
 *
 *  3. THE ENGINE DRAWS THE CANVAS (wave redesign, Task 6a). The editor used to
 *     paint its own picture of the waveform beside the engine's preview, and
 *     four of the seven defects in spec §5 were the two disagreeing. Now the
 *     canvas IS the engine's output (wave-canvas.js) and this file only draws
 *     its own marks over it (selection, cursor, dots). `levelsOf` stays the
 *     codec's answer for what a cycle holds, and `brickOf` the engine's brick
 *     for a level — the gestures ask them (`resolveBusTarget`); nothing here
 *     draws a second picture from them.
 *
 *  4. A GROUP CAN BE JOINED AT ITS HEAD BUT NOT AT ITS TAIL. That is what
 *     `laneInsertPath` does, and it is a consequence of flattened indexing, not
 *     a bug to paper over. So every insert affordance ASKS the bridge where it
 *     would land and says so on its own label before it is pressed — see
 *     `landingOf`.
 *
 *  5. ONE GESTURE, ONE `apply`, ONE `toPatch`. Task 5 measured the store's
 *     refusal rate climbing with the number of structural operations stacked up
 *     before a write-back (8.0% at 1-3, 17.0% at 1-6). Those refusals are
 *     correct — they used to be silent corruption — so the way to keep them
 *     rare is to never let edits pile up. `commit()` below is the only way a
 *     gesture reaches the store, and it does both halves every time.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.md2docWaveUi = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const SVGNS = 'http://www.w3.org/2000/svg';

  /**
   * The brush palette, exactly the set the spec names, in that order.
   *
   * v3.5.0 Task 10 widened this from 11 to 22: `P`/`N` (explicit-edge
   * clocks, drawn by the engine with an arrow on the explicit edge),
   * `2`-`9` (bus levels beyond the plain `=`, already understood by
   * `brickOf` and `codec.levelsOf` but never offered as a brush), and `|`
   * (the gap marker) placed last because it is not a level at all —
   * `codec.levelsOf('=.|')` measured it as "carry the previous level", so
   * painting it does not change what a cycle shows, only that it shows a
   * discontinuity.
   */
  const BRUSHES = ['0', '1', 'x', 'z', 'p', 'n', 'P', 'N', 'h', 'l', 'u', 'd',
    '=', '2', '3', '4', '5', '6', '7', '8', '9', '|'];

  /**
   * Where the brushes sit (spec section 4.2): six resident on the toolbar,
   * the other sixteen in 更多's grid, grouped. Together they are `BRUSHES`,
   * each exactly once — `test/wave-draw.test.js` pins that.
   */
  const BRUSH_RESIDENT = ['0', '1', 'x', '=', '3', 'p'];
  const BRUSH_MORE = [
    ['電位', ['z', 'h', 'l', 'u', 'd']],
    ['時脈', ['n', 'P', 'N']],
    ['資料', ['2', '4', '5', '6', '7', '8', '9']],
    ['其他', ['|']],
  ];

  /**
   * Whether a `KeyboardEvent.key` value both PICKS and PAINTS a brush —
   * `handleDrawingKey` (below `enterDrawing`) tests this exact call, not a
   * copy of it, so the admission rule and what the keyboard can actually
   * reach cannot drift apart the way the module's own prologue warns about
   * (rule 3: two beliefs about the same thing is the failure this batch
   * keeps producing). Named and exported on its own so a test can pin
   * "every brush is keyboard-reachable" against the real rule instead of a
   * re-implementation of it — see `wave-codec.test.js`'s
   * `isBrushKey`-roster assertion.
   *
   * `key.length === 1` is what actually excludes navigation: every
   * `BRUSHES` entry is one character, while `ArrowLeft`/`ArrowRight`/
   * `ArrowUp`/`ArrowDown`/`Home`/`End` are multi-character key NAMES, so
   * `BRUSHES.indexOf(key)` is already `-1` for all six regardless of this
   * length check — it is kept anyway so that invariant is spelled out at
   * the point of use rather than left to rely on `BRUSHES` never growing a
   * multi-character entry by mistake. Deliberately NOT keyed on
   * `ev.shiftKey`: v3.5.0 Task 10 added `P`/`N` (and `|` sits next to `\`
   * on a US layout) to `BRUSHES`, and all three are typed WITH Shift on an
   * ordinary keyboard, so a shiftKey exclusion here would make them
   * mouse-only — see Task 10's fix-round report for the full reasoning on
   * why dropping it does not reopen the Shift+arrow risk the old comment
   * named (that risk is excluded above, by `nav`, on `key` identity, not on
   * `ev.shiftKey`).
   */
  function isBrushKey(key) {
    return typeof key === 'string' && key.length === 1 && BRUSHES.indexOf(key) !== -1;
  }

  /** Engine units (spec §3, wave-canvas.js): a cycle is 40 wide, a lane 30
   *  tall. Since Task 6a the canvas measures its layout from the engine's own
   *  svg; these only build the fallback `layoutNow()` hands out when the
   *  engine has not drawn the current document (no WaveDrom on the page, or a
   *  document it refused). In that state nothing is drawn and the layout is
   *  only asked for lane and cycle COUNTS, which do not depend on sizes. */
  const SIZES = { laneHeight: 30, cycleWidth: 40, nameColWidth: 0 };

  /** The canvas enlargement (spec §4.1: about 60px per cycle, 1.5 engine
   *  units per CSS px), and how far above the engine's svg the layer's cycle
   *  ruler baseline sits. The room for the ruler is `.ed-wave-canvas-host`'s
   *  top padding in lib/md2doc.js (20px). */
  const CANVAS_SCALE = 1.5;
  const RULER_GAP = 6;

  /** Task 7 (spec section 4.3). How close (CSS px) the pointer has to be to
   *  a cycle boundary, over the ruler band, for the ruler's ＋ to show there
   *  — under half a 60px cycle, so the ruler numbers in the middle of each
   *  cycle stay a dead zone. */
  const PLUS_REACH = 12;
  /** How far (CSS px) around the engine's own text box a press still counts
   *  as a press on a data label: a one-character label is about 10px wide. */
  const LABEL_HIT_PAD = 3;
  /** The floating range toolbar's distance from the run, and from the
   *  panel's sides. */
  const RANGE_GAP = 6;
  /** What the range toolbar's 電位 ⌄ offers: every brush, the toolbar's six
   *  first, then 更多's groups. */
  const RANGE_LEVELS = [['常用', BRUSH_RESIDENT]].concat(BRUSH_MORE);

  /**
   * Task 8 (spec section 4.4): how the engine indents the name column, in
   * engine units, measured from the pinned wavedrom's
   * `node_modules/wavedrom/lib/rec.js`: the lane list starts 10 in, and each
   * group nests its members a further 25 when it has a title (a string or a
   * number at index 0) and 10 when it has none. A group's bracket is drawn
   * at its members' indent (`render-groups.js`, `e.x + 0.5`) and its title,
   * rotated, 10 to the left of that. So each group owns the band of the
   * name column between its parent's indent and its own — that is where a
   * pointer means the group (its title and bracket) rather than a lane's
   * name.
   */
  const NAME_INDENT_LIST = 10;
  const NAME_INDENT_TITLED = 25;
  const NAME_INDENT_UNTITLED = 10;
  /** A row's ⠿ (CSS px): its size and its gap to the name it belongs to,
   *  and how far a press on it has to travel before it is a drag. */
  const GRIP_W = 16;
  const GRIP_H = 22;
  const GRIP_GAP = 2;
  const GRIP_DRAG_SLOP = 4;
  /** The in-place name field is never narrower than this (CSS px): a short
   *  name's column is too narrow to type a longer one into. */
  const NAME_FIELD_MIN = 140;

  /**
   * The index the canvas is rendered under (the side preview's until Task 6a,
   * which stopped rendering that preview so the two never share the id), and
   * why it is not 0.
   *
   * `RenderWaveForm(index, …)` names its structural ids after that index —
   * `svgcontent_<i>`, `waves_<i>`, `lanes_<i>`, `gmarks_<i>`, `gmark_<lane>_<i>`
   * — and the document's own diagram is already rendered at 0. MEASURED in a
   * real page carrying one rendered diagram, counting duplicate `id`s across
   * the whole document (0 before the preview existed):
   *
   *     RenderWaveForm(0,    …, notFirstSignal=false)   240 duplicate ids
   *     RenderWaveForm(0,    …, notFirstSignal=true)     20 duplicate ids
   *     RenderWaveForm(9000, …, notFirstSignal=true)      0 duplicate ids
   *
   * In all three the preview came out with the same 18 `<use>` elements and the
   * same 300px width, and with `notFirstSignal=true` a brick still measures
   * 20x20 — the `<use>`s resolve against the skin the page already carries, so
   * re-emitting the whole `<defs>` (`notFirstSignal=false`, 1 extra `<defs>`
   * and a duplicate of every brick symbol id) buys nothing. A document using a
   * non-default `config.skin` was the reason to be careful about sharing, and
   * it is not a risk here: the preview renders THE SAME DOCUMENT as the diagram
   * whose skin is on the page.
   */
  const PREVIEW_INDEX = 9000;
  const PREVIEW_ID_PREFIX = 'md2doc-wave-preview-';

  /**
   * Whether `el` is inside the editor's serialisation surface.
   *
   * Constraint 1 at the top of this file, as something a caller can ask rather
   * than as a rule it has to remember. `.content`'s own children are what
   * client.js reads back as "the render I last knew about", so anything this
   * module parks in there travels into the user's markdown.
   */
  function mountedInsideContent(el) {
    let node = el;
    while (node !== null && node !== undefined) {
      if (node.classList !== undefined && node.classList.contains('content')) return true;
      node = node.parentElement;
    }
    return false;
  }

  /** Line and column of a byte offset, 1-based — what a parse failure has to
   *  say beyond its own message for the offset to mean anything to a person. */
  function whereIs(text, offset) {
    const upto = String(text).slice(0, Math.max(0, offset | 0));
    const lines = upto.split(/\r\n|\r|\n/);
    return { line: lines.length, column: lines[lines.length - 1].length + 1 };
  }

  // `plainCopy`, `groupSpansOf`, `directFirstLaneOf` and `valueAt` used to
  // live here. v3.6.0 Task 2 moved `plainCopy` and `directFirstLaneOf` to
  // `wave-panels.js` with the rendering functions that were their only
  // callers (and Task 14 then deleted `directFirstLaneOf` outright, with the
  // per-row 解散群組 button that was its one caller); `groupSpansOf` and
  // `valueAt` moved to `wave-geometry.js` per ruling R9, since both
  // `wave-panels.js` and `wave-draw.js` need them and that module is the one
  // place both already depend on.

  /** The labels a lane's `data` supplies, one per explicit value cycle. */
  function labelsOf(lane) {
    const raw = lane === null || typeof lane !== 'object' ? undefined : lane.data;
    if (Array.isArray(raw)) return raw.map(function (x) { return String(x); });
    if (typeof raw === 'string') return raw.split(/\s+/).filter(function (x) { return x !== ''; });
    return [];
  }

  // -------------------------------------------------------------------------
  // The editor
  // -------------------------------------------------------------------------

  /**
   * Open the editing surface over one wavedrom block's source text.
   *
   * `opts`:
   *   document    the DOM document to build in (required)
   *   host        where the overlay is mounted; defaults to `document.body`.
   *               A host inside `.content` is REFUSED — see constraint 1.
   *   source      the block's WaveJSON text
   *   codec, geometry, createStore   the three modules, handed in
   *   wavedrom    `window.WaveDrom` or null; null leaves the canvas undrawn
   *               (client.js refuses to open the editor without it, spec
   *               section 6)
   *   notify(level, text, action?)  where messages go (spec section 4.8):
   *               level 'error' (the red card that stays) or 'notice' (the
   *               4-second toast); `action` is `{label, run}` or absent
   *   saveStatus() -> {dirty}  the FILE's save state when the editor opens;
   *               later changes arrive through the returned `setSaveStatus`
   *   saveKeyHint the save key as this platform spells it (default Ctrl+S)
   *   onGesture({name, patch, store})  called after EVERY gesture that changed
   *               the document, with that gesture's own patch already computed
   *   onClose(reason)  called once, when the overlay goes away. `reason` is
   *               `'escape'` when the user pressed Escape and `'commit'` for
   *               every other route out (✕, 完成, or a caller driving
   *               the returned `close()`). Task 7 needs the two apart because
   *               they mean opposite things to the document: a commit leaves
   *               this session's write-backs standing, an Escape takes them
   *               back off again. Passed as an argument rather than inferred
   *               by the caller from what the keyboard last did — that
   *               inference is exactly the kind this file has already paid
   *               for once (see the banner/Escape split in `onKeyDown`).
   *
   * Never throws on a source that cannot be read: `createStore` answers with a
   * refusing store and this shows the parser's message and offset. A block that
   * silently fails to open is the worst outcome there is — it still looks
   * editable and simply is not.
   */
  function createWaveEditor(opts) {
    const d = opts.document;
    const codec = opts.codec;
    const geometry = opts.geometry;
    const host = opts.host || d.body;
    if (mountedInsideContent(host)) {
      throw new Error('wave-ui: the overlay may not be mounted inside .content ' +
        '(its children are serialised back into the user markdown)');
    }
    // `opts.draw` (wave-draw.js's `createDrawer`) arrives as a parameter like
    // every other dependency here, per this file's own header comment — a
    // bare `require('./wave-draw.js')` would be undefined in the browser,
    // where wave-ui.js is injected as a plain <script> with no shim of its
    // own (see lib/editor/server.js). Missing it fails LOUD rather than
    // quietly drawing nothing: a diagram with no drawing layer behind it must
    // never look like a diagram that simply has nothing to draw.
    if (!opts.draw) {
      throw new Error('wave-ui: opts.draw (wave-draw.js\'s createDrawer) is required');
    }
    // v3.6.0 Task 2: `opts.panels` (wave-panels.js's `createPanels`) is the
    // toolbar/popover/notice counterpart to `opts.draw` just
    // above, arriving as a parameter for the identical reason — no shim for
    // a bare `require('./wave-panels.js')` in the browser injection path.
    if (!opts.panels) {
      throw new Error('wave-ui: opts.panels (wave-panels.js\'s createPanels) is required');
    }
    // Task 6a: the engine canvas (wave-canvas.js), same reasoning again.
    if (!opts.canvas || typeof opts.canvas.createCanvas !== 'function') {
      throw new Error('wave-ui: opts.canvas (wave-canvas.js) is required');
    }

    const store = opts.createStore(opts.source);

    /**
     * The exact bytes this block's write-back holds right now, not a
     * re-serialisation made for display (匯出's 複製 WaveJSON and the test
     * probe below read it). The SAME `store.toPatch()` path `afterStoreMoved` already
     * runs after every gesture (`lastPatch`, below), recomputed fresh here
     * rather than reusing that cached value: this can be asked before the
     * very first gesture, while `lastPatch` is still `null`.
     *
     * A refusal is shown as a sentence, not thrown — the same "say what it
     * cannot do" rule `renderUnmodelled` and the unreadable-source panel
     * both already follow, rather than crashing over a state the user can
     * act on (undo one step, or make a smaller change).
     */
    function sourceText() {
      const patch = store.toPatch();
      return patch.ok === true ? patch.text
        : '（這個改動目前沒辦法只改幾個位元組寫回去：' + patch.reason + '）';
    }
    // Test-visible, same convention `client.js` already uses for its own
    // `window.__edTest*` probes: a plain global a Puppeteer test can call
    // directly, assigned through `d.defaultView` rather than a bare
    // `window` reference — this file names no global of its own (see its
    // header) and is reachable from node with a fake `opts.document`, where
    // a bare `window` would throw.
    const probeWin = d.defaultView;
    if (probeWin) probeWin.__edWaveSourceProbe = sourceText;
    // Task 8: the document ON SCREEN, which is not always what the probe
    // above can write back — the store refuses some structural edits (a new
    // or dissolved group) rather than re-serialise the block, and the
    // canvas still shows the edit.
    if (probeWin) probeWin.__edWaveDocProbe = function () { return JSON.stringify(store.doc); };

    // Since Task 6a the drawer only supplies the brush glyphs and the brick
    // model (`brickOf` / `isBus`); the canvas marks are `layerApi`'s.
    const drawer = opts.draw.createDrawer({ d: d, geometry: geometry, SVGNS: SVGNS });
    const layerApi = opts.draw.createLayer({ d: d, SVGNS: SVGNS });

    const overlay = d.createElement('div');
    overlay.className = 'ed-wave-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', '波形編輯器');

    // ── what this dialog says back (spec section 4.8, two levels) ─────────
    //
    // `notify('error', …)` is the red card that stays until closed — only for
    // a problem that loses data; `notify('notice', …)` is the four-second
    // toast for every other result and refusal. client.js implements both
    // (`opts.notify`, its showError / showNotice). The overlay's
    // `data-wave-status` keeps the last message either way, which is what
    // tests and `noteStatus` read. `announce` is the cursor's position in
    // words, for the hidden `role=status` region only.
    function notify(level, text, action) {
      overlay.setAttribute('data-wave-status', text);
      if (typeof opts.notify === 'function') {
        opts.notify(level === 'error' ? 'error' : 'notice', text, action);
      }
    }
    /** Recorded on the overlay and nowhere else: the normal path, which a
     *  toast on every stroke would only drown out. */
    function noteStatus(text) {
      overlay.setAttribute('data-wave-status', text);
    }
    let liveRegion = null;
    function announce(text) {
      if (liveRegion !== null) liveRegion.textContent = text;
    }

    // ── state that is the UI's own, not the document's ────────────────────
    // Declared HERE, above the unreadable-source return below, because
    // `close()` clears `drag` and the unreadable panel has a 關閉 button too:
    // a `let` declared past that return would still be in its temporal dead
    // zone when that button is pressed, and close() would throw instead of
    // closing.
    let brush = '1';
    let clip = null;
    // v3.6.0 Task 14: `{laneIndex, laneTo, from, to}` — THE selection, and
    // the only one this dialog has. `laneIndex`..`laneTo` (inclusive,
    // normalised so `laneTo >= laneIndex`) is the lane range the 訊號/群組
    // sections act on; `from`..`to` is the cycle range on `laneIndex` that
    // the 週期 section and the brushes act on. An ordinary selection has
    // `laneTo === laneIndex`; only Shift+click on the old rail widened it,
    // and nothing does today: Task 8's name column acts on one row at a
    // time, the row whose ⠿ was used.
    //
    // Every producer writes all four keys. That is deliberate rather than
    // "absent means single lane": this repo has already paid for one value
    // whose two ends disagreed about what `undefined` meant (wavedrom's own
    // `captext` vs `ticktock`), and a reader here does
    // `i >= laneIndex && i <= laneTo` with no second rule to remember.
    let selection = null;
    let drag = null;             // live pointer drag, never pushed until mouseup
    let gestures = 0;
    let lastPatch = null;
    // Where the keyboard should end up after the NEXT repaint, when that is not
    // simply "wherever it was". A gesture that MOVES a lane is the case that
    // needs it: whatever the keyboard was on belongs to a row, and after the
    // move the lane the user is pushing around sits at a different row — so
    // Alt+↓ twice has to move the same lane twice, not two different ones.
    // (v3.6.0 Task 16 re-pointed this sentence: it used to name the rail's
    // per-row ▲, which Task 14 removed. Since Task 8 `moveLaneTo` carries
    // the same fact: when the keyboard is in the name column it nominates the
    // moved lane's own ⠿. The narrative further down about what ▲/▼ USED to
    // do is a record of a past version and is deliberately left as it was.)
    let focusOverride = null;
    // Where the KEYBOARD is on the drawing: one cell, and the keyboard's whole
    // equivalent of the pointer. Null until the keyboard has actually entered
    // the drawing — a cursor drawn before anyone asked for one is a second
    // permanent highlight beside the selection with nothing behind it.
    //
    // A pointer press moves it too (see `onCanvasDown`), so the two devices can
    // never end up pointing at different cells: painting with `1` after a click
    // paints the cell that was clicked.
    let cursor = null;
    // The selected `edge` array entry — the codec's ORIGINAL index into
    // `doc.edge`, exactly what `geometry.edgeLayout` reports as `index` (NOT
    // the filtered array position; a dangling entry ahead of it is skipped
    // there and would otherwise shift everything after it out of step). Null
    // means no edge is selected. `render()` clamps it to null the moment the
    // edge it names stops being drawable (deleted, or its entry no longer
    // parses), so a stale index can never reach a commit. Its editing
    // surface (the floating edge toolbar) is Task 9's.
    let selectedEdge = null;
    // v3.5.0 Task 7: the edge-CREATION gesture's own state, shared verbatim
    // by the pointer and the keyboard — one state machine, two input sources.
    // `edgeMode` is explicit rather than inferred from "is a key held" or "is
    // the mouse button down", for the same reason the brush canvas keeps
    // `drag` as its own variable instead of asking `ev.buttons`: a painting
    // drag and an edge-creation drag must never be read as each other, and a
    // named mode is what lets `onCanvasDown` choose between them up front.
    //   'idle'     — the 關聯線 button is off; every press paints or selects.
    //   'armed'    — pressed once; the NEXT thing (a press, or a cell plus
    //                Enter) marks the start of a line.
    //   'dragging' — the mouse is down after that press; every move only
    //                repaints a preview, the document is untouched.
    // `pendingFrom` is the marked start cell, `{at, cell}` in the same two
    // numbers `codec.ensureNode`/`geometry.cellRect` already take — the
    // codec's flattened lane index and the cycle inside it. It is cleared
    // only when `setEdgeMode` moves all the way back to 'idle': going back to
    // 'armed' after a drop that produced nothing (rule 1 below) deliberately
    // LEAVES it standing, so a keyboard user who marked a start and then
    // pressed Enter over an empty row does not have to re-mark it — the next
    // Enter still means "finish from where I already stood".
    let edgeMode = 'idle';
    let pendingFrom = null;
    // v3.6.0 Task 11: which transition anchor the pointer is nearest while
    // armed — `{laneIndex, cell}`, `geometry.boundaryAt`'s own field names,
    // never converted to `cellFromEvent`'s `cycle` (see that function's own
    // comment). Cleared whenever `edgeMode` leaves 'armed' for any reason
    // (idle or dragging) so a stale hot dot never survives past the state
    // that produced it — set alongside `edgeMode` in `setEdgeMode` itself,
    // the one place that already keeps every other edge-gesture mark
    // (`pendingFrom`) in sync with it.
    let hoverBoundary = null;
    /** The one place `edgeMode` changes. Keeps the arm button's own visual
     *  state, the overlay's `data-wave-edgemode` (what a test or a future
     *  task reads instead of reaching into this closure) and the "is a start
     *  cell marked" invariant all moving together. */
    function setEdgeMode(next) {
      edgeMode = next;
      edgeBtn.setAttribute('aria-pressed', next === 'idle' ? 'false' : 'true');
      edgeBtn.classList.toggle('is-on', next !== 'idle');
      overlay.setAttribute('data-wave-edgemode', next);
      if (next === 'idle') pendingFrom = null;
      // v3.6.0 Task 11: the hover dot only ever means anything while
      // 'armed' (dragging repaints its own hot dot via `onCanvasMove`'s
      // `at`, computed fresh every move) — leaving 'armed' for either
      // neighbour state without clearing this would let a stale hot dot
      // from the last hover survive into a repaint nothing is tracking it
      // for any more.
      if (next !== 'armed') hoverBoundary = null;
    }
    // v3.5.0 Task 8: dragging either END of the SELECTED edge to another
    // cell. `{index, end, at, cell} | null` — `index` is the same original
    // `doc.edge` index `selectedEdge` names (a drag can only start from that
    // edge's own drawn handle, see `onCanvasDown`), `end` is `'from'` or
    // `'to'`, and `at`/`cell` are the live drop target, `null` until the
    // first `pointermove` lands on a real cell.
    //
    // Unlike `edgeMode`/`pendingFrom` — two separate variables that Task 7
    // spent three fix rounds re-synchronising after one could go stale while
    // the other stood — this is ONE variable that is both "is a drag
    // happening" and "what does it know so far". There is no second flag to
    // fall out of step with it: `onCanvasMove`/`onCanvasUp` test this value
    // itself, so nulling it is the whole of cancelling the gesture, in one
    // place, atomically. It still has to be threaded through the same two
    // places Task 7's marks are, though, because the hazard those rounds
    // found is not particular to `pendingFrom` — it is "a mark naming a lane
    // outlives the document that lane numbering was valid in":
    //   - `carryMarks` below carries `at` by lane IDENTITY, exactly like
    //     `pendingFrom.at`, for the same reason: a structural undo/redo can
    //     land while this drag is in flight (the keyboard stays live while a
    //     mouse button is held — Ctrl+Z does not care what the mouse is
    //     doing), and a raw row number surviving that would let the eventual
    //     drop's `moveEdgeEnd` bounds-check successfully against a lane the
    //     user was never actually pointing at.
    //   - `render()`'s own `selectedEdge` clamp is widened to drop this too:
    //     `index` can only ever be reached from `selectedEdge`'s own drawn
    //     handle, so the two may never disagree — a drag whose edge stops
    //     being drawable (deleted, or its selection cleared by that same
    //     mid-drag undo) has to die with it rather than commit a move onto
    //     whatever entry now happens to sit at that array position.
    let endpointDrag = null;
    // The document the marks' lane numbers are numbers INTO.
    //
    // `cursor` and `selection` name a ROW, and a row number means a different
    // lane after anything that reorders rows. The first cut answered that per
    // operation — ▲ and ▼ swapped the two indexes themselves — and that is the
    // shape that cannot be finished: it fixed the move and not the UNDO of the
    // move, so ▲ then Ctrl+Z left the cursor and the selection sitting
    // confidently on the neighbour, and the next brush key painted a lane the
    // user was not looking at. Nothing on screen contradicted them. ✕ and ＋
    // were the same defect before that, and something else would have been
    // next.
    //
    // So the marks are carried by lane IDENTITY through one funnel instead:
    // `afterStoreMoved` is the only road every store movement takes — apply,
    // undo and redo all end there — and `carryMarks` asks the STORE which row
    // each lane is on now. No operation has to remember anything, so no
    // operation can forget.
    let marksDoc = null;
    // The in-place name field while it is open — a signal's name or a
    // group's title (Task 8, spec section 4.4; `openNameField`), as a
    // `{cancel, retire, input}` triple — and therefore what the first
    // Escape closes. Before the layering, Escape typed at a rename field ran
    // `close('escape')` and threw the WHOLE session away, which is the most
    // expensive answer available to「我改名改到一半不想改了」.
    let nameEdit = null;
    // v3.5.0 Task 11: the bus data-label field while it is open — this
    // dialog's OTHER sub-panel, same shape as `nameEdit` above (a
    // `{cancel, retire}` pair) and layered the same way in `onKeyDown`'s
    // Escape handling. Unlike the rename field, this one's node lives
    // beside the canvas that `paintLayer` repaints on every cursor
    // move, not only on a structural edit — so `retire()` is called from
    // THERE, not only from `render()` (see `paintLayer`).
    let dataEdit = null;
    // Task 7: what the pointer is over while no button is held — the cell
    // whose whole cycle column the layer lights (`hoverCell`, spec section
    // 4.3), or, over the ruler band above the lanes, the cycle boundary the
    // ruler's ＋ sits on (`rulerPlus`, 0..cycles). Chrome only: the ＋'s own
    // press reads its boundary off the pressed element, not from here.
    let hoverCell = null;
    let rulerPlus = null;
    // Task 7: the floating toolbar over a selected run of cycles while it is
    // on screen — `{el, key}`, `key` naming the run it was built for, so a
    // repaint that leaves the run alone (a hover, a label edit) keeps the
    // same buttons and whatever the keyboard is on among them.
    let rangeBar = null;
    // Task 6a: the engine canvas (wave-canvas.js `createCanvas`), one per
    // editor session. Declared up here because `close()` destroys it and the
    // unreadable-source panel below returns before it is ever created.
    let engineCanvas = null;
    // The one popover open now (`togglePopover`): `{el, owner, kind, ...}`.
    // Declared up here, above the unreadable-source return, because the
    // dialog's Escape (`onKeyDown`) reads it on that path too.
    let popover = null;
    // Task 8 (spec section 4.4): which row of the name column the pointer
    // is over — `{kind: 'lane', laneIndex}` or `{kind: 'group', span}` (a
    // `geometry.groupSpansOf` span) — so the layer lights that row and its
    // ⠿ shows. And a lane being dragged by its ⠿: `{laneIndex, x0, y0,
    // active, drop}`, `drop` the row boundary (0..lanes) it would land on.
    let hoverName = null;
    let gripDrag = null;

    // ── the modal focus model ─────────────────────────────────────────────
    //
    // `role="dialog"` + `aria-modal="true"` is a promise, and before this the
    // overlay kept none of it: nothing was focused on open (MEASURED:
    // `document.activeElement` was `document.body` the instant the panel came
    // up), `Tab` never reached any of its controls, and closing left the
    // keyboard wherever the browser happened to drop it.
    //
    // It is also what makes the OWNERSHIP question answerable. The surrounding
    // editor used to ask "did this event land inside the overlay?", which is a
    // question about the event; with focus on body the honest answer was "no"
    // and the document behind the modal kept the key. Ownership has to be true
    // BEFORE any event arrives, so client.js now asks a state question — and
    // this is the other half: the state is real, focus is actually in here.
    const FOCUSABLE = 'button, input, select, textarea, a[href], ' +
      '[tabindex]:not([tabindex="-1"])';
    // Where the keyboard was before this opened, so it can be handed back.
    const cameFrom = d.activeElement;

    // ── R2: the document behind the modal does not scroll ─────────────────
    //
    // A state predicate over EVENTS cannot answer this one: native wheel
    // scrolling is not delivered to a listener anyone guards, so measured, a
    // single wheel gesture with the pointer over the panel took the document
    // behind it from `scrollY 0` to `800` with the overlay still up.
    //
    // Nothing is mutated by that, so this is not a data question — it is the
    // same question the V3 overlay census answers for `.ed-wave-edit-btn`,
    // which is classified `gone` precisely because "a scroll makes its
    // coordinates point at the wrong thing". The wave editor is anchored to one
    // diagram in the document; scrolling the document out from under it moves
    // where the user lands when it closes, silently.
    //
    // So it is locked, and restored exactly as it was found — the inline value
    // is captured rather than assumed to be empty, so a page that sets its own
    // is not quietly rewritten. `overflow: hidden` on the ROOT leaves
    // `scrollTop` where it is and does not touch the panel's own three scroll
    // columns, which keep working.
    //
    // `lockScroll()` is called from TWO places — the unreadable-source panel's
    // own mount, and the ready panel's — and in each it is the statement
    // immediately before that path's `host.appendChild(overlay)`. That, not the
    // number of call sites, is the property: the lock is taken by the same
    // statement that puts the overlay on screen, so "is it mounted" and "is it
    // locked" cannot disagree, and a THIRD early-return panel has to do the same
    // pairing rather than inherit it.
    //
    // Setting it once at the top, where it was, meant a throw anywhere in the
    // construction below left the whole document permanently unscrollable with
    // no overlay on screen and no way back but a reload — `openWaveEditor`'s own
    // `catch` clears `waveEditor` and re-throws, and it does not know about the
    // lock. Nothing between there and the mount realistically throws today; the
    // point is that it no longer has to be true.
    const rootEl = d.documentElement;
    let rootOverflowWas = null;
    function lockScroll() {
      if (rootOverflowWas !== null) return;
      rootOverflowWas = rootEl.style.overflow;
      rootEl.style.overflow = 'hidden';
    }
    function unlockScroll() {
      if (rootOverflowWas === null) return;
      rootEl.style.overflow = rootOverflowWas;
      rootOverflowWas = null;
    }

    /**
     * Everything inside the modal layer that can take the keyboard.
     *
     * The layer is the overlay AND any conflict banner standing on screen, and
     * that second part is not a detail. `.ed-conflict` is `z-index: 999` against
     * this overlay's 998, so a banner raised while the panel is open PAINTS
     * above it (measured) — but a focus trap scoped to the overlay alone would
     * make its Dismiss and Reload buttons unreachable by keyboard, and that
     * banner is the user's only route out of a disk conflict. This branch has
     * already paid once for a fixed layer hiding that banner; it does not get
     * to pay again by trapping the keyboard away from it.
     */
    function modalRoots() {
      const out = [overlay];
      for (const el of d.querySelectorAll('.ed-conflict')) out.push(el);
      return out;
    }

    function focusables() {
      const out = [];
      for (const root of modalRoots()) {
        for (const el of root.querySelectorAll(FOCUSABLE)) {
          if (el.disabled === true || el.hidden === true) continue;
          if (el.getClientRects().length === 0) continue;
          out.push(el);
        }
      }
      return out;
    }

    let closed = false;
    /**
     * Take the whole surface down, once, leaving nothing of this editor behind.
     *
     * Every listener installed on the DOCUMENT is removed here, and a drag in
     * flight is cancelled rather than left armed. That is not tidiness: a drag
     * installs `mousemove`/`mouseup` on the document, so an Escape pressed
     * mid-drag used to leave both attached, and the eventual release still ran
     * the paint — into a store that is no longer on screen, through an
     * `onGesture` whose owner had already been torn down. Measured: a
     * page-level `TypeError: Cannot set properties of null (setting
     * 'lastGesture')`, plus two leaked listeners per cancelled drag.
     *
     * `closed` is also checked by the gesture path itself, so a callback
     * already queued when this ran cannot reach the store either.
     */
    function close(reason) {
      if (closed) return;
      closed = true;
      drag = null;
      endpointDrag = null;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      // One canvas per session: `md2docTheme.onTheme` has no unsubscribe, so
      // `destroy()` is what stops this canvas following the theme.
      if (engineCanvas !== null) engineCanvas.destroy();
      d.removeEventListener('keydown', onKeyDown, true);
      d.removeEventListener('mousemove', onCanvasMove, true);
      d.removeEventListener('mouseup', onCanvasUp, true);
      unlockScroll();
      // Hand the keyboard back to whatever had it. In today's entry flow that
      // is `document.body` — the entry button is hidden inside its own click
      // handler, so the browser has already reset focus by the time this
      // constructor runs — and restoring body is what the browser does anyway
      // when the focused element is removed. It matters for the keyboard entry
      // path Task 7 adds, and it costs one guarded call.
      if (cameFrom !== null && cameFrom !== undefined && cameFrom !== d.body &&
          d.contains(cameFrom) && typeof cameFrom.focus === 'function') {
        cameFrom.focus();
      }
      // Anything that is not the Escape key is a commit. Spelled as a default
      // here rather than at each call site so a future exit route that forgets
      // to say which it is leaves the user's work standing instead of throwing
      // it away — the safe direction of the two.
      if (typeof opts.onClose === 'function') {
        opts.onClose(reason === 'escape' ? 'escape' : 'commit');
      }
    }

    /**
     * While this overlay is up it owns its own keys.
     *
     * Escape closes it, and undo/redo go to the STORE — the waveform's stack,
     * which is the one the user is looking at. Before this, Ctrl+Z inside the
     * overlay reached the surrounding editor and rolled back the MARKDOWN
     * DOCUMENT behind the modal (measured: the tail paragraph's edit
     * disappeared while the overlay stayed up), which also rewrote `lines` and
     * left the caller's line range stale. Capture phase, and
     * `stopPropagation()` on every key this claims, so the decision is made
     * here rather than by whichever listener happens to be registered first.
     */
    function onKeyDown(ev) {
      // Spec section 7.2: while an input method is composing, the keys are
      // the IME's — the Enter that picks a candidate, the Escape that drops
      // the composition, the Tab some IMEs use to page candidates. None of
      // them is a commit, a cancel or a focus move of this dialog's, so
      // nothing here claims a key until the composition ends. Dialog-wide
      // rather than per field, so every inline field (the data label today;
      // the rename, edge-label and note fields of Tasks 8 and 9) is covered
      // by this one line, and so are the single-key shortcuts, which only
      // ever apply on the canvas and never mid-composition.
      if (ev.isComposing === true || ev.keyCode === 229) return;
      // A key that came from the conflict banner is the banner's, not this
      // dialog's. The banner is inside `modalRoots()` on purpose — it has to
      // stay Tab-reachable — but that is a focus decision, not a claim on its
      // keys. MEASURED before this: a user who Tab-walked over to read the
      // banner and pressed Escape to back out lost the entire wave editing
      // session while the banner they were looking at stayed up.
      //
      // Nothing is swallowed here: no `preventDefault`, no `stopPropagation`, so
      // whatever else would handle that key still can. Today nothing does — the
      // banner has no Escape of its own (see `dismissKeynavExitBanner()`'s
      // comment) and client.js's own listener returns at the modal gate — so
      // Escape there is a no-op. A no-op is the right answer; losing the session
      // is not.
      //
      // Only ESCAPE is handed back, not every key: Tab has to stay trapped even
      // while the cursor is on the banner, or the walk leaves the modal layer
      // from its far end and the trap has a hole exactly where the banner is.
      const fromBanner = ev.target !== null && ev.target !== undefined &&
        typeof ev.target.closest === 'function' &&
        ev.target.closest('.ed-conflict') !== null;
      if (ev.key === 'Escape' && fromBanner) return;
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        // Escape is LAYERED: the innermost thing on screen first, this dialog
        // second, and (above) the conflict banner's own. The rename field
        // (the rail's, then; the name column's since Task 8) was the first
        // sub-panel this editor had, and before this its
        // Escape reached `close('escape')` — which DISCARDS the session. So
        // backing out of a half-typed group name threw away every gesture the
        // user had made, and the one Ctrl+Z that takes a discard back is not
        // something the keystroke announces.
        if (nameEdit !== null) { nameEdit.cancel(); return; }
        // v3.5.0 Task 11: the bus data-label field, this dialog's OTHER
        // text sub-panel — same layering reason as `nameEdit` just
        // above: without this, Escape typed while labelling a bus value
        // discarded the whole editing session instead of just the field.
        if (dataEdit !== null) { dataEdit.cancel(); return; }
        // Task 8: an open popover (a ⠿ menu, 週期與相位…, and with them the
        // toolbar's 更多 / 訊號 / 匯出) closes before the dialog does, and
        // the keyboard goes back to whatever opened it. Task 11 owns the
        // rest of the layering.
        if (popover !== null) { closePopover(true); return; }
        if (gripDrag !== null) { cancelGripDrag(); return; }
        // v3.5.0 Task 7: the armed/dragging edge gesture is this dialog's
        // OTHER sub-panel-shaped thing — not a text field, but still a
        // half-done action standing in front of the dialog's own Escape.
        // Cancelling it never touches the document (rule 2: nothing was
        // written yet), so there is no undo step to leave behind either.
        if (edgeMode !== 'idle') { setEdgeMode('idle'); render(); return; }
        // v3.5.0 Task 8: a third sub-panel-shaped thing, same rule — the
        // document is untouched during an endpoint drag (rule 3), so
        // cancelling it is nulling the one variable that both is and knows
        // the drag, then a repaint. The mousemove/mouseup listeners are left
        // attached exactly as `edgeMode`'s own cancel above leaves them:
        // `onCanvasUp` unconditionally removes both at its very first line
        // whenever the button eventually comes up, so a stray move in
        // between finds `endpointDrag === null`, falls through every other
        // branch and repaints nothing — no listener leak, no second rule.
        if (endpointDrag !== null) { endpointDrag = null; render(); return; }
        close('escape');
        return;
      }
      if (ev.key === 'Tab') {
        // Spec section 4.3: in the data-label field, Tab is「下一段」— the
        // label is written and the next data segment's field opens (Shift+Tab
        // the previous one) — rather than a walk through the dialog.
        if (dataEdit !== null && ev.target === dataEdit.input) {
          ev.preventDefault();
          ev.stopPropagation();
          dataEdit.step(ev.shiftKey ? -1 : 1);
          return;
        }
        // The trap. Without it the surrounding editor's own「nothing focused」
        // branch swallowed Tab and none of this dialog's controls could be
        // reached from the keyboard at all.
        const list = focusables();
        ev.preventDefault();
        ev.stopPropagation();
        if (list.length === 0) return;
        const at = list.indexOf(d.activeElement);
        const next = ev.shiftKey
          ? list[at <= 0 ? list.length - 1 : at - 1]
          : list[(at === -1 || at === list.length - 1) ? 0 : at + 1];
        next.focus();
        return;
      }
      // Task 8 (spec sections 4.3 and 4.4): the keys that act on the signal
      // whose NAME has the keyboard — its ⠿ is focused, or its ⠿ menu is
      // open with the keyboard in it. Del (and Backspace) deletes that
      // signal; F2 renames it (a group's ⠿: renames the group). On the
      // canvas Del still means cycles (`handleDrawingKey`) — the two never
      // hold at once, because the keyboard is in one place.
      if (store.ok === true && !ev.ctrlKey && !ev.metaKey && !ev.altKey && handleNameKey(ev)) return;
      /**
       * v3.6.0 Task 16: the dialog's four Alt+arrow chords.
       *
       *   Alt+↑ / Alt+↓   move the SELECTED LANE up or down the list.
       *   Alt+← / Alt+→   move the CELL CURSOR to the next transition, while
       *                   the 關聯線 gesture is armed.
       *
       * Alt is this dialog's "the arrow key, but coarser" modifier, and the
       * two halves are honestly not the same KIND of operation — vertically
       * it acts on the document (a lane changes place, `commit` runs),
       * horizontally only on the cursor (nothing is written). What they share
       * is that each is the larger-grained reading of the arrow beneath it,
       * and that neither is reachable any other way from the keyboard.
       *
       * Alt+←/→ arrived here in fix round 3, moved off plain ←/→. See the
       * long comment in `handleDrawingKey` for what that binding cost (T9b:
       * a jump can only land on a transition, so it left several cells with
       * no keyboard route at all, and the keyboard could no longer reproduce
       * the mouse's edge byte for byte). This branch is the only home
       * available to it: the call to `handleDrawingKey` below is gated on
       * `!ev.altKey`, so no Alt-modified key can reach that function, and
       * re-opening that gate is how `Ctrl+Z` routing would get disturbed.
       *
       * ALL FOUR ARE CLAIMED DIALOG-WIDE, including the two that then refuse.
       * `Alt+←`/`Alt+→` is Back/Forward in a desktop browser, and an
       * unclaimed one inside a modal editing session is a keystroke that can
       * navigate the whole session away. Claiming it — `preventDefault()` in
       * the capture phase, on every target inside this overlay — is the
       * direction that reduces that risk whichever way a given browser
       * behaves. MEASURED, and the measurement is INCONCLUSIVE rather than
       * reassuring: this repo's headless Chrome does not fire back-navigation
       * on a CDP-synthesised `Alt+ArrowLeft` at all — verified on a bare page
       * with no key handler of any kind, history length 3, document unchanged
       * — so the harness cannot answer the question either way, and a real
       * desktop browser is where it would have to be confirmed. The cost of
       * claiming it is one: Option+←/→ word navigation inside a lane's name
       * field, a single-line input, stops working.
       *
       * Task 14 took the rail's per-row ▲/▼ off — one pair per lane, none of
       * which fit in the slimmed row — and left the handle's drag-and-drop
       * as the only way to reorder a lane at all. A gesture that exists only
       * under a pointer is the gap v3.5.0 Task 10 spent a whole task closing
       * on this same surface, so it does not get to reopen here. The
       * reference fork never had a second door either: its shortcut parser
       * returns null the moment it sees `altKey`, so `moveLane` is
       * drag-only there. Ours has two doors and both go through the SAME
       * `codec.moveLane`, with display positions — the rail's own drop
       * handler in `wave-panels.js` is the other one — rather than growing a
       * second opinion about lane order.
       *
       * The LANE half is claimed here rather than inside `handleDrawingKey`
       * for two reasons that are both load-bearing. `handleDrawingKey`
       * accepts exactly two targets (the canvas and the dialog) and returns
       * false on anything else, while the place a person reordering lanes
       * actually sits is the lane's own NAME — since Task 8 its ⠿ in the name
       * column, where `moveLaneTo`'s `focusOverride` puts them and keeps
       * them, so Alt+↓ twice moves the same lane twice instead of two
       * different ones (`keyboardLane` picks that lane, not the selection).
       * And the call to it just below is gated on `!ev.altKey`, so an
       * Alt-modified key cannot reach it at all.
       *
       * Above the `!(ctrl||meta) || alt` gate further down, which returns on
       * any Alt key: everything Alt-modified this dialog claims has to be
       * claimed before that line.
       *
       * TWO THINGS THE CONDITION DELIBERATELY DOES NOT SAY, both v3.6.0 Task
       * 16 fix round 1, both documented rather than guarded:
       *
       * `ev.shiftKey` is not tested, so **Alt+Shift+↑/↓ moves the lane too**.
       * That is the same shape `isBrushKey` settled on (see its own comment
       * at the top of this file): keying an admission rule on Shift is what
       * blocked `P`/`N`/`|` from the keyboard entirely in v3.5.0 Task 10.
       * There is no second meaning for Shift here — a lane move has no range
       * to extend — so the extra modifier is harmless rather than ambiguous,
       * and refusing it would only make the key stop working for anyone
       * whose hand is still on Shift from a Shift+click on the rail.
       *
       * No sub-panel gate either. A press taken while the name field or the
       * bus data-label field is open moves the lane and lets the repaint
       * retire that field, dropping whatever was half-typed in it — exactly
       * what `Ctrl+Z` already does there (see `render()`'s own first line,
       * and `paintLayer`'s). Neither wedges the keyboard: each field's
       * `retire` names where it goes (the row's ⠿, or the canvas) whenever
       * nothing else has, so `restoreFocus` lands on a real element. Standing this gesture behind the sub-panels the
       * way Escape does is a design call this task did not take.
       */
      if (store.ok === true && ev.altKey === true && !ev.ctrlKey && !ev.metaKey &&
          (ev.key === 'ArrowUp' || ev.key === 'ArrowDown' ||
           ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
          // Task 8: with a signal's name holding the keyboard, that signal
          // moves (the ⠿ menu's 上移 / 下移 say Alt+↑ / Alt+↓); from the
          // canvas, the selected one, as before. A group's ⠿ (or its menu)
          // moves the group, like that menu's 上移 / 下移.
          const named = keyboardLane(ev.target);
          const group = named === null ? keyboardGroup(ev.target) : null;
          if (named !== null) {
            if (popover !== null) closePopover(true);
            moveLaneBy(named, ev.key === 'ArrowUp' ? -1 : 1);
          } else if (group !== null) {
            if (popover !== null) closePopover(true);
            moveGroupBy(group, ev.key === 'ArrowUp' ? -1 : 1);
          } else {
            moveSelectedLane(ev.key === 'ArrowUp' ? -1 : 1);
          }
          return;
        }
        // Armed only, and it REFUSES OUT LOUD otherwise rather than becoming
        // a silent no-op. `jumpTransition` writes `hoverBoundary`, which
        // `setEdgeMode` documents as meaningful only while 'armed' — a jump
        // taken while idle would leave a hot dot behind that nothing is
        // tracking, and it would light up the moment the user did arm.
        if (edgeMode !== 'armed') {
          notify('notice', '先按「關聯線」武裝，Alt+←／→ 才有轉態點可以跳');
          return;
        }
        jumpTransition(ev.key === 'ArrowRight' ? 1 : -1);
        return;
      }
      // The drawing's own keys, claimed here rather than on the canvas element
      // so they are decided in the same place — and in the same phase — as
      // Escape, Tab and undo/redo. Deliberately BELOW those three (a cell
      // cursor may not outrank the way out of the dialog) and ABOVE the
      // modifier gate below, so `Ctrl+Z` with the drawing focused still means
      // undo and nothing here has to re-implement it.
      if (store.ok === true && !ev.ctrlKey && !ev.metaKey && !ev.altKey &&
          handleDrawingKey(ev)) {
        return;
      }
      if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
      const undoKey = typeof ev.key === 'string' && ev.key.toLowerCase() === 'z';
      const redoKey = typeof ev.key === 'string' &&
        (ev.key.toLowerCase() === 'y' || (ev.key.toLowerCase() === 'z' && ev.shiftKey));
      // The unreadable panel has no store to move and no status line to write
      // to — `say` and the toolbar below are never constructed on that path —
      // but it still has to CLAIM undo and redo rather than let them past.
      // MEASURED before this: Ctrl+Z pressed over the unreadable panel reached
      // the surrounding editor and rolled the markdown document back behind a
      // modal the user cannot see past.
      if (store.ok !== true) {
        if (undoKey || redoKey) { ev.preventDefault(); ev.stopPropagation(); }
        return;
      }
      const key = typeof ev.key === 'string' ? ev.key.toLowerCase() : '';
      if (key === 'z' && !ev.shiftKey) {
        ev.preventDefault();
        ev.stopPropagation();
        if (store.undo()) afterStoreMoved('undo');
        else notify('notice', '沒有可以復原的動作');
        return;
      }
      if (key === 'y' || (key === 'z' && ev.shiftKey)) {
        ev.preventDefault();
        ev.stopPropagation();
        if (store.redo()) afterStoreMoved('redo');
        else notify('notice', '沒有可以重做的動作');
        return;
      }
      // Task 8: Ctrl+D, 建立副本 (spec section 4.4) — the signal whose name
      // has the keyboard, or from the canvas the cursor's. Claimed
      // everywhere in the dialog, so the browser's own Ctrl+D (bookmark)
      // never fires over the modal — in a text field (a name, a data
      // label) it is claimed and does nothing.
      if (key === 'd' && !ev.shiftKey) {
        ev.preventDefault();
        ev.stopPropagation();
        const named = keyboardLane(ev.target);
        const at = named !== null ? named
          : (ev.target === canvas && cursor !== null ? cursor.laneIndex : null);
        if (at !== null) {
          if (popover !== null) closePopover(true);
          duplicateLaneAt(at);
        }
        return;
      }
      // Task 7: the cycle clipboard. 複製 lives on the range toolbar (spec
      // section 4.3) and has no paste button beside it, so Ctrl+C / Ctrl+V on
      // the canvas are the keyboard's copy and its only paste: the copied
      // cycles go in front of the selection, every lane widening together.
      // On the canvas only — in a text field these are the field's own.
      if (ev.target === canvas && !ev.shiftKey && (key === 'c' || key === 'v')) {
        ev.preventDefault();
        ev.stopPropagation();
        if (key === 'c') copyCycles();
        else pasteAt('insert');
      }
    }
    d.addEventListener('keydown', onKeyDown, true);

    const panel = d.createElement('div');
    panel.className = 'ed-wave-panel';
    // The dialog itself is the initial focus holder — the ARIA pattern's own
    // default, and the one that does not put a highlight on ✕ the moment the
    // panel opens. `tabindex="-1"` makes it focusable without putting it in the
    // sequential tab order; the first Tab then lands on the first real control.
    panel.setAttribute('tabindex', '-1');
    overlay.appendChild(panel);

    // ── title bar (spec section 4.1): 編輯波形, the save status, ✕ ──────────
    const head = d.createElement('div');
    head.className = 'ed-wave-head';
    const heading = d.createElement('span');
    heading.className = 'ed-wave-title';
    heading.textContent = '編輯波形';
    head.appendChild(heading);
    // The FILE's save state (spec section 4.8), not this editor's: every
    // gesture is already written into the document, so what is unsaved is the
    // markdown file on disk. client.js answers `opts.saveStatus()` and pushes
    // every later change through `setSaveStatus` (the returned API).
    const saveStatusEl = d.createElement('span');
    saveStatusEl.className = 'ed-wave-save';
    head.appendChild(saveStatusEl);
    const saveKey = typeof opts.saveKeyHint === 'string' ? opts.saveKeyHint : 'Ctrl+S';
    function setSaveStatus(dirty) {
      const on = dirty === true;
      saveStatusEl.setAttribute('data-dirty', on ? '1' : '0');
      saveStatusEl.textContent = on ? '● 有未儲存的變更 · ' + saveKey + ' 儲存' : '✓ 已儲存';
    }
    const savedAtOpen = typeof opts.saveStatus === 'function' ? opts.saveStatus() : null;
    setSaveStatus(savedAtOpen !== null && typeof savedAtOpen === 'object' && savedAtOpen.dirty === true);
    const closeBtn = d.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ed-wave-close';
    closeBtn.setAttribute('data-focus-key', 'ed-wave-close');
    closeBtn.setAttribute('aria-label', '關閉');
    closeBtn.textContent = '✕';
    closeBtn.title = '關閉（修改已經寫進文件）';
    // Wrapped rather than passed straight in: a bare `close` receives the
    // MouseEvent as its first argument, and a reason parameter that is silently
    // fed a DOM event is one rename away from meaning something.
    closeBtn.addEventListener('click', function () { close('commit'); });
    head.appendChild(closeBtn);
    panel.appendChild(head);

    if (store.ok !== true) {
      // ── the block cannot be read back ──────────────────────────────────
      // Ruling P3-6 parses at Edit-click time, so this is the first moment
      // anyone could know. Say the message AND the offset, and turn the offset
      // into a line/column plus the text around it — an offset on its own is
      // not something a person can act on.
      const bad = d.createElement('div');
      bad.className = 'ed-wave-parse-error';
      const at = whereIs(opts.source, store.error.offset);
      const msg = d.createElement('p');
      msg.className = 'ed-wave-parse-message';
      msg.textContent = '這個 wavedrom 區塊讀不回來，所以沒有東西可以編輯：' +
        store.error.message;
      bad.appendChild(msg);
      const where = d.createElement('p');
      where.className = 'ed-wave-parse-where';
      where.textContent = '位置：offset ' + store.error.offset +
        '（第 ' + at.line + ' 行第 ' + at.column + ' 個字）';
      where.setAttribute('data-wave-offset', String(store.error.offset));
      bad.appendChild(where);
      const excerpt = d.createElement('pre');
      excerpt.className = 'ed-wave-parse-excerpt';
      excerpt.textContent = String(opts.source).split(/\r\n|\r|\n/)[at.line - 1] || '';
      bad.appendChild(excerpt);
      panel.appendChild(bad);
      overlay.setAttribute('data-wave-state', 'unreadable');
      lockScroll();
      host.appendChild(overlay);
      panel.focus();
      return { el: overlay, store: store, close: close, refresh: function () {},
        setSaveStatus: setSaveStatus };
    }

    overlay.setAttribute('data-wave-state', 'ready');
    // The marks start out addressing the document the store opened with.
    marksDoc = store.doc;

    // ── toolbar (spec section 4.2) ───────────────────────────────────────
    //
    // One row, left to right: 復原 重做 | the six resident brushes + 更多 |
    // ＋拍 －拍 | 訊號 | 關聯線 | ⚙ 匯出 | 完成 (pushed right). The buttons are
    // built further down, after every function they call; the row itself
    // goes in now so the DOM order is title bar, toolbar, notice, stage, hint.
    const toolbar = d.createElement('div');
    toolbar.className = 'ed-wave-toolbar';
    toolbar.setAttribute('aria-label', '波形工具列');
    panel.appendChild(toolbar);

    // The toolbar pieces, the popovers and the notice card are plain DOM
    // built by wave-panels.js. `actions.commit` is the one piece of this
    // file's state its settings writers (kept for Tasks 8 and 10) reach.
    const panels = opts.panels.createPanels({
      d: d, geometry: geometry, codec: codec, overlay: overlay,
      actions: { commit: commit },
    });

    // ── the one popover ──────────────────────────────────────────────────
    //
    // 更多, 訊號 and 匯出 each open a small popover under their button. Only
    // one is open at a time; it closes on a pick, on its button pressed
    // again, or on a press anywhere else in the dialog. On close the keyboard
    // goes back to the button that opened it (spec section 7.3). Task 8's
    // ⠿ menus and 週期與相位… are popovers too, opened by a row's ⠿; `extra`
    // says which (`{kind: 'lane', lane}`, `{kind: 'group', path}`,
    // `{kind: 'period', lane}`), which is how Del knows a lane menu is open.
    function closePopover(refocus) {
      if (popover === null) return;
      const p = popover;
      popover = null;
      if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
      p.owner.setAttribute('aria-expanded', 'false');
      if (refocus === true && d.contains(p.owner)) p.owner.focus();
    }
    function togglePopover(owner, build, extra) {
      if (popover !== null && popover.owner === owner) { closePopover(true); return; }
      closePopover(false);
      const el = build();
      panel.appendChild(el);
      const pr = panel.getBoundingClientRect();
      const br = owner.getBoundingClientRect();
      let left = br.left - pr.left;
      const width = el.getBoundingClientRect().width;
      if (left + width > pr.width - 8) left = Math.max(8, pr.width - 8 - width);
      el.style.left = left + 'px';
      el.style.top = (br.bottom - pr.top + 4) + 'px';
      owner.setAttribute('aria-expanded', 'true');
      popover = Object.assign({ el: el, owner: owner, kind: 'toolbar' }, extra || {});
      const first = el.querySelector('.is-on') || el.querySelector('button, input');
      if (first !== null) first.focus();
    }
    overlay.addEventListener('mousedown', function (ev) {
      if (popover === null) return;
      const t = ev.target;
      if (popover.el.contains(t) || popover.owner.contains(t)) return;
      closePopover(false);
    }, true);

    // ── 週期 (cycle) operations ──────────────────────────────────────────
    function insertCycle() {
      const at = selection === null ? 0 : Math.min(selection.from, selection.to);
      commit('insert-cycle', function (doc) { return codec.insertCycles(doc, at, 1); });
    }
    /**
     * Delete the selected cycles from every lane — －拍, the range toolbar's
     * 刪除 N 拍 and Del (spec section 4.3: Del deletes cycles whenever cycles
     * are selected, and the cursor alone counts as one).
     *
     * What is left selected is the one cycle at the cut, with the cursor on
     * it, so the floating toolbar goes away with the run it was about and a
     * second Del takes the next cycle rather than a run that is no longer
     * there. When the keyboard was on that toolbar, it goes back to the
     * canvas instead of to a button the repaint removes.
     */
    function deleteCycles() {
      const sel = selection !== null ? selection : (cursor === null ? null
        : { laneIndex: cursor.laneIndex, laneTo: cursor.laneIndex, from: cursor.cycle, to: cursor.cycle });
      if (sel === null) { notify('notice', '先選一段 cycle 再刪'); return; }
      const from = Math.min(sel.from, sel.to);
      const count = Math.abs(sel.to - sel.from) + 1;
      const was = { selection: selection, cursor: cursor, focusOverride: focusOverride };
      selection = { laneIndex: sel.laneIndex, laneTo: sel.laneTo, from: from, to: from };
      if (cursor !== null) cursor = { laneIndex: sel.laneIndex, cycle: from };
      if (focusOverride === null && rangeBar !== null && rangeBar.el.contains(d.activeElement)) {
        focusOverride = 'canvas';
      }
      const done = commit('delete-cycle', function (doc) { return codec.deleteCycles(doc, from, count); });
      if (!done) {
        selection = was.selection; cursor = was.cursor; focusOverride = was.focusOverride;
      }
    }

    /**
     * Insert `count` cycles at boundary `at` (in front of cycle `at`; `at`
     * may be the cycle count, the end) in every lane, keeping the cursor and
     * the selection on the cycles they were on — the ruler's ＋ and the range
     * toolbar's 前插 / 後插 (spec section 4.3). A mark at or after the
     * boundary moves right with its cycle; `carryMarks` only follows LANES,
     * so the cycle half of the shift is said here, before the commit, and
     * taken back if the commit refuses.
     */
    function insertCyclesKeepingMarks(at, count, name, fn) {
      const was = { selection: selection, cursor: cursor };
      const move = function (c) { return c >= at ? c + count : c; };
      if (selection !== null) {
        selection = { laneIndex: selection.laneIndex, laneTo: selection.laneTo,
          from: move(selection.from), to: move(selection.to) };
      }
      if (cursor !== null) cursor = { laneIndex: cursor.laneIndex, cycle: move(cursor.cycle) };
      const done = commit(name, fn);
      if (!done) { selection = was.selection; cursor = was.cursor; }
      return done;
    }
    function insertCyclesAt(at) {
      return insertCyclesKeepingMarks(at, 1, 'insert-cycle', function (doc) {
        return codec.insertCycles(doc, at, 1);
      });
    }

    // Copy and paste of a cycle range: 複製 is on the range toolbar (spec
    // section 4.3), and Ctrl+C / Ctrl+V on the canvas are the keyboard's
    // copy and its paste (`onKeyDown`).
    function copyCycles() {
      if (selection === null) { notify('notice', '先選一段 cycle 再複製'); return; }
      const from = Math.min(selection.from, selection.to);
      const count = Math.abs(selection.to - selection.from) + 1;
      clip = codec.copyCycles(store.doc, from, count);
      notify('notice', '複製了 ' + count + ' 個 cycle');
      render();
    }
    function pasteAt(mode) {
      if (clip === null) { notify('notice', '剪貼簿是空的'); return; }
      const at = selection === null ? 0 : Math.min(selection.from, selection.to);
      const paste = function (doc) { return codec.pasteCycles(doc, at, clip, mode); };
      // An inserting paste widens every lane in front of the selection, so
      // the marks move right with their cycles; an overwrite moves nothing.
      if (mode === 'insert') insertCyclesKeepingMarks(at, clip.count, 'paste-' + mode, paste);
      else commit('paste-' + mode, paste);
    }

    /**
     * The cell the A and T actions start from: the cursor while it sits on
     * the selection's lane (the run's live end), otherwise the run's first
     * cycle. Null when nothing is selected.
     */
    function actionCell() {
      if (cursor !== null && (selection === null || selection.laneIndex === cursor.laneIndex)) return cursor;
      if (selection === null) return null;
      return { laneIndex: selection.laneIndex, cycle: Math.min(selection.from, selection.to) };
    }
    // Ruling R12: the range toolbar's 關聯線 (A) and 標註 (T), and the A and
    // T keys on the canvas, call these two. Task 9 implements them (spec
    // section 4.5); until then they do nothing.
    function startEdgeFromCell(laneIndex, cycle) { /* Task 9 */ }
    function startNoteAt(laneIndex, cycle) { /* Task 9 */ }

    // ── 電位 (brushes) ───────────────────────────────────────────────────
    //
    // Spec section 4.2: six resident levels on the toolbar, the other sixteen
    // in 更多's grouped grid. Every brush button, wherever it sits, is built
    // by `brushButton` with the glyph from `drawer.levelIcon` and the
    // keyboard character as a caption, so the two places cannot draw a brush
    // differently.
    //
    // `pick`, when given, makes the button a LEVEL for the selected run (the
    // range toolbar's 電位 ⌄, spec section 4.3) instead of a brush: it paints
    // the run through `pick(ch)` and leaves the brush alone, has its own
    // `range-level-` focus key (a repaint must not land the keyboard on the
    // toolbar's brush of the same character), and is skipped by
    // `paintBrushState` (which brush is on says nothing about the run).
    function brushButton(ch, pick) {
      const b = d.createElement('button');
      b.type = 'button';
      b.className = 'ed-wave-brush';
      b.setAttribute('data-brush', ch);
      b.appendChild(drawer.levelIcon(ch));
      const cap = d.createElement('span');
      cap.className = 'ed-wave-brush-char';
      cap.textContent = ch;
      b.appendChild(cap);
      if (typeof pick === 'function') {
        b.setAttribute('data-range-level', ch);
        b.setAttribute('data-focus-key', 'range-level-' + ch);
        b.title = '把選取的拍改成 ' + ch;
        b.addEventListener('click', function () {
          closePopover(true);
          pick(ch);
        });
        return b;
      }
      b.setAttribute('data-focus-key', 'brush-' + ch);
      b.title = '電位 ' + ch + '（在畫布上按 ' + ch + ' 也能選用）';
      if (ch === brush) b.classList.add('is-on');
      b.addEventListener('click', function () {
        brush = ch;
        // A pick from the grid closes it and hands the keyboard back to 更多.
        const fromGrid = popover !== null && popover.el.contains(b);
        if (fromGrid) closePopover(true);
        paintBrushState();
      });
      return b;
    }

    /**
     * The overlay's `data-wave-lane-range`, repainted from `selection`.
     *
     * Called from `render()`, from `repaintDrawing()`, and from every inline
     * `paintLayer` site in this file, because each of those writes
     * `selection` and none of them rebuilds the toolbar. Until Task 6b this
     * also kept the 訊號 / 群組 buttons' enabled state and landing labels;
     * those buttons are gone (the 訊號 menu computes its landing when it
     * opens), and the lane-range attribute is what is left.
     */
    function paintSelectionState(doc, layout) {
      overlay.setAttribute('data-wave-lane-range', selection === null ? ''
        : selection.laneIndex + ',' + selection.laneTo);
    }

    /** Which brush is on: every brush button on screen (the toolbar's and,
     *  while it is open, the grid's), 更多 itself when the brush is one of
     *  the grid's, and the overlay's `data-wave-brush`. */
    function paintBrushState() {
      for (const b of overlay.querySelectorAll('.ed-wave-brush')) {
        if (b.hasAttribute('data-range-level')) continue;
        b.classList.toggle('is-on', b.getAttribute('data-brush') === brush);
      }
      moreBtn.classList.toggle('is-on', BRUSH_RESIDENT.indexOf(brush) === -1);
      overlay.setAttribute('data-wave-brush', brush);
    }

    /**
     * Where 訊號's 新增訊號 / 新增空白列 put their new lane: right after the selection, and
     * at the very top when there is nothing selected.
     *
     * "After the selection" is `laneTo + 1`, not `laneIndex + 1`: with a
     * whole range picked, adding below the range is the only reading that
     * does not silently cut it in half.
     *
     * The no-selection answer is 0 rather than the end, and that is the one
     * choice here that is not obvious. The rail used to carry a ＋ at every
     * position — one per row plus a tail — so every insert position from 0
     * to n was reachable in one press. One button that only ever inserts
     * AFTER something cannot offer position 0 at all: there is no lane to
     * be after. Pairing "after the selection" with "0 when there is no
     * selection" restores the full range — 0 with nothing picked, k+1 with
     * lane k picked, the end with the last lane picked — and it costs one
     * surprising default instead of one unreachable position. The button
     * says which it is about to do before it is pressed (`data-lands-in`
     * and the tooltip), so the surprise is visible rather than discovered.
     */
    function signalInsertAt(layout) {
      const l = layout === undefined || layout === null
        ? layoutNow() : layout;
      if (selection === null) return 0;
      return Math.min(selection.laneTo + 1, l.lanes.length);
    }

    /**
     * Insert `lane` so it becomes display position `at`, and say which
     * container it landed in (constraint 4). 訊號's two items, the ⠿ menu's
     * 在下方新增訊號 / 在下方新增空白列 and the ＋ 新增訊號 row all come here.
     */
    function addLaneAt(at, name, lane) {
      const landing = panels.landingOf(store.doc, at);
      const where = landing.title === null ? '群組外' : '群組「' + landing.title + '」裡';
      const added = commit(name, function (doc2) { return codec.addLane(doc2, at, lane); });
      // fix round 1 (F6): the whole prefix per branch, not one concatenation
      // with a shared 落在. The two bases differ by exactly one space — the
      // lane phrase ends in a Latin word, the spacer one in a CJK one — so a
      // single shared suffix has to get one of them wrong.
      const lead = lane.wave === undefined ? '空白列落在' : '新增的 lane 落在';
      if (added) notify('notice', lead + where);
      return added;
    }
    function addLaneFromToolbar(name, lane) {
      addLaneAt(signalInsertAt(), name, lane);
    }

    /** The 訊號 menu (spec section 4.2): 新增訊號, 新增空白列. Each item
     *  says where its lane will land before it is pressed (constraint 4).
     *  A pick hands the keyboard back to 訊號 first, so the repaint the
     *  commit runs finds it there (the item itself is gone by then). */
    function signalMenu() {
      const at = signalInsertAt();
      const landing = panels.landingOf(store.doc, at);
      const where = landing.title === null ? '群組外' : '群組「' + landing.title + '」裡';
      const el = panels.menu('ed-wave-signal-pop', [
        { key: 'ed-wave-signal-add', label: '新增訊號',
          title: '在選取的 lane 後面加一條（沒有選取就加在最前面）—— 會落在' + where,
          run: function () { closePopover(true); addLaneFromToolbar('add-lane', { name: '', wave: 'x' }); } },
        { key: 'ed-wave-signal-blank', label: '新增空白列',
          title: '在選取的 lane 後面插入一個空白列（WaveJSON 的 {}，用來空出間距）—— 會落在' + where,
          run: function () { closePopover(true); addLaneFromToolbar('add-spacer', {}); } },
      ]);
      for (const b of el.querySelectorAll('button')) {
        b.setAttribute('data-insert-at', String(at));
        b.setAttribute('data-lands-in', landing.title === null ? '' : landing.title);
      }
      return el;
    }

    // ── the signals: what the name column's ⠿ does (spec section 4.4) ───
    //
    // Every operation here names its lane by display position, the way the
    // codec counts (constraint 2). The ⠿ menu, its shortcuts (F2, Ctrl+D,
    // Alt+↑/↓, Del) and the ⠿ drag all end here, so the menu and the keys
    // cannot disagree about what an action means.

    /** A WaveJSON blank row (`{}`): no name and no wave. It is a row with a
     *  ⠿ like any other, but has no name to rename. */
    function isSpacer(lane) {
      return lane === null || typeof lane !== 'object' ||
        (lane.name === undefined && lane.wave === undefined);
    }
    /** The focus keys of a lane's ⠿ and of a group's ⠿. A group is named by
     *  its path, which is what moves with it. */
    function gripKey(i) { return 'grip-' + i; }
    function groupGripKey(path) { return 'group-grip-' + path.join('.'); }

    /** Whether the keyboard is in the name column: on a ⠿, or in a menu or
     *  panel one opened. Gestures started there leave the keyboard on the
     *  ⠿ of the row they acted on; from anywhere else they leave it alone. */
    function keyboardOnNames() {
      const a = d.activeElement;
      if (a === null || a === undefined || typeof a.closest !== 'function') return false;
      if (a.closest('.ed-wave-grip') !== null && overlay.contains(a)) return true;
      return popover !== null && popover.kind !== 'toolbar' && popover.el.contains(a);
    }
    /**
     * The lane whose NAME has the keyboard, for an event aimed at `target`:
     * its ⠿ is focused, or its ⠿ menu is open and the keyboard is in that
     * menu (spec section 4.3: then Del deletes the signal). Null otherwise —
     * 週期與相位…'s fields are text the keyboard is typing into, not a name.
     */
    function keyboardLane(target) {
      if (target === null || target === undefined || typeof target.closest !== 'function') return null;
      const grip = target.closest('.ed-wave-grip');
      if (grip !== null && overlay.contains(grip) && grip.hasAttribute('data-lane')) {
        return Number(grip.getAttribute('data-lane'));
      }
      if (popover !== null && popover.kind === 'lane' && popover.el.contains(target)) return popover.lane;
      return null;
    }
    /** The same for a group's ⠿: the span (`geometry.groupSpansOf`) or null. */
    function keyboardGroup(target) {
      if (target === null || target === undefined || typeof target.closest !== 'function') return null;
      const grip = target.closest('.ed-wave-grip');
      let key = null;
      if (grip !== null && overlay.contains(grip) && grip.hasAttribute('data-group')) {
        key = grip.getAttribute('data-group');
      } else if (popover !== null && popover.kind === 'group' && popover.el.contains(target)) {
        key = popover.path.join('.');
      }
      return key === null ? null : spanByKey(key);
    }
    function spanByKey(key) {
      for (const s of geometry.groupSpansOf(store.doc, layoutNow())) {
        if (s.path.join('.') === key) return s;
      }
      return null;
    }

    /** Del / F2 with a name holding the keyboard (`onKeyDown`). */
    function handleNameKey(ev) {
      const key = ev.key;
      if (key !== 'Delete' && key !== 'Backspace' && key !== 'F2') return false;
      const lane = keyboardLane(ev.target);
      const group = lane === null && key === 'F2' ? keyboardGroup(ev.target) : null;
      if (lane === null && group === null) return false;
      ev.preventDefault();
      ev.stopPropagation();
      if (popover !== null) closePopover(true);
      if (group !== null) { openGroupRename(group); return true; }
      if (key === 'F2') openLaneRename(lane);
      else removeLaneAt(lane);
      return true;
    }

    /** 刪除 (Del): the lane at `at`. The keyboard, if it was on the names,
     *  lands on the ⠿ of whichever lane takes the row (the last one when the
     *  bottom lane went, ＋ 新增訊號 when none is left). */
    function removeLaneAt(at) {
      const n = layoutNow().lanes.length;
      if (at < 0 || at >= n) return;
      if (keyboardOnNames()) {
        focusOverride = n - 1 === 0 ? 'ed-wave-add-lane' : gripKey(Math.min(at, n - 2));
      }
      const removed = commit('remove-lane', function (doc2) { return codec.removeLane(doc2, at); });
      if (removed) notify('notice', '已刪掉 1 條 lane —— Ctrl+Z 可以拿回來');
    }
    /** 建立副本 (Ctrl+D): a copy of lane `at`, right under it. */
    function duplicateLaneAt(at) {
      if (at < 0 || at >= layoutNow().lanes.length) return;
      const landing = panels.landingOf(store.doc, at + 1);
      const where = landing.title === null ? '群組外' : '群組「' + landing.title + '」裡';
      if (keyboardOnNames()) focusOverride = gripKey(at + 1);
      const didDup = commit('duplicate-lane', function (doc2) {
        return codec.duplicateLane(doc2, at);
      });
      if (didDup) notify('notice', '複製的 lane 落在' + where);
    }

    /**
     * 上移 / 下移 (Alt+↑ / Alt+↓): move lane `at` one row (`step` -1 or 1).
     * Both ends of the list REFUSE OUT LOUD instead of silently doing
     * nothing: a key that does nothing and says nothing is, to the person
     * pressing it, indistinguishable from a key this dialog never bound.
     */
    function laneStepRefusal(at, step) {
      const to = at + step;
      if (to < 0) return '這已經是第一條 lane 了，沒有更上面的位置';
      if (to >= layoutNow().lanes.length) return '這已經是最後一條 lane 了，沒有更下面的位置';
      return null;
    }
    function moveLaneBy(at, step) {
      const refused = laneStepRefusal(at, step);
      if (refused !== null) { notify('notice', refused); return; }
      moveLaneTo(at, at + step);
    }
    /**
     * Move lane `at` so it becomes display position `to` (`codec.moveLane`,
     * counted after the lift) — 上移 / 下移, Alt+↑/↓ and the ⠿ drag.
     *
     * The marks are NOT re-pointed here: `carryMarks` follows every lane by
     * identity through the store's trace, so the cursor and the selection
     * stay on the lanes they were on wherever those went.
     *
     * v3.6.0 Task 16 fix round 1: SAY WHICH CONTAINER IT LANDED IN. A move
     * may cross a group boundary (`laneInsertPath`'s asymmetry) and the
     * flattened name order is the only thing that changes on screen, so
     * this re-parenting gesture must not be the quietest one. Asked of the
     * document AFTER the move: `laneInsertPath(doc, to)` means "in front of
     * whichever lane sits at `to`, in THAT lane's own container", and after
     * the move the lane at `to` is the moved one.
     */
    function moveLaneTo(at, to) {
      if (keyboardOnNames()) focusOverride = gripKey(to);
      const didMove = commit('move-lane', function (doc2) {
        return codec.moveLane(doc2, at, to);
      });
      if (didMove) {
        const landing = panels.landingOf(store.doc, to);
        notify('notice', '搬動的 lane 落在' +
          (landing.title === null ? '群組外' : '群組「' + landing.title + '」裡'));
      }
    }
    /**
     * v3.6.0 Task 16: Alt+↑ / Alt+↓ from the canvas move the SELECTED lane —
     * one lane, the range's first (`moveLane` moves one lane; a loop over a
     * range would renumber each member out from under the next). The marks
     * are collapsed onto it first, at its old row, and `carryMarks` takes
     * them to the new one. MEASURED in a real browser on the journey
     * fixture, both from the trace alone: Alt+↓ on the lane selected at row
     * 0 with no cell cursor yet took `data-wave-lane-range` 0,0 → 1,1 and
     * left `data-wave-cursor` empty; Alt+↑ with the cell cursor on the moved
     * lane at row 2 took `data-wave-cursor` 2,0 → 1,0.
     */
    function moveSelectedLane(step) {
      if (selection === null) { notify('notice', '先選一條 lane 再搬'); return; }
      const at = selection.laneIndex;
      const refused = laneStepRefusal(at, step);
      if (refused !== null) { notify('notice', refused); return; }
      selection = { laneIndex: at, laneTo: at, from: selection.from, to: selection.to };
      moveLaneTo(at, at + step);
    }

    /**
     * 和下一條組成群組: lane `at` and the one under it become a new group,
     * and the group's name field opens right away, the way a new group used
     * to get its rename field (spec section 4.4). The two have to sit in
     * the same array: WaveJSON's group is one slice of one array.
     */
    function groupWithNext(at) {
      const layout = layoutNow();
      if (at + 1 >= layout.lanes.length) {
        notify('notice', '這是最後一條，下面沒有可以一起組成群組的訊號');
        return;
      }
      const committed = commit('group-lanes', function (doc2) {
        return codec.groupLanes(doc2, [at, at + 1], '');
      });
      if (!committed) {
        notify('notice', '這一條和下一條不在同一層，WaveJSON 的群組只能是同一層裡連續的一段');
        return;
      }
      const after = layoutNow();
      const path = after.lanes[at].path.slice(0, -1);
      const span = spanByKey(path.join('.'));
      if (span !== null) openGroupRename(span);
    }
    /**
     * 解散群組: the group's lanes stay where they are and the group goes.
     * `codec.ungroupLanes` names a group by one of its DIRECT member lanes,
     * so the first such lane in the span is asked for; a group made only of
     * sub-groups has none, and says so.
     */
    function ungroupSpan(span) {
      const layout = layoutNow();
      let member = null;
      for (let i = span.from; i <= span.to; i++) {
        const row = layout.lanes[i];
        if (row !== undefined && row.path.length === span.path.length + 1) { member = i; break; }
      }
      if (member === null) {
        notify('notice', '這個群組裡只有子群組，先解散裡面的群組');
        return;
      }
      if (keyboardOnNames()) focusOverride = gripKey(span.from);
      const done = commit('ungroup', function (doc2) { return codec.ungroupLanes(doc2, member); });
      if (!done) notify('notice', '這個群組解散不了');
    }
    /** 上移 / 下移 for a group: it trades places with its neighbour in the
     *  array that holds it (`panels.commitGroupMove`). */
    function moveGroupBy(span, dir) {
      const dest = panels.groupStepPath(store.doc, span.path, dir);
      if (dest === null) {
        notify('notice', dir < 0 ? '這個群組已經在最上面了' : '這個群組已經在最下面了');
        return;
      }
      if (keyboardOnNames()) focusOverride = groupGripKey(dest);
      panels.commitGroupMove(span.path, dir);
    }

    // ── the ⠿ menus and 週期與相位… ───────────────────────────────────────
    /** A menu item's action: the menu goes first (the keyboard back on the
     *  ⠿ that opened it), then the gesture runs. */
    function picked(fn) {
      return function () { closePopover(true); fn(); };
    }
    function toggleLaneMenu(i, grip) {
      togglePopover(grip, function () {
        const row = layoutNow().lanes[i];
        const actions = {
          copy: picked(function () { duplicateLaneAt(i); }),
          addBelow: picked(function () { addLaneAt(i + 1, 'add-lane', { name: '', wave: 'x' }); }),
          blankBelow: picked(function () { addLaneAt(i + 1, 'add-spacer', {}); }),
          up: picked(function () { moveLaneBy(i, -1); }),
          down: picked(function () { moveLaneBy(i, 1); }),
          group: picked(function () { groupWithNext(i); }),
          period: function () { closePopover(false); openPeriodPopover(i, grip); },
          remove: picked(function () { removeLaneAt(i); }),
        };
        if (row !== undefined && !isSpacer(row.lane)) {
          actions.rename = picked(function () { openLaneRename(i); });
        }
        return panels.laneMenu(grip, { isGroup: false, actions: actions });
      }, { kind: 'lane', lane: i });
    }
    function toggleGroupMenu(span, grip) {
      togglePopover(grip, function () {
        return panels.laneMenu(grip, { isGroup: true, actions: {
          rename: picked(function () { openGroupRename(span); }),
          ungroup: picked(function () { ungroupSpan(span); }),
          up: picked(function () { moveGroupBy(span, -1); }),
          down: picked(function () { moveGroupBy(span, 1); }),
        } });
      }, { kind: 'group', path: span.path });
    }
    function openPeriodPopover(i, grip) {
      const row = layoutNow().lanes[i];
      if (row === undefined) return;
      togglePopover(grip, function () { return panels.periodPhasePopover(row.lane, i); },
        { kind: 'period', lane: i });
    }

    // ── the in-place name field (spec section 4.4) ──────────────────────
    /** 改名 / F2 / a click on the name: the field over lane `i`'s name. A
     *  blank row has none; its ⠿ takes the keyboard instead. */
    function openLaneRename(i) {
      const layout = layoutNow();
      const row = layout.lanes[i];
      if (row === undefined) return;
      if (isSpacer(row.lane)) {
        focusByKey(gripKey(i));
        notify('notice', '空白列沒有名稱可以改');
        return;
      }
      const box = nameBoxClient(layout, i);
      if (box === null) return;
      openNameField({
        box: box, value: typeof row.lane.name === 'string' ? row.lane.name : '',
        focusKey: 'lane-rename-' + i, back: gripKey(i), group: false,
        write: function (value) {
          commit('rename', function (doc2) { return codec.renameLane(doc2, i, value); });
        },
      });
    }
    /** 改名 on a group's ⠿: the field over the group's title. */
    function openGroupRename(span) {
      const box = groupBoxClient(layoutNow(), span);
      if (box === null) return;
      openNameField({
        box: box, value: span.title, focusKey: 'group-rename-' + span.path.join('.'),
        back: groupGripKey(span.path), group: true,
        write: function (value) { panels.commitGroupTitle(span.path, value); },
      });
    }
    /**
     * Open the name field (`panels.renameField`) over `o.box` (client px),
     * placed in the stage's scrolled content box like the data-label field.
     *
     * Same `{cancel, retire}` contract as `openDataEdit`: Enter / leaving
     * the field writes (once — a latch, because Enter, `change` and `blur`
     * can all arrive for one commit); Esc (`onKeyDown`'s layering, or the
     * field's own key handler while the dialog's stands aside) takes it
     * down unwritten; a repaint underneath it (`render`) retires it. The
     * keyboard ends on the row's ⠿ (`o.back`) whenever the field had it —
     * the "focus is on the signal's name" state in which Del deletes the
     * signal — never on `document.body`.
     */
    function openNameField(o) {
      if (nameEdit !== null) nameEdit.cancel();
      if (dataEdit !== null) dataEdit.cancel();
      let input = null;
      const live = function () { return nameEdit !== null && nameEdit.input === input; };
      const takeDown = function () { if (input.parentNode !== null) input.parentNode.removeChild(input); };
      const holdsKeyboard = function () { return d.activeElement === input; };
      const finish = function (value) {
        if (!live()) return;
        nameEdit = null;
        const hadKeyboard = holdsKeyboard();
        takeDown();
        if (value === o.value) {
          if (hadKeyboard) focusByKey(o.back);
          return;
        }
        if (focusOverride === null && (hadKeyboard || !overlay.contains(d.activeElement))) {
          focusOverride = o.back;
        }
        o.write(value);
      };
      const cancel = function () {
        if (!live()) return;
        nameEdit = null;
        takeDown();
        focusByKey(o.back);
      };
      const retire = function () {
        if (!live()) return;
        nameEdit = null;
        if (focusOverride === null && holdsKeyboard()) focusOverride = o.back;
        takeDown();
      };
      input = panels.renameField({ value: o.value, focusKey: o.focusKey, onCommit: finish, onCancel: cancel });
      if (o.group) input.classList.add('is-group');
      const wr = stage.getBoundingClientRect();
      input.style.left = (o.box.left - wr.left - stage.clientLeft + stage.scrollLeft) + 'px';
      input.style.top = (o.box.top - wr.top - stage.clientTop + stage.scrollTop) + 'px';
      input.style.width = o.box.width + 'px';
      input.style.height = o.box.height + 'px';
      stage.appendChild(input);
      nameEdit = { cancel: cancel, retire: retire, input: input };
      input.focus();
      input.select();
    }
    /** Put the keyboard on the element carrying `key`, or on the dialog
     *  when the repaint did not bring it back — never on nothing. */
    function focusByKey(key) {
      const el = overlay.querySelector('[data-focus-key="' + key + '"]');
      if (el !== null && el.disabled !== true) el.focus();
      else panel.focus();
    }

    // ── 匯出 ──────────────────────────────────────────────────────────────
    //
    // THE SOURCE IS THE ENGINE'S OWN OUTPUT, so what a user exports is the
    // same picture the rendered document shows. Since Task 6a (Ruling R3)
    // that is the canvas's engine svg — the side preview it used to read no
    // longer renders — cloned at the engine's own size (`engineSize`), not at
    // the canvas's 1.5x. Task 10 replaces this with a clean offscreen render
    // (until then a dark-mode export carries the canvas's dark recolour).
    //
    // Every browser global the three need — `XMLSerializer`, `Blob`, `URL`,
    // `Image`, `setTimeout`, `navigator` — is reached through `probeWin`
    // (`d.defaultView`, declared beside `sourceText` above), never as a bare
    // identifier: this file is require-able in node against a fake
    // `opts.document` (see its header) and names no global of its own.

    /**
     * The canvas's engine SVG, serialised so that it still draws OUTSIDE this page.
     *
     * The plain `serializeToString(svg)` that this obviously wants to be is a
     * trap, and a quiet one. The canvas renders with `notFirstSignal`
     * true whenever a WaveDrom skin is already on the page — which is ALWAYS
     * in the flow that reaches this editor, because the entry affordance only
     * appears over a rendered diagram — so the preview SVG carries neither the
     * skin's `<defs>` nor its `<style>`. MEASURED on this repo's own wave
     * fixture: the preview SVG is 5057 bytes with 51 `<use>` elements, 0
     * `<defs>` and 0 `<style>`, every one of those 51 pointing at an id that
     * lives in a DIFFERENT SVG on the page. Serialised as-is it opens as half
     * a picture — the whole clock lane and every brick shape gone, all text in
     * the browser's default font — and it opens that way without erroring, so
     * a check that the file was written, or that the click did not throw, sees
     * nothing at all. Rasterised: 1409 non-white pixels of 54000 against 5693
     * for the self-contained file.
     *
     * So: clone the canvas svg at the engine's own size, and if the clone has
     * no `<defs>` of its own, prepend a CLONE of the page skin's `<style>` and
     * `<defs>`.
     */
    function exportSvgText() {
      const svg = engineCanvas === null ? null : engineCanvas.svg;
      if (svg === null || svg === undefined) return '';
      const size = engineSize(svg);
      const clone = svg.cloneNode(true);
      clone.setAttribute('width', String(size.w));
      clone.setAttribute('height', String(size.h));
      if (clone.querySelector('defs') === null) {
        // `#socket` is the skin's own first entry, asked for INSIDE a
        // WaveDrom-rendered SVG's defs — the identical question, asked the
        // identical way, that wave-canvas.js `skinElsewhere` asks to decide whether to emit a
        // skin at all. Two different answers to "is the skin on this page"
        // would be exactly the disagreement that leaves this export broken.
        const socket = d.querySelector('svg.WaveDrom defs #socket');
        const skin = socket === null ? null : socket.closest('svg');
        if (skin !== null) {
          const defs = skin.querySelector('defs');
          const style = skin.querySelector('style');
          // CLONED, never moved. These nodes are what every diagram ON THE
          // PAGE draws from; an export that took them would blank the whole
          // document behind the dialog the first time anyone pressed 匯出.
          if (defs !== null) clone.insertBefore(defs.cloneNode(true), clone.firstChild);
          if (style !== null) clone.insertBefore(style.cloneNode(true), clone.firstChild);
        }
      }
      return new probeWin.XMLSerializer().serializeToString(clone);
    }

    /**
     * The engine's own size of the canvas svg: its viewBox, which the canvas
     * keeps when it enlarges width/height by `CANVAS_SCALE`. Falls back to the
     * scaled attributes divided back down.
     */
    function engineSize(svg) {
      const vb = String(svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
      if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { w: vb[2], h: vb[3] };
      const k = engineCanvas === null ? 1 : engineCanvas.scale;
      return { w: Number(svg.getAttribute('width')) / k, h: Number(svg.getAttribute('height')) / k };
    }

    function downloadBlob(blob, filename) {
      const url = probeWin.URL.createObjectURL(blob);
      const a = d.createElement('a');
      a.href = url;
      a.download = filename;
      d.body.appendChild(a);
      a.click();
      a.remove();
      // revoke 延後一拍：立刻 revoke 會讓某些瀏覽器在下載開始前就失去來源。
      probeWin.setTimeout(function () { probeWin.URL.revokeObjectURL(url); }, 1000);
    }

    function exportSvg() {
      const text = exportSvgText();
      if (text === '') { notify('notice', '波形還沒畫出來，沒有東西可以匯出'); return; }
      downloadBlob(new probeWin.Blob([text], { type: 'image/svg+xml' }), exportName('svg'));
      notify('notice', '已匯出 ' + exportName('svg'));
    }

    // PNG is rasterised at twice the SVG's own size: at 1x a 300-480px wide
    // diagram goes soft the moment it is pasted into a slide or shown on a
    // high-density screen (wave redesign spec section 5-7). The SVG is drawn
    // at the target size, so lines and text are re-rasterised, not upscaled.
    const PNG_SCALE = 2;

    function exportPng() {
      const text = exportSvgText();
      if (text === '') { notify('notice', '波形還沒畫出來，沒有東西可以匯出'); return; }
      const size = engineSize(engineCanvas.svg);
      const w = size.w;
      const h = size.h;
      // A zero-sized canvas is not an error to `toBlob`: it hands back a
      // perfectly valid, perfectly empty PNG. Refuse it in words rather than
      // let the user save a file that is a picture of nothing.
      if (!(w > 0) || !(h > 0)) {
        notify('notice', '波形的尺寸讀不出來，PNG 匯不出去');
        return;
      }
      const img = d.createElement('img');
      img.onload = function () {
        const cv = d.createElement('canvas');
        cv.width = w * PNG_SCALE; cv.height = h * PNG_SCALE;
        const ctx2 = cv.getContext('2d');
        // The SVG's own background rect is white, but only over its own box;
        // painting white first means a PNG dropped into a dark-themed document
        // does not show that document's background through the margins.
        ctx2.fillStyle = '#ffffff';
        ctx2.fillRect(0, 0, cv.width, cv.height);
        ctx2.drawImage(img, 0, 0, cv.width, cv.height);
        cv.toBlob(function (blob) {
          if (blob === null) { notify('notice', 'PNG 轉檔失敗'); return; }
          downloadBlob(blob, exportName('png'));
          notify('notice', '已匯出 ' + exportName('png'));
        }, 'image/png');
      };
      img.onerror = function () { notify('notice', 'PNG 轉檔失敗'); };
      // A data URI, not an object URL: an SVG loaded into an `<img>` renders
      // in the browser's secure static mode either way, and a data URI needs
      // no revoke to pair with it on a path that can end in `onerror`.
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
    }

    function exportJson() {
      // `sourceText()`, not a second serialisation: this is the same walk of
      // `store.toPatch()` the write-back takes, so what lands on the
      // clipboard can never disagree with what the block holds.
      const text = sourceText();
      const clip = probeWin.navigator && probeWin.navigator.clipboard;
      if (clip && typeof clip.writeText === 'function') {
        clip.writeText(text).then(function () {
          notify('notice', 'WaveJSON 已複製到剪貼簿');
        }, function () {
          notify('notice', '複製失敗；可以關閉後用區塊 ⠿ →「MD 原始碼」手動選取');
        });
        return;
      }
      notify('notice', '這個瀏覽器不給用剪貼簿；可以關閉後用區塊 ⠿ →「MD 原始碼」手動選取');
    }

    /**
     * 檔名：markdown 檔名 + block 序號 + 副檔名。
     *
     * `opts.fileLabel` IS the source, and the caller has to pass it. The
     * sentence that used to stand here — that `d.title` is "the same answer by
     * another road", because md2doc writes `path.basename(src, '.md')` into
     * `<title>` — was false the moment anyone edited anything. client.js owns
     * the page title while a session is open and decorates it:
     * `document.title = (documentIsDirty() ? '● ' : '') + baseTitle`. MEASURED
     * on this repo's wave fixture, one lane-copy before pressing 匯出:
     * `document.title` is `'● doc'` and the export lands as
     * `●-doc-wave-1.svg`. The marker survives the sanitiser (`●` is not in its
     * class, and stripping leading `-` runs does not reach it), and it only
     * appears for a user who actually edited — so an export tried straight
     * after opening gives the clean name and hides it.
     *
     * The fix is not to strip `'● '` here. That would put client.js's
     * decoration format into a second file, and the next change to the marker
     * would rot it silently. client.js passes `baseTitle` instead — the title
     * as it was BEFORE it began decorating, which is the one value in this
     * system that is exactly the markdown file's basename.
     *
     * `d.title` therefore stays only as a last resort for a host that passes
     * no `fileLabel` at all (today there is none). It is NOT equivalent: it is
     * whatever that host has written into the title by the time 匯出 is
     * pressed.
     *
     * The sanitiser is not cosmetic: a filename with a `/` in it would
     * otherwise reach `a.download` as a path separator.
     */
    function exportName(ext) {
      const raw = String(opts.fileLabel || d.title || 'wave');
      const label = raw.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'wave';
      return label + '-wave-' + Number(opts.blockIndex || 0) + '.' + ext;
    }

    /** The 匯出 menu. Task 10 replaces it with spec section 4.6's menu (copy
     *  as image, a clean offscreen render); the three exports stay reachable
     *  until then. */
    function exportMenu() {
      return panels.menu('ed-wave-export-pop', [
        { key: 'ed-wave-export-svg', label: '下載 SVG', title: '存成 SVG 檔（含 WaveDrom 的 skin，離開這一頁也畫得出來）',
          run: function () { closePopover(true); exportSvg(); } },
        { key: 'ed-wave-export-png', label: '下載 PNG', title: '存成 PNG 檔（白底，2 倍大小）',
          run: function () { closePopover(true); exportPng(); } },
        { key: 'ed-wave-export-json', label: '複製 WaveJSON', title: '把這張波形的 WaveJSON 複製到剪貼簿',
          run: function () { closePopover(true); exportJson(); } },
      ]);
    }

    // ── the toolbar's buttons, in spec section 4.2's order ───────────────
    function sep() {
      const s = d.createElement('span');
      s.className = 'ed-wave-sep';
      s.setAttribute('aria-hidden', 'true');
      toolbar.appendChild(s);
    }
    const undoBtn = panels.toolButton('ed-wave-undo', '↶', '復原（Ctrl+Z）', function () {
      if (!store.undo()) { notify('notice', '沒有可以復原的動作'); return; }
      afterStoreMoved('undo');
    }, toolbar);
    undoBtn.setAttribute('aria-label', '復原');
    const redoBtn = panels.toolButton('ed-wave-redo', '↷', '重做（Ctrl+Y）', function () {
      if (!store.redo()) { notify('notice', '沒有可以重做的動作'); return; }
      afterStoreMoved('redo');
    }, toolbar);
    redoBtn.setAttribute('aria-label', '重做');
    sep();
    for (const ch of BRUSH_RESIDENT) toolbar.appendChild(brushButton(ch));
    const moreBtn = panels.toolButton('ed-wave-brush-more', '更多 ⌄', '其他電位、時脈、資料與斷點', function () {
      togglePopover(moreBtn, function () { return panels.brushGrid(BRUSH_MORE, brushButton); });
    }, toolbar);
    moreBtn.setAttribute('aria-haspopup', 'true');
    moreBtn.setAttribute('aria-expanded', 'false');
    sep();
    panels.toolButton('ed-wave-cycle-insert', '＋拍',
      '在選取的位置插入一拍（每一條訊號同時加寬）', insertCycle, toolbar);
    panels.toolButton('ed-wave-cycle-delete', '－拍',
      '刪掉選取的拍（每一條訊號同時變窄）', deleteCycles, toolbar);
    sep();
    const signalBtn = panels.toolButton('ed-wave-signal-menu', '訊號 ⌄', '新增訊號或空白列', function () {
      togglePopover(signalBtn, signalMenu);
    }, toolbar);
    signalBtn.setAttribute('aria-haspopup', 'true');
    signalBtn.setAttribute('aria-expanded', 'false');
    sep();
    // v3.5.0 Task 7: arm the edge-creation gesture. One-shot in the sense
    // that a drag which PRODUCES an edge disarms it (`finishEdgeDrag` below);
    // pressing the button itself is a plain toggle, so a change of mind
    // before ever pressing on the canvas costs one more click, not Escape.
    const edgeBtn = panels.toolButton('ed-wave-edge-arm', '關聯線',
      '按一下讓轉換處的圓點出現，從一格拖到另一格畫出關聯線（Esc 取消）', function () {
        setEdgeMode(edgeMode === 'idle' ? 'armed' : 'idle');
        // The transition dots are the only on-canvas evidence arming
        // happened, so they are painted now rather than on the next repaint.
        render();
      }, toolbar);
    sep();
    // Ruling R2: the ⚙ popover is Task 10's; until then this does nothing.
    const settingsBtn = panels.toolButton('ed-wave-settings', '⚙', '整體設定', function () {}, toolbar);
    settingsBtn.setAttribute('aria-label', '整體設定');
    const exportBtn = panels.toolButton('ed-wave-export-menu', '匯出 ⌄', '下載或複製這張波形', function () {
      togglePopover(exportBtn, exportMenu);
    }, toolbar);
    exportBtn.setAttribute('aria-haspopup', 'true');
    exportBtn.setAttribute('aria-expanded', 'false');
    panels.toolButton('ed-wave-done', '完成', '關閉（修改已經寫進文件）', function () {
      close('commit');
    }, toolbar);
    setEdgeMode('idle');

    // ── the notice card, the stage, the hint bar, the live region ────────
    //
    // The notice card (spec section 4.9) sits right under the toolbar and
    // says which parts of this document the editor cannot place.
    const notice = panels.noticeCard();
    panel.appendChild(notice.el);

    // The stage: the canvas's scroll container, the full width of the
    // dialog now that the side rail is gone (spec section 4.1).
    const stage = d.createElement('div');
    stage.className = 'ed-wave-stage';
    panel.appendChild(stage);
    // Task 6a: what the engine could not draw, said where the drawing would be.
    const canvasError = d.createElement('div');
    canvasError.className = 'ed-wave-canvas-error';
    canvasError.hidden = true;
    stage.appendChild(canvasError);
    // The range toolbar is placed against the panel, so it follows the run
    // when the stage scrolls under it.
    stage.addEventListener('scroll', function () { placeRangeBar(); });
    // The engine's svg and the interaction layer share one positioned box, so
    // the layer can be laid exactly over the svg. Its top padding (CSS) is
    // the room the layer's cycle ruler takes above the engine's drawing.
    const canvasHost = d.createElement('div');
    canvasHost.className = 'ed-wave-canvas-host';
    stage.appendChild(canvasHost);
    // Task 8 (spec section 4.4): the row under the drawing that adds a
    // signal at the end — the one insert position the ⠿ menus (which add
    // BELOW a row) and 訊號 (after the selection) do not make obvious.
    panels.toolButton('ed-wave-add-lane', '＋ 新增訊號', '在最後面加一條訊號', function () {
      addLaneAt(layoutNow().lanes.length, 'add-lane', { name: '', wave: 'x' });
    }, stage);
    // One canvas per editor session (spec §3.2); `close()` destroys it.
    engineCanvas = opts.canvas.createCanvas({
      d: d, engine: opts.wavedrom, theme: opts.theme || null, geometry: geometry, codec: codec,
      host: canvasHost, index: PREVIEW_INDEX, prefix: PREVIEW_ID_PREFIX, scale: CANVAS_SCALE,
    });
    // Test hooks, same convention as `__edWaveSourceProbe`: one cell's
    // client-space centre and rect, from the canvas's own geometry.
    if (probeWin) {
      probeWin.__edWaveCellPoint = function (laneIndex, cycle) {
        const r = engineCanvas.cellRectClient(laneIndex, cycle);
        return r === null ? null : { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      };
      probeWin.__edWaveCellRect = function (laneIndex, cycle) {
        const r = engineCanvas.cellRectClient(laneIndex, cycle);
        return r === null ? null : { left: r.left, top: r.top, width: r.width, height: r.height };
      };
    }

    // The bottom hint bar says what can be done next, never what just
    // happened (spec section 4.8). Task 11 makes it follow the selection.
    const hint = d.createElement('div');
    hint.className = 'ed-wave-hint';
    hint.textContent = '點一拍改電位、按住拖曳塗一段';
    panel.appendChild(hint);

    // The cursor's position in words, for a screen reader only (spec section
    // 4.8): visually hidden, and not where results or refusals go.
    const live = d.createElement('div');
    live.className = 'ed-wave-live';
    live.setAttribute('role', 'status');
    panel.appendChild(live);
    liveRegion = live;


    // ── the one road from a gesture to the document ───────────────────────
    /**
     * Run one gesture: one `apply`, then one `toPatch`, then repaint.
     *
     * Constraint 5. The patch is computed HERE, on the gesture, and not saved
     * up for a session-ending write: Task 5 measured the store's refusal rate
     * rising with the number of structural operations stacked before a
     * write-back, and a refusal the user meets ten edits later is one they have
     * to bisect themselves. Refusing early refuses small.
     *
     * A refusal is shown and nothing is written. It is NOT rolled back — the
     * document on screen is still what the user asked for, and undoing their
     * edit because the file cannot express it yet would be this layer deciding
     * for them. Task 7 owns what happens to the patch; this owns that there is
     * exactly one per gesture.
     */
    function commit(name, fn) {
      // A gesture that arrives after the overlay came down has nowhere to land:
      // the store is off screen and the caller's own state is already torn
      // down. Cheap and load-bearing — an Escape mid-drag is exactly this.
      if (closed) return false;
      const changed = store.apply(name, fn);
      if (!changed) {
        // A paint that changes nothing is what pressing a cell that already
        // holds the brush's value is, i.e. an ordinary click on the drawing;
        // a toast for every such click would be noise. Every other gesture
        // that changes nothing is a refusal the user should hear about.
        if (name === 'paint') noteStatus('這個動作沒有改變任何東西');
        else notify('notice', '這個動作沒有改變任何東西');
        return false;
      }
      gestures++;
      afterStoreMoved(name);
      return true;
    }

    /**
     * Move the marks from the document they were made in to the one the store
     * is showing now, by asking who each lane IS rather than where it sat.
     *
     * `laneTrace(before, after)[j]` is the row that lane `j` occupied before,
     * or null for a row that did not exist then — the store's own answer, the
     * one the patch planner reads, injected rather than re-derived here (see
     * `wave-store.laneTrace`). Inverting it answers the question a mark has:
     * "the lane I was on — where is it now?"
     *
     * A lane that is GONE (its ✕, or the undo of an insert) has no answer, and
     * the mark falls back to the old row number clamped into the new layout —
     * which is what a person expects after deleting a row: the cursor lands on
     * whatever took its place, rather than disappearing. The clamp in
     * `paintLayer` does that, so this simply leaves the number alone.
     *
     * With no `laneTrace` injected — an older page carrying an older
     * wave-store — the marks are DROPPED on any structural change instead of
     * being left pointing at whatever inherited the index. "I no longer know
     * where you were" is a state the user can see; "here, except it is a
     * different lane now" is the defect.
     */
    function carryMarks(nextDoc) {
      if (marksDoc === nextDoc) return;
      const before = marksDoc;
      marksDoc = nextDoc;
      // Fix round 2: `pendingFrom` joins the guard's own "is there anything
      // to carry" question — widened rather than given a second guard of
      // its own, so there stays ONE call to `opts.laneTrace` and ONE
      // `rowOf` built from it, not a second belief about the lookup living
      // next to the first. Reachable with `cursor`/`selection` both null:
      // the keyboard's `armed` state is not locked to a document capture
      // the way a mouse drag is, so a user can mark a start cell with
      // Enter, delete every lane from the toolbar (which nulls `cursor`/
      // `selection` in `paintLayer`'s own clamp but left `pendingFrom`
      // alone before this fix), add lanes back past the stale index, and
      // finish the gesture — silently anchoring an edge to a lane the
      // trace never actually confirmed, because the lookup below was
      // skipped entirely while `pendingFrom` was the only mark still
      // standing. `ensureNode` bounds-checks against whatever document is
      // in hand at THAT moment, not against the one `pendingFrom` was
      // marked in, so a stale-but-back-in-range index is silently valid to
      // it — this file's worst failure class, wrong data written with
      // nothing on screen that explains it.
      // v3.5.0 Task 8: `endpointDrag` widens this same guard rather than
      // getting one of its own, for the identical reason `pendingFrom` did
      // in fix round 2 — one call to `opts.laneTrace`, one `rowOf`, not a
      // second belief about the lookup. Reachable with the other three all
      // null: a keyboard undo/redo reached WHILE a mouse button is down
      // dragging an endpoint is exactly the same shape of gap `pendingFrom`
      // closed — the pointer holds no document capture of its own, only
      // this variable's `at` does.
      // v3.6.0 Task 14: `selection` carries the rail's lane range itself
      // now, so these three are the whole list again — there is no fourth
      // set of row numbers standing beside them to ask about.
      if (before === null ||
          (cursor === null && selection === null && pendingFrom === null &&
           endpointDrag === null)) {
        return;
      }
      const trace = typeof opts.laneTrace === 'function'
        ? opts.laneTrace(before, nextDoc) : null;
      // No `laneTrace` injected: "I no longer know where you were" applies
      // to `pendingFrom` exactly as it already does to `cursor`/`selection`
      // — dropped, not guessed at. `endpointDrag` joins them: a drag naming
      // a lane nothing here can still vouch for is the same hazard either
      // way.
      if (trace === null) {
        cursor = null; selection = null; pendingFrom = null; endpointDrag = null;
        return;
      }
      // Structural or not: a content operation traces as the identity, so this
      // is a no-op for a paint without having to know that it is one.
      const rowOf = function (was) {
        for (let j = 0; j < trace.length; j++) {
          if (trace[j] === was) return j;
        }
        return null;
      };
      if (cursor !== null) {
        const at = rowOf(cursor.laneIndex);
        if (at !== null) cursor = { laneIndex: at, cycle: cursor.cycle };
      }
      if (selection !== null) {
        // v3.6.0 Task 14, tightened in fix round 1: BOTH ends of the lane
        // range are retraced, independently, and an end the trace cannot
        // vouch for is DROPPED rather than left on a stale number. That is
        // the member-by-member rule the retired lane multi-select used
        // ("an entry that cannot be traced is removed"), applied to a pair.
        //
        // Round 0 put this whole block inside `if (rowOf(laneIndex) !== null)`,
        // which reads like a guard and is not one: when the range's FIRST
        // lane was the one that vanished, nothing ran and BOTH numbers were
        // left standing. `paintLayer`'s clamp does not save it — that
        // only pulls `laneTo` down to the last row and never collapses a
        // range — so 建立群組 and 訊號's 刪除 acted on a span the user never
        // selected. Reachable in three gestures: insert a lane, Shift-select
        // from it downwards, undo the insert.
        //
        // What survives, by case:
        //   both ends traced → the traced range (re-normalised: a reorder
        //                      can swap which end is lower)
        //   one end traced   → collapsed onto that end — the one lane still
        //                      vouched for
        //   neither traced   → collapsed onto `laneIndex`'s OLD number. The
        //                      number is kept because `laneIndex` doubles as
        //                      a screen position `paintLayer` re-clamps and
        //                      `cursor`'s own "land on whoever took the
        //                      place" instinct is right for that; the SPAN is
        //                      not kept, so a structural op can at worst
        //                      touch that one row, never a range.
        const near = rowOf(selection.laneIndex);
        const far = rowOf(selection.laneTo);
        const a = near !== null ? near : (far !== null ? far : selection.laneIndex);
        const b = far !== null ? far : a;
        selection = {
          laneIndex: Math.min(a, b), laneTo: Math.max(a, b),
          from: selection.from, to: selection.to,
        };
      }
      // `pendingFrom` is a mark of the exact same shape as `cursor` (a row
      // number plus a cycle), carried the same way — by lane IDENTITY
      // through this same trace, not by raw row number (see the guard
      // above for why it must reach here even when `cursor`/`selection`
      // cannot). It deliberately does NOT copy cursor's "leave the number
      // alone when untraceable" half, though: `cursor` gets away with that
      // because `paintLayer` re-clamps it into range on every repaint, and
      // because a cursor landing on "whatever now occupies that visual
      // position" after its own lane vanished is the right instinct for a
      // position marker. `pendingFrom` has no such clamp anywhere, and it is
      // not a position — it is a lane the user already committed to as one
      // fixed end of an edge. Fix round 2: leaving it at a stale raw index
      // is exactly the hazard the coordinator's review walked to the end —
      // delete the marked lane, add unrelated lanes back until the count
      // passes the stale number again, and `ensureNode` would bounds-check
      // successfully against a lane the user never chose. So an untraceable
      // `pendingFrom` is DROPPED here, the same as `trace === null` above
      // drops it wholesale — never left standing on a number nothing
      // vouches for.
      if (pendingFrom !== null) {
        const at = rowOf(pendingFrom.at);
        pendingFrom = at === null ? null : { at: at, cell: pendingFrom.cell };
      }
      // `endpointDrag.at` is a mark of the exact same shape as
      // `pendingFrom.at` — a lane the user is currently pointing a live
      // gesture at, not a position `paintLayer` re-clamps on every
      // repaint — so it is carried the same way and dropped the same way
      // when the lane it named cannot be traced. Left alone while `at` is
      // still `null` (mousedown fired, no `pointermove` has landed on a
      // real cell yet): there is no row number there yet to go stale.
      // `index`/`end`/`cell` are not row numbers and need no retracing
      // here — `index` is guarded separately by `render()`'s widened
      // `selectedEdge` clamp (the drag dies with the selection it drags).
      if (endpointDrag !== null && endpointDrag.at !== null) {
        const at = rowOf(endpointDrag.at);
        endpointDrag = at === null ? null
          : { index: endpointDrag.index, end: endpointDrag.end, at: at, cell: endpointDrag.cell };
      }
    }

    function afterStoreMoved(name) {
      if (closed) return;
      // Before anything reads or draws them. `commit`, the undo/redo buttons
      // and the Ctrl+Z / Ctrl+Y keys all arrive here, and nothing else moves
      // the store — so this is the whole of "the marks follow their lane".
      carryMarks(store.doc);
      lastPatch = store.toPatch();
      // Ruling R16: a patch that lands becomes the store's new base, so the
      // next gesture is planned against the bytes now in the file — one
      // gesture per patch, an undo as the one reverse gesture — instead of
      // against the text the editor opened with. A refusal does not move it.
      // `isDirty` keeps measuring against the opening text either way. The
      // patch is the WHOLE block text, which `onGesture`'s owner writes as is,
      // so base and file agree after every write that lands.
      if (lastPatch.ok === true && typeof store.rebase === 'function') store.rebase(lastPatch.text);
      render();
      // Spec section 4.8: a write that cannot reach the file loses data, so
      // it is the red card; an ordinary write-back is the normal path and
      // the title bar's save status already shows it, so it is not toasted
      // (the closing summary of Task 11 counts the session's changes).
      if (lastPatch.ok === true) {
        noteStatus('已寫回：' + name);
      } else {
        notify('error', '這個改動沒辦法只改幾個位元組寫回去：' + lastPatch.reason);
      }
      if (typeof opts.onGesture === 'function') {
        opts.onGesture({ name: name, patch: lastPatch, store: store });
      }
    }

    // ── painting ──────────────────────────────────────────────────────────
    //
    // Task 6a: `canvas` is the INTERACTION LAYER — an svg laid over the
    // engine's drawing (`engineCanvas.svg`), at the same position and size,
    // re-placed on every paint. It is created once and never replaced (the
    // old hand-drawn canvas was rebuilt on every repaint and had to hand the
    // keyboard back each time). It is the drawing's focus target and, because
    // it sits on top of the engine's svg, the element every press lands on.
    const canvas = d.createElementNS(SVGNS, 'svg');
    canvas.setAttribute('class', 'ed-wave-canvas ed-wave-layer');
    // In the Tab cycle, and therefore in the focus trap, like every other
    // control in here.
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('data-focus-key', 'canvas');
    // The one keyboard manual a screen-reader user gets for this surface.
    canvas.setAttribute('aria-label',
      '波形繪圖區：方向鍵移動游標，Shift+左右鍵選一段 cycle，' +
      '按電位字元（' + BRUSHES.join(' ') + '）塗上去，Del 刪掉選取的拍；' +
      '資料格按 Enter 改標籤；F2 改這條訊號的名稱；' +
      '武裝關聯線之後，Alt+左右鍵可以在轉態點之間跳');
    canvas.style.position = 'absolute';
    canvas.style.left = '0px';
    canvas.style.top = '0px';
    // The cycle ruler sits above the engine's svg, outside the layer's own box.
    canvas.style.overflow = 'visible';
    canvas.addEventListener('mousedown', onCanvasDown);
    // Hover has to be live from the moment the layer exists: a plain hover
    // with no button down never reaches a mousedown handler at all.
    canvas.addEventListener('mousemove', onCanvasHover);
    // Task 7: the hover column and the ruler's ＋ go when the pointer leaves
    // the drawing. Not while a data-label field is open: every layer repaint
    // retires that field (`paintLayer`), and the pointer drifting off the
    // canvas is not a reason to lose what is being typed.
    // Task 8: leaving the drawing for a row's ⠿ keeps that row lit — the ⠿
    // sits over the name column, so the pointer reaching for it leaves the
    // layer without leaving the row.
    canvas.addEventListener('mouseleave', function (ev) {
      if (dataEdit !== null) return;
      const to = ev.relatedTarget;
      const toGrip = to !== null && to !== undefined && typeof to.closest === 'function' &&
        to.closest('.ed-wave-grip') !== null;
      const nextName = toGrip ? hoverName : null;
      if (hoverCell === null && rulerPlus === null && nextName === hoverName) return;
      hoverCell = null;
      rulerPlus = null;
      hoverName = nextName;
      repaintDrawing();
    });
    // Tabbing onto the drawing is an entry like any other, so it puts the
    // cursor on screen. Re-entrant only once: `enterDrawing()` sets `cursor`.
    canvas.addEventListener('focus', function () {
      if (cursor === null) enterDrawing();
    });
    canvasHost.appendChild(canvas);
    // Task 8: the name column's ⠿ buttons, one per row and one per group
    // title, in a box laid over the host's padding box. Ahead of the layer
    // in document order, so Tab reaches the names before the drawing; above
    // it in paint order (CSS), so a press on a shown ⠿ reaches it.
    const gripBox = d.createElement('div');
    gripBox.className = 'ed-wave-grips';
    canvasHost.insertBefore(gripBox, canvas);

    /**
     * The layout the pointer, the keyboard and the layer all read: the engine
     * canvas's own (engine units, measured from its svg) whenever it has drawn
     * the document the store holds now, and otherwise a fallback in engine
     * units that only answers counts (see `SIZES`).
     */
    function layoutNow() {
      const l = engineCanvas === null ? null : engineCanvas.layout;
      if (l !== null && engineCanvas.doc === store.doc) return l;
      return geometry.layoutOf(store.doc, SIZES);
    }

    /**
     * Paint the interaction layer over the engine's drawing — what the old
     * `drawer.renderCanvas` was for every call site, minus the waveform, which
     * the engine draws. Called by `render()` after the engine has redrawn, and
     * on its own wherever only UI state changed (a cursor move, a drag preview,
     * a hover), so the engine is not asked to redraw an identical picture.
     *
     * It keeps three duties of the old drawer:
     *   - the CLAMP. The cursor and the selection are index pairs into a
     *     document that can get shorter (deleting cycles or the bottom lane),
     *     so both are pulled back into range here, where the layout that says
     *     what "in range" means is in hand. A cycle range that overshoots
     *     clamps; a lane that is gone drops the selection rather than moving it
     *     to whichever lane inherited the index. `laneTo` is rebuilt, never
     *     dropped: a key left out here is a key deleted from the live selection.
     *   - the overlay's `data-wave-cursor` / `-edge-count` / `-edge-pending` /
     *     `-endpoint-drag`, each assigned inside the branch that decides it,
     *     so "nothing drawn" and "the overlay says none" are one decision.
     *   - an open data-label field is retired: the paint may move what it sits
     *     over, exactly as the old full rebuild took it away.
     * And, since Task 7, it ends by bringing the floating range toolbar in
     * line with the selection it just drew (`syncRangeBar`).
     *
     * Layer-local px are client px minus the layer's own client rect. The
     * engine-unit geometry is converted with the svg's client origin read ONCE
     * (`engineCanvas.cellRectClient` is the same arithmetic per call); reading
     * it per cell while the paint is appending nodes would force a layout per
     * cell.
     */
    function paintLayer(layoutIn) {
      const layout = layoutIn === undefined || layoutIn === null ? layoutNow() : layoutIn;
      const doc = store.doc;
      if (dataEdit !== null) dataEdit.retire();
      if (cursor !== null) {
        if (layout.lanes.length === 0 || layout.cycles === 0) {
          cursor = null;
        } else {
          cursor = {
            laneIndex: Math.max(0, Math.min(cursor.laneIndex, layout.lanes.length - 1)),
            cycle: Math.max(0, Math.min(cursor.cycle, layout.cycles - 1)),
          };
        }
      }
      if (selection !== null) {
        if (layout.lanes.length === 0 || layout.cycles === 0 ||
            selection.laneIndex < 0 || selection.laneIndex >= layout.lanes.length) {
          selection = null;
        } else {
          const lastLane = layout.lanes.length - 1;
          const far = typeof selection.laneTo === 'number'
            ? Math.min(selection.laneTo, lastLane) : selection.laneIndex;
          selection = {
            laneIndex: selection.laneIndex,
            laneTo: Math.max(selection.laneIndex, far),
            from: Math.max(0, Math.min(selection.from, layout.cycles - 1)),
            to: Math.max(0, Math.min(selection.to, layout.cycles - 1)),
          };
        }
      }

      const edges = geometry.edgeLayout(doc, layout);
      overlay.setAttribute('data-wave-edge-count', String(edges.length));
      const has = function (li, c) { return geometry.cellRect(layout, li, c) !== null; };
      const cursorCell = cursor !== null && has(cursor.laneIndex, cursor.cycle)
        ? cursor.laneIndex + ',' + cursor.cycle : '';
      overlay.setAttribute('data-wave-cursor', cursorCell);
      const pendingCell = pendingFrom !== null && cursor !== null &&
        has(pendingFrom.at, pendingFrom.cell) && has(cursor.laneIndex, cursor.cycle)
        ? pendingFrom.at + ',' + pendingFrom.cell : '';
      overlay.setAttribute('data-wave-edge-pending', pendingCell);
      const dragged = endpointDrag === null ? undefined
        : edges.filter(function (e) { return e.index === endpointDrag.index; })[0];
      const endpointDragMark = dragged !== undefined && endpointDrag.at !== null &&
        has(endpointDrag.at, endpointDrag.cell)
        ? endpointDrag.index + ':' + endpointDrag.end + '@' + endpointDrag.at + ',' + endpointDrag.cell : '';
      overlay.setAttribute('data-wave-endpoint-drag', endpointDragMark);

      const svg = engineCanvas === null ? null : engineCanvas.svg;
      if (svg === null || engineCanvas.layout !== layout) {
        // Nothing drawn (no engine, or a document it refused): an empty,
        // still-focusable layer.
        canvas.style.width = '0px';
        canvas.style.height = '0px';
        layerApi.paint(canvas, { cells: [], cellRect: null, anchor: null, rulerY: 0, width: 0, height: 0 }, {});
        syncGrips(null);
        syncRangeBar();
        return;
      }
      // Task 7: the layer covers the ruler band as well as the engine's svg
      // — from the top of the host's padding box (the band is that padding,
      // see `.ed-wave-canvas-host` in lib/md2doc.js) down to the svg's
      // bottom — so a pointer over the ruler is over the layer, which is
      // what lets the ruler's ＋ show on hover and take a press.
      const hostRect = canvasHost.getBoundingClientRect();
      const sr = svg.getBoundingClientRect();
      const bandTop = hostRect.top + canvasHost.clientTop;
      const layerHeight = Math.max(sr.bottom - bandTop, sr.height);
      canvas.style.left = (sr.left - hostRect.left - canvasHost.clientLeft) + 'px';
      canvas.style.top = (Math.min(bandTop, sr.top) - bandTop) + 'px';
      canvas.style.width = sr.width + 'px';
      canvas.style.height = layerHeight + 'px';
      canvas.setAttribute('width', String(sr.width));
      canvas.setAttribute('height', String(layerHeight));
      const lr = canvas.getBoundingClientRect();
      const k = engineCanvas.scale;
      const dx = sr.left - lr.left;
      const dy = sr.top - lr.top;
      const pt = function (p) { return { x: dx + p.x * k, y: dy + p.y * k }; };
      const rectOf = function (li, c) {
        const r = laneCellRect(layout, li, c);
        return { x: dx + r.x * k, y: dy + r.y * k, width: r.width * k, height: r.height * k };
      };
      // The pointer marks are clamped like the cursor above: a structural
      // change can leave them past the end of what is drawn now.
      if (hoverCell !== null && (hoverCell.laneIndex >= layout.lanes.length || hoverCell.cycle >= layout.cycles)) {
        hoverCell = null;
      }
      if (rulerPlus !== null && rulerPlus > layout.cycles) rulerPlus = null;
      const centre = function (li, c) {
        const r = rectOf(li, c);
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      };
      const dots = edgeMode !== 'idle' ? 'all' : 'off';
      const view = {
        scale: k,
        // Ruling R8: the dot source is `geometry.transitionsOf`, the same
        // cells Alt+←/→ walks — asked only while dots are on screen.
        cells: layout.lanes.map(function (row, i) {
          return { laneIndex: i, cycles: row.cycles,
            transitions: dots === 'off' ? [] : geometry.transitionsOf(doc, i) };
        }),
        cellRect: rectOf,
        anchor: function (li, cell) {
          const a = geometry.anchorOfCell(layout, li, cell);
          return a === null ? centre(li, cell) : pt(a);
        },
        rulerY: dy - RULER_GAP,
        bodyTop: dy,
        width: lr.width,
        height: lr.height,
      };
      let pending = null;
      if (dragged !== undefined) {
        // The in-flight endpoint drag: from the edge's UNMOVED end to the
        // cell the drag is over (its own current end until a move lands).
        const other = endpointDrag.end === 'from' ? 'to' : 'from';
        pending = { from: pt(dragged[other]),
          to: endpointDragMark !== '' ? centre(endpointDrag.at, endpointDrag.cell) : pt(dragged[endpointDrag.end]) };
      } else if (pendingCell !== '') {
        pending = { from: centre(pendingFrom.at, pendingFrom.cell), to: centre(cursor.laneIndex, cursor.cycle) };
      }
      let selEdge = null;
      if (selectedEdge !== null) {
        const e = edges.filter(function (x) { return x.index === selectedEdge; })[0];
        if (e !== undefined) {
          selEdge = {
            d: e.d.replace(/(-?[0-9.]+),(-?[0-9.]+)/g, function (_, x, y) {
              return (dx + Number(x) * k) + ',' + (dy + Number(y) * k);
            }),
            from: pt(e.from), to: pt(e.to),
          };
        }
      }
      // Hover is the idle pointer's: a drag shows its own run, and the
      // armed edge gesture its dots.
      const pointerIdle = drag === null && endpointDrag === null && edgeMode === 'idle' && gripDrag === null;
      // Task 8: the name column's row (a group's: all its rows) is lit while
      // the pointer is over it, and the dragged lane's row while its ⠿ is
      // being dragged; the drop line marks where it would land.
      if (hoverName !== null && hoverName.kind === 'lane' && hoverName.laneIndex >= layout.lanes.length) {
        hoverName = null;
      }
      const draggingLane = gripDrag !== null && gripDrag.active === true;
      const lit = draggingLane ? { kind: 'lane', laneIndex: gripDrag.laneIndex }
        : (drag === null && endpointDrag === null && edgeMode !== 'dragging' ? hoverName : null);
      let rowHover = null;
      let rowHoverTo = null;
      if (lit !== null && lit.kind === 'lane') rowHover = lit.laneIndex;
      else if (lit !== null) { rowHover = lit.span.from; rowHoverTo = lit.span.to; }
      let dropLine = null;
      if (draggingLane && gripDrag.drop !== null &&
          gripDrag.drop !== gripDrag.laneIndex && gripDrag.drop !== gripDrag.laneIndex + 1) {
        dropLine = { y: dy + rowBoundaryY(engineCanvas.measured, gripDrag.drop) * k };
      }
      overlay.setAttribute('data-wave-lane-drop', dropLine === null ? '' : String(gripDrag.drop));
      layerApi.paint(canvas, view, {
        hover: pointerIdle ? hoverCell : null,
        rowHover: rowHover,
        rowHoverTo: rowHoverTo,
        dropLine: dropLine,
        selection: selection === null ? null
          : { laneIndex: selection.laneIndex, from: selection.from, to: selection.to },
        cursor: cursorCell === '' ? null : cursor,
        rulerPlus: edgeMode === 'dragging' || drag !== null || endpointDrag !== null ? null : rulerPlus,
        dots: dots,
        hotDot: hoverBoundary,
        pending: pending,
        selectedEdge: selEdge,
        overflow: [],
      });
      syncGrips(layout, hostRect, sr);
      syncRangeBar();
    }

    /**
     * One cell's rect in engine units — `geometry.cellRect`, and past a
     * lane's own reach (period / phase, or the boundary after its last
     * cycle) the same arithmetic unclamped, so the layer and the ruler's
     * boundaries never get a null.
     */
    function laneCellRect(layout, li, c) {
      const r = geometry.cellRect(layout, li, c);
      if (r !== null) return r;
      const row = layout.lanes[li];
      if (row === undefined) return { x: 0, y: 0, width: 0, height: 0 };
      return { x: row.originX + c * row.cycleWidth, y: row.y, width: row.cycleWidth, height: row.height };
    }

    // ── the name column (spec section 4.4) ────────────────────────────────
    //
    // The names, the group brackets and the group titles are the ENGINE's
    // drawing, under the interaction layer, so a press or a hover over them
    // always lands on the layer: no element under the pointer can say which
    // name it is. Ruling R13: they are hit by geometry, the way cells and
    // data labels are — rows from the measured `laneTops`, the column from
    // the measured `xg`, and the bands inside it from the engine's own
    // indents (`NAME_INDENT_*`). The ⠿ buttons are this file's, laid over
    // the column; a press on a shown ⠿ is an ordinary DOM hit.

    /** The indent of the members of the array at `containerPath`
     *  (`['signal']` or a group's path), in engine units. */
    function memberIndent(doc, containerPath) {
      let x = NAME_INDENT_LIST;
      for (let cut = 2; cut <= containerPath.length; cut++) {
        const g = geometry.valueAt(doc, containerPath.slice(0, cut));
        const titled = Array.isArray(g) && (typeof g[0] === 'string' || typeof g[0] === 'number');
        x += titled ? NAME_INDENT_TITLED : NAME_INDENT_UNTITLED;
      }
      return x;
    }
    /** The band of the name column a group owns: `[lo, hi)` engine units.
     *  An outermost group's band runs to the column's left edge. */
    function groupBand(doc, path) {
      const lo = path.length <= 2 ? 0 : memberIndent(doc, path.slice(0, -1)) + 1;
      return { lo: lo, hi: memberIndent(doc, path) + 1 };
    }
    /** The row whose band holds engine y `y`, or null. */
    function rowAtY(m, y) {
      for (let i = 0; i < m.laneTops.length; i++) {
        if (y >= m.laneTops[i] && y < m.laneTops[i] + m.laneHeight) return i;
      }
      return null;
    }
    /** The engine y of row boundary `b` (0..rows): the top of row `b`, or
     *  the bottom of the last row. */
    function rowBoundaryY(m, b) {
      const n = m.laneTops.length;
      if (n === 0) return 0;
      return b < n ? m.laneTops[b] : m.laneTops[n - 1] + m.laneHeight;
    }
    /** What the name column is answered against: the engine's svg box, its
     *  scale and its measurement — only while it shows the store's document
     *  in `layout`. */
    function nameGeometry(layout) {
      if (engineCanvas === null || engineCanvas.svg === null || engineCanvas.layout !== layout ||
          engineCanvas.doc !== store.doc || engineCanvas.measured === null) return null;
      return { sr: engineCanvas.svg.getBoundingClientRect(), k: engineCanvas.scale, m: engineCanvas.measured };
    }
    /**
     * Which name-column row a pointer event is over: `{kind: 'lane',
     * laneIndex}` (a signal's name, or a blank row), `{kind: 'group', span}`
     * (a group's title and bracket), or null (not over the column).
     */
    function nameHitAt(ev, layout) {
      const g = nameGeometry(layout);
      if (g === null) return null;
      const x = (ev.clientX - g.sr.left) / g.k;
      const y = (ev.clientY - g.sr.top) / g.k;
      if (x < 0 || x > g.m.xg + 0.5) return null;
      const i = rowAtY(g.m, y);
      if (i === null || i >= layout.lanes.length) return null;
      const container = layout.lanes[i].path.slice(0, -1);
      if (container.length <= 1 || x >= memberIndent(store.doc, container) + 1) {
        return { kind: 'lane', laneIndex: i };
      }
      for (let cut = 2; cut <= container.length; cut++) {
        const path = container.slice(0, cut);
        const band = groupBand(store.doc, path);
        if (x >= band.lo && x < band.hi) {
          const span = spanByKey(path.join('.'));
          return span === null ? null : { kind: 'group', span: span };
        }
      }
      return null;
    }
    function sameName(a, b) {
      if (a === null || b === null) return a === b;
      if (a.kind !== b.kind) return false;
      return a.kind === 'lane' ? a.laneIndex === b.laneIndex : a.span.path.join('.') === b.span.path.join('.');
    }
    /** Lane `i`'s name, as a client box the name field is laid over: from
     *  the lane's own indent to the column's right edge, the row's height.
     *  A column narrower than `NAME_FIELD_MIN` widens it leftwards, but
     *  never past the drawing's left edge (the stage cannot scroll there);
     *  what is still missing goes rightwards, over the first cycles. */
    function nameBoxClient(layout, i) {
      const g = nameGeometry(layout);
      if (g === null || i >= g.m.laneTops.length) return null;
      const container = layout.lanes[i].path.slice(0, -1);
      const lo = container.length <= 1 ? 0 : memberIndent(store.doc, container) + 1;
      const right = g.sr.left + g.m.xg * g.k;
      const width = Math.max(NAME_FIELD_MIN, right - (g.sr.left + lo * g.k));
      const left = Math.max(g.sr.left, right - width);
      return { left: left, top: g.sr.top + g.m.laneTops[i] * g.k, width: width, height: g.m.laneHeight * g.k };
    }
    /** A group's title, as the client box its name field is laid over: from
     *  its band's left edge, on its first row. */
    function groupBoxClient(layout, span) {
      const g = nameGeometry(layout);
      if (g === null || span.from >= g.m.laneTops.length) return null;
      const band = groupBand(store.doc, span.path);
      return { left: g.sr.left + band.lo * g.k, top: g.sr.top + g.m.laneTops[span.from] * g.k,
        width: NAME_FIELD_MIN, height: g.m.laneHeight * g.k };
    }

    /**
     * The ⠿ buttons, in step with what is drawn: one per row (`data-lane`)
     * and one per titled group (`data-group`, its path), in row order, a
     * group's ahead of its first row's. They are rebuilt only when the
     * engine has drawn a new layout; between draws a paint only says which
     * one is lit. The elements are REUSED by focus key, so a ⠿ that has the
     * keyboard, or owns the open menu, survives the redraw a gesture causes.
     *
     * A lane's ⠿ stands just left of its name as the engine measured it
     * (the name is right-aligned, so that is where the name starts); a
     * group's sits in the group's band, on its first row.
     */
    let gripsFor = null;
    const grips = new Map();
    function syncGrips(layout, hostRect, sr) {
      if (layout === null) {
        gripsFor = null;
        for (const el of grips.values()) if (el.parentNode) el.parentNode.removeChild(el);
        grips.clear();
        return;
      }
      if (gripsFor !== layout) {
        gripsFor = layout;
        // A new drawing: what the pointer was over has to be found again.
        if (gripDrag === null) hoverName = null;
        placeGrips(layout, hostRect, sr);
      }
      const litKey = gripDrag !== null ? gripKey(gripDrag.laneIndex)
        : hoverName === null ? null
        : hoverName.kind === 'lane' ? gripKey(hoverName.laneIndex) : groupGripKey(hoverName.span.path);
      for (const [key, el] of grips) el.classList.toggle('is-on', key === litKey);
    }
    function placeGrips(layout, hostRect, sr) {
      const m = engineCanvas.measured;
      const k = engineCanvas.scale;
      const ox = hostRect.left + canvasHost.clientLeft;
      const oy = hostRect.top + canvasHost.clientTop;
      const spans = geometry.groupSpansOf(store.doc, layout);
      const want = [];
      for (let i = 0; i < layout.lanes.length && i < m.laneTops.length; i++) {
        const heads = spans.filter(function (s) { return s.from === i; })
          .sort(function (a, b) { return a.path.length - b.path.length; });
        for (const s of heads) {
          const band = groupBand(store.doc, s.path);
          want.push({ key: groupGripKey(s.path), group: s.path.join('.'), label: '群組「' + s.title + '」',
            left: sr.left + (band.lo + band.hi) / 2 * k - GRIP_W / 2 - ox,
            top: sr.top + m.laneTops[i] * k + 2 - oy });
        }
        const text = engineCanvas.svg.querySelector('[id="wavelane_' + i + '_' + PREVIEW_INDEX + '"] > text');
        const nameLeft = text !== null ? text.getBoundingClientRect().left : sr.left + (m.xg - 10) * k;
        const lane = layout.lanes[i].lane;
        const label = isSpacer(lane) ? '第 ' + (i + 1) + ' 列（空白列）'
          : '訊號「' + (typeof lane.name === 'string' && lane.name !== '' ? lane.name : '第 ' + (i + 1) + ' 條') + '」';
        want.push({ key: gripKey(i), lane: i, label: label,
          left: nameLeft - GRIP_GAP - GRIP_W - ox,
          top: sr.top + (m.laneTops[i] + m.laneHeight / 2) * k - GRIP_H / 2 - oy });
      }
      const keep = new Set();
      let order = true;
      for (let j = 0; j < want.length; j++) {
        const w = want[j];
        keep.add(w.key);
        let el = grips.get(w.key);
        if (el === undefined) { el = makeGrip(w.key); grips.set(w.key, el); order = false; }
        if (w.lane !== undefined) { el.setAttribute('data-lane', String(w.lane)); el.removeAttribute('data-group'); }
        else { el.setAttribute('data-group', w.group); el.removeAttribute('data-lane'); }
        el.setAttribute('aria-label', w.label + '：拖曳排序，Enter 打開選單（F2 改名、Del 刪除）');
        el.title = w.lane !== undefined ? '拖曳排序；按一下打開選單' : '按一下打開群組選單';
        el.style.left = w.left + 'px';
        el.style.top = w.top + 'px';
        if (gripBox.children[j] !== el) order = false;
      }
      for (const [key, el] of grips) {
        if (keep.has(key)) continue;
        if (el.parentNode) el.parentNode.removeChild(el);
        grips.delete(key);
      }
      // Re-appended only when the order changed: moving a node that has the
      // keyboard drops it (`render` puts it back by its focus key).
      if (!order || gripBox.children.length !== want.length) {
        for (const w of want) gripBox.appendChild(grips.get(w.key));
      }
    }
    function makeGrip(key) {
      const b = d.createElement('button');
      b.type = 'button';
      b.className = 'ed-wave-grip';
      b.setAttribute('data-focus-key', key);
      b.setAttribute('aria-haspopup', 'true');
      b.setAttribute('aria-expanded', 'false');
      b.textContent = '⠿';
      b.addEventListener('mousedown', onGripPress);
      b.addEventListener('click', onGripClick);
      b.addEventListener('mouseenter', onGripEnter);
      b.addEventListener('mouseleave', onGripLeave);
      return b;
    }
    /** What a ⠿ stands for, read off the element (they are reused). */
    function gripName(el) {
      if (el.hasAttribute('data-lane')) return { kind: 'lane', laneIndex: Number(el.getAttribute('data-lane')) };
      const span = spanByKey(el.getAttribute('data-group') || '');
      return span === null ? null : { kind: 'group', span: span };
    }
    function onGripEnter(ev) {
      if (gripDrag !== null) return;
      const named = gripName(ev.currentTarget);
      if (sameName(named, hoverName)) return;
      hoverName = named;
      repaintDrawing();
    }
    function onGripLeave(ev) {
      if (gripDrag !== null || ev.relatedTarget === canvas || hoverName === null) return;
      hoverName = null;
      repaintDrawing();
    }
    /**
     * A press on a ⠿. Cancelled, so the keyboard stays where it was and the
     * ⠿ does not take a focus ring from a mouse press. A lane's ⠿ is
     * dragged to reorder (spec section 4.4): the press only arms that, and
     * the release decides — moved past `GRIP_DRAG_SLOP`, a drop; otherwise
     * a click, which opens the menu (`onGripUp`). A group's ⠿ has no drag;
     * its `click` opens the menu.
     */
    function onGripPress(ev) {
      if (ev.button !== 0) return;
      ev.preventDefault();
      const el = ev.currentTarget;
      if (!el.hasAttribute('data-lane')) return;
      gripDrag = { laneIndex: Number(el.getAttribute('data-lane')), el: el,
        x0: ev.clientX, y0: ev.clientY, active: false, drop: null };
      d.addEventListener('mousemove', onGripMove, true);
      d.addEventListener('mouseup', onGripUp, true);
    }
    /** A lane's ⠿ opens its menu from the keyboard here (`detail` 0: Enter
     *  or Space); the mouse's click is decided in `onGripUp`. A group's ⠿
     *  opens its menu here either way. */
    function onGripClick(ev) {
      const el = ev.currentTarget;
      const named = gripName(el);
      if (named === null) return;
      if (named.kind === 'group') { toggleGroupMenu(named.span, el); return; }
      if (ev.detail === 0) toggleLaneMenu(named.laneIndex, el);
    }
    function dropBoundaryAt(clientY) {
      const g = nameGeometry(layoutNow());
      if (g === null || g.m.laneTops.length === 0) return null;
      const y = (clientY - g.sr.top) / g.k;
      const b = Math.round((y - g.m.laneTops[0]) / g.m.laneHeight);
      return Math.max(0, Math.min(b, g.m.laneTops.length));
    }
    function onGripMove(ev) {
      if (gripDrag === null) return;
      if (ev.buttons === 0) { onGripUp(ev); return; }
      if (!gripDrag.active) {
        if (Math.abs(ev.clientX - gripDrag.x0) < GRIP_DRAG_SLOP && Math.abs(ev.clientY - gripDrag.y0) < GRIP_DRAG_SLOP) return;
        gripDrag.active = true;
        closePopover(false);
      }
      const drop = dropBoundaryAt(ev.clientY);
      if (drop === gripDrag.drop) return;
      gripDrag.drop = drop;
      repaintDrawing();
    }
    /**
     * The ⠿'s release. Not a drag: the click, so the menu. A drag: one
     * `moveLane` to the row boundary the drop line marked — `drop` counts
     * boundaries before the lift, `moveLane` positions after it, hence the
     * `- 1` below the lane — and nothing at all when that is where the lane
     * already is (spec: a drop on the start position is a no-op, not an
     * undo step).
     */
    function onGripUp() {
      d.removeEventListener('mousemove', onGripMove, true);
      d.removeEventListener('mouseup', onGripUp, true);
      const g = gripDrag;
      gripDrag = null;
      if (g === null) return;
      if (!g.active) {
        if (d.contains(g.el)) toggleLaneMenu(g.laneIndex, g.el);
        return;
      }
      repaintDrawing();
      if (g.drop === null) return;
      const to = g.drop > g.laneIndex ? g.drop - 1 : g.drop;
      if (to === g.laneIndex) return;
      moveLaneTo(g.laneIndex, to);
    }
    /** Esc during a ⠿ drag: nothing moves. The listeners stay until the
     *  button comes up, and find nothing to do then. */
    function cancelGripDrag() {
      gripDrag = null;
      repaintDrawing();
    }

    // ── the floating range toolbar (spec section 4.3) ─────────────────────
    //
    // Up while a RUN of cycles is selected (two or more — one cycle is what
    // every click selects, and a toolbar on every click would sit over the
    // drawing the whole time), the pointer is not dragging and no edge
    // gesture is live. `paintLayer` asks after every repaint, so every road
    // that changes the selection — a drag, Shift+←/→, a gesture, an undo —
    // shows, moves or drops it without having to remember to.
    function rangeBarWanted() {
      return !closed && selection !== null && selection.from !== selection.to &&
        drag === null && endpointDrag === null && edgeMode === 'idle' &&
        engineCanvas !== null && engineCanvas.svg !== null && engineCanvas.doc === store.doc;
    }
    function dropRangeBar() {
      if (rangeBar === null) return;
      if (popover !== null && rangeBar.el.contains(popover.owner)) closePopover(false);
      if (rangeBar.el.parentNode) rangeBar.el.parentNode.removeChild(rangeBar.el);
      rangeBar = null;
    }
    function syncRangeBar() {
      if (!rangeBarWanted()) { dropRangeBar(); return; }
      const lo = Math.min(selection.from, selection.to);
      const hi = Math.max(selection.from, selection.to);
      const key = selection.laneIndex + ':' + lo + '-' + hi;
      if (rangeBar === null || rangeBar.key !== key) {
        dropRangeBar();
        const el = panels.rangeToolbar(rangeAnchor(lo, hi), {
          count: hi - lo + 1,
          actions: {
            level: function (btn) {
              togglePopover(btn, function () {
                return panels.brushGrid(RANGE_LEVELS, function (ch) { return brushButton(ch, paintSelection); });
              });
            },
            copy: copyCycles,
            remove: deleteCycles,
            insertBefore: function () {
              if (selection !== null) insertCyclesAt(Math.min(selection.from, selection.to));
            },
            insertAfter: function () {
              if (selection !== null) insertCyclesAt(Math.max(selection.from, selection.to) + 1);
            },
            edge: function () { const c = actionCell(); if (c !== null) startEdgeFromCell(c.laneIndex, c.cycle); },
            note: function () { const c = actionCell(); if (c !== null) startNoteAt(c.laneIndex, c.cycle); },
          },
        });
        panel.appendChild(el);
        rangeBar = { el: el, key: key };
      }
      placeRangeBar();
    }
    /** The selected run's client box, as `{left, top, width}` in the panel's
     *  own coordinates (the toolbar is placed in the panel, like the
     *  popovers, so the stage's scroll clip cannot cut it off). */
    function rangeAnchor(lo, hi) {
      const a = engineCanvas.cellRectClient(selection.laneIndex, lo);
      const b = engineCanvas.cellRectClient(selection.laneIndex, hi);
      if (a === null || b === null) return { left: 0, top: 0, width: 0 };
      const pr = panel.getBoundingClientRect();
      return { left: a.left - pr.left - panel.clientLeft, top: a.top - pr.top - panel.clientTop,
        width: b.left + b.width - a.left };
    }
    /** Above the run, centred on it; below it when the space above is not
     *  inside the stage; never past the panel's sides. Called on every
     *  repaint and on the stage's scroll. */
    function placeRangeBar() {
      if (rangeBar === null || selection === null) return;
      const lo = Math.min(selection.from, selection.to);
      const hi = Math.max(selection.from, selection.to);
      const a = engineCanvas.cellRectClient(selection.laneIndex, lo);
      const b = engineCanvas.cellRectClient(selection.laneIndex, hi);
      if (a === null || b === null) return;
      const el = rangeBar.el;
      const pr = panel.getBoundingClientRect();
      const st = stage.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let top = a.top - RANGE_GAP - h;
      if (top < st.top) top = a.top + a.height + RANGE_GAP;
      let left = (a.left + b.left + b.width) / 2 - w / 2;
      left = Math.max(pr.left + RANGE_GAP, Math.min(left, pr.right - RANGE_GAP - w));
      el.style.left = (left - pr.left - panel.clientLeft) + 'px';
      el.style.top = (top - pr.top - panel.clientTop) + 'px';
    }
    /** The range toolbar's 電位: the run becomes one run of `ch`, the same
     *  `setCellRange` a drag paints with, and the brush stays as it was. */
    function paintSelection(ch) {
      if (selection === null) return;
      const sel = selection;
      commit('paint', function (doc) {
        return codec.setCellRange(doc, sel.laneIndex, sel.from, sel.to, ch);
      });
    }

    /**
     * Repaint everything, and give the keyboard cursor back where it was.
     *
     * Identity is carried by `data-focus-key`, not by element identity: a
     * repaint can replace the element the keyboard was on (a data-label
     * field, a rename field), and a focus left on a detached node is
     * `document.body` with extra steps — the state that turns the next
     * Backspace into "delete the selected blocks". The text cursor inside a
     * field is carried too; a field that came back with different text keeps
     * the cursor clamped to what is there now.
     *
     * The name field (`nameEdit`, Task 8) is the one sub-panel a
     * repaint does not bring back, so a repaint that runs while it is open
     * retires it explicitly first. Without that, Ctrl+Z typed into it once
     * wedged the whole page: focus stayed on a detached element and no key
     * reached anything, not even Escape.
     */
    function render() {
      if (nameEdit !== null) nameEdit.retire();
      const before = focusMark();
      const doc = store.doc;
      // Task 6a: the engine redraws the canvas first (spec §3.2); everything
      // below reads the layout it measured.
      const drawn = engineCanvas.render(doc);
      canvasError.hidden = drawn.ok === true;
      canvasError.textContent = drawn.ok === true ? '' : drawn.error;
      overlay.setAttribute('data-wave-canvas', drawn.ok === true ? 'ok' : 'failed');
      const layout = layoutNow();
      // Clamped BEFORE `paintLayer` reads it, and against `edgeLayout`'s own
      // filtered list rather than `doc.edge.length` — an edge whose anchor
      // letter went missing is still an array element (so a length check
      // would miss it) but `edgeLayout` already will not place it, and a
      // selection pointed at an edge nothing on screen shows is exactly the
      // stale-selection defect `carryMarks` above exists to avoid for lanes.
      if (selectedEdge !== null && !edgeIsDrawable(doc, layout, selectedEdge)) {
        selectedEdge = null;
      }
      // v3.5.0 Task 8: `endpointDrag.index` can only ever be reached from
      // `selectedEdge`'s own handle (see `onCanvasDown`), so the two may
      // never disagree — a drag that outlives the selection it was dragging
      // (a mid-drag undo that deselects without deleting) dies with it.
      if (endpointDrag !== null && endpointDrag.index !== selectedEdge) {
        endpointDrag = null;
      }
      paintLayer(layout);
      overlay.setAttribute('data-wave-selected-edge',
        selectedEdge === null ? '' : String(selectedEdge));
      panels.renderUnmodelled(doc, layout, notice);
      undoBtn.disabled = !store.canUndo();
      redoBtn.disabled = !store.canRedo();
      paintSelectionState(doc, layout);
      overlay.setAttribute('data-wave-gestures', String(gestures));
      overlay.setAttribute('data-wave-lanes', String(layout.lanes.length));
      overlay.setAttribute('data-wave-cycles', String(layout.cycles));
      overlay.setAttribute('data-wave-dirty', store.isDirty() ? '1' : '0');
      overlay.setAttribute('data-wave-patch',
        lastPatch === null ? 'none' : (lastPatch.ok === true ? 'ok' : 'refused'));
      paintBrushState();
      restoreFocus(before);
    }

    /** Whether `geometry.edgeLayout` would still draw the edge at `index` —
     *  the same test the drawing itself applies, asked rather than repeated. */
    function edgeIsDrawable(doc, layout, index) {
      const edges = geometry.edgeLayout(doc, layout);
      for (const e of edges) {
        if (e.index === index) return true;
      }
      return false;
    }

    /** What has the keyboard now, as something that survives a rebuild. */
    function focusMark() {
      const el = d.activeElement;
      if (el === null || el === undefined || !overlay.contains(el)) return null;
      const key = el.getAttribute('data-focus-key');
      if (key === null) return null;
      const mark = { key: key, start: null, end: null };
      // `selectionStart` throws on input types that have no text selection; the
      // fields here are all type=text, but reading it defensively costs nothing
      // and keeps a future field from turning a repaint into an exception.
      try {
        mark.start = el.selectionStart;
        mark.end = el.selectionEnd;
      } catch (e) { /* not a text field */ }
      return mark;
    }

    function restoreFocus(mark) {
      const want = focusOverride !== null ? focusOverride : (mark === null ? null : mark.key);
      focusOverride = null;
      if (want === null) return;
      // v3.6.0 Task 14: "did not come back" includes "came back DISABLED".
      // `.focus()` on a disabled control is inert — the fact T6h pinned for
      // the rail's ▲ at the top of the list — and the toolbar is now where
      // the gestures that disable their own button live: 訊號's 刪除 empties
      // the selection, so the very button the user pressed is disabled by
      // the repaint that press caused. Found-but-inert fell straight through
      // to `document.body`, which is the state this whole function exists to
      // prevent, and which turns the next Backspace into「delete the
      // selected blocks」.
      const inert = function (node) { return node === null || node.disabled === true; };
      let el = overlay.querySelector('[data-focus-key="' + want + '"]');
      // A named destination the repaint did not bring back. It happens: a
      // group's key is its first lane's row number, so inserting a lane above
      // it renumbers the key that a rename field had already nominated —
      // measured, `{overlay:1, input:0, key:null, tag:"BODY"}`. Fall back to
      // where the keyboard actually was, and failing that to the dialog
      // itself. Never to nothing: nothing is `document.body`, and this whole
      // task is about not ending there.
      if (inert(el) && mark !== null && mark.key !== want) {
        el = overlay.querySelector('[data-focus-key="' + mark.key + '"]');
      }
      if (inert(el)) {
        if (!overlay.contains(d.activeElement)) panel.focus();
        return;
      }
      el.focus();
      if (mark === null || mark.key !== want) return;
      if (mark.start === null || typeof el.setSelectionRange !== 'function') return;
      const n = typeof el.value === 'string' ? el.value.length : 0;
      try {
        el.setSelectionRange(Math.min(mark.start, n), Math.min(mark.end, n));
      } catch (e) { /* not a text field */ }
    }

    /**
     * The in-place editor for one bus cell's `data` label — this dialog's
     * OTHER sub-panel, same `{cancel, retire}` shape as the name field
     * (`nameEdit`) and opened the same two ways every other gesture in this file
     * is: a pointer press on the label (`onCanvasDown`) or the keyboard's
     * own Enter (`handleDrawingKey`), both of which hand it the cycle that
     * owns the slot; `slot` below is `codec.dataSlotOf`'s answer for that
     * cycle, never a belief of this file's own about which cycles consume
     * one.
     *
     * Positioned over the cell (since Task 7, over its whole data segment)
     * from `engineCanvas.cellRectClient` — the same
     * numbers the keyboard cursor and the pointer's own hit test share —
     * converted into the stage's scrolled content box (`.ed-wave-stage` is
     * `position: relative`, see `lib/md2doc.js`), so no padding is written
     * out here as a constant.
     *
     * Unlike a rename field, this one's node sits beside a canvas
     * `paintLayer` repaints on every cursor move — see that function's own
     * first line for why `retire()` has to be called from there too, not
     * only from `render()`.
     */
    function openDataEdit(laneIndex, cycle) {
      const layout = layoutNow();
      const row = layout.lanes[laneIndex];
      const lane = row === undefined ? null : row.lane;
      const slot = lane === null ? null : codec.dataSlotOf(lane, cycle);
      if (slot === null) return;
      // Task 6a: client geometry from the engine canvas; the field is a
      // positioned child of the stage, so it is placed in the stage's
      // scrolled content box (client rect minus the stage's, plus its scroll).
      // Task 7: it spans the whole data segment — the owning cycle and the
      // continuations after it — because that is the box the engine centres
      // the label in, so the field opens over the label that was pressed.
      const box = engineCanvas.cellRectClient(laneIndex, cycle);
      if (box === null) return;
      const last = engineCanvas.cellRectClient(laneIndex, segmentEnd(lane, cycle));
      const boxRight = last === null ? box.left + box.width : last.left + last.width;
      // A press or an Enter that lands on a second bus cell while the field
      // is still open on the first one: the open field never got the blur
      // that a plain click elsewhere would have given it (the keyboard's
      // Enter path never moves focus at all), so it is cancelled here,
      // by hand, before this one opens. Unsaved text in the first field is
      // discarded — the same trade a rename field makes for itself on
      // every route that is not `finish()` itself.
      if (dataEdit !== null) dataEdit.cancel();

      const current = labelsOf(lane)[slot];
      const startValue = typeof current === 'string' ? current : '';

      const input = d.createElement('input');
      input.type = 'text';
      input.className = 'ed-wave-data-input';
      input.setAttribute('data-focus-key', 'data-input-' + laneIndex + '-' + cycle);
      input.value = startValue;
      const wr = stage.getBoundingClientRect();
      input.style.left = (box.left - wr.left - stage.clientLeft + stage.scrollLeft) + 'px';
      input.style.top = (box.top - wr.top - stage.clientTop + stage.scrollTop) + 'px';
      input.style.width = (boxRight - box.left) + 'px';
      input.style.height = box.height + 'px';
      // Spec section 7.2: an input method composing into this field owns
      // Enter (it picks a candidate). `onKeyDown` stands aside for every
      // key while `isComposing` is set; this flag covers what that cannot
      // see — the `change` a browser may fire as a composition is committed.
      let composing = false;
      input.addEventListener('compositionstart', function () { composing = true; });
      input.addEventListener('compositionend', function () { composing = false; });

      /** The field off. A no-op once a repaint has already taken it away. */
      const takeDown = function () {
        if (input.parentNode !== null) input.parentNode.removeChild(input);
      };
      /** Whether the keyboard is IN the field right now. False on the
       *  `blur` path — the browser has already moved it by then. */
      const holdsKeyboard = function () { return d.activeElement === input; };

      const finish = function () {
        // Once. `blur` and this file's own explicit Enter handler can both
        // reach here for the one commit (Enter removes the field, which
        // fires a `blur` of its own) — the latch is the same "whoever gets
        // here first owns the gesture" rule a rename field's `finish` uses.
        if (dataEdit === null) return;
        dataEdit = null;
        const hadKeyboard = holdsKeyboard();
        const value = input.value;
        takeDown();
        if (value === startValue) {
          // Nothing to write, so nothing to repaint — `canvas` is already
          // the element it was before this field opened.
          if (hadKeyboard) canvas.focus();
          return;
        }
        // The keyboard is only NAMED when it would otherwise be lost — same
        // condition a rename field's `finish` uses: either this field had it, or
        // whatever DOES have it right now is not even inside the overlay
        // (both mean the coming repaint would otherwise leave it on
        // `document.body`). `focusOverride` already set by someone else's
        // more specific promise is left alone.
        if (focusOverride === null && (hadKeyboard || !overlay.contains(d.activeElement))) {
          focusOverride = 'canvas';
        }
        commit('data-label', function (doc) {
          return codec.setDataAt(doc, laneIndex, slot, value);
        });
      };
      /** A repaint is about to run underneath this field (`paintLayer`) —
       *  an undo, a redo, any gesture that repaints while it is open. The
       *  field goes with it, the latch drops, and the keyboard is named,
       *  exactly the same reason `nameEdit.retire` exists. Since Task 6a
       *  the repaint no longer wipes the wrap, so the node is taken down
       *  here, AFTER the latch drops (its `blur` then finds nothing to do). */
      const retire = function () {
        if (dataEdit === null) return;
        dataEdit = null;
        if (focusOverride === null && holdsKeyboard()) focusOverride = 'canvas';
        takeDown();
      };
      /** Escape's half: the field goes, the label does not change, the
       *  session stands, and the keyboard goes back to the drawing — never
       *  to `document.body`. No repaint: the canvas was never touched. */
      const cancel = function () {
        if (dataEdit === null) return;
        dataEdit = null;
        takeDown();
        canvas.focus();
      };
      // The explicit commit key: Enter. Left to a plain native `change`
      // event the way a rename field is would depend on whether this
      // browser fires `change` for a lone text input on Enter alone, which
      // is not a promise this file makes elsewhere — asked for outright
      // instead, the same way Escape is asked for explicitly one level up
      // in `onKeyDown` rather than left to a default.
      input.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter') return;
        if (composing || ev.isComposing === true || ev.keyCode === 229) return;
        ev.preventDefault();
        ev.stopPropagation();
        finish();
      });
      input.addEventListener('change', function () { if (!composing) finish(); });
      input.addEventListener('blur', finish);
      /** Tab's half (spec section 4.3,「Tab 下一段」, reached from
       *  `onKeyDown`): this label is written, then the next data segment of
       *  the same lane opens (`dir` -1: the previous one). With no segment
       *  that way, the label is written and the keyboard goes back to the
       *  canvas. The cursor and the selection move with the field. */
      const step = function (dir) {
        const next = neighbourSlotCycle(lane, cycle, dir);
        finish();
        if (next === null) { canvas.focus(); return; }
        cursor = { laneIndex: laneIndex, cycle: next };
        selection = { laneIndex: laneIndex, laneTo: laneIndex, from: next, to: next };
        repaintDrawing();
        scrollCursorIntoView();
        openDataEdit(laneIndex, next);
      };
      stage.appendChild(input);
      dataEdit = { cancel: cancel, retire: retire, step: step, input: input };
      input.focus();
      input.select();
    }

    /** The last cycle of the data segment that cycle `cycle` owns: it and
     *  the continuations after it (`codec.expandWave`'s `held`). */
    function segmentEnd(lane, cycle) {
      const cells = codec.expandWave(typeof lane.wave === 'string' ? lane.wave : '');
      let end = cycle;
      while (end + 1 < cells.length && cells[end + 1].held) end++;
      return end;
    }
    /** The cycle owning the next (`dir` 1) or previous (`dir` -1) data slot
     *  of `lane` from cycle `cycle`, or null — `codec.dataSlotOf` decides
     *  which cycles own one, never a second rule here. */
    function neighbourSlotCycle(lane, cycle, dir) {
      const n = codec.expandWave(typeof lane.wave === 'string' ? lane.wave : '').length;
      for (let i = cycle + dir; i >= 0 && i < n; i += dir) {
        if (codec.dataSlotOf(lane, i) !== null) return i;
      }
      return null;
    }
    /** The cycle that owns data slot `slot` of `lane`, or null. */
    function cycleOfSlot(lane, slot) {
      const n = codec.expandWave(typeof lane.wave === 'string' ? lane.wave : '').length;
      for (let i = 0; i < n; i++) {
        if (codec.dataSlotOf(lane, i) === slot) return i;
      }
      return null;
    }

    /**
     * Where a press or an Enter on cycle `cycle` of `lane` should open the
     * data-label field — or whether it must refuse the gesture outright
     * instead of letting it fall through to an ordinary paint.
     *
     * v3.5.0 Task 11 fix round 1: a cycle INSIDE a bus run that itself owns
     * no slot (`codec.dataSlotOf` answers `null` — a `.` continuation or a
     * `|` gap) used to fall straight through to the paint-arming code with
     * nothing catching it. Reviewer-traced: the press silently repainted
     * that continuation with whatever brush was current, turning it into a
     * fresh EXPLICIT value cycle and shifting every LATER label in the lane
     * one slot to the right — silent data corruption, not an inert click,
     * because the box this cycle sits inside is exactly what this task now
     * invites the user to press.
     *
     * `isBus(brickOf(...))` is the engine's own brick model for whether a
     * cycle is drawn as a bus box (wave-draw.js), asked here to decide it
     * for the GESTURE — so a plain non-bus cycle (`0`, `1`, `x`, a
     * clock, …) is untouched and keeps painting exactly as it always has;
     * only a cycle INSIDE a bus box is ever diverted. Walking backward for
     * the owning cycle stops the moment the resolved LEVEL changes — two
     * adjacent bus runs of the identical value (`2.2.` — measured against
     * `codec`'s own doc comment: two separate labels, not one) must not
     * have a later cycle resolve into the EARLIER run's slot.
     *
     * Returns:
     *   `{cycle, slot}` — open the field for THIS cycle's slot: either
     *                      `cycle` itself owns one, or the walk back to its
     *                      run's owning explicit cycle found one.
     *   `'blocked'`      — inside a bus box, but no owning cycle exists (a
     *                       leading repeater with nothing to continue —
     *                       MEASURED, `levelsOf` draws such a lane as `x`,
     *                       so this should be unreachable in practice, but
     *                       the check is kept rather than assumed so a
     *                       future change to that rule fails LOUD here
     *                       rather than silently reaching paint again).
     *                       Callers must refuse the gesture on this answer,
     *                       never fall through.
     *   `null`           — not a bus box; ordinary behaviour is unaffected.
     */
    function resolveBusTarget(lane, cycle) {
      const slot = codec.dataSlotOf(lane, cycle);
      if (slot !== null) return { cycle: cycle, slot: slot };
      const levels = codec.levelsOf(typeof lane.wave === 'string' ? lane.wave : '');
      if (!drawer.isBus(drawer.brickOf(levels[cycle]))) return null;
      for (let i = cycle - 1; i >= 0 && levels[i] === levels[cycle]; i--) {
        const s = codec.dataSlotOf(lane, i);
        if (s !== null) return { cycle: i, slot: s };
      }
      return 'blocked';
    }

    // ── the keyboard on the drawing ───────────────────────────────────────
    /**
     * Every gesture the drawing has, without a pointer.
     *
     * The drawing was the one surface in this dialog a keyboard could not
     * operate AT ALL: painting was a mouse drag, and `selection` — which every
     * cycle operation reads — could only be made by dragging. There are FIVE
     * cycle buttons, and four of them refused outright for a keyboard user,
     * each with its own message a few lines above: 刪除 cycle and 複製 answer
     *「先選一段 cycle 再…」with no selection, and both 貼上 answer「剪貼簿是
     * 空的」because the only thing that fills the clipboard is 複製. The fifth,
     * 插入 cycle, is the one that worked — and `selection === null ? 0` means
     * it silently meant "at cycle 0" wherever the user was looking. This is
     * that `selection`, made with the arrow keys.
     *
     * The keymap is deliberately small and has no chords: arrows move,
     * Shift+arrow extends along the lane, Home/End jump to the ends of the
     * lane, a brush character paints, Space and Enter paint with whatever
     * brush is on. Everything else the dialog can do is a real `<button>` or
     * `<input>` that Tab already reaches.
     *
     * That sentence has NO exceptions and no mode-dependence, which is a
     * property v3.6.0 Task 16 briefly broke and fix round 3 restored. Round 0
     * bound the transition jump over plain ←/→ while the 關聯線 gesture was
     * armed, so the keymap above became false for two keys at a state this
     * function itself decides — and, worse than the documentation problem,
     * several cells stopped being reachable from the keyboard at all (T9b).
     * Round 3 moved that jump to Alt+←/→, which cannot arrive here: the call
     * site is gated on `!ev.altKey`. So every Alt chord this dialog has —
     * Alt+↑/↓ for the lane, Alt+←/→ for the jump — is claimed one level up in
     * `onKeyDown` and is deliberately NOT part of this keymap.
     *
     * Two targets are accepted, and only two:
     *   the canvas  — the surface itself, `tabindex="0"`, so it is in the Tab
     *                 cycle and in the focus trap like every other control.
     *   the panel   — the dialog element, which holds the keyboard for exactly
     *                 one moment: right after it opens, where the ARIA pattern
     *                 puts it (T6k pins that). An arrow key there can only
     *                 mean the drawing, so it ENTERS the drawing — and does not
     *                 also move, because a cursor that appears one cell away
     *                 from where it was born never shows the user where it
     *                 started counting from.
     */
    function handleDrawingKey(ev) {
      const onCanvas = ev.target === canvas;
      const onPanel = ev.target === panel;
      if (!onCanvas && !onPanel) return false;
      const key = ev.key;
      const nav = key === 'ArrowLeft' || key === 'ArrowRight' ||
        key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End';
      if (onPanel) {
        if (!nav) return false;
        ev.preventDefault();
        ev.stopPropagation();
        enterDrawing();
        return true;
      }
      // v3.6.0 Task 16 fix round 3: THE ARROWS ARE PER-CELL IN EVERY STATE,
      // and the transition jump no longer lives here.
      //
      // Round 0 bound the jump over plain ← / → while armed. A jump can only
      // ever land on a transition, so that removed the keyboard's only
      // cell-precise positioning on the one surface that needs it: on
      // `p....` (transitions `[0]`) cell 1 became unreachable, and on
      // `0.1.0` (`[0,2,4]`) cells 1 and 3 did. Home/End do not rescue it —
      // they reach the two ends and nothing in between. T9b in
      // `test/editor-journey.test.js` is the invariant that caught it: the
      // keyboard's Enter/Enter route must write a BYTE-IDENTICAL source to
      // the mouse drag, and the mouse aims at exactly those cells. MEASURED
      // with the jump bound here — mouse `node: '.a'` / `node: '...b'`
      // against keyboard `node: 'a'` / `node: '....b'`: different cells,
      // different file, invariant gone.
      //
      // The jump is a convenience; per-cell movement is the primitive
      // underneath it, and a convenience may not be bound over a primitive
      // when that leaves no way back to it. So the jump moved to Alt+←/→,
      // claimed in `onKeyDown` beside Alt+↑/↓ — see that branch for why that
      // is the only home available to it (this function cannot be reached
      // with Alt held) and for what Alt means across the four arrows.
      if (nav) {
        ev.preventDefault();
        ev.stopPropagation();
        moveCursor(key, ev.shiftKey === true);
        return true;
      }
      // Task 7, spec section 4.3: Del means what is selected. On the canvas
      // that is cycles — the selected run, or the cursor's one cycle — and
      // they go from every lane. (A signal's name holding the keyboard is the
      // other meaning, the name column's — `handleNameKey`; it never reaches
      // this function, which answers for the canvas only.) Backspace is the
      // same key on a keyboard whose Delete is labelled so.
      // Task 8: F2 here renames the cursor's lane (spec section 4.4).
      if (key === 'F2') {
        ev.preventDefault();
        ev.stopPropagation();
        if (cursor !== null) openLaneRename(cursor.laneIndex);
        return true;
      }
      if (key === 'Delete' || key === 'Backspace') {
        ev.preventDefault();
        ev.stopPropagation();
        deleteCycles();
        return true;
      }
      // Ruling R12: A (關聯線) and T (標註) from the cell in hand — the same
      // two actions as the range toolbar's last two buttons. `SHORTCUT_KEYS`
      // is the roster, compared case-sensitively, and disjoint from
      // `BRUSHES` (wave-codec.test.js pins that), so a brush key never gets
      // here; '?' is the shortcut card's (Task 11) and is not claimed yet.
      // Composition never reaches this point (`onKeyDown` stands aside).
      if (key !== '?' && SHORTCUT_KEYS.indexOf(key) !== -1) {
        ev.preventDefault();
        ev.stopPropagation();
        const at = actionCell();
        if (at !== null) {
          if (key === 'a' || key === 'A') startEdgeFromCell(at.laneIndex, at.cycle);
          else startNoteAt(at.laneIndex, at.cycle);
        }
        return true;
      }
      // v3.5.0 Task 7: the keyboard's two-step version of the drag, ahead of
      // the plain Enter-paints case below so an armed Enter never falls
      // through to it. First Enter marks `cursor` as `pendingFrom` (arrows
      // above already moved it, exactly as a mouse press would have);
      // second Enter — from wherever the cursor walked to since — is the
      // SAME `finishEdgeDrag` the mouse's `onCanvasUp` calls, so the three
      // no-op drops and the one-armed-if-nothing-happened rule are decided
      // in that one place, not re-decided here.
      if (edgeMode === 'armed' && key === 'Enter' && cursor !== null) {
        ev.preventDefault();
        ev.stopPropagation();
        if (pendingFrom === null) {
          pendingFrom = { at: cursor.laneIndex, cell: cursor.cycle };
          notify('notice', '起點已標記，移到終點再按一次 Enter');
          render();
        } else {
          finishEdgeDrag(cursor.laneIndex, cursor.cycle);
        }
        return true;
      }
      // v3.5.0 Task 11: Enter on a cell inside a bus box opens that box's
      // label field instead of painting over it with the brush — the
      // keyboard's own version of the pointer's press on a label in
      // `onCanvasDown`. `resolveBusTarget` walks a continuation back to its
      // run's owning cycle (fix round 1: a cursor resting on a `.`/`|`
      // continuation inside a run used to fall straight through to
      // `paintAtCursor()` below with nothing catching it — silent data
      // corruption). Since Task 7 the pointer reaches the same owning cycle
      // from the other side: the label it pressed names its data slot
      // (`labelHitAt`), and `cycleOfSlot` finds the cycle that owns it.
      // Placed AFTER the armed-edge Enter
      // above (arming an edge outranks opening a label field — the same
      // press cannot mean both) and BEFORE the generic Enter-paints case
      // below, which it must pre-empt.
      if (key === 'Enter' && cursor !== null) {
        const dlLayout = layoutNow();
        const dlRow = dlLayout.lanes[cursor.laneIndex];
        const dlLane = dlRow === undefined ? null : dlRow.lane;
        if (dlLane !== null) {
          const dlTarget = resolveBusTarget(dlLane, cursor.cycle);
          if (dlTarget === 'blocked') {
            ev.preventDefault();
            ev.stopPropagation();
            notify('notice', '這一格接在某個 bus 值後面，但看不出屬於哪一個，沒有欄位可以編輯。');
            return true;
          }
          if (dlTarget !== null) {
            ev.preventDefault();
            ev.stopPropagation();
            cursor = { laneIndex: cursor.laneIndex, cycle: dlTarget.cycle };
            openDataEdit(cursor.laneIndex, dlTarget.cycle);
            return true;
          }
        }
      }
      // A brush character both PICKS the brush and paints with it. Picking
      // without painting would need a second keystroke to do the thing the
      // user already said, and the toolbar's own brush buttons are still there
      // for「選起來待會再用」. `isBrushKey` is the admission rule — see its
      // own comment (this file's top) for why it is not keyed on
      // `ev.shiftKey` (v3.5.0 Task 10 fix round 1: that used to block
      // `P`/`N`/`|`, all typed with Shift, from the keyboard entirely).
      if (isBrushKey(key)) {
        ev.preventDefault();
        ev.stopPropagation();
        brush = key;
        paintBrushState();
        paintAtCursor();
        return true;
      }
      if (key === ' ' || key === 'Enter') {
        ev.preventDefault();
        ev.stopPropagation();
        paintAtCursor();
        return true;
      }
      return false;
    }

    /** Put the keyboard on the drawing, at the cell it last held (cell 0 of
     *  lane 0 the first time). Never moves the cursor: entering and moving in
     *  one keystroke hides where the cursor came from. */
    function enterDrawing() {
      const layout = layoutNow();
      if (layout.lanes.length === 0 || layout.cycles === 0) { canvas.focus(); return; }
      // A cursor, and NOT a selection. Arriving is not choosing: this fires on
      // a plain `Tab` onto the drawing, and a focus move that quietly arms
      // 刪除 cycle and 複製 with a range nobody drew is a destructive button
      // loaded by walking past it. The first arrow key — an act, not a
      // traversal — is what makes a selection, exactly as a pointer press
      // does, and `paintAtCursor` already falls back to the single cursor cell
      // when there is no selection to use.
      if (cursor === null) cursor = { laneIndex: 0, cycle: 0 };
      canvas.focus();
      repaintDrawing(layout);
      sayCursor(layout);
    }

    /**
     * Move the cell cursor, and carry `selection` with it.
     *
     * The two are one thing on purpose. `selection` is what every cycle
     * operation acts on and what `setCellRange` is given, and its shape —
     * ONE lane, a run of cycles — is exactly what a cursor plus Shift can
     * describe. A pointer press already collapses it to the pressed cell; a
     * plain arrow does the same, and Shift+←/→ keeps the anchor it was made
     * with. Shift+↑/↓ collapses the CYCLE range onto the lane it lands on.
     *
     * v3.6.0 Task 14 narrowed what that sentence claims. It used to say a
     * two-lane selection was not a thing this document model had; that is
     * no longer true — `selection.laneIndex`..`laneTo` is a lane range, and
     * 建立群組 / 訊號's 刪除 act on it. What is still true is that the
     * cycle range belongs to ONE lane (`laneIndex`), so an arrow key that
     * changes lanes has no cycle anchor left to extend from. Widening the
     * LANE range from the keyboard is a gesture this dialog does not have
     * yet; the rail's Shift+click is the one that makes it.
     */
    function moveCursor(key, extend) {
      const layout = layoutNow();
      if (layout.lanes.length === 0 || layout.cycles === 0) return;
      if (cursor === null) { enterDrawing(); return; }
      let lane = cursor.laneIndex;
      let cyc = cursor.cycle;
      if (key === 'ArrowLeft') cyc -= 1;
      else if (key === 'ArrowRight') cyc += 1;
      else if (key === 'ArrowUp') lane -= 1;
      else if (key === 'ArrowDown') lane += 1;
      else if (key === 'Home') cyc = 0;
      else if (key === 'End') cyc = layout.cycles - 1;
      lane = Math.max(0, Math.min(lane, layout.lanes.length - 1));
      cyc = Math.max(0, Math.min(cyc, layout.cycles - 1));
      const sameLane = lane === cursor.laneIndex;
      cursor = { laneIndex: lane, cycle: cyc };
      if (extend && sameLane && selection !== null && selection.laneIndex === lane) {
        selection = { laneIndex: lane, laneTo: lane, from: selection.from, to: cyc };
      } else {
        selection = { laneIndex: lane, laneTo: lane, from: cyc, to: cyc };
      }
      repaintDrawing(layout);
      scrollCursorIntoView();
      sayCursor(layout);
    }

    /**
     * v3.6.0 Task 16: while armed, walk the cursor between this lane's
     * TRANSITIONS — `dir === 1` rightwards, `dir === -1` leftwards. Reached
     * by **Alt+←/→**, claimed in `onKeyDown`; fix round 3 moved it off plain
     * ←/→, which it had been bound over.
     *
     * What Alt+← / Alt+→ is for is picking the cell an edge will anchor to,
     * and an edge anchors at a transition. Walking one cycle at a time makes
     * a user press the key eight times to cross an eight-cycle flat run and
     * land on seven cells they cannot usefully aim at.
     *
     * It is an ADDITION to per-cell movement, never a replacement for it —
     * that distinction is the whole of fix round 3. Plain ←/→ still walks one
     * cell in every state, armed included, because a jump can only land on a
     * transition and any cell that is not one would otherwise have no
     * keyboard route at all. The POINTER could always drop an endpoint
     * anywhere along a flat run (hanging a label in the middle of a bus needs
     * exactly that); after round 3 the keyboard can too, which is what T9b
     * pins byte for byte.
     *
     * Which cells count is `geometry.transitionsOf`'s answer, the SAME one
     * `wave-draw.js` paints the dots from, so a key can never stop somewhere
     * the drawing did not put a dot. It is not re-derived here, and it is not
     * "a cycle whose level differs from the one before" — see that function's
     * own docstring for why that is a different (and wrong) rule.
     *
     * THE TWO ENDS CLAMP, and that has one consequence worth stating because
     * it looks backwards for one press: the armed cursor only ever rests on a
     * transition, so → with nothing further right goes to the RIGHTMOST
     * transition and ← with nothing further left goes to the leftmost. When
     * the cursor was parked to the right of every transition — arming does
     * not move it, so that is reachable in one step — the first → therefore
     * snaps LEFT, onto the rightmost anchor. Every press after that is a
     * no-op at the same cell. Pinned both ways in `test/editor-journey.test.js`.
     *
     * `selection` is collapsed onto the landing cell exactly as `moveCursor`'s
     * own non-extend branch does it: `paintAtCursor` paints `selection`'s run
     * whenever it belongs to the cursor's lane, so a jump that left a stale
     * run standing would make the next brush key paint a stretch of cycles
     * the cursor is no longer anywhere near. Alt+Shift+←/→ does NOT extend
     * the selection — an edge endpoint is one cell, so a jump has no range to
     * grow. Plain Shift+←/→ still extends, exactly as it always did; round 3
     * gave that back by taking the jump off the unmodified arrows.
     *
     * Ends in the same three calls `moveCursor` does, for the same reason: no
     * document content changed, so this is a repaint of the layer, not a
     * `render()` that would also ask the engine to redraw the identical
     * picture.
     */
    function jumpTransition(dir) {
      const layout = layoutNow();
      if (layout.lanes.length === 0 || layout.cycles === 0) return;
      // Arriving is not choosing — the same rule `moveCursor` and
      // `enterDrawing` already state. A first keystroke that both entered
      // the drawing and jumped somewhere would never show the user which
      // cell it started counting from.
      if (cursor === null) { enterDrawing(); return; }
      const lane = cursor.laneIndex;
      const cells = geometry.transitionsOf(store.doc, lane);
      // A lane with nothing to anchor to: WaveDrom's `{}` spacer is the
      // fixture case, and a lane whose wave is all continuations is the
      // other. Neither is an error, and neither may move the cursor to a
      // cell this rule says it is not allowed to rest on.
      if (cells.length === 0) {
        notify('notice', '這條 lane 上沒有轉態點可以停，關聯線接不上去');
        return;
      }
      const now = cursor.cycle;
      let next;
      if (dir > 0) {
        next = cells.find(function (c) { return c > now; });
        if (next === undefined) next = cells[cells.length - 1];
      } else {
        const before = cells.filter(function (c) { return c < now; });
        next = before.length === 0 ? cells[0] : before[before.length - 1];
      }
      cursor = { laneIndex: lane, cycle: next };
      selection = { laneIndex: lane, laneTo: lane, from: next, to: next };
      // `cell`, not `cycle`: `hoverBoundary` carries `geometry.boundaryAt`'s
      // own field names all the way to the layer's `hotDot` (`createLayer`), which compares
      // `.cell` — the two spellings are deliberately different and a mix-up
      // fails silently there.
      hoverBoundary = { laneIndex: lane, cell: next };
      repaintDrawing(layout);
      scrollCursorIntoView();
      sayCursor(layout);
    }

    /** Paint the cursor's run with the current brush: one gesture, one
     *  `commit`, exactly like the pointer's `mouseup`. The range comes from
     *  `selection` when it belongs to the cursor's own lane — which every
     *  keyboard move guarantees — and from the single cursor cell otherwise,
     *  so a selection left behind by a drag on ANOTHER lane can never make a
     *  keystroke paint somewhere the cursor is not. */
    function paintAtCursor() {
      if (cursor === null) return;
      const sel = (selection !== null && selection.laneIndex === cursor.laneIndex)
        ? selection : { laneIndex: cursor.laneIndex, from: cursor.cycle, to: cursor.cycle };
      const ch = brush;
      commit('paint', function (doc) {
        return codec.setCellRange(doc, sel.laneIndex, sel.from, sel.to, ch);
      });
    }

    /**
     * Say where the cursor is, in words.
     *
     * The rectangle is the answer for someone who can see it; the hidden live
     * region carries `role="status"`, so this is the same answer for someone
     * who cannot. It names the LANE rather than its index because the index is the
     * codec's flattened display order and means nothing to the person reading.
     *
     * POSITION ONLY — no instructions. A live region is re-announced in full
     * every time it changes, and this changes on every arrow key, so a hint
     * appended here is a hint read out on every press of a key the user is
     * holding down. The hint is already in the two places it belongs and is
     * announced once each: the canvas's own `aria-label`, read when the
     * keyboard arrives on the drawing, and the opening announcement.
     */
    function sayCursor(layout) {
      if (cursor === null) return;
      const row = layout.lanes[cursor.laneIndex];
      const lane = row === undefined ? null : row.lane;
      const name = (lane !== null && typeof lane.name === 'string' && lane.name !== '')
        ? lane.name : '第 ' + (cursor.laneIndex + 1) + ' 條 lane';
      const from = selection === null ? cursor.cycle : Math.min(selection.from, selection.to);
      const to = selection === null ? cursor.cycle : Math.max(selection.from, selection.to);
      const span = (selection !== null && selection.laneIndex === cursor.laneIndex && to > from)
        ? '，選了 cycle ' + (from + 1) + '–' + (to + 1) : '';
      announce('游標：' + name + ' cycle ' + (cursor.cycle + 1) + span);
    }

    /** The interaction layer and the selection state, repainted without
     *  touching the store or the engine: a cursor move changes no document
     *  content, so asking the engine to redraw would paint the identical
     *  picture. */
    function repaintDrawing(layout) {
      const l = layout === undefined || layout === null
        ? layoutNow() : layout;
      paintLayer(l);
      // AFTER `paintLayer`, which is what clamps `selection` into the document
      // it just drew — reading it before would arm a button against a range
      // the drawing has already refused.
      paintSelectionState(store.doc, l);
    }

    /**
     * Keep the cursor inside the canvas column's clip.
     *
     * `.ed-wave-stage` is a scroll container — that is how a diagram
     * wider than the column is reached at all — so a cursor walked off its
     * right-hand edge is a keyboard cursor the user cannot see, which is the
     * one thing this task may not produce. Not a corner: MEASURED in this
     * session on the 800x600 viewport the browser suites use, with the fixture
     * this file's journey rows use, the column's `clientWidth` is 230px and the
     * drawing is 240px wide at 5 cycles — so the LAST cycle is already off the
     * clip before anything is inserted.
     *
     * The arithmetic is against the wrap's PADDING BOX (`clientLeft` /
     * `clientWidth`), which is the box `scrollLeft` moves; measuring against
     * `getBoundingClientRect().width` instead counts the border and leaves the
     * cell short of where it was asked to go.
     */
    function scrollCursorIntoView() {
      if (cursor === null || engineCanvas === null) return;
      // Task 6a: the cell's client rect from the engine canvas.
      const box = engineCanvas.cellRectClient(cursor.laneIndex, cursor.cycle);
      if (box === null) return;
      const wbox = stage.getBoundingClientRect();
      const left = box.left - (wbox.left + stage.clientLeft);
      const top = box.top - (wbox.top + stage.clientTop);
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      if (left < 0) stage.scrollLeft += left;
      else if (left + box.width > w) stage.scrollLeft += left + box.width - w;
      if (top < 0) stage.scrollTop += top;
      else if (top + box.height > h) stage.scrollTop += top + box.height - h;
    }

    // ── the pointer ───────────────────────────────────────────────────────
    /**
     * A paint is a real drag: `mousedown` picks the first cycle, `mousemove`
     * extends the run, `mouseup` is the one moment the document changes.
     *
     * Nothing is applied while the button is down. One gesture is one
     * `setCellRange`, which is also what the run means — a bus dragged across
     * four cycles is one value with three continuations, not four values.
     */
    function onCanvasDown(ev) {
      if (ev.button !== 0) return;
      const layout = layoutNow();
      // Task 7, spec section 4.3: the ruler's ＋ inserts a cycle at its
      // boundary in every lane. Its ring is the one thing in the ruler band
      // that takes a press (lib/md2doc.js), so the target says which boundary
      // it is — read off the element the browser hit, not recomputed from
      // where the pointer is. The keyboard stays where it was: nothing here
      // is a cell to put the cursor on.
      const plus = ev.target !== null && typeof ev.target.closest === 'function'
        ? ev.target.closest('.ed-wave-ruler-plus') : null;
      if (plus !== null && canvas.contains(plus)) {
        ev.preventDefault();
        const at = Number(plus.getAttribute('data-cycle'));
        if (Number.isInteger(at)) insertCyclesAt(at);
        return;
      }
      // Task 8, spec section 4.4: a press on a NAME renames it in place (a
      // group's title: the group). The name column is never a cell, so no
      // other branch below could have wanted this press. A blank row has
      // no name; its ⠿ takes the keyboard instead (`openLaneRename`).
      const named = nameHitAt(ev, layout);
      if (named !== null) {
        ev.preventDefault();
        if (named.kind === 'lane') openLaneRename(named.laneIndex);
        else openGroupRename(named.span);
        return;
      }
      // v3.5.0 Task 7: armed edge-creation claims the press outright, before
      // the edge-select / deselect / paint dispatch below ever runs — the
      // whole point of arming is that the NEXT press starts the drag, so it
      // must not be shadowed by "did this land on an existing edge" or "did
      // this land on a cell to paint". A press that misses every lane
      // (`at === null`, e.g. the canvas's own padding) leaves the button
      // armed rather than eating it for nothing: missing the diagram is not
      // the same as aiming at the wrong cell, but the recovery is the same —
      // try the press again.
      if (edgeMode === 'armed') {
        const at = cellFromEvent(ev);
        if (at === null) return;
        ev.preventDefault();
        pendingFrom = { at: at.laneIndex, cell: at.cycle };
        setEdgeMode('dragging');
        // The keyboard follows the pointer here for the same reason it does
        // in the paint path below: `cursor` is the ONE notion of "where is
        // the other end right now" that the mouse move handler, the preview
        // line and (on the keyboard's own path) `handleDrawingKey` all read,
        // so drag and keystroke can never disagree about the live endpoint.
        cursor = { laneIndex: at.laneIndex, cycle: at.cycle };
        canvas.focus();
        render();
        d.addEventListener('mousemove', onCanvasMove, true);
        d.addEventListener('mouseup', onCanvasUp, true);
        return;
      }
      // v3.5.0 Task 8: a press on the SELECTED edge's own handle starts an
      // endpoint drag, ahead of the plain select/deselect dispatch a few
      // lines down — that dispatch's own `edgeHitAt` would otherwise see the
      // exact same press and read it as "re-select the edge that is already
      // selected", which is a real answer but the wrong one for a press ON
      // its handle. Recomputed fresh here (`geometry.edgeLayout`, not a
      // cached list) for the same reason `cellFromEvent`/`edgeHitAt`
      // already are — a press can never be judged against a layout
      // `paintLayer` has moved on from.
      //
      // Scoped to `handle.index === selectedEdge` on purpose:
      // `geometry.edgeHandleAt` answers for EVERY edge's endpoints
      // regardless of selection (see its own comment), but `renderEdges`
      // only ever DRAWS handles on the selected one — a press near a
      // DIFFERENT edge's endpoint has no handle on screen to have landed on,
      // and falls through to the ordinary select-by-path/point dispatch
      // below exactly as it always has.
      if (selectedEdge !== null) {
        const edges = geometry.edgeLayout(store.doc, layout);
        const ep = enginePoint(ev);
        const handle = ep === null ? null : geometry.edgeHandleAt(edges, ep.x, ep.y);
        if (handle !== null && handle.index === selectedEdge) {
          ev.preventDefault();
          // Fix round 1, item 1: a self-loop (`from === to`) puts both ends
          // at the exact same pixel, so `geometry.edgeHandleAt`'s own
          // `['to', 'from']` iteration always resolves the press to `'to'` —
          // there is no position this file (or the user) can use to tell
          // the two apart, and inferring one would just be a guess dressed
          // up as an answer. What was missing was not a fix, it was the
          // honest half: before this, the press silently moved `'to'` with
          // nothing on screen saying that is what happened, or that `'from'`
          // was never reachable at all.
          const dragged = edges.filter(function (e) { return e.index === handle.index; })[0];
          if (dragged !== undefined && dragged.edge.from === dragged.edge.to) {
            notify('notice', '這是一條 self-loop（起點跟終點在同一格），兩端的把手疊在同一個位置：' +
              '只有拖得到的這一端可以搬，另一端目前搬不到。');
          }
          endpointDrag = { index: handle.index, end: handle.end, at: null, cell: null };
          canvas.focus();
          // Fix round 1, item 2: without a repaint here the press looks
          // inert until the first `pointermove` — `.is-drag-source` (set
          // from this same `endpointDrag`, read by `renderEdges`) would not
          // fade the dragged edge until then, unlike the sibling
          // `edgeMode === 'armed'` branch above, which repaints immediately
          // on its own press. `paintLayer`, not the full `render()`: this
          // state change touches only the canvas SVG (the faded path; the
          // dashed landing preview has nothing to draw yet since `at` is
          // still `null`) — `selectedEdge` is unchanged, so nothing outside
          // the layer needs repainting.
          paintLayer(layout);
          // The toolbar reads `selection`; this repaint can change it (fix round 1).
          paintSelectionState(store.doc, layout);
          d.addEventListener('mousemove', onCanvasMove, true);
          d.addEventListener('mouseup', onCanvasUp, true);
          return;   // 不塗、不選格
        }
      }
      // Task 7: a press on a DATA LABEL opens that label's field (spec
      // section 4.3,「點標籤文字」) instead of painting. The engine draws the
      // labels now, underneath this layer, so no element under the press can
      // say "label" (the old `.ed-wave-buslabel` mark died with the
      // hand-drawn canvas in Task 6a). The answer comes from the engine's own
      // text boxes instead (`engineCanvas.labelBoxes()`, measured off the svg
      // the engine drew and paired to their data slot), the same way
      // `cellFromEvent` answers which cell a press is on. Only the label's
      // own box counts: a press anywhere else in the same bus box falls
      // through and paints, because painting a bus cell is what the brushes
      // are for. Ahead of `edgeHitAt` for the reason that has always held
      // here: an edge whose end sits on a labelled cell must not swallow the
      // press on the label.
      const hitLabel = labelHitAt(ev);
      const labelLane = hitLabel === null ? undefined : layout.lanes[hitLabel.laneIndex];
      const labelCycle = labelLane === undefined ? null : cycleOfSlot(labelLane.lane, hitLabel.slot);
      if (labelCycle !== null) {
        ev.preventDefault();
        const hadEdge = selectedEdge !== null;
        selectedEdge = null;
        cursor = { laneIndex: hitLabel.laneIndex, cycle: labelCycle };
        selection = {
          laneIndex: hitLabel.laneIndex, laneTo: hitLabel.laneIndex,
          from: labelCycle, to: labelCycle,
        };
        canvas.focus();
        if (hadEdge) render();
        else {
          paintLayer(layout);
          paintSelectionState(store.doc, layout);
        }
        openDataEdit(hitLabel.laneIndex, labelCycle);
        return;
      }
      // An edge — its endpoint handle first (it sits ON TOP of the cell it
      // anchors to, and a selected edge's handle must win the press even
      // though the cell underneath is perfectly paintable), then its path —
      // is asked BEFORE the cell/brush dispatch below (but AFTER the bus
      // label block above — see its own comment for why that one now goes
      // first). A hit selects and returns without arming `drag`: this
      // dispatch draws and selects edges; a press on the SELECTED edge's own
      // handle never reaches here at all (see the drag-start branch above),
      // so this remains a plain select — it does not itself drag anything.
      const edgeHit = edgeHitAt(ev, layout);
      if (edgeHit !== null) {
        ev.preventDefault();
        selectedEdge = edgeHit;
        canvas.focus();
        render();
        return;
      }
      // A press that hit neither an edge's handle nor its path deselects
      // whatever WAS selected. A selection that outlives a click elsewhere
      // would let a later delete act on an edge the user has stopped
      // looking at. This is IN ADDITION to the paint gesture below, on the
      // very same press — not instead of it.
      const hadSelectedEdge = selectedEdge !== null;
      selectedEdge = null;
      const at = cellFromEvent(ev);
      if (at === null) {
        // Missed the diagram entirely (e.g. the canvas's own padding). Only
        // the deselect, if there was one to make, needs a repaint; nothing
        // else here changed.
        if (hadSelectedEdge) render();
        return;
      }
      ev.preventDefault();
      drag = { laneIndex: at.laneIndex, from: at.cycle, to: at.cycle };
      selection = {
        laneIndex: at.laneIndex, laneTo: at.laneIndex,
        from: at.cycle, to: at.cycle,
      };
      // The keyboard follows the pointer, for two reasons that are really one:
      // the two cursors may not disagree about which cell is current, and
      // `preventDefault()` above suppresses the focus a press would otherwise
      // give a `tabindex` element — so without this, clicking the drawing and
      // then pressing `1` would paint wherever the keyboard had been left.
      cursor = { laneIndex: at.laneIndex, cycle: at.cycle };
      canvas.focus();
      // The common case — no edge was selected — keeps the cheap
      // `paintLayer`-only repaint this always did. A full `render()` is
      // only paid on the transition that actually needs it: dropping the
      // edge selection, which `render()` publishes on the overlay.
      if (hadSelectedEdge) render();
      else {
        paintLayer(layout);
        // The toolbar reads `selection`; this repaint can change it (fix round 1).
        paintSelectionState(store.doc, layout);
      }
      d.addEventListener('mousemove', onCanvasMove, true);
      d.addEventListener('mouseup', onCanvasUp, true);
    }

    function onCanvasMove(ev) {
      if (endpointDrag !== null) {
        // Same abandoned-button recovery as the two drags below: the button
        // came up somewhere this page never heard about.
        if (ev.buttons === 0) { onCanvasUp(); return; }
        const layout = layoutNow();
        const at = cellFromEvent(ev);
        // A move that strays off the diagram leaves `at`/`cell` exactly
        // where they last were, same recovery as `edgeMode === 'dragging'`
        // below and for the same reason: the drop target the user is
        // currently over is still the last cell the pointer was actually on
        // top of, not "nowhere".
        if (at !== null) {
          endpointDrag = { index: endpointDrag.index, end: endpointDrag.end,
            at: at.laneIndex, cell: at.cycle };
        }
        // `hoverBoundary` is left alone here: the layer's dots are only
        // drawn while `edgeMode !== 'idle'` (see `paintLayer`'s `dots`, unchanged
        // by this task), and an endpoint drag never moves `edgeMode` away
        // from 'idle' (it is a wholly separate gesture from edge-creation —
        // see `endpointDrag`'s own declaration comment), so there is no dot
        // on screen for a hot mark to name here. `cellFromEvent` still
        // snaps this drag's OWN drop target to the nearest anchor via
        // `boundaryAt` — that part of Task 11 applies regardless — this is
        // only about the separate hover-dot chrome.
        // The document is untouched during the drag (rule 3): this repaints
        // the preview only, never a `commit`.
        paintLayer(layout);
        // The toolbar reads `selection`; this repaint can change it (fix round 1).
        paintSelectionState(store.doc, layout);
        return;
      }
      if (edgeMode === 'dragging') {
        // Same abandoned-button recovery as the paint drag below: the button
        // came up somewhere this page never heard about.
        if (ev.buttons === 0) { onCanvasUp(); return; }
        const layout = layoutNow();
        const at = cellFromEvent(ev);
        // A move that strays off the diagram leaves `cursor` — and so the
        // preview line — exactly where it last was, rather than snapping the
        // line away: the drop target the user is currently over is still the
        // last cell the pointer was actually on top of.
        if (at !== null) {
          cursor = { laneIndex: at.laneIndex, cycle: at.cycle };
          // v3.6.0 Task 11: the hot dot keeps following the drag once it
          // starts, rather than freezing at whatever it last showed during
          // the pre-press hover (or never lighting up at all, if the drag
          // started from a keyboard Enter with no hover first) — same
          // `cycle`-to-`cell` conversion as `onCanvasHover`, at this same
          // boundary.
          hoverBoundary = { laneIndex: at.laneIndex, cell: at.cycle };
        }
        // The document is untouched during the drag (rule 2): this repaints
        // the preview line only, never a `commit`.
        paintLayer(layout);
        // The toolbar reads `selection`; this repaint can change it (fix round 1).
        paintSelectionState(store.doc, layout);
        return;
      }
      if (drag === null) return;
      // The button came up somewhere this page never heard about — outside the
      // window, or over the browser's own chrome. Without this the drag stays
      // armed, the next pointer move across the canvas keeps extending a
      // selection with nothing held down, and the following press commits a
      // range the user never drew. Read from the code, not measured: puppeteer
      // cannot withhold a `mouseup`.
      if (ev.buttons === 0) { onCanvasUp(); return; }
      const layout = layoutNow();
      const at = cellFromEvent(ev);
      if (at === null) return;
      // The lane is fixed by the press: a drag that strays onto a neighbour is
      // still painting the lane it started on.
      drag.to = at.cycle;
      selection = {
        laneIndex: drag.laneIndex, laneTo: drag.laneIndex,
        from: drag.from, to: drag.to,
      };
      // The drag's live end is where the cursor is, so a paint continued with
      // Shift+←/→ after the button comes up carries on from the same cell.
      cursor = { laneIndex: drag.laneIndex, cycle: drag.to };
      paintLayer(layout);
      // The toolbar reads `selection`; this repaint can change it (fix round 1).
      paintSelectionState(store.doc, layout);
    }

    function onCanvasUp() {
      d.removeEventListener('mousemove', onCanvasMove, true);
      d.removeEventListener('mouseup', onCanvasUp, true);
      if (endpointDrag !== null) {
        finishEndpointDrag();
        return;
      }
      if (edgeMode === 'dragging') {
        // `cursor` is never null here: `onCanvasDown` set it to the press
        // cell before this drag was ever armed, and every move since then
        // only ever moved it to another real cell (see `onCanvasMove`
        // above). The null-safe form costs nothing and matches the
        // `finishEdgeDrag`/`codec.ensureNode` contract exactly rather than
        // asserting a fact this file does not have to assert.
        finishEdgeDrag(cursor === null ? null : cursor.laneIndex,
          cursor === null ? null : cursor.cycle);
        return;
      }
      if (drag === null) return;
      const g = drag;
      drag = null;
      const painted = commit('paint', function (doc) {
        return codec.setCellRange(doc, g.laneIndex, g.from, g.to, brush);
      });
      // A drag that changed nothing (the run already held the brush) still
      // ended: repaint so the selection it made gets its range toolbar,
      // which the layer kept down while the button was held.
      if (!painted) repaintDrawing();
    }

    /**
     * The end of an endpoint drag on the SELECTED edge — one `commit`, so one
     * undo step, matching every other gesture in this file (constraint 5).
     *
     * Unlike `finishEdgeDrag` below, this has no keyboard-driven twin and
     * takes no parameters: there is no second input device sharing `cursor`
     * to aim it, so everything the drop needs already lives in `endpointDrag`
     * itself, read and cleared in the same first two lines the same way
     * `finishEdgeDrag` clears `pendingFrom`'s owning mode up front.
     *
     * `drag.at === null` means the pointer never landed on a real cell for
     * the whole gesture (pressed the handle, released off the diagram or
     * without ever moving) — nothing to drop onto, so this only repaints to
     * take the (already absent) preview line off screen and does not call
     * `commit` at all; a `commit` with a non-integer `at` would just be
     * `codec.moveEdgeEnd`'s own bounds check refusing it one function later
     * for no benefit.
     *
     * Every other landing — including the three no-ops `moveEdgeEnd` itself
     * refuses (dropping back on the end's own cell, dropping on the cell
     * holding the edge's OTHER end, and an out-of-range target) — reaches
     * `commit` exactly once and is judged by `commit`'s own return value,
     * the same "one test of did-anything-change" rule `finishEdgeDrag`
     * documents at length below: nothing here re-derives any of those three
     * checks, that would be a second belief about the same refusal living
     * next to `moveEdgeEnd`'s own.
     */
    function finishEndpointDrag() {
      const drag = endpointDrag;
      endpointDrag = null;
      if (drag === null) return;
      if (drag.at === null) { render(); return; }
      commit('edge-move', function (doc) {
        return codec.moveEdgeEnd(doc, drag.index, drag.end, drag.at, drag.cell);
      });
      render();
    }

    /**
     * The end of an edge-creation gesture, reached from both input devices —
     * the mouse's `onCanvasUp` above and the keyboard's second Enter in
     * `handleDrawingKey` below. Constraint 4: one function, not two
     * histories of the same decision.
     *
     * `at`/`cell` name the drop cell, or `null`/`null` when the gesture did
     * not land on any lane at all. Nothing below special-cases the no-op
     * drops rule 3 lists — dropping back on the start cell, dropping on a
     * row with no waveform (a spacer — a group's own title is never a row
     * to drop on in the first place: `codec.isLane` rejects the title
     * string, so `flattenLanes` never allocates one, and there is no
     * coordinate here to mis-hit), dropping on the cell that already holds
     * this edge's OTHER end, and — fix round 1 — repeating the exact same
     * drag a second time:
     *
     *   - a spacer's row IS a real, hittable cell (`geometry.cellAt` answers
     *     it like any other), but `codec.ensureNode`'s own lane-local bound
     *     refuses it: an empty `wave` reads as zero cells, so no cycle is
     *     ever in range. The "missed the diagram entirely" case
     *     (`at === null`) falls through the SAME check for a different
     *     reason — neither `at` nor `cell` is an integer `ensureNode`'s
     *     bounds test accepts;
     *   - the start cell and the drop cell landing on the same anchor —
     *     whether because they truly are the same cell, or because the drop
     *     cell is wherever this edge's other end already lives — is exactly
     *     `a.letter === b.letter` below;
     *   - a repeat of this exact gesture between the same two cells would,
     *     without the check below, silently push a byte-identical second
     *     `doc.edge` entry — two arrows drawn exactly on top of each other,
     *     indistinguishable on screen, plus a second undo step for nothing
     *     visible (MEASURED against the real store: drag (0,1)->(0,3) twice,
     *     `doc.edge` becomes `["a~>b","a~>b"]`). Refused here rather than
     *     before `commit`, same as the other three: an entry with the same
     *     four fields (`from`, `to`, `shape`, `label`) already in `doc.edge`
     *     makes this call's own output redundant. This is narrower than
     *     "refuse any second edge between these two anchors" — two
     *     DIFFERENT annotations between the same pair (`a~>b setup` next to
     *     `a-b hold`) are legitimate and stay possible; only a verbatim
     *     repeat of THIS gesture's own fixed output (`shape: '~>'`,
     *     `label: ''`) is refused.
     *
     * So there is one test of "did anything change", not four: `commit`'s
     * own return value. A refused/no-op commit pushes no undo step (`commit`
     * already guarantees that) and — rule 1 — leaves the gesture `'armed'`
     * rather than disarming it, because the user pressed the button and got
     * nothing for it; a real edge disarms back to `'idle'`. Either way this
     * repaints once more on its own, because `commit` only repaints when it
     * changed something, and the pending-line preview has to come off the
     * screen in the no-op case too.
     *
     * Fix round 3: `pendingFrom === null` on entry is no longer read as
     * "nothing to do" and left at that. `carryMarks` can now drop
     * `pendingFrom` to `null` on its own (round 2, both when a structural
     * change makes it untraceable and when no `laneTrace` is injected at
     * all) WITHOUT touching `edgeMode` — before round 2 the only code path
     * that ever nulled `pendingFrom` was `setEdgeMode('idle')` itself, so
     * the two could never come apart. Reached from `onCanvasUp` while
     * `edgeMode === 'dragging'` (the mouse button was down when the
     * document changed out from under it), leaving `edgeMode` untouched
     * here would strand it at `'dragging'` forever: `onCanvasMove` and
     * `onCanvasUp` both check that mode FIRST, so every later paint drag's
     * `mousemove`/`mouseup` would be swallowed by this function instead of
     * painting, silently and with no error. So this resyncs the mode to
     * the mark it depends on before doing anything else.
     */
    function finishEdgeDrag(at, cell) {
      if (pendingFrom === null) { setEdgeMode('idle'); render(); return; }
      const from = pendingFrom;
      const changed = commit('edge-add', function (doc) {
        const a = codec.ensureNode(doc, from.at, from.cell);
        if (a.letter === null) return doc;
        const b = codec.ensureNode(a.doc, at, cell);
        if (b.letter === null) return doc;
        if (a.letter === b.letter) return doc;   // same anchor both ends
        const dup = (b.doc.edge || []).some(function (entry) {
          const e = codec.parseEdge(entry);
          return e !== null && e.from === a.letter && e.to === b.letter &&
            e.shape === '~>' && e.label === '';
        });
        if (dup) return doc;   // byte-identical repeat of this gesture
        return codec.addEdge(b.doc, { from: a.letter, to: b.letter, shape: '~>', label: '' });
      });
      setEdgeMode(changed ? 'idle' : 'armed');
      render();
    }

    /**
     * Pointer coordinates in the drawing's own space, then the codec's cell.
     *
     * v3.6.0 Task 11: while an edge gesture is live — `edgeMode !== 'idle'`
     * (armed, marking a start; or dragging, aiming the other end) or an
     * `endpointDrag` is in flight — the target is the ANCHOR the engine
     * actually draws the line to, not the cell under the pointer.
     * `geometry.boundaryAt` rounds to the nearest one; `geometry.cellAt`
     * floors to the cell the pointer is over. Painting still wants the
     * floor: the brush's target is the cell you are over, and unifying the
     * two here is exactly the regression this task exists to prevent (see
     * `boundaryAt`'s own comment in `wave-geometry.js`).
     *
     * `boundaryAt` returns `{laneIndex, cell}`; every caller of this
     * function already destructures `{laneIndex, cycle}` from `cellAt`'s
     * shape, so the field is renamed HERE, at the one place the two
     * definitions meet, rather than letting a `cell` leak into a `cycle`
     * slot downstream.
     */
    function cellFromEvent(ev) {
      // Task 6a: through the engine canvas, which converts client coordinates
      // to engine units and asks the same `geometry.cellAt` / `boundaryAt` —
      // only while it has drawn the document the store holds now.
      if (engineCanvas === null || engineCanvas.doc !== store.doc) return null;
      if (edgeMode !== 'idle' || endpointDrag !== null) {
        const b = engineCanvas.boundaryAt(ev.clientX, ev.clientY);
        return b === null ? null : { laneIndex: b.laneIndex, cycle: b.cell };
      }
      return engineCanvas.cellAt(ev.clientX, ev.clientY);
    }

    /** A pointer event in the engine's own units (the canvas svg's viewBox),
     *  the space `geometry.edgeLayout` / `edgeHandleAt` answer in on the
     *  canvas's layout. Null while nothing is drawn. */
    function enginePoint(ev) {
      const svg = engineCanvas === null ? null : engineCanvas.svg;
      if (svg === null) return null;
      const r = svg.getBoundingClientRect();
      return { x: (ev.clientX - r.left) / engineCanvas.scale, y: (ev.clientY - r.top) / engineCanvas.scale };
    }

    /**
     * Pure hover, no button down, nothing committed. Three marks follow it:
     * the cycle column under the pointer (`hoverCell`, idle), the ruler's ＋
     * at the nearest boundary while the pointer is over the ruler band
     * (`rulerPlus`, Task 7), and — while armed and not yet dragging — the
     * nearest transition anchor, so the layer's hot dot can light up before
     * the user presses. Each repaint happens only when one of them changed.
     *
     * A canvas-own listener rather than the document-level
     * `onCanvasMove`/`onCanvasUp` pair: those two are only added once a
     * drag actually starts, so a plain hover before the first press has
     * nothing else watching it. Once a drag IS live (a paint drag, an armed
     * edge drag or an endpoint drag), `onCanvasMove`'s own branches already
     * repaint on every move, so this steps out of the way.
     */
    function onCanvasHover(ev) {
      if (drag !== null || endpointDrag !== null || edgeMode === 'dragging' || gripDrag !== null) return;
      // Every layer repaint retires an open data-label field (`paintLayer`);
      // a pointer drifting over the drawing is not a reason to lose it.
      if (dataEdit !== null) return;
      const layout = layoutNow();
      // Task 7: over the ruler band the pointer may bring up the ＋; over the
      // drawing it lights the cycle column (idle) or the nearest transition
      // dot (armed, as before).
      const band = rulerBoundaryAt(ev, layout);
      // Task 8: over the name column the pointer lights a row (a group's
      // rows) and brings up that row's ⠿; nothing else is lit there.
      const nextName = band === undefined && gripDrag === null ? nameHitAt(ev, layout) : null;
      let nextPlus = null;
      let nextHover = null;
      let nextDot = null;
      if (band !== undefined) {
        nextPlus = band;
      } else if (nextName !== null) {
        // the name column: no cell, no dot
      } else if (edgeMode === 'armed') {
        const at = cellFromEvent(ev);
        nextDot = at === null ? null : { laneIndex: at.laneIndex, cell: at.cycle };
      } else {
        nextHover = cellFromEvent(ev);
      }
      const sameCell = function (a, b, key) {
        return (a === null && b === null) ||
          (a !== null && b !== null && a.laneIndex === b.laneIndex && a[key] === b[key]);
      };
      const dotSame = edgeMode !== 'armed' || sameCell(hoverBoundary, nextDot, 'cell');
      if (dotSame && rulerPlus === nextPlus && sameCell(hoverCell, nextHover, 'cycle') &&
          sameName(hoverName, nextName)) return;
      if (edgeMode === 'armed') hoverBoundary = nextDot;
      rulerPlus = nextPlus;
      hoverCell = nextHover;
      hoverName = nextName;
      paintLayer(layout);
      // The toolbar reads `selection`; this repaint can change it (fix round 1).
      paintSelectionState(store.doc, layout);
    }

    /**
     * The `doc.edge` index the press landed on, or `null`.
     *
     * Task 6a: the ENGINE draws the edges now, and the `.ed-wave-edge-hit`
     * strokes and `.ed-wave-edge-handle` rects described below belong to the
     * retired hand-drawn canvas — they no longer exist, so half 2 finds
     * nothing and only half 1 (the selected edge's handle, or a self-loop's,
     * in engine units via `enginePoint`) can still answer. Selecting an edge
     * by its line is rebuilt in Task 9; the text below describes the old
     * canvas.
     *
     * Two questions, in order, both against `geometry.edgeLayout(store.doc,
     * layout)` computed fresh here — the same recompute-don't-cache rule
     * `cellFromEvent`/`geometry.cellAt` already follow, so a press can never
     * be judged against a layout `paintLayer` has moved on from:
     *
     *   1. `geometry.edgeHandleAt` — a handle is a small rect centred on an
     *      endpoint, asked in the SAME layout-local space `cellFromEvent`
     *      uses (the canvas's own `getBoundingClientRect()`). v3.6.0 Task 6:
     *      `SIZES.nameColWidth` is 120, not 0 — but `ev.clientX - box.left`
     *      still needs nothing added or subtracted for it, because the name
     *      column's width is already baked into every cell's own `originX`
     *      (`wave-geometry.layoutOf`), the same layout-local coordinate
     *      `geometry.edgeHandleAt`/`cellAt` read. One coordinate space, not
     *      two reconciled by an offset — a nonzero name column moves where
     *      cycle 0 STARTS in that space, it does not add a second term on
     *      top of it. final review finding 4: trusted when it names the
     *      edge that is actually SELECTED — `renderEdges` only DRAWS a
     *      handle on the selected edge, so its answer for any OTHER edge is a
     *      rectangle with nothing on screen, and letting that phantom
     *      rectangle claim the press is what used to swallow a bus label's
     *      press whenever the label's cell doubled as an unselected edge's
     *      endpoint (see `onCanvasDown`'s data-label check, which now
     *      runs before this function is even called, for the other half of
     *      that fix). A press within a handle-sized target of the SELECTED
     *      edge's own endpoint still selects it rather than painting the
     *      cell under it. final review re-review, item 1: ALSO trusted when
     *      the named edge is a self-loop (`from === to`), selected or not —
     *      a self-loop's `pathFor` output is a zero-length path (every
     *      command's endpoint equals its start), which Chrome gives no hit
     *      area at all, so #2 below can never find one; the handle is the
     *      only thing a self-loop can ever be selected by, and a self-loop
     *      the user hand-writes into the markdown must stay selectable and
     *      deletable even before it has ever been clicked once.
     *   2. The `<path class="ed-wave-edge-hit">` twin `renderEdges` layers
     *      over each visible edge, read back through `document.elementFromPoint`
     *      at the press's SCREEN coordinates (no conversion needed — that is
     *      what `elementFromPoint` already takes).
     */
    function edgeHitAt(ev, layout) {
      const edges = geometry.edgeLayout(store.doc, layout);
      if (edges.length === 0) return null;
      const ep = enginePoint(ev);
      const handle = ep === null ? null : geometry.edgeHandleAt(edges, ep.x, ep.y);
      // final review finding 4: only trust the handle answer when it names
      // the edge that is actually SELECTED — the same scoping the
      // endpoint-drag branch in `onCanvasDown` already applies, for the same
      // reason (see its comment): `renderEdges` only ever DRAWS a handle on
      // the selected edge, so `geometry.edgeHandleAt`'s answer for any OTHER
      // edge index is a rectangle with nothing on screen at all. Before this,
      // that undrawn rectangle still won the press here — a bus label whose
      // cell happened to double as an unselected edge's endpoint could never
      // open its label editor, because this branch claimed the press first.
      // An edge stays selectable regardless: the fall-through below still
      // hit-tests every edge's own 10px `.ed-wave-edge-hit` path.
      //
      // final review re-review, item 1: EXCEPT a self-loop (`from === to`),
      // which this "an edge stays selectable regardless" promise does not
      // actually cover — MEASURED regression, not a hypothetical: `pathFor`
      // degenerates to a zero-length path for every shape family when
      // `from === to` (every `L`/`C` command's endpoint equals its start),
      // and Chrome gives a zero-length, butt-cap path NO hit area at all —
      // `elementsFromPoint` returns nothing there, so the `.ed-wave-edge-hit`
      // fallback below can never find it either. The phantom handle this
      // finding gates off was the ONLY thing that could ever select a
      // self-loop that has never been selected before (`selectedEdge` is set
      // from exactly this function's return value, nowhere else) — a
      // self-loop the user hand-writes into the markdown (the UI itself
      // never creates one; `finishEdgeDrag` refuses a same-letter drag) would
      // otherwise be permanently unselectable and undeletable by mouse. So a
      // handle match is trusted when it is drawn (`handle.index ===
      // selectedEdge`, as before) OR when the edge it names is a self-loop —
      // a self-loop's handle is the one hit target it has, selected or not.
      if (handle !== null) {
        if (handle.index === selectedEdge) return handle.index;
        const named = edges.filter(function (e) { return e.index === handle.index; })[0];
        if (named !== undefined && named.edge.from === named.edge.to) return handle.index;
      }
      if (typeof d.elementFromPoint !== 'function') return null;
      const el = d.elementFromPoint(ev.clientX, ev.clientY);
      const hitPath = el !== null && el !== undefined && typeof el.closest === 'function'
        ? el.closest('.ed-wave-edge-hit') : null;
      if (hitPath === null || !canvas.contains(hitPath)) return null;
      const idx = hitPath.getAttribute('data-edge-index');
      return idx === null ? null : Number(idx);
    }

    /**
     * The data label under a press, as `{laneIndex, slot}`, or null — Task 7.
     *
     * The engine draws the labels, and it draws them UNDER the interaction
     * layer, so the element a press lands on is always the layer (the click
     * checks pin that with `elementFromPoint`); nothing in the DOM under the
     * pointer can be asked. The question is answered the way
     * `cellFromEvent` answers its own: by geometry, here the boxes the
     * engine's text was measured at when it drew (`engineCanvas.labelBoxes`,
     * client px, already paired to their data slot), widened by
     * `LABEL_HIT_PAD` so a one-character label is not a 10px target. A label
     * the measurement could not pair to a segment (`slot === null`) is not a
     * target. Only while the canvas shows the document the store holds.
     */
    function labelHitAt(ev) {
      if (engineCanvas === null || engineCanvas.doc !== store.doc) return null;
      for (const b of engineCanvas.labelBoxes()) {
        if (b.slot === null) continue;
        if (ev.clientX >= b.left - LABEL_HIT_PAD && ev.clientX <= b.left + b.width + LABEL_HIT_PAD &&
            ev.clientY >= b.top - LABEL_HIT_PAD && ev.clientY <= b.top + b.height + LABEL_HIT_PAD) {
          return { laneIndex: b.laneIndex, slot: b.slot };
        }
      }
      return null;
    }

    /**
     * Which cycle boundary the ruler's ＋ belongs at for this pointer event,
     * Task 7: `undefined` when the pointer is not over the ruler band (it is
     * over the drawing, or nothing is drawn), `null` over the band but not
     * near a boundary, else the boundary `b` (0..cycles, the left edge of
     * cycle `b`; `cycles` is the right end). The boundaries are the first
     * lane's, the lane `createLayer` numbers the ruler from.
     */
    function rulerBoundaryAt(ev, layout) {
      const svg = engineCanvas === null ? null : engineCanvas.svg;
      if (svg === null || engineCanvas.layout !== layout || layout.lanes.length === 0) return undefined;
      const sr = svg.getBoundingClientRect();
      if (ev.clientY >= sr.top) return undefined;
      const k = engineCanvas.scale;
      let best = null;
      let bestDist = Infinity;
      for (let b = 0; b <= layout.cycles; b++) {
        const x = sr.left + laneCellRect(layout, 0, b).x * k;
        const dist = Math.abs(ev.clientX - x);
        if (dist < bestDist) { best = b; bestDist = dist; }
      }
      return bestDist <= PLUS_REACH ? best : null;
    }

    // Mounted BEFORE the first paint, not after: the canvas is rendered by the
    // engine's own `RenderWaveForm`, which resolves its target with
    // `getElementById` — an element that is not in the document yet is not
    // findable, and the engine's failure there is a null dereference several
    // frames away from the cause. Measured (on the old side preview): rendering
    // first left it reading `failed` with "Cannot read properties of null".
    lockScroll();
    host.appendChild(overlay);
    panel.focus();
    render();
    // The opening line, once, to the live region (Task 6b: there is no
    // visible status line any more; the hint bar carries the visible next
    // step). It is the keyboard's manual: the lane move and the transition
    // jump are reachable from nowhere a keyboard user can read otherwise,
    // and a one-shot announcement is where such a hint may go (see
    // `sayCursor` for why the per-move announcement may not carry it).
    announce('選一個電位，然後在波形上按住拖過去；或直接按方向鍵進波形，' +
      'Shift+左右鍵選一段，再按電位字元塗上去。' +
      'Alt+↑／Alt+↓ 把選取的 lane 往上下搬；' +
      '武裝關聯線之後，Alt+左右鍵可以在轉態點之間跳。');

    return {
      el: overlay,
      store: store,
      close: close,
      refresh: render,
      lastPatch: function () { return lastPatch; },
      setSaveStatus: setSaveStatus,
    };
  }

  // 編輯器層級的單鍵快捷鍵（關聯線 A、標註 T、快捷鍵卡 ?；比對區分大小寫）。
  // 不得與 BRUSHES 相交——測試守。
  const SHORTCUT_KEYS = ['a', 'A', 't', 'T', '?'];

  return {
    createWaveEditor: createWaveEditor,
    mountedInsideContent: mountedInsideContent,
    BRUSHES: BRUSHES,
    BRUSH_RESIDENT: BRUSH_RESIDENT,
    BRUSH_MORE: BRUSH_MORE,
    isBrushKey: isBrushKey,
    SIZES: SIZES,
    SHORTCUT_KEYS: SHORTCUT_KEYS,
  };
});
