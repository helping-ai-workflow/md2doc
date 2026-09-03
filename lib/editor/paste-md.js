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

function tableCell(content, node, index) {
  var prefix = index === 0 ? '| ' : ' ';
  return prefix + content.trim().replace(/\n+/g, ' ') + ' |';
}

function addTableRules(service) {
  service.addRule('tableCell', {
    filter: ['th', 'td'],
    replacement: function (content, node) {
      var index = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
      return tableCell(content, node, index);
    }
  });

  service.addRule('tableRow', {
    filter: 'tr',
    replacement: function (content, node) {
      var borderCells = '';
      if (isHeadingRow(node)) {
        for (var i = 0; i < node.childNodes.length; i += 1) {
          borderCells += tableCell('---', node.childNodes[i], i);
        }
      }
      return '\n' + content + (borderCells ? '\n' + borderCells : '');
    }
  });

  service.addRule('tableSection', {
    filter: ['thead', 'tbody', 'tfoot'],
    replacement: function (content) {
      return content;
    }
  });

  service.addRule('table', {
    filter: function (node) {
      return node.nodeName === 'TABLE';
    },
    replacement: function (content) {
      // A table with no THEAD/TH row has no separator line -- synthesize
      // one under the first row so the output still lexes as a GFM table.
      var lines = content.replace(/^\n+/, '').replace(/\n+$/, '').split('\n');
      if (lines.length > 0 && !/^\|(?:\s*---\s*\|)+$/.test(lines[1] || '')) {
        var cols = (lines[0].match(/\|/g) || []).length - 1;
        if (cols > 0) {
          var sep = '|' + new Array(cols + 1).join(' --- |');
          lines.splice(1, 0, sep);
        }
      }
      return '\n\n' + lines.join('\n') + '\n\n';
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
// Priority: an image always wins (there is no lossless plain-text or
// markdown stand-in for an image, so `plainOnly` cannot rescue one).
// Otherwise `plainOnly` forces 'text' even when 'text/html' is present
// (that is the whole point of a "paste as plain text" gesture). Otherwise
// 'text/html' -> converted markdown, falling back to 'text/plain'.
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
  if (imageKey) return { kind: 'image', blob: items[imageKey] };

  var html = items['text/html'];
  var text = items['text/plain'];

  if (!plainOnly && typeof html === 'string' && html !== '') {
    return { kind: 'markdown', value: htmlToMarkdown(html) };
  }
  return { kind: 'text', value: typeof text === 'string' ? text : '' };
}

return { htmlToMarkdown: htmlToMarkdown, pickPayload: pickPayload };
});
