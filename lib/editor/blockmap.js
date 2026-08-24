'use strict';
const { marked } = require('marked');

// Top-level marked tokens → 1-indexed inclusive line ranges.
// `space` tokens (blank-line runs) advance the cursor but are not blocks.
// A token's `raw` may include trailing newlines (blank lines marked folded
// in); the block's endLine excludes those so ranges never claim blank lines
// that separate blocks.
function buildBlockMap(mdText) {
  const tokens = marked.lexer(mdText);
  const blocks = [];
  let cursor = 1; // current line number of the token's first character
  let id = 0;
  for (const t of tokens) {
    const rawNewlines = (t.raw.match(/\n/g) || []).length;
    if (t.type !== 'space') {
      const content = t.raw.replace(/\n+$/, '');
      const span = content === '' ? 1 : content.split('\n').length;
      blocks.push({
        id: id++,
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
