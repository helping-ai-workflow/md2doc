'use strict';
const assert = require('assert');
const { marked } = require('marked');
const { serializeList } = require('../lib/editor/list-md.js');

// minimal element stub — same pattern as test/table-md.test.js / test/inline-md.test.js
function el(name, attrs, ...children) {
  return {
    nodeType: 1, nodeName: name.toUpperCase(),
    childNodes: children.map(c => typeof c === 'string' ? { nodeType: 3, textContent: c } : c),
    getAttribute: (k) => (attrs || {})[k] !== undefined ? attrs[k] : null,
    get textContent() {
      return this.childNodes.map(c => c.textContent).join('');
    },
  };
}
function text(s) { return { nodeType: 3, textContent: s }; }
function li(...children) { return el('li', {}, ...children); }
function ul(...children) { return el('ul', {}, ...children); }
function ol(...children) { return el('ol', {}, ...children); }

marked.setOptions({ gfm: true, breaks: false });

// 1. flat ul
{
  const list = ul(li('item one'), li('item two'), li('item three'));
  const { md, unsupported } = serializeList(list);
  assert.deepStrictEqual(unsupported, []);
  assert.strictEqual(md, [
    '- item one',
    '- item two',
    '- item three',
  ].join('\n'));
}

// 2. ordered list renumbers 1..n regardless of any DOM `start`
{
  const list = ol(li('three'), li('four'), li('five'));
  const { md, unsupported } = serializeList(list);
  assert.deepStrictEqual(unsupported, []);
  assert.strictEqual(md, [
    '1. three',
    '2. four',
    '3. five',
  ].join('\n'));
}

// 3. 3-deep nesting indent — verified against marked's real DOM shape below
// (nested <ul>/<ol> is a trailing child of the parent <li>, not a sibling).
{
  const list = ul(
    li('item one'),
    li('item two', ul(
      li('nested a'),
      li('nested b', ol(
        li('deep 1'),
        li('deep 2')
      ))
    )),
    li('item three')
  );
  const { md, unsupported } = serializeList(list);
  assert.deepStrictEqual(unsupported, []);
  assert.strictEqual(md, [
    '- item one',
    '- item two',
    '  - nested a',
    '  - nested b',
    '    1. deep 1',
    '    2. deep 2',
    '- item three',
  ].join('\n'));
}

// 3b. structural round-trip check via marked.parse of the real source markdown,
// confirming the DOM shape this task models is what marked actually emits.
{
  const srcMd = [
    '- item one',
    '- item two',
    '  - nested a',
    '  - nested b',
    '    1. deep 1',
    '    2. deep 2',
    '- item three',
  ].join('\n');
  const html = marked.parse(srcMd);
  assert.ok(html.includes('<li>item two<ul>'), 'nested <ul> must be a trailing child of its <li>: ' + html);
  assert.ok(html.includes('<li>nested b<ol>'), 'nested <ol> must be a trailing child of its <li>: ' + html);
}

// 4. item with <br> and inline marks
{
  const list = ul(li('a ', el('strong', {}, 'bold'), ' ', el('br', {}), 'line two'));
  const { md, unsupported } = serializeList(list);
  assert.deepStrictEqual(unsupported, []);
  assert.strictEqual(md, '- a **bold** <br>line two');
}

// 5. mixed ol-in-ul
{
  const list = ul(li('a', ol(li('b'), li('c'))));
  const { md, unsupported } = serializeList(list);
  assert.deepStrictEqual(unsupported, []);
  assert.strictEqual(md, ['- a', '  1. b', '  2. c'].join('\n'));
}

// 6. unsupported: checkbox input (task list) — flagged via inline-md.js's
// own default unhandled-element branch, no special-case in list-md.js.
{
  const list = ul(li(el('input', { type: 'checkbox', disabled: '' }), ' todo'));
  const { unsupported } = serializeList(list);
  assert.ok(unsupported.includes('INPUT'), 'checkbox input must be reported unsupported');
}

// 6b. unsupported: non-LI child of a UL/OL
{
  const list = ul(el('div', {}, 'stray'));
  const { unsupported } = serializeList(list);
  assert.ok(unsupported.includes('DIV'), 'non-LI child must be reported unsupported');
}

// 7. no trailing whitespace on any line, even when item text itself
// carries a trailing space.
{
  const list = ul(li('trailing space '), li('normal'));
  const { md } = serializeList(list);
  md.split('\n').forEach((line) => {
    assert.strictEqual(line, line.replace(/[ \t]+$/, ''),
      'line has trailing whitespace: ' + JSON.stringify(line));
  });
}

// 8. loose list (marked's <p>-wrapped item, per real renderer finding —
// this task's decision: degrade to unsupported 'P', item text still
// best-effort serialized).
{
  // models marked's real loose-list DOM shape:
  // <li><p>item one</p></li>  (trailing insignificant whitespace text
  // node included, mirroring what a real DOM parser produces — see
  // module header)
  const list = ul(
    li(el('p', {}, 'item one'), text('\n')),
    li(el('p', {}, 'item two'), text('\n'), ul(li('nested a')))
  );
  const { md, unsupported } = serializeList(list);
  assert.ok(unsupported.includes('P'), 'loose list item must be reported unsupported');
  assert.strictEqual(md, ['- item one', '- item two', '  - nested a'].join('\n'));
  // no blank line anywhere, and no leaked literal newline from the dropped
  // insignificant whitespace text node
  assert.ok(!md.includes('\n\n'), 'no blank line inside emitted block');
  md.split('\n').forEach((line) => assert.strictEqual(line, line.replace(/[ \t]+$/, '')));
}

// gate-compat: every emitted line matches /^( {2})*(-|\d+\.) /
{
  const list = ul(
    li('a', ul(li('b', ol(li('c'), li('d')))))
  );
  const { md } = serializeList(list);
  md.split('\n').forEach((line) => {
    assert.ok(/^( {2})*(-|\d+\.) /.test(line), 'line fails gate marker regex: ' + JSON.stringify(line));
  });
}

// gate-compat: no blank lines inside the emitted block for a deep mixed list
{
  const list = ul(
    li('a', ul(li('b'), li('c', ol(li('d'), li('e'))))),
    li('f')
  );
  const { md } = serializeList(list);
  assert.ok(!md.includes('\n\n'), 'no blank line inside emitted block');
}

console.log('list-md.test.js OK');
