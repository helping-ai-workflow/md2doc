#!/usr/bin/env node
'use strict';

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

function main(argv) {
    // Handle --version / --help first so they short-circuit validation.
    for (const a of argv) {
        if (a === '--version' || a === '-v') {
            process.stdout.write(VERSION + '\n');
            return 0;
        }
        if (a === '--help' || a === '-h') {
            printHelp();
            return 0;
        }
    }
    process.stderr.write('error: no input file\n');
    printHelp();
    return 2;
}

process.exit(main(process.argv.slice(2)));
