#!/usr/bin/env node
/**
 * md2doc.js — Markdown → HTML / PDF
 *
 * Handles:
 *   - WaveDrom timing diagrams  (```wavedrom blocks)
 *   - Mermaid diagrams          (```mermaid blocks)
 *   - GFM tables, code blocks, blockquotes
 *
 * Dependencies:
 *   npm install marked           # markdown parser
 *   npm install puppeteer        # PDF only — downloads Chromium (~170MB)
 *
 * Usage:
 *   node md2doc.js <input.md> <output.html>
 *   node md2doc.js <input.md> <output.pdf>
 */

'use strict';

const fs            = require('fs');
const path          = require('path');
const { spawnSync } = require('child_process');

const [,, src, dst] = process.argv;
if (!src || !dst) {
  console.error('Usage: node md2doc.js <input.md> <output.html|pdf>');
  process.exit(1);
}

const ext = path.extname(dst).toLowerCase();
const md  = fs.readFileSync(src, 'utf8');

function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch (_) {
      // Ignore invalid candidates and continue probing fallbacks.
    }
  }
  return null;
}

function safeResolve(modulePath) {
  try {
    return require.resolve(modulePath);
  } catch (_) {
    return null;
  }
}

function inlineScriptTag(sourcePath) {
  if (!sourcePath) {
    return null;
  }
  return `<script type="text/javascript">\n${fs.readFileSync(sourcePath, 'utf8')}\n</script>`;
}

const localWaveDromSkin = firstExistingPath([
  process.env.WAVEDROM_SKIN_JS,
  safeResolve('wavedrom/skins/default.js'),
  '/home/user/.vscode-server/extensions/shd101wyy.markdown-preview-enhanced-0.8.22/crossnote/dependencies/wavedrom/skins/default.js',
]);

const localWaveDromJs = firstExistingPath([
  process.env.WAVEDROM_JS,
  safeResolve('wavedrom/wavedrom.min.js'),
  '/home/user/.vscode-server/extensions/shd101wyy.markdown-preview-enhanced-0.8.22/crossnote/dependencies/wavedrom/wavedrom.min.js',
]);

const localMermaidJs = firstExistingPath([
  process.env.MERMAID_JS,
  safeResolve('mermaid/dist/mermaid.min.js'),
  '/home/user/.vscode-server/extensions/shd101wyy.markdown-preview-enhanced-0.8.22/crossnote/dependencies/mermaid/mermaid.min.js',
]);

const waveDromSkinTag = inlineScriptTag(localWaveDromSkin)
  || '<script src="https://cdn.jsdelivr.net/npm/wavedrom/skins/default.js" type="text/javascript"></script>';

const waveDromTag = inlineScriptTag(localWaveDromJs)
  || '<script src="https://cdn.jsdelivr.net/npm/wavedrom/wavedrom.min.js" type="text/javascript"></script>';

const mermaidScriptTag = inlineScriptTag(localMermaidJs)
  || `<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
  mermaid.initialize({ startOnLoad: true, theme: 'default' });
</script>`;

const mermaidInitTag = localMermaidJs
  ? `<script type="text/javascript">
  if (typeof mermaid !== 'undefined') {
    mermaid.initialize({ startOnLoad: true, theme: 'default' });
  }
</script>`
  : '';

// ── Markdown → HTML body ─────────────────────────────────────────────────────
// Use a custom renderer to intercept fenced code blocks before marked escapes
// their content. This is the correct approach — pre-processing the raw markdown
// string causes marked to re-parse the injected HTML and mangle indented lines.

