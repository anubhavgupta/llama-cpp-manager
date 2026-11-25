'use strict';

// L1 backend conformance suite runner (plan.md §2 Phase 4 row L1, §6 suite design rules).
//
//   node tests/L1-backend/run.js --verify-against-selftest        # legacy sandbox, must be 100% green
//   node tests/L1-backend/run.js --verify-against-selftest --repeat 3
//   node tests/L1-backend/run.js --ref worktree --only contract,presets
//   node tests/L1-backend/run.js --attach                         # run against a manager already
//                                                                 # listening (PARITY_BASE_URL etc.)
//
// §6.1: everything the suite talks to comes from the environment or from these flags — base URL,
// socket URL, binary path, model dir, nvidia-smi mode, settings file. §6.2: the same checks run
// against legacy (this self-test) and against the candidate. Nothing here imports app code; the
// gate at the top of main() greps for it.

const fs = require('fs');
const path = require('path');

const { Sandbox, delay, waitFor, winPath } = require('./lib/sandbox');
const { COMPARISON, MANIFEST, Registry, WsRecorder, fixturePath } = require('./lib/harness');

function fail(id, detail) {
    const error = new Error(id + ': ' + detail);
    error.id = id;
    throw error;
}

function assert(condition, id, detail) {
    if (!condition) fail(id, detail);
}

const L1_DIR = __dirname;
const REPO = path.resolve(__dirname, '..', '..');
const GROUPS = [
    require('./checks/01-contract'),
    require('./checks/02-process'),
    require('./checks/03-restart'),
    require('./checks/04-presets'),
    ...require('./checks/05-metrics'),
    require('./checks/06-socket')
];

// Which endpoint a check id belongs to, for the per-endpoint count in the report.
const ENDPOINT_OF = [
    [/^L1\.ROOT\./, 'GET /'],
    [/^L1\.SWAGGER/, 'GET /swagger(.json)'],
    [/^L1\.STATIC\./, 'GET / (static)'],
    [/^L1\.SETTINGS\./, '/settings'],
    [/^L1\.PORT\./, '/settings (Q11 port)'],
    [/^L1\.STATUS\./, '/status'],
    [/^L1\.MODELS\./, '/models'],
    [/^L1\.METRICS\./, '/metrics'],
    [/^L1\.START\./, '/start'],
    [/^L1\.STOP\./, '/stop'],
    [/^L1\.EXIT-CODE\./, '/start (exit path)'],
    [/^L1\.LOG\./, '/start -> socket log stream'],
    [/^L1\.RESTART\./, '/restart'],
    [/^L1\.PRESETS\./, '/launch-presets'],
    [/^L1\.SOCKET\./, 'socket.io'],
    [/^L1\.GROUP\./, 'harness guard (no child left registered)']
];

function endpointOf(id) {
    for (const [pattern, name] of ENDPOINT_OF) if (pattern.test(id)) return name;
    return 'unmapped';
}

// --------------------------------------------------------------------- argument parsing ------
function parseArgs(argv) {
    const options = { ref: 'parity-baseline', repeat: 1, keepScratch: false, attach: false, verify: false };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        const next = () => {
            index += 1;
            assert(index < argv.length, 'ARG', 'missing value for ' + token);
            return argv[index];
        };
        if (token === '--verify-against-selftest') options.verify = true;
        else if (token === '--attach') options.attach = true;
        else if (token === '--no-clean') options.keepScratch = true;
        else if (token === '--ref') options.ref = next();
        else if (token === '--scratch') options.scratch = next();
        else if (token === '--repeat') options.repeat = Number.parseInt(next(), 10);
        else if (token === '--only') options.only = new Set(next().split(',').map((name) => name.trim()));
        else if (token === '--keep-scratch') options.keepScratch = true;
        else if (token === '--base-url') process.env.PARITY_BASE_URL = next();
        else fail('ARG', 'unknown argument: ' + token);
    }
    assert(Number.isInteger(options.repeat) && options.repeat >= 1, 'ARG', '--repeat needs a positive integer');
    assert(options.verify || options.attach, 'ARG',
        'choose --verify-against-selftest (build a sandbox and run the suite against legacy) or' +
        ' --attach (run against a manager that is already listening)');
    return options;
}

