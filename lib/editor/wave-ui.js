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
 * `opts.document`). That is also why this file names no global of its own: the
 * layer that knows which `document` and which engine build are in play is
 * client.js, and it is the only one that should be deciding.
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

  /** The brush palette, exactly the set the spec names, in that order. */
  const BRUSHES = ['0', '1', 'x', 'z', 'p', 'n', 'h', 'l', 'u', 'd', '='];

  /** Drawing sizes. Handed to `wave-geometry` so the hit test and the paint
   *  cannot drift; nothing here re-derives a row position. */
  const SIZES = { laneHeight: 34, cycleWidth: 48, nameColWidth: 0 };

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

  /**
   * A plain, unfrozen copy of a document.
   *
   * The store's documents are deep-frozen — that is what stops a stray write
   * from corrupting an undo entry — and wavedrom's renderer WRITES INTO the
   * source object it is handed. Under this file's strict prologue that is a
   * throw, so the preview gets its own copy every time. Bounded by the codec's
   * own nesting ceiling so a pathological document cannot run the stack out
   * here either.
   */
  function plainCopy(value, depth) {
    if (depth > 64 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      const out = [];
      for (let i = 0; i < value.length; i++) out.push(plainCopy(value[i], depth + 1));
      return out;
    }
    const out = {};
    for (const key of Object.keys(value)) out[key] = plainCopy(value[key], depth + 1);
    return out;
  }

  /** Line and column of a byte offset, 1-based — what a parse failure has to
   *  say beyond its own message for the offset to mean anything to a person. */
  function whereIs(text, offset) {
    const upto = String(text).slice(0, Math.max(0, offset | 0));
    const lines = upto.split(/\r\n|\r|\n/);
    return { line: lines.length, column: lines[lines.length - 1].length + 1 };
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

  function valueAt(doc, path) {
    let node = doc;
    for (const seg of path) {
      if (node === null || typeof node !== 'object') return undefined;
      node = node[seg];
    }
    return node;
  }

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

    const store = opts.createStore(opts.source);

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
    // The rail's rename field while it is open — this editor's ONE sub-panel,
    // and therefore what the first Escape closes. Before this, Escape typed at
    // a rename field ran `close('escape')` and threw the WHOLE session away,
    // which is the most expensive answer available to「我改名改到一半不想改了」.
    let groupRename = null;

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
        else say('沒有可以復原的動作');
        return;
      }
      if (key === 'y' || (key === 'z' && ev.shiftKey)) {
        ev.preventDefault();
        ev.stopPropagation();
        if (store.redo()) afterStoreMoved('redo');
        else say('沒有可以重做的動作');
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
    const closeBtn = d.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ed-wave-close';
    closeBtn.textContent = '關閉';
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

    function toolButton(cls, label, hint, fn) {
      const b = d.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.setAttribute('data-focus-key', cls);
      b.textContent = label;
      b.title = hint;
      b.addEventListener('click', fn);
      cycleBar.appendChild(b);
      return b;
    }

    toolButton('ed-wave-cycle-insert', '插入 cycle',
      '在選取的位置插入一個 cycle（每一條 lane 同時加寬，不會有人掉隊）', function () {
        const at = selection === null ? 0 : Math.min(selection.from, selection.to);
        commit('insert-cycle', function (doc) { return codec.insertCycles(doc, at, 1); });
      });
    toolButton('ed-wave-cycle-delete', '刪除 cycle',
      '刪掉選取的 cycle（每一條 lane 同時變窄）', function () {
        if (selection === null) { say('先選一段 cycle 再刪'); return; }
        const from = Math.min(selection.from, selection.to);
        const count = Math.abs(selection.to - selection.from) + 1;
        commit('delete-cycle', function (doc) { return codec.deleteCycles(doc, from, count); });
      });
    toolButton('ed-wave-cycle-copy', '複製',
      '把選取的 cycle 從每一條 lane 上拷一份', function () {
        if (selection === null) { say('先選一段 cycle 再複製'); return; }
        const from = Math.min(selection.from, selection.to);
        const count = Math.abs(selection.to - selection.from) + 1;
        clip = codec.copyCycles(store.doc, from, count);
        say('複製了 ' + count + ' 個 cycle');
        render();
      });
    toolButton('ed-wave-cycle-paste', '貼上（插入）',
      '把剪貼簿插進選取的位置', function () { pasteAt('insert'); });
    toolButton('ed-wave-cycle-paste-over', '貼上（覆蓋）',
      '用剪貼簿蓋掉選取位置起算的那幾個 cycle', function () { pasteAt('overwrite'); });

    function pasteAt(mode) {
      if (clip === null) { say('剪貼簿是空的'); return; }
      const at = selection === null ? 0 : Math.min(selection.from, selection.to);
      commit('paste-' + mode, function (doc) {
        return codec.pasteCycles(doc, at, clip, mode);
      });
    }

    const undoBtn = toolButton('ed-wave-undo', '復原', '退回上一個動作', function () {
      if (!store.undo()) { say('沒有可以復原的動作'); return; }
      afterStoreMoved('undo');
    });
    const redoBtn = toolButton('ed-wave-redo', '重做', '再做一次剛剛復原掉的動作', function () {
      if (!store.redo()) { say('沒有可以重做的動作'); return; }
      afterStoreMoved('redo');
    });

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
    // told so out loud by `renderUnmodelled()` below rather than drawn wrongly
    // in silence.
    const metaBar = d.createElement('div');
    metaBar.className = 'ed-wave-meta';
    toolbar.appendChild(metaBar);

    function metaField(cls, label, placeholder) {
      const wrap = d.createElement('label');
      wrap.className = 'ed-wave-metafield';
      const text = d.createElement('span');
      text.textContent = label;
      wrap.appendChild(text);
      const input = d.createElement('input');
      input.type = 'text';
      input.className = cls;
      input.setAttribute('data-focus-key', cls);
      input.placeholder = placeholder;
      wrap.appendChild(input);
      metaBar.appendChild(wrap);
      return input;
    }

    const headInput = metaField('ed-wave-head-text', 'head', '上方標題');
    const footInput = metaField('ed-wave-foot-text', 'foot', '下方標題');

    headInput.addEventListener('change', function () { commitBanner('head', headInput.value); });
    footInput.addEventListener('change', function () { commitBanner('foot', footInput.value); });

    // The "this drawing is not showing you everything" notice. Empty, and with
    // no box on screen, for the documents that carry none of the three.
    const unmodelled = d.createElement('div');
    unmodelled.className = 'ed-wave-unmodelled';
    unmodelled.hidden = true;
    toolbar.appendChild(unmodelled);

    function commitBanner(which, value) {
      commit(which, function (doc) {
        const had = doc[which];
        if (value === '' && (had === undefined || had === null)) return doc;
        const next = Object.assign({}, doc);
        next[which] = Object.assign({}, (had !== null && typeof had === 'object') ? had : {});
        next[which].text = value;
        return next;
      });
    }

    // ── body: lane list | drawing | preview ───────────────────────────────
    const body = d.createElement('div');
    body.className = 'ed-wave-body';
    panel.appendChild(body);

    const laneCol = d.createElement('div');
    laneCol.className = 'ed-wave-lanes';
    body.appendChild(laneCol);

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

    const status = d.createElement('div');
    status.className = 'ed-wave-status';
    // Everything this dialog says back — where the cursor is, what a gesture
    // did, why one was refused — is written here and nowhere else, so it is
    // the one place that has to be announced rather than merely painted.
    status.setAttribute('role', 'status');
    panel.appendChild(status);

    function say(text) {
      status.textContent = text;
      overlay.setAttribute('data-wave-status', text);
    }

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
        say('這個動作沒有改變任何東西');
        return false;
      }
      gestures++;
      afterStoreMoved(name);
      return true;
    }

    function afterStoreMoved(name) {
      if (closed) return;
      lastPatch = store.toPatch();
      render();
      if (lastPatch.ok === true) {
        say('已寫回：' + name);
      } else {
        say('這個改動沒辦法只改幾個位元組寫回去：' + lastPatch.reason);
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
     */
    function render() {
      const before = focusMark();
      const doc = store.doc;
      const layout = geometry.layoutOf(doc, SIZES);
      renderLanes(doc, layout);
      renderCanvas(doc, layout);
      renderPreview(doc);
      renderMeta(doc);
      renderUnmodelled(doc);
      undoBtn.disabled = !store.canUndo();
      redoBtn.disabled = !store.canRedo();
      overlay.setAttribute('data-wave-gestures', String(gestures));
      overlay.setAttribute('data-wave-lanes', String(layout.lanes.length));
      overlay.setAttribute('data-wave-cycles', String(layout.cycles));
      overlay.setAttribute('data-wave-dirty', store.isDirty() ? '1' : '0');
      overlay.setAttribute('data-wave-patch',
        lastPatch === null ? 'none' : (lastPatch.ok === true ? 'ok' : 'refused'));
      paintBrushState();
      restoreFocus(before);
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
      const el = overlay.querySelector('[data-focus-key="' + want + '"]');
      if (el === null) return;
      el.focus();
      if (mark === null || mark.key !== want) return;
      if (mark.start === null || typeof el.setSelectionRange !== 'function') return;
      const n = typeof el.value === 'string' ? el.value.length : 0;
      try {
        el.setSelectionRange(Math.min(mark.start, n), Math.min(mark.end, n));
      } catch (e) { /* not a text field */ }
    }

    function renderMeta(doc) {
      const h = doc.head;
      const f = doc.foot;
      headInput.value = (h !== null && typeof h === 'object' && typeof h.text === 'string')
        ? h.text : '';
      footInput.value = (f !== null && typeof f === 'object' && typeof f.text === 'string')
        ? f.text : '';
    }

    /**
     * Say out loud which properties of this document the drawing is not
     * showing.
     *
     * `config.hscale`, and a lane's `period` / `phase`, all change what the
     * engine paints and none of them is modelled here (see the toolbar comment
     * for the measurements). Drawing a confident picture that ignores them is
     * the failure this whole overlay is arranged to avoid, so a document that
     * carries any of them says so, names them, and points at the preview —
     * which IS faithful, because it is the engine.
     */
    function renderUnmodelled(doc) {
      const found = [];
      const cfg = doc.config;
      if (cfg !== null && typeof cfg === 'object' && cfg.hscale !== undefined) {
        found.push('config.hscale');
      }
      for (const path of codec.lanePaths(doc)) {
        const lane = valueAt(doc, path);
        if (lane === null || typeof lane !== 'object') continue;
        if (lane.period !== undefined && found.indexOf('period') === -1) found.push('period');
        if (lane.phase !== undefined && found.indexOf('phase') === -1) found.push('phase');
      }
      overlay.setAttribute('data-wave-unmodelled', found.join(' '));
      unmodelled.hidden = found.length === 0;
      unmodelled.textContent = found.length === 0 ? '' :
        '這份文件用了 ' + found.join('、') +
        '，左邊的手繪波形不表現它們（寬度與相位會不一樣）——以右邊的 WaveDrom 預覽為準。';
    }

    /**
     * The lane list.
     *
     * Rows are `layout.laneHeight` tall and in `layout.lanes` order, so row k
     * here and row k of the drawing are the same lane by construction rather
     * than by a second traversal that could disagree.
     */
    function renderLanes(doc, layout) {
      laneCol.textContent = '';
      const rows = d.createElement('div');
      rows.className = 'ed-wave-lane-rows';
      rows.style.height = layout.height + 'px';
      laneCol.appendChild(rows);

      // Group titles first, so they sit UNDER the rows in paint order and a
      // lane's own controls stay clickable over them.
      for (const span of groupSpansOf(doc, layout)) {
        const tag = d.createElement('button');
        tag.type = 'button';
        tag.className = 'ed-wave-group';
        tag.setAttribute('data-focus-key', 'group-' + span.from);
        tag.textContent = span.title;
        tag.title = '群組「' + span.title + '」——點一下改名';
        tag.setAttribute('data-group-from', String(span.from));
        tag.setAttribute('data-group-to', String(span.to));
        tag.style.top = (span.from * layout.laneHeight) + 'px';
        tag.style.height = ((span.to - span.from + 1) * layout.laneHeight) + 'px';
        tag.style.left = ((span.depth - 1) * 16) + 'px';
        tag.addEventListener('click', function () { renameGroup(span); });
        rows.appendChild(tag);
      }

      for (let i = 0; i < layout.lanes.length; i++) {
        rows.appendChild(laneRow(doc, layout, i));
      }
      // The tail insert. `laneInsertPath(doc, laneCount)` goes on the end of
      // `signal` itself, which is what makes the group asymmetry visible here
      // rather than surprising afterwards.
      rows.appendChild(insertButton(doc, layout.lanes.length, layout, true));
    }

    function laneRow(doc, layout, i) {
      const row = d.createElement('div');
      row.className = 'ed-wave-lane-row';
      row.setAttribute('data-lane', String(i));
      row.style.top = (i * layout.laneHeight) + 'px';
      row.style.height = layout.laneHeight + 'px';
      row.style.paddingLeft = (layout.lanes[i].depth * 16) + 'px';
      if (selection !== null && selection.laneIndex === i) row.classList.add('is-selected');

      row.appendChild(insertButton(doc, i, layout, false));

      const name = d.createElement('input');
      name.type = 'text';
      name.className = 'ed-wave-lane-name';
      name.setAttribute('data-focus-key', 'lane-name-' + i);
      const lane = layout.lanes[i].lane;
      name.value = typeof lane.name === 'string' ? lane.name : '';
      name.addEventListener('change', function () {
        commit('rename', function (doc2) { return codec.renameLane(doc2, i, name.value); });
      });
      row.appendChild(name);

      const up = d.createElement('button');
      up.type = 'button';
      up.className = 'ed-wave-lane-up';
      up.setAttribute('data-focus-key', 'lane-up-' + i);
      up.textContent = '▲';
      up.title = '往上移一格';
      up.disabled = i === 0;
      up.addEventListener('click', function () {
        // The button this lane arrives at, EXCEPT at the top, where `lane-up-0`
        // is disabled and `.focus()` on it is inert — measured, walking a lane
        // to the top with three ▲ put the cursor on `lane-up-2`, `lane-up-1`
        // and then BODY, which is the state F7 exists to prevent and the fourth
        // press then did nothing at all. At the top the cursor goes to the one
        // control on that row that is never disabled there: ▼.
        focusOverride = i - 1 === 0 ? 'lane-down-0' : 'lane-up-' + (i - 1);
        commit('move', function (doc2) { return codec.moveLane(doc2, i, i - 1); });
      });
      row.appendChild(up);

      const down = d.createElement('button');
      down.type = 'button';
      down.className = 'ed-wave-lane-down';
      down.setAttribute('data-focus-key', 'lane-down-' + i);
      down.textContent = '▼';
      down.title = '往下移一格';
      down.disabled = i === layout.lanes.length - 1;
      down.addEventListener('click', function () {
        // Mirror of ▲ above: `lane-down-<last>` is disabled, so the bottom row
        // hands the cursor to ▲ instead.
        focusOverride = i + 1 === layout.lanes.length - 1
          ? 'lane-up-' + (i + 1) : 'lane-down-' + (i + 1);
        commit('move', function (doc2) { return codec.moveLane(doc2, i, i + 1); });
      });
      row.appendChild(down);

      const del = d.createElement('button');
      del.type = 'button';
      del.className = 'ed-wave-lane-remove';
      del.setAttribute('data-focus-key', 'lane-remove-' + i);
      del.textContent = '✕';
      del.title = '刪掉這條 lane（如果群組因此空掉，群組也會一起走）';
      del.addEventListener('click', function () {
        selection = null;
        // The row this button belongs to is about to stop existing, so the
        // keyboard goes to the ＋ that occupies that position instead — the
        // one control at that spot that survives every removal, tail included.
        focusOverride = 'lane-add-' + i;
        commit('remove-lane', function (doc2) { return codec.removeLane(doc2, i); });
      });
      row.appendChild(del);
      return row;
    }

    /**
     * Where a lane inserted at display position `index` would actually land,
     * asked of the bridge rather than guessed.
     *
     * This is constraint 4 made visible. `laneInsertPath` puts an insert at a
     * group's FIRST lane inside that group, and an insert at the position just
     * past its LAST lane outside it — a group can be joined at its head and
     * never at its tail. That asymmetry is not something a label can argue
     * away, so the label states it: the button says which container it will
     * land in, before it is pressed, and the status line says it again after.
     */
    function landingOf(doc, index) {
      const path = codec.laneInsertPath(doc, index);
      if (path === null) return { path: null, title: null };
      const container = path.slice(0, path.length - 1);
      const held = valueAt(doc, container);
      const title = Array.isArray(held) && typeof held[0] === 'string' ? held[0] : null;
      return { path: path, title: title };
    }

    function insertButton(doc, index, layout, isTail) {
      const b = d.createElement('button');
      b.type = 'button';
      b.className = isTail ? 'ed-wave-lane-add ed-wave-lane-add-tail' : 'ed-wave-lane-add';
      b.textContent = '＋';
      b.setAttribute('data-insert-at', String(index));
      b.setAttribute('data-focus-key', 'lane-add-' + index);
      const landing = landingOf(doc, index);
      const where = landing.title === null ? '群組外' : '群組「' + landing.title + '」裡';
      b.setAttribute('data-lands-in', landing.title === null ? '' : landing.title);
      b.title = '在這裡加一條 lane —— 會落在' + where;
      if (isTail) {
        b.style.top = (layout.lanes.length * layout.laneHeight) + 'px';
      }
      b.addEventListener('click', function () {
        // Straight into the new lane's name field: it is what the user is going
        // to type next, and it is the only control the new row introduces.
        focusOverride = 'lane-name-' + index;
        const added = commit('add-lane', function (doc2) {
          return codec.addLane(doc2, index, { name: '', wave: 'x' });
        });
        if (added) say('新增的 lane 落在' + where);
      });
      return b;
    }

    function renameGroup(span) {
      const input = d.createElement('input');
      input.type = 'text';
      input.className = 'ed-wave-group-input';
      input.setAttribute('data-focus-key', 'group-input-' + span.from);
      input.value = span.title;
      const finish = function () {
        // Once. `change` and `blur` both fire for a field the user commits with
        // Enter, and Escape's cancel below takes the field off screen — which
        // is a blur too. Whoever gets here first owns the gesture; the flag is
        // also how `cancel()` tells this one not to run.
        if (groupRename === null) return;
        groupRename = null;
        const value = input.value;
        if (value === span.title) { render(); return; }
        focusOverride = 'group-' + span.from;
        commit('rename-group', function (doc2) {
          return replaceAt(doc2, span.path.concat([0]), value);
        });
      };
      // Escape's half of the layering: the field goes, the name does not
      // change, the session stands, and the keyboard goes back to the rail tag
      // the field was covering — never to `document.body`, which is the state
      // the whole of this task exists to make unreachable.
      const cancel = function () {
        if (groupRename === null) return;
        groupRename = null;
        focusOverride = 'group-' + span.from;
        render();
      };
      input.addEventListener('change', finish);
      input.addEventListener('blur', finish);
      const rows = laneCol.querySelector('.ed-wave-lane-rows');
      const tag = rows.querySelector('.ed-wave-group[data-group-from="' + span.from + '"]');
      if (tag !== null) {
        input.style.top = tag.style.top;
        input.style.left = tag.style.left;
        rows.replaceChild(input, tag);
        // Two facts, and only the two that are read: that a rename is standing
        // (this being non-null) and how to take it back down. A copy of the
        // span or of the field itself would be a second record of something
        // the closure above already holds.
        groupRename = { cancel: cancel };
        input.focus();
        input.select();
      }
    }

    /**
     * A copy of `doc` with one scalar replaced, for the two fields the codec's
     * lane operations do not cover (a group's own title).
     *
     * Structure-sharing everywhere it does not have to copy, so the store's
     * lane-identity bookkeeping still sees every untouched lane as the same
     * object — `remapOrigins` answers a content edit by position and a
     * structural one by identity, and a wholesale clone here would make an
     * ordinary rename look like a structural change.
     */
    function replaceAt(node, path, value) {
      if (path.length === 0) return value;
      const seg = path[0];
      const child = replaceAt(node[seg], path.slice(1), value);
      if (Array.isArray(node)) {
        const out = node.slice();
        out[seg] = child;
        return out;
      }
      const out = Object.assign({}, node);
      out[seg] = child;
      return out;
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
     */
    function renderCanvas(doc, layout) {
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
      canvasWrap.textContent = '';
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

      // cycle grid
      for (let c = 0; c <= layout.cycles; c++) {
        const g = d.createElementNS(SVGNS, 'line');
        g.setAttribute('class', 'ed-wave-grid');
        g.setAttribute('x1', String(c * layout.cycleWidth));
        g.setAttribute('x2', String(c * layout.cycleWidth));
        g.setAttribute('y1', '0');
        g.setAttribute('y2', String(layout.height));
        canvas.appendChild(g);
      }

      for (let i = 0; i < layout.lanes.length; i++) {
        drawLane(canvas, layout, i);
      }

      if (selection !== null) {
        const from = Math.min(selection.from, selection.to);
        const to = Math.max(selection.from, selection.to);
        const box = d.createElementNS(SVGNS, 'rect');
        box.setAttribute('class', 'ed-wave-selection');
        box.setAttribute('x', String(from * layout.cycleWidth));
        box.setAttribute('y', String(selection.laneIndex * layout.laneHeight));
        box.setAttribute('width', String((to - from + 1) * layout.cycleWidth));
        box.setAttribute('height', String(layout.laneHeight));
        canvas.appendChild(box);
      }

      // The keyboard's cell, drawn last so it is over the selection tint and
      // over the trace. Its geometry comes from `wave-geometry.cellRect` — the
      // inverse of the hit test the pointer uses — so the cell the cursor is
      // DRAWN on and the cell an edit lands in cannot drift apart.
      if (cursor !== null) {
        const cell = geometry.cellRect(layout, cursor.laneIndex, cursor.cycle);
        if (cell !== null) {
          const cur = d.createElementNS(SVGNS, 'rect');
          cur.setAttribute('class', 'ed-wave-cursor');
          cur.setAttribute('data-ed-wave-cursor', '');
          cur.setAttribute('data-cell', cursor.laneIndex + ',' + cursor.cycle);
          cur.setAttribute('x', String(cell.x));
          cur.setAttribute('y', String(cell.y));
          cur.setAttribute('width', String(cell.width));
          cur.setAttribute('height', String(cell.height));
          canvas.appendChild(cur);
        }
      }
      // The same value on the overlay, written in the same statement sequence
      // that draws the rect so the two cannot say different things: it is what
      // a scenario reads when the rect is not the thing under test, and it is
      // the only record left when the cursor has none (an empty document).
      overlay.setAttribute('data-wave-cursor',
        cursor === null ? '' : cursor.laneIndex + ',' + cursor.cycle);

      canvas.addEventListener('mousedown', onCanvasDown);
      // Tabbing onto the drawing is an entry like any other, so it puts the
      // cursor on screen rather than leaving a focused surface with no visible
      // cursor in it. Re-entrant only once: `enterDrawing()` repaints, the
      // repaint re-focuses the new canvas and fires this again, and by then
      // `cursor` is set.
      canvas.addEventListener('focus', function () {
        if (cursor === null) enterDrawing();
      });
      canvasWrap.appendChild(canvas);
      if (hadFocus) canvas.focus();
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
      // `data-wave-<i>` cannot carry the difference between "no `wave` key" and
      // `wave: ''` — both are the empty string — and that difference is exactly
      // what the engine draws differently, so it gets its own attribute.
      svg.setAttribute('data-haswave-' + i, hasWave ? '1' : '0');
      svg.setAttribute('data-wave-' + i, wave);
      svg.setAttribute('data-levels-' + i, levels.join(''));
      svg.setAttribute('data-bricks-' + i, bricks.join(' '));
      svg.setAttribute('data-gaps-' + i, gaps.join(' '));

      const hi = row.y + 7;
      const lo = row.y + row.height - 9;
      const mid = (hi + lo) / 2;
      const cw = layout.cycleWidth;
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
        const x0 = run.from * cw;
        const x1 = (run.to + 1) * cw;
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
          const a = bandOf(runs[r - 1].brick);
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

      // The gap marker, last so it sits over the trace it interrupts. The
      // engine draws one per `|`; drawing none made the two pictures disagree
      // on a lane whose levels agreed exactly, which is the quietest form of
      // the disagreement this overlay exists to surface.
      for (const c of gaps) {
        const xm = (c + 0.5) * cw;
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

    // ── the keyboard on the drawing ───────────────────────────────────────
    /**
     * Every gesture the drawing has, without a pointer.
     *
     * The drawing was the one surface in this dialog a keyboard could not
     * operate AT ALL: painting was a mouse drag, and the cycle operations
     * (insert / delete / copy / paste) act on `selection`, which only a drag
     * could produce — so four toolbar buttons a keyboard user could Tab to and
     * press were dead on arrival, and the two that are not (insert / paste)
     * silently meant "at cycle 0". This is that `selection`, made with the
     * arrow keys.
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
      // A brush character both PICKS the brush and paints with it. Picking
      // without painting would need a second keystroke to do the thing the
      // user already said, and the toolbar's own brush buttons are still there
      // for「選起來待會再用」. `ev.shiftKey` is excluded so a shifted key can
      // never paint: with Shift the browser reports `H`, not `h`, and a brush
      // table that quietly lower-cased it would make Shift+arrow's neighbour
      // keys destructive.
      if (!ev.shiftKey && BRUSHES.indexOf(key) !== -1) {
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
      if (cursor === null) {
        cursor = { laneIndex: 0, cycle: 0 };
        selection = { laneIndex: 0, from: 0, to: 0 };
      }
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
      say('游標：' + name + ' cycle ' + (cursor.cycle + 1) + span +
        '（方向鍵移動，Shift+方向鍵選一段，按 ' + BRUSHES.join(' ') + ' 塗上去）');
    }

    /** The lane list and the drawing, repainted together and without touching
     *  the store or the preview: a cursor move changes no document content, so
     *  re-rendering the engine's preview beside it would be a round trip to
     *  paint the identical picture. The lane list IS repainted, because
     *  `.is-selected` on its rows is where "which lane am I on" is shown. */
    function repaintDrawing(layout) {
      const l = layout === undefined || layout === null
        ? geometry.layoutOf(store.doc, SIZES) : layout;
      renderLanes(store.doc, l);
      renderCanvas(store.doc, l);
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
      const at = cellFromEvent(ev, layout);
      if (at === null) return;
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
      renderCanvas(store.doc, layout);
      d.addEventListener('mousemove', onCanvasMove, true);
      d.addEventListener('mouseup', onCanvasUp, true);
    }

    function onCanvasMove(ev) {
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
      renderCanvas(store.doc, layout);
    }

    function onCanvasUp() {
      d.removeEventListener('mousemove', onCanvasMove, true);
      d.removeEventListener('mouseup', onCanvasUp, true);
      if (drag === null) return;
      const g = drag;
      drag = null;
      commit('paint', function (doc) {
        return codec.setCellRange(doc, g.laneIndex, g.from, g.to, brush);
      });
    }

    /** Pointer coordinates in the drawing's own space, then the codec's cell. */
    function cellFromEvent(ev, layout) {
      if (canvas === null) return null;
      const box = canvas.getBoundingClientRect();
      return geometry.cellAt(layout, ev.clientX - box.left, ev.clientY - box.top);
    }

    // ── the preview ───────────────────────────────────────────────────────
    /**
     * The engine's own rendering of the very same document.
     *
     * This is the check on the drawing, which is the only reason it is on
     * screen. It is rendered from a plain copy because wavedrom writes into the
     * source object it is handed and the store's documents are frozen.
     */
    function renderPreview(doc) {
      const engine = opts.wavedrom;
      if (engine === null || engine === undefined ||
          typeof engine.RenderWaveForm !== 'function') {
        previewHost.textContent = '（這一頁沒有載入 WaveDrom，預覽從缺）';
        previewWrap.setAttribute('data-wave-preview', 'absent');
        return;
      }
      try {
        // `notFirstSignal` means "the skin is already on this page, do not
        // emit it again". True whenever a WaveDrom render has already run here,
        // which is always in the flow that reaches this editor — the entry
        // affordance only appears over a RENDERED diagram. The fallback to
        // `false` is for the page where it somehow has not: emitting the skin
        // is only wasteful, while omitting one that is not there leaves every
        // `<use>` unresolvable and the preview blank, which is the one state
        // this panel may never be in.
        // `socket` is a bare, global, un-namespaced id that the engine's own
        // skin `<defs>` defines — so ask for it INSIDE a WaveDrom-rendered SVG's
        // defs rather than anywhere on the page. A document carrying inline
        // HTML with `id="socket"` would otherwise convince this that the skin is
        // present on a page where no diagram had rendered, and the preview would
        // come up blank: the one state this panel may never be in.
        const skinOnPage = d.querySelector('svg.WaveDrom defs #socket') !== null;
        engine.RenderWaveForm(PREVIEW_INDEX, plainCopy(doc, 0),
          PREVIEW_ID_PREFIX, skinOnPage);
        previewWrap.setAttribute('data-wave-preview', 'ok');
        previewWrap.setAttribute('data-wave-preview-skin', skinOnPage ? 'shared' : 'own');
      } catch (e) {
        previewHost.textContent = 'WaveDrom 畫不出這份文件：' + String(e && e.message);
        previewWrap.setAttribute('data-wave-preview', 'failed');
      }
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
    say('選一個電位，然後在波形上按住拖過去；或直接按方向鍵進波形，' +
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
    brickOf: brickOf,
    groupSpansOf: groupSpansOf,
    mountedInsideContent: mountedInsideContent,
    BRUSHES: BRUSHES,
    SIZES: SIZES,
  };
});
