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
}
// task list items
{
  const { blocks } = buildBlockMap('- [ ] todo\n- [x] done');
  assert.deepStrictEqual(blocks.map((b) => [b.listType, b.checked]),
    [['task', false], ['task', true]]);
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

console.log('blockmap.test.js OK');
