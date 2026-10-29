'use strict';
// v3.17.0 T1: the pure core of the in-place code editor.
const assert = require('assert');
const ce = require('../lib/editor/code-edit.js');
const hl = require('../lib/highlight.js');

// parseFence / buildFence round trip
assert.deepStrictEqual(ce.parseFence(['```verilog', 'module m;', 'endmodule', '```']),
  { indent: '', char: '`', open: 3, info: 'verilog', body: ['module m;', 'endmodule'], closed: true });
assert.deepStrictEqual(ce.buildFence({ indent: '', char: '`', open: 3, info: 'md', body: ['```js', 'x', '```'] }),
  ['````md', '```js', 'x', '```', '````']);
assert.deepStrictEqual(ce.buildFence({ indent: '', char: '~', open: 3, info: '', body: ['```'] }), ['~~~', '```', '~~~']);
assert.deepStrictEqual(ce.buildFence({ indent: '  ', char: '`', open: 5, info: 'c', body: ['x'] }), ['  `````c', 'x', '  `````']);
assert.strictEqual(ce.parseFence(['    indented code']), null);
assert.strictEqual(ce.parseFence(['plain']), null);
assert.strictEqual(ce.parseFence([]), null);
// R37: a backtick fence whose info holds a backtick is inline code, not a fence
assert.strictEqual(ce.parseFence(['```a`b', 'x', '```']), null);
assert.deepStrictEqual(ce.parseFence(['~~~a`b', 'x', '~~~']),
  { indent: '', char: '~', open: 3, info: 'a`b', body: ['x'], closed: true });
// unterminated: runs to the end
assert.deepStrictEqual(ce.parseFence(['```py', 'a', 'b']),
  { indent: '', char: '`', open: 3, info: 'py', body: ['a', 'b'], closed: false });
assert.deepStrictEqual(ce.parseFence(['```']),
  { indent: '', char: '`', open: 3, info: '', body: [], closed: false });
// a shorter or different-char run does not close; a longer one does; a closer may not carry text
assert.deepStrictEqual(ce.parseFence(['````', '```', '~~~~', '```` x', '````']),
  { indent: '', char: '`', open: 4, info: '', body: ['```', '~~~~', '```` x'], closed: true });
assert.deepStrictEqual(ce.parseFence(['```', 'a', '`````']).body, ['a']);
// indent, info trimmed
assert.deepStrictEqual(ce.parseFence(['  ~~~~  c  ', '  x', '  ~~~~']),
  { indent: '  ', char: '~', open: 4, info: 'c', body: ['  x'], closed: true });
// empty body round trip
assert.deepStrictEqual(ce.buildFence({ indent: '', char: '`', open: 3, info: '', body: [] }), ['```', '```']);
// longest run anywhere in the body, not only at line start
assert.deepStrictEqual(ce.buildFence({ indent: '', char: '`', open: 3, info: '', body: ['a ```` b'] }), ['`````', 'a ```` b', '`````']);
// open length kept when larger
assert.deepStrictEqual(ce.buildFence({ indent: '', char: '`', open: 4, info: '', body: ['x'] }), ['````', 'x', '````']);

// language
assert.strictEqual(ce.setFenceLang('verilog title="a b"', 'python'), 'python title="a b"');
assert.strictEqual(ce.setFenceLang('verilog', ''), '');
assert.strictEqual(ce.setFenceLang('verilog  title=x', ''), 'title=x');
assert.strictEqual(ce.setFenceLang('', 'c'), 'c');
// v3.17.2 A2 (R53): the words after the language are kept as written (a
// quoted value's inner spaces included), and a first word holding `=` is an
// attribute, not a language: a pick goes in front of it, "" leaves it alone.
assert.strictEqual(ce.setFenceLang('a   b  c', 'x'), 'x b  c');
assert.strictEqual(ce.setFenceLang('verilog title="a  b"', ''), 'title="a  b"');
assert.strictEqual(ce.setFenceLang('verilog title="a  b"', 'c'), 'c title="a  b"');
assert.strictEqual(ce.setFenceLang('title="a"', 'python'), 'python title="a"');
assert.strictEqual(ce.setFenceLang('title="a"', ''), 'title="a"');
assert.strictEqual(ce.langLabel('title="a"'), '\u7d14\u6587\u5b57');
assert.strictEqual(ce.langWord('title="a" x'), '');
assert.strictEqual(ce.langWord('  SV title=x'), 'SV');
assert.strictEqual(ce.langLabel('sv'), 'Verilog');
assert.strictEqual(ce.langLabel('SystemVerilog'), 'Verilog');
assert.strictEqual(ce.langLabel('c++ title=x'), 'C++');
assert.strictEqual(ce.langLabel(''), '純文字');
assert.strictEqual(ce.langLabel('rust'), 'rust');
assert.strictEqual(ce.langLabel('Rust'), 'Rust', 'as written');
assert.deepStrictEqual(ce.filterLangs('py').map(l => l.id), ['python']);
assert.strictEqual(ce.filterLangs('').length, 12);
assert.deepStrictEqual(ce.filterLangs('JAVA').map(l => l.id), ['javascript']);
assert.deepStrictEqual(ce.filterLangs('純').map(l => l.id), ['']);
assert.deepStrictEqual(ce.filterLangs('zzz'), []);

