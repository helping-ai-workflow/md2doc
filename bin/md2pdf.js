#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const FORMAT = 'pdf';
const LIB = path.resolve(__dirname, '..', 'lib', 'md2doc.js');
const VERSION = require('../package.json').version;

function printHelp() {
    process.stdout.write([
        `md2${FORMAT} — render Markdown to ${FORMAT.toUpperCase()} (WaveDrom / Mermaid / Graphviz supported)`,
        '',
        'Usage:',
        `  md2${FORMAT} <input.md> [<input2.md> ...]      # render each to <stem>.${FORMAT} next to source`,
        `  md2${FORMAT} <input.md> --out <path.${FORMAT}>    # explicit output (single-file mode)`,
        `  md2${FORMAT} <input.md> --open                # render then open viewer`,
        `  md2${FORMAT} <input.md> --quiet               # suppress progress output`,
        '',
        'Flags:',
        '  --out <path>   Explicit output path. Only valid with exactly one input.',
        '  --open         Launch the platform viewer after render.',
        '  --quiet        Suppress per-file progress messages.',
        '  --version, -v  Print version.',
        '  --help, -h     Print this help.',
        ''
    ].join('\n'));
}

function parseArgs(argv) {
    const inputs = [];
    let out = null;
    let open = false;
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
        if (a === '--open') { open = true; continue; }
        if (a === '--quiet') { quiet = true; continue; }
        if (a.startsWith('-')) {
            process.stderr.write(`error: unknown flag ${a}\n`);
            process.exit(2);
        }
        inputs.push(a);
    }

    if (inputs.length === 0) {
        printHelp();
        process.exit(2);
    }
    if (out !== null && inputs.length !== 1) {
        process.stderr.write('error: --out is only valid with exactly one input file\n');
        process.exit(2);
    }
    return { inputs, out, open, quiet };
}

function deriveOutput(input, format) {
    const stem = input.replace(/\.md$/i, '');
    if (stem === input) {
        return input + '.' + format;
    }
    return stem + '.' + format;
}

function openViewer(filePath) {
    const platform = process.platform;
    let cmd, args;
    if (platform === 'darwin') {
        cmd = 'open'; args = [filePath];
    } else if (platform === 'win32') {
        cmd = 'cmd'; args = ['/c', 'start', '""', filePath];
    } else {
        cmd = 'xdg-open'; args = [filePath];
    }
    const r = spawnSync(cmd, args, { stdio: 'ignore' });
    if (r.error || r.status !== 0) {
        process.stderr.write(`warning: could not launch viewer for ${filePath}\n`);
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const outputs = [];

    for (const input of args.inputs) {
        if (!fs.existsSync(input)) {
            process.stderr.write(`error: input not found: ${input}\n`);
            process.exit(1);
        }
        const output = (args.out !== null) ? args.out : deriveOutput(input, FORMAT);
        if (!args.quiet) {
            process.stdout.write(`[${FORMAT.toUpperCase()}] ${input} → ${output}\n`);
        }
        const r = spawnSync(process.execPath, [LIB, input, output], { stdio: 'inherit' });
        if (r.status !== 0) {
            process.stderr.write(`error: render failed for ${input} (exit ${r.status})\n`);
            process.exit(r.status || 1);
        }
        outputs.push(output);
    }

    if (args.open) {
        for (const o of outputs) {
            openViewer(o);
        }
    }
}

main();
