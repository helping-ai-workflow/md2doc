'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.md2docInlineMd = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // Escaping rules (verbatim from task-2 brief, plus review fix 2026-08-25,
  // plus the strikethrough/underline fix below):
  //  - backslash / backtick / asterisk / brackets escaped always
  //  - underscore escaped ONLY at a word boundary (snake_case stays clean)
  //  - literal `<` becomes `&lt;` (HTML-safe, keeps <br> etc. unambiguous)
  //  - tilde escaped UNCONDITIONALLY (every `~`, not just doubled runs) —
  //    since DEL/S now round-trips through GFM `~~...~~` (see walkChildren
  //    below), a literal `~~` typed by the user (no strikethrough intent at
  //    all) would otherwise silently turn into real strikethrough the next
  //    time the source is re-rendered. Escaping every single `~` is the
  //    simplest deterministic rule that can't under-escape a run of any
  //    length; marked un-escapes `\~` back to a literal `~` on parse either
  //    way, so this is lossless for genuinely single tildes too.
  // `]` mirrors `[` (CRITICAL 2 fix): escaping only `[` leaves an unbalanced
  // literal `]` that breaks bracket pairing in the enclosing link/citation
  // syntax — e.g. an <a> whose label is itself "[text]" would otherwise
  // parse as a stray "[[text]](<a...>...)" instead of one working link.
  function isWordChar(ch) {
    return ch !== undefined && /\w/.test(ch);
  }

  function escapeText(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') { out += '\\\\'; continue; }
      if (c === '`') { out += '\\`'; continue; }
      if (c === '*') { out += '\\*'; continue; }
      if (c === '[') { out += '\\['; continue; }
      if (c === ']') { out += '\\]'; continue; }
      if (c === '<') { out += '&lt;'; continue; }
      if (c === '~') { out += '\\~'; continue; }
      if (c === '_') {
        const prev = s[i - 1];
        const next = s[i + 1];
        out += (isWordChar(prev) && isWordChar(next)) ? '_' : '\\_';
        continue;
      }
      out += c;
    }
    return out;
  }

  // Real contenteditable output wraps plain runs in attribute-less <span>s
  // (Chrome/Firefox formatting artifacts). Those are transparent. A <span>
  // carrying any of these attributes is a real style/class/behavior carrier
  // we don't support yet, so it is reported via `unsupported` instead of
  // unwrapped. Widened (review fix 2026-08-25, IMPORTANT 4) past style/class
  // to the realistic contenteditable/extension attribute set: browsers and
  // editing extensions (spellcheck UI, Grammarly, TinyMCE-style paste) stamp
  // these onto spans that carry real, non-plain-text intent.
  const SPAN_ATTR_PROBE = [
    'style', 'class', 'id', 'data-mce-style', 'data-mce-bogus',
    'dir', 'contenteditable', 'spellcheck', 'lang', 'title',
    'data-gramm', 'data-gramm_editor', 'data-enable-grammarly',
  ];

  function spanHasAttributes(node) {
    for (let i = 0; i < SPAN_ATTR_PROBE.length; i++) {
      const v = node.getAttribute(SPAN_ATTR_PROBE[i]);
      // Deliberate: an attribute present but set to '' (e.g. class="") is
      // treated the same as absent — it carries no actual style/behavior
      // intent, so it shouldn't disqualify the span from being transparent.
      if (v !== null && v !== undefined && v !== '') return true;
    }
    return false;
  }

  // CommonMark code-span fence: the fence must be longer than the longest
  // run of consecutive backticks inside the content, or the fence closes
  // early on that run (CRITICAL 1 fix, verified against marked.parseInline:
  // a fixed 2-backtick fence corrupts content containing "``"). Padding is
  // *required* whenever the content touches the fence boundary with a
  // backtick (verified: unpadded "```x``" fails to parse as code at all);
  // for interior-only backtick runs padding is optional but harmless
  // (verified round-trip-identical either way), so we always pad once a
  // fence is needed — simpler, and preserves the original single-backtick
  // test's exact padded form.
  function serializeCode(node) {
    const raw = node.textContent;
    const runs = raw.match(/`+/g);
    const longestRun = runs ? Math.max.apply(null, runs.map((r) => r.length)) : 0;
    if (longestRun === 0) return '`' + raw + '`';
    const fence = new Array(longestRun + 2).join('`');
    return fence + ' ' + raw + ' ' + fence;
  }

  // IMPORTANT 3 (degrade-never-lose): the citation form only round-trips
  // through md2doc's own citation regex ([^\]\n]+) when the anchor's body
  // is a single plain-text run with no embedded `]`. Nested formatting
  // (childNodes isn't exactly one text node) or a body containing `]`
  // between the outer brackets would either silently flatten real content
  // or emit citation syntax md2doc can't re-parse — so those degrade to
  // unsupported instead of emitting best-effort-but-broken markdown.
  function isCitationEligible(node, text) {
    if (node.childNodes.length !== 1 || node.childNodes[0].nodeType !== 3) return false;
    const inner = text.slice(1, -1);
    return inner.indexOf(']') === -1;
  }

  function serializeAnchor(node, unsupported) {
    const href = node.getAttribute('href');
    const text = node.textContent;
    // citation: <a href="#slug">[body]</a> -> [[body]]
    if (href && href.charAt(0) === '#' && /^\[.*\]$/.test(text)) {
      if (isCitationEligible(node, text)) {
        return '[[' + text.slice(1, -1) + ']]';
      }
      unsupported.push('A');
      return '';
    }
    const label = walkChildren(node.childNodes, unsupported).md;
    return '[' + label + '](' + (href || '') + ')';
  }

  // v3.4.0 / backlog 3 (Ruling T6-7, then a fix-round regression): STRONG
  // and EM each emit a fixed, context-blind '*'-based delimiter for their
  // own tag — '**'/'**' or '*'/'*' — with no awareness of what the
  // accumulated sibling output already ends with. CommonMark scans the
  // *raw character stream*, not the DOM/AST, and a "delimiter run" is a
  // maximal span of identical adjacent characters: when one node's closing
  // '*' is directly followed (no separating character) by the next
  // sibling's opening '*', the two independent single-char delimiter
  // EVENTS silently fuse into one length-2+ RUN in the emitted text, which
  // marked's own flanking/pairing algorithm then matches on its own terms
  // — not necessarily the pairing the DOM implied. Measured (task-8
  // report): DOM `<em><code>code</code></em><em>text</em>` serialized to
  // `*`code`**text*` — the merged `**` is grabbed by marked as its own
  // delimiter run, and the FIRST <em> is dropped entirely, reappearing as
  // two literal '*' characters around the code span on reload.
  //
  // The first version of this fix guarded on ANY trailing '*', which
  // regressed a real journey scenario: `<em>it</em>` immediately followed
  // by `<strong><em>al</em> bold</strong>` — EM's closing 1 star touching
  // STRONG's opening 2+1 stars — serializes WITHOUT any guard to
  // `*it****al* bold**`, which marked already parses correctly as-is
  // (`<em>it</em><strong><em>al</em> bold</strong>`); inserting a comment
  // there changed already-correct bytes for no reason, and
  // editor-journey.test.js caught it. A 100-context sweep (reviewer-built:
  // 5 front contexts × 5 back contexts × the 4 direct EM/STRONG pairings)
  // measured the actual split: SAME-tag adjacency (EM-then-EM,
  // STRONG-then-STRONG) breaks 50/50; CROSS-tag adjacency (EM-then-STRONG,
  // STRONG-then-EM) is correct 50/50 — `*a*` immediately followed by
  // `**b**` is exactly 3 touching stars, which CommonMark's own delimiter
  // matching splits correctly without any help.
  //
  // Fix (task-8 report has the re-measured matrix): guard on the TAG of
  // whichever STRONG/EM most recently closed at THIS sibling level, not on
  // the trailing character. `lastMarkTag` (below) tracks it; a STRONG/EM
  // node inserts `<!-- -->` only when `lastMarkTag` equals its OWN tag.
  // `<!-- -->` contains no '*', so when it does fire it always ends the
  // preceding run and starts a fresh one, regardless of what characters
  // sit on either side — unlike switching to `_`/`__`, which was tried and
  // rejected: `_`-based emphasis carries CommonMark's intraword
  // restriction, and a switched closing `_` glued directly to a following
  // word character (no space) fails to close at all (verified:
  // `*`code`*_text_word` leaves `_text_word` unparsed, while the
  // HTML-comment form parses `text` as EM in the same shape). The comment
  // is inert on read-back too: `walkChildren` only handles nodeType 3
  // (text) and 1 (element) and silently skips anything else (comment nodes
  // are nodeType 8), so it never leaks into canWysiwyg's `unsupported`
  // list or into a later re-serialize — a reparsed document with the
  // comment still in the DOM just re-triggers this same guard on the next
  // save, it does not accumulate.
  //
  // `lastMarkTag` also fixes review Minor 1 (a false trigger on a literal,
  // already-escaped asterisk) as a side effect, with no regex needed: a
  // TEXT node resets `lastMarkTag` to null whenever it contributes any
  // characters at all, because escapeText() unconditionally escapes every
  // literal '*' a user types — a text node's own trailing character is
  // therefore NEVER a live, still-open '*' that a following STRONG/EM
  // could collide with, so there is nothing to compare tags against. The
  // text "a*" (typed literally, no italics intent) followed by an EM was a
  // MORE common false trigger than the real bug under the old last-char
  // check: it inserted a needless `<!-- -->` even though "a\*<em>x</em>"
  // already round-trips correctly on its own.
  //
  // Every OTHER node type that contributes real, non-empty output (CODE,
  // A, BR, DEL/S, U) also resets `lastMarkTag` to null: none of them ever
  // end their own output in a live '*' (backtick, ')'/']]', '>', '~~'
  // respectively), so nothing after them can be touching a star run.
  // Nodes that contribute NOTHING to `out` (an empty text node, a
  // `<span>` carrying attributes, an unrecognized tag pushed to
  // `unsupported`) leave `lastMarkTag` untouched — correctly preserving
  // whatever WAS touching before them, since they added no separating
  // character.
  //
  // DIV and transparent (attribute-less) SPAN are genuine passthroughs —
  // browsers wrap plain runs in bare <span>s, and a top-level <div> line
  // splices its children inline rather than nesting — so `EM` immediately
  // followed by `<span><em>x</em></span>` (or wrapped in a <div>) must
  // still be treated as touching, same-tag EM adjacency: this is exactly
  // the "透明節點覆蓋一點都沒少" requirement the coordinator called out.
  // Both branches therefore propagate the RECURSIVE call's own
  // `lastMarkTag` outward whenever that recursive call actually
  // contributed characters (`inner.md.length`); if it contributed nothing,
  // the DIV/SPAN itself contributed nothing either (SPAN) or only its own
  // leading `<br>` (DIV, non-first segment) — a `<br>` is real, `*`-free
  // output, so it resets to null; truly nothing added at all leaves the
  // incoming `lastMarkTag` untouched, same as any other zero-output node.

  // Walk a sibling list. A top-level <div> is a contenteditable line-break
  // artifact (browsers split lines with <div> rather than <br>), so each
  // <div> boundary after the first emits a <br> and its children are
  // spliced inline, never nested further. Returns `{ md, lastMarkTag }` —
  // `lastMarkTag` is this call's OWN trailing-star-boundary state (see
  // above), needed by DIV/SPAN passthrough and by nothing else: a caller
  // that wraps its own delimiter around a recursive call's content (EM,
  // STRONG, DEL/S, U, the citation label) only ever needs `.md`, because
  // its own outer delimiter is a fixed, known tag regardless of what's
  // nested inside.
  function walkChildren(nodes, unsupported) {
    let out = '';
    let firstSegment = true;
    let lastMarkTag = null;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.nodeType === 3) {
        const text = escapeText(node.textContent);
        out += text;
        if (text.length) lastMarkTag = null;
        firstSegment = false;
        continue;
      }
      if (node.nodeType !== 1) continue;
      const name = node.nodeName;
      if (name === 'DIV') {
        let added = '';
        if (!firstSegment) added += '<br>';
        const inner = walkChildren(node.childNodes, unsupported);
        added += inner.md;
        out += added;
        if (added.length) lastMarkTag = inner.md.length ? inner.lastMarkTag : null;
        firstSegment = false;
        continue;
      }
      if (name === 'SPAN') {
        if (spanHasAttributes(node)) {
          unsupported.push(name);
        } else {
          const inner = walkChildren(node.childNodes, unsupported);
          out += inner.md;
          if (inner.md.length) lastMarkTag = inner.lastMarkTag;
        }
        firstSegment = false;
        continue;
      }
      if (name === 'STRONG' || name === 'B') {
        out += (lastMarkTag === 'STRONG' ? '<!-- -->' : '') +
          '**' + walkChildren(node.childNodes, unsupported).md + '**';
        lastMarkTag = 'STRONG';
        firstSegment = false;
        continue;
      }
      if (name === 'EM' || name === 'I') {
        out += (lastMarkTag === 'EM' ? '<!-- -->' : '') +
          '*' + walkChildren(node.childNodes, unsupported).md + '*';
        lastMarkTag = 'EM';
        firstSegment = false;
        continue;
      }
      if (name === 'DEL' || name === 'S') {
        // GFM strikethrough — verified marked (gfm: true, the renderer's own
        // setOptions()) round-trips `~~x~~` to `<del>x</del>`; `<s>` is
        // accepted on input (some contenteditable/paste paths produce it)
        // but the toolbar/serializer always speak DEL, matching what marked
        // itself emits.
        out += '~~' + walkChildren(node.childNodes, unsupported).md + '~~';
        lastMarkTag = null;
        firstSegment = false;
        continue;
      }
      if (name === 'U') {
        // Underline has no Markdown/GFM syntax at all, so this emits literal
        // inline HTML by design — marked passes raw inline `<u>...</u>`
        // straight through untouched (verified), which is exactly what we
        // want: the rendered output shows an underline, and re-opening the
        // WYSIWYG editor sees the same <u> element back (server-rendered
        // HTML round-trips through the DOM parser the same way STRONG/EM/
        // DEL do). No escaping concern the other marks have: unlike `~`/`*`/
        // backtick, literal `<u>` typed as plain text is already escaped by
        // the `<` -> `&lt;` rule above, so it can never collide with a real
        // toolbar-made underline.
        out += '<u>' + walkChildren(node.childNodes, unsupported).md + '</u>';
        lastMarkTag = null;
        firstSegment = false;
        continue;
      }
      if (name === 'CODE') {
        out += serializeCode(node);
        lastMarkTag = null;
        firstSegment = false;
        continue;
      }
      if (name === 'A') {
        out += serializeAnchor(node, unsupported);
        lastMarkTag = null;
        firstSegment = false;
        continue;
      }
      if (name === 'BR') {
        // Spec §3.12. Two different things arrive here as the same element:
        //   * a <br> the EDIT-MODE renderer marked (lib/md2doc.js's
        //     renderer.br) as having come from a markdown HARD BREAK — it must
        //     go back out as a hard break, or the block loses a source line;
        //   * every other <br> — one Shift+Enter inserted, one the source
        //     spelled out literally, or the placeholder Chromium leaves behind
        //     when the last character of a surface is deleted — which keeps
        //     emitting the literal '<br>' it always did. That is a round-trip
        //     contract with tests pinning it and it does not move.
        //
        // BACKSLASH, not two trailing spaces, and the choice is forced rather
        // than stylistic: markdown's other hard-break spelling is two trailing
        // spaces, and this module's own output is checked by
        // assertNoTrailingWhitespace() (gate-compat.test.js's fossilized
        // paperwork-gate contract), while list-md.js additionally trims every
        // emitted line unconditionally. The backslash form clears both and
        // re-lexes to the same `br` token (verified: marked.lexer('- a\\\n  b')
        // gives the item a `br`). The cost, stated in §3.12: a user who wrote
        // two trailing spaces gets a backslash back — on a block they were
        // editing, with the same meaning and the same line count. Untouched
        // blocks are replayed byte-for-byte by §3.4's bystander rule and never
        // reach this code.
        const hardBreak = typeof node.getAttribute === 'function' &&
          node.getAttribute('data-hard-break') === '1';
        out += hardBreak ? '\\\n' : '<br>';
        lastMarkTag = null;
        firstSegment = false;
        continue;
      }
      unsupported.push(name);
      firstSegment = false;
    }
    return { md: out, lastMarkTag };
  }

  function serializeInline(rootEl) {
    const unsupported = [];
    const md = walkChildren(rootEl.childNodes, unsupported).md;
    return { md, unsupported };
  }

  function canWysiwyg(rootEl) {
    return serializeInline(rootEl).unsupported.length === 0;
  }

  return { serializeInline, canWysiwyg, escapeText };
});
