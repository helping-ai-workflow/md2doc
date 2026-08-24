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
  let lines = ED.lines, blocks = ED.blocks, mtimeMs = ED.mtimeMs;
  const stack = new ops.UndoStack();
  const baseTitle = document.title;
  const contentEl = document.querySelector('.content');

  // Only one raw-edit editor may be open at a time (fix for the "two
  // editors open, committing one silently wipes the other's uncommitted
  // text" defect). Policy chosen: opening a SECOND BLOCK's editor while one
  // is already open is REFUSED outright — the already-open editor gets a
  // brief visual flash as feedback — rather than auto-cancelling it. An
  // auto-cancel-if-unmodified policy was considered but rejected there: it
  // needs its own dirty-diff bookkeeping for one extra convenience and
  // still surprises a user who *did* type something, so "always refuse,
  // always predictable" is the simpler and safer contract for opening a
  // second block.
  //
  // undo()/redo() are a DIFFERENT collision, not covered by the above: they
  // don't open a second editor, they replace the ENTIRE .content subtree
  // (via safeRerenderAll()) regardless of which block, if any, currently
  // has an editor open. If that swap runs while some block's editor is
  // open, its textarea is detached without ever running its own restore()
  // — the only place that clears `activeEditor` — so `activeEditor` is
  // left pointing at a node no longer in the document, and every future
  // gutter click (any block) hits the "a different editor is open" guard
  // above forever (a real regression found in review: silent total lockout,
  // recoverable only by reloading). So undo()/redo() must resolve any open
  // editor FIRST, deterministically: no unsaved keystrokes → silently
  // cancel it (same effect as Esc) and proceed; unsaved keystrokes → refuse
  // the undo/redo entirely and flash the (still live) open editor — same
  // "always refuse, always predictable" policy, just applied to the
  // undo/redo collision instead of the open-a-second-block collision. See
  // resolveOpenEditorOrRefuse() below.
  //
  // Belt-and-braces: rerenderAll() also unconditionally nulls `activeEditor`
  // right after every successful .content swap, regardless of caller, so a
  // future safeRerenderAll() call site that forgets this pre-check can
  // never reproduce the lockout — any editor that was open is gone by
  // construction the moment the swap happens.
  let activeEditor = null; // { blockEl, hasChanges(), restore() } | null

  // Resolve whatever raw-edit editor is currently open BEFORE a caller
  // proceeds to a .content-replacing operation (undo/redo). Returns true
  // when it's safe to proceed (no editor was open, or it was cleanly
  // cancelled because it had no unsaved keystrokes). Returns false when the
  // operation must be abandoned (an open editor has unsaved keystrokes) —
  // the caller does nothing further; the open editor is flashed as the
  // visible reason why.
  function resolveOpenEditorOrRefuse() {
    if (!activeEditor) return true;
    if (!activeEditor.hasChanges()) {
      activeEditor.restore();
      return true;
    }
    flashActiveEditor();
    return false;
  }

  function setDirty() {
    document.title = (stack.dirtyDepth !== 0 ? '● ' : '') + baseTitle;
  }

  function flashActiveEditor() {
    if (!activeEditor) return;
    const el = activeEditor.blockEl;
    el.classList.add('ed-attn');
    setTimeout(() => el.classList.remove('ed-attn'), 600);
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
    // resolveOpenEditorOrRefuse() first.
    activeEditor = null;
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
        // editor (gutters, save, undo).
      }
    }
    attachGutters();
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

  function openRawEditor(blockEl) {
    if (blockEl.querySelector('.ed-raw')) return; // already editing this block
    if (activeEditor && activeEditor.blockEl !== blockEl) {
      // Single-editor-at-a-time policy (see `activeEditor` comment above):
      // refuse, and flash the block that IS open so the refusal is visible.
      flashActiveEditor();
      return;
    }
    const blockId = Number(blockEl.getAttribute('data-block-id'));
    const block = blocks.find((b) => b.id === blockId);
    if (!block) return;

    // Strip any existing gutter BEFORE capturing the "restore to" HTML.
    // The gutter's click handler is DOM-wired (addEventListener in
    // attachGutters()), not something innerHTML round-tripping preserves —
    // capturing it here would let restore() below "revive" a dead,
    // listener-less button, and attachGutters()'s own dedupe (a `.ed-gutter`
    // child already present) would then permanently refuse to replace it.
    // The block-level fix mirrors here: restore() re-runs attachGutters()
    // once this node has no gutter child left, so a fresh, live one is
    // always attached again.
    const existingGutter = blockEl.querySelector(':scope > .ed-gutter');
    if (existingGutter) existingGutter.remove();
    const original = blockEl.innerHTML;
    const source = extractBlockSource(lines, block);

    const wrap = document.createElement('div');
    wrap.className = 'ed-editing';

    const ta = document.createElement('textarea');
    ta.className = 'ed-raw';
    ta.value = source;

    // `restore` is a hoisted function declaration (defined further down in
    // this closure) — referencing it here, before its textual definition,
    // is safe. hasChanges() is what resolveOpenEditorOrRefuse() (used by
    // undo/redo) uses to decide "silently cancel" vs "refuse and flash".
    activeEditor = { blockEl, hasChanges: () => ta.value !== source, restore };

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
      attachGutters(); // re-adds a live gutter to this (now un-wrapped) block
    }

    async function commit() {
      const result = commitEdit({ lines, blocks, stack }, blockId, ta.value);
      if (result.op === null) {
        restore();
        return;
      }
      const prevLines = lines;
      lines = result.lines;
      const ok = await safeRerenderAll();
      if (!ok) {
        // Roll back the optimistic edit: pop the op safeRerenderAll's
        // failure means was never actually rendered, and put this block's
        // pre-edit content (with a live gutter) back on screen so state
        // stays consistent with what the server actually has.
        const rollback = stack.undo(lines);
        lines = rollback ? rollback.lines : prevLines;
        restore();
        return;
      }
      // Success: rerenderAll() already replaced the whole .content subtree
      // (this block included) and nulled `activeEditor` itself — nothing
      // left to do here.
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

  function attachGutters() {
    const els = contentEl.querySelectorAll('.ed-block');
    for (let i = 0; i < els.length; i++) {
      const blockEl = els[i];
      if (blockEl.querySelector(':scope > .ed-gutter')) continue; // already wired
      const gutter = document.createElement('button');
      gutter.type = 'button';
      gutter.className = 'ed-gutter';
      gutter.textContent = '✎';
      gutter.setAttribute('aria-label', 'Edit block');
      gutter.addEventListener('click', (e) => {
        e.preventDefault();
        openRawEditor(blockEl);
      });
      blockEl.appendChild(gutter);
    }
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
    // see the `activeEditor` comment near its declaration for why this is
    // required (undo/redo silently detaching an open-but-unresolved editor
    // was the Finding-4-regression lockout).
    if (!resolveOpenEditorOrRefuse()) return;
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
    if (!resolveOpenEditorOrRefuse()) return;
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

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 's') {
      e.preventDefault();
      save();
      return;
    }
    if (inTextarea) return; // Ctrl+Enter/Esc handled per-textarea above

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
    fetch('/api/ping', { method: 'POST' }).catch(() => {});
  }, 10000);

  attachGutters();
})();
