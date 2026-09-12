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
  const st = {
    text: text, i: 0, depth: 0,
    spans: new Map(), members: new Map(), leads: new Map(), dups: new Set(),
  };
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
      ok: true,
      doc: doc,
      spans: st.spans,
      members: st.members,
      leads: st.leads,
      dups: st.dups,
      source: text,
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
function recordMember(st, memberKey, start, end, lead) {
  st.members.set(memberKey, [start, end]);
  st.leads.set(memberKey, lead);
}

function parseObject(st, path) {
  const obj = {};
  const seen = new Set();
  st.i++; // consume the opening brace
  for (;;) {
    const lead = st.i;          // where this member's leading trivia starts
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
      recordMember(st, memberKey, memberStart, st.i, lead);
      continue;                              // a trailing comma just loops round to the brace
    }
    recordMember(st, memberKey, memberStart, valueEnd, lead);
    if (sep === '}') { st.i++; return obj; }
    if (sep === undefined) fail(st, st.i, 'Unterminated object: expected a closing brace');
    fail(st, st.i, "Expected ',' or '}' but found " + JSON.stringify(sep));
  }
}

function parseArray(st, path) {
  const arr = [];
  st.i++; // consume the opening bracket
  for (;;) {
    const lead = st.i;          // where this element's leading trivia starts
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
      recordMember(st, memberKey, memberStart, st.i, lead);
      continue;                              // a trailing comma just loops round to the bracket
    }
    recordMember(st, memberKey, memberStart, valueEnd, lead);
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
      !(parsed.members instanceof Map) || !(parsed.leads instanceof Map) ||
      !(parsed.dups instanceof Set)) {
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
    resolved.push(r);
  }

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
    // Nothing changed, so the bytes that are already there are written back
    // unexamined. Without this, a save that touches every field would re-spell
    // literals it has no business touching: the author's `0xff` would come back
    // as `255`, because a number is rendered from its value and not from the
    // text it was written as. It keeps its range rather than dropping out of
    // the batch, so whether a batch is refused as overlapping stays a question
    // about the batch's shape and not about which values happened to match.
    return {
      ok: true, path: path, start: span[0], end: span[1],
      text: ctx.text.slice(span[0], span[1]),
    };
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
    // Go in above whatever comments are written over that member, not between
    // them and it — otherwise the new lane silently inherits the note the
    // author wrote about the old one. Same rule the end of the array uses.
    const lead = ctx.parsed.leads.get(JSON.stringify(parentPath.concat([index])));
    const at = commentRunStart(ctx.text, lead === undefined ? member[0] : lead, member[0]);
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
  const lead = ctx.parsed.leads.get(JSON.stringify(path));
  const range = removalRange(ctx.text, member[0], member[1],
    lead === undefined ? member[0] : lead);
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
 * Where the run of comments that belongs to a member begins, or `memberStart`
 * when none does.
 *
 * This is the whole of the comment-ownership rule, and the rule is one
 * sentence: **a comment belongs to the member it follows on the same line, or —
 * when it stands on its own line or lines — to the member immediately below it,
 * provided no blank line comes between.** Insert and remove both read it from
 * here, which is what keeps them from disagreeing about who owns a given note:
 * an insert goes in above the run so the note keeps describing the member it
 * was written for, and a remove takes the run with it so the note does not
 * outlive its subject and start reading as a description of the next member.
 *
 * It is decided by reading `[leadStart, memberStart)` — the trivia the parser
 * walked over on its way to this member — forwards, one comment at a time.
 * Reading it backwards a line at a time is what the earlier attempt did, and it
 * could not see a block comment spanning more than one line: its closing
 * line starts with a star, not a slash, so the run ended there and the comment
 * was handed to the wrong member. Forwards, a comment of any shape is one
 * token, so there is no line shape left to get wrong.
 *
 * The one guess left is the first member of a container: a heading written
 * immediately above it, with no blank line, is taken as that member's and
 * travels with it when it is deleted. A blank line is how an author says
 * otherwise, and that is the same signal on both operations.
 */
