'use strict';
/* UMD, same shape as convert-md.js / lineops.js: `require`-able in node for
   the unit tests, and injected into the editor page as
   `window.md2docDocSource` (lib/editor/server.js). client.js is inlined
   into the page as a plain <script>, not bundled, so a bare top-level
   require('./docsource.js') there would be an undefined identifier in the
   browser and would kill the whole injected script. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.md2docDocSource = factory();
})(typeof self !== 'undefined' ? self : this, function () {

// Pure state machine + lines[]<->string conversion for the "追加 4 全文原始碼
// 逃生口" (whole-document source escape hatch): 編輯 ⇄ 原始碼 ⇄ 預覽.
//
// EOL representation: `eol` is always a single literal separator string --
// '\n', '\r\n' or '\r' -- the same convention server.js already establishes
// at load time (majority-vote across the file, ties go to '\n'; see
// server.js's `eol` derivation next to its own `mdText.split(/\r\n|\r|\n/)`).
// This module does not re-derive eol and does not guess per-line; it is
// handed the file's one canonical eol and uses it for every join.
//
// Splitting, though, is always done with the UNIVERSAL three-way regex
// `/\r\n|\r|\n/`, never with a literal `eol`-only split. Two reasons:
//   1. Symmetry with how `lines[]` was produced in the first place
//      (server.js:154) -- if load used the universal regex, from-source
//      must use the same one, or a file whose canonical eol is '\r\n' but
//      whose textarea content picked up a stray '\n' (browsers normalize
//      textarea .value to '\n' on some paste paths) would silently lose a
//      line instead of being read back correctly.
//   2. `\r\n` is listed before the two single-character alternatives, so a
//      CRLF pair is always consumed as ONE separator, never split into a
//      spurious blank line between a lone \r and a lone \n.
const MODES = ['edit', 'source', 'preview'];

// Three-state cycle: edit -> source -> preview -> edit. An unrecognized
// mode (defensive: a caller passing something stale) falls back to the
// first state rather than throwing, matching how the rest of this module
// prefers a safe default over a thrown exception for malformed input.
function next(mode) {
  const idx = MODES.indexOf(mode);
  return MODES[(idx + 1) % MODES.length];
}

// lines[] -> the whole document as one string, for seeding the source
// textarea. `lines` mirrors the app's canonical model (server.js's
// `mdText.split(/\r\n|\r|\n/)`): a trailing '' entry represents a final
// trailing newline in the source file, no trailing '' entry represents a
// file with no trailing newline. Plain join reproduces exactly that.
function toSource(lines, eol) {
  const arr = Array.isArray(lines) ? lines : [];
  const sep = typeof eol === 'string' && eol !== '' ? eol : '\n';
  return arr.join(sep);
}

function linesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// string -> {lines, changed}, the inverse of toSource. `prevLines` is an
// OPTIONAL third argument (not part of the frozen `fromSource(text, eol)`
// two-arg call the plan documents -- every call site that omits it keeps
// working exactly as documented): when a caller already holds the lines[]
// the textarea was seeded from, passing it here lets `changed` answer the
// question that actually matters at the call site -- "did the user's edit
// change anything, or can I skip the write?" -- instead of the strictly
// weaker "did this string fail to round-trip through split+join," which
// cannot detect an in-place character edit that leaves every line break
// untouched (a pure function of (text, eol) alone provably cannot tell
// "edited" apart from "untouched" for that case; see docsource.test.js's
// comment on the one-character-edit fixture for the worked example).
//
// Without `prevLines`, `changed` falls back to that weaker round-trip
// check: did splitting `text` and rejoining with `eol` reproduce `text`
// exactly? This is still meaningful on its own -- it is exactly what makes
// invariant 1's `fromSource(toSource(lines, eol), eol)` round trip return
// `changed === false` for arbitrary `lines`, since `toSource` only ever
// joins with the literal `eol` separator, so re-splitting with the
// universal regex and rejoining with the same `eol` always reconstructs
// that specific string byte-for-byte.
function fromSource(text, eol, prevLines) {
  const sep = typeof eol === 'string' && eol !== '' ? eol : '\n';
  const s = typeof text === 'string' ? text : String(text == null ? '' : text);
  const lines = s.split(/\r\n|\r|\n/);
  const changed = Array.isArray(prevLines)
    ? !linesEqual(lines, prevLines)
    : toSource(lines, sep) !== s;
  return { lines, changed };
}

return { MODES, next, toSource, fromSource };
});
