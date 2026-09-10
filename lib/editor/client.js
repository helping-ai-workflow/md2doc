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

  // ── S4 Task 3: relocating ONE block's lines (spec §4.5) ────────────────
  //
  // A move is ONE commitRangeEdit over
  // `min(source, destination) .. max(source, destination)`. UndoStack's op is
  // `{startLine, endLine, before, after}` — a SINGLE contiguous line range,
  // with no notion of a source and a destination — so a move written as
  // "removal here, insertion there" is two ops and two Ctrl+Z, which §3.4
  // forbids. For a block that is not a li there is nothing to re-serialize:
  // the lines are relocated VERBATIM, so nothing can be re-escaped and no
  // marker arithmetic is involved.
  //
  // THE BLANK-LINE RULE, which the plan left to this task to define:
  //
  //   1. The block's own lines move byte-for-byte.
  //   2. At the seam it LEAVES, the blank run that surrounded it is absorbed
  //      and replaced by exactly ONE blank line — or by none when the block
  //      was at the start or the end of the file.
  //   3. At the seam it LANDS in, one blank line is emitted on each side of
  //      it whose neighbouring line is not already blank.
  //
  // Neither existing helper is the right tool, and the plan says so:
  // commitRangeRemoval() absorbs exactly one adjacent blank and
  // commitBlockInsertion() always adds a leading one. Each is HALF of a move
  // and the halves do not compose — the pair leaves the document one
  // separator short at the seam that was left and one long at the seam that
  // was landed in, and it is two undo ops.
  //
  // CONSEQUENCE, measured against marked.lexer + blockmap.buildBlockMap on
  // every fixture in test/editor-client-runtime.test.js's T3 section before
  // any byte was pinned: in a document whose blocks are separated by exactly
  // one blank line — everything this editor's own serializer emits — a move
  // is a PERMUTATION OF THE FILE'S LINES. Same lines, same count, same
  // separators.
  //
  // The one exception, and it is deliberate: a document that already jams two
  // blocks onto adjacent lines ('# A\n# B\n# C\n') has no blank at the
  // landing seam to carry, so rule 3 CREATES one and the count goes up. It
  // has to. MEASURED: 'paraA\n# H\n\nparaB\n' with paraA appended and no
  // blank emitted is '# H\n\nparaB\nparaA\n', which marked.lexer answers as
  // ONE paragraph — the move would have eaten a block. The count moves only
  // in that direction, and only at a seam that had no separator to begin
  // with.
  //
  // The final '' of a file that ends in a newline is the TERMINATOR, not a
  // blank separator; `contentLen` below is what keeps rule 2 from eating the
  // file's last newline when the block being moved is the last one.
  //
  // Pure: takes and returns plain data, and lives in the node-visible core
  // beside the other commit helpers.
  function planBlockMove(lines, blocks, src, dest) {
    const isBlank = (s) => s !== undefined && s !== null && s.trim() === '';
    const contentLen = lines.length - (lines.length && lines[lines.length - 1] === '' ? 1 : 0);
    let above = 0;
    while (src.startLine - 1 - above >= 1 && isBlank(lines[src.startLine - 2 - above])) above++;
    let below = 0;
    while (src.endLine + 1 + below <= contentLen && isBlank(lines[src.endLine + below])) below++;
    // The source's own extraction range: its lines plus the whole blank run on
    // either side of it. What goes BACK at that seam is rule 2's single blank,
    // and only when the seam has a block on both sides of it.
    const ds = src.startLine - above;
    const de = src.endLine + below;
    const srcFill = (ds >= 2 && de < contentLen) ? [''] : [];
    const blockLines = lines.slice(src.startLine - 1, src.endLine);
    // `dest === null` is the {mode:'append'} target: the insertion point is
    // one line past the last block's last line.
    const ins = dest ? dest.startLine
      : (blocks.length ? blocks[blocks.length - 1].endLine + 1 : contentLen + 1);
    // Dropped where it already is. `ins === ds` is "on my own top edge";
    // `ins === de + 1` is "on the seam immediately below me" — visually the
    // same place, and the byte no-op the drag's own release-where-you-started
    // case depends on. Every other `ins` inside the extraction range is a
    // blank line, which no block's startLine can name.
    if (ins >= ds && ins <= de + 1) return null;
    const prevLine = ins >= 2 ? lines[ins - 2] : null;
    const nextLine = ins <= lines.length ? lines[ins - 1] : null;
    const lead = (prevLine !== null && !isBlank(prevLine)) ? [''] : [];
    const trail = (nextLine !== null && !isBlank(nextLine)) ? [''] : [];
    const payload = lead.concat(blockLines, trail);
    // ONE range, covering both seams. Everything between them is carried
    // through untouched — which is what makes this a single undo op instead
    // of a removal and an insertion.
    if (ins > de + 1) {
      const after = srcFill.concat(lines.slice(de, ins - 1), payload);
      const newStart = ds + srcFill.length + (ins - 1 - de) + lead.length;
      return { startLine: ds, endLine: ins - 1, after: after,
        newRange: { startLine: newStart, endLine: newStart + blockLines.length - 1 } };
    }
    const after = payload.concat(lines.slice(ins - 1, ds - 1), srcFill);
    const newStart = ins + lead.length;
    return { startLine: ins, endLine: de, after: after,
      newRange: { startLine: newStart, endLine: newStart + blockLines.length - 1 } };
  }

  // The commit half. `op === null` with `noop` set means the block was
  // released where it already was — a BYTE no-op, not a failure, and
  // deliberately distinct from commitRangeEdit()'s own unchanged-text
  // `op: null` so a caller can tell "nothing to do" from "somebody handed me
  // a range that produced the same text".
  function commitBlockMove(state, src, dest) {
    const plan = planBlockMove(state.lines, state.blocks, src, dest);
    if (!plan) {
      return { lines: state.lines, blocks: state.blocks, op: null, noop: 'same-position' };
    }
    const r = commitRangeEdit(state, plan.startLine, plan.endLine, plan.after.join('\n'));
    r.newRange = plan.newRange;
    return r;
  }

  // ── S4 Task 4: the pure half of a LIST ITEM's move (spec §4.5) ─────────
  //
  // A li's lines CANNOT be relocated the way planBlockMove() relocates every
  // other block's — verbatim. Markers and ordinals are RUN-GLOBAL: '3. charlie'
  // moved to the head of its run has to come back as '1. charlie' with
  // everything behind it renumbered, and its indent prefix is a column count
  // measured against the marker widths standing above it. So a li's move is
  // expressed the way duplicateListItems() expresses a duplicate — as a
  // REORDERED SPAN ARRAY handed to serializeBlocks(), committed over the run's
  // own line range as ONE commitRangeEdit (§3.4: one gesture, one undo op).
  // These two functions are the parts of that reasoning with no DOM in them.

  // The span order after "the `count` members starting at `from` go
  // immediately before the member at `insertAt`". `insertAt` names a slot in
  // the array BEFORE the removal — it comes straight from the drop target's
  // `before-block N` — so a DOWNWARD move is decremented by the WHOLE count
  // and an upward one is not decremented at all: the same `insertAt` means two
  // different slots depending on the direction, which is the whole reason this
  // is a named function with its own test rather than a splice pair at the
  // call site.
  //
  // S4 Task 6 widened it from one member to `count`, in place rather than
  // beside: §4.5's 「grip 在選取集合內 → 整批搬」 is the SAME arithmetic and a
  // second copy of an off-by-one is the 「不得另寫一條」 shape §3.6 has already
  // ruled against twice. The single-item case is `count === 1` and its whole
  // test table was migrated onto this signature unchanged.
  //
  // `null` means the order would be UNCHANGED, which is a byte no-op and not a
  // failure: every `insertAt` from `from` to `from + count` inclusive is the
  // SET'S OWN FOOTPRINT — `from` is "released on my own top edge",
  // `from + count` is "released on the seam immediately below me", and the
  // slots in between name a position INSIDE the set, which is not a reorder of
  // the span but a shuffle of members that are travelling together. Visually
  // they are all the same place, and they are the case the drag's own
  // release-where-you-started gesture depends on. An out-of-range index, an
  // empty set and a set that runs off the end answer `null` too; there is no
  // order any of them could name.
  function reorderSpanRange(length, from, count, insertAt) {
    if (!(length > 0) || !(count > 0)) return null;
    if (!(from >= 0) || from + count > length) return null;
    if (!(insertAt >= 0) || insertAt > length) return null;
    if (insertAt >= from && insertAt <= from + count) return null;
    const rest = [];
    const moved = [];
    for (let i = 0; i < length; i++) {
      if (i >= from && i < from + count) moved.push(i); else rest.push(i);
    }
    const at = insertAt > from ? insertAt - count : insertAt;
    return rest.slice(0, at).concat(moved, rest.slice(at));
  }

  // ── S4 Task 6: the LINE RANGE a batch move relocates (spec §3.3, §4.5) ──
  //
  // §3.3's operand set is CONTIGUOUS in block order — resolveGutterOperands()
  // refuses a gap before anything reaches here — so its members' lines plus
  // the separators standing between them are ONE contiguous run, which is
  // exactly what planBlockMove() relocates verbatim. That is the whole reason
  // a batch move is the SAME single commitRangeEdit a one-block move is, and
  // therefore the same single Ctrl+Z (§3.4).
  //
  // Named rather than written as an object literal at the call site because
  // the set reaches the bytes through this one expression and nothing else: an
  // endLine taken from any member but the LAST leaves the rest of the set
  // standing where it was while its head travels, and the blank-line rules
  // then re-emit separators around both halves — a document the user never
  // asked for, from a one-token typo. A pure function is a mutation a test can
  // kill in a millisecond instead of a browser round trip.
  function spanMoveRange(recs) {
    if (!recs || !recs.length) return null;
    return { startLine: recs[0].startLine, endLine: recs[recs.length - 1].endLine };
  }

  // §4.5's INDENT SEAM, asked of the span AS IT WOULD BE COMMITTED.
  //
  // Markdown indent is only ever RELATIVE (indent-clamp.js's own opening
  // sentence): an item's depth exists solely because a shallower item stands
  // above it. serializeBlocks() rebuilds its marker-width stack as it walks the
  // array, from empty — so a span whose FIRST block claims `data-indent="1"`
  // emits that block at column 0, and the DOM and the file then disagree about
  // the nesting. A move creates exactly that by lifting an item out from above
  // its own child.
  //
  // The bound is deliberately the one indent-clamp.js's `boundAt()` computes
  // — the previous li's indent + 1, and 0 when there is no previous li or the
  // previous block is not one — so the predicate and the clamp cannot drift.
  //
  // S4 Task 7 KEPT it and moved it to AFTER the clamp. Asked of the raw
  // reordered span it refused 1425 of the 4067 legal drops; the clamp now
  // answers 1411 of those, and what this still refuses is the 14 no
  // removal-clamp can reach — a batch whose last member is shallower than the
  // block it lands before, i.e. the INSERTION half of the move. See
  // performListItemDrop() for the single site and BLOCK_MOVE_ORPHAN_MESSAGE
  // for the family and the sweep behind those numbers.
  function spanIndentsAreAnchored(items) {
    let prevLi = null;
    for (let i = 0; i < (items || []).length; i++) {
      const it = items[i] || {};
      if (it.type !== 'li') { prevLi = null; continue; }
      const indent = typeof it.indent === 'number' ? it.indent : 0;
      if (indent > (prevLi === null ? 0 : prevLi + 1)) return false;
      prevLi = indent;
    }
    return true;
  }

  // ── S4 Task 5: the CROSS-BOUNDARY seam predicate (spec §4.5) ──────────
  //
  // §4.5's ruling, made by the user on 2026-09-01 and implemented rather than
  // re-opened: a cross-boundary move is REFUSED with a banner in 3.0.0 and the
  // capability deferred to 3.1.0, whose first step is amending the spec with
  // the blank-line rule for a run/non-run seam. This function is the whole of
  // "which moves cross a boundary" for a block that is NOT a list item; a li
  // source has its own, narrower question (its destination must be a slot in
  // its own §3.8 run) and answers it in performListItemDrop().
  //
  // A move touches TWO seams and they need DIFFERENT rules. That asymmetry is
  // the task's finding, and every row below is a marked.lexer measurement:
  //
  //   DESTINATION — where the block LANDS. An insertion can only ever SPLIT;
  //   it has no way to merge two lists. So the only thing it can break is a
  //   run it lands INSIDE, and the question is exactly "are these two
  //   neighbours members of ONE run":
  //     '# Doc\n\npara\n\n- a\n- b\n\ntail\n' with `para` spliced
  //       between the items -> list(1) | paragraph | list(1): one two-item run
  //       became two one-item runs, and the blanks rule 3 emits either side
  //       are §4.3's looseness trap. REFUSED.
  //     '# Doc\n\n- a\n\n1. b\n\ntail\n' with `para` spliced at the
  //       same-looking seam -> heading | ul(1,tight) | paragraph |
  //       ol(1,tight) | paragraph. Nothing merged, nothing loosened, because
  //       these were already two lists. ACCEPTED — this is Task 3's
  //       deliberate over-refusal, and narrowing it is what Task 5 owed.
  //
  //   SOURCE — where the block LEAVES. A removal MERGES, and it CANNOT be
  //   narrowed with anything the block model carries. Every one of these
  //   leaves ONE list with `loose === true`, i.e. every item renders as a <p>,
  //   serializeBlocks() reports 'P' for each, and the whole run degrades
  //   read-only with no banner:
  //     '- a'      | para | '- b'        ->  '- a\n\n- b\n'
  //     '1. a'     | para | '2. b'       ->  '1. a\n\n2. b\n'
  //     '- [ ] a'  | para | '- [x] b'    ->  '- [ ] a\n\n- [x] b\n'
  //     '- a'      | para | '  1. a1'    ->  '- a\n\n  1. a1\n'
  //   The last one is why the obvious narrowings are all wrong. blockmap
  //   reports those two items as (indent 0, listType 'ul') and (indent 0,
  //   listType 'ol') — DIFFERENT runs AND different list types, so every fact
  //   the model exposes says "two lists, safe", while the file says loose.
  //   What decides it is the two-space prefix on a raw line, which no block
  //   attribute carries and which the client cannot lex (render is a server
  //   round trip; there is no lexer in the browser). The mirror over-refusal
  //   is '- a' | para | '* b' -> '- a\n\n* b\n', measurably TWO tight
  //   lists and still refused, because the discriminator there is the bullet
  //   CHARACTER — another raw byte the model does not carry. Recorded in §4.5
  //   as a deliberate over-refusal for 3.1.0, not as a correctness claim.
  //
  // `srcSeam` / `destSeam` are `{prev, next}`; each side is null when there is
  // no such block or it is not a li, and otherwise `{runKey}` — the
  // `data-block-id` of the FIRST member of listRunOf(), which is §3.4 rule 2's
  // scope, so a nested child and its parent answer the SAME key. A null
  // runKey (a run the DOM could not answer) counts as "same": an unknown seam
  // refuses rather than guesses, because the guess that goes wrong corrupts a
  // list and corrupting a list is not undoable.
  //
  // Returns 'source' | 'destination' | null. When both seams object the
  // SOURCE one is reported: it is the objection that holds wherever the user
  // aims next, so it is the one worth telling them about.
  //
  // Pure, and exported, because the enumeration it encodes is a table of
  // measurements — a gesture-level test can only reach a handful of its rows.
  function blockMoveSeamRefusal(srcSeam, destSeam) {
    const s = srcSeam || {};
    const d = destSeam || {};
    if (s.prev && s.next) return 'source';
    if (d.prev && d.next &&
        (d.prev.runKey === null || d.next.runKey === null ||
         d.prev.runKey === d.next.runKey)) return 'destination';
    return null;
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
  // because the idiom is copy-pasted and the next site to copy it will not
  // remember either. Declared in the pure core so it is reachable from node: the branch
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
    module.exports = { extractBlockSource, commitEdit, commitRangeEdit, commitRangeRemoval, commitListBlockRemoval, commitBlockInsertion, planBlockMove, commitBlockMove, reorderSpanRange, spanMoveRange, spanIndentsAreAnchored, blockMoveSeamRefusal, rollbackFailedRender, headingDepthOf, withHeadingDepth };
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
  // v3.1.0 Task E: the four Phase-1 modules, injected by server.js ahead of
  // this file. Read the same way every earlier module is — off `window`, not
  // via require() (this script is a plain <script> tag in the page, not a
  // bundle). Each is read defensively at its call sites: an older cached page
  // that predates the injection must degrade to "the toolbar is absent",
  // never to "the whole client runtime throws before it arms anything".
  const toolbarModel = window.md2docToolbarModel;
  const pasteMd = window.md2docPasteMd;
  const assetLib = window.md2docAsset;
  const docSourceLib = window.md2docDocSource;
  let lines = ED.lines, blocks = ED.blocks, mtimeMs = ED.mtimeMs;
  let lastParts = null;
  // F10: 上一次【成功套用】的 render 留下來的東西 —— 當時的整份 `lines`，以及
  // 當時的文件是不是以一道沒閉合的圍欄收尾。
  //
  // fix round 2 (K7): 這裡不再說「跟 `blocks` 一起前進」，那句是錯的。`blocks`
  // 是被 applyPatch()／applyFullRender() 自己換掉的（applyFullRender() 的第一行
  // 就是 `blocks = j.blocks`），時機不受套用成功與否管；下面這些狀態則是
  // applyRenderResult() 在【呼叫那些 apply 之前】讀、在【套用成功之後】才寫的，所以
  // 判別式讀到的一定是上一份已經上過畫面的狀態。
  //
  // 開場值從 bootstrap payload 直接算（ED.lines 與 ED.blocks 是
  // lib/editor/server.js 的 GET /edit/:id 在同一個回應裡送出來的），這樣一份
  // 【開檔時就已經沒閉合】的文件不會在使用者的下一個手勢上被誣賴成吞噬。
  let lastRenderLines = ED.lines.slice();
  let lastRenderEndedUnclosed = endsWithUnclosedFence(ED.lines, ED.blocks);
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

  // T21 item 1: the burst Escape most recently threw away, kept alive for
  // exactly one document-level Ctrl+Z. Escape means DISCARD and still does —
  // what changed is that the discard is no longer unrecoverable. Driven on
  // this branch before the fix, on all three burst surfaces (paragraph, table
  // cell, list item): type, Escape, then Ctrl+Z ×3 and Ctrl+Y ×3 — the text
  // was gone after all six, and the title went '● doc' -> 'doc', so the
  // beforeunload guard was disarmed over it too.
  //
  // The burst's OWN history is what carries the text back, which is why this
  // holds the history object rather than an HTML string: revertBurstAndEnd()
  // snapshots on both sides of the revert (the discipline every other
  // mutation in this file already follows — see snapBurstIfActive()), so
  // restoring is one history.undo() and the entries UNDER it stay reachable
  // afterwards. `reverted` is the staleness guard: anything that repaints the
  // surface between the Escape and the Ctrl+Z (a render, another block's
  // commit) makes this stash unusable, and it is dropped rather than applied
  // over a document that moved.
  //
  // One slot, cleared the moment any burst opens (startBurst()/
  // startTableBurst()) or the page re-renders (rerenderAll()), so the only
  // window in which it answers a Ctrl+Z is the one the user is complaining
  // about: Escape, then Ctrl+Z.
  let discardedBurst = null; // { history, editEl, blockType, cellIdx, reverted } | null

  function dropDiscardedBurst() {
    if (!discardedBurst) return;
    discardedBurst.history.dispose();
    discardedBurst = null;
  }

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

  // `stack.dirtyDepth` is `_done.length - _savedDepth` (lineops.js), so it
  // moves when an op is pushed onto or popped off the undo stack, or when a
  // save re-baselines it. The burst substrate keeps what the user typed in
  // the DOM until the burst resolves, and none of those has happened yet at
  // that point — so a block that has been typed into but not yet left reads
  // as clean. MEASURED on `# Doc\n\nAlpha paragraph.\n` (click the
  // paragraph, type, then navigate away):
  //   mid-burst    document.title "doc"    no beforeunload dialog
  //   after blur   document.title "● doc"  dialog raised
  // This names that gap, and is the shape bystanderCarryOver() already uses
  // to pick out the block whose bytes are not in `lines` yet — including its
  // `currentBurst.editEl` guard, kept here because this also runs inside the
  // beforeunload handler, where a throw would drop the navigation guard
  // rather than surface.
  function burstHasUncommittedEdit() {
    return !!(currentBurst && currentBurst.editEl &&
      burstBaselineHtml(currentBurst.editEl) !== currentBurst.original);
  }

  function setDirty() {
    const dirty = stack.dirtyDepth !== 0 || burstHasUncommittedEdit();
    document.title = (dirty ? '● ' : '') + baseTitle;
  }

  // setDirty() is push-driven: something has to call it. MEASURED by keeping
  // the predicate above but removing the watcher below — typing into a
  // paragraph still left the title at "doc", so nothing repaints it while a
  // burst is open. That is the second half of the gap. The dot needs
  // something that fires while the burst is still open, and again when the
  // surface goes back to its baseline without a commit.
  //
  // A mutation watcher rather than a list of call sites, because the
  // gestures that dirty a burst and the gestures that clean it again do not
  // share an entry point: typing raises an `input` event, a selection-
  // toolbar mark does not (MEASURED: pressing B over a selection in a
  // paragraph burst leaves the surface `<strong>Alpha</strong> paragraph.`
  // with the document-level `input` listener's inputType log still empty),
  // and a burst-local Ctrl+Z swaps the whole surface in through innerHTML.
  //
  // `attributes` is watched because a gesture exists that writes an
  // attribute and nothing else into a burst that is left open: the
  // edge menu's 對齊 reaches cycleColumnAlign()'s
  // `cell.setAttribute('style', 'text-align:…')`, and runCycleAlign() around
  // it only snap()s the burst history. MEASURED with `attributes` unwatched,
  // driving that menu with real mouse events: `document.title` stayed "doc"
  // while the unload guard DID fire — the predicate saw the edit and the dot
  // did not.
  //
  // 🔗 over an existing link writes an attribute too
  // (applyLinkToggleBody()'s `whole.setAttribute('href', …)`) and does NOT
  // establish this: MEASURED through a real modal rather than a stubbed
  // window.prompt, the prompt takes focus off the surface first, which
  // resolves and commits the burst, so `stack.dirtyDepth` has already moved
  // by the time the attribute lands. Not every attribute write in this file
  // was measured. The table selection chrome is another that reaches a burst
  // surface; burstBaselineHtml() normalises it away, and MEASURED, neither
  // it nor a bare cell click produces a dot.
  //
  // Cost per delivered batch is a `document.title` write, plus a
  // burstBaselineHtml() while `stack.dirtyDepth` still reads clean (the `||`
  // short-circuits past it otherwise). MEASURED, innerHTML serialize plus
  // its indexOf scans on a rendered table block: 0.02 ms at 7.4 KB, 0.06 ms
  // at 21 KB, 0.19 ms at 71 KB.
  const burstDirtyWatcher = new MutationObserver(setDirty);

  // Called wherever a burst opens. disconnect() first because observe() ADDS
  // a target rather than replacing one, so re-pointing is what keeps a single
  // watcher single. MEASURED, observing surface A then surface B on the same
  // observer and mutating both: without the disconnect the callback is
  // delivered records from A as well as B, with it only from B.
  function watchBurstForDirtyDot(editEl) {
    burstDirtyWatcher.disconnect();
    burstDirtyWatcher.observe(editEl, {
      childList: true, subtree: true, characterData: true, attributes: true,
    });
  }

  // ── banners (conflict / render-failed / save-failed) ──────────────────
  // One shared, dismissible banner element. `actionLabel`+`onAction` add an
  // extra button ahead of the always-present ✕ dismiss button (e.g. the
  // conflict banner's "Reload"); omit them for a plain dismiss-only notice.
  let activeBanner = null;
  // Review recommendation 5 (2026-08-31): whether the banner on screen is a
  // structural REFUSAL — 「無法整批操作」 and its siblings — as opposed to a
  // conflict / render-failed / save-failed notice. Only a refusal is cleared
  // by a later gesture that succeeds (see dismissRefusalBanner()); the other
  // three describe the state of the FILE or the connection and must stay until
  // the user dismisses them.
  let activeBannerIsRefusal = false;
  // F10 fix round 1 的對稱項：這條 banner 描述的是【文件現在的形狀】，跟
  // refusal 一樣需要一個「後來的事件可以把它收掉」的記號，但收掉它的條件不
  // 同（見 dismissSwallowBanner()），所以是另一個旗標而不是共用那一個。
  let activeBannerIsSwallow = false;
  function showBanner(message, actionLabel, onAction) {
    if (activeBanner) { activeBanner.remove(); activeBanner = null; }
    // Reset unconditionally: refuseStructuralListEdit() sets it back to true
    // straight after its own call, so every OTHER caller gets false without
    // having to know this flag exists.
    activeBannerIsRefusal = false;
    activeBannerIsSwallow = false;
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
      if (activeBanner === el) {
        activeBanner = null;
        activeBannerIsRefusal = false;
        activeBannerIsSwallow = false;
      }
    });
    el.appendChild(dismissBtn);
    document.body.appendChild(el);
    activeBanner = el;
    return el;
  }

  // Review recommendation 5: a refusal banner must not outlive the gesture that
  // raised it. refuseStructuralListEdit() has been dismiss-only since S1, and
  // S3 made it far more reachable (7 of the T8 sweep's 13 selection shapes
  // refuse), so 「選取範圍同時含有清單項目與其他區塊，無法整批操作」 could stand
  // over a document the user had since successfully edited — a plain lie about
  // the state of the document. Called from rerenderAll()'s success path, which
  // is the one point every structural operation reaches only by having WORKED:
  // every failure exit above it returns before this. Deliberately NOT called
  // from the Escape / clear-selection paths — dismissing a selection is not the
  // same event as a later gesture succeeding, and the refusal is still the true
  // answer to the gesture the user last attempted.
  function dismissRefusalBanner() {
    if (!activeBanner || !activeBannerIsRefusal) return;
    activeBanner.remove();
    activeBanner = null;
    activeBannerIsRefusal = false;
  }

  function showConflictBanner() {
    showBanner(
      'File changed on disk — reload to pick up external edits ' +
      '(your unsaved changes will be lost).',
      'Reload',
      () => location.reload()
    );
  }

  // F10 ——「一道沒閉合的圍欄把後面的內容吃掉了」那一句，單獨一個常數。
  // test/editor-journey.test.js 的 F10 那一列釘的是這串文字本身，而不是
  // 「畫面上有一條 .ed-conflict」。那個 class 只有 showBanner() 一個產生點，
  // 而 showBanner() 的呼叫端（grep 全檔逐一開過）橫跨這些彼此無關的家族：
  //   - 磁碟衝突：showConflictBanner()
  //   - render 失敗：rerenderAll() 的 'Render failed — network error'／
  //     'Render failed — ' + reason／'Render failed — malformed server response'
  //     ，加上 safeRerenderAll() 的 'Render failed — unexpected error'
  //   - save 失敗：save() 的 'Save failed — network error'／
  //     'Save failed — malformed server response'／'Save failed — ' + reason
  //   - 手勢在 render 與 render 之間失去目標：DROPPED_GESTURE_MESSAGE
  //   - 清單／表格的結構性拒絕：refuseStructuralListEdit()、'無法刪除最後一欄'、
  //     '無法刪除標題列'、'無法刪除最後一列'
  //   - burst 降級：'含不支援的格式，改用原始碼編輯'
  //   - 工具列插圖：TOOLBAR_UNSUPPORTED_IMAGE_MESSAGE、'圖片讀取失敗 — '、
  //     '圖片上傳失敗 — '（網路 throw／非 2xx／回應格式不正確）、
  //     TOOLBAR_NO_ANCHOR_MESSAGE
  // 光看 class 分不出是哪一個。
  const SWALLOW_MESSAGE = '這道 ``` 圍欄沒有閉合，它後面的內容全部被吃進' +
    '同一個程式碼區塊裡了。把收尾的圍欄補回去就會復原。';

  // F10 —— 吞噬的【形狀】，不是計數。
  //
  // 這支問的是「最後一個區塊是不是一道沒閉合的圍欄」：type 是 code、它的開頭
  // 那一行真的是一道圍欄（縮排式 code block 的 type 也是 code、開頭行不是圍欄，
  // 靠 fenceOpenerOf() 排掉），而它底下沒有任何一行能收掉那道圍欄（closesFence()
  // 認字元與長度 —— 見 fenceOpenerOf() 與 closesFence() 的註解，K1／K3）。只有開頭圍欄、還沒有本文與收尾
  // 的單行 code 區塊也算沒閉合。
  //
  // 為什麼只看最後一個區塊：**頂層**的一道沒閉合的圍欄會一路吃到檔尾，所以它
  // 就是最後一個區塊。巢狀在 blockquote／清單項裡的圍欄不是這樣，但它也不吃到
  // 檔尾 —— MEASURED（buildBlockMap）：
  //   '# Doc\n\n> ```js\n> code\n\nTail.\n'   heading blockquote[3,4] paragraph[6,6]
  //   '# Doc\n\n- ```js\n  code\n\nTail.\n'   heading li[3,4]         paragraph[6,6]
  //   '# Doc\n\n```js\ncode\n\nTail.\n'       heading code[3,6]
  // 容器在空行就結束了，'Tail.' 還在外面、沒有被吃掉，所以這支不看它、也不需要
  // 看它。
  //
  // `srcLines` 是 1-indexed 行號要索引的那個陣列（呼叫端傳模組層的 `lines`
  // 或 bootstrap 的 ED.lines），`blockList` 是與它同一份快照的 block 陣列。
  function endsWithUnclosedFence(srcLines, blockList) {
    if (!Array.isArray(blockList) || blockList.length === 0) return false;
    const last = blockList[blockList.length - 1];
    if (!last || last.type !== 'code') return false;
    const opener = fenceOpenerOf(srcLines[last.startLine - 1]);
    if (!opener) return false;   // 縮排式 code block：type 也是 code，但開頭不是圍欄
    for (let n = last.startLine + 1; n <= last.endLine; n++) {
      if (closesFence(srcLines[n - 1], opener)) return false;
    }
    return true;
  }

  // F10 —— 吞噬與【修剪】的差別是【歸屬】，而歸屬要算數量，不是問有沒有。
  //
  // 「形狀 ∧ 區塊少了」擋掉了純計數判別的那族誤報，但放進來另一族：使用者把收
  // 尾圍欄連同它後面的東西一起【刪掉】（往檔尾 trim），區塊照樣掉、文件照樣以沒
  // 閉合的圍欄收尾 —— 可是圍欄後面本來就沒東西了，是使用者自己刪的。那時候那句
  // 話的每一個子句（「後面的內容全部被吃進去」「補回收尾圍欄就會復原」）都是假的。
  //
  // 真正的差別：吞噬時，本來活在 fenced code block【外面】的行跑進了裡面；修剪
  // 時那些行只是不見了。這裡用內容比對，不做行號對齊（對齊在插入／刪除混在一起
  // 時很脆，這個做法完全不需要它）。
  //
  // fix round 3 (L1)：上一版問的是【有沒有】—— 「這一行以前在外面，而現在不在
  // 外面了」。那個問法朝相反的方向各說一種謊，下面每一種都是驅動出來的：
  //   往檔尾 trim，而圍欄本文有一行【也】出現在被刪掉的尾巴裡（散文重複了它自己
  //     用圍欄展示的那道指令，是這個形狀最普通的樣子）→ 什麼都沒被吃掉卻會叫。
  //   真吞噬，但被吃掉的那一行文件別處【還有一份】→ 「現在不在外面」不成立，
  //     於是不叫。被吃掉的每一行都有副本時整個吞噬都消音。
  //   被吃掉的是一個【縮排式】code block → 上一版把它算成「本來就在 code 裡」，
  //     於是不叫。
  //
  // 所以改成算數量，而且是【逐行】判：走過新的尾端圍欄本文裡出現過的每一種非
  // 空行內容，只要有一行【自己】同時滿足下面這些條件，就是吞噬，當場 return：
  //
  //   wasOutCount > nowOutCount —— 這一行在上一份／這一份 render 裡出現在
  //     fenced code block【外面】的次數。外面的份數變少 ＝ 它被吃進去了。
  //   nowTotal >= prevTotal —— 同一行在上一份／這一份【整份文件裡】出現的次數
  //     （圍欄裡的份數也算）。沒有變少 ＝ 它只是換了位置，不是被刪掉。
  //
  // fix round 4 (M1)：前半與後半在上一版是【各自加總】再比一次的，那讓不同的
  // 行互相抵銷，不論哪個方向都出事。真吞噬靜默：code block 裡有一行重複（`}`
  // 是日常樣子），一次編輯刪掉其中一份並且刪掉收尾圍欄 —— 被吃掉的那一行自己
  // 前半與後半都成立，卻被那個消失的 `}` 拉低總數而抵銷掉。誤報回來：往檔尾
  // trim 的同一次編輯裡把本文某一行複製一份 —— 被 trim 掉的那一行撐前半、被複
  // 製的那一行撐後半，湊出一個沒有任何一行自己成立的「真」。
  //
  // 「總數」刻意只算這一行、而且連圍欄裡的份數一起算，不是整份文件的行數：
  // 最常見的真吞噬是【只刪掉收尾圍欄那一行】，整份文件的非空行數會因此少一行，
  // 用文件層級的總數當門檻會把它殺掉（那也是為什麼不能用 Δlines >= 0）。
  //
  // 「不在 fenced code block 內」不是「不在 code block 內」：縮排式 code block
  // 的 type 也是 code，但它是文件裡看得見的內容，被一道圍欄吃掉一樣是吞噬。
  // 靠 fenceOpenerOf() 分辨（開頭那一行是不是圍欄）。

  // 一份 render 裡，每一種非空行內容出現了幾次：`out` 只數【不在任何 fenced
  // code block 內】的那些，`all` 數整份文件。
  function lineCounts(srcLines, blockList) {
    const inFence = {};
    for (const b of blockList) {
      if (!b || b.type !== 'code') continue;
      if (!fenceOpenerOf(srcLines[b.startLine - 1])) continue;
      for (let n = b.startLine; n <= b.endLine; n++) inFence[n] = true;
    }
    const out = Object.create(null);
    const all = Object.create(null);
    for (let n = 1; n <= srcLines.length; n++) {
      const row = srcLines[n - 1];
      if (typeof row !== 'string' || row.trim() === '') continue;
      all[row] = (all[row] || 0) + 1;
      if (!inFence[n]) out[row] = (out[row] || 0) + 1;
    }
    return { out: out, all: all };
  }
  // `tail` 是新的 block 陣列的最後一個（呼叫端已經確認它是一道沒閉合的圍欄）。
  function absorbedOutsideContent(prevLines, prevBlocks, newLines, newBlocks, tail) {
    const was = lineCounts(prevLines, prevBlocks);
    const now = lineCounts(newLines, newBlocks);
    const seen = Object.create(null);
    for (let n = tail.startLine + 1; n <= tail.endLine; n++) {
      const row = newLines[n - 1];
      if (typeof row !== 'string' || row.trim() === '' || seen[row]) continue;
      seen[row] = true;
      const wasOutCount = was.out[row] || 0;
      const nowOutCount = now.out[row] || 0;
      const prevTotal = was.all[row] || 0;
      const nowTotal = now.all[row] || 0;
      if (wasOutCount > nowOutCount && nowTotal >= prevTotal) return true;
    }
    return false;
  }

  // F10 fix round 1 —— 吞噬的 banner 必須退場。
  //
  // 它不是 refusal，所以 dismissRefusalBanner() 不會碰它（那支只清
  // `activeBannerIsRefusal`）。退場的條件不是「後來有一次成功的編輯」而是
  // 「文件不再以沒閉合的圍欄收尾」：圍欄還開著的時候，後面的內容就還被吃著，
  // 那時候把警告收掉才是說謊。呼叫點在 applyRenderResult() 套用成功之後。
  function dismissSwallowBanner() {
    if (!activeBanner || !activeBannerIsSwallow) return;
    activeBanner.remove();
    activeBanner = null;
    activeBannerIsSwallow = false;
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
  async function rerenderAll(editRange) {
    // T21 item 1: this render is about to replace the surfaces the stash names,
    // so whatever Escape put there stops being restorable here. The staleness
    // guard in restoreDiscardedBurst() would refuse it anyway; dropping it at
    // the source is what keeps a dead history object from being held.
    dropDiscardedBurst();
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
    if (!Array.isArray(j.parts) || !Array.isArray(j.blocks)) {
      showBanner('Render failed — malformed server response. Your edit was not applied.', null, null);
      return false;
    }
    // Past every failure exit: this render is going to happen, so whatever
    // gesture asked for it has succeeded. Review recommendation 5 — a stale
    // structural refusal is cleared HERE and nowhere else.
    dismissRefusalBanner();
    // Task E: rerenderAll() now takes `editRange` as its own parameter —
    // every call site that has a real op computes it there (see the 18
    // safeRerenderAll() call sites that pass one) and threads it down through
    // safeRerenderAll() to here. Passed straight through to
    // applyRenderResult() as the second positional argument; Task F is what
    // actually reads it to decide patch-vs-fallback.
    //
    // Fix round 1: `scrollY` and `declaredRange` are captured ABOVE, before
    // the extraction boundary (they must be read early — see their own
    // comments — well before this point), so they are NOT part of the
    // moved tail and are out of `applyFullRender`'s scope unless threaded
    // through explicitly. Passed positionally here and through
    // applyRenderResult() rather than folded into `j` (which is the
    // server's response payload, not render-context the CALLER derived).
    return applyRenderResult(j, editRange, scrollY, declaredRange);
  }

  // v3.2.0 Task F: patch-vs-fallback dispatch.
  //
  // `scrollY`/`declaredRange` are rerenderAll()'s own pre-fetch captures
  // (see its comments) — applyFullRender() needs them for the same
  // window.scrollTo()/rebuildBlockSelection() calls the tail always made,
  // but as a sibling function it cannot reach rerenderAll()'s locals by
  // closure, so they ride along here instead.
  //
  // `scrollY` is forwarded to applyFullRender() ONLY (controller ruling F3):
  // the fallback needs it because `contentEl.innerHTML = ...` destroys and
  // rebuilds every node, collapsing the scroll extent to zero for an instant;
  // the patch path leaves the prefix and suffix nodes attached, so the scroll
  // position never moves and re-applying a pre-fetch scrollY would fight the
  // browser (the reader may legitimately be somewhere else by the time the
  // response lands).
  //
  // `editRange` gates the patch attempt AS A BOOLEAN and in no other way: the
  // 3 call sites with no committed op pass nothing and fall back by contract.
  // Its VALUE is forwarded to patchmap(), which never reads it (決議 4(b) — it
  // is advisory, and seeding the span from an op's line range measurably
  // widens the answer), so neither the direction nor the width of the range
  // affects the plan. `lastParts` is null
  // on the first render of a session (the bootstrap payload carries no parts),
  // which makes patchmap() return null — so the first commit after a page load
  // is ALWAYS a full render. That is specified behaviour, not a bug.
  // Fix round 2: applyPatch()'s index arithmetic addresses `contentEl`'s
  // element children POSITIONALLY against `lastParts`. That correspondence is
  // not free — several gestures mutate .content's child list DIRECTLY, in the
  // window between two renders, and every one of them breaks it:
  //
  //   :insertListItemAfter()   inserts a PROVISIONAL li (no data-block-id at
  //                            all) as a sibling before its own commit renders
  //   :splitListItemAtCaret()  same shape, on Enter inside a li
  //   :duplicateListItem()     inserts cloneNode()d copies, which carry the
  //                            ORIGINAL's data-block-id — duplicated ids
  //   :moveListItem()          re-inserts existing li elements at a new
  //                            position: the COUNT is unchanged and every id
  //                            is still present, only the ORDER moved
  //   :removeListItem()        REMOVES li elements outright (the Backspace-
  //                            join and multi-item-delete paths), so the
  //                            child count drops below lastParts.length
  //                            before the render that would explain it
  //
  // MEASURED on the ＋→清單 gesture with a dirty burst open on the anchor
  // (test/editor-client-runtime.test.js:3918): two commits land back to back,
  // and at the second one `lastParts.length` is 3 while contentEl has 4
  // children. patchmap computes a zero-width insertion at index 2, the removal
  // loop removes nothing, and the fragment is inserted BEFORE the provisional
  // node — which nobody then removes. Four li blocks where three belong. The
  // fallback never had the problem: `innerHTML =` wipes whatever the gesture
  // left behind.
  //
  // So the patch path checks, cheaply and positionally, that the DOM still
  // reads exactly as the last render left it: same number of children, and
  // child i still carrying block i's id. Any of the four mutations above fails
  // one of those, and that render falls back — i.e. exactly the pre-v3.2.0
  // behaviour for those gestures, which is why this cannot regress them.
  //
  // ⚠ What it does NOT check is whether a kept node's MARKUP still equals the
  // part that produced it — a gesture that rewrites an attribute in place
  // (data-indent, data-list-start) without changing the child list passes this
  // guard. That is a different family (kept nodes carrying stale local state)
  // and is tracked separately; do not grow this predicate into it without
  // measuring the cost, because unlike this walk that one is not O(1) per node.
  function domMatchesLastRender() {
    if (!Array.isArray(lastParts) || !Array.isArray(blocks)) return false;
    if (blocks.length !== lastParts.length) return false;
    const kids = contentEl.children;
    if (kids.length !== lastParts.length) return false;
    for (let i = 0; i < kids.length; i++) {
      // Compared against blocks[i].id rather than against `i`: the two are the
      // same today (blockmap.js hands out a positional ordinal, which is what
      // makes patchmap's idDelta rewrite work at all) but the JOIN KEY is the
      // id, and stating it that way is what keeps this honest if that identity
      // is ever relaxed.
      if (kids[i].getAttribute('data-block-id') !== String(blocks[i].id)) return false;
    }
    return true;
  }

  async function applyRenderResult(j, editRange, scrollY, declaredRange) {
    // F10 —— 判別式：【形狀 ∧ 歸屬】。
    //
    // 第一版是純計數（Δblocks < 0 且 Δlines >= 0）。實測它在再普通不過的編輯
    // 上就會叫，磁碟位元組卻完全正確 —— 全文原始碼裡把一行的字清掉但行留著
    // （blocks 4->3、lines 8->8）、⠿「MD 原始碼」裡把一段清成空字串或一個空白
    // （同樣 4->3、8->8）、把每一段的字都清掉（4->1、8->8）。計數分不開「一個
    // 區塊因為自己的內容被清空而消失」與「一個區塊因為被別人吸收而消失」。
    //
    // 第二版是「形狀 ∧ 區塊少了」。形狀那一半擋掉了上面那族，但效果那一半只
    // 是計數換個位置，於是放進來一族新的：使用者把收尾圍欄連同它後面的東西一
    // 起【刪掉】（往檔尾 trim），區塊照樣 4~5 掉到 3、文件照樣以沒閉合的圍欄
    // 收尾，可是圍欄後面本來就沒東西了 —— 是使用者自己刪的。那時候那句話的
    // 每一個子句都是假的。
    //
    // 這一版把效果那一半換成【歸屬】（見 absorbedOutsideContent()）：新的尾端
    // 圍欄的本文裡，有沒有哪一行在上一份 render 裡活在 code block 外面、而在
    // 這一份已經不在外面了。吞噬時有（那些行被吃進去了），修剪時沒有（那些行
    // 不見了，不是搬進去）。
    //
    // 每一項各擋掉一族，而且各有一列 journey 案例釘住它 —— 把那一項【單獨】拿
    // 掉，那一列就紅。這是機械掃出來的，不是看出來的：判別式、歸屬測試自己的組
    // 成、圍欄配對器的每一條規則，各自單獨 ablate 一次，每次都把 F9／F10 那一段
    // 的案例逐列跑過，記錄哪一列紅。
    //   nowUnclosed              —— 使用者自己按「轉換成 › 程式碼」把重複的一段
    //                               包進圍欄裡，外面的份數當然少一份，但文件並沒
    //                               有以沒閉合的圍欄收尾（PIN-shape）
    //   !lastRenderEndedUnclosed —— 一開檔就沒閉合的文件靠它不被誣賴（PIN-prev、
    //                               G7）
    //   absorbedOutsideContent   —— 往檔尾 trim 與「圍欄後面沒東西」靠它擋
    //                               （K2 的 X4／P1／P2／P7、控制列 C3）
    //
    // 量到的漏網（false negative；同一次掃描量到的誤報是零）。把一道 '```' 用
    // 全文原始碼插進 baseline（'# Doc' / 'Alpha.' / 一段 ```js 圍欄 / '## Next' /
    // 'Bravo.' / 'Charlie.' / '- x' / '- y'）的每一個行位置，逐一【驅動】過，
    // 再拿 buildBlockMap 算出的真值（有沒有本來在 code block 外面的非空行跑進
    // 去了）對答案：
    //   插在第 6..16 行之前   真的吃到東西 → 有叫
    //   插在第 4、5、17、18 行之前   什麼都沒吃到 → 沒叫（正確）
    //   插在第 1、2、3 行之前   真的吃到東西 → 【沒叫】
    // 第 1/2/3 行那些格的機制跟計數無關：新的開頭圍欄跟文件裡【原本就有的】
    // 那道收尾圍欄配成一對，所以吃掉東西的那個 code block 是【閉合】的，文件
    // 也不是以沒閉合的圍欄收尾 —— 形狀那一半看不到它。而且那個結果跟使用者
    // 自己按 ⠿「轉換成 › 程式碼」得到的形狀一模一樣（同一份語料裡那一列必須
    // 靜默），兩者只差在意圖，文件本身分不出來。
    //
    // 另一族漏網（同樣是量到的，同樣不打算靠再改一版判別式去關）：**同一次編輯
    // 刪掉收尾圍欄，而且也刪掉了被吃那一行內容的另一份**。被吃的那一行前半成
    // 立（圍欄外面的份數變少），但後半的整份文件份數也跟著少了，所以那一行自己
    // 不成立，於是靜默。瀏覽器裡驅動確認過：'Bravo.' 在圍欄裡與圍欄外各一份，
    // 刪掉圍欄裡那一份與收尾圍欄之後，外面那個 'Bravo.' 真的被吃進去（區塊由
    // 區塊數真的變少、磁碟是 '# Doc\n\n```js\n\nBravo.\n'），banner 不出現。
    //
    // 為什麼不關：拿「這一行在圍欄裡的份數變多了」（nowIn > wasIn）去換掉後半，
    // 在同一份位置真值的掃描上只關掉一部分漏網，卻把誤報從零帶到有 —— 對一個
    // 警告來說，誤報那個方向才是致命的（叫錯一次，使用者就再也不信它），而漏掉
    // 一次警告只是把使用者留在 v3.3.0 之前的狀態：本來就沒有信號。所以這些
    // 漏網是**寫下來的已知缺口**，不是待修的 bug，也刻意不寫成測試案例 —— 把缺
    // 口釘成「預期行為」會讓將來真的補起來時看起來像退步。
    //
    // 反方向已知的例外，而且它是**設計的極限、不是沒修**：使用者往檔尾 trim，
    // 同一次編輯又把被 trim 掉那一行的內容複製進圍欄本文。實測那些手勢產生的
    // 文件**逐位元組相同**（'# Doc\n\n```sh\nsetup\nsetup\n' —— 一邊是把
    // 'setup' 複製進去再 trim，另一邊是單純刪掉收尾圍欄讓外面那個 'setup' 被吃
    // 進去），所以任何只看文件內容的判別式都分不開它們。這一格會叫，而它叫的
    // 那份文件確實跟一次真吞噬的結果一模一樣。
    //
    // 讀的時機：`blocks` 與 `lines` 都必須在呼叫 applyPatch()／
    // applyFullRender() 之前讀 —— applyFullRender() 的第一行就是
    // `blocks = j.blocks`，applyPatch() 也在它那段 mutation window 之前把
    // `blocks` 換掉（先存一份 prevBlocks 好在自己的 catch 裡回捲）。`lines`
    // 已經是這次 render 的輸入（rerenderAll() 送出去的 body 就是
    // `lines.join('\n')`），而上一份的 `lines` 存在 `lastRenderLines` 裡。
    const nowUnclosed = endsWithUnclosedFence(lines, j.blocks);
    const swallowed = nowUnclosed && !lastRenderEndedUnclosed &&
                      absorbedOutsideContent(lastRenderLines, blocks,
                                             lines, j.blocks,
                                             j.blocks[j.blocks.length - 1]);
    const plan = (editRange && window.md2docPatchmap && domMatchesLastRender())
      ? window.md2docPatchmap.patchmap({
          oldBlocks: blocks, newBlocks: j.blocks,
          oldParts: lastParts, newParts: j.parts, editRange: editRange,
        })
      : null;
    const ok = plan ? await applyPatch(j, plan, declaredRange)
                    : await applyFullRender(j, scrollY, declaredRange);
    // applyPatch() 與 applyFullRender() 今天都只回 true：applyFullRender() 全函
    // 式唯一的 return 就是尾端
    // 那個 `return true`，而 applyPatch() 要嘛回 true、要嘛在自己的 catch 裡
    // 把整件事交給 applyFullRender()。所以這道門今天不會擋下任何東西；它存
    // 在是為了把「render 沒套用成功就不要前進上面那些 lastRender* 狀態、也
    // 要為一次沒上畫面的編輯升起警告」這件事寫在這裡，而不是留給讀者去讀
    // 它們的本體。
    if (!ok) return false;
    lastRenderLines = lines.slice();
    lastRenderEndedUnclosed = nowUnclosed;
    // 升 banner 排在套用之後：套用是把新的 DOM 放上畫面那一步，警告的是使用
    // 者【現在看到的】那份文件。applyPatch()／applyFullRender() 自己不呼叫
    // showBanner()，所以這一句不會被同一次 render 裡的另一句蓋掉。
    if (swallowed) {
      showBanner(SWALLOW_MESSAGE, null, null);
      activeBannerIsSwallow = true;   // 順序同 refuseStructuralListEdit()：
                                      // showBanner() 自己會把旗標歸零。
    } else if (!nowUnclosed) {
      // 圍欄補回去了（或者這次 render 之後文件本來就不是那個形狀）——
      // 警告已經不再是真的，收掉。見 dismissSwallowBanner() 的註解。
      dismissSwallowBanner();
    }
    return true;
  }

  // Incremental DOM patch: replace ONLY the middle span patchmap identified,
  // leaving every prefix and suffix node attached. Keeping those nodes in
  // place is the whole point — it is what preserves document.activeElement,
  // the caret offset, already-rendered mermaid/WaveDrom SVGs and the scroll
  // position across a commit.
  //
  // `declaredRange` arrives as a PARAMETER and is never re-read from
  // `pendingSelectionRange` here (controller ruling F2): rerenderAll() already
  // consumed that module-level slot before it even issued the fetch (see its
  // own comment for why it must be consumed that early), so re-reading it here
  // would always yield undefined and silently drop selection restoration on
  // every patched commit.
  async function applyPatch(j, plan, declaredRange) {
    // 步驟 4 的五步。順序是 spec 決議 2(c) 定死的：
    //   1) 消費 pendingSelectionRange（已由 rerenderAll() 在 fetch 之前做掉，
    //      值以 declaredRange 參數傳進來——ruling F2）
    //   2) 組 <template> 並 armEditables(t.content) —— 唯一可以吃容器的一件事
    //   3) 移除 replaceSpan 節點、insertBefore 插入
    //   4) 重寫被保留後綴節點的 data-block-id
    //   5) rebuildBlockSelection(declaredRange) → __md2docInitDiagrams(contentEl)
    //      → __md2docRebindReader() → applySelectionClasses()
    //
    // Step 5's internal order matches applyFullRender()'s, deliberately:
    // rebuildBlockSelection() sits BEFORE the two `try`-swallowed rebind
    // blocks so a diagram-init throw can never skip it (applyFullRender()'s
    // own comment says exactly that). The brief's snippet listed the rebinds
    // first; its prose says to preserve the existing relative order, and the
    // prose is what is right — a selection silently lost on the render that
    // introduced the document's first mermaid fence is the failure it names.
    //
    // The snapshot is taken BEFORE any mutation: every index below
    // (`oldStart`..`oldEnd`, and the `oldEnd + 1` reference node) is an index
    // into the PRE-patch child list, which is what patchmap computed against.
    // contentEl's element children are the `.ed-block` parts, 1:1 and in
    // document order: lib/md2doc.js emits each part as a single
    // `<div class="ed-block" …>…</div>` (the only two emit sites) and the
    // client only ever assigns `parts.join('\n')` into contentEl. The chrome
    // is never a direct child — the ⠿ handle, the ＋ button, the gutter menu
    // and the insert menu all go on a BLOCK, and the source-mode textarea is
    // inserted as contentEl's SIBLING.
    //
    // Fix round 2: that is NOT unconditionally true between renders — four
    // list gestures mutate this child list directly. domMatchesLastRender()
    // (see its comment, above applyRenderResult) is what establishes the
    // property before we are called; it is a PRECONDITION of everything
    // below, not something this function re-derives.
    const children = Array.prototype.slice.call(contentEl.children);
    // v3.2.1: 「被改寫區塊內的游標」焦點修復。動機來自 undo/redo 的量測——
    // undo/redo 並非普遍掉焦點：游標在被改寫區間【之外】時 activeElement /
    // 所屬 block / caret offset 全部存活（連一次讓自己 data-block-id 8→7 的
    // 結構性 undo 都扛得住）；只有游標落在被改寫區塊【內】才掉到 BODY，之後
    // 打字被靜默丟棄。所以判準是位置，不是操作種類，也完全不需要 op→block
    // 映射（實測 op.startLine 在 14 個實例中只有 4 個正確，對 move / insert
    // 都指向沒有擁有者的空行——該設計已退掉）。
    //
    // ⚠ 觸發面不是「只有 undo/redo」：任何一次 patch 只要聚焦的 block 落在
    // replaceSpan 內就會走到，fix round 1 的 review 點名了兩類非 undo 的呼叫者——
    //   * 一般的 burst 提交：endBurstWithoutResolve() 不 blur，焦點還留在那個
    //     即將被換掉的面上；
    //   * 帶 declaredRange 的批次結構操作：焦點坐在 `.ed-block` 外框上（roving
    //     tabindex）。
    // 這兩類上還原完之後常常會被下面 applySelectionClasses() 自己的
    // `focusEl.focus()` 立刻覆蓋掉（它把焦點搬回選取的 focus block），也就是多
    // 一趟 focus 往返而已；journey 案例 3 / 4 / 6 走的正是這些路徑，皆綠。
    //
    // 必須在 DOM 手術之前算：removeChild 之後 activeElement 已經是 BODY，
    // 而 `children` 是 patch 前的快照，也是 plan 的索引所指的那份清單。
    const focusedBlockEl = document.activeElement &&
      document.activeElement.closest ? document.activeElement.closest('.ed-block') : null;
    const ci = focusedBlockEl ? children.indexOf(focusedBlockEl) : -1;
    const focusWasInSpan = ci >= 0 &&
      ci >= plan.replaceSpan.oldStart && ci <= plan.replaceSpan.oldEnd;
    // Fix round 1 (review Important 1): `blocks`/`lastParts` are the JOIN KEY
    // between the module's model and the DOM, and they are overwritten BEFORE
    // the DOM is touched — armEditables() reads the new `blocks` (see its call
    // below), so the order is forced. That opens a window in which a throw
    // would leave the model describing a DOM that was never built: the
    // exception bubbles to safeRerenderAll()'s catch, the user is told "Your
    // edit was not applied", `false` comes back — and the NEXT commit then
    // diffs parts describing blocks that do not exist, so every index is
    // wrong and nothing reports it. Same silent-failure shape as ruling F4.
    //
    // applyFullRender() has no such window: its `blocks`/`lastParts` →
    // innerHTML → armEditables() order means the same throw leaves a
    // consistent "DOM swapped, just not armed" state that the next render
    // heals. So the patch path buys the equivalent guarantee explicitly:
    // capture, and put the whole mutation window in a try that rolls the two
    // back and lets the FALLBACK land the commit instead of losing it.
    const prevBlocks = blocks;
    const prevLastParts = lastParts;
    blocks = j.blocks;
    lastParts = j.parts;

    try {
      // <template> 是刻意指名的，不是「隨便一種容器」：
      //   createDocumentFragment() + innerHTML  -> innerHTML 不存在，什麼都插不進去、不報錯
      //   Range.createContextualFragment()      -> 文件裡作者手寫的 raw <script> 每次 patch 重新執行
      // 暫存 <div> 也正確，只多一圈 child drain。
      const tpl = document.createElement('template');
      tpl.innerHTML = plan.replaceSpan.newParts.join('\n');
      // 必須在 blocks 已換成新陣列之後——armEditables 的 li 分支走
      // canWysiwygForLi → blockOwnsNoLine，那支讀的是模組層的 `blocks`；
      // 用舊陣列判斷會把一個「不擁有任何來源行」的 li 誤武裝成 contenteditable。
      //
      // ⚠ 只對新片段呼叫，永遠不要對被保留的前綴／後綴節點再跑一次：
      // armEditables 不是 idempotent（⠿ handle 與 ＋ button 是無條件
      // appendChild），double-arm 實測會變成 10 個 handle 而不是 5 個。
      armEditables(tpl.content);

      // 保留節點永不 detach：只移除中段，其餘原地不動。
      // 不得用 replaceChildren() 或 remove-and-re-append 重建整份子節點列表——
      // 實測 detach 再插回同一位置會讓 document.activeElement 掉回 BODY。
      //
      // Fix round 1 (review, comment-only): this removes ELEMENTS, so the `\n`
      // TEXT nodes `parts.join('\n')` left between the removed blocks stay
      // behind. Harmless today — `contentEl.children` and allBlockEls()'s
      // querySelectorAll both skip text nodes, and nothing in this file reads
      // `contentEl.childNodes` — but it does mean `.content`'s child-NODE shape
      // after a patch differs from its shape after a full render, which would
      // matter to any future test that asserts on childNodes rather than
      // children.
      for (let i = plan.replaceSpan.oldStart; i <= plan.replaceSpan.oldEnd; i++) {
        if (children[i]) contentEl.removeChild(children[i]);
      }
      // 參考節點是「第一個被保留的後綴節點」。它在 children 快照裡的 index 是
      // oldEnd + 1，而且因為後綴從未被 detach，那個 object 現在仍在 DOM 裡。
      // 後綴為空時是 null，insertBefore(frag, null) 等同 append。
      const refNode = children[plan.replaceSpan.oldEnd + 1] || null;
      contentEl.insertBefore(tpl.content, refNode);   // fragment 會被排空並保序

      // 被保留的後綴節點的 data-block-id 已經過期（id 是位置序號）。
      // 前綴恆為 0：id 即索引，前綴在兩份陣列裡都佔 0..k-1。
      if (plan.idDelta !== 0) {
        const all = contentEl.children;
        for (let i = all.length - plan.keepSuffix; i < all.length; i++) {
          const el = all[i];
          const oldId = Number(el.getAttribute('data-block-id'));
          el.setAttribute('data-block-id', String(oldId + plan.idDelta));
        }
      }
    } catch (e) {
      // Roll the model back to what the (still-unmutated, or only partly
      // mutated) DOM last agreed with, then land the commit through the
      // fallback rather than losing it — applyFullRender() rebuilds .content
      // wholesale, so it is correct from a half-patched DOM too.
      //
      // ⚠ `window.scrollY` here does NOT violate ruling F3. F3 forbids
      // re-applying rerenderAll()'s STALE pre-fetch snapshot on the patch
      // path, because the patch path never collapses the scroll extent. This
      // is the CURRENT scroll position, read at this instant, handed to an
      // innerHTML swap that genuinely does collapse it. Different value,
      // different reason. Do not "correct" it to the `scrollY` parameter —
      // applyPatch() deliberately does not take one.
      blocks = prevBlocks;
      lastParts = prevLastParts;
      return applyFullRender(j, window.scrollY, declaredRange);
    }

    if (focusWasInSpan) {
      // 落在被置換區間內的游標，其節點已經被移除。把焦點放到對應的新節點
      // （夾在新中段的範圍內），caret 置尾。
      //
      // 位置刻意在 teardown 之前，而真正的機制是 fix round 1 的 review 查出來
      // 的這一條（第一版註解寫的「靠收尾那段焦點檢查認養」是錯的，那段在這條
      // 路徑上是死碼）：`surface.focus()` 會【同步】觸發 document 層那個委派的
      // focusin。undo() 早已 await 完 switchAwayFrom()，所以 `switching` 與
      // `currentBurst` 都是 null——focusin 的兩個 early-return 都不成立——而新
      // 節點在 insertBefore 之前就被 armEditables(tpl.content) 武裝過了，於是
      // startBurst() 當場就跑完。打字有人追蹤、Ctrl+S 才寫得進檔案（實測拿掉
      // 這一塊時 undo 之後打的字連磁碟都到不了）。收尾最後那段
      // `if (!currentBurst && …)` 的焦點檢查因此在這條路徑上恆為 false。
      //
      // 代價要說清楚：下面的 `burstSurvived` 是在這裡【之後】才求值的，所以在
      // 走到這一塊的 render 上，它量到的是「剛剛由還原開出來的那個 burst」，
      // 而不是它註解所寫的「patch 前就開著、而且面活過 patch」。受影響的是三個
      // 以它為閘門的收尾項：currentBurst 的 dispose、resetSelToolbarState()、
      // resetToolbarBlock()——三者都會改走 survived 分支。結果是好的（剛開的
      // burst 不被丟掉、startBurst() 剛掛上的 selectionchange listener 不被拆、
      // toolbarBlockEl 保住 focusin 剛設好的活節點），但那是巧合而不是設計，
      // 所以在 `burstSurvived` 那裡也留了一行對照註解。不搬 `burstSurvived`
      // 到還原之前，是刻意的取捨：搬了會讓剛開的 burst 先被 dispose 再由收尾
      // 重開一次，並把每次 undo 的工具列 degrade 原封不動地留著。
      // teardown 各項彼此的相對順序沒有被動到，條件式的 activeEditor 歸零
      // 仍然在 DOM 手術之後求值。
      const newLen = plan.replaceSpan.newParts.length;
      if (newLen > 0) {
        // landing 恆落在新中段內：ci >= oldStart 保證非負，min() 夾住上界，
        // 而 patch 後的子節點是 prefix(keepPrefix) + 新中段(newLen) + suffix。
        // 零寬區間（insert，oldEnd === oldStart - 1）根本進不了 focusWasInSpan。
        const landing = plan.keepPrefix + Math.min(ci - plan.replaceSpan.oldStart, newLen - 1);
        const el = contentEl.children[landing];
        const surface = el ? blockContentEl(el) : null;
        if (surface) {
          surface.focus();
          try {
            const r = document.createRange();
            r.selectNodeContents(surface);
            r.collapse(false);
            const s = window.getSelection();
            s.removeAllRanges(); s.addRange(r);
          } catch (e) { /* best-effort，同 focusBlockAtLine 的處置 */ }
        }
      }
    }

    // ── teardown ────────────────────────────────────────────────────────
    // Controller ruling F1: the patch path runs the SAME teardown items
    // applyFullRender() runs, unconditionally and in the same relative order.
    // The rationale comments below are copied from applyFullRender() because
    // they document WHY each one exists; the one thing that differs is the
    // trigger — there the nodes were detached by the innerHTML replacement,
    // here they were detached by the removeChild loop above (or, for state
    // that points at a node in the KEPT span, they were not detached at all,
    // which is exactly why leaving the state standing is not automatically
    // safe either: `blocks` and every data-block-id under it just changed).
    //
    // Fix round 1 (review, comment-only) — the consequence a future change to
    // this list has to know about: the fallback's innerHTML replacement also
    // WIPES any uncommitted burst text, which is what keeps the DOM and
    // `lines[]` consistent when item 3 disposes the burst. The patch path
    // leaves that text sitting in a kept node while `currentBurst` has already
    // been disposed. Unreachable today — every call site goes through
    // switchAwayFrom() first, which is what applyFullRender()'s own comment
    // calls "technically unreachable" — but that is precisely what this
    // belt-and-braces teardown is insurance against, and on THIS path a future
    // call site that forgets switchAwayFrom() leaves text visible in the DOM,
    // absent from `lines[]`, with its undo history already disposed.
    //
    // Whatever editor (if any) was open a moment ago may have just been
    // detached by the span removal above — its own restore()/commit() never
    // ran, so it never got a chance to null this out itself. On the FALLBACK
    // path this is done unconditionally, which is what makes the undo/redo
    // lockout regression (see the `activeEditor` comment above) structurally
    // impossible even from a call site that forgets to call switchAwayFrom().
    //
    // ── Final review item 1 / 決議 3(1) 的 activeEditor 對稱項 ───────────
    // 決議 3(1) 的論證逐字適用在這裡，而它原本沒有被問過：fallback 之所以
    // 可以無條件歸零，是因為 `contentEl.innerHTML = ` 把每個節點都拔掉了
    // ——面也一起從螢幕上消失。patch 保留節點，而 openRawEditor() 的
    // `.ed-raw` 包裝是塞進**區塊自己**（`blockEl.innerHTML = '';
    // blockEl.appendChild(wrap)`），所以 contentEl 的子節點數與每一個
    // data-block-id 都沒有變、domMatchesLastRender() 照過、patch 照跑——
    // 落在前綴／後綴裡的 textarea 於是活過 patch，而這一行把它變成沒人
    // 追蹤的殭屍：switchAwayFrom() 再也看不到它，點開別處不會自動提交，
    // 而下一次任何 rerenderAll() 會把它連同未提交的文字一起蓋掉。
    //
    // 實測可達（scratchpad/item1-scenarioB.js，兩次 run 一致）。序列是
    // 「render 往返途中開一個 raw editor」，與決議 3(2) 為 currentBurst 記下
    // 的那條 race 同形，只是觸發點必須是**在 fetch 之前就 settle 掉
    // switchAwayFrom() 的**站點（undo()/redo()/changeHeadingDepth()…），
    // 因為 resolveBurst() 自己那條路徑把整個 render 關在 `switching` 的
    // single-flight 裡，反而把並行的點擊序列化掉：
    //   openRawEditor-entry   {blockId:'2', currentBurst:false, activeEditor:false}
    //   dispatch              {patch:true, keepPrefix:4, oldStart:4, oldEnd:4,
    //                          activeEditor:true, rawTextareas:1}
    //   patch-teardown        {activeEditor:true, activeEditorBlockAttached:true,
    //                          activeEditorBlockId:'2', rawTextareas:1}
    // 接著在存活的 textarea 裡打字、點到別的區塊、Ctrl+S：
    //   [after clicking away] {rawTextareas:1, rawValue:'…const LOST = 2;'}
    //   [file on disk]        '# Doc\n\nCode anchor.\n\n```js\nconst x = 1;\n```\n…'
    //   [LOST typing present in file?] NO — data loss
    // 螢幕上看得到，檔案裡沒有——與決議 3(1) 為 burst 記下的完全同一種缺陷。
    //
    // 判準與 burst 那項同形，而且必須同形：實測
    // `document.body.contains(activeEditor.blockEl)`，不得由 patchmap 的
    // index 算術推論。推論錯的代價是 activeEditor 指著已 detach 的節點，
    // 正好是上面那段「undo/redo lockout」在防的事——所以節點沒活下來時
    // 一律走原本的無條件歸零，lockout 仍然結構上不可能。
    //
    // 多一道 burst 不需要的閘門：burst 的 `blockId` 是唯一會 stale 的欄位，
    // 其餘都從新的 `blocks` 現查；openRawEditor() 的 session 則把
    // `blockId`/`startLine`/`endLine` 三個都閉包成常數，所以留下來之前要先
    // 讓它把三者從現在的 DOM 屬性與新的 `blocks` 重新推導成功
    // （reanchor()，見那裡的註解——推導不出來就退回歸零）。
    if (!(activeEditor && activeEditor.blockEl
        && document.body.contains(activeEditor.blockEl)
        && activeEditor.reanchor())) {
      activeEditor = null;
    }
    // §10-gap fix (review): same belt-and-braces reasoning for
    // `pristineInsert` — its window is meant to close via one of the
    // explicit resolution hooks (resolveBurst()/revertBurstAndEnd()/
    // revertTableBurstAndEnd()/cancelAndMaybeDiscard()) BEFORE any
    // rerenderAll() reaches here.
    //
    // Final review item 1, second half — 這一項**刻意沒有**跟著上面開例外，
    // 而且理由不是「到不了」：同一條 race 一樣到得了這裡。是這個狀態被
    // 這次 render 本身作廢了。`pristineInsert` 的整個意思是「undo stack 的
    // **最頂端**那一筆就是我這個插入 op」——discardPristineInsert() 走
    // `stack.discardTop()`（lib/editor/lineops.js），它無條件 pop 最頂端那筆
    // 並就地反轉，不驗證那筆是不是自己的。而任何走到 applyPatch 的 render
    // 都帶著一個 truthy 的 editRange，也就是**剛剛有一筆 op 被推上 stack**
    // （commitRangeEdit / commitBlockInsertion / undo()/redo() 的搬動）。所以
    // patch 之後把 `pristineInsert` 留著，等於讓之後任何一次「放棄這個空
    // 區塊」去 pop 並反轉**別人的**那一筆——那是比它要防的孤兒佔位區塊更
    // 嚴重的失敗。要讓這一項變成可以開例外，得先讓 discardTop() 認得 op
    // 的 identity（例如 discardPristineInsert() 記下 op 物件本身、pop 前先
    // 比對），在那之前無條件歸零就是正解。
    pristineInsert = null;
    // ── Task G / 決議 3：teardown 的三項例外 ─────────────────────────
    // 判準必須是「burst 的編輯面在 patch 之後仍然連在文件上」的**節點
    // identity 實測**，不得由 index 算術推論。推論錯的代價是 burst 指著已
    // detach 的節點——正是上面 activeEditor / toolbarBlockEl 那兩段註解在防的
    // 事，而且跳過 dispose() 時若節點其實已被換掉，會同時留下一疊
    // innerHTML 快照與一個閉包住 detached 節點的 captureFn。
    //
    // 為什麼只在 patch 路徑需要這個例外：fallback 的 `contentEl.innerHTML = `
    // 把每一個節點都拔掉，所以 12 項 teardown 把任何編輯面孤兒化都是安全的
    // （螢幕上也一併消失）。patch 保留前綴與後綴節點，所以同一套 teardown
    // 會把一個螢幕上還在、焦點還在的面變成沒人追蹤的殭屍。
    //
    // 三項例外各自留在原位 gate，不抄成一個 if 區塊：ruling F1 要求這 12 項
    // 的**相對順序**與 applyFullRender() 一致，把 resetSelToolbarState() /
    // resetToolbarBlock() 搬到第 3 項旁邊才是真的改了順序。條件只算一次，
    // 而且算在會動到 currentBurst 的那一項之前（算完才輪得到把它歸零）。
    // ⚠ v3.2.1 fix round 1：這個節點 identity 判準本身沒變，但它求值的時機
    // 現在落在上面那塊焦點還原【之後】。還原的 `surface.focus()` 在
    // switchAwayFrom() 已經結算完的路徑上（undo()/redo()）會【同步】開出一個新
    // 的 burst（見那裡的註解），所以在那種 render 上這裡量到的 true 說的是
    // 「現在有一個 burst，而且它的面在文件上」，不是「patch 前那個 burst 活下
    // 來了」。下面三個以它為閘門的項因此會走 survived 分支。實測（undo 走
    // patch 路徑）：收尾後工具列 disabled 停在 7/22，不是 resetToolbarBlock()
    // 跑過該有的 18/22 —— 也就是 resetToolbarBlock() 確實被跳過了，這是
    // burstSurvived 為 true 的直接證據。反過來，若還原當下 currentBurst 還沒被
    // 歸零（別條路徑），focusin 的 `if (currentBurst) return;` 會擋掉開 burst，
    // 這裡照舊量到「舊 burst 的面被拔掉了」＝false，收尾最後那段焦點檢查才是
    // 接手的人。兩種情形都不需要這一項改判準。
    const burstSurvived = !!(currentBurst && currentBurst.editEl
      && document.body.contains(currentBurst.editEl));
    // Task 2 (Phase 3): same belt-and-braces reasoning for the always-on
    // WYSIWYG burst — nulling here, not in resolveBurst(), is what keeps this
    // a single source of truth, mirroring activeEditor just above.
    // Task G: skipped when the burst's surface survived the patch — nulling it
    // there is what strands a live, focused, still-typeable surface with
    // nothing tracking it (the `input`/`focusout` handlers are both predicated
    // on `currentBurst.editEl === editEl`, and `focusin` only fires on
    // ENTERING, so focus that never left never reopens one).
    if (!burstSurvived && currentBurst) { currentBurst.history.dispose(); currentBurst = null; }
    // Task 5: the hover-edge insert bubbles and the row/column grip handles
    // are positioned against a specific table's geometry; a stale bubble left
    // visible (pointing at now-detached or re-rendered geometry) would
    // misbehave on the next click. hideTableGrips() clears their tracked
    // table/row/column references too.
    hideTableInsertBubbles();
    hideTableGrips();
    // Task 4 fix (review finding): the SAME reasoning applies to the
    // selection toolbar and its document-level selectionchange listener.
    // Every call site today resolves the session via switchAwayFrom() first
    // (making this technically unreachable), but that safety depends on every
    // FUTURE call site remembering to — exactly how the Task 3 listener-leak
    // regression happened. resetSelToolbarState() is idempotent.
    // Task G: travels with the `currentBurst` exception above, and must. The
    // `selectionchange` listener it removes is attached by startBurst() /
    // startTableBurst() and by NOTHING else, so on a surviving burst whose
    // focus never leaves there is no later focusin to re-attach it — measured,
    // the floating selection toolbar and the fixed bar's five inline-format
    // buttons (which piggyback on that same listener, and which this version's
    // `hasSelection` wiring also rides) stay dead until the user clicks away
    // and back.
    if (!burstSurvived) resetSelToolbarState();
    // Task 6: same belt-and-braces reasoning again for the edge-click menu
    // and any in-flight row drag.
    hideTableEdgeMenu();
    cancelTeDrag();
    // S4 Task 2: same belt-and-braces reasoning for an in-flight ⠿ block drag —
    // the gesture's ordinal refers to a block index that this patch may have
    // just renumbered. Nothing was mutated by the drag, so there is nothing to
    // revert; the state simply must not survive the render.
    cancelBlockDrag();
    // Final-review Finding 5b (Important): the ⠿ gutter menu — toggleGutterMenu()
    // appends the ONE shared `gutterMenu` node as a CHILD of whichever block
    // it's open for, so a removed block took it away without its own close
    // path ever running. Left uncleared, `gutterMenuBlockEl` keeps pointing at
    // a detached node and the NEXT toggleGutterMenu() call on that same stale
    // reference would treat the menu as already open instead of opening fresh.
    // closeGutterMenu() is idempotent.
    closeGutterMenu();
    // §10-gap fix: same belt-and-braces reasoning for the ＋ insert menu —
    // it's the same "singleton node appended as a child of whichever block
    // it's open for" idiom as gutterMenu just above.
    closeInsertMenu();
    // v3.1.0 §4: and the SAME belt-and-braces reasoning one more time for the
    // toolbar's tracked block. `toolbarBlockEl` points INTO the subtree that
    // was just patched, and a detached node's getAttribute() still answers
    // perfectly happily: left standing, the bar would keep reporting the old
    // block's type/indent/heading depth and every button would act on a node
    // no click can ever reach again.
    // Task G: same exception, same reason — `toolbarBlockEl` is only ever
    // re-set on focusin / the click delegation, so clearing it under a burst
    // whose focus never leaves kills every block-dependent toolbar button until
    // the user clicks away and back (MEASURED on the smoke fixture: disabled
    // goes 7/22 -> 18/22, and nothing calls updateToolbar() again until the
    // next click). It has TWO further side effects (v3.2.1: the third was
    // preview mode's contenteditable re-arm, removed with the mode itself),
    // and both ride along safely: (1) updateToolbar() is re-derived from the
    // DOM on the next interaction; (2) closeToolbarMenu() — skipping it leaves
    // the H▾ dropdown standing across a patch, which is benign because
    // `toolbarMenuEl` is appended to document.body, not into a block, so the
    // patch never detaches it, and applyHeadingLevel() re-resolves through
    // liveToolbarBlock(), which self-heals a detached `toolbarBlockEl`.
    if (!burstSurvived) resetToolbarBlock();

    // Task G step 2: re-derive the surviving burst's `blockId` FROM THE DOM
    // ATTRIBUTE — never assign it independently.
    //
    // startBurst()/startTableBurst() derive `blockId` from
    // `blockEl.getAttribute('data-block-id')`, so on a kept node it is the
    // FIELD that goes stale, not the attribute: the id rewrite inside the try
    // above already renumbered every kept suffix node. bystanderCarryOver()
    // compares `String(currentBurst.blockId)` against a node's getAttribute()
    // result AS STRINGS; if the field and the attribute disagree in either
    // direction a dirty burst stops being excluded from the replay and the
    // replay overwrites the user's uncommitted typing. Hence the fixed order:
    // the patch rewrites the attribute first, this re-derives the field from
    // it. `blockEl` is `editEl.closest('.ed-block')` captured at burst-start
    // and, because `burstSurvived` measured `editEl` as still attached, it is
    // the same still-attached element.
    if (burstSurvived) {
      currentBurst.blockId = Number(currentBurst.blockEl.getAttribute('data-block-id'));
    }

    // S3 Task 5 (§4.4's ordered three steps): armEditables() above was step 1;
    // this is steps 2 and 3 — rebuild the member set from the declared (or
    // still-standing) LINE RANGE against the freshly built `blocks`. It sits
    // AFTER the unconditional teardown above so nothing there can null what it
    // just set, and BEFORE the two `try`-swallowed rebind blocks below so a
    // diagram-init throw can never skip it.
    //
    // Fix round 1 (review, ruling F3 amendment): there are TWO scroll sources
    // applyFullRender()'s `window.scrollTo(0, scrollY)` compensates, and only
    // one of them is absent here. The one F3 correctly ruled out is the
    // innerHTML swap collapsing the scroll extent — that cannot happen on this
    // path, and re-applying the stale pre-fetch snapshot would fight the
    // browser. The other is rebuildBlockSelection()'s own tail: it ends in
    // `focusEl.focus()`, which scrolls the focus holder into view (the comment
    // above applyFullRender()'s scrollTo says exactly this). That source is
    // very much still live here, so a keyboard-driven patched commit taken
    // while the block selection is scrolled off-screen would jump the viewport
    // where the fallback would not.
    //
    // Compensated precisely: read the CURRENT scroll position immediately
    // before, restore it immediately after, and only if the call actually
    // moved it. Never the pre-fetch `scrollY` — applyPatch() deliberately does
    // not take one.
    const scrollBeforeSelection = window.scrollY;
    rebuildBlockSelection(declaredRange);
    if (window.scrollY !== scrollBeforeSelection) {
      window.scrollTo(0, scrollBeforeSelection);
    }
    // 這三個都是 document-scoped，必須在插入之後、對整份文件跑：
    // __md2docInitDiagrams 的 WaveDrom 分支自述「has no per-root scoping API
    // — ProcessAll() always scans the whole document」，實測對 detached
    // fragment 呼叫時 mermaid 畫得出來但 WaveDrom 完全沒動。
    if (window.__md2docInitDiagrams) {
      try {
        window.__md2docInitDiagrams(contentEl);
      } catch (e) {
        // Same Phase-1 known limitation as the fallback path: a newly
        // introduced diagram type whose library global was never loaded stays
        // unrendered until reload. Never let that break the rest of the editor.
      }
    }
    if (window.__md2docRebindReader) {
      try {
        window.__md2docRebindReader();
      } catch (e) {
        // Never let a reader-runtime rebind failure break block selection/save/undo.
      }
    }
    // Fix round 1 (review, comment-only): whenever rebuildBlockSelection()
    // above does NOT take its early-return path it has already called
    // applySelectionClasses() once, via setBlockSelection()/
    // clearBlockSelection() — so on those renders this is a redundant SECOND
    // pass, costing one extra blur/focus round trip. It is kept unconditional
    // anyway, because the case where it is genuinely load-bearing is exactly
    // the case where rebuildBlockSelection() early-returns: a plain typing
    // commit with no selection anywhere, where nothing else would clear the
    // KEPT nodes' stale `.ed-selected`/tabindex.
    //
    // applySelectionClasses() 必須跑：它是 total 的（先把 `.ed-selected` 與
    // tabindex 從每一個區塊清掉再重套）。innerHTML 置換時代那份「保留節點的
    // 殘留 class 自動消失」的免費午餐在 patch 路徑沒有了。
    applySelectionClasses();

    // ── Task G step 3 / 決議 3(1)：patch 收尾的焦點檢查 ────────────────
    // endBurstWithoutResolve() 有 11 個呼叫點，全部在 render 之前，而
    // ⠿／＋／工具列的 mousedown 都無條件 preventDefault()——刻意的，好讓
    // 焦點留在 armed 面上（既有 runtime 測試斷言「⠿ 的 mousedown 不得 blur
    // 還開著的 dirty burst」）。今天安全只因為 innerHTML 置換把那個節點
    // 拔掉；patch 保留節點，就把「焦點還在、currentBurst 為 null」從邊角
    // 變成日常。那個狀態下：打字不被追蹤（input listener 以
    // currentBurst.editEl 為前提）、移開焦點什麼都不提交（focusout 同理）
    // ——螢幕上看得到，檔案裡沒有。
    //
    // 位置是刻意的：在 teardown 之後（這時 currentBurst 才真的歸零了），
    // 也在 rebuildBlockSelection() / applySelectionClasses() 之後——那兩支的
    // focusEl.focus() 可能把焦點搬到一個 `.ed-block` 上（那是真的移走了，
    // 不該重開 burst）。先開再讓它搬走只會多觸發一輪 focusout →
    // resolveBurst()。又因為 resetSelToolbarState() 已經跑完（!burstSurvived
    // 才會走到這裡），startBurst() 重新掛上的 selectionchange listener 不會被
    // 回頭拆掉。
    //
    // ⚠ 這一步會改動 switchAwayFrom() 的後置條件。resolveOpenSession() 解掉
    // currentBurst、await 完 render 之後就直接 return true，不再重檢；而工具列
    // 與 ⠿／＋ 的 mousedown 都 preventDefault()，焦點會留在原面上。所以這裡可能
    // 在那個被 await 的 render 裡重開一個 burst，讓 switchAwayFrom() 帶著一個
    // 開著的 session 回傳 true——它自己的 doc comment 說它是「單一、完整的
    // make it safe to proceed 閘門」。這是刻意的取捨：那個面上的鍵入沒人追蹤才是
    // 資料遺失，而重開的 burst 是乾淨的（original 就是當下的 innerHTML），
    // 下一次 focusout 會把它零編輯解掉。已知的一個後果是本輪修掉的那個：
    // openRawEditor() 原本只擋 activeEditor，於是它註冊 activeEditor 之後的
    // ta.focus() 會把這個 bystander burst 的 focusout 變成一次 switchAwayFrom()，
    // 連帶把剛開的 raw editor 一起收掉——見那裡的 Task G fix round 1 註解。
    // 任何新的「開一個 session 然後自己搬焦點」的路徑都要先解掉 burst。
    //
    // startBurst() 吃 editEl（`.ed-wys-armed` 本人）、startTableBurst() 吃 cellEl
    // （`.ed-wys-cell` 本人，它自己 closest('table')）——兩者都正好是
    // activeElement，所以直接傳。兩者都不呼叫 focus()，不搞 scrollIntoView，
    // 所以這裡**不需要** rebuildBlockSelection() 那種 scroll 補償。
    const ae = document.activeElement;
    if (!currentBurst && ae && contentEl.contains(ae)) {
      if (ae.classList.contains('ed-wys-cell')) startTableBurst(ae);
      else if (ae.classList.contains('ed-wys-armed')) startBurst(ae);
    }
    // Same tail as applyFullRender(): the dirty dot and the `true` that tells
    // every safeRerenderAll() caller the commit landed. Omitting either is the
    // exact silent-failure shape ruling F4 warns about — safeRerenderAll()'s
    // try/catch would swallow a throw and the DOM would still look right.
    setDirty();
    return true;
  }

  async function applyFullRender(j, scrollY, declaredRange) {
    blocks = j.blocks;
    lastParts = j.parts;                       // v3.2.0: 供下一次 patch 當 oldParts
    // v3.2.1 R2: 必須先於 innerHTML 寫入。這個寫入 detach 掉聚焦的 raw
    // textarea，同步 focusout 重入 switchAwayFrom() → resolveOpenSession() →
    // commitNow()，於是同一次編輯提交兩次（實測衍生新 block 時磁碟上文字出現
    // 兩次；停在同一個 block 內則第二次回 op === null 退化成取消，所以看不出來）。
    // Whatever editor (if any) was open a moment ago just got detached by
    // the innerHTML replacement below — its own restore()/commit() never
    // ran, so it never got a chance to null this out itself. Do it here,
    // unconditionally, on every successful swap: this is what makes the
    // undo/redo lockout regression (see the `activeEditor` comment above)
    // structurally impossible even from a call site that forgets to call
    // switchAwayFrom() first.
    activeEditor = null;
    contentEl.innerHTML = j.parts.join('\n');  // fallback 路徑用 join 還原
    // Task 2 (Phase 3): re-arm every WYSIWYG-eligible paragraph/heading (and
    // attach a ⠿ handle to every non-table block) in the freshly-swapped
    // DOM — see armEditables() below. Must run before anything else touches
    // the fresh nodes (diagram re-init, reader rebind, focus restoration).
    armEditables(contentEl);
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
    // S4 Task 2: same belt-and-braces reasoning for an in-flight ⠿ block drag —
    // the innerHTML replacement above just detached every block the gesture's
    // ordinal refers to. Nothing was mutated by the drag, so there is nothing
    // to revert; the state simply must not survive the render.
    cancelBlockDrag();
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
    // v3.1.0 §4: and the SAME belt-and-braces reasoning one more time for the
    // toolbar's tracked block. The toolbar node itself is mounted on
    // document.body (see mountToolbar() below) precisely so the innerHTML
    // replacement above cannot destroy it — but `toolbarBlockEl` points INTO
    // the subtree that was just swapped, and a detached node's
    // getAttribute() still answers perfectly happily: left standing, the bar
    // would keep reporting the old block's type/indent/heading depth and
    // every button would act on a node no click can ever reach again. Zeroing
    // it re-derives the model's documented no-block state (undo/redo/outline/
    // preview stay live, everything else greys out) — the same contract
    // closeGutterMenu()/closeInsertMenu() above have, and idempotent for the
    // same reason.
    resetToolbarBlock();
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
  //
  // Task E: `editRange` passes straight through to rerenderAll(). Callers
  // with a real committed op compute it there and pass it; the 3 no-op call
  // sites (restore()'s rangeMode exit, the per-li unsupported-format
  // refusal, and commitListStructure()'s no-range exit) pass nothing, which
  // falls back to a full re-render by contract — patch can only compare
  // renderer output, never DOM the user has already touched.
  async function safeRerenderAll(editRange) {
    try {
      return await rerenderAll(editRange);
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

  // F9 —— raw 原始碼編輯器開啟時的 textarea 種子與 caret 落點。
  //
  // openRawEditor() 以前收尾一律是
  // `ta.setSelectionRange(ta.value.length, ta.value.length)`，每一種區塊都落
  // 在值的結尾。對 fenced code 那個位置在【收尾 fence 之後】。MEASURED
  // （test/editor-journey.test.js 的 F9 那一列，fixture
  // '# Doc\n\nAlpha.\n\n```js\nconst a = 1;\n```\n\nBravo.\n'，用真的滑鼠
  // 按壓點進 code block）：修之前 selectionStart = selectionEnd = 22，而值是
  // '```js\nconst a = 1;\n```'，長度正是 22 —— caret 就在收尾那串反引號
  // 之後，打一個字進去，收尾那一行變成 '```Z'，圍欄不再閉合。
  //
  // 這支回 `{ value, caret }`：`value` 是要放進 textarea 的字串（通常就是傳
  // 進來的原始碼；只有下面 b／b' 那些形狀會被動到），`caret` 是 offset。
  //
  // 規則不是「caret 永遠不會落在圍欄標記上」—— 那句話是假的，見下面的例外。
  // 規則是：**只要來源裡存在一個不在圍欄標記上的落點，就選它；空圍欄則種一行
  // 本文出來給它落**。
  //
  //  a) 第一行是一道開頭圍欄（fenceOpenerOf()）→ caret 落在下一行行首，那是
  //     第一個位在程式碼本文裡的 offset。
  //  b) 【空的圍欄】（a 的次分類：下一行就是它的【配對】收尾圍欄）→ 本文區一
  //     行都沒有，兩端的候選位置都在圍欄標記上，**原始碼裡沒有安全的 offset**。
  //     所以在開頭與收尾圍欄之間種一行空白進 `value`，caret 落在那一行。
  //  b') 同樣的空圍欄長在一段跨區塊 span 的【尾端】（⠿ 選單的「MD 原始碼」框
  //     得出來，例如 'Alpha.\n\n```js\n```'）→ 同樣種一行。
  //  c) 最後一行是某道圍欄的【配對】收尾、而第一行不是開頭圍欄 → 結尾落點會
  //     落在那道收尾圍欄上，改落在前一行的行尾。
  //  其餘一律維持結尾落點。
  //
  // caret 仍然會落在一行【長得像圍欄】的行上的情形（掃過一批來源形狀量到的 ——
  // 段落／引用／表格／清單項／html／縮排式 code／各種圍欄與跨區塊 span —— 這些
  // 情形都不是破壞）：
  //  - 來源只有一行，而那一行是一道孤零零的開頭圍欄 '```js'（⠿ 對一個只有開
  //    頭圍欄的 code 區塊就會給出這個）。沒有別的行可選；在那裡打字得到
  //    '```jsX'，仍然是一道開頭圍欄（info string 從 js 變成 jsX），區塊的收尾
  //    狀態不變。
  //  - 來源尾端那一行長得像圍欄，但在這段來源裡【不收掉任何圍欄】，例如
  //    'Alpha.\n\n```js\ncode\n~~~'：那道 ```js 沒有被收掉，'~~~' 是它的本文。
  //    在那裡打字只是改本文。
  //  - a 分支落到的那一行【本身長得像圍欄】，因為它是外層圍欄的本文 —— 巢狀
  //    圍欄 '~~~\n```\nx\n```\n~~~' 的 caret 就落在第二行那個 ``` 的行首
  //    （test/editor-journey.test.js 的巢狀圍欄那一列釘的正是這個落點）。在那裡
  //    打字得到 'Z```'，那一行仍然只是外層圍欄的本文，內外圍欄的配對都不變。
  //
  // b 分支不會讓文件變髒：openRawEditor() 的 `hasChanges()` 比對的是這支回
  // 的 `value`（不是檔案裡那段 `source`），所以剛開起來的 textarea 仍然算
  // 「沒有變更」，關掉走的是 restore()／cancelAndMaybeDiscard() 這條不寫檔的
  // 路。`source` 本身留給 reanchor() 用，它比的是檔案的真實位元組。
  //
  // 刻意【沒有】照 task-5 brief 一併把 blockquote／image 改成「第一行行首」。
  // MEASURED（lib/editor/blockmap.js 的 buildBlockMap）：
  //   '> line one\n> line two'    -> blockquote
  //   'X> line one\n> line two'   -> paragraph, blockquote   ← 行首落點
  //   '> line one\n> line twoX'   -> blockquote              ← 結尾落點
  // 對 blockquote 而言「第一行行首」在 '>' 的前面，打第一個字就把那一行踢出
  // 引用區塊，比它要取代的結尾落點更糟。image 打在頭尾都等價（'X![a](b.png)' 與
  // '![a](b.png)X' 都還是 paragraph）。
  //
  // 這支為什麼只動圍欄：圍欄是這些形狀裡唯一【結尾就是一個收尾標記】的。把一
  // 個字打在其他形狀的結尾只是加字 —— MEASURED（buildBlockMap，左為原文、右
  // 為結尾多打一個 X 之後的 type，左右相同就是沒壞）：
  //   '| A | B |\n|---|---|\n| 1 | 2 |'  table      -> table
  //   '    a\n    b'（縮排式 code）       code       -> code
  //   '- alpha'                            li         -> li
  //   '<div>\nhi\n</div>'                 html       -> html
  //   '> a\n> b'                          blockquote -> blockquote
  //   '![a](b.png)'                        paragraph  -> paragraph
  // 圍欄的 type 也一樣是 code -> code，所以【單看一個孤立的區塊看不出差別】；
  // 差別在整份文件上：收尾圍欄被打壞之後就不再收尾，它後面的東西全部併進來。
  // 那是 test/editor-journey.test.js 的 F10 那一列量到的：5 個區塊掉到 3 個，
  // 尾巴進磁碟。
  // 一道圍欄的【開頭】，回 { char, len }；不是開頭圍欄時回 null。
  //
  // fix round 2 (K1/K3): 這裡與 closesFence() 取代了原本那對只認「長得像圍欄」
  // 的 regex。收尾圍欄必須跟開頭圍欄【同一種字元、而且不比它短】，而反引號
  // 圍欄的 info string 不得再含反引號。它們各修各的：K1 那個被種進空白行的缺
  // 陷靠的是【收尾必須配對】那一條 —— 把 info string 那條單獨拿掉再掃一次圍欄形
  // 狀，巢狀那幾種逐字不變（只有名字裡有 backtick-info 的那些形狀會變）。info
  // string 那條自己的壞法在下面。
  //
  // 少了收尾配對那條，'~~~' 開頭、下一行是 '```' 的巢狀圍欄會被誤判成【空圍
  // 欄】，於是 rawEditorSeed() 那個 grown 分支往使用者的檔案裡種進一行空白，而
  // 且提交時真的寫到磁碟（40c9569 沒有這個問題，是 588ae30 引進的）。同一個誤判
  // 的另一面在 endsWithUnclosedFence()：一份以光禿禿 '~~~' 收尾的文件會被當成
  // 「圍欄有收好」，真正的吞噬因此靜默。
  //
  // 少了 info string 那條：'``` a`b' 這一行 marked 當它是【段落】（反引號圍欄的
  // info string 不能含反引號），下一行才是真正的開頭圍欄。把段落那一行當成開頭
  // 圍欄之後，它會跟後面那道真的收尾圍欄配成一對，rawEditorSeed() 於是把 caret
  // 放到【真開頭圍欄】那一行的行首 —— 打一個字就把 '```js' 變成 'Z```js'，開頭
  // 圍欄消失、收尾那道 ``` 反而變成開頭，它後面的東西被吃進去（實測 ablation
  // 之後 blocks 從 heading paragraph code[4,6] paragraph 變成
  // heading paragraph[3,5] code[6,8]）。這條由 test/editor-journey.test.js 的
  // 「a backtick in the info string is not a fence opener」那一列釘住。
  function fenceOpenerOf(line) {
    if (typeof line !== 'string') return null;
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) return null;
    const char = m[1].charAt(0);
    if (char === '`' && m[2].indexOf('`') !== -1) return null;
    return { char: char, len: m[1].length };
  }
  // `line` 能不能收掉 `opener` 開的那道圍欄。
  //
  // fix round 3 (L2): 這支的需求是 **marked 的行為**，不是 CommonMark 的條文，
  // 也不是比較有道理的那個讀法 —— `j.blocks` 就是 marked 的 tokenizer 產出的，
  // 這支只要跟它講的不一樣，判別式就會拿一份跟畫面上不同的文件在推理。
  // marked 的 fences rule 收尾那一段是 `(?: {0,3}\1[~`]* *(?=\n|$)|$)`：最多三個
  // 前導空格、接著跟開頭圍欄【逐字相同】的那一串（同字元同長度，`\1` 是
  // backreference）、再接任意個 ` 或 ~、然後只能是空格。
  //
  // MEASURED（把候選行放進 '```\nx\n<候選>\nAFTER\n'，看 buildBlockMap 有沒有
  // 把 AFTER 留在 code block 外面）—— 上一版跟 marked 在這些行上不一致，而且不
  // 一致的方向不是單向的：
  //   '```' + 一個 tab      marked 說【沒收】，上一版說收了 —— 正是 K3 那個 FN1 形狀
  //   '``` ' + tab、'```' + tab + ' '   同上
  //   '```~~'（混合的尾巴）  marked 說【收了】，上一版說沒收
  // 尾端只認空格（marked 是 ` *`，不是 `[ \t]*`），而開頭那一串之後可以再跟
  // 任意個 ` 或 ~。
  function closesFence(line, opener) {
    if (typeof line !== 'string' || !opener) return false;
    let i = 0;
    while (i < 3 && line.charAt(i) === ' ') i++;
    for (let k = 0; k < opener.len; k++) {
      if (line.charAt(i + k) !== opener.char) return false;
    }
    i += opener.len;
    while (i < line.length && (line.charAt(i) === '`' || line.charAt(i) === '~')) i++;
    while (i < line.length && line.charAt(i) === ' ') i++;
    return i === line.length;
  }
  // 把 rows 掃一遍，回傳每一對【配對成功】的圍欄 { openIdx, closeIdx }。
  // 沒有配到收尾的開頭圍欄不會出現在結果裡。
  function fencePairs(rows) {
    const pairs = [];
    let open = null;
    for (let i = 0; i < rows.length; i++) {
      if (open) {
        if (closesFence(rows[i], open.opener)) { pairs.push({ openIdx: open.idx, closeIdx: i }); open = null; }
        continue;
      }
      const o = fenceOpenerOf(rows[i]);
      if (o) open = { opener: o, idx: i };
    }
    return pairs;
  }
  function rowStartOffset(rows, idx) {
    let n = 0;
    for (let i = 0; i < idx; i++) n += rows[i].length + 1;
    return n;
  }
  function rawEditorSeed(text) {
    const rows = text.split('\n');
    // 只有一行的來源直接落在結尾。那一行是一道孤零零的開頭圍欄時，caret 就在
    // 標記行上 —— 見上面那段註解裡明講的那些例外。
    if (rows.length === 1) return { value: text, caret: text.length };
    const pairs = fencePairs(rows);
    if (fenceOpenerOf(rows[0])) {
      const first = pairs.filter(function (p) { return p.openIdx === 0; })[0];
      if (first && first.closeIdx === 1) {
        const grown = [rows[0], ''].concat(rows.slice(1));
        return { value: grown.join('\n'), caret: rowStartOffset(grown, 1) };
      }
      return { value: text, caret: rowStartOffset(rows, 1) };
    }
    const lastIdx = rows.length - 1;
    const tailPair = pairs.filter(function (p) { return p.closeIdx === lastIdx; })[0];
    if (tailPair) {
      if (tailPair.openIdx === lastIdx - 1) {
        const grown = rows.slice(0, lastIdx).concat(['']).concat(rows.slice(lastIdx));
        return { value: grown.join('\n'), caret: rowStartOffset(grown, lastIdx) };
      }
      return { value: text, caret: rowStartOffset(rows, lastIdx) - 1 };
    }
    return { value: text, caret: text.length };
  }

  // v3.1.0 修正 4: `range` ({startLine, endLine}, 1-indexed inclusive) opens
  // the raw editor over an EXPLICIT span of source lines instead of the
  // block's own record. Two callers need it and one property makes both
  // work: a list item (whose source line carries its marker and leading
  // columns, and which must NOT go through the run re-serializer while a
  // textarea is standing where its .ed-li-text should be) and a multi-block
  // ⠿ selection (whose span is several blocks' lines at once). Both also
  // switch this editor's teardown from an innerHTML rewrite to a real
  // re-render — see restore() below for why that is not optional.
  async function openRawEditor(blockEl, range) {
    if (blockEl.querySelector('.ed-raw')) return; // already editing this block
    // Task G fix round 1 (npm test RED on f63c88a): the guard below used to
    // read `activeEditor` ALONE, so a WYSIWYG burst open on a DIFFERENT block
    // survived into this function — and then `ta.focus()` (a few lines down,
    // after `activeEditor` has already been registered) blurs that surface,
    // whose delegated focusout calls switchAwayFrom(). resolveOpenSession()
    // resolves BOTH kinds of session, so it resolves the burst AND then finds
    // the brand-new, unmodified `activeEditor` and calls cancelNow() on it —
    // which for a pristine insert is cancelAndMaybeDiscard() -> the freshly
    // inserted block is discarded and its textarea never survives the gesture.
    //
    // MEASURED (scratchpad taskG-repro-code.js, replaying
    // test/editor-client-runtime.test.js's Section 10「abandoned inserts
    // (all 5 kinds)」): + -> 程式碼 with stale focus left on an untouched
    // bystander paragraph produced
    //   openRawEditor {currentBurst:true, activeEditor:false}
    //   resolveOpenSession {currentBurst:true, activeEditor:true, pristineInsert:6}
    //   cancelAndMaybeDiscard {blockId:6, pristineInsert:6}
    // and zero code blocks left in the DOM. Only 程式碼 is affected because it
    // is the one insert kind that registers an `activeEditor` before moving
    // focus; the other four just focus another armed surface.
    //
    // The burst arm was previously unreachable — every caller resolved the
    // session first — which is why the guard only ever named `activeEditor`.
    // applyPatch()'s step-3 focus check makes it reachable: it adopts focus
    // that a preventDefault()-ing gesture left standing on a bystander, so a
    // burst can now be open on a block nobody is interacting with. Resolving
    // it HERE (before `activeEditor` is registered, so the focusout that
    // `ta.focus()` fires finds nothing to resolve) is the same defense-in-
    // depth this guard already documents, applied to the other session kind.
    if ((activeEditor && activeEditor.blockEl !== blockEl) ||
        (currentBurst && currentBurst.blockEl !== blockEl)) {
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
    // v3.2.0 (final review item 1): `let`, not `const` — reanchor() below
    // re-derives all three of `blockId`/`startLine`/`endLine` when this
    // session survives an incremental patch. See its own comment.
    let blockId = Number(blockEl.getAttribute('data-block-id'));
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
    // The only such blocks today are list items, and they are never armed, so
    // before Task 4 gave every block a ⠿ this was reached by a plain body
    // click and stayed unreported. (Until v3.1.0 this note also cited RULING
    // F-O as an independent second reason. F-O is superseded for the ⠿ menu
    // — see toggleGutterMenu() below — so this guard now carries the case
    // ALONE, and it is the one that always mattered: a block that owns no
    // source line has nothing to seed a textarea WITH, no matter how the
    // editor is torn down afterwards.) Guarded HERE rather than at the click
    // delegator so
    // every caller — the delegated degraded-block click, openRawViaGutter(),
    // the burst-degrade path — is closed by one check.
    if (blockOwnsNoLine(blockEl)) { refuseStructuralListEdit(noSourceLineMessageFor(blockEl)); return; }

    // v3.1.0 修正 4: the span this editor owns. Without `range` it is exactly
    // the block's own record, so `source` below is byte-identical to what
    // extractBlockSource(lines, block) returned before — that helper IS this
    // slice, and every pre-v3.1.0 call site keeps its behaviour unchanged.
    // v3.2.0 (final review item 1): `let` for the same reason as `blockId`.
    let startLine = range ? range.startLine : block.startLine;
    let endLine = range ? range.endLine : block.endLine;
    // The same inverted-range refusal blockOwnsNoLine() just made for the
    // block, re-asked of the range actually being edited: a caller-supplied
    // span can be malformed even when the anchor block is fine.
    if (endLine < startLine) { refuseStructuralListEdit(noSourceLineMessageFor(blockEl)); return; }
    // A list item's rendered chrome (the .ed-li-marker span, the optional
    // .ed-li-check span, the .ed-li-text surface) is REBUILT BY THE RENDERER
    // from the source line's marker — it is not recoverable from a captured
    // innerHTML string once the item's own text has been rewritten, which is
    // exactly what RULING F-O objected to. So a li (and any explicit range)
    // commits through commitRangeEdit() over these lines rather than through
    // the run serializer, and tears down through a real re-render — which
    // removes F-O's stated premise rather than working around it. Ruling 13
    // (v3.1.0) supersedes F-O for THIS surface, the ⠿ menu's MD 原始碼, and
    // for that surface only: the burst-degrade refusal in resolveBurst() and
    // the blockOwnsNoLine() guard just above both still stand, for reasons
    // that were never F-O's.
    const rangeMode = !!range || blockEl.getAttribute('data-block-type') === 'li';
    const original = blockEl.innerHTML;
    const source = lines.slice(startLine - 1, endLine).join('\n');

    const wrap = document.createElement('div');
    wrap.className = 'ed-editing';

    const ta = document.createElement('textarea');
    ta.className = 'ed-raw';
    // F9: `seed.value` 通常 === `source`；只有空圍欄那一種形狀會多一行
    // 空白本文（見 rawEditorSeed()）。`source` 不可以跟著換掉 ——
    // reanchor() 拿它跟檔案裡的位元組逐字比。
    const seed = rawEditorSeed(source);
    ta.value = seed.value;

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
      // F9: 比對 `seed.value` 而不是 `source` —— 空圍欄那條路上種進去的那
      // 一行空白是這個編輯器自己放的，不是使用者打的，把它算成「有變更」
      // 會讓「開起來看一眼就關掉」變成一次靜默的寫檔。
      hasChanges: () => ta.value !== seed.value,
      commitNow: commit,
      cancelNow: cancelAndMaybeDiscard,
      reanchor,
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
    // F9: 不再無條件落在值的結尾 —— 見 rawEditorSeed() 自己的註解。
    ta.setSelectionRange(seed.caret, seed.caret);

    async function restore() {
      // v3.1.0 修正 4: `rangeMode` cannot restore by rewriting innerHTML —
      // for a li that string would have to carry the marker/check/text chrome
      // back, and for a multi-block span there is more than one block's DOM
      // to put back in the first place. A re-render rebuilds all of it from
      // `lines`, which this path never touched (restore() NEVER commits), so
      // the document is byte-identical either way — this is a different way
      // of repainting the same bytes, not a different edit.
      if (rangeMode) {
        if (activeEditor && activeEditor.blockEl === blockEl) activeEditor = null;
        await safeRerenderAll();
        return;
      }
      // v3.2.1 R1: 清 activeEditor 必須先於這個 innerHTML 寫入。寫入會 detach
      // 聚焦的 textarea，Chromium 同步派發 focusout，而 focusout handler 只要
      // activeEditor 非 null 就會走 switchAwayFrom() → resolveOpenSession() →
      // commitNow()，把使用者按 Escape 要丟棄的文字提交進檔案（實測落到磁碟）。
      // 同一函式的 rangeMode 分支早就是這個順序，理由相同。
      // Only clear `activeEditor` if it's still THIS block's entry — it may
      // already have been cleared out from under us (e.g. by rerenderAll()'s
      // own defensive reset on a successful swap elsewhere), and this must
      // never stomp some OTHER block's activeEditor set after this one.
      if (activeEditor && activeEditor.blockEl === blockEl) activeEditor = null;
      blockEl.innerHTML = original;
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
      await restore();
      if (wasPristineForThisBlock) return await discardPristineInsert();
      return true;
    }

    // v3.2.0 final review item 1 — 決議 3(1) 的 activeEditor 對稱項。
    //
    // 這個 session 的 `blockId` / `startLine` / `endLine` 是開啟當下從**那一
    // 份** `blocks` 抓下來的；fallback 路徑上那從來不是問題，因為
    // `contentEl.innerHTML = ` 會把這個 textarea 一起拔掉。patch 路徑保留
    // 前綴／後綴節點，所以它可以活過一次 render，而 render 之後 `blocks`
    // 已整份換掉、被保留後綴節點的 data-block-id 也被重寫過。
    //
    // applyPatch() 的 teardown 在實測 `document.body.contains(blockEl)` 成立
    // 之後呼叫這支，把三個欄位從**現在**的 DOM 屬性與新的 `blocks` 重新
    // 推導。回傳 false 代表推導不出來，呼叫端必須退回原本的無條件歸零：
    //   - `range`：呼叫端指定的跨區塊 span（⠿ 選單的「MD 原始碼」批次路徑）
    //     在新的 `blocks` 裡沒有單一對應記錄，無從重新推導。
    //   - 區塊在新的 `blocks` 裡不存在（防禦；節點還在就不該發生）。
    //   - 重新切出來的來源**不是** byte-identical：那表示這個區塊底下的行
    //     真的變了，`ta.value` 與 `source` 都已經不是檔案裡的東西，沿用這個
    //     session 會把過期的文字提交回去。patch 只保留 parts 相同的節點，所以
    //     正常情況下這個等式成立；不成立時退回歸零是保守的正解。
    function reanchor() {
      if (range) return false;
      const id = Number(blockEl.getAttribute('data-block-id'));
      const b = blocks.find((x) => x.id === id);
      if (!b || b.endLine < b.startLine) return false;
      if (lines.slice(b.startLine - 1, b.endLine).join('\n') !== source) return false;
      blockId = id;
      startLine = b.startLine;
      endLine = b.endLine;
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
      // v3.1.0 修正 4: an explicit range commits over ITS OWN span. commitEdit()
      // is the by-id wrapper over exactly this call (it looks the block up and
      // delegates), so the two branches are the same pipeline — replaceLines()
      // + one undo op — differing only in which lines they name.
      const result = rangeMode
        ? commitRangeEdit({ lines, blocks, stack }, startLine, endLine, ta.value)
        : commitEdit({ lines, blocks, stack }, blockId, ta.value);
      if (result.op === null) {
        // §10-gap fix (review): an explicit commit (Ctrl+Enter/✓) whose
        // text happens to be byte-identical to `source` is still an
        // "unchanged" exit for THIS block — same auto-remove contract as
        // every other restore() call site.
        return await cancelAndMaybeDiscard();
      }
      const prevLines = lines;
      lines = result.lines;
      const editRange = result.op
        ? { startLine: Math.min(result.op.startLine, result.op.endLine + 1),
            endLine: Math.max(result.op.startLine - 1, result.op.endLine),
            delta: result.op.after.length - result.op.before.length }
        : undefined;
      const ok = await safeRerenderAll(editRange);
      if (!ok) {
        // Roll back the optimistic edit: pop the op safeRerenderAll's
        // failure means was never actually rendered, so `lines` stays
        // consistent with what the server actually has. Deliberately does
        // NOT call restore() — the editor (and the user's unsaved text)
        // stays open and visible; see the comment above.
        lines = rollbackFailedRender({ lines, stack }, result, prevLines);
        return false;
      }
      // Success. On the FALLBACK path rerenderAll() replaced the whole
      // .content subtree (this block included) and nulled `activeEditor`
      // itself, so there was nothing left to do here.
      //
      // v3.2.0 final review item 1: that is no longer unconditional. The
      // patch path only detaches this block when it lands inside
      // `replaceSpan` — and a commit very often leaves it OUTSIDE: whenever
      // the edit's visible effect is a NEW block AFTER this one (a line
      // appended below a fence, a paragraph typed under a paragraph) this
      // block's own part is byte-identical before and after, so patchmap
      // keeps it in `keepPrefix` and the textarea stays on screen, on top of
      // content that was already repainted around it.
      //
      // MEASURED at HEAD, before this repair (scratchpad/item1-zombie.js
      // --head): Ctrl+Enter on a code fence with one line appended commits
      // correctly to the file but leaves `rawTextareas: 1` standing forever
      // — unclickable, because both the delegated click handler and
      // openRawEditor() early-return on a block that already has a `.ed-raw`.
      // With the `activeEditor` exception above it is worse than cosmetic:
      // the session stays live with its ORIGINAL `source`, so the next
      // switchAwayFrom() sees hasChanges() and commits the same text a
      // second time (measured: 'const LOST = 2;' twice in the file).
      //
      // A kept node's part is byte-identical by construction — that is the
      // only reason patchmap kept it — so `original` (this block's innerHTML
      // captured at open, i.e. post-armEditables) is exactly the content to
      // put back. Same one-line repaint the non-range restore() below uses,
      // for the same reason.
      //
      // ⚠ 順序不可對調，而且不是防禦性的：`blockEl.innerHTML =` 會把還握著
      // 焦點的 textarea 就地 detach，Chromium 在那當下**同步**送出一次
      // focusout，委派的 focusout handler 走 switchAwayFrom() →
      // resolveOpenSession() → activeEditor.commitNow()。先重繪再歸零時，
      // 那一發看到的還是這個 session、hasChanges() 仍為真，於是把同一段文字
      // 再提交一次（實測：'ZZZ tail.' 在檔案裡出現兩次，stack 是
      // commit → focusout → switchAwayFrom → resolveOpenSession → commitNow）。
      // 先歸零就沒有東西可以被重新解析。rangeMode 的 restore() 早就是這個
      // 順序，理由相同。
      if (activeEditor && activeEditor.blockEl === blockEl) activeEditor = null;
      if (document.body.contains(blockEl) && blockEl.querySelector('.ed-raw')) {
        blockEl.innerHTML = original;
      }
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
  // each commit helper that reaches ops.replaceLines() (grep
  // `ops.replaceLines(`) about a range shape none of them expect. The block is
  // still rendered, still selectable, and its CHILD — which does own its line —
  // stays fully editable.
  function blockOwnsNoLine(blockEl) {
    const raw = blockEl.getAttribute('data-block-id');
    if (raw === null) return false; // provisional block: no record yet, not our call
    const rec = blocks.find((b) => b.id === Number(raw));
    return !!rec && rec.endLine < rec.startLine;
  }

  // Two DIFFERENT things now arrive with an empty range, and blockOwnsNoLine()
  // cannot tell them apart because the range shape is identical:
  //
  //   '- - a'   the outer item genuinely owns no line — its content begins
  //             with its child. A modelled, legitimate shape.
  //   degraded  blockmap.js could not LOCATE this item's nested list inside
  //             the item's own text, so it emptied the whole subtree rather
  //             than hand out line numbers it had guessed. The item owns a
  //             line; nobody can say which.
  //
  // Answering the second with the first's wording ('沒有自己的來源行') would
  // tell the user something untrue about their document — that item HAS a
  // source line. So the flag blockmap.js sets on the degraded records is read
  // here, instead of re-deriving a cause from `endLine < startLine`, which
  // carries none.
  //
  // No markdown MEASURED so far reaches the second branch: every string a full
  // journey run hands buildBlockMap(), and every trailing-space variant of
  // those, produced no `unlocatable` records. So the branch is driven
  // instead by making the real blockmap search fail — grep
  // test/editor-journey.test.js for 'already degraded', which wraps marked's
  // lexer for one row so the server serves a genuinely degraded document, then
  // clicks the degraded item and reads the banner off the page. MEASURED by that
  // row, and only that row: the click renders UNLOCATABLE_LINE_MESSAGE, opens no
  // textarea, and leaves the file byte-identical.
  //
  // The other half of the pair is pinned somewhere else and it is worth knowing
  // where, because no single file renders both: test/editor-client-runtime.test.js
  // clicks the outer item of a '- - b' same-line nest and asserts the banner
  // reads NO_SOURCE_LINE_MESSAGE — grep it for '沒有自己的來源行'. Those two
  // assertions, in two files, are what keep the two causes from collapsing back
  // into one sentence. This branch is a net for a shape nobody has produced yet,
  // not a path.
  function blockRangeIsUnlocatable(blockEl) {
    if (!blockEl || !blockEl.getAttribute) return false;
    const raw = blockEl.getAttribute('data-block-id');
    if (raw === null) return false;
    const rec = blocks.find((b) => b.id === Number(raw));
    return !!(rec && rec.unlocatable);
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
  // The degraded-subtree wording (see blockRangeIsUnlocatable() above). Each
  // one NAMES ITS OPERATION exactly as the pair above does — that is the whole
  // reason the pair above is a pair — and differs from it only in the clause
  // that states the cause. Deliberately says nothing about the refusal being
  // temporary: nothing lifts it, so wording like 「已暫停」 would promise a state
  // change that never comes.
  const UNLOCATABLE_LINE_MESSAGE = '這段巢狀清單對不到自己的來源行，無法刪除或直接編輯';
  const UNLOCATABLE_LINE_INSERT_MESSAGE = '這段巢狀清單對不到自己的來源行，無法在其後插入區塊';
  // Both refusals go through one chooser each, so a call site cannot pick the
  // right guard and the wrong sentence.
  function noSourceLineMessageFor(blockEl) {
    return blockRangeIsUnlocatable(blockEl) ? UNLOCATABLE_LINE_MESSAGE : NO_SOURCE_LINE_MESSAGE;
  }
  function noSourceLineInsertMessageFor(blockEl) {
    return blockRangeIsUnlocatable(blockEl)
      ? UNLOCATABLE_LINE_INSERT_MESSAGE : NO_SOURCE_LINE_INSERT_MESSAGE;
  }

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
  // S4 Task 7 split this in two WITHOUT changing what any existing caller does:
  // computeIndentClamp() answers the clamp, applyIndentClamp() writes it, and
  // the four callers that existed before this task still call the latter and
  // still see exactly the answer they saw. The reason for the split is the ⠿
  // DROP, and it is not a stylistic one: every other caller clamps a span it
  // has already decided to commit, while the drop still has ONE refusal left
  // after the clamp (see performListItemDrop()). Writing `data-indent` on a
  // gesture that then refuses leaves a half-clamped DOM behind — the same
  // "the screen and the model disagree" failure the clamp exists to prevent,
  // produced by the clamp itself. So the drop asks first and writes only once
  // it knows it is committing.
  //
  // `null` is "no answer at all": no clamp module, an empty span, or an
  // operated element that is not IN the span. That last one abandons the whole
  // clamp rather than clamping a subset — a partial op set makes rule 2's scope
  // start in the wrong place, which is a silent wrong answer. Every caller
  // treats `null` as "leave every indent alone", which is what the pre-split
  // function did by returning early.
  function computeIndentClamp(spanEls, opBlockEl, opOldIndent, opts) {
    if (!indentClamp || !spanEls || !spanEls.length) return null;
    // v3.0.2 — the structural answer to the stale-`run` pattern that v3.0.1
    // point-fixed at three call sites, and that both reviewers asked to have
    // fixed at the call convention instead. There are FIVE call sites, not
    // three (3483 batch delete, 3812 convert, 5778 batch Tab/Shift+Tab, 6028
    // caret Tab/Shift+Tab — both indent directions share ONE call site each,
    // batch vs. caret, not one call site per direction — and the drop's
    // compute at 8516), and every one of them hands over a `listRunOf()`
    // result in document order. Two ways that goes stale, both of which
    // produced a confident wrong number rather than a refusal: a member
    // DETACHED (getAttribute still answers on a detached node) and a span
    // still attached but no longer in the run's document order (indexOf()
    // then reports an opIndex for a layout that no longer exists, so §3.4
    // rule 2's scope starts in the wrong place). Re-deriving the span here
    // instead of checking it was rejected: it would quietly change the
    // contract from "clamp this span" to "clamp the run containing this
    // op", and the drop is the one caller subtle enough that taking that
    // expressiveness away is not free.
    //
    // It does NOT throw. This file's defensive style (safeRerenderAll at
    // ~990) is that the editor must not die on one path's failure. But the
    // refusal is NOT free either: at the drop (8516) a null clamp feeds
    // spanIndentsAreAnchored() the RAW reordered indents, and that refuses
    // 1425 of 4067 legal drops where the clamped answer refuses only 14 (the
    // clamp rescues the other 1411; the measured numbers are recorded at
    // line ~371). So a false positive here costs the user up to 1411 legal
    // batch drags, replaced by a banner —
    // which is why the assert is worth this cost even though the batch-
    // delete, convert and drop sites each have a scenario whose correct
    // answer needs a real reclamp (a wrongly-firing assert breaks them
    // visibly), while neither Tab call site (5778 batch, 6028 caret) has a
    // scenario that reclamps a TRAILING sibling — see
    // test/editor-client-runtime.test.js for the per-site detail.
    const fresh = listRunOf(spanEls[0]);
    if (fresh.length !== spanEls.length ||
        fresh.some((el, i) => el !== spanEls[i])) {
      // Minor 5: the length pair alone is silent on the reordered-but-same-
      // length case (the ONLY case where an index is diagnostic — a length
      // mismatch is already self-explanatory), so report the first index at
      // which the two runs disagree too.
      const minLen = Math.min(fresh.length, spanEls.length);
      let badIndex = -1;
      for (let i = 0; i < minLen; i++) {
        if (fresh[i] !== spanEls[i]) { badIndex = i; break; }
      }
      if (badIndex < 0 && fresh.length !== spanEls.length) badIndex = minLen;
      console.error('computeIndentClamp: stale span — the run has ' + fresh.length +
        ' members, the caller passed ' + spanEls.length +
        ', first differing at index ' + badIndex +
        '; refusing rather than clamping against a layout that no longer exists');
      return null;
    }
    const opEls = Array.isArray(opBlockEl) ? opBlockEl : [opBlockEl];
    const opIndex = [];
    for (let k = 0; k < opEls.length; k++) {
      const at = spanEls.indexOf(opEls[k]);
      if (at < 0) return null;
      opIndex.push(at);
    }
    if (!opIndex.length) return null;
    const model = spanEls.map((el, i) => ({
      id: i, // index-as-id: the span IS the universe here
      type: el.getAttribute('data-block-type') === 'li' ? 'li' : 'other',
      indent: Number(el.getAttribute('data-indent')) || 0,
    }));
    return indentClamp.clampIndents(model, opIndex, opOldIndent, opts || {})
      .map((r) => ({ el: spanEls[r.blockId], indent: r.indent }))
      .filter((r) => !!r.el);
  }

  function writeIndentClamp(answer) {
    (answer || []).forEach((r) => {
      if ((Number(r.el.getAttribute('data-indent')) || 0) !== r.indent) {
        setBlockIndent(r.el, r.indent);
      }
    });
  }

  function applyIndentClamp(spanEls, opBlockEl, opOldIndent, opts) {
    writeIndentClamp(computeIndentClamp(spanEls, opBlockEl, opOldIndent, opts));
  }

  function placeCaretAtEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ── Task 15: the two selections Tab writes ───────────────────────────────
  //
  // Both go through setBaseAndExtent() rather than the removeAllRanges() +
  // addRange() pair placeCaretAtEnd() just above uses, because Tab now writes
  // a selection on every press and the spellings differ in what they
  // dispatch. Counted on a live cell, applying boundary values that were
  // ALREADY the ones in force: setBaseAndExtent() dispatched no
  // selectionchange, removeAllRanges() + addRange() dispatched one, and
  // selectNodeContents() followed by that pair dispatched one. The resulting
  // Range is otherwise the same: over a cell holding 'c2', both spellings of
  // "select the contents" read back start TD offset 0 to end TD offset 1
  // covering 'c2', and both spellings of each caret placement read back the
  // matching collapsed pair. On a cell emptied first, setBaseAndExtent()
  // placed a collapsed selection instead of throwing.
  //
  // The element-anchored boundary points are load-bearing beyond tidiness —
  // see `tabSelectedCellEl` further down, whose release condition is exactly
  // "the live selection is no longer these".
  function selectSurfaceContents(el) {
    const sel = window.getSelection();
    if (!sel) return;
    sel.setBaseAndExtent(el, 0, el, el.childNodes.length);
  }

  function placeCaretAtSurfaceStart(el) {
    const sel = window.getSelection();
    if (!sel) return;
    sel.setBaseAndExtent(el, 0, el, 0);
  }

  // ── Marks a Range operation leaves behind holding nothing ────────────────
  //
  // extractContents() and deleteContents() each act on an element the range
  // only PARTIALLY contains by taking its contained part and leaving the
  // original element in place. When the boundary sits at offset 0 of that
  // element's own first child, everything it held goes and the original is
  // left holding nothing that renders. Measured, bolding a selection that
  // starts at the first character of an <em>:
  //
  //   before  `Alpha <em>ital</em> bold text here.`
  //   after   `Alpha <em></em><strong><em>ital</em> bold</strong> text here.`
  //
  // Nothing downstream drops that <em>: it still serialises to its delimiter
  // on each side. The bytes measured on disk, one gesture per line, all from
  // the same selection:
  //
  //   toolbar 粗體  `Alpha *****ital* bold** text here.`
  //   toolbar 🔗    `Alpha **[*ital* bold](https://example.com) text here.`
  //   Shift+Enter   `Alpha **<br> text here.`
  //   paste         `Alpha **PASTED text here.`
  //   Enter in a li `- Alpha **`
  //
  // Each of those re-parses with the stray asterisks as literal text and comes
  // back escaped on the next save — 「*字號前面都有 \ 跳脫」, the symptom this
  // was reported as. Journey row `escape-cycle` drives that whole cycle.
  //
  // Collecting and dropping are separate functions because the operation
  // between them differs per call site: extractContents() into a new element
  // (the mark and link paths), deleteContents() then an insert (Shift+Enter,
  // paste), and a delete plus a tail extraction (the list split, which folds
  // its delete range and its tail range into the same collection).

  const EDIT_SURFACE_SEL = '.ed-wys-armed, .ed-wys-cell';

  // The editing surface `node` sits in — a paragraph / heading / list-item
  // surface, or a table cell. This is what the walk below terminates at, and
  // the reason it names the CELL rather than the <table>: a cell left holding
  // nothing must stay a cell, and it does because the walk never reaches it.
  function editSurfaceOf(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentNode);
    return el && el.closest ? el.closest(EDIT_SURFACE_SEL) : null;
  }

  // The elements the operation could leave empty: the element ancestors of
  // `range`'s start container and of its end container, up to (not including)
  // `root`, each tagged with its element depth below `root`. Called BEFORE the
  // operation, because the Range's boundary points move the moment it runs.
  //
  // `into` lets a call site fold several ranges into the same collection; an
  // element already collected is not collected again.
  //
  // A boundary that is not inside `root` contributes nothing, and a falsy
  // `root` collects nothing at all. Without a terminator inside the editing
  // surface the walk would climb into the page chrome, and there is nothing up
  // there this function could nominate for removal. Making that true HERE rather than
  // trusting each caller is what lets the removal below dereference
  // `parentNode` unguarded.
  function collectLeftovers(range, root, into) {
    const leftovers = into || [];
    if (!root) return leftovers;
    const collect = (node) => {
      if (!node || !root.contains(node)) return;
      const chain = [];
      for (let n = node; n && n !== root; n = n.parentNode) {
        if (n.nodeType === 1) chain.push(n);
      }
      // `chain` is deepest-first, so `chain.length - i` is the element depth
      // below `root` — a value that compares correctly across chains, which a
      // plain per-chain index would not.
      chain.forEach((n, i) => {
        if (!leftovers.some((x) => x.el === n)) leftovers.push({ el: n, depth: chain.length - i });
      });
    };
    collect(range.startContainer);
    collect(range.endContainer);
    return leftovers;
  }

  // Removes the collected elements the operation left holding nothing. Call it
  // AFTER whatever the call site puts in the range's place, so an element that
  // now holds the new node is not mistaken for an empty leftover.
  //
  // "Holds nothing" is `no child ELEMENT and no text`. Every conjunct of that
  // test has a journey row that reds when that conjunct alone is removed:
  //
  //  * the text test alone would delete a mark left holding a <br> — a hard
  //    break has no text, but it is content the user typed. Journey row
  //    `keeps-br`.
  //  * the element test alone would delete a mark left holding TEXT, which is
  //    what a selection starting partway into that mark leaves behind. Journey
  //    row `keeps-text`.
  //
  // What it is NOT is a child count. A fully-taken boundary text node is not
  // removed by extractContents() or by deleteContents(); its data is replaced
  // with the remainder, so the node survives holding the empty string. Probed
  // right after the extraction on the bold row — the surviving <em> reported
  // `<em></em>`, its childNodes still holding a text node whose data was "". A child-count test
  // never fires on the very shape this exists for.
  //
  // Deepest first, so a mark left empty only by the removal of an inner one is
  // still seen as empty when its own turn comes. Journey row `nested-order`.
  //
  // `parentNode` is dereferenced unguarded: a candidate is an ancestor of a
  // boundary container and a strict descendant of `root` — collectLeftovers()
  // enforces the descendant part rather than trusting callers. A partially
  // contained ancestor is exactly what these Range methods leave in place: the
  // `before`/`after` measurement above is that, seen directly. And the
  // deepest-first order means a candidate is reached only after every candidate
  // it contains, so nothing detaches a candidate before its turn.
  function dropEmptied(leftovers) {
    leftovers.slice().sort((a, b) => b.depth - a.depth).forEach((x) => {
      if (!x.el.firstElementChild && x.el.textContent === '') x.el.parentNode.removeChild(x.el);
    });
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
    // Same leftover as the toolbar's: a paste over a selection that starts at
    // the first character of an <em> left `Alpha **PASTED text here.` on disk.
    const leftovers = collectLeftovers(range, editSurfaceOf(range.startContainer));
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
    dropEmptied(leftovers);
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
    // Same leftover as the toolbar's: Shift+Enter over a selection that starts
    // at the first character of an <em> left `Alpha **<br> text here.` on disk.
    const leftovers = collectLeftovers(range, editSurfaceOf(range.startContainer));
    range.deleteContents();
    const br = document.createElement('br');
    range.insertNode(br);
    range.setStartAfter(br);
    range.setEndAfter(br);
    // After the <br> is in place, because the <br> can land INSIDE a mark this
    // very delete emptied and that mark must then be kept. Measured, Shift+Enter
    // over a selection covering the whole of `<em>ital</em>`:
    // `Alpha <em><br></em> bold text here.` — dropping before the insert would
    // have taken that <em> and the caret's new home with it.
    dropEmptied(leftovers);
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
  //
  // v3.2.1 final wave: THIN WRAPPER + `finally`, the same shape the other four
  // sinks use, because this function's own early exits were live holes in
  // exactly the promise this version's CHANGELOG makes. MEASURED on ddac6ce
  // with real keystrokes, three runs each: typing in `# Title` then Shift+Tab
  // went H1.ed-wys-armed / 15 enabled → BODY / 4 enabled, and `###### Title`
  // then Tab did the same; `## Title` + Tab (the unclamped control) stayed
  // H3.ed-wys-armed / 15. The clamp is reachable from an ordinary gesture:
  // handleBurstKeydown()'s `changeHeadingDepth(currentBurst.blockEl,
  // e.shiftKey ? -1 : 1)` passes a raw ±1 with no `delta === 0` filter (unlike
  // applyHeadingLevel(), which computes a delta and can hand over 0), so Tab
  // at either end of H1..H6 lands on `newDepth === curDepth` — an early return
  // that sits BELOW the switchAwayFrom() that already committed and re-rendered
  // and ABOVE the restore at the tail.
  //
  // The body answers a line on every exit it can name one for:
  //   * success                  result.op.startLine (the commit's own first
  //                              written line — see the note at the tail)
  //   * newDepth === curDepth    block.startLine
  //   * result.op === null       block.startLine
  // `block` is looked up out of `blocks` AFTER switchAwayFrom(), so its
  // startLine is already a post-render coordinate. INSTRUMENTED at that exit
  // rather than reasoned: on `# Title` typed into and then Shift+Tab-ed, the
  // clamped return printed
  //   {sameBlocksArray:false, sameNode:false, blockId:0, startLine:1,
  //    resolvesToId:0, resolvedText:'TitleX'}
  // — switchAwayFrom() had replaced both the `blocks` array and the heading's
  // DOM node, and `block.startLine` still resolved to the LIVE block carrying
  // the just-committed text, which is exactly what focusBlockAtLine() needs.
  //
  // The two re-query failures above it (`blockEl` gone, `block` not in
  // `blocks`) deliberately answer nothing: there is no block left to aim at,
  // and guessing a line is worse than restoring no caret.
  async function changeHeadingDepth(blockEl, delta) {
    let focusLine = null;
    const anchor = {};
    try {
      const out = await changeHeadingDepthBody(blockEl, delta, anchor);
      if (out != null) focusLine = out;
    } finally {
      restoreAfterStructuralOp(focusLine, anchor.line);
    }
  }

  async function changeHeadingDepthBody(blockEl, delta, anchor) {
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
    // Post-switchAwayFrom(), post-render: the landing for every exit below
    // that writes nothing. See restoreAfterStructuralOp().
    if (anchor) anchor.line = block.startLine;
    const curLine = lines[block.startLine - 1];
    const curDepth = headingDepthOf(curLine);
    const newDepth = Math.max(1, Math.min(6, curDepth + delta));
    if (newDepth === curDepth) return;
    const newLine = withHeadingDepth(curLine, newDepth);
    const result = commitEdit({ lines, blocks, stack }, blockId, newLine);
    if (result.op === null) return;
    const prevLines = lines;
    lines = result.lines;
    const editRange = result.op
      ? { startLine: Math.min(result.op.startLine, result.op.endLine + 1),
          endLine: Math.max(result.op.startLine - 1, result.op.endLine),
          delta: result.op.after.length - result.op.before.length }
      : undefined;
    const okRender = await safeRerenderAll(editRange);
    if (!okRender) {
      lines = rollbackFailedRender({ lines, stack }, result, prevLines);
    }
    // v3.2.1 (controller ruling T5-1): the OTHER sink. H▾ on a block that is
    // ALREADY a heading routes HERE, not to convertBlockViaMenu() —
    // applyHeadingLevel() takes that road only for a NON-heading — so without
    // this, H2 → H4 still ends the way every conversion used to: the render's
    // teardown ran resetToolbarBlock(), activeElement is BODY and the bar is
    // down to 4 enabled buttons, and a second operation needs a fresh click.
    //
    // Same predicate and the same measurement as convertBlockViaMenu()'s exit
    // — the wrapper's restoreAfterStructuralOp() is now literally the same
    // function, so see its note for why it is `blockSelection` and not operand
    // cardinality, and why forcing a caret while a selection stands
    // manufactures a broken state rather than fixing one.
    //
    // The line is `result.op.startLine`, the commit's OWN first written line:
    // commitEdit() resolves the block and hands commitRangeEdit() that
    // startLine, which is where replaceLines() writes `after`. This function
    // declares no collapse of its own (it is not a set operation), so the
    // commit result is the only post-commit value it holds — and it is a
    // RESULT, not a pre-commit `block.startLine` capture. An insertion above
    // this block cannot have happened between the two, because the commit IS
    // the only thing that ran.
    return result.op.startLine;
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
    // ── v3.0.1: one icon per 轉換成 target ────────────────────────────────
    // Keys are CONVERT_TARGETS[].id verbatim; openConvertSubmenu() looks them
    // up by that id, so a rename on either side must be made on both.
    // 文字 — a paragraph pilcrow, drawn rather than typed so it inherits the
    // same stroke weight as every sibling icon.
    text: '<path d="M9 2.5H6.2a2.7 2.7 0 0 0 0 5.4H9"/><path d="M9 2.5v11"/><path d="M11.8 2.5v11"/>',
    // 標題 1–6 — an "H" plus the level, as two strokes and a numeral bar set.
    h1: '<path d="M3 3v10"/><path d="M8 3v10"/><path d="M3 8h5"/><path d="M11.5 6.5l1.5-1v7.5"/>',
    h2: '<path d="M3 3v10"/><path d="M8 3v10"/><path d="M3 8h5"/><path d="M11 6.6a1.6 1.6 0 0 1 2.7 1.1c0 1.4-2.7 2.6-2.7 5.3h3"/>',
    h3: '<path d="M3 3v10"/><path d="M8 3v10"/><path d="M3 8h5"/><path d="M11 5.8h2.7l-1.6 2.6a1.8 1.8 0 1 1-1.3 3"/>',
    h4: '<path d="M3 3v10"/><path d="M8 3v10"/><path d="M3 8h5"/><path d="M13 5.8v7.2"/><path d="M13 10.7h-2.6l2.2-4.9"/>',
    h5: '<path d="M3 3v10"/><path d="M8 3v10"/><path d="M3 8h5"/><path d="M13.5 5.8h-2.6v2.8a1.9 1.9 0 1 1-.5 3.6"/>',
    h6: '<path d="M3 3v10"/><path d="M8 3v10"/><path d="M3 8h5"/><path d="M13.4 6.2a1.9 1.9 0 0 0-3 1.5v3.2a1.8 1.8 0 1 0 3.1-1.3 1.8 1.8 0 0 0-3.1 1.3"/>',
    // 項目符號列表 — three dots with three rules.
    ul: '<circle cx="3.2" cy="4.2" r="1"/><circle cx="3.2" cy="8" r="1"/><circle cx="3.2" cy="11.8" r="1"/>' +
      '<path d="M6.4 4.2h7.4"/><path d="M6.4 8h7.4"/><path d="M6.4 11.8h7.4"/>',
    // 編號列表 — the same three rules led by 1/2/3 strokes.
    ol: '<path d="M2.2 3.4l1-.6v2.8"/><path d="M2 8.2a1 1 0 0 1 1.7.7c0 .9-1.7 1.6-1.7 2.4h1.9"/>' +
      '<path d="M2.1 11.4h1.6l-1 1.1a1 1 0 1 1-.7 1.2"/>' +
      '<path d="M6.4 4.2h7.4"/><path d="M6.4 8.6h7.4"/><path d="M6.4 12.9h7.4"/>',
    // 待辦清單 — a checked box.
    task: '<rect x="2.2" y="2.6" width="10.8" height="10.8" rx="2.4"/><path d="M5.2 8.2l2.1 2.1 3.8-4"/>',
    // 引用 — a quote bar plus two shortened rules.
    quote: '<path d="M3 3.4v9.2"/><path d="M6.4 5.4h7.2"/><path d="M6.4 8h7.2"/><path d="M6.4 10.6h4.6"/>',
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
      // v3.0.1: the submenu carries icons too. Without them its labels start
      // at the button's own padding while the parent menu's start past a 16px
      // icon, so the two levels' text does not share a vertical line — the
      // exact defect the user reported. `.ed-handle-menu-btn` is already a
      // flex row with a gap, so an icon plus a text node is all it takes.
      b.innerHTML = menuIconMarkup(t.id);
      b.appendChild(document.createTextNode(t.label));
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
    // Clamp the panel's top into the viewport. Measured on this branch:
    // opening ⠿ then hovering 轉換成 never reads window.innerHeight before
    // this line, confirming the clamp below did not already exist somewhere
    // else in this path. getBoundingClientRect() is read after the append
    // above, so the height it reports is the panel as laid out here, not a
    // guessed constant, and it already reflects .ed-handle-submenu's own
    // max-height cap (lib/md2doc.js) when a short viewport has forced that
    // cap to bite. Its `bottom` already carries the containing block's
    // screen position, because the `top` set above resolves against that
    // block (position: absolute). Shifting `top` up by the bottom overflow
    // is the clamp.
    const overflowBottom = sub.getBoundingClientRect().bottom - window.innerHeight;
    if (overflowBottom > 0) {
      sub.style.top = (anchorBtn.offsetTop - overflowBottom) + 'px';
    }
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

  // ── The one rule about 轉換成 and block type ────────────────────────────
  // The block types 轉換成 is WITHHELD from, and the banner the BATCH path
  // shows when a span holds one. ONE table, TWO call sites — toggleGutterMenu()
  // just below hides the item on a single block's ⠿; convertBlockViaMenu()
  // refuses a span that holds one — and that is the point of it being a shared
  // predicate rather than a type test written out twice. MEASURED 2026-08-31,
  // with the batch path gating only 'table': a selection over a paragraph, an
  // hr and a paragraph, converted from a grip on a paragraph, wrote
  // '# Doc\n\n- alpha\n- ---\n- bravo\n' with NO banner — '- ---' being the
  // exact byte sequence the 'hr' reason below names as why the item is not
  // offered. A type withheld in one place and silently allowed in the other IS
  // the defect; deriving both from here is what makes a fourth type impossible
  // to add to one affordance and forget in the other.
  //
  // Why these three:
  //   'table' — §7: there is no target that could carry a table's cells, and
  //     every one of the twelve would destroy them.
  //   'hr' / 'html' — the gesture would LIE. convert-md strips a block's
  //     MARKER to get its content, and an <hr> has no content: its source line
  //     IS the marker. Measured: 'hr' → 項目符號列表 writes '- ---', which
  //     marked re-lexes as an hr again, so the file's bytes change, the block
  //     type does not, and nothing is said; 'hr' → 文字 is a byte no-op, also
  //     silent. An 'html' block is raw passthrough for the same reason — no
  //     marker to strip and nothing to re-host. Nothing is LOST either way,
  //     but an item that appears to work and does nothing is worse than an
  //     item that is not offered.
  //
  // Each type names ITSELF in the banner: a user whose selection holds an hr
  // must not be told it holds a table. One template, three labels — the
  // wording is per type, the RULE is not.
  const BATCH_CONVERT_WITHHELD_MESSAGES = {
    table: '選取範圍含有表格，無法整批轉換',
    hr: '選取範圍含有分隔線，無法整批轉換',
    html: '選取範圍含有 HTML 區塊，無法整批轉換',
  };
  function convertWithheldFor(blockType) {
    return Object.prototype.hasOwnProperty.call(
      BATCH_CONVERT_WITHHELD_MESSAGES, blockType);
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
    // Spec §7 / §3.7. Which types, and why, is stated ONCE just above — this
    // is one of that predicate's two call sites, and convertBlockViaMenu()'s
    // batch refusal is the other.
    gutterMenuConvert.hidden = convertWithheldFor(blockType);
    gutterMenuDuplicate.hidden = false;
    gutterMenuDelete.hidden = false;
    // 'MD 原始碼' is offered for EVERY block type, list items included, and
    // for a multi-block selection. The menu is a SINGLETON moved between
    // blocks, so this is still written on every open rather than set once.
    // (test/editor-reader-rebind.test.js drives raw-edit through this button
    // by its exact text on a paragraph.)
    //
    // ⚠ THIS REVERSES RULING F-O, deliberately and at spec level (v3.1.0
    // Ruling 13), for this surface and this surface only. F-O read: 'MD
    // 原始碼' is hidden for a list item PERMANENTLY, because openRawEditor()
    // replaces the block's innerHTML with a <textarea> — and a li is one line
    // of a run serialized as a whole, so a textarea inside it is content the
    // serializer cannot represent, and restore() would have to rebuild the
    // marker/check/text chrome out of a string. 修正 4 removes that premise
    // instead of arguing with it: a li now raw-edits an explicit LINE RANGE,
    // commits it through commitRangeEdit() rather than the run
    // re-serializer, and RESTORES BY RE-RENDERING rather than by rewriting
    // innerHTML, so no serializer ever sees the textarea and no chrome is
    // ever rebuilt by hand.
    //
    // F-O's OTHER call sites are NOT in scope and still refuse, each for a
    // reason that was never F-O's: openRawEditor()'s blockOwnsNoLine() guard
    // (a block with an inverted range has no line to seed a textarea with)
    // and resolveBurst()'s unsupported-inline-content path (that refusal is
    // about the CONTENT, not the container).
    //
    // §3.7's other sentence about this item — 「多選時不顯示 `MD 原始碼`」 —
    // is also lifted, and for the same kind of reason: it existed because
    // openRawViaGutter() rewrote ONE block's source lines, so over a set of N
    // it silently answered for the grip's block and ignored the rest. It now
    // opens on the WHOLE span's line range (§3.3 membership, asked through
    // resolveGutterOperands() so the contiguity and no-source-line gates come
    // with it), so the item does what it appears to do.
    // The membership question itself moved WITH the decision it feeds, into
    // openRawViaGutter() (it now chooses the RANGE instead of the
    // visibility), so it is asked exactly once, in the place that acts on it.
    gutterMenuMd.hidden = false;
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
    // v3.1.0 §4: the toolbar's ― button. '---' is safe as a thematic break
    // here specifically because commitBlockInsertion() ALWAYS writes a
    // leading blank line (see its own comment) — a '---' directly under a
    // non-blank line would instead lex as a setext H2 and silently promote
    // whatever preceded it. Nothing else in this file may reuse this
    // skeleton through a path that does not guarantee that blank.
    line: ['---'],
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
    // v3.2.0: UndoStack.undo()/discardTop() reverse the op when applying it but
    // return the unmodified FORWARD op, so the range actually rewritten is
    // [op.startLine, op.startLine + op.after.length - 1] and the delta is the
    // mirror of the forward one. Using op.endLine here would name the opposite
    // direction — the span the op wrote on the way FORWARD, not the one this
    // reversal just rewrote.
    //
    // Final review item 4 — what naming it wrongly would cost today: nothing.
    // Per 決議 4(b) `editRange` is ADVISORY. patchmap() destructures
    // oldBlocks/newBlocks/oldParts/newParts and never reads it; the kept
    // prefix/suffix is the longest common run of the two PART arrays, and
    // seeding it from an op's line range only ever made the answer worse
    // (measured in 決議 4(b): seeded kept 0 of 5, pure-parts kept 4 of 5).
    // Its one client-side use is the truthiness gate in applyRenderResult().
    // So the direction changes no plan — this is simply the correct value for
    // whenever something does start reading it.
    const editRange = discarded.op
      ? { startLine: discarded.op.startLine,
          endLine: discarded.op.startLine + discarded.op.after.length - 1,
          delta: discarded.op.before.length - discarded.op.after.length }
      : undefined;
    const okRender = await safeRerenderAll(editRange);
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
      // click opens the raw in-place source editor directly.
      //
      // F9: this branch used to re-place the caret itself, because
      // openRawEditor() put it at the END of the textarea — i.e. after the
      // closing fence, not on the blank BODY line BLOCK_SKELETONS['code']
      // (`['```', '', '```']`, see its own comment) puts there specifically
      // so typing has somewhere to land. openRawEditor() now asks
      // rawEditorSeed() (see its own comment), and for that skeleton — whose
      // middle row is '' and therefore not a bare fence — it returns the
      // same offset this branch used to compute, indexOf('\n') + 1, with the
      // value untouched. So the fix-up is deleted rather than kept as a
      // no-op that reads like it is still load-bearing.
      await openRawEditor(blockEl);
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
  // v3.1.0 §4 / 追加 2 / 追加 3: `opts.lines` supplies EXPLICIT source lines
  // instead of one of the five placeholder skeletons — the image-drop path
  // (`![](assets/…)`) and the paste path (turndown's markdown) both need to
  // land real content, and both must land it as SOURCE so it goes through
  // commitBlockInsertion()/replaceLines() like every other edit rather than
  // being spliced into the DOM behind serializeBlocks()'s back. Everything
  // else about the insert — the run-wide gate, the subtree anchor, the
  // rollback — is shared, which is the whole reason this is one extra
  // parameter and not a second insertion path.
  async function insertBlockBelow(blockEl, kind, opts) {
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
      refuseStructuralListEdit(noSourceLineInsertMessageFor(liveBlockEl));
      return;
    }
    const customLines = opts && Array.isArray(opts.lines) ? opts.lines : null;
    const newLines = customLines || BLOCK_SKELETONS[kind];
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
        refuseStructuralListEdit(noSourceLineInsertMessageFor(anchorEl));
        return;
      }
    }
    const liveBlockId = Number(anchorEl.getAttribute('data-block-id'));
    const block = blocks.find((b) => b.id === liveBlockId);
    if (!block) return;
    const result = commitBlockInsertion({ lines, blocks, stack }, liveBlockId, newLines);
    const prevLines = lines;
    lines = result.lines;
    const editRange = result.op
      ? { startLine: Math.min(result.op.startLine, result.op.endLine + 1),
          endLine: Math.max(result.op.startLine - 1, result.op.endLine),
          delta: result.op.after.length - result.op.before.length }
      : undefined;
    const okRender = await safeRerenderAll(editRange);
    if (!okRender) {
      lines = rollbackFailedRender({ lines, stack }, result, prevLines);
      return;
    }
    // §10-gap fix (review): mark the freshly-inserted block "pristine" —
    // see `pristineInsert`'s own comment for the full contract. `blocks`
    // was just reassigned by the successful rerenderAll() above, so this
    // is the server-authoritative id for the block at `newStartLine`.
    //
    // v3.1.0: a custom-lines insert is NEITHER pristine NOR focus-and-select.
    // `pristineInsert` means "a placeholder the user has not touched yet, so
    // abandoning it removes it again" — applied to a dropped image or a
    // pasted paragraph it would silently delete real content the moment the
    // user clicked elsewhere without typing. focusAndSelectAll() is wrong for
    // the same reason: it selects the block's whole content so the first
    // keystroke replaces it, which is what a ZWSP placeholder wants and what
    // a just-pasted paragraph very much does not.
    //
    // 'line' is excluded for the same reason from the other direction: both
    // are PLACEHOLDER semantics, and an <hr> has no placeholder. There is
    // nothing for focusAndSelectAll() to select (the block's content element
    // is the rule itself), and "abandoning it un-typed removes it again"
    // describes a skeleton waiting to be filled in — a thematic break is
    // finished the moment it exists.
    if (!customLines && kind !== 'line') {
      const target = blocks.find((b) => b.startLine === result.newStartLine);
      if (target) pristineInsert = { blockId: target.id };
      await focusInsertedBlock(result.newStartLine, kind);
    } else if (kind === 'line') {
      // v3.2.1: <hr> 沒有 placeholder，所以不 focusInsertedBlock()（那是上面
      // 那個 `kind !== 'line'` 既有的刻意 opt-out）。這一支只做工具列復原：把
      // toolbarBlockEl 指向新插入的 hr block，讓 bar 不要停在 render teardown
      // 留下的 4 顆。
      //
      // ⚠ 明說量測到的事，不要說希望發生的事：**caret 沒有被還原**。實測
      // （alpha / bravo / charlie，點進 bravo 再按 分隔線）這一支停用時是
      // {activeElement: BODY, enabled: 4}、啟用後是 {activeElement: BODY,
      // enabled: 15}，兩者磁碟 byte-identical。也就是說使用者按完分隔線仍然
      // 沒有游標，要再點一次 block 才能繼續打字 —— 工具列復原就是這一支交付的
      // 全部。要連 caret 一起還原是另一個決定（游標該落在錨點 block 還是 hr
      // 之後的 block），不在本 task 的範圍內。
      //
      // Final wave, M4: gated on `blockSelection` like the other four restore
      // sites. Harmless today — a ＋ 分隔線 pressed with a set standing writes
      // no declareCollapse(), so re-aiming the bar at the hr cannot contradict
      // a tinted set the way a forced caret would — but "the one site that does
      // not ask the question" is how the next divergence gets in.
      if (!blockSelection) reaimToolbarBlockAtLine(result.newStartLine);
    }
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
  //
  // v3.2.1 final wave: `anchor` is an optional OUT-PARAMETER. When given, its
  // `.line` is set to the grip block's start line as soon as that block has
  // been re-resolved against the post-switchAwayFrom() `blocks` — i.e. a
  // number that is already valid on the freshly rendered DOM. Every refusal
  // BELOW that assignment therefore leaves the caller holding a live
  // coordinate for a block the refusal did not touch.
  //
  // FIVE exits sit ABOVE it and all of them leave `.line` undefined, which is
  // the honest answer in each case (N3 — the first version of this sentence
  // said "the two exits", the same undercount M2 existed to fix, so they are
  // counted out here one by one):
  //   1. `if (!blockEl) return null`        — no gesture at all.
  //   2. `if (!ok) return null`             — switchAwayFrom()'s commit FAILED
  //      and the session it could not commit is still open with its own
  //      banner; aiming a caret anywhere would fight it.
  //   3. the dropped-gesture re-resolve     — the block is genuinely gone.
  //   4. the no-source-line refusal         — the block is there, but its range
  //      is inverted (endLine === startLine - 1), and
  //      `blocks.find(b => b.startLine === …)` would resolve some OTHER block.
  //   5. `if (!rec)` (a second DROPPED_GESTURE) — the one the undercount lost.
  //      It is NOT absorbed by 4: blockOwnsNoLine() is `!!rec && rec.endLine <
  //      rec.startLine`, so it answers FALSE when the id is absent from
  //      `blocks`, and it also answers false for a provisional block whose
  //      `data-block-id` is null (blockRecOf() returns null for both). Either
  //      way there is no record to read a startLine off.
  // See restoreAfterStructuralOp().
  async function resolveGutterOperands(blockEl, anchor) {
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
    if (blockOwnsNoLine(liveBlockEl)) { refuseStructuralListEdit(noSourceLineMessageFor(liveBlockEl)); return null; }
    const rec = blockRecOf(liveBlockEl);
    if (!rec) { showBanner(DROPPED_GESTURE_MESSAGE, null, null); return null; }
    if (anchor) anchor.line = rec.startLine;

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
      if (blockOwnsNoLine(el)) { refuseStructuralListEdit(noSourceLineMessageFor(el)); return null; }
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
  // S4 Task 5: the ⠿ drag's cross-boundary refusals, one per CAUSE.
  //
  // Task 3 raised all of these with a single provisional constant
  // (BLOCK_MOVE_LIST_SEAM_MESSAGE, '區塊搬移不能跨越清單邊界') and said THIS task
  // owned the final wording. They are three different problems with three
  // OPPOSITE remedies, so one sentence for all of them sends two thirds of
  // the users to fix the wrong end of their own gesture:
  //   * the SOURCE seam — the block cannot leave where it is, because the two
  //     lists it stands between would join into one loose run. No destination
  //     helps; the remedy is not to move it (or to move something else).
  //   * the DESTINATION seam — the block cannot go INSIDE a list. The remedy
  //     is to aim somewhere else, which is the exact opposite advice.
  //   * OUT OF RUN — a list item may only move among its own §3.8 siblings.
  //     The remedy is to stay inside its own list.
  // Naming follows the BATCH_*_MESSAGE convention above. None of the three is
  // a substring of another, of §4.3's own gate message, or of
  // BLOCK_MOVE_ORPHAN_MESSAGE below — which is what lets a test assert WHICH
  // refusal fired rather than that some banner mentioning 清單 appeared.
  const BLOCK_MOVE_SOURCE_SEAM_MESSAGE = '移走這個區塊會讓上下兩串清單接在一起，無法搬移';
  const BLOCK_MOVE_DEST_SEAM_MESSAGE = '無法把區塊放進清單項目之間';
  const BLOCK_MOVE_OUT_OF_RUN_MESSAGE = '清單項目只能在所屬清單內搬移';
  // S4 Task 7: what is LEFT of Task 4's indent refusal, and it is 14 drops out
  // of 4067. §4.5's clamp is now performed (performListItemDrop() runs the
  // removal half of the move through clampIndents()'s `{ removed: true }`),
  // which answers every SOURCE-side orphan. What no removal-clamp can reach is
  // the INSERTION half: a BATCH whose last member is SHALLOWER than the block
  // it lands before leaves that block with no parent chain above it, at the
  // NEW index, and §3.4 has no rule for that seam. MEASURED over every legal
  // indent array of length 2..6 and depth 0..3, every operand-set size and
  // every destination the run gate admits: 4067 drops, 1425 refused by Task
  // 4's predicate, 14 still unanchored after the clamp — every one of them a
  // multi-block set breaking at the block immediately after the landed set.
  // (test/editor-client.test.js re-runs that sweep and pins all three numbers.)
  //
  // RE-WORDED with the narrowing, and the wording is the point: Task 4's
  // 「搬移後子項目會失去上層項目，暫時無法搬移到這裡」 said "temporarily", which
  // was true while the capability was missing and is a lie now that it is not.
  // What is left is a DESTINATION objection with the same remedy
  // BLOCK_MOVE_DEST_SEAM_MESSAGE has — aim somewhere else — so it says which
  // end of the gesture is at fault. Still not a substring of any other refusal
  // in this file, which is what lets a test assert WHICH one fired.
  const BLOCK_MOVE_ORPHAN_MESSAGE = '落點的子項目會失去上層項目，無法搬移到這裡';
  // 轉換成's own refusals are NOT declared here. They are per block TYPE, and
  // they are the same ruling §3.7 applies to a single block's ⠿ — so they live
  // with that predicate, in BATCH_CONVERT_WITHHELD_MESSAGES above
  // toggleGutterMenu(), where the menu-hiding call site can share them. The
  // four constants above are shape-level and belong to every batch operation.

  function blockElById(id) {
    return document.querySelector('.ed-block[data-block-id="' + id + '"]');
  }

  // §3.4 rule 3's batch anchor: 「多 block 操作的錨點 = 選取集合中最小的舊
  // indent」, not the first member. Deleting `{a(0), b(1)}` anchored on a(0) is
  // right, but anchored on the FIRST member of `{b(1), …}` the following
  // segment head's bound is computed against 1 instead of 0 and a same-segment
  // sibling lands at −1 (undefined in columns).
  //
  // ⚠ This value is the anchor for the blocks BELOW the operated set — the
  // bound applyIndentClamp() re-measures them against — and NOTHING else.
  // §3.4 rule 3 also cites a batch TAB whose first member is at its ceiling as
  // a failure of first-member anchoring, but that half was superseded by the
  // 2026-08-31 D1 review: how far the set itself may move is batchIndentDelta()
  // and is the minimum head-room across ALL members, so a set holding a member
  // at its ceiling is a whole-batch no-op regardless of what its shallowest
  // member could have done alone. Do not re-derive Tab's delta from here.
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

  // ── v3.2.1 final wave: ONE landing for all four structural sinks ────────
  //
  // The v3.2.1 wrappers restored only on the SUCCESS line the body answered.
  // Measured on ddac6ce, 轉換成 → 引用 on a hard-wrapped list item (an ENABLED
  // menu item — `disabled === false`, measured) whose own burst was dirty:
  // DIV.ed-li-text ed-wys-armed / 16 enabled → BODY / 4 enabled, plus the
  // banner 「此清單含不支援的格式，無法調整結構」. The `finally` WAS reached;
  // `focusLine` was simply null there, so focusBlockAtLine() was skipped and
  // reaimToolbarBlockAtLine(null) returned on its first line — while
  // resolveGutterOperands()'s own switchAwayFrom() had already committed the
  // burst and re-rendered, which is what took the foothold away.
  //
  // Hence the second coordinate. `focusLine` is the body's SUCCESS landing and
  // is used exactly as before. `anchorLine` is resolveGutterOperands()'s live
  // grip line (see its `anchor` out-parameter) and is used ONLY when the body
  // answered nothing — a refusal, a no-op commit, or a rolled-back render.
  //
  // The foothold check on that second path is deliberate and is NOT symmetric
  // with the first. A refusal can also arrive with the user's caret still
  // exactly where they left it (a CLEAN burst goes out through
  // endBurstWithoutResolve(): no commit, no render, focus never moves —
  // measured: 轉換成 → 引用 on the same hard-wrapped li WITHOUT typing first
  // leaves DIV.ed-li-text ed-wys-armed / 16 enabled on ddac6ce). Restoring
  // unconditionally there would drag that caret to the end of the block for no
  // reason — the same mistake fix round 1 corrected in applyLinkToggle(), and
  // this is the same predicate it settled on.
  //
  // M3, the predicate divergence: the four sinks now AGREE that a rolled-back
  // render restores. Verified by reading rather than driven (a render failure
  // needs the server to fail mid-gesture): every `return false` inside
  // rerenderAll() is one of its four fetch/parse exits, all of them above the
  // call to applyRenderResult(); applyPatch() and applyFullRender() contain no
  // `return false` at all (grep: zero hits between them). So a `false` answer
  // from safeRerenderAll() means the DOM was never touched — the anchor block
  // is still on screen under the same id — while the switchAwayFrom() that ran
  // BEFORE it may already have re-rendered and reset the bar. Restoring is
  // therefore the right answer, and returning empty-handed (what
  // duplicateBlockViaMenuBody() and deleteBlockViaGutterBody() used to do on
  // `!okRender`) strands the user in exactly the I1/I2 shape. The one failure
  // this does NOT cover is a THROW inside applyPatch()/applyFullRender(),
  // caught by safeRerenderAll(): that can leave the DOM half-swapped, and
  // neither the old behaviour nor this one has an answer for it.
  function restoreAfterStructuralOp(focusLine, anchorLine) {
    // 有 blockSelection 站著時什麼都不做 —— 見 convertBlockViaMenu() 底下那段
    // 註解：強行還原 caret 會做出「底色仍說已選取、Delete 卻是死鍵」的混種狀態。
    if (blockSelection) return;
    if (focusLine != null) {
      focusBlockAtLine(focusLine, true);   // caretToEnd
      // 降級目標（quote / code）沒有可聚焦編輯面，focusBlockAtLine 會安靜
      // no-op；把 toolbarBlockEl 指回那個 block，工具列才不會塌成 4 顆。
      reaimToolbarBlockAtLine(focusLine);
      return;
    }
    if (anchorLine == null) return;
    const held = document.activeElement;
    const heldSurface = held && held.closest
      ? held.closest('.ed-wys-armed, .ed-wys-cell, .ed-raw') : null;
    if (heldSurface) {
      // ⚠ C1. "The caret never left, so there is nothing to do" was TRUE of the
      // caret and FALSE of the toolbar, and the first version of this guard
      // skipped both. The bar can be down to 4 while the caret is still sitting
      // on a live surface, and that is the ORDINARY case, not an edge one: it
      // is what happens on the PATCH render path — most commits past the
      // first page load take that route, but the FALLBACK stays reachable
      // through the whole session on its own routes, not just the first
      // render: `domMatchesLastRender()` (see its own comment) fails on a
      // block-count, dom-child-count, or per-block-id mismatch just as
      // readily as on a null `lastParts`, and `safeRerenderAll()`'s
      // no-`editRange` callers — restore()'s rangeMode exit, the per-li
      // unsupported-format refusal, commitListStructure()'s no-range exit
      // (see the wrapper's own comment just above it) — fall back by
      // contract regardless of dom state.
      //
      // INSTRUMENTED inside applyPatch() on a primed ⠿刪除 refusal, one log
      // line per step, rather than read off the source:
      //   route            PATCH
      //   focusWasInSpan?  v:true  currentBurst:true  burstElAttached:false
      //                    active:BODY
      //   afterFocusRestore   active:DIV.ed-li-text ed-wys-armed
      //                       toolbarBlockElNull:false
      //   burstSurvived    v:false  currentBurst:true
      //                    active:DIV.ed-li-text ed-wys-armed
      //   resetToolbarBlock?  willRun:true
      //   afterResetToolbarBlock  toolbarBlockElNull:true
      //   restoreAfterStructuralOp  active:DIV.ed-li-text ed-wys-armed
      //                             toolbarBlockElNull:true
      // — applyPatch()'s `focusWasInSpan` block hands focus back to the NEW
      // surface via `surface.focus()`, which dispatches focusin
      // SYNCHRONOUSLY. The first version of this comment read `currentBurst`
      // as still the OLD burst at guard time, with focusin's
      // `if (currentBurst) return;` stopping a fresh one from opening — that
      // was never measured, and does not hold on this route: `switching` is
      // truthy here (this very commit is the render switchAwayFrom() is
      // awaiting), so the handler suspends at `if (switching) await
      // switching;`, the line immediately before that guard, and cannot get
      // past it until this same call to applyPatch() returns. By then
      // applyPatch()'s OWN focus-adoption tail has already run — the
      // `if (!currentBurst && ae && contentEl.contains(ae)) { … startBurst(ae);
      // … }` further down this function, whose own comment notes undo's
      // synchronous focusin leaves that check "恆為 false" there (currentBurst
      // already set by then) — the mirror image of this route, where
      // currentBurst is null at that point and the check fires, opening a
      // fresh burst on the very surface `focus()` landed on. The suspended
      // focusin's `if (currentBurst) return;` reads THAT burst once it
      // resumes, not the pre-patch one persisting. Either way `burstSurvived`
      // is false and `resetToolbarBlock()` runs AFTER the caret was handed
      // back — that half stood correct and still does. The unprimed run of
      // the same gesture took the FALLBACK route and arrived here with
      // active:BODY, which is why the first wave's measurements never saw
      // this.
      //
      // So: do not drag the caret (it never left), but DO re-aim the bar, at
      // the block the caret is actually in rather than at `anchorLine` — those
      // are the same block on every path measured, and when they ever differ
      // the caret's own block is the honest answer.
      const blk = heldSurface.closest('.ed-block');
      if (blk && document.body.contains(blk)) { toolbarBlockEl = blk; updateToolbar(); }
      return;
    }
    focusBlockAtLine(anchorLine, true);   // caretToEnd
    reaimToolbarBlockAtLine(anchorLine);
  }

  // v3.2.1: the caret restore is a THIN WRAPPER around the conversion body so
  // that it sits at the function's EXIT and every exit reaches it. The body's
  // pre-commit refusal exits, enumerated (final wave, M2 — the sentence that
  // stood here said "three" and named three of them):
  //   1. `if (!operands) return`            — resolveGutterOperands() answered
  //                                           null (dropped gesture, no source
  //                                           line, empty/gapped/no-element
  //                                           batch)
  //   2. the mixed list/non-list refusal    (BATCH_MIXED_MESSAGE)
  //   3. the withheld-type refusal          (BATCH_CONVERT_WITHHELD_MESSAGES)
  //   4. `if (!liRun)`                      (BATCH_MULTIRUN_MESSAGE)
  //   5. `!listRunSupportsStructuralEdit()` (§4.1's run-wide gate)
  //   6. `if (!stripped.ok)`                (per-block 「此區塊的格式無法轉換」)
  // — six, not three, plus `result.op === null` (a commit that wrote nothing)
  // and the rolled-back render on the tail. Every one of them is reachable
  // from a lit ⠿ menu item, and the li → list / li → non-list / blocks → list
  // helpers this function tail-calls carry their own refusals on top.
  //
  // The body returns the operated block's post-commit start line, or undefined
  // when it refused or wrote nothing — `anchor.line` is what covers the
  // second case (see restoreAfterStructuralOp()).
  async function convertBlockViaMenu(blockEl, target) {
    let focusLine = null;
    const anchor = {};
    try {
      const out = await convertBlockViaMenuBody(blockEl, target, anchor);
      if (out != null) focusLine = out;
    } finally {
      // v3.2.1: 判準是「有沒有 blockSelection 站著」，不是 operand 數量 ——
      // 實測 operands.els.length === 1 在「有選取」與「無選取」兩態都成立，
      // 鑑別力為零。有選取時 declareCollapse() → applySelectionClasses() 已經
      // 在全新 DOM 上把 roving focus 裝回 .ed-block wrapper（9 種轉換形狀全部
      // 如此），這時強行還原 caret 會製造混種狀態：底色仍說「已選取」，Delete
      // 卻變成死鍵、Shift+↓ 降級成移動文字游標。所以有選取時什麼都不做。
      restoreAfterStructuralOp(focusLine, anchor.line);
    }
  }

  async function convertBlockViaMenuBody(blockEl, target, anchor) {
    if (!blockEl || !target) return;
    // §3.3's membership rules and the whole shared preamble — see
    // resolveGutterOperands() above. `els` is ONE contiguous span; the plan's
    // central constraint is that every path below takes that span whole rather
    // than looping, because a loop re-renders between items and invalidates
    // every id in between (the defect class recorded in this file twice: a
    // fenced block raw-edited into two paragraphs changes the BLOCK count
    // without changing the LINE count, so an id-indexed delete hit the wrong
    // block, and the same shape silently rewrote a neighbouring table).
    const operands = await resolveGutterOperands(blockEl, anchor);
    if (!operands) return;
    const els = operands.els;
    const recs = operands.recs;
    const shape = spanListKinds(els);
    if (shape.anyLi && !shape.allLi) { refuseStructuralListEdit(BATCH_MIXED_MESSAGE); return; }
    // §3.7 / §7 withhold 轉換成 from some block types ENTIRELY —
    // toggleGutterMenu() hides the item outright, and the list plus every
    // reason is in BATCH_CONVERT_WITHHELD_MESSAGES above it. This is the SAME
    // predicate, asked of a SET: none of those reasons stops applying because
    // the block happens to be one member of a span, and a batch whose grip is a
    // paragraph reaches the withheld member anyway. MEASURED, before this gate
    // existed: a table span wrote '> | A | B |' … / '- | A | B |' with its other
    // rows as continuations, an hr span wrote '- ---', an html span wrote
    // '> <div>x</div>'. Nothing is LOST in any of them (they all still lex as
    // what they were) — which is exactly why it is so quiet: the single-block ⠿
    // and the batch ⠿ give OPPOSITE answers to the same question with nothing
    // on screen saying so, the shape §3.6's 2026-08-31 「不得另寫一條」 ruling
    // exists to prevent. ⇒ REFUSE, with a banner (§3.6: 靜默不動作是缺陷), file
    // byte-identical.
    //
    // The banner names the type that is ACTUALLY in the span, not one of the
    // four shape-level messages above: BATCH_MIXED names list items vs other
    // blocks (a paragraph+table span holds no list item at all) and BATCH_GAP
    // names non-contiguity — either would name something the user's selection
    // has not done. So would telling a user with an hr in the selection that it
    // contains a table.
    //
    // SCOPED TO 轉換成. 建立副本 / 刪除 / the Delete key / Tab over a span
    // holding any of these types are measured correct and have no equivalent
    // objection — they do not need a target that can carry cells, or a marker
    // to strip — so the predicate deliberately does NOT reach
    // resolveGutterOperands(), and the T8 sweep's three withheld-type rows keep
    // those five cells as APPLYING so a widening shows up as a failure too.
    // Placed BELOW the mixed gate so no span that already refuses changes which
    // banner it gets.
    const withheld = shape.kinds.filter(convertWithheldFor)[0];
    if (withheld) {
      refuseStructuralListEdit(BATCH_CONVERT_WITHHELD_MESSAGES[withheld]);
      return;
    }

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
      return await convertListItemsType(els, liRun, recs, target);
    }
    // S2 Task 4 / S3 Task 6: li → a NON-list target. The items LEAVE the run,
    // so the span has to be rebuilt in three pieces and §4.3 rule 1's blank
    // lines put between them — the plain path below would leave the converted
    // lines mid-list with no separator and lazy continuation would swallow them
    // into the item above (measured, §4.3 rule 1).
    if (shape.allLi) {
      return await convertListItemsAway(els, liRun, recs, target);
    }
    // S2 Task 5 / S3 Task 6: non-list blocks BECOME list items, so §4.3 rule
    // 2's looseness policy applies — eat the separator to an adjacent run of
    // the same list type, or the merged list goes LOOSE and every item of it
    // degrades read-only. Same rule, same helper the li → li path above uses.
    if (convertMd.targetIsList(target)) {
      return await convertBlocksIntoList(els, recs, shape.kinds, target);
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
    const editRange = result.op
      ? { startLine: Math.min(result.op.startLine, result.op.endLine + 1),
          endLine: Math.max(result.op.startLine - 1, result.op.endLine),
          delta: result.op.after.length - result.op.before.length }
      : undefined;
    const okRender = await safeRerenderAll(editRange);
    if (!okRender) {
      lines = rollbackFailedRender({ lines, stack }, result, prevLines);
    }
    // v3.2.1 §Task 5: the caller's `focusLine`. NOT a new value and NOT a
    // pre-commit startLine — it is the very line the collapse above declares,
    // i.e. the operated span's post-commit first line. The plain path is the
    // one path that does not move it (the commit replaces the span in place).
    return first.startLine;
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
  //
  // v3.2.1: the caret restore is a THIN WRAPPER around the duplication body,
  // same shape and same reason as convertBlockViaMenu() above: the body has
  // several exits that duplicate nothing — resolveGutterOperands() answering
  // null, the mixed-list refusal, each of duplicateListItems()'s four, the
  // op === null no-op and the failed render on the non-li tail — all of them
  // reachable from a lit ⠿ menu item, and the wrapper is what makes every one
  // of them reach the restore. The body answers the ORIGINAL span's first
  // start line on success and undefined on every one of those exits.
  //
  // Final wave: "reach the restore" was true and not sufficient — with
  // `focusLine` null the restore had nothing to aim at and did nothing. The
  // refusal exits now land on `anchor.line`; see restoreAfterStructuralOp().
  //
  // 落點是【原件】而不是副本。三個理由，其中兩個是這個檔案自己已經寫下的事實：
  //  1. 一個選單項目只能有一個答案。有 blockSelection 站著時，§3.3 的塌縮把
  //     集合留在【原件】上（見 body 裡 declareCollapse() 那段註解：副本插在
  //     所有被複製的東西【下面】，所以原件的行區間原封不動）。落在副本會讓
  //     「按完 建立副本 之後手上握著什麼」取決於一個看不見的先前狀態。
  //  2. 原件的行號直接可讀，副本的行號在 li 路徑上要另外付代價。副本帶著
  //     原件的 data-block-id，所以 runLineOfBlock() 的
  //     `lineMeta.findIndex((m) => m.blockId === targetId)` 回的是【原件】那
  //     一行。這不是做不到 —— runLineOfBlock() 對沒有 id 的 block 另有一支
  //     按位置數行的 fallback，而副本在 span 裡的位置是已知的 `at + 1 + i`。
  //     代價在別的地方：那個共用的 id 正是 bystanderCarryOver() 逐位元組重播
  //     副本、而不是重新 escape 它的原因（見下方 duplicateListItems() 的註解，
  //     一個 '~5px' 不重播就會變成 '\~5px'）。所以這是一個取捨，不是一道牆。
  //  3. 畫面上沒有東西在使用者底下移動：副本長在下面，原件原地不動。
  async function duplicateBlockViaMenu(blockEl) {
    let focusLine = null;
    const anchor = {};
    try {
      const out = await duplicateBlockViaMenuBody(blockEl, anchor);
      if (out != null) focusLine = out;
    } finally {
      restoreAfterStructuralOp(focusLine, anchor.line);
    }
  }

  async function duplicateBlockViaMenuBody(blockEl, anchor) {
    // §3.3's membership rules plus the shared preamble — see
    // resolveGutterOperands(). The whole span is duplicated by ONE commit; a
    // per-member loop would re-render between items and invalidate every id in
    // between.
    const operands = await resolveGutterOperands(blockEl, anchor);
    if (!operands) return;
    const els = operands.els;
    const recs = operands.recs;
    const shape = spanListKinds(els);
    if (shape.anyLi && !shape.allLi) { refuseStructuralListEdit(BATCH_MIXED_MESSAGE); return; }

    if (shape.allLi) {
      // recs[0].startLine is unchanged by this commit — duplicateListItems()'s
      // own declareCollapse() comment is the argument: the copies land after
      // everything the set owns, and no member's line COUNT can change (a
      // multi-line target is refused, and §3.8's renumbering only ever changes
      // marker WIDTH), so the originals still occupy the range they occupied.
      return (await duplicateListItems(els, recs)) ? recs[0].startLine : undefined;
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
    const editRange = result.op
      ? { startLine: Math.min(result.op.startLine, result.op.endLine + 1),
          endLine: Math.max(result.op.startLine - 1, result.op.endLine),
          delta: result.op.after.length - result.op.before.length }
      : undefined;
    if (!(await safeRerenderAll(editRange))) {
      lines = rollbackFailedRender({ lines, stack }, result, prevLines);
      return;
    }
    // The insertion is anchored on the LAST member and lands BELOW it, so
    // ops.shiftBlocks() moved only ids greater than that one — the span's own
    // first start line is the same number before and after, which is the same
    // fact declareCollapse() above relies on.
    return first.startLine;
  }

  // The li half of 建立副本. The copy is spliced into the run's own span and the
  // WHOLE span is re-serialized over the run's line range — one commitRangeEdit,
  // therefore one undo op (§4.3: 建立副本與刪除均為單一 undo), no leading blank, and
  // §3.8's renumbering falls out of the re-serialization ('1. alpha' duplicated
  // gives '1. alpha / 2. alpha / 3. bravo', not '1. alpha / 1. alpha / 2.
  // bravo').
  //
  // v3.2.1: returns commitListStructure()'s own true/false, and false for each
  // of the four refusal exits — duplicateBlockViaMenu()'s wrapper needs to tell
  // a refusal (nothing was duplicated, the block is still where it was) apart
  // from a completed duplicate.
  async function duplicateListItems(liEls, recs) {
    // Every list batch is one run's problem — see batchRunOf().
    const run = batchRunOf(liEls);
    if (!run) { refuseStructuralListEdit(BATCH_MULTIRUN_MESSAGE); return false; }
    // §4.3's run-wide gate — 轉換／建立副本／刪除／拖曳 each make this call for
    // themselves; there is no shared helper. Its input is §3.4 rule 2's scope,
    // which is exactly what listRunOf() returns (the outermost run PLUS every
    // descendant of its members). A duplicate is NOT column-only (§4.1 修訂 2:
    // it adds the item's lines over again), so a multi-line li refuses as a
    // TARGET while remaining a perfectly good bystander — and in a batch EVERY
    // member is a target.
    if (!listRunSupportsStructuralEdit(run, liEls)) { refuseStructuralListEdit(); return false; }
    // Captured BEFORE the copy enters the span. The copy carries the
    // ORIGINAL's data-block-id — that is what makes bystanderCarryOver() replay
    // its bytes rather than re-escape them — so runRangeOfBlocks() would
    // resolve it to the original's record, and on a duplicate of the span's
    // LAST member that silently re-states the range's end line.
    const range = runRangeOfBlocks({ lines, blocks, stack }, run);
    if (!range) return false;

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
    if (at < 0) return false;

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
    return await commitListStructure(span, null, false,
      { presetRange: range, carryOver: bystanderCarryOver(span) });
  }
  // Deletes `blockEl`'s ENTIRE line range (generalizing commitListBlockRemoval()
  // — unchanged, see its own comment — to any block type, not just an
  // emptied-out list). Same resolve-first / re-query-live-block-by-id
  // precondition as insertBlockBelow() above.
  //
  // v3.2.1: the caret restore is a THIN WRAPPER around the removal body, same
  // shape as convertBlockViaMenu() above. A delete has no "back to the block it
  // operated on" — the block is gone — so the body answers the HOLE's line
  // coordinate (the removed span's own first start line) and
  // blockLineAfterRemoval() below turns that into a block that still exists.
  //
  // 有 blockSelection 站著時什麼都不做的判準與 convertBlockViaMenu() 相同，
  // 但在這條路徑上它幾乎總是讓路：批次刪除的 §3.3 塌縮是 declareCollapse(null)
  // ＝清空集合（見 body 內那段註解），render 之後 blockSelection 已經是 null。
  // 那是對的 —— 沒有集合站著就沒有「底色仍說已選取、Delete 卻是死鍵」的混種
  // 狀態可言，而使用者剛把手上唯一的著力點刪掉，更需要拿回一個。
  async function deleteBlockViaGutter(blockEl) {
    let removed = null;
    const anchor = {};
    try {
      const out = await deleteBlockViaGutterBody(blockEl, anchor);
      if (out) removed = out;
    } finally {
      // Final wave: on the refusal / rolled-back-render exits `removed` is
      // null, so the landing falls through to `anchor.line` — the block the
      // gesture named, which a refusal left exactly where it was. On the
      // SUCCESS path that block no longer exists, which is why the success
      // coordinate is blockLineAfterRemoval()'s carried neighbour and not the
      // anchor: restoreAfterStructuralOp() only consults `anchor.line` when
      // the first argument is null.
      const focusLine = removed ? blockLineAfterRemoval(removed) : null;
      // `anchor.line` is the line of the block that was just DELETED, so it is
      // offered only when the body refused. A successful delete that cannot
      // name a landing (blockLineAfterRemoval() answering null — an emptied
      // document) must restore nothing rather than aim at the hole.
      restoreAfterStructuralOp(focusLine, removed ? null : anchor.line);
    }
  }

  // The block the user is left holding once a span has been removed. Takes the
  // `{ prevLine, spanIsFirst }` the body captured BEFORE its commit:
  //
  //   prevLine    the block immediately ABOVE the removed span, or null when
  //               there is none. A PRE-commit start line, and stable across the
  //               render for ONE reason that covers every path, not a reason
  //               per path:
  //
  //                 commitRangeRemoval() and commitRangeEdit() compute the
  //                 SAME anchor — `blocks.filter((b) => b.endLine <= endLine)
  //                 .pop()`, textually identical in both — and hand it to
  //                 ops.shiftBlocks(), which moves a block only when
  //                 `b.id > editedId` (lineops.js). Ids are positional
  //                 ordinals in document order, so the block above the span has
  //                 a SMALLER id than every block inside it, and the anchor is
  //                 at least the span's last member (that member is itself in
  //                 the filtered list). The neighbour therefore fails
  //                 `b.id > editedId` whichever helper runs.
  //
  //               ⚠ Fix round 3. The sentence that stood here said the li path
  //               calls NEITHER of those helpers. That is false, and its own
  //               named example is the counter-example: commitListStructure()
  //               routes `md === ''` — no survivors, i.e. a WHOLE-RUN delete —
  //               straight into commitRangeRemoval(). Instrumented and driven
  //               rather than read: 刪除 over all three items of
  //               '- alpha / - bravo / - charlie' printed
  //                 commitRangeRemoval range=5..7 anchor=id4(7..7)
  //                 shiftBlocks editedId=4 delta=-4 movedIds=[5] untouchedIds=[0,1,2,3,4]
  //               while a partial delete of the same run printed
  //                 commitRangeEdit range=5..7 anchor=id4(7..7)
  //                 shiftBlocks editedId=4 delta=-1 movedIds=[5] untouchedIds=[0,1,2,3,4]
  //               — two different helpers, the same anchor, and in both the
  //               neighbour (id1) sits in `untouchedIds`. Five gestures were
  //               instrumented this way (whole run, middle item, first item, a
  //               non-li paragraph, and a run that is the entire document) and
  //               the neighbour was untouched in all five.
  //   spanIsFirst true when the removed span WAS the document's first block, so
  //               "no previous block" is a fact rather than a failed lookup —
  //               see deleteBlockViaGutterBody()'s own comment for why those two
  //               are not the same answer.
  //
  // 「上面那一個、游標落在它的結尾」是 Notion 的答案，也是 Backspace 併行的
  // 落點；這個編輯器的 ⠿ / 建立副本 / 轉換成 整組詞彙都是 Notion 的。
  //
  // ⚠ Fix round 1, item 2: this used to INFER the neighbour from the hole's
  // coordinate — "the largest post-render startLine strictly below it". That is
  // wrong whenever commitRangeRemoval() takes its `sl -= 1` branch (the line
  // after the span is not blank, so it absorbs the blank ABOVE instead): every
  // block BELOW the hole then moves up too, the first of them lands one line
  // ABOVE the hole's own start line, and taking the maximum picks THAT
  // deterministically over the real previous block. Driven on '…Bravo para.\n' immediately followed by
  // a block that interrupts a paragraph — an ATX heading, a list, a fenced
  // code block, an hr — the caret landed on the block BELOW the hole in all
  // four, and on the code / hr shapes (no focusable surface) it landed nowhere
  // at all. The answer is not derivable from the hole; it has to be carried.
  //
  // With `spanIsFirst`, whatever is first NOW is the block that moved up into
  // the hole — `blocks[0]`, no search needed. Answers null for a delete that
  // emptied the document, and for the unreachable "span not found" case, where
  // guessing a block is worse than restoring no caret at all.
  function blockLineAfterRemoval(removed) {
    if (removed.prevLine != null) return removed.prevLine;
    if (!removed.spanIsFirst) return null;
    return blocks.length ? blocks[0].startLine : null;
  }

  async function deleteBlockViaGutterBody(blockEl, anchor) {
    // §3.3's membership rules plus the shared preamble (identity capture,
    // switchAwayFrom(), the re-resolve after a commit that re-rendered, and the
    // no-source-line refusal) — see resolveGutterOperands(). The stake on the
    // re-resolve is highest here: an id shift used to make this delete a
    // DIFFERENT block's lines, with the ⠿ menu the user pressed pointing at a
    // block that survived.
    const operands = await resolveGutterOperands(blockEl, anchor);
    if (!operands) return;
    const els = operands.els;
    const recs = operands.recs;
    const shape = spanListKinds(els);
    if (shape.anyLi && !shape.allLi) { refuseStructuralListEdit(BATCH_MIXED_MESSAGE); return; }
    // Fix round 1, item 2: the block immediately ABOVE the span, read out of
    // the PRE-commit `blocks` and carried to the wrapper. It cannot be
    // recovered afterwards from the hole's coordinate — see
    // blockLineAfterRemoval()'s own comment for the measurement. `blocks` is in
    // document order (blockmap.js hands out a positional ordinal), so the
    // element before recs[0] is that neighbour.
    //
    // Located by OBJECT IDENTITY, and the three outcomes are kept apart on
    // purpose (fix round 2, item 3 — `at > 0` folded the third into the
    // second and would have landed the caret on the document's first block
    // with no signal at all):
    //   at > 0   there is a previous block; its start line is the landing.
    //   at === 0 the span IS the document's first block — `spanIsFirst` tells
    //            blockLineAfterRemoval() to take the moved-up fallback.
    //   at < 0   recs[0] is not in `blocks`. Unreachable as written:
    //            resolveGutterOperands() builds `recs` from this very array
    //            (blockRecOf()'s `blocks.find()` for the single case,
    //            selection.js's membersOf() `blocks.filter()` for the batch —
    //            both hand back the SAME object references), and nothing
    //            awaits between its return and this line, so `blocks` cannot
    //            have been replaced in between. If it ever becomes reachable,
    //            both flags stay false/null and the wrapper simply restores no
    //            caret and re-aims the toolbar — a bar-only degrade, never a
    //            landing on the wrong block.
    const at = blocks.indexOf(recs[0]);
    const prevLine = at > 0 ? blocks[at - 1].startLine : null;
    const spanIsFirst = at === 0;
    // Spec §6, "S1 期間的已知危險" item 1: a LIST ITEM's delete is not a line
    // splice. S1 is what first put a ⠿ on a li, and the plain range removal
    // below corrupts a list three separate ways — see
    // deleteListItemsViaGutter() for the measurements and the routing.
    if (shape.allLi) {
      return (await deleteListItemsViaGutter(els))
        ? { prevLine: prevLine, spanIsFirst: spanIsFirst } : undefined;
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
    const editRange = result.op
      ? { startLine: Math.min(result.op.startLine, result.op.endLine + 1),
          endLine: Math.max(result.op.startLine - 1, result.op.endLine),
          delta: result.op.after.length - result.op.before.length }
      : undefined;
    const okRender = await safeRerenderAll(editRange);
    if (!okRender) {
      lines = rollbackFailedRender({ lines, stack }, result, prevLines);
      return;
    }
    return { prevLine: prevLine, spanIsFirst: spanIsFirst };
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
  //
  // v3.2.1: returns commitListStructure()'s own true/false, and false for each
  // of its three refusal exits — deleteBlockViaGutter()'s wrapper needs to tell
  // a refusal (nothing was removed, the block is still where it was) apart from
  // a completed delete before it goes looking for a neighbour.
  async function deleteListItemsViaGutter(liEls) {
    // Every list batch is one run's problem — see batchRunOf().
    const run = batchRunOf(liEls);
    if (!run) { refuseStructuralListEdit(BATCH_MULTIRUN_MESSAGE); return false; }
    // §4.3's run-wide gate, whose input is §3.4 rule 2's scope — which is
    // exactly what listRunOf() returns (the outermost run PLUS every
    // descendant of its members), so the deeper runs this delete is about to
    // re-indent are covered, not just the target's own. Deleting is NOT
    // column-only: it removes the target's lines outright, so a multi-line
    // target refuses per §4.1 — and in a batch every member is a target.
    if (!listRunSupportsStructuralEdit(run, liEls)) { refuseStructuralListEdit(); return false; }
    const range = runRangeOfBlocks({ lines, blocks, stack }, run);
    if (!range) return false;
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
    return await commitListStructure(survivors, null, false,
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
    // v3.2.1 §Task 5: the caller's `focusLine` — the same post-shift line the
    // collapse just declared, never the pre-commit startLine (the merge
    // widening above moves it by exactly `shift`).
    return recs[0].startLine + shift;
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
    const editRange = result.op
      ? { startLine: Math.min(result.op.startLine, result.op.endLine + 1),
          endLine: Math.max(result.op.startLine - 1, result.op.endLine),
          delta: result.op.after.length - result.op.before.length }
      : undefined;
    if (!(await safeRerenderAll(editRange))) {
      lines = rollbackFailedRender({ lines, stack }, result, prevLines);
    }
    // v3.2.1 §Task 5: the caller's `focusLine` — the converted piece's own
    // first emitted line, which is what the collapse above declares. The
    // pre-commit startLine is wrong here: the split rebuilds the run in three
    // pieces and §4.3 rule 1's blanks move the converted half.
    return outStart;
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
    const editRange = result.op
      ? { startLine: Math.min(result.op.startLine, result.op.endLine + 1),
          endLine: Math.max(result.op.startLine - 1, result.op.endLine),
          delta: result.op.after.length - result.op.before.length }
      : undefined;
    if (!(await safeRerenderAll(editRange))) {
      lines = rollbackFailedRender({ lines, stack }, result, prevLines);
    }
    // v3.2.1 §Task 5: the caller's `focusLine` — the WIDENED range's first
    // line, which is where the merged list actually starts. `recs[0].startLine`
    // would be wrong whenever §4.3 rule 2 ate a separator above the span.
    return merged.startLine;
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
      // resurrected itself into `lines`.
      // v3.2.1: 先清 currentBurst 再寫 innerHTML。對 TABLE burst，editEl 是
      // <table> 而聚焦節點是子代 .ed-wys-cell，所以這個寫入會 detach 聚焦的
      // cell；Chromium 同步派發 focusout，而 focusout 的 table 分支只要
      // currentBurst 非 null 就會 resolveBurst() 並提交 —— 這顆按鈕的職責是
      // 丟棄，實測卻把打的字寫進磁碟。revertTableBurstAndEnd() 早就是這個
      // 順序，而它的註解正是說明「先清 currentBurst」才是它不需要抑制旗標
      // 的原因；上一版這裡的註解宣稱在鏡像那份契約，實際把它倒過來了。
      const dyingBurst = currentBurst;
      currentBurst = null;
      dyingBurst.history.dispose();
      dyingBurst.editEl.innerHTML = dyingBurst.original;
      resetSelToolbarState();
    } else {
      const ok = await switchAwayFrom();
      if (!ok) return;
    }
    // v3.1.0 修正 4: which LINES this raw edit owns is now §3.3's membership
    // question, asked through the same door every other ⠿ operation uses.
    // resolveGutterOperands() brings the whole shared preamble with it — the
    // re-resolve after a commit that re-rendered, the no-source-line refusal,
    // the emptiness and CONTIGUITY gates — which is what makes a span range
    // safe to take as `recs[0].startLine .. recs[last].endLine`: a disjoint
    // selection would refuse here rather than quietly swallowing the blocks
    // sitting in the gap. Its own switchAwayFrom() is a no-op by this point
    // (the branch above already resolved whatever was open).
    const operands = await resolveGutterOperands(blockEl);
    if (!operands) return;
    const els = operands.els;
    const recs = operands.recs;
    const liveBlockEl = els[0];
    const isLi = liveBlockEl.getAttribute('data-block-type') === 'li';
    // A single non-li block keeps the pre-v3.1.0 path exactly: no range, so
    // openRawEditor() uses the block's own record and restores by innerHTML.
    const range = (recs.length > 1 || isLi)
      ? { startLine: recs[0].startLine, endLine: recs[recs.length - 1].endLine }
      : null;
    await openRawEditor(liveBlockEl, range);
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
    dropDiscardedBurst();
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
    watchBurstForDirtyDot(editEl);
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
    // S4 Task 2: and an in-flight ⠿ block drag, for the same reason — this
    // resolution is about to commit and re-render whichever block it holds an
    // ordinal into.
    cancelBlockDrag();
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
      // Show banner + teardown + rerenderAll (file is untouched, burst never
      // wrote to `lines`) + return false — this path does NOT fall back to
      // openRawEditor().
      //
      // ⚠ v3.1.0 Ruling 13 supersedes RULING F-O for the ⠿ menu's MD 原始碼
      // (see toggleGutterMenu()), and NOT for this site. Two different
      // reasons: F-O was about the CONTAINER (a textarea cannot live inside a
      // serialized run), which 修正 4 answers by restoring through a
      // re-render; this refusal is about the CONTENT — the run's own
      // serializer has just reported it cannot round-trip this item, and
      // silently opening an editor from inside a burst resolution would be a
      // second, unasked-for gesture on top of a failed one. The banner's
      // advice ('改用原始碼編輯') is now literally actionable, which it was
      // not before: the user can reach exactly that through the ⠿ menu.
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
      const editRange = liCommitResult.op
        ? { startLine: Math.min(liCommitResult.op.startLine, liCommitResult.op.endLine + 1),
            endLine: Math.max(liCommitResult.op.startLine - 1, liCommitResult.op.endLine),
            delta: liCommitResult.op.after.length - liCommitResult.op.before.length }
        : undefined;
      const liOk = await safeRerenderAll(editRange);
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
    // v3.0.1: hand the serializer the table's CURRENT source lines so it can
    // reuse the author's own column widths instead of flattening the whole
    // table to minimal form over a one-cell edit. extractBlockSource() is the
    // same helper the raw editor prefills from, so "what the file says" has
    // exactly one definition.
    const tableBlockRec = burst.blockType === 'table'
      ? blocks.find((b) => b.id === burst.blockId) : null;
    const result = burst.blockType === 'table'
      ? tableMd.serializeTable(burst.editEl,
          tableBlockRec ? extractBlockSource(lines, tableBlockRec) : null)
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
    const editRange = commitResult.op
      ? { startLine: Math.min(commitResult.op.startLine, commitResult.op.endLine + 1),
          endLine: Math.max(commitResult.op.startLine - 1, commitResult.op.endLine),
          delta: commitResult.op.after.length - commitResult.op.before.length }
      : undefined;
    const ok = await safeRerenderAll(editRange);
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

  // ── Task 15: where a keyboard caret can actually land ────────────────────
  //
  // Hands back the element inside `blockEl` that can hold a caret, or null
  // when the block has none. It answers with the target rather than a yes/no
  // so the Tab walk out of a table takes its landing site from the same
  // measurement that decided the block was reachable at all.
  //
  // The class tokens asked for are the ones armEditables() writes: a single
  // contenteditable surface carrying 'ed-wys-armed' (its paragraph/heading
  // branch, and the armed row of its li branch), and a table's per-cell
  // surfaces carrying 'ed-wys-cell'. A block armEditables() left degraded
  // carries neither.
  //
  // Asking a class rather than calling .focus() and reading
  // document.activeElement back is not caution. Driven over a fixture whose
  // blocks were a table, a fenced code block, another table, a blockquote, an
  // image-only paragraph, a thematic break and a plain paragraph,
  // blockContentEl(blockEl).focus() left document.activeElement on BODY for
  // every one of them except the paragraph — the tables included, because
  // blockContentEl() of a table block is the <table> itself and focusing that
  // moved nothing, while focusing one of its cells does.
  //
  // querySelector cannot reach past this block into a nested item's: driven on
  // a fixture whose list nests, every '.ed-block' in the document was a direct
  // child of '.content' and none had another '.ed-block' as an ancestor.
  // md2doc.js emits a nested item's block as a SIBLING carrying 'data-indent',
  // not inside its parent's.
  function focusableSurfaceOf(blockEl) {
    if (!blockEl) return null;
    return blockEl.querySelector('.ed-wys-armed') || blockEl.querySelector('.ed-wys-cell');
  }

  // The nearest sibling block in `dir` (+1 forward, -1 back) that has one, or
  // null. Nothing tests for '.ed-block' on the way past: on the same fixture
  // every child of '.content' was one, and armEditables() only ever walks
  // '.ed-block' elements, so an element that was not one carries no surface
  // for focusableSurfaceOf() to find.
  function adjacentFocusableBlock(blockEl, dir) {
    const step = (el) => (dir > 0 ? el.nextElementSibling : el.previousElementSibling);
    for (let el = blockEl ? step(blockEl) : null; el; el = step(el)) {
      if (focusableSurfaceOf(el)) return el;
    }
    return null;
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

  // v3.0.2: computeIndentClamp() lives past this file's node early-exit
  // (module.exports at line ~509 ships the pure core only) and nothing on
  // window reaches it, so the stale-span assert added to it in v3.0.2 had
  // no way to be tested at all. This joins the other test seams on window
  // (grep `window.__edTest`) and is the only production surface that change
  // adds.
  window.__edTestClampProbe = function (spanEls, opBlockEl, opOldIndent, opts) {
    return computeIndentClamp(spanEls, opBlockEl, opOldIndent, opts);
  };

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
    const editRange = result.op
      ? { startLine: Math.min(result.op.startLine, result.op.endLine + 1),
          endLine: Math.max(result.op.startLine - 1, result.op.endLine),
          delta: result.op.after.length - result.op.before.length }
      : undefined;
    const ok = await safeRerenderAll(editRange);
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
    // T21 item 1: a pristine insert keeps the old, unrecoverable shape, and
    // that is not an oversight — discardPristineInsert() REMOVES the block, so
    // there is no surface left to restore into and nothing was typed that the
    // skeleton itself did not carry (the pristine window closes at this
    // block's first real edit; see pristineInsert's own comment).
    if (wasPristineForThisBlock) {
      burst.history.dispose();
      editEl.innerHTML = burst.original;
      currentBurst = null;
      resetSelToolbarState();
      await discardPristineInsert(); // rerenderAll() already detaches editEl — nothing left to blur()
      return;
    }
    // The paired snapshot, the same shape snapBurstIfActive() spells out for
    // the programmatic mutations that already snap on both sides of
    // themselves (grep `history.snap('` for them): the state being thrown away
    // has to be on the stack ABOVE the state being restored, or the undo lands
    // one entry short. flushTyping() is the pre half here rather than a snap()
    // — after typing, the debounce is what is holding the typed state.
    //
    // Both lines were ablated one at a time and the gesture re-driven, on the
    // paragraph, and each one alone loses the text: with flushTyping() removed,
    // Escape then Ctrl+Z left the paragraph reading 'The migration has three
    // phases.' — the typing gone and not on the document stack either; with the
    // snap() removed, the same gesture left the same text, i.e. the Ctrl+Z
    // looked like it did nothing.
    burst.history.flushTyping();
    editEl.innerHTML = burst.original;
    burst.history.snap('escape-discard');
    discardedBurst = {
      history: burst.history, editEl, blockType: burst.blockType, cellIdx: -1,
      reverted: burstBaselineHtml(editEl),
    };
    currentBurst = null;
    resetSelToolbarState();
    editEl.blur();
  }

  // The table twin of the stash above — a table burst's editEl is the whole
  // <table> and the focused node is one cell, so restoring has to put the
  // caret back in a cell, by ORDINAL among tableCellsOf() (the same handle
  // tableBurstUndo() uses, and for the same reason: the innerHTML swap
  // replaces every cell node).
  function stashDiscardedTableBurst(burst, tableEl, cellIdx, revertFn) {
    burst.history.flushTyping();
    revertFn();
    burst.history.snap('escape-discard');
    discardedBurst = {
      history: burst.history, editEl: tableEl, blockType: 'table', cellIdx,
      reverted: burstBaselineHtml(tableEl),
    };
  }

  // Ctrl+Z with no burst open, when the last thing that happened was an
  // Escape: put back what that Escape discarded and re-open the burst around
  // it, so the restored text is a live edit again — dirty dot lit, committed
  // by the next blur, and one more Ctrl+Z steps back through the same history
  // to the pre-edit baseline and then cascades out to the document stack.
  //
  // Returns false when there is nothing to restore or the stash has gone
  // stale, and the caller then does the ordinary document undo — which is
  // what an Escape that discarded NOTHING (focus a surface, press Escape
  // without editing) must also do: its history has a single entry, undo()
  // answers null, and the user's Ctrl+Z is not swallowed.
  //
  // The order — focus FIRST, then write — is load-bearing. focus() opens a
  // fresh burst whose `original` is the reverted surface, so the restored
  // text reads as an edit against it; writing first and focusing after would
  // make the restored text the new baseline, and resolveBurst()'s zero-edit
  // guard would then drop it on the way out without committing.
  function restoreDiscardedBurst() {
    const d = discardedBurst;
    discardedBurst = null;
    if (!d) return false;
    if (!document.body.contains(d.editEl) || burstBaselineHtml(d.editEl) !== d.reverted) {
      d.history.dispose();
      return false;
    }
    const typed = d.history.undo();
    if (typed === null) { d.history.dispose(); return false; }
    const isTable = d.blockType === 'table';
    const cells = isTable ? tableCellsOf(d.editEl) : [];
    const entry = isTable
      ? (cells[Math.max(0, Math.min(cells.length - 1, d.cellIdx))] || cells[0])
      : d.editEl;
    if (!entry) { d.history.dispose(); return false; }
    entry.focus();
    if (!currentBurst || currentBurst.editEl !== d.editEl) { d.history.dispose(); return false; }
    currentBurst.history.dispose();
    currentBurst.history = d.history;
    if (isTable) {
      // See suppressTableFocusout's own comment: this reassignment detaches
      // the focused cell, and Chromium fires the blur/focusout for it
      // synchronously, with the burst deliberately still live.
      const tableEl = d.editEl;
      suppressTableFocusout = true;
      try {
        tableEl.innerHTML = typed;
      } finally {
        suppressTableFocusout = false;
      }
      const newCells = tableCellsOf(tableEl);
      const target = newCells[Math.max(0, Math.min(newCells.length - 1, d.cellIdx))] || newCells[0];
      if (target) {
        currentBurst.activeCellEl = target;
        selToolbarEditEl = target;
        target.focus();
        placeCaretAtEnd(target);
      }
      return true;
    }
    d.editEl.innerHTML = typed;
    placeCaretAtEnd(d.editEl);
    return true;
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
  //
  // v3.3.0 地基 B — every caller of THIS function now snapshots on BOTH sides
  // of its mutation (the `*-pre` reasons are the pre-mutation half). The table
  // structural ops — insert row, insert column, delete row, delete column,
  // cycle column align, drag row, drag column — take the same paired shape but
  // call currentBurst.history.snap() directly; grep `history.snap('` to see
  // all of them at once. The burst history's
  // undo() pops the top and returns the entry BELOW it, so the stack top has
  // to describe the DOM as it currently stands; a lone post-mutation snap
  // makes the top "typed text + the mark" with nothing between it and the
  // block's opening state, and one Ctrl+Z therefore threw away the sentence
  // the user had just typed along with the mark. MEASURED before the fix, on
  // a paragraph typed into and then bolded from the toolbar: the DOM after
  // Ctrl+Z was "Alpha paragraph." — the whole ` typed sentence` gone.
  //
  // The extra call is free when nothing has changed: history.snap() compares
  // its capture against the stack top and pushes only on a difference, so a
  // pre-mutation snap taken when the top is already current adds no entry.
  //
  // `reason` is metadata only — createBurstHistory().snap() does not read it
  // (see lib/editor/history.js).
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
    // T21 item 2: the landing mark survives a RUN of Tabs and nothing else.
    // Shift is excluded because it is Shift+Tab's own first keydown, and
    // excluding it is what lets a backwards walk keep walking. Every other
    // key — a character, Ctrl, Escape — is the user starting to work on the
    // block they landed on, and from then on Tab means what it has always
    // meant here (heading depth / list indent). Set BEFORE the li dispatch
    // below so both surfaces see the same cleared mark.
    if (e.key !== 'Tab' && e.key !== 'Shift') currentBurst.arrivedByTab = false;
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
      // T21 item 2: a Tab that ARRIVED here keeps walking instead of editing
      // what it landed on. Task 15 gave Tab a cross-block landing but left the
      // next Tab reading as this branch, and a key being used to navigate then
      // silently rewrote the document: driven on the fixture table, pressing
      // its last body cell and then Tab four times took '### Build snippet' to
      // '######' and Ctrl+S wrote that to disk; backwards from the first
      // header cell, Shift+Tab twice outdented '  - epsilon' to '- epsilon' on
      // disk. Both were silent — a heading changing size and the title's dot
      // were the only tells.
      if (currentBurst.arrivedByTab) {
        walkToAdjacentBlockByTab(currentBurst.blockEl, e.shiftKey ? -1 : 1);
        return;
      }
      if (currentBurst.blockType === 'heading') {
        changeHeadingDepth(currentBurst.blockEl, e.shiftKey ? -1 : 1);
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        snapBurstIfActive(editEl, 'br-pre');
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
  // the same extractContents()-based pattern extractRangeInto() below uses,
  // so inline formatting (a caret mid-<strong>, say) splits cleanly instead of
  // being torn, and sharing collectLeftovers()/dropEmptied() with it so the
  // split does not leave an emptied mark behind — see inside.
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
    // Leftover marks, collected across this function's range operations before
    // they run, and dropped once the tail extraction below has run.
    // `textEl` — this item's own `.ed-li-text` — is the walk's terminator, not
    // the document root: the surface itself must survive an Enter that empties
    // it. Measured before this: Enter with the caret on the first character of
    // the <em> in `- Alpha *ital* rest` left the upper item on disk as
    // `- Alpha **`. Nothing was lost there, every character stayed in the right
    // item — the damage was the stray delimiters, which escape to `\*\*` on the
    // save after that.
    const leftovers = collectLeftovers(range, textEl);
    if (!range.collapsed) range.deleteContents(); // collapses to the start point
    const tailRange = document.createRange();
    tailRange.setStart(range.startContainer, range.startOffset);
    tailRange.setEnd(textEl, textEl.childNodes.length);
    collectLeftovers(tailRange, textEl, leftovers);
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
    // After the delete and the tail extraction have run. Dropping between them
    // would judge a mark before the extraction had emptied it — the pre-fix bug
    // again. What does NOT matter is where this sits relative to the new item
    // being built: measured in review, dropping before the tail is rehomed but
    // after those Range operations gives byte-identical output.
    dropEmptied(leftovers);
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
    const all = allBlockEls();
    const i = all.indexOf(blockEl);
    if (i < 0) return false;
    const prev = liAttrs(all[i - 1]);
    // Rule (d), narrowed (v3.0.1). The old rule was `if (self.listStart)
    // return false` — the first item of a LIST has nothing above it to nest
    // under. That over-refused: a bullet outdented to indent 0 directly
    // BELOW an ordered item is a listStart (a ul following an ol) whose
    // previous block is a perfectly good parent, and the user could never
    // indent it back. The half that still has to be refused is the one the
    // old rule was really aimed at: two list tokens the user kept apart with
    // a BLANK LINE. Indenting the second one makes listRunOf() span both,
    // and re-serializing that span swallows the blank line — a rewrite of
    // lines nobody touched, which is the one thing this editor must never do.
    // Contiguity is a fact about the FILE, so it is read off `blocks`, not
    // guessed from the DOM.
    if (self.listStart) {
      if (!prev) return false;
      const prevRec = blockRecOf(all[i - 1]);
      const selfRec = blockRecOf(blockEl);
      if (!prevRec || !selfRec) return false;
      if (prevRec.endLine + 1 !== selfRec.startLine) return false;
    }
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
  // And the one number is the MINIMUM AVAILABLE HEAD-ROOM across the members,
  // not the head-room of the shallowest one. This is review defect D1
  // (2026-08-31), MEASURED on 8486ecd: `- a / (2sp)- b / (2sp)- c / - d` with
  // b, c and d selected took its delta from d (the minimum INDENT, +1) and
  // applied it to all three; applyIndentClamp() then walked the operated
  // blocks in document order, pulled b back to its own ceiling of 1 — and
  // recomputed c's ceiling against the JUST-SETTLED b, so c was allowed to
  // stay at 2 and became b's CHILD. Only the constrained member came back.
  // That is the 「半移動」 §3.4 rule 4 forbids: 「段內相對關係必須保持」.
  //
  // So a member with no head-room floors the WHOLE set at zero. Three reasons
  // this is the branch and not "move what can move":
  //   * it is what Shift+Tab has always done — its delta is floored by a
  //     member already at indent 0, and T7 carry 5 records that as a
  //     deliberate no-op for exactly this reason;
  //   * §3.4 rule 4 requires the members' relative relationships to survive
  //     the operation, and a partial move is precisely what breaks them;
  //   * CHANGELOG v2.12.0 already promises it — "a set that cannot move as a
  //     whole does not move at all rather than half-moving".
  //
  // ⚠ §3.4 rule 3's SECOND worked example is written the other way round
  // (「批次 Tab 選 b(1)..d(0) 時第一成員 b 已在上界 ⇒ delta 0 ⇒ 整批 no-op」 is
  // listed there as a FAILURE of first-member anchoring). It cannot be
  // satisfied at the same time as rule 4 on the D1 fixture — d moving while b
  // and c are clamped IS the half-move — and the review ruled for rule 4. The
  // b(1)..d(0) set is therefore a whole-batch no-op now, and T7's scenario for
  // it was migrated with that reason in its assertion message.
  //
  // spanMinIndent() is still §3.4 rule 3's anchor VALUE for applyIndentClamp()
  // — the bound the blocks BELOW the set are re-measured against — and that
  // use is unchanged. Only the set's own movement is computed here.

  // How far ONE member may move, as a magnitude (0 or 1), never a signed
  // delta. `dir` is +1 (Tab) or -1 (Shift+Tab). The ceiling restates
  // indentListItem()'s own single-item rule, v3.0.1's narrowed list-start
  // clause included: a listStart member still refuses UNLESS the block
  // immediately before it (by file line, via blockRecOf — same contiguity
  // check, same code shape as indentListItem()'s, kept in that shape
  // deliberately so the two stay in visible agreement) is a contiguous list
  // item, in which case it has real head-room like any other item. Before
  // v3.0.1 this was unconditional (`if (self.listStart) return 0;`) —
  // batch Tab on a listStart block was refused outright, matching
  // indentListItem()'s then-unconditional refusal. Narrowing ONE of the two
  // without the other silently reintroduces the single-item defect on the
  // batch axis: a listStart item directly below a contiguous ordered item,
  // selected as part of a batch, would stay refused even though the very
  // same block indents fine on its own. The floor is outdentListItem()'s
  // (indent 0 cannot rise), untouched by this narrowing. Both read PRE-move
  // indents, which is §3.4's global convention ("the operated block's
  // indent" always means the value before the operation), and it is what
  // makes the minimum below well-defined: every member is measured against
  // the document as it stands, not against members already moved.
  function memberIndentHeadroom(el, dir) {
    const self = liAttrs(el);
    if (!self) return 0;
    if (dir < 0) return self.indent > 0 ? 1 : 0;
    const all = allBlockEls();
    const i = all.indexOf(el);
    if (i < 0) return 0;
    const prev = liAttrs(all[i - 1]);
    if (self.listStart) {
      if (!prev) return 0;
      const prevRec = blockRecOf(all[i - 1]);
      const selfRec = blockRecOf(el);
      if (!prevRec || !selfRec) return 0;
      if (prevRec.endLine + 1 !== selfRec.startLine) return 0;
    }
    const max = prev ? prev.indent + 1 : 0;
    return Math.max(0, Math.min(1, max - self.indent));
  }

  // How far the WHOLE set may move, as one SIGNED number: the smallest
  // head-room any member has, in `dir`'s direction. Zero for an empty set and
  // zero the moment one member cannot move, which is the D1 ruling.
  function batchIndentDelta(liEls, dir) {
    const els = liEls || [];
    if (!els.length) return 0;
    let room = 1;
    for (let i = 0; i < els.length; i++) {
      const r = memberIndentHeadroom(els[i], dir);
      if (r < room) room = r;
      if (room === 0) return 0;
    }
    return dir < 0 ? -room : room;
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
    const delta = batchIndentDelta(liEls, dir);
    // A zero delta is a COMPLETE no-op — nothing mutated, nothing committed,
    // file byte-identical, the set left standing — exactly what the single-item
    // Tab does at its own boundary, and NOT a refusal (no banner: the spec's
    // 「靜默不動作是缺陷」 is about refusals, and this is the documented
    // boundary answer §3.5 gives for a set at its ceiling). On §3.5's b+c
    // example this IS the right answer, and it is the answer per-item maths
    // cannot give; after D1 it is also the answer whenever ANY member is at
    // its ceiling, which is what keeps the members' relative order intact.
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
      //
      // v3.0.1 (review round 1 follow-up): `run` above is batchRunOf()'s
      // PRE-mutation snapshot — the exact same staleness handleLiKeydown()'s
      // single-item Tab branch had before its own v3.0.1 fix (see that
      // call's comment). For a single-member batch on a listStart item whose
      // ceiling memberIndentHeadroom() has just narrowed (a bullet directly
      // below a contiguous ordered item), the pre-mutation run is `[liEls[0]]`
      // alone — batchRunOf() never walked backward past the list-start
      // boundary, because before this fix nothing could ever cross it. With
      // no anchor IN the span, applyIndentClamp()'s rule 1 has nothing to
      // bound the indent the forEach above just wrote against, and clamps it
      // straight back to 0 — silently undoing the write, MEASURED directly:
      // narrowing memberIndentHeadroom() alone left the covering test RED.
      // A FRESH listRunOf(liEls[0]) call here — taken after the write above —
      // walks back from the NEW indent and finds the real parent, exactly
      // like the post-mutation `liveRun = listRunOf(liEls[0])` a few lines
      // below (the COMMIT span) already does; using the same fresh call for
      // the clamp keeps the two consistent, same reasoning as
      // handleLiKeydown()'s Tab branch. Provably identical to the old stale
      // `run` for every case where no member was ever a list-start
      // (listRunOf() slices by INDEX RANGE, and neither the range's
      // start/end index nor the elements between them shift when only
      // already-run-member indents change).
      applyIndentClamp(listRunOf(liEls[0]), liEls, oldIndent);
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
    const editRange = result.op
      ? { startLine: Math.min(result.op.startLine, result.op.endLine + 1),
          endLine: Math.max(result.op.startLine - 1, result.op.endLine),
          delta: result.op.after.length - result.op.before.length }
      : undefined;
    const okRender = await safeRerenderAll(editRange);
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

  // v3.1.0 §4: the toolbar's ⇥ / ⇤ buttons. A ZERO-ARGUMENT commit wrapper,
  // placed beside tabSelection(dir) above because it is the same shape of
  // thing: a gesture that is not a keystroke, driving a mutation whose only
  // existing entry point wanted a KeyboardEvent.
  //
  // Why this function has to exist at all: indentListItem()/outdentListItem()
  // (further up) only ever write `data-indent` on the DOM and return a
  // boolean. They never touch `lines`, never push an undo op, never
  // re-render. Wiring a toolbar button straight to either of them produces a
  // list that visibly re-indents and then snaps back on the next render, with
  // the file byte-identical throughout. Everything that makes Tab a real edit
  // lives in handleLiKeydown()'s Tab branch — the run-wide gate, the mutation
  // under mutateListRun()'s focusout suppression, the indent clamp, the
  // bystander carry-over and the one-op commit — so that is what is
  // reproduced here, in the same order, with `e.shiftKey` replaced by `dir`.
  //
  // `caretLiBlock()` is zero-argument (it reads window.getSelection()), which
  // is what makes an editEl-free wrapper possible: the toolbar has no event
  // target inside the run, only a live caret — and the caret is the right
  // answer anyway, since a run has one editable surface per item.
  //
  // dir > 0 indents, dir < 0 outdents.
  async function indentCaretLi(dir) {
    const li = caretLiBlock();
    if (!li) return;
    let run = listRunOf(li);
    if (!run.length) return;
    // `columnOnly`: an indent change rewrites nothing but leading columns, so
    // a hard-wrapped item is allowed to be the target — same reading, and the
    // same measurement, as the Tab branch this mirrors.
    if (!listRunSupportsStructuralEdit(run, li, { columnOnly: true })) {
      refuseStructuralListEdit();
      return;
    }
    const oldIndent = Number(li.getAttribute('data-indent')) || 0;
    const changed = mutateListRun(() => {
      if (!(dir < 0 ? outdentListItem(li) : indentListItem(li))) return false;
      // v3.0.1, carried over VERBATIM and deliberately: the clamp must read a
      // FRESH listRunOf(li) — taken after the write above — not the
      // pre-mutation `run` captured outside. indentListItem() can move a
      // rule-(d) list-start item whose pre-mutation run is `[li]` alone; with
      // no anchor in the span, applyIndentClamp()'s rule 1 has nothing to
      // bound the new indent against and clamps it straight back to 0,
      // silently undoing the write. See handleLiKeydown()'s own copy of this
      // note for the full derivation.
      applyIndentClamp(listRunOf(li), li, oldIndent);
      return true;
    });
    if (!changed) return; // at the boundary: nothing mutated, nothing committed
    run = listRunOf(li);
    // Column-only: nothing's CONTENT moved, so every block in the span — the
    // target included — is a bystander whose source bytes come back
    // untouched. Built once and shared with runLineOfBlock() below.
    const carry = bystanderCarryOver(run, null);
    await commitListStructure(run, runLineOfBlock(run, li, carry), true, { carryOver: carry });
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
    // Review recommendation 5: mark it, so the next SUCCESSFUL render clears
    // it (dismissRefusalBanner(), called from rerenderAll()). Set after the
    // showBanner() call, which resets the flag for every other caller.
    activeBannerIsRefusal = true;
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
    // Load-bearing, not incidental: `li` is the item the caret is IN, and
    // removeListItem() detaches exactly that node — the one Chromium
    // currently has focus on — from the DOM. Drop this suppression span and
    // that detach's synchronous blur/focusout reaches resolveBurst() mid-
    // mutation, with the run still in its PRE-removal shape (see
    // `suppressLiFocusout`'s own comment above: "observed: '- <br>' written
    // back for an item that had just been deleted"). That costs an extra
    // resolveBurst({type:'li'}) committing a run nobody meant to commit, on
    // top of the one commitListStructure() below already performs — one
    // keystroke becomes two undo ops, and the second undo writes that stray
    // '- <br>' to disk. Do not fold this into a "the node barely moved"
    // cleanup.
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
    // T21 item 2, the li half — see handleBurstKeydown()'s Tab branch. Ahead
    // of the run gates below because a walk needs no run: it is leaving.
    if (e.key === 'Tab' && currentBurst && currentBurst.arrivedByTab) {
      walkToAdjacentBlockByTab(currentBurst.blockEl, e.shiftKey ? -1 : 1);
      return true;
    }
    // Row 2: Shift+Enter is an in-block line break, not a structural change.
    if (e.key === 'Enter' && e.shiftKey) {
      snapBurstIfActive(editEl, 'br-pre');
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
      // INERT here: indentListItem()/outdentListItem() are attribute-only in
      // this flat model (setBlockIndent() on `li` and its subtree — see the
      // note on outdentListItem() further down this function) and never
      // detach the focused node, so the synchronous blur/focusout this span
      // exists to catch never fires, whether or not the flag is set.
      // Measured: primed a burst on `li`, ran this mutation, and no
      // focusout fired — `document.activeElement` stayed put and the node
      // never left the document. Kept for uniformity with the load-bearing
      // span in convertEmptyTopLevelLiToParagraph() above, not because this
      // one guards anything measured.
      const changed = mutateListRun(() => {
        if (!(e.shiftKey ? outdentListItem(li) : indentListItem(li))) return false;
        // v3.0.1: `run` above is a PRE-mutation snapshot, captured while `li`
        // still had its OLD indent. That is fine for outdentListItem() — the
        // clamp's model rereads every element's CURRENT data-indent off the
        // DOM, so it self-corrects regardless of which elements the snapshot
        // names — but indentListItem() can now move a rule-(d) list-start
        // item (a bullet directly below an ordered item, say) whose own
        // pre-mutation run is `[li]` alone: nothing shallower ever preceded
        // it, because runBlocksOf() stops at a list-start by design. With no
        // anchor IN the span, applyIndentClamp()'s rule 1 has nothing to
        // bound the indent this call just wrote against, and clamps it
        // straight back to 0 — silently undoing the write. A FRESH
        // listRunOf(li) call here — taken after the write above — walks back
        // from li's NEW indent and finds the real parent, exactly like the
        // post-mutation `run = listRunOf(li)` a few lines below (the COMMIT
        // span) already does; using the same fresh call for the clamp keeps
        // the two consistent. Provably identical to the old stale `run` for
        // every case where li was never a list-start (listRunOf() slices by
        // INDEX RANGE, and neither the range's start/end index nor the
        // elements between them shift when only li's own indent changes).
        applyIndentClamp(listRunOf(li), li, oldIndent);
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
      // INERT here too, same measurement as the Tab span above:
      // outdentListItem() is attribute-only and never detaches the focused
      // node.
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
        // liSurfaceHoldsNothing() — and only once the outdent above has
        // actually happened, since a refused press must leave the DOM
        // byte-identical.
        //
        // ⚠ Final wave, I4. The sentence that stood here said this innerHTML
        // assignment is itself a reason the write must sit inside
        // mutateListRun()'s suppression span — "an innerHTML assignment on the
        // focused node triggers the very same Chromium unfocus quirk". MEASURED
        // false, and its own premise is the counter-example: `textEl` IS the
        // focused node, and writing its innerHTML replaces only its SUBTREE —
        // the element itself is never detached. Control experiment, driven in a
        // real page: focus a `.ed-li-text`, count focusout on it and on
        // `document` (capture), then assign `''` — 0 focusout, 0 blur,
        // `document.activeElement` still that same node, node still in the
        // document.
        //
        // What the span IS for is written at `suppressLiFocusout`'s own
        // declaration: a structural list key can move, split or REMOVE the
        // focused block, and Chromium's synchronous unfocus then reaches
        // resolveBurst() with the run still in its pre-mutation shape. This
        // assignment is inside the span because it is part of the same
        // mutation, not because it contributes a focusout of its own.
        //
        // No claim is made here about WHICH callee needs it, and deliberately
        // not about outdentListItem(): that function is attribute-only in this
        // flat model — it calls setBlockIndent() on the block and its subtree
        // (`data-indent` + a CSS custom property) and re-parents nothing, so it
        // is not the answer either.
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
    // INERT here too, same measurement as the Tab span above:
    // splitListItemAtCaret() keeps `li` itself in place (only `newLi` is a
    // freshly-inserted sibling) and never touches the focused node's
    // attachment.
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
    dropDiscardedBurst();
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
    watchBurstForDirtyDot(tableEl);
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
    // Captured HERE, while the pressed cell is still in the document (the
    // delegated focusin listener that calls this passes its own `e.target`),
    // for the stale recovery further down — see its comment for what each
    // handle is for and what was measured about it. A commit resolved by the
    // `await` below rebinds `blocks` to the new render's list
    // (applyFullRender()'s own first lines), so a startLine belonging to the
    // pre-commit list has to be read before it.
    const pressedRowEl = cellEl.parentElement;
    const pressedRow = pressedRowEl ? allRowsOf(tableEl).indexOf(pressedRowEl) : -1;
    const pressedCol = pressedRowEl
      ? Array.prototype.indexOf.call(pressedRowEl.cells, cellEl) : -1;
    const blockNum = blockEl ? Number(blockEl.getAttribute('data-block-id')) : null;
    const blockAtPress = blockNum != null ? blocks.find((b) => b.id === blockNum) : null;
    const pressedStartLine = blockAtPress ? blockAtPress.startLine : null;
    const pressedIdentity = tableIdentityOf(tableEl);
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
      // Reached when the pressed cell's node is gone from the document by the
      // time this focusin resumes. Instrumented on the F8 fixture (a
      // paragraph left dirty, then a press into the table): the mousedown's
      // focusout resolves that paragraph, and applyRenderResult()'s patch
      // gate consults domMatchesLastRender(), which reports false while
      // `lastParts` is still null — as it is until a render has landed — so
      // the render goes to applyFullRender(), whose `contentEl.innerHTML =`
      // rewrites .content wholesale. A probe around the `await` above
      // recorded route ["applyFullRender"] together with
      // `document.body.contains(cellEl)` false, on each reproduction driven.
      // Recovering the cell as `tableCellsOf(...)[0]` therefore dropped the
      // caret into the header cell rather than the pressed one; driven to
      // disk, a `QQ` typed straight after the press came back as
      // `| QQA | B |`.
      //
      // What DOES come back after that rewrite, measured across the same
      // commit: the pressed cell's (row, col) seat in its table. Naming the
      // table again is the other half, and the handle this recovery already
      // used was driven alongside the one ensureTableBurstOpen() re-resolves
      // through — neither subsumes the other:
      //   a raw edit adding a LINE ahead of the table, block count unchanged
      //     -> data-block-id still names this table; startLine names the
      //        paragraph that grew
      //   a raw edit adding a BLOCK ahead of the table, line count unchanged
      //     -> data-block-id names a renumbered neighbour; startLine still
      //        names this table
      // so the id is asked first and the startLine handle answers when it
      // cannot, for the reason ensureTableBurstOpen()'s S1 comment writes
      // down. Whichever one answers, tableIdentityOf() has to agree before a
      // caret is placed: a commit that renumbers ids can leave the captured
      // id pointing at a DIFFERENT table, and the same (row, col) seat
      // inside THAT table is one the user never pressed — driven on a
      // fixture holding a second table, dropping this check landed the caret
      // in the neighbour's body cell. A commit that moves this table's start
      // line AND renumbers its id leaves nothing for either handle to
      // resolve; no caret is then placed, the conservative half of the trade
      // ensureTableBurstOpen() already takes.
      const liveTableFrom = (candidateBlockEl) => {
        const t = candidateBlockEl ? blockContentEl(candidateBlockEl) : null;
        if (!t || !t.classList || !t.classList.contains('ed-wys-table')) return null;
        if (pressedIdentity == null || tableIdentityOf(t) !== pressedIdentity) return null;
        return t;
      };
      const liveTableEl =
        liveTableFrom(blockId != null
          ? document.querySelector('.ed-block[data-block-id="' + blockId + '"]') : null) ||
        liveTableFrom(pressedStartLine != null ? blockElAtLine(pressedStartLine) : null);
      const liveRowEl = (liveTableEl && pressedRow >= 0)
        ? allRowsOf(liveTableEl)[pressedRow] : null;
      liveCellEl = (liveRowEl && pressedCol >= 0) ? liveRowEl.cells[pressedCol] : null;
      if (!liveCellEl || !liveCellEl.classList.contains('ed-wys-cell')) return;
      liveCellEl.focus();
      return;
    }
    startTableBurst(liveCellEl);
  }

  // Tab / Shift+Tab inside a table. Two things were measured on a table whose
  // cells were A, B, c1 and c2, before this version, and both are fixed here:
  //
  //   * At either end of the cell list the target index was CLAMPED, so the
  //     press resolved back to the cell it started from. The handler still ran
  //     and its preventDefault() was readable in the bubble phase, so the
  //     browser's own Tab traversal was consumed as well. Pressed in c2 it
  //     left document.activeElement on that same TD, the block count and the
  //     file's bytes unchanged, and the only visible effect was the caret
  //     moving to the end of the cell it was already in. Shift+Tab in A was
  //     the same dead key.
  //   * The landing placed a COLLAPSED caret at the end of the target cell, so
  //     typing straight after a Tab appended rather than replaced: Tab out of
  //     A and then typing ZZ left B holding 'BZZ'.
  //
  // Now a step within the table SELECTS the target cell's contents, which is
  // what makes "Tab, then type" a replacement the way a spreadsheet does, and
  // a step off either end leaves the table — leaveTableByTab() below.
  //
  // Tab does not add a row past the last cell. That is the product's answer,
  // not something missing here.
  function moveActiveTableCell(cellEl, delta) {
    const tableEl = cellEl.closest('table');
    const cells = tableCellsOf(tableEl);
    const next = cells.indexOf(cellEl) + delta;
    if (next >= 0 && next < cells.length) {
      const target = cells[next];
      target.focus();
      selectSurfaceContents(target);
      // Keep the floating .ed-seltb down over exactly this selection — see
      // `tabSelectedCellEl`'s own comment for what releases it again.
      tabSelectedCellEl = target;
      return;
    }
    leaveTableByTab(tableEl, delta);
  }

  // Tab off either end of a table: to the nearest block in that direction that
  // focusableSurfaceOf() finds a surface in, degraded blocks stepped over.
  //
  // The burst is resolved FIRST, rather than focusing the destination and
  // leaving the resulting focusout to do it. Focus leaving the table is itself
  // what ends a table burst, and a burst carrying an edit ends by committing
  // and re-rendering, which rewrites '.content' wholesale. Driven on a table
  // left dirty when the press lands, watching focusin/focusout for that one
  // press:
  //
  //   resolve first (this shape) — focusout on the cell, then a single
  //     focusin, on the destination this function re-resolved. The element
  //     captured before the resolution was gone from the document by then;
  //     ablating the re-resolution and focusing THAT captured node instead
  //     landed the caret on no editable surface — document.activeElement came
  //     back carrying no class and the whole page as its text.
  //   focus first — focusout on the cell, focusin on the destination,
  //     focusout on it again as the render detaches it, focusin on its
  //     replacement. The caret does arrive, by a longer road and through a
  //     node that is being taken apart underneath it.
  //
  // Resolving first and re-resolving afterwards is also the shape
  // ensureTableBurstOpen() above already uses against the same hazard.
  //
  // captureBlockIdentity() / reresolveBlockEl() is the handle, for the reason
  // their own comment writes down: blockmap.js renumbers ids from zero on
  // every render, so a captured id can name the destination's NEIGHBOUR after
  // a commit that changed the block count, and the start line plus the block's
  // own source lines is what proves the block sitting there afterwards is the
  // one the press was aimed at. When it cannot be proven nothing is focused —
  // the conservative half of the trade the gutter gestures already take.
  //
  // Nothing is focused when no such block exists either, and the caller's
  // preventDefault() still stands over that press. Handing it back to the
  // browser is not the alternative: buildGutterHandle() sets tabindex="-1" on
  // the per-block chrome precisely because a browser-run Tab walks into it,
  // and the document-level Tab branch near the bottom of this file already
  // treats a Tab from inside an '.ed-block' as a deliberate silent no-op.
  // T21 item 2 split this in two. The body below is the LANDING, and it is no
  // longer only a table's exit: once a Tab has moved the caret across a block
  // boundary, the next Tab has to be able to move it again, so the block it
  // just landed on calls the same function. leaveTableByTab() underneath is
  // the table's own name for it, kept because the whole comment above is
  // written about that gesture.
  //
  // `arrivedByTab` is the landing's mark on the burst it just opened, and the
  // burst object is the right place for it: bursts are per focus, so the mark
  // cannot outlive the surface it describes, and clicking into some other
  // block opens a burst without it. handleBurstKeydown()/handleLiKeydown()
  // read it to decide that a further Tab means "move on" rather than "edit
  // this" — see the measurement in handleBurstKeydown()'s Tab branch.
  //
  // The mark is set for whatever kind of burst the landing opened, and only
  // the paragraph/heading/li Tab branches ever READ it: a table cell's Tab is
  // owned by handleTableCellKeydown(), which already means "move on" (to the
  // next cell, and off the end back through here). Scoping the WRITE to
  // non-table destinations as well was tried and dropped — ablating that
  // condition alone changed no measured behaviour (the row that Tabs out of
  // one table, into the next, and then on to its second cell stayed green
  // either way), so it was a condition no test could speak for.
  async function walkToAdjacentBlockByTab(fromBlockEl, delta) {
    const destBlockEl = adjacentFocusableBlock(fromBlockEl, delta);
    if (!destBlockEl) return;
    const identity = captureBlockIdentity(destBlockEl);
    const ok = await switchAwayFrom();
    if (!ok) return;
    const liveBlockEl = document.body.contains(destBlockEl)
      ? destBlockEl : reresolveBlockEl(identity);
    const surface = focusableSurfaceOf(liveBlockEl);
    if (!surface) return;
    surface.focus();
    // A caret at the start of the destination, not a selection of the whole
    // of it: selecting a paragraph the user only tabbed past would put every
    // word of it one keystroke from being replaced.
    placeCaretAtSurfaceStart(surface);
    if (currentBurst) currentBurst.arrivedByTab = true;
  }

  async function leaveTableByTab(tableEl, delta) {
    await walkToAdjacentBlockByTab(tableEl ? tableEl.closest('.ed-block') : null, delta);
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
    // T21 item 1: same split as revertBurstAndEnd() above — a pristine insert
    // is about to lose its whole block, so nothing is stashed for it.
    const cells = tableCellsOf(tableEl);
    const cellIdx = cells.indexOf(burst.activeCellEl || cellEl);
    if (wasPristineForThisBlock) burst.history.dispose();
    currentBurst = null;
    resetSelToolbarState();
    hideTableInsertBubbles();
    hideTableGrips();
    hideTableEdgeMenu();
    cancelTeDrag();
    if (wasPristineForThisBlock) {
      tableEl.innerHTML = burst.original;
      await discardPristineInsert();
      return;
    }
    stashDiscardedTableBurst(burst, tableEl, cellIdx, () => {
      tableEl.innerHTML = burst.original;
    });
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
      snapBurstIfActive(tableEl, 'br-pre');
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
    // The two delimiters are written as ESCAPES, not as literal control
    // bytes. They used to be literal, which made grep classify this whole
    // 9643-line file as binary and SILENTLY TRUNCATE its output — a real
    // investigation was misled by it. The runtime value is identical.
    return allRowsOf(tableEl).length + '\x01' +
      Array.prototype.slice.call(headerRow.cells).map((c) => c.textContent).join('\x00');
  }
  // v3.4.0 §2: `forDrag` narrows the policy above for the ROW/COLUMN DRAG
  // callers only (performRowDrop()/performColDrop() below) — every other
  // caller (the insert-row/insert-column hover bubbles, cycleAlign(),
  // deleteRow/deleteColumn's own callers) keeps focusing cells[0] with a
  // normal, scrolling focus() exactly as before, unchanged.
  //
  // Why a drag needs a DIFFERENT policy, not just a smaller guard elsewhere:
  // a drag gesture never had a focused cell of its own, yet THIS function's
  // own `cell.focus()` a few lines down is what actually opens the burst in
  // the first place — the delegated focusin listener
  // (handleTableCellFocusIn() above) is the ONLY path that calls
  // startTableBurst(), so the call can't simply be skipped for a drag; the
  // burst would never open at all, and every existing row/column drag
  // scenario that asserts "a drop auto-starts a burst" (a cell must be
  // focused afterward) would break. What can change for a drag, since it
  // never had an opinion about WHICH cell should end up focused, is WHICH
  // cell this picks and HOW it focuses it:
  //   - `{ preventScroll: true }` — a plain focus() with no options scrolls
  //     its target into view. A stack-traced probe (measured, not guessed —
  //     see performRowDrop()'s own comment below for the full write-up)
  //     found this is only HALF the "drag jumps to the header" symptom's
  //     origin: restoreTableFocus() (below) always re-resolves and
  //     re-focuses the SAME cell this call already focused — there is no
  //     way to skip that second focus() by checking an index, since the
  //     index it would check is always valid by the time it's read (same
  //     comment). So restoreTableFocus()'s own focus() ALSO needs
  //     `preventScroll: true` — this call alone was never going to be
  //     enough.
  //   - the first BODY cell (a <td>), not cells[0] (the header <th>) — a
  //     table drag's own regression scenario asserts the resulting active
  //     element is not a header cell. Every cell (header or body) already
  //     carries 'ed-wys-cell' (armEditables()'s table branch, arm time), so
  //     a body cell satisfies "a drop auto-starts a burst" exactly as well
  //     as the header did — and restoreTableFocus() re-focuses whichever
  //     cell THIS picks, so picking a body cell here is what keeps its own
  //     re-focus off the header too. Falls back to cells[0] only when the
  //     table has no body row at all (nothing to drag in that case anyway).
  async function ensureTableBurstOpen(tableEl, forDrag) {
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
    const cells = tableCellsOf(liveTableEl);
    const cell = forDrag ? (cells.find((c) => c.tagName !== 'TH') || cells[0]) : cells[0];
    if (!cell) return null;
    if (forDrag) cell.focus({ preventScroll: true }); else cell.focus();
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
    currentBurst.history.snap('insert-col-pre');
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
    // above — the table element reference has to be re-resolved.
    //
    // ⚠ RETRACTION. An earlier revision of this comment went on to say that
    // `afterRowIndex`, being a plain integer, stays valid across that swap.
    // Ruling T3-9 measured the opposite and parked the fix in v3.4.0: the
    // index names a row of the table the bubble was positioned against, and
    // after a handover it is read against a different element's row list, so
    // `bodyRowsOf(liveTableEl)[afterRowIndex]` comes back `undefined`,
    // `afterRow` is falsy, and insertRow() below takes its
    // `tbody.insertBefore(newRow, tbody.firstChild)` branch — the same branch
    // `afterRowIndex: -1` uses deliberately. The row lands at the TOP of the
    // table rather than the gesture being dropped. Nothing here guards it yet.
    // Task 14's hide-on-approach fix (see updateTableInsertBubbles() below)
    // made this bubble reliably pressable, which widened the exposure of that
    // deferred defect rather than narrowing it.
    const liveTableEl = await ensureTableBurstOpen(tableEl);
    if (!liveTableEl) return;
    const afterRow = afterRowIndex >= 0 ? bodyRowsOf(liveTableEl)[afterRowIndex] : null;
    currentBurst.history.snap('insert-row-pre');
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
    // v3.3.0 F7: a raised bubble, and the row grip, are `position: fixed`
    // overlays on document.body painted OVER the very band that raises the
    // bubble — the bubble is centred on the boundary it offers and the row
    // grip straddles the table's left border — so a pointer reaching for a
    // bubble arrives on one of them and `target` stops being a table
    // descendant. Resolving the table from `target` alone then hides the
    // bubble the pointer is reaching for, the next mousemove finds a cell
    // again and raises it, and the bubble flickers along the whole
    // approach; whether it is up when the press lands comes down to where
    // the last move happened to fall. MEASURED on this repo's puppeteer,
    // walking the pointer horizontally across the row bubble's own band: the
    // mousemove targets alternated between the bubble and whatever is
    // painted under it, and the bubble went hidden on the alternating
    // events where the bubble itself was the target. So fall back to the table
    // this hover already resolved, and leave the proximity tests below to
    // decide visibility from x/y exactly as they do for any other pointer
    // position, rather than freezing whatever was last shown.
    //
    // The `.ed-block::before` corridor needs no entry here: it is a
    // pseudo-element OF the block, so a hit inside it reports the block as
    // `target` and the closest() above already matches (MEASURED at
    // x = tableLeft - 10: `DIV.ed-block`). That is why nothing in this fix
    // touches its `pointer-events`, which lib/md2doc.js documents as
    // deliberately absent — being hit-testable is what that corridor is for.
    // That "for" is this fix's hit-test above, not the corridor's ONLY job:
    // the same rule also carries the block's own ⠿/＋ gutter :hover reveal
    // (lib/md2doc.js's own comment on `.ed-block::before` — "deliberately
    // NOT pointer-events: none: that would stop it being hit-tested, which
    // is the entire mechanism"). This fix measured that the hit-test still
    // resolves to the block for the bubble; it did not re-measure whether
    // the gutter's hover reveal still behaves as before, so setting
    // `pointer-events: none` here to simplify the table-bubble case remains
    // untried, not merely undesirable.
    //
    // The COLUMN grip is deliberately absent from the list below: it is
    // anchored on the header cell's CENTRE while the column bubble's band
    // hugs that same cell's RIGHT edge. MEASURED on the fixture used to
    // drive this fix, the column grip spanned x [639.3, 667.3] while the
    // header cells' right edges sat at 894 and 1375.5 — the grip's rect
    // never reaches either band, so a guard for it here is one no test on
    // this fixture could hold down.
    let tableEl = blockEl ? blockContentEl(blockEl) : null;
    if (!tableEl && target && target.closest &&
      target.closest('.ed-tb-insert, .ed-te-grip-row')) {
      tableEl = hoveredInsertTableEl;
    }
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
  // contenteditable cell, even though the row grip visually overlaps one
  // (since §4.2 conflict 2 landed in S4 T1 it sits ENTIRELY inside the first
  // column, within that cell's own widened left padding; see the geometry
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
  // wraps it in `suppressTableFocusout` — one of the sites that set that flag,
  // alongside tableBurstUndo(), tableBurstRedo(), performColDrop() and
  // restoreDiscardedBurst()'s table branch; test/editor-client.test.js pins
  // the set and audits each one for its try/finally — and puts focus back
  // explicitly via restoreTableFocus(). An earlier
  // revision moved the <tr> with a plain `insertBefore()`, which reparents
  // in one synchronous step, never blurs, and needed no guard — the header
  // promotion requirement is what retired that. The menu's delete ops (which
  // DO remove nodes) sidestep the same hazard a different way — see
  // refocusAwayFromColumn()/refocusAwayFromRow() below.
  //
  // Both the menu (delete/align) and the drag's DOM move are burst
  // mutations: ensureTableBurstOpen() (Task 5, above) auto-starts a burst
  // on this table if none is open yet, then the op snapshots the live DOM
  // (`snap('<reason>-pre')`), mutates it, and snapshots again — committed on
  // table-leave like any other table edit. The pre-snapshot is v3.3.0 地基 B;
  // see snapBurstIfActive()'s comment for why a lone post-snapshot loses the
  // text the user typed into a cell just before the structural edit. The
  // structural ops it names (insert/delete row and column, cycle column align,
  // drag row and column) call currentBurst.history.snap() DIRECTLY rather than
  // through snapBurstIfActive(), which is why they were not in that function's
  // call-site inventory — the guard snapBurstIfActive() applies is already
  // supplied here by ensureTableBurstOpen()'s non-null return, which is
  // itself conditioned on `currentBurst.editEl === liveTableEl`. Refusal banners reuse the exact wording the retired
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

  // v3.2.1 fix round 1: same idiom as `suppressTableFocusout`/
  // `suppressLiFocusout` above — a flag set for the exact synchronous-ish
  // span of one operation that would otherwise be torn down by a listener
  // reacting to a side effect THAT OPERATION ITSELF triggers. Here:
  // runCycleAlign()'s `ensureTableBurstOpen()` can call a cell's `.focus()`,
  // which can scroll the page for real — and the resulting 'scroll' event
  // is asynchronous relative to the focus() call (measured: it does not
  // reliably land before runCycleAlign()'s own code resumes after the
  // `await`), so a plain "check teMenuKind again afterward" re-open would
  // race it and sometimes miss. onAnyScroll() checks this flag before
  // calling hideTableEdgeMenu() so the menu's open state is never torn down
  // in the first place during that span, whichever tick the event lands on.
  let suppressEdgeMenuAutoHide = false;

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

  // The column menu's vertical placement, shared by showColumnMenu() and by
  // runCycleAlign()'s reposition so the two can never drift apart. Above the
  // header cell by default, BELOW it when there is not enough room above —
  // the same "no room above, go below" fallback positionSelToolbar() uses.
  //
  // The floor is `.ed-toolbar`'s height, not zero. That toolbar is
  // `position: fixed` at the top of the viewport at z-index 101 and this menu
  // is at 12, so a menu placed inside that band is painted UNDER it and stops
  // being clickable while still reporting `hidden === false` and a perfectly
  // ordinary rectangle. Measured at 800x600 on a document whose first block is
  // the table: the menu's own top was 20.5px and
  // `document.elementsFromPoint()` at the 對齊 button's own centre returned
  // `DIV.ed-toolbar` first, with the button second — so the click landed on the
  // toolbar and runCycleAlign() never ran.
  //
  // That band became reachable when the edit page stopped reserving 60px for
  // the .sidebar-toggle it hides (lib/md2doc.js's `@media (max-width: 1080px)`
  // .page-layout rule): the same first-block table's header top moved from
  // ~104px to ~60px, which puts the menu under the toolbar while the grip that
  // opens it is still comfortably clickable. Both numbers were measured on
  // this branch, on either side of that change.
  function placeTeMenuAboveCell(r) {
    const topInset = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--ed-toolbar-h')) || 0;
    let top = r.top - teEdgeMenu.offsetHeight - TE_MENU_GAP_PX;
    if (top < topInset) top = r.bottom + TE_MENU_GAP_PX;
    teEdgeMenu.style.top = top + 'px';
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
    // Task 9 fix round 1 (Ruling T9-5) left this line unfloored, on a
    // measurement that said the col grip stops being clickable before the
    // header's top can get low enough to matter. That measurement is
    // RETRACTED: it only ever asked whether the menu's top went NEGATIVE, and
    // the menu is unreachable well before that — it goes under `.ed-toolbar`,
    // which is 44px tall and paints over this menu. See
    // placeTeMenuAboveCell() for what was measured instead, and for why the
    // band is reachable by an ordinary mouse now.
    placeTeMenuAboveCell(r);
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
    // Task 9 fix round 1 (Ruling T9-5): same clamp shape as
    // openConvertSubmenu()'s .ed-handle-submenu fix — measure the menu's
    // own rendered bottom now that positionTeMenu() has placed and shown
    // it, and shift `top` up by the bottom overflow when there is one.
    // `.ed-te-menu` is `position: fixed` (lib/md2doc.js), so its own
    // getBoundingClientRect() is already in viewport coordinates. Scoped to
    // showRowMenu(): the row menu's `top` starts at the row's own top,
    // which is the case the review measured overflowing at an ordinary
    // window height. showColumnMenu() positions upward from the header
    // instead and carries its own floor — placeTeMenuAboveCell().
    const overflowBottom = teEdgeMenu.getBoundingClientRect().bottom - window.innerHeight;
    if (overflowBottom > 0) {
      teEdgeMenu.style.top = (r.top - overflowBottom) + 'px';
    }
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
    currentBurst.history.snap('delete-col-pre');
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
    currentBurst.history.snap('delete-row-pre');
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
    // v3.2.1 fix round 1: ensureTableBurstOpen() below can call a cell's
    // .focus(), which can scroll the page for real — and v3.2.1's onAnyScroll
    // (this file's module-level scroll listener) calls hideTableEdgeMenu() on
    // every scroll, which would reset teMenuKind/teMenuTableEl/teMenuColIndex
    // to null and un-highlight the column, breaking this function's own
    // "stays open, repeated clicks keep cycling" contract below. Measured
    // TWICE: (1) a plain "re-check state and re-show if it changed" fix
    // RACES the resulting 'scroll' event, which is asynchronous relative to
    // the `.focus()` call and does not reliably land before this function
    // resumes after the `await` — so suppress the menu's own auto-hide for
    // this span instead (`suppressEdgeMenuAutoHide`, see its own comment).
    // (2) clearing that suppression in a plain `finally` right after the
    // `await` ALSO raced it — the pending 'scroll' event can land AFTER this
    // function has already resumed and cleared the flag, since a
    // `focus()`-triggered scroll is not guaranteed to be delivered within
    // the same microtask turn as the promise chain above. Measured fix:
    // browsers dispatch a pending scroll before the next
    // requestAnimationFrame callback runs (it is part of the "update the
    // rendering" steps that precede rAF callbacks in the same frame), so
    // holding the flag through one rAF tick lets a pending scroll land AND
    // be swallowed before this lifts it.
    let liveTableEl;
    suppressEdgeMenuAutoHide = true;
    try {
      liveTableEl = await ensureTableBurstOpen(tableEl);
      if (!liveTableEl) { suppressEdgeMenuAutoHide = false; return; }
      currentBurst.history.snap('align-col-pre');
      cycleColumnAlign(liveTableEl, colIndex);
      currentBurst.history.snap('align-col');
    } catch (e) {
      suppressEdgeMenuAutoHide = false;
      throw e;
    }
    requestAnimationFrame(() => {
      suppressEdgeMenuAutoHide = false;
      // Fix round 2 (Important, caught by the re-reviewer): suppressing
      // hideTableEdgeMenu() only stops onAnyScroll from closing the menu —
      // it does NOT stop `ensureTableBurstOpen()`'s own `switchAwayFrom()`
      // from closing it for an UNRELATED, legitimate reason when a burst was
      // open on a DIFFERENT block: switchAwayFrom() -> resolveBurst() ->
      // hideTableEdgeMenu() (unconditional, not suppressed — only
      // onAnyScroll's call is gated) nulls teMenuKind/teMenuTableEl/
      // teMenuColIndex and clears the highlight. Without this guard the
      // unconditional reposition below would then make that CORRECTLY-
      // closed menu visible again — empty of highlight, and inert (its own
      // teMenuKind/teMenuColIndex are null, so a second 對齊/刪除欄 click
      // reads no target and does nothing) — floating over the document
      // until the next scroll happens to close it for an unrelated reason.
      // Only reposition when the menu is STILL the one this call opened:
      // same kind, same column, and the table identity matches EITHER
      // `tableEl` (showColumnMenu() was called with this — the pre-swap
      // identity, read from its own definition above — and nothing since
      // has touched teMenuTableEl) or `liveTableEl` (belt-and-braces, in
      // case some future path re-opens the menu against the live node).
      if (teMenuKind !== 'col' || teMenuColIndex !== colIndex ||
          (teMenuTableEl !== liveTableEl && teMenuTableEl !== tableEl)) return;
      // Stays open (unlike delete) UNLESS ensureTableBurstOpen()'s
      // switchAwayFrom() legitimately closed it above (guard just above) —
      // repeated clicks keep cycling. The column's cells are the SAME nodes
      // (cycleColumnAlign() only touches the `style` attribute) so the
      // existing highlight is still valid — nothing to rehighlight.
      // `.ed-te-menu` is `position: fixed` (viewport-relative) though, so if
      // the suppressed span above actually scrolled the page, its left/top
      // are now stale relative to the header cell; reposition on every call
      // that gets past the identity guard three lines up (same math as
      // showColumnMenu(), skipping its toggle-closed branch — that branch would
      // wrongly close a menu that never actually asked to close). Final wave,
      // M1: "unconditionally" is what this said before that guard was added,
      // and it stopped being true then — a call whose menu is no longer the one
      // it opened returns above and repositions nothing. A no-op scroll makes
      // this a no-op reposition (same numbers back).
      const headerRow = headerRowOf(liveTableEl);
      const cell = headerRow ? headerRow.cells[colIndex] : null;
      if (cell) {
        const r = cell.getBoundingClientRect();
        positionTeMenu(r.left, r.top);
        placeTeMenuAboveCell(r);
      }
    });
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
  // Geometry, per axis (v3.0.1: they are mirror images again):
  //   COLUMN grip: its CENTRELINE coincides with the table's TOP border, so
  //     its hit rect straddles that border by half its own height on each
  //     side (P0-a).
  //   ROW grip: its CENTRELINE coincides with the table's LEFT border, so
  //     its hit rect straddles that border by half its own width on each
  //     side — same shape as the column grip, restored in v3.0.1 (spec §4.2
  //     hit-test conflict 2).
  //
  // History: why the row axis briefly broke the symmetry, and how that was
  // undone. The block's own gutter ⠿ hangs outside the content box, and a
  // table block's own table starts at that same left edge, so a row grip
  // centred on the table's left border occupied [blockLeft-10, blockLeft+10]
  // and overlapped the ⠿'s right 6px. Both are position: fixed / absolutely
  // positioned overlays and the grip is a document.body child at z-index 7,
  // so the grip won that hit test whenever it was showing — which is
  // whenever the pointer had recently been over a table cell. MEASURED on
  // v2.12.0 at 1400x900 with the row grip parked on the HEADER row (the only
  // row whose 28px-tall grip reaches the ⠿'s own top-20px band):
  // elementFromPoint() walked across the table block's ⠿ at its vertical
  // centre answered .ed-handle for x 390..401 and the ROW GRIP for x
  // 402..407. S4 makes the ⠿ a drag handle, so those 6px would have started
  // a table ROW drag instead of a block move.
  //
  // S4 T1 (v2.12.0) fixed that by INSETTING the grip instead — its left edge
  // on the table's left border, entirely inside the table, no more straddle.
  // That broke the row/column symmetry (the column grip still straddles the
  // table's top border, because nothing of the page's own chrome lives up
  // there) and was reported as a v3.0.1 visual regression. An even earlier
  // revision (v2.10.1) had already tried an inset like it and been reverted,
  // because a 20px grip inside a cell whose left padding is 14px sits on
  // that cell's TEXT — S4 T1 avoided repeating that by widening the first
  // column's own edit-mode padding to clear the inset grip.
  //
  // v3.0.1 undoes the inset rather than re-tuning it: the row grip goes back
  // to straddling the border (this file's change, see updateTableEdgeGrips()
  // below), and the ⠿/＋ pair itself moves further LEFT instead (a shift
  // token declared alongside the gutter's own tokens in lib/md2doc.js) — the
  // overlap is removed at its SOURCE, not by moving the grip out of the
  // ⠿'s way. That also means the first column's edit-mode padding widening
  // is gone: the grip's straddling half (10px) fits inside the column's
  // default 14px padding on its own, so v2.10.1's original defect does not
  // come back. Neither the ⠿'s right edge nor the grip's left edge is
  // written down as a literal on either side of the gap between them — see
  // the shift-token comment in lib/md2doc.js's edit-mode :root block, which
  // this file deliberately does not name (test/editor-client.test.js forbids
  // the retired hover-gutter class name as a bare substring and the token
  // name contains it) — so the two cannot drift apart the way v2.11.0's pair
  // position once did (the CSS comment claiming "an 8px gap" was describing
  // that stale position, which v2.11.1 replaced).
  // test/editor-client-runtime.test.js asserts BOTH directions: every pixel
  // of a block's ⠿ answers that ⠿ (row grip hidden and showing), and the row
  // grip's own centre answers the row grip.
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

  // --ed-te-grip-row-w, read once and cached. The token is the single source
  // of truth for the grip's width (lib/md2doc.js declares it); parsing it here
  // means the JS never carries a second copy of the number.
  let gripRowWidthCache = null;
  function gripRowWidthPx() {
    if (gripRowWidthCache !== null) return gripRowWidthCache;
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--ed-te-grip-row-w');
    const n = parseFloat(raw);
    gripRowWidthCache = Number.isFinite(n) && n > 0 ? n : 20;
    return gripRowWidthCache;
  }

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

  // v3.0.2 — the gutter keep-alive for the table row grip. Held in its own
  // module-level reference, NOT read back off `gripRowTableEl`, because
  // hideTableGrips() below nulls that at its own line 7246-7248: a teardown
  // that went looking for the block through it would find null exactly when
  // it needs to clear the class, and rerenderAll()'s hideTableGrips() call
  // reaches it with the table already detached.
  let gutterKeepEl = null;

  function setGutterKeep(blockEl) {
    const next = blockEl || null;
    if (gutterKeepEl === next) return;
    if (gutterKeepEl) gutterKeepEl.classList.remove('ed-keep-lit');
    gutterKeepEl = next;
    if (gutterKeepEl) gutterKeepEl.classList.add('ed-keep-lit');
  }

  function clearGutterKeep() { setGutterKeep(null); }

  // The block whose gutter the CURRENTLY SHOWN row grip is covering, or null
  // when there is nothing to keep lit. Two conditions, both load-bearing:
  //
  //   • gripRowTableEl / gripRowEl may be null while a grip is nonetheless
  //     visible — a header-only table takes the else branch at 7466-7470 and
  //     nulls both, then the column grip is shown unconditionally just
  //     below. Both callers of this function are reached in that state.
  //   • only the HEADER row's grip shares a Y with the ⠿. Keeping the
  //     gutter lit for a body row's grip would light the ⠿ in a place the
  //     defect never occurred — a behaviour change beyond the fix.
  function headerGripBlock() {
    if (!gripRowTableEl || !gripRowEl) return null;
    if (gripRowEl !== headerRowOf(gripRowTableEl)) return null;
    return gripRowTableEl.closest('.ed-block');
  }

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
    clearGutterKeep();
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
  // Current geometry (v3.0.1 restored the row axis to mirror the column
  // axis — see the "Notion-style row/column grip handles" section comment
  // above for the S4 T1 detour into an inset row grip and how it was
  // undone): BOTH grips straddle their own border again, the COLUMN grip
  // half above / half below the table's TOP border and the ROW grip half
  // outside / half inside the table's LEFT border. The corridor-crossing
  // bug described above therefore applies to BOTH axes' straddling shape in
  // principle, and pointInColGripZone() still covers the column's
  // outside-the-border corridor exactly as before. pointInRowGripZone()
  // deliberately does NOT get an equivalent corridor formula back, even
  // though the straddle is back — see its own comment for why the padded
  // grip rect alone is still sufficient.
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
  // What each keep-zone covers TODAY:
  //   pointInColGripZone() keeps the ORIGINAL corridor shape: the union of
  //     (the column grip's own padded rect) and (the straight strip between
  //     the grip's own TOP edge and the table's top border, x clamped to the
  //     anchor COLUMN's own horizontal extent, padded). The column grip
  //     straddles the top border, so that corridor is real.
  //   pointInRowGripZone() is the padded grip rect ALONE, no corridor term —
  //     kept that way through the v3.0.1 straddle restoration on purpose,
  //     not left behind by accident. A pointer travelling from inside a body
  //     cell to the row grip's own centre (which sits exactly on the
  //     table's left border) never has to leave the table's horizontal
  //     extent on the way there, so the padded rect alone already covers
  //     every REAL (non-teleporting) approach this file's own test suite
  //     exercises — see "table grips: the row grip straddles the table's
  //     left border again…" in test/editor-client-runtime.test.js. That is
  //     narrower than the column axis's guarantee (nothing approaches the
  //     row grip from further out along the table's own left edge the way a
  //     pointer can approach the column grip from above it), which is why
  //     the two functions are allowed to stay asymmetric even though the
  //     grips' shapes are not. If a future report finds a real pointer path
  //     that does need a corridor term here, that is a new, separate defect
  //     — not evidence this reasoning was wrong when it was written.
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
    // v3.0.1 恢復跨界：row grip 的中心線重新落在表格左邊界上（不再是
    // S4 T1 那個左緣頂在邊界上、整個縮進表格內側的做法）。與 ⠿ 的重疊
    // 改在源頭解決——往左再位移的是頁面 gutter 的 ⠿/＋ 那一對按鈕本身
    // （多移動一個位移 token，宣告在 lib/md2doc.js 的編輯模式 :root 區
    // 塊，此檔案依慣例不直接引用其名稱），不是移動 grip。
    //
    // 走廊公式沒有跟著補回來，是刻意維持的範圍決定，不是漏掉：
    // TE_GRIP_ZONE_PAD_PX=4 的 padded rect 涵蓋 [tableLeft-14,
    // tableLeft+14]（grip 本身 20px 寬、跨在邊界上是 [tableLeft-10,
    // tableLeft+10]，外加 4px 緩衝）。指標從儲存格內側走向 grip 中心
    // （正好落在 tableLeft）的整段路徑，x 一律 >= tableLeft，從未離開
    // 表格的水平範圍，所以「儲存格 -> grip」這條測試套件唯一驗證過的
    // 真實（非瞬移）路徑，本來就不需要走廊公式。哪天真的量到一條需要
    // 走廊的真實路徑（例如從表格左側、gutter 那一側靠近），那是新的、
    // 獨立的缺陷，不代表這裡當初的推論錯了。
    //
    // 誠實記一筆巧合，不要誤讀成保證：⠿ 的右緣恰好落在 tableLeft-14，
    // 與這個 padded rect 的左緣相觸、不重疊——這是 TE_GRIP_ZONE_PAD_PX
    // 這個寫死的 4，與 lib/md2doc.js 那個 4px 呼吸間距 token 兩個各自
    // 獨立宣告出來的巧合，不是誰推導誰的保證。任一邊數值改動，觸點都
    // 可能變成 1px 縫隙或重疊，沒有任何型別檢查會抓到。這是既有狀態，
    // 不是本次修正引入或修掉的東西。
    //
    // 對使用者可見的差別：離開表格左側不再等於立刻收掉 row grip——padded
    // rect 本身就已經探出表格邊界 14px，所以指標要離開這整個 padded rect
    // （水平或垂直）才會真的收掉，錨定那一列的高度也不例外。
    return pointInPaddedRect(x, y, rowGrip.getBoundingClientRect(), TE_GRIP_ZONE_PAD_PX);
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
    // table — the column grip PAINTS half outside it (straddling the top
    // border) and the row grip paints inside the first column (§4.2
    // conflict 2). Either way neither is a table descendant, so the moment
    // the real pointer crosses from a cell onto
    // the grip itself, `target` is the grip and is no
    // longer inside any '.ed-block[data-block-type="table"]' or 'th, td'.
    // Without this guard, that transition would hit the "nothing found"
    // branches below and hide the very grip the pointer just moved onto —
    // pulling it out from under a user trying to click/press it. Leave
    // whatever was last shown untouched instead; hideTableGrips() (called
    // from table-leave, burst-end, and drag-start elsewhere) already covers
    // every path that actually needs to clear it.
    //
    // ⚠ KNOWN GAP, deferred by Ruling T14-5 to v3.4.0: the list below names the
    // two grips and NOT '.ed-tb-insert', so the hover-insert ＋ bubble — which
    // is the same kind of `position: fixed` overlay painted over the same band
    // — falls through to the branches beneath and takes the ⠿ grips down while
    // the pointer stands on it. The reason it was not closed here is that
    // widening this test also widens the early return's setGutterKeep() call,
    // whose behaviour on the ＋ bubble is unmeasured. A reader of this function
    // should know it is knowingly incomplete rather than infer the list is the
    // whole set.
    if (target && target.closest && (target.closest('.ed-te-grip-row') || target.closest('.ed-te-grip-col'))) {
      // v3.0.2: only the ROW grip is the one that covers the ⠿'s approach.
      // Testing the hit rather than reusing the branch condition matters —
      // the column grip sits above the table's top border, nowhere near the
      // ⠿, and lighting the gutter from there is the behaviour change this
      // fix is scoped to avoid.
      setGutterKeep(target.closest('.ed-te-grip-row') ? headerGripBlock() : null);
      return;
    }
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
      const inRowZone = pointInRowGripZone(x, y);
      if (inRowZone || pointInColGripZone(x, y)) {
        setGutterKeep(inRowZone ? headerGripBlock() : null);
        return;
      }
      hideTableGrips();
      return;
    }
    clearGutterKeep();

    const tableRect = tableEl.getBoundingClientRect();
    const rowEl = cellEl.parentElement;
    const headerRow = headerRowOf(tableEl);
    const colIndex = colIndexOf(cellEl);

    // Row grip: every row, including the header — the first row of a
    // markdown table IS the header, so any row must be draggable to the
    // top to become it. ONE position rule for all of them (user acceptance:
    // 「grip 位置都一樣」) — its CENTRELINE on the table's left border, i.e.
    // straddling it half outside / half inside the table, restored in
    // v3.0.1 (spec §4.2 hit-test conflict 2 — see the geometry note above
    // buildTableGrip() for the S4 T1 detour into an inset grip and how it
    // was undone), vertically centred on its own row; no
    // header special case. The
    // one exception is a header-only table (no body rows): its single row
    // is thead's only row, and dragging it away would empty the thead —
    // serializeTable() would degrade it and the user's table would vanish
    // from the page. Withhold the grip there instead.
    if (rowEl && (rowEl !== headerRow || bodyRowsOf(tableEl).length > 0)) {
      gripRowTableEl = tableEl;
      gripRowEl = rowEl;
      const r = rowEl.getBoundingClientRect();
      // Fallback height matches .ed-te-grip-row's own CSS height exactly
      // (28) — offsetHeight reads 0 while `hidden` (display: none) is still
      // true on the FIRST show of a hover session, before the
      // `hidden = false` assignment below takes effect.
      const gh = rowGrip.offsetHeight || 28;
      // v3.0.1: back to STRADDLING the table's left border (the S4 T1 inset
      // was a workaround for the ⠿ hit-test overlap; the ⠿/＋ pair has
      // since moved further left via a CSS shift token in lib/md2doc.js,
      // which removes the overlap at its source). The width is read from the
      // token rather than written as a literal here: offsetWidth reads 0
      // while `hidden` is still true on the first show of a hover session,
      // and a hard-coded fallback is exactly the CSS/JS drift the token
      // exists to prevent.
      const gw = rowGrip.offsetWidth || gripRowWidthPx();
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
  // v3.4.0 §2 (measured, not guessed — see the two call sites' own comment
  // below for the full chain): this function's caller already has a cell
  // focused by the time this runs (ensureTableBurstOpen()'s forDrag branch
  // opens the burst and focuses one BEFORE either caller below ever reads
  // `cellIndex`), so a plain focus() here was re-focusing the SAME cell a
  // second time — a stack-traced probe caught exactly that: two focus()
  // calls on the identical element, the second one (this one) with no
  // options, immediately followed by the page scrolling. `preventScroll`
  // stops that second, redundant scroll without changing which cell ends
  // up focused.
  // v3.4.0 §2: `cellIndex < 0`'s fallback used to be `cells[0]` — the
  // header cell — inherited from before this function had a `forDrag`-style
  // "avoid the header" policy anywhere. It stayed reachable in theory (a
  // negative index means "no cell to re-resolve"), but the row/col-drop
  // stale-index defect fixed above (both call sites now re-resolve against
  // a rebuild-stable coordinate rather than a cell reference/ordinal that
  // may have moved) removes every realistic path that could still produce
  // one here: a drag never deletes the active row/cell, only reorders it,
  // so a valid `activeCellEl` captured before the drop always resolves to
  // SOME live cell afterward. Changed anyway, defensively, since both of
  // this function's only two callers are drag paths (same fact the
  // `forDrag` policy above is built on): prefer the first BODY cell over
  // the header, same as `ensureTableBurstOpen()`'s own `forDrag` pick — a
  // drag landing on the header is exactly the symptom this whole task
  // fixed, so a fallback that still could is worth closing even if nothing
  // currently reaches it. Falls through to `cells[0]` only when the table
  // has no body row at all; `if (!cell) return` below still means "don't
  // focus anything" for the fully-empty case, covering that alternative
  // too.
  function restoreTableFocus(tableEl, cellIndex) {
    const cells = tableCellsOf(tableEl);
    const cell = cellIndex >= 0
      ? cells[Math.min(cellIndex, cells.length - 1)]
      : (cells.find((c) => c.tagName !== 'TH') || cells[0]);
    if (!cell) return;
    if (currentBurst && currentBurst.blockType === 'table') currentBurst.activeCellEl = cell;
    selToolbarEditEl = cell;
    cell.focus({ preventScroll: true });
    placeCaretAtEnd(cell);
  }

  async function performRowDrop(tableEl, rowEl, dropTarget) {
    // rowEl/dropTarget 都是 pointerdown/拖曳期間抓的；ensureTableBurstOpen()
    // 可能 resolve 掉別的 block 的 dirty burst 並換掉整片 .content，所以
    // 先轉成 allRowsOf() 的 ordinal，之後在 live table 上重新定位。
    const rowIndex = allRowsOf(tableEl).indexOf(rowEl);
    // v3.4.0 §2: `forDrag=true` — see ensureTableBurstOpen()'s own comment.
    // A row drag never had a focused cell of its own, so if this call is
    // the one that opens the burst, it must neither scroll the page nor
    // land on the header cell.
    const liveTableEl = await ensureTableBurstOpen(tableEl, true);
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

    currentBurst.history.snap('drag-row-pre');
    const aligns = columnAlignsOf(liveTableEl);
    // v3.4.0 §2（量出來的，不是猜的）：這裡曾經寫過
    // `if (activeIndex >= 0) restoreTableFocus(...)`，想法是拖曳沒點過任何
    // 儲存格時 activeIndex 應該是 -1、藉此跳過這次呼叫。實測證明那個模型
    // 錯了——`activeIndex` 在這裡結構上永遠 >= 0：ensureTableBurstOpen()
    // 只有在 currentBurst 確實是這個表格時才會回傳非 null，而
    // `currentBurst.activeCellEl` 在 startTableBurst() 建立 currentBurst
    // 的同一個賦值式裡就一定被設好（不管 burst 是本來就開著、還是這次
    // ensureTableBurstOpen() 的 forDrag 分支剛開的）。所以「用 index 判斷
    // 要不要呼叫 restoreTableFocus()」這條路走不通，不要再試。
    //
    // 真正的捲動來源是 restoreTableFocus() 自己那次 focus()：它一定會把
    // ensureTableBurstOpen() 剛剛（forDrag、preventScroll、挑 body 儲存格）
    // 已經對好焦的那顆儲存格，重新 focus 一次——用一支外接的 stack-trace
    // 探針量到兩次 focus() 打在同一顆元素上，第二次沒帶 preventScroll，
    // 緊接著就是那次把畫面拉回去的捲動。修法落在 restoreTableFocus() 自己
    // 身上（它的 cell.focus() 現在帶 { preventScroll: true }），這裡維持
    // 無條件呼叫。
    //
    // 另一個既存缺陷（跟以上兩件事無關，重排「之前」量、「之後」用同一個
    // 序位）：原本 `activeIndex` 在這裡（rebuildTableSections() 之前）用
    // `tableCellsOf(liveTableEl).indexOf(currentBurst.activeCellEl)` 算好，
    // 卻在下面 restoreTableFocus() 裡對「重排之後」的 cell 清單使用——重排
    // 只要讓被拖那列插到 activeCellEl 那列前面，中間隔的 cell 數就變了，
    // 舊序位對到的會是別的儲存格（使用者正在打字那格，焦點卻被丟到別的
    // TD，接下來每一鍵都寫進錯的儲存格）。用一支 stack-trace 探針量過：
    // rebuildTableSections() 本身只搬 <tr>（appendChild，never 重建），但
    // retagCell() 在該列跨越表頭／本文邊界（被升格成表頭或被降成本文）時
    // **會**造出全新的 <td>/<th>（複製屬性、不是同一顆物件）——用 JS
    // expando 屬性（不是 HTML attribute，因為 attribute 會被複製過去，測
    // 不出是不是同一顆）量過：不跨表頭時標記存活，跨表頭時標記消失。
    // <tr> 元素本身兩種情況都不變（只有 appendChild 搬過），所以「列＋欄」
    // 這組座標在重排前後都穩，序位不穩。改成：重排前記下 activeRowEl（那
    // 顆 <tr>）與 activeColIdx（欄序，colIndexOf() 已有）；重排、
    // armNewTableCells() 都跑完之後，用 `activeRowEl.cells[activeColIdx]`
    // 重新取得那顆儲存格（不管 retagCell() 換過沒有，同一列同一欄序就是
    // 使用者原本在打字的那顆），再轉回 restoreTableFocus() 要的序位。
    const activeCellBefore = currentBurst && currentBurst.activeCellEl;
    const activeRowEl = activeCellBefore ? activeCellBefore.parentElement : null;
    const activeColIdx = activeCellBefore ? colIndexOf(activeCellBefore) : -1;
    suppressTableFocusout = true;
    try {
      rebuildTableSections(liveTableEl, order, aligns);
    } finally {
      suppressTableFocusout = false;
    }
    armNewTableCells(liveTableEl);
    const restoredCell = (activeRowEl && activeColIdx >= 0) ? activeRowEl.cells[activeColIdx] : null;
    const activeIndex = restoredCell ? tableCellsOf(liveTableEl).indexOf(restoredCell) : -1;
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
    // v3.4.0 §2: `forDrag=true` — same reasoning as performRowDrop() above.
    const liveTableEl = await ensureTableBurstOpen(tableEl, true);
    if (!liveTableEl) return;
    if (toIndex === fromIndex || toIndex === fromIndex + 1) return; // 原地放回
    // 短列必須讓整個操作放棄，不能只跳過那一列（final review M4）：原本
    // `if (!moved) return;` 在 forEach 裡面，短列會被略過、其他列照搬 —— 結果
    // 是欄位彼此錯位，而每一列的 cell 數量都跟原本一樣，ragged-table guard
    // 看不出任何異常。寧可整個不動。
    const dropRows = allRowsOf(liveTableEl);
    if (!dropRows.length || dropRows.some((row) => !row.cells[fromIndex])) return;
    currentBurst.history.snap('drag-col-pre');
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
    // v3.4.0 §2（量出來的，不是猜的——完整說明見 performRowDrop() 對應處的
    // 同一段註解）：這裡曾經寫過 `if (activeIndex >= 0) restoreTableFocus(...)`，
    // 想靠 index 擋掉這次呼叫，但 `activeIndex` 在這裡結構上永遠 >= 0
    // （ensureTableBurstOpen() 只有在 currentBurst 確實是這個表格時才回傳
    // 非 null，而 currentBurst.activeCellEl 在 startTableBurst() 建立
    // currentBurst 的同一個賦值式裡就一定被設好）——這條路走不通，不要
    // 再試。真正的捲動來源是 restoreTableFocus() 自己那次 focus()，修法
    // 落在它自己身上（`{ preventScroll: true }`），這裡維持無條件呼叫。
    //
    // 另一個既存缺陷，跟列拖曳同根、但失效方式不同（欄重排動的是「同一列
    // 裡 cell 的順序」，不是列本身）：這裡原本也是在上面重排「之前」用
    // `tableCellsOf(liveTableEl).indexOf(currentBurst.activeCellEl)` 算
    // `activeIndex`，重排之後才用——欄一旦搬過，每一列裡 cell 的順序都變
    // 了，`tableCellsOf()`（跨全表攤平）算出來的序位一樣是舊的。用同一支
    // 探針量過：欄重排的 forEach 是 `row.appendChild(c)`，對已經是那個
    // row 子節點的 cell 只是搬動、從不建立新節點（跟列拖曳的 retagCell()
    // 不同，欄拖曳完全不牽涉 TH／TD 轉換），所以不需要「列＋欄」那組座標
    // ——重排後直接用同一顆 `currentBurst.activeCellEl` 物件重算一次
    // indexOf() 就對了，物件本身沒被換過。
    const activeIndex = (currentBurst && currentBurst.activeCellEl)
      ? tableCellsOf(liveTableEl).indexOf(currentBurst.activeCellEl) : -1;
    restoreTableFocus(liveTableEl, activeIndex);
    hideTableGrips();
    hideTableEdgeMenu();
    currentBurst.history.snap('drag-col');
  }

  // ── S4 Task 2: dragging a BLOCK by its ⠿ handle (spec §4.5) ─────────────
  // The gesture SKELETON only — threshold, capture, drop-target computation,
  // the indicator, and every cancellation path. THE DROP IS A NO-OP; Tasks
  // 3-7 add the commits. §4.5 says to reuse the table row drag's skeleton
  // above, and this does, including its central invariant:
  //
  //     NOTHING IN THE DOM IS MUTATED DURING A DRAG. Only the indicator moves.
  //
  // That is the whole reason cancelBlockDrag() can be called unconditionally
  // from Escape / pointercancel / window blur / the next pointerdown /
  // rerenderAll() / resolveBurst() with nothing to revert — see
  // cancelTeDrag()'s own comment for the same argument on the row axis. It
  // also means no `class=""` residue can reach a burst's zero-edit guard (the
  // row path had to strip one by hand, because it DIMS the dragged <tr>; this
  // gesture deliberately dims nothing, so the question never arises). Even the
  // ⠿ menu, which lives as a CHILD of its block and would therefore be a
  // content mutation to close, is left alone until the gesture is over.
  // S4 Task 2b: the drag-cursor class, on `document.documentElement`. Named
  // once so the add, the remove and lib/md2doc.js's rule cannot drift apart.
  const BLOCK_DRAGGING_CLASS = 'ed-block-dragging';
  const blockDropIndicator = document.createElement('div');
  blockDropIndicator.className = 'ed-block-drop-indicator';
  blockDropIndicator.hidden = true;
  document.body.appendChild(blockDropIndicator);

  // The drop-target candidates: the document's block sequence, in document
  // order. MEASURED on this branch (1400x900, a doc mixing paragraphs, a
  // heading, a list run with a nested item, a same-line-nest PHANTOM, a
  // fenced code block and a table): every single `.ed-block` is a DIRECT
  // child of `contentEl` — S1 flattened the <ul>/<ol> containers away — so
  // allBlockEls() already IS that sequence, with no nesting to flatten and no
  // second, overlapping y-range sitting inside another candidate's box.
  // Named rather than inlined because Tasks 3-7 re-resolve against it.
  function blockDropCandidates() {
    return allBlockEls();
  }

  // Nearest block-drop target for `clientY` — a discriminated union:
  //   {mode: 'before-block', blockIndex, y} | {mode: 'append', y}
  // `blockIndex` is an ORDINAL into blockDropCandidates(); never a
  // `data-block-id` (blockmap.js renumbers 0..n-1 on every render, so a
  // captured id names the target's NEIGHBOUR after any commit that changes
  // the block count) and never a node (a mid-gesture commit detaches them).
  //
  // spec §4.6 replaced the table's `{beforeRow, y}` with exactly this shape,
  // because a null `beforeRow` had been overloaded to mean "append". That
  // ruling is followed here rather than nearestColDropTarget()'s flat
  // `{index, x}`, which is the one place it was never applied.
  //
  // There is no 'above-header' counterpart: a table's first row IS its
  // header, so promoting a row to first place needed its own mode; the
  // document has no such distinguished first block, and `before-block 0`
  // already says "become the new first block".
  function nearestBlockDropTarget(clientY) {
    const els = blockDropCandidates();
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) {
        return { mode: 'before-block', blockIndex: i, y: r.top };
      }
    }
    const last = els[els.length - 1];
    const rect = last ? last.getBoundingClientRect() : contentEl.getBoundingClientRect();
    return { mode: 'append', y: rect.bottom };
  }

  // The in-flight ⠿ gesture, or null between gestures — the block-axis
  // counterpart of `tePointer`. `sourceIndex` is the ORDINAL of the pressed
  // block AT PRESS TIME, which is the table drop's own rule ("convert the
  // pressed node to an ordinal first, re-resolve in the live DOM at drop
  // time"): between the press and the release, resolveGutterOperands()'s
  // switchAwayFrom() may commit some other dirty burst, re-render, and detach
  // every node in the document. `dragging` flips true once
  // TE_DRAG_THRESHOLD_PX is crossed; `dropTarget` is the union above, filled
  // in by updateBlockDropIndicator() as the pointer moves.
  let blockDragState = null;

  // Arms the gesture for a press on a ⠿. Returns TRUE when it owns this
  // pointer, so the `pointerdown` listener below can stop before it reaches
  // beginShiftClickSelection()/armBlockSelDrag().
  //
  // Running FIRST is required and is also free: `.ed-handle` is a member of
  // ED_SEL_GESTURE_CHROME, so armBlockSelDrag()'s very first line already
  // returned for exactly this target (and beginShiftClickSelection()'s does
  // too) — which is why a press on the ⠿ recorded NO pointer state at all
  // before this task. Nothing about a press anywhere else changes.
  //
  // No preventDefault() here, deliberately. wireBlockSelection()'s delegated
  // `mousedown` preventDefault() on `.ed-handle` is what keeps a dirty
  // burst's focus intact across a ⠿ press — without it the press blurs the
  // burst, the blur commits, the commit re-renders, the button is detached
  // between mousedown and mouseup and the `click` never fires at all (the
  // swallowed-first-click defect that fix exists for). Cancelling
  // `pointerdown` additionally suppresses the compatibility `mousedown` in
  // some engines, i.e. the very event that fix lives on. updateBlockDrag()
  // does the preventDefault() instead, once the gesture is definitely a drag.
  function armBlockDrag(e) {
    const handleEl = e.target && e.target.closest ? e.target.closest('.ed-handle') : null;
    if (!handleEl) return false;
    const blockEl = handleEl.closest('.ed-block');
    if (!blockEl) return false;
    const index = blockDropCandidates().indexOf(blockEl);
    if (index < 0) return false;
    blockDragState = {
      pointerId: e.pointerId,
      sourceIndex: index,
      // Carried for Tasks 3-7's own re-resolution cross-check only; the
      // ORDINAL above is the identity, for the renumbering reason spelt out
      // on `blockDragState`.
      sourceBlockId: blockEl.getAttribute('data-block-id'),
      startX: e.clientX, startY: e.clientY,
      dragging: false,
      dropTarget: null,
      captureEl: null,
    };
    return true;
  }

  // Repositions the singleton line onto the current drop target. All four
  // dimensions are written on every move — the node is this gesture's alone
  // (see the class comment in lib/md2doc.js for why it is not the table's),
  // but the content column can be resized by a sidebar drag or a window
  // resize between two frames, so a partially-written box would leave a stale
  // width behind.
  function updateBlockDropIndicator(clientY) {
    const target = nearestBlockDropTarget(clientY);
    blockDragState.dropTarget = target;
    const els = blockDropCandidates();
    const spanEl = target.mode === 'append' ? els[els.length - 1] : els[target.blockIndex];
    const r = spanEl ? spanEl.getBoundingClientRect() : contentEl.getBoundingClientRect();
    blockDropIndicator.style.left = r.left + 'px';
    blockDropIndicator.style.width = r.width + 'px';
    blockDropIndicator.style.top = (target.y - 1) + 'px';
    blockDropIndicator.style.height = '3px';
  }

  // Capture on documentElement at ENGAGE time, not at press time — the S3
  // selection drag's reasoning (captureBlockSelDrag()) applies verbatim here
  // and the table's does not. A press on a ⠿ that turns out to be a plain
  // click must not be interfered with AT ALL: it has to reach `click` and open
  // the menu. And the pressed node is a per-block button that rerenderAll()
  // and openRawEditor()'s restore() both re-create, so capturing on it would
  // pin a node the gesture can outlive.
  function captureBlockDrag(e) {
    const el = document.documentElement;
    if (el && typeof el.setPointerCapture === 'function') {
      try { el.setPointerCapture(e.pointerId); blockDragState.captureEl = el; }
      catch (err) { /* not capturable here — the buttons/blur/cancel guards still apply */ }
    }
  }

  function releaseBlockDragCapture(st) {
    if (st && st.captureEl && typeof st.captureEl.releasePointerCapture === 'function') {
      try { st.captureEl.releasePointerCapture(st.pointerId); } catch (err) { /* already released */ }
    }
  }

  function updateBlockDrag(e) {
    if (!blockDragState || e.pointerId !== blockDragState.pointerId) return;
    if (tePointer) return; // a grip gesture owns this pointer
    // The browser can simply never deliver a pointerup (released over browser
    // chrome, over another window). The next move with no button held is the
    // only signal left that the gesture is over — the same guard
    // updateBlockSelDrag() carries, for the same reason.
    // S4 Task 3: endBlockDrag() is async now. Deliberately not awaited here —
    // `updateBlockDrag` is called from a `pointermove` listener that cannot
    // await, and this branch is the last-resort recovery for a pointerup the
    // browser never delivered. The teardown inside it is synchronous either
    // way; only the drop's own commit trails.
    if (typeof e.buttons === 'number' && e.buttons === 0) { endBlockDrag(); return; }
    if (!blockDragState.dragging) {
      const dx = e.clientX - blockDragState.startX, dy = e.clientY - blockDragState.startY;
      if (Math.hypot(dx, dy) < TE_DRAG_THRESHOLD_PX) return;
      blockDragState.dragging = true;
      captureBlockDrag(e);
      blockDropIndicator.hidden = false;
      // S4 Task 2b (user request, 2026-09-01): the ONLY feedback the source
      // block gets. `.ed-handle` is `opacity: 0` off-hover, so from the moment
      // the pointer leaves the block there is nothing under the cursor but the
      // indicator line. The ruling is a `cursor: grabbing` class on
      // `document.documentElement` — OUTSIDE `contentEl`, so the "mutate
      // nothing in the content DOM during a drag" invariant this whole gesture
      // rests on still holds, and every cancellation path stays unconditional.
      // The table drag's `ed-te-row-dragging` dim is deliberately NOT the
      // model: it dims a node INSIDE the content, and the burst's zero-edit
      // guard compares `contentEl`'s innerHTML, so the residue it leaves had
      // to be stripped by hand.
      //
      // ⚠ CORRECTED (S4 review round, 2026-09-01). The earlier wording here
      // and in §4.5 said documentElement AVOIDS that `class=""` residue. It
      // does not. classList.add() on an element with no `class` attribute
      // CREATES one and remove() only empties its value — measured in the same
      // Chromium: `<html class="">` after every engaged drag, every time. The
      // residue is not avoided, it is RELOCATED: `<html>` is a node nothing in
      // this file compares, `contentEl.innerHTML` is a string the zero-edit
      // guard reads on every commit. The ruling is unchanged (the cost really
      // is zero); only its stated reason was wrong.
      document.documentElement.classList.add(BLOCK_DRAGGING_CLASS);
      // Nothing else is touched here. The table's hover chrome (insert
      // bubbles, grips) is hidden by the rAF `mousemove` gate below, which is
      // where the row drag and the S3 selection drag both do it too; and the
      // ⠿ / ＋ menus are left alone until endBlockDrag(), because closing one
      // detaches a node from INSIDE a block and would break the
      // "nothing is mutated during a drag" invariant this whole gesture rests
      // on.
    }
    e.preventDefault();
    updateBlockDropIndicator(e.clientY);
  }

  // Shared teardown. Both exits below go through it, so a future drop added
  // to endBlockDrag() can never be reached from a cancellation path.
  function teardownBlockDrag() {
    if (!blockDragState) return null;
    const st = blockDragState;
    blockDragState = null;
    releaseBlockDragCapture(st);
    blockDropIndicator.hidden = true;
    // S4 Task 2b: removed HERE and nowhere else. T2 routed endBlockDrag() and
    // cancelBlockDrag() through this one function precisely so a later
    // addition inherits all five abort paths (pointerup, Escape,
    // pointercancel, window blur, the next pointerdown / every re-render) for
    // free. Unconditional on `.dragging`: classList.remove() of a class that
    // was never added is a no-op, and a gesture that ended before the
    // threshold never added it.
    document.documentElement.classList.remove(BLOCK_DRAGGING_CLASS);
    // A gesture that became a drag owns its own trailing `click`: released
    // outside every block it would reach wireBlockSelection()'s
    // switchAwayFrom(); released back over the ⠿ it started on it would OPEN
    // THE MENU the user was not asking for. Same one-shot flag the S3
    // selection drag sets, re-armed to false by the next pointerdown so a
    // gesture whose click never arrives cannot swallow a later one.
    if (st.dragging) blockSelClickSuppressed = true;
    return st;
  }

  // The `pointerup` half. S4 Task 3 makes the drop REAL for a single block
  // that is not a list item; Tasks 4-7 widen it. The teardown above is
  // synchronous and happens FIRST, so the gesture is already over (indicator
  // down, capture released, `ed-block-dragging` off <html>) before a single
  // byte is considered — nothing the commit does can leave drag state behind.
  //
  // ASYNC, and the `pointerup` listener awaits it: the drop resolves an open
  // burst and re-renders, and a fire-and-forget promise would let a test (or
  // the next gesture) observe the document between the release and the
  // commit's own /api/render.
  async function endBlockDrag() {
    const st = teardownBlockDrag();
    if (!st || !st.dragging) return;
    // The menus are closed AFTER the gesture rather than at engage: closing
    // one detaches a node from inside a block, and mutating nothing during a
    // drag is what makes every cancellation path above unconditional.
    closeGutterMenu();
    closeInsertMenu();
    await performBlockDrop(st);
  }

  // ── S4 Task 3: the drop (spec §4.5) ───────────────────────────────────
  // Everything up to here has been chrome. This is where the ⠿ drag writes
  // bytes, through the pure commitBlockMove() above: ONE commitRangeEdit over
  // the min..max span, hence exactly one Ctrl+Z.
  //
  // The pressed block is named by ORDINAL, never by node and never by id —
  // the table drop's own rule. `blockmap.js` renumbers ids 0..n-1 on every
  // render, so a captured id names the target's NEIGHBOUR after any commit
  // that changes the block count, and every node in the document is detached
  // by a re-render. The ordinal is resolved in the LIVE DOM here, before
  // resolveGutterOperands() is allowed to commit anything.
  //
  // The DESTINATION needs the same protection and gets it one step earlier:
  // its identity is captured BEFORE resolveGutterOperands(), whose
  // switchAwayFrom() may commit some other block's dirty burst and re-render.
  // reresolveBlockEl() then proves the block sitting at that start line
  // afterwards really is the same one, exactly as the source's own re-resolve
  // does; when it cannot, the gesture is DROPPED with a banner rather than
  // completed against a block the user did not point at.
  async function performBlockDrop(st) {
    const target = st.dropTarget;
    // ⚠ S4 Task 6 audited this for §3.6 (「靜默不動作是缺陷」) and it is the one
    // silent exit in this function that NO GESTURE CAN REACH: performBlockDrop()
    // is called only from endBlockDrag()'s `st.dragging` branch, engaging sets
    // `dragging` and then calls updateBlockDropIndicator(), which assigns
    // `dropTarget` UNCONDITIONALLY from nearestBlockDropTarget() — and that
    // function has no null answer at all, falling through to
    // `{mode:'append'}` when no block's mid-line is below the pointer. Kept as
    // a defensive guard, not as a behaviour.
    if (!target) return; // engaged but never moved onto a target — nothing to do
    const els = blockDropCandidates();
    const sourceEl = els[st.sourceIndex];
    const destEl = target.mode === 'append' ? null : (els[target.blockIndex] || null);
    if (!sourceEl || (target.mode !== 'append' && !destEl)) {
      showBanner(DROPPED_GESTURE_MESSAGE, null, null);
      return;
    }
    const destIdentity = destEl ? captureBlockIdentity(destEl) : null;
    // ...and the SAME question resolveGutterOperands() asks about the source,
    // asked about the destination, BEFORE the commit that answers it.
    //
    // S4 review round (2026-09-01), MEDIUM: a drop onto a block with an open
    // DIRTY burst was ALWAYS refused. Measured on
    // '# Doc\n\nalpha\n\nbravo\n\ncharlie\n' — type ' EDITED' into
    // `charlie`, drag `alpha` onto charlie's top edge — and the answer was
    // '文件已更新，請重試這個操作' with the edit committed and the move not.
    //
    // It is an ASYMMETRY, not a race, and it could not be anything else:
    // reresolveBlockEl()'s fingerprint is the block's SOURCE, and the commit
    // that changed that source is this drop's OWN resolveGutterOperands() →
    // switchAwayFrom(). The fingerprint is therefore GUARANTEED to miss. The
    // source side has had reresolveBlockElAfterSelfCommit() for exactly this
    // since S2; this is its destination-side counterpart, gated the same way
    // — on ownsOpenSession() read BEFORE the commit, because `currentBurst` is
    // gone afterwards — so reresolveBlockEl() keeps its fingerprint for
    // everybody else. Deliberately NOT a widening of that function: S2's own
    // note says the narrowed variant exists precisely so no other caller loses
    // the fingerprint.
    const destSelfSession = destEl ? ownsOpenSession(destEl) : false;
    // The shared gutter preamble — identity capture, switchAwayFrom(), the
    // re-resolve after a commit that re-rendered, the no-source-line refusal
    // and §3.3's membership. Not re-implemented here: 「不得另寫一條」.
    const operands = await resolveGutterOperands(sourceEl);
    if (!operands) return;
    let liveDestEl = destEl;
    if (destEl && !document.body.contains(destEl)) {
      liveDestEl = reresolveBlockEl(destIdentity) ||
        (destSelfSession ? reresolveBlockElAfterSelfCommit(destIdentity) : null);
      if (!liveDestEl) { showBanner(DROPPED_GESTURE_MESSAGE, null, null); return; }
    }
    // ── S4 Task 6: THE OPERAND SET (spec §4.5, §3.3, §3.6) ────────────────
    // §4.5: 「grip 在選取集合內 → 整批搬（3.3 的成員資格規則）」. Up to Task 5
    // this read `if (operands.batch) return;` — the last two SILENT shapes in
    // the drag path, which §3.6 calls a defect in so many words
    // (「靜默不動作是缺陷」). From here down `opEls` is a span of one OR MORE
    // blocks and every path takes it whole; nothing loops over it, for the
    // reason convertBlockViaMenu() states — a commit between two members
    // re-renders and invalidates every id in between.
    const opEls = operands.els;
    const opRecs = operands.recs;
    // ── the FIRST home position, and it is shared by every kind and size ──
    // A drop that lands where the block already is is a silent byte no-op —
    // NOT a refusal and NOT a dropped gesture. It has to be answered before
    // every gate, and MEASURED, because the gates get it wrong on their own:
    // `before-block <sourceIndex>` — released on the block's own top edge,
    // which is exactly what the drag's "released where it started" scenario
    // drives — makes the destination the SOURCE, and the destination's index
    // in the source-less array below is then -1, i.e. the
    // '文件已更新，請重試這個操作' banner, for a gesture in which nothing
    // whatsoever went wrong. Caught by driving a real gesture and reading the
    // banner back; the byte assertions could not see it, because the file is
    // untouched either way. For a SET the same question is membership: any
    // member's top edge is the set's own footprint. The li path below has a
    // SECOND home position of its own — see performListItemDrop().
    if (liveDestEl && opEls.indexOf(liveDestEl) !== -1) return;
    const shape = spanListKinds(opEls);
    // §3.6's 2026-08-31 ruling, and the EXISTING banner: 「混合 span 一律拒絕」.
    // A mixed span would need a blank-line rule at the run/non-run seam — the
    // li half has to stay tight while the non-li half has to keep its
    // separators, and inside ONE commit range those two demands conflict. §3.6
    // records that the spec does not have that rule and that inventing it in
    // the last stage repeats the §3.4 marker-width error, so this refuses with
    // 建立副本 / 刪除 / 轉換's own message rather than a fifth move message.
    //
    // DELIBERATELY ABOVE the second home position, which is the one place this
    // function departs from Task 3's "answer a home position before every
    // gate" rule, and the departure is the point: a seam objection depends on
    // where the user AIMED, so refusing a put-it-back gesture with one would
    // be a banner for a gesture in which nothing went wrong. MIXED is a
    // property of the SET — it gives the same answer at every destination, so
    // there is no aim that would have worked and saying so is the honest
    // outcome. (The drop-on-a-member case is already out, above.)
    if (shape.anyLi && !shape.allLi) { refuseStructuralListEdit(BATCH_MIXED_MESSAGE); return; }
    // S4 Task 4 / Task 6: a li source has its own path. Its lines cannot be
    // relocated verbatim (markers and ordinals are run-global), so the whole
    // run is re-serialized in the new span order instead — still ONE
    // commitRangeEdit, still one Ctrl+Z. `shape.allLi` rather than the first
    // member's type: a set is all-li or it is mixed, and mixed is already out.
    // Everything below this line is the non-li move.
    if (shape.allLi) {
      await performListItemDrop(opEls, liveDestEl);
      return;
    }
    // ── the SECOND home position, still before every gate ──────────────
    // `before-block <sourceIndex + 1>` — the seam immediately below, the same
    // position on screen — is a no-op planBlockMove() answers null for, but
    // the list-seam gate below would have refused it OUT LOUD first whenever
    // the block sits between two list items. (The first home position is
    // answered above, before the li branch, because both kinds share it.)
    const live = blockDropCandidates();
    // The set's own two edges. `si` is its FIRST member and `sj` its LAST —
    // the source seam is what stands OUTSIDE those, and asking `si + 1` for it
    // would name the set's second member on any set of more than one.
    const si = live.indexOf(opEls[0]);
    const sj = live.indexOf(opEls[opEls.length - 1]);
    const rest = live.filter((el) => opEls.indexOf(el) === -1);
    const di = liveDestEl ? rest.indexOf(liveDestEl) : rest.length;
    if (si < 0 || sj < 0 || di < 0) { showBanner(DROPPED_GESTURE_MESSAGE, null, null); return; }
    // §3.3's set is contiguous in block order — resolveGutterOperands()'s own
    // gate — so its members' lines plus the separators between them are ONE
    // range, which is what makes a batch move the same single commitRangeEdit
    // (and the same single Ctrl+Z) a one-block move is. See spanMoveRange().
    const srcRec = spanMoveRange(opRecs);
    const destRec = liveDestEl ? blockRecOf(liveDestEl) : null;
    if (!srcRec || (liveDestEl && !destRec)) {
      showBanner(DROPPED_GESTURE_MESSAGE, null, null);
      return;
    }
    // A destination that owns no source line has an INVERTED range, and its
    // startLine names the line its OWNER occupies — inserting there would put
    // the block inside somebody else's territory.
    //
    // ⚠ S4 Task 6 MEASURED that this is REACHABLE, and that Task 3's comment
    // here ("unreachable while the seam gate below holds") was wrong. It said
    // so on the grounds that every no-line phantom this model produces is a
    // li — true, and beside the point: the seam gate refuses a destination
    // whose BOTH neighbours are li of one run, and a phantom's upper
    // neighbour is very often not a li at all. Driven as a real gesture on
    // '# Doc\n\npara\n\n- - b\n- c\n\ntail\n' (blockmap:
    // heading{1,1} | para{3,3} | li{5,4} PHANTOM | li{5,5} | li{6,6} |
    // para{8,8}): the phantom has a box of its own (measured top 190,
    // bottom 215 at 1400x900), so nearestBlockDropTarget() names it like any
    // other block; `rest[di - 1]` is the PARAGRAPH, so blockMoveSeamRefusal()
    // answers null; and planBlockMove() answers a REAL plan for it
    // ('# Doc\n\npara\n\ntail\n\n- - b\n- c\n'), so it is not a home
    // position either. Dragging `tail` onto that phantom therefore did
    // nothing, wrote nothing and said nothing — §3.6's 「靜默不動作是缺陷」,
    // and the third silent shape this task owed on top of the two the plan
    // named.
    //
    // The banner is the DESTINATION seam's, not a fifth constant: the line
    // this drop names belongs to the phantom's own nested item, so the block
    // really would land between an item and its sublist, which is exactly
    // what 無法把區塊放進清單項目之間 says. The remedy it gives (aim
    // somewhere else) is the correct one.
    if (destRec && destRec.endLine < destRec.startLine) {
      refuseStructuralListEdit(BLOCK_MOVE_DEST_SEAM_MESSAGE);
      return;
    }
    // The second home position (see above): `null` means "already there".
    // Asked BEFORE the seam gate so a put-it-back gesture is silent rather
    // than refused. planBlockMove() is pure, so asking twice costs nothing.
    if (!planBlockMove(lines, blocks, srcRec, destRec)) return;
    // Both seams MEASURED with marked.lexer, not reasoned about:
    //   destination — '# Doc\n\npara\n\n- a\n- b\n\ntail\n' with `para`
    //     spliced between the two items lexes as list(1 item) | paragraph |
    //     list(1 item): ONE two-item run became TWO one-item runs, and the
    //     blank lines rule 3 emits are §4.3's looseness trap;
    //   source — '# Doc\n\n- a\n\npara\n\n- b\n' with `para` lifted out
    //     leaves '- a\n\n- b\n', which lexes as ONE list, loose === TRUE.
    //     Every item then renders as <p>, serializeBlocks() reports 'P' for
    //     each, and the whole run degrades read-only WITH NO BANNER.
    // S4 Task 5 NARROWED the destination half of this and deliberately left
    // the source half wide; blockMoveSeamRefusal()'s own header carries the
    // full enumeration and the measurement behind every row of it. The short
    // version: an insertion can only SPLIT, so the destination only has to
    // refuse a seam INSIDE one run; a removal MERGES, and the model does not
    // carry the raw bytes (the bullet character, the leading two spaces) that
    // decide whether two runs about to become adjacent stay two lists.
    //
    // The descriptor is built from listRunOf() — §3.4 rule 2's scope — so a
    // nested child and its parent answer the same run key, which is what
    // stops "a paragraph dropped between an item and its own sublist" from
    // reading as a boundary between two separate lists.
    const seamDesc = (el) => {
      if (!el || !el.getAttribute || el.getAttribute('data-block-type') !== 'li') return null;
      const r = listRunOf(el);
      return { runKey: r.length ? r[0].getAttribute('data-block-id') : null };
    };
    const seamRefusal = blockMoveSeamRefusal(
      { prev: seamDesc(live[si - 1]), next: seamDesc(live[sj + 1]) },
      { prev: seamDesc(rest[di - 1]), next: seamDesc(rest[di]) });
    if (seamRefusal === 'source') {
      refuseStructuralListEdit(BLOCK_MOVE_SOURCE_SEAM_MESSAGE);
      return;
    }
    if (seamRefusal === 'destination') {
      refuseStructuralListEdit(BLOCK_MOVE_DEST_SEAM_MESSAGE);
      return;
    }
    const result = commitBlockMove({ lines, blocks, stack }, srcRec, destRec);
    // commitRangeEdit()'s own unchanged-text answer, or a refused inverted
    // range. Neither pushed an op, so there is nothing to render or roll back.
    //
    // ⚠ S4 Task 6 audited this too, and corrected Task 3's claim that neither
    // is reachable. The inverted-range half is not (planBlockMove() has
    // already answered a real plan). The UNCHANGED-TEXT half is: MEASURED on
    // 'same\n\nsame\n\ntail\n' with the first paragraph moved past the
    // second, planBlockMove() answers a genuine plan and the text it produces
    // is the file byte-for-byte, because the two blocks are identical. That
    // is a real byte no-op — the document after the gesture IS the document
    // before it — so it stays silent for Task 3's own reason. A banner here
    // would tell a user that a move they can SEE succeeded had failed.
    if (!result.op) return;
    const prevLines = lines;
    lines = result.lines;
    // §3.3's collapse, declared IMMEDIATELY before the render and never
    // earlier: the moved block's range in the NEW document, which is where a
    // standing selection must end up. declareCollapse()'s own `if
    // (blockSelection)` guard is what stops this single-block gesture from
    // INVENTING a selection when none was standing.
    declareCollapse(result.newRange);
    const editRange = result.op
      ? { startLine: Math.min(result.op.startLine, result.op.endLine + 1),
          endLine: Math.max(result.op.startLine - 1, result.op.endLine),
          delta: result.op.after.length - result.op.before.length }
      : undefined;
    const okRender = await safeRerenderAll(editRange);
    if (!okRender) {
      lines = rollbackFailedRender({ lines, stack }, result, prevLines);
    }
  }

  // ── S4 Task 4: the drop of a LIST ITEM, inside its own run (spec §4.5) ──
  //
  // Task 3's drop returned SILENTLY for a li. §3.6 is explicit that
  // 「靜默不動作是缺陷」, so after this function a li drag either MOVES or
  // refuses WITH A BANNER; the only silent outcome left is a home position,
  // which is Task 3's own ruling (a drop where the block already is is a byte
  // no-op, not a refusal) and is answered in two places here.
  //
  // THE SHAPE IS duplicateListItems()'s, and the recon named it as the only
  // existing path that already expresses a reorder as ONE commit:
  //   * capture `presetRange` BEFORE mutating — runRangeOfBlocks() takes the
  //     FIRST and LAST members of the array it is handed on the written
  //     assumption that the array is in DOCUMENT order, which the reordered
  //     span is not;
  //   * build the REORDERED SPAN ARRAY (serializeBlocks() emits in array
  //     order, and rebuilds its width/counter/type stacks as it walks — the
  //     output is entirely determined by that order);
  //   * mutateListRun() to move the node, with the focusout suppressed;
  //   * commitListStructure(span, …, {presetRange, carryOver}), where
  //     `carryOver` is bystanderCarryOver(span) — built AFTER the reorder and
  //     BEFORE `blocks` is rebuilt — so every block's ORIGINAL bytes are
  //     replayed by id and nothing is re-escaped ('~5px' would otherwise come
  //     back '\~5px'). Only the marker and the leading columns are re-stated,
  //     which is exactly §3.8's renumbering and §3.4's colDelta.
  // One commitRangeEdit inside commitListStructure() is one undo op, which is
  // §3.4's requirement for one gesture.
  //
  // `data-list-start` is a POSITION property, not an item property. It is the
  // only carrier of "marked's lexer opened a list token here" (§3.8 rule (d))
  // and serializeBlocks() resets its ordinal counter on it, so a reorder that
  // changes which item stands FIRST has to carry it across — the mirror image
  // of duplicateListItems() stripping it from a copy. MEASURED, on
  // '1. alpha / 2. bravo / 3. charlie' with charlie dragged to the head:
  // without the transfer the attribute stays on `alpha`, which is now the
  // span's SECOND block, and the run comes back
  // '1. charlie / 1. alpha / 2. bravo'.
  //
  // SCOPE — and it is exactly the task's title, "within its own run". The
  // destination must be a slot between the item's own §3.8 RUN SIBLINGS, or
  // the slot immediately past the last of them. Everything else is a
  // cross-boundary move: out of the list entirely, into a nested sublist, into
  // a different run. Task 5 owns that enumeration and the ruling it implements
  // is already made — refused with a banner in 3.0.0 — so they are refused
  // here with Task 5's own constant rather than half-implemented.
  //
  // S4 Task 6 widened `liEl` to `liEls` — §3.3's operand set, one OR MORE list
  // items in document order. The whole function is the same commit: the set is
  // contiguous in block order (resolveGutterOperands()'s gate), and `run` is a
  // contiguous slice of the document (listRunOf()'s own contract), so the
  // members occupy CONSECUTIVE slots of `run` and "move them" is one call to
  // reorderSpanRange() with a count instead of two paths.
  async function performListItemDrop(liEls, destEl) {
    const liEl = liEls[0];
    const lastLiEl = liEls[liEls.length - 1];
    // §3.4 rule 2's scope, and the span commitListStructure() re-serializes:
    // the OUTERMOST run reachable from this item plus every descendant of its
    // members. Not the item's own sibling run — a span that STARTS at indent 2
    // has no width recorded for depths 0 and 1 and would be emitted with no
    // indent prefix at all, i.e. committing it would de-nest the whole thing.
    const run = listRunOf(liEl);
    const srcIdxs = liEls.map((el) => run.indexOf(el));
    const srcIdx = srcIdxs[0];
    if (srcIdx < 0) { showBanner(DROPPED_GESTURE_MESSAGE, null, null); return; }
    // A member outside the grip's own commit span means the set straddles TWO
    // runs — contiguity in `blocks` does not imply one run, because two
    // adjacent runs separated by a delimiter change ('- a' / '1. b') are
    // adjacent blocks with no phantom between them. Same answer
    // convertBlockViaMenu() gives, through the same message: the commit
    // re-serializes ONE run's line range and a member outside it would be
    // rewritten by a range that does not cover it.
    if (srcIdxs.indexOf(-1) !== -1) { refuseStructuralListEdit(BATCH_MULTIRUN_MESSAGE); return; }
    // ...and they must be CONSECUTIVE slots of it. Guaranteed today by
    // spanIsContiguous() plus listRunOf() returning a contiguous slice, and
    // checked anyway rather than asserted in prose: reorderSpanRange() takes a
    // `from` and a `count`, so a gap here would silently drag a NON-member
    // along with the set.
    for (let k = 1; k < srcIdxs.length; k++) {
      if (srcIdxs[k] !== srcIdxs[k - 1] + 1) { refuseStructuralListEdit(BATCH_GAP_MESSAGE); return; }
    }
    const all = blockDropCandidates();
    // ── the SECOND home position ───────────────────────────────────────
    // `before-block <sourceIndex + 1>` is the seam immediately below the item,
    // which is the same place on screen as its own top edge. For an item WITH
    // CHILDREN that next block is its own first child, and "before my own
    // first child" is precisely where it already is; for the run's LAST item
    // it is the block AFTER the run, which must be read as "already there"
    // and not as a boundary crossing. Answered before every gate, for Task 3's
    // reason: a refusal here would be a banner for a gesture in which nothing
    // went wrong.
    const afterSrcEl = all[all.indexOf(lastLiEl) + 1] || null;
    if (destEl ? destEl === afterSrcEl : all[all.length - 1] === lastLiEl) return;
    // ── §4.3's run-wide gate ───────────────────────────────────────────
    // 「轉換／建立副本／刪除／拖曳一律在 mutation 前走
    // listRunSupportsStructuralEdit()」. There is no shared helper — the four
    // existing call sites each make the call themselves — so this one does
    // too. Its input is §3.4 rule 2's scope, which is exactly what listRunOf()
    // returns. Ahead of every OTHER refusal, the convention convertBlockViaMenu()
    // states: a run that cannot be structurally edited at all must say so,
    // rather than report whichever narrower objection is asked next.
    //
    // `columnOnly` is the honest option, and it is the same argument
    // insertBlockBelow()'s li path and the rule-2 merge already make: a
    // reorder rewrites NO item's CONTENT and NO item's LINE COUNT. The only
    // bytes that move in any member are its marker and its leading columns —
    // §3.8's renumbering, applied to a replayed bystander as §3.4's colDelta —
    // which is the criterion listRunSupportsStructuralEdit() documents.
    // Without it a single hard-wrapped item anywhere in the run would veto
    // every drag, which on this repo's own CHANGELOG.md is every run (80.6% of
    // its list items are hard-wrapped).
    if (!listRunSupportsStructuralEdit(run, null, { columnOnly: true })) {
      refuseStructuralListEdit();
      return;
    }
    // ── the destination must be a slot in the item's OWN §3.8 run ──────
    // `sibs` is that run: the same-depth members listRunOf() walked out from.
    // The two legal shapes are "before sibling S" and "past the last
    // sibling's whole subtree" — the latter being the ONLY way to name the
    // end of a run that something follows, since the drop target can only ever
    // name a block, and the block it names there is outside the run.
    const sibs = runBlocksOf(liEl);
    const lastSib = sibs[sibs.length - 1];
    const sibTail = subtreeBlocksAfter(lastSib, Number(lastSib.getAttribute('data-indent')) || 0);
    const runEndEl = sibTail.length ? sibTail[sibTail.length - 1] : lastSib;
    const afterRunEl = all[all.indexOf(runEndEl) + 1] || null;
    let insertAt = -1;
    if (destEl === null) {
      // The {mode:'append'} target is "after the document's last block", so it
      // names the end of this run only when the run ends the document.
      if (afterRunEl === null) insertAt = run.indexOf(runEndEl) + 1;
    } else if (sibs.indexOf(destEl) !== -1) {
      insertAt = run.indexOf(destEl);
    } else if (destEl === afterRunEl) {
      insertAt = run.indexOf(runEndEl) + 1;
    }
    // All four out-of-run shapes land here: a slot between two non-li, a
    // DIFFERENT run, the middle of a run of another list type, and the
    // {mode:'append'} target when a block follows the run. Task 5 gave them
    // their own message — the remedy is "stay inside your own list", which
    // neither seam message says.
    if (insertAt < 0) { refuseStructuralListEdit(BLOCK_MOVE_OUT_OF_RUN_MESSAGE); return; }
    // `null` is the order-is-unchanged answer — the two home positions above
    // reach this by another road (an item whose next block is a sibling), and
    // it stays SILENT for the same reason.
    const order = reorderSpanRange(run.length, srcIdx, srcIdxs.length, insertAt);
    if (!order) return;
    // Captured BEFORE the reorder, and this is the whole reason duplicateListItems()
    // captures it too: runRangeOfBlocks() reads the first and last members of
    // the ARRAY, and the reordered span's first member is not the run's first
    // line.
    const range = runRangeOfBlocks({ lines, blocks, stack }, run);
    if (!range) { showBanner(DROPPED_GESTURE_MESSAGE, null, null); return; }
    const span = order.map((i) => run[i]);
    // ── THE SEAM TASK 7 OWNS — §4.5's indent clamp ─────────────────────
    //
    // §4.5: the moved item keeps its own `data-indent` (nothing here writes
    // one) and 「子項留在原地（依 3.4 位移夾取）」 — the children it leaves
    // behind are re-anchored by §3.4.
    //
    // THE MEASUREMENT THIS IS BUILT ON, and it is the correction of Task 4's.
    // Task 4 measured that handing `applyIndentClamp()` the REORDERED span
    // clamps nothing — true, and for a reason that names its own remedy:
    // rule 2's scope starts after the operated block's NEW index, while the
    // orphans are left behind at its OLD one. A move IS a REMOVAL at the old
    // index plus an INSERTION at the new one, so the orphans are the removal's
    // business and `{ removed: true }` — the mode the ⠿ delete has used since
    // S1 — is exactly the right question, asked of `run` in DOCUMENT order
    // (which it still is: nothing has touched the DOM yet). `clampIndents()`
    // reports no indent for a removed block, so the travelling members' own
    // depths are never rewritten by this; the reorder below then re-inserts
    // them at the destination unchanged. NOTHING in indent-clamp.js changed,
    // no new mode, no §3.4 amendment.
    //
    // Two things the sweep settled that prose could not (every legal indent
    // array of length 2..6 and depth 0..3 × every operand-set size × every
    // destination the gate above admits = 4067 drops; the pin is in
    // test/editor-client.test.js):
    //
    //  1. §4.5 also says the moved block is 「落點使其非法時夾到合法值」. That
    //     has NO reachable case: 0 of the 4067 leave the moved block's own
    //     indent illegal, because the destination gate above only ever admits
    //     a slot among its own same-depth siblings and the block standing
    //     before such a slot can always parent it. If that gate is ever
    //     widened (3.1.0) this becomes owed — and rule 1 of clampIndents()
    //     already answers it, on the span, at the new index.
    //  2. The clamp does not answer everything. 14 of the 4067 stay
    //     unanchored, all of them BATCH sets whose last member is SHALLOWER
    //     than the block they land before — the INSERTION half, at the new
    //     index, for which §3.4 has no rule. Those keep Task 4's refusal,
    //     narrowed to them and re-worded with it.
    //
    // ORDER MATTERS: compute, judge, and only then write. A refusal that has
    // already written `data-indent` leaves a half-clamped DOM behind on a
    // gesture that wrote no bytes — the same screen/model disagreement the
    // clamp exists to prevent, produced by the clamp itself.
    const clamp = computeIndentClamp(run, liEls, spanMinIndent(liEls), { removed: true });
    const clamped = new Map();
    (clamp || []).forEach((r) => { clamped.set(r.el, r.indent); });
    if (!spanIndentsAreAnchored(span.map((el) => ({
      type: el.getAttribute('data-block-type') === 'li' ? 'li' : 'other',
      indent: clamped.has(el) ? clamped.get(el)
        : (Number(el.getAttribute('data-indent')) || 0),
    })))) {
      refuseStructuralListEdit(BLOCK_MOVE_ORPHAN_MESSAGE);
      return;
    }
    // S4 review round (2026-09-01): this WRITE is load-bearing, and it took a
    // measurement to show it. Deleting the line left all 39 S4 scenarios green
    // — the four T7 ones named after the clamp included — because every one of
    // them moves a SINGLE item, and for `count === 1` the write can never
    // change a byte: serializeBlocks() rebuilds its width stack as it walks
    // (`widths.length = indent + 1` after every block), so an over-deep
    // `data-indent` is emitted at its anchor's own column, which is the column
    // the clamp would have written. Re-run over the whole 4067-drop space with
    // the real serializeBlocks() on both sides: 0 single-item drops differ, 53
    // BATCH drops differ on a `ul` and 123 on an `ol`. The smallest is indents
    // 0,0,1,2,1 with {1,2} moved past the run — without the write the orphan
    // that kept its departed parent's depth is ADOPTED by a block the user
    // never touched, which is rule 3's own worked failure. Pinned as bytes by
    // the RV2 runtime scenario and as counts in test/editor-client.test.js.
    writeIndentClamp(clamp);
    const sibsAfter = span.filter((el) => sibs.indexOf(el) !== -1);
    mutateListRun(() => {
      // `data-list-start` follows the run's HEAD, not the item — see this
      // function's own header for the measured '1. charlie / 1. alpha' that
      // dropping this produces. Only the moved item can change which sibling
      // stands first, so this is the only pair that can need it; a NESTED
      // run's own list-start belongs to a member nothing moved and is left
      // exactly where it is.
      if (sibsAfter[0] !== sibs[0] && sibs[0].getAttribute('data-list-start') === '1') {
        sibs[0].removeAttribute('data-list-start');
        sibsAfter[0].setAttribute('data-list-start', '1');
      }
      // `insertAt` indexes `run`, which is still in document order at this
      // point — the DOM has not been touched yet. `insertAt === run.length`
      // cannot be the moved item's own slot (that is the home position, out
      // above), so the reference node is safe to read off the run's last
      // member.
      const refEl = insertAt < run.length ? run[insertAt] : run[run.length - 1].nextSibling;
      // In the set's OWN order, each before the same reference node: that
      // leaves them consecutive and in document order at the destination,
      // which is what reorderSpanRange() already said the span would be. A
      // loop that inserted each before the PREVIOUS one would reverse the set.
      liEls.forEach((el) => { el.parentNode.insertBefore(el, refEl); });
    });
    // AFTER the reorder and BEFORE `blocks` is rebuilt, which is the window
    // bystanderCarryOver() documents. No `mutatedEl`: nothing in this span had
    // its CONTENT rewritten — the map is what keeps every member byte-
    // identical to the file, the moved one included.
    const carryOver = bystanderCarryOver(span);
    // §3.3's collapse, declared immediately before the render inside
    // commitListStructure(). declareCollapse()'s own `if (blockSelection)`
    // guard is what stops this single-block gesture from INVENTING a
    // selection when none was standing; when one WAS, resolveGutterOperands()
    // has already collapsed it onto this item, so it has to follow the item
    // to its new lines.
    declareCollapse(movedLiRangeAfterReorder(span, liEls, carryOver, range));
    await commitListStructure(span, null, false,
      { presetRange: range, carryOver: carryOver });
  }

  // The moved item's line range in the run AS IT IS ABOUT TO BE COMMITTED.
  //
  // Deliberately NOT runLineOfBlock(), and this is a measurement that
  // contradicts the obvious reuse: that function derives the run's start line
  // with runRangeOfBlocks(runEls), which takes the FIRST member of the array —
  // correct for every existing caller, whose array is in document order, and
  // wrong here by construction, because the reordered span's first member is
  // whichever item was just moved to the head. The rest of its arithmetic is
  // reproduced: `lineMeta` carries one entry per EMITTED line naming the block
  // that owns it, so a block's range is the run of entries bearing its id —
  // counted, never assumed to be one, because a hard-wrapped item replays
  // several.
  //
  // S4 Task 6: `liEls` is §3.3's operand set, one or more. The members travel
  // together and stay consecutive, so their emitted lines are one contiguous
  // run and the answer is the FIRST line of the first member to the LAST line
  // of the last — which is exactly §3.3's 「操作結果所涵蓋的行區間」. Taking
  // the first member's range alone would collapse a three-block drag onto one
  // tinted block.
  function movedLiRangeAfterReorder(span, liEls, carryOver, range) {
    const ids = liEls.map((el) => el.getAttribute('data-block-id'));
    if (ids.indexOf(null) !== -1) return null;
    const { lineMeta } = listMd.serializeBlocks(span, { carryOver: carryOver || null });
    let first = -1;
    let last = -1;
    lineMeta.forEach((m, i) => {
      if (ids.indexOf(m.blockId) === -1) return;
      if (first < 0) first = i;
      last = i;
    });
    if (first < 0) return null;
    return { startLine: range.startLine + first, endLine: range.startLine + last };
  }

  // Unconditional teardown of the in-flight ⠿ gesture — called from FIVE
  // places, exactly mirroring cancelTeDrag()'s own list: the Escape
  // prologue's first rungs, `pointercancel`, window `blur`, the defensive
  // clear at the top of the next `pointerdown`, and every re-render path
  // (rerenderAll() / resolveBurst()). Nothing was mutated, so there is
  // nothing to revert and no state this is unsafe to be called from — the
  // null-out is unconditional on `blockDragState` being set and is NOT gated
  // on `.dragging`, which is the review fix cancelTeDrag() carries too (a
  // burst resolution landing during the pressed-but-pre-threshold window used
  // to leave the table's state pointing at a row rerenderAll() was about to
  // detach).
  function cancelBlockDrag() {
    teardownBlockDrag();
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
    // S4 Task 2: same defensive reasoning again for the ⠿ block drag — a prior
    // gesture whose pointerup/pointercancel never arrived must not survive into
    // this one. Nothing was mutated, so this is always a clean no-op teardown.
    if (blockDragState) cancelBlockDrag();
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
      // S4 Task 2 (spec §4.5): the ⠿ drag arms HERE, ahead of both selection
      // entries, and claims the pointer when it owns it. It has to run before
      // armBlockSelDrag(), whose first line returns for `.ed-handle` (a member
      // of ED_SEL_GESTURE_CHROME) — which is why a press on the ⠿ recorded no
      // pointer state at all before this task. beginShiftClickSelection()
      // returns for the same target, so ordering it above the Shift branch too
      // changes nothing for any press that is not on a ⠿: armBlockDrag()
      // returns false for every other target and falls straight through.
      //
      // S4 review round (2026-09-01) — RECORDED, because nobody had. It DOES
      // change one thing for a press that IS on a ⠿: armBlockDrag() reads no
      // modifier, so Shift / Ctrl / Alt + ⠿ now starts a drag, where before S4
      // it did nothing at all until release. KEPT, deliberately: the table's
      // row and column grips take the pointer with no modifier check either
      // (see the `if (!hit)` branch's else, below), so a ⠿ that behaved
      // differently would be the surprise; neither §3.3 nor §4.5 gives a
      // modified ⠿ press a meaning of its own; and a modified press that never
      // crosses the threshold still opens the menu, so nothing was taken away.
      // Pinned by the RV5 scenario in test/editor-client-runtime.test.js.
      if (armBlockDrag(e)) return;
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

  // S4 Task 2: the ⠿ block drag's own pointermove. Registered alongside the
  // other two rather than folded into either: the table drag's listener bails
  // on `!tePointer` (the state this one runs in) and the selection drag's bails
  // on `!blockSelDrag` (likewise). updateBlockDrag()'s own first lines are the
  // symmetric bail.
  document.addEventListener('pointermove', (e) => {
    updateBlockDrag(e);
  });

  document.addEventListener('pointerup', async (e) => {
    // S3 Task 4: recon hazard 2 — there is no `mouseup` listener anywhere in
    // this file, so the block-selection drag ends on the pointer events, the
    // same skeleton the table drag uses. Before the `!tePointer` bail: a
    // selection drag is armed precisely when no grip gesture is in flight.
    endBlockSelDrag();
    // S4 Task 2: and the ⠿ block drag's. Same placement reasoning as the line
    // above — a block drag is armed precisely when no grip gesture is in
    // flight, so it must be ended before the `!tePointer` bail.
    // S4 Task 3: AWAITED, now that the drop writes. endBlockDrag()'s own
    // teardown runs synchronously (an async function body runs to its first
    // await), so the `tePointer` branch below is not reordered around any
    // state it reads; what the await buys is that the commit and its
    // re-render are complete before this handler returns.
    await endBlockDrag();
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
    // S4 Task 2: the same abort ends a ⠿ block drag. Nothing was mutated (only
    // the indicator moved), so this is the same unconditional cleanup.
    cancelBlockDrag();
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
    // S4 Task 2: same again for the ⠿ block drag — an undeliverable pointerup
    // is an undeliverable pointerup whichever gesture is holding it.
    cancelBlockDrag();
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
  // Task 15: the cell whose whole contents the Tab walk selected, or null.
  // Tab now writes a full-cell selection on every press, and
  // onSelectionChangeForToolbar() below asks only "is there a non-collapsed
  // selection inside `selToolbarEditEl`" — which a Tab-made selection answers
  // yes to, so the floating .ed-seltb rose over the cell on every press.
  //
  // Keyed on the CELL ELEMENT, never on a Range. A release condition phrased
  // as "the selection went collapsed" would fire on its own during a
  // re-render: measured across a commit that took the full-render route, a
  // Range built over a cell before it neither threw nor reported itself
  // broken afterwards, while the cell it was built from did — see the probe
  // figures quoted with the release check in onSelectionChangeForToolbar().
  //
  // Released the moment the live selection stops being exactly this cell's
  // contents, which is also what keeps a HAND-MADE selection out of the
  // suppression: the boundary points written here are the cell element itself
  // at offset zero and at its child count, while a selection the user builds
  // is anchored in the text. Driven on a cell holding 'c2', a drag across it,
  // a double click, a triple click and Ctrl+A each read back a startContainer
  // of '#text', so none of them matches.
  //
  // What this cannot reach, and does not cause: a press that begins INSIDE the
  // standing selection is Chromium's own drag-the-selected-text gesture.
  // Driven straight after a Tab, it dispatched dragstart and dragend and not
  // one selectionchange, so no release condition of any shape gets a hearing —
  // the same with this suppression removed. Anything that collapses the
  // selection first (a click, an arrow key) puts an ordinary drag back, and
  // that drag releases here. Meanwhile the FIXED toolbar's inline buttons stay
  // enabled throughout: hasFormattableSelection() answers for those and knows
  // nothing about this flag, measured with B live over a suppressed selection.
  let tabSelectedCellEl = null;
  // Task 16: set when positionSelToolbar() below takes .ed-seltb down over a
  // selection that left the viewport while staying alive, and cleared when
  // the bar goes back up. Its lifetime has to reach OUTSIDE the
  // `selToolbar.parentNode` gate in onAnyScroll(), because that gate is what
  // the removal turns against the bar: with the node detached the gate
  // returns before anything can re-ask.
  //
  // Measured on a paragraph selection in a document of filler paragraphs,
  // before this flag existed — scrolled to +150 the bar followed, its top
  // moving 192 -> 42; at +1500 it was gone from the DOM; scrolled back to the
  // top it stayed gone while the selection still read non-collapsed with its
  // rect back at top 234. A synthetic selectionchange dispatched at that
  // point put the bar back at top 192, which is what says the missing state
  // was the permission to re-ask rather than a live selection.
  //
  // Opposite polarity to tabSelectedCellEl above: that flag holds the bar
  // DOWN, this one lets it back UP. Keyed on neither a cell nor a Range — the
  // defect reproduces on a paragraph, where there is no cell to key on, and
  // the re-ask reads the selection back off the document when it fires. It
  // says nothing about WHY the bar is down right now: measured after a Tab
  // walk moved on from a scrolled-away selection, it read true while Task
  // 15's suppression was what held the bar down.
  let selToolbarOffViewport = false;
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
    // Task 15: the Tab suppression is part of the same "a session is open"
    // state, so it goes down with the rest of it.
    tabSelectedCellEl = null;
    // Task 16: same reasoning — "the bar is down because it scrolled out of
    // view" is a statement about an open session's selection, and there is no
    // session left to make it about.
    selToolbarOffViewport = false;
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
    // v3.1.0: the fixed toolbar's five inline-format buttons enable/disable on
    // exactly the same question this listener already answers ("is there a
    // non-collapsed selection inside `selToolbarEditEl`?"), so it piggybacks
    // here instead of attaching a SECOND document-level selectionchange
    // listener.
    //
    // That is not just tidiness. test/editor-client-runtime.test.js
    // instruments document.addEventListener for this exact type and asserts
    // the live count is 1 during a session and 0 after — the property being
    // that a burst's listener is removed on rerender and never stacks. A
    // permanent second listener would not leak or stack, but it would move
    // that counter's baseline and force three numeric assertions plus a
    // waitForFunction(count === 0) to be rewritten around it, weakening a
    // leak guard to accommodate a convenience. Reusing this one keeps the
    // guard exactly as written, and is also strictly more correct: with no
    // burst open `selToolbarEditEl` is null, so `hasSelection` is false —
    // which is precisely when this listener is not attached.
    try {
      const selNow = window.getSelection();
      if (!selNow || selNow.rangeCount === 0 || selNow.isCollapsed) { hideSelToolbar(); return; }
      const range = selNow.getRangeAt(0);
      if (!selToolbarEditEl ||
          !selToolbarEditEl.contains(range.startContainer) ||
          !selToolbarEditEl.contains(range.endContainer)) {
        hideSelToolbar();
        return;
      }
      // Task 15 (T15-5): a selection the Tab walk wrote keeps this bar down.
      // Asked here, below the collapsed exit above, on purpose — focusing a
      // cell parks a collapsed selection in it a moment before the walk writes
      // the real one, and releasing on that would let the bar up again on the
      // very press this is suppressing.
      //
      // The BOUNDARY comparison is the working half: it says whether this is
      // still the Tab's own selection or one the user has since built by hand,
      // and each of its four terms was ablated on its own against a selection
      // differing in that term alone — every one of them left its own input
      // wrongly suppressed, and no other.
      //
      // The isConnected term is belt and braces, and honestly so: ablating it
      // changed no measured behaviour, because a detached cell fails the
      // boundary comparison as well. It is asked anyway because the cell
      // element is the only handle that can be asked at all — driven across a
      // commit that took the full-render route, a Range built over a cell
      // beforehand reported startContainer.isConnected true and covered the
      // empty string afterwards, while that same cell reported isConnected
      // false. A Range collapses in silence, so a release keyed on one would
      // fire during a re-render of its own accord.
      if (tabSelectedCellEl) {
        if (tabSelectedCellEl.isConnected &&
            range.startContainer === tabSelectedCellEl && range.startOffset === 0 &&
            range.endContainer === tabSelectedCellEl &&
            range.endOffset === tabSelectedCellEl.childNodes.length) {
          hideSelToolbar();
          return;
        }
        tabSelectedCellEl = null;
      }
      positionSelToolbar(range);
    } finally {
      // In a `finally` so every early return above still refreshes the bar —
      // the collapse-to-caret exits are exactly the ones that must turn the
      // mark buttons back off.
      updateToolbar();
    }
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

  // Extracts the range's contents into `el`, puts `el` where the range was,
  // and drops the marks the extraction emptied — the fused form of
  // collectLeftovers() + dropEmptied() above, which is all an extractContents()
  // call site needs. applyMarkToggle()'s wrap branch reaches it through
  // wrapRangeIn() below; applyLinkToggleBody()'s new-link path calls it
  // directly. A native Ctrl+B does not arrive here at all: client.js binds no
  // Ctrl/Cmd + b/i/u, so that keystroke reaches the contenteditable as the
  // browser's own execCommand and produces a <b>. The journey suite drives
  // that keystroke and the toolbar button side by side, each with its own tag
  // pattern, for exactly that reason.
  function extractRangeInto(range, el, root) {
    const leftovers = collectLeftovers(range, root);
    el.appendChild(range.extractContents());
    range.insertNode(el);
    dropEmptied(leftovers);
    return el;
  }

  // Wraps the range's contents in a brand-new `<tag>` element via Range
  // surgery (extractContents/insertNode — plain DOM Range methods, NOT
  // execCommand). Returns a Range spanning the new element's contents.
  function wrapRangeIn(range, tag, root) {
    const el = extractRangeInto(range, document.createElement(tag.toLowerCase()), root);
    const r = document.createRange();
    r.selectNodeContents(el);
    return r;
  }

  // v3.2.1: 在字元空間修剪 Range 的前後空白，再交給 wrapRangeIn()。
  // 不用 startOffset/endOffset 步進：當邊界容器是【元素節點】時那些 offset
  // 索引的是【子節點】而非字元，一次遞減會跳過整個文字節點。實測人類拖曳
  // 選取 105 次都不會產生元素邊界，但編輯器自己的 reselectAndReposition() 會。
  function trimRangeToText(range) {
    const parts = [];
    const take = (n) => {
      const len = n.data.length;
      let a, b;
      try { a = range.comparePoint(n, 0); b = range.comparePoint(n, len); }
      catch (e) { return; }
      if (b < 0 || a > 0) return;                 // 整個節點落在範圍外
      const from = (n === range.startContainer && n.nodeType === 3) ? range.startOffset : 0;
      const to = (n === range.endContainer && n.nodeType === 3) ? range.endOffset : len;
      if (to > from) parts.push({ n: n, from: from, to: to });
    };
    const root = range.commonAncestorContainer;
    const walk = (node) => {
      if (node.nodeType === 3) { take(node); return; }
      for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
    };
    // v3.2.1 review: root.nodeType === 3 的情況已經由 walk() 自己的
    // `node.nodeType === 3` 分支正確處理（single-text-node 選取時
    // startContainer/endContainer 必為同一個 text node，也就是這裡的
    // root——take() 的 `n === range.startContainer`／`n === range.endContainer`
    // 判斷照樣成立）。原本 `root.nodeType === 3 ? root : root` 兩支完全相同，
    // 是無效的死碼，這裡直接呼叫 walk(root)；journey 測試（選取整個落在單一
    // text node 內）已驗證這條路徑產出正確的 from/to。
    walk(root);
    if (!parts.length) return false;
    // 從頭砍掉空白
    while (parts.length) {
      const p = parts[0];
      while (p.from < p.to && /\s/.test(p.n.data[p.from])) p.from++;
      if (p.from < p.to) break;
      parts.shift();
    }
    // 從尾砍掉空白
    while (parts.length) {
      const p = parts[parts.length - 1];
      while (p.to > p.from && /\s/.test(p.n.data[p.to - 1])) p.to--;
      if (p.to > p.from) break;
      parts.pop();
    }
    if (!parts.length) return false;              // 全空白選取 → 不包裝
    range.setStart(parts[0].n, parts[0].from);
    range.setEnd(parts[parts.length - 1].n, parts[parts.length - 1].to);
    return true;
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
      snapBurstIfActive(root, 'mark-pre');
      reselectAndReposition(unwrapElement(whole));
      snapBurstIfActive(root, 'mark');
      return;
    }
    const overlapping = overlappingMarks(range, tag, root);
    if (overlapping.length > 0) {
      snapBurstIfActive(root, 'mark-pre');
      const extended = extendRangeOverMarks(range, overlapping);
      // Re-query against the EXTENDED range: `overlapping` above was
      // computed from the original (smaller) range, and every mark the
      // extended range now fully covers must be removed.
      overlappingMarks(extended, tag, root).forEach((m) => unwrapElement(m));
      reselectAndReposition(extended);
      snapBurstIfActive(root, 'mark');
      return;
    }
    if (!trimRangeToText(range)) return;   // 全空白／collapsed 選取：no-op
    snapBurstIfActive(root, 'mark-pre');
    reselectAndReposition(wrapRangeIn(range, tag, root));
    snapBurstIfActive(root, 'mark');
  }

  // Resolves once a `focusout` has been dispatched at `el` AND that dispatch
  // has fully finished, or after `ms` milliseconds if no focusout arrives at
  // all — whichever comes first.
  //
  // Two things about it are load-bearing and both were measured on the 🔗
  // gesture:
  //
  //  * The wait is needed because the blur a native modal causes is delivered
  //    on the browser's own schedule, NOT as a task queued by the code that
  //    opened the modal: window.prompt() returned at t=27ms and the focusout
  //    landed at t=28ms, i.e. after the caller had already returned. So a plain
  //    setTimeout(0) is not a substitute for listening.
  //  * The resolve is handed to a TIMER rather than called from the listener.
  //    A listener's own resolve() only queues a microtask, and the HTML spec
  //    performs a microtask checkpoint after EACH listener callback of a
  //    browser-initiated dispatch — so an awaiter resumed from there runs
  //    BEFORE the document-level focusout delegator further along the same
  //    propagation path, and therefore before anything that delegator starts
  //    exists to be waited on. Measured exactly that way: resolving from the
  //    listener left `switching` still null at the awaiter, and the caret was
  //    lost to the render that followed. A timer moves the resume to the next
  //    task, after the whole dispatch.
  function nextFocusout(el, ms) {
    return new Promise((resolve) => {
      let deadline = null;
      const finish = () => {
        el.removeEventListener('focusout', onFocusout);
        if (deadline !== null) { clearTimeout(deadline); deadline = null; }
        resolve();
      };
      const onFocusout = () => { setTimeout(finish, 0); };
      el.addEventListener('focusout', onFocusout);
      deadline = setTimeout(finish, ms);
    });
  }

  // v3.2.1: THIN WRAPPER over the toggle body below, same shape as
  // convertBlockViaMenu() — but the restoration cannot sit in a plain
  // synchronous finally here, and that is the whole difference. MEASURED, with
  // an in-page focus/mutation trace on the 🔗 button:
  //
  //   t=21ms  window.prompt() entered      t=27ms  prompt() returned
  //   t=28ms  focusout on the armed surface (the modal's own blur, delivered
  //           after the body had already finished its DOM surgery)
  //   t=31ms  focusin — the browser hands focus straight back
  //   t=52ms  a SECOND focusout, this one from applyFullRender() (captured
  //           stack: applyFullRender <- applyRenderResult <- rerenderAll)
  //   t=66ms  document.activeElement === BODY, toolbar down to 4 buttons
  //
  // So the thing that costs the user their foothold is not the modal: focus
  // comes back on its own. It is that the document's focusout delegator read
  // the modal's blur as "the user left this surface" and ran switchAwayFrom()
  // -> resolveBurst() -> commitEdit() -> rerenderAll(), and that render
  // replaced the whole .content subtree the restored focus was sitting in.
  // The other four inline-format buttons (toolbar-model.js's `group: 'inline'`
  // is bold / italic / strike / inline-code / link — five, of which link is
  // this one) never hit this, because none of them opens a modal and so none
  // of them ever blurs.
  //
  // The two awaits below are therefore each waiting for one specific thing:
  // nextFocusout() for that blur to be dispatched at all, and `switching` for
  // the commit + render it started to finish. Only then is there a live block
  // to aim at.
  async function applyLinkToggle() {
    const root = selToolbarEditEl;
    const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
    // hasFormattableSelection() is the body's own four guards spelled once (see
    // its comment). When it is false the body returns before it can reach
    // window.prompt(), so there is no modal, no blur, and nothing to wait for.
    // Waiting anyway would stall this call for the whole timeout and then move
    // the caret to the end of a block the user never edited.
    //
    // ⚠ Final wave, I3. `willPrompt` is a NECESSARY condition for a modal, not
    // a sufficient one, and the sentence that used to stand at the restore
    // said otherwise. Those four guards do match the body's four, but the body
    // has a FIFTH pre-prompt exit they know nothing about: the
    // `overlapping.length > 0` branch, where a selection that only PARTIALLY
    // overlaps an existing link unwraps it and returns without ever calling
    // window.prompt(). MEASURED on ddac6ce — selecting `lpha lin` across
    // `Alpha <a>linked</a> …` and clicking 🔗 gave `dialogs: 0` while
    // `willPrompt` was true. Behaviour was still correct there, but only
    // because the `stillHeld` gate below happened to catch it; the guarantee
    // the comment claimed did not exist. So the body now REPORTS whether it
    // prompted and the wait is gated on that report rather than on the
    // prediction. `blurred` still has to be ARMED before the body runs (the
    // blur it waits for is caused from inside it) — an armed-but-unused
    // promise settles on its own 400ms timeout, which removes its own listener
    // and resolves nobody.
    const willPrompt = hasFormattableSelection(sel);
    // Captured BEFORE the body: `selToolbarEditEl` is one of the things the
    // render nulls. The LINE survives that render — resolveBurst() commits
    // through commitEdit(state, burst.blockId, newText), an in-place replace of
    // this block's own line range, and ops.shiftBlocks() only shifts blocks
    // whose id is GREATER than the edited one, so nothing can move this block's
    // own start line.
    const rec = willPrompt && root && root.closest
      ? blockRecOf(root.closest('.ed-block')) : null;
    const line = rec ? rec.startLine : null;
    // Armed before the body runs, because the blur it is waiting for is caused
    // by a call inside the body. The timeout is the fallback for a browser that
    // does not blur on a modal at all; its cost when it fires is one caret
    // moved to the end of the block the link was just written into.
    const blurred = willPrompt && root ? nextFocusout(root, 400) : null;
    let prompted = false;
    try {
      prompted = applyLinkToggleBody() === true;
    } finally {
      if (blurred && prompted) {
        await blurred;
        if (switching) await switching;
        // Fix round 1, item 1: reaching here means the modal DID open (the
        // body said so), not that the user confirmed it. On Esc / cancel the body does no DOM
        // surgery, the burst goes out through endBurstWithoutResolve(), there
        // is no commit and no render — and the focus the modal took comes back
        // by itself (the t=31ms focusin in the trace above). Restoring on top
        // of that collapses the user's selection to a caret at the block's end.
        // Driven, 🔗 then Esc: with this gate the selection is still 'Alpha'
        // (non-collapsed, 20 buttons); without it, '' and collapsed.
        //
        // So the restore only fires when the foothold is actually GONE. The
        // accept path is unaffected — the render has just run and
        // activeElement is BODY there — and a 400ms timeout misfire becomes
        // harmless for the same reason.
        const held = document.activeElement;
        const stillHeld = held && held.closest &&
          held.closest('.ed-wys-armed, .ed-wys-cell, .ed-raw');
        // 有 blockSelection 站著時什麼都不做 —— 與 convertBlockViaMenu() 同一個
        // 判準、同一個理由：強行還原 caret 會做出「底色仍說已選取、Delete 卻是
        // 死鍵」的混種狀態。
        if (!stillHeld && !blockSelection && line != null) {
          focusBlockAtLine(line, true);   // caretToEnd
        }
        // ⚠ C1, second occurrence of the same root cause. The re-aim used to
        // sit INSIDE the `!stillHeld` branch, so a call that kept its foothold
        // restored nothing at all — and on the PATCH render path (every commit
        // after a page load's first) applyPatch() hands focus back to the new
        // surface and only THEN runs resetToolbarBlock(), so "foothold held"
        // and "bar collapsed to 4" are the ordinary combination, not a
        // contradiction. Measured, 🔗 accept: unprimed P.ed-wys-armed/15,
        // primed P.ed-wys-armed/4. The caret restore stays gated (fix round
        // 1's Esc/cancel finding); only the bar comes out.
        if (!blockSelection && line != null) {
          // 就【這個還原目前所攜帶的座標】（一個 block 的起始行）而言，TABLE
          // 儲存格是還原不回 caret 的形狀：`root` 是 CELL，但 `line` 只能指到
          // 整張表這個 block，而 blockContentEl() 對 table 回傳
          // firstElementChild ＝ <table> 本身，它沒有 tabindex、focus() 是
          // no-op。實測結果因此是 journey 的 bar-only 形狀（V2d 釘住）：連結
          // 正確寫進磁碟、工具列 15 顆仍瞄著那張表，但 activeElement 是 BODY。
          // 這不是死路 —— 儲存格的 (row, col) 在 re-render 之間是穩定的，帶著
          // 它就能還原；只是本版沒有帶。reaim 是目前這個形狀下唯一還拿得回來
          // 的東西 —— 沒有它工具列會塌成 4 顆。
          reaimToolbarBlockAtLine(line);
        }
      }
    }
  }

  // Link is its own entry point (not applyMarkToggle) because "unwrap" here
  // means "prompt to edit or clear the URL", and "wrap" means "prompt for a
  // URL first" — both need window.prompt() before any DOM surgery happens.
  //
  // Final wave, I3: returns TRUE iff this call actually reached a
  // window.prompt(), and false on every exit that did not — the four guards at
  // the top AND the partial-overlap unwrap in the middle, which is the one the
  // wrapper's `willPrompt` prediction cannot see. The wrapper waits for the
  // modal's blur only on a true.
  function applyLinkToggleBody() {
    const root = selToolbarEditEl;
    if (!root) return false;
    const sel = window.getSelection();
    if (!sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return false;
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return false;

    const whole = wholeSelectionMark(range, 'A', root);
    if (whole) {
      const url = window.prompt('連結網址（留空以移除連結）：', whole.getAttribute('href') || '');
      if (url === null) return true; // cancelled — leave the link untouched
      snapBurstIfActive(root, 'mark-pre');
      if (url.trim() === '') {
        reselectAndReposition(unwrapElement(whole));
      } else {
        whole.setAttribute('href', url.trim());
        reselectAndReposition(range);
      }
      snapBurstIfActive(root, 'mark');
      return true;
    }
    const overlapping = overlappingMarks(range, 'A', root);
    if (overlapping.length > 0) {
      snapBurstIfActive(root, 'mark-pre');
      const extended = extendRangeOverMarks(range, overlapping);
      overlappingMarks(extended, 'A', root).forEach((m) => unwrapElement(m));
      reselectAndReposition(extended);
      snapBurstIfActive(root, 'mark');
      return false;   // unwrapped in place — no modal ever opened
    }
    const url = window.prompt('連結網址：', 'https://');
    if (url === null || url.trim() === '') return true; // cancelled or empty — no-op
    snapBurstIfActive(root, 'mark-pre');
    const el = document.createElement('a');
    el.setAttribute('href', url.trim());
    extractRangeInto(range, el, root);
    const r = document.createRange();
    r.selectNodeContents(el);
    reselectAndReposition(r);
    snapBurstIfActive(root, 'mark');
    return true;
  }

  // The .ed-seltb buttons, paired with the mark each one toggles, for
  // paintSelToolbarMarks() below. Filled by buildSelToolbar(), which runs once.
  const selToolbarMarkBtns = [];

  function buildSelToolbar() {
    const el = document.createElement('div');
    el.className = 'ed-seltb';
    function addBtn(cls, label, ariaLabel, tag, onClick) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ed-seltb-btn ' + cls;
      b.textContent = label;
      b.setAttribute('aria-label', ariaLabel);
      b.setAttribute('aria-pressed', 'false');
      selToolbarMarkBtns.push({ btn: b, tag: tag });
      // Keep the DOM selection intact across the click: without this, the
      // button (outside the contenteditable root) stealing focus on
      // mousedown would collapse the selection before the click handler
      // ever runs, leaving nothing left to act on.
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
      el.appendChild(b);
      return b;
    }
    addBtn('ed-seltb-b', 'B', 'Bold', 'STRONG', () => applyMarkToggle('STRONG'));
    addBtn('ed-seltb-i', 'I', 'Italic', 'EM', () => applyMarkToggle('EM'));
    addBtn('ed-seltb-s', 'S', '刪除線', 'DEL', () => applyMarkToggle('DEL'));
    addBtn('ed-seltb-u', 'U', '底線', 'U', () => applyMarkToggle('U'));
    addBtn('ed-seltb-code', '<>', 'Code', 'CODE', () => applyMarkToggle('CODE'));
    addBtn('ed-seltb-link', '\u{1F517}', 'Link', 'A', () => applyLinkToggle());
    return el;
  }

  // v3.3.0 (F2): the floating bar's own four-state painting, from the same
  // `ctx.marks` the fixed toolbar's five are derived from.
  //
  // ⚠ `aria-disabled`, never the `disabled` property. Each of these buttons
  // keeps the selection alive across its own click through the `mousedown`
  // preventDefault() addBtn() installs above, and a disabled <button>
  // dispatches no mousedown at all, so that preventDefault would never run.
  //
  // MEASURED, real mouse press (move / down / 80ms / up) on the B button over
  // an inert selection, with a capture-phase counter on `document` and a click
  // counter on the button itself. As it ships:
  //   {"active":"P.ed-wys-armed","sel":" ","seltb":true,"downs":1,"clicks":1}
  // and the block's innerHTML byte-identical before and after. The same press
  // with `disabled` set on that button instead:
  //   {"active":"BODY.","sel":" ","seltb":false,"downs":0,"clicks":0}
  // — no mousedown reaches the document at all, the focus lands on BODY and
  // the bar is gone by the time the press ends. buildToolbar() can afford
  // `disabled` on the fixed bar because it installs a capture-phase
  // `pointerdown` guard on that bar's container; there is no such
  // container-level interception here.
  //
  // So the press on an inert button still runs applyMarkToggle(), which is
  // fine: the same measurement shows the block unchanged. Nothing here needs
  // to intercept it.
  let selToolbarMarkSig = null;
  function paintSelToolbarMarks(marks) {
    const sig = JSON.stringify(marks);
    if (sig === selToolbarMarkSig) return;
    selToolbarMarkSig = sig;
    selToolbarMarkBtns.forEach((entry) => {
      const m = marks ? marks[entry.tag] : null;
      entry.btn.setAttribute('aria-pressed',
        m === 'whole' ? 'true' : (m === 'partial' ? 'mixed' : 'false'));
      if (m === 'inert') entry.btn.setAttribute('aria-disabled', 'true');
      else entry.btn.removeAttribute('aria-disabled');
    });
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
    // v3.2.1: 原本的零矩形檢查是死碼 —— 實測捲出視野的 Range 仍保有
    // 151x17 的矩形，永遠到不了這一支。改成真正的視窗外檢查。
    const topInset = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--ed-toolbar-h')) || 0;
    if (rect.bottom <= topInset || rect.top >= window.innerHeight ||
        rect.right <= 0 || rect.left >= window.innerWidth) {
      // Task 16: of the exits that take this bar down, this is the one that
      // leaves a live selection behind, so it is the one that arms the
      // re-ask on scroll. Walked by grepping hideSelToolbar(), its other
      // callers are reached by a session ending, by the selection collapsing
      // or leaving the edit root, by Task 15's Tab suppression, or by a mark
      // toggle with no range to reselect.
      selToolbarOffViewport = true;
      hideSelToolbar(); return;
    }
    if (!selToolbar.parentNode) document.body.appendChild(selToolbar);
    selToolbarOffViewport = false;
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
    // mouseup) that commit's /api/render round trip can finish and REPLACE
    // THE BLOCK ELEMENT inside `.content` — detaching THIS very button,
    // which lives in that block — before mouseup. (`.content` itself is
    // NOT swapped: applyFullRender() assigns `contentEl.innerHTML`, which
    // rebuilds its children but keeps the element, and the patch route
    // removes just the one block; both were traced, see the v3.3.0 note
    // below.) A click event never fires at all for a target removed from the
    // document between mousedown and mouseup: the first click is silently
    // eaten (no menu opens), and only a second click on the fresh,
    // re-armed handle actually works. preventDefault() here stops the
    // button from stealing focus in the first place, so a dirty burst's
    // own ⠿ click never triggers that race.
    // §10-gap fix: same reasoning as the ⠿ handle above, for the ＋ insert
    // button — a mousedown-triggered blur on a dirty burst elsewhere would
    // otherwise race this button's own click the exact same way.
    // v3.3.0 階段 0: the two MENU-ITEM classes join the list. `.ed-handle` /
    // `.ed-insert` are the buttons that OPEN the menus;
    // `.ed-handle-menu-btn` / `.ed-insert-menu-btn` are the items INSIDE them
    // (buildGutterMenu()/buildInsertMenu() give every item one of those two
    // classes), and neither menu's items carry a mousedown preventDefault()
    // of their own. The ⠿/＋ gutter builds exactly four kinds of pressable
    // BUTTON — the handle, the ＋ button, a gutter-menu item (the 轉換成
    // submenu's buttons share that class) and an insert-menu item — and
    // before this line only the first two were covered. The menu PANEL
    // itself (`div.ed-handle-menu`, which has padding) is deliberately not
    // in that list: a press landing in the gap between two items still
    // steals focus, and is out of scope here.
    //
    // Trace taken with ONLY `.ed-handle`/`.ed-insert` in this list, dirty
    // burst on the block, an 80 ms press on 建立副本, listeners on mousedown /
    // focusout / fetch / mouseup / click plus a MutationObserver naming the
    // removed node (unprimed fallback route | primed patch route):
    //
    //   +7ms  | +5ms  mousedown on .ed-handle-menu-btn, defaultPrevented=false
    //   +7ms  | +5ms  focusout on the burst's .ed-wys-armed, activeElement→BODY
    //   +8ms  | +6ms  POST /api/render   (the focusout handler's commit)
    //   +28ms | +12ms response applied — the removed node is the BLOCK ELEMENT,
    //                 removed from `.content` (which keeps its own identity)
    //                 and replaced by a different node with the same
    //                 data-block-id; the fallback rebuilds all of `.content`'s
    //                 children, the patch route removes just this one. The menu
    //                 — parked by toggleGutterMenu()/toggleInsertMenu() with
    //                 blockEl.appendChild() — is removed WITH the block.
    //   +93ms | +91ms mouseup, target now the replacement block's surface, and
    //                 NO click event at all: the pressed node left the document
    //                 between mousedown and mouseup.
    //
    // Same trace with these two selectors added: no focusout and no
    // /api/render before mouseup — the item keeps its click, and the commit
    // runs afterwards from inside the item's own handler.
    document.addEventListener('mousedown', (e) => {
      // T21 item 2: pointing at something is the other way (besides pressing a
      // key that is not Tab — see handleBurstKeydown()) of saying the walk is
      // over. A click that lands on the SAME surface the walk arrived at does
      // not open a new burst, so without this the mark would survive a
      // deliberate caret placement and the next Tab would leave instead of
      // indenting the item the user had just aimed at.
      if (currentBurst) currentBurst.arrivedByTab = false;
      if (e.target && e.target.closest &&
          (e.target.closest('.ed-handle') || e.target.closest('.ed-insert') ||
           e.target.closest('.ed-handle-menu-btn') ||
           e.target.closest('.ed-insert-menu-btn'))) e.preventDefault();
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
    // T21 item 1: an Escape that discarded a burst leaves exactly one thing
    // for the next Ctrl+Z to undo, and it is not on this stack — the burst
    // never committed, so `lines` never saw it. restoreDiscardedBurst()
    // answers false whenever there is no such thing (which is almost always),
    // and the ordinary document undo below runs untouched.
    if (restoreDiscardedBurst()) return;
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
    // v3.2.0: UndoStack.undo()/discardTop() reverse the op when applying it but
    // return the unmodified FORWARD op, so the range actually rewritten is
    // [op.startLine, op.startLine + op.after.length - 1] and the delta is the
    // mirror of the forward one. Using op.endLine here would name the opposite
    // direction — the span the op wrote on the way FORWARD, not the one this
    // reversal just rewrote.
    //
    // Final review item 4 — what naming it wrongly would cost today: nothing.
    // Per 決議 4(b) `editRange` is ADVISORY. patchmap() destructures
    // oldBlocks/newBlocks/oldParts/newParts and never reads it; the kept
    // prefix/suffix is the longest common run of the two PART arrays, and
    // seeding it from an op's line range only ever made the answer worse
    // (measured in 決議 4(b): seeded kept 0 of 5, pure-parts kept 4 of 5).
    // Its one client-side use is the truthiness gate in applyRenderResult().
    // So the direction changes no plan — this is simply the correct value for
    // whenever something does start reading it.
    const editRange = r.op
      ? { startLine: r.op.startLine,
          endLine: r.op.startLine + r.op.after.length - 1,
          delta: r.op.before.length - r.op.after.length }
      : undefined;
    const ok = await safeRerenderAll(editRange);
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
    // redo() is NOT reversed — it goes through
    // replaceLines(lines, op.startLine, op.endLine, op.after), so the
    // ordinary forward formula applies here, unlike undo() above.
    const editRange = r.op
      ? { startLine: Math.min(r.op.startLine, r.op.endLine + 1),
          endLine: Math.max(r.op.startLine - 1, r.op.endLine),
          delta: r.op.after.length - r.op.before.length }
      : undefined;
    const ok = await safeRerenderAll(editRange);
    if (!ok) {
      // Reverse the redo attempt: pop the op back off and restore `lines`.
      const rollback = stack.undo(lines);
      lines = rollback ? rollback.lines : prevLines;
    }
  }

  // ── v3.1.0 §4: the always-visible editing toolbar ──────────────────────
  // The version's headline feature: before this there was no toolbar at all,
  // and every editing affordance was hidden behind a hover gutter, a caret
  // position or a text selection. window.md2docToolbarModel (injected by
  // server.js, built and reviewed as lib/editor/toolbar-model.js) owns the
  // 23-button roster, the group order that decides separator placement, and
  // the whole active/disabled derivation; everything below is mounting and
  // wiring. Nothing here re-derives a button's state by hand — a second
  // opinion about when ⇥ is legal is exactly what the pure-module split
  // exists to prevent.
  //
  // EVERY existing entry point stays: the ⠿ menu, the ＋ menu and the
  // floating selection toolbar are untouched. This is one more road to the
  // same operations, not a replacement for any of them.
  let toolbarEl = null;
  let toolbarBtns = null;   // { [buttonId]: HTMLButtonElement }
  let toolbarMenuEl = null; // the H▾ dropdown panel, or null when closed
  let toolbarBlockEl = null;
  let toolbarStateSig = '';
  // 追加 4's document mode: 'edit' | 'source'. v3.2.1 removed the third
  // state ('preview'); docsource.js's MODES comment records why.
  // docsource.js owns the cycle order and the lines[]<->string conversion.
  let docMode = 'edit';
  let sourceTextarea = null;
  let sourceBaseLines = null;
  // 追加 2: Ctrl+Shift+V arms a plain-text-only paste for the NEXT paste
  // event. A ClipboardEvent carries no modifier state of its own, so the
  // intent has to be captured on the keystroke that produced it.
  let plainPasteArmed = false;

  const TOOLBAR_UNSUPPORTED_IMAGE_MESSAGE = '只接受 PNG / JPEG / GIF / WebP 圖片';
  const TOOLBAR_NO_ANCHOR_MESSAGE = '找不到可以插入圖片的位置';

  // Extra visual classes for the three inline buttons whose own glyph is the
  // affordance (B is bold, I is italic, S is struck through) — the same
  // idiom .ed-seltb-b/-i/-s use.
  const TOOLBAR_BTN_CLASS = {
    bold: 'ed-toolbar-b', italic: 'ed-toolbar-i', strike: 'ed-toolbar-s',
  };

  // The buttons whose model state can ever report `active: true` — i.e. the
  // real toggles, and the only ones that may carry aria-pressed. Every other
  // button is a command, not a toggle.
  // v3.2.0: derived, not mirrored. Adding a toggle to toolbar-model.js used to
  // need a matching edit here, and forgetting it made aria-pressed lie.
  //
  // v3.3.0 (F2), recorded rather than changed: `check` is outside this set on
  // purpose. It is `toggle: false` while its conversion-group siblings quote /
  // code / list / ordered-list are `toggle: true`, which is honest only for as
  // long as deriveState() never sets `check.active` — and it does not: that
  // function assigns nothing to `state.check` beyond the disabled flags every
  // button gets. What would change that is a rule lighting ☑ when the current
  // block is already a task item. The flag would have to flip in the same
  // edit, because this set is what decides whether aria-pressed is written at
  // all, and a button that can report `active` while sitting outside it says
  // nothing where it should say `true`.
  const TOOLBAR_TOGGLE_IDS = new Set(
    (toolbarModel ? toolbarModel.BUTTONS : []).filter((b) => b.toggle).map((b) => b.id));

  // The block the bar currently reports on, or null. `null` is the model's
  // documented no-block state (undo/redo/outline/preview live, everything
  // else greyed), which is exactly what rerenderAll()'s teardown wants — see
  // resetToolbarBlock() below.
  function liveToolbarBlock() {
    if (toolbarBlockEl && document.body.contains(toolbarBlockEl)) return toolbarBlockEl;
    toolbarBlockEl = null;
    return null;
  }

  // Called from rerenderAll()'s belt-and-braces teardown. A detached node's
  // getAttribute() still answers, so a tracked block that survived the
  // .content swap would keep the bar reporting a block no click can reach.
  function resetToolbarBlock() {
    toolbarBlockEl = null;
    closeToolbarMenu();
    updateToolbar();
  }

  // v3.2.1: point the bar back at the block a structural op just produced.
  //
  // rerenderAll()'s teardown calls resetToolbarBlock() (toolbarBlockEl = null,
  // bar repainted in its no-block state: 4 enabled buttons), and nothing
  // re-points it unless a focusin/click lands on a block. That is fine when
  // the op ends with focusBlockAtLine() — the surface's focus event runs
  // wireToolbarTracking()'s focusin handler, which does exactly this. It is
  // NOT fine for a target with no focusable surface (quote / code / hr), where
  // focusBlockAtLine() silently no-ops and the bar would stay collapsed on a
  // block that is right there on screen. updateToolbar() is what repaints;
  // resetToolbarBlock() is idempotent, so re-pointing after it is safe.
  // Resolves nothing and touches nothing when `line` is null or the block is
  // gone (a refusal, a rolled-back render).
  function reaimToolbarBlockAtLine(line) {
    if (line == null) return;
    const target = blocks.find((b) => b.startLine === line);
    if (!target) return;
    const blockEl = document.querySelector('.ed-block[data-block-id="' + target.id + '"]');
    if (!blockEl) return;
    toolbarBlockEl = blockEl;
    updateToolbar();
  }

  // Final review item 5: the EXACT predicate applyMarkToggle() and
  // applyLinkToggle() gate on — all four of their conditions, not three.
  // Kept as one function so the toolbar's enablement and the actions' own
  // refusal cannot drift apart: whenever this says true, both actions run.
  //
  // The fourth condition (containment) is the one `hasSelection` used to
  // omit, and it is reachable: a drag-select that STARTS inside an open
  // burst and ENDS in the next block leaves the selection non-collapsed with
  // `selToolbarEditEl` still set. The floating selection toolbar already
  // asks this same question of itself and correctly hides (see its
  // selectionchange listener above), but updateToolbar() still ran and lit
  // the five inline-format buttons over a selection every one of them
  // silently refuses — precisely the dead-button failure this version's
  // enablement wiring exists to remove.
  function hasFormattableSelection(sel) {
    if (!selToolbarEditEl || !sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return false;
    return selToolbarEditEl.contains(range.startContainer) &&
      selToolbarEditEl.contains(range.endContainer);
  }

  // The mark elements the toolbars toggle. 'U' is here because .ed-seltb has a
  // U button (buildSelToolbar(), earlier in this file); toolbar-model.js's
  // MARK_TAG_BY_ID covers the fixed toolbar's inline group and does not
  // mention it.
  const MARK_TAGS = ['STRONG', 'EM', 'DEL', 'CODE', 'A', 'U'];

  // v3.3.0 (F2): which of those marks the current selection is in, as the
  // four-state vocabulary both toolbars paint from — or null when there is no
  // formattable selection at all. The three non-null states below name the
  // branch applyMarkToggle() would take on that tag, in its own order:
  //
  //   'whole'   `wholeSelectionMark()` hit — the unwrap branch.
  //   'partial' `overlappingMarks()` non-empty — the extend-and-unwrap branch.
  //   'none'    neither — the wrap branch, which would wrap something.
  //   'inert'   neither, and the wrap branch would refuse.
  //
  // Two things about 'inert' are load-bearing and neither is guessable from
  // the button:
  //
  //  * It is asked per tag, not once. Only applyMarkToggle()'s THIRD branch is
  //    guarded by trimRangeToText(); the first two run to completion on an
  //    all-whitespace selection. MEASURED: with the single space inside
  //    `**bold text**` selected, pressing B took the unwrap branch — the
  //    <strong> was gone, the paragraph's text was unchanged, and the file
  //    saved back with no `**` in it. So drawing every button inert there
  //    would grey out a button that acts.
  //  * 'A' never reaches it. The link button does not go through
  //    applyMarkToggle() at all — applyLinkToggleBody() above has the same
  //    first two branches but its third calls window.prompt() and
  //    extractRangeInto() with no trim guard anywhere, so an all-whitespace
  //    selection prompts and wraps. MEASURED: selecting the single space in
  //    `Alpha bold text …` and pressing 🔗 raised the dialog 「連結網址：」 and
  //    left `Alpha<a href="https://probe/"> </a>bold text …` in the block. So
  //    drawing 🔗 inert there would grey out a button that acts.
  //
  // trimRangeToText() is tag-independent, so it is asked once. It is asked
  // with a CLONE: it calls setStart/setEnd on the range it is handed whenever
  // it returns true, and this function runs on every selectionchange, so the
  // live range would have the user's own selection edges pulled in off every
  // caret move that the open burst's selectionchange listener hears. `wholeSelectionMark()` and `overlappingMarks()` take the live
  // range. test/editor-journey.test.js drives a keyboard selection across a
  // marked run and asserts, at each step, that the range's boundary points are
  // byte-identical either side of the selectionchange dispatch and that the
  // string it covers has grown by one character. Ablated to check the suite can
  // see it: putting a setStart() into wholeSelectionMark(), and again into
  // overlappingMarks(), each turned the suite red.
  function selectionMarkStates(sel) {
    if (!hasFormattableSelection(sel)) return null;
    const root = selToolbarEditEl;
    const range = sel.getRangeAt(0);
    const wrappable = trimRangeToText(range.cloneRange());
    const out = {};
    for (const tag of MARK_TAGS) {
      if (wholeSelectionMark(range, tag, root)) out[tag] = 'whole';
      else if (overlappingMarks(range, tag, root).length > 0) out[tag] = 'partial';
      else if (wrappable || tag === 'A') out[tag] = 'none';
      else out[tag] = 'inert';
    }
    return out;
  }

  // ctx for toolbarModel.deriveState(). Every field is read off the DOM /
  // `lines` at call time; nothing is cached, so a stale value cannot outlive
  // a render.
  function toolbarContext() {
    const blockEl = liveToolbarBlock();
    const blockType = blockEl ? blockEl.getAttribute('data-block-type') : null;
    let headingDepth = 1;
    if (blockType === 'heading') {
      const rec = blockRecOf(blockEl);
      if (rec && rec.endLine >= rec.startLine) headingDepth = headingDepthOf(lines[rec.startLine - 1]);
    }
    const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
    return {
      blockType: blockType,
      indent: blockEl ? (Number(blockEl.getAttribute('data-indent')) || 0) : 0,
      headingDepth: headingDepth,
      inList: blockType === 'li',
      listOrdered: !!blockEl && blockEl.getAttribute('data-list-type') === 'ol',
      // The mark buttons act through applyMarkToggle()/applyLinkToggle();
      // hasFormattableSelection() (just above) is their refusal test spelled
      // once, rather than a looser "is anything selected anywhere on the page".
      hasSelection: hasFormattableSelection(sel),
      // The identity behind that boolean: selectionMarkStates() (just above)
      // measures it here because toolbar-model.js may not touch the DOM, and
      // .ed-seltb is painted from the same measurement — see updateToolbar().
      marks: selectionMarkStates(sel),
      mode: docMode,
    };
  }

  function updateToolbar() {
    if (!toolbarEl || !toolbarBtns || !toolbarModel) return;
    const ctx = toolbarContext();
    // Both bars, one measurement. paintSelToolbarMarks() runs BEFORE the `sig`
    // early-return below, because that signature is built from the toolbar's
    // own buttons and .ed-seltb has one — U — that none of them speaks for:
    // moving the selection between plain text and a <u> run changes nothing in
    // `state`, so the early return would fire and U would keep whatever it last
    // said. Pinned by a journey row that drives exactly that move.
    paintSelToolbarMarks(ctx.marks);
    const state = toolbarModel.deriveState(ctx);
    // selectionchange fires on every caret move, so the state is diffed
    // before any DOM is written — 22 attribute writes per keystroke is a
    // cost with no matching benefit.
    const sig = JSON.stringify(state);
    if (sig === toolbarStateSig) return;
    toolbarStateSig = sig;
    Object.keys(toolbarBtns).forEach((id) => {
      const st = state[id];
      const btn = toolbarBtns[id];
      if (!st || !btn) return;
      btn.disabled = !!st.disabled;
      // aria-pressed ONLY on the buttons that can actually be pressed-in.
      // Writing it to all 22 made a screen reader announce `undo`, `image`
      // and `table` as toggle buttons stuck in the "not pressed" state,
      // which is a lie about what they do.
      if (TOOLBAR_TOGGLE_IDS.has(id)) {
        // v3.3.0 (F2): three values, not two. `mixed` is what the five inline
        // buttons report over a selection that overlaps marks of their tag
        // without lying inside one — pressing them there removes the marks
        // rather than adding any, and 'true'/'false' can say neither.
        btn.setAttribute('aria-pressed',
          st.mixed ? 'mixed' : (st.active ? 'true' : 'false'));
      }
      // `headings` (H / H1..H6) and, since v3.2.1, the mode button carry a
      // derived label; every other button keeps the glyph it was built with.
      if (typeof st.label === 'string') btn.textContent = st.label;
      // v3.2.1: a per-mode title CANNOT be baked in buildToolbar() — the mode
      // button's title names the NEXT state, so it has to be rewritten every
      // time the mode changes. It rides the same diffed loop as everything
      // else: `title` is part of the state object, therefore part of `sig`.
      if (typeof st.title === 'string') {
        btn.title = st.title;
        btn.setAttribute('aria-label', st.title);
      }
    });
    // Label edits above change the row's width (H becomes H1, 編輯 becomes
    // 原始碼), which moves the scroll maximum, so repaint the edge hint here
    // too. Placed inside the diffed branch on purpose: an unchanged sig means
    // no attribute was written, therefore no width moved.
    paintToolbarOverflow();
    // The write above can disable the button the keyboard cursor is sitting
    // on. A real focus would have been thrown back to BODY by the browser at
    // this point, and Tab from BODY goes nowhere — driven on this build, a
    // dozen consecutive Tabs starting from BODY left activeElement on BODY
    // every time — so the keyboard would be stuck there. A virtual cursor has
    // nothing to lose: it steps to the next enabled button instead.
    const cursorBtn = toolbarRovingBtns()[toolbarRovingIndex];
    if (cursorBtn && cursorBtn.disabled) moveToolbarCursor(1);
  }

  // F12: which end of the bar still has buttons behind it. The stylesheet
  // turns each token into an edge gradient; nothing here decides how it looks.
  //
  // The one-pixel margin is a deliberate cushion and NOT a measured
  // requirement — say so rather than inventing a reason for it. Driven at 900
  // and at 420 px wide, the largest scrollLeft the bar accepts came back equal
  // to scrollWidth minus clientWidth to the pixel (75 and 555), so a strict
  // comparison would have been correct at both. The cushion is there because
  // scrollWidth is reported as a whole number over a row whose own width is
  // not, and what it costs when the two agree is that the gradient goes out a
  // pixel before the travel ends.
  function paintToolbarOverflow() {
    if (!toolbarEl) return;
    const max = toolbarEl.scrollWidth - toolbarEl.clientWidth;
    const sl = toolbarEl.scrollLeft;
    const tokens = [];
    if (sl > 1) tokens.push('left');
    if (sl < max - 1) tokens.push('right');
    const v = tokens.join(' ');
    if (toolbarEl.getAttribute('data-ed-tb-overflow') !== v) {
      toolbarEl.setAttribute('data-ed-tb-overflow', v);
    }
  }

  // ── F12, keyboard entry to the toolbar ────────────────────────────────
  //
  // The cursor here is VIRTUAL: no toolbar button ever takes DOM focus, and
  // the caret stays exactly where the user left it. That is not a stylistic
  // choice, it is what makes the rest of this safe. buildToolbar()'s own
  // ⚠ LOAD-BEARING note records why: a toolbar <button> taking focus fires
  // the armed surface's focusout, which commits and re-renders, and the
  // selection the pressed button was about to act on is gone before its click
  // handler runs. The mousedown preventDefault() there stops that happening
  // by mouse; keeping DOM focus still means it cannot happen by keyboard
  // either, and no focusout exemption has to be invented for the way back
  // out.
  //
  // toolbarRovingIndex is an index into the bar's buttons in DOM order, or
  // -1 while the mode is off.
  let toolbarRovingIndex = -1;

  function toolbarRovingBtns() {
    return toolbarEl ? Array.prototype.slice.call(
      toolbarEl.querySelectorAll('.ed-toolbar-btn')) : [];
  }

  function paintToolbarRoving() {
    const btns = toolbarRovingBtns();
    btns.forEach((b, i) => {
      if (i === toolbarRovingIndex) b.setAttribute('data-ed-tb-cursor', '');
      else b.removeAttribute('data-ed-tb-cursor');
    });
    if (!toolbarEl) return;
    if (toolbarRovingIndex < 0 || !btns[toolbarRovingIndex]) {
      toolbarEl.removeAttribute('data-ed-tb-keynav');
    } else {
      toolbarEl.setAttribute('data-ed-tb-keynav',
        btns[toolbarRovingIndex].getAttribute('data-ed-tb'));
    }
  }

  // Scroll the cursor into the strip the buttons rest in, which is narrower
  // than the bar: the mode slot occupies the right-hand end of it. The right
  // boundary is read off the slot's own rect rather than repeating the
  // padding-right the stylesheet reserves, so the two cannot drift apart.
  // The arithmetic is spelled out rather than delegated to scrollIntoView(),
  // whose contract is written against the whole chain of scrollable ancestors
  // while the only box that should move here is this one.
  function revealToolbarCursor(btn) {
    if (!toolbarEl) return;
    const bar = toolbarEl.getBoundingClientRect();
    const slotEl = toolbarEl.querySelector('.ed-toolbar-status');
    const right = slotEl
      ? Math.min(bar.right, slotEl.getBoundingClientRect().left) : bar.right;
    // Rounded AWAY from the edge being cleared, not by the nearest whole
    // number. These boxes have fractional widths while scrollLeft is stored
    // whole, so asking for a flush landing can round the button back under the
    // edge it was supposed to clear: driven with plain subtraction, walking
    // leftwards along the row at a 420px viewport parked stops at a left edge
    // of -0.39, -0.19 and -0.09, and flooring instead put every one of them
    // back inside. Rounding this way spends at most a whole pixel of extra
    // travel and cannot undershoot. What it does not buy is the last
    // fractional pixel at the very end of the travel — the row's own width
    // ends in .109 and scrollWidth is whole, so the trailing button still
    // overhangs the slot by that much with the bar scrolled as far as it
    // goes; that residue is the one the reachability row's own note describes.
    const r = btn.getBoundingClientRect();
    if (r.left < bar.left) {
      toolbarEl.scrollLeft = Math.floor(toolbarEl.scrollLeft - (bar.left - r.left));
    } else if (r.right > right) {
      toolbarEl.scrollLeft = Math.ceil(toolbarEl.scrollLeft + (r.right - right));
    }
  }

  // Steps over disabled buttons. The walk is bounded by the button count and
  // wraps, so a bar with nothing enabled would leave the index where it was
  // rather than spin — see the model's own guarantee that this cannot happen
  // (deriveState() keeps `preview` out of every disabling branch, including
  // the source-mode override; T11-2 later exempted `outline` from that
  // override too, so the enabled set there is `['outline','preview']` — the
  // guarantee holds more strongly than when this was written, not less).
  function moveToolbarCursor(delta) {
    const btns = toolbarRovingBtns();
    if (!btns.length) return;
    let i = toolbarRovingIndex;
    for (let step = 0; step < btns.length; step++) {
      i = ((i + delta) % btns.length + btns.length) % btns.length;
      if (!btns[i].disabled) {
        toolbarRovingIndex = i;
        paintToolbarRoving();
        revealToolbarCursor(btns[i]);
        return;
      }
    }
  }

  // No "already in the mode" guard, because the key branch cannot deliver one:
  // while the mode is on, the entry chord's own key is not one of the keys the
  // mode names, so it takes the hand-back path and ends the mode instead. The
  // gesture is therefore a toggle, and that is pinned rather than inferred.
  // moveToolbarCursor() is the null guard as well — it starts by asking the
  // bar for its buttons, and answers an empty list when there is no bar.
  function enterToolbarKeynav() {
    toolbarRovingIndex = -1;
    moveToolbarCursor(1);
  }

  function exitToolbarKeynav() {
    if (toolbarRovingIndex < 0) return false;
    toolbarRovingIndex = -1;
    paintToolbarRoving();
    return true;
  }

  // Activation goes through the same call the click handler makes, so a
  // keyboard press and a mouse press cannot drift apart.
  //
  // WHERE THE CARET ENDS UP AFTERWARDS, driven button by button over the
  // enabled row in a plain paragraph, pressing Enter on the cursor and then
  // typing to see whether the characters land anywhere:
  //
  //   * quote, code and line end on BODY and typing goes nowhere, with a
  //     clean burst and with a dirty one alike.
  //   * undo, redo and image join them ONLY when the surface has an
  //     uncommitted edit — the action resolves that burst first, and the
  //     re-render is what drops the caret. With nothing pending they land back
  //     on the armed paragraph and typing resumes.
  //   * everything else lands on an editable surface and typing resumes.
  //
  // A mouse click on those same buttons does exactly the same thing, so this
  // is not something the keyboard route introduced — but a mouse user climbs
  // out by clicking into the text and a keyboard user cannot, because Tab from
  // BODY goes nowhere. Deferred to v3.4.0 rather than fixed here: the fix is
  // in the activation path, which the mouse shares.
  //
  // THE WAY OUT until then, driven end to end from a stranded BODY: the entry
  // chord still works there (the bar's own state survives, and its row is
  // fully enabled), so walking to the mode button and pressing Enter puts the
  // caret in the source textarea, where typing lands. Coming back the same way
  // returns the document to edit mode but leaves the caret on BODY again — the
  // hatch is somewhere to keep typing, not a way back to the WYSIWYG caret.
  function activateToolbarCursor() {
    const btn = toolbarRovingBtns()[toolbarRovingIndex];
    if (!btn || btn.disabled) return;
    Promise.resolve(runToolbarAction(btn.getAttribute('data-ed-tb'), btn))
      .catch(() => {}).then(updateToolbar);
  }

  function buildToolbar() {
    const bar = document.createElement('div');
    bar.className = 'ed-toolbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '編輯工具列');
    const btns = {};
    let prevGroup = null;
    toolbarModel.BUTTONS.forEach((def) => {
      // GROUPS order doubles as separator placement: one divider wherever
      // consecutive buttons change group.
      if (prevGroup !== null && def.group !== prevGroup) {
        const sep = document.createElement('span');
        sep.className = 'ed-toolbar-sep';
        bar.appendChild(sep);
      }
      prevGroup = def.group;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ed-toolbar-btn' +
        (TOOLBAR_BTN_CLASS[def.id] ? ' ' + TOOLBAR_BTN_CLASS[def.id] : '');
      btn.textContent = def.icon;
      btn.title = def.title;
      btn.setAttribute('aria-label', def.title);
      btn.setAttribute('data-ed-tb', def.id);
      // Not a tab stop, same as the ⠿ / ＋ gutter buttons: this is chrome,
      // and the Tab key belongs to the document's own structure.
      btn.setAttribute('tabindex', '-1');
      // ⚠ LOAD-BEARING, not a nicety. Without it the five inline-format
      // buttons are dead on arrival: a <button> taking focus on mousedown
      // fires the armed surface's focusout, which commits and re-renders,
      // so applyMarkToggle()'s `selToolbarEditEl` is null and the selection
      // is gone before the click handler ever runs. buildSelToolbar() and
      // both table grip builders defend themselves the identical way.
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        Promise.resolve(runToolbarAction(def.id, btn)).catch(() => {}).then(updateToolbar);
      });
      bar.appendChild(btn);
      btns[def.id] = btn;
    });
    // Fix round 1, item 3: a click on a DISABLED toolbar button used to take
    // the caret with it — the same gesture and the same symptom this release
    // exists for. MEASURED, and the two halves matter separately:
    //
    //  * `mousedown` and `click` are NOT dispatched at all for a disabled
    //    <button> — 0 of each at a capture-phase listener on `document`, for
    //    the whole propagation path, so the per-button mousedown
    //    preventDefault() a few lines above cannot run and neither could one
    //    on this container.
    //  * `pointerdown` IS dispatched (1 at that same document listener) and is
    //    cancellable, and cancelling it suppresses the compatibility mousedown
    //    together with its default action — which is the focus move.
    //
    // Driven, caret in a paragraph, clicking the disabled 🅑: without this
    // handler activeElement was BODY in both the untouched-burst state (bar
    // still 15) and the typed-in state (bar down to 4, because that focusout
    // ran a full commit + render); with it, P.ed-wys-armed / 15 in both.
    //
    // Scope: capture phase on the bar, and preventDefault() ONLY when the
    // press resolves to a disabled button. Never stopPropagation() — the
    // document-level pointerdown delegator (table grips, ⠿ block drag, block
    // selection) still sees the event, and finds nothing to arm, exactly as
    // before. An ENABLED button, a separator, the status slot and the bar's
    // own background are all untouched. The H▾ dropdown is NOT inside this
    // subtree (toggleToolbarHeadingMenu() appends it to document.body), so it
    // is out of reach here and keeps its own per-item mousedown handler.
    bar.addEventListener('pointerdown', (e) => {
      const pressed = e.target && e.target.closest ? e.target.closest('button') : null;
      if (pressed && pressed.disabled) e.preventDefault();
    }, true);
    toolbarBtns = btns;
    // v3.1.0 的 spec 承諾「元素存在但無內容，§3 上線時填入、不需要重排版面」，
    // 但元素從未被建立。這裡把承諾兌現：佔好寬度。內容不再是空的 ——
    // paintModeStatus() 會在 mountToolbar() 掛上之後、以及每次 setDocMode()
    // 切換時寫入當前模式名稱。
    const statusEl = document.createElement('span');
    statusEl.className = 'ed-toolbar-status';
    // Final wave, M7: the only announcement a mode switch ever gets. Every
    // toolbar button is `tabindex="-1"` (see buildToolbar()'s own note), so a
    // screen reader is never focused on the mode button when it is pressed and
    // hears nothing about the state that just changed; the slot's text is the
    // only thing that says so. `role="status"` carries an implicit
    // aria-live="polite", and the explicit attribute is written alongside it
    // because that implication is the part assistive tech has historically
    // been inconsistent about — belt and braces, one line, no layout cost.
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');
    bar.appendChild(statusEl);
    return bar;
  }

  async function runToolbarAction(id, btnEl) {
    const blockEl = liveToolbarBlock();
    switch (id) {
      // ⚠ The BROWSER-side zero-argument undo()/redo(), never `stack.undo` /
      // `stack.redo`. Those are the pure core's helpers (they are what
      // rollbackFailedRender() reverses an op with) and calling them from
      // here would skip switchAwayFrom() and safeRerenderAll() — the exact
      // shape this file records as having produced a silent total lockout
      // recoverable only by reloading the page.
      case 'undo': return undo();
      case 'redo': return redo();
      case 'headings': return toggleToolbarHeadingMenu(btnEl);
      // The five conversion targets are convert-md.js's own ids, so the
      // gesture goes through convertBlockViaMenu()'s §3.7 / §4.3 gates
      // (withheld types, mixed spans, run support) exactly like the ⠿
      // submenu's items do.
      case 'quote': return blockEl ? convertBlockViaMenu(blockEl, 'quote') : undefined;
      case 'code': return blockEl ? convertBlockViaMenu(blockEl, 'code') : undefined;
      case 'list': return blockEl ? convertBlockViaMenu(blockEl, 'ul') : undefined;
      case 'ordered-list': return blockEl ? convertBlockViaMenu(blockEl, 'ol') : undefined;
      case 'check': return blockEl ? convertBlockViaMenu(blockEl, 'task') : undefined;
      case 'bold': return applyMarkToggle('STRONG');
      case 'italic': return applyMarkToggle('EM');
      case 'strike': return applyMarkToggle('DEL');
      case 'inline-code': return applyMarkToggle('CODE');
      case 'link': return applyLinkToggle();
      // NOT indentListItem()/outdentListItem(): those only write data-indent
      // on the DOM and never commit. See indentCaretLi()'s own comment.
      case 'outdent': return indentCaretLi(-1);
      case 'indent': return indentCaretLi(1);
      case 'table': return blockEl ? insertBlockBelow(blockEl, 'table') : undefined;
      case 'line': return blockEl ? insertBlockBelow(blockEl, 'line') : undefined;
      case 'insert-after': return blockEl ? insertBlockBelow(blockEl, 'paragraph') : undefined;
      case 'insert-before': return blockEl ? insertBlockAbove(blockEl) : undefined;
      case 'image': return pickAndInsertImage();
      case 'outline': return toggleOutlineSidebar();
      case 'preview': return cycleDocMode();
      default: return undefined;
    }
  }

  // ── headings ▾ ─────────────────────────────────────────────────────────
  // KNOWN GAP, documented rather than fixed: the toolbar's keyboard cursor can
  // open and close this dropdown, but its items are still reachable by mouse
  // only — they carry no cursor of their own and the mode's arrow keys move
  // along the bar, not into the panel. No keyboard route reaches them.
  function closeToolbarMenu() {
    if (toolbarMenuEl) { toolbarMenuEl.remove(); toolbarMenuEl = null; }
  }

  function toggleToolbarHeadingMenu(btnEl) {
    if (toolbarMenuEl) { closeToolbarMenu(); return; }
    const menu = document.createElement('div');
    menu.className = 'ed-toolbar-menu';
    [1, 2, 3, 4, 5, 6].forEach((n) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'ed-toolbar-menu-btn';
      item.textContent = '標題 ' + n;
      item.setAttribute('tabindex', '-1');
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        closeToolbarMenu();
        Promise.resolve(applyHeadingLevel(n)).catch(() => {}).then(updateToolbar);
      });
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
    const r = btnEl.getBoundingClientRect();
    const top = r.bottom + 4;
    menu.style.top = top + 'px';
    menu.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 140)) + 'px';
    // Task 9 fix round 1 (Ruling T9-5): same clamp shape as
    // openConvertSubmenu()'s .ed-handle-submenu fix above — measure the
    // panel's own rendered bottom after it is appended and positioned, and
    // shift `top` up by the bottom overflow when there is one.
    // `.ed-toolbar-menu` is `position: fixed` (lib/md2doc.js), so its own
    // getBoundingClientRect() is already in viewport coordinates and `top`
    // needs no containing-block translation the way the absolute-positioned
    // submenu did.
    const overflowBottom = menu.getBoundingClientRect().bottom - window.innerHeight;
    if (overflowBottom > 0) {
      menu.style.top = (top - overflowBottom) + 'px';
    }
    toolbarMenuEl = menu;
  }

  // changeHeadingDepth(blockEl, delta) takes a RELATIVE delta and has no
  // blockType guard, while headingDepthOf() answers 1 for any non-heading
  // line — so calling it on a paragraph silently prefixes '## ' and turns it
  // into an H2 while bypassing convertBlockViaMenu()'s gates entirely. Both
  // halves of that are handled here: a non-heading is CONVERTED through the
  // gate (convert-md.js's 'h1'..'h6' targets already carry the level), and a
  // heading gets a delta computed against its own current depth.
  async function applyHeadingLevel(n) {
    const blockEl = liveToolbarBlock();
    if (!blockEl) return;
    if (blockEl.getAttribute('data-block-type') !== 'heading') {
      await convertBlockViaMenu(blockEl, 'h' + n);
      return;
    }
    const rec = blockRecOf(blockEl);
    if (!rec || rec.endLine < rec.startLine) return;
    const delta = n - headingDepthOf(lines[rec.startLine - 1]);
    if (delta === 0) return;
    await changeHeadingDepth(blockEl, delta);
  }

  // ── insert above ───────────────────────────────────────────────────────
  // commitBlockInsertion() only ever inserts AFTER a block's range, so
  // "insert above" is expressed the way this file already expresses it (see
  // convertEmptyTopLevelLiToParagraph()'s own preceding-block lookup):
  // anchor on the block before this one. That keeps one insertion path and
  // one set of gates rather than teaching the pure core a direction.
  async function insertBlockAbove(blockEl) {
    const rec = blockRecOf(blockEl);
    if (!rec) return;
    const preceding = blocks
      .filter((b) => b.id !== rec.id && b.endLine < rec.startLine && b.endLine >= b.startLine)
      .pop();
    if (preceding) {
      const anchorEl = blockElAtLine(preceding.startLine);
      if (anchorEl) { await insertBlockBelow(anchorEl, 'paragraph'); return; }
    }
    // Nothing above to anchor on — see insertParagraphAtTop(). Refusing here
    // instead would leave the document's FIRST block permanently impossible
    // to precede: the ⠿ and ＋ menus both insert below, so this button is the
    // only affordance that reaches that position at all.
    await insertParagraphAtTop(blockEl);
  }

  // The document's first block has no predecessor to insert BELOW, and
  // commitBlockInsertion() only ever inserts after a block's range. Rather
  // than teach the pure core a direction (a change under byte-stability and
  // roundtrip fixtures), the insert is expressed as a REPLACE of that
  // block's own first source line by [skeleton, '', that same line] — the
  // same commitRangeEdit()/replaceLines() pipeline as every other edit,
  // therefore one undo op, and no new primitive.
  //
  // The switchAwayFrom() + re-resolve preamble is insertBlockBelow()'s,
  // for its reasons: the resolution can commit a dirty burst, whose
  // rerenderAll() detaches the very node this was called with.
  async function insertParagraphAtTop(blockEl) {
    const identity = captureBlockIdentity(blockEl);
    const selfSession = ownsOpenSession(blockEl);
    const ok = await switchAwayFrom();
    if (!ok) return;
    let liveBlockEl = blockEl;
    if (!document.body.contains(blockEl)) {
      liveBlockEl = reresolveBlockEl(identity) ||
        (selfSession ? reresolveBlockElAfterSelfCommit(identity) : null);
      if (!liveBlockEl) { showBanner(DROPPED_GESTURE_MESSAGE, null, null); return; }
    }
    const rec = blockRecOf(liveBlockEl);
    // A block that owns no source line has an inverted range, and there is
    // no line to splice in front of.
    if (!rec || rec.endLine < rec.startLine) {
      refuseStructuralListEdit(noSourceLineInsertMessageFor(liveBlockEl));
      return;
    }
    const at = rec.startLine;
    const newText = BLOCK_SKELETONS.paragraph.concat(['', lines[at - 1]]).join('\n');
    const result = commitRangeEdit({ lines, blocks, stack }, at, at, newText);
    if (result.op === null) return;
    const prevLines = lines;
    lines = result.lines;
    const editRange = result.op
      ? { startLine: Math.min(result.op.startLine, result.op.endLine + 1),
          endLine: Math.max(result.op.startLine - 1, result.op.endLine),
          delta: result.op.after.length - result.op.before.length }
      : undefined;
    const okRender = await safeRerenderAll(editRange);
    if (!okRender) {
      lines = rollbackFailedRender({ lines, stack }, result, prevLines);
      return;
    }
    // The new paragraph starts exactly where the old first line did — same
    // pristine + focus contract insertBlockBelow() gives a skeleton insert.
    const target = blocks.find((b) => b.startLine === at);
    if (target) pristineInsert = { blockId: target.id };
    await focusInsertedBlock(at, 'paragraph');
  }

  // ── 大綱 ───────────────────────────────────────────────────────────────
  // TWO attributes, chosen by viewport, and that is not an accident.
  //
  // `body[data-sidebar-open]` is the reader runtime's own attribute (see
  // lib/md2doc.js's setSidebarOpen()) and it drives the MOBILE drawer. The
  // first cut of this function reused it on desktop too, on the premise that
  // nothing outside the max-width:1080px block read it. That premise was
  // false, and the failure was severe: `body[data-sidebar-open]
  // .sidebar-scrim { display: block; }` sits at BASE scope, so on a desktop
  // viewport the button painted a full-viewport 35%-black scrim over the
  // whole page (position:fixed; inset:0; z-index:98) — the document went
  // grey and unclickable, and the scrim's own click handler then called
  // setSidebarOpen(false), so the first click anywhere undid it and the
  // whole gesture read as a flicker.
  //
  // Desktop therefore gets a PRIVATE attribute nothing else reads,
  // `data-ed-outline-hidden`, matched by an edit-mode-only rule in
  // lib/md2doc.js. Named for the non-default state because the desktop
  // outline is a sticky column shown by default, which is also what lets
  // aria-expanded below stay truthful on both viewports.
  function toggleOutlineSidebar() {
    // The same 1080px breakpoint the stylesheet's own drawer block uses.
    const mobile = typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 1080px)').matches;
    let expanded;
    if (mobile) {
      expanded = !document.body.hasAttribute('data-sidebar-open');
      if (expanded) document.body.setAttribute('data-sidebar-open', '');
      else document.body.removeAttribute('data-sidebar-open');
    } else {
      expanded = document.body.hasAttribute('data-ed-outline-hidden');
      if (expanded) document.body.removeAttribute('data-ed-outline-hidden');
      else document.body.setAttribute('data-ed-outline-hidden', '');
    }
    const toggle = document.getElementById('sidebar-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  // ── 追加 3: images ─────────────────────────────────────────────────────
  function lastBlockEl() {
    const all = contentEl.querySelectorAll('.ed-block');
    return all.length ? all[all.length - 1] : null;
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('could not read the image'));
      fr.onload = () => {
        // readAsDataURL gives 'data:<mime>;base64,<payload>' — the endpoint
        // wants the payload alone, and derives the extension from the mime
        // it is told, never from this prefix.
        const s = String(fr.result || '');
        const comma = s.indexOf(',');
        resolve(comma === -1 ? '' : s.slice(comma + 1));
      };
      fr.readAsDataURL(blob);
    });
  }

  // Uploads one blob and answers its 'assets/<name>' path, or null (a banner
  // is already showing by then). The MIME whitelist is asked BEFORE the round
  // trip so an unsupported drop is refused instantly and locally — the server
  // asks the same question again, and it is the server's answer that is
  // authoritative.
  async function uploadImageBlob(blob) {
    if (!blob) return null;
    if (!assetLib || !assetLib.extFor(blob.type)) {
      showBanner(TOOLBAR_UNSUPPORTED_IMAGE_MESSAGE, null, null);
      return null;
    }
    let data;
    try {
      data = await blobToBase64(blob);
    } catch (e) {
      showBanner('圖片讀取失敗 — ' + describeFailure(e), null, null);
      return null;
    }
    let res;
    try {
      res = await fetch('/api/asset', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fileId: ED.fileId, mime: blob.type, name: blob.name || 'image', data: data,
        }),
      });
    } catch (e) {
      showBanner('圖片上傳失敗 — ' + describeFailure(e) + '。檔案未寫入。', null, null);
      return null;
    }
    if (!res.ok) {
      const reason = await describeHttpFailure(res);
      showBanner('圖片上傳失敗 — ' + reason + '。檔案未寫入。', null, null);
      return null;
    }
    let j;
    try { j = await res.json(); } catch (e) { j = null; }
    if (!j || typeof j.path !== 'string') {
      showBanner('圖片上傳失敗 — 伺服器回應格式不正確。', null, null);
      return null;
    }
    return j.path;
  }

  // asset.js's sanitizeName() deliberately keeps spaces (and everything else
  // that is not a path separator or a drive colon) — a screenshot really is
  // called 'Screen Shot 2026-09-03 at 14.02.11.png'. A bare space, or a
  // parenthesis, inside an inline image destination ends the destination
  // early, so `![](assets/My Shot.png)` renders as literal text. Percent-
  // encoding exactly those characters fixes it in both directions: browsers
  // resolve the escape, and md2doc's own resolveAssetPath() decodes the
  // filePart before probing the disk (it also probes the raw form, so
  // non-ASCII characters are deliberately left alone rather than escaped).
  // '%' itself is encoded FIRST by being in the same character class, so a
  // filename that already contains one cannot be double-decoded.
  const TOOLBAR_MD_DEST_UNSAFE_RE = /[%\s()<>"']/g;
  function markdownImageDest(p) {
    return String(p == null ? '' : p).replace(TOOLBAR_MD_DEST_UNSAFE_RE, (c) => {
      const hex = c.charCodeAt(0).toString(16).toUpperCase();
      return '%' + (hex.length < 2 ? '0' + hex : hex);
    });
  }

  // Uploads every image in `blobs` and lands them as ONE block insertion.
  // One insertion, not one per image: each insert re-renders and detaches the
  // anchor, so a loop would be inserting against a stale node from the second
  // image onward — and it would also cost one undo op per image for what the
  // user experienced as a single drop. Blank lines between the paths keep
  // them separate paragraphs instead of one paragraph of soft breaks.
  async function insertImages(blobs, anchorEl) {
    const paths = [];
    for (let i = 0; i < blobs.length; i += 1) {
      const p = await uploadImageBlob(blobs[i]);
      if (p) paths.push(p);
    }
    if (!paths.length) return;
    const target = (anchorEl && document.body.contains(anchorEl)) ? anchorEl : lastBlockEl();
    if (!target) { showBanner(TOOLBAR_NO_ANCHOR_MESSAGE, null, null); return; }
    const newLines = [];
    paths.forEach((p, i) => {
      if (i > 0) newLines.push('');
      newLines.push('![](' + markdownImageDest(p) + ')');
    });
    await insertBlockBelow(target, 'paragraph', { lines: newLines });
  }

  // v3.2.1: 「插入圖片竟然無法在我當前的位置後插入，每次都跑到最後」. Two
  // separate mechanisms put the image at EOF, and BOTH were measured — the
  // second one is the reason this function is longer than it looks like it
  // needs to be.
  //
  //   (a) `input.click()` below is a SYNTHETIC click. It bubbles to the
  //       document delegator, which reads it as a click landing outside every
  //       block → switchAwayFrom() → commit + re-render → the anchor node
  //       captured a moment earlier is detached → insertImages() falls back to
  //       lastBlockEl() and the image lands at the end of the file.
  //       Deterministic whenever the block the user is in is dirty, which is
  //       exactly the reported gesture.
  //
  //   (b) stopPropagation() on that click is NECESSARY BUT NOT SUFFICIENT. It
  //       fixes the reported gesture, yet the anchor stayed a raw DOM node
  //       held across the file dialog: a FULL render landing between the click
  //       and the `change` event detaches it and the image is back at EOF.
  //       The v3.2.0 patch path is not the exposure — two forced mid-dialog
  //       renders (a commit in another block, a ⠿ 刪除 of another block) were
  //       measured to patch and leave the anchor attached — but a full render
  //       is one patchmap() miss away (it returns null whenever there is no
  //       usable editRange), and a real OS file dialog stays open for as long
  //       as the user takes. So the window is small, not hypothetical.
  //
  // Hence both halves: stop the synthetic click from reading as an
  // outside-click, AND resolve the open session BEFORE the picker opens while
  // carrying the anchor as a stable IDENTITY that is re-resolved when the
  // files come back, instead of as a node reference. The identity triple is
  // insertBlockBelow()'s (captureBlockIdentity / ownsOpenSession /
  // reresolveBlockEl + reresolveBlockElAfterSelfCommit) — that function solved
  // this same problem for its own anchor and the image path simply never
  // adopted it. Do not "simplify" the re-resolution away: it is the half that
  // survives the dialog.
  //
  // ⚠ ORDERING: `await switchAwayFrom()` runs BEFORE input.click(). Chrome
  // gates the file picker on TRANSIENT user activation, which is time-based
  // (~5 s) and is NOT spent by awaiting a promise, so the picker still opens.
  // The journey scenario presses 🖼 on a DIRTY block, so a real commit — an
  // /api/render round trip — runs inside that await; if the activation were
  // spent, waitForFileChooser() there would time out. A commit slower than
  // the activation window would be the one way this ordering could bite.
  async function pickAndInsertImage() {
    // Captured BEFORE switchAwayFrom(), because that is what can renumber the
    // ids and rewrite the source — see captureBlockIdentity()'s comment.
    const blockEl = liveToolbarBlock() || lastBlockEl();
    const identity = captureBlockIdentity(blockEl);
    // The commit inside switchAwayFrom() can be a rewrite of THIS block's own
    // source, in which case reresolveBlockEl()'s fingerprint is guaranteed to
    // miss because WE are the reason the source changed; the narrowed
    // re-resolve is used only then. Same reasoning as insertBlockBelow().
    const selfSession = ownsOpenSession(blockEl);
    if (!(await switchAwayFrom())) return;
    const anchorEl = (blockEl && document.body.contains(blockEl))
      ? blockEl
      : (reresolveBlockEl(identity) ||
        (selfSession ? reresolveBlockElAfterSelfCommit(identity) : null));
    if (!anchorEl) { showBanner(TOOLBAR_NO_ANCHOR_MESSAGE, null, null); return; }
    // Re-captured AFTER the commit: `identity` above holds the PRE-commit
    // fingerprint, which the commit we just awaited may itself have
    // invalidated. What has to survive the dialog is the anchor as it stands
    // now.
    const dialogIdentity = captureBlockIdentity(anchorEl);
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp';
    input.multiple = true;
    input.hidden = true;
    // (a) above.
    input.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const files = input.files ? Array.prototype.slice.call(input.files) : [];
      input.remove();
      if (!files.length) return;
      // (b) above. A render that landed while the dialog was open detached
      // `anchorEl`; the identity still names the block the user pointed at.
      // If even that misses, the block the user aimed at no longer exists as
      // it was — refuse (and skip the upload, so no orphan lands in the
      // user's assets/) rather than silently appending at EOF, which is the
      // very symptom being fixed.
      const live = document.body.contains(anchorEl)
        ? anchorEl : reresolveBlockEl(dialogIdentity);
      if (!live) { showBanner(TOOLBAR_NO_ANCHOR_MESSAGE, null, null); return; }
      insertImages(files, live);
    });
    input.click();
  }

  function dragCarriesFiles(e) {
    const dt = e.dataTransfer;
    if (!dt || !dt.types) return false;
    return Array.prototype.indexOf.call(dt.types, 'Files') !== -1;
  }

  function wireImageDrop() {
    // ⚠ BOTH listeners are gated on `docMode === 'edit'`, and that gate is
    // load-bearing rather than tidy-minded.
    //
    // In SOURCE mode `enterSourceMode()` only sets `contentEl.hidden = true` —
    // every `.ed-block` is still in the DOM, so `lastBlockEl()` resolves and an
    // ungated drop ran the whole upload plus an `insertBlockBelow()` commit
    // behind the hidden content, against `lines`. The textarea the user is
    // looking at still held the PRE-drop source, and `leaveSourceMode()` then
    // commits `commitRangeEdit(1, lines.length, ta.value)` over the post-drop
    // `lines` — erasing the reference that was just inserted. MEASURED:
    // '# Doc\n\nBody para.\n' -> source mode -> drop x.png -> type EDITED ->
    // leave, and the file ends '# Doc\n\nBody para.\n\nEDITED\n' with
    // assets/x.png orphaned on disk. No error, no visible effect, and a stray
    // binary left in what is usually a git working tree.
    //
    // v3.2.1: `!== 'edit'` rather than `=== 'source'` on purpose. Source is
    // the only other mode today, but the gate's reason is "the content the
    // user is looking at is not the content a drop would write into" — a
    // future third mode inherits the refusal rather than the hole.
    document.addEventListener('dragover', (e) => {
      if (docMode !== 'edit') return;
      if (!dragCarriesFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('drop', (e) => {
      if (docMode !== 'edit') return;
      if (!dragCarriesFiles(e)) return;
      const files = e.dataTransfer
        ? Array.prototype.slice.call(e.dataTransfer.files || [])
        : [];
      const images = files.filter((f) => !!(assetLib && assetLib.extFor(f.type)));
      if (!images.length) return; // not ours: let the page do whatever it would
      e.preventDefault();
      const anchorEl = (e.target && e.target.closest) ? e.target.closest('.ed-block') : null;
      insertImages(images, anchorEl || liveToolbarBlock() || lastBlockEl());
    });
  }

  // ── 追加 2: paste ──────────────────────────────────────────────────────
  // Reads a real DataTransfer into the plain { 'mime/type': string | Blob }
  // shape paste-md.js's pickPayload() documents. Only ONE image flavour is
  // taken: pickPayload picks the first it finds anyway, and a clipboard can
  // carry several encodings of the same bitmap.
  function clipboardItemsOf(dt) {
    const items = {};
    if (!dt) return items;
    try { items['text/plain'] = dt.getData('text/plain') || ''; } catch (err) { items['text/plain'] = ''; }
    try { items['text/html'] = dt.getData('text/html') || ''; } catch (err) { items['text/html'] = ''; }
    const files = dt.files ? Array.prototype.slice.call(dt.files) : [];
    for (let i = 0; i < files.length; i += 1) {
      if (files[i] && String(files[i].type).indexOf('image/') === 0) {
        items[files[i].type] = files[i];
        break;
      }
    }
    return items;
  }

  // A converted payload that is ONE line carrying no markdown syntax at all
  // is indistinguishable from the plain-text paste this editor has always
  // done — and that case (copy a word or a phrase out of a browser, paste it
  // mid sentence) must keep landing at the caret rather than becoming a new
  // block. Anything else is real structure and takes the source path.
  //
  // The test is split in two because markdown's characters are NOT all alike.
  // The first cut used one character class for both kinds and put '-', '#'
  // and '!' in it — which re-introduced exactly the regression this test
  // exists to prevent, since 'e-mail', 'state-of-the-art' and 'Hello!' are
  // ordinary prose that would have become new paragraph blocks. Those three
  // only begin a construct at LINE POSITION, so they belong in the
  // start-anchored test, not the anywhere test. ('![' is still caught: the
  // '[' is in the anywhere class.)
  const TOOLBAR_INLINE_UNSAFE_RE = /[*_`~\[\]<>|\\]/;
  const TOOLBAR_BLOCK_START_RE =
    /^(?: {4}|\t|#{1,6}(?:\s|$)|[-*+][ \t]|\d+[.)][ \t]|>|`{3}|~{3}|-{3}|={3})/;
  function isInlineSafePaste(md) {
    if (md === '' || md.indexOf('\n') !== -1) return false;
    if (TOOLBAR_INLINE_UNSAFE_RE.test(md)) return false;
    return !TOOLBAR_BLOCK_START_RE.test(md);
  }

  function handleArmedPaste(dt, editEl) {
    const items = clipboardItemsOf(dt);
    const carriesSomething = Object.keys(items).some((k) => (
      typeof items[k] === 'string' ? items[k] !== '' : !!items[k]));
    // An EMPTY paste is not the paste the gesture asked for, and must not
    // consume the Ctrl+Shift+V arming. MEASURED in headless Chromium: the
    // Ctrl+Shift+V keystroke ITSELF dispatches a paste event carrying no
    // flavours at all (`types: []`, `getData('text/plain') === ''`) before
    // any real clipboard content arrives. Consuming `plainPasteArmed` there
    // disarmed the very paste the user had just asked to be plain — the
    // gesture silently degraded to a normal rich paste. Returning early also
    // saves an insertTextAtCaret('') that would snapshot the burst for a
    // no-op edit.
    if (!carriesSomething) return;
    const plainOnly = plainPasteArmed;
    plainPasteArmed = false;
    const payload = pasteMd
      ? pasteMd.pickPayload(items, plainOnly)
      : { kind: 'text', value: dt ? dt.getData('text/plain') : '' };
    if (payload.kind === 'image') {
      insertImages([payload.blob], editEl.closest('.ed-block'));
      return;
    }
    if (payload.kind === 'markdown') {
      const md = String(payload.value == null ? '' : payload.value).replace(/\r\n?/g, '\n');
      if (md.trim() === '') return;
      if (isInlineSafePaste(md)) {
        snapBurstIfActive(editEl, 'paste-pre');
        insertTextAtCaret(md);
        snapBurstIfActive(editEl, 'paste');
        return;
      }
      // Landed as SOURCE below the caret's block, never spliced into the
      // WYSIWYG DOM: that is what guarantees it passes through
      // commitBlockInsertion()/replaceLines() and therefore through
      // serializeBlocks()'s existing gates, instead of arriving as a pile of
      // foreign nodes the serializer would have to make sense of afterwards.
      insertBlockBelow(editEl.closest('.ed-block'), 'paragraph', { lines: md.split('\n') });
      return;
    }
    snapBurstIfActive(editEl, 'paste-pre');
    insertTextAtCaret(payload.value || '');
    snapBurstIfActive(editEl, 'paste');
  }

  function wirePlainPasteArming() {
    // Capture phase: this only records intent, and must do so before any
    // other keydown handler can preventDefault() its way past it.
    document.addEventListener('keydown', (e) => {
      plainPasteArmed = !!((e.ctrlKey || e.metaKey) && e.shiftKey &&
        (e.key === 'v' || e.key === 'V'));
    }, true);
  }

  // ── 追加 4: the whole-document source escape hatch ─────────────────────
  // v3.2.1: applyPreviewEditability() lived here and was preview mode's ONLY
  // effect. Preview is gone (docsource.js's MODES comment carries the
  // measurement), and with it the last caller of this function.

  function enterSourceMode() {
    // The pre-edit snapshot fromSource() diffs against. Omitting it makes
    // `changed` unconditionally true (docsource.js's documented fail-safe),
    // i.e. a needless write of byte-identical content on every exit.
    sourceBaseLines = lines.slice();
    const ta = document.createElement('textarea');
    ta.className = 'ed-source';
    ta.setAttribute('aria-label', '文件原始碼');
    ta.value = docSourceLib.toSource(lines, EOL);
    contentEl.hidden = true;
    contentEl.parentNode.insertBefore(ta, contentEl);
    sourceTextarea = ta;
    ta.focus();
  }

  // Returns false when the commit's render failed — the textarea is then left
  // standing with the user's text intact (a failed round trip must never be
  // the thing that discards a whole document's edit), and the mode does not
  // advance.
  async function leaveSourceMode() {
    const ta = sourceTextarea;
    if (!ta) return true;
    const parsed = docSourceLib.fromSource(ta.value, EOL, sourceBaseLines);
    if (parsed.changed) {
      // 全量置換 through the SAME replaceLines() pipeline every other edit
      // uses — one commitRangeEdit over the whole document, therefore one
      // undo op, and no second writer of `lines`.
      const result = commitRangeEdit({ lines, blocks, stack }, 1, lines.length,
        parsed.lines.join('\n'));
      if (result.op !== null) {
        const prevLines = lines;
        lines = result.lines;
        setDirty();
        const editRange = result.op
          ? { startLine: Math.min(result.op.startLine, result.op.endLine + 1),
              endLine: Math.max(result.op.startLine - 1, result.op.endLine),
              delta: result.op.after.length - result.op.before.length }
          : undefined;
        const ok = await safeRerenderAll(editRange);
        if (!ok) {
          lines = rollbackFailedRender({ lines, stack }, result, prevLines);
          setDirty();
          return false;
        }
      }
    }
    sourceTextarea = null;
    sourceBaseLines = null;
    ta.remove();
    contentEl.hidden = false;
    return true;
  }

  async function cycleDocMode() {
    if (!docSourceLib) return;
    await setDocMode(docSourceLib.next(docMode));
  }

  async function setDocMode(next) {
    if (next === docMode) return;
    if (docMode === 'edit') {
      // Same precondition every structural operation has: resolve whatever
      // session is open before the DOM it lives in is swapped or hidden.
      const ok = await switchAwayFrom();
      if (!ok) return;
    }
    if (docMode === 'source') {
      const ok = await leaveSourceMode();
      if (!ok) return;
    }
    docMode = next;
    if (docMode === 'source') enterSourceMode();
    document.body.setAttribute('data-ed-mode', docMode);
    paintModeStatus();
    updateToolbar();
  }

  // v3.2.1: 模式必須說出來 —— 使用者按第二下以為卡住，其實是進了 source。
  // Called from setDocMode() AND from mountToolbar(), so the slot is truthful
  // from the first paint rather than only after the first mode change.
  function paintModeStatus() {
    const statusEl = document.querySelector('.ed-toolbar-status');
    if (statusEl) statusEl.textContent = docMode === 'source' ? '原始碼' : '編輯';
  }

  // ── mount ──────────────────────────────────────────────────────────────
  function wireToolbarTracking() {
    // Which block the bar reports on. Delegated at document level (never a
    // per-block listener) for the same reason every other affordance in this
    // file is: blocks are rebuilt wholesale on every render.
    document.addEventListener('focusin', (e) => {
      if (!e.target || !e.target.closest) return;
      if (e.target.closest('.ed-toolbar') || e.target.closest('.ed-toolbar-menu')) return;
      const blockEl = e.target.closest('.ed-block');
      if (!blockEl) return;
      toolbarBlockEl = blockEl;
      updateToolbar();
    });
    document.addEventListener('click', (e) => {
      if (!e.target || !e.target.closest) return;
      if (e.target.closest('.ed-toolbar') || e.target.closest('.ed-toolbar-menu')) return;
      closeToolbarMenu();
      // F12: a press somewhere else is a hand-back, so the bar's keyboard
      // cursor goes with it. Deliberately hung on click and not on focusin:
      // SOME activations do land a focusin on an editable surface, and hanging
      // the hand-back there would end the mode after a single press for those.
      // Driven with an uncommitted edit pending, the ones that fire a focusin
      // are list, ordered-list, check, table, insert-before, insert-after and
      // preview; headings, outline, and everything in the landing note on
      // activateToolbarCursor() fire none. So this cannot be a blanket claim
      // about activation, and the earlier version of this comment made it one.
      exitToolbarKeynav();
      const blockEl = e.target.closest('.ed-block');
      if (blockEl) toolbarBlockEl = blockEl;
      updateToolbar();
    });
    // NOTE: there is deliberately NO selectionchange listener here — the
    // burst's own onSelectionChangeForToolbar() calls updateToolbar() for us.
    // See that function for why a second one must not be attached.
  }

  function mountToolbar() {
    // An older cached page can be running this runtime without the v3.1.0
    // module tags. Degrade to "no toolbar" rather than throwing before
    // armEditables() has run.
    if (!toolbarModel) return;
    toolbarEl = buildToolbar();
    // ⚠ document.body, NOT contentEl. rerenderAll()'s fallback path does
    // `contentEl.innerHTML = j.parts.join('\n')` (v3.2.0: `/api/render`
    // answers `{ parts, blocks }` and there is no `bodyHtml` on the wire any
    // more — see applyFullRender()), replacing .content's children wholesale,
    // and only armEditables() rebuilds anything afterwards — it knows nothing
    // about a toolbar. A bar mounted inside .content would
    // vanish on the first commit with nothing left to bring it back. Every
    // persistent chrome node in this file is on document.body for exactly
    // this reason: the conflict banner, the selection toolbar, the table
    // grips and the table edge menu.
    document.body.appendChild(toolbarEl);
    // A scroll event does not bubble, so this one is on the bar itself rather
    // than folded into the document-level capture-phase listener at the foot
    // of this file. That listener does receive the bar's own scroll —
    // measured, capture reaches a target that never bubbles — but what it
    // does with it is tear down grips and menus, which has nothing to do with
    // repainting an edge gradient.
    //
    // The resize listener is not redundant with the scroll one. A viewport
    // change moves clientWidth, and whether it also produces a scroll event
    // depends on where the bar happens to be resting: driven from 420px out
    // to 1400px, the bar sitting at its scroll maximum got a scroll event
    // (the clamp back to zero), and the bar already at zero got none at all,
    // while both had to end up with the hint out.
    toolbarEl.addEventListener('scroll', paintToolbarOverflow, { passive: true });
    window.addEventListener('resize', paintToolbarOverflow);
    document.body.setAttribute('data-ed-mode', docMode);
    paintModeStatus();
    wireToolbarTracking();
    wireImageDrop();
    wirePlainPasteArming();
    // No separate first paint of the edge hint here: on this call the
    // remembered toolbar signature is still its initial empty string, which no
    // JSON.stringify() of a state object can equal, so updateToolbar() takes
    // its write branch and repaints on the way out. Driven at a 420px-wide
    // viewport, the bar carries the right-hand token before any gesture.
    updateToolbar();
  }

  // ── global key handling ─────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    // ── F12: the toolbar's keyboard mode owns its own keys ─────────────
    // Above everything, including the `.ed-raw` textarea bail further down.
    // That bail returns for EVERY key, so an entry gesture placed under it
    // would be dead while a degraded block's raw editor holds focus — driven
    // from that editor, the gesture lands on the bar and the caret stays in
    // the textarea. Source mode is a different surface (`textarea.ed-source`,
    // which that bail does not match) and reaches the bar as well; there the
    // model disables the row apart from the button that gets you back out, so
    // the cursor lands on that one.
    //
    // Escape is NOT claimed here. It belongs to the ordered prologue just
    // below, which already ranks a drag and an open menu above everything
    // else; the rung that leaves this mode was inserted there, in rank order,
    // rather than jumped ahead of them.
    //
    // Anything this mode does not name hands the keyboard straight back: the
    // mode ends and the keystroke carries on down this listener to whatever
    // would have had it.
    //
    // The modifier names in that list are KEY NAMES, not modifier flags:
    // `e.key === 'Control'` is the Control key pressed BY ITSELF, which
    // browsers dispatch a keydown for — driven, and the row asserts that
    // dispatch before it asserts anything about the cue, because a browser
    // that stayed silent would make the whole check pass while proving
    // nothing. Without the exclusions that keydown reaches the hand-back, so a
    // user who presses Control to begin a chord loses the cursor before
    // finishing it. That bare press is the shape that separates them, and each
    // is ablated on its own against it rather than reasoned about as a set.
    //
    // A chord does NOT separate them, which is why an earlier reading here
    // called `Control` and `Meta` unpinnable: Ctrl+S ends the mode and writes
    // the file whether or not `Control` is excluded, because the `s` behind it
    // is unnamed here and hands back before the save branch below runs. The
    // exclusion does its work at the modifier's own keydown, which lands
    // before the key a chord is named for ever arrives.
    //
    // `Alt` and `Shift` carry a second duty on top of that:
    //
    //   Alt   — WITHOUT it the entry chord stops toggling. The Alt keydown
    //           would end the mode, and the F10 behind it would then arrive
    //           with the mode already off and re-enter, so pressing the chord
    //           a second time would look like it did nothing. WITH it, the
    //           Alt keydown is ignored and the F10 lands as an unnamed key,
    //           which is what ends the mode. The exclusion is the cause of the
    //           toggle, not a defence against it.
    //   Shift — keeps Shift+Arrow on the toolbar cursor. Without it the Shift
    //           keydown ends the mode and the arrow behind it falls through to
    //           the block-selection extension instead.
    //
    // A menu raised from this bar goes down on the way past. Without this the
    // hand-back cleared the cursor cue and left the H▾ dropdown standing, so
    // the two disagreed and only Escape was any use. Escape is excluded
    // because the ordered prologue below owns it and takes the menu down
    // there, in rank order; Enter and Space are excluded because they are the
    // keys that opened the menu and have to keep closing it.
    if (toolbarRovingIndex >= 0) {
      if (toolbarMenuEl && e.key !== 'Escape' && e.key !== 'Enter' && e.key !== ' ') {
        closeToolbarMenu();
      }
      if (e.key === 'ArrowRight') { e.preventDefault(); moveToolbarCursor(1); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); moveToolbarCursor(-1); return; }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); activateToolbarCursor(); return;
      }
      if (e.key !== 'Escape' && e.key !== 'Alt' && e.key !== 'Shift' &&
          e.key !== 'Control' && e.key !== 'Meta') {
        exitToolbarKeynav();
      }
    } else if (e.altKey && e.key === 'F10') {
      e.preventDefault();
      enterToolbarKeynav();
      return;
    }

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
    // ⚠ CORRECTED 2026-08-31 (review recommendation 6). Until this date the
    // comment here read "the two Escape branches immediately below ... are
    // deliberately kept: they still carry their non-Escape duties". They had
    // none — both were gated on `&& e.key === 'Escape'` and both conditions
    // are re-asked verbatim in this prologue, which returns, so neither could
    // ever run again. They have been DELETED and the reasoning they carried
    // is folded in here, which is where the live checks are:
    //
    //   * the row drag wins the keystroke ahead of everything else, Ctrl+S
    //     included, so a drag in flight is never resolved by a save;
    //   * the edge-menu condition is `(teMenuKind || teHighlightEls.length)`,
    //     NOT `teMenuKind` alone. That widening was made in S0 (final review
    //     I1) for the HEADER grip, whose click deliberately produces a
    //     highlight with no menu (its only item, "delete row", cannot apply to
    //     a header), so teMenuKind stays null. Gated on teMenuKind alone the
    //     Escape fell through to handleTableCellKeydown()'s own Escape branch
    //     -> revertTableBurstAndEnd(), throwing away everything typed into the
    //     burst — so the header row would have been the one place where
    //     dismissing a selection is destructive. Do not narrow it back.
    //
    // The `closeGutterMenu()` source-presence guard in
    // test/editor-client.test.js is NOT affected: it matches the literal
    // `e.key === 'Escape') { e.preventDefault(); closeGutterMenu();`, which is
    // the THIRD Escape branch, much further down in this same listener, and
    // that one is still live for a keystroke this prologue lets through.
    //
    // Placement note: this sits ABOVE the `.ed-raw` textarea bail below, which
    // is where the two now-deleted Escape branches sat too. Harmless for the raw
    // editor: its own per-instance keydown listener runs in the TARGET phase,
    // before this document-level one, so its Escape has already been handled;
    // and the one menu item that opens a raw editor (MD 原始碼) calls
    // closeGutterMenu() first, so gutterMenuBlockEl is null by then.
    if (e.key === 'Escape') {
      if (tePointer && tePointer.dragging) { e.preventDefault(); cancelTeDrag(); return; }
      // S4 Task 2: the ⠿ block drag gets the same first rung, and for the same
      // reason — Escape-during-a-drag is a distinct gesture from
      // Escape-reverts-the-burst, and the drag must be the one that answers.
      // Mutually exclusive with the rung above (one pointer, one gesture).
      if (blockDragState && blockDragState.dragging) { e.preventDefault(); cancelBlockDrag(); return; }
      if (teMenuKind || teHighlightEls.length) { e.preventDefault(); hideTableEdgeMenu(); return; }
      if (gutterMenuBlockEl || insertMenuBlockEl) {
        e.preventDefault();
        closeGutterMenu();
        closeInsertMenu();
        return;
      }
      // F12, in rank order: the H▾ dropdown is a menu raised from inside the
      // bar, so it goes out before the bar's keyboard mode does, matching the
      // way the menu rungs above rank against the selection rung below.
      if (toolbarMenuEl) { e.preventDefault(); closeToolbarMenu(); return; }
      if (exitToolbarKeynav()) { e.preventDefault(); return; }
      if (blockSelection) { e.preventDefault(); clearBlockSelection(); return; }
      // Nothing above owns this Escape — fall through to the burst
      // short-circuits below, where Escape-reverts-the-burst still belongs.
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

  // The `inputType` values Chromium reports for the BROWSER's own formatting
  // commands. md2doc binds no formatting shortcut of its own — the keys its
  // `ctrlKey || metaKey` branches act on are `Enter`, `z`, `y`, shift+`Z`,
  // `s` and shift+`v`/`V`: the raw editor's commit, undo, redo, save and
  // plain-paste arming. `b`, `i` and `u` are not among them, so Ctrl+B
  // reaches the contenteditable as the browser's own execCommand and does not
  // pass through any snapBurstIfActive() call site.
  //
  // MEASURED (puppeteer 24.42.0 / headless Chromium, an `.ed-wys-armed`
  // paragraph, ' typed sentence' typed then a five-character selection
  // bolded with Ctrl+B) — exactly two events, in this order:
  //
  //   beforeinput  inputType="formatBold"  innerHTML "Alpha paragraph. typed sentence"
  //   input        inputType="formatBold"  innerHTML "Alpha paragraph. <b>typed</b> sentence"
  //
  // i.e. the mutation is the beforeinput's default action, so a beforeinput
  // listener still sees the pre-mutation DOM. That is what makes the pair
  // below the native-command equivalent of the `*-pre` / post snapshots every
  // programmatic call site takes (grep `snapBurstIfActive(` and
  // `history.snap('` for the two families).
  //
  // Three of the inputTypes below were actually driven end to end and are
  // pinned by journey rows: formatBold (Ctrl+B), formatItalic (Ctrl+I),
  // formatUnderline (Ctrl+U) — measured tags `<b>` / `<i>` / `<u>`. The rest —
  // formatStrikeThrough, formatSuperscript, formatSubscript, formatRemove —
  // are listed on the same mechanism but have NOT been driven here; they cost
  // nothing when they never fire, and they are not a claim that they work.
  //
  // A Set, not an object literal: an object literal inherits from
  // Object.prototype, so `types['constructor']` and `types['toString']` are
  // truthy and an inputType named like a prototype key would take the format
  // path. `.has()` answers only for what is actually listed.
  const NATIVE_FORMAT_INPUT_TYPES = new Set([
    'formatBold', 'formatItalic', 'formatUnderline', 'formatStrikeThrough',
    'formatSuperscript', 'formatSubscript', 'formatRemove'
  ]);

  // Resolves the burst history that owns `e.target`, or null. This is the
  // selection logic the `input` listener carried inline before v3.3.0, lifted
  // out unchanged so the new `beforeinput` listener answers the same question
  // the same way: a `.ed-wys-cell` only counts when the current burst is the
  // table burst over its own <table>, and any other surface only counts when
  // it IS the current burst's editEl.
  function burstHistoryForInputEvent(e) {
    if (!e.target || !e.target.closest) return null;
    const cellEl = e.target.closest('.ed-wys-cell');
    if (cellEl) {
      const tableEl = cellEl.closest('table');
      if (currentBurst && currentBurst.blockType === 'table' && currentBurst.editEl === tableEl) {
        return currentBurst.history;
      }
      return null;
    }
    const editEl = e.target.closest('.ed-wys-armed');
    if (!editEl || !currentBurst || currentBurst.editEl !== editEl) return null;
    return currentBurst.history;
  }

  // Capture phase, matching the phase the ordering above was measured in.
  document.addEventListener('beforeinput', (e) => {
    if (!NATIVE_FORMAT_INPUT_TYPES.has(e.inputType)) return;
    const history = burstHistoryForInputEvent(e);
    if (!history) return;
    history.snap('native-format-pre');
  }, true);

  document.addEventListener('input', (e) => {
    const history = burstHistoryForInputEvent(e);
    if (!history) return;
    if (NATIVE_FORMAT_INPUT_TYPES.has(e.inputType)) {
      // The post-mutation half, and it is LOAD-BEARING — do not simplify it
      // back to noteTyping(). noteTyping() does not push anything for this
      // event: it snaps only when the PREVIOUS pending capture is already
      // >= debounceMs old, then sets `isPendingSnap = true` (history.js,
      // noteTyping()). Nothing clears that flag on a timer — only snap(),
      // start() and dispose() assign it false — so the pending capture stands
      // until something flushes it, and undo() flushes it as its first act.
      // By then the capture is of the DOM as it is at UNDO time, not as it
      // was when the command ran.
      //
      // TRACED by wrapping window.md2docHistory.createBurstHistory and
      // logging every call with the stack size on both sides. Two gestures,
      // this line present vs. swapped for noteTyping():
      //
      //   ── Ctrl+B, keep typing inside the window, Ctrl+Z ────────────────
      //   with:     snap('native-format-pre') 1->2   snap('native-format') 2->3
      //             noteTyping() 3->3 x2             undo() 3->3
      //             DOM after undo "Alpha paragraph. <b>typed</b> sentence"
      //   without:  snap('native-format-pre') 1->2   noteTyping() 2->2 x3
      //             undo() 2->2
      //             DOM after undo "Alpha paragraph. typed sentence"
      //
      // Read the `undo() N->N` rows: the size does not drop, so undo() pushed
      // one entry (its flushTyping()) and popped one. WITHOUT this line that
      // flushed entry is "bold + XY", so the pop lands one entry short of the
      // bold and the bold is undone together with everything typed after it —
      // this task's own defect with a different prefix. The journey row
      // 「原生 Ctrl+B 後【400ms 內】繼續打字」 pins exactly that.
      //
      //   ── Ctrl+B, 250ms pause, Ctrl+Z (the four earlier rows) ──────────
      //   with:     snap('native-format-pre') 1->2   snap('native-format') 2->3
      //             undo() 3->2
      //   without:  snap('native-format-pre') 1->2   noteTyping() 2->2
      //             undo() 2->2
      //   both:     DOM after undo "Alpha paragraph. typed sentence"
      //
      // Those four rows do NOT pin this line, and the reason is NOT that the
      // pause cleared anything — the `undo() 2->2` above shows the pending
      // capture was still there and was flushed. It is that with nothing
      // typed after the command, the flushed capture EQUALS what this line
      // would have pushed, so undo steps back to the same entry either way.
      history.snap('native-format');
      return;
    }
    history.noteTyping();
  });

  document.addEventListener('paste', (e) => {
    const cellEl = e.target && e.target.closest && e.target.closest('.ed-wys-cell');
    if (cellEl) {
      e.preventDefault();
      const dt = e.clipboardData || window.clipboardData;
      snapBurstIfActive(cellEl.closest('table'), 'paste-pre');
      insertTextAtCaret(dt ? dt.getData('text/plain') : '');
      snapBurstIfActive(cellEl.closest('table'), 'paste');
      return;
    }
    const editEl = e.target && e.target.closest && e.target.closest('.ed-wys-armed');
    if (!editEl) return;
    e.preventDefault();
    const dt = e.clipboardData || window.clipboardData;
    // v3.1.0 追加 2: paste-md.js decides what the clipboard actually holds
    // (text/html -> markdown, an image, or plain text) and this routes the
    // answer. The TABLE-CELL branch above deliberately keeps its plain-text
    // behaviour: a cell cannot host a block, and a converted markdown table
    // pasted into one cell would be a nested structure the serializer has no
    // way to represent.
    handleArmedPaste(dt, editEl);
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
      // S4 Task 2: and a third, in the same shape, for the ⠿ block drag —
      // without it this listener would keep repainting the ＋ bubbles and
      // repositioning the grips onto whatever row the cursor is dragging
      // across, on top of the drop indicator, every frame of the gesture. Both
      // are HIDDEN rather than merely left un-recomputed, so anything already
      // showing from the frame before the threshold was crossed cannot linger
      // stale. Unlike the table gate above there is no "active grip" to spare:
      // the drag's own handle is a per-block button that the pointer has
      // already left, and the indicator is the whole of the feedback.
      if (blockDragState && blockDragState.dragging) {
        hideTableInsertBubbles();
        hideTableGrips();
        return;
      }
      updateTableInsertBubbles(tbMoveX, tbMoveY, tbMoveTarget);
      updateTableEdgeGrips(tbMoveX, tbMoveY, tbMoveTarget);
    });
  });

  // v3.2.1: client.js 原本的 scroll 監聽器數量是 0，所以每一個 position:fixed
  // 的浮層在捲動後都停在原視窗座標。grip／bubble 有 mousemove 驅動可重新升起，
  // 隱藏它們就夠；.ed-seltb 沒有（它只由 selectionchange 與
  // applyMarkToggle／applyLinkToggle 驅動，而捲動不觸發 selectionchange），
  // 純隱藏會讓它永遠回不來，所以它要重新定位、只在選取整個離開視窗時才隱藏。
  // capture 階段是必要的：真正會自己捲的不是 .content（overflow-y: visible，
  // 實測 scrollHeight === clientHeight，捲的其實是 document）——是側欄的
  // .toc-list／#search-results-list（皆 overflow-y: auto，TOC 標題夠多時
  // 實測 scrollHeight > clientHeight）與 .lightbox-stage（overflow: auto）。
  // 這些容器的 scroll 事件不冒泡，只有 capture 階段收得到。
  // 副作用（已記錄，非缺陷）：正因為 capture 連這些側欄容器的捲動都收，捲動
  // TOC 或搜尋結果清單時——即使正文內容一格都沒動——也會隱藏 table grips
  // 並關掉開著的 .ed-te-menu。
  //
  // 這個監聽器刻意是「模組層級、只掛一次、永不移除」，不跟著任何一次
  // burst 的生命週期走（不在 resetSelToolbarState() 裡拆）。理由：真正會
  // 刪資料的 .ed-te-menu／grip 家族（見上面 Task 5 的 mousemove 委派）不需要
  // 任何 burst 就能被叫出來 —— 使用者可以單純把游標移到表格上（觸發上面那個
  // 無條件掛載的 mousemove）升起 grip、打開 .ed-te-menu，此時完全沒有
  // selToolbarListener（那個監聽器只在 burst 開著時才存在）。若把這個捲動
  // 監聽器綁在 burst 身上，恰好在「grip／選單開著但沒有 burst」這個狀態下
  // 它會不存在。resetSelToolbarState() 本身也會在每次 rerender 時執行（六個
  // 呼叫點之一在本檔的 rerenderAll() 路徑上），把監聽器綁在它身上還會讓
  // 監聽器在 session 中途被拆掉、且永不重掛。
  let selScrollRaf = 0;
  function onAnyScroll() {
    if (tePointer && tePointer.dragging) return;   // 拖曳中不動
    hideTableGrips();
    hideTableInsertBubbles();
    // v3.2.1 fix round 1: suppressEdgeMenuAutoHide — see its own comment —
    // is set for runCycleAlign()'s ensureTableBurstOpen() span, whose
    // cell.focus() can itself be the cause of this very scroll event; that
    // operation repositions the menu itself afterward, so skip tearing its
    // state down here (grip/bubble/toolbar-menu hiding above and below is
    // unaffected — they re-raise on the next mousemove regardless).
    if (!suppressEdgeMenuAutoHide) hideTableEdgeMenu(); // ← 真正會刪資料的是選單，不是 grip
    closeToolbarMenu();
    if (selScrollRaf) return;
    selScrollRaf = requestAnimationFrame(() => {
      selScrollRaf = 0;
      // 沒升起 → 0 次 layout read。Task 16 adds a boolean read here and
      // nothing else. Measured over a scroll burst against instrumented
      // Range/Element rect getters and getComputedStyle: with nothing
      // selected, with a burst open over a collapsed caret, and with a
      // selection that went collapsed while the bar was scrolled away, the
      // reads positionSelToolbar() performs stayed at zero — the same
      // figures as before this line changed. What does read layout per
      // scroll now is a live non-collapsed selection inside the edit root:
      // over the same burst that went from two Range rects to eighteen, one
      // per scroll event, which is the state this branch exists to re-ask.
      if (!selToolbar.parentNode && !selToolbarOffViewport) return;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || sel.isCollapsed) { hideSelToolbar(); return; }
      const range = sel.getRangeAt(0);
      if (!selToolbarEditEl ||
          !selToolbarEditEl.contains(range.startContainer) ||
          !selToolbarEditEl.contains(range.endContainer)) { hideSelToolbar(); return; }
      // Task 15's suppression is asked on this path too, and it has to be:
      // before Task 16 the gate above returned on a detached bar, so a
      // scroll could not raise one. It can now, and a Tab-made full-cell
      // selection is a live non-collapsed selection inside the edit root —
      // the shape the checks above admit. Measured with this line dropped,
      // on a hand selection raised over a cell, scrolled out of view and
      // then walked on by Tab: the scroll that Tab's own focus() causes
      // appended .ed-seltb over the Tab's selection, and it was down again by
      // the time the gesture settled — so the settled state reads the same
      // with this line and without it, and a MutationObserver counting the
      // append is what sees the difference.
      //
      // The flag is read, not the boundary comparison that releases it in
      // onSelectionChangeForToolbar(): a scroll has no release to make, it
      // has to honour what the last selectionchange decided, and reading the
      // flag costs no layout.
      if (tabSelectedCellEl) { hideSelToolbar(); return; }
      positionSelToolbar(range);
    });
  }
  document.addEventListener('scroll', onAnyScroll, { passive: true, capture: true });

  window.addEventListener('beforeunload', (e) => {
    if (stack.dirtyDepth !== 0 || burstHasUncommittedEdit()) {
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
  // v3.1.0 §4: last, so every const it closes over (stack, BLOCK_SKELETONS,
  // selToolbar, …) is initialised and the bar's first deriveState() sees the
  // armed document rather than an empty one.
  mountToolbar();
})();