function commentRunStart(text, leadStart, memberStart) {
  if (!(leadStart >= 0) || leadStart > memberStart) return memberStart;
  let j = leadStart;
  let runStart = -1;
  let lastEnd = -1;
  while (j < memberStart) {
    const c = text[j];
    if (c === undefined) break;
    if (SPACE[c] === 1) { j++; continue; }
    const start = j;
    if (c === '/' && text[j + 1] === '/') {
      while (j < memberStart && text[j] !== '\n' && text[j] !== '\r') j++;
    } else if (c === '/' && text[j + 1] === '*') {
      const close = text.indexOf('*/', j + 2);
      if (close === -1 || close + 2 > memberStart) break;
      j = close + 2;
    } else {
      break;                       // not trivia; the parser says this cannot happen
    }
    if (lineBreaksBetween(text, leadStart, start) === 0) {
      // It starts on the line the previous member (or the opening delimiter)
      // ended on, so it follows that and not this one.
      lastEnd = j;
      continue;
    }
    if (runStart === -1 || lineBreaksBetween(text, lastEnd, start) >= 2) runStart = start;
    lastEnd = j;
  }
  if (runStart === -1) return memberStart;
  // Exactly one line break between the run and the member: no blank line, and
  // the run is not sitting on the member's own line in front of it.
  return lineBreaksBetween(text, lastEnd, memberStart) === 1 ? runStart : memberStart;
}

/** How many lines `text[from..to)` ends, counting CRLF once. Stops counting at 2. */
function lineBreaksBetween(text, from, to) {
  let n = 0;
  for (let j = from; j < to && n < 2; j++) {
    const c = text[j];
    if (c === '\r') {
      n++;
      if (text[j + 1] === '\n') j++;
    } else if (c === '\n') {
      n++;
    } else {
      const code = c.charCodeAt(0);
      if (code === 0x2028 || code === 0x2029) n++;   // the other two line terminators
    }
  }
  return n;
}

/**
 * How much of a removal is the member's own line rather than the member itself,
 * and what to take with it.
 *
 * A member that had its line to itself takes the whole line: its indentation,
 * the comment that follows it on that line, the comments written above it, and
 * the line break. Leaving any of that behind is what orphans a note against the
 * wrong lane, with the deleted lane's indentation fused onto it. A comment
 * that follows the member on its line but runs on past it goes too — it is
 * that member's by the same sentence `commentRunStart` states, and the insert
 * side already treats it that way, so the two would otherwise disagree about
 * who owns it.
 *
 * A member sharing its line with others takes only itself plus the horizontal
 * whitespace that followed it, so a one-line array closes up instead of keeping
 * the gap where the element used to be.
 */
