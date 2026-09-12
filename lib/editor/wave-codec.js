'use strict';

/**
 * wave-codec — a tolerant WaveJSON reader that remembers where every value came
 * from, and a write-back that changes only those bytes.
 *
 * WaveJSON is a JavaScript object literal, not strict JSON. Real wavedrom code
 * blocks use unquoted keys, single-quoted strings, trailing commas and line or
 * block comments; `JSON.parse` rejects all four. So this is a small
 * recursive-descent parser instead.
 *
 * It also records, for every value it parses, the half-open source range
 * `[start, end)` of that value's literal text. That is what lets `patchSource`
 * rewrite only the bytes of the one value that changed, leaving the author's
 * indentation, quote characters and comments untouched. Nothing is normalised
 * on the way in: `0..0` and `0...` render differently in wavedrom, so a parser
 * that "tidied" a wave string would be destroying information.
 *
 * Alongside those it records a second table, `members`, holding the range of
 * each whole member — key, colon, value and trailing comma. Value spans alone
 * are enough to change a lane's wave string, and adding a cycle is only that:
 * each lane's wave string gets rewritten and nothing else moves. Adding or
 * deleting a *lane* is the one genuinely structural thing a wave GUI does, and
 * member spans turn it into a local splice too, so it does not have to fall
 * back on rewriting the file.
 *
 * Security: the source text comes out of the user's markdown file, so it is
 * never handed to any code-executing API. This module builds no code at run
 * time and imports nothing at all; `test/wave-codec.test.js` greps it for the
 * spellings that would introduce either, so keep the prose here clear of them.
 *
 * Contract: this does not throw on any input. Every malformed source —
 * including one nested past `MAX_DEPTH` — comes back as
 * `{ok: false, message, offset}`, so callers in the layers above are entitled
 * to call it without a `try`.
 *
 * "On any input" is the honest form of that promise, not "never": if the
 * CALLER arrives with its stack already at the limit, the engine can raise
 * RangeError in a frame where the catch handler itself has no stack left to
 * run. Measured under `--stack-size=200`. Nothing in this file can close that,
 * and the input is not what decides it.
 *
 * @typedef {Array<string|number>} DocPath
 *   Object keys are strings, array indices are numbers — `['signal', 0, 'wave']`.
 *   `spans` is keyed by `JSON.stringify(path)`, so index types must match:
 *   `['signal','0','wave']` is a different key and is never produced here.
 */

/**
 * Every character ECMAScript counts as WhiteSpace or a LineTerminator. The
 * exotic ones matter: a wavedrom block pasted out of a rendered web page
 * carries U+00A0, and one pasted out of a CJK document carries U+3000. JS
 * itself treats both as whitespace, so this parser does too — otherwise a lane
 * ends up with the key `'name '`, the GUI shows no name, and the rename
 * the user then types has no span to write through.
 */
const SPACE = {};
for (const c of ' \t\n\r\f\v        ' +
                '         　﻿') {
  SPACE[c] = 1;
}

/**
 * U+200B is neither JS whitespace nor a valid identifier character, and it is
 * the other invisible that survives a web paste. Excluding it here turns it
 * into a reported error rather than a silently wrong key.
 */
const ZERO_WIDTH_SPACE = '​';

/**
 * Nesting ceiling. The deepest legitimate WaveJSON is about ten containers —
 * root, `signal`, a few nested groups, a lane, its `data`, an element — so 64
 * leaves roughly six times the headroom any real document needs, while sitting
 * ~49x below the depth at which this host's stack actually gives out (measured:
 * 3124 levels parse, 3125 throws). Choosing a fixed ceiling rather than
 * catching the stack overflow is what makes the failure deterministic: it does
 * not move with `--stack-size` or with how deep the caller's own stack already
 * was, and it can report a real `offset`.
 */
const MAX_DEPTH = 64;

