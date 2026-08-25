'use strict';
const assert = require('assert');
const { serializeTable } = require('../lib/editor/table-md.js');

// minimal element stub — same pattern as test/inline-md.test.js
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

function th(attrs, ...children) { return el('th', attrs, ...children); }
function td(attrs, ...children) { return el('td', attrs, ...children); }
function tr(...children) { return el('tr', {}, ...children); }
// Models exactly what renderer.table (lib/md2doc.js) actually emits:
// <table><colgroup>...</colgroup><thead><tr>...</tr></thead><tbody>...</tbody></table>
function table(headerRow, bodyRows) {
  return el('table', {},
    el('colgroup', {}),
    el('thead', {}, headerRow),
    el('tbody', {}, ...bodyRows)
  );
}

// 1. minimal emission: single-space padding, unpadded '|---|' separator
{
  const t = table(
    tr(th({}, 'Col A'), th({}, 'Col B')),
    [tr(td({}, '1'), td({}, '2')), tr(td({}, '3'), td({}, '4'))]
  );
  const { md, unsupported } = serializeTable(t);
  assert.deepStrictEqual(unsupported, []);
  assert.strictEqual(md, [
    '| Col A | Col B |',
    '|---|---|',
    '| 1 | 2 |',
    '| 3 | 4 |',
  ].join('\n'));
}

// 2. literal '|' in a cell -> '&#124;'
{
  const t = table(tr(th({}, 'H')), [tr(td({}, 'a|b'))]);
  const { md } = serializeTable(t);
  assert.strictEqual(md, ['| H |', '|---|', '| a&#124;b |'].join('\n'));
}

// 3. <br> cell — a real <br> node inside a cell; inline-md.js already
// verifies BR -> '<br>', table-md.js does no extra handling for it.
{
  const t = table(tr(th({}, 'H')), [tr(td({}, 'a', el('br', {}), 'b'))]);
  const { md } = serializeTable(t);
  assert.strictEqual(md, ['| H |', '|---|', '| a<br>b |'].join('\n'));
}

// 4. alignment variants: left / right / center / default(no style)
{
  const t = table(
    tr(
      th({ style: 'text-align:left' }, 'L'),
      th({ style: 'text-align:right' }, 'R'),
      th({ style: 'text-align:center' }, 'C'),
      th({}, 'D')
    ),
    [tr(td({}, '1'), td({}, '2'), td({}, '3'), td({}, '4'))]
  );
  const { md } = serializeTable(t);
  const lines = md.split('\n');
  assert.strictEqual(lines[1], '|:---|---:|:---:|---|');
}

// 5. no line ends in whitespace (rows are always '|'-terminated by
// construction; this guards a future regression that adds trailing padding)
{
  const t = table(tr(th({}, 'H ')), [tr(td({}, 'x '))]);
  const { md } = serializeTable(t);
  md.split('\n').forEach((line) => {
    assert.strictEqual(line, line.replace(/\s+$/, ''),
      'line has trailing whitespace: ' + JSON.stringify(line));
  });
}

// 6. unsupported cell detection, aggregated across all cells
{
  const withImg = table(
    tr(th({}, 'H')),
    [tr(td({}, 'a', el('img', { src: 'x.png' })))]
  );
  const { unsupported } = serializeTable(withImg);
  assert.deepStrictEqual(unsupported, ['IMG']);
}

// every emitted line is ONE physical row starting with '|' (gate-compat
// precondition — see task-6 brief's gate-compat.test.js)
{
  const t = table(tr(th({}, 'H')), [tr(td({}, '1')), tr(td({}, '2'))]);
  const { md } = serializeTable(t);
  md.split('\n').forEach((line) => assert.ok(line.startsWith('|'), 'row must start with |: ' + line));
}

// header-only table (no body rows) still emits header + separator, no
// trailing empty row
{
  const t = table(tr(th({}, 'Only')), []);
  const { md } = serializeTable(t);
  assert.strictEqual(md, ['| Only |', '|---|'].join('\n'));
}

console.log('table-md.test.js OK');
