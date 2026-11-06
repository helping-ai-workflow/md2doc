'use strict';
const assert = require('assert');
const { marked } = require('marked');
const { serializeInline, canWysiwyg, escapeText, escapeBlockStarts, normalizeHref, isPastedUrl } = require('../lib/editor/inline-md.js');

// minimal element stub
function el(name, attrs, ...children) {
  return {
    nodeType: 1, nodeName: name.toUpperCase(),
    childNodes: children.map(c => typeof c === 'string' ? { nodeType: 3, textContent: c } : c),
    getAttribute: (k) => (attrs || {})[k] !== undefined ? attrs[k] : null,
    get textContent() {
      return this.childNodes.map(c => c.textContent).join('');
    },
  };
}

// marks
assert.strictEqual(serializeInline(el('p', {}, 'a ', el('strong', {}, 'b'), ' c')).md, 'a **b** c');
assert.strictEqual(serializeInline(el('p', {}, el('em', {}, 'x'))).md, '*x*');
assert.strictEqual(serializeInline(el('p', {}, el('code', {}, 'pmac_tx_tvalidchk'))).md, '`pmac_tx_tvalidchk`');
// code containing a backtick → double-backtick fence
assert.strictEqual(serializeInline(el('p', {}, el('code', {}, 'a`b'))).md, '`` a`b ``');
// links + citation
assert.strictEqual(serializeInline(el('p', {}, el('a', { href: 'http://x' }, 'lnk'))).md, '[lnk](http://x)');
assert.strictEqual(serializeInline(el('p', {}, el('a', { href: '#ref-1' }, '[ref-1, §2]'))).md, '[[ref-1, §2]]');
// br
assert.strictEqual(serializeInline(el('p', {}, 'a', el('br', {}), 'b')).md, 'a<br>b');
// v3.14.0 T8: the tail <br> Shift+Enter leaves at a surface end is not written
assert.strictEqual(serializeInline(el('p', {}, 'a', el('br', {}), el('br', { 'data-ed-tail': '1' }))).md, 'a<br>');
assert.strictEqual(serializeInline(el('p', {}, 'a', el('br', {}), 'b', el('br', { 'data-ed-tail': '1' }))).md, 'a<br>b');
assert.strictEqual(serializeInline(el('p', {}, el('strong', {}, 'a'), el('br', { 'data-ed-tail': '1' }), el('strong', {}, 'b'))).md, '**a**<!-- -->**b**');
// v3.14.0 T9: the reader's search mark is transparent; any other mark is not
assert.strictEqual(serializeInline(el('p', {}, 'a ', el('mark', { class: 'search-hit is-selected' }, 'b'), ' c')).md, 'a b c');
assert.deepStrictEqual(serializeInline(el('p', {}, 'a ', el('mark', {}, 'b'))).unsupported, ['MARK'], 'only the search mark is transparent');
{
  const mk = (tag, attrs) => serializeInline(el('p', {}, el('strong', {}, 'a'), el(tag, attrs, 'b'), el('strong', {}, 'c'))).md;
  assert.strictEqual(mk('mark', { class: 'search-hit' }), mk('span', {}), 'a search mark between two bold marks serializes like a bare span');
  assert.strictEqual(mk('mark', { class: 'search-hit' }), '**a**b**c**');
}
// escaping: backtick/asterisk/backslash always; underscore intraword NOT escaped
assert.strictEqual(escapeText('snake_case_id'), 'snake_case_id');
assert.strictEqual(escapeText('_lead and trail_'), '\\_lead and trail\\_');
assert.strictEqual(escapeText('a*b `c` d\\e'), 'a\\*b \\`c\\` d\\\\e');
assert.strictEqual(escapeText('x < y'), 'x &lt; y');
// unsupported detection
const withImg = el('p', {}, 'a', el('img', { src: 'x.png' }));
assert.deepStrictEqual(serializeInline(withImg).unsupported, ['IMG']);
assert.strictEqual(canWysiwyg(withImg), false);
assert.strictEqual(canWysiwyg(el('p', {}, 'plain ', el('strong', {}, 'ok'))), true);
// nested marks
assert.strictEqual(serializeInline(el('p', {}, el('strong', {}, el('em', {}, 'both')))).md, '***both***');

// --- normalization pre-approved for Tasks 3/5 (contenteditable DOM realities) ---
// bare <span> (no attributes) is transparent — unwraps to its children
assert.strictEqual(serializeInline(el('p', {}, el('span', {}, 'a '), el('strong', {}, 'b'), el('span', {}, ' c'))).md, 'a **b** c');
// <span style="..."> (or any attribute) is NOT transparent — unsupported
const withStyledSpan = el('p', {}, 'a', el('span', { style: 'color:red' }, 'b'));
assert.deepStrictEqual(serializeInline(withStyledSpan).unsupported, ['SPAN']);
assert.strictEqual(canWysiwyg(withStyledSpan), false);
// <div> boundary between siblings acts as <br>
assert.strictEqual(serializeInline(el('div', {}, el('div', {}, 'a'), el('div', {}, 'b'))).md, 'a<br>b');

// --- review fixes (2026-08-25): fence-length, bracket escaping, citation degrade, span probe ---

// CRITICAL 1: code content with a 2-backtick run needs a 3-backtick fence,
// not the previously-fixed 2-backtick fence (which corrupts the round-trip:
// the interior "``" prematurely closes a 2-backtick fence).
{
  const md = serializeInline(el('p', {}, el('code', {}, 'a``b'))).md;
  assert.strictEqual(md, '``` a``b ```');
  assert.strictEqual(marked.parseInline(md), '<code>a``b</code>');
}
// boundary-touching backtick (content starts with a backtick) — padding is
// not just cosmetic here, CommonMark requires it or the span fails to parse
// at all (verified: unpadded "```x``" does not parse as code).
{
  const md = serializeInline(el('p', {}, el('code', {}, '`x'))).md;
  assert.strictEqual(marked.parseInline(md), '<code>`x</code>');
}
// pre-existing single-interior-backtick case still round-trips (regression guard)
{
  const md = serializeInline(el('p', {}, el('code', {}, 'a`b'))).md;
  assert.strictEqual(md, '`` a`b ``');
  assert.strictEqual(marked.parseInline(md), '<code>a`b</code>');
}

// CRITICAL 2: escapeText must escape `]` unconditionally (mirrors `[`), or
// bracket pairing in link labels breaks.
assert.strictEqual(escapeText('[a]'), '\\[a\\]');
assert.strictEqual(escapeText('['), '\\[');
assert.strictEqual(escapeText(']'), '\\]');
// reviewer probe: a normal link whose label is itself "[text]" must still
// round-trip to a single working anchor (not `[[text]](<a...>` autolink debris).
{
  const md = serializeInline(el('p', {}, el('a', { href: 'http://x' }, '[text]'))).md;
  assert.strictEqual(marked.parseInline(md), '<a href="http://x">[text]</a>');
}
// reviewer probe: a near-citation (`#`-href but text isn't `[...]` exactly)
// must still round-trip to a working link.
{
  const md = serializeInline(el('p', {}, el('a', { href: '#note' }, '[abc] extra'))).md;
  assert.strictEqual(marked.parseInline(md), '<a href="#note">[abc] extra</a>');
}

// IMPORTANT 3: citation branch degrade-never-lose — if the anchor's children
// aren't exactly one text node, or the bracketed body itself contains `]`,
// md2doc's own citation regex ([^\]\n]+) can't re-parse it, so degrade to
// unsupported instead of emitting corrupt/unparseable citation syntax.
{
  // nested formatting inside the citation anchor: not a single text node
  const withFormattedCitation = el('p', {}, el('a', { href: '#note' }, el('em', {}, '[abc]')));
  const res = serializeInline(withFormattedCitation);
  assert.deepStrictEqual(res.unsupported, ['A']);
  assert.strictEqual(canWysiwyg(withFormattedCitation), false);
}
{
  // body contains a `]` between the outer brackets
  const withEmbeddedBracket = el('p', {}, el('a', { href: '#note' }, '[abc] and [def]'));
  const res = serializeInline(withEmbeddedBracket);
  assert.deepStrictEqual(res.unsupported, ['A']);
  assert.strictEqual(canWysiwyg(withEmbeddedBracket), false);
}
// still-good citation (single text node, no embedded `]`) keeps working
assert.strictEqual(serializeInline(el('p', {}, el('a', { href: '#ref-1' }, '[ref-1, §2]'))).md, '[[ref-1, §2]]');