function removalRange(text, start, end, leadStart) {
  const withComment = endOfTrailingTrivia(text, end, true);
  const e = withComment > end ? withComment : end;
  const s = commentRunStart(text, leadStart, start);

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
function isFormatBreak(ch) {
  if (ch === undefined) return false;
  const code = ch.charCodeAt(0);
  return code === 0x7f || code === 0x2028 || code === 0x2029;
}

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

/**
 * Walk forward from `from` over the trivia that belongs to whatever just ended —
 * horizontal whitespace and comments — and answer where the line break is.
 * Anything else, such as the closing bracket of a one-line array, answers
 * `from`, so nothing is assumed about text this has not accounted for.
 *
 * `acrossLines` says whether a block comment may carry the scan onto later
 * lines. Both callers want that, for the same reason: a comment written after
 * an element describes that element however many lines it takes, so an insert
 * that landed in front of it would hand it to the new element, and a remove
 * that left it behind would hand it to the next one.
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
 * `budget` is how many containers may be opened below this point: the reading
 * half of this file stops at `MAX_DEPTH`, so a value written at a path that
 * already uses some of that may only have the rest. Anything deeper is refused
 * rather than written, because it would produce a file this very module then
 * refuses to read. A value that contains itself is refused too, caught on the
 * stack of containers currently being written rather than by running out of
 * actual stack. Both matter because the value arrives from an editor's own
 * model, where a lane pointing back at the document it belongs to is an
 * ordinary shape — and so is a Date, which is why an object that is not a plain
 * one is refused as well instead of being written out as `{}`.
 */
function serialize(value, quote, budget) {
  return writeValue(value, quote, budget, budget, []);
}

/** The recursive half of `serialize`, carrying the depth budget and the stack. */
function writeValue(value, quote, depthLeft, budget, stack) {
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
    if (kind === 'object' && !isPlainObject(value)) {
      // A Date, Map, Set, RegExp or class instance answers `Object.keys` with an
      // empty list, so writing it would emit `{}` and report success — data loss
      // wearing a successful return, which is the one outcome this module exists
      // to prevent. It has no WaveJSON spelling, so it is refused like the other
      // host-only values.
      return { ok: false, why: 'the value holds something that is not a plain object, ' +
        'which has no WaveJSON spelling of its own and would be written as an empty ' +
        'object, so nothing was written' };
    }
    if (stack.indexOf(value) !== -1) {
      return { ok: false, why: 'the value contains a cycle — it holds itself, ' +
        'which has no WaveJSON spelling, so nothing was written' };
    }
    if (!(depthLeft >= 1)) {
      return { ok: false, why: 'the value is nested too deeply: more than the ' + budget +
        ' levels left at this path (' + MAX_DEPTH + ' is all this module will read back, ' +
        'and the path itself uses ' + (MAX_DEPTH - budget) + '), so nothing was written' };
    }
    stack.push(value);
    let out;
    if (kind === 'array') {
      const parts = [];
      for (const item of value) {
        const ser = writeValue(item, quote, depthLeft - 1, budget, stack);
        if (ser.ok !== true) { stack.pop(); return ser; }
        parts.push(ser.text);
      }
      out = '[' + parts.join(', ') + ']';
    } else {
      const parts = [];
      for (const key of Object.keys(value)) {
        const ser = writeValue(value[key], quote, depthLeft - 1, budget, stack);
        if (ser.ok !== true) { stack.pop(); return ser; }
        parts.push(renderKey(key, quote) + ': ' + ser.text);
      }
      out = parts.length === 0 ? '{}' : '{ ' + parts.join(', ') + ' }';
    }
    stack.pop();
    return { ok: true, text: out };
  }
  return { ok: false, why: 'a value of kind ' + kind + ' has no WaveJSON spelling, so nothing was written' };
}

/**
 * An object literal's worth of object: one whose prototype is the ordinary one,
 * or none at all. Anything else carries its content somewhere `Object.keys`
 * cannot see it.
 */
function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
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

/**
 * The characters a wave string is made of, and what each one means for the
 * picture.
 *
 * `.` is the one that decides the shape of everything below it, and it does NOT
 * mean "the same character again". Measured against the pinned wavedrom 3.5.0,
 * over the 19 level characters `01xzpnhlud=23456789`: `ch..ch` and `ch...`
 * render the same for exactly two of them, the clocks `p` and `n`. For the
 * other 17 the doubled form puts a transition marker at that cycle where the
 * dotted form draws a plain hold — `0..0` emits `#0m0` where `0...` emits
 * `#000`, and `h..h` emits `#pclk` where `h...` emits `#111`. So a model that
 * resolved `.` down to the character it continues would be throwing away
 * something the reader can see, and `collapseWave(expandWave(w)) === w` would
 * be false for 17 characters out of 19.
 *
 * `|` is a gap drawn over whatever level is current. It carries no level of its
 * own, so a `.` behind it continues the level from in front of it — measured,
 * `0|.` draws 0 at every cycle, while `0|0` draws the transition that says the
 * level was asserted again.
 *
 * `=` and `2` through `9` are the value characters, and each one written out
 * explicitly consumes one entry of the lane's `data` list. A `.` or a `|`
 * consumes none: measured, `2.2.` with `['A','B']` labels two runs A and B,
 * while `2222` with four labels uses all four.
 */
const HELD_CHAR = '.';
const GAP_CHAR = '|';
const VALUE_CHARS = '=23456789';

function isValueChar(ch) {
  return typeof ch === 'string' && ch.length === 1 && VALUE_CHARS.indexOf(ch) !== -1;
}

