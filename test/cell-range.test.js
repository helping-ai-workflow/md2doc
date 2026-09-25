'use strict';
const assert = require('assert');
const cr = require('../lib/editor/cell-range.js');

assert.deepStrictEqual(cr.normalize({ r: 3, c: 0 }, { r: 1, c: 2 }),
  { top: 1, left: 0, bottom: 3, right: 2 }, 'normalize orders both axes');
assert.deepStrictEqual(cr.cellsIn({ top: 0, left: 1, bottom: 1, right: 2 }),
  [{ r: 0, c: 1 }, { r: 0, c: 2 }, { r: 1, c: 1 }, { r: 1, c: 2 }], 'row-major');
assert.strictEqual(cr.isSingle({ r: 1, c: 1 }, { r: 1, c: 1 }), true);
assert.strictEqual(cr.isSingle({ r: 1, c: 1 }, { r: 1, c: 2 }), false);

assert.deepStrictEqual(cr.step({ r: 0, c: 0 }, 'up', 3, 3), { r: 0, c: 0 }, 'clamped at the top');
assert.deepStrictEqual(cr.step({ r: 2, c: 2 }, 'right', 3, 3), { r: 2, c: 2 }, 'clamped at the right');
assert.deepStrictEqual(cr.step({ r: 1, c: 1 }, 'down', 3, 3), { r: 2, c: 1 });
assert.deepStrictEqual(cr.step({ r: 1, c: 1 }, 'left', 3, 3), { r: 1, c: 0 });

assert.deepStrictEqual(cr.parseTsv('a\tb\nc\td\n'), [['a', 'b'], ['c', 'd']], 'trailing newline dropped');
assert.deepStrictEqual(cr.parseTsv('a\tb\r\nc\td'), [['a', 'b'], ['c', 'd']], 'CRLF');
assert.deepStrictEqual(cr.parseTsv('"x\ty"\t"he said ""hi"""\n"two\nlines"\tz'),
  [['x\ty', 'he said "hi"'], ['two\nlines', 'z']], 'Excel quoting');
assert.deepStrictEqual(cr.parseTsv('a\t\tc'), [['a', '', 'c']], 'empty middle field');
assert.deepStrictEqual(cr.parseTsv('a\nb\tc'), [['a'], ['b', 'c']], 'ragged rows kept ragged');

assert.strictEqual(cr.toTsv([['a', 'b'], ['c', 'd']]), 'a\tb\nc\td');
assert.strictEqual(cr.toTsv([['x\ty', 'he said "hi"'], ['two\nlines', 'z']]),
  '"x\ty"\t"he said ""hi"""\n"two\nlines"\tz', 'quotes exactly what parseTsv unquotes');
assert.deepStrictEqual(cr.parseTsv(cr.toTsv([['p"q', 'r\ns', '']])), [['p"q', 'r\ns', '']],
  'round trip');

assert.deepStrictEqual(cr.growthNeeded({ r: 2, c: 1 }, [['a', 'b', 'c'], ['d']], 3, 3),
  { addRows: 1, addCols: 1 }, 'origin (2,1) + 2x3 grid on a 3x3 table');
assert.deepStrictEqual(cr.growthNeeded({ r: 0, c: 0 }, [['a']], 3, 3), { addRows: 0, addCols: 0 });

console.log('cell-range.test.js OK');