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
  /\.content p,\s*\.content li,\s*\.content blockquote,\s*\.content h1,\s*\.content h2,\s*\.content h3,\s*\.content h4,\s*\.content h5,\s*\.content h6,\s*\.content dt,\s*\.content dd \{\s*overflow-wrap: anywhere;\s*word-break: break-word;\s*\}/,
  'expected prose-only overflow-wrap rule (incl. headings + dl)'
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
assert.match(
  html,
  /\.content \{\s*min-width: 0;\s*flex: 1 1 auto;\s*\}/,
  '.content base flex rule (min-width: 0; flex: 1 1 auto) still present'
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
assert.match(
  tablesHtml,
  /<colgroup><col class="col-narrow"><col class="col-narrow"><col class="col-narrow"><col class="col-narrow"><col class="col-prose"><\/colgroup>/,
  'expected exact 4 narrow + 1 prose colgroup'
);
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

// --- Mermaid block: escaped source + CDN v11 ---
{
    const mermaidMd = path.join(tmpDir, 'mermaid.md');
    const mermaidHtml = path.join(tmpDir, 'mermaid.html');
    fs.writeFileSync(mermaidMd, [
        '# Diagram',
        '',
        '```mermaid',
        'flowchart TD',
        '    A["make IP=&lt;IP&gt; run"] --> B["x<br/>y"]',
        '```',
        '',
    ].join('\n'), 'utf8');

    const mrun = spawnSync('node', ['lib/md2doc.js', mermaidMd, mermaidHtml], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
    });
    assert.strictEqual(mrun.status, 0, 'mermaid fixture renders');
    const mhtml = fs.readFileSync(mermaidHtml, 'utf8');

    // Source must be HTML-escaped inside the .mermaid div so the browser hands
    // mermaid the literal source text (GitHub-equivalent semantics): the
    // author's `&lt;IP&gt;` must arrive escaped once more, and a raw `<br/>`
    // must arrive as text, not be parsed into an element the HTML parser eats.
    assert.match(mhtml, /<div class="mermaid">[\s\S]*?&amp;lt;IP&amp;gt;[\s\S]*?<\/div>/,
        'entity-written labels survive HTML parsing');
    assert.match(mhtml, /<div class="mermaid">[\s\S]*?&lt;br\/&gt;[\s\S]*?<\/div>/,
        'raw <br/> in mermaid source is escaped, not element-ified');

    // mermaid is now a bundled dep: the local inline-embed path always fires.
    // No CDN reference, and the local-only init guard must be present.
    assert.doesNotMatch(mhtml, /cdn\.jsdelivr\.net/, 'mermaid bundled — no CDN fallback');
    assert.match(mhtml, /if \(typeof mermaid !== 'undefined'\)/, 'local mermaid init guard present (bundled path taken)');
}

console.log('md2doc mermaid escaping test passed');

// ── text-only doc must NOT embed the mermaid/wavedrom runtimes ──
const plainMd = path.join(tmpDir, 'plain.md');
const plainHtml = path.join(tmpDir, 'plain.html');
fs.writeFileSync(plainMd, ['# Plain', '', 'Just text, no diagrams.', ''].join('\n'), 'utf8');
const prun = spawnSync('node', ['lib/md2doc.js', plainMd, plainHtml], {
  cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
});
assert.strictEqual(prun.status, 0, 'plain fixture renders');
const phtml = fs.readFileSync(plainHtml, 'utf8');
assert.doesNotMatch(phtml, /if \(typeof mermaid !== 'undefined'\)/, 'no mermaid runtime embedded in a diagram-free doc');
assert.doesNotMatch(phtml, /WaveDrom\.ProcessAll|WaveSkin/, 'no wavedrom runtime embedded in a diagram-free doc');
console.log('md2doc conditional-injection test passed');

// ── dot/graphviz renders in-process via WASM (no system 'dot' binary) ──
const dotMd = path.join(tmpDir, 'dot.md');
const dotHtml = path.join(tmpDir, 'dot.html');
fs.writeFileSync(dotMd, ['# Dot', '', '```dot', 'digraph { a -> b; }', '```', ''].join('\n'), 'utf8');

