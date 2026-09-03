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

// string -> {lines, changed}, the inverse of toSource. `lines` is always a
// faithful parse of `text` (universal-regex split, see the module header),
// independent of `prevLines` -- what `prevLines` controls is only the
// `changed` flag's meaning, per the plan-owner ruling below.
//
// CONTRACT (plan-owner ruling, fix round 1 -- do not "optimize" this back):
// `prevLines` is the lines[] the source textarea was seeded from -- the
// pre-edit state a real caller (client.js) always has on hand when it
// calls this on the way OUT of source mode. `prevLines` is optional in
// ARITY ONLY, so the name `fromSource(text, eol)` and every two-arg call
// site keep parsing correctly; it is NOT optional in the sense of "safe to
// omit and get a sensible answer for `changed`":
//
//   - `prevLines` GIVEN (array): `changed` is a real content diff against
//     it (`!linesEqual(lines, prevLines)`). This is the only form that can
//     tell "the user edited a line" apart from "untouched," and it is the
//     form the integration task (client.js) must call.
//   - `prevLines` OMITTED: `changed` is unconditionally `true`.
//
// Why `true` and not a "did this round-trip cleanly" fidelity check (the
// round 1 defect): a pure function of `(text, eol)` alone has nothing to
// diff an edit against, and a same-eol in-place character edit -- the
// overwhelming majority of real edits -- round-trips through split+join
// exactly as cleanly as untouched text does. A fidelity-based `changed`
// therefore reports `false` (unchanged) for most real edits too, and the
// caller's contract is "changed: false means do not write the file" --
// which silently discards the user's edit. That is a data-loss default.
// `changed: true` is the fail-safe direction: the unknown case reads as
// "assume it was edited," so the caller writes; the worst case is one
// needless write of byte-identical content, never a dropped edit.
function fromSource(text, eol, prevLines) {
  // `eol` is accepted for API symmetry with `toSource(lines, eol)` and is
  // NOT used here: parsing is always the universal three-way split (module
  // header), never a literal-`eol` split, so there is nothing for it to do.
  const s = typeof text === 'string' ? text : String(text == null ? '' : text);
  const lines = s.split(/\r\n|\r|\n/);
  const changed = Array.isArray(prevLines) ? !linesEqual(lines, prevLines) : true;
  return { lines, changed };
}

return { MODES, next, toSource, fromSource };
});
