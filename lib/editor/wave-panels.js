'use strict';

/**
 * wave-panels — the pieces of the waveform editor's shell that are built from
 * plain DOM: toolbar buttons, the small popovers the toolbar opens (menus and
 * the grouped brush grid), and the notice card under the toolbar that says
 * which parts of the document the editor cannot place.
 *
 * Plain CommonJS, like `wave-codec.js` / `wave-geometry.js` / `wave-store.js`
 * / `wave-draw.js` next to it: `wave-ui.js` is injected into the edit page as
 * a bare `<script>` with no `require()` of its own, so it takes this module in
 * as `opts.panels` (see `lib/editor/server.js`'s shim and
 * `lib/editor/client.js`'s `openWaveEditor`), the same way it takes
 * `opts.draw`.
 *
 * Wave redesign Task 6b: the right-hand column (its five collapsible panels,
 * the lane list beside the canvas and the preview) is gone. Spec section 4.9
 * gives each of its parts a new home; the settings fields, a lane's period /
 * phase and the edge inspector come back as popovers in Tasks 8 to 10.
 *
 * `deps`:
 *   d, geometry, codec   the document and the two modules, handed in
 *   overlay              the dialog root (the notice publishes its counts there)
 *   actions.commit(name, fn)   run one gesture (constraint 5 in wave-ui.js)
 */

