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

  if (typeof module === 'object' && module.exports) {
    module.exports = { extractBlockSource, commitEdit };
    return; // node: pure core only
  }

  // ── DOM wiring (browser only) ─────────────────────────────────────────
  const ED = window.__ED__;
  const inlineMd = window.md2docInlineMd;
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
    switching = (async () => {
      if (!activeEditor) return true;
      if (!activeEditor.hasChanges()) {
        activeEditor.cancelNow();
        return true;
      }
      return await activeEditor.commitNow(); // false → editor stays open, banner already shown
    })().finally(() => { switching = null; });
    return switching;
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
    // Whatever editor (if any) was open a moment ago just got detached by
    // the innerHTML replacement above — its own restore()/commit() never
    // ran, so it never got a chance to null this out itself. Do it here,
    // unconditionally, on every successful swap: this is what makes the
    // undo/redo lockout regression (see the `activeEditor` comment above)
    // structurally impossible even from a call site that forgets to call
    // switchAwayFrom() first.
    activeEditor = null;
    // Same reasoning applies to the click-to-select edit bar: whatever block
    // had it open a moment ago was just destroyed by the innerHTML
    // replacement above, so `selectedBlockEl` — and the bar node itself, if
    // it was still attached there — must not survive the swap. Reset
    // unconditionally here too, so a future call site can never reproduce a
    // stale-node leak the way the activeEditor lockout once did.
    dismissBar();
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
  function insertTextAtCaret(text) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.setEndAfter(node);
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

  function headingDepthOf(line) {
    const m = line.match(/^(#{1,6})\s?/);
    return m ? m[1].length : 1;
  }

  function withHeadingDepth(line, newDepth) {
    const m = line.match(/^#{1,6}\s?/);
    const rest = m ? line.slice(m[0].length) : line;
    return '#'.repeat(newDepth) + ' ' + rest;
  }

  // Heading ± buttons on the bar: a pure source-level transform (just the
  // leading `#` run) via the SAME commitEdit()/replaceLines() pipeline as
  // every other edit, then a full re-render — deliberately independent of
  // whatever the inline serializer thinks of the heading's prose content.
  // switchAwayFrom() first resolves any editor that's currently open on this
  // (or another) block, same precondition as undo()/redo() below, so this
  // never races a concurrent commit or operates on stale `lines`/`blocks`.
  async function changeHeadingDepth(delta) {
    const blockEl = selectedBlockEl;
    if (!blockEl) return;
    const blockId = Number(blockEl.getAttribute('data-block-id'));
    const ok = await switchAwayFrom();
    if (!ok) return;
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

  // openWysiwygEditor(blockEl, block): implements the shared editor-object
  // contract (see the `activeEditor` comment near its declaration above) for
  // in-place paragraph/heading editing. Routed to from the bar's ✎ button
  // (see buildBar() below) when the block is a paragraph/heading AND
  // canWysiwygForBlock() says its content round-trips through the inline
  // serializer; every other block keeps going through openRawEditor().
  function openWysiwygEditor(blockEl, block) {
    const blockId = block.id;
    const blockType = blockEl.getAttribute('data-block-type');
    const editEl = blockContentEl(blockEl);
    if (!editEl) return;

    // Captured BEFORE stripping the heading anchor below, so cancel() puts
    // the full original markup (anchor included) back exactly as rendered.
    const original = editEl.innerHTML;
    const depth = blockType === 'heading' ? Number(editEl.tagName.slice(1)) : null;
    if (blockType === 'heading') stripHeadingAnchor(editEl);
    // The md the CURRENT (post-strip) DOM serializes to right now, before any
    // typing — hasChanges() below compares against this, not innerHTML, so
    // browser attribute-reordering/whitespace quirks never read as a change.
    const originalMd = inlineMd.serializeInline(editEl).md;

    editEl.setAttribute('contenteditable', 'true');
    editEl.classList.add('ed-wys');

    function cancel() {
      editEl.innerHTML = original;
      editEl.removeAttribute('contenteditable');
      editEl.classList.remove('ed-wys');
      // CRITICAL fix: unlike raw-edit's fresh <textarea> (thrown away with
      // the whole wrap on cancel), `editEl` here is the block's PERSISTENT
      // content element — it stays in the DOM and gets a BRAND NEW keydown/
      // paste listener pair on every future re-open. Without this removal,
      // N open/cancel cycles leave N stale listener sets alive; the (N-1)
      // stale ones' `cancel()` closures still fire on Esc/commit alongside
      // the current session's, racing an uncommanded second /api/render
      // that can revert a just-typed commit out from under the real one.
      editEl.removeEventListener('keydown', onKeydown);
      editEl.removeEventListener('paste', onPaste);
      // Phase-2 Task 4: same per-session attach/detach discipline as the
      // keydown/paste listeners just above — the selection toolbar must
      // never survive past this session (hidden on cancel/commit/collapse,
      // never shown outside an active WYSIWYG session).
      document.removeEventListener('selectionchange', onSelectionChangeForToolbar);
      hideSelToolbar();
      selToolbarEditEl = null;
      if (activeEditor && activeEditor.blockEl === blockEl) activeEditor = null;
      dismissBar();
    }

    // Same commit/rollback shape as openRawEditor()'s commit() above — see
    // its comment for what the true/false return means to switchAwayFrom().
    async function commit() {
      const result = inlineMd.serializeInline(editEl);
      if (result.unsupported.length > 0) {
        // The paste handler below only ever inserts plain text, but a
        // browser-native rich-paste/drag-drop path could still land
        // unsupported markup mid-session — degrade-never-lose: drop it and
        // fall back to raw-edit prefilled with the block's UNTOUCHED
        // original source (openRawEditor() re-derives it from `lines`,
        // which this commit path never wrote to).
        showBanner('含不支援的格式，改用原始碼編輯', null, null);
        cancel();
        openRawEditor(blockEl);
        // IMPORTANT fix: this degrade is NOT a clean resolution — it just
        // swapped this block's OWN editor (WYSIWYG -> raw), it did not
        // "finish" in a way that makes it safe for whoever called
        // commitNow() (switchAwayFrom(), on behalf of a click on some OTHER
        // block, or undo/redo) to proceed. Returning true here let that
        // caller continue — e.g. the click delegator would go on to
        // showBarFor(C) for the block the user actually clicked, leaving the
        // bar on C while the freshly-opened raw editor sits on THIS block:
        // bar and open editor on two different blocks. Returning false
        // (same contract as a network commit failure) makes every such
        // caller abort and leave this block's new raw editor exactly where
        // it is, with nothing else moving.
        return false;
      }
      const newText = depth !== null ? '#'.repeat(depth) + ' ' + result.md : result.md;
      const commitResult = commitEdit({ lines, blocks, stack }, blockId, newText);
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
      // (this block included), nulled `activeEditor`, and dismissed the bar.
      // cancel() (which normally tears down the selection toolbar) never
      // runs on this path, so it must be torn down explicitly here too —
      // same reasoning as the keydown/paste listeners above it.
      document.removeEventListener('selectionchange', onSelectionChangeForToolbar);
      hideSelToolbar();
      selToolbarEditEl = null;
      return true;
    }

    activeEditor = { blockEl, isWys: true, hasChanges: () => inlineMd.serializeInline(editEl).md !== originalMd,
      commitNow: commit, cancelNow: cancel };
    updateBarButtons(blockEl);

    // Named (not inline-anonymous) so cancel() above can removeEventListener
    // them by reference — see its comment.
    function onKeydown(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) insertBrAtCaret();
        else commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    }
    function onPaste(e) {
      e.preventDefault();
      const dt = e.clipboardData || window.clipboardData;
      insertTextAtCaret(dt ? dt.getData('text/plain') : '');
    }
    // Phase-2 Task 4: shows/repositions/hides the floating selection toolbar
    // as the selection changes during this session. selectionchange (not
    // mouseup) is the reliable signal — mouseup alone misses keyboard-driven
    // selections (Shift+arrow, Ctrl+A, …).
    function onSelectionChangeForToolbar() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { hideSelToolbar(); return; }
      const range = sel.getRangeAt(0);
      if (!editEl.contains(range.startContainer) || !editEl.contains(range.endContainer)) {
        hideSelToolbar();
        return;
      }
      positionSelToolbar(range);
    }
    editEl.addEventListener('keydown', onKeydown);
    editEl.addEventListener('paste', onPaste);
    selToolbarEditEl = editEl;
    document.addEventListener('selectionchange', onSelectionChangeForToolbar);

    editEl.focus();
    placeCaretAtEnd(editEl);
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
  let selToolbarEditEl = null; // the open WYSIWYG session's contenteditable root, or null

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
      return;
    }
    reselectAndReposition(wrapRangeIn(range, tag));
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
      return;
    }
    const overlapping = overlappingMarks(range, 'A', root);
    if (overlapping.length > 0) {
      const extended = extendRangeOverMarks(range, overlapping);
      overlappingMarks(extended, 'A', root).forEach((m) => unwrapElement(m));
      reselectAndReposition(extended);
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

  // ── click-to-select edit bar ────────────────────────────────────────────
  // Replaces the old per-block hover gutter. Clicking anywhere in an
  // .ed-block (lightbox targets excluded — those still open the lightbox,
  // unchanged) shows ONE floating bar, built once and moved between blocks,
  // anchored to the clicked block's top edge. Wiring is delegated to
  // `document` exactly once (see wireBlockSelection() below), so — unlike
  // the old per-element gutters — nothing here ever needs re-attaching
  // after a .content swap (commit/undo/redo).
  const ED_LIGHTBOX_TARGETS =
    'img, .mermaid, .graphviz, [id^="WaveDrom_Display_"], .wavedrom-diagram';
  let selectedBlockEl = null;

  // References populated by buildBar() below — needed by updateBarButtons()
  // to toggle visibility per selected block / editor state.
  let editBtn, mdBtn, minusBtn, plusBtn;

  function buildBar() {
    const b = document.createElement('div');
    b.className = 'ed-bar';

    minusBtn = document.createElement('button');
    minusBtn.type = 'button';
    minusBtn.className = 'ed-bar-btn ed-bar-minus';
    minusBtn.textContent = '−';
    minusBtn.setAttribute('aria-label', 'Decrease heading level');
    minusBtn.hidden = true;
    minusBtn.addEventListener('click', (e) => { e.stopPropagation(); changeHeadingDepth(-1); });

    plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.className = 'ed-bar-btn ed-bar-plus';
    plusBtn.textContent = '+';
    plusBtn.setAttribute('aria-label', 'Increase heading level');
    plusBtn.hidden = true;
    plusBtn.addEventListener('click', (e) => { e.stopPropagation(); changeHeadingDepth(1); });

    editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'ed-bar-btn ed-bar-edit';
    editBtn.textContent = '✎ 編輯';
    editBtn.setAttribute('aria-label', 'Edit block');
    // Task 3 routing: paragraph/heading blocks whose rendered content
    // round-trips through the inline serializer get the WYSIWYG editor;
    // everything else (unsupported inline content, images, code/table/list/
    // blockquote/html blocks, …) keeps the existing raw-edit textarea.
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const blockEl = selectedBlockEl;
      if (!blockEl) return;
      const blockId = Number(blockEl.getAttribute('data-block-id'));
      const block = blocks.find((bl) => bl.id === blockId);
      if (!block) { dismissBar(); return; }
      const blockType = blockEl.getAttribute('data-block-type');
      if ((blockType === 'paragraph' || blockType === 'heading') &&
          canWysiwygForBlock(blockEl, blockType)) {
        openWysiwygEditor(blockEl, block);
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
    // Escape hatch: discards the in-progress WYSIWYG session (same as Esc)
    // and reopens the block via the raw textarea, prefilled from `lines`
    // (untouched, since the WYSIWYG session never committed).
    mdBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const blockEl = selectedBlockEl;
      if (!blockEl || !activeEditor || activeEditor.blockEl !== blockEl) return;
      activeEditor.cancelNow();
      openRawEditor(blockEl);
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ed-bar-btn ed-bar-close';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Dismiss edit bar');
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissBar();
    });
    b.appendChild(minusBtn);
    b.appendChild(plusBtn);
    b.appendChild(editBtn);
    b.appendChild(mdBtn);
    b.appendChild(closeBtn);
    return b;
  }

  const bar = buildBar();

  // Toggles which bar buttons are visible for the given (selected) block:
  // ± only for headings; MD only while a WYSIWYG session is actively open
  // on this exact block (✎ hidden in that state — there's nothing left to
  // route, it's already editing).
  function updateBarButtons(blockEl) {
    const blockType = blockEl.getAttribute('data-block-type');
    const isHeading = blockType === 'heading';
    const isWysEditing = !!(activeEditor && activeEditor.blockEl === blockEl && activeEditor.isWys);
    editBtn.hidden = isWysEditing;
    mdBtn.hidden = !isWysEditing;
    minusBtn.hidden = !isHeading;
    plusBtn.hidden = !isHeading;
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
  // block's editor is open must resolve it first via switchAwayFrom() —
  // see the `activeEditor` comment near its declaration.
  function wireBlockSelection() {
    document.addEventListener('click', async (e) => {
      if (!e.target || !e.target.closest) { await switchAwayFrom(); dismissBar(); return; }
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
      if (e.target.closest('.ed-bar')) return; // the bar's own buttons handle themselves
      if (e.target.closest('.ed-seltb')) return; // the selection toolbar's own buttons handle themselves
      if (e.target.closest(ED_LIGHTBOX_TARGETS)) return; // let the lightbox open, unchanged
      let blockEl = e.target.closest('.ed-block');
      if (!blockEl) { await switchAwayFrom(); dismissBar(); return; } // clicked outside any block
      // This block's editor (raw OR WYSIWYG — Task 3) is already open: let
      // the click behave natively (caret placement, text selection) instead
      // of re-running the select/switch dance on every click inside it.
      // Generalizes the old `.querySelector('.ed-raw')` check, which only
      // covered the raw editor.
      if (activeEditor && activeEditor.blockEl === blockEl) return;
      // A DIFFERENT block's editor may be open — resolve it (commit if
      // modified, else cancel) before selecting the clicked block. A
      // successful auto-commit replaces the whole .content subtree
      // (rerenderAll), which detaches `blockEl` — re-resolve the live node
      // by its stable block id once switchAwayFrom() settles.
      const blockId = blockEl.getAttribute('data-block-id');
      const ok = await switchAwayFrom();
      if (!ok) return; // the open editor's auto-commit failed; stay put, don't select blockEl
      blockEl = document.querySelector('.ed-block[data-block-id="' + blockId + '"]') || blockEl;
      showBarFor(blockEl);
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
    const inTextarea = e.target && e.target.tagName === 'TEXTAREA' &&
      e.target.classList.contains('ed-raw');
    // Task 3: the WYSIWYG editor's content element (the <p>/<h#> tag itself)
    // carries the 'ed-wys' class while contenteditable — same gate purpose
    // as `inTextarea` above, so Enter/Shift+Enter/Esc typed while editing
    // reach ITS OWN keydown listener (see openWysiwygEditor()) instead of
    // this global handler's Escape/undo/redo, and native browser undo
    // (Ctrl+Z) inside the editable region isn't hijacked by the block-level
    // undo stack — exactly like the raw textarea's own native undo today.
    const inWys = e.target && e.target.classList && e.target.classList.contains('ed-wys');

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 's') {
      e.preventDefault();
      save();
      return;
    }
    if (inTextarea || inWys) return; // Ctrl+Enter/Enter/Shift+Enter/Esc handled per-element above

    if (e.key === 'Escape') {
      e.preventDefault();
      dismissBar();
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

  wireBlockSelection();
})();
