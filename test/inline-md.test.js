'use strict';
const assert = require('assert');
const { serializeInline, canWysiwyg, escapeText } = require('../lib/editor/inline-md.js');

// minimal element stub
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

// marks
assert.strictEqual(serializeInline(el('p', {}, 'a ', el('strong', {}, 'b'), ' c')).md, 'a **b** c');
assert.strictEqual(serializeInline(el('p', {}, el('em', {}, 'x'))).md, '*x*');
assert.strictEqual(serializeInline(el('p', {}, el('code', {}, 'pmac_tx_tvalidchk'))).md, '`pmac_tx_tvalidchk`');
// code containing a backtick → double-backtick fence
assert.strictEqual(serializeInline(el('p', {}, el('code', {}, 'a`b'))).md, '`` a`b ``');
// links + citation
assert.strictEqual(serializeInline(el('p', {}, el('a', { href: 'http://x' }, 'lnk'))).md, '[lnk](http://x)');
assert.strictEqual(serializeInline(el('p', {}, el('a', { href: '#ref-1' }, '[ref-1, §2]'))).md, '[[ref-1, §2]]');
// br
assert.strictEqual(serializeInline(el('p', {}, 'a', el('br', {}), 'b')).md, 'a<br>b');
// escaping: backtick/asterisk/backslash always; underscore intraword NOT escaped
assert.strictEqual(escapeText('snake_case_id'), 'snake_case_id');
assert.strictEqual(escapeText('_lead and trail_'), '\\_lead and trail\\_');
assert.strictEqual(escapeText('a*b `c` d\\e'), 'a\\*b \\`c\\` d\\\\e');
assert.strictEqual(escapeText('x < y'), 'x &lt; y');
// unsupported detection
const withImg = el('p', {}, 'a', el('img', { src: 'x.png' }));
assert.deepStrictEqual(serializeInline(withImg).unsupported, ['IMG']);
assert.strictEqual(canWysiwyg(withImg), false);
assert.strictEqual(canWysiwyg(el('p', {}, 'plain ', el('strong', {}, 'ok'))), true);
// nested marks
assert.strictEqual(serializeInline(el('p', {}, el('strong', {}, el('em', {}, 'both')))).md, '***both***');

// --- normalization pre-approved for Tasks 3/5 (contenteditable DOM realities) ---
// bare <span> (no attributes) is transparent — unwraps to its children
assert.strictEqual(serializeInline(el('p', {}, el('span', {}, 'a '), el('strong', {}, 'b'), el('span', {}, ' c'))).md, 'a **b** c');
// <span style="..."> (or any attribute) is NOT transparent — unsupported
const withStyledSpan = el('p', {}, 'a', el('span', { style: 'color:red' }, 'b'));
assert.deepStrictEqual(serializeInline(withStyledSpan).unsupported, ['SPAN']);
assert.strictEqual(canWysiwyg(withStyledSpan), false);
// <div> boundary between siblings acts as <br>
assert.strictEqual(serializeInline(el('div', {}, el('div', {}, 'a'), el('div', {}, 'b'))).md, 'a<br>b');

console.log('inline-md.test.js OK');
