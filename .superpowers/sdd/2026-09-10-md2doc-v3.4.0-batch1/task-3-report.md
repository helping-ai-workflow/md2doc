# Task 3 report: 儲存按鈕的模型層

## Status

DONE.

## Commit

`ee19f58` on branch `feat/v3.4.0-batch1` — "feat(editor): a save button in the toolbar model"
（2 files changed, 107 insertions(+), 18 deletions(-); only `lib/editor/toolbar-model.js`
and `test/toolbar-model.test.js` staged/committed.）

## Tests run

- `node test/toolbar-model.test.js` → EXIT=0（346 checks，含 brief step 1 的新測試區塊）
- `node test/editor-client.test.js` → EXIT=0

Both via `> logfile 2>&1; echo EXIT=$?`, no pipe.

## What changed beyond the brief's literal diff

Pre-existing assertions in `test/toolbar-model.test.js` that hard-coded the
old roster shape had to migrate (not a regression — they pinned a count/list
that the new button legitimately changes):

- `BUTTONS.length` 22 → 23
- `GROUPS` array: added `'file'` at front
- `expectedByGroup`: added `file: ['save']`
- a stray comment ("export is not part of the 22") updated to 23

None of these needed logic changes elsewhere — e.g. the pre-existing
"no block" test (`allowed` set without `'save'`) and the pre-existing
"mode: source" sweep (`else` branch expecting `disabled === true`) both
still pass unmodified, because `save`'s default `dirty` is falsy in those
ctxs, which happens to already match the old expectations.

## Ruling P2 (NO_BLOCK_ALLOWED + `!dirty` line both kept)

Implemented exactly as ruled. `NO_BLOCK_ALLOWED`'s `'save'` entry now carries
a comment explaining it is currently overwritten by the later
`state.save.disabled = !dirty` line, and is kept as the fallback enforcement
point should that line ever move above the no-block loop.

## The `continue`-rewrite trap

Rewrote the source-mode override to explicitly set
`state[b.id].disabled = false` for `preview`/`outline` before `continue`
(not a bare `continue` that would rely on the main loop's value). Added a
dedicated assertion (`srcWithBlock`, using a ctx with a real `blockType` so
`hasBlock` is true and the no-block loop doesn't confound the result) that
pins `preview.disabled === false` and `outline.disabled === false` in source
mode after this rewrite.

One honesty note for the record: I could not find a ctx under the current
code where `preview`/`outline`'s `disabled` would actually be `true` right
before the source-mode override runs — they're in `NO_BLOCK_ALLOWED` (so the
no-block loop never touches them) and no other rule in `deriveState()`
touches those two ids before the override. So today this assertion cannot
distinguish "explicit `= false`" from "bare `continue` on an already-false
value" via any reachable ctx — it's a shape/regression guard for future code
that might add a rule touching these ids earlier, not a currently-red-without-it
test. Flagging this in case the brief's intent was a stronger guarantee than
the codebase can currently exercise.

## Concerns

- **Out-of-scope modified file found in the working tree**: `git status`
  shows `test/editor-client-runtime.test.js` modified (258 insertions), which
  I did not touch and which was not listed in the session's initial
  `gitStatus` snapshot. It looks like v3.4.0 §2 (table row drag) work, not
  part of Task 3's scope (`lib/editor/toolbar-model.js` /
  `test/toolbar-model.test.js` only). I left it untouched and did not stage
  or commit it — `git add` was scoped to exactly the two files named in the
  brief. Surfacing this so the orchestrator can confirm it's expected
  (concurrent Task-2-family work in the same shared worktree) rather than
  something dropped by accident.
- Did not run `npm test`, `editor-client-runtime.test.js`, or
  `editor-journey.test.js`, per explicit instruction (slow + currently
  unreliable under today's load).
- `lib/editor/client.js` still needs to actually read `ctx.dirty` from
  real dirty-tracking state and pass it into `deriveState()` for this to
  have any runtime effect — that's out of this task's scope
  (`toolbar-model.js` is a pure function module) and presumably a later
  batch task's job.
