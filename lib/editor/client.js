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
    module.exports = { extractBlockSource, commitEdit, headingDepthOf, withHeadingDepth };
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
    // Same reasoning applies to the click-to-select edit bar: whatever block
    // had it open a moment ago was just destroyed by the innerHTML
    // replacement above, so `selectedBlockEl` — and the bar node itself, if
    // it was still attached there — must not survive the swap. Reset
    // unconditionally here too, so a future call site can never reproduce a
    // stale-node leak the way the activeEditor lockout once did.
    dismissBar();
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
      // below) already resolves this on the block-click that selects
      // `blockEl` before its bar's ✎ button can be clicked, so by the time
      // openRawEditor() runs here `activeEditor` is normally already null;
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

    // Strip any live edit bar BEFORE capturing the "restore to" HTML. The
    // bar's own buttons are DOM-wired (addEventListener in buildBar()), not
    // something innerHTML round-tripping preserves — capturing it here
    // would let restore() below "revive" a dead, listener-less copy of it.
    // Normally the bar is already gone by the time openRawEditor() runs
    // (the ✎ button's own click handler calls dismissBar() first — see
    // buildBar() below), but this stays as a belt-and-braces guard against
    // a future call site that forgets to.
    if (selectedBlockEl === blockEl) dismissBar();
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
    if (!ok || !document.body.contains(blockEl)) return;
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

  // Arms every WYSIWYG-eligible paragraph/heading in `root` as an always-on
  // contenteditable surface, and gives every non-table block (eligible or
  // degraded alike) a ⠿ handle in its left gutter. Run once at load and
  // again after every rerenderAll() swap (fresh DOM, nothing armed yet).
  // Idempotent-by-construction: only ever called against a freshly-rendered
  // subtree that has never been armed before.
  function armEditables(root) {
    const blockEls = Array.prototype.slice.call(root.querySelectorAll('.ed-block'));
    blockEls.forEach((blockEl) => {
      const blockType = blockEl.getAttribute('data-block-type');
      if (blockType === 'table') return; // T5's job — left entirely alone.
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
      }
      // Every non-table block (armed or degraded) gets the ⠿ handle — a
      // real per-block DOM node (not a listener: see buildGutterHandle()'s
      // comment for why that's fine), appended AFTER the content element so
      // blockContentEl()'s firstElementChild lookup is unaffected.
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
    return el;
  }

  // The single shared ⠿ menu (heading ± / MD 原始碼 / close) — built once,
  // moved into whichever block's DOM the user opened it on, same pattern as
  // `bar`/`selToolbar` elsewhere in this file. `gutterMenuBlockEl` names
  // which block it's currently open for.
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
    if (!burst) return true;
    burst.history.flushTyping();
    // Task 4 (Phase 3): a list burst serializes through list-md.js's
    // serializeList() (it takes the list ROOT element, exactly what
    // burst.editEl already is for a 'list' burst — see armEditables() above)
    // instead of inline-md.js's serializeInline(); every other block type
    // (paragraph/heading) keeps using serializeInline() unchanged.
    const result = burst.blockType === 'list'
      ? listMd.serializeList(burst.editEl)
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
    const commitResult = commitEdit({ lines, blocks, stack }, burst.blockId, newText);
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
    // braces, same idiom as activeEditor/dismissBar()/resetSelToolbarState()
    // elsewhere in this file — unconditionally nulled `currentBurst` and
    // disposed its history. Nothing left to do here.
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
  // applying"). A no-op when `root` isn't the currently-focused burst's edit
  // surface (e.g. a Task 5 table-cell session, which never sets
  // `currentBurst` at all and keeps using its own undo-less commit model).
  function snapBurstIfActive(root, reason) {
    if (currentBurst && currentBurst.editEl === root) currentBurst.history.snap(reason);
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

  // ── Phase-2 Task 5: table cell WYSIWYG editing ──────────────────────────
  // Interaction model deliberately differs from the paragraph/heading flow
  // above: a table has many independently-editable cells, so a click that
  // lands directly on a TH/TD (see wireBlockSelection() below) opens the
  // WHOLE table's session AND makes that specific cell the initial edit
  // root in one step — no separate ✎ click required (though ✎ still works
  // as a fallback: it opens the session with the FIRST cell active). Only
  // ONE cell is contenteditable at a time; Tab/Shift+Tab move which cell is
  // active WITHOUT ending the session. The whole session still commits as
  // ONE line-range replacement (one undo op) when it ends: Esc reverts
  // EVERYTHING typed this session — a deliberate departure from the
  // paragraph editor's per-block Esc above, per the brief — and clicking
  // outside the table (or opening a different block, or undo/redo)
  // auto-commits via the existing switchAwayFrom() substrate, unchanged.
  //
  // Fixed Tab-navigation order: document order of every TH/TD, which for a
  // table (thead before tbody, rows/cells in source order) is exactly
  // header-row-left-to-right then each body row left-to-right. Real DOM
  // (not the node-test stub), so querySelectorAll is fair game here —
  // unlike table-md.js, this file has never been childNodes-only.
  function tableCellsOf(tableEl) {
    return Array.prototype.slice.call(tableEl.querySelectorAll('th, td'));
  }

  function openTableEditor(blockEl, block, initialCell) {
    const blockId = block.id;
    const tableEl = blockContentEl(blockEl);
    if (!tableEl) return;

    // Captured before any cell becomes contenteditable — cancel() restores
    // this verbatim, same role as openWysiwygEditor()'s `original` above.
    const original = tableEl.innerHTML;
    // hasChanges() below re-serializes the LIVE (possibly mid-edit) table on
    // every call and compares against this baseline — never innerHTML, same
    // reasoning as openWysiwygEditor()'s `originalMd`.
    const originalMd = tableMd.serializeTable(tableEl).md;

    let activeCellEl = null;

    function deactivateCell() {
      if (!activeCellEl) return;
      activeCellEl.removeAttribute('contenteditable');
      activeCellEl.classList.remove('ed-wys');
      activeCellEl.removeEventListener('keydown', onCellKeydown);
      activeCellEl.removeEventListener('paste', onCellPaste);
      activeCellEl = null;
    }

    function activateCell(cellEl) {
      if (!cellEl || cellEl === activeCellEl) return;
      deactivateCell();
      cellEl.setAttribute('contenteditable', 'true');
      cellEl.classList.add('ed-wys');
      cellEl.addEventListener('keydown', onCellKeydown);
      cellEl.addEventListener('paste', onCellPaste);
      activeCellEl = cellEl;
      // Task 4 substrate reuse (brief's explicit instruction: "wire your
      // cell edit root the same way paragraph editing does"): the selection
      // toolbar keys off this module-scope variable, re-read fresh on every
      // selectionchange firing. Updating it here — WITHOUT touching the
      // document listener itself, attached once below for the whole session
      // — is what lets the toolbar keep working as Tab moves the active
      // cell.
      selToolbarEditEl = cellEl;
      cellEl.focus();
      placeCaretAtEnd(cellEl);
    }

    function moveActiveCell(delta) {
      const cells = tableCellsOf(tableEl);
      const idx = activeCellEl ? cells.indexOf(activeCellEl) : -1;
      const next = Math.max(0, Math.min(cells.length - 1, idx + delta));
      activateCell(cells[next]);
    }

    // Named (not inline-anonymous) so deactivateCell() above can
    // removeEventListener them by reference — same discipline as
    // openWysiwygEditor()'s onKeydown/onPaste.
    function onCellKeydown(e) {
      if (e.key === 'Enter') {
        // Brief: "Enter inside a cell inserts <br>" — unconditionally,
        // unlike the paragraph editor where plain Enter commits and only
        // Shift+Enter inserts a <br>. A table cell session has no
        // Enter-commits-session gesture at all (see the section comment
        // above: only an outside click or Esc ends the session).
        e.preventDefault();
        insertBrAtCaret();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        moveActiveCell(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    }
    function onCellPaste(e) {
      e.preventDefault();
      const dt = e.clipboardData || window.clipboardData;
      insertTextAtCaret(dt ? dt.getData('text/plain') : '');
    }

    // Clicking a DIFFERENT cell while the session is already open switches
    // the active cell. wireBlockSelection()'s document-level delegate lets
    // clicks INSIDE the already-open block's own editor through untouched
    // (`activeEditor.blockEl === blockEl` -> return), so this table-scoped
    // listener is what makes those clicks do anything at all.
    function onTableClick(e) {
      const cell = e.target.closest('th, td');
      if (cell && tableEl.contains(cell)) activateCell(cell);
    }
    tableEl.addEventListener('click', onTableClick);

    function cancel() {
      deactivateCell();
      tableEl.removeEventListener('click', onTableClick);
      tableEl.innerHTML = original;
      if (activeEditor && activeEditor.blockEl === blockEl) activeEditor = null;
      resetSelToolbarState();
      dismissBar();
    }

    // Same commit/rollback shape (and the same true/false return contract
    // for switchAwayFrom()) as openWysiwygEditor()'s commit() above.
    async function commit() {
      const result = tableMd.serializeTable(tableEl);
      if (result.unsupported.length > 0) {
        // Degrade-never-lose: a browser-native rich paste/drag-drop could
        // still land unsupported markup in a cell mid-session even though
        // the whole table passed canWysiwygForTable() at open time. Same
        // resolution as openWysiwygEditor()'s commit(): drop it, fall back
        // to raw-edit prefilled from the block's UNTOUCHED source (`lines`
        // was never written to by this session), and return false so
        // whatever caller invoked commitNow() (switchAwayFrom() on behalf
        // of a click on some OTHER block, or undo/redo) aborts instead of
        // proceeding as if this resolved cleanly.
        showBanner('含不支援的格式，改用原始碼編輯', null, null);
        cancel();
        openRawEditor(blockEl);
        return false;
      }
      const commitResult = commitEdit({ lines, blocks, stack }, blockId, result.md);
      if (commitResult.op === null) {
        cancel();
        return true;
      }
      const prevLines = lines;
      lines = commitResult.lines;
      const ok = await safeRerenderAll();
      if (!ok) {
        const rollback = stack.undo(lines);
        lines = rollback ? rollback.lines : prevLines;
        return false;
      }
      // Success: rerenderAll() already replaced the whole .content subtree
      // (this table included), nulled activeEditor, dismissed the bar, and
      // reset the selection-toolbar state — nothing left to do here.
      return true;
    }

    activeEditor = {
      blockEl, isWys: true,
      hasChanges: () => tableMd.serializeTable(tableEl).md !== originalMd,
      commitNow: commit, cancelNow: cancel,
      // Phase-2 Task 6: exposes the session's `activeCellEl` (this
      // closure's "last-focused cell") to the ed-bar's row/column-op button
      // handlers (runTableStructureOp() below, defined outside this
      // closure) — those act on the row/column of whichever cell was most
      // recently focused via activateCell(), same variable Tab/click
      // navigation already keeps current.
      getFocusedCell: () => activeCellEl,
    };
    updateBarButtons(blockEl);

    // The document-level selectionchange listener is attached ONCE for the
    // whole session (not re-attached per cell) — see activateCell()'s
    // comment for why updating `selToolbarEditEl` alone is enough to keep
    // the toolbar following whichever cell is active.
    selToolbarListener = onSelectionChangeForToolbar;
    document.addEventListener('selectionchange', onSelectionChangeForToolbar);

    activateCell(initialCell || tableCellsOf(tableEl)[0]);
  }

  // ── Phase-2 Task 6: table structure ops (row/col add/del, alignment) ────
  // Buttons on the ed-bar (wired in buildBar() below): ＋列 / －列 / ＋欄 /
  // －欄 / 對齊, shown whenever a TABLE block is selected (updateBarButtons()
  // below) — independent of whether a cell-editing session is already open,
  // per the brief's explicit "decide and document" note. Chosen policy
  // (simplest option the brief offered): a button click AUTO-OPENS the
  // table's WYSIWYG session (first cell active, same as ✎) if none is open
  // yet on this block, mutates the LIVE table DOM, then immediately calls
  // the session's own commitNow() — reusing openTableEditor()'s existing
  // commit() unchanged, including its degrade-to-raw-edit fallback for a
  // table that turns out not to round-trip (no separate pre-check needed
  // here). Each op is a discrete, one-shot edit (same shape as
  // changeHeadingDepth()'s ± buttons above), not a sustained typing
  // session — the table session ends immediately after (rerenderAll()
  // replaces the whole .content subtree on a successful commit, same as
  // every other commit path in this file).
  //
  // Row ops act on the row containing the session's last-focused cell
  // (activeEditor.getFocusedCell(), set above); column ops on that cell's
  // column index, read via the real DOM's native `<tr>.cells` (this file —
  // unlike table-md.js's node-stub-constrained walk — has always used real
  // DOM APIs). Alignment is read/written on the HEADER cell only for
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
  // focused ＋列 falls through to this same first-body-row placement rather
  // than being refused (only deletion of the header is refused — see
  // runTableStructureOp()'s 'row-' branch below).
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

  // Shared handler for all five table-structure ed-bar buttons. `kind` is
  // one of 'row+' / 'row-' / 'col+' / 'col-' / 'align'.
  async function runTableStructureOp(kind) {
    const blockEl = selectedBlockEl;
    if (!blockEl || blockEl.getAttribute('data-block-type') !== 'table') return;
    const blockId = Number(blockEl.getAttribute('data-block-id'));
    const block = blocks.find((b) => b.id === blockId);
    if (!block) return;

    if (!activeEditor || activeEditor.blockEl !== blockEl || !activeEditor.isWys) {
      // No table session open on this block yet — resolve whatever OTHER
      // editor might be open first (same precondition changeHeadingDepth()
      // above uses; unreachable in normal use since wireBlockSelection()
      // already resolves this before the bar for `blockEl` can be showing
      // at all, but kept as the same defensive belt-and-braces), then
      // auto-open a table session with the first cell active — see the
      // section comment above for why this is the chosen "no session yet"
      // behavior instead of requiring an explicit ✎ click first.
      const ok = await switchAwayFrom();
      if (!ok || !document.body.contains(blockEl)) return;
      // Review fix (Important 1): mirror editBtn's own routing (buildBar()
      // below) — a table with ANY unsupported cell must degrade straight to
      // raw-edit, same as every other entry point (✎, direct cell click).
      // Without this gate, an op button would open a session on an
      // unsupported table anyway, mutate the DOM, and only discover the
      // problem at commitNow() — which THEN degrades to raw-edit but has
      // already thrown away the structural op the user just performed. Gate
      // BEFORE opening, not after, so the op is never silently lost.
      if (!canWysiwygForTable(blockContentEl(blockEl))) {
        dismissBar();
        openRawEditor(blockEl);
        return;
      }
      openTableEditor(blockEl, block);
    }
    if (!activeEditor || activeEditor.blockEl !== blockEl || !activeEditor.isWys) return;

    const tableEl = blockContentEl(blockEl);
    const focusedCell = activeEditor.getFocusedCell();
    if (!tableEl || !focusedCell) return;

    const row = focusedCell.parentElement;
    const colIndex = colIndexOf(focusedCell);

    if (kind === 'row+') {
      insertRow(tableEl, row.parentElement === tableEl.tBodies[0] ? row : null);
    } else if (kind === 'row-') {
      if (focusedCell.tagName === 'TH') {
        showBanner('無法刪除標題列', null, null);
        return;
      }
      if (bodyRowsOf(tableEl).length <= 1) {
        showBanner('無法刪除最後一列', null, null);
        return;
      }
      deleteRow(row);
    } else if (kind === 'col+') {
      insertColumn(tableEl, colIndex);
    } else if (kind === 'col-') {
      const headerRow = headerRowOf(tableEl);
      if (!headerRow || headerRow.cells.length <= 1) {
        showBanner('無法刪除最後一欄', null, null);
        return;
      }
      deleteColumn(tableEl, colIndex);
    } else if (kind === 'align') {
      cycleColumnAlign(tableEl, colIndex);
    } else {
      return;
    }

    await activeEditor.commitNow();
  }

  // ── Phase-2 Task 4: floating selection toolbar (bold/italic/code/link) ──
  // Shown over a non-collapsed selection INSIDE the active WYSIWYG editor's
  // content element (see openWysiwygEditor() above, which attaches/detaches
  // the selectionchange listener driving this per session); hidden on
  // commit/cancel/selection-collapse; never shown outside a WYSIWYG session.
  // Built once (like `bar` below) and moved via document.body append/remove
  // rather than re-created per session.
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
  // `activeEditor`/dismissBar() — see its call site's comment.
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
  // ONE listener, attached ONCE per session, keeps working for
  // openTableEditor() too as Tab/click moves which cell is active (brief:
  // "wire your cell edit root the same way paragraph editing does (reuse,
  // don't fork)").
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

  // ── click-to-select edit bar (Task 2, Phase 3: TABLE-ONLY survivor) ─────
  // T5 hasn't armed tables yet (Global Constraint: "DO NOT arm them in this
  // task"), so the Phase-2 click-select-then-bar flow survives here
  // UNCHANGED for table blocks only — same floating bar (built once, moved
  // between blocks), same .ed-selected outline, same delegated `document`
  // click listener. Paragraph/heading blocks no longer use ANY of this
  // (they're always-on contenteditable — see armEditables()/the burst
  // section above); their old ✎/MD/± bar buttons are gone, replaced by the
  // ⠿ handle + its own small menu (buildGutterMenu() above).
  const ED_LIGHTBOX_TARGETS =
    'img, .mermaid, .graphviz, [id^="WaveDrom_Display_"], .wavedrom-diagram';
  let selectedBlockEl = null;

  // References populated by buildBar() below. Task 2 (Phase 3): ± retired
  // along with the bar's paragraph/heading role (headings get their ± from
  // the ⠿ menu now — see changeHeadingDepth()/buildGutterMenu() above);
  // editBtn/mdBtn survive TABLE-SCOPED ONLY — showBarFor() is only ever
  // called for a table block (see wireBlockSelection() below), so these are
  // reachable exclusively through that path now, but their behavior for an
  // unsupported-table degrade / an open table WYSIWYG session's raw escape
  // hatch stays byte-for-byte the Phase-2 original.
  let editBtn, mdBtn;
  // Phase-2 Task 6: table structure-op buttons (row/col add/del, alignment).
  let rowPlusBtn, rowMinusBtn, colPlusBtn, colMinusBtn, alignBtn;

  function buildBar() {
    const b = document.createElement('div');
    b.className = 'ed-bar';

    editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'ed-bar-btn ed-bar-edit';
    editBtn.textContent = '✎ 編輯';
    editBtn.setAttribute('aria-label', 'Edit block');
    // Task 2 (Phase 3): only ever reachable for a TABLE block now (see the
    // comment on the `editBtn` declaration above) — a table whose every
    // cell round-trips gets the table WYSIWYG session; anything else
    // (unsupported cell content) falls back to raw-edit, same as Phase 2.
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const blockEl = selectedBlockEl;
      if (!blockEl) return;
      const blockId = Number(blockEl.getAttribute('data-block-id'));
      const block = blocks.find((bl) => bl.id === blockId);
      if (!block) { dismissBar(); return; }
      if (canWysiwygForTable(blockContentEl(blockEl))) {
        openTableEditor(blockEl, block);
      } else {
        dismissBar();
        openRawEditor(blockEl);
      }
    });

    mdBtn = document.createElement('button');
    mdBtn.type = 'button';
    mdBtn.className = 'ed-bar-btn ed-bar-md';
    mdBtn.textContent = 'MD';
    mdBtn.setAttribute('aria-label', 'Switch to raw markdown edit');
    mdBtn.hidden = true;
    // Escape hatch: discards the in-progress table WYSIWYG session (same as
    // Esc) and reopens the block via the raw textarea, prefilled from
    // `lines` (untouched, since the WYSIWYG session never committed).
    mdBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const blockEl = selectedBlockEl;
      if (!blockEl || !activeEditor || activeEditor.blockEl !== blockEl) return;
      activeEditor.cancelNow();
      openRawEditor(blockEl);
    });

    // Phase-2 Task 6: table structure ops — shown whenever a TABLE block is
    // selected (see updateBarButtons() below), independent of whether a
    // cell-editing session is already open on it. Each click routes through
    // the shared runTableStructureOp() handler (defined above, near
    // openTableEditor()), which auto-opens the session if needed.
    rowPlusBtn = document.createElement('button');
    rowPlusBtn.type = 'button';
    rowPlusBtn.className = 'ed-bar-btn ed-bar-row-plus';
    rowPlusBtn.textContent = '＋列';
    rowPlusBtn.setAttribute('aria-label', 'Add row');
    rowPlusBtn.hidden = true;
    rowPlusBtn.addEventListener('click', (e) => { e.stopPropagation(); runTableStructureOp('row+'); });

    rowMinusBtn = document.createElement('button');
    rowMinusBtn.type = 'button';
    rowMinusBtn.className = 'ed-bar-btn ed-bar-row-minus';
    rowMinusBtn.textContent = '－列';
    rowMinusBtn.setAttribute('aria-label', 'Delete row');
    rowMinusBtn.hidden = true;
    rowMinusBtn.addEventListener('click', (e) => { e.stopPropagation(); runTableStructureOp('row-'); });

    colPlusBtn = document.createElement('button');
    colPlusBtn.type = 'button';
    colPlusBtn.className = 'ed-bar-btn ed-bar-col-plus';
    colPlusBtn.textContent = '＋欄';
    colPlusBtn.setAttribute('aria-label', 'Add column');
    colPlusBtn.hidden = true;
    colPlusBtn.addEventListener('click', (e) => { e.stopPropagation(); runTableStructureOp('col+'); });

    colMinusBtn = document.createElement('button');
    colMinusBtn.type = 'button';
    colMinusBtn.className = 'ed-bar-btn ed-bar-col-minus';
    colMinusBtn.textContent = '－欄';
    colMinusBtn.setAttribute('aria-label', 'Delete column');
    colMinusBtn.hidden = true;
    colMinusBtn.addEventListener('click', (e) => { e.stopPropagation(); runTableStructureOp('col-'); });

    alignBtn = document.createElement('button');
    alignBtn.type = 'button';
    alignBtn.className = 'ed-bar-btn ed-bar-align';
    alignBtn.textContent = '對齊';
    alignBtn.setAttribute('aria-label', 'Cycle column alignment');
    alignBtn.hidden = true;
    alignBtn.addEventListener('click', (e) => { e.stopPropagation(); runTableStructureOp('align'); });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ed-bar-btn ed-bar-close';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Dismiss edit bar');
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissBar();
    });
    b.appendChild(rowPlusBtn);
    b.appendChild(rowMinusBtn);
    b.appendChild(colPlusBtn);
    b.appendChild(colMinusBtn);
    b.appendChild(alignBtn);
    b.appendChild(editBtn);
    b.appendChild(mdBtn);
    b.appendChild(closeBtn);
    return b;
  }

  const bar = buildBar();

  // Toggles which bar buttons are visible for the given (selected) block:
  // MD only while a table WYSIWYG session is actively open on this exact
  // block (✎ hidden in that state — there's nothing left to route, it's
  // already editing); the five table structure-op buttons show for ANY
  // selected table block — not gated on isWysEditing, since a click
  // auto-opens the session (see runTableStructureOp() above). Task 2
  // (Phase 3): showBarFor() is only ever called for a table block now (see
  // wireBlockSelection() below), so `blockType` is always 'table' here in
  // practice — the check is kept explicit rather than assumed.
  function updateBarButtons(blockEl) {
    const isTable = blockEl.getAttribute('data-block-type') === 'table';
    const isWysEditing = !!(activeEditor && activeEditor.blockEl === blockEl && activeEditor.isWys);
    editBtn.hidden = isWysEditing;
    mdBtn.hidden = !isWysEditing;
    rowPlusBtn.hidden = !isTable;
    rowMinusBtn.hidden = !isTable;
    colPlusBtn.hidden = !isTable;
    colMinusBtn.hidden = !isTable;
    alignBtn.hidden = !isTable;
  }

  // Detach the bar and drop the selected-block outline. Safe to call any
  // time, including when nothing is selected (`bar.remove()` on an already
  // -detached node, and a null `selectedBlockEl` check, are both no-ops).
  function dismissBar() {
    if (selectedBlockEl) selectedBlockEl.classList.remove('ed-selected');
    bar.remove();
    selectedBlockEl = null;
  }

  function showBarFor(blockEl) {
    if (selectedBlockEl === blockEl) return; // already selected
    if (selectedBlockEl) selectedBlockEl.classList.remove('ed-selected');
    selectedBlockEl = blockEl;
    blockEl.classList.add('ed-selected');
    blockEl.appendChild(bar); // moves the bar; CSS anchors it to the top edge
    updateBarButtons(blockEl);
  }

  // Single delegated listener, wired once at the bottom of this file. Async
  // because clicking another block (or outside any block) while some
  // block's editor/burst is open must resolve it first via switchAwayFrom()
  // — see the `activeEditor` / `currentBurst` comments near their
  // declarations. Task 2 (Phase 3): scope narrowed to TABLE blocks (Phase-2
  // click-select-then-bar, unchanged), the ⠿ handle/menu, and opening a
  // DEGRADED (non-table, non-WYSIWYG-eligible) block's raw editor
  // immediately on click — paragraph/heading WYSIWYG blocks are always-on
  // contenteditable and need no click routing at all here; native focus
  // (the delegated focusin/focusout listeners below) does the rest.
  function wireBlockSelection() {
    document.addEventListener('click', async (e) => {
      if (!e.target || !e.target.closest) { await switchAwayFrom(); dismissBar(); closeGutterMenu(); return; }
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
      if (e.target.closest('.ed-bar')) return; // the bar's own (table-only) buttons handle themselves
      if (e.target.closest('.ed-seltb')) return; // the selection toolbar's own buttons handle themselves
      // ⠿ handle: toggles its menu for the block it belongs to. ⠿ menu: its
      // own buttons handle themselves (stopPropagation()). Either way, this
      // click is fully handled here — never falls through to the
      // open-a-block logic below.
      const handleEl = e.target.closest('.ed-handle');
      if (handleEl) { toggleGutterMenu(handleEl.closest('.ed-block')); return; }
      if (e.target.closest('.ed-handle-menu')) return;
      // Any other click closes an already-open ⠿ menu (same "click outside
      // dismisses" convention the old bar used for `.ed-selected`).
      if (gutterMenuBlockEl) closeGutterMenu();
      if (e.target.closest(ED_LIGHTBOX_TARGETS)) return; // let the lightbox open, unchanged
      let blockEl = e.target.closest('.ed-block');
      if (!blockEl) { await switchAwayFrom(); dismissBar(); return; } // clicked outside any block

      if (blockEl.getAttribute('data-block-type') === 'table') {
        // This block's raw editor is already open: let the click behave
        // natively (caret placement inside the textarea) instead of
        // re-running the select/switch dance on every click inside it.
        if (activeEditor && activeEditor.blockEl === blockEl) return;
        // A DIFFERENT block's editor/burst may be open — resolve it first.
        // A successful auto-commit replaces the whole .content subtree
        // (rerenderAll), which detaches `blockEl` — re-resolve the live
        // node by its stable block id once switchAwayFrom() settles.
        const blockId = blockEl.getAttribute('data-block-id');
        const ok = await switchAwayFrom();
        if (!ok) return; // the open editor's auto-commit failed; stay put
        blockEl = document.querySelector('.ed-block[data-block-id="' + blockId + '"]') || blockEl;
        showBarFor(blockEl);
        // Phase-2 Task 5: a click that lands directly on a table CELL (not
        // just the table's chrome/border/padding) opens that table's
        // WYSIWYG session immediately with the clicked cell as the initial
        // edit root. Still degrades to raw-edit up front (never opens a
        // half-broken cell session) when any cell in the table doesn't
        // round-trip through the inline serializer. `blockEl` was just
        // re-resolved above (post-switchAwayFrom); `cell` is still
        // `e.target`'s ORIGINAL closest th/td — if switchAwayFrom()
        // triggered a .content swap, `cell` is a now-detached stale node
        // and `blockEl.contains(cell)` is false by construction, so this
        // simply no-ops instead of acting on stale DOM.
        const cell = e.target.closest('th, td');
        if (cell && blockEl.contains(cell)) {
          const tableEl = blockContentEl(blockEl);
          const tBlockId = Number(blockEl.getAttribute('data-block-id'));
          const tBlock = blocks.find((bl) => bl.id === tBlockId);
          if (tBlock && canWysiwygForTable(tableEl)) {
            openTableEditor(blockEl, tBlock, cell);
          }
        }
        return;
      }

      // Non-table: already an armed WYSIWYG surface (native contenteditable
      // click places the caret; the delegated focusin listener starts the
      // burst) or an already-open raw editor (native textarea click) — let
      // it behave natively, nothing to route here.
      const editEl = blockContentEl(blockEl);
      if ((editEl && editEl.classList.contains('ed-wys-armed')) || blockEl.querySelector('.ed-raw')) return;
      // Degraded block, not yet open: click swaps in the raw textarea
      // immediately — no bar, no menu step (brief: "existing raw editor,
      // minus the bar step"). Still resolve whatever else might be open
      // first, same precondition every other open path uses.
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
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 's') {
      e.preventDefault();
      save();
      return;
    }

    const inTextarea = e.target && e.target.tagName === 'TEXTAREA' &&
      e.target.classList.contains('ed-raw');
    if (inTextarea) return; // Ctrl+Enter/Esc handled by openRawEditor()'s own per-instance listener

    // Phase-2 Task 5: a table cell mid-edit still carries the OLD 'ed-wys'
    // class (tables aren't armed by Task 2 — untouched) and has its own
    // onCellKeydown listener (Enter/Tab/Escape) attached directly; same
    // "don't hijack" reasoning as inTextarea above.
    const inOldWys = e.target && e.target.classList && e.target.classList.contains('ed-wys');
    if (inOldWys) return;

    // Task 2 (Phase 3): a paragraph/heading always-on WYSIWYG burst surface
    // — Enter/Shift+Enter/Esc/Ctrl+Z/Ctrl+Y are all handled per-surface by
    // handleBurstKeydown() above (which also owns preventDefault() for
    // those keys), so nothing below this must run for it either.
    const wysArmedEl = e.target && e.target.closest && e.target.closest('.ed-wys-armed');
    if (wysArmedEl) {
      handleBurstKeydown(e, wysArmedEl);
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      dismissBar();
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
  // every always-on paragraph/heading edit surface, no matter how many
  // times the page is re-armed by rerenderAll(). Gated throughout by the
  // `.ed-wys-armed` class.
  document.addEventListener('focusin', async (e) => {
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
    const editEl = e.target && e.target.closest && e.target.closest('.ed-wys-armed');
    if (!editEl || !currentBurst || currentBurst.editEl !== editEl) return;
    currentBurst.history.noteTyping();
  });

  document.addEventListener('paste', (e) => {
    const editEl = e.target && e.target.closest && e.target.closest('.ed-wys-armed');
    if (!editEl) return; // table cells (old '.ed-wys') keep their own onCellPaste listener
    e.preventDefault();
    const dt = e.clipboardData || window.clipboardData;
    insertTextAtCaret(dt ? dt.getData('text/plain') : '');
    snapBurstIfActive(editEl, 'paste');
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
