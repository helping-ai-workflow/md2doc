'use strict';

/**
 * wave-overflow — estimate how wide a WaveDrom data label is and find the ones
 * wider than the segment they sit in.
 *
 * UMD: node `module.exports`, browser `window.md2docWaveOverflow`. Segments come
 * from wave-codec (`expandWave`, `dataSlotOf`), never from a second parser of
 * the wave string.
 *
 * Widths are the standard Helvetica AFM advances (1/1000 em) for ASCII 32-126;
 * anything else counts one em. The reader draws data labels in Helvetica at
 * 14.6667px, which measured 107px for twelve F and 149px for
 * "D2 (client FCS last 4B)"; this table reproduces both within 2px.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./editor/wave-codec.js'));
  } else {
    root.md2docWaveOverflow = factory(root.__md2docWave['wave-codec.js']);
  }
}(typeof self !== 'undefined' ? self : this, function (codec) {
  // Index 0 is code 32 (space).
  const AFM = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
  ];
  const DEFAULT_FONT_PX = 14.6667;
  const CYCLE_UNITS = 40;
  const PAD = 6;   // breathing room kept on top of the text

  function estimateTextWidth(text, fontPx) {
    const px = typeof fontPx === 'number' ? fontPx : DEFAULT_FONT_PX;
    let em = 0;
    for (const ch of String(text)) {
      const c = ch.codePointAt(0);
      em += (c >= 32 && c <= 126 ? AFM[c - 32] : 1000) / 1000;
    }
    return em * px;
  }

  // WaveDrom's own rule (parse-config.js): rounded, <=0 -> 1, capped at 100.
  function hscaleOf(doc) {
    const h = doc && doc.config && doc.config.hscale;
    if (!h) return 1;
    const n = Math.round(h > 0 ? Math.round(h) : 1);
    return n > 0 ? Math.min(n, 100) : 1;
  }

  function lanesOf(list, out) {
    for (const item of list) {
      if (Array.isArray(item)) lanesOf(item, out);
      else if (item && typeof item === 'object') out.push(item);
    }
    return out;
  }

  function dataList(lane) {
    if (Array.isArray(lane.data)) return lane.data.map(String);
    if (typeof lane.data === 'string') return lane.data.split(/\s+/).filter(Boolean);
    return [];
  }

  function overflowOf(doc) {
    const out = [];
    if (!doc || !Array.isArray(doc.signal)) return out;
    const hscale = hscaleOf(doc);
    lanesOf(doc.signal, []).forEach(function (lane, laneIndex) {
      if (typeof lane.wave !== 'string') return;
      const cells = codec.expandWave(lane.wave);
      const data = dataList(lane);
      const p = Number(lane.period);
      const period = p > 0 ? p : 1;
      for (let i = 0; i < cells.length; i++) {
        const slot = codec.dataSlotOf(lane, i);
        if (slot === null || slot >= data.length) continue;
        let n = 1;
        while (i + n < cells.length && cells[i + n].held) n++;
        const label = data[slot];
        const need = estimateTextWidth(label) + PAD;
        const unit = n * CYCLE_UNITS * period;
        if (need <= unit * hscale) continue;
        out.push({
          laneIndex: laneIndex, name: typeof lane.name === 'string' ? lane.name : '',
          slot: slot, label: label, cells: n, needScale: Math.ceil(need / unit),
        });
      }
    });
    return out;
  }

  function suggestScale(list, current) {
    let k = 0;
    for (const o of list || []) if (o.needScale > k) k = o.needScale;
    return k || (typeof current === 'number' ? current : 1);
  }

  return { estimateTextWidth: estimateTextWidth, overflowOf: overflowOf, suggestScale: suggestScale };
}));