// --------------------------------------------------------------- no app-code imports --------

// §6.1 'suites never import app code'. public/ and legacy/ are the app's own sources; legacy/lib
// is even served by the app. Enforced on the suite's own files so the claim cannot rot.
function enforceNoAppImports() {
    const offenders = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(abs); continue; }
            if (!/\.js$/.test(entry.name)) continue;
            const text = fs.readFileSync(abs, 'utf8');
            const lines = text.split('\n');
            lines.forEach((line, number) => {
                if (/^\s*\/?\*|^\s*\/\//.test(line)) return;
                const match = /require\(\s*['"]([^'"]+)['"]\s*\)/.exec(line);
                if (!match) return;
                const target = match[1];
                if (/(^|[\\/])(public|legacy)([\\/]|$)/.test(target) ||
                    target.includes('/public/') || target.includes('/legacy/')) {
                    offenders.push(path.relative(REPO, abs) + ':' + (number + 1) + ' -> ' + target);
                }
            });
        }
    };
    walk(L1_DIR);
    assert(offenders.length === 0, 'NO-APP-IMPORTS',
        'the L1 suite imports app code, which §6.1 forbids: ' + offenders.join(', '));
    return offenders;
}

// ------------------------------------------------------------------------ attached mode -----

// A manager the suite did not start (§6.1). The recorder env it was launched with is read back
// from the environment so the argv / chunk-log claims stay checkable.
class Attached {
    constructor() {
        const base = new URL(process.env.PARITY_BASE_URL || 'http://localhost:7837');
        this.port = Number.parseInt(base.port || '7837', 10);
        this.baseUrl = base.origin;
        this.socketUrl = process.env.PARITY_SOCKET_URL || this.baseUrl;
        this.bin = process.env.PARITY_BIN || process.execPath;
        this.modelsDir = process.env.PARITY_MODELS_DIR || '';
        this.nvidiaMode = process.env.PARITY_NVIDIA_MODE || 'ok';
        this.settingsPath = process.env.PARITY_SETTINGS_FILE || '';
        this.iniPath = process.env.PARITY_INI_FILE || '';
        this.fakeScript = process.env.PARITY_FAKE_SCRIPT || '';
        this.standin = process.env.PARITY_STANDIN || this.bin;
        this.app = process.env.PARITY_APP_DIR || '';
        this.session = null;
    }

    async prepare() { /* already running */ }

    async startSession(name) {
        this.session = { name, argvLog: process.env.PARITY_ARGV_LOG || '',
            chunkLog: process.env.PARITY_CHUNK_LOG || '', stdout: [], stderr: [] };
        return this.session;
    }

    async stopSession() { this.session = null; }

    async restartManager() {
        fail('ATTACH', 'the /restart-after-manager-restart check restarts the manager, which' +
            ' --attach mode does not own; run it with --verify-against-selftest');
    }

    sessionText() { return ''; }

    argvLines() { return readJsonl(this.session.argvLog); }

    chunkRecords(source) {
        return readJsonl(this.session.chunkLog).map((line) => JSON.parse(line))
            .filter((record) => record.source === source);
    }

    async waitForArgvLines(count, timeoutMs) {
        const settled = await waitFor('argv lines', timeoutMs || 30000, () => this.argvLines().length >= count);
        assert(settled, 'ARGV-TIMEOUT', 'the argv log never reached ' + count + ' lines');
    }

    settingsFile() { return this.settingsPath; }

    iniFile() { return this.iniPath; }

    request(method, route, body, headers) {
        return new Promise((resolve, reject) => {
            const http = require('http');
            const payload = body === undefined || body === null ? null :
                (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8'));
            const sendHeaders = { Accept: '*/*', ...(headers || {}) };
            if (payload) {
                sendHeaders['Content-Type'] = sendHeaders['Content-Type'] || 'application/json';
                sendHeaders['Content-Length'] = String(payload.length);
            }
            const url = new URL(this.baseUrl + route);
            const req = http.request({ host: url.hostname, port: url.port || 80, method, path: url.pathname,
                agent: new http.Agent({ keepAlive: false }), headers: sendHeaders }, (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks) }));
            });
            req.on('error', reject);
            req.setTimeout(30000, () => req.destroy(new Error('timeout ' + method + ' ' + route)));
            if (payload) req.write(payload);
            req.end();
        });
    }

    async checkPorts() { /* the owner of the manager owns its ports */ }

    cleanTree() { /* not ours */ }
}

