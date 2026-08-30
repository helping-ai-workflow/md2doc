'use strict';
/* Spec §3.3 / §3.6 / §4.4 — block 多選的純模型.
   UMD, same shape as indent-clamp.js: `require`-able in node for the unit
   tests, and injected into the editor page as `window.md2docSelection`. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.md2docSelection = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // A selection's identity is a LINE RANGE — never block ids, never DOM nodes.
  // buildBlockMap() renumbers every id from 0 on every render (blockmap.js:170)
  // and every batch operation triggers a full rerenderAll(), so an id or an
  // element held across a commit is a dangling reference into a document that
  // no longer exists. Every post-commit recovery path already in client.js
  // (blockElAtLine, reresolveBlockEl, focusBlockAtLine) goes through startLine
  // for exactly this reason. Nothing in this file reads the DOM, and nothing
  // outside it may hand this file an id.
  //
  //   a selection   — { anchorLine, focusLine }, or null for "nothing selected"
  //   a block       — a record from buildBlockMap(): { id, type, startLine,
  //                   endLine, ... }. Read here for startLine/endLine only;
  //                   `id` is passed through untouched for the caller's own use.
  //   `blocks`      — the whole live block list, in document order.

  // ── the no-line exclusion ────────────────────────────────────────────
  // buildBlockMap emits a block for the OUTER item of a same-line nest
  // ("- - a" -> outer {startLine:3, endLine:2}, inner {startLine:3,
  // endLine:3}), and its range is INVERTED because it owns no source line of
  // its own. Such a block has no line for a range to touch, so it can never be
  // a member of a line-range selection. This is the same predicate as
  // blockOwnsNoLine() in client.js:928, which is the guard every structural
  // path in the editor already checks before it writes bytes.
  function ownsALine(b) {
    return !!b && typeof b.startLine === 'number' && typeof b.endLine === 'number'
      && b.endLine >= b.startLine;
  }

  function lineOf(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // ── normalize ────────────────────────────────────────────────────────
  // Orders anchor/focus into the {startLine, endLine} shape the block records
  // and the UndoStack op shape already use, so the two never have to be
  // mentally converted at a call site. Returns null rather than a NaN range
  // for "no selection" — a NaN range compares false against everything and
  // would silently produce an empty member set that looks like a real answer.
  function normalize(sel) {
    if (!sel) return null;
    const a = lineOf(sel.anchorLine);
    const f = lineOf(sel.focusLine);
    if (a === null || f === null) return null;
    return { startLine: Math.min(a, f), endLine: Math.max(a, f) };
  }

  // ── membership ───────────────────────────────────────────────────────
  // Membership is INTERSECTION, not containment: a multi-line block touched
  // anywhere is wholly selected. Block selection has no partial state (§3.6 —
  // the visual is a tint over whole blocks), so a code fence whose middle line
  // is in range is in the set exactly as much as a one-line paragraph is.
  // Returns block RECORDS in document order, never ids and never elements.
  function membersOf(sel, blocks) {
    const r = normalize(sel);
    if (!r) return [];
    return (blocks || []).filter(
      (b) => ownsALine(b) && b.startLine <= r.endLine && b.endLine >= r.startLine);
  }

  function isSelected(sel, block) {
    const r = normalize(sel);
    if (!r || !ownsALine(block)) return false;
    return block.startLine <= r.endLine && block.endLine >= r.startLine;
  }

  // ── extendTo ─────────────────────────────────────────────────────────
  // Shift+Click and a drag both move the FOCUS and keep the anchor where the
  // gesture started; that is what makes a selection reversible by dragging
  // back. With no prior selection there is no anchor to keep, so the gesture
  // starts one collapsed at that line.
  function extendTo(sel, line) {
    const l = lineOf(line);
    if (l === null) return sel || null;
    const a = sel ? lineOf(sel.anchorLine) : null;
    return { anchorLine: a === null ? l : a, focusLine: l };
  }

  // ── stepFocus ────────────────────────────────────────────────────────
  // §4.4's Shift+↑↓. Moves by BLOCK, not by line: blocks do not tile the
  // document (blank separator lines belong to nothing), so a per-line step
  // would park the focus on a line that owns no block and collapse the set to
  // nothing on the way past. Blocks that own no source line are skipped for
  // the same reason membersOf() excludes them — landing on one would leave a
  // selection whose member set is empty.
  //
  // Clamped at both ends: stepping past either end is a no-op, never an error
  // and never a wrap. `dir` is any negative number for up, anything else down.
  function stepFocus(sel, blocks, dir) {
    if (!sel) return sel || null;
    const nav = (blocks || []).filter(ownsALine);
    if (!nav.length) return sel;
    const focus = lineOf(sel.focusLine);
    if (focus === null) return sel;
    const step = dir < 0 ? -1 : 1;

    // The focus normally sits exactly on a block's startLine, because that is
    // what this function and the gesture handlers write. If it does not (a
    // caller resolved a raw click y-coordinate, say), take the nearest block
    // at or after it, and the last block when the line is past the end.
    let i = nav.findIndex((b) => b.startLine === focus);
    if (i === -1) i = nav.findIndex((b) => b.startLine > focus);
    if (i === -1) i = nav.length - 1;

    const j = Math.max(0, Math.min(nav.length - 1, i + step));
    return { anchorLine: sel.anchorLine, focusLine: nav[j].startLine };
  }

  // ── §3.3's membership rule ───────────────────────────────────────────
  // "grip 在選取集合內 → 作用整個集合；grip 在集合外 → 先把集合換成該單一
  // block 再作用." One helper so every operation asks the question the same
  // way instead of each menu handler re-deriving it.
  //
  // `opBlock` MUST be a record out of `blocks` — identity is by reference, not
  // by id (this module never touches ids) and not by line tuple (a nest three
  // deep like "- - - a" produces two structurally identical phantoms, so a
  // tuple compare is genuinely ambiguous). A record from anywhere else answers
  // 'single', which is the conservative direction: it operates on one block
  // rather than silently on N.
  //
  // A selection of exactly the grip block is 'batch' with one member, not a
  // fallthrough to 'single'. The two answers are byte-identical for a single
  // block today, but a caller that special-cased size 1 would drift the moment
  // batch and single paths diverge.
  function resolveMembership(sel, blocks, opBlock) {
    const members = membersOf(sel, blocks);
    if (opBlock && members.indexOf(opBlock) !== -1) return { mode: 'batch', members };
    return { mode: 'single', members: opBlock ? [opBlock] : [] };
  }

  // ── collapseTo ───────────────────────────────────────────────────────
  // §3.3: "操作後集合塌縮為「操作結果所涵蓋的行區間」". Every structural
  // operation declares the line range it produced; rerenderAll() re-derives
  // the member set from that range against the freshly built block list. §4.4:
  // if the range does not resolve, the selection is CLEARED rather than left
  // dangling — an operation that removed everything it touched declares an
  // empty (inverted) range, and that is not a selection of one line.
  function collapseTo(range) {
    if (!range) return null;
    const s = lineOf(range.startLine);
    const e = lineOf(range.endLine);
    if (s === null || e === null || e < s) return null;
    return { anchorLine: s, focusLine: e };
  }

  // ── spanIsContiguous ─────────────────────────────────────────────────
  // Batch convert/delete/duplicate rewrite their single-item entry points to
  // take ONE contiguous index range — a loop would re-render between items and
  // invalidate every id in between, which is the defect class recorded at
  // client.js:3298 and :4806. This is the gate that says a set can be
  // expressed that way.
  //
  // Indices are taken over the WHOLE `blocks` list, phantoms included. A
  // no-line phantom sitting between two members ('- a\n- - b\n- c\n' ->
  // li{1,1} | phantom{2,1} | li{2,2} | li{3,3}) is never a member, but it IS
  // in the DOM run a batch operation would slice, and every structural path
  // already refuses a phantom (blockOwnsNoLine). Reporting false there hands
  // the caller a refusal instead of a range it cannot honour.
  function spanIsContiguous(members, blocks) {
    const list = members || [];
    if (list.length <= 1) {
      // 0 members has no gap to find; the caller checks emptiness itself,
      // because "nothing selected" and "a set with a hole in it" deserve
      // different messages.
      return list.every((m) => (blocks || []).indexOf(m) !== -1);
    }
    const idx = list.map((m) => (blocks || []).indexOf(m));
    if (idx.some((i) => i < 0)) return false;
    idx.sort((a, b) => a - b);
    for (let k = 1; k < idx.length; k++) if (idx[k] !== idx[k - 1] + 1) return false;
    return true;
  }

  return {
    normalize,
    membersOf,
    isSelected,
    extendTo,
    stepFocus,
    resolveMembership,
    collapseTo,
    spanIsContiguous,
  };
});
