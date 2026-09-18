'use strict';
/*
 * wave-ui — the wavedrom editing surface: the overlay, the hand-drawn waveform,
 * the toolbar, the lane list and the live WaveDrom preview beside it.
 *
 * UMD, the same shape convert-md.js / patchmap.js use: require-able in node so
 * the drawing decisions can be checked without a browser, and injected into the
 * edit page as `window.md2docWaveUi` (lib/editor/server.js). client.js is
 * inlined as a plain <script>, not bundled, so a bare require() here would be
 * undefined in the browser — every dependency arrives as a parameter instead
 * (`opts.codec`, `opts.geometry`, `opts.createStore`, `opts.wavedrom`,
 * `opts.document`, `opts.draw`, `opts.panels`). That is also why this file
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
 *  3. `levelsOf` IS THE ONLY SOURCE OF TRUTH FOR WHAT A CYCLE SHOWS. The
 *     preview beside the drawing exists to catch a disagreement between the
 *     two; if the drawing computed its own levels there would be two beliefs on
 *     screen and the user would have no way to tell which one the file means.
 *     So `brickOf` maps a level to the engine's OWN brick symbol and the
 *     drawing is a rendering of those symbols — see `brickOf`'s comment for the
 *     measurement behind every row of that table.
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
   * clocks — see the arrow measurement in `drawLane`'s isClock branch),
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

  /** Drawing sizes. Handed to `wave-geometry` so the hit test and the paint
   *  cannot drift; nothing here re-derives a row position.
   *
   *  v3.6.0 Task 6: nameColWidth was 0 — the canvas always supported a name
   *  column (`wave-geometry.DEFAULTS` carried 40), the UI was just passing 0.
   *  120px: the canvas needs to say what a lane is called, not lean on the
   *  rail beside it. Task 8 re-measures this against the longest lane name in
   *  the repo's fixtures and may change it — this value is not re-derived
   *  here.
   *
   *  v3.6.0 Task 8 — MEASURED: the longest `name:` fixture across
   *  test/editor-journey.test.js, test/wave-codec.test.js and
   *  test/wave-geometry.test.js is 12 chars (`he said "hi"`). Rendered as an
   *  SVG `<text>` at 11px (`wave-draw.js`'s `.ed-wave-lane-label`) it measures
   *  54.9px in the app's default sans-serif stack and 79.5px in the worst
   *  case tried (monospace) — both comfortably under the 110px a top-level
   *  (depth 0) name gets (`nameColWidth 120 - NAME_GAP 10`), so 120 stays.
   *  See task-8-report.md for the full measurement (puppeteer,
   *  `getComputedTextLength`). */
  const SIZES = { laneHeight: 34, cycleWidth: 48, nameColWidth: 120 };

  /**
   * The index the preview is rendered under, and why it is not 0.
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
   *   wavedrom    `window.WaveDrom` or null; null just means no live preview
   *   onGesture({name, patch, store})  called after EVERY gesture that changed
   *               the document, with that gesture's own patch already computed
   *   onClose(reason)  called once, when the overlay goes away. `reason` is
   *               `'escape'` when the user pressed Escape and `'commit'` for
   *               every other route out (the 關閉 button, or a caller driving
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
    // toolbar/lane-rail/right-hand-panels counterpart to `opts.draw` just
    // above, arriving as a parameter for the identical reason — no shim for
    // a bare `require('./wave-panels.js')` in the browser injection path.
    if (!opts.panels) {
      throw new Error('wave-ui: opts.panels (wave-panels.js\'s createPanels) is required');
    }

    const store = opts.createStore(opts.source);

    /**
     * v3.6.0 Task 13: the 原始碼 panel's whole reason to exist — the exact
     * bytes 保留並關閉 would write right now, not a re-serialisation made
     * for display. The SAME `store.toPatch()` path `afterStoreMoved` already
     * runs after every gesture (`lastPatch`, below), recomputed fresh here
     * rather than reusing that cached value: this can be asked before the
     * very first gesture, while `lastPatch` is still `null`.
     *
     * A refusal is shown as a sentence, not thrown — the same "say what it
     * cannot do" rule `renderUnmodelled` and the unreadable-source panel
     * both already follow, rather than crashing a panel over a state the
     * user can act on (undo one step, or make a smaller change).
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

    const drawer = opts.draw.createDrawer({
      d: d,
      geometry: geometry,
      codec: codec,
      SIZES: SIZES,
      SVGNS: SVGNS,
      BRUSHES: BRUSHES,
      labelsOf: labelsOf,
    });

    const overlay = d.createElement('div');
    overlay.className = 'ed-wave-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', '波形編輯器');

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
    // `laneTo === laneIndex`; only Shift+click on the rail widens it.
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
    // per-row ▲, which Task 14 removed; `moveSelectedLane` now carries the
    // same fact and nominates the moved lane's own name field. The narrative
    // further down about what ▲/▼ USED to do is a record of a past version
    // and is deliberately left as it was.)
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
    // The `edge` array entry the inspector row edits — the codec's ORIGINAL
    // index into `doc.edge`, exactly what `geometry.edgeLayout` reports as
    // `index` (NOT the filtered array position; a dangling entry ahead of it
    // is skipped there and would otherwise shift everything after it out of
    // step). Null means no edge is selected, and that is the whole of the
    // inspector row's visibility rule — see `renderEdgeBar`. `render()`
    // clamps it to null the moment the edge it names stops being drawable
    // (deleted, or its entry no longer parses), so a stale index can never
    // reach `renderEdgeBar` or a shape/label commit.
    let selectedEdge = null;
    // v3.6.0 Task 13 fix round 3: the PREVIOUS render's `selectedEdge`, so
    // `render()` below can tell "just became selected" (null -> a number)
    // apart from "still selected, repainting for some other reason" (a
    // number -> the same or a different number) — see the comment at that
    // check for why the distinction matters.
    let lastSelectedEdge = null;
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
    // The rail's rename field while it is open — this editor's ONE sub-panel,
    // and therefore what the first Escape closes. Before this, Escape typed at
    // a rename field ran `close('escape')` and threw the WHOLE session away,
    // which is the most expensive answer available to「我改名改到一半不想改了」.
    let groupRename = null;
    // v3.5.0 Task 11: the bus data-label field while it is open — this
    // dialog's OTHER sub-panel, same shape as `groupRename` above (a
    // `{cancel, retire}` pair) and layered the same way in `onKeyDown`'s
    // Escape handling. Unlike the rail's rename field, this one's node lives
    // beside the canvas SVG that `renderCanvas` rebuilds on every cursor
    // move, not only on a structural edit — so `retire()` is called from
    // THERE, not only from `render()` (see `renderCanvas`'s own first line).
    let dataEdit = null;

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
        // second, and (above) the conflict banner's own. The rail's rename
        // field is the only sub-panel this editor has, and before this its
        // Escape reached `close('escape')` — which DISCARDS the session. So
        // backing out of a half-typed group name threw away every gesture the
        // user had made, and the one Ctrl+Z that takes a discard back is not
        // something the keystroke announces.
        if (groupRename !== null) { groupRename.cancel(); return; }
        // v3.5.0 Task 11: the bus data-label field, this dialog's OTHER
        // text sub-panel — same layering reason as `groupRename` just
        // above: without this, Escape typed while labelling a bus value
        // discarded the whole editing session instead of just the field.
        if (dataEdit !== null) { dataEdit.cancel(); return; }
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
       * actually sits is the lane's own NAME FIELD — which is where
       * `moveSelectedLane`'s `focusOverride` puts them and keeps them, so
       * Alt+↓ twice moves the same lane twice instead of two different ones.
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
       * No sub-panel gate either. A press taken while the rail's rename
       * field or the bus data-label field is open moves the lane and lets
       * the repaint retire that field, dropping whatever was half-typed in
       * it — exactly what `Ctrl+Z` already does there (see `render()`'s own
       * first line, and `renderCanvas`'s). Both text sub-panels behave the
       * same way and neither wedges the keyboard: `moveSelectedLane` has
       * already written `focusOverride`, so `dataEdit.retire`'s own
       * `focusOverride === null` claim never fires and `restoreFocus` lands
       * on a real element. Standing this gesture behind the sub-panels the
       * way Escape does is a design call this task did not take.
       */
      if (store.ok === true && ev.altKey === true && !ev.ctrlKey && !ev.metaKey &&
          (ev.key === 'ArrowUp' || ev.key === 'ArrowDown' ||
           ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
          moveSelectedLane(ev.key === 'ArrowUp' ? -1 : 1);
          return;
        }
        // Armed only, and it REFUSES OUT LOUD otherwise rather than becoming
        // a silent no-op. `jumpTransition` writes `hoverBoundary`, which
        // `setEdgeMode` documents as meaningful only while 'armed' — a jump
        // taken while idle would leave a hot dot behind that nothing is
        // tracking, and it would light up the moment the user did arm.
        if (edgeMode !== 'armed') {
          panels.say('先按「關聯線」武裝，Alt+←／→ 才有轉態點可以跳');
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
        else panels.say('沒有可以復原的動作');
        return;
      }
      if (key === 'y' || (key === 'z' && ev.shiftKey)) {
        ev.preventDefault();
        ev.stopPropagation();
        if (store.redo()) afterStoreMoved('redo');
        else panels.say('沒有可以重做的動作');
      }
    }
    d.addEventListener('keydown', onKeyDown, true);

    const panel = d.createElement('div');
    panel.className = 'ed-wave-panel';
    // The dialog itself is the initial focus holder — the ARIA pattern's own
    // default, and the one that does not put a highlight on 關閉 the moment the
    // panel opens. `tabindex="-1"` makes it focusable without putting it in the
    // sequential tab order; the first Tab then lands on the first real control.
    panel.setAttribute('tabindex', '-1');
    overlay.appendChild(panel);

    const head = d.createElement('div');
    head.className = 'ed-wave-head';
    const heading = d.createElement('span');
    heading.className = 'ed-wave-title';
    heading.textContent = '波形編輯器';
    head.appendChild(heading);
    // What the two ways out DO, said on screen rather than assumed.
    //
    // Escape is a modal's universal close key and here it DISCARDS: ten minutes
    // of drawing goes, and the one keystroke that brings it back (`Ctrl+Z`) is
    // not something the gesture announces. This batch's own rule — a
    // destructive outcome and a safe one may not both be silent — is the rule
    // behind the drawio「這一頁已經不在了」banner and behind the refusal
    // notices, and it applies to the biggest surface in the product just as
    // much. So the header says which key keeps the work, which key throws it
    // away, and that throwing it away is undoable.
    const escapeHint = d.createElement('span');
    escapeHint.className = 'ed-wave-escape-hint';
    escapeHint.setAttribute('data-wave-escape-hint', '');
    escapeHint.textContent = 'Esc＝放棄這次編輯（按一次 Ctrl+Z 可以拿回來）';
    head.appendChild(escapeHint);
    const closeBtn = d.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ed-wave-close';
    closeBtn.textContent = '關閉';
    closeBtn.title = '保留這次編輯並關閉（Esc 則是放棄）';
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
      return { el: overlay, store: store, close: close, refresh: function () {} };
    }

    overlay.setAttribute('data-wave-state', 'ready');
    // The marks start out addressing the document the store opened with.
    marksDoc = store.doc;

    // ── toolbar ───────────────────────────────────────────────────────────
    //
    // v3.6.0 Task 12: eight captioned `.ed-wave-tool-group` sections
    // (週期/電位/訊號/群組/關聯線/歷史/匯出/檔案) instead of the two flat bars
    // this used to be. See `wave-panels.js`'s `toolGroup()` for why each
    // caption sits to the LEFT of its buttons rather than above them.
    const toolbar = d.createElement('div');
    toolbar.className = 'ed-wave-toolbar ed-wave-tools';
    panel.appendChild(toolbar);

    // v3.6.0 Task 2/12: the toolbar/right-hand-panels/lane-rail factory.
    // Called here, right after `panel` exists, which is BEFORE several
    // elements its OTHER returned functions need (`metaBar`'s own fields,
    // the edge inspector, `laneCol`, the preview host, `status`). `deps` is
    // the same object referenced below at each of those elements' own
    // creation — see `deps.metaBar =` etc. — and `wave-panels.js`'s own
    // header explains why that is not a reorder. `actions` is the callback
    // bag for the `wave-ui.js`-owned state a moved function still needs to
    // read or write; see that same header for what each entry is for and
    // why `close` is not among them (nothing that moved calls it).
    const deps = {
      d: d,
      geometry: geometry,
      codec: codec,
      SIZES: SIZES,
      actions: {
        commit: commit,
        render: render,
        selectionSet: function (value) { selection = value; },
        focusOverrideGet: function () { return focusOverride; },
        focusOverrideSet: function (key) { focusOverride = key; },
        groupRenameGet: function () { return groupRename; },
        groupRenameSet: function (value) { groupRename = value; },
        sourceText: sourceText,
      },
      overlay: overlay,
      panel: panel,
      PREVIEW_INDEX: PREVIEW_INDEX,
      PREVIEW_ID_PREFIX: PREVIEW_ID_PREFIX,
      wavedrom: opts.wavedrom,
    };
    const panels = opts.panels.createPanels(deps);

    // v3.6.0 Task 15: the shared `NOT_YET_WIRED` title that used to stand
    // here went out with its last three holders — 匯出's SVG / PNG /
    // 複製 WaveJSON. Every button this toolbar builds now does something,
    // and nothing is created disabled to make a section's shape look real.

    // ── 週期 ──────────────────────────────────────────────────────────────
    const cycleGroup = panels.toolGroup('週期');
    toolbar.appendChild(cycleGroup);
    panels.toolButton('ed-wave-cycle-insert', '插入 cycle',
      '在選取的位置插入一個 cycle（每一條 lane 同時加寬，不會有人掉隊）', function () {
        const at = selection === null ? 0 : Math.min(selection.from, selection.to);
        commit('insert-cycle', function (doc) { return codec.insertCycles(doc, at, 1); });
      }, cycleGroup);
    panels.toolButton('ed-wave-cycle-delete', '刪除 cycle',
      '刪掉選取的 cycle（每一條 lane 同時變窄）', function () {
        if (selection === null) { panels.say('先選一段 cycle 再刪'); return; }
        const from = Math.min(selection.from, selection.to);
        const count = Math.abs(selection.to - selection.from) + 1;
        commit('delete-cycle', function (doc) { return codec.deleteCycles(doc, from, count); });
      }, cycleGroup);
    panels.toolButton('ed-wave-cycle-copy', '複製',
      '把選取的 cycle 從每一條 lane 上拷一份', function () {
        if (selection === null) { panels.say('先選一段 cycle 再複製'); return; }
        const from = Math.min(selection.from, selection.to);
        const count = Math.abs(selection.to - selection.from) + 1;
        clip = codec.copyCycles(store.doc, from, count);
        panels.say('複製了 ' + count + ' 個 cycle');
        render();
      }, cycleGroup);
    panels.toolButton('ed-wave-cycle-paste', '貼上（插入）',
      '把剪貼簿插進選取的位置', function () { pasteAt('insert'); }, cycleGroup);
    panels.toolButton('ed-wave-cycle-paste-over', '貼上（覆蓋）',
      '用剪貼簿蓋掉選取位置起算的那幾個 cycle', function () { pasteAt('overwrite'); }, cycleGroup);

    function pasteAt(mode) {
      if (clip === null) { panels.say('剪貼簿是空的'); return; }
      const at = selection === null ? 0 : Math.min(selection.from, selection.to);
      commit('paste-' + mode, function (doc) {
        return codec.pasteCycles(doc, at, clip, mode);
      });
    }

    // ── 電位 ──────────────────────────────────────────────────────────────
    //
    // v3.6.0 Task 12: this section WRAPS the existing brush bar — the 22
    // brush buttons are still built inline by this same loop, with
    // `drawer.levelIcon` glyphs (Task 10) — `panels.toolButton` is not used
    // for them, so only the container they land in is new here.
    const brushGroup = panels.toolGroup('電位');
    toolbar.appendChild(brushGroup);
    const brushBar = d.createElement('div');
    brushBar.className = 'ed-wave-brushes';
    brushGroup.appendChild(brushBar);
    const brushButtons = [];
    for (const ch of BRUSHES) {
      const b = d.createElement('button');
      b.type = 'button';
      b.className = 'ed-wave-brush';
      b.setAttribute('data-brush', ch);
      b.setAttribute('data-focus-key', 'brush-' + ch);
      // v3.6.0 Task 10: the glyph is built by `drawer.levelIcon` — the SAME
      // brick-drawing code `renderCanvas` paints the diagram with, not a
      // second hand-drawn set (see wave-draw.js's own `levelIcon` comment).
      // `panels.toolButton` is NOT used for these buttons: brush buttons are
      // built here, inline, not through that helper, so wiring the icon
      // where `toolButton` lives would put glyphs on the cycle-operation
      // buttons instead and leave every brush bare. The character stays on
      // the button too, as a caption next to the icon rather than instead
      // of it — a user who already knows the wavedrom letter should not
      // have to relearn a picture-only toolbar.
      b.appendChild(drawer.levelIcon(ch));
      const cap = d.createElement('span');
      cap.className = 'ed-wave-brush-char';
      cap.textContent = ch;
      b.appendChild(cap);
      b.addEventListener('click', function () {
        brush = ch;
        paintBrushState();
      });
      brushBar.appendChild(b);
      brushButtons.push(b);
    }
    /**
     * The toolbar sections that act on `selection`, repainted from it.
     *
     * v3.6.0 Task 14. Called from `render()`, from `repaintDrawing()`, and
     * from every INLINE `drawer.renderCanvas` site in this file — which is
     * not a set of duplicate calls. `render()` is the slow path; every other
     * one of them both writes `selection` and reads it back out of the
     * drawer's own clamp, and none of them rebuilds the toolbar. Wired only
     * into `render()`, these buttons kept whatever state the LAST full
     * repaint left them in.
     *
     * Two rescues used to hide most of that, and fix round 1 is the gesture
     * where both are shut at once:
     *
     *   - `onCanvasUp`'s `commit('paint', …)` re-renders — but `commit`
     *     returns false without calling `afterStoreMoved` when the gesture
     *     changed nothing, and pressing a cell that already holds the
     *     brush's own value changes nothing.
     *   - `onCanvasDown`'s `canvas.focus()` fires the drawer-wired
     *     `enterDrawing` → `repaintDrawing` — but only when the canvas did
     *     not already have the keyboard, i.e. never on the second press in
     *     a row.
     *
     * MEASURED, both symptoms: (a) open the dialog (no selection, 刪除
     * disabled), walk to a lane with the arrow keys, and 刪除 was still
     * disabled although the lane was selected and highlighted on both the
     * rail and the canvas; (b) press req's cycle 2, then ack's cycle 4 —
     * `data-insert-at`/`data-lands-in` stayed on 2/`bus` while the button,
     * which reads the LIVE `selection`, would have inserted at 4 outside
     * every group. (b) is the worse of the two: it is this task's own
     * contract — the button says which container it is about to use BEFORE
     * it is pressed — broken by the button itself.
     *
     * So it is called at every writer of the state it paints, not at the
     * one whose symptom was reported. The rail's own `.is-selected` is a
     * separate, pre-existing staleness on those same inline paths (they do
     * not call `panels.renderLanes` either) and is deliberately NOT fixed
     * here.
     *
     * 新增 and 空白列 stay enabled with nothing selected — that case has a
     * real answer of its own (position 0; see `signalInsertAt`) — and they
     * publish WHERE the insert lands before they are pressed, which is the
     * property the rail's per-row ＋ used to carry in `data-lands-in` and
     * its tooltip. The other three need a lane named, and 解散群組 needs
     * that lane to be inside a group; a button that looks pressable and
     * then answers「先選一條 lane」is the affordance this batch is
     * removing, not reproducing.
     */
    function paintSelectionState(doc, layout) {
      const insertAt = signalInsertAt(layout);
      const insertLanding = panels.landingOf(doc, insertAt);
      const insertWhere = insertLanding.title === null
        ? '群組外' : '群組「' + insertLanding.title + '」裡';
      for (const b of [signalAddBtn, signalBlankBtn]) {
        b.setAttribute('data-insert-at', String(insertAt));
        b.setAttribute('data-lands-in',
          insertLanding.title === null ? '' : insertLanding.title);
      }
      signalAddBtn.title = '在選取的 lane 後面加一條（沒有選取就加在最前面）—— 會落在' + insertWhere;
      signalBlankBtn.title = '在選取的 lane 後面插入一個空白列（WaveJSON 的 {}，' +
        '用來空出間距；刪除跟刪一般的 lane 一樣）—— 會落在' + insertWhere;
      signalDeleteBtn.disabled = selection === null;
      signalCopyBtn.disabled = selection === null;
      groupBtn.disabled = selection === null || selection.laneTo === selection.laneIndex;
      groupDissolveBtn.disabled = selection === null ||
        !laneIsInGroup(layout, selection.laneIndex);
      overlay.setAttribute('data-wave-lane-range', selection === null ? ''
        : selection.laneIndex + ',' + selection.laneTo);
    }

    function paintBrushState() {
      for (const b of brushButtons) {
        b.classList.toggle('is-on', b.getAttribute('data-brush') === brush);
      }
      overlay.setAttribute('data-wave-brush', brush);
    }

    // ── 訊號 ──────────────────────────────────────────────────────────────
    //
    // v3.6.0 Task 14: these four came off the lane rail, where every row
    // carried its own copy and none of them fit (see `wave-panels.js`'s
    // `laneRow`). One copy each, here, acting on `selection` — the same mark
    // the 週期 section and the brushes read, not a second one kept only for
    // them.
    //
    // WHERE an insert lands is `laneInsertPath`'s asymmetry and cannot be
    // argued away: an insert at a group's first lane joins that group, an
    // insert just past its last lane does not. So the button says which
    // container it is about to use BEFORE it is pressed — `data-lands-in`
    // and the tooltip, both refreshed by `paintSelectionState` below on
    // every repaint, full or fast — and the status line says it again
    // after. That is the property the rail's per-row ＋ used to carry,
    // moved rather than dropped.
    const signalGroup = panels.toolGroup('訊號');
    toolbar.appendChild(signalGroup);

    /**
     * Where 新增 / 空白列 put their new lane: right after the selection, and
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
        ? geometry.layoutOf(store.doc, SIZES) : layout;
      if (selection === null) return 0;
      return Math.min(selection.laneTo + 1, l.lanes.length);
    }

    function addLaneFromToolbar(name, lane) {
      const at = signalInsertAt();
      const landing = panels.landingOf(store.doc, at);
      const where = landing.title === null ? '群組外' : '群組「' + landing.title + '」裡';
      // Straight into the new lane's own name field — it is what the user
      // types next, and on a spacer (no name to type) there is nothing
      // else on that row to land on either. The lane arrives at display
      // position `at`, so that is the key.
      focusOverride = 'lane-name-' + at;
      const added = commit(name, function (doc2) { return codec.addLane(doc2, at, lane); });
      // fix round 1 (F6): the whole prefix per branch, not one concatenation
      // with a shared 落在. The two bases this replaced differ by exactly one
      // space — `say('新增的 lane 落在' + …)` has it because the phrase ends
      // in a Latin word (so does 複製's message further down), and
      // `say('空白列落在' + …)` does not because it ends in a CJK one. A
      // single shared suffix has to get one of them wrong.
      const lead = lane.wave === undefined ? '空白列落在' : '新增的 lane 落在';
      if (added) panels.say(lead + where);
    }

    const signalAddBtn = panels.toolButton('ed-wave-signal-add', '新增',
      '在選取的 lane 後面加一條（沒有選取就加在最前面）', function () {
        addLaneFromToolbar('add-lane', { name: '', wave: 'x' });
      }, signalGroup);
    // v3.5.0 Task 13: WaveDrom's own blank row, `{}`. There is deliberately
    // no dedicated "remove spacer" control: a spacer is a lane like any
    // other, so 刪除 below removes it exactly as it removes anything else.
    const signalBlankBtn = panels.toolButton('ed-wave-signal-blank', '空白列',
      '在選取的 lane 後面插入一個空白列（WaveJSON 的 {}，用來空出間距；刪除跟刪一般的 lane 一樣）',
      function () { addLaneFromToolbar('add-spacer', {}); }, signalGroup);
    const signalDeleteBtn = panels.toolButton('ed-wave-signal-delete', '刪除',
      '刪掉選取的那幾條 lane（如果群組因此空掉，群組也會一起走）', function () {
        if (selection === null) { panels.say('先選一條 lane 再刪'); return; }
        const lo = selection.laneIndex;
        const hi = selection.laneTo;
        const n = hi - lo + 1;
        // The rows about to stop existing are exactly the ones the marks
        // name, so the selection goes FIRST — a selection naming cycles on
        // a lane that is about to disappear is stale the instant `commit`
        // runs, and that staleness is what `carryMarks` exists to prevent
        // everywhere else.
        selection = null;
        // The rows about to vanish are also where the keyboard is allowed to
        // land, and the button the user pressed is about to disable itself
        // (no selection left), so naming a destination here is not a nicety:
        // `restoreFocus`'s fallback would otherwise be a disabled button.
        // Display position `lo` is whatever lane inherits the place the
        // deleted range occupied — on a document emptied down to nothing the
        // key simply is not there and `restoreFocus` falls back to the
        // dialog, which is the right answer for「there is no row left」.
        focusOverride = 'lane-name-' + lo;
        // Bottom-up: every removal renumbers the rows BELOW it, so taking
        // the highest index first leaves the ones still to go untouched.
        //
        // fix round 1: an earlier draft of this comment claimed a top-down
        // loop would delete a DIFFERENT set of lanes. It would not, and the
        // claim is withdrawn rather than reworded — checked against the
        // codec over five ranges, group-spanning ones included: deleting
        // `lo` n times and deleting hi..lo give the identical document,
        // because whatever shifts into `lo` is the next member of a
        // CONTIGUOUS range. What bottom-up actually buys is that each index
        // still means the lane it meant when the range was measured, so the
        // loop stays correct if a range that is not contiguous ever reaches
        // it; top-down would be silently relying on the contiguity.
        const removed = commit('remove-lane', function (doc2) {
          let out = doc2;
          for (let k = hi; k >= lo; k -= 1) out = codec.removeLane(out, k);
          return out;
        });
        if (removed) panels.say('已刪掉 ' + n + ' 條 lane —— Ctrl+Z 可以拿回來');
      }, signalGroup);
    const signalCopyBtn = panels.toolButton('ed-wave-signal-copy', '複製',
      '複製選取的 lane，接在它後面（data 等欄位一起複製；node 錨點不會跟著複製，' +
      '避免兩條 lane 搶同一個字母）', function () {
        if (selection === null) { panels.say('先選一條 lane 再複製'); return; }
        // One lane, the range's first: `duplicateLane` copies one lane and
        // lands it at `at + 1`, and a loop over a range would interleave
        // each copy with the original it renumbers. The range's own far end
        // is left alone rather than guessed at.
        const at = selection.laneIndex;
        const landing = panels.landingOf(store.doc, at + 1);
        const where = landing.title === null ? '群組外' : '群組「' + landing.title + '」裡';
        focusOverride = 'lane-name-' + (at + 1);
        const didDup = commit('duplicate-lane', function (doc2) {
          return codec.duplicateLane(doc2, at);
        });
        if (didDup) panels.say('複製的 lane 落在' + where);
      }, signalGroup);

    /**
     * v3.6.0 Task 16: move the selected lane one row up (`step === -1`) or
     * down (`step === 1`) — the keyboard's half of the rail handle's drag,
     * reached by Alt+↑ / Alt+↓ in `onKeyDown`.
     *
     * ONE lane, the range's first, exactly as 複製 just above: `moveLane`
     * moves one lane, and a loop over a range would renumber each member out
     * from under the next. The range's far end is collapsed rather than
     * guessed at, so what moved and what is selected afterwards are the same
     * one lane.
     *
     * Both ends of the list REFUSE OUT LOUD instead of silently doing
     * nothing. A key that does nothing and says nothing is, to the person
     * pressing it, indistinguishable from a key this dialog never bound —
     * and the status line is where every other refusal in here already goes.
     *
     * WHERE THE MARKS END UP. They are collapsed onto the moved lane BEFORE
     * the commit, at its OLD row, and `carryMarks` — this file's single
     * mechanism for "a mark follows its lane", by lane identity through
     * `wave-store.laneTrace` — is what carries them to the new row.
     * Re-pointing them by hand afterwards would cost a second `render()`
     * (the one inside `commit` has already run and already consumed
     * `focusOverride`) and would stand a second belief about where the lane
     * went beside the trace's, which is the shape of defect this batch has
     * paid for repeatedly. MEASURED in a real browser on the journey
     * fixture, both from the trace alone: Alt+↓ on the lane selected at row
     * 0 with no cell cursor yet took `data-wave-lane-range` 0,0 → 1,1 and
     * left `data-wave-cursor` empty (no cursor is invented for a gesture
     * that never entered the drawing); Alt+↑ with the cell cursor sitting on
     * the moved lane at row 2 took `data-wave-cursor` 2,0 → 1,0 and
     * `data-wave-lane-range` 2,2 → 1,1.
     *
     * The invariant 訊號's 刪除 quietly depends on — a non-null `selection`
     * always names a lane that exists, so its `commit` always returns true —
     * survives every exit here. The two refusals leave `selection` exactly
     * as they found it. The commit path writes `{laneIndex: at, laneTo: at}`
     * with `at` an index `renderCanvas`'s clamp has already vouched for, and
     * a move changes no lane's EXISTENCE, so whether `carryMarks` then
     * traces it to `to` (both ends of a collapsed range trace together) or
     * drops it to null for want of an injected `laneTrace`, what is left is
     * either a real row or nothing at all — never a row number with no lane
     * under it.
     */
    function moveSelectedLane(step) {
      if (selection === null) { panels.say('先選一條 lane 再搬'); return; }
      const layout = geometry.layoutOf(store.doc, SIZES);
      const at = selection.laneIndex;
      const to = at + step;
      if (to < 0) { panels.say('這已經是第一條 lane 了，沒有更上面的位置'); return; }
      if (to >= layout.lanes.length) {
        panels.say('這已經是最後一條 lane 了，沒有更下面的位置');
        return;
      }
      selection = { laneIndex: at, laneTo: at, from: selection.from, to: selection.to };
      // The lane arrives at row `to`, so the keyboard goes to the field it
      // arrives in — the same rule the rail's own `drop` handler follows,
      // and the whole reason `focusOverride` exists (see its declaration).
      focusOverride = 'lane-name-' + to;
      const didMove = commit('move-lane', function (doc2) {
        return codec.moveLane(doc2, at, to);
      });
      // v3.6.0 Task 16 fix round 1: SAY WHICH CONTAINER IT LANDED IN.
      //
      // `moveLane` may cross a group boundary — `laneInsertPath`'s asymmetry,
      // which the whole 訊號 section already announces before and after every
      // insert. MEASURED against the real codec on the journey fixture:
      // Alt+↓ on `clk` at row 0 moves it INTO the group `bus`
      // (`["clk",["bus",…]]` → `[["bus",["req","clk","dat"]],…]`), and the
      // flattened name order is the only thing that changes on screen. Before
      // this, the single word the user got back was `afterStoreMoved`'s
      // generic「已寫回：move-lane」, so the one case in this function that
      // re-parents a lane was also its quietest — while BOTH refusals spoke.
      //
      // Asked of the document AFTER the move, unlike 複製 above, which asks
      // before because its lane does not exist yet. `laneInsertPath(doc, to)`
      // means "in front of whichever lane sits at `to`, in THAT lane's own
      // container", and after the move the lane at `to` is the moved one — so
      // its answer is the moved lane's own container, including the
      // group's-first-lane edge. Verified against the codec for all four
      // moves the journey scenario makes: bus / 群組外 / bus / bus.
      //
      // ONE shared lead — `'搬動的 lane 落在'` — with only the container name
      // branching. That is what the line below does, and the whole of what it
      // needs to do.
      //
      // fix round 2 (N2) WITHDRAWS the claim that stood here ("the whole
      // prefix per branch rather than one shared 落在, the same rule
      // 新增/空白列 above record"), which said the opposite of the code
      // directly beneath it. That rule exists because 新增 and 空白列 are TWO
      // gestures sharing ONE handler whose leads differ by a space —
      // `'新增的 lane 落在'` ends in a Latin word, `'空白列落在'` in a CJK one
      // — and this function has no such axis: one gesture, one lead. The
      // space after `lane` here is that typographic rule on its own, and the
      // 群組外 / 群組「…」裡 tail is the identical two-way split 複製 uses.
      if (didMove) {
        const landing = panels.landingOf(store.doc, to);
        panels.say('搬動的 lane 落在' +
          (landing.title === null ? '群組外' : '群組「' + landing.title + '」裡'));
      }
    }

    // ── 群組 ──────────────────────────────────────────────────────────────
    const groupGroup = panels.toolGroup('群組');
    toolbar.appendChild(groupGroup);
    // Wrap the selected lane range into one new group. The codec is the one
    // that decides contiguity — this button does not pre-filter what is
    // selectable, it only decides whether there is enough of a selection to
    // bother trying, so the refusal message the user actually needed
    // ("these lanes are not next to each other") comes from `commit`'s own
    // status line rather than being silently swallowed here.
    //
    // v3.6.0 Task 14: the range is `selection`'s, not a second mark's — so
    //「選起來的那幾條」names the same highlight the canvas and the Lane
    // panel are showing, rather than a second one only this button could
    // see. Shift+click on the rail is the one gesture that WIDENS it;
    // Shift+↑/↓ on the canvas still collapses onto the lane it lands on
    // (see `moveCursor`), which is why the tooltip names the rail and not
    // the keyboard.
    //
    // The group is created with an EMPTY label and the rename field is
    // opened immediately — the same affordance 新增 gives a brand new lane
    // (empty `name`, keyboard straight into the field) — rather than a
    // placeholder string the user has to notice and clear.
    const groupBtn = panels.toolButton('ed-wave-group-make', '建立群組',
      '把選起來的那幾條連續 lane 包成一個新群組（在左邊的 lane 列表上 Shift+點選一段）',
      function () {
        if (selection === null || selection.laneTo === selection.laneIndex) {
          panels.say('先選至少兩條連續的 lane，才有東西可以群組');
          return;
        }
        const ats = [];
        for (let k = selection.laneIndex; k <= selection.laneTo; k += 1) ats.push(k);
        const minAt = ats[0];
        const committed = commit('group-lanes', function (doc2) {
          return codec.groupLanes(doc2, ats, '');
        });
        if (!committed) {
          panels.say('這幾條 lane 不連續（或選取已經失效），WaveJSON 的群組只能是連續的一段');
          return;
        }
        // The commit above already repainted with the (now stale) highlight
        // showing; one more repaint clears it before handing the keyboard to
        // the rename field, the same two-step `renameGroup` itself already
        // is — a rebuild first, then the sub-panel laid over what it built.
        selection = null;
        render();
        const layout = geometry.layoutOf(store.doc, SIZES);
        const spans = geometry.groupSpansOf(store.doc, layout);
        for (const span of spans) {
          if (span.from === minAt) { panels.renameGroup(span); break; }
        }
      }, groupGroup);
    // v3.6.0 Task 14: 解散 the group the selected lane is a DIRECT member
    // of. The lanes it held stay exactly where they were; only the wrapping
    // array and its title go. `ungroupLanes`'s own docstring explains why
    // "direct" is the only thing a display position can name — and why a
    // group built entirely out of sub-groups therefore has no lane that
    // names it, which is exactly the case `laneIsInGroup` below reports as
    // "nothing to dissolve here" by disabling this button.
    const groupDissolveBtn = panels.toolButton('ed-wave-group-dissolve', '解散群組',
      '解散選取的 lane 所屬的那個群組（裡面的 lane 都留著，只是不再是一組）', function () {
        if (selection === null) { panels.say('先選一條群組裡的 lane'); return; }
        const at = selection.laneIndex;
        // The lane at `at` survives ungrouping at the same display position
        // (`ungroupLanes`: the flattened order and count never change), so
        // its own name field is exactly where the keyboard should land.
        focusOverride = 'lane-name-' + at;
        const done = commit('ungroup', function (doc2) { return codec.ungroupLanes(doc2, at); });
        if (!done) panels.say('這條 lane 不在任何群組裡');
      }, groupGroup);

    /**
     * Whether display position `at` is a direct member of some group —
     * `ungroupLanes`'s own precondition, asked of the layout rather than
     * re-derived. A lane sitting straight under `signal` has a path of
     * length 2 (`['signal', k]`); anything longer is inside at least one
     * group.
     */
    function laneIsInGroup(layout, at) {
      if (at < 0 || at >= layout.lanes.length) return false;
      return layout.lanes[at].path.length > 2;
    }
    // ── 關聯線 ────────────────────────────────────────────────────────────
    const edgeGroup = panels.toolGroup('關聯線');
    toolbar.appendChild(edgeGroup);
    // v3.5.0 Task 7: arm the edge-creation gesture. One-shot in the sense
    // that a drag which PRODUCES an edge disarms it (`finishEdgeDrag` below);
    // pressing the button itself is a plain toggle, so a change of mind
    // before ever pressing on the canvas costs one more click, not Escape.
    const edgeBtn = panels.toolButton('ed-wave-edge-arm', '關聯線',
      '按一下武裝，然後從一格拖到另一格畫出關聯線（Escape 取消）', function () {
        setEdgeMode(edgeMode === 'idle' ? 'armed' : 'idle');
        // v3.6.0 Task 11: the transition dots (and their removal) are the
        // only on-canvas evidence arming happened — `setEdgeMode` above
        // only touches the button/overlay attributes, so without this the
        // dots would not appear until some OTHER repaint happened to run
        // first (the next cursor move, say), which is not "the instant you
        // press the button".
        render();
      }, edgeGroup);
    setEdgeMode('idle');

    // ── 歷史 ──────────────────────────────────────────────────────────────
    const historyGroup = panels.toolGroup('歷史');
    toolbar.appendChild(historyGroup);
    const undoBtn = panels.toolButton('ed-wave-undo', '復原', '退回上一個動作', function () {
      if (!store.undo()) { panels.say('沒有可以復原的動作'); return; }
      afterStoreMoved('undo');
    }, historyGroup);
    const redoBtn = panels.toolButton('ed-wave-redo', '重做', '再做一次剛剛復原掉的動作', function () {
      if (!store.redo()) { panels.say('沒有可以重做的動作'); return; }
      afterStoreMoved('redo');
    }, historyGroup);

    // ── 匯出 ──────────────────────────────────────────────────────────────
    //
    // v3.6.0 Task 15: the three buttons Task 12 created as shape.
    //
    // THE SOURCE IS THE PREVIEW'S SVG, never the canvas. The preview is the
    // ENGINE'S OWN OUTPUT, so what a user exports is the same picture the
    // rendered document shows; exporting the canvas would export this file's
    // second implementation of that picture — the one precondition 3 in this
    // module's header exists to stop from becoming a second belief on screen.
    //
    // Every browser global the three need — `XMLSerializer`, `Blob`, `URL`,
    // `Image`, `setTimeout`, `navigator` — is reached through `probeWin`
    // (`d.defaultView`, declared beside `sourceText` above), never as a bare
    // identifier: this file is require-able in node against a fake
    // `opts.document` (see its header) and names no global of its own.

    /**
     * The preview's SVG, serialised so that it still draws OUTSIDE this page.
     *
     * The plain `serializeToString(svg)` that this obviously wants to be is a
     * trap, and a quiet one. `renderPreview` renders with `notFirstSignal`
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
     * So: clone the preview, and if the clone has no `<defs>` of its own,
     * prepend a CLONE of the page skin's `<style>` and `<defs>`.
     */
    function exportSvgText() {
      const host = deps.previewHost;
      const svg = (host === null || host === undefined) ? null : host.querySelector('svg');
      if (svg === null || svg === undefined) return '';
      const clone = svg.cloneNode(true);
      if (clone.querySelector('defs') === null) {
        // `#socket` is the skin's own first entry, asked for INSIDE a
        // WaveDrom-rendered SVG's defs — the identical question, asked the
        // identical way, that `renderPreview` asks to decide whether to emit a
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
      if (text === '') { panels.say('預覽還沒畫出來，沒有東西可以匯出'); return; }
      downloadBlob(new probeWin.Blob([text], { type: 'image/svg+xml' }), exportName('svg'));
      panels.say('已匯出 ' + exportName('svg'));
    }

    function exportPng() {
      const text = exportSvgText();
      if (text === '') { panels.say('預覽還沒畫出來，沒有東西可以匯出'); return; }
      const svg = deps.previewHost.querySelector('svg');
      const w = Number(svg.getAttribute('width'));
      const h = Number(svg.getAttribute('height'));
      // A zero-sized canvas is not an error to `toBlob`: it hands back a
      // perfectly valid, perfectly empty PNG. Refuse it in words rather than
      // let the user save a file that is a picture of nothing.
      if (!(w > 0) || !(h > 0)) {
        panels.say('預覽的尺寸讀不出來，PNG 匯不出去');
        return;
      }
      const img = d.createElement('img');
      img.onload = function () {
        const cv = d.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx2 = cv.getContext('2d');
        // The SVG's own background rect is white, but only over its own box;
        // painting white first means a PNG dropped into a dark-themed document
        // does not show that document's background through the margins.
        ctx2.fillStyle = '#ffffff';
        ctx2.fillRect(0, 0, w, h);
        ctx2.drawImage(img, 0, 0);
        cv.toBlob(function (blob) {
          if (blob === null) { panels.say('PNG 轉檔失敗'); return; }
          downloadBlob(blob, exportName('png'));
          panels.say('已匯出 ' + exportName('png'));
        }, 'image/png');
      };
      img.onerror = function () { panels.say('PNG 轉檔失敗'); };
      // A data URI, not an object URL: an SVG loaded into an `<img>` renders
      // in the browser's secure static mode either way, and a data URI needs
      // no revoke to pair with it on a path that can end in `onerror`.
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
    }

    function exportJson() {
      // `sourceText()`, not a second serialisation: this is the same walk of
      // `store.toPatch()` that the 原始碼 panel shows and that 保留並關閉
      // would write, so what lands on the clipboard can never disagree with
      // either of them.
      const text = sourceText();
      const clip = probeWin.navigator && probeWin.navigator.clipboard;
      if (clip && typeof clip.writeText === 'function') {
        clip.writeText(text).then(function () {
          panels.say('WaveJSON 已複製到剪貼簿');
        }, function () {
          panels.say('複製失敗，可以從右欄的原始碼面板手動選取');
        });
        return;
      }
      panels.say('這個瀏覽器不給用剪貼簿，可以從右欄的原始碼面板手動選取');
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

    const exportGroup = panels.toolGroup('匯出');
    toolbar.appendChild(exportGroup);
    panels.toolButton('ed-wave-export-svg', 'SVG',
      '把預覽那張圖存成 SVG 檔（含 WaveDrom 的 skin，離開這一頁也畫得出來）',
      exportSvg, exportGroup);
    panels.toolButton('ed-wave-export-png', 'PNG',
      '把預覽那張圖存成 PNG 檔（白底，尺寸跟預覽一樣）',
      exportPng, exportGroup);
    panels.toolButton('ed-wave-export-wavejson', '複製 WaveJSON',
      '把右欄原始碼面板上那份 WaveJSON 複製到剪貼簿',
      exportJson, exportGroup);

    // ── 檔案 ──────────────────────────────────────────────────────────────
    //
    // v3.6.0 Task 12: both wired now, unlike every disabled section above —
    // neither waits on a later task. 保留並關閉 runs the SAME commit path the
    // header's 關閉 button already runs (`close('commit')`); 放棄 is new:
    // before this, discarding an edit was keyboard-only (Escape), so a
    // pointer user had no way to abandon one. `close`'s own contract makes
    // "anything that is not `'escape'` is a commit" the default, so wiring
    // 放棄 is one line.
    const fileGroup = panels.toolGroup('檔案');
    toolbar.appendChild(fileGroup);
    panels.toolButton('ed-wave-file-close', '保留並關閉',
      '保留這次編輯並關閉（跟標題列的「關閉」是同一個動作）', function () {
        close('commit');
      }, fileGroup);
    panels.toolButton('ed-wave-file-discard', '放棄',
      '放棄這次編輯（跟 Esc 是同一個動作；按一次 Ctrl+Z 可以拿回來）', function () {
        close('escape');
      }, fileGroup);

    // head / foot / hscale — the document-level fields the 文件 panel
    // exposes, plus (below, in the Lane panel) a per-lane period/phase.
    //
    // v3.6.0 Task 8 fix round 2: the sentence that used to stand here —
    // "the drawing does not model `hscale`, `period` or `phase` at all
    // (zero occurrences in wave-codec, wave-geometry or this file)" — went
    // false at Task 4 and nobody caught it until a review two tasks later.
    // `wave-geometry.js`'s `layoutOf` reads a lane's own `period`/`phase`
    // into `originX`/`cycleWidth`, and `hscaleOf(cfg)` reads `config.hscale`
    // globally; `wave-draw.js` uses those per-lane values for every brick's
    // x-coordinate. That is real modelling, not zero occurrences.
    //
    // v3.6.0 Task 9 fix round 2 (ruling R30) then closed the half that was
    // still open when the paragraph above was written: the shared cycle grid
    // and the ruler are DIAGRAM-wide and now derive from the same
    // `hscale`-scaled diagram pitch the bricks are painted at, so they move
    // with `period` and `config.hscale` too. `test/wave-draw.test.js` pins
    // both fixtures value-by-value against the engine's own render —
    // `period: 4` draws the engine's 17 ticks (0..16), not `cycles + 1`;
    // `hscale: 2` draws them 96 apart (48 × 2), the case whose tick COUNT is
    // unchanged and whose pitch is the only tell.
    //
    // So as of Task 18 `panels.renderUnmodelled()` no longer fires for any of
    // the three: they are modelled, and saying otherwise is now the false
    // statement. See that function's own block comment.
    //
    // v3.6.0 Task 13: a CONTROL for these three is back — `config.hscale`
    // here, `period`/`phase` in the Lane panel below — because what made
    // shipping one "the worst of the three options" (see the Task 8 comment
    // this replaces) was a control that INVITES the two pictures to
    // disagree while showing a confident wrong one. Relocating the fields
    // into named, individually-labelled panel rows does not change that risk
    // by itself. What closed it is Tasks 4 and 9 actually MODELLING the
    // three — in `wave-geometry.js`'s `layoutOf`/`hscaleOf` and
    // `wave-draw.js`'s diagram pitch, the one place cycle geometry is
    // allowed to live, so this file never grew a second belief about it.
    // A control that sets a value the canvas then draws is not the failure
    // the Task 8 comment was guarding against.
    const headInput = panels.metaField(
      'ed-wave-head-text', 'head', '上方標題', 'head.text', panels.sections.document);
    const headTickInput = panels.metaField('ed-wave-head-tick', 'head.tick',
      '起始刻度，例如 0', 'head.tick', panels.sections.document);
    const headTockInput = panels.metaField('ed-wave-head-tock', 'head.tock',
      '半格刻度起始值，例如 0', 'head.tock', panels.sections.document);
    const headEveryInput = panels.metaField('ed-wave-head-every', 'head.every',
      '每幾格顯示一次刻度', 'head.every', panels.sections.document);
    const footInput = panels.metaField(
      'ed-wave-foot-text', 'foot', '下方標題', 'foot.text', panels.sections.document);
    // v3.5.0 Task 13, fix round 1: the ruler fields — the COMPLETE set, not
    // the three Task 13's own brief happened to name. Measured directly
    // against the pinned engine rather than recalled: `renderMarks` in
    // `node_modules/wavedrom/lib/render-marks.js` calls
    // `ticktock(lane, 'head', 'tick', ...)`, `ticktock(lane, 'head', 'tock',
    // ...)`, `ticktock(lane, 'foot', 'tick', ...)` and
    // `ticktock(lane, 'foot', 'tock', ...)` — all four, not just
    // `head.tick`/`foot.tock` — and inside `ticktock` itself,
    // `cxt[ref1].every` is read off whichever of `head`/`foot` `ref1` is, so
    // `every` applies under BOTH, not only `head`. That is eight keys —
    // `{head, foot} × {text, tick, tock, every}` — of which the first Task
    // 13 round shipped five (`head.text`/`foot.text` from v3.4.0, plus
    // `head.tick`/`head.every`/`foot.tock`). The three missing ones
    // (`head.tock`/`foot.tick`/`foot.every`) are added here so the set is
    // complete rather than an arbitrary subset a user cannot predict — "why
    // can I put a tick above the diagram but not below it" is exactly the
    // shape of bug five-of-eight invites.
    //
    // Labels are the literal WaveJSON PATH (`head.tick`, not bare `tick`),
    // not just the leaf key the first round used — with only one of
    // tick/tock/every ever existing under `head` (and the mirror one under
    // `foot`), a bare leaf label could not be confused for its sibling; with
    // all four now under both, `tick` alone would leave two fields on screen
    // both labelled `tick` with no way to tell which of them draws above the
    // diagram and which below. `head`/`foot` on the two `.text` fields stay
    // bare, since those never had a same-named sibling to begin with.
    // Grouped head-then-foot in DOM order (four fields, then four fields)
    // rather than the first round's ad hoc growth order, for the same
    // readability reason. v3.6.0 Task 13: head/tick/tock/every are now
    // created ABOVE, before `footInput`, so the document panel's DOM order
    // is the full `head.*` group followed by the full `foot.*` group —
    // `test/editor-journey.test.js`'s five-panel scenario pins this exact
    // order.
    const footTickInput = panels.metaField('ed-wave-foot-tick', 'foot.tick',
      '下方起始刻度，例如 0', 'foot.tick', panels.sections.document);
    const footTockInput = panels.metaField('ed-wave-foot-tock', 'foot.tock',
      '下方半格刻度起始值，例如 0', 'foot.tock', panels.sections.document);
    const footEveryInput = panels.metaField('ed-wave-foot-every', 'foot.every',
      '下方每幾格顯示一次刻度', 'foot.every', panels.sections.document);
    // v3.6.0 Task 13: the document panel's ninth field — see the block
    // comment above for why a control for this is back at all.
    const hscaleInput = panels.metaField('ed-wave-config-hscale', 'hscale',
      '整份圖的水平縮放倍率（config.hscale，1-100 的整數；空白＝不設定）',
      'config.hscale', panels.sections.document);
    // Published for `panels.renderMeta`'s lazy read, same reason as
    // `deps.headInput` etc. below — see `wave-panels.js`'s own header for
    // why these stay a lazy `deps` read rather than a return value.
    deps.headInput = headInput;
    deps.footInput = footInput;
    deps.headTickInput = headTickInput;
    deps.headTockInput = headTockInput;
    deps.headEveryInput = headEveryInput;
    deps.footTickInput = footTickInput;
    deps.footTockInput = footTockInput;
    deps.footEveryInput = footEveryInput;
    deps.hscaleInput = hscaleInput;

    headInput.addEventListener('change', function () { panels.commitBanner('head', 'text', headInput.value); });
    footInput.addEventListener('change', function () { panels.commitBanner('foot', 'text', footInput.value); });
    headTickInput.addEventListener('change', function () { panels.commitBanner('head', 'tick', headTickInput.value); });
    headTockInput.addEventListener('change', function () {
      panels.commitBanner('head', 'tock', headTockInput.value);
    });
    headEveryInput.addEventListener('change', function () { panels.commitBanner('head', 'every', headEveryInput.value); });
    footTickInput.addEventListener('change', function () {
      panels.commitBanner('foot', 'tick', footTickInput.value);
    });
    footTockInput.addEventListener('change', function () { panels.commitBanner('foot', 'tock', footTockInput.value); });
    footEveryInput.addEventListener('change', function () {
      panels.commitBanner('foot', 'every', footEveryInput.value);
    });
    hscaleInput.addEventListener('change', function () {
      panels.commitConfigField('hscale', hscaleInput.value);
    });

    // ── the Lane panel: period / phase for the currently selected lane ─────
    //
    // v3.6.0 Task 13: new. "Selected lane" here is the CYCLE selection's own
    // `laneIndex` (`selection`, below) — this dialog has never had a
    // separate "selected lane" concept, and inventing a second one only for
    // these two fields would be a second belief about what "selected" means
    // in the same file. Disabled whenever `selection` is null; see
    // `panels.renderLaneField`'s own comment for the render side.
    const lanePeriodInput = panels.metaField('ed-wave-lane-period', 'period',
      '先選一段 cycle 才能設定', 'period', panels.sections.lane);
    const lanePhaseInput = panels.metaField('ed-wave-lane-phase', 'phase',
      '先選一段 cycle 才能設定', 'phase', panels.sections.lane);
    deps.lanePeriodInput = lanePeriodInput;
    deps.lanePhaseInput = lanePhaseInput;
    lanePeriodInput.addEventListener('change', function () {
      if (selection === null) return;
      panels.commitLaneField(selection.laneIndex, 'period', lanePeriodInput.value);
    });
    lanePhaseInput.addEventListener('change', function () {
      if (selection === null) return;
      panels.commitLaneField(selection.laneIndex, 'phase', lanePhaseInput.value);
    });

    // ── the edge inspector row ──────────────────────────────────────────
    //
    // Same rule as `renderUnmodelled` below: HIDDEN, with no box on screen at
    // all, unless `selectedEdge` names one — `renderEdgeBar` is what flips
    // `edgeBar.hidden` and it is only ever called from `render()`, so the two
    // can never disagree. Built once here, like `headInput`/`footInput`
    // above; `render()` repaints its VALUES on every pass through
    // `renderEdgeBar`, and the usual `data-focus-key` / `restoreFocus` pair
    // is what keeps a half-typed label from losing the caret on that repaint.
    const edgeBar = d.createElement('div');
    edgeBar.className = 'ed-wave-edgebar';
    edgeBar.hidden = true;
    // v3.6.0 Task 13: the 關聯線 panel's body, not the toolbar — see
    // `wave-panels.js`'s `sections` for why the container is available
    // synchronously here.
    panels.sections.edge.appendChild(edgeBar);

    const shapeWrap = d.createElement('label');
    shapeWrap.className = 'ed-wave-metafield';
    const shapeWrapText = d.createElement('span');
    shapeWrapText.textContent = '形狀';
    shapeWrap.appendChild(shapeWrapText);
    const shapeSel = d.createElement('select');
    shapeSel.className = 'ed-wave-edge-shape';
    shapeSel.setAttribute('data-focus-key', 'ed-wave-edge-shape');
    for (const s of codec.EDGE_SHAPES) {
      const o = d.createElement('option');
      o.value = s;
      o.textContent = s;
      shapeSel.appendChild(o);
    }
    shapeSel.addEventListener('change', function () {
      if (selectedEdge === null) return;
      commit('edge-shape', function (doc) {
        const cur = codec.parseEdge((doc.edge || [])[selectedEdge]);
        if (cur === null) return doc;
        return codec.updateEdge(doc, selectedEdge,
          { from: cur.from, to: cur.to, shape: shapeSel.value, label: cur.label });
      });
    });
    shapeWrap.appendChild(shapeSel);
    edgeBar.appendChild(shapeWrap);

    const edgeLabelWrap = d.createElement('label');
    edgeLabelWrap.className = 'ed-wave-metafield';
    const edgeLabelWrapText = d.createElement('span');
    edgeLabelWrapText.textContent = '標籤';
    edgeLabelWrap.appendChild(edgeLabelWrapText);
    const edgeLabelInput = d.createElement('input');
    edgeLabelInput.type = 'text';
    edgeLabelInput.className = 'ed-wave-edge-label';
    edgeLabelInput.setAttribute('data-focus-key', 'ed-wave-edge-label');
    edgeLabelInput.placeholder = '這條線的標籤';
    edgeLabelInput.addEventListener('change', function () {
      if (selectedEdge === null) return;
      commit('edge-label', function (doc) {
        const cur = codec.parseEdge((doc.edge || [])[selectedEdge]);
        if (cur === null) return doc;
        return codec.updateEdge(doc, selectedEdge,
          { from: cur.from, to: cur.to, shape: cur.shape, label: edgeLabelInput.value });
      });
    });
    edgeLabelWrap.appendChild(edgeLabelInput);
    edgeBar.appendChild(edgeLabelWrap);

    const edgeDeleteBtn = d.createElement('button');
    edgeDeleteBtn.type = 'button';
    edgeDeleteBtn.className = 'ed-wave-edge-delete';
    edgeDeleteBtn.setAttribute('data-focus-key', 'ed-wave-edge-delete');
    edgeDeleteBtn.textContent = '刪除這條線';
    edgeDeleteBtn.title = '刪掉這條關聯線（連帶清掉沒有其他 edge 再用的 anchor 字母）';
    edgeDeleteBtn.addEventListener('click', function () {
      if (selectedEdge === null) return;
      const at = selectedEdge;
      // Cleared BEFORE `commit`, not after: `commit` repaints synchronously,
      // and `removeEdge` shifts every later entry's index down by one — so an
      // index cleared only after `commit` returns would let `render()`'s
      // clamp see a DIFFERENT edge that happens to have landed on the same
      // number, and silently keep the inspector open on it.
      selectedEdge = null;
      commit('edge-remove', function (doc) {
        return codec.pruneNodes(codec.removeEdge(doc, at));
      });
    });
    edgeBar.appendChild(edgeDeleteBtn);
    // Published for `panels.renderEdgeBar`'s lazy read, same reason as
    // `deps.metaBar` above.
    deps.edgeBar = edgeBar;
    deps.shapeSel = shapeSel;
    deps.edgeLabelInput = edgeLabelInput;

    // The "this drawing is not showing you everything" notice. Empty, and with
    // no box on screen, for the documents that carry none of the three.
    const unmodelled = d.createElement('div');
    unmodelled.className = 'ed-wave-unmodelled';
    unmodelled.hidden = true;
    toolbar.appendChild(unmodelled);

    // The other notice: this block has nothing this editor can edit. Its own
    // element rather than a second sentence in the one above, because the two
    // are different claims — "the drawing is not showing you everything" and
    // "there is nothing here to draw" — and a document can be in both states.
    const noSignal = d.createElement('div');
    noSignal.className = 'ed-wave-unmodelled ed-wave-nolanes';
    noSignal.hidden = true;
    toolbar.appendChild(noSignal);
    // Published for `panels.renderUnmodelled`'s lazy read, same reason as
    // `deps.headInput` etc. above.
    deps.unmodelled = unmodelled;
    deps.noSignal = noSignal;

    // ── body: lane list | drawing | right-hand column ──────────────────────
    //
    // v3.6.0 Task 13: the body's third column USED to be `previewWrap`
    // directly; it is now `panels.side`, the five-section right-hand column
    // built inside `createPanels()` (see `wave-panels.js`'s own comment
    // above `side`/`sections`), and `previewWrap` moves one level deeper,
    // into `panels.sections.preview`.
    const body = d.createElement('div');
    body.className = 'ed-wave-body';
    panel.appendChild(body);

    const laneCol = d.createElement('div');
    laneCol.className = 'ed-wave-lanes';
    body.appendChild(laneCol);
    // Published for `panels.renderLanes`/`panels.renameGroup`'s lazy read,
    // same reason as `deps.headInput` etc. above.
    deps.laneCol = laneCol;

    const canvasWrap = d.createElement('div');
    canvasWrap.className = 'ed-wave-canvas-wrap';
    body.appendChild(canvasWrap);

    const previewWrap = d.createElement('div');
    previewWrap.className = 'ed-wave-preview';
    const previewLabel = d.createElement('div');
    previewLabel.className = 'ed-wave-preview-label';
    previewLabel.textContent = 'WaveDrom 預覽';
    previewWrap.appendChild(previewLabel);
    const previewHost = d.createElement('div');
    previewHost.className = 'ed-wave-preview-host';
    // The output id prefix is deliberately NOT `WaveDrom_Display_`: md2doc's
    // own init hook reclaims every id with that prefix before each
    // ProcessAll(), and the reader's lightbox picks its click targets by it.
    // This preview belongs to neither.
    previewHost.id = PREVIEW_ID_PREFIX + PREVIEW_INDEX;
    previewWrap.appendChild(previewHost);
    panels.sections.preview.appendChild(previewWrap);
    // Published for `panels.renderPreview`'s lazy read, same reason as
    // `deps.headInput` etc. above.
    deps.previewWrap = previewWrap;
    deps.previewHost = previewHost;

    // The right-hand column itself, appended once — the position the old
    // `previewWrap` occupied directly in `body`.
    body.appendChild(panels.side);

    const status = d.createElement('div');
    status.className = 'ed-wave-status';
    // Everything this dialog says back — where the cursor is, what a gesture
    // did, why one was refused — is written here and nowhere else, so it is
    // the one place that has to be announced rather than merely painted.
    status.setAttribute('role', 'status');
    panel.appendChild(status);
    // Published for `panels.say`'s lazy read, same reason as `deps.metaBar`
    // above.
    deps.status = status;

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
        panels.say('這個動作沒有改變任何東西');
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
     * `renderCanvas` does that, so this simply leaves the number alone.
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
      // `selection` in `renderCanvas`'s own clamp but left `pendingFrom`
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
        // left standing. `renderCanvas`'s clamp does not save it — that
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
        //                      a screen position `renderCanvas` re-clamps and
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
      // because `renderCanvas` re-clamps it into range on every repaint, and
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
      // gesture at, not a position `renderCanvas` re-clamps on every
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
      render();
      if (lastPatch.ok === true) {
        panels.say('已寫回：' + name);
      } else {
        panels.say('這個改動沒辦法只改幾個位元組寫回去：' + lastPatch.reason);
      }
      if (typeof opts.onGesture === 'function') {
        opts.onGesture({ name: name, patch: lastPatch, store: store });
      }
    }

    // ── painting ──────────────────────────────────────────────────────────
    let canvas = null;

    /**
     * v3.6.0 Task 13 fix round 4: keep the CURRENTLY selected edge's own
     * drawn handles clear of the expanded side rail — by narrowing the
     * RAIL, never by moving the canvas.
     *
     * Diagnosed against a real page before writing this (see task-13-
     * report.md, fix round 4), and the first two things tried both failed
     * against that diagnosis before this one was chosen:
     *
     *   1. Hypothesis (mine and the reviewer's, both wrong): the expand
     *      reflows the canvas mid-gesture, so a point resolved before it
     *      goes stale. MEASURED false — `.ed-wave-canvas`'s own
     *      `getBoundingClientRect()` is IDENTICAL before, during and after
     *      the whole gesture. Nothing moves.
     *   2. First fix tried: scroll the canvas horizontally to carry the
     *      handle out from under the rail (`canvasWrap.scrollLeft`), the
     *      same technique `pointInCanvas` uses in the test suite. MEASURED
     *      to do nothing on the fixture that actually fails: a short
     *      document's drawn content is NARROWER than the wrap's own
     *      `clientWidth`, so `scrollWidth === clientWidth` — there is no
     *      scrollABLE range at all, and setting `scrollLeft` past 0 is
     *      silently clamped straight back to 0. The rail's expansion does
     *      not add any scrollable width to the wrap (it is an absolutely
     *      positioned overlay, outside the wrap's own box model), so a
     *      short document can never be scrolled clear of it.
     *
     * The actual defect both of those diagnosed correctly but did not fix
     * is occlusion, not displacement: the expanded rail is `position:
     * absolute`, OPAQUE, `z-index: 3`, painted ON TOP of the canvas at a
     * narrow viewport (round 1's own deliberate design — the rail overlays
     * rather than squeezes, so the canvas keeps its width-budget win).
     * `elementFromPoint` at the handle's own coordinates resolved to a
     * `<span>` INSIDE the rail, not the handle — because the rail is what
     * is actually painted there now, regardless of scroll position.
     *
     * So this narrows the rail instead: its `width` (normally 340px, the
     * CSS default) is set only as far down as needed to keep the selected
     * edge's rightmost handle clear, floored at `MIN_WIDTH` so the panel
     * never shrinks to something unusable. `right: 0` stays anchored (the
     * CSS is untouched), so shrinking width moves the rail's LEFT edge
     * right, away from the handle, while the canvas itself never moves at
     * all — satisfying the same invariant the "reflow mid-gesture"
     * hypothesis was chasing (`.ed-wave-canvas`'s rect never changes
     * between a press and its release) for a different, correct reason.
     *
     * Recomputed from scratch on every call (the leading `style.width =
     * ''` is not an optimization to skip) rather than only on a change of
     * `selectedEdge` — an unrelated repaint can still move a lane's own
     * geometry (hscale, a resize) while the SAME edge stays selected, and
     * a stale width would either pointlessly over-narrow the rail or,
     * worse, under-narrow it and silently reopen the exact defect this
     * exists to close.
     *
     * Selecting an edge is very often immediately followed by dragging the
     * very handle selection just exposed — it is the ONLY way to adjust an
     * endpoint (`onCanvasDown`'s drag-start branch only ever fires for the
     * SELECTED edge's own handle), so select-then-drag is not an edge
     * case, it is the whole mechanism this protects.
     *
     * Purely geometric, so it is a correct no-op everywhere it should be:
     * at a wide viewport the rail sits in-flow beside the canvas's own
     * wrap and never overlaps it at all, so `rightmost` never exceeds
     * `bodyRight - MIN_WIDTH` and no inline width is ever applied; with the
     * rail collapsed to its 28px rail, the CSS `flex: 0 0 28px` on that
     * (non-absolute, in-flow) state takes priority over an inline `width`
     * for a flex item's own sizing, so a leftover inline style from a
     * PRIOR expansion cannot keep the collapsed rail artificially wide.
     *
     * Residual, accepted limit: if `bodyRight - rightmost - margin` is
     * itself below `MIN_WIDTH`, this clamps to `MIN_WIDTH` rather than
     * shrinking further, which can still leave a small residual overlap in
     * a genuinely too-narrow-to-satisfy-both-at-once case. Not reachable
     * by anything in this repo's own fixtures (checked against
     * `EDGE_FORK_MD`, the narrowest one that exercises this path).
     */
    function clearSelectedEdgeOfSide() {
      panels.side.style.width = '';
      if (selectedEdge === null) return;
      const bodyRight = body.getBoundingClientRect().right;
      let rightmost = null;
      for (const end of ['from', 'to']) {
        const h = d.querySelector('.ed-wave-edge-handle[data-edge-index="' +
          selectedEdge + '"][data-edge-handle="' + end + '"]');
        if (h === null) continue;
        const r = h.getBoundingClientRect();
        if (rightmost === null || r.right > rightmost) rightmost = r.right;
      }
      if (rightmost === null) return;
      const MARGIN = 4;
      const MIN_WIDTH = 160;
      const fits = bodyRight - rightmost - MARGIN;
      if (fits < 340) panels.side.style.width = Math.max(MIN_WIDTH, Math.round(fits)) + 'px';
    }

    /**
     * Repaint everything, and give the keyboard cursor back where it was.
     *
     * `renderLanes` rebuilds the lane list from scratch, so without this a
     * rename committed with Enter left `document.activeElement` on
     * `document.body` — measured. That is the same defect class as four of the
     * last five commits on this branch, and here it is also the ENABLING step
     * for the block-selection data loss: focus on body plus a standing
     * selection turns the next Backspace into "delete the selected blocks".
     *
     * Identity is carried by `data-focus-key`, not by element identity, because
     * the element the user was typing in no longer exists after the rebuild.
     * The text cursor inside a field is carried too; a field that came back
     * with different text keeps the cursor clamped to what is there now.
     *
     * The rename field is the ONE `data-focus-key` that a repaint does not
     * bring back — the rail only ever rebuilds the tag it replaced — so a
     * repaint that runs while it is open has to retire it explicitly. Without
     * that, `Ctrl+Z` typed into the field wedged the whole page: the undo
     * repainted, `restoreFocus` looked for `group-input-<n>` and found
     * nothing, focus was left on a DETACHED element, and from then on NO key
     * reached the page at all — not `a`, not three Escapes, so the modal could
     * not even be closed without a mouse. That is the defect family this task
     * exists for, one worse than the six it cites, and it was reachable in two
     * keystrokes from the sub-panel the task itself redesigned.
     */
    function render() {
      if (groupRename !== null) groupRename.retire();
      const before = focusMark();
      const doc = store.doc;
      const layout = geometry.layoutOf(doc, SIZES);
      // Clamped BEFORE `renderCanvas`/`renderEdgeBar` read it, and against
      // `edgeLayout`'s own filtered list rather than `doc.edge.length` — an
      // edge whose anchor letter went missing is still an array element (so
      // a length check would miss it) but `edgeLayout` already will not draw
      // it, and an inspector row pointed at an edge nothing on screen shows
      // is exactly the stale-selection defect `carryMarks` above exists to
      // avoid for lanes.
      if (selectedEdge !== null && !edgeIsDrawable(doc, layout, selectedEdge)) {
        selectedEdge = null;
      }
      // v3.5.0 Task 8: `endpointDrag.index` can only ever be reached from
      // `selectedEdge`'s own drawn handle (see `onCanvasDown`), so the two
      // may never disagree — checked with `!==` rather than "is `index`
      // still drawable" on its own, because that would let a drag survive a
      // mid-drag undo that DESELECTS the edge without deleting it (the
      // clamp above nulls `selectedEdge` on its own timing). A drag that
      // outlives the selection it was dragging is exactly the class of
      // hazard Task 7 paid three rounds to close for `pendingFrom`/
      // `edgeMode`; this is the same rule applied to this task's own mark.
      if (endpointDrag !== null && endpointDrag.index !== selectedEdge) {
        endpointDrag = null;
      }
      panels.renderLanes(doc, layout, { selection: selection });
      // v3.6.0 Task 13: the Lane panel's period/phase — same `selection` mark
      // `renderLanes` above already reads for the CYCLE highlight, not a
      // second "selected lane" concept.
      panels.renderLaneField(doc, layout, { selection: selection });
      const wds = {
        cursor: cursor,
        selection: selection,
        pendingFrom: pendingFrom,
        endpointDrag: endpointDrag,
        selectedEdge: selectedEdge,
        overlay: overlay,
        canvasWrap: canvasWrap,
        dataEdit: dataEdit,
        enterDrawing: enterDrawing,
        onCanvasDown: onCanvasDown,
        onCanvasHover: onCanvasHover,
        edgeMode: edgeMode,
        hoverBoundary: hoverBoundary,
      };
      canvas = drawer.renderCanvas(canvas, doc, layout, wds);
      cursor = wds.cursor;
      selection = wds.selection;
      panels.renderEdgeBar(doc, { selectedEdge: selectedEdge });
      // v3.6.0 Task 13 fix round 3: selecting an edge is an action whose
      // ENTIRE feedback surface is the 關聯線 panel just painted above —
      // at a narrow viewport (<1100px) that panel sits inside the
      // collapsed rail, where every one of its controls renders at zero
      // size (`wave-panels.js`'s `section()` docstring and `lib/md2doc.js`'s
      // `.ed-wave-side` media query: `data-open` is the SECTION's own
      // toggle state and says nothing about whether the RAIL is currently
      // showing it). Left alone, a narrow-viewport user who selects an edge
      // gets no hint that the only surface to edit or delete it exists at
      // all. So this expands the rail — but only on the TRANSITION into
      // having a selection (`lastSelectedEdge === null`, checked against
      // the PREVIOUS render, not "selectedEdge !== null" on its own):
      // expanding on every repaint would fight a user who deliberately
      // collapses the rail back (the fix-round-1 button) while still
      // working on the same selected edge — the very next keystroke would
      // pop it back open. Firing once, at the moment of selection, is the
      // honest response without becoming a second one-way door.
      //
      // Lane/cycle selection does NOT get the same treatment, by deliberate
      // choice, not oversight: unlike an edge, selecting a lane already has
      // visible feedback OUTSIDE the side column — `renderLanes` highlights
      // the row (`.is-selected`) and the canvas itself draws the cycle
      // selection — so a narrow-viewport user who selects a lane is never
      // left looking at nothing the way an edge-select would leave them.
      if (selectedEdge !== null && lastSelectedEdge === null) {
        panels.expandSide();
      }
      lastSelectedEdge = selectedEdge;
      // v3.6.0 Task 13 fix round 4: re-checked on EVERY render while an
      // edge is selected, not only on the transition that just (maybe)
      // expanded the rail above — see `clearSelectedEdgeOfSide`'s own
      // comment for the mechanism. Unlike `expandSide()`, this has no
      // "only once" concern: it recomputes and resets from scratch each
      // call, so it stays correct across switching directly from one
      // selected edge to another, an unrelated repaint moving the SAME
      // edge's own handle (a resize, an hscale change), or the rail
      // collapsing back (where it correctly clears its own inline style).
      clearSelectedEdgeOfSide();
      panels.renderPreview(doc);
      panels.renderMeta(doc);
      panels.renderUnmodelled(doc, layout);
      // v3.6.0 Task 13: the 原始碼 panel. Repainted every pass, like every
      // other panel above — cheap (one `store.toPatch()`, already run once
      // per gesture by `afterStoreMoved`) and it means the panel can never
      // show a patch older than what is on screen.
      panels.renderSource();
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
     * OTHER sub-panel, same `{cancel, retire}` shape as `renameGroup` just
     * above and opened the same two ways every other gesture in this file
     * is: a pointer press (`onCanvasDown`) or the keyboard's own Enter
     * (`handleDrawingKey`), both of which have already asked
     * `codec.dataSlotOf` before calling this, so `slot` below is never
     * recomputed from a belief of its own about which cycles consume one.
     *
     * Positioned with `geometry.cellRect` — the exact numbers the keyboard
     * cursor and the pointer's own hit test already share — offset by
     * `canvas.offsetLeft`/`offsetTop` rather than the wrap's own padding
     * written out as a constant: the field is a plain sibling of the SVG
     * inside `.ed-wave-canvas-wrap` (now `position: relative`, see
     * `lib/md2doc.js`), so reading the SVG's OWN measured offset is what
     * keeps the two from drifting apart if that padding ever changes.
     *
     * Unlike `renameGroup`'s field, this one's node sits beside a canvas
     * `renderCanvas` rebuilds on every cursor move — see that function's own
     * first line for why `retire()` has to be called from there too, not
     * only from `render()`.
     */
    function openDataEdit(laneIndex, cycle) {
      if (canvas === null) return;
      const layout = geometry.layoutOf(store.doc, SIZES);
      const row = layout.lanes[laneIndex];
      const lane = row === undefined ? null : row.lane;
      const slot = lane === null ? null : codec.dataSlotOf(lane, cycle);
      if (slot === null) return;
      const box = geometry.cellRect(layout, laneIndex, cycle);
      if (box === null) return;
      // A press or an Enter that lands on a second bus cell while the field
      // is still open on the first one: the open field never got the blur
      // that a plain click elsewhere would have given it (the keyboard's
      // Enter path never moves focus at all), so it is cancelled here,
      // by hand, before this one opens. Unsaved text in the first field is
      // discarded — the same trade `renameGroup` makes for its own field on
      // every route that is not `finish()` itself.
      if (dataEdit !== null) dataEdit.cancel();

      const current = labelsOf(lane)[slot];
      const startValue = typeof current === 'string' ? current : '';

      const input = d.createElement('input');
      input.type = 'text';
      input.className = 'ed-wave-data-input';
      input.setAttribute('data-focus-key', 'data-input-' + laneIndex + '-' + cycle);
      input.value = startValue;
      input.style.left = (canvas.offsetLeft + box.x) + 'px';
      input.style.top = (canvas.offsetTop + box.y) + 'px';
      input.style.width = box.width + 'px';
      input.style.height = box.height + 'px';

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
        // here first owns the gesture" rule `renameGroup.finish` uses.
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
        // condition `renameGroup.finish` uses: either this field had it, or
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
      /** The canvas is about to be rebuilt underneath this field by
       *  `renderCanvas` — an undo, a redo, any gesture that repaints while
       *  it is open. The node goes with that rebuild; what matters is
       *  dropping the latch and naming where the keyboard lands, exactly
       *  the same reason `renameGroup.retire` exists. */
      const retire = function () {
        if (dataEdit === null) return;
        dataEdit = null;
        if (focusOverride === null && holdsKeyboard()) focusOverride = 'canvas';
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
      // event the way `renameGroup`'s field is would depend on whether this
      // browser fires `change` for a lone text input on Enter alone, which
      // is not a promise this file makes elsewhere — asked for outright
      // instead, the same way Escape is asked for explicitly one level up
      // in `onKeyDown` rather than left to a default.
      input.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        ev.stopPropagation();
        finish();
      });
      input.addEventListener('change', finish);
      input.addEventListener('blur', finish);
      canvasWrap.appendChild(input);
      dataEdit = { cancel: cancel, retire: retire };
      input.focus();
      input.select();
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
     * `isBus(brickOf(...))` is the same test `drawLane` uses to decide
     * whether a cycle is a bus box at all for the PICTURE, asked here to
     * decide it for the GESTURE — so a plain non-bus cycle (`0`, `1`, `x`, a
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
      const onCanvas = canvas !== null && ev.target === canvas;
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
          panels.say('起點已標記，移到終點再按一次 Enter');
          render();
        } else {
          finishEdgeDrag(cursor.laneIndex, cursor.cycle);
        }
        return true;
      }
      // v3.5.0 Task 11: Enter on a cell inside a bus box opens that box's
      // label field instead of painting over it with the brush — the
      // keyboard's own version of the pointer's click below in
      // `onCanvasDown`. `resolveBusTarget` is the SAME resolution
      // `onCanvasDown` uses (fix round 1: a cursor resting on a `.`/`|`
      // continuation inside a run used to fall straight through to
      // `paintAtCursor()` below with nothing catching it — the identical
      // silent-corruption hazard the pointer path had, closed the same way
      // here rather than only on the mouse), so the two input devices can
      // never disagree about which cells are labellable or where a press
      // on a continuation actually lands. Placed AFTER the armed-edge Enter
      // above (arming an edge outranks opening a label field — the same
      // press cannot mean both) and BEFORE the generic Enter-paints case
      // below, which it must pre-empt.
      if (key === 'Enter' && cursor !== null) {
        const dlLayout = geometry.layoutOf(store.doc, SIZES);
        const dlRow = dlLayout.lanes[cursor.laneIndex];
        const dlLane = dlRow === undefined ? null : dlRow.lane;
        if (dlLane !== null) {
          const dlTarget = resolveBusTarget(dlLane, cursor.cycle);
          if (dlTarget === 'blocked') {
            ev.preventDefault();
            ev.stopPropagation();
            panels.say('這一格接在某個 bus 值後面，但看不出屬於哪一個，沒有欄位可以編輯。');
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
      if (canvas === null) return;
      const layout = geometry.layoutOf(store.doc, SIZES);
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
      const layout = geometry.layoutOf(store.doc, SIZES);
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
      scrollCursorIntoView(layout);
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
     * document content changed, so this is a repaint of the drawing and the
     * rail, not a `render()` that would also rebuild the preview to paint the
     * identical picture.
     */
    function jumpTransition(dir) {
      const layout = geometry.layoutOf(store.doc, SIZES);
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
        panels.say('這條 lane 上沒有轉態點可以停，關聯線接不上去');
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
      // own field names all the way to `drawTransitions`, which compares
      // `.cell` — the two spellings are deliberately different and a mix-up
      // fails silently there, as that function's own comment says.
      hoverBoundary = { laneIndex: lane, cell: next };
      repaintDrawing(layout);
      scrollCursorIntoView(layout);
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
     * The rectangle is the answer for someone who can see it; the status line
     * carries `role="status"`, so this is the same answer for someone who
     * cannot. It names the LANE rather than its index because the index is the
     * codec's flattened display order and means nothing to the person reading.
     *
     * POSITION ONLY — no instructions. A live region is re-announced in full
     * every time it changes, and this changes on every arrow key, so a hint
     * appended here is a hint read out on every press of a key the user is
     * holding down. The hint is already in the two places it belongs and is
     * announced once each: the canvas's own `aria-label`, read when the
     * keyboard arrives on the drawing, and the opening status line.
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
      panels.say('游標：' + name + ' cycle ' + (cursor.cycle + 1) + span);
    }

    /** The lane list and the drawing, repainted together and without touching
     *  the store or the preview: a cursor move changes no document content, so
     *  re-rendering the engine's preview beside it would be a round trip to
     *  paint the identical picture. The lane list IS repainted, because
     *  `.is-selected` on its rows is where "which lane am I on" is shown. */
    function repaintDrawing(layout) {
      const l = layout === undefined || layout === null
        ? geometry.layoutOf(store.doc, SIZES) : layout;
      panels.renderLanes(store.doc, l, { selection: selection });
      const wds = {
        cursor: cursor,
        selection: selection,
        pendingFrom: pendingFrom,
        endpointDrag: endpointDrag,
        selectedEdge: selectedEdge,
        overlay: overlay,
        canvasWrap: canvasWrap,
        dataEdit: dataEdit,
        enterDrawing: enterDrawing,
        onCanvasDown: onCanvasDown,
        onCanvasHover: onCanvasHover,
        edgeMode: edgeMode,
        hoverBoundary: hoverBoundary,
      };
      canvas = drawer.renderCanvas(canvas, store.doc, l, wds);
      cursor = wds.cursor;
      selection = wds.selection;
      // AFTER the drawer, which is what clamps `selection` into the document
      // it just drew — reading it before would arm a button against a range
      // the drawing has already refused.
      paintSelectionState(store.doc, l);
    }

    /**
     * Keep the cursor inside the canvas column's clip.
     *
     * `.ed-wave-canvas-wrap` is a scroll container — that is how a diagram
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
    function scrollCursorIntoView(layout) {
      if (cursor === null || canvas === null) return;
      const box = geometry.cellRect(layout, cursor.laneIndex, cursor.cycle);
      if (box === null || typeof canvas.getBoundingClientRect !== 'function') return;
      const cbox = canvas.getBoundingClientRect();
      const wbox = canvasWrap.getBoundingClientRect();
      const left = (cbox.left + box.x) - (wbox.left + canvasWrap.clientLeft);
      const top = (cbox.top + box.y) - (wbox.top + canvasWrap.clientTop);
      const w = canvasWrap.clientWidth;
      const h = canvasWrap.clientHeight;
      if (left < 0) canvasWrap.scrollLeft += left;
      else if (left + box.width > w) canvasWrap.scrollLeft += left + box.width - w;
      if (top < 0) canvasWrap.scrollTop += top;
      else if (top + box.height > h) canvasWrap.scrollTop += top + box.height - h;
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
      const layout = geometry.layoutOf(store.doc, SIZES);
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
        const at = cellFromEvent(ev, layout);
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
      // `renderCanvas` has moved on from.
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
        const box = canvas.getBoundingClientRect();
        const handle = geometry.edgeHandleAt(edges, ev.clientX - box.left, ev.clientY - box.top);
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
            panels.say('這是一條 self-loop（起點跟終點在同一格），兩端的把手疊在同一個位置：' +
              '只有拖得到的這一端可以搬，另一端目前搬不到。');
          }
          endpointDrag = { index: handle.index, end: handle.end, at: null, cell: null };
          canvas.focus();
          // Fix round 1, item 2: without a repaint here the press looks
          // inert until the first `pointermove` — `.is-drag-source` (set
          // from this same `endpointDrag`, read by `renderEdges`) would not
          // fade the dragged edge until then, unlike the sibling
          // `edgeMode === 'armed'` branch above, which repaints immediately
          // on its own press. `renderCanvas`, not the full `render()`: this
          // state change touches only the canvas SVG (the faded path; the
          // dashed landing preview has nothing to draw yet since `at` is
          // still `null`) — `selectedEdge` is unchanged, so the edge
          // inspector row and the lane list are both already showing exactly
          // what they should, and paying for `renderLanes`/`renderEdgeBar`
          // again would be the same needless cost the existing
          // `hadSelectedEdge`-gated branch further down in this function
          // already avoids.
          const wds = {
            cursor: cursor,
            selection: selection,
            pendingFrom: pendingFrom,
            endpointDrag: endpointDrag,
            selectedEdge: selectedEdge,
            overlay: overlay,
            canvasWrap: canvasWrap,
            dataEdit: dataEdit,
            enterDrawing: enterDrawing,
            onCanvasDown: onCanvasDown,
            onCanvasHover: onCanvasHover,
            edgeMode: edgeMode,
            hoverBoundary: hoverBoundary,
          };
          canvas = drawer.renderCanvas(canvas, store.doc, layout, wds);
          cursor = wds.cursor;
          selection = wds.selection;
          // The toolbar reads `selection`; this repaint can change it (fix round 1).
          paintSelectionState(store.doc, layout);
          d.addEventListener('mousemove', onCanvasMove, true);
          d.addEventListener('mouseup', onCanvasUp, true);
          return;   // 不塗、不選格
        }
      }
      // v3.5.0 Task 11 fix round 2 (widened in round 3): a press that lands
      // on the label's own mark — the `<text>` when the run has a label, or
      // (round 3) the small `<circle class="ed-wave-buslabel-empty">`
      // `drawLane` draws in its place when the run has none — opens the
      // data-label field instead of arming a paint drag, rather than merely
      // somewhere inside the box the mark sits in. Round 1 gated this on
      // the CELL (`codec.dataSlotOf`/`resolveBusTarget` alone, asked off
      // the pressed cycle with no regard to what was actually under the
      // pointer) and that was reviewer-verified to be its own regression:
      // T6b paints `N` onto a bus cell with the mouse, and painting a
      // bus cell is exactly what twenty-two brushes exist for — a gesture
      // that swallows every press anywhere in the box leaves the user no
      // pointer route to repaint one at all. The string is what a press on
      // its mark means to change, so the mark is the target; a press
      // anywhere else in the SAME box — the polygon, its bevelled ends, a
      // held continuation's own cell — falls straight through to the
      // ordinary paint dispatch below exactly as it always has, ROUND 1's
      // fix included: that fix's `resolveBusTarget` still runs, just gated
      // on the mark hit rather than on cell membership, so a press on the
      // label of a merged run still resolves to the run's owning explicit
      // cycle regardless of which cycle's pixels the mark happens to
      // straddle (see `resolveBusTarget`'s own comment — its answer is the
      // same whichever cycle a press on that shared mark geometrically
      // lands on). Both marks carry the SAME `ed-wave-buslabel` class —
      // round 3's placeholder ADDS `ed-wave-buslabel-empty` on top of it
      // rather than replacing it — so this check needed no change at all
      // to cover the empty case; it was already asking for the class, not
      // for an element type. `.ed-wave-buslabel`'s `pointer-events:
      // visiblePainted` (`lib/md2doc.js`) plus paint order — each mark is
      // appended AFTER its box's `<polygon>` in `drawLane`, so it sits on
      // top and wins the hit test in its own footprint — is what makes the
      // two targets disjoint instead of the mark being invisibly swallowed
      // by the polygon underneath it.
      //
      // final review finding 4: this block moved AHEAD of `edgeHitAt` below
      // (it used to run after it), and its condition now asks
      // `busLabelHitAt` instead of testing `ev.target` directly.
      //
      // Gating `edgeHandleAt` on `selectedEdge` (the change in `edgeHitAt`
      // itself, above) stops a PHANTOM, undrawn handle from claiming a press
      // by pure coordinate math — but MEASURED against a real page, that
      // alone does not make this block reachable: `renderEdges` draws
      // `.ed-wave-edge-hit` (a 10px-wide, invisible-but-hit-testable stroke,
      // `pointer-events: stroke`) AFTER every lane's own content, so for any
      // edge whose endpoint lands on a bus cell, that invisible stroke
      // paints ON TOP of the cell's `.ed-wave-buslabel` mark. `ev.target` —
      // the browser's own topmost-element answer — is `path.ed-wave-edge-
      // hit` at that pixel regardless of source order in THIS function:
      // moving this block ahead of `edgeHitAt` does not change what
      // `ev.target` IS, only when it gets asked. Reordering plus the
      // original `ev.target` check was tried first and measured to still
      // fail — `elementFromPoint` at the labelled cell's own centre resolved
      // to the hit path, not the label, exactly as before.
      //
      // `busLabelHitAt` answers a different question: not "what is the
      // TOPMOST element here" but "is there a bus-label mark ANYWHERE in the
      // stack of elements under this press", via `elementsFromPoint`
      // (plural) — the standard way to see past one hit-testable layer
      // sitting on top of another at the same point. That is a real,
      // measured difference in outcome, not a matter of code order.
      if (busLabelHitAt(ev) !== null) {
        const busAt = cellFromEvent(ev, layout);
        if (busAt !== null) {
          const busLane = layout.lanes[busAt.laneIndex].lane;
          const busTarget = resolveBusTarget(busLane, busAt.cycle);
          // `resolveBusTarget` should never actually answer `null` here —
          // the label only ever exists over a cycle the codec itself calls
          // a bus level — but the check is kept rather than assumed, same
          // reasoning as the `'blocked'` branch just below it.
          if (busTarget === 'blocked') {
            ev.preventDefault();
            panels.say('這一格接在某個 bus 值後面，但看不出屬於哪一個，沒有欄位可以編輯。');
            return;
          }
          if (busTarget !== null) {
            ev.preventDefault();
            const busHadSelectedEdge = selectedEdge !== null;
            selectedEdge = null;
            cursor = { laneIndex: busAt.laneIndex, cycle: busTarget.cycle };
            selection = {
              laneIndex: busAt.laneIndex, laneTo: busAt.laneIndex,
              from: busTarget.cycle, to: busTarget.cycle,
            };
            canvas.focus();
            if (busHadSelectedEdge) render();
            else {
              const wds = {
                cursor: cursor,
                selection: selection,
                pendingFrom: pendingFrom,
                endpointDrag: endpointDrag,
                selectedEdge: selectedEdge,
                overlay: overlay,
                canvasWrap: canvasWrap,
                dataEdit: dataEdit,
                enterDrawing: enterDrawing,
                onCanvasDown: onCanvasDown,
                onCanvasHover: onCanvasHover,
                edgeMode: edgeMode,
                hoverBoundary: hoverBoundary,
              };
              canvas = drawer.renderCanvas(canvas, store.doc, layout, wds);
              cursor = wds.cursor;
              selection = wds.selection;
              // The toolbar reads `selection`; this repaint can change it (fix round 1).
              paintSelectionState(store.doc, layout);
            }
            openDataEdit(busAt.laneIndex, busTarget.cycle);
            return;
          }
        }
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
      // whatever WAS selected. The inspector row is the only visible sign a
      // selection exists, and a selection that outlives a click elsewhere
      // would let a later 刪除這條線 act on an edge the user has stopped
      // looking at. This is IN ADDITION to the paint gesture below, on the
      // very same press — not instead of it.
      const hadSelectedEdge = selectedEdge !== null;
      selectedEdge = null;
      const at = cellFromEvent(ev, layout);
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
      // `renderCanvas`-only repaint this always did. A full `render()` is
      // only paid on the transition that actually needs it: hiding the
      // inspector row, which lives in the toolbar `renderCanvas` never
      // touches.
      if (hadSelectedEdge) render();
      else {
        const wds = {
          cursor: cursor,
          selection: selection,
          pendingFrom: pendingFrom,
          endpointDrag: endpointDrag,
          selectedEdge: selectedEdge,
          overlay: overlay,
          canvasWrap: canvasWrap,
          dataEdit: dataEdit,
          enterDrawing: enterDrawing,
          onCanvasDown: onCanvasDown,
          onCanvasHover: onCanvasHover,
          edgeMode: edgeMode,
          hoverBoundary: hoverBoundary,
        };
        canvas = drawer.renderCanvas(canvas, store.doc, layout, wds);
        cursor = wds.cursor;
        selection = wds.selection;
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
        const layout = geometry.layoutOf(store.doc, SIZES);
        const at = cellFromEvent(ev, layout);
        // A move that strays off the diagram leaves `at`/`cell` exactly
        // where they last were, same recovery as `edgeMode === 'dragging'`
        // below and for the same reason: the drop target the user is
        // currently over is still the last cell the pointer was actually on
        // top of, not "nowhere".
        if (at !== null) {
          endpointDrag = { index: endpointDrag.index, end: endpointDrag.end,
            at: at.laneIndex, cell: at.cycle };
        }
        // `hoverBoundary` is left alone here: `drawTransitions` only ever
        // draws while `edgeMode !== 'idle'` (see its own guard, unchanged
        // by this task), and an endpoint drag never moves `edgeMode` away
        // from 'idle' (it is a wholly separate gesture from edge-creation —
        // see `endpointDrag`'s own declaration comment), so there is no dot
        // on screen for a hot mark to name here. `cellFromEvent` still
        // snaps this drag's OWN drop target to the nearest anchor via
        // `boundaryAt` — that part of Task 11 applies regardless — this is
        // only about the separate hover-dot chrome.
        // The document is untouched during the drag (rule 3): this repaints
        // the preview only, never a `commit`.
        const wds = {
          cursor: cursor,
          selection: selection,
          pendingFrom: pendingFrom,
          endpointDrag: endpointDrag,
          selectedEdge: selectedEdge,
          overlay: overlay,
          canvasWrap: canvasWrap,
          dataEdit: dataEdit,
          enterDrawing: enterDrawing,
          onCanvasDown: onCanvasDown,
          onCanvasHover: onCanvasHover,
          edgeMode: edgeMode,
          hoverBoundary: hoverBoundary,
        };
        canvas = drawer.renderCanvas(canvas, store.doc, layout, wds);
        cursor = wds.cursor;
        selection = wds.selection;
        // The toolbar reads `selection`; this repaint can change it (fix round 1).
        paintSelectionState(store.doc, layout);
        return;
      }
      if (edgeMode === 'dragging') {
        // Same abandoned-button recovery as the paint drag below: the button
        // came up somewhere this page never heard about.
        if (ev.buttons === 0) { onCanvasUp(); return; }
        const layout = geometry.layoutOf(store.doc, SIZES);
        const at = cellFromEvent(ev, layout);
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
        const wds = {
          cursor: cursor,
          selection: selection,
          pendingFrom: pendingFrom,
          endpointDrag: endpointDrag,
          selectedEdge: selectedEdge,
          overlay: overlay,
          canvasWrap: canvasWrap,
          dataEdit: dataEdit,
          enterDrawing: enterDrawing,
          onCanvasDown: onCanvasDown,
          onCanvasHover: onCanvasHover,
          edgeMode: edgeMode,
          hoverBoundary: hoverBoundary,
        };
        canvas = drawer.renderCanvas(canvas, store.doc, layout, wds);
        cursor = wds.cursor;
        selection = wds.selection;
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
      const layout = geometry.layoutOf(store.doc, SIZES);
      const at = cellFromEvent(ev, layout);
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
      const wds = {
        cursor: cursor,
        selection: selection,
        pendingFrom: pendingFrom,
        endpointDrag: endpointDrag,
        selectedEdge: selectedEdge,
        overlay: overlay,
        canvasWrap: canvasWrap,
        dataEdit: dataEdit,
        enterDrawing: enterDrawing,
        onCanvasDown: onCanvasDown,
        onCanvasHover: onCanvasHover,
        edgeMode: edgeMode,
        hoverBoundary: hoverBoundary,
      };
      canvas = drawer.renderCanvas(canvas, store.doc, layout, wds);
      cursor = wds.cursor;
      selection = wds.selection;
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
      commit('paint', function (doc) {
        return codec.setCellRange(doc, g.laneIndex, g.from, g.to, brush);
      });
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
    function cellFromEvent(ev, layout) {
      if (canvas === null) return null;
      const box = canvas.getBoundingClientRect();
      const x = ev.clientX - box.left;
      const y = ev.clientY - box.top;
      if (edgeMode !== 'idle' || endpointDrag !== null) {
        const b = geometry.boundaryAt(layout, x, y);
        return b === null ? null : { laneIndex: b.laneIndex, cycle: b.cell };
      }
      return geometry.cellAt(layout, x, y);
    }

    /**
     * Pure hover, no button down, nothing committed — which anchor the
     * pointer is nearest while armed and not yet dragging, purely so
     * `drawTransitions`'s hot dot can light up before the user presses.
     *
     * A canvas-own listener rather than the document-level
     * `onCanvasMove`/`onCanvasUp` pair: those two are only added once a
     * drag actually starts (`onCanvasDown`'s 'armed' and endpoint-drag
     * branches), so a plain hover before the first press has nothing else
     * watching it. Once a drag IS live, `onCanvasMove`'s own branches
     * already repaint on every move and set `hoverBoundary` themselves
     * (below), so this steps out of the way rather than doing the same
     * work under a second name — the `edgeMode !== 'armed'` guard covers
     * both: `edgeMode === 'dragging'` fails it directly, and an
     * `endpointDrag` never moves `edgeMode` away from 'idle' in the first
     * place (it is a wholly separate gesture from edge-creation), so it
     * fails the same guard too.
     */
    function onCanvasHover(ev) {
      if (edgeMode !== 'armed') return;
      const layout = geometry.layoutOf(store.doc, SIZES);
      const at = cellFromEvent(ev, layout);
      const next = at === null ? null : { laneIndex: at.laneIndex, cell: at.cycle };
      const same = (hoverBoundary === null && next === null) ||
        (hoverBoundary !== null && next !== null &&
          hoverBoundary.laneIndex === next.laneIndex && hoverBoundary.cell === next.cell);
      if (same) return;
      hoverBoundary = next;
      const wds = {
        cursor: cursor,
        selection: selection,
        pendingFrom: pendingFrom,
        endpointDrag: endpointDrag,
        selectedEdge: selectedEdge,
        overlay: overlay,
        canvasWrap: canvasWrap,
        dataEdit: dataEdit,
        enterDrawing: enterDrawing,
        onCanvasDown: onCanvasDown,
        onCanvasHover: onCanvasHover,
        edgeMode: edgeMode,
        hoverBoundary: hoverBoundary,
      };
      canvas = drawer.renderCanvas(canvas, store.doc, layout, wds);
      cursor = wds.cursor;
      selection = wds.selection;
      // The toolbar reads `selection`; this repaint can change it (fix round 1).
      paintSelectionState(store.doc, layout);
    }

    /**
     * The `doc.edge` index the press landed on, or `null`.
     *
     * Two questions, in order, both against `geometry.edgeLayout(store.doc,
     * layout)` computed fresh here — the same recompute-don't-cache rule
     * `cellFromEvent`/`geometry.cellAt` already follow, so a press can never
     * be judged against a layout `renderCanvas` has moved on from:
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
     *      endpoint (see `onCanvasDown`'s `busLabelHitAt` check, which now
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
      if (canvas === null) return null;
      const edges = geometry.edgeLayout(store.doc, layout);
      if (edges.length === 0) return null;
      const box = canvas.getBoundingClientRect();
      const handle = geometry.edgeHandleAt(edges, ev.clientX - box.left, ev.clientY - box.top);
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
     * The `.ed-wave-buslabel` mark under a press, or `null` — final review
     * finding 4.
     *
     * NOT `ev.target`: `renderEdges` draws `.ed-wave-edge-hit` (invisible,
     * `pointer-events: stroke`, 10px wide) AFTER every lane's own content, so
     * whenever an edge's endpoint lands on a bus cell, that stroke paints ON
     * TOP of the cell's own label mark — `ev.target` at that pixel is the
     * edge-hit path, never the label underneath it, and no amount of
     * reordering the CALLS in `onCanvasDown` changes that, because `ev.target`
     * is the browser's own topmost-element answer, decided at dispatch time
     * by paint order, not by which `if` this file happens to ask first.
     * MEASURED against a real page: moving the bus-label check ahead of
     * `edgeHitAt` while still reading `ev.target` left the label unreachable,
     * identically to before.
     *
     * `document.elementsFromPoint` (plural — distinct from the singular
     * `elementFromPoint` `edgeHitAt` above reads) answers a different
     * question: the WHOLE stack of elements under the point, in z-order, not
     * only the topmost one. Walking it for a `.ed-wave-buslabel` finds the
     * mark even when something else is painted over it, which is exactly
     * this finding's fix. The walk stops at `canvas` itself so a label-shaped
     * class elsewhere in the document (outside the canvas this press is
     * even inside) can never match.
     *
     * Falls back to the old `ev.target`-only check when `elementsFromPoint`
     * is not available at all (older engines) — that keeps every OTHER bus
     * label (the overwhelming majority, which do not sit under an edge's
     * endpoint) working exactly as it always has; only the overlap case this
     * finding is about stays unfixed on such an engine.
     */
    function busLabelHitAt(ev) {
      function isLabel(el) {
        return el !== null && el !== undefined && typeof el.classList === 'object' &&
          el.classList !== null && el.classList.contains('ed-wave-buslabel');
      }
      if (typeof d.elementsFromPoint === 'function') {
        const stack = d.elementsFromPoint(ev.clientX, ev.clientY);
        for (const el of stack) {
          if (isLabel(el)) return el;
          if (el === canvas) break;
        }
        return null;
      }
      return isLabel(ev.target) ? ev.target : null;
    }

    // Mounted BEFORE the first paint, not after: the preview is rendered by the
    // engine's own `RenderWaveForm`, which resolves its target with
    // `getElementById` — an element that is not in the document yet is not
    // findable, and the engine's failure there is a null dereference several
    // frames away from the cause. Measured: rendering first left every preview
    // reading `failed` with "Cannot read properties of null".
    lockScroll();
    host.appendChild(overlay);
    panel.focus();
    render();
    // The opening line described a pointer and only a pointer, which is how a
    // surface ends up with no keyboard: the instructions never mentioned one.
    //
    // v3.6.0 Task 16 fix round 1 applies that same reasoning to this task's
    // own gesture. Reordering a lane became keyboard-reachable here, and the
    // only place that said so was a HOVER tooltip on the rail's drag handle
    // — a `<span>` with deliberately no focus key, i.e. the one surface a
    // keyboard user can never read. This is a one-shot line, not the
    // per-move announcement `sayCursor` owns, so a hint belongs in it (see
    // `sayCursor`'s own docstring for why the same hint may NOT go there).
    //
    // fix round 3 re-points the last clause. Round 1 wrote it as an EXCEPTION
    // ("武裝關聯線之後，左右鍵改成在轉態點之間跳") because round 0's binding
    // really did change what two keys this same sentence had just promised.
    // Round 3 moved the jump to Alt+←/→, so the promise above holds in every
    // state and the clause is now an extra key rather than a retraction.
    panels.say('選一個電位，然後在波形上按住拖過去；或直接按方向鍵進波形，' +
      'Shift+左右鍵選一段，再按電位字元塗上去。' +
      'Alt+↑／Alt+↓ 把選取的 lane 往上下搬；' +
      '武裝關聯線之後，Alt+左右鍵可以在轉態點之間跳。');

    return {
      el: overlay,
      store: store,
      close: close,
      refresh: render,
      lastPatch: function () { return lastPatch; },
    };
  }

  return {
    createWaveEditor: createWaveEditor,
    mountedInsideContent: mountedInsideContent,
    BRUSHES: BRUSHES,
    isBrushKey: isBrushKey,
    SIZES: SIZES,
  };
});