/**
 * Split a wave string into one cell per cycle, losslessly.
 *
 * A cell is `{ch, held}`: `held` is true exactly where the source wrote a `.`,
 * and `ch` is the level that cycle displays — for a held cell, the level of the
 * run it continues. Nothing is normalised, so `collapseWave` puts the source
 * string back character for character. That round trip is the invariant every
 * layer above rests on, and it is only true because `held` is kept.
 *
 * A `.` with nothing in front of it has no level to continue and answers `''`.
 * wavedrom 3.5.0 draws such a lane entirely as x — measured, `..0` renders six
 * x segments and never draws the 0 at all — so `''` is the honest answer rather
 * than a guess at what the author meant.
 *
 * Iteration is by code point, so a character outside the basic plane stays one
 * cell and still round trips.
 */
function expandWave(wave) {
  const cells = [];
  if (typeof wave !== 'string') return cells;
  let level = '';
  for (const ch of wave) {
    if (ch === HELD_CHAR) {
      cells.push({ ch: level, held: true });
      continue;
    }
    cells.push({ ch: ch, held: false });
    if (ch !== GAP_CHAR) level = ch;
  }
  return cells;
}

/**
 * Put cells back together into a wave string.
 *
 * A `.` is written only where the cell says that cycle is a continuation; this
 * never introduces one on its own. A plain string is accepted as a cell and is
 * always an explicit character, so `['p','p','p','p']` comes back as `pppp` and
 * not as `p...` — collapsing repeats into dots would change the picture, for
 * the reason `HELD_CHAR` states.
 */
function collapseWave(cells) {
  if (!Array.isArray(cells)) return '';
  let out = '';
  for (const cell of cells) out += cellChar(cell);
  return out;
}

/** The single source character a cell stands for. */
function cellChar(cell) {
  if (typeof cell === 'string') return cell;
  if (cell === null || typeof cell !== 'object') return '';
  if (cell.held === true) return HELD_CHAR;
  return typeof cell.ch === 'string' ? cell.ch : '';
}

/**
 * What level each cycle displays — what the geometry and rendering layers ask
 * for, and the half of the model that `expandWave` deliberately does not answer
 * on its own. `.` and `|` both take the level from in front of them, and a
 * cycle with nothing in front of it answers `''`.
 *
 * Takes a wave string or an array of cells.
 */
function levelsOf(wave) {
  const cells = typeof wave === 'string' ? expandWave(wave) : wave;
  const out = [];
  if (!Array.isArray(cells)) return out;
  let level = '';
  for (const cell of cells) {
    const ch = cellChar(cell);
    if (ch !== HELD_CHAR && ch !== GAP_CHAR && ch !== '') level = ch;
    out.push(level);
  }
  return out;
}
/**
 * Read one lane into the shape the cycle operations work on: a cell per cycle,
 * each explicit value cell carrying the `data` label it consumes.
 *
 * Folding the labels into the cells is what lets inserting, deleting and
 * pasting cycles keep them lined up without a second bookkeeping pass — the
 * label travels with the cell that owns it. `spare` holds any labels the wave
 * never reaches; wavedrom ignores those, so they are handed back untouched
 * rather than dropped.
 */
function readLane(lane) {
  const cells = expandWave(typeof lane.wave === 'string' ? lane.wave : '');
  const raw = lane.data;
  const asText = typeof raw === 'string';
  let labels = null;
  if (Array.isArray(raw)) labels = raw;
  else if (asText) labels = raw.trim() === '' ? [] : raw.trim().split(/\s+/);
  let slot = 0;
  const rich = [];
  for (const cell of cells) {
    const out = { ch: cell.ch, held: cell.held, label: undefined };
    if (!cell.held && isValueChar(cell.ch)) {
      if (labels !== null) out.label = labels[slot];
      slot++;
    }
    rich.push(out);
  }
  return {
    cells: rich,
    hasLabels: labels !== null,
    asText: asText,
    spare: labels === null ? [] : labels.slice(slot),
  };
}

/**
 * Write a lane model back out as a new lane object, sharing no array or object
 * with the old one. A lane whose `data` was written as a space-separated string
 * gets a string back: wavedrom 3.5.0 reads both spellings, so rewriting one as
 * the other would be a change to bytes nobody asked to change.
 */
function writeLane(lane, model) {
  const next = copyObject(lane);
  next.wave = collapseWave(model.cells);
  if (model.hasLabels) {
    const labels = [];
    for (const cell of model.cells) {
      if (!cell.held && isValueChar(cell.ch)) {
        labels.push(cell.label === undefined ? '' : cell.label);
      }
    }
    for (const left of model.spare) labels.push(left);
    next.data = model.asText ? labels.join(' ') : labels;
  }
  return next;
}

