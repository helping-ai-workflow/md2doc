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
 * gives each of its parts a new home: a lane's period / phase and the group
 * rename come back in Task 8's name column (`laneMenu`, `renameField`,
 * `periodPhasePopover`), the edge inspector as the floating toolbar beside
 * an edge's label in Task 9 (`edgeToolbar`, `noteToolbar`, `inlineInput`),
 * and the settings fields as Task 10's ⚙ popover (`settingsPopover`).
 *
 * `deps`:
 *   d, geometry, codec   the document and the two modules, handed in
 *   overlay              the dialog root (the notice publishes its counts there)
 *   actions.commit(name, fn)   run one gesture (constraint 5 in wave-ui.js)
 */

/**
 * The edge toolbar's two button groups (spec section 4.5): 線型 straight /
 * curve / elbow by 箭頭 none / end / both, nine shapes. `SHAPE_ROWS` also
 * carries the half-curve and elbow variants 更多 offers, each with the
 * variant it becomes under each head (null: the variant has no such form),
 * so changing the head of `-|-` gives `-|->`, not `-|>`.
 */
const NINE = {
  straight: { none: '-', end: '->', both: '<->' },
  curve: { none: '~', end: '~>', both: '<~>' },
  elbow: { none: '-|', end: '-|>', both: '<-|>' },
};
const SHAPE_ROWS = [
  ['straight', ['-', '->', '<->']],
  ['curve', ['~', '~>', '<~>']],
  ['elbow', ['-|', '-|>', '<-|>']],
  ['curve', ['-~', '-~>', '<-~>']],
  ['curve', ['~-', '~->', null]],
  ['elbow', ['-|-', '-|->', '<-|->']],
  ['elbow', ['|-', '|->', null]],
];
const HEADS = ['none', 'end', 'both'];

/** `shape` -> `{line, head}`; both null for `+` (a tee at each end, no line
 *  family and no arrow) and for anything unknown. */
function shapeParts(shape) {
  for (const row of SHAPE_ROWS) {
    const at = row[1].indexOf(shape);
    if (at !== -1) return { line: row[0], head: HEADS[at] };
  }
  return { line: null, head: null };
}
/** The shape `shape` becomes when one of its parts changes: `{line}` picks
 *  from the nine and keeps the head; `{head}` keeps a 更多 variant when it
 *  has that head, else falls back to the nine. A part that `shape` does not
 *  have (`+`) reads as straight, no arrow. */
function shapeWith(shape, change) {
  const parts = shapeParts(shape);
  const line = parts.line === null ? 'straight' : parts.line;
  const head = parts.head === null ? 'none' : parts.head;
  if (change.line !== undefined) return NINE[change.line][head];
  for (const row of SHAPE_ROWS) {
    if (row[1].indexOf(shape) === -1) continue;
    const v = row[1][HEADS.indexOf(change.head)];
    if (v !== null && v !== undefined) return v;
  }
  return NINE[line][change.head];
}
const NINE_SHAPES = [].concat.apply([], Object.keys(NINE).map(function (k) {
  return HEADS.map(function (h) { return NINE[k][h]; });
}));

