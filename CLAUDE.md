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

**But do not count occurrences in `client.js` with `grep`.** The file carries a
literal NUL byte — `const DRAWIO_FP_SEP = '\u0000';`, line 16666, offset 966233 —
so GNU grep (3.11, measured) classifies it as binary and *prints
`binary file matches` instead of the matches*. The failure is silent when you
pipe: `grep -o waveEditBtn lib/editor/client.js | wc -l` reports **0**, the same
answer as "not present"; `grep -ao …| wc -l` and node's `String.indexOf` both
report **16**. A plain `grep -n` for a pattern that matches line 16666 prints
nothing either. `grep -c` happens to be unaffected (it counts *lines*, not
occurrences), which is why this hides for so long.

So: for any count or absence check in `client.js`, use `String.indexOf` in node
(what the guard test itself uses) or `grep -a`. A count taken with `grep -o`
reads as a clean guard — which is exactly the direction that lets a retired name
ship.

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

**A third category the two rules above will misclassify: the run that read a
tree nobody ever committed.** `npm test` opens each suite's files when that
suite starts, ~20 suites in, so a long run that overlaps an agent writing to the
same working tree executes a mixture of revisions. That red carries real
`AssertionError`s — so the rule above calls it a product defect — and it is not
one; it is unattributable, and chasing it costs a full run plus the diagnosis.
It happened once here (v3.4.0 batch 3): the failure message quoted a string that
`git grep` finds **zero** times at the revision the run started from, zero at the
revision that landed mid-run, and zero at HEAD. It only ever existed on disk,
uncommitted.

So: **never start a long suite while anything else is editing the same tree**, and
before believing any long-run failure, `git grep` a distinctive string from its
message against the revision the run started from. Zero hits means the run is
void — rerun on a clean tree (`git status` empty) and do not attribute it. A
separate worktree is the way to run and edit at once.

## Never Infer a Hit From `getBoundingClientRect()`

The browser dispatches a press through `elementFromPoint` / `elementsFromPoint`, which
account for stroke width, `pointer-events`, paint order and transparency. A rectangle
comparison knows none of that, and it **lies in both directions**:

- **False red.** v3.5.0 had a guard asserting a selection rect covered a label before
  pressing it. The boxes said no; `elementFromPoint` at that exact pixel said the rect
  really was on top. The guard was measuring the wrong thing, not reporting a real
  change.
- **False green.** Two boxes overlapping proves nothing when the top one carries
  `pointer-events: none` — it never intercepts at all.

Related, and measured here: **SVG paint order is document order.** `renderCanvas` draws
every lane before it draws the edges, so an invisible 10px `.ed-wave-edge-hit` stroke
sits on top of every bus label underneath it — no matter which `if` the hit-testing code
happens to run first. A fix that only reorders the checks does nothing.

And: **a zero-length path has no hit area at all** (butt cap, no `stroke-linecap`).
A self-loop edge degenerates to exactly that, which is why it needs its handle to stay
hittable rather than relying on its line.

## One Concept, Two Definitions, and a Layer That Assumes They Agree

Three separate defects in v3.5.0 had the same shape — the same idea defined differently
at two ends of the system, with the code in between assuming one answer:

- `node` string indices are **cells**, while the drawing thinks in **cycles**; `.` and
  `|` occupy a cell but are not their own cycle.
- `getBoundingClientRect` boxes versus `elementFromPoint` hits (above).
- An empty string means "unset" to the engine's `captext` (a truthy test) and
  "set, draw the default ruler" to its `ticktock` (an `=== undefined` test) — so
  clearing a field had to DELETE the key, not write `''`.

When you touch a value that crosses a boundary, check what the far side does with it
rather than what your side means by it. Measure both ends.

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

## A Traversal Bound Is Not a Count — Deriving Beats Grepping

The rule above says grep for a literal before changing a count. v3.5.0 followed it and
still went red: growing the wave editor's brush roster from 11 to 22 broke a scenario
whose Tab walk was capped at `60`. That `60` is not a count of anything — it is a
**traversal bound that merely has to be big enough for a count kept somewhere else**,
so grepping for `11`, `22` or `brush` finds nothing.

The general form: **changing a roster can break a constant that only has to be large
enough for that roster.** Those constants are invisible to the grep the rule above
prescribes.

So: a bound over a collection should be DERIVED from that collection at the point of
use, not written as a number. `test/editor-journey.test.js` now computes its Tab caps
from the dialog's actual focusable count (`modalFocusableCap`), using the same selector
and the same filters as `wave-ui.js`'s own `focusables()` — a copy of the product's
rule, not a second opinion about it. Each site says in a comment why it is derived, or
someone will simplify it back to a number.

## `lib/md2doc.js`'s CSS Lives Inside a JS Template Literal

The `<style>` block is built inside a template literal, so **a backtick anywhere in a
comment you add there breaks the whole file** — and the break is a syntax error far from
where you typed it. This bit v3.5.0 twice, in two different tasks.

Run `node --check lib/md2doc.js` before every commit that touches that file. It is also
where every `.ed-wave-*` rule lives: visual properties (stroke, fill, opacity, dashes)
belong there as CSS classes, not as inline SVG attributes — a renderer with two styling
mechanisms means the next person changing colours edits one and silently misses the
other.

## Do NOT Stage

- `docs/superpowers/specs/`, `docs/superpowers/plans/` — local working state from brainstorming / writing-plans skills. Not for the repo (already in `.gitignore`? — if not, the rule still stands).
- `*.html` files generated by `md2doc foo.md` for testing — output, not source.
- `node_modules/`, `.cache/puppeteer/`, etc. (covered by `.gitignore`).
