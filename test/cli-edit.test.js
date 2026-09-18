'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');

const BIN = path.resolve(__dirname, '..', 'bin', 'md2doc.js');
const CLI_PATH = path.resolve(__dirname, '..', 'lib', 'editor', 'cli.js');

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    }).on('error', reject);
  });
}

// Mirrors the real client's POST /api/ping (content-type: application/json,
// a non-empty body) — see lib/editor/client.js's setInterval(..., 10000).
// v3.6.0: this heartbeat no longer has any bearing on whether the session
// stays alive (see openAlive() below for the mechanism that now does) — kept
// only for the one thing it still does, the drawio staleness check.
function ping(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request(
      { host: u.hostname, port: u.port, method: 'POST', path: '/api/ping',
        headers: { 'content-type': 'application/json' } },
      (res) => { res.resume(); res.on('end', resolve); });
    r.on('error', reject);
    r.end('{}');
  });
}

// Mirrors the real client's EventSource('/api/alive?...') — a GET whose
// response headers arrive and then never ends. Resolves once the connection
// is open (headers received); `.close()` aborts the underlying socket, the
// same thing a closed/navigated-away tab (or a page.reload()'s old
// connection) does on the wire. This — not the ping above — is what
// server.js now treats as "the tab is here".
function openAlive(url, clientId) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const fileId = u.pathname.match(/\/edit\/(\d+)/)[1];
    const r = http.request(
      { host: u.hostname, port: u.port, method: 'GET',
        path: '/api/alive?fileId=' + fileId + '&clientId=' + encodeURIComponent(clientId) },
      (res) => {
        res.on('data', () => {}); // drain keepalive comments
        resolve({ status: res.statusCode, close: () => req.destroy() });
      });
    r.on('error', reject);
    const req = r;
    r.end();
  });
}

// Pulls this tab's drawioClientId (reused as the /api/alive client id — see
// client.js's EventSource call site) out of a fetched edit page's body.
function clientIdOf(pageBody) {
  const m = /window\.__ED__ = (\{[\s\S]*?\})<\/script>/.exec(pageBody);
  const ed = JSON.parse(m[1].replace(/\\u003c/g, '<'));
  return ed.drawioClientId;
}

// T21 item 3: opens a TCP connection to the server and sends nothing on it —
// what a browser handed the edit URL does when it warms a connection it may
// never use. Such a socket is not one `server.close()` retires on its own, so
// it is the shape that made `md2doc --edit doc.md` print its interrupt line
// and then sit there. Driven directly against the shipped CLI before the fix:
// SIGINT, still alive 10 s later, 3 runs of 3.
function openBareSocket(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(u.port), u.hostname, () => resolve(sock));
    sock.on('error', reject);
  });
}

function countInterruptLines(out) {
  return out.split('md2doc: interrupted — closing this editor session.').length - 1;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls `predicateFn` instead of sleeping a fixed interval and hoping —
// the pattern this file uses to wait on a real process/state change.
// (waitForExit below drives the same principle a different way, off the
// child's 'exit' event rather than polling.)
function waitFor(predicateFn, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    // Monotonic, never `Date.now()`: this is an elapsed time, and wall-clock is
    // adjusted under a running process (NTP, a VM resuming, a host waking from
    // suspend). A jump forward makes this give up on a child process that was
    // answering perfectly well, and the failure it reports — "timeout waiting
    // for …" — names the wrong cause. MEASURED on this branch in the journey
    // suite, where the same mistake produced a mouse press of **-6341ms**.
    const start = performance.now();
    const iv = setInterval(() => {
      const v = predicateFn();
      if (v) { clearInterval(iv); resolve(v); }
      else if (performance.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error('timeout waiting for: ' + label));
      }
    }, 50);
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error('process did not exit within ' + timeoutMs + 'ms')), timeoutMs);
    child.on('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal }); });
  });
}

// Spawns lib/editor/cli.js's startEditSession() directly in a fresh child
// process (bypassing bin/md2doc.js, which has no flag for connectionGraceMs /
// neverOpenedGraceMs). A fresh process is required, not an in-process call:
// startEditSession() ends by calling process.exit(0), which would kill this
// test runner if called in-process.
function spawnDirect(files, extraOpts) {
  const opts = Object.assign({ files, open: false }, extraOpts);
  const script =
    `const { startEditSession } = require(${JSON.stringify(CLI_PATH)});\n` +
    `startEditSession(${JSON.stringify(opts)}).catch((e) => { console.error(e); process.exit(1); });\n`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const state = { out: '' };
  child.stdout.on('data', (c) => { state.out += c; });
  return { child, state };
}

