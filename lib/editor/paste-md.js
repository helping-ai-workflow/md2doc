'use strict';
/* UMD, same shape as lineops.js / indent-clamp.js / convert-md.js:
   `require`-able in node for the unit tests, and injected into the editor
   page as `window.md2docPasteMd` (lib/editor/server.js). client.js is
   inlined into the page as a plain <script>, not bundled, so a bare
   require('./paste-md.js') there would be an undefined identifier in the
   browser. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.md2docPasteMd = factory();
})(typeof self !== 'undefined' ? self : this, function () {

// This module has one external dependency: turndown (HTML -> Markdown).
// server.js injects every editor module into the page as a plain <script>
// tag, in a fixed order (lib/editor/server.js) -- turndown's browser UMD
// build (node_modules/turndown/lib/turndown.browser.umd.js, which defines
// the global `TurndownService`) is one more such tag. Resolving turndown at
// FACTORY time -- a top-level `require('turndown')`, or reading
// `TurndownService` at module-eval time -- would silently coupled this
// module's *load order* to turndown's <script> tag landing before this
// one; reorder server.js's injection list and the factory throws before a
// single test runs, or before the page even paints. Resolving lazily,
// inside htmlToMarkdown, defers that lookup to the first call, by which
// point both node's `require` cache (node side) and the browser page's
// <script> tags (browser side) have already settled. There is no existing
// precedent for an external-module lookup in this codebase's editor
// modules (convert-md.js / lineops.js / indent-clamp.js / selection.js all
// have zero external dependencies), so this is a fresh pattern, not a
// copy of one.
function getTurndownService() {
  // Recomputed here (not read from the outer UMD wrapper's `root` param)
  // because that param belongs to the wrapper function, not to this
  // factory's lexical scope -- the factory is a sibling argument at the
  // IIFE call site, so it does not close over it.
  var root = typeof self !== 'undefined' ? self : this;
  return typeof require === 'function' ? require('turndown') : root.TurndownService;
}

// --- GFM extras turndown's core does not ship ------------------------------
//
// turndown's core rule set has no rule for <del>/<s>/<strike> or for
// <table>. The obvious fix is the `turndown-plugin-gfm` package, but the
// brief scopes package.json to exactly one new dependency (turndown) --
// adding a second package is out of scope for this track. These two rules
// are a deliberately small, from-scratch reimplementation of the same
// GFM shapes (not a copy of turndown-plugin-gfm's source), added via
// turndownService.addRule the same way any consumer of turndown extends it.

function addStrikethroughRule(service) {
  service.addRule('strikethrough', {
    filter: ['del', 's', 'strike'],
    replacement: function (content) {
      return '~~' + content + '~~';
    }
  });
}

// --- bold / italic next to punctuation (v3.17.5 R2) -------------------------
//
// CommonMark only takes a `*` run whose inside character, when it is
// punctuation (marked 14: \p{P}\p{S}), has whitespace, punctuation or the edge
// of the text on its outside. turndown's own strong / emphasis rules wrap
// blind, so a pasted `前面<b>「引號」</b>後面` became `前面**「引號」**後面` and
// the reader showed the asterisks. These two rules replace them and put
// `<!-- -->` (marked reads an HTML tag as punctuation) on a side that needs
// it -- the same separator, for the same rule, as walkChildren() in
// inline-md.js; the classes below are that file's FLANK_WS / FLANK_PUNCT.
// Whitespace at the edges never reaches them: turndown moves it outside
// first (`node.flankingWhitespace`), and a side that got some needs nothing.
//
// The outside character is read from the DOM, because the markdown around
// this node does not exist yet: the nearest text before / after it within the
// block, through bare inline wrappers. A neighbour that writes a delimiter or
// a bracket of its own there (a parent <b>, <a>, <code>...) is punctuation; an
// <img>, <br> or <hr> writes `)` or whitespace. Any other element with no text
// (a Word bookmark `<a name>`, an empty <span>, `<o:p>`) writes nothing and is
// looked past; the wrappers below write only their content (v3.17.5 final
// review I3: <u>, <sup>, <ins>... were missing, and an empty neighbour stopped
// the search).
//
// Before the run, the character is one UTF-16 unit, as marked reads it
// (`token.raw.slice(-1)`): an astral symbol there (📌) is a lone surrogate to
// it, a word character (final review I2).
var FLANK_WS = /\s/;
var FLANK_PUNCT = /[\p{P}\p{S}]/u;
var TRANSPARENT_INLINE = /^(SPAN|FONT|MARK|SMALL|BIG|ABBR|CITE|DFN|Q|TIME|DATA|BDI|BDO|U|INS|SUB|SUP|KBD|SAMP|VAR|LABEL|O:P)$/;
var WRITES_ITS_OWN = /^(IMG|BR|HR)$/;

function isWordish(ch) {
  return ch !== undefined && !FLANK_WS.test(ch) && !FLANK_PUNCT.test(ch);
}

function edgeChar(text, last) {
  if (!text) return undefined;
  return last ? text[text.length - 1] : Array.from(text)[0];
}

// Only an inline element's text is read as the neighbour. A block, or an
// element not on these lists, is a line edge or unknown: the answer is
// "not a word character", so no separator -- which can never put `<!--` at a
// line start, where marked reads it as an HTML block that ends the paragraph
// (re-review I1: `<div>前</div><b>「x」</b>`).
var MARKUP_INLINE = /^(STRONG|B|EM|I|DEL|S|STRIKE|A|CODE)$/;

// An element with no text writes nothing only when it is one of the inline
// elements above and nothing inside it writes either. An <img>, <br> or <hr>
// writes `)` or a line break (re-review C1: `<span><br></span>` was looked
// past, and the separator landed at the start of a line); a block -- or an
// element not on the lists -- writes a line edge even when empty (round 3,
// I1': `<p></p>` is a blank line). A bold / italic with no text is dropped by
// its own rule whatever it holds (`<b><br></b>`).
function writesNothing(el) {
  var name = el.nodeName;
  if (/^(STRONG|B|EM|I)$/.test(name) && !el.textContent.trim()) return true;
  if (!TRANSPARENT_INLINE.test(name) && !MARKUP_INLINE.test(name)) return false;
  for (var c = el.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1 && !writesNothing(c)) return false;
  }
  return true;
}

// The character a neighbour writes at the edge facing the run: its last (or
// first) descendant that writes anything. A <br> / <img> / <hr> there, or a
// block or unknown element on the way, answers undefined -- so
// `<span>前<br></span>` is a line edge, not 前.
function edgeOf(node, last) {
  if (node.nodeType === 3) return node.textContent ? edgeChar(node.textContent, last) : undefined;
  if (node.nodeType !== 1) return undefined;
  if (!TRANSPARENT_INLINE.test(node.nodeName) && !MARKUP_INLINE.test(node.nodeName)) return undefined;
  for (var c = last ? node.lastChild : node.firstChild; c; c = last ? c.previousSibling : c.nextSibling) {
    if (c.nodeType === 3 && !c.textContent) continue;
    if (c.nodeType === 1 && !c.textContent && writesNothing(c)) continue;
    if (c.nodeType !== 1 && c.nodeType !== 3) continue;
    return edgeOf(c, last);
  }
  return undefined;
}

function outsideChar(node, dir) {
  for (var n = node; n; n = n.parentNode) {
    var sib = n[dir];
    while (sib && (sib.nodeType === 1 ? !sib.textContent && writesNothing(sib)
      : sib.nodeType !== 3 || !sib.textContent)) sib = sib[dir];
    if (sib) return edgeOf(sib, dir === 'previousSibling');
    var parent = n.parentNode;
    if (!parent || parent.nodeType !== 1 || !TRANSPARENT_INLINE.test(parent.nodeName)) return undefined;
  }
  return undefined;
}

function insideChar(md, last) {
  var chars = Array.from(md);
  if (last) {
    var i = chars.length - 1;
    while (i >= 0 && chars[i] === '*') i -= 1;
    return chars[i];
  }
  var j = 0;
  while (j < chars.length && chars[j] === '*') j += 1;
  return chars[j];
}

function flankedReplacement(delimiterOf) {
  return function (content, node, options) {
    if (!content.trim()) return '';
    // turndown moves the text's own edge whitespace outside, but not a <br>'s
    // `  \n` at an edge (final review): peel that too
    var lead = /^\s*/.exec(content)[0];
    var trail = /\s*$/.exec(content)[0];
    var delim = delimiterOf(options);
    var md = delim + content.slice(lead.length, content.length - trail.length) + delim;
    var ws = node.flankingWhitespace || { leading: '', trailing: '' };
    var before = !lead && !ws.leading && FLANK_PUNCT.test(insideChar(md, false) || '') &&
      isWordish(outsideChar(node, 'previousSibling'));
    var after = !trail && !ws.trailing && FLANK_PUNCT.test(insideChar(md, true) || '') &&
      isWordish(outsideChar(node, 'nextSibling'));
    return lead + (before ? '<!-- -->' : '') + md + (after ? '<!-- -->' : '') + trail;
  };
}

