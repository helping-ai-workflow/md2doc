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

const hlLib = require('../lib/highlight.js');
const vm = require('vm');
// v3.17.0 T1 (D6): the browser build of the same highlighter.
{
  const bundle = hlLib.browserBundle();
  assert.strictEqual(typeof bundle, 'string');
  assert.ok(!/<\/script/i.test(bundle), 'the bundle is served as a script: no closing script tag');
  assert.strictEqual(hlLib.browserBundle(), bundle, 'memoised');
  const ctx = { window: {} }; ctx.self = ctx.window; vm.createContext(ctx);
  vm.runInContext(bundle, ctx);
  const b = ctx.window.md2docHljs;
  assert.ok(b && typeof b.highlightCode === 'function', 'window.md2docHljs.highlightCode');
  assert.deepStrictEqual(Array.from(b.LANGS), hlLib.LANGS);
  assert.strictEqual(b.highlightCode('module m;', 'sv'), highlightCode('module m;', 'sv'));
  assert.strictEqual(b.highlightCode('x', 'rust'), null);
  assert.strictEqual(b.highlightCode('x', ''), null);
  for (const [lang, code] of [['python', 'def f(x):\n  return x < 2'], ['json', '{"a": [1, 2]}'], ['bash', 'echo $HOME | wc'], ['diff', '-a\n+b']]) {
    assert.strictEqual(b.highlightCode(code, lang + ' title=x'), highlightCode(code, lang + ' title=x'), lang);
  }
}
assert.deepStrictEqual(hlLib.LANGS, ['verilog', 'python', 'bash', 'c', 'cpp', 'json', 'yaml', 'tcl', 'makefile', 'javascript', 'diff', 'plaintext']);
assert.deepStrictEqual(hlLib.ALIASES, { systemverilog: 'verilog', sv: 'verilog', v: 'verilog', sh: 'bash', shell: 'bash', zsh: 'bash' });
// R32: the coloured HTML's text content is the input, byte for byte.
{
  const unesc = (h) => h.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
  const fixtures = [
    ['verilog', 'assign a = b < c && d;\n// x & y'],
    ['python', 'if a < b and c > d:\n\tprint("&amp; 中文")'],
    ['c', 'x = a<b ? "\t" : \'&\';'],
    ['json', '{"名稱": "值 <b>", "t": "\t"}'],
    ['bash', 'echo "unterminated string $HOME &'],
    ['python', "s = 'never closed\nnext < line"],
    ['javascript', 'const s = `open ${a} <'],
  ];
  for (const [lang, x] of fixtures) {
    const h = highlightCode(x, lang);
    assert.ok(h !== null, lang);
    assert.strictEqual(unesc(h), x, 'textContent unchanged for ' + lang + ': ' + JSON.stringify(x));
  }
}

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
