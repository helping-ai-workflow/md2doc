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
  // ── Emission form (spec §4 / task-5 brief, amended by v3.0.1, v3.17.8) ─
  // There are TWO emission forms for the padding. Form B applies when
  // serializeTable() was handed an `originalMd` it could turn into a width
  // source: columnWidthsOf() parsed it (not ragged) and the forward header
  // scan in serializeTable() found no MOVED column. Since v3.0.2 a renamed
  // or dropped column no longer voids it; only that column loses its width.
  // No second argument, an unparseable or ragged original, a moved column:
  // all of them land on form A.
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
  // Cell bytes (v3.17.8 F1, both forms): a cell whose original field reads
  // the same as its current content (see readsSame()) is written with the
  // original field's bytes, trimmed; every other cell gets the canonical
  // spelling below. A header row or body row whose cells were ALL reused, in
  // the original columns, with no column widened past that line's own
  // fields, is the original line itself (trimmed), odd padding like '|a|b|'
  // included. Body rows are paired with original rows by pairBodyRows(), so a
  // row inserted, deleted or moved leaves the others as they were. With no
  // parser nothing is reused, and the output is what it was before v3.17.8.
  //
  // Canonical spelling: a literal '|' inside a cell's text -> '&#124;'; a
  // cell newline is the literal '<br>' inline-md.js's
  // serializeInline() already emits for both a real <br> node and a
  // contenteditable <div> line-split boundary — AND (final-review Finding 1
  // defense-in-depth) any raw '\n'/'\r' that still reaches a text node is
  // collapsed to '<br>' here too, via escapeNewlines() below, so a cell can
  // never split serializeTable()'s output into more physical lines than
  // it has rows. A '|' inside a <code> span is written as '\|' instead
  // (v3.17.6) — see codePipesOf() below; the one code text that has no
  // table spelling reports 'CODE' unsupported. A reused field never holds a
  // newline or an unescaped '|' (it is one field of one source line). No
  // trailing whitespace on any emitted line: a built row or separator is
  // '|'-delimited fields, and an original line is trimmed and, to be read
  // at all, ends in an unescaped '|' (splitFields()).
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

  // A '|' inside a <code> span (v3.17.6; Finding 4 of 2026-08-25 refused
  // every one). escapePipes() above cannot be used on it: '&#124;' is never
  // decoded inside a code span, so `` `a|b` `` would come back as `a&#124;b`.
  // GFM's own spelling is '\|': the table tokenizer drops that backslash when
  // it splits the row into cells, before the cell is parsed inline, so the
  // code span shows a bare '|'. It is also what paperwork asks for. Its
  // quality gate (G-MD-TABLE-PIPE,
  // `scan_table_rows_for_unescaped_pipe_in_backtick` in scripts/gate/shared.py,
  // 10.4.0) hard-FAILs an unescaped pipe inside a backtick span of a table
  // row and gives '\|' as the fix. The paperwork-workspace-rtk design-docs
  // are written that way, and those tables used to fall back to raw-edit.
  //
  // Correction, recorded because the old comment here said otherwise: it
  // called '\|' "the gate's documented trap". Nothing in paperwork 10.4.0
  // backs that. The only trap note about an escaped pipe there is a docstring
  // in scripts/gate/hwe1.py (`_hwe1_requirement_units`): that helper splits
  // hwe1 requirement rows with a plain split("|"), so it would cut such a
  // cell in two, and the docstring itself says no gate reads that cell text
  // today. It is a hazard for whoever extends that helper. It is not a rule
  // against the form, and design-doc gates do not use that helper.
  //
  // One code text still has no spelling. marked's splitCells() treats a pipe
  // as escaped when an ODD run of backslashes precedes it, then deletes one
  // backslash. Code text with an even run before its '|' (none, two, …) is
  // written with one more backslash and reads back exactly. With an odd run,
  // that extra backslash makes the run even and the pipe becomes a cell
  // boundary. That case reports 'CODE' unsupported, and the whole table falls
  // back to raw-edit as before (canWysiwygForTable() in client.js).
  //
  // Returns { pipes, unwritable } over every CODE element in the cell. It
  // recurses through elements that are not CODE and does not descend into
  // CODE, because serializeCode() writes a CODE element's textContent whole.
  // It sticks to childNodes/nodeType/nodeName like the rest of this file (no
  // querySelector, per the node-test stub).
  const ODD_BACKSLASH_PIPE = /(?:^|[^\\])(?:\\\\)*\\\|/;
  function codePipesOf(node, acc) {
    const out = acc || { pipes: 0, unwritable: false };
    const kids = elementChildren(node);
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (k.nodeName === 'CODE') {
        const t = k.textContent;
        out.pipes += t.split('|').length - 1;
        if (ODD_BACKSLASH_PIPE.test(t)) out.unwritable = true;
      } else {
        codePipesOf(k, out);
      }
    }
    return out;
  }

  // The placeholder serializeCode() writes for a code '|' while the cell's
  // markdown goes through escapePipes(). A private-use character, so real
  // text almost never holds it. If one does, the count check in
  // cellContentOf() catches it and the cell degrades rather than guessing.
  const CODE_PIPE_MARK = '\uE000';

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
  // A hand-written table may use '\|' anywhere, and since v3.17.8 so may
  // this serializer's output (a reused field keeps the author's '\|'), so
  // the split must not break on an escaped delimiter. Escaped means what
  // marked's splitCells() means (v3.17.8 F3): an ODD run of backslashes
  // before the '|'. A backslash and the character after it are taken as one
  // pair, so '\\|' is an escaped backslash and then a delimiter; before this
  // the split read that '|' as escaped, the row came out one field short and
  // the whole table lost its width memory. A line whose last '|' is escaped
  // has no closing delimiter and is not a row this can read (see the end).
  function splitFields(line) {
    const t = line.trim();
    if (t.charAt(0) !== '|' || t.length < 2) return null;
    const out = [];
    let cur = '';
    for (let i = 1; i < t.length; i++) {
      const c = t.charAt(i);
      if (c === '\\' && i + 1 < t.length) { cur += c + t.charAt(i + 1); i += 1; continue; }
      if (c === '|') { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    // A line whose last '|' is escaped (`| p | q \|`) has no closing
    // delimiter: not a row this can read, so it is never reused and the table
    // has no width memory. v3.17.8's final-review round 1 split it the old way
    // instead (last '|' closes the row) to keep the width memory, and the
    // re-review found that this loses an edit: the field ` q \` read alone is
    // `q \`, but in its line it reads `q |`, so an edit from `q |` to `q \`
    // read "the same" and the original line came back (N1). Width memory
    // for such a rare table is not worth that.
    if (cur !== '') return null;
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

  // ── v3.17.8 F1: an untouched cell keeps its bytes ─────────────────────
  // Every cell is serialized from the DOM, so a cell nobody edited comes
  // back in this file's canonical spelling: a plain '[' as '\[', a
  // plain-text '\|' as '&#124;'. The meaning is the same; the git diff is
  // not. So a current cell reuses its ORIGINAL field (trimmed) when the two
  // spellings READ the same, and that is decided by parsing, not by rules:
  // a private `new Marked({ gfm: true, breaks: false })` (the same family as
  // inline-md.js's getInlineParser(); server.js injects marked before the
  // editor modules) renders each spelling as the one cell of a one-column
  // table, and the two cell HTMLs are compared after character references
  // in their text are decoded (marked passes '&#124;' through, the browser
  // shows '|'). A cell is parsed once per string (readCache).
  //
  // The plain parser has none of md2doc's sub / sup / KaTeX extensions, so
  // an original holding an unescaped '~', '^' or '$' is reused only when it
  // is byte-equal to the canonical spelling (R5). No parser (a page without
  // marked, or setCellParser(null)): nothing is reused and every byte is
  // what the serializer wrote before v3.17.8.
  let cellParser; // undefined: not looked up yet; null: none available
  const readCache = new Map();
  function getCellParser() {
    if (cellParser !== undefined) return cellParser;
    cellParser = null;
    try {
      let lib = null;
      if (typeof module === 'object' && module.exports && typeof require === 'function') lib = require('marked');
      else if (typeof self !== 'undefined' && self.marked) lib = self.marked;
      if (lib && typeof lib.Marked === 'function') {
        const m = new lib.Marked({ gfm: true, breaks: false });
        cellParser = (s) => m.parse(s);
      }
    } catch (e) {
      cellParser = null;
    }
    return cellParser;
  }
  // Tests swap the parser: a function (markdown -> HTML), null to switch
  // reuse off, or nothing to go back to the lookup above.
  function setCellParser(fn) {
    cellParser = typeof fn === 'function' ? fn : (fn === null ? null : undefined);
    readCache.clear();
  }

  const CELL_HEAD = '<table>\n<thead>\n<tr>\n<th>h</th>\n</tr>\n</thead>\n<tbody><tr>\n<td>';
  const CELL_TAIL = '</td>\n</tr>\n</tbody></table>\n';
  const NAMED_REF = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  // A named reference outside NAMED_REF cannot be decoded here, so a cell
  // holding one has no reading at all (final review I3): left as it was, the
  // `&` was re-escaped and `&copy;` (shows ©) read the same as the typed
  // text `\&copy;` (shows &copy;), so an edit to that text was overwritten
  // by the original bytes. Such a cell is now reused only when byte-equal.
  const UNKNOWN_REF = {};
  function decodeRef(m, dec, hex, name) {
    if (name !== undefined) {
      if (NAMED_REF[name] !== undefined) return NAMED_REF[name];
      throw UNKNOWN_REF;
    }
    const n = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    return n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) ? '�' : String.fromCodePoint(n);
  }
  // Text between tags: references decoded, then & < > " re-escaped, so two
  // spellings of one character give one string. Tags are left as they are.
  // HTML comments are dropped first: nothing shows them, the editor's DOM
  // walk skips them (so the canonical spelling never has one), and
  // inline-md.js's own read-back (htmlMarks()) skips them too. That keeps
  // an untouched cell's comments, e.g. the `<!-- [[source, Cl.x]] -->`
  // citation anchors in paperwork's hwe1 tables, which the canonical
  // spelling would drop.
  function normalizeCellHtml(html) {
    return html.replace(/<!--[\s\S]*?-->/g, '').split(/(<[^>]*>)/).map((part, i) => (i % 2 ? part : part
      .replace(/&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g, decodeRef)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'))).join('');
  }
  // The normalized HTML of `field` as the one cell of a one-column table, or
  // null when it is not read as exactly that (then it never reads the same
  // as anything).
  function cellReading(parse, field) {
    if (readCache.has(field)) return readCache.get(field);
    let v = null;
    try {
      const html = parse('| h |\n| - |\n| ' + field + ' |');
      if (typeof html === 'string' && html.startsWith(CELL_HEAD) && html.endsWith(CELL_TAIL)) {
        const inner = html.slice(CELL_HEAD.length, html.length - CELL_TAIL.length);
        if (inner.indexOf('</td>') === -1) v = normalizeCellHtml(inner);
      }
    } catch (e) {
      v = null;
    }
    // FIFO, not a clear: a table larger than the cap read itself cold on every
    // commit when the whole cache was dropped (final review M1).
    if (readCache.size >= READ_CACHE_MAX) readCache.delete(readCache.keys().next().value);
    readCache.set(field, v);
    return v;
  }
  const READ_CACHE_MAX = 100000;
  // One string per cell such that readsSame(a, b) === (readingKey(a) ===
  // readingKey(b)): a cell with a reading is keyed by it, one without by its
  // bytes, so it only ever pairs with itself. pairBodyRows() hashes rows on it.
  function readingKey(parse, x) {
    if (!parse) return 'B' + x;
    const r = cellReading(parse, x);
    return r === null ? 'B' + x : 'R' + r;
  }
  function readsSame(parse, a, b) {
    if (a === b) return true;
    const ra = cellReading(parse, a);
    return ra !== null && ra === cellReading(parse, b);
  }
  // '~' (sub), '^' (sup) or '$' (KaTeX) after an even backslash run (R5).
  const EXTENSION_CHAR = /(?:^|[^\\])(?:\\\\)*[~^$]/;

  // The original table's rows for reuse: { header, body } where `header` is
  // { fields, line } and `body` holds one { fields, line } per body row, or
  // null for a line splitFields() cannot read (it is then never paired).
  // `line` is the source line trimmed. Unlike columnWidthsOf(), a ragged row
  // does not void the table: reuse is decided per cell. null when there is
  // no original or its header line is not a row.
  function originalRowsOf(originalMd) {
    if (typeof originalMd !== 'string' || originalMd === '') return null;
    const rows = originalMd.split('\n').filter((l) => l.trim() !== '');
    if (rows.length < 2) return null;
    const row = (l) => { const f = splitFields(l); return f ? { fields: f, line: l.trim() } : null; };
    const header = row(rows[0]);
    if (!header) return null;
    return { header, body: rows.slice(2).map(row) };
  }

  // Pairs each current body row with an original body row (an index into
  // `origBody`, or -1). A row "matches" when every mapped cell reads the
  // same. (1) a forward greedy scan pairs matching rows in order — the
  // anchors; (2) a row left over that matches some unused original anywhere
  // is paired with it (a moved row); (3) the rows still left between two
  // anchors are paired in order with the unused originals between the same
  // anchors — that is an edited row, whose other cells are then reused one
  // by one. A wrong pair only costs preserved bytes: every reuse is gated by
  // readsSame() again, cell by cell.
  // Linear in rows (final review M1: the scans were quadratic, 3000 rows
  // that all differ took 3 s): each row is hashed on its mapped cells'
  // readingKey(), so "matches" is one Map lookup.
  function pairBodyRows(curRows, origBody, colMap, keyOf) {
    const mapped = [];
    colMap.forEach((k, i) => { if (k !== undefined) mapped.push(i); });
    const pair = new Array(curRows.length).fill(-1);
    if (mapped.length === 0) return pair;
    const SEP = '\u0000';
    const origKey = origBody.map((o) => {
      if (!o) return null;
      const parts = [];
      for (let x = 0; x < mapped.length; x++) {
        const f = o.fields[colMap[mapped[x]]];
        if (f === undefined) return null;
        parts.push(keyOf(f.trim()));
      }
      return parts.join(SEP);
    });
    const curKey = curRows.map((row) => mapped.map((i) => keyOf(row[i])).join(SEP));
    // key -> { list: ascending original indices, p1: step-1 cursor, p2: step-2 cursor }
    const byKey = new Map();
    origKey.forEach((k, q) => {
      if (k === null) return;
      let e = byKey.get(k);
      if (!e) { e = { list: [], p1: 0, p2: 0 }; byKey.set(k, e); }
      e.list.push(q);
    });
    const used = new Array(origBody.length).fill(false);
    const anchor = new Array(curRows.length).fill(false);
    // (1) forward greedy: the first unused match at or after j. Every original
    // used in this step lies before j, so a cursor that skips indices < j
    // finds it, and it only moves forward.
    let j = 0;
    for (let c = 0; c < curRows.length; c++) {
      const e = byKey.get(curKey[c]);
      if (!e) continue;
      while (e.p1 < e.list.length && e.list[e.p1] < j) e.p1++;
      if (e.p1 < e.list.length) {
        const q = e.list[e.p1++];
        pair[c] = q; used[q] = true; anchor[c] = true; j = q + 1;
      }
    }
    // (2) a leftover row that matches an unused original anywhere (moved).
    for (let c = 0; c < curRows.length; c++) {
      if (pair[c] !== -1) continue;
      const e = byKey.get(curKey[c]);
      if (!e) continue;
      while (e.p2 < e.list.length && used[e.list[e.p2]]) e.p2++;
      if (e.p2 < e.list.length) { const q = e.list[e.p2++]; pair[c] = q; used[q] = true; }
    }
    // (3) the rows still left between two anchors take the unused originals
    // between the same anchors, in order.
    const nextAnchorQ = new Array(curRows.length + 1);
    nextAnchorQ[curRows.length] = origBody.length;
    for (let c = curRows.length - 1; c >= 0; c--) nextAnchorQ[c] = anchor[c] ? pair[c] : nextAnchorQ[c + 1];
    let q = 0;
    for (let c = 0; c < curRows.length; c++) {
      if (anchor[c]) { q = pair[c] + 1; continue; }
      if (pair[c] !== -1) continue;
      const nextQ = nextAnchorQ[c + 1];
      while (q < nextQ && (used[q] || !origBody[q])) q++;
      if (q < nextQ) { pair[c] = q; used[q] = true; q++; }
    }
    return pair;
  }

  // The contents a row is emitted with: each cell's original field where it
  // may be reused, else its canonical content. `whole` is true when every
  // cell was reused and the columns are the original's, in order — the row
  // may then be the original line itself (decided at emission, once widths
  // are known).
  function reuseRow(parse, canon, cellBad, orig, colMap, nOrigCols) {
    if (!orig) return { contents: canon, whole: false };
    let whole = canon.length === orig.fields.length && canon.length === nOrigCols;
    const contents = canon.map((c, i) => {
      const k = colMap[i];
      if (k !== i) whole = false;
      const field = k === undefined ? undefined : orig.fields[k];
      if (field === undefined || cellBad[i]) { whole = false; return c; }
      const f = field.trim();
      if (f === c) return c;
      if (!EXTENSION_CHAR.test(f) && readsSame(parse, f, c)) return f;
      whole = false;
      return c;
    });
    return { contents, whole };
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
    const code = codePipesOf(cell);
    const res = inlineMd.serializeInline(cell, { codePipe: CODE_PIPE_MARK });
    res.unsupported.forEach((u) => unsupported.push(u));
    const parts = escapeNewlines(escapePipes(res.md)).split(CODE_PIPE_MARK);
    if (code.unwritable || parts.length - 1 !== code.pipes) unsupported.push('CODE');
    return parts.join('\\|');
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
    // `bad` marks a cell that reported unsupported: it is never reused, so a
    // reuse can never stand in for (or hide) such a cell.
    const cellOf = (c) => {
      const before = unsupported.length;
      const md = cellContentOf(c, unsupported);
      return { md, bad: unsupported.length !== before };
    };
    const headerCellMd = headerCells.map(cellOf);
    const bodyCellMd = bodyRows.map((tr) => elementChildren(tr).filter(isCell).map(cellOf));
    // The canonical contents; replaced below by the reused ones (F1).
    let headerContents = headerCellMd.map((x) => x.md);
    let bodyContentRows = bodyCellMd.map((row) => row.map((x) => x.md));

    // Read the ORIGINAL widths first, then line each CURRENT header column
    // up with the original column it corresponds to BY TEXT (since v3.17.8,
    // by how the text reads: `same` below), not by raw index. A column inserted in the MIDDLE (insertColumn() in client.js)
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
    // F1: with a parser, names are compared by how they READ (a header
    // spelled 'a\_b' in the file is the DOM's 'a_b'); without one, by bytes,
    // as before. `src` is the original's rows for reuse (null: no reuse).
    const parse = getCellParser();
    const same = parse ? (a, b) => readsSame(parse, a, b) : (a, b) => a === b;
    const src = parse ? originalRowsOf(originalMd) : null;
    const origNames = original ? original.headerFields
      : (src ? src.header.fields.map((f) => f.trim()) : null);
    // colIdx[i]: the original column current column i was matched to.
    const colIdx = new Array(headerContents.length);
    let moved = false;
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
    if (origNames) {
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
        for (let q = j; q < origNames.length; q++) {
          if (same(origNames[q].trim(), name)) { k = q; break; }
        }
        if (k >= 0) {
          colIdx[i] = k;
          if (original) matchedSepFields[i] = original.sepFields[k];
          j = k + 1;
        } else {
          // The EMPTY name is exempt from the reorder test below, and the
          // exemption is load-bearing, not defensive: insertColumn()
          // (lib/editor/client.js:6448-6465) creates a th (or td) with no
          // content at all — the element itself at line 6451 — so every
          // inserted column is named ''. A table that
          // already holds one blank header would therefore see the new
          // column's '' "found elsewhere in the original" and take the
          // whole-table refusal — a straight regression against v3.0.1 on
          // the ordinary insert-a-column-twice flow.
          if (name !== '') unmatchedNames.push(name);
          if (original && j >= origNames.length) sepFallbackNatural[i] = true;
        }
      }
      // A column that could not find itself in what remains of the original,
      // yet whose name IS somewhere in the original, has MOVED relative to
      // the others. That is the one shape a per-column width guess gets
      // silently wrong ("a column move must carry its alignment with it"),
      // so it still discards the width source for the WHOLE table. A name
      // that is absent from the original entirely is an insert or a rename:
      // nothing stale to carry, so its neighbours keep their widths.
      moved = unmatchedNames.some((n) =>
        origNames.some((f) => same(f.trim(), n)));
      // F1: the cells of a column the scan did not match (a moved one) are
      // still reused when exactly one unmatched original column has its name.
      // This feeds reuse only; the width refusal above stands.
      if (src) {
        const taken = new Set(colIdx.filter((k) => k !== undefined));
        for (let i = 0; i < headerContents.length; i++) {
          const name = headerContents[i].trim();
          if (colIdx[i] !== undefined || name === '') continue;
          const hits = [];
          for (let q = 0; q < origNames.length; q++) {
            if (!taken.has(q) && same(origNames[q].trim(), name)) hits.push(q);
          }
          if (hits.length === 1) { colIdx[i] = hits[0]; taken.add(hits[0]); }
        }
      }
    }

    // F1: reuse each untouched cell's original bytes (see reuseRow()), before
    // the widths are settled, so the reused contents are what they measure.
    let headerWhole = false;
    const bodyWhole = bodyContentRows.map(() => false);
    const bodyOrig = bodyContentRows.map(() => null);
    if (src) {
      const nOrigCols = src.header.fields.length;
      const h = reuseRow(parse, headerContents, headerCellMd.map((x) => x.bad), src.header, colIdx, nOrigCols);
      headerContents = h.contents;
      headerWhole = h.whole;
      const pair = pairBodyRows(bodyContentRows, src.body, colIdx, (x) => readingKey(parse, x));
      bodyContentRows = bodyContentRows.map((canon, r) => {
        const orig = pair[r] === -1 ? null : src.body[pair[r]];
        const b = reuseRow(parse, canon, bodyCellMd[r].map((x) => x.bad), orig, colIdx, nOrigCols);
        bodyWhole[r] = b.whole;
        bodyOrig[r] = orig;
        return b.contents;
      });
    }

    if (original) {
      if (!moved) {
        // Not moved means the name rescue above found nothing (an unmatched
        // name is absent from the original), so colIdx is the scan's alone.
        widths = colIdx.map((k) => (k === undefined ? undefined : original.widths[k]));
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

    // F1: a row whose cells were all reused, in the original columns, is the
    // original line itself (trimmed), padding and all, unless a column it
    // holds was widened past that line's own field.
    const asWritten = (whole, orig) => whole && orig.fields.every((f, i) =>
      !widths || widths[i] === undefined || widths[i] <= f.length);
    const lines = [];
    lines.push(asWritten(headerWhole, src && src.header) ? src.header.line
      : serializeRow(headerContents, widths));
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
      //      ONLY leaves every column unmatched — and so only produces the
      //      same all-undefined `widths`, byte-for-byte the `null` output,
      //      because every preference above falls through to this 0 — when
      //      none of the promoted row's cells collides with an ORIGINAL
      //      header name. A collision re-enters the by-text match above (the
      //      `k >= 0` branch), so that column inherits the OLD column's
      //      width and the row emits half-aligned rather than fully minimal
      //      (measured: promoting a 'Note' / 'zzz' row past an original
      //      'Name | Note' header keeps column 0 at the original Note
      //      column's width while column 1 falls to 3-dash minimal). The two
      //      promotion scenarios this suite covers are both collision-free.
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

    bodyContentRows.forEach((contents, r) => lines.push(asWritten(bodyWhole[r], bodyOrig[r])
      ? bodyOrig[r].line : serializeRow(contents, widths)));

    return { md: lines.join('\n'), unsupported };
  }

  return { serializeTable, setCellParser };
});
