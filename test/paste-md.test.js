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

// v3.4.1: a file with no MIME at all -- a .drawio -- arrives under the fixed
// 'file' key, because this map is keyed by MIME and that file has none. The
// rule for WHICH files are insertable lives in client.js's insertableFile();
// what is pinned here is only that the key is looked at.
eq(
  pm.pickPayload({ file: 'BLOB' }, false),
  { kind: 'image', blob: 'BLOB' },
  "a MIME-less file under the 'file' key is picked up like an image"
);
eq(
  pm.pickPayload({ file: 'BLOB', 'text/html': '<p>x</p>' }, false),
  { kind: 'markdown', value: 'x' },
  "html still wins over a 'file' payload -- same precedence as image/*"
);
eq(
  pm.pickPayload({ file: 'BLOB', 'text/plain': 'p' }, true),
  { kind: 'text', value: 'p' },
  "plainOnly still wins over a 'file' payload -- same precedence as image/*"
);

eq(
  pm.pickPayload({}, false),
  { kind: 'text', value: '' },
  'nothing on the clipboard -> empty text, does not throw'
);

// --- v3.17.5 R2: pasted bold / italic whose text starts or ends with
//     punctuation next to a word character. turndown already moves edge
//     whitespace outside the delimiters; punctuation it wrapped blind, and the
//     result lands in the file as source (client.js's 'markdown' paste branch).
//     Measured on 4d7669f: `前面<b>「引號」</b>後面` -> `前面**「引號」**後面`,
//     shown with literal asterisks. The oracle is the reader's own marked
//     (requiring lib/md2doc.js installs its extensions), last in the file.
{
  const { marked } = require('marked');
  require('../lib/md2doc.js');
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
  const shownText = (h) => h.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, (m, n) => ENT[n])
    .replace(/\s+/g, ' ').trim();
  function pasted(name, html, bytes, want, text) {
    const md = pm.htmlToMarkdown(html);
    eq(md, bytes, 'v3175 R2 ' + name + ': bytes');
    const out = marked.parse(md);
    ok(out.includes(want), 'v3175 R2 ' + name + ': ' + JSON.stringify(out) + ' lacks ' + JSON.stringify(want));
    eq(shownText(out), text, 'v3175 R2 ' + name + ': the reader shows the pasted text');
  }
  pasted('cjk brackets', '<p>前面<b>「引號」</b>後面</p>', '前面<!-- -->**「引號」**<!-- -->後面', '<strong>「引號」</strong>', '前面「引號」後面');
  pasted('cjk full stop', '<p><strong>中文。</strong>後面</p>', '**中文。**<!-- -->後面', '<strong>中文。</strong>', '中文。後面');
  pasted('em', '<p>a<em>中文。</em>後</p>', 'a*中文。*<!-- -->後', '<em>中文。</em>', 'a中文。後');
  pasted('symbol', '<p>x<strong>$5</strong>y</p>', 'x<!-- -->**$5**y', '<strong>$5</strong>', 'x$5y');
  pasted('nested run guarded outside', '<p>a<b><i>「x」</i></b>b</p>', 'a<!-- -->***「x」***<!-- -->b', '「x」</', 'a「x」b');
  pasted('through a span', '<p>前<span><b>「x」</b></span>後</p>', '前<!-- -->**「x」**<!-- -->後', '<strong>「x」</strong>', '前「x」後');
  // final review I3: an empty element beside the bold (a Word bookmark, an
  // empty span) is skipped, and a wrapper turndown writes no syntax for is
  // looked through
  pasted('empty anchor before', '<p>前<a name="_Toc1"></a><b>「x」</b>後</p>', '前<!-- -->**「x」**<!-- -->後', '<strong>「x」</strong>', '前「x」後');
  pasted('empty span after', '<p>前<b>「x」</b><span></span>後</p>', '前<!-- -->**「x」**<!-- -->後', '<strong>「x」</strong>', '前「x」後');
  pasted('through u', '<p><u><b>「x」</b></u>後</p>', '**「x」**<!-- -->後', '<strong>「x」</strong>', '「x」後');
  pasted('through sup', '<p>前<sup><b>「x」</b></sup></p>', '前<!-- -->**「x」**', '<strong>「x」</strong>', '前「x」');
  // re-review C1 / I1: the separator never lands at the start of a line --
  // marked reads a line opening `<!--` as an HTML block, which ends the
  // paragraph and leaves the stars literal. A <br> inside a skipped wrapper,
  // or a block before / after, is a line edge: nothing is looked past it.
  function noLineStartComment(name, html) {
    const md = pm.htmlToMarkdown(html);
    ok(!/(^|\n)<!--/.test(md), 'v3175 R2 ' + name + ': no line starts with the separator, ' + JSON.stringify(md));
    ok(/<strong>「x」<\/strong>/.test(marked.parse(md)), 'v3175 R2 ' + name + ': bold taken, ' + JSON.stringify(marked.parse(md)));
  }
  noLineStartComment('br in a span before', '<p>前<span><br></span><b>「x」</b>後</p>');
  noLineStartComment('br in a Word span before', '<p>前<span lang="EN-US"><span></span><br></span><b>「x」</b>後</p>');
  noLineStartComment('div before', '<div>前</div><b>「x」</b>後');
  noLineStartComment('p before', '<p>前</p><b>「x」</b>後');
  noLineStartComment('li before', '<ul><li>前</li></ul><b>「x」</b>後');
  noLineStartComment('br at the end of a span before', '<p><span>前<br></span><b>「x」</b>後</p>');
  noLineStartComment('br at the end of a nested span before', '<p><span>前<span><br></span></span><b>「x」</b>後</p>');
  // re-review round 3, I1': an EMPTY block still writes a line edge
  noLineStartComment('empty p before', '<p>前</p><p></p><b>「x」</b>後');
  noLineStartComment('empty p between', '前<p></p><b>「x」</b>後');
  noLineStartComment('empty div before', '<div>前<div></div><b>「x」</b>後</div>');
  noLineStartComment('empty list before', '<div>前<ul><li></li></ul><b>「x」</b>後</div>');
  noLineStartComment('empty table before', '<div>前<table><tr><td></td></tr></table><b>「x」</b></div>');
  // ...while an inline element that writes nothing is still looked past: a
  // bold holding only a <br> is dropped by its rule, and Word's empty <o:p>
  pasted('bold holding only a br', '<p>aa<b><br></b><b>「x」</b>後</p>', 'aa<!-- -->**「x」**<!-- -->後', '<strong>「x」</strong>', 'aa「x」後');
  pasted('word o:p', '<p>前<o:p></o:p><b>「x」</b>後</p>', '前<!-- -->**「x」**<!-- -->後', '<strong>「x」</strong>', '前「x」後');
  pasted('br in a span before, bytes', '<p>前<span><br></span><b>「x」</b>後</p>', '前  \n**「x」**<!-- -->後', '<strong>「x」</strong>', '前「x」後');
  pasted('div after', '<p>前<b>「x」</b></p><div>後</div>', '前<!-- -->**「x」**\n\n後', '<strong>「x」</strong>', '前「x」 後');
  // final review I2, paste side
  pasted('emoji before', '<p>📌<b>「重點」</b>請看</p>', '📌<!-- -->**「重點」**<!-- -->請看', '<strong>「重點」</strong>', '📌「重點」請看');
  // final review (minor): a hard break at the edge of a pasted bold
  pasted('hard break at the end', '<p><b>x<br></b>y</p>', '**x**  \ny', '<strong>x</strong><br>', 'xy');
  // nothing where the neighbour already satisfies the rule
  pasted('punct neighbours', '<p>「<b>引號</b>」</p>', '「**引號**」', '<strong>引號</strong>', '「引號」');
  pasted('space neighbours', '<p>前 <b>「x」</b> 後</p>', '前 **「x」** 後', '<strong>「x」</strong>', '前 「x」 後');
  pasted('turndown space', '<p>alpha<b> 「x」</b> delta</p>', 'alpha **「x」** delta', '<strong>「x」</strong>', 'alpha 「x」 delta');
  pasted('word edges', '<p>x<b>中</b>y</p>', 'x**中**y', '<strong>中</strong>', 'x中y');
}

