'use strict';
const assert = require('assert');
const asset = require('../lib/editor/asset.js');

let checks = 0;
function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg + '\n  actual:   ' + JSON.stringify(actual) +
    '\n  expected: ' + JSON.stringify(expected));
  checks += 1;
}

// ============================================================================
// sanitizeName -- attacker-supplied filenames. This is the write path: the
// tests are written like an attacker, not like a happy-path smoke test.
// ============================================================================

eq(asset.sanitizeName('../../etc/passwd'), 'passwd', 'classic ../ traversal is reduced to the basename');
eq(asset.sanitizeName('a/b.png'), 'b', 'a nested path keeps only the last segment, extension stripped');
eq(asset.sanitizeName('/etc/passwd'), 'passwd', 'a bare absolute path likewise');
eq(asset.sanitizeName('../../../../../../etc/shadow'), 'shadow', 'deep traversal, still just the basename');

// Windows is a supported target even though this suite runs on Linux: a
// backslash-delimited path and an NTFS drive letter must not survive.
eq(asset.sanitizeName('C:\\Windows\\x.png'), 'x', 'drive letter and backslash separators are stripped');
eq(asset.sanitizeName('..\\..\\Windows\\System32\\x.png'), 'x', 'backslash traversal is stripped too');

// NTFS Alternate Data Stream syntax: 'x.png:evil' names a stream called
// 'evil' ON the file 'x.png'. The colon must not reach the final name.
eq(asset.sanitizeName('x.png:evil'), 'x', 'an NTFS ADS suffix is stripped along with the extension');
eq(asset.sanitizeName('C:\\Windows\\x.png:evil'), 'x', 'drive letter AND ADS suffix together, both stripped');

// '..' and '.' carry no traversal power once they are the only thing left
// after taking the last segment, but they are not usable stems either.
eq(asset.sanitizeName('..'), 'file', 'a bare .. falls back to a defined name, not a literal ..');
eq(asset.sanitizeName('.'), 'file', 'a bare . likewise');

// Defined behavior for the edge shapes the brief calls out explicitly.
eq(asset.sanitizeName(''), 'file', 'an empty filename has a defined fallback');
eq(asset.sanitizeName('.png'), '.png', 'a pure-extension name has no content before the only dot, so nothing is stripped');
eq(asset.sanitizeName(null), 'file', 'null is coerced, not thrown on');
eq(asset.sanitizeName(undefined), 'file', 'undefined likewise');

// Only the LAST extension is stripped -- extFor governs which one is
// re-attached, not how many dots the original name happened to carry.
eq(asset.sanitizeName('archive.tar.gz'), 'archive.tar', 'only the final extension is stripped');
eq(asset.sanitizeName('noext'), 'noext', 'a name with no dot at all is returned whole');

// --- fix-round-1 CRITICAL: the extension-stripping slice must not
// manufacture a fresh '.'/'..' out of an all-dots input the top-of-function
// fallback never saw. '...' is not '.' or '..' itself, so it reached the
// slice unmodified; base.slice(0, base.lastIndexOf('.')) then sliced it
// down to exactly '..', returned unchecked, by the very function whose job
// is refusing '..'.
eq(asset.sanitizeName('...'), 'file',
  "three dots must not slice down to '..' -- the exact bug fix-round-1 found");
eq(asset.sanitizeName('....'), '...',
  "four dots slice down to three, which is NOT '.' or '..' and so is a safe, ordinary stem");
eq(asset.sanitizeName('.....'), '....', 'five dots likewise slice down to four, still safe');
// A dot-PREFIXED (not all-dots) stem can degenerate to a bare '.' the same
// way: '..foo.png' -> base '..foo.png' -> stem '..foo' (fine, 5 chars) is
// NOT the risky shape; the risky shape is when only 1-2 literal dots
// remain after the slice, e.g. an input engineered so the slice lands
// exactly on a dot boundary.
eq(asset.sanitizeName('..png'), 'file',
  "base '..png' slices at its only dot to stem '.', which must fall back, not be returned literal");

// The general property every attack string above is actually relying on:
// sanitizeName NEVER returns '.', '..', or ''. Re-checked here across the
// whole adversarial fixture list at once, not just the individual cases
// above, per the fix-round-1 ruling that this must be an enforced property,
// not an accident of whichever strings happened to get their own eq().
const SANITIZE_ADVERSARIAL_FIXTURES = [
  '../../etc/passwd', 'a/b.png', '/etc/passwd', '../../../../../../etc/shadow',
  'C:\\Windows\\x.png', '..\\..\\Windows\\System32\\x.png',
  'x.png:evil', 'C:\\Windows\\x.png:evil',
  '..', '.', '', '.png', null, undefined,
  'archive.tar.gz', 'noext',
  '...', '....', '.....', '..png', '...png', '....png',
  '/', '//', '\\', '\\\\', ':', '::', '.:', ':.',
];
for (const input of SANITIZE_ADVERSARIAL_FIXTURES) {
  const out = asset.sanitizeName(input);
  assert.notStrictEqual(out, '.', 'sanitizeName(' + JSON.stringify(input) + ') must never return "."');
  assert.notStrictEqual(out, '..', 'sanitizeName(' + JSON.stringify(input) + ') must never return ".."');
  assert.notStrictEqual(out, '', 'sanitizeName(' + JSON.stringify(input) + ') must never return ""');
  checks += 1;
}

