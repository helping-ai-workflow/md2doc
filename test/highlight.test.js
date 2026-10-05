'use strict';
const assert = require('assert');
const path = require('path');
const { highlightCode } = require('../lib/highlight.js');
const { renderMarkdown } = require('../lib/md2doc.js');

const v = highlightCode("module a; assign x = 1'b0; // c\nendmodule", 'verilog');
assert.ok(v.includes('<span class="hljs-keyword">module</span>'), v);
assert.ok(v.includes('hljs-number') && v.includes('hljs-comment'), v);
assert.strictEqual(highlightCode('a <b>', 'nosuchlang'), null, 'unregistered → null');
assert.strictEqual(highlightCode('x', ''), null, 'no lang → null');
assert.ok(highlightCode('module m; endmodule', 'verilog title=x').includes('hljs-keyword'), 'first word only');
assert.ok(highlightCode('module m; endmodule', 'SystemVerilog').includes('hljs-keyword'), 'alias, case-insensitive');
assert.ok(highlightCode('a < b && c', 'python').includes('&lt;'), 'escaped');

(async () => {
  const src = path.join(__dirname, 'fixtures-highlight.md');
  const md = '\x60\x60\x60verilog\nmodule a; endmodule\n\x60\x60\x60\n\n\x60\x60\x60\na <b>\n\x60\x60\x60\n\n\x60\x60\x60nosuch\nplain & text\n\x60\x60\x60\n';
  const { html } = await renderMarkdown(md, src, {});
  assert.ok(/<pre><code class="language-verilog hljs"><span class="hljs-keyword">module<\/span>/.test(html), 'verilog block coloured');
  assert.ok(html.includes('<pre><code class="language-">a &lt;b&gt;</code></pre>'), 'unlabelled block plain');
  assert.ok(html.includes('<pre><code class="language-nosuch">plain &amp; text</code></pre>'), 'unknown lang plain');
  const text = (h) => h.replace(/<[^>]+>/g, '');
  assert.strictEqual(text(highlightCode('module a; // x', 'verilog')), 'module a; // x', 'textContent unchanged');
  assert.ok(!/<script[^>]*>[^<]*hljs/.test(html), 'no highlighting script in the page');
  const edit = (await renderMarkdown(md, src, { editMode: true })).html;
  assert.ok(edit.includes('hljs-keyword'), 'edit mode blocks coloured too');
  // The info string lands in an attribute and must stay text there.
  const evil = (await renderMarkdown('\x60\x60\x60x" onmouseover="alert(1)\ny\n\x60\x60\x60\n', src, {})).html;
  assert.ok(!/<code[^>]*\sonmouseover="/.test(evil) && evil.includes('language-x&quot; onmouseover=&quot;alert(1)'), 'info string escaped in class');
  console.log('highlight: ok');
})().catch((e) => { console.error(e); process.exit(1); });