let bodyHtml;
let tocHtml = '';
let serializedSections = '[]';
try {
  const { marked, Renderer } = require('marked');

  const renderer = new Renderer();
  const tocItems = [];
  const slugCounts = new Map();
  const sections = [];
  let currentSection = null;

  function startSection({ id, depth, text }) {
    currentSection = {
      id,
      depth,
      title: text,
      searchTextParts: [text],
    };
    sections.push(currentSection);
  }

  function appendSectionText(value) {
    if (!currentSection || !value) {
      return;
    }
    const clean = stripHtmlTags(value).replace(/\s+/g, ' ').trim();
    if (clean) {
      currentSection.searchTextParts.push(clean);
    }
  }

  function collectCellText(cells) {
    if (!Array.isArray(cells)) {
      return;
    }
    for (const cell of cells) {
      if (cell && Array.isArray(cell.tokens)) {
        appendSectionText(flattenTokenText(cell.tokens));
      } else if (cell && typeof cell.text === 'string') {
        appendSectionText(cell.text);
      }
    }
  }

  function buildTocTree(items) {
    const root = [];
    const stack = [{ depth: 0, children: root }];

    for (const item of items) {
      const node = { ...item, children: [] };
      while (stack.length > 1 && item.depth <= stack[stack.length - 1].depth) {
        stack.pop();
      }
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    }

    return root;
  }

  function renderTocNodes(nodes, level = 1) {
    if (!nodes.length) {
      return '';
    }

    const itemsHtml = nodes
      .map((node) => {
        const linkHtml = `<a href="#${node.id}">${escapeHtml(node.text)}</a>`;
        const hasChildren = node.children && node.children.length > 0;

        if (!hasChildren) {
          return `<li class="toc-item toc-level-${level}">${linkHtml}</li>`;
        }

        return `<li class="toc-item toc-level-${level} toc-parent">
  <details>
    <summary>${linkHtml}</summary>
    ${renderTocNodes(node.children, level + 1)}
  </details>
</li>`;
      })
      .join('\n');

    return `<ul class="toc-list toc-list-level-${level}">
${itemsHtml}
</ul>`;
  }

  function flattenTokenText(tokens) {
    if (!Array.isArray(tokens)) {
      return '';
    }
    return tokens
      .map((item) => {
        if (item.type === 'link' || item.type === 'em' || item.type === 'strong' || item.type === 'del') {
          return flattenTokenText(item.tokens);
        }
        if (item.type === 'codespan') {
          return item.text || '';
        }
        if (item.tokens) {
          return flattenTokenText(item.tokens);
        }
        return item.text || '';
      })
      .join('');
  }

  function stripHtmlTags(value) {
    return String(value || '').replace(/<[^>]*>/g, '');
  }

  function slugifyHeading(value) {
    const base = stripHtmlTags(value)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-+|-+$/g, '')
      || 'section';
    const count = slugCounts.get(base) || 0;
    slugCounts.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  renderer.code = function(token) {
    // token is either a string (old API) or {text, lang} object (new API)
    const lang = (typeof token === 'object') ? (token.lang || '') : (arguments[1] || '');
    const code = (typeof token === 'object') ? token.text : token;

    if (lang === 'wavedrom') {
      return `\n<script type="WaveDrom">\n${code}\n</script>\n`;
    }
    if (lang === 'mermaid') {
      return `\n<div class="mermaid">\n${code}\n</div>\n`;
    }
    if (lang === 'dot' || lang === 'graphviz') {
      const r = spawnSync('dot', ['-Tsvg'], { input: code, encoding: 'utf8', timeout: 10000 });
      if (r.status === 0) {
        // Strip XML declaration / DOCTYPE; keep only the <svg> element.
        // Remove fixed width/height attrs so CSS max-width:100% + height:auto
        // can scale the diagram to content width; viewBox preserves aspect ratio.
        const svg = r.stdout
          .replace(/<\?xml[^>]*\?>/g, '')
          .replace(/<!DOCTYPE[^>]*>/g, '')
          .replace(/(<svg\b[^>]*?)\s+width="[^"]*"/i, '$1')
          .replace(/(<svg\b[^>]*?)\s+height="[^"]*"/i, '$1')
          .trim();
        return `\n<div class="graphviz">${svg}</div>\n`;
      }
      console.error('[WARN] dot render failed:', r.stderr);
      // Fall through to default code block
    }
    // Default: syntax-highlighted code block
    const escaped = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<pre><code class="language-${lang}">${escaped}</code></pre>\n`;
  };

  renderer.heading = function(token) {
    const depth = Number(token.depth || 1);
    const headingText = stripHtmlTags(flattenTokenText(token.tokens) || token.text || '');
    const headingId = slugifyHeading(headingText);
    const headingHtml = this.parser.parseInline(token.tokens);

    tocItems.push({
      depth,
      id: headingId,
      text: headingText,
    });
    startSection({ depth, id: headingId, text: headingText });

    return `<h${depth} id="${headingId}" class="heading-with-anchor" data-reader-heading data-reader-depth="${depth}">${headingHtml}<a class="heading-anchor" href="#${headingId}" aria-label="Link to this section">#</a></h${depth}>\n`;
  };

  const baseParagraph = renderer.paragraph.bind(renderer);
  renderer.paragraph = function(token) {
    appendSectionText(flattenTokenText(token.tokens));
    return baseParagraph(token);
  };

  const baseListitem = renderer.listitem.bind(renderer);
  renderer.listitem = function(token) {
    appendSectionText(flattenTokenText(token.tokens));
    return baseListitem(token);
  };

  const baseBlockquote = renderer.blockquote.bind(renderer);
  renderer.blockquote = function(token) {
    appendSectionText(flattenTokenText(token.tokens));
    return baseBlockquote(token);
  };

  const baseTable = renderer.table.bind(renderer);
  renderer.table = function(token) {
    collectCellText(token.header);
    if (Array.isArray(token.rows)) {
      for (const row of token.rows) {
        collectCellText(row);
      }
    }
    return baseTable(token);
  };

  marked.setOptions({ gfm: true, breaks: false, renderer });

  // Pre-process non-standard inline syntax before marked parses
  const mdPre = md
    .replace(/\^([^^]+)\^/g, '<sup>$1</sup>')   // ^a^  → <sup>a</sup>
    .replace(/~([^~]+)~/g,   '<sub>$1</sub>');   // ~a~  → <sub>a</sub>

  bodyHtml = marked.parse(mdPre);
  serializedSections = JSON.stringify(
    sections.map((section) => ({
      id: section.id,
      depth: section.depth,
      title: section.title,
      searchText: section.searchTextParts.join(' '),
    }))
  ).replace(/</g, '\\u003c');
  if (tocItems.length > 0) {
    const tocTree = buildTocTree(tocItems);
    tocHtml = `<aside class="reader-sidebar" data-reader-sidebar>
  <section class="reader-tools">
    <label class="reader-search-label" for="doc-search-input">Search this spec</label>
    <div class="reader-search-row">
      <input type="search" id="doc-search-input" placeholder="Enter keyword and press Enter">
      <button id="doc-search-submit" type="button">Search</button>
      <button id="doc-search-clear" type="button">Clear</button>
    </div>
  </section>
  <section class="search-results" id="search-results" hidden>
    <div class="search-results-header">
      <span class="search-results-title">Results</span>
      <span id="search-result-count" class="reader-status">0</span>
      <button id="search-prev" type="button" disabled aria-label="Previous match">◀</button>
      <button id="search-next" type="button" disabled aria-label="Next match">▶</button>
    </div>
    <div id="search-results-list"></div>
  </section>
  <nav class="toc" aria-label="Table of contents" data-reader-toc>
    <div class="toc-header">
      <span class="toc-title">Contents</span>
      <button id="toc-expand-all" type="button" aria-label="Expand all">⊞</button>
      <button id="toc-collapse-all" type="button" aria-label="Collapse all">⊟</button>
    </div>
    ${renderTocNodes(tocTree)}
  </nav>
</aside>`;
  }
} catch (e) {
  console.error('[ERROR] marked not found — install with: npm install marked');
  console.error(e.message);
  process.exit(1);
}

