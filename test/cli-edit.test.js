'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
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

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls `predicateFn` instead of sleeping a fixed interval and hoping —
// the pattern this file uses to wait on a real process/state change.
// (waitForExit below drives the same principle a different way, off the
// child's 'exit' event rather than polling.)
function waitFor(predicateFn, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      const v = predicateFn();
      if (v) { clearInterval(iv); resolve(v); }
      else if (Date.now() - start > timeoutMs) {
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
// process (bypassing bin/md2doc.js, which has no flag for idleTimeoutMs /
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

  // (a) tab closed: after the page is opened once and then goes silent (no
  // more /api/ping), the idle timer closes the session and prints its line.
  {
    const { child, state } = spawnDirect([a], { idleTimeoutMs: 900, neverOpenedGraceMs: 60000 });
    const url = await waitForUrl(state, 15000);
    const page = await get(url); // marks started=true, arms the idle timer
    assert.strictEqual(page.status, 200);

    // Send nothing further — this is the "tab closed" simulation: no more
    // pings arrive, exactly like a real closed tab.
    const { code, signal } = await waitForExit(child, 9000);
    assert.strictEqual(code, 0, '(a) idle exit: process exits 0 (got signal=' + signal + ')');
    assert.ok(state.out.includes('md2doc: no browser activity for a while — closing this editor session.'),
      '(a) idle-close must print its own line — got stdout: ' + JSON.stringify(state.out));
  }

  // (c) a session whose URL is never opened ends on its own after the grace
  // period — the predicate under test is server.js's neverOpenedTimer
  // callback actually closing the server when `started` is still false.
  {
    const { child, state } = spawnDirect([b], { neverOpenedGraceMs: 900, idleTimeoutMs: 60000 });
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

  // Ruling T17-1 / T17-2: a session that IS opened — even after a delay
  // longer than idleTimeoutMs itself — must not be killed by the
  // never-opened grace timer, including while that timer's own deadline
  // passes during ongoing activity. Only once activity actually stops does
  // the (separate) idle path take over. This is the red/green test for the
  // `if (started) return` guard inside neverOpenedTimer's callback: remove
  // that guard and this session is killed with the wrong reason (or at the
  // wrong time) while still being actively pinged.
  {
    const { child, state } = spawnDirect([c], { neverOpenedGraceMs: 1200, idleTimeoutMs: 1000 });
    const url = await waitForUrl(state, 15000);

    await sleepMs(500); // a delay past what a 30s-style idle clock would forgive
    const page = await get(url); // opens the session, well inside the 1200ms grace
    assert.strictEqual(page.status, 200);
    assert.strictEqual(child.exitCode, null, 'must still be alive right after opening');

    // Keep the session active with a ping cadence tighter than
    // idleTimeoutMs, running well past the neverOpenedGraceMs deadline
    // (500ms open + 3*300ms = 1400ms > 1200ms grace).
    for (let i = 0; i < 3; i++) {
      await sleepMs(300);
      await ping(url);
      assert.strictEqual(child.exitCode, null,
        'must survive the never-opened grace deadline while actively pinged (iteration ' + i + ')');
    }

    // Stop pinging; the idle path (not the never-opened path) should now
    // close the session.
    const { code, signal } = await waitForExit(child, 9000);
    assert.strictEqual(code, 0, 'post-activity idle exit: process exits 0 (got signal=' + signal + ')');
    assert.ok(state.out.includes('md2doc: no browser activity for a while — closing this editor session.'),
      'an opened-then-idle session must close via the idle line, not the never-opened line — got stdout: ' +
      JSON.stringify(state.out));
    assert.ok(!state.out.includes('the editor link was never opened'),
      'an opened session must never print the never-opened line — got stdout: ' + JSON.stringify(state.out));
  }

  console.log('cli-edit.test.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