// IMPORTANT 4: widen SPAN_ATTR_PROBE to realistic contenteditable attributes
{
  const withContentEditableSpan = el('p', {}, el('span', { contenteditable: 'false' }, 'x'));
  assert.deepStrictEqual(serializeInline(withContentEditableSpan).unsupported, ['SPAN']);
}
{
  const withDirSpan = el('p', {}, el('span', { dir: 'ltr' }, 'x'));
  assert.deepStrictEqual(serializeInline(withDirSpan).unsupported, ['SPAN']);
}

// --- strikethrough (DEL/S) + underline (U) marks ---

// DEL and S both serialize to GFM `~~...~~`, matching what marked itself
// emits for `~~x~~` (probed above the fix: marked.parseInline('~~b~~') ===
// '<del>b</del>') — the toolbar always creates DEL; S is accepted on input
// (e.g. some browsers' native strikethrough) but serializes identically.
assert.strictEqual(serializeInline(el('p', {}, el('del', {}, 'x'))).md, '~~x~~');
assert.strictEqual(serializeInline(el('p', {}, el('s', {}, 'x'))).md, '~~x~~');
assert.strictEqual(marked.parseInline(serializeInline(el('p', {}, el('del', {}, 'word'))).md), '<del>word</del>');

// U has no Markdown syntax and emits literal inline HTML by design — marked
// passes raw inline `<u>...</u>` straight through untouched.
assert.strictEqual(serializeInline(el('p', {}, el('u', {}, 'x'))).md, '<u>x</u>');
assert.strictEqual(marked.parseInline(serializeInline(el('p', {}, el('u', {}, 'word'))).md), '<u>word</u>');

// nested with bold, both directions
assert.strictEqual(serializeInline(el('p', {}, el('strong', {}, el('del', {}, 'x')))).md, '**~~x~~**');
assert.strictEqual(serializeInline(el('p', {}, el('del', {}, el('strong', {}, 'x')))).md, '~~**x**~~');
assert.strictEqual(serializeInline(el('p', {}, el('strong', {}, el('u', {}, 'x')))).md, '**<u>x</u>**');

// both marks are part of the supported set now (canWysiwyg stays true)
assert.strictEqual(canWysiwyg(el('p', {}, el('del', {}, 'x'), ' ', el('u', {}, 'y'))), true);

// escaping: every `~` is escaped unconditionally, so typing a literal
// "~~text~~" (no strikethrough intent) round-trips as plain text instead of
// silently becoming real strikethrough on the next render.
assert.strictEqual(escapeText('a~b'), 'a\\~b');
assert.strictEqual(escapeText('a~~b~~c'), 'a\\~\\~b\\~\\~c');
assert.strictEqual(marked.parseInline(escapeText('a~~b~~c')), 'a~~b~~c');
// a real toolbar-made DEL survives right next to escaped literal tildes in
// plain sibling text, without either bleeding into the other.
{
  const md = serializeInline(el('p', {}, 'a~~b~~c ', el('del', {}, 'd'), ' e~~f~~g')).md;
  assert.strictEqual(md, 'a\\~\\~b\\~\\~c ~~d~~ e\\~\\~f\\~\\~g');
  assert.strictEqual(marked.parseInline(md), 'a~~b~~c <del>d</del> e~~f~~g');
}

// ── spec §3.12: BR is two different things wearing the same tag ──────────
// The edit-mode renderer (lib/md2doc.js's renderer.br) marks a <br> that came
// from a markdown HARD BREAK; nothing else carries the marker. This module
// sees only the DOM, so the marker is the entire basis for telling them apart.
{
  // marked's own routing is what makes the marker possible at all, and it
  // holds only under `breaks: false` (pinned at lib/md2doc.js's setOptions).
  // Asserted here rather than assumed: if a future marked upgrade sent a
  // literal '<br>' through the br renderer, the marker would land on
  // Shift+Enter's breaks too and silently rewrite them.
  assert.deepStrictEqual(marked.lexer('x  \ny')[0].tokens.map((t) => t.type),
    ['text', 'br', 'text'], 'a hard break must lex as a `br` token');
  assert.deepStrictEqual(marked.lexer('x<br>y')[0].tokens.map((t) => t.type),
    ['text', 'html', 'text'], 'a literal <br> must lex as an `html` token, never `br`');

  // A marked <br> becomes a hard break in BACKSLASH form. Not two trailing
  // spaces: this module's output is subject to gate-compat.test.js's
  // assertNoTrailingWhitespace fossil (and list-md.js trims every line it
  // emits), so the space form cannot be emitted at all — see §3.12.
  const hard = serializeInline(el('p', {}, 'a', el('br', { 'data-hard-break': '1' }), 'b')).md;
  assert.strictEqual(hard, 'a\\\nb');
  assert.deepStrictEqual(hard.split('\n').map((l) => l.replace(/[ \t]+$/, '')), hard.split('\n'),
    'no emitted line may end in whitespace — the reason the space form is unavailable');
  // …and it comes back as a hard break, not as a literal backslash.
  assert.deepStrictEqual(marked.lexer(hard)[0].tokens.map((t) => t.type),
    ['text', 'br', 'text'], 'the emitted backslash form must re-lex as a hard break');

  // An UNMARKED <br> keeps emitting the literal '<br>' it always did. This is
  // the Shift+Enter round-trip contract (a browser-inserted <br> carries no
  // marker), the hand-written-'<br>'-in-source contract, and the Chromium
  // placeholder <br> left behind when a surface's last character is deleted —
  // all three are the same code path and none of them may move.
  assert.strictEqual(serializeInline(el('p', {}, 'a', el('br', {}), 'b')).md, 'a<br>b');
  // an explicit "not a hard break" attribute value is not a hard break either
  assert.strictEqual(
    serializeInline(el('p', {}, 'a', el('br', { 'data-hard-break': '0' }), 'b')).md, 'a<br>b');
  // and the literal form still round-trips to a <br> in the rendered HTML
  assert.strictEqual(marked.parseInline('a<br>b'), 'a<br>b');
}

// ── v3.4.0 / backlog 3 (Ruling T6-7): star-delimiter boundary guard ──────
// v3.3.0 measured this live and deliberately shipped no test for it: pinning
// the wrong bytes of the day would have gone red on the real fix for the
// wrong reason (see `walkChildren`'s own comment block in inline-md.js).
// This pins the SAME-TAG shapes measured in task-8's report and the fixed
// output — same-tag adjacency (EM-then-EM, STRONG-then-STRONG) is exactly
// the case that must still insert `<!-- -->`; see further down for the
// cross-tag fix-round regression (must NOT insert).
{
  // Canonical repro: a selection ending right at `*`code`*`'s own boundary,
  // immediately followed (no separating text) by another EM. Before the fix
  // this serialized to `*`code`**text*` — the touching `*`+`*` fuse into one
  // length-2 run, marked hands it to STRONG-pairing instead, and the FIRST
  // <em> is dropped entirely (round-trips back as two literal '*' characters
  // flanking the code span, not italics).
  const shape = el('p', {}, el('em', {}, el('code', {}, 'code')), el('em', {}, 'text'));
  const md = serializeInline(shape).md;
  assert.strictEqual(md, '*`code`*<!-- -->*text*',
    '定界符相鄰的選取不得產生互相吞併的 `*` 定界符跑');
  assert.strictEqual(marked.parseInline(md), '<em><code>code</code></em><!-- --><em>text</em>');

  // STRONG-next-to-STRONG collapses the same way without the guard
  // (`**a****b**` reparses as one <strong> swallowing the literal `****`).
  const strongStrong = serializeInline(
    el('p', {}, el('strong', {}, 'a'), el('strong', {}, 'b'))).md;
  assert.strictEqual(strongStrong, '**a**<!-- -->**b**');
  assert.strictEqual(marked.parseInline(strongStrong), '<strong>a</strong><!-- --><strong>b</strong>');

  // Regression guard: no false trigger when nothing touches. Nested
  // STRONG>EM ('***both***', line ~40 above) must stay untouched — the
  // guard only fires between SIBLINGS, never between a wrapper and its own
  // first child, and a lone mark with no preceding '*' emits no comment.
  assert.strictEqual(serializeInline(el('p', {}, el('strong', {}, el('em', {}, 'both')))).md,
    '***both***');
  assert.strictEqual(serializeInline(el('p', {}, 'a ', el('em', {}, 'x'), ' c')).md, 'a *x* c');
}

