'use strict';

// Pure marker arithmetic for the S2 "轉換成" submenu (spec 3.2, 4.3).
//
// Why this module reads LINES and not the DOM: `serializeBlocks` reports any
// non-`li` block inside a span as unsupported (list-md.js:462-463), which is
// exactly the shape a conversion produces. Routing a conversion through the
// run re-serializer would make every li->heading refuse itself. Reading the
// source lines also means inline content is never re-escaped, so a `~5px` in
// the converted block survives as `~5px`.
//
// This module knows nothing about indent arithmetic. The caller owns the
// marker-width stack (spec 3.4) and passes the finished `indentPrefix` in.

const CONVERT_TARGETS = [
  { id: 'text', label: '文字' },
  { id: 'h1', label: '標題 1' },
  { id: 'h2', label: '標題 2' },
  { id: 'h3', label: '標題 3' },
  { id: 'h4', label: '標題 4' },
  { id: 'h5', label: '標題 5' },
  { id: 'h6', label: '標題 6' },
  { id: 'ul', label: '項目符號列表' },
  { id: 'ol', label: '編號列表' },
  { id: 'task', label: '待辦清單' },
  { id: 'code', label: '程式碼' },
  { id: 'quote', label: '引用' },
];

// A bullet is -, * or +; an ordinal is digits followed by . or ). The GFM task
// checkbox is parsed out of the CONTENT, not the marker (spec 3.4 errata), so
// it is stripped as a second, separate step.
const LI_MARKER = /^(\s*)(?:[-*+]|\d{1,9}[.)])(\s+)/;
const TASK_BOX = /^\[([ xX])\]\s+/;
const ATX = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const QUOTE = /^>\s?/;
const FENCE = /^(\s*)(```+|~~~+)(.*)$/;

function stripMarker(sourceLines, blockKind) {
  const src = Array.isArray(sourceLines) ? sourceLines : [];
  if (src.length === 0) return { content: [], ok: false };

  if (blockKind === 'li') {
    const m = src[0].match(LI_MARKER);
    if (!m) return { content: [], ok: false };
    let first = src[0].slice(m[0].length);
    const box = first.match(TASK_BOX);
    if (box) first = first.slice(box[0].length);
    // Continuation lines carry the item's own indent; drop the common prefix.
    const rest = src.slice(1).map((l) => l.replace(/^\s+/, ''));
    return { content: [first, ...rest], ok: true };
  }

  if (blockKind === 'heading') {
    const m = src[0].match(ATX);
    // A setext heading (underlined with === or ---) is two lines and has no
    // marker to strip from line 1; treat it as content plus a discarded rule.
    if (!m) {
      if (src.length >= 2 && /^\s*(=+|-+)\s*$/.test(src[1])) {
        return { content: [src[0].trim()], ok: true };
      }
      return { content: [], ok: false };
    }
    return { content: [m[2]], ok: true };
  }

  if (blockKind === 'blockquote') {
    return { content: src.map((l) => l.replace(QUOTE, '')), ok: true };
  }

  if (blockKind === 'code') {
    const open = src[0].match(FENCE);
    // An INDENTED code block has no fence. Stripping four spaces would be a
    // guess, and a wrong one whenever the body is itself indented, so refuse.
    if (!open) return { content: [], ok: false };
    let end = src.length;
    if (end > 1 && FENCE.test(src[end - 1])) end -= 1;
    return { content: src.slice(1, end), ok: true };
  }

  // paragraph, html, anything else that owns its lines verbatim
  return { content: src.slice(), ok: true };
}

function targetIsList(target) {
  return target === 'ul' || target === 'ol' || target === 'task';
}

function listAttrsFor(target) {
  if (target === 'ul') return { listType: 'ul', task: false };
  if (target === 'ol') return { listType: 'ol', task: false };
  if (target === 'task') return { listType: 'ul', task: true };
  return null;
}

function emitAs(content, target, opts) {
  const o = opts || {};
  const prefix = o.indentPrefix || '';
  const body = Array.isArray(content) ? content : [];

  if (target === 'text') return body.slice();

  if (/^h[1-6]$/.test(target)) {
    // A heading is one line by definition. Joining is the only lossless move
    // available; splitting would make one gesture produce two blocks.
    const hashes = '#'.repeat(Number(target.slice(1)));
    return [prefix + hashes + ' ' + body.join(' ')];
  }

  if (target === 'quote') return body.map((l) => prefix + '> ' + l);

  if (target === 'code') {
    return [prefix + '```', ...body.map((l) => prefix + l), prefix + '```'];
  }

  if (targetIsList(target)) {
    const marker = target === 'ol' ? String(o.ordinal || 1) + '. ' : '- ';
    const box = target === 'task' ? (o.checked ? '[x] ' : '[ ] ') : '';
    const head = prefix + marker + box + (body[0] !== undefined ? body[0] : '');
    // Continuations sit under the marker so they stay inside the item. The
    // checkbox is deliberately NOT counted: spec 3.4's errata measured
    // `- [ ] ` as contributing 2 columns, not 6, because GFM parses the box
    // out of the item's CONTENT rather than out of the CommonMark marker.
    const contIndent = ' '.repeat(marker.length);
    const rest = body.slice(1).map((l) => prefix + contIndent + l);
    return [head, ...rest];
  }

  return body.slice();
}

module.exports = { CONVERT_TARGETS, stripMarker, emitAs, targetIsList, listAttrsFor };