const drun = spawnSync(process.execPath, ['lib/md2doc.js', dotMd, dotHtml], {
  cwd: path.resolve(__dirname, '..'),
  encoding: 'utf8',
  // Strip any system 'dot' from PATH to prove we do NOT shell out to it.
  // Use process.execPath (absolute node binary path) so the spawn itself
  // succeeds even with PATH scrubbed to /nonexistent.
  env: { ...process.env, PATH: '/nonexistent' },
});
assert.strictEqual(drun.status, 0, 'dot fixture renders with no system dot on PATH');
const dhtml = fs.readFileSync(dotHtml, 'utf8');
assert.match(dhtml, /<div class="graphviz"><svg/, 'dot block rendered to inline SVG via WASM');
assert.doesNotMatch(dhtml, /data-graphviz-src=/, 'placeholder fully replaced by SVG');
assert.doesNotMatch(dhtml, /dot render failed/, 'no spawnSync ENOENT warning');
console.log('md2doc dot WASM test passed');

// ── --bake-svg produces inert SVG with no diagram-engine runtime ──
// Capability-gated: needs a usable Chromium. Logs a visible skip if absent —
// this gates on environment capability, it does not silence a correctness failure.
(function bakeSvgTest() {
  let chromiumOk = true;
  try { require('puppeteer').executablePath(); }
  catch (_) { chromiumOk = false; }
  if (!chromiumOk) { console.log('[SKIP] bake-svg test: Chromium unavailable in this environment'); return; }

  const bMd = path.join(tmpDir, 'bake.md');
  const bHtml = path.join(tmpDir, 'bake.html');
  fs.writeFileSync(bMd, ['# Bake', '', '```mermaid', 'graph TD; A-->B;', '```', ''].join('\n'), 'utf8');
  const br = spawnSync('node', ['lib/md2doc.js', bMd, bHtml, '--bake-svg'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
  });
  assert.strictEqual(br.status, 0, 'bake-svg render succeeds');
  const bh = fs.readFileSync(bHtml, 'utf8');
  assert.match(bh, /<svg/, 'baked output contains inline SVG');
  assert.doesNotMatch(bh, /data-md2doc-diagram-engine/, 'diagram-engine runtime scripts stripped from baked output');
  assert.doesNotMatch(bh, /<div class="mermaid">\s*graph TD/, 'unrendered mermaid placeholder replaced');
  console.log('md2doc bake-svg test passed');
})();

// ── Collapsing the TOC leaves a usable restore control (regression) ──
// Bug: clicking #toc-collapse-toggle shrank the sidebar to a 36px rail but the
// header's expand-all/collapse-all buttons pushed the restore toggle past the
// rail's right edge, where overflow:hidden clipped it — collapse with no way back.
// Capability-gated on Chromium (like the bake test); logs a visible [SKIP] if absent.
(async function tocCollapseRestoreTest() {
  let puppeteer;
  try { puppeteer = require('puppeteer'); puppeteer.executablePath(); }
  catch (_) { console.log('[SKIP] toc-collapse restore test: Chromium unavailable'); return; }

  const tocMd = path.join(tmpDir, 'toc-collapse.md');
  const tocHtmlOut = path.join(tmpDir, 'toc-collapse.html');
  fs.writeFileSync(tocMd, ['# One', '', '## Two', '', '### Three', '', 'Body text.', ''].join('\n'), 'utf8');
  const tr = spawnSync('node', ['lib/md2doc.js', tocMd, tocHtmlOut], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  assert.strictEqual(tr.status, 0, 'toc fixture renders');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    // Desktop width: the rail-collapse path (#toc-collapse-toggle), not the
    // mobile hamburger (which is the ≤1080px path).
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto('file://' + path.resolve(tocHtmlOut), { waitUntil: 'load' });

    await page.click('#toc-collapse-toggle');
    const collapsed = await page.evaluate(() => document.body.hasAttribute('data-toc-collapsed'));
    assert.strictEqual(collapsed, true, 'sidebar collapses on toggle click');

    // The restore toggle must stay fully inside the collapsed rail (not clipped
    // away by overflow:hidden), or the user can never click it back.
    const fits = await page.evaluate(() => {
      const tog = document.getElementById('toc-collapse-toggle');
      const bar = document.querySelector('.reader-sidebar');
      if (!tog || !bar) return false;
      const t = tog.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      const s = getComputedStyle(tog);
      const visible = s.display !== 'none' && s.visibility !== 'hidden' && t.width > 0 && t.height > 0;
      return visible && t.right <= b.right + 1 && t.left >= b.left - 1;
    });
    assert.strictEqual(fits, true, 'restore toggle stays within the collapsed rail (clickable, not clipped)');

    await page.click('#toc-collapse-toggle');
    const restored = await page.evaluate(() => !document.body.hasAttribute('data-toc-collapsed'));
    assert.strictEqual(restored, true, 'clicking the toggle restores the sidebar');
    console.log('md2doc toc-collapse restore test passed');
  } finally {
    await browser.close();
  }
})().catch((err) => { console.error((err && err.stack) || err); process.exit(1); });
