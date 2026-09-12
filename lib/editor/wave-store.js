'use strict';

/**
 * wave-store — the WaveJSON a GUI is editing, an undo stack over it, and the
 * bridge from "what it says now" back to the smallest patch of the source text.
 *
 * The store holds three things and derives everything else from them: the
 * source text the block came from, the parse of that text (kept because its
 * spans are what a minimal patch is written through), and a stack of documents.
 * Every entry on that stack is a whole WaveJSON value, not a delta — the codec's
 * operations are pure and share every subtree they did not touch, so keeping N
 * of them costs about what keeping one of them costs, and undo is a subtraction
 * on an index rather than an inverse operation that has to be derived and can
 * be derived wrongly.
 *
 * `toPatch` does NOT replay the stack. It compares the current entry against
 * the parse of the original text and writes the difference; nothing about how
 * the user got there reaches the file. That is what makes an edit and its
 * inverse cost zero bytes instead of two edits that cancel, and it is why
 * `isDirty` can be a question about the two documents rather than about the
 * stack — see the note on it below.
 *
 * Two rules this file does not get to bend:
 *
 *   - Lane numbers are the codec's flattened display order, and the ONLY way
 *     from one to a path is `lanePath` / `lanePaths` / `laneInsertPath` /
 *     `laneRemovePath`. A path built here by hand — `['signal', k]` — names a
 *     real lane whenever a group is involved, just not the one the user
 *     pointed at, and nothing downstream refuses it.
 *   - A refusal travels upward unchanged. When the codec answers that a change
 *     cannot be written as a local patch, `toPatch` hands that `{ok:false,
 *     reason, rewroteRange}` straight back. Deciding what the user should do
 *     about it — rewrite the block, cancel, edit by hand — belongs to the
 *     layer that can ask them, and re-serialising the block behind their back
 *     is the one answer this file may never give.
 *
 * No timers, no DOM, no code built at run time: the text being edited is the
 * user's markdown. `test/wave-store.test.js` greps this file for all three.
 *
 * @typedef {Array<string|number>} DocPath  the shape the codec keys spans by
 */

const C = require('./wave-codec.js');

/**
 * The codec's own nesting ceiling, mirrored rather than imported because it is
 * not exported. Every recursive walk here stops at it, so a value a caller's
 * own operation put in the doc — where a lane holding the doc it belongs to is
 * an ordinary shape — cannot run the stack out.
 */
const MAX_DEPTH = 64;

/**
 * Open a store over one wavedrom block's source text.
 *
 * A source that cannot be read back comes back as a store that refuses rather
 * than as a throw or a null: the GUI layer above has a block on screen either
 * way, and `ok` plus a refusing `toPatch` is something it can show.
 */
