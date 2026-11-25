'use strict';
// The L3 sandbox: the L1 sandbox (tests/L1-backend/lib/sandbox.js, required, never modified) plus
// the three things only the seam layer needs — settings.json control through the app's own
// /settings API, materialisation of the corpus model files, and byte access to the artifacts the
// server writes.
//
// The manager port is NOT configurable: server.js hardcodes 7837 (Q11), so an L3 sandbox always
// owns 7837 while it runs. L4 therefore runs its two refs sequentially and gives each side a
// stable per-side base URL through a loopback forwarder (see tests/L4-dual/helpers/forwarder.js).

const fs = require('fs');
const path = require('path');

const { Sandbox, assert, delay, waitFor, winPath, portOpen } = require('../../L1-backend/lib/sandbox');
const { PathMap, winPath: backslash } = require('./pathmap');

// The stop -> relaunch rhythm, as a set of conditions instead of a sleep. Q24 records that /stop arms
// SIGTERM -> 1 s -> SIGKILL on the MODULE-LEVEL runningProcess; the manager also runs its 1 s metrics
// sample through execSync ('nvidia-smi …' in server.js getSystemMetrics, driven by
// setInterval(updateSystemMetricsHistory, 1000)), which blocks the event loop, so the armed timer
// fires whenever that loop next turns over. Measured on this machine (the launch/stop table under
// tools/parity/reports/nightly/traces, idle vs 52% vs 100% CPU): at 52% CPU the stand-in of the NEXT
// launch died of that stale timer 913-1056 ms after its own spawn, 8 launches out of 8, with
// 'Server process exited with code null' in the manager log — while the same rhythm holds for >=15 s
// at idle. A fixed 1.5 s quiet period therefore relaunches INTO the armed window as soon as the box
// is busy, and the check that follows reads a dead server: '/status never reported running=true' and
// a #stopBtn that never enables are that one event seen from the two sides of page.js.
const Q24 = {
    floorMs: 1500,        // the recorded quiescence, kept exactly as the ledger states it
    armedMs: 1000,        // the arming delay in server.js /stop
    proofMs: 500,         // responsive span that proves the loop turned over after the deadline
    pollMs: 25,
    tripBudgetMs: 100,    // a /status answer slower than this means the manager's loop was blocked
    capMs: 15000,         // and if it never settles, say so instead of waiting forever
    pidWaitMs: 1500,
    portWaitMs: 4000
};

// Windows refuses the manager's own spawn of the stand-in now and then: the manager prints
// 'Error launching server with presets: Error: spawn EINVAL' and answers 200 having started nothing.
// Measured here at about one refusal per 55 spawn attempts, and it happens in green fires as well as
// red ones (the fire1/fire4/fire5 traces under tools/parity/reports/nightly/traces each carry one), so
// it is the OS declining to create a process rather than anything the suite can pin. The tolerance is
// in launchRequest below, and the tally is per fire so run.js can cap it.
const spawnEinval = { retries: 0, note: 'manager logged spawn EINVAL at attempt 1' };
const SPAWN_EINVAL_CAP = 2;

// The ini write is not atomic, so a single read of models-preset.ini can land on a truncated file
// (see waitForIniChange). INI_STABLE_MS is the margin two reads of the same bytes must be separated
// by before the wait believes them: measured here with the recorded payload size (19386 bytes) and a
// reader in a second process, the zero-byte state a truncate-then-write leaves behind was observable
// for up to 205 ms while the box was 100% busy, so a shorter margin could still pair two truncated
// reads. The cost is one margin per ini write per check.
const INI_POLL_MS = 25;         // the cadence waitFor used before this condition replaced it
const INI_STABLE_MS = 250;

// Signal 0 answers ESRCH for a pid that is already gone; anything else means it is still there.
function processGone(pid) {
    try {
        process.kill(pid, 0);
        return false;
    } catch (error) {
        return true;
    }
}

class SeamSandbox extends Sandbox {
    constructor(options) {
        super(options);
        this.appDirOption = options.appDir || null;
        // L4 puts a loopback forwarder in front of the manager so two refs can each carry a stable
        // per-side base URL while the app itself stays pinned to 7837 (Q11).
        this.baseUrl = options.baseUrl || 'http://localhost:' + this.port;
    }

