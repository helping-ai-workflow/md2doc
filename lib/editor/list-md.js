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
  //   closing </li> tag — an artifact of marked's own pretty-printed HTML
  //   once it round-trips through a real DOM parser (innerHTML/DOMParser).
  //   These are dropped before classifying an item's content (see
  //   isBlankText() below) — keeping them would (a) miscount a loose
  //   item's content node as 2 nodes instead of 1 (P + trailing "\n"),
  //   breaking the loose-item detection, and (b) leak a literal "\n" into
  //   the emitted line via inline-md's escapeText(), which does not treat
  //   "\n" specially, splitting one list-item line into two physical
  //   lines — a direct violation of the gate's one-line-per-item
  //   contract. Dropping them loses no real content: they carry no
  //   visible text. A stray NON-blank text node in either position (some
  //   other DOM-construction path, not marked's own output) is a
  //   different case — see "stray text" note below — and is flagged
  //   unsupported rather than silently dropped or silently kept.
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
  //      /^ *(-|\d+\.) / (indent is ancestor-marker-width accumulated, see
  //      "INDENT" note below — not a fixed multiple of 2), and no test
  //      elsewhere in this codebase tolerates a blank line inside a
  //      structural emission.
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
  // stale `start` would be actively wrong).
  //
  // INDENT (controller ruling, supersedes a fixed "2-space per depth"):
  // a nested list's indent is the ACCUMULATED WIDTH of every ancestor
  // item's own emitted marker, not a flat '  '.repeat(depth). A '- '
  // marker is 2 columns; '1. ' is 3; '10. ' is 4 — CommonMark (and
  // marked's own lexer) only keeps a sub-list attached to its parent
  // list_item when the sub-list's indent is AT LEAST the parent marker's
  // width. Verified directly against marked.lexer(): 2-space indent under
  // an OL item (marker '1. ', 3 columns) de-nests on re-parse — the
  // nested list comes back as a SEPARATE top-level list token, and two
  // sibling OL items whose nested lists both mis-indent this way collapse
  // into one merged list on re-lex. 3-space (or more) indent under that
  // same '1. ' item keeps the nested list correctly attached as a child
  // of item.tokens. See serializeListNode()'s `indentPrefix` parameter
  // below and test/list-md.test.js's round-trip cases (ol>li>ul, ol>li>ol,
  // 3-deep mixed, and the two-digit '10. '-width case).
  //
  // Nested lists are emitted as additional lines AFTER their parent
  // item's own line. No trailing whitespace on any line (each line is
  // explicitly trimmed of trailing space/tab); no leading whitespace
  // either beyond the accumulated indent — a dropped unsupported leading
  // element (e.g. a task-list checkbox <input>, which inline-md.js's
  // walkChildren() already flags via its default unhandled-element
  // branch without emitting anything for it) would otherwise leave a
  // stray double space between the marker and the item's remaining text;
  // itemMd's own leading whitespace is trimmed for exactly this reason.
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
  // given accumulated indent prefix (a literal string of spaces — the
  // sum of every ancestor item's own marker width, see header "INDENT"
  // note). Returns an array of already-trimmed, already-indented
  // physical lines. Mutates `unsupported` and `unsupportedByLi` in place
  // (same aggregation pattern as table-md.js's serializeRow).
  function serializeListNode(listEl, indentPrefix, unsupported, unsupportedByLi) {
    const ordered = listEl.nodeName === 'OL';
    const lines = [];
    let n = 1;

    allChildNodes(listEl).forEach((kid) => {
      if (kid.nodeType === 3) {
        // A stray text node directly under UL/OL (i.e. NOT inside an <li>)
        // is either marked's own insignificant "\n" pretty-print artifact
        // (dropped, see header) or genuine stray content from some other
        // DOM-construction path — the latter can't be represented as a
        // list line at all, so it is flagged rather than silently eaten.
        if (!isBlankText(kid)) unsupported.push('TEXT');
        return;
      }
      if (kid.nodeType !== 1) return; // any other exotic node type: ignore
      if (kid.nodeName !== 'LI') {
        unsupported.push(kid.nodeName);
        return;
      }

      let checkAttr = null; // non-null once a .ed-li-check span is seen
      const nestedLists = [];
      const contentNodes = [];

      // classifyLiChild: the per-child classify body, extracted so it can be
      // shared between the direct <li> children loop and the .ed-li-text
      // unwrap below — avoids duplicating isListNode/isBlankText branches.
      const classifyLiChild = (c) => {
        if (isListNode(c)) {
          nestedLists.push(c);
        } else if (isBlankText(c)) {
          // dropped: insignificant whitespace-only artifact, see header
        } else {
          contentNodes.push(c);
        }
      };

      allChildNodes(kid).forEach((c) => {
        if (c.nodeType === 1 && c.nodeName === 'SPAN' && c.getAttribute('class') === 'ed-li-check') {
          // Task 4 DOM shape: checkbox state lives on data-checked; consume
          // the span here so it never reaches inline-md as unsupported content.
          checkAttr = c.getAttribute('data-checked') === '1';
        } else if (c.nodeType === 1 && c.nodeName === 'DIV' && c.getAttribute('class') === 'ed-li-text') {
          // Task 4 DOM shape: inline content is wrapped in a .ed-li-text div.
          // Unwrap by splicing its children into the SAME contentNodes list —
          // NOT a separate variable — so the loose-item detection below
          // (contentNodes.length === 1 && P) still fires correctly for a
          // .ed-li-text that contains a single <p> (RULING F-M).
          allChildNodes(c).forEach(classifyLiChild);
        } else {
          // Pre-Task-4 bare shape (tight/loose marked output, or plain li('text')
          // fixtures) — unchanged behaviour, additive branch only.
          classifyLiChild(c);
        }
      });

      let inlineChildNodes = contentNodes;
      if (contentNodes.length === 1 && contentNodes[0].nodeType === 1 && contentNodes[0].nodeName === 'P') {
        unsupported.push('P'); // loose list item — see header decision
        inlineChildNodes = allChildNodes(contentNodes[0]);
      }

      const { md: rawItemMd, unsupported: innerUnsupported } =
        inlineMd.serializeInline({ childNodes: inlineChildNodes });

      // Per-li attribution: record inline-serializer unsupported names keyed by
      // this li's data-block-id (may be null for provisional lis that have not
      // been assigned a blockId yet).
      if (innerUnsupported.length > 0) {
        unsupportedByLi.push({
          blockId: kid.getAttribute('data-block-id'),
          names: innerUnsupported.slice(),
        });
      }
      innerUnsupported.forEach((u) => unsupported.push(u));

      // strip leading whitespace left behind by a dropped leading element
      // (e.g. a checkbox <input>) — see header note.
      const itemMd = rawItemMd.replace(/^[ \t]+/, '');

      // Two-part marker: bullet (ordered ordinal or plain '- ') and an
      // optional checkbox prefix. The two parts are independent so that
      // an ordered task list ('1. [ ] todo') gets BOTH — the brief's
      // single-expression marker silently deletes checkbox on ordered
      // task lists (RULING F-N).
      const bullet = ordered ? (n + '. ') : '- ';
      const marker = checkAttr === null ? bullet : bullet + (checkAttr ? '[x] ' : '[ ] ');
      n++;
      lines.push((indentPrefix + marker + itemMd).replace(/[ \t]+$/, ''));

      // childIndentPrefix derives from marker.length — task item '- [ ] '
      // (6 chars) gives a 6-space nested indent for free, no extra logic.
      const childIndentPrefix = indentPrefix + new Array(marker.length + 1).join(' ');
      nestedLists.forEach((nl) => {
        serializeListNode(nl, childIndentPrefix, unsupported, unsupportedByLi).forEach((l) => lines.push(l));
      });
    });

    return lines;
  }

  function serializeList(listEl) {
    const unsupported = [];
    const unsupportedByLi = [];
    const lines = serializeListNode(listEl, '', unsupported, unsupportedByLi);
    return { md: lines.join('\n'), unsupported, unsupportedByLi };
  }

  // ── S1: flat block serializer ─────────────────────────────────────
  // Additive: serializeList() above is untouched and keeps every one of its
  // callers and tests. serializeBlocks() walks a LINEAR run of
  // `.ed-block[data-block-type="li"]` elements instead of a DOM tree, which
  // is the shape Task 3's flat renderer emits (no nested <ul>/<li> at all).
  //
  // Each blockEl must carry data-block-type="li", data-list-type="ul"|"ol",
  // data-task="0"|"1", data-indent="K" and data-block-id, and contain one
  // .ed-li-text; optionally one .ed-li-check[data-checked] and one
  // .ed-li-marker (plus, from Task 4, .ed-handle / .ed-insert gutter chrome).
  //
  // INDENT: nesting depth is a data attribute now, but the emitted indent
  // must still be the ACCUMULATED WIDTH of every ancestor item's own marker
  // ('- ' 2, '1. ' 3, '10. ' 4, '- [ ] ' 6) — a flat "two spaces per level"
  // de-nests on re-parse. See the module header's INDENT ruling; `widths`
  // below is that stack, rebuilt as the run is walked.
  //
  // RUN (spec §3.8): a run breaks at a shallower li, or at a same-depth li
  // whose data-list-type differs. Deeper items never break the run they are
  // nested under. Every run's ordinal restarts at 1 — hence `counters`,
  // indexed by depth, with everything deeper than the current depth cleared
  // whenever the walk comes back up.
  //
  // Same DOM-API constraint as the rest of this module, plus
  // `classList.contains` (state classes are token-matched, never compared as
  // whole strings: at runtime .ed-li-text also carries ed-wys-armed).
  const LI_CHROME = ['ed-handle', 'ed-insert', 'ed-li-marker', 'ed-li-check', 'ed-li-text'];

  function hasClass(node, name) {
    return !!(node && node.nodeType === 1 && node.classList && node.classList.contains(name));
  }

  // blockEls may be a real NodeList (browser run scan) or a plain Array
  // (node stubs) — index it manually rather than relying on Array methods.
  function toArray(listLike) {
    const out = [];
    for (let i = 0; i < listLike.length; i++) out.push(listLike[i]);
    return out;
  }

  function firstChildWithClass(el, name) {
    const kids = allChildNodes(el);
    for (let i = 0; i < kids.length; i++) {
      if (hasClass(kids[i], name)) return kids[i];
    }
    return null;
  }

  // Deliberately NOT isBlankText(): that one requires a newline, because a
  // bare ' ' text node BETWEEN INLINE NODES inside a tight <li> is meaningful
  // spacing that serializeList must keep (test 4: '- a **bold** <br>line
  // two'). Here we are looking at the direct children of a flat .ed-block,
  // where the only text nodes are the template's own inter-element
  // whitespace — which may be a single space with no newline. Widening
  // isBlankText itself would regress serializeList, so the widening is
  // scoped to this walk instead.
  function isBlankBlockText(node) {
    return node.nodeType === 3 && /^\s*$/.test(node.textContent || '');
  }

  function serializeBlocks(blockEls) {
    const unsupported = [];
    const unsupportedByLi = [];
    const lineMeta = [];
    const lines = [];
    // widths[k] = the marker width (as a literal run of spaces) of the
    // innermost item seen at depth k; counters[k] = the running ordinal of
    // the run currently open at depth k.
    const widths = [];
    const counters = [];
    let prev = null; // { indent, listType }

    toArray(blockEls).forEach((blockEl) => {
      const blockId = blockEl.getAttribute('data-block-id');
      const indent = Number(blockEl.getAttribute('data-indent')) || 0;
      const listType = blockEl.getAttribute('data-list-type') === 'ol' ? 'ol' : 'ul';
      const isTask = blockEl.getAttribute('data-task') === '1';

      // Run bookkeeping. Going DEEPER opens a brand-new run at that depth;
      // a same-depth list-type change closes the run and opens another;
      // coming back UP leaves this depth's run open (deeper items did not
      // break it) but clears every deeper depth so the next descent
      // restarts at 1.
      if (!prev || indent > prev.indent ||
          (indent === prev.indent && listType !== prev.listType)) {
        counters[indent] = 0;
      }
      for (let k = counters.length - 1; k > indent; k--) counters[k] = 0;

      const indentPrefix = widths.slice(0, indent).join('');
      counters[indent] = (counters[indent] || 0) + 1;

      const checkEl = firstChildWithClass(blockEl, 'ed-li-check');
      const isChecked = checkEl ? checkEl.getAttribute('data-checked') === '1' : false;
      // Two-part marker: the bullet (ordered ordinal or '- ') and an
      // optional checkbox, kept independent so an ordered task list gets
      // BOTH ('1. [ ] todo') — RULING F-N, same as serializeList above.
      const bullet = listType === 'ol' ? (counters[indent] + '. ') : '- ';
      const marker = isTask ? bullet + (isChecked ? '[x] ' : '[ ] ') : bullet;

      const textEl = firstChildWithClass(blockEl, 'ed-li-text');
      const innerUnsupported = [];
      let itemMd = '';
      if (textEl) {
        const res = inlineMd.serializeInline(textEl);
        itemMd = res.md;
        res.unsupported.forEach((u) => innerUnsupported.push(u));
      }

      // Anything in the block that is neither chrome nor the text surface is
      // content we cannot represent — flag it, never swallow it.
      allChildNodes(blockEl).forEach((kid) => {
        if (kid.nodeType === 3) {
          if (!isBlankBlockText(kid)) unsupported.push('TEXT');
          return;
        }
        if (kid.nodeType !== 1) return;
        for (let i = 0; i < LI_CHROME.length; i++) {
          if (hasClass(kid, LI_CHROME[i])) return;
        }
        unsupported.push(kid.nodeName);
      });

      // Per-li attribution, keyed by the getAttribute() string block id
      // (compared against String(burst.blockId) by the caller).
      if (innerUnsupported.length > 0) {
        unsupportedByLi.push({ blockId: blockId, names: innerUnsupported.slice() });
      }
      innerUnsupported.forEach((u) => unsupported.push(u));

      widths[indent] = new Array(marker.length + 1).join(' ');
      widths.length = indent + 1;

      // Leading whitespace is stripped for the same reason as in
      // serializeListNode (a dropped leading element would leave a stray
      // double space); trailing whitespace is never emitted.
      lines.push((indentPrefix + marker + itemMd.replace(/^[ \t]+/, '')).replace(/[ \t]+$/, ''));
      lineMeta.push({ blockId: blockId, indentPrefix: indentPrefix, marker: marker });
      prev = { indent: indent, listType: listType };
    });

    return {
      md: lines.join('\n'),
      unsupported: unsupported,
      unsupportedByLi: unsupportedByLi,
      lineMeta: lineMeta,
    };
  }

  return { serializeList, serializeBlocks };
});
