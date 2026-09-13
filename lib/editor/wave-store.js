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
 * Four rules this file does not get to bend:
 *
 *   - Lane numbers are the codec's flattened display order, and the ONLY way
 *     from one to a path is `lanePath` / `lanePaths` / `laneInsertPath` /
 *     `laneRemovePath` / `laneRemovePaths`. A path built here by hand —
 *     `['signal', k]` — names a real lane whenever a group is involved, just
 *     not the one the user pointed at, and nothing downstream refuses it.
 *   - **A plan is written out, read back and compared before it is handed
 *     over.** Everything below plans from the two documents, and a planner can
 *     be wrong in ways that still produce a well-formed patch: it did, for an
 *     ordinary one-position drag, and the file then said a different lane had
 *     moved. So the last step of `toPatch` is to parse its own output and check
 *     it says what the document says. Where it does not, this refuses. That
 *     turns every planning gap there is or will be from silent corruption into
 *     an honest refusal, which is the only failure mode this layer may have.
 *   - A refusal travels upward unchanged. When the codec answers that a change
 *     cannot be written as a local patch, `toPatch` hands that `{ok:false,
 *     reason, rewroteRange}` straight back. Deciding what the user should do
 *     about it — rewrite the block, cancel, edit by hand — belongs to the
 *     layer that can ask them, and re-serialising the block behind their back
 *     is the one answer this file may never give.
" PLACEHOLDER 
 *
 * A throw inside an `apply` callback is NOT caught. The store's own state is
 * untouched when one happens (nothing is pushed until the new document is in
 * hand), but the callback is the caller's code, and swallowing an error in it
 * would turn their bug into this module's silent no-op. `test/wave-store.test.js`
 * pins both halves of that.
 *
 * No timers, no DOM, no code built at run time: the text being edited is the
 * user's markdown. `test/wave-store.test.js` greps this file for all three.
 *
 * @typedef {Array<string|number>} DocPath  the shape the codec keys spans by
 */

const C = require('./wave-codec.js');

/**
 * The codec's nesting ceiling, read from the codec rather than mirrored, so the
 * two cannot drift: every recursive walk here stops where its reader stops.
 */
