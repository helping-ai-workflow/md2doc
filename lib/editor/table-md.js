'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./inline-md.js'));
  } else {
    root.md2docTableMd = factory(root.md2docInlineMd);
  }
})(typeof self !== 'undefined' ? self : this, function (inlineMd) {

  // table-md.js — table DOM -> minimal-form GFM markdown (Phase-2 Task 5).
  //
  // ── Renderer finding (verified against lib/md2doc.js's renderer.table,
  //    ~line 650, BEFORE writing serializeTable below — required by the
  //    task brief) ───────────────────────────────────────────────────────
  // Per-column alignment: renderer.table's `alignStyle(cell)` helper emits
  // `style="text-align:<left|right|center>"` on BOTH <th> and <td> for that
  // column ONLY when marked's lexed `cell.align` is truthy (an explicit GFM
  // `:---` / `---:` / `:---:` separator was used). A column with the plain
  // `---` separator (marked's `cell.align === null`) gets NO style
  // attribute at all — not `style="text-align:left"`, nothing. So
  // alignment must be read from the PRESENCE/VALUE of the `style`
  // attribute — read here from the header row's <th> cells, since
  // alignStyle() is applied identically per-column to every row — never
  // from a class or an `align=` attribute; renderer.table emits neither.
  //
  // classifyColumns() (same file) ALSO stamps `class="cell-narrow"` /
  // `class="cell-prose"` per column — those are rendering-WIDTH hints (see
  // `.content table col.col-narrow { width: 1% }` in the CSS block) with
  // nothing to do with text alignment. Reading them as alignment would be a
  // bug; they are deliberately never consulted below.
  //
  // ── Emission form (spec §4 / task-5 brief) ─────────────────────────────
  // '| a | b |' rows (single-space padding); '|---|' separator row — no
  // padding around the dashes, ':' alignment variants (':---' / '---:' /
  // ':---:'), dashes never stretched to content width; literal '|' inside
  // a cell -> '&#124;'; a cell newline is the literal '<br>' inline-md.js's
  // serializeInline() already emits for both a real <br> node and a
  // contenteditable <div> line-split boundary — AND (final-review Finding 1
  // defense-in-depth) any raw '\n'/'\r' that still reaches a text node is
  // collapsed to '<br>' here too, via escapeNewlines() below, so a cell can
  // never split serializeTable()'s output into more physical lines than
  // it has rows. No trailing whitespace on any emitted line (every row/
  // separator line is built as '|'-delimited fields, so it always ends in
  // '|', never in whitespace, by construction). A '|' inside a <code> span
  // has no faithful gate-safe emission — see cellHasCodePipe() below —
  // and reports 'CODE' unsupported instead of corrupting it.
  //
  // Constrained (same as inline-md.js, and for the same reason: the node
  // test drives this with the hand-rolled element stub from
  // test/inline-md.test.js) to childNodes / nodeType / nodeName /
  // textContent / getAttribute — NO querySelector/querySelectorAll.

  function elementChildren(node) {
    const out = [];
    for (let i = 0; i < node.childNodes.length; i++) {
      const c = node.childNodes[i];
      if (c.nodeType === 1) out.push(c);
    }
    return out;
  }

  function firstChildNamed(node, name) {
    const kids = elementChildren(node);
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].nodeName === name) return kids[i];
    }
    return null;
  }

  function childrenNamed(node, name) {
    return elementChildren(node).filter((c) => c.nodeName === name);
  }

  function isCell(node) {
    return node.nodeName === 'TH' || node.nodeName === 'TD';
  }

  // '&#124;' — the postprocess literal-pipe escape (spec §4). Applied AFTER
  // inline serialization: inline-md.js's own escaping table has no reason
  // to know about the table-cell delimiter, so it never touches a bare '|'.
  function escapePipes(s) {
    return s.split('|').join('&#124;');
  }

  // Finding 1 (final-review, defense in depth): inline-md.js's escapeText()
  // and serializeCode() never touch '\n' — a text node carrying a raw
  // embedded newline (e.g. a paste path that bypassed client.js's own
  // <br>-segmentation, or any future caller of serializeInline()) would
  // otherwise leak a literal line break into this cell's md, splitting one
  // table row into an orphan-cell-line the gate can't parse. Collapse any
  // raw newline sequence to the same literal '<br>' token a real <br>
  // element already serializes to (case 4 in table-md.test.js / gate-compat
  // .test.js) — applied at the same postprocess spot as escapePipes().
  function escapeNewlines(s) {
    return s.replace(/\r\n|\r|\n/g, '<br>');
  }

  // Finding 4: a '|' inside a <code> span has no faithful gate-safe
  // emission — escapePipes() above runs on the WHOLE cell's serialized md
  // and can't tell a code span's content from plain text, so naively
  // applying it would corrupt the code span (turning `` `a|b` `` into the
  // broken `` `a&#124;b` ``, which never decodes back inside a code span).
  // `\|` (some other renderers' escape) is the gate's documented trap, so
  // there's no safe escape at all here — degrade-never-lose: detect a CODE
  // element anywhere in the cell whose textContent contains '|' and report
  // it unsupported instead, same signal an IMG/SPAN/etc. already uses to
  // degrade the whole table to raw-edit (see canWysiwygForTable() in
  // client.js). Recurses through the cell's element children looking for
  // CODE — constrained to childNodes/nodeType/nodeName like the rest of
  // this file (no querySelector, per the node-test stub).
  function cellHasCodePipe(node) {
    const kids = elementChildren(node);
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (k.nodeName === 'CODE') {
        if (k.textContent.indexOf('|') !== -1) return true;
      } else if (cellHasCodePipe(k)) {
        return true;
      }
    }
    return false;
  }

  function cellAlign(cell) {
    const style = cell.getAttribute('style');
    if (!style) return null;
    const m = /text-align\s*:\s*(left|right|center)/.exec(style);
    return m ? m[1] : null;
  }

  function sepCellFor(align) {
    if (align === 'left') return ':---';
    if (align === 'right') return '---:';
    if (align === 'center') return ':---:';
    return '---';
  }

  function serializeRow(cells, unsupported) {
    const parts = cells.map((cell) => {
      if (cellHasCodePipe(cell)) unsupported.push('CODE');
      const res = inlineMd.serializeInline(cell);
      res.unsupported.forEach((u) => unsupported.push(u));
      return escapeNewlines(escapePipes(res.md));
    });
    return '| ' + parts.join(' | ') + ' |';
  }

  function serializeTable(tableEl) {
    const unsupported = [];
    const thead = firstChildNamed(tableEl, 'THEAD');
    const tbody = firstChildNamed(tableEl, 'TBODY');
    const headerRow = thead ? firstChildNamed(thead, 'TR') : null;
    const headerCells = headerRow ? elementChildren(headerRow).filter(isCell) : [];

    const lines = [];
    lines.push(serializeRow(headerCells, unsupported));
    lines.push('|' + headerCells.map((c) => sepCellFor(cellAlign(c))).join('|') + '|');

    const bodyRows = tbody ? childrenNamed(tbody, 'TR') : [];
    bodyRows.forEach((tr) => {
      const cells = elementChildren(tr).filter(isCell);
      lines.push(serializeRow(cells, unsupported));
    });

    return { md: lines.join('\n'), unsupported };
  }

  return { serializeTable };
});
