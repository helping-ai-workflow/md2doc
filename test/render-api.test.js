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

  console.log('render-api.test.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