const NUMBER_RE = /[+-]?(?:0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|Infinity|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/y;
const IDENT_START_RE = /[A-Za-z_$-￿]/;
const IDENT_PART_RE = /[A-Za-z0-9_$-￿]/;

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
  const st = { text: text, i: 0, depth: 0, spans: new Map(), members: new Map(), dups: new Set() };
  try {
    skipTrivia(st);
    if (st.i >= text.length) fail(st, st.i, 'Empty source: expected a WaveJSON value');
    const doc = parseValue(st, []);
    skipTrivia(st);
    if (st.i < text.length) {
      fail(st, st.i, 'Unexpected trailing content after the top-level value');
    }
    // `source` is what lets `patchSource` refuse a stale parse result. Spans are
    // offsets into one particular string; applied to a text that has moved on,
    // they land mid-token and write a file that no longer parses. Holding the
    // string costs nothing — strings are immutable, so this is the same one the
    // caller already has, not a copy.
    return {
      ok: true, doc: doc, spans: st.spans, members: st.members, dups: st.dups, source: text,
    };
  } catch (err) {
    if (err && err.isWaveParseError) {
      return { ok: false, message: err.message, offset: err.offset };
    }
    if (err instanceof RangeError) {
      // MAX_DEPTH normally gets here first, so this looks unreachable and was
      // reported as unproven when it was written. It is not: a review reached
      // it under `--stack-size=200` from 12 of 13 sampled caller depths, and
      // again at 500. The earlier negative result came from probing at the
      // default stack size, where V8 re-tiers the calibrating harness between
      // calibration and test. This branch is what holds the no-`try` contract
      // when a caller arrives on a deep stack — which a GUI event path does.
      return { ok: false, message: 'Source is too deeply nested to parse', offset: st.i };
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
  if (c === '{' || c === '[') {
    if (st.depth >= MAX_DEPTH) {
      fail(st, start, 'Nesting is too deep: more than ' + MAX_DEPTH +
        ' levels of nested objects and arrays');
    }
    st.depth++;
    value = c === '{' ? parseObject(st, path) : parseArray(st, path);
    st.depth--;
  } else if (c === '"' || c === "'") value = parseString(st);
  else if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) value = parseNumber(st);
  else value = parseWord(st);
  st.spans.set(JSON.stringify(path), [start, st.i]);
  return value;
}

/**
 * Record the span of a whole member — the key, the colon, the value and the
 * trailing comma if one is there.
 *
 * This is recorded here, while the cursor is walking the member, rather than by
 * a later scan over the source. A scan cannot do it: looking forward from a
 * value's end for the separator finds the comma written inside a block comment,
 * and looking backward from a value for its key has to walk past a line comment
 * that is allowed to contain a colon of its own. Both are already handled here
 * for free, because `skipTrivia` has been over that text.
 *
 * The range starts at the first character of the key (for an array, of the
 * element), so leading indentation and any comment sitting above the member are
 * outside it. It ends after the comma, so the trivia between the value and that
 * comma — including a comment written there — is inside it. Without a trailing
 * comma it ends at the last character of the value, and the trailing comment on
 * the same line stays outside.
 */
function recordMember(st, memberKey, start, end) {
  st.members.set(memberKey, [start, end]);
}

function parseObject(st, path) {
  const obj = {};
  const seen = new Set();
  st.i++; // consume the opening brace
  for (;;) {
    skipTrivia(st);
    const c = st.text[st.i];
    if (c === undefined) fail(st, st.i, 'Unterminated object: expected a closing brace');
    if (c === '}') { st.i++; return obj; }
    const memberStart = st.i;
    const key = parseKey(st);
    skipTrivia(st);
    if (st.text[st.i] !== ':') {
      fail(st, st.i, "Expected ':' after key " + JSON.stringify(key));
    }
    st.i++;
    const memberKey = JSON.stringify(path.concat([key]));
    // `{a: {b: 1}, a: 2}` is legal here and the later member wins in `doc`, so
    // both the value span and the member span at ["a"] end up describing the
    // second one while the span at ["a","b"] still describes text inside the
    // first. Writing a value through a span stays correct; splicing a member
    // out does not, so the paths involved are remembered and refused there.
    if (seen.has(memberKey)) st.dups.add(memberKey);
    else seen.add(memberKey);
    const value = parseValue(st, path.concat([key]));
    assign(obj, key, value);
    const valueEnd = st.i;
    skipTrivia(st);
    const sep = st.text[st.i];
    if (sep === ',') {
      st.i++;
      recordMember(st, memberKey, memberStart, st.i);
      continue;                              // a trailing comma just loops round to the brace
    }
    recordMember(st, memberKey, memberStart, valueEnd);
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
    const memberStart = st.i;
    const memberKey = JSON.stringify(path.concat([arr.length]));
    arr.push(parseValue(st, path.concat([arr.length])));
    const valueEnd = st.i;
    skipTrivia(st);
    const sep = st.text[st.i];
    if (sep === ',') {
      st.i++;
      recordMember(st, memberKey, memberStart, st.i);
      continue;                              // a trailing comma just loops round to the bracket
    }
    recordMember(st, memberKey, memberStart, valueEnd);
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
  const word = scanWord(st);
  if (word === '') {
    fail(st, st.i, 'Expected a property name but found ' + JSON.stringify(c === undefined ? '' : c));
  }
  return word;
}

/**
 * Scan a bare identifier. Stops at anything `SPACE` calls trivia, so a space
 * character can never be absorbed into a key, and at U+200B. Returns '' (with
 * the position unmoved) when there is no identifier here.
 */
function scanWord(st) {
  const t = st.text;
  if (!isIdentChar(t[st.i], true)) return '';
  let j = st.i + 1;
  while (isIdentChar(t[j], false)) j++;
  const word = t.slice(st.i, j);
  st.i = j;
  return word;
}

function isIdentChar(c, isFirst) {
  if (c === undefined) return false;
  if (SPACE[c] === 1 || c === ZERO_WIDTH_SPACE) return false;
  return (isFirst ? IDENT_START_RE : IDENT_PART_RE).test(c);
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
  const start = st.i;
  const word = scanWord(st);
  if (word === '') fail(st, st.i, 'Unexpected character ' + JSON.stringify(st.text[st.i]));
  switch (word) {
    case 'true': return true;
    case 'false': return false;
    case 'null': return null;
    case 'undefined': return undefined;
    case 'NaN': return NaN;
    case 'Infinity': return Infinity;
    default:
      return fail(st, start, 'Unexpected token ' + JSON.stringify(word));
  }
}

/**
 * Write a set of edits back into the source as the smallest replacement that
 * expresses them.
 *
 * Every edit names a value by path; the span recorded for that path says which
 * bytes are that value, and only those bytes are rewritten. Everything else in
 * the file — the author's indentation, the comment two columns to the right of
 * the wave string, whichever quote character that one value happened to use —
 * survives because it is never read and never written. That is not tidiness:
 * against wavedrom 3.5.0 `0..0` and `0...` render as different waveforms (a
 * transition marker against a plain hold), and so do the other levels and data
 * characters, so a write-back that re-serialised or "normalised" a wave string
 * would change the picture the user is looking at.
 *
 * Three kinds of edit:
 *
 *   {path, value} or {op:'set', path, value}
 *       Replace the value at `path`. Refused when nothing is parsed at that
 *       path, or when the new value is a different kind from the old one —
 *       turning a string into an array is a structural change, not a local
 *       replacement, and this returns `{ok:false}` rather than guessing.
 *
 *   {op:'insert', path, value}
 *       Splice a new element into an array; the last path segment is the index
 *       it should end up at, and may be the array's current length to append.
 *       This is what a GUI's "add a lane" does. Adding a *cycle* is not here on
 *       purpose: it only rewrites each lane's wave string, which is an ordinary
 *       `set`.
 *
 *   {op:'remove', path}
 *       Splice out one whole member — key, colon, value and trailing comma.
 *
 * Refusals carry `rewroteRange`, which says which stretch of the file the edit
 * wanted, so a caller can show the user what it would have had to touch instead
 * of failing silently or rewriting the file behind them.
 *
 * @param {string} text            the same source that was handed to parseSource
 * @param {object} parsed          a successful parseSource result
 * @param {Array<object>} edits
 * @returns {{ok: true, text: string}
 *          |{ok: false, reason: string, rewroteRange: object|null}}
 */
function patchSource(text, parsed, edits) {
  if (typeof text !== 'string') {
    return refuse('patchSource expects the source text as a string', null);
  }
  if (!parsed || parsed.ok !== true || !(parsed.spans instanceof Map) ||
      !(parsed.members instanceof Map) || !(parsed.dups instanceof Set)) {
    return refuse('patchSource needs a successful parseSource result from this same module', null);
  }
  if (parsed.source !== text) {
    // Two patches in a row without re-parsing in between is the shape a GUI
    // reaches for, and it is the one input on which silence would be worst:
    // every span past the first edit is off by however much that edit changed
    // the length, so the write lands mid-token and the user's diagram stops
    // parsing. Refusing is the only honest answer — the spans cannot be
    // adjusted from here, because this has no idea which edits produced `text`.
    return refuse(
      'this parse result came from a different source text; re-run parseSource on ' +
        'the text being patched, because spans from the old one point at the wrong bytes',
      null);
  }
  if (!Array.isArray(edits)) return refuse('patchSource expects an array of edits', null);
  if (edits.length === 0) return { ok: true, text: text };

  const ctx = { text: text, parsed: parsed };
  // Two edits naming one path have no defined result: for a value they would
  // fight over the same bytes, and for two inserts at one index the order they
  // land in is whatever the sort happens to do with two ranges that are both
  // empty at the same offset. The overlap test below catches the first because
  // the ranges genuinely overlap, and cannot catch the second because an empty
  // range does not overlap itself — so both are refused here instead, and the
  // module says the same thing about a repeated path whatever the op was.
  const seenPaths = new Set();
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object' || !Array.isArray(edit.path)) continue;
    const key = JSON.stringify(edit.path);
    if (seenPaths.has(key)) {
      return refuse(
        'the same path ' + key + ' appears in two edits, so which one wins is not defined',
        nearestRange(ctx, edit.path));
    }
    seenPaths.add(key);
  }
  const resolved = [];
  for (const edit of edits) {
    const r = resolveEdit(ctx, edit);
    if (r.ok !== true) return r;
    if (r.skip === true) continue;      // a value-equal edit writes nothing at all
    resolved.push(r);
  }
  if (resolved.length === 0) return { ok: true, text: text };

  // Back to front, so applying one edit cannot move the spans of the ones that
  // have not been applied yet.
  resolved.sort(function (a, b) { return (b.start - a.start) || (b.end - a.end); });
  for (let k = 1; k < resolved.length; k++) {
    const later = resolved[k - 1];
    const earlier = resolved[k];
    if (earlier.end > later.start) {
      return refuse(
        'two edits cover overlapping ranges, so applying both would not be a local replacement',
        { path: earlier.path, spanPath: earlier.path, start: earlier.start, end: later.end });
    }
  }

  let out = text;
  for (const r of resolved) out = out.slice(0, r.start) + r.text + out.slice(r.end);
  return { ok: true, text: out };
}

function refuse(reason, rewroteRange) {
  return { ok: false, reason: reason, rewroteRange: rewroteRange };
}

/** Turn one edit into a `{start, end, text}` replacement, or refuse. */
function resolveEdit(ctx, edit) {
  if (!edit || typeof edit !== 'object') return refuse('each edit must be an object', null);
  if (!Array.isArray(edit.path)) {
    return refuse('each edit needs a path array, the same shape parseSource keys its spans by', null);
  }
  const op = edit.op === undefined ? 'set' : edit.op;
  if (op === 'set') return resolveSet(ctx, edit);
  if (op === 'insert') return resolveInsert(ctx, edit);
  if (op === 'remove') return resolveRemove(ctx, edit);
  return refuse('unknown edit op ' + JSON.stringify(edit.op), nearestRange(ctx, edit.path));
}

function resolveSet(ctx, edit) {
  const path = edit.path;
  const span = ctx.parsed.spans.get(JSON.stringify(path));
  if (!span) {
    return refuse(
      'nothing is parsed at ' + JSON.stringify(path) +
        ', so this is a structural change rather than a local replacement',
      nearestRange(ctx, path));
  }
  const found = lookup(ctx.parsed.doc, path);
  const oldKind = found.found ? kindOf(found.value) : 'missing';
  const newKind = kindOf(edit.value);
  if (newKind === 'undefined') {
    return refuse('a patch will not write undefined into the source',
      rangeOf(path, path, span));
  }
  if (oldKind !== newKind) {
    return refuse(
      'the new value is a ' + newKind + ' where the source has a ' + oldKind +
        '; changing a value type is a structural change, not a local replacement',
      rangeOf(path, path, span));
  }
  if (newKind === 'object' || newKind === 'array') {
    // A container `set` is a structural rewrite wearing a value replacement's
    // clothes: its span covers the whole subtree, so writing it re-spells every
    // member and drops every comment inside — the one thing this module exists
    // to prevent. Change the fields, or splice with insert and remove.
    return refuse(
      'setting a whole ' + newKind + ' at ' + JSON.stringify(path) + ' would re-serialise ' +
        'that subtree and drop any comment or formatting inside it; set the fields ' +
        'individually, or use insert and remove',
      rangeOf(path, path, span));
  }
  if (sameScalar(found.value, edit.value)) {
    // Nothing changed, so nothing is written. Without this, a save that touches
    // every field would re-spell literals it has no business touching: the
    // author's `0xff` would come back as `255` because a number is rendered
    // from its value and not from the text it was written as.
    return { ok: true, skip: true, path: path };
  }
  const quote = ctx.text[span[0]] === "'" ? "'" : '"';
  const ser = serialize(edit.value, quote, MAX_DEPTH - path.length);
  if (ser.ok !== true) return refuse(ser.why, rangeOf(path, path, span));
  return { ok: true, path: path, start: span[0], end: span[1], text: ser.text };
}

function resolveInsert(ctx, edit) {
  const path = edit.path;
  if (path.length === 0 || typeof path[path.length - 1] !== 'number') {
    return refuse('insert addresses an array element, so its path must end in a numeric index',
      nearestRange(ctx, path));
  }
  const index = path[path.length - 1];
  const parentPath = path.slice(0, -1);
  const parentSpan = ctx.parsed.spans.get(JSON.stringify(parentPath));
  const parent = lookup(ctx.parsed.doc, parentPath);
  if (!parentSpan || !parent.found || !Array.isArray(parent.value)) {
    return refuse('insert needs an array at ' + JSON.stringify(parentPath),
      nearestRange(ctx, parentPath));
  }
  if (index !== Math.floor(index) || !(index >= 0 && index <= parent.value.length)) {
    return refuse(
      'insert index ' + index + ' is outside the array at ' + JSON.stringify(parentPath) +
        ', which holds ' + parent.value.length + ' elements',
      rangeOf(path, parentPath, parentSpan));
  }
  if (touchesDuplicateKey(ctx, path)) {
    return refuse(duplicateWhy(path), rangeOf(path, parentPath, parentSpan));
  }
  const ser = serialize(edit.value, '"', MAX_DEPTH - path.length);
  if (ser.ok !== true) return refuse(ser.why, rangeOf(path, parentPath, parentSpan));

  if (parent.value.length === 0) {
    const at = parentSpan[0] + 1;
    // An empty array has no element to copy a layout from. If it was written
    // across lines, the new element takes a line of its own, indented one step
    // in from the closing bracket; two spaces because there is nothing in the
    // file to measure a step from. A one-line array stays on its line.
    const close = lineIndentBefore(ctx.text, parentSpan[1] - 1);
    if (close !== null) {
      const eol = lineBreakBefore(ctx.text, parentSpan[1] - 1);
      return { ok: true, path: path, start: at, end: at, text: eol + close + '  ' + ser.text };
    }
    return { ok: true, path: path, start: at, end: at, text: ser.text };
  }
  if (index < parent.value.length) {
    const member = ctx.parsed.members.get(JSON.stringify(parentPath.concat([index])));
    if (!member) {
      return refuse('no member span for ' + JSON.stringify(path), rangeOf(path, parentPath, parentSpan));
    }
    // Go in above whatever comment lines are written over that member, not
    // between them and it — otherwise the new lane silently inherits the note
    // the author wrote about the old one. Same rule the end of the array uses.
    const at = commentBlockStart(ctx.text, member[0]);
    const indent = lineIndentBefore(ctx.text, at);
    const gap = indent === null ? ' ' : lineBreakBefore(ctx.text, at) + indent;
    return { ok: true, path: path, start: at, end: at, text: ser.text + ',' + gap };
  }
  const last = ctx.parsed.members.get(JSON.stringify(parentPath.concat([index - 1])));
  if (!last) {
    return refuse('no member span for ' + JSON.stringify(parentPath.concat([index - 1])),
      rangeOf(path, parentPath, parentSpan));
  }
  const indent = lineIndentBefore(ctx.text, last[0]);
  const gap = indent === null ? ' ' : lineBreakBefore(ctx.text, last[0]) + indent;
  const comma = ctx.text[last[1] - 1] === ',' ? '' : ',';
  // The new element goes after whatever the last one has left on its own line,
  // so a comment written beside that lane keeps describing that lane instead of
  // drifting onto the new one. When the last element had no trailing comma the
  // comma has to go in front of that trivia rather than after it — a comma
  // appended after a line comment would be swallowed by the comment and the
  // array would no longer parse — so the trivia is re-emitted, byte for byte,
  // behind it.
  const at = endOfTrailingTrivia(ctx.text, last[1], true);
  const kept = ctx.text.slice(last[1], at);
  return { ok: true, path: path, start: last[1], end: at, text: comma + kept + gap + ser.text };
}

function resolveRemove(ctx, edit) {
  const path = edit.path;
  if (path.length === 0) {
    return refuse('the whole document is not a member that can be removed', nearestRange(ctx, path));
  }
  const member = ctx.parsed.members.get(JSON.stringify(path));
  if (!member) {
    return refuse('nothing is parsed at ' + JSON.stringify(path) + ', so there is no member to remove',
      nearestRange(ctx, path));
  }
  if (touchesDuplicateKey(ctx, path)) {
    return refuse(duplicateWhy(path), rangeOf(path, path, member));
  }
  const range = removalRange(ctx.text, member[0], member[1]);
  return { ok: true, path: path, start: range[0], end: range[1], text: '' };
}

/**
 * A key written twice in the same object is legal WaveJSON and the later one
 * wins, which leaves the earlier one's subtree still holding spans that the doc
 * says nothing about: `{a: {b: 1}, a: 2}` has a span at ["a","b"] while `doc.a`
 * is `2`. Writing a value through a span is still right, because the span at a
 * path and the value at that path were recorded by the same pass and describe
 * the same occurrence. Splicing a member out is not: the member span at ["a"]
 * describes only the second one, so removing it would leave the first behind
 * and the key would still be there. So a member-level edit refuses as soon as
 * the path, or any path above it, is one of the repeated keys.
 */
function touchesDuplicateKey(ctx, path) {
  for (let n = 1; n <= path.length; n++) {
    if (ctx.parsed.dups.has(JSON.stringify(path.slice(0, n)))) return true;
  }
  return false;
}

function duplicateWhy(path) {
  return JSON.stringify(path) + ' sits under a duplicate key, where a member span ' +
    'describes only one of the occurrences, so splicing there would leave the other behind';
}

/**
 * The horizontal whitespace between the start of `at`'s line and `at`, or null
 * when something other than whitespace is in front of it on that line. An
 * inserted element copies this so it lands on its own line, indented like its
 * neighbour, without any existing byte being rewritten.
 */
function lineIndentBefore(text, at) {
  let s = at;
  while (s > 0 && (text[s - 1] === ' ' || text[s - 1] === '\t')) s--;
  if (s > 0 && text[s - 1] !== '\n') return null;
  return text.slice(s, at);
}

/**
 * The line terminator that ended the line before `at` — the one an inserted
 * line has to match. Writing a bare newline into a file the author keeps in
 * CRLF leaves it with mixed endings, which is the same kind of harm as
 * reindenting it: a change to bytes nobody asked to change.
 */
function lineBreakBefore(text, at) {
  let s = at;
  while (s > 0 && (text[s - 1] === ' ' || text[s - 1] === '\t')) s--;
  if (s >= 2 && text[s - 1] === '\n' && text[s - 2] === '\r') return '\r\n';
  return '\n';
}

/**
 * Where the run of comment lines written directly above `at` begins, or `at`
 * when there is none.
 *
 * A comment on the line above a lane is that lane's, the way a trailing comment
 * on its own line is. That decides two operations at once, and they have to
 * agree: an insert goes in above the run, so the note keeps describing the lane
 * it was written for, and a remove takes the run with it, so the note does not
 * outlive its subject and end up reading as a description of the next lane.
 *
 * A blank line ends the run, which is what separates a lane's own note from a
 * heading written about the array. It is still a guess at the author's intent
 * for the first lane of a container — a heading written immediately above it,
 * with no blank line, travels with that lane when it is deleted. The
 * alternative guess leaves the heading silently describing something else, and
 * between the two, this one is at least the same rule the insert side uses.
 */
function commentBlockStart(text, at) {
  let s = at;
  while (s > 0 && (text[s - 1] === ' ' || text[s - 1] === '\t')) s--;
  if (s > 0 && text[s - 1] !== '\n') return at;     // code in front of it on this line
  let head = at;
  for (;;) {
    if (s === 0) return head;
    let contentEnd = s - 1;                          // the line break above
    if (text[contentEnd] !== '\n') return head;
    if (contentEnd > 0 && text[contentEnd - 1] === '\r') contentEnd--;
    let lineStart = contentEnd;
    while (lineStart > 0 && text[lineStart - 1] !== '\n') lineStart--;
    const content = commentOnlyLineStart(text, lineStart, contentEnd);
    if (content === null) return head;
    head = content;
    s = lineStart;
  }
}

/**
 * Where the comment starts on a line that holds nothing but one, or null when
 * the line holds anything else — code, or nothing at all. A blank line is not a
 * comment line, so it ends a run rather than being absorbed into it.
 */
function commentOnlyLineStart(text, from, to) {
  let j = from;
  while (j < to && (text[j] === ' ' || text[j] === '\t')) j++;
  if (j >= to) return null;
  const start = j;
  if (text[j] === '/' && text[j + 1] === '/') return start;
  if (text[j] === '/' && text[j + 1] === '*') {
    const close = text.indexOf('*/', j + 2);
    if (close === -1 || close + 2 > to) return null;
    j = close + 2;
    while (j < to && (text[j] === ' ' || text[j] === '\t')) j++;
    return j >= to ? start : null;
  }
  return null;
}

/**
 * How much of a removal is the member's own line rather than the member itself,
 * and what to take with it.
 *
 * A member that had its line to itself takes the whole line: its indentation,
 * the comment written after it on that line, the comment lines written above
 * it, and the line break. Leaving any of that behind is what orphans a note
 * against the wrong lane, with the deleted lane's indentation fused onto it.
 *
 * A member sharing its line with others takes only itself plus the horizontal
 * whitespace that followed it, so a one-line array closes up instead of keeping
 * the gap where the element used to be.
 */
function removalRange(text, start, end) {
  const withComment = endOfTrailingTrivia(text, end, false);
  const e = withComment > end ? withComment : end;
  const s = commentBlockStart(text, start);

  let head = s;
  while (head > 0 && (text[head - 1] === ' ' || text[head - 1] === '\t')) head--;
  const ownsTheLine = head === 0 || text[head - 1] === '\n';

  let tail = e;
  while (tail < text.length && (text[tail] === ' ' || text[tail] === '\t')) tail++;
  if (ownsTheLine && (text[tail] === '\n' || text[tail] === '\r')) {
    if (text[tail] === '\r') tail++;
    if (text[tail] === '\n') tail++;
    return [head, tail];
  }
  return [s, tail];
}

/** True when `text[from..to)` holds any character the language ends a line at. */
function hasLineBreakBetween(text, from, to) {
  for (let j = from; j < to; j++) {
    if (isFormatBreak(text[j]) || text[j] === '\n' || text[j] === '\r') return true;
  }
  return false;
}

/**
 * DEL, and the two separators the language counts as line terminators inside a
 * string. They are written as code points rather than as themselves so that
 * nothing invisible sits in this file.
 */
/**
 * An unpaired surrogate. `quoteString` iterates by code point, so a character
 * still in the surrogate range here is one that has no partner: writing it out
 * as itself survives an in-memory round trip but not the trip through UTF-8
 * that saving the file is, so it is escaped like the other characters that
 * cannot be written literally.
 */
function isLoneSurrogate(ch) {
  const code = ch.charCodeAt(0);
  return code >= 0xd800 && code <= 0xdfff && ch.length === 1;
}

function isFormatBreak(ch) {
  if (ch === undefined) return false;
  const code = ch.charCodeAt(0);
  return code === 0x7f || code === 0x2028 || code === 0x2029;
}

/**
 * Walk forward from `from` over the trivia that belongs to whatever just ended —
 * horizontal whitespace and comments — and answer where the line break is.
 * Anything else, such as the closing bracket of a one-line array, answers
 * `from`, so nothing is assumed about text this has not accounted for.
 *
 * `acrossLines` says whether a block comment may carry the scan onto later
 * lines. An insert wants that: a two-line comment written after the last
 * element describes that element, and landing in front of it would hand it to
 * the new one. A remove does not — taking a comment that big along with the
 * member is far more than the edit asked for.
 */
function endOfTrailingTrivia(text, from, acrossLines) {
  let j = from;
  for (;;) {
    const c = text[j];
    if (c === ' ' || c === '\t') { j++; continue; }
    if (c === '\n' || c === '\r') return j;
    if (c === '/' && text[j + 1] === '/') {
      while (j < text.length && text[j] !== '\n' && text[j] !== '\r') j++;
      return j;
    }
    if (c === '/' && text[j + 1] === '*') {
      const close = text.indexOf('*/', j + 2);
      if (close === -1) return from;
      if (!acrossLines && hasLineBreakBetween(text, j, close)) return from;
      j = close + 2;
      continue;
    }
    return from;
  }
}

/** Walk `doc` down `path`, distinguishing "absent" from "present and undefined". */
function lookup(doc, path) {
  let cur = doc;
  for (let k = 0; k < path.length; k++) {
    if (cur === null || typeof cur !== 'object') return { found: false };
    const seg = path[k];
    if (Array.isArray(cur)) {
      if (typeof seg !== 'number' || !(seg >= 0 && seg < cur.length)) return { found: false };
    } else if (typeof seg !== 'string' || !Object.prototype.hasOwnProperty.call(cur, seg)) {
      return { found: false };
    }
    cur = cur[seg];
  }
  return { found: true, value: cur };
}

/**
 * Whether two scalars are the same value for the purpose of "did this edit
 * change anything". NaN counts as equal to itself, and negative zero as equal
 * to zero — the difference has no meaning in a waveform, and treating them as
 * different would mean rewriting the author's literal to say the same thing.
 * Containers never reach this: a container set is refused before it gets here.
 */
function sameScalar(a, b) {
  if (a === b) return true;
  return Number.isNaN(a) && Number.isNaN(b);
}

function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  return t === 'object' ? 'object' : t;
}