const MAX_DEPTH = C.MAX_DEPTH;

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

  const baseDoc = deepFreeze(parsed.doc, 0);
  const basePaths = C.lanePaths(baseDoc);
  const history = [{ opName: null, doc: baseDoc, origins: countUp(basePaths.length) }];
  let at = 0;

  /** The span of one path as a range a caller can frame, or null. */
  function range(path) {
    const span = parsed.spans.get(JSON.stringify(path));
    return span === undefined
      ? null
      : { path: path, spanPath: path, start: span[0], end: span[1] };
  }

  /** One range covering several paths — for a refusal about more than one lane. */
  function spanning(paths) {
    let out = null;
    for (const path of paths) {
      const one = range(path);
      if (one === null) continue;
      if (out === null) out = one;
      else {
        out = {
          path: out.path,
          spanPath: out.spanPath,
          start: Math.min(out.start, one.start),
          end: Math.max(out.end, one.end),
        };
      }
    }
    return out === null ? range([]) : out;
  }

  const ctx = { baseDoc: baseDoc, basePaths: basePaths, range: range, spanning: spanning };

  /**
   * Run one operation and, when it changed anything, push the result.
   *
   * `fn` is handed the current doc and answers the next one. The codec answers
   * the very same object when an operation did nothing — an index out of range,
   * a brush that means nothing where it was aimed — so that identity is the
   * test for "did this happen", and an operation that did nothing does not cost
   * the user an undo press that appears to do nothing either.
   *
   * What comes back also has to be shaped like the document that went in. `{}`
   * and `[]` are neither null nor scalars, and a store that accepted one would
   * spend a stack slot on it and then report `ok:true` on a patch that empties
   * the whole block — the worst possible shape for a layer whose principle is
   * to refuse rather than rewrite.
   *
   * `opName` is carried on the entry and handed back by `undoName` / `redoName`.
   * This file does not coalesce by it; the editor's own burst rules live a layer
   * up, and they need the name to decide.
   */
  function apply(opName, fn) {
    if (typeof fn !== 'function') return false;
    const here = history[at];
    const next = fn(here.doc);
    if (next === here.doc || !isDocShape(here.doc, next)) return false;
    const adopted = adoptDocument(next, 0, new Map());
    const origins = remapOrigins(here.doc, adopted, here.origins);
    history.length = at + 1;
    history.push({
      opName: opName === undefined ? null : opName,
      doc: adopted,
      origins: origins,
    });
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
   * now — or a refusal, the codec's or this file's, never a rewrite.
   *
   * A plan can have more than one candidate: an adjacent pair of lanes reading
   * in swapped order is explained equally well by "the upper one was dragged
   * down" and "the lower one was dragged up", and those two are DIFFERENT trees
   * as soon as a group boundary sits between them. Display order cannot choose,
   * and neither can object identity — under `moveLane` both candidates are the
   * same object at a new position. So the choice is not made by argument at
   * all: each candidate is written out, read back and compared against the
   * document, and the one that reproduces it wins. None reproducing it is a
   * refusal, not a guess.
   */
  function toPatch() {
    const here = history[at];
    const plan = planEdits(ctx, here.doc, here.origins);
    if (plan.ok !== true) return plan;
    let refused = null;
    let mismatched = null;
    for (const edits of plan.alternatives) {
      const written = C.patchSource(sourceText, parsed, edits);
      if (written.ok !== true) {
        if (refused === null) refused = written;
        continue;
      }
      const back = C.parseSource(written.text);
      if (back.ok === true && sameValue(back.doc, here.doc, 0)) return written;
      if (mismatched === null) mismatched = refuse(NET_REASON, range([]));
    }
    // Nothing reproduced the document, so this is a refusal — and WHICH refusal
    // matters, because the candidate that refused during planning is usually the
    // reading that was actually right. A candidate whose plan named a real
    // structural conflict says more than "the bytes did not come back the same",
    // so it is preferred, then the codec's own words, and only then the net.
    //
    // When there was more than one reading, the one being described is the first
    // by position and not necessarily the drag the user performed, so the message
    // says that rather than asserting a gesture nobody made. Naming the "more
    // plausible" reading instead would be a tie-break by argument, which is the
    // thing that shipped the wrong patch in the first place.
    if (plan.refusals.length > 0) {
      const first = plan.refusals[0];
      if (plan.readings < 2) return first;
      return refuse('the lanes were reordered in a way that has more than one reading — ' +
        'which lane was dragged cannot be told apart from the result — and none of them ' +
        'could be written as a local patch. One reading was refused because: ' + first.reason,
        first.rewroteRange);
    }
    if (refused !== null) return refused;
    return mismatched === null ? refuse(NET_REASON, range([])) : mismatched;
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
    // No span table and no edit, so there is no range to frame: `rewroteRange`
    // is null on purpose here, and `error.offset` is where the trouble is.
    toPatch: function () { return refuse(why, null); },
  };
  Object.defineProperty(store, 'doc', { enumerable: true, get: function () { return null; } });
  return store;
}

/** What the read-back check says when no reading of the edit reproduces the doc. */
const NET_REASON =
  'the smallest patch that could be built for this change does not read back as the ' +
  'document the editor is showing, so it was not written; this change needs more than ' +
  'one local edit, or a whole-block rewrite';

function refuse(reason, rewroteRange) {
  return { ok: false, reason: reason, rewroteRange: rewroteRange };
}

const OK = { ok: true };

/**
 * Freeze a document and everything under it, in place.
 *
 * Only for the parse's own document, which nobody else has ever held. A node
 * that is already frozen was frozen by this function, which froze its children
 * first, so it is safe to stop there.
 */
function deepFreeze(value, depth) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value) || depth > MAX_DEPTH) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item, depth + 1);
    return value;
  }
  for (const key of Object.keys(value)) deepFreeze(value[key], depth + 1);
  return value;
}

/**
 * Take a document an operation answered with: share every node that is already
 * frozen, copy every node that is not, and freeze the copies.
 *
 * The sharing is what keeps this proportional to what the operation actually
 * rebuilt — everything it left alone is a node from the previous document and
 * is frozen already — and it is also what keeps lane objects comparable by
 * identity across the edit, which is what `remapOrigins` reads.
 *
 * The copying is for the caller. An operation written by hand can put an object
 * the caller still owns into the document — a lane template reused for every
 * new lane, a row held in a clipboard — and freezing that in place would leave
 * them holding something that throws on the next write, far from here. The
 * codec's own operations deep-copy what they are given and would not need this;
 * hand-written ones are exactly the ones that do.
 *
 * A `__proto__` member is written with `defineProperty`, the same way the codec
 * reads one, so a key like that stays data instead of reaching the prototype.
 *
 * `seen` makes the copy structure-preserving rather than merely tree-shaped: a
 * node reached twice stays one node, and a value that holds itself stays a value
 * that holds itself. Without it a cycle would come out the other side as a
 * MAX_DEPTH-deep tree — quietly turning the one thing the codec refuses by name
 * into something it refuses for an unrelated reason, with a message about
 * nesting for a document the caller wrote as a loop.
 */
