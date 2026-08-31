# Changelog

All notable changes to this project will be documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## v2.12.0 — 2026-08-31

### Added

- **Blocks can be selected as a set, and one gesture then acts on all of them.**
  Press inside a block and drag past its edge, or Shift+Click a second block: every
  block in between takes a semi-transparent blue wash with its text still readable
  underneath. Shift+↑ / ↓ then grows and shrinks the set a block at a time, and Esc
  clears it. With a set standing, the ⠿ menu's `轉換成`, `建立副本` and `刪除` act on
  the whole set, and so do Tab, Shift+Tab, Delete and Backspace. Each of them is a
  single Ctrl+Z, however many blocks it touched — including selecting the whole
  document and pressing Delete, which empties it and takes one Ctrl+Z to bring back.
- **Tab over a selection keeps the blocks' relationship to each other.** The whole
  set moves by one shared step, measured from its shallowest item, so three
  selected siblings stay siblings instead of folding into one another — and a set
  that cannot move as a whole does not move at all rather than half-moving. On
  headings the same key steps every heading in the set a level down or up, stopping
  at 標題 1 and 標題 6.
- **The selection stays put across the redraw its own operation causes.** After a
  batch convert, duplicate or indent the set lands on the lines the operation
  produced, the keyboard still works without touching the mouse, and the page does
  not jump. An undo or redo clears it, so you are never left with a highlight over
  a document that has changed underneath it.
- **A batch that cannot be done says so instead of doing nothing.** Selections that
  mix list items with other blocks, that skip a block in the middle, that span two
  separate lists, or that cover a list already frozen read-only are refused with a
  message on screen, and not one byte of the file is written. `轉換成` over a
  selection that contains a **table** is refused the same way: a table's own ⠿ has
  never offered `轉換成` — no target can carry its cells — and a set the table
  happens to be part of does not change that. Duplicating, deleting or indenting a
  selection containing a table is unaffected.
- **`MD 原始碼` is withheld while several blocks are selected.** It rewrites one
  block's source lines, so over a set it would silently answer for the block the ⠿
  was pressed on and ignore the rest. A set of exactly one block, or a set standing
  elsewhere in the document, still offers it.
- **Every ⠿ menu item now leads with an icon** — a turning arrow for `轉換成 ›`,
  two offset cards for `建立副本`, a bin for `刪除`, angle brackets for `MD 原始碼`.
  They are drawn in the item's own colour, so they follow the menu rather than
  being pinned to one theme.
- **`轉換成 ›` opens its submenu on hover**, without a click. Moving diagonally
  towards a target further down the panel keeps it open the whole way, including
  across the few pixels of gap between the item and the panel; settling on another
  item closes it. A click still toggles it, as before.

### Fixed

- **Esc with the ⠿ menu open threw away what you had just typed.** The menu's own
  Esc handler was unreachable while any edit surface held focus — which is always,
  because the menu deliberately keeps focus where it was — so the key fell through
  to the editor and reverted the block instead, leaving the menu on screen. Esc now
  resolves the thing nearest the front: a table drag, then a menu, then a block
  selection, and only then the block being edited.
- **Ctrl+S followed by Ctrl+Z did nothing.** Saving an untouched block leaves it
  focused with no edit in progress, and in that state the undo key was captured by
  the block and then discarded. Undo and redo now reach the document whenever there
  is no edit in progress to own them.

## v2.11.1 — 2026-08-31

### Fixed

- **Tab no longer walks out of the document.** Pressing Tab or Shift+Tab moved the
  browser's own focus ring onto a gutter `＋` or `⠿` button — the caret left the
  block and the next keystroke went nowhere. Two independent causes: a surface that
  is still focused and still armed after Ctrl+S has no open burst, and the key
  handler bailed out of the whole document handler with it; and after a commit,
  an Escape, a Ctrl+Z, or a click on a bullet marker nothing is focused at all, and
  there was no Tab branch for that case anywhere. Tab is now consumed in both
  states, and the two gutter buttons — mouse-only affordances that had become
  sequential focus stops simply by being `<button>`s — are out of the tab order.
  Every Tab that already worked still works: indent, outdent, the clamp's no-ops,
  a run-wide refusal, a hard-wrapped item, and type-then-Tab.
- **The `⠿` sits closer to the block, and the gutter no longer has a dead band.**
  The `＋`/`⠿` pair now occupies the geometry the design spec always specified
  (`[blockLeft−40, blockLeft−4]` instead of `[blockLeft−54, blockLeft−18]`). More
  importantly the gutter is now one continuous hover zone: moving the pointer out
  of the text towards the `⠿` used to cross 18px that belonged to neither the block
  nor a button, so both buttons faded out under the cursor on the way to them
  (measured: opacity 0 for ~270 ms of a real pointer travel). The same fix closes
  two related holes — the bottom ~5px of every list row, and the whole vertical
  middle of a multi-line heading, neither of which could reach a button at all.
