'use strict';
const { marked } = require('marked');

// Top-level marked tokens → 1-indexed inclusive line ranges.
// `space` tokens (blank-line runs) advance the cursor but are not blocks.
// A token's `raw` may include trailing newlines (blank lines marked folded
// in); the block's endLine excludes those so ranges never claim blank lines
// that separate blocks.

function trimmedLineCount(raw) {
  const content = raw.replace(/\n+$/, '');
  return content === '' ? 1 : content.split('\n').length;
}

// Recursively emit one `li` block per list item at every depth.
// Recursion order (mirrored by Task 4's render walk):
//   1. Push the item's own block.
//   2. Recurse into that item's nested child lists, left-to-right.
//   3. Move on to the next sibling item.
// `nextId` is a shared box { v: <int> } so ids stay 0..n-1 in document order.
// 0-based LINE offsets, within an item's own raw, at which each of its CHILD
// LIST tokens begins. Exactly one offset per child list token, always — the
// arrays are built in the same pass so they cannot desynchronise.
//
// Anchored on `item.text`, which is marked's DEDENTED copy of the item's own
// content. It is line-for-line with `item.raw` (dedenting removes columns, never
// lines), and every nested token's `raw` is a genuine substring of it, so a
// child's line offset can be COMPUTED from a character offset instead of being
// guessed. Three earlier mechanisms are ruled out, each by a defect it shipped:
//
//   * `ownSpan = totalSpan - childSpan` assumed an item's own lines all precede
//     its children. False for content that resumes after a sublist, and it
//     handed the child a startLine naming the WRONG line.
//   * Matching the child's raw against the item's trimmed LINE TEXT fails twice
//     over: marked dedents a nested raw and, for SAME-LINE nesting, strips the
//     parent marker too (item '- - a' has a child whose raw '- a' appears
//     nowhere in it), so the child was skipped, blocks[] fell one short of the
//     render walk that consumes it in lockstep, and the document failed to open
//     at all; and identical text elsewhere in the item — '- b' inside a fenced
//     or indented code block — won the search, so typing into the real child
//     landed in the fence or destroyed the code block.
//   * Summing each token's raw NEWLINE COUNT looks like the top-level loop's
//     trick but is not: at top level the raws are faithful source slices, while
//     inside an item a `text` token's raw is SYNTHESISED — a lazy continuation
//     comes back as "x\n\ncont\n" (three newlines) for two source lines, which
//     overshoots every following child by one.
//
// So `text` tokens are skipped rather than trusted, and every other token is
// consumed monotonically to advance the cursor. That ordering is what keeps a
// code block's lookalike content behind us: the `code` token itself claims those
// bytes before the following `list` token is searched for. A child list always
// begins a line, so its match is additionally required to land at a line start —
// which rules out a marker sitting inside an inline code span on a text line.
function lineOffsetAt(content, charOffset) {
  return (content.slice(0, charOffset).match(/\n/g) || []).length;
}

function indexOfAtLineStart(content, needle, from) {
  let at = content.indexOf(needle, from);
  while (at > 0 && content.charAt(at - 1) !== '\n') {
    at = content.indexOf(needle, at + 1);
  }
  return at;
}