/**
 * A shallow copy that keeps key order and cannot be tricked by a `__proto__`
 * key the source file wrote: `Object.assign` would run that one through the
 * prototype setter instead of copying it, which is the same hole `assign`
 * closes on the way in.
 */
function copyObject(obj) {
  const out = {};
  if (obj === null || typeof obj !== 'object') return out;
  for (const key of Object.keys(obj)) assign(out, key, obj[key]);
  return out;
}

/** The level and the data label in force at each cycle. */
function resolveCells(cells) {
  const levels = [];
  const labels = [];
  let level = '';
  let label;
  for (const cell of cells) {
    if (!cell.held && cell.ch !== GAP_CHAR && cell.ch !== '') {
      level = cell.ch;
      label = isValueChar(cell.ch) ? cell.label : undefined;
    }
    levels.push(level);
    labels.push(label);
  }
  return { levels: levels, labels: labels };
}

/**
 * Write out the continuation that a change at `index` would otherwise re-point,
 * and answer the cells to change instead.
 *
 * Painting one cycle moves every cycle that was holding its level. On `0...`,
 * setting cycle 2 to `1` naively gives `0.1.`, and cycle 3 — which nobody
 * touched — goes from 0 to 1; measured, `0.1.` and `0.10` are different
 * pictures. So the first held cell after `index` is written out at the level it
 * was already showing, and every continuation past it is anchored again by
 * that one.
 *
 * A `|` is stepped over rather than written out. It has no level of its own to
 * pin, and a gap drawn over the old level has no spelling once the level in
 * front of it changes; that is wavedrom's shape, not this model's, and it is
 * why `0|.` repainted at cycle 0 gives `1|0` and not something that keeps the
 * gap showing 0.
 */
function anchorAfter(cells, index) {
  for (let j = index + 1; j < cells.length; j++) {
    if (cells[j].held) {
      const out = cells.slice();
      out[j] = anchoredCell(resolveCells(cells), j);
      return out;
    }
    if (cells[j].ch !== GAP_CHAR) break;
  }
  return cells;
}

/** The same, for the cell at `index` itself, so a clipping can stand on its own. */
function anchorSelf(cells, index) {
  if (!(index >= 0 && index < cells.length) || !cells[index].held) return cells;
  const out = cells.slice();
  out[index] = anchoredCell(resolveCells(cells), index);
  return out;
}

/**
 * One held cell written out at the level and label it was already showing. A
 * cell whose level is `''` becomes `x`, because x is what wavedrom draws for a
 * cycle with nothing in front of it.
 */
function anchoredCell(resolved, j) {
  const level = resolved.levels[j];
  const ch = level === '' ? 'x' : level;
  return { ch: ch, held: false, label: isValueChar(ch) ? resolved.labels[j] : undefined };
}

/**
 * Run `change` over the lane at `index` and answer a new doc — or the very same
 * doc, the identical object rather than an equal one, when nothing changed.
 *
 * That identity is how a store above can tell a no-op from an edit without
 * comparing anything, and it is what every operation here answers for an index
 * out of range, a character that is not one character, or an argument it cannot
 * read. None of them throw, which matches the promise the parsing half of this
 * file makes. Lanes that were not touched come through as the same objects, so
 * a diff against the original names one value and the patch stays minimal.
 */
function mapLane(doc, index, change) {
  const lanes = lanesOf(doc);
  if (lanes === null || !isIndex(index, lanes.length)) return doc;
  const lane = lanes[index];
  if (!isLane(lane)) return doc;
  const next = change(lane);
  if (next === null || next === lane || sameLane(lane, next)) return doc;
  const lanesNext = lanes.slice();
  lanesNext[index] = next;
  return withLanes(doc, lanesNext);
}

/** A lane is an object; a nested array in `signal` is a group and is not one. */
function isLane(lane) {
  return lane !== null && typeof lane === 'object' && !Array.isArray(lane);
}

function lanesOf(doc) {
  if (doc === null || typeof doc !== 'object') return null;
  return Array.isArray(doc.signal) ? doc.signal : null;
}

