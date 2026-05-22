#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const BIN = path.join(REPO, 'bin', 'md2doc.js');
const VERSION = require(path.join(REPO, 'package.json')).version;

function run(args, opts = {}) {
    return spawnSync(process.execPath, [BIN, ...args], {
        cwd: opts.cwd || REPO,
        encoding: 'utf8',
        env: { ...process.env, ...(opts.env || {}) },
    });
}

// --- Task 1: --help and --version ---
{
    const r = run(['--version']);
    assert.strictEqual(r.status, 0, '--version exits 0');
    assert.strictEqual(r.stdout.trim(), VERSION, '--version prints package version');
}
{
    const r = run(['-v']);
    assert.strictEqual(r.status, 0, '-v exits 0');
    assert.strictEqual(r.stdout.trim(), VERSION, '-v prints package version');
}
{
    const r = run(['--help']);
    assert.strictEqual(r.status, 0, '--help exits 0');
    assert.match(r.stdout, /md2doc/, '--help mentions md2doc');
    assert.match(r.stdout, /--html/, '--help mentions --html');
    assert.match(r.stdout, /--pdf/, '--help mentions --pdf');
    assert.match(r.stdout, /--out/, '--help mentions --out');
    assert.match(r.stdout, /--open/, '--help mentions --open');
}
{
    const r = run(['-h']);
    assert.strictEqual(r.status, 0, '-h exits 0');
    assert.match(r.stdout, /md2doc/, '-h prints help');
}
{
    const r = run([]);
    assert.strictEqual(r.status, 2, 'no args exits 2');
    assert.match(r.stderr, /no input/i, 'no args explains missing input');
}

console.log('Task 1 — help / version OK');
