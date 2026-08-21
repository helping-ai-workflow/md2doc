#!/usr/bin/env node
'use strict';

// Image assets: markdown (and raw-HTML) image references must survive the move
// from the markdown's directory to wherever the HTML lands (OS temp dir by
// default). Relative srcs are resolved against the SOURCE markdown and inlined
// as data: URIs so the output stays self-contained.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'lib', 'md2doc.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-img-'));
const srcDir = path.join(tmpDir, 'doc');
const assetDir = path.join(srcDir, 'assets');
// Output deliberately lands OUTSIDE srcDir — that is the real-world failure
// mode (default render target is the OS temp dir).
const outDir = path.join(tmpDir, 'out');
fs.mkdirSync(assetDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

// 1x1 transparent PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const pngBytes = Buffer.from(PNG_B64, 'base64');
fs.writeFileSync(path.join(assetDir, 'block.png'), pngBytes);
fs.writeFileSync(path.join(assetDir, 'my pic.png'), pngBytes);
fs.writeFileSync(path.join(assetDir, 'diagram.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>', 'utf8');
const absPng = path.join(tmpDir, 'abs.png');
fs.writeFileSync(absPng, pngBytes);
fs.writeFileSync(path.join(assetDir, 'v1:2.png'), pngBytes);
// A non-image local file that a malicious / careless markdown could point at.
const secretPath = path.join(tmpDir, 'id_rsa');
fs.writeFileSync(secretPath, 'PRIVATE-KEY-CONTENT-DO-NOT-INLINE', 'utf8');

const mdPath = path.join(srcDir, 'doc.md');
fs.writeFileSync(mdPath, [
  '# Images',
  '',
  '![block diagram](assets/block.png)',
  '',
  '![titled](assets/block.png "A Title")',
  '',
  '![spaced](assets/my%20pic.png)',
  '',
  '![vector](./assets/diagram.svg)',
  '',
  '![absolute](' + absPng + ')',
  '',
  '![remote](https://example.com/remote.png)',
  '',
  '![prebaked](data:image/gif;base64,R0lGODlhAQABAAAAACw=)',
  '',
  '![gone](assets/missing.png)',
  '',
  '<img src="assets/block.png" width="400" alt="raw html">',
  '',
  '<img alt="gt > inside" src="assets/block.png">',
  '',
  '<img src=assets/block.png alt="unquoted">',
  '',
  '![amp & lt <x> quote "q"](assets/block.png "T & T")',
  '',
  '`<img src="assets/block.png">` stays literal.',
  '',
  '![colon name](assets/v1:2.png)',
  '',
  '![fragment](assets/diagram.svg#gear)',
  '',
  '![query](assets/block.png?v=2)',
  '',
  '![secret](../id_rsa)',
  '',
  '<img src="assets/block.png" srcset="assets/block.png 1x, assets/my%20pic.png 2x">',
  '',
  '<picture><source srcset="assets/diagram.svg" type="image/svg+xml"><img src="assets/block.png"></picture>',
  '',
  '<!-- <img src="assets/block.png"> -->',
  '',
].join('\n'), 'utf8');

const htmlPath = path.join(outDir, 'doc.html');
const run = spawnSync('node', [LIB, mdPath, htmlPath], { cwd: REPO, encoding: 'utf8' });
assert.strictEqual(run.status, 0, 'image fixture renders: ' + run.stderr);
const html = fs.readFileSync(htmlPath, 'utf8');

// Scope every assertion to the rendered document body: the page also carries
// bundled mermaid/katex JS whose source text contains the literal '<img'.
const bodyStart = html.indexOf('<main class="content">');
assert.ok(bodyStart > 0, 'located the content container');
const body = html.slice(bodyStart, html.indexOf('</main>', bodyStart) + 1 || undefined);

const pngDataUri = 'data:image/png;base64,' + PNG_B64;
// A deliberately commented-out <img> keeps its relative src, so the
// "nothing relative survives" assertions look at the live markup only.
const live = body.replace(/<!--[\s\S]*?-->/g, '');

// 1. Relative image is inlined, and the bare relative src is gone.
assert.ok(body.includes(pngDataUri), 'relative png inlined as a data: URI');
assert.ok(!/src="assets\/block\.png"/.test(live), 'no bare relative src left for assets/block.png');

// 2. alt text survives.
assert.match(body, /alt="block diagram"/, 'alt text preserved');

// 3. title survives.
assert.match(body, /title="A Title"/, 'title attribute preserved');

// 4. Percent-encoded filename resolves to the real file on disk.
assert.ok(!/src="assets\/my%20pic\.png"/.test(live), 'percent-encoded src resolved, not passed through');
assert.strictEqual(
  (body.match(new RegExp(pngDataUri.replace(/[+/]/g, '\\$&'), 'g')) || []).length >= 4,
  true,
  'block.png (x2 + raw html) and "my pic.png" all inlined'
);

// 5. './'-prefixed SVG inlined with the svg mime type.
assert.match(body, /src="data:image\/svg\+xml;base64,/, 'svg inlined with image/svg+xml');
assert.ok(!/src="\.\/assets\/diagram\.svg"/.test(live), 'no bare ./assets/diagram.svg src left');

// 6. Absolute local path inlined too.
assert.ok(!body.includes('src="' + absPng + '"'), 'absolute local path inlined, not left as a bare path');

// 7. Remote and pre-baked data URIs pass through untouched.
assert.match(body, /src="https:\/\/example\.com\/remote\.png"/, 'remote URL untouched');
assert.match(body, /src="data:image\/gif;base64,R0lGODlhAQABAAAAACw="/, 'existing data: URI untouched');

// 8. Missing file: no crash, src preserved verbatim, warning on stderr.
assert.match(body, /src="assets\/missing\.png"/, 'missing image keeps its original src');
assert.match(run.stderr, /assets\/missing\.png/, 'missing image warned on stderr');

// 9. Raw-HTML <img> in markdown gets the same treatment, attributes intact.
assert.match(body, /<img[^>]*width="400"/, 'raw html img keeps its width attribute');
assert.match(body, /<img[^>]*alt="raw html"/, 'raw html img keeps its alt attribute');

// 10. Library code embedded in the page must NOT have been rewritten.
assert.ok(html.length > body.length, 'assertions were scoped to the document body');

// 11. alt / title must be escaped exactly ONCE. marked's tokenizer already
// escapes both (its stock renderer interpolates them raw), so re-escaping in a
// custom renderer.image turns '&' into a visible '&amp;'.
assert.match(body, /alt="amp &amp; lt &lt;x&gt; quote &quot;q&quot;"/, 'alt escaped exactly once');
assert.match(body, /title="T &amp; T"/, 'title escaped exactly once');
assert.ok(!/&amp;amp;/.test(body), 'no double-escaped entity anywhere in the body');

// 12. A quoted attribute may contain '>' — the tag matcher must not truncate
// there and miss a src that sits after it.
assert.match(body, /<img alt="gt > inside" src="data:image\/png;base64,/, 'src after a >-bearing attribute still inlined');

// 13. Unquoted src (legal HTML) is inlined and comes back quoted.
assert.match(body, /<img src="data:image\/png;base64,[^"]+" alt="unquoted">/, 'unquoted src inlined and re-quoted');

// 14. An <img> inside a codespan stays literal — it is escaped text, not markup.
assert.match(body, /<code>&lt;img src=&quot;assets\/block\.png&quot;&gt;<\/code>/, 'codespan img left untouched');

// 15. A filename containing ':' is a local file, not a URL scheme.
assert.ok(!/src="assets\/v1:2\.png"/.test(body), "':' in a filename does not make it a remote ref");

// 16. An SVG fragment (#gear selects a symbol inside the file) survives.
assert.match(body, /src="data:image\/svg\+xml;base64,[^"]+#gear"/, 'svg fragment re-attached to the data URI');

// 17. A cache-busting query is dropped, and the file still inlines.
assert.ok(!/src="assets\/block\.png\?v=2"/.test(body), '?query src resolved and inlined');

// 18. Extension allowlist: a non-image local file is NEVER read into the output.
assert.match(body, /src="\.\.\/id_rsa"/, 'non-image ref left as-is');
assert.ok(!html.includes('PRIVATE-KEY-CONTENT-DO-NOT-INLINE'), 'non-image file content not inlined verbatim');
assert.ok(
  !html.includes(Buffer.from('PRIVATE-KEY-CONTENT-DO-NOT-INLINE', 'utf8').toString('base64')),
  'non-image file content not inlined as base64'
);
assert.match(run.stderr, /not a known image extension.*id_rsa/, 'non-image ref warned on stderr');

// 19. srcset candidates are rewritten too — a browser prefers srcset over src,
// so leaving it relative renders a broken image even when src is inlined.
assert.ok(!/srcset="[^"]*assets\//.test(live), 'no relative candidate left in any srcset');
assert.match(body, /srcset="data:image\/png;base64,[^"]+ 1x, ?data:image\/png;base64,[^"]+ 2x"/, 'both srcset candidates inlined with descriptors intact');

// 20. <source> inside <picture> is rewritten as well.
assert.match(body, /<source srcset="data:image\/svg\+xml;base64,[^"]+" type="image\/svg\+xml">/, 'picture/source srcset inlined');

// 21. An <img> inside an HTML comment is left alone (invisible — inlining it
// would only bloat the output).
assert.match(body, /<!-- <img src="assets\/block\.png"> -->/, 'commented-out img untouched');

console.log('md2doc image-asset test passed');
