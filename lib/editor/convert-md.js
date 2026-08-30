'use strict';
/* UMD, same shape as lineops.js / indent-clamp.js: `require`-able in node for
   the unit tests, and injected into the editor page as `window.md2docConvertMd`
   (lib/editor/server.js). client.js is inlined into the page as a plain
   <script>, not bundled, so a bare require('./convert-md.js') there would be
   an undefined identifier in the browser. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.md2docConvertMd = factory();
})(typeof self !== 'undefined' ? self : this, function () {

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
// An ATX heading may carry NO content at all: measured against marked 14.1.4,
// '#', '##', '###', '## ##' and '#### #' all lex as a heading whose text is
// ''. Requiring `\s+` plus content refused them, and the user saw
// 此區塊的格式無法轉換 on an empty heading. The optional closing sequence is
// stripped separately, because '## ##' has one with no content in front of it.
const ATX = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
// A closing sequence is a run of # at end of line, preceded by whitespace or
// by nothing at all. Measured: '## alpha#' keeps the '#' (no space in front)
// and '## alpha #x' keeps the whole tail (not a pure run).
const ATX_CLOSE = /(?:^|[ \t]+)#+$/;
const QUOTE = /^>\s?/;
// The OPENING fence: <=3 columns of indent, then a run of >=3 backticks or
// tildes, then an optional info string.
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;

// Does `line` close a fence opened with `openRun`? Measured against marked
// 14.1.4, all four conditions are load-bearing:
//   '````\na\n```'   -> the '```' survives as CONTENT (too short)
//   '```\na\n~~~'    -> the '~~~' survives as CONTENT (wrong character)
//   '```\na\n```js'  -> the '```js' survives as CONTENT (info string)
//   '```\na\n    ```'-> the '    ```' survives as CONTENT (4 columns)
// while '```\na\n   ```' and '```js\na\n````' both DO close. Matching
// "looks like a fence" ate a line of the user's code in the first four cases.
function isClosingFence(line, openRun) {
  const m = String(line).match(/^( {0,3})(`{3,}|~{3,})[ \t]*$/);
  if (!m) return false;
  return m[2][0] === openRun[0] && m[2].length >= openRun.length;
}

// The longest fence-shaped run of `ch` in `body` -- i.e. the longest run that
// would CLOSE a fence made of `ch`. Measured: an inline run ('a ``` b') and a
// run indented 4+ columns never close, so neither inflates the fence; a run
// indented 0-3 columns does.
function longestClosingRun(body, ch) {
  const re = ch === '`' ? /^ {0,3}(`{3,})[ \t]*$/ : /^ {0,3}(~{3,})[ \t]*$/;
  let longest = 0;
  for (const line of body) {
    const m = String(line).match(re);
    if (m && m[1].length > longest) longest = m[1].length;
  }
  return longest;
}

function stripMarker(sourceLines, blockKind) {
  const src = Array.isArray(sourceLines) ? sourceLines : [];
  if (src.length === 0) return { content: [], ok: false };

  if (blockKind === 'li') {
    const m = src[0].match(LI_MARKER);
    if (!m) return { content: [], ok: false };
    // A MULTI-LINE li refuses. The previous code flattened continuations with
    // replace(/^\s+/, ''), which is exactly the guess the code branch below
    // refuses to make for an indented code block -- and it silently destroys
    // whatever structure the continuation carried (a nested fence, an indented
    // sub-block). Today the \u00a74.1 gate refuses a multi-line li as an operation
    // target before this is ever reached, so this is defence in depth; dead
    // code in this repo has a history of later gaining a caller, and it must
    // not be a mine when it does.
    if (src.length > 1) return { content: [], ok: false };
    let first = src[0].slice(m[0].length);
    const box = first.match(TASK_BOX);
    if (box) first = first.slice(box[0].length);
    return { content: [first], ok: true };
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
    const raw = m[2] === undefined ? '' : m[2];
    return { content: [raw.replace(ATX_CLOSE, '')], ok: true };
  }

  if (blockKind === 'blockquote') {
    return { content: src.map((l) => l.replace(QUOTE, '')), ok: true };
  }

  if (blockKind === 'code') {
    const open = src[0].match(FENCE_OPEN);
    // An INDENTED code block has no fence. Stripping four spaces would be a
    // guess, and a wrong one whenever the body is itself indented, so refuse.
    if (!open) return { content: [], ok: false };
    let end = src.length;
    if (end > 1 && isClosingFence(src[end - 1], open[2])) end -= 1;
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
    const text = body.join(' ');
    // An EMPTY heading emits no trailing space, or converting '##' to a
    // heading of the same level would rewrite the line to '## '.
    return [text === '' ? prefix + hashes : prefix + hashes + ' ' + text];
  }

  if (target === 'quote') return body.map((l) => prefix + '> ' + l);

  if (target === 'code') {
    // Negotiate the fence length. A body that itself contains a fence line
    // closed the block early: emitting ['```','before','```','after','```']
    // lexes as code,paragraph -- 'after' escapes into the document, and the
    // trailing fence opens an unterminated block. The opening run must be
    // strictly longer than any run in the body that could close it. Measured:
    // a TILDE run cannot close a backtick fence, so it does not count here,
    // despite what the fix request assumed.
    const fence = '`'.repeat(Math.max(3, longestClosingRun(body, '`') + 1));
    return [prefix + fence, ...body.map((l) => prefix + l), prefix + fence];
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

return { CONVERT_TARGETS, stripMarker, emitAs, targetIsList, listAttrsFor };
});
