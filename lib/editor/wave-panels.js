'use strict';

/**
 * wave-panels — the toolbar, the right-hand panels (meta fields, the edge
 * inspector) and the lane rail. Moved out of `wave-ui.js`, behaviour
 * unchanged line for line — this module is a pure move, not a rewrite.
 *
 * Plain CommonJS, like `wave-codec.js` / `wave-geometry.js` / `wave-store.js`
 * / `wave-draw.js` next to it, and for the identical reason `wave-draw.js`'s
 * own header already gives: `wave-ui.js` is injected into the edit page as a
 * bare `<script>` with no `require()` of its own, so a UMD header here would
 * be reaching for a `require` that is undefined in the browser. `wave-ui.js`
 * takes this module in as `opts.panels` (see `lib/editor/server.js`'s shim
 * and `lib/editor/client.js`'s `openWaveEditor`), the same way it already
 * takes `opts.draw`.
 *
 * This layer does not require `wave-draw.js` — the dependency direction
 * between the two extracted layers is one-way, and neither needs the other:
 * anything both would need travels through `wave-ui.js` or through
 * `wave-geometry.js`.
 *
 * `createPanels(deps)` is called from `wave-ui.js` right after `panel`
 * exists, which is BEFORE several of the DOM elements the returned paint
 * functions need (`metaBar`'s own input fields, the edge inspector's
 * `shapeSel`/`edgeLabelInput`, the lane rail's `laneCol`, the preview's
 * `previewHost`/`previewWrap`, the status line's `status`) exist. Rather
 * than reorder any of `wave-ui.js`'s original DOM-scaffolding statements to
 * satisfy this factory's own call site — the brief this module was built
 * from forbids reordering, and scaffolding order is what keeps the
 * toolbar's visual layout unchanged — `deps` is a single object
 * `wave-ui.js` keeps a reference to and PUBLISHES more fields onto as it
 * creates each element, in their original unchanged position. The functions
 * below that need one of those later fields read it off `deps` directly at
 * their own call time (`deps.laneCol`, `deps.edgeBar`, …) rather than
 * caching it into a local at the top of this factory — by the time any of
 * them actually runs (the first `render()`, or a click on an
 * already-mounted control), every field they read has long since been
 * published. Only what is genuinely ready the moment `createPanels()` runs
 * (`d`, `geometry`, `codec`, `SIZES`, `actions`, `overlay`, `panel`, the
 * preview's id constants, the wavedrom engine reference) is cached into a
 * local up front.
 *
 * v3.6.0 Task 12: `toolButton()` used to always append into a single
 * `cycleBar` div cached from `deps.cycleBar` — the toolbar's only button
 * row at the time. Now that the toolbar is eight captioned
 * `.ed-wave-tool-group` sections (`toolGroup()`, below), `toolButton()`
 * takes the target group as its last argument instead, and `deps` no
 * longer carries `cycleBar` at all — nothing in this file needs a single
 * shared bar to exist before `createPanels()` runs anymore.
 *
 * `actions` is the callback bag for the handful of `wave-ui.js`-owned pieces
 * of state a moved function still has to read or write, now that it is no
 * longer a closure over `wave-ui.js`'s own variables:
 *
 *   commit(name, fn)            run one gesture (constraint 5 in wave-ui.js's
 *                                own header)
 *   render()                    repaint the whole dialog
 *   selectionSet(v)             write-only: `laneRow`'s own click handler
 *                                writes the one selection this dialog has —
 *                                `{laneIndex, laneTo, from, to}`, a lane
 *                                range plus the cycle range on its first
 *                                lane. Reads go through `state.selection`
 *                                instead, since every one of them happens
 *                                synchronously inside a `renderLanes` call
 *                                and a getter would be one more indirection
 *                                over the value `state` already carries
 *   focusOverrideGet()/Set(key) the one-shot "where should the keyboard land
 *                                after this repaint" override — read AND
 *                                written from inside `renameGroup`'s deferred
 *                                `finish`/`retire`/`cancel` closures, so both
 *                                halves are needed, not only the setter a
 *                                write-only caller like `laneRow`'s drop
 *                                handler uses
 *   groupRenameGet()/Set(v)     the rail's one open rename session — a mutex
 *                                `renameGroup`'s own deferred closures test
 *                                and clear over time, and `wave-ui.js`'s
 *                                `render()` also reads directly (unchanged,
 *                                since `render()` itself did not move) to
 *                                decide whether to retire it before a repaint
 *
 * `close` is not in `actions`: no function that moved here calls it (checked
 * against every line in this file, not assumed).
 *
 * `commitBanner` is exported despite being internal to the eight meta-field
 * change listeners that are its only callers — a deviation from this task's
 * own brief, which called it an internal helper. Those eight listeners stay
 * in `wave-ui.js`, at their original position, because the input elements
 * they close over (`headInput`, `footInput`, …) are `wave-ui.js` locals a
 * caller needs to go on holding for `deps.headInput` etc. below to work; the
 * alternative — building those eight fields and their listeners inside this
 * factory instead, so `commitBanner` could stay private — would mean
 * reconstructing `wave-ui.js`'s own scaffolding order inside this file,
 * which is the reordering this whole factory is built to avoid. Exporting
 * one more trivial function was the smaller change.
 */