function readJsonl(file) {
    if (!file || !fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

// --------------------------------------------------------------------------- context --------

class Context {
    constructor(sandbox, registry) {
        this.sandbox = sandbox;
        this.registry = registry;
        this.port = sandbox.port;
        this.socketUrl = process.env.PARITY_SOCKET_URL || 'http://localhost:' + this.port;
        this.sockets = [];
        this.ws = null;
    }

    check(id, quirk, fn) { return this.registry.check(id, quirk, fn); }

    get(route) { return this.sandbox.request('GET', route); }

    async post(route, body) {
        const at = Date.now();
        const res = await this.sandbox.request('POST', route, body);
        res.at = at;
        return res;
    }

    async waitForRunning(running, timeoutMs) {
        const settled = await waitFor('/status running=' + running, timeoutMs || 30000, async () => {
            try {
                return JSON.parse((await this.get('/status')).raw.toString('utf8')).running === running;
            } catch (error) {
                return false;
            }
        });
        assert(settled, 'STATUS-TIMEOUT', '/status never reported running=' + running);
        return settled;
    }

    // Q24: /stop leaves a SIGKILL armed for one more second on the module-level runningProcess, so
    // a relaunch inside that window is killed by the stale timer. Every group keeps the same 1.5 s
    // of quiet the recording harness keeps between a stop and the next launch.
    async quietAfterStop(ms) {
        await delay(ms === undefined ? 1500 : ms);
    }

    // Stop whatever child is registered and spend the Q24 window, so the next launch is unambiguous.
    async stopChild() {
        const status = JSON.parse((await this.get('/status')).raw.toString('utf8'));
        if (!status.running) {
            await this.quietAfterStop();
            return false;
        }
        await this.post('/stop');
        await this.waitForRunning(false);
        await this.quietAfterStop();
        return true;
    }

    async connectSocket(id) {
        const recorder = await WsRecorder.connect(this.socketUrl, id);
        this.sockets.push(recorder);
        this.ws = recorder;
        return recorder;
    }

    liveSockets() { return this.sockets.filter((recorder) => !recorder.socket.disconnected); }

    // POST /start with the stand-in / fake and report the child pid the recorder logged.
    async launch(options) {
        const launched = await this.launchRaw(options);
        await this.waitForRunning(true);
        return launched;
    }

    // Same, without waiting for /status: the Q24 probe needs the gap between /stop and /start.
    // Arg order follows the recorded argv fixtures (fixtures/argv/J3*), so a positional compare of
    // the vector is meaningful.
    async launchRaw(options) {
        const opts = options || {};
        const args = [winPath(this.sandbox.fakeScript)];
        if (opts.model) args.push('-m', opts.model);
        if (opts.port) args.push('--port', String(opts.port));
        args.push('--parity-chunks', String(opts.parityChunks === undefined ? '0' : opts.parityChunks));
        if (opts.exitCode !== undefined) args.push('--parity-exit-code', String(opts.exitCode));
        if (opts.slowExitMs) args.push('--parity-slow-exit', String(opts.slowExitMs));
        if (opts.extraArgs) args.push(...opts.extraArgs);
        const before = this.sandbox.argvLines().length;
        const startedAt = Date.now();
        const res = await this.post('/start', { serverPath: opts.serverPath || process.execPath, args });
        assert(res.status === 200, 'LAUNCH-STATUS', 'POST /start returned ' + res.status + ' ' +
            res.raw.toString('utf8'));
        // 200 is also what an already-running child answers (Q3), so the body has to say the spawn
        // happened before the argv log can be expected to grow.
        const body = (() => { try { return JSON.parse(res.raw.toString('utf8')); } catch (error) { return null; } })();
        assert(body && body.success === true, 'LAUNCH-SPAWNED',
            'POST /start answered 200 without spawning: ' + res.raw.toString('utf8') +
            ' — a child is still registered; stop it first');
        await this.sandbox.waitForArgvLines(before + 1, 30000);
        const lines = this.sandbox.argvLines().map((line) => JSON.parse(line));
        return { status: res.status, args, startedAt, pid: lines[lines.length - 1].pid };
    }

    async restartManager() {
        for (const recorder of this.sockets) { try { recorder.socket.close(); } catch (error) { /* gone */ } }
        this.sockets.length = 0;
        this.ws = null;
        await this.sandbox.restartSession(this.sandbox.session.name);
    }

    async close() {
        for (const recorder of this.sockets) { try { recorder.socket.close(); } catch (error) { /* gone */ } }
        this.sockets.length = 0;
    }
}

// The argv log is per session; a group that restarts the manager inside itself has to keep reading
// the same file, so the sandbox's argv path is stable for the whole group.
function groupSessionName(group, index) {
    return 'L1-' + group.name + '-' + index;
}

// ----------------------------------------------------------------------------- report -------

function printResults(registry, startedAt) {
    const byEndpoint = new Map();
    for (const entry of registry.results) {
        const endpoint = endpointOf(entry.id);
        const bucket = byEndpoint.get(endpoint) || { pass: 0, fail: 0 };
        bucket[entry.status] += 1;
        byEndpoint.set(endpoint, bucket);
    }
    console.log('');
    console.log('checks per endpoint');
    for (const [endpoint, bucket] of [...byEndpoint.entries()].sort()) {
        console.log('  ' + endpoint.padEnd(30) + ' ' + String(bucket.pass).padStart(3) + ' pass' +
            (bucket.fail ? '  ' + String(bucket.fail).padStart(3) + ' FAIL' : ''));
    }
    console.log('');
    for (const entry of registry.results) {
        const mark = entry.status === 'pass' ? 'PASS' : 'FAIL';
        console.log(mark + '  [' + entry.quirk + ']  ' + entry.id +
            (entry.detail && mark === 'PASS' ? '  — ' + entry.detail : ''));
        if (mark === 'FAIL') {
            console.log('      id: ' + entry.id);
            console.log('      ' + String(entry.detail).split('\n').join('\n      '));
        }
    }
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log('');
    console.log(registry.results.length - registry.failures.length + ' passed, ' +
        registry.failures.length + ' failed of ' + registry.results.length + ' checks in ' +
        seconds + ' s');
    return registry.failures.length === 0;
}

// ------------------------------------------------------------------------------ main --------

// The scratch root is deleted on success, so a green nightly L1 run used to leave no artifact
// behind at all. One JSON per run, next to the nightly logs (tools/parity/reports/nightly/ is
// git-visible), so the cadence trail exists independently of the suite's own stdout.
const SUMMARY_DIR = path.join(REPO, 'tools', 'parity', 'reports', 'nightly');

function summaryFile(options) {
    const mode = options.attach ? 'attach' : (options.verify ? 'selftest' : 'run');
    const utc = new Date().toISOString().replace(/[:]/g, '-').replace(/\.\d{3}Z$/, 'Z');
    return path.join(SUMMARY_DIR, 'l1-' + utc + '-' + mode + '.json');
}

function writeRunSummary(options, passes, green) {
    const file = summaryFile(options);
    fs.mkdirSync(SUMMARY_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
        producedBy: 'node tests/L1-backend/run.js ' + process.argv.slice(2).join(' '),
        at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        mode: options.attach ? 'attach' : (options.verify ? 'verify-against-selftest' : 'run'),
        ref: options.attach ? null : options.ref,
        repeat: options.repeat,
        green: green,
        exitCode: green ? 0 : 1,
        passes: passes.map((pass) => ({
            index: pass.index,
            seconds: Number(pass.seconds.toFixed(1)),
            groups: pass.groups,
            checks: pass.registry.results.length,
            passed: pass.registry.results.length - pass.registry.failures.length,
            failed: pass.registry.failures.length,
            result: pass.registry.results.map((entry) => ({
                id: entry.id, quirk: entry.quirk, status: entry.status,
                ...(entry.status === 'fail'
                    ? { detail: String(entry.detail).split('\n').slice(0, 6).join('\n') }
                    : {})
            }))
        }))
    }, null, 2) + '\n');
    console.log('run summary: ' + path.relative(REPO, file));
    return file;
}

