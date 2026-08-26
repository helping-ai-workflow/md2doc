# Changelog

All notable changes to this project will be documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- **Phase 3: Notion-grade editing** — click anywhere in a paragraph/heading/list/
  table to type directly (no "select then edit" step). Rendered formatting shows
  as you type; focus leaving the block auto-commits. Ctrl+Z/Y step through local
  block history then cascade to document level. ⠿ block menu offers heading depth
  control and MD 原始碼 escape hatch.
- **List structural editing** — Enter splits items, Shift+Enter inserts `<br>`,
  Tab/Shift+Tab indent/outdent; empty-item Enter removes it. Removing all items
  deletes the block cleanly.
- **Table always-on editing** — every cell permanently editable; Tab/Shift+Tab
  navigate between cells (within table stays in burst); ＋ bubbles on edges insert
  rows/columns; edge-click menus delete and cycle alignment (columns) or delete
  (rows); row-edge drag reorders body rows. Edited tables emit gate-compatible
  minimal form (single-space padding, minimal separators).
- **Burst undo with cascade** — Ctrl+Z/Y within a block step through that block's
  local session history; once exhausted, the next step cascades to document-level
  undo/redo stack.
- **Block-level insert and delete** — a ＋ button next to every block's ⠿ handle
  opens a menu (段落/標題/清單/表格/程式碼) to insert a new block directly below,
  with the cursor landing in it immediately; the ⠿ menu gained a 刪除 item to
  delete the whole block (absorbing one adjacent blank line, mirroring the
  existing empty-list-removal line math). Both are a single Ctrl+Z step.

## v2.8.1 — 2026-08-24

### Fixed

- **Mermaid diagrams lost their theme colors in the popup.** Mermaid scopes its
  embedded CSS to the svg's `#id`; the lightbox clone dropped the id and the
  theme died. The clone now takes a `lightbox-<id>` rename with the scoped
  selectors rewritten to match.
- **Dragging a shape left a ghost at the old spot.** During an `m`-mode gesture
  the raster clone reverts to the unannotated base image (the overlay renders
  the live shapes); release re-bakes.

### Changed

- **Stroke widths are now office-like absolute values.** S/M/L = 1/2/4 px at
  fit zoom (was a multiplier on an auto-thickened base that got chunky on
  fit-enlarged vector art). Arrow heads and the selection UI scale down
  accordingly.

## v2.8.0 — 2026-08-24

### Added

- **Annotations stay on the inline figure after Esc.** Closing the lightbox
  overlays the drawings on the in-document image/diagram (same-viewBox svg,
  click-through). In-memory only — reload starts clean; Clear + Esc removes it.
- **Stroke color and width pickers.** Five color swatches (red/blue/green/
  orange/black) and S/M/L widths. New shapes take the current style; with a
  shape selected in `m` mode the pickers restyle it, undoably. Arrow heads
  follow the stroke color.
- **⧉ Copy button.** Composites artwork + annotations to a PNG on the
  clipboard — works for raster images and vector diagrams alike (vector at 2x).

### Fixed

- **Right-click "Copy image" in the lightbox missed the drawings.** The shown
  raster clone is now re-baked (image + shapes → PNG data URI) on every
  committed op, so the native copy includes the annotations.

## v2.7.0 — 2026-08-24

### Added

- **Lightbox annotations.** Mark up any popped-out diagram or image with the
  shared-whiteboard shortcut set: `f` freehand, `e` ellipse, `r` rectangle,
  `l` line, `a` arrow, `m` select/move/resize (Del deletes), `Ctrl+Z`/`Ctrl+Y`
  undo/redo, and a Clear button (one undoable op). Shapes live in image
  coordinates so they ride every zoom, survive close/reopen of the same image
  within the page visit, and reset on reload. Esc is layered: cancel the
  in-progress stroke → drop the selection → close the lightbox.

## v2.6.1 — 2026-08-24

### Changed

- **TOC horizontal scrollbar.** The TOC list now shows a thin native horizontal
  scrollbar when a title overflows, so the mouse can drag it directly —
  shift+wheel still works. Doubles as the "more text clipped" hint.

## v2.6.0 — 2026-08-24

### Added

- **Drag the sidebar/content divider to resize.** The 32px gutter between the
  sidebar and the document is now a splitter: invisible until hovered (a thin
  blue line + `col-resize` cursor), drag to set the sidebar width (180px–50vw),
  double-click to reset. The chosen width persists across reloads via
  `localStorage`. Hidden in the collapsed rail, the mobile drawer, and print.
- **TOC horizontal peek with shift+wheel.** Deep headings no longer ellipsize —
  titles keep their natural single-line width and the list clips them at the
  edge (no horizontal scrollbar). Shift+wheel scrolls the TOC sideways to read
  the clipped tails; the position stays where you leave it and defaults to the
  far left.

### Changed

- **Compact search results.** The search label is now just "Search", snippets
  shrink to ~25 chars before / ~45 after the hit, clamp to two lines, and the
  matched keyword is highlighted with `<mark>`.