function withLanes(doc, lanes) {
  const next = copyObject(doc);
  next.signal = lanes;
  return next;
}

function isIndex(n, length) {
  return Number.isInteger(n) && n >= 0 && n < length;
}

function isBound(n, length) {
  return Number.isInteger(n) && n >= 0 && n <= length;
}

/**
 * Whether two lanes say the same thing. Only the top level is compared value by
 * value, with arrays compared element by element; anything deeper was carried
 * over by reference and so is the same object when it is unchanged.
 */
function sameLane(a, b) {
  const keys = Object.keys(b);
  if (keys.length !== Object.keys(a).length) return false;
  for (const key of keys) {
    const x = a[key];
    const y = b[key];
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) return false;
      for (let j = 0; j < x.length; j++) {
        if (x[j] !== y[j]) return false;
      }
      continue;
    }
    if (x !== y) return false;
  }
  return true;
}

/**
 * Paint one cycle of one lane.
 *
 * `ch` is a single character: a level, a value character, `|` for a gap, or `.`
 * to make the cycle continue the one in front of it. Anything else — a longer
 * string, a cycle outside the lane, a group where a lane was named — answers
 * the doc unchanged.
 *
 * A newly painted value cell keeps the label of the value cell it replaced and
 * otherwise starts blank; a cell painted with something that is not a value
 * character gives its label up, so the lane's `data` list stays exactly as long
 * as the number of value characters written out.
 */
function setCell(doc, laneIndex, cycle, ch) {
  return paint(doc, laneIndex, cycle, cycle, ch, false);
}

/**
 * Paint a range of cycles of one lane, `from` and `to` both included and in
 * either order — a drag that went right to left selects the same cycles.
 *
 * The range becomes one run: `ch` at its first cycle and continuations after
 * it. That is what a bus painted across four cycles means, and it keeps the
 * range to a single `data` entry instead of one per cycle. `.` and `|` are
 * written at every cycle instead, having no run to start.
 */
function setCellRange(doc, laneIndex, from, to, ch) {
  return paint(doc, laneIndex, from, to, ch, true);
}

function paint(doc, laneIndex, from, to, ch, asRun) {
  if (typeof ch !== 'string' || Array.from(ch).length !== 1) return doc;
  return mapLane(doc, laneIndex, function (lane) {
    const model = readLane(lane);
    const n = model.cells.length;
    let lo = from;
    let hi = to;
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
    if (lo > hi) {
      const swap = lo;
      lo = hi;
      hi = swap;
    }
    if (!isIndex(lo, n) || !isIndex(hi, n)) return null;
    const anchored = anchorAfter(model.cells, hi);
    const before = resolveCells(anchored);
    const heldLevel = lo > 0 ? before.levels[lo - 1] : '';
    const cells = anchored.slice();
    for (let j = lo; j <= hi; j++) {
      if (ch === HELD_CHAR) {
        cells[j] = { ch: heldLevel, held: true, label: undefined };
      } else if (asRun && j > lo && ch !== GAP_CHAR) {
        cells[j] = { ch: ch, held: true, label: undefined };
      } else if (isValueChar(ch)) {
        const old = anchored[j];
        const kept = !old.held && isValueChar(old.ch) ? old.label : '';
        cells[j] = { ch: ch, held: false, label: kept === undefined ? '' : kept };
      } else {
        cells[j] = { ch: ch, held: false, label: undefined };
      }
    }
    model.cells = cells;
    return writeLane(lane, model);
  });
}
/**
 * Widen every lane at the same cycle, so nothing slips out of line.
 *
 * The new cycles are continuations, which is what leaves every level on either
 * side exactly where it was. At cycle 0 there is nothing to continue, so the
 * lane's first cell is written out a second time in front of itself and the
 * rest of the new cycles continue that; a lane with no cycles at all starts
 * with `x`, which is what wavedrom draws where a lane says nothing.
 */
function insertCycles(doc, at, count) {
  return spanOp(doc, function (lane) {
    const model = readLane(lane);
    if (!Number.isInteger(count) || count < 1 || !isBound(at, model.cells.length)) return null;
    const filler = fillerCells(model.cells, at, count);
    model.cells = model.cells.slice(0, at).concat(filler, model.cells.slice(at));
    return writeLane(lane, model);
  });
}