// keys
assert.deepStrictEqual(ce.newlineWithIndent('  a', 3), { text: '  a\n  ', caret: 6 });
assert.deepStrictEqual(ce.newlineWithIndent('x\n\ty', 4), { text: 'x\n\ty\n\t', caret: 6 });
assert.deepStrictEqual(ce.newlineWithIndent('  ab', 2), { text: '  \n  ab', caret: 5 }, 'mid-line split keeps the indent');
assert.deepStrictEqual(ce.newlineWithIndent('', 0), { text: '\n', caret: 1 });
assert.deepStrictEqual(ce.indentLines('a\nb', 0, 3, false), { text: '  a\n  b', selStart: 2, selEnd: 7 });
assert.deepStrictEqual(ce.indentLines(' a\n   b', 0, 7, true), { text: 'a\n b', selStart: 0, selEnd: 4 });
// R42: a selection ending at column 0 does not touch that line
assert.deepStrictEqual(ce.indentLines('a\nb\n', 0, 4, false), { text: '  a\n  b\n', selStart: 2, selEnd: 8 });
assert.deepStrictEqual(ce.indentLines('a\nb\nc', 0, 2, false), { text: '  a\nb\nc', selStart: 2, selEnd: 4 });
assert.deepStrictEqual(ce.indentLines('a\nb\nc', 2, 5, false), { text: 'a\n  b\n  c', selStart: 4, selEnd: 9 });
// dedent: up to 2, clamps at the line start, untouched lines stay
assert.deepStrictEqual(ce.indentLines('    a\n b\nc', 0, 9, true), { text: '  a\nb\nc', selStart: 0, selEnd: 6 });
assert.deepStrictEqual(ce.indentLines('  a', 1, 2, true), { text: 'a', selStart: 0, selEnd: 0 });
// no-op dedent returns the same text
assert.deepStrictEqual(ce.indentLines('a\nb', 0, 3, true), { text: 'a\nb', selStart: 0, selEnd: 3 });
// collapsed caret touches its own line
assert.deepStrictEqual(ce.indentLines('a\nb', 3, 3, false), { text: 'a\n  b', selStart: 5, selEnd: 5 });
assert.deepStrictEqual(ce.indentLines('a\nb', 1, 1, false), { text: '  a\nb', selStart: 3, selEnd: 3 });

// history
const h = new ce.TextHistory({ text: '', selStart: 0, selEnd: 0 });
h.push({ text: 'a', selStart: 1, selEnd: 1 }); h.push({ text: 'ab', selStart: 2, selEnd: 2 });
assert.strictEqual(h.undo().text, 'a'); assert.strictEqual(h.undo().text, ''); assert.strictEqual(h.undo(), null);
assert.strictEqual(h.redo().text, 'a');
h.push({ text: 'ax', selStart: 2, selEnd: 2 });
assert.strictEqual(h.redo(), null, 'a push drops the redo tail');
assert.strictEqual(h.undo().text, 'a');
const h2 = new ce.TextHistory({ text: '0', selStart: 0, selEnd: 0 }, 3);
for (let i = 1; i <= 6; i++) h2.push({ text: String(i), selStart: 0, selEnd: 0 });
let n = 0; while (h2.undo()) n++;
assert.strictEqual(n, 2, 'cap 3 keeps 3 snapshots');
const h3 = new ce.TextHistory({ text: 'a', selStart: 0, selEnd: 0 });
h3.push({ text: 'a', selStart: 1, selEnd: 1 });
assert.strictEqual(h3.undo(), null, 'an identical text is not a new step');

// CODE_LANGS agrees with the server's registered list
assert.deepStrictEqual(ce.CODE_LANGS.filter(l => l.id).map(l => l.id), hl.LANGS.filter(id => id !== 'plaintext'));
assert.deepStrictEqual(ce.CODE_LANGS[ce.CODE_LANGS.length - 1], { id: '', label: '純文字', aliases: ['plaintext', 'text', 'txt'] });
// R38: every alias resolves server-side and labels as its target
for (const l of ce.CODE_LANGS) {
  for (const a of l.aliases) {
    assert.notStrictEqual(hl.highlightCode('x', a), null, 'alias resolves: ' + a);
    assert.strictEqual(ce.langLabel(a), l.label, 'alias label: ' + a);
  }
}
for (const [a, t] of Object.entries(hl.ALIASES)) {
  assert.ok(ce.CODE_LANGS.find(l => l.id === t).aliases.includes(a), 'custom alias in CODE_LANGS: ' + a);
}
assert.ok(!/<\/script/i.test(require('fs').readFileSync(require.resolve('../lib/editor/code-edit.js'), 'utf8')), 'no closing script tag');
console.log('code-edit: ok');
