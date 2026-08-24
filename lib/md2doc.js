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

const [,, src, dst] = process.argv;
const BAKE_SVG = process.argv.slice(4).includes('--bake-svg');

// How long to let client-side WaveDrom / Mermaid scripts render before we
// snapshot the DOM (PDF print, or --bake-svg inert-SVG bake).
const DIAGRAM_RENDER_WAIT_MS = 2500;
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

function inlineScriptTag(sourcePath, engine) {
  if (!sourcePath) {
    return null;
  }
  const marker = engine ? ` data-md2doc-diagram-engine="${engine}"` : '';
  return `<script type="text/javascript"${marker}>\n${fs.readFileSync(sourcePath, 'utf8')}\n</script>`;
}

// wavedrom is pinned to 3.5.0 in package.json: 3.6.1+ adds an `exports` map
// that no longer exposes the `wavedrom/wavedrom.min.js` / `wavedrom/skins/default.js`
// subpaths resolved below, so a bump past 3.5.x must switch to an exports-blessed
// entry (or a vendored copy) or these safeResolve() calls return null and the
// hard guard further down exits 1.
const localWaveDromSkin = firstExistingPath([
  process.env.WAVEDROM_SKIN_JS,
  safeResolve('wavedrom/skins/default.js'),
]);

const localWaveDromJs = firstExistingPath([
  process.env.WAVEDROM_JS,
  safeResolve('wavedrom/wavedrom.min.js'),
]);

const localMermaidJs = firstExistingPath([
  process.env.MERMAID_JS,
  safeResolve('mermaid/dist/mermaid.min.js'),
]);

if (!localMermaidJs || !localWaveDromJs || !localWaveDromSkin) {
  console.error('[ERROR] bundled diagram runtime missing — reinstall dependencies with `npm install`');
  process.exit(1);
}

const waveDromSkinTag = inlineScriptTag(localWaveDromSkin, 'wavedrom');
const waveDromTag     = inlineScriptTag(localWaveDromJs, 'wavedrom');
const mermaidScriptTag = inlineScriptTag(localMermaidJs, 'mermaid');

const mermaidInitTag = `<script type="text/javascript" data-md2doc-diagram-engine="mermaid">
  if (typeof mermaid !== 'undefined') {
    mermaid.initialize({ startOnLoad: true, theme: 'default' });
  }
</script>`;

// ── Markdown → HTML body ─────────────────────────────────────────────────────
// Use a custom renderer to intercept fenced code blocks before marked escapes
// their content. This is the correct approach — pre-processing the raw markdown
// string causes marked to re-parse the injected HTML and mangle indented lines.

let usesMermaid = false;
let usesWaveDrom = false;
let usesMath = false;

// Self-contained KaTeX stylesheet: inline katex.min.css with each woff2 @font-face
// rewritten to a base64 data: URI and the woff/ttf alternates stripped, so a
// math-bearing HTML prints offline (and in puppeteer PDF) with no font fetch.
// Built lazily — only when a document actually contains math.
function buildKatexStyleTag() {
  const cssPath = require.resolve('katex/dist/katex.min.css');
  const fontDir = path.join(path.dirname(cssPath), 'fonts');
  let css = fs.readFileSync(cssPath, 'utf8');
  css = css.replace(/url\(fonts\/(KaTeX_[\w-]+)\.woff2\)/g, (_, name) => {
    const b64 = fs.readFileSync(path.join(fontDir, `${name}.woff2`)).toString('base64');
    return `url(data:font/woff2;base64,${b64})`;
  });
  // Drop the now-redundant woff/ttf src alternates (woff2 is universal in modern
  // browsers + puppeteer Chromium), so nothing references the on-disk font files.
  css = css.replace(/,url\(fonts\/[\w-]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, '');
  return `<style data-md2doc-math>${css}</style>`;
}

// ── Local image assets ───────────────────────────────────────────────────────
// Image srcs in the markdown are relative to the SOURCE markdown, but the HTML
// is normally written somewhere else entirely (the OS temp dir by default), so
// a relative src resolves against the wrong directory and the image silently
// never loads. Resolve every local reference against the markdown's own
// directory and inline it as a data: URI — the same self-contained principle
// the embedded CSS / KaTeX fonts already follow, and the only form that also
// survives the puppeteer PDF path (which renders from its own temp HTML).
const SRC_DIR = path.dirname(path.resolve(src));
const LARGE_ASSET_WARN_BYTES = 4 * 1024 * 1024;

// Doubles as the allowlist: a reference whose extension is not an image is left
// alone. Without that gate, `![x](../../../.ssh/id_rsa)` would happily base64
// the file into a document meant to be shared.
const IMAGE_MIME_BY_EXT = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp':  'image/bmp',
  '.ico':  'image/x-icon',
  '.apng': 'image/apng',
  '.tif':  'image/tiff',
  '.tiff': 'image/tiff',
};

const inlinedAssetCache = new Map();
const skippedAssetWarned = new Set();

// Only a scheme we actually know is treated as remote — a bare `letter+colon`
// test would misread both a Windows drive (`C:/img.png`) and a filename that
// merely contains a colon. `//host/x.png` is protocol-relative.
const EXTERNAL_REF_RE = /^(?:(?:https?|data|file|blob|ftps?|mailto|tel|about|chrome|chrome-extension|moz-extension):|\/\/)/i;

function isExternalRef(href) {
  return EXTERNAL_REF_RE.test(String(href).trim());
}

function warnOnce(href, message) {
  if (skippedAssetWarned.has(href)) return;
  skippedAssetWarned.add(href);
  console.error(message);
}

// Splits `assets/pic.svg?v=2#gear` into its path and its fragment. The query is
// dropped (it is cache-busting for a fetch that no longer happens); the
// fragment is kept and re-attached to the data URI, since it selects a view /
// symbol inside an SVG rather than addressing the file.
function splitAssetRef(href) {
  const raw = String(href).trim();
  const hash = raw.indexOf('#');
  const withoutHash = hash === -1 ? raw : raw.slice(0, hash);
  const fragment = hash === -1 ? '' : raw.slice(hash);
  return { filePart: withoutHash.replace(/\?.*$/, ''), fragment };
}

function resolveAssetPath(filePart) {
  if (!filePart) return null;
  let decoded = filePart;
  try {
    decoded = decodeURIComponent(filePart);
  } catch (_) {
    // Malformed percent-escapes: probe the raw form only.
  }
  const candidates = [];
  for (const c of [decoded, filePart]) {
    candidates.push(path.isAbsolute(c) ? c : path.resolve(SRC_DIR, c));
  }
  return firstExistingPath(candidates);
}

// Returns a data: URI, or null when the reference must be left untouched
// (remote URL, already a data: URI, non-image extension, or no such file).
function inlineImageSrc(href) {
  if (!href || isExternalRef(href)) return null;
  const { filePart, fragment } = splitAssetRef(href);
  if (!filePart) return null;

  const mime = IMAGE_MIME_BY_EXT[path.extname(filePart).toLowerCase()];
  if (!mime) {
    warnOnce(href, `[WARN] not a known image extension, left as-is: ${href}`);
    return null;
  }

  const abs = resolveAssetPath(filePart);
  if (!abs) {
    warnOnce(href, `[WARN] image not found, left as-is: ${href} (resolved against ${SRC_DIR})`);
    return null;
  }

  let uri = inlinedAssetCache.get(abs);
  if (uri === undefined) {
    uri = null;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) throw new Error('not a regular file');
      if (stat.size > LARGE_ASSET_WARN_BYTES) {
        console.error(`[WARN] inlining large image (${(stat.size / 1048576).toFixed(1)} MB): ${href}`);
      }
      uri = `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
    } catch (e) {
      console.error(`[WARN] could not inline image ${href}: ${e.message}`);
      uri = null;
    }
    inlinedAssetCache.set(abs, uri);
  }
  return uri ? uri + fragment : null;
}

// A srcset value is a comma-separated list of `<url> <descriptor>` candidates.
function inlineSrcsetValue(value) {
  const parts = String(value).split(',');
  let changed = false;
  const rebuilt = parts.map((part) => {
    const m = part.match(/^(\s*)(\S+)(\s*.*)$/);
    if (!m) return part;
    const uri = inlineImageSrc(m[2]);
    if (!uri) return part;
    changed = true;
    return m[1] + uri + m[3];
  });
  return changed ? rebuilt.join(',') : null;
}

// Author-written <img> / <source> tags (specs use them for width= and for
// <picture>) need the same rewrite. Scoped to markdown-authored HTML chunks
// only — never run over the whole page, whose bundled mermaid / katex JS also
// contains '<img' literals.
// The tag matcher is attribute-aware: a quoted value may legally contain '>',
// and a plain [^>]* would truncate the tag and miss a src that sits after it.
const ASSET_TAG_RE = /<(?:img|source)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const SRC_ATTR_RE   = /(\s(?:src|srcset)\s*=\s*)(?:(["'])([^"']*)\2|([^\s"'=<>`]+))/gi;

function inlineImagesInTag(tag) {
  return tag.replace(SRC_ATTR_RE, (match, lead, quote, quoted, bare) => {
    const raw = (quoted !== undefined ? quoted : bare) || '';
    const decoded = raw.replace(/&amp;/g, '&');
    const isSrcset = /srcset\s*=\s*$/i.test(lead);
    const value = isSrcset ? inlineSrcsetValue(decoded) : inlineImageSrc(decoded);
    return value ? `${lead}"${value}"` : match;
  });
}

