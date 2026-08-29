'use strict';
/* Spec §3.4 — 縮排合法性：位移後再夾取.
   UMD, same shape as lineops.js: `require`-able in node for the unit tests,
   and injected into the editor page as `window.md2docIndentClamp`. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.md2docIndentClamp = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // Markdown indent is only ever RELATIVE: an item's depth exists solely
  // because some shallower item stands above it. So every structural
  // operation can leave blocks it never touched with an indent that no longer
  // has an anchor — and an unanchored indent is not a display glitch, it is a
  // different document. Four columns of dangling indent after a paragraph
  // lexes as an INDENTED CODE BLOCK; one column too many under a task marker
  // makes marked swallow the sublist as literal text. The editor re-renders
  // from the file after every commit, so "looks right on screen, cannot be
  // saved" survives exactly one round trip.
  //
  //   clampIndents(blocks, opIndex, opOldIndent, opts)
  //
  //   blocks       — the commit span, in document order, as plain objects:
  //                  `{ id, type, indent }`. `type` is the block type string
  //                  ('li' or anything else); `indent` is the POST-mutation
  //                  value the caller has already written for whatever it
  //                  moved. Nothing here reads the DOM.
  //   opIndex      — index into `blocks` of the operated block, or an ARRAY of
  //                  indices for a multi-block operation (spec §3.4 rule 3).
  //   opOldIndent  — the operated block's indent BEFORE the operation (spec
  //                  §3.4's global convention). For a multi-block operation
  //                  this is the SMALLEST old indent in the set — anchoring on
  //                  the first member instead drives later members negative on
  //                  a delete and no-ops an entire batch Tab.
  //   opts.removed          — the operated block(s) no longer exist.
  //   opts.operatedBecomes  — the operated block is still there but is no
  //                           longer a list item (§3.3 conversion); the value
  //                           is its new `{ type }`.
  //
  // Returns `[{ blockId, indent }]` — one entry per block that is STILL a list
  // item, in document order. A removed or converted block has no indent to
  // report and is absent; every other block is present, including ones ahead
  // of the operation, which never move.
  function clampIndents(blocks, opIndex, opOldIndent, opts) {
    const options = opts || {};
    const src = (blocks || []).map((b) => ({
      id: b.id,
      type: b.type,
      indent: typeof b.indent === 'number' ? b.indent : 0,
    }));
    const opIdxs = (Array.isArray(opIndex) ? opIndex.slice() : [opIndex])
      .filter((i) => i >= 0 && i < src.length)
      .sort((a, b) => a - b);
    if (!opIdxs.length) return liEntries(src, () => true);

    const removed = {};
    if (options.removed) opIdxs.forEach((i) => { removed[i] = true; });
    if (options.operatedBecomes) {
      opIdxs.forEach((i) => { src[i].type = options.operatedBecomes.type || 'paragraph'; });
    }

    // A block that is gone, or is no longer a list item, cannot anchor
    // anything. `null` means "the next block down may sit at indent 0 and no
    // deeper" — the same answer as having no previous block at all.
    function anchorBefore(idx) {
      for (let k = idx - 1; k >= 0; k--) {
        if (removed[k]) continue;
        if (src[k].type !== 'li') return null;
        return src[k].indent;
      }
      return null;
    }
    const boundAt = (idx) => {
      const a = anchorBefore(idx);
      return a === null ? 0 : a + 1;
    };

    // ── Rule 1: the operated block itself ────────────────────────────────
    // Its own upper bound is the ordinary one, so a caller that optimistically
    // wrote `indent + 1` for a Tab gets it taken back when nothing above can
    // parent it. Clamped in document order so a multi-block set anchors on
    // members the loop has already settled.
    opIdxs.forEach((i) => {
      if (removed[i] || src[i].type !== 'li') return;
      src[i].indent = Math.max(0, Math.min(src[i].indent, boundAt(i)));
    });

    // ── Rule 2: the scope ────────────────────────────────────────────────
    // From the block after the LAST operated one, up to (not including) the
    // first block that is not a list item or whose indent is SMALLER than the
    // operated block's OLD indent. "Smaller", never "smaller or equal": the
    // following same-level siblings lost the same anchor the children did, and
    // leaving them out is what makes the model and the bytes drift apart.
    const scopeStart = opIdxs[opIdxs.length - 1] + 1;
    let scopeEnd = scopeStart; // exclusive
    while (scopeEnd < src.length) {
      const b = src[scopeEnd];
      if (b.type !== 'li') break;
      if (b.indent < opOldIndent) break;
      scopeEnd++;
    }

    // ── Rule 3: segments ─────────────────────────────────────────────────
    // The first segment is the operated block's whole subtree (everything
    // deeper than its old indent); each later segment is one same-level
    // sibling plus ITS whole subtree. One delta per segment, never per item:
    // clamping items independently lets the first child settle at 0 and the
    // second stay at 1, i.e. sibling #2 gets ADOPTED by sibling #1 — a
    // restructure of content the user never touched.
    const segments = [];
    let at = scopeStart;
    if (at < scopeEnd && src[at].indent > opOldIndent) {
      let end = at;
      while (end < scopeEnd && src[end].indent > opOldIndent) end++;
      segments.push([at, end]);
      at = end;
    }
    while (at < scopeEnd) {
      let end = at + 1;
      while (end < scopeEnd && src[end].indent > src[at].indent) end++;
      segments.push([at, end]);
      at = end;
    }

    segments.forEach(([from, to]) => {
      const delta = Math.max(0, src[from].indent - boundAt(from));
      if (delta === 0) return;
      for (let k = from; k < to; k++) src[k].indent = Math.max(0, src[k].indent - delta);
    });

    // ── Rule 4: per-item clamp, both bounds ──────────────────────────────
    // Runs over the scope in document order so each block is measured against
    // the already-settled block above it. The segment deltas above preserve
    // relative depth; this only ever pulls in an item that is still deeper
    // than its own parent allows.
    for (let k = scopeStart; k < scopeEnd; k++) {
      src[k].indent = Math.max(0, Math.min(src[k].indent, boundAt(k)));
    }

    return liEntries(src, (i) => !removed[i]);
  }

  function liEntries(src, keep) {
    const out = [];
    src.forEach((b, i) => {
      if (!keep(i) || b.type !== 'li') return;
      out.push({ blockId: b.id, indent: b.indent });
    });
    return out;
  }

  return { clampIndents };
});