// ── review Minor 1: no false trigger on an ESCAPED trailing star ─────────
// A literal '*' the user typed (escaped by escapeText() to "\*") followed
// directly by a toggled EM is, if anything, a MORE everyday gesture than two
// marks landing DOM-adjacent — and it already round-tripped correctly
// without any guard, so inserting `<!-- -->` there would be pure waste.
// (This was originally fixed with a backslash-parity regex on the trailing
// character; the fix-round rewrite below replaced that with `lastMarkTag`
// tag-tracking, which resolves the same false trigger as a side effect —
// see `walkChildren`'s own comment block — without needing a regex at all:
// a TEXT node always resets `lastMarkTag` to null when it contributes any
// characters, since escapeText() never leaves a live trailing '*' behind.
// These assertions are unchanged; only the mechanism underneath moved.)
{
  const md = serializeInline(el('p', {}, 'a*', el('em', {}, 'x'))).md;
  assert.strictEqual(md, 'a\\**x*',
    '一個轉義過的字面星號後面直接接 EM，不該插入用不到的 <!-- -->');
  assert.ok(md.indexOf('<!--') === -1, '轉義的 \\* 不是活的定界符，不該觸發守衛');
  assert.strictEqual(marked.parseInline(md), 'a*<em>x</em>');

  // one literal backslash + one literal star, both escaped by escapeText()
  // (odd number of backslashes ends up in front of the star's own escaping
  // backslash — still not live).
  const md2 = serializeInline(el('p', {}, 'a\\*', el('em', {}, 'x'))).md;
  assert.ok(md2.indexOf('<!--') === -1,
    '一個逃脫的反斜線加一個逃脫的星號，星號仍然不是活的，不該觸發守衛');
  assert.strictEqual(marked.parseInline(md2), 'a\\*<em>x</em>');

  // two EM nodes DOM-adjacent (not a text node's escaped star) is the real
  // bug shape — same-tag, the guard must still fire here.
  const shapeStillGuarded = el('p', {},
    el('em', {}, el('code', {}, 'code')), el('em', {}, 'text'));
  assert.ok(serializeInline(shapeStillGuarded).md.indexOf('<!-- -->') !== -1,
    '兩個真正相鄰、同 tag 的 EM 定界符仍然要觸發守衛');
}

// ── fix-round regression (editor-journey.test.js:1165): CROSS-tag adjacency
// must NOT be guarded ─────────────────────────────────────────────────────
// The first version of this fix guarded on ANY trailing '*', regardless of
// which tag produced it. That over-inserted for `<em>it</em>` immediately
// followed by `<strong><em>al</em> bold</strong>` (EM's closing 1 star
// touching STRONG's opening 2+1 stars) — already-correct output
// `*it****al* bold**` gained a needless `<!-- -->`, changing bytes a
// journey scenario had pinned. A 100-context sweep (5 front contexts × 5
// back contexts × {em-em, strong-strong, em-strong, strong-em}) measured:
// same-tag breaks 50/50 without a guard, cross-tag is correct 50/50
// WITHOUT one. The fix distinguishes them via `lastMarkTag` (see
// `walkChildren`): only fires when the tag about to open matches the tag
// that most recently closed at this sibling level.
{
  // the exact journey shape, reduced to its DOM: EM(it) directly followed
  // by STRONG wrapping [EM(al), ' bold'] — cross-tag (EM, then STRONG).
  const journeyShape = el('p', {}, 'Alpha ',
    el('em', {}, 'it'),
    el('strong', {}, el('em', {}, 'al'), ' bold'),
    ' text here.');
  const journeyMd = serializeInline(journeyShape).md;
  assert.strictEqual(journeyMd, 'Alpha *it****al* bold** text here.',
    '跨 tag 相鄰（EM 接 STRONG）本來就正確，不該被守衛插入 <!-- -->');
  assert.strictEqual(marked.parseInline(journeyMd),
    'Alpha <em>it</em><strong><em>al</em> bold</strong> text here.');

  // both directions of simple cross-tag adjacency, no nesting involved.
  const emThenStrong = serializeInline(
    el('p', {}, el('em', {}, 'a'), el('strong', {}, 'b'))).md;
  assert.strictEqual(emThenStrong, '*a***b**');
  assert.strictEqual(marked.parseInline(emThenStrong), '<em>a</em><strong>b</strong>');

  const strongThenEm = serializeInline(
    el('p', {}, el('strong', {}, 'a'), el('em', {}, 'b'))).md;
  assert.strictEqual(strongThenEm, '**a***b*');
  assert.strictEqual(marked.parseInline(strongThenEm), '<strong>a</strong><em>b</em>');

  // same-tag adjacency must still be caught (the regression fix must not
  // have swung the other way and stopped guarding the real bug).
  const emThenEm = serializeInline(
    el('p', {}, el('em', {}, 'a'), el('em', {}, 'b'))).md;
  assert.strictEqual(emThenEm, '*a*<!-- -->*b*');
  assert.strictEqual(marked.parseInline(emThenEm), '<em>a</em><!-- --><em>b</em>');

  const strongThenStrong = serializeInline(
    el('p', {}, el('strong', {}, 'a'), el('strong', {}, 'b'))).md;
  assert.strictEqual(strongThenStrong, '**a**<!-- -->**b**');
  assert.strictEqual(marked.parseInline(strongThenStrong),
    '<strong>a</strong><!-- --><strong>b</strong>');
}

// ── review Minor 2: the guard's `<!-- -->` must not accumulate on re-save
// ──────────────────────────────────────────────────────────────────────
// This is the load-bearing argument for accepting `<!-- -->` as the fix at
// all: a comment node this guard emits gets read back by marked's own
// parser as an actual DOM comment (nodeType 8) sitting between the two
// marks on the NEXT edit session. walkChildren() only ever handles
// nodeType 3 (text) and nodeType 1 (element) and silently skips everything
// else, so that leftover comment contributes nothing to `out` and leaves
// `lastMarkTag` untouched (fix-round rewrite: the guard now keys off
// `lastMarkTag`, not the trailing character of `out`, but the same
// "zero-contribution nodes don't reset state" property is what makes this
// idempotent either way) — the guard re-evaluates the same boundary and
// reinserts exactly one `<!-- -->`, not two. Proven here by building the
// DOM the SECOND save would actually see (comment node already present)
// and asserting the output is BYTE-IDENTICAL to the first save's output —
// not just "still parses", but the exact same string, which is what rules
// out linear growth across edit sessions.
{
  const freshShape = el('p', {}, el('em', {}, el('code', {}, 'code')), el('em', {}, 'text'));
  const freshMd = serializeInline(freshShape).md;
  assert.strictEqual(freshMd, '*`code`*<!-- -->*text*');

  // nodeType 8 = COMMENT_NODE; walkChildren() never reads its attributes or
  // textContent (it hits the `node.nodeType !== 1` skip before either would
  // matter), so an empty stub is enough to stand in for a real DOM comment.
  const staleComment = { nodeType: 8, textContent: '' };
  const shapeAfterOneRoundTrip = el('p', {},
    el('em', {}, el('code', {}, 'code')), staleComment, el('em', {}, 'text'));
  const mdAfterOneRoundTrip = serializeInline(shapeAfterOneRoundTrip).md;
  assert.strictEqual(mdAfterOneRoundTrip, freshMd,
    '已經帶著上一輪守衛留下的 comment node 的 DOM，重新序列化必須跟乾淨的 DOM 產生逐位元組相同的輸出——否則每編輯一次就多一個註解');

  // two stale comments in a row (a hypothetical worse accumulation) must
  // still collapse to the same single-comment output — the guard is keyed
  // off the trailing character of `out`, not off how many comment nodes it
  // walks past, so any number of leftover comments between the same two
  // marks converges to the same fixed point.
  const shapeWithTwoStaleComments = el('p', {},
    el('em', {}, el('code', {}, 'code')), staleComment, staleComment, el('em', {}, 'text'));
  assert.strictEqual(serializeInline(shapeWithTwoStaleComments).md, freshMd);
}

