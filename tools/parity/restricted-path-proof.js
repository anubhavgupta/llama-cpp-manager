'use strict';
// The scheduler-PATH proof, as one re-runnable gate (F1 + F2 of AUDIT-2026-11-25, plus the L3
// raw-capture regression the 2026-11-25 07:20Z scheduled fire exposed).
//
//   node tools/parity/restricted-path-proof.js
//
// Every finding in this class has the same shape: green from an interactive shell, red from
// Task Scheduler, because the scheduled PATH is System32 + the Windows dir + git's mingw64 bin and
// nothing else — no Git\usr\bin (so bare `bash` is WSL bash, which cannot open C:/... at all), no
// WindowsPowerShell (so bare `powershell` does not resolve), and no node at all (which is why
// install-nightly.sh registers an absolute node path). This script rebuilds that environment, runs
// the entrypoints inside it, and requires them green, so the class cannot come back silently.
//
// Exit code is the number of failed checks. It takes the one-executor lock because two of the
// checks run real suites.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const parityLock = require('./parity-lock.js');

const REPO = path.resolve(__dirname, '..', '..');
const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const MINGW_BIN = 'C:\\Program Files\\Git\\mingw64\\bin';

function schedulerPath() {
    const list = [path.join(SYSTEM_ROOT, 'System32'), SYSTEM_ROOT];
    if (fs.existsSync(MINGW_BIN)) list.push(MINGW_BIN);
    return list.join(';');
}

// The scheduled environment: this PATH, absolute node, and PARITY_LOCK_HELD because this process
// holds the lock the suites would otherwise want.
function scheduledEnv() {
    return { ...process.env, PATH: schedulerPath(), PARITY_LOCK_HELD: '1' };
}

let passed = 0;
const failures = [];

function record(name, ok, detail) {
    if (ok) {
        passed += 1;
        console.log('PASS  ' + name + (detail ? '  — ' + detail : ''));
    } else {
        failures.push(name);
        console.log('FAIL  ' + name + '  — ' + detail);
    }
    return ok;
}

function tailOf(text, lines) {
    return text.split('\n').filter((line) => line.trim() !== '').slice(-lines).join(' / ');
}

