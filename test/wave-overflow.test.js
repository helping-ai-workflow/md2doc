#!/usr/bin/env node
'use strict';

// Label-width estimate + overflow detector (lib/wave-overflow.js) and the CLI
// stderr warning built on it. Plan: wave-redesign P1 Task 3.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const W = require('../lib/wave-overflow.js');

const LIB = path.join(__dirname, '..', 'lib', 'md2doc.js');
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function doc(wave, data, hscale) {
  return { signal: [{ name: 'd', wave, data }], config: { hscale } };
}

check('estimateTextWidth: measured reader widths', () => {
  assert.ok(Math.abs(W.estimateTextWidth('FFFFFFFFFFFF') - 107) <= 1.5);
  assert.ok(Math.abs(W.estimateTextWidth('D2 (client FCS last 4B)') - 149) <= 2);
  assert.strictEqual(W.estimateTextWidth('', 14.6667), 0);
  // non-ASCII counts one em
  assert.ok(Math.abs(W.estimateTextWidth('中', 10) - 10) < 1e-9);
});

check('overflowOf: 12 F in a 2-cycle segment needs scale 2', () => {
  const r = W.overflowOf(doc('x.3.x..', ['FFFFFFFFFFFF'], 1));
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].needScale, 2);
  assert.strictEqual(r[0].cells, 2);
  assert.strictEqual(r[0].label, 'FFFFFFFFFFFF');
  assert.strictEqual(r[0].name, 'd');
  assert.strictEqual(r[0].laneIndex, 0);
  assert.strictEqual(r[0].slot, 0);
});

check('overflowOf: long label in a 1-cycle segment needs scale 4', () => {
  const r = W.overflowOf(doc('x333x.', ['D2 (client FCS last 4B)'], 1));
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].needScale, 4);
});

check('overflowOf: short label fits', () => {
  assert.deepStrictEqual(W.overflowOf(doc('x333x.', ['D0'], 1)), []);
});

check('overflowOf: hscale and period widen the segment', () => {
  assert.deepStrictEqual(W.overflowOf(doc('x.3.x..', ['FFFFFFFFFFFF'], 2)), []);
  const d = doc('x.3.x..', ['FFFFFFFFFFFF'], 1);
  d.signal[0].period = 2;
  assert.deepStrictEqual(W.overflowOf(d), []);
});

check('suggestScale', () => {
  assert.strictEqual(W.suggestScale([{ needScale: 2 }, { needScale: 4 }]), 4);
  assert.strictEqual(W.suggestScale([], 3), 3);
});

check('CLI: warns on stderr, exit 0, html unchanged by warning', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-'));
  const md = path.join(dir, 'a.md');
  const html = path.join(dir, 'a.html');
  fs.writeFileSync(md, '# t\n\n```wavedrom\n{ signal: [{ name: \'d\', wave: \'x.3.x..\', data: [\'FFFFFFFFFFFF\'] }] }\n```\n');
  const r = spawnSync(process.execPath, [LIB, md, html], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stderr.includes('set config.hscale to 2 (estimated)'), r.stderr);
  assert.ok(r.stderr.includes('wavedrom #1: "FFFFFFFFFFFF" in d is wider than its 2-cycle segment'), r.stderr);
  assert.ok(fs.existsSync(html));
});

check('CLI: no warning when labels fit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-'));
  const md = path.join(dir, 'b.md');
  fs.writeFileSync(md, '```wavedrom\n{ signal: [{ name: \'d\', wave: \'x333x.\', data: [\'D0\'] }] }\n```\n');
  const r = spawnSync(process.execPath, [LIB, md, path.join(dir, 'b.html')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!r.stderr.includes('wider than'), r.stderr);
});

(async () => {
  let failed = 0;
  for (const c of checks) {
    try { await c.fn(); console.log('ok   ' + c.name); }
    catch (e) { failed++; console.log('FAIL ' + c.name + '\n     ' + (e && e.message)); }
  }
  if (failed) { console.log(failed + ' failed'); process.exit(1); }
  console.log('wave-overflow: ' + checks.length + ' checks PASS');
})();
