'use strict';
const assert = require('assert');
const { buildBlockMap } = require('../lib/editor/blockmap.js');

const md = [
  '# Title',            // 1  heading
  '',                   // 2
  'Para one.',          // 3  paragraph
  '',                   // 4
  '| A | B |',          // 5  table
  '|---|---|',          // 6
  '| x<br>y | z |',     // 7
  '',                   // 8
  '```verilog',         // 9  code
  'module m;',          // 10
  'endmodule',          // 11
  '```',                // 12
  '',                   // 13
  '- item 1',           // 14 list
  '- item 2',           // 15
  '',                   // 16
  '> quoted',           // 17 blockquote (no trailing newline at EOF)
].join('\n');

const { blocks, lineCount } = buildBlockMap(md);

assert.strictEqual(lineCount, 17);
const expected = [
  ['heading',    1, 1],
  ['paragraph',  3, 3],
  ['table',      5, 7],
  ['code',       9, 12],
  ['li',         14, 14],
  ['li',         15, 15],
  ['blockquote', 17, 17],
];
assert.strictEqual(blocks.length, expected.length,
  'block count (space tokens excluded)');
expected.forEach(([type, s, e], i) => {
  assert.strictEqual(blocks[i].type, type, `block ${i} type`);
  assert.strictEqual(blocks[i].startLine, s, `block ${i} startLine`);
  assert.strictEqual(blocks[i].endLine, e, `block ${i} endLine`);
  assert.strictEqual(blocks[i].id, i, `block ${i} id`);
});

// non-overlap + monotonic
for (let i = 1; i < blocks.length; i++) {
  assert.ok(blocks[i].startLine > blocks[i - 1].endLine, `block ${i} disjoint`);
}

// setext heading + hr + trailing newline EOF variant
const md2 = 'Title\n=====\n\n---\n\nlast\n';
const b2 = buildBlockMap(md2).blocks;
assert.deepStrictEqual(
  b2.map((b) => [b.type, b.startLine, b.endLine]),
  [['heading', 1, 2], ['hr', 4, 4], ['paragraph', 6, 6]]
);

// per-li segmentation: each list line is its own block
{
  const md = '# H\n\n- a\n- b\n  1. c\n  2. d\n- e\n\npara';
  const { blocks } = buildBlockMap(md);
  const lis = blocks.filter((b) => b.type === 'li');
  assert.strictEqual(lis.length, 5, 'five li blocks');
  assert.deepStrictEqual(
    lis.map((b) => [b.startLine, b.endLine, b.listType, b.indent]),
    [[3, 3, 'ul', 0], [4, 4, 'ul', 0], [5, 5, 'ol', 1], [6, 6, 'ol', 1], [7, 7, 'ul', 0]]);
  assert.strictEqual(blocks.find((b) => b.type === 'list'), undefined, 'no list-container block');
  // ids strictly document-ordered
  assert.deepStrictEqual(blocks.map((b) => b.id), blocks.map((_, i) => i));
  // a NON-task li must not carry a `checked` key at all (the `if (item.task)`
  // guard's narrowness): a stray `checked: false` would be indistinguishable
  // downstream from a genuine unchecked task item.
  assert.strictEqual('checked' in lis[0], false,
    'non-task li must have no `checked` property');
}
// task list items
{
  const { blocks } = buildBlockMap('- [ ] todo\n- [x] done');
  assert.deepStrictEqual(blocks.map((b) => [b.listType, b.task, b.checked]),
    [['ul', true, false], ['ul', true, true]]);
}
// ordered × task are independent axes (GFM allows `1. [ ] a`)
{
  const { blocks } = buildBlockMap('1. [ ] alpha\n2. [x] beta\n');
  assert.deepStrictEqual(
    blocks.map((b) => [b.listType, b.task, b.checked]),
    [['ol', true, false], ['ol', true, true]],
    'an ordered task list must keep BOTH its ordered-ness and its task-ness'
  );
}
{
  const { blocks } = buildBlockMap('- plain\n- [ ] todo\n');
  assert.deepStrictEqual(
    blocks.map((b) => [b.listType, b.task]),
    [['ul', false], ['ul', true]],
    'a bullet list marks task-ness per item, list type per list'
  );
}
// multi-line li (lazy continuation) spans both lines
{
  const { blocks } = buildBlockMap('- first\n  continued\n- second');
  assert.deepStrictEqual(blocks.map((b) => [b.startLine, b.endLine]), [[1, 2], [3, 3]]);
}
// span integrity: li blocks cover the whole list token range with no overlap
{
  const { blocks } = buildBlockMap('- a\n  - b\n    - c\n- d');
  assert.deepStrictEqual(blocks.map((b) => [b.startLine, b.endLine, b.indent]),
    [[1, 1, 0], [2, 2, 1], [3, 3, 2], [4, 4, 0]]);
}