// --- fix-round-1 MINOR: a 255-byte cap, truncating the stem only (there is
// no extension left to protect at this point -- it was already stripped).
const LONG_ASCII_STEM = 'a'.repeat(300);
const cappedAscii = asset.sanitizeName(LONG_ASCII_STEM + '.png');
assert.ok(Buffer.byteLength(cappedAscii, 'utf8') <= 250,
  'an oversized ASCII stem is capped to the 255-byte budget minus the longest whitelisted extension (.webp, 5 bytes)');
eq(cappedAscii, 'a'.repeat(250), 'the cap truncates at exactly 250 bytes for pure ASCII');
checks += 1;

// A short name is never touched by the cap.
eq(asset.sanitizeName('short.png'), 'short', 'a short stem is unaffected by the length cap');

// Multi-byte UTF-8 (CJK, 3 bytes/char in UTF-8): the cap must not split a
// code point mid-sequence. 100 '中' chars is 300 bytes uncapped; budget is
// 250 bytes, so floor(250/3) = 83 whole characters (249 bytes) survive.
const LONG_CJK_STEM = '中'.repeat(100);
const cappedCjk = asset.sanitizeName(LONG_CJK_STEM + '.png');
assert.ok(Buffer.byteLength(cappedCjk, 'utf8') <= 250,
  'a multi-byte stem is also capped to the 250-byte stem budget');
eq(cappedCjk, '中'.repeat(83), 'truncation stops at a whole code point, never splitting one mid-sequence');
checks += 1;

// --- extension-combination rule: extFor(mime) decides the OUTPUT extension,
// never the caller-claimed one. Otherwise the MIME whitelist is theater.
eq(asset.uniqueName(asset.sanitizeName('x.html'), []) + asset.extFor('image/png'), 'x.png',
  'a spoofed .html name carrying image/png data is renamed to .png, not kept as .html');

// ============================================================================
// extFor -- MIME whitelist. image/svg+xml is a deliberate exclusion: an SVG
// can carry an inline <script>, so it is not on the raster-only whitelist.
// ============================================================================

eq(asset.extFor('image/png'), '.png', 'png is whitelisted');
eq(asset.extFor('image/jpeg'), '.jpg', 'jpeg is whitelisted');
eq(asset.extFor('image/gif'), '.gif', 'gif is whitelisted');
eq(asset.extFor('image/webp'), '.webp', 'webp is whitelisted');
eq(asset.extFor('image/svg+xml'), null, 'svg is deliberately excluded (inline-script XSS risk)');
eq(asset.extFor('text/html'), null, 'an arbitrary non-image mime is rejected');
eq(asset.extFor('application/octet-stream'), null, 'a generic binary mime is rejected');
eq(asset.extFor(''), null, 'an empty mime is rejected');
eq(asset.extFor(undefined), null, 'an undefined mime is rejected, not thrown on');
eq(asset.extFor('__proto__'), null, 'a prototype-pollution-shaped key is not accidentally whitelisted');

// ============================================================================
// uniqueName -- collision suffixing, extension-aware.
// ============================================================================

eq(asset.uniqueName('a.png', ['a.png', 'a-2.png']), 'a-3.png',
  'the suffix is inserted before the extension, and climbs past every taken slot');
eq(asset.uniqueName('a.png', []), 'a.png', 'no collision, name is returned unchanged');
eq(asset.uniqueName('a.png', ['b.png']), 'a.png', 'a different existing name is not a collision');
eq(asset.uniqueName('a', ['a']), 'a-2', 'a base with no extension is suffixed directly');
eq(asset.uniqueName('a.tar.gz', ['a.tar.gz']), 'a.tar-2.gz',
  'only the LAST dot is treated as the extension boundary, matching sanitizeName');

// ============================================================================
// relPath -- pure formatter.
// ============================================================================

eq(asset.relPath('a.png'), 'assets/a.png', 'joins under the assets/ directory');
eq(asset.relPath(''), 'assets/', 'defined even for an empty name');

// ============================================================================
// isWithin -- the third boundary. Server-side only; not reachable from the
// browser at all (see the header comment in asset.js).
// ============================================================================

eq(asset.isWithin('/x', '/x/../y'), false, "'..' that escapes dir is refused");
eq(asset.isWithin('/x', '/x/y.png'), true, 'a real child of dir is accepted');
eq(asset.isWithin('/x', '/xy/z.png'), false,
  'a sibling directory that merely shares a string prefix is not "within" dir');
eq(asset.isWithin('/x', '/x'), false, 'dir itself is not within dir -- a target must be a strict descendant');
eq(asset.isWithin('/x', '/x/y/../../etc/passwd'), false, 'traversal that walks back out past dir is refused');
eq(asset.isWithin('/a/b', '/a/b/c/../d.png'), true,
  "a '..' that stays inside dir after resolution is legitimately within it");
eq(asset.isWithin('/a/b/', '/a/b/c.png'), true, 'a trailing slash on dir does not change the result');

console.log('asset.test.js OK (' + checks + ' checks)');
