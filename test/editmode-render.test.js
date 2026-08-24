'use strict';
const path = require('path');
const assert = require('assert');
const { renderMarkdown } = require('../lib/md2doc.js');
const { buildBlockMap } = require('../lib/editor/blockmap.js');

(async () => {
  const md = [
    '# T', '', 'para', '',
    '| A |', '|---|', '| 1 |', '',
    '```mermaid', 'graph TD; a-->b;', '```', '',
  ].join('\n');
  const fake = path.join(__dirname, 'fixture.md'); // path only used for SRC_DIR

  const plain = await renderMarkdown(md, fake, {});
  assert.ok(!plain.bodyHtml.includes('ed-block'),
    'non-edit render has no wrappers');

  const edit = await renderMarkdown(md, fake, { editMode: true });
  const ids = [...edit.bodyHtml.matchAll(/data-block-id="(\d+)"/g)]
    .map((m) => Number(m[1]));
  const map = buildBlockMap(md);
  assert.deepStrictEqual(ids, map.blocks.map((b) => b.id),
    'one wrapper per block, in order');
  assert.ok(edit.bodyHtml.includes('data-block-type="table"'));
  assert.strictEqual(edit.blocks.length, map.blocks.length);

  // unwrapped inner content equals the plain render's content
  const stripped = edit.bodyHtml
    .replace(/<div class="ed-block"[^>]*>/g, '')
    .replace(/<\/div>\n?(?=<div class="ed-block"|$)/g, '');
  assert.ok(stripped.includes('<table') && plain.bodyHtml.includes('<table'),
    'table renders in both');

  // re-init hook present in the full page script
  assert.ok(edit.html.includes('__md2docInitDiagrams'),
    'diagram init exposed for re-invocation');
  assert.ok(plain.html.includes('__md2docInitDiagrams') === false ||
            plain.html.includes('__md2docInitDiagrams'),
    'hook may exist in plain mode too — allowed either way');

  const mdRef = 'x [[ref-1, §2]] y\n\ntail\n';
  const e2 = await renderMarkdown(mdRef, fake, { editMode: true });
  assert.strictEqual(e2.blocks[0].startLine, 1);
  assert.strictEqual(e2.blocks[1].startLine, 3, '[[...]] must not shift lines');

  console.log('editmode-render.test.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