function adoptDocument(value, depth, seen) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value) || depth > MAX_DEPTH) return value;
  const already = seen.get(value);
  if (already !== undefined) return already;
  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (const item of value) out.push(adoptDocument(item, depth + 1, seen));
    return Object.freeze(out);
  }
  const out = {};
  seen.set(value, out);
  for (const key of Object.keys(value)) {
    put(out, key, adoptDocument(value[key], depth + 1, seen));
  }
  return Object.freeze(out);
}

/** Spelled out of its own characters so nothing in this file carries it literally. */
const PROTO_KEY = '__' + 'proto' + '__';

function put(obj, key, value) {
  if (key === PROTO_KEY) {
    Object.defineProperty(obj, key, {
      value: value, enumerable: true, writable: true, configurable: true,
    });
  } else {
    obj[key] = value;
  }
}

/**
 * Whether what an operation answered is still a document of the same shape.
 *
 * A lane list that was an array has to stay one: everything below counts lanes
 * through the codec's walk, and a `signal` that is suddenly a string or absent
 * is not an edit of this diagram, it is a different object that happens to be
 * an object.
 */
function isDocShape(was, next) {
  if (next === null || typeof next !== 'object' || Array.isArray(next)) return false;
  if (Array.isArray(was.signal) && !Array.isArray(next.signal)) return false;
  return true;
}

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
 * What identity does NOT answer is which lane the user dragged when two lanes
 * swapped: both are the same object, both are somewhere new. That question is
 * settled in `toPatch`, by writing each reading out and reading it back.
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

/**
 * Where each lane of `afterDoc` was in `beforeDoc`, as display-order indexes:
 * `trace[j]` is the row that lane occupied before, or `null` for a row that
 * did not exist then.
 *
 * `remapOrigins` above already answers this question — it is how the patch
 * planner knows which lane is which — and this is that same answer asked one
 * operation wide instead of session-wide. It is exported because the EDITOR
 * needs the identical answer for a different reason: the keyboard's cell
 * cursor and the selection are row indexes, and every operation that reorders
 * rows moves the lane out from under them.
 *
 * One implementation, deliberately. The alternative is a second belief about
 * which lane is which living in the UI, and this batch has now paid three
 * times for exactly that shape — the drawing recomputing levels the codec
 * already knew, geometry walking the tree the codec already walks, two records
 * of one comment run. A mark that disagreed with the patch about lane identity
 * would paint one lane and write another.
 */