// B1: SAME-LINE NESTING. An item whose content starts with another list
// marker on the SAME line ('- - a') has a child list token whose first line IS
// the parent's own first line. Locating that child by matching its text against
// the item's lines cannot work — marked DEDENTS the child's raw to '- a', which
// never equals any line of '- - a' — so the child was skipped entirely, the
// renderer's lockstep walk ran off the end of blocks[], and the whole document
// failed to open (HTTP 500, "Cannot read properties of undefined (reading
// 'task')"). Every combination of the five markers nests this way.
{
  const MARKERS = ['-', '*', '+', '1.', '1)'];
  const MARKER_RE = /^ *(?:[-*+]|\d+[.)]) /;
  MARKERS.forEach((outer) => {
    MARKERS.forEach((inner) => {
      const md = outer + ' ' + inner + ' a\n';
      const { blocks } = buildBlockMap(md);
      const lis = blocks.filter((b) => b.type === 'li');
      assert.strictEqual(lis.length, 2,
        JSON.stringify(md) + ' must produce one block PER ITEM (outer + nested), got ' +
        lis.length);
      assert.deepStrictEqual(lis.map((b) => b.indent), [0, 1],
        JSON.stringify(md) + ': the second item is nested');
      lis.forEach((b) => {
        assert.strictEqual(b.startLine, 1,
          JSON.stringify(md) + ': both items begin on the shared first line, got ' + b.startLine);
        assert.ok(MARKER_RE.test(md.split('\n')[b.startLine - 1]),
          JSON.stringify(md) + ': startLine must name a marker line');
      });
      // ids stay 0..n-1 in document order — the invariant the renderer walks in
      // lockstep with.
      assert.deepStrictEqual(blocks.map((b) => b.id), blocks.map((_, i) => i));
    });
  });
}

// B2: a child list token must never be located by TEXT. An item containing a
// fenced or indented code block whose content happens to read like the child's
// first line matched the CODE line first, so startLine pointed inside the code:
// typing into the real nested item then landed in the fence, or destroyed the
// indented code block outright.
{
  const cases = [
    ['- a\n\n  ```\n  - b\n  ```\n\n  - b\n', 7],
    ['- a\n\n      - b\n\n  - b\n', 5],
    // Branch review, BLOCKING 2: the INLINE-CODE-SPAN shape, which is the one
    // that actually exercises indexOfAtLineStart(). Both fixtures above pass
    // on the monotonic `pos` advance alone — the `code` token claims the
    // lookalike bytes before the `list` token is searched for — so neither of
    // them reacts to dropping the line-start requirement. An inline span has
    // no token of its own to consume: `- b` sits INSIDE the parent's `text`
    // raw, which this walk deliberately skips, so a plain indexOf() from
    // pos=0 finds the parent's OWN line and the child is placed on it.
    ['- text with `- b` inline\n  - b\n', 2],
  ];
  cases.forEach(([md, expected]) => {
    const nested = buildBlockMap(md).blocks.filter((b) => b.type === 'li' && b.indent === 1);
    assert.strictEqual(nested.length, 1, JSON.stringify(md) + ': exactly one nested item');
    assert.strictEqual(nested[0].startLine, expected,
      JSON.stringify(md) + ': the nested item is the REAL one at line ' + expected +
      ', not the identical text inside the code block — got ' + nested[0].startLine +
      ' (' + JSON.stringify(md.split('\n')[nested[0].startLine - 1]) + ')');
  });

  // Branch review, BLOCKING 2 — the DIRECT assertion on the whole map, not
  // just on the nested item's startLine.
  //
  // indexOfAtLineStart() had no test of any kind: grep across lib/ and test/
  // found its definition and its single call site and nothing else. What the
  // shape below costs when the line-start requirement is dropped is not one
  // wrong startLine, it is BOTH ranges at once, and neither of them
  // announces itself:
  //
  //   correct: [{1,1},{2,2}]   broken: [{1,0},{1,1}]
  //
  // The parent's range INVERTS (endLine < startLine), which
  // blockOwnsNoLine() silently disarms rather than reports, and the child
  // now points at the parent's source line — so one real keystroke in the
  // child saves a DUPLICATED line ('  - bZ' alongside the untouched
  // '  - b'). Stated as the full [startLine, endLine] pair for every block
  // so an inverted parent cannot pass by having the right startLine.
  {
    const md = '- text with `- b` inline\n  - b\n';
    assert.deepStrictEqual(
      buildBlockMap(md).blocks.map((b) => [b.type, b.startLine, b.endLine, b.indent]),
      [['li', 1, 1, 0], ['li', 2, 2, 1]],
      'a `- b` inside an INLINE CODE SPAN is not a line start, so the child list token ' +
      'must be located at line 2. Getting [[li,1,0],[li,1,1]] means the search stopped ' +
      'requiring a line start: the parent owns no line and the child owns the parent\'s.');
  }
}

