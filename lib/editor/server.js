'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const drawioLib = require('../drawio.js');
const { renderMarkdown } = require('../md2doc.js');

const LINEOPS_SRC = fs.readFileSync(path.join(__dirname, 'lineops.js'), 'utf8');
const INLINE_MD_SRC = fs.readFileSync(path.join(__dirname, 'inline-md.js'), 'utf8');
const TABLE_MD_SRC = fs.readFileSync(path.join(__dirname, 'table-md.js'), 'utf8');
// Task 4 (Phase 3): list-md.js's browser factory reads `root.md2docInlineMd`
// directly (same pattern table-md.js uses) — must land after inline-md.js,
// same as table-md.js above. Order relative to table-md.js itself doesn't
// matter (list-md.js never reads window.md2docTableMd), but it's injected
// right after it to keep the two sibling serializers grouped together.
const LIST_MD_SRC = fs.readFileSync(path.join(__dirname, 'list-md.js'), 'utf8');
const HISTORY_SRC = fs.readFileSync(path.join(__dirname, 'history.js'), 'utf8');
// Task 6: spec §3.4's shift-then-clamp, a pure data transform with no
// dependency on any other editor module — order among these is irrelevant, it
// only has to land before client.js reads window.md2docIndentClamp.
const INDENT_CLAMP_SRC = fs.readFileSync(path.join(__dirname, 'indent-clamp.js'), 'utf8');
// S2 spec §3.2/§4.3: the pure marker stripper/emitter behind the 轉換成
// submenu. Same "no dependency on any other editor module" property as
// indent-clamp.js above — it only has to land before client.js reads
// window.md2docConvertMd.
const CONVERT_MD_SRC = fs.readFileSync(path.join(__dirname, 'convert-md.js'), 'utf8');
// v3.2.0: the pure string-diff module behind incremental DOM patching —
// stripBlockId()/patchmap() compare oldParts[i] against newParts[j] with only
// data-block-id normalized (see the global constraint on that). Same "no
// dependency on any other editor module" property as indent-clamp.js and
// convert-md.js above; it only has to land before client.js reads
// window.md2docPatchmap.
const PATCHMAP_SRC = fs.readFileSync(path.join(__dirname, 'patchmap.js'), 'utf8');
// S3 spec §3.3/§3.6/§4.4: the pure block multi-select model — line-range
// normalization, membership, Shift+arrow stepping, the §3.3 grip rule and the
// post-operation collapse. Same "no dependency on any other editor module"
// property as indent-clamp.js and convert-md.js above; it only has to land
// before client.js reads window.md2docSelection.
const SELECTION_SRC = fs.readFileSync(path.join(__dirname, 'selection.js'), 'utf8');
// v3.1.0 Task E: the four Phase-1 modules behind the visible toolbar, the
// paste pipeline, the image-drop asset endpoint and the whole-document
// source escape hatch. Same "pure module, no dependency on any other editor
// module" property as indent-clamp.js / convert-md.js / selection.js above —
// each only has to land before client.js reads its window global.
const TOOLBAR_MODEL_SRC = fs.readFileSync(path.join(__dirname, 'toolbar-model.js'), 'utf8');
const DOCSOURCE_SRC = fs.readFileSync(path.join(__dirname, 'docsource.js'), 'utf8');
const ASSET_SRC = fs.readFileSync(path.join(__dirname, 'asset.js'), 'utf8');
// turndown's BROWSER build. node's `require('turndown')` resolves to
// lib/turndown.cjs.js, which is not loadable as a plain <script> tag — the
// UMD build is, and it defines the global `TurndownService` that
// paste-md.js's getTurndownService() reads at CALL time (not factory time,
// so this tag's position relative to paste-md.js's is not load-bearing;
// it is injected first anyway, to keep the dependency reading left-to-right).
const TURNDOWN_SRC = fs.readFileSync(
  require.resolve('turndown/lib/turndown.browser.umd.js'), 'utf8');
const PASTE_MD_SRC = fs.readFileSync(path.join(__dirname, 'paste-md.js'), 'utf8');

// v3.4.0 batch3 Task 6: the wavedrom GUI's modules.
//
// wave-codec.js / wave-geometry.js / wave-store.js are plain CommonJS ON
// PURPOSE, and rewriting them into the UMD header every other module here uses
// is not available: test/wave-codec.test.js bans the spelling `require(` in the
// codec outright, test/wave-geometry.test.js bans every host-object read a UMD
// header performs (`typeof self`, `root.x = …`), and test/wave-store.test.js
// pins the store's require list to exactly `["require('./wave-codec.js')"]`. So
// the browser gets them through the small CommonJS shim below instead —
// the module text itself is inlined byte for byte.
//
// v3.6.0 Task 1: wave-draw.js joins them, plain CommonJS too — a pure
// extraction out of wave-ui.js, not test-guarded like the other three, but
// needing the identical shim for a different reason: wave-ui.js itself is
// injected as a bare <script> with no `require()` of its own (see its own
// header comment), so it cannot resolve `require('./wave-draw.js')` in the
// browser any more than the page around it could. `createWaveEditor()` takes
// it in as `opts.draw` instead, the same way it already takes `opts.codec`
// and `opts.geometry`.
//
// v3.6.0 Task 2: wave-panels.js joins them for the identical reason —
// another pure extraction out of wave-ui.js (the toolbar, the right-hand
// panels and the lane rail this time), needing the same shim because
// wave-ui.js still cannot `require()` anything in the browser. Taken in as
// `opts.panels`.
//
// wave-ui.js is UMD like its neighbours and needs no shim; in the page it
// defines `window.md2docWaveUi` and takes the other five as parameters.
const WAVE_CODEC_SRC = fs.readFileSync(path.join(__dirname, 'wave-codec.js'), 'utf8');
const WAVE_GEOMETRY_SRC = fs.readFileSync(path.join(__dirname, 'wave-geometry.js'), 'utf8');
const WAVE_STORE_SRC = fs.readFileSync(path.join(__dirname, 'wave-store.js'), 'utf8');
const WAVE_DRAW_SRC = fs.readFileSync(path.join(__dirname, 'wave-draw.js'), 'utf8');
const WAVE_PANELS_SRC = fs.readFileSync(path.join(__dirname, 'wave-panels.js'), 'utf8');
const WAVE_UI_SRC = fs.readFileSync(path.join(__dirname, 'wave-ui.js'), 'utf8');