// v3.11: a RAW HTML anchor — `<a id="ref-x"></a>`, no href attribute at all —
// is not a markdown link. It used to come out as '[]()', which erased the
// anchor the moment the block was edited (measured on mac-tx-core's 21
// reference items). It is unsupported now, so the block falls back to the
// source box instead of being rewritten. An EMPTY href is still a link:
// '[x]()' renders as <a href="">.
{
  const anchor = el('p', {}, el('a', { id: 'ref-x' }), 'RFC 2863');
  const res = serializeInline(anchor);
  assert.deepStrictEqual(res.unsupported, ['A'], 'a raw anchor is unsupported');
  assert.strictEqual(canWysiwyg(anchor), false, 'so the block is never rewritten in place');
  assert.strictEqual(serializeInline(el('p', {}, el('a', { href: '' }, 'x'))).md, '[x]()',
    'an empty href is still a markdown link');
}

// v3.13.1 T2 (F-1): a block marker at the start of a line is escaped, so a
// paragraph or item whose text begins with `## `, `- `, `> `, `1. ` (…) stays
// that block on the next render. Input is escapeText() output.
{
  const rows = [
    ['## Title', '\\## Title', 'ATX heading'],
    ['#', '\\#', 'empty heading'],
    ['#Title', '#Title', 'no space, not a heading'],
    ['####### x', '####### x', 'seven #, not a heading'],
    ['- item', '\\- item', 'bullet'],
    ['-', '\\-', 'lone dash, setext underline'],
    ['-5 dBm', '-5 dBm', 'not a marker; must stay byte-stable'],
    ['+ x', '\\+ x', 'bullet'],
    ['> q', '\\> q', 'blockquote'],
    ['>q', '\\>q', 'blockquote needs no space'],
    ['1. x', '1\\. x', 'ordered'],
    ['1) x', '1\\) x', 'ordered'],
    ['1.5 V', '1.5 V', 'not a marker'],
    ['---', '\\---', 'thematic break'],
    ['===', '\\===', 'setext underline'],
    ['| a | b |', '\\| a | b |', 'pipe at line start'],
    ['   ## x', '   \\## x', '<= 3 spaces of indent'],
    ['a\\\n## b', 'a\\\n\\## b', 'after a hard break'],
    ['a\n- b', 'a\n\\- b', 'lazy continuation line'],
    ['\\## x', '\\## x', 'already escaped stays'],
    ['Alpha ## not start', 'Alpha ## not start', 'mid-line'],
    ['-- -', '\\-- -', 'spaced-dash thematic break'],
    ['-- - -', '\\-- - -', 'spaced-dash thematic break'],
    ['----  -', '\\----  -', 'spaced-dash thematic break'],
    ['a\n-- -', 'a\n\\-- -', 'spaced-dash break after a paragraph line'],
    ['- -- -', '\\- -- -', 'bullet rule first'],
    ['-- x', '-- x', 'dashes then a word: not a marker'],
  ];
  rows.forEach(([input, want, why]) => {
    assert.strictEqual(escapeBlockStarts(input), want, why + ': ' + JSON.stringify(input));
  });
}

// v3.15.0 T5: the URL field's href normaliser and the paste-a-URL test.
assert.strictEqual(normalizeHref('  example.com/a b '), 'https://example.com/a%20b');
assert.strictEqual(normalizeHref('https://x.y/(a)'), 'https://x.y/%28a%29');
assert.strictEqual(normalizeHref('#sec-2'), '#sec-2');
assert.strictEqual(normalizeHref('./doc.md'), './doc.md');
assert.strictEqual(normalizeHref('../doc.md'), '../doc.md');
assert.strictEqual(normalizeHref('/abs/doc.md'), '/abs/doc.md');
assert.strictEqual(normalizeHref('mailto:a@b.c'), 'mailto:a@b.c');
assert.strictEqual(normalizeHref('   '), '');
assert.strictEqual(normalizeHref('https://x.y/<a>'), 'https://x.y/%3Ca%3E');
assert.strictEqual(isPastedUrl(' https://x.y/a\n'), true);
assert.strictEqual(isPastedUrl('see https://x.y'), false);
assert.strictEqual(isPastedUrl('ftp://x.y'), false);
assert.strictEqual(isPastedUrl('https://x.y a'), false);

// v3.17.0 T7 (D17): the image paragraph parser and the alt / path rewriter.
{
  const { parseImageParagraph: p, rewriteImage: rw } = require('../lib/editor/inline-md.js');
  assert.deepStrictEqual(p('![chip top](assets/chip_top.png)'), { alt: 'chip top', dest: 'assets/chip_top.png', title: null, angle: false });
  assert.deepStrictEqual(p('  ![a \\] b](<my pic.png> "T")  '), { alt: 'a ] b', dest: 'my pic.png', title: '"T"', angle: true });
  assert.deepStrictEqual(p("![](x.png 'T U')"), { alt: '', dest: 'x.png', title: "'T U'", angle: false });
  assert.deepStrictEqual(p('![a](x.png (T))'), { alt: 'a', dest: 'x.png', title: '(T)', angle: false });
  assert.deepStrictEqual(p('![a](x_(1).png)'), { alt: 'a', dest: 'x_(1).png', title: null, angle: false });
  assert.strictEqual(p('see ![a](x.png)'), null);
  assert.strictEqual(p('![a](x.png) ![b](y.png)'), null);
  assert.strictEqual(p('![a](x.png) tail'), null);
  assert.strictEqual(p('[![a](x.png)](http://e)'), null);
  assert.strictEqual(p('![a][ref]'), null);
  assert.strictEqual(p('![a](x.png'), null);
  assert.strictEqual(p('![a](x.png "T)'), null);
  assert.strictEqual(p('plain text'), null);
  assert.strictEqual(p(''), null);
  assert.strictEqual(rw('![a](x.png "T")', { dest: 'assets/y.png' }), '![a](assets/y.png "T")');
  assert.strictEqual(rw('![a](x.png "T")', { alt: 'p [q]' }), '![p \\[q\\]](x.png "T")');
  assert.strictEqual(rw("  ![a](x.png 'T')", { alt: 'b' }), "  ![b](x.png 'T')");
  assert.strictEqual(rw('![a](<my pic.png> "T")', { dest: 'assets/dot.png' }), '![a](assets/dot.png "T")');
  // v3.17.3 A3 (was '![b\\\\c](x.png)  '): a backslash in the alt is written as a
  // character reference, because marked renders `\\` in an alt as two backslashes.
  // v3.17.4 E1: any `&name;` goes through the installed decoder; numerics need none.
  {
    const im = require('../lib/editor/inline-md.js');
    assert.strictEqual(p('![a &copy; b](x.png)').alt, 'a &copy; b', 'no decoder: an unknown name stays literal');
    assert.strictEqual(p('![a &lt; &amp; &quot;](x.png)').alt, 'a < & "', 'no decoder: the six names still decode');
    assert.strictEqual(p('![&#169; &#xA9;](x.png)').alt, '\u00a9 \u00a9', 'numeric references decode');
    im.setNamedReferenceDecoder((n) => ({ copy: '\u00a9' })[n]);
    try {
      assert.strictEqual(p('![a &copy; b](x.png)').alt, 'a \u00a9 b');
      assert.strictEqual(p('![a &nope; b](x.png)').alt, 'a &nope; b', 'a name the decoder does not know stays literal');
      assert.strictEqual(rw('![a](x.png)', { alt: 'a \u00a9 b' }), '![a \u00a9 b](x.png)', 'the character is written as is');
    } finally { im.setNamedReferenceDecoder(null); }
    assert.strictEqual(p('![a &copy; b](x.png)').alt, 'a &copy; b', 'reset restores the default');
  }
  assert.strictEqual(rw('![a](x.png)  ', { alt: 'b\\c' }), '![b&#92;c](x.png)  ');
  assert.strictEqual(rw('![a](x.png)', {}), '![a](x.png)');
  assert.strictEqual(rw('not an image', { alt: 'z' }), 'not an image');
  // The alt a rewrite writes reads back as typed.
  assert.strictEqual(p(rw('![a](x.png)', { alt: 'p [q] \\ r' })).alt, 'p [q] \\ r');
  // v3.17.3 A3: the alt a rewrite writes renders, in marked, as an <img> whose
  // alt attribute (entities decoded, as a browser reads it) is what was typed,
  // and parses back to what was typed.
  const attrDecode = (t) => t.replace(/&(quot|amp|lt|gt|#x[0-9a-f]+|#[0-9]+);/gi, (m, n) => (
    n[0] === '#' ? String.fromCodePoint(n[1].toLowerCase() === 'x' ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10))
      : { quot: '"', amp: '&', lt: '<', gt: '>' }[n]));
  for (const x of ['a`b', 'a&amp;b', 'x\\y', 'a]b', '中文*斜*', 'a&b', 'p [q] \\ r', 'x\\', 'a\\*b', '`', 'a&#96;b']) {
    const src = rw('![old](assets/a.png "T")', { alt: x });
    const html = marked.parse(src);
    const m = /^<p><img src="assets\/a\.png" alt="([^"]*)" title="T"><\/p>\s*$/.exec(html);
    assert.ok(m, 'alt ' + JSON.stringify(x) + ' must still render as one image, got ' + JSON.stringify(src) + ' -> ' + JSON.stringify(html));
    assert.strictEqual(attrDecode(m[1]), x, 'rendered alt of ' + JSON.stringify(src));
    assert.strictEqual(p(src).alt, x, 'parse back of ' + JSON.stringify(src));
  }
  // Final review M2 (R25 / R7): a character reference in a source alt is read
  // the way the reader shows it — numeric (decimal, hex) and the named ones
  // amp, lt, gt, quot, apos, nbsp — and the field's text, written back, renders
  // to that same text. An unknown name stays as written.
  const shown = (t) => t.replace(/&(quot|amp|lt|gt|apos|nbsp|#x[0-9a-f]+|#[0-9]+);/gi, (m, n) => (
    n[0] === '#' ? String.fromCodePoint(n[1].toLowerCase() === 'x' ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10))
      : { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: '\u00a0' }[n.toLowerCase()]));
  for (const [srcAlt, field] of [['a &lt; b', 'a < b'], ['&gt;&quot;&apos;', '>"\''], ['x&nbsp;y', 'x\u00a0y'],
    ['&#65;&#x42;&#X43;', 'ABC'], ['a&amp;lt;b', 'a&lt;b'], ['&bogus; &lt', '&bogus; &lt'], ['a&#96;b &#92;', 'a`b \\']]) {
    const src = '![' + srcAlt + '](assets/a.png "T")';
    const before = /alt="([^"]*)"/.exec(marked.parse(src));
    assert.strictEqual(shown(before[1]), field, 'guard: the reader shows ' + JSON.stringify(field) + ' for ' + JSON.stringify(src));
    assert.strictEqual(p(src).alt, field, 'v3173 M2: the field shows the reader\'s alt for ' + JSON.stringify(src));
    const out = rw(src, { alt: p(src).alt + ' x' });
    const after = /^<p><img src="assets\/a\.png" alt="([^"]*)" title="T"><\/p>\s*$/.exec(marked.parse(out));
    assert.ok(after, 'still one image: ' + JSON.stringify(out));
    assert.strictEqual(shown(after[1]), field + ' x', 'v3173 M2: written ' + JSON.stringify(out) + ' renders the field\'s text');
  }
}

