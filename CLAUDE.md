# md2doc — Contributor Notes

## Repo Layout

Single-file renderer. Everything lives in `lib/md2doc.js`:

| Region | Purpose | Approx range |
|---|---|---|
| Top | Inline-script tag discovery (WaveDrom / Mermaid local-or-CDN) | lines 30–100 |
| `marked` block | Custom renderer (`code` / `heading` / `image` / `html` / `paragraph` / `listitem` / `blockquote` / `table`) + TOC builder + section index | lines 108–375 |
| Asset inlining | `SRC_DIR` + `inlineImageSrc` / `inlineImagesInHtmlChunk` — local image srcs resolved against the **source markdown** and base64-inlined as `data:` URIs | just above `let bodyHtml` |
| `<style>` block | Embedded CSS for HTML output | lines 380–820 |
| `<script>` reader runtime | Search / scroll-sync / TOC collapse / sidebar drawer / zoom-resize scroll anchoring / diagram lightbox | lines 850–1300 |
| Output dispatch | `.html` write or puppeteer-driven `.pdf` export | lines 1300–end |

CLI entry point: `bin/md2doc.js`. Shells out to `lib/md2doc.js` once per `(input, format)` pair.

Tests live in `test/` — `md2doc.test.js` (renderer), `images.test.js` (image assets), `scroll-anchor.test.js` (zoom/resize reading position), `lightbox.test.js` (diagram popup), `cli.test.js`, `code-operator.test.js`; mostly regex assertions against rendered HTML. Run with `npm test`; a new file must be added to the `test` script in `package.json`.

## Release Flow

This repo is **auto-published to npm on tag push** via `.github/workflows/publish.yml` (trigger: `v*.*.*` tag). Workflow:

```bash
# from a clean main with the feature already merged:
npm version <major|minor|patch> -m "chore: release v%s"   # bumps package.json + package-lock.json, commits, annotated-tags vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

After tag push, the npm registry updates in ~1–2 minutes.

**Do NOT run `npm publish` manually.** The auto-publish handles it. Manual publish risks racing the GitHub Action or publishing an out-of-sync build.

**Verify locally** with `npm install -g @helping-ai-workflow/md2doc@latest && md2doc --version`.

Feature branches that aren't ready to ship: just push the branch (no tag). Tag only after merge to main.

## When Touching `renderer.table`

The custom table renderer emits `<colgroup>` + per-cell `class="cell-narrow|cell-prose"` based on a content heuristic (`classifyColumns` in `lib/md2doc.js`). Two non-obvious rules:

1. `unbreakableRun` regex omits `_` — snake_case identifiers like `pmac_tx_tvalidchk` would otherwise be classified as one 17-char unbreakable token and never reach the ≤ 12 narrow threshold. `_` is treated as a break point for classification only; CSS `white-space: nowrap` on `<td><code>` still keeps the rendered token whole.
2. The heuristic uses **data rows only** for `hasWhitespace` / `maxTokenLen` / `avgCellLen`. Headers like "Clock Domain" contain whitespace but are not representative of cell content. Header is used as fallback only when the column has no data rows.

If you change either rule, re-run `npm test` and visually re-check `mac_merge_tx_spec.md` rendered output — that's the realistic stress test for the heuristic.

## Lightbox Zoom — Do NOT Use `transform: scale()`

`.lightbox-canvas` is resized in px (`width = naturalWidth * zoom`) and its child is
`width: 100%; height: auto`. That is deliberate: a CSS transform scales the painted
pixels but leaves the scroll extent at the pre-zoom size, so the enlarged edges become
unreachable — which defeats the whole point of the overlay. `test/lightbox.test.js`
asserts `stage.scrollWidth > stage.clientWidth` after zooming, and a transform-based
rewrite fails it.

`.lightbox-stage` needs `position: relative`: it must be the canvas's `offsetParent`
for the cursor-anchored zoom maths.

## CSS Cascade — Read Before Editing

`.content { min-width: 0; flex: 1 1 auto; }` is the flex base for the content column; **do not** add `overflow-wrap` / `word-break` here — those are prose-only and live on `.content p, .content li, .content blockquote`. There's a test guard asserting this; if you regress it the suite will fail.

Sticky first column uses `position: sticky; left: 0; background: #ffffff` on `tbody td:first-child` + `thead th:first-child`. Zebra-stripe and header overrides are kept in source-order to win cascade. Don't reorder them.