    // iniPath/argvLog exist on the base class as methods/paths; expose the ini path directly too.
    get iniPath() {
        return this.iniFile();
    }

    // Same build as L1, with one extra mode: an already-checked-out app directory (a scratch git
    // worktree a mutant patch was applied to, or a Part-2 candidate build).
    prepare(options) {
        if (!this.appDirOption) return super.prepare(options);
        for (const dir of [this.binDir, this.logDir, this.treeRoot]) {
            fs.mkdirSync(dir, { recursive: true });
        }
        this.app = path.resolve(this.appDirOption);
        assert(fs.existsSync(path.join(this.app, 'server.js')),
            '--app: no server.js in ' + this.app);
        this.junctionNodeModules();
        this.buildFixtureTree();
        this.buildStandIn();
        return this;
    }

    pathMap() {
        return new PathMap({ treeRoot: this.treeRoot, appDir: this.app, standin: this.standin,
            scratchRoot: this.scratch });
    }

    // settings.json is the app's own state; it is written through POST /settings so the seam is
    // observed through the same API a browser uses (and so Q2's write behaviour stays in the loop).
    async writeSettings(body) {
        const res = await this.request('POST', '/settings', body);
        assert(res.status === 200, 'POST /settings returned ' + res.status + ' ' + res.raw.toString('utf8'));
        return JSON.parse(res.raw.toString('utf8'));
    }

    settingsBytes() {
        const file = path.join(this.app, 'settings.json');
        return fs.existsSync(file) ? fs.readFileSync(file) : null;
    }

    iniBytes() {
        const file = path.join(this.app, 'models-preset.ini');
        return fs.existsSync(file) ? fs.readFileSync(file) : null;
    }

    // Wait for POST /launch-presets to have rewritten the ini: `previous` is the bytes to move away
    // from (null when the file is not expected to exist yet).
    //
    // Resolving on the first visible byte change was the M5 flake (re-audit-2 of AUDIT-2026-11-25):
    // server.js writes the ini with fs.writeFileSync, which truncates the file and THEN writes the
    // payload, so a poll inside that window sees 0 bytes, the wait answers 'rewritten', and the
    // check's single read compares "" against 19386 recorded bytes — 'L3.CORPUS-INI-TOKEN-BYTES …
    // expected 19386 bytes, got 0' with L3.CORPUS-INI-TOKEN-WRITTEN green in the same check run, twice
    // on record and never reproducible on demand. So a candidate is accepted only when it is NON-EMPTY
    // and repeats byte-for-byte INI_STABLE_MS later: the truncated state this race actually produces
    // is zero bytes (measured: 476 zero-byte reads, 0 partial reads, out of 1283 reads taken inside
    // the window), and no such state survives the re-read.
    async waitForIniChange(previous, timeoutMs) {
        const deadline = Date.now() + (timeoutMs || 20000);
        for (;;) {
            const first = this.iniBytes();
            if (first && first.length > 0) {
                await delay(INI_STABLE_MS);
                const second = this.iniBytes();
                if (second && second.length > 0 && second.equals(first)
                    && (previous === null || !second.equals(previous))) return true;
            }
            if (Date.now() >= deadline) return false;
            await delay(INI_POLL_MS);
        }
    }

    // §9A remapped mode needs the corpus's own model files to exist: fixture-tree.sh builds a
    // different layout, and a modelPath with no matching <option> blanks (Q18) instead of launching.
    // capture-legacy.js materialises the same files the same way for the recorded J6 run.
    materialiseCorpusModels(configs) {
        let ensured = 0;
        for (const config of Object.values(configs)) {
            for (const field of ['modelPath', 'draftModelPath']) {
                const value = typeof config[field] === 'string' ? config[field] : '';
                if (!value.toLowerCase().endsWith('.gguf')) continue;
                const file = backslash(value);
                fs.mkdirSync(path.dirname(file), { recursive: true });
                if (!fs.existsSync(file)) {
                    fs.writeFileSync(file, Buffer.alloc(0));
                    ensured += 1;
                }
            }
        }
        return ensured;
    }