async function waitForUrl(state, timeoutMs) {
  await waitFor(() => /http:\/\/127\.0\.0\.1:\d+\/edit\/\d+/.test(state.out), timeoutMs, 'edit URL on stdout');
  return state.out.match(/http:\/\/127\.0\.0\.1:\d+\/edit\/\d+/)[0];
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-cli-edit-'));
  const a = path.join(dir, 'a.md');
  const b = path.join(dir, 'b.md');
  const c = path.join(dir, 'c.md');
  fs.writeFileSync(a, '# A\n');
  fs.writeFileSync(b, '# B\n');
  fs.writeFileSync(c, '# C\n');

  // flag conflicts
  for (const bad of [['--edit', a, '--pdf'], ['--edit', a, '--out', 'x.html'],
                     ['--edit', a, '--bake-svg'], ['--edit', dir]]) {
    const r = spawnSync(process.execPath, [BIN, ...bad], { encoding: 'utf8' });
    assert.strictEqual(r.status, 2, `expected exit 2 for: ${bad.join(' ')}`);
  }

  // happy path + (b) SIGINT prints its own line and exits 0
  {
    const child = spawn(process.execPath, [BIN, '--edit', a, b, '--no-open'],
      { stdio: ['ignore', 'pipe', 'inherit'] });
    const state = { out: '' };
    child.stdout.on('data', (c) => { state.out += c; });
    await waitFor(() => {
      const m = state.out.match(/http:\/\/127\.0\.0\.1:\d+\/edit\/\d+/g);
      return m && m.length >= 2 ? m.slice(0, 2) : null;
    }, 15000, 'two edit URLs on stdout');
    const urls = state.out.match(/http:\/\/127\.0\.0\.1:\d+\/edit\/\d+/g).slice(0, 2);
    const p0 = await get(urls[0]);
    assert.strictEqual(p0.status, 200);
    assert.ok(p0.body.includes('window.__ED__'));
    const p1 = await get(urls[1]);
    assert.ok(p1.body.includes('window.__ED__'));

    child.kill('SIGINT');
    const { code, signal } = await waitForExit(child, 10000);
    assert.strictEqual(code, 0, 'SIGINT exit: process exits 0, not signal-killed (got signal=' + signal + ')');
    assert.ok(state.out.includes('md2doc: interrupted — closing this editor session.'),
      '(b) SIGINT must print its own line — got stdout: ' + JSON.stringify(state.out));
  }

  // (a) tab closed: the page is opened and its /api/alive connection is
  // established (the real browser flow — client.js opens the EventSource
  // right after running), then that connection drops and nothing replaces
  // it. This is THE reported defect, exercised end to end through a real
  // spawned process: the session must close, via the connection dropping —
  // not via a ping stopping, which no longer means anything (v3.6.0).
  {
    const { child, state } = spawnDirect([a], { connectionGraceMs: 150, neverOpenedGraceMs: 60000 });
    const url = await waitForUrl(state, 15000);
    const page = await get(url);
    assert.strictEqual(page.status, 200);
    const conn = await openAlive(url, clientIdOf(page.body));
    assert.strictEqual(conn.status, 200, '(a) precondition: /api/alive must accept the connection');

    // The connection drops — exactly what a closed tab (or a crashed
    // browser) does — and nothing reconnects.
    conn.close();

    const { code, signal } = await waitForExit(child, 9000);
    assert.strictEqual(code, 0, '(a) idle exit: process exits 0 (got signal=' + signal + ')');
    assert.ok(state.out.includes('md2doc: no browser activity for a while — closing this editor session.'),
      '(a) idle-close must print its own line — got stdout: ' + JSON.stringify(state.out));
  }

  // (c) a session whose URL is never opened ends on its own after the grace
  // period — the predicate under test is server.js's neverOpenedTimer
  // callback actually closing the server when `started` is still false.
  {
    const { child, state } = spawnDirect([b], { neverOpenedGraceMs: 900, connectionGraceMs: 60000 });
    await waitForUrl(state, 15000);
    // Never GET the URL at all.

    await sleepMs(400); // comfortably before the 900ms grace deadline
    assert.strictEqual(child.exitCode, null,
      '(c) must still be alive before the never-opened grace period elapses');

    const { code, signal } = await waitForExit(child, 9000);
    assert.strictEqual(code, 0, '(c) never-opened exit: process exits 0 (got signal=' + signal + ')');
    assert.ok(state.out.includes('md2doc: the editor link was never opened — closing this editor session.'),
      '(c) never-opened close must print its own line — got stdout: ' + JSON.stringify(state.out));
  }

  // (c2) v3.6.0: the page being GET-requested is no longer enough to count
  // as "opened" — only a live /api/alive connection is (see
  // registerAliveConnection()'s own comment in server.js on why that
  // boundary moved). A raw HTTP client (this test, or any tool that fetches
  // the HTML but never runs client.js's EventSource) must still be closed by
  // the never-opened deadline, exactly as if the URL had never been fetched
  // at all.
  {
    const { child, state } = spawnDirect([c], { neverOpenedGraceMs: 900, connectionGraceMs: 60000 });
    const url = await waitForUrl(state, 15000);
    const page = await get(url); // HTML fetched, but no /api/alive connection ever follows
    assert.strictEqual(page.status, 200);

    const { code, signal } = await waitForExit(child, 9000);
    assert.strictEqual(code, 0, '(c2) never-opened exit despite a plain GET: process exits 0 (got signal=' + signal + ')');
    assert.ok(state.out.includes('md2doc: the editor link was never opened — closing this editor session.'),
      '(c2) a GET with no /api/alive connection must still close via the never-opened line — got stdout: ' +
      JSON.stringify(state.out));
  }

  // (c3) mirror of (c2), end to end: pinging on its own — with no /api/alive
  // connection ever made — must not sustain a session forever either.
  // Pinging used to BE the liveness signal; it no longer is anything more
  // than the drawio staleness heartbeat (v3.6.0).
  {
    const { child, state } = spawnDirect([a], { neverOpenedGraceMs: 300, connectionGraceMs: 60000 });
    const url = await waitForUrl(state, 15000);
    await get(url);
    const pingIv = setInterval(() => { ping(url).catch(() => {}); }, 80);

    const { code, signal } = await waitForExit(child, 9000);
    clearInterval(pingIv);
    assert.strictEqual(code, 0, '(c3) never-opened exit despite ongoing pings: process exits 0 (got signal=' + signal + ')');
    assert.ok(state.out.includes('md2doc: the editor link was never opened — closing this editor session.'),
      '(c3) pinging alone must not keep a session alive — got stdout: ' + JSON.stringify(state.out));
  }

  // Ruling T17-1 / T17-2: a session that IS opened — even after a delay, and
  // even while its own /api/alive connection stays open PAST the
  // never-opened grace deadline — must not be killed by the never-opened
  // timer. Only once the connection actually drops does the (separate)
  // connection-grace path take over. This is the red/green test for the
  // `if (started) return` guard inside neverOpenedTimer's callback: remove
  // that guard and this session is killed with the wrong reason (or at the
  // wrong time) while its connection is still very much open.
  {
    const { child, state } = spawnDirect([c], { neverOpenedGraceMs: 1200, connectionGraceMs: 1000 });
    const url = await waitForUrl(state, 15000);

    await sleepMs(500); // a delay past what a fast idle-style clock would forgive
    const page = await get(url);
    assert.strictEqual(page.status, 200);
    const conn = await openAlive(url, clientIdOf(page.body)); // opens the session, well inside the 1200ms grace
    assert.strictEqual(conn.status, 200);
    assert.strictEqual(child.exitCode, null, 'must still be alive right after opening');

    // Hold the connection open well past the neverOpenedGraceMs deadline
    // (500ms open + 900ms held = 1400ms > 1200ms grace) without ever pinging
    // — pinging is no longer what liveness is measured by (v3.6.0).
    await sleepMs(900);
    assert.strictEqual(child.exitCode, null,
      'must survive the never-opened grace deadline while its /api/alive connection is still open');

    // Now drop the connection; the connection-grace path (not the
    // never-opened path) should close the session.
    conn.close();
    const { code, signal } = await waitForExit(child, 9000);
    assert.strictEqual(code, 0, 'post-activity idle exit: process exits 0 (got signal=' + signal + ')');
    assert.ok(state.out.includes('md2doc: no browser activity for a while — closing this editor session.'),
      'an opened-then-disconnected session must close via the idle line, not the never-opened line — got stdout: ' +
      JSON.stringify(state.out));
    assert.ok(!state.out.includes('the editor link was never opened'),
      'an opened session must never print the never-opened line — got stdout: ' + JSON.stringify(state.out));
  }

  // (e) T21 item 3: SIGINT must exit even when a socket is open that has
  // never carried a request. This is the whole of the reported defect — the
  // interrupt line printed and the process stayed — and the reason
  // `--no-open` looked innocent is that nothing had opened such a socket in
  // that run. Ablated: with shutdownServer()'s closeAllConnections() call
  // removed from lib/editor/server.js, this row fails with 'process did not
  // exit within 9000ms'.
  {
    const { child, state } = spawnDirect([a], { connectionGraceMs: 60000, neverOpenedGraceMs: 60000 });
    const url = await waitForUrl(state, 15000);
    const sock = await openBareSocket(url);

    child.kill('SIGINT');
    const { code, signal } = await waitForExit(child, 8000);
    sock.destroy();
    assert.strictEqual(code, 0,
      '(e) SIGINT with an unused-but-open socket must still exit 0 (got signal=' + signal + ')');
    assert.strictEqual(countInterruptLines(state.out), 1,
      '(e) the interrupt line must be printed exactly once — got stdout: ' + JSON.stringify(state.out));
  }

  // (f) the same unused-but-open socket against the connection-grace
  // deadline, which has no second keystroke to rescue it: a tab that was
  // opened, established its /api/alive connection and then that connection
  // dropped — while a separate warmed-but-unused socket (a browser's
  // speculative preconnect, never carrying any request at all) is ALSO still
  // open — must still close the session. Same root cause as (e), a path the
  // user cannot intervene on.
  {
    const { child, state } = spawnDirect([b], { connectionGraceMs: 150, neverOpenedGraceMs: 60000 });
    const url = await waitForUrl(state, 15000);
    const page = await get(url);
    assert.strictEqual(page.status, 200);
    const conn = await openAlive(url, clientIdOf(page.body)); // the real liveness connection
    assert.strictEqual(conn.status, 200);
    const sock = await openBareSocket(url); // an unrelated, never-used socket left lying around

    conn.close(); // the tab's actual connection drops; the bare socket does not
    const { code, signal } = await waitForExit(child, 9000);
    sock.destroy();
    assert.strictEqual(code, 0,
      '(f) idle close with an unused-but-open socket must still exit 0 (got signal=' + signal + ')');
    assert.ok(state.out.includes('md2doc: no browser activity for a while — closing this editor session.'),
      '(f) idle close must still print its own line — got stdout: ' + JSON.stringify(state.out));
  }

  // (g) Ruling T21-4: the SIGINT handler replaces Node's default action, so
  // whatever else it does, a second Ctrl+C has to remain a way out — and it
  // must not repeat the line, which is what the reported run saw twice. The
  // first close is made unable to complete on purpose (srv.close replaced
  // with a no-op after the session is up, which is exactly what the handler
  // calls), because with the (e) fix in place a first SIGINT otherwise
  // succeeds and there is nothing for a second one to rescue.
  {
    const script =
      'const { startEditSession } = require(' + JSON.stringify(CLI_PATH) + ');\n' +
      'startEditSession({ files: ' + JSON.stringify([c]) + ', open: false })\n' +
      '  .then((srv) => { srv.close = () => {}; })\n' +
      '  .catch((e) => { console.error(e); process.exit(1); });\n';
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    const state = { out: '' };
    child.stdout.on('data', (ch) => { state.out += ch; });
    await waitForUrl(state, 15000);

    try {
      child.kill('SIGINT');
      await waitFor(() => countInterruptLines(state.out) === 1, 5000, 'the first interrupt line');
      await sleepMs(600);
      assert.strictEqual(child.exitCode, null,
        '(g) precondition: with close() unable to complete, the first SIGINT must leave it running — ' +
        'otherwise this row is not measuring the second one');

      child.kill('SIGINT');
      const { code, signal } = await waitForExit(child, 8000);
      assert.strictEqual(code, 130,
        '(g) a second SIGINT must end the process itself, 130 (got code=' + code + ' signal=' + signal + ')');
      assert.strictEqual(countInterruptLines(state.out), 1,
        '(g) the second SIGINT must not reprint the line — got stdout: ' + JSON.stringify(state.out));
    } finally {
      // This child is deliberately built so that it CANNOT close its own
      // server, so a failure here leaves it running — and its stderr is
      // inherited from this process, which means anything waiting on this
      // process's pipes (a spawnSync in an ablation driver, a CI harness)
      // would wait for that child forever. Measured: an ablation run that
      // removed the handler's `interrupted = true;` hung past 300 s on
      // exactly this. The kill is unconditional; on the passing path the
      // process is already gone and it is a no-op.
      try { child.kill('SIGKILL'); } catch (e) { /* already exited */ }
    }
  }

  console.log('cli-edit.test.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
