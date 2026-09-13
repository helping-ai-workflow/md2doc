#!/usr/bin/env node
'use strict';
/*
 * extract-journey-rows — print a contiguous run of scenario blocks out of
 * test/editor-journey.test.js, exactly as the file holds them.
 *
 * WHY THIS EXISTS
 *
 * `test/editor-journey.test.js` and `test/editor-client-runtime.test.js` are
 * the two suites this repo's CLAUDE.md forbids a working agent from running
 * (they are long, and they run every scenario in one unguarded sequence, so the
 * first throw hides everything after it). Developing or reviewing ONE scenario
 * therefore means running that scenario on its own, against a prelude of your
 * own — and the moment you retype the scenario into a scratch harness, what you
 * ran is no longer what the file says. Two rounds of this task were reviewed on
 * exactly that ambiguity, in both directions: an implementer claiming a mirror
 * could not drift, and a reviewer having to write this same slicer to check.
 *
 * So: the bytes come from the file, and the digest below is how a report can
 * name them. Nothing here runs a browser or a test — the prelude you wrap these
 * rows in is yours, and it is the part that is allowed to differ.
 *
 * USAGE
 *
 *   node test/tools/extract-journey-rows.js T8a T8h        # first..last marker
 *   node test/tools/extract-journey-rows.js T6b            # one row
 *   node test/tools/extract-journey-rows.js --list         # every marker
 *                                                          # (every `// X —`
 *                                                          #  comment, prose
 *                                                          #  included)
 *   node test/tools/extract-journey-rows.js --file <path> T8a T8h
 *
 * A "marker" is the `// <NAME> —` comment line each scenario opens with, at the
 * indentation the file uses. The run ends at the closing brace of the block
 * that prints the LAST marker's `journey: … — OK` line, so a row made of two
 * consecutive blocks (T8f) comes out whole.
 *
 * Output: the extracted source on stdout, and to STDERR the line range, the
 * byte count and a sha256 of the extracted text — the three things a report can
 * quote and a reviewer can recompute:
 *
 *   node test/tools/extract-journey-rows.js T8a T8h > /tmp/rows.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function parseArgs(argv) {
  const out = { file: null, names: [], list: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--list') out.list = true;
    else if (argv[i] === '--file') { out.file = argv[i + 1]; i++; }
    else out.names.push(argv[i]);
  }
  return out;
}

function markers(text) {
  const re = /^([ \t]*)\/\/ ([A-Za-z][\w.-]*) —/gm;
  const found = [];
  let m = re.exec(text);
  while (m !== null) {
    found.push({ name: m[2], at: m.index, indent: m[1] });
    m = re.exec(text);
  }
  return found;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function main() {
  // `… | head` closes the pipe under us, and an unhandled EPIPE turns a
  // perfectly ordinary look at the output into a stack trace.
  process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
  const args = parseArgs(process.argv.slice(2));
  const file = args.file === null
    ? path.join(__dirname, '..', 'editor-journey.test.js') : args.file;
  const text = fs.readFileSync(file, 'utf8');
  const found = markers(text);

  if (args.list || args.names.length === 0) {
    for (const one of found) {
      process.stdout.write(one.name + '\t' + file + ':' + lineOf(text, one.at) + '\n');
    }
    if (args.names.length === 0 && !args.list) process.exitCode = 1;
    return;
  }

  const first = found.find((x) => x.name === args.names[0]);
  const lastName = args.names[args.names.length - 1];
  const last = found.find((x) => x.name === lastName);
  if (first === undefined || last === undefined) {
    process.stderr.write('no such marker: ' +
      (first === undefined ? args.names[0] : lastName) +
      ' (try --list)\n');
    process.exitCode = 1;
    return;
  }

  // Where the last row ends: its `console.log('journey: … — OK');` line, plus
  // any closing braces that immediately follow it at the marker's indentation
  // or deeper.
  //
  // NOT "the next closing brace after the announce line". Most scenarios are
  // one block that prints on its way out, but a row that loops over two
  // variants (T8b) prints AFTER its block has closed, and searching forward
  // from there swallows the whole of the row below it — measured on this file:
  // T8b came back as lines 11957-12184, which is T8c's ending, and the two
  // extractions overlapped by 164 lines.
  const announce = text.indexOf("console.log('journey:", last.at);
  if (announce === -1) {
    process.stderr.write('the last marker has no `journey: …` line after it\n');
    process.exitCode = 1;
    return;
  }
  let end = text.indexOf('\n', announce);
  end = end === -1 ? text.length : end + 1;
  for (;;) {
    const nl = text.indexOf('\n', end);
    const line = text.slice(end, nl === -1 ? text.length : nl);
    const indent = line.search(/\S/);
    if (!/^[ \t]*\}[;,]?\s*$/.test(line) || indent < last.indent.length) break;
    end = nl === -1 ? text.length : nl + 1;
  }
  const body = text.slice(first.at, end);

  process.stdout.write(body);
  process.stderr.write(
    file + ':' + lineOf(text, first.at) + '-' + lineOf(text, end - 1) +
    '  bytes=' + Buffer.byteLength(body, 'utf8') +
    '  sha256=' + crypto.createHash('sha256').update(body, 'utf8').digest('hex') + '\n');
}

main();