function createStore(sourceText) {
  const parsed = C.parseSource(sourceText);
  if (parsed.ok !== true) return refusingStore(sourceText, parsed);

  const baseDoc = parsed.doc;
  const basePaths = C.lanePaths(baseDoc);
  const history = [{ opName: null, doc: baseDoc, origins: countUp(basePaths.length) }];
  let at = 0;

  /**
   * Run one operation and, when it changed anything, push the result.
   *
   * `fn` is handed the current doc and answers the next one. The codec answers
   * the very same object when an operation did nothing — an index out of range,
   * a brush that means nothing where it was aimed — so that identity is the
   * test for "did this happen", and an operation that did nothing does not cost
   * the user an undo press that appears to do nothing either.
   *
   * `opName` is carried on the entry and handed back by `undoName` / `redoName`.
   * This file does not coalesce by it; the editor's own burst rules live a layer
   * up, and they need the name to decide.
   */
  function apply(opName, fn) {
    if (typeof fn !== 'function') return false;
    const here = history[at];
    const next = fn(here.doc);
    if (next === here.doc || next === null || typeof next !== 'object') return false;
    const origins = remapOrigins(here.doc, next, here.origins);
    history.length = at + 1;
    history.push({ opName: opName === undefined ? null : opName, doc: next, origins: origins });
    at++;
    return true;
  }

  function undo() {
    if (at === 0) return false;
    at--;
    return true;
  }

  function redo() {
    if (at >= history.length - 1) return false;
    at++;
    return true;
  }

  /**
   * Whether the file on disk would change if it were saved now.
   *
   * This compares the two DOCUMENTS — the current one against the parse of the
   * original text — and not the stack position, and not the patched text.
   *
   * Not the stack: an edit and the edit that undoes it leave two entries behind
   * and a doc identical to the one that was opened, and a save would write the
   * same bytes back. A store that called that dirty would put a "save?" prompt
   * in front of a user who has nothing to save.
   *
   * Not the patched text: producing it means running the whole write-back,
   * which is the expensive half of this file and is entitled to REFUSE. A
   * refusal is not an answer to "has this changed" — it means the change cannot
   * be written locally, which is emphatically a change — so a caller asking
   * about dirtiness would have to interpret a refusal to get an answer, and the
   * only honest interpretation is the one the document already gives directly.
   *
   * The two agree by construction: the diff below emits an edit exactly where
   * the two docs differ, so no difference means no edit means the same bytes
   * back. `sameScalar` is the codec's own rule, which is why it is repeated
   * here rather than `Object.is`: the codec writes nothing for two values it
   * considers the same, so calling them different here would claim a change
   * that the patch would not write.
   */
  function isDirty() {
    return !sameValue(baseDoc, history[at].doc, 0);
  }

  /**
   * The smallest patch that turns the original source into what the doc says
   * now — or the codec's refusal, unchanged.
   */
  function toPatch() {
    const here = history[at];
    const plan = planEdits(baseDoc, basePaths, here.doc, here.origins);
    if (plan.ok !== true) return plan;
    return C.patchSource(sourceText, parsed, plan.edits);
  }

  const store = {
    ok: true,
    error: null,
    source: sourceText,
    apply: apply,
    undo: undo,
    redo: redo,
    canUndo: function () { return at > 0; },
    canRedo: function () { return at < history.length - 1; },
    undoName: function () { return at > 0 ? history[at].opName : null; },
    redoName: function () { return at < history.length - 1 ? history[at + 1].opName : null; },
    isDirty: isDirty,
    toPatch: toPatch,
  };
  Object.defineProperty(store, 'doc', {
    enumerable: true,
    get: function () { return history[at].doc; },
  });
  return store;
}

/** A store over a source that could not be read back: it refuses, it never throws. */
function refusingStore(sourceText, parsed) {
  const why = 'the source could not be read back as WaveJSON (' + parsed.message +
    '), so there is no document to edit and no local patch to write';
  const store = {
    ok: false,
    error: { message: parsed.message, offset: parsed.offset },
    source: sourceText,
    apply: function () { return false; },
    undo: function () { return false; },
    redo: function () { return false; },
    canUndo: function () { return false; },
    canRedo: function () { return false; },
    undoName: function () { return null; },
    redoName: function () { return null; },
    isDirty: function () { return false; },
    toPatch: function () { return refuse(why, null); },
  };
  Object.defineProperty(store, 'doc', { enumerable: true, get: function () { return null; } });
  return store;
}

function refuse(reason, rewroteRange) {
  return { ok: false, reason: reason, rewroteRange: rewroteRange };
}

const OK = { ok: true };

// ---------------------------------------------------------------------------
// Which lane is which, across an edit
// ---------------------------------------------------------------------------

/**
 * Where each lane of `afterDoc` came from in the base document, carried one
 * operation at a time rather than worked out at save time.
 *
 * It has to be carried, because after the fact the two ends are not comparable:
 * a lane whose wave string changed is a new object at the same position, and a
 * lane that moved is the same object at a new position. Asked about the end
 * state alone, a diff cannot tell "lane 1 was edited" from "lane 1 was deleted
 * and another added in its place", and the two write completely different
 * patches.
 *
 * Per operation it is decidable, because the codec's operations fall into two
 * kinds and neither is ambiguous. A content operation (`setCell`, `insertCycles`,
 * a paste) rebuilds the lanes it touches and leaves the list's length and order
 * alone. A structural one (`addLane`, `removeLane`, `moveLane`) carries every
 * lane object through untouched and changes the order. So identity answers the
 * structural ones exactly, and position answers the content ones exactly.
 *
 * The residue — lanes matched by neither — is paired up in display order, which
 * is right for a content operation and is a guess only for an operation that
 * was BOTH structural and content-bearing in one call. No codec operation is,
 * and one built by hand out of two of them should be applied as two.
 */
