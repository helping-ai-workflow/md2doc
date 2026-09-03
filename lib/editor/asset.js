'use strict';
/* UMD, same shape as convert-md.js: `require`-able in node for the unit
   tests, and injected into the editor page as `window.md2docAsset`
   (lib/editor/server.js) for the parts the client UI needs (sanitizeName /
   extFor / uniqueName / relPath). client.js is inlined into the page as a
   plain <script>, not bundled, so a bare top-level require(...) here would
   be an undefined identifier in the browser and take down the whole
   injected script -- see the comment at the top of convert-md.js.

   isWithin is NODE/SERVER ONLY: the browser side never calls it (there is
   no filesystem on that side to check containment against; only
   lib/editor/server.js, guarding the real write, calls it). Even so it does
   NOT `require('path')` -- per the ruling for this module, every function
   here is plain string arithmetic, so the file stays safe to inject
   unconditionally regardless of which functions a given caller uses. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.md2docAsset = factory();
})(typeof self !== 'undefined' ? self : this, function () {

// The image-drop endpoint accepts exactly these encoded raster formats.
// image/svg+xml is deliberately NOT here: an SVG file can carry an inline
// <script>/<foreignObject> payload, and this whitelist is the only gate
// between an attacker-controlled MIME string and a file written to disk --
// widening it to vector formats trades a decode convenience for a stored-XSS
// vector, which is not a trade this endpoint gets to make silently.
var EXT_FOR_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// A stem is "reserved" -- unusable, must fall back -- if it is exactly '.',
// exactly '..', or empty. This check is re-run after EVERY transformation
// that can change the string, not just once at the top: fix-round-1 found
// that the extension-stripping slice below can manufacture a fresh '..' out
// of an input the top-of-function check never saw (`'...'` -> base `'...'`,
// which is not '.'/'..'/'' so it passes unmodified, then
// `stem = base.slice(0, base.lastIndexOf('.'))` = `'..'`, returned
// unchecked). The function whose entire job is rejecting '..' must not be
// able to manufacture one partway through its own body.
function isReservedStem(s) {
  return s === '.' || s === '..' || s === '';
}

// The longest extension this module ever attaches (see EXT_FOR_MIME) is
// '.webp' at 5 bytes; reserving that much headroom out of the 255-byte
// filename budget guarantees stem + extension never exceeds it, without
// this function needing to know which mime the caller will pick.
var MAX_NAME_BYTES = 255;
var MAX_EXT_BYTES = Object.keys(EXT_FOR_MIME).reduce(function (m, k) {
  return Math.max(m, EXT_FOR_MIME[k].length);
}, 0);
var MAX_STEM_BYTES = MAX_NAME_BYTES - MAX_EXT_BYTES;

// UTF-8 byte length of one Unicode CODE POINT (not a UTF-16 code unit).
function utf8ByteLen(codePoint) {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

// Truncates `s` to at most `maxBytes` UTF-8 bytes without splitting a
// Unicode code point (iterates via Array.from, which walks code points, not
// UTF-16 code units -- load-bearing for CJK/astral characters, both
// realistic in a pasted screenshot filename). No Buffer / TextEncoder
// dependency, so this stays safe to run in the browser build of this
// module too, same as everything else in this file.
function truncateUtf8(s, maxBytes) {
  var out = '';
  var used = 0;
  var chars = Array.from(s);
  for (var i = 0; i < chars.length; i++) {
    var len = utf8ByteLen(chars[i].codePointAt(0));
    if (used + len > maxBytes) break;
    out += chars[i];
    used += len;
  }
  return out;
}

// Only the last path segment survives, and only its stem (the caller
// re-attaches whatever extFor(mime) decides -- see extFor below -- so
// whatever extension the ORIGINAL name carried, spoofed or not, is
// discarded here, not preserved).
//
// Three separator families are stripped, not just '/':
//   '/'  -- the traversal vector this endpoint obviously has to defend
//           ('../../etc/passwd', 'a/b.png').
//   '\\' -- Windows is a supported target for this tool even though this
//           process may run on Linux; 'C:\Windows\x.png' must not survive
//           as a literal filename component either.
//   ':'  -- NTFS Alternate Data Stream syntax ('x.png:evil' writes into a
//           stream named 'evil' *on* the real file 'x.png') and the drive
//           letter ('C:'). Both are neutralized by taking only what
//           precedes the first colon found in the segment that already
//           survived the '/' and '\\' split.
//
// The result is also capped to MAX_STEM_BYTES (UTF-8 bytes), truncating
// only the stem -- there is no extension left to truncate at this point,
// it has already been stripped -- so a long pasted-screenshot filename
// cannot reach fs.writeFileSync and fail with ENAMETOOLONG.
function sanitizeName(filename) {
  var s = String(filename === null || filename === undefined ? '' : filename);
  s = s.split('\\').join('/');
  var parts = s.split('/');
  var base = parts[parts.length - 1];
  var colonIdx = base.indexOf(':');
  if (colonIdx !== -1) base = base.slice(0, colonIdx);
  // '..' and '.' are meaningful only as path SEGMENTS; once nothing but the
  // last segment is left, they carry no traversal power any more, but they
  // are still not usable file stems, so map them (and the empty string, the
  // "no filename at all" case) onto one defined fallback.
  if (isReservedStem(base)) base = 'file';
  // Strip the extension: the last '.' in the segment, as long as it is not
  // the segment's very first character (that makes '.png' a dotfile stem,
  // not an extension marker with nothing in front of it -- still a defined,
  // deterministic result, just not a stripped one).
  var dot = base.lastIndexOf('.');
  var stem = dot > 0 ? base.slice(0, dot) : base;
  // Re-validate: this slice can manufacture '.', '..' or '' out of an
  // all-dots (or dot-prefixed) `base` that the check above never caught.
  if (isReservedStem(stem)) stem = 'file';
  stem = truncateUtf8(stem, MAX_STEM_BYTES);
  // Re-validate again: belt-and-suspenders against a future MAX_STEM_BYTES
  // shrinking below 2 and cutting a legitimate '..foo'-shaped stem down to
  // a bare '..'. Not reachable at the current 250-byte budget, but the
  // point of this whole fix round is that "not reachable today" is not the
  // same guarantee as "provably never produces '.'/'..'/''".
  if (isReservedStem(stem)) stem = 'file';
  return stem;
}

// mime -> extension, or null when it is outside EXT_FOR_MIME. Never guesses
// from the filename -- that is the whole point of gating on the whitelist.
function extFor(mime) {
  var key = String(mime === null || mime === undefined ? '' : mime);
  return Object.prototype.hasOwnProperty.call(EXT_FOR_MIME, key) ? EXT_FOR_MIME[key] : null;
}

// CONTRACT (fix-round-1 ruling): `base` is a FULL FILENAME, extension
// included (e.g. 'a.png'), and `existing` is a raw directory listing of the
// same shape (e.g. fs.readdir()'s output -- also full filenames). The
// integration task composes the candidate as
// `uniqueName(sanitizeName(name) + extFor(mime), existing)` BEFORE calling
// this function, not `uniqueName(stem, existing)` with the extension
// appended after: a bare stem checked against an extension-bearing listing
// silently defeats collision detection ('x' !== 'x.png' as far as
// indexOf() is concerned, even though 'x.png' really is taken). This
// function's own contract does not change to accommodate that -- it stays
// the plain, already-tested extension-aware suffixer pinned by
// uniqueName('a.png', ['a.png','a-2.png']) -> 'a-3.png'; only the caller's
// composition order does.
//
// Appends '-2', '-3', ... immediately before the extension until `base`
// (or a suffixed variant of it) is absent from `existing`.
function uniqueName(base, existing) {
  var list = Array.isArray(existing) ? existing : [];
  var s = String(base === null || base === undefined ? '' : base);
  var dot = s.lastIndexOf('.');
  var stem = dot > 0 ? s.slice(0, dot) : s;
  var ext = dot > 0 ? s.slice(dot) : '';
  if (list.indexOf(s) === -1) return s;
  var n = 2;
  for (;;) {
    var candidate = stem + '-' + n + ext;
    if (list.indexOf(candidate) === -1) return candidate;
    n += 1;
  }
}

// Pure formatter: the caller is expected to have already run `name` through
// sanitizeName / extFor / uniqueName. relPath performs no validation of its
// own -- it is not the safety boundary; sanitizeName and isWithin are.
function relPath(name) {
  return 'assets/' + String(name === null || name === undefined ? '' : name);
}

// POSIX-style '.'/'..' resolution over a '/'-joined string, without pulling
// in node's `path` module (see the file-header comment for why). Good
// enough for isWithin's job: `dir` and `target` are both server-side
// absolute filesystem paths built by lib/editor/server.js, not user input
// carrying Windows separators -- sanitizeName is what stands between user
// input and either argument here.
function normalizeSegments(p) {
  var s = String(p === null || p === undefined ? '' : p);
  var abs = s.indexOf('/') === 0;
  var parts = s.split('/');
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var seg = parts[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
      // an absolute path's '..' past the root has nowhere to go; drop it
      continue;
    }
    out.push(seg);
  }
  return (abs ? '/' : '') + out.join('/');
}

// true iff `target`, once '.'/'..' is resolved away, is a strict descendant
// of `dir` (also resolved). This is the third and final boundary: even if
// sanitizeName's basename-only contract were somehow bypassed upstream, a
// resolved target that escapes `dir` -- or merely shares its string prefix
// without a path separator between them ('/x' vs '/xy/...') -- is refused.
// `target === dir` is also refused: every real caller appends a filename to
// `dir` before checking, so equality is never the legitimate case, and
// accepting it would just be a hole with no corresponding valid use.
//
// CONTRACT (fix-round-1 ruling, binding): `dir` and `target` MUST already
// be '/'-normalized POSIX paths when passed in. This function does not
// understand '\\' as a separator -- ruled POSIX-only on purpose, so this
// file keeps avoiding node's `path` module; normalizing a native-Windows
// path to '/' before calling this is the CALLER's job (the integration
// task's server-side boundary, not this module). A '\\'-separated `target`
// is not silently accepted as "within" -- normalizeSegments treats the
// whole backslash-joined string as one path segment, so it can never match
// the '/'-joined `dir` prefix, and isWithin FAILS CLOSED (returns false)
// rather than wrongly permitting a traversal. Confirmed by the fix-round-1
// review: this is a functional bug on native Windows (a legitimate target
// gets refused), not a security hole.
function isWithin(dir, target) {
  var d = normalizeSegments(dir);
  var t = normalizeSegments(target);
  if (t === d) return false;
  return t.indexOf(d + '/') === 0;
}

return { sanitizeName: sanitizeName, extFor: extFor, uniqueName: uniqueName, relPath: relPath, isWithin: isWithin };
});