- **Enter then Tab on the new empty list item no longer destroys the item above
  it.** An empty item is written as a bare `-`, and directly under its parent's own
  text that line is not a list marker at all: CommonMark reads a line of nothing
  but dashes at an open paragraph's column as a setext heading underline. Pressing
  Enter and then Tab on `- beta` therefore saved `- beta` followed by `  -`, which
  reads back as `<li><h2>beta</h2></li>` — the new item gone and the parent
  re-typed as a heading, from two ordinary keystrokes. Only that one position is affected and
  only that one position changes: an empty item nested as the first child of a
  deeper level now carries a zero-width space, which is content to the parser and
  invisible to the reader, and is removed again on the way back in so it never
  becomes part of what the user types.

### Changed

- The `⠿` menu's duplicate item is now labelled `建立副本` (Notion's own
  Traditional Chinese term), matching `轉換成` and `刪除`.

## v2.11.0 — 2026-08-30

### Added

- **Any block can now be turned into any other block type.** The ⠿ handle opens a
  vertical menu whose `轉換成 ›` submenu carries all twelve types — 文字,
  標題 1 through 標題 6, 項目符號列表, 編號列表, 待辦清單, 程式碼, 引用 — and every
  block type can reach every one of them: a paragraph becomes a heading, a code
  block becomes a bulleted list, a list item becomes a quote, and back again. The
  block's text is moved across verbatim rather than re-generated, so characters
  markdown would otherwise escape (`~5px`, `snake_case`) come through a conversion
  unchanged, and the whole thing is a single Ctrl+Z.
- **`複製` duplicates a block.** For a list item the copy is inserted after the
  item's entire subtree, so the original keeps its children, and the copy carries
  the item's type, indent and checkbox state. Ordered lists renumber themselves
  around it. One undo, like every other gesture.
- **The `＋` button works on list items.** It used to be hidden on them, so a list
  was the one place in the document you could not insert from. A new item inherits
  the anchor's list type and indent and lands after the anchor's whole subtree, so
  inserting under a parent no longer breaks its children off.
- **List items get the same gutter as every other block.** Edit mode now draws each
  item as its own full-width row with the ⠿ and ＋ on one vertical axis at every
  nesting depth, instead of nested list markup in which a deep item had no handle
  at all. A table block is the one block with no `轉換成` — there is no type that
  could carry its cells.
- **Tab and Shift+Tab do the indenting.** Inside a list they indent and outdent the
  item (children stay where they are and become siblings); on a heading they step
  the level down and up. The `−` / `+` buttons the old menu carried for heading
  level are gone, and so is its `✕` — the menu closes on Esc or a click outside.
- **Task lists and ordered lists are independent.** `1. [ ] a` round-trips as an
  ordered task item instead of losing one of the two, and a mixed run
  (`1. plain / 2. [ ] task / 3. plain`) stays a single list with continuous
  numbering.

### Fixed

- **A conversion can no longer freeze a list read-only.** Turning a block into a
  list next to an existing list of the same type left the blank line between them
  standing, and markdown does not read that blank as a separator — it reads it as
  an instruction to make the combined list *loose*. Every item then rendered as a
  paragraph, and from that moment every structural edit anywhere in that list was
  refused, with no message saying why. The separator is now absorbed so the run
  stays tight and editable. The opposite direction is handled with it: converting
  an item out of a list puts blank lines back where they are needed, including at
  the run's outer edges, where the converted text would otherwise be swallowed
  back into the item above it.
- **A menu gesture is no longer dropped when the block has unsaved edits.** Typing
  in a block and then pressing ⠿ or ＋ without clicking away first answered
  「文件已更新，請重試這個操作」 and did nothing — on all four of 轉換成, 複製,
  刪除 and ＋. The editor was committing your typing first and then failing to
  recognise the very block it had just rewritten. The gesture now lands on top of
  your own edit.
- **A conversion refuses out loud instead of guessing.** An indented (unfenced)
  code block, a list item spanning more than one line, and a list that already
  contains something the editor cannot represent each show a banner and change
  nothing, rather than producing a plausible-looking block with content silently
  dropped. Converting to 程式碼 also lengthens the fence when the text itself
  contains one, so a code sample that carries a fence of its own no longer breaks
  out of the block it was just converted into.
- **Deleting a list item deletes the list item.** The ⠿ menu's 刪除 used to splice
  out the block's line range: on a paragraph followed by a three-item numbered
  list it removed the paragraph and all three items; it left a child indented under
  nothing, which markdown then reads as a code block; and it left the surviving
  items carrying their old numbers on disk while the screen showed the new ones.
- **A line you did not touch is never rewritten.** Editing one item of a list used
  to re-generate the whole list, which put backslashes in front of `~` and `_` in
  the items around it. Untouched lines now keep their own bytes, and a hard line
  break (two trailing spaces) survives an edit of its own block.