function createPanels(deps) {
  const d = deps.d;
  const geometry = deps.geometry;
  const codec = deps.codec;
  const actions = deps.actions;
  const overlay = deps.overlay;

  /** One toolbar button. `parent` (last arg, required) is where it goes. */
  function toolButton(cls, label, hint, fn, parent) {
    const b = d.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.setAttribute('data-focus-key', cls);
    b.textContent = label;
    b.title = hint;
    b.addEventListener('click', fn);
    parent.appendChild(b);
    return b;
  }

  /**
   * A small popover a toolbar button opens: `div.ed-wave-pop` plus the given
   * class. `wave-ui.js` places it under its button and owns opening and
   * closing (only one is open at a time).
   */
  function popover(cls) {
    const el = d.createElement('div');
    el.className = 'ed-wave-pop ' + cls;
    return el;
  }

  /**
   * A menu popover. `items` are `{ key, label, title, run }`; `key` becomes
   * both the item's class and its `data-focus-key`, like `toolButton`.
   */
  function menu(cls, items) {
    const el = popover('ed-wave-menu ' + cls);
    el.setAttribute('role', 'menu');
    for (const item of items) {
      const b = d.createElement('button');
      b.type = 'button';
      b.className = 'ed-wave-menu-item ' + item.key;
      b.setAttribute('data-focus-key', item.key);
      b.setAttribute('role', 'menuitem');
      b.textContent = item.label;
      if (item.title) b.title = item.title;
      b.addEventListener('click', item.run);
      el.appendChild(b);
    }
    return el;
  }

  /**
   * The grid 更多 opens (spec section 4.2): one titled row per group.
   * `groups` is `[[title, [ch, ...]], ...]`; `makeBrush(ch)` builds the same
   * button the toolbar's resident brushes use, so a brush looks and acts the
   * same wherever it is picked from.
   */
  function brushGrid(groups, makeBrush) {
    const el = popover('ed-wave-brush-grid');
    for (const g of groups) {
      const row = d.createElement('div');
      row.className = 'ed-wave-brush-group';
      const title = d.createElement('span');
      title.className = 'ed-wave-brush-group-title';
      title.textContent = g[0];
      row.appendChild(title);
      const list = d.createElement('div');
      list.className = 'ed-wave-brushes';
      for (const ch of g[1]) list.appendChild(makeBrush(ch));
      row.appendChild(list);
      el.appendChild(row);
    }
    return el;
  }

  /**
   * The notice card under the toolbar (spec section 4.9): neutral, and it can
   * be folded away. `show(sentences)` fills it; no sentences hides it. The
   * folded state lives on the card for the rest of the session, so a repaint
   * does not unfold what the user folded.
   */
  function noticeCard() {
    const el = d.createElement('div');
    el.className = 'ed-wave-notice';
    el.hidden = true;
    const text = d.createElement('div');
    text.className = 'ed-wave-notice-text';
    el.appendChild(text);
    const fold = d.createElement('button');
    fold.type = 'button';
    fold.className = 'ed-wave-notice-fold';
    fold.setAttribute('data-focus-key', 'ed-wave-notice-fold');
    fold.textContent = '收起';
    fold.addEventListener('click', function () {
      const folded = el.hasAttribute('data-folded');
      if (folded) el.removeAttribute('data-folded');
      else el.setAttribute('data-folded', '');
      fold.textContent = folded ? '收起' : '展開';
      fold.setAttribute('aria-expanded', folded ? 'true' : 'false');
    });
    fold.setAttribute('aria-expanded', 'true');
    el.appendChild(fold);
    function show(sentences) {
      el.hidden = sentences.length === 0;
      text.textContent = sentences.join(' ');
    }
    return { el: el, show: show };
  }

  /**
   * A numeral typed into `hscale`/`period`/`phase` is committed as a real
   * JS `number`, not as the string the `<input>` holds — unlike the eight
   * banner fields' `commitBanner`, which always writes a string and is
   * correct to (see its own header comment: the engine's `captext` and
   * `ticktock` both accept a plain string). These three are different:
   * `wave-geometry.hscaleOf`/`layoutOf` gate on `typeof … === 'number'`, so
   * a STRING `"2"` would silently read as "unset" to the editor's geometry —
   * its default of 1/0 — while the engine that draws the canvas still
   * honours it (its `tonumber()` coerces a string with `>`). That is the
   * exact same-idea-two-definitions divergence this batch has already paid
   * for three times elsewhere (see `md2doc`'s CLAUDE.md). Blank clears the
   * field (the `undefined` sentinel `setConfigField`/`setLaneField` both
   * read); anything that is not a plain, trimmed number is left as the raw
   * string — both the geometry's `typeof` gate and the engine's own
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

  /**
   * Where a lane inserted at display position `index` would actually land,
   * asked of the bridge rather than guessed.
   *
   * This is constraint 4 made visible. `laneInsertPath` puts an insert at a
   * group's FIRST lane inside that group, and an insert at the position just
   * past its LAST lane outside it — a group can be joined at its head and
   * never at its tail. That asymmetry is not something a label can argue
   * away, so the label states it: the 訊號 menu's items say which container
   * they will land in before they are pressed (`data-lands-in` and the
   * title, computed when `wave-ui.js` opens the menu), and the notice says
   * it again after.
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
   * Say which parts of this document the editor cannot place, in the notice
   * card (spec section 4.9), and what to do about each: the next step is the
   * block's own MD source, reached by closing the editor.
   *
   * Edges are asked of `geometry.edgeLayoutDetail` — the walk that places
   * them — rather than re-derived here. Skips are bucketed by whatever
   * `reason` comes back, not by a list of the reasons known today, so a new
   * reason shows up as its own (generically worded) bucket instead of
   * escaping the notice. A point note (`<letter> <text>`) is not a skip:
   * the engine draws it (spec section 5-3).
   *
   * `found` is where a document property the canvas does not show would be
   * listed. It is empty today (period, phase and hscale are modelled) and is
   * still published as `data-wave-unmodelled`, so a test can tell "nothing to
   * report" from "never rendered".
   */
  function renderUnmodelled(doc, layout, card) {
    const found = [];
    const detail = geometry.edgeLayoutDetail(doc, layout);
    const buckets = new Map();
    for (const skip of detail.skipped) {
      if (!buckets.has(skip.reason)) buckets.set(skip.reason, []);
      buckets.get(skip.reason).push(skip);
    }
    function which(list) {
      return '第 ' + list.map(function (s) { return s.index + 1; }).join('、') + ' 條關聯線';
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
    // Only the letters no lane carries: a dangling edge's other end is real.
    const nodes = codec.nodesOf(doc);
    function missing(list) {
      return letters(list).filter(function (l) { return nodes[l] === undefined; });
    }
    const NEXT = '關閉後用區塊 ⠿ →「MD 原始碼」修改。';
    // `dangling` and `unparseable` are not drawn by the engine either;
    // `out-of-range` is drawn by the engine but the editor cannot place its
    // ends, so it cannot be selected or dragged here.
    const REASON_TEXT = {
      dangling: function (list) {
        return which(list) + '用到不存在的錨點字母（' + missing(list).join('、') + '），畫不出來；' + NEXT;
      },
      unparseable: function (list) {
        return which(list) + '的寫法認不得，畫不出來；' + NEXT;
      },
      'out-of-range': function (list) {
        return which(list) + '的錨點（' + letters(list).join('、') +
          '）落在那條訊號目前的長度之外，在這裡選不到也拖不動；' + NEXT;
      },
    };
    const sentences = [];
    if (found.length > 0) {
      sentences.push('這份文件用了 ' + found.join('、') + '，編輯器沒有把它們畫出來；' + NEXT);
    }
    for (const [reason, list] of buckets) {
      const text = REASON_TEXT[reason];
      sentences.push(text ? text(list) : which(list) + '因為「' + reason + '」畫不出來；' + NEXT);
    }

    const danglingCount = buckets.has('dangling') ? buckets.get('dangling').length : 0;
    overlay.setAttribute('data-wave-unmodelled', found.join(' '));
    overlay.setAttribute('data-wave-dangling-edges', String(danglingCount));
    overlay.setAttribute('data-wave-skipped-edges', String(detail.skipped.length));

    // This editor edits `signal:` and nothing else, so a `reg:` or `assign:`
    // block opens with no lanes. Say so rather than look broken.
    const kinds = [];
    for (const key of ['reg', 'assign']) {
      if (doc[key] !== undefined) kinds.push(key + ':');
    }
    const noLanes = codec.lanePaths(doc).length === 0;
    overlay.setAttribute('data-wave-nolanes', noLanes ? '1' : '0');
    if (noLanes) {
      sentences.unshift((kinds.length === 0
        ? '這個區塊裡沒有 signal:，所以沒有可以編輯的訊號；'
        : '這個區塊用的是 ' + kinds.join(' / ') + '，這個編輯器只編輯 signal: 的訊號；') +
        '要改這個區塊，' + NEXT);
    }
    card.show(sentences);
  }

  return {
    toolButton: toolButton,
    popover: popover,
    menu: menu,
    brushGrid: brushGrid,
    noticeCard: noticeCard,
    renderUnmodelled: renderUnmodelled,
    // Where an insert lands, asked of the bridge (constraint 4 in
    // wave-ui.js); the 訊號 menu says it before and after.
    landingOf: landingOf,
    // The settings and lane fields' write side, kept for the popovers of
    // Tasks 8 and 10 (spec section 4.9).
    commitBanner: commitBanner,
    commitConfigField: commitConfigField,
    commitLaneField: commitLaneField,
    tickTockText: tickTockText,
  };
}

module.exports = { createPanels: createPanels };