// One CommonJS module, wrapped so a plain <script> can carry it.
//
// The `'use strict'` is the FIRST statement of the script, not of the wrapper
// function, so the whole tag — module body included — is strict. That is
// load-bearing rather than tidy: the store deep-freezes every document it
// keeps, and a frozen object only BITES in strict mode. test/wave-store.test.js
// T24 measured the sloppy-mode alternative — four of five writes to a frozen
// document were silent — so a wrapper that lost the prologue would put the
// original corruption back and make it quieter.
//
// `require` here resolves by basename against what has already been shimmed,
// which is enough for the only two edges that exist (both './wave-codec.js')
// and stays a total function for anything else: an unknown name answers
// undefined and the module that asked fails where it asked.
function waveModuleTag(name, src) {
  return '<script>\'use strict\';\n' +
    'window.__md2docWave = window.__md2docWave || {};\n' +
    '(function () {\n' +
    'var module = { exports: {} };\n' +
    'var exports = module.exports;\n' +
    'function require(p) { return window.__md2docWave[String(p).split(\'/\').pop()]; }\n' +
    src + '\n' +
    'window.__md2docWave[' + JSON.stringify(name) + '] = module.exports;\n' +
    '})();</script>\n';
}

// The SAME pure module the page gets, required here for the node side of
// /api/asset. asset.js is deliberately free of `require('fs')`/`require('path')`
// (it is plain string arithmetic), so every filesystem decision below is made
// here — including the '/'-normalization isWithin's contract demands.
const assetLib = require('./asset.js');

// asset.js's isWithin() is POSIX-only BY CONTRACT (see its own comment): it
// does not understand '\\' as a separator and fails CLOSED on a native-Windows
// path, refusing every legitimate write. Normalizing at this boundary is the
// caller's job, and this is that boundary.
function toPosixPath(p) {
  return String(p === null || p === undefined ? '' : p).split('\\').join('/');
}

function readJson(req, limitBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    // Accumulate raw Buffers and decode ONCE at the end. Per-chunk string
    // concatenation (`buf += chunk`) decodes each chunk independently, so a
    // multi-byte UTF-8 character straddling a TCP chunk boundary becomes
    // U+FFFD — on a multi-MB CJK document that silently corrupts one
    // character per unlucky chunk boundary (seen in the wild: 9 mangled
    // chars in one zero-edit save).
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      chunks.push(c);
      total += c.length;
      if (total > limitBytes) { reject(new Error('payload too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
    });
  });
}

// DNS-rebinding defense. The content-type gate below stops a cross-site
// "simple" POST, but it cannot stop a request the browser believes is
// SAME-origin: a page on evil.com served with a 1-second-TTL A record can
// rebind that name to 127.0.0.1 and then POST to http://evil.com:PORT/... with
// a real application/json body. No preflight fires, the content-type check is
// satisfied, and the attacker is inside.
//
// What made that reachable is that a route needs no unguessable precondition.
// /api/save happens to have one — `baseMtimeMs` must equal the file's actual
// mtimeMs, a float an attacker cannot guess — but /api/asset needs only a
// `fileId` inside [0, absFiles.length), which is guessable in one try, and it
// WRITES FILES. So the check belongs at the front door rather than on the one
// route that happened to lack a second lock: the Host header is attacker-
// controlled in name only, since a rebinding attack must send the name it
// rebound, and that name is never a loopback literal.
//
// A missing Host is rejected too (HTTP/1.0 clients): this server is only ever
// addressed by lib/editor/open.js and a browser, both of which send one.
function hostIsLoopback(hostHeader, port) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return false;
  const h = hostHeader.toLowerCase();
  const names = ['127.0.0.1', 'localhost', '[::1]'];
  for (const n of names) {
    if (h === n + ':' + port) return true;
    // A bare Host (no ':port') means the scheme's default port. Only accept it
    // when that is genuinely the port we are listening on.
    if (port === 80 && h === n) return true;
  }
  return false;
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

// The one invariant that ties the two halves of the payload together: every
// block's line range must address a line that actually EXISTS in `lines`.
// blockmap.js derives ranges from marked's own tokenisation while `lines`
// comes from a regex split here, so the two can only agree while both use the
// SAME definition of a line terminator — and when they disagree the failure is
// silent and destructive (lineops.replaceLines() splices past the end of the
// array, deleting every line the block map thought was there). Throwing here
// turns that into the server route's 500 + the client's error banner, which is
// a document that will not open rather than a document that opens and then
// eats its own tail.
function assertBlockRangesFit(blocks, lines) {
  let maxEnd = 0;
  for (const b of blocks || []) if (b.endLine > maxEnd) maxEnd = b.endLine;
  if (maxEnd > lines.length) {
    throw new Error('block map is out of range: endLine ' + maxEnd +
      ' > ' + lines.length + ' lines (line-terminator handling disagrees with marked)');
  }
}

// F13: the never-opened grace deadline is deliberately its own constant, not
// connectionGraceMs (see that constant's own comment) reused. connectionGraceMs
// governs the gap between one /api/alive connection dropping and a
// replacement showing up once a real tab is confirmed to have existed at
// all. Before the URL is opened there is no connection to have dropped in
// the first place — the wait here is instead for a human to alt-tab to a
// browser, or, over SSH, copy the printed URL across to a local machine and
// load it there, which routinely takes longer than connectionGraceMs allows.
// Reusing connectionGraceMs for that wait would close sessions on people
// still reading the terminal output. Five minutes is chosen as a margin
// generous for that human handoff while still finite; test/cli-edit.test.js
// drives it through a shortened override — an unopened session still exits
// on its own, and a session opened partway through the grace window keeps
// working afterward.
const DEFAULT_NEVER_OPENED_GRACE_MS = 5 * 60 * 1000;

// v3.6.0: replaces idleTimeoutMs as the "is anyone still there" clock.
// idleTimeoutMs measured the gap since the last /api/ping — a plain
// setInterval(..., 10000) in client.js — and pings from a backgrounded
// (merely unfocused, tab still open) browser tab are throttled by the
// browser itself. MEASURED on this branch (see LIVENESS-REPORT.md): once
// Chrome's real background-timer throttling is allowed to engage — puppeteer
// disables it by default for automation stability, and the first measurement
// pass on this branch silently measured THAT instead — a backgrounded tab's
// 10s ping settled at roughly once per minute. 60s > the old 30,000ms
// default, so a tab the user had only alt-tabbed away from looked exactly
// like a closed one and the session was killed out from under a document
// still open on screen. A connection is not a timer, so it is not subject to
// that clamp: GET /api/alive holds its response open for as long as the tab
// (or this same document's tab, after a reload) keeps it open, and dropping
// to zero open connections is what this grace measures from.
//
// The grace itself exists for one trap: an F5 reload closes the old
// connection and opens a new one, and the two are NOT the same event — there
// is a real (if small) gap between them, during which the connection count is
// genuinely zero. Without a grace, every reload would kill the session.
// MEASURED (LIVENESS-REPORT.md, five consecutive page.reload() calls against
// a real headless Chrome hitting the real /api/alive route): the old
// connection's 'close' to the replacement connection's arrival ran
// 55-73ms, averaging 64ms. This default (5s) is roughly 70x that measured
// margin — headroom for a slower disk, a loaded machine, or a proxy in the
// path — while still closing a genuinely abandoned session within a few
// seconds rather than lingering. test/cli-edit.test.js and
// test/editor-server.test.js drive it through a shortened override, the same
// pattern DEFAULT_NEVER_OPENED_GRACE_MS above already uses.
const DEFAULT_CONNECTION_GRACE_MS = 5000;

