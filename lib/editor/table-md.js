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
  // ── Emission form (spec §4 / task-5 brief, amended by v3.0.1) ──────────
  // There are TWO emission forms, and exactly one gate selects between them:
  // whether serializeTable() was handed an `originalMd` it could turn into a
  // usable width source (columnWidthsOf() parsed it, AND the greedy
  // header-TEXT walk in serializeTable() matched EVERY original column, in
  // order — the all-or-nothing gate). No second argument, an unparseable or
  // ragged original, a renamed header, a dropped column: all of them land on
  // form A.
  //
  //   A. MINIMAL form (pre-v3.0.1, unchanged, and still what
  //      `serializeTable(tableEl)` with no second argument emits — byte for
  //      byte): '| a | b |' rows with single-space padding; a '|---|'
  //      separator row with no padding around the dashes, ':' alignment
  //      variants (':---' / '---:' / ':---:'), dashes never stretched to
  //      content width, always at least 3 of them.
  //
  //   B. WIDTH-PRESERVING form (v3.0.1 欄寬保留): every row of a column,
  //      header and body alike, is padded out to that column's preserved
  //      width, and the separator's dash run IS stretched to the same width
  //      — with NO 3-dash floor, because a legal hand-aligned '|:-:|' must
  //      not be widened (see sepCellFor() for that floor's exact scope). A
  //      preserved width only exists for a column whose original fields were
  //      the same width on every row AND wider than 3; a matched column that
  //      fails that test still reuses its ORIGINAL separator field's width
  //      rather than collapsing to the minimal 3. On top of that, F1: when a
  //      matched column's original separator field already expresses the
  //      column's current alignment and is already exactly the target width,
  //      that field is re-emitted VERBATIM — padding and all — so the padded
  //      separators Prettier and VS Code emit ('| ----- | --- |') survive a
  //      no-op instead of being rebuilt flush ('|-------|-----|').
  //
  // Independent of the form: a literal '|' inside
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

  // `{ widths, headerFields, sepFields }` describing the ORIGINAL table, or
  // null when `originalMd` is absent or is not a table this can read. null
  // means "no width source" and every caller below then emits minimal form
  // — the pre-v3.0.1 behaviour, unchanged. `headerFields` (each original
  // header field, trimmed) is what serializeTable() below uses to line a
  // CURRENT column back up with the original column it corresponds to — see
  // the comment at its call site for why index alone is not enough.
  // `sepFields` (each original SEPARATOR field VERBATIM — padding, colons and
  // all; always captured, independent of the `uniform`/`> 3` gate below)
  // serves the separator emission site twice: its LENGTH is the fallback
  // width for a matched column whose header/body rows aren't uniform (I1,
  // 2026-09-02 review round 1), and the field ITSELF is re-emitted unchanged
  // when nothing about that column's separator actually changed (F1,
  // 2026-09-02 final review) — see sepFieldAlign() and the emission site.
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
    let sepFields = null;
    for (let r = 1; r < rows.length; r++) {
      const fields = splitFields(rows[r]);
      // A ragged original is not a width source — bail rather than guess.
      if (!fields || fields.length !== widths.length) return null;
      if (r === 1) sepFields = fields.slice();
      for (let c = 0; c < fields.length; c++) {
        if (fields[c].length !== widths[c]) uniform[c] = false;
      }
    }
    for (let c = 0; c < widths.length; c++) {
      if (!uniform[c] || widths[c] <= 3) widths[c] = undefined;
    }
    return { widths, headerFields: first.map((f) => f.trim()), sepFields };
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

  // The alignment an ORIGINAL separator field already expresses, in the same
  // vocabulary cellAlign() above returns ('left' / 'right' / 'center' /
  // null), so the two can be compared directly at the emission site.
  // Returns `undefined` — which cellAlign() can never return — for anything
  // that is not a bare separator field, so a field this can't fully account
  // for can never be re-emitted verbatim. F1 (2026-09-02 final review).
  function sepFieldAlign(field) {
    const t = field.trim();
    if (!/^:?-+:?$/.test(t)) return undefined;
    const l = t.charAt(0) === ':';
    const r = t.charAt(t.length - 1) === ':';
    if (l && r) return 'center';
    if (l) return 'left';
    if (r) return 'right';
    return null;
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
    // all-or-nothing gate below, gets that right).
    //
    // v3.0.2 superseded the 2026-09-02 review round-1 ruling that a renamed
    // header or a deleted column must discard the whole table's width memory:
    // the forward scan below skips an original column that no longer appears,
    // and only a genuine column REORDER still takes the whole-table refusal.
    // What is still NOT handled — deliberately — is a table with DUPLICATE
    // header names: the scan pairs by TEXT, so after a delete a survivor can
    // inherit the same-named other column's width. Telling the instances
    // apart needs identity matching, which is a larger change than this
    // patch release carries. See test/table-width.test.js cases 14, 15, 20,
    // 21, 23 and 24, which pin every branch of the above.
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
    // The ORIGINAL separator row's own field, VERBATIM, for each MATCHED
    // column. Used two ways at the emission site below:
    //
    //   • its LENGTH is the fallback width for a matched column whose
    //     header/body rows are not themselves uniform (`original.widths[j]`
    //     is `undefined` there — see columnWidthsOf()). I1 (review round 1):
    //     without this, such a column's header/body rows fell back to their
    //     own natural content width (which happens to reproduce the original
    //     bytes when nothing changed), but the separator fell back to the
    //     bare 3-dash minimal — rewriting a separator line the user never
    //     touched the moment ANY other cell in the table was edited.
    //   • the FIELD ITSELF is re-emitted unchanged when the column's
    //     separator did not actually change (F1, final review) — see the
    //     verbatim gate at the emission site.
    const matchedSepFields = new Array(headerContents.length);
    if (original) {
      const matched = new Array(headerContents.length);
      // v3.0.2: a FORWARD SCAN, not the pre-v3.0.2 lockstep compare. The
      // lockstep version left `j` parked on the first original column that
      // did not match, so it could never recover from one mismatch — and
      // "some original column was never consumed" is the signature of a
      // DELETE and a RENAME just as much as of the column REORDER the gate
      // below actually exists to refuse. Scanning forward lets a delete or
      // a rename skip the original it no longer has, and moves the refusal
      // into an explicit test (`moved`) instead of a side effect of `j`.
      const unmatchedNames = [];
      let j = 0;
      for (let i = 0; i < headerContents.length; i++) {
        const name = headerContents[i].trim();
        let k = -1;
        for (let q = j; q < original.headerFields.length; q++) {
          if (original.headerFields[q].trim() === name) { k = q; break; }
        }
        if (k >= 0) {
          matched[i] = original.widths[k];
          matchedSepFields[i] = original.sepFields[k];
          j = k + 1;
        } else {
          matched[i] = undefined;
          // The EMPTY name is exempt from the reorder test below, and the
          // exemption is load-bearing, not defensive: insertColumn()
          // (lib/editor/client.js:6391-6396) creates a th with no content
          // at all, so every inserted column is named ''. A table that
          // already holds one blank header would therefore see the new
          // column's '' "found elsewhere in the original" and take the
          // whole-table refusal — a straight regression against v3.0.1 on
          // the ordinary insert-a-column-twice flow.
          if (name !== '') unmatchedNames.push(name);
          if (j >= original.headerFields.length) sepFallbackNatural[i] = true;
        }
      }
      // A column that could not find itself in what remains of the original,
      // yet whose name IS somewhere in the original, has MOVED relative to
      // the others. That is the one shape a per-column width guess gets
      // silently wrong ("a column move must carry its alignment with it"),
      // so it still discards the width source for the WHOLE table. A name
      // that is absent from the original entirely is an insert or a rename:
      // nothing stale to carry, so its neighbours keep their widths.
      const moved = unmatchedNames.some((n) =>
        original.headerFields.some((f) => f.trim() === n));
      if (!moved) {
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
      //   2. matchedSepFields[i].length — this column WAS matched to an
      //      original column, just not a uniform-width one (I1: reproduces
      //      the ORIGINAL separator's own field width instead of collapsing
      //      to the bare 3-dash minimal on an edit elsewhere in the table).
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
      //      renamed header, or a row-drag promotion). Since v3.0.2 the
      //      gate above no longer discards `widths` for a rename, so this
      //      branch is now the live path for a renamed column: its header
      //      and body rows take padField()'s `|| 0` natural width and its
      //      separator takes the bare 3-dash minimal. A row-drag promotion
      //      leaves every column unmatched, so `widths` is an all-undefined
      //      array — byte-for-byte the same output as the `null` it used to
      //      be, because every preference above falls through to this 0.
      const origField = matchedSepFields[i];
      const w = widths
        ? (widths[i] !== undefined ? widths[i]
            : origField !== undefined ? origField.length
            : (sepFallbackNatural[i] ? headerContents[i].length + 2 : 0))
        : 0;
      const align = cellAlign(c);
      // F1 (2026-09-02 final review, Critical): once the width is settled,
      // prefer the ORIGINAL field's own BYTES over rebuilding them. Every
      // preference above only ever agreed on the WIDTH of the separator
      // field; sepCellFor() then rebuilt its contents as a dash run flush
      // against both delimiters. For the padded separator row Prettier,
      // prettier-plugin-markdown and VS Code's table formatter all emit —
      // '| ----- | --- |', the most common machine-aligned markdown table
      // in the wild — that is the same width but different bytes, so a pure
      // no-op (click into the table, click away) came back as
      // '|-------|-----|'. commitRangeEdit() short-circuits only on a
      // byte-identical result, so that was a REAL op: an undo entry pushed,
      // `lines` replaced, and the next save writing a line the user never
      // touched.
      //
      // Re-emit the original field verbatim only when BOTH hold, so this can
      // never smuggle a stale separator past a genuine change:
      //   (a) the field already expresses the alignment this column now has
      //       (sepFieldAlign() returns `undefined` for anything that isn't a
      //       plain separator field, which cellAlign() can never equal, so an
      //       unparseable field always falls through); and
      //   (b) the target width `w` is exactly that field's own length — any
      //       width GROWTH (a cell that outgrew its column, cases 5 and 12)
      //       lands here with w > origField.length and falls through.
      // Everything that falls through takes today's sepCellFor() path,
      // unchanged.
      if (widths && origField !== undefined &&
          origField.length === w && sepFieldAlign(origField) === align) {
        return origField;
      }
      return sepCellFor(align, w);
    }).join('|') + '|');

    bodyContentRows.forEach((contents) => lines.push(serializeRow(contents, widths)));

    return { md: lines.join('\n'), unsupported };
  }

  return { serializeTable };
});
