'use strict';
// v3.10.0: syntax colour for fenced code, done once when the HTML is written —
// the reading page needs no script for it, and PDF gets it for free. Only the
// languages below are registered; anything else (or no language) stays plain
// text rather than guessing.
const hljs = require('highlight.js/lib/core');

const LANGS = {
  verilog: require('highlight.js/lib/languages/verilog'),
  python: require('highlight.js/lib/languages/python'),
  bash: require('highlight.js/lib/languages/bash'),
  c: require('highlight.js/lib/languages/c'),
  cpp: require('highlight.js/lib/languages/cpp'),
  json: require('highlight.js/lib/languages/json'),
  yaml: require('highlight.js/lib/languages/yaml'),
  tcl: require('highlight.js/lib/languages/tcl'),
  makefile: require('highlight.js/lib/languages/makefile'),
  javascript: require('highlight.js/lib/languages/javascript'),
  diff: require('highlight.js/lib/languages/diff'),
  plaintext: require('highlight.js/lib/languages/plaintext'),
};
for (const [name, def] of Object.entries(LANGS)) hljs.registerLanguage(name, def);
hljs.registerAliases(['systemverilog', 'sv', 'v'], { languageName: 'verilog' });
hljs.registerAliases(['sh', 'shell', 'zsh'], { languageName: 'bash' });

// `lang` is the fence's info string; only its first word names the language,
// case-insensitively. Returns escaped, coloured HTML, or null when the
// language is missing or not registered.
function highlightCode(code, lang) {
  const name = String(lang || '').trim().split(/\s+/)[0].toLowerCase();
  if (!name || !hljs.getLanguage(name)) return null;
  return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
}

module.exports = { highlightCode };
