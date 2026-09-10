# Task 2 report: 表格列／欄拖曳之後畫面跳到表頭

**Status:** NEEDS_RUN (Step 1 round 3 → Step 2, waiting on the RED-phase run)
**Commit:** none yet — production code (`lib/editor/client.js`) not touched.
Only the test file has changed so far.

## Round 2 result (reported back by coordinator) and what it means

`EXIT=1`, but NOT an `AssertionError` — a `TimeoutError` on the row-order
`waitForFunction` (30s). Good news buried in it: the precondition
(`headerBottom < 0`) at line 8120 PASSED — the header really was off-screen
this time, so the round-2 fixture fix (tallTableRows()/scrollRowIntoView())
is validated. The failure was purely "the drag didn't produce the row order
I hand-predicted" — a fixture bug, not evidence about the production code.

**Root cause, confirmed by reading (not guessing) `lib/editor/client.js`:**

- `allRowsOf(tableEl)` (~9203) = `[headerRow].concat(bodyRows)` — the header
  occupies index 0. My round-2 `expectedOrder` IIFE built its array from
  body rows ONLY (`for (let i = 1; i <= N; i++) orig.push(...)`, no header
  slot), so every index it used was off by however `performRowDrop()`'s
  OWN index (which comes from `allRowsOf()`) actually differs from a
  body-only index.
