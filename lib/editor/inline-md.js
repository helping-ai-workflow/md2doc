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
    const label = walkChildren(node.childNodes, unsupported);
    return '[' + label + '](' + (href || '') + ')';
  }

  // Walk a sibling list. A top-level <div> is a contenteditable line-break
  // artifact (browsers split lines with <div> rather than <br>), so each
  // <div> boundary after the first emits a <br> and its children are
  // spliced inline, never nested further.
  function walkChildren(nodes, unsupported) {
    let out = '';
    let firstSegment = true;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.nodeType === 3) {
        out += escapeText(node.textContent);
        firstSegment = false;
        continue;
      }
      if (node.nodeType !== 1) continue;
      const name = node.nodeName;
      if (name === 'DIV') {
        if (!firstSegment) out += '<br>';
        out += walkChildren(node.childNodes, unsupported);
        firstSegment = false;
        continue;
      }
      if (name === 'SPAN') {
        if (spanHasAttributes(node)) {
          unsupported.push(name);
        } else {
          out += walkChildren(node.childNodes, unsupported);
        }
        firstSegment = false;
        continue;
      }
      if (name === 'STRONG' || name === 'B') {
        out += '**' + walkChildren(node.childNodes, unsupported) + '**';
        firstSegment = false;
        continue;
      }
      if (name === 'EM' || name === 'I') {
        out += '*' + walkChildren(node.childNodes, unsupported) + '*';
        firstSegment = false;
        continue;
      }
      if (name === 'DEL' || name === 'S') {
        // GFM strikethrough — verified marked (gfm: true, the renderer's own
        // setOptions()) round-trips `~~x~~` to `<del>x</del>`; `<s>` is
        // accepted on input (some contenteditable/paste paths produce it)
        // but the toolbar/serializer always speak DEL, matching what marked
        // itself emits.
        out += '~~' + walkChildren(node.childNodes, unsupported) + '~~';
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
        out += '<u>' + walkChildren(node.childNodes, unsupported) + '</u>';
        firstSegment = false;
        continue;
      }
      if (name === 'CODE') {
        out += serializeCode(node);
        firstSegment = false;
        continue;
      }
      if (name === 'A') {
        out += serializeAnchor(node, unsupported);
        firstSegment = false;
        continue;
      }
      if (name === 'BR') {
        out += '<br>';
        firstSegment = false;
        continue;
      }
      unsupported.push(name);
      firstSegment = false;
    }
    return out;
  }

  function serializeInline(rootEl) {
    const unsupported = [];
    const md = walkChildren(rootEl.childNodes, unsupported);
    return { md, unsupported };
  }

  function canWysiwyg(rootEl) {
    return serializeInline(rootEl).unsupported.length === 0;
  }

  return { serializeInline, canWysiwyg, escapeText };
});