function createPanels(deps) {
  const d = deps.d;
  const geometry = deps.geometry;
  const codec = deps.codec;
  const actions = deps.actions;
  const overlay = deps.overlay;
  /** 更多's list: every shape the engine draws that is not one of the nine. */
  const MORE_SHAPES = codec.EDGE_SHAPES.filter(function (s) { return NINE_SHAPES.indexOf(s) === -1; });

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
   * A menu popover. `items` are `{ key, label, title, run, shortcut?, danger? }`;
   * `key` becomes both the item's class and its `data-focus-key`, like
   * `toolButton`. `shortcut` is the key the same action has elsewhere, shown
   * on the item's right; `danger` marks an item that removes something (red).
   */
  function menu(cls, items) {
    const el = popover('ed-wave-menu ' + cls);
    el.setAttribute('role', 'menu');
    for (const item of items) {
      const b = d.createElement('button');
      b.type = 'button';
      b.className = 'ed-wave-menu-item ' + item.key + (item.danger ? ' is-danger' : '');
      b.setAttribute('data-focus-key', item.key);
      b.setAttribute('role', 'menuitem');
      const label = d.createElement('span');
      label.className = 'ed-wave-menu-label';
      label.textContent = item.label;
      b.appendChild(label);
      if (item.shortcut) {
        const k = d.createElement('span');
        k.className = 'ed-wave-menu-key';
        k.textContent = item.shortcut;
        b.appendChild(k);
      }
      if (item.title) b.title = item.title;
      b.addEventListener('click', item.run);
      el.appendChild(b);
    }
    return el;
  }

  /**
   * The ⠿ menu of one row in the name column (spec section 4.4). A signal's
   * row: 改名 F2, 建立副本 Ctrl+D, 在下方新增訊號, 在下方新增空白列,
   * 上移 Alt+↑, 下移 Alt+↓, 和下一條組成群組, 週期與相位…, 刪除 Del (red).
   * A group's row (`isGroup`): 改名, 解散群組, 上移, 下移.
   *
   * `actions` holds what each item does, keyed by the item's suffix
   * (`rename`, `copy`, `addBelow`, `blankBelow`, `up`, `down`, `group`,
   * `period`, `remove`; for a group `rename`, `ungroup`, `up`, `down`). An
   * action that is missing leaves its item out: a blank row (`{}`) has no
   * name, so wave-ui hands it no `rename`. `anchor` is the grip that opens
   * the menu; wave-ui places the menu under it, as it does every toolbar
   * popover.
   */
  function laneMenu(anchor, opts) {
    const a = opts.actions;
    const spec = opts.isGroup ? [
      ['rename', 'ed-wave-lane-rename', '改名', '', '改這個群組的名稱'],
      ['ungroup', 'ed-wave-lane-ungroup', '解散群組', '', '拿掉這個群組，裡面的訊號留在原位'],
      ['up', 'ed-wave-lane-up', '上移', '', '整個群組往上搬一格'],
      ['down', 'ed-wave-lane-down', '下移', '', '整個群組往下搬一格'],
    ] : [
      ['rename', 'ed-wave-lane-rename', '改名', 'F2', '在名稱上直接改名'],
      ['copy', 'ed-wave-lane-copy', '建立副本', 'Ctrl+D', '在下面放一條一樣的訊號'],
      ['addBelow', 'ed-wave-lane-add-below', '在下方新增訊號', '', '在這一條下面加一條新訊號'],
      ['blankBelow', 'ed-wave-lane-blank-below', '在下方新增空白列', '', '在這一條下面插入一個空白列（WaveJSON 的 {}）'],
      ['up', 'ed-wave-lane-up', '上移', 'Alt+↑', '往上搬一格'],
      ['down', 'ed-wave-lane-down', '下移', 'Alt+↓', '往下搬一格'],
      ['group', 'ed-wave-lane-group', '和下一條組成群組', '', '把這一條和下一條包成一個群組，接著替它取名'],
      ['period', 'ed-wave-lane-period', '週期與相位…', '', '這一條的 period（每個字元佔幾拍）與 phase（往左移幾拍）'],
      ['remove', 'ed-wave-lane-delete', '刪除', 'Del', '刪掉這一條（Ctrl+Z 可以拿回來）'],
    ];
    const items = [];
    for (const s of spec) {
      if (typeof a[s[0]] !== 'function') continue;
      items.push({ key: s[1], label: s[2], shortcut: s[3], title: s[4], run: a[s[0]], danger: s[0] === 'remove' });
    }
    const el = menu('ed-wave-lane-menu', items);
    if (anchor && typeof anchor.getAttribute === 'function') {
      el.setAttribute('data-for', anchor.getAttribute('data-focus-key') || '');
    }
    return el;
  }

  /**
   * The in-place name field (spec section 4.4): a signal's name or a group's
   * title, typed where it is drawn. wave-ui places it and decides what a
   * commit writes; this owns the keys.
   *
   * `opts`: `value`, `focusKey`, `onCommit(value)`, `onCancel()`.
   * Enter commits and Esc cancels; `change` and `blur` commit too — but
   * never while an input method is composing (spec section 7.2): the Enter
   * that picks a candidate, the Esc that drops a composition and the Tab
   * some IMEs page with belong to the IME. wave-ui's dialog-level key
   * handler already stands aside for those keys; the field's own handlers
   * have to as well, and a `change` fired as a composition is committed is
   * not a commit either.
   */
  function renameField(opts) {
    const input = d.createElement('input');
    input.type = 'text';
    input.className = 'ed-wave-rename';
    input.setAttribute('data-focus-key', opts.focusKey);
    input.setAttribute('aria-label', '名稱');
    input.value = opts.value;
    let composing = false;
    input.addEventListener('compositionstart', function () { composing = true; });
    input.addEventListener('compositionend', function () { composing = false; });
    input.addEventListener('keydown', function (ev) {
      if (composing || ev.isComposing === true || ev.keyCode === 229) return;
      if (ev.key === 'Enter') {
        ev.preventDefault();
        ev.stopPropagation();
        opts.onCommit(input.value);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        opts.onCancel();
      }
    });
    input.addEventListener('change', function () { if (!composing) opts.onCommit(input.value); });
    input.addEventListener('blur', function () { opts.onCommit(input.value); });
    return input;
  }

  /**
   * 週期與相位… (spec section 4.4): one lane's `period` and `phase`, the two
   * fields the side rail's Lane section used to hold. Each is written when
   * it is committed (Enter, or leaving it) through `commitLaneField`, so a
   * numeral goes in as a number and a blank field removes the key; the
   * panel stays open for the other field. Composition is respected the same
   * way as in the name field.
   *
   * `lane` is the lane object (read for the current values), `at` its
   * display position.
   */
  function periodPhasePopover(lane, at) {
    const el = popover('ed-wave-period-pop');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', '週期與相位');
    const laneObj = lane !== null && typeof lane === 'object' ? lane : {};
    for (const key of ['period', 'phase']) {
      const row = d.createElement('label');
      row.className = 'ed-wave-period-row';
      const cap = d.createElement('span');
      cap.className = 'ed-wave-period-cap';
      cap.textContent = key === 'period' ? '週期 period' : '相位 phase';
      row.appendChild(cap);
      const input = d.createElement('input');
      input.type = 'text';
      input.className = 'ed-wave-period-input';
      input.setAttribute('data-focus-key', 'ed-wave-lane-' + key + '-input');
      input.setAttribute('inputmode', 'decimal');
      const now = laneObj[key];
      input.value = now === undefined || now === null ? '' : String(now);
      input.title = key === 'period'
        ? '每個波形字元佔幾拍（空白＝1）' : '整條往左移幾拍，可以是小數（空白＝0）';
      let composing = false;
      let written = input.value;
      const commitNow = function () {
        if (composing || input.value === written) return;
        written = input.value;
        commitLaneField(at, key, input.value);
      };
      input.addEventListener('compositionstart', function () { composing = true; });
      input.addEventListener('compositionend', function () { composing = false; });
      input.addEventListener('keydown', function (ev) {
        if (composing || ev.isComposing === true || ev.keyCode === 229) return;
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        ev.stopPropagation();
        commitNow();
      });
      input.addEventListener('change', commitNow);
      row.appendChild(input);
      el.appendChild(row);
    }
    return el;
  }

  /**
   * ⚙ 整張圖 (spec section 4.6): the document-wide settings the side rail's
   * 文件 section used to hold. Top level: 標題 (`head.text`, a multi-line
   * box), 每拍寬度 (`config.hscale` as 1× 2× 3× 4× — the engine rounds it to
   * an integer, so only integers are offered), and, when a data label is
   * wider than its segment, a card saying how many with 「改成每拍 K×」. Under
   * 進階 (folded when the popover opens): `head.tick` / `tock` / `every`,
   * `foot.text`, `foot.tick` / `tock` / `every`.
   *
   * `opts`:
   *   doc        the document now (read for the current values)
   *   overflow   `[{needScale}, ...]` — the labels wider than their segment
   *   scale      the smallest scale that fits them all (K), when there are any
   *   actions    `setHeadText(text)`, `setScale(k, fromCard)`, `setBanner(which, key, value)`
   *
   * A text field is written when it is committed: Enter (Shift+Enter is a new
   * line in 標題), leaving it, or `flush()` — which wave-ui calls when the
   * popover closes, because a field taken out of the page never fires
   * `change` and 「改了立即生效」 must not lose what was typed. A field whose
   * text has not changed since it was last written writes nothing. While an
   * input method is composing, Enter belongs to it (spec section 7.2).
   *
   * Clearing a field writes `''`, which `codec.setBannerField` turns into a
   * DELETED key. A numeral in tick / tock / every is written as a number:
   * the pinned engine adds the hbounds offset to them with `+`
   * (parse-config.js `source.head.tick + lane.xmin_cfg/2`), so a STRING
   * `"5"` becomes `"50"` and the ruler starts at 50.
   *
   * Returns the popover element. `el.refresh({doc, overflow, scale})`
   * brings it in line with a repaint in place — a field holding unwritten
   * text keeps it — and `el.flush()` writes every field with unwritten text.
   */
  function settingsPopover(anchor, opts) {
    const actions = opts.actions;
    const el = popover('ed-wave-settings-pop');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', '整張圖');
    if (anchor && typeof anchor.getAttribute === 'function') {
      el.setAttribute('data-for', anchor.getAttribute('data-focus-key') || '');
    }
    const fields = [];

    function caption(parent, text) {
      const c = d.createElement('div');
      c.className = 'ed-wave-set-cap';
      c.textContent = text;
      parent.appendChild(c);
      return c;
    }
    /** One text field bound to `read(doc)` and written by `write(text)`. */
    function textField(parent, key, label, read, write, multi, spoken) {
      const row = d.createElement('label');
      row.className = 'ed-wave-set-row';
      const cap = d.createElement('span');
      cap.className = 'ed-wave-set-label';
      cap.textContent = label;
      row.appendChild(cap);
      const input = d.createElement(multi ? 'textarea' : 'input');
      if (multi) input.rows = 2;
      else input.type = 'text';
      input.className = 'ed-wave-set-input';
      input.setAttribute('data-focus-key', key);
      input.setAttribute('aria-label', spoken || label);
      row.appendChild(input);
      parent.appendChild(row);
      const f = { input: input, read: read, written: '' };
      f.commit = function () {
        if (input.value === f.written) return;
        f.written = input.value;
        write(input.value);
      };
      let composing = false;
      input.addEventListener('compositionstart', function () { composing = true; });
      input.addEventListener('compositionend', function () { composing = false; });
      input.addEventListener('keydown', function (ev) {
        if (composing || ev.isComposing === true || ev.keyCode === 229) return;
        if (ev.key !== 'Enter' || ev.shiftKey) return;
        ev.preventDefault();
        ev.stopPropagation();
        f.commit();
      });
      input.addEventListener('change', function () { if (!composing) f.commit(); });
      fields.push(f);
      return f;
    }
    function bannerValue(key, text) {
      return key !== 'text' && /^-?\d+(\.\d+)?$/.test(text.trim()) ? Number(text) : text;
    }
    function bannerField(parent, which, key, label) {
      // Spoken with its band: two fields on screen are both captioned 標題,
      // and three pairs tick / tock / every.
      const spoken = (which === 'head' ? '上方' : '下方') + (key === 'text' ? '標題' : '刻度 ' + key);
      textField(parent, 'ed-wave-set-' + which + '-' + key, label,
        function (doc) {
          const b = doc[which];
          return b !== null && typeof b === 'object' ? tickTockText(b[key]) : '';
        },
        function (text) { actions.setBanner(which, key, bannerValue(key, text)); }, false, spoken);
    }

    textField(el, 'ed-wave-set-head', '標題',
      function (doc) { return doc.head && typeof doc.head === 'object' ? tickTockText(doc.head.text) : ''; },
      function (text) { actions.setHeadText(text); }, true);

    caption(el, '每拍寬度');
    const scales = d.createElement('div');
    scales.className = 'ed-wave-set-scales';
    scales.setAttribute('role', 'group');
    scales.setAttribute('aria-label', '每拍寬度');
    const scaleBtns = [];
    for (let k = 1; k <= 4; k++) {
      const b = toolButton('ed-wave-set-scale', k + '×', '每拍寬度 ' + k + ' 倍（config.hscale）', function () {
        actions.setScale(k);
      }, scales);
      b.setAttribute('data-focus-key', 'ed-wave-set-scale-' + k);
      b.setAttribute('aria-pressed', 'false');
      scaleBtns.push(b);
    }
    el.appendChild(scales);

    // The overflow card (spec section 4.6, and section 6 for K > 4).
    const card = d.createElement('div');
    card.className = 'ed-wave-set-overflow';
    card.hidden = true;
    const cardText = d.createElement('span');
    cardText.className = 'ed-wave-set-overflow-text';
    card.appendChild(cardText);
    const fix = toolButton('ed-wave-set-fix', '', '', function () {
      const k = Number(fix.getAttribute('data-scale'));
      // `true`: from the card, whose button goes away with what it fixes.
      if (k > 0) actions.setScale(k, true);
    }, card);
    el.appendChild(card);

    const advBtn = toolButton('ed-wave-set-advanced', '進階', '上方刻度、下方標題與下方刻度', function () {
      const open = advBtn.getAttribute('aria-expanded') !== 'true';
      advBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      adv.hidden = !open;
    }, el);
    advBtn.setAttribute('aria-expanded', 'false');
    const adv = d.createElement('div');
    adv.className = 'ed-wave-set-adv';
    adv.hidden = true;
    caption(adv, '上方刻度');
    bannerField(adv, 'head', 'tick', 'tick');
    bannerField(adv, 'head', 'tock', 'tock');
    bannerField(adv, 'head', 'every', 'every');
    caption(adv, '下方');
    bannerField(adv, 'foot', 'text', '標題');
    bannerField(adv, 'foot', 'tick', 'tick');
    bannerField(adv, 'foot', 'tock', 'tock');
    bannerField(adv, 'foot', 'every', 'every');
    el.appendChild(adv);

    function refresh(state) {
      const doc = state.doc;
      for (const f of fields) {
        const now = f.read(doc);
        // Text typed and not yet written stays; everything else follows the
        // document (an undo, the other fields' writes).
        if (f.input.value !== f.written) { f.written = now; continue; }
        f.written = now;
        if (f.input.value !== now) f.input.value = now;
      }
      const cfg = doc.config !== null && typeof doc.config === 'object' ? doc.config : {};
      const hscale = typeof cfg.hscale === 'number' ? cfg.hscale : (cfg.hscale === undefined ? 1 : null);
      scaleBtns.forEach(function (b, i) { b.setAttribute('aria-pressed', hscale === i + 1 ? 'true' : 'false'); });
      const list = state.overflow || [];
      const k = state.scale;
      card.hidden = list.length === 0;
      if (list.length === 0) {
        fix.removeAttribute('data-scale');
        return;
      }
      cardText.textContent = list.length + ' 個資料標籤比它那一段寬' +
        (k > 4 ? '；需要每拍 ' + k + '×，圖會比內文寬並被縮小' : '');
      fix.textContent = '改成每拍 ' + k + '×';
      fix.title = '把每拍寬度改成 ' + k + ' 倍，讓每個標籤都放得下';
      fix.setAttribute('data-scale', String(k));
    }
    for (const f of fields) {
      f.written = f.read(opts.doc);
      f.input.value = f.written;
    }
    refresh({ doc: opts.doc, overflow: opts.overflow, scale: opts.scale });
    el.refresh = refresh;
    el.flush = function () { for (const f of fields) f.commit(); };
    return el;
  }

  /**
   * 匯出 ⌄ (spec section 4.6): 複製為圖片, 下載 PNG, 下載 SVG, 複製 WaveJSON,
   * and the line that says every export is light on white. `acts` holds
   * what each does (`copyImage`, `downloadPng`, `downloadSvg`, `copyJson`);
   * wave-ui closes the menu and runs it in the same click, which 複製為圖片
   * needs (the clipboard item has to be made inside the press).
   */
  function exportMenu(anchor, acts) {
    const el = menu('ed-wave-export-pop', [
      { key: 'ed-wave-export-copyimg', label: '複製為圖片', title: '把這張波形的 PNG（2 倍大小）放進剪貼簿', run: acts.copyImage },
      { key: 'ed-wave-export-png', label: '下載 PNG', title: '存成 PNG 檔（白底，2 倍大小）', run: acts.downloadPng },
      { key: 'ed-wave-export-svg', label: '下載 SVG', title: '存成 SVG 檔（自帶 WaveDrom 的 skin，離開這一頁也畫得出來）', run: acts.downloadSvg },
      { key: 'ed-wave-export-json', label: '複製 WaveJSON', title: '把這張波形的 WaveJSON 複製到剪貼簿', run: acts.copyJson },
    ]);
    const note = d.createElement('div');
    note.className = 'ed-wave-export-note';
    note.textContent = '匯出一律是淺色、白底';
    el.appendChild(note);
    if (anchor && typeof anchor.getAttribute === 'function') {
      el.setAttribute('data-for', anchor.getAttribute('data-focus-key') || '');
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
   * The floating toolbar over a selected run of cycles (spec section 4.3):
   * 電位 ⌄, 複製, 刪除 N 拍, 前插, 後插, 關聯線 (A), 標註 (T), in that order.
   * The last two are W5's, folded in here; like the rest, what they do
   * arrives from wave-ui.js in `actions`.
   *
   * `anchor` is `{left, top, width}`: where the toolbar goes, in its
   * container's coordinates. wave-ui.js measures the toolbar once it is on
   * screen and moves it (above the run, or below it when there is no room),
   * so this only sets the first position.
   *
   * A press with the pointer does not take the keyboard off the canvas
   * (`mousedown` is cancelled), so the arrows, Del and Ctrl+V keep working
   * on the drawing after a button is clicked. Tab still reaches every
   * button, and a button pressed from the keyboard keeps it.
   */
  function rangeToolbar(anchor, opts) {
    const count = opts.count;
    const actions = opts.actions;
    const el = d.createElement('div');
    el.className = 'ed-wave-range';
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', '選取的 ' + count + ' 拍');
    el.style.left = anchor.left + 'px';
    el.style.top = anchor.top + 'px';
    const items = [
      ['ed-wave-range-level', '電位 ⌄', '把這 ' + count + ' 拍改成同一個電位', actions.level],
      ['ed-wave-range-copy', '複製', '複製這 ' + count + ' 拍（在畫布上按 Ctrl+V 貼到選取的位置前面）', actions.copy],
      ['ed-wave-range-delete', '刪除 ' + count + ' 拍', '刪掉這 ' + count + ' 拍（每一條訊號同時變窄；Del 也可以）', actions.remove],
      ['ed-wave-range-before', '前插', '在這一段前面插入一拍', actions.insertBefore],
      ['ed-wave-range-after', '後插', '在這一段後面插入一拍', actions.insertAfter],
      ['ed-wave-range-edge', '關聯線 A', '從這一拍拉一條關聯線（A）', actions.edge],
      ['ed-wave-range-note', '標註 T', '在這一拍加一個標註（T）', actions.note],
    ];
    for (const it of items) {
      const run = it[3];
      const b = toolButton(it[0], it[1], it[2], function () { run(b); }, el);
      b.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
      if (it[0] === 'ed-wave-range-level') {
        b.setAttribute('aria-haspopup', 'true');
        b.setAttribute('aria-expanded', 'false');
      }
    }
    return el;
  }

  /**
   * The floating toolbar beside a selected edge's label (spec section 4.5):
   * 線型 (直 曲 折) and 箭頭 (無 單向 雙向) as two button groups, 更多 (the
   * other eleven shapes, listed inside the toolbar when it is opened),
   * 改標籤 and 刪除. `opts.shape` is the edge's shape now, which decides the
   * pressed line and head (`shapeParts`); every press goes to wave-ui.js
   * through `opts.actions`: `setLine(line)`, `setHead(head)`, `more(shape)`,
   * `editLabel()`, `remove()`, and `resized()` (optional) after 更多 opens
   * or folds, so wave-ui.js can move the taller or shorter toolbar.
   *
   * Like the range toolbar, a press with the pointer does not take the
   * keyboard off the canvas, so Del and Enter keep meaning the selected
   * edge; Tab still reaches every button.
   */
  function edgeToolbar(anchor, opts) {
    const actions = opts.actions;
    const parts = shapeParts(opts.shape);
    const el = barShell(anchor, '關聯線');
    const group = function (label) {
      const g = d.createElement('div');
      g.className = 'ed-wave-edge-group';
      g.setAttribute('role', 'group');
      g.setAttribute('aria-label', label);
      el.appendChild(g);
      return g;
    };
    const lines = group('線型');
    for (const [line, text, title] of [['straight', '直', '直線'], ['curve', '曲', '曲線'], ['elbow', '折', '折線']]) {
      const b = barButton('ed-wave-edge-line-' + line, text, title, function () { actions.setLine(line); }, lines);
      b.setAttribute('aria-pressed', parts.line === line ? 'true' : 'false');
    }
    const heads = group('箭頭');
    for (const [head, text, title] of [['none', '無', '沒有箭頭'], ['end', '單向', '終點一個箭頭'], ['both', '雙向', '兩端都有箭頭']]) {
      const b = barButton('ed-wave-edge-head-' + head, text, title, function () { actions.setHead(head); }, heads);
      b.setAttribute('aria-pressed', parts.head === head ? 'true' : 'false');
    }
    const list = d.createElement('div');
    list.className = 'ed-wave-edge-more-list';
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', '其他形狀');
    list.hidden = true;
    const moreBtn = barButton('ed-wave-edge-more', '更多 ⌄', '其他 11 種形狀（半曲、中折、先直後橫、+）', function () {
      list.hidden = !list.hidden;
      moreBtn.setAttribute('aria-expanded', list.hidden ? 'false' : 'true');
      if (typeof actions.resized === 'function') actions.resized();
    }, el);
    moreBtn.setAttribute('aria-expanded', 'false');
    barButton('ed-wave-edge-label', '改標籤', '在線上改標籤（Enter 或雙擊標籤也可以）', function () { actions.editLabel(); }, el);
    barButton('ed-wave-edge-delete', '刪除', '刪掉這條關聯線（Del 也可以）', function () { actions.remove(); }, el)
      .classList.add('is-danger');
    MORE_SHAPES.forEach(function (shape, i) {
      const b = barButton('ed-wave-edge-shape-' + i, shape, '形狀 ' + shape, function () { actions.more(shape); }, list);
      b.setAttribute('data-shape', shape);
      b.setAttribute('aria-pressed', opts.shape === shape ? 'true' : 'false');
    });
    el.appendChild(list);
    return el;
  }

  /**
   * The same floating toolbar for a selected point note (spec section 4.5):
   * 改文字, 拉成關聯線, 刪除 — `opts.actions.editText()`, `toEdge()`,
   * `remove()`.
   */
  function noteToolbar(anchor, opts) {
    const actions = opts.actions;
    const el = barShell(anchor, '標註');
    barButton('ed-wave-note-text', '改文字', '在標註上改文字（Enter 或雙擊也可以）', function () { actions.editText(); }, el);
    barButton('ed-wave-note-to-edge', '拉成關聯線', '從這個標註的位置拉一條關聯線，文字變成線的標籤', function () { actions.toEdge(); }, el);
    barButton('ed-wave-note-delete', '刪除', '刪掉這個標註（Del 也可以）', function () { actions.remove(); }, el)
      .classList.add('is-danger');
    return el;
  }

  function barShell(anchor, label) {
    const el = d.createElement('div');
    el.className = 'ed-wave-edge-bar';
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', label);
    el.style.left = anchor.left + 'px';
    el.style.top = anchor.top + 'px';
    return el;
  }
  function barButton(key, text, title, run, parent) {
    const b = toolButton(key, text, title, run, parent);
    b.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
    return b;
  }

  /**
   * One line of text typed where it is drawn (spec section 4.5): an edge's
   * label or a point note's text, `input.ed-wave-edge-input[data-kind]`.
   * wave-ui.js places it and decides what a commit writes — and what
   * Escape means, because for a label field opened on a brand-new edge
   * Escape takes the edge back off (the dialog's own Escape layering). This
   * owns Enter and the composition: Enter commits, but never while an input
   * method is composing (spec section 7.2), and neither does the `change` or
   * `blur` a committed composition can fire.
   *
   * `opts`: `kind` ('label' | 'note'), `value`, `focusKey`, `label` (the
   * field's accessible name), `onCommit(value)`.
   */
  function inlineInput(opts) {
    const input = d.createElement('input');
    input.type = 'text';
    input.className = 'ed-wave-edge-input';
    input.setAttribute('data-kind', opts.kind);
    input.setAttribute('data-focus-key', opts.focusKey);
    input.setAttribute('aria-label', opts.label);
    input.value = opts.value;
    let composing = false;
    input.addEventListener('compositionstart', function () { composing = true; });
    input.addEventListener('compositionend', function () { composing = false; });
    input.addEventListener('keydown', function (ev) {
      if (composing || ev.isComposing === true || ev.keyCode === 229) return;
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      ev.stopPropagation();
      opts.onCommit(input.value);
    });
    input.addEventListener('change', function () { if (!composing) opts.onCommit(input.value); });
    input.addEventListener('blur', function () { if (!composing) opts.onCommit(input.value); });
    return input;
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
   * JS `number`, not as the string the `<input>` holds. (The banner fields
   * do the same for tick / tock / every since Task 10 — see `bannerValue`
   * in `settingsPopover` for the engine's `+` that turns a string `"5"`
   * into `"50"`; their `.text` stays a string.) For these three:
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
    return actions.commit('config.' + key, function (doc) {
      return codec.setConfigField(doc, key, parseNumericField(value));
    });
  }

  function commitLaneField(at, key, value) {
    actions.commit('lane.' + key, function (doc) {
      return codec.setLaneField(doc, at, key, parseNumericField(value));
    });
  }

  /**
   * A copy of `node` with the value at `path` replaced, sharing every subtree
   * it does not have to copy — so the store's lane-identity bookkeeping
   * (`remapOrigins` matches lanes by identity across a structural edit) still
   * sees each untouched lane as the same object. The codec's lane operations
   * cover lanes; a group's own title and its place among its siblings are
   * the two writes they do not, and both go through this.
   */
  function replaceAt(node, path, value) {
    if (path.length === 0) return value;
    const seg = path[0];
    const child = replaceAt(node[seg], path.slice(1), value);
    const out = Array.isArray(node) ? node.slice() : Object.assign({}, node);
    out[seg] = child;
    return out;
  }

  /** The group at `path` gets the title `value` (spec section 4.4, 改名). */
  function commitGroupTitle(path, value) {
    return actions.commit('rename-group', function (doc) {
      const group = geometry.valueAt(doc, path);
      if (!Array.isArray(group) || typeof group[0] !== 'string' || group[0] === value) return doc;
      return replaceAt(doc, path.concat([0]), value);
    });
  }

  /**
   * Where the group at `path` lands when it trades places with its neighbour
   * one step `dir` (-1 up, 1 down) in the array that holds it — a lane, a
   * blank row or another group — or null when there is none that way. The
   * title at index 0 of a titled parent group is not a neighbour.
   */
  function groupStepPath(doc, path, dir) {
    const parentPath = path.slice(0, -1);
    const parent = geometry.valueAt(doc, parentPath);
    if (!Array.isArray(parent)) return null;
    const first = parentPath.length > 1 && typeof parent[0] === 'string' ? 1 : 0;
    const at = path[path.length - 1];
    const to = at + dir;
    if (to < first || to >= parent.length) return null;
    return parentPath.concat([to]);
  }

  /** 上移 / 下移 for a whole group: swap it with that neighbour. */
  function commitGroupMove(path, dir) {
    return actions.commit('move-group', function (doc) {
      const dest = groupStepPath(doc, path, dir);
      if (dest === null) return doc;
      const parentPath = path.slice(0, -1);
      const next = geometry.valueAt(doc, parentPath).slice();
      const a = path[path.length - 1];
      const b = dest[dest.length - 1];
      const held = next[a];
      next[a] = next[b];
      next[b] = held;
      return replaceAt(doc, parentPath, next);
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
    return actions.commit(which + '.' + key, function (doc) { return codec.setBannerField(doc, which, key, value); });
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
   * exists to avoid elsewhere in this file. Editing the field commits a
   * number for a plain numeral and the typed string otherwise (Task 10's
   * `settingsPopover`): the engine adds the hbounds offset to tick / tock
   * with `+`, so the STRING `"5"` would start the ruler at 50.
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
    // Task 8 (spec section 4.4): the name column's ⠿ menu, its in-place
    // name field and 週期與相位…, and the two group writes.
    laneMenu: laneMenu,
    renameField: renameField,
    periodPhasePopover: periodPhasePopover,
    commitGroupTitle: commitGroupTitle,
    groupStepPath: groupStepPath,
    commitGroupMove: commitGroupMove,
    brushGrid: brushGrid,
    // Task 10 (spec section 4.6): ⚙ 整張圖 and 匯出 ⌄.
    settingsPopover: settingsPopover,
    exportMenu: exportMenu,
    rangeToolbar: rangeToolbar,
    // Task 9 (spec section 4.5): the edge and note toolbars, their shape
    // arithmetic, and the inline label / note field.
    edgeToolbar: edgeToolbar,
    noteToolbar: noteToolbar,
    inlineInput: inlineInput,
    shapeParts: shapeParts,
    shapeWith: shapeWith,
    noticeCard: noticeCard,
    renderUnmodelled: renderUnmodelled,
    // Where an insert lands, asked of the bridge (constraint 4 in
    // wave-ui.js); the 訊號 menu says it before and after.
    landingOf: landingOf,
    // The settings and lane fields' write side (spec section 4.9): the
    // lane fields are Task 8's 週期與相位…, the settings Task 10's.
    commitBanner: commitBanner,
    commitConfigField: commitConfigField,
    commitLaneField: commitLaneField,
    tickTockText: tickTockText,
  };
}

module.exports = { createPanels: createPanels, shapeParts: shapeParts, shapeWith: shapeWith, NINE: NINE };
