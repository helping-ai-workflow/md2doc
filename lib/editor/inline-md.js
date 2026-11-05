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

  // v3.13.1 T2 (F-1): text a person typed at the start of a paragraph or
  // list-item line that a renderer would read as a block marker. Measured
  // before this: typing `## `, `- `, `> ` or `1. ` at a paragraph start saved
  // the line unescaped, and the next render silently turned the paragraph
  // into a heading, list or quote.
  //
  // Input is escapeText() output, possibly several lines (a hard break's
  // backslash-newline, or a lazy continuation). Each line, after up to three
  // spaces of indent, gets the FIRST matching rule below; nothing else is
  // touched. The list is the decision:
  //   ATX heading      `#`..`######` then space/tab/end   -> `\#…`
  //   bullet           `-` or `+` then space/tab/end      -> `\-…` / `\+…`
  //   blockquote       `>` (no space needed)              -> `\>…`
  //   ordered          1-9 digits, `.` or `)`, space/end  -> `1\.` / `1\)`
  //   setext/rule      a run of `=` or of `-`, alone      -> `\===` / `\---`
  //   spaced rule      3+ `-` with spaces between, alone  -> `\-- -`
  //   table row        `|`                                -> `\|…`
  // `*`, `_`, backtick, `~`, `<` and `[` never get here unescaped
  // (escapeText()). A line whose first character is `\` matches nothing,
  // which is what keeps already-escaped text byte-stable. `-5 dBm` and
  // `1.5 V` match nothing either: the marker must be followed by a space, a
  // tab or the end of the line. Indented code (4+ spaces) is out of scope.
  const BLOCK_START_RULES = [
    { re: /^#{1,6}(?=[ \t]|$)/, fix: (rest) => '\\' + rest },
    { re: /^[-+](?=[ \t]|$)/, fix: (rest) => '\\' + rest },
    { re: /^>/, fix: (rest) => '\\' + rest },
    { re: /^(\d{1,9})([.)])(?=[ \t]|$)/, fix: (rest) => rest.replace(/^(\d{1,9})([.)])/, '$1\\$2') },
    { re: /^(=+|-+)[ \t]*$/, fix: (rest) => '\\' + rest },
    // A thematic break may have spaces between its dashes (`-- -`,
    // `----  -`); the run rule above only sees an unbroken one.
    { re: /^-(?:[ \t]*-){2,}[ \t]*$/, fix: (rest) => '\\' + rest },
    { re: /^\|/, fix: (rest) => '\\' + rest },
  ];
  function escapeBlockStarts(md) {
    return String(md).split('\n').map((line) => {
      const ind = /^ {0,3}/.exec(line)[0];
      const rest = line.slice(ind.length);
      for (let i = 0; i < BLOCK_START_RULES.length; i++) {
        if (BLOCK_START_RULES[i].re.test(rest)) return ind + BLOCK_START_RULES[i].fix(rest);
      }
      return line;
    }).join('\n');
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
  //
  // `opts.codePipe` (v3.17.6, table cells only): what a '|' in the code text
  // is written as. table-md.js passes a placeholder here and turns it into
  // `\|` after its own whole-cell '&#124;' pass, which must not see it. The
  // fence is measured on the real text; the placeholder holds no backtick.
  function serializeCode(node, opts) {
    const raw = node.textContent;
    const runs = raw.match(/`+/g);
    const longestRun = runs ? Math.max.apply(null, runs.map((r) => r.length)) : 0;
    const body = opts && opts.codePipe !== undefined ? raw.split('|').join(opts.codePipe) : raw;
    if (longestRun === 0) return '`' + body + '`';
    const fence = new Array(longestRun + 2).join('`');
    return fence + ' ' + body + ' ' + fence;
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

  // The test serializeAnchor() uses to write `[[body]]` (v3.17.7: shared
  // with serializeInline()'s read-back check).
  function isCitationNode(node) {
    const href = typeof node.getAttribute === 'function' ? node.getAttribute('href') : null;
    const text = node.textContent;
    return !!href && href.charAt(0) === '#' && /^\[.*\]$/.test(text) && isCitationEligible(node, text);
  }
  function serializeAnchor(node, unsupported, opts) {
    const href = node.getAttribute('href');
    // A raw HTML anchor (`<a id="ref-x"></a>`, NO href attribute) is not a
    // markdown link: emitting '[label]()' for it erased the anchor on the
    // first edit of its block. Unsupported, so the block keeps its source.
    // An empty href ('' — from '[x]()') is still a link.
    if (href === null) {
      unsupported.push('A');
      return '';
    }
    const text = node.textContent;
    // citation: <a href="#slug">[body]</a> -> [[body]]
    if (href && href.charAt(0) === '#' && /^\[.*\]$/.test(text)) {
      if (isCitationEligible(node, text)) {
        return '[[' + text.slice(1, -1) + ']]';
      }
      unsupported.push('A');
      return '';
    }
    const label = walkChildren(node.childNodes, unsupported, opts).md;
    return '[' + label + '](' + (href || '') + ')';
  }

  // (What a mark's own edges must look like -- whitespace and punctuation
  // just inside its delimiters -- is a separate rule, v3.17.5, written above
  // `splitEdges` / `appendPiece` further down.)
  //
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
  // v3.17.5 M1 + R1: a delimiter run only counts when CommonMark's flanking
  // rule accepts it, and STRONG / EM / DEL used to wrap their content blind.
  // Measured on 4d7669f, all three rendered literal asterisks in the reader:
  //   Delete down to a leading space     `alpha ** charlie** delta`
  //   Ctrl+B on 「引號」                  `前面**「引號」**後面`
  //   Ctrl+B on `charlie ` (with space)  `alpha **charlie **delta`
  // The rule, in marked 14's own classes (whitespace = JS `\s`, punctuation =
  // `\p{P}\p{S}`): the character just INSIDE a run may not be whitespace, and
  // when it is punctuation the character just OUTSIDE must be whitespace,
  // punctuation or the edge of the text.
  //
  // Two fixes, one per half of the rule:
  //   * whitespace inside -> moved outside (`splitEdges`), byte for byte, so
  //     ` charlie` in bold becomes ` **charlie**`; a mark holding nothing
  //     else is no mark at all. A hard break (`\` + newline) at an edge
  //     moves out whole: peeling only its newline would leave the backslash
  //     escaping the delimiter.
  //   * punctuation inside, a word character outside -> `<!-- -->` between
  //     them (`appendPiece`). The comment is the same inert separator the
  //     same-tag guard above uses; marked masks an HTML tag as punctuation,
  //     so the run then has punctuation on both sides, which the rule allows.
  //     Only `*` runs need it: marked's `~~` is not punctuation-flanking
  //     (`~~中文。~~後面` parses), and `_` is never emitted.
  // The punctuation check runs where two pieces are joined, on the bytes
  // themselves, because the character outside a run may belong to a sibling,
  // or to a parent's sibling when the run starts or ends a bare SPAN: every
  // level joins its own pieces, so a run at the edge of a nested call is
  // checked again by its parent. A run's inside is found by skipping its bare
  // `*`s: escapeText() escapes every literal `*`, so a `*` at either end of a
  // piece is a delimiter unless an odd run of backslashes precedes it.
  const FLANK_WS = /\s/;
  const FLANK_PUNCT = /[\p{P}\p{S}]/u;
  function isWordish(ch) {
    return ch !== undefined && !FLANK_WS.test(ch) && !FLANK_PUNCT.test(ch);
  }
  function lastCodePoint(s, end) {
    if (end <= 0) return undefined;
    const lo = s.charCodeAt(end - 1);
    if (lo >= 0xdc00 && lo <= 0xdfff && end >= 2) {
      const hi = s.charCodeAt(end - 2);
      if (hi >= 0xd800 && hi <= 0xdbff) return s.slice(end - 2, end);
    }
    return s[end - 1];
  }
  function firstCodePoint(s, start) {
    if (start >= s.length) return undefined;
    return String.fromCodePoint(s.codePointAt(start));
  }
  // The character just inside a leading `*` run, or undefined when `s` does
  // not open with one.
  function openingRunInside(s) {
    let i = 0;
    while (s[i] === '*') i++;
    return i ? firstCodePoint(s, i) : undefined;
  }
  // The character just inside a trailing `*` run, or undefined when `s` does
  // not close with one.
  function closingRunInside(s) {
    let k = 0;
    while (k < s.length && s[s.length - 1 - k] === '*') k++;
    if (!k) return undefined;
    let b = 0;
    while (s[s.length - 1 - k - b] === '\\') b++;
    if (b % 2) return k > 1 ? '*' : undefined; // the run's first `*` is an escaped literal
    return lastCodePoint(s, s.length - k);
  }
  // Two v3.17.5 final-review findings shape the outside characters:
  //   * I2 -- marked reads the character before an opening run as ONE UTF-16
  //     unit (`token.raw.slice(-1)`), so an astral symbol there (📌, \p{So})
  //     is a lone surrogate to it, i.e. a word character. Match that.
  //   * I1 -- a closing run touching the next piece's opening run fuses with
  //     it (`**注意：***斜體*`); the character after the fused run is the one
  //     inside the right piece's run, not its `*`. The opening side needs no
  //     such care: once the left run has closed, marked sees a `*`
  //     (punctuation) before the rest, which the rule accepts.
  function needsFlankSeparator(left, right) {
    if (!left || !right) return false;
    const open = openingRunInside(right);
    if (open !== undefined && FLANK_PUNCT.test(open) && isWordish(left[left.length - 1])) return true;
    const close = closingRunInside(left);
    const after = right[0] === '*' ? openingRunInside(right) : firstCodePoint(right, 0);
    return close !== undefined && FLANK_PUNCT.test(close) && isWordish(after);
  }
  function appendPiece(out, piece) {
    return out + (needsFlankSeparator(out, piece) ? '<!-- -->' : '') + piece;
  }
  // `md` -> { lead, core, trail }: whitespace (and whole hard breaks) peeled
  // off both ends of a mark's content.
  function splitEdges(md) {
    let start = 0;
    let end = md.length;
    for (;;) {
      if (start < end && FLANK_WS.test(md[start])) { start++; continue; }
      // a leading `\` is always a hard break's: a literal one is `\\`
      if (md[start] === '\\' && md[start + 1] === '\n' && start + 2 <= end) { start += 2; continue; }
      break;
    }
    for (;;) {
      if (end > start && md[end - 1] === '\n') {
        let b = 0;
        while (end - 2 - b >= start && md[end - 2 - b] === '\\') b++;
        end -= b % 2 ? 2 : 1;
        continue;
      }
      if (end > start && FLANK_WS.test(md[end - 1])) { end--; continue; }
      break;
    }
    return { lead: md.slice(0, start), core: md.slice(start, end), trail: md.slice(end) };
  }

  function markIsSearchHit(node) {
    if (typeof node.getAttribute !== 'function') return false;
    return (' ' + (node.getAttribute('class') || '') + ' ').indexOf(' search-hit ') !== -1;
  }
  // `ctx` (v3.17.7) says how a STRONG / EM nested inside another STRONG / EM
  // is spelled; see serializeInline(). Absent means the plain `*` spelling.
  // `touching` (v3.17.7) is the mark tag that ends right before these
  // nodes, for a transparent wrapper whose first child may need the
  // same-tag guard against it.
  function walkChildren(nodes, unsupported, opts, ctx, touching) {
    const c = ctx || PLAIN;
    let out = '';
    let firstSegment = true;
    let lastMarkTag = touching || null;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.nodeType === 3) {
        const text = escapeText(node.textContent);
        out = appendPiece(out, text);
        if (text.length) lastMarkTag = null;
        firstSegment = false;
        continue;
      }
      if (node.nodeType !== 1) continue;
      const name = node.nodeName;
      if (name === 'DIV') {
        let added = '';
        if (!firstSegment) added += '<br>';
        const inner = walkChildren(node.childNodes, unsupported, opts, c);
        added += inner.md;
        out = appendPiece(out, added);
        if (added.length) lastMarkTag = inner.md.length ? inner.lastMarkTag : null;
        firstSegment = false;
        continue;
      }
      if (name === 'MARK' && markIsSearchHit(node)) {
        // v3.14.0 T9: the reader's search paints its hits as this element and
        // it is transient, so it serializes as what it wraps.
        const inner = walkChildren(node.childNodes, unsupported, opts, c, lastMarkTag);
        out = appendPiece(out, inner.md);
        if (inner.md.length) lastMarkTag = inner.lastMarkTag;
        firstSegment = false;
        continue;
      }
      if (name === 'SPAN') {
        if (spanHasAttributes(node)) {
          unsupported.push(name);
        } else {
          const inner = walkChildren(node.childNodes, unsupported, opts, c, lastMarkTag);
          out = appendPiece(out, inner.md);
          if (inner.md.length) lastMarkTag = inner.lastMarkTag;
        }
        firstSegment = false;
        continue;
      }
      if (name === 'STRONG' || name === 'B' || name === 'EM' || name === 'I') {
        const tag = (name === 'STRONG' || name === 'B') ? 'STRONG' : 'EM';
        const e = splitEdges(walkChildren(node.childNodes, unsupported, opts, c.inner).md);
        if (e.core) {
          // a hoisted leading space already separates two same-tag runs
          const guard = !e.lead && lastMarkTag === tag ? '<!-- -->' : '';
          const delim = c.delims[tag];
          out = appendPiece(out, e.lead + guard + c.before + delim + e.core + delim + c.after + e.trail);
          lastMarkTag = e.trail ? null : tag;
        } else if (e.lead || e.trail) {
          out = appendPiece(out, e.lead + e.trail);
          lastMarkTag = null;
        }
        firstSegment = false;
        continue;
      }
      if (name === 'DEL' || name === 'S') {
        // GFM strikethrough — verified marked (gfm: true, the renderer's own
        // setOptions()) round-trips `~~x~~` to `<del>x</del>`; `<s>` is
        // accepted on input (some contenteditable/paste paths produce it)
        // but the toolbar/serializer always speak DEL, matching what marked
        // itself emits.
        //
        // v3.17.7 N2: two strikethroughs side by side get the same guard as
        // two bolds. `~~a~~~~b~~` reads as ONE del holding `a~~~~b` (measured
        // on 71fedaa: strike `two` right after `~~one~~` wrote exactly that).
        const e = splitEdges(walkChildren(node.childNodes, unsupported, opts, c).md);
        const guard = e.core && !e.lead && lastMarkTag === 'DEL' ? '<!-- -->' : '';
        out = appendPiece(out, e.core ? e.lead + guard + '~~' + e.core + '~~' + e.trail : e.lead + e.trail);
        if (e.core) lastMarkTag = e.trail ? null : 'DEL';
        else if (e.lead || e.trail) lastMarkTag = null;
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
        out = appendPiece(out, '<u>' + walkChildren(node.childNodes, unsupported, opts, c).md + '</u>');
        lastMarkTag = null;
        firstSegment = false;
        continue;
      }
      if (name === 'CODE') {
        // v3.17.7 N3: two code spans side by side are one span to a reader
        // (`` `one``two` `` is the code "one``two"), so they get a guard too.
        // serializeCode() never writes an empty span, so this always fires
        // between two real ones.
        out = appendPiece(out, (lastMarkTag === 'CODE' ? '<!-- -->' : '') + serializeCode(node, opts));
        lastMarkTag = 'CODE';
        firstSegment = false;
        continue;
      }
      if (name === 'A') {
        out = appendPiece(out, serializeAnchor(node, unsupported, opts));
        lastMarkTag = null;
        firstSegment = false;
        continue;
      }
      if (name === 'BR' && typeof node.getAttribute === 'function' &&
          node.getAttribute('data-ed-tail') === '1') {
        // v3.14.0 T8: the editor's tail <br> (insertBrAtCaret() in client.js)
        // only gives a line break at the end of a surface a line to stand on.
        // It is not content: nothing written, and like an empty text node it
        // leaves lastMarkTag / firstSegment as they were.
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
        out = appendPiece(out, hardBreak ? '\\\n' : '<br>');
        lastMarkTag = null;
        firstSegment = false;
        continue;
      }
      unsupported.push(name);
      firstSegment = false;
    }
    return { md: out, lastMarkTag };
  }

  // ── v3.17.7 N1: check the bytes with the reader's own parser ─────────────
  //
  // A STRONG / EM nested inside another STRONG / EM is written `*` / `**`
  // like any other, and most of the time marked reads that back. Not always:
  // marked's emphasis scan (emStrong in marked 14) walks from an opening run
  // to its closer counting the `*` runs in between, and a run with word
  // characters on both sides is a "mid" run it may skip under the rule of 3.
  // Whether a nested mark survives therefore depends on the characters
  // around its runs. Measured on 71fedaa, each from a toolbar gesture:
  //   `*`c`**i**tal*`                -> the em is lost, its stars show
  //   `*~~a**a**~~*`                 -> `~~` is invisible to that scan
  //   `前面「引號<!-- -->*」**粗**後面，中文*。`
  // while `*a**i**tal*` and `***ital* bold**` read fine. The rules are
  // marked's, so marked decides: serializeInline() writes the bytes as
  // before, parses them, and compares the marks on every character with the
  // DOM it was given. Only when they differ does it try other spellings for
  // the nested marks, in this order, keeping the first that reads back:
  //   1. `__` / `_` for every STRONG / EM inside another (those runs are
  //      not `*`, so the outer scan does not count them);
  //   2. the same with `<!-- -->` on both sides of each such mark (a run
  //      next to `<` is no longer flanked by a word character), then each of
  //      those guards dropped again if the bytes still read back without it.
  // If neither reads back the original bytes are kept: what this release
  // wrote before. Bytes that already read back are never touched, so no
  // file written by an earlier release changes by being opened and saved.
  // A fuzz over random strong / em / del / code trees (inline-md.test.js;
  // 7725 of 20000 read back wrong on 71fedaa) needed nothing beyond step 2.
  //
  // A repaired spelling never keeps `<!--` at the start of a line: marked
  // reads a line-start `<!--` as an HTML block and ends the paragraph there
  // (v3.17.5 C1), and parseInline() cannot see that. It does not have to:
  // the only guards step 2 adds sit before an opening run or after a
  // closing one, and after a newline the character before an opening run
  // is whitespace, which already does what the guard's `>` does (no
  // right-flanking, opening allowed). So a step-2 guard at a line start is
  // dropped before anything is parsed, whether or not the drop pass below
  // runs (re-review: with the pass skipped past 16 guards, one survived
  // after a hard break and the reader cut the paragraph there). The walk
  // itself never writes one (needsFlankSeparator() sees `\n` as a non-word
  // character).
  //
  // The parser is a private `new Marked()` with gfm on and nothing else, in
  // node and in the editor page alike (server.js injects marked's UMD build
  // before this file). The reader's own instance carries the md2doc
  // renderer, whose text hook writes into the render's search index, and
  // its sub / sup / KaTeX extensions only see `~` / `^` / `$`, which this
  // comparison is not about. No parser (a page without marked) means no
  // check: the bytes are written as before.
  const GUARD = '<!-- -->';
  const STAR = { STRONG: '**', EM: '*' };
  const UNDERSCORE = { STRONG: '__', EM: '_' };
  // PLAIN.inner is PLAIN: the spelling every release before this one used.
  const PLAIN = { delims: STAR, before: '', after: '', inner: null };
  PLAIN.inner = PLAIN;
  function spelling(before) {
    const nested = { delims: UNDERSCORE, before, after: before, inner: null };
    nested.inner = nested;
    return { delims: STAR, before: '', after: '', inner: nested };
  }
  const NESTED_UNDERSCORE = spelling('');
  // One character stands in for each step-2 guard until it is decided, so
  // only those guards are ever dropped, never one the walk wrote itself. It
  // must be punctuation to needsFlankSeparator(), as the `<` it stands for
  // is: with a word-like stand-in the walk skips a guard the real bytes need
  // (measured: `ital**<!-- -->_…` lost the `<!-- -->` before its `**`).
  // U+2E3B THREE-EM DASH (\p{Pd}); a block whose text holds one skips step 2.
  const PENDING = '\u2E3B';
  const NESTED_GUARDED = spelling(PENDING);

  let inlineParser; // undefined: not looked up yet; null: none available
  function getInlineParser() {
    if (inlineParser !== undefined) return inlineParser;
    inlineParser = null;
    try {
      let lib = null;
      if (typeof module === 'object' && module.exports && typeof require === 'function') lib = require('marked');
      else if (typeof self !== 'undefined' && self.marked) lib = self.marked;
      if (lib && typeof lib.Marked === 'function') {
        const m = new lib.Marked({ gfm: true, breaks: false });
        inlineParser = (s) => m.parseInline(s);
      }
    } catch (e) {
      inlineParser = null;
    }
    return inlineParser;
  }
  // Tests swap the parser: a function, null to switch the check off, or
  // nothing to go back to the lookup above.
  function setInlineParser(fn) {
    inlineParser = typeof fn === 'function' ? fn : (fn === null ? null : undefined);
  }

  // One entry per non-space character: the character and the sorted set of
  // S(trong) / E(m) / D(el) around it. A code span is one entry holding its
  // text without whitespace (a reader strips one space at each end, and
  // spacing is not what this check is about). Whitespace is left out
  // (splitEdges() moves it across a delimiter on purpose), and so are line
  // breaks, link targets and <u>. A citation is written `[[body]]`, which
  // this private parser (no md2doc extension) reads as that literal text,
  // so its DOM side counts the outer brackets too: without them the two
  // sides never agreed and any block holding a citation was never repaired
  // (final review).
  const MARK_LETTER = { STRONG: 'S', B: 'S', EM: 'E', I: 'E', DEL: 'D', S: 'D' };
  const SPACE = /\s/;
  function domMarks(nodes, marks, out) {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.nodeType === 3) {
        for (const ch of node.textContent) if (!SPACE.test(ch)) out.push(ch + '[' + marks + ']');
        continue;
      }
      if (node.nodeType !== 1) continue;
      if (node.nodeName === 'CODE') { out.push('`' + node.textContent.replace(/\s+/g, '') + '[' + marks + ']'); continue; }
      if (node.nodeName === 'A' && isCitationNode(node)) {
        for (const ch of '[' + node.textContent + ']') if (!SPACE.test(ch)) out.push(ch + '[' + marks + ']');
        continue;
      }
      const k = MARK_LETTER[node.nodeName];
      const inner = k && marks.indexOf(k) === -1 ? (marks + k).split('').sort().join('') : marks;
      domMarks(node.childNodes, inner, out);
    }
    return out;
  }
  const HTML_TAG_MARK = { strong: 'S', em: 'E', del: 'D' };
  const HTML_ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
  function htmlMarks(html) {
    const out = [];
    const open = [];
    let code = null;
    const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|&(amp|lt|gt|quot|#39);|([^<&]+|[<&])/g;
    const current = () => open.slice().sort().filter((k, i, a) => a.indexOf(k) === i).join('');
    let m;
    while ((m = re.exec(html))) {
      if (m[0].startsWith('<!--')) continue;
      if (m[2]) {
        const tag = m[2].toLowerCase();
        if (tag === 'code') {
          if (m[1]) { out.push('`' + (code || '').replace(/\s+/g, '') + '[' + current() + ']'); code = null; } else code = '';
          continue;
        }
        const k = HTML_TAG_MARK[tag];
        if (!k) continue;
        if (m[1]) { const at = open.lastIndexOf(k); if (at !== -1) open.splice(at, 1); } else open.push(k);
        continue;
      }
      const t = m[3] ? HTML_ENTITY[m[3]] : m[4];
      if (code !== null) { code += t; continue; }
      for (const ch of t) if (!SPACE.test(ch)) out.push(ch + '[' + current() + ']');
    }
    return out;
  }

  // `opts` is optional; its one field, `codePipe`, is described at
  // serializeCode(). Every caller but table-md.js passes nothing.
  function serializeInline(rootEl, opts) {
    const unsupported = [];
    const md = walkChildren(rootEl.childNodes, unsupported, opts).md;
    // The spellings below only differ where a STRONG / EM sits inside another
    // one, so a block without that is written as walked, unparsed: no cost
    // on the per-keystroke shortcut check or for callers that only want
    // `unsupported`.
    if (unsupported.length || !hasNestedStar(rootEl.childNodes, false)) return { md, unsupported };
    const parse = getInlineParser();
    if (!parse) return { md, unsupported };
    const want = domMarks(rootEl.childNodes, '', []).join('|');
    // table-md.js writes a code `|` as its placeholder; the cell shows `|`
    // (GFM drops the `\` of `\|` before the cell is parsed inline).
    const pipe = opts && opts.codePipe;
    const readsBack = (s) => {
      try {
        return htmlMarks(parse(pipe ? s.split(pipe).join('|') : s)).join('|') === want;
      } catch (e) {
        return false;
      }
    };
    if (readsBack(md)) return { md, unsupported };
    const one = walkChildren(rootEl.childNodes, [], opts, NESTED_UNDERSCORE).md;
    if (readsBack(one)) return { md: one, unsupported };
    if (domText(rootEl.childNodes).indexOf(PENDING) === -1) {
      const parts = walkChildren(rootEl.childNodes, [], opts, NESTED_GUARDED).md.split(PENDING);
      // guard k sits right after parts[k]; none is kept at a line start
      let before = '';
      const keep = parts.slice(1).map((_, k) => {
        before += parts[k];
        return !/(^|\n)[ \t]*$/.test(before);
      });
      const build = () => parts.reduce((acc, part, i) =>
        (i ? acc + (keep[i - 1] ? GUARD : '') : '') + part, '');
      if (readsBack(build())) {
        // Each drop is one more parse of the whole block. Past a handful of
        // guards keep them all: correct bytes, a few extra `<!-- -->`
        // (final review measured 400 repaired marks at 3.4 s otherwise).
        for (let i = 0; i < keep.length && keep.length <= MAX_GUARDS_TO_DROP; i++) {
          if (!keep[i]) continue;
          keep[i] = false;
          if (!readsBack(build())) keep[i] = true;
        }
        return { md: build(), unsupported };
      }
    }
    return { md, unsupported };
  }
  const MAX_GUARDS_TO_DROP = 16;
  const STAR_TAGS = { STRONG: 1, B: 1, EM: 1, I: 1 };
  // Whether a STRONG / EM sits inside another one, through any wrapper the
  // walk spells with the context it was given (not CODE, not a link label).
  function hasNestedStar(nodes, inStar) {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.nodeType !== 1 || node.nodeName === 'CODE' || node.nodeName === 'A') continue;
      const star = STAR_TAGS[node.nodeName] === 1;
      if (star && inStar) return true;
      if (hasNestedStar(node.childNodes, inStar || star)) return true;
    }
    return false;
  }
  function domText(nodes) {
    let s = '';
    for (let i = 0; i < nodes.length; i++) s += nodes[i].textContent || '';
    return s;
  }

  function canWysiwyg(rootEl) {
    return serializeInline(rootEl).unsupported.length === 0;
  }

  // v3.15.0 T5 (D15): what the URL field writes into an href. serializeAnchor
  // puts the href into `[text](href)` unescaped, so a space or a parenthesis
  // would end the destination early; those and angle brackets are
  // percent-encoded. A bare host gets https://; anything that already names a
  // scheme, an anchor or a path is kept.
  function normalizeHref(raw) {
    let h = String(raw == null ? '' : raw).trim();
    if (h === '') return '';
    if (!/^([a-z][a-z0-9+.-]*:|#|\/|\.\/|\.\.\/)/i.test(h)) h = 'https://' + h;
    return h.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29')
      .replace(/</g, '%3C').replace(/>/g, '%3E');
  }

  // A clipboard text that is exactly one http(s) URL (the address bar adds a
  // trailing newline, some pages surrounding spaces).
  function isPastedUrl(text) {
    return /^https?:\/\/\S+$/.test(String(text == null ? '' : text).trim());
  }

  // ── v3.17.0 T7 (D17): the image paragraph ───────────────────────────────
  // A paragraph that is one `![alt](dest "title")` and nothing else. scanImage
  // finds the three spans a rewrite may touch (the alt between the brackets,
  // the destination, everything else is left byte-for-byte): the title with
  // its quote style and the whitespace around it, the leading and trailing
  // whitespace of the line. A linked image, a reference image (`![a][r]`),
  // text around the image or a second image is not one.
  function scanImage(text) {
    const s = String(text == null ? '' : text);
    const m = /^[ \t]*!\[/.exec(s);
    if (!m) return null;
    let i = m[0].length;
    const altStart = i;
    let depth = 0;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') { i++; continue; }
      if (c === '\n') return null;
      if (c === '[') depth++;
      else if (c === ']') { if (depth === 0) break; depth--; }
    }
    if (i >= s.length || s[i] !== ']') return null;
    const altEnd = i;
    i++;
    if (s[i] !== '(') return null;
    i++;
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
    const destStart = i;
    let angle = false;
    let destEnd;
    if (s[i] === '<') {
      angle = true;
      i++;
      for (; i < s.length; i++) {
        const c = s[i];
        if (c === '\\') { i++; continue; }
        if (c === '\n' || c === '<') return null;
        if (c === '>') break;
      }
      if (i >= s.length) return null;
      destEnd = i + 1;
      i = destEnd;
    } else {
      let parens = 0;
      for (; i < s.length; i++) {
        const c = s[i];
        if (c === '\\') { i++; continue; }
        if (c === ' ' || c === '\t' || c === '\n') break;
        if (c === '(') parens++;
        else if (c === ')') { if (parens === 0) break; parens--; }
      }
      if (parens !== 0) return null;
      destEnd = i;
    }
    let j = i;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
    let title = null;
    if (j > i && j < s.length && (s[j] === '"' || s[j] === "'" || s[j] === '(')) {
      const close = s[j] === '(' ? ')' : s[j];
      let k = j + 1;
      for (; k < s.length; k++) {
        if (s[k] === '\\') { k++; continue; }
        if (s[k] === close) break;
      }
      if (k >= s.length) return null;
      title = s.slice(j, k + 1);
      j = k + 1;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
    }
    if (s[j] !== ')') return null;
    const tail = s.slice(j + 1);
    if (!/^[ \t]*$/.test(tail)) return null;
    return { s, altStart, altEnd, destStart, destEnd, angle, title };
  }

  // v3.17.3 A3: marked keeps a backslash before anything but [ and ] in an
  // image's alt (measured, marked 14: `a\`b` renders alt a\`b, `x\\y` renders
  // x\\y), and an unbalanced backtick in the brackets turns the whole image
  // into a code span. So only [ and ] are backslash-escaped; the backtick,
  // the ampersand and the backslash are written as the character references
  // the browser reads back as the same character. The reader side below
  // undoes those, plus the backslash escapes older files hold.
  // Final review M2 (R25 / R7), widened by v3.17.4 E1 (R10): every character
  // reference the reader decodes — marked passes them into the alt attribute
  // untouched and the browser decodes them — so the field shows what the
  // reader shows. A decimal or hex number needs no table. A name goes through
  // the installed decoder (the client installs one that asks the page itself,
  // so every name the browser knows decodes); with none installed, the six
  // names amp, lt, gt, quot, apos and nbsp. A name the decoder does not know
  // stays as written in the field, and is written so that it renders as that
  // text. An edited alt is written as the decoded character itself.
  const ALT_ESCAPE = { '[': '\\[', ']': '\\]', '&': '&amp;', '`': '&#96;', '\\': '&#92;' };
  const ALT_NAMED_CHAR = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  const defaultNamedReference = (name) => ALT_NAMED_CHAR[name];
  let namedReference = defaultNamedReference;
  function setNamedReferenceDecoder(fn) { namedReference = typeof fn === 'function' ? fn : defaultNamedReference; }
  const ALT_UNESCAPE = /\\([!-\/:-@\[-`{-~])|&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g;
  // A number the HTML parser would not give as itself (zero, a surrogate,
  // past U+10FFFF) is U+FFFD there, so it is here too.
  function altCodePoint(n) {
    return n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) ? '\ufffd' : String.fromCodePoint(n);
  }
  function altUnescape(m, c, dec, hex, name) {
    if (c !== undefined) return c;
    if (dec !== undefined) return altCodePoint(parseInt(dec, 10));
    if (hex !== undefined) return altCodePoint(parseInt(hex, 16));
    const r = namedReference(name);
    return typeof r === 'string' ? r : m;
  }

  function parseImageParagraph(text) {
    const f = scanImage(text);
    if (!f) return null;
    const rawAlt = f.s.slice(f.altStart, f.altEnd);
    const rawDest = f.s.slice(f.destStart, f.destEnd);
    return {
      alt: rawAlt.replace(ALT_UNESCAPE, altUnescape),
      dest: f.angle ? rawDest.slice(1, -1) : rawDest,
      title: f.title,
      angle: f.angle,
    };
  }

  // Alt and/or destination replaced, everything else kept. `alt` is plain text
  // (the characters that would end or bend the brackets are escaped, see
  // ALT_ESCAPE); `dest` is written as given, so the caller makes it
  // markdown-ready — an angle-bracketed original loses its brackets.
  function rewriteImage(text, patch) {
    const f = scanImage(text);
    if (!f) return String(text == null ? '' : text);
    const p = patch || {};
    let out = f.s.slice(0, f.altStart);
    out += typeof p.alt === 'string' ? p.alt.replace(/[\\\[\]&`]/g, (c) => ALT_ESCAPE[c]) : f.s.slice(f.altStart, f.altEnd);
    out += f.s.slice(f.altEnd, f.destStart);
    out += typeof p.dest === 'string' ? p.dest : f.s.slice(f.destStart, f.destEnd);
    out += f.s.slice(f.destEnd);
    return out;
  }

  return { serializeInline, canWysiwyg, escapeText, escapeBlockStarts, normalizeHref, isPastedUrl, parseImageParagraph, rewriteImage, setNamedReferenceDecoder, setInlineParser };
});
