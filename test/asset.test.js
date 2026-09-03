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