// I3 (re-asserted) + the durable invariant, over the whole corpus this task has
// accumulated: every li block's startLine names ITS OWN marker line.
{
  const MARKER_RE = /^ *(?:[-*+]|\d+[.)]) /;
  const corpus = [
    '- a\n  - b\n\n  more text\n- c\n',
    '- a\n\n  - a1\n    cont\n  - a2\n\n- b\n',
    '- alpha\n  cont\n- bravo\n',
    '- a\n  1. x\n  1) y\n- d\n',
    '- a\n  - b\n  * c\n- d\n',
    '- a\n  - b\n    - c\n- d',
    '# H\n\n- a\n  - b\n\n  tail\n\npara\n',
    '- a\n\n  ```\n  - b\n  ```\n\n  - b\n',
    '- a\n\n      - b\n\n  - b\n',
    '1. [ ] alpha\n2. [x] beta\n',
    '- plain\n- [ ] todo\n',
    '- first\n  continued\n- second',
    '- a\n  - b\n    1. p\n    1) q\n  - c\n- d\n',
  ];
  ['-', '*', '+', '1.', '1)'].forEach((o) => {
    ['-', '*', '+', '1.', '1)'].forEach((i) => corpus.push(o + ' ' + i + ' a\n'));
  });
  corpus.forEach((md) => {
    const lines = md.split('\n');
    const lis = buildBlockMap(md).blocks.filter((b) => b.type === 'li');
    let prev = 0;
    lis.forEach((b) => {
      assert.ok(MARKER_RE.test(lines[b.startLine - 1]),
        'li block ' + b.id + ' of ' + JSON.stringify(md) + ' has startLine ' + b.startLine +
        ' naming ' + JSON.stringify(lines[b.startLine - 1]) + ', which is not a marker line');
      assert.ok(b.startLine >= prev,
        'startLines must be non-decreasing in document order, in ' + JSON.stringify(md));
      prev = b.startLine;
    });
  });
}

// I3's own outcome is unchanged: own content that resumes AFTER a child stays
// unaddressable — a {startLine, endLine} pair cannot express a discontiguous
// range, so it is left out rather than mis-covered.
{
  const { blocks } = buildBlockMap('- a\n  - b\n\n  more text\n- c\n');
  assert.deepStrictEqual(blocks.map((b) => [b.startLine, b.endLine, b.indent]),
    [[1, 1, 0], [2, 2, 1], [5, 5, 0]],
    "an item whose own content resumes AFTER its sublist keeps only its own " +
    "contiguous marker line; the trailing own-content line belongs to no block");
}