// ── HTML template ────────────────────────────────────────────────────────────
const title = path.basename(src, '.md');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    margin: 0;
    padding: 0;
    line-height: 1.65;
    color: #24292e;
    font-size: 15px;
    background: #ffffff;
  }
  html { scroll-behavior: auto; }
  html, body { overflow-x: clip; }
  .page-layout {
    display: flex;
    align-items: flex-start;
    gap: 32px;
    margin: 0;
    padding: 24px 24px 48px;
    max-width: 100%;
    box-sizing: border-box;
  }
  .reader-sidebar {
    position: sticky;
    top: 24px;
    width: 320px;
    height: calc(100vh - 48px);
    overflow: hidden;
    flex: 0 0 320px;
    padding-right: 8px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .reader-tools { flex: 0 0 auto; }
  .sidebar-toggle {
    display: none;
    position: fixed;
    top: 12px;
    left: 12px;
    z-index: 100;
    background: #ffffff;
    border: 1px solid #d0d7de;
    border-radius: 8px;
    padding: 6px 10px;
    font-size: 1.1em;
    line-height: 1;
    cursor: pointer;
    box-shadow: 0 2px 6px rgba(0,0,0,0.08);
  }
  .sidebar-scrim {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.35);
    z-index: 98;
  }
  body[data-sidebar-open] .sidebar-scrim { display: block; }
  .reader-tools,
  .search-results,
  .toc {
    border: 1px solid #d0d7de;
    border-radius: 10px;
    background: #f8fafc;
    padding: 12px 14px;
  }
  .reader-search-label {
    display: block;
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #57606a;
    margin-bottom: 6px;
  }
  .reader-search-row {
    display: flex;
    gap: 6px;
    margin-bottom: 8px;
  }
  .reader-search-row input[type="search"] {
    flex: 1 1 auto;
    min-width: 0;
    padding: 6px 8px;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    font: inherit;
  }
  .reader-search-row button {
    padding: 4px 10px;
    font: inherit;
    font-size: 0.85em;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    background: #ffffff;
    cursor: pointer;
  }
  .reader-search-row button:hover {
    background: #eef2f6;
  }
  .search-results-header,
  .toc-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
  }
  .search-results-title,
  .toc-title {
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #57606a;
    flex: 0 0 auto;
  }
  .reader-status {
    flex: 1 1 auto;
    font-size: 0.82em;
    color: #57606a;
  }
  .search-results-header button,
  .toc-header button {
    padding: 2px 8px;
    font: inherit;
    font-size: 0.9em;
    line-height: 1;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    background: #ffffff;
    color: #57606a;
    cursor: pointer;
  }
  .search-results-header button:hover,
  .toc-header button:hover {
    background: #eef2f6;
    color: #24292e;
  }
  .search-results-header button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .toc-header .toc-title,
  .search-results-header .search-results-title {
    margin-right: auto;
  }
  .search-results[hidden] {
    display: none;
  }
  .search-results:not([hidden]) {
    display: flex;
    flex-direction: column;
    flex: 0 0 auto;
    max-height: 50%;
    min-height: 0;
  }
  .search-results-header { flex: 0 0 auto; }
  #search-results-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  .search-result-item {
    width: 100%;
    text-align: left;
    border: 1px solid transparent;
    border-radius: 8px;
    background: #ffffff;
    padding: 8px 10px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font: inherit;
  }
  .search-result-item:hover {
    background: #eef2f6;
  }
  .search-result-item.is-active {
    background: #dbeafe;
    box-shadow: inset 0 0 0 1px #93c5fd;
  }
  .search-result-title {
    font-weight: 600;
    font-size: 0.92em;
    color: #24292e;
  }
  .search-result-snippet {
    font-size: 0.82em;
    color: #57606a;
    line-height: 1.35;
  }
  .search-empty {
    margin: 0;
    font-size: 0.85em;
    color: #6a737d;
  }
  mark.search-hit.is-selected {
    background: #fde68a;
    color: inherit;
    padding: 0 2px;
    border-radius: 3px;
  }
  .toc {
    display: flex;
    flex-direction: column;
    flex: 1 1 0;
    min-height: 0;
    overflow: hidden;
  }
  .toc-header { flex: 0 0 auto; }
  .toc > .toc-list {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  .toc ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .toc li {
    margin: 0;
    padding: 0;
  }
  .toc-list + .toc-list {
    margin-top: 2px;
  }
  .toc-item {
    margin: 1px 0;
  }
  .toc a {
    display: inline-block;
    max-width: 100%;
    color: #57606a;
    text-decoration: none;
    padding: 4px 0 4px 0;
    overflow-wrap: anywhere;
    word-break: break-word;
    box-sizing: border-box;
  }
  .toc summary {
    min-width: 0;
  }
  .toc li {
    min-width: 0;
  }
  .toc a:hover {
    color: #0969da;
  }
  .toc a.is-active {
    color: #0b57d0;
    font-weight: 700;
  }
  .toc a.is-match {
    color: #355070;
    background: #eaf2ff;
    border-radius: 4px;
    padding-left: 4px;
    padding-right: 4px;
  }
  .toc details {
    margin: 0;
  }
  .toc summary {
    list-style: none;
    cursor: pointer;
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 2px 0;
  }
  .toc summary::-webkit-details-marker {
    display: none;
  }
  .toc summary::before {
    content: '▸';
    color: #57606a;
    font-size: 0.78em;
    line-height: 1.8;
    flex: 0 0 auto;
    transform: translateY(1px);
  }
  .toc details[open] > summary::before {
    content: '▾';
  }
  .toc details > .toc-list {
    margin-left: 14px;
    padding-left: 10px;
    border-left: 1px solid #d8dee4;
  }
  .toc-item:not(.toc-parent) > a {
    padding-left: 18px;
  }
  .toc-list-level-1 > .toc-item > a,
  .toc-list-level-1 > .toc-item > details > summary > a {
    font-weight: 600;
  }
  .toc-list-level-2 > .toc-item > a,
  .toc-list-level-2 > .toc-item > details > summary > a {
    font-size: 0.95em;
  }
  .toc-list-level-3 > .toc-item > a,
  .toc-list-level-3 > .toc-item > details > summary > a,
  .toc-list-level-4 > .toc-item > a,
  .toc-list-level-4 > .toc-item > details > summary > a,
  .toc-list-level-5 > .toc-item > a,
  .toc-list-level-5 > .toc-item > details > summary > a,
  .toc-list-level-6 > .toc-item > a,
  .toc-list-level-6 > .toc-item > details > summary > a {
    font-size: 0.9em;
  }
  .content {
    min-width: 0;
    flex: 1 1 auto;
  }
  .content p,
  .content li,
  .content blockquote {
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .content > * { max-width: 100%; }
  .content iframe, .content video, .content canvas { max-width: 100%; height: auto; }
  .heading-with-anchor {
    position: relative;
  }
  .heading-anchor {
    margin-left: 0.45em;
    color: #57606a;
    text-decoration: none;
    opacity: 0;
    transition: opacity 0.15s ease, color 0.15s ease;
    font-weight: 500;
  }
  .heading-with-anchor:hover .heading-anchor,
  .heading-with-anchor:focus-within .heading-anchor {
    opacity: 1;
  }
  .heading-anchor:hover,
  .heading-anchor:focus {
    color: #0969da;
  }
  h1 { font-size: 2em;   border-bottom: 2px solid #e1e4e8; padding-bottom: 10px; margin-top: 1.5em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #e1e4e8; padding-bottom: 6px;  margin-top: 1.4em; }
  h3 { font-size: 1.2em; margin-top: 1.3em; }
  h4 { font-size: 1.05em; margin-top: 1.2em; }
  code {
    background: #f6f8fa;
    padding: 2px 5px;
    border-radius: 3px;
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    font-size: 0.875em;
  }
  pre {
    background: #f6f8fa;
    padding: 16px;
    border-radius: 6px;
    overflow-x: auto;
    line-height: 1.45;
  }
  pre code { background: none; padding: 0; font-size: 0.875em; }
  table {
    display: block;
    border-collapse: collapse;
    width: 100%;
    max-width: 100%;
    margin: 16px 0;
    font-size: 0.9em;
    overflow-x: auto;
  }
  th, td { border: 1px solid #dfe2e5; padding: 7px 14px; text-align: left; }
  th { background: #f6f8fa; font-weight: 600; }
  tr:nth-child(even) { background: #fafbfc; }
  blockquote {
    border-left: 4px solid #dfe2e5;
    padding: 0 16px;
    color: #6a737d;
    margin: 0 0 16px 0;
  }
  hr { border: none; border-top: 1px solid #e1e4e8; margin: 24px 0; }
  .mermaid { text-align: center; margin: 20px 0; }
  .graphviz { text-align: center; margin: 20px 0; }
  .content img {
    max-width: 100%;
    height: auto;
  }
  .content svg,
  .mermaid svg,
  .graphviz svg {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 0 auto;
  }
  @media (max-width: 1080px) {
    .sidebar-toggle { display: inline-flex; align-items: center; }
    .page-layout {
      display: block;
      max-width: 100%;
      padding-top: 60px;
    }
    .reader-sidebar {
      position: fixed;
      top: 0;
      left: 0;
      bottom: 0;
      width: 85%;
      max-width: 360px;
      height: 100vh;
      background: #ffffff;
      z-index: 99;
      transform: translateX(-100%);
      transition: transform 0.2s ease;
      margin: 0;
      padding: 16px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      gap: 12px;
      box-shadow: 2px 0 12px rgba(0,0,0,0.15);
      flex: initial;
    }
    body[data-sidebar-open] .reader-sidebar { transform: translateX(0); }
    .heading-anchor { opacity: 1; }
  }
  @media print {
    body { font-size: 11pt; }
    .page-layout {
      display: block;
      max-width: 100%;
      margin: 0;
      padding: 0 10px;
    }
    .reader-sidebar,
    .sidebar-toggle,
    .sidebar-scrim { display: none !important; }
    .content { max-width: 100%; }
    .heading-anchor { display: none; }
    pre  { font-size: 9pt; }
    a[href]:after { content: none; }
  }
</style>
</head>
<body>
<button class="sidebar-toggle" id="sidebar-toggle" type="button" aria-label="Toggle sidebar" aria-expanded="false">☰</button>
<div class="sidebar-scrim" id="sidebar-scrim"></div>
<div class="page-layout">
${tocHtml}
<main class="content">
${bodyHtml}
</main>
</div>

<!-- WaveDrom -->
${waveDromSkinTag}
${waveDromTag}
<script type="text/javascript">
  function renderWaveDrom() {
    if (typeof WaveDrom !== 'undefined') {
      WaveDrom.ProcessAll();
    }
  }
  window.addEventListener('DOMContentLoaded', renderWaveDrom);
  window.addEventListener('load', renderWaveDrom);
  setTimeout(renderWaveDrom, 250);
  setTimeout(renderWaveDrom, 1000);
</script>

<!-- Mermaid -->
${mermaidScriptTag}
${mermaidInitTag}

<!-- Reader runtime -->
<script id="reader-section-data" type="application/json">${serializedSections}</script>
<script type="text/javascript">
(function () {
  'use strict';
  const readerState = {
    activeSectionId: null,
    query: '',
    results: [],
    selectedResultIndex: -1,
    activeHighlight: null,
  };
  window.__readerState = readerState;

  const rawData = document.getElementById('reader-section-data');
  const sections = rawData ? JSON.parse(rawData.textContent || '[]') : [];
  const headingNodes = Array.from(document.querySelectorAll('[data-reader-heading]'));
  const tocLinks = new Map(
    Array.from(document.querySelectorAll('.toc a[href^="#"]')).map((link) => [link.getAttribute('href').slice(1), link])
  );

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeText(value) {
    return String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  }

  function expandTocAncestors(link) {
    let node = link && link.closest('details');
    while (node) {
      node.open = true;
      node = node.parentElement && node.parentElement.closest('details');
    }
  }

  function ensureTocLinkVisible(link) {
    if (!link) return;
    const scroller = document.querySelector('.toc > .toc-list');
    if (!scroller) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const linkRect = link.getBoundingClientRect();
    if (linkRect.top < scrollerRect.top) {
      scroller.scrollTop += linkRect.top - scrollerRect.top;
    } else if (linkRect.bottom > scrollerRect.bottom) {
      scroller.scrollTop += linkRect.bottom - scrollerRect.bottom;
    }
  }

  let observerFrozen = false;

  function syncActiveHeading(sectionId, options) {
    if (!sectionId || readerState.activeSectionId === sectionId) {
      return;
    }
    const freezeSidebar = options && options.freezeSidebar === true;
    const previous = tocLinks.get(readerState.activeSectionId);
    if (previous) {
      previous.classList.remove('is-active');
    }
    readerState.activeSectionId = sectionId;
    const next = tocLinks.get(sectionId);
    if (next) {
      next.classList.add('is-active');
      if (!freezeSidebar) {
        expandTocAncestors(next);
        ensureTocLinkVisible(next);
      }
    }
  }

  if (typeof IntersectionObserver !== 'undefined' && headingNodes.length) {
    const observer = new IntersectionObserver((entries) => {
      if (observerFrozen) {
        return;
      }
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) {
        syncActiveHeading(visible[0].target.id);
      }
    }, { rootMargin: '0px 0px -65% 0px', threshold: [0, 1] });
    headingNodes.forEach((node) => observer.observe(node));
  }

  const allTocDetails = () => Array.from(document.querySelectorAll('.toc details'));
  const expandAllBtn = document.getElementById('toc-expand-all');
  if (expandAllBtn) {
    expandAllBtn.addEventListener('click', () => {
      allTocDetails().forEach((node) => { node.open = true; });
    });
  }
  const collapseAllBtn = document.getElementById('toc-collapse-all');
  if (collapseAllBtn) {
    collapseAllBtn.addEventListener('click', () => {
      allTocDetails().forEach((node) => { node.open = false; });
      const activeLink = tocLinks.get(readerState.activeSectionId);
      expandTocAncestors(activeLink);
    });
  }

  const SKIP_SELECTOR = 'svg, .mermaid, .graphviz, script, style';

  function buildSnippet(section, query) {
    const haystack = section.searchText || section.title || '';
    const lower = haystack.toLowerCase();
    const index = lower.indexOf(query);
    if (index === -1) {
      return haystack.slice(0, 140);
    }
    const start = Math.max(0, index - 50);
    const end = Math.min(haystack.length, index + query.length + 70);
    let snippet = haystack.slice(start, end).trim();
    if (start > 0) snippet = '…' + snippet;
    if (end < haystack.length) snippet += '…';
    return snippet;
  }

  function clearMatchedTocState() {
    tocLinks.forEach((link) => link.classList.remove('is-match'));
  }

  function applyMatchedTocState() {
    const matched = new Set(readerState.results.map((result) => result.id));
    tocLinks.forEach((link, id) => {
      link.classList.toggle('is-match', matched.has(id));
    });
  }

  function clearSelectedHighlight() {
    const mark = readerState.activeHighlight;
    if (mark && mark.parentNode) {
      const text = document.createTextNode(mark.textContent || '');
      mark.parentNode.replaceChild(text, mark);
      text.parentNode.normalize();
    }
    readerState.activeHighlight = null;
  }

  function updateSearchStatus() {
    const status = document.getElementById('search-result-count');
    const prevBtn = document.getElementById('search-prev');
    const nextBtn = document.getElementById('search-next');
    if (status) {
      if (!readerState.query) {
        status.textContent = '';
      } else if (!readerState.results.length) {
        status.textContent = '0';
      } else {
        status.textContent = readerState.selectedResultIndex >= 0
          ? (readerState.selectedResultIndex + 1) + '/' + readerState.results.length
          : String(readerState.results.length);
      }
    }
    const hasResults = readerState.results.length > 0;
    if (prevBtn) prevBtn.disabled = !hasResults;
    if (nextBtn) nextBtn.disabled = !hasResults;
  }

  function renderSearchResults() {
    const panel = document.getElementById('search-results');
    const list = document.getElementById('search-results-list');
    if (!panel || !list) return;
    if (!readerState.query) {
      panel.hidden = true;
      list.innerHTML = '';
      return;
    }
    if (!readerState.results.length) {
      panel.hidden = false;
      list.innerHTML = '<p class="search-empty">No matching sections.</p>';
      return;
    }
    panel.hidden = false;
    list.innerHTML = readerState.results.map((result, index) => (
      '<button class="search-result-item' + (index === readerState.selectedResultIndex ? ' is-active' : '') + '" data-result-index="' + index + '" type="button">'
      + '<span class="search-result-title">' + escapeHtml(result.title) + '</span>'
      + '<span class="search-result-snippet">' + escapeHtml(result.snippet) + '</span>'
      + '</button>'
    )).join('');
  }

  function sectionBoundary(sectionId) {
    const start = document.getElementById(sectionId);
    if (!start) return null;
    const startDepth = Number(start.getAttribute('data-reader-depth') || '1');
    let end = null;
    let node = start.nextElementSibling;
    while (node) {
      if (node.matches && node.matches('[data-reader-heading]')) {
        const depth = Number(node.getAttribute('data-reader-depth') || '1');
        if (depth <= startDepth) {
          end = node;
          break;
        }
      }
      node = node.nextElementSibling;
    }
    return { start, end };
  }

  function highlightFirstOccurrence(sectionId, query) {
    const bounds = sectionBoundary(sectionId);
    if (!bounds) return null;
    const { start, end } = bounds;
    const container = start.parentNode;
    if (!container) return null;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (node.parentElement && node.parentElement.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        if (node.parentElement && node.parentElement.closest('.reader-sidebar')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let inRange = false;
    const queryLower = query.toLowerCase();
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!inRange) {
        if (start.contains(node)) {
          inRange = true;
        } else if (start.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) {
          inRange = true;
        } else {
          continue;
        }
      }
      if (node.parentElement && node.parentElement.closest('.heading-anchor')) continue;
      if (end) {
        const pos = end.compareDocumentPosition(node);
        if (end === node || end.contains(node) || (pos & Node.DOCUMENT_POSITION_FOLLOWING)) {
          break;
        }
      }
      const text = node.nodeValue;
      const idx = text.toLowerCase().indexOf(queryLower);
      if (idx === -1) continue;
      const before = text.slice(0, idx);
      const match = text.slice(idx, idx + query.length);
      const after = text.slice(idx + query.length);
      const mark = document.createElement('mark');
      mark.className = 'search-hit is-selected';
      mark.textContent = match;
      const parent = node.parentNode;
      if (!parent) return null;
      if (before) parent.insertBefore(document.createTextNode(before), node);
      parent.insertBefore(mark, node);
      if (after) {
        node.nodeValue = after;
      } else {
        parent.removeChild(node);
      }
      return mark;
    }
    return null;
  }

  function jumpToAndHighlight(result) {
    clearSelectedHighlight();
    const query = normalizeText(readerState.query);
    if (!query) return;
    const mark = highlightFirstOccurrence(result.id, query);
    if (mark) {
      readerState.activeHighlight = mark;
      mark.scrollIntoView({ behavior: 'instant', block: 'center' });
    } else {
      const heading = document.getElementById(result.id);
      if (heading) heading.scrollIntoView({ behavior: 'instant', block: 'start' });
    }
  }

  function detectActiveHeading() {
    const threshold = 120;
    let candidate = null;
    for (const node of headingNodes) {
      const rect = node.getBoundingClientRect();
      if (rect.top <= threshold) {
        candidate = node;
      } else {
        break;
      }
    }
    return candidate || headingNodes[0] || null;
  }

  function resyncTocToScroll() {
    const node = detectActiveHeading();
    if (!node) return;
    if (readerState.activeSectionId === node.id) {
      const link = tocLinks.get(node.id);
      if (link) {
        expandTocAncestors(link);
        ensureTocLinkVisible(link);
      }
      return;
    }
    syncActiveHeading(node.id);
  }

  function ensureActiveResultVisible() {
    const list = document.getElementById('search-results-list');
    if (!list) return;
    const active = list.querySelector('.search-result-item.is-active');
    if (active) {
      active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function selectResult(index) {
    if (!readerState.results.length) return;
    const size = readerState.results.length;
    const wrapped = ((index % size) + size) % size;
    const result = readerState.results[wrapped];
    if (!result) return;
    readerState.selectedResultIndex = wrapped;
    observerFrozen = true;
    renderSearchResults();
    ensureActiveResultVisible();
    syncActiveHeading(result.id, { freezeSidebar: true });
    jumpToAndHighlight(result);
    updateSearchStatus();
  }

  function clearSearchState() {
    const input = document.getElementById('doc-search-input');
    if (input) input.value = '';
    readerState.query = '';
    readerState.results = [];
    readerState.selectedResultIndex = -1;
    observerFrozen = false;
    clearSelectedHighlight();
    clearMatchedTocState();
    renderSearchResults();
    updateSearchStatus();
    resyncTocToScroll();
  }

  function performSearch() {
    const input = document.getElementById('doc-search-input');
    const rawQuery = input ? input.value.trim() : '';
    const query = normalizeText(rawQuery);
    readerState.query = rawQuery;
    clearSelectedHighlight();
    clearMatchedTocState();

    if (!query) {
      readerState.results = [];
      readerState.selectedResultIndex = -1;
      renderSearchResults();
      updateSearchStatus();
      return;
    }

    readerState.results = sections
      .filter((section) => normalizeText(section.searchText).includes(query))
      .map((section) => ({
        id: section.id,
        title: section.title,
        snippet: buildSnippet(section, query),
      }));
    readerState.selectedResultIndex = -1;
    renderSearchResults();
    updateSearchStatus();
    applyMatchedTocState();
    if (readerState.results.length) {
      selectResult(0);
    }
  }

  const searchInput = document.getElementById('doc-search-input');
  if (searchInput) {
    searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        performSearch();
      }
    });
  }
  const submitBtn = document.getElementById('doc-search-submit');
  if (submitBtn) submitBtn.addEventListener('click', performSearch);
  const clearBtn = document.getElementById('doc-search-clear');
  if (clearBtn) clearBtn.addEventListener('click', clearSearchState);
  const prevBtn = document.getElementById('search-prev');
  if (prevBtn) prevBtn.addEventListener('click', () => selectResult(readerState.selectedResultIndex - 1));
  const nextBtn = document.getElementById('search-next');
  if (nextBtn) nextBtn.addEventListener('click', () => selectResult(readerState.selectedResultIndex + 1));
  const resultsList = document.getElementById('search-results-list');
  if (resultsList) {
    resultsList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-result-index]');
      if (button) {
        selectResult(Number(button.getAttribute('data-result-index')));
      }
    });
  }

  const contentRoot = document.querySelector('main.content');
  if (contentRoot) {
    contentRoot.addEventListener('click', () => {
      observerFrozen = false;
      resyncTocToScroll();
    });
  }

  updateSearchStatus();

  const sidebarToggle = document.getElementById('sidebar-toggle');
  const sidebarScrim = document.getElementById('sidebar-scrim');
  function setSidebarOpen(open) {
    if (open) {
      document.body.setAttribute('data-sidebar-open', '');
    } else {
      document.body.removeAttribute('data-sidebar-open');
    }
    if (sidebarToggle) sidebarToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', () => {
      setSidebarOpen(!document.body.hasAttribute('data-sidebar-open'));
    });
  }
  if (sidebarScrim) {
    sidebarScrim.addEventListener('click', () => setSidebarOpen(false));
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.body.hasAttribute('data-sidebar-open')) {
      setSidebarOpen(false);
    }
  });
  document.addEventListener('click', (event) => {
    if (!document.body.hasAttribute('data-sidebar-open')) return;
    if (!event.target || !event.target.closest) return;
    if (event.target.closest('.toc a[href^="#"]') || event.target.closest('.search-result-item')) {
      setSidebarOpen(false);
    }
  });
})();
</script>
</body>
</html>`;

// ── Output ───────────────────────────────────────────────────────────────────
if (ext === '.html') {
  fs.writeFileSync(dst, html, 'utf8');
  console.log(`[HTML] ${src} → ${dst}`);

} else if (ext === '.pdf') {
  (async () => {
    let puppeteer;
    try {
      puppeteer = require('puppeteer');
    } catch (e) {
      console.error('[ERROR] puppeteer not found — install with: npm install puppeteer');
      process.exit(1);
    }

    // Write temporary HTML, launch headless Chromium, export PDF
    const tmp = dst.replace(/\.pdf$/, '._tmp.html');
    fs.writeFileSync(tmp, html, 'utf8');

    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-crash-reporter', '--disable-dev-shm-usage'],
    });
    const page    = await browser.newPage();

    await page.goto('file://' + path.resolve(tmp), { waitUntil: 'load' });

    // Allow WaveDrom / Mermaid scripts time to render diagrams
    await new Promise(r => setTimeout(r, 2500));

    await page.pdf({
      path:           dst,
      format:         'A4',
      printBackground: true,
      outline:         true,
      tagged:          true,
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' }
    });

    await browser.close();
    fs.unlinkSync(tmp);
    console.log(`[PDF]  ${src} → ${dst}`);
  })();

} else {
  console.error('[ERROR] Output extension must be .html or .pdf');
  process.exit(1);
}