function inlineImagesInHtmlChunk(chunk) {
  if (!chunk || !/<(?:img|source)\b/i.test(chunk)) return chunk;
  // Step over comments untouched — a commented-out <img> is not displayed, so
  // inlining it would only bloat the output (or smuggle a file into it).
  let out = '';
  let last = 0;
  HTML_COMMENT_RE.lastIndex = 0;
  let m;
  while ((m = HTML_COMMENT_RE.exec(chunk)) !== null) {
    out += chunk.slice(last, m.index).replace(ASSET_TAG_RE, inlineImagesInTag) + m[0];
    last = m.index + m[0].length;
  }
  return out + chunk.slice(last).replace(ASSET_TAG_RE, inlineImagesInTag);
}

let bodyHtml;
let tocHtml = '';
let serializedSections = '[]';
try {
  const { marked, Renderer } = require('marked');
  const katex = require('katex');

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
        const linkHtml = `<a href="#${node.id}" title="${escapeHtml(node.text)}">${escapeHtml(node.text)}</a>`;
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

  function unbreakableRun(s) {
    // Treat `_` as a break point — identifiers like `pmac_tx_*` are unbreakable in CSS but breakable for classification.
    const matches = String(s || '').match(/[A-Za-z0-9\-./@:]+/g);
    if (!matches) return 0;
    let max = 0;
    for (const m of matches) if (m.length > max) max = m.length;
    return max;
  }

  function cellRawText(cell) {
    if (!cell) return '';
    if (Array.isArray(cell.tokens)) return flattenTokenText(cell.tokens);
    return String(cell.text || '');
  }

  function classifyColumns(token) {
    const colCount = (token.header || []).length;
    const classes = [];
    for (let i = 0; i < colCount; i++) {
      const allCells = [];
      if (token.header && token.header[i]) allCells.push(token.header[i]);
      const dataCells = [];
      if (Array.isArray(token.rows)) {
        for (const row of token.rows) {
          if (row && row[i]) {
            allCells.push(row[i]);
            dataCells.push(row[i]);
          }
        }
      }
      const allTexts = allCells.map(cellRawText);
      const dataTexts = dataCells.map(cellRawText);
      // Header labels (e.g. "Clock Domain") often contain whitespace not representative of cell content; use data rows for the heuristic and fall back to header only when the column has no data.
      const heuristicTexts = dataTexts.length > 0 ? dataTexts : allTexts;
      let maxTokenLen = 0;
      let totalLen = 0;
      let hasWhitespace = false;
      let hasSentence = false;
      for (const t of heuristicTexts) {
        const r = unbreakableRun(t);
        if (r > maxTokenLen) maxTokenLen = r;
        totalLen += t.length;
        if (/\s/.test(t)) hasWhitespace = true;
        if (/。|\. /.test(t)) hasSentence = true;
      }
      const avgCellLen = heuristicTexts.length ? (totalLen / heuristicTexts.length) : 0;

      // Narrow takes precedence over prose (tie-break: prefer narrow / conservative).
      if (maxTokenLen <= 12 && !hasWhitespace) {
        classes.push('col-narrow');
      } else if (avgCellLen > 40 || hasSentence) {
        classes.push('col-prose');
      } else {
        classes.push('col-default');
      }
    }
    return classes;
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

  // marked's tokenizer already escapes alt / title (its default image renderer
  // interpolates both raw), so this must NOT escape them again. Only the src is
  // ours; everything else — including cleanUrl() on a src we leave alone — stays
  // marked's job, so non-inlined images render exactly as before.
  const baseImage = renderer.image.bind(renderer);
  renderer.image = function(token) {
    const isObj = (token !== null && typeof token === 'object');
    const href  = isObj ? (token.href  || '') : (token || '');
    const title = isObj ? (token.title || '') : (arguments[1] || '');
    const text  = isObj ? (token.text  || '') : (arguments[2] || '');
    const uri = inlineImageSrc(href);
    if (!uri) return baseImage.apply(this, arguments);
    // A data: URI is base64 (or an already-encoded payload): no quote, no '<'.
    let out = `<img src="${uri}" alt="${text}"`;
    if (title) out += ` title="${title}"`;
    return out + '>';
  };

  const baseHtml = renderer.html.bind(renderer);
  renderer.html = function(token) {
    return inlineImagesInHtmlChunk(baseHtml.apply(this, arguments));
  };

  renderer.code = function(token) {
    // token is either a string (old API) or {text, lang} object (new API)
    const lang = (typeof token === 'object') ? (token.lang || '') : (arguments[1] || '');
    const code = (typeof token === 'object') ? token.text : token;

    if (lang === 'wavedrom') {
      usesWaveDrom = true;
      return `\n<script type="WaveDrom">\n${code}\n</script>\n`;
    }
    if (lang === 'mermaid') {
      usesMermaid = true;
      // Escape so the browser delivers the literal source to mermaid. Raw
      // injection lets the HTML parser consume entities and tags first —
      // an author's &lt;IP&gt; became an <IP> element mermaid sanitized
      // away — diverging from GitHub's escaped-code-block semantics.
      return `\n<div class="mermaid">\n${escapeHtml(code)}\n</div>\n`;
    }
    if (lang === 'math') {
      // KaTeX renders synchronously to static HTML (class="katex"); no client
      // runtime, no async post-pass. throwOnError:false degrades a bad formula
      // to red error text instead of crashing the whole render.
      try {
        return `\n${katex.renderToString(code, { displayMode: true, throwOnError: false })}\n`;
      } catch (e) {
        const esc = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        return `<pre><code class="language-math">${esc}</code></pre>\n`;
      }
    }
    if (lang === 'dot' || lang === 'graphviz') {
      // Defer rendering to the async bakeGraphviz() post-pass so the
      // synchronous marked() pass stays sync. The dot source is carried as
      // base64 in a data attribute — safe for arbitrary dot syntax (quotes,
      // angle brackets, newlines) inside an HTML attribute.
      const b64 = Buffer.from(code, 'utf8').toString('base64');
      return `\n<div class="graphviz" data-graphviz-src="${b64}"></div>\n`;
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

  renderer.table = function(token) {
    collectCellText(token.header);
    if (Array.isArray(token.rows)) {
      for (const row of token.rows) {
        collectCellText(row);
      }
    }

    const classes = classifyColumns(token);
    const colHtml = classes
      .map((c) => (c === 'col-default' ? '<col>' : `<col class="${c}">`))
      .join('');
    const cellClassAttr = (i) => {
      const c = classes[i];
      if (c === 'col-narrow') return ' class="cell-narrow"';
      if (c === 'col-prose')  return ' class="cell-prose"';
      return '';
    };
    const alignStyle = (cell) => (cell && cell.align)
      ? ` style="text-align:${cell.align}"`
      : '';

    const headerCells = (token.header || []).map((cell, i) => {
      const inner = cell && Array.isArray(cell.tokens)
        ? this.parser.parseInline(cell.tokens)
        : '';
      return `<th${cellClassAttr(i)}${alignStyle(cell)}>${inner}</th>`;
    }).join('');
    const headerHtml = `<thead><tr>${headerCells}</tr></thead>`;

    const bodyRows = Array.isArray(token.rows) ? token.rows.map((row) => {
      const cells = (row || []).map((cell, i) => {
        const inner = cell && Array.isArray(cell.tokens)
          ? this.parser.parseInline(cell.tokens)
          : '';
        return `<td${cellClassAttr(i)}${alignStyle(cell)}>${inner}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('') : '';
    const bodyHtmlPart = `<tbody>${bodyRows}</tbody>`;

    return `<table>\n<colgroup>${colHtml}</colgroup>\n${headerHtml}\n${bodyHtmlPart}\n</table>\n`;
  };

  marked.setOptions({ gfm: true, breaks: false, renderer });

  // Code-aware subscript / superscript as marked inline extensions.
  // The old raw-text pre-pass (mdPre.replace(/~([^~]+)~/...)) ran BEFORE marked
  // tokenised, so it rewrote ~NOT / ^XOR operators inside fenced, indented and
  // inline code into <sub>/<sup> (96 such mangles in one RTL spec). As inline
  // extensions marked tokenises code first, so these never fire inside code.
  // The tokenizer also requires a single whitespace-free token (~x~ / ^x^), so
  // spaced operator expressions (~a & ~b, a ^ b) and lone operators (2^24, ~rst)
  // stay literal even in prose — only a genuine subscript/superscript converts.
  marked.use({
    extensions: [
      {
        name: 'subscript',
        level: 'inline',
        start(src) { const i = src.indexOf('~'); return i < 0 ? undefined : i; },
        tokenizer(src) {
          const m = /^~(?=\S)([^~\s\n]+)~/.exec(src);
          if (m) {
            return { type: 'subscript', raw: m[0], text: m[1],
                     tokens: this.lexer.inlineTokens(m[1]) };
          }
        },
        renderer(token) { return `<sub>${this.parser.parseInline(token.tokens)}</sub>`; },
      },
      {
        name: 'superscript',
        level: 'inline',
        start(src) { const i = src.indexOf('^'); return i < 0 ? undefined : i; },
        tokenizer(src) {
          const m = /^\^(?=\S)([^^\s\n]+)\^/.exec(src);
          if (m) {
            return { type: 'superscript', raw: m[0], text: m[1],
                     tokens: this.lexer.inlineTokens(m[1]) };
          }
        },
        renderer(token) { return `<sup>${this.parser.parseInline(token.tokens)}</sup>`; },
      },
    ],
  });

  // $$…$$ (display) and $…$ (inline) math via KaTeX. marked tokenizes code
  // spans/fences first, so $ inside code stays literal; the extension's
  // default no-space-adjacency rules keep prose currency ($5 to $10) unrendered.
  const markedKatex = require('marked-katex-extension');
  marked.use(markedKatex({ throwOnError: false }));

  // Pre-process the remaining non-standard inline syntax before marked parses
  const escAttr = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const mdPre = md
    .replace(/\[\[([^\]\n]+)\]\]/g, (_, inner) => {  // [[ref-id, §sub]] → clickable citation
      const body = inner.trim();
      const slug = body.split(',', 1)[0].trim();
      return `<a href="#${escAttr(slug)}">[${escAttr(body)}]</a>`;
    });

  bodyHtml = marked.parse(mdPre);
  // Both the ```math fence and the $/$$ extension emit class="katex" — a single
  // post-parse scan is the source of truth for conditional CSS injection.
  usesMath = /class="katex/.test(bodyHtml);
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
    <label class="reader-search-label" for="doc-search-input">Search</label>
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
      <div class="toc-header-actions">
        <button id="toc-expand-all" type="button" aria-label="Expand all">⊞</button>
        <button id="toc-collapse-all" type="button" aria-label="Collapse all">⊟</button>
        <button id="toc-collapse-toggle" type="button" aria-label="Collapse table of contents" title="Collapse / expand sidebar">◀</button>
      </div>
      <div class="toc-breadcrumb" data-toc-breadcrumb aria-label="Current location"></div>
    </div>
    ${renderTocNodes(tocTree)}
  </nav>
</aside>
<div class="sidebar-splitter" id="sidebar-splitter" role="separator" aria-orientation="vertical" aria-label="Resize sidebar"></div>`;
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
    /* Sidebar/content spacing is carried by .sidebar-splitter (32px), not gap,
       so the drag handle can live inside the visual gutter. */
    gap: 0;
    margin: 0;
    padding: 24px 24px 48px;
    max-width: 100%;
    box-sizing: border-box;
  }
  .reader-sidebar {
    position: sticky;
    top: 24px;
    flex: 0 0 auto;
    width: var(--md2doc-sidebar-w, clamp(220px, 22vw, 300px));
    min-width: 0;
    height: calc(100vh - 48px);
    overflow: hidden;
    padding-right: 8px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  body[data-toc-collapsed] .reader-sidebar {
    flex-basis: 36px;
    width: 36px;
    min-width: 36px;
    padding-right: 0;
  }
  body[data-toc-collapsed] .reader-tools,
  body[data-toc-collapsed] .search-results,
  body[data-toc-collapsed] .toc > .toc-list,
  body[data-toc-collapsed] .toc-breadcrumb {
    display: none;
  }
  body[data-toc-collapsed] #toc-collapse-toggle {
    transform: rotate(180deg);
  }
  /* In the 36px collapsed rail only the restore toggle remains: hide the
     TOC-list buttons (no list to act on) and shrink padding so the toggle
     fits inside the rail instead of being clipped by overflow:hidden. */
  body[data-toc-collapsed] #toc-expand-all,
  body[data-toc-collapsed] #toc-collapse-all {
    display: none;
  }
  body[data-toc-collapsed] .toc {
    padding: 12px 3px;
  }
  body[data-toc-collapsed] .toc-header {
    margin-bottom: 0;
    justify-content: center;
  }
  body[data-toc-collapsed] .toc-header-actions {
    justify-content: center;
  }
  .sidebar-splitter {
    flex: 0 0 32px;
    align-self: stretch;
    cursor: col-resize;
    display: flex;
    justify-content: center;
    touch-action: none;
    user-select: none;
  }
  .sidebar-splitter::before {
    content: '';
    width: 3px;
    border-radius: 2px;
    background: transparent;
    transition: background 0.15s ease;
  }
  .sidebar-splitter:hover::before,
  .sidebar-splitter.is-dragging::before {
    background: #93c5fd;
  }
  body[data-toc-collapsed] .sidebar-splitter {
    cursor: default;
  }
  body[data-toc-collapsed] .sidebar-splitter::before {
    display: none;
  }
  #toc-collapse-toggle {
    margin-left: 0;
    padding: 2px 8px;
    font: inherit;
    font-size: 0.9em;
    line-height: 1;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    background: #ffffff;
    color: #57606a;
    cursor: pointer;
    transition: transform 0.15s ease;
  }
  #toc-collapse-toggle:hover {
    background: #eef2f6;
    color: #24292e;
  }
  @media (max-width: 1080px) {
    #toc-collapse-toggle { display: none; }
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
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
    margin-bottom: 8px;
  }
  .toc-header-actions {
    flex: 0 0 auto;
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }
  /* Sticky breadcrumb: stacked ancestor chain of the current scroll position.
     Each row is single-line + ellipsis; full text on hover via title=. */
  .toc-breadcrumb {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .toc-breadcrumb a {
    display: block;
    max-width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: #57606a;
    text-decoration: none;
    font-size: 0.82em;
    line-height: 1.55;
    box-sizing: border-box;
  }
  .toc-breadcrumb a:hover {
    color: #0969da;
  }
  .toc-breadcrumb a.breadcrumb-current {
    color: #0b57d0;
    font-weight: 700;
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
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .search-result-snippet mark {
    background: #fde68a;
    color: inherit;
    padding: 0 1px;
    border-radius: 2px;
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
    /* Horizontal peek: thin native scrollbar (drag/track-click/touchpad) plus
       the shift+wheel handler; appears only when a title actually overflows. */
    overflow-x: auto;
    scrollbar-width: thin;
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
    margin: 0;
  }
  .toc a {
    display: block;
    /* Full natural width (no ellipsis) so shift+wheel can peek clipped tails;
       min-width keeps hover/match backgrounds covering the whole row. */
    width: max-content;
    min-width: 100%;
    color: #57606a;
    text-decoration: none;
    padding: 2px 0;
    line-height: 1.4;
    white-space: nowrap;
    box-sizing: border-box;
  }
  .toc summary > a {
    flex: 0 0 auto;
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
    padding: 0;
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
  .content blockquote,
  .content h1,
  .content h2,
  .content h3,
  .content h4,
  .content h5,
  .content h6,
  .content dt,
  .content dd {
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
  .content table th,
  .content table td {
    overflow-wrap: normal;
    word-break: normal;
  }
  .content table th {
    white-space: nowrap;
  }
  .content table td code,
  .content table th code {
    white-space: nowrap;
  }
  .content table { table-layout: auto; }
  .content table col.col-narrow { width: 1%; }
  .content table col.col-prose { width: auto; }
  .content table th.cell-narrow,
  .content table td.cell-narrow { white-space: nowrap; }
  .content table tbody td:first-child,
  .content table thead th:first-child {
    position: sticky;
    left: 0;
    z-index: 1;
    background: #ffffff;
  }
  .content table thead th:first-child {
    background: #f6f8fa;
  }
  .content table tbody tr:nth-child(even) td:first-child {
    background: #fafbfc;
  }
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
  /* Anything the reader can pop out. The click handler uses the same
     selectors, so this cursor and that behaviour cannot drift apart. */
  .content img,
  .content .mermaid,
  .content .graphviz,
  .content [id^="WaveDrom_Display_"] { cursor: zoom-in; }
  .content a img { cursor: pointer; }

  .lightbox {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    flex-direction: column;
    background: rgba(16, 18, 21, 0.92);
  }
  .lightbox[hidden] { display: none; }
  .lightbox-bar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    padding: 8px 12px;
    background: rgba(0, 0, 0, 0.35);
    color: #e6edf3;
    font-size: 13px;
  }
  .lightbox-bar button {
    min-width: 32px;
    height: 28px;
    padding: 0 10px;
    border: 1px solid rgba(255, 255, 255, 0.25);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.08);
    color: inherit;
    font: inherit;
    line-height: 1;
    cursor: pointer;
  }
  .lightbox-bar button:hover { background: rgba(255, 255, 255, 0.18); }
  .lightbox-bar button.is-active {
    background: rgba(147, 197, 253, 0.35);
    box-shadow: inset 0 0 0 1px #93c5fd;
  }
  .lightbox-sep {
    width: 1px;
    align-self: stretch;
    margin: 4px 2px;
    background: rgba(255, 255, 255, 0.25);
  }
  /* Annotation overlay: absolute twin of the artwork, same viewBox, so shapes
     live in image coordinates and ride every zoom for free. Must undo the
     .lightbox-canvas > * block/white-background defaults. */
  .lightbox-canvas > .lightbox-anno {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    background: transparent;
    pointer-events: none;
  }
  .lightbox-stage[data-anno-cursor="draw"],
  .lightbox-stage[data-anno-cursor="draw"] .lightbox-anno { cursor: crosshair; }
  .lightbox-anno g[data-anno-id] { cursor: move; }
  .lightbox-anno [data-anno-handle] { cursor: nwse-resize; }
  .lightbox-zoom-value {
    min-width: 56px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .lightbox-hint {
    margin-right: auto;
    opacity: 0.7;
    font-size: 12px;
  }
  /* position: relative makes the stage the canvas's offsetParent, which the
     cursor-anchored zoom maths depends on. */
  .lightbox-stage {
    position: relative;
    flex: 1 1 auto;
    overflow: auto;
    cursor: grab;
    overscroll-behavior: contain;
  }
  .lightbox-stage[data-panning] { cursor: grabbing; }
  .lightbox-canvas { margin: 0 auto; position: relative; }
  /* Sized in px by the runtime; the child follows, so the scroll extent grows
     with the zoom. A CSS transform would scale the pixels and leave the scroll
     area at the original size, stranding the edges out of reach. */
  .lightbox-canvas > * {
    display: block;
    width: 100%;
    height: auto;
    max-width: none;
    max-height: none;
    margin: 0;
    background: #ffffff;
  }
  body[data-lightbox-open] { overflow: hidden; }
  @media print { .lightbox { display: none !important; } }
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
    .sidebar-splitter { display: none; }
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
    .sidebar-splitter,
    .sidebar-scrim { display: none !important; }
    .content { max-width: 100%; }
    .heading-anchor { display: none; }
    pre  { font-size: 9pt; }
    a[href]:after { content: none; }
  }
</style>
${usesMath ? buildKatexStyleTag() : ''}
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
${usesWaveDrom ? `${waveDromSkinTag}
${waveDromTag}
<script type="text/javascript" data-md2doc-diagram-engine="wavedrom">
  function renderWaveDrom() {
    if (typeof WaveDrom !== 'undefined') {
      WaveDrom.ProcessAll();
    }
  }
  window.addEventListener('DOMContentLoaded', renderWaveDrom);
  window.addEventListener('load', renderWaveDrom);
  setTimeout(renderWaveDrom, 250);
  setTimeout(renderWaveDrom, 1000);
</script>` : ''}

<!-- Mermaid -->
${usesMermaid ? `${mermaidScriptTag}
${mermaidInitTag}` : ''}

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

  const breadcrumbEl = document.querySelector('[data-toc-breadcrumb]');
  const sectionIndexById = new Map(sections.map((section, i) => [section.id, i]));

  // Sticky breadcrumb: the ancestor chain (shallow→deep) of the active section.
  // For each decreasing depth, take the nearest preceding section, then append
  // the active section itself. Rendered as stacked, indented, clickable rows.
  function renderBreadcrumb(sectionId) {
    if (!breadcrumbEl) return;
    if (!sectionIndexById.has(sectionId)) {
      breadcrumbEl.innerHTML = '';
      return;
    }
    const idx = sectionIndexById.get(sectionId);
    const chain = [];
    let need = sections[idx].depth;
    for (let i = idx; i >= 0 && need >= 1; i--) {
      if (sections[i].depth <= need) {
        chain.unshift(sections[i]);
        need = sections[i].depth - 1;
      }
    }
    if (!chain.length) {
      breadcrumbEl.innerHTML = '';
      return;
    }
    const minDepth = chain[0].depth;
    breadcrumbEl.innerHTML = chain
      .map((section, i) => {
        const indent = (section.depth - minDepth) * 10;
        const cls = i === chain.length - 1 ? ' class="breadcrumb-current"' : '';
        const title = escapeHtml(section.title);
        return '<a href="#' + section.id + '"' + cls + ' title="' + title +
          '" style="padding-left:' + indent + 'px">' + title + '</a>';
      })
      .join('');
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
    renderBreadcrumb(sectionId);
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

  // Paint the breadcrumb immediately so the header is populated before the
  // first IntersectionObserver callback fires.
  if (sections[0]) {
    renderBreadcrumb(sections[0].id);
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

  function readTocCollapsed() {
    try { return localStorage.getItem('md2doc.toc.collapsed') === '1'; }
    catch (_) { return false; }
  }
  function writeTocCollapsed(v) {
    try { localStorage.setItem('md2doc.toc.collapsed', v ? '1' : '0'); }
    catch (_) { /* private mode / quota — ignore */ }
  }
  if (readTocCollapsed()) {
    document.body.setAttribute('data-toc-collapsed', '');
  }
  const tocCollapseBtn = document.getElementById('toc-collapse-toggle');
  if (tocCollapseBtn) {
    tocCollapseBtn.addEventListener('click', () => {
      const nowCollapsed = document.body.toggleAttribute('data-toc-collapsed');
      writeTocCollapsed(nowCollapsed);
    });
  }

  const SKIP_SELECTOR = 'svg, .mermaid, .graphviz, script, style';

  function buildSnippet(section, query) {
    const haystack = section.searchText || section.title || '';
    const lower = haystack.toLowerCase();
    const index = lower.indexOf(query);
    if (index === -1) {
      return { text: haystack.slice(0, 80), matchStart: -1, matchLength: 0 };
    }
    const start = Math.max(0, index - 25);
    const end = Math.min(haystack.length, index + query.length + 45);
    let text = haystack.slice(start, end);
    let matchStart = index - start;
    if (start > 0) { text = '…' + text; matchStart += 1; }
    if (end < haystack.length) text += '…';
    return { text, matchStart, matchLength: query.length };
  }

  function renderSnippetHtml(snippet) {
    if (!snippet) return '';
    if (snippet.matchStart < 0) return escapeHtml(snippet.text);
    const before = snippet.text.slice(0, snippet.matchStart);
    const hit = snippet.text.slice(snippet.matchStart, snippet.matchStart + snippet.matchLength);
    const after = snippet.text.slice(snippet.matchStart + snippet.matchLength);
    return escapeHtml(before) + '<mark>' + escapeHtml(hit) + '</mark>' + escapeHtml(after);
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
      + '<span class="search-result-snippet">' + renderSnippetHtml(result.snippet) + '</span>'
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
    if (lightboxIsOpen()) return;
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

  // ── Sidebar splitter: drag to resize, persisted; double-click resets ─────
  const sidebarEl = document.querySelector('.reader-sidebar');
  const splitterEl = document.getElementById('sidebar-splitter');
  const SIDEBAR_WIDTH_KEY = 'md2doc.sidebar.width';
  function clampSidebarWidth(px) {
    return Math.min(Math.max(px, 180), Math.round(window.innerWidth * 0.5));
  }
  function applySidebarWidth(px) {
    document.documentElement.style.setProperty('--md2doc-sidebar-w', px + 'px');
  }
  try {
    const storedWidth = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY), 10);
    if (Number.isFinite(storedWidth)) applySidebarWidth(clampSidebarWidth(storedWidth));
  } catch (e) { /* storage unavailable */ }
  if (splitterEl && sidebarEl) {
    let dragging = false;
    let dragMoved = false;
    let dragStartX = 0;
    let dragStartWidth = 0;
    splitterEl.addEventListener('pointerdown', (event) => {
      if (document.body.hasAttribute('data-toc-collapsed')) return;
      dragging = true;
      dragMoved = false;
      dragStartX = event.clientX;
      dragStartWidth = sidebarEl.offsetWidth;
      splitterEl.classList.add('is-dragging');
      if (splitterEl.setPointerCapture) splitterEl.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    splitterEl.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const delta = event.clientX - dragStartX;
      if (Math.abs(delta) >= 3) dragMoved = true;
      if (dragMoved) applySidebarWidth(clampSidebarWidth(dragStartWidth + delta));
    });
    function endSidebarDrag() {
      if (!dragging) return;
      dragging = false;
      splitterEl.classList.remove('is-dragging');
      if (!dragMoved) return;
      try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarEl.offsetWidth)); }
      catch (e) { /* storage unavailable */ }
    }
    splitterEl.addEventListener('pointerup', endSidebarDrag);
    splitterEl.addEventListener('pointercancel', endSidebarDrag);
    splitterEl.addEventListener('dblclick', () => {
      document.documentElement.style.removeProperty('--md2doc-sidebar-w');
      try { localStorage.removeItem(SIDEBAR_WIDTH_KEY); }
      catch (e) { /* storage unavailable */ }
    });
  }

  // ── TOC horizontal peek: shift+wheel scrolls a hidden-overflow x-axis ─────
  const tocScrollEl = document.querySelector('.toc > .toc-list');
  if (tocScrollEl) {
    tocScrollEl.addEventListener('wheel', (event) => {
      if (!event.shiftKey) return;
      const delta = event.deltaX !== 0 ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      tocScrollEl.scrollLeft += delta;
    }, { passive: false });
  }

  // ── Zoom / resize scroll anchoring ────────────────────────────────────────
  // Browser zoom (and any window resize) reflows the column but leaves the
  // pixel scroll offset untouched, so the passage being read slides out of
  // view. Remember what sat at the top of the reading column and put it back.
  var ANCHOR_LINE = 80;
  var contentEl = document.querySelector('main.content');
  var anchorNode = null;
  var anchorTop = 0;
  var anchorFrame = 0;
  var suppressAnchorCapture = false;
  var lastLayoutWidth = document.documentElement.clientWidth;
  var lastPixelRatio = window.devicePixelRatio;

  function captureScrollAnchor() {
    if (suppressAnchorCapture || !contentEl) return;
    var rect = contentEl.getBoundingClientRect();
    var hit = document.elementFromPoint(rect.left + rect.width / 2, ANCHOR_LINE);
    var node = (hit && hit.closest) ? hit.closest('main.content > *') : null;
    if (!node) {
      // Between blocks, or over a gap: fall back to the last heading above the
      // anchor line. Heading offsets are monotonic in document order, so this
      // is a binary search rather than a scan of every heading each frame.
      var lo = 0;
      var hi = headingNodes.length - 1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (headingNodes[mid].getBoundingClientRect().top <= ANCHOR_LINE) {
          node = headingNodes[mid];
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
    }
    if (!node) return;
    anchorNode = node;
    anchorTop = node.getBoundingClientRect().top;
  }

  function restoreScrollAnchor() {
    if (!anchorNode || !anchorNode.isConnected) return;
    var delta = anchorNode.getBoundingClientRect().top - anchorTop;
    if (!delta) return;
    window.scrollTo(window.scrollX, window.scrollY + delta);
  }

  window.addEventListener('scroll', function () {
    if (anchorFrame) return;
    anchorFrame = window.requestAnimationFrame(function () {
      anchorFrame = 0;
      captureScrollAnchor();
    });
  }, { passive: true });

  window.addEventListener('resize', function () {
    var width = document.documentElement.clientWidth;
    var ratio = window.devicePixelRatio;
    // A height-only change (a mobile browser hiding its toolbar, a devtools
    // dock) reflows nothing, so correcting the scroll would only jerk the page.
    if (width === lastLayoutWidth && ratio === lastPixelRatio) return;
    lastLayoutWidth = width;
    lastPixelRatio = ratio;
    // Hold the anchor across the whole reflow: the scrollTo below fires scroll
    // events that would otherwise re-capture a mid-reflow position.
    suppressAnchorCapture = true;
    restoreScrollAnchor();
    window.requestAnimationFrame(function () {
      restoreScrollAnchor();
      window.requestAnimationFrame(function () {
        suppressAnchorCapture = false;
        captureScrollAnchor();
      });
    });
  });

  captureScrollAnchor();

  // ── Diagram / image lightbox ──────────────────────────────────────────────
  // Specs are read at 100% but their block diagrams and waveforms are drawn far
  // wider than the column, so the inline copy is unreadably small. Clicking one
  // pops it into a modal stage that zooms and scrolls.
  var LIGHTBOX_TARGETS = 'img, .mermaid, .graphviz, [id^="WaveDrom_Display_"]';
  var LIGHTBOX_MIN_ZOOM = 0.05;
  var LIGHTBOX_MAX_ZOOM = 8;
  var LIGHTBOX_STEP = 1.25;
  var lightboxEl = null;
  var lightboxStage = null;
  var lightboxCanvas = null;
  var lightboxZoomValue = null;
  var lightboxZoom = 1;
  var lightboxFitZoom = 1;
  var lightboxNaturalW = 1;
  var lightboxNaturalH = 1;
  var lightboxReturnScroll = 0;

  // Annotation layer state. Shapes are keyed per source node in memory only:
  // close/reopen keeps them, reload starts clean (they are reading-session
  // scratch, and localStorage keys would go stale when the doc regenerates).
  var ANNO_NS = 'http://www.w3.org/2000/svg';
  var annoStore = (typeof WeakMap === 'function') ? new WeakMap() : null;
  var annoShapes = [];
  var annoSvg = null;
  var annoMode = null;        // null | 'f' | 'e' | 'r' | 'm'
  var annoSelected = null;
  var annoDraft = null;
  var annoUndoStack = [];
  var annoRedoStack = [];
  var annoStrokeW = 3;
  var annoToolButtons = {};

  function lightboxIsOpen() {
    return !!lightboxEl && !lightboxEl.hidden;
  }

  function lightboxButton(label, title, onClick) {
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('click', onClick);
    return button;
  }

  function computeLightboxFit(isVector) {
    var pad = 24;
    var byWidth = (lightboxStage.clientWidth - pad) / lightboxNaturalW;
    var byHeight = (lightboxStage.clientHeight - pad) / lightboxNaturalH;
    var fit = Math.min(byWidth, byHeight);
    if (!isFinite(fit) || fit <= 0) return 1;
    // Vector art fills the window — a waveform authored at 480px wide is the
    // whole reason for popping it out. A raster image stops at actual size,
    // where enlarging past 100% only buys blur.
    return isVector ? fit : Math.min(fit, 1);
  }

  function setLightboxZoom(next, anchorX, anchorY) {
    if (!lightboxCanvas) return;
    var clamped = Math.min(LIGHTBOX_MAX_ZOOM, Math.max(LIGHTBOX_MIN_ZOOM, next));
    var stage = lightboxStage;
    var ax = (typeof anchorX === 'number') ? anchorX : stage.clientWidth / 2;
    var ay = (typeof anchorY === 'number') ? anchorY : stage.clientHeight / 2;
    // Keep whatever sits under the anchor point pinned across the zoom.
    var contentX = stage.scrollLeft + ax - lightboxCanvas.offsetLeft;
    var contentY = stage.scrollTop + ay - lightboxCanvas.offsetTop;
    var ratio = clamped / lightboxZoom;
    lightboxZoom = clamped;
    // Width in px, not a transform: the scroll extent has to grow with the
    // zoom, or the enlarged edges can never be scrolled into view.
    lightboxCanvas.style.width = Math.max(1, Math.round(lightboxNaturalW * clamped)) + 'px';
    if (lightboxZoomValue) {
      lightboxZoomValue.textContent = Math.round(clamped * 100) + '%';
    }
    stage.scrollLeft = contentX * ratio - ax + lightboxCanvas.offsetLeft;
    stage.scrollTop = contentY * ratio - ay + lightboxCanvas.offsetTop;
  }

  function zoomLightboxBy(factor, anchorX, anchorY) {
    setLightboxZoom(lightboxZoom * factor, anchorX, anchorY);
  }

  // ── Lightbox annotation layer ─────────────────────────────────────────────
  function annoGeomOf(shape) {
    if (shape.type === 'path') return { pts: shape.pts.map(function (p) { return [p[0], p[1]]; }) };
    var geom = {};
    Object.keys(shape).forEach(function (k) { if (k !== 'type') geom[k] = shape[k]; });
    return geom;
  }

  function annoSetGeom(shape, geom) {
    if (shape.type === 'path') shape.pts = geom.pts.map(function (p) { return [p[0], p[1]]; });
    else Object.keys(geom).forEach(function (k) { shape[k] = geom[k]; });
  }

  function annoBBox(shape) {
    if (shape.type === 'rect') return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
    if (shape.type === 'ellipse') return { x: shape.cx - shape.rx, y: shape.cy - shape.ry, w: shape.rx * 2, h: shape.ry * 2 };
    if (shape.type === 'line' || shape.type === 'arrow') {
      return {
        x: Math.min(shape.x1, shape.x2), y: Math.min(shape.y1, shape.y2),
        w: Math.abs(shape.x2 - shape.x1), h: Math.abs(shape.y2 - shape.y1),
      };
    }
    var xs = shape.pts.map(function (p) { return p[0]; });
    var ys = shape.pts.map(function (p) { return p[1]; });
    var x = Math.min.apply(null, xs);
    var y = Math.min.apply(null, ys);
    return { x: x, y: y, w: Math.max.apply(null, xs) - x, h: Math.max.apply(null, ys) - y };
  }

  function annoApplyBBox(shape, from, to) {
    var sx = from.w > 0.01 ? to.w / from.w : 1;
    var sy = from.h > 0.01 ? to.h / from.h : 1;
    if (shape.type === 'rect') {
      shape.x = to.x; shape.y = to.y; shape.w = to.w; shape.h = to.h;
    } else if (shape.type === 'ellipse') {
      shape.cx = to.x + to.w / 2; shape.cy = to.y + to.h / 2;
      shape.rx = to.w / 2; shape.ry = to.h / 2;
    } else if (shape.type === 'line' || shape.type === 'arrow') {
      var x1 = to.x + (shape.x1 - from.x) * sx;
      var y1 = to.y + (shape.y1 - from.y) * sy;
      var x2 = to.x + (shape.x2 - from.x) * sx;
      var y2 = to.y + (shape.y2 - from.y) * sy;
      shape.x1 = x1; shape.y1 = y1; shape.x2 = x2; shape.y2 = y2;
    } else {
      shape.pts = shape.pts.map(function (p) {
        return [to.x + (p[0] - from.x) * sx, to.y + (p[1] - from.y) * sy];
      });
    }
  }

  function annoPathD(pts) {
    return pts.map(function (p, i) {
      return (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
    }).join(' ');
  }

  function annoShapeEl(shape) {
    var tag = (shape.type === 'line' || shape.type === 'arrow') ? 'line' : shape.type;
    var el = document.createElementNS(ANNO_NS, tag);
    if (shape.type === 'line' || shape.type === 'arrow') {
      el.setAttribute('x1', shape.x1.toFixed(1)); el.setAttribute('y1', shape.y1.toFixed(1));
      el.setAttribute('x2', shape.x2.toFixed(1)); el.setAttribute('y2', shape.y2.toFixed(1));
      el.setAttribute('stroke-linecap', 'round');
      if (shape.type === 'arrow') el.setAttribute('marker-end', 'url(#anno-arrow-head)');
    } else if (shape.type === 'rect') {
      el.setAttribute('x', shape.x.toFixed(1)); el.setAttribute('y', shape.y.toFixed(1));
      el.setAttribute('width', Math.max(0.1, shape.w).toFixed(1));
      el.setAttribute('height', Math.max(0.1, shape.h).toFixed(1));
      el.setAttribute('fill', 'transparent');
    } else if (shape.type === 'ellipse') {
      el.setAttribute('cx', shape.cx.toFixed(1)); el.setAttribute('cy', shape.cy.toFixed(1));
      el.setAttribute('rx', Math.max(0.1, shape.rx).toFixed(1));
      el.setAttribute('ry', Math.max(0.1, shape.ry).toFixed(1));
      el.setAttribute('fill', 'transparent');
    } else {
      el.setAttribute('d', annoPathD(shape.pts));
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke-linejoin', 'round');
      el.setAttribute('stroke-linecap', 'round');
    }
    el.setAttribute('stroke', '#ef4444');
    el.setAttribute('stroke-width', String(annoStrokeW));
    return el;
  }

  function annoEnsureDefs() {
    var defs = document.createElementNS(ANNO_NS, 'defs');
    var marker = document.createElementNS(ANNO_NS, 'marker');
    marker.setAttribute('id', 'anno-arrow-head');
    marker.setAttribute('markerWidth', '8');
    marker.setAttribute('markerHeight', '8');
    marker.setAttribute('refX', '6.4');
    marker.setAttribute('refY', '3');
    marker.setAttribute('orient', 'auto');
    var tip = document.createElementNS(ANNO_NS, 'path');
    tip.setAttribute('d', 'M0 0 L7 3 L0 6 Z');
    tip.setAttribute('fill', '#ef4444');
    marker.appendChild(tip);
    defs.appendChild(marker);
    annoSvg.appendChild(defs);
  }

  function annoRedraw() {
    if (!annoSvg) return;
    while (annoSvg.firstChild) annoSvg.removeChild(annoSvg.firstChild);
    annoEnsureDefs();
    annoShapes.forEach(function (shape, index) {
      var g = document.createElementNS(ANNO_NS, 'g');
      g.setAttribute('data-anno-id', String(index));
      g.appendChild(annoShapeEl(shape));
      if (shape.type === 'path' || shape.type === 'line' || shape.type === 'arrow') {
        // A 3px stroke is an unclickable target — give strokes a fat invisible twin.
        var hit = document.createElementNS(ANNO_NS, shape.type === 'path' ? 'path' : 'line');
        if (shape.type === 'path') {
          hit.setAttribute('d', annoPathD(shape.pts));
        } else {
          hit.setAttribute('x1', shape.x1); hit.setAttribute('y1', shape.y1);
          hit.setAttribute('x2', shape.x2); hit.setAttribute('y2', shape.y2);
        }
        hit.setAttribute('fill', 'none');
        hit.setAttribute('stroke', 'transparent');
        hit.setAttribute('stroke-width', String(annoStrokeW * 5));
        hit.setAttribute('data-anno-hit', '');
        g.appendChild(hit);
      }
      annoSvg.appendChild(g);
    });
    if (annoSelected && annoShapes.indexOf(annoSelected) !== -1) {
      var box = annoBBox(annoSelected);
      var ui = document.createElementNS(ANNO_NS, 'rect');
      ui.setAttribute('data-anno-ui', '');
      ui.setAttribute('x', box.x); ui.setAttribute('y', box.y);
      ui.setAttribute('width', Math.max(0.1, box.w)); ui.setAttribute('height', Math.max(0.1, box.h));
      ui.setAttribute('fill', 'none');
      ui.setAttribute('stroke', '#3b82f6');
      ui.setAttribute('stroke-width', String(Math.max(1, annoStrokeW / 2)));
      ui.setAttribute('stroke-dasharray', (annoStrokeW * 2) + ' ' + annoStrokeW);
      annoSvg.appendChild(ui);
      var hs = annoStrokeW * 3;
      [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]]
        .forEach(function (corner, i) {
          var h = document.createElementNS(ANNO_NS, 'rect');
          h.setAttribute('data-anno-ui', '');
          h.setAttribute('data-anno-handle', String(i));
          h.setAttribute('x', corner[0] - hs / 2); h.setAttribute('y', corner[1] - hs / 2);
          h.setAttribute('width', hs); h.setAttribute('height', hs);
          h.setAttribute('fill', '#3b82f6');
          annoSvg.appendChild(h);
        });
    }
  }

  function annoPushOp(op) {
    annoUndoStack.push(op);
    annoRedoStack.length = 0;
  }

  function annoApplyOp(op, reverse) {
    if (op.kind === 'add') {
      if (reverse) annoShapes.splice(annoShapes.indexOf(op.shape), 1);
      else annoShapes.splice(Math.min(op.index, annoShapes.length), 0, op.shape);
    } else if (op.kind === 'del') {
      if (reverse) annoShapes.splice(Math.min(op.index, annoShapes.length), 0, op.shape);
      else annoShapes.splice(annoShapes.indexOf(op.shape), 1);
    } else if (op.kind === 'geom') {
      annoSetGeom(op.shape, reverse ? op.before : op.after);
    } else if (op.kind === 'clear') {
      if (reverse) op.shapes.forEach(function (s) { annoShapes.push(s); });
      else annoShapes.length = 0;
    }
  }

  function annoUndo() {
    var op = annoUndoStack.pop();
    if (!op) return;
    annoApplyOp(op, true);
    annoRedoStack.push(op);
    annoSelected = null;
    annoRedraw();
  }

  function annoRedo() {
    var op = annoRedoStack.pop();
    if (!op) return;
    annoApplyOp(op, false);
    annoUndoStack.push(op);
    annoSelected = null;
    annoRedraw();
  }

  function annoClearAll() {
    if (!annoShapes.length) return;
    annoPushOp({ kind: 'clear', shapes: annoShapes.slice() });
    annoShapes.length = 0;
    annoSelected = null;
    annoRedraw();
  }

  function annoDeleteSelected() {
    if (!annoSelected) return;
    var index = annoShapes.indexOf(annoSelected);
    if (index === -1) return;
    annoPushOp({ kind: 'del', shape: annoSelected, index: index });
    annoShapes.splice(index, 1);
    annoSelected = null;
    annoRedraw();
  }

  function setAnnoMode(mode) {
    annoMode = (annoMode === mode) ? null : mode;
    if (annoMode !== 'm') annoSelected = null;
    Object.keys(annoToolButtons).forEach(function (key) {
      annoToolButtons[key].classList.toggle('is-active', key === annoMode);
    });
    if (annoSvg) annoSvg.style.pointerEvents = annoMode ? 'auto' : 'none';
    if (lightboxStage) {
      if (annoMode === 'f' || annoMode === 'e' || annoMode === 'r') {
        lightboxStage.setAttribute('data-anno-cursor', 'draw');
      } else {
        lightboxStage.removeAttribute('data-anno-cursor');
      }
    }
    annoRedraw();
  }

  function annoPoint(event) {
    var rect = annoSvg.getBoundingClientRect();
    var scale = rect.width > 0 ? lightboxNaturalW / rect.width : 1;
    return { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale };
  }

  function annoCancelDraft() {
    if (!annoDraft) return;
    if (annoDraft.el && annoDraft.el.parentNode) annoDraft.el.parentNode.removeChild(annoDraft.el);
    annoDraft = null;
  }

  function annoPointerDown(event) {
    if (!annoMode || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (annoSvg.setPointerCapture) {
      try { annoSvg.setPointerCapture(event.pointerId); } catch (e) { /* detached */ }
    }
    var pt = annoPoint(event);
    if (annoMode === 'm') {
      var handle = event.target.closest ? event.target.closest('[data-anno-handle]') : null;
      var group = event.target.closest ? event.target.closest('g[data-anno-id]') : null;
      if (handle && annoSelected) {
        var corner = Number(handle.getAttribute('data-anno-handle'));
        var box = annoBBox(annoSelected);
        annoDraft = {
          kind: 'resize', shape: annoSelected, corner: corner,
          startBox: box, before: annoGeomOf(annoSelected), moved: false,
          anchor: {
            x: (corner === 0 || corner === 2) ? box.x + box.w : box.x,
            y: (corner === 0 || corner === 1) ? box.y + box.h : box.y,
          },
        };
      } else if (group) {
        annoSelected = annoShapes[Number(group.getAttribute('data-anno-id'))] || null;
        annoDraft = annoSelected ? {
          kind: 'move', shape: annoSelected, start: pt,
          startBox: annoBBox(annoSelected), before: annoGeomOf(annoSelected), moved: false,
        } : null;
        annoRedraw();
      } else {
        annoSelected = null;
        annoRedraw();
      }
      return;
    }
    var shape;
    if (annoMode === 'f') shape = { type: 'path', pts: [[pt.x, pt.y]] };
    else if (annoMode === 'e') shape = { type: 'ellipse', cx: pt.x, cy: pt.y, rx: 0, ry: 0 };
    else if (annoMode === 'l') shape = { type: 'line', x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
    else if (annoMode === 'a') shape = { type: 'arrow', x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
    else shape = { type: 'rect', x: pt.x, y: pt.y, w: 0, h: 0 };
    annoDraft = { kind: 'draw', shape: shape, start: pt, el: annoShapeEl(shape), clientDist: 0, lastClient: [event.clientX, event.clientY] };
    annoSvg.appendChild(annoDraft.el);
  }

  function annoUpdateDraftEl() {
    var d = annoDraft;
    var fresh = annoShapeEl(d.shape);
    d.el.parentNode.replaceChild(fresh, d.el);
    d.el = fresh;
  }

  function annoPointerMove(event) {
    if (!annoDraft) return;
    var pt = annoPoint(event);
    var d = annoDraft;
    if (d.kind === 'draw') {
      d.clientDist += Math.abs(event.clientX - d.lastClient[0]) + Math.abs(event.clientY - d.lastClient[1]);
      d.lastClient = [event.clientX, event.clientY];
      if (d.shape.type === 'path') {
        d.shape.pts.push([pt.x, pt.y]);
      } else if (d.shape.type === 'line' || d.shape.type === 'arrow') {
        d.shape.x2 = pt.x; d.shape.y2 = pt.y;
      } else if (d.shape.type === 'ellipse') {
        d.shape.cx = (d.start.x + pt.x) / 2; d.shape.cy = (d.start.y + pt.y) / 2;
        d.shape.rx = Math.abs(pt.x - d.start.x) / 2; d.shape.ry = Math.abs(pt.y - d.start.y) / 2;
      } else {
        d.shape.x = Math.min(d.start.x, pt.x); d.shape.y = Math.min(d.start.y, pt.y);
        d.shape.w = Math.abs(pt.x - d.start.x); d.shape.h = Math.abs(pt.y - d.start.y);
      }
      annoUpdateDraftEl();
      return;
    }
    d.moved = true;
    if (d.kind === 'move') {
      var box = d.startBox;
      annoApplyBBox(d.shape, annoBBox(d.shape), {
        x: box.x + (pt.x - d.start.x), y: box.y + (pt.y - d.start.y), w: box.w, h: box.h,
      });
    } else {
      var ax = d.anchor.x;
      var ay = d.anchor.y;
      annoApplyBBox(d.shape, annoBBox(d.shape), {
        x: Math.min(ax, pt.x), y: Math.min(ay, pt.y),
        w: Math.max(1, Math.abs(pt.x - ax)), h: Math.max(1, Math.abs(pt.y - ay)),
      });
    }
    annoRedraw();
  }

  function annoPointerUp() {
    if (!annoDraft) return;
    var d = annoDraft;
    annoDraft = null;
    if (d.kind === 'draw') {
      if (d.el.parentNode) d.el.parentNode.removeChild(d.el);
      var tooSmall = d.clientDist < 4 ||
        (d.shape.type === 'path' && d.shape.pts.length < 2);
      if (!tooSmall) {
        annoPushOp({ kind: 'add', shape: d.shape, index: annoShapes.length });
        annoShapes.push(d.shape);
      }
      annoRedraw();
      return;
    }
    if (d.moved) {
      annoPushOp({ kind: 'geom', shape: d.shape, before: d.before, after: annoGeomOf(d.shape) });
    }
    annoRedraw();
  }

  function annoSetup(sourceNode) {
    annoShapes = [];
    if (annoStore) {
      annoShapes = annoStore.get(sourceNode);
      if (!annoShapes) { annoShapes = []; annoStore.set(sourceNode, annoShapes); }
    }
    annoUndoStack = [];
    annoRedoStack = [];
    annoSelected = null;
    annoCancelDraft();
    annoStrokeW = Math.max(3, Math.round(Math.max(lightboxNaturalW, lightboxNaturalH) / 300));
    annoSvg = document.createElementNS(ANNO_NS, 'svg');
    annoSvg.setAttribute('class', 'lightbox-anno');
    annoSvg.setAttribute('viewBox', '0 0 ' + lightboxNaturalW + ' ' + lightboxNaturalH);
    annoSvg.addEventListener('pointerdown', annoPointerDown);
    annoSvg.addEventListener('pointermove', annoPointerMove);
    annoSvg.addEventListener('pointerup', annoPointerUp);
    annoSvg.addEventListener('pointercancel', annoPointerUp);
    lightboxCanvas.appendChild(annoSvg);
    annoMode = null;
    setAnnoMode(null);
  }

  function buildLightbox() {
    if (lightboxEl) return;
    lightboxEl = document.createElement('div');
    lightboxEl.className = 'lightbox';
    lightboxEl.hidden = true;
    lightboxEl.setAttribute('role', 'dialog');
    lightboxEl.setAttribute('aria-modal', 'true');

    var bar = document.createElement('div');
    bar.className = 'lightbox-bar';
    var hint = document.createElement('span');
    hint.className = 'lightbox-hint';
    hint.textContent = 'ctrl+scroll zoom · drag pan · f/e/r/l/a draw · m select · del remove · ctrl+z undo · esc close';
    lightboxZoomValue = document.createElement('span');
    lightboxZoomValue.className = 'lightbox-zoom-value';
    lightboxZoomValue.setAttribute('data-lightbox-zoom-value', '');
    bar.appendChild(hint);
    bar.appendChild(lightboxButton('−', 'Zoom out', function () { zoomLightboxBy(1 / LIGHTBOX_STEP); }));
    bar.appendChild(lightboxZoomValue);
    bar.appendChild(lightboxButton('+', 'Zoom in', function () { zoomLightboxBy(LIGHTBOX_STEP); }));
    bar.appendChild(lightboxButton('Fit', 'Fit to window', function () { setLightboxZoom(lightboxFitZoom); }));
    bar.appendChild(lightboxButton('1:1', 'Actual size', function () { setLightboxZoom(1); }));
    var sep = document.createElement('span');
    sep.className = 'lightbox-sep';
    bar.appendChild(sep);
    [
      ['f', '✎', 'Freehand (f)'],
      ['e', '○', 'Ellipse (e)'],
      ['r', '▭', 'Rectangle (r)'],
      ['l', '╱', 'Line (l)'],
      ['a', '↗', 'Arrow (a)'],
      ['m', '✥', 'Select / move (m)'],
    ].forEach(function (tool) {
      var button = lightboxButton(tool[1], tool[2], function () { setAnnoMode(tool[0]); });
      button.setAttribute('data-anno-tool', tool[0]);
      annoToolButtons[tool[0]] = button;
      bar.appendChild(button);
    });
    var clearButton = lightboxButton('Clear', 'Clear all annotations', annoClearAll);
    clearButton.setAttribute('data-anno-clear', '');
    bar.appendChild(clearButton);
    bar.appendChild(lightboxButton('✕', 'Close', closeLightbox));

    lightboxStage = document.createElement('div');
    lightboxStage.className = 'lightbox-stage';
    lightboxCanvas = document.createElement('div');
    lightboxCanvas.className = 'lightbox-canvas';
    lightboxStage.appendChild(lightboxCanvas);
    lightboxEl.appendChild(bar);
    lightboxEl.appendChild(lightboxStage);
    document.body.appendChild(lightboxEl);

    var panning = false;
    var panX = 0;
    var panY = 0;
    var panDistance = 0;

    lightboxStage.addEventListener('wheel', function (event) {
      // Plain and shift+wheel stay native scrolling — that is the pan.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      var rect = lightboxStage.getBoundingClientRect();
      zoomLightboxBy(
        event.deltaY < 0 ? LIGHTBOX_STEP : 1 / LIGHTBOX_STEP,
        event.clientX - rect.left,
        event.clientY - rect.top
      );
    }, { passive: false });

    lightboxStage.addEventListener('mousedown', function (event) {
      if (event.button !== 0) return;
      // With a tool armed the overlay owns pointer events over the artwork.
      if (annoMode && event.target && event.target.closest && event.target.closest('.lightbox-anno')) return;
      panning = true;
      panDistance = 0;
      panX = event.clientX;
      panY = event.clientY;
      lightboxStage.setAttribute('data-panning', '');
      event.preventDefault();
    });
    document.addEventListener('mousemove', function (event) {
      if (!panning) return;
      var dx = event.clientX - panX;
      var dy = event.clientY - panY;
      panX = event.clientX;
      panY = event.clientY;
      panDistance += Math.abs(dx) + Math.abs(dy);
      lightboxStage.scrollLeft -= dx;
      lightboxStage.scrollTop -= dy;
    });
    document.addEventListener('mouseup', function () {
      if (!panning) return;
      panning = false;
      lightboxStage.removeAttribute('data-panning');
    });

    lightboxStage.addEventListener('click', function (event) {
      if (panDistance > 4) return;
      // Only the empty backdrop closes; a click on the artwork must not.
      if (event.target === lightboxStage) closeLightbox();
    });
    lightboxStage.addEventListener('dblclick', function (event) {
      event.preventDefault();
      if (annoMode && event.target && event.target.closest && event.target.closest('.lightbox-anno')) return;
      setLightboxZoom(Math.abs(lightboxZoom - 1) < 0.001 ? lightboxFitZoom : 1);
    });
  }

  function lightboxSourceOf(node) {
    if (node.tagName === 'IMG') return node;
    return node.querySelector('svg') || node;
  }

  function lightboxNaturalSize(source) {
    if (source.tagName === 'IMG') {
      return { w: source.naturalWidth || source.clientWidth || 1, h: source.naturalHeight || source.clientHeight || 1 };
    }
    var box = source.viewBox ? source.viewBox.baseVal : null;
    if (box && box.width) return { w: box.width, h: box.height };
    var rect = source.getBoundingClientRect();
    return { w: rect.width || 1, h: rect.height || 1 };
  }

  function openLightbox(node) {
    buildLightbox();
    var source = lightboxSourceOf(node);
    var size = lightboxNaturalSize(source);
    lightboxNaturalW = Math.max(1, Math.round(size.w));
    lightboxNaturalH = Math.max(1, Math.round(size.h));

    var isVector = !!(source.tagName && source.tagName.toLowerCase() === 'svg');
    var clone = source.cloneNode(true);
    clone.removeAttribute('id');
    clone.removeAttribute('class');
    clone.removeAttribute('style');
    clone.removeAttribute('width');
    clone.removeAttribute('height');
    if (isVector && !clone.getAttribute('viewBox')) {
      clone.setAttribute('viewBox', '0 0 ' + lightboxNaturalW + ' ' + lightboxNaturalH);
    }
    while (lightboxCanvas.firstChild) {
      lightboxCanvas.removeChild(lightboxCanvas.firstChild);
    }
    lightboxCanvas.appendChild(clone);
    annoSetup(node);

    lightboxReturnScroll = window.scrollY;
    suppressAnchorCapture = true;
    document.body.setAttribute('data-lightbox-open', '');
    lightboxEl.hidden = false;
    lightboxStage.scrollTop = 0;
    lightboxStage.scrollLeft = 0;
    lightboxZoom = 1;
    lightboxFitZoom = computeLightboxFit(isVector);
    setLightboxZoom(lightboxFitZoom);
  }

  function closeLightbox() {
    if (!lightboxIsOpen()) return;
    lightboxEl.hidden = true;
    document.body.removeAttribute('data-lightbox-open');
    annoCancelDraft();
    annoSvg = null;
    annoMode = null;
    setAnnoMode(null);
    while (lightboxCanvas.firstChild) {
      lightboxCanvas.removeChild(lightboxCanvas.firstChild);
    }
    window.scrollTo(window.scrollX, lightboxReturnScroll);
    window.requestAnimationFrame(function () {
      suppressAnchorCapture = false;
      captureScrollAnchor();
    });
  }

  if (contentEl) {
    contentEl.addEventListener('click', function (event) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      var target = (event.target && event.target.closest) ? event.target.closest(LIGHTBOX_TARGETS) : null;
      if (!target) return;
      // A linked image is a link first.
      if (target.closest('a[href]')) return;
      event.preventDefault();
      openLightbox(target);
    });
  }

  document.addEventListener('keydown', function (event) {
    if (!lightboxIsOpen()) return;
    var key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 'z' && !event.shiftKey) {
      event.preventDefault(); annoUndo(); return;
    }
    if ((event.ctrlKey || event.metaKey) && (key === 'y' || (key === 'z' && event.shiftKey))) {
      event.preventDefault(); annoRedo(); return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      // Layered: cancel an in-progress draw, then drop the selection, then close.
      if (annoDraft) { annoCancelDraft(); annoRedraw(); return; }
      if (annoSelected) { annoSelected = null; annoRedraw(); return; }
      closeLightbox();
      return;
    }
    if (key === 'f' || key === 'e' || key === 'r' || key === 'l' || key === 'a' || key === 'm') {
      event.preventDefault(); setAnnoMode(key); return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault(); annoDeleteSelected(); return;
    }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomLightboxBy(LIGHTBOX_STEP); return; }
    if (event.key === '-' || event.key === '_') { event.preventDefault(); zoomLightboxBy(1 / LIGHTBOX_STEP); return; }
    if (event.key === '0') { event.preventDefault(); setLightboxZoom(lightboxFitZoom); return; }
    if (event.key === '1') { event.preventDefault(); setLightboxZoom(1); }
  });

  window.addEventListener('resize', function () {
    if (!lightboxIsOpen()) return;
    var shown = lightboxCanvas.firstElementChild;
    lightboxFitZoom = computeLightboxFit(!!(shown && shown.tagName.toLowerCase() === 'svg'));
  });
})();
</script>
</body>
</html>`;

// Render every deferred dot/graphviz placeholder to inline SVG using the
// in-process WASM engine. Loads the WASM module only when at least one dot
// block exists, so text-only docs pay nothing.
async function bakeGraphviz(htmlStr) {
  if (!/data-graphviz-src=/.test(htmlStr)) return htmlStr;
  let Graphviz;
  try {
    ({ Graphviz } = require('@hpcc-js/wasm-graphviz'));
  } catch (e) {
    console.error('[ERROR] @hpcc-js/wasm-graphviz not installed — run `npm install`:', e.message);
    return htmlStr;
  }
  const gv = await Graphviz.load();
  return htmlStr.replace(/<div class="graphviz" data-graphviz-src="([^"]*)"><\/div>/g, (m, b64) => {
    const dotSrc = Buffer.from(b64, 'base64').toString('utf8');
    try {
      const svg = gv.dot(dotSrc)
        .replace(/<\?xml[^>]*\?>/g, '')
        .replace(/<!DOCTYPE[\s\S]*?>/g, '')
        // drop graphviz's "Generated by graphviz" banner comment so the div and <svg> are adjacent
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim();
      return `<div class="graphviz">${svg}</div>`;
    } catch (e) {
      console.error('[WARN] graphviz render failed:', e.message);
      const escaped = dotSrc.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<pre><code class="language-dot">${escaped}</code></pre>\n`;
    }
  });
}

function launchBrowser(puppeteer) {
  return puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-crash-reporter', '--disable-dev-shm-usage'],
  });
}

// Pre-render mermaid/wavedrom to inert SVG using headless Chromium, then strip
// the diagram-engine runtime scripts so the output HTML carries no diagram JS.
async function bakeDiagrams(htmlStr) {
  if (!/data-md2doc-diagram-engine/.test(htmlStr)) return htmlStr;
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (e) {
    console.error('[ERROR] --bake-svg requires puppeteer/Chromium — install it, or drop --bake-svg:', e.message);
    process.exit(1);
  }
  const tmp = dst.replace(/\.html$/i, '._bake.html');
  fs.writeFileSync(tmp, htmlStr, 'utf8');
  let browser;
  try {
    browser = await launchBrowser(puppeteer);
  } catch (e) {
    fs.unlinkSync(tmp);
    console.error('[ERROR] --bake-svg requires Chromium but it failed to launch — drop --bake-svg or install Chromium:', e.message);
    process.exit(1);
  }
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.resolve(tmp), { waitUntil: 'load' });
    await new Promise(r => setTimeout(r, DIAGRAM_RENDER_WAIT_MS));
    await page.evaluate(() => {
      document.querySelectorAll('script[data-md2doc-diagram-engine]').forEach((s) => s.remove());
    });
    return await page.content();
  } finally {
    await browser.close();
    fs.unlinkSync(tmp);
  }
}

// ── Output ───────────────────────────────────────────────────────────────────
(async () => {
  let finalHtml = await bakeGraphviz(html);

  if (ext === '.html') {
    if (BAKE_SVG) finalHtml = await bakeDiagrams(finalHtml);
    fs.writeFileSync(dst, finalHtml, 'utf8');
    console.log(`[HTML] ${src} → ${dst}`);

  } else if (ext === '.pdf') {
    if (BAKE_SVG) console.log('[INFO] --bake-svg is redundant for PDF output (already static); ignoring');
    let puppeteer;
    try {
      puppeteer = require('puppeteer');
    } catch (e) {
      console.error('[ERROR] puppeteer not found — install with: npm install puppeteer');
      process.exit(1);
    }

    // Write temporary HTML, launch headless Chromium, export PDF.
    // Case-insensitive: an uppercase .PDF dst must not make tmp === dst, or the
    // unlinkSync below deletes the freshly written PDF.
    const tmp = dst.replace(/\.pdf$/i, '._tmp.html');
    fs.writeFileSync(tmp, finalHtml, 'utf8');

    const browser = await launchBrowser(puppeteer);
    const page = await browser.newPage();

    await page.goto('file://' + path.resolve(tmp), { waitUntil: 'load' });

    // Allow WaveDrom / Mermaid scripts time to render diagrams.
    // NOTE: this sleep is load-bearing for the DEFAULT (view-time) render path.
    // It is only safe to drop under --bake-svg, where the DOM is already final SVG.
    await new Promise(r => setTimeout(r, DIAGRAM_RENDER_WAIT_MS));

    await page.pdf({
      path:            dst,
      format:          'A4',
      printBackground: true,
      outline:         true,
      tagged:          true,
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' }
    });

    await browser.close();
    fs.unlinkSync(tmp);
    console.log(`[PDF]  ${src} → ${dst}`);

  } else {
    console.error('[ERROR] Output extension must be .html or .pdf');
    process.exit(1);
  }
})().catch((e) => {
  console.error('[ERROR]', (e && e.stack) || e);
  process.exit(1);
});