function addFlankingEmphasisRules(service) {
  service.addRule('strongFlanking', {
    filter: ['strong', 'b'],
    replacement: flankedReplacement(function (o) { return o.strongDelimiter; })
  });
  service.addRule('emphasisFlanking', {
    filter: ['em', 'i'],
    replacement: flankedReplacement(function (o) { return o.emDelimiter; })
  });
}

function isFirstTbody(el) {
  var prev = el.previousSibling;
  return (
    el.nodeName === 'TBODY' &&
    (!prev || (prev.nodeName === 'THEAD' && /^\s*$/.test(prev.textContent)))
  );
}

function isHeadingRow(tr) {
  var parent = tr.parentNode;
  if (!parent) return false;
  if (parent.nodeName === 'THEAD') return true;
  if (parent.firstChild !== tr) return false;
  if (parent.nodeName !== 'TABLE' && !isFirstTbody(parent)) return false;
  for (var i = 0; i < tr.childNodes.length; i += 1) {
    if (tr.childNodes[i].nodeName !== 'TH') return false;
  }
  return tr.childNodes.length > 0;
}

// Fix-round-1 (2026-09-03), Critical: a literal `|` in cell content used to
// pass through unescaped, so e.g. a Windows path or a bitwise-or expression
// silently added a phantom column -- every column to its right misaligned
// against the header. Escape any `|` that isn't already an escaped `\|`
// (the latter can arrive when a nested table's own already-escaped cell
// content is flattened into its parent cell, see cellMarkdown below).
//
// v3.17.7 F2: "already escaped" means an ODD run of backslashes before the
// `|`, which is how marked's splitCells() decides it (the parity rule
// v3.17.6 wrote down in table-md.js). The old test was one backslash, any
// run: text `a \| b` (turndown writes its backslash as `\\`) came out
// `a \\| b`, an even run, and the cell was cut in two (measured on 71fedaa).
function escapePipes(s) {
  return String(s).replace(/(\\*)\|/g, function (m, run) {
    return run.length % 2 ? m : run + '\\|';
  });
}