## v2.5.0 — 2026-08-21

### Added

- **Click a diagram or image to open it full-screen.** Spec artwork is drawn far
  wider than the text column, so the inline copy is unreadably small. Clicking
  any image, Mermaid, Graphviz or WaveDrom graphic now pops it into a modal
  stage that zooms and scrolls.
  - Wheel scrolls, shift+wheel scrolls sideways, ctrl/cmd+wheel zooms around the
    pointer, and dragging pans. Toolbar buttons and the `+` `-` `0` `1` keys do
    the same; `Esc`, the ✕ and a click on the backdrop close it.
  - Zoom resizes the artwork rather than applying a CSS transform, so the scroll
    extent grows with it — under a transform the enlarged edges cannot be
    scrolled into view at all.
  - Vector art opens scaled to fill the window (a 480px-wide waveform is exactly
    what needs enlarging, and SVG upscales losslessly); a raster image opens at
    actual size, where going past 100% only buys blur.
  - An image wrapped in a link stays a link. The overlay is built on first use,
    is hidden in print, and never reaches the PDF output.

## v2.4.2 — 2026-08-21

### Fixed

- **Zooming no longer loses your place.** Browser zoom (and any window resize)
  reflows the text column but leaves the pixel scroll offset untouched, so the
  passage being read slid out of view — measured at 252 px of drift on a real
  spec for one zoom step, with the browser's own scroll anchoring contributing
  nothing. The reader runtime now remembers which block sat at the top of the
  reading column and restores it after the reflow, re-applying it a frame later
  so late-settling images and diagrams cannot knock it loose again.
  - The anchor is re-captured on scroll, throttled to one `requestAnimationFrame`
    and resolved with `elementFromPoint` (falling back to a binary search over
    the headings), so it costs one hit-test per painted frame rather than a
    walk of the document.
  - A height-only resize — a mobile browser hiding its toolbar, a devtools dock —
    reflows nothing and is deliberately left alone, since correcting the scroll
    there would only jerk the page.

## v2.4.1 — 2026-08-20

### Fixed

- **Markdown images now render.** `![alt](assets/pic.png)` was emitted with its
  relative src verbatim, but the HTML is written somewhere else entirely (the OS
  temp dir by default, or wherever `--out` points), so the browser resolved the
  path against the wrong directory and every local image silently failed to
  load. Local image references are now resolved against the **source markdown's**
  directory and inlined as base64 `data:` URIs — the same self-contained
  principle the embedded CSS / KaTeX fonts already follow, and the only form
  that also survives the puppeteer PDF path (which renders from its own temp
  HTML). Applies to markdown `![...]()` images and to author-written `<img>`
  tags (common in specs for `width=`).
  - Covers `src` **and** `srcset` (a browser prefers `srcset`, so leaving it
    relative breaks the image even when `src` is inlined), on `<img>` and on
    `<source>` inside `<picture>`.
  - Remote (`http(s)://`, protocol-relative) and pre-baked `data:` srcs pass
    through untouched. Only known URL schemes count as remote, so a filename
    containing `:` stays a local file.
  - Percent-encoded names (`my%20pic.png`), `./`-prefixed and absolute paths all
    resolve. A `?query` is dropped; an SVG `#fragment` is kept on the data URI.
  - Only known image extensions are inlined — `![x](../../id_rsa)` is left
    alone and warned about rather than base64'd into a document meant to be
    shared. An `<img>` inside an HTML comment is skipped for the same reason.
  - A reference with no file on disk keeps its original src and warns on stderr
    (`[WARN] image not found, left as-is: ...`) instead of failing the render.
  - Inlining an image larger than 4 MB warns on stderr; the render still
    succeeds.
  - `alt` / `title` keep marked's own escaping — no `&amp;amp;` double-escape —
    and any image that is *not* inlined renders through marked's stock
    `image()` renderer, byte-identical to before.

### Note

Each reference carries its own copy of the payload, so a document that shows the
same 1 MB diagram three times grows by ~4 MB. That is base64's floor for a
self-contained file; the PDF output is unaffected (Chromium dedupes on decode).

## v2.4.0 — 2026-06-28

### Added