- `nearestRowDropTarget()` (~10541), which `updateDropIndicator()` feeds
  the drop `clientY` and whose `.rowIndex` becomes `performRowDrop()`'s
  `toIndex`, returns `rowIndex: all.indexOf(rows[i])` where `all =
  allRowsOf(tableEl)` — also header-inclusive. `rowBoundaryCoords()` (this
  test file) releases at the BOTTOM of body row `afterBodyIndex`, which is
  the TOP of the NEXT body row and below that next row's own midline, so
  production's resolved `toIndex` is `allRowsOf().indexOf(bodyRow[
  afterBodyIndex + 1])` = `(afterBodyIndex + 1) + 1` = `afterBodyIndex + 2`
  — not `afterBodyIndex` as round 2 assumed.
- Net effect for `fromBodyIndex=39, afterBodyIndex=36` (round 2's values):
  production's real splice leaves 37 untouched rows before the moved one
  (`...,37,r37,40,r40,38,r38,39,r39`), not the 36 round 2 predicted
  (`...,36,r36,40,r40,37,...`) — off by exactly one row, exactly the header
  offset.
- Sanity check against real, already-observed behavior: applying this same
  header-aware formula to round 1's `fromBodyIndex=2, afterBodyIndex=0`
  (the 3-row table) reproduces `1,a,3,c,2,b` / `...,2,bPROBE` — the SAME
  order round 1 actually got right (round 1 got lucky/right there because
  `afterBodyIndex=0` still worked out, not because the body-only model was
  correct in general).

This is hypothesis **(A)** — a wrong `expectedOrder` computation — not (B):
the drag itself did resolve to some ordering (a `TimeoutError` alone
couldn't prove that, which is why round 3 below replaces the open-ended
wait with a bounded one that surfaces the real value either way.

## Round 1 result (reported back by coordinator) and what it means

`node test/editor-client-runtime.test.js` round 1 → `EXIT=1`, failing on
`拖曳不得把焦點放到表頭儲存格`: `{"scrollY":3761,"active":"TH.cell-narrow
ed-wys-cell"}`. So:

- Focus-on-header defect: **reproduced** (mechanism direction confirmed —
  something in the drag path does end up focusing cells[0]/the header TH).
- Scroll-jump symptom: **NOT reproduced** — the `scrollY` assertion (checked
  first, before the `active` one) PASSED, i.e. `after.scrollY === before`
  held. `focus()` only scrolls when its target is actually off-screen; round
  1's 3-row table fit in one viewport even with `scrollToTable()`'s
  `block:'center'` alignment, so the header was still on-screen when
  focused — nothing to scroll back into view.
- Scenario 2 (the regression guard) did **not** appear in the failure
  output. Checked: this file is one big `(async () => { ... })().catch((e)
  => { ...; process.exit(1); })` (line ~23852 in the original numbering) —
  a single thrown assertion anywhere aborts everything after it, with no
  per-scenario try/catch. Scenario 1 sits before scenario 2 in the file, so
  scenario 2 **never ran** (not "ran and passed") — still unverified.

## Round 3 fix to the test (still Step 1 — `lib/editor/client.js` untouched)

- Added `expectedRowDragOrder(n, fromBodyIndex, afterBodyIndex)` — the
  header-aware prediction described above, read from `allRowsOf()` and
  `nearestRowDropTarget()` rather than re-derived by hand. Validated
  standalone (outside Puppeteer, pure function) against both round 1's
  observed-correct 3-row result and round 2's hand-derivation of the 40-row
  case — matches.
- Replaced BOTH scenarios' open-ended `page.waitForFunction(...)` on the
  row order with: `dragRow()` → `settleEditor()` → a bounded 500ms grace →
  read the actual flat tbody-td join → `assert.strictEqual(actual,
  expected, ...)`. Per the coordinator's explicit request: if the
  prediction is wrong again, this fails fast with the real value instead of
  another 30s blind timeout. (Scenario 2's expected string
  `'1,a,3,c,2,bPROBE'` was already validated correct via round 1's
  behavior, per the sanity check above — kept as a literal there since it's
  a small, already-confirmed fixture, not run through the new N-row
  helper.)
- **Moved both scenarios from mid-file (after "promote-then-demote round
  trip") to the very end of the file**, immediately before
  `console.log('editor-client-runtime.test.js OK')` — per the coordinator's
  observation that this file has no per-scenario try/catch (one top-level
  `(async () => {...})().catch((e) => {...; process.exit(1);})`), so a
  failure in these two (which have now needed three rounds) no longer
  blocks the ~350 pre-existing scenarios that used to run after them. No
  other scenario's relative order was touched — this was a pure relocation
  of only the two new blocks.

## What was done (Step 1)

Added two scenarios to `test/editor-client-runtime.test.js`, adapted to this
file's actual conventions (no `scenario()`/`LONG_DOC_WITH_TABLE` helpers
existed — this file's table-drag tests use bare `{ ... try/finally }` blocks
with `setupTableDoc()`, `tableBlockSel()`, `rowGripCoords()`,
`rowBoundaryCoords()`, `dragRowTo()`; I followed that pattern instead of the
brief's pseudocode literally):

- New helpers (placed next to their nearest relatives, not grouped):
  - `typeIntoCell(page, tableSel, rowIndex, colIndex, text)` — real click by
    (row, col) instead of by text (the regression scenario needs to click
    BEFORE the text changes) — next to `clickCellWithText()`.
  - `scrollToTable(page, tableSel)` — `scrollIntoView({block:'center'})` then
    returns `window.scrollY` — next to `typeIntoCell`.
  - `longDocWithTableRows()` — `'pad\n\n'.repeat(100)` filler (same shape the
    existing S3 §4.4 "scrolling does not clear the selection" scenario
    already uses elsewhere in this file) + a 3-row/2-column table.
  - `dragRow(page, tableSel, fromIndex, toIndex)` — composes the existing
    `rowGripCoords()`/`rowBoundaryCoords()`/`dragRowTo()` — next to
    `dragRowTo()`.
- Two scenarios, now at the very end of the file (see round 3 above for why
  they moved there), right before `console.log('editor-client-runtime.test.js OK')`:
  1. **"a drag with no pre-focused cell and the header scrolled off-screen
     leaves the scroll position alone"** — 40-row table, drags the last row
     to just after row N-4 with NO cell focused first and the header's
     `getBoundingClientRect().bottom < 0` asserted as a precondition, a
     diagnostic row-order assertion (round 3), then asserts
     `window.scrollY` is unchanged and `document.activeElement` is not a
     `TH`.
  2. **"a drag started from an edited cell keeps that cell focused"** (must
     NOT regress; still unexercised by any real run) — clicks + types into
     body row 1 col 1 first (cell becomes `bPROBE`), drags row 2→after-row-0,
     a diagnostic row-order assertion (round 3), then asserts
     `document.activeElement.textContent` is still `bPROBE`.

`node --check test/editor-client-runtime.test.js` passes (syntax only — the
file itself was NOT run, per instruction). `node test/editor-client.test.js`
(the fast guard, unaffected since `lib/editor/client.js` is untouched) passes
in ~1.5s.

## A mechanism risk found while reading the code (not yet resolved — flagging before the run, not guessing past it)

`ensureTableBurstOpen()` (client.js ~9394-9425), which BOTH `performRowDrop()`
and `performColDrop()` call first via `await ensureTableBurstOpen(tableEl)`,
itself does `tableCellsOf(liveTableEl)[0]` then `cell.focus()` when no table
burst is open yet on that table — i.e. cells[0], the same header cell
`restoreTableFocus()`'s `activeIndex === -1` fallback would pick. Depending on
exactly when the resulting `focusin` → `handleTableCellFocusIn()` →
`startTableBurst()` chain resolves relative to `performRowDrop()`'s own
`activeIndex` read (this is an async/microtask ordering question I could not
settle by reading alone), the scroll-to-header could originate from THIS
`cell.focus()` call rather than (or in addition to) `restoreTableFocus()`'s.
If so, the brief's Step 3 fix (gating the `restoreTableFocus()` call on
`activeIndex >= 0`) would leave scenario 1 red even after the fix, because
the first `cell.focus()` already happened and already scrolled the page
before `activeIndex` is even computed.

I did not act on this speculation — per the brief, mechanism questions get
settled by the driven test, not by more reading. Flagging it now so a
still-red Step-4 result isn't a surprise; if that happens the likely next
fix is `cell.focus({ preventScroll: true })` on `ensureTableBurstOpen()`'s
own focus call (line ~9422) in addition to the `performRowDrop`/
`performColDrop` guard, not a sign the guard itself is wrong.

## NEEDS_RUN (round 3 — Step 1 only, `lib/editor/client.js` still untouched)

```
指令: node test/editor-client-runtime.test.js
```

Expected (pre-fix, production code untouched):
- Every pre-existing scenario (~350) → unaffected, and now runs to
  completion regardless of what happens in the two new scenarios (they're
  last in the file).
- `table row drag (v3.4.0 §2): a drag with no pre-focused cell and the
  header scrolled off-screen leaves the scroll position alone`:
  - The `headerBottom < 0` precondition should hold (round 2 already
    confirmed this part of the fixture works).
  - The new diagnostic row-order assertion should now PASS (formula fixed
    and validated standalone — see above); if it's still red, the actual
    value in the failure message is the next real lead, not another guess.
  - Target assertion, expected **RED**: `拖曳不得改變捲動位置`
    （`after.scrollY !== before`）— this is the goal for this round: reach
    and fail specifically here, with real before/after `scrollY` values.
- `table row drag (v3.4.0 §2): a drag started from an edited cell keeps
  that cell focused` → should finally run (never reached in rounds 1-2).
  Expected **GREEN** — `currentBurst.activeCellEl` is non-null when the
  drag starts, so `activeIndex >= 0` and `restoreTableFocus()` is
  unconditionally called both before and after the eventual Step 3 fix.

Per the coordinator's instruction, this run is deliberately test-only —
Step 3 (the `if (activeIndex >= 0) restoreTableFocus(...)` guard in both
`performRowDrop()`/`performColDrop()`) is NOT applied yet, so the earlier
`ensureTableBurstOpen()`-vs-`restoreTableFocus()` origin question can be
answered cleanly by comparing this run's result to the next one (after
Step 3 is applied) rather than conflating "did the fixture reproduce it"
with "did the fix work" in one run.