function runNode(args, options) {
    const opts = options || {};
    if (opts.capture) {
        return Promise.resolve(spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8',
            windowsHide: true, env: scheduledEnv(), maxBuffer: 64 * 1024 * 1024 }));
    }
    console.log('      $ ' + process.execPath + ' ' + args.map((token) => token.length > 90
        ? '<inline script>' : token).join(' '));
    return new Promise((resolve) => {
        const child = spawn(process.execPath, args, { cwd: REPO, windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'], env: scheduledEnv() });
        const out = [];
        const grab = (chunk) => {
            const text = chunk.toString('utf8');
            for (const line of text.split('\n')) {
                if (line.trim() !== '') process.stdout.write('      | ' + line + '\n');
            }
            out.push(text);
        };
        child.stdout.on('data', grab);
        child.stderr.on('data', grab);
        child.on('close', (code) => resolve({ status: code, stdout: out.join(''), stderr: '' }));
    });
}

function which(tool) {
    const probe = spawnSync('cmd.exe', ['/c', 'where', tool], { encoding: 'utf8',
        env: { PATH: schedulerPath(), SystemRoot: SYSTEM_ROOT } });
    return probe.status === 0 ? probe.stdout.trim().split('\n')[0].trim() : null;
}

async function main() {
    console.log('restricted-PATH proof — PATH = ' + schedulerPath());
    console.log('node for the children: ' + process.execPath + ' (registered absolutely by '
        + 'install-nightly.sh, because it is not on this PATH)');

    // 1. The environment is the scheduled one, or nothing below means anything.
    const bash = which('bash');
    const powershell = which('powershell');
    const node = which('node');
    record('PATH has no WindowsPowerShell and no node', powershell === null && node === null,
        'bash=' + (bash || 'absent') + ' powershell=' + (powershell || 'absent')
        + ' node=' + (node || 'absent'));
    if (bash && /System32/i.test(bash)) {
        console.log('      bare `bash` here is ' + bash + ' (WSL: cannot open C:/...) — which is why '
            + 'fixture-tree.sh goes through tools/parity/bash-path.js');
    }

    // 2. F1 + F2: the fixture tree builds, and the ACL deny is lifted by the unlock path rather than
    // by luck, with bash resolved absolutely inside the restricted environment.
    const treeProbe = `
        const fs = require('fs');
        const { runBash, bashPath } = require(${JSON.stringify(path.join(REPO, 'tools/parity/bash-path.js'))});
        const script = ${JSON.stringify(path.join(REPO, 'tools/parity/fixture-tree.sh'))};
        const uname = require('child_process').spawnSync(bashPath(), ['-c', 'uname -s'],
            { encoding: 'utf8' }).stdout;
        const root = 'C:/parity-scratch-proof';
        const tree = root + '/fixtures';
        fs.rmSync(root, { recursive: true, force: true });
        const built = runBash(script, [tree, 'build']);
        if (built.status !== 0) { console.log('BUILD-FAILED ' + (built.stderr || built.stdout)); process.exit(1); }
        const deny = fs.existsSync(tree + '/models/unreadable');
        let bare = 'removed (deny not active: proof void)';
        try { fs.rmSync(root, { recursive: true, force: true }); }
        catch (error) { bare = error.code; }
        const cleaned = runBash(script, [tree, 'clean']);
        fs.rmSync(root, { recursive: true, force: true });
        console.log(JSON.stringify({ bash: bashPath(), uname: (uname || '').trim(), deny, bare,
            cleanStatus: cleaned.status, gone: !fs.existsSync(root) }));
    `;
    const treeResult = await runNode(['-e', treeProbe], { capture: true });
    let tree = null;
    try {
        tree = JSON.parse(String(treeResult.stdout).trim().split('\n').pop());
    } catch (error) { /* reported below */ }
    record('fixture-tree.sh builds, and the unlock path removes the ACL-deny tree (F1+F2)',
        !!tree && /^(MINGW|MSYS|CYGWIN)/.test(String(tree.uname)) && tree.deny === true
        && tree.bare === 'EPERM' && tree.cleanStatus === 0 && tree.gone === true,
        tree ? 'bash=' + tree.bash + ' (' + tree.uname + ') deny=' + tree.deny
            + ' bare fs.rmSync=' + tree.bare + ' fixture-tree.sh clean exit=' + tree.cleanStatus
            + ' root removed=' + tree.gone
            : 'probe produced no verdict: ' + tailOf(String(treeResult.stdout)
                + String(treeResult.stderr), 4));

    // 3. The regression the 2026-11-25 scheduled fire found: the stand-in captures its own command
    //    line through PowerShell, and on this PATH that executable has to be found by absolute path
    //    or every recorded argv line loses `raw` and the byte-exact J6 rows go red.
    const rawProbe = `
        const fs = require('fs');
        const { spawn } = require('child_process');
        const log = require('path').join(require('os').tmpdir(), 'parity-raw-proof.jsonl');
        fs.rmSync(log, { force: true });
        const child = spawn(process.execPath,
            [${JSON.stringify(path.join(REPO, 'tools/parity/fake-llama-server.js'))},
                '--parity-chunks', '0'],
            { env: { ...process.env, PARITY_ARGV_LOG: log }, stdio: 'ignore' });
        const wait = setInterval(() => {
            if (fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('\\n')) {
                clearInterval(wait);
                const record = JSON.parse(fs.readFileSync(log, 'utf8').split('\\n')[0]);
                console.log(JSON.stringify({ raw: record.raw === null ? null : record.raw.slice(0, 60) }));
                child.kill();
                process.exit(0);
            }
        }, 100);
        setTimeout(() => { console.log('{"raw":"TIMEOUT"}'); child.kill(); process.exit(1); }, 30000);
    `;
    const rawResult = await runNode(['-e', rawProbe], { capture: true });
    let raw = null;
    try {
        raw = JSON.parse(String(rawResult.stdout).trim().split('\n').pop());
    } catch (error) { /* reported below */ }
    record('stand-in records its raw command line with powershell off PATH', !!raw
        && typeof raw.raw === 'string' && raw.raw.trim() !== '' && raw.raw !== 'TIMEOUT',
        raw ? 'raw = ' + raw.raw + '…' : 'no capture: ' + tailOf(String(rawResult.stdout)
            + String(rawResult.stderr), 4));

    // 4. F1 as originally proven: the L1 contract group builds and cleans its whole sandbox here.
    const l1 = await runNode(['tests/L1-backend/run.js', '--verify-against-selftest', '--only',
        'contract']);
    const l1ok = l1.status === 0;
    record('L1 --only contract green under the scheduler PATH', l1ok,
        'exit=' + l1.status + '  ' + tailOf(String(l1.stdout), 2));

    // 5. The L3 corpus group, the gate that was red in the scheduled fire.
    const l3 = await runNode(['tests/L3-seam/run.js', '--verify-against-selftest', '--only',
        'corpus-seed,corpus-launch']);
    const l3ok = l3.status === 0;
    record('L3 corpus-seed,corpus-launch green under the scheduler PATH (J6 argv-jsonl included)',
        l3ok, 'exit=' + l3.status + '  ' + tailOf(String(l3.stdout), 2));

    console.log('\n' + (failures.length ? 'RESTRICTED-PATH PROOF RED' : 'RESTRICTED-PATH PROOF GREEN')
        + ' — ' + passed + ' passed, ' + failures.length + ' failed'
        + (failures.length ? ': ' + failures.join('; ') : ''));
    return failures.length;
}

if (require.main === module) {
    const lock = parityLock.acquire('restricted-path-proof node tools/parity/restricted-path-proof.js');
    main().then((code) => {
        lock.release();
        process.exit(code);
    }, (error) => {
        lock.release();
        console.error('restricted-path-proof.js: ' + (error && error.stack ? error.stack : error));
        process.exit(1);
    });
}

module.exports = { schedulerPath, scheduledEnv };