function remapOrigins(beforeDoc, afterDoc, beforeOrigins) {
  const before = laneObjects(beforeDoc);
  const after = laneObjects(afterDoc);
  const out = new Array(after.length).fill(-1);
  const taken = new Array(before.length).fill(false);
  const byObject = new Map();
  for (let i = 0; i < before.length; i++) {
    const seen = byObject.get(before[i]);
    if (seen === undefined) byObject.set(before[i], [i]);
    else seen.push(i);
  }
  for (let j = 0; j < after.length; j++) {
    const queue = byObject.get(after[j]);
    if (queue !== undefined && queue.length > 0) {
      const i = queue.shift();
      out[j] = i;
      taken[i] = true;
    }
  }
  const restBefore = [];
  for (let i = 0; i < before.length; i++) {
    if (!taken[i]) restBefore.push(i);
  }
  const restAfter = [];
  for (let j = 0; j < after.length; j++) {
    if (out[j] === -1) restAfter.push(j);
  }
  const pairs = Math.min(restBefore.length, restAfter.length);
  for (let k = 0; k < pairs; k++) out[restAfter[k]] = restBefore[k];
  return out.map(function (i) {
    return i === -1 ? null : beforeOrigins[i];
  });
}

/** Every lane object, in the codec's display order. */
function laneObjects(doc) {
  return C.lanePaths(doc).map(function (p) { return valueAt(doc, p); });
}

function countUp(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(i);
  return out;
}

// ---------------------------------------------------------------------------
// From two documents to a set of edits
// ---------------------------------------------------------------------------

/**
 * The edits that turn the base document into the current one.
 *
 * Two routes, and which one is taken is decided by the lane roster rather than
 * by what the caller said they were doing. When every lane is still there and
 * still in the same place, the two trees have the same shape and the whole
 * thing is one parallel walk: every differing value becomes an edit at its own
 * path, and group titles, `config`, `head` and anything else the author wrote
 * are covered for free by the same walk.
 *
 * When lanes were added, removed or reordered the shapes no longer line up, so
 * the structural half is written with the codec's five pinned recipes — which
 * address lanes through the bridge, never by a path built here — and the
 * content half is then done pairwise between lanes that survived.
 */
function planEdits(baseDoc, basePaths, doc, origins) {
  const edits = [];
  const laneAware = Array.isArray(signalOf(baseDoc)) && Array.isArray(signalOf(doc));
  const skip = laneAware ? 'signal' : null;
  const top = diffMembers([], baseDoc, doc, skip, edits, 0);
  if (top.ok !== true) return top;
  if (laneAware) {
    const same = origins.length === basePaths.length && isCountUp(origins);
    const lanes = same
      ? diffValue(['signal'], signalOf(baseDoc), signalOf(doc), edits, 1)
      : planStructural(baseDoc, basePaths, doc, origins, edits);
    if (lanes.ok !== true) return lanes;
  }
  return { ok: true, edits: edits };
}

function isCountUp(origins) {
  for (let i = 0; i < origins.length; i++) {
    if (origins[i] !== i) return false;
  }
  return true;
}

function signalOf(doc) {
  return doc === null || typeof doc !== 'object' ? null : doc.signal;
}

/**
 * The structural half: what was removed, what moved, what was added, and then
 * the fields of the lanes that came through.
 *
 * Every path here is measured against the BASE document, because that is the
 * text being patched and the spans are keyed to it. The destination of a move
 * is the lane it should end up in front of, named by the bridge, which is the
 * same counting `moveLane`'s own recipe does.
 */