function rangeOf(path, spanPath, span) {
  return { path: path, spanPath: spanPath, start: span[0], end: span[1] };
}

/** The range of the closest ancestor that does have a span. The root always has one. */
function nearestRange(ctx, path) {
  const p = Array.isArray(path) ? path : [];
  for (let n = p.length; n >= 0; n--) {
    const sub = p.slice(0, n);
    const span = ctx.parsed.spans.get(JSON.stringify(sub));
    if (span) return rangeOf(p, sub, span);
  }
  return null;
}

/**
 * Render a value as WaveJSON source text. `quote` is the quote character the
 * span being replaced already used, so a single-quoted value stays single
 * quoted; the other quote character is then left alone inside the string rather
 * than escaped, because it needs no escaping there.
 *
 * A value with no WaveJSON spelling — undefined, and the other host-only value
 * kinds — comes back as a refusal instead of being written out as the bare word
 * undefined, which would read back as something the editor never asked for.
 *
 * `depthLeft` is how many more containers may be opened at this point, and
 * `stack` holds the containers currently being written, which is what makes a
 * value that contains itself a refusal rather than a stack overflow. Both
 * matter because the value comes from an editor's own model, where a lane
 * pointing back at the document it belongs to is an ordinary shape; the reading
 * half of this file already decided that a fixed ceiling beats catching an
 * overflow, and it is the same ceiling, because anything written past it is
 * something this very module would refuse to read back.
 */