// v3.17.5 M1 + R1: a mark's delimiters must be ones CommonMark accepts. An
// opening run is only left-flanking when the character after it is not
// whitespace and, if it is punctuation (marked: \p{P}\p{S}), the character
// before it is whitespace, punctuation or the start; the closing run mirrors
// that. Measured on 4d7669f: `alpha ** charlie** delta` (Delete down to a
// leading space), `前面**「引號」**後面` (Ctrl+B on 「引號」) and
// `alpha **charlie **delta` all render their asterisks literally.
//
// The oracle is the reader's own marked: requiring lib/md2doc.js installs its
// extensions (sub/superscript, KaTeX) on the shared instance, so this block
// sits last in the file and nothing above it sees them.
{
  require('../lib/md2doc.js');
  const reader = (md) => marked.parse(md).trim().replace(/^<p>|<\/p>$/g, '');
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
  const shownText = (h) => h.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, (m, n) => ENT[n])
    .replace(/\s+/g, ' ');
  const p = (...kids) => el('p', {}, ...kids);
  const hb = () => el('br', { 'data-hard-break': '1' });
  // nodes -> exact bytes, and the reader must show `want` (an HTML fragment)
  // and exactly the editor's own text: a delimiter the reader did not take
  // shows up as an extra character.
  function edge(name, nodes, bytes, want) {
    const root = p(...nodes);
    const md = serializeInline(root).md;
    assert.strictEqual(md, bytes, 'v3175 M1 ' + name + ': bytes');
    const out = reader(md);
    assert.strictEqual(shownText(out), root.textContent.replace(/\s+/g, ' '),
      'v3175 M1 ' + name + ': the reader shows other text than the editor, ' + JSON.stringify(out));
    assert.ok(out.includes(want), 'v3175 M1 ' + name + ': ' + JSON.stringify(out) + ' lacks ' + JSON.stringify(want));
  }
  // whitespace edges move outside the delimiters, byte for byte
  edge('leading space', ['alpha ', el('strong', {}, ' charlie'), ' delta'], 'alpha  **charlie** delta', '<strong>charlie</strong>');
  edge('leading space, no space before', ['alpha', el('strong', {}, ' charlie'), ' delta'], 'alpha **charlie** delta', 'alpha <strong>charlie</strong> delta');
  edge('trailing space', ['alpha ', el('strong', {}, 'charlie '), 'delta'], 'alpha **charlie** delta', 'alpha <strong>charlie</strong> delta');
  edge('em both sides', ['a', el('em', {}, ' x '), 'b'], 'a *x* b', 'a <em>x</em> b');
  edge('del leading', ['a', el('del', {}, ' x'), 'b'], 'a ~~x~~b', 'a <del>x</del>b');
  edge('nested strong>em', ['a', el('strong', {}, el('em', {}, ' x')), 'b'], 'a ***x***b', '<em><strong>x</strong></em>');
  edge('nbsp', ['a', el('strong', {}, ' x'), 'b'], 'a **x**b', '<strong>x</strong>');
  edge('ideographic space', ['前', el('strong', {}, '中文　'), '後'], '前**中文**　後', '<strong>中文</strong>');
  edge('trailing hard break', ['a ', el('strong', {}, 'x', hb()), 'b'], 'a **x**\\\nb', '<strong>x</strong><br>');
  edge('several spaces', ['a', el('strong', {}, '  x  '), 'b'], 'a  **x**  b', '<strong>x</strong>');
  // a mark holding only whitespace (or nothing) is no mark at all
  edge('whitespace only', ['a', el('strong', {}, ' '), 'b'], 'a b', 'a b');
  assert.strictEqual(serializeInline(p('a', el('strong', {}), 'b')).md, 'ab', 'v3175 M1: an empty mark writes nothing');
  assert.strictEqual(serializeInline(p('a', el('em', {}, el('strong', {}, ' ')), 'b')).md, 'a b', 'v3175 M1: nested whitespace-only marks write only the space');
  // punctuation edges next to a word character get `<!-- -->` on that side only
  edge('cjk brackets', ['前面', el('strong', {}, '「引號」'), '後面'], '前面<!-- -->**「引號」**<!-- -->後面', '<strong>「引號」</strong>');
  edge('cjk full stop', [el('strong', {}, '中文。'), '後面'], '**中文。**<!-- -->後面', '<strong>中文。</strong>');
  edge('colon label', [el('strong', {}, '注意：'), '請看'], '**注意：**<!-- -->請看', '<strong>注意：</strong>');
  edge('symbol', ['x', el('strong', {}, '$5'), 'y'], 'x<!-- -->**$5**y', '<strong>$5</strong>');
  edge('em punct', ['a', el('em', {}, '中文。'), '後'], 'a*中文。*<!-- -->後', '<em>中文。</em>');
  edge('escaped star head', ['a', el('strong', {}, '*x'), 'b'], 'a<!-- -->**\\*x**b', '<strong>*x</strong>');
  edge('escaped star tail', ['a', el('strong', {}, 'x*'), 'b'], 'a**x\\***<!-- -->b', '<strong>x*</strong>');
  edge('nested run guarded outside', ['a', el('em', {}, el('strong', {}, '「x」')), 'b'], 'a<!-- -->***「x」***<!-- -->b', '<strong>「x」</strong>');
  edge('across a bare span', [el('span', {}, el('strong', {}, '中文。')), '後'], '**中文。**<!-- -->後', '<strong>中文。</strong>');
  edge('across a bare span, opening', ['前', el('span', {}, el('strong', {}, '「x」'))], '前<!-- -->**「x」**', '<strong>「x」</strong>');
  // ...and nothing where the neighbour already satisfies the rule
  edge('punct neighbours', ['「', el('strong', {}, '引號'), '」'], '「**引號**」', '<strong>引號</strong>');
  edge('space neighbours', ['前面 ', el('strong', {}, '「x」'), ' 後面'], '前面 **「x」** 後面', '<strong>「x」</strong>');
  edge('line ends', [el('strong', {}, '「x」')], '**「x」**', '<strong>「x」</strong>');
  edge('word edges', ['x', el('strong', {}, '中'), 'y'], 'x**中**y', '<strong>中</strong>');
  edge('del punct', ['a', el('del', {}, '「x」'), 'b'], 'a~~「x」~~b', '<del>「x」</del>');
  edge('next to a link', [el('strong', {}, 'x。'), el('a', { href: 'http://x' }, 'lnk')], '**x。**[lnk](http://x)', '<strong>x。</strong><a');
  // final review I1: a closing run touching the next mark's opening run fuses
  // with it, so the character outside each is the one inside the other
  edge('cross-tag fused, punct closes', [el('strong', {}, '注意：'), el('em', {}, '斜體')], '**注意：**<!-- -->*斜體*', '<strong>注意：</strong><!-- --><em>斜體</em>');
  edge('cross-tag fused, em first', [el('em', {}, '注意：'), el('strong', {}, '粗體')], '*注意：*<!-- -->**粗體**', '<em>注意：</em><!-- --><strong>粗體</strong>');
  // ...but not the opening side: once the left run has closed, marked sees a
  // `*` (punctuation) before what is left of the run
  edge('cross-tag fused, punct opens', [el('strong', {}, '粗'), el('em', {}, '「x」')], '**粗***「x」*', '<strong>粗</strong><em>「x」</em>');
  edge('cross-tag fused, punct both', [el('strong', {}, '「a」'), el('em', {}, '「b」')], '**「a」***「b」*', '<strong>「a」</strong><em>「b」</em>');
  // final review I2: marked reads the character before an opening run as one
  // UTF-16 unit, so an astral symbol there counts as a word character
  edge('emoji before', ['📌', el('strong', {}, '「重點」'), '請看'], '📌<!-- -->**「重點」**<!-- -->請看', '<strong>「重點」</strong>');
  edge('emoji after', [el('strong', {}, '「x」'), '😀'], '**「x」**😀', '<strong>「x」</strong>');
  // the same-tag guard (v3.4.0) is untouched, and a hoisted space replaces it
  edge('same-tag guard', [el('strong', {}, 'a'), el('strong', {}, 'b')], '**a**<!-- -->**b**', '<strong>a</strong><!-- --><strong>b</strong>');
  edge('same-tag, space between', [el('strong', {}, 'a'), el('strong', {}, ' b')], '**a** **b**', '<strong>a</strong> <strong>b</strong>');
}

