'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./inline-md.js'));
  } else {
    root.md2docListMd = factory(root.md2docInlineMd);
  }
})(typeof self !== 'undefined' ? self : this, function (inlineMd) {

  // list-md.js — list DOM -> minimal-form markdown (Phase-3 Task 3).
  //
  // ── Renderer finding (verified against lib/md2doc.js BEFORE writing
  //    serializeList below — required by the task brief) ─────────────────
  // lib/md2doc.js does NOT override renderer.list — only renderer.listitem,
  // and that override (~line 638) is text-collection-only (appendSectionText)
  // then delegates to marked's own baseListitem. So the actual list HTML
  // shape below is marked's stock output (verified directly against
  // marked.parse() with the same { gfm: true, breaks: false } options
  // md2doc.js sets at ~line 703):
  //
  //   TIGHT (no blank line between source items):
  //     <ul>\n<li>item two<ul>\n<li>nested a</li>\n...</ul>\n</li>\n...</ul>
  //   A nested <ul>/<ol> is a trailing CHILD of the parent <li>, placed
  //   AFTER that <li>'s own text/inline nodes — never a sibling of <li>
  //   inside the outer list, and never wrapped in another <li>.
  //
  //   LOOSE (blank line between source items):
  //     <li><p>item one</p>\n</li>
  //     <li><p>item two</p>\n<ul>\n<li>nested a</li>\n</ul>\n</li>
  //   marked wraps EACH item's own text in a <p>; a nested list (if any)
  //   still comes after that <p>, still inside the same <li>.
  //
  //   TASK LIST: <li><input disabled type="checkbox"> todo</li> — the
  //   checkbox is a plain, unhandled element as far as inline-md.js's
  //   walkChildren() is concerned, so passing it through already reports
  //   'INPUT' via that function's default unsupported-name branch — no
  //   special-case needed here.
  //
  //   Both shapes also carry INSIGNIFICANT whitespace-only text nodes
  //   (bare "\n") between a closing </p> or </ul> tag and the enclosing
  //   closing </li> tag — an
  //   artifact of marked's own pretty-printed HTML once it round-trips
  //   through a real DOM parser (innerHTML/DOMParser). These are dropped
  //   before classifying an item's content (see isBlankText() below) —
  //   keeping them would (a) miscount a loose item's content node as 2
  //   nodes instead of 1 (P + trailing "\n"), breaking the loose-item
  //   detection, and (b) leak a literal "\n" into the emitted line via
  //   inline-md's escapeText(), which does not treat "\n" specially,
  //   splitting one list-item line into two physical lines — a direct
  //   violation of the gate's one-line-per-item contract. Dropping them
  //   loses no real content: they carry no visible text.
  //
  // ── Loose-list decision (task brief requires this be documented) ──────
  // Loose (<p>-wrapped) items are reported UNSUPPORTED ('P') rather than
  // serialized faithfully as blank-line-separated markdown. Reasoning:
  //   1. Faithful round-trip needs a blank line between EVERY item at
  //      the loose list's level, while nested tight sub-lists at deeper
  //      indents must NOT get blank lines — the emission rule ("no blank
  //      lines inside the emitted block UNLESS loose-list support
  //      requires them") already flags this as the risky path.
  //   2. The gate-compat contract (see test/gate-compat.test.js's sibling
  //      table-md.js invariants, and this task's own list gate-compat
  //      cases) is line-based: every list line matches
  //      /^( {2})*(-|\d+\.) /, and no test elsewhere in this codebase
  //      tolerates a blank line inside a structural emission.
  //   3. Degrade-never-lose is the established pattern in inline-md.js
  //      (SPAN with attributes, non-single-text-node citation anchors)
  //      and table-md.js (CODE span containing '|'): when a DOM shape
  //      cannot be represented losslessly under the emission contract,
  //      flag it unsupported and let the caller fall back to raw-edit
  //      instead of emitting best-effort-but-corrupting markdown.
  // The item's own text is still serialized (best-effort, for debugging/
  // visibility) even when flagged 'P' — same as table-md.js still returns
  // `md` alongside a non-empty `unsupported` array. Callers must check
  // `unsupported.length === 0` before trusting `md`, exactly as with
  // inline-md.js / table-md.js.
  //
  // ── Emission form ───────────────────────────────────────────────────
  // UL item: '- <inline>'; OL item: '<n>. <inline>' with n renumbered
  // 1..n regardless of any source `start` attribute (a WYSIWYG editor
  // must renumber after item insert/delete/reorder, so preserving a
  // stale `start` would be actively wrong). 2 literal spaces of indent
  // per nesting depth. Nested lists are emitted as additional lines
  // AFTER their parent item's own line. No trailing whitespace on any
  // line (each line is explicitly trimmed of trailing space/tab).
  //
  // Constrained (same as inline-md.js / table-md.js, and for the same
  // reason — the node test drives this with the hand-rolled element stub
  // from test/inline-md.test.js / test/table-md.test.js) to childNodes /
  // nodeType / nodeName / textContent / getAttribute — NO
  // querySelector/querySelectorAll.

  function allChildNodes(node) {
    const out = [];
    for (let i = 0; i < node.childNodes.length; i++) out.push(node.childNodes[i]);
    return out;
  }

  // Matches ONLY the marked-pretty-print whitespace artifact (a text node
  // that is pure whitespace AND contains a newline) — never a bare space
  // (or run of spaces) with no newline, which is meaningful inline
  // spacing a real contenteditable DOM can legitimately place directly
  // between two inline nodes inside a tight <li> (no <p> wrapper). See
  // header note above: the artifact marked actually emits is always
  // exactly "\n", never a plain " ".
  function isBlankText(node) {
    return node.nodeType === 3 && /\n/.test(node.textContent) && /^\s*$/.test(node.textContent);
  }

  function isListNode(node) {
    return node.nodeType === 1 && (node.nodeName === 'UL' || node.nodeName === 'OL');
  }

  // Serializes one UL/OL node (and everything nested under it) at the
  // given indent depth. Returns an array of already-trimmed, already-
  // indented physical lines. Mutates `unsupported` in place (same
  // aggregation pattern as table-md.js's serializeRow).
  function serializeListNode(listEl, depth, unsupported) {
    const ordered = listEl.nodeName === 'OL';
    const indent = new Array(depth + 1).join('  '); // '  '.repeat(depth)
    const lines = [];
    let n = 1;

    allChildNodes(listEl).forEach((kid) => {
      if (kid.nodeType !== 1) return; // insignificant whitespace between <li>s
      if (kid.nodeName !== 'LI') {
        unsupported.push(kid.nodeName);
        return;
      }

      const nestedLists = [];
      const contentNodes = [];
      allChildNodes(kid).forEach((c) => {
        if (isListNode(c)) {
          nestedLists.push(c);
        } else if (isBlankText(c)) {
          // dropped: insignificant whitespace-only artifact, see header
        } else {
          contentNodes.push(c);
        }
      });

      let inlineChildNodes = contentNodes;
      if (contentNodes.length === 1 && contentNodes[0].nodeType === 1 && contentNodes[0].nodeName === 'P') {
        unsupported.push('P'); // loose list item — see header decision
        inlineChildNodes = allChildNodes(contentNodes[0]);
      }

      const { md: itemMd, unsupported: innerUnsupported } =
        inlineMd.serializeInline({ childNodes: inlineChildNodes });
      innerUnsupported.forEach((u) => unsupported.push(u));

      const marker = ordered ? (n + '. ') : '- ';
      n++;
      lines.push((indent + marker + itemMd).replace(/[ \t]+$/, ''));

      nestedLists.forEach((nl) => {
        serializeListNode(nl, depth + 1, unsupported).forEach((l) => lines.push(l));
      });
    });

    return lines;
  }

  function serializeList(listEl) {
    const unsupported = [];
    const lines = serializeListNode(listEl, 0, unsupported);
    return { md: lines.join('\n'), unsupported };
  }

  return { serializeList };
});