// SAME-LINE nesting yields an EMPTY own-range for the outer item, at every
// marker combination. Asserted explicitly so the shape is a documented output
// rather than a surprise: lineops.js's replaceLines() turns end < start into an
// INSERTION, so client.js refuses to arm such a block and no commit can start
// on it (see canWysiwygForLi's blockOwnsNoLine guard).
{
  const MARKERS = ['-', '*', '+', '1.', '1)'];
  MARKERS.forEach((outer) => {
    MARKERS.forEach((inner) => {
      const md = outer + ' ' + inner + ' a\n';
      const lis = buildBlockMap(md).blocks.filter((b) => b.type === 'li');
      assert.strictEqual(lis[0].endLine, lis[0].startLine - 1,
        JSON.stringify(md) + ': the outer item owns NO line of its own, so its range is ' +
        'empty (endLine === startLine - 1), got [' + lis[0].startLine + '-' + lis[0].endLine + ']');
      assert.ok(lis[1].endLine >= lis[1].startLine,
        JSON.stringify(md) + ': the nested item DOES own its line and must keep a ' +
        'well-formed range');
    });
  });
  // ...and no ordinary shape produces one.
  ['- a\n- b\n', '- a\n  - b\n', '- alpha\n  cont\n- bravo\n',
   '- a\n  - b\n\n  more text\n- c\n', '- a\n\n  - a1\n    cont\n  - a2\n\n- b\n',
  ].forEach((md) => {
    buildBlockMap(md).blocks.forEach((b) => {
      assert.ok(b.endLine >= b.startLine,
        JSON.stringify(md) + ': block ' + b.id + ' must have a well-formed range, got [' +
        b.startLine + '-' + b.endLine + ']');
    });
  });
}

