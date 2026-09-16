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
 * `createPanels(deps)` is called from `wave-ui.js` right after the toolbar's
 * `cycleBar` exists (so `toolButton` has somewhere to append into) — which is
 * BEFORE several of the DOM elements the returned paint functions need
 * (`metaBar`'s own input fields, the edge inspector's `shapeSel`/
 * `edgeLabelInput`, the lane rail's `laneCol`, the preview's `previewHost`/
 * `previewWrap`, the status line's `status`) exist. Rather than reorder any
 * of `wave-ui.js`'s original DOM-scaffolding statements to satisfy this
 * factory's own call site — the brief this module was built from forbids
 * reordering, and scaffolding order is what keeps the toolbar's visual
 * layout unchanged — `deps` is a single object `wave-ui.js` keeps a
 * reference to and PUBLISHES more fields onto as it creates each element, in
 * their original unchanged position. The functions below that need one of
 * those later fields read it off `deps` directly at their own call time
 * (`deps.laneCol`, `deps.edgeBar`, …) rather than caching it into a local at
 * the top of this factory — by the time any of them actually runs (the
 * first `render()`, or a click on an already-mounted control), every field
 * they read has long since been published. Only what is genuinely ready the
 * moment `createPanels()` runs (`d`, `geometry`, `codec`, `SIZES`, `actions`,
 * `cycleBar`, `overlay`, `panel`, the preview's id constants, the wavedrom
 * engine reference) is cached into a local up front.
 *
 * `actions` is the callback bag for the handful of `wave-ui.js`-owned pieces
 * of state a moved function still has to read or write, now that it is no
 * longer a closure over `wave-ui.js`'s own variables:
 *
 *   commit(name, fn)            run one gesture (constraint 5 in wave-ui.js's
 *                                own header)
 *   render()                    repaint the whole dialog
 *   selectionSet(v)             write-only: the ✕ (remove-lane) button
 *                                clears the cycle selection before removing
 *                                its own row, since a selection naming cycles
 *                                on a lane about to disappear is stale the
 *                                instant `commit` below runs
 *   focusOverrideGet()/Set(key) the one-shot "where should the keyboard land
 *                                after this repaint" override — read AND
 *                                written from inside `renameGroup`'s deferred
 *                                `finish`/`retire`/`cancel` closures, so both
 *                                halves are needed, not only the setter a
 *                                write-only caller like `insertButton` uses
 *   groupRenameGet()/Set(v)     the rail's one open rename session — a mutex
 *                                `renameGroup`'s own deferred closures test
 *                                and clear over time, and `wave-ui.js`'s
 *                                `render()` also reads directly (unchanged,
 *                                since `render()` itself did not move) to
 *                                decide whether to retire it before a repaint
 *   laneMultiSelectSet(v)       the Shift+click lane multi-select `laneRow`'s
 *                                click handler mutates; read-only uses go
 *                                through `state.laneMultiSelect` instead,
 *                                since every read happens synchronously
 *                                during a `renderLanes`/`laneRow` call and a
 *                                getter would just be one more indirection
 *                                over the same value `state` already carries
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
  const cycleBar = deps.cycleBar;
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
   * v3.5.0 Task 12: the lowest display position inside `span`'s range whose
   * lane is a DIRECT member of `span`'s own group array — one nested exactly
   * one level deeper than `span.path` — rather than one that lives inside a
   * sub-group `span` merely contains. This is the one lane `codec.ungroupLanes`
   * can be asked about to name THIS group and not some inner one: a lane's
   * immediate parent is unambiguous (see that function's own comment), so a
   * group is addressable through it exactly when it has at least one lane
   * that belongs to it directly.
   *
   * `null` when it does not — a group built entirely out of sub-groups, with
   * no lane of its own at any depth of one. That group's tag still renders
   * (it has a title, and `groupSpansOf` shows every titled one), but nothing
   * in the rail offers to dissolve it, because there is no `at` this codec
   * shape can express that names it and only it.
   */
  function directFirstLaneOf(layout, span) {
    for (let i = span.from; i <= span.to; i++) {
      if (layout.lanes[i].path.length === span.path.length + 1) return i;
    }
    return null;
  }

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
    deps.metaBar.appendChild(wrap);
    return input;
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
    // v3.5.0 Task 12: which row, if any, hosts THIS group's own 解散
    // button — see `directFirstLaneOf`'s comment for why at most one row
    // can, and why some groups (made entirely of sub-groups) have none.
    const ungroupAt = new Map();
    for (const span of spans) {
      const at = directFirstLaneOf(layout, span);
      if (at !== null) ungroupAt.set(at, span);
    }

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
      tag.style.top = (span.from * layout.laneHeight) + 'px';
      tag.style.height = ((span.to - span.from + 1) * layout.laneHeight) + 'px';
      tag.style.left = ((span.depth - 1) * 16) + 'px';
      tag.addEventListener('click', function () { renameGroup(span); });
      rows.appendChild(tag);
    }

    for (let i = 0; i < layout.lanes.length; i++) {
      rows.appendChild(laneRow(doc, layout, i, ungroupAt.get(i), state));
    }
    // The tail insert. `laneInsertPath(doc, laneCount)` goes on the end of
    // `signal` itself, which is what makes the group asymmetry visible here
    // rather than surprising afterwards.
    rows.appendChild(insertButton(doc, layout.lanes.length, layout, true));
  }

  /**
   * `ungroupSpan` is the group THIS row's 解散 button dissolves, or
   * `undefined` on every row that is not a group's own direct-first-lane —
   * `renderLanes` hands it over from the one `directFirstLaneOf` pass it
   * already made rather than this function re-deriving it per row.
   */
  function laneRow(doc, layout, i, ungroupSpan, state) {
    const row = d.createElement('div');
    row.className = 'ed-wave-lane-row';
    row.setAttribute('data-lane', String(i));
    row.style.top = (i * layout.laneHeight) + 'px';
    row.style.height = layout.laneHeight + 'px';
    row.style.paddingLeft = (layout.lanes[i].depth * 16) + 'px';
    if (state.selection !== null && state.selection.laneIndex === i) row.classList.add('is-selected');
    if (state.laneMultiSelect !== null && state.laneMultiSelect.indexOf(i) !== -1) {
      row.classList.add('is-multi-selected');
    }
    // v3.5.0 Task 12: Shift+click anywhere on the row toggles it into or
    // out of `laneMultiSelect`, the set「建立群組」reads. Capture phase, so
    // this decides BEFORE the row's own children do — a Shift+click landing
    // on ▲/▼/✕/the name field is claimed here rather than moving the lane,
    // deleting it, or opening its name for editing, the same reason
    // `onKeyDown` claims Escape/Tab in the capture phase at the dialog
    // level. An ordinary click (no Shift) is NOT claimed at all: it falls
    // through untouched to whichever child the user actually pressed,
    // which is what keeps every existing gesture in this row working
    // exactly as it did before this task.
    //
    // Fix round 1 (item 1): the name `<input>` is excluded from that catch.
    // `render()` below rebuilds the WHOLE lane rail from `store.doc`, and a
    // Shift+click that reached this listener while the user was still
    // typing in that field — no `change` fired yet, so nothing had been
    // committed — rebuilt the input from the OLD value, discarding
    // whatever they had typed with nothing on screen explaining it. That
    // is the exact failure family this batch has already paid for
    // (`pendingFrom`/`endpointDrag`'s own fix rounds), arriving by a route
    // THIS task opened: before it, `render()` never ran while the keyboard
    // was still in a field with no blur. Shift+click inside a text field
    // is also, on every platform, understood as "extend the text
    // selection" — leaving it alone here is not just the safe choice, it
    // is the expected one. MEASURED (a real Puppeteer page, the nested-
    // group / long-name / ungroup-button-present row — the most crowded
    // this rail ever gets): the input covers at most 45 of the row's
    // 200px; 129–155px of every row stays outside it. So there is always a
    // large, ordinary Shift+click target left — the ▲/▼/✕/＋/解散群組
    // buttons and the row's own padding — and excluding the input costs
    // nothing a user could actually reach for.
    row.addEventListener('click', function (ev) {
      if (ev.shiftKey !== true) return;
      if (ev.target !== null && typeof ev.target.classList === 'object' &&
          ev.target.classList.contains('ed-wave-lane-name')) {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      let laneMultiSelect = state.laneMultiSelect;
      if (laneMultiSelect === null) laneMultiSelect = [];
      const at = laneMultiSelect.indexOf(i);
      if (at === -1) laneMultiSelect.push(i);
      else laneMultiSelect.splice(at, 1);
      if (laneMultiSelect.length === 0) laneMultiSelect = null;
      actions.laneMultiSelectSet(laneMultiSelect);
      actions.render();
    }, true);

    row.appendChild(insertButton(doc, i, layout, false));

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
      actions.focusOverrideSet(i - 1 === 0 ? 'lane-down-0' : 'lane-up-' + (i - 1));
      actions.commit('move', function (doc2) { return codec.moveLane(doc2, i, i - 1); });
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
      actions.focusOverrideSet(i + 1 === layout.lanes.length - 1
        ? 'lane-up-' + (i + 1) : 'lane-down-' + (i + 1));
      actions.commit('move', function (doc2) { return codec.moveLane(doc2, i, i + 1); });
    });
    row.appendChild(down);

    const del = d.createElement('button');
    del.type = 'button';
    del.className = 'ed-wave-lane-remove';
    del.setAttribute('data-focus-key', 'lane-remove-' + i);
    del.textContent = '✕';
    del.title = '刪掉這條 lane（如果群組因此空掉，群組也會一起走）';
    del.addEventListener('click', function () {
      actions.selectionSet(null);
      // The row this button belongs to is about to stop existing, so the
      // keyboard goes to the ＋ that occupies that position instead — the
      // one control at that spot that survives every removal, tail included.
      actions.focusOverrideSet('lane-add-' + i);
      actions.commit('remove-lane', function (doc2) { return codec.removeLane(doc2, i); });
    });
    row.appendChild(del);

    // v3.5.0 Task 13: duplicate this lane — a full deep copy (`data` / any
    // other key, via `codec.duplicateLane`) landing right after it at
    // `i + 1`. Same landing-awareness `insertButton` below already gives
    // the user for an ordinary insert: `duplicateLane` is built on the very
    // `addLane`/`laneInsertPath` door that button uses, so it inherits the
    // identical group-tail asymmetry, and the status line says so the same
    // way.
    //
    // final review finding 2: `node` is deliberately NOT among the copied
    // keys. It names anchor letters that resolve to THIS lane; carrying it
    // onto the duplicate would give two lanes the same letters and silently
    // relocate every edge already anchored here onto the copy instead. The
    // duplicate starts with no anchors of its own.
    const dup = d.createElement('button');
    dup.type = 'button';
    dup.className = 'ed-wave-lane-duplicate';
    dup.setAttribute('data-focus-key', 'lane-duplicate-' + i);
    dup.textContent = '複製';
    dup.title = '複製這條 lane，接在它後面（data 等欄位一起複製；node 錨點不會跟著複製，避免兩條 lane 搶同一個字母）';
    dup.addEventListener('click', function () {
      const landing = landingOf(doc, i + 1);
      const where = landing.title === null ? '群組外' : '群組「' + landing.title + '」裡';
      // The copy's own name field is the one control a duplicate exists
      // for the user to reach next — same reasoning as `insertButton`'s
      // `focusOverride` below.
      actions.focusOverrideSet('lane-name-' + (i + 1));
      const didDup = actions.commit('duplicate-lane', function (doc2) { return codec.duplicateLane(doc2, i); });
      if (didDup) say('複製的 lane 落在' + where);
    });
    row.appendChild(dup);

    // v3.5.0 Task 13: insert a spacer — WaveDrom's own blank row, `{}` —
    // right after this lane. There is deliberately no dedicated "remove
    // spacer" control: a spacer is a lane like any other, so the ✕ button
    // every row already has removes it exactly as it removes any other
    // lane. `codec.addLane` already accepts `{}` (`isLane` only requires a
    // non-array object), so this needs no new codec function of its own —
    // unlike `duplicateLane`, which needed one because nothing in the
    // codec already answers "the lane at this position, copied".
    const spacer = d.createElement('button');
    spacer.type = 'button';
    spacer.className = 'ed-wave-lane-spacer';
    spacer.setAttribute('data-focus-key', 'lane-spacer-' + i);
    spacer.textContent = '空白列';
    spacer.title = '在這條後面插入一個空白列（WaveJSON 的 {}，用來空出間距；' +
      '刪除跟刪一般的 lane 一樣，用 ✕）';
    spacer.addEventListener('click', function () {
      const landing = landingOf(doc, i + 1);
      const where = landing.title === null ? '群組外' : '群組「' + landing.title + '」裡';
      // A spacer has no name to type, so the control the user is most
      // likely to reach for next is ✕ — on the new row itself, at i + 1.
      actions.focusOverrideSet('lane-remove-' + (i + 1));
      const didAdd = actions.commit('add-spacer', function (doc2) { return codec.addLane(doc2, i + 1, {}); });
      if (didAdd) say('空白列落在' + where);
    });
    row.appendChild(spacer);

    // v3.5.0 Task 12: 解散, only on the one row `renderLanes` handed a
    // span for — the group's own direct first lane (see
    // `directFirstLaneOf`). The lanes it held stay exactly where they
    // were; only the wrapping array and its title go.
    if (ungroupSpan !== undefined) {
      const ungroup = d.createElement('button');
      ungroup.type = 'button';
      ungroup.className = 'ed-wave-lane-ungroup';
      ungroup.setAttribute('data-focus-key', 'lane-ungroup-' + i);
      ungroup.textContent = '解散群組';
      ungroup.title = '解散「' + ungroupSpan.title +
        '」這個群組（裡面的 lane 都留著，只是不再是一組）';
      ungroup.addEventListener('click', function () {
        // The lane at `i` survives ungrouping at the same display position
        // (see `ungroupLanes`'s own comment: the flattened order and count
        // never change), so its own name field is exactly where the
        // keyboard should land.
        actions.focusOverrideSet('lane-name-' + i);
        actions.commit('ungroup', function (doc2) { return codec.ungroupLanes(doc2, i); });
      });
      row.appendChild(ungroup);
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
   * away, so the label states it: the button says which container it will
   * land in, before it is pressed, and the status line says it again after.
   */
  function landingOf(doc, index) {
    const path = codec.laneInsertPath(doc, index);
    if (path === null) return { path: null, title: null };
    const container = path.slice(0, path.length - 1);
    const held = geometry.valueAt(doc, container);
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
      actions.focusOverrideSet('lane-name-' + index);
      const added = actions.commit('add-lane', function (doc2) {
        return codec.addLane(doc2, index, { name: '', wave: 'x' });
      });
      if (added) say('新增的 lane 落在' + where);
    });
    return b;
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
    toolButton: toolButton,
    metaField: metaField,
    commitBanner: commitBanner,
    renderMeta: renderMeta,
    renderLanes: renderLanes,
    renderEdgeBar: renderEdgeBar,
    renderPreview: renderPreview,
    renderUnmodelled: renderUnmodelled,
    renameGroup: renameGroup,
    say: say,
  };
}

module.exports = { createPanels: createPanels };