- **A failed commit no longer rolls back somebody else's edit,** and a block that
  owns no source line of its own refuses to be deleted or raw-edited instead of
  quietly removing a blank line belonging to a different block.
- **A wide ordinal stays in its own column.** `10.` no longer pushes its row's text
  out of alignment with the rest of the list, and a marker that outgrows its column
  overflows into the gutter rather than onto its own text.
- **The table row grip is back on the table's border line, and every row uses the
  same rule.** v2.10.1 moved it fully inside the table's left edge, where a 20px
  grip sat on top of the first cell's 14px padding and bit ~5px into the cell's
  text; the header row additionally carried a downward offset that no other row
  had. Both are gone: every row's grip — header included — is centred on the
  table's left border, exactly mirroring how the column grip is centred on the
  top border. The grip now clears the first cell's text by 4.5px at the default
  layout.
- **The block gutter has its own room instead of borrowing the sidebar's.** In
  edit mode the content column now carries 48px of left padding and the ⠿ / ＋
  buttons live inside it, 8px clear of the row grip. Previously the gutter hung
  outside the content box on top of the sidebar splitter, and the 6px overlap it
  created with the row grip was what motivated v2.10.1's inset in the first
  place — the overlap is now impossible by geometry rather than avoided by a
  special case. Reader and PDF output are unaffected: the padding is emitted only
  for edit-mode renders.

## v2.10.1 — 2026-08-28

### Added

- **The table header row now has a drag grip too.** Every row — header included —
  shows a 6-dot grip at its left edge, and dragging any row to the top makes it
  the header (the old header becomes a data row). It is a **pure move**: the same
  cell nodes are re-laid across `<thead>`/`<tbody>`, so nothing is re-serialized
  and per-column alignment follows its column.
- **Columns can be dragged to reorder.** The column grip now drags as well as
  opening its menu; `<colgroup>` is kept in sync so column widths do not shift
  out from under the move, and alignment travels with the column.

### Fixed

- **Saving no longer rewrites a whole file's line endings.** The file's one EOL is
  now picked by majority vote when the document loads, instead of "any CRLF
  anywhere wins" — a 10,000-line LF file with one stray CRLF line used to get all
  10,000 lines rewritten on the next save. Saving still joins the whole file with
  that single detected EOL (`lines` is kept `\r`-free throughout; only `/api/save`
  re-attaches it — spec §3.11); the vote is what keeps the rewrite down to the
  minority lines instead of all of them.
- **Clicking the header grip no longer opens an inapplicable menu.** The row
  menu's only item is "delete row" and a header can never be deleted, so the
  header grip now just highlights the row instead. Two things were fixed
  alongside it: the highlight is painted on the row's **cells**, not on the
  `<tr>` — every `<th>` (and the sticky first column's `<td>`) paints its own
  opaque background on top of the row box, so a row-level highlight was
  literally zero pixels of change; and with that highlight showing and no menu
  open, `Esc` used to fall through to the focused cell's own Escape branch and
  revert the whole table burst, discarding everything typed into it.
- **A table gesture can no longer rewrite a DIFFERENT table.** Every table
  structure op (insert, delete, align, row drag, column drag) first commits
  whatever editor is open elsewhere, and that commit re-renders the document —
  which renumbers every block id. The op then re-resolved "its" table by the id
  it had captured *before* the commit, so a commit that added a block above
  (splitting a paragraph in the MD 原始碼 editor, say) made that id name the
  neighbouring table, and the gesture landed there: columns reordered, or a
  data row promoted to header, in a table the user never touched. The table is
  now re-resolved by its start line and checked against the identity captured
  before the commit; a gesture that cannot be matched back is dropped instead.
- **A refused delete no longer canonically rewrites the table.** "刪除列 /
  刪除欄" on the last row/column shows a banner and deletes nothing — but the
  selection highlight it left standing had already been baked into the burst's
  "nothing changed yet" baseline, so the next click elsewhere (which strips the
  highlight) registered as an edit and re-serialized the whole table into its
  minimal form. Hand padding and hand-written alignment vanished from a table
  the user had only clicked on. That baseline now ignores selection chrome
  entirely.
- **A drag can no longer emit a headerless or ragged table.** A column move now
  abandons the whole operation if any row is too short, instead of skipping that
  row and reordering the rest — which left the columns misaligned while every row
  still had its original cell count, so the ragged-table guard could not see it.

### Known behaviours

- After a row or column reorder the caret lands on the same cell **ordinal**
  rather than following the cell that moved.
- The leftmost ~20px of the first column is covered by the row grip (it sits just
  **inside** the table's left border, because the space outside belongs to the
  block's own ⠿ handle), so a click in that strip does not place the caret.

## v2.10.0 — 2026-08-27

The Phase 3 editor work below shipped across v2.9.0 and v2.10.0; both of those
releases went out with it still sitting under `## Unreleased`, so neither tag's
changelog mentioned it. Recorded here after the fact.

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
