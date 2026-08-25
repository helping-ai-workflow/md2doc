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

// How long to let client-side WaveDrom / Mermaid scripts render before we
// snapshot the DOM (PDF print, or --bake-svg inert-SVG bake).
const DIAGRAM_RENDER_WAIT_MS = 2500;

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

// ── marked setup (installed once at require time) ───────────────────────────
// marked.use() has no de-dup: it unshifts a fresh copy of these tokenizers
// into marked's shared/global extension registry on every call. These two
// extensions don't depend on any per-document state (mdText/srcPath), so they
// are installed exactly once here rather than inside renderMarkdown() — doing
// it per-call would grow the registry unboundedly in a long-lived process
// (the editor server calls renderMarkdown() once per edit).
let marked, Renderer;
try {
  ({ marked, Renderer } = require('marked'));

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
} catch (e) {
  console.error('[ERROR] marked not found — install with: npm install marked');
  console.error(e.message);
  process.exit(1);
}

async function renderMarkdown(mdText, srcPath, opts = {}) {
  const md = mdText;
  const src = srcPath;
  let usesMermaid = false;
  let usesWaveDrom = false;
  let usesMath = false;
  let blocks = null;
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
  // NOTE: intentionally no try/catch here. A throw from marked/katex parsing
  // (pathological markdown, a malformed extension token, etc.) must propagate
  // to the caller: the CLI's outer `(async () => {...})().catch(...)` exits 1,
  // and the long-lived editor server's route wraps renderMarkdown in its own
  // try/catch to return a 500 and keep serving. Swallowing it here with
  // process.exit(1) (the old behavior) used to kill the whole editor server on
  // any render-time throw — see lib/editor/server.js's /api/render handler.
  // The *module-level* require('marked') failure above (~line 172) still has
  // its own catch, since that one really is unrecoverable at load time.
  {
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

    // subscript/superscript and $…$/$$…$$ KaTeX extensions are installed once
    // at module-require time (see the top-level marked setup above) — marked's
    // global extension registry is shared, and marked.use() has no de-dup.
    // setOptions() through the marked.parse()/parser()/lexer() calls below
    // must stay synchronous: marked keeps its renderer/options as shared
    // global state, so an await between setOptions and parse would let a
    // concurrent renderMarkdown() call for a DIFFERENT request overwrite
    // this renderer mid-render (the editor server handles requests
    // concurrently, unlike the one-shot CLI).
    marked.setOptions({ gfm: true, breaks: false, renderer });

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

    if (opts.editMode) {
      // Ranges are computed on mdPre. The [[...]] preprocessing above only
      // replaces text within single lines and never adds/removes newlines,
      // so line ranges stay valid against the ORIGINAL md the client holds
      // (guarded by the '[[...]] must not shift lines' test).
      const { buildBlockMap } = require('./editor/blockmap.js');
      blocks = buildBlockMap(mdPre).blocks;
      // marked.lexer() inline-lexes as part of block lexing (verified against
      // marked 14.1.4: a paragraph token's `.tokens` already holds resolved
      // inline tokens such as `strong`/`link`, not raw text) — so
      // marked.parser([t]) on one already-lexed top-level token reproduces
      // exactly what the whole-document parse would emit for that token,
      // using the same renderer/options set above.
      const tokens = marked.lexer(mdPre);
      const parts = [];
      let bi = 0;
      for (const t of tokens) {
        if (t.type === 'space') continue;
        const b = blocks[bi++];
        const inner = marked.parser([t]);
        parts.push(
          `<div class="ed-block" data-block-id="${b.id}" data-block-type="${b.type}">` +
          inner + '</div>'
        );
      }
      bodyHtml = parts.join('\n');
    } else {
      bodyHtml = marked.parse(mdPre);
    }
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
  }

  // ── HTML template ────────────────────────────────────────────────────────────
  const title = path.basename(src, '.md');

  // Edit-mode only: the reader runtime's diagram init becomes a re-invokable,
  // idempotent hook (needed by a later task so re-rendered blocks can trigger
  // diagram init again after a DOM swap, without a full page reload).
  // Mermaid is explicitly initialized with startOnLoad:false here and driven
  // entirely through this hook — running it alongside the non-edit path's
  // `startOnLoad:true` auto-scan would race the same DOMContentLoaded event
  // and risk mermaid processing (or erroring on) the same node twice.
  // WaveDrom is driven entirely through this hook too (the non-edit path's
  // own 4x-retry `renderWaveDrom` script is dropped in edit mode below) —
  // WaveDrom.ProcessAll() (node_modules/wavedrom/lib/process-all.js) always
  // rescans `document.querySelectorAll('*')` for elements whose `.type` is
  // (case-insensitively) 'wavedrom' and unconditionally inserts a fresh
  // WaveDrom_Display_* node for every match; it never marks a source node
  // processed. Calling it more than once therefore re-renders (and
  // duplicates the DOM nodes for) every diagram already rendered, not just
  // new ones — confirmed empirically via puppeteer: 3 consecutive
  // ProcessAll() calls produced WaveDrom_Display_* counts 1 -> 2 -> 3. Worse,
  // ProcessAll() numbers whatever it finds THIS call starting at index 0
  // (WaveDrom_Display_0, WaveDrom_Display_1, ...), and internally resolves
  // both the source JSON (`eva('InputJSON_' + i)`) and the render target
  // (`renderWaveForm` -> `getElementById('WaveDrom_Display_' + i)`) via
  // getElementById — so on a second call, an id reused from an EARLIER call
  // that's still sitting on an old, already-rendered node collides with the
  // new call's id 0, and getElementById resolves to whichever element is
  // FIRST in document order: a stale id can make a brand-new diagram get
  // rendered from an old diagram's source JSON, or into an old diagram's
  // display div (silently overwriting it), leaving the true new div empty —
  // confirmed empirically the same way (adding a fresh unprocessed wavedrom
  // script and re-invoking left the new WaveDrom_Display_* node with no
  // <svg> while the original diagram's div picked up the new content
  // instead). `type="WaveDrom"` / `id="InputJSON_*"` / `id="WaveDrom_Display_*"`
  // are the only signals ProcessAll and its helpers use, so the fix is to
  // reclaim all of those off every already-processed node before each call,
  // so the call's fresh 0-based numbering can never collide with anything
  // still resolvable via getElementById.
  const diagramInitHookScript = `<script type="text/javascript" data-md2doc-diagram-engine="init-hook">
  var __md2docWavedromSeq = 0;
  window.__md2docInitDiagrams = function (rootEl) {
    rootEl = rootEl || document;
    if (typeof mermaid !== 'undefined') {
      mermaid.initialize({ startOnLoad: false, theme: 'default' });
      var mermaidNodes = rootEl.querySelectorAll ? rootEl.querySelectorAll('.mermaid') : [];
      var pending = [];
      for (var i = 0; i < mermaidNodes.length; i++) {
        if (mermaidNodes[i].getAttribute('data-processed') !== 'true') {
          pending.push(mermaidNodes[i]);
        }
      }
      if (pending.length) {
        mermaid.init(undefined, pending);
      }
    }
    if (typeof WaveDrom !== 'undefined') {
      // WaveDrom has no per-root scoping API — ProcessAll() always scans the
      // whole document, so this branch is intentionally NOT scoped to
      // rootEl (known limitation of this hook's "scoped to rootEl" contract
      // for WaveDrom specifically). Only call it when there is at least one
      // still-unprocessed script(type=WaveDrom) source node anywhere in the
      // document; a node is "unprocessed" as long as its type attribute
      // still literally reads "WaveDrom" (case as emitted by the code
      // renderer above).
      var wavePending = document.querySelectorAll('script[type="WaveDrom"]');
      if (wavePending.length) {
        // Reclaim every id ProcessAll's getElementById lookups could
        // otherwise re-resolve to a stale, already-rendered node from an
        // earlier call (see the comment above this script for why).
        var stale = document.querySelectorAll(
          '[id^="WaveDrom_Display_"], script[id^="InputJSON_"]'
        );
        for (var s = 0; s < stale.length; s++) {
          stale[s].id = 'md2doc-wavedrom-done-' + (__md2docWavedromSeq++);
        }
        WaveDrom.ProcessAll();
        for (var j = 0; j < wavePending.length; j++) {
          // ProcessAll() just inserted the display div as the immediately
          // preceding sibling of its source script node (see process-all.js:
          // parentNode.insertBefore(node0, points.item(i))). Tag it with a
          // stable class BEFORE the id reclaim above can ever rename it away
          // (on a later call) — the CSS cursor rule and the lightbox click
          // target selector both key off this class (in addition to the
          // WaveDrom_Display_ id prefix, which non-edit pages rely on and
          // never rename), so a diagram stays clickable and zoom-in-affordant
          // for its whole lifetime, independent of id reclaiming.
          var displayDiv = wavePending[j].previousElementSibling;
          if (displayDiv) {
            displayDiv.classList.add('wavedrom-diagram');
          }
          wavePending[j].setAttribute('type', 'WaveDrom-done');
        }
      }
    }
  };
  window.addEventListener('DOMContentLoaded', function () {
    window.__md2docInitDiagrams(document);
  });
</script>`;

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
  .content [id^="WaveDrom_Display_"],
  .content .wavedrom-diagram { cursor: zoom-in; }
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
  .lightbox-swatch {
    width: 16px;
    height: 16px;
    min-width: 16px;
    padding: 0;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.4);
    cursor: pointer;
    align-self: center;
  }
  .lightbox-swatch.is-active {
    border-color: #ffffff;
    box-shadow: 0 0 0 2px #93c5fd;
  }
  /* Inline annotation overlay left behind after closing the lightbox:
     same-viewBox svg over the source figure, in-memory only. */
  .anno-inline-wrap {
    position: relative;
    display: inline-block;
    max-width: 100%;
  }
  .anno-inline {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
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
  /* Editor runtime (browser --edit mode). These selectors only ever appear
     in edit-mode renders (.ed-block wrappers are only emitted when
     opts.editMode is set — see the marked.lexer()/marked.parser() loop
     above), so shipping this unconditionally is inert on normal HTML
     output, same precedent as the lightbox selectors above. */
  .ed-block { position: relative; cursor: pointer; }
  .ed-block:hover { outline: 1px dashed #b0b0b0; }
  /* Phase 3 Task 2: always-on paragraph/heading/list editing. Every eligible
     block's content element is contenteditable from the moment it renders
     (armEditables() in the client runtime) — no persistent outline (that
     would outline the whole document at once); the blue "editing" outline
     only appears while the surface is actually focused, via :focus, so it
     naturally shows/hides itself in lockstep with the burst lifecycle
     (focusin starts a burst, focusout ends it) without any JS-driven class
     toggling. */
  .ed-wys-armed { cursor: text; }
  .ed-wys-armed:focus {
    outline: 2px solid #3b82f6; outline-offset: 2px;
    caret-color: #3b82f6;
  }
  /* Task 5: table cells armed PERMANENTLY (one edit surface per CELL, not
     per table root — see armEditables()'s 'table' branch in the client
     runtime) — same "no persistent outline, blue on :focus" language as
     .ed-wys-armed above, but INSET (negative offset), not outset: the
     enclosing table element has overflow-x: auto (see the table ruleset
     below), which would clip an outset outline on any cell near the
     table's horizontal edges. */
  .ed-wys-cell { cursor: text; }
  .ed-wys-cell:focus {
    outline: 2px solid #3b82f6; outline-offset: -2px;
    caret-color: #3b82f6;
  }
  /* Phase 3 Task 2: the ⠿ block-actions handle — one real per-block node
     (not a floating, JS-repositioned element like .ed-seltb/.ed-tb-insert),
     sat in the block's left gutter and revealed on hover. Only ever a
     visibility toggle (opacity), never display or pointer-events, so a
     script-driven click still reaches it even without a real hover. */
  .ed-handle {
    position: absolute; left: -22px; top: 0; width: 18px; height: 20px;
    display: flex; align-items: center; justify-content: center;
    padding: 0; margin: 0; border: none; border-radius: 4px;
    background: transparent; color: #8a8a8a; font-size: 13px; line-height: 1;
    cursor: pointer; opacity: 0; transition: opacity .12s ease, background .12s ease;
  }
  .ed-block:hover .ed-handle,
  .ed-handle:focus { opacity: 1; }
  .ed-handle:hover { background: rgba(0, 0, 0, 0.08); }
  /* The ⠿ handle's small menu: heading ± / MD 原始碼 / close. Dark
     translucent pill, bordered icon buttons — same visual language as
     .ed-seltb below. */
  .ed-handle-menu {
    position: absolute; top: -4px; left: -4px; z-index: 6;
    display: flex; align-items: center; gap: 4px;
    padding: 4px 6px; border-radius: 8px;
    background: rgba(16, 18, 21, 0.92); color: #e6edf3;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  }
  .ed-handle-menu-btn {
    min-width: 28px; height: 26px; padding: 0 8px;
    border: 1px solid rgba(255, 255, 255, 0.25); border-radius: 6px;
    background: rgba(255, 255, 255, 0.08); color: inherit;
    font: inherit; font-size: 12px; line-height: 1;
    white-space: nowrap; cursor: pointer;
  }
  .ed-handle-menu-btn:hover { background: rgba(255, 255, 255, 0.18); }
  .ed-handle-menu-btn[hidden] { display: none; }
  /* Task 5: hover-edge column/row insert bubbles — a SINGLETON pair of "＋"
     buttons (client runtime repositions them via getBoundingClientRect(),
     never creates more than these two). Visual language deliberately
     matches .ed-handle above (small, low-contrast, no persistent chrome)
     rather than .ed-seltb/.ed-handle-menu's dark pill — this is a single
     small affordance shown only within TB_EDGE_PX of a boundary, not a
     toolbar. position: fixed matches the viewport-relative coordinates the
     client runtime computes via getBoundingClientRect(). */
  .ed-tb-insert {
    position: fixed; z-index: 8;
    width: 18px; height: 18px; padding: 0; margin: 0;
    display: flex; align-items: center; justify-content: center;
    border: 1px solid #3b82f6; border-radius: 50%;
    background: #fff; color: #3b82f6; font-size: 13px; line-height: 1;
    cursor: pointer; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  }
  .ed-tb-insert:hover { background: #3b82f6; color: #fff; }
  .ed-tb-insert[hidden] { display: none; }
  /* Task 6: table edge-click menus (delete/align) + row drag-reorder.
     '.ed-te-hl' marks the currently-selected column's cells (th+td) or row
     (the <tr> itself) — !important because the sticky-first-column rules
     below (tbody td:first-child / thead th:first-child) carry higher
     specificity (0,1,2 vs this class's 0,1,0) and would otherwise win over
     a first-column/first-row highlight despite this rule appearing later in
     source order. '.ed-te-menu' is a SINGLETON floating menu (position:
     fixed, same viewport-relative idiom as .ed-seltb/.ed-tb-insert above),
     relabeled/repositioned per click rather than rebuilt. '.ed-te-drop-
     indicator' is the singleton line shown while dragging a row.
     '.ed-te-row-dragging' dims the row actually being dragged. */
  .ed-te-hl { background: rgba(59, 130, 246, 0.15) !important; }
  .ed-te-menu {
    position: fixed; z-index: 12;
    display: flex; align-items: center; gap: 4px;
    padding: 4px 6px; border-radius: 8px;
    background: rgba(16, 18, 21, 0.92); color: #e6edf3;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  }
  .ed-te-menu[hidden] { display: none; }
  .ed-te-menu-btn {
    min-width: 28px; height: 26px; padding: 0 8px;
    border: 1px solid rgba(255, 255, 255, 0.25); border-radius: 6px;
    background: rgba(255, 255, 255, 0.08); color: inherit;
    font: inherit; font-size: 12px; line-height: 1;
    white-space: nowrap; cursor: pointer;
  }
  .ed-te-menu-btn:hover { background: rgba(255, 255, 255, 0.18); }
  .ed-te-menu-btn[hidden] { display: none; }
  .ed-te-drop-indicator {
    position: fixed; z-index: 8; height: 3px; border-radius: 2px;
    background: #3b82f6; pointer-events: none;
  }
  .ed-te-drop-indicator[hidden] { display: none; }
  .ed-te-row-dragging { opacity: 0.4; }
  /* Task 4: floating selection toolbar (bold/italic/code/link), shown over a
     non-collapsed selection inside an active WYSIWYG session. position:
     fixed matches the viewport-relative coordinates the client runtime
     computes via Range.getBoundingClientRect(). z-index sits below
     .ed-conflict (999). */
  .ed-seltb {
    position: fixed; z-index: 15;
    display: flex; align-items: center; gap: 4px;
    padding: 4px 6px; border-radius: 8px;
    background: rgba(16, 18, 21, 0.92); color: #e6edf3;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  }
  .ed-seltb-btn {
    min-width: 28px; height: 26px; padding: 0 8px;
    border: 1px solid rgba(255, 255, 255, 0.25); border-radius: 6px;
    background: rgba(255, 255, 255, 0.08); color: inherit;
    font: inherit; font-size: 13px; line-height: 1;
    white-space: nowrap; cursor: pointer;
  }
  .ed-seltb-btn:hover { background: rgba(255, 255, 255, 0.18); }
  .ed-seltb-b { font-weight: bold; }
  .ed-seltb-i { font-style: italic; }
  .ed-editing { position: relative; }
  .ed-raw {
    display: block; width: 100%; font-family: monospace; font-size: 13px;
    min-height: 3em; box-sizing: border-box; padding: 6px;
    border: 1px solid #808080; resize: vertical;
  }
  .ed-controls { display: flex; gap: 6px; margin-top: 4px; }
  .ed-controls button {
    font-size: 13px; padding: 2px 10px; cursor: pointer;
    border: 1px solid #b0b0b0; border-radius: 4px; background: #fff;
  }
  .ed-commit { color: #0a7a0a; }
  .ed-cancel { color: #b00020; }
  .ed-conflict {
    position: fixed; top: 0; left: 0; right: 0; padding: 10px;
    background: #b00020; color: #fff; z-index: 999; text-align: center;
    display: flex; align-items: center; justify-content: center; gap: 12px;
  }
  .ed-conflict button {
    background: #fff; color: #b00020; border: none; border-radius: 4px;
    padding: 4px 12px; cursor: pointer; font-weight: bold;
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
${usesWaveDrom
    ? (opts.editMode
        // Edit mode: WaveDrom init is driven entirely by diagramInitHookScript
        // (emitted from the Mermaid section below, unconditionally whenever
        // opts.editMode is true) — NOT by this block's own retry script.
        // Running both here would race: this script's own DOMContentLoaded
        // listener calls the un-deduped WaveDrom.ProcessAll() directly, so if
        // it fires before the hook gets a chance to mark the source node
        // processed, the very first page load already double-renders the
        // diagram. Only embedding the library here (no init script) removes
        // that race and leaves the hook as the single authority.
        ? `${waveDromSkinTag}
${waveDromTag}`
        : `${waveDromSkinTag}
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
</script>`)
    : ''}

<!-- Mermaid -->
${usesMermaid
    ? (opts.editMode
        ? `${mermaidScriptTag}
${diagramInitHookScript}`
        : `${mermaidScriptTag}
${mermaidInitTag}`)
    : (opts.editMode ? diagramInitHookScript : '')}

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
  // let, not const: edit mode's rerenderAll() swaps .content's innerHTML
  // wholesale after a commit (see lib/editor/client.js), which detaches every
  // node this was captured from. window.__md2docRebindReader() below
  // re-queries and reassigns this same binding so every closure in this IIFE
  // that reads headingNodes (detectActiveHeading, the zoom/resize scroll
  // anchor's binary search, …) sees the live nodes without needing its own
  // re-init call — they all close over this one variable, not a copy of it.
  let headingNodes = Array.from(document.querySelectorAll('[data-reader-heading]'));
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

  // Hoisted out of a bare if block (and into a rebindable function) so that
  // window.__md2docRebindReader() below can disconnect the stale observer
  // and create a fresh one over the post-edit heading nodes — an observer
  // keeps observing the exact node references passed to observe(), so after
  // .content's innerHTML is replaced wholesale, the old observer is watching
  // detached nodes that will never intersect anything again.
  let headingObserver = null;
  function bindHeadingObserver() {
    if (headingObserver) {
      headingObserver.disconnect();
      headingObserver = null;
    }
    if (typeof IntersectionObserver === 'undefined' || !headingNodes.length) {
      return;
    }
    headingObserver = new IntersectionObserver((entries) => {
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
    headingNodes.forEach((node) => headingObserver.observe(node));
  }
  bindHeadingObserver();

  // Paint the breadcrumb immediately so the header is populated before the
  // first IntersectionObserver callback fires.
  if (sections[0]) {
    renderBreadcrumb(sections[0].id);
  }

  // Edit mode only: re-init hook, sibling to window.__md2docInitDiagrams
  // (defined in diagramInitHookScript above for edit-mode pages), called
  // from lib/editor/client.js's rerenderAll() right after it swaps
  // .content's innerHTML on a commit. Re-queries the heading nodes that
  // just got replaced and rebinds the IntersectionObserver onto them, so
  // TOC highlighting / breadcrumb tracking / the zoom-resize scroll anchor
  // (all of which read the headingNodes binding above) keep working
  // against live nodes instead of silently going dead after the first edit.
  // Defined unconditionally (this script runs on every page, not just edit
  // mode) but never invoked outside the edit-mode client — non-edit pages'
  // on-load behavior is unchanged since nothing here calls it automatically.
  window.__md2docRebindReader = function () {
    // Always re-queries the whole document, matching the initial-load query
    // above — heading nodes only ever live inside .content, but scoping this
    // to a passed-in root would just be an equivalent, more fragile way of
    // saying the same thing.
    headingNodes = Array.from(document.querySelectorAll('[data-reader-heading]'));
    bindHeadingObserver();
  };

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
  var LIGHTBOX_TARGETS = 'img, .mermaid, .graphviz, [id^="WaveDrom_Display_"], .wavedrom-diagram';
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
  var ANNO_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#111827'];
  // Office-like absolute stroke widths: rendered px at fit zoom (S/M/L).
  var ANNO_WIDTHS = [1, 2, 4];
  var annoStore = (typeof WeakMap === 'function') ? new WeakMap() : null;
  var annoShapes = [];
  var annoSvg = null;
  var annoMode = null;        // null | 'f' | 'e' | 'r' | 'l' | 'a' | 'm'
  var annoSelected = null;
  var annoDraft = null;
  var annoUndoStack = [];
  var annoRedoStack = [];
  var annoStrokeW = 3;
  var annoColor = ANNO_COLORS[0];
  var annoWidth = ANNO_WIDTHS[1];
  var annoToolButtons = {};
  var annoStyleButtons = [];
  var annoSourceNode = null;
  var annoCloneEl = null;
  var annoBaseSrc = null;

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
    var color = shape.color || ANNO_COLORS[0];
    if (shape.type === 'line' || shape.type === 'arrow') {
      el.setAttribute('x1', shape.x1.toFixed(1)); el.setAttribute('y1', shape.y1.toFixed(1));
      el.setAttribute('x2', shape.x2.toFixed(1)); el.setAttribute('y2', shape.y2.toFixed(1));
      el.setAttribute('stroke-linecap', 'round');
      if (shape.type === 'arrow') el.setAttribute('marker-end', 'url(#anno-arrow-' + color.slice(1) + ')');
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
    el.setAttribute('stroke', color);
    el.setAttribute('stroke-width', (shape.sw || annoStrokeW).toFixed(2));
    return el;
  }

  function annoEnsureDefs(svg) {
    var defs = document.createElementNS(ANNO_NS, 'defs');
    ANNO_COLORS.forEach(function (color) {
      var marker = document.createElementNS(ANNO_NS, 'marker');
      // Same id + content in every overlay svg, so document-wide url(#) lookups
      // always resolve to an identical marker.
      marker.setAttribute('id', 'anno-arrow-' + color.slice(1));
      marker.setAttribute('markerWidth', '8');
      marker.setAttribute('markerHeight', '8');
      marker.setAttribute('refX', '6.4');
      marker.setAttribute('refY', '3');
      marker.setAttribute('orient', 'auto');
      var tip = document.createElementNS(ANNO_NS, 'path');
      tip.setAttribute('d', 'M0 0 L7 3 L0 6 Z');
      tip.setAttribute('fill', color);
      marker.appendChild(tip);
      defs.appendChild(marker);
    });
    svg.appendChild(defs);
  }

  function annoRedraw() {
    if (!annoSvg) return;
    while (annoSvg.firstChild) annoSvg.removeChild(annoSvg.firstChild);
    annoEnsureDefs(annoSvg);
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
        hit.setAttribute('stroke-width', String(Math.max((shape.sw || annoStrokeW) * 5, 10 / (lightboxFitZoom || 1))));
        hit.setAttribute('data-anno-hit', '');
        g.appendChild(hit);
      }
      annoSvg.appendChild(g);
    });
    if (annoSelected && annoShapes.indexOf(annoSelected) !== -1) {
      var u = 1.5 / (lightboxFitZoom || 1); // ~1.5px at fit zoom
      var box = annoBBox(annoSelected);
      var ui = document.createElementNS(ANNO_NS, 'rect');
      ui.setAttribute('data-anno-ui', '');
      ui.setAttribute('x', box.x); ui.setAttribute('y', box.y);
      ui.setAttribute('width', Math.max(0.1, box.w)); ui.setAttribute('height', Math.max(0.1, box.h));
      ui.setAttribute('fill', 'none');
      ui.setAttribute('stroke', '#3b82f6');
      ui.setAttribute('stroke-width', String(u));
      ui.setAttribute('stroke-dasharray', (u * 4) + ' ' + (u * 2));
      annoSvg.appendChild(ui);
      var hs = u * 6;
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
    annoBake();
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
    } else if (op.kind === 'style') {
      var style = reverse ? op.before : op.after;
      op.shape.color = style.color;
      op.shape.sw = style.sw;
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
    annoBake();
  }

  function annoRedo() {
    var op = annoRedoStack.pop();
    if (!op) return;
    annoApplyOp(op, false);
    annoUndoStack.push(op);
    annoSelected = null;
    annoRedraw();
    annoBake();
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

  function setAnnoStyle(patch) {
    if (patch.color) annoColor = patch.color;
    if (patch.w) annoWidth = patch.w;
    annoStyleButtons.forEach(function (entry) {
      entry.button.classList.toggle('is-active',
        entry.kind === 'color' ? entry.value === annoColor : entry.value === annoWidth);
    });
    // With a selection, the pickers restyle it (undoably); otherwise they only
    // set the style for the next shape.
    if (annoSelected) {
      var beforeStyle = { color: annoSelected.color, sw: annoSelected.sw };
      annoSelected.color = patch.color || annoSelected.color;
      if (patch.w) annoSelected.sw = patch.w / (lightboxFitZoom || 1);
      annoPushOp({
        kind: 'style', shape: annoSelected,
        before: beforeStyle,
        after: { color: annoSelected.color, sw: annoSelected.sw },
      });
      annoRedraw();
    }
  }

  // Re-bake the shown raster clone (image + shapes composited to a PNG data
  // URI) so a native right-click "Copy image" carries the annotations.
  function annoShapesSvgMarkup() {
    var svg = document.createElementNS(ANNO_NS, 'svg');
    svg.setAttribute('xmlns', ANNO_NS);
    svg.setAttribute('viewBox', '0 0 ' + lightboxNaturalW + ' ' + lightboxNaturalH);
    svg.setAttribute('width', lightboxNaturalW);
    svg.setAttribute('height', lightboxNaturalH);
    annoEnsureDefs(svg);
    annoShapes.forEach(function (shape) { svg.appendChild(annoShapeEl(shape)); });
    return new XMLSerializer().serializeToString(svg);
  }

  function annoComposite(drawBase, scale, done) {
    var canvas = document.createElement('canvas');
    canvas.width = lightboxNaturalW * scale;
    canvas.height = lightboxNaturalH * scale;
    var ctx = canvas.getContext('2d');
    drawBase(ctx, canvas, function () {
      if (!annoShapes.length) { done(canvas); return; }
      var overlay = new Image();
      overlay.onload = function () {
        ctx.drawImage(overlay, 0, 0, canvas.width, canvas.height);
        done(canvas);
      };
      overlay.onerror = function () { done(canvas); };
      overlay.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(annoShapesSvgMarkup());
    });
  }

  function annoBake() {
    if (!annoCloneEl || annoCloneEl.tagName !== 'IMG' || !annoBaseSrc) return;
    var expected = annoCloneEl;
    annoComposite(function (ctx, canvas, next) {
      var base = new Image();
      base.onload = function () { ctx.drawImage(base, 0, 0, canvas.width, canvas.height); next(); };
      base.onerror = function () { next(); };
      base.src = annoBaseSrc;
    }, 1, function (canvas) {
      if (annoCloneEl !== expected) return; // lightbox moved on to another image
      try { annoCloneEl.src = canvas.toDataURL('image/png'); }
      catch (e) { /* tainted canvas — keep the plain image */ }
    });
  }

  function annoCopyImage() {
    var clone = annoCloneEl;
    if (!clone) return;
    var isImg = clone.tagName === 'IMG';
    annoComposite(function (ctx, canvas, next) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      var base = new Image();
      base.onload = function () { ctx.drawImage(base, 0, 0, canvas.width, canvas.height); next(); };
      base.onerror = function () { next(); };
      base.src = isImg ? (annoBaseSrc || clone.src)
        : 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
    }, isImg ? 1 : 2, function (canvas) {
      try {
        canvas.toBlob(function (blob) {
          if (!blob || typeof ClipboardItem === 'undefined' || !navigator.clipboard || !navigator.clipboard.write) return;
          navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).catch(function () {});
        }, 'image/png');
      } catch (e) { /* clipboard unavailable */ }
    });
  }

  // After Esc the drawings stay visible on the inline figure: a same-viewBox
  // overlay svg over the source element. In-memory only — gone on reload.
  function annoSyncInline() {
    var node = annoSourceNode;
    if (!node) return;
    var visual = lightboxSourceOf(node);
    if (!visual || !visual.parentNode) return;
    var wrap = visual.closest ? visual.closest('.anno-inline-wrap') : null;
    var shapes = annoShapes;
    if (!shapes.length) {
      if (wrap) {
        var old = wrap.querySelector('svg.anno-inline');
        if (old) wrap.removeChild(old);
      }
      return;
    }
    if (!wrap) {
      wrap = document.createElement('span');
      wrap.className = 'anno-inline-wrap';
      visual.parentNode.insertBefore(wrap, visual);
      wrap.appendChild(visual);
    }
    var overlay = wrap.querySelector('svg.anno-inline');
    if (!overlay) {
      overlay = document.createElementNS(ANNO_NS, 'svg');
      overlay.setAttribute('class', 'anno-inline');
      wrap.appendChild(overlay);
    }
    overlay.setAttribute('viewBox', '0 0 ' + lightboxNaturalW + ' ' + lightboxNaturalH);
    while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
    annoEnsureDefs(overlay);
    shapes.forEach(function (shape) { overlay.appendChild(annoShapeEl(shape)); });
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
      // The baked clone still shows the shape at its old spot — revert to the
      // base image for the gesture; the overlay alone renders the live shapes.
      if (annoDraft && annoCloneEl && annoCloneEl.tagName === 'IMG' && annoBaseSrc) {
        annoCloneEl.src = annoBaseSrc;
      }
      return;
    }
    var shape;
    if (annoMode === 'f') shape = { type: 'path', pts: [[pt.x, pt.y]] };
    else if (annoMode === 'e') shape = { type: 'ellipse', cx: pt.x, cy: pt.y, rx: 0, ry: 0 };
    else if (annoMode === 'l') shape = { type: 'line', x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
    else if (annoMode === 'a') shape = { type: 'arrow', x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
    else shape = { type: 'rect', x: pt.x, y: pt.y, w: 0, h: 0 };
    shape.color = annoColor;
    shape.sw = annoWidth / (lightboxFitZoom || 1);
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
    } else {
      annoBake(); // gesture reverted the clone to the base image — restore it
    }
    annoRedraw();
  }

  function annoSetup(sourceNode) {
    annoSourceNode = sourceNode;
    annoCloneEl = lightboxCanvas.firstElementChild;
    annoBaseSrc = (annoCloneEl && annoCloneEl.tagName === 'IMG') ? annoCloneEl.src : null;
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
    if (annoShapes.length) annoBake();
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
    ANNO_COLORS.forEach(function (color) {
      var swatch = lightboxButton('', 'Stroke color ' + color, function () { setAnnoStyle({ color: color }); });
      swatch.className = 'lightbox-swatch';
      swatch.style.background = color;
      swatch.setAttribute('data-anno-color', color);
      if (color === annoColor) swatch.classList.add('is-active');
      annoStyleButtons.push({ kind: 'color', value: color, button: swatch });
      bar.appendChild(swatch);
    });
    [['S', ANNO_WIDTHS[0]], ['M', ANNO_WIDTHS[1]], ['L', ANNO_WIDTHS[2]]].forEach(function (width) {
      var button = lightboxButton(width[0], 'Stroke width ' + width[1] + 'px', function () { setAnnoStyle({ w: width[1] }); });
      button.setAttribute('data-anno-width', String(width[1]));
      if (width[1] === annoWidth) button.classList.add('is-active');
      annoStyleButtons.push({ kind: 'width', value: width[1], button: button });
      bar.appendChild(button);
    });
    var copyButton = lightboxButton('⧉', 'Copy image with annotations', annoCopyImage);
    copyButton.setAttribute('data-anno-copy', '');
    bar.appendChild(copyButton);
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
    // Mermaid scopes its embedded <style> to the svg's #id — dropping the id
    // kills the theme. Rename it instead (avoids a duplicate id) and rewrite
    // the scoped selectors to the new name.
    if (isVector && source.id) {
      var lightboxCloneId = 'lightbox-' + source.id;
      clone.setAttribute('id', lightboxCloneId);
      Array.prototype.forEach.call(clone.querySelectorAll('style'), function (styleEl) {
        styleEl.textContent = styleEl.textContent.split('#' + source.id).join('#' + lightboxCloneId);
      });
    } else {
      clone.removeAttribute('id');
    }
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
    annoSyncInline();
    annoSourceNode = null;
    annoCloneEl = null;
    annoBaseSrc = null;
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

  const bakedHtml = await bakeGraphviz(html);
  const bakedBody = await bakeGraphviz(bodyHtml);
  return { html: bakedHtml, bodyHtml: bakedBody, blocks };
}
module.exports = { renderMarkdown };

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
async function bakeDiagrams(htmlStr, dstPath) {
  if (!/data-md2doc-diagram-engine/.test(htmlStr)) return htmlStr;
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (e) {
    console.error('[ERROR] --bake-svg requires puppeteer/Chromium — install it, or drop --bake-svg:', e.message);
    process.exit(1);
  }
  const tmp = dstPath.replace(/\.html$/i, '._bake.html');
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

// ── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const [,, src, dst] = process.argv;
  const BAKE_SVG = process.argv.slice(4).includes('--bake-svg');
  if (!src || !dst) {
    console.error('Usage: node md2doc.js <input.md> <output.html|pdf>');
    process.exit(1);
  }

  const ext = path.extname(dst).toLowerCase();

  (async () => {
    const mdText = fs.readFileSync(src, 'utf8');
    const { html } = await renderMarkdown(mdText, path.resolve(src), {});
    let finalHtml = html;

    if (ext === '.html') {
      if (BAKE_SVG) finalHtml = await bakeDiagrams(finalHtml, dst);
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
}
