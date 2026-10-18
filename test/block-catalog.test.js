'use strict';
// v3.15.0 T1: the "/" menu's block catalogue (lib/editor/block-catalog.js) —
// its 16 items, their groups, the filter (D7) and the skeletons (D5).
const assert = require('assert');
const cat = require('../lib/editor/block-catalog.js');
const ids = (q) => cat.filterSlashItems(q).map((i) => i.id);
assert.deepStrictEqual(cat.SLASH_ITEMS.map((i) => i.id), ['text','h1','h2','h3','ul','ol','task','quote','code','divider','table','image','mermaid','graphviz','wavedrom','math']);
assert.deepStrictEqual(cat.SLASH_GROUPS.map((g) => g.label), ['基本','清單','區塊','圖表']);
assert.strictEqual(ids('').length, 16);
assert.deepStrictEqual(ids('表'), ['table']);
assert.deepStrictEqual(ids('h2'), ['h2']);
assert.deepStrictEqual(ids('code'), ['code']);
assert.deepStrictEqual(ids('程式'), ['code']);
assert.deepStrictEqual(ids('MER'), ['mermaid']);
assert.deepStrictEqual(ids('圖'), ['image','mermaid','graphviz']);
assert.deepStrictEqual(ids('heading'), ['h1','h2','h3']);
assert.deepStrictEqual(ids('zzz'), []);
assert.deepStrictEqual(cat.itemById('task').lines, ['- [ ] ']);
assert.deepStrictEqual(cat.TABLE_SKELETON, ['| A | B | C |', '|---|---|---|', '|  |  |  |', '|  |  |  |']);
assert.deepStrictEqual(cat.itemById('math').lines, ['$$', 'x^2', '$$']);
assert.deepStrictEqual(cat.SLASH_ITEMS.filter((i) => i.pristine === false).map((i) => i.id), ['mermaid','graphviz','wavedrom','math']);
// The rest of the interface the client reads: labels, hints and lines in the
// order the spec's table gives them, and the two items with no skeleton.
assert.deepStrictEqual(cat.SLASH_ITEMS.map((i) => i.label), ['文字','標題 1','標題 2','標題 3','項目符號列表','編號列表','待辦清單','引用','程式碼','分隔線','表格','圖片','Mermaid 圖','Graphviz 圖','WaveDrom 波形','數學公式']);
assert.deepStrictEqual(cat.SLASH_ITEMS.map((i) => i.hint), ['','#','##','###','-','1.','[]','>','\x60\x60\x60','---','','','','','','$$']);
assert.deepStrictEqual(cat.SLASH_ITEMS.map((i) => i.group), ['basic','basic','basic','basic','list','list','list','block','block','block','block','block','diagram','diagram','diagram','diagram']);
assert.deepStrictEqual(cat.SLASH_ITEMS.filter((i) => i.lines === null).map((i) => i.id), ['text', 'image']);
assert.deepStrictEqual(cat.itemById('h3').lines, ['###']);
assert.deepStrictEqual(cat.itemById('ol').lines, ['1.']);
assert.deepStrictEqual(cat.itemById('quote').lines, ['>']);
assert.deepStrictEqual(cat.itemById('code').lines, ['\x60\x60\x60', '', '\x60\x60\x60']);
assert.deepStrictEqual(cat.itemById('divider').lines, ['---']);
assert.deepStrictEqual(cat.itemById('mermaid').lines, ['\x60\x60\x60mermaid', 'graph TD', '  A --> B', '\x60\x60\x60']);
assert.deepStrictEqual(cat.itemById('graphviz').lines, ['\x60\x60\x60dot', 'digraph { a -> b }', '\x60\x60\x60']);
assert.deepStrictEqual(cat.itemById('wavedrom').lines, ['\x60\x60\x60wavedrom', "{ signal: [{ name: 'clk', wave: 'p....' }] }", '\x60\x60\x60']);
assert.strictEqual(cat.itemById('nope'), null);
assert.deepStrictEqual(ids('TaBlE'), ['table'], 'case-insensitive');
assert.deepStrictEqual(ids('able'), [], 'prefix, not substring');
// v3.15.0 T3: the Markdown shortcut matcher (D3) and the lines a match
// writes (D5 skeletons when nothing follows the caret). NBSP is written as an
// escape: a contenteditable often types a trailing space as U+00A0.
const ms = cat.matchShortcut;
assert.deepStrictEqual(ms('## ', false), { kind: 'heading', depth: 2 });
assert.deepStrictEqual(ms('## ', false), { kind: 'heading', depth: 2 });
assert.deepStrictEqual(ms('###### ', true), { kind: 'heading', depth: 6 });
assert.strictEqual(ms('####### ', true), null);
assert.deepStrictEqual([ms('- ', true), ms('* ', true)], [{ kind: 'ul' }, { kind: 'ul' }]);
assert.deepStrictEqual([ms('- ', true), ms('* ', false)], [{ kind: 'ul' }, { kind: 'ul' }]);
assert.deepStrictEqual(ms('12. ', true), { kind: 'ol', start: 12 });
assert.deepStrictEqual(ms('3. ', false), { kind: 'ol', start: 3 });
assert.deepStrictEqual([ms('[] ', true), ms('[ ] ', true)], [{ kind: 'task' }, { kind: 'task' }]);
assert.deepStrictEqual(ms('[ ] ', true), { kind: 'task' });
assert.deepStrictEqual(ms('> ', false), { kind: 'quote' });
assert.deepStrictEqual(ms('> ', true), { kind: 'quote' });
assert.deepStrictEqual([ms('\x60\x60\x60', true), ms('\x60\x60\x60', false)], [{ kind: 'code' }, null]);
assert.deepStrictEqual([ms('---', true), ms('---', false)], [{ kind: 'divider' }, null]);
assert.deepStrictEqual([ms('a## ', true), ms('#', true), ms('1.', true)], [null, null, null]);
assert.deepStrictEqual([ms('## x', true), ms(' ## ', true), ms('1234567890. ', true), ms('+ ', true)], [null, null, null, null]);
assert.deepStrictEqual(cat.shortcutLines({ kind: 'heading', depth: 2 }, []), ['##']);
assert.deepStrictEqual(cat.shortcutLines({ kind: 'heading', depth: 2 }, ['']), ['##']);
assert.deepStrictEqual(cat.shortcutLines({ kind: 'heading', depth: 2 }, ['Title']), ['## Title']);
assert.deepStrictEqual(cat.shortcutLines({ kind: 'heading', depth: 1 }, ['a', 'b']), ['# a b'], 'a heading is one line');
assert.deepStrictEqual(cat.shortcutLines({ kind: 'ul' }, []), ['-']);
assert.deepStrictEqual(cat.shortcutLines({ kind: 'ul' }, ['x', 'y']), ['- x', '  y']);
assert.deepStrictEqual(cat.shortcutLines({ kind: 'task' }, []), ['- [ ] ']);
assert.deepStrictEqual(cat.shortcutLines({ kind: 'task' }, ['x']), ['- [ ] x']);
assert.deepStrictEqual(cat.shortcutLines({ kind: 'ol', start: 3 }, []), ['3.']);
assert.deepStrictEqual(cat.shortcutLines({ kind: 'ol', start: 3 }, ['x']), ['3. x']);
assert.deepStrictEqual(cat.shortcutLines({ kind: 'ol', start: 12 }, ['x', 'y']), ['12. x', '    y']);
assert.deepStrictEqual(cat.shortcutLines({ kind: 'quote' }, []), ['>']);
assert.deepStrictEqual(cat.shortcutLines({ kind: 'quote' }, ['a', 'b']), ['> a', '> b']);
assert.deepStrictEqual(cat.shortcutLines({ kind: 'code' }, []), ['\x60\x60\x60', '', '\x60\x60\x60']);
assert.deepStrictEqual(cat.shortcutLines({ kind: 'divider' }, []), ['---']);
console.log('block-catalog.test.js OK');
