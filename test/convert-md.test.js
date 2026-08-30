'use strict';
const assert = require('assert');
const cm = require('../lib/editor/convert-md.js');

let checks = 0;
function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg + '\n  actual:   ' + JSON.stringify(actual) +
    '\n  expected: ' + JSON.stringify(expected));
  checks += 1;
}

// Finding 1's corruption is a TOKEN-SHAPE fact, not a string fact: the bad
// output lexed as code,paragraph. Assert against marked itself.
const { marked } = require('marked');
function lexTypes(ls) { return marked.lexer(ls.join('\n')).map((t) => t.type); }

// --- stripMarker: every kind the menu can be opened on -----------------------

eq(cm.stripMarker(['- alpha'], 'li').content, ['alpha'], 'ul item');
eq(cm.stripMarker(['  - alpha'], 'li').content, ['alpha'], 'indented ul item keeps no indent');
eq(cm.stripMarker(['1. alpha'], 'li').content, ['alpha'], 'ol item');
eq(cm.stripMarker(['10. alpha'], 'li').content, ['alpha'], 'two-digit ol item');
eq(cm.stripMarker(['- [ ] alpha'], 'li').content, ['alpha'], 'unchecked task');
eq(cm.stripMarker(['- [x] alpha'], 'li').content, ['alpha'], 'checked task');
eq(cm.stripMarker(['1. [X] alpha'], 'li').content, ['alpha'], 'ordered checked task, capital X');
eq(cm.stripMarker(['* alpha'], 'li').content, ['alpha'], 'asterisk bullet');
eq(cm.stripMarker(['+ alpha'], 'li').content, ['alpha'], 'plus bullet');
eq(cm.stripMarker(['1) alpha'], 'li').content, ['alpha'], 'paren-delimited ordinal');

eq(cm.stripMarker(['## alpha'], 'heading').content, ['alpha'], 'atx heading');
eq(cm.stripMarker(['###### alpha'], 'heading').content, ['alpha'], 'h6');
eq(cm.stripMarker(['## alpha ##'], 'heading').content, ['alpha'], 'closed atx heading');

eq(cm.stripMarker(['> alpha'], 'blockquote').content, ['alpha'], 'blockquote');
eq(cm.stripMarker(['> alpha', '> beta'], 'blockquote').content, ['alpha', 'beta'], 'two-line quote');
eq(cm.stripMarker(['>alpha'], 'blockquote').content, ['alpha'], 'quote with no space');

eq(cm.stripMarker(['```js', 'const a = 1;', '```'], 'code').content, ['const a = 1;'],
  'fenced code drops both fences and the info string');
eq(cm.stripMarker(['```', 'a', 'b', '```'], 'code').content, ['a', 'b'], 'multi-line fenced code');
eq(cm.stripMarker(['~~~', 'a', '~~~'], 'code').content, ['a'], 'tilde fence');

eq(cm.stripMarker(['alpha'], 'paragraph').content, ['alpha'], 'paragraph is its own content');
eq(cm.stripMarker(['alpha', 'beta'], 'paragraph').content, ['alpha', 'beta'], 'two-line paragraph');

// A shape we cannot strip must say so rather than guess.
eq(cm.stripMarker(['    indented code'], 'code').ok, false, 'indented code block is not strippable');
eq(cm.stripMarker([], 'paragraph').ok, false, 'no source lines is not strippable');

// --- emitAs: every target the submenu offers --------------------------------

eq(cm.emitAs(['alpha'], 'text', {}), ['alpha'], 'to text');
eq(cm.emitAs(['alpha'], 'h1', {}), ['# alpha'], 'to h1');
eq(cm.emitAs(['alpha'], 'h6', {}), ['###### alpha'], 'to h6');
eq(cm.emitAs(['alpha'], 'ul', {}), ['- alpha'], 'to bullet list');
eq(cm.emitAs(['alpha'], 'ol', {}), ['1. alpha'], 'to ordered list');
eq(cm.emitAs(['alpha'], 'task', {}), ['- [ ] alpha'], 'to task list');
eq(cm.emitAs(['alpha'], 'quote', {}), ['> alpha'], 'to quote');
eq(cm.emitAs(['alpha'], 'code', {}), ['```', 'alpha', '```'], 'to code');

eq(cm.emitAs(['alpha', 'beta'], 'quote', {}), ['> alpha', '> beta'], 'multi-line to quote');
eq(cm.emitAs(['alpha', 'beta'], 'code', {}), ['```', 'alpha', 'beta', '```'], 'multi-line to code');

