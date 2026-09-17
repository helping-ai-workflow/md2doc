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
   *  here. */
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
  // callers; `groupSpansOf` and `valueAt` moved to `wave-geometry.js` per
  // ruling R9, since both `wave-panels.js` and `wave-draw.js` need them and
  // that module is the one place both already depend on.

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
    let selection = null;        // {laneIndex, from, to} — the cycles a gesture acts on
    let drag = null;             // live pointer drag, never pushed until mouseup
    let gestures = 0;
    let lastPatch = null;
    // Where the keyboard should end up after the NEXT repaint, when that is not
    // simply "wherever it was". A move button is the case that needs it: the
    // control the user pressed belongs to a row, and after the move the lane
    // they are pushing around is at a different row — so pressing ▲ twice has
    // to move the same lane twice, not two different ones.
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
    // v3.5.0 Task 12: which lane rows are Shift+click multi-selected on the
    // rail, for「建立群組」— an array of display-position integers, in
    // whatever order the clicks added them, or `null` when nothing is
    // picked (never `[]`; the empty case is collapsed to `null` the moment
    // the last member is toggled off, so every other mark's "is anything
    // standing" check — a plain `!== null` — stays true of this one too).
    //
    // This is a fourth mark of the exact family `pendingFrom`/`endpointDrag`
    // already are: a set of lanes the user has committed to for an upcoming
    // STRUCTURAL edit, named by row number, which a reorder or an undo/redo
    // can invalidate out from under it. So it is carried the same way —
    // widening `carryMarks`'s guard and its `rowOf` lookup rather than
    // growing a second belief about lane identity — and dropped the same
    // way: an entry that cannot be traced to a surviving lane is removed
    // from the set rather than left pointing at whatever now sits at that
    // row. `cursor`'s "leave the stale number, let `renderCanvas` clamp it"
    // is the wrong instinct here for the reason `pendingFrom`'s own comment
    // gives — this mark feeds a structural op (`groupLanes`) the moment the
    // button is pressed, not a screen position, and a stale member silently
    // renumbering onto an unrelated lane would group a lane the user never
    // selected with nothing on screen saying so.
    let laneMultiSelect = null;
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
    const toolbar = d.createElement('div');
    toolbar.className = 'ed-wave-toolbar';
    panel.appendChild(toolbar);

    const brushBar = d.createElement('div');
    brushBar.className = 'ed-wave-brushes';
    toolbar.appendChild(brushBar);
    const brushButtons = [];
    for (const ch of BRUSHES) {
      const b = d.createElement('button');
      b.type = 'button';
      b.className = 'ed-wave-brush';
      b.setAttribute('data-brush', ch);
      b.setAttribute('data-focus-key', 'brush-' + ch);
      b.textContent = ch;
      b.addEventListener('click', function () {
        brush = ch;
        paintBrushState();
      });
      brushBar.appendChild(b);
      brushButtons.push(b);
    }
    function paintBrushState() {
      for (const b of brushButtons) {
        b.classList.toggle('is-on', b.getAttribute('data-brush') === brush);
      }
      overlay.setAttribute('data-wave-brush', brush);
    }

    const cycleBar = d.createElement('div');
    cycleBar.className = 'ed-wave-cycleops';
    toolbar.appendChild(cycleBar);

    // v3.6.0 Task 2: the toolbar/right-hand-panels/lane-rail factory. Called
    // here, right after `cycleBar` exists (`toolButton` needs somewhere to
    // append into), which is BEFORE several elements its OTHER returned
    // functions need (`metaBar`'s own fields, the edge inspector, `laneCol`,
    // the preview host, `status`). `deps` is the same object referenced
    // below at each of those elements' own creation — see `deps.metaBar =`
    // etc. — and `wave-panels.js`'s own header explains why that is not a
    // reorder. `actions` is the callback bag for the `wave-ui.js`-owned state
    // a moved function still needs to read or write; see that same header
    // for what each entry is for and why `close` is not among them (nothing
    // that moved calls it).
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
        laneMultiSelectSet: function (value) { laneMultiSelect = value; },
      },
      cycleBar: cycleBar,
      overlay: overlay,
      panel: panel,
      PREVIEW_INDEX: PREVIEW_INDEX,
      PREVIEW_ID_PREFIX: PREVIEW_ID_PREFIX,
      wavedrom: opts.wavedrom,
    };
    const panels = opts.panels.createPanels(deps);

    panels.toolButton('ed-wave-cycle-insert', '插入 cycle',
      '在選取的位置插入一個 cycle（每一條 lane 同時加寬，不會有人掉隊）', function () {
        const at = selection === null ? 0 : Math.min(selection.from, selection.to);
        commit('insert-cycle', function (doc) { return codec.insertCycles(doc, at, 1); });
      });
    panels.toolButton('ed-wave-cycle-delete', '刪除 cycle',
      '刪掉選取的 cycle（每一條 lane 同時變窄）', function () {
        if (selection === null) { panels.say('先選一段 cycle 再刪'); return; }
        const from = Math.min(selection.from, selection.to);
        const count = Math.abs(selection.to - selection.from) + 1;
        commit('delete-cycle', function (doc) { return codec.deleteCycles(doc, from, count); });
      });
    panels.toolButton('ed-wave-cycle-copy', '複製',
      '把選取的 cycle 從每一條 lane 上拷一份', function () {
        if (selection === null) { panels.say('先選一段 cycle 再複製'); return; }
        const from = Math.min(selection.from, selection.to);
        const count = Math.abs(selection.to - selection.from) + 1;
        clip = codec.copyCycles(store.doc, from, count);
        panels.say('複製了 ' + count + ' 個 cycle');
        render();
      });
    panels.toolButton('ed-wave-cycle-paste', '貼上（插入）',
      '把剪貼簿插進選取的位置', function () { pasteAt('insert'); });
    panels.toolButton('ed-wave-cycle-paste-over', '貼上（覆蓋）',
      '用剪貼簿蓋掉選取位置起算的那幾個 cycle', function () { pasteAt('overwrite'); });

    function pasteAt(mode) {
      if (clip === null) { panels.say('剪貼簿是空的'); return; }
      const at = selection === null ? 0 : Math.min(selection.from, selection.to);
      commit('paste-' + mode, function (doc) {
        return codec.pasteCycles(doc, at, clip, mode);
      });
    }

    const undoBtn = panels.toolButton('ed-wave-undo', '復原', '退回上一個動作', function () {
      if (!store.undo()) { panels.say('沒有可以復原的動作'); return; }
      afterStoreMoved('undo');
    });
    const redoBtn = panels.toolButton('ed-wave-redo', '重做', '再做一次剛剛復原掉的動作', function () {
      if (!store.redo()) { panels.say('沒有可以重做的動作'); return; }
      afterStoreMoved('redo');
    });

    // v3.5.0 Task 12: wrap the current Shift+click multi-select (see
    // `laneMultiSelect` above, and `laneRow` below for the gesture itself)
    // into one new group. The codec is the one that decides contiguity —
    // this button does not pre-filter what is selectable, it only decides
    // whether there is enough of a selection to bother trying, so the
    // refusal message the user actually needed ("these lanes are not next
    // to each other") comes from `commit`'s own status line rather than
    // being silently swallowed here.
    //
    // The group is created with an EMPTY label and the rename field is
    // opened immediately — the same affordance `insertButton` already gives
    // a brand new lane (empty `name`, keyboard straight into the field) —
    // rather than a placeholder string the user has to notice and clear.
    const groupBtn = panels.toolButton('ed-wave-group-make', '建立群組',
      '把左邊用 Shift+點 選起來的那幾條連續 lane 包成一個新群組', function () {
        if (laneMultiSelect === null || laneMultiSelect.length < 2) {
          panels.say('先在左邊用 Shift+點 連續選至少兩條 lane，才有東西可以群組');
          return;
        }
        const ats = laneMultiSelect.slice().sort(function (a, b) { return a - b; });
        const minAt = ats[0];
        const committed = commit('group-lanes', function (doc2) {
          return codec.groupLanes(doc2, ats, '');
        });
        if (!committed) {
          panels.say('這幾條 lane 不連續（或選取已經失效），WaveJSON 的群組只能是連續的一段');
          return;
        }
        laneMultiSelect = null;
        // The commit above already repainted with the (now stale) highlight
        // showing; one more repaint clears it before handing the keyboard to
        // the rename field, the same two-step `renameGroup` itself already
        // is — a rebuild first, then the sub-panel laid over what it built.
        render();
        const layout = geometry.layoutOf(store.doc, SIZES);
        const spans = geometry.groupSpansOf(store.doc, layout);
        for (const span of spans) {
          if (span.from === minAt) { panels.renameGroup(span); break; }
        }
      });

    // v3.5.0 Task 7: arm the edge-creation gesture. One-shot in the sense
    // that a drag which PRODUCES an edge disarms it (`finishEdgeDrag` below);
    // pressing the button itself is a plain toggle, so a change of mind
    // before ever pressing on the canvas costs one more click, not Escape.
    const edgeBtn = panels.toolButton('ed-wave-edge-arm', '關聯線',
      '按一下武裝，然後從一格拖到另一格畫出關聯線（Escape 取消）', function () {
        setEdgeMode(edgeMode === 'idle' ? 'armed' : 'idle');
      });
    setEdgeMode('idle');

    // head / foot — the document-level fields this drawing can honour.
    //
    // `config.hscale` USED to be a third field here and has been removed. The
    // drawing does not model `hscale`, `period` or `phase` at all (zero
    // occurrences in wave-codec, wave-geometry or this file), and measured
    // against the pinned engine each of them changes what the engine paints
    // while leaving the drawing exactly as it was:
    //
    //     {wave:'0101'}                 engine 8 half-bricks   drawing 4 cycles
    //     {wave:'0101', period:2}       engine 16              drawing 4, unchanged
    //     {wave:'0101', phase:0.5}      engine 7               drawing 4, unshifted
    //     {wave:'0101'} config.hscale:2 engine 16              drawing 4, unchanged
    //
    // Shipping a CONTROL for a property the canvas ignores is the worst of the
    // three options: it invites the user to make the two pictures disagree and
    // then shows them a confident wrong one. Modelling the three properly is
    // not a change this file may make on its own either — cycle width lives in
    // `wave-geometry`, which is closed and whose arithmetic Task 3 pinned, and
    // a half-model here would be a SECOND belief about cycle geometry in the
    // same tree, which is the exact failure this batch keeps producing.
    //
    // So: the control is gone, and a document that carries any of the three is
    // told so out loud by `panels.renderUnmodelled()` below rather than drawn wrongly
    // in silence.
    const metaBar = d.createElement('div');
    metaBar.className = 'ed-wave-meta';
    toolbar.appendChild(metaBar);
    // v3.6.0 Task 2: published onto `deps` (see its construction above, and
    // `wave-panels.js`'s own header) for `panels.metaField`'s lazy read —
    // `deps` was handed to `createPanels()` before `metaBar` existed.
    deps.metaBar = metaBar;

    const headInput = panels.metaField('ed-wave-head-text', 'head', '上方標題');
    const footInput = panels.metaField('ed-wave-foot-text', 'foot', '下方標題');
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
    // readability reason.
    const headTickInput = panels.metaField('ed-wave-head-tick', 'head.tick', '起始刻度，例如 0');
    const headTockInput = panels.metaField('ed-wave-head-tock', 'head.tock', '半格刻度起始值，例如 0');
    const headEveryInput = panels.metaField('ed-wave-head-every', 'head.every', '每幾格顯示一次刻度');
    const footTickInput = panels.metaField('ed-wave-foot-tick', 'foot.tick', '下方起始刻度，例如 0');
    const footTockInput = panels.metaField('ed-wave-foot-tock', 'foot.tock', '下方半格刻度起始值，例如 0');
    const footEveryInput = panels.metaField('ed-wave-foot-every', 'foot.every', '下方每幾格顯示一次刻度');
    // Published for `panels.renderMeta`'s lazy read, same reason as
    // `deps.metaBar` above.
    deps.headInput = headInput;
    deps.footInput = footInput;
    deps.headTickInput = headTickInput;
    deps.headTockInput = headTockInput;
    deps.headEveryInput = headEveryInput;
    deps.footTickInput = footTickInput;
    deps.footTockInput = footTockInput;
    deps.footEveryInput = footEveryInput;

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
    toolbar.appendChild(edgeBar);

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
    // `deps.metaBar` above.
    deps.unmodelled = unmodelled;
    deps.noSignal = noSignal;

    // ── body: lane list | drawing | preview ───────────────────────────────
    const body = d.createElement('div');
    body.className = 'ed-wave-body';
    panel.appendChild(body);

    const laneCol = d.createElement('div');
    laneCol.className = 'ed-wave-lanes';
    body.appendChild(laneCol);
    // Published for `panels.renderLanes`/`panels.renameGroup`'s lazy read,
    // same reason as `deps.metaBar` above.
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
    body.appendChild(previewWrap);
    // Published for `panels.renderPreview`'s lazy read, same reason as
    // `deps.metaBar` above.
    deps.previewWrap = previewWrap;
    deps.previewHost = previewHost;

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
      // v3.5.0 Task 12: `laneMultiSelect` joins the same guard for the same
      // reason again — a Shift+click multi-select standing while an unrelated
      // undo/redo or move lands underneath it is exactly this shape of gap,
      // just with a SET of row numbers instead of one.
      if (before === null ||
          (cursor === null && selection === null && pendingFrom === null &&
           endpointDrag === null && laneMultiSelect === null)) {
        return;
      }
      const trace = typeof opts.laneTrace === 'function'
        ? opts.laneTrace(before, nextDoc) : null;
      // No `laneTrace` injected: "I no longer know where you were" applies
      // to `pendingFrom` exactly as it already does to `cursor`/`selection`
      // — dropped, not guessed at. `endpointDrag` joins them: a drag naming
      // a lane nothing here can still vouch for is the same hazard either
      // way. `laneMultiSelect` is dropped wholesale here too, the same as
      // every other mark: with no trace at all there is nothing to check
      // any of its members against.
      if (trace === null) {
        cursor = null; selection = null; pendingFrom = null; endpointDrag = null;
        laneMultiSelect = null;
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
        const at = rowOf(selection.laneIndex);
        if (at !== null) {
          selection = { laneIndex: at, from: selection.from, to: selection.to };
        }
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
      // `laneMultiSelect` is a SET of marks of the same shape as
      // `pendingFrom.at` — each one a lane the user has already committed to
      // for the group they are about to build — carried and dropped the same
      // way, member by member rather than all-or-nothing: a reorder that
      // only invalidates ONE of several selected rows should not throw away
      // the rest of a selection the user is still building. An entry that
      // cannot be traced is removed rather than left on a stale number, for
      // the identical reason `pendingFrom` never keeps one either — a
      // structural op reads this set directly, not a screen position
      // `renderCanvas` re-clamps on every repaint. Emptied down to nothing,
      // it collapses to `null` so every other guard's plain `!== null` check
      // stays the whole truth about "is anything still selected".
      if (laneMultiSelect !== null) {
        const kept = [];
        for (let m = 0; m < laneMultiSelect.length; m++) {
          const at = rowOf(laneMultiSelect[m]);
          if (at !== null) kept.push(at);
        }
        laneMultiSelect = kept.length === 0 ? null : kept;
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
      // v3.5.0 Task 12: the same defensive clamp `selectedEdge` gets just
      // above, for a mark of its own row-number shape — belt to
      // `carryMarks`'s suspenders, not a replacement for it: `carryMarks`
      // is what keeps a member POINTING AT THE RIGHT LANE across an edit,
      // and runs before this on every path that reaches `render()`. This
      // only catches a member that is merely out of range for whatever
      // reason (there should not be one left standing; a repaint is cheap
      // insurance against a future caller of `render()` that forgets to
      // route through `afterStoreMoved` first).
      if (laneMultiSelect !== null) {
        const kept = [];
        for (let m = 0; m < laneMultiSelect.length; m++) {
          if (laneMultiSelect[m] >= 0 && laneMultiSelect[m] < layout.lanes.length) {
            kept.push(laneMultiSelect[m]);
          }
        }
        laneMultiSelect = kept.length === 0 ? null : kept;
      }
      panels.renderLanes(doc, layout, { selection: selection, laneMultiSelect: laneMultiSelect });
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
      };
      canvas = drawer.renderCanvas(canvas, doc, layout, wds);
      cursor = wds.cursor;
      selection = wds.selection;
      panels.renderEdgeBar(doc, { selectedEdge: selectedEdge });
      panels.renderPreview(doc);
      panels.renderMeta(doc);
      panels.renderUnmodelled(doc, layout);
      undoBtn.disabled = !store.canUndo();
      redoBtn.disabled = !store.canRedo();
      groupBtn.disabled = laneMultiSelect === null || laneMultiSelect.length < 2;
      overlay.setAttribute('data-wave-multiselect',
        laneMultiSelect === null ? '' : laneMultiSelect.slice().sort(function (a, b) {
          return a - b;
        }).join(','));
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
      let el = overlay.querySelector('[data-focus-key="' + want + '"]');
      // A named destination the repaint did not bring back. It happens: a
      // group's key is its first lane's row number, so inserting a lane above
      // it renumbers the key that a rename field had already nominated —
      // measured, `{overlay:1, input:0, key:null, tag:"BODY"}`. Fall back to
      // where the keyboard actually was, and failing that to the dialog
      // itself. Never to nothing: nothing is `document.body`, and this whole
      // task is about not ending there.
      if (el === null && mark !== null && mark.key !== want) {
        el = overlay.querySelector('[data-focus-key="' + mark.key + '"]');
      }
      if (el === null) {
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
     * with. Shift+↑/↓ collapses: a selection that spanned two lanes is not a
     * thing this document model has, so pretending with a highlight would be
     * the drawing telling the user something the codec cannot honour.
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
        selection = { laneIndex: lane, from: selection.from, to: cyc };
      } else {
        selection = { laneIndex: lane, from: cyc, to: cyc };
      }
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
      panels.renderLanes(store.doc, l, { selection: selection, laneMultiSelect: laneMultiSelect });
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
      };
      canvas = drawer.renderCanvas(canvas, store.doc, l, wds);
      cursor = wds.cursor;
      selection = wds.selection;
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
          };
          canvas = drawer.renderCanvas(canvas, store.doc, layout, wds);
          cursor = wds.cursor;
          selection = wds.selection;
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
            selection = { laneIndex: busAt.laneIndex, from: busTarget.cycle, to: busTarget.cycle };
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
              };
              canvas = drawer.renderCanvas(canvas, store.doc, layout, wds);
              cursor = wds.cursor;
              selection = wds.selection;
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
      selection = { laneIndex: at.laneIndex, from: at.cycle, to: at.cycle };
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
        };
        canvas = drawer.renderCanvas(canvas, store.doc, layout, wds);
        cursor = wds.cursor;
        selection = wds.selection;
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
        };
        canvas = drawer.renderCanvas(canvas, store.doc, layout, wds);
        cursor = wds.cursor;
        selection = wds.selection;
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
        if (at !== null) cursor = { laneIndex: at.laneIndex, cycle: at.cycle };
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
        };
        canvas = drawer.renderCanvas(canvas, store.doc, layout, wds);
        cursor = wds.cursor;
        selection = wds.selection;
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
      selection = { laneIndex: drag.laneIndex, from: drag.from, to: drag.to };
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
      };
      canvas = drawer.renderCanvas(canvas, store.doc, layout, wds);
      cursor = wds.cursor;
      selection = wds.selection;
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

    /** Pointer coordinates in the drawing's own space, then the codec's cell. */
    function cellFromEvent(ev, layout) {
      if (canvas === null) return null;
      const box = canvas.getBoundingClientRect();
      return geometry.cellAt(layout, ev.clientX - box.left, ev.clientY - box.top);
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
    panels.say('選一個電位，然後在波形上按住拖過去；或直接按方向鍵進波形，' +
      'Shift+左右鍵選一段，再按電位字元塗上去。');

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