// server.js sends one of these on every open /api/alive stream so an idle
// stream is never silently dropped by an intermediary (a corporate proxy, a
// misbehaving localhost tool) that closes connections it hasn't seen traffic
// on in a while, and so a half-open socket (the far end vanished without a
// TCP FIN, e.g. a laptop that lost power) is discovered on the next write
// rather than held forever. A bare SSE comment line (no `data:` field) is
// invisible to EventSource's onmessage — nothing to parse, nothing to react
// to, exactly the "the connection's mere existence is the signal" contract
// client.js documents at its own call site.
const ALIVE_KEEPALIVE_MS = 15000;

// T21 item 3: closing this server has to mean "stop serving now", not "stop
// serving once every open socket happens to go away". `server.close()` on its
// own does the latter: it stops accepting, then waits for the connections it
// already has. A browser handed the edit URL opens a socket it may never send
// a request on (a speculative preconnect), and such a socket is not one Node
// retires by itself — driven against `md2doc --edit` on this box with a
// viewer stub that opened one TCP connection to the port and sent no bytes,
// SIGINT printed cli.js's line and the process was still alive 10 s later,
// 3 runs of 3 — while the same runs with a viewer stub that connected and
// sent a request, and with `--no-open`, exited in 7-10 ms. The same hang
// reaches the idle and never-opened deadlines below, which have no second
// keystroke to rescue them, so every exit this file owns goes through here.
//
// closeAllConnections() lands the sockets that close() would wait on. It is
// Node >= 18.2 and package.json's engines floor is >= 18, so the call is
// guarded rather than assumed; on an 18.0/18.1 runtime the behaviour is
// exactly what it was before this function existed.
function shutdownServer(server, reason) {
  // F13: name the reason before closing, so cli.js's listener (the process's
  // stdout writer) can print a line distinct from the other exits.
  if (reason) server.emit('md2doc-auto-close', reason);
  server.close();
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
}

