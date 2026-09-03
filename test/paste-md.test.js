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

// Fix-round-1, Critical: a literal `|` in cell content used to add a
// phantom column instead of being escaped. Exact HTML from the review.
const pipeTable = pm.htmlToMarkdown(
  '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>a|b</td><td>2</td></tr></tbody></table>'
);
const pipeLines = pipeTable.split('\n').filter((l) => l !== '');
eq(pipeLines[0], '| A | B |', 'pipe-in-cell: header row unaffected');
eq(pipeLines[2], '| a\\|b | 2 |', 'pipe-in-cell: literal | is escaped as \\|, not a phantom column');
eq((pipeLines[2].match(/(?<!\\)\|/g) || []).length, 3,
  'pipe-in-cell: exactly 3 unescaped | (2 columns) -- the pre-fix bug produced 4');

// Fix-round-1, Important: colspan used to leave the row short of the
// table's real width. Exact HTML from the review.
const colspanTable = pm.htmlToMarkdown(
  '<table><thead><tr><th colspan=2>AB</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
);
const colspanLines = colspanTable.split('\n').filter((l) => l !== '');
eq(colspanLines[0], '| AB |  |', 'colspan=2 header expands to 2 cells, the second one empty');
ok(/^\|\s*---\s*\|\s*---\s*\|$/.test(colspanLines[1]), 'colspan: separator row has 2 columns, matching the body');
eq(colspanLines[2], '| 1 | 2 |', 'colspan: body row unaffected, now aligned to the header width');

// Fix-round-1, Important: a nested <table> inside a <td>. After the pipe
// escape and the rectangle normalization above, the inner table's own
// pipes/newlines must collapse into ONE escaped, single-line outer cell
// (not a stream of stray pipes that breaks the outer row's lex).
const nestedTable = pm.htmlToMarkdown(
  '<table><tbody><tr><td><table><tr><td>x</td><td>y</td></tr></table></td><td>z</td></tr></tbody></table>'
);
const nestedLines = nestedTable.split('\n').filter((l) => l !== '');
eq(nestedLines.length, 2, 'nested table: outer table is exactly 2 lexable lines (header + separator)');
nestedLines.forEach((l, i) => {
  eq((l.match(/(?<!\\)\|/g) || []).length, 3, 'nested table line ' + i + ': exactly 3 unescaped | (2 columns)');
});

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

// Fix-round-2 ruling: in the default (non-plainOnly) path, text/html now
// beats an image when both are present -- a rich-text copy (Word/browser/
// Confluence) routinely carries a bitmap of the same content alongside the
// HTML, and the image-first rule from round 1 made that bitmap win over the
// markdown this whole track exists to produce. Three-flavour case: html +
// image + plain, default path -> html wins.
eq(
  pm.pickPayload({ 'image/png': 'BLOB', 'text/plain': 'fallback', 'text/html': '<p>fallback</p>' }, false),
  { kind: 'markdown', value: 'fallback' },
  'default path: html + image + plain all present -> html wins (fix-round-2)'
);

// The two branches fix-round-2 must NOT disturb, re-confirmed explicitly:
eq(
  pm.pickPayload({ 'image/png': 'BLOB' }, false),
  { kind: 'image', blob: 'BLOB' },
  'default path: image-only (no text/html at all) -> still image'
);
eq(
  pm.pickPayload({ 'image/png': 'BLOB', 'text/plain': 'fallback', 'text/html': '<p>fallback</p>' }, true),
  { kind: 'text', value: 'fallback' },
  'plainOnly path: html + image + plain all present -> text still wins (fix-round-1, unchanged)'
);

// Fix-round-1 ruling: plainOnly wins over an image when a text flavour
// exists -- both branches of that ruling, explicit and side by side.
eq(
  pm.pickPayload({ 'image/png': 'BLOB', 'text/plain': 'plain text present' }, true),
  { kind: 'text', value: 'plain text present' },
  'plainOnly + image present + text/plain present -> text wins (honour the gesture)'
);
eq(
  pm.pickPayload({ 'image/png': 'BLOB' }, true),
  { kind: 'image', blob: 'BLOB' },
  'plainOnly + image present + NO text flavour at all -> falls through to image'
);

eq(
  pm.pickPayload({}, false),
  { kind: 'text', value: '' },
  'nothing on the clipboard -> empty text, does not throw'
);

console.log('paste-md.test.js: ' + checks + ' checks passed');
