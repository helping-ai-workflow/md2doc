'use strict';

/**
 * wave-codec — a tolerant WaveJSON reader that remembers where every value came from.
 *
 * WaveJSON is a JavaScript object literal, not strict JSON. Real wavedrom code
 * blocks use unquoted keys, single-quoted strings, trailing commas and line or
 * block comments; `JSON.parse` rejects all four. So this is a small
 * recursive-descent parser instead.
 *
 * It also records, for every value it parses, the half-open source range
 * `[start, end)` of that value's literal text. That is what lets a later
 * write-back rewrite only the bytes of the one value that changed, leaving the
 * author's indentation, quote characters and comments untouched. Nothing is
 * normalised on the way in: `0..0` and `0...` render differently in wavedrom, so
 * a parser that "tidied" a wave string would be destroying information.
 *
 * Security: the source text comes out of the user's markdown file, so it is
 * never handed to a code-executing API. There is no use of the global `eval`
 * and no dynamic Function construction anywhere in this file.
 *
 * @typedef {Array<string|number>} DocPath
 *   Object keys are strings, array indices are numbers — `['signal', 0, 'wave']`.
 *   `spans` is keyed by `JSON.stringify(path)`, so index types must match:
 *   `['signal','0','wave']` is a different key and is never produced here.
 */

const SPACE = {
  ' ': 1, '\t': 1, '\n': 1, '\r': 1, '\f': 1, '\v': 1,
  ' ': 1, '﻿': 1, ' ': 1, ' ': 1,
};

const NUMBER_RE = /[+-]?(?:0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|Infinity|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/y;
const WORD_RE = /[A-Za-z_$-￿][A-Za-z0-9_$-￿]*/y;

/**
 * Parse a WaveJSON source string.
 *
 * @param {string} text
 * @returns {{ok: true, doc: any, spans: Map<string, [number, number]>}
 *          |{ok: false, message: string, offset: number}}
 */
function parseSource(text) {
  if (typeof text !== 'string') {
    return {
      ok: false,
      offset: 0,
      message: 'parseSource expects a string, got ' + (text === null ? 'null' : typeof text),
    };
  }
  const st = { text: text, i: 0, spans: new Map() };
  try {
    skipTrivia(st);
    if (st.i >= text.length) fail(st, st.i, 'Empty source: expected a WaveJSON value');
    const doc = parseValue(st, []);
    skipTrivia(st);
    if (st.i < text.length) {
      fail(st, st.i, 'Unexpected trailing content after the top-level value');
    }
    return { ok: true, doc: doc, spans: st.spans };
  } catch (err) {
    if (err && err.isWaveParseError) {
      return { ok: false, message: err.message, offset: err.offset };
    }
    throw err;
  }
}

/** Throw a positioned parse error. `parseSource` turns it into `{ok:false}`. */
function fail(st, offset, message) {
  const before = st.text.slice(0, offset);
  const line = before.split('\n').length;
  const col = offset - (before.lastIndexOf('\n') + 1) + 1;
  const err = new Error(message + ' (line ' + line + ', column ' + col + ')');
  err.isWaveParseError = true;
  err.offset = offset;
  throw err;
}

/** Skip whitespace, line comments and block comments. */
function skipTrivia(st) {
  const t = st.text;
  for (;;) {
    const c = t[st.i];
    if (c === undefined) return;
    if (SPACE[c] === 1) { st.i++; continue; }
    if (c === '/' && t[st.i + 1] === '/') {
      st.i += 2;
      while (st.i < t.length && t[st.i] !== '\n' && t[st.i] !== '\r') st.i++;
      continue;
    }
    if (c === '/' && t[st.i + 1] === '*') {
      const start = st.i;
      const end = t.indexOf('*/', st.i + 2);
      if (end === -1) fail(st, start, 'Unterminated block comment');
      st.i = end + 2;
      continue;
    }
    return;
  }
}

/** Parse one value and record its span under `path`. */
function parseValue(st, path) {
  skipTrivia(st);
  const start = st.i;
  const c = st.text[st.i];
  if (c === undefined) fail(st, start, 'Unexpected end of input: expected a value');
  let value;
  if (c === '{') value = parseObject(st, path);
  else if (c === '[') value = parseArray(st, path);
  else if (c === '"' || c === "'") value = parseString(st);
  else if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) value = parseNumber(st);
  else value = parseWord(st);
  st.spans.set(JSON.stringify(path), [start, st.i]);
  return value;
}

function parseObject(st, path) {
  const obj = {};
  st.i++; // consume the opening brace
  for (;;) {
    skipTrivia(st);
    const c = st.text[st.i];
    if (c === undefined) fail(st, st.i, 'Unterminated object: expected a closing brace');
    if (c === '}') { st.i++; return obj; }
    const key = parseKey(st);
    skipTrivia(st);
    if (st.text[st.i] !== ':') {
      fail(st, st.i, "Expected ':' after key " + JSON.stringify(key));
    }
    st.i++;
    const value = parseValue(st, path.concat([key]));
    assign(obj, key, value);
    skipTrivia(st);
    const sep = st.text[st.i];
    if (sep === ',') { st.i++; continue; }   // a trailing comma just loops round to the brace
    if (sep === '}') { st.i++; return obj; }
    if (sep === undefined) fail(st, st.i, 'Unterminated object: expected a closing brace');
    fail(st, st.i, "Expected ',' or '}' but found " + JSON.stringify(sep));
  }
}