function createPanels(deps) {
  const d = deps.d;
  const geometry = deps.geometry;
  const codec = deps.codec;
  const SIZES = deps.SIZES;
  const actions = deps.actions;
  const overlay = deps.overlay;
  const panel = deps.panel;
  const PREVIEW_INDEX = deps.PREVIEW_INDEX;
  const PREVIEW_ID_PREFIX = deps.PREVIEW_ID_PREFIX;
  const wavedrom = deps.wavedrom;

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

  /**
   * v3.6.0 Task 12: one captioned toolbar section — a `.ed-wave-tool-group`
   * with a `.ed-wave-tool-caption` at the front.
   *
   * The caption sits to the LEFT of the section's buttons, not above them:
   * the toolbar is a horizontal bar, and a caption row above each group
   * would make it two lines tall on top of a row that already wraps — the
   * 電位 group's 22 brushes alone wrap to two rows at this dialog's fixed
   * viewport (MEASURED, Task 10: 22 × 38px against a 728px container).
   * Vertical space is what a tall diagram (60+ cycles) is already short of,
   * so this reorganisation may not spend more of it.
   */
  function toolGroup(caption) {
    const g = d.createElement('div');
    g.className = 'ed-wave-tool-group';
    const cap = d.createElement('span');
    cap.className = 'ed-wave-tool-caption';
    cap.textContent = caption;
    g.appendChild(cap);
    return g;
  }

  // `group` (last arg, required) is the `.ed-wave-tool-group` this button
  // belongs to — see `toolGroup()` above and this module's own header for
  // why there is no longer a single shared bar this could default to.
  function toolButton(cls, label, hint, fn, group) {
    const b = d.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.setAttribute('data-focus-key', cls);
    b.textContent = label;
    b.title = hint;
    b.addEventListener('click', fn);
    group.appendChild(b);
    return b;
  }

  /**
   * v3.6.0 Task 13: one collapsible right-hand panel — a `.ed-wave-section`
   * with its own `.ed-wave-section-title` header button and a
   * `.ed-wave-section-body` the header toggles.
   *
   * `open` seeds `data-open` — the section's expanded state — but that state
   * lives ONLY on the attribute for the life of this one editor session; it
   * is never read back out of, or written into, the document. A session that
   * opens with 關聯線/文件/Lane expanded and 預覽/原始碼 collapsed always
   * starts that way again next time, by design: the three that default open
   * are the ones a gesture on the canvas immediately needs (an edge just
   * got selected, a lane just got selected, the ruler fields), and the two
   * that default closed are read-only references a user opens on demand
   * rather than panels they edit through.
   *
   * Returns `{el, body}` — the section element to place in the DOM, and the
   * body div a caller fills in. Kept separate rather than handing back only
   * `el` and making every caller `querySelector('.ed-wave-section-body')`
   * back out of it: every call site already knows which body it wants the
   * instant it asks for the section.
   */
  function section(key, title, open) {
    const s = d.createElement('section');
    s.className = 'ed-wave-section';
    s.setAttribute('data-section', key);
    if (open) s.setAttribute('data-open', '');
    const h = d.createElement('button');
    h.type = 'button';
    h.className = 'ed-wave-section-title';
    h.setAttribute('data-focus-key', 'section-' + key);
    h.textContent = title;
    h.addEventListener('click', function () {
      // v3.6.0 Task 13: under the <1100px collapse (md2doc.js's own media
      // query), the rail's section titles are the only thing still
      // visible/clickable — without this, a narrow-viewport user could
      // toggle `data-open` all day and never see a body, because
      // `.ed-wave-side:not([data-expanded]) .ed-wave-section-body` stays
      // `display:none` regardless. Harmless at a wide viewport: nothing
      // there matches `[data-expanded]` outside that media query, so this
      // is a no-op attribute there.
      //
      // The FIRST click while still collapsed only reveals the rail and
      // does not also toggle the section it landed on: 關聯線/文件/Lane
      // all default `data-open`, so a plain toggle here would make that
      // very first click look like "the user just closed the panel they
      // pressed" the instant the rail became wide enough to show it.
      const wasExpanded = side.hasAttribute('data-expanded');
      side.setAttribute('data-expanded', '');
      if (!wasExpanded) return;
      if (s.hasAttribute('data-open')) s.removeAttribute('data-open');
      else s.setAttribute('data-open', '');
    });
    s.appendChild(h);
    const body = d.createElement('div');
    body.className = 'ed-wave-section-body';
    s.appendChild(body);
    return { el: s, body: body };
  }

  // v3.6.0 Task 13: the whole right-hand column, built eagerly here rather
  // than incrementally published onto `deps` the way `metaBar`/`edgeBar`/
  // `laneCol`/`previewWrap`/`status` are (see this module's own header for
  // why THOSE are lazy): every section body a caller could want already
  // exists the instant `createPanels()` returns, because `section()` above
  // needs nothing but `d`. `wave-ui.js` appends `panels.side` into `.ed-wave-
  // body` once, in the position the old `.ed-wave-preview` column used to
  // occupy, and targets `panels.sections.<key>` for everything that used to
  // go into `metaBar`/`edgeBar`/`previewWrap` directly.
  //
  // Order is the fixed, tested order: edge, document, lane, preview, source.
  // Open by default: edge/document/lane (a gesture on the canvas — selecting
  // an edge, selecting a lane, typing a ruler field — has to see its own
  // panel without an extra click). Closed by default: preview/source (the
  // engine's own picture and the exact bytes a save would write are both
  // references a user consults on demand, not panels edited through).
  const side = d.createElement('div');
  side.className = 'ed-wave-side';

  // v3.6.0 Task 13 fix round 1: a way back. Expanding the rail (a click on
  // any section title, below) used to be a one-way door under the <1100px
  // collapse — nothing ever removed `data-expanded` again, so the first
  // click at a narrow viewport permanently forfeited canvas space for the
  // rest of the session, which works directly against this whole version's
  // own goal. `display: none` outside `[data-expanded]` (md2doc.js's CSS)
  // keeps this invisible and out of the tab order everywhere else — it only
  // ever matters in the one state it exists for.
  const collapseBtn = d.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'ed-wave-side-collapse';
  collapseBtn.setAttribute('data-focus-key', 'side-collapse');
  collapseBtn.title = '收合右欄';
  collapseBtn.textContent = '»  收合';
  collapseBtn.addEventListener('click', function () {
    side.removeAttribute('data-expanded');
  });
  side.appendChild(collapseBtn);

  const sections = {};
  for (const def of [
    ['edge', '關聯線', true],
    ['document', '文件', true],
    ['lane', 'Lane', true],
    ['preview', 'WaveDrom 預覽', false],
    ['source', '原始碼', false],
  ]) {
    const built = section(def[0], def[1], def[2]);
    side.appendChild(built.el);
    sections[def[0]] = built.body;
  }

  /**
   * v3.6.0 Task 13 fix round 3: expand the rail programmatically — the SAME
   * `data-expanded` attribute a section title's first click (`section()`
   * above) and the collapse button's own opposite (`collapseBtn` above)
   * already use, called instead from `wave-ui.js`'s `render()` on the one
   * transition that needs it without a click at all: selecting an edge at
   * a narrow viewport, whose only feedback surface is a section this attribute
   * governs. A no-op outside the `<1100px` media query, same as those two
   * call sites — nothing there matches `[data-expanded]` at a wider one.
   */
  function expandSide() {
    side.setAttribute('data-expanded', '');
  }

  // v3.6.0 Task 13: `container` is the section body a field belongs in —
  // explicit at the call site, the same reasoning `toolButton`'s own
  // trailing `group` argument (Task 12) already gives for why there is no
  // default to fall back on now that this dialog has more than one place a
  // field could land.
  function metaField(cls, label, placeholder, field, container) {
    const wrap = d.createElement('label');
    wrap.className = 'ed-wave-metafield';
    const text = d.createElement('span');
    text.textContent = label;
    wrap.appendChild(text);
    const input = d.createElement('input');
    input.type = 'text';
    input.className = cls;
    input.setAttribute('data-focus-key', cls);
    input.setAttribute('data-field', field);
    input.placeholder = placeholder;
    wrap.appendChild(input);
    container.appendChild(wrap);
    return input;
  }

  /**
   * A numeral typed into `hscale`/`period`/`phase` is committed as a real
   * JS `number`, not as the string the `<input>` holds — unlike the eight
   * banner fields' `commitBanner`, which always writes a string and is
   * correct to (see its own header comment: the engine's `captext` and
   * `ticktock` both accept a plain string). These three are different:
   * `wave-geometry.hscaleOf`/`layoutOf` gate on `typeof … === 'number'`, so
   * a STRING `"2"` would silently read as "unset" on THIS canvas — this
   * batch's own default of 1/0 — while the pinned engine's own preview still
   * honours it (its `tonumber()` coerces a string with `>`). That is the
   * exact same-idea-two-definitions divergence this batch has already paid
   * for three times elsewhere (see `md2doc`'s CLAUDE.md). Blank clears the
   * field (the `undefined` sentinel `setConfigField`/`setLaneField` both
   * read); anything that is not a plain, trimmed number is left as the raw
   * string — both this canvas's `typeof` gate and the engine's own
   * `tonumber()` already fall back to the SAME default (1 for hscale/period,
   * 0 for phase) for a non-numeric value, so there is nothing to reconcile
   * for that case, only for a well-formed one.
   */
  function parseNumericField(value) {
    if (value === '') return undefined;
    return /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : value;
  }

  function commitConfigField(key, value) {
    actions.commit('config.' + key, function (doc) {
      return codec.setConfigField(doc, key, parseNumericField(value));
    });
  }

  function commitLaneField(at, key, value) {
    actions.commit('lane.' + key, function (doc) {
      return codec.setLaneField(doc, at, key, parseNumericField(value));
    });
  }

  // v3.5.0 Task 13: widened from `(which, value)` — always writing `.text`
  // — to `(which, key, value)` so the same function also carries the other
  // five ruler fields.
  //
  // Fix round 2: the write itself moved into `codec.setBannerField` rather
  // than staying inline here. The inline version's own no-op guard —
  // `value === '' && (hadObj[key] === undefined || hadObj[key] === null)`
  // — only refused to WRITE when the key had never been set; once a key
  // WAS set, clearing the field fell through to `next[which][key] = ''`,
  // an empty string rather than an absent key. `.text` hid that: the
  // engine's `captext` treats `''` the same as absent (a plain truthy
  // check). `tick`/`tock`/`every` do not — `ticktock` in
  // `node_modules/wavedrom/lib/render-marks.js` only skips a field that is
  // `=== undefined`, so `''` reached its array branch, `Number('')` is
  // `0`, and the engine drew a full default 0-based ruler on a field that
  // LOOKED empty on screen — the exact confident-wrong-state class this
  // file exists to avoid, reintroduced by the write side after the read
  // side (`tickTockText`) got it right. `setBannerField` deletes the key
  // (and the parent object, if that empties it) instead of writing `''`,
  // closing that gap once for all six fields rather than special-casing
  // `.text`'s accidental safety.
  //
  // This also gives these six fields their first test seam:
  // `commitBanner` itself is a closure with no unit-test access, but
  // `setBannerField` is a plain, exported, pure function — pinned in
  // `test/wave-codec.test.js`.
  function commitBanner(which, key, value) {
    actions.commit(which + '.' + key, function (doc) { return codec.setBannerField(doc, which, key, value); });
  }

  function say(text) {
    deps.status.textContent = text;
    overlay.setAttribute('data-wave-status', text);
  }

  /**
   * Show or hide the inspector row, and — when it is showing — fill it in
   * from the selected edge's own entry.
   *
   * The ONLY thing that may set `edgeBar.hidden`, so "is an edge selected"
   * and "is there a box on screen" cannot come apart: precondition T1 at
   * the top of this file's docstring for the overlay itself, applied to
   * this row. Called only from `render()`, after `selectedEdge` has already
   * been clamped, so the `codec.parseEdge` below is not expected to fail —
   * it is checked anyway because "expected to" is not "guaranteed to".
   */
  function renderEdgeBar(doc, state) {
    const selectedEdge = state.selectedEdge;
    overlay.setAttribute('data-wave-selected-edge',
      selectedEdge === null ? '' : String(selectedEdge));
    deps.edgeBar.hidden = selectedEdge === null;
    if (selectedEdge === null) return;
    const cur = codec.parseEdge((doc.edge || [])[selectedEdge]);
    if (cur === null) { deps.edgeBar.hidden = true; return; }
    deps.shapeSel.value = cur.shape;
    deps.edgeLabelInput.value = cur.label;
  }

  /**
   * `tick`/`every`/`tock` are read by the pinned engine as a number, a
   * string, or an array of either (`ticktock` in
   * `node_modules/wavedrom/lib/render-marks.js`) — unlike `head`/`foot`'s
   * own `.text`, which is always a plain string. A text `<input>` can only
   * hold one shape, so a hand-authored numeric or array value is shown in
   * its string form (an array space-joined, the same shape the engine's
   * own `val.trim().split(/\s+/)` turns a plain string back into) rather
   * than blanked out — blanking a field that actually holds `tick: 0`
   * would show a confident wrong state, the same failure `renderUnmodelled`
   * exists to avoid elsewhere in this file. Editing the field always
   * commits a plain string back, which the engine treats identically to
   * whichever shape it replaced.
   */
  function tickTockText(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return v.join(' ');
    return '';
  }

  function renderMeta(doc) {
    const h = doc.head;
    const f = doc.foot;
    deps.headInput.value = (h !== null && typeof h === 'object' && typeof h.text === 'string')
      ? h.text : '';
    deps.footInput.value = (f !== null && typeof f === 'object' && typeof f.text === 'string')
      ? f.text : '';
    deps.headTickInput.value = (h !== null && typeof h === 'object') ? tickTockText(h.tick) : '';
    deps.headEveryInput.value = (h !== null && typeof h === 'object') ? tickTockText(h.every) : '';
    deps.footTockInput.value = (f !== null && typeof f === 'object') ? tickTockText(f.tock) : '';
    deps.headTockInput.value = (h !== null && typeof h === 'object') ? tickTockText(h.tock) : '';
    deps.footTickInput.value = (f !== null && typeof f === 'object') ? tickTockText(f.tick) : '';
    deps.footEveryInput.value = (f !== null && typeof f === 'object') ? tickTockText(f.every) : '';
    // v3.6.0 Task 13: the document panel's ninth field. `config.hscale` is
    // meant to hold a number (see `commitConfigField`'s own comment), but a
    // hand-authored document can carry anything — `tickTockText` already
    // does the identical "show it as a string either way" job for the six
    // ruler fields, so it is reused here rather than a near-duplicate.
    const cfg = doc.config;
    deps.hscaleInput.value = (cfg !== null && typeof cfg === 'object')
      ? tickTockText(cfg.hscale) : '';
  }

  /**
   * The Lane panel's two fields — `period`/`phase` for whichever lane the
   * CYCLE selection currently names (`state.selection.laneIndex`, the same
   * mark the brush/cycle toolbar already acts on — there is no separate
   * "selected lane" concept in this dialog). Disabled, and blank, whenever
   * nothing is selected: a control a gesture cannot currently reach is
   * disabled rather than left to silently do nothing, the same rule
   * `groupBtn`'s own disabled state already follows in `wave-ui.js`.
   */
  function renderLaneField(doc, layout, state) {
    const sel = state.selection;
    const row = (sel !== null) ? layout.lanes[sel.laneIndex] : undefined;
    if (row === undefined) {
      deps.lanePeriodInput.disabled = true;
      deps.lanePhaseInput.disabled = true;
      deps.lanePeriodInput.value = '';
      deps.lanePhaseInput.value = '';
      return;
    }
    deps.lanePeriodInput.disabled = false;
    deps.lanePhaseInput.disabled = false;
    const lane = (row.lane !== null && typeof row.lane === 'object') ? row.lane : {};
    deps.lanePeriodInput.value = tickTockText(lane.period);
    deps.lanePhaseInput.value = tickTockText(lane.phase);
  }

  /**
   * The 原始碼 panel: `writeBack(originalText, doc).text` — the actual bytes
   * a save would write — not a re-serialisation made for display. Reads
   * `actions.sourceText()`, which walks the SAME `store.toPatch()` path
   * `afterStoreMoved` already runs after every gesture (`wave-ui.js`), so
   * this panel can never show a different answer than what 保留並關閉 would
   * actually write.
   */
  function renderSource() {
    const pre = d.createElement('pre');
    pre.className = 'ed-wave-source';
    pre.textContent = actions.sourceText();
    sections.source.replaceChildren(pre);
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
   *
   * Edges join this same notice for the opposite reason. As of this task
   * they ARE drawn — `renderEdges` below — so the claim for them is not "the
   * drawing ignores this property" but "this specific edge cannot be
   * placed".
   *
   * final review finding 3: this used to re-derive only ONE of
   * `geometry.edgeLayout`'s three skip reasons (the dangling-letter one) by
   * walking `doc.edge` a second time with its own copy of that check —
   * which is also the one case the pinned engine agrees with us on
   * (measured: an edge naming an absent letter draws nothing there either).
   * The other two — an unparseable shape, and a `node` index that has
   * outlived its lane's length (reachable from the editor's own
   * insert/delete-cycles buttons, since neither reindexes `node`) — are
   * exactly where the engine DOES draw a line and we silently do not,
   * which is the one divergence this whole overlay exists to prevent, and
   * the old code said nothing about either.
   *
   * So this asks `geometry.edgeLayoutDetail` — the SAME walk `renderEdges`
   * draws from — which edges it could not place and why, instead of
   * re-deriving any check of its own. Skips are bucketed by whatever
   * `reason` string comes back, not by a hardcoded list of the two or three
   * reasons known today: a fourth `continue` added to `edgeLayoutDetail`
   * later shows up here as its own bucket (worded generically if
   * `REASON_TEXT` has not been taught a nicer sentence for it yet) with no
   * change needed in this function, rather than escaping the notice the way
   * the third one did until now.
   */
  function renderUnmodelled(doc, layout) {
    const found = [];
    const cfg = doc.config;
    if (cfg !== null && typeof cfg === 'object' && cfg.hscale !== undefined) {
      found.push('config.hscale');
    }
    for (const path of codec.lanePaths(doc)) {
      const lane = geometry.valueAt(doc, path);
      if (lane === null || typeof lane !== 'object') continue;
      if (lane.period !== undefined && found.indexOf('period') === -1) found.push('period');
      if (lane.phase !== undefined && found.indexOf('phase') === -1) found.push('phase');
    }

    const detail = geometry.edgeLayoutDetail(doc, layout);
    // Bucket every skip by its own reported `reason` — discovered from what
    // came back, not enumerated in advance, so nothing here has to change
    // for a reason this function has never heard of.
    const buckets = new Map();
    for (const skip of detail.skipped) {
      if (!buckets.has(skip.reason)) buckets.set(skip.reason, []);
      buckets.get(skip.reason).push(skip);
    }

    function letters(list) {
      const out = [];
      for (const skip of list) {
        if (skip.edge === null) continue;
        if (out.indexOf(skip.edge.from) === -1) out.push(skip.edge.from);
        if (out.indexOf(skip.edge.to) === -1) out.push(skip.edge.to);
      }
      return out;
    }

    // Known reasons get a sentence that says what a user can act on.
    // `dangling` matches the engine (nothing to reconcile against the
    // preview); `unparseable` and `out-of-range` are the two the engine
    // draws and we do not, so both point at the preview as the tie-breaker.
    const REASON_TEXT = {
      dangling: function (list) {
        return '這個區塊有 ' + list.length + ' 條關聯線引用了不存在的 anchor（' +
          letters(list).join('、') + '），左邊畫不出它們。';
      },
      unparseable: function (list) {
        return '這個區塊有 ' + list.length +
          ' 條關聯線的寫法連引擎也認不得，左邊畫不出它們（跟右邊的 WaveDrom 預覽一致）。';
      },
      'out-of-range': function (list) {
        return '這個區塊有 ' + list.length + ' 條關聯線的 anchor（' +
          letters(list).join('、') + '）落在那條 lane 目前的長度之外，左邊畫不出它們' +
          '——但右邊的 WaveDrom 預覽仍然會畫，兩邊會不一致，以預覽為準。';
      },
    };

    const sentences = [];
    if (found.length > 0) {
      sentences.push('這份文件用了 ' + found.join('、') +
        '，左邊的手繪波形不表現它們（寬度與相位會不一樣）——以右邊的 WaveDrom 預覽為準。');
    }
    for (const [reason, list] of buckets) {
      const text = REASON_TEXT[reason];
      sentences.push(text ? text(list) :
        '這個區塊有 ' + list.length + ' 條關聯線因為「' + reason + '」畫不出來，' +
        '以右邊的 WaveDrom 預覽為準。');
    }

    const danglingCount = buckets.has('dangling') ? buckets.get('dangling').length : 0;
    overlay.setAttribute('data-wave-unmodelled', found.join(' '));
    overlay.setAttribute('data-wave-dangling-edges', String(danglingCount));
    // The total the dangling-only count above cannot say: every edge entry
    // `edgeLayoutDetail` could not place, for any reason at all.
    overlay.setAttribute('data-wave-skipped-edges', String(detail.skipped.length));
    deps.unmodelled.hidden = sentences.length === 0;
    deps.unmodelled.textContent = sentences.join(' ');

    // …and the bigger version of the same honesty. This editor edits
    // `signal:` and nothing else, so a `reg:` or `assign:` block opens a
    // canvas with no lanes on it: `lanePaths()` is empty, `addLane()` hands
    // the document straight back, and pressing ＋ produced one status line
    //「這個動作沒有改變任何東西」— true, and no explanation at all. An
    // editor that looks broken is worse than one that says what it cannot
    // do, and the notice above is the precedent: the drawing already tells
    // the user which properties it is not showing them.
    const kinds = [];
    for (const key of ['reg', 'assign']) {
      if (doc[key] !== undefined) kinds.push(key + ':');
    }
    const noLanes = codec.lanePaths(doc).length === 0;
    overlay.setAttribute('data-wave-nolanes', noLanes ? '1' : '0');
    deps.noSignal.hidden = !noLanes;
    deps.noSignal.textContent = !noLanes ? '' :
      (kinds.length === 0
        ? '這個區塊裡沒有 signal:，所以沒有可以編輯的 lane。'
        : '這個區塊用的是 ' + kinds.join(' / ') +
          '，這個編輯器只編輯 signal: 的 lane。') +
      '右邊的 WaveDrom 預覽仍然是引擎畫的原圖；要改這個區塊請用「⠿ → MD 原始碼」。';
  }

  /**
   * The lane list.
   *
   * Rows are `layout.laneHeight` tall and in `layout.lanes` order, so row k
   * here and row k of the drawing are the same lane by construction rather
   * than by a second traversal that could disagree.
   */
  function renderLanes(doc, layout, state) {
    deps.laneCol.textContent = '';
    const rows = d.createElement('div');
    rows.className = 'ed-wave-lane-rows';
    rows.style.height = layout.height + 'px';
    deps.laneCol.appendChild(rows);

    const spans = geometry.groupSpansOf(doc, layout);

    // Group titles first, so they sit UNDER the rows in paint order and a
    // lane's own controls stay clickable over them.
    for (const span of spans) {
      const tag = d.createElement('button');
      tag.type = 'button';
      tag.className = 'ed-wave-group';
      tag.setAttribute('data-focus-key', 'group-' + span.from);
      tag.textContent = span.title;
      tag.title = '群組「' + span.title + '」——點一下改名';
      tag.setAttribute('data-group-from', String(span.from));
      tag.setAttribute('data-group-to', String(span.to));
      // v3.6.0 Task 6: `layout.lanes[i].y`, not `i * layout.laneHeight` — lane
      // 0 no longer starts at y=0 (the ruler/head-title band sits above it),
      // and this rail is a separate scroll-synced column from the canvas that
      // must line up row-for-row with it. `span.from` is always a real lane
      // index (a group always has at least one lane under it), so
      // `layout.lanes[span.from]` is never absent here.
      tag.style.top = layout.lanes[span.from].y + 'px';
      tag.style.height = ((span.to - span.from + 1) * layout.laneHeight) + 'px';
      tag.style.left = ((span.depth - 1) * 16) + 'px';
      tag.addEventListener('click', function () { renameGroup(span); });
      rows.appendChild(tag);
    }

    for (let i = 0; i < layout.lanes.length; i++) {
      rows.appendChild(laneRow(doc, layout, i, state));
    }
  }

  /**
   * Which row a lane-handle drag started on, for the life of that one drag.
   *
   * NOT read out of the drag's own `DataTransfer`: that payload is writable
   * by any page, so a drop handler trusting it would accept a drag begun in
   * another window as a lane reorder. This is a closure variable, set by the
   * one `dragstart` in this file and cleared by the matching `dragend` and
   * by every `drop` that acts on it, so a drag that never started here is
   * `null` here and every drop is a no-op.
   */
  let laneDragFrom = null;

  /**
   * The rail's one row: a drag handle, a name field, and — on a lane that is
   * WaveDrom's own blank spacer — a badge saying so.
   *
   * v3.6.0 Task 14. Every row used to carry six controls (＋ ▲ ▼ ✕ 複製
   * 空白列), and the one row that hosted its group's 解散群組 carried seven.
   * They did not fit: the rail is 200px, the name field was flexed down to
   * 45px on the most crowded row (MEASURED in Task 12's own Shift+click
   * comment, since deleted with the gesture it described), and a three-
   * character Chinese caption in a 24px button is laid out vertically by the
   * browser — the editor shipped a column of stacked glyphs where a label was
   * meant. All six moved to the toolbar's 訊號/群組 sections, where they act
   * on `selection`.
   *
   * That move is what retires the rail's SECOND selection — the set of row
   * numbers Task 12 added to serve one button (建立群組), which then had to
   * be carried across undo/redo beside the other four marks, clamped again
   * in `render()`, and drawn with a tint of its own so a user could tell it
   * from the cycle selection standing at the same time. There is one
   * selection now: `selection`, whose `laneIndex`..`laneTo` is the lane range
   * and whose `from`..`to` is the cycle range on `laneIndex`. Shift+click
   * here and Shift+arrow on the canvas write the same mark.
   *
   * Clicking the row selects its lane; clicking the NAME FIELD does not.
   * That exclusion is inherited from the gesture this replaces and is the
   * same fact: `render()` rebuilds the whole rail, so a repaint fired from
   * inside a field the user is still typing in rebuilds that field from the
   * document — discarding uncommitted text with nothing on screen to explain
   * it. The handle is always present and never flexes away, so there is
   * always a click target for "select this lane" even on a row whose name
   * fills the field.
   */
  function laneRow(doc, layout, i, state) {
    const row = d.createElement('div');
    row.className = 'ed-wave-lane-row';
    row.setAttribute('data-lane', String(i));
    // v3.6.0 Task 6: `layout.lanes[i].y` carries the ruler/head-title band's
    // offset, `i * layout.laneHeight` does not. Left as the latter this row
    // would sit `layout.originY` px too high, out of step with its own
    // canvas row.
    row.style.top = layout.lanes[i].y + 'px';
    row.style.height = layout.laneHeight + 'px';
    row.style.paddingLeft = (layout.lanes[i].depth * 16) + 'px';
    if (state.selection !== null &&
        i >= state.selection.laneIndex && i <= state.selection.laneTo) {
      row.classList.add('is-selected');
    }

    row.addEventListener('click', function (ev) {
      if (ev.target !== null && typeof ev.target.classList === 'object' &&
          ev.target.classList.contains('ed-wave-lane-name')) {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      const sel = state.selection;
      if (ev.shiftKey === true && sel !== null) {
        // Extend, normalised so `laneIndex <= laneTo` always holds and no
        // reader has to re-derive which end is which. Extending UPWARDS
        // therefore moves `laneIndex` — and with it the row the cycle box
        // sits on — to the new top of the range; the cycle numbers
        // themselves are untouched.
        const anchor = sel.laneIndex;
        actions.selectionSet({
          laneIndex: Math.min(anchor, i), laneTo: Math.max(anchor, i),
          from: sel.from, to: sel.to,
        });
      } else {
        // A plain click selects this lane at its first cycle. It IS a cycle
        // selection, deliberately: there is one selection, and picking a
        // lane from the rail has to leave the toolbar's cycle section
        // pointing somewhere real rather than at a lane range with no
        // cycles named.
        actions.selectionSet({ laneIndex: i, laneTo: i, from: 0, to: 0 });
      }
      actions.render();
    }, true);

    // Reordering. `codec.moveLane` is the one place that knows what a
    // destination position means once the lane has been lifted out (and that
    // it may cross a group boundary on the way) — this gesture hands it two
    // display positions and nothing else, rather than growing a second
    // opinion about lane order in the rail.
    const handle = d.createElement('span');
    handle.className = 'ed-wave-lane-handle';
    handle.setAttribute('draggable', 'true');
    handle.setAttribute('data-focus-key', 'lane-handle-' + i);
    handle.textContent = '⠿';
    handle.title = '拖曳這裡可以調整這條 lane 的順序';
    handle.addEventListener('dragstart', function (ev) {
      laneDragFrom = i;
      // The row index also goes into the DataTransfer, but it is NOT what
      // the drop reads: a drop handler that trusted it would accept a drag
      // that started anywhere on the page, including another window. The
      // payload is set because a drag with no data attached does not start
      // at all in some browsers, and for nothing else.
      if (ev.dataTransfer !== null && ev.dataTransfer !== undefined) {
        ev.dataTransfer.effectAllowed = 'move';
        try { ev.dataTransfer.setData('text/plain', String(i)); } catch (e) { /* nothing to do */ }
      }
    });
    handle.addEventListener('dragend', function () { laneDragFrom = null; });
    row.appendChild(handle);

    row.addEventListener('dragover', function (ev) {
      if (laneDragFrom === null) return;
      // preventDefault is what MAKES this a drop target; without it the
      // browser never fires `drop` at all and the gesture dies silently.
      ev.preventDefault();
      if (ev.dataTransfer !== null && ev.dataTransfer !== undefined) {
        ev.dataTransfer.dropEffect = 'move';
      }
    });
    row.addEventListener('drop', function (ev) {
      if (laneDragFrom === null) return;
      ev.preventDefault();
      const from = laneDragFrom;
      laneDragFrom = null;
      if (from === i) return;
      // The lane arrives at this row, so the keyboard goes to the field it
      // arrives in — the same rule every gesture in this dialog follows, and
      // the reason F7/T6h exist.
      actions.focusOverrideSet('lane-name-' + i);
      actions.commit('move-lane', function (doc2) { return codec.moveLane(doc2, from, i); });
    });

    const name = d.createElement('input');
    name.type = 'text';
    name.className = 'ed-wave-lane-name';
    name.setAttribute('data-focus-key', 'lane-name-' + i);
    const lane = layout.lanes[i].lane;
    name.value = typeof lane.name === 'string' ? lane.name : '';
    name.addEventListener('change', function () {
      actions.commit('rename', function (doc2) { return codec.renameLane(doc2, i, name.value); });
    });
    row.appendChild(name);

    // WaveDrom's own blank row, `{}` — no `wave`, no `name`. It draws as
    // nothing, so without this the rail shows an empty name field on a row
    // the canvas leaves blank and there is no way to tell it from a lane
    // someone simply has not named yet.
    if (lane.wave === undefined && lane.name === undefined) {
      const badge = d.createElement('span');
      badge.className = 'ed-wave-lane-badge';
      badge.textContent = '空白列';
      badge.title = 'WaveJSON 的 {}，用來空出間距';
      row.appendChild(badge);
    }
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
   * away, so the label states it: the 訊號 section's 新增 says which
   * container it will land in before it is pressed (`data-lands-in`, kept
   * current by `wave-ui.js`'s `render()`), and the status line says it again
   * after.
   *
   * v3.6.0 Task 14: exported, because the caller that needs it is now the
   * toolbar in `wave-ui.js` rather than a button this file builds.
   */
  function landingOf(doc, index) {
    const path = codec.laneInsertPath(doc, index);
    if (path === null) return { path: null, title: null };
    const container = path.slice(0, path.length - 1);
    const held = geometry.valueAt(doc, container);
    const title = Array.isArray(held) && typeof held[0] === 'string' ? held[0] : null;
    return { path: path, title: title };
  }

  /**
   * The rail's rename field: this dialog's one sub-panel.
   *
   * The field is INSERTED beside its tag and the tag is hidden, rather than
   * the two being swapped, and taking it down again touches only those two
   * nodes. That is not tidiness. Taking it down used to mean a full
   * `render()` — a rebuild of the entire rail — and a rebuild that runs
   * inside a `blur` handler destroys the element the user is in the middle
   * of pressing. Measured before this: open the field, then press any rail
   * button; the mousedown blurred the field, the rail was rebuilt, the
   * mouseup landed on a fresh element so no `click` ever fired, the press
   * did nothing at all, and the keyboard ended on `document.body` inside a
   * modal with no visible cursor.
   */
  function renameGroup(span) {
    const rows = deps.laneCol.querySelector('.ed-wave-lane-rows');
    const tag = rows === null ? null
      : rows.querySelector('.ed-wave-group[data-group-from="' + span.from + '"]');
    if (tag === null) return;

    const input = d.createElement('input');
    input.type = 'text';
    input.className = 'ed-wave-group-input';
    input.setAttribute('data-focus-key', 'group-input-' + span.from);
    input.value = span.title;
    input.style.top = tag.style.top;
    input.style.left = tag.style.left;

    /** The field off, the tag back — and nothing else in the rail touched.
     *  A no-op for both once a repaint has taken them away. */
    const takeDown = function () {
      if (input.parentNode !== null) input.parentNode.removeChild(input);
      if (d.contains(tag)) tag.hidden = false;
    };
    /** The tag this field was covering, or — when a repaint has replaced it
     *  and moved it (a group's `from` is its first lane's row, so an insert
     *  above it renumbers the key) — whatever now carries that key, and
     *  failing that the dialog itself. Never nothing: nothing is
     *  `document.body`. */
    const focusTag = function () {
      const live = d.contains(tag) ? tag
        : overlay.querySelector('[data-focus-key="group-' + span.from + '"]');
      if (live !== null) live.focus();
      else panel.focus();
    };
    /** Whether the keyboard is IN the field right now. False on the `blur`
     *  path — the browser has already moved it by then — which is how the
     *  two are told apart without asking which device did anything. */
    const holdsKeyboard = function () { return d.activeElement === input; };

    const finish = function () {
      // Once. `change` and `blur` both fire for a field committed with Enter,
      // and every teardown below is a blur too. Whoever gets here first owns
      // the gesture; the latch is also how the other two say "not you".
      if (actions.groupRenameGet() === null) return;
      actions.groupRenameSet(null);
      const hadKeyboard = holdsKeyboard();
      const value = input.value;
      takeDown();
      if (value === span.title) {
        // Nothing to write, so nothing to repaint — the tag is already back.
        // The keyboard is only moved when it was in the field: on the mouse
        // path the browser is already carrying it to the control that was
        // pressed, and that control is still there to receive it now that
        // this path no longer rebuilds the rail.
        if (hadKeyboard) focusTag();
        return;
      }
      // A real commit, so a real repaint — and the keyboard has to be named
      // if it would otherwise be lost. `focusOverride` is left alone when a
      // caller has already made a more specific promise.
      if (actions.focusOverrideGet() === null &&
          (hadKeyboard || !overlay.contains(d.activeElement))) {
        actions.focusOverrideSet('group-' + span.from);
      }
      actions.commit('rename-group', function (doc2) {
        return replaceAt(doc2, span.path.concat([0]), value);
      });
    };
    // The rail is about to be rebuilt underneath this field by somebody
    // else's repaint — an undo, a redo, any gesture that reaches `render()`
    // while it is open. Both nodes go with that rebuild, so there is nothing
    // to take down; what matters is dropping the latch and naming where the
    // keyboard lands, because `group-input-<n>` will not exist afterwards and
    // focus would be left on a node that is no longer in the document — which
    // is the wedge that lost every subsequent keystroke.
    const retire = function () {
      if (actions.groupRenameGet() === null) return;
      actions.groupRenameSet(null);
      if (actions.focusOverrideGet() === null && holdsKeyboard()) {
        actions.focusOverrideSet('group-' + span.from);
      }
    };
    // Escape's half of the layering: the field goes, the name does not
    // change, the session stands, and the keyboard goes back to the tag the
    // field was covering — never to `document.body`, which is the state the
    // whole of this task exists to make unreachable. No repaint at all: the
    // tag was never destroyed.
    const cancel = function () {
      if (actions.groupRenameGet() === null) return;
      actions.groupRenameSet(null);
      takeDown();
      focusTag();
    };

    input.addEventListener('change', finish);
    input.addEventListener('blur', finish);
    tag.hidden = true;
    rows.insertBefore(input, tag);
    // Three facts, and only the three that are read: that a rename is
    // standing (this being non-null), how to take it down on purpose, and how
    // to let go of it when a repaint takes it down for us. A copy of the span
    // or of the field itself would be a second record of something the
    // closure above already holds.
    actions.groupRenameSet({ cancel: cancel, retire: retire });
    input.focus();
    input.select();
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

  function renderPreview(doc) {
    const engine = wavedrom;
    if (engine === null || engine === undefined ||
        typeof engine.RenderWaveForm !== 'function') {
      deps.previewHost.textContent = '（這一頁沒有載入 WaveDrom，預覽從缺）';
      deps.previewWrap.setAttribute('data-wave-preview', 'absent');
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
      deps.previewWrap.setAttribute('data-wave-preview', 'ok');
      deps.previewWrap.setAttribute('data-wave-preview-skin', skinOnPage ? 'shared' : 'own');
    } catch (e) {
      deps.previewHost.textContent = 'WaveDrom 畫不出這份文件：' + String(e && e.message);
      deps.previewWrap.setAttribute('data-wave-preview', 'failed');
    }
  }

  return {
    toolGroup: toolGroup,
    toolButton: toolButton,
    metaField: metaField,
    commitBanner: commitBanner,
    commitConfigField: commitConfigField,
    commitLaneField: commitLaneField,
    renderMeta: renderMeta,
    renderLaneField: renderLaneField,
    renderSource: renderSource,
    renderLanes: renderLanes,
    // v3.6.0 Task 14: the 訊號 section's 新增/空白列/複製 live in
    // `wave-ui.js` now, and each of them has to say which container its
    // insert lands in — before the press (the button's own `data-lands-in`)
    // and after it (the status line). One answer, from the bridge.
    landingOf: landingOf,
    renderEdgeBar: renderEdgeBar,
    renderPreview: renderPreview,
    renderUnmodelled: renderUnmodelled,
    renameGroup: renameGroup,
    say: say,
    // v3.6.0 Task 13: the right-hand column and its five section bodies —
    // see the block above `metaField` for why these are built eagerly
    // rather than published lazily onto `deps` the way `metaBar`/`edgeBar`/
    // etc. used to be. `wave-ui.js` appends `side` once into `.ed-wave-body`
    // and targets `sections.<key>` for every field/notice/preview that used
    // to go straight into the toolbar or the body row.
    side: side,
    sections: sections,
    expandSide: expandSide,
  };
}

module.exports = { createPanels: createPanels };
