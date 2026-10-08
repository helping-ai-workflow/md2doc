'use strict';

/**
 * The wave editor's canvas, drawn by the WaveDrom engine itself
 * (wave-redesign spec §3).
 *
 * The editor used to paint its own picture of the waveform, and four of the
 * seven defects in spec §5 were that picture disagreeing with the reader's.
 * Here the engine draws the canvas — the same call the old preview panel
 * made — so what the editor shows IS the output. This module owns that call
 * and the coordinate bridge on top of it; the interaction layer (selection,
 * cursor, dots, handles) is drawn by the layers above, in client coordinates
 * this hands out.
 *
 * Coordinates, three spaces:
 *   - engine units: the svg's viewBox (a cycle is 40, a lane 30). `layout`
 *     and `measured` speak these.
 *   - the svg is enlarged by `scale` (width/height multiplied, viewBox kept),
 *     so one engine unit is `scale` CSS px.
 *   - client: what pointer events carry. Converted by subtracting the svg's
 *     client rect and dividing by `scale`.
 *
 * UMD: in the edit page lib/editor/server.js wraps this as the
 * `window.__md2docWave['wave-canvas.js']` module; every dependency (the
 * document, the engine, the theme API, geometry, codec) is handed in.
 */

/** How long a label can be beyond its segment: lib/wave-overflow.js `PAD`. */
const LABEL_PAD = 6;
/** The engine's cycle width in its own units (2 bricks of `lane.xs` 20). */
const CYCLE_UNITS = 40;