function serialize(value, quote, depthLeft, stack) {
  const kind = kindOf(value);
  if (kind === 'string') return { ok: true, text: quoteString(value, quote) };
  if (kind === 'number') {
    if (Number.isNaN(value)) return { ok: true, text: 'NaN' };
    if (value === Infinity) return { ok: true, text: 'Infinity' };
    if (value === -Infinity) return { ok: true, text: '-Infinity' };
    return { ok: true, text: String(value) };
  }
  if (kind === 'boolean') return { ok: true, text: String(value) };
  if (kind === 'null') return { ok: true, text: 'null' };
  if (kind === 'array' || kind === 'object') {
    const seen = stack === undefined ? [] : stack;
    if (seen.indexOf(value) !== -1) {
      return { ok: false, why: 'the value contains a cycle — it holds itself, ' +
        'which has no WaveJSON spelling, so nothing was written' };
    }
    if (!(depthLeft >= 1)) {
      return { ok: false, why: 'the value nests deeper here than ' + MAX_DEPTH +
        ' levels, which is the depth this module will read back, so nothing was written' };
    }
    seen.push(value);
    let out;
    if (kind === 'array') {
      const parts = [];
      for (const item of value) {
        const ser = serialize(item, quote, depthLeft - 1, seen);
        if (ser.ok !== true) { seen.pop(); return ser; }
        parts.push(ser.text);
      }
      out = '[' + parts.join(', ') + ']';
    } else {
      const parts = [];
      for (const key of Object.keys(value)) {
        const ser = serialize(value[key], quote, depthLeft - 1, seen);
        if (ser.ok !== true) { seen.pop(); return ser; }
        parts.push(renderKey(key, quote) + ': ' + ser.text);
      }
      out = parts.length === 0 ? '{}' : '{ ' + parts.join(', ') + ' }';
    }
    seen.pop();
    return { ok: true, text: out };
  }
  return { ok: false, why: 'a value of kind ' + kind + ' has no WaveJSON spelling, so nothing was written' };
}

const BARE_KEY_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function renderKey(key, quote) {
  return BARE_KEY_RE.test(key) ? key : quoteString(key, quote);
}

function quoteString(s, quote) {
  let out = quote;
  for (const ch of s) {
    if (ch === quote || ch === '\\') { out += '\\' + ch; continue; }
    if (ch === '\n') { out += '\\n'; continue; }
    if (ch === '\r') { out += '\\r'; continue; }
    if (ch === '\t') { out += '\\t'; continue; }
    if (ch === '\b') { out += '\\b'; continue; }
    if (ch === '\f') { out += '\\f'; continue; }
    if (ch < ' ' || isFormatBreak(ch) || isLoneSurrogate(ch)) {
      out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
      continue;
    }
    out += ch;
  }
  return out + quote;
}

module.exports = { parseSource, patchSource };
