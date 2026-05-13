#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-test-'));
const mdPath = path.join(tmpDir, 'heading-links.md');
const htmlPath = path.join(tmpDir, 'heading-links.html');

fs.writeFileSync(
  mdPath,
  [
    '# Top',
    '',
    '## Heading [ref](#top) and `code`',
    '',
    '### Deep Section',
    '',
    '#### Deeper Section',
    '',
    'Paragraph.',
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

assert.match(html, /<nav class="toc"/, 'expected TOC markup');
assert.match(html, /<ul class="toc-list toc-list-level-1">/, 'expected nested TOC root list');
assert.match(
  html,
  /<details>\s*<summary><a href="#top">Top<\/a><\/summary>/,
  'expected level-1 TOC section to be collapsed by default'
);
assert.match(
  html,
  /<details>\s*<summary><a href="#heading-ref-and-code">Heading ref and code<\/a><\/summary>/,
  'expected nested TOC section to be collapsible'
);
assert.match(html, /<a href="#deeper-section">Deeper Section<\/a>/, 'expected deeper heading to appear in TOC');
assert.match(
  html,
  /<h2 id="heading-ref-and-code" class="heading-with-anchor[^"]*"[^>]*>Heading <a href="#top">ref<\/a> and <code>code<\/code><a class="heading-anchor" href="#heading-ref-and-code" aria-label="Link to this section">#<\/a><\/h2>/,
  'expected inline heading markdown to render as HTML'
);

// Task 1 — reader shell assertions
assert.match(html, /<section class="reader-tools"/, 'expected reader tools container');
assert.match(html, /<input[^>]+type="search"[^>]+id="doc-search-input"/, 'expected search input');
assert.match(html, /<button[^>]+id="doc-search-submit"/, 'expected search submit button');
assert.match(html, /<button[^>]+id="doc-search-clear"/, 'expected search clear button');
assert.match(html, /<button[^>]+id="toc-expand-all"/, 'expected expand-all button');
assert.match(html, /<button[^>]+id="toc-collapse-all"/, 'expected collapse-all button');
assert.match(html, /<section class="search-results" id="search-results"/, 'expected search results container');
assert.match(html, /<nav class="toc"[^>]*data-reader-toc/, 'expected TOC reader hook');

// Task 1 — serialized section data + bootstrap hooks
assert.match(html, /<script id="reader-section-data" type="application\/json">/, 'expected serialized section data');
assert.match(html, /const readerState = \{/, 'expected reader state bootstrap');
assert.match(html, /function performSearch\(/, 'expected search function bootstrap');
assert.match(html, /function syncActiveHeading\(/, 'expected scroll sync function bootstrap');

// Task 3 — TOC state CSS + handlers
assert.match(html, /\.toc a\.is-active \{/, 'expected active TOC CSS');
assert.match(html, /\.toc a\.is-match \{/, 'expected matched TOC CSS');
assert.match(html, /toc-expand-all/, 'expected TOC expand-all handler');
assert.match(html, /toc-collapse-all/, 'expected TOC collapse-all handler');

// Task 4 — search runtime
assert.match(html, /function renderSearchResults\(/, 'expected result renderer');
assert.match(html, /function selectResult\(/, 'expected result selector');
assert.match(html, /mark\.search-hit\.is-selected/, 'expected selected-hit CSS');

// Task 1 (layout) — B1: narrow overflow-wrap to prose only
assert.match(
  html,
  /\.content p,\s*\.content li,\s*\.content blockquote \{\s*overflow-wrap: anywhere;\s*word-break: break-word;\s*\}/,
  'expected prose-only overflow-wrap rule'
);
assert.doesNotMatch(
  html,
  /\.content \{[^}]*overflow-wrap: anywhere/,
  '.content should no longer carry overflow-wrap: anywhere'
);
assert.doesNotMatch(
  html,
  /\.content \{[^}]*word-break: break-word/,
  '.content should no longer carry word-break: break-word'
);

// Task 2 (layout) — B2: atomic token nowrap inside table cells
assert.match(
  html,
  /\.content table th,\s*\.content table td \{\s*overflow-wrap: normal;\s*word-break: normal;\s*\}/,
  'expected td/th wrap reset'
);
assert.match(
  html,
  /\.content table th \{\s*white-space: nowrap;\s*\}/,
  'expected th nowrap'
);
assert.match(
  html,
  /\.content table td code,\s*\.content table th code \{\s*white-space: nowrap;\s*\}/,
  'expected td/th code nowrap'
);

// Task 3 (layout) — B3 fixture: classify and emit colgroup + cell classes
const tableMdPath  = path.join(tmpDir, 'tables.md');
const tableHtmlPath = path.join(tmpDir, 'tables.html');
fs.writeFileSync(
  tableMdPath,
  [
    '# Tables',
    '',
    '| Signal | Dir | Width | Clock Domain | Description |',
    '|---|---|---|---|---|',
    '| `pmac_tx_tvalidchk` | In | 1 | `clk_tx` | TVALIDCHK：`pmac_tx_tvalid` parity，由上游 pMAC TX Core 產生，本模組驗證。 |',
    '| `pmac_tx_tready`    | Out | 1 | `clk_tx` | backpressure |',
    '',
  ].join('\n'),
  'utf8'
);

const runTables = spawnSync('node', ['lib/md2doc.js', tableMdPath, tableHtmlPath], {
  cwd: path.resolve(__dirname, '..'),
  encoding: 'utf8',
});
if (runTables.status !== 0) {
  process.stderr.write(runTables.stdout || '');
  process.stderr.write(runTables.stderr || '');
  process.exit(runTables.status || 1);
}
const tablesHtml = fs.readFileSync(tableHtmlPath, 'utf8');

assert.match(tablesHtml, /<colgroup>/, 'expected colgroup emitted');
// Signal column: all-`<code>`, short tokens, no whitespace → narrow
assert.match(tablesHtml, /<col class="col-narrow">[\s\S]*?<col class="col-narrow">[\s\S]*?<col class="col-narrow">[\s\S]*?<col class="col-narrow">[\s\S]*?<col class="col-prose">/,
  'expected 4 narrow cols + 1 prose col in this fixture');
assert.match(tablesHtml, /<th class="cell-narrow">Signal<\/th>/, 'expected Signal header tagged narrow');
assert.match(tablesHtml, /<th class="cell-prose">Description<\/th>/, 'expected Description header tagged prose');
assert.match(tablesHtml, /<td class="cell-narrow"><code>pmac_tx_tvalidchk<\/code><\/td>/,
  'expected Signal data cell tagged narrow with intact code span');
assert.match(tablesHtml, /<td class="cell-prose">TVALIDCHK/, 'expected Description data cell tagged prose');

// Task 3 (layout) — B3 CSS support
assert.match(
  tablesHtml,
  /\.content table col\.col-narrow \{\s*width: 1%;\s*\}/,
  'expected col-narrow width:1% rule'
);
assert.match(
  tablesHtml,
  /\.content table col\.col-prose \{\s*width: auto;\s*\}/,
  'expected col-prose width:auto rule'
);
assert.match(
  tablesHtml,
  /\.content table th\.cell-narrow,\s*\.content table td\.cell-narrow \{\s*white-space: nowrap;\s*\}/,
  'expected cell-narrow nowrap rule'
);

// Task 4 (layout) — B4: sticky first column
assert.match(
  tablesHtml,
  /\.content table tbody td:first-child,\s*\.content table thead th:first-child \{\s*position: sticky;\s*left: 0;\s*z-index: 1;\s*background: #ffffff;\s*\}/,
  'expected sticky first-column rule'
);
assert.match(
  tablesHtml,
  /\.content table thead th:first-child \{\s*background: #f6f8fa;\s*\}/,
  'expected sticky header first-column background override'
);
assert.match(
  tablesHtml,
  /\.content table tbody tr:nth-child\(even\) td:first-child \{\s*background: #fafbfc;\s*\}/,
  'expected sticky zebra-stripe override'
);

// Task 5 (layout) — A1: TOC adaptive width
assert.match(
  html,
  /\.reader-sidebar \{[^}]*flex: 0 1 300px;[^}]*\}/,
  'expected sidebar flex 0 1 300px'
);
assert.match(
  html,
  /\.reader-sidebar \{[^}]*width: clamp\(220px, 22vw, 300px\);[^}]*\}/,
  'expected sidebar width clamp'
);
assert.match(
  html,
  /\.reader-sidebar \{[^}]*min-width: 220px;[^}]*\}/,
  'expected sidebar min-width'
);

// Task 6 (layout) — A2: TOC collapse toggle + persistence
assert.match(html, /<button[^>]+id="toc-collapse-toggle"[^>]*>/, 'expected collapse toggle button');
assert.match(html, /aria-label="Collapse table of contents"/, 'expected accessible label');
assert.match(
  html,
  /body\[data-toc-collapsed\] \.reader-sidebar \{[^}]*flex-basis: 36px;[^}]*width: 36px;[^}]*\}/,
  'expected collapsed sidebar CSS'
);
assert.match(
  html,
  /body\[data-toc-collapsed\] \.reader-tools,\s*body\[data-toc-collapsed\] \.search-results,\s*body\[data-toc-collapsed\] \.toc \> \.toc-list,\s*body\[data-toc-collapsed\] \.toc-title \{\s*display: none;\s*\}/,
  'expected collapsed inner-element hide rules'
);
assert.match(html, /localStorage\.getItem\('md2doc\.toc\.collapsed'\)/, 'expected localStorage read');
assert.match(html, /localStorage\.setItem\('md2doc\.toc\.collapsed'/, 'expected localStorage write');
assert.match(html, /toggleAttribute\('data-toc-collapsed'\)/, 'expected toggle handler');

console.log('md2doc heading rendering test passed');
