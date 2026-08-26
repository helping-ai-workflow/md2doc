'use strict';
const assert = require('assert');
const { marked } = require('marked');
const { serializeInline, canWysiwyg, escapeText } = require('../lib/editor/inline-md.js');

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

console.log('inline-md.test.js OK');