// indentPrefix is supplied by the caller, which owns the marker-width stack.
eq(cm.emitAs(['alpha'], 'ul', { indentPrefix: '  ' }), ['  - alpha'], 'indented bullet');
eq(cm.emitAs(['alpha'], 'ol', { indentPrefix: '   ', ordinal: 3 }), ['   3. alpha'], 'indented ordinal');
eq(cm.emitAs(['alpha'], 'task', { checked: true }), ['- [x] alpha'], 'checked task preserved');

// A heading cannot hold more than one line: the rest is dropped by the caller,
// so emitAs must refuse to invent a shape that re-lexes as two blocks.
eq(cm.emitAs(['alpha', 'beta'], 'h2', {}), ['## alpha beta'], 'multi-line to heading joins with a space');

// --- the target list the submenu renders ------------------------------------

eq(cm.CONVERT_TARGETS.map((t) => t.id),
  ['text', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'task', 'code', 'quote'],
  'submenu order, spec 3.2 v1 — no collapsible list in this version');
eq(cm.CONVERT_TARGETS.map((t) => t.label),
  ['文字', '標題 1', '標題 2', '標題 3', '標題 4', '標題 5', '標題 6',
   '項目符號列表', '編號列表', '待辦清單', '程式碼', '引用'],
  'submenu labels');

eq(cm.targetIsList('ul'), true, 'ul is a list target');
eq(cm.targetIsList('task'), true, 'task is a list target');
eq(cm.targetIsList('h3'), false, 'a heading is not a list target');
eq(cm.listAttrsFor('task'), { listType: 'ul', task: true }, 'task is ul x task, spec 4.1 orthogonality');
eq(cm.listAttrsFor('ol'), { listType: 'ol', task: false }, 'ol is not a task');
eq(cm.listAttrsFor('text'), null, 'text has no list attrs');

// --- round trip: strip then re-emit is identity for the same shape ----------

for (const [line, kind, target] of [
  ['- alpha', 'li', 'ul'],
  ['1. alpha', 'li', 'ol'],
  ['- [x] alpha', 'li', 'task'],
  ['## alpha', 'heading', 'h2'],
  ['##', 'heading', 'h2'],
  ['> alpha', 'blockquote', 'quote'],
]) {
  const s = cm.stripMarker([line], kind);
  const opts = kind === 'li' && /\[x\]/i.test(line) ? { checked: true } : {};
  eq(cm.emitAs(s.content, target, opts), [line], 'round trip ' + line);
}

// ============================================================================
// Post-review fixes. Every expectation below was measured against marked
// 14.1.4 before it was written; where a measurement contradicted the review
// finding, the measurement won and the comment says so.
// ============================================================================

// --- finding 1: emitAs must negotiate the opening fence length --------------
// A body that itself contains a fence line closed the block early: the output
// lexed as code,paragraph, i.e. `after` escaped the block into the document.
// Measured: a run of N backticks is closed only by a run of >= N of the SAME
// character, indented at most 3 columns, carrying no info string.
eq(cm.emitAs(['before', '```', 'after'], 'code', {}),
  ['````', 'before', '```', 'after', '````'], 'a body fence forces a longer opening fence');
eq(lexTypes(cm.emitAs(['before', '```', 'after'], 'code', {})), ['code'],
  'the emitted block must lex as ONE code token, not code,paragraph');
eq(cm.emitAs(['a', '`````', 'b'], 'code', {}), ['``````', 'a', '`````', 'b', '``````'],
  'a 5-run needs a 6-fence');
eq(lexTypes(cm.emitAs(['a', '`````', 'b'], 'code', {})), ['code'], 'and the 6-fence really holds');
eq(cm.emitAs(['a', '  ```', 'b'], 'code', {}), ['````', 'a', '  ```', 'b', '````'],
  '2 columns of indent still closes a fence, so that line still counts');
// Measured, against the review instruction: a TILDE run cannot close a
// backtick fence, so it must not inflate one.
eq(cm.emitAs(['a', '~~~', 'b'], 'code', {}), ['```', 'a', '~~~', 'b', '```'],
  'a tilde run does not close a backtick fence, so no inflation');
eq(lexTypes(cm.emitAs(['a', '~~~', 'b'], 'code', {})), ['code'], 'and it really is one token');
// Measured: 4 columns is past the closing-fence window, and an inline run is
// not a fence line at all. Neither may inflate the fence.
eq(cm.emitAs(['a', '    ```', 'b'], 'code', {}), ['```', 'a', '    ```', 'b', '```'],
  '4 columns of indent is past the closing-fence window');