function laneTrace(beforeDoc, afterDoc) {
  return remapOrigins(beforeDoc, afterDoc, countUp(laneObjects(beforeDoc).length));
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
 * The candidate edit lists that turn the base document into the current one.
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
 * content half is then done pairwise between lanes that survived. That half can
 * offer more than one candidate; `toPatch` decides between them by reproduction.
 */
function planEdits(ctx, doc, origins) {
  const common = [];
  const laneAware = Array.isArray(signalOf(ctx.baseDoc)) && Array.isArray(signalOf(doc));
  const skip = laneAware ? 'signal' : null;
  const top = diffMembers(ctx, [], ctx.baseDoc, doc, skip, common);
  if (top.ok !== true) return top;
  if (!laneAware) return { ok: true, alternatives: [common], refusals: [], readings: 1 };
  if (origins.length === ctx.basePaths.length && isCountUp(origins)) {
    const lanes = diffValue(ctx, ['signal'], signalOf(ctx.baseDoc), signalOf(doc), common);
    if (lanes.ok !== true) return lanes;
    return { ok: true, alternatives: [common], refusals: [], readings: 1 };
  }
  const structural = planStructural(ctx, doc, origins);
  if (structural.ok !== true) return structural;
  return {
    ok: true,
    alternatives: structural.alternatives.map(function (extra) { return common.concat(extra); }),
    refusals: structural.refusals,
    readings: structural.readings,
  };
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
 * text being patched and the spans are keyed to it.
 */
function planStructural(ctx, doc, origins) {
  const survivors = [];
  for (let j = 0; j < origins.length; j++) {
    if (origins[j] !== null) survivors.push({ cur: j, base: origins[j] });
  }

  // A group title is not a lane, so nothing above tracks one, and a structural
  // walk would carry a renamed title silently past the patch. No codec
  // operation renames one — only a hand-written operation reaches this — so
  // rather than guess which title became which, anything the current doc says
  // that the base doc did not is refused. A title that vanished is ordinary: it
  // went with the group its last lane emptied. (A group DISSOLVED by hand, with
  // its lanes kept, says nothing new here — that one is caught by the
  // read-back check in `toPatch`, because the patch would still hold the group.)
  const titles = titleCensus(ctx.baseDoc);
  for (const title of titlesOf(doc)) {
    const seen = titles.get(title);
    if (seen === undefined || seen === 0) {
      return refuse('a group title changed at the same time as the lane roster, and a ' +
        'title is not a lane, so which one it used to be is not recoverable; apply the ' +
        'title change and the lane change as two edits', ctx.range(['signal']));
    }
    titles.set(title, seen - 1);
  }

  const order = survivors.map(function (s) { return s.base; });
  const candidates = singleMoveCandidates(order);
  if (candidates === null) {
    const dragged = outsideLongestRun(order).map(function (p) { return ctx.basePaths[order[p]]; });
    return refuse('more than one lane would have to move, and every destination is ' +
      'measured against the same source text, so which one lands first is not defined; ' +
      'write the patch and re-read the block between the moves', ctx.spanning(dragged));
  }

  // Every candidate is planned, including the ones that refuse: a candidate can
  // only be ruled out by writing it, and a refusal from one of them is kept
  // rather than dropped, because when none of the others reproduces the
  // document that refusal is the answer.
  const alternatives = [];
  const refusals = [];
  for (const pos of (candidates.length === 0 ? [null] : candidates)) {
    const one = planWithMove(ctx, doc, origins, survivors, order, pos);
    if (one.ok !== true) {
      refusals.push(one);
      continue;
    }
    alternatives.push(one.edits);
  }
  // Even a plan where every reading refused comes back as `ok:true` with no
  // alternatives: `toPatch` is the one place that turns "nothing could be
  // written" into a refusal, so that the message it chooses is decided the same
  // way whether there was one reading or several.
  return {
    ok: true,
    alternatives: alternatives,
    refusals: refusals,
    readings: candidates.length === 0 ? 1 : candidates.length,
  };
}

/**
 * One candidate plan: the whole structural half, written as though the lane at
 * display position `movePos` of the surviving order is the one that was dragged
 * (or nothing was, when it is null).
 */
function planWithMove(ctx, doc, origins, survivors, order, movePos) {
  const edits = [];
  const curPaths = C.lanePaths(doc);
  let movePath = null;
  let moveTo = null;
  if (movePos !== null) {
    movePath = ctx.basePaths[order[movePos]];
    moveTo = destinationFor(ctx, order, movePos);
    if (moveTo === null) {
      return refuse('the lane that moved has no destination in the document it is ' +
        'moving inside', ctx.range(movePath));
    }
  }

  // What has to come out of the file is not only the lanes the user deleted: a
  // lane that LEFT a group takes that group with it too when nothing else is
  // staying behind, and the two halves only see each other if they are counted
  // together. Counted apart, a group whose last two lanes went by one deletion
  // and one drag stays in the file as an empty husk — titled, drawing nothing,
  // and unaddressable ever after.
  const gone = [];
  for (let i = 0; i < ctx.basePaths.length; i++) {
    if (!survivorsHave(survivors, i)) gone.push(i);
  }
  const movedOut = movePath !== null &&
    JSON.stringify(movePath.slice(0, -1)) !== JSON.stringify(moveTo.slice(0, -1));
  const removals = C.laneRemovePaths(ctx.baseDoc, movedOut ? gone.concat([order[movePos]]) : gone);
  if (removals === null) {
    return refuse('the lanes to remove could not be resolved against the source document',
      ctx.range(['signal']));
  }
  // What the codec's own `move` will cut out, by the same rule: the lane, or the
  // group it empties by leaving. Anything the joint count says goes but the move
  // does not take is a group emptied by the deletion AND the drag together, and
  // that has no single local patch — the group's bytes contain the lane that has
  // to survive somewhere else, so the two edits would overlap.
  const moveCut = movePath === null ? null : C.laneRemovePath(ctx.baseDoc, order[movePos]);
  for (const path of removals) {
    if (moveCut !== null && JSON.stringify(path) === JSON.stringify(moveCut)) continue;
    if (moveCut !== null && isPrefixPath(path, moveCut)) {
      return refuse('a group is emptied by a deletion and a drag together, and the bytes ' +
        'that would have to be deleted are the same bytes the drag has to carry somewhere ' +
        'else; save the deletion and the drag as two edits', ctx.range(path));
    }
    edits.push({ op: 'remove', path: path });
  }

  if (movePath !== null) edits.push({ op: 'move', path: movePath, to: moveTo });

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
        ? C.laneInsertPath(ctx.baseDoc, ctx.basePaths.length)
        : C.laneInsertPath(ctx.baseDoc, before),
      value: valueAt(doc, curPaths[j]),
    });
  }

  for (const s of survivors) {
    const was = valueAt(ctx.baseDoc, ctx.basePaths[s.base]);
    const now = valueAt(doc, curPaths[s.cur]);
    if (was === now) continue;
    const r = diffValue(ctx, ctx.basePaths[s.base], was, now, edits);
    if (r.ok !== true) return r;
  }
  return { ok: true, edits: edits };
}

