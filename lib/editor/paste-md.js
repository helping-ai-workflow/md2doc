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
function escapePipes(s) {
  return String(s).replace(/(?<!\\)\|/g, '\\|');
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
  addStrikethroughRule(service);
  addTableRules(service);
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

  var imageKey = null;
  for (var k in items) {
    if (Object.prototype.hasOwnProperty.call(items, k) &&
        k.indexOf('image/') === 0 && items[k] != null) {
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