// The search above is a byte-for-byte `indexOf`, and marked does not hand back
// bytes that match byte-for-byte: a nested list token's `raw` has the trailing
// spaces stripped off its LAST line while the enclosing `item.text` keeps them.
// MEASURED on this repo's marked, for '# H\n\n- alpha\n  - beta\n  - \n- gamma\n':
//
//   item.text          "alpha\n- beta\n- "      <- trailing space kept
//   child list tk.raw  "- beta\n-\n"            <- trailing space gone, \n added
//
// so `content.indexOf(tk.raw)` was -1, and the guessed offset 0 that followed
// shifted every descendant's startLine UP one line. That is not a corner: the
// markdown the CLIENT serialises mid-session contains the shape:
// '# H\n\n- alpha\n  - beta\n    - \n- gamma\n' was captured coming back from
// client.js during a test/editor-journey.test.js run and mapped to an inverted
// range under the old search. Ordinary authored markdown does it too — an
// everyday flat-plus-nested list corrupts the moment a trailing space lands on
// its nested line. Neither of those two strings is itself a fixture: the capture
// harness and the mutation sweep that found them are in
// .superpowers/sdd/2026-09-07-md2doc-v3.3.0/task-4-report.md §4. What IS pinned,
// and what to read instead, is the shape FAMILY — grep 'trailing space' in
// test/blockmap.test.js for the range assertions, and 'eats the item above' in
// test/editor-journey.test.js for the gestures that used to do exactly that.
//
// Both sides are put through the same normalisation before the search: trailing
// spaces and tabs are dropped from every line. Two properties are relied on,
// and they are different from each other:
//
//   LINE OFFSETS SURVIVE. The transform only ever removes characters that are
//   not '\n', so it cannot change a line count — a character offset found in
//   the normalised copy names the same LINE offset it would have named in the
//   original, and a line offset is the only thing this function returns.
//
//   SUBSTRINGS SURVIVE. If the needle occurred in the content before, the
//   normalised needle occurs in the normalised content. Every '\n' inside the
//   needle is the same '\n' in the content, so a space run sitting before it is
//   stripped identically on both sides; the two can only disagree at the
//   needle's own END, where the needle may lose a trailing run the content
//   keeps. That only makes the needle SHORTER, and a prefix of a substring is
//   still a substring. (Byte identity of two equal strings under a shared
//   transform is the wrong lemma here — it says nothing about a needle whose
//   surroundings differ from its own end.)
//
// The needle additionally loses its trailing newlines (`\n+$`), because the raw
// of a token that ends the item carries a terminator `item.text` does not have.
// That leaves `pos` on the newline (or newlines) that ended the consumed token
// rather than after them, so both searches below start earlier than they used
// to and a match could in principle land on one of those bytes. One argument
// rules that out for both searches at once, so it is the only one stated here:
// to match at a position occupied by a newline, the NEEDLE would have to begin
// with a newline. MEASURED over the journey capture plus a synthetic sweep of
// nested lists (blank lines, fenced code, blockquotes, tab indents, ordered and
// task markers): no nested list token's `raw` began with '\n'. Labelled
// MEASURED and not invariant — nothing downstream may assume it.
function stripTrailingLineSpace(s) {
  return s.replace(/[ \t]+$/gm, '');
}

// Returns { offsets, unlocatable }. `offsets` keeps its old contract exactly:
// one entry per child list token, always, in order. `unlocatable` is true when
// at least one of those entries is a GUESS rather than a found position —
// see pushListItemBlocks(), which is what acts on it.
function childListStartOffsets(item) {
  const content = stripTrailingLineSpace(
    typeof item.text === 'string' ? item.text : ''
  );
  const offsets = [];
  let unlocatable = false;
  let pos = 0;
  for (const tk of item.tokens || []) {
    const needle = stripTrailingLineSpace(typeof tk.raw === 'string' ? tk.raw : '')
      .replace(/\n+$/, '');
    if (tk.type === 'list') {
      // An empty needle would make `indexOf` answer `pos` for any content, i.e.
      // report a find that was never made. Treated as not-found instead.
      let at = needle === '' ? -1 : indexOfAtLineStart(content, needle, pos);
      if (at < 0 && needle !== '') at = content.indexOf(needle, pos);
      // Unlocatable (a shape this walk does not model): fall back to the line
      // the cursor is already on. Never skip — a missing block desynchronises
      // the render walk and takes the whole document down.
      if (at < 0) unlocatable = true;
      offsets.push(at < 0 ? lineOffsetAt(content, pos) : lineOffsetAt(content, at));
      if (at >= 0) pos = at + needle.length;
      continue;
    }
    // `text` raws are synthesised; everything else is a faithful slice and is
    // consumed so later searches start beyond it.
    if (tk.type === 'text') continue;
    // BEHAVIOUR CHANGE, small and deliberate: before the trailing-newline trim
    // above, a `space` token (a blank-line run inside the item) had a needle of
    // pure newlines and this branch consumed it, advancing `pos` past the blank
    // run. Trimmed, that needle is '' — and `''.indexOf` answers `pos` for any
    // content, i.e. a find that was never made — so the token is skipped and
    // `pos` stays where it was, which means every later search starts earlier
    // than it used to.
    //
    // What establishes that this is harmless is an ABLATION, not an argument: a
    // copy of this function that still advances `pos` past an empty needle
    // (using the untrimmed raw) produced block maps identical to these on every
    // document of the journey capture, of its trailing-space mutations, and of a
    // synthetic nested-list sweep. The same sweeps also show `space` was the
    // only token type whose needle ever collapsed to '' — which is the only type
    // that CAN, its raw being whitespace by construction.
    if (needle === '') continue;
    const at = content.indexOf(needle, pos);
    if (at >= 0) pos = at + needle.length;
  }
  return { offsets, unlocatable };
}

