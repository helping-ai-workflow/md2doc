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

  function setDirty() {
    document.title = (stack.dirtyDepth !== 0 ? '● ' : '') + baseTitle;
  }

  function findBlockEl(blockId) {
    return contentEl.querySelector('.ed-block[data-block-id="' + blockId + '"]');
  }

  async function rerenderAll() {
    const scrollY = window.scrollY;
    const res = await fetch('/api/render', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileId: ED.fileId, content: lines.join('\n') }),
    });
    const j = await res.json();
    blocks = j.blocks;
    contentEl.innerHTML = j.bodyHtml;
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
  }

  function autoSize(ta) {
    ta.style.height = 'auto';
    ta.style.height = (ta.scrollHeight + 2) + 'px';
  }

  function openRawEditor(blockEl) {
    if (blockEl.querySelector('.ed-raw')) return; // already editing
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
    }

    function commit() {
      const result = commitEdit({ lines, blocks, stack }, blockId, ta.value);
      if (result.op === null) {
        restore();
        return;
      }
      lines = result.lines;
      blocks = result.blocks;
      rerenderAll();
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

  // ── conflict banner ───────────────────────────────────────────────────
  let conflictBanner = null;
  function showConflictBanner() {
    if (conflictBanner) return;
    conflictBanner = document.createElement('div');
    conflictBanner.className = 'ed-conflict';
    const msg = document.createElement('span');
    msg.textContent = 'File changed on disk — reload to pick up external edits ' +
      '(your unsaved changes will be lost).';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Reload';
    btn.addEventListener('click', () => location.reload());
    conflictBanner.appendChild(msg);
    conflictBanner.appendChild(btn);
    document.body.appendChild(conflictBanner);
  }

  // ── save ───────────────────────────────────────────────────────────────
  async function save() {
    const res = await fetch('/api/save', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileId: ED.fileId, content: lines.join('\n'), baseMtimeMs: mtimeMs }),
    });
    if (res.status === 200) {
      const j = await res.json();
      mtimeMs = j.mtimeMs;
      stack.markSaved();
      setDirty();
      return;
    }
    if (res.status === 409) {
      showConflictBanner();
      return;
    }
    // Any other failure: surface nothing destructive; leave state as-is so
    // the user can retry — never silently drop their edits.
  }

  // ── undo / redo ───────────────────────────────────────────────────────
  function undo() {
    const r = stack.undo(lines);
    if (!r) return;
    lines = r.lines;
    rerenderAll();
  }

  function redo() {
    const r = stack.redo(lines);
    if (!r) return;
    lines = r.lines;
    rerenderAll();
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
