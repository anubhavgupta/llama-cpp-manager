'use strict';
// One executor at a time on the shared scratch root and the manager ports (AUDIT-2026-11-25
// finding 3: a second executor running in C:/parity-scratch deleted this run's log file out from
// under it and produced EPERM races on the ACL-deny fixture that read as suite reds).
//
//   node tools/parity/parity-lock.js --status     who holds it, and for how long
//   node tools/parity/parity-lock.js --selftest   the exclusivity + stale-takeover contract
//
// The lock is one O_EXCL file at <root>/.parity-lock holding the holder's pid and acquisition
// time. A lock older than STALE_MINUTES is taken over with a printed line, because a holder that
// died (killed task, crashed worker) must not lock the gate out permanently.
//
// An entrypoint that spawns suites (run-nightly.js, negative-controls.js) takes the lock once and
// exports PARITY_LOCK_HELD to its children; a suite runner that sees that variable is running
// inside a holder and does not re-acquire, so a child cannot collide with its own parent.
//
// The scratch-tree owners (tests/L1-backend/lib/sandbox.js cleanTree) delete everything the run
// created under the root but keep LOCK_NAME: the holder may be the orchestrator that spawned the
// suite, and its job is still in progress.

const fs = require('fs');
const path = require('path');

const ROOT = process.env.PARITY_LOCK_ROOT || 'C:/parity-scratch';
const LOCK_NAME = '.parity-lock';
const LOCK_FILE = path.join(ROOT, LOCK_NAME);
const STALE_MINUTES = 45;
const HELD_ENV = 'PARITY_LOCK_HELD';

function readPayload(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        return null;
    }
}

function ageMs(payload) {
    const at = payload ? Date.parse(payload.acquiredAt) : NaN;
    return Number.isFinite(at) ? Date.now() - at : NaN;
}

function describe(file) {
    const payload = readPayload(file);
    if (!payload) return 'an unreadable lock file at ' + file;
    const age = ageMs(payload);
    return 'pid ' + payload.pid + ' (' + payload.owner + ') since ' + payload.acquiredAt
        + (Number.isFinite(age) ? ', ' + Math.round(age / 1000) + ' s ago' : ', age unknown');
}

// Refuse-and-report while another holder is live: the caller gets a message naming the holder, and
// a stale lock is taken over on the same path with the takeover printed. Returns null when this
// process is already running inside a holder (PARITY_LOCK_HELD).
function acquire(owner, options) {
    const opts = options || {};
    const file = opts.file || LOCK_FILE;
    const log = opts.log || ((line) => console.log(line));
    if (process.env[HELD_ENV]) return { file, inherited: true, release: () => {} };
    const payload = { pid: process.pid, owner: owner, acquiredAt: new Date().toISOString()
        .replace(/\.\d{3}Z$/, 'Z'), node: process.execPath };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (;;) {
        let fd;
        try {
            fd = fs.openSync(file, 'wx');
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const holder = readPayload(file);
            const age = ageMs(holder);
            const stale = !holder || !Number.isFinite(age) || age > STALE_MINUTES * 60000;
            if (!stale) {
                throw new Error('PARITY-LOCK-HELD: ' + file + ' is held by ' + describe(file)
                    + '. One executor runs on ' + ROOT + ' at a time (AUDIT-2026-11-25 finding 3);'
                    + ' a lock older than ' + STALE_MINUTES + ' minutes is taken over automatically.');
            }
            log('PARITY-LOCK-TAKEOVER: ' + file + ' was left by ' + describe(file)
                + ' (older than ' + STALE_MINUTES + ' minutes, or unreadable); taking it over for pid '
                + process.pid + ' (' + owner + ')');
            fs.rmSync(file, { force: true });
            continue;
        }
        fs.writeSync(fd, JSON.stringify(payload, null, 2) + '\n');
        fs.closeSync(fd);
        return {
            file,
            acquired: true,
            payload,
            release: () => {
                const now = readPayload(file);
                // Never delete a lock this process no longer owns: after a takeover the file belongs
                // to whoever wrote it, and removing it would unlock a run that is still going.
                if (now && now.pid === process.pid) fs.rmSync(file, { force: true });
            }
        };
    }
}

function status() {
    if (!fs.existsSync(LOCK_FILE)) return { held: false, file: LOCK_FILE };
    const payload = readPayload(LOCK_FILE);
    return { held: true, file: LOCK_FILE, holder: payload, ageMs: ageMs(payload),
        stale: !payload || !Number.isFinite(ageMs(payload))
            || ageMs(payload) > STALE_MINUTES * 60000 };
}

