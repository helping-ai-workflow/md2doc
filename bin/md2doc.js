#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const LIB = path.resolve(__dirname, '..', 'lib', 'md2doc.js');
const VERSION = require('../package.json').version;

function printHelp() {
    process.stdout.write([
        'md2doc — render Markdown to HTML / PDF (WaveDrom / Mermaid / Graphviz supported)',
        '',
        'Usage:',
        '  md2doc <input.md>...                       Render to HTML, write to OS temp dir, open viewer',
        '  md2doc --pdf <input.md>...                 Render to PDF instead',
        '  md2doc --html --pdf <input.md>             Render both formats',
        '  md2doc <input.md> --out <file.html>        Write to a specific file (no auto-open)',
        '  md2doc <input.md>... --out <dir>/          Write each to <dir>/<stem>.html (no auto-open)',
        '',
        'Flags:',
        '  --html              Render HTML (default if neither --html nor --pdf is given).',
        '  --pdf               Render PDF.',
        '  --out <path>        Output path. Ends with \'/\' or existing dir → directory mode.',
        '                      Ends with .html/.pdf → file mode (single input only).',
        '                      Implies --no-open unless --open is also passed.',
        '  --open              Launch the platform viewer after render (default when --out is absent).',
        '  --no-open           Skip the viewer launch.',
        '  --quiet             Suppress per-file progress messages.',
        '  --version, -v       Print version.',
        '  --help, -h          Print this help.',
        ''
    ].join('\n'));
}

function parseArgs(argv) {
    const inputs = [];
    let html = false;
    let pdf = false;
    let out = null;
    let openExplicit = null; // null = unset; true/false = user-specified
    let quiet = false;

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--version' || a === '-v') {
            process.stdout.write(VERSION + '\n');
            process.exit(0);
        }
        if (a === '--help' || a === '-h') {
            printHelp();
            process.exit(0);
        }
        if (a === '--html') { html = true; continue; }
        if (a === '--pdf') { pdf = true; continue; }
        if (a === '--open') { openExplicit = true; continue; }
        if (a === '--no-open') { openExplicit = false; continue; }
        if (a === '--quiet') { quiet = true; continue; }
        if (a === '--out') {
            if (out !== null) {
                process.stderr.write('error: --out specified more than once\n');
                process.exit(2);
            }
            i++;
            if (i >= argv.length) {
                process.stderr.write('error: --out requires a value\n');
                process.exit(2);
            }
            out = argv[i];
            continue;
        }
        if (a.startsWith('-')) {
            process.stderr.write('error: unknown flag ' + a + '\n');
            process.exit(2);
        }
        inputs.push(a);
    }

    if (inputs.length === 0) {
        process.stderr.write('error: no input file\n');
        printHelp();
        process.exit(2);
    }

    // Format defaults: neither flag → HTML only.
    const formats = [];
    if (html || (!html && !pdf)) formats.push('html');
    if (pdf) formats.push('pdf');

    // Open default: ON when --out absent, OFF when --out present; user can override either way.
    let open;
    if (openExplicit !== null) {
        open = openExplicit;
    } else {
        open = (out === null);
    }

    return { inputs, formats, out, open, quiet };
}

function shortHash(absPath) {
    return crypto.createHash('sha1').update(absPath).digest('hex').slice(0, 6);
}

function defaultOutputPath(input, format) {
    const abs = path.resolve(input);
    const stem = path.basename(input).replace(/\.md$/i, '');
    const dir = path.join(os.tmpdir(), 'md2doc');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, stem + '-' + shortHash(abs) + '.' + format);
}

function classifyOut(outValue) {
    // Returns { kind: 'dir' | 'file', ext: 'html'|'pdf'|null }
    if (outValue.endsWith('/') || outValue.endsWith(path.sep)) {
        return { kind: 'dir', ext: null };
    }
    try {
        if (fs.existsSync(outValue) && fs.statSync(outValue).isDirectory()) {
            return { kind: 'dir', ext: null };
        }
    } catch (_) { /* fall through */ }
    if (/\.html$/i.test(outValue)) return { kind: 'file', ext: 'html' };
    if (/\.pdf$/i.test(outValue))  return { kind: 'file', ext: 'pdf' };
    return { kind: 'ambiguous', ext: null };
}

function resolveOutputs(args) {
    const pairs = [];
    if (args.out === null) {
        for (const input of args.inputs) {
            for (const format of args.formats) {
                pairs.push({ input, format, output: defaultOutputPath(input, format) });
            }
        }
        return pairs;
    }

    const cls = classifyOut(args.out);

    if (cls.kind === 'ambiguous') {
        process.stderr.write(
            'error: --out \'' + args.out + '\' must end with \'/\' to mean a directory ' +
            'or \'.html\'/\'.pdf\' to mean a file\n'
        );
        process.exit(2);
    }

    if (cls.kind === 'file') {
        if (args.inputs.length > 1) {
            process.stderr.write('error: --out file path is only valid with one input\n');
            process.exit(2);
        }
        if (args.formats.length > 1) {
            process.stderr.write('error: --out file path is not valid when producing both formats\n');
            process.exit(2);
        }
        if (cls.ext !== args.formats[0]) {
            process.stderr.write(
                'error: --out \'' + args.out + '\' extension does not match selected format\n'
            );
            process.exit(2);
        }
        pairs.push({ input: args.inputs[0], format: args.formats[0], output: args.out });
        return pairs;
    }

    // cls.kind === 'dir' — implemented in Task 5
    process.stderr.write('error: --out directory mode not yet implemented\n');
    process.exit(2);
}

function isWSL() {
    if (process.platform !== 'linux') return false;
    if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
    try {
        return fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop');
    } catch (_) {
        return false;
    }
}

function openViewer(filePath) {
    const platform = process.platform;
    let cmd, args;
    if (platform === 'darwin') {
        cmd = 'open'; args = [filePath];
    } else if (platform === 'win32') {
        cmd = 'cmd'; args = ['/c', 'start', '""', filePath];
    } else if (isWSL()) {
        const r = spawnSync('wslpath', ['-w', filePath], { encoding: 'utf8' });
        if (r.status === 0 && r.stdout) {
            cmd = 'explorer.exe'; args = [r.stdout.trim()];
        } else {
            cmd = 'xdg-open'; args = [filePath];
        }
    } else {
        cmd = 'xdg-open'; args = [filePath];
    }
    const r = spawnSync(cmd, args, { stdio: 'ignore' });
    if (r.error) {
        process.stderr.write('warning: could not launch viewer for ' + filePath + ': ' + r.error.message + '\n');
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));

    for (const input of args.inputs) {
        if (!fs.existsSync(input)) {
            process.stderr.write('error: input not found: ' + input + '\n');
            process.exit(1);
        }
    }

    const pairs = resolveOutputs(args);
    const outputs = [];
    for (const { input, output } of pairs) {
        const stdio = args.quiet ? ['inherit', 'ignore', 'inherit'] : 'inherit';
        const r = spawnSync(process.execPath, [LIB, input, output], { stdio });
        if (r.status !== 0) {
            process.stderr.write('error: render failed for ' + input + ' (exit ' + r.status + ')\n');
            process.exit(r.status || 1);
        }
        if (!args.quiet) {
            process.stdout.write(output + '\n');
        }
        outputs.push(output);
    }

    if (args.open) {
        for (const o of outputs) openViewer(o);
    }
}

main();