// v3.17.7 F2: a `|` in a pasted table cell is a cell boundary to GFM unless an
// ODD run of backslashes precedes it (marked's splitCells(), the parity rule
// v3.17.6 wrote down in table-md.js). escapePipes() used to skip every `|`
// with a `\` before it, so a cell whose text held `\|` (turndown writes that
// backslash as `\\`) was cut in two. Measured on 71fedaa:
//   <td>a \| b</td>          -> `| a \\| b |`   -> cells `a \` and `b`
//   <td><code>a \| b</code>  -> `` `a \| b` `` -> the code shows `a | b`
{
  const { Marked } = require('marked');
  const gfm = new Marked({ gfm: true });
  // [cell html] -> the body row's cells as the reader renders them
  function bodyCells(cellHtml) {
    const md = pm.htmlToMarkdown('<table><tr><th>h</th><th>k</th></tr><tr><td>' + cellHtml + '</td><td>x</td></tr></table>');
    const body = gfm.parse(md).replace(/\n/g, '').match(/<tbody><tr>(.*?)<\/tr><\/tbody>/);
    return { md, cells: body ? body[1].split('</td>').filter(Boolean).map((c) => c.replace(/^<td>/, '')) : null };
  }
  function cellsAre(name, cellHtml, firstCell) {
    const got = bodyCells(cellHtml);
    eq(got.cells, [firstCell, 'x'], 'v3177 F2 ' + name + ' (md ' + JSON.stringify(got.md) + ')');
  }
  cellsAre('text, one backslash', 'a \\| b', 'a \\| b');
  cellsAre('text, two backslashes', 'a \\\\| b', 'a \\\\| b');
  cellsAre('text, bare pipe', 'a | b', 'a | b');
  cellsAre('code, bare pipe', '<code>a | b</code>', '<code>a | b</code>');
  cellsAre('code, two backslashes', '<code>a \\\\| b</code>', '<code>a \\\\| b</code>');
  // An odd run before the `|` in code has no GFM spelling at all (v3.17.6):
  // the backslash that keeps the pipe in the cell is the one GFM deletes. The
  // characters are kept, written as text; only the code style is lost.
  cellsAre('code, one backslash', '<code>a \\| b</code>', 'a \\| b');
  // Every character, including the ones the reader would otherwise read as
  // markup (final review: `^2^`, `~~y~~`, `$x$`, `<!--`, `&amp;` all came
  // through as superscript, strikethrough, math, a swallowed comment, `&`).
  {
    const reader = require('marked').marked;
    require('../lib/md2doc.js');
    for (const code of ['a ^2^ \\| ~~y~~ $x$', 'a<!-- \\| -->', 'a &amp;copy; \\| <b>']) {
      const md = pm.htmlToMarkdown('<table><tr><th>h</th></tr><tr><td><code>' +
        code.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</code></td></tr></table>');
      const html = reader.parse(md);
      const cell = html.replace(/\n/g, '').match(/<tbody><tr><td>(.*?)<\/td><\/tr><\/tbody>/);
      const shown = cell && cell[1].replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
      eq(shown, code, 'v3177 F2 unspellable code keeps every character (md ' + JSON.stringify(md) + ')');
    }
  }
  // code without a pipe is untouched
  cellsAre('code, no pipe', '<code>a \\ b</code>', '<code>a \\ b</code>');
}

console.log('paste-md.test.js: ' + checks + ' checks passed');