// The contract finding 3 needs: a second holder is refused while the lock is live, releasing frees
// the path for the next entrypoint, a stale lock is taken over with a printed line, a holder that
// lost the file must not delete the new owner's lock, and an inherited run neither acquires nor
// releases.
function selftest() {
    const fs2 = require('fs');
    const root = fs2.mkdtempSync(path.join(require('os').tmpdir(), 'parity-lock-'));
    const file = path.join(root, LOCK_NAME);
    const lines = [];
    const log = (line) => lines.push(line);
    const first = acquire('selftest-holder', { file, log });
    if (!first.acquired) throw new Error('lock selftest: the first acquire did not create the lock');
    const written = readPayload(file);
    if (written.pid !== process.pid || written.owner !== 'selftest-holder') {
        throw new Error('lock selftest: the payload does not name this holder: '
            + JSON.stringify(written));
    }
    let refused = false;
    try {
        acquire('selftest-second', { file, log });
    } catch (error) {
        refused = String(error.message).startsWith('PARITY-LOCK-HELD');
        if (!refused) throw error;
    }
    if (!refused) throw new Error('lock selftest: a second holder was not refused');
    first.release();
    if (fs2.existsSync(file)) throw new Error('lock selftest: release() left the lock file behind');
    const stale = acquire('selftest-reacquire', { file, log });
    stale.release();
    fs2.writeFileSync(file, JSON.stringify({ pid: 999999, owner: 'selftest-dead',
        acquiredAt: new Date(Date.now() - (STALE_MINUTES + 1) * 60000).toISOString() }) + '\n');
    lines.length = 0;
    const taken = acquire('selftest-takeover', { file, log });
    if (!lines.some((line) => line.startsWith('PARITY-LOCK-TAKEOVER'))) {
        throw new Error('lock selftest: taking over a >' + STALE_MINUTES + '-minute lock printed no '
            + 'takeover line');
    }
    const stolen = readPayload(file);
    if (stolen.pid !== process.pid) throw new Error('lock selftest: the takeover did not rewrite the payload');
    taken.release();
    if (fs2.existsSync(file)) throw new Error('lock selftest: the new owner left the lock behind');
    // A holder whose file was rewritten by a takeover must not delete the new owner's lock.
    const own = acquire('selftest-about-to-lose-it', { file, log });
    fs2.writeFileSync(file, JSON.stringify({ pid: 999998, owner: 'selftest-took-over'
        , acquiredAt: new Date().toISOString() }) + '\n');
    own.release();
    if (!fs2.existsSync(file) || readPayload(file).pid !== 999998) {
        throw new Error('lock selftest: a holder that lost the lock deleted the new owner\'s file');
    }
    fs2.writeFileSync(file, JSON.stringify({ pid: process.pid, owner: 'selftest-inherited' }) + '\n');
    process.env[HELD_ENV] = '1';
    const inherited = acquire('selftest-child', { file, log });
    if (!inherited.inherited) throw new Error('lock selftest: a child of a holder tried to acquire');
    inherited.release();
    if (!fs2.existsSync(file)) throw new Error('lock selftest: an inherited run released the parent lock');
    delete process.env[HELD_ENV];
    fs2.rmSync(file, { force: true });
    fs2.rmSync(root, { recursive: true, force: true });
    console.log('PARITY-LOCK SELFTEST GREEN');
    console.log('  lock file: ' + LOCK_NAME + ' under ' + ROOT + ' (O_EXCL, pid + acquiredAt)');
    console.log('  second holder refused; >' + STALE_MINUTES + ' min lock taken over with a printed line');
    console.log('  ' + HELD_ENV + ' children neither acquire nor release');
    return 0;
}

function main() {
    const arg = process.argv.slice(2)[0];
    if (arg === '--selftest') return selftest();
    const now = status();
    if (!now.held) {
        console.log('not held: ' + now.file + ' does not exist');
        return 0;
    }
    console.log('held: ' + describe(now.file) + (now.stale ? '  [STALE: older than '
        + STALE_MINUTES + ' minutes, the next entrypoint takes it over]' : ''));
    return 0;
}

if (require.main === module) {
    try {
        process.exitCode = main();
    } catch (error) {
        console.error('parity-lock.js: ' + (error && error.message || error));
        process.exitCode = 1;
    }
}

module.exports = { ROOT, LOCK_NAME, LOCK_FILE, STALE_MINUTES, HELD_ENV, acquire, status, describe };
