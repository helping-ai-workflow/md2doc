'use strict';
/* UMD, same shape as convert-md.js: `require`-able in node for the unit tests
   (test/code-edit.test.js), and injected into the editor page as
   `window.md2docCodeEdit` (lib/editor/server.js). Interpolated raw into a
   <script> tag, so it must never contain a closing script tag. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.md2docCodeEdit = factory();
})(typeof self !== 'undefined' ? self : this, function () {

// v3.17.0 T1: the pure core of the in-place code editor (decisions D3, D7,
// D10). No DOM, no editor state.

// D7: the languages the highlighter registers (lib/highlight.js LANGS, same
// order), each with its display name and every alias that resolves to it —
// highlight.js's own built-in aliases plus the two custom lists. A unit row
// keeps this table equal to the server's.
const CODE_LANGS = [
  { id: 'verilog', label: 'Verilog', aliases: ['v', 'sv', 'svh', 'systemverilog'] },
  { id: 'python', label: 'Python', aliases: ['py', 'gyp', 'ipython'] },
  { id: 'bash', label: 'Bash', aliases: ['sh', 'zsh', 'shell'] },
  { id: 'c', label: 'C', aliases: ['h'] },
  { id: 'cpp', label: 'C++', aliases: ['cc', 'c++', 'h++', 'hpp', 'hh', 'hxx', 'cxx'] },
  { id: 'json', label: 'JSON', aliases: ['jsonc'] },
  { id: 'yaml', label: 'YAML', aliases: ['yml'] },
  { id: 'tcl', label: 'Tcl', aliases: ['tk'] },
  { id: 'makefile', label: 'Makefile', aliases: ['mk', 'mak', 'make'] },
  { id: 'javascript', label: 'JavaScript', aliases: ['js', 'jsx', 'mjs', 'cjs'] },
  { id: 'diff', label: 'Diff', aliases: ['patch'] },
  { id: '', label: '純文字', aliases: ['plaintext', 'text', 'txt'] },
];

function firstWord(info) {
  return String(info || '').trim().split(/\s+/)[0] || '';
}

// The chip's text for a fence info string: the first word's language name,
// aliases resolved; empty is 純文字; an unknown word is shown as written.
function langLabel(info) {
  const word = firstWord(info);
  if (!word) return '純文字';
  const w = word.toLowerCase();
  for (const l of CODE_LANGS) {
    if ((l.id && l.id === w) || l.aliases.indexOf(w) !== -1) return l.label;
  }
  return word;
}

// The language menu's filter: case-insensitive prefix on id, label or alias.
function filterLangs(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return CODE_LANGS.slice();
  return CODE_LANGS.filter((l) =>
    (l.id && l.id.indexOf(q) === 0) || l.label.toLowerCase().indexOf(q) === 0 ||
    l.aliases.some((a) => a.indexOf(q) === 0));
}

// Replace the info string's first word; '' removes it. The other words are
// kept, single-spaced.
function setFenceLang(info, lang) {
  const words = String(info || '').trim().split(/\s+/).filter(Boolean);
  const rest = words.slice(1);
  return (lang ? [lang].concat(rest) : rest).join(' ');
}

// blockLines[0] must open a fence (up to 3 spaces, then 3+ backticks or
// tildes). CommonMark: a backtick fence's info string may not hold a backtick
// (that line is inline code). Body lines are returned raw (indentation
// included); the closer is the first line of 0-3 spaces + the same char at
// least `open` times + nothing else. No closer: the block runs to the end.
function parseFence(blockLines) {
  if (!blockLines || !blockLines.length) return null;
  const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(blockLines[0]);
  if (!m) return null;
  const char = m[2][0];
  const info = m[3].trim();
  if (char === '`' && info.indexOf('`') !== -1) return null;
  const open = m[2].length;
  const closer = new RegExp('^ {0,3}' + (char === '`' ? '`' : '~') + '{' + open + ',}[ \\t]*$');
  const body = [];
  let closed = false;
  for (let i = 1; i < blockLines.length; i++) {
    if (closer.test(blockLines[i])) { closed = true; break; }
    body.push(blockLines[i]);
  }
  return { indent: m[1], char, open, info, body, closed };
}

// D10: n = max(3, the opening length, the longest run of the fence char
// anywhere in the body + 1). The body is written as given.
function buildFence(f) {
  let longest = 0;
  const re = f.char === '~' ? /~+/g : /`+/g;
  for (const line of f.body) {
    let r;
    re.lastIndex = 0;
    while ((r = re.exec(line))) if (r[0].length > longest) longest = r[0].length;
  }
  const n = Math.max(3, f.open || 3, longest + 1);
  const bar = f.indent + f.char.repeat(n);
  return [bar + f.info].concat(f.body, [bar]);
}

// D3 Enter: a newline plus the current line's leading whitespace (only as far
// as the caret when the caret sits inside the indentation).
function newlineWithIndent(text, pos) {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const ws = /^[ \t]*/.exec(text.slice(lineStart))[0];
  const indent = ws.slice(0, Math.max(0, Math.min(ws.length, pos - lineStart)));
  return { text: text.slice(0, pos) + '\n' + indent + text.slice(pos), caret: pos + 1 + indent.length };
}

