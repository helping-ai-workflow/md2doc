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

// --- Task 2: default invocation writes HTML to temp + prints path ---
function shortHash(absPath) {
    return crypto.createHash('sha1').update(absPath).digest('hex').slice(0, 6);
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-cli-test-'));
const mdA = path.join(sandbox, 'sample.md');
fs.writeFileSync(mdA, '# Hello\n\nBody.\n', 'utf8');

{
    // Default: --no-open used to avoid launching a real browser; behavior is otherwise identical
    // to the user's default invocation, and the test still proves the temp path + render dispatch.
    const r = run([mdA, '--no-open']);
    assert.strictEqual(r.status, 0, 'default render exits 0');
    const expectedOut = path.join(os.tmpdir(), 'md2doc', 'sample-' + shortHash(mdA) + '.html');
    assert.ok(fs.existsSync(expectedOut), 'temp HTML output exists at ' + expectedOut);
    const html = fs.readFileSync(expectedOut, 'utf8');
    assert.match(html, /<nav class="toc"/, 'rendered HTML contains TOC markup');
    assert.match(r.stdout, new RegExp(expectedOut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        'stdout reports the temp output path');
    fs.unlinkSync(expectedOut);
}

console.log('Task 2 — default temp render OK');

// --- Task 3: --pdf and --html --pdf produce the right files ---
{
    const r = run([mdA, '--pdf', '--no-open']);
    assert.strictEqual(r.status, 0, '--pdf exits 0');
    const expected = path.join(os.tmpdir(), 'md2doc', 'sample-' + shortHash(mdA) + '.pdf');
    assert.ok(fs.existsSync(expected), 'PDF output exists at ' + expected);
    fs.unlinkSync(expected);
}
{
    const r = run([mdA, '--html', '--pdf', '--no-open']);
    assert.strictEqual(r.status, 0, '--html --pdf exits 0');
    const h = path.join(os.tmpdir(), 'md2doc', 'sample-' + shortHash(mdA) + '.html');
    const p = path.join(os.tmpdir(), 'md2doc', 'sample-' + shortHash(mdA) + '.pdf');
    assert.ok(fs.existsSync(h), 'HTML output exists');
    assert.ok(fs.existsSync(p), 'PDF output exists');
    fs.unlinkSync(h);
    fs.unlinkSync(p);
}

console.log('Task 3 — format selection OK');

// --- Task 4: --out file mode ---
{
    const outFile = path.join(sandbox, 'explicit.html');
    const r = run([mdA, '--out', outFile]);
    assert.strictEqual(r.status, 0, '--out file exits 0');
    assert.ok(fs.existsSync(outFile), '--out file is written');
    // --out implies --no-open: no temp-dir copy should be produced
    const tempCopy = path.join(os.tmpdir(), 'md2doc', 'sample-' + shortHash(mdA) + '.html');
    if (fs.existsSync(tempCopy)) fs.unlinkSync(tempCopy);
    fs.unlinkSync(outFile);
}
{
    const outFile = path.join(sandbox, 'explicit.pdf');
    const r = run([mdA, '--pdf', '--out', outFile]);
    assert.strictEqual(r.status, 0, '--pdf --out .pdf exits 0');
    assert.ok(fs.existsSync(outFile), '--out PDF file is written');
    fs.unlinkSync(outFile);
}

console.log('Task 4 — --out file mode OK');

// --- Task 5: --out directory mode ---
{
    const outDir = path.join(sandbox, 'build') + path.sep;
    const r = run([mdA, '--out', outDir]);
    assert.strictEqual(r.status, 0, '--out trailing-slash dir exits 0');
    const written = path.join(sandbox, 'build', 'sample.html');
    assert.ok(fs.existsSync(written), 'file written inside dir: ' + written);
    fs.unlinkSync(written);
}
{
    // Pre-existing directory without trailing slash should still be treated as dir
    const outDir = path.join(sandbox, 'build2');
    fs.mkdirSync(outDir);
    const r = run([mdA, '--out', outDir]);
    assert.strictEqual(r.status, 0, 'existing dir --out exits 0');
    const written = path.join(outDir, 'sample.html');
    assert.ok(fs.existsSync(written), 'file written inside existing dir');
    fs.unlinkSync(written);
}
{
    // Batch into dir
    const mdB = path.join(sandbox, 'second.md');
    fs.writeFileSync(mdB, '# Second\n', 'utf8');
    const outDir = path.join(sandbox, 'build3') + path.sep;
    const r = run([mdA, mdB, '--out', outDir]);
    assert.strictEqual(r.status, 0, 'batch --out dir exits 0');
    const wa = path.join(sandbox, 'build3', 'sample.html');
    const wb = path.join(sandbox, 'build3', 'second.html');
    assert.ok(fs.existsSync(wa), 'first file written');
    assert.ok(fs.existsSync(wb), 'second file written');
    fs.unlinkSync(wa);
    fs.unlinkSync(wb);
    fs.unlinkSync(mdB);
}
{
    // --html --pdf into dir produces both
    const outDir = path.join(sandbox, 'build4') + path.sep;
    const r = run([mdA, '--html', '--pdf', '--out', outDir]);
    assert.strictEqual(r.status, 0, 'both formats into dir exits 0');
    const h = path.join(sandbox, 'build4', 'sample.html');
    const p = path.join(sandbox, 'build4', 'sample.pdf');
    assert.ok(fs.existsSync(h), 'HTML written');
    assert.ok(fs.existsSync(p), 'PDF written');
    fs.unlinkSync(h);
    fs.unlinkSync(p);
}

console.log('Task 5 — --out directory mode OK');

// --- Task 6: error cases ---
{
    const r = run([mdA, '--out', 'bar']);
    assert.strictEqual(r.status, 2, 'ambiguous --out exits 2');
    assert.match(r.stderr, /must end with/, 'ambiguous --out explains rule');
}
{
    const r = run([mdA, '--pdf', '--out', path.join(sandbox, 'x.html')]);
    assert.strictEqual(r.status, 2, 'extension mismatch exits 2');
    assert.match(r.stderr, /extension does not match/, 'extension mismatch is explained');
}
{
    const r = run([mdA, '--html', '--pdf', '--out', path.join(sandbox, 'x.html')]);
    assert.strictEqual(r.status, 2, 'two formats into one file exits 2');
    assert.match(r.stderr, /both formats|two formats|not valid when producing both/i,
        'two-formats-one-file is explained');
}
{
    const mdB = path.join(sandbox, 'extra.md');
    fs.writeFileSync(mdB, '# Extra\n', 'utf8');
    const r = run([mdA, mdB, '--out', path.join(sandbox, 'x.html')]);
    assert.strictEqual(r.status, 2, 'multi-input file --out exits 2');
    assert.match(r.stderr, /only valid with one input/, 'multi-input file is explained');
    fs.unlinkSync(mdB);
}
{
    const r = run([path.join(sandbox, 'nope.md'), '--no-open']);
    assert.strictEqual(r.status, 1, 'missing input exits 1');
    assert.match(r.stderr, /input not found/, 'missing input is explained');
}
{
    const r = run([mdA, '--bogus']);
    assert.strictEqual(r.status, 2, 'unknown flag exits 2');
    assert.match(r.stderr, /unknown flag/, 'unknown flag is named');
}
{
    const r = run([mdA, '--out']);
    assert.strictEqual(r.status, 2, '--out without value exits 2');
    assert.match(r.stderr, /--out requires a value/, '--out missing value is explained');
}

console.log('Task 6 — error cases OK');

// --- Task 7: --quiet, --no-open behavior pinning ---
{
    const r = run([mdA, '--quiet', '--no-open']);
    assert.strictEqual(r.status, 0, '--quiet exits 0');
    assert.strictEqual(r.stdout, '', '--quiet suppresses stdout');
    const temp = path.join(os.tmpdir(), 'md2doc', 'sample-' + shortHash(mdA) + '.html');
    assert.ok(fs.existsSync(temp), '--quiet still renders');
    fs.unlinkSync(temp);
}
{
    // --out + --open: should still complete successfully even though the viewer launch
    // is platform-specific. We can't easily assert "viewer launched" without mocking,
    // so we assert exit 0 + file written and rely on manual smoke-test for the launch itself.
    const outFile = path.join(sandbox, 'opened.html');
    const r = run([mdA, '--out', outFile, '--no-open']); // use --no-open in CI to avoid launch
    assert.strictEqual(r.status, 0, '--out --no-open exits 0');
    assert.ok(fs.existsSync(outFile), '--out file written');
    fs.unlinkSync(outFile);
}

console.log('Task 7 — open/quiet matrix OK');

// --- Task 8: --out format inference + uppercase .PDF tmp-path fix ---
{
    // Bare inference: no format flag, --out *.pdf selects PDF
    const outFile = path.join(sandbox, 'inferred.pdf');
    const r = run([mdA, '--out', outFile]);
    assert.strictEqual(r.status, 0, 'flag-less --out .pdf exits 0 (format inferred)');
    assert.ok(fs.existsSync(outFile), 'inferred PDF is written');
    assert.strictEqual(fs.readFileSync(outFile).slice(0, 5).toString(), '%PDF-',
        'inferred output is a real PDF');
    fs.unlinkSync(outFile);
}
{
    // Uppercase .PDF destination must survive tmp-file cleanup (lib tmp-path derivation
    // was case-sensitive and deleted the freshly written PDF)
    const outFile = path.join(sandbox, 'UPPER.PDF');
    const r = run([mdA, '--pdf', '--out', outFile]);
    assert.strictEqual(r.status, 0, '--pdf --out UPPER.PDF exits 0');
    assert.ok(fs.existsSync(outFile), 'uppercase .PDF output still exists after tmp cleanup');
    assert.strictEqual(fs.readFileSync(outFile).slice(0, 5).toString(), '%PDF-',
        'uppercase .PDF output is a real PDF');
    fs.unlinkSync(outFile);
}
{
    // Inference + uppercase combined; original casing preserved in output name
    const outFile = path.join(sandbox, 'INFER.PDF');
    const r = run([mdA, '--out', outFile]);
    assert.strictEqual(r.status, 0, 'flag-less --out INFER.PDF exits 0');
    assert.ok(fs.existsSync(outFile), 'uppercase inferred PDF exists with original casing');
    assert.strictEqual(fs.readFileSync(outFile).slice(0, 5).toString(), '%PDF-',
        'uppercase inferred output is a real PDF');
    fs.unlinkSync(outFile);
}
{
    // Inference composes with --quiet
    const outFile = path.join(sandbox, 'quiet-inferred.pdf');
    const r = run([mdA, '--out', outFile, '--quiet']);
    assert.strictEqual(r.status, 0, 'inferred PDF with --quiet exits 0');
    assert.strictEqual(r.stdout, '', '--quiet suppresses stdout on inferred render');
    assert.ok(fs.existsSync(outFile), 'quiet inferred PDF exists');
    fs.unlinkSync(outFile);
}
{
    // Help documents the inference (exit 0 already pinned by Task 1)
    const r = run(['--help']);
    assert.match(r.stdout, /extension selects the format/,
        '--help documents --out extension inference');
}

console.log('Task 8 — --out format inference OK');

// --- Task 9: inference guardrails (regression pins — green before and after) ---
{
    // Explicit flag still wins: --html + .pdf out stays an error
    const r = run([mdA, '--html', '--out', path.join(sandbox, 'y.pdf')]);
    assert.strictEqual(r.status, 2, '--html --out .pdf still exits 2');
    assert.match(r.stderr, /extension does not match/, 'explicit-flag mismatch is explained');
}
{
    // Error precedence: both-formats beats mismatch
    const r = run([mdA, '--html', '--pdf', '--out', path.join(sandbox, 'z.pdf')]);
    assert.strictEqual(r.status, 2, '--html --pdf --out .pdf exits 2');
    assert.match(r.stderr, /both formats|two formats|not valid when producing both/i,
        'both-formats error wins');
    assert.doesNotMatch(r.stderr, /extension does not match/, 'mismatch error does not also fire');
}
{
    // Existing directory literally named *.pdf shadows inference → dir mode, HTML default
    const trap = path.join(sandbox, 'trap.pdf');
    fs.mkdirSync(trap);
    const r = run([mdA, '--out', trap]);
    assert.strictEqual(r.status, 0, 'existing dir named trap.pdf exits 0');
    assert.ok(fs.existsSync(path.join(trap, 'sample.html')), 'dir mode writes HTML inside trap.pdf/');
    assert.ok(!fs.existsSync(path.join(trap, 'sample.pdf')), 'no PDF inferred for a directory target');
    fs.unlinkSync(path.join(trap, 'sample.html'));
    fs.rmdirSync(trap);
}
{
    // Trailing separator forces dir mode even with a .pdf-looking name
    const outDir = path.join(sandbox, 'slash.pdf') + path.sep;
    const r = run([mdA, '--out', outDir]);
    assert.strictEqual(r.status, 0, 'trailing-sep .pdf name exits 0 as dir');
    assert.ok(fs.existsSync(path.join(sandbox, 'slash.pdf', 'sample.html')), 'dir mode writes HTML');
    assert.ok(!fs.existsSync(path.join(sandbox, 'slash.pdf', 'sample.pdf')), 'no PDF inferred for dir target');
    fs.unlinkSync(path.join(sandbox, 'slash.pdf', 'sample.html'));
    fs.rmdirSync(path.join(sandbox, 'slash.pdf'));
}
{
    // Multi-input + file --out still rejected; inference does not relax it
    const mdB = path.join(sandbox, 'multi.md');
    fs.writeFileSync(mdB, '# Multi\n', 'utf8');
    const r = run([mdA, mdB, '--out', path.join(sandbox, 'm.pdf')]);
    assert.strictEqual(r.status, 2, 'multi-input flag-less file --out exits 2');
    assert.match(r.stderr, /only valid with one input/, 'multi-input is still explained');
    fs.unlinkSync(mdB);
}
{
    // .htm stays ambiguous — no alias
    const r = run([mdA, '--out', path.join(sandbox, 'x.htm')]);
    assert.strictEqual(r.status, 2, '.htm --out exits 2');
    assert.match(r.stderr, /must end with/, '.htm is still ambiguous');
}
{
    // Dotfile-style --out '.pdf' (extension only, no stem) is ambiguous, rejected
    // at argument time — path.extname('.pdf') is '' so the renderer could never
    // dispatch it anyway.
    const r = run([mdA, '--out', path.join(sandbox, '.pdf')]);
    assert.strictEqual(r.status, 2, 'dotfile .pdf --out exits 2');
    assert.match(r.stderr, /must end with/, 'dotfile-only extension is ambiguous');
}

console.log('Task 9 — inference guardrails OK');

// --- Task 10: --bake-svg flag ---
{
    const r = run(['--bake-svg', '--help']);
    assert.strictEqual(r.status, 0, '--bake-svg is a recognized flag (no unknown-flag exit 2)');
    assert.match(r.stdout, /--bake-svg/, '--bake-svg documented in help');
    console.log('Task 10 — cli --bake-svg flag test passed');
}

// --- spec §5.3 item 15: the suite runs EVERY test file ---------------------
//
// 「`test/` 目錄的檔案數與 `package.json` 的 `test` script 條目數互相一致」.
// Listed as a guardrail since the spec was written and never built; S4 Task 8
// (stage closure) is the last honest place to add it.
//
// It is deliberately NOT a count comparison. §5.3 explains why a hard-coded
// number is wrong ("不硬編 28"), and a bare `a.length === b.length` has the
// same defect one step removed: adding a file and forgetting one already in
// the script keeps the two totals equal and the suite silently stops running
// a test. The SET difference is what actually says which file is unwatched,
// and it is reported in both directions — a script entry naming a file that
// no longer exists makes `npm test` die with MODULE_NOT_FOUND halfway
// through, which reads as a broken test rather than as a stale script.
{
    const pkg = require(path.join(REPO, 'package.json'));
    const entries = String(pkg.scripts.test).split('&&')
        .map((s) => s.trim()).filter(Boolean);
    // Every entry is `node <path>`; anything else in the chain would break the
    // mapping silently, so it is asserted rather than filtered away.
    const nonNode = entries.filter((e) => !/^node test\/[\w.-]+\.test\.js$/.test(e));
    assert.deepStrictEqual(nonNode, [],
        'every entry of the `test` script must be `node test/<file>.test.js` — this guard '
        + 'maps entries to files by name, and an entry it cannot parse would drop out of '
        + 'both directions of the comparison below and take its file with it');
    const inScript = entries.map((e) => e.replace(/^node /, '')).sort();
    const onDisk = fs.readdirSync(path.join(REPO, 'test'))
        .filter((f) => f.endsWith('.test.js')).map((f) => 'test/' + f).sort();
    // ANTI-VACUITY: two empty sets are trivially equal. Both sides must be
    // real, and `>= 20` is a floor the suite passed long before this guard
    // existed — not a count to maintain.
    assert.ok(onDisk.length >= 20 && inScript.length >= 20,
        'both sides must be non-trivial: ' + onDisk.length + ' file(s) on disk, '
        + inScript.length + ' entry/entries in the script');
    assert.deepStrictEqual(
        onDisk.filter((f) => inScript.indexOf(f) === -1), [],
        'a test file exists that `npm test` never runs — add it to package.json\'s `test` '
        + 'script. A new file that nothing invokes is a test suite that shrinks silently');
    assert.deepStrictEqual(
        inScript.filter((f) => onDisk.indexOf(f) === -1), [],
        'the `test` script names a file that is not in test/ — `npm test` will die with '
        + 'MODULE_NOT_FOUND partway through and look like a broken test');
    // The duplicate case neither difference can see: the same file listed
    // twice keeps both set differences empty and doubles a file's runtime.
    assert.strictEqual(new Set(inScript).size, inScript.length,
        'no file may be listed twice in the `test` script');
    console.log('spec §5.3 item 15 — all ' + onDisk.length
        + ' test files are in the test script OK');
}