// The spec pins CHECKS.md as part of the gate: every executed check id has to be listed there with
// the §9 quirk it pins, so a new check cannot pass unnoticed.
function enforceChecksIndex(registry) {
    const file = path.join(L1_DIR, 'CHECKS.md');
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const missing = registry.results.filter((entry) => !text.includes(entry.id));
    assert(missing.length === 0, 'L1.CHECKS-MD',
        (text ? 'CHECKS.md does not list ' : 'tests/L1-backend/CHECKS.md is missing; ') +
        (missing.length ? missing.length + ' check id(s): ' + missing.map((entry) => entry.id).join(', ') : '') +
        '\n      file: tests/L1-backend/CHECKS.md');
}

async function runOnce(options, index) {
    const registry = new Registry();
    const sandbox = options.attach ? new Attached() : new Sandbox({
        repo: REPO, ref: options.ref, scratch: options.scratch, port: urlPort()
    });
    const startedAt = Date.now();
    if (!options.attach) {
        console.log('== sandbox ' + sandbox.scratch + '  ref ' + options.ref);
        sandbox.prepare();
        await sandbox.checkPorts();
    }
    const groups = GROUPS.filter((group) => !options.only || options.only.has(group.name));
    let pass = null;
    try {
        for (const group of groups) {
            console.log('--> group ' + group.name + ' (NVIDIA_SMI_STUB_MODE=' + group.stubMode + ')');
            await sandbox.startSession(groupSessionName(group, index), { stubMode: group.stubMode });
            const groupContext = new Context(sandbox, registry);
            try {
                await group.run(groupContext);
            } catch (error) {
                await registry.check('L1-GROUP.' + group.name.toUpperCase(), 'harness', () => {
                    throw error;
                });
            } finally {
                await groupContext.close();
                try { await sandbox.stopSession(); } catch (error) { /* already down */ }
                await delay(1500); // Q24: the stop timer must be spent before the next group spawns
            }
        }
    } finally {
        try { await sandbox.stopSession(); } catch (error) { /* already down */ }
        pass = { index, registry, groups: groups.map((group) => group.name),
            seconds: (Date.now() - startedAt) / 1000 };
        if (!options.attach && !options.keepScratch) sandbox.cleanTree();
    }
    return pass;
}