/**
 * Where a dragged lane has to land, as a path the codec's `move` resolves
 * against the base document: in front of whichever surviving lane follows it
 * now, or on the end of the lane list when none does. That is the same counting
 * `moveLane`'s own recipe does — a destination measured after the lift is one
 * place further along while the lane is still in the way.
 */
function destinationFor(ctx, order, movePos) {
  for (let k = movePos + 1; k < order.length; k++) {
    return C.laneInsertPath(ctx.baseDoc, order[k]);
  }
  return C.laneInsertPath(ctx.baseDoc, ctx.basePaths.length);
}

function survivorsHave(survivors, base) {
  for (const s of survivors) {
    if (s.base === base) return true;
  }
  return false;
}

/** Whether `a` is `b` itself or an ancestor of it. */
function isPrefixPath(a, b) {
  if (a.length > b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Which single lane could have been dragged to produce this order.
 *
 * `[]` when the surviving lanes still read in the order the file has them, so
 * nothing moved. Otherwise every position that, lifted out, leaves the rest
 * increasing — **all** of them, not one chosen by a tie-break. An adjacent pair
 * reading swapped always yields two, and they are not equivalent: with a group
 * boundary between them, "b moved up" puts b outside the group and "a moved
 * down" pulls a inside it. Choosing by argument here is how this file shipped a
 * patch for the wrong lane, so it does not choose; `toPatch` writes each
 * candidate out and keeps the one that reads back as the document.
 *
 * `null` when no single lift can explain the order — two or more lanes moved,
 * and one source text cannot say which lands first.
 */
function singleMoveCandidates(order) {
  if (isIncreasing(order, -1)) return [];
  const out = [];
  for (let p = 0; p < order.length; p++) {
    if (isIncreasing(order, p)) out.push(p);
  }
  return out.length === 0 ? null : out;
}

/** Whether `order` is increasing once the element at `skip` is left out. */
function isIncreasing(order, skip) {
  let last = -Infinity;
  for (let i = 0; i < order.length; i++) {
    if (i === skip) continue;
    if (!(order[i] > last)) return false;
    last = order[i];
  }
  return true;
}

/**
 * Which positions of `order` are not in a longest increasing subsequence of it.
 * Only used to NAME the lanes in the refusal when more than one has to move —
 * the decision itself is made by reproduction, not by this.
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
 *
 * There is no depth guard here, and none is needed: this walks the two documents
 * in step and only keeps going where BOTH sides are containers, so its depth is
 * bounded by the base document's — and that one came out of `parseSource`, which
 * refuses past its own ceiling. Measured against this host: a value nested 61
 * levels under a lane parses and saves, and 62 is refused by the reader before
 * anything here sees it. The guard that used to sit here could not fire from any
 * source this store can open, so it was removed rather than left as a branch no
 * test could reach. `test/wave-store.test.js` pins the two measurements, so a
 * change to that ceiling reddens rather than quietly reopening the question.
 */
function diffValue(ctx, path, was, now, edits) {
  if (was === now) return OK;
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
      const r = diffValue(ctx, path.concat([i]), was[i], now[i], edits);
      if (r.ok !== true) return r;
    }
    return OK;
  }
  if (wasKind === 'object') return diffMembers(ctx, path, was, now, null, edits);
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
function diffMembers(ctx, path, was, now, skipKey, edits) {
  for (const key of Object.keys(was)) {
    if (key === skipKey) continue;
    if (!has(now, key)) {
      edits.push({ op: 'remove', path: path.concat([key]) });
      continue;
    }
    const r = diffValue(ctx, path.concat([key]), was[key], now[key], edits);
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

module.exports = { createStore, laneTrace };