// v3.17.7 F2: code whose text has an odd backslash run before a `|` has no
// spelling in a GFM table cell. The backslash that keeps the pipe in the
// cell is the one GFM deletes before the code span is read, so the code
// shows one backslash fewer (or, with one backslash more, the run turns even
// and the pipe ends the cell); table-md.js refuses the same code (v3.17.6).
// Paste cannot refuse, so such a span is written as text with EVERY ASCII
// punctuation character backslash-escaped (CommonMark allows that for all
// of them): then nothing in it is read as markup -- not `<!--`, not an
// entity, not md2doc's `^sup^` / `~sub~` / `$math$`. turndown's own
// escape() leaves those alone (final review: `a<!-- \| -->` lost its text,
// `^2^` became superscript). The `|` comes out `\|`, an odd run, which
// escapePipes() then leaves as it is. Every character arrives; only the
// code style does not.
var ODD_BACKSLASH_PIPE = /(?:^|[^\\])(?:\\\\)*\\\|/;
function addUnspellableCellCodeRule(service) {
  service.addRule('unspellableCellCode', {
    filter: function (node) {
      if (node.nodeName !== 'CODE') return false;
      if (node.parentNode && node.parentNode.nodeName === 'PRE') return false;
      if (!ODD_BACKSLASH_PIPE.test(node.textContent || '')) return false;
      for (var p = node.parentNode; p; p = p.parentNode) {
        if (p.nodeName === 'TD' || p.nodeName === 'TH') return true;
      }
      return false;
    },
    replacement: function (content, node) {
      return (node.textContent || '').replace(/[!-\/:-@\[-`{-~]/g, '\\$&');
    }
  });
}

// Only the ROWS THIS TABLE OWNS -- direct <tr> children, and <tr> children
// one level down inside a <thead>/<tbody>/<tfoot>. A nested <table> sitting
// inside one of this table's <td> cells is two levels further down (tr ->
// td -> table -> tbody -> tr), so it is never reached by this walk and its
// rows can never be mistaken for this table's own rows.
function collectRows(table) {
  var rows = [];
  for (var i = 0; i < table.childNodes.length; i += 1) {
    var child = table.childNodes[i];
    if (child.nodeName === 'TR') {
      rows.push(child);
    } else if (child.nodeName === 'THEAD' || child.nodeName === 'TBODY' || child.nodeName === 'TFOOT') {
      for (var j = 0; j < child.childNodes.length; j += 1) {
        if (child.childNodes[j].nodeName === 'TR') rows.push(child.childNodes[j]);
      }
    }
  }
  return rows;
}

function cellColSpan(cellNode) {
  var n = typeof cellNode.colSpan === 'number' ? cellNode.colSpan
    : parseInt(cellNode.getAttribute && cellNode.getAttribute('colspan'), 10);
  return n > 0 ? n : 1;
}

// Converts ONE cell's own content (recursing through `service`, so a
// nested <table> inside this cell is itself converted by this same table
// rule -- see the module comment above addTableRules). The result is
// flattened to one line and pipe-escaped, so a nested table collapses into
// one escaped, single-line cell instead of leaking a stream of stray pipes
// into the parent row.
function cellMarkdown(cellNode, service) {
  var md = service.turndown(cellNode);
  return escapePipes(String(md).trim().replace(/\s*\n+\s*/g, ' '));
}

// Fix-round-1, Important: a colspan="N" cell used to emit as a single
// cell, leaving the row N-1 columns short of every other row it should
// align with. Ruling: expand it into N cells (content in the first, empty
// in the rest) rather than modeling a real merged-cell grid. rowspan is
// deliberately NOT expanded (no full grid model) -- a row it shortens is
// simply padded to the table's width by padRow below. Lossy, but every row
// still lexes as a well-formed GFM row.
function expandRowCells(row, service) {
  var out = [];
  for (var i = 0; i < row.childNodes.length; i += 1) {
    var cellNode = row.childNodes[i];
    if (cellNode.nodeName !== 'TH' && cellNode.nodeName !== 'TD') continue;
    var span = cellColSpan(cellNode);
    out.push(cellMarkdown(cellNode, service));
    for (var s = 1; s < span; s += 1) out.push('');
  }
  return out;
}

function renderRowLine(cells) {
  return '| ' + cells.join(' | ') + ' |';
}

function padRow(cells, width) {
  var out = cells.slice();
  while (out.length < width) out.push('');
  return out;
}

// Fix-round-1, Important: rebuilds the WHOLE table from the DOM directly
// (rather than composing per-cell/per-row replacement strings the way the
// pre-fix version did) so column count can be normalized across every row
// before any markdown is emitted -- expanding colspan and padding every
// row, header included, out to the table's widest row (see
// expandRowCells/padRow above). That decision needs the full row set in
// hand; it cannot be made one row/cell at a time.
function renderTable(table, service) {
  var rows = collectRows(table);
  if (rows.length === 0) return '';

  var expanded = rows.map(function (row) {
    return { row: row, cells: expandRowCells(row, service) };
  });

  var width = 0;
  expanded.forEach(function (r) { if (r.cells.length > width) width = r.cells.length; });
  if (width === 0) return '';

  var headerIdx = -1;
  for (var i = 0; i < expanded.length; i += 1) {
    if (isHeadingRow(expanded[i].row)) { headerIdx = i; break; }
  }
  // No <thead>/<th> anywhere: promote the first row to the header slot so
  // the table still lexes as GFM, same as the pre-fix behavior.
  if (headerIdx === -1) headerIdx = 0;

  var lines = [];
  lines.push(renderRowLine(padRow(expanded[headerIdx].cells, width)));
  lines.push(renderRowLine(new Array(width).fill('---')));
  expanded.forEach(function (r, idx) {
    if (idx === headerIdx) return;
    lines.push(renderRowLine(padRow(r.cells, width)));
  });

  return '\n\n' + lines.join('\n') + '\n\n';
}

function addTableRules(service) {
  service.addRule('table', {
    filter: function (node) {
      return node.nodeName === 'TABLE';
    },
    replacement: function (content, node) {
      return renderTable(node, service);
    }
  });
}

function htmlToMarkdown(html) {
  var TurndownService = getTurndownService();
  var service = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*'
  });
  // v3.17.8 D3: turndown's escape() covers Markdown punctuation only, so
  // pasted TEXT that spells HTML came back as markup: `<b>x</b>` turned bold,
  // `<!-- c -->` vanished, `&amp;` showed as `&`. A `<` that could open a tag,
  // a comment or an autolink is written `&lt;`, and an `&` shaped like a
  // character reference is written `\&` -- the spellings inline-md.js's
  // escapeText() gives typed text. A bare `<` (`1 < 2`) or `&` (`AT&T`) is
  // already shown as typed and stays bare. Code is not escaped by turndown
  // at all, and needs none: a code span is literal.
  var baseEscape = service.escape;
  service.escape = function (s) {
    return baseEscape.call(this, s)
      .replace(/&(?=#?\w+;)/g, '\\&')
      .replace(/<(?=[A-Za-z\/!?])/g, '&lt;');
  };
  addStrikethroughRule(service);
  addFlankingEmphasisRules(service);
  addTableRules(service);
  addUnspellableCellCodeRule(service);
  return service.turndown(html == null ? '' : String(html));
}

// --- clipboard payload selection --------------------------------------------
//
// Pure decision logic, no DOM/ClipboardEvent access here -- the caller
// (client.js, a later track) reads the real `ClipboardEvent#clipboardData`
// / `navigator.clipboard.read()` result into this plain
// { 'mime/type': string | Blob } shape and hands it in.
//
// Fix-round-1 (2026-09-03), ruling on the priority order: `plainOnly`
// (Ctrl+Shift+V, an explicit "give me text" gesture) wins over an image
// whenever the clipboard carries ANY text flavour (`text/plain` OR
// `text/html`) -- honour the gesture whenever there is text to honour it
// with. Fall through to the image only when there is no text flavour at
// all, since there is then no text to honour the gesture with.
//
// Fix-round-2 (2026-09-03), ruling extended to the default (non-plainOnly)
// path: `text/html` now beats an image when both are present. Round 1 left
// an unconditional image-first rule there. But a `text/html` clipboard is a
// rich-text copy (Word / a browser / Confluence), and those sources
// routinely put a bitmap of the SAME content alongside the HTML -- with
// image-first, the headline case this track exists for (paste from Word,
// get markdown) instead landed a screenshot of the Word content, which is
// worse than the plain-text behavior it was meant to replace. `text/html`
// -> `<img src="...">` converts losslessly to `![](...)`, keeping a remote
// URL instead of re-uploading a copy of it. A screenshot from a snipping
// tool carries no `text/html` at all, so it is unaffected and still takes
// the image branch (reaching the asset endpoint, a later track's concern,
// not this module's).
function pickPayload(clipboardItems, plainOnly) {
  var items = clipboardItems || {};

  // 'file' sits beside the image/* keys: a .drawio carries no MIME, so the
  // client keys it there rather than inventing one. The payload kind stays
  // 'image' because its only consumer is the upload path, which asks nothing
  // about the bytes -- /api/asset decides what may actually be written.
  var imageKey = null;
  for (var k in items) {
    if (Object.prototype.hasOwnProperty.call(items, k) &&
        (k.indexOf('image/') === 0 || k === 'file') && items[k] != null) {
      imageKey = k;
      break;
    }
  }

  var html = items['text/html'];
  var text = items['text/plain'];
  var hasText = (typeof text === 'string' && text !== '') || (typeof html === 'string' && html !== '');

  if (plainOnly) {
    if (hasText) return { kind: 'text', value: typeof text === 'string' ? text : '' };
    if (imageKey) return { kind: 'image', blob: items[imageKey] };
    return { kind: 'text', value: '' };
  }

  if (typeof html === 'string' && html !== '') {
    return { kind: 'markdown', value: htmlToMarkdown(html) };
  }

  if (imageKey) return { kind: 'image', blob: items[imageKey] };

  return { kind: 'text', value: typeof text === 'string' ? text : '' };
}

return { htmlToMarkdown: htmlToMarkdown, pickPayload: pickPayload };
});
