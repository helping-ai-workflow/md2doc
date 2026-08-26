'use strict';
const fs = require('fs');
const { spawnSync } = require('child_process');

function isWSL() {
    if (process.platform !== 'linux') return false;
    if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
    try {
        return fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop');
    } catch (_) {
        return false;
    }
}

const URL_RE = /^https?:\/\//i;

function defaultWslpath(target) {
    return spawnSync('wslpath', ['-w', target], { encoding: 'utf8' });
}

// Pure decision helper: given a target (file path or URL) and injectable
// environment probes, returns the { cmd, args } to spawn. No side effects
// beyond the injected wslpathFn (which itself may spawn `wslpath`).
//
// WSL note: `wslpath -w '<a URL>'` does NOT fail — it mangles the string
// into a garbage Windows-flavoured path (e.g. 'http://127.0.0.1:1234/edit/0'
// -> 'http\127.0.0.11234\edit\0') and still exits 0. So a URL target must be
// detected up front and routed straight to explorer.exe, which accepts URLs
// directly on Windows; the wslpath conversion path is for real file paths
// only.
function resolveViewerCommand(target, { platform = process.platform, wsl = isWSL(), wslpathFn = defaultWslpath } = {}) {
    if (platform === 'darwin') {
        return { cmd: 'open', args: [target] };
    }
    if (platform === 'win32') {
        return { cmd: 'cmd', args: ['/c', 'start', '""', target] };
    }
    if (wsl) {
        if (URL_RE.test(target)) {
            return { cmd: 'explorer.exe', args: [target] };
        }
        const r = wslpathFn(target);
        if (r.status === 0 && r.stdout) {
            return { cmd: 'explorer.exe', args: [r.stdout.trim()] };
        }
        return { cmd: 'xdg-open', args: [target] };
    }
    return { cmd: 'xdg-open', args: [target] };
}

function openViewer(filePath) {
    const { cmd, args } = resolveViewerCommand(filePath);
    const r = spawnSync(cmd, args, { stdio: 'ignore' });
    if (r.error) {
        process.stderr.write('warning: could not launch viewer for ' + filePath + ': ' + r.error.message + '\n');
    }
}

module.exports = { openViewer, isWSL, resolveViewerCommand };
