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
  ];
  cases.forEach(([md, expected]) => {
    const nested = buildBlockMap(md).blocks.filter((b) => b.type === 'li' && b.indent === 1);
    assert.strictEqual(nested.length, 1, JSON.stringify(md) + ': exactly one nested item');
    assert.strictEqual(nested[0].startLine, expected,
      JSON.stringify(md) + ': the nested item is the REAL one at line ' + expected +
      ', not the identical text inside the code block — got ' + nested[0].startLine +
      ' (' + JSON.stringify(md.split('\n')[nested[0].startLine - 1]) + ')');
  });
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

console.log('blockmap.test.js OK');
