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
function pushListItemBlocks(listToken, cursor, indent, blocks, nextId) {
  for (const item of listToken.items) {
    const childListTokens = item.tokens.filter((t) => t.type === 'list');
    const totalSpan = trimmedLineCount(item.raw);
    const childSpan = childListTokens.reduce((s, t) => s + trimmedLineCount(t.raw), 0);
    const ownSpan = totalSpan - childSpan;
    const block = {
      id: nextId.v++,
      type: 'li',
      startLine: cursor,
      endLine: cursor + ownSpan - 1,
      listType: item.task ? 'task' : (listToken.ordered ? 'ol' : 'ul'),
      indent,
    };
    if (item.task) block.checked = !!item.checked;
    blocks.push(block);
    let childCursor = cursor + ownSpan;
    for (const ct of childListTokens) {
      pushListItemBlocks(ct, childCursor, indent + 1, blocks, nextId);
      childCursor += (ct.raw.match(/\n/g) || []).length;
    }
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
