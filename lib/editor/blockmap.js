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
// 0-based LINE offsets of each child list token inside its item's own raw.
//
// Matching is by line, not by substring: marked DEDENTS a nested token's `raw`
// (an item `'- a\n  - b\n'` has a child whose raw is `'- b'`, with the parent's
// two-space indent stripped), so `item.raw.indexOf(child.raw)` is always -1 for
// anything nested. Comparing trimmed line text sidesteps the indent entirely.
//
// The scan is monotonic — each child resumes past the previous child's last
// line — so a DESCENDANT line that happens to read the same as a later
// sibling's first line cannot be matched early.
// Returns -1 for a child that cannot be located; the caller skips it rather
// than inventing an address.
function childListLineOffsets(itemRaw, childListTokens) {
  const lines = itemRaw.split('\n');
  const offsets = [];
  let from = 0;
  for (const ct of childListTokens) {
    const head = ct.raw.split('\n')[0].trim();
    let at = -1;
    for (let i = from; i < lines.length; i++) {
      if (lines[i].trim() === head) { at = i; break; }
    }
    offsets.push(at);
    if (at >= 0) from = at + trimmedLineCount(ct.raw);
  }
  return offsets;
}

function pushListItemBlocks(listToken, cursor, indent, blocks, nextId) {
  for (const item of listToken.items) {
    const childListTokens = item.tokens.filter((t) => t.type === 'list');
    const totalSpan = trimmedLineCount(item.raw);

    // A child list's position inside the item is LOCATED, never derived from
    // "total minus children".
    //
    // `ownSpan = totalSpan - childSpan` assumed an item's own lines all come
    // BEFORE its children. That is true of most markdown and false of this,
    // which CommonMark allows:
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
    // Searching forward through `item.raw` (never from 0 twice) keeps the
    // offsets monotonic, so identical child text at two depths cannot alias.
    const childLineOffsets = childListLineOffsets(item.raw, childListTokens);

    // The item's OWN block covers its contiguous leading lines only — up to
    // its first child. Own content that resumes AFTER a child is genuinely
    // discontiguous and a {startLine, endLine} pair cannot represent it, so it
    // is deliberately left OUT of the range rather than mis-covered. Such an
    // item is also unsupported to the serializer (it renders as two <p>s, or as
    // one text node holding a newline — see list-md.js's 'P'/'MULTILINE'
    // reporting), so it is never armed and no structural key acts on it: the
    // range is never used to rewrite it.
    const firstChildLine = childLineOffsets.length && childLineOffsets[0] >= 0
      ? childLineOffsets[0] : -1;
    const ownSpan = firstChildLine >= 0 ? firstChildLine : totalSpan;
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
    childListTokens.forEach((ct, k) => {
      const off = childLineOffsets[k];
      // A child whose raw could not be located (shape this walk does not model)
      // is skipped rather than given a guessed address — emitting a block whose
      // startLine names the wrong line is the very failure this replaced.
      if (off < 0) return;
      pushListItemBlocks(ct, cursor + off, indent + 1, blocks, nextId);
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