async function createEditorServer({
  files, neverOpenedGraceMs = DEFAULT_NEVER_OPENED_GRACE_MS,
  connectionGraceMs = DEFAULT_CONNECTION_GRACE_MS,
  clientJs = '', listenPort = 0,
}) {
  const absFiles = files.map((f) => path.resolve(f));
  let neverOpenedTimer = null;
  let started = false;
  // v3.6.0: the liveness mechanism. `aliveConnections` holds every currently
  // open GET /api/alive response, GLOBALLY across every tab and every file
  // this one server serves — `md2doc --edit a.md b.md` is one session, and
  // closing the tab for a.md must not tear down b.md's still-open tab, so
  // the decision that matters is "is the set empty", never "which file was
  // this connection for". `started` now means "at least one such connection
  // has ever been registered" — see registerAliveConnection() and
  // DEFAULT_NEVER_OPENED_GRACE_MS's own comment on why that boundary moved
  // off GET /edit/:id.
  const aliveConnections = new Set();
  let shutdownGraceTimer = null;
  // Guards against the (already-benign, but worth making impossible on
  // purpose) case of two shutdown triggers landing close together — e.g. a
  // connection's 'close' event arriving from closeAllConnections() itself
  // while the process is already on its way out through srv.close().
  let closing = false;

  // v3.4.0 batch2 Task 6 — Ruling B2-2: watch every `.drawio`/`.xml` file the
  // CURRENTLY OPEN document references, and let /api/ping's already-firing
  // 10s heartbeat (see its own comment below) double as the staleness check,
  // rather than inventing a SEPARATE push transport for it. v3.6.0 DID add
  // one push transport to this stack — GET /api/alive, an SSE stream, but
  // only for session liveness (see registerAliveConnection() below and
  // DEFAULT_CONNECTION_GRACE_MS's comment for why polling could not do that
  // job). The reasoning that kept drawio staleness on polling is unchanged
  // and still applies to drawio specifically: a filesystem watch would need
  // one watcher per referenced file with no bound on how many a document can
  // reference, and the existing 10s heartbeat already has a client on the
  // other end of it for a different reason, so riding it costs nothing extra
  // beyond the stat calls in checkDrawioStale() below.
  //
  // TWO maps, and the split is the whole point of fix round 1:
  //
  //   drawioWatch   fileId -> { refs }.  WHAT THE LAST BAKE RESOLVED.
  //                 The list of absolute paths that render actually resolved,
  //                 i.e. the only paths worth stat'ing for this document.
  //                 Fix round 2 (re-review G13): this used to carry a
  //                 `stamps` Map as well, which nothing ever read — the new
  //                 tab's baseline comes from trackDrawioRefs()'s RETURN
  //                 value, handed straight to registerDrawioClient() in the
  //                 same expression. Dead state in a freshly written
  //                 mechanism is a maintenance trap, so it is gone; the stamp
  //                 lib/md2doc.js takes before the bake (review F4) still
  //                 travels, just not through here.
  //
  //   drawioClients clientKey -> { fileId, stamps, pending, lastSeen }.
  //                 WHAT ONE BROWSER TAB IS ACTUALLY SHOWING. Review F3: the
  //                 baseline used to be per-file, so with two tabs open on one
  //                 document the first to ping consumed the one signal and the
  //                 second sat on a stale diagram looking perfectly healthy.
  //                 A tab gets its id minted by GET /edit/:id — the same
  //                 response that paints its DOM — so its baseline is exactly
  //                 the bytes it is displaying, with no window in which
  //                 another tab's render could seed it wrong.
  //
  // Review F2's invariant: a client's `stamps` advances ONLY when that client
  // has told us its DOM now shows those bytes. Until then every heartbeat
  // keeps reporting the same staleness, so every one of the client's bail
  // paths (network error, mid-gesture DOM, focus inside the block, …) really
  // does get retried on the next tick instead of losing the change forever.
  const drawioWatch = new Map();
  const drawioClients = new Map();
  // The token that identifies a CONTENT VERSION, not a ping. Minted once per
  // (client, observed stamp set) and repeated verbatim on every later ping
  // that still sees the same bytes — if it were per-ping, a refresh that took
  // longer than one 10s beat would always ack a token the server had already
  // superseded, and the pair would never converge.
  let drawioTokenSeq = 0;
  let drawioLastSweep = 0;
  // 10 minutes = 60 missed heartbeats. A tab that has not pinged in that long
  // is closed (or its machine slept); keeping its entry would leak one small
  // object per tab ever opened for the life of the server process.
  const DRAWIO_CLIENT_IDLE_MS = 10 * 60 * 1000;

  function drawioClientKey(fileId, clientId) {
    if (typeof clientId !== 'string' || clientId === '') return null;
    if (typeof fileId !== 'number' || !isFinite(fileId)) return null;
    return String(fileId) + '\u0000' + clientId;
  }

  function sweepDrawioClients(now) {
    if (now - drawioLastSweep < 60 * 1000) return;
    drawioLastSweep = now;
    for (const [k, c] of drawioClients) {
      if (now - c.lastSeen > DRAWIO_CLIENT_IDLE_MS) drawioClients.delete(k);
    }
  }

  // Fix round 2 (re-review G5). A tab that is still talking to us is alive by
  // definition, so a well-formed clientId with no entry gets one back rather
  // than being answered 204 forever with no signal and no route back but a
  // reload. Reachable the moment a laptop sleeps or a background tab's timers
  // are frozen for longer than the sweep window — and before this, the tab's
  // own returning heartbeat was what deleted it (the sweep ran BEFORE the
  // lastSeen refresh), so the failure mode was silent, permanent, and caused
  // by the recovery attempt itself.
  //
  // Seeded with an EMPTY stamp map on purpose, not with the last bake's: we
  // do not know what that tab's DOM is showing, and an empty baseline makes
  // the next check report stale, which costs one re-render the client then
  // acks. Wrong in the safe direction (one redundant bake) instead of the
  // unsafe one (a tab that silently never updates again).
  //
  // Fix round 3 (re-review2 H4): the bound is EVICT-OLDEST, applied at BOTH
  // doors. Round 2 capped only the ping door and refused past the cap, which
  // was wrong twice over: `GET /edit/:id` wrote into the same map with no
  // check at all, and refusing meant that once 64 entries accumulated, a
  // genuinely swept live tab could never re-register — G5's own guard rail
  // reintroducing exactly the silent deafness G5 was raised about. Dropping
  // the least-recently-seen entry instead keeps the map at <= MAX from both
  // doors AND never turns a live tab away: the entry we drop is by
  // construction the one that has gone quietest.
  //
  // WHAT THIS BOUNDS, EXACTLY (fix round 4, re-review3 M3 — the sentence this
  // replaces claimed more than the code delivers): **the map, not the render
  // load.** Round 2's refuse-at-cap did cap the bakes a fresh-id-per-ping
  // caller could provoke — past 64 ids it answered a bare 204, so no token and
  // no `/api/render` followed. Evict-oldest removes that ceiling on purpose:
  // a caller rotating a new id every ping now gets `{stale, token}` every
  // time and can drive `/api/render` — and therefore headless-Chromium bakes
  // — without bound. That trade is deliberate, because the refusal it removes
  // is exactly what made a swept live tab permanently deaf, and availability
  // for the real tab is worth more here than a ceiling on a caller that is
  // already inside the loopback-only, Host-checked front door (see the
  // DNS-rebinding note above `hostIsLoopback`). Recorded as a known
  // limitation rather than guarded: every guard added to this mechanism so
  // far has produced the next round's finding.
  const DRAWIO_CLIENT_MAX = 64;
  function makeRoomForDrawioClient() {
    while (drawioClients.size >= DRAWIO_CLIENT_MAX) {
      let oldestKey = null, oldestSeen = Infinity;
      for (const [k, c] of drawioClients) {
        if (c.lastSeen < oldestSeen) { oldestSeen = c.lastSeen; oldestKey = k; }
      }
      if (oldestKey === null) return;   // unreachable while size > 0
      drawioClients.delete(oldestKey);
    }
  }
  function ensureDrawioClient(fileId, clientId, now) {
    const key = drawioClientKey(fileId, clientId);
    if (key === null) return null;
    let c = drawioClients.get(key);
    if (c) { c.lastSeen = now; return c; }
    if (!drawioWatch.has(fileId)) return null;
    makeRoomForDrawioClient();
    c = { fileId, stamps: new Map(), pending: null, lastSeen: now };
    drawioClients.set(key, c);
    return c;
  }

  // Called after every render that actually re-reads the source markdown
  // (GET /edit/:id and POST /api/render both call renderMarkdown() fresh).
  // Records WHAT WAS BAKED; deliberately does NOT touch any client's
  // baseline — that is review F2's invariant, and the trap F2 names is
  // exactly this function: /api/render runs BEFORE the client has decided
  // whether it can apply the result, so advancing anything here would lose
  // every post-response bail.
  function trackDrawioRefs(fileId, refs) {
    const list = Array.isArray(refs) ? refs : [];
    const paths = [];
    const stamps = new Map();
    for (const r of list) {
      const abs = r && typeof r.path === 'string' ? r.path : null;
      if (!abs || stamps.has(abs)) continue;
      paths.push(abs);
      stamps.set(abs, r.stamp === undefined ? null : r.stamp);
    }
    drawioWatch.set(fileId, { refs: paths });
    return stamps;
  }

  function registerDrawioClient(fileId, stamps) {
    const clientId = crypto.randomBytes(12).toString('hex');
    const key = drawioClientKey(fileId, clientId);
    if (key === null) return clientId;   // unreachable today; never key on null
    const now = Date.now();
    makeRoomForDrawioClient();           // H4: this door is bounded too
    drawioClients.set(key, {
      fileId, stamps: new Map(stamps), pending: null, lastSeen: now,
    });
    sweepDrawioClients(now);             // G5: after the write, never before
    return clientId;
  }

  function sameStamps(a, b) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) { if (!b.has(k) || b.get(k) !== v) return false; }
    return true;
  }

  // (a) requirement: a document with no drawio references must cost this
  // heartbeat NOTHING beyond the Map lookups below — zero fs.statSync calls,
  // same as the bare 204 this replaces. Only a document that actually has
  // `refs.length > 0` pays for the stat loop that follows.
  //
  // Returns the token to hand the client, or null for "nothing stale".
  function checkDrawioStale(fileId, clientId) {
    const state = drawioWatch.get(fileId);
    if (!state || state.refs.length === 0) return null;
    const key = drawioClientKey(fileId, clientId);
    if (key === null) return null;
    const c = drawioClients.get(key);
    // An unknown client here is one touchDrawioClient() declined to
    // (re-)register: a page from before this feature (no clientId at all), a
    // malformed id, or a fileId this server never rendered. It gets the old
    // bare 204 rather than a signal it has no baseline to interpret. Note
    // that hitting DRAWIO_CLIENT_MAX is NOT one of those cases any more —
    // see makeRoomForDrawioClient() (re-review2 H4).
    if (!c) return null;
    const now = new Map();
    let changed = false;
    for (const p of state.refs) {
      const st = drawioLib.drawioStampOf(p);
      now.set(p, st);
      if (c.stamps.get(p) !== st) changed = true;
    }
    if (!changed) { c.pending = null; return null; }
    if (c.pending && sameStamps(c.pending.stamps, now)) return c.pending.id;
    drawioTokenSeq += 1;
    c.pending = { id: 'd' + drawioTokenSeq, stamps: now };
    return c.pending.id;
  }

  // Keeps a live tab out of the idle sweep above (re-registering it if the
  // sweep already got there — G5), and is the one place the sweep is actually
  // driven from: the heartbeat is the only thing that fires often enough to
  // be worth hanging it on, and it is throttled to at most once a minute
  // inside sweepDrawioClients().
  //
  // ORDER IS LOAD-BEARING: ensure/touch first, sweep second. The other way
  // round, a tab returning from a >10-minute freeze is deleted by the very
  // ping it sent to say it was back.
  function touchDrawioClient(fileId, clientId) {
    const now = Date.now();
    ensureDrawioClient(fileId, clientId, now);
    sweepDrawioClients(now);
  }

  // The client's half of F2's invariant: it sends back the token it was given
  // ONLY after its DOM really carries that render. Anything less than a
  // complete apply (a block skipped because the user's focus was inside it,
  // a mid-gesture DOM, a failed fetch) sends nothing, so `stamps` stays put
  // and the very next heartbeat reports the same staleness again.
  function ackDrawioApplied(fileId, clientId, token) {
    if (typeof token !== 'string' || token === '') return;
    const key = drawioClientKey(fileId, clientId);
    if (key === null) return;
    const c = drawioClients.get(key);
    if (!c || !c.pending || c.pending.id !== token) return;
    c.stamps = c.pending.stamps;
    c.pending = null;
  }

  // Fires shutdownServer() at most once, regardless of which of this file's
  // several deadlines got there first (see `closing`'s own comment above).
  function shutdownOnce(server, reason) {
    if (closing) return;
    closing = true;
    cancelShutdownGrace();
    shutdownServer(server, reason);
  }

  function cancelShutdownGrace() {
    if (shutdownGraceTimer) { clearTimeout(shutdownGraceTimer); shutdownGraceTimer = null; }
  }

  // Armed the moment `aliveConnections` drops to zero, cancelled the moment
  // a new one arrives (registerAliveConnection() below calls
  // cancelShutdownGrace() unconditionally on every new connection, whether or
  // not a grace timer happens to be running). This is the trap named in the
  // design doc: an F5 reload closes the old /api/alive stream and opens a
  // fresh one, and those are two SEPARATE events with a real gap between
  // them — without this grace, every reload would read as "the tab closed"
  // and kill the session out from under the user mid-refresh. See
  // DEFAULT_CONNECTION_GRACE_MS's own comment for the measurement that sized
  // the default.
  function armShutdownGrace(server) {
    if (shutdownGraceTimer || closing) return;
    shutdownGraceTimer = setTimeout(() => {
      shutdownGraceTimer = null;
      // Re-check rather than trust the callback firing at all means "still
      // zero": a connection could have registered and then, in a pathological
      // fast sequence, this timer's callback could still be queued from
      // before that registration cancelled it. Belt-and-braces; cheap.
      if (aliveConnections.size > 0) return;
      shutdownOnce(server, 'idle');
    }, connectionGraceMs);
    if (shutdownGraceTimer.unref) shutdownGraceTimer.unref();
  }

  // Registers one open GET /api/alive response as "this tab is here". Every
  // call cancels any pending shutdown grace FIRST — a fresh connection is by
  // definition proof the session should stay up, whether it is genuinely the
  // first tab, a second tab, or a reload's replacement for one that just
  // dropped. `started` flips here rather than on GET /edit/:id — see
  // DEFAULT_NEVER_OPENED_GRACE_MS's comment on why the "was this session ever
  // really opened" boundary is a live connection now, not the HTML request
  // that precedes it by however long the browser takes to run client.js.
  function registerAliveConnection(server, res, fileId, clientId) {
    cancelShutdownGrace();
    started = true;
    // Stashed on the response object itself rather than threaded through a
    // second Map: nothing in the closing decision reads these back (see this
    // function's own comment), so a real diagnostic (a future `/api/debug`,
    // a log line) is the only consumer, and it already has `res` in hand.
    res._md2docAliveFileId = fileId;
    res._md2docAliveClientId = clientId;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    // Flushes the headers immediately rather than waiting for the first
    // keepalive tick — the client's EventSource does not consider the
    // connection open (readyState transitions to OPEN) until bytes arrive.
    res.write(': connected\n\n');
    aliveConnections.add(res);
    const keepalive = setInterval(() => {
      // A write to an already-gone socket throws; the 'close' listener below
      // is what actually tears this connection's bookkeeping down; this
      // catch only stops that throw from reaching an uncaught spot on a beat
      // that lost a race against the socket's own teardown.
      try { res.write(': keepalive\n\n'); } catch (e) { /* 'close' handles cleanup */ }
    }, ALIVE_KEEPALIVE_MS);
    if (keepalive.unref) keepalive.unref();
    res.on('close', () => {
      clearInterval(keepalive);
      if (!aliveConnections.has(res)) return; // already handled (e.g. shutdown path)
      aliveConnections.delete(res);
      if (aliveConnections.size === 0) armShutdownGrace(server);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');

      // FIRST, ahead of every route including GET /edit/:id — see
      // hostIsLoopback() above for the attack this closes. Placed here rather
      // than on /api/asset alone: that route is merely where it was reachable,
      // not where the hole is.
      const addr = server.address();
      if (!hostIsLoopback(req.headers.host, addr && addr.port)) {
        return send(res, 403, { error: 'forbidden host' });
      }

      const editMatch = url.pathname.match(/^\/edit\/(\d+)$/);

      // Cross-origin defense for every state-changing POST route: a
      // cross-site "simple" POST (form submission, no CORS preflight) cannot
      // set a non-simple content-type header like application/json, so
      // requiring it here means a browser blocks the request before it ever
      // reaches this server — this server never sends CORS headers, so the
      // browser would otherwise let the request fire-and-forget cross-origin.
      // /api/ping is included; lib/editor/client.js's fetch calls already
      // send this header for render, save, and ping.
      // v3.1.0: '/api/asset' is in this set for the same reason the other
      // three are, and more urgently — it is the only route that CREATES a
      // file. A route left out of this set has NO cross-origin defense at
      // all: any page the user happens to be browsing while `md2doc --edit`
      // is running could fire a cross-site "simple" POST at every candidate
      // localhost port and write to disk.
      const STATE_CHANGING_POST_PATHS = new Set(['/api/render', '/api/save', '/api/ping', '/api/asset']);
      if (req.method === 'POST' && STATE_CHANGING_POST_PATHS.has(url.pathname)) {
        const contentType = String(req.headers['content-type'] || '');
        if (!/^application\/json\b/i.test(contentType)) {
          return send(res, 415, { error: 'content-type must be application/json' });
        }
      }

      if (req.method === 'GET' && editMatch) {
        const fileId = Number(editMatch[1]);
        const file = absFiles[fileId];
        if (!file || !fs.existsSync(file)) return send(res, 404, { error: 'unknown file' });
        const mdText = fs.readFileSync(file, 'utf8');
        const mtimeMs = fs.statSync(file).mtimeMs;
        // EOL 偵測與拆行：lines 內部一律不含 \r（spec §3.11）。只有
        // /api/save 會把它接回檔案原本的 EOL；/api/render 一律用 \n。
        //
        // 三種終止符，不是兩種（T7）：marked 的 preprocess 把裸 \r 正規化成
        // \n（實測 marked 14：'# H\rpara\r' → heading + paragraph 兩個
        // token），所以 blockmap 會給出「第 2 行」這種行號；而 /\r\n|\n/
        // 不拆裸 \r，`lines` 只有一個元素。行號與 lines 脫鉤之後，任何
        // commit 的 replaceLines() 都會把 startLine 之後的內容整段吃掉——
        // 實測 '# H\rpara\r' 編輯第一個 block 之後 'para' 直接消失。
        // 拆行規則必須跟 marked 的換行定義一致。
        //
        // 多數決，不是「有 CRLF 就算 CRLF」（final review I3）：save 會把
        // `lines` 全部用同一個 eol 接回去，所以一萬行的 LF 檔裡混進一行
        // CRLF，舊式偵測會在第一次存檔時把一萬行全部改寫成 CRLF ——
        // 直接違反 spec §3.11 第 4 點「commit 範圍以外的行保留原位元組」。
        // 多數決把損害限制在少數派那幾行。平手時取 LF（git / POSIX 預設）。
        // 用「\n 總數 − CRLF 數」算裸 LF，而不是 /(^|[^\r])\n/g：後者是
        // non-overlapping 比對，連續空行的第二個 \n 會被前一次比對吃掉的
        // 字元擋掉而漏數。減法沒有這個誤差。
        //
        // 裸 \r 也進多數決，理由跟上一段同一條：既然現在會拆它，一個純
        // CR 檔（classic Mac）就會在第一次存檔時被整份改寫成 LF——正是
        // §3.11 第 4 點禁止的事。平手一律 LF。
        const lfTotal = (mdText.match(/\n/g) || []).length;
        const crTotal = (mdText.match(/\r/g) || []).length;
        const crlfCount = (mdText.match(/\r\n/g) || []).length;
        const bareLf = lfTotal - crlfCount;
        const bareCr = crTotal - crlfCount;
        // Strict > on every comparison, so ANY tie falls through to LF — which
        // is what the paragraph above promises. `>=` against bareCr handed a
        // CR/CRLF tie to CRLF and contradicted it. Nothing else moves: a
        // pure-CRLF file has bareCr === 0.
        const eol = (crlfCount > bareLf && crlfCount > bareCr) ? '\r\n'
          : (bareCr > bareLf && bareCr > crlfCount) ? '\r'
          : '\n';
        const { html, blocks, drawioRefs } = await renderMarkdown(mdText, file, { editMode: true });
        // Fix round 1 (review F3): mint this TAB's own staleness baseline from
        // the very render that is about to paint it. Per-tab, not per-file —
        // two tabs on one document must each get told about an external edit.
        const drawioClientId = registerDrawioClient(fileId, trackDrawioRefs(fileId, drawioRefs));
        const lines = mdText.split(/\r\n|\r|\n/);
        assertBlockRangesFit(blocks, lines);
        const payload = JSON.stringify({
          fileId, mtimeMs, eol, lines, blocks, drawioClientId,
        });
        const inject =
          `<script>window.__ED__ = ${payload.replace(/</g, '\\u003c')}</script>\n` +
          `<script>${LINEOPS_SRC}</script>\n` +
          `<script>${INLINE_MD_SRC}</script>\n` +
          `<script>${TABLE_MD_SRC}</script>\n` +
          `<script>${LIST_MD_SRC}</script>\n` +
          `<script>${HISTORY_SRC}</script>\n` +
          `<script>${INDENT_CLAMP_SRC}</script>\n` +
          `<script>${CONVERT_MD_SRC}</script>\n` +
          `<script>${PATCHMAP_SRC}</script>\n` +
          `<script>${SELECTION_SRC}</script>\n` +
          `<script>${TOOLBAR_MODEL_SRC}</script>\n` +
          `<script>${DOCSOURCE_SRC}</script>\n` +
          `<script>${ASSET_SRC}</script>\n` +
          `<script>${TURNDOWN_SRC}</script>\n` +
          `<script>${PASTE_MD_SRC}</script>\n` +
          waveModuleTag('wave-codec.js', WAVE_CODEC_SRC) +
          waveModuleTag('wave-geometry.js', WAVE_GEOMETRY_SRC) +
          waveModuleTag('wave-store.js', WAVE_STORE_SRC) +
          waveModuleTag('wave-draw.js', WAVE_DRAW_SRC) +
          waveModuleTag('wave-panels.js', WAVE_PANELS_SRC) +
          `<script>${WAVE_UI_SRC}</script>\n` +
          `<script>${clientJs}</script>\n`;
        // Splice at the LAST "</body>" — the document's real closing tag.
        // The first occurrence can sit inside an inlined diagram bundle's JS
        // string literal (mermaid's DOMPurify source contains "</body>");
        // String.replace would inject __ED__ mid-bundle and break every
        // script on the page. Also avoids replace()'s "$" substitution rules.
        const bodyAt = html.lastIndexOf('</body>');
        const out = bodyAt !== -1
          ? html.slice(0, bodyAt) + inject + html.slice(bodyAt)
          : html + inject;
        // `started` no longer flips here — see registerAliveConnection()'s
        // comment. This request only proves the HTML was served, not that a
        // live tab is behind it (this same GET is also what a plain HTTP
        // client, e.g. curl or this file's own test helpers, sends).
        // no-store: the page embeds a snapshot of the client runtime AND the
        // file's lines/mtime — a cached copy is stale code + a guaranteed
        // mtime conflict after any external edit.
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        return res.end(out);
      }

      if (req.method === 'POST' && url.pathname === '/api/render') {
        const { fileId, content } = await readJson(req);
        const file = absFiles[fileId];
        if (!file) return send(res, 404, { error: 'unknown file' });
        const { parts, blocks, drawioRefs } = await renderMarkdown(content, file, { editMode: true });
        // Refs only — NOT any client's baseline. See trackDrawioRefs()'s own
        // comment: the client has not yet decided whether it can apply this.
        trackDrawioRefs(fileId, drawioRefs);
        return send(res, 200, { parts, blocks });
      }

      if (req.method === 'POST' && url.pathname === '/api/save') {
        const { fileId, content, baseMtimeMs } = await readJson(req);
        const file = absFiles[fileId];
        if (!file) return send(res, 404, { error: 'unknown file' });
        // baseMtimeMs is REQUIRED, not optional: skipping the compare when
        // it's missing would let a stale editor tab silently clobber a
        // newer on-disk edit (the whole point of the mtime guard).
        if (baseMtimeMs === undefined || baseMtimeMs === null) {
          return send(res, 400, { error: 'baseMtimeMs is required' });
        }
        const cur = fs.statSync(file).mtimeMs;
        if (cur !== baseMtimeMs) {
          return send(res, 409, { error: 'mtime-conflict', mtimeMs: cur });
        }
        const tmp = file + '.md2doc-tmp';
        fs.writeFileSync(tmp, content, 'utf8');
        fs.renameSync(tmp, file);
        return send(res, 200, { mtimeMs: fs.statSync(file).mtimeMs });
      }

      // v3.1.0 追加 3: the image-drop / image-paste asset endpoint. Writes ONE
      // raster image next to the document under `assets/` and answers with the
      // relative markdown path the client then inserts as source.
      //
      // Six guards, none of them optional:
      //   0. '/api/asset' is in STATE_CHANGING_POST_PATHS above (the CSRF
      //      content-type gate). Without it this is a world-writable file
      //      drop for any page in the user's browser.
      //   1. fileId is type-checked. `/api/save`'s `!file` guard alone lets
      //      `fileId: "length"` through (absFiles.length is a number, so the
      //      lookup succeeds); Number.isInteger + a range check does not.
      //   2. An explicit 8 MB readJson limit, not the 50 MB default.
      //   3. The extension comes ONLY from the MIME whitelist (extFor); a
      //      caller-supplied 'x.html' can never become the name on disk.
      //   4. assets/ is created here — nothing else in this server creates
      //      directories, so the first drop would otherwise be a guaranteed
      //      ENOENT 500.
      //   5. The string-level isWithin() check is followed by a realpath
      //      re-check (a literal comparison cannot see a symlinked assets/,
      //      and writeFileSync FOLLOWS symlinks), and the file itself is
      //      opened 'wx' — which refuses to follow an existing symlink AND
      //      closes uniqueName()'s check-then-write TOCTOU window.
      if (req.method === 'POST' && url.pathname === '/api/asset') {
        const body = await readJson(req, 8 * 1024 * 1024);
        const fileId = body ? body.fileId : undefined;
        if (!Number.isInteger(fileId) || fileId < 0 || fileId >= absFiles.length) {
          return send(res, 400, { error: 'fileId must be an index into the open file list' });
        }
        const file = absFiles[fileId];
        const b64 = typeof body.data === 'string' ? body.data : '';
        const buf = Buffer.from(b64, 'base64');
        if (buf.length === 0) return send(res, 400, { error: 'empty image payload' });

        // v3.4.1: two gates, not one widened whitelist.
        //
        // The raster gate is `extFor(body.mime)` and it is unchanged --
        // `image/svg+xml` stays out for the reason asset.js documents (an SVG
        // can carry <script>, and a MIME string is attacker-controlled).
        //
        // The drawio gate below exists because that first gate CANNOT answer
        // for .drawio at all: browsers report `file.type === ''` for it, so
        // v3.4.0 shipped a renderer that embeds `.drawio`/`.xml` and an insert
        // path that answered every such upload with 'unsupported image type'.
        //
        // Its rule is the half that makes it safe: the EXTENSION picks the
        // candidate and the CONTENT decides whether anything is written. The
        // extension is matched against two literals and the stored value is
        // taken from this table rather than from the name, so no casing,
        // Unicode lookalike or double-extension in an attacker-supplied
        // filename can become the extension on disk. A payload renamed to
        // .xml is refused unless drawio's own parser recognises a root it
        // writes (<mxfile> or <mxGraphModel>).
        const DRAWIO_EXT = { '.drawio': '.drawio', '.xml': '.xml' };
        let ext = assetLib.extFor(body.mime);
        if (!ext) {
          const rawName = String(body.name === null || body.name === undefined ? '' : body.name);
          const m = /\.(drawio|xml)$/i.exec(rawName);
          const candidate = m ? DRAWIO_EXT['.' + m[1].toLowerCase()] : null;
          if (!candidate) return send(res, 400, { error: 'unsupported image type' });
          // `buf` is what lands on disk, so `buf` is what gets checked --
          // never a re-decode of `body.data`, which could differ.
          if (!drawioLib.isDrawioXml(buf.toString('utf8'))) {
            return send(res, 400, {
              error: 'refused: this file is not a draw.io diagram (no <mxfile> or <mxGraphModel> root)',
            });
          }
          ext = candidate;
        }

        const baseDir = path.dirname(file);
        const assetsDir = path.join(baseDir, 'assets');
        fs.mkdirSync(assetsDir, { recursive: true });
        let existing;
        try { existing = fs.readdirSync(assetsDir); } catch (e) { existing = []; }

        // Ruling 10: the candidate is composed as a FULL filename before
        // uniqueName sees it. `existing` is a raw readdir listing whose
        // entries carry extensions, so a bare stem could never match one —
        // a second same-named image would sail past collision detection and
        // then hit the 'wx' flag as a hard EEXIST instead of becoming -2.
        //
        // The comparison is CASE-FOLDED, because the write below is not.
        // macOS and Windows are both supported targets (it is why
        // sanitizeName defends '\\' and ':'), and their filesystems are
        // case-insensitive: `existing.indexOf('Shot.png')` misses an on-disk
        // `shot.png`, so no '-2' is generated, open(..., 'wx') returns EEXIST
        // and the user gets a generic 「圖片上傳失敗」 that repeats identically
        // on every retry. asset.js is reviewed and unchanged — the numbering
        // is still entirely its own; only the SPACE the question is asked in
        // moves. The user's original stem casing is then restored, so a
        // dropped `Shot.png` is still written as `Shot.png`.
        const stem = assetLib.sanitizeName(body.name);
        const desiredLower = (stem + ext).toLowerCase();
        const pickedLower = assetLib.uniqueName(
          desiredLower, existing.map((e) => String(e).toLowerCase()));
        let name;
        if (pickedLower === desiredLower) {
          name = stem + ext;
        } else {
          // uniqueName only ever inserts '-<n>' immediately before the
          // extension, so that suffix is what is lifted back across. Matched
          // rather than sliced by length: toLowerCase() is not guaranteed to
          // preserve length for every code point.
          const m = /(-\d+)$/.exec(pickedLower.slice(0, pickedLower.length - ext.length));
          name = stem + (m ? m[1] : '') + ext;
        }
        const target = path.join(assetsDir, name);
        if (!assetLib.isWithin(toPosixPath(assetsDir), toPosixPath(target))) {
          return send(res, 400, { error: 'refused: asset path escapes the assets directory' });
        }
        // Second boundary, against the filesystem rather than the string: a
        // pre-existing `assets` SYMLINK pointing anywhere at all passes the
        // check above unchanged, because that check only ever saw text.
        let realBase, realAssets;
        try {
          realBase = fs.realpathSync(baseDir);
          realAssets = fs.realpathSync(assetsDir);
        } catch (e) {
          return send(res, 500, { error: 'cannot resolve the assets directory' });
        }
        if (!assetLib.isWithin(toPosixPath(realBase), toPosixPath(realAssets))) {
          return send(res, 400, { error: 'refused: assets directory escapes the document directory' });
        }
        try {
          fs.writeFileSync(path.join(realAssets, name), buf, { flag: 'wx' });
        } catch (e) {
          if (e && e.code === 'EEXIST') {
            return send(res, 409, { error: 'asset already exists: ' + name });
          }
          throw e;
        }
        return send(res, 200, { name, path: assetLib.relPath(name) });
      }

      // v3.6.0: the liveness stream. A GET (EventSource cannot send any other
      // method), held open for as long as the tab exists. fileId/clientId are
      // read here purely so a future diagnostic has them to hand — see
      // registerAliveConnection()'s own comment for why nothing about
      // whether the session stays alive depends on either one being
      // well-formed; the response object's own identity is the only thing
      // the closing decision is keyed on, deliberately, the same way
      // drawioClients above is keyed on a validated pair while THIS map does
      // not need one at all.
      if (req.method === 'GET' && url.pathname === '/api/alive') {
        const aliveFileId = Number(url.searchParams.get('fileId'));
        const aliveClientId = url.searchParams.get('clientId');
        registerAliveConnection(server, res, aliveFileId, aliveClientId);
        return; // response intentionally stays open — nothing more to send
      }

      if (req.method === 'POST' && url.pathname === '/api/ping') {
        // v3.4.0 batch2 Task 6: fileId / drawioClientId / drawioAck are NEW,
        // all optional, on the body this heartbeat already sent every 10s
        // (old clients / the existing test in test/editor-server.test.js send
        // `{}` — that still resolves to "no tracked state", the same
        // zero-cost 204 as before). A body that fails to parse degrades the
        // same way: no staleness check, plain 204 — a malformed ping body
        // must never be the thing that breaks the drawio-staleness contract.
        // v3.6.0: this route no longer has any bearing on whether the
        // session stays alive — see GET /api/alive above for that. It is
        // kept exactly as it was for the ONE job it still does: the drawio
        // staleness heartbeat below.
        //
        // Fix round 1 (review F8): an explicit 8 KB readJson limit, not the
        // 50 MB default — the same precedent /api/save set for its own body,
        // for the same reason. This body is always three short scalars, and
        // this is the ONE route that fires unconditionally every 10 seconds
        // from every open tab; it has no business also being the most
        // permissive one in the server.
        let fileId, drawioClientId, drawioAck;
        try {
          const body = await readJson(req, 8 * 1024);
          if (body) {
            fileId = body.fileId;
            drawioClientId = body.drawioClientId;
            drawioAck = body.drawioAck;
          }
        } catch (e) {
          fileId = undefined; drawioClientId = undefined; drawioAck = undefined;
        }
        // Ack FIRST, then re-check: a client that has just confirmed it
        // applied version N must get a 204 on this same beat unless the file
        // has moved on past N since.
        touchDrawioClient(fileId, drawioClientId);
        ackDrawioApplied(fileId, drawioClientId, drawioAck);
        const staleToken = checkDrawioStale(fileId, drawioClientId);
        if (staleToken) {
          return send(res, 200, { stale: true, token: staleToken });
        }
        res.writeHead(204);
        return res.end();
      }

      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 500, { error: String((e && e.message) || e) });
    }
  });

  // EADDRINUSE (or any other listen-time error, e.g. a pinned --port that's
  // already taken) previously fired as an uncaught 'error' event on `server`
  // with nothing listening, since a plain `server.listen(..., resolve)`
  // Promise never rejects — it only ever resolves on the 'listening' event.
  // That crashed the whole process, bypassing bin's `.catch`. Listen for
  // 'error' too and reject the promise so the caller gets a normal rejection.
  await new Promise((resolve, reject) => {
    function onError(err) {
      server.removeListener('listening', onListening);
      reject(err);
    }
    function onListening() {
      server.removeListener('error', onError);
      resolve();
    }
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(listenPort, '127.0.0.1');
  });
  const port = server.address().port;

  // F13: counts from listen (this point), not from process start — listen
  // is the moment a client could first reach the server, and that is the
  // deadline this timer is measuring against. Unref'd like shutdownGraceTimer,
  // and for the same reason: the listening socket (or, once one exists, an
  // open /api/alive connection) is what should keep the process alive, not
  // this timer. A timer that held a ref would keep the process up on its own
  // even if the socket already went away, which is backwards for a clock
  // whose only job is to give up and exit.
  neverOpenedTimer = setTimeout(() => {
    // The guard against closing a session that has already been opened —
    // this timer is armed once, at listen time, and left to run; it is not
    // cancelled by GET /api/alive registering a connection. Whether a live
    // connection was ever established by the time the deadline arrives is
    // decided here, by reading `started` fresh at fire time (registerAliveConnection()
    // is the only place that sets it — see its own comment). Proven
    // load-bearing by mutation: with this line removed, an actively-connected
    // session still gets closed the moment this deadline passes (see
    // test/cli-edit.test.js's "must survive the never-opened grace deadline"
    // case).
    if (started) return;
    shutdownOnce(server, 'never-opened');
  }, neverOpenedGraceMs);
  if (neverOpenedTimer.unref) neverOpenedTimer.unref();

  return {
    server,
    port,
    urlFor(absPath) {
      const i = absFiles.indexOf(path.resolve(absPath));
      return i === -1 ? null : `http://127.0.0.1:${port}/edit/${i}`;
    },
    close() {
      if (neverOpenedTimer) clearTimeout(neverOpenedTimer);
      shutdownOnce(server, null);
    },
  };
}

module.exports = { createEditorServer, assertBlockRangesFit };
