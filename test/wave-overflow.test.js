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
  assert.strictEqual(r.stderr, 'md2doc: ' + md + ': wavedrom #1: 1 data label is wider than its segment ' +
    '("FFFFFFFFFFFF" in d); set config.hscale to 2 (estimated)\n');
  assert.ok(fs.existsSync(html));
});

// Final review M1: one line per diagram, never one per label — two lines for one diagram
// said "set to 2" and then "set to 4", and following the first was not enough.
const TWO_DIAGRAMS = '# t\n\n```wavedrom\n' +
  '{ signal: [{ name: \'d\', wave: \'x.3.x3x\', data: [\'FFFFFFFFFFFF\', \'D2 (client FCS last 4B)\'] },' +
  ' { name: \'e\', wave: \'x3x\', data: [\'GGGGGGGGGGGG\'] }] }\n```\n\n' +
  '```wavedrom\n{ signal: [{ name: \'f\', wave: \'x333x.\', data: [\'D0\'] }] }\n```\n\n' +
  '```wavedrom\n{ signal: [{ name: \'g\', wave: \'x3x\', data: [\'FFFFFFFFFFFF\'] }] }\n```\n';
check('CLI: one warning line per diagram, naming the largest scale and the count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-'));
  const md = path.join(dir, 'c.md');
  fs.writeFileSync(md, TWO_DIAGRAMS);
  const r = spawnSync(process.execPath, [LIB, md, path.join(dir, 'c.html')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const lines = r.stderr.split('\n').filter(Boolean);
  assert.deepStrictEqual(lines, [
    'md2doc: ' + md + ': wavedrom #1: 3 data labels are wider than their segments ' +
      '(worst: "D2 (client FCS last 4B)" in d); set config.hscale to 4 (estimated)',
    'md2doc: ' + md + ': wavedrom #3: 1 data label is wider than its segment ' +
      '("FFFFFFFFFFFF" in g); set config.hscale to 3 (estimated)',
  ], r.stderr);
});

// Final review M1: bin/md2doc.js renders each format in its own child process, and every
// child used to print the warnings, so --html --pdf printed each line twice.
check('CLI (bin): --html --pdf prints each warning once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-'));
  const md = path.join(dir, 'd.md');
  fs.writeFileSync(md, TWO_DIAGRAMS);
  const BIN = path.join(__dirname, '..', 'bin', 'md2doc.js');
  const r = spawnSync(process.execPath, [BIN, md, '--html', '--pdf', '--no-open', '--out', dir + path.sep],
    { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'd.html')) && fs.existsSync(path.join(dir, 'd.pdf')), 'guard: both formats written');
  const lines = r.stderr.split('\n').filter((l) => l.includes('wider than'));
  assert.strictEqual(lines.length, 2, 'two overflowing diagrams, two lines: ' + r.stderr);
  assert.ok(lines[0].includes('wavedrom #1:') && lines[1].includes('wavedrom #3:'), r.stderr);
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
