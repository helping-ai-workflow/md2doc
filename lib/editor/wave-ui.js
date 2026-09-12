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
   *   onClose()   called once, when the overlay goes away
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

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      d.removeEventListener('keydown', onKeyDown, true);
      if (typeof opts.onClose === 'function') opts.onClose();
    }

    function onKeyDown(ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); close(); }
    }
    d.addEventListener('keydown', onKeyDown, true);

    const panel = d.createElement('div');
    panel.className = 'ed-wave-panel';
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
    closeBtn.addEventListener('click', close);
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
      host.appendChild(overlay);
      return { el: overlay, store: store, close: close, refresh: function () {} };
    }

    overlay.setAttribute('data-wave-state', 'ready');

    // ── state that is the UI's own, not the document's ────────────────────
    let brush = '1';
    let clip = null;
    let selection = null;        // {laneIndex, from, to} — the cycles a gesture acts on
    let drag = null;             // live pointer drag, never pushed until mouseup
    let gestures = 0;
    let lastPatch = null;

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

    // head / foot / hscale — the document-level fields, edited in place.
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
      input.placeholder = placeholder;
      wrap.appendChild(input);
      metaBar.appendChild(wrap);
      return input;
    }

    const headInput = metaField('ed-wave-head-text', 'head', '上方標題');
    const footInput = metaField('ed-wave-foot-text', 'foot', '下方標題');
    const hscaleInput = metaField('ed-wave-hscale', 'hscale', '1');

    headInput.addEventListener('change', function () { commitBanner('head', headInput.value); });
    footInput.addEventListener('change', function () { commitBanner('foot', footInput.value); });
    hscaleInput.addEventListener('change', function () {
      const n = Number(hscaleInput.value);
      if (!isFinite(n) || n <= 0) { say('hscale 必須是一個大於 0 的數'); render(); return; }
      commit('hscale', function (doc) {
        const next = Object.assign({}, doc);
        next.config = Object.assign({}, doc.config || {});
        next.config.hscale = n;
        return next;
      });
    });

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
    previewHost.id = 'md2doc-wave-preview-0';
    previewWrap.appendChild(previewHost);
    body.appendChild(previewWrap);

    const status = d.createElement('div');
    status.className = 'ed-wave-status';
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

    function render() {
      const doc = store.doc;
      const layout = geometry.layoutOf(doc, SIZES);
      renderLanes(doc, layout);
      renderCanvas(doc, layout);
      renderPreview(doc);
      renderMeta(doc);
      undoBtn.disabled = !store.canUndo();
      redoBtn.disabled = !store.canRedo();
      overlay.setAttribute('data-wave-gestures', String(gestures));
      overlay.setAttribute('data-wave-lanes', String(layout.lanes.length));
      overlay.setAttribute('data-wave-cycles', String(layout.cycles));
      overlay.setAttribute('data-wave-dirty', store.isDirty() ? '1' : '0');
      overlay.setAttribute('data-wave-patch',
        lastPatch === null ? 'none' : (lastPatch.ok === true ? 'ok' : 'refused'));
      paintBrushState();
    }

    function renderMeta(doc) {
      const h = doc.head;
      const f = doc.foot;
      headInput.value = (h !== null && typeof h === 'object' && typeof h.text === 'string')
        ? h.text : '';
      footInput.value = (f !== null && typeof f === 'object' && typeof f.text === 'string')
        ? f.text : '';
      const cfg = doc.config;
      hscaleInput.value = (cfg !== null && typeof cfg === 'object' && cfg.hscale !== undefined)
        ? String(cfg.hscale) : '';
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
      const lane = layout.lanes[i].lane;
      name.value = typeof lane.name === 'string' ? lane.name : '';
      name.addEventListener('change', function () {
        commit('rename', function (doc2) { return codec.renameLane(doc2, i, name.value); });
      });
      row.appendChild(name);

      const up = d.createElement('button');
      up.type = 'button';
      up.className = 'ed-wave-lane-up';
      up.textContent = '▲';
      up.title = '往上移一格';
      up.disabled = i === 0;
      up.addEventListener('click', function () {
        commit('move', function (doc2) { return codec.moveLane(doc2, i, i - 1); });
      });
      row.appendChild(up);

      const down = d.createElement('button');
      down.type = 'button';
      down.className = 'ed-wave-lane-down';
      down.textContent = '▼';
      down.title = '往下移一格';
      down.disabled = i === layout.lanes.length - 1;
      down.addEventListener('click', function () {
        commit('move', function (doc2) { return codec.moveLane(doc2, i, i + 1); });
      });
      row.appendChild(down);

      const del = d.createElement('button');
      del.type = 'button';
      del.className = 'ed-wave-lane-remove';
      del.textContent = '✕';
      del.title = '刪掉這條 lane（如果群組因此空掉，群組也會一起走）';
      del.addEventListener('click', function () {
        selection = null;
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
      const landing = landingOf(doc, index);
      const where = landing.title === null ? '群組外' : '群組「' + landing.title + '」裡';
      b.setAttribute('data-lands-in', landing.title === null ? '' : landing.title);
      b.title = '在這裡加一條 lane —— 會落在' + where;
      if (isTail) {
        b.style.top = (layout.lanes.length * layout.laneHeight) + 'px';
      }
      b.addEventListener('click', function () {
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
      input.value = span.title;
      const finish = function () {
        const value = input.value;
        if (value === span.title) { render(); return; }
        commit('rename-group', function (doc2) {
          return replaceAt(doc2, span.path.concat([0]), value);
        });
      };
      input.addEventListener('change', finish);
      input.addEventListener('blur', finish);
      const rows = laneCol.querySelector('.ed-wave-lane-rows');
      const tag = rows.querySelector('.ed-wave-group[data-group-from="' + span.from + '"]');
      if (tag !== null) {
        input.style.top = tag.style.top;
        input.style.left = tag.style.left;
        rows.replaceChild(input, tag);
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
      canvasWrap.textContent = '';
      canvas = d.createElementNS(SVGNS, 'svg');
      canvas.setAttribute('class', 'ed-wave-canvas');
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

      canvas.addEventListener('mousedown', onCanvasDown);
      canvasWrap.appendChild(canvas);
    }

    function drawLane(svg, layout, i) {
      const row = layout.lanes[i];
      const lane = row.lane;
      const levels = codec.levelsOf(typeof lane.wave === 'string' ? lane.wave : '');
      const bricks = levels.map(brickOf);
      svg.setAttribute('data-wave-' + i, typeof lane.wave === 'string' ? lane.wave : '');
      svg.setAttribute('data-levels-' + i, levels.join(''));
      svg.setAttribute('data-bricks-' + i, bricks.join(' '));

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
      renderCanvas(store.doc, layout);
      d.addEventListener('mousemove', onCanvasMove, true);
      d.addEventListener('mouseup', onCanvasUp, true);
    }

    function onCanvasMove(ev) {
      if (drag === null) return;
      const layout = geometry.layoutOf(store.doc, SIZES);
      const at = cellFromEvent(ev, layout);
      if (at === null) return;
      // The lane is fixed by the press: a drag that strays onto a neighbour is
      // still painting the lane it started on.
      drag.to = at.cycle;
      selection = { laneIndex: drag.laneIndex, from: drag.from, to: drag.to };
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
        engine.RenderWaveForm(0, plainCopy(doc, 0), 'md2doc-wave-preview-', false);
        previewWrap.setAttribute('data-wave-preview', 'ok');
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
    host.appendChild(overlay);
    render();
    say('選一個電位，然後在波形上按住拖過去。');

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
