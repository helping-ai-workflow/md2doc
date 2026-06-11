#!/usr/bin/env node
'use strict';

// Regression: ~NOT / ^XOR operators inside code must NOT be mangled into
// <sub>/<sup>. The old pre-pass (mdPre.replace(/~([^~]+)~/...)) ran on raw
// markdown before marked tokenised, so it rewrote operators inside fenced,
// indented and inline code. Code-aware marked inline extensions fix this.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-op-test-'));
const mdPath = path.join(tmpDir, 'ops.md');
const htmlPath = path.join(tmpDir, 'ops.html');

fs.writeFileSync(
  mdPath,
  [
    '# Operators',
    '',
    'Inline code: `PAD = ~abort & ~fcs_param_present` and `crc ^ 0x0000 ^ mask`.',
    '',
    '    PAD  = ~abort & ~fcs & ~rg',          // indented code block
    '    GEN  = a ^ b ^ c',
    '',
    '```',
    'KEEP = ~abort & fcs & ~recompute',         // fenced code block
    'x = p ^ q ^ r',
    '```',
    '',
    'Genuine subscript H~2~O and superscript x^2^ in prose stay supported.',
    '',
  ].join('\n'),
  'utf8'
);

const run = spawnSync('node', ['lib/md2doc.js', mdPath, htmlPath], {
  cwd: path.resolve(__dirname, '..'),
  encoding: 'utf8',
});
if (run.status !== 0) {
  process.stderr.write(run.stdout || '');
  process.stderr.write(run.stderr || '');
  process.exit(run.status || 1);
}
const html = fs.readFileSync(htmlPath, 'utf8');

// Operators inside code: the rendered <code>/<pre> text must keep literal
// ~ and ^ — never <sub>/<sup> (literal or HTML-escaped).
const codeBlocks = [...html.matchAll(/<(code|pre)[^>]*>([\s\S]*?)<\/\1>/g)]
  .map((m) => m[2])
  .join('\n');
assert.ok(
  !/&lt;sub&gt;|<sub>|&lt;sup&gt;|<sup>/.test(codeBlocks),
  'operators inside code must NOT be rewritten to <sub>/<sup>; got:\n' + codeBlocks
);
assert.ok(/~abort &amp; ~fcs_param_present/.test(html), 'inline-code ~ operators must stay literal');
assert.ok(/crc \^ 0x0000 \^ mask/.test(html), 'inline-code ^ operators must stay literal');
assert.ok(/~abort &amp; ~fcs &amp; ~rg/.test(html), 'indented-code ~ operators must stay literal');
assert.ok(/a \^ b \^ c/.test(html), 'indented-code ^ operators must stay literal');

// Genuine sub/sup in prose still render.
assert.match(html, /H<sub>2<\/sub>O/, 'genuine ~x~ subscript in prose must still render');
assert.match(html, /x<sup>2<\/sup>/, 'genuine ^x^ superscript in prose must still render');

console.log('code-operator.test.js: PASS');
