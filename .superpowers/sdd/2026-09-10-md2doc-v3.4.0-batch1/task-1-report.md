# Task 1 report: heading 文字的雙重跳脫

**Status:** DONE_WITH_CONCERNS
**Commit:** `5c93d77` on `feat/v3.4.0-batch1`

## What was done

Implemented brief steps 1–7 as written:

1. Added the red test to `test/md2doc.test.js` (adapted to this file's actual
   style — spawnSync + tmpDir fixture files, no `renderToHtml` helper exists
   in this file, unlike the brief's snippet assumed).
2. Confirmed red pre-fix: `#alpha-amp-beta`, `#c-lt-d-gt-e`.
3. Added `unescapeHtml()` next to `escapeHtml()` (line ~704), exact inverse,
   `&amp;` decoded last.
4. Changed `flattenTokenText()`'s `codespan` branch and fallthrough branch to
   return `unescapeHtml(item.text || '')`, plus the contract comment.
5–6. Re-ran `test/md2doc.test.js` and the four named quick tests
   (`docsource`, `roundtrip`, `render-api`, `editmode-render`) — all green.
7. Committed `lib/md2doc.js` + `test/md2doc.test.js`.

## Deviation from the brief (why DONE_WITH_CONCERNS, not DONE)

After implementing exactly steps 3–4, the test was **still red** — not on the
`Alpha & Beta` assertions, but on the `## C < D > E` fixture: the slug came
back `#c-e` (silently dropping "D"), not the brief's expected `#c-d-e`.

Root cause: `marked.lexer('## C < D > E')` tokenizes the whole heading as a
single `text` token (`text: "C &lt; D &gt; E"`) — there is no separate
`html`-type token for `< D >` (marked's inline-html tokenizer requires a
letter immediately after `<`, and `< D >` has a space). Before this task's
fix, `flattenTokenText()` returned that string still escaped, so
`stripHtmlTags()`'s regex `/<[^>]*>/g` never saw a literal `<` and did
nothing. After unescaping, the literal string `"C < D > E"` reaches
`stripHtmlTags()`, whose regex cannot distinguish "real HTML tag" from
"literal text that happens to look like one" — it strips `< D >` wholesale,
including "D".

This isn't a hypothetical edge case introduced by extending scope — it's the
exact fixture the brief itself specifies for the acceptance test. Per code
evidence, brief steps 3–4 alone are insufficient to make the brief's own test
green.

**Fix applied (beyond the brief's literal 2-branch instruction):** tightened
`stripHtmlTags()`'s regex from `/<[^>]*>/g` to `/<\/?[a-zA-Z][^<>]*>/g` —
require a letter (optionally after `/`) immediately after `<`, matching how
real HTML tags are actually shaped. Verified:
- `<x>` (genuine inline html token, per the brief's own background example)
  still strips correctly.
- `< D >` (literal prose that merely looks like a tag) is now left alone.
- ~~No existing test in the repo exercises `stripHtmlTags` with HTML comments
  or other edge shapes that this tightening would change~~ **[Corrected in
  fix round 1 below — this grep only proved absence of test coverage, not
  absence of a bug; a real HTML-comment fixture through the actual renderer
  exposed a real regression that the grep couldn't see.]** Grepped
  `test/*.test.js` for `<!--` — the 3 hits are unrelated (raw markdown
  source fixtures, an image-comment-passthrough test) and none go through
  `stripHtmlTags`; that only means no existing test would have caught a
  regression here, not that the regex change was safe.

This function is shared by three call sites (`appendSectionText` at line
~528, `slugifyHeading` at line ~677, and `renderer.heading`'s `headingText`
at line ~801) — all three were equally exposed to the same false-positive
risk once `flattenTokenText()` started unescaping, so fixing the shared
regex (rather than patching each call site or adding special-casing in
`flattenTokenText()` for `html`-type tokens) is the minimal, root-cause fix
that doesn't leave the other two call sites silently broken.

## Cross-axis note (flagged, not fixed — out of scope for Task 1)

`appendSectionText()` (search/section-index text, fed from paragraphs, list
items, blockquotes, table cells — not just headings) shares the exact same
`flattenTokenText()` → `stripHtmlTags()` pipeline. Before this task, any
literal `< word >`-shaped prose in body text was already latent-immune (text
tokens stayed escaped). This task's core fix (unescaping) would have opened
the identical "eats literal look-alike text" hole there too, had the
`stripHtmlTags()` regex tightening not been shared code. Because the fix
*is* shared, this surface is already covered — no separate action needed,
but flagging it since it's a consumer outside Task 1's declared scope
("heading 文字的雙重跳脫") that benefited from the same line.

## Test summary

- `node test/md2doc.test.js` → EXIT=0 (all 9 sub-tests pass, including 2
  new assertions blocks: original heading suite + the new double-escape
  block)
- `node test/docsource.test.js` → EXIT=0
- `node test/roundtrip.test.js` → EXIT=0
- `node test/render-api.test.js` → EXIT=0
- `node test/editmode-render.test.js` → EXIT=0
- Grepped all `test/*.test.js` for `reader-section-data|searchTextParts|startSection|flattenTokenText`
  — only `md2doc.test.js` touches this path; no other fast test exercises
  the changed code.

## Anchor-breaking change (as the brief's own commit message documents)

`#alpha-amp-beta` → `#alpha-beta`, `#c-lt-d-gt-e` → `#c-d-e`. Any external
links to old entity-named slugs break. This is the defect's own output being
corrected, not a new compatibility concern — documented in the commit body
per the brief's prescribed message.

---

## Fix round 1 (review finding, Important)

**Finding:** the letter-after-`<` regex tightening (`/<\/?[a-zA-Z][^<>]*>/g`)
stopped `stripHtmlTags()` from stripping HTML comments — `<!--` starts with
`!`, not a letter. `## Section <!-- note --> Title` regressed
`#section-title` → `#section-note-title`: the comment's contents leaked into
the permalink. Silent — no error, no existing test caught it.

**Measurement (coordinator required this before picking a fix):** does
`stripHtmlTags()` only ever receive text that already went through
`flattenTokenText()`? Checked every call site:

- `appendSectionText()` is called from `collectCellText()` two ways: line
  540 `appendSectionText(flattenTokenText(cell.tokens))` (tokenized) **and**
  line 542 `appendSectionText(cell.text)` — a direct, non-tokenized fallback
  used when a table cell has no `.tokens` array. This second path bypasses
  `flattenTokenText()` entirely.
- `renderer.heading`'s `headingText` (line ~801) is
  `flattenTokenText(token.tokens) || token.text || ''` — the `token.text`
  fallback (raw marked heading text, fires when `flattenTokenText()` returns
  `''`) also bypasses `flattenTokenText()`'s per-token-type branches.
- `slugifyHeading()` is only ever called with that same `headingText`, so it
  inherits both the tokenized path and the `token.text` fallback.

**Answer: no** — at least two real paths (`cell.text` fallback,
`token.text` fallback) hand `stripHtmlTags()` raw, non-tokenized text that
can contain genuine HTML markup never touched by
`flattenTokenText()`'s `item.type` branches.

**Decision: regex fallback (Option B), not the structural fix.** The
reviewer-proposed structural fix — strip tags only inside
`flattenTokenText()`'s `item.type === 'html'` branch, run zero tag-stripping
on the text/codespan branches, and (implicitly) stop calling
`stripHtmlTags()` on `flattenTokenText()`'s output at the call sites — can't
be a full replacement given the measurement above: the `cell.text` and
`token.text` fallback paths never go through `flattenTokenText()` at all, so
moving all tag-detection into its `html` branch would leave those two paths
with **zero** tag-stripping — real embedded HTML in an untokenized table
cell, or in a heading whose tokens happen to flatten to `''`, would then
leak straight through unstripped. That's a regression in its own right, not
a smaller version of the current bug. Making the structural approach fully
correct would require pushing tag-detection out to each of those two
call-site branches individually (so `collectCellText()`'s `cell.text`
branch and the heading's `token.text` fallback each run their own
tag-stripping before calling `appendSectionText`/using `headingText`) —
more call sites touched, more places to get right, for no correctness gain
over a single shared, correct regex. Went with the fallback: added a
`<!--[\s\S]*?-->` alternative to `stripHtmlTags()`'s regex, applied uniformly
at all three call sites as before. Documented the known remaining gap in a
code comment: `<!DOCTYPE ...>` and `<? ... ?>` share the same
non-letter-after-`<` shape and are still unstripped — no real fixture has
hit this yet, so it wasn't added speculatively.

**Test:** added the reviewer's exact fixture (`## Section <!-- note -->
Title` → expect `href="#section-title"`) to `test/md2doc.test.js`, right
after the existing double-escape block. Confirmed red pre-fix
(`href="#section-note-title"`, matching the reviewer's measured value
exactly), confirmed green post-fix.

**Status:** DONE
**Commit:** `808af13` on `feat/v3.4.0-batch1`

**Tests run this round:**
- `node test/md2doc.test.js` → EXIT=0 (10 sub-tests, including the new
  html-comment-slug block)
- `node test/docsource.test.js` → EXIT=0
- `node test/roundtrip.test.js` → EXIT=0
- `node test/render-api.test.js` → EXIT=0
- `node test/editmode-render.test.js` → EXIT=0