function planStructural(baseDoc, basePaths, doc, origins, edits) {
  const curPaths = C.lanePaths(doc);
  const survivors = [];
  for (let j = 0; j < origins.length; j++) {
    if (origins[j] !== null) survivors.push({ cur: j, base: origins[j] });
  }

  // A group title is not a lane, so nothing above tracks one, and a structural
  // walk would carry a renamed title silently past the patch. No codec
  // operation renames one — only a hand-written operation reaches this — so
  // rather than guess which title became which, anything the current doc says
  // that the base doc did not is refused. A title that vanished is ordinary: it
  // went with the group its last lane emptied.
  const titles = titleCensus(baseDoc);
  for (const title of titlesOf(doc)) {
    const seen = titles.get(title);
    if (seen === undefined || seen === 0) {
      return refuse('a group title changed at the same time as the lane roster, and a ' +
        'title is not a lane, so which one it used to be is not recoverable; apply the ' +
        'title change and the lane change as two edits', null);
    }
    titles.set(title, seen - 1);
  }

  const kept = new Set();
  for (const s of survivors) kept.add(s.base);
  const removed = [];
  for (let i = 0; i < basePaths.length; i++) {
    if (!kept.has(i)) removed.push(i);
  }
  for (const path of removalPaths(baseDoc, basePaths, removed)) {
    edits.push({ op: 'remove', path: path });
  }

  // The lanes that survived should read in increasing base order. Whatever is
  // not part of a longest increasing run is what the user dragged.
  const order = survivors.map(function (s) { return s.base; });
  const dragged = outsideLongestRun(order);
  if (dragged.length > 1) {
    return refuse('more than one lane would have to move, and both destinations are ' +
      'measured against the same source text, so which one lands first is not defined; ' +
      'write the patch and re-read the block between the moves', null);
  }
  if (dragged.length === 1) {
    const pos = dragged[0];
    let before = null;
    for (let k = pos + 1; k < order.length; k++) {
      before = order[k];
      break;
    }
    edits.push({
      op: 'move',
      path: basePaths[order[pos]],
      to: before === null
        ? C.laneInsertPath(baseDoc, basePaths.length)
        : C.laneInsertPath(baseDoc, before),
    });
  }

  for (let j = 0; j < origins.length; j++) {
    if (origins[j] !== null) continue;
    let before = null;
    for (let k = j + 1; k < origins.length; k++) {
      if (origins[k] === null) continue;
      before = origins[k];
      break;
    }
    edits.push({
      op: 'insert',
      path: before === null
        ? C.laneInsertPath(baseDoc, basePaths.length)
        : C.laneInsertPath(baseDoc, before),
      value: valueAt(doc, curPaths[j]),
    });
  }

  for (const s of survivors) {
    const was = valueAt(baseDoc, basePaths[s.base]);
    const now = valueAt(doc, curPaths[s.cur]);
    if (was === now) continue;
    const r = diffValue(basePaths[s.base], was, now, edits, basePaths[s.base].length);
    if (r.ok !== true) return r;
  }
  return OK;
}

/**
 * Which positions of `order` are not in a longest increasing subsequence of it.
 *
 * That is the set of lanes a reorder has to pick up: leave them out and what is
 * left is already in the file's order. Quadratic, over the number of lanes in
 * one wavedrom block.
 */
function outsideLongestRun(order) {
  const n = order.length;
  if (n < 2) return [];
  const len = new Array(n).fill(1);
  const prev = new Array(n).fill(-1);
  let best = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (order[j] < order[i] && len[j] + 1 > len[i]) {
        len[i] = len[j] + 1;
        prev[i] = j;
      }
    }
    if (len[i] > len[best]) best = i;
  }
  const keep = new Set();
  for (let i = best; i !== -1; i = prev[i]) keep.add(i);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (!keep.has(i)) out.push(i);
  }
  return out;
}

/**
 * What a set of removed lanes actually takes out of the file: each lane, or the
 * group around it once that group is left holding no lane at all, however many
 * levels up that reaches.
 *
 * `laneRemovePath` answers this for ONE removal against the document as it
 * stands. A save can be several removals at once, and asking it once per lane
 * against the base document would answer "just the lane" every time — the other
 * lanes of the group are still there in that document — and leave an empty
 * group behind in the file that the user can see and can no longer address. So
 * the whole set is decided together, by the same rule: a group goes when every
 * lane under it goes, and a group the author wrote with no lanes in it is
 * content of its own and keeps its parent alive.
 */
function removalPaths(baseDoc, basePaths, removed) {
  if (removed.length === 0) return [];
  const gone = new Set();
  for (const i of removed) gone.add(JSON.stringify(basePaths[i]));
  const mark = function (arr, here, depth) {
    let hasLane = false;
    let allGone = true;
    const kids = [];
    if (depth <= MAX_DEPTH) {
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i];
        const p = here.concat([i]);
        if (Array.isArray(item)) {
          const sub = mark(item, p, depth + 1);
          kids.push(sub);
          if (sub.hasLane) hasLane = true;
          if (!sub.gone) allGone = false;
        } else if (isLane(item)) {
          hasLane = true;
          const g = gone.has(JSON.stringify(p));
          kids.push({ path: p, gone: g, kids: null, hasLane: true });
          if (!g) allGone = false;
        }
      }
    }
    return { path: here, gone: hasLane && allGone, kids: kids, hasLane: hasLane };
  };
  const out = [];
  const emit = function (node) {
    for (const kid of node.kids) {
      if (kid.gone) out.push(kid.path);
      else if (kid.kids !== null) emit(kid);
    }
  };
  emit(mark(signalOf(baseDoc), ['signal'], 0));
  return out;
}