    // The stand-in records one line per spawn for the relay and one for the relayed fake; the last
    // line is always the newest argv the manager handed to spawn().
    argvRecords() {
        return this.argvLines().map((line) => JSON.parse(line));
    }

    lastArgv() {
        const records = this.argvRecords();
        return records.length ? records[records.length - 1] : null;
    }

    // One spawn writes two argv lines: the compiled stand-in records the vector it was handed, then
    // relays to node + fake-llama-server.js, which records the vector it received. Every recorded
    // journey (J3, J5, J6) has that pair, so a wait for 'one launch' is a wait for both lines —
    // otherwise a comparison can read the relay line before the relay has written anything.
    async waitForLaunch(before, timeoutMs) {
        const settled = await this.waitForArgvLines(before + 2, timeoutMs || 30000)
            .then(() => true, () => false);
        return settled ? this.lastArgv() : null;
    }

    // Refusals the manager has logged in this session's manager log(s).
    spawnEinvalLogged() {
        const prefix = this.sessionIndex + '-';
        let logged = 0;
        for (const name of fs.readdirSync(this.logDir)) {
            if (!name.startsWith(prefix) || !name.endsWith('.manager.log')) continue;
            const text = fs.readFileSync(path.join(this.logDir, name), 'utf8');
            logged += (text.match(/Error launching server.*spawn EINVAL/g) || []).length;
        }
        return logged;
    }

    // POST a request that must spawn the server child, and wait for the argv pair the launch writes.
    // If nothing was spawned AND the manager logged a spawn EINVAL during exactly this window, the
    // refusal is the OS's, so the identical request is re-posted once. A missing launch for any other
    // reason stays missing and the check goes red, and the caller keeps the response for its own
    // status assertion (onResponse runs before the wait, so a wrong status does not cost 30 s).
    async launchRequest(route, body, options) {
        const opts = options || {};
        const timeoutMs = opts.timeoutMs === undefined ? 30000 : opts.timeoutMs;
        const before = this.argvRecords().length;
        const logged = this.spawnEinvalLogged();
        let res = await this.request('POST', route, body);
        if (opts.onResponse) opts.onResponse(res);
        let spawned = await this.waitForLaunch(before, timeoutMs);
        let retried = false;
        if (!spawned && this.spawnEinvalLogged() > logged) {
            spawnEinval.retries += 1;
            retried = true;
            res = await this.request('POST', route, body);
            if (opts.onResponse) opts.onResponse(res);
            spawned = await this.waitForLaunch(before, timeoutMs);
        }
        return { res, spawned, retried, retryNote: retried ? spawnEinval.note : '' };
    }

    // The pids the last launch recorded: the stand-in and the fake it relays to.
    lastLaunchPids() {
        return this.argvLines().slice(-2).map((record) => record.pid).filter((pid) => Number.isInteger(pid));
    }

    // The --port the last launch handed the stand-in. The harness owns this port (it is the fake's,
    // not the manager's 7837), and the next fake needs it free or it dies of EADDRINUSE instead of
    // starting.
    lastLaunchPort() {
        const record = this.lastArgv();
        if (!record || !Array.isArray(record.argv)) return null;
        const at = record.argv.indexOf('--port');
        const port = at < 0 ? null : Number.parseInt(record.argv[at + 1], 10);
        return Number.isInteger(port) ? port : null;
    }

    // Proof that the manager has run everything it armed before `stopAt`: node fires due timers
    // before the poll phase of the same loop turn, so PROOF_MS of consecutive fast /status answers,
    // begun at least armedMs after the stop, means the loop turned over after the armed timer was due
    // and the timer ran. A block in progress makes these answers slow, which restarts the span — the
    // extra time the old constant was guessing at, now measured. Returns ms since stopAt.
    async waitForQuietManager(stopAt, options) {
        const opts = options || {};
        const proofMs = opts.proofMs === undefined ? Q24.proofMs : opts.proofMs;
        const budget = opts.tripBudgetMs === undefined ? Q24.tripBudgetMs : opts.tripBudgetMs;
        const capMs = opts.capMs === undefined ? Q24.capMs : opts.capMs;
        const started = Date.now();
        const floorMs = Math.max(Q24.floorMs, Q24.armedMs + proofMs);
        let spanStart = null;
        for (;;) {
            if (Date.now() - stopAt >= Q24.armedMs) {
                const sending = Date.now();
                let answered = true;
                try {
                    await this.request('GET', '/status');
                } catch (error) {
                    answered = false;
                }
                const now = Date.now();
                if (!answered || now - sending > budget) {
                    spanStart = null;
                } else if (spanStart === null) {
                    spanStart = now;
                } else if (now - spanStart >= proofMs && now - stopAt >= floorMs) {
                    return now - stopAt;
                }
            }
            if (Date.now() - started > capMs) return Date.now() - stopAt;
            await delay(Q24.pollMs);
        }
    }

