'use strict';
/* UMD, same shape as convert-md.js / lineops.js: require-able in node for the
   unit tests, and injected into the editor page as `window.md2docPatchmap`
   (lib/editor/server.js). client.js is inlined as a plain <script>, not
   bundled, so a bare require() here would be undefined in the browser. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.md2docPatchmap = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // The ONLY normalisation applied before comparing two part strings.
  //
  // `data-block-id` is a POSITIONAL ordinal — blockmap.js:170 starts a shared
  // { v: 0 } box and :141/:179 do `id: nextId.v++`, so `blocks[i].id === i` is
  // an identity. Any edit that changes the BLOCK COUNT therefore rewrites the
  // id of every part after the edit point, and without this strip the suffix
  // never matches and the widen swallows the document to its end (measured:
  // keepSuffix 0 vs 14 on the same edit).
  //
  // It is the ONLY field that may be normalised away: no CSS rule anywhere
  // keys on it (grep data-block-id lib/md2doc.js hits only the two emit sites,
  // :303 and :911), so its value changing does not change how the node paints.
  // The other renderer-owned positional attributes — data-list-start,
  // data-run-start, data-indent, data-list-type — DO change the rendering when
  // their value changes, so a mismatch there must widen. Do not extend this.
  const BLOCK_ID_RE = / data-block-id="\d+"/g;
  function stripBlockId(partStr) {
    return String(partStr).replace(BLOCK_ID_RE, '');
  }

  function patchmap(input) {
    const oldBlocks = input && input.oldBlocks;
    const newBlocks = input && input.newBlocks;
    const oldParts = input && input.oldParts;
    const newParts = input && input.newParts;

    // Structural guards. `oldParts` is absent on the first render of a session
    // (the bootstrap payload carries no parts — see the plan's Task C), which
    // is a legitimate fallback, not an error.
    if (!Array.isArray(oldParts) || !Array.isArray(newParts)) return null;
    if (!Array.isArray(oldBlocks) || !Array.isArray(newBlocks)) return null;
    if (oldParts.length !== oldBlocks.length) return null;
    if (newParts.length !== newBlocks.length) return null;

    const oldN = oldParts.length;
    const newN = newParts.length;
    const o = oldParts.map(stripBlockId);
    const n = newParts.map(stripBlockId);

    let keepPrefix = 0;
    while (keepPrefix < oldN && keepPrefix < newN && o[keepPrefix] === n[keepPrefix]) keepPrefix++;

    let keepSuffix = 0;
    while (
      keepSuffix < oldN - keepPrefix &&
      keepSuffix < newN - keepPrefix &&
      o[oldN - 1 - keepSuffix] === n[newN - 1 - keepSuffix]
    ) keepSuffix++;

    // The middle is a single contiguous covering interval by construction:
    // prefix and suffix are a true prefix and a true suffix, so everything
    // between them is replaced even if some of it happened to be unchanged.
    // An insertion yields oldEnd === oldStart - 1 (a zero-width span).
    const oldStart = keepPrefix;
    const oldEnd = oldN - keepSuffix - 1;

    return {
      keepPrefix: keepPrefix,
      keepSuffix: keepSuffix,
      replaceSpan: {
        oldStart: oldStart,
        oldEnd: oldEnd,
        newParts: newParts.slice(keepPrefix, newN - keepSuffix),
      },
      // Applied by the caller to every KEPT SUFFIX node, rewriting its
      // data-block-id to oldId + idDelta. The prefix never needs it: id is the
      // index, and the prefix occupies 0..k-1 in both arrays.
      idDelta: newN - oldN,
    };
  }

  return { stripBlockId: stripBlockId, patchmap: patchmap };
});
