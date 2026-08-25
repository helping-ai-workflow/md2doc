'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.md2docInlineMd = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // Escaping rules (verbatim from task-2 brief):
  //  - backslash / backtick / asterisk / leading-bracket escaped always
  //  - underscore escaped ONLY at a word boundary (snake_case stays clean)
  //  - literal `<` becomes `&lt;` (HTML-safe, keeps <br> etc. unambiguous)
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
      if (c === '<') { out += '&lt;'; continue; }
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
  // carrying any of these attributes is a real style/class carrier we don't
  // support yet, so it is reported via `unsupported` instead of unwrapped.
  const SPAN_ATTR_PROBE = ['style', 'class', 'id', 'data-mce-style'];

  function spanHasAttributes(node) {
    for (let i = 0; i < SPAN_ATTR_PROBE.length; i++) {
      const v = node.getAttribute(SPAN_ATTR_PROBE[i]);
      if (v !== null && v !== undefined && v !== '') return true;
    }
    return false;
  }

  function serializeCode(node) {
    const raw = node.textContent;
    if (raw.indexOf('`') !== -1) return '`` ' + raw + ' ``';
    return '`' + raw + '`';
  }

  function serializeAnchor(node, unsupported) {
    const href = node.getAttribute('href');
    const text = node.textContent;
    // citation: <a href="#slug">[body]</a> -> [[body]]
    if (href && href.charAt(0) === '#' && /^\[.*\]$/.test(text)) {
      return '[[' + text.slice(1, -1) + ']]';
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