    // Every group calls this between checks: the manager is stopped, the armed-timer window has
    // provably closed, and the port the next launch will use is free. See Q24 above for why the wait
    // is a condition rather than the 1.5 s constant it replaced.
    async stopAndWait() {
        const stopAt = Date.now();
        const status = JSON.parse((await this.request('GET', '/status')).raw.toString('utf8'));
        if (status.running) {
            await this.request('POST', '/stop');
            await waitFor('/status running=false', 30000, async () => {
                try {
                    return JSON.parse((await this.request('GET', '/status')).raw.toString('utf8')).running === false;
                } catch (error) {
                    return false;
                }
            });
        }
        // The floor lives inside waitForQuietManager (armedMs + proofMs = the recorded 1.5 s), so the
        // common case costs exactly what the old constant cost and a lagging manager costs more.
        const quietMs = await this.waitForQuietManager(stopAt);
        // Then the processes the launch created. Killing the stand-in does not reliably take the relayed
        // fake with it (2 of the 5 measured cycles kept the launch port bound after the stand-in was
        // gone), and a survivor only reaches its bind 2-3 s later under load — after a port-is-free-now
        // check would already have passed — so the next launch dies of EADDRINUSE instead of starting.
        const port = this.lastLaunchPort();
        const pids = this.lastLaunchPids();
        const alive = pids.filter((pid) => !processGone(pid));
        const gone = await waitFor('the last launch processes gone', Q24.pidWaitMs,
            () => pids.every(processGone));
        let swept = [];
        if (!gone) swept = this.sweepChildren();
        let released = true;
        if (port !== null) {
            released = await waitFor(':' + port + ' released by the stopped stand-in', Q24.portWaitMs,
                async () => !(await portOpen(port)));
            if (!released) {
                // A stand-in killed by the stale timer can leave the relayed fake holding the port
                // (2 of the 5 measured cycles). Same guarded sweep stopSession uses: only recorded
                // fake-llama-server pids are ever signalled.
                swept = this.sweepChildren();
                released = await waitFor(':' + port + ' released after sweeping the stale fake',
                    Q24.portWaitMs, async () => !(await portOpen(port)));
            }
        }
        // Silent in a normal fire: the floor plus the proof span lands at ~1.55 s and the threshold is
        // 1.6 s, so an unloaded machine prints nothing (the negative-control logs must stay
        // byte-identical between runs — N3). Anomalies always print, and PARITY_Q24_TRACE=1 prints every
        // stop's timing when a slow machine has to be read.
        if (process.env.PARITY_Q24_TRACE || swept.length || !released) {
            console.log('    [q24] stop quiescence ' + quietMs + ' ms (floor ' + Q24.floorMs
                + ', proof ' + Q24.proofMs + '), launch port '
                + (port === null ? 'none recorded' : port + ' ' + (released ? 'released' : 'STILL BOUND'))
                + (alive.length ? '; pids alive at stop ' + alive.join(',') : '')
                + (swept.length ? ', swept stale fake pids ' + swept.join(',') : ''));
        }
        assert(released, 'L3.STOP-PORT-RELEASED', 'port ' + port + ' was still listening '
            + Q24.portWaitMs + ' ms after /stop and after sweeping the recorded fake pids; the next '
            + 'launch would die of EADDRINUSE instead of starting, so something outside this run is '
            + 'holding it');
    }
}

module.exports = { SeamSandbox, assert, delay, waitFor, winPath, spawnEinval, SPAWN_EINVAL_CAP };
