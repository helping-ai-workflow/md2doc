'use strict';
const assert = require('assert');
const { resolveViewerCommand } = require('../lib/editor/open.js');

// WSL + URL → explorer.exe with the raw URL, wslpath never consulted
// (live-verified: `wslpath -w '<url>'` exits 0 with a mangled path, it does
// not fail, so the URL case must be detected before any wslpath call).
{
    let wslpathCalled = false;
    const { cmd, args } = resolveViewerCommand('http://127.0.0.1:1234/edit/0', {
        platform: 'linux',
        wsl: true,
        wslpathFn: () => { wslpathCalled = true; return { status: 0, stdout: 'garbage' }; },
    });
    assert.strictEqual(cmd, 'explorer.exe');
    assert.deepStrictEqual(args, ['http://127.0.0.1:1234/edit/0']);
    assert.strictEqual(wslpathCalled, false, 'wslpath must not be consulted for URL targets');
}

// WSL + https URL → same treatment
{
    const { cmd, args } = resolveViewerCommand('https://example.com/x', {
        platform: 'linux',
        wsl: true,
        wslpathFn: () => { throw new Error('should not be called'); },
    });
    assert.strictEqual(cmd, 'explorer.exe');
    assert.deepStrictEqual(args, ['https://example.com/x']);
}

// WSL + file path → wslpath conversion path, success case
{
    const { cmd, args } = resolveViewerCommand('/tmp/md2doc/foo.html', {
        platform: 'linux',
        wsl: true,
        wslpathFn: (t) => {
            assert.strictEqual(t, '/tmp/md2doc/foo.html');
            return { status: 0, stdout: 'C:\\tmp\\md2doc\\foo.html\n' };
        },
    });
    assert.strictEqual(cmd, 'explorer.exe');
    assert.deepStrictEqual(args, ['C:\\tmp\\md2doc\\foo.html']);
}

// WSL + file path, wslpath failure → falls back to xdg-open
{
    const { cmd, args } = resolveViewerCommand('/tmp/md2doc/foo.html', {
        platform: 'linux',
        wsl: true,
        wslpathFn: () => ({ status: 1, stdout: '' }),
    });
    assert.strictEqual(cmd, 'xdg-open');
    assert.deepStrictEqual(args, ['/tmp/md2doc/foo.html']);
}

// Plain linux (non-WSL) → xdg-open regardless of target shape
{
    const { cmd, args } = resolveViewerCommand('http://127.0.0.1:1234/edit/0', {
        platform: 'linux',
        wsl: false,
        wslpathFn: () => { throw new Error('should not be called'); },
    });
    assert.strictEqual(cmd, 'xdg-open');
    assert.deepStrictEqual(args, ['http://127.0.0.1:1234/edit/0']);
}

// darwin / win32 → unaffected by URL-vs-file, no wsl branch consulted
{
    const mac = resolveViewerCommand('/tmp/foo.html', { platform: 'darwin', wsl: false });
    assert.strictEqual(mac.cmd, 'open');
    assert.deepStrictEqual(mac.args, ['/tmp/foo.html']);

    const win = resolveViewerCommand('http://127.0.0.1:1234/edit/0', { platform: 'win32', wsl: false });
    assert.strictEqual(win.cmd, 'cmd');
    assert.deepStrictEqual(win.args, ['/c', 'start', '""', 'http://127.0.0.1:1234/edit/0']);
}

console.log('open-viewer.test.js OK');