/** Every group title in the lane tree, in order. */
function titlesOf(doc) {
  const out = [];
  const walk = function (arr, depth) {
    if (depth > MAX_DEPTH) return;
    for (const item of arr) {
      if (Array.isArray(item)) walk(item, depth + 1);
      else if (!isLane(item)) out.push(item);
    }
  };
  const lanes = signalOf(doc);
  if (Array.isArray(lanes)) walk(lanes, 0);
  return out;
}

function titleCensus(doc) {
  const out = new Map();
  for (const title of titlesOf(doc)) {
    const seen = out.get(title);
    out.set(title, seen === undefined ? 1 : seen + 1);
  }
  return out;
}

function isLane(item) {
  return item !== null && typeof item === 'object' && !Array.isArray(item);
}

// ---------------------------------------------------------------------------
// Value-level difference
// ---------------------------------------------------------------------------

/**
 * Emit the edits that turn `was` into `now` at `path`.
 *
 * Scalars that differ become a plain `set`, which is the edit that rewrites
 * exactly one literal's bytes. Arrays of the same length are walked element by
 * element for the same reason — a `data` list with a note beside each label
 * keeps those notes, which a wholesale rewrite of the list cannot.
 *
 * Where the shape itself changed — a different type, or a different number of
 * elements — there is no local replacement of a single literal to make, so it
 * asks for `replace` and lets the codec decide whether it can be said without
 * reflowing bytes nobody touched. A lane's `data` moving from the
 * space-separated string to the array form is exactly that case and is the
 * reason `replace` exists; a whole lane, or a `data` array written over several
 * lines, is refused there, and that refusal travels up.
 */
function diffValue(path, was, now, edits, depth) {
  if (was === now) return OK;
  if (depth > MAX_DEPTH) {
    return refuse('the value at ' + JSON.stringify(path) + ' is nested deeper than the ' +
      MAX_DEPTH + ' levels this module will walk, so the change was not written', null);
  }
  const wasKind = kindOf(was);
  const nowKind = kindOf(now);
  if (wasKind !== nowKind) {
    edits.push({ op: 'replace', path: path, value: now });
    return OK;
  }
  if (wasKind === 'array') {
    if (was.length !== now.length) {
      edits.push({ op: 'replace', path: path, value: now });
      return OK;
    }
    for (let i = 0; i < was.length; i++) {
      const r = diffValue(path.concat([i]), was[i], now[i], edits, depth + 1);
      if (r.ok !== true) return r;
    }
    return OK;
  }
  if (wasKind === 'object') return diffMembers(path, was, now, null, edits, depth);
  if (!sameScalar(was, now)) edits.push({ path: path, value: now });
  return OK;
}

/**
 * The members of one object against another: a member that is gone is spliced
 * out, a member that is new goes in after the object's last, and the rest are
 * compared value by value.
 *
 * The new-member case is the second half of the rename recipe — naming a lane
 * the author wrote without a name — and it is a different edit from a `set`,
 * which is why it is decided here on what the base document holds rather than
 * by the caller remembering which kind of rename they did.
 */
function diffMembers(path, was, now, skipKey, edits, depth) {
  for (const key of Object.keys(was)) {
    if (key === skipKey) continue;
    if (!has(now, key)) {
      edits.push({ op: 'remove', path: path.concat([key]) });
      continue;
    }
    const r = diffValue(path.concat([key]), was[key], now[key], edits, depth + 1);
    if (r.ok !== true) return r;
  }
  for (const key of Object.keys(now)) {
    if (key === skipKey) continue;
    if (!has(was, key)) edits.push({ op: 'insert', path: path.concat([key]), value: now[key] });
  }
  return OK;
}

/**
 * Whether two documents say the same thing.
 *
 * Key order is not part of it: two objects with the same members differ in no
 * value, so the diff above writes nothing for them and the file would not
 * change. Scalars use the codec's own rule, for the same reason.
 */
function sameValue(a, b, depth) {
  if (a === b) return true;
  if (depth > MAX_DEPTH) return false;
  const ka = kindOf(a);
  if (ka !== kindOf(b)) return false;
  if (ka === 'array') {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!sameValue(a[i], b[i], depth + 1)) return false;
    }
    return true;
  }
  if (ka === 'object') {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!has(b, key)) return false;
      if (!sameValue(a[key], b[key], depth + 1)) return false;
    }
    return true;
  }
  return sameScalar(a, b);
}

/** The codec's rule: NaN is itself, and negative zero is zero. */
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

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Walk a document down a path the codec handed out. */
function valueAt(node, path) {
  let cur = node;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

module.exports = { createStore };