// v3.17.7: what the reader shows must be what the editor held, mark for mark.
//
// marksOf() flattens either side to one entry per non-space character: the
// character plus the sorted set of S(trong) / E(m) / D(el) around it; a code
// span is one entry holding its whole text. Whitespace is left out because
// splitEdges() moves it across a delimiter on purpose, and <br> because a
// hard break is checked by its own rows above.
{
  const reader = (md) => marked.parseInline(md);
  const p = (...kids) => el('p', {}, ...kids);
  const hb = () => el('br', { 'data-hard-break': '1' });
  const MARK = { STRONG: 'S', B: 'S', EM: 'E', I: 'E', DEL: 'D', S: 'D' };
  function domMarks(node, marks, out) {
    if (node.nodeType === 3) {
      for (const ch of node.textContent) if (!/\s/.test(ch)) out.push(ch + '[' + marks + ']');
      return out;
    }
    if (node.nodeName === 'CODE') { out.push('`' + node.textContent.replace(/\s+/g, '') + '[' + marks + ']'); return out; }
    // a citation is written `[[body]]`, and since v3.17.9 the reader's marked
    // (this block runs after lib/md2doc.js installed its `citation` extension)
    // shows it as the anchor the editor held, `[body]`. Before, the citation
    // was a text pre-pass outside marked and this oracle read `[[body]]`.
    if (node.nodeName === 'A' && /^#/.test(node.getAttribute('href') || '') && /^\[.*\]$/.test(node.textContent)) {
      for (const ch of node.textContent) out.push(ch + '[' + marks + ']');
      return out;
    }
    const k = MARK[node.nodeName];
    const next = k && marks.indexOf(k) === -1 ? (marks + k).split('').sort().join('') : marks;
    for (const c of node.childNodes) domMarks(c, next, out);
    return out;
  }
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
  function htmlMarks(h) {
    const out = []; const open = []; let code = null; let m;
    const re = /<!--[\s\S]*?-->|<(\/?)([a-z]+)\b[^>]*>|&(amp|lt|gt|quot|#39);|([^<&]+|[<&])/g;
    const cur = () => [...new Set(open)].sort().join('');
    while ((m = re.exec(h))) {
      if (m[0].startsWith('<!--')) continue;
      if (m[2]) {
        if (m[2] === 'code') {
          if (m[1]) { out.push('`' + code.replace(/\s+/g, '') + '[' + cur() + ']'); code = null; } else code = '';
          continue;
        }
        const k = { strong: 'S', em: 'E', del: 'D' }[m[2]];
        if (!k) continue;
        if (m[1]) open.splice(open.lastIndexOf(k), 1); else open.push(k);
        continue;
      }
      const t = m[3] ? ENT[m[3]] : m[4];
      if (code !== null) { code += t; continue; }
      for (const ch of t) if (!/\s/.test(ch)) out.push(ch + '[' + cur() + ']');
    }
    return out;
  }
  function readsBack(name, root, bytes) {
    const md = serializeInline(root).md;
    if (bytes !== undefined) assert.strictEqual(md, bytes, 'v3177 ' + name + ': bytes');
    assert.strictEqual(htmlMarks(reader(md)).join(''), domMarks(root, '', []).join(''),
      'v3177 ' + name + ': the reader shows other marks than the editor held; md ' +
      JSON.stringify(md) + ' reads ' + JSON.stringify(reader(md)));
    return md;
  }

  // N2: two strikethroughs side by side get the same guard two bolds do.
  // Measured on 71fedaa (strike `two` after `~~one~~` in the editor):
  // `~~one~~~~two~~` reads `<del>one~~~~two</del>`.
  readsBack('adjacent del', p('Alpha ', el('del', {}, 'one'), el('del', {}, 'two'), ' three.'),
    'Alpha ~~one~~<!-- -->~~two~~ three.');
  readsBack('adjacent del, space between', p(el('del', {}, 'a'), el('del', {}, ' b')), '~~a~~ ~~b~~');
  readsBack('del then bold', p(el('del', {}, 'a'), el('strong', {}, 'b')), '~~a~~**b**');
  // N3: two code spans side by side. On 71fedaa (inline-code on `two` after
  // `` `one` ``) the file got `` `one``two` ``: one code span, "one``two".
  readsBack('adjacent code', p('Alpha ', el('code', {}, 'one'), el('code', {}, 'two'), ' three.'),
    'Alpha `one`<!-- -->`two` three.');
  readsBack('adjacent code, fenced', p(el('code', {}, 'a`b'), el('code', {}, 'c')), '`` a`b ``<!-- -->`c`');

  // N1: a mark nested in another `*` mark whose runs marked's emphasis scan
  // miscounts. Each row is the shape a real gesture produced on 71fedaa
  // (toolbar over a random range), with the bytes it wrote then.
  //   *`c`**i**tal*                     -> em lost, stars literal
  readsBack('bold inside em after code', p('Alpha ', el('em', {}, el('code', {}, 'c'), el('strong', {}, 'i'), 'tal'), ' bold'),
    'Alpha *`c`__i__<!-- -->tal* bold');
  //   前面「引號<!-- -->*」**粗**後面，中文*。 -> em lost
  readsBack('bold inside em after a bracket', p('前面「引號', el('em', {}, '」', el('strong', {}, '粗'), '後面，中文'), '。'));
  //   *~~a**a**~~*  and  *~~**,中**~~*   (del between the two `*` marks)
  readsBack('bold in del in em', p(el('em', {}, el('del', {}, 'a', el('strong', {}, 'a')))));
  readsBack('punct bold in del in em', p('x ', el('em', {}, el('del', {}, el('strong', {}, ',中'))), ' y'));
  readsBack('em in bold, both inner bolds', p(el('em', {}, el('strong', {}, 'a'), el('strong', {}, el('code', {}, 'c')))));

  // Final review: the check must not be fooled by a neighbour. Each of these
  // held the repair off on a3255f5 (the reader showed `*` and lost the em):
  //   text whose second character is `!` was skipped as if it were `<!--`;
  //   a citation `[[r1]]` read as that literal text to the parser (before
  //   v3.17.9 the citation was not part of marked) while the DOM holds `[r1]`,
  //   so the two sides never agreed;
  //   a code span with spaces at both ends loses one each side when read.
  readsBack('neighbour text with !', p(el('code', {}, 'k'), 's! ', el('em', {}, el('code', {}, 'c'), el('strong', {}, 'i'), 'tal')),
    '`k`s! *`c`__i__<!-- -->tal*');
  readsBack('citation in the block', p(el('a', { href: '#r' }, '[r1]'), ' ', el('em', {}, el('code', {}, 'c'), el('strong', {}, 'i'), 'tal')),
    '[[r1]] *`c`__i__<!-- -->tal*');
  readsBack('spaced code in the block', p(el('code', {}, ' x '), ' ', el('em', {}, el('code', {}, 'c'), el('strong', {}, 'i'), 'tal')),
    '` x ` *`c`__i__<!-- -->tal*');
  // ...and the del / code guards see a neighbour inside a bare span (the
  // walk's own comment above promised that for EM already).
  readsBack('adjacent del across a span', p(el('del', {}, 'one'), el('span', {}, el('del', {}, 'two'))), '~~one~~<!-- -->~~two~~');
  readsBack('adjacent code across a span', p(el('code', {}, 'one'), el('span', {}, el('code', {}, 'two'))), '`one`<!-- -->`two`');
  readsBack('adjacent em across a span', p(el('em', {}, 'a'), el('span', {}, el('em', {}, 'b'))), '*a*<!-- -->*b*');

  // What already reads right is written exactly as before.
  readsBack('unchanged: bold over an em', p('Alpha ', el('strong', {}, el('em', {}, 'ital'), ' bold'), ' text'),
    'Alpha ***ital* bold** text');
  readsBack('unchanged: full cover', p(el('strong', {}, el('em', {}, 'both'))), '***both***');
  readsBack('unchanged: intraword bold in em', p(el('em', {}, 'a', el('strong', {}, 'i'), 'tal')), '*a**i**tal*');

  // A repaired spelling never puts `<!--` at the start of a line: there it
  // opens an HTML block and ends the paragraph (v3.17.5 C1). After a newline
  // the character before an opening run is whitespace, so it needs no guard.
  for (const [name, root] of [
    ['after a hard break', p(el('em', {}, 'a', hb(), el('strong', {}, 'i'), 'tal'))],
    ['after a hard break, code first', p(el('em', {}, el('code', {}, 'c'), hb(), el('strong', {}, 'i'), 'tal'))],
    ['after a hard break, in a span', p(el('em', {}, 'a', hb(), el('span', {}, el('strong', {}, '「粗」')), '後面'))],
  ]) {
    const md = readsBack(name, root);
    assert.ok(!/(^|\n)[ \t]*<!--/.test(md), 'v3177 ' + name + ': `<!--` at a line start: ' + JSON.stringify(md));
  }

  // ...also when there are too many guards for the drop pass (re-review:
  // nine repaired marks, the last after a hard break, kept a line-start
  // `<!--` and the reader cut the paragraph there).
  {
    const kids = [el('code', {}, 'c')];
    for (let i = 0; i < 9; i++) {
      if (i === 8) kids.push(hb());
      kids.push(el('strong', {}, 'i'), 'tal ');
    }
    const md = readsBack('many guards, last after a hard break', p('Alpha ', el('em', {}, ...kids), ' end'));
    assert.ok(!/(^|\n)[ \t]*<!--/.test(md), 'v3177 many guards: `<!--` at a line start: ' + JSON.stringify(md));
  }

  // Tables write a code `|` through a placeholder (table-md.js); the check
  // reads it as the `|` the cell will show.
  {
    const PH = '';
    const cell = p(el('em', {}, el('code', {}, 'a|b'), el('strong', {}, 'i'), 'tal'));
    const md = serializeInline(cell, { codePipe: PH }).md;
    assert.strictEqual(md, '*`a' + PH + 'b`__i__<!-- -->tal*', 'v3177 table cell: repaired with the placeholder kept');
  }

  // The whole family, by fuzz: random trees of strong / em / del / code /
  // text, no mark inside itself (the toolbar unwraps that) and no two code
  // spans side by side without a guard. Fixed seed so a red run reproduces.
  // On 71fedaa this generator failed 7725 of 20000 (55 shapes).
  {
    let seed = 20261105;
    // Math.imul: a plain `*` loses precision past 2^53 and the stream
    // collapsed to a few hundred distinct trees (final review).
    const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const WORDS = ['a', 'bc', '中', '文字', 'ital'];
    const PUNCT = ['。', '「', '」', '：', ',', '.', '('];
    const text = () => { const r = rnd(); return r < 0.6 ? pick(WORDS) : r < 0.8 ? pick(WORDS) + ' ' + pick(WORDS) : r < 0.9 ? pick(PUNCT) + pick(WORDS) : pick(WORDS) + pick(PUNCT); };
    const MARKS = ['strong', 'em', 'del'];
    function gen(depth, anc) {
      const kids = [];
      const k = 1 + Math.floor(rnd() * 3);
      for (let i = 0; i < k; i++) {
        const r = rnd();
        const prev = kids[kids.length - 1];
        const avail = MARKS.filter((m) => anc.indexOf(m) === -1);
        if (depth < 3 && r < 0.55 && avail.length) { const m = pick(avail); kids.push(el(m, {}, ...gen(depth + 1, anc.concat(m)))); }
        else if (r < 0.62 && !(prev && prev.nodeName === 'CODE')) kids.push(el('code', {}, pick(['c', 'x y'])));
        else kids.push(text());
      }
      return kids;
    }
    let bad = 0; let first = null;
    for (let i = 0; i < 4000; i++) {
      const root = p(...gen(0, []));
      const md = serializeInline(root).md;
      if (htmlMarks(reader(md)).join('') !== domMarks(root, '', []).join('')) { bad++; if (!first) first = md; }
    }
    assert.strictEqual(bad, 0, 'v3177 nested fuzz: ' + bad + ' of 4000 read back wrong, first ' + JSON.stringify(first));
  }

  // The check only runs where it can change something: a STRONG / EM inside
  // another. Everything else (the per-keystroke shortcut check included) is
  // written without a parse (final review: 400 repaired marks took 3.4 s
  // when every block was parsed and every guard re-checked).
  {
    let calls = 0;
    const { setInlineParser } = require('../lib/editor/inline-md.js');
    const { Marked } = require('marked');
    const m = new Marked({ gfm: true });
    setInlineParser((s) => { calls++; return m.parseInline(s); });
    serializeInline(p('a ', el('strong', {}, 'b'), ' ', el('em', {}, 'c'), el('del', {}, el('strong', {}, 'd'))));
    assert.strictEqual(calls, 0, 'v3177: no nested star, no parse');
    serializeInline(p(el('em', {}, 'a', el('strong', {}, 'b'), 'c')));
    assert.strictEqual(calls, 1, 'v3177: a nested star that reads back costs one parse');
    setInlineParser();
  }
}

// v3.17.8 D3: text that spells an HTML character reference (`&amp;`, `&lt;`,
// `&#38;`, `&#x26;`) is what the person typed, so it must not be decoded by
// the reader. Measured on 3b51ce9: `a &amp; b` wrote `a &amp; b`, the reader
// showed `a & b`. A bare `&` (`AT&T`, `a & b`, `&copy` with no `;`) is never
// a reference and stays unescaped, so existing bytes do not move.
{
  const { Marked } = require('marked');
  const m = new Marked({ gfm: true });
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"' };
  // one pass, as a browser decodes: `&amp;lt;` shows `&lt;`, never `<`
  const shows = (md) => m.parseInline(md).replace(/&(amp|lt|gt|quot);/g, (x, n) => ENT[n]);
  for (const t of ['a &amp; b', 'x &lt;y', '&#38; and &#x26;', '&nbsp;', 'R&D;', 'p&amp;q &AMP; r']) {
    const md = escapeText(t);
    assert.strictEqual(shows(md), t, 'v3178 D3: ' + JSON.stringify(t) + ' wrote ' + JSON.stringify(md));
  }
  assert.strictEqual(escapeText('a &amp; b'), 'a \\&amp; b', 'v3178 D3: a reference-shaped & gets a backslash');
  for (const t of ['AT&T', 'a & b', '&copy', '&', 'a&;b', '& amp;']) {
    assert.strictEqual(escapeText(t), t, 'v3178 D3: ' + JSON.stringify(t) + ' is not a reference and stays as it was');
  }
  // the same through serializeInline, inside a mark, and next to the N1 check
  assert.strictEqual(serializeInline(el('p', {}, el('strong', {}, '&amp;'))).md, '**\\&amp;**');
  const nested = el('p', {}, el('em', {}, 'x &amp; ', el('strong', {}, 'b'), ' y'));
  assert.strictEqual(shows(serializeInline(nested).md).replace(/<[^>]+>/g, ''), 'x &amp; b y', 'v3178 D3: N1 block with a reference');
}

// v3.17.10: bytes the editor's DOM holds (a comment) or cannot hold (a stray
// end tag, a processing instruction) were never written back, so editing the
// block lost them (D9 in a cell, M-a in a paragraph / heading / list item).
// Measured on c8e6025 in the real editor: `Alpha <!-- keep --> beta.` + Z ->
// `Alpha  beta.Z`; `Alpha x</span> beta.` + Z -> `Alpha x beta.Z`.
{
  const cm = (d) => ({ nodeType: 8, nodeName: '#comment', textContent: d });
  const raw = (r) => cm('md2doc-raw:' + encodeURIComponent(r));
  const s = (...kids) => serializeInline(el('p', {}, ...kids)).md;
  // R2: a comment with text is written back as it was
  assert.strictEqual(s('Alpha ', cm(' keep '), ' beta.'), 'Alpha <!-- keep --> beta.', 'v31710 R2: comment kept');
  assert.strictEqual(s('Cl.2', cm(' [[ieee, Cl.2]] ')), 'Cl.2<!-- [[ieee, Cl.2]] -->', 'v31710 R2: citation anchor comment kept');
  assert.strictEqual(s('a', cm('x\ny'), 'b'), 'a<!--x\ny-->b', 'v31710 R2: multi-line comment kept');
  // a whitespace-only comment is the editor's own guard: re-decided by the walk
  assert.strictEqual(s(el('strong', {}, 'a'), cm(' '), el('strong', {}, 'b')), '**a**<!-- -->**b**', 'v31710 R2: guard not doubled');
  assert.strictEqual(s('a', cm(' '), 'b'), 'ab', 'v31710 R2: a guard with nothing to guard is dropped, as before');
  // a comment between two marks already separates them: no extra guard
  assert.strictEqual(s(el('strong', {}, 'a'), cm(' c '), el('strong', {}, 'b')), '**a**<!-- c -->**b**', 'v31710 R2: comment is the separator');
  {
    const md = s('x ', el('strong', {}, 'a', cm(' c ')), ' y');
    assert.strictEqual(marked.parseInline(md), 'x <strong>a<!-- c --></strong> y', 'v31710 R2: comment inside a mark, got ' + JSON.stringify(md));
  }
  // R3: the edit-mode placeholder for an inline html token the DOM cannot hold
  assert.strictEqual(s('Alpha x', raw('</span>'), ' beta.'), 'Alpha x</span> beta.', 'v31710 R3: stray end tag written back');
  assert.strictEqual(s('a', raw('</my-tag >')), 'a</my-tag >', 'v31710 R3: spelling kept');
  assert.strictEqual(s('a ', raw('<?pi x?>'), ' b'), 'a <?pi x?> b', 'v31710 R3: processing instruction written back');
  assert.strictEqual(s('a ', raw('<!DOCTYPE x>'), ' b'), 'a <!DOCTYPE x> b', 'v31710 R3: declaration written back');
  assert.strictEqual(s('a ', raw('<![CDATA[ x ]]>'), ' b'), 'a <![CDATA[ x ]]> b', 'v31710 R3: CDATA written back');
  // a placeholder whose payload is anything else stays the comment it is
  for (const bad of ['<script>alert(1)</script>', '<span>', '</span><b>', 'x']) {
    const d = 'md2doc-raw:' + encodeURIComponent(bad);
    assert.strictEqual(s('a', cm(d)), 'a<!--' + d + '-->', 'v31710 R3: forged payload ' + JSON.stringify(bad) + ' is not injected');
  }
  assert.strictEqual(s('a', cm('md2doc-raw:%E0%A4%A')), 'a<!--md2doc-raw:%E0%A4%A-->', 'v31710 R3: bad encoding stays a comment');
  // typed text that spells a comment is still text
  assert.ok(marked.parseInline(s('a <!-- b -->')).indexOf('<!--') === -1, 'v31710: typed comment text is escaped');
  assert.deepStrictEqual(serializeInline(el('p', {}, 'a', cm(' c '))).unsupported, [], 'v31710: a comment is supported');
}
// R5: marked reads a line starting with `<!--` / `<?` / `<!X` / `<![CDATA[`
// (or holding only a complete tag) as an HTML block, which ends the paragraph,
// so such a leading run moves to the end of its line; a line of nothing else
// joins the previous line (the first line: the next one).
{
  const cases = [
    ['<!-- c --> x', 'x <!-- c -->'],
    ['<!-- c -->x **b**', 'x **b**<!-- c -->'],
    ['a\n<!-- c --> x', 'a\nx <!-- c -->'],
    ['a\n<!-- c -->', 'a<!-- c -->'],
    ['<!-- c -->\nb', 'b<!-- c -->'],
    ['<!-- c --> x\\\ny', 'x <!-- c -->\\\ny'],
    ['a\\\n<!-- c --> y', 'a\\\ny <!-- c -->'],
    ['<?pi?> x', 'x <?pi?>'],
    ['<!X y> x', 'x <!X y>'],
    ['<![CDATA[z]]> x', 'x <![CDATA[z]]>'],
    ['<!-- a --></span> x', 'x <!-- a --></span>'],
    ['</span>\nb', 'b</span>'],
    ['a\n</span>', 'a</span>'],
  ];
  for (const [input, want] of cases) {
    assert.strictEqual(escapeBlockStarts(input), want, 'v31710 R5: ' + JSON.stringify(input));
    const toks = marked.lexer(want).filter((t) => t.type !== 'space');
    assert.deepStrictEqual(toks.map((t) => t.type), ['paragraph'], 'v31710 R5: one paragraph for ' + JSON.stringify(want));
  }
  // not a block start: left alone
  for (const same of ['a </span>', '</span> x', 'a <!-- c --> b', '<!-- c -->', '\\<!-- c --> x', '&lt;!-- c --> x']) {
    assert.strictEqual(escapeBlockStarts(same), same, 'v31710 R5: unchanged ' + JSON.stringify(same));
  }
}

console.log('inline-md.test.js OK');