- **KaTeX math rendering.** ` ```math ` fenced blocks, `$$…$$` display math and
  `$…$` inline math now render as typeset math via server-side KaTeX
  (`katex.renderToString` + `marked-katex-extension`). Rendering is fully offline
  and self-contained: the KaTeX stylesheet is inlined with all woff2 fonts
  base64-embedded, so a math-bearing HTML displays and prints (including the
  puppeteer PDF path) with no network. The math stylesheet is injected only when
  a document actually contains math, so math-free output stays byte-identical.
  Unsupported expressions degrade to red error text (`throwOnError: false`)
  instead of crashing the render.

### Changed

- **TOC items are now single-line.** Long headings no longer wrap; they are
  clipped with an ellipsis (full text on hover via `title=`, and always visible
  in the new breadcrumb). The TOC left edge stays anchored while the document
  scrolls — it never auto-scrolls horizontally. Row spacing was tightened.
- **Sticky breadcrumb replaces the static `Contents` header.** The sidebar header
  now shows the ancestor heading chain of the current scroll position (VSCode
  sticky-scroll style), stacked and clickable, updating as you scroll. The
  expand / collapse controls moved to their own row above it.

## v2.2.0 — 2026-06-11

### Fixed

- `~` / `^` operators inside code are no longer mangled into `<sub>` / `<sup>`.
  Subscript (`~x~`) and superscript (`^x^`) were applied by a raw-text pre-pass
  that ran before the markdown was tokenised, so `~NOT` / `^XOR` operators in
  fenced, indented and inline code got rewritten — e.g. a `PAD = ~abort & ~fcs`
  code block rendered as `<sub>abort & </sub>fcs` (96 such mangles in one RTL
  spec). Subscript / superscript are now code-aware `marked` inline extensions:
  they never fire inside code, and the tokenizer requires a single
  whitespace-free token (`~x~` / `^x^`), so spaced operator expressions
  (`~a & ~b`, `a ^ b`) and lone operators (`2^24`, `~rst`) stay literal even in
  prose. Genuine subscripts such as `SMD-S~0..3~` still render.

### Tests

- Added `test/code-operator.test.js` (operators-in-code regression) to the
  `npm test` suite.

## v2.1.1 — 2026-06-11

### Fixed

- Mermaid source is now HTML-escaped inside the `.mermaid` div. Raw injection
  let the HTML parser consume entities and tags before mermaid ran — an
  author's `&lt;IP&gt;` became an `<IP>` element that mermaid sanitized away,
  silently dropping label text. Escaping restores GitHub-equivalent semantics
  (`&lt;IP&gt;` displays as `<IP>`, literal `<br/>` still line-breaks).
- CDN fallback bumped from `mermaid@10` to `mermaid@11`. v10 scrambles
  `flowchart` layout when a subgraph with `direction` has edges crossing its
  boundary; v11 lays the same source out top-down like GitHub.

## v2.1.0 — 2026-06-11

### Added

- `--out` extension now selects the output format when no `--html`/`--pdf` flag
  is given: `md2doc foo.md --out report.pdf` renders a PDF instead of erroring.
  Explicit flags still win, and a flag that contradicts the `--out` extension
  still exits 2. Directory targets (trailing `/` or an existing directory —
  even one named like `foo.pdf`) keep the HTML default.

### Fixed

- Uppercase `.PDF` output paths no longer lose the rendered file. The temp-HTML
  path was derived with a case-sensitive `.pdf` replace, so for `--out X.PDF`
  the temp file aliased the destination and the post-render cleanup deleted the
  freshly written PDF while still reporting success.

### Changed

- Failure modes shifted for two previously rejected invocations: flag-less
  `--out *.pdf` now succeeds (and overwrites an existing file, as explicit
  `--pdf` always did), and in environments without puppeteer it now fails at
  render time with exit 1 instead of failing argument validation with exit 2.
- The mismatch / ambiguous-`--out` error messages now mention the inference
  rule, and the both-formats message now suggests `--out <dir>/` (key
  substrings unchanged in all three).
- An `--out` whose basename is just `.html`/`.pdf` (extension only, no stem) is
  now rejected as ambiguous at argument time instead of failing late in the
  renderer with a contradictory message.

## v2.0.1 — 2026-05-23

### Fixed

- Long snake_case identifiers in headings (h1–h6) and `<dt>`/`<dd>` no longer
  overflow the viewport. The prose-only `overflow-wrap` rule introduced in
  v1.1.0 left headings uncovered; this extends it to headings and definition
  lists while preserving the table-cell `overflow-wrap: normal` override.

## v2.0.0 — 2026-05-22

### Breaking changes

- **Removed** `md2html` and `md2pdf` binaries. Use `md2doc` instead.
  - `md2html foo.md` → `md2doc foo.md`
  - `md2pdf foo.md`  → `md2doc --pdf foo.md`
- **Removed** default output next to the source markdown.
  - Default output now writes to `<os-tmpdir>/md2doc/<stem>-<hash>.<format>`.
  - Pass `--out <path>` to write somewhere specific.
- **Changed** `--open` to default ON when `--out` is absent.
  - Pass `--no-open` to opt out.
  - Passing `--out` automatically disables auto-open (override with `--open`).

### Added

- Unified `md2doc` CLI with `--html` / `--pdf` flag selection.
- Both formats in one invocation: `md2doc --html --pdf foo.md`.
- `--out` directory mode (`--out ./build/`) for batch output with stable filenames.
- `--no-open` flag for explicit opt-out of viewer launch.
- `test/cli.test.js` covering the full CLI surface.

### Internal

- `lib/md2doc.js` rendering pipeline unchanged. The new binary is a thin
  orchestrator: arg parse → output path resolution → spawn `lib/md2doc.js` per
  `(input, format)` → optional viewer launch.

## v1.1.2 and earlier

See git history.