/**
 * A plain, unfrozen copy of a document: the store's documents are frozen and
 * the engine writes into the source it is given. Same bound as wave-panels.js
 * `plainCopy`, which this mirrors.
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

function createCanvas(opts) {
  const d = opts.d;
  const engine = opts.engine;
  const theme = opts.theme || null;
  const geometry = opts.geometry;
  const codec = opts.codec;
  const host = opts.host;
  // Not 0: the document's own diagrams render at 0, and the ids the engine
  // derives from the index would collide (wave-ui.js PREVIEW_INDEX explains
  // the measurement). The prefix avoids `WaveDrom_Display_`, which the
  // reader's own scripts (lightbox, recolour observer) treat as theirs.
  const index = opts.index === undefined ? 9000 : opts.index;
  const prefix = opts.prefix === undefined ? 'md2doc-wave-preview-' : opts.prefix;
  const scale = opts.scale === undefined ? 1.5 : opts.scale;

  const target = d.createElement('div');
  target.id = prefix + index;
  host.appendChild(target);

  let svg = null;
  let layout = null;
  let measured = null;
  let lastDoc = null;
  let destroyed = false;

  /**
   * The canvas background the label backings take in dark (spec §5-5): the
   * first ancestor of the host, the host included, whose computed background
   * is not transparent.
   */
  function backing() {
    for (let el = host; el && el.nodeType === 1; el = el.parentElement) {
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(bg)) return bg;
    }
    return undefined;
  }

  function recolour(dark) {
    if (theme === null || svg === null) return;
    theme.recolourSvg(svg, dark, { backing: backing() });
  }

  /**
   * Whether a WaveDrom skin is on the page OUTSIDE this canvas. The engine
   * empties the target before drawing, so a skin this canvas carried itself
   * would be gone by the time the new svg looked for it. `socket` is asked
   * for inside a WaveDrom svg's defs, not anywhere: a document's inline HTML
   * may carry its own `id="socket"` (wave-panels.js renderPreview).
   */
  function skinElsewhere() {
    const found = d.querySelectorAll('svg.WaveDrom defs #socket');
    for (let i = 0; i < found.length; i++) if (!target.contains(found[i])) return true;
    return false;
  }

  function render(doc) {
    if (engine === null || engine === undefined || typeof engine.RenderWaveForm !== 'function') {
      return { ok: false, error: '這一頁沒有載入 WaveDrom' };
    }
    if (!target.isConnected) return { ok: false, error: '畫布還沒放進頁面' };
    try {
      engine.RenderWaveForm(index, plainCopy(doc, 0), prefix, skinElsewhere());
    } catch (e) {
      svg = null; layout = null; measured = null;
      return { ok: false, error: 'WaveDrom 畫不出這份文件：' + String(e && e.message) };
    }
    svg = target.querySelector('svg');
    if (svg === null) {
      layout = null; measured = null;
      return { ok: false, error: 'WaveDrom 沒有畫出圖' };
    }
    const w = Number(svg.getAttribute('width'));
    const h = Number(svg.getAttribute('height'));
    svg.setAttribute('width', String(w * scale));
    svg.setAttribute('height', String(h * scale));
    if (theme !== null && theme.isDark()) recolour(true);
    lastDoc = doc;
    measured = geometry.measureEngineSvg(svg, doc);
    layout = geometry.layoutOf(doc, {
      laneHeight: measured.laneHeight,
      cycleWidth: CYCLE_UNITS,
      nameColWidth: measured.xg + 0.5,
      originY: measured.laneTops.length > 0 ? measured.laneTops[0] : measured.originY,
    });
    return { ok: true };
  }

  function origin() {
    const r = svg.getBoundingClientRect();
    return { left: r.left, top: r.top };
  }

  function toEngine(clientX, clientY) {
    const o = origin();
    return { x: (clientX - o.left) / scale, y: (clientY - o.top) / scale };
  }

  function cellAt(clientX, clientY) {
    if (layout === null) return null;
    const p = toEngine(clientX, clientY);
    return geometry.cellAt(layout, p.x, p.y);
  }

  function boundaryAt(clientX, clientY) {
    if (layout === null) return null;
    const p = toEngine(clientX, clientY);
    return geometry.boundaryAt(layout, p.x, p.y);
  }

  function cellRectClient(laneIndex, cycle) {
    if (layout === null) return null;
    const r = geometry.cellRect(layout, laneIndex, cycle);
    if (r === null) return null;
    const o = origin();
    return { left: o.left + r.x * scale, top: o.top + r.y * scale,
      width: r.width * scale, height: r.height * scale };
  }

  function anchorClient(laneIndex, cell) {
    if (layout === null) return null;
    const a = geometry.anchorOfCell(layout, laneIndex, cell);
    if (a === null) return null;
    const o = origin();
    return { x: o.left + a.x * scale, y: o.top + a.y * scale };
  }

  function labelBoxes() {
    if (measured === null) return [];
    const o = origin();
    return measured.labels.map(function (l) {
      return {
        laneIndex: l.laneIndex, slot: l.slot, text: l.text,
        left: o.left + (l.x - l.width / 2) * scale, top: o.top + l.y * scale,
        width: l.width * scale, height: l.height * scale,
      };
    });
  }

  /**
   * Labels wider than their segment, by the width the engine really drew —
   * the same rule as lib/wave-overflow.js `overflowOf` (label + LABEL_PAD
   * against the segment's `cells * 40 * period`, times hscale), which can
   * only estimate the width.
   */
  function overflow() {
    if (measured === null || layout === null) return [];
    const out = [];
    for (const l of measured.labels) {
      if (l.slot === null || l.cells === null) continue;
      const row = layout.lanes[l.laneIndex];
      const lane = row && row.lane && typeof row.lane === 'object' ? row.lane : {};
      const p = Number(lane.period);
      const unit = l.cells * CYCLE_UNITS * (p > 0 ? p : 1);
      const need = l.width + LABEL_PAD;
      if (need <= unit * layout.hscale) continue;
      out.push({ laneIndex: l.laneIndex, slot: l.slot, label: l.text, needScale: Math.ceil(need / unit) });
    }
    return out;
  }

  /**
   * The engine's own drawing of every `edge` entry it drew (Task 9): `[{index,
   * path, label}]`, `index` the entry's position in `doc.edge`, `path` the
   * engine's `gmark_<from>_<to>` path, `label` the `g` holding its label box
   * or null. The engine writes them into `wavearcs_<index>` in entry order,
   * each path followed by its label when the entry has one, and skips an
   * entry when either letter names no anchor (render-arcs.js `archer`), so
   * the walk below repeats exactly that test: the same split of the entry
   * (`trim().split(/\s+/)`, the label taken from the UNtrimmed string) and
   * the same anchor set (every non-`.` character of every lane's `node`).
   * The lowercase letter labels the engine adds after the last edge are
   * never reached. If a drawn element is not the one expected (an id that
   * does not name the entry's letters), the walk stops there rather than
   * pair an entry with another entry's drawing.
   */
  function arcs() {
    if (svg === null || lastDoc === null || !Array.isArray(lastDoc.edge)) return [];
    const group = svg.querySelector('g[id^="wavearcs_"]');
    if (group === null) return [];
    const events = new Set();
    for (const p of codec.lanePaths(lastDoc)) {
      const lane = geometry.valueAt(lastDoc, p);
      const node = lane !== null && typeof lane === 'object' && typeof lane.node === 'string' ? lane.node : '';
      for (const ch of node) if (ch !== '.') events.add(ch);
    }
    const kids = [];
    for (let n = group.firstChild; n !== null; n = n.nextSibling) if (n.nodeType === 1) kids.push(n);
    const out = [];
    let k = 0;
    for (let i = 0; i < lastDoc.edge.length; i++) {
      const entry = lastDoc.edge[i];
      if (typeof entry !== 'string') return out;
      const head = entry.trim().split(/\s+/)[0];
      const from = head.substr(0, 1);
      const to = head.substr(-1, 1);
      if (!events.has(from) || !events.has(to)) continue;
      const path = kids[k];
      if (path === undefined || path.tagName.toLowerCase() !== 'path' ||
          path.getAttribute('id') !== 'gmark_' + from + '_' + to) return out;
      k++;
      let label = null;
      if (entry.substring(head.length).substring(1) !== '') {
        label = kids[k];
        if (label === undefined || label.tagName.toLowerCase() !== 'g') return out;
        k++;
      }
      out.push({ index: i, path: path, label: label });
    }
    return out;
  }

  // `onTheme` returns the unsubscribe (lib/theme/runtime.js); `destroy()`
  // calls it, so a closed canvas is not kept alive by the theme's listener
  // list — that listener reaches the host, and through it the whole editor
  // overlay and its store, for the life of the page (final review M3).
  let unsubscribe = null;
  if (theme !== null && typeof theme.onTheme === 'function') {
    const off = theme.onTheme(function (dark) { if (!destroyed) recolour(dark); });
    if (typeof off === 'function') unsubscribe = off;
  }

  /** Stops following the theme and takes the canvas out of the host. */
  function destroy() {
    destroyed = true;
    if (unsubscribe !== null) { unsubscribe(); unsubscribe = null; }
    if (target.parentNode) target.parentNode.removeChild(target);
    svg = null; layout = null; measured = null; lastDoc = null;
  }

  return {
    render: render,
    get svg() { return svg; },
    get layout() { return layout; },
    get measured() { return measured; },
    get doc() { return lastDoc; },
    scale: scale,
    cellAt: cellAt,
    boundaryAt: boundaryAt,
    cellRectClient: cellRectClient,
    anchorClient: anchorClient,
    labelBoxes: labelBoxes,
    overflow: overflow,
    arcs: arcs,
    destroy: destroy,
  };
}

const api = { createCanvas: createCanvas, plainCopy: plainCopy };
if (typeof module === 'object' && module.exports) module.exports = api;
else if (typeof window !== 'undefined') window.md2docWaveCanvas = api;
