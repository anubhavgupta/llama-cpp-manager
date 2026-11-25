'use strict';
// One place that decides how a POSIX shell script in this repo is executed.
//
// Why this exists: the nightly job runs with the Task Scheduler PATH (System32 + Git\mingw64\bin,
// no Git\usr\bin), where bare `bash` resolves to WSL bash — a Linux shell whose idea of this disk
// is /mnt/c, so it cannot open `C:\...` OR `C:/...`. The suite scripts (fixture-tree.sh) need the
// git-bash they ship with: they call cygpath and icacls, and they build NTFS ACLs.
//
// So: resolve an MSYS/Cygwin-family bash by absolute path, and hand it forward-slash absolute
// paths, which is the one form both MSYS bash and cygpath accept without conversion.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const candidates = () => {
    const list = [
        'C:/Program Files/Git/bin/bash.exe',
        'C:/Program Files/Git/usr/bin/bash.exe',
        'C:/Program Files (x86)/Git/bin/bash.exe'
    ];
    // A non-default install is still found when git itself is on PATH: its exec-path lives at
    // <root>/mingw64/libexec/git-core (or <root>/libexec/git-core for the 32-bit layout).
    const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
    const execPath = String(exec.stdout || '').trim().replace(/\\/g, '/');
    if (exec.status === 0 && execPath) {
        let root = path.posix.dirname(execPath);
        for (let up = 0; up < 3; up += 1) {
            list.push(path.posix.join(root, 'bin', 'bash.exe'));
            root = path.posix.dirname(root);
        }
    }
    return list;
};

// `uname -s` is the discriminator that matters: MINGW*/MSYS*/CYGWIN* means cygpath, NTFS paths and
// the Windows view of the filesystem. Linux means this shell cannot read the fixture tree at all.
const isPosixWindowsBash = (bash) => {
    if (!fs.existsSync(bash)) return false;
    const uname = spawnSync(bash, ['-c', 'uname -s'], { encoding: 'utf8' });
    return /^(MINGW|MSYS|CYGWIN)/.test(String(uname.stdout || '').trim());
};

let resolved = null;

function bashPath() {
    if (resolved && fs.existsSync(resolved)) return resolved;
    const seen = new Set();
    for (const candidate of candidates()) {
        const key = candidate.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (isPosixWindowsBash(candidate)) {
            resolved = candidate;
            return resolved;
        }
    }
    throw new Error('no git-bash (MSYS/Cygwin bash with cygpath + uname MINGW*) found among: '
        + candidates().join(', ') + ' — fixture-tree.sh cannot run under WSL /bin/bash');
}

// bash accepts C:/dir/file as an absolute path; backslashes are eaten as escapes.
const posixPath = (value) => String(value).replace(/\\/g, '/');

// Run one of this repo's shell scripts. The script path is always argument zero, and every path
// argument goes through posixPath, so the caller never has to think about slash orientation.
function runBash(script, args = [], options = {}) {
    return spawnSync(bashPath(), [posixPath(script), ...args.map(posixPath)],
        { encoding: 'utf8', windowsHide: true, ...options });
}

module.exports = { bashPath, posixPath, runBash };