/**
 * Narrow every lane at the same cycle.
 *
 * The first continuation after the deleted stretch is written out first, so the
 * cycle that follows the cut keeps the level it was showing instead of picking
 * up whatever now lands in front of it. Deleting cycle 0 of `0.11` therefore
 * gives `011` and not a `.11` whose first cycle has nothing to hold on to.
 */
function deleteCycles(doc, at, count) {
  return spanOp(doc, function (lane) {
    const model = readLane(lane);
    const n = model.cells.length;
    if (!Number.isInteger(count) || count < 1 || !isIndex(at, n)) return null;
    const take = Math.min(count, n - at);
    const anchored = anchorAfter(model.cells, at + take - 1);
    model.cells = anchored.slice(0, at).concat(anchored.slice(at + take));
    return writeLane(lane, model);
  });
}

/**
 * Run `change` over every lane at once and answer a new doc, or the same doc
 * when no lane changed. Groups and anything else that is not a lane pass
 * through as themselves.
 *
 * Every operation that changes how many cycles a lane has goes through here,
 * because a widening that reached only some lanes would slide the rest of the
 * picture out of line — the one failure a wave editor cannot let past.
 */
function spanOp(doc, change) {
  const lanes = lanesOf(doc);
  if (lanes === null) return doc;
  let touched = false;
  const next = [];
  for (const lane of lanes) {
    if (!isLane(lane)) {
      next.push(lane);
      continue;
    }
    const out = change(lane);
    if (out === null || sameLane(lane, out)) {
      next.push(lane);
      continue;
    }
    touched = true;
    next.push(out);
  }
  return touched ? withLanes(doc, next) : doc;
}

/**
 * The cells a widening puts in at `at`: continuations of the level in front of
 * them, or — at cycle 0, where there is no such level — a second copy of the
 * lane's first cell followed by continuations of that.
 */
function fillerCells(cells, at, count) {
  const out = [];
  if (at > 0) {
    const level = resolveCells(cells).levels[at - 1];
    for (let k = 0; k < count; k++) out.push({ ch: level, held: true, label: undefined });
    return out;
  }
  const head = cells.length > 0 ? cells[0] : null;
  out.push(head === null
    ? { ch: 'x', held: false, label: undefined }
    : { ch: head.ch, held: head.held, label: head.label });
  const level = levelsOf(out)[0];
  for (let k = 1; k < count; k++) out.push({ ch: level, held: true, label: undefined });
  return out;
}
/**
 * Lift a stretch of cycles off every lane.
 *
 * The clipping's first cycle is written out rather than left as a continuation,
 * so it carries its own level and can be pasted anywhere without picking up
 * whatever happens to sit in front of it there. `data` holds the labels of the
 * value characters inside the stretch, in order, the same way a lane does.
 */
function copyCycles(doc, at, count) {
  const lanes = lanesOf(doc);
  if (lanes === null || !Number.isInteger(at) || at < 0 ||
      !Number.isInteger(count) || count < 1) {
    return { kind: 'cycles', count: 0, lanes: [] };
  }
  const out = [];
  for (const lane of lanes) {
    if (!isLane(lane)) {
      out.push({ chars: [], data: [] });
      continue;
    }
    const model = readLane(lane);
    const cells = anchorSelf(model.cells, at).slice(at, at + count);
    const chars = [];
    const data = [];
    for (const cell of cells) {
      chars.push({ ch: cell.ch, held: cell.held });
      if (!cell.held && isValueChar(cell.ch)) {
        data.push(cell.label === undefined ? '' : cell.label);
      }
    }
    out.push({ chars: chars, data: data });
  }
  return { kind: 'cycles', count: count, lanes: out };
}

/**
 * Put a clipping back at `at`.
 *
 * `insert` widens every lane by the clipping's width, including the lanes the
 * clipping says nothing about — widening only some of them would slide the rest
 * of the picture out of line, the same reason `insertCycles` works on every
 * lane at once. `overwrite` replaces the same number of cycles and leaves a
 * lane the clipping does not reach alone, because nothing moves.
 *
 * A clipping lane whose cells do not number `count` is treated as saying
 * nothing about that lane rather than as a width to guess at.
 */
