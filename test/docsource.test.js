'use strict';
const assert = require('assert');
const ds = require('../lib/editor/docsource.js');

let checks = 0;
function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg + '\n  actual:   ' + JSON.stringify(actual) +
    '\n  expected: ' + JSON.stringify(expected));
  checks += 1;
}

// --- MODES / next(): the three-state cycle ----------------------------------

eq(ds.MODES, ['edit', 'source', 'preview'], 'MODES is the exact order the plan specifies');

eq(ds.next('edit'), 'source', 'edit -> source');
eq(ds.next('source'), 'preview', 'source -> preview');
eq(ds.next('preview'), 'edit', 'preview -> edit: the cycle closes');

// Walking the full cycle from any starting point returns to that same start.
for (const start of ds.MODES) {
  let m = start;
  for (let i = 0; i < ds.MODES.length; i += 1) m = ds.next(m);
  eq(m, start, 'three next() calls from ' + start + ' return to ' + start);
}

// Defensive: an unrecognized mode does not throw, and lands on a real mode.
eq(ds.MODES.includes(ds.next('bogus')), true, 'an unknown mode falls back to a real mode, not a throw');

// --- toSource / fromSource: round trip is byte-identical, changed === false -

// Fixture set drawn straight from the brief: plain LF, CRLF, trailing blank
// lines, and a fenced code block whose body contains a literal '---' (must
// round-trip as plain content, not be treated as a YAML/thematic-break
// delimiter -- this module knows nothing about markdown semantics at all).
const fixtures = [
  { name: 'plain LF, no trailing blank', lines: ['# Title', '', 'body text', 'more body'], eol: '\n' },
  { name: 'CRLF file', lines: ['# Title', '', 'CRLF body', ''], eol: '\r\n' },
  { name: 'bare CR file', lines: ['a', 'b', 'c'], eol: '\r' },
  { name: 'trailing blank lines (multiple)', lines: ['a', 'b', '', '', ''], eol: '\n' },
  { name: 'no trailing newline at all', lines: ['a', 'b', 'c'], eol: '\n' },
  { name: 'single empty document', lines: [''], eol: '\n' },
  { name: 'fenced code containing a literal ---', lines: ['```', 'a', '---', 'b', '```'], eol: '\n' },
  { name: 'fenced code containing --- with CRLF file', lines: ['```yaml', '---', 'k: v', '---', '```'], eol: '\r\n' },
  // Note: lines: [] is deliberately NOT a fixture here. The string model
  // this module works in cannot represent it: ''.split(/\r\n|\r|\n/) is
  // [''], one empty line, never []. This mirrors how the app's canonical
  // lines[] was produced in the first place -- server.js:154's
  // `mdText.split(/\r\n|\r|\n/)` -- which likewise never returns an empty
  // array for any string input, including ''. An empty document is always
  // lines: [''].
  { name: 'truly empty document (no content, no trailing newline)', lines: [''], eol: '\n' },
];

for (const f of fixtures) {
  const src = ds.toSource(f.lines, f.eol);
  const result = ds.fromSource(src, f.eol);
  eq(result.lines, f.lines, 'round trip byte-identical lines[]: ' + f.name);
  eq(result.changed, false, 'round trip changed === false: ' + f.name);
  // toSource(fromSource(...).lines, eol) must reproduce the exact same string
  // -- the other half of "byte-identical."
  eq(ds.toSource(result.lines, f.eol), src, 'the string itself round-trips: ' + f.name);
}

// --- fromSource: a real edit is detected, and only that line differs -------
//
// A pure fromSource(text, eol) cannot, by construction, tell "the user
// edited this" apart from "this text happens to already be the canonical
// join of some lines[]" when the edit does not touch any line break --
// splitting-then-rejoining reproduces the edited string just as exactly as
// it reproduces the untouched one, so the two-arg round-trip check alone
// is provably unable to distinguish them. That's why fromSource accepts an
// OPTIONAL third argument, `prevLines`: the lines[] the source view was
// seeded from. A real caller (client.js, a later track) always has this on
// hand -- it's the very state the textarea was opened from -- so this is
// the shape a real "did anything change" check takes.
{
  const original = ['# Title', 'first paragraph', 'second paragraph', ''];
  const eol = '\n';
  const src = ds.toSource(original, eol);
  const editedLines = original.slice();
  editedLines[2] = 'second PARAGRAPH edited'; // one line, mid-content, no newline touched
  const editedSrc = ds.toSource(editedLines, eol);

  const result = ds.fromSource(editedSrc, eol, original);
  eq(result.lines, editedLines, 'fromSource still parses the edited text correctly');
  eq(result.changed, true, 'changed === true when compared against the pre-edit lines[]');

  let diffCount = 0;
  for (let i = 0; i < original.length; i += 1) {
    if (original[i] !== result.lines[i]) diffCount += 1;
  }
  eq(diffCount, 1, 'exactly one line differs from the original');

  // The unedited round trip, by contrast, reports changed === false even
  // when a prevLines reference is supplied and matches.
  const unchanged = ds.fromSource(src, eol, original);
  eq(unchanged.changed, false, 'no edit + matching prevLines => changed === false');
  eq(unchanged.lines, original, 'no edit => lines are byte-identical to the original');

  // Same edit, but the caller supplies no prevLines at all: the two-arg
  // form falls back to round-trip fidelity, which the edited text still
  // satisfies (no line break was touched), so changed === false here. This
  // is the documented, correct two-arg behavior -- not a bug -- and pins
  // the exact case the paragraph above explains.
  const twoArg = ds.fromSource(editedSrc, eol);
  eq(twoArg.changed, false,
    'two-arg fallback: an in-place edit that touches no line break is indistinguishable from untouched');
}

// --- fromSource: the two-arg fallback still catches real fidelity loss -----
//
// Text whose line breaks are NOT uniformly `eol` -- e.g. a stray '\n' inside
// a file whose canonical eol is '\r\n' -- fails the round-trip check even
// with no prevLines given, because rejoining the parsed lines with the
// declared `eol` no longer reproduces the original string.
{
  const mixed = 'a\r\nb\nc\r\n'; // declared eol is '\r\n', but line 2's break is bare '\n'
  const result = ds.fromSource(mixed, '\r\n');
  eq(result.lines, ['a', 'b', 'c', ''], 'mixed-eol text still parses via the universal regex');
  eq(result.changed, true, 'mixed-eol text fails the two-arg round-trip fidelity check');
}

// --- mutation-kill anchor -----------------------------------------------
// (documented in task-D-report.md: forcing fromSource to always return
// changed: true is caught by the very first round-trip fixture assertion
// above -- `result.changed === false` -- which fails immediately.)

console.log('docsource.test.js OK (' + checks + ' checks)');