eq(lexTypes(cm.emitAs(['a', '    ```', 'b'], 'code', {})), ['code'], 'and that block holds too');
eq(cm.emitAs(['a ``` b'], 'code', {}), ['```', 'a ``` b', '```'],
  'an inline run is not a fence line');
eq(lexTypes(cm.emitAs(['a ``` b'], 'code', {})), ['code'], 'and that block holds too');

// --- finding 3: only a REAL closing fence may be dropped --------------------
// stripMarker matched "looks like a fence" without comparing character or
// length, so it ate a line of the user's code whenever the last line was a
// fence-shaped line that marked does NOT treat as closing.
eq(cm.stripMarker(['````', 'a', '```'], 'code').content, ['a', '```'],
  'a shorter run does not close a longer fence, so it is content');
eq(cm.stripMarker(['```', 'a', '~~~'], 'code').content, ['a', '~~~'],
  'a tilde run does not close a backtick fence');
eq(cm.stripMarker(['~~~', 'a', '```'], 'code').content, ['a', '```'], 'and the mirror case');
eq(cm.stripMarker(['```', 'a', '```js'], 'code').content, ['a', '```js'],
  'a closing fence may not carry an info string');
eq(cm.stripMarker(['```', 'a', '    ```'], 'code').content, ['a', '    ```'],
  '4 columns of indent is past the closing-fence window');
eq(cm.stripMarker(['```', 'a', '   ```'], 'code').content, ['a'],
  '3 columns of indent still closes');
eq(cm.stripMarker(['```', 'a'], 'code').content, ['a'],
  'an unterminated fence keeps every body line');
// MEASURED CORRECTION to review finding 3: a LONGER run of the same character
// really does close a shorter fence (marked: '````\na\n```' keeps the '```',
// but '```\na\n````' does not). The original example was not a bug.
eq(cm.stripMarker(['```js', 'a', '````'], 'code').content, ['a'],
  'a longer run of the same char DOES close');

// --- finding 2: a multi-line li refuses instead of guessing -----------------
// The li branch flattened continuation lines with replace(/^\s+/, ''), which
// is exactly the guess the code branch refuses to make for indented code, and
// it destroys any structure the continuation carried.
eq(cm.stripMarker(['- a', '  cont'], 'li').ok, false, 'a multi-line li is not strippable');
eq(cm.stripMarker(['- a', '      indented cont'], 'li').ok, false,
  'flattening the continuation destroyed structure; refuse, like indented code does');
eq(cm.stripMarker(['- a', '  cont'], 'li').content, [], 'a refusal carries no content');
eq(cm.stripMarker(['- a'], 'li').ok, true, 'a single-line li is unaffected');

// --- finding 4: an empty ATX heading is a heading --------------------------
// Measured: marked lexes '#', '##', '###', '## ##' and '#### #' all as a
// heading whose text is ''. Refusing them showed the user 此區塊的格式無法轉換
// when they opened the menu on an empty heading.
eq(cm.stripMarker(['##'], 'heading'), { content: [''], ok: true },
  'a hashes-only heading is empty, not unstrippable');
eq(cm.stripMarker(['#'], 'heading').content, [''], 'h1 likewise');
eq(cm.stripMarker(['## ##'], 'heading').content, [''], 'a bare closing sequence leaves empty content');
eq(cm.stripMarker(['#### #'], 'heading').content, [''], 'ditto with an odd-length closing run');
eq(cm.stripMarker(['## '], 'heading').content, [''], 'hashes plus a trailing space');
eq(cm.stripMarker(['## alpha#'], 'heading').content, ['alpha#'],
  'a # not preceded by a space is content, not a closing sequence');
eq(cm.stripMarker(['## alpha #x'], 'heading').content, ['alpha #x'], 'a non-run tail is content');
eq(cm.stripMarker(['## alpha  ##  '], 'heading').content, ['alpha'],
  'closing run plus trailing whitespace');
// Still refused, because marked does not lex these as headings either.
eq(cm.stripMarker(['#alpha'], 'heading').ok, false, 'no space after the hashes is not a heading');
eq(cm.stripMarker(['####### alpha'], 'heading').ok, false, 'seven hashes is not a heading');

// An empty heading must not gain a trailing space on the way back out, or a
// no-op conversion would rewrite bytes.
eq(cm.emitAs([''], 'h2', {}), ['##'], 'an empty heading emits no trailing space');
eq(cm.emitAs([], 'h2', {}), ['##'], 'no content at all, same');
eq(lexTypes(cm.emitAs([''], 'h2', {})), ['heading'], 'and it still lexes as a heading');

console.log('convert-md.test.js OK (' + checks + ' checks)');
