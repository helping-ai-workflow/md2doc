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

module.exports = { openViewer, isWSL };