function parseArray(st, path) {
  const arr = [];
  st.i++; // consume the opening bracket
  for (;;) {
    skipTrivia(st);
    const c = st.text[st.i];
    if (c === undefined) fail(st, st.i, 'Unterminated array: expected a closing bracket');
    if (c === ']') { st.i++; return arr; }
    arr.push(parseValue(st, path.concat([arr.length])));
    skipTrivia(st);
    const sep = st.text[st.i];
    if (sep === ',') { st.i++; continue; }   // a trailing comma just loops round to the bracket
    if (sep === ']') { st.i++; return arr; }
    if (sep === undefined) fail(st, st.i, 'Unterminated array: expected a closing bracket');
    fail(st, st.i, "Expected ',' or ']' but found " + JSON.stringify(sep));
  }
}

/** Object keys: quoted string, bare identifier, or numeric literal. */
function parseKey(st) {
  const c = st.text[st.i];
  if (c === '"' || c === "'") return parseString(st);
  if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) return String(parseNumber(st));
  WORD_RE.lastIndex = st.i;
  const m = WORD_RE.exec(st.text);
  if (!m) {
    fail(st, st.i, 'Expected a property name but found ' + JSON.stringify(c === undefined ? '' : c));
  }
  st.i += m[0].length;
  return m[0];
}

/**
 * Write a key without letting a `__proto__` key in the source reach the
 * prototype chain — the text is untrusted.
 */
function assign(obj, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(obj, key, {
      value: value, enumerable: true, writable: true, configurable: true,
    });
  } else {
    obj[key] = value;
  }
}

function parseString(st) {
  const quote = st.text[st.i];
  const start = st.i;
  st.i++;
  let out = '';
  for (;;) {
    if (st.i >= st.text.length) fail(st, start, 'Unterminated string literal');
    const c = st.text[st.i];
    if (c === quote) { st.i++; return out; }
    if (c === '\n' || c === '\r') {
      fail(st, st.i, 'Unterminated string literal: line break inside a string');
    }
    if (c === '\\') { st.i++; out += readEscape(st); continue; }
    out += c;
    st.i++;
  }
}

function readEscape(st) {
  if (st.i >= st.text.length) fail(st, st.i, 'Unterminated escape sequence');
  const c = st.text[st.i];
  st.i++;
  switch (c) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case 'b': return '\b';
    case 'f': return '\f';
    case 'v': return '\v';
    case '0':
      if (st.text[st.i] >= '0' && st.text[st.i] <= '9') {
        fail(st, st.i - 2, 'Octal escape sequences are not supported');
      }
      return '\0';
    case 'x': return String.fromCharCode(readHex(st, 2, st.i - 2));
    case 'u': {
      if (st.text[st.i] === '{') {
        const open = st.i;
        st.i++;
        let digits = '';
        while (st.i < st.text.length && st.text[st.i] !== '}') digits += st.text[st.i++];
        if (st.text[st.i] !== '}' || !/^[0-9a-fA-F]{1,6}$/.test(digits)) {
          fail(st, open - 2, 'Invalid unicode escape sequence');
        }
        st.i++;
        const code = parseInt(digits, 16);
        if (code > 0x10ffff) fail(st, open - 2, 'Unicode escape sequence out of range');
        return String.fromCodePoint(code);
      }
      return String.fromCharCode(readHex(st, 4, st.i - 2));
    }
    case '\r':
      if (st.text[st.i] === '\n') st.i++;
      return '';       // line continuation
    case '\n': return '';
    default: return c; // an escaped quote, backslash or slash stands for itself
  }
}

function readHex(st, count, errAt) {
  const digits = st.text.slice(st.i, st.i + count);
  if (digits.length < count || !/^[0-9a-fA-F]+$/.test(digits)) {
    fail(st, errAt, 'Invalid hexadecimal escape sequence');
  }
  st.i += count;
  return parseInt(digits, 16);
}

function parseNumber(st) {
  NUMBER_RE.lastIndex = st.i;
  const m = NUMBER_RE.exec(st.text);
  if (!m) fail(st, st.i, 'Invalid number literal');
  const start = st.i;
  st.i += m[0].length;
  let body = m[0];
  let sign = 1;
  if (body[0] === '+' || body[0] === '-') {
    if (body[0] === '-') sign = -1;
    body = body.slice(1);
  }
  const n = Number(body);
  if (Number.isNaN(n)) fail(st, start, 'Invalid number literal ' + JSON.stringify(m[0]));
  return sign * n;
}

function parseWord(st) {
  WORD_RE.lastIndex = st.i;
  const m = WORD_RE.exec(st.text);
  if (!m) fail(st, st.i, 'Unexpected character ' + JSON.stringify(st.text[st.i]));
  const start = st.i;
  st.i += m[0].length;
  switch (m[0]) {
    case 'true': return true;
    case 'false': return false;
    case 'null': return null;
    case 'undefined': return undefined;
    case 'NaN': return NaN;
    case 'Infinity': return Infinity;
    default:
      return fail(st, start, 'Unexpected token ' + JSON.stringify(m[0]));
  }
}

module.exports = { parseSource };