// `inheritedUnlocatable` is how an item degrades its whole subtree: see the
// `degraded` note below the block literal.
function pushListItemBlocks(listToken, cursor, indent, blocks, nextId, inheritedUnlocatable) {
  for (const item of listToken.items) {
    const childListTokens = item.tokens.filter((t) => t.type === 'list');
    const totalSpan = trimmedLineCount(item.raw);
    const located = childListStartOffsets(item);
    const childLineOffsets = located.offsets;
    const degraded = !!inheritedUnlocatable || located.unlocatable;

    // The item's OWN block covers its contiguous leading lines only — up to its
    // first child.
    //
    // `ownSpan = totalSpan - childSpan` (the original) assumed an item's own
    // lines all come BEFORE its children. That is true of most markdown and
    // false of this, which CommonMark allows:
    //
    //     - a
    //       - b
    //
    //       more text
    //     - c
    //
    // There, `a` owns line 1 AND line 4 with its child in between, so the old
    // arithmetic put the child's cursor at line 4 — `b.startLine` named
    // "  more text" instead of "  - b". In the flat block model startLine is
    // the ADDRESS every gutter action and every focusBlockAtLine() lookup uses,
    // so a wrong one silently targets somebody else's line.
    //
    // Own content that resumes AFTER a child stays deliberately OUT of the
    // range rather than mis-covered: it is genuinely discontiguous and a
    // {startLine, endLine} pair cannot represent it. Such an item is also
    // unsupported to the serializer (it renders as two <p>s, or as one text
    // node holding a newline — see list-md.js's 'P' / 'MULTILINE' reporting),
    // so it is never armed and no structural key acts on it as a target.
    //
    // SAME-LINE nesting ('- - a') gives ownSpan 0, so the outer item's endLine
    // sits one BEFORE its startLine. That is not a quirk to be smoothed over:
    // the item's own content really is empty, because the child begins on the
    // very first line, and an EMPTY range is the only honest way to say so.
    // Preserved as-is — it is the shape this file has always produced for that
    // markdown.
    //
    // It is the one place a block's range is not a well-formed interval, and
    // that is dangerous rather than merely odd: lineops.js's replaceLines()
    // computes `slice(0, start-1).concat(new, slice(end))`, whose two slices
    // OVERLAP when end < start, so a commit against such a range INSERTS a line
    // and leaves the original standing. The guarantee that no commit ever
    // reaches one is enforced in lib/editor/client.js, at the single arming
    // boundary — canWysiwygForLi() refuses a block whose range is empty, so it
    // is never editable and no commit path can start on it. If you add a
    // consumer that walks block ranges, either honour that emptiness or check
    // for it; do not assume `startLine <= endLine`.
    //
    // DEGRADED SUBTREE. When childListStartOffsets() could not FIND a child
    // list and had to guess its line, every line number computed from that
    // guess is fiction, and the fiction does not stop at the parent: the guess
    // is the offset each descendant's cursor is built from, so an entire nested
    // run gets addresses belonging to the lines ABOVE it. That is not an
    // abstract risk — it is the shape a user is in between typing a nested
    // marker and typing its first character, and the observed result was that
    // client.js's bystanderCarryOver() replayed the WRONG source line over a
    // sibling: '- alpha\n  - beta\n  - \n' committed back as
    // '- alpha\n  - alpha\n-\n', with beta gone from the file.
    //
    // So the whole subtree — this item and, via `inheritedUnlocatable`, every
    // item below it — is given an EMPTY range (endLine === startLine - 1)
    // rather than a wrong one. Empty is a shape this codebase already defines
    // and already defends: client.js's blockOwnsNoLine() is `endLine <
    // startLine`, and the functions that call it directly are
    // canWysiwygForLi() (arming), openRawEditor() (the raw textarea),
    // insertBlockBelow() (the ＋ paths, twice — anchor and subtree tail),
    // resolveGutterOperands() (twice — where the ⠿ menu's 刪除 and every other
    // grip operation resolves its targets, reached from deleteBlockViaGutter()
    // through deleteBlockViaGutterBody()) and bystanderCarryOver() (the replay
    // of untouched siblings). So an empty range refuses at every arming and
    // commit boundary instead of writing somebody else's line.
    //
    // Every block is still PUSHED. lib/md2doc.js's edit-mode render walk
    // consumes blocks[] in lockstep and throws on `biRef.v !== blocks.length`,
    // so a skipped block takes the whole document down; an empty range costs
    // that check nothing, and server.js's assertBlockRangesFit() only rejects
    // `endLine > lines.length`, which a shortened range can never trip.
    //
    // `unlocatable` marks these records so the client can say WHY it refused.
    // Same-line nesting ('- - a') produces an empty range too, and it is a
    // legitimate, fully-modelled shape — it does not get the flag, and it
    // keeps its own existing wording.
    //
    // ACCEPTED RESIDUAL: the degraded subtree's source lines end up owned by no
    // block at all. lib/editor/selection.js's `ownsALine()` is
    // `b.endLine >= b.startLine`, and membersOf() filters on it, so those lines
    // fall out of every block selection — a drag across them selects the blocks
    // either side and nothing in between. That is the price of emptying the
    // subtree instead of corrupting it, and it is the right trade: a wrong
    // range writes over somebody else's line, an absent one only cannot be
    // selected. Unreachable as this is written (no markdown found so far makes
    // the search fail); recorded here so whoever first reaches it meets this
    // in the code rather than in the field.
    const ownSpan = childLineOffsets.length ? childLineOffsets[0] : totalSpan;
    const block = {
      id: nextId.v++,
      type: 'li',
      startLine: cursor,
      endLine: degraded ? cursor - 1 : cursor + ownSpan - 1,
      // Two independent axes (RULING F-N): GFM allows `1. [ ] a`, so
      // ordered-ness and task-ness cannot share one field. `listType` is the
      // LIST's type; `task` is the ITEM's.
      listType: listToken.ordered ? 'ol' : 'ul',
      task: !!item.task,
      indent,
    };
    if (item.task) block.checked = !!item.checked;
    if (degraded) block.unlocatable = true;
    blocks.push(block);
    // Every child is emitted, unconditionally: blocks[] is consumed in lockstep
    // by lib/md2doc.js's render walk, so a skipped child desynchronises the two
    // and the render runs off the end of the array.
    childListTokens.forEach((ct, k) => {
      pushListItemBlocks(ct, cursor + childLineOffsets[k], indent + 1, blocks, nextId, degraded);
    });
    // advance cursor by full item raw newlines; fall back to totalSpan if raw
    // has no trailing newline (EOF item).
    cursor += (item.raw.match(/\n/g) || []).length || totalSpan;
  }
}

function buildBlockMap(mdText) {
  const tokens = marked.lexer(mdText);
  const blocks = [];
  let cursor = 1; // current line number of the token's first character
  const nextId = { v: 0 };
  for (const t of tokens) {
    const rawNewlines = (t.raw.match(/\n/g) || []).length;
    if (t.type === 'list') {
      pushListItemBlocks(t, cursor, 0, blocks, nextId);
    } else if (t.type !== 'space') {
      const content = t.raw.replace(/\n+$/, '');
      const span = content === '' ? 1 : content.split('\n').length;
      blocks.push({
        id: nextId.v++,
        type: t.type,
        startLine: cursor,
        endLine: cursor + span - 1,
      });
    }
    // advance by full raw (including folded trailing blank lines).
    // If raw has no trailing newline (EOF), the next token doesn't exist,
    // so the off-by-one is unobservable.
    cursor += rawNewlines;
  }
  return { blocks, lineCount: mdText.split('\n').length };
}

module.exports = { buildBlockMap };
