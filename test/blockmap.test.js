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
  ['list',       14, 15],
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

console.log('blockmap.test.js OK');
