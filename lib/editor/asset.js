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
  if (base === '.' || base === '..' || base === '') base = 'file';
  // Strip the extension: the last '.' in the segment, as long as it is not
  // the segment's very first character (that makes '.png' a dotfile stem,
  // not an extension marker with nothing in front of it -- still a defined,
  // deterministic result, just not a stripped one).
  var dot = base.lastIndexOf('.');
  var stem = dot > 0 ? base.slice(0, dot) : base;
  if (stem === '') stem = 'file';
  return stem;
}

// mime -> extension, or null when it is outside EXT_FOR_MIME. Never guesses
// from the filename -- that is the whole point of gating on the whitelist.
function extFor(mime) {
  var key = String(mime === null || mime === undefined ? '' : mime);
  return Object.prototype.hasOwnProperty.call(EXT_FOR_MIME, key) ? EXT_FOR_MIME[key] : null;
}

// Append '-2', '-3', ... immediately before the extension until `base` (or
// a suffixed variant of it) is absent from `existing`. `base` may or may
// not carry an extension itself -- both shapes are real call sites: a
// standalone full filename ('a.png') here, and a bare stem ('x', with the
// caller appending extFor(mime)'s result afterward) in the composed
// pipeline the brief specifies.
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
function isWithin(dir, target) {
  var d = normalizeSegments(dir);
  var t = normalizeSegments(target);
  if (t === d) return false;
  return t.indexOf(d + '/') === 0;
}

return { sanitizeName: sanitizeName, extFor: extFor, uniqueName: uniqueName, relPath: relPath, isWithin: isWithin };
});
