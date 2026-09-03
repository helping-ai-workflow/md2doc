'use strict';
const assert = require('assert');
const pm = require('../lib/editor/paste-md.js');

let checks = 0;
function ok(actual, msg) {
  assert.ok(actual, msg);
  checks += 1;
}
function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg + '\n  actual:   ' + JSON.stringify(actual) +
    '\n  expected: ' + JSON.stringify(expected));
  checks += 1;
}

// --- htmlToMarkdown: fixed turndown configuration (ATX heading, `-` bullet,
//     fenced code) plus the GFM shapes turndown's core does not ship --------

eq(pm.htmlToMarkdown('<h2>Title</h2>'), '## Title', 'h2 -> ATX heading');
eq(pm.htmlToMarkdown('<h1>One</h1>'), '# One', 'h1 -> ATX heading');

const emphasis = pm.htmlToMarkdown('<p><strong>b</strong> <em>i</em> <del>d</del></p>');
ok(emphasis.includes('**b**'), 'strong -> **');
ok(emphasis.includes('*i*'), 'em -> *');
ok(emphasis.includes('~~d~~'), 'del -> ~~');

const strike = pm.htmlToMarkdown('<p><s>s1</s> <strike>s2</strike></p>');
ok(strike.includes('~~s1~~'), 's -> ~~');
ok(strike.includes('~~s2~~'), 'strike -> ~~');

const list = pm.htmlToMarkdown('<ul><li>alpha</li><li>beta</li></ul>');
ok(/^-\s+alpha$/m.test(list), 'ul li -> "- " bullet, alpha line');
ok(/^-\s+beta$/m.test(list), 'ul li -> "- " bullet, beta line');

const code = pm.htmlToMarkdown('<pre><code>const a = 1;</code></pre>');
eq(code, '```\nconst a = 1;\n```', 'pre>code -> fenced code block');

const codeWithLang = pm.htmlToMarkdown('<pre><code class="language-js">const a = 1;</code></pre>');
ok(codeWithLang.startsWith('```'), 'pre>code with a language class still fences');
ok(codeWithLang.includes('const a = 1;'), 'fenced code keeps the body');

const table = pm.htmlToMarkdown(
  '<table><thead><tr><th>A</th><th>B</th></tr></thead>' +
  '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
);
const tableLines = table.split('\n').filter((l) => l !== '');
eq(tableLines[0], '| A | B |', 'table header row');
ok(/^\|\s*---\s*\|\s*---\s*\|$/.test(tableLines[1]), 'table separator row');
eq(tableLines[2], '| 1 | 2 |', 'table data row');

// A table with no <thead>/<th> still needs a separator row to lex as GFM.
const tableNoHead = pm.htmlToMarkdown('<table><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>');
const noHeadLines = tableNoHead.split('\n').filter((l) => l !== '');
eq(noHeadLines[0], '| 1 | 2 |', 'headerless table: first row becomes the header row');
ok(/^\|\s*---\s*\|\s*---\s*\|$/.test(noHeadLines[1]), 'headerless table: synthesized separator row');
eq(noHeadLines[2], '| 3 | 4 |', 'headerless table: second row is data');

eq(pm.htmlToMarkdown(''), '', 'empty html -> empty string');
eq(pm.htmlToMarkdown(null), '', 'null html -> empty string, does not throw');

// --- pickPayload: clipboard payload selection -------------------------------

eq(
  pm.pickPayload({ 'text/html': '<h1>Title</h1>', 'text/plain': 'Title' }, false),
  { kind: 'markdown', value: '# Title' },
  'text/html present, not plainOnly -> markdown'
);

eq(
  pm.pickPayload({ 'text/html': '<h1>Title</h1>', 'text/plain': 'Title' }, true),
  { kind: 'text', value: 'Title' },
  'plainOnly true -> text even though text/html is present'
);

eq(
  pm.pickPayload({ 'text/plain': 'just text' }, false),
  { kind: 'text', value: 'just text' },
  'no text/html -> falls back to text/plain'
);

eq(
  pm.pickPayload({ 'image/png': 'BLOB', 'text/plain': 'fallback', 'text/html': '<p>fallback</p>' }, false),
  { kind: 'image', blob: 'BLOB' },
  'image/png present -> kind:image, regardless of the other MIME types'
);

eq(
  pm.pickPayload({ 'image/png': 'BLOB' }, true),
  { kind: 'image', blob: 'BLOB' },
  'image/png present -> kind:image even when plainOnly is true'
);

eq(
  pm.pickPayload({}, false),
  { kind: 'text', value: '' },
  'nothing on the clipboard -> empty text, does not throw'
);

console.log('paste-md.test.js: ' + checks + ' checks passed');
