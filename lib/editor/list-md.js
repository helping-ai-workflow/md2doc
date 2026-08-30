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

      // childIndentPrefix derives from BULLET.length, NOT marker.length. The
      // '[ ] ' checkbox is a GFM construct parsed out of the item's CONTENT,
      // not part of the CommonMark list marker, so a child's content column
      // is where the BULLET ends: a '- [ ] ' item is still a 2-column parent
      // and '1. [ ] ' a 3-column one. Measured against this repo's marked,
      // the child-indent acceptance windows are '- ' 2..5, '1. ' 3..6,
      // '10. ' 4..7, '- [ ] ' 2..5, '1. [ ] ' 3..6 — so the old
      // marker.length (6 under '- [ ] ') fell outside the window and marked
      // absorbed the child into the parent item as literal text, whose
      // remaining 4-space indent then reads as an indented CODE BLOCK. That
      // was silent data corruption on a single commit, not a formatting nit.
      // (An earlier revision of spec §3.4 said '- [ ] ' was 6 columns; it was
      // wrong and now carries an errata table. See test case 27.)
      const childIndentPrefix = indentPrefix + new Array(bullet.length + 1).join(' ');
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
  // must still be the ACCUMULATED WIDTH of every ancestor item's own BULLET
  // ('- ' 2, '1. ' 3, '10. ' 4) — a flat "two spaces per level" de-nests on
  // re-parse. See the module header's INDENT ruling; `widths` below is that
  // stack, rebuilt as the run is walked.
  //
  // The task checkbox is NOT part of that width. '[ ] ' is a GFM construct
  // parsed out of the item's CONTENT, not part of the CommonMark list
  // marker, so a child's content column is where the BULLET ends — a
  // '- [ ] ' parent is still a 2-column parent, and '1. [ ] ' a 3-column
  // one. (An earlier revision of spec §3.4 said '- [ ] ' was 6 columns; that
  // was wrong and the spec now carries an errata table. Measured against
  // this repo's own marked.lexer, the child-indent windows are: '- ' 2..5,
  // '1. ' 3..6, '10. ' 4..7, '- [ ] ' 2..5, '1. [ ] ' 3..6. Emitting 6 under
  // '- [ ] ' lands outside the window: marked absorbs the child into the
  // parent item as literal text and the nested list is DESTROYED on commit.
  // test/list-md.test.js case 23 round-trips both task shapes.)
  //
  // A BLOCK MAY OWN A CONTIGUOUS RANGE OF LINES. `lines` and `lineMeta` are
  // pushed in lockstep — one lineMeta entry per emitted line, so
  // `lineMeta.length === md.split('\n').length` always — and consecutive
  // entries may share a blockId when an item is hard-wrapped. A caller maps a
  // block to the INDEX RANGE of the entries bearing its id; assuming one line
  // per block is what let the per-li degrade path address a different item's
  // line. See the continuation-column note in the emission below.
  //
  // RUN (spec §3.8): a run breaks at a shallower li, at a same-depth li whose
  // data-list-type differs, or at a non-li block. Deeper items never break
  // the run they are nested under. Every run's ordinal restarts at 1 — hence
  // `counters`, indexed by depth, with everything deeper than the current
  // depth cleared whenever the walk comes back up.
  //
  // Rule (b) compares against the last block seen AT THAT DEPTH (`types`),
  // NOT against the immediately previous block: with a deeper item sitting
  // between two same-depth blocks, comparing against `prev` makes the
  // list-type change invisible and the ordinal never restarts. The md then
  // re-lexes as <ol start="3">, §3.8 discards `start`, and the next commit
  // renumbers to '1.' — the document oscillates between two states forever.
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

  // One source line's leading whitespace + every list marker standing on it,
  // split away from the content that follows. A same-line nest ('- 1. b')
  // carries one marker per level, so the walk repeats until it stops matching;
  // the GFM task checkbox is stepped over as part of its own marker because
  // physically it stands between that marker and the next one.
  //
  // `prefix` is what §3.4's colDelta measures the OLD side against, so it comes
  // back as literal text rather than a count — a caller that finds a TAB in it
  // knows the column arithmetic is not exact and can decline.
  const SRC_MARKER_RE = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])([ \t]+)(?:\[[ xX]\][ \t]+)?/;
  function splitSourceMarkers(line) {
    const text = typeof line === 'string' ? line : '';
    let at = 0;
    for (;;) {
      const m = SRC_MARKER_RE.exec(text.slice(at));
      if (!m) break;
      at += m[0].length;
    }
    return { prefix: text.slice(0, at), content: text.slice(at) };
  }

  function spaces(n) {
    return n > 0 ? new Array(n + 1).join(' ') : '';
  }

  // ── The setext-underline hazard on an EMPTY bulleted item ───────────────
  // An empty item is emitted as a BARE marker ('-', no trailing space): '- '
  // lexes as a PARAGRAPH, which is why lib/editor/client.js's
  // BLOCK_SKELETONS.list is a bare marker too, and that reasoning is not being
  // undone here. But CommonMark gives that same bare '-' a SECOND reading, and
  // which one wins is decided by the line ABOVE it: an EMPTY list item may not
  // interrupt a paragraph, and a line consisting of nothing but '-' standing
  // at an open paragraph's own content column is a SETEXT H2 UNDERLINE.
  //
  // That is exactly the line an indent produces. `- beta` + Enter + Tab wrote
  //
  //     - alpha
  //     - beta
  //       -
  //
  // and marked (14.1.4) reads it back as `<li><h2>beta</h2></li>`: the new
  // item is gone and the parent's text has been re-typed as a heading. Two
  // ordinary keystrokes, silent content destruction, measured on 2.11.0.
  //
  // The hazard is POSITIONAL, not a property of the marker. It exists only
  // where the previously emitted line is a paragraph at this line's own
  // column, which inside a run means precisely "this item is the FIRST item of
  // a deeper nesting" (`prev.indent < indent`) — the parent's own text (or its
  // lazy continuation) is then the line immediately above, and a child's
  // marker column IS the parent's content column by construction. An empty
  // item that follows a SAME-level sibling is safe (the line above is a marker
  // line, so '-' can only be another marker there), and so is one whose
  // predecessor is deeper.
  //
  // Every other shape is left byte-identical:
  //   * ordered — '1.' is not a run of dashes, so it is not a setext underline;
  //   * task    — a content-free task item never emits a marker line at all
  //               (it becomes `pending`, a same-line prefix), which is what the
  //               `head === indentPrefix + marker` test below detects;
  //   * non-empty items, and every empty item at top level.
  //
  // The escape is a U+200B ZERO WIDTH SPACE: real, non-whitespace content to
  // the block lexer (so the line is a list item, not an underline) and nothing
  // at all to a reader. It is the same trade-off client.js already documents
  // for BLOCK_SKELETONS.paragraph. It never becomes part of the user's text:
  // lib/md2doc.js's edit-mode list renderer renders a U+200B-only item as an
  // EMPTY surface, so the next keystroke lands in an empty item, and the
  // itemMd normalisation above takes the character back off on the way out.
  const SETEXT_ESCAPE = '\u200b';
  const SETEXT_ESCAPE_RE = /^\u200b+$/;
  function escapeSetextHazard(firstOwnLine, ctx) {
    if (firstOwnLine !== '') return firstOwnLine;
    if (ctx.listType !== 'ul' || ctx.isTask) return firstOwnLine;
    // A `pending` task prefix has already been joined onto `head`, so the line
    // is not a bare run of dashes and needs nothing.
    if (ctx.head !== ctx.indentPrefix + ctx.marker) return firstOwnLine;
    if (!ctx.prev || ctx.indent <= ctx.prev.indent) return firstOwnLine;
    return SETEXT_ESCAPE;
  }

  // `opts.carryOver` (spec §3.4, 多行 li 的旁觀者規則): a map of block id →
  // that block's ORIGINAL source lines. A hard-wrapped item named there is NOT
  // re-serialized; its own bytes are replayed with the column difference of its
  // new marker applied to every line it owns.
  //
  // This is not a fidelity nicety, it is the difference between Tab working on
  // a real document and not working at all. Structural refusal is run-wide
  // (RULING F-R) and MULTILINE feeds it, so before this a single hard-wrapped
  // item anywhere in a run refused the whole run — and 80.6% of this repo's own
  // CHANGELOG.md list items are hard-wrapped. Dropping MULTILINE from the gate
  // is not the fix on its own either: the round trip through the inline
  // serializer is LOSSY for a bystander (measured on CHANGELOG.md at v2.10.2 —
  // '~5px' comes back as '\~5px', because escapeText() escapes a tilde marked
  // never treated as markup). Replaying the source is what keeps an untouched
  // item byte-identical, which is in turn what stops the commit's line-range
  // replace from rewriting lines the user never looked at.
  function serializeBlocks(blockEls, opts) {
    const carryOver = (opts && opts.carryOver) || null;
    const unsupported = [];
    const unsupportedByLi = [];
    const multiLineBlockIds = [];
    const lineMeta = [];
    const lines = [];
    // widths[k] = the marker width (as a literal run of spaces) of the
    // innermost item seen at depth k; counters[k] = the running ordinal of
    // the run currently open at depth k.
    const widths = [];
    const counters = [];
    // types[k] = the list type of the last block seen at depth k, so rule (b)
    // survives a deeper item sitting between two same-depth blocks.
    const types = [];
    let prev = null; // { indent, listType }

    // ── Round 6: a CONTENT-FREE TASK item cannot be given a line of its own ──
    // marked only reads '[ ]' / '[x]' as a checkbox when content follows ON THE
    // SAME LINE: '- [ ]\n  - b' lexes as '<li>[ ]<ul>…' — the checkbox becomes
    // literal text and its state stops being machine-readable. Same-line
    // nesting ('- [ ] - b') is exactly that shape: the outer item's own content
    // is empty because its child starts on its line.
    //
    // So such an item does not emit a line; it becomes a PREFIX carried onto
    // the next emitted line, which restores the source's own same-line form.
    // The columns it contributes to that line's indent prefix — its BULLET's
    // width, checkbox excluded, the same rule `widths` uses — are already
    // written by the prefix, so they come off the front of the line it joins.
    //
    // A PLAIN content-free item keeps its own line: '-\n  - b' and '- - b' are
    // the same tree to marked, and the canonical form is preferable because it
    // gives the item a source line of its own (blockmap can then hand it a
    // well-formed range). Only the checkbox forces the same-line form.
    //
    // The prefix is FLUSHED as its own line — degrading to literal '[ ]', which
    // is what the source said anyway — whenever the next block is not deeper,
    // i.e. when the item has no child to attach to. Merging it onto a SIBLING
    // would invent nesting that the document never had.
    let pending = null; // { text, cols, indent, blockId, indentPrefix, marker }

    function flushPending() {
      if (!pending) return;
      lines.push(pending.text.replace(/[ \t]+$/, ''));
      lineMeta.push({ blockId: pending.blockId, indentPrefix: pending.indentPrefix,
        marker: pending.marker });
      pending = null;
    }

    // Drops up to `n` leading SPACE columns — the ones `pending` has already
    // physically written on this line.
    function stripCols(line, n) {
      let k = 0;
      while (k < n && line.charAt(k) === ' ') k++;
      return line.slice(k);
    }

    toArray(blockEls).forEach((blockEl) => {
      const blockId = blockEl.getAttribute('data-block-id');

      // §3.8 rule (c): a non-li block terminates a run. It has no marker and
      // no .ed-li-text contract, so emitting a '- <text>' line for it would
      // silently invent list structure. Flag it, never swallow it — the same
      // principle the alien-child branch below follows. Names are uppercased
      // to match the element-name convention the rest of `unsupported` uses.
      const blockType = blockEl.getAttribute('data-block-type');
      if (blockType !== 'li') {
        unsupported.push(String(blockType || 'UNKNOWN').toUpperCase());
        // A non-li block ends the run (§3.8 rule c), so a task prefix still
        // open cannot have a child after it — put it back on its own line
        // rather than letting it reach across the break.
        flushPending();
        return;
      }

      const indent = Number(blockEl.getAttribute('data-indent')) || 0;
      // Only a DEEPER block is the pending item's child; anything else means it
      // had none, so its marker goes back onto a line of its own.
      if (pending && indent <= pending.indent) flushPending();
      const listType = blockEl.getAttribute('data-list-type') === 'ol' ? 'ol' : 'ul';
      const isTask = blockEl.getAttribute('data-task') === '1';
      // §3.8 rule (d): this block is the first item of its own list TOKEN.
      const isListStart = blockEl.getAttribute('data-list-start') === '1';

      // Run bookkeeping. Going DEEPER opens a brand-new run at that depth
      // (even when the type matches); a list-type change against the last
      // block AT THIS DEPTH closes that run and opens another; coming back
      // UP leaves this depth's run open (deeper items did not break it) but
      // clears every deeper depth so the next descent restarts at 1.
      //
      // Rule (d) is the fourth reset, and rules (a)-(c) cannot derive it:
      // '  1. x' followed by '  1) y' is TWO nested list tokens (a delimiter
      // change starts a new list) at the SAME depth with the SAME type, so
      // without this the second list is renumbered as a continuation of the
      // first ('2. y') and a commit rewrites a list the user never touched.
      // lib/md2doc.js stamps the attribute; only the renderer still knows
      // where marked's token boundaries were.
      if (isListStart || !prev || indent > prev.indent || types[indent] !== listType) {
        counters[indent] = 0;
      }
      for (let k = counters.length - 1; k > indent; k--) {
        counters[k] = 0;
        types[k] = undefined;
      }
      types[indent] = listType;

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
        // The surface's own children are filtered through isBlankText() —
        // NOT isBlankBlockText() — before they reach the inline serializer,
        // exactly as serializeListNode() above does for a tree <li>. A LOOSE
        // item's surface is `\n<p>text</p>\n` (marked pretty-prints block-level
        // output), and inline-md.js has no reason to treat a text node's "\n"
        // specially: escapeText() emits it verbatim, so ONE list item turned
        // into THREE physical lines — a direct violation of the gate's
        // one-line-per-item contract, and worse, it desynchronised `lineMeta`
        // from `md.split('\n')` so a caller committing a single item's line by
        // index wrote a DIFFERENT item's line into it (observed: editing the
        // item after a loose blank replaced its source line with '  - ').
        // isBlankText() is the right predicate here and isBlankBlockText() is
        // not: the artifact marked emits always contains a newline, while a
        // bare ' ' BETWEEN INLINE NODES is meaningful spacing the item must
        // keep. (isBlankBlockText() stays as-is for the block's own direct
        // children, where the template's inter-element whitespace can legally
        // be a single space with no newline.)
        const inlineKids = [];
        allChildNodes(textEl).forEach((c) => { if (!isBlankText(c)) inlineKids.push(c); });
        const res = inlineMd.serializeInline({ childNodes: inlineKids });
        itemMd = res.md;
        res.unsupported.forEach((u) => innerUnsupported.push(u));
        // The other half of the SETEXT ESCAPE applied at the emission site
        // below: a U+200B is this serializer's own way of saying "empty item
        // in a position where a bare marker would re-lex as a heading
        // underline", so this serializer is also the one that takes it back
        // off. Without it, an escaped item that later moves somewhere the
        // escape is not needed (Shift+Tab back to the top level) would keep a
        // zero-width character it never asked for, and the item would stop
        // reading as empty to every `itemMd === ''` test in this function.
        if (SETEXT_ESCAPE_RE.test(itemMd)) itemMd = '';
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

      // A block may own a contiguous RANGE of lines — and if it does, that is
      // reported for STRUCTURAL operations only.
      //
      // A hard-wrapped ("lazy continuation") item is ordinary markdown: 22.4%
      // of this repo's own 799 list items are one, every CHANGELOG bullet
      // included. Its .ed-li-text holds a literal '\n', which inline-md.js's
      // escapeText() emits verbatim. An earlier revision made such an item
      // UNSUPPORTED outright and truncated it to one line, which kept `lines`
      // and `lineMeta` parallel but turned a fifth of every real document
      // read-only. Spec §4.1 asks for less than that: a multi-line li refuses
      // structural operations as an operation TARGET, and 文字編輯不受影響.
      //
      // So MULTILINE goes to `unsupported` — which is what
      // listRunSupportsStructuralEdit() gates on, and what forces the per-li
      // partial commit path so no other item is re-emitted — and NOT to
      // `unsupportedByLi`, which is the channel canWysiwygForLi() and
      // resolveBurst()'s F-W text-edit refusal read. Same split the tree
      // serializer has always used for loose 'P'. Callers that must ignore it
      // for arming filter on STRUCTURAL_ONLY_UNSUPPORTED rather than
      // hard-coding the name.
      // `multiLineBlockIds` is the same fact with an OWNER attached. The flat
      // `unsupported` array has no attribution, so a caller reading it can only
      // ask "does this run contain a hard-wrapped item", which is exactly the
      // question that made Tab useless on real documents. Spec §4.1 asks a
      // narrower one — "is the block I am about to operate ON hard-wrapped" —
      // and that needs the id.
      // T7 — WHAT THIS FLAG IS AND IS NOT. It answers "does this item's
      // SURFACE TEXT hold a newline", which catches a LAZY continuation and
      // nothing else. It is NOT the answer to "does this block own more than
      // one source line", and the difference is not academic: a markdown HARD
      // BREAK is two trailing SPACES, which marked renders as <br>, so such an
      // item's surface holds no '\n' at all and this flag calls it
      // single-line. Measured: Enter on one used to be accepted and collapsed
      // its two source lines into ONE bearing the literal text '<br>'
      // ('- a  \n  b ~t' -> '- a<br>b \~t'), and as a BYSTANDER of somebody
      // else's Tab it was rewritten the same way.
      //
      // Neither of those is fixable HERE, because this module sees a DOM and
      // the answer lives in the file. Widening the test to '<br>' was tried
      // and is wrong in the other direction: inline-md.js emits '<br>' for a
      // real hard break, for a literal '<br>' the source spelled out by hand,
      // AND for the placeholder <br> Chromium leaves behind when the user
      // deletes an item's last character — so it made an EMPTIED item
      // structurally frozen (Enter could no longer remove it).
      // lib/editor/client.js owns both decisions instead, off `blocks`:
      // listRunSupportsStructuralEdit() refuses a target whose range spans
      // several lines, and bystanderCarryOver() replays every untouched
      // block's own bytes. This flag stays as the narrow thing it always was.
      const isMultiLine = /\n/.test(itemMd);
      if (isMultiLine) {
        unsupported.push('MULTILINE');
        multiLineBlockIds.push(blockId);
      }

      // Per-li attribution, keyed by the getAttribute() string block id
      // (compared against String(burst.blockId) by the caller).
      if (innerUnsupported.length > 0) {
        unsupportedByLi.push({ blockId: blockId, names: innerUnsupported.slice() });
      }
      innerUnsupported.forEach((u) => unsupported.push(u));

      // BULLET, not `marker`: the '[ ] ' checkbox is content, not marker
      // width — see the INDENT note above. Using marker.length here puts a
      // task item's child outside marked's acceptance window and destroys it.
      widths[indent] = new Array(bullet.length + 1).join(' ');
      widths.length = indent + 1;

      // Emission. Leading whitespace on the item's own first line is stripped
      // for the same reason as in serializeListNode (a dropped leading element
      // would leave a stray double space); trailing whitespace is never
      // emitted, on any line.
      //
      // CONTINUATION COLUMN: every line after the first is re-indented to the
      // item's CONTENT column — `indentPrefix + bullet width` — which is the
      // same accumulated-width rule §3.4's errata pinned for a CHILD LIST's
      // indent, and for the same reason: that column is where marked resumes
      // the item's own paragraph. The checkbox is excluded from it ('- [ ] ' is
      // a 2-column parent), exactly as `widths` above computes. One column too
      // few and the continuation lexes as a sibling or a lazy line of the wrong
      // item; four too many and it lexes as an INDENTED CODE BLOCK. The line's
      // own leading whitespace is dropped first so the column is ours to state,
      // not the DOM's to leak. test/list-md.test.js case 31(d) round-trips this
      // through marked.lexer.
      //
      // lineMeta gets ONE ENTRY PER EMITTED LINE, each naming the block that
      // owns it, so consecutive entries may share a blockId. The invariant is
      // `lineMeta.length === md.split('\n').length`; violating it is precisely
      // what let a caller's line index address a DIFFERENT item's line.
      const ownLines = itemMd.replace(/^[ \t]+/, '').split('\n');
      const contPrefix = indentPrefix + new Array(bullet.length + 1).join(' ');
      // Round 6: join an open task prefix (above) to this line, dropping the
      // columns it already wrote; then, if THIS item is itself a content-free
      // task item, become the prefix instead of emitting.
      let head = indentPrefix + marker;
      // `indentPrefix` in lineMeta is the text PHYSICALLY standing before this
      // line's own marker. Normally that is the accumulated width; on a line a
      // task prefix has joined, it is that prefix — which is what a caller
      // replaying the line (client.js's per-li commit) and §3.4's colDelta both
      // need, and why this does not want a separate field.
      let metaPrefix = indentPrefix;
      if (pending) {
        head = pending.text + stripCols(indentPrefix + marker, pending.cols);
        metaPrefix = head.slice(0, head.length - marker.length);
        pending = null;
      }
      if (isTask && ownLines.length === 1 && ownLines[0] === '') {
        pending = { text: head, cols: indentPrefix.length + bullet.length, indent: indent,
          blockId: blockId, indentPrefix: metaPrefix, marker: marker };
        prev = { indent: indent, listType: listType };
        return;
      }
      // ── §3.4 bystander replay ────────────────────────────────────────────
      // The caller named this block's own source lines, so they are emitted
      // instead of the round trip. Only the marker is re-stated (it has to be:
      // an ordinal or an ancestor's width may have moved), and the resulting
      // COLUMN difference is applied to every continuation line — applying it
      // to the marker line alone is what turns a continuation into an indented
      // code block.
      //
      // Declined, falling through to the ordinary path, when the arithmetic
      // would be a guess rather than a measurement: no marker on the first
      // source line (nothing to measure the old prefix against), or a TAB in
      // that prefix (its column count depends on a tab stop this module does
      // not get to choose).
      //
      // Which blocks are named is entirely the CALLER's decision, and it is
      // not the same question as `multiLineBlockIds` above: client.js keys the
      // map on each block's own SOURCE LINE RANGE, which is the only place the
      // truth lives (this module sees a DOM, not a file), and names every
      // block it did not itself mutate — not just the multi-line ones. A
      // single-line bystander needs the replay too: escapeText() escapes a
      // tilde marked never treats as markup, so '~5px' came back '\~5px' in an
      // item the gesture never touched.
      const carried = carryOver && blockId !== null && carryOver[blockId];
      const carriedSplit = carried && carried.length ? splitSourceMarkers(carried[0]) : null;
      const carriedOk = !!carriedSplit && carriedSplit.prefix !== '' &&
        carriedSplit.prefix.indexOf('\t') === -1;
      if (carriedOk) {
        // No trailing-whitespace trim on a replayed line, unlike the
        // re-serialized path below: these bytes are the file's own, and a
        // markdown hard break IS two trailing spaces. Trimming would edit an
        // item the operation was explicitly told not to touch.
        lines.push(head + carriedSplit.content);
        lineMeta.push({ blockId: blockId, indentPrefix: metaPrefix, marker: marker });
        const colDelta = head.length - carriedSplit.prefix.length;
        for (let k = 1; k < carried.length; k++) {
          const raw = typeof carried[k] === 'string' ? carried[k] : '';
          // colDelta 0 is the overwhelmingly common case (nothing about this
          // item's marker moved), and it is emitted BYTE-FOR-BYTE — including
          // any tab indentation, which §3.11(4) says only a re-serialized line
          // may normalise.
          if (colDelta === 0) {
            lines.push(raw);
            lineMeta.push({ blockId: blockId, indentPrefix: /^[ \t]*/.exec(raw)[0], marker: '' });
            continue;
          }
          const lead = /^[ \t]*/.exec(raw)[0];
          const body = raw.slice(lead.length);
          const prefix = body === '' ? '' : spaces(Math.max(0, lead.length + colDelta));
          lines.push(prefix + body);
          lineMeta.push({ blockId: blockId, indentPrefix: prefix, marker: '' });
        }
        prev = { indent: indent, listType: listType };
        return;
      }
      lines.push((head + escapeSetextHazard(ownLines[0], {
        head: head, indentPrefix: indentPrefix, marker: marker,
        listType: listType, isTask: isTask, indent: indent, prev: prev,
      })).replace(/[ \t]+$/, ''));
      lineMeta.push({ blockId: blockId, indentPrefix: metaPrefix, marker: marker });
      for (let k = 1; k < ownLines.length; k++) {
        const body = ownLines[k].replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
        // A blank continuation would emit a blank line, which re-lexes the
        // whole list as LOOSE and changes every item's rendering. Content that
        // genuinely contains a blank line arrives as separate <p> elements
        // instead (the 'P' path), so dropping an empty segment here loses
        // nothing; both `lines` and `lineMeta` skip it together, so they stay
        // parallel.
        if (body === '') continue;
        lines.push(contPrefix + body);
        lineMeta.push({ blockId: blockId, indentPrefix: contPrefix, marker: '' });
      }
      prev = { indent: indent, listType: listType };
    });
    // A task prefix still open at the end of the run had no child at all.
    flushPending();

    return {
      md: lines.join('\n'),
      unsupported: unsupported,
      unsupportedByLi: unsupportedByLi,
      multiLineBlockIds: multiLineBlockIds,
      lineMeta: lineMeta,
    };
  }

  // Names that appear in `unsupported` to gate STRUCTURAL operations but that
  // must NOT stop a block being armed for text editing. Exported so the client
  // and the serializer cannot drift apart on the distinction.
  const STRUCTURAL_ONLY_UNSUPPORTED = ['MULTILINE'];

  return { serializeList, serializeBlocks, STRUCTURAL_ONLY_UNSUPPORTED };
});
