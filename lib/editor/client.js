'use strict';
/* md2doc editor client runtime (Phase 1: raw-edit). Inlined into the edit
   page after lineops.js; also requireable in node for the pure core. */
(function () {
  const ops = (typeof window !== 'undefined' && window.md2docLineOps)
    ? window.md2docLineOps
    : require('./lineops.js');

  function extractBlockSource(lines, block) {
    return lines.slice(block.startLine - 1, block.endLine).join('\n');
  }

  // ── T8 item 1: the range helpers refuse an INVERTED range THEMSELVES ────
  // A block that owns no source line has endLine === startLine - 1 (see
  // blockOwnsNoLine() further down) and blocks do not tile the document, so an
  // inverted range is a shape callers can genuinely arrive at. Both helpers
  // below were written assuming endLine >= startLine, and handed an inverted
  // range neither fails — each does something plausible and wrong:
  //   commitRangeEdit()    `lines.slice(startLine-1, endLine)` is [], so the
  //                        unchanged-text test compares against '', and
  //                        ops.replaceLines() splices without removing — an
  //                        INSERT where a replace was asked for. Measured:
  //                        '# Doc\n\n- a\n\n- - b\n' + 'ZZZ' ->
  //                        '# Doc\n\n- a\n\nZZZ\n- - b\n'.
  //   commitRangeRemoval() the blank-line absorption samples `lines[el]` (the
  //                        range's own first line) and `lines[sl-2]` (a line
  //                        owned by whatever precedes), finds one blank and
  //                        deletes it. Measured: '# Doc\n\n- a\n\n- - b\n'
  //                        -> '# Doc\n\n- a\n- - b\n', silently.
  // That single root cause was fixed FIVE separate times at five call sites
  // (T3 arming, T3 same-line child commit, T4 gutter delete, T4 raw edit,
  // T7 insertBlockBelow). Those guards stay — they can show the user a banner,
  // which this cannot — but the rule now also lives in the one place every
  // path must pass through.
  //
  // The refusal REUSES the existing "nothing changed" return shape (`op: null`,
  // the caller's own arrays handed straight back) plus a `refused` tag, rather
  // than throwing: every call site already has a correct abort path for
  // op === null, and none of the five is inside a try/catch, so a throw would
  // convert a silent wrong edit into an unhandled rejection mid-gesture — a
  // different failure, not a safer one. The tag is what makes the refusal
  // observable; `console.error` is what makes it findable in a real session.
  function refuseInvertedRange(state, who, startLine, endLine) {
    if (endLine >= startLine) return null;
    if (typeof console !== 'undefined' && console && typeof console.error === 'function') {
      console.error('[md2doc] ' + who + ' refused an inverted line range: startLine=' +
        startLine + ' endLine=' + endLine + ' (a block that owns no source line, or a ' +
        'caller that computed a range backwards) — nothing was committed');
    }
    return { lines: state.lines, blocks: state.blocks, op: null, refused: 'inverted-range' };
  }

  // Pure: apply a raw-edit commit to an EXPLICIT line range (startLine..endLine,
  // 1-indexed inclusive); push onto stack.
  // Returns {lines, blocks, op}; op === null when text is unchanged.
  // The shift anchor is the LAST block whose endLine <= the range's endLine,
  // so that only blocks after the committed range are shifted — not blocks
  // inside it. Guards the no-anchor case (range before every block).
  function commitRangeEdit(state, startLine, endLine, newText) {
    const refusal = refuseInvertedRange(state, 'commitRangeEdit', startLine, endLine);
    if (refusal) return refusal;
    const before = state.lines.slice(startLine - 1, endLine);
    const after = newText.split('\n');
    if (before.join('\n') === after.join('\n')) {
      return { lines: state.lines, blocks: state.blocks, op: null };
    }
    const op = { startLine, endLine, before, after };
    const r = ops.replaceLines(state.lines, startLine, endLine, after);
    const anchor = state.blocks.filter((b) => b.endLine <= endLine).pop();
    const blocks = anchor ? ops.shiftBlocks(state.blocks, anchor.id, r.delta) : state.blocks;
    state.stack.push(op);
    return { lines: r.lines, blocks, op };
  }

  // Pure: apply a raw-edit commit to (lines, blocks); push onto stack.
  // Returns {lines, blocks, op}; op === null when text is unchanged.
  // Wrapper over commitRangeEdit: looks up the block by id and delegates.
  function commitEdit(state, blockId, newText) {
    const block = state.blocks.find((b) => b.id === blockId);
    return commitRangeEdit(state, block.startLine, block.endLine, newText);
  }

  // Generalized range removal: deletes startLine..endLine (zero lines) and
  // absorbs exactly ONE adjacent blank line — the same blank-line contract as
  // commitListBlockRemoval() but for an EXPLICIT range instead of a single
  // block id. Used by the li burst's empty-run path (Task 7) and by the
  // list-burst empty-list path via the wrapper below.
  // RULING F-C: the shiftBlocks anchor is the last block whose endLine is
  // within the requested range, computed BEFORE blank-line absorption so that
  // widening endLine to cover an adjacent blank never reaches across into the
  // next real block and mis-shifts it.
  function commitRangeRemoval(state, startLine, endLine) {
    const refusal = refuseInvertedRange(state, 'commitRangeRemoval', startLine, endLine);
    if (refusal) return refusal;
    const anchor = state.blocks.filter((b) => b.endLine <= endLine).pop();
    let sl = startLine, el = endLine;
    // state.lines[el] (0-indexed) is the line immediately AFTER the range.
    if (state.lines[el] !== undefined && state.lines[el].trim() === '') {
      el += 1;
    } else if (state.lines[sl - 2] !== undefined && state.lines[sl - 2].trim() === '') {
      sl -= 1;
    }
    const before = state.lines.slice(sl - 1, el);
    const op = { startLine: sl, endLine: el, before, after: [] };
    const r = ops.replaceLines(state.lines, sl, el, []);
    const blocks = anchor ? ops.shiftBlocks(state.blocks, anchor.id, r.delta) : state.blocks;
    state.stack.push(op);
    return { lines: r.lines, blocks, op };
  }

  // Task 4 fix (review, Important): removing the LAST remaining item of a
  // list block (empty-Enter on a list with exactly one item) serializes to
  // '' — committing that through commitEdit() would replace the block's
  // line range with [''] (ONE blank line: `newText.split('\n')` on an empty
  // string is `['']`, not `[]`), leaving stray diff noise instead of
  // cleanly closing the gap. Thin wrapper over commitRangeRemoval() above —
  // see that function for the exact byte-level contract. Verified against the
  // reviewer's exact probe: `# Doc\n\n- Only\n\nTrailer` -> `# Doc\n\nTrailer`
  // (exactly one separating blank line) — see test/editor-client.test.js.
  function commitListBlockRemoval(state, blockId) {
    const block = state.blocks.find((b) => b.id === blockId);
    return commitRangeRemoval(state, block.startLine, block.endLine);
  }

  // Phase 3 §10-gap fix: inserts a NEW block's `newBlockLines` directly below
  // the block identified by `blockId`, via lineops.insertLines() — mirrors
  // commitListBlockRemoval()'s blank-line math ABOVE, but in reverse: that
  // function absorbs an EXISTING neighboring blank line to avoid leaving a
  // double blank behind after a removal; this one REUSES an existing
  // trailing blank (when the hovered block already has one — the normal
  // mid-document case) as the new block's OWN trailing separator, instead of
  // inserting a second one next to it. A leading blank is always inserted
  // fresh (the hovered block's own trailing content never carries one). Two
  // cases for what follows the hovered block:
  //   - a blank line (or nothing — true EOF): reuse it / nothing needed, so
  //     `after` is just [blank, ...newBlockLines] — the pre-existing blank
  //     (or plain end-of-file) becomes/stays the separator to whatever's
  //     next.
  //   - non-blank content immediately follows (no blank neighbor — an edge
  //     case malformed input could produce): a fresh trailing blank is
  //     added too, or the new block would merge into the next one when
  //     re-lexed.
  // The resulting op is a zero-width "before" range (nothing existed at the
  // insertion point to replace) — same trick commitListBlockRemoval() uses
  // in the opposite direction (a zero-width "after" range) to let the
  // existing UndoStack undo()/redo() pair (lib/editor/lineops.js) handle a
  // pure insertion/pure removal without a third op shape.
  function commitBlockInsertion(state, blockId, newBlockLines) {
    const block = state.blocks.find((b) => b.id === blockId);
    // T8 item 1, third helper in the same family: the anchor's range is read as
    // an interval here too (`endLine + 1` is the insertion point, `lines[endLine]`
    // the trailing-blank probe), so an inverted one puts the new block ABOVE the
    // block it was anchored to, inside the previous one's territory.
    // refuseInvertedRange() takes the range, so the anchor's own is passed.
    const anchorRefusal = refuseInvertedRange(state, 'commitBlockInsertion',
      block.startLine, block.endLine);
    if (anchorRefusal) return anchorRefusal;
    const endLine = block.endLine;
    const nextLine = state.lines[endLine]; // 0-indexed: line right after the block, or undefined at EOF
    const needsTrailingBlank = nextLine !== undefined && nextLine.trim() !== '';
    const after = needsTrailingBlank
      ? ['', ...newBlockLines, '']
      : ['', ...newBlockLines];
    const op = { startLine: endLine + 1, endLine, before: [], after };
    const r = ops.insertLines(state.lines, endLine, after);
    const blocks = ops.shiftBlocks(state.blocks, blockId, r.delta);
    state.stack.push(op);
    // The new block's own content starts one line after the leading blank
    // this function always inserts (see `after` above — its first element
    // is always the fresh leading blank) — callers use this to locate the
    // freshly-inserted block in the blocks array a subsequent full
    // rerenderAll() (which recomputes blocks server-side) hands back.
    const newStartLine = op.startLine + 1;
    return { lines: r.lines, blocks, op, newStartLine };
  }

  // ── T8 review MEDIUM-1: the one correct way to undo a failed render ─────
  // Six sites in this file share the shape "commit optimistically, re-render,
  // and if the render failed put `lines` back". The inlined version of that
  // last step was `const rollback = stack.undo(lines); lines = rollback ?
  // rollback.lines : prevLines;` — correct only while EVERY commit pushed an
  // op. Since commitRangeEdit()/commitRangeRemoval()/commitBlockInsertion()
  // learned to REFUSE an inverted range (above), a commit can return
  // `op: null` having pushed nothing, and UndoStack.undo() pops `_done`
  // unconditionally (lib/editor/lineops.js) — so at the two sites that never
  // inspected `result.op` (insertBlockBelow / deleteBlockViaGutter) a refusal
  // followed by a render failure popped and reversed the user's PREVIOUS,
  // UNRELATED edit. Latent only because those two check blockOwnsNoLine()
  // first; S2 gives li blocks a ＋ and it goes live.
  //
  // One helper rather than two `if (result.op === null) return;` lines,
  // because the idiom is copy-pasted and the seventh site will not remember
  // either. Declared in the pure core so it is reachable from node: the branch
  // cannot be driven through a gesture today, and a guard that can only be
  // checked by grepping for its own source text is the shape that already
  // failed review once on this plan.
  //
  // `state` needs `.lines` (the CURRENT, optimistically-assigned array) and
  // `.stack`. Returns the array `lines` should become.
  function rollbackFailedRender(state, result, prevLines) {
    if (!result || result.op === null) return prevLines;
    const rollback = state.stack.undo(state.lines);
    return rollback ? rollback.lines : prevLines;
  }

  function headingDepthOf(line) {
    const m = line.match(/^(#{1,6})\s?/);
    return m ? m[1].length : 1;
  }

  // Final-review Finding 5: an EMPTY heading (rest === '') used to emit
  // '#'.repeat(newDepth) + ' ' — the trailing space survives even with
  // nothing after it, a spec §4 no-trailing-whitespace violation. marked
  // still lexes a bare '#'.repeat(depth) run (no space, nothing after) as a
  // valid empty-text heading token (verified: marked.lexer('##') ->
  // {type:'heading', depth:2, text:''}), so the space is only needed when
  // there IS content after it.
  function withHeadingDepth(line, newDepth) {
    const m = line.match(/^#{1,6}\s?/);
    const rest = m ? line.slice(m[0].length) : line;
    return rest === '' ? '#'.repeat(newDepth) : '#'.repeat(newDepth) + ' ' + rest;
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { extractBlockSource, commitEdit, commitRangeEdit, commitRangeRemoval, commitListBlockRemoval, commitBlockInsertion, rollbackFailedRender, headingDepthOf, withHeadingDepth };
    return; // node: pure core only
  }

  // ── DOM wiring (browser only) ─────────────────────────────────────────
  const ED = window.__ED__;
  const inlineMd = window.md2docInlineMd;
  const tableMd = window.md2docTableMd;
  const listMd = window.md2docListMd;
  const indentClamp = window.md2docIndentClamp;
  const convertMd = window.md2docConvertMd;
  const selectionLib = window.md2docSelection;
  const historyLib = window.md2docHistory;
  let lines = ED.lines, blocks = ED.blocks, mtimeMs = ED.mtimeMs;
  // 檔案原本的換行符。lines 內部永遠是不含 \r 的純內容行；只有 save()
  // 會把它接回這個 EOL，render 一律用 \n（spec §3.11）。
  const EOL = ED.eol || '\n';
  const stack = new ops.UndoStack();
  const baseTitle = document.title;
  const contentEl = document.querySelector('.content');

  // Click-to-switch substrate (Phase-2 Task 1; replaces the old "refuse a
  // second block's editor outright" policy). At most one block editor is
  // open at a time, but instead of refusing a switch away from it, the open
  // editor is resolved automatically: unmodified → silently cancelled (same
  // effect as Esc); modified → auto-committed. Both raw-edit and (future)
  // WYSIWYG editors expose the same shape here so switchAwayFrom() below
  // works uniformly regardless of which kind of editor is open:
  //   { blockEl, hasChanges(), commitNow(): Promise<boolean>, cancelNow(): void }
  //
  // undo()/redo() are a DIFFERENT collision, not just "open a second
  // editor": they replace the ENTIRE .content subtree (via
  // safeRerenderAll()) regardless of which block, if any, currently has an
  // editor open. If that swap ran while some block's editor was open
  // without resolving it first, its textarea would be detached without
  // ever running its own cancelNow()/commitNow() — the only place that
  // clears `activeEditor` — so `activeEditor` would be left pointing at a
  // node no longer in the document, and every future attempt to open a
  // block's editor would then find a stale `activeEditor` (a real
  // regression found in review: silent total lockout, recoverable only by
  // reloading). So undo()/redo() also resolve any open editor FIRST via
  // switchAwayFrom() below — same resolution as a block switch, just
  // triggered by the undo/redo collision instead of the click collision.
  //
  // Belt-and-braces: rerenderAll() also unconditionally nulls `activeEditor`
  // right after every successful .content swap, regardless of caller, so a
  // future safeRerenderAll() call site that forgets this pre-check can
  // never reproduce the lockout — any editor that was open is gone by
  // construction the moment the swap happens.
  let activeEditor = null; // { blockEl, hasChanges(), commitNow(), cancelNow() } | null

  // Task 2 (Phase 3): the currently-open always-on WYSIWYG "burst" — at most
  // one paragraph/heading contenteditable surface is being edited at a time,
  // tracked separately from `activeEditor` above (which covers the OLDER
  // raw-edit / table-cell editor shape). See the "always-on WYSIWYG burst"
  // section further down for the full shape and lifecycle.
  let currentBurst = null; // { blockEl, editEl, blockId, blockType, depth, original, history } | null

  // §10-gap fix (review): the block insertBlockBelow() most recently
  // inserted, tracked from the moment its edit surface is first focused
  // until its FIRST resolution (blur, Escape, explicit commit, or Ctrl+Z) —
  // whichever comes first, one exit only. "Insert ＋, click away without
  // typing" is an ordinary changed-my-mind action (verified against ALL 5
  // skeletons: an untouched insert would otherwise leave behind an
  // invisible ZWSP paragraph, a heading with a spec-§4-violating trailing
  // space, a list item that fails the documented marker pattern, or a
  // visually-empty table/code block) — every resolution path below checks
  // this and, if the block's content is STILL byte-identical to what was
  // inserted (never edited), auto-removes it via discardPristineInsert()
  // instead of leaving the skeleton on disk. Editing ANYTHING clears it
  // (see each call site below) — from that point on the block is a normal,
  // permanently-committed one like any other.
  let pristineInsert = null; // { blockId } | null

  // Task 5 fix (found via a standalone repro harness — see the task-5
  // report): a table mutation that DETACHES the focused cell — whether by
  // reassigning tableEl.innerHTML wholesale or by re-parenting the cell/row
  // nodes — removes whichever cell currently has focus. Chromium runs the
  // focus-fixup "unfocus"
  // step (firing a synchronous blur/focusout) BEFORE the node is actually
  // detached — NOT after, as a naive reading of "removed nodes lose focus"
  // would suggest — so at the moment that focusout's handler runs,
  // `e.target.closest('table')` STILL resolves to the live `tableEl`
  // (its `parentNode` hasn't been cleared yet), and the handler's
  // "still inside the table" exclusion (which reads `e.relatedTarget`,
  // itself still null/unset at that same instant, since nothing has
  // received focus yet) does NOT catch it either. Without this flag, that
  // spurious focusout was read as "focus genuinely left the table" and
  // called switchAwayFrom() — silently RE-COMMITTING the very state the
  // revert/undo/redo was in the middle of discarding, then wiping focus to
  // <body> once the resulting rerenderAll() swapped .content. Set true for
  // the exact synchronous span of each such mutation; the focusout listener
  // checks it FIRST and no-ops the whole branch while set.
  //
  // There are exactly FOUR set-to-true sites, and test/editor-client.test.js
  // asserts that count (plus that every one of them is wrapped in a
  // try/finally that clears the flag even on a throw — a latched-true flag
  // silently disables blur-commits for EVERY block type until reload):
  //   1. tableBurstUndo()  — `tableEl.innerHTML = state`
  //   2. tableBurstRedo()  — `tableEl.innerHTML = state`
  //   3. performRowDrop()  — rebuildTableSections(): a row drop is a PURE
  //      MOVE across thead/tbody (any row dragged to the top becomes the
  //      header), so the rebuild detaches the focused cell.
  //   4. performColDrop()  — the per-row cell-reorder loop, which appendChild()s
  //      every row's cells back in the new order, detaching the focused one.
  // revertTableBurstAndEnd() is deliberately NOT on this list, and NOT
  // because anything else guards it: it needs no flag at all because it
  // nulls `currentBurst` and disposes the burst history BEFORE it touches
  // innerHTML — so by the time that rewrite fires Chromium's synchronous
  // blur/focusout, the focusout handler's table branch finds no burst left
  // to resolve and no-ops on its own. See its own comment for the full
  // story. If a fifth site is ever added,
  // update the count in editor-client.test.js deliberately and audit the new
  // site for the same try/finally.
  let suppressTableFocusout = false;

  // Task 8: the SAME Chromium behaviour, one substrate over — see
  // `suppressTableFocusout` just above for the full description of the quirk.
  // A structural list key (Enter / Tab / Shift+Tab on a per-li block) moves,
  // splits or removes the very block whose `.ed-li-text` currently has focus,
  // so Chromium runs its unfocus step — firing a synchronous focusout — with
  // the run still in its PRE-mutation shape and `currentBurst` still live.
  // Unguarded, that focusout reaches resolveBurst(), whose li branch happily
  // serializes and COMMITS the run as it stood before the key: one keystroke
  // becomes two undo ops, and an empty-Enter re-commits the very item it is
  // removing (observed: '- <br>' written back for an item that had just been
  // deleted). Set true for the exact synchronous span of each structural
  // mutation — see mutateListRun() below; the focusout listener checks it
  // FIRST, alongside the table flag, and no-ops the whole branch while set.
  // The burst is NOT lost by suppressing it: commitListStructure() ends it
  // explicitly right afterwards, and re-serializes the LIVE run, so any
  // typed-but-uncommitted text in the run is still committed.
  let suppressLiFocusout = false;

  // Runs one structural list-DOM mutation with that focusout suppressed.
  // try/finally so a throw inside `fn` can never leave the flag stuck on
  // (which would silently disable every subsequent blur-commit in the page).
  function mutateListRun(fn) {
    suppressLiFocusout = true;
    try {
      return fn();
    } finally {
      suppressLiFocusout = false;
      // S1: indents (and therefore run boundaries) may have just moved.
      refreshRunStarts();
    }
  }

  // Resolve whatever editor is currently open BEFORE a caller proceeds to
  // something that must not run concurrently with an open editor (opening a
  // DIFFERENT block's editor, dismissing the bar on an outside click, or a
  // .content-replacing undo/redo). Returns true when it's safe to proceed:
  // no editor was open, or it was cleanly resolved (cancelled if unmodified,
  // committed if modified). Returns false only when a modified editor's
  // auto-commit FAILED (server error / network) — the caller must abandon
  // whatever it was about to do; the open editor stays open, with its
  // banner already shown by the failed commitNow(), as the visible reason
  // why (state consistency over convenience).
  //
  // Single-flight: outside-click and undo()/redo()'s pre-check are two
  // INDEPENDENT triggers that can both fire from near-simultaneous user
  // input (e.g. a mouse blur immediately followed by Ctrl+Z) before either
  // has resolved. Without a guard, a second caller arriving while the first
  // is still awaiting activeEditor.commitNow() would see the SAME
  // activeEditor (still non-null, still hasChanges() === true — nothing
  // about the in-flight commit has touched the textarea's value yet) and
  // fire a SECOND, fully independent commit() on the very same closure:
  // two concurrent /api/render calls racing, `lines` reflecting whichever
  // one happened to run its synchronous portion last while the DOM ends up
  // reflecting whichever response resolves last — silent save/DOM
  // divergence. `switching` caches the in-flight promise so every
  // concurrent caller shares the ONE resolution instead. This also covers
  // openRawEditor()'s defense-in-depth switchAwayFrom() call (see its
  // comment) for the same reason — it's just another caller.
  let switching = null;
  function switchAwayFrom() {
    if (switching) return switching;
    switching = resolveOpenSession().finally(() => { switching = null; });
    return switching;
  }

  // Task 2 (Phase 3): resolves BOTH kinds of "something is open" state this
  // file can have at once — at most one of the two is ever non-null in
  // practice (a block is either an always-on WYSIWYG burst, OR an
  // old-style raw-edit/table-cell `activeEditor`, never both), but this
  // checks both defensively so switchAwayFrom() stays a single, complete
  // "make it safe to proceed" gate for every caller (undo/redo/save, the
  // table click delegator, the burst's own focusout handler, …). See
  // resolveBurst() below for the burst half of this — same true/false
  // contract as activeEditor.commitNow() (false → the failed session stays
  // open with its edit intact, banner already shown, caller must abandon
  // whatever it was about to do).
  async function resolveOpenSession() {
    if (currentBurst) {
      const ok = await resolveBurst();
      if (!ok) return false;
    }
    if (!activeEditor) return true;
    if (!activeEditor.hasChanges()) {
      // §10-gap fix (review): cancelNow() (the raw editor's
      // cancelAndMaybeDiscard()) now itself returns true/false — false
      // only when it was a pristine block whose own auto-removal render
      // failed. Must be awaited/propagated the same way commitNow() below
      // already is, or a caller relying on switchAwayFrom()'s true/false
      // contract (proceed only when safe) could act on stale state.
      return await activeEditor.cancelNow();
    }
    return await activeEditor.commitNow(); // false → editor stays open, banner already shown
  }

  function setDirty() {
    document.title = (stack.dirtyDepth !== 0 ? '● ' : '') + baseTitle;
  }

  // ── banners (conflict / render-failed / save-failed) ──────────────────
  // One shared, dismissible banner element. `actionLabel`+`onAction` add an
  // extra button ahead of the always-present ✕ dismiss button (e.g. the
  // conflict banner's "Reload"); omit them for a plain dismiss-only notice.
  let activeBanner = null;
  function showBanner(message, actionLabel, onAction) {
    if (activeBanner) { activeBanner.remove(); activeBanner = null; }
    const el = document.createElement('div');
    el.className = 'ed-conflict';
    const msg = document.createElement('span');
    msg.textContent = message;
    el.appendChild(msg);
    if (actionLabel && onAction) {
      const actionBtn = document.createElement('button');
      actionBtn.type = 'button';
      actionBtn.textContent = actionLabel;
      actionBtn.addEventListener('click', onAction);
      el.appendChild(actionBtn);
    }
    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.textContent = '✕';
    dismissBtn.setAttribute('aria-label', 'Dismiss');
    dismissBtn.addEventListener('click', () => {
      el.remove();
      if (activeBanner === el) activeBanner = null;
    });
    el.appendChild(dismissBtn);
    document.body.appendChild(el);
    activeBanner = el;
    return el;
  }

  function showConflictBanner() {
    showBanner(
      'File changed on disk — reload to pick up external edits ' +
      '(your unsaved changes will be lost).',
      'Reload',
      () => location.reload()
    );
  }

  function describeFailure(e) {
    return (e && e.message) ? e.message : String(e);
  }

  // res is a fetch Response with a non-2xx/409 status (or undefined, for a
  // network-level throw where no response ever arrived). Best-effort pulls
  // a server-provided {error} message; falls back to the HTTP status.
  async function describeHttpFailure(res) {
    let reason = 'HTTP ' + res.status;
    try {
      const body = await res.json();
      if (body && body.error) reason = body.error;
    } catch (e) {
      // no JSON body (or parse failure) — keep the HTTP-status reason
    }
    return reason;
  }

  // ── full re-render (used by commit / undo / redo) ──────────────────────
  // Returns true on success (DOM + blocks + dirty-dot all updated). Returns
  // false on ANY failure — network throw, non-ok status, or a malformed
  // response — WITHOUT touching contentEl.innerHTML or `blocks`, and shows
  // a dismissible banner explaining what happened. Never throws: every
  // await is inside its own try/catch, so callers never see a rejection.
  async function rerenderAll() {
    const scrollY = window.scrollY;
    // S3 Task 5 (§4.4 step 2): the line range this render's operation declared
    // for the rebuilt selection. Consumed HERE, before the first failure exit,
    // rather than down at the rebuild itself: every `return false` below
    // leaves `blockSelection` untouched — which is what makes a line-range
    // selection survive a failed render for free — and a declaration left
    // standing would then land on some LATER, unrelated render instead.
    const declaredRange = pendingSelectionRange;
    pendingSelectionRange = undefined;
    let res;
    try {
      res = await fetch('/api/render', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileId: ED.fileId, content: lines.join('\n') }),
      });
    } catch (e) {
      showBanner('Render failed — network error (' + describeFailure(e) +
        '). Your edit was not applied.', null, null);
      return false;
    }
    if (!res.ok) {
      const reason = await describeHttpFailure(res);
      showBanner('Render failed — ' + reason + '. Your edit was not applied.', null, null);
      return false;
    }
    let j;
    try {
      j = await res.json();
    } catch (e) {
      showBanner('Render failed — malformed server response. Your edit was not applied.', null, null);
      return false;
    }
    if (typeof j.bodyHtml !== 'string' || !Array.isArray(j.blocks)) {
      showBanner('Render failed — malformed server response. Your edit was not applied.', null, null);
      return false;
    }
    blocks = j.blocks;
    contentEl.innerHTML = j.bodyHtml;
    // Task 2 (Phase 3): re-arm every WYSIWYG-eligible paragraph/heading (and
    // attach a ⠿ handle to every non-table block) in the freshly-swapped
    // DOM — see armEditables() below. Must run before anything else touches
    // the fresh nodes (diagram re-init, reader rebind, focus restoration).
    armEditables(contentEl);
    // Whatever editor (if any) was open a moment ago just got detached by
    // the innerHTML replacement above — its own restore()/commit() never
    // ran, so it never got a chance to null this out itself. Do it here,
    // unconditionally, on every successful swap: this is what makes the
    // undo/redo lockout regression (see the `activeEditor` comment above)
    // structurally impossible even from a call site that forgets to call
    // switchAwayFrom() first.
    activeEditor = null;
    // §10-gap fix (review): same belt-and-braces reasoning for
    // `pristineInsert` — its window is meant to close via one of the
    // explicit resolution hooks (resolveBurst()/revertBurstAndEnd()/
    // revertTableBurstAndEnd()/cancelAndMaybeDiscard()) BEFORE any
    // rerenderAll() reaches here, since every one of those (or the
    // caller that triggered a DIFFERENT commit instead) already went
    // through switchAwayFrom() first. Reset unconditionally here too,
    // same "structurally impossible to leak" contract as activeEditor
    // just above — this call site is set strictly AFTER its own
    // insertBlockBelow() rerenderAll() awaits, so it can never clobber a
    // fresh assignment.
    pristineInsert = null;
    // Task 2 (Phase 3): same belt-and-braces reasoning for the always-on
    // WYSIWYG burst — whatever block had one open a moment ago was just
    // detached by the innerHTML replacement above, so its own focusout
    // resolution never got a chance to null this out itself (this is
    // reached on the SUCCESS path of a commit that originated from the
    // burst itself, where resolveBurst() is still on the stack above this
    // rerenderAll() call — nulling here, not there, is what keeps this a
    // single source of truth, mirroring activeEditor just above).
    if (currentBurst) { currentBurst.history.dispose(); currentBurst = null; }
    // Task 5: same reasoning applies to the hover-edge insert bubbles —
    // whatever table they were positioned against a moment ago was just
    // destroyed by the innerHTML replacement above, so a stale bubble left
    // visible (pointing at now-detached geometry) would misbehave on the
    // next click. Reset unconditionally here too, same idiom as
    // resetSelToolbarState() below. Same reasoning for the row/column grip
    // handles — hideTableGrips() (defined alongside the Task 6 edge menu
    // below) clears their tracked table/row/column references too.
    hideTableInsertBubbles();
    hideTableGrips();
    // Task 4 fix (review finding): the SAME reasoning applies to the
    // selection toolbar and its document-level selectionchange listener —
    // whatever WYSIWYG session was open a moment ago just got detached by
    // the innerHTML replacement above, so its cancel()/commit() never ran to
    // tear this down itself. Every call site today resolves the session via
    // switchAwayFrom() first (making this technically unreachable), but that
    // safety depends on every FUTURE call site remembering to — exactly how
    // the Task 3 listener-leak regression happened (see openWysiwygEditor()'s
    // cancel() comment). Reset unconditionally here too, so a future call
    // site can never reproduce that failure mode for the toolbar either.
    // resetSelToolbarState() is idempotent (safe even when nothing was open).
    resetSelToolbarState();
    // Task 6: same belt-and-braces reasoning again for the edge-click menu
    // and any in-flight row drag — whatever table they referenced a moment
    // ago was just destroyed by the innerHTML replacement above.
    hideTableEdgeMenu();
    cancelTeDrag();
    // Final-review Finding 5b (Important): same belt-and-braces reasoning
    // again for the ⠿ gutter menu — `toggleGutterMenu()` appends the ONE
    // shared `gutterMenu` node as a CHILD of whichever block it's open for
    // (see its own comment), so the innerHTML replacement above just
    // detached it (along with the block it was open on) without its own
    // close path ever running. Left uncleared, `gutterMenuBlockEl` keeps
    // pointing at a detached node: the NEXT toggleGutterMenu() call on that
    // same (now-stale) reference would incorrectly treat the menu as
    // already open (its `gutterMenuBlockEl === blockEl` toggle-closed
    // check comparing against a node no future click can ever produce
    // again) instead of opening fresh on whatever block is actually
    // clicked. closeGutterMenu() is idempotent (safe even when nothing is
    // open — same contract as resetSelToolbarState()/hideTableEdgeMenu()).
    closeGutterMenu();
    // §10-gap fix: same belt-and-braces reasoning for the ＋ insert menu —
    // it's the same "singleton node appended as a child of whichever block
    // it's open for" idiom as gutterMenu just above.
    closeInsertMenu();
    // S3 Task 5 (§4.4's ordered three steps): armEditables() above was step
    // 1; this is steps 2 and 3 — rebuild the member set from the declared (or
    // still-standing) LINE RANGE against the freshly built `blocks`, clear it
    // if that range no longer resolves, and give the focus endpoint a real
    // roving-tabindex holder. It sits AFTER the unconditional teardown above
    // so nothing there can null what it just set, and BEFORE the two
    // `try`-swallowed rebind blocks below so a diagram-init throw can never
    // skip it. It is also deliberately ABOVE window.scrollTo(): the .focus()
    // it ends in scrolls the holder into view, and the scroll restore below
    // is what puts the reader back where they were.
    rebuildBlockSelection(declaredRange);
    window.scrollTo(0, scrollY);
    if (window.__md2docInitDiagrams) {
      try {
        window.__md2docInitDiagrams(contentEl);
      } catch (e) {
        // Phase-1 known limitation: if an edit introduces the FIRST block of
        // a diagram type the initial page never loaded (e.g. the first
        // ```mermaid fence in a doc that had none at load time), the
        // library global is undefined for that type and the block stays as
        // raw/unrendered markup until the page is reloaded. Never let that
        // surface as an uncaught exception that would break the rest of the
        // editor (block selection, save, undo).
      }
    }
    // Finding 4: reader-runtime features (TOC highlight / breadcrumb via the
    // IntersectionObserver, the zoom-resize scroll anchor's heading binary
    // search) all read heading nodes captured once at initial page load
    // (see lib/md2doc.js's reader-runtime <script>). The innerHTML swap
    // above just detached every one of those nodes. Sibling to
    // __md2docInitDiagrams above: re-query the live heading nodes and
    // rebind the observer onto them so those features keep working after a
    // commit instead of silently going dead.
    if (window.__md2docRebindReader) {
      try {
        window.__md2docRebindReader();
      } catch (e) {
        // Never let a reader-runtime rebind failure break block selection/save/undo.
      }
    }
    setDirty();
    return true;
  }

  // Defensive wrapper around every rerenderAll() call site: guarantees the
  // caller never sees an unhandled rejection even if a future change to
  // rerenderAll() (or one of its callees) introduces a stray throw.
  async function safeRerenderAll() {
    try {
      return await rerenderAll();
    } catch (e) {
      showBanner('Render failed — unexpected error (' + describeFailure(e) +
        '). Your edit was not applied.', null, null);
      return false;
    }
  }

  function autoSize(ta) {
    ta.style.height = 'auto';
    ta.style.height = (ta.scrollHeight + 2) + 'px';
  }

  async function openRawEditor(blockEl) {
    if (blockEl.querySelector('.ed-raw')) return; // already editing this block
    if (activeEditor && activeEditor.blockEl !== blockEl) {
      // Click-to-switch (see `activeEditor` / switchAwayFrom() comments
      // above): resolve whatever editor IS open before opening this one.
      // Defense in depth — the delegated click listener (wireBlockSelection
      // below) already resolves this before a degraded block's click (or the
      // ⠿ menu's "MD 原始碼" escape hatch) ever calls openRawEditor(), so by
      // the time this function runs `activeEditor` is normally already null;
      // this guard just makes openRawEditor() safe to call directly too. If
      // a switchAwayFrom() triggered elsewhere (outside-click, undo/redo)
      // is still in flight when this call lands, switchAwayFrom()'s own
      // single-flight cache (`switching`) is what makes THIS call safe to
      // just await the same in-progress resolution rather than firing a
      // second, independent commit.
      const ok = await switchAwayFrom();
      if (!ok) return; // the open editor's auto-commit failed; stay put
    }
    const blockId = Number(blockEl.getAttribute('data-block-id'));
    const block = blocks.find((b) => b.id === blockId);
    if (!block) return;
    // Task 4 fix round 1 (Critical, second path): a block that owns no source
    // line has an INVERTED range (endLine === startLine - 1) — see
    // blockOwnsNoLine(). Everything below assumes a well-formed interval:
    // extractBlockSource() of an inverted range is '', so the textarea opens
    // EMPTY, and commit() -> commitEdit() -> commitRangeEdit(5, 4, text)
    // INSERTS the text as a new line instead of replacing anything, leaving
    // the clicked item untouched and a stray line in the file (measured:
    // '# Doc\n\n- a\n\n- - b\n' + 'ZZZ' -> '# Doc\n\n- a\n\nZZZ\n- - b\n').
    // The only such blocks today are list items (RULING F-O independently
    // forbids a textarea inside one), and they are never armed, so before
    // Task 4 gave every block a ⠿ this was reached by a plain body click and
    // stayed unreported. Guarded HERE rather than at the click delegator so
    // every caller — the delegated degraded-block click, openRawViaGutter(),
    // the burst-degrade path — is closed by one check.
    if (blockOwnsNoLine(blockEl)) { refuseStructuralListEdit(NO_SOURCE_LINE_MESSAGE); return; }

    const original = blockEl.innerHTML;
    const source = extractBlockSource(lines, block);

    const wrap = document.createElement('div');
    wrap.className = 'ed-editing';

    const ta = document.createElement('textarea');
    ta.className = 'ed-raw';
    ta.value = source;

    // `restore`/`commit` are hoisted function declarations (defined further
    // down in this closure) — referencing them here, before their textual
    // definition, is safe. hasChanges() is what switchAwayFrom() (used by
    // block-switch / outside-click / undo / redo) uses to decide "silently
    // cancel" vs "auto-commit". commitNow/cancelNow are the raw-edit
    // editor's implementation of the shared editor-object contract (see the
    // `activeEditor` comment above) — thin wrappers over these same
    // commit()/restore() closures used by the manual Ctrl+Enter/✓/Esc/✕ UI.
    activeEditor = {
      blockEl,
      hasChanges: () => ta.value !== source,
      commitNow: commit,
      cancelNow: cancelAndMaybeDiscard,
    };

    const controls = document.createElement('div');
    controls.className = 'ed-controls';
    const commitBtn = document.createElement('button');
    commitBtn.type = 'button';
    commitBtn.className = 'ed-commit';
    commitBtn.textContent = '✓';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'ed-cancel';
    cancelBtn.textContent = '✕';
    controls.appendChild(commitBtn);
    controls.appendChild(cancelBtn);

    wrap.appendChild(ta);
    wrap.appendChild(controls);

    blockEl.innerHTML = '';
    blockEl.appendChild(wrap);
    autoSize(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    function restore() {
      blockEl.innerHTML = original;
      // Only clear `activeEditor` if it's still THIS block's entry — it may
      // already have been cleared out from under us (e.g. by rerenderAll()'s
      // own defensive reset on a successful swap elsewhere), and this must
      // never stomp some OTHER block's activeEditor set after this one.
      if (activeEditor && activeEditor.blockEl === blockEl) activeEditor = null;
      // No re-wiring needed here (unlike the old per-block gutter): block
      // selection / the edit bar are handled by ONE delegated `document`
      // click listener (see wireBlockSelection() below), so this
      // now-un-wrapped block is already clickable again by construction.
    }

    // §10-gap fix (review): wraps restore() — restore() NEVER commits
    // anything to `lines` (only decorative DOM), so for THIS block, any
    // call to it (Escape, ✕, or the auto-cancel-on-unchanged-blur path in
    // resolveOpenSession()) means `lines` still holds EXACTLY whatever was
    // there when this editor opened. For a pristine, just-inserted code
    // block, that's still the untouched skeleton — auto-remove it, same as
    // every other block type's abandon path. Used at every restore() call
    // site below so there's exactly ONE place this check lives.
    async function cancelAndMaybeDiscard() {
      const wasPristineForThisBlock = !!(pristineInsert && pristineInsert.blockId === blockId);
      if (wasPristineForThisBlock) pristineInsert = null;
      restore();
      if (wasPristineForThisBlock) return await discardPristineInsert();
      return true;
    }

    // Returns true when the editor is resolved (committed, or a no-op
    // commit that fell back to a cancel) — safe for a caller (switchAwayFrom
    // included) to proceed. Returns false only when the render actually
    // failed: the optimistic edit is rolled back from `lines`/the undo
    // stack, but — unlike the old behavior — the editor is left OPEN with
    // the user's text untouched (state consistency over convenience: a
    // network hiccup must never silently discard what they typed). The
    // failure banner is already shown by safeRerenderAll()/rerenderAll().
    async function commit() {
      const result = commitEdit({ lines, blocks, stack }, blockId, ta.value);
      if (result.op === null) {
        // §10-gap fix (review): an explicit commit (Ctrl+Enter/✓) whose
        // text happens to be byte-identical to `source` is still an
        // "unchanged" exit for THIS block — same auto-remove contract as
        // every other restore() call site.
        return await cancelAndMaybeDiscard();
      }
      const prevLines = lines;
      lines = result.lines;
      const ok = await safeRerenderAll();
      if (!ok) {
        // Roll back the optimistic edit: pop the op safeRerenderAll's
        // failure means was never actually rendered, so `lines` stays
        // consistent with what the server actually has. Deliberately does
        // NOT call restore() — the editor (and the user's unsaved text)
        // stays open and visible; see the comment above.
        lines = rollbackFailedRender({ lines, stack }, result, prevLines);
        return false;
      }
      // Success: rerenderAll() already replaced the whole .content subtree
      // (this block included) and nulled `activeEditor` itself — nothing
      // left to do here.
      return true;
    }

    ta.addEventListener('input', () => autoSize(ta));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelAndMaybeDiscard();
      }
    });
    commitBtn.addEventListener('click', commit);
    cancelBtn.addEventListener('click', cancelAndMaybeDiscard);
  }

  // ── Phase-2 Task 3: paragraph / heading WYSIWYG editing ────────────────
  // A block's rendered content is the .ed-block's single element child
  // (see lib/md2doc.js's editMode wrapper: `<div class="ed-block"
  // ...>${inner}</div>` where `inner` is exactly one <p>/<h#>/... tag).
  // Per-li exception (Task 6 / Phase 4): for data-block-type="li" the block's
  // editable content is its child <div class="ed-li-text">, not
  // firstElementChild — S1 made that distinction load-bearing rather than
  // merely defensive, since a flat list block's FIRST element child is always
  // the .ed-li-marker span (and the .ed-li-check span may follow it).
  function blockContentEl(blockEl) {
    if (blockEl.getAttribute && blockEl.getAttribute('data-block-type') === 'li') {
      // Walk childNodes for the DIV with class ed-li-text (Task 4 shape).
      const children = blockEl.childNodes;
      for (let i = 0; i < children.length; i++) {
        const n = children[i];
        if (n.nodeType === 1 && n.nodeName === 'DIV' &&
            n.classList && n.classList.contains('ed-li-text')) {
          return n;
        }
      }
      return null;
    }
    return blockEl.firstElementChild;
  }

  // Headings render with a trailing `<a class="heading-anchor">#</a>`
  // permalink icon INSIDE the <h#> tag (lib/md2doc.js's renderer.heading) —
  // presentational chrome, not authored content. It must never reach the
  // inline serializer: an anchor whose text is the literal "#" doesn't match
  // the citation shape (`/^\[.*\]$/`), so inline-md.js's serializeAnchor()
  // would emit it as a bogus trailing markdown link on every heading commit
  // instead of flagging it unsupported. Mutates `el` in place (safe to call
  // on a throwaway clone for the non-mutating eligibility probe below, or on
  // the real live element right before it becomes contenteditable).
  function stripHeadingAnchor(el) {
    const a = el.querySelector(':scope > a.heading-anchor');
    if (a) a.remove();
    return el;
  }

  // Non-mutating eligibility check used at the ✎ button's routing decision —
  // clones the content element so a block that turns out ineligible (falls
  // back to raw-edit) is never touched.
  function canWysiwygForBlock(blockEl, blockType) {
    const el = blockContentEl(blockEl);
    if (!el) return false;
    const probe = blockType === 'heading' ? stripHeadingAnchor(el.cloneNode(true)) : el;
    return inlineMd.canWysiwyg(probe);
  }

  // Phase-2 Task 5: same "check before ever opening the editor" contract as
  // canWysiwygForBlock() above, for a <table> element — Global Constraint:
  // any single unsupported cell degrades the WHOLE table to raw-edit, never
  // a partial/half-broken cell session. No cloneNode() needed here (unlike
  // the heading case above): serializeTable() never mutates its input.
  function canWysiwygForTable(tableEl) {
    return !!tableEl && tableMd.serializeTable(tableEl).unsupported.length === 0;
  }

  // Task 6 (Phase 4): per-li eligibility check — serialize THIS block alone
  // and refuse to arm it if anything in it cannot round-trip. Returns false
  // when any inline content is unsupported, so one bad item never degrades its
  // siblings.
  //
  // S1: no probe element is built any more. Pre-S1 this had to clone the <li>
  // into a synthetic UL/OL because serializeList() only took a list ROOT;
  // serializeBlocks() takes the block elements directly, so the live element
  // is passed as a one-element run. Both halves of the result are checked:
  // `unsupportedByLi` carries the per-block inline names, `unsupported` is its
  // strict superset (it additionally collects stray TEXT, foreign children,
  // and — flat model, controller note T2-B — the 'P' of a loose item, which
  // reaches the inline serializer as an ordinary unhandled element name).
  //
  // STRUCTURAL_ONLY names are excluded. 'MULTILINE' (a hard-wrapped item, which
  // legitimately owns a RANGE of lines) is reported so the structural gate can
  // refuse Tab / Enter on it, but spec §4.1 keeps text editing unaffected — and
  // arming IS text editing. Roughly a fifth of real-world list items are
  // hard-wrapped, so treating the flag as an arming veto turns whole documents
  // read-only. Filtered by NAME LIST rather than by a hard-coded string so the
  // serializer stays the single source of truth.
  function armBlockingNames(unsupported) {
    return unsupported.filter((n) => listMd.STRUCTURAL_ONLY_UNSUPPORTED.indexOf(n) === -1);
  }

  // A block that owns NO SOURCE LINE has nothing to edit, and arming it is
  // actively destructive. Under same-line nesting ('- - b') the outer item's
  // content begins with its child, so blockmap.js gives it
  // endLine === startLine - 1 — an empty range, not an interval. The commit
  // helpers do not special-case that: the per-li degrade path (taken whenever
  // the run holds a loose or hard-wrapped item) hands
  // editedBlock.startLine/endLine straight to commitRangeEdit(), whose
  // replaceLines() computes `slice(0, start-1).concat(new, slice(end))` — with
  // end < start those two slices OVERLAP, so the original line survives AND the
  // new one is inserted:
  //
  //   '# D\n\n- a\n\n- - b\n'  --type Z-->  '# D\n\n- a\n\n- Z\n- - b\n'
  //
  // Refusing here closes every such path with one rule, instead of teaching
  // seven commit helpers about a range shape none of them expect. The block is
  // still rendered, still selectable, and its CHILD — which does own its line —
  // stays fully editable.
  function blockOwnsNoLine(blockEl) {
    const raw = blockEl.getAttribute('data-block-id');
    if (raw === null) return false; // provisional block: no record yet, not our call
    const rec = blocks.find((b) => b.id === Number(raw));
    return !!rec && rec.endLine < rec.startLine;
  }

  // Task 4 fix round 1: the message the two blockOwnsNoLine() guards above
  // (openRawEditor / deleteBlockViaGutter) pass into the SHARED
  // refuseStructuralListEdit() helper (defined further down, next to
  // listRunSupportsStructuralEdit() — see its comment for why this is a
  // parameter and not a second function). One constant so both call sites
  // stay byte-identical instead of two hand-typed copies drifting apart.
  const NO_SOURCE_LINE_MESSAGE = '此項目沒有自己的來源行，無法刪除或直接編輯';
  // T7 fix round 1 (LOW-2): insertBlockBelow()'s own wording. A second
  // constant rather than a reuse, because the one above NAMES the two
  // operations it refuses — an insert that answered '無法刪除' would be
  // telling the user something that is not true of the button they pressed.
  const NO_SOURCE_LINE_INSERT_MESSAGE = '此項目沒有自己的來源行，無法在其後插入區塊';

  // The list markers standing at the head of one source line, left to right.
  // A same-line nest ('- 1. b') puts one marker per nesting level on the line;
  // this reads them back so a re-emitted ancestor line can keep the bullet
  // character / ordinal delimiter the file already uses. Stops at the first
  // non-marker, so the last entry is the innermost item's own marker.
  function sourceMarkerChain(line) {
    const out = [];
    let rest = typeof line === 'string' ? line : '';
    for (;;) {
      // The optional trailing group is a GFM task checkbox: it is CONTENT, not
      // marker, but it sits between this marker and the next one, so the walk
      // has to step over it or the chain stops at the first task item.
      const m = /^(\s*)(?:([-*+])|(\d{1,9})([.)]))(\s+)(?:\[[ xX]\]\s+)?/.exec(rest);
      if (!m) return out;
      out.push({ bullet: m[2] || null, delim: m[4] || null });
      rest = rest.slice(m[0].length);
    }
  }

  // Rewrites a serialized marker to use the SOURCE's bullet char / ordinal
  // delimiter, keeping the serializer's own width and ordinal. Both
  // substitutions are single characters, so the marker's column count — which
  // the child's indent prefix was computed against (spec §3.4) — cannot move.
  //
  // Why not just keep the serializer's canonical '-' / '1.': the degrade path
  // rewrites ONE line and leaves its siblings' bytes alone, and marked starts a
  // NEW list token at a bullet-char or delimiter change. Canonicalising this
  // line alone therefore splits the surrounding list in two ('+ a' + '- …'),
  // which is a visible change to items the user never edited.
  // Takes the BULLET ('- ', '2. '), never the whole marker: a task item's
  // marker is bullet + checkbox ('1. [ ] '), and the ordinal delimiter is then
  // no longer at the end of the string for the substitution to find.
  function bulletInSourceStyle(bullet, src) {
    if (!src) return bullet;
    if (src.bullet) return /^[-*+]/.test(bullet) ? src.bullet + bullet.slice(1) : bullet;
    if (src.delim) return bullet.replace(/([.)])(\s*)$/, src.delim + '$2');
    return bullet;
  }


  // Round 5 — the other half of the same-line-nesting problem. Refusing to ARM
  // a zero-line block (above) keeps it from being the TARGET of a commit; it
  // does nothing about the fact that its marker physically STANDS ON its
  // child's source line. '- - b' is one line carrying two markers, and the
  // child's own line range IS that line — so the per-li degrade path, which
  // replaces [editedBlock.startLine, editedBlock.endLine] with only the lines
  // lineMeta attributes to the edited block, overwrote every ancestor marker
  // standing on it:
  //
  //   '# D\n\n- a\n\n- - b\n'  --type Z-->  '# D\n\n- a\n\n  - bZ\n'
  //
  // The child lost its parent — a semantic change (the previous item swallows
  // it), not a reformat.
  //
  // So the replacement re-emits every such ancestor's MARKER on a line of its
  // own, ahead of the edited block's lines. That is the canonical form the
  // whole-run path already produces for a tight run ('- a\n-\n  - b'), it
  // round-trips ('-\n  - b' and '- - b' are the same tree to marked), and it
  // removes the zero-line shape from the file, so the ancestor becomes armable
  // afterwards.
  //
  // A content-free TASK ancestor is NOT in this list, and must not be: marked
  // only reads '[ ]' / '[x]' as a checkbox when content follows on the SAME
  // line, so a line of its own would downgrade it to literal text. Round 6
  // moved that case into the serializer, which now carries such an item as a
  // prefix on its child's line — so it emits no lineMeta entry of its own and
  // this walk never sees it, while the child's own emitted line (which the
  // caller slices anyway) already carries its marker. The two forms therefore
  // stay in one place: lib/editor/list-md.js decides, this only replays.
  //
  // MARKER ONLY, never the ancestor's emitted line: an item whose own content
  // resumes AFTER its child ('- - b' … '  tail') owns that content on a line
  // OUTSIDE this commit range, so emitting the serializer's full line for it
  // would duplicate the text. Its indent prefix and marker WIDTH come from
  // lineMeta's own record rather than from a guess — an ordered outer
  // contributes three columns, not two (spec §3.4's errata table) — while the
  // bullet CHARACTERS are taken back from the source line.
  //
  // Only ancestors whose startLine EQUALS the edited block's are collected:
  // that is what "stands on the same source line" means. A zero-line ancestor
  // higher up the document, or one belonging to an earlier sibling, names a
  // different line and must not be touched.
  function sharedMarkerLinesBefore(lineMeta, firstIdx, editedBlock) {
    const out = [];
    // The markers on that source line are its nesting levels, outermost first,
    // and the LAST one is the edited block's own — so a block's marker is found
    // by its DEPTH, not by counting the entries collected here. A task ancestor
    // occupies a marker on the line while contributing no lineMeta entry at
    // all (see above), which is exactly what a running counter would misalign.
    const chain = sourceMarkerChain(lines[editedBlock.startLine - 1]);
    const base = editedBlock.indent - (chain.length - 1);
    for (let k = 0; k < firstIdx; k++) {
      const m = lineMeta[k];
      if (!m || m.blockId === null || m.blockId === undefined) continue;
      const rec = blocks.find((b) => b.id === Number(m.blockId));
      if (!rec || rec.endLine >= rec.startLine) continue; // owns a line of its own
      if (rec.startLine !== editedBlock.startLine) continue;
      const marker = bulletInSourceStyle(m.marker, chain[rec.indent - base]);
      out.push((m.indentPrefix + marker).replace(/\s+$/, ''));
    }
    return out;
  }

  function canWysiwygForLi(blockEl) {
    if (!blockEl) return false;
    if (blockOwnsNoLine(blockEl)) return false;
    const res = listMd.serializeBlocks([blockEl]);
    return armBlockingNames(res.unsupported).length === 0 && res.unsupportedByLi.length === 0;
  }

  // ── S1: one run scan replaces every "walk up to the outermost UL/OL" ─────
  // The flat model has no <ul>/<ol> nodes left to walk up to: every list item
  // is a sibling `.ed-block[data-block-type="li"]` and its depth is
  // `data-indent`. Six helpers used to reach the enclosing list by DOM
  // ancestry; they all now go through the scan below.
  //
  // RUN (spec §3.8): the sibling items bound to the same parent item. Scanning
  // outward from a block, a run ends at the first li with a SMALLER indent, at
  // the first same-indent li whose data-list-type differs, or at the first
  // non-li block. DEEPER items never break the run — they are descendants of
  // one of its members.
  //
  // Rules (a)/(b)/(c) are bit-for-bit the rule lib/editor/list-md.js's
  // serializeBlocks() applies internally when it restarts an ordinal. If the
  // two ever disagree, the symptom is a wrong ordinal or a wrong commit range.
  //
  // Rule (d) — a run never crosses a `data-list-start="1"` — has no counterpart
  // in serializeBlocks() because it never needs one: §3.8's three rules cannot
  // tell two ADJACENT top-level lists of the same type apart (marked emits a
  // fresh list token for a bullet-char change, so '- a' followed by '* c' is
  // two lists whose blocks are all indent 0 / type ul), and before flattening
  // the two <ul> roots carried that distinction. lib/md2doc.js's renderer
  // stamps the boundary; this scan honours it, so serializeBlocks() is never
  // handed a span that straddles two lists and the two can never disagree on a
  // span that actually reaches it.

  function allBlockEls() {
    return Array.prototype.slice.call(contentEl.querySelectorAll('.ed-block'));
  }

  function liAttrs(el) {
    if (!el || !el.getAttribute || el.getAttribute('data-block-type') !== 'li') return null;
    return {
      el: el,
      indent: Number(el.getAttribute('data-indent')) || 0,
      listType: el.getAttribute('data-list-type') === 'ol' ? 'ol' : 'ul',
      listStart: el.getAttribute('data-list-start') === '1',
    };
  }

  // The nearest li `.ed-block` ancestor of `node` (inclusive), or null.
  // Text nodes are legal input (Selection boundary points are usually text
  // nodes), so this walks parentNode by hand rather than using .closest().
  function closestLiBlock(node) {
    let n = node;
    while (n) {
      if (n.nodeType === 1 && n.getAttribute &&
          n.classList && n.classList.contains('ed-block') &&
          n.getAttribute('data-block-type') === 'li') return n;
      n = n.parentNode;
    }
    return null;
  }

  // Spec §3.8's run of `blockEl`, as an array of block elements in document
  // order. Empty when `blockEl` is not a live li block.
  function runBlocksOf(blockEl) {
    const self = liAttrs(blockEl);
    if (!self) return [];
    const all = allBlockEls();
    const i = all.indexOf(blockEl);
    if (i < 0) return [];
    const out = [blockEl];
    if (!self.listStart) {
      for (let k = i - 1; k >= 0; k--) {
        const a = liAttrs(all[k]);
        if (!a || a.indent < self.indent) break;
        if (a.indent === self.indent) {
          if (a.listType !== self.listType) break;
          out.unshift(all[k]);
        }
        // Rule (d), scoped to THIS depth. A list-start DEEPER than `self` is a
        // nested sublist hanging off one of the run's own members — it must not
        // end the run it lives inside. Only a list-start at `self`'s depth (or
        // shallower, already handled above) is a boundary for this run.
        if (a.listStart && a.indent <= self.indent) break;
      }
    }
    for (let k = i + 1; k < all.length; k++) {
      const a = liAttrs(all[k]);
      if (!a || a.indent < self.indent) break;
      if (a.listStart && a.indent <= self.indent) break; // rule (d), this depth
      if (a.indent === self.indent) {
        if (a.listType !== self.listType) break;
        out.push(all[k]);
      }
    }
    return out;
  }

  // The COMMIT UNIT for any list edit: the contiguous block span made up of
  // the OUTERMOST run reachable from `blockEl` plus every descendant of that
  // run's members. Returned in document order; empty when `blockEl` is not a
  // live li block.
  //
  // Why the outermost run and not `blockEl`'s own: serializeBlocks() rebuilds
  // the marker-width stack (spec §3.4) as it walks, so a span that STARTS at
  // indent 2 has no width recorded for depths 0 and 1 and emits its first line
  // with NO indent at all — i.e. committing a nested run on its own would
  // promote it to top level and destroy the nesting. Starting at the outermost
  // depth is also exactly what the pre-S1 code did (listRunRootOf() walked up
  // to the UL/OL whose parent was not an <li>, i.e. the whole top-level list),
  // so the committed byte ranges are unchanged by the flattening.
  //
  // What DID change — deliberately, per spec §3.8 rule (b) — is that two
  // adjacent top-level lists of DIFFERENT type are two spans. Pre-S1 they were
  // already two separate <ul>/<ol> roots, so this is the same behaviour
  // expressed without the containers.
  function listRunOf(blockEl) {
    const self = liAttrs(blockEl);
    if (!self) return [];
    const all = allBlockEls();
    const i = all.indexOf(blockEl);
    if (i < 0) return [];
    // 1. Walk back to the shallowest li that still owns `blockEl` — its
    //    outermost ancestor item. Stops at the first non-li block.
    // The walk stops on its own the moment it reaches indent 0, which is where
    // every list token's first item sits — so it can never cross into the
    // PREVIOUS list, and rule (d) needs no break of its own here. It must NOT
    // be skipped for a list-start block at indent > 0: that is a NESTED list's
    // first item, whose outermost ancestor is still above it in the same list,
    // and returning a nested-only span would emit the run with no indent
    // prefix at all — i.e. de-nest it on commit.
    let anchor = i;
    let anchorIndent = self.indent;
    for (let k = i - 1; k >= 0 && anchorIndent > 0; k--) {
      const a = liAttrs(all[k]);
      if (!a) break;
      if (a.indent < anchorIndent) { anchor = k; anchorIndent = a.indent; }
    }
    // 2. That ancestor's own §3.8 run gives the span's first and last MEMBER.
    const run = runBlocksOf(all[anchor]);
    if (!run.length) return [];
    const startIdx = all.indexOf(run[0]);
    let endIdx = all.indexOf(run[run.length - 1]);
    // 3. Extend past the last member to cover its subtree.
    // `a.indent <= anchorIndent` already stops at the next list token's first
    // item (every token starts at indent 0 relative to its own nesting), so no
    // separate rule-(d) break belongs here — and a DEEPER list-start is a
    // nested sublist of the last run member, which the span must include.
    for (let k = endIdx + 1; k < all.length; k++) {
      const a = liAttrs(all[k]);
      if (!a || a.indent <= anchorIndent) break;
      endIdx = k;
    }
    return all.slice(startIdx, endIdx + 1);
  }

  // Returns { startLine, endLine, firstId } for a run span (as returned by
  // listRunOf()), looked up in state.blocks by data-block-id. Document order is
  // monotonic in block id, so first/last suffices.
  //
  // A span may contain a PROVISIONAL block — splitListItemAtCaret()'s new item,
  // which has no data-block-id because it does not exist in `lines` yet. Those
  // are skipped: the range is the source lines the span currently OCCUPIES, and
  // a provisional block occupies none. (Pre-S1 this fell out for free because
  // the provisional <li> carried no `ed-block` class and the querySelectorAll
  // never saw it; the flat model needs it to be a real block element, so the
  // skip has to be explicit.) Returns null when no member is resolvable.
  function runRangeOfBlocks(state, runEls) {
    if (!runEls || !runEls.length) return null;
    const resolved = [];
    runEls.forEach((el) => {
      const raw = el.getAttribute('data-block-id');
      if (raw === null) return;
      const b = state.blocks.find((x) => x.id === Number(raw));
      if (b) resolved.push(b);
    });
    if (!resolved.length) return null;
    const firstBlock = resolved[0];
    const lastBlock = resolved[resolved.length - 1];
    return { startLine: firstBlock.startLine, endLine: lastBlock.endLine, firstId: firstBlock.id };
  }

  // Convenience wrapper kept at the old call shape: takes any node inside a
  // list item and resolves its own commit span's line range.
  function runRangeOf(state, node) {
    return runRangeOfBlocks(state, listRunOf(closestLiBlock(node)));
  }

  // Re-derives `data-run-start` across the whole document. The attribute is
  // pure CSS chrome (Task 5 resets the ordered counter on it) and no
  // serializer reads it, but a structural key changes indents WITHOUT a
  // re-render for the duration of the commit's round trip, so leaving it stale
  // would show wrong ordinals for that window. Same rule as the renderer's
  // liRunStartsHere() and serializeBlocks()'s own ordinal restart.
  function refreshRunStarts() {
    const all = allBlockEls();
    let prev = null;
    const types = [];
    all.forEach((el) => {
      const a = liAttrs(el);
      if (!a) { prev = null; types.length = 0; return; }
      // Rule (d): a new list token always opens a new run, and closes the runs
      // open AT ITS OWN DEPTH AND DEEPER — never the shallower ones, which
      // belong to the list this token is nested inside. data-list-start is
      // renderer-owned and never rewritten here: it is the only carrier of the
      // boundary between two adjacent same-type list tokens.
      if (a.listStart) types.length = Math.min(types.length, a.indent);
      const isStart = !prev || a.indent > prev.indent || types[a.indent] !== a.listType;
      for (let k = types.length - 1; k > a.indent; k--) types[k] = undefined;
      types[a.indent] = a.listType;
      prev = a;
      if (isStart) el.setAttribute('data-run-start', '1');
      else el.removeAttribute('data-run-start');
    });
  }

  // The single place a block's depth is written: `data-indent` is what every
  // serializer and scan reads, and `--ed-indent` is the CSS mirror the flat
  // renderer emits alongside it. Writing one without the other makes the
  // screen disagree with the model for the length of a commit round trip.
  function setBlockIndent(blockEl, indent) {
    blockEl.setAttribute('data-indent', String(indent));
    blockEl.style.setProperty('--ed-indent', String(indent));
  }

  // Spec §3.4, applied to the DOM: hand the (already-mutated) commit span to
  // the pure clamp in lib/editor/indent-clamp.js and write back whatever it
  // says. `opBlockEl` is the block the gesture moved, `opOldIndent` its indent
  // BEFORE the move (the spec's global convention).
  //
  // Scoped to the commit SPAN, never to the whole document: the span is
  // exactly the set of blocks the following commit re-serializes, so a clamp
  // confined to it can never widen the byte range an operation touches. On a
  // document that was legal to begin with — which is every document, since
  // data-indent is derived from marked's own nesting — this is a no-op, and it
  // is meant to be. It is here so the ONE definition of "legal indent" lives
  // in one testable place instead of being re-derived by each key handler.
  //
  // Blocks are matched by data-block-id, so a PROVISIONAL block (a split's new
  // item, id-less) is passed through untouched rather than being addressed by
  // position.
  // `opts` is handed straight to clampIndents() — today only `{ removed: true }`,
  // used by the ⠿ delete below, which must clamp the span it is ABOUT to take a
  // member out of. The span passed in therefore still CONTAINS `opBlockEl` (it
  // has to: `opIndex` is an index into it, and rule 2's scope starts after it);
  // clampIndents() reports no indent for a removed block, so the write-back
  // below never touches the element that is on its way out.
  //
  // S3 Task 6: `opBlockEl` may also be an ARRAY — spec §3.4 rule 3's multi-block
  // operation, which clampIndents() has accepted since S1 (`opIndex` may be an
  // array of indices). `opOldIndent` is then the SMALLEST old indent in the set,
  // never the first member's: §3.4 rule 3 records both ways the first member
  // goes wrong (a delete drives a later member to indent −1; a batch Tab whose
  // first member is already at its ceiling no-ops the whole set). The caller
  // computes it with spanMinIndent(). A member that is not in `spanEls` aborts
  // the whole clamp rather than clamping a subset — a partial op set makes rule
  // 2's scope start in the wrong place, which is a silent wrong answer.
  function applyIndentClamp(spanEls, opBlockEl, opOldIndent, opts) {
    if (!indentClamp || !spanEls || !spanEls.length) return;
    const opEls = Array.isArray(opBlockEl) ? opBlockEl : [opBlockEl];
    const opIndex = [];
    for (let k = 0; k < opEls.length; k++) {
      const at = spanEls.indexOf(opEls[k]);
      if (at < 0) return;
      opIndex.push(at);
    }
    if (!opIndex.length) return;
    const model = spanEls.map((el, i) => ({
      id: i, // index-as-id: the span IS the universe here
      type: el.getAttribute('data-block-type') === 'li' ? 'li' : 'other',
      indent: Number(el.getAttribute('data-indent')) || 0,
    }));
    indentClamp.clampIndents(model, opIndex, opOldIndent, opts || {}).forEach((r) => {
      const el = spanEls[r.blockId];
      if (el && (Number(el.getAttribute('data-indent')) || 0) !== r.indent) {
        setBlockIndent(el, r.indent);
      }
    });
  }

  function placeCaretAtEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Paste handler support: insert plain text at the caret via Range surgery,
  // keeping the serializer's input domain closed to plain text + the inline
  // elements it itself produces (bold/italic/code/links/br) — see the brief's
  // "Paste" rule.
  //
  // Final-review Finding 1: pasted text containing a newline used to land
  // verbatim in ONE text node, so a paste into a table cell produced a text
  // node whose textContent itself contained '\n' — table-md.js's
  // serializeRow() had no reason to expect that (a cell newline was only
  // ever supposed to arrive as a real <br> node, same as Shift+Enter's
  // insertBrAtCaret() below) and emitted it raw, splitting one table row
  // into a spec-forbidden orphan cell line. Split on any newline sequence
  // and insert a real <br> element between segments — the SAME DIV/BR
  // policy walkChildren() (inline-md.js) already round-trips, so this is
  // consistent with how Shift+Enter's own <br> already behaves, not a new
  // code path. table-md.js also gained a defense-in-depth backstop for any
  // other caller that still lands a raw '\n' in a text node (see
  // escapeNewlines() there) — this is the primary fix, that's the belt.
  function insertTextAtCaret(text) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const segments = String(text).split(/\r\n|\r|\n/);
    segments.forEach((seg, i) => {
      if (i > 0) {
        const br = document.createElement('br');
        range.insertNode(br);
        range.setStartAfter(br);
        range.setEndAfter(br);
      }
      const node = document.createTextNode(seg);
      range.insertNode(node);
      range.setStartAfter(node);
      range.setEndAfter(node);
    });
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Shift+Enter support: insert a literal <br> at the caret via Range
  // surgery — inline-md.js's walkChildren() serializes a <br> node straight
  // back to `<br>` markdown, so this round-trips without going through the
  // DIV-boundary path (that's for browsers' own line-split artifacts, not
  // something this editor ever produces itself).
  function insertBrAtCaret() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const br = document.createElement('br');
    range.insertNode(br);
    range.setStartAfter(br);
    range.setEndAfter(br);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Heading ± buttons on the bar: a pure source-level transform (just the
  // leading `#` run) via the SAME commitEdit()/replaceLines() pipeline as
  // every other edit, then a full re-render — deliberately independent of
  // whatever the inline serializer thinks of the heading's prose content.
  // switchAwayFrom() first resolves any editor that's currently open on this
  // (or another) block, same precondition as undo()/redo() below, so this
  // never races a concurrent commit or operates on stale `lines`/`blocks`.
  async function changeHeadingDepth(blockEl, delta) {
    if (!blockEl) return;
    const blockId = Number(blockEl.getAttribute('data-block-id'));
    // Commits (never discards) whatever burst/editor is open first — same
    // precondition undo()/redo() use below, so this never races a concurrent
    // commit or operates on stale `lines`/`blocks`. Task 2 (Phase 3): this
    // now also resolves an open always-on WYSIWYG burst on THIS same block
    // (the ⠿ menu's ±  buttons can be clicked while its own heading is
    // mid-edit) via switchAwayFrom()'s extended resolveOpenSession().
    const ok = await switchAwayFrom();
    if (!ok) return;
    // Final-review Finding 5c (Important): with 5a's mousedown
    // preventDefault() now keeping the ⠿ click from blurring a dirty
    // burst, THIS is where that same dirty burst (on this heading's own
    // block) actually gets resolved — the `switchAwayFrom()` above commits
    // it, whose rerenderAll() swaps the WHOLE `.content` subtree, detaching
    // the ORIGINAL `blockEl` this function was called with. The old
    // `!document.body.contains(blockEl)` check treated that as "gone,
    // nothing to do" and silently no-opped — which is exactly the
    // dirty-heading-then-± regression 5a's fix would otherwise introduce
    // (before 5a, the ± click's OWN mousedown had already committed the
    // burst and swapped the DOM before this ran, so `blockEl` was ALREADY
    // stale on every such click, just via a different, race-dependent
    // path — this bug pre-dates 5a, 5a just makes it deterministic). Same
    // stale-node recovery the focusin listener's own re-resolve branch
    // uses above: re-query the LIVE block by id rather than trusting the
    // original reference.
    if (!document.body.contains(blockEl)) {
      blockEl = document.querySelector('.ed-block[data-block-id="' + blockId + '"]');
      if (!blockEl) return;
    }
    const block = blocks.find((b) => b.id === blockId);
    if (!block) return;
    const curLine = lines[block.startLine - 1];
    const curDepth = headingDepthOf(curLine);
    const newDepth = Math.max(1, Math.min(6, curDepth + delta));
    if (newDepth === curDepth) return;
    const newLine = withHeadingDepth(curLine, newDepth);
    const result = commitEdit({ lines, blocks, stack }, blockId, newLine);
    if (result.op === null) return;
    const prevLines = lines;
    lines = result.lines;
    const okRender = await safeRerenderAll();
    if (!okRender) {
      lines = rollbackFailedRender({ lines, stack }, result, prevLines);
    }
  }

  // ── Task 2 (Phase 3): always-on WYSIWYG editing + burst undo ───────────
  // Retires the Phase-2 click-select-then-✎ flow for paragraph/heading
  // blocks: every WYSIWYG-eligible one is contenteditable from the moment
  // it lands in the DOM (armEditables() below, run once at load and again
  // after every rerenderAll() swap). Click = native caret placement — no
  // "open" step. Focusing such a surface starts a "burst" (a short-lived
  // undo/redo scope backed by lib/editor/history.js's createBurstHistory());
  // focusing away from it resolves the burst exactly like the old
  // activeEditor did (commit if changed, silently drop if not) via
  // switchAwayFrom()/resolveOpenSession() above — table cells and the raw
  // textarea editor are untouched, they keep using `activeEditor` as before.
  //
  // Listener discipline (the brief's hard requirement, institutionalizing
  // the Task-3-P2 listener-leak lesson): every one of these surfaces is
  // armed identically and wired through exactly ONE delegated document-level
  // focusin / focusout / keydown / paste / input listener set (registered
  // once, at the bottom of this file) gated by the `.ed-wys-armed` class —
  // never a per-block addEventListener that could re-stack across repeated
  // open/close cycles.
  function blockDepthOf(blockType, editEl) {
    return blockType === 'heading' ? Number(editEl.tagName.slice(1)) : null;
  }

  // Arms every WYSIWYG-eligible paragraph/heading/list/table in `root` as an
  // always-on editable surface, and gives every block (eligible or degraded
  // alike) a ⠿ handle in its left gutter. Run once at load and again after
  // every rerenderAll() swap (fresh DOM, nothing armed yet).
  // Idempotent-by-construction: only ever called against a freshly-rendered
  // subtree that has never been armed before.
  function armEditables(root) {
    const blockEls = Array.prototype.slice.call(root.querySelectorAll('.ed-block'));
    blockEls.forEach((blockEl) => {
      const blockType = blockEl.getAttribute('data-block-type');
      const editEl = blockContentEl(blockEl);
      if (editEl && (blockType === 'paragraph' || blockType === 'heading') &&
          canWysiwygForBlock(blockEl, blockType)) {
        // Heading permalink anchors are presentational chrome, never
        // authored content (see stripHeadingAnchor()'s own comment) — strip
        // them at arm time so they never become part of what's typed/
        // selected/serialized. Never re-inserted by hand: the markdown they
        // came from never referenced them, and the NEXT full rerenderAll()
        // regenerates them fresh from the server (then immediately strips
        // them again on re-arm) — "restored in serialization" in the brief
        // refers to exactly this round trip, not a DOM patch-back here.
        if (blockType === 'heading') stripHeadingAnchor(editEl);
        editEl.setAttribute('contenteditable', 'true');
        editEl.classList.add('ed-wys-armed');
      } else if (blockType === 'li') {
        // Task 6 (Phase 4): per-li arming. Each
        // `.ed-block[data-block-type="li"]` is armed independently: only its
        // own .ed-li-text div becomes
        // contenteditable when canWysiwygForLi holds, so one unsupported item
        // does not degrade its siblings.
        if (editEl && canWysiwygForLi(blockEl)) {
          editEl.setAttribute('contenteditable', 'true');
          editEl.classList.add('ed-wys-armed');
        }
        // S1: the li now gets the same ⠿ as every other block, at every
        // indent depth. This is only safe because list-md.js's
        // serializeBlocks() skips the chrome BY CLASS TOKEN (its LI_CHROME
        // allowlist) — if that allowlist is ever narrowed, every <button>
        // here reaches the inline serializer as content, every li reports
        // 'BUTTON' unsupported and the WHOLE document degrades read-only.
        //
        // S2 Task 7 (§6's S1 note item 3, 「＋ 對 li 在 S1 隱藏，S2 解除」): the
        // ＋ is back, in the same order as every other type. What S1 was
        // waiting for is now true — insertBlockBelow() gates a li anchor on
        // listRunSupportsStructuralEdit(), anchors the insertion at the end of
        // the anchor's SUBTREE (so a parent's children are never straddled),
        // and takes the 清單 kind through the run's own re-serialization, which
        // is where §3.4's marker-width stack lives. '.ed-insert' is already in
        // list-md.js's LI_CHROME allowlist, so this adds no NEW element type
        // for serializeBlocks() to report as unsupported — the `clean` probe in
        // the S1 li-gutter scenario is what actually holds that.
        blockEl.appendChild(buildGutterInsertButton());
        blockEl.appendChild(buildGutterHandle());
        return;
      } else if (editEl && blockType === 'table' && canWysiwygForTable(editEl)) {
        // Task 5 (Phase 3): table cells armed PERMANENTLY at arm time
        // (Global Constraint — replaces Phase-2's click-to-open session).
        // Every TH/TD becomes its OWN contenteditable surface (class
        // 'ed-wys-cell'), unlike the list/paragraph single-content-root
        // arming above, because a table has many independently-editable
        // cells — but the BURST still spans the WHOLE table
        // (currentBurst.editEl === the <table> element, never any one
        // cell; see startTableBurst() below), so Tab/click between cells
        // never ends it, only leaving the TABLE does. The TABLE root
        // itself gets the marker class 'ed-wys-table' (never
        // contenteditable itself — a <table> can't sensibly host a caret)
        // so the click delegator and the hover-insert overlay below can
        // recognize an armed table without walking its cells.
        editEl.classList.add('ed-wys-table');
        tableCellsOf(editEl).forEach((cell) => {
          cell.setAttribute('contenteditable', 'true');
          cell.classList.add('ed-wys-cell');
        });
      }
      // Every block (armed or degraded — table included, since this task
      // retires the old `if (blockType === 'table') return` early exit)
      // gets the ⠿ handle — a real per-block DOM node (not a listener: see
      // buildGutterHandle()'s comment for why that's fine), appended AFTER
      // the content element so blockContentEl()'s firstElementChild lookup
      // is unaffected. §10-gap fix: and a ＋ insert button right alongside
      // it, same non-listener node shape, same reason.
      blockEl.appendChild(buildGutterInsertButton());
      blockEl.appendChild(buildGutterHandle());
    });
  }

  // A fresh ⠿ button per block — deliberately NOT wired with its own
  // addEventListener (that would be exactly the per-block listener the
  // brief's discipline rule forbids); the delegated document `click`
  // listener (wireBlockSelection() below) recognizes '.ed-handle' and
  // routes the click, so this node itself carries no JS at all.
  function buildGutterHandle() {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'ed-handle';
    el.textContent = '⠿';
    el.setAttribute('aria-label', '區塊選項');
    // v2.11.1: a <button> is a sequential focus stop, and there is one of
    // these plus one ＋ standing immediately after EVERY block — so any Tab
    // that reaches the browser walks straight into gutter chrome, which is the
    // most jarring shape of the two escape classes fixed above. Both are
    // mouse-only affordances with no keyboard contract of their own (the ⠿
    // menu is opened by click; nothing here is reachable or operable by
    // keyboard today), so they are removed from the tab order rather than
    // given one they do not have. tabindex="-1" keeps them programmatically
    // and click-focusable, so `.ed-handle:focus { opacity: 1 }` still works.
    el.setAttribute('tabindex', '-1');
    // Deliberately NOT wired with its own addEventListener here (see the
    // paragraph above) — including for Final-review Finding 5a's mousedown
    // preventDefault() (see wireBlockSelection()'s delegated 'mousedown'
    // listener below for that fix): a per-node listener attached HERE would
    // NOT survive openRawEditor()'s restore() (`blockEl.innerHTML =
    // original`, a plain string re-parse that recreates this button with
    // none of its own JS re-attached) the way the delegated 'click'
    // listener already does — the exact hazard this file's discipline rule
    // exists to prevent.
    return el;
  }

  // The single shared ⠿ menu (spec §3.7: 轉換成 › / 建立副本 / 刪除 / MD 原始碼)
  // — built once, moved into whichever block's DOM the user opened it on,
  // same pattern as `selToolbar` elsewhere in this file. `gutterMenuBlockEl`
  // names which block it's currently open for. Because the node is a
  // SINGLETON, every per-type visibility decision has to be re-applied on
  // each open (see toggleGutterMenu below), never set once at build time.
  //
  // S2: the heading ± pair is gone from here — §3.5 moved that gesture onto
  // Tab / Shift+Tab, which call the same changeHeadingDepth() this menu used
  // to. So is ✕: §3.7 closes the menu by Esc or an outside click, both of
  // which were already wired (the document-level keydown / click handlers
  // further down), so removing the button removes a button, not a capability.
  let gutterMenuBlockEl = null;
  let gutterMenuConvert, gutterMenuDuplicate, gutterMenuDelete, gutterMenuMd;
  // The 轉換成 submenu: a SECOND singleton, built lazily on demand and torn
  // down with the menu. It carries `ed-handle-menu` as well as its own class
  // so it inherits the panel's whole visual language AND so the document-level
  // outside-click handler's `closest('.ed-handle-menu')` exclusion covers it
  // without a second selector.
  let convertSubmenu = null;

  // ── v2.12.0 Task 4b, half 1: an icon at the head of every item ──────────
  // User request: 「選單每個功能開頭給一個圖示，完全照抄 notion」. Notion's
  // visual LANGUAGE, drawn here rather than their assets copied: 16x16 on a
  // 0 0 16 16 viewBox, 1.5px stroke, fill:none, round caps and joins, and
  // stroke="currentColor" so an icon is simply the colour of the row it sits
  // in — retheme .ed-handle-menu and the icons follow for free, which a hex
  // literal here would break silently.
  //
  // The menu is a SINGLETON built once at module scope and moved between
  // blocks, so this markup is parsed exactly once for the life of the page.
  // Nothing here may run per open.
  const MENU_ICON_PATHS = {
    // 轉換成 — a turn/redirect arrow: out to the right, then down. "this block
    // becomes that one".
    convert: '<path d="M2.5 4.5h6a3 3 0 0 1 3 3v4.6"/><path d="M9 9.6l2.5 2.5 2.5-2.5"/>',
    // 建立副本 — two offset rounded cards, the standard duplicate glyph. The
    // back card is an L-shaped outline rather than a second full rect so the
    // two do not draw a line through each other.
    duplicate: '<rect x="5.5" y="5.5" width="8" height="8" rx="2"/>' +
      '<path d="M10.5 5.5V4.5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h1"/>',
    // 刪除 — a trash can: lid, handle, tapered body, two ribs.
    trash: '<path d="M2.5 4.5h11"/>' +
      '<path d="M6.4 4.5V3.2a1.2 1.2 0 0 1 1.2-1.2h.8a1.2 1.2 0 0 1 1.2 1.2v1.3"/>' +
      '<path d="M4.2 4.5l.6 8.1a1.4 1.4 0 0 0 1.4 1.3h3.6a1.4 1.4 0 0 0 1.4-1.3l.6-8.1"/>' +
      '<path d="M6.6 7.2v4.2"/><path d="M9.4 7.2v4.2"/>',
    // MD 原始碼 — angle brackets: source, not prose.
    code: '<path d="M6 3.6L2 8l4 4.4"/><path d="M10 3.6L14 8l-4 4.4"/>',
  };
  function menuIconMarkup(name) {
    return '<svg class="ed-menu-icon" viewBox="0 0 16 16" width="16" height="16" ' +
      'aria-hidden="true" focusable="false" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      MENU_ICON_PATHS[name] + '</svg>';
  }

  // ── v2.12.0 Task 4b, half 2: the submenu opens on HOVER ─────────────────
  // User request: 「"轉換成" hover 沒有自動顯示子選單」.
  //
  // The naive "open on mouseenter, close on mouseleave" reproduces the gutter
  // corridor defect v2.11.1 had just finished fixing, and MEASURED on this
  // branch at 1400x900 it is worse than the plan predicted:
  //
  //   * `.ed-handle-submenu { left: 100%; margin-left: 4px }` over a menu with
  //     4px of padding leaves x in [item.right + 4, sub.left) — exactly 4
  //     device px on the item's own row — hit-testing to the BLOCK underneath.
  //     A mouseleave-closes rule shuts the panel while the pointer is inside
  //     that band, on its way in.
  //   * The far worse one: the submenu is 342px tall against the menu's 118px,
  //     so a straight line from 轉換成 to the panel's LAST row is 344px long
  //     and leaves the item/panel pair for 334ms at 1200px/s, 367ms at 600,
  //     535ms at 300 and 1068ms at 150 — first across 建立副本 / 刪除 /
  //     MD 原始碼, then across bare page BELOW the menu. No close delay covers
  //     that AND still shuts the panel promptly when the user really has
  //     settled on 刪除; the plan's suggested 150-250ms covers neither end.
  //
  // So the rule is the classic menu-aim one, and it is a DIRECTION test rather
  // than a distance or a timer: while the pointer is moving INTO the panel —
  // inside the triangle whose apex is where it was one sample ago and whose
  // base is the panel's near (left) edge, top to bottom — nothing closes the
  // submenu, whatever it happens to be passing over on the way. Every other
  // sample (a different parent item, bare page, off the menu entirely)
  // SCHEDULES the close, and the grace period below is only what covers a
  // single sample the triangle misses. Escape / outside click /
  // closeGutterMenu() are unchanged and still immediate.
  const SUBMENU_CLOSE_MS = 300;
  let submenuCloseTimer = null;
  let submenuAimPrev = null;
  // Whether the standing panel was opened by the pointer rather than by a
  // click — see the 轉換成 item's own handler for what it is for.
  let convertSubmenuViaHover = false;

  function cancelSubmenuClose() {
    if (submenuCloseTimer !== null) { clearTimeout(submenuCloseTimer); submenuCloseTimer = null; }
  }
  function scheduleSubmenuClose() {
    // Deliberately NOT restarted while one is already counting down: the
    // countdown starts at the first sample that says "not on the way in", and
    // any sample that says otherwise cancels it outright. Restarting per
    // mousemove would make the close time depend on how much the user jiggles.
    if (submenuCloseTimer !== null) return;
    submenuCloseTimer = setTimeout(() => {
      submenuCloseTimer = null;
      closeConvertSubmenu();
    }, SUBMENU_CLOSE_MS);
  }
  function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
    const cross = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
    const d1 = cross(px, py, ax, ay, bx, by);
    const d2 = cross(px, py, bx, by, cx, cy);
    const d3 = cross(px, py, cx, cy, ax, ay);
    return !(((d1 < 0) || (d2 < 0) || (d3 < 0)) && ((d1 > 0) || (d2 > 0) || (d3 > 0)));
  }
  function onSubmenuPointerMove(e) {
    if (!convertSubmenu) return;
    const prev = submenuAimPrev;
    submenuAimPrev = { x: e.clientX, y: e.clientY };
    const t = e.target;
    const inSub = !!(t && t.closest && t.closest('.ed-handle-submenu'));
    const btn = t && t.closest ? t.closest('.ed-handle-menu-btn') : null;
    if (inSub || (btn && btn === gutterMenuConvert)) { cancelSubmenuClose(); return; }
    if (prev) {
      const r = convertSubmenu.getBoundingClientRect();
      if (pointInTriangle(e.clientX, e.clientY, prev.x, prev.y, r.left, r.top, r.left, r.bottom)) {
        cancelSubmenuClose();
        return;
      }
    }
    scheduleSubmenuClose();
  }

  function buildGutterMenu() {
    const el = document.createElement('div');
    el.className = 'ed-handle-menu';

    function item(label, aria, onClick, icon) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ed-handle-menu-btn';
      // The icon first, then the label as a bare TEXT NODE. Never
      // `b.textContent = label` after this (it would wipe the icon), and
      // deliberately no wrapper element around the label: every menu helper in
      // this repo and in test/editor-client-runtime.test.js finds an item by
      // EXACT `b.textContent`, and an <svg> contributes none of its own, so the
      // label reads back byte-identical with the icon in front of it.
      b.innerHTML = menuIconMarkup(icon);
      b.appendChild(document.createTextNode(label));
      b.setAttribute('aria-label', aria);
      b.addEventListener('click', onClick);
      el.appendChild(b);
      return b;
    }

    // Hover-open. One delegated listener on the singleton menu, for the life of
    // the page. The submenu is a CHILD of the menu so its own mouseovers bubble
    // through here too, which is why this is an IDENTITY check against
    // gutterMenuConvert rather than a label match.
    el.addEventListener('mouseover', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('.ed-handle-menu-btn') : null;
      if (!gutterMenuConvert || btn !== gutterMenuConvert || gutterMenuConvert.hidden) return;
      cancelSubmenuClose();
      if (!convertSubmenu) openConvertSubmenu(gutterMenuConvert, true);
    });

    // 轉換成 is the one item that does NOT close the menu — it grows a
    // submenu, and a second press folds it back up.
    gutterMenuConvert = item('轉換成 ›', 'Convert this block', (e) => {
      e.stopPropagation();
      if (convertSubmenu) {
        // A click folds a CLICK-opened panel back up — the S2 toggle, which is
        // the path clickGutterMenuItem() / convertVia() drive throughout the
        // test suite and which must not regress. It must NOT fold up a panel
        // the pointer's own hover just opened: the pointer is on the item, so
        // no further mouseover would ever fire, and the panel would become
        // unreachable by mouse — the exact opposite of what was asked for.
        // The click does consume the hover flag, so a second one still folds.
        if (!convertSubmenuViaHover) { closeConvertSubmenu(); return; }
        convertSubmenuViaHover = false;
        cancelSubmenuClose();
        return;
      }
      openConvertSubmenu(gutterMenuConvert, false);
    }, 'convert');

    gutterMenuDuplicate = item('建立副本', 'Duplicate this block', (e) => {
      e.stopPropagation();
      const blockEl = gutterMenuBlockEl;
      closeGutterMenu();
      duplicateBlockViaMenu(blockEl);
    }, 'duplicate');

    // §10-gap fix: block-level DELETE. Reuses commitListBlockRemoval()
    // unchanged (that function was already fully block-type-agnostic —
    // it only ever reads block.startLine/endLine off `state.blocks`,
    // nothing list-specific — so "generalizing" it to any block type is
    // just calling it from here too, not touching its implementation) via
    // deleteBlockViaGutter() below, which resolves any open burst first
    // (requirement: structural ops always go through switchAwayFrom()).
    gutterMenuDelete = item('刪除', 'Delete this block', (e) => {
      e.stopPropagation();
      const blockEl = gutterMenuBlockEl;
      closeGutterMenu();
      deleteBlockViaGutter(blockEl);
    }, 'trash');

    gutterMenuMd = item('MD 原始碼', 'Switch to raw markdown edit', (e) => {
      e.stopPropagation();
      const blockEl = gutterMenuBlockEl;
      closeGutterMenu();
      openRawViaGutter(blockEl);
    }, 'code');

    return el;
  }
  const gutterMenu = buildGutterMenu();

  // Spec §3.2's twelve v1 targets, rendered as a panel anchored to the right
  // of the 轉換成 row. The panel is a CHILD of the menu, and the menu is
  // `position: absolute`, so it is the submenu's own containing block and
  // `left: 100%` (lib/md2doc.js) resolves against the menu's padding box —
  // no viewport arithmetic, and the panel travels with the menu when the menu
  // is moved into another block.
  function openConvertSubmenu(anchorBtn, viaHover) {
    closeConvertSubmenu();
    const sub = document.createElement('div');
    sub.className = 'ed-handle-menu ed-handle-submenu';
    convertMd.CONVERT_TARGETS.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ed-handle-menu-btn';
      b.textContent = t.label;
      b.setAttribute('aria-label', 'Convert to ' + t.id);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const blockEl = gutterMenuBlockEl;
        closeGutterMenu();
        convertBlockViaMenu(blockEl, t.id);
      });
      sub.appendChild(b);
    });
    sub.style.top = anchorBtn.offsetTop + 'px';
    anchorBtn.parentNode.appendChild(sub);
    convertSubmenu = sub;
    convertSubmenuViaHover = !!viaHover;
    // The aim triangle needs a previous sample to have an apex; the first
    // mousemove after the open only records one. Cleared here so a panel
    // re-opened on another block cannot aim from the old block's geometry.
    submenuAimPrev = null;
    // Attached only while a panel is standing, and removed again below — a
    // document-level mousemove listener that outlived the panel would be a
    // per-move cost on every page for nothing.
    document.addEventListener('mousemove', onSubmenuPointerMove);
  }

  function closeConvertSubmenu() {
    cancelSubmenuClose();
    submenuAimPrev = null;
    convertSubmenuViaHover = false;
    document.removeEventListener('mousemove', onSubmenuPointerMove);
    if (convertSubmenu) { convertSubmenu.remove(); convertSubmenu = null; }
  }

  function closeGutterMenu() {
    // The submenu lives INSIDE the menu, so removing the menu already detaches
    // it — but `convertSubmenu` would keep pointing at the detached node and
    // the next 轉換成 press would read it as "already open" and merely fold a
    // panel nobody can see. Same stale-singleton hazard `gutterMenuBlockEl`
    // documents just below, and the reason rerenderAll()'s reset list needs no
    // second entry: it already calls this.
    closeConvertSubmenu();
    gutterMenu.remove();
    gutterMenuBlockEl = null;
  }

  function toggleGutterMenu(blockEl) {
    if (!blockEl) return;
    if (gutterMenuBlockEl === blockEl) { closeGutterMenu(); return; }
    // §10-gap fix: the ⠿ menu and the ＋ insert menu are mutually exclusive
    // — both are singleton nodes appended as a CHILD of whichever block
    // they're open for (same idiom), so opening one while the other is open
    // on a DIFFERENT block would otherwise leave two floating menus up at
    // once. closeInsertMenu() is idempotent (safe even when nothing is open).
    closeInsertMenu();
    // A menu re-opened on another block must never inherit the previous
    // block's expanded submenu — it was built against THAT block and its
    // targets close over `gutterMenuBlockEl` at click time, so a stale panel
    // is a panel that converts the wrong block.
    closeConvertSubmenu();
    gutterMenuBlockEl = blockEl;
    const blockType = blockEl.getAttribute('data-block-type');
    // Spec §7: a table block has no 轉換成 at all (there is no target that
    // could carry a table's cells, and every one of the twelve would destroy
    // them).
    //
    // 'hr' and 'html' are withheld for a different, measured reason: the
    // gesture would LIE. convert-md strips a block's marker to get its
    // content, and an <hr> has no content — its source line IS the marker.
    // Measured: 'hr' → 項目符號列表 writes '- ---', which marked re-lexes
    // as an hr again, so the file's bytes change, the block type does not,
    // and no banner is shown. 'hr' → 文字 is a byte no-op, also silent.
    // An 'html' block is raw passthrough for the same reason: there is no
    // marker to strip and no content to re-host. Nothing is lost either way,
    // but an item that appears to work and does nothing is worse than an
    // item that is not offered.
    gutterMenuConvert.hidden = (blockType === 'table' || blockType === 'hr' || blockType === 'html');
    gutterMenuDuplicate.hidden = false;
    gutterMenuDelete.hidden = false;
    // RULING F-O: 'MD 原始碼' is hidden for a list item PERMANENTLY, not as a
    // phased measure. openRawEditor() replaces the block's innerHTML with a
    // <textarea>, and a li is one line of a run that is serialized as a whole
    // — a textarea inside it is content the serializer cannot represent, and
    // restore() would have to rebuild the marker/check/text chrome from a
    // string. Every other block type keeps it: the menu is a SINGLETON moved
    // between blocks, so this must be reset on every open, not set once.
    // (test/editor-reader-rebind.test.js drives raw-edit through this button
    // by its exact text on a paragraph.)
    gutterMenuMd.hidden = (blockType === 'li');
    blockEl.appendChild(gutterMenu);
  }

  // ── §10-gap fix: block-level INSERT ─────────────────────────────────────
  // A fresh ＋ button per block, sat NEXT TO the ⠿ handle in the left gutter
  // (Notion order: ＋ then ⠿, ＋ further from the content — see the CSS in
  // lib/md2doc.js). Same "no per-node listener" discipline as
  // buildGutterHandle() above, for the same reason (openRawEditor()'s
  // restore() re-parses the block's innerHTML from a plain string, which
  // would silently drop any listener attached directly here).
  function buildGutterInsertButton() {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'ed-insert';
    el.textContent = '＋';
    el.setAttribute('aria-label', '插入區塊');
    // Not a tab stop — see buildGutterHandle() above for the whole reason.
    el.setAttribute('tabindex', '-1');
    return el;
  }

  // The single shared ＋ insert menu — same singleton/move-into-block idiom
  // as `gutterMenu` above. `insertMenuBlockEl` names which block it's open
  // for (the block the new one will be inserted BELOW).
  let insertMenuBlockEl = null;

  const INSERT_KIND_LABELS = [
    ['paragraph', '段落'],
    ['heading', '標題'],
    ['list', '清單'],
    ['table', '表格'],
    ['code', '程式碼'],
  ];

  function buildInsertMenu() {
    const el = document.createElement('div');
    el.className = 'ed-insert-menu';
    INSERT_KIND_LABELS.forEach(([kind, label]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ed-insert-menu-btn';
      btn.textContent = label;
      btn.setAttribute('aria-label', 'Insert ' + kind + ' block below');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const blockEl = insertMenuBlockEl;
        closeInsertMenu();
        insertBlockBelow(blockEl, kind);
      });
      el.appendChild(btn);
    });
    return el;
  }
  const insertMenu = buildInsertMenu();

  function closeInsertMenu() {
    insertMenu.remove();
    insertMenuBlockEl = null;
  }

  function toggleInsertMenu(blockEl) {
    if (!blockEl) return;
    if (insertMenuBlockEl === blockEl) { closeInsertMenu(); return; }
    // Mutual exclusion with the ⠿ menu — see toggleGutterMenu()'s own
    // comment for why. closeGutterMenu() is idempotent.
    closeGutterMenu();
    insertMenuBlockEl = blockEl;
    blockEl.appendChild(insertMenu);
  }

  // The new-block skeletons — deliberately minimal, matching the brief's
  // exact shapes for 段落/標題/清單/表格/程式碼, with one deviation forced by
  // `marked`'s own lexer: a bare `- ` (marker + trailing space, nothing
  // else) does NOT lex as a `list` token — marked only recognizes a list
  // item once it has SOME body content, so `- ` alone degrades to a plain
  // `paragraph` token (verified against marked 14.1.4: `marked.lexer('- ')`
  // -> `[{type:'paragraph', raw:'- ', ...}]`, while `marked.lexer('-')` ->
  // `[{type:'list', ...}]`). Using the brief's literal `- ` would silently
  // insert a paragraph typed "- " instead of an actual empty list block, so
  // this uses the bare marker `-` instead — verified to lex as `list` with
  // one empty `<li>`.
  //
  // The 段落 skeleton similarly can't be a truly empty line: a blank line by
  // itself is consumed by marked's lexer as a `space` token between
  // neighboring blocks, never becomes its own `paragraph` token, and would
  // leave the ＋ menu unable to find (or focus) any block at all — see
  // commitBlockInsertion()'s newStartLine contract, which callers use to
  // locate the inserted block in the server's recomputed block list.
  // U+200B (zero-width space) is real, non-whitespace-per-`\s` text that
  // marked DOES lex as its own paragraph, and renders as `<p>​</p>` —
  // visually empty. focusInsertedBlock() below selects that single
  // character so an immediate keystroke replaces it, matching the "empty
  // paragraph to type into" intent; if the user commits without typing at
  // all, the ZWSP is what ends up on disk (a known, documented trade-off —
  // see the phase report).
  //
  // 程式碼: a bare two-line fence pair (```/```, nothing between) is what
  // "fence pair with empty body" reads as most literally, and DOES lex as
  // an empty code block (marked.lexer('```\n```') -> [{type:'code',
  // text:''}]) — but it gives the caret nowhere to land BETWEEN the fences:
  // there is no third line there. focusInsertedBlock() below places the
  // raw-editor caret right after the opening fence's newline; with only two
  // lines that position is the very START of the closing fence's own line,
  // so typing lands immediately before the closing ``` with no line break
  // of its own (`` ```typed``` `` on one line — verified via a failing
  // browser probe). A three-line fence with one blank line between them
  // (still `text: ''` per marked — verified) gives that line to land on.
  const BLOCK_SKELETONS = {
    paragraph: ['​'],
    heading: ['## '],
    list: ['-'],
    table: ['| A | B |', '|---|---|', '|  |  |'],
    code: ['```', '', '```'],
  };

  // Selects the entirety of `el`'s content (used right after focusing a
  // freshly-inserted, placeholder-only block) so the user's very first
  // keystroke replaces the placeholder instead of being inserted next to
  // it. A no-op-equivalent (nothing to select) on the genuinely-empty
  // heading/list/table skeletons; load-bearing only for the paragraph
  // skeleton's ZWSP placeholder (see BLOCK_SKELETONS above).
  function focusAndSelectAll(el) {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Locates and focuses the block a commitBlockInsertion()+rerenderAll()
  // pair just created, by the `newStartLine` the commit computed BEFORE the
  // render (the server-recomputed `blocks` array — reassigned by
  // rerenderAll() itself — is the only place that new block gets an id, so
  // matching by its known startLine is the only way back to it).
  // §10-gap fix (review): auto-removes the block `pristineInsert` currently
  // points at — called from every "this block's edit surface just
  // resolved" path (see `pristineInsert`'s own comment for the full list)
  // once that path has confirmed the block's content is STILL
  // byte-identical to what was inserted. Reverses commitBlockInsertion()'s
  // own op directly via UndoStack.discardTop() (lib/editor/lineops.js)
  // rather than committing a SEPARATE removal — the insert op is popped
  // and its exact line-range reversed, so the net effect is byte-identical
  // to "the insert never happened": zero new undo-stack entries, not two
  // ops that cancel out (chosen per the review's explicit preference,
  // verified against UndoStack's shape — discardTop() never touches
  // `_undone`, so it can't disturb an unrelated redo trail either).
  // Returns true/false with the SAME contract as every other resolution
  // path in this file (switchAwayFrom()'s callers): false only when the
  // cleanup's own render failed — the (still pristine) block is left
  // as-is, on both `lines` and the stack, for a later attempt to retry.
  async function discardPristineInsert() {
    pristineInsert = null;
    const discarded = stack.discardTop(lines);
    if (!discarded) return true; // nothing to discard — defensive, should not happen
    const prevLines = lines;
    lines = discarded.lines;
    setDirty();
    const okRender = await safeRerenderAll();
    if (!okRender) {
      stack.push(discarded.op); // put it back — see discardTop()'s own comment
      lines = prevLines;
      setDirty();
      return false;
    }
    return true;
  }

  async function focusInsertedBlock(newStartLine, kind) {
    const target = blocks.find((b) => b.startLine === newStartLine);
    if (!target) return;
    const blockEl = document.querySelector('.ed-block[data-block-id="' + target.id + '"]');
    if (!blockEl) return;
    if (kind === 'code') {
      // Code blocks are never WYSIWYG-armed (armEditables() above has no
      // 'code' branch) — same degraded-block contract as any other fence:
      // click opens the raw in-place source editor directly. openRawEditor()
      // itself places the caret at the END of the textarea (its generic
      // contract, shared with every other raw-edit open path) — that lands
      // AFTER the closing fence, not on the blank BODY line
      // BLOCK_SKELETONS['code'] (see its own comment) puts there
      // specifically so typing has somewhere to land. Move it there once
      // the textarea exists.
      await openRawEditor(blockEl);
      const ta = blockEl.querySelector('textarea.ed-raw');
      if (ta) {
        const nlIdx = ta.value.indexOf('\n');
        const pos = nlIdx === -1 ? ta.value.length : nlIdx + 1;
        ta.setSelectionRange(pos, pos);
        ta.focus();
      }
      return;
    }
    if (kind === 'table') {
      const tableEl = blockContentEl(blockEl);
      const firstBodyRow = tableEl ? bodyRowsOf(tableEl)[0] : null;
      const firstBodyCell = firstBodyRow ? firstBodyRow.cells[0] : null;
      if (firstBodyCell) focusAndSelectAll(firstBodyCell);
      return;
    }
    const editEl = blockContentEl(blockEl);
    if (editEl) focusAndSelectAll(editEl);
  }

  // Inserts a new block of `kind` directly below `blockEl`. Requirement:
  // structural ops resolve any open burst FIRST (single-flight, same as
  // every other structural op in this file), then re-query the LIVE block
  // by data-block-id (the resolution may have committed a DIFFERENT block's
  // dirty burst, swapping the whole `.content` subtree and detaching
  // `blockEl` along with it — same "ensureTableBurstOpen()'s Finding 6"
  // recovery idiom used throughout this file), THEN acts.
  async function insertBlockBelow(blockEl, kind) {
    if (!blockEl) return;
    // T7: captured BEFORE switchAwayFrom(), because that is what can renumber
    // the ids — see captureBlockIdentity()'s comment.
    const identity = captureBlockIdentity(blockEl);
    // S2 Task 7: the FOURTH and last call site of the hole 轉換 (Task 2), 刪除
    // and 建立副本 (Task 6) already closed, and the one that was latent only
    // because a li had no ＋ to press. Finding 5a's delegated mousedown
    // preventDefault() names '.ed-insert' as well as '.ed-handle', so the
    // burst survives the press and the commit that lands inside
    // switchAwayFrom() below can be a rewrite of THIS block's own source —
    // in which case reresolveBlockEl()'s source fingerprint is guaranteed to
    // miss, because WE are the reason the source changed, and the gesture is
    // dropped with '文件已更新，請重試這個操作' having done nothing. The
    // narrowed re-resolve (startLine + type, no fingerprint) is used ONLY
    // when the session that just committed was this block's OWN;
    // reresolveBlockEl() keeps its fingerprint for everybody else.
    const selfSession = ownsOpenSession(blockEl);
    const ok = await switchAwayFrom();
    if (!ok) return;
    let liveBlockEl = blockEl;
    if (!document.body.contains(blockEl)) {
      liveBlockEl = reresolveBlockEl(identity) ||
        (selfSession ? reresolveBlockElAfterSelfCommit(identity) : null);
      if (!liveBlockEl) { showBanner(DROPPED_GESTURE_MESSAGE, null, null); return; }
    }
    // T7 fix round 1 (LOW-2): same refusal deleteBlockViaGutter() makes below,
    // for the same reason and against the same LIVE block. A block that owns
    // no source line has endLine === startLine - 1 (blockOwnsNoLine()), and
    // commitBlockInsertion() inserts at `endLine + 1` — which for an inverted
    // range is the line ABOVE the block, i.e. inside whatever precedes it. It
    // also reads `state.lines[endLine]` to decide the trailing blank, so it
    // samples a line belonging to somebody else. Latent today only because a
    // li block grows no ＋ until S2; S2 is next, and a guard that has to be
    // remembered later is a guard that will not be.
    if (blockOwnsNoLine(liveBlockEl)) {
      refuseStructuralListEdit(NO_SOURCE_LINE_INSERT_MESSAGE);
      return;
    }
    const newLines = BLOCK_SKELETONS[kind];
    if (!newLines) return;

    // ── S2 Task 7: a LIST ITEM anchor (§6's S1 note item 3) ────────────────
    //
    // Two things change, and both were measured against the pure core rather
    // than reasoned from the plan:
    //
    // 1. THE INSERTION POINT IS THE END OF THE ANCHOR'S SUBTREE, not the
    //    anchor's own last line. This is the ruling §4.3 already made for
    //    建立副本 (「副本插在該 block 整棵子樹之後」), and it is what makes every
    //    non-list kind safe here. Measured on ['# Doc','','- alpha',
    //    '  - child','    - grand','']: anchored on `child`,
    //    commitBlockInsertion() with the 段落 skeleton yields
    //    '# Doc\n\n- alpha\n  - child\n\n<ZWSP>\n\n    - grand\n', and
    //    marked lexes '    - grand' after a paragraph as an INDENTED CODE
    //    BLOCK — the grandchild's content is gone. Anchored on the end of the
    //    subtree the same gesture yields
    //    '# Doc\n\n- alpha\n  - child\n    - grand\n\n<ZWSP>\n', whose
    //    token list holds no `code` at all. No kind needs to refuse.
    //
    // 2. THE 清單 KIND DOES NOT GO THROUGH commitBlockInsertion() AT ALL.
    //    That function ALWAYS writes a leading blank line (see its own
    //    comment), and for a list that blank is the §4.3 rule 2 defect:
    //    measured, '# Doc\n\n- alpha\n  - child\n\n  -\n' has a NESTED
    //    list with loose === true, so every item of it grows a <p>,
    //    serializeBlocks() pushes 'P' for each and the run degrades read-only
    //    with no banner. Same fork 建立副本 hit in Task 6, and the same answer:
    //    route the li through its own run's re-serialization, which emits no
    //    blank at all, re-runs §3.8's renumbering, and — the point of carry 2
    //    — takes the new item's indent prefix from the serializer's own
    //    marker-width stack instead of re-deriving it. There is deliberately
    //    no `indentPrefixOf()` here: `' '.repeat(indent * 2)` is what §3.4
    //    forbids, and even reading lineMeta's `indentPrefix` back would be a
    //    second copy of an arithmetic list-md.js already owns.
    //
    // The §4.3 run-wide gate applies on the way in, like every other
    // structural op. `columnOnly` is the honest option: no EXISTING item's
    // content or line count is rewritten — the only bytes that move in a
    // bystander are its marker and leading columns (§3.8 renumbering, applied
    // as §3.4's colDelta by the carryOver replay), which is exactly the
    // criterion listRunSupportsStructuralEdit() documents. Without it a
    // single hard-wrapped item anywhere in the run would veto the ＋, which
    // on this repo's own CHANGELOG.md is every run.
    let anchorEl = liveBlockEl;
    if (liveBlockEl.getAttribute('data-block-type') === 'li') {
      const run = listRunOf(liveBlockEl);
      if (!run.length) return;
      if (!listRunSupportsStructuralEdit(run, null, { columnOnly: true })) {
        refuseStructuralListEdit();
        return;
      }
      const subtree = subtreeBlocksAfter(liveBlockEl,
        Number(liveBlockEl.getAttribute('data-indent')) || 0);
      anchorEl = subtree.length ? subtree[subtree.length - 1] : liveBlockEl;
      if (kind === 'list') { await insertListItemAfter(liveBlockEl, run, anchorEl); return; }
      // The subtree's last member is a li like any other, so it can own no
      // source line for the same reason the anchor could — and it is the block
      // commitBlockInsertion() is about to read `endLine` and `lines[endLine]`
      // off. Re-checked against the block actually used.
      if (blockOwnsNoLine(anchorEl)) {
        refuseStructuralListEdit(NO_SOURCE_LINE_INSERT_MESSAGE);
        return;
      }
    }
    const liveBlockId = Number(anchorEl.getAttribute('data-block-id'));
    const block = blocks.find((b) => b.id === liveBlockId);
    if (!block) return;
    const result = commitBlockInsertion({ lines, blocks, stack }, liveBlockId, newLines);
    const prevLines = lines;
    lines = result.lines;
    const okRender = await safeRerenderAll();
    if (!okRender) {
      lines = rollbackFailedRender({ lines, stack }, result, prevLines);
      return;
    }
    // §10-gap fix (review): mark the freshly-inserted block "pristine" —
    // see `pristineInsert`'s own comment for the full contract. `blocks`
    // was just reassigned by the successful rerenderAll() above, so this
    // is the server-authoritative id for the block at `newStartLine`.
    const target = blocks.find((b) => b.startLine === result.newStartLine);
    if (target) pristineInsert = { blockId: target.id };
    await focusInsertedBlock(result.newStartLine, kind);
  }


  // S2 Task 7 — the li half of ＋. The new item is spliced into the run's own
  // span and the WHOLE span is re-serialized over the run's line range: one
  // commitRangeEdit, therefore one undo op, no leading blank line (so the run
  // stays TIGHT — see insertBlockBelow()'s note 2), §3.8's renumbering for
  // free, and the new item's indent prefix straight out of list-md.js's
  // marker-width stack.
  //
  // `lastEl` is the end of the anchor's subtree, so the new item is the
  // anchor's SIBLING and lands after the anchor's children rather than
  // between them.
  async function insertListItemAfter(liEl, run, lastEl) {
    // Captured BEFORE the new item enters the span: it carries no
    // data-block-id (it does not exist in `lines` yet), so runRangeOfBlocks()
    // would skip it — but on an insertion after the span's LAST member the
    // derived range would then silently stop one line short of nothing at all.
    // Passing the pre-mutation range is the same discipline duplicateListItem()
    // uses, for the same reason.
    const range = runRangeOfBlocks({ lines, blocks, stack }, run);
    if (!range) return;
    const at = run.indexOf(lastEl);
    if (at < 0) return;
    const newLi = buildProvisionalListItem(liEl);
    const span = run.slice(0, at + 1).concat([newLi], run.slice(at + 1));
    mutateListRun(() => {
      lastEl.parentNode.insertBefore(newLi, lastEl.nextSibling);
    });
    // No `mutatedEl`: nothing that already existed had its content rewritten,
    // so every existing member is replayed from the file's own bytes and a
    // '~5px' stays a '~5px'. The new item has no id and is skipped by
    // bystanderCarryOver() on its own.
    const carry = bystanderCarryOver(span);
    // The SAME map commitListStructure() is about to use — runLineOfBlock()
    // is an index INTO the lines that map produces, so rebuilding it here
    // would only usually be the same answer.
    const focusLine = runLineOfBlock(span, newLi, carry);
    await commitListStructure(span, focusLine, false,
      { presetRange: range, carryOver: carry });
  }

  // A brand-new, empty list item that will become real on the next commit —
  // the same provisional-block shape splitListItemAtCaret() builds (no
  // data-block-id: it owns no source line yet, and the commit's rerenderAll()
  // replaces it with a real, server-numbered block).
  //
  // It inherits `data-list-type` and `data-task` from the anchor, NOT the
  // 清單 menu label's implied bullet. §3.8 rule (b) is why: a different
  // data-list-type ENDS the run, so a bullet dropped into an ordered run
  // would split it into three list tokens and renumber what is left. Enter on
  // a list item (splitListItemAtCaret above) already inherits both, so this is
  // the established answer rather than a new one.
  //
  // `data-list-start` is deliberately NOT copied: it is the only carrier of
  // "marked opened a new list token here" (§3.8 rule (d)) and a new sibling
  // inside an existing run is never a token boundary — copying it would
  // restart the ordinal counter mid-run.
  function buildProvisionalListItem(anchorLi) {
    const el = document.createElement('div');
    el.className = 'ed-block';
    el.setAttribute('data-block-type', 'li');
    el.setAttribute('data-list-type', anchorLi.getAttribute('data-list-type') || 'ul');
    const isTask = anchorLi.getAttribute('data-task') === '1';
    el.setAttribute('data-task', isTask ? '1' : '0');
    setBlockIndent(el, Number(anchorLi.getAttribute('data-indent')) || 0);
    const marker = document.createElement('span');
    marker.className = 'ed-li-marker';
    marker.setAttribute('aria-hidden', 'true');
    el.appendChild(marker);
    // A fresh item is never checked — nothing in the anchor's line says
    // otherwise. buildLiCheckbox() is the one place that markup lives, so the
    // renderer and this stay byte-identical (see its own comment).
    if (isTask) el.appendChild(buildLiCheckbox());
    const text = document.createElement('div');
    text.className = 'ed-li-text';
    el.appendChild(text);
    return el;
  }

  // ── S2 spec §4.3: 轉換成 ────────────────────────────────────────────────
  //
  // The written gesture order is fixed: closeGutterMenu() (the menu item's own
  // click handler already did it) -> switchAwayFrom() -> re-locate the block by
  // startLine -> operate. The SOURCE is the resolved `lines`, never the DOM.
  //
  // Why line-level rather than "mutate the DOM and re-serialize the run like
  // every other structural op": list-md.js's serializeBlocks() pushes the
  // uppercased block type into `unsupported` for any non-`li` block inside the
  // span it is given, which is EXACTLY the shape a conversion produces — every
  // li -> heading would hit the degrade path and refuse itself. Reading `lines`
  // also means the inline content is never re-serialized, so escapeText() never
  // runs over it and a `~5px` in the converted block stays `~5px`.
  // ── S3 Task 6: the ⠿ gesture's OPERAND SET (spec §3.3) ──────────────────
  //
  // Up to S2 every gutter operation worked on exactly one block and the three
  // entry points below carried a byte-identical preamble: capture identity,
  // resolve whatever session is open, re-find the block if that commit
  // re-rendered, refuse a block that owns no source line. §3.3 turns that ONE
  // element into a SPAN — 「grip 在選取集合內 → 作用整個集合；grip 在集合外 →
  // 先把集合換成該單一 block 再作用」— so the preamble moved here and grew a
  // membership step.
  //
  // ORDERING IS LOAD-BEARING. Membership is resolved AFTER switchAwayFrom(),
  // never before: that call can commit an open burst, and its rerenderAll()
  // renumbers every block id and hands back a fresh `blocks` array. A record
  // captured ahead of it is a dangling reference — and resolveMembership()
  // compares by REFERENCE (Task 1 carry 4: ids are forbidden architecturally
  // and line tuples are genuinely ambiguous, since `- - - a` yields two
  // structurally identical phantoms {startLine:1, endLine:0}), so a stale
  // record silently answers 'single' and the batch degrades to one block. The
  // selection itself survives that render for free — its identity is a LINE
  // RANGE, which is exactly what no render can invalidate.
  //
  // Returns `null` when the gesture is refused or dropped — the banner has
  // already been raised — otherwise `{ els, recs, batch }`: the LIVE block
  // elements in document order, their records out of `blocks` (by reference),
  // and whether more than one block is being operated on.
  async function resolveGutterOperands(blockEl) {
    if (!blockEl) return null;
    // Finding 5a's mousedown preventDefault() deliberately keeps a dirty burst
    // alive across the ⠿ press, so the commit that lands inside
    // switchAwayFrom() below can be a rewrite of the very block the gesture
    // names — in which case reresolveBlockEl()'s SOURCE fingerprint is
    // guaranteed to miss, because WE are the reason the source changed. That
    // is not a dropped gesture; startLine + type still name the block, and the
    // fingerprint's job (proving an UNRELATED commit did not move somebody
    // else into this slot) is done by those two here.
    const identity = captureBlockIdentity(blockEl);
    const selfSession = ownsOpenSession(blockEl);
    const ok = await switchAwayFrom();
    if (!ok) return null;
    let liveBlockEl = blockEl;
    if (!document.body.contains(blockEl)) {
      liveBlockEl = reresolveBlockEl(identity) ||
        (selfSession ? reresolveBlockElAfterSelfCommit(identity) : null);
      if (!liveBlockEl) { showBanner(DROPPED_GESTURE_MESSAGE, null, null); return null; }
    }
    // A block that owns no source line has an INVERTED range
    // (endLine === startLine - 1) and every commit helper handed one does
    // something plausible and wrong.
    if (blockOwnsNoLine(liveBlockEl)) { refuseStructuralListEdit(NO_SOURCE_LINE_MESSAGE); return null; }
    const rec = blockRecOf(liveBlockEl);
    if (!rec) { showBanner(DROPPED_GESTURE_MESSAGE, null, null); return null; }

    const res = selectionLib
      ? selectionLib.resolveMembership(blockSelection, blocks, rec)
      : { mode: 'single', members: [rec] };
    if (res.mode !== 'batch') {
      // §3.3's second half: 「grip 在集合外 → 先把集合換成該單一 block 再作用」.
      // Done here rather than left to the post-operation collapse so a REFUSAL
      // also leaves the documented state behind, instead of a set somewhere
      // else in the document that the user's next keystroke would batch over.
      // No selection standing at all stays exactly as it was pre-S3.
      if (blockSelection) {
        setBlockSelection({ anchorLine: rec.startLine, focusLine: rec.startLine });
      }
      return { els: [liveBlockEl], recs: [rec], batch: false };
    }
    const members = res.members;
    // Task 1 carry 6: `spanIsContiguous([])` is TRUE — no members, no gaps — so
    // emptiness is checked separately and gets its own wording. Unreachable
    // through the menu today (resolveMembership() only answers 'batch' when the
    // grip block is itself a member), but the two states are genuinely
    // different and a single gate would report the wrong one if it ever is.
    if (!members.length) { refuseStructuralListEdit(BATCH_EMPTY_MESSAGE); return null; }
    // Task 1 carry 2: a gap is NOT only what a disjoint selection produces. A
    // no-line phantom can sit BETWEEN two real members — `- a\n- - b\n- c\n`
    // yields li{1,1} | phantom{2,1} | li{2,2} | li{3,3}, so selecting lines 1–2
    // (an entirely natural gesture) lands on indices 0 and 2. The batch cannot
    // be expressed as one contiguous index range, so it refuses rather than
    // writing a range it cannot honour.
    if (!selectionLib.spanIsContiguous(members, blocks)) {
      refuseStructuralListEdit(BATCH_GAP_MESSAGE);
      return null;
    }
    const els = [];
    for (let i = 0; i < members.length; i++) {
      const el = blockElById(members[i].id);
      if (!el) { showBanner(DROPPED_GESTURE_MESSAGE, null, null); return null; }
      // Belt to membersOf()'s own braces: selection.js excludes a block that
      // owns no line from every member set it builds, so this is unreachable —
      // but "another module filters it" is an argument about another file's
      // output, and this is the guard that stands between an inverted range and
      // a commit helper.
      if (blockOwnsNoLine(el)) { refuseStructuralListEdit(NO_SOURCE_LINE_MESSAGE); return null; }
      els.push(el);
    }
    return { els: els, recs: members, batch: members.length > 1 };
  }

  // §3.3's collapse: 「操作後集合塌縮為「操作結果所涵蓋的行區間」」. Declared
  // IMMEDIATELY before the render and never earlier — rerenderAll() consumes the
  // declaration at its very top, before its first failure exit, so one left
  // standing lands on some LATER, unrelated render (Task 5 carry 5).
  //
  // ONLY when a set was actually standing, and that guard is load-bearing:
  // without it an ordinary single-block ⠿ 建立副本 or 轉換成 on a document with
  // NO selection would CREATE one — collapseTo() resolves the declared range,
  // membersOf() finds the block, and setBlockSelection() tints it and pulls the
  // roving focus onto it. That is a selection the user never made, and it would
  // change the resting state of every pre-S3 gutter gesture. resolveGutterOperands()
  // has already applied §3.3's 「grip 在集合外 → 先把集合換成該單一 block」, so
  // `blockSelection` is non-null here exactly when the gesture was a set
  // operation. Leaving the declaration UNSET is the correct answer otherwise:
  // `undefined` means "keep whatever is standing", and nothing is.
  function declareCollapse(range) {
    if (blockSelection) declareSelectionRange(range);
  }

  const BATCH_EMPTY_MESSAGE = '沒有選取任何區塊';
  const BATCH_GAP_MESSAGE = '選取範圍不連續，無法整批操作';
  const BATCH_MIXED_MESSAGE = '選取範圍同時含有清單項目與其他區塊，無法整批操作';
  const BATCH_MULTIRUN_MESSAGE = '選取範圍跨越兩個清單，無法整批操作';

  function blockElById(id) {
    return document.querySelector('.ed-block[data-block-id="' + id + '"]');
  }

  // §3.4 rule 3's batch anchor: 「多 block 操作的錨點 = 選取集合中最小的舊
  // indent」, not the first member. The spec records both ways the first member
  // goes wrong — deleting `{a(0), b(1)}` anchored on a(0) is right, but anchored
  // on the FIRST member of `{b(1), …}` the following segment head's bound is
  // computed against 1 instead of 0 and a same-segment sibling lands at −1
  // (undefined in columns); and a batch Tab whose first member already sits at
  // its ceiling yields delta 0 and no-ops the entire set.
  function spanMinIndent(els) {
    let min = null;
    (els || []).forEach((el) => {
      const v = Number(el.getAttribute('data-indent')) || 0;
      if (min === null || v < min) min = v;
    });
    return min === null ? 0 : min;
  }

  // The kinds a span holds, and the one shape no batch path can express.
  // A contiguous span of list items is rewritten through its RUN's
  // re-serialization; a contiguous span of non-list blocks is a plain line
  // splice. A span holding BOTH is neither: the run's survivors have to be
  // re-emitted at the same time as a line range outside the run is removed, and
  // the blank-line policy at the seam between them has no ruling in the spec.
  // Refused with its own banner rather than guessed at.
  function spanListKinds(els) {
    const kinds = els.map((el) => el.getAttribute('data-block-type'));
    return {
      kinds: kinds,
      allLi: kinds.length > 0 && kinds.every((k) => k === 'li'),
      anyLi: kinds.indexOf('li') !== -1,
    };
  }

  // Every list batch is one run's problem: listRunOf() is the span the commit
  // re-serializes, and a member outside it would be rewritten by a range that
  // does not cover it. Contiguity in `blocks` does not imply one run — two
  // adjacent runs separated by a delimiter change (`- a` / `* b`) are adjacent
  // blocks with no phantom between them.
  function batchRunOf(liEls) {
    const run = listRunOf(liEls[0]);
    if (!run.length) return null;
    for (let i = 0; i < liEls.length; i++) if (run.indexOf(liEls[i]) === -1) return null;
    return run;
  }

  async function convertBlockViaMenu(blockEl, target) {
    if (!blockEl || !target) return;
    // §3.3's membership rules and the whole shared preamble — see
    // resolveGutterOperands() above. `els` is ONE contiguous span; the plan's
    // central constraint is that every path below takes that span whole rather
    // than looping, because a loop re-renders between items and invalidates
    // every id in between (the defect class recorded in this file twice: a
    // fenced block raw-edited into two paragraphs changes the BLOCK count
    // without changing the LINE count, so an id-indexed delete hit the wrong
    // block, and the same shape silently rewrote a neighbouring table).
    const operands = await resolveGutterOperands(blockEl);
    if (!operands) return;
    const els = operands.els;
    const recs = operands.recs;
    const shape = spanListKinds(els);
    if (shape.anyLi && !shape.allLi) { refuseStructuralListEdit(BATCH_MIXED_MESSAGE); return; }

    // §4.3's run-wide gate: 轉換／建立副本／刪除／拖曳 all pass through
    // listRunSupportsStructuralEdit() BEFORE any mutation, the same door
    // Tab/Enter/checkbox already use. Its input is §3.4 rule 2's SCOPE, which
    // is exactly what listRunOf() returns (the outermost run PLUS every
    // descendant of its members) — see deleteListItemsViaGutter()'s own note.
    //
    // ORDERING IS LOAD-BEARING, not incidental. This sits AHEAD of the
    // refusals below and, further down, of stripMarker(): a multi-line li must
    // report §4.1's 「此清單含不支援的格式，無法調整結構」 and not
    // convert-md.js's per-block 「此區塊的格式無法轉換」, which is what it
    // would get if stripMarker() saw it first (that function refuses a
    // multi-line li too, for its own, narrower reason). The runtime scenario
    // 'a multi-line li refuses with the §4.1 banner' asserts the MESSAGE, so it
    // is what notices if this order is ever flipped.
    //
    // A conversion is NOT column-only (§4.1 修訂 2): it rewrites the item's own
    // text or line count, so a multi-line li refuses as a TARGET while
    // remaining a perfectly good bystander. S3 Task 6 passes the WHOLE operand
    // set as the target list — every member is being rewritten, so every member
    // has to clear the gate, not just the one the ⠿ was pressed on.
    let liRun = null;
    if (shape.allLi) {
      liRun = batchRunOf(els);
      if (!liRun) { refuseStructuralListEdit(BATCH_MULTIRUN_MESSAGE); return; }
      if (!listRunSupportsStructuralEdit(liRun, els)) { refuseStructuralListEdit(); return; }
    }

    // S2 Task 3 / S3 Task 6: li → a LIST target. The blocks stay list items, so
    // the run stays a run and the existing re-serialization machinery applies
    // unchanged.
    if (shape.allLi && convertMd.targetIsList(target)) {
      await convertListItemsType(els, liRun, recs, target);
      return;
    }
    // S2 Task 4 / S3 Task 6: li → a NON-list target. The items LEAVE the run,
    // so the span has to be rebuilt in three pieces and §4.3 rule 1's blank
    // lines put between them — the plain path below would leave the converted
    // lines mid-list with no separator and lazy continuation would swallow them
    // into the item above (measured, §4.3 rule 1).
    if (shape.allLi) {
      await convertListItemsAway(els, liRun, recs, target);
      return;
    }
    // S2 Task 5 / S3 Task 6: non-list blocks BECOME list items, so §4.3 rule
    // 2's looseness policy applies — eat the separator to an adjacent run of
    // the same list type, or the merged list goes LOOSE and every item of it
    // degrades read-only. Same rule, same helper the li → li path above uses.
    if (convertMd.targetIsList(target)) {
      await convertBlocksIntoList(els, recs, shape.kinds, target);
      return;
    }

    // The plain path: N non-list blocks to a non-list target. One commit over
    // the span's whole line range, each member converted from its OWN source
    // lines (never re-serialized, which is what keeps a `~5px` a `~5px`) and
    // the pieces separated by a blank line so they re-lex as N blocks.
    const first = recs[0];
    const last = recs[recs.length - 1];
    const pieces = [];
    for (let i = 0; i < recs.length; i++) {
      const src = lines.slice(recs[i].startLine - 1, recs[i].endLine);
      const stripped = convertMd.stripMarker(src, shape.kinds[i]);
      if (!stripped.ok) { refuseStructuralListEdit('此區塊的格式無法轉換'); return; }
      pieces.push(convertMd.emitAs(stripped.content, target, {}).join('\n'));
    }
    const md = pieces.join('\n\n');

    const result = commitRangeEdit({ lines, blocks, stack },
      first.startLine, last.endLine, md);
    // Nothing changed (converting an H2 to 標題 2) — and nothing was pushed
    // onto the undo stack either, so there is nothing to render or roll back,
    // and no selection range to declare.
    if (result.op === null) return;
    const prevLines = lines;
    lines = result.lines;
    // §3.3: 「操作後集合塌縮為操作結果所涵蓋的行區間」. Declared IMMEDIATELY
    // before the render, never earlier (Task 5 carry 5): rerenderAll() consumes
    // the declaration at its very top, so one left standing lands on some
    // later, unrelated render.
    declareCollapse({
      startLine: first.startLine,
      endLine: first.startLine + md.split('\n').length - 1,
    });
    const okRender = await safeRerenderAll();
    if (!okRender) {
      lines = rollbackFailedRender({ lines, stack }, result, prevLines);
    }
  }

  // Is the editor session switchAwayFrom() would resolve open on THIS block?
  // Both shapes count — the always-on WYSIWYG burst and the older raw-edit /
  // table-cell `activeEditor` — because resolveOpenSession() commits either.
  function ownsOpenSession(blockEl) {
    if (currentBurst && currentBurst.blockEl === blockEl) return true;
    if (activeEditor && activeEditor.blockEl === blockEl) return true;
    return false;
  }

  // The narrowed re-resolve for the case above: startLine and type must still
  // match, but the source is allowed to differ because our own switchAwayFrom()
  // just rewrote it. Deliberately NOT folded into reresolveBlockEl() — every
  // other caller of that function needs the fingerprint, and a shared helper
  // that sometimes skips it is the shape that lets a future call site act on a
  // block the user never pointed at.
  function reresolveBlockElAfterSelfCommit(identity) {
    if (!identity) return null;
    const at = blocks.find((b) => b.startLine === identity.startLine);
    if (!at || at.type !== identity.type) return null;
    return document.querySelector('.ed-block[data-block-id="' + at.id + '"]');
  }

  // S2 Task 6 — 建立副本 (§4.3).
  //
  // The copy is inserted after the block's ENTIRE SUBTREE, never after its own
  // line. The spec records the measurement and it reproduces here:
  //   after the subtree  '- a\n  - a1\n- a\n- b\n'
  //     -> items ['- a\n  - a1\n', '- a\n', '- b']   (a keeps its child)
  //   after a's own line '- a\n- a\n  - a1\n- b\n'
  //     -> items ['- a\n', '- a\n  - a1\n', '- b']   (the COPY got a1)
  // Both lex cleanly and both are tight, so nothing but the item boundaries
  // tells them apart — which is why the runtime scenario asserts the raws.
  //
  // TWO commit paths, and which one each case takes was MEASURED against the
  // pure core, not reasoned from symmetry:
  //
  //  * a NON-li block goes through commitBlockInsertion(), which IS this
  //    operation and already owns the blank-line policy (see :170-179).
  //    Measured on ['# Doc','','alpha',''] with body ['alpha']:
  //    '# Doc\n\nalpha\n\nalpha\n'.
  //  * a li does NOT — this is the trap. commitBlockInsertion() ALWAYS
  //    inserts a leading blank line. Measured on ['# Doc','','- a','- b','']
  //    with body ['- a'] it returns '# Doc\n\n- a\n\n- a\n\n- b\n', and
  //    marked.lexer() reports that as ONE list with loose === true. Every item
  //    of a loose list renders as <p>, serializeBlocks() pushes 'P' for each of
  //    them (list-md.js:462) and the WHOLE run degrades read-only with no
  //    banner — §4.3 rule 2's defect, re-opened by a duplicate instead of by a
  //    conversion. A li therefore duplicates through its own RUN's
  //    re-serialization (duplicateListItems() below), which emits no blank at
  //    all and re-runs §3.8's renumbering on the way.
  //
  // Neither path re-serializes the copy's CONTENT: the non-li path slices
  // `lines`, and the li path carries the clone through bystanderCarryOver()
  // under the ORIGINAL's block id, so list-md.js replays the file's own bytes
  // for it and only re-states the marker. Both keep a `~5px` a `~5px`.
  async function duplicateBlockViaMenu(blockEl) {
    // §3.3's membership rules plus the shared preamble — see
    // resolveGutterOperands(). The whole span is duplicated by ONE commit; a
    // per-member loop would re-render between items and invalidate every id in
    // between.
    const operands = await resolveGutterOperands(blockEl);
    if (!operands) return;
    const els = operands.els;
    const recs = operands.recs;
    const shape = spanListKinds(els);
    if (shape.anyLi && !shape.allLi) { refuseStructuralListEdit(BATCH_MIXED_MESSAGE); return; }

    if (shape.allLi) {
      await duplicateListItems(els, recs);
      return;
    }

    // The non-li span duplicates as ONE slice of `lines` — separators between
    // its members included, which is what makes the copies re-lex as the same N
    // blocks rather than one merged one. commitBlockInsertion() anchors on the
    // LAST member (it inserts BELOW its anchor), and its own leading blank is
    // the separator between the original span and the copy.
    const first = recs[0];
    const last = recs[recs.length - 1];
    const result = commitBlockInsertion({ lines, blocks, stack }, last.id,
      lines.slice(first.startLine - 1, last.endLine));
    if (result.op === null) return;
    const prevLines = lines;
    lines = result.lines;
    // §3.3's collapse. A duplicate inserts BELOW everything it copied, so the
    // originals keep the exact line range they had — declaring it is the same
    // answer as "keep what is standing" and says so explicitly, which is what
    // keeps this correct if the insertion point ever moves.
    declareCollapse({ startLine: first.startLine, endLine: last.endLine });
    if (!(await safeRerenderAll())) {
      lines = rollbackFailedRender({ lines, stack }, result, prevLines);
    }
  }

  // The li half of 建立副本. The copy is spliced into the run's own span and the
  // WHOLE span is re-serialized over the run's line range — one commitRangeEdit,
  // therefore one undo op (§4.3: 建立副本與刪除均為單一 undo), no leading blank, and
  // §3.8's renumbering falls out of the re-serialization ('1. alpha' duplicated
  // gives '1. alpha / 2. alpha / 3. bravo', not '1. alpha / 1. alpha / 2.
  // bravo').
  async function duplicateListItems(liEls, recs) {
    // Every list batch is one run's problem — see batchRunOf().
    const run = batchRunOf(liEls);
    if (!run) { refuseStructuralListEdit(BATCH_MULTIRUN_MESSAGE); return; }
    // §4.3's run-wide gate — 轉換／建立副本／刪除／拖曳 each make this call for
    // themselves; there is no shared helper. Its input is §3.4 rule 2's scope,
    // which is exactly what listRunOf() returns (the outermost run PLUS every
    // descendant of its members). A duplicate is NOT column-only (§4.1 修訂 2:
    // it adds the item's lines over again), so a multi-line li refuses as a
    // TARGET while remaining a perfectly good bystander — and in a batch EVERY
    // member is a target.
    if (!listRunSupportsStructuralEdit(run, liEls)) { refuseStructuralListEdit(); return; }
    // Captured BEFORE the copy enters the span. The copy carries the
    // ORIGINAL's data-block-id — that is what makes bystanderCarryOver() replay
    // its bytes rather than re-escape them — so runRangeOfBlocks() would
    // resolve it to the original's record, and on a duplicate of the span's
    // LAST member that silently re-states the range's end line.
    const range = runRangeOfBlocks({ lines, blocks, stack }, run);
    if (!range) return;

    // §4.3, measured: after the SUBTREE, not after the item's own line.
    // subtreeBlocksAfter() is the flat model's subtree — the contiguous run of
    // following blocks at a STRICTLY greater indent — and listRunOf() already
    // covers every one of them, so the insertion point is always inside `run`.
    // For a BATCH the anchor is the LAST member's subtree, which is the direct
    // generalization: the copies land after everything the set owns, in the
    // set's own document order.
    const anchorLi = liEls[liEls.length - 1];
    const subtree = subtreeBlocksAfter(anchorLi, Number(anchorLi.getAttribute('data-indent')) || 0);
    const lastEl = subtree.length ? subtree[subtree.length - 1] : anchorLi;
    const at = run.indexOf(lastEl);
    if (at < 0) return;

    const copies = liEls.map((liEl) => liEl.cloneNode(true));
    // `data-list-start` is the ONLY carrier of "marked's lexer opened a new
    // list token here" (§3.8 rule (d)) and serializeBlocks() resets the
    // ordinal counter on it. A copy is never a token boundary — it sits inside
    // the run it was cloned from — so a clone that kept the attribute would
    // restart the numbering: duplicating the first item of '1. alpha / 2.
    // bravo' emits '1. alpha / 1. alpha / 2. bravo'.
    copies.forEach((copy) => copy.removeAttribute('data-list-start'));
    const span = run.slice(0, at + 1).concat(copies, run.slice(at + 1));
    mutateListRun(() => {
      // One fixed reference node, so the copies land in their own order:
      // insertBefore(c1, ref) then insertBefore(c2, ref) gives lastEl, c1, c2.
      const ref = lastEl.nextSibling;
      copies.forEach((copy) => { lastEl.parentNode.insertBefore(copy, ref); });
    });
    // No `mutatedEl`: nothing in this span had its CONTENT rewritten in the
    // DOM, the copy included. The map is what keeps both lines byte-identical
    // to the file — dropping it entirely re-serializes them through
    // inline-md.js's escapeText() and a '~5px' comes back '\~5px' (measured;
    // the 'the copy is not re-escaped' scenario is what notices).
    //
    // ⚠ MEASURED, and worth stating because it is NOT the usual contract:
    // passing `liEl` here would be INERT, unlike at every other call site.
    // bystanderCarryOver() keys the map on the block ID, and the copy carries
    // the ORIGINAL's id — so the copy's own pass re-adds the very entry the
    // exclusion just skipped. The argument is omitted because it is wrong in
    // principle (nothing was mutated), not because a test would catch it.
    //
    // That shared id is also what makes ONE map entry serve both lines, while
    // list-md.js re-states each line's marker from that element's OWN
    // attributes — which is the §3.8 renumbering, and which is also how the
    // copy keeps its 型態 / 縮排 / 勾選狀態.
    // §3.3's collapse, declared immediately before the render inside
    // commitListStructure(). The copies land AFTER everything the set owns and
    // no member's line COUNT can change (a multi-line target is refused above,
    // and §3.8's renumbering only ever changes marker WIDTH), so the originals
    // still occupy exactly the range they occupied before the commit.
    declareCollapse({
      startLine: recs[0].startLine,
      endLine: recs[recs.length - 1].endLine,
    });
    await commitListStructure(span, null, false,
      { presetRange: range, carryOver: bystanderCarryOver(span) });
  }
  // Deletes `blockEl`'s ENTIRE line range (generalizing commitListBlockRemoval()
  // — unchanged, see its own comment — to any block type, not just an
  // emptied-out list). Same resolve-first / re-query-live-block-by-id
  // precondition as insertBlockBelow() above.
  async function deleteBlockViaGutter(blockEl) {
    // §3.3's membership rules plus the shared preamble (identity capture,
    // switchAwayFrom(), the re-resolve after a commit that re-rendered, and the
    // no-source-line refusal) — see resolveGutterOperands(). The stake on the
    // re-resolve is highest here: an id shift used to make this delete a
    // DIFFERENT block's lines, with the ⠿ menu the user pressed pointing at a
    // block that survived.
    const operands = await resolveGutterOperands(blockEl);
    if (!operands) return;
    const els = operands.els;
    const recs = operands.recs;
    const shape = spanListKinds(els);
    if (shape.anyLi && !shape.allLi) { refuseStructuralListEdit(BATCH_MIXED_MESSAGE); return; }
    // Spec §6, "S1 期間的已知危險" item 1: a LIST ITEM's delete is not a line
    // splice. S1 is what first put a ⠿ on a li, and the plain range removal
    // below corrupts a list three separate ways — see
    // deleteListItemsViaGutter() for the measurements and the routing.
    if (shape.allLi) {
      await deleteListItemsViaGutter(els);
      return;
    }
    // A contiguous span of non-list blocks is one line range: the separators
    // between its members are inside it by construction (members are adjacent
    // in `blocks`, so nothing else lives between them), and commitRangeRemoval()
    // absorbs exactly one adjacent blank on the outside — the same blank-line
    // contract commitListBlockRemoval() documents, which is literally this call
    // for a single block. The one-block case keeps going through that wrapper so
    // the shipped single-block path is byte-for-byte the S2 one.
    const first = recs[0];
    const last = recs[recs.length - 1];
    const result = els.length === 1
      ? commitListBlockRemoval({ lines, blocks, stack }, first.id)
      : commitRangeRemoval({ lines, blocks, stack }, first.startLine, last.endLine);
    const prevLines = lines;
    lines = result.lines;
    // §3.3's collapse: a delete's result covers NO lines, so the set is cleared
    // rather than collapsed (Task 1 carry 5 — collapseTo() answers null for an
    // inverted range, and §4.4 says a range that no longer resolves clears).
    // Declared immediately before the render, never earlier (Task 5 carry 5).
    declareCollapse(null);
    const okRender = await safeRerenderAll();
    if (!okRender) {
      lines = rollbackFailedRender({ lines, stack }, result, prevLines);
    }
  }

  // Spec §6, "S1 期間的已知危險" item 1 — the ⠿ delete of a LIST ITEM.
  //
  // Up to S1 this path did not exist: armEditables() returned before the
  // gutter chrome for a li, so the menu (and therefore its 刪除) was
  // unreachable on one. S1 gives every block a ⠿, which connected the
  // block-type-agnostic commitListBlockRemoval() to the most natural gesture
  // in the new UI — and that function deletes ONE BLOCK'S LINE RANGE, which is
  // the wrong unit for a list in three separate ways, all measured with a real
  // gesture plus Ctrl+S:
  //
  //   * its blank-line absorption is correct for a standalone block and wrong
  //     for a run member: the blank ABOVE the run still separates the
  //     SURVIVORS from whatever precedes them. 'Para.\n\n1. a\n2. b\n3. c\n'
  //     came back 'Para.\n2. b\n3. c\n' — one paragraph, three items gone,
  //     no banner.
  //   * no §3.4 clamp, so a child outlives its parent at an indent nothing
  //     anchors: '# T\n\n- a\n    - deep\n- b\n' left '    - deep' four
  //     columns after a heading, i.e. an INDENTED CODE BLOCK.
  //   * no re-serialization of the survivors, so an ordered run kept its old
  //     ordinals on disk ('2. b / 3. c') while the CSS counter showed 1,2 —
  //     the file and the screen disagreeing until somebody types in that run.
  //
  // The sequence is convertEmptyTopLevelLiToParagraph()'s, not a new one:
  // capture the span's range BEFORE mutating (removing the last item leaves
  // commitListStructure() nothing to derive it from), clamp, remove, then
  // commit the re-serialized survivors over that range with every one of them
  // carried over verbatim — nothing here rewrites any survivor's CONTENT, only
  // its marker and its leading columns.
  async function deleteListItemsViaGutter(liEls) {
    // Every list batch is one run's problem — see batchRunOf().
    const run = batchRunOf(liEls);
    if (!run) { refuseStructuralListEdit(BATCH_MULTIRUN_MESSAGE); return; }
    // §4.3's run-wide gate, whose input is §3.4 rule 2's scope — which is
    // exactly what listRunOf() returns (the outermost run PLUS every
    // descendant of its members), so the deeper runs this delete is about to
    // re-indent are covered, not just the target's own. Deleting is NOT
    // column-only: it removes the target's lines outright, so a multi-line
    // target refuses per §4.1 — and in a batch every member is a target.
    if (!listRunSupportsStructuralEdit(run, liEls)) { refuseStructuralListEdit(); return; }
    const range = runRangeOfBlocks({ lines, blocks, stack }, run);
    if (!range) return;
    // §3.4 rule 3's batch anchor: the SMALLEST old indent in the set, never the
    // first member's — see spanMinIndent().
    const oldIndent = spanMinIndent(liEls);
    const survivors = run.filter((el) => liEls.indexOf(el) === -1);
    mutateListRun(() => {
      // Clamp FIRST, while every member is still in the span: `{ removed: true }`
      // is what tells the pure function that these blocks can no longer anchor
      // anything, and rule 2's scope is measured from the LAST of their
      // positions. ONE call for the whole set, not one per member: clampIndents()
      // takes an array of operated indices precisely so a batch computes one
      // segment delta per §3.4 rule 3 instead of N independent clamps, which is
      // what splits the user's siblings apart.
      applyIndentClamp(run, liEls, oldIndent, { removed: true });
      liEls.forEach((el) => removeListItem(el));
    });
    // No `mutatedEl`: the deleted block is not among the survivors, and every
    // survivor's own bytes are exactly what the file already holds. The marker
    // is re-stated by the serializer regardless of the carry-over, which is
    // what renumbers the run (§3.8) and applies the clamped indent.
    //
    // §3.3's collapse: a delete's result covers no lines, so the set is cleared.
    // Declared immediately before commitListStructure(), whose only render on
    // this path is the one it makes after the commit — the `!range` bail above
    // it cannot fire, `presetRange` is non-null by construction here.
    declareCollapse(null);
    await commitListStructure(survivors, null, false,
      { presetRange: range, carryOver: bystanderCarryOver(survivors) });
  }

  // S2 Task 3 — 轉換成 › 項目符號列表 / 編號列表 / 待辦清單 on a li.
  //
  // The block STAYS a li, which is what makes this the easy list shape: the
  // run stays a run, so nothing here has to reach for convert-md.js at all.
  // The two attributes are flipped in the DOM and the whole span goes back
  // through commitListStructure() exactly like every other structural list op
  // — which is also what re-runs §3.8's renumbering (a type change splits the
  // run at this item, so both halves restart at 1) and §3.4's marker-width
  // stack (a child under a '1. ' parent moves from column 2 to column 3).
  //
  // `run` and the §4.3 gate are the CALLER's (convertBlockViaMenu): the gate
  // has to sit ahead of every other refusal so a multi-line li reports §4.1's
  // banner, and re-deriving the run here would walk `allBlockEls()` twice.
  //
  // MEASURED, and it contradicts the plan, which pinned blank lines either
  // side of the converted item: none are emitted and none are needed.
  // `marked.lexer('- alpha\n1. bravo\n- charlie\n')` already returns THREE
  // list tokens — a marker-type change interrupts a list on its own. §4.3
  // rule 1's blank line is about li → NON-LIST (Task 4), where a bare
  // paragraph line really would be swallowed as a lazy continuation.
  //
  // `data-list-type` and `data-task` are §4.1's two ORTHOGONAL axes, so 待辦
  // 清單 is 'ul' + task and switching to 項目符號列表 removes the checkbox
  // rather than merely unchecking it — a plain bullet has nowhere in the
  // markdown to store checkedness.
  // ── §4.3 rule 2 (the looseness trap), in its 2026-08-30 revised form ──────
  //
  // MEASURED, twice, and the second measurement is what the revision is about:
  //   marked.lexer('- a\n- b\n- c\n')   → ONE list, loose === false
  //   marked.lexer('- a\n- b\n\n- c\n') → ONE list, loose === TRUE
  // A blank line between two lists of the SAME marker type does not separate
  // them; it makes the single list they form LOOSE. Every item of a loose list
  // renders as `<p>…</p>`, serializeBlocks() reports 'P' for each of them
  // (list-md.js:56-70 documents the ruling, :462 is the push) and the whole run
  // degrades read-only — with NO banner, because nothing refused anything.
  //
  // The spec's original wording keyed the rule on 「來源是非清單」. That is
  // wrong, and the counter-example was measured in the live editor during S2
  // Task 3:
  //   start   '# Doc\n\n- a\n\n1. b\n'  → list|space|list, BOTH tight
  //   gesture 轉換成 › 項目符號列表 on `b`
  //   bytes   '# Doc\n\n- a\n\n- b\n'   → ONE list, loose === true
  //   after   every structural gesture on that run refuses with §4.1's banner
  // One li → li conversion froze a run the user could no longer restructure.
  // The ruling therefore keys on 「轉換結果是 li」: whatever the source was, if
  // the RESULT is a li, the separator to a same-type neighbour must be eaten.
  //
  // Two consequences that are not obvious:
  //
  // 1. The blank line being eaten lies OUTSIDE listRunOf()'s span — it belongs
  //    BETWEEN two runs, to neither. So the commit range has to be widened
  //    past runRangeOfBlocks(listRunOf(...)) explicitly. This is one of only
  //    two places where that happens (§3.4's 2026-08-30 erratum); the other is
  //    §4.3 rule 1's edge blanks in convertListItemsAway() above.
  //
  // 2. The run-wide gate has to hold for BOTH runs. Merging a DEGRADED run
  //    into a healthy one freezes the healthy one too — and declining to merge
  //    is no escape, because once the marker types match, markdown merges the
  //    two whether or not the separator survives (it just goes loose instead).
  //    The only correct answer there is to refuse the whole gesture, which is
  //    what `ok: false` means.
  //
  // ⚠ The question is asked about the neighbour's RUN, not about the
  // neighbour BLOCK — and this contradicts the plan's Task 5 sketch, which
  // tests `previousBlockEl`'s own data-indent/data-list-type. MEASURED:
  //   '- alpha\n  - beta\n\n- gamma\n' → ONE list, loose === true
  // The block above the separator is `beta` at indent 1, so the sketch's
  // predicate says "no merge" and commits exactly those degrading bytes. The
  // list `gamma` actually joins is ALPHA's, and looseness is a property of the
  // whole list token — so the comparison must be against listRunOf(neighbour)'s
  // HEAD, which is the run's top-level identity.
  //
  // `range` is the commit range as the caller's own machinery derived it;
  // `spanEls` the block span that range covers (used only to find the
  // neighbouring blocks); `headAttrs` / `tailAttrs` the {listType, indent} the
  // span's first and last TOP-LEVEL lines will carry AFTER the conversion —
  // which is why they are passed in rather than read here: for li → li this
  // runs BEFORE the DOM mutation, so a refusal never has a half-mutated run to
  // undo.
  function widenRangeForListMerge(range, spanEls, headAttrs, tailAttrs) {
    const all = allBlockEls();
    const first = spanEls[0];
    const last = spanEls[spanEls.length - 1];
    const i = all.indexOf(first);
    const j = all.indexOf(last);
    let startLine = range.startLine;
    let endLine = range.endLine;
    const sides = [
      { el: i > 0 ? all[i - 1] : null, attrs: headAttrs, back: true },
      { el: (j >= 0 && j + 1 < all.length) ? all[j + 1] : null, attrs: tailAttrs, back: false },
    ];
    for (let k = 0; k < sides.length; k++) {
      const side = sides[k];
      if (!side.el || !side.attrs) continue;
      if (side.el.getAttribute('data-block-type') !== 'li') continue;
      // The neighbour's OWN outermost run — see the ⚠ above.
      const nrun = listRunOf(side.el);
      if (!nrun.length) continue;
      const head = nrun[0];
      if ((Number(head.getAttribute('data-indent')) || 0) !== side.attrs.indent) continue;
      const headType = head.getAttribute('data-list-type') === 'ol' ? 'ol' : 'ul';
      if (headType !== side.attrs.listType) continue;
      // Every line between two adjacent blocks is blank by construction
      // (buildBlockMap() strips a token's trailing newlines, so no block ever
      // owns a separator). Eating ALL of them is also 「正規化連續空行」:
      // measured, '- a\n\n\n- b\n' is still ONE loose list, so stopping after
      // one blank would leave the degrade in place.
      let moved = false;
      if (side.back) {
        while (startLine >= 2 && String(lines[startLine - 2]).trim() === '') {
          startLine -= 1; moved = true;
        }
      } else {
        while (endLine < lines.length && String(lines[endLine]).trim() === '') {
          endLine += 1; moved = true;
        }
      }
      // No separator between us and it: they are already two runs that
      // markdown keeps apart for a reason this rule does not touch (a
      // delimiter change, `- a` / `* b`). Nothing to eat, nothing to gate.
      if (!moved) continue;
      // Consequence 2. `columnOnly` is the honest option here: this run's
      // bytes are not being rewritten AT ALL (it sits entirely outside the
      // commit range), so the only question worth asking of it is the
      // `unsupported` one — and a hard-wrapped bystander li in there must not
      // veto the merge, exactly as §4.1 keeps it legal everywhere else.
      if (!listRunSupportsStructuralEdit(nrun, null, { columnOnly: true })) {
        return { startLine: range.startLine, endLine: range.endLine, ok: false };
      }
    }
    return { startLine: startLine, endLine: endLine, ok: true };
  }

  // The {listType, indent} a span member will carry once the operand set
  // `liEls` has become `attrs`. Everything outside the set keeps what it has.
  function postConvertLiAttrs(el, liEls, attrs) {
    return {
      listType: liEls.indexOf(el) !== -1
        ? attrs.listType
        : (el.getAttribute('data-list-type') === 'ol' ? 'ol' : 'ul'),
      indent: Number(el.getAttribute('data-indent')) || 0,
    };
  }

  async function convertListItemsType(liEls, run, recs, target) {
    const range = runRangeOfBlocks({ lines, blocks, stack }, run);
    if (!range) return;
    const attrs = convertMd.listAttrsFor(target);
    if (!attrs) return;
    // §4.3 rule 2, in its revised form: the ruling keys on 「轉換結果是 li」,
    // so it applies HERE too, not only to the 非清單 → 清單 path below. This
    // is the S2 Task 3 defect — '- a' + blank + '1. b', both tight, and one
    // 轉換成 › 項目符號列表 on `b` merged them into one LOOSE list that froze
    // read-only with no banner. See widenRangeForListMerge()'s own note.
    //
    // The head/tail of the span are compared, not the converted item: a
    // conversion in the MIDDLE of a run leaves the run's outer lines alone, and
    // it is those that abut the separators. `tailEl` is the last member at the
    // span's TOP-LEVEL indent — listRunOf() includes descendants, and a nested
    // trailing item is not what the following list token would merge with.
    // Computed BEFORE mutateListRun() so a refusal has nothing to undo.
    const headEl = run[0];
    const headIndent = Number(headEl.getAttribute('data-indent')) || 0;
    let tailEl = headEl;
    run.forEach((el) => {
      if ((Number(el.getAttribute('data-indent')) || 0) === headIndent) tailEl = el;
    });
    const merged = widenRangeForListMerge(range, run,
      postConvertLiAttrs(headEl, liEls, attrs), postConvertLiAttrs(tailEl, liEls, attrs));
    if (!merged.ok) { refuseStructuralListEdit(); return; }
    // How far the run's own first line MOVES. widenRangeForListMerge() only ever
    // widens the range BACKWARDS over blank separators (§4.3 rule 2's tight
    // merge), and the markdown written over the widened range is the run's own
    // serialization with no leading blank — so every line of the run shifts up
    // by exactly this much, and the collapse range below has to shift with it.
    const shift = merged.startLine - range.startLine;
    range.startLine = merged.startLine;
    range.endLine = merged.endLine;
    mutateListRun(() => {
      liEls.forEach((liEl) => {
        liEl.setAttribute('data-list-type', attrs.listType);
        liEl.setAttribute('data-task', attrs.task ? '1' : '0');
        const box = liCheckEl(liEl);
        if (attrs.task) {
          // Insert BEFORE the surface: §4.1 fixes the child order as
          // marker → check → text, and list-md.js's firstChildWithClass() plus
          // the delegated checkbox-toggle listener both assume it.
          if (!box) liEl.insertBefore(buildLiCheckbox(), liTextEl(liEl));
        } else if (box) {
          box.remove();
        }
      });
    });
    // NO `mutatedEl` — deliberately, and this contradicts the plan's Task 3
    // sketch, which passes `liEl`. bystanderCarryOver(span, mutatedEl)
    // EXCLUDES `mutatedEl` from the replay map, so naming the converted item
    // is what sends ITS content back through inline-md.js's escapeText().
    // Measured: serializeInline('~5px') === '\~5px', and the runtime scenario
    // 'a list-type change never re-escapes the item’s own content' failed
    // exactly that way before this line lost its second argument. Nothing
    // here rewrote the item's CONTENT — only two attributes and a checkbox
    // span, none of which the serializer reads from `.ed-li-text` — so its
    // bytes belong to the file, same as every other member of the run.
    // Carrying it is free: list-md.js emits `head + carriedSplit.content` for
    // a carried line, i.e. it re-states the marker from the NEW attributes,
    // and SRC_MARKER_RE eats the old bullet AND the old GFM checkbox off the
    // carried source. That is what makes '- [x] alpha' → '- alpha' work.
    //
    // §3.3's collapse: the operand set stays exactly where it is — the members
    // are still list items in the same run and only their MARKERS are re-stated,
    // so no line count inside the run can change. Only the merge widening moves
    // them, by `shift`.
    declareCollapse({
      startLine: recs[0].startLine + shift,
      endLine: recs[recs.length - 1].endLine + shift,
    });
    await commitListStructure(run, null, false,
      { presetRange: range, carryOver: bystanderCarryOver(run) });
  }

  // The `data-block-type` a conversion target will carry once it is committed.
  // Only ever handed to indent-clamp's `operatedBecomes`, whose one question
  // is "is this still a li?" — but naming the real type keeps the call honest
  // if the pure function ever grows a second question.
  function convertedBlockType(target) {
    if (/^h[1-6]$/.test(target)) return 'heading';
    if (target === 'quote') return 'blockquote';
    if (target === 'code') return 'code';
    return 'paragraph';
  }

  // S2 Task 4 — 轉換成 › 文字 / 標題 N / 程式碼 / 引用 on a li (§4.3 rule 1).
  //
  // The item LEAVES the run, so the run's own line range is rebuilt in three
  // pieces: the survivors before it, the converted block's own lines (read
  // from `lines`, never re-serialized — that is what keeps a `~5px` a `~5px`),
  // and the survivors after it. §3.8's renumbering falls out of re-serializing
  // each surviving half on its own; §4.3 rule 1's blank lines are the '\n\n'
  // joins between the pieces.
  //
  // `run` and the §4.3 run-wide gate are the CALLER's (convertBlockViaMenu),
  // for the reason spelled out there: the gate must sit ahead of every other
  // refusal so a multi-line li reports §4.1's banner and not stripMarker()'s
  // narrower one.
  //
  // Deliberately NOT re-checked here: `serializeBlocks().unsupported` on the
  // two halves. The gate above already serialized the WHOLE run through
  // listRunSupportsStructuralEdit(), and `unsupported` is a per-block fact, so
  // splitting the span cannot add a name. A naive `unsupported.length > 0`
  // re-check is worse than redundant — it refuses a HARD-WRAPPED bystander,
  // which §4.1 explicitly keeps legal (MULTILINE is filtered out of the
  // run-wide veto and re-checked against the TARGET's line range only).
  // Measured; the 'a multi-line bystander is replayed, not refused' scenario
  // is what notices.
  async function convertListItemsAway(liEls, run, recs, target) {
    const range = runRangeOfBlocks({ lines, blocks, stack }, run);
    if (!range) return;
    // Each member's own bytes, read from `lines` and never re-serialized — that
    // is what keeps a `~5px` a `~5px`. Joined by a blank line so N converted
    // items re-lex as N blocks and not one lazy continuation of the first.
    const convertedPieces = [];
    for (let i = 0; i < liEls.length; i++) {
      const rec = recs[i];
      const stripped = convertMd.stripMarker(lines.slice(rec.startLine - 1, rec.endLine), 'li');
      if (!stripped.ok) { refuseStructuralListEdit('此區塊的格式無法轉換'); return; }
      convertedPieces.push(convertMd.emitAs(stripped.content, target, {}).join('\n'));
    }
    const convertedMd = convertedPieces.join('\n\n');

    // §3.4 rule 3's batch anchor — the SMALLEST old indent in the set.
    const oldIndent = spanMinIndent(liEls);
    // ONE contiguous index range, never a loop over `run.indexOf(member)`
    // per item: the run is split ONCE into the survivors before the set and the
    // survivors after it. The operand set is contiguous in `blocks` (checked by
    // spanIsContiguous() before any of this) and the run is a contiguous slice
    // of the same list, so the two indices below bracket exactly `liEls.length`
    // members — asserted rather than assumed, because this arithmetic is what
    // writes the bytes and an off-by-one here silently re-serializes a
    // bystander into the converted half.
    const idx = run.indexOf(liEls[0]);
    const lastIdx = run.indexOf(liEls[liEls.length - 1]);
    if (idx < 0 || lastIdx < idx || lastIdx - idx + 1 !== liEls.length) {
      refuseStructuralListEdit(BATCH_GAP_MESSAGE);
      return;
    }
    const before = run.slice(0, idx);
    const after = run.slice(lastIdx + 1);

    // §3.4, and the FIRST production caller of the pure clamp's
    // `operatedBecomes` branch (RULING T6-B). `liEl` stays in the span — the
    // option is what tells clampIndents() that it can no longer anchor
    // anything, and rule 2's scope is measured from its position — and it is
    // NOT removed from the DOM: nothing below serializes it (its bytes come
    // from convert-md.js), commitRangeEdit() + safeRerenderAll() rebuild the
    // whole document from markdown anyway, and leaving it there means a
    // FAILED render shows the pre-conversion item rather than a hole.
    // mutateListRun() is still the wrapper, for its finally: `data-indent`
    // just moved on the survivors, so `data-run-start` (the ordered counter's
    // CSS reset) is stale for the length of the render round trip.
    //
    // ⚠ MEASURED, and it contradicts the plan's step 7: on the plan's own
    // '- alpha / (2sp)- child / (4sp)- grandchild' fixture this clamp is a
    // NO-OP on the emitted bytes. serializeBlocks() rebuilds its marker-width
    // stack from EMPTY for each span it is given (list-md.js:502,
    // `widths.slice(0, indent)`), so the first block of the `after` half
    // always emits at column 0 whatever its data-indent says — which is
    // exactly what the clamp would have done to it. The clamp earns its place
    // one shape further out: when the scope holds TWO segments (§3.4 rule 3),
    // their deltas differ and the width stack cannot derive that on its own.
    // The 'the §3.4 segment deltas survive the split commit' scenario is that
    // shape, and it is the one that goes red without this option.
    mutateListRun(() => {
      applyIndentClamp(run, liEls, oldIndent, { operatedBecomes: { type: convertedBlockType(target) } });
    });

    // No `mutatedEl`: the converted block is in neither half, and every
    // survivor's bytes are exactly what the file already holds. Naming a block
    // here EXCLUDES it from the replay map, which is what sends its content
    // back through escapeText() — see convertListItemsType()'s note.
    const carry = bystanderCarryOver(before.concat(after));
    const pieces = [];
    if (before.length) pieces.push(listMd.serializeBlocks(before, { carryOver: carry }).md);
    // Which piece the converted blocks are — the collapse range below counts
    // emitted LINES up to it, and "0 or 1" is only true while `before` is the
    // one optional piece ahead of it.
    const convertedPieceIdx = pieces.length;
    pieces.push(convertedMd);
    if (after.length) pieces.push(listMd.serializeBlocks(after, { carryOver: carry }).md);
    let md = pieces.join('\n\n');

    // §4.3 rule 1 at the RUN's own edges. Inside the range the '\n\n' joins
    // above already separate the pieces; outside it, the neighbouring line
    // belongs to another block and may be a li of an ADJACENT run (a
    // list-type change splits a run without a blank line — measured in Task
    // 3), in which case '- alpha / bravo' re-lexes as one item. The blank is
    // added only when the neighbour is not already blank, which is also what
    // 「正規化連續空行」 amounts to here: no double separator is ever created.
    let lead = 0;
    if (!before.length && range.startLine > 1 &&
        String(lines[range.startLine - 2]).trim() !== '') { md = '\n' + md; lead = 1; }
    if (!after.length && range.endLine < lines.length &&
        String(lines[range.endLine]).trim() !== '') md = md + '\n';

    // §3.3's collapse: 「操作後集合塌縮為操作結果所涵蓋的行區間」— the CONVERTED
    // blocks' own lines, not the whole commit range (which is the entire run,
    // bystanders included). Counted in emitted lines: every '\n\n' join
    // between two pieces adds one blank line on top of the piece's own lines,
    // and `lead` is the one §4.3 rule 1 puts at the very front.
    let offset = lead;
    for (let k = 0; k < convertedPieceIdx; k++) offset += pieces[k].split('\n').length + 1;
    const outStart = range.startLine + offset;
    const outEnd = outStart + convertedMd.split('\n').length - 1;

    const result = commitRangeEdit({ lines, blocks, stack }, range.startLine, range.endLine, md);
    if (result.op === null) return;
    const prevLines = lines;
    lines = result.lines;
    declareCollapse({ startLine: outStart, endLine: outEnd });
    if (!(await safeRerenderAll())) {
      lines = rollbackFailedRender({ lines, stack }, result, prevLines);
    }
  }

  // S2 Task 5 — 轉換成 › 項目符號列表 / 編號列表 / 待辦清單 on a block that is
  // NOT a list item (§4.3 rule 2, the return leg of rule 1).
  //
  // Line-level like every other conversion: the source comes from `lines`, so
  // the content is never re-serialized and a `~5px` stays a `~5px`. The block
  // owns its own lines and nothing else is re-emitted, so there is no run to
  // serialize and no carryOver to build — the two neighbouring runs are
  // deliberately left byte-untouched, and the ONLY thing that leaves the
  // block's own range is the blank separator rule 2 eats.
  //
  // No §4.1 run-wide gate on the way in: the source is not a li, so it belongs
  // to no run. The gate that DOES apply is the one inside
  // widenRangeForListMerge(), on whichever neighbouring run this block is
  // about to merge into.
  async function convertBlocksIntoList(blockEls, recs, kinds, target) {
    const attrs = convertMd.listAttrsFor(target);
    if (!attrs) return;
    // One item per member, joined by a bare newline: the members' own
    // separators are INSIDE the commit range and are replaced, which is what
    // makes N paragraphs one TIGHT list. A blank between them would make the
    // list loose and degrade every item read-only (§4.3 rule 2).
    const pieces = [];
    for (let i = 0; i < recs.length; i++) {
      const stripped = convertMd.stripMarker(
        lines.slice(recs[i].startLine - 1, recs[i].endLine), kinds[i]);
      if (!stripped.ok) { refuseStructuralListEdit('此區塊的格式無法轉換'); return; }
      pieces.push(convertMd.emitAs(stripped.content, target, {}).join('\n'));
    }
    const md = pieces.join('\n');
    const first = recs[0];
    const last = recs[recs.length - 1];

    // emitAs() puts a list target at column 0 with no indent prefix, so the
    // span's post-conversion identity is (target list type, indent 0) on both
    // edges — it emits one item per member, however many physical lines each
    // item spans.
    const self = { listType: attrs.listType, indent: 0 };
    const merged = widenRangeForListMerge(
      { startLine: first.startLine, endLine: last.endLine }, blockEls, self, self);
    if (!merged.ok) { refuseStructuralListEdit(); return; }

    const result = commitRangeEdit({ lines, blocks, stack },
      merged.startLine, merged.endLine, md);
    if (result.op === null) return;
    const prevLines = lines;
    lines = result.lines;
    // §3.3's collapse: the emitted items occupy the whole (possibly widened)
    // commit range — nothing else is written here.
    declareCollapse({
      startLine: merged.startLine,
      endLine: merged.startLine + md.split('\n').length - 1,
    });
    if (!(await safeRerenderAll())) {
      lines = rollbackFailedRender({ lines, stack }, result, prevLines);
    }
  }

  // The `.ed-li-check` chrome for a li that has just BECOME a task item.
  //
  // ⚠ This markup must stay byte-identical to the renderer's, which builds the
  // same span from a template literal at lib/md2doc.js:287-289:
  //   <span class="ed-li-check" data-checked="0" role="checkbox"
  //         aria-checked="false"></span>
  // Attribute ORDER matters as well as content: `bystanderCarryOver()` and the
  // burst baseline both compare innerHTML strings, and the very next successful
  // render replaces this element with the renderer's own — so a mismatch would
  // show up as a spurious diff for exactly one commit round trip. A new
  // task item is always unchecked (nothing in a `- alpha` line says otherwise).
  //
  // It deliberately carries NO click handler: the toggle is a delegated
  // listener on `.content` that resolves via closest('.ed-li-check').
  // It adds no NEW element type either — 'ed-li-check' is already in
  // list-md.js's closed LI_CHROME allowlist, so serializeBlocks() keeps
  // skipping it instead of reporting SPAN as unsupported.
  function buildLiCheckbox() {
    const box = document.createElement('span');
    box.className = 'ed-li-check';
    box.setAttribute('data-checked', '0');
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', 'false');
    return box;
  }

  // The ⠿ menu's "MD 原始碼" escape hatch: discards (never commits) any
  // in-progress burst on THIS block — same "throw away my WYSIWYG edits,
  // switch to raw-edit against the untouched on-disk source" contract the
  // old bar's MD button had — then opens the raw textarea. Deliberately
  // does NOT go through switchAwayFrom() for `blockEl`'s own burst (that
  // would COMMIT it, the opposite of what this button means); it still
  // resolves (commits/cancels) anything ELSE that might be open first, as a
  // defensive precondition, same as openRawEditor()'s own guard.
  async function openRawViaGutter(blockEl) {
    if (!blockEl) return;
    if (currentBurst && currentBurst.blockEl === blockEl) {
      // Final-review Finding 4 (Important): this used to null `currentBurst`
      // WITHOUT restoring `editEl.innerHTML` first — unlike every other
      // "discard this burst" exit (revertBurstAndEnd()/
      // revertTableBurstAndEnd() above both do `editEl.innerHTML =
      // burst.original` before nulling), so the burst's un-committed DOM
      // (whatever the user had typed) stayed sitting in the live DOM,
      // un-reverted. openRawEditor() below reads its raw-textarea seed from
      // the block's SOURCE (`lines`), not from this DOM, so the discarded
      // typing didn't show up in the raw editor itself — but the
      // now-orphaned WYSIWYG surface behind it still held it. The very next
      // focus/blur cycle on that same block (click into it, click back out
      // — e.g. after Esc-ing the raw editor) re-armed that same stale DOM
      // and committed it as if it were live content: the "discarded" edit
      // resurrected itself into `lines`. Restore the pre-edit snapshot
      // FIRST, mirroring revertBurstAndEnd()'s own contract, so nothing is
      // left behind for a later burst to accidentally pick up and commit.
      currentBurst.editEl.innerHTML = currentBurst.original;
      currentBurst.history.dispose();
      currentBurst = null;
      resetSelToolbarState();
    } else {
      const ok = await switchAwayFrom();
      if (!ok) return;
    }
    openRawEditor(blockEl);
  }

  // Starts a burst on `editEl` (a `.ed-wys-armed` content element) — called
  // from the delegated `focusin` listener below. captureFn snapshots the
  // surface's innerHTML; history.start() records snapshot 0 (the pre-edit
  // baseline Esc reverts to).
  // S2 (Important): the "did the user actually change anything?" baseline —
  // `editEl.innerHTML` with SELECTION CHROME stripped. Every burst-level
  // comparison against `burst.original` (resolveBurst()'s zero-edit guard,
  // burstUndo()/tableBurstUndo()'s pristine-insert probes) and every
  // burst-history snapshot goes through here, so both sides of every such
  // comparison are normalised the same way.
  //
  // Why it has to exist: showRowMenu()/showColumnMenu() add '.ed-te-hl' to
  // LIVE cells before any burst exists, and the delete handler then opens
  // the burst — so a raw `tableEl.innerHTML` baseline BAKES THE HIGHLIGHT
  // IN. A refused delete ("無法刪除最後一列/欄") leaves that highlight
  // standing; the next click elsewhere strips it, and the baseline no longer
  // matches an untouched table. resolveBurst() then re-serialises the whole
  // thing through table-md.js's canonical form, silently destroying hand
  // padding and hand-written alignment in a table the user never edited.
  // Fixing only the refusal path (hideTableEdgeMenu() there) does not help:
  // stripping the class is itself the diff, whichever code path does it.
  // The same reasoning covers '.ed-te-row-dragging', which a drag adds and
  // pointerup/cancelTeDrag() removes.
  //
  // Fast path first: the overwhelming majority of calls (every paragraph /
  // heading / list burst, and any table with no selection on it) carry no
  // chrome at all, and must not pay for a full subtree clone. When chrome IS
  // present the clone is mutated instead of the live DOM, so the user's
  // visible selection survives the measurement. classList.remove() on the
  // clone re-serialises the class attribute joined by single spaces — byte-
  // identical to what the renderer emitted — and an attribute left empty is
  // dropped outright (the renderer never emits `class=""`).
  function burstBaselineHtml(editEl) {
    const html = editEl.innerHTML;
    if (html.indexOf('ed-te-hl') === -1 && html.indexOf('ed-te-row-dragging') === -1) return html;
    const clone = editEl.cloneNode(true);
    const marked = clone.querySelectorAll('.ed-te-hl, .ed-te-row-dragging');
    Array.prototype.forEach.call(marked, (el) => {
      el.classList.remove('ed-te-hl');
      el.classList.remove('ed-te-row-dragging');
      if (!el.className) el.removeAttribute('class');
    });
    return clone.innerHTML;
  }

  function startBurst(editEl) {
    const blockEl = editEl.closest('.ed-block');
    if (!blockEl) return;
    const blockId = Number(blockEl.getAttribute('data-block-id'));
    const block = blocks.find((b) => b.id === blockId);
    if (!block) return;
    const blockType = blockEl.getAttribute('data-block-type');
    const history = historyLib.createBurstHistory(() => burstBaselineHtml(editEl), { debounceMs: 400 });
    history.start();
    currentBurst = {
      blockEl, editEl, blockId, blockType,
      depth: blockDepthOf(blockType, editEl),
      original: burstBaselineHtml(editEl),
      history,
    };
    selToolbarEditEl = editEl;
    if (!selToolbarListener) {
      selToolbarListener = onSelectionChangeForToolbar;
      document.addEventListener('selectionchange', onSelectionChangeForToolbar);
    }
  }

  // Extracts the three-statement burst teardown (dispose history, null
  // currentBurst, reset toolbar) into a named helper so every refuse/no-op
  // path shares the same idiom and structural ops can call it explicitly
  // after their own commit to prevent the subsequent focusout from
  // double-committing (the focusin/focusout handlers check currentBurst).
  function endBurstWithoutResolve() {
    const burst = currentBurst;
    if (burst) burst.history.dispose();
    currentBurst = null;
    resetSelToolbarState();
  }

  // Resolves the currently-open burst: serialize -> commit if changed (via
  // the same commitEdit()/safeRerenderAll() pipeline every other edit in
  // this file uses), silently drop if unchanged. Same true/false contract as
  // activeEditor.commitNow() above (false = a network commit genuinely
  // failed; the burst stays OPEN with its DOM untouched, banner already
  // shown — Global Constraint's commit-failure rollback + single-flight
  // semantics). Called only from resolveOpenSession() (switchAwayFrom()'s
  // extended body) — never call this directly.
  async function resolveBurst() {
    const burst = currentBurst;
    // Task 5: any burst resolution (table or not) invalidates whatever
    // boundary the hover-insert overlay was tracking — cheap/idempotent even
    // when the bubbles are already hidden, so unconditional here is simpler
    // than gating it on burst.blockType === 'table'.
    hideTableInsertBubbles();
    // Task 6: same reasoning for the grip handles, the edge-click menu, and
    // any in-flight row drag — all three reference elements of whichever
    // table this resolution is about to commit/detach.
    hideTableGrips();
    hideTableEdgeMenu();
    cancelTeDrag();
    if (!burst) return true;
    // §10-gap fix (review): this burst's block's "pristine" window (see
    // `pristineInsert`'s own comment) closes right here, the moment its
    // OWN first burst resolves — one way (a real edit, below) or the
    // other (still byte-identical to the skeleton, checked next).
    // Captured + cleared BEFORE that check runs so no later resolution on
    // this same block can ever act on a stale reference once it's had a
    // real edit.
    const wasPristineForThisBlock = !!(pristineInsert && pristineInsert.blockId === burst.blockId);
    if (wasPristineForThisBlock) pristineInsert = null;
    // Final-review Finding 2 (Critical): a zero-edit burst (focus into a
    // surface, then blur/click-out with no actual DOM mutation — e.g.
    // clicking into a hand-padded/long-dash table cell, or just clicking a
    // paragraph and clicking away) used to fall straight through to the
    // serialize -> commitEdit() path below regardless. table-md.js's/
    // inline-md.js's/list-md.js's serializers always emit their OWN
    // canonical form (single space between pipes, minimal `---`
    // separators, no padding) — so opening a burst on non-canonical-but-
    // otherwise-untouched source (hundreds of hand-formatted tables exist
    // in real corpora) silently REWROTE it to the serializer's minimal form
    // and marked the document dirty even though the user typed nothing.
    // `burst.original` is exactly `burstBaselineHtml(burst.editEl)`
    // captured at focus time (startBurst()/startTableBurst() above, for
    // every block type this burst substrate covers — paragraph/heading/
    // list/table all store it the same way): the surface's innerHTML with
    // table SELECTION CHROME normalised away, so a highlight that was
    // already standing when the burst opened (S2 — see burstBaselineHtml()
    // above) can neither be baked into the baseline nor show up as an edit
    // when a later click strips it. A byte-identical normalised innerHTML
    // means the DOM genuinely never changed, so drop the burst here like the
    // `commitResult.op === null` no-op path below, without ever reaching
    // the serializer (and therefore without ever risking a canonicalizing
    // rewrite of untouched content).
    if (burstBaselineHtml(burst.editEl) === burst.original) {
      endBurstWithoutResolve();
      // §10-gap fix (review): untouched AND was pristine — an ordinary
      // "insert ＋, click away without typing" changed-my-mind. Auto-remove
      // the block instead of leaving its skeleton on disk.
      if (wasPristineForThisBlock) return await discardPristineInsert();
      return true;
    }
    burst.history.flushTyping();
    // Task 7 (Phase 4): li burst — serialize the whole list run through
    // serializeBlocks(), commit via commitRangeEdit() over the full run range.
    // Per-li degrade (spec §8): if OTHER lis in the run are unsupported,
    // commit only the edited li's own line range to avoid lossy round-trip
    // of their content (serializeBlocks strips unsupported inline elements from
    // `md`, so whole-run commit would silently delete their content).
    if (burst.blockType === 'li') {
      const editedLiEl = closestLiBlock(burst.editEl);
      const runEls = listRunOf(editedLiEl);
      if (!runEls.length) { endBurstWithoutResolve(); return true; }
      // T7 fix round 1 (HIGH-1): the §3.4 bystander replay belongs here too,
      // and this was the ONE list commit path that never got it — which made
      // "a line the user did not touch is never rewritten" false for the
      // commonest gesture of all, TYPING. The fully-supported branch below
      // commits `runMd` over the WHOLE run range, so every other item in the
      // run was re-serialized from the DOM on every keystroke burst:
      //
      //   before: '- alpha one··\n  alpha two ~t\n- bravo one··\n  bravo two ~u\n- charlie ~v\n'
      //   type one char into bravo, save
      //   after:  '- alpha one<br>alpha two \~t\n- bravo one<br>bravo two \~uZ\n- charlie \~v\n'
      //
      // — alpha's two source lines collapsed onto one bearing the literal
      // text '<br>' (the file lost a line) and charlie's '~v' was escaped,
      // in two items the user never opened.
      //
      // `mutatedEl` is the edited li: its DOM holds keystrokes `lines` has
      // not seen. bystanderCarryOver()'s dirty-burst exclusion already covers
      // it here (this is past the zero-edit guard, and `burst.blockId` IS this
      // li's id), so naming it is belt-and-braces — but it is the same fact
      // stated in the same place as the five structural call sites, which is
      // what stops the next reader having to re-derive it.
      //
      // The PARTIAL-run branch below is unaffected in OUTCOME, though not
      // untouched: a replayed bystander can emit a different number of lines
      // than a re-serialized one, so `first`/`last` shift. They index into
      // `runLines`, which is `runMd` from this very call, so the slice stays
      // self-consistent — and the bystanders' lines never reach `lines` on
      // that path anyway, because it commits only the edited block's own
      // source range.
      const carry = bystanderCarryOver(runEls, editedLiEl);
      const { md: runMd, unsupported, unsupportedByLi, lineMeta } =
        listMd.serializeBlocks(runEls, { carryOver: carry });
      // Refuse if the EDITED li itself has unsupported inline content.
      // RULING F-O: do NOT call openRawEditor() on a list block — injecting
      // a textarea into list structure corrupts list-md serialization and
      // renders badly. Show banner + teardown + rerenderAll (file is untouched,
      // burst never wrote to `lines`) + return false.
      const editedIdStr = String(burst.blockId);
      if (unsupportedByLi.some((u) => u.blockId === editedIdStr)) {
        showBanner('含不支援的格式，改用原始碼編輯', null, null);
        endBurstWithoutResolve();
        await safeRerenderAll();
        return false;
      }
      const range = runRangeOfBlocks({ lines, blocks, stack }, runEls);
      if (!range) { endBurstWithoutResolve(); return true; }
      let commitMd, commitStart, commitEnd;
      if (unsupported.length > 0) {
        // The run contains SOME unsupported content — commit only the edited
        // li's own line range so nothing else in the run is round-tripped
        // through the tight (blank-line-collapsed) runMd.
        //
        // F-W (silent data loss): the gate MUST key on `unsupported`
        // (the SUPERSET), not `unsupportedByLi`. `unsupportedByLi` collects
        // ONLY per-li inline-serializer names (e.g. VIDEO); `unsupported`
        // additionally gets 'P' pushed for every LOOSE list item plus stray
        // TEXT / foreign non-LI elements. A run containing a LOOSE li pushes
        // 'P' to `unsupported` ONLY — so keying on `unsupportedByLi` took the
        // whole-run tight commit and DELETED the loose blank line, silently
        // flattening the nested sublist. Keying on `unsupported` closes the
        // loose-'P', stray-TEXT and foreign-element cases in one shot.
        const editedBlock = blocks.find((b) => b.id === burst.blockId);
        if (!editedBlock) { endBurstWithoutResolve(); return true; }
        // F-W (the trap): the slice MUST be located among the run's emitted
        // LINES, NOT by the source-line delta
        // (editedBlock.startLine - range.startLine). runMd has no blank lines,
        // so a loose item present anywhere earlier in the run makes a later
        // supported li's SOURCE startLine overshoot runMd's line count — the
        // old delta slice then returned '' and commitRangeRemoval DELETED the
        // li's line.
        //
        // `lineMeta` is the serializer's own authoritative line -> blockId
        // mapping and is read instead of re-deriving anything from the DOM.
        // Two reasons position arithmetic cannot be used: a block the
        // serializer refuses emits NO line (controller note T2-C), and a
        // hard-wrapped block emits SEVERAL — so a block maps to the index
        // RANGE of the entries bearing its id, and the commit replaces that
        // whole range. Taking only the first line here is what overwrote a
        // later item's source with a continuation line. lineMeta's blockId is
        // the raw getAttribute() string, hence the String() comparison (same
        // convention as the unsupportedByLi gate above).
        const runLines = runMd.split('\n');
        let first = -1;
        let last = -1;
        lineMeta.forEach((m, k) => {
          if (m.blockId !== editedIdStr) return;
          if (first < 0) first = k;
          last = k;
        });
        if (first < 0) { endBurstWithoutResolve(); return true; }
        // Round 5/6: the edited block's source line may also carry the markers
        // of zero-line ancestors (same-line nesting, '- - b'). They emit their
        // own lines in runMd but are not attributed to this block, so slicing
        // by id alone dropped them and the child lost its parent. A plain
        // ancestor is re-emitted on a line of its own; a TASK ancestor has to
        // stay on the child's line or its checkbox degrades to literal text.
        // See sharedMarkerPrefixFor().
        commitMd = sharedMarkerLinesBefore(lineMeta, first, editedBlock)
          .concat(runLines.slice(first, last + 1)).join('\n');
        commitStart = editedBlock.startLine;
        commitEnd = editedBlock.endLine;
      } else {
        // Fully-supported run: commit the whole range at once.
        commitMd = runMd;
        commitStart = range.startLine;
        commitEnd = range.endLine;
      }
      const liCommitResult = (commitMd === '')
        ? commitRangeRemoval({ lines, blocks, stack }, commitStart, commitEnd)
        : commitRangeEdit({ lines, blocks, stack }, commitStart, commitEnd, commitMd);
      if (liCommitResult.op === null) {
        endBurstWithoutResolve();
        return true;
      }
      const liPrevLines = lines;
      lines = liCommitResult.lines;
      const liOk = await safeRerenderAll();
      if (!liOk) {
        lines = rollbackFailedRender({ lines, stack }, liCommitResult, liPrevLines);
        return false;
      }
      return true;
    }
    // Task 5: a table burst serializes through table-md.js's serializeTable()
    // (it takes the TABLE element, exactly what burst.editEl already is for a
    // 'table' burst). Every other block type (paragraph/heading) keeps using
    // inline-md.js's serializeInline() unchanged.
    // S1 removed the pre-per-li 'list' branch that lived here: blockmap has not
    // emitted type:'list' blocks since Phase 4, so no startBurst() call could
    // produce blockType === 'list' and the branch was already dead code.
    const result = burst.blockType === 'table' ? tableMd.serializeTable(burst.editEl)
      : inlineMd.serializeInline(burst.editEl);
    if (result.unsupported.length > 0) {
      // Degrade-never-lose (same contract as Phase 2's openWysiwygEditor()
      // commit()): our own paste handler only ever inserts plain text, but a
      // browser-native rich-paste/drag-drop could still land unsupported
      // markup mid-burst. Drop it, fall back to raw-edit prefilled with the
      // block's UNTOUCHED original source (this burst never wrote to
      // `lines`), and return false so the caller (switchAwayFrom(), on
      // behalf of whatever triggered this resolution) aborts instead of
      // proceeding as if the burst resolved cleanly.
      showBanner('含不支援的格式，改用原始碼編輯', null, null);
      endBurstWithoutResolve();
      openRawEditor(burst.blockEl);
      return false;
    }
    // Final-review Finding 5 (carried over): an emptied-out heading must not
    // commit '#'.repeat(depth) + ' ' with nothing after the space. Every
    // non-heading burst's `depth` is null (blockDepthOf() only computes it for
    // 'heading'), so it takes the plain result.md branch.
    const newText = burst.depth === null ? result.md :
      (result.md === '' ? '#'.repeat(burst.depth) : '#'.repeat(burst.depth) + ' ' + result.md);
    // S1 removed the pre-per-li "a whole-list burst that serialized to ''"
    // branch that lived here alongside the dead 'list' serializer arm above.
    // The per-li equivalent — a run whose every item was removed — is handled
    // by commitListStructure()'s own md === '' path.
    const commitResult = commitEdit({ lines, blocks, stack }, burst.blockId, newText);
    if (commitResult.op === null) {
      endBurstWithoutResolve();
      return true;
    }
    const prevLines = lines;
    lines = commitResult.lines;
    const ok = await safeRerenderAll();
    if (!ok) {
      lines = rollbackFailedRender({ lines, stack }, commitResult, prevLines);
      // Burst stays open: DOM/history untouched, banner already shown by
      // safeRerenderAll(). rerenderAll() never ran its belt-and-braces
      // `currentBurst = null` reset on this failure path (that reset only
      // fires on an actual successful swap), so `currentBurst` still points
      // at the same (still live, still armed) surface here.
      return false;
    }
    // Success: rerenderAll() already replaced the whole .content subtree
    // (this block included), re-armed it via armEditables(), and — belt and
    // braces, same idiom as activeEditor/resetSelToolbarState() elsewhere in
    // this file — unconditionally nulled `currentBurst` and disposed its
    // history. Nothing left to do here.
    return true;
  }

  // Live `.ed-block` element whose block STARTS at `startLine` in the current
  // (post-render) `blocks` array, or null. Every server render re-derives
  // block ids from the markdown, so a startLine captured BEFORE a commit is
  // the only stable way back to a specific block afterwards — the same lookup
  // focusBlockAtLine() below does, exposed separately for the structural ops
  // (Task 8's empty-li → paragraph conversion) that need the ELEMENT rather
  // than the caret.
  function blockElAtLine(startLine) {
    const target = blocks.find((b) => b.startLine === startLine);
    if (!target) return null;
    return document.querySelector('.ed-block[data-block-id="' + target.id + '"]');
  }

  // ── S3 Task 2: block multi-select state ────────────────────────────────
  // The selection's identity is a LINE RANGE, never ids and never nodes.
  // buildBlockMap renumbers every id from 0 on every render (blockmap.js's
  // `nextId = {v:0}`) and every batch operation triggers a full
  // rerenderAll(), so an id or an element held across a commit is a dangling
  // reference into a document that no longer exists — the same reasoning
  // blockElAtLine() above is written down for. All the range arithmetic and
  // §3.3's membership rules live in the pure, node-tested
  // lib/editor/selection.js (window.md2docSelection); this file only paints.
  let blockSelection = null; // { anchorLine, focusLine } | null

  // §4.4: the focus endpoint's block element. Null when the selection's focus
  // line is not (or is no longer) some block's startLine — the caller then
  // simply holds no focus rather than guessing at a neighbour.
  function selectionFocusBlockEl() {
    if (!blockSelection) return null;
    return blockElAtLine(blockSelection.focusLine);
  }

  // Repaints `.ed-selected` and the roving tabindex from `blockSelection`.
  // Idempotent and total: it clears both attributes off EVERY block first, so
  // it is equally the "apply" and the "clear" path and no stale tint can
  // survive a state change.
  function applySelectionClasses() {
    const members = blockSelection && selectionLib
      ? selectionLib.membersOf(blockSelection, blocks) : [];
    const ids = new Set(members.map((b) => String(b.id)));
    for (const el of allBlockEls()) {
      el.classList.toggle('ed-selected', ids.has(el.getAttribute('data-block-id')));
      el.removeAttribute('tabindex');
    }
    // §4.4 wants a REAL focus holder: with focus left on <body> the keydown
    // dispatch has nothing to anchor on and the browser's own Tab order walks
    // straight past the selection. A ROVING tabindex="-1" (exactly one block
    // focusable at a time, moved as the focus endpoint moves) is the standard
    // answer, and -1 rather than 0 keeps every block out of the sequential Tab
    // order — Tab inside the editor is already a structural key. There is no
    // other tabindex anywhere in lib/; this is greenfield.
    //
    // Focusing a .ed-block is inert for the burst machinery: the delegated
    // focusin handler bails unless the target closes onto .ed-wys-cell or
    // .ed-wys-armed, and the block WRAPPER is neither (armEditables() arms
    // blockContentEl(), a child).
    const focusEl = selectionFocusBlockEl();
    if (focusEl) { focusEl.setAttribute('tabindex', '-1'); focusEl.focus(); }
  }

  // S3 Task 4: the keyboard's anchor for §4.4 entry (c) once the set is gone.
  // MEASURED on 2026-08-30, contradicting Task 2 carry 7 / Task 3 carry 7:
  // removing the roving `tabindex` from the block that currently has DOM
  // focus BLURS it in Chromium (`document.activeElement` becomes <body>), so
  // applySelectionClasses()'s "clear both attributes off EVERY block first"
  // means a cleared selection leaves NO focused block behind. Without this
  // memory there is nothing for Shift+↑↓ to resume from after an Escape: the
  // caret's own surface owns those keys (they are the browser's
  // extend-the-text-selection gesture, and the burst short-circuit keeps them
  // that way), and <body> has no block to anchor on.
  let lastSelectionFocusLine = null;

  function setBlockSelection(sel) {
    if (sel && Number.isFinite(Number(sel.focusLine))) lastSelectionFocusLine = Number(sel.focusLine);
    blockSelection = sel;
    applySelectionClasses();
  }
  function clearBlockSelection() { blockSelection = null; applySelectionClasses(); }

  // ── S3 Task 5: surviving rerenderAll() (§4.4's ordered three steps) ────
  // `contentEl.innerHTML` is replaced wholesale on every commit, so the
  // painted tint and the roving focus holder are destroyed by definition —
  // MEASURED on this branch: with a selection over lines 3–4 standing, a
  // rerenderAll() leaves `blockSelection` intact (its identity is a line
  // range, which no render can invalidate) but the fresh server HTML carries
  // no `.ed-selected` and no `tabindex`, so `document.activeElement` is
  // `<body>` and the keyboard is dead while the model still says two blocks
  // are selected. The model and the paint drift apart, and every batch
  // operation in Tasks 6/7 ends in exactly this swap.
  //
  // NOTE for the plan's own wording: it says "without the rebuild the tint
  // survives (it is re-derived from lines) but focus falls back to <body>".
  // Only the second half is true. Nothing re-derives the tint — the swap
  // simply throws the classes away with the nodes that carried them.
  //
  // §4.4 also says each structural operation DECLARES the line range it
  // produced, and that a range which no longer resolves clears the selection
  // rather than leaving it dangling. `pendingSelectionRange` is that
  // declaration: `undefined` means "nothing declared, keep whatever is
  // standing" (a burst commit must not destroy a selection it never touched),
  // `null` means "clear" (undo/redo), and a `{startLine, endLine}` means
  // "collapse to this" (Tasks 6/7's batch operations).
  let pendingSelectionRange;
  function declareSelectionRange(range) { pendingSelectionRange = range; }

  // §4.4 step 3: the rebuilt set must have a REAL focus holder, not <body>.
  // A declared range's focus endpoint is a LINE, and after a render that line
  // is often the INSIDE of a block rather than its startLine — collapseTo()
  // hands back the range's endLine, and a table or a fence owns four lines
  // for one block. selectionFocusBlockEl() answers null for such a line
  // (Task 2 carry 5), i.e. a selection with no focus holder and a dead
  // keyboard, which is the whole failure this task exists to prevent. So the
  // focus endpoint is snapped onto the startLine of the member it lands in,
  // on the side it was already on so the gesture stays reversible.
  //
  // The snap is REFUSED if it would change the member set: Tasks 6/7 compute
  // the batch anchor from these members and that anchor writes bytes, so a
  // focus holder is not worth a silently different set. That branch is
  // defensive — snapping only ever shrinks the range towards the anchor, and
  // a member that would drop out would have to start after the block the
  // focus line lands in — but "buildBlockMap never emits that" is an argument
  // about another file's output, not an invariant this one can enforce.
  function selectionWithFocusHolder(sel, members) {
    if (blockElAtLine(sel.focusLine)) return sel;
    const snapTo = Number(sel.focusLine) < Number(sel.anchorLine)
      ? members[0] : members[members.length - 1];
    if (!snapTo) return sel;
    const candidate = { anchorLine: sel.anchorLine, focusLine: snapTo.startLine };
    const after = selectionLib.membersOf(candidate, blocks);
    if (after.length !== members.length) return sel;
    for (let i = 0; i < after.length; i++) if (after[i] !== members[i]) return sel;
    return blockElAtLine(candidate.focusLine) ? candidate : sel;
  }

  // §4.4 step 2, called from rerenderAll() AFTER its unconditional teardown
  // (so nothing below can null what this just set) and BEFORE the two
  // `try`-swallowed rebind blocks (so a diagram-init throw cannot skip it).
  // `armEditables()` still runs first, per its own comment.
  function rebuildBlockSelection(declaredRange) {
    // Nothing standing and nothing declared: the fresh DOM already carries no
    // tint and no tabindex, so there is nothing to repaint and no reason to
    // walk every block on a render that has no selection anywhere near it.
    if (declaredRange === undefined && !blockSelection) return;
    const sel = declaredRange === undefined
      ? blockSelection
      : (selectionLib ? selectionLib.collapseTo(declaredRange) : null);
    if (!sel || !selectionLib) { clearBlockSelection(); return; }
    const members = selectionLib.membersOf(sel, blocks);
    if (!members.length) { clearBlockSelection(); return; }
    setBlockSelection(selectionWithFocusHolder(sel, members));
  }

  // The block record behind a rendered `.ed-block`, or null. Every gesture
  // below turns an element (or a point) into a LINE this way — the line is
  // the selection's identity, the id is only how the DOM addresses it in
  // between two renders.
  function blockRecOf(blockEl) {
    if (!blockEl || !blockEl.getAttribute) return null;
    const raw = blockEl.getAttribute('data-block-id');
    if (raw === null) return null; // provisional block: no record yet
    return blocks.find((b) => b.id === Number(raw)) || null;
  }

  // Test-only hooks. Task 2 shipped the two WRITE hooks (no gesture created a
  // selection yet); Task 4 adds the READ one so a gesture scenario can assert
  // the resulting member set BY LINE RANGE rather than by counting tinted
  // nodes — a test that counts `.ed-selected` silently passes or fails on
  // Task 2's CSS instead of on the gesture under test. `memberLines` is the
  // model's own answer (selection.js against `blocks`); `domSelectedLines` is
  // the same question asked of the DOM, so a scenario can pin both and catch
  // the two drifting apart. They are the browser-side counterpart of the
  // node-side `module.exports` guard at the top of this file — the same
  // "expose the seam the tests need, in the one environment that has it"
  // split — and nothing in the product calls them.
  window.__edTestSetSelection = function (anchorLine, focusLine) {
    setBlockSelection({ anchorLine: anchorLine, focusLine: focusLine });
  };
  window.__edTestClearSelection = function () { clearBlockSelection(); };
  window.__edTestGetSelection = function () {
    if (!blockSelection) return null;
    const members = selectionLib ? selectionLib.membersOf(blockSelection, blocks) : [];
    return {
      anchorLine: blockSelection.anchorLine,
      focusLine: blockSelection.focusLine,
      memberLines: members.map((b) => [b.startLine, b.endLine]),
      domSelectedLines: allBlockEls()
        .filter((el) => el.classList.contains('ed-selected'))
        .map((el) => { const r = blockRecOf(el); return r ? [r.startLine, r.endLine] : null; }),
      focusHolderId: (function () {
        const el = selectionFocusBlockEl();
        return el ? el.getAttribute('data-block-id') : null;
      })(),
    };
  };
  // Task 5 seams. `__edTestForceRerender` runs the REAL rerenderAll() (not
  // safeRerenderAll(), so a scenario sees a throw rather than a banner) —
  // every batch operation in Tasks 6/7 ends in one, and this is how a
  // scenario exercises the swap without also exercising a batch operation
  // that does not exist yet. `__edTestTruncateTo` drops `lines` to its first
  // n, which is how a scenario reaches the "the selection's lines no longer
  // parse" state without an operation that deletes blocks.
  // Task 6 seam: the raw `blocks` records. A scenario needs them to prove the
  // shape of its OWN fixture — specifically that a no-line PHANTOM really does
  // sit BETWEEN two members, which is an INVERTED {startLine, endLine} at a
  // known index. Nothing in the DOM carries that fact: the phantom's element is
  // there, its (missing) line range is not, so a gap scenario that asserted the
  // gap from the DOM alone would be asserting something it merely believes.
  window.__edTestBlocks = function () {
    return blocks.map((b) => ({
      id: b.id, type: b.type, startLine: b.startLine, endLine: b.endLine,
    }));
  };
  window.__edTestForceRerender = function () { return rerenderAll(); };
  window.__edTestTruncateTo = function (n) { lines = lines.slice(0, n); };

  // ── S3 Task 4: the entry and exit GESTURES ─────────────────────────────
  // §4.4 entries: (a) press inside a block and drag across its boundary;
  // (b) Shift+Click; (c) Shift+↑↓. Exits: Escape (Task 3's keydown prologue)
  // and a click inside any block without Shift. Scrolling and window blur
  // deliberately do NOT clear — the drag they abort is torn down, the
  // selection it built stands.
  //
  // Everything below turns a POINT or an ELEMENT into a LINE and hands it to
  // selection.js; no gesture ever holds an id or a node across a repaint.

  // Chrome that owns its own press/click semantics. A gesture must never be
  // armed on one of these, or Shift+Clicking the ⠿ handle would build a
  // selection instead of opening the menu, and a drag inside the raw
  // textarea would fight its own text selection.
  const ED_SEL_GESTURE_CHROME = '.ed-handle, .ed-handle-menu, .ed-insert, .ed-insert-menu, ' +
    '.ed-te-menu, .ed-te-grip, .ed-tb-insert, .ed-seltb, .ed-conflict, .ed-raw';
  function isSelGestureChrome(target) {
    return !!(target && target.closest && target.closest(ED_SEL_GESTURE_CHROME));
  }

  // The line a gesture landing on `target` selects, or null when there is
  // none. Task 1 carry 3 / Task 2 carry 5: the focus endpoint must always be
  // the `startLine` of a block that OWNS a line — selectionFocusBlockEl()
  // returns null for anything else, which would leave a selection with no
  // focus holder and a dead keyboard. A phantom (the outer item of a
  // same-line nest, `endLine < startLine`) is therefore never the answer; its
  // own first line-owning descendant is, since that descendant is what the
  // user sees inside the phantom's box.
  function selectableLineOf(target) {
    let el = target && target.closest ? target.closest('.ed-block') : null;
    while (el) {
      const rec = blockRecOf(el);
      if (rec && rec.endLine >= rec.startLine) return rec.startLine;
      const inner = el.querySelector('.ed-block');
      const innerRec = inner ? blockRecOf(inner) : null;
      if (innerRec && innerRec.endLine >= innerRec.startLine) return innerRec.startLine;
      el = el.parentElement && el.parentElement.closest ? el.parentElement.closest('.ed-block') : null;
    }
    return null;
  }

  function selectableLineAtPoint(clientX, clientY) {
    // Coordinates, not `e.target`: once a drag is under pointer capture every
    // pointer event retargets to the capture element, so the target says
    // nothing about what is under the cursor. elementFromPoint always does.
    const el = document.elementFromPoint(clientX, clientY);
    if (!el || !contentEl.contains(el)) return null;
    return selectableLineOf(el);
  }

  function focusedSelectableLine() {
    const el = document.activeElement;
    return el && el.closest ? selectableLineOf(el) : null;
  }

  function clearNativeTextSelection() {
    const s = window.getSelection();
    if (s && typeof s.removeAllRanges === 'function') s.removeAllRanges();
  }

  // The in-flight press. `dragging` flips only once the pointer has crossed
  // into a DIFFERENT block — §4.4's entry threshold is that boundary, not a
  // pixel distance, so a press-and-wiggle inside one block stays ordinary
  // text selection.
  let blockSelDrag = null;
  // A gesture's own trailing `click`. A press in one block released in
  // another still fires one (on their common ancestor), and
  // wireBlockSelection()'s click handler would answer it with either
  // switchAwayFrom() (released outside any block) or the §4.4 exit rule
  // (released inside one) — the second of which would clear the very
  // selection the drag just built. Consumed exactly once, and re-armed to
  // false by the next pointerdown so a gesture whose click never arrives
  // (an abort, a release outside the window) cannot swallow a later one.
  let blockSelClickSuppressed = false;

  function armBlockSelDrag(e) {
    if (isSelGestureChrome(e.target)) return;
    const line = selectableLineOf(e.target);
    if (line === null) return;
    blockSelDrag = {
      pointerId: e.pointerId,
      originLine: line,
      // §4.4's table exception: a drag whose origin is a cell and which never
      // leaves that table keeps native text selection. Measured: a table is
      // exactly ONE .ed-block, so the block-boundary rule already says the
      // same thing — this is kept explicit because it is the spec's own
      // wording and because it stays correct if a cell ever comes to contain
      // blocks of its own.
      originTableEl: e.target.closest ? e.target.closest('table') : null,
      focusLine: line,
      dragging: false,
      captureEl: null,
    };
  }

  // Mirrors the table drag's capture skeleton (setPointerCapture at the top
  // of the te pointerdown, releaseTeCapture() on every exit): capture is what
  // keeps pointermove/up arriving once the cursor leaves the window. Taken at
  // ENGAGE time rather than at press time, so a press that turns out to be
  // plain text selection is never interfered with, and on documentElement
  // rather than the pressed node, which a mid-gesture commit can detach.
  function captureBlockSelDrag(e) {
    const el = document.documentElement;
    if (el && typeof el.setPointerCapture === 'function') {
      try { el.setPointerCapture(e.pointerId); blockSelDrag.captureEl = el; }
      catch (err) { /* not capturable here — the buttons/blur/cancel guards still apply */ }
    }
  }

  // Unconditional teardown of the in-flight press, called from pointerup,
  // pointercancel, the window blur listener, the next pointerdown, and the
  // "no buttons are down any more" guard in pointermove. The SELECTION is
  // never touched here: §4.4 says blur does not clear, and an aborted drag
  // must leave a complete set rather than a half-built one.
  function endBlockSelDrag() {
    if (!blockSelDrag) return;
    const st = blockSelDrag;
    blockSelDrag = null;
    if (st.captureEl && typeof st.captureEl.releasePointerCapture === 'function') {
      try { st.captureEl.releasePointerCapture(st.pointerId); } catch (err) { /* already released */ }
    }
    if (st.dragging) blockSelClickSuppressed = true;
  }

  function updateBlockSelDrag(e) {
    if (!blockSelDrag || e.pointerId !== blockSelDrag.pointerId) return;
    if (tePointer) return; // a grip gesture owns this pointer
    // The browser can simply never deliver a pointerup (released over browser
    // chrome, over another window). The next move with no button held is the
    // only signal left that the gesture is over.
    if (typeof e.buttons === 'number' && e.buttons === 0) { endBlockSelDrag(); return; }
    const overEl = document.elementFromPoint(e.clientX, e.clientY);
    if (!blockSelDrag.dragging) {
      if (blockSelDrag.originTableEl && overEl && blockSelDrag.originTableEl.contains(overEl)) return;
      const line = selectableLineAtPoint(e.clientX, e.clientY);
      if (line === null || line === blockSelDrag.originLine) return;
      blockSelDrag.dragging = true;
      blockSelDrag.focusLine = line;
      captureBlockSelDrag(e);
    } else {
      const line = selectableLineAtPoint(e.clientX, e.clientY);
      // Off every block (the page margin, an overlay): keep the last block the
      // drag actually reached rather than collapsing the set mid-gesture.
      if (line !== null) blockSelDrag.focusLine = line;
    }
    e.preventDefault();
    // The press started a native text selection that keeps extending with the
    // pointer; once the gesture is a BLOCK selection the two must not both be
    // painted. preventDefault() on pointermove does not stop it, so it is
    // dropped explicitly on every frame of the drag.
    clearNativeTextSelection();
    setBlockSelection({ anchorLine: blockSelDrag.originLine, focusLine: blockSelDrag.focusLine });
  }

  // §4.4 entry (b). The anchor is the standing selection's own anchor, or —
  // entering fresh — the block that holds the caret, so Shift+Click reads as
  // "from where I am to here". With neither, it collapses onto the clicked
  // block, which is extendTo()'s own answer for a null selection.
  function beginShiftClickSelection(e) {
    if (isSelGestureChrome(e.target)) return;
    const line = selectableLineOf(e.target);
    if (line === null) return;
    const seed = focusedSelectableLine();
    // Shift+Click INSIDE the block that already holds the caret is the one
    // Shift+Click that must stay native: it is how a user extends a text
    // selection to a point, and there is no second block to take.
    if (!blockSelection && seed !== null && seed === line) return;
    // Cancels the caret placement (and the focus move that would start a
    // burst on the clicked block) before it happens; the trailing click is
    // consumed by the flag.
    e.preventDefault();
    blockSelClickSuppressed = true;
    clearNativeTextSelection();
    const base = blockSelection || (seed === null ? null : { anchorLine: seed, focusLine: seed });
    setBlockSelection(selectionLib.extendTo(base, line));
  }

  // §4.4 entry (c) / its extension. Returns true when it owned the key.
  // stepFocus() skips blocks that own no source line, so every press MOVES —
  // Task 1 carry 3's "the first Shift+↓ does nothing, the second one moves".
  function stepSelectionFocus(dir) {
    if (!selectionLib) return false;
    if (blockSelection) {
      setBlockSelection(selectionLib.stepFocus(blockSelection, blocks, dir));
      return true;
    }
    // Entering fresh: the block that holds the roving focus, or — once a
    // clear has blurred it (see lastSelectionFocusLine) — the line the last
    // selection ended on, provided it still names a block that owns a line.
    let seed = focusedSelectableLine();
    if (seed === null && lastSelectionFocusLine !== null) {
      const rec = blocks.find((b) => b.startLine === lastSelectionFocusLine &&
        b.endLine >= b.startLine);
      if (rec) seed = rec.startLine;
    }
    if (seed === null) return false;
    setBlockSelection(selectionLib.stepFocus({ anchorLine: seed, focusLine: seed }, blocks, dir));
    return true;
  }

  // ── T7: surviving a commit that renumbers every block id ───────────────
  // A gutter gesture (⠿ delete, ＋ insert) resolves any open burst FIRST, and
  // that resolution can commit a DIFFERENT block's dirty editor, re-render,
  // and detach the element the gesture started from. Recovering by
  // `data-block-id` is not recovery at all: blockmap.js assigns ids 0..n-1 in
  // document order on EVERY render (`nextId = {v:0}`), so a commit that
  // changes the block COUNT shifts every later id and the captured id then
  // names the target's NEIGHBOUR. Measured: a fenced code block raw-edited
  // into two paragraphs changes the count WITHOUT changing the line count, so
  // '⠿ → 刪除' on the last paragraph deleted the one before it instead.
  //
  // Same defect class the S1 table fix closed (ensureTableBurstOpen()'s own
  // comment), and the same remedy: `startLine` is the stable handle, and the
  // block's own SOURCE LINES are the fingerprint proving the block sitting
  // there afterwards really is the same one. When the intervening commit moved
  // the target's own start line there is nothing left to resolve — the
  // fingerprint fails, the caller DROPS the gesture and says so. Never
  // guessed: completing every gesture is worth less than never acting on a
  // block the user did not point at.
  function blockSourceOf(block) {
    return lines.slice(block.startLine - 1, block.endLine).join('\n');
  }
  function captureBlockIdentity(blockEl) {
    if (!blockEl) return null;
    const raw = blockEl.getAttribute('data-block-id');
    if (raw === null) return null;
    const b = blocks.find((x) => x.id === Number(raw));
    if (!b) return null;
    return { startLine: b.startLine, type: b.type, source: blockSourceOf(b) };
  }
  function reresolveBlockEl(identity) {
    if (!identity) return null;
    const at = blocks.find((b) => b.startLine === identity.startLine);
    if (!at || at.type !== identity.type || blockSourceOf(at) !== identity.source) return null;
    return document.querySelector('.ed-block[data-block-id="' + at.id + '"]');
  }

  // What a caller says when it refuses to act rather than act on the wrong
  // block. Dismiss-only, same shape as refuseStructuralListEdit()'s banner —
  // the previous behaviour was to return silently, which reads to the user as
  // "the menu item is broken" and invites a second press.
  const DROPPED_GESTURE_MESSAGE = '文件已更新，請重試這個操作';

  // Finds the block whose startLine === `startLine` in the current `blocks`
  // array and focuses its WYSIWYG surface. `caretToEnd` = true places the
  // caret after the last character; false (default) places it at the start.
  // Best-effort: silently no-ops when the block or its surface cannot be
  // found (unarmed li, raw-edit block). Used by structural ops in Tasks 8-9
  // to restore focus after rerenderAll().
  function focusBlockAtLine(startLine, caretToEnd) {
    const target = blocks.find((b) => b.startLine === startLine);
    if (!target) return;
    const blockEl = document.querySelector('[data-block-id="' + target.id + '"]');
    if (!blockEl) return;
    const surface = blockContentEl(blockEl);
    if (!surface) return;
    surface.focus();
    try {
      const range = document.createRange();
      range.selectNodeContents(surface);
      range.collapse(!caretToEnd); // true = to start; false = to end
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {
      // best-effort caret placement — ignore on empty or non-text surfaces
    }
  }

  // ── Task 8 (Phase 4): structural commit for a per-li block run ──────────
  // Spec §3: a single list item cannot emit its own line (ordinals and ancestor
  // marker widths are tree-global), so the commit unit for ANY structural
  // change is the contiguous list RUN — re-serialize the whole run, replace
  // its line range once. That keeps every structural key at exactly ONE undo
  // op (a single contiguous range op on the existing UndoStack).
  //
  // RULING F-F: module scope, deliberately NOT nested inside the keydown
  // handler — Task 9's delegated checkbox-toggle click handler calls this too.
  //
  // The DOM mutation must already have happened when this is called; it reads
  // the live run back out through listMd.serializeBlocks(). `focusStartLine` is
  // the (post-commit) line the caret should end up on — see
  // runLineOfBlock() below for how a caller computes it — or null to leave
  // focus wherever the re-render puts it. Returns true on success, false when
  // the commit's own re-render failed (rolled back the same way every other
  // commit path in this file does: stack.undo() + restore `lines`).
  //
  // S1: `runEls` is the POST-mutation run span itself (listRunOf() on any block
  // still in the run), not a node to walk up from — the flat model has no list
  // container left to resolve. A caller whose mutation REMOVED the block the
  // key came from therefore computes the span from a surviving sibling, or
  // passes an empty array plus a `presetRange` when the run has no members
  // left; an empty span serializes to '' and takes the range-removal path
  // below, exactly as an emptied run did before.
  // Both "cannot locate the run" refusals below re-render before returning: the
  // caller's DOM mutation has ALREADY happened by the time this function runs,
  // so bailing out without a render would leave the screen showing a structural
  // change that never reached `lines`, with no burst left tracking it. Same
  // reasoning (and same remedy) as the `op === null` path further down.
  //
  // CALLER GATE CONTRACT: every caller MUST check
  // listRunSupportsStructuralEdit(root) and call refuseStructuralListEdit()
  // BEFORE mutating the DOM and calling this function. This function
  // re-serializes the WHOLE run — an unsupported li anywhere in it would have
  // its content silently deleted if the gate is skipped. The keydown handlers
  // (Tab, Enter) and the Task 9 checkbox click handler both enforce this.
  // Spec §3.4's bystander rule, resolved against the live file state: every
  // block in the commit span that the gesture did not itself touch, mapped to
  // the source lines it owns right now, so listMd.serializeBlocks() can replay
  // them instead of running them back through the (measurably lossy) inline
  // round trip. See its own carryOver comment for the measurement.
  //
  // ── T7: EVERY untouched block, keyed on its LINE RANGE ─────────────────
  // This used to name only the blocks the serializer reported in
  // `multiLineBlockIds`, and both halves of that were wrong.
  //
  //  * WRONG SET. `multiLineBlockIds` answers "does the surface text hold a
  //    '\n'", which is blind to a markdown HARD BREAK (two trailing spaces →
  //    <br>, no newline in the DOM). Such an item was never carried, so a Tab
  //    on a SIBLING re-serialised it: its two source lines collapsed onto one
  //    line bearing the literal text '<br>', and the file lost a line in an
  //    item nobody touched. list-md.js's detector has since been widened, but
  //    the truth about how many lines a block owns lives HERE — in `blocks` —
  //    not in a DOM heuristic, so that is what this reads.
  //  * WRONG QUESTION. Even a genuinely single-line bystander must not be
  //    re-serialised: escapeText() escapes a tilde marked never treats as
  //    markup, so an untouched '~5px' came back '\~5px'. Carrying EVERY
  //    untouched block makes "a line the user did not touch is never
  //    rewritten" a property of the commit, rather than a special case for
  //    hard-wrapped items. (Chosen over teaching inline-md.js not to escape a
  //    lone '~': that changes a global serialisation rule and every other
  //    caller with it, and it would still leave the next such character to
  //    find. Controller note T7-B picked the same half.)
  //
  // The probe serialisation this used to run for the id list is gone with it,
  // which also takes one of the four serializeBlocks() passes a single Tab
  // used to make off the hot path.
  //
  // Three exclusions, all about "whose bytes are authoritative":
  //
  //  * `mutatedEl` — the block the gesture REWROTE in the DOM before calling
  //    the commit (Enter's split cuts its text in two; the empty-item outdent
  //    clears its surface). Replaying its source would undo exactly that. A
  //    column-only caller (Tab, the checkbox toggle) names nothing here, on
  //    purpose: it changed an integer, not content, so its own target is a
  //    bystander of itself and must come back byte-identical too.
  //  * the block of an open burst whose surface has ACTUALLY been edited. Its
  //    DOM holds keystrokes `lines` has not seen, and replaying `lines` would
  //    silently throw them away. The dirty test is resolveBurst()'s own
  //    zero-edit guard, so both places agree on what "edited" means — and an
  //    UNEDITED burst is deliberately still replayed, because that is the
  //    common case for Tab (click into an item, press Tab) and re-serializing
  //    it would rewrite bytes the user only pressed an indent key on.
  //  * a block with no resolvable, non-inverted range — a provisional split
  //    item owns no source lines at all (no id yet), and a same-line nest's
  //    outer item has endLine === startLine - 1. Neither has bytes to replay,
  //    and slicing an inverted range would hand back the WRONG line. The
  //    predicate is blockOwnsNoLine() itself rather than a second hand-typed
  //    copy of `endLine < startLine`, so a change to that definition reaches
  //    here too.
  function bystanderCarryOver(span, mutatedEl) {
    const dirtyId = (currentBurst && currentBurst.editEl &&
      burstBaselineHtml(currentBurst.editEl) !== currentBurst.original)
      ? String(currentBurst.blockId) : null;
    const out = {};
    let any = false;
    (span || []).forEach((el) => {
      if (!el || el === mutatedEl) return;
      const raw = el.getAttribute('data-block-id');
      if (raw === null || raw === dirtyId) return;
      const rec = blocks.find((b) => b.id === Number(raw));
      if (!rec || blockOwnsNoLine(el)) return;
      out[raw] = lines.slice(rec.startLine - 1, rec.endLine);
      any = true;
    });
    return any ? out : null;
  }

  // `opts`: { presetRange, carryOver }. `carryOver` is the map
  // bystanderCarryOver() built — the CALLER builds it, once, right after its
  // own DOM mutation, and hands the SAME object to runLineOfBlock() as well:
  // the two must agree line-for-line (a replayed bystander can emit a
  // different number of lines than a re-serialized one would), and building it
  // twice also meant walking `blocks` twice per keystroke. Omitted (or null)
  // means "no bystander replay", which is only correct for a span whose blocks
  // all have their bytes in the DOM.
  async function commitListStructure(runEls, focusStartLine, caretToEnd, opts) {
    const span = runEls || [];
    const presetRange = opts && opts.presetRange;
    const { md } = listMd.serializeBlocks(span, { carryOver: (opts && opts.carryOver) || null });
    // The run's line range is read back off its own li blocks' ids — which
    // requires at least one li to still BE there. A caller whose mutation
    // removed the run's last item therefore captures the range BEFORE mutating
    // and passes it in; everyone else lets it be derived here.
    const range = presetRange || runRangeOfBlocks({ lines, blocks, stack }, span);
    if (!range) { endBurstWithoutResolve(); await safeRerenderAll(); return false; }
    const result = (md === '')
      // Every list block emits a non-empty marker line, so md === '' can only
      // mean the run has no items left — delete the range outright (absorbing
      // one adjacent blank separator) instead of committing a stray blank line.
      // Same contract commitListBlockRemoval() documents.
      ? commitRangeRemoval({ lines, blocks, stack }, range.startLine, range.endLine)
      : commitRangeEdit({ lines, blocks, stack }, range.startLine, range.endLine, md);
    // Structural ops bypass the burst's own resolve: the commit above already
    // wrote the run, so the focusout that follows this key must NOT re-commit
    // the (now stale) surface a second time.
    endBurstWithoutResolve();
    const prevLines = lines;
    // op === null means the mutated DOM re-serialized byte-identically (e.g. a
    // no-op reorder). `lines` is untouched, but the local DOM mutation is
    // still sitting there un-committed — re-render anyway so what's on screen
    // is always exactly what's in `lines`.
    if (result.op !== null) lines = result.lines;
    const ok = await safeRerenderAll();
    if (!ok) {
      lines = rollbackFailedRender({ lines, stack }, result, prevLines);
      // Deliberately NOT a second safeRerenderAll(), unlike the two refusals
      // above: this shape is different — a render WAS attempted and failed, so
      // rerenderAll() left `.content` untouched by contract and already showed
      // the "your edit was not applied" banner. Retrying immediately would only
      // stack an identical second banner. `lines` is authoritative and correct;
      // the screen keeps the local structural mutation until the next
      // successful render (any later commit, undo, or redo) re-derives the DOM
      // from `lines`. Same convention as insertBlockBelow() /
      // deleteBlockViaGutter() / resolveBurst()'s own failure paths.
      return false;
    }
    if (focusStartLine != null) focusBlockAtLine(focusStartLine, caretToEnd);
    return true;
  }

  // The line `targetBlock`'s own marker will occupy once the run span it belongs
  // to is committed by commitListStructure() above.
  //
  // Counted in EMITTED LINES, not in blocks: a block index is only the line
  // offset while every block emits exactly one line, and neither end of that
  // holds — a refused block emits none (controller note T2-C) and a
  // hard-wrapped one emits several. `lineMeta` is the serializer's own
  // line -> blockId mapping, so the answer is the index of the FIRST entry
  // bearing this block's id (its marker line; continuation entries follow).
  // Returns null when the run (or the block) cannot be located.
  function runLineOfBlock(runEls, targetBlock, carryOver) {
    const range = runRangeOfBlocks({ lines, blocks, stack }, runEls);
    if (!range || !targetBlock) return null;
    const targetId = targetBlock.getAttribute('data-block-id');
    // The SAME carryOver commitListStructure() will use — passed in by the
    // caller rather than rebuilt here, because a rebuild is only *usually* the
    // same answer and this index has to be exactly it: a replayed bystander
    // can emit a different number of lines than a re-serialized one would (a
    // blank continuation is dropped on the re-serialize path but replayed
    // verbatim here), and this answer is an index INTO those lines.
    const { lineMeta } = listMd.serializeBlocks(runEls, { carryOver: carryOver || null });
    // A provisional block (split's new item) has no id yet, so it cannot be
    // found by one — fall back to counting the lines emitted before it.
    if (targetId === null) {
      const at = runEls.indexOf(targetBlock);
      if (at < 0) return null;
      const before = runEls.slice(0, at).map((el) => el.getAttribute('data-block-id'));
      let n = 0;
      lineMeta.forEach((m) => { if (before.indexOf(m.blockId) !== -1) n++; });
      return range.startLine + n;
    }
    const idx = lineMeta.findIndex((m) => m.blockId === targetId);
    if (idx === -1) return null;
    return range.startLine + idx;
  }

  // Degrade-never-lose gate for structural keys: refuse the key outright when
  // ANY block in the run span is unsupported (loose <p>-wrapped item, foreign
  // child element, stray text directly inside the block, unsupported inline
  // markup). serializeBlocks() strips what it cannot represent from `md`, so
  // committing such a run deletes that content silently.
  //
  // RULING F-R — why the gate is RUN-WIDE, and why that does not contradict
  // spec §8's per-li narrowing. §8 governs which li you may TYPE in: a text
  // edit can be confined to the edited li's OWN line range (Task 7's partial-run
  // path in resolveBurst() above), leaving every other li's source bytes
  // untouched, so one unsupported li only degrades itself. That narrowing is
  // impossible for a STRUCTURAL op: per spec §3 the commit unit IS the
  // contiguous run, because an indent / outdent / split rewrites OTHER lines'
  // indent prefixes and ordinals — so the whole run must be re-serialized, and
  // that re-serialization is exactly what emits garbage for an unsupported li
  // anywhere in it. Refusing run-wide is therefore the only non-corrupting
  // answer, not an over-broad one.
  //
  // Called BEFORE any mutation, so a refusal costs nothing to undo.
  //
  // ── Task 6: MULTILINE is a TARGET-ONLY refusal ─────────────────────────
  // Everything above stays true for content the serializer cannot represent.
  // A hard-wrapped item is a different animal: it is ordinary, valid markdown
  // that the serializer represents perfectly well — it just owns several lines
  // instead of one. Feeding it into the run-wide rule was measured, on this
  // repo's own CHANGELOG.md, to refuse Tab on 100% of list items (80.6% of that
  // file's 72 items are hard-wrapped, so effectively every run holds one). S1's
  // headline gesture was therefore dead on any real document.
  //
  // Spec §4.1 splits the roles instead: hard-wrapped refuses as the operation
  // TARGET (its own line range is what a split / convert / delete would have to
  // rewrite, and no caller here knows how), and as a BYSTANDER it is carried
  // through untouched — see commitListStructure()'s carryOver below, which
  // replays its source bytes rather than re-serializing it.
  //
  // `targetEl` is the block the gesture acts on. It is NOT optional in spirit:
  // omitting it falls back to the old run-wide answer, which is the safe
  // direction but also the useless one, so every call site names its target.
  //
  // ── DEVIATION from spec §4.1, with the measurement that forced it ──────
  // §4.1 lists Tab among the operations a hard-wrapped item refuses AS THE
  // TARGET. Implemented literally, that does not deliver the acceptance
  // condition this task was given ("Tab must work on CHANGELOG.md"), and the
  // reason is arithmetic rather than opinion: measured on this repo's
  // CHANGELOG.md at v2.10.2, 58 of 72 list items are hard-wrapped and NOT ONE
  // of the 14 single-line items shares a run with one. Target-only refusal
  // therefore moves the number of items that accept Tab from 14/72 to 14/72 —
  // it changes nothing at all on that document, because there the
  // hard-wrapped item is never the bystander, it is the item you want to
  // indent.
  //
  // What the rest of §4.1's list has in common is that it REWRITES the item's
  // content or its line count: a split cuts the text in two, a conversion
  // re-authors it as a fence or a paragraph, a delete removes its lines, a
  // duplicate re-emits them. None of those has a defined answer for an item
  // whose content spans several source lines, which is what the refusal is
  // protecting.
  //
  // Tab and Shift+Tab are not in that family. They change one integer and
  // nothing else, and the resulting byte change is EXACTLY §3.4's colDelta —
  // "對其 [startLine, endLine] 每一行套用同一欄位差", the same mechanism the
  // spec already defines for a bystander, pointed at the target instead. So
  // `opts.columnOnly` lets the indent keys through, and every other structural
  // caller keeps §4.1's refusal untouched.
  //
  // `columnOnly` is a CRITERION, not the name of two keys (T7, and §4.1 has
  // been amended to match so the next such operation needs no fresh ruling):
  // an operation is column-only when it changes no content, no line count, and
  // nothing but leading columns or the characters inside a marker. The GFM
  // checkbox toggle qualifies on exactly the same arithmetic as Tab — '[ ] '
  // and '[x] ' are the same width, so its colDelta is 0 — and it was the
  // second caller to need it. Anything that rewrites the item's TEXT or its
  // LINE COUNT (split, convert, delete, duplicate) is not column-only and must
  // keep refusing a multi-line target.
  //
  // The one thing that must not happen is replaying stale bytes over live
  // keystrokes; bystanderCarryOver() below is what draws that line, by
  // excluding a burst whose surface has actually been edited.
  function listRunSupportsStructuralEdit(runEls, targetEl, opts) {
    if (!runEls || !runEls.length) return false;
    const res = listMd.serializeBlocks(runEls);
    const multi = res.multiLineBlockIds || [];
    // Anything OTHER than MULTILINE still refuses run-wide, unchanged.
    for (let i = 0; i < res.unsupported.length; i++) {
      if (res.unsupported[i] !== 'MULTILINE') return false;
    }
    if (opts && opts.columnOnly) return true;
    // S3 Task 6: `targetEl` may be an ARRAY — a batch operation has N targets in
    // one run and every one of them has to clear §4.1's multi-line gate, not
    // just the one the ⠿ was pressed on. An empty array is the same question as
    // no target at all (nobody is being rewritten).
    const targetEls = targetEl === null || targetEl === undefined
      ? [] : (Array.isArray(targetEl) ? targetEl : [targetEl]);
    if (!targetEls.length) return multi.length === 0;
    // T7: the AUTHORITATIVE multi-line test, and it is not `multi`.
    // `multiLineBlockIds` reports a '\n' in the item's surface text, which
    // sees a LAZY continuation and is blind to a markdown HARD BREAK (two
    // trailing spaces -> <br>, no newline in the DOM). Enter on such an item
    // was therefore accepted, and re-serialised its two source lines into one
    // line bearing the literal text '<br>' — precisely the rewrite §4.1's
    // refusal exists to prevent. How many lines a block owns is a fact about
    // the FILE, so it is read off `blocks` here rather than guessed from the
    // DOM in list-md.js (which was tried: '<br>' also matches the placeholder
    // Chromium leaves when the last character is deleted, and an emptied item
    // must stay removable). `multi` is kept as well — it costs nothing and
    // covers any surface newline that is not a line-range fact.
    for (let t = 0; t < targetEls.length; t++) {
      const targetRaw = targetEls[t].getAttribute('data-block-id');
      const targetRec = blocks.find((b) => b.id === Number(targetRaw));
      if (targetRec && targetRec.endLine > targetRec.startLine) return false;
      // getAttribute() strings on both sides — the same convention
      // unsupportedByLi[].blockId uses.
      if (multi.indexOf(targetRaw) !== -1) return false;
    }
    return true;
  }

  // Esc inside a burst: revert to snapshot 0 (the pre-focus baseline) and
  // end the burst WITHOUT committing — replaces the old per-session Esc
  // cancel. Clears `currentBurst` BEFORE calling blur() so the delegated
  // focusout handler (which fires synchronously from blur()) finds nothing
  // left to resolve and no-ops, instead of re-entering resolveBurst().
  async function revertBurstAndEnd(editEl) {
    const burst = currentBurst;
    if (!burst || burst.editEl !== editEl) return;
    // §10-gap fix (review): Escape ALWAYS reverts to `burst.original` — for
    // a pristine block that's exactly its still-untouched skeleton, so
    // this unconditionally qualifies as "abandoned" (no separate
    // unchanged-check needed here, unlike resolveBurst()'s branch, where a
    // real commit is also possible).
    const wasPristineForThisBlock = !!(pristineInsert && pristineInsert.blockId === burst.blockId);
    if (wasPristineForThisBlock) pristineInsert = null;
    burst.history.dispose();
    editEl.innerHTML = burst.original;
    currentBurst = null;
    resetSelToolbarState();
    if (wasPristineForThisBlock) {
      await discardPristineInsert(); // rerenderAll() already detaches editEl — nothing left to blur()
      return;
    }
    editEl.blur();
  }

  // Ctrl+Z inside a burst: step the burst-local history first; only once
  // it's exhausted (atBottom — the surface is already back to its pre-focus
  // baseline) does this cascade OUT to the document-level undo() stack,
  // after committing the (by definition unchanged, so a no-op) burst first
  // — see switchAwayFrom()/resolveBurst() above. Fire-and-forget: the
  // keydown handler already called preventDefault() synchronously.
  function burstUndo(editEl) {
    const burst = currentBurst;
    if (!burst || burst.editEl !== editEl) return;
    const state = burst.history.undo();
    if (state !== null) {
      editEl.innerHTML = state;
      placeCaretAtEnd(editEl); // best-effort — see the file-level caret-quirk note
      return;
    }
    // §10-gap fix (review): if this burst is an untouched pristine insert,
    // switchAwayFrom() below will itself auto-remove the block (resolveBurst()'s
    // pristineInsert branch) — that auto-remove IS the undo the user just
    // asked for (Ctrl+Z on a block with nothing else to step back through
    // locally). Chaining a SECOND undo() after it would incorrectly cascade
    // to whatever op preceded the insert instead. Computed HERE,
    // synchronously, off the same `burst` object switchAwayFrom() is about
    // to resolve — nothing can change either condition between this check
    // and that resolution running.
    const willAutoRemove = !!(pristineInsert && pristineInsert.blockId === burst.blockId &&
      burstBaselineHtml(burst.editEl) === burst.original);
    switchAwayFrom().then((ok) => { if (ok && !willAutoRemove) undo(); });
  }

  // Ctrl+Y / Ctrl+Shift+Z inside a burst: symmetric to burstUndo() above.
  function burstRedo(editEl) {
    const burst = currentBurst;
    if (!burst || burst.editEl !== editEl) return;
    const state = burst.history.redo();
    if (state !== null) {
      editEl.innerHTML = state;
      placeCaretAtEnd(editEl);
      return;
    }
    switchAwayFrom().then((ok) => { if (ok) redo(); });
  }

  // Records a programmatic (non-typing) mutation of `root` — a toolbar mark
  // toggle, a Shift+Enter <br> insertion, a paste — as its own burst-history
  // snapshot, per the brief ("Programmatic mutations ... call snap() after
  // applying"). A no-op when `root` isn't part of the currently-focused
  // burst's edit surface.
  //
  // Final-review Finding 3 (Important): a plain `editEl === root` equality
  // check misses every Task 5 table-cell caller. A table burst's
  // `currentBurst.editEl` is the WHOLE <table> (see startTableBurst() above
  // — one burst spans every cell), but the selection toolbar's mark-toggle
  // callers (applyMarkToggle()/applyLinkToggle() below) and the table-cell
  // paste handler all pass `root = selToolbarEditEl`/`cellEl.closest('table')`
  // — for a mark toggle specifically that's the individual CELL
  // (startTableBurst()/handleTableCellFocusIn() set `selToolbarEditEl =
  // cellEl`, never the table), which never strictly equals `editEl` even
  // though it's the burst's own content. `.contains()` catches that case
  // (and is a no-op broadening everywhere else: for paragraph/heading/list,
  // `root` IS `editEl`, so the first branch already matched and the
  // `.contains()` call never even runs). Without this, a bold/italic/link/
  // paste toggle inside a table cell silently skipped its own burst-history
  // snapshot — Ctrl+Z after it would step PAST the mark (or straight to
  // cascading out of the burst) instead of reverting just that toggle.
  function snapBurstIfActive(root, reason) {
    if (currentBurst && (currentBurst.editEl === root || currentBurst.editEl.contains(root))) {
      currentBurst.history.snap(reason);
    }
  }

  // The delegated keydown handler's per-keystroke logic for a focused
  // `.ed-wys-armed` surface — Enter commits (via blur(), which the
  // delegated focusout handler turns into a resolveBurst() call — see
  // wireBurstListeners() below), Shift+Enter inserts a <br> and snapshots
  // it, Escape reverts, Ctrl+Z/Y drive the burst-local history.
  function handleBurstKeydown(e, editEl) {
    if (!currentBurst || currentBurst.editEl !== editEl) {
      // v2.11.1 acceptance, escape class B. This bail is reachable with the
      // surface STILL FOCUSED and still `.ed-wys-armed`: resolveBurst() nulls
      // `currentBurst` without blurring (Ctrl+S is the everyday way in), and
      // the delegated handler's call site below `return`s unconditionally, so
      // nothing else in the document handler runs either. For every other key
      // that is the right answer — the surface is a plain contenteditable and
      // the browser's default IS the behaviour we want. Tab is the one key
      // whose default is not "insert something" but "walk the caret out of the
      // document": measured on 2.11.0 it moved focus to that same item's own ＋
      // button (Shift+Tab, to the previous block's ⠿). Spec §3.5 names this
      // outright — 必須 preventDefault()，否則 Tab 在 body 上是瀏覽器焦點巡覽.
      // Swallowed, not acted on: there is no burst to act within, and an
      // indent from a resolved burst would be a structural edit the user did
      // not ask for.
      if (e.key === 'Tab') e.preventDefault();
      return;
    }
    // Task 8 (Phase 4): per-li burst — Enter / Shift+Enter / Tab / Shift+Tab
    // are owned by handleLiKeydown() below (spec §4's key semantics for li
    // surfaces, acceptance rows 1, 3, 5, 6, 7, 8). Every other key (Escape,
    // Ctrl+Z, Ctrl+Y) falls through to the shared branches below and behaves
    // exactly as it does for a paragraph.
    if (currentBurst.blockType === 'li') {
      if (handleLiKeydown(e, editEl)) return;
    }
    // Task 6 — spec §3.5's other two rows. Tab is CONSUMED here: the
    // alternative is not "nothing happens", it is the browser's own focus
    // traversal walking the caret out of the document body, which is both a
    // surprise and (because it fires focusout) an unasked-for commit.
    //
    //   heading   — one level down / up, clamped to H1..H6 by
    //               changeHeadingDepth(), which is the same source-level
    //               transform the ⠿ menu's ± buttons already use.
    //   paragraph — a true no-op. Not "unhandled": preventDefault() and
    //               return, so the block is byte-identical afterwards.
    //
    // T7 correction: that is the WHOLE list, not a sample of it. This branch
    // runs only for a block with an open burst, and armEditables() opens one
    // for exactly four block types — paragraph, heading, li, table. `li` has
    // already returned above (handleLiKeydown()), and a table cell never
    // reaches here at all (it runs through handleTableCellKeydown(), whose Tab
    // keeps its cell-navigation contract). Blockquote and fenced code are
    // never armed — they are degraded blocks whose click opens the raw
    // textarea — so no "consumed no-op" branch has ever executed for them,
    // whatever the commit message that introduced this said.
    if (e.key === 'Tab') {
      e.preventDefault();
      if (currentBurst.blockType === 'heading') {
        changeHeadingDepth(currentBurst.blockEl, e.shiftKey ? -1 : 1);
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        insertBrAtCaret();
        snapBurstIfActive(editEl, 'br');
      } else {
        editEl.blur();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      revertBurstAndEnd(editEl);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
      e.preventDefault();
      burstUndo(editEl);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
      e.preventDefault();
      burstRedo(editEl);
      return;
    }
  }

  // ── Task 4 (Phase 3): list item structural editing ─────────────────────
  // Enter = split into a new sibling item at the caret; Shift+Enter = <br>
  // (same as paragraph/heading); Tab = indent (child of previous sibling,
  // no-op with none); Shift+Tab = outdent (moves after the parent item,
  // no-op at top level); Enter on an EMPTY item removes it AND ends the
  // burst (commits) — every other empty-item-preserving Enter/Tab/Shift+Tab
  // is a purely local DOM mutation that keeps the burst open (multiple
  // splits/indents can happen in one sustained editing session), followed
  // by history.snap() per the Global Constraint ("every structural mutation
  // -> history snap").

  // S1: the caret's own li block, or null. closestLiBlock() replaces the old
  // "nearest ancestor <li>, never crossing root" walk — a flat block has no
  // list ancestor to cross, and the block boundary is the natural stop.
  function caretLiBlock() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    return closestLiBlock(sel.getRangeAt(0).startContainer);
  }

  // Task 4 fix (review, Critical): a NON-collapsed selection whose two
  // boundary points resolve to DIFFERENT list blocks (or either resolves
  // to none) has no defined split semantics under the brief's caret-based
  // Enter contract — splitListItemAtCaret()'s Range extractContents() was
  // anchored only to the START container's own item, so a cross-item
  // selection silently deleted whatever the selection covered in the OTHER
  // item(s) before the (wrong) split ran. True only for a genuinely
  // cross-item selection; a same-item multi-character selection is still a
  // normal (delete-then-split) Enter, handled by splitListItemAtCaret()
  // itself.
  function selectionSpansMultipleListItems() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return false;
    const startLi = closestLiBlock(range.startContainer);
    const endLi = closestLiBlock(range.endContainer);
    return !startLi || !endLi || startLi !== endLi;
  }

  // S1 replacement for directNestedListOf(): "does this item own children?" is
  // now "is the NEXT block an li at a strictly greater indent?". A block's
  // children are, by construction of the flat renderer's DFS walk, the
  // contiguous run of deeper blocks immediately following it.
  // RULING F-Q's guard reads this.
  function liBlockHasChildren(blockEl) {
    const self = liAttrs(blockEl);
    if (!self) return false;
    const all = allBlockEls();
    const i = all.indexOf(blockEl);
    if (i < 0) return false;
    const next = liAttrs(all[i + 1]);
    return !!next && next.indent > self.indent;
  }

  // Task 8: the per-li edit surface (`<div class="ed-li-text">`, see
  // lib/md2doc.js's renderEditModeList) that holds this block's own inline
  // content, or null. S1 removed the pre-per-li "fall back to the <li> itself"
  // shape: a flat li block ALWAYS has exactly one .ed-li-text child (the
  // renderer emits it unconditionally, and splitListItemAtCaret() below
  // reproduces it), so a null here means the element is not a list block at
  // all — which callers must not paper over.
  function liTextEl(blockEl) {
    for (let i = 0; i < blockEl.childNodes.length; i++) {
      const c = blockEl.childNodes[i];
      if (c.nodeType === 1 && c.nodeName === 'DIV' &&
          c.classList && c.classList.contains('ed-li-text')) return c;
    }
    return null;
  }

  // Task 8: the non-editable checkbox chrome (spec §6) of `blockEl`, if any.
  function liCheckEl(blockEl) {
    for (let i = 0; i < blockEl.childNodes.length; i++) {
      const c = blockEl.childNodes[i];
      if (c.nodeType === 1 && c.nodeName === 'SPAN' &&
          c.classList && c.classList.contains('ed-li-check')) return c;
    }
    return null;
  }

  // Task 8 / RULING F-Q: "empty" for the PER-LI Enter contract (spec §11 row 3)
  // means the item's OWN text is blank. Owning children does NOT disqualify it:
  // row 3's press OUTDENTS the item and the subtree travels with it, so there
  // is nothing to orphan. Spec §4 / §11 row 3 state the outdent with no
  // carve-out, so gating row 3 on "has no children" silently sent an empty item
  // that owned a sublist to the row-1 SPLIT instead (two empty items, the
  // subtree re-parented under the second).
  //
  // "Own text" is the `.ed-li-text` surface's text, which in the flat model is
  // the item's own content by construction — descendants are separate blocks,
  // not descendants of this element. NBSP is normalised to a space so a surface
  // holding only a non-breaking space still counts as blank, and a bare
  // placeholder <br> counts too (its textContent is '').
  function liOwnTextIsBlank(blockEl) {
    const textEl = liTextEl(blockEl);
    if (!textEl) return false;
    return textEl.textContent.replace(/\u00a0/g, ' ').trim() === '';
  }

  // Task 8 / RULING F-U: true when `el` holds nothing any serializer would emit
  // — only whitespace text (NBSP included, matching liOwnTextIsBlank()'s own
  // normalisation) and placeholder <br>s. Deliberately stricter than
  // "textContent === ''", which the pre-F-U clear used: a void ELEMENT (an <img>
  // or <video>) also has empty textContent, and clearing innerHTML on it is data
  // loss. Such void elements are unsupported by the inline serializer, so they
  // make their li unsupported and the run-wide gate refuses structural keys before
  // this is ever reached for them. However, the predicate is intentionally
  // non-recursive: it returns false for ANY non-BR element, including supported
  // inline wrappers like <div> (which Chromium can leave as an empty-line
  // construct). The run-wide gate does NOT refuse structural keys for runs where
  // all lis are supported, so this conservative stance — treat any non-BR element
  // as "holds something" — is the correct safety net here. In practice Chromium
  // collapses empty-wrapper shapes (e.g. <div><br></div>) to a bare <br> after
  // full-content deletion, which the predicate already handles correctly.
  function liSurfaceHoldsNothing(el) {
    for (let i = 0; i < el.childNodes.length; i++) {
      const c = el.childNodes[i];
      if (c.nodeType === 1 && c.nodeName !== 'BR') return false;
      if (c.nodeType === 3 && c.textContent.replace(/\u00a0/g, ' ').trim() !== '') return false;
    }
    return true;
  }

  // Splits `blockEl` into two sibling BLOCKS at the caret via Range surgery —
  // the same extractContents()-based pattern wrapRangeIn() above already uses,
  // so inline formatting (a caret mid-<strong>, say) splits cleanly instead of
  // being torn.
  //
  // The caret lives inside the block's own `<div class="ed-li-text">` surface,
  // so the tail range runs to the END OF THAT DIV and the new block gets a
  // .ed-li-text div of its own to hold it. The provisional block deliberately
  // carries NO data-block-id: list-md.js reads it only for per-li unsupported
  // ATTRIBUTION, and the very next commitListStructure() + re-render replaces
  // this element with a real, server-numbered block anyway. It DOES carry
  // data-block-type / data-list-type / data-task / data-indent, all of which
  // serializeBlocks() reads to emit the line, plus a `.ed-li-marker` and (for a
  // task item) an unchecked `.ed-li-check`, so splitting a task item yields
  // another task item rather than silently converting the tail half to a plain
  // bullet.
  //
  // S1: the subtree needs no handling at all. A block's children are the
  // contiguous deeper blocks that FOLLOW it, and the new block is inserted
  // directly after the old one — so the subtree lands under the NEW item for
  // free, which is the same "whichever half it follows in DOM order" rule the
  // nested version had and what the spec's Enter contract requires.
  //
  // Returns the new block element, or null when the caret is not inside
  // `blockEl`'s own surface (nothing mutated).
  function splitListItemAtCaret(blockEl) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const textEl = liTextEl(blockEl);
    if (!textEl) return null;
    const range = sel.getRangeAt(0).cloneRange();
    // Containment is checked BEFORE deleteContents() so the refusal below is a
    // true no-op rather than "the selection was deleted, then we gave up".
    if (range.startContainer !== textEl && !textEl.contains(range.startContainer)) return null;
    if (!range.collapsed) range.deleteContents(); // collapses to the start point
    const tailRange = document.createRange();
    tailRange.setStart(range.startContainer, range.startOffset);
    tailRange.setEnd(textEl, textEl.childNodes.length);
    const tailFrag = tailRange.extractContents();

    const newBlock = document.createElement('div');
    newBlock.className = 'ed-block';
    newBlock.setAttribute('data-block-type', 'li');
    newBlock.setAttribute('data-list-type', blockEl.getAttribute('data-list-type') || 'ul');
    newBlock.setAttribute('data-task', blockEl.getAttribute('data-task') === '1' ? '1' : '0');
    setBlockIndent(newBlock, Number(blockEl.getAttribute('data-indent')) || 0);
    const marker = document.createElement('span');
    marker.className = 'ed-li-marker';
    marker.setAttribute('aria-hidden', 'true');
    newBlock.appendChild(marker);
    const check = liCheckEl(blockEl);
    if (check) {
      const newCheck = check.cloneNode(false);
      newCheck.setAttribute('data-checked', '0');
      newCheck.setAttribute('aria-checked', 'false');
      newBlock.appendChild(newCheck);
    }
    const newText = document.createElement('div');
    newText.className = 'ed-li-text';
    newText.appendChild(tailFrag);
    newBlock.appendChild(newText);
    blockEl.parentNode.insertBefore(newBlock, blockEl.nextSibling);
    return newBlock;
  }

  // S1: removing an item is removing its element. There is no list container
  // left to clean up when it empties — the run simply has one member fewer.
  // Callers must have established that the block owns no children (see
  // liBlockHasChildren()); the flat model would otherwise leave orphans behind
  // at a deeper indent than anything above them.
  function removeListItem(blockEl) {
    blockEl.parentNode.removeChild(blockEl);
  }

  // The contiguous run of blocks immediately after `blockEl` whose indent is
  // strictly greater than `indent` — i.e. that item's subtree in the flat
  // model. Used by the outdent below, which moves the subtree with its owner.
  function subtreeBlocksAfter(blockEl, indent) {
    const all = allBlockEls();
    const i = all.indexOf(blockEl);
    const out = [];
    if (i < 0) return out;
    for (let k = i + 1; k < all.length; k++) {
      const a = liAttrs(all[k]);
      if (!a || a.indent <= indent) break;
      out.push(all[k]);
    }
    return out;
  }

  // Tab (spec §3.5, 清單項 row): the item's indent goes up by one, clamped by
  // spec §3.4 rule 1 — "the previous block's indent + 1", with an upper bound of
  // 0 when the previous block is not a list item. Returns true iff something
  // actually moved, so the caller only commits on a real change.
  //
  // ── Task 6: THE SUBTREE NO LONGER FOLLOWS ──────────────────────────────
  // Up to v2.10.2 an indent dragged the item's whole subtree with it. That was
  // never a decision, it was an artifact: pre-S1 Tab re-parented the <li> and
  // the nested <ul> travelled inside it, and the flat rewrite reproduced the
  // observable behaviour rather than changing two things at once.
  //
  // Spec §3.5 says the opposite, and the user chose it explicitly after seeing
  // both behaviours side by side: the children keep their own indent and
  // therefore become the operated item's SIBLINGS. So '- a / - b / (2sp)- b1'
  // + Tab on b now gives '- a / (2sp)- b / (2sp)- b1', not
  // '- a / (2sp)- b / (4sp)- b1'. The row-5 scenario in
  // test/editor-client-runtime.test.js pinned the old expectation and was
  // migrated with this change.
  //
  // Nothing replaces the subtree walk: leaving the children alone IS the new
  // rule, and §3.4's clamp confirms it is legal (a child at old+1 sits under a
  // parent that is now also at old+1, whose bound is old+2).
  //
  // S1: this is integer arithmetic on data-indent, not re-parenting. It
  // reproduces the pre-S1 semantics exactly — there, an item with no previous
  // <li> SIBLING could not indent, and in the flat model an item whose previous
  // BLOCK is shallower-or-equal gets the same answer via the clamp (a deeper
  // previous block belongs to the previous sibling's subtree and only raises
  // the bound, which the +1 never reaches).
  //
  // RULING F-T is now structural rather than defensive: the moved item keeps
  // its own data-list-type, so it can no longer be silently re-markered by
  // being appended into a sublist of the other type.
  function indentListItem(blockEl) {
    const self = liAttrs(blockEl);
    if (!self) return false;
    // Rule (d): the first item of a LIST has nothing above it to nest under.
    // Without this the §3.4 clamp would happily read the previous list's last
    // item as "the previous block" and indent this one underneath it, merging
    // two lists the user never asked to join. Pre-S1 this fell out of
    // `previousElementSibling` being null inside the item's own <ul>.
    if (self.listStart) return false;
    const all = allBlockEls();
    const i = all.indexOf(blockEl);
    if (i < 0) return false;
    const prev = liAttrs(all[i - 1]);
    const max = prev ? prev.indent + 1 : 0;
    const next = Math.min(self.indent + 1, max);
    if (next === self.indent) return false;
    setBlockIndent(blockEl, next);
    return true;
  }

  // Shift+Tab (spec §11 row 6 / §3.5, user-verified against Notion): the item
  // rises one level, its OWN subtree rises with it, and its former FOLLOWING
  // same-level siblings keep their indent — which is exactly what makes them
  // its children afterwards. Top level (indent 0) -> no-op (row 8).
  //
  // S1: the three clauses of §3.5 collapse into two integer writes. Clause 2
  // (the "adoption" the pre-S1 version implemented by physically re-parenting
  // every follower into a freshly-created sublist of the matching type) is now
  // free: leaving the followers' indent alone IS the adoption, and because they
  // keep their own data-list-type they can no longer come back re-markered as
  // '1.' — the third silent failure mode the nested implementation had to
  // hand-guard against. Clause 3 is the same subtree walk indentListItem()
  // above uses, with delta -1.
  function outdentListItem(blockEl) {
    const self = liAttrs(blockEl);
    if (!self || self.indent === 0) return false;
    const subtree = subtreeBlocksAfter(blockEl, self.indent);
    setBlockIndent(blockEl, self.indent - 1);
    subtree.forEach((el) => {
      const a = liAttrs(el);
      if (a) setBlockIndent(el, Math.max(0, a.indent - 1));
    });
    return true;
  }

  // ── S3 Task 7: §3.5's batch Tab / Shift+Tab over a standing selection ──
  //
  // The whole task in one sentence: compute the delta ONCE, from the member
  // with the MINIMUM old indent, apply it to the whole set, and only THEN
  // clamp per item. Running the single-item arithmetic per member instead
  // breaks the sibling relationships the user selected — §3.5's own worked
  // example is `- a / (2sp)- b / (2sp)- c` with b+c selected: per item, c's
  // ceiling is 2 (because b sits at 1) so c moves there and is ADOPTED as b's
  // child, when the correct answer is that nothing moves at all.
  //
  // And the anchor is the minimum old indent, never the first member. That is
  // §3.4 rule 3's SECOND worked failure and it is Tab's own: a set running
  // b(1)..d(0) has a first member already at its ceiling, so a first-member
  // anchor yields delta 0 and no-ops the entire batch although Tab on d alone
  // is legal. Task 6 measured that the same swap is UNOBSERVABLE on a batch
  // DELETE (every survivor above the set is still a list item, so
  // anchorBefore() answers the same under either anchor and every segment
  // delta comes out 0), so a Tab fixture is the only thing that can pin it.

  // The element the batch delta is measured from: the first member carrying
  // the set's minimum old indent. spanMinIndent() is §3.4 rule 3's anchor
  // VALUE; this is the block that holds it.
  function batchIndentAnchorEl(liEls) {
    const min = spanMinIndent(liEls);
    for (let i = 0; i < liEls.length; i++) {
      if ((Number(liEls[i].getAttribute('data-indent')) || 0) === min) return liEls[i];
    }
    return liEls[0];
  }

  // How far the WHOLE set may move, as one number. `dir` is +1 (Tab) or -1
  // (Shift+Tab). The ceiling restates indentListItem()'s own single-item rule
  // for the anchor — the list-start clause included, so a set that opens a list
  // cannot nest itself under the previous list's last item — and the floor is
  // outdentListItem()'s (indent 0 cannot rise). Both read PRE-move indents,
  // which is §3.4's global convention ("the operated block's indent" always
  // means the value before the operation).
  function batchIndentDelta(anchorEl, dir) {
    const self = liAttrs(anchorEl);
    if (!self) return 0;
    if (dir < 0) return self.indent > 0 ? -1 : 0;
    if (self.listStart) return 0;
    const all = allBlockEls();
    const i = all.indexOf(anchorEl);
    if (i < 0) return 0;
    const prev = liAttrs(all[i - 1]);
    const max = prev ? prev.indent + 1 : 0;
    return Math.max(0, Math.min(1, max - self.indent));
  }

  // The li half. One mutation, one clamp, one commit — never a loop over the
  // members, for the reason the whole batch layer exists: a loop re-renders
  // between items and invalidates every id in between.
  async function indentListItemsBySelection(liEls, recs, dir) {
    // Every list batch is one run's problem — see batchRunOf().
    const run = batchRunOf(liEls);
    if (!run) { refuseStructuralListEdit(BATCH_MULTIRUN_MESSAGE); return; }
    // `columnOnly`: an indent change rewrites nothing but leading columns, so a
    // hard-wrapped member is a legal TARGET here — the same deviation the caret
    // Tab's own gate documents, and in a batch every member is a target.
    if (!listRunSupportsStructuralEdit(run, liEls, { columnOnly: true })) {
      refuseStructuralListEdit(); return;
    }
    const oldIndent = spanMinIndent(liEls);
    const delta = batchIndentDelta(batchIndentAnchorEl(liEls), dir);
    // A zero delta is a COMPLETE no-op — nothing mutated, nothing committed,
    // file byte-identical, the set left standing — exactly what the single-item
    // Tab does at its own boundary. On §3.5's b+c example this IS the right
    // answer, and it is the answer per-item maths cannot give.
    if (delta === 0) return;
    const first = recs[0];
    const last = recs[recs.length - 1];
    mutateListRun(() => {
      liEls.forEach((el) => setBlockIndent(el,
        Math.max(0, (Number(el.getAttribute('data-indent')) || 0) + delta)));
      // ONE call for the whole set, never one per member: clampIndents() takes
      // an ARRAY of operated indices precisely so §3.4 rule 3 computes one
      // segment delta for the blocks below instead of N independent clamps, and
      // its rule 1 then walks the operated blocks in document order so each is
      // measured against the member above it that the same pass just settled.
      applyIndentClamp(run, liEls, oldIndent);
    });
    // Re-derived AFTER the mutation, like the caret Tab's: an indent change can
    // move a block between runs.
    const liveRun = listRunOf(liEls[0]);
    if (!liveRun.length) return;
    // Column-only: nothing's CONTENT moved, so every block in the span — the
    // members included — is a bystander whose source bytes must come back
    // untouched.
    const carry = bystanderCarryOver(liveRun, null);
    // §3.3's collapse, declared immediately before the commit's render (Task 5
    // carry 5) and only when a set was standing (Task 6 carry 6). A
    // column-only edit changes no line COUNT and moves no line, so the members
    // keep exactly the range they had.
    declareCollapse({ startLine: first.startLine, endLine: last.endLine });
    await commitListStructure(liveRun, null, false, { carryOver: carry });
  }

  // The non-li half — §3.5's heading row, batched: Tab lowers a heading one
  // level (clamped to H6), Shift+Tab raises it (clamped to H1), and a
  // paragraph / quote / code member is a true no-op.
  //
  // The span is rewritten IN PLACE inside its own line range: each heading
  // member's line is re-emitted at the new depth and every other line —
  // separators and non-heading members alike — comes back verbatim. That is
  // what makes 「段落 no-op」 a real no-op instead of a re-serialization that
  // could move bytes nobody asked it to, and it is why this is ONE
  // commitRangeEdit and therefore one undo op.
  async function changeHeadingDepthsInSpan(els, recs, dir) {
    const first = recs[0];
    const last = recs[recs.length - 1];
    const span = lines.slice(first.startLine - 1, last.endLine);
    let changed = false;
    for (let i = 0; i < recs.length; i++) {
      if (recs[i].type !== 'heading') continue;
      const at = recs[i].startLine - first.startLine;
      const cur = span[at];
      // headingDepthOf() answers 1 for ANY line, matched or not, so a SETEXT
      // heading ('Title' over '====') would be handed a '#' it never asked for
      // and its underline left behind. Only a real ATX line is rewritten.
      if (typeof cur !== 'string' || !/^#{1,6}(\s|$)/.test(cur)) continue;
      const depth = headingDepthOf(cur);
      const next = Math.max(1, Math.min(6, depth + dir));
      if (next === depth) continue;
      span[at] = withHeadingDepth(cur, next);
      changed = true;
    }
    // Every member was a paragraph, or every heading already sat at its clamp:
    // §3.5 rules that a no-op, so nothing is committed and nothing re-renders.
    if (!changed) return;
    const result = commitRangeEdit({ lines, blocks, stack },
      first.startLine, last.endLine, span.join('\n'));
    if (result.op === null) return;
    const prevLines = lines;
    lines = result.lines;
    // §3.3's collapse: a depth change rewrites no line COUNT, so the set
    // collapses onto the lines it already held.
    declareCollapse({ startLine: first.startLine, endLine: last.endLine });
    const okRender = await safeRerenderAll();
    if (!okRender) {
      lines = rollbackFailedRender({ lines, stack }, result, prevLines);
    }
  }

  // The keydown entry point. The "grip" is the roving focus holder, which is a
  // member of the set by construction, so resolveGutterOperands() answers
  // 'batch' and hands back the whole span — together with the shared preamble
  // every ⠿ operation already goes through (switchAwayFrom(), the re-resolve
  // after a commit that re-rendered, the no-source-line refusal, the emptiness
  // and contiguity gates). Membership resolves by REFERENCE against the live
  // `blocks`, which is exactly why the record must come from there and not from
  // a fresh find() (Task 1 carry 4).
  async function tabSelection(dir) {
    const focusEl = selectionFocusBlockEl();
    if (!focusEl) return;
    const operands = await resolveGutterOperands(focusEl);
    if (!operands) return;
    const els = operands.els;
    const recs = operands.recs;
    const shape = spanListKinds(els);
    // §3.6's 2026-08-31 ruling, inherited rather than re-invented. NOTE: this
    // CONTRADICTS the S3 plan's Task 7 text ("a batch containing both kinds
    // applies each rule to its own kind") — see the Task 7 carry. A mixed span
    // would need the run's survivors re-serialized at the same time as lines
    // outside the run are rewritten, i.e. two commits and therefore two undo
    // ops, which §3.4's 「一次使用者手勢 = 恰好一個 undo op」 forbids.
    if (shape.anyLi && !shape.allLi) { refuseStructuralListEdit(BATCH_MIXED_MESSAGE); return; }
    if (shape.allLi) { await indentListItemsBySelection(els, recs, dir); return; }
    await changeHeadingDepthsInSpan(els, recs, dir);
  }

  // §3.6's 「Delete 整批刪」, whose 2026-08-31 ruling is that it goes through
  // the SAME batch path as the ⠿ menu's 刪除 and that no second deletion path
  // is written. deleteBlockViaGutter() already resolves §3.3's membership for
  // itself and routes an all-li span to deleteListItemsViaGutter(), so the key
  // is one call — every refusal, every collapse and the one-undo-op guarantee
  // come with it for free rather than being restated here.
  async function deleteSelection() {
    const focusEl = selectionFocusBlockEl();
    if (!focusEl) return;
    await deleteBlockViaGutter(focusEl);
  }

  // ── Task 8 (Phase 4): Notion key semantics on per-li blocks ─────────────
  // Spec §4's "key semantics on li surfaces", acceptance rows 1, 3, 5, 6, 7,
  // 8. Structurally different from Task 4's whole-list handleListKeydown()
  // (deleted in S1 along with the rest of the legacy 'list' surface): there, a
  // key mutated one big contenteditable and the commit waited for focusout.
  // Here each li is its own block AND its own surface, so a provisional block is not a real
  // block until the run is committed and re-rendered — every mutating key
  // therefore commits immediately (spec §3: "any structural change
  // re-serializes the whole run → one line-range replace"), which is also what
  // keeps each key at exactly ONE undo op.
  //
  // The one documented exception is row 3's TOP-LEVEL press (see
  // convertEmptyTopLevelLiToParagraph() below and RULING F-J).

  // Shared refusal for a structural key on a run that cannot round-trip —
  // see listRunSupportsStructuralEdit(). Also reused (with an explicit
  // `message` override) by the two blockOwnsNoLine() guards near
  // openRawEditor() / deleteBlockViaGutter() above — a block that owns no
  // source line at all is a different reason to refuse than "the run holds
  // an unsupported format", so it gets its own wording, but there is still
  // only ONE dismiss-only banner helper: two near-identical refusal
  // functions in this closure collided once already (Task 4 fix round 1)
  // and shadowed each other silently (last-declaration-wins), so the
  // no-source-line callers pass their own text instead of a second function.
  function refuseStructuralListEdit(message) {
    showBanner(message || '此清單含不支援的格式，無法調整結構', null, null);
  }

  // Row 3, top-level press: spec §4 — "at top level the next press converts
  // the block to a paragraph". Markdown cannot persist an EMPTY paragraph, so
  // this reuses the repo's existing §10 pristine-insert machinery instead of
  // inventing a second empty-block representation: remove the li (commit #1,
  // the run re-serialize), then insertBlockBelow() the paragraph skeleton
  // anchored to whatever block now PRECEDES the removal point (commit #2). The
  // user lands in a focused provisional paragraph that becomes real the moment
  // anything is typed into it, and self-removes at zero net undo cost if
  // abandoned (discardPristineInsert()).
  //
  // RULING F-J: this is therefore the ONE structural key press that is not a
  // single undo op. Observed granularity (asserted in
  // test/editor-client-runtime.test.js): Ctrl+Z #1 removes the provisional
  // paragraph without popping the stack, Ctrl+Z #2 reverts the li removal.
  async function convertEmptyTopLevelLiToParagraph(runEls, li) {
    // Both captured BEFORE the mutation. The range, because removing the run's
    // last item leaves commitListStructure() nothing to derive it from. The
    // anchor, because a removal never shifts a block that starts ahead of it,
    // and the run's re-serialization only rewrites lines from the run's own
    // start onward — so this startLine survives the commit and is the stable
    // handle back to that block (ids are re-derived by every render).
    const range = runRangeOfBlocks({ lines, blocks, stack }, runEls);
    const liBlock = blocks.find((b) => b.id === Number(li.getAttribute('data-block-id')));
    // `b.id !== liBlock.id` is not redundant: a block that owns no source line
    // has endLine === startLine - 1, so it satisfies `endLine < startLine`
    // AGAINST ITSELF and would be picked as its own predecessor. Unreachable
    // today (such a block is never armed, so this row-3 path cannot start on
    // one) but it is the same class of bug as the arming one above, and the
    // guard costs nothing.
    const precedingBlock = liBlock
      ? blocks.filter((b) => b.id !== liBlock.id && b.endLine < liBlock.startLine).pop()
      : null;
    // S1: the post-mutation span is the pre-mutation one minus the removed
    // block. It cannot be re-derived from `li` afterwards (the element is
    // detached), and re-deriving it from a survivor would be wrong for the
    // last-item case, where the answer must be an EMPTY span (serializes to
    // '', which is what takes commitListStructure()'s range-removal path).
    const survivors = runEls.filter((el) => el !== li);
    mutateListRun(() => removeListItem(li));
    // No `mutatedEl`: `li` is not IN `survivors`, and every block that is was
    // left exactly as the file has it.
    const ok = await commitListStructure(survivors, null, false,
      { presetRange: range, carryOver: bystanderCarryOver(survivors) });
    if (!ok) return;
    // Nothing precedes the removal point (the list opened the document):
    // commitBlockInsertion() can only insert BELOW an existing block, so the
    // paragraph step is skipped. The li removal still stands — no content is
    // lost, the user just has to type where they want the paragraph.
    if (!precedingBlock) return;
    const anchorEl = blockElAtLine(precedingBlock.startLine);
    if (!anchorEl) return;
    await insertBlockBelow(anchorEl, 'paragraph');
  }

  // Returns true when the key was CONSUMED (Enter/Tab, incl. their no-op
  // outcomes); false lets handleBurstKeydown()'s shared Escape / Ctrl+Z /
  // Ctrl+Y branches run unchanged.
  function handleLiKeydown(e, editEl) {
    if (e.key !== 'Enter' && e.key !== 'Tab') return false;
    e.preventDefault();
    // Row 2: Shift+Enter is an in-block line break, not a structural change.
    if (e.key === 'Enter' && e.shiftKey) {
      insertBrAtCaret();
      snapBurstIfActive(editEl, 'br');
      return true;
    }
    // The CARET's block, not editEl's: a run has one editable surface per item,
    // and the caret can legitimately sit in a different one than the burst was
    // opened on (placing a Range inside another item's surface does not move
    // focus). closestLiBlock(editEl) is the fallback when the selection is
    // absent or outside the run.
    const li = caretLiBlock() || closestLiBlock(editEl);
    if (!li) return true;
    // S1: the commit span, re-derived AFTER each mutation below (an indent
    // change can move a block between runs). This one is the PRE-mutation span
    // the gates run against.
    let run = listRunOf(li);
    if (!run.length) return true;

    if (e.key === 'Tab') {
      // `columnOnly`: an indent change rewrites nothing but leading columns, so
      // a hard-wrapped item is allowed to be the target here — see
      // listRunSupportsStructuralEdit()'s deviation note for the measurement.
      if (!listRunSupportsStructuralEdit(run, li, { columnOnly: true })) {
        refuseStructuralListEdit(); return true;
      }
      // Tab (spec §3.5): indentListItem() moves ONLY the caret item — its
      // children keep their indent and become its siblings. Shift+Tab:
      // outdentListItem() raises it one level, takes its own subtree with it,
      // and adopts its former following same-level siblings. Both return false
      // at their respective boundary (no previous sibling / already top level),
      // which is a complete no-op — nothing mutated, nothing committed, file
      // byte-identical.
      const oldIndent = Number(li.getAttribute('data-indent')) || 0;
      const changed = mutateListRun(() => {
        if (!(e.shiftKey ? outdentListItem(li) : indentListItem(li))) return false;
        applyIndentClamp(run, li, oldIndent);
        return true;
      });
      if (!changed) return true;
      run = listRunOf(li);
      // Column-only: nothing's CONTENT moved, so every block in the span —
      // the target included — is a bystander whose source bytes must come
      // back untouched. Built once and shared with runLineOfBlock() below,
      // which indexes into the lines this very map decides.
      const carry = bystanderCarryOver(run, null);
      commitListStructure(run, runLineOfBlock(run, li, carry), true, { carryOver: carry });
      return true;
    }

    // Enter.
    if (selectionSpansMultipleListItems()) {
      // Refuse rather than silently deleting the spanned content — no
      // mutation, no commit, no banner. Collapse to the end of the selection
      // so a repeat Enter (now a plain caret) behaves predictably.
      // (Explicit removeAllRanges()/addRange() — same pattern every other
      // Range-mutation in this file uses — rather than mutating the Range
      // returned by getRangeAt() in place, which isn't guaranteed to sync
      // back to the live Selection.)
      const sel = window.getSelection();
      if (sel.rangeCount) {
        const r = sel.getRangeAt(0).cloneRange();
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
      }
      return true;
    }
    // Enter's target is the caret's own item in every one of its three
    // outcomes (split, empty-outdent, convert-to-paragraph) — each rewrites
    // that item's own line range, which is exactly what a hard-wrapped item
    // refuses (spec §4.1).
    if (!listRunSupportsStructuralEdit(run, li)) { refuseStructuralListEdit(); return true; }
    if (liOwnTextIsBlank(li)) {
      // Row 3: one press = one outdent, with the SAME semantics as Shift+Tab
      // (adoption included). RULING F-Q: an item that OWNS a sublist takes this
      // path too — its subtree travels with it, so there is nothing to orphan.
      const outdented = mutateListRun(() => {
        if (!outdentListItem(li)) return false;
        // The surface can still hold things the user reads as "nothing" but a
        // serializer does not: Chromium's placeholder <br> (left behind when the
        // last character is deleted), which inline-md.js emits as a literal
        // '<br>', and — RULING F-U — a bare NBSP, which liOwnTextIsBlank() above
        // normalises away but list-md.js's trailing-whitespace trim
        // (/[ \t]+$/) does not, so it would survive into the committed line.
        // Either way the user sees an empty item and must get a bare '-'. Clear
        // the surface under the SAME normalisation the branch condition used —
        // liSurfaceHoldsNothing() — inside the suppression span (an innerHTML
        // assignment on the focused node triggers the very same Chromium unfocus
        // quirk), and only once the outdent above has actually happened, since a
        // refused press must leave the DOM byte-identical.
        const textEl = liTextEl(li);
        if (textEl && liSurfaceHoldsNothing(textEl)) textEl.innerHTML = '';
        return true;
      });
      if (outdented) {
        run = listRunOf(li);
        // `li` is the mutated block (the outdent may have cleared its
        // surface), so its own bytes are the DOM's, not the file's.
        const carry = bystanderCarryOver(run, li);
        commitListStructure(run, runLineOfBlock(run, li, carry), true, { carryOver: carry });
        return true;
      }
      // Already at top level, so this is row 3's "next press converts the block
      // to a paragraph" step — EXCEPT when the item owns a sublist. RULING F-Q
      // draws the line here: a paragraph cannot own list children, so
      // converting would have to promote them to top-level items, which spec
      // row 3 never describes and which silently restructures content the user
      // did not touch. Refuse instead — a complete no-op (nothing mutated,
      // nothing committed, burst left open) until the user empties or moves the
      // children themselves.
      if (liBlockHasChildren(li)) return true;
      convertEmptyTopLevelLiToParagraph(run, li);
      return true;
    }
    // Row 1: split at the caret; the caret goes to the START of the new block.
    const newLi = mutateListRun(() => splitListItemAtCaret(li));
    if (!newLi) return true;
    run = listRunOf(newLi);
    // `li` had its text CUT IN TWO in the DOM; replaying its source would put
    // the whole of it back and duplicate the half that moved into `newLi`.
    // Named explicitly rather than leaning on the dirty-burst exclusion: the
    // caret can sit in a different item than the burst was opened on (see
    // where `li` is derived above), and then the burst names the wrong block.
    // `newLi` is provisional (no data-block-id) and excludes itself.
    const carry = bystanderCarryOver(run, li);
    commitListStructure(run, runLineOfBlock(run, newLi, carry), false, { carryOver: carry });
    return true;
  }

  // ── Task 5 (Phase 3): table always-on WYSIWYG editing + burst undo ─────
  // Retires Phase-2's click-select-then-✎ table session (the old per-table
  // opening function, now deleted entirely) in favor of the SAME always-on
  // burst substrate Task 2
  // (paragraph/heading) and Task 4 (list) already use — every cell of an
  // eligible table is permanently contenteditable from armEditables() (see
  // its 'table' branch above), no "open" step. A table's burst is the ONE
  // structural exception to "burst.editEl is the focused surface itself"
  // (true for paragraph/heading/list): a table has MANY independently-
  // editable cells, so burst.editEl is the whole <table> (matching what
  // tableMd.serializeTable() expects, and what commits as ONE line-range
  // replacement) while burst.activeCellEl tracks whichever cell most
  // recently had focus — Tab/click moving between cells updates
  // activeCellEl WITHOUT ending the burst; only focus leaving the TABLE
  // entirely (or Esc, or undo/redo cascading out) ends it. activeCellEl is
  // also what the Task 5 hover-insert bubbles below and T6's future edge
  // menus read to know which row/column an op should act on.
  //
  // Fixed Tab-navigation order: document order of every TH/TD, which for a
  // table (thead before tbody, rows/cells in source order) is exactly
  // header-row-left-to-right then each body row left-to-right. Real DOM
  // (not the node-test stub), so querySelectorAll is fair game here —
  // unlike table-md.js, this file has never been childNodes-only.
  function tableCellsOf(tableEl) {
    return Array.prototype.slice.call(tableEl.querySelectorAll('th, td'));
  }

  // Starts a burst rooted at `tableEl` (any cell's arm-time class already
  // makes it a valid focus target) — mirrors startBurst() above, just with
  // an extra `activeCellEl` field and a captureFn that snapshots the WHOLE
  // table's innerHTML (which already includes every cell's contenteditable/
  // class attributes, set once at arm time — see armEditables()'s 'table'
  // branch — so a burst-undo snapshot restore below reproduces a fully
  // re-armed table, not a plain static one).
  function startTableBurst(cellEl) {
    const tableEl = cellEl.closest('table');
    const blockEl = tableEl && tableEl.closest('.ed-block');
    if (!blockEl) return;
    const blockId = Number(blockEl.getAttribute('data-block-id'));
    const block = blocks.find((b) => b.id === blockId);
    if (!block) return;
    const history = historyLib.createBurstHistory(() => burstBaselineHtml(tableEl), { debounceMs: 400 });
    history.start();
    currentBurst = {
      blockEl, editEl: tableEl, blockId, blockType: 'table',
      depth: null, original: burstBaselineHtml(tableEl), history,
      activeCellEl: cellEl,
    };
    selToolbarEditEl = cellEl;
    if (!selToolbarListener) {
      selToolbarListener = onSelectionChangeForToolbar;
      document.addEventListener('selectionchange', onSelectionChangeForToolbar);
    }
  }

  // The delegated focusin listener's table-cell branch (called instead of
  // the plain paragraph/list path below whenever the focused target is a
  // '.ed-wys-cell') — mirrors that path's single-flight / re-resolve-after-
  // rerenderAll() shape exactly, just keyed on the CELL's owning table
  // rather than the cell itself (so moving focus between cells of the same
  // table's already-open burst is a no-op here, not a new burst).
  async function handleTableCellFocusIn(cellEl) {
    const tableEl = cellEl.closest('table');
    if (!tableEl) return;
    if (currentBurst && currentBurst.blockType === 'table' && currentBurst.editEl === tableEl) {
      currentBurst.activeCellEl = cellEl; // burst already open — just the active cell moved
      selToolbarEditEl = cellEl;
      return;
    }
    const blockEl = tableEl.closest('.ed-block');
    const blockId = blockEl ? blockEl.getAttribute('data-block-id') : null;
    if (switching) await switching;
    if (currentBurst && currentBurst.blockType === 'table' && currentBurst.blockEl &&
        currentBurst.blockEl.getAttribute('data-block-id') === blockId) {
      currentBurst.activeCellEl = cellEl;
      selToolbarEditEl = cellEl;
      return; // the awaited resolution's own re-entrant focus already won this table's burst
    }
    if (currentBurst) return; // a concurrent focusin (a DIFFERENT block) already won the race
    let liveCellEl = cellEl;
    if (!document.body.contains(cellEl)) {
      const liveBlockEl = blockId != null ? document.querySelector('.ed-block[data-block-id="' + blockId + '"]') : null;
      const liveTableEl = liveBlockEl ? blockContentEl(liveBlockEl) : null;
      liveCellEl = liveTableEl ? tableCellsOf(liveTableEl)[0] : null;
      if (!liveCellEl || !liveCellEl.classList.contains('ed-wys-cell')) return;
      liveCellEl.focus();
      return;
    }
    startTableBurst(liveCellEl);
  }

  function moveActiveTableCell(cellEl, delta) {
    const tableEl = cellEl.closest('table');
    const cells = tableCellsOf(tableEl);
    const idx = cells.indexOf(cellEl);
    const next = Math.max(0, Math.min(cells.length - 1, idx + delta));
    const target = cells[next];
    if (target) { target.focus(); placeCaretAtEnd(target); }
  }

  // Esc inside a table burst: revert to the pre-focus baseline and end the
  // burst WITHOUT committing — mirrors revertBurstAndEnd() above, but a
  // table burst has no single always-live element to blur() afterward (the
  // innerHTML rewrite below detaches whichever cell WAS focused, and
  // replaces it with an equivalent-but-different node). Chromium runs the
  // focus-fixup "unfocus" step (firing a synchronous blur/focusout) BEFORE
  // actually detaching the node — see `suppressTableFocusout`'s own
  // comment near `currentBurst`'s declaration for the full story — so
  // `e.target.closest('table')` in that focusout would still resolve to
  // this live `tableEl`. What makes THIS call site safe WITHOUT that flag
  // is nulling `currentBurst` first: the focusout handler's table branch
  // requires `currentBurst` to be non-null, so by the time the innerHTML
  // rewrite below fires that synchronous blur, there is no burst left to
  // mistakenly resolve — same "belt and braces" idiom rerenderAll() uses.
  async function revertTableBurstAndEnd(cellEl) {
    const burst = currentBurst;
    if (!burst || burst.blockType !== 'table' || burst.editEl !== cellEl.closest('table')) return;
    const tableEl = burst.editEl;
    // §10-gap fix (review): same "Escape always reverts to `burst.original`,
    // which for a pristine block IS the still-untouched skeleton" reasoning
    // as revertBurstAndEnd() above.
    const wasPristineForThisBlock = !!(pristineInsert && pristineInsert.blockId === burst.blockId);
    if (wasPristineForThisBlock) pristineInsert = null;
    burst.history.dispose();
    currentBurst = null;
    resetSelToolbarState();
    hideTableInsertBubbles();
    hideTableGrips();
    hideTableEdgeMenu();
    cancelTeDrag();
    tableEl.innerHTML = burst.original;
    if (wasPristineForThisBlock) await discardPristineInsert();
  }

  // Ctrl+Z inside a table burst: symmetric to burstUndo() above, but a
  // table-history snapshot replaces the WHOLE table's innerHTML (not one
  // focusable surface), so the previously-active cell's DOM node is stale
  // after restore — re-focus the cell at the SAME ordinal position (by
  // index among tableCellsOf()) in the freshly-restored DOM instead.
  function tableBurstUndo(cellEl) {
    const burst = currentBurst;
    if (!burst || burst.blockType !== 'table' || burst.editEl !== cellEl.closest('table')) return;
    const tableEl = burst.editEl;
    const cells = tableCellsOf(tableEl);
    const idx = cells.indexOf(burst.activeCellEl || cellEl);
    const state = burst.history.undo();
    if (state !== null) {
      // Task 6: the innerHTML swap below detaches whatever cells/rows the
      // grip handles, the edge menu, or an in-flight drag currently
      // reference on THIS table — clear all three before the swap, same
      // belt-and-braces idiom as rerenderAll()/resolveBurst() above.
      hideTableGrips();
      hideTableEdgeMenu();
      cancelTeDrag();
      // See `suppressTableFocusout`'s own comment (near `currentBurst`'s
      // declaration) for exactly why this flag is required around this
      // reassignment. try/finally (review fix): if the assignment itself
      // throws, the flag must still be cleared — this listener sits at the
      // TOP of the document-level `focusout` handler, so a latched-true
      // flag would silently disable blur-commits for EVERY block type
      // (not just tables) until reload.
      suppressTableFocusout = true;
      try {
        tableEl.innerHTML = state;
      } finally {
        suppressTableFocusout = false;
      }
      const newCells = tableCellsOf(tableEl);
      const target = newCells[Math.max(0, Math.min(newCells.length - 1, idx))] || newCells[0];
      if (target) {
        burst.activeCellEl = target;
        selToolbarEditEl = target;
        target.focus();
        placeCaretAtEnd(target);
      }
      return;
    }
    // §10-gap fix (review): same reasoning as burstUndo()'s own guard above
    // — the resolution switchAwayFrom() is about to run will itself
    // auto-remove an untouched pristine table insert, so a chained undo()
    // must be skipped or it cascades one op too far.
    const willAutoRemove = !!(pristineInsert && pristineInsert.blockId === burst.blockId &&
      burstBaselineHtml(tableEl) === burst.original);
    switchAwayFrom().then((ok) => { if (ok && !willAutoRemove) undo(); });
  }

  // Ctrl+Y / Ctrl+Shift+Z inside a table burst: symmetric to tableBurstUndo().
  function tableBurstRedo(cellEl) {
    const burst = currentBurst;
    if (!burst || burst.blockType !== 'table' || burst.editEl !== cellEl.closest('table')) return;
    const tableEl = burst.editEl;
    const cells = tableCellsOf(tableEl);
    const idx = cells.indexOf(burst.activeCellEl || cellEl);
    const state = burst.history.redo();
    if (state !== null) {
      // Task 6: same belt-and-braces clear as tableBurstUndo() above.
      hideTableGrips();
      hideTableEdgeMenu();
      cancelTeDrag();
      // try/finally — same exception-safety reasoning as tableBurstUndo()'s
      // own comment just above.
      suppressTableFocusout = true;
      try {
        tableEl.innerHTML = state;
      } finally {
        suppressTableFocusout = false;
      }
      const newCells = tableCellsOf(tableEl);
      const target = newCells[Math.max(0, Math.min(newCells.length - 1, idx))] || newCells[0];
      if (target) {
        burst.activeCellEl = target;
        selToolbarEditEl = target;
        target.focus();
        placeCaretAtEnd(target);
      }
      return;
    }
    switchAwayFrom().then((ok) => { if (ok) redo(); });
  }

  // The delegated keydown handler's per-keystroke logic for a focused
  // '.ed-wys-cell' — mirrors handleBurstKeydown() above: Enter is
  // UNCONDITIONAL <br> insert (never a commit — a table burst has no
  // Enter-commits gesture at all, only leaving the TABLE or Esc ends it),
  // Tab/Shift+Tab move the active cell without ending the burst, Escape
  // reverts, Ctrl+Z/Y drive the burst-local history.
  function handleTableCellKeydown(e, cellEl) {
    const tableEl = cellEl.closest('table');
    if (!currentBurst || currentBurst.blockType !== 'table' || currentBurst.editEl !== tableEl) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      insertBrAtCaret();
      snapBurstIfActive(tableEl, 'br');
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      moveActiveTableCell(cellEl, e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      revertTableBurstAndEnd(cellEl);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
      e.preventDefault();
      tableBurstUndo(cellEl);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
      e.preventDefault();
      tableBurstRedo(cellEl);
      return;
    }
  }

  // ── Table structure ops (row/col add/del, alignment) ────────────────────
  // Pure DOM-mutation helpers — UI-independent by design. The Phase-2
  // floating-toolbar buttons that used to drive these are retired along
  // with the rest of the click-select bar (Global Constraint: "old
  // table-op bar buttons already retired in T2's bar removal" — the LAST
  // bar consumer, tables, is retired here). Task 5 itself only wires
  // insertRow()/insertColumn() (via
  // the hover-edge insert bubbles below); deleteRow()/deleteColumn()/
  // cycleColumnAlign() have no UI surface in THIS task — they stay exactly
  // as they were (never mutated, never even renamed) specifically so T6's
  // future edge-menus can wire them up unchanged, per the brief's explicit
  // "the op FUNCTIONS stay — T6 reuses them from edge menus".
  //
  // Column index is read via the real DOM's native `<tr>.cells` (this file
  // — unlike table-md.js's node-stub-constrained walk — has always used
  // real DOM APIs). Alignment is read/written on the HEADER cell only for
  // determining the NEXT state, but applied to every cell (th+td) in the
  // column: table-md.js's serializeTable() reads alignment from the header
  // row alone (documented "column-uniform assumption" in that file), so
  // leaving body cells out of sync here would silently diverge from what
  // gets committed — see cycleColumnAlign() below.
  function colIndexOf(cellEl) {
    return Array.prototype.indexOf.call(cellEl.parentElement.cells, cellEl);
  }

  function headerRowOf(tableEl) {
    return tableEl.tHead ? tableEl.tHead.rows[0] : null;
  }

  function bodyRowsOf(tableEl) {
    const tbody = tableEl.tBodies[0];
    return tbody ? Array.prototype.slice.call(tbody.rows) : [];
  }

  // All rows (header first, then body, in document order) — every row/col
  // structural op below walks this list so header + body cells stay in
  // lockstep column-for-column.
  function allRowsOf(tableEl) {
    const header = headerRowOf(tableEl);
    return (header ? [header] : []).concat(bodyRowsOf(tableEl));
  }

  // Inserts a new, empty body row directly after `afterRow` — or as the
  // FIRST body row when `afterRow` is the header (or there is no body yet):
  // there is no "row before the header" to insert after, so a header-
  // adjacent ＋ boundary falls through to this same first-body-row
  // placement (this is exactly why the hover-insert bubble below treats the
  // header's own bottom edge as its own boundary, `afterRowIndex: -1`).
  function insertRow(tableEl, afterRow) {
    const colCount = headerRowOf(tableEl) ? headerRowOf(tableEl).cells.length : 0;
    const tbody = tableEl.tBodies[0];
    const newRow = document.createElement('tr');
    for (let i = 0; i < colCount; i++) newRow.appendChild(document.createElement('td'));
    if (afterRow && afterRow.parentElement === tbody) {
      afterRow.parentElement.insertBefore(newRow, afterRow.nextSibling);
    } else if (tbody) {
      tbody.insertBefore(newRow, tbody.firstChild);
    }
  }

  function deleteRow(rowEl) {
    if (rowEl && rowEl.parentElement) rowEl.parentElement.removeChild(rowEl);
  }

  // Inserts a new, empty cell (th in the header row, td everywhere else) at
  // `colIndex + 1` in EVERY row — never just the focused row — so the table
  // stays rectangular (every row the same cell count), a precondition
  // table-md.js's column-uniform alignment reading (and this file's own
  // colIndexOf()) both assume.
  function insertColumn(tableEl, colIndex) {
    allRowsOf(tableEl).forEach((row) => {
      const isHeader = row === headerRowOf(tableEl);
      const cell = document.createElement(isHeader ? 'th' : 'td');
      // 新欄是空的，narrow 與空儲存格一致；classifyColumns() 是 render 時
      // 的啟發式，編輯器無法重跑，下一次 commit 全量重繪時才會重算。
      cell.className = 'cell-narrow';
      const ref = row.cells[colIndex];
      row.insertBefore(cell, ref ? ref.nextSibling : null);
    });
    const cg = tableEl.querySelector('colgroup');
    if (cg) {
      const col = document.createElement('col');
      col.className = 'col-narrow';
      const ref = cg.children[colIndex];
      cg.insertBefore(col, ref ? ref.nextSibling : null);
    }
  }

  function deleteColumn(tableEl, colIndex) {
    allRowsOf(tableEl).forEach((row) => {
      const cell = row.cells[colIndex];
      if (cell) row.removeChild(cell);
    });
    const cg = tableEl.querySelector('colgroup');
    if (cg && cg.children[colIndex]) cg.removeChild(cg.children[colIndex]);
  }

  // Mirrors table-md.js's own cellAlign() (that file can't require this one
  // — node-test-constrained to childNodes/getAttribute only — so the tiny
  // regex is duplicated rather than shared; keep both in sync if the style
  // form ever changes).
  function cellStyleAlign(cell) {
    const style = cell.getAttribute('style');
    if (!style) return null;
    const m = /text-align\s*:\s*(left|right|center)/.exec(style);
    return m ? m[1] : null;
  }

  const ALIGN_CYCLE = ['left', 'center', 'right'];
  // Unset/default (no style attribute — GFM's plain `---` separator) is
  // NOT a cycle stop of its own per the brief ("cycle left→center→right");
  // indexOf() returning -1 for it lands the FIRST click on 'left' ((-1+1)
  // % 3 === 0), same as clicking from an explicit 'right'. There is no way
  // to cycle back OUT to unset once a click has set an explicit alignment.
  function nextAlign(current) {
    const idx = ALIGN_CYCLE.indexOf(current);
    return ALIGN_CYCLE[(idx + 1) % ALIGN_CYCLE.length];
  }

  function cycleColumnAlign(tableEl, colIndex) {
    const headerRow = headerRowOf(tableEl);
    const headerCell = headerRow ? headerRow.cells[colIndex] : null;
    const next = nextAlign(headerCell ? cellStyleAlign(headerCell) : null);
    allRowsOf(tableEl).forEach((row) => {
      const cell = row.cells[colIndex];
      if (cell) cell.setAttribute('style', 'text-align:' + next);
    });
  }

  // ── Task 5: hover-edge column/row insert bubbles ────────────────────────
  // A SINGLETON pair of "＋" bubble buttons (never one node per boundary —
  // Global Constraint) built once and repositioned via getBoundingClientRect()
  // onto whichever boundary (if any) the pointer is currently near, driven by
  // a single throttled (rAF-coalesced) document `mousemove` listener wired
  // near the bottom of this file alongside the other delegated listeners.
  // Column bubble: shown near a table's TOP edge, over the RIGHT edge of one
  // of its header cells (documented decision: only a boundary AFTER an
  // existing column is offered — there is no "insert before the first
  // column" boundary, since insertColumn(tableEl, colIndex)'s own contract
  // is "insert after colIndex"; see the task-5 report). Row bubble: shown
  // near a table's LEFT edge, over the BOTTOM edge of the header or any body
  // row (see insertRow()'s own "header counts as the first boundary" note
  // just above).
  const TB_EDGE_PX = 10; // proximity threshold, in CSS px, for "near a boundary"
  const TB_BUBBLE_SIZE = 18; // must match .ed-tb-insert's CSS width/height

  function buildTableInsertBubble(cls, ariaLabel) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ed-tb-insert ' + cls;
    b.textContent = '＋';
    b.setAttribute('aria-label', ariaLabel);
    b.hidden = true;
    // Same "keep the burst's focus/selection intact across the click" idiom
    // as .ed-seltb's own buttons (buildSelToolbar() above) — without this,
    // the bubble (outside any cell) stealing focus on mousedown would fire a
    // focusout on the currently-focused cell BEFORE the click handler ever
    // runs, which (since the bubble sits outside the table) would look like
    // "focus left the table" and commit the burst before the insert applies.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    document.body.appendChild(b);
    return b;
  }
  const colInsertBubble = buildTableInsertBubble('ed-tb-insert-col', 'Insert column');
  const rowInsertBubble = buildTableInsertBubble('ed-tb-insert-row', 'Insert row');

  function hideTableInsertBubbles() {
    colInsertBubble.hidden = true;
    rowInsertBubble.hidden = true;
  }

  // Ensures a table burst is open and focused on `tableEl` (brief: "auto-
  // start a burst if none open — decide semantics, document"). Chosen
  // policy: focuses the table's FIRST cell — same fallback Phase-2's own ✎
  // button used ("opens the session with the FIRST cell active"). A NO-OP
  // (touches neither focus nor `switchAwayFrom()`) when `tableEl`'s OWN
  // burst is ALREADY the open one, so a rapid sequence of bubble clicks on
  // the same table never re-focuses/re-selects anything mid-sequence.
  // Resolves whatever ELSE is open first, same precondition every other
  // open path in this file uses. cell.focus() synchronously starts the
  // burst via the delegated focusin listener's table-cell branch (see
  // handleTableCellFocusIn() above) — no separate direct call needed here.
  //
  // Final-review Finding 6 (Important): `switchAwayFrom()` here may resolve
  // a DIFFERENT block's dirty burst (the whole reason this function exists
  // — a ＋ bubble / edge-menu op / row drop on a table that ISN'T the
  // currently-focused one still needs whatever else is open committed
  // first). That commit's rerenderAll() swaps the WHOLE `.content`
  // subtree, not just the block that was dirty — which detaches `tableEl`
  // too, even though the table itself was never the thing being resolved.
  // The old `!document.body.contains(tableEl)` check treated that as
  // "table's gone" and bailed out, silently discarding the insert/delete/
  // align/drop the caller was trying to perform. Capture this table's OWN
  // identity FIRST and, same stale-node recovery the focusin listener uses
  // above, re-resolve the LIVE table by it when the original reference no
  // longer resolves — returning that live element (which callers below now
  // use in place of their own now-possibly-stale `tableEl`) instead of a
  // bare boolean, so a caller can never accidentally keep operating on the
  // detached node it started with.
  //
  // S1 (Critical): that recovery used to key on `data-block-id`, which is
  // NOT stable across the very commit it is recovering from. blockmap.js
  // renumbers ids 0..n-1 in document order on EVERY render (`nextId =
  // {v:0}`), so a resolved burst that changes the NUMBER of blocks before
  // this table (e.g. a dirty raw-edit textarea whose source splits one
  // paragraph into two) shifts every later id down — and the id captured
  // here then names a DIFFERENT block. `classList.contains('ed-wys-table')`
  // was the only guard, and every table passes it, so the gesture silently
  // rewrote an untouched neighbouring table (a row drag even promoted one of
  // its body rows to its header). Re-resolve by `startLine` instead — see
  // blockElAtLine()'s own comment: a startLine captured before a commit is
  // the only stable way back to a specific block afterwards — and then
  // verify the block we landed on really is the same table (header cell
  // count, header cell text, row count) before handing it to a caller that
  // is about to mutate it. A commit that shifts this table's own start line
  // (an insert/delete ABOVE it) leaves nothing to resolve; returning null
  // drops the gesture, which is the conservative half of the trade — never
  // mutating the wrong table beats completing every gesture.
  function tableIdentityOf(tableEl) {
    const headerRow = tableEl ? headerRowOf(tableEl) : null;
    if (!headerRow) return null;
    return allRowsOf(tableEl).length + '' +
      Array.prototype.slice.call(headerRow.cells).map((c) => c.textContent).join(' ');
  }
  async function ensureTableBurstOpen(tableEl) {
    if (currentBurst && currentBurst.blockType === 'table' && currentBurst.editEl === tableEl) return tableEl;
    const blockEl = tableEl.closest('.ed-block');
    const blockId = blockEl ? Number(blockEl.getAttribute('data-block-id')) : null;
    const block = blockId != null ? blocks.find((b) => b.id === blockId) : null;
    const startLine = block ? block.startLine : null;
    const identity = tableIdentityOf(tableEl);
    const ok = await switchAwayFrom();
    if (!ok) return null;
    let liveTableEl = tableEl;
    if (!document.body.contains(tableEl)) {
      const liveBlockEl = startLine != null ? blockElAtLine(startLine) : null;
      liveTableEl = liveBlockEl ? blockContentEl(liveBlockEl) : null;
      // T7: both refusals used to `return null` in silence — the drag, the
      // insert, the alignment change simply did not happen and nothing on
      // screen said why, which is indistinguishable from a broken control.
      // Dropping is still the right answer (see the S1 comment above); saying
      // nothing was not.
      if (!liveTableEl || !liveTableEl.classList || !liveTableEl.classList.contains('ed-wys-table')) {
        showBanner(DROPPED_GESTURE_MESSAGE, null, null); return null;
      }
      if (identity == null || tableIdentityOf(liveTableEl) !== identity) {
        showBanner(DROPPED_GESTURE_MESSAGE, null, null); return null;
      }
    }
    if (currentBurst && currentBurst.blockType === 'table' && currentBurst.editEl === liveTableEl) return liveTableEl;
    const cell = tableCellsOf(liveTableEl)[0];
    if (!cell) return null;
    cell.focus();
    return (currentBurst && currentBurst.blockType === 'table' && currentBurst.editEl === liveTableEl)
      ? liveTableEl : null;
  }

  // A cell inserted by insertColumn()/insertRow() (reused unchanged from
  // Phase 2 — see the section comment above) is plain markup with no
  // contenteditable/class attributes of its own; the hover-insert click
  // handlers below call this immediately after each insert so the new
  // cell is armed exactly like every other cell in an already-armed table
  // (idempotent: only touches cells that aren't already armed, so it's
  // safe to call unconditionally over the whole table rather than tracking
  // exactly which cells an insert just created).
  function armNewTableCells(tableEl) {
    tableCellsOf(tableEl).forEach((cell) => {
      if (!cell.classList.contains('ed-wys-cell')) {
        cell.setAttribute('contenteditable', 'true');
        cell.classList.add('ed-wys-cell');
      }
    });
  }

  async function onColInsertBubbleClick() {
    const tableEl = hoveredInsertTableEl;
    const colIndex = Number(colInsertBubble.dataset.colIndex);
    if (!tableEl || Number.isNaN(colIndex)) return;
    // Final-review Finding 6: use the LIVE table ensureTableBurstOpen()
    // resolves to (which may differ from `tableEl` if a dirty burst
    // elsewhere just committed and swapped `.content` out from under this
    // click) — never the possibly-now-detached `tableEl` itself.
    const liveTableEl = await ensureTableBurstOpen(tableEl);
    if (!liveTableEl) return;
    insertColumn(liveTableEl, colIndex);
    armNewTableCells(liveTableEl);
    currentBurst.history.snap('insert-col');
    hideTableInsertBubbles(); // the boundary geometry just changed; wait for the next mousemove
    hideTableGrips(); // same reasoning — a shifted column index would otherwise stay stale
  }
  colInsertBubble.addEventListener('click', (e) => { e.stopPropagation(); onColInsertBubbleClick(); });

  async function onRowInsertBubbleClick() {
    const tableEl = hoveredInsertTableEl;
    const afterRowIndex = Number(rowInsertBubble.dataset.afterRowIndex); // -1 -> header (first body row)
    if (!tableEl || Number.isNaN(afterRowIndex)) return;
    // Final-review Finding 6: same live-table swap as onColInsertBubbleClick()
    // above — `afterRowIndex` is a plain integer so it stays valid across
    // the swap unchanged, only the table element reference needs re-resolving.
    const liveTableEl = await ensureTableBurstOpen(tableEl);
    if (!liveTableEl) return;
    const afterRow = afterRowIndex >= 0 ? bodyRowsOf(liveTableEl)[afterRowIndex] : null;
    insertRow(liveTableEl, afterRow);
    armNewTableCells(liveTableEl);
    currentBurst.history.snap('insert-row');
    hideTableInsertBubbles();
    hideTableGrips(); // same reasoning as onColInsertBubbleClick() above
  }
  rowInsertBubble.addEventListener('click', (e) => { e.stopPropagation(); onRowInsertBubbleClick(); });

  // The table the bubbles are currently positioned against, if any — set by
  // updateTableInsertBubbles() below, read back by the two click handlers
  // above (dataset carries WHICH boundary; this carries WHICH table).
  let hoveredInsertTableEl = null;

  // Recomputes bubble visibility/position from the latest throttled pointer
  // coordinates — called from the mousemove listener wired near the bottom
  // of this file. `target` is whatever element was directly under the
  // pointer (Event#target) at those coordinates.
  function updateTableInsertBubbles(x, y, target) {
    const blockEl = target && target.closest && target.closest('.ed-block[data-block-type="table"]');
    const tableEl = blockEl ? blockContentEl(blockEl) : null;
    if (!tableEl || !tableEl.classList.contains('ed-wys-table')) {
      hideTableInsertBubbles();
      hoveredInsertTableEl = null;
      return;
    }
    hoveredInsertTableEl = tableEl;
    const tableRect = tableEl.getBoundingClientRect();
    const half = TB_BUBBLE_SIZE / 2;

    let colShown = false;
    const headerRow = headerRowOf(tableEl);
    if (headerRow && Math.abs(y - tableRect.top) <= TB_EDGE_PX) {
      const headerCells = Array.prototype.slice.call(headerRow.cells);
      for (let i = 0; i < headerCells.length; i++) {
        const r = headerCells[i].getBoundingClientRect();
        if (Math.abs(x - r.right) <= TB_EDGE_PX) {
          colInsertBubble.dataset.colIndex = String(i);
          colInsertBubble.style.left = (r.right - half) + 'px';
          colInsertBubble.style.top = (tableRect.top - half) + 'px';
          colInsertBubble.hidden = false;
          colShown = true;
          break;
        }
      }
    }
    if (!colShown) colInsertBubble.hidden = true;

    let rowShown = false;
    if (Math.abs(x - tableRect.left) <= TB_EDGE_PX) {
      const boundaries = [];
      if (headerRow) boundaries.push({ y: headerRow.getBoundingClientRect().bottom, afterRowIndex: -1 });
      bodyRowsOf(tableEl).forEach((row, i) => {
        boundaries.push({ y: row.getBoundingClientRect().bottom, afterRowIndex: i });
      });
      for (let i = 0; i < boundaries.length; i++) {
        if (Math.abs(y - boundaries[i].y) <= TB_EDGE_PX) {
          rowInsertBubble.dataset.afterRowIndex = String(boundaries[i].afterRowIndex);
          rowInsertBubble.style.left = (tableRect.left - half) + 'px';
          rowInsertBubble.style.top = (boundaries[i].y - half) + 'px';
          rowInsertBubble.hidden = false;
          rowShown = true;
          break;
        }
      }
    }
    if (!rowShown) rowInsertBubble.hidden = true;
  }

  // ── Task 6: table edge-click menus (delete/align) + row drag-reorder ────
  // Clicking a column's grip handle (the horizontal 6-dot affordance shown
  // just above the column while hovering it — see the "Notion-style grip
  // handles" section below) selects the column: every th/td in it gets
  // '.ed-te-hl' and a floating menu (delete / align-cycle) appears. Clicking
  // a row's grip handle (the vertical 6-dot affordance shown at the row's
  // own left edge while hovering it) selects the row the same way, with a
  // delete-only menu — except on the HEADER row, whose grip click only
  // highlights (a header can never be deleted, so its menu would be empty;
  // see the header-grip branch in the pointerup handler below).
  // User-acceptance feedback on the ORIGINAL design (an
  // invisible TE_EDGE_PX=8 proximity zone hugging the table's raw top/left
  // pixel edge, with no visible affordance at all) was that it was
  // unusably small — pixel-hunting a click target with no visual cue. The
  // grips below are the fix: real, adequately-sized (≥18×24px) elements the
  // user can actually see and aim for. Both grips are overlay elements
  // `position: fixed`-appended to document.body — never DOM CHILDREN of a
  // contenteditable cell, even though the row grip's inner half visually
  // overlaps one (it straddles the table's left border; see the geometry
  // note in the "Notion-style row/column grip handles" section below). So —
  // unlike the old zones, which
  // sat INSIDE an already-permanently-contenteditable cell and needed the
  // delegated `pointerdown` listener below to preventDefault() there to
  // stop native caret placement from stealing the click — a grip's own
  // buildTableGrip()-installed `mousedown` preventDefault() is what keeps
  // focus put now (same "keep focus put" idiom buildTableInsertBubble()
  // documents for the hover-insert bubbles above).
  //
  // Row drag starts from the SAME row grip. EVERY row is draggable and every
  // row gets a grip, the header <tr> included (spec §3.10/§4.6: in markdown a
  // table's first row IS its header, so position alone decides header
  // identity — dragging a data row above the header PROMOTES it, and the old
  // header becomes a data row). EVERY row's grip — the header's included —
  // uses the SAME geometry: centred on the table's left border, vertically
  // centred on its own row. There is no per-row-type special case.
  //
  // After a small movement threshold (distinguishing "click to open the
  // menu" from "press-and-drag"), a drop-indicator line tracks the pointer
  // between rows — including an "above the header" boundary; releasing
  // performs a PURE MOVE via rebuildTableSections(), which re-lays the same
  // <tr>/<th>/<td> nodes across thead/tbody so whichever row ended up first
  // becomes the header row. That rebuild necessarily DETACHES the cell that
  // currently holds focus, so Chromium fires a synchronous focusout
  // mid-mutation — exactly the quirk tableBurstUndo()/tableBurstRedo()'s
  // innerHTML-snapshot restore has to guard. performRowDrop() therefore
  // wraps it in `suppressTableFocusout` (the third of the flag's four sites)
  // and puts focus back explicitly via restoreTableFocus(). An earlier
  // revision moved the <tr> with a plain `insertBefore()`, which reparents
  // in one synchronous step, never blurs, and needed no guard — the header
  // promotion requirement is what retired that. The menu's delete ops (which
  // DO remove nodes) sidestep the same hazard a different way — see
  // refocusAwayFromColumn()/refocusAwayFromRow() below.
  //
  // Both the menu (delete/align) and the drag's DOM move are burst
  // mutations: ensureTableBurstOpen() (Task 5, above) auto-starts a burst
  // on this table if none is open yet, then the op mutates the live DOM and
  // calls currentBurst.history.snap() — committed on table-leave like any
  // other table edit. Refusal banners reuse the exact wording the retired
  // Phase-2 click-select edit toolbar used for these same three guards (see
  // commit 0661cde, now dead code with zero call sites — this task is what
  // revives deleteRow()/deleteColumn()/cycleColumnAlign() unchanged, per
  // the brief's explicit "wire, don't rewrite"). This grip-based revision
  // keeps every one of those downstream primitives (menu building, delete/
  // align ops, drag-drop pointer machinery) UNCHANGED — only the "what
  // counts as a hit" question moved from raw geometry (hitTestEdgeZone(),
  // now retired) to hitTestGrip() (defined in the grip section below).
  const TE_DRAG_THRESHOLD_PX = 5; // pointer movement before a press becomes a drag
  const TE_MENU_GAP_PX = 6;

  // The column/row currently selected by the edge menu (or all-null when
  // closed) — read by the menu's own button handlers below, cleared by
  // hideTableEdgeMenu().
  let teMenuKind = null;    // 'col' | 'row' | null
  let teMenuTableEl = null;
  let teMenuColIndex = null; // meaningful only when teMenuKind === 'col'
  let teMenuRowEl = null;    // meaningful only when teMenuKind === 'row'
  // Elements currently wearing the '.ed-te-hl' highlight class — tracked so
  // clearEdgeHighlight() can strip it again without re-deriving the
  // (possibly now-stale, post-delete) column/row it came from.
  let teHighlightEls = [];

  function clearEdgeHighlight() {
    // classList.remove() leaves a dangling `class=""` behind on any element
    // the renderer/armEditables() emitted with NO class of its own — a
    // col-default cell in a table that was never armed — and
    // that residue is a real innerHTML diff that defeats resolveBurst()'s
    // zero-edit guard, canonically rewriting a table the user only
    // highlighted. Same fix cancelTeDrag()/the pointerup drag branch already
    // apply to the dragged row's own class — drop the attribute when it
    // goes empty, here too.
    teHighlightEls.forEach((el) => {
      el.classList.remove('ed-te-hl');
      if (!el.className) el.removeAttribute('class');
    });
    teHighlightEls = [];
  }

  function highlightColumn(tableEl, colIndex) {
    clearEdgeHighlight();
    allRowsOf(tableEl).forEach((row) => {
      const cell = row.cells[colIndex];
      if (cell) { cell.classList.add('ed-te-hl'); teHighlightEls.push(cell); }
    });
  }

  // S3 (Important): the class goes on the row's CELLS, exactly like
  // highlightColumn() above — never on the `<tr>`. A `<tr>` highlight paints
  // nothing the user can see: `th { background: #f6f8fa }` and the sticky
  // first column's `background: #ffffff` are painted by the CELLS, which sit
  // ABOVE the row box, and `!important` does not let a rule on one element
  // beat an opaque background painted by a different element on top of it.
  // The header row (all-`<th>`) rendered as ZERO pixels changed, and the
  // body-row case lost its first cell to the sticky rule for the same
  // reason — while the Esc gate below still counted that invisible state as
  // "a selection is open" and ate the user's next Escape.
  function highlightRow(rowEl) {
    clearEdgeHighlight();
    Array.prototype.slice.call(rowEl.cells).forEach((cell) => {
      cell.classList.add('ed-te-hl');
      teHighlightEls.push(cell);
    });
  }

  function hideTableEdgeMenu() {
    teEdgeMenu.hidden = true;
    clearEdgeHighlight();
    teMenuKind = null;
    teMenuTableEl = null;
    teMenuColIndex = null;
    teMenuRowEl = null;
  }

  // A single singleton floating menu (never one per column/row — same
  // Global Constraint the hover-insert bubbles above follow) whose two
  // buttons are relabeled/shown-or-hidden per teMenuKind by
  // showColumnMenu()/showRowMenu() below, rather than rebuilding it.
  function buildTeMenuButton(cls, label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ed-te-menu-btn ' + cls;
    b.textContent = label;
    // Same "keep the burst's focus intact across the click" idiom as
    // buildTableInsertBubble()'s own buttons above — see the section
    // comment for why this matters (and why the focusout handler below
    // ALSO excludes '.ed-te-menu' as belt-and-braces alongside this).
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }
  const teEdgeMenu = document.createElement('div');
  teEdgeMenu.className = 'ed-te-menu';
  teEdgeMenu.hidden = true;
  const teDeleteBtn = buildTeMenuButton('ed-te-menu-delete', '', async () => {
    if (teMenuKind === 'col') await runDeleteColumn();
    else if (teMenuKind === 'row') await runDeleteRow();
  });
  const teAlignBtn = buildTeMenuButton('ed-te-menu-align', '對齊', async () => { await runCycleAlign(); });
  teEdgeMenu.appendChild(teDeleteBtn);
  teEdgeMenu.appendChild(teAlignBtn);
  document.body.appendChild(teEdgeMenu);

  // Shows the menu at `(left, top)`, then (now that it's visible and
  // measurable) lets the caller shift it by its own real offsetWidth/
  // offsetHeight — a two-step "show, then measure, then reposition" dance
  // that avoids hardcoding the menu's size (which differs between the
  // column form — two buttons — and the row form — one).
  function positionTeMenu(left, top) {
    teEdgeMenu.style.left = left + 'px';
    teEdgeMenu.style.top = Math.max(0, top) + 'px';
    teEdgeMenu.hidden = false;
  }

  function showColumnMenu(tableEl, colIndex) {
    if (teMenuKind === 'col' && teMenuTableEl === tableEl && teMenuColIndex === colIndex) {
      hideTableEdgeMenu(); // re-clicking the same column's edge toggles the menu closed
      return;
    }
    teMenuKind = 'col';
    teMenuTableEl = tableEl;
    teMenuColIndex = colIndex;
    teMenuRowEl = null;
    teDeleteBtn.textContent = '刪除欄';
    teAlignBtn.hidden = false;
    highlightColumn(tableEl, colIndex);
    const headerRow = headerRowOf(tableEl);
    const cell = headerRow ? headerRow.cells[colIndex] : null;
    const r = (cell || tableEl).getBoundingClientRect();
    positionTeMenu(r.left, r.top);
    teEdgeMenu.style.top = (r.top - teEdgeMenu.offsetHeight - TE_MENU_GAP_PX) + 'px';
  }

  function showRowMenu(tableEl, rowEl) {
    if (teMenuKind === 'row' && teMenuTableEl === tableEl && teMenuRowEl === rowEl) {
      hideTableEdgeMenu(); // re-clicking the same row's edge toggles the menu closed
      return;
    }
    teMenuKind = 'row';
    teMenuTableEl = tableEl;
    teMenuRowEl = rowEl;
    teMenuColIndex = null;
    teDeleteBtn.textContent = '刪除列';
    teAlignBtn.hidden = true;
    highlightRow(rowEl);
    const r = rowEl.getBoundingClientRect();
    const tableRect = tableEl.getBoundingClientRect();
    positionTeMenu(tableRect.left, r.top);
    teEdgeMenu.style.left = (tableRect.left - teEdgeMenu.offsetWidth - TE_MENU_GAP_PX) + 'px';
  }

  // Moves `currentBurst.activeCellEl` to a cell that will SURVIVE deleting
  // `colIndex` — called BEFORE deleteColumn() so the removal never touches
  // the currently-focused node in the first place. A plain .focus() call
  // here fires a focusout+focusin pair that both resolve to cells inside
  // the SAME table — the delegated focusout handler's `stillInTable` check
  // (relatedTarget still inside tableEl) already treats that as a normal
  // in-burst cell move, not "left the table" — so this needs no
  // suppressTableFocusout: unlike tableBurstUndo()/Redo()'s innerHTML-
  // snapshot restore, nothing here ever detaches the currently-focused node
  // WHILE it's still focused.
  function refocusAwayFromColumn(tableEl, colIndex) {
    const burst = currentBurst;
    if (!burst || !burst.activeCellEl || !document.body.contains(burst.activeCellEl)) return;
    if (colIndexOf(burst.activeCellEl) !== colIndex) return;
    const row = burst.activeCellEl.parentElement;
    const alt = row.cells[colIndex === 0 ? 1 : 0];
    if (alt) { alt.focus(); placeCaretAtEnd(alt); }
  }

  // Mirrors refocusAwayFromColumn() for a doomed ROW: picks the previous
  // row (or the next one, for row index 0) at the same column index — always
  // safe to assume one exists, since deleteRow() is only ever reached after
  // the header/last-body-row refusal checks in runDeleteRow() below have
  // already passed.
  function refocusAwayFromRow(tableEl, rowEl) {
    const burst = currentBurst;
    if (!burst || !burst.activeCellEl || !document.body.contains(burst.activeCellEl)) return;
    if (burst.activeCellEl.parentElement !== rowEl) return;
    const rows = allRowsOf(tableEl);
    const idx = rows.indexOf(rowEl);
    const altRow = idx <= 0 ? rows[1] : rows[idx - 1];
    if (!altRow) return;
    const colIdx = colIndexOf(burst.activeCellEl);
    const alt = altRow.cells[colIdx] || altRow.cells[0];
    if (alt) { alt.focus(); placeCaretAtEnd(alt); }
  }

  async function runDeleteColumn() {
    const tableEl = teMenuTableEl;
    const colIndex = teMenuColIndex;
    if (!tableEl || colIndex == null) return;
    // Final-review Finding 6: use the LIVE table (a dirty burst on a
    // DIFFERENT block may have just committed inside ensureTableBurstOpen(),
    // swapping `.content` and detaching `tableEl`) — column index is a
    // plain integer, stable across that swap, so only the element itself
    // needs re-resolving.
    const liveTableEl = await ensureTableBurstOpen(tableEl);
    if (!liveTableEl) return;
    const headerRow = headerRowOf(liveTableEl);
    if (!headerRow || headerRow.cells.length <= 1) {
      showBanner('無法刪除最後一欄', null, null);
      return;
    }
    refocusAwayFromColumn(liveTableEl, colIndex);
    deleteColumn(liveTableEl, colIndex);
    currentBurst.history.snap('delete-col');
    hideTableEdgeMenu();
  }

  async function runDeleteRow() {
    const tableEl = teMenuTableEl;
    const rowEl = teMenuRowEl;
    if (!tableEl || !rowEl) return;
    // Final-review Finding 6: `rowEl` is a DOM node, not an index — capture
    // its ORDINAL position in the (still-live-at-this-point) table BEFORE
    // ensureTableBurstOpen() can possibly commit a different block's dirty
    // burst and swap `.content` out from under it, then re-locate the row
    // at that same position in the LIVE table afterward. A plain
    // `document.body.contains(rowEl)` check can't recover from this the
    // way it can for a stable index — the row must be re-found by where it
    // WAS, not by its (now-stale) identity.
    const rowIndex = allRowsOf(tableEl).indexOf(rowEl);
    const liveTableEl = await ensureTableBurstOpen(tableEl);
    if (!liveTableEl) return;
    const liveRowEl = rowIndex >= 0 ? allRowsOf(liveTableEl)[rowIndex] : null;
    if (!liveRowEl) return;
    if (liveRowEl === headerRowOf(liveTableEl)) {
      showBanner('無法刪除標題列', null, null);
      return;
    }
    if (bodyRowsOf(liveTableEl).length <= 1) {
      showBanner('無法刪除最後一列', null, null);
      return;
    }
    refocusAwayFromRow(liveTableEl, liveRowEl);
    deleteRow(liveRowEl);
    currentBurst.history.snap('delete-row');
    hideTableEdgeMenu();
  }

  async function runCycleAlign() {
    const tableEl = teMenuTableEl;
    const colIndex = teMenuColIndex;
    if (!tableEl || colIndex == null) return;
    // Final-review Finding 6: same live-table swap as runDeleteColumn() above.
    const liveTableEl = await ensureTableBurstOpen(tableEl);
    if (!liveTableEl) return;
    cycleColumnAlign(liveTableEl, colIndex);
    currentBurst.history.snap('align-col');
    // Stays open (unlike delete): repeated clicks keep cycling. The
    // column's cells are the SAME nodes (cycleColumnAlign() only touches
    // the `style` attribute) so the existing highlight is still valid —
    // nothing to reposition/rehighlight.
  }

  // ── Notion-style row/column grip handles ─────────────────────────────
  // Two singleton overlay elements — same "one shared node, repositioned
  // via getBoundingClientRect(), never one per row/column" Global Constraint
  // the hover-insert bubbles above follow. `rowGrip` is a vertical 6-dot
  // handle shown at the LEFT EDGE of whichever row the pointer is currently
  // hovering any cell of — EVERY row, the header included (spec §3.10: the
  // header is draggable too, since position alone decides header identity;
  // only its CLICK differs, highlighting instead of opening the
  // delete-only menu) — positioned identically on every row, header
  // included; `colGrip` is a horizontal 6-dot handle
  // shown just ABOVE whichever column the pointer is hovering (every
  // column, header included — the column menu's delete/align both apply to
  // header cells too). Built once by buildTableGrip() below and driven by
  // updateTableEdgeGrips(), called from the SAME rAF-throttled mousemove
  // listener (wired near the bottom of this file) that already drives
  // updateTableInsertBubbles() — see its own comment for the coalescing
  // contract this reuses.
  // Review fix (P0-a) + user acceptance (uniform geometry): neither grip is
  // separated from the table, and both use the SAME rule — the grip's own
  // CENTRELINE coincides with the table border it belongs to, so its hit
  // rect straddles that border by half its own size on each side. COLUMN
  // grip: centred on the table's TOP edge. ROW grip: centred on the table's
  // LEFT edge. An earlier revision insetted the row grip fully INSIDE the
  // table to dodge the block's own gutter ⠿; that was reverted — the ⠿
  // occupies only the block's top ~20px while a row grip sits at its own
  // row's mid-height, so the two never actually intersect, and the inset put
  // the grip on top of the first cell's TEXT (user-acceptance defect). The
  // gutter is given its own room in CSS instead (`.content { padding-left }`
  // plus `.ed-handle/.ed-insert { left: -36px }`, both edit-mode-only — see
  // lib/md2doc.js), so the straddling grip reaches only into the first
  // cell's PADDING, never its text.
  // Either way the grip's hit rect DOES overlap the insert bubble's hit
  // rect (the bubble extends TB_BUBBLE_SIZE/2 = 9px past the edge on its
  // own axis). Non-intersection via rect separation is no longer possible
  // or required. Instead, "insert-bubble click is never eaten by the grip"
  // is maintained by z-index ordering: .ed-te-grip-row/.ed-te-grip-col
  // carry z-index:7 (these rulesets come after .ed-te-grip's z-index:9 in
  // source-order with equal specificity, so the later value wins), which
  // is below the bubble's z-index:8. The browser's hit-test therefore
  // awards a click at the overlap corner to the BUBBLE, not the grip,
  // even though their rects overlap.
  // test/editor-client-runtime.test.js's "table grip/bubble click priority"
  // scenario asserts this via document.elementFromPoint() at the exact
  // reported overlap corner AND verifies the z-index ordering directly —
  // re-verify it if either the grip's or bubble's z-index ever changes.

  function buildTableGrip(cls, ariaLabel) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ed-te-grip ' + cls;
    b.setAttribute('aria-label', ariaLabel);
    for (let i = 0; i < 6; i++) {
      const dot = document.createElement('span');
      dot.className = 'ed-te-grip-dot';
      b.appendChild(dot);
    }
    b.hidden = true;
    // Same "keep the burst's focus/selection intact across the click" idiom
    // buildTableInsertBubble() above documents — without this, the grip
    // (a document.body child, never a descendant of the table it is pinned
    // to, however far inside the table's own edge it is drawn) stealing
    // focus on mousedown would fire a focusout on the currently-focused
    // cell BEFORE this gesture's own `pointerdown` handler below even runs.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    document.body.appendChild(b);
    return b;
  }
  const rowGrip = buildTableGrip('ed-te-grip-row', '列選項 / 拖曳排序');
  const colGrip = buildTableGrip('ed-te-grip-col', '欄選項 / 拖曳排序');

  // Which table/row/column the two grips are CURRENTLY pinned to — updated
  // by updateTableEdgeGrips() below, read back by hitTestGrip() at
  // pointerdown time. `gripRowEl` is a live DOM reference (read
  // synchronously, at the moment of the click/press that follows the hover
  // that set it — no staleness window); `gripColIndex` is a plain ordinal
  // integer, same "stable across a live-table swap" reasoning
  // runDeleteColumn() etc. above already rely on for column indices.
  let gripRowTableEl = null;
  let gripRowEl = null;
  let gripColTableEl = null;
  let gripColIndex = null;

  function hideTableGrips() {
    rowGrip.hidden = true;
    colGrip.hidden = true;
    // Task 8 fix round 1 (Minor 4): clear BOTH grips' dragging visual — a
    // row and a column can each wear `ed-te-grip-dragging` mid-drag, and
    // this is reachable while one is in flight (e.g. a burst resolution
    // calling hideTableGrips() mid-gesture), so leaving colGrip out was
    // exactly the row/col asymmetry this task exists to remove.
    rowGrip.classList.remove('ed-te-grip-dragging');
    colGrip.classList.remove('ed-te-grip-dragging');
    gripRowTableEl = null;
    gripRowEl = null;
    gripColTableEl = null;
    gripColIndex = null;
  }

  // Bug fix (user acceptance) — history: grips were originally BOTH
  // border-straddling (P0-a), and were visible on hover but UNREACHABLE by a
  // real pointer. Root cause — a pointer travelling from inside a cell
  // toward a grip necessarily crossed a ~10px corridor OUTSIDE the table's
  // border on the way (the grip's own left/top half). The naive hit test
  // below ("on a cell, or hide") hid the grip the instant the pointer left
  // the table/cell — BEFORE it ever reached the grip — so only a
  // teleporting click (every existing test used pressReleaseAt()/
  // gripCenter(), which jump straight to the grip's own coordinates) could
  // ever land on it; a real mouse gesture could not.
  //
  // Current geometry (uniform, both axes): BOTH grips straddle their own
  // table border — the row grip half outside / half inside the table's LEFT
  // border, the column grip half above / half below its TOP border. So the
  // corridor-crossing bug described above applies to BOTH of them exactly as
  // originally described, and both keep-zones below cover the corresponding
  // outside-the-border corridor.
  //
  // Review fix (Important, first pass over-permissive): the first version of
  // this fix kept a grip visible while the pointer was ANYWHERE within the
  // table's rect expanded by the grip's own footprint — i.e. along the
  // table's FULL height/width, not just near the row/column the grip is
  // actually anchored to. On a tall table, hovering row 1 then moving the
  // pointer to the left margin at row 10's height (far below row 1's grip,
  // reviewer live-reproduced) kept row 1's grip visible at its now-stale
  // position instead of hiding it. Fixed by gating the keep-zone on the
  // SPECIFIC shown grip's own anchor (pointInRowGripZone()/
  // pointInColGripZone() below) instead of the whole table.
  //
  // What each keep-zone covers TODAY: both keep the ORIGINAL corridor shape,
  // mirrored per axis. pointInRowGripZone() is the union of (the row grip's
  // own rect, padded by TE_GRIP_ZONE_PAD_PX for sub-pixel rounding) and (the
  // straight strip between the grip's own LEFT edge and the table's LEFT
  // border, y clamped to the anchor ROW's own vertical extent, padded).
  // pointInColGripZone() is the same with the axes swapped: the strip
  // between the grip's own top edge and the table's top border, x clamped to
  // the anchor COLUMN's own horizontal extent, padded.
  // A pointer outside either grip's own zone is a genuine exit and still
  // hides the grip via hideTableGrips(), same as before. Neither fix touches
  // either grip's size or z-index, so the click-priority guarantee (bubble
  // z-index:8 > grip z-index:7 — see the comment above buildTableGrip())
  // is unaffected — this only changes how long an already-shown grip STAYS
  // visible, never where it sits. See
  // test/editor-client-runtime.test.js's "grip reachability by a REAL
  // (non-teleporting) pointer" scenario (positive case) and "grip hover
  // corridor is anchored to its own row, not the whole table" (the
  // reviewer's negative-case repro).
  const TE_GRIP_ZONE_PAD_PX = 4; // sub-pixel-rounding slack around a grip's own rect / its anchor row/column extent

  function pointInPaddedRect(x, y, rect, pad) {
    return x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad;
  }

  function pointInRowGripZone(x, y) {
    if (rowGrip.hidden || !gripRowTableEl || !gripRowEl ||
      !document.body.contains(gripRowEl) || !document.body.contains(gripRowTableEl)) return false;
    const gr = rowGrip.getBoundingClientRect();
    if (pointInPaddedRect(x, y, gr, TE_GRIP_ZONE_PAD_PX)) return true;
    // grip 跨在表格左邊界上，所以「從儲存格走向 grip」必定經過邊界外側的
    // 那半個 grip 寬度。走廊＝從 grip 自己的左緣到表格左緣，垂直方向夾在
    // 所錨定那一列的上下緣（加 TE_GRIP_ZONE_PAD_PX 的次像素寬容）。
    const rowRect = gripRowEl.getBoundingClientRect();
    const tableRect = gripRowTableEl.getBoundingClientRect();
    return x >= gr.left && x <= tableRect.left &&
      y >= rowRect.top - TE_GRIP_ZONE_PAD_PX && y <= rowRect.bottom + TE_GRIP_ZONE_PAD_PX;
  }

  function pointInColGripZone(x, y) {
    if (colGrip.hidden || !gripColTableEl || gripColIndex == null ||
      !document.body.contains(gripColTableEl)) return false;
    const gc = colGrip.getBoundingClientRect();
    if (pointInPaddedRect(x, y, gc, TE_GRIP_ZONE_PAD_PX)) return true;
    // Same header-cell-first, hovered-cell-fallback basis
    // updateTableEdgeGrips() itself positions the column grip against — see
    // its own comment for why (every WYSIWYG-armed table has a header in
    // practice; defensive only).
    const headerRow = headerRowOf(gripColTableEl);
    const anchorCell = headerRow ? headerRow.cells[gripColIndex] : null;
    if (!anchorCell) return false;
    const tableRect = gripColTableEl.getBoundingClientRect();
    const cellRect = anchorCell.getBoundingClientRect();
    return y >= gc.top && y <= tableRect.top &&
      x >= cellRect.left - TE_GRIP_ZONE_PAD_PX && x <= cellRect.right + TE_GRIP_ZONE_PAD_PX;
  }

  // Recomputes grip visibility/position from the latest throttled pointer
  // coordinates — called from the mousemove listener wired near the bottom
  // of this file. `target` is whatever element was directly under the
  // pointer (Event#target) at those coordinates, same contract
  // updateTableInsertBubbles() above uses.
  function updateTableEdgeGrips(x, y, target) {
    // Both grips are `position: fixed` overlays appended to document.body
    // (same as the hover-insert bubbles) rather than descendants of the
    // table — both PAINT half outside it (the column grip straddling the top
    // border, the row grip straddling the left border). So the moment the
    // real pointer crosses from a cell onto
    // the grip itself, `target` is the grip and is no
    // longer inside any '.ed-block[data-block-type="table"]' or 'th, td'.
    // Without this guard, that transition would hit the "nothing found"
    // branches below and hide the very grip the pointer just moved onto —
    // pulling it out from under a user trying to click/press it. Leave
    // whatever was last shown untouched instead; hideTableGrips() (called
    // from table-leave, burst-end, and drag-start elsewhere) already covers
    // every path that actually needs to clear it.
    if (target && target.closest && (target.closest('.ed-te-grip-row') || target.closest('.ed-te-grip-col'))) return;
    const blockEl = target && target.closest && target.closest('.ed-block[data-block-type="table"]');
    const tableEl = blockEl ? blockContentEl(blockEl) : null;
    const cellEl = (tableEl && target && target.closest) ? target.closest('th, td') : null;
    const onValidCell = !!(tableEl && tableEl.classList.contains('ed-wys-table') && cellEl && tableEl.contains(cellEl));
    if (!onValidCell) {
      // Not directly over a table cell — either the pointer genuinely left
      // the table, or (the bug fixed above) it is travelling through the
      // corridor toward a grip that's already shown, anchored to ITS OWN
      // row/column only (see pointInRowGripZone()/pointInColGripZone()'s own
      // comment for why not the whole table). Keep that grip up while still
      // in its zone; only actually hide once the pointer has left both
      // zones entirely.
      if (pointInRowGripZone(x, y) || pointInColGripZone(x, y)) return;
      hideTableGrips();
      return;
    }

    const tableRect = tableEl.getBoundingClientRect();
    const rowEl = cellEl.parentElement;
    const headerRow = headerRowOf(tableEl);
    const colIndex = colIndexOf(cellEl);

    // Row grip: every row, including the header — the first row of a
    // markdown table IS the header, so any row must be draggable to the
    // top to become it. ONE position rule for all of them (user acceptance:
    // 「grip 位置都一樣」) — centred on the table's left border, vertically
    // centred on its own row; no header special case. The
    // one exception is a header-only table (no body rows): its single row
    // is thead's only row, and dragging it away would empty the thead —
    // serializeTable() would degrade it and the user's table would vanish
    // from the page. Withhold the grip there instead.
    if (rowEl && (rowEl !== headerRow || bodyRowsOf(tableEl).length > 0)) {
      gripRowTableEl = tableEl;
      gripRowEl = rowEl;
      const r = rowEl.getBoundingClientRect();
      // Fallback dims match .ed-te-grip-row's own CSS width/height exactly
      // (20x28) — offsetWidth/Height read 0 while `hidden` (display: none)
      // is still true on the FIRST show of a hover session, before the
      // `hidden = false` assignment below takes effect.
      const gw = rowGrip.offsetWidth || 20;
      const gh = rowGrip.offsetHeight || 28;
      rowGrip.style.left = (tableRect.left - gw / 2) + 'px';
      rowGrip.style.top = (r.top + r.height / 2 - gh / 2) + 'px';
      rowGrip.hidden = false;
    } else {
      gripRowTableEl = null;
      gripRowEl = null;
      rowGrip.hidden = true;
    }

    // Column grip: every column, positioned against the HEADER cell's own
    // span (falling back to the hovered cell's own span if the table has no
    // header — defensive; every WYSIWYG-armed table has one in practice).
    gripColTableEl = tableEl;
    gripColIndex = colIndex;
    const headerCell = headerRow ? headerRow.cells[colIndex] : null;
    const cr = (headerCell || cellEl).getBoundingClientRect();
    // Fallback dims match .ed-te-grip-col's own CSS width/height (28x24) —
    // same first-show-while-still-hidden reasoning as the row grip above.
    const cgh = colGrip.offsetHeight || 24;
    const cgw = colGrip.offsetWidth || 28;
    colGrip.style.left = (cr.left + cr.width / 2 - cgw / 2) + 'px';
    colGrip.style.top = (tableRect.top - cgh / 2) + 'px';
    colGrip.hidden = false;
  }

  // Whether the pointer landed on a grip at pointerdown — replaces the
  // retired hitTestEdgeZone()'s pixel-proximity geometry with a simple "is
  // the target one of the two grip elements" check, returning the exact
  // same shape ({kind, tableEl, colIndex} or {kind, tableEl, rowEl,
  // isHeader}) hitTestEdgeZone() used to, so every downstream consumer
  // below (the drag-threshold check, showColumnMenu()/showRowMenu(),
  // performRowDrop()) needed NO changes.
  function hitTestGrip(target) {
    if (!target || !target.closest) return null;
    if (target.closest('.ed-te-grip-row')) {
      if (!gripRowTableEl || !gripRowEl || !document.body.contains(gripRowEl)) return null;
      return { kind: 'row', tableEl: gripRowTableEl, rowEl: gripRowEl,
        isHeader: gripRowEl === headerRowOf(gripRowTableEl) };
    }
    if (target.closest('.ed-te-grip-col')) {
      // The `document.body.contains()` detach check mirrors the row branch
      // above: the two axes are symmetric gestures now (Task 8 gave the
      // column its own drag), so a stale `gripColTableEl` left pointing at a
      // table that a rerenderAll()/burst-resolution already swapped out must
      // fail the hit-test rather than hand a detached node to performColDrop().
      if (!gripColTableEl || gripColIndex == null || !document.body.contains(gripColTableEl)) return null;
      return { kind: 'col', tableEl: gripColTableEl, colIndex: gripColIndex };
    }
    return null;
  }

  // The singleton drop-indicator line shown while dragging a row (never one
  // per boundary — same Global Constraint as the hover-insert bubbles /
  // edge menu above).
  const teDropIndicator = document.createElement('div');
  teDropIndicator.className = 'ed-te-drop-indicator';
  teDropIndicator.hidden = true;
  document.body.appendChild(teDropIndicator);

  // Nearest row-drop target for `clientY` — a discriminated union:
  // {mode:'above-header', y} | {mode:'before-row', rowIndex, y} |
  // {mode:'append', y}. `rowIndex` is an ordinal into allRowsOf(). The
  // header row is now itself a candidate boundary (spec §4.6: the first row
  // of a markdown table IS its header, so promoting any row to first place
  // has to go through an explicit "above the header" target) — `<=` on the
  // header's own midline gives "released exactly on the header's centre" an
  // unambiguous home in `above-header` rather than leaving it to float
  // between two branches.
  //
  // spec §4.6：`<=` 讓「釋放點恰在表頭正中央」有明確歸屬（above-header）。
  // 既有那條綠測試釋放在表頭列的 bottom，落在 FALSE 側，仍走下面的
  // body 中線鏈、仍得 3,1,2，因此不需要改它的期望值。
  function nearestRowDropTarget(tableEl, clientY) {
    const headerRow = headerRowOf(tableEl);
    if (headerRow) {
      const hr = headerRow.getBoundingClientRect();
      if (clientY <= hr.top + hr.height / 2) return { mode: 'above-header', y: hr.top };
    }
    const all = allRowsOf(tableEl);
    const rows = bodyRowsOf(tableEl);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) {
        return { mode: 'before-row', rowIndex: all.indexOf(rows[i]), y: r.top };
      }
    }
    const last = rows[rows.length - 1];
    const y = last ? last.getBoundingClientRect().bottom
      : (headerRow ? headerRow.getBoundingClientRect().bottom : tableEl.getBoundingClientRect().top);
    return { mode: 'append', y };
  }

  // The in-flight edge-zone pointer gesture (press-then-either-click-or-
  // drag), or null between gestures. `hit` is whatever hitTestGrip()
  // returned at pointerdown; `dragging` flips true once TE_DRAG_THRESHOLD_PX
  // is crossed (row zones only — see the pointermove listener below);
  // `dropTarget` is filled in by updateDropIndicator() as the pointer
  // moves while dragging (the nearestRowDropTarget() union — see its own
  // comment above). `pointerId`/`captureEl` back the pointer-capture
  // review fix below — see cancelTeDrag()'s comment for why this gesture
  // needs it at all.
  let tePointer = null;

  function updateDropIndicator(clientY) {
    const tableEl = tePointer.hit.tableEl;
    const target = nearestRowDropTarget(tableEl, clientY);
    tePointer.dropTarget = target;
    const tableRect = tableEl.getBoundingClientRect();
    teDropIndicator.style.left = tableRect.left + 'px';
    teDropIndicator.style.width = tableRect.width + 'px';
    teDropIndicator.style.top = (target.y - 1) + 'px';
    // The indicator is a shared singleton with the COLUMN drop indicator
    // (updateColDropIndicator() below), which drives a vertical line and
    // therefore sets `height` itself — a row drag must write its own back
    // every time or a prior column drag's height would leak into this one.
    teDropIndicator.style.height = '3px';
  }

  // Column-drop counterpart of updateDropIndicator() above: a vertical line
  // spanning the table's full height at the nearest column boundary, rather
  // than a horizontal line spanning its width.
  function updateColDropIndicator(clientX) {
    const tableEl = tePointer.hit.tableEl;
    const target = nearestColDropTarget(tableEl, clientX);
    tePointer.dropTarget = target;
    const tableRect = tableEl.getBoundingClientRect();
    teDropIndicator.style.left = (target.x - 1) + 'px';
    teDropIndicator.style.width = '3px';
    teDropIndicator.style.top = tableRect.top + 'px';
    teDropIndicator.style.height = tableRect.height + 'px';
  }

  // Review fix (Critical): best-effort releasePointerCapture() — a no-op
  // (wrapped in try/catch) when the browser already auto-released it (the
  // normal case on a clean pointerup/pointercancel) or `captureEl` got
  // detached from the document in the meantime (e.g. a burst resolution
  // mid-gesture). Shared by cancelTeDrag() and the pointerup handler below
  // so capture is released on every exit path, not just the happy one.
  function releaseTeCapture(st) {
    if (st && st.captureEl && typeof st.captureEl.releasePointerCapture === 'function') {
      try { st.captureEl.releasePointerCapture(st.pointerId); } catch (err) { /* already released/detached — fine */ }
    }
  }

  // Unconditional cleanup of the in-flight edge-zone gesture — called from
  // FIVE places: Esc-during-drag (a distinct gesture from Esc-reverts-burst
  // — see handleTableCellKeydown() above, which owns Escape for a focused
  // cell; the global keydown listener below intercepts Escape BEFORE that
  // branch whenever a drag is actually in flight), the new `pointercancel`
  // and window `blur` listeners below (review fix, Critical — see their own
  // comments), a DEFENSIVE clear at the top of the `pointerdown` listener
  // below (in case a PRIOR gesture's pointerup/pointercancel never reached
  // us at all — same hazard), and every table-burst-end path above
  // (rerenderAll()/resolveBurst()/revertTableBurstAndEnd()/
  // tableBurstUndo()/tableBurstRedo()).
  //
  // Review fix (Important): the null-out is unconditional on `tePointer`
  // being set — NOT gated on `.dragging` (the original bug: a burst
  // resolution landing during the pressed-but-pre-threshold window used to
  // leave `tePointer` referencing a row/table that innerHTML/rerenderAll()
  // was about to detach, since this returned early for a non-dragging
  // gesture). No mutation ever happens here either way — a pre-threshold
  // press never moved the row, and an in-flight drag only ever moved the
  // INDICATOR line, never the row itself (see performRowDrop(), the only
  // place that actually calls insertBefore()) — so there's nothing to
  // revert regardless of which state this was called from.
  function cancelTeDrag() {
    if (!tePointer) return;
    releaseTeCapture(tePointer);
    if (tePointer.dragging && tePointer.hit && tePointer.hit.rowEl) {
      const draggedRowEl = tePointer.hit.rowEl;
      draggedRowEl.classList.remove('ed-te-row-dragging');
      // classList.add() CREATED the attribute on a renderer-emitted `<tr>`
      // (marked's table renderer emits rows with no class at all), and
      // classList.remove() leaves `class=""` behind rather than dropping
      // it. That residue is a real innerHTML diff, so resolveBurst()'s
      // zero-edit guard (`burst.editEl.innerHTML === burst.original`) would
      // see "edited" for a gesture that changed nothing and canonically
      // rewrite a hand-padded table. Drop the attribute when it went empty.
      if (!draggedRowEl.className) draggedRowEl.removeAttribute('class');
    }
    // Either grip may still be wearing its "active drag handle" visual (see
    // the pointermove listener below) — strip both unconditionally, same
    // belt-and-braces reasoning as the `ed-te-row-dragging` removal above.
    rowGrip.classList.remove('ed-te-grip-dragging');
    colGrip.classList.remove('ed-te-grip-dragging');
    teDropIndicator.hidden = true;
    tePointer = null;
  }

  // 對齊是**欄**屬性（分隔列由表頭 cells 的 style 合成），所以重建前先讀
  // 出來、重建後套回新的表頭列。只在 align 非 null 時寫，否則會把原本
  // 沒有 style 的欄寫成 ':---'（spec §4.6 的 attribute-byte 冪等要求）。
  function columnAlignsOf(tableEl) {
    const headerRow = headerRowOf(tableEl);
    if (!headerRow) return [];
    return Array.prototype.slice.call(headerRow.cells).map(cellStyleAlign);
  }

  // TH ↔ TD 改名。tag 已經正確就原樣返回——**不重造**，否則屬性落地順序
  // 會與 armEditables() 不同，innerHTML 隨之改變，於是「原地放回」也會
  // 被 zero-edit guard 判定為有編輯而 commit（整表 canonical 重寫）。
  //
  // 需要重造時，屬性一律照 cell.attributes 的**原順序**逐一複製，不做任何
  // 特例、也不對「當初是怎麼 arm 的」做任何假設：重造出來的 cell 屬性序列
  // 與原本那顆逐字相同，byte-identity 要的就只是這個。
  //
  // 之所以不能寫死順序（連「contenteditable 一律擺最後」都不行）：arm 當下
  // 的順序**逐欄不同**，取決於 classifyColumns()（lib/md2doc.js）給那一欄的
  // 等級。col-narrow / col-prose 的 cell renderer 會給 class，armEditables()
  // 再把 contenteditable 接在後面 → `class, style, contenteditable`；但
  // col-default 的 cell renderer **完全不給 class**，於是
  // setAttribute('contenteditable') 先落地、classList.add('ed-wys-cell') 才
  // 把 class 建出來 → `style, contenteditable, class`。任何固定順序都會弄壞
  // 其中一種，讓「拖下去再拖回來」列序還原、位元卻沒還原，觸發整表
  // canonical 重寫。逐字複製對三種等級同時成立。
  function retagCell(cell, tagName) {
    if (cell.nodeName === tagName) return cell;
    const next = document.createElement(tagName.toLowerCase());
    Array.prototype.slice.call(cell.attributes).forEach((attr) => {
      next.setAttribute(attr.name, attr.value);
    });
    while (cell.firstChild) next.appendChild(cell.firstChild);
    cell.parentElement.replaceChild(next, cell);
    return next;
  }

  // 依 orderedRows 重建 thead/tbody：第一列進 thead（cells 轉 th），其餘
  // 進 tbody（cells 轉 td）。不變式「thead 恰有一列」由此保證。
  function rebuildTableSections(tableEl, orderedRows, aligns) {
    const thead = tableEl.tHead;
    const tbody = tableEl.tBodies[0];
    if (!thead || !tbody || orderedRows.length === 0) return;
    orderedRows.forEach((row, i) => {
      const wantTag = i === 0 ? 'TH' : 'TD';
      Array.prototype.slice.call(row.cells).forEach((cell) => retagCell(cell, wantTag));
      (i === 0 ? thead : tbody).appendChild(row);
    });
    const newHeader = orderedRows[0];
    aligns.forEach((align, i) => {
      const cell = newHeader.cells[i];
      if (cell && align) cell.setAttribute('style', 'text-align:' + align);
    });
  }

  // 重建必然 detach 持有焦點的儲存格；focusout 被 suppressTableFocusout
  // 吃掉之後沒有人會把焦點放回去，document.activeElement 會落到 <body>，
  // 於是 keydown 走不到 handleTableCellKeydown，Ctrl+Z 會落到全域 undo()
  // 而先 commit 再退。用序位重新解析目標格並真的 focus。
  function restoreTableFocus(tableEl, cellIndex) {
    const cells = tableCellsOf(tableEl);
    const cell = cells[cellIndex >= 0 ? Math.min(cellIndex, cells.length - 1) : 0];
    if (!cell) return;
    if (currentBurst && currentBurst.blockType === 'table') currentBurst.activeCellEl = cell;
    selToolbarEditEl = cell;
    cell.focus();
    placeCaretAtEnd(cell);
  }

  async function performRowDrop(tableEl, rowEl, dropTarget) {
    // rowEl/dropTarget 都是 pointerdown/拖曳期間抓的；ensureTableBurstOpen()
    // 可能 resolve 掉別的 block 的 dirty burst 並換掉整片 .content，所以
    // 先轉成 allRowsOf() 的 ordinal，之後在 live table 上重新定位。
    const rowIndex = allRowsOf(tableEl).indexOf(rowEl);
    const liveTableEl = await ensureTableBurstOpen(tableEl);
    if (!liveTableEl) return;
    const liveRows = allRowsOf(liveTableEl);
    if (rowIndex < 0 || !liveRows[rowIndex]) return;

    let toIndex;
    if (dropTarget.mode === 'above-header') toIndex = 0;
    else if (dropTarget.mode === 'append') toIndex = liveRows.length;
    else toIndex = dropTarget.rowIndex;

    const order = liveRows.slice();
    const moved = order.splice(rowIndex, 1)[0];
    order.splice(toIndex > rowIndex ? toIndex - 1 : toIndex, 0, moved);
    if (order.every((row, i) => row === liveRows[i])) return; // 原地放回：不動 DOM、不 snap

    const aligns = columnAlignsOf(liveTableEl);
    const activeIndex = (currentBurst && currentBurst.activeCellEl)
      ? tableCellsOf(liveTableEl).indexOf(currentBurst.activeCellEl) : -1;
    suppressTableFocusout = true;
    try {
      rebuildTableSections(liveTableEl, order, aligns);
    } finally {
      suppressTableFocusout = false;
    }
    armNewTableCells(liveTableEl);
    restoreTableFocus(liveTableEl, activeIndex);
    // 插入路徑早就這樣做了，drop 路徑一直沒有：不清的話 grip 還釘在舊
    // 座標、teMenuColIndex 指向已經換位的欄。
    hideTableGrips();
    hideTableEdgeMenu();
    // 一律 snap（去重交給 history 自己）。舊碼用 nextSibling 比對判斷
    // 「有沒有動」，對「第一列與唯一 body 列對調」永遠回 false。
    currentBurst.history.snap('drag-row');
  }

  // 欄落點：以表頭各 cell 的中線決定要插到哪個 ordinal 之前。
  function nearestColDropTarget(tableEl, clientX) {
    const headerRow = headerRowOf(tableEl);
    if (!headerRow) return { index: 0, x: tableEl.getBoundingClientRect().left };
    const cells = Array.prototype.slice.call(headerRow.cells);
    for (let i = 0; i < cells.length; i++) {
      const r = cells[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return { index: i, x: r.left };
    }
    const last = cells[cells.length - 1].getBoundingClientRect();
    return { index: cells.length, x: last.right };
  }

  // <colgroup> 決定欄寬，且編輯器至今從沒碰過它；不跟著搬的話欄寬會錯位，
  // 而 table-md.js 不看 colgroup ⇒ 純 markdown 斷言抓不到這個 bug。
  function reorderColgroup(tableEl, fromIndex, toIndex) {
    const cg = tableEl.querySelector('colgroup');
    if (!cg) return;
    const cols = Array.prototype.slice.call(cg.children);
    if (!cols[fromIndex]) return;
    const moved = cols.splice(fromIndex, 1)[0];
    cols.splice(toIndex > fromIndex ? toIndex - 1 : toIndex, 0, moved);
    cols.forEach((c) => cg.appendChild(c));
  }

  async function performColDrop(tableEl, fromIndex, toIndex) {
    const liveTableEl = await ensureTableBurstOpen(tableEl);
    if (!liveTableEl) return;
    if (toIndex === fromIndex || toIndex === fromIndex + 1) return; // 原地放回
    const activeIndex = (currentBurst && currentBurst.activeCellEl)
      ? tableCellsOf(liveTableEl).indexOf(currentBurst.activeCellEl) : -1;
    // 短列必須讓整個操作放棄，不能只跳過那一列（final review M4）：原本
    // `if (!moved) return;` 在 forEach 裡面，短列會被略過、其他列照搬 —— 結果
    // 是欄位彼此錯位，而每一列的 cell 數量都跟原本一樣，ragged-table guard
    // 看不出任何異常。寧可整個不動。
    const dropRows = allRowsOf(liveTableEl);
    if (!dropRows.length || dropRows.some((row) => !row.cells[fromIndex])) return;
    suppressTableFocusout = true;
    try {
      dropRows.forEach((row) => {
        const cells = Array.prototype.slice.call(row.cells);
        const moved = cells.splice(fromIndex, 1)[0];
        cells.splice(toIndex > fromIndex ? toIndex - 1 : toIndex, 0, moved);
        cells.forEach((c) => row.appendChild(c));
      });
      reorderColgroup(liveTableEl, fromIndex, toIndex);
    } finally {
      suppressTableFocusout = false;
    }
    restoreTableFocus(liveTableEl, activeIndex);
    hideTableGrips();
    hideTableEdgeMenu();
    currentBurst.history.snap('drag-col');
  }

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest && e.target.closest('.ed-te-menu')) return; // the menu's own buttons handle themselves
    // Review fix (Critical): a PRIOR gesture's pointerup/pointercancel may
    // never have reached us at all (release over browser chrome / the
    // window edge, the window losing focus without a pointercancel, ...) —
    // clear any dangling drag state (dimmed row, frozen indicator, stale
    // capture) BEFORE starting a new one, so a stuck drag can never survive
    // into the next gesture and a fresh pointerdown always starts clean.
    if (tePointer) cancelTeDrag();
    // S3 Task 4: same defensive reasoning one line up, for the block-selection
    // press — and the flag that suppresses a gesture's own trailing click is
    // re-armed here so a gesture whose click never arrived cannot swallow the
    // next one.
    blockSelClickSuppressed = false;
    if (blockSelDrag) endBlockSelDrag();
    const hit = hitTestGrip(e.target);
    // A click on a DIFFERENT zone (or entirely outside any zone) dismisses
    // whatever menu is already open, same "any other click closes the ⠿
    // menu" precedent wireBlockSelection() follows below — but NOT when
    // it's the SAME column/row being re-clicked: that case is a toggle,
    // left to showColumnMenu()/showRowMenu() at pointerup so a bare
    // re-click (no drag) closes it instead of flicker-closing then
    // reopening it here.
    const isSameSelection = hit && teMenuKind === hit.kind && teMenuTableEl === hit.tableEl &&
      (hit.kind === 'col' ? teMenuColIndex === hit.colIndex : teMenuRowEl === hit.rowEl);
    // The highlight can now exist WITHOUT a menu (a header grip's plain
    // click, above) — so the dismiss condition can no longer gate on
    // teMenuKind alone, or that highlight would survive until
    // resolveBurst() instead of clearing on the next click.
    if ((teMenuKind || teHighlightEls.length) && !isSameSelection) hideTableEdgeMenu();
    if (!hit) {
      // S3 Task 4 (recon hazard 1): this listener already fires on EVERY left
      // click and is a no-op whenever hitTestGrip() finds nothing — which is
      // exactly the branch the block-selection gestures belong on. Arming
      // them HERE, inside the incumbent handler, is what makes "a grip hit
      // still wins" true by construction: a second, competing pointerdown
      // listener would have to re-derive the hit test, and would race this
      // one's menu dismiss above depending on registration order.
      if (e.shiftKey) { beginShiftClickSelection(e); return; }
      armBlockSelDrag(e);
      return;
    }
    e.preventDefault();
    tePointer = { hit, startX: e.clientX, startY: e.clientY, dragging: false,
      pointerId: e.pointerId, captureEl: e.target };
    // Review fix (Critical): setPointerCapture() is what guarantees
    // pointermove/pointerup/pointercancel keep arriving for THIS pointerId
    // even once the cursor leaves the table (or the browser window's
    // client area) mid-drag — without it, dragging a row upward past the
    // table top (or releasing over the tab bar) can leave the browser
    // never delivering a pointerup at all, which is exactly the latch bug
    // this whole review round is about. Best-effort: not every target
    // supports it (and a detached/exotic target could throw), so this is
    // belt-and-braces alongside the defensive pointerdown clear above and
    // the pointercancel/blur listeners below, not the ONLY safeguard.
    if (typeof e.target.setPointerCapture === 'function') {
      try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* not capturable here — the other two guards still apply */ }
    }
  });

  document.addEventListener('pointermove', (e) => {
    if (!tePointer) return;
    if (tePointer.hit.kind !== 'row' && tePointer.hit.kind !== 'col') return;
    if (!tePointer.dragging) {
      const dx = e.clientX - tePointer.startX, dy = e.clientY - tePointer.startY;
      if (Math.hypot(dx, dy) < TE_DRAG_THRESHOLD_PX) return;
      tePointer.dragging = true;
      hideTableEdgeMenu();
      hideTableInsertBubbles();
      if (tePointer.hit.kind === 'row') {
        // The column grip hides like the insert bubbles above (it isn't
        // meaningful mid row-drag); the ROW grip stays visible and switches
        // to its "dragging" visual (grabbing cursor) — it IS the drag
        // handle the user is holding, per the brief ("the active grip may
        // stay as the drag handle visual").
        colGrip.hidden = true;
        rowGrip.classList.add('ed-te-grip-dragging');
        tePointer.hit.rowEl.classList.add('ed-te-row-dragging');
      } else {
        // Symmetric for a column drag: the row grip hides, the column grip
        // itself becomes the drag handle visual.
        rowGrip.hidden = true;
        colGrip.classList.add('ed-te-grip-dragging');
      }
      teDropIndicator.hidden = false;
    }
    e.preventDefault();
    if (tePointer.hit.kind === 'row') updateDropIndicator(e.clientY);
    else updateColDropIndicator(e.clientX);
  });

  // S3 Task 4: the block-selection drag's own pointermove. Registered after
  // the table drag's (above), and bails while `tePointer` is set, so a grip
  // gesture is never fought over. Not folded into that listener because its
  // very first line is `if (!tePointer) return;` — the state this one runs in.
  document.addEventListener('pointermove', (e) => {
    updateBlockSelDrag(e);
  });

  document.addEventListener('pointerup', async (e) => {
    // S3 Task 4: recon hazard 2 — there is no `mouseup` listener anywhere in
    // this file, so the block-selection drag ends on the pointer events, the
    // same skeleton the table drag uses. Before the `!tePointer` bail: a
    // selection drag is armed precisely when no grip gesture is in flight.
    endBlockSelDrag();
    if (!tePointer) return;
    const st = tePointer;
    releaseTeCapture(st);
    tePointer = null;
    if (st.dragging) {
      if (st.hit.kind === 'row') {
        st.hit.rowEl.classList.remove('ed-te-row-dragging');
        // Drop a now-empty `class=""` — see cancelTeDrag()'s own comment
        // above for why the residue alone defeats the zero-edit guard. (The
        // grips below need no such treatment: they are OUR elements and
        // always carry at least 'ed-te-grip-row'/'ed-te-grip-col', so
        // removing one class can never empty their attribute.)
        if (!st.hit.rowEl.className) st.hit.rowEl.removeAttribute('class');
      }
      rowGrip.classList.remove('ed-te-grip-dragging');
      colGrip.classList.remove('ed-te-grip-dragging');
      teDropIndicator.hidden = true;
      if (st.hit.kind === 'row') await performRowDrop(st.hit.tableEl, st.hit.rowEl, st.dropTarget);
      else await performColDrop(st.hit.tableEl, st.hit.colIndex, st.dropTarget.index);
      return;
    }
    // A plain press-release with no drag threshold crossed: open the menu
    // for whatever zone was hit at pointerdown.
    if (st.hit.kind === 'col') showColumnMenu(st.hit.tableEl, st.hit.colIndex);
    else if (st.hit.isHeader) {
      // The row menu's only item is "delete row", and the header row can
      // never be deleted — showing it would just be an empty box. A plain
      // click on the header grip highlights the row instead.
      // clearEdgeHighlight() runs first so re-clicking a different header
      // (or a different row's menu having been open) doesn't stack
      // highlights within the same session.
      clearEdgeHighlight();
      highlightRow(st.hit.rowEl);
    } else showRowMenu(st.hit.tableEl, st.hit.rowEl);
  });

  // Review fix (Critical): the browser/OS can ABORT a gesture outright —
  // palm rejection, the captured element getting removed/disabled, some
  // other UI (a native context menu, a drag-and-drop of different content)
  // stealing the pointer — in which case `pointerup` never fires at all,
  // only `pointercancel`. Treated exactly like Esc-during-drag: unconditional
  // cleanup via cancelTeDrag(), no mutation (the row itself was never
  // actually moved mid-drag, only the indicator line).
  document.addEventListener('pointercancel', () => {
    cancelTeDrag();
    // S3 Task 4: the same abort ends a block-selection drag. The selection it
    // has built so far STANDS (§4.4: nothing but Escape and a plain click
    // clears) — what must not survive is the live drag, or the next stray
    // pointer move would keep extending a gesture the user already ended.
    endBlockSelDrag();
  });

  // Review fix (Critical): the whole BROWSER WINDOW losing focus mid-
  // gesture (alt-tab, clicking the OS taskbar/another app, ...) is another
  // way `pointerup`/`pointercancel` can simply never arrive — pointer
  // capture only guarantees delivery within this browser's own window, not
  // across a focus change to a different window entirely. Same
  // unconditional cleanup; harmless no-op via cancelTeDrag()'s own guard
  // when no gesture is in flight, so this is safe to fire on every blur.
  window.addEventListener('blur', () => {
    cancelTeDrag();
    // S3 Task 4: §4.4 says window blur does NOT clear the selection — but the
    // drag in flight when focus left is exactly as undeliverable-pointerup as
    // a row drag's, so it is torn down here too.
    endBlockSelDrag();
  });

  // ── Phase-2 Task 4: floating selection toolbar (bold/italic/code/link) ──
  // Shown over a non-collapsed selection INSIDE the active WYSIWYG editor's
  // content element (see openWysiwygEditor() above, which attaches/detaches
  // the selectionchange listener driving this per session); hidden on
  // commit/cancel/selection-collapse; never shown outside a WYSIWYG session.
  // Built once (like the hover-insert bubbles below) and moved via
  // document.body append/remove rather than re-created per session.
  //
  // Toggle policy (verbatim from the brief): if the ENTIRE selection lies
  // within one mark element of the target type, unwrap it (remove the
  // wrapper, keep its content in place). Otherwise wrap the selection's
  // contents in a new mark element. When the selection PARTIALLY overlaps an
  // existing mark of that type (touches it but isn't fully inside it), the
  // simplest deterministic policy — extend the selection to cover that
  // mark's full extent, then unwrap — is used instead of trying to split the
  // mark at the selection boundary.
  //
  // Marks map EXACTLY to the elements the inline serializer consumes
  // (STRONG/EM/CODE/A/DEL/U, see inline-md.js's walkChildren) — never a
  // <span>, which the serializer treats as either transparent (no
  // attributes) or unsupported (styled). No execCommand anywhere below —
  // every mutation is plain Range/Node surgery (extractContents/insertNode/
  // insertBefore).
  // The open session's current contenteditable edit root: the paragraph/
  // heading's own content element for a Task 3 session, or (Task 5) the
  // ACTIVE cell of an open table session — updated as Tab moves which cell
  // is active, so this always names whatever element the toolbar's mark
  // toggles should act on right now.
  let selToolbarEditEl = null;
  // The currently-attached onSelectionChangeForToolbar function reference (or
  // null) — kept at this module scope, NOT just inside openWysiwygEditor()'s
  // closure, specifically so a call site OUTSIDE that closure (rerenderAll()
  // below) can remove it without needing a reference to the per-session
  // function itself.
  let selToolbarListener = null;

  // Idempotent: safe to call any number of times, including when no session
  // is open (removeEventListener on a null/already-removed listener,
  // hideSelToolbar() on an already-detached node, and `= null` on an
  // already-null variable are all no-ops). This is what lets rerenderAll()
  // below reset this state UNCONDITIONALLY, the same way it already does for
  // `activeEditor` — see its call site's comment.
  function resetSelToolbarState() {
    if (selToolbarListener) {
      document.removeEventListener('selectionchange', selToolbarListener);
      selToolbarListener = null;
    }
    hideSelToolbar();
    selToolbarEditEl = null;
  }

  // Shows/repositions/hides the floating selection toolbar as the selection
  // changes during an open session. selectionchange (not mouseup) is the
  // reliable signal — mouseup alone misses keyboard-driven selections
  // (Shift+arrow, Ctrl+A, …). Module-scope (not nested inside
  // openWysiwygEditor()) and reads `selToolbarEditEl` fresh on every firing
  // — rather than a per-session-closed edit-root variable — specifically so
  // ONE listener, attached ONCE per burst, keeps working for a table burst
  // too as Tab/click moves which cell is active (see startTableBurst()/
  // handleTableCellFocusIn() above, which update `selToolbarEditEl` the
  // same way activateCell() used to — brief: "wire your cell edit root the
  // same way paragraph editing does (reuse, don't fork)").
  function onSelectionChangeForToolbar() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { hideSelToolbar(); return; }
    const range = sel.getRangeAt(0);
    if (!selToolbarEditEl ||
        !selToolbarEditEl.contains(range.startContainer) ||
        !selToolbarEditEl.contains(range.endContainer)) {
      hideSelToolbar();
      return;
    }
    positionSelToolbar(range);
  }

  // Nearest ancestor of `node` (inclusive) with tagName `tag`, stopping at
  // (and never crossing) `root` — a mark belonging to a DIFFERENT block must
  // never be treated as covering this selection.
  function closestMarkAncestor(node, tag, root) {
    let n = node;
    while (n && n !== root) {
      if (n.nodeType === 1 && n.tagName === tag) return n;
      n = n.parentNode;
    }
    return null;
  }

  // The entire selection lies within ONE mark element of `tag` iff both
  // boundary points resolve to the SAME nearest ancestor of that type — a
  // Range's content is exactly what's between its two boundary points in
  // document order, so both being inside the same single element guarantees
  // everything between them is too.
  function wholeSelectionMark(range, tag, root) {
    const startMark = closestMarkAncestor(range.startContainer, tag, root);
    const endMark = closestMarkAncestor(range.endContainer, tag, root);
    return (startMark && startMark === endMark) ? startMark : null;
  }

  // Removes `el`, keeping its children in place at the same position.
  // Returns a Range spanning the (now unwrapped) children so the caller can
  // restore the selection to exactly the content that was inside `el` —
  // native Range objects are "live" and auto-adjust their boundary points as
  // the DOM mutates, so this stays correct across the removals below.
  function unwrapElement(el) {
    const parent = el.parentNode;
    const kids = Array.prototype.slice.call(el.childNodes);
    kids.forEach((k) => parent.insertBefore(k, el));
    parent.removeChild(el);
    if (kids.length === 0) return null;
    const r = document.createRange();
    r.setStartBefore(kids[0]);
    r.setEndAfter(kids[kids.length - 1]);
    return r;
  }

  // Wraps the range's contents in a brand-new `<tag>` element via Range
  // surgery (extractContents/insertNode — plain DOM Range methods, NOT
  // execCommand). Returns a Range spanning the new element's contents.
  function wrapRangeIn(range, tag) {
    const el = document.createElement(tag.toLowerCase());
    el.appendChild(range.extractContents());
    range.insertNode(el);
    const r = document.createRange();
    r.selectNodeContents(el);
    return r;
  }

  // Marks of `tag` that the range overlaps (fully or partially) — called
  // only AFTER wholeSelectionMark() has already returned null, so any hit
  // here is by construction a partial-overlap case (see the toggle-policy
  // comment above).
  function overlappingMarks(range, tag, root) {
    return Array.prototype.slice.call(root.querySelectorAll(tag))
      .filter((m) => range.intersectsNode(m));
  }

  // Extends `range` outward to fully cover every mark in `marks` — Range
  // boundary points are live, so growing the range here is what makes the
  // later unwrap step remove the WHOLE mark instead of splitting it.
  function extendRangeOverMarks(range, marks) {
    const extended = range.cloneRange();
    marks.forEach((m) => {
      const mr = document.createRange();
      mr.selectNode(m);
      if (mr.compareBoundaryPoints(Range.START_TO_START, extended) < 0) extended.setStartBefore(m);
      if (mr.compareBoundaryPoints(Range.END_TO_END, extended) > 0) extended.setEndAfter(m);
    });
    return extended;
  }

  // Restores the DOM selection to `r` and repositions the toolbar over it —
  // used after every wrap/unwrap so a second click on the same (now
  // re-marked) content sees the right selection, and so the toolbar doesn't
  // wait on the async native selectionchange event to catch up.
  function reselectAndReposition(r) {
    if (!r) { hideSelToolbar(); return; }
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    positionSelToolbar(r);
  }

  // Applies the toggle policy for a plain mark type (STRONG/EM/CODE/DEL/U —
  // link has its own entry point below because it also needs a URL prompt).
  function applyMarkToggle(tag) {
    const root = selToolbarEditEl;
    if (!root) return;
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return;
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;

    const whole = wholeSelectionMark(range, tag, root);
    if (whole) {
      reselectAndReposition(unwrapElement(whole));
      snapBurstIfActive(root, 'mark');
      return;
    }
    const overlapping = overlappingMarks(range, tag, root);
    if (overlapping.length > 0) {
      const extended = extendRangeOverMarks(range, overlapping);
      // Re-query against the EXTENDED range: `overlapping` above was
      // computed from the original (smaller) range, and every mark the
      // extended range now fully covers must be removed.
      overlappingMarks(extended, tag, root).forEach((m) => unwrapElement(m));
      reselectAndReposition(extended);
      snapBurstIfActive(root, 'mark');
      return;
    }
    reselectAndReposition(wrapRangeIn(range, tag));
    snapBurstIfActive(root, 'mark');
  }

  // Link is its own entry point (not applyMarkToggle) because "unwrap" here
  // means "prompt to edit or clear the URL", and "wrap" means "prompt for a
  // URL first" — both need window.prompt() before any DOM surgery happens.
  function applyLinkToggle() {
    const root = selToolbarEditEl;
    if (!root) return;
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return;
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;

    const whole = wholeSelectionMark(range, 'A', root);
    if (whole) {
      const url = window.prompt('連結網址（留空以移除連結）：', whole.getAttribute('href') || '');
      if (url === null) return; // cancelled — leave the link untouched
      if (url.trim() === '') {
        reselectAndReposition(unwrapElement(whole));
      } else {
        whole.setAttribute('href', url.trim());
        reselectAndReposition(range);
      }
      snapBurstIfActive(root, 'mark');
      return;
    }
    const overlapping = overlappingMarks(range, 'A', root);
    if (overlapping.length > 0) {
      const extended = extendRangeOverMarks(range, overlapping);
      overlappingMarks(extended, 'A', root).forEach((m) => unwrapElement(m));
      reselectAndReposition(extended);
      snapBurstIfActive(root, 'mark');
      return;
    }
    const url = window.prompt('連結網址：', 'https://');
    if (url === null || url.trim() === '') return; // cancelled or empty — no-op
    const el = document.createElement('a');
    el.setAttribute('href', url.trim());
    el.appendChild(range.extractContents());
    range.insertNode(el);
    const r = document.createRange();
    r.selectNodeContents(el);
    reselectAndReposition(r);
    snapBurstIfActive(root, 'mark');
  }

  function buildSelToolbar() {
    const el = document.createElement('div');
    el.className = 'ed-seltb';
    function addBtn(cls, label, ariaLabel, onClick) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ed-seltb-btn ' + cls;
      b.textContent = label;
      b.setAttribute('aria-label', ariaLabel);
      // Keep the DOM selection intact across the click: without this, the
      // button (outside the contenteditable root) stealing focus on
      // mousedown would collapse the selection before the click handler
      // ever runs, leaving nothing left to act on.
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
      el.appendChild(b);
      return b;
    }
    addBtn('ed-seltb-b', 'B', 'Bold', () => applyMarkToggle('STRONG'));
    addBtn('ed-seltb-i', 'I', 'Italic', () => applyMarkToggle('EM'));
    addBtn('ed-seltb-s', 'S', '刪除線', () => applyMarkToggle('DEL'));
    addBtn('ed-seltb-u', 'U', '底線', () => applyMarkToggle('U'));
    addBtn('ed-seltb-code', '<>', 'Code', () => applyMarkToggle('CODE'));
    addBtn('ed-seltb-link', '\u{1F517}', 'Link', () => applyLinkToggle());
    return el;
  }

  const selToolbar = buildSelToolbar();

  function hideSelToolbar() {
    if (selToolbar.parentNode) selToolbar.parentNode.removeChild(selToolbar);
  }

  // Viewport-clamped, positioned above the selection by default; falls back
  // to below when there isn't room above (and is clamped horizontally/
  // vertically to stay fully on-screen either way). Coordinates are
  // viewport-relative (getBoundingClientRect()) to match `.ed-seltb`'s
  // `position: fixed`.
  function positionSelToolbar(range) {
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { hideSelToolbar(); return; }
    if (!selToolbar.parentNode) document.body.appendChild(selToolbar);
    const gap = 8, margin = 4;
    const tbRect = selToolbar.getBoundingClientRect();
    let top = rect.top - tbRect.height - gap;
    if (top < margin) top = rect.bottom + gap; // not enough room above -> below
    top = Math.max(margin, Math.min(top, window.innerHeight - tbRect.height - margin));
    let left = rect.left + rect.width / 2 - tbRect.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - tbRect.width - margin));
    selToolbar.style.top = top + 'px';
    selToolbar.style.left = left + 'px';
  }

  // ── click routing (Task 5: the click-select edit bar's last consumer —
  //    tables — is retired here; T2 already retired it for paragraph/
  //    heading) ──────────────────────────────────────────────────────────
  // Every block type is now either always-on contenteditable (paragraph/
  // heading/list root, or every cell of an armed table) or degraded (opens
  // the raw textarea directly on click, no bar/menu step) — see
  // armEditables() above. What's left to route here is: the lightbox
  // exclusion, the ⠿ handle/menu, and opening a degraded block's raw editor.
  const ED_LIGHTBOX_TARGETS =
    'img, .mermaid, .graphviz, [id^="WaveDrom_Display_"], .wavedrom-diagram';

  // Single delegated listener, wired once at the bottom of this file. Async
  // because clicking another block (or outside any block) while some
  // block's editor/burst is open must resolve it first via switchAwayFrom()
  // — see the `activeEditor` / `currentBurst` comments near their
  // declarations.
  function wireBlockSelection() {
    // Final-review Finding 5a (Important): same "keep the burst's focus
    // intact across the click" idiom every other overlay button in this
    // file uses (buildTableInsertBubble()/buildTeMenuButton() above) —
    // DELEGATED here (rather than a per-node listener in
    // buildGutterHandle() — see that function's own comment for why) since
    // this button is recreated per-block on every rerenderAll() AND can be
    // recreated again mid-session by openRawEditor()'s restore(). Without
    // this, a mousedown on the ⠿ handle for a block with its OWN burst
    // currently open and dirty blurs the focused editable surface as the
    // button's default mousedown action, firing the delegated focusout
    // handler's async switchAwayFrom()->resolveBurst()->rerenderAll()
    // commit chain BEFORE the click event that opens the menu ever fires.
    // At human click speed (a real, non-zero gap between mousedown and
    // mouseup) that commit's /api/render round trip can finish and swap
    // `.content` — detaching THIS very button — before mouseup, and a
    // click event never fires at all for a target removed from the
    // document between mousedown and mouseup: the first click is silently
    // eaten (no menu opens), and only a second click on the fresh,
    // re-armed handle actually works. preventDefault() here stops the
    // button from stealing focus in the first place, so a dirty burst's
    // own ⠿ click never triggers that race.
    // §10-gap fix: same reasoning as the ⠿ handle above, for the ＋ insert
    // button — a mousedown-triggered blur on a dirty burst elsewhere would
    // otherwise race this button's own click the exact same way.
    document.addEventListener('mousedown', (e) => {
      if (e.target && e.target.closest &&
          (e.target.closest('.ed-handle') || e.target.closest('.ed-insert'))) e.preventDefault();
    });
    document.addEventListener('click', async (e) => {
      // S3 Task 4: the trailing click of a gesture that already answered this
      // press itself (a drag across a block boundary, a Shift+Click). A drag
      // released in another block would otherwise hit the §4.4 exit rule
      // below and clear the set it just built; one released on the page
      // margin would hit the outside-a-block switchAwayFrom() instead.
      if (blockSelClickSuppressed) { blockSelClickSuppressed = false; return; }
      if (!e.target || !e.target.closest) { await switchAwayFrom(); closeGutterMenu(); closeInsertMenu(); return; }
      // showBanner() appends `.ed-conflict` to document.body — OUTSIDE any
      // .ed-block — so without this guard a click on the banner's own
      // Dismiss/Reload button (which doesn't stopPropagation()) bubbles up
      // here and matches "clicked outside any block" below, re-firing
      // switchAwayFrom() -> commitNow() -> a SECOND /api/render while the
      // first failure's banner is still what the user is trying to dismiss.
      // That re-fire fails again (same reason) and shows a NEW banner
      // immediately after the old one is removed, so the banner never
      // actually goes away and dismiss re-triggers the failed commit on
      // every click. Must be excluded before any other branch.
      if (e.target.closest('.ed-conflict')) return;
      if (e.target.closest('.ed-seltb')) return; // the selection toolbar's own buttons handle themselves
      if (e.target.closest('.ed-tb-insert')) return; // belt-and-braces; the bubble's own click stopPropagation()s already
      if (e.target.closest('.ed-te-menu')) return; // Task 6: the edge menu's own buttons handle themselves
      // Task 6 (grip handles): a plain click's own `pointerdown`/`pointerup`
      // pair above already opened the menu — unlike the bubbles/menu
      // buttons, the grips have no `click` listener of their own to
      // stopPropagation() here, so without this exclusion the SAME click
      // would also fall through to "clicked outside any block" below and
      // fire an unwanted switchAwayFrom() right after the menu just opened.
      if (e.target.closest('.ed-te-grip')) return;
      // Task 9: task-list checkbox toggle. The .ed-li-check span is
      // non-focusable chrome — no per-node listener, routed here by
      // delegation. Gate BEFORE mutation (same contract as the structural
      // key handlers in handleLiKeydown): commitListStructure re-serializes
      // the WHOLE run, so an unsupported li anywhere in it would have its
      // content silently deleted if we proceeded. Callers of
      // commitListStructure must always gate pre-mutation.
      const checkEl = e.target.closest && e.target.closest('.ed-li-check');
      if (checkEl) {
        e.preventDefault();
        const li = closestLiBlock(checkEl);
        if (!li) return;
        const run = listRunOf(li);
        if (!run.length) return;
        // The toggle rewrites the checkbox INSIDE this item's own marker, so
        // the item is the operation target (spec §4.1) — but by §4.1's own
        // CRITERION (see listRunSupportsStructuralEdit()'s note) it is a
        // COLUMN-ONLY operation and therefore not one of the refusals: it
        // changes no content, no line count and no column at all ('[ ] ' and
        // '[x] ' are the same width, so §3.4's colDelta is exactly 0). Without
        // this a hard-wrapped task item — which on a real to-do list is most
        // of them — answered '此清單含不支援的格式，無法調整結構' to a click
        // on its own checkbox.
        if (!listRunSupportsStructuralEdit(run, li, { columnOnly: true })) {
          refuseStructuralListEdit(); return;
        }
        // Resolve any open burst on another block before mutating. The span
        // is non-focusable, so mousedown on it does NOT steal focus — the
        // currently-focused surface's focusout never fires, and currentBurst
        // stays open until we explicitly resolve it here.
        // switchAwayFrom() may trigger a safeRerenderAll() that detaches
        // `checkEl`. Capture the target li's block-id first so we can
        // re-find it in the post-render DOM.
        const targetBlockId = li.getAttribute('data-block-id');
        const ok = await switchAwayFrom();
        if (!ok) return;
        // Re-find the li and its checkbox after the potential re-render.
        const targetLi = targetBlockId
          ? document.querySelector(
              '.ed-block[data-block-type="li"][data-block-id="' + targetBlockId + '"]')
          : null;
        const targetCheck = targetLi && targetLi.querySelector(':scope > .ed-li-check');
        if (!targetCheck) return;
        // Re-gate on the post-render DOM in case the burst resolution
        // changed the run's supported status.
        const targetRun = listRunOf(targetLi);
        if (!targetRun.length) return;
        if (!listRunSupportsStructuralEdit(targetRun, targetLi, { columnOnly: true })) {
          refuseStructuralListEdit(); return;
        }
        // Flip state, then serialize the whole run as one undo op.
        const wasChecked = targetCheck.getAttribute('data-checked') === '1';
        targetCheck.setAttribute('data-checked', wasChecked ? '0' : '1');
        targetCheck.setAttribute('aria-checked', String(!wasChecked));
        // focusStartLine = null: a checkbox click is not a caret gesture;
        // leave focus wherever the post-commit re-render puts it.
        // Column-only, so no `mutatedEl`: the flipped state travels in the
        // re-stated MARKER (list-md.js builds '[x] ' as part of it, and
        // splitSourceMarkers() strips the old one off the replayed line), and
        // everything after that marker — this item's own continuation lines
        // included — comes back byte-for-byte.
        await commitListStructure(targetRun, null, false,
          { carryOver: bystanderCarryOver(targetRun, null) });
        return;
      }
      // ⠿ handle: toggles its menu for the block it belongs to. ⠿ menu: its
      // own buttons handle themselves (stopPropagation()). Either way, this
      // click is fully handled here — never falls through to the
      // open-a-block logic below.
      const handleEl = e.target.closest('.ed-handle');
      if (handleEl) { toggleGutterMenu(handleEl.closest('.ed-block')); return; }
      if (e.target.closest('.ed-handle-menu')) return;
      // §10-gap fix: ＋ button / ＋ menu join the same exclusion pattern —
      // toggle for the button itself, own-buttons-handle-themselves for the
      // menu (see buildInsertMenu()'s stopPropagation()).
      const insertBtnEl = e.target.closest('.ed-insert');
      if (insertBtnEl) { toggleInsertMenu(insertBtnEl.closest('.ed-block')); return; }
      if (e.target.closest('.ed-insert-menu')) return;
      // Any other click closes an already-open ⠿ menu / ＋ menu.
      if (gutterMenuBlockEl) closeGutterMenu();
      if (insertMenuBlockEl) closeInsertMenu();
      // S3 Task 4, §4.4 exit: a click INSIDE any block, without Shift, clears
      // the whole set. Deliberately below the ⠿/＋/menu/checkbox branches
      // above, which all return early — §3.3 decides batch-vs-single by
      // whether the GRIP is inside the set, so a grip click must not clear it
      // first. A click OUTSIDE every block is deliberately not an exit: §4.4
      // lists exactly Escape and this one. clearBlockSelection() steals no
      // focus (Task 3 carry 7), so the caret still lands where the user
      // clicked.
      if (blockSelection && !e.shiftKey && e.target.closest('.ed-block')) clearBlockSelection();
      if (e.target.closest(ED_LIGHTBOX_TARGETS)) return; // let the lightbox open, unchanged
      let blockEl = e.target.closest('.ed-block');
      // v2.11.1: `.ed-block::before` (lib/md2doc.js's editModeLayoutCss) makes
      // the 40px gutter part of the block's HIT area so that hovering it keeps
      // the ＋/⠿ pair visible. That is a hover fix, and it must not become a
      // click fix by accident: before it, a click in the gutter band hit
      // main.content and meant "clicked outside any block" — which for a
      // DEGRADED block (blockquote, fenced code, an unsupported table) is the
      // difference between committing whatever was open and silently opening
      // that block's raw source editor from 20px away from it.
      //
      // Read only when the click landed on the block's OWN box (a click on any
      // descendant — the text surface, a marker, a checkbox, a gutter button —
      // is unaffected) and only when the event actually carries coordinates:
      // a synthesized `new MouseEvent('click', {bubbles:true})` and
      // `el.click()` both report clientX/clientY 0, which several scenarios in
      // test/editor-client-runtime.test.js use precisely because they mean
      // "the block itself", not "a point". `offsetX < 0` looks like the
      // tidier test and is NOT usable: for a synthesized event Chromium still
      // derives offsetX from clientX 0, so it comes back as minus the block's
      // whole left offset and every such click reads as a gutter click.
      if (blockEl && e.target === blockEl && (e.clientX || e.clientY)) {
        if (e.clientX < blockEl.getBoundingClientRect().left) blockEl = null;
      }
      if (!blockEl) { await switchAwayFrom(); return; } // clicked outside any block

      // Task 5: a table block is now armed exactly like paragraph/heading/
      // list (see armEditables() above) — an eligible table's cells are
      // permanently contenteditable (class 'ed-wys-cell', table root class
      // 'ed-wys-table'), so a click on one is native caret placement (the
      // delegated focusin listener starts/continues its burst — see
      // handleTableCellFocusIn() above), same as any other always-on
      // surface. A table that failed canWysiwygForTable() at arm time never
      // gets those classes, so it falls straight through to the generic
      // degraded-block branch below: "click opens in-place source editor"
      // (Global Constraint) — no bar, no extra step, same as any other
      // degraded block.
      const editEl = blockContentEl(blockEl);
      if ((editEl && (editEl.classList.contains('ed-wys-armed') || editEl.classList.contains('ed-wys-table'))) ||
          blockEl.querySelector('.ed-raw')) return;
      // Degraded block, not yet open: click swaps in the raw textarea
      // immediately — no bar, no menu step. Still resolve whatever else
      // might be open first, same precondition every other open path uses.
      const ok = await switchAwayFrom();
      if (!ok || !document.body.contains(blockEl)) return;
      openRawEditor(blockEl);
    });
  }

  // ── save ───────────────────────────────────────────────────────────────
  async function save() {
    let res;
    try {
      res = await fetch('/api/save', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileId: ED.fileId, content: lines.join(EOL), baseMtimeMs: mtimeMs }),
      });
    } catch (e) {
      showBanner('Save failed — network error (' + describeFailure(e) +
        '); changes NOT saved.', null, null);
      return;
    }
    if (res.status === 200) {
      let j;
      try {
        j = await res.json();
      } catch (e) {
        showBanner('Save failed — malformed server response; changes NOT saved.', null, null);
        return;
      }
      mtimeMs = j.mtimeMs;
      stack.markSaved();
      setDirty();
      return;
    }
    if (res.status === 409) {
      showConflictBanner();
      return;
    }
    // Any other status: surface it visibly — never silently drop the
    // user's edits. Dirty state (and `mtimeMs`) is left untouched, and
    // there is no auto-retry; the user decides what to do next.
    const reason = await describeHttpFailure(res);
    showBanner('Save failed — ' + reason + '; changes NOT saved.', null, null);
  }

  // ── undo / redo ───────────────────────────────────────────────────────
  async function undo() {
    // Resolve any open editor BEFORE the .content-replacing swap below —
    // see the `activeEditor` / switchAwayFrom() comments near its
    // declaration for why this is required (undo/redo silently detaching an
    // open-but-unresolved editor was the Finding-4-regression lockout). A
    // modified editor auto-commits here (pushing its own op onto `stack`
    // first), so the undo that follows targets whatever is now the newest
    // op — which, if an auto-commit just happened, IS that commit.
    if (!(await switchAwayFrom())) return;
    const prevLines = lines;
    const r = stack.undo(lines);
    if (!r) return;
    lines = r.lines;
    // S3 Task 5 (§4.4): undo/redo ALWAYS clears the block selection.
    // `UndoStack`'s op is exactly {startLine, endLine, before, after}
    // (lineops.js) and carries no selection state, so there is nothing to
    // restore a set to — and Task 5's rebuild would otherwise keep the old
    // line range standing over a document that just changed underneath it.
    // DECLARED rather than cleared outright so the rollback below leaves a
    // standing selection alone when the render fails.
    declareSelectionRange(null);
    const ok = await safeRerenderAll();
    if (!ok) {
      // Reverse the undo attempt: push the op back and restore `lines` to
      // what was on screen before this undo was requested.
      const rollback = stack.redo(lines);
      lines = rollback ? rollback.lines : prevLines;
    }
  }

  async function redo() {
    if (!(await switchAwayFrom())) return;
    const prevLines = lines;
    const r = stack.redo(lines);
    if (!r) return;
    lines = r.lines;
    declareSelectionRange(null); // §4.4, same as undo() above
    const ok = await safeRerenderAll();
    if (!ok) {
      // Reverse the redo attempt: pop the op back off and restore `lines`.
      const rollback = stack.undo(lines);
      lines = rollback ? rollback.lines : prevLines;
    }
  }

  // ── global key handling ─────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    // ── S3 §4.4: Escape priority is drag > menu > selection > burst ─────
    // A new ordered PROLOGUE, not a reshuffle of what follows (§4.4 is
    // explicit about that). The two target-based short-circuits further down
    // (.ed-wys-cell, .ed-wys-armed) `return` for EVERY key, so the gutter /
    // insert menu's own Escape branch — which sits BELOW them — was
    // unreachable whenever an armed surface held focus. And it always does
    // while a ⠿ menu is open: wireBlockSelection()'s mousedown
    // preventDefault() deliberately keeps focus inside the burst so a dirty
    // block's own ⠿ click cannot race its blur-commit.
    //
    // Measured on 2026-08-30 against v2.11.0: typing " EDITED" into a
    // paragraph, opening its ⠿ menu and pressing Escape reached
    // handleBurstKeydown() -> revertBurstAndEnd() — the paragraph went back
    // to "alpha", the uncommitted edit was destroyed, AND the menu stayed on
    // screen. Exactly inverted from what the user asked for.
    //
    // The two Escape branches immediately below (in-flight row drag, table
    // edge menu) are now reached HERE first and are dead for Escape. They are
    // deliberately kept: they still carry their non-Escape duties and the
    // reasoning in their comments, and the edge-menu condition is mirrored
    // here as `(teMenuKind || teHighlightEls.length)` rather than restated —
    // that widening was made in S0 for the header grip, whose click produces
    // a highlight with NO menu, and narrowing it back here would re-open the
    // exact destructive Escape it was made to close.
    //
    // Placement note: this sits ABOVE the `.ed-raw` textarea bail below, as
    // the two pre-existing Escape branches already did. Harmless for the raw
    // editor: its own per-instance keydown listener runs in the TARGET phase,
    // before this document-level one, so its Escape has already been handled;
    // and the one menu item that opens a raw editor (MD 原始碼) calls
    // closeGutterMenu() first, so gutterMenuBlockEl is null by then.
    if (e.key === 'Escape') {
      if (tePointer && tePointer.dragging) { e.preventDefault(); cancelTeDrag(); return; }
      if (teMenuKind || teHighlightEls.length) { e.preventDefault(); hideTableEdgeMenu(); return; }
      if (gutterMenuBlockEl || insertMenuBlockEl) {
        e.preventDefault();
        closeGutterMenu();
        closeInsertMenu();
        return;
      }
      if (blockSelection) { e.preventDefault(); clearBlockSelection(); return; }
      // Nothing above owns this Escape — fall through to the burst
      // short-circuits below, where Escape-reverts-the-burst still belongs.
    }

    // Task 6: Esc during an in-flight row drag cancels JUST the drag (no
    // mutation — the row was never actually moved, only the indicator line
    // tracked the pointer) — a DISTINCT gesture from Esc-reverts-burst
    // (handleTableCellKeydown() below), which must never fire for this same
    // keypress. Checked before EVERY other branch (including Ctrl+S) so a
    // drag in flight always wins the keystroke.
    if (tePointer && tePointer.dragging && e.key === 'Escape') {
      e.preventDefault();
      cancelTeDrag();
      return;
    }
    // Task 6: Esc with the edge menu open closes JUST the menu — same
    // "intercept before the wys-cell/wys-armed Escape branches" reasoning,
    // since the cell that was focused (if any) before the menu opened is
    // still focused underneath it (the menu's own mousedown preventDefault()
    // never stole focus).
    // Final review I1: the condition is `(teMenuKind || teHighlightEls.length)`,
    // NOT `teMenuKind` alone — the exact same widening the pointerdown dismiss
    // gate already got, and for the same reason: a header grip's click
    // deliberately produces a highlight with NO menu (its only menu item,
    // "delete row", cannot apply to a header), so teMenuKind stays null. Gated
    // on teMenuKind alone, that Esc fell through to handleTableCellKeydown()'s
    // own Escape branch -> revertTableBurstAndEnd(), throwing away everything
    // typed into the burst. With a BODY row's menu open the identical keypress
    // merely closes the menu, so the header row would have been the one place
    // where dismissing a selection is destructive.
    if ((teMenuKind || teHighlightEls.length) && e.key === 'Escape') {
      e.preventDefault();
      hideTableEdgeMenu();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 's') {
      e.preventDefault();
      // Final-review Finding 1 (Critical): this used to call save() directly,
      // which serializes `lines` — but a mid-burst keystroke (typed, never
      // blurred) has NOT reached `lines` yet; save() would persist the STALE
      // pre-burst text and markSaved() would then clear the dirty dot,
      // silently discarding the just-typed content with no beforeunload
      // warning left to catch it. Resolve whatever burst/editor is open
      // FIRST (same precondition undo()/redo()/changeHeadingDepth() use)
      // so `lines` reflects the latest edit before save() reads it. On a
      // commit failure switchAwayFrom() returns false — the banner it
      // already showed is the visible reason save() is skipped; the burst
      // stays open with the user's text intact rather than saving nothing.
      switchAwayFrom().then((ok) => { if (ok) save(); });
      return;
    }

    const inTextarea = e.target && e.target.tagName === 'TEXTAREA' &&
      e.target.classList.contains('ed-raw');
    if (inTextarea) return; // Ctrl+Enter/Esc handled by openRawEditor()'s own per-instance listener

    // Task 5: a table cell (class 'ed-wys-cell') owns its own Enter/Tab/
    // Escape/Ctrl+Z/Ctrl+Y contract, materially different from paragraph/
    // heading/list (Enter is an UNCONDITIONAL <br>, Tab moves the active
    // cell without ending the burst) — handleTableCellKeydown() owns that
    // entire surface, mirroring handleBurstKeydown() just below.
    // S3: undo/redo is the one pair of keys the two short-circuits below must
    // NOT claim when there is no burst to own them. resolveBurst()'s zero-edit
    // path calls endBurstWithoutResolve() and returns WITHOUT re-rendering, so
    // after a Ctrl+S on an untouched surface `currentBurst` is null while that
    // surface still holds native focus and its .ed-wys-armed / .ed-wys-cell
    // class. The next Ctrl+Z then matched a short-circuit, reached
    // handleBurstKeydown() / handleTableCellKeydown(), and died on their
    // identical `!currentBurst` bail on the first line — the global undo()
    // further down was never reached.
    //
    // Measured on 2026-08-30 against v2.11.0, for paragraph, li AND table:
    // type a character, Ctrl+S, click back in, Ctrl+S again (an ordinary habit
    // keystroke), Ctrl+Z — the file did not change. Pre-existing on main;
    // fixed here because this is the same dispatch S3 rewrites.
    //
    // Deliberately narrow: only the undo/redo keys, and only with no burst.
    // Every other key on an armed surface keeps going to its burst handler
    // exactly as before, burst or no burst.
    const undoRedoKey = (e.ctrlKey || e.metaKey) &&
      (e.key === 'z' || e.key === 'y' || (e.shiftKey && e.key === 'Z'));
    const burstOwnsKey = !!currentBurst || !undoRedoKey;

    const cellEl = e.target && e.target.closest && e.target.closest('.ed-wys-cell');
    if (cellEl && burstOwnsKey) {
      handleTableCellKeydown(e, cellEl);
      return;
    }

    // Task 2 (Phase 3): a paragraph/heading/list always-on WYSIWYG burst
    // surface — Enter/Shift+Enter/Esc/Ctrl+Z/Ctrl+Y are all handled
    // per-surface by handleBurstKeydown() above (which also owns
    // preventDefault() for those keys), so nothing below this must run for
    // it either.
    const wysArmedEl = e.target && e.target.closest && e.target.closest('.ed-wys-armed');
    if (wysArmedEl && burstOwnsKey) {
      handleBurstKeydown(e, wysArmedEl);
      return;
    }

    // S3 Task 4, §4.4 entry (c). Deliberately BELOW the two burst
    // short-circuits above: inside an armed surface (or a table cell)
    // Shift+↑↓ is the browser's own extend-the-text-selection gesture and
    // must stay that way. A standing selection's focus holder is a plain
    // `.ed-block` — neither `.ed-wys-armed` nor `.ed-wys-cell` — so the keys
    // reach here exactly when block selection is what they can mean.
    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey &&
        (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      if (stepSelectionFocus(e.key === 'ArrowUp' ? -1 : 1)) { e.preventDefault(); return; }
    }

    // ── S3 Task 7: §3.5's 選取集合語意 and §3.6's 「Delete 整批刪」 ─────────
    // Deliberately BELOW the two burst short-circuits, exactly like the
    // Shift+↑↓ branch above: inside an armed surface Tab indents the caret's
    // own item and Delete removes a CHARACTER, and inside a table cell Tab
    // navigates cells — three contracts this must not touch. A standing
    // selection puts DOM focus on a plain `.ed-block` wrapper, which is
    // neither `.ed-wys-armed` nor `.ed-wys-cell`, so these keys arrive here
    // exactly when block selection is what they can mean.
    //
    // `blockSelection` is the gate, and it is the whole guard: with no set
    // standing there is no focus holder either, and every key below behaves
    // exactly as it did pre-S3.
    if (blockSelection && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key === 'Tab') {
        // §3.5, in as many words: 必須 preventDefault()，否則 Tab 在 body 上是
        // 瀏覽器焦點巡覽.
        e.preventDefault();
        tabSelection(e.shiftKey ? -1 : 1);
        return;
      }
      // Backspace is the same gesture as Delete, deliberately: with a set
      // standing, focus is on a block wrapper and not on any text surface, so
      // neither key can mean "delete a character" — and a user who selected
      // blocks and reached for Backspace meant the selection. preventDefault()
      // matters for its own reason here: an unhandled Backspace outside an
      // editable is history-navigation in some configurations.
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelection();
        return;
      }
    }

    // v2.11.1 acceptance, escape class A: Tab with NOTHING focused. Every
    // branch above is keyed on the event target being some edit surface, and
    // after a commit / Escape / Ctrl+Z, or a click on a bullet marker or in
    // the block's own gutter, focus is on BODY and the target is BODY — so no
    // branch matched and the browser ran its own sequential focus navigation,
    // landing on whichever gutter <button> happens to come next in document
    // order. Spec §3.5: 必須 preventDefault()，否則 Tab 在 body 上是瀏覽器焦點
    // 巡覽. This is deliberately a silent no-op rather than "indent the block
    // nearest the caret": with no focus there is no caret, so there is no
    // block the key could mean.
    //
    // Scoped so a real control keeps its keyboard contract: the reader's own
    // search input and the raw editor's textarea (which returned above) are
    // still tabbable, and so is anything else the user has deliberately
    // focused. What is swallowed is Tab from inside a `.ed-block` and Tab with
    // no focus at all — the two states the editor puts the user in.
    if (e.key === 'Tab') {
      const inBlock = e.target && e.target.closest && e.target.closest('.ed-block');
      // A REAL control inside a block keeps its keyboard contract. The raw
      // source editor's own 完成/取消 buttons are the case that matters: Tab
      // out of its textarea is how a keyboard user reaches them (the textarea
      // itself returned above), and swallowing the next Tab would trap focus
      // on the button it just landed on. The ⠿ menu's buttons are the same
      // shape. The two GUTTER buttons are excluded from that exemption on
      // purpose — they are the chrome this fix exists to keep out of the tab
      // order, and buildGutterHandle()/buildGutterInsertButton() give them
      // tabindex="-1" for the same reason.
      const control = e.target && e.target.closest && e.target.closest(
        'button:not(.ed-handle):not(.ed-insert), input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])');
      const focused = document.activeElement;
      const nothingFocused = !focused || focused === document.body ||
        focused === document.documentElement;
      if ((inBlock && !control) || nothingFocused) {
        e.preventDefault();
        return;
      }
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      closeGutterMenu();
      closeInsertMenu();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
      e.preventDefault();
      undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) &&
        (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
      e.preventDefault();
      redo();
      return;
    }
  });

  // ── Task 2 (Phase 3): the delegated focusin/focusout/paste/input set ────
  // arming a WYSIWYG-eligible block (see armEditables() above) never
  // attaches anything to it directly — these four listeners, registered
  // exactly ONCE each at document level, are the entire wiring surface for
  // every always-on paragraph/heading/list edit surface, no matter how many
  // times the page is re-armed by rerenderAll(). Gated throughout by the
  // `.ed-wys-armed` class. Task 5: a table cell's OWN focusin/focusout/
  // input/paste handling (class 'ed-wys-cell') is a separate branch at the
  // top of each listener below — see handleTableCellFocusIn() above.
  document.addEventListener('focusin', async (e) => {
    const cellEl = e.target && e.target.closest && e.target.closest('.ed-wys-cell');
    if (cellEl) { await handleTableCellFocusIn(cellEl); return; }
    const editEl = e.target && e.target.closest && e.target.closest('.ed-wys-armed');
    if (!editEl) return;
    if (currentBurst && currentBurst.editEl === editEl) return; // already tracking
    const blockElAtFocus = editEl.closest('.ed-block');
    const blockId = blockElAtFocus ? blockElAtFocus.getAttribute('data-block-id') : null;
    // A DIFFERENT surface's burst (or an old-style activeEditor) may still
    // be resolving from the focusout that just preceded this focusin — see
    // switchAwayFrom()'s single-flight `switching`. Await it before
    // starting a new burst so the two never race a concurrent commit.
    if (switching) await switching;
    if (currentBurst) return; // a concurrent focusin already won the race
    let liveEditEl = editEl;
    if (!document.body.contains(editEl)) {
      // The awaited resolution above committed successfully and swapped the
      // whole .content subtree (rerenderAll()), detaching the original
      // target. Re-resolve the equivalent LIVE node by block id and move
      // focus there for real — that re-enters this same handler
      // synchronously (switching is null by now), which starts the burst.
      const liveBlockEl = blockId != null ? document.querySelector('.ed-block[data-block-id="' + blockId + '"]') : null;
      liveEditEl = liveBlockEl ? blockContentEl(liveBlockEl) : null;
      if (!liveEditEl || !liveEditEl.classList.contains('ed-wys-armed')) return;
      liveEditEl.focus();
      return;
    }
    startBurst(liveEditEl);
  });

  document.addEventListener('focusout', (e) => {
    // showBanner() appends `.ed-conflict` to document.body, OUTSIDE any
    // .ed-block — focus moving there (e.g. the user clicking its Dismiss/
    // Reload button) is not a "blur away to commit", it's dismissing the
    // very banner a FAILED commit just showed. Without this guard, that
    // click would fire a SECOND, identical, doomed-to-fail commit attempt —
    // the same failure mode wireBlockSelection()'s click delegator has
    // always excluded `.ed-conflict` for (see its own comment).
    if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.ed-conflict')) return;
    // Task 5: a table burst spans MANY focusable cells (unlike paragraph/
    // heading/list, where burst.editEl IS the one focused surface) — moving
    // focus between cells of the SAME table (Tab, or a click on another
    // cell) must NOT end the burst, only focus leaving the TABLE entirely
    // does. relatedTarget (the element ABOUT to gain focus) is what decides
    // that: still inside the table -> no-op (the paired focusin above
    // already updated activeCellEl); the hover-insert bubbles are also
    // excluded (belt-and-braces alongside their own mousedown
    // preventDefault() — see buildTableInsertBubble() above) so a bubble
    // click's focus dance never looks like "left the table" either.
    // `suppressTableFocusout` (see its own comment near `currentBurst`'s
    // declaration) excludes a THIRD case none of the above catches: a
    // table-burst-internal innerHTML REASSIGNMENT (revert/undo/redo) fires
    // this same synchronous blur/focusout on the cell it's about to
    // replace, and — because Chromium unfocuses BEFORE actually detaching
    // the node — `e.target.closest('table')` still resolves to this live
    // `tableEl` and `e.relatedTarget` is still unset, so neither
    // `stillInTable` nor `toOverlay` below would catch it either.
    if (suppressTableFocusout) return;
    // Task 8: same guard for a structural list mutation in flight — see
    // `suppressLiFocusout`'s own comment (next to the table flag) for why this
    // focusout must not be read as "the user left the surface".
    if (suppressLiFocusout) return;
    const cellEl = e.target && e.target.closest && e.target.closest('.ed-wys-cell');
    if (cellEl && currentBurst && currentBurst.blockType === 'table' && currentBurst.editEl === cellEl.closest('table')) {
      const tableEl = currentBurst.editEl;
      const stillInTable = e.relatedTarget && tableEl.contains(e.relatedTarget);
      const toOverlay = e.relatedTarget && e.relatedTarget.closest &&
        (e.relatedTarget.closest('.ed-tb-insert') || e.relatedTarget.closest('.ed-te-menu') ||
          e.relatedTarget.closest('.ed-te-grip'));
      if (stillInTable || toOverlay) return;
      switchAwayFrom().then((ok) => {
        if (!ok && currentBurst && currentBurst.editEl === tableEl) {
          (currentBurst.activeCellEl || cellEl).focus();
        }
      });
      return;
    }
    const editEl = e.target && e.target.closest && e.target.closest('.ed-wys-armed');
    if (editEl && currentBurst && currentBurst.editEl === editEl) {
      // Task 2 (Phase 3): focusing away from an armed surface commits it —
      // switchAwayFrom() (extended above to resolve `currentBurst` too)
      // carries over the SAME commit-failure rollback + single-flight
      // semantics raw-edit/table sessions have always had. On failure the
      // burst stays open (DOM/history untouched, banner already shown) —
      // refocusing it here is what makes "stays open" visibly true again
      // even though native focus had already moved on to whatever the user
      // clicked.
      switchAwayFrom().then((ok) => {
        if (!ok && currentBurst && currentBurst.editEl === editEl) editEl.focus();
      });
      return;
    }
    // Degraded blocks (brief: "blur commits (changed) or restores
    // (unchanged)"). Ctrl+Enter/Escape keep working via openRawEditor()'s
    // own per-instance listener (unchanged); this adds the blur trigger on
    // top of it, through the same switchAwayFrom()/activeEditor path every
    // other commit route in this file already uses.
    const ta = e.target && e.target.matches && e.target.matches('textarea.ed-raw') ? e.target : null;
    if (!ta) return;
    const blockEl = ta.closest('.ed-block');
    // Moving focus to this editor's OWN ✓/✕ controls is not a "blur away"
    // — let their own click handlers run (which call commit()/restore()
    // directly) instead of racing them with an extra switchAwayFrom() call.
    if (e.relatedTarget && blockEl && blockEl.contains(e.relatedTarget)) return;
    if (!activeEditor || activeEditor.blockEl !== blockEl) return;
    switchAwayFrom();
  });

  document.addEventListener('input', (e) => {
    const cellEl = e.target && e.target.closest && e.target.closest('.ed-wys-cell');
    if (cellEl) {
      const tableEl = cellEl.closest('table');
      if (currentBurst && currentBurst.blockType === 'table' && currentBurst.editEl === tableEl) {
        currentBurst.history.noteTyping();
      }
      return;
    }
    const editEl = e.target && e.target.closest && e.target.closest('.ed-wys-armed');
    if (!editEl || !currentBurst || currentBurst.editEl !== editEl) return;
    currentBurst.history.noteTyping();
  });

  document.addEventListener('paste', (e) => {
    const cellEl = e.target && e.target.closest && e.target.closest('.ed-wys-cell');
    if (cellEl) {
      e.preventDefault();
      const dt = e.clipboardData || window.clipboardData;
      insertTextAtCaret(dt ? dt.getData('text/plain') : '');
      snapBurstIfActive(cellEl.closest('table'), 'paste');
      return;
    }
    const editEl = e.target && e.target.closest && e.target.closest('.ed-wys-armed');
    if (!editEl) return;
    e.preventDefault();
    const dt = e.clipboardData || window.clipboardData;
    insertTextAtCaret(dt ? dt.getData('text/plain') : '');
    snapBurstIfActive(editEl, 'paste');
  });

  // Task 5: hover-edge insert bubbles — one delegated, rAF-throttled
  // mousemove listener (never a per-block/per-boundary listener) drives
  // updateTableInsertBubbles() above. Coalesced to at most once per animation
  // frame: every mousemove updates the latest known pointer position, but
  // only the FIRST one in a frame schedules the (idempotent) recompute —
  // later moves in the same frame just refresh the coordinates it will read.
  let tbMoveX = 0, tbMoveY = 0, tbMoveTarget = null, tbMoveScheduled = false;
  document.addEventListener('mousemove', (e) => {
    tbMoveX = e.clientX; tbMoveY = e.clientY; tbMoveTarget = e.target;
    if (tbMoveScheduled) return;
    tbMoveScheduled = true;
    requestAnimationFrame(() => {
      tbMoveScheduled = false;
      // Review fix (Important): this listener is independent of Task 6's
      // own `pointermove` above and keeps firing every frame regardless —
      // without this gate, an active row drag would repaint the ＋ bubble
      // (or reposition/re-show the grips over some OTHER row/column the
      // cursor is currently dragging across) on TOP of the drop indicator on
      // every real drag. Explicitly HIDE the insert bubbles and the OTHER
      // grip (not just skip recomputing) so anything already showing from
      // the moment just before the drag threshold was crossed doesn't linger
      // stale for the rest of the gesture. Task 8 fix round 1 (Important 1):
      // a column drag is now possible too, so "the other grip" is no longer
      // always the column grip — hide `colGrip` during a row drag, `rowGrip`
      // during a column drag. The ACTIVE grip (whichever kind is being
      // dragged) is deliberately left untouched here — the pointermove
      // listener above already switched it to its "dragging" visual (see
      // `ed-te-grip-dragging`) as the drag's own handle, and this gate must
      // not fight that by hiding it or repositioning it onto whatever
      // row/column the cursor happens to be over.
      if (tePointer && tePointer.dragging) {
        hideTableInsertBubbles();
        if (tePointer.hit.kind === 'row') colGrip.hidden = true;
        else rowGrip.hidden = true;
        return;
      }
      // S3 Task 4 (recon hazard 3): a block-selection drag needs the same
      // gate, for the same reason — this listener keeps firing every frame
      // regardless, and would repaint the ＋ bubbles and reposition the grips
      // onto whatever row the cursor is dragging across, on top of the tint.
      // Both are HIDDEN rather than merely left un-recomputed, so anything
      // already showing from the frame before the boundary was crossed does
      // not linger stale for the rest of the gesture.
      if (blockSelDrag && blockSelDrag.dragging) {
        hideTableInsertBubbles();
        hideTableGrips();
        return;
      }
      updateTableInsertBubbles(tbMoveX, tbMoveY, tbMoveTarget);
      updateTableEdgeGrips(tbMoveX, tbMoveY, tbMoveTarget);
    });
  });

  window.addEventListener('beforeunload', (e) => {
    if (stack.dirtyDepth !== 0) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  });

  setInterval(() => {
    // /api/ping requires content-type: application/json like the other
    // state-changing POST routes (415 otherwise) — see server.js's CORS
    // defense. A body is included so the header is meaningful, not just
    // present on an otherwise-empty request.
    fetch('/api/ping', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).catch(() => {});
  }, 10000);

  armEditables(contentEl);
  wireBlockSelection();
})();
