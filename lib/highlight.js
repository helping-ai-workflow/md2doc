'use strict';
// v3.10.0: syntax colour for fenced code, done once when the HTML is written —
// the reading page needs no script for it, and PDF gets it for free. Only the
// languages below are registered; anything else (or no language) stays plain
// text rather than guessing.
const hljs = require('highlight.js/lib/core');

const LANG_DEFS = {
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
for (const [name, def] of Object.entries(LANG_DEFS)) hljs.registerLanguage(name, def);
// The two custom alias lists, flat: alias -> language. Registered below and
// replayed verbatim by browserBundle().
const ALIASES = {};
for (const [target, list] of [['verilog', ['systemverilog', 'sv', 'v']], ['bash', ['sh', 'shell', 'zsh']]]) {
  hljs.registerAliases(list, { languageName: target });
  for (const a of list) ALIASES[a] = target;
}
// The registered ids, in registration order (the editor's language menu).
const LANGS = Object.keys(LANG_DEFS);

// `lang` is the fence's info string; only its first word names the language,
// case-insensitively. Returns escaped, coloured HTML, or null when the
// language is missing or not registered.
function highlightCode(code, lang) {
  const name = String(lang || '').trim().split(/\s+/)[0].toLowerCase();
  if (!name || !hljs.getLanguage(name)) return null;
  return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
}

// v3.17.0 D6: the same highlighter as one script for the edit page, served on
// demand at /api/lib/highlight.js. highlight.js core and each registered
// language wrapped in a CommonJS shim, then the same registration and the same
// highlightCode semantics. No closing script tag may appear in it (the page
// loads it as a script; a test guards that). Built once.
let bundle = null;
function browserBundle() {
  if (bundle !== null) return bundle;
  const fs = require('fs');
  const wrap = (file) => '(function () { var module = { exports: {} }; var exports = module.exports;\n' +
    fs.readFileSync(require.resolve(file), 'utf8') + '\nreturn module.exports; })()';
  const parts = [
    '(function () {',
    'var hljs = ' + wrap('highlight.js/lib/core') + ';',
    'var defs = {',
    LANGS.map((n) => JSON.stringify(n) + ': ' + wrap('highlight.js/lib/languages/' + n)).join(',\n'),
    '};',
    'var LANGS = ' + JSON.stringify(LANGS) + ';',
    'var ALIASES = ' + JSON.stringify(ALIASES) + ';',
    'LANGS.forEach(function (n) { hljs.registerLanguage(n, defs[n]); });',
    'Object.keys(ALIASES).forEach(function (a) { hljs.registerAliases([a], { languageName: ALIASES[a] }); });',
    'function highlightCode(code, lang) {',
    "  var name = String(lang || '').trim().split(/\\s+/)[0].toLowerCase();",
    '  if (!name || !hljs.getLanguage(name)) return null;',
    "  return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;",
    '}',
    "var root = typeof window !== 'undefined' ? window : self;",
    'root.md2docHljs = { highlightCode: highlightCode, LANGS: LANGS };',
    '})();',
  ];
  bundle = parts.join('\n');
  return bundle;
}

module.exports = { highlightCode, LANGS, ALIASES, browserBundle };