function urlPort() {
    const base = process.env.PARITY_BASE_URL;
    if (!base) return 7837;
    return Number.parseInt(new URL(base).port || '7837', 10);
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    enforceNoAppImports();
    console.log('L1 backend conformance suite — ' + (options.verify ? 'self-test against ' + options.ref : 'attached') +
        '\n   fixtures: ' + fixturePath('').trim() + '  (' + MANIFEST.fileCount + ' recorded files,' +
        ' comparison policy ' + COMPARISON.rules.length + ' rules)');
    console.log('   groups: ' + GROUPS.map((group) => group.name).join(', '));

    let green = true;
    const passes = [];
    for (let index = 1; index <= options.repeat; index += 1) {
        if (options.repeat > 1) console.log('\n===== pass ' + index + ' of ' + options.repeat + ' =====');
        const pass = await runOnce(options, index);
        passes.push(pass);
        const ok = printResults(pass.registry, Date.now() - pass.seconds * 1000);
        let indexed = true;
        try {
            enforceChecksIndex(pass.registry);
        } catch (error) {
            indexed = false;
            console.log('FAIL  [harness]  L1.CHECKS-MD\n      ' + String(error.detail || error).split('\n').join('\n      '));
        }
        green = green && ok && indexed;
        if (!green && options.repeat > 1) break;
    }
    writeRunSummary(options, passes, green);
    console.log(green
        ? '\nL1 ' + (options.verify ? 'SELF-TEST GREEN' : 'GREEN') + ' against ' +
            (options.attach ? (process.env.PARITY_BASE_URL || 'the attached manager') : options.ref)
        : '\nL1 RED: ' + 'see the FAIL lines above');
    return green ? 0 : 1;
}

main().then((code) => process.exit(code), (error) => {
    console.error('run.js: ' + (error && error.stack ? error.stack : error));
    process.exit(1);
});
