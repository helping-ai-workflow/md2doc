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

  // Pure: apply a raw-edit commit to (lines, blocks); push onto stack.
  // Returns {lines, blocks, op}; op === null when text is unchanged.
  function commitEdit(state, blockId, newText) {
    const block = state.blocks.find((b) => b.id === blockId);
    const before = state.lines.slice(block.startLine - 1, block.endLine);
    const after = newText.split('\n');
    if (before.join('\n') === after.join('\n')) {
      return { lines: state.lines, blocks: state.blocks, op: null };
    }
    const op = { startLine: block.startLine, endLine: block.endLine, before, after };
    const r = ops.replaceLines(state.lines, block.startLine, block.endLine, after);
    const blocks = ops.shiftBlocks(state.blocks, blockId, r.delta);
    state.stack.push(op);
    return { lines: r.lines, blocks, op };
  }

  // Task 4 fix (review, Important): removing the LAST remaining item of a
  // list block (empty-Enter on a list with exactly one item) serializes to
  // '' — committing that through commitEdit() would replace the block's
  // line range with [''] (ONE blank line: `newText.split('\n')` on an empty
  // string is `['']`, not `[]`), leaving stray diff noise instead of
  // cleanly closing the gap. This deletes the block's ENTIRE line range
  // (zero lines) and — to avoid stacking the block's own two neighboring
  // blank-line separators into a double blank — also absorbs exactly ONE
  // adjacent blank line: the one immediately AFTER the block if it's blank,
  // else the one immediately BEFORE it if THAT one's blank, else neither
  // (nothing to absorb — the block had no blank neighbor on either side,
  // e.g. start/end of file). Verified against the reviewer's exact probe:
  // `# Doc\n\n- Only\n\nTrailer` -> `# Doc\n\nTrailer` (exactly one
  // separating blank line) — see test/editor-client.test.js.
  function commitListBlockRemoval(state, blockId) {
    const block = state.blocks.find((b) => b.id === blockId);
    let startLine = block.startLine, endLine = block.endLine;
    // state.lines[endLine] (0-indexed) is the line immediately AFTER the
    // block (block occupies 0-indexed startLine-1 .. endLine-1).
    if (state.lines[endLine] !== undefined && state.lines[endLine].trim() === '') {
      endLine += 1;
    } else if (state.lines[startLine - 2] !== undefined && state.lines[startLine - 2].trim() === '') {
      startLine -= 1;
    }
    const before = state.lines.slice(startLine - 1, endLine);
    const op = { startLine, endLine, before, after: [] };
    const r = ops.replaceLines(state.lines, startLine, endLine, []);
    const blocks = ops.shiftBlocks(state.blocks, blockId, r.delta);
    state.stack.push(op);
    return { lines: r.lines, blocks, op };
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
    module.exports = { extractBlockSource, commitEdit, commitListBlockRemoval, headingDepthOf, withHeadingDepth };
    return; // node: pure core only
  }

  // ── DOM wiring (browser only) ─────────────────────────────────────────
  const ED = window.__ED__;
  const inlineMd = window.md2docInlineMd;
  const tableMd = window.md2docTableMd;
  const listMd = window.md2docListMd;
  const historyLib = window.md2docHistory;
  let lines = ED.lines, blocks = ED.blocks, mtimeMs = ED.mtimeMs;
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

  // Task 5 fix (found via a standalone repro harness — see the task-5
  // report): a table burst's tableEl.innerHTML REASSIGNMENT (revert /
  // undo / redo — the only mutations that replace the WHOLE table, unlike
  // insertRow()/insertColumn() which patch it in place) removes whichever
  // cell currently has focus. Chromium runs the focus-fixup "unfocus"
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
  // the exact synchronous span of each such innerHTML reassignment (see
  // tableBurstUndo()/tableBurstRedo()/revertTableBurstAndEnd() below); the
  // focusout listener checks it FIRST and no-ops the whole branch while set.
  let suppressTableFocusout = false;

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
      activeEditor.cancelNow();
      return true;
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
      cancelNow: restore,
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
        restore();
        return true;
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
        const rollback = stack.undo(lines);
        lines = rollback ? rollback.lines : prevLines;
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
        restore();
      }
    });
    commitBtn.addEventListener('click', commit);
    cancelBtn.addEventListener('click', restore);
  }

  // ── Phase-2 Task 3: paragraph / heading WYSIWYG editing ────────────────
  // A block's rendered content is always the .ed-block's single element
  // child (see lib/md2doc.js's editMode wrapper: `<div class="ed-block"
  // ...>${inner}</div>` where `inner` is exactly one <p>/<h#>/... tag).
  function blockContentEl(blockEl) {
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

  // Task 4 (Phase 3): same "check before ever opening the editor" contract
  // as canWysiwygForBlock()/canWysiwygForTable() above, for a list block's
  // UL/OL root — Global Constraint: "armed like paragraphs when canWysiwyg
  // holds over ALL items" (a single unsupported item — e.g. a GFM task-list
  // checkbox — degrades the WHOLE list to raw-edit, never a half-armed
  // list). No cloneNode() needed: serializeList() never mutates its input,
  // same as serializeTable().
  function canWysiwygForList(listEl) {
    return !!listEl && listMd.serializeList(listEl).unsupported.length === 0;
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
      const rollback = stack.undo(lines);
      lines = rollback ? rollback.lines : prevLines;
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
      } else if (editEl && blockType === 'list' && canWysiwygForList(editEl)) {
        // Task 4 (Phase 3): recommended arming shape (documented in the task
        // report) — contenteditable on the LIST ROOT itself (the UL/OL that
        // IS blockContentEl(blockEl), per lib/md2doc.js's editMode wrapper),
        // not per-<li>. One edit surface per list block: native caret moves
        // across items for free, and the root element is exactly what
        // list-md.js's serializeList() already expects as its argument — no
        // translation layer needed between "what's contenteditable" and
        // "what gets serialized" (resolveBurst() below passes burst.editEl
        // straight to serializeList() for a list burst, the same way it
        // passes the paragraph/heading editEl straight to serializeInline()).
        editEl.setAttribute('contenteditable', 'true');
        editEl.classList.add('ed-wys-armed');
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
      // is unaffected.
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

  // The single shared ⠿ menu (heading ± / MD 原始碼 / close) — built once,
  // moved into whichever block's DOM the user opened it on, same pattern as
  // `selToolbar` elsewhere in this file. `gutterMenuBlockEl` names which
  // block it's currently open for.
  let gutterMenuBlockEl = null;
  let gutterMenuMinus, gutterMenuPlus;

  function buildGutterMenu() {
    const el = document.createElement('div');
    el.className = 'ed-handle-menu';

    gutterMenuMinus = document.createElement('button');
    gutterMenuMinus.type = 'button';
    gutterMenuMinus.className = 'ed-handle-menu-btn';
    gutterMenuMinus.textContent = '−';
    gutterMenuMinus.setAttribute('aria-label', 'Decrease heading level');
    gutterMenuMinus.addEventListener('click', (e) => {
      e.stopPropagation();
      const blockEl = gutterMenuBlockEl;
      closeGutterMenu();
      changeHeadingDepth(blockEl, -1);
    });

    gutterMenuPlus = document.createElement('button');
    gutterMenuPlus.type = 'button';
    gutterMenuPlus.className = 'ed-handle-menu-btn';
    gutterMenuPlus.textContent = '+';
    gutterMenuPlus.setAttribute('aria-label', 'Increase heading level');
    gutterMenuPlus.addEventListener('click', (e) => {
      e.stopPropagation();
      const blockEl = gutterMenuBlockEl;
      closeGutterMenu();
      changeHeadingDepth(blockEl, 1);
    });

    const mdBtn = document.createElement('button');
    mdBtn.type = 'button';
    mdBtn.className = 'ed-handle-menu-btn';
    mdBtn.textContent = 'MD 原始碼';
    mdBtn.setAttribute('aria-label', 'Switch to raw markdown edit');
    mdBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const blockEl = gutterMenuBlockEl;
      closeGutterMenu();
      openRawViaGutter(blockEl);
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ed-handle-menu-btn';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Close menu');
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeGutterMenu();
    });

    el.appendChild(gutterMenuMinus);
    el.appendChild(gutterMenuPlus);
    el.appendChild(mdBtn);
    el.appendChild(closeBtn);
    return el;
  }
  const gutterMenu = buildGutterMenu();

  function closeGutterMenu() {
    gutterMenu.remove();
    gutterMenuBlockEl = null;
  }

  function toggleGutterMenu(blockEl) {
    if (!blockEl) return;
    if (gutterMenuBlockEl === blockEl) { closeGutterMenu(); return; }
    gutterMenuBlockEl = blockEl;
    const blockType = blockEl.getAttribute('data-block-type');
    const isHeading = blockType === 'heading';
    gutterMenuMinus.hidden = !isHeading;
    gutterMenuPlus.hidden = !isHeading;
    blockEl.appendChild(gutterMenu);
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
  function startBurst(editEl) {
    const blockEl = editEl.closest('.ed-block');
    if (!blockEl) return;
    const blockId = Number(blockEl.getAttribute('data-block-id'));
    const block = blocks.find((b) => b.id === blockId);
    if (!block) return;
    const blockType = blockEl.getAttribute('data-block-type');
    const history = historyLib.createBurstHistory(() => editEl.innerHTML, { debounceMs: 400 });
    history.start();
    currentBurst = {
      blockEl, editEl, blockId, blockType,
      depth: blockDepthOf(blockType, editEl),
      original: editEl.innerHTML,
      history,
    };
    selToolbarEditEl = editEl;
    if (!selToolbarListener) {
      selToolbarListener = onSelectionChangeForToolbar;
      document.addEventListener('selectionchange', onSelectionChangeForToolbar);
    }
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
    // `burst.original` is exactly `burst.editEl.innerHTML` captured at
    // focus time (startBurst()/startTableBurst() above, for every block
    // type this burst substrate covers — paragraph/heading/list/table all
    // store it the same way) — a byte-identical innerHTML means the DOM
    // genuinely never changed, so drop the burst here exactly like the
    // `commitResult.op === null` no-op path below, without ever reaching
    // the serializer (and therefore without ever risking a canonicalizing
    // rewrite of untouched content).
    if (burst.editEl.innerHTML === burst.original) {
      burst.history.dispose();
      currentBurst = null;
      resetSelToolbarState();
      return true;
    }
    burst.history.flushTyping();
    // Task 4 (Phase 3): a list burst serializes through list-md.js's
    // serializeList() (it takes the list ROOT element, exactly what
    // burst.editEl already is for a 'list' burst — see armEditables() above)
    // instead of inline-md.js's serializeInline(); Task 5: a table burst
    // serializes through table-md.js's serializeTable() the same way (it
    // takes the TABLE element, exactly what burst.editEl already is for a
    // 'table' burst). Every other block type (paragraph/heading) keeps using
    // serializeInline() unchanged.
    const result = burst.blockType === 'list' ? listMd.serializeList(burst.editEl)
      : burst.blockType === 'table' ? tableMd.serializeTable(burst.editEl)
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
      burst.history.dispose();
      currentBurst = null;
      resetSelToolbarState();
      openRawEditor(burst.blockEl);
      return false;
    }
    // Final-review Finding 5 (carried over): an emptied-out heading must not
    // commit '#'.repeat(depth) + ' ' with nothing after the space. A list
    // burst's `depth` is always null (blockDepthOf() only computes it for
    // 'heading'), so it takes the plain result.md branch, same as a
    // paragraph.
    const newText = burst.depth === null ? result.md :
      (result.md === '' ? '#'.repeat(burst.depth) : '#'.repeat(burst.depth) + ' ' + result.md);
    // Task 4 fix (review, Important): a list burst that serialized to ''
    // means every item was removed (each <li> always emits a non-empty
    // marker line — see list-md.js — so a 0-line result can ONLY happen
    // with 0 <li>s left) — delete the block's line range entirely instead
    // of committing a single stray blank line. See commitListBlockRemoval()'s
    // own comment for the exact byte-level contract.
    const commitResult = (burst.blockType === 'list' && result.md === '')
      ? commitListBlockRemoval({ lines, blocks, stack }, burst.blockId)
      : commitEdit({ lines, blocks, stack }, burst.blockId, newText);
    if (commitResult.op === null) {
      burst.history.dispose();
      currentBurst = null;
      resetSelToolbarState();
      return true;
    }
    const prevLines = lines;
    lines = commitResult.lines;
    const ok = await safeRerenderAll();
    if (!ok) {
      const rollback = stack.undo(lines);
      lines = rollback ? rollback.lines : prevLines;
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

  // Esc inside a burst: revert to snapshot 0 (the pre-focus baseline) and
  // end the burst WITHOUT committing — replaces the old per-session Esc
  // cancel. Clears `currentBurst` BEFORE calling blur() so the delegated
  // focusout handler (which fires synchronously from blur()) finds nothing
  // left to resolve and no-ops, instead of re-entering resolveBurst().
  function revertBurstAndEnd(editEl) {
    const burst = currentBurst;
    if (!burst || burst.editEl !== editEl) return;
    burst.history.dispose();
    editEl.innerHTML = burst.original;
    currentBurst = null;
    resetSelToolbarState();
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
    switchAwayFrom().then((ok) => { if (ok) undo(); });
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
    if (!currentBurst || currentBurst.editEl !== editEl) return;
    // Task 4 (Phase 3): a list burst's Enter/Tab/Shift+Tab semantics are
    // materially different from paragraph/heading (split/indent/outdent
    // instead of commit/br) — handleListKeydown() owns that entire surface
    // (including its own Escape/Ctrl+Z/Ctrl+Y, mirrored from below) and
    // returns before any of the paragraph/heading branches run.
    if (currentBurst.blockType === 'list') {
      handleListKeydown(e, editEl);
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

  // Nearest ancestor <li> of `node` (inclusive), never crossing `root` —
  // same walk-up pattern as closestMarkAncestor() above, specialized to LI.
  function closestListItem(node, root) {
    let n = node;
    while (n && n !== root) {
      if (n.nodeType === 1 && n.nodeName === 'LI') return n;
      n = n.parentNode;
    }
    return null;
  }

  function caretListItem(root) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    return closestListItem(sel.getRangeAt(0).startContainer, root);
  }

  // Task 4 fix (review, Critical): a NON-collapsed selection whose two
  // boundary points resolve to DIFFERENT <li> elements (or either resolves
  // to none) has no defined split semantics under the brief's caret-based
  // Enter contract — splitListItemAtCaret()'s Range extractContents() was
  // anchored only to the START container's own <li>, so a cross-item
  // selection silently deleted whatever the selection covered in the OTHER
  // item(s) before the (wrong) split ran. True only for a genuinely
  // cross-item selection; a same-item multi-character selection is still a
  // normal (delete-then-split) Enter, handled by splitListItemAtCaret()
  // itself.
  function selectionSpansMultipleListItems(root) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return false;
    const startLi = closestListItem(range.startContainer, root);
    const endLi = closestListItem(range.endContainer, root);
    return !startLi || !endLi || startLi !== endLi;
  }

  // Any UL/OL that is a direct child of `li` — per list-md.js's documented
  // DOM shape, a nested sublist (if any) is always exactly one such
  // trailing child; scanning ALL children (not just the last) is defensive
  // against an edit having transiently left it somewhere else.
  function directNestedListOf(li) {
    for (let i = 0; i < li.childNodes.length; i++) {
      const c = li.childNodes[i];
      if (c.nodeType === 1 && (c.nodeName === 'UL' || c.nodeName === 'OL')) return c;
    }
    return null;
  }

  // An item is "empty" (brief: "Enter on EMPTY item = remove it") when it
  // has no nested sublist (removing it would orphan real content — refuse
  // that case rather than silently dropping children) and its own text is
  // blank (covers a bare placeholder <br> too — a <br>-only li's
  // textContent is '').
  function isEmptyListItem(li) {
    if (directNestedListOf(li)) return false;
    return li.textContent.replace(/ /g, ' ').trim() === '';
  }

  function placeCaretAtStart(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Splits `li` into two siblings at the caret via Range surgery — the same
  // extractContents()-based pattern wrapRangeIn() above already uses, so
  // inline formatting (a caret mid-<strong>, say) splits cleanly instead of
  // being torn. Everything from the caret to the end of `li`'s own children
  // — INCLUDING a trailing nested sublist, which per list-md.js's
  // documented shape is always li's own last child — moves into the new
  // sibling: a caret positioned before the nested sublist therefore carries
  // it along with the new (second) item. Deliberately simple/deterministic
  // (whichever half the nested sublist physically follows in DOM order)
  // rather than a separate "which half keeps the children" policy.
  function splitListItemAtCaret(li) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0).cloneRange();
    if (!range.collapsed) range.deleteContents(); // collapses to the start point
    const tailRange = document.createRange();
    tailRange.setStart(range.startContainer, range.startOffset);
    tailRange.setEnd(li, li.childNodes.length);
    const tailFrag = tailRange.extractContents();
    const newLi = document.createElement('li');
    newLi.appendChild(tailFrag);
    li.parentNode.insertBefore(newLi, li.nextSibling);
    placeCaretAtStart(newLi);
  }

  // Removes `li` from its list. If that empties out a NESTED sublist (never
  // the burst's own root list — editEl's own parent is the block <div>, not
  // an <li>, so this never touches the root), the now-empty <ul>/<ol> is
  // cleaned up too rather than left dangling.
  function removeListItem(li) {
    const parentList = li.parentNode;
    parentList.removeChild(li);
    if (parentList.childElementCount === 0 &&
        parentList.parentNode && parentList.parentNode.nodeName === 'LI') {
      parentList.parentNode.removeChild(parentList);
    }
  }

  // Tab: `li` becomes the LAST child of its previous sibling's own nested
  // sublist (creating one — matching the CURRENT list's ordered/unordered
  // type — if the previous sibling doesn't have one yet). No previous
  // sibling -> no-op (brief). Returns true iff a mutation actually happened,
  // so the caller only snaps history on a real change.
  function indentListItem(li) {
    const prev = li.previousElementSibling;
    if (!prev || prev.nodeName !== 'LI') return false;
    let nested = directNestedListOf(prev);
    if (!nested) {
      nested = document.createElement(li.parentNode.nodeName === 'OL' ? 'ol' : 'ul');
      prev.appendChild(nested);
    }
    li.parentNode.removeChild(li);
    nested.appendChild(li);
    return true;
  }

  // Shift+Tab: `li` moves out to become the NEXT sibling of the <li> that
  // owns its current list — top level (no owning <li>) -> no-op (brief).
  // Deliberately does NOT also relocate any of `li`'s own following
  // siblings in the list it's leaving — they stay right where they are,
  // still nested under the same parent item; only the outdented item
  // itself moves (documented decision — see the task-4 report).
  function outdentListItem(li) {
    const parentList = li.parentNode;
    const grandLi = parentList.parentNode;
    if (!grandLi || grandLi.nodeName !== 'LI') return false;
    const grandList = grandLi.parentNode;
    parentList.removeChild(li);
    grandList.insertBefore(li, grandLi.nextSibling);
    if (parentList.childElementCount === 0) grandLi.removeChild(parentList);
    return true;
  }

  function handleListKeydown(e, editEl) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        insertBrAtCaret();
        snapBurstIfActive(editEl, 'br');
        return;
      }
      const li = caretListItem(editEl);
      if (!li) return;
      if (selectionSpansMultipleListItems(editEl)) {
        // Refuse rather than silently deleting the spanned content — no
        // mutation, no history snap. Collapse to the end of the selection
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
        return;
      }
      if (isEmptyListItem(li)) {
        removeListItem(li);
        snapBurstIfActive(editEl, 'list-remove');
        editEl.blur(); // ends the burst -> commits, per the brief
        return;
      }
      splitListItemAtCaret(li);
      snapBurstIfActive(editEl, 'list-split');
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const li = caretListItem(editEl);
      if (!li) return;
      const changed = e.shiftKey ? outdentListItem(li) : indentListItem(li);
      if (changed) {
        placeCaretAtEnd(li);
        snapBurstIfActive(editEl, e.shiftKey ? 'list-outdent' : 'list-indent');
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
    const history = historyLib.createBurstHistory(() => tableEl.innerHTML, { debounceMs: 400 });
    history.start();
    currentBurst = {
      blockEl, editEl: tableEl, blockId, blockType: 'table',
      depth: null, original: tableEl.innerHTML, history,
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
  function revertTableBurstAndEnd(cellEl) {
    const burst = currentBurst;
    if (!burst || burst.blockType !== 'table' || burst.editEl !== cellEl.closest('table')) return;
    const tableEl = burst.editEl;
    burst.history.dispose();
    currentBurst = null;
    resetSelToolbarState();
    hideTableInsertBubbles();
    hideTableGrips();
    hideTableEdgeMenu();
    cancelTeDrag();
    tableEl.innerHTML = burst.original;
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
    switchAwayFrom().then((ok) => { if (ok) undo(); });
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
      const ref = row.cells[colIndex];
      row.insertBefore(cell, ref ? ref.nextSibling : null);
    });
  }

  function deleteColumn(tableEl, colIndex) {
    allRowsOf(tableEl).forEach((row) => {
      const cell = row.cells[colIndex];
      if (cell) row.removeChild(cell);
    });
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
  // block id FIRST and, same stale-node recovery the focusin listener uses
  // above, re-resolve the LIVE table by it when the original reference no
  // longer resolves — returning that live element (which callers below now
  // use in place of their own now-possibly-stale `tableEl`) instead of a
  // bare boolean, so a caller can never accidentally keep operating on the
  // detached node it started with.
  async function ensureTableBurstOpen(tableEl) {
    if (currentBurst && currentBurst.blockType === 'table' && currentBurst.editEl === tableEl) return tableEl;
    const blockEl = tableEl.closest('.ed-block');
    const blockId = blockEl ? blockEl.getAttribute('data-block-id') : null;
    const ok = await switchAwayFrom();
    if (!ok) return null;
    let liveTableEl = tableEl;
    if (!document.body.contains(tableEl)) {
      const liveBlockEl = blockId != null ? document.querySelector('.ed-block[data-block-id="' + blockId + '"]') : null;
      liveTableEl = liveBlockEl ? blockContentEl(liveBlockEl) : null;
      if (!liveTableEl || !liveTableEl.classList.contains('ed-wys-table')) return null;
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
  // a row's grip handle (the vertical 6-dot affordance shown just left of
  // the row while hovering it) selects the row the same way, with a
  // delete-only menu. User-acceptance feedback on the ORIGINAL design (an
  // invisible TE_EDGE_PX=8 proximity zone hugging the table's raw top/left
  // pixel edge, with no visible affordance at all) was that it was
  // unusably small — pixel-hunting a click target with no visual cue. The
  // grips below are the fix: real, adequately-sized (≥18×24px) elements the
  // user can actually see and aim for. Both grips are OUTSIDE the table
  // (never inside a contenteditable cell), so — unlike the old zones, which
  // sat INSIDE an already-permanently-contenteditable cell and needed the
  // delegated `pointerdown` listener below to preventDefault() there to
  // stop native caret placement from stealing the click — a grip's own
  // buildTableGrip()-installed `mousedown` preventDefault() is what keeps
  // focus put now (same "keep focus put" idiom buildTableInsertBubble()
  // documents for the hover-insert bubbles above).
  //
  // Row drag starts from the SAME row grip (body rows only — the header
  // <tr> is never draggable, per the brief, and never gets a grip at all):
  // after a small movement threshold (distinguishing "click to open the
  // menu" from "press-and-drag"), a drop-indicator line tracks the pointer
  // between body rows; releasing performs the reorder via a plain
  // `insertBefore()` on the SAME <tr> node (never a clone/innerHTML-
  // replace). The DOM's "insert" algorithm reparents a node in one
  // synchronous step without an observable disconnected state, so — unlike
  // tableBurstUndo()/tableBurstRedo()'s innerHTML-snapshot restore just
  // above — moving the dragged row this way never blurs it even if it
  // happened to contain the active cell, so this needs no
  // suppressTableFocusout guard. The menu's delete ops (which DO remove
  // nodes) sidestep the same hazard a different way — see
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
    teHighlightEls.forEach((el) => el.classList.remove('ed-te-hl'));
    teHighlightEls = [];
  }

  function highlightColumn(tableEl, colIndex) {
    clearEdgeHighlight();
    allRowsOf(tableEl).forEach((row) => {
      const cell = row.cells[colIndex];
      if (cell) { cell.classList.add('ed-te-hl'); teHighlightEls.push(cell); }
    });
  }

  function highlightRow(rowEl) {
    clearEdgeHighlight();
    rowEl.classList.add('ed-te-hl');
    teHighlightEls.push(rowEl);
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
  // handle shown just LEFT of whichever BODY row (never the header — it
  // isn't deletable/draggable, so it never gets one) the pointer is
  // currently hovering any cell of; `colGrip` is a horizontal 6-dot handle
  // shown just ABOVE whichever column the pointer is hovering (every
  // column, header included — the column menu's delete/align both apply to
  // header cells too). Built once by buildTableGrip() below and driven by
  // updateTableEdgeGrips(), called from the SAME rAF-throttled mousemove
  // listener (wired near the bottom of this file) that already drives
  // updateTableInsertBubbles() — see its own comment for the coalescing
  // contract this reuses.
  const TE_GRIP_GAP_PX = 4; // gap, in CSS px, between a grip and the table edge it sits outside of

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
    // (outside the table) stealing focus on mousedown would fire a focusout
    // on the currently-focused cell BEFORE this gesture's own `pointerdown`
    // handler below even runs.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    document.body.appendChild(b);
    return b;
  }
  const rowGrip = buildTableGrip('ed-te-grip-row', '列選項 / 拖曳排序');
  const colGrip = buildTableGrip('ed-te-grip-col', '欄選項');

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
    rowGrip.classList.remove('ed-te-grip-dragging');
    gripRowTableEl = null;
    gripRowEl = null;
    gripColTableEl = null;
    gripColIndex = null;
  }

  // Recomputes grip visibility/position from the latest throttled pointer
  // coordinates — called from the mousemove listener wired near the bottom
  // of this file. `target` is whatever element was directly under the
  // pointer (Event#target) at those coordinates, same contract
  // updateTableInsertBubbles() above uses.
  function updateTableEdgeGrips(x, y, target) {
    // Both grips sit OUTSIDE the table (position: fixed, appended to
    // document.body — same as the hover-insert bubbles), so the moment the
    // real pointer crosses from a cell onto the grip itself, `target` is no
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
    if (!tableEl || !tableEl.classList.contains('ed-wys-table')) { hideTableGrips(); return; }
    const cellEl = target && target.closest && target.closest('th, td');
    if (!cellEl || !tableEl.contains(cellEl)) { hideTableGrips(); return; }

    const tableRect = tableEl.getBoundingClientRect();
    const rowEl = cellEl.parentElement;
    const headerRow = headerRowOf(tableEl);
    const colIndex = colIndexOf(cellEl);

    // Row grip: body rows only — the header row is never deletable/
    // draggable (same rule the retired edge-zone drag gate applied).
    if (rowEl && rowEl !== headerRow) {
      gripRowTableEl = tableEl;
      gripRowEl = rowEl;
      const r = rowEl.getBoundingClientRect();
      // Fallback dims match .ed-te-grip-row's own CSS width/height exactly
      // (20x28) — offsetWidth/Height read 0 while `hidden` (display: none)
      // is still true on the FIRST show of a hover session, before the
      // `hidden = false` assignment below takes effect.
      const gh = rowGrip.offsetHeight || 28;
      const gw = rowGrip.offsetWidth || 20;
      rowGrip.style.left = (tableRect.left - gw - TE_GRIP_GAP_PX) + 'px';
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
    colGrip.style.top = (tableRect.top - cgh - TE_GRIP_GAP_PX) + 'px';
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
      return { kind: 'row', tableEl: gripRowTableEl, rowEl: gripRowEl, isHeader: false };
    }
    if (target.closest('.ed-te-grip-col')) {
      if (!gripColTableEl || gripColIndex == null) return null;
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

  // Nearest body-row boundary to `clientY` — header excluded (drops always
  // clamp to the body, per the brief), same "boundary per row" shape
  // insertRow()'s hover-boundary geometry above uses, just decided by
  // proximity (a drag always has SOME nearest boundary) rather than a fixed
  // threshold.
  function nearestRowDropTarget(tableEl, clientY) {
    const rows = bodyRowsOf(tableEl);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return { beforeRow: rows[i], y: r.top };
    }
    const last = rows[rows.length - 1];
    const headerRow = headerRowOf(tableEl);
    const y = last ? last.getBoundingClientRect().bottom
      : (headerRow ? headerRow.getBoundingClientRect().bottom : tableEl.getBoundingClientRect().top);
    return { beforeRow: null, y };
  }

  // The in-flight edge-zone pointer gesture (press-then-either-click-or-
  // drag), or null between gestures. `hit` is whatever hitTestGrip()
  // returned at pointerdown; `dragging` flips true once TE_DRAG_THRESHOLD_PX
  // is crossed (row zones only — see the pointermove listener below);
  // `dropBeforeRow` is filled in by updateDropIndicator() as the pointer
  // moves while dragging. `pointerId`/`captureEl` back the pointer-capture
  // review fix below — see cancelTeDrag()'s comment for why this gesture
  // needs it at all.
  let tePointer = null;

  function updateDropIndicator(clientY) {
    const tableEl = tePointer.hit.tableEl;
    const target = nearestRowDropTarget(tableEl, clientY);
    tePointer.dropBeforeRow = target.beforeRow;
    const tableRect = tableEl.getBoundingClientRect();
    teDropIndicator.style.left = tableRect.left + 'px';
    teDropIndicator.style.width = tableRect.width + 'px';
    teDropIndicator.style.top = (target.y - 1) + 'px';
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
      tePointer.hit.rowEl.classList.remove('ed-te-row-dragging');
    }
    // The row grip may still be wearing its "active drag handle" visual
    // (see the pointermove listener below) — strip it unconditionally, same
    // belt-and-braces reasoning as the `ed-te-row-dragging` removal above.
    rowGrip.classList.remove('ed-te-grip-dragging');
    teDropIndicator.hidden = true;
    tePointer = null;
  }

  async function performRowDrop(tableEl, rowEl, beforeRow) {
    // Final-review Finding 6: `rowEl`/`beforeRow` are DOM nodes captured at
    // pointerdown/during the drag — same staleness hazard runDeleteRow()
    // now guards against (a dirty burst on a DIFFERENT block, resolved
    // inside ensureTableBurstOpen() below, swaps `.content` and detaches
    // every node this table's drag was tracking, not just the ones on the
    // block that committed). Snapshot both as ORDINAL row positions before
    // that can happen, then re-locate them by position in the live table
    // afterward, mirroring runDeleteRow()'s own index-based recovery.
    const rowIndex = allRowsOf(tableEl).indexOf(rowEl);
    const beforeRowIndex = beforeRow ? allRowsOf(tableEl).indexOf(beforeRow) : -1;
    const liveTableEl = await ensureTableBurstOpen(tableEl);
    if (!liveTableEl) return;
    const liveRows = allRowsOf(liveTableEl);
    const liveRowEl = rowIndex >= 0 ? liveRows[rowIndex] : null;
    const liveBeforeRow = beforeRowIndex >= 0 ? liveRows[beforeRowIndex] : null;
    if (!liveRowEl) return;
    const tbody = liveTableEl.tBodies[0];
    if (!tbody || liveRowEl.parentElement !== tbody) return;
    const prevNext = liveRowEl.nextSibling;
    if (liveBeforeRow && liveBeforeRow.parentElement === tbody) tbody.insertBefore(liveRowEl, liveBeforeRow);
    else tbody.appendChild(liveRowEl);
    // Skip the snap when the drop landed exactly where the row already was
    // (e.g. dropped back onto itself) — no actual reorder happened, so
    // there's nothing worth adding to the burst's undo history.
    if (liveRowEl.nextSibling !== prevNext) currentBurst.history.snap('drag-row');
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
    if (teMenuKind && !isSameSelection) hideTableEdgeMenu();
    if (!hit) return;
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
    if (tePointer.hit.kind !== 'row' || tePointer.hit.isHeader) return; // only draggable body-row zones arm a drag
    if (!tePointer.dragging) {
      const dx = e.clientX - tePointer.startX, dy = e.clientY - tePointer.startY;
      if (Math.hypot(dx, dy) < TE_DRAG_THRESHOLD_PX) return;
      tePointer.dragging = true;
      hideTableEdgeMenu();
      hideTableInsertBubbles();
      // The column grip hides like the insert bubbles above (it isn't
      // meaningful mid row-drag); the ROW grip stays visible and switches to
      // its "dragging" visual (grabbing cursor) — it IS the drag handle the
      // user is holding, per the brief ("the active grip may stay as the
      // drag handle visual").
      colGrip.hidden = true;
      rowGrip.classList.add('ed-te-grip-dragging');
      tePointer.hit.rowEl.classList.add('ed-te-row-dragging');
      teDropIndicator.hidden = false;
    }
    e.preventDefault();
    updateDropIndicator(e.clientY);
  });

  document.addEventListener('pointerup', async (e) => {
    if (!tePointer) return;
    const st = tePointer;
    releaseTeCapture(st);
    tePointer = null;
    if (st.dragging) {
      st.hit.rowEl.classList.remove('ed-te-row-dragging');
      rowGrip.classList.remove('ed-te-grip-dragging');
      teDropIndicator.hidden = true;
      await performRowDrop(st.hit.tableEl, st.hit.rowEl, st.dropBeforeRow);
      return;
    }
    // A plain press-release with no drag threshold crossed: open the menu
    // for whatever zone was hit at pointerdown.
    if (st.hit.kind === 'col') showColumnMenu(st.hit.tableEl, st.hit.colIndex);
    else showRowMenu(st.hit.tableEl, st.hit.rowEl);
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
  // (STRONG/EM/CODE/A, see inline-md.js's walkChildren) — never a <span>,
  // which the serializer treats as either transparent (no attributes) or
  // unsupported (styled). No execCommand anywhere below — every mutation is
  // plain Range/Node surgery (extractContents/insertNode/insertBefore).
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

  // Applies the toggle policy for a plain mark type (STRONG/EM/CODE — link
  // has its own entry point below because it also needs a URL prompt).
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
    document.addEventListener('mousedown', (e) => {
      if (e.target && e.target.closest && e.target.closest('.ed-handle')) e.preventDefault();
    });
    document.addEventListener('click', async (e) => {
      if (!e.target || !e.target.closest) { await switchAwayFrom(); closeGutterMenu(); return; }
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
      // ⠿ handle: toggles its menu for the block it belongs to. ⠿ menu: its
      // own buttons handle themselves (stopPropagation()). Either way, this
      // click is fully handled here — never falls through to the
      // open-a-block logic below.
      const handleEl = e.target.closest('.ed-handle');
      if (handleEl) { toggleGutterMenu(handleEl.closest('.ed-block')); return; }
      if (e.target.closest('.ed-handle-menu')) return;
      // Any other click closes an already-open ⠿ menu.
      if (gutterMenuBlockEl) closeGutterMenu();
      if (e.target.closest(ED_LIGHTBOX_TARGETS)) return; // let the lightbox open, unchanged
      let blockEl = e.target.closest('.ed-block');
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
        body: JSON.stringify({ fileId: ED.fileId, content: lines.join('\n'), baseMtimeMs: mtimeMs }),
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
    const ok = await safeRerenderAll();
    if (!ok) {
      // Reverse the redo attempt: pop the op back off and restore `lines`.
      const rollback = stack.undo(lines);
      lines = rollback ? rollback.lines : prevLines;
    }
  }

  // ── global key handling ─────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
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
    if (teMenuKind && e.key === 'Escape') {
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
    const cellEl = e.target && e.target.closest && e.target.closest('.ed-wys-cell');
    if (cellEl) {
      handleTableCellKeydown(e, cellEl);
      return;
    }

    // Task 2 (Phase 3): a paragraph/heading/list always-on WYSIWYG burst
    // surface — Enter/Shift+Enter/Esc/Ctrl+Z/Ctrl+Y are all handled
    // per-surface by handleBurstKeydown() above (which also owns
    // preventDefault() for those keys), so nothing below this must run for
    // it either.
    const wysArmedEl = e.target && e.target.closest && e.target.closest('.ed-wys-armed');
    if (wysArmedEl) {
      handleBurstKeydown(e, wysArmedEl);
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      closeGutterMenu();
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
      // every real drag. Explicitly HIDE the insert bubbles and the column
      // grip (not just skip recomputing) so anything already showing from
      // the moment just before the drag threshold was crossed doesn't linger
      // stale for the rest of the gesture. The ROW grip is deliberately left
      // untouched here — the pointermove listener above already switched it
      // to its "dragging" visual (see `ed-te-grip-dragging`) as the drag's
      // own handle, and this gate must not fight that by hiding it or
      // repositioning it onto whatever row the cursor happens to be over.
      if (tePointer && tePointer.dragging) { hideTableInsertBubbles(); colGrip.hidden = true; return; }
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
