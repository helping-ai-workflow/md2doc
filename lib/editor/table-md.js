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

  // ── v3.0.1 欄寬保留 ────────────────────────────────────────────────────
  // A cell FIELD is the text between two '|' delimiters, PADDING INCLUDED:
  // in '| a   | b |' the fields are ' a   ' and ' b '. A column only counts
  // as a deliberately hand-aligned width source when its field is the SAME
  // width on EVERY row of the original (header, separator, every body row)
  // AND that width is greater than 3 — see columnWidthsOf() below for why
  // both conditions are required (C2, 2026-09-02 review round 1: a uniform
  // width of 3 is indistinguishable from this serializer's own minimal
  // form, which is exactly 3 on every row by construction).
  //
  // A raw '|' never appears inside a cell in source THIS serializer produced
  // (it emits '&#124;'), but a hand-written table may use the '\|' escape, so
  // the split must not break on an escaped delimiter.
  function splitFields(line) {
    const t = line.trim();
    if (t.charAt(0) !== '|' || t.charAt(t.length - 1) !== '|' || t.length < 2) return null;
    const inner = t.slice(1, -1);
    const out = [];
    let cur = '';
    for (let i = 0; i < inner.length; i++) {
      const c = inner.charAt(i);
      if (c === '\\' && inner.charAt(i + 1) === '|') { cur += '\\|'; i += 1; continue; }
      if (c === '|') { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    out.push(cur);
    return out;
  }

  // `{ widths, headerFields, sepWidths }` describing the ORIGINAL table, or
  // null when `originalMd` is absent or is not a table this can read. null
  // means "no width source" and every caller below then emits minimal form
  // — the pre-v3.0.1 behaviour, unchanged. `headerFields` (each original
  // header field, trimmed) is what serializeTable() below uses to line a
  // CURRENT column back up with the original column it corresponds to — see
  // the comment at its call site for why index alone is not enough.
  // `sepWidths` (each original SEPARATOR field's own width, always
  // captured, independent of the `uniform`/`> 3` gate below) is the
  // separator-line fallback for a matched column whose header/body rows
  // aren't uniform — see its use at the separator emission site (I1,
  // 2026-09-02 review round 1).
  //
  // A column only counts as a width source when its field is the SAME width
  // on EVERY row (header, separator, every body row) — that is what a
  // deliberately hand-aligned column looks like — AND that width is > 3. A
  // column whose original fields are NOT all equal was never hand-aligned to
  // begin with: it's v3.0.0's un-padded minimal form, where each row's field
  // is only as wide as that row's own content happens to be (e.g. header
  // field 6, a body field 7, another body field 5 — three different
  // numbers, no alignment to preserve). The `> 3` half of the gate catches
  // the case that slips past the uniform check alone: a minimal-form table
  // (single-char cells, say) reports the SAME width — exactly 3 — on every
  // row, because ' a ' and '---' are both 3 characters; that is what THIS
  // serializer's own minimal form always looks like, not evidence of a
  // deliberate alignment (C2, review round 1). Without the `> 3` half, an
  // ordinary minimal-form table would misread itself as "already aligned"
  // and start re-widening on every edit — the header, the separator, AND
  // every untouched row — even though v3.0.0 left all three byte-identical.
  // Reporting `undefined` for such a column — rather than the width seen —
  // means every caller's `widths[i] || 0` / `row[i] === undefined` checks
  // fall through to independent per-row minimal form for it, exactly as if
  // the column had no original at all.
  function columnWidthsOf(originalMd) {
    if (typeof originalMd !== 'string' || originalMd === '') return null;
    const rows = originalMd.split('\n').filter((l) => l.trim() !== '');
    if (rows.length < 2) return null;
    const first = splitFields(rows[0]);
    if (!first) return null;
    const widths = first.map((f) => f.length);
    const uniform = widths.map(() => true);
    let sepWidths = null;
    for (let r = 1; r < rows.length; r++) {
      const fields = splitFields(rows[r]);
      // A ragged original is not a width source — bail rather than guess.
      if (!fields || fields.length !== widths.length) return null;
      if (r === 1) sepWidths = fields.map((f) => f.length);
      for (let c = 0; c < fields.length; c++) {
        if (fields[c].length !== widths[c]) uniform[c] = false;
      }
    }
    for (let c = 0; c < widths.length; c++) {
      if (!uniform[c] || widths[c] <= 3) widths[c] = undefined;
    }
    return { widths, headerFields: first.map((f) => f.trim()), sepWidths };
  }

  // ' content ' right-padded out to `width`. NEVER truncates: a cell whose
  // content grew past the original column simply widens that column, and a
  // deliberately blank hand-aligned cell (e.g. `|     |` kept wide on
  // purpose) is reproduced at its full original width, never shrunk down to
  // its own natural 2 chars — padding is a MINIMUM, not a maximum;
  // truncating here would delete the user's alignment (or their text).
  //
  // (2026-09-02 review round 1, C2: an earlier version special-cased an
  // EMPTY cell to always emit the natural 2-char field, to stop a freshly
  // hover-inserted row/column from being padded out to its column's width.
  // That was a misdiagnosis — the actual cause was columnWidthsOf() treating
  // a uniform width of 3 (== this serializer's own minimal form) as a
  // hand-aligned width source, so an ordinary just-inserted minimal-form
  // column looked "aligned" and got synced. Fixing that at the source (the
  // `> 3` gate above) made the empty-cell special case both unnecessary AND
  // actively wrong — it silently discarded a genuinely blank, intentionally
  // padded cell's width in an aligned table. Removed.)
  function padField(content, width) {
    const field = ' ' + content + ' ';
    return field.length >= width ? field : field + ' '.repeat(width - field.length);
  }

  function cellAlign(cell) {
    const style = cell.getAttribute('style');
    if (!style) return null;
    const m = /text-align\s*:\s*(left|right|center)/.exec(style);
    return m ? m[1] : null;
  }

  // The dash run is stretched to `width`, minus whatever the colons consume.
  // The 3-dash floor belongs ONLY to the no-width path (`w === 0`): that is
  // GFM's own minimum, and it's also exactly the minimal form ('---' /
  // ':---' / '---:' / ':---:') a width of 0 produces — what makes "no
  // original" and "minimal-form original" the same answer. A KNOWN width
  // (`w > 0`) must NOT be floored up to 3: a narrow hand-aligned separator
  // like '|:--:|' (width 4) or '|:-:|' (width 3) is legal GFM (marked lexes
  // it as one table token with `align === 'center'`), and flooring it to
  // '|:---:|' rewrites a line the user never touched — C1 (2026-09-02
  // review round 1): every center-aligned column narrower than 5, and every
  // left/right-aligned column narrower than 4, silently widened on an
  // otherwise-unchanged table, which made commitEdit() write the file and
  // push an undo entry on a plain click-in/click-away. Floor of 1 instead:
  // a dash run can't go negative once the colon(s) are subtracted, but it's
  // otherwise free to reproduce whatever width the original actually had.
  function sepCellFor(align, width) {
    const w = typeof width === 'number' ? width : 0;
    const floor = w > 0 ? 1 : 3;
    if (align === 'left') return ':' + '-'.repeat(Math.max(floor, w - 1));
    if (align === 'right') return '-'.repeat(Math.max(floor, w - 1)) + ':';
    if (align === 'center') return ':' + '-'.repeat(Math.max(floor, w - 2)) + ':';
    return '-'.repeat(Math.max(floor, w));
  }

  // The cell's markdown content, WITHOUT padding. Rendered exactly once per
  // cell (never twice — inlineMd.serializeInline() would double-report
  // `unsupported` for the same cell), so width measurement and emission
  // below both read from these same strings.
  function cellContentOf(cell, unsupported) {
    if (cellHasCodePipe(cell)) unsupported.push('CODE');
    const res = inlineMd.serializeInline(cell);
    res.unsupported.forEach((u) => unsupported.push(u));
    return escapeNewlines(escapePipes(res.md));
  }

  function serializeRow(contents, widths) {
    const parts = contents.map((content, i) =>
      padField(content, widths ? (widths[i] || 0) : 0));
    return '|' + parts.join('|') + '|';
  }

  function serializeTable(tableEl, originalMd) {
    const unsupported = [];
    const thead = firstChildNamed(tableEl, 'THEAD');
    const tbody = firstChildNamed(tableEl, 'TBODY');
    const headerRow = thead ? firstChildNamed(thead, 'TR') : null;
    const headerCells = headerRow ? elementChildren(headerRow).filter(isCell) : [];

    const bodyRows = tbody ? childrenNamed(tbody, 'TR') : [];
    // degrade-never-lose：這兩種形狀序列化出去就回不來了。
    // 空表頭會輸出 '|  |' + '||'，re-lex 成 paragraph（整張表消失）；
    // 比表頭寬的 body 列，重讀時多出來的欄會被直接丟掉。
    if (headerCells.length === 0) {
      return { md: '', unsupported: ['TABLE_NO_HEADER'] };
    }
    const ragged = bodyRows.some((tr) =>
      elementChildren(tr).filter(isCell).length !== headerCells.length);
    if (ragged) {
      return { md: '', unsupported: ['TABLE_RAGGED'] };
    }

    // Render every cell's content up front (same order the pre-v3.0.1 code
    // walked: header first, then each body row left-to-right), so the width
    // pass below and the emission pass after it share one rendering.
    const headerContents = headerCells.map((c) => cellContentOf(c, unsupported));
    const bodyContentRows = bodyRows.map((tr) =>
      elementChildren(tr).filter(isCell).map((c) => cellContentOf(c, unsupported)));

    // Read the ORIGINAL widths first, then line each CURRENT header column
    // up with the original column it corresponds to BY TEXT, not by raw
    // index. A column inserted in the MIDDLE (insertColumn() in client.js)
    // shifts every later column's index by one without changing what that
    // column actually is — matching by index alone would hand the shifted
    // column a stale neighbour's width, and the freshly-inserted empty
    // column would inherit whatever width used to sit at its new index (a
    // plain-index version of this walk is byte-identical to this one for a
    // trailing/mid-table INSERT — padField()'s natural fallback already
    // covers the inserted column either way — but it is NOT for a column
    // MOVE: test/editor-client-runtime.test.js:7876-7927 drags "Detail"
    // from the last position to the first and requires ALL THREE widths
    // dropped even though "Name" and "Note" still sit at index-shifted but
    // TEXT-unchanged positions; only text-matching, combined with the
    // all-or-nothing gate below, gets that right). A mismatch that is
    // simply a RENAMED header (or a dragged ROW promoting a different row
    // to "header" — the per-column-alignment-survives-header-change
    // scenario) is walked the exact same way as any other mismatch: it
    // doesn't advance `j`, so — per the all-or-nothing gate below — it
    // discards the width source for the WHOLE table, not just that one
    // column. That reflow-on-rename is TODAY'S shipped, pre-existing
    // behaviour (v3.0.1 already reflows the whole table on any edit; a
    // rename doing the same is not a regression) — deliberately NOT
    // "fixed" here per the 2026-09-02 review round-1 ruling: detecting
    // rename-vs-permutation is design work that doesn't belong in a patch
    // release. See test/table-width.test.js's "renamed header" case, which
    // pins this so the next change to it is deliberate.
    const original = columnWidthsOf(originalMd);
    let widths = null;
    // Set for a column that falls off the END of the original header list
    // (every original column has already been matched by the time this one
    // is reached) — a genuinely NEW, appended column, e.g. test case 6's
    // 'City'. Its separator still tracks its OWN header's natural width
    // below. This exists to reconcile the brief's OWN case 6: the brief's
    // Step 5 code unconditionally used `widths[i] || 0` for the separator
    // (which is 0, i.e. the bare 3-dash minimal, for any unmatched column),
    // but the brief's own expected string for case 6 has 'City' getting a
    // 6-dash separator — 'City''s own rendered width, not 3 dashes. No
    // pre-existing test forces this; it exists purely to make the brief's
    // Step 5 code and the brief's own case 6 expectation agree with each
    // other. Any OTHER mismatch (a renamed header, or a row-drag promotion)
    // gets no special separator treatment: it falls all the way back to the
    // 3-dash minimal, same as `widths[i]` itself already falls back to
    // natural per-row padding for it — moot in practice, since the
    // all-or-nothing gate below discards `widths` entirely for those cases
    // anyway, so this array is never even consulted for them.
    const sepFallbackNatural = new Array(headerContents.length).fill(false);
    // The ORIGINAL separator row's own per-column field width, for a
    // MATCHED column whose header/body rows are not themselves uniform
    // (`original.widths[j]` is `undefined` there — see columnWidthsOf()).
    // I1 (review round 1): without this, such a column's header/body rows
    // fell back to their own natural content width (which happens to
    // reproduce the original bytes when nothing changed), but the
    // separator fell back to the bare 3-dash minimal — rewriting a
    // separator line the user never touched the moment ANY other cell in
    // the table was edited. Falling back to the ORIGINAL separator's own
    // width instead reproduces it unless the table's shape genuinely
    // changed enough to invalidate `widths` altogether (the gate below).
    const matchedSep = new Array(headerContents.length);
    if (original) {
      const matched = new Array(headerContents.length);
      let j = 0;
      for (let i = 0; i < headerContents.length; i++) {
        if (j < original.headerFields.length &&
            headerContents[i].trim() === original.headerFields[j].trim()) {
          matched[i] = original.widths[j];
          matchedSep[i] = original.sepWidths[j];
          j++;
        } else {
          matched[i] = undefined;
          if (j >= original.headerFields.length) sepFallbackNatural[i] = true;
        }
      }
      // Only trust this walk as a width source AT ALL if it found EVERY
      // original column, in order, somewhere in the current header row (j
      // reached the end). A PARTIAL match — some columns matched, some
      // didn't — means the table's column identity changed in a way this
      // can't safely map: a column DRAG that reorders existing columns
      // (rather than just adding one) still finds two of three headers
      // byte-identical to their originals via this same greedy walk, but
      // "a column move must carry its alignment with it" requires ALL
      // THREE widths dropped, not just the moved one — a per-column guess
      // here would silently keep stale padding on a column that only
      // happens to still have the same text. So a partial match discards
      // the width source for the WHOLE table, same as no original at all.
      if (j === original.headerFields.length) {
        widths = matched;
        // A matched column is then widened, for every row of that column
        // at once (header + separator + every body row), to whatever the
        // grown content now needs — the padding floor rises but never
        // falls, and never truncates (test case 5): "a cell whose content
        // grew past the original column widens that COLUMN", not just its
        // own line. An unmatched column's width stays `undefined` here —
        // comparing a number against `undefined` is always false, so this
        // loop leaves it alone and padField()'s `|| 0` fallback below
        // gives it independent per-row minimal form instead.
        const allRows = [headerContents].concat(bodyContentRows);
        for (let i = 0; i < widths.length; i++) {
          let needed = widths[i];
          allRows.forEach((row) => {
            if (row[i] === undefined) return;
            const natural = row[i].length + 2; // 1-space padding, both sides
            if (natural > needed) needed = natural;
          });
          widths[i] = needed;
        }
      }
    }

    const lines = [];
    lines.push(serializeRow(headerContents, widths));
    lines.push('|' + headerCells.map((c, i) => {
      // Preference order for a column's separator width:
      //   1. widths[i] — this column is a full hand-aligned width source
      //      (matched, uniform, and > 3). Same width the header/body rows
      //      already use.
      //   2. matchedSep[i] — this column WAS matched to an original column,
      //      just not a uniform-width one (I1: reproduces the ORIGINAL
      //      separator's own field width instead of collapsing to the bare
      //      3-dash minimal on an edit elsewhere in the table).
      //   3. headerContents[i].length + 2, but ONLY for a column that fell
      //      off the END of the original header list (sepFallbackNatural —
      //      see above): a genuinely new, appended column still gets a
      //      separator matching its own header's natural width (case 6:
      //      'City' has no original width, but its separator is 6 dashes),
      //      unlike the header/body rows above, whose padField() `|| 0`
      //      deliberately leaves such a column unsynced.
      //   4. 0 (the plain 3-dash minimal) — no original table at all
      //      (`widths` itself is null: cases 1 and 7 stay byte-identical to
      //      the pre-v3.0.1 minimal form), or a mismatch that is neither a
      //      matched-but-non-uniform column nor a trailing new one (a
      //      renamed header, or a row-drag promotion) — moot in practice,
      //      since the all-or-nothing gate above already discarded
      //      `widths` entirely for those cases.
      const w = widths
        ? (widths[i] !== undefined ? widths[i]
            : matchedSep[i] !== undefined ? matchedSep[i]
            : (sepFallbackNatural[i] ? headerContents[i].length + 2 : 0))
        : 0;
      return sepCellFor(cellAlign(c), w);
    }).join('|') + '|');

    bodyContentRows.forEach((contents) => lines.push(serializeRow(contents, widths)));

    return { md: lines.join('\n'), unsupported };
  }

  return { serializeTable };
});