// ── N4: a trailing space on a nested list's last line ──────────────────────
//
// marked strips the trailing spaces off a nested list token's `raw` but keeps
// them in the enclosing `item.text`, so childListStartOffsets()'s byte-for-byte
// indexOf() missed and fell back to "the line the cursor is already on" — line
// offset 0. That gave the parent an INVERTED range and shifted every descendant
// UP one line, which is what let a commit against the empty item replay the
// item above it.
//
// Provenance of the three shapes, which is not uniform:
//   * the first two are the markdown test/editor-journey.test.js drives. It
//     presses Enter on each of them and then Tab on the first one again — three
//     rows over two strings, a split this tier cannot express, which is why the
//     two strings earn only one entry apiece here;
//   * the third is not a journey fixture at all. It came out of client.js's OWN
//     serialiser: capturing every markdown string a full journey run handed
//     buildBlockMap() turned up '# H\n\n- alpha\n  - beta\n    - \n- gamma\n'
//     arriving from the client mid-session, and it mapped to an inverted range
//     under the old search. A three-level shape is pinned here because that is
//     where the defect was found in the wild, not because a journey row types it.
{
  [
    ['# H\n\n- alpha\n  - beta\n  - \n- gamma\n', 'empty last item'],
    ['# H\n\n- alpha\n  - beta\n  - x \n- gamma\n', 'non-empty last item'],
    ['- alpha\n  - beta\n    - deep \n- gamma\n', 'three levels deep'],
  ].forEach(([md, label]) => {
    const bs = buildBlockMap(md).blocks;
    bs.forEach((b) => {
      assert.ok(b.endLine >= b.startLine,
        label + ' ' + JSON.stringify(md) + ': block ' + b.id +
        ' must have a well-formed range, got [' + b.startLine + '-' + b.endLine + ']');
      assert.strictEqual(b.unlocatable, undefined,
        label + ' ' + JSON.stringify(md) + ': block ' + b.id +
        ' is locatable, so it must carry no unlocatable flag');
    });
    // Ranges must also be RIGHT, not merely well-formed. "startLine names A
    // marker line" is NOT that check and does not belong here: the pre-fix map
    // shifted the descendants up by one, which lands them on the marker line of
    // the item ABOVE — still a marker line, so a test phrased that way is green
    // on the very build it is supposed to catch (measured).
    //
    // The check that bites: in each of these shapes every item owns exactly one
    // source line and the blocks come out in document order, so the k-th li
    // block must own the k-th MARKER LINE of the source, start and end.
    //
    // That is NOT a general rule about block maps, and the difference matters to
    // whoever adds the fourth fixture. Four shapes produce a CORRECT map that
    // this invariant would call wrong, and each is checked for below:
    //
    //   '- a\n  cont\n- b\n'      indented continuation — the item owns two
    //                             lines, so the endLine half breaks.
    //   '- a\ncont\n- b\n'        lazy continuation, unindented — same, and it
    //                             slips past an indent-based check.
    //   a fence holding '- fake'  the marker scan below counts a line no li
    //                             owns, so the startLine half breaks. At any
    //                             indent: a top-level fence is not indented, so
    //                             the fence check is the only one that sees it.
    //   '- - a\n- b\n'            same-line nesting — TWO items begin on one
    //                             marker line, so there are more li blocks than
    //                             marker lines. Not hypothetical: this very file
    //                             fixtures that shape a few assertions down.
    //
    // Asserting the fixture's shape first means a fourth fixture fails HERE,
    // with a message naming the shape, instead of failing the invariant with a
    // confusing one that sends the next person into blockmap.js.
    const lines = md.split('\n');
    const isMarkerLine = (ln) => /^\s*(?:[-*+]|\d+[.)])(\s|$)/.test(ln);
    const contentLines = lines.filter((ln) =>
      ln !== '' && /^[ \t]/.test(ln) && !isMarkerLine(ln));
    assert.deepStrictEqual(contentLines, [],
      label + ' ' + JSON.stringify(md) + ': PRECONDITION for the marker-line ' +
      'invariant below — every indented line must itself be a list marker. An ' +
      'indented line that is not one is item content (a continuation, or a line ' +
      'inside a fence), which means some item owns more than one line and the ' +
      'invariant no longer describes a correct map. Got ' +
      JSON.stringify(contentLines));
    const fences = lines.filter((ln) => /^\s*(?:```|~~~)/.test(ln));
    assert.deepStrictEqual(fences, [],
      label + ' ' + JSON.stringify(md) + ': PRECONDITION for the marker-line ' +
      'invariant below — no fenced block, at any indent. A fence can hold a line ' +
      'that looks like a marker to the scan below but belongs to no li. Got ' +
      JSON.stringify(fences));
    const sameLineNests = lines.filter((ln) =>
      /^\s*(?:[-*+]|\d+[.)])\s+(?:[-*+]|\d+[.)])(\s|$)/.test(ln));
    assert.deepStrictEqual(sameLineNests, [],
      label + ' ' + JSON.stringify(md) + ': PRECONDITION for the marker-line ' +
      'invariant below — no same-line nesting. Two items beginning on one line ' +
      'means more li blocks than marker lines, and the outer one owns no line at ' +
      'all. Got ' + JSON.stringify(sameLineNests));
    const lazyLines = [];
    let inListLine = false;
    lines.forEach((ln) => {
      if (ln.trim() === '') { inListLine = false; return; }
      if (isMarkerLine(ln)) { inListLine = true; return; }
      // Unindented, non-blank, straight after a list line: CommonMark folds it
      // into that item (lazy continuation), so the item owns two lines while
      // staying invisible to the indent check above.
      if (inListLine && !/^[ \t]/.test(ln)) { lazyLines.push(ln); return; }
      inListLine = false;
    });
    assert.deepStrictEqual(lazyLines, [],
      label + ' ' + JSON.stringify(md) + ': PRECONDITION for the marker-line ' +
      'invariant below — no lazy (unindented) continuation. Got ' +
      JSON.stringify(lazyLines));
    const markerLines = [];
    lines.forEach((ln, i) => {
      if (/^\s*(?:[-*+]|\d+[.)])(\s|$)/.test(ln)) markerLines.push(i + 1);
    });
    const lis = bs.filter((b) => b.type === 'li');
    assert.deepStrictEqual(lis.map((b) => b.startLine), markerLines,
      label + ' ' + JSON.stringify(md) + ': the li blocks must START on the ' +
      'marker lines of the source, in order — got ' +
      JSON.stringify(lis.map((b) => b.startLine)) + ', source marker lines are ' +
      JSON.stringify(markerLines) + '. A startLine one line early IS the defect: ' +
      'it addresses the item ABOVE, and a commit replays that item\'s source');
    assert.deepStrictEqual(lis.map((b) => b.endLine), markerLines,
      label + ' ' + JSON.stringify(md) + ': every item here owns exactly its own ' +
      'one line, so endLine must equal that same marker line — got ' +
      JSON.stringify(lis.map((b) => b.endLine)));
  });
  // The specific corruption, spelled out: with the trailing space, 'beta' is on
  // source line 4 and the empty item on line 5. Before the fix the map said 3
  // and 4, so editing the empty item wrote over beta.
  const bs = buildBlockMap('# H\n\n- alpha\n  - beta\n  - \n- gamma\n').blocks
    .filter((b) => b.type === 'li').map((b) => [b.startLine, b.endLine]);
  assert.deepStrictEqual(bs, [[3, 3], [4, 4], [5, 5], [6, 6]],
    'the four items own lines 3/4/5/6 one apiece');
}

// ── N4: same-line nesting keeps its empty range and stays UNFLAGGED ─────────
//
// '- - a' produces endLine === startLine - 1 too, but for a completely
// different reason: that item genuinely owns no line. It is a modelled shape,
// not a degraded one, and client.js picks its refusal wording off this flag —
// so flagging it would tell the user their document could not be located when
// it could.
{
  ['- - a\n', '- 1. a\n', '* + b\n', '1. - c\n'].forEach((md) => {
    const lis = buildBlockMap(md).blocks.filter((b) => b.type === 'li');
    assert.strictEqual(lis[0].endLine, lis[0].startLine - 1,
      JSON.stringify(md) + ': the outer item still has an empty range');
    lis.forEach((b) => {
      assert.strictEqual(b.unlocatable, undefined,
        JSON.stringify(md) + ': block ' + b.id + ' must carry NO unlocatable flag — ' +
        'an empty range is not by itself a degradation');
    });
  });
}

// ── N4: the degraded-subtree path, driven through the REAL search ──────────
//
// Every `unlocatable === undefined` assertion above is negative: they would all
// stay green forever if the field were renamed, or if it stopped being set at
// all. This is their positive counterpart, and it does not stub the flag onto
// a record — it makes the real childListStartOffsets() search genuinely fail, by
// perturbing what marked hands it, and then asserts on what the real
// pushListItemBlocks() does about that.
//
// Prefixing a nested list token's `raw` with text that appears nowhere in the
// parent's own `item.text` is exactly the condition the widened search cannot
// recover from, so `at < 0` is reached the same way an unmodelled shape would
// reach it.
{
  const { marked } = require('marked');
  const realLexer = marked.lexer;
  let blocks;
  try {
    marked.lexer = function () {
      const toks = realLexer.apply(this, arguments);
      const walk = (lt) => {
        for (const it of lt.items || []) {
          for (const tk of it.tokens || []) {
            if (tk.type === 'list') { tk.raw = ' UNFINDABLE\n' + tk.raw; walk(tk); }
          }
        }
      };
      for (const t of toks) if (t.type === 'list') walk(t);
      return toks;
    };
    blocks = buildBlockMap('- alpha\n  - beta\n    - deep\n- gamma\n').blocks;
  } finally {
    marked.lexer = realLexer;
  }
  // Ruling T4-0: degrade, never skip. lib/md2doc.js's edit-mode render walk
  // throws on `biRef.v !== blocks.length`, so a dropped block takes the whole
  // document down — worse than the defect it would be degrading around.
  assert.strictEqual(blocks.length, 4,
    'all four items must still be emitted when the search fails — a missing ' +
    'block desynchronises the render walk, got ' + JSON.stringify(blocks));
  const flagged = blocks.filter((b) => b.unlocatable === true).map((b) => b.indent);
  assert.deepStrictEqual(flagged, [0, 1, 2],
    'the WHOLE subtree under the unlocatable child degrades — the parent whose ' +
    'search failed and every descendant built off its guessed offset, got ' +
    JSON.stringify(blocks));
  // Addressed by POSITION, not by filtering on the flag. Filtering meant the
  // loop body ran zero times on a build that sets no flag — an assertion that
  // asserts nothing on exactly the build it is meant to catch. The first three
  // blocks ARE the subtree (C1 has just pinned the count at four, and the walk
  // emits parent-then-descendants before the next sibling), so this runs
  // everywhere and reds on a build that leaves them addressing real lines.
  blocks.slice(0, 3).forEach((b) => {
    assert.ok(b.endLine < b.startLine,
      'every block of the degraded subtree must carry an EMPTY range, so ' +
      'client.js\'s blockOwnsNoLine() refuses it at every arming and commit ' +
      'boundary, got [' + b.startLine + '-' + b.endLine + ']');
  });
  // The sibling is NOT collateral: its cursor advance comes from `item.raw`'s
  // newline count, which the failed search never touched.
  const gamma = blocks[3];
  assert.strictEqual(gamma.unlocatable, undefined,
    '- gamma has no unlocatable child of its own and must not be flagged');
  assert.deepStrictEqual([gamma.startLine, gamma.endLine], [4, 4],
    '- gamma keeps its real, editable range while its sibling subtree degrades');
  // The perturbation must be gone: everything after this point in the file — and
  // every other test sharing this process — uses the real lexer again.
  const sane = buildBlockMap('- alpha\n  - beta\n- gamma\n').blocks;
  assert.strictEqual(sane.filter((b) => b.unlocatable).length, 0,
    'the lexer wrapper must be restored — a leaked one would degrade every ' +
    'nested list mapped after it, got ' + JSON.stringify(sane));
}

// ── backlog #13: a top-level PARAGRAPH's raw can carry a synthesised
// internal newline ────────────────────────────────────────────────────────
//
// Not in childListStartOffsets()'s family at all — this is buildBlockMap()'s
// TOP-LEVEL loop trusting a 'paragraph' token's `t.raw` newline count, which
// marked (14.1.4) can inflate by one for a paragraph whose LAST line is an
// over-indented (tab, or >=4-space) lazy continuation immediately followed
// by a line marked's tokenizer inspects to decide whether it closes the
// paragraph as a setext heading. MEASURED: raw comes back as 'a\n\n\tb\n'
// (3 newlines) for the 2 real source lines 'a' and '\tb' — an internal
// blank line that names nothing in the source. Every block from the
// terminator onward then named the line ABOVE its real one, and the second
// li's startLine landed on an actual BLANK line — this is what "startLine
// falls on a non-marker line" meant; it is not inside any list item's own
// search, it is the CURSOR arriving at the list already one line late.
{
  const md = 'a\n\tb\n---\n- x\n- y\n\ntail\n';
  const lines = md.split('\n');
  const { blocks, lineCount } = buildBlockMap(md);
  assert.strictEqual(lineCount, 8);
  const expected = [
    ['paragraph', 1, 2],
    ['hr', 3, 3],
    ['li', 4, 4],
    ['li', 5, 5],
    ['paragraph', 7, 7],
  ];
  assert.deepStrictEqual(
    blocks.map((b) => [b.type, b.startLine, b.endLine]), expected,
    'a paragraph ending in an over-indented lazy continuation, immediately ' +
    'followed by --- , must not shift every later block down one line, got ' +
    JSON.stringify(blocks));
  // Oracle rule (i): no block's startLine or endLine may name a blank line —
  // this is the direct, general form of what the pre-fix map violated (the
  // second li's startLine on line 6, which is '').
  blocks.forEach((b) => {
    assert.notStrictEqual(lines[b.startLine - 1].trim(), '',
      'block ' + b.id + ' (' + b.type + ') startLine ' + b.startLine + ' must not be blank');
    assert.notStrictEqual(lines[b.endLine - 1].trim(), '',
      'block ' + b.id + ' (' + b.type + ') endLine ' + b.endLine + ' must not be blank');
  });
}

// Same family, a different terminator: a bare table-SEPARATOR-shaped line
// ('|---|' — no header row above it, so marked tokenizes it as its own
// paragraph, not a 'table') triggers the identical marked quirk (both it and
// '---' are dash-shaped text marked's setext-underline lookahead inspects)
// — pinned separately so a fix that narrowly special-cased literal '---'
// would still be caught.
{
  const md = 'a\n\tb\n|---|\n\ntail\n';
  const { blocks } = buildBlockMap(md);
  assert.deepStrictEqual(
    blocks.map((b) => [b.type, b.startLine, b.endLine]),
    [['paragraph', 1, 2], ['paragraph', 3, 3], ['paragraph', 5, 5]],
    'a table-separator-shaped line right after the same over-indented lazy ' +
    'continuation must not shift the following blocks down a line, got ' +
    JSON.stringify(blocks));
}

console.log('blockmap.test.js OK');
