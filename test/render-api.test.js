'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { renderMarkdown } = require('../lib/md2doc.js');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-api-'));
  const mdPath = path.join(dir, 'a.md');
  const md = '# Title\n\nHello **world**.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n';
  fs.writeFileSync(mdPath, md, 'utf8');

  // requiring the module must NOT exit the process or demand argv
  const out = await renderMarkdown(md, mdPath, {});
  assert.ok(typeof out.html === 'string' && out.html.includes('<html'),
    'html is a full document');
  assert.ok(out.bodyHtml.includes('<table'), 'bodyHtml contains the table');
  assert.ok(out.html.includes(out.bodyHtml.slice(0, 60)),
    'html embeds bodyHtml');

  // calling twice must work (no module-level single-shot state)
  const out2 = await renderMarkdown(md, mdPath, {});
  assert.strictEqual(out2.bodyHtml, out.bodyHtml, 'renders are deterministic');

  // Regression: marked.use() has no de-dup, so installing the subscript /
  // superscript / KaTeX extensions inside renderMarkdown() (instead of once
  // at require time) would unshift fresh copies into marked's shared global
  // extension registry on every call — unbounded growth in a long-lived
  // process (the editor server calls renderMarkdown() once per edit).
  const { marked } = require('marked');
  const mdWithExtensions = '# T\n\nSub ~x~, sup ^y^, math $z$.\n';
  await renderMarkdown(mdWithExtensions, mdPath, {});
  const countAfterFirst = (marked.defaults.extensions.inline || []).length;
  await renderMarkdown(mdWithExtensions, mdPath, {});
  const countAfterSecond = (marked.defaults.extensions.inline || []).length;
  await renderMarkdown(mdWithExtensions, mdPath, {});
  const countAfterThird = (marked.defaults.extensions.inline || []).length;
  assert.strictEqual(countAfterSecond, countAfterFirst,
    'marked inline extension registry must not grow between renders');
  assert.strictEqual(countAfterThird, countAfterSecond,
    'marked inline extension registry must not grow between renders');

  // v3.2.0: parts 與 blocks 1:1，且每個 part 都已烘焙
  {
    const md = '# H\n\npara\n\n- a\n- b\n\n```dot\ndigraph { a -> b; }\n```\n\ntail\n';
    const { bodyHtml, parts, blocks } = await renderMarkdown(md, path.join(dir, 'x.md'), { editMode: true });
    assert.strictEqual(Array.isArray(parts), true, 'renderMarkdown 必須回傳 parts');
    assert.strictEqual(parts.length, blocks.length,
      'parts.length === blocks.length，got ' + parts.length + ' vs ' + blocks.length);
    parts.forEach((p, i) => {
      const ids = p.match(/data-block-id="(\d+)"/g) || [];
      assert.strictEqual(ids.length, 1, 'part ' + i + ' 必須恰含一個 data-block-id，got ' + ids.length);
      assert.strictEqual(ids[0], 'data-block-id="' + blocks[i].id + '"',
        'part ' + i + ' 的 id 必須等於 blocks[' + i + '].id');
    });
    assert.strictEqual(parts.join('\n'), bodyHtml,
      'parts.join(\'\\n\') 必須逐位元組等於 bodyHtml（兩者都在烘焙之後）');
    assert.strictEqual(/data-graphviz-src=/.test(parts.join('')), false,
      '每個 part 都必須已烘焙——未烘焙的 part 插進 DOM 會是一個空的 <div class="graphviz">');
  }

  console.log('render-api.test.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
