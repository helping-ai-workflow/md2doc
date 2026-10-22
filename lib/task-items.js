'use strict';
// v3.15.0 B2 fix round 1 (R56): an EMPTY to-do item at the token level.
//
// marked reads `[ ]` / `[x]` as a checkbox only when a space follows it, and
// it trims an item's trailing whitespace first when the item is the last one
// of a NESTED list: `- a\n  - [ ] \n` (end of file, or a paragraph next) lexes
// the child as a plain item whose text is "[ ]" (measured, marked 14.1.4).
// The editor writes exactly that shape for a new empty to-do (Enter at the end
// of a nested last to-do), and no byte form of an empty nested task survives
// marked without visible content. So the READING side decides: a list item
// whose whole text is `[ ]`, `[x]` or `[X]` and that marked did not already
// read as a task is an empty to-do, checked accordingly.
//
// One place for both readers: this module installs the rule on marked's own
// `list` tokenizer, so every marked.lexer() / marked.parse() in the process —
// the reader renderer (lib/md2doc.js) and the editor's block map
// (lib/editor/blockmap.js), which both require this file — sees the same
// token. An escaped box (`- \[ \]`, what the editor writes for that text in a
// plain item) is text and stays text. Other renderers (GitHub) still show a
// literal "[ ]" for such an item; that is what the file says.
const { marked } = require('marked');

const EMPTY_BOX = /^\[([ xX])\]$/;

function normalizeListToken(listToken) {
  if (!listToken || !Array.isArray(listToken.items)) return listToken;
  listToken.items.forEach((item) => {
    if (!item || item.task) return;
    const m = EMPTY_BOX.exec(String(item.text || '').trim());
    if (!m) return;
    item.task = true;
    item.checked = m[1] !== ' ';
    item.text = '';
    item.tokens = [];
  });
  return listToken;
}

marked.use({
  tokenizer: {
    list(src) {
      const token = marked.Tokenizer.prototype.list.call(this, src);
      return token ? normalizeListToken(token) : token;
    },
  },
});

module.exports = { normalizeListToken };