## Editor Client — Guarded Retired-Name Substrings

`test/editor-client.test.js` asserts `lib/editor/client.js` contains none of a list of bare substrings naming retired editor-bar internals (`ed-bar`, `attachGutters`, `dismissBar`, etc., matched with plain `includes`, not word boundaries) — ordinary prose can trip it (a comment mentioning "fixed-bar" once reddened the whole suite via `ed-bar`), so grep that guarded list before committing a new comment into `client.js`.

## The Two Long Puppeteer Suites — No Per-Scenario `try`/`catch`

`test/editor-client-runtime.test.js` and `test/editor-journey.test.js` run every
scenario in one unguarded sequence. **The first throw ends the run**, so every
scenario after it is silently not executed — the log just stops. Two consequences
that cost this repo 20 minutes a pop, twice in one batch:

1. **A `TimeoutError` returns zero information.** Never use a bare
   `waitForFunction` to wait for a value you can predict. Use
   `act → settle → grace → read the actual value → assert.strictEqual(...)`, so a
   wrong guess prints the real value instead of `Timeout 30000ms exceeded`.
2. **"The test exists" is not "the test ran."** A v3.4.0 data-correctness bug
   (a table row drag re-pointing the caret at the wrong cell, so every subsequent
   keystroke lands in the wrong cell) sat undetected because scenario 1 always
   threw first and scenario 2 was never reached. When you add a scenario, confirm
   it actually appears in the `OK` output — an unreached scenario reads exactly
   like a passing one.

Reading a red run: a failure carrying **0 `AssertionError`** plus
`TargetCloseError` / `Navigating frame was detached` / `Protocol error` is
infrastructure (the browser was reaped), not a product defect — rerun. A
`TimeoutError` landing on a **newly written fixture** is usually real; one landing
on a **pre-existing helper the diff never touched** is usually flake. Either way,
rerun until green — never interpret a red run you have not reproduced.

## Changing a Count, a Roster, or a Pinned Measurement

Before you change any "number of X" — button counts, enabled-button tallies,
`scrollWidth` values in comments — grep the whole repo for that literal first.
Adding one toolbar button in v3.4.0 hit four test files, and one of the hits was
not the literal at all but a completeness assertion over the button-id set
(`TB_ROWS` in `editor-journey.test.js`).

Two rules that fall out of it:

- **Present-tense descriptions migrate; historical measurement narratives do
  not.** A comment saying "owns the 22-button roster" is a claim about today and
  must become 23. A comment saying "v3.2.1 measured 7/22 disabled" is a record of
  a measurement — editing the number fabricates data that was never measured.
- **Re-measure, don't recompute.** When a change invalidates a `MEASURED` comment,
  take the measurement again. A v3.4.0 gap tweak looked like it only moved one
  pinned number from 555 to 522; re-measuring showed the *other* number in the
  same sentence was already wrong (75, actually 42). This repo makes real
  decisions from `MEASURED` comments, so a stale one is expensive.

## Do NOT Stage

- `docs/superpowers/specs/`, `docs/superpowers/plans/` — local working state from brainstorming / writing-plans skills. Not for the repo (already in `.gitignore`? — if not, the rule still stands).
- `*.html` files generated by `md2doc foo.md` for testing — output, not source.
- `node_modules/`, `.cache/puppeteer/`, etc. (covered by `.gitignore`).