function pasteCycles(doc, at, clip, mode) {
  if (mode !== 'insert' && mode !== 'overwrite') return doc;
  if (clip === null || typeof clip !== 'object' || clip.kind !== 'cycles' ||
      !Array.isArray(clip.lanes) || !Number.isInteger(clip.count) || clip.count < 1) {
    return doc;
  }
  if (!Number.isInteger(at) || at < 0) return doc;
  let index = -1;
  return spanOp(doc, function (lane) {
    index++;
    const model = readLane(lane);
    const n = model.cells.length;
    const source = clipCells(clip.lanes[index], clip.count);
    if (mode === 'overwrite') {
      if (source === null || !isIndex(at, n)) return null;
      const anchored = anchorAfter(model.cells, at + clip.count - 1);
      model.cells = anchored.slice(0, at).concat(source, anchored.slice(at + clip.count));
      return writeLane(lane, model);
    }
    if (!isBound(at, n)) return null;
    const anchored = anchorSelf(model.cells, at);
    const block = source === null ? fillerCells(anchored, at, clip.count) : source;
    model.cells = anchored.slice(0, at).concat(block, anchored.slice(at));
    return writeLane(lane, model);
  });
}

/** One clipping lane as cells with their labels folded back in, or null when it has none. */
function clipCells(clipLane, count) {
  if (clipLane === null || typeof clipLane !== 'object' || !Array.isArray(clipLane.chars)) {
    return null;
  }
  if (clipLane.chars.length !== count) return null;
  const labels = Array.isArray(clipLane.data) ? clipLane.data : [];
  let slot = 0;
  const out = [];
  for (const cell of clipLane.chars) {
    const ch = cellChar(cell);
    const held = ch === HELD_CHAR;
    const level = held && cell !== null && typeof cell === 'object' &&
      typeof cell.ch === 'string' ? cell.ch : ch;
    const rich = { ch: held ? level : ch, held: held, label: undefined };
    if (!held && isValueChar(ch)) {
      rich.label = labels[slot];
      slot++;
    }
    out.push(rich);
  }
  return out;
}
/**
 * Put a lane into the document at `at`, as a copy — the object the caller hands
 * over stays theirs, so changing it afterwards cannot reach inside the doc.
 *
 * A lane written out this way is a plain object with its keys in the order they
 * were given, which is what the patching half of this file needs to splice it
 * in as one member rather than re-serialise the array around it.
 */
function addLane(doc, at, lane) {
  const lanes = lanesOf(doc);
  if (lanes === null || !isBound(at, lanes.length) || !isLane(lane)) return doc;
  const next = lanes.slice();
  next.splice(at, 0, copyObject(lane));
  return withLanes(doc, next);
}

/** Take the lane at `at` out. */
function removeLane(doc, at) {
  const lanes = lanesOf(doc);
  if (lanes === null || !isIndex(at, lanes.length)) return doc;
  const next = lanes.slice();
  next.splice(at, 1);
  return withLanes(doc, next);
}

/**
 * Move the lane at `from` to `to`, counted after it has been lifted out, which
 * is what a drag down the lane list does.
 *
 * Only the order of the array changes; every lane object comes through as
 * itself, so the comment each one carries in the source still belongs to the
 * same lane when the move is written back as a remove and an insert.
 */
function moveLane(doc, from, to) {
  const lanes = lanesOf(doc);
  if (lanes === null || !isIndex(from, lanes.length) ||
      !isIndex(to, lanes.length) || from === to) {
    return doc;
  }
  const next = lanes.slice();
  next.splice(to, 0, next.splice(from, 1)[0]);
  return withLanes(doc, next);
}

/** Rename the lane at `at`. A group is an array, not a lane, and is left alone. */
function renameLane(doc, at, name) {
  if (typeof name !== 'string') return doc;
  return mapLane(doc, at, function (lane) {
    const next = copyObject(lane);
    next.name = name;
    return next;
  });
}

module.exports = {
  parseSource, patchSource,
  expandWave, collapseWave, levelsOf,
  setCell, setCellRange, insertCycles, deleteCycles, copyCycles, pasteCycles,
  addLane, removeLane, moveLane, renameLane,
};
