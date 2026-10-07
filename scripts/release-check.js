#!/usr/bin/env node
'use strict';

// Release gate for .github/workflows/publish.yml.
//
// The test suites run once, on the pull request. Branch protection on `main`
// requires those checks to be green and the branch to be up to date before a
// merge, so every commit on main is a tree that already passed them; running
// `npm test` again on the tag only repeated a 40-minute job (v3.12.1: four
// `npm test` runs for one release). What the tag job still has to prove is that
// the release metadata agrees:
//   - the tag is vX.Y.Z and equals package.json's version;
//   - the top `## vX.Y.Z — YYYY-MM-DD` heading of CHANGELOG.md is that version;
//   - (CLI, --on-main) the tagged commit is reachable from origin/main.
//
// Usage: node scripts/release-check.js <tag> [--on-main]

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HEADING = /^## v(\d+\.\d+\.\d+) — \d{4}-\d{2}-\d{2}\s*$/m;

function checkRelease({ tag, pkgVersion, changelog }) {
  const errors = [];
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    errors.push(`tag "${tag}" is not of the form vX.Y.Z`);
  } else if (tag !== 'v' + pkgVersion) {
    errors.push(`tag ${tag} does not match package.json version ${pkgVersion}`);
  }
  const m = HEADING.exec(changelog);
  if (m === null) {
    errors.push('CHANGELOG.md has no "## vX.Y.Z — YYYY-MM-DD" heading');
  } else if ('v' + m[1] !== tag) {
    errors.push(`CHANGELOG.md top section is v${m[1]}, not ${tag}`);
  }
  return errors;
}

function main(argv) {
  const tag = argv[0];
  if (!tag) { console.error('usage: node scripts/release-check.js <tag> [--on-main]'); return 2; }
  const root = path.join(__dirname, '..');
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const errors = checkRelease({ tag, pkgVersion, changelog });
  if (argv.includes('--on-main')) {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { cwd: root, stdio: 'ignore' });
    } catch (e) {
      errors.push(`the tagged commit is not on origin/main (tag only merge commits on main)`);
    }
  }
  for (const e of errors) console.error('release-check: ' + e);
  if (errors.length === 0) console.log(`release-check: ${tag} ok (package.json ${pkgVersion}, CHANGELOG top section ${tag})`);
  return errors.length === 0 ? 0 : 1;
}

module.exports = { checkRelease };
if (require.main === module) process.exit(main(process.argv.slice(2)));
