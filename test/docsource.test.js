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

// --- toSource / fromSource: round trip is byte-identical -------------------
// (changed === false only in the 3-arg form, where there is a prevLines
// reference to diff against; changed === true unconditionally in the 2-arg
// form -- see the fixture loop below and the module's fromSource contract
// comment for why.)

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

  // The 3-arg form -- fromSource(text, eol, prevLines) -- is invariant 1's
  // real load-bearing check: a no-op round trip through the source view
  // must give byte-identical lines[] AND changed === false, so the caller
  // knows not to write. This is the form the integration task must call.
  const result3 = ds.fromSource(src, f.eol, f.lines);
  eq(result3.lines, f.lines, 'round trip byte-identical lines[] (3-arg): ' + f.name);
  eq(result3.changed, false, 'round trip changed === false (3-arg, prevLines given): ' + f.name);
  // toSource(fromSource(...).lines, eol) must reproduce the exact same string
  // -- the other half of "byte-identical."
  eq(ds.toSource(result3.lines, f.eol), src, 'the string itself round-trips: ' + f.name);

  // The 2-arg form -- no prevLines -- still parses `lines` correctly (the
  // parse itself never depends on prevLines), but per the plan-owner
  // ruling `changed` is unconditionally true here: with nothing to diff
  // against, "unknown" must fail toward "assume edited," never toward
  // "assume unchanged," because the caller's contract for changed:false is
  // "do not write the file."
  const result2 = ds.fromSource(src, f.eol);
  eq(result2.lines, f.lines, 'round trip byte-identical lines[] (2-arg): ' + f.name);
  eq(result2.changed, true, 'no prevLines => changed === true even on a true no-op (2-arg): ' + f.name);
}

// --- fromSource: a real edit is detected, and only that line differs -------
//
// A pure fromSource(text, eol) cannot, by construction, tell "the user
// edited this" apart from "this text happens to already be the canonical
// join of some lines[]" when the edit does not touch any line break --
// splitting-then-rejoining reproduces the edited string just as exactly as
// it reproduces the untouched one. Only the 3-arg form -- fromSource(text,
// eol, prevLines) -- can tell them apart, by diffing against the lines[]
// the source view was seeded from. That is why this is the ONLY form the
// integration task (client.js) is allowed to rely on for `changed`.
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

  // The unedited round trip, by contrast, reports changed === false when a
  // prevLines reference is supplied and matches -- this is the only case
  // in the whole module where changed can legitimately be false.
  const unchanged = ds.fromSource(src, eol, original);
  eq(unchanged.changed, false, 'no edit + matching prevLines => changed === false');
  eq(unchanged.lines, original, 'no edit => lines are byte-identical to the original');

  // Plan-owner ruling, fix round 1: the 2-arg form (no prevLines) must
  // default changed to true UNCONDITIONALLY -- not "true only for edits
  // that happen to break round-trip fidelity." Pin both directions with
  // the SAME source text here: edited or not, omitting prevLines always
  // reads as "assume edited."
  const twoArgEdited = ds.fromSource(editedSrc, eol);
  eq(twoArgEdited.changed, true, '2-arg, edited text: changed === true');
  const twoArgUnedited = ds.fromSource(src, eol);
  eq(twoArgUnedited.changed, true,
    '2-arg, UNEDITED text (would round-trip cleanly): changed === true anyway -- ' +
    'this is the fail-safe default, not a fidelity check');
}

// --- fromSource: 2-arg parsing is still correct on mixed-EOL text ----------
//
// The `lines` result never depends on prevLines or on the declared `eol`
// matching what's actually in `text` -- parsing is always the universal
// three-way split. `changed` is still unconditionally true with no
// prevLines, same as every other 2-arg case above; this fixture exists to
// confirm the parse itself (not just `changed`) is unaffected by a
// declared eol that doesn't match the text's actual line breaks.
{
  const mixed = 'a\r\nb\nc\r\n'; // declared eol is '\r\n', but line 2's break is bare '\n'
  const result = ds.fromSource(mixed, '\r\n');
  eq(result.lines, ['a', 'b', 'c', ''], 'mixed-eol text still parses via the universal regex');
  eq(result.changed, true, '2-arg default holds here too');
}

// --- mutation-kill anchor -----------------------------------------------
// (documented in task-D-report.md: forcing fromSource to always return
// changed: true unconditionally -- collapsing the 3-arg content-diff
// branch too -- is caught by the first 3-arg round-trip fixture assertion
// above -- `result3.changed === false` -- which fails immediately.)

console.log('docsource.test.js OK (' + checks + ' checks)');
