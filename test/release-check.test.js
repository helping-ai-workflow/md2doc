#!/usr/bin/env node
'use strict';

// scripts/release-check.js — the publish workflow's gate. Tests stop running in
// publish.yml (main only receives commits whose PR checks were green, enforced by
// branch protection), so the tag job only has to prove the tag, package.json and
// CHANGELOG agree before `npm publish`.

const assert = require('assert');
const { checkRelease } = require('../scripts/release-check.js');

const CHANGELOG = [
  '# Changelog', '', 'All notable changes…', '',
  '## v3.13.0 — 2026-10-08', '', '### Added', '', '- thing', '',
  '## v3.12.1 — 2026-10-07', '',
].join('\n');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check('a tag, package.json and the top CHANGELOG heading that agree pass', () => {
  assert.deepStrictEqual(checkRelease({ tag: 'v3.13.0', pkgVersion: '3.13.0', changelog: CHANGELOG }), []);
});
check('a tag that is not the package.json version fails and names both', () => {
  const errs = checkRelease({ tag: 'v3.13.1', pkgVersion: '3.13.0', changelog: CHANGELOG });
  assert.ok(errs.some((e) => e.includes('v3.13.1') && e.includes('3.13.0')), JSON.stringify(errs));
});
check('a CHANGELOG whose top section is another version fails', () => {
  const errs = checkRelease({ tag: 'v3.12.1', pkgVersion: '3.12.1', changelog: CHANGELOG });
  assert.ok(errs.some((e) => e.includes('CHANGELOG') && e.includes('v3.13.0')), JSON.stringify(errs));
});
check('a CHANGELOG with no "## vX.Y.Z — YYYY-MM-DD" heading fails', () => {
  const errs = checkRelease({ tag: 'v3.13.0', pkgVersion: '3.13.0', changelog: '# Changelog\n\n## Unreleased\n' });
  assert.ok(errs.some((e) => e.includes('CHANGELOG')), JSON.stringify(errs));
});
check('a tag that is not vX.Y.Z fails', () => {
  const errs = checkRelease({ tag: 'release-3.13.0', pkgVersion: '3.13.0', changelog: CHANGELOG });
  assert.ok(errs.some((e) => e.includes('release-3.13.0')), JSON.stringify(errs));
});

let failed = 0;
for (const c of checks) {
  try { c.fn(); console.log('ok   ' + c.name); } catch (e) { failed++; console.log('FAIL ' + c.name + '\n     ' + e.message); }
}
if (failed) { console.log(failed + ' of ' + checks.length + ' release-check test(s) failed'); process.exit(1); }
console.log('release-check: ' + checks.length + ' checks passed');
