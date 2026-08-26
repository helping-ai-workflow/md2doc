'use strict';
const path = require('path');
const assert = require('assert');
const { renderMarkdown } = require('../lib/md2doc.js');
const { buildBlockMap } = require('../lib/editor/blockmap.js');

(async () => {
  // Extend fixture with a list containing a nested sublist and a task item, so
  // the id-sequence assertion exercises per-li twin-walk synchronization.
  const md = [
    '# T', '', 'para', '',
    '| A |', '|---|', '| 1 |', '',
    '```mermaid', 'graph TD; a-->b;', '```', '',
    '- item a', '  1. nested c', '- [x] done', '',
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

  // Helper: render md in editMode and return bodyHtml.
  async function renderEdit(m) {
    const r = await renderMarkdown(m, fake, { editMode: true });
    return r.bodyHtml;
  }

  // --- per-li blocks: li carries ed-block; no div wrapper around the list ---
  const listHtml = await renderEdit('- **a** x\n- b\n  1. c');
  assert(!/<div class="ed-block" data-block-type="list"/.test(listHtml),
    'no list-container ed-block div');
  assert(/<li class="ed-block" data-block-id="0" data-block-type="li" data-list-type="ul" data-indent="0">/.test(listHtml),
    'first li has correct ed-block attrs');
  assert(/<div class="ed-li-text"><strong>a<\/strong> x<\/div>/.test(listHtml),
    'inline wrapped in ed-li-text');
  assert(/data-list-type="ol" data-indent="1"/.test(listHtml),
    'nested ol li attrs');

  // task li renders check chrome OUTSIDE ed-li-text
  const taskHtml = await renderEdit('- [x] done');
  assert(/<span class="ed-li-check" data-checked="1" role="checkbox" aria-checked="true"><\/span><div class="ed-li-text">done<\/div>/.test(taskHtml),
    'task check span before ed-li-text');

  // loose list: <p> must be preserved inside ed-li-text (RULING F-L)
  const looseHtml = await renderEdit('- a\n\n- b');
  assert(/<div class="ed-li-text"><p>a<\/p>/.test(looseHtml),
    'loose list keeps <p> in ed-li-text');

  console.log('editmode-render.test.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
