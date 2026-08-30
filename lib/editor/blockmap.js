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

function childListStartOffsets(item) {
  const content = typeof item.text === 'string' ? item.text : '';
  const offsets = [];
  let pos = 0;
  for (const tk of item.tokens || []) {
    if (tk.type === 'list') {
      let at = indexOfAtLineStart(content, tk.raw, pos);
      if (at < 0) at = content.indexOf(tk.raw, pos);
      // Unlocatable (a shape this walk does not model): fall back to the line
      // the cursor is already on. Never skip — a missing block desynchronises
      // the render walk and takes the whole document down.
      offsets.push(at < 0 ? lineOffsetAt(content, pos) : lineOffsetAt(content, at));
      if (at >= 0) pos = at + tk.raw.length;
      continue;
    }
    // `text` raws are synthesised; everything else is a faithful slice and is
    // consumed so later searches start beyond it.
    if (tk.type === 'text') continue;
    const at = content.indexOf(tk.raw, pos);
    if (at >= 0) pos = at + tk.raw.length;
  }
  return offsets;
}

function pushListItemBlocks(listToken, cursor, indent, blocks, nextId) {
  for (const item of listToken.items) {
    const childListTokens = item.tokens.filter((t) => t.type === 'list');
    const totalSpan = trimmedLineCount(item.raw);
    const childLineOffsets = childListStartOffsets(item);

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
    const ownSpan = childLineOffsets.length ? childLineOffsets[0] : totalSpan;
    const block = {
      id: nextId.v++,
      type: 'li',
      startLine: cursor,
      endLine: cursor + ownSpan - 1,
      // Two independent axes (RULING F-N): GFM allows `1. [ ] a`, so
      // ordered-ness and task-ness cannot share one field. `listType` is the
      // LIST's type; `task` is the ITEM's.
      listType: listToken.ordered ? 'ol' : 'ul',
      task: !!item.task,
      indent,
    };
    if (item.task) block.checked = !!item.checked;
    blocks.push(block);
    // Every child is emitted, unconditionally: blocks[] is consumed in lockstep
    // by lib/md2doc.js's render walk, so a skipped child desynchronises the two
    // and the render runs off the end of the array.
    childListTokens.forEach((ct, k) => {
      pushListItemBlocks(ct, cursor + childLineOffsets[k], indent + 1, blocks, nextId);
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