// D3 Tab / Shift+Tab over a selection (R42). Touched lines are those that
// intersect [selStart, selEnd]; when the selection is not collapsed and its
// end sits at column 0 of a line, that line is not touched. Indent adds two
// spaces; dedent removes up to two leading spaces. A position on a touched
// line keeps its column relative to the line's text (indent: a column-0
// position moves with the text, unlike VS Code; dedent: clamps at the line
// start); positions on other lines just follow the text.
function indentLines(text, selStart, selEnd, dedent) {
  const lines = text.split('\n');
  const starts = [];
  let off = 0;
  for (const l of lines) { starts.push(off); off += l.length + 1; }
  const touched = lines.map((l, i) => {
    const s = starts[i], e = s + l.length;
    if (!(s <= selEnd && e >= selStart)) return false;
    if (selEnd > selStart && s === selEnd) return false;
    return true;
  });
  const delta = lines.map((l, i) => {
    if (!touched[i]) return 0;
    if (!dedent) return 2;
    const lead = /^ */.exec(l)[0].length;
    return -Math.min(2, lead);
  });
  const newStarts = [];
  let n = 0;
  for (let i = 0; i < lines.length; i++) { newStarts.push(n); n += lines[i].length + delta[i] + 1; }
  const out = lines.map((l, i) => (delta[i] > 0 ? '  ' + l : delta[i] < 0 ? l.slice(-delta[i]) : l));
  function map(pos) {
    let i = lines.length - 1;
    while (i > 0 && starts[i] > pos) i--;
    const col = pos - starts[i];
    return newStarts[i] + (delta[i] < 0 ? Math.max(0, col + delta[i]) : col + delta[i]);
  }
  return { text: out.join('\n'), selStart: map(selStart), selEnd: map(selEnd) };
}

// The edit's own undo stack (native undo dies when re-colouring replaces the
// innerHTML). Snap = { text, selStart, selEnd }. A push whose text equals the
// current one is not a step; a push drops the redo tail; the stack keeps the
// last `cap` snapshots.
class TextHistory {
  constructor(initial, cap) {
    this.cap = cap || 200;
    this.stack = [initial];
    this.i = 0;
  }
  push(snap) {
    if (snap.text === this.stack[this.i].text) {
      this.stack[this.i] = snap;
      return;
    }
    this.stack.length = this.i + 1;
    this.stack.push(snap);
    if (this.stack.length > this.cap) this.stack.shift();
    this.i = this.stack.length - 1;
  }
  undo() {
    if (this.i <= 0) return null;
    this.i--;
    return this.stack[this.i];
  }
  redo() {
    if (this.i >= this.stack.length - 1) return null;
    this.i++;
    return this.stack[this.i];
  }
}

return { CODE_LANGS, langLabel, filterLangs, parseFence, buildFence, setFenceLang,
  newlineWithIndent, indentLines, TextHistory };
});
