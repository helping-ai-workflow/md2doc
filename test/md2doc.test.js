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

console.log('md2doc heading rendering test passed');
