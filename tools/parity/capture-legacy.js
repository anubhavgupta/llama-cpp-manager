'use strict';

// Phase 1 legacy recording harness (plan.md §2 Phase 1.4, §11).
//
//   --capture  run the journeys against a legacy copy of the app, write every recorded byte under
//              --out (fixtures/{http,ws,argv,ini,localstorage,screenshots}/), then write
//              MANIFEST.json with sha256 + journey + the exact command that produced each file.
//   --compare  byte-compare two recorded trees using fixtures/COMPARISON.json for the per-family
//              comparison mode (§8 nondeterminism ledger). Non-zero exit on any unexplained diff.
//
// The app is never run from the repo: capture-legacy.sh extracts `git archive parity-baseline`
// into a scratch sandbox and junctions node_modules into it (§10 blast radius), so the real
// settings.json / models-preset.ini / model dirs are never touched.
//
// journeys: J0-baseline J1-settings J2-models J2b-metrics-garbage J2c-metrics-fail
//           J3-start-stop J3b-exit-code J3c-start-missing-path J3d-restart J4-launch-presets
//           J5-ui-states J5-ui-log-cap J5-ui-cadence J5-ui-launch J5-ui-dialogs J6-corpus-smoke

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const MANAGER_PORT = 7837;
const FROZEN_CLOCK_MS = Date.parse('2026-01-01T00:00:00.000Z');
const KINDS = ['http', 'ws', 'argv', 'ini', 'localstorage', 'screenshots'];
const REPEAT_LINE = 'slot request: generated 1 token in 42 ms — parity log-cap probe line';

// Canned /metrics body for the screenshot pages only. The real endpoint returns os-utils and
// Math.random() values every second (recorded by J1/J2/J5-ui-cadence); left live it would
// repaint the charts and the metric readouts differently in every recorded pixel.
const SCREENSHOT_METRICS = { cpu: 10, ram: 20, gpu: 30, vram: 40, vramUsage: '12345/24576' };

// ------------------------------------------------------------- utils ------------------------

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const jsonText = (value) => JSON.stringify(value, null, 2) + '\n';
const OPEN_WS_RECORDERS = [];
let LAST_MANAGER_LOG = null;
const winPath = (p) => String(p).replace(/[\\/]+/g, '\\');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
    throw new Error(message);
}

function assert(condition, message) {
    if (!condition) fail(message);
}

async function waitFor(label, timeoutMs, predicate) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return true;
        await delay(30);
    }
    return predicate();
}

function readFileBytes(file) {
    return fs.readFileSync(file);
}

function portOpen(port) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('error', () => resolve(false));
        socket.setTimeout(2000, () => { socket.destroy(); resolve(false); });
    });
}

function parseArgs(argv) {
    const out = { mode: 'capture', out: path.join(REPO, 'fixtures'), repo: REPO };
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        const next = () => {
            i += 1;
            if (i >= argv.length) fail('missing value for ' + token);
            return argv[i];
        };
        if (token === '--compare') { out.mode = 'compare'; out.a = next(); out.b = next(); } else if (token === '--capture') out.mode = 'capture';
        else if (token === '--repo') out.repo = path.resolve(next());
        else if (token === '--scratch') out.scratch = next();
        else if (token === '--out') out.out = path.resolve(next());
        else if (token === '--standin') out.standin = next();
        else if (token === '--stub') out.stubDir = next();
        else if (token === '--csc') out.csc = next();
        else if (token === '--standin-sha') out.standinSha = next();
        else if (token === '--comparison') out.comparison = path.resolve(next());
        else if (token === '--only') out.only = new Set(next().split(',').map((name) => name.trim()).filter(Boolean));
        else fail('unknown argument: ' + token);
    }
    out.comparison = out.comparison || path.join(REPO, 'fixtures', 'COMPARISON.json');
    return out;
}

// -------------------------------------------------------- fixture writer --------------------

class Fixtures {
    constructor(outDir) {
        this.out = outDir;
        this.entries = [];
    }

    // Every recorded file goes through here, so nothing can escape MANIFEST.json.
    write(kind, journey, name, bytes, producedBy) {
        assert(KINDS.includes(kind), 'unknown fixture kind ' + kind);
        assert(/[A-Za-z0-9._@-]+(\.[A-Za-z0-9]+)+/.test(name), 'unusable fixture file name ' + name);
        const rel = path.posix.join('fixtures', kind, journey, name);
        const abs = path.join(this.out, kind, journey, name);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
        fs.writeFileSync(abs, buffer);
        this.entries.push({ path: rel, sha256: sha256(buffer), journey, producedBy });
        return rel;
    }

    json(kind, journey, name, value, producedBy) {
        return this.write(kind, journey, name, jsonText(value), producedBy);
    }

    // Byte-for-byte copy of a file the harness does not author (argv recorder output, config files
    // the app wrote inside the sandbox).
    copyFrom(kind, journey, name, sourceFile, producedBy) {
        assert(fs.existsSync(sourceFile), 'nothing to copy from ' + sourceFile);
        return this.write(kind, journey, name, readFileBytes(sourceFile), producedBy);
    }
}

// ------------------------------------------------------------ HTTP client -------------------

// node:http with keepAlive:false and raw Buffer bodies. undici's global fetch pools sockets
// (Connection is a forbidden header there) and re-serialising a JSON body would destroy the exact
// bytes that are the parity contract.
function request(method, route, body, headers) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined || body === null ? null :
            (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8'));
        const sendHeaders = { Accept: '*/*', ...(headers || {}) };
        if (payload) {
            sendHeaders['Content-Type'] = sendHeaders['Content-Type'] || 'application/json';
            sendHeaders['Content-Length'] = String(payload.length);
        }
        const req = http.request({
            host: '127.0.0.1',
            port: MANAGER_PORT,
            method,
            path: route,
            agent: new http.Agent({ keepAlive: false }),
            headers: sendHeaders
        }, (res) => {
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

// ------------------------------------------------------ PATH-MAP token resolver -------------

// fixtures/PATH-MAP.json tokens -> this machine's scratch paths.
//
// Two deliberate normalisations, both needed for a launchable corpus on Windows:
//   * backslash form, because server.js builds /models paths with path.join and a seeded
//     modelPath must match a <select> option byte-for-byte or the UI blanks it (Q18). The
//     committed remapped corpus is all-forward-slash (load-corpus.js remapUnder() runs every
//     value through normPath), so the original separator style is already gone there; the
//     backslash form is what real-path mode would have produced.
//   * the exe token ends in .cmd, which node refuses to spawn without a shell (EINVAL), so it
//     resolves to the compiled relay stand-in instead.
function buildTokenResolver(repo) {
    const map = JSON.parse(fs.readFileSync(path.join(repo, 'fixtures', 'PATH-MAP.json'), 'utf8'));
    return function resolveTokens(value, scratchRoot, standInExe) {
        const root = winPath(scratchRoot);
        const exe = winPath(standInExe);
        const walk = (node) => {
            if (typeof node === 'string') {
                const isPathToken = node.indexOf(map.tokenRoot) === 0;
                const text = node.split(map.exeToken).join(exe).split(map.tokenRoot).join(root);
                return isPathToken ? text.split('/').join('\\') : text;
            }
            if (Array.isArray(node)) return node.map(walk);
            if (node && typeof node === 'object') {
                const out = {};
                for (const key of Object.keys(node)) out[key] = walk(node[key]);
                return out;
            }
            return node;
        };
        return walk(value);
    };
}

// --------------------------------------------------------------- ws recorder ----------------

// socket.io-client, EVERY event name + payload in arrival order. log-stream payloads are stored as
// base64 of the received string so chunk forwarding is provable (no reassembly, no trim, no
// re-encoding) from the fixture alone.
class WsRecorder {
    constructor(connectionId, url) {
        this.connectionId = connectionId;
        this.url = url;
        this.events = [];
        this.connectRecorded = false;
        // Same defaults public/script.js uses (polling first, then upgrade). Forcing
        // transports:['websocket'] connects but the namespace never delivers, which would record an
        // empty trace instead of the reconnect choreography C6 cares about.
        this.socket = require('socket.io-client').io(url, { forceNew: true });
        this.socket.onAny((event, ...args) => this.push(event, args));
        // socket.io handles 'connect' outside the reserved-event onAny path, and it is the event the
        // app itself renders ("Connected to server for real-time logging"), so record it explicitly.
        this.socket.on('connect', () => {
            if (this.connectRecorded) return;
            this.connectRecorded = true;
            this.push('connect', [null]);
        });
        OPEN_WS_RECORDERS.push(this);
    }

    static async connect(journey, connectionId) {
        const recorder = new WsRecorder(connectionId, 'http://localhost:' + MANAGER_PORT);
        const open = await waitFor('socket ' + connectionId + ' connect', 15000, () => recorder.socket.connected);
        assert(open, 'socket.io client ' + connectionId + ' never reached connected=true');
        return recorder;
    }

    push(event, args) {
        const payload = args.length === 0 ? null : args[0];
        const entry = { seq: this.events.length + 1, event };
        if (event === 'log-stream' && payload && typeof payload.data === 'string') {
            entry.payload = {
                type: payload.type,
                dataBase64: Buffer.from(payload.data, 'utf8').toString('base64'),
                dataLength: Buffer.byteLength(payload.data, 'utf8')
            };
        } else {
            entry.payload = payload === undefined ? null : payload;
        }
        this.events.push(entry);
    }

    count(name) {
        return this.events.filter((entry) => entry.event === name).length;
    }

    async close() {
        this.socket.close();
        const seen = await waitFor('socket ' + this.connectionId + ' disconnect', 5000,
            () => this.events.some((entry) => entry.event === 'disconnect'));
        // One trailing disconnect entry, whatever the client happened to emit on the wire.
        if (!seen) this.push('disconnect', ['io client disconnect']);
        const index = OPEN_WS_RECORDERS.indexOf(this);
        if (index >= 0) OPEN_WS_RECORDERS.splice(index, 1);
    }

    // A journey that throws mid-flight must not leave a reconnecting client holding the event loop.
    static async closeAll() {
        for (const recorder of [...OPEN_WS_RECORDERS]) {
            try { recorder.socket.close(); } catch (error) { /* already gone */ }
        }
        OPEN_WS_RECORDERS.length = 0;
    }

    toFixture() {
        return { connection: this.connectionId, url: this.url, events: this.events };
    }
}

// ------------------------------------------------------------------ capture ----------------

class Capture {
    constructor(options) {
        this.o = options;
        this.scratch = options.scratch;
        this.app = path.join(this.scratch, 'app');
        this.treeRoot = path.join(this.scratch, 'fixtures');
        this.modelsDir = path.join(this.treeRoot, 'models');
        this.binDir = path.join(this.scratch, 'bin');
        this.argvDir = path.join(this.scratch, 'argv');
        this.fakeScript = path.join(this.binDir, 'fake-llama-server.js');
        this.standin = winPath(options.standin);
        this.out = new Fixtures(options.out);
        this.resolveTokens = buildTokenResolver(options.repo);
        this.session = null;
        this.browser = null;
        fs.mkdirSync(this.argvDir, { recursive: true });
    }

    describeSession(extra) {
        const s = this.session;
        const base = s ? 'node ' + winPath(path.join(this.app, 'server.js')) + ' (cwd ' + winPath(this.app) +
            ', legacy copy: git archive parity-baseline -> ' + winPath(this.scratch) + '/app)' +
            ' session=' + s.name +
            ' env{PATH=' + winPath(this.o.stubDir) + ';<PATH>' +
            ',NVIDIA_SMI_STUB_MODE=' + s.stubMode +
            ',PARITY_ARGV_LOG=' + winPath(s.argvLog) +
            ',PARITY_NODE=' + winPath(process.execPath) +
            ',PARITY_FAKE_SCRIPT=' + winPath(this.fakeScript) + ',MODEL_PATH=<unset>}'
            : 'no manager session';
        return extra ? base + ' | ' + extra : base;
    }

    // The live tee is what a crashed journey leaves behind; the fixture copy is the recorded one.
    sessionLogPath(name) {
        const dir = path.join(this.scratch, 'sessions');
        fs.mkdirSync(dir, { recursive: true });
        this.sessionIndex = (this.sessionIndex || 0) + 1;
        return path.join(dir, this.sessionIndex + '-' + name + '.manager.log');
    }

    sessionText(session) {
        return Buffer.concat(session.stdout).toString('utf8') + Buffer.concat(session.stderr).toString('utf8');
    }

    // A manager that lost its child handle (the /restart quirk) cannot stop that child, and on
    // Windows TerminateProcess leaves a relayed grandchild behind. Anything this session spawned
    // that is still alive would hold its llama-server port into the next journey's recording.
    sweepSessionChildren(session) {
        if (!fs.existsSync(session.argvLog)) return [];
        const pids = fs.readFileSync(session.argvLog, 'utf8').split('\n')
            .filter((line) => line.trim() !== '')
            .map((line) => { try { return JSON.parse(line).pid; } catch (error) { return null; } })
            .filter((pid) => Number.isInteger(pid) && pid !== process.pid);
        if (pids.length === 0) return [];
        const filter = pids.map((pid) => 'ProcessId=' + pid).join(' or ');
        const script = 'Get-CimInstance Win32_Process -Filter "' + filter +
            '" | ForEach-Object { $_.ProcessId.ToString() + "|" + $_.CommandLine }';
        const listing = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
        const killed = [];
        for (const line of String(listing.stdout || '').split('\n')) {
            const split = line.indexOf('|');
            if (split < 0) continue;
            const pid = Number.parseInt(line.slice(0, split), 10);
            const commandLine = line.slice(split + 1).toLowerCase();
            // Only our own stand-ins, never a recycled pid running something else.
            if (commandLine.indexOf('fake-llama-server') < 0 || !Number.isInteger(pid)) continue;
            spawnSync('cmd.exe', ['/c', 'taskkill', '/F', '/PID', String(pid)], { stdio: 'ignore' });
            killed.push(pid);
        }
        if (killed.length) console.log('    swept ' + killed.length + ' orphaned stand-in process(es): ' + killed.join(', '));
        return killed;
    }

    async startSession(name, options = {}) {
        if (this.session) fail('session ' + this.session.name + ' is still running');
        const argvLog = path.join(this.argvDir, (options.argvLogName || name) + '.jsonl');
        if (!options.argvLogName) fs.rmSync(argvLog, { force: true });
        const stubMode = options.stubMode || 'ok';
        const env = { ...process.env };
        delete env.MODEL_PATH;
        env.PATH = winPath(this.o.stubDir) + ';' + (env.PATH || '');
        env.NVIDIA_SMI_STUB_MODE = stubMode;
        env.PARITY_ARGV_LOG = winPath(argvLog);
        env.PARITY_NODE = process.execPath;
        env.PARITY_FAKE_SCRIPT = winPath(this.fakeScript);

        assert(!(await portOpen(MANAGER_PORT)),
            'port ' + MANAGER_PORT + ' is busy; refusing to kill an unknown process — free it and re-run');
        const child = spawn(process.execPath, [winPath(path.join(this.app, 'server.js'))], {
            cwd: winPath(this.app), env, stdio: ['ignore', 'pipe', 'pipe']
        });
        const session = { name, stubMode, argvLog, child, stdout: [], stderr: [], closed: false,
            logPath: this.sessionLogPath(name) };
        const tee = fs.createWriteStream(session.logPath);
        child.stdout.on('data', (chunk) => { session.stdout.push(chunk); tee.write(chunk); });
        child.stderr.on('data', (chunk) => { session.stderr.push(chunk); tee.write(chunk); });
        child.on('close', (code, signal) => {
            session.closed = true;
            session.result = { code: code, signal: signal };
            tee.end();
        });
        this.session = session;
        LAST_MANAGER_LOG = session.logPath;
        console.log('    session ' + name + ' starting (NVIDIA_SMI_STUB_MODE=' + stubMode + ')');
        const up = await waitFor('manager listening on :' + MANAGER_PORT, 20000, () => portOpen(MANAGER_PORT));
        assert(up, 'legacy manager did not start listening on ' + MANAGER_PORT);
        // server.js samples on a 1 s interval and answers with its zeroed initial state until the
        // first tick lands; recording that would capture a startup artefact instead of behaviour.
        // ram is the readiness signal because gpu/vram legitimately stay zero in some stub modes.
        const sampled = await waitFor('first metrics sample', 25000, async () => {
            try {
                const res = await request('GET', '/metrics');
                return res.status === 200 && JSON.parse(res.raw.toString('utf8')).ram > 0;
            } catch (error) {
                return false;
            }
        });
        assert(sampled, 'server.js never produced a metrics sample within 25 s');
        return session;
    }

    // POST /stop first: killing the manager would orphan its spawned child (the stand-in or the
    // relayed fake) with its llama-server port still bound, which would change later recordings.
    // Then SIGTERM, then SIGKILL one second later — the window server.js uses for its children.
    async stopSession(recordFor) {
        const session = this.session;
        this.session = null;
        if (!session) return { code: null, signal: null };
        try {
            await request('POST', '/stop', undefined, { 'Content-Type': 'application/json' });
            await waitFor('child stopped', 8000, async () =>
                JSON.parse((await request('GET', '/status')).raw.toString('utf8')).running === false);
        } catch (error) { /* the manager may already be gone */ }
        if (!session.closed) {
            session.child.kill('SIGTERM');
            if (!(await waitFor('manager exit', 10000, () => session.closed))) {
                spawnSync('cmd.exe', ['/c', 'taskkill', '/T', '/F', '/PID', String(session.child.pid)], { stdio: 'ignore' });
            }
            await waitFor('manager close', 10000, () => session.closed);
            await delay(150);
        }
        this.sweepSessionChildren(session);
        if (recordFor) {
            const prefix = recordFor.prefix || 'manager';
            this.out.write('ws', recordFor.journey, prefix + '.stdout.log', Buffer.concat(session.stdout),
                'stdout of ' + this.describeSession());
            this.out.write('ws', recordFor.journey, prefix + '.stderr.log', Buffer.concat(session.stderr),
                'stderr of ' + this.describeSession());
        }
        return session.result || { code: null, signal: null };
    }

    async get(journey, name, route) {
        const res = await request('GET', route);
        this.out.json('http', journey, name + '.request.json', {
            method: 'GET', url: 'http://localhost:' + MANAGER_PORT + route, headers: { Accept: '*/*' }, body: null
        }, this.describeSession('GET ' + route));
        this.out.write('http', journey, name + '.response', res.raw,
            this.describeSession('GET ' + route + ' -> ' + res.status));
        return res;
    }

    async post(journey, name, route, body) {
        const res = await request('POST', route, body, { 'Content-Type': 'application/json' });
        this.out.json('http', journey, name + '.request.json', {
            method: 'POST', url: 'http://localhost:' + MANAGER_PORT + route,
            headers: { 'Content-Type': 'application/json', Accept: '*/*' }, body
        }, this.describeSession('POST ' + route));
        this.out.write('http', journey, name + '.response', res.raw,
            this.describeSession('POST ' + route + ' -> ' + res.status));
        return res;
    }

    // Raw copy of the argv recorder output (one line per spawned process, written by the spawned
    // process itself: the stand-in relay plus the relayed fake).
    recordArgv(journey, label) {
        const log = this.session.argvLog;
        assert(fs.existsSync(log), 'no argv log at ' + log + ' — nothing was spawned?');
        return this.out.copyFrom('argv', journey, label ? label + '.jsonl' : 'launch.jsonl', log,
            this.describeSession('argv + raw command line appended to ' + winPath(log) + ' by '
                + 'tools/parity/standin-llama-server.exe relaying to tools/parity/fake-llama-server.js'));
    }

    lastArgv(journey) {
        const lines = fs.readFileSync(this.session.argvLog, 'utf8').split('\n').filter((l) => l.trim() !== '');
        assert(lines.length > 0, 'argv log ' + this.session.argvLog + ' is empty');
        return JSON.parse(lines[lines.length - 1]);
    }

    async waitForRunning(running, timeoutMs) {
        const ok = await waitFor('/status running=' + running, timeoutMs || 20000, async () => {
            const res = await request('GET', '/status');
            return JSON.parse(res.raw.toString('utf8')).running === running;
        });
        assert(ok, '/status never reported running=' + running);
    }

    // /status turns true as soon as spawn() returned, long before node has booted and written its
    // argv line. Journeys that read the argv log must wait for the recorder, not for the endpoint.
    async waitForArgvLines(count, timeoutMs) {
        const log = this.session.argvLog;
        const ok = await waitFor('argv lines >= ' + count, timeoutMs || 25000, () => {
            if (!fs.existsSync(log)) return false;
            return fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.trim() !== '').length >= count;
        });
        assert(ok, 'argv log ' + log + ' never reached ' + count + ' line(s)');
    }

    // -------------------------------------------------------------- browser ----------------

    async launchBrowser() {
        if (this.browser) return this.browser;
        const { chromium } = require('playwright');
        this.browser = await chromium.launch();
        return this.browser;
    }

    async closeBrowser() {
        if (this.browser) await this.browser.close();
        this.browser = null;
    }

    // A fresh context per UI state: localStorage is per-context, so 'fresh' really is fresh.
    async newUiPage(options = {}) {
        const browser = await this.launchBrowser();
        const context = await browser.newContext({
            viewport: options.viewport || { width: 1280, height: 800 },
            deviceScaleFactor: 1,
            reducedMotion: 'reduce'
        });
        const blocked = [];
        await context.route('**/*', (route) => {
            const host = new URL(route.request().url()).hostname;
            if (host === 'localhost' || host === '127.0.0.1') return route.continue();
            blocked.push(route.request().url());
            return route.abort();
        });
        if (options.seed) {
            const seed = options.seed;
            await context.addInitScript((data) => {
                localStorage.setItem(data.configsKey, data.configsJson);
                localStorage.setItem(data.settingsKey, data.settingsJson);
            }, {
                configsKey: seed.configsKey, settingsKey: seed.settingsKey,
                configsJson: JSON.stringify(seed.configs), settingsJson: JSON.stringify(seed.settings)
            });
        }
        if (options.freezeClock) {
            // Isolates the one nondeterministic part of the log pane (its ISO timestamps) so the
            // pane text and its pixels are comparable; the timestamp FAMILY stays shape-compared in
            // fixtures/COMPARISON.json, and the real timestamps are recorded unsanitised in J3's ws
            // fixtures. Timers keep running on the real clock.
            await context.addInitScript((fixed) => {
                const RealDate = Date;
                class FrozenDate extends RealDate {
                    constructor(...args) { if (args.length === 0) super(fixed); else super(...args); }
                    static now() { return fixed; }
                }
                window.Date = FrozenDate;
            }, FROZEN_CLOCK_MS);
        }
        const page = await context.newPage();
        const pageState = { context, page, blocked, dialogs: [], navigations: 0 };
        page.on('dialog', (dialog) => {
            pageState.dialogs.push({ type: dialog.type(), message: dialog.message() });
            const action = pageState.dialogAction || 'dismiss';
            dialog[action]().catch(() => {});
        });
        page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) pageState.navigations += 1; });
        if (options.mockMetrics) {
            await page.route('**/metrics', (route) => route.fulfill({
                status: 200, contentType: 'application/json', body: JSON.stringify(SCREENSHOT_METRICS)
            }));
        }
        await page.goto('http://localhost:' + MANAGER_PORT + '/', { waitUntil: 'load' });
        await page.waitForFunction(() => document.fonts.status !== 'loading').catch(() => {});
        await page.waitForTimeout(options.settleMs === undefined ? 400 : options.settleMs);
        return pageState;
    }

    async fontState(pageState) {
        return pageState.page.evaluate(() => ({
            status: document.fonts.status,
            loaded: [...document.fonts].filter((face) => face.status === 'loaded').map((face) => face.family),
            bodyFontFamily: getComputedStyle(document.body).fontFamily,
            fontLinks: [...document.querySelectorAll('link[rel=stylesheet]')].map((link) => link.href)
        }));
    }

    async dumpStorage(pageState) {
        return pageState.page.evaluate(() => {
            const entries = [];
            for (let index = 0; index < localStorage.length; index += 1) {
                const key = localStorage.key(index);
                entries.push([key, localStorage.getItem(key)]);
            }
            return { order: entries.map((entry) => entry[0]), entries };
        });
    }

    // Every form control in the document, in document order. Q8 needs the values, not just storage.
    async dumpFields(pageState) {
        return pageState.page.evaluate(() => [...document.querySelectorAll('input, select, textarea')]
            .map((node) => ({
                id: node.id || null,
                tag: node.tagName.toLowerCase(),
                type: node.getAttribute('type') || null,
                value: node.type === 'checkbox' ? null : node.value,
                checked: node.type === 'checkbox' ? node.checked : null,
                disabled: !!node.disabled,
                text: node.tagName === 'SELECT' ? node.options.length : null
            })));
    }

    // Records the page's own request/response bytes (what the UI actually put on the wire).
    async exchange(pageState, journey, name, urlSuffix, trigger) {
        const page = pageState.page;
        const pending = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no ' + urlSuffix + ' response within 30 s')), 30000);
            const handler = async (res) => {
                if (!res.url().endsWith(urlSuffix)) return;
                page.off('response', handler);
                clearTimeout(timer);
                try {
                    resolve({
                        status: res.status(),
                        request: {
                            method: res.request().method(), url: res.url(),
                            headers: res.request().headers(), postData: res.request().postData()
                        },
                        body: await res.body()
                    });
                } catch (error) { reject(error); }
            };
            page.on('response', handler);
        });
        const triggered = trigger ? trigger() : null;
        const result = await pending;
        if (triggered) await triggered;
        this.out.json('http', journey, name + '.request.json', result.request, this.describeSession(
            'page ' + result.request.method + ' ' + result.request.url + ' (Playwright chromium, response observed via CDP)'));
        this.out.write('http', journey, name + '.response', result.body, this.describeSession(
            'page ' + result.request.method + ' ' + result.request.url + ' -> ' + result.status));
        return result;
    }

    // Pixels are only comparable if the page state that produced them is comparable: the metrics
    // canvases redraw on a 1 s sampler (how many ticks landed before the shot is timing), so they are
    // hidden, animations are stopped, and fonts are awaited. The paired .render.json is the compared
    // artifact - element geometry and control state - because PNG bytes also carry whatever the log
    // pane happened to render.
    async screenshot(pageState, journey, name) {
        await pageState.page.addStyleTag({ content: 'canvas{display:none !important}'
            + '*{animation:none !important;transition:none !important;caret-color:transparent !important}' });
        await pageState.page.evaluate(async () => {
            if (document.fonts && document.fonts.ready) await document.fonts.ready;
        });
        await pageState.page.waitForTimeout(200);
        const png = await pageState.page.screenshot({ fullPage: true });
        const viewport = pageState.page.viewportSize();
        const render = await pageState.page.evaluate(() => {
            const round = (value) => Math.round(value * 100) / 100;
            const elements = [...document.querySelectorAll('[id]')].map((element) => {
                const box = element.getBoundingClientRect();
                const row = { id: element.id, tag: element.tagName.toLowerCase(),
                    visible: !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
                    rect: [round(box.x), round(box.y), round(box.width), round(box.height)] };
                if ('value' in element) row.value = element.value;
                if ('checked' in element) row.checked = element.checked;
                if ('disabled' in element) row.disabled = element.disabled;
                const shown = (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
                row.text = element.id === 'modelOutput'
                    ? '<log-pane:' + element.textContent.split('\n').length + '-entries>'
                    // Percent labels are sampler output even when canned, and any non-canned one is
                    // machine state (§8); the claim here is geometry and control state.
                    : shown.replace(/\d/g, '<n>');
                return row;
            });
            const pane = document.getElementById('modelOutput');
            return { title: document.title, elementCount: elements.length,
                scrollHeight: Math.round(document.documentElement.scrollHeight),
                logPane: { lineCount: pane.textContent.split('\n').length,
                    startsWithTimestamp: /^\[\d{4}-/.test(pane.textContent) },
                elements };
        });
        this.out.json('screenshots', journey, name + '.render.json', {
            viewport, focus: null, elements: render.elements, logPane: render.logPane,
            title: render.title, scrollHeight: render.scrollHeight,
            note: 'Compared artifact behind ' + name + '.png: geometry and control state of every'
                + ' [id] element, with the log pane reduced to its entry count because streamed text'
                + ' depends on pipe coalescing. Canvases were display:none for the shot.'
        }, this.describeSession('render fingerprint of the same page state as ' + name + '.png'));
        return this.out.write('screenshots', journey, name + '.png', png, this.describeSession(
            'Playwright chromium page.screenshot({fullPage:true}) viewport=' + JSON.stringify(viewport)
            + ', canvases hidden, animations disabled, document.fonts.ready awaited'));
        }

    // ------------------------------------------------------------------ seeds ----------------

    corpusSeed() {
        const { loadCorpus } = require('./load-corpus.js');
        const corpus = loadCorpus();
        const list = JSON.parse(fs.readFileSync(path.join(this.o.repo, 'fixtures', 'corpus', 'configs.remapped.json'), 'utf8'));
        const settings = JSON.parse(fs.readFileSync(path.join(this.o.repo, 'fixtures', 'corpus', 'settings.remapped.json'), 'utf8'));
        const configs = {};
        for (const entry of list) configs[entry.name] = entry.config;
        // FIXTURE_ROOT is the fixture tree (fixtures/PATH-MAP.json lists FIXTURE_ROOT/models, which is
        // the tree fixture-tree.sh builds), not the scratch root - otherwise the corpus model paths
        // fall outside the directory the app scans and nothing can be launched.
        const resolved = this.resolveTokens({ configs, settings }, this.treeRoot, this.standin);
        assert(Object.keys(resolved.configs).length === list.length,
            'corpus config count changed while rebuilding the localStorage-shaped map');
        return {
            configsKey: corpus.configsKey, settingsKey: corpus.settingsKey,
            configs: resolved.configs, settings: resolved.settings
        };
    }

    // Two configs + settings for the UI journeys: a small, legible storage state.
    smallSeed(port) {
        const spaced = winPath(path.join(this.modelsDir, 'models with spaces', 'spaced model Q4.gguf'));
        const plain = winPath(path.join(this.modelsDir, 'a', 'model-a.gguf'));
        return {
            configsKey: 'llamaCppConfigs', settingsKey: 'llamaCppSettings',
            settings: { serverPort: port, modelsDirectory: winPath(this.modelsDir) },
            configs: {
                'capture-alpha': {
                    serverPath: this.standin, modelPath: spaced, ngl: 99, threads: 12, temp: 0.7,
                    topK: 20, topP: 0.00, minP: 0.05, repeatPenalty: '1.05', presencePenalty: 0.00,
                    parallel: 1, loadMode: 'mmap', swaFull: false, backendSampling: false,
                    contextSize: 16384, nCpuMoe: 8, cpuMoe: false, ctkEnable: false,
                    contextTokenKey: 'f16', contextTokenValue: 'f16', fastAttention: 'auto', jinja: true,
                    verbose: false, noKvOffload: false, noMmprojOffload: false, cacheRam: 8192,
                    speculationType: 'none', ngramMod: false, specDraftNMax: 0, reasoning: 'off',
                    loadCustomChatTemplate: true, chatTemplateKwargs: '{"preserve_thinking": true}',
                    draftModelPath: '', ngld: 0, ctkd: 'f16', ctvd: 'f16'
                },
                'capture-beta': {
                    serverPath: this.standin, modelPath: plain, ngl: 0, threads: 4, temp: 0,
                    topK: 0, topP: 0, minP: '0.00', repeatPenalty: 0, presencePenalty: '0.0',
                    parallel: 0, loadMode: 'mmap', swaFull: true, backendSampling: true,
                    contextSize: 1, nCpuMoe: 0, cpuMoe: true, ctkEnable: true,
                    contextTokenKey: 'q8_0', contextTokenValue: 'q8_0', fastAttention: 'on', jinja: false,
                    verbose: true, noKvOffload: true, noMmprojOffload: true, cacheRam: -1,
                    speculationType: 'draft-mtp', ngramMod: true, specDraftNMax: 8, reasoning: 'auto',
                    loadCustomChatTemplate: false, chatTemplateKwargs: '', draftModelPath: '', ngld: 0,
                    ctkd: 'f16', ctvd: 'f16', mlock: true, ndio: false
                }
            }
        };
    }

    // Remapped-mode corpus (§9A): the tree fixture-tree.sh built does not contain the corpus's own
    // model paths, so materialise them; otherwise every corpus modelPath would miss its <option>
    // and blank (Q18) instead of launching. Done late (J6) so J2's /models golden stays the pure
    // fixture-tree layout.
    materialiseCorpusModels() {
        const ensured = [];
        const skipped = [];
        const seed = this.corpusSeed();
        for (const name of Object.keys(seed.configs)) {
            const config = seed.configs[name];
            for (const field of ['modelPath', 'draftModelPath']) {
                const value = typeof config[field] === 'string' ? config[field] : '';
                if (!value.toLowerCase().endsWith('.gguf')) continue;
                const file = winPath(value);
                ensured.push(file);
                try {
                    fs.mkdirSync(path.dirname(file), { recursive: true });
                    if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.alloc(0));
                } catch (error) {
                    skipped.push({ path: file, error: error.code || error.message });
                }
            }
        }
        return { ensured: ensured.length, skipped };
    }
}

// --------------------------------------------------------------- journeys -------------------

// The UI's own emission order, so /start is driven with a realistic llama-server vector. One
// value carries spaces AND quotes ('{"preserve_thinking": true}') to pin libuv argv quoting.
function realisticStartArgs(cap, modelPath) {
    const dir = modelPath.replace(/[/\\][^/\\]*$/, '');
    return [winPath(cap.fakeScript), '-m', modelPath, '-ngl', '99', '-t', '12', '--temp', '0.7',
        '--top-k', '20', '--top-p', '0.00', '--min-p', '0.05', '--repeat-penalty', '1.05',
        '--parallel', '1', '--load-mode', 'mmap', '-c', '16384', '--n-cpu-moe', '8',
        '-ctk', 'q8_0', '-ctv', 'q8_0', '-fa', '--jinja',
        '--chat-template-kwargs', '{"preserve_thinking": true}',
        '--chat-template-file', dir + '\\chat-template.jinja', '--verbose', '--backend-sampling',
        '--no-kv-offload', '--no-mmproj-offload', '--cache-ram', '8192',
        '--spec-type', 'ngram-mod,draft-mtp', '--spec-ngram-mod-n-match', '24',
        '--spec-ngram-mod-n-min', '48', '--spec-ngram-mod-n-max', '64', '--reasoning', 'off',
        '--host', '0.0.0.0', '-fit', 'off', '--port', '7838'];
}

function parseJson(res, what) {
    assert(res.status === 200 || res.status === 400, what + ' returned unexpected status ' + res.status);
    try {
        return JSON.parse(res.raw.toString('utf8'));
    } catch (error) {
        fail(what + ' body is not JSON: ' + res.raw.toString('utf8').slice(0, 200));
    }
}

const spacedModel = (cap) => winPath(path.join(cap.modelsDir, 'models with spaces', 'spaced model Q4.gguf'));
const plainModel = (cap) => winPath(path.join(cap.modelsDir, 'a', 'model-a.gguf'));
const STUB_VRAM_USAGE = '12345/24576';

async function j0Baseline(cap) {
    await cap.startSession('J0-baseline');
    await cap.get('J0-baseline', 'root', '/');
    await cap.get('J0-baseline', 'swagger', '/swagger');
    await cap.get('J0-baseline', 'swagger-json', '/swagger.json');
    const settings = parseJson(await cap.get('J0-baseline', 'settings-first-run', '/settings'), 'GET /settings');
    assert(settings.success === true, 'first-run GET /settings did not report success');
    assert(settings.settings.serverPort === 8080,
        'first-run GET /settings serverPort is ' + settings.settings.serverPort + ', expected DEFAULT_PORT 8080');
    // The hardcoded C:\Users\anubh default is legacy behaviour read out of the app, not corpus
    // data; it is deliberately kept in the recorded bytes (see the J0 note fixture).
    assert(/\\.lmstudio\\models$/.test(settings.settings.modelsDirectory),
        'first-run modelsDirectory is not the app default branch: ' + settings.settings.modelsDirectory);
    cap.out.json('http', 'J0-baseline', 'first-run-note.json', {
        observation: 'GET /settings with no settings.json in the sandbox answers from server.js own'
            + ' default branch. The personal path in the recorded response is the string hardcoded'
            + ' in server.js at parity-baseline, recorded from the app (C5) — it is not corpus data.',
        recordedDefaultModelsDirectory: settings.settings.modelsDirectory,
        serverPort: settings.settings.serverPort
    }, cap.describeSession('first-run default branch note'));
}

async function j1Settings(cap) {
    const models = winPath(cap.modelsDir);
    const settingsFile = path.join(cap.app, 'settings.json');
    const withPort = parseJson(await cap.post('J1-settings', 'settings-post-with-port', '/settings',
        { modelsDirectory: models, serverPort: 7838 }), 'POST /settings with serverPort');
    assert(withPort.success === true, 'POST /settings with serverPort did not succeed');
    cap.out.copyFrom('ini', 'J1-settings', 'settings.after-with-port.json', settingsFile,
        cap.describeSession('bytes of ' + winPath(settingsFile) + ' after POST /settings {modelsDirectory, serverPort:7838}'));
    const readBack = parseJson(await cap.get('J1-settings', 'settings-read', '/settings'), 'GET /settings');
    assert(readBack.settings.serverPort === 7838, 'GET /settings after the POST shows ' + readBack.settings.serverPort);

    const withoutPort = parseJson(await cap.post('J1-settings', 'settings-post-without-port', '/settings',
        { modelsDirectory: models }), 'POST /settings without serverPort');
    assert(withoutPort.success === true, 'POST /settings without serverPort did not succeed');
    cap.out.copyFrom('ini', 'J1-settings', 'settings.after-without-port.json', settingsFile,
        cap.describeSession('bytes of ' + winPath(settingsFile) + ' after POST /settings WITHOUT serverPort'
            + ' — Q2: the file must say 8080 even though it said 7838'));
    const written = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert(written.serverPort === 8080,
        'Q2 not reproduced: settings.json says serverPort ' + written.serverPort + ', expected 8080');

    for (let index = 1; index <= 3; index += 1) {
        const metrics = parseJson(await cap.get('J1-settings', 'metrics-' + index, '/metrics'), 'GET /metrics');
        assert(Object.keys(metrics).join(',') === 'cpu,ram,gpu,vram,vramUsage',
            '/metrics key set changed: ' + Object.keys(metrics).join(','));
        assert(metrics.vramUsage === STUB_VRAM_USAGE,
            'with the nvidia-smi stub on PATH /metrics vramUsage must be the stub-derived'
            + ' ${total-free}/${total}, got ' + metrics.vramUsage);
    }
    const status = parseJson(await cap.get('J1-settings', 'status', '/status'), 'GET /status');
    assert(status.running === false, 'GET /status on an idle manager should be false');
}

async function j2Models(cap) {
    await cap.startSession('J2-models');
    const body = parseJson(await cap.get('J2-models', 'models', '/models'), 'GET /models');
    assert(body.success === true, 'GET /models did not report success');
    const byRelative = new Map(body.models.map((model) => [model.relativePath.split('\\').join('/'), model]));
    const rel = (p) => p.split('\\').join('/');
    assert(body.models.every((model) => !rel(model.path).split('/').pop().toLowerCase().startsWith('mmproj')),
        'a mmproj file leaked into the /models result (server.js excludes mmproj*)');
    assert(body.models.some((model) => /with spaces/.test(rel(model.path))), 'spaced-path model missing');
    assert(body.models.some((model) => /ünïc/.test(rel(model.path))), 'non-ASCII model missing');
    assert(byRelative.has('a/model-a.gguf') && byRelative.get('a/model-a.gguf').mmprojFile,
        'mmproj association failed for models/a/model-a.gguf');
    assert(byRelative.get('MMProj-case-only/case-probe-model.gguf').mmprojFile === null,
        'association is case-insensitive but server.js matches "mmproj" case-sensitively');
    assert(byRelative.get('a/b/deep-b-model.gguf').mmprojFile === null,
        'a parent-directory mmproj must not be associated with a nested model');
    assert(/mmproj-a\.gguf$/.test(String(byRelative.get('multi-mmproj/multi-model.gguf').mmprojFile)),
        'first-match association failed for models/multi-mmproj');
    assert(!body.models.some((model) => /unreadable/.test(rel(model.path))),
        'the ACL-denied directory was readable — the fixture tree was not denied');
    await cap.stopSession();
}

// plan.md §9 trap 4 lists "unexpected CSV shape" as a simulated-metrics trigger. Recorded evidence
// says otherwise: garbage output does not throw, so gpu/vram stay at their initialised 0 and
// vramUsage is "0/0". Only the throw paths (missing binary, non-zero exit) reach the catch that
// produces the Math.random() values. Legacy output is the oracle (C4), so the journey records the
// zeros and this note fixture keeps the disagreement visible.
async function j2MetricsGarbage(cap) {
    const journey = 'J2b-metrics-garbage';
    await cap.startSession(journey, { stubMode: 'garbage' });
    for (let index = 1; index <= 3; index += 1) {
        const metrics = parseJson(await cap.get(journey, 'metrics-' + index, '/metrics'), 'GET /metrics');
        assert(metrics.gpu === 0 && metrics.vram === 0 && metrics.vramUsage === '0/0',
            'NVIDIA_SMI_STUB_MODE=garbage no longer reports zeros: ' + JSON.stringify(metrics));
        assert(metrics.ram > 0, 'ram should still be measured off the real OS: ' + JSON.stringify(metrics));
    }
    cap.out.json('http', journey, 'shape-note.json', {
        observation: 'With nvidia-smi replying "not a csv", getSystemMetrics() parses the line, finds'
            + ' fewer than 3 comma fields, and returns WITHOUT throwing — so the Math.random() catch'
            + ' branch never runs and /metrics reports gpu=0, vram=0, vramUsage="0/0" alongside real'
            + ' cpu/ram. plan.md §9 trap 4 lists the unexpected CSV shape as a simulated-path trigger;'
            + ' recorded legacy runtime evidence (plan §4 step 1) says it is a silent-zero path.',
        stubMode: 'garbage',
        stubReply: 'not a csv',
        simulatedPathRequires: 'an execSync throw: missing binary or non-zero exit (see J2c-metrics-fail)'
    }, cap.describeSession('garbage-stub shape note'));
    await cap.stopSession();
}

async function j2MetricsSimulated(cap, journey, stubMode) {
    await cap.startSession(journey, { stubMode });
    for (let index = 1; index <= 3; index += 1) {
        const metrics = parseJson(await cap.get(journey, 'metrics-' + index, '/metrics'), 'GET /metrics');
        assert(metrics.vramUsage.endsWith('/8192'),
            journey + ': Q6 simulated path should report the 8 GB simulated total, got ' + metrics.vramUsage);
        assert(metrics.gpu > 0 && metrics.gpu < 50, journey + ': simulated gpu out of the Math.random()*50 band: ' + metrics.gpu);
        assert(metrics.vram > 0 && metrics.vram < 60, journey + ': simulated vram out of the Math.random()*60 band: ' + metrics.vram);
        assert(metrics.vramUsage !== STUB_VRAM_USAGE, journey + ': simulated metrics equals the stub values');
    }
    await cap.stopSession();
}

async function j3StartStop(cap) {
    const journey = 'J3-start-stop';
    await cap.startSession(journey);
    const ws = await WsRecorder.connect(journey, journey + '-c1');
    const before = parseJson(await cap.get(journey, 'status-before', '/status'), 'GET /status');
    assert(before.running === false, 'expected running=false before POST /start');

    const args = realisticStartArgs(cap, spacedModel(cap));
    const start = parseJson(await cap.post(journey, 'start', '/start',
        { serverPath: process.execPath, args }), 'POST /start');
    assert(start.success === true, 'POST /start did not succeed: ' + JSON.stringify(start));
    // Wait for the child to actually boot and stream: /status is true the moment spawn() returns,
    // and stopping before any output would record an empty log stream.
    const streaming = await waitFor('child startup logs', 25000, () => ws.count('log-stream') > 0);
    assert(streaming, 'no log-stream event reached the socket.io client while the server was running');
    await cap.waitForRunning(true);
    parseJson(await cap.get(journey, 'status-running', '/status'), 'GET /status while running');

    const duplicate = await cap.post(journey, 'start-while-running', '/start',
        { serverPath: process.execPath, args });
    const duplicateBody = parseJson(duplicate, 'POST /start while running');
    assert(duplicate.status === 200 && duplicateBody.success === false &&
        duplicateBody.error === 'Server is already running',
        'Q3 not reproduced: /start while running returned ' + duplicate.status + ' ' + duplicate.raw.toString('utf8'));

    // The startup stream has to be captured in full, and that is only possible while the child is
    // alive: /stop kills it and the manager stops forwarding. The fake writes the listening
    // notification last, so an ended-with line means every startup line has been delivered.
    const listeningLine = 'main: server is listening on http://' + args[args.indexOf('--host') + 1]
        + ':' + args[args.indexOf('--port') + 1] + '\n';
    const completeStartup = () => streamConcat(ws, 'stdout').endsWith(listeningLine);
    const startupDone = await waitFor('startup stream delivered in full', 25000, completeStartup);
    assert(startupDone, 'the child never finished streaming its startup lines: ' + JSON.stringify(
        streamConcat(ws, 'stdout').slice(-160)));
    const stdoutSourceLines = streamLineCount(ws, 'stdout');
    const stderrSourceLines = streamLineCount(ws, 'stderr');

    const stop = parseJson(await cap.post(journey, 'stop', '/stop', undefined), 'POST /stop');
    assert(stop.success === true, 'POST /stop did not succeed');
    await cap.waitForRunning(false);
    const ended = await waitFor('server-ended', 10000, () => ws.count('server-ended') > 0);
    assert(ended, 'socket.io client never received server-ended after POST /stop');
    assert(completeStartup(), 'stdout kept growing after POST /stop, so the recorded trace is not a'
        + ' complete startup stream');
    const serverEnded = ws.events.filter((entry) => entry.event === 'server-ended');
    await ws.close();

    assert(ws.events.some((entry) => entry.event === 'log-stream' &&
        Buffer.from(entry.payload.dataBase64, 'base64').toString('utf8').indexOf('\n') < 0),
        'every log-stream payload was a whole line — server.js should forward raw pipe chunks');
    assert(serverEnded.length === 1, 'expected exactly one server-ended event, got ' + serverEnded.length);
    cap.out.json('ws', journey, 'stream-lines.json', {
        stdoutSourceLines, stderrSourceLines,
    note: 'Line counts of the concatenated log-stream payload bytes, recorded after the fake finished'
        + ' streaming and before POST /stop: this journey writes every startup line to stdout, and the'
        + ' listening notification is the last of them. The pane side of the §9 trap 9 claim - newline'
        + ' loss and the per-event .trim() - is recorded by J5-ui-log-cap.'
    }, cap.describeSession('concatenated log-stream payloads of ' + journey + '-c1'));
    cap.out.json('ws', journey, 'events.json', ws.toFixture(),
        cap.describeSession('socket.io-client (default transports) on http://localhost:' + MANAGER_PORT +
            ', every event via socket.onAny, log payloads base64 of the received string'));
    await cap.waitForArgvLines(1);
    cap.recordArgv(journey);
    await cap.stopSession({ journey });
}

async function j3ExitCode(cap) {
    const journey = 'J3b-exit-code';
    await cap.startSession(journey);
    const ws = await WsRecorder.connect(journey, journey + '-c1');
    const args = [winPath(cap.fakeScript), '-m', plainModel(cap), '--port', '17839',
        '--parity-chunks', '0', '--parity-exit-code', '3'];
    const start = parseJson(await cap.post(journey, 'start', '/start',
        { serverPath: process.execPath, args }), 'POST /start');
    assert(start.success === true, 'POST /start did not succeed');
    const ended = await waitFor('server-ended', 20000, () => ws.count('server-ended') > 0);
    assert(ended, 'the child exit did not produce a server-ended event');
    await cap.waitForRunning(false, 10000);
    await ws.close();
    cap.out.json('ws', journey, 'events.json', ws.toFixture(), cap.describeSession(
        'socket.io-client event trace of the child-exit path (exit code 3 via --parity-exit-code)'));
    await cap.waitForArgvLines(1);
    cap.recordArgv(journey);
    await cap.stopSession({ journey });
    const managerLog = fs.readFileSync(path.join(cap.out.out, 'ws', journey, 'manager.stdout.log'), 'utf8');
    assert(/Server process exited with code 3/.test(managerLog),
        'manager stdout does not report the child exit code 3 — see ws/' + journey + '/manager.stdout.log');
}

async function j3MissingPath(cap) {
    const journey = 'J3c-start-missing-path';
    await cap.startSession(journey);
    const missing = await cap.post(journey, 'start-without-serverpath', '/start', { args: ['-m', 'x.gguf'] });
    assert(missing.status === 400, 'Q3 not reproduced: /start without serverPath returned ' + missing.status);
    const body = parseJson(missing, 'POST /start without serverPath');
    assert(body.success === false && body.error === 'Server path is required', 'unexpected body ' + missing.raw.toString('utf8'));
    const stop = await cap.post(journey, 'stop-while-idle', '/stop', undefined);
    assert(stop.status === 200 && parseJson(stop, 'POST /stop idle').success === false,
        'POST /stop while idle should be 200 success:false, got ' + stop.status);
    await cap.stopSession();
}

async function j3Restart(cap) {
    const journey = 'J3d-restart';
    await cap.startSession(journey);
    const noConfig = await cap.post(journey, 'restart-before-any-launch', '/restart', undefined);
    assert(noConfig.status === 400, 'POST /restart with no lastLaunchConfig should be 400, got ' + noConfig.status);

    // No --port here: /restart kills the old child and assigns the replacement in the same tick, so
    // a listening child would make the replacement race the dying one for the port. This journey is
    // about the process bookkeeping, not about the socket.
    const args = [winPath(cap.fakeScript), '-m', plainModel(cap), '--parity-chunks', '0'];
    const start = parseJson(await cap.post(journey, 'start', '/start',
        { serverPath: process.execPath, args }), 'POST /start');
    assert(start.success === true, 'POST /start did not succeed');

    const ws = await WsRecorder.connect(journey, 'J3d-restart-c1');
    await cap.waitForArgvLines(1);
    await cap.waitForRunning(true);
    cap.recordArgv(journey, 'after-start');

    // Express owns unmatched routes, so GET /restart is the framework 404 page, not the app JSON.
    const getRestart = await cap.get(journey, 'restart-get-not-a-route', '/restart');
    assert(getRestart.status === 404, 'GET /restart should be the Express 404, got ' + getRestart.status);

    const restart = await cap.post(journey, 'restart', '/restart', undefined);
    assert(restart.status === 200 && parseJson(restart, 'POST /restart').success === true,
        'POST /restart with lastLaunchConfig should be 200 success:true, got ' + restart.status);

    // Quirk, recorded rather than fixed (proposed ledger row Q23, recorded on win32): the old
    // child's close handler clears the module-level runningProcess after /restart already assigned
    // the replacement (server.js:459-470), so GET /status settles on running:false even though a
    // child was spawned, and POST /stop can no longer reach it. The SIGTERM -> 1 s -> SIGKILL timer
    // /restart armed (server.js:437-445) reads that same variable when it fires, so whether the
    // replacement survives is a race; counts below are shape-compared, and the racing window's
    // stdout bytes are not recorded here because J3-start-stop already owns them.
    // On POSIX the old child receives a deliverable SIGTERM, so its exit ordering differs; the
    // recorded platform is part of this fixture.
    const statusImmediate = await cap.get(journey, 'status-immediately-after-restart', '/status');
    await delay(2000);
    const statusSettled = await cap.get(journey, 'status-after-restart-settle', '/status');
    assert(statusSettled.status === 200 && JSON.parse(statusSettled.raw.toString('utf8')).running === false,
        'expected GET /status to settle on running:false after POST /restart (stale runningProcess), got '
        + statusSettled.raw.toString('utf8'));
    const stopZombie = await cap.post(journey, 'stop-after-restart', '/stop', undefined);
    assert(stopZombie.status === 200 && parseJson(stopZombie, 'POST /stop after /restart').success === false,
        'POST /stop after /restart should be 200 success:false, got ' + stopZombie.status);
    const ended = await waitFor('server-ended after /restart', 15000, () => ws.count('server-ended') > 0);
    assert(ended, 'no server-ended event reached the client after POST /restart');

    const zombie = cap.session;
    const managerText = cap.sessionText(zombie);
    const argvLines = fs.readFileSync(zombie.argvLog, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
    cap.out.json('http', journey, 'restart-settle.json', {
        observation: 'POST /restart answers 200 success:true, but /status settles on running:false: the'
            + ' killed child\'s close handler clears runningProcess after /restart assigned the'
            + ' replacement (server.js:459-470), and POST /stop then returns success:false while the'
            + ' replacement may still be running. The deferred SIGKILL at server.js:437-445 reads the'
            + ' same module-level variable, so the replacement surviving is a race - the counts below'
            + ' differ between runs and are compared through the restart-settle shape rule.',
        recordedOnPlatform: process.platform,
        restartBody: JSON.parse(restart.raw.toString('utf8')),
        statusImmediatelyAfterRestart: JSON.parse(statusImmediate.raw.toString('utf8')),
        statusAfterRestartSettle: JSON.parse(statusSettled.raw.toString('utf8')),
        stopAfterRestart: JSON.parse(stopZombie.raw.toString('utf8')),
        managerExitLines: (managerText.match(/Server process exited with code/g) || []).length,
        argvLines: argvLines,
        serverEndedEvents: ws.count('server-ended')
    }, cap.describeSession('shape-mode settle snapshot of the /restart race (COMPARISON rule restart-settle)'));

    await ws.close();
    // Event identity is the claim here; how many log chunks coalesce and how many terminal events
    // arrive depends on who wins the /restart race.
    cap.out.json('ws', journey, 'event-identity.json', {
        connection: ws.connectionId,
        url: ws.url,
        firstEvent: ws.events.length ? ws.events[0].event : null,
        lastEvent: ws.events.length ? ws.events[ws.events.length - 1].event : null,
        eventNames: [...new Set(ws.events.map((entry) => entry.event))].sort()
    }, cap.describeSession('socket.io event identity across /start -> /restart -> settle;'
        + ' log-stream payload bytes are golden in ws/J3-start-stop/events.json'));
    await cap.stopSession();

    // Q4: lastLaunchConfig lives in memory only, so a fresh manager rejects /restart.
    await cap.startSession(journey, { argvLogName: journey });
    const argvBefore = fs.readFileSync(cap.session.argvLog, 'utf8').split('\n').filter((l) => l.trim() !== '').length;
    const afterRestart = await cap.post(journey, 'restart-after-manager-restart', '/restart', undefined);
    assert(afterRestart.status === 400, 'Q4 not reproduced: POST /restart after a manager restart returned ' + afterRestart.status);
    const argvAfter = fs.readFileSync(cap.session.argvLog, 'utf8').split('\n').filter((l) => l.trim() !== '').length;
    assert(argvAfter === argvBefore, 'a 400 /restart must not spawn anything: argv lines went '
        + argvBefore + ' -> ' + argvAfter);
    cap.out.json('http', journey, 'restart-after-manager-restart.json', {
        status: afterRestart.status,
        body: JSON.parse(afterRestart.raw.toString('utf8'))
    }, cap.describeSession('Q4: lastLaunchConfig is in-memory state, so a restarted manager answers'
        + ' 400 and spawns nothing (the argv log gained no line)'));
    await cap.stopSession({ journey, prefix: 'manager-2' });
}

async function j4LaunchPresets(cap) {
    const journey = 'J4-launch-presets';
    await cap.startSession(journey);
    const settingsFile = path.join(cap.app, 'settings.json');
    const iniFile = path.join(cap.app, 'models-preset.ini');
    // J1 ends on POST /settings without serverPort, which resets the file to DEFAULT_PORT, so the
    // dual-path comparison has to seed 7838 here and prove /launch-presets ignores it.
    const seed = parseJson(await cap.post(journey, 'settings-server-port-7838', '/settings',
        { modelsDirectory: winPath(cap.modelsDir), serverPort: 7838 }), 'POST /settings serverPort 7838');
    assert(seed.success === true, 'POST /settings did not succeed: ' + JSON.stringify(seed));
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert(settings.serverPort === 7838, 'expected settings.json serverPort 7838 for the Q5 dual-path, got ' + settings.serverPort);

    const presets = 'version = 1\n\n[capture-alpha]\nmodel = ' + spacedModel(cap) +
        '\nmmproj = ' + winPath(path.join(cap.modelsDir, 'models with spaces', 'mmproj-spaced model Q4.gguf')) +
        '\ntemp = 0.7\nc = 16384\nspec-type = ngram-mod\nspec-ngram-size-n = 24\ndraft-min = 48\ndraft-max = 64\n\n' +
        '[capture-beta]\nmodel = ' + plainModel(cap) + '\ntop-k = 20\nreasoning = off\n\nport = 7838\n';

    // No serverPort in the body: /launch-presets falls back to DEFAULT_PORT 8080 even though
    // settings.json says 7838, while /start takes --port from the client (Q5 dual path).
    const first = parseJson(await cap.post(journey, 'launch-presets-default-port', '/launch-presets',
        { presets, serverPath: cap.standin }), 'POST /launch-presets');
    assert(first.success === true && first.presetsFile === winPath(iniFile),
        'unexpected /launch-presets body ' + JSON.stringify(first));
    await cap.waitForRunning(true);
    cap.out.copyFrom('ini', journey, 'presets-direct.ini', iniFile,
        cap.describeSession('bytes of ' + winPath(iniFile) + ' written by POST /launch-presets (verbatim copy of the request presets field)'));
    await cap.waitForArgvLines(2);
    const noPortArgv = cap.lastArgv(journey);
    await cap.post(journey, 'stop-after-default-port', '/stop', undefined);
    await cap.waitForRunning(false);

    const second = parseJson(await cap.post(journey, 'launch-presets-explicit-port', '/launch-presets',
        { presets, serverPath: cap.standin, serverPort: 7838 }), 'POST /launch-presets with serverPort');
    assert(second.success === true, 'POST /launch-presets with serverPort did not succeed');
    await cap.waitForRunning(true);
    cap.out.copyFrom('ini', journey, 'presets-direct-with-port.ini', iniFile,
        cap.describeSession('bytes of ' + winPath(iniFile) + ' written by the second POST /launch-presets'));
    await cap.waitForArgvLines(4);
    const withPortArgv = cap.lastArgv(journey);

    const restart = await cap.post(journey, 'restart-after-presets', '/restart', undefined);
    assert(restart.status === 400,
        'POST /restart after a presets launch should still be 400 (/launch-presets never sets'
        + ' lastLaunchConfig), got ' + restart.status);
    await cap.post(journey, 'stop-after-explicit-port', '/stop', undefined);
    await cap.waitForRunning(false);

    const portOf = (argv) => argv[argv.indexOf('--port') + 1];
    assert(portOf(noPortArgv.argv) === '8080',
        'Q5 not reproduced: /launch-presets without serverPort spawned --port ' + portOf(noPortArgv.argv));
    assert(portOf(withPortArgv.argv) === '7838', 'Q5: /launch-presets with serverPort=7838 spawned --port ' + portOf(withPortArgv.argv));
    cap.out.json('argv', journey, 'port-source-evidence.json', {
        settingsJsonServerPort: settings.serverPort,
        launchPresetsWithoutServerPort: { argv: noPortArgv.argv, port: portOf(noPortArgv.argv) },
        launchPresetsWithServerPort: { argv: withPortArgv.argv, port: portOf(withPortArgv.argv) },
        startJourneyPort: '7838 (see argv/J3-start-stop/launch.jsonl, client-supplied --port)'
    }, cap.describeSession('Q5 dual-path summary derived from the argv lines in this journey'));
    await cap.waitForArgvLines(4);
    cap.recordArgv(journey);
    await cap.stopSession({ journey });
}

// The two stand-in routes that node v24 refuses, recorded as evidence for why the journeys use the
// compiled relay (see tools/parity/standin-llama-server.cs).
function spawnProbe(exe, args, env) {
    return new Promise((resolve) => {
        const result = { exe, args, code: null, signal: null, stdout: '', stderr: '', spawnError: null };
        let child;
        try {
            child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(env || {}) } });
        } catch (error) {
            // node throws synchronously for a .cmd/.bat target (CVE-2024-27980), which is precisely
            // the evidence this probe records, so it must not abort the journey.
            result.spawnError = { code: error.code, message: error.message, thrownBySpawn: true };
            resolve(result);
            return;
        }
        let out = '';
        let err = '';
        let spawnError = null;
        child.stdout.on('data', (chunk) => { out += chunk; });
        child.stderr.on('data', (chunk) => { err += chunk; });
        child.on('error', (error) => { spawnError = { code: error.code, message: error.message }; });
        child.on('close', (code, signal) => {
            result.code = code; result.signal = signal; result.stdout = out; result.stderr = err;
            result.spawnError = spawnError;
            resolve(result);
        });
        setTimeout(() => child.kill('SIGKILL'), 8000);
    });
}

async function probeStandIn(cap) {
    const copy = path.join(cap.binDir, 'probe-node-copy.exe');
    fs.copyFileSync(process.execPath, copy);
    const shim = path.join(cap.binDir, 'probe-shim.cmd');
    fs.writeFileSync(shim, '@echo off\r\nnode "%~dp0fake-llama-server.js" %*\r\nexit /b %ERRORLEVEL%\r\n');
    const appArgVector = ['--models-preset', winPath(path.join(cap.app, 'models-preset.ini')),
        '--host', '0.0.0.0', '--port', '8080'];
    const withAppArgs = await spawnProbe(copy, appArgVector);
    const withKnob = await spawnProbe(copy, ['--parity-exit-code', '0']);
    const cmdShim = await spawnProbe(shim, appArgVector);
    const kill = await probeStandInKill(cap);
    return {
        why: 'server.js spawns serverPath without a shell. A copy of node.exe renamed to the app path'
            + ' parses the app-built arg vector as its own CLI options and dies before any preload;'
            + ' node refuses to spawn .cmd/.bat without shell:true. The compiled relay in'
            + ' tools/parity/standin-llama-server.cs is the only stand-in either path can launch.',
        nodeExeCopyWithAppArgVector: withAppArgs,
        nodeExeCopyWithFakeKnob: withKnob,
        cmdShim,
        relayUsedInstead: { exe: cap.standin, fakeScript: winPath(cap.fakeScript) },
        relayKillSemantics: kill
    };
}

// node's Windows kill() is TerminateProcess, which runs no handler in the relay. The relay therefore
// puts the node child in a kill-on-close job object, so a /stop or a manager kill cannot leave a
// grandchild holding the llama-server port; L1/L3 stop tests rely on that being measured here.
async function probeStandInKill(cap) {
    const port = 17899;
    assert(!(await portOpen(port)), 'probe port ' + port + ' is busy; refusing to record a false release');
    const child = spawn(cap.standin,
        ['--host', '127.0.0.1', '--port', String(port), '--parity-chunks', '0'],
        { env: { ...process.env, PARITY_NODE: process.execPath,
            PARITY_FAKE_SCRIPT: winPath(cap.fakeScript), PARITY_ARGV_LOG: '' }, stdio: 'ignore' });
    const bound = await waitFor('stand-in relay bound :' + port, 20000, () => portOpen(port));
    assert(bound, 'the stand-in relay never bound probe port ' + port);
    child.kill('SIGTERM');
    const released = await waitFor('relay port release', 10000, async () => !(await portOpen(port)));
    await waitFor('relay exit', 10000, () => child.exitCode !== null || child.signalCode !== null);
    assert(released, 'killing the stand-in relay left the relayed node child holding port ' + port);
    return {
        port,
        relayBound: bound,
        portReleasedAfterKill: released,
        relayExit: { code: child.exitCode, signal: child.signalCode },
        mechanism: 'JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE wraps the relayed node child, so terminating'
            + ' the relay terminates the tree (a real llama-server.exe is a single process)'
    };
}

async function j5UiStates(cap) {
    const journey = 'J5-ui-states';
    await cap.startSession(journey);
    const viewports = [{ width: 1280, height: 800 }, { width: 1920, height: 1080 }];
    const notes = { screenshotPages: {}, blockedExternalRequests: {}, dialogs: [], metricsStub: SCREENSHOT_METRICS };

    for (const viewport of viewports) {
        const tag = viewport.width + 'x' + viewport.height;
        // The metrics panel renders live CPU/RAM percentages, so the default-state shots use the
        // canned /metrics body as well: two recordings of the same DOM must show the same digits.
        const fresh = await cap.newUiPage({ viewport, mockMetrics: true, freezeClock: true });
        notes.screenshotPages['default-' + tag] = { seed: 'none', mockMetrics: true, frozenClock: true,
            fonts: await cap.fontState(fresh) };
        notes.blockedExternalRequests['default-' + tag] = fresh.blocked;
        if (tag === '1280x800') {
            notes.storageStates = notes.storageStates || {};
            notes.storageStates.fresh = { storage: await cap.dumpStorage(fresh), fields: await cap.dumpFields(fresh) };
        }
        await cap.screenshot(fresh, journey, 'default-' + tag);
        await fresh.context.close();
    }

    for (const viewport of viewports) {
        const tag = viewport.width + 'x' + viewport.height;
        const seeded = await cap.newUiPage({ viewport, seed: cap.smallSeed(17851), mockMetrics: true, freezeClock: true });
        await seeded.page.click('#configList .config-item .config-item-name');
        await seeded.page.waitForSelector('#configList .config-item.active');
        await seeded.page.waitForTimeout(400);
        await cap.screenshot(seeded, journey, 'config-selected-' + tag);

        await seeded.page.click('#settingsBtn');
        await seeded.page.waitForSelector('#settingsDialog[open]');
        await seeded.page.waitForTimeout(400);
        await cap.screenshot(seeded, journey, 'settings-dialog-' + tag);
        await seeded.page.click('#cancelSettingsBtn');
        await seeded.page.waitForTimeout(200);

        seeded.dialogAction = 'dismiss';
        await seeded.page.click('#configList .config-item .delete-btn');
        // A native confirm() is an OS window outside the page surface, and page JS is blocked while
        // it is open, so the pixel evidence is the page state after dismissing it; the dialog text
        // itself is recorded (Q13) in ws/J5-ui-dialogs/dialogs.json.
        await seeded.page.waitForTimeout(400);
        await cap.screenshot(seeded, journey, 'delete-confirm-' + tag);
        notes.dialogs.push(...seeded.dialogs.map((dialog) => ({ ...dialog, state: 'delete-confirm-' + tag })));
        notes.screenshotPages['config-selected-' + tag] = notes.screenshotPages['settings-dialog-' + tag] =
            notes.screenshotPages['delete-confirm-' + tag] =
            { seed: 'smallSeed(17851)', mockMetrics: true, frozenClock: true, fonts: await cap.fontState(seeded) };
        await seeded.context.close();
    }

    const corpus = cap.corpusSeed();
    assert(corpus.configsKey === 'llamaCppConfigs' && corpus.settingsKey === 'llamaCppSettings',
        'corpus localStorage keys are ' + corpus.configsKey + '/' + corpus.settingsKey +
        ', but public/script.js reads llamaCppConfigs/llamaCppSettings');
    const corpusPage = await cap.newUiPage({ seed: corpus, mockMetrics: true, freezeClock: true, settleMs: 800 });
    notes.storageStates['after-corpus-seed'] = {
        storage: await cap.dumpStorage(corpusPage), fields: await cap.dumpFields(corpusPage),
        seededConfigCount: Object.keys(corpus.configs).length
    };
    await corpusPage.context.close();

    const flow = await cap.newUiPage({ seed: cap.smallSeed(17852), mockMetrics: true, freezeClock: true });
    const beta = await configIndex(flow.page, 'capture-beta');
    await flow.page.click(configSelector(beta, '.edit-btn'));
    await flow.page.waitForSelector('#configFormContainer[open]');
    await flow.page.click('#saveConfigBtn');
    await flow.page.waitForTimeout(300);
    notes.storageStates['after-save-config'] = { storage: await cap.dumpStorage(flow), fields: await cap.dumpFields(flow) };

    const selected = await configIndex(flow.page, 'capture-beta');
    await flow.page.click(configSelector(selected, '.config-item-name'));
    await flow.page.waitForSelector('#configList .config-item.active');
    flow.dialogAction = 'accept';
    await flow.page.click(configSelector(selected, '.delete-btn'));
    await flow.page.waitForTimeout(400);
    notes.storageStates['after-delete'] = { storage: await cap.dumpStorage(flow), fields: await cap.dumpFields(flow) };

    // Q8: deleteConfiguration resets only a hard-coded subset, so compare every field value before
    // and after the delete and against the untouched defaults of the fresh page.
    const defaults = new Map(notes.storageStates.fresh.fields.map((field) => [field.id, field]));
    const before = new Map(notes.storageStates['after-save-config'].fields.map((field) => [field.id, field]));
    const after = notes.storageStates['after-delete'].fields;
    notes.q8DeleteReset = {
        note: 'deleteConfiguration resets a hard-coded list that diverges from the HTML defaults'
            + ' (Q8). Every control in the document is compared, not just the 36 persisted fields.',
        controlCount: after.length,
        rows: after.filter((field) => field.id).map((field) => ({
            id: field.id,
            before: before.has(field.id) ? { value: before.get(field.id).value, checked: before.get(field.id).checked } : null,
            after: { value: field.value, checked: field.checked },
            changed: before.has(field.id) && (before.get(field.id).value !== field.value ||
                before.get(field.id).checked !== field.checked),
            equalsHtmlDefault: defaults.has(field.id) && defaults.get(field.id).value === field.value &&
                defaults.get(field.id).checked === field.checked
        })).filter((row) => row.changed)
    };
    assert(notes.q8DeleteReset.rows.length > 0, 'deleting the active config changed no field values'
        + ' — the Q8 partial reset did not happen');

    for (const name of ['fresh', 'after-corpus-seed', 'after-save-config', 'after-delete']) {
        cap.out.json('localstorage', journey, name + '.json', notes.storageStates[name],
            cap.describeSession('localStorage (insertion order) + every form control value, state ' + name));
    }
    cap.out.json('localstorage', journey, 'q8-delete-reset.json', notes.q8DeleteReset,
        cap.describeSession('per-control diff of after-save-config vs after-delete vs fresh defaults'));
    cap.out.json('screenshots', journey, 'state-notes.json', notes,
        cap.describeSession('screenshot provenance: viewport, storage seed, font load state, blocked'
            + ' non-localhost requests, frozen page clock, canned /metrics body'));
    await flow.context.close();
    await cap.stopSession();
}

const decodePayload = (entry) => Buffer.from(entry.payload.dataBase64, 'base64').toString('utf8');

const streamConcat = (ws, type) => ws.events
    .filter((entry) => entry.event === 'log-stream' && entry.payload.type === type)
    .map(decodePayload).join('');

// Concatenated payload bytes per stream type: the line count of that text is what the fake wrote,
// independent of how the socket layer split it across events.
function streamLineCount(ws, type) {
    const text = streamConcat(ws, type);
    if (text === '') return 0;
    return text.replace(/\n$/, '').split('\n').length;
}

async function j5UiLogCap(cap) {
    const journey = 'J5-ui-log-cap';
    await cap.startSession(journey);
    const page = await cap.newUiPage({ seed: cap.smallSeed(17841), mockMetrics: true, freezeClock: true });
    const readPane = () => page.page.evaluate(() => {
        const element = document.getElementById('modelOutput');
        const lines = element.textContent.split('\n');
        return { elementId: element.id, lineCount: lines.length, firstLine: lines[0],
            lastLine: lines[lines.length - 1], text: element.textContent,
            scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
    });

    // #launchBtn reads the selected config; with nothing selected the UI posts an empty serverPath
    // and the manager answers 400, so the log-cap window would never open.
    const alpha = await configIndex(page.page, 'capture-alpha');
    await page.page.click(configSelector(alpha, '.config-item-name'));
    await page.page.waitForSelector('#configList .config-item.active');

    const ws = await WsRecorder.connect(journey, 'J5-ui-log-cap-c1');
    await page.page.click('#launchBtn');
    await cap.waitForRunning(true);
    // Wait for the startup stream to FINISH (two identical reads), not just for a line count: closing
    // the recorder mid-stream would truncate the golden payload bytes at a random point.
    let streamText = '';
    const startup = await waitFor('startup stream finished', 30000, () => {
        const now = streamConcat(ws, 'stdout');
        const settled = now === streamText && now.indexOf('main: server is listening on') >= 0;
        streamText = now;
        return settled;
    });
    assert(startup, 'the UI-launched child never finished streaming its startup lines');

    // Phase 1 records what the default 7-byte chunking leaves in the pane. script.js trims every
    // log-stream payload and appends it as its own line, so chunk fragments become lines and
    // whitespace-only fragments become blank lines. How many payloads coalesce into one event is
    // socket timing, so the payload bytes are the golden (events.json) and only the ratio claim is
    // asserted here (plan.md §9 trap 2).
    const chunks7 = await readPane();
    const sourceLines = streamLineCount(ws, 'stdout');
    const blankPayloads = ws.events.filter((entry) => entry.event === 'log-stream' &&
        decodePayload(entry).trim() === '').length;
    cap.out.json('ws', journey, 'chunk-boundary.json', {
        note: 'Default 7-byte chunks: each log-stream payload becomes one pane line after .trim(), so N'
            + ' source lines become many pane lines and whitespace-only payloads become blank lines.'
            + ' The exact pane line count follows socket coalescing and is shape-compared; the payload'
            + ' bytes are golden in ws/J5-ui-log-cap/events.json.',
        sourceLines,
        blankPayloads,
        paneLines: chunks7.lineCount,
        paneBlankLines: chunks7.text.split('\n').filter((line) => line.trim() === '').length,
        morePaneLinesThanSourceLines: chunks7.lineCount > sourceLines,
        somePayloadsAreWhitespaceOnly: blankPayloads > 0
    }, cap.describeSession('chunk-boundary effect of data.trim() per log-stream event (chunks=7)'));
    cap.out.write('ws', journey, 'log-pane-chunks7.text', chunks7.text,
        cap.describeSession('#modelOutput.textContent after the UI-launched child streamed in 7-byte chunks'));
    await ws.close();
    cap.out.json('ws', journey, 'events.json', ws.toFixture(),
        cap.describeSession('socket.io trace of the chunks=7 startup stream, log payloads base64 of the'
            + ' received string (partial-line assert in COMPARISON rule ws-events)'));

    // Stopping from outside the page leaves the page socket connected (only the UI's own stopServer()
    // disconnects it), so the next spawn streams into the same open pane.
    await cap.post(journey, 'stop-from-driver', '/stop', undefined);
    await cap.waitForRunning(false);
    // /stop arms SIGTERM -> 1 s -> SIGKILL against the module-level runningProcess and clears that
    // variable immediately, so a child started inside the window is killed by the stale timer. Wait
    // it out here; J3d-restart records the /restart form of the same defect.
    await delay(1500);
    await cap.post(journey, 'start-log-flood', '/start', {
        serverPath: cap.standin,
        args: [winPath(cap.fakeScript), '-m', plainModel(cap), '--parity-chunks', '0',
            '--parity-repeat-line', REPEAT_LINE, '--parity-repeat-count', '1203']
    });
    await cap.waitForRunning(true);

    let pane = null;
    const capped = await waitFor('log pane capped at 1000 lines', 180000, async () => {
        pane = await readPane();
        return pane.lineCount === 1000 && String(pane.firstLine).endsWith(REPEAT_LINE);
    });
    assert(capped, 'the log pane never settled at the 1000-line cap, last seen ' + JSON.stringify(pane &&
        { lineCount: pane.lineCount, firstLine: String(pane.firstLine).slice(-45) }));
    const stable = await waitFor('flood finished streaming', 120000, async () => {
        const next = await readPane();
        const same = next.lineCount === pane.lineCount && next.firstLine === pane.firstLine &&
            next.lastLine === pane.lastLine;
        pane = next;
        return same;
    });
    assert(stable, 'the log pane kept changing, so the flood never finished');

    const pinnedToBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2;
    const entries = pane.text.split('\n');
    const oldestEntriesDropped = entries[0].indexOf(REPEAT_LINE) >= 0;
    const trailingSplitElementEmpty = entries[entries.length - 1] === '';
    cap.out.json('ws', journey, 'log-pane.json', {
        elementId: pane.elementId,
        lineCount: pane.lineCount,
        repeatLine: REPEAT_LINE,
        // Booleans rather than the first/last line text: which streamed fragments share one pane entry
        // is pipe timing, so the raw text is compared through the log-pane-capped shape rule while the
        // cap claim itself is asserted here.
        capEvidence: { heldExactlyOneThousandEntries: pane.lineCount === 1000, oldestEntriesDropped,
            trailingSplitElementEmpty, pinnedToBottom },
        note: 'showOutput caps the pane at the last 1000 entries of textContent.split("\n") and then pins'
            + ' scrollTop to scrollHeight (plan.md §9 trap 9). The page clock was frozen for the pixels, and'
            + ' every entry is the same --parity-repeat-line text.'
    }, cap.describeSession('page.evaluate on #modelOutput after the 1212-line flood was capped'));
    cap.out.write('ws', journey, 'log-pane.text', pane.text,
        cap.describeSession('raw #modelOutput.textContent after the flood was capped at 1000 lines'));
    assert(pane.lineCount === 1000, 'expected the cap to hold the pane at exactly 1000 lines, got ' + pane.lineCount);
    assert(oldestEntriesDropped, 'the oldest entries were not dropped by the cap: ' + entries[0].slice(-45));
    assert(trailingSplitElementEmpty, 'expected the trailing split element of the pane split to be empty');
    assert(pinnedToBottom, 'auto-scroll did not pin the pane to the bottom: scrollTop=' + pane.scrollTop +
        ' clientHeight=' + pane.clientHeight + ' scrollHeight=' + pane.scrollHeight);
    await cap.screenshot(page, journey, 'log-pane-1280x800');
    await cap.waitForArgvLines(4);
    cap.recordArgv(journey, 'launches');
    await cap.post(journey, 'stop-after-log-flood', '/stop', undefined);
    await cap.waitForRunning(false);
    await page.context.close();
    await cap.stopSession();
}

async function j5UiCadence(cap) {
    const journey = 'J5-ui-cadence';
    await cap.startSession(journey);
    const page = await cap.newUiPage({ seed: cap.smallSeed(17843), settleMs: 1200 });
    const entries = [];
    const lastByPath = new Map();
    let lastAny = null;
    page.page.on('request', (request_) => {
        const url = new URL(request_.url());
        if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return;
        if (url.pathname !== '/status' && url.pathname !== '/metrics') return;
        const at = Date.now();
        entries.push({ url: request_.url(), path: url.pathname, tMs: at,
            gapFromAnyMs: lastAny === null ? null : at - lastAny,
            gapFromSamePathMs: lastByPath.has(url.pathname) ? at - lastByPath.get(url.pathname) : null });
        lastAny = at;
        lastByPath.set(url.pathname, at);
    });
    const windowMs = 12000;
    // Same launch state J5-ui-log-cap proved: #launchBtn reads the selected config, and with nothing
    // selected the UI validates and aborts before fetch, so no /start would ever be issued.
    const alpha = await configIndex(page.page, 'capture-alpha');
    await page.page.click(configSelector(alpha, '.config-item-name'));
    await page.page.waitForSelector('#configList .config-item.active');
    await page.page.click('#launchBtn');
    const started = Date.now();
    await cap.waitForRunning(true);
    await delay(windowMs);
    const counts = {};
    for (const entry of entries) counts[entry.path] = (counts[entry.path] || 0) + 1;
    cap.out.json('ws', journey, 'request-cadence.json', {
        windowMs: Date.now() - started,
        running: parseJson(await cap.get(journey, 'status-while-running', '/status'), 'GET /status').running,
        counts,
        note: 'fetch URLs the page issued while a server was running, in arrival order, with wall-clock'
            + ' gaps. public/script.js polls /status every 5 s (init) and /metrics every 1 s'
            + ' (startMetricUpdates).',
        entries
    }, cap.describeSession('Playwright page.on(request) for ' + windowMs + ' ms with NVIDIA_SMI_STUB_MODE=ok'));
    assert((counts['/metrics'] || 0) >= 10, 'only ' + (counts['/metrics'] || 0) + ' /metrics requests in the window');
    assert((counts['/status'] || 0) >= 2, 'only ' + (counts['/status'] || 0) + ' /status requests in the window');
    await cap.post(journey, 'stop-after-cadence', '/stop', undefined);
    await cap.waitForRunning(false);
    await page.context.close();
    await cap.stopSession();
}

async function j5UiLaunchProbes(cap) {
    const journey = 'J5-ui-launch';
    await cap.startSession(journey);
    cap.out.json('argv', journey, 'probe-stand-in.json', await probeStandIn(cap),
        cap.describeSession('spawn probes run by capture-legacy.js against a copy of ' +
            winPath(process.execPath) + ' and a .cmd shim in ' + winPath(cap.binDir)));

    const seed = cap.smallSeed(7838);
    const page = await cap.newUiPage({ seed, mockMetrics: true, freezeClock: true });
    const argvLog = cap.session.argvLog;
    const argvLines = () => fs.existsSync(argvLog)
        ? fs.readFileSync(argvLog, 'utf8').split('\n').filter((line) => line.trim() !== '').map(JSON.parse)
        : [];
    const formState = () => page.page.evaluate(() => {
        const select = document.getElementById('modelPath');
        const optionValues = [...select.options].map((option) => option.value);
        return { modelPathValue: select.value,
            modelPathIsAnOption: optionValues.includes(select.value),
            optionCount: optionValues.length,
            serverPathValue: document.getElementById('serverPath').value,
            launchDisabled: document.getElementById('launchBtn').disabled };
    });
    const selectConfig = async (name) => {
        const at = await configIndex(page.page, name);
        await page.page.click(configSelector(at, '.config-item-name'));
        await page.page.waitForSelector('#configList .config-item.active');
        await page.page.waitForTimeout(300);
        return formState();
    };

    // One recorded attempt per Launch click: the form state the click read, the request the page
    // issued (or the dialog that stopped it), and how many stand-in processes the argv log gained.
    const attempts = [];
    const attempt = async (name, fixture, stopFirst) => {
        const form = await selectConfig(name);
        const dialogsBefore = page.dialogs.length;
        const argvBefore = argvLines().length;
        let exchange = null;
        let blockedBeforeRequest = null;
        try {
            exchange = await cap.exchange(page, journey, fixture, '/start', async () => {
                if (stopFirst) {
                    await cap.post(journey, fixture + '-stop-first', '/stop', undefined);
                    await cap.waitForRunning(false);
                    // /stop arms SIGTERM -> 1 s -> SIGKILL on the module-level runningProcess and clears
                    // it at once, so a child started inside that second is killed by the stale timer
                    // (J3d-restart records the /restart form). Wait the window out before relaunching.
                    await delay(1500);
                }
                await page.page.click('#launchBtn');
            });
        } catch (error) {
            blockedBeforeRequest = error.message;
        }
        await delay(2500);
        const status = JSON.parse((await cap.get(journey, fixture + '-status', '/status')).raw.toString('utf8'));
        const record = {
            config: name,
            form,
            requestObserved: exchange !== null,
            requestBlockedWith: blockedBeforeRequest,
            requestStatus: exchange ? exchange.status : null,
            requestBody: exchange && exchange.request.postData ? JSON.parse(exchange.request.postData) : null,
            responseBody: exchange ? JSON.parse(exchange.body.toString('utf8')) : null,
            dialogsDuringAttempt: page.dialogs.slice(dialogsBefore),
            argvLinesBefore: argvBefore,
            argvLinesAfter: argvLines().length,
            runningAfter: status.running
        };
        record.argvLinesGained = record.argvLinesAfter - record.argvLinesBefore;
        attempts.push(record);
        return record;
    };

    const alpha = await attempt('capture-alpha', 'start-from-ui', false);
    assert(alpha.requestStatus === 200, 'the UI POST /start returned ' + alpha.requestStatus);
    assert(alpha.requestBody && alpha.requestBody.args.includes(spacedModel(cap)),
        'the UI-built /start body does not carry the seeded model path');
    assert(alpha.argvLinesGained >= 2, 'the UI launch did not reach the stand-in: argv lines gained '
        + alpha.argvLinesGained);
    assert(alpha.runningAfter === true, 'the page launch did not leave the manager running');

    const beta = await attempt('capture-beta', 'start-from-ui-draft-mtp', true);

    cap.out.json('ws', journey, 'launch-attempts.json', {
        note: 'One entry per #launchBtn click. launchServer validates serverPath then the modelPath'
            + ' <select> (script.js:413-420) and alerts instead of posting /start, and loadConfiguration'
            + ' blanks a modelPath with no matching <option> (Q18), so the form state and the dialog list'
            + ' are recorded next to the argv evidence rather than assumed.',
        argvLog: winPath(argvLog),
        attempts
    }, cap.describeSession('per-click record of form state, page request, dialog text and argv growth'));

    const lines = argvLines();
    // The mmproj association comes from a sibling file whose name starts with 'mmproj' (server.js:233-248),
    // so only the launch whose model sits in that directory can carry it - capture-alpha, not capture-beta.
    const alphaArgv = lines.filter((line) => line.argv.includes(spacedModel(cap))).pop();
    assert(alphaArgv, 'no recorded UI launch carried the seeded spaced model: '
        + JSON.stringify(lines.map((line) => line.argv)));
    assert(alphaArgv.argv.includes('--mmproj'), 'the UI launch did not forward the mmproj association: ' + JSON.stringify(alphaArgv.argv));
    assert(alphaArgv.argv.includes('-fa'), 'Q9: fastAttention auto should emit a bare -fa: ' + JSON.stringify(alphaArgv.argv));
    const fitAt = alphaArgv.argv.indexOf('-fit');
    assert(fitAt >= 0 && alphaArgv.argv[fitAt + 1] === 'off',
        'Q14: -fit off was not appended: ' + JSON.stringify(alphaArgv.argv));
    // Whichever way the second attempt went, it has to be self-consistent: a request that the manager
    // accepted means two more stand-in processes, a blocked click means none and a dialog.
    if (beta.responseBody && beta.responseBody.success === true) {
        assert(beta.argvLinesGained >= 2, 'the beta launch was accepted but spawned nothing: argv growth '
            + beta.argvLinesGained);
        await cap.waitForRunning(true);
    } else {
        assert(beta.dialogsDuringAttempt.length > 0 || beta.requestObserved === false,
            'the beta attempt neither spawned, alerted, nor issued a request: ' + JSON.stringify(beta));
    }

    cap.out.json('localstorage', journey, 'after-ui-launch.json', {
        storage: await cap.dumpStorage(page),
        note: 'launchServer calls saveCurrentValues(currentConfigId), so the launched config is'
            + ' re-written on launch (Q7) and any orphan key in it disappears (Q16).'
    }, cap.describeSession('localStorage after the UI-launch-driven POST /start calls'));
    cap.recordArgv(journey);
    await cap.post(journey, 'stop-after-ui-launch', '/stop', undefined);
    await cap.waitForRunning(false);
    await page.context.close();
    await cap.stopSession();
}

async function j5UiDialogs(cap) {
    const journey = 'J5-ui-dialogs';
    await cap.startSession(journey);
    const page = await cap.newUiPage({ seed: cap.smallSeed(17852), mockMetrics: true, freezeClock: true });

    await page.page.click('#launchBtn');
    await page.page.waitForTimeout(300);

    await page.page.click('#settingsBtn');
    // The settings dialog is createElement('dialog') with class settings-dialog and no id (script.js:63).
    await page.page.waitForSelector('dialog.settings-dialog[open]');
    await page.page.fill('#modelsDirectory', '');
    await page.page.click('#saveSettingsBtn');
    await page.page.waitForTimeout(300);

    await page.page.fill('#modelsDirectory', winPath(cap.modelsDir));
    await page.page.fill('#serverPort', '7838');
    const navigationsBefore = page.navigations;
    await cap.exchange(page, journey, 'settings-from-ui', '/settings',
        () => page.page.click('#saveSettingsBtn'));
    const reloaded = await waitFor('location.reload() after the settings save', 10000,
        async () => page.navigations > navigationsBefore);
    assert(reloaded, 'Q13 not reproduced: saving settings did not trigger location.reload()');
    await page.page.waitForTimeout(500);

    // Save with an empty name: saveConfiguration() alerts and the <dialog> stays open, which then
    // intercepts pointer events on anything behind it (Q13 dialog evidence).
    await page.page.click('#addConfigBtn');
    await page.page.waitForSelector('#configFormContainer[open]');
    const emptyNameAt = page.dialogs.length;
    await page.page.click('#saveConfigBtn');
    await page.page.waitForTimeout(300);
    const emptyNameAlert = page.dialogs.slice(emptyNameAt);
    assert(emptyNameAlert.length === 1 && /configuration name/i.test(emptyNameAlert[0].message),
        'saving a config with no name did not alert: ' + JSON.stringify(emptyNameAlert));
    await page.page.click('#cancelConfigBtn');
    await page.page.waitForFunction(() => !document.getElementById('configFormContainer').open);

    // Delete a config with the confirm accepted; the field-level reset it causes is recorded by
    // J5-ui-states (Q8), so this journey keeps the dialog text and the list length change.
    page.dialogAction = 'accept';
    const configsBefore = await page.page.$$eval('#configList .config-item', (nodes) => nodes.length);
    await page.page.click('#configList .config-item .delete-btn');
    await page.page.waitForTimeout(500);
    const configsAfter = await page.page.$$eval('#configList .config-item', (nodes) => nodes.length);
    const deleteDialogs = page.dialogs.filter((dialog) => /delete the configuration/i.test(dialog.message));
    page.dialogAction = 'dismiss';
    assert(deleteDialogs.length === 1, 'expected one delete confirm dialog, got '
        + JSON.stringify(deleteDialogs));
    assert(configsAfter === configsBefore - 1, 'accepting the delete confirm did not remove one config: '
        + configsBefore + ' -> ' + configsAfter);

    cap.out.json('ws', journey, 'dialogs.json', {
        dialogs: page.dialogs,
        settingsSave: { requestRecordedAs: 'http/' + journey + '/settings-from-ui.request.json',
            mainFrameNavigationsBefore: navigationsBefore, mainFrameNavigationsAfter: page.navigations,
            reloadObserved: reloaded },
        configNameAlert: emptyNameAlert,
        deleteConfirm: { dialogs: deleteDialogs, configsBefore, configsAfter },
        note: 'Native alert/confirm dialogs are OS windows outside the page surface, so they are'
            + ' recorded as type + message text here (Q13). The handler dismissed them unless the'
            + ' journey set accept.'
    }, cap.describeSession('Playwright dialog handler + framenavigated counters'));
    await page.context.close();
    await cap.stopSession();
}

async function j6CorpusSmoke(cap) {
    const journey = 'J6-corpus-smoke';
    const materialised = cap.materialiseCorpusModels();
    await cap.startSession(journey);
    const seed = cap.corpusSeed();
    assert(seed.configsKey === 'llamaCppConfigs' && seed.settingsKey === 'llamaCppSettings',
        'corpus localStorage keys are ' + seed.configsKey + '/' + seed.settingsKey + '; the app reads'
        + ' llamaCppConfigs/llamaCppSettings');
    const page = await cap.newUiPage({ seed, settleMs: 800 });
    await page.page.waitForSelector('#configList .config-item');

    const rendered = await page.page.$$eval('#configList .config-item .config-item-name',
        (nodes) => nodes.map((node) => node.textContent));
    const corpusOrder = Object.keys(seed.configs);
    cap.out.json('localstorage', journey, 'config-list.json', {
        count: rendered.length,
        renderedOrder: rendered,
        corpusInsertionOrder: corpusOrder,
        legacySortReference: [...corpusOrder].sort(),
        renderedEqualsLegacySort: JSON.stringify(rendered) === JSON.stringify([...corpusOrder].sort()),
        corpusModelPathsEnsured: materialised.ensured,
        corpusModelFilesSkipped: materialised.skipped
    }, cap.describeSession('rendered #configList order after seeding the remapped corpus via addInitScript'));
    assert(rendered.length === corpusOrder.length,
        'the config list rendered ' + rendered.length + ' of ' + corpusOrder.length + ' corpus configs');
    assert(JSON.stringify(rendered) === JSON.stringify([...corpusOrder].sort()),
        'rendered order is not the legacy .sort() order');

    const survey = await page.page.evaluate((configsJson) => {
        const select = document.getElementById('modelPath');
        const options = new Set([...select.options].map((option) => option.value));
        const configs = JSON.parse(configsJson);
        return Object.keys(configs).map((name) => ({
            name,
            modelPath: configs[name].modelPath || null,
            matchesOption: options.has(configs[name].modelPath),
            serverPath: configs[name].serverPath || null
        }));
    }, JSON.stringify(seed.configs));
    cap.out.json('localstorage', journey, 'model-path-select-survey.json', {
        note: 'Q18: loadConfiguration assigns config.modelPath to the <select>; a value with no'
            + ' matching <option> blanks it, and launchServer then alerts instead of posting /start.'
            + ' Only configs whose modelPath matches a /models option can be launched on this machine.',
        optionsFromModelsEndpoint: survey.filter((row) => row.matchesOption).length,
        rows: survey
    }, cap.describeSession('direct <select>.value membership probe against the /models option set'));

    const launchable = survey.filter((row) => row.matchesOption).slice(0, 3);
    assert(launchable.length === 3, 'only ' + launchable.length + ' corpus configs have a model in the'
        + ' fixture tree; cannot record the three corpus launches');
    for (let index = 0; index < launchable.length; index += 1) {
        const row = launchable[index];
        const at = await configIndex(page.page, row.name);
        await page.page.click(configSelector(at, '.config-item-name'));
        await page.page.waitForSelector('#configList .config-item.active');
        const launch = () => page.page.click('#launchBtn');
        const trigger = index === 0 ? launch : async () => {
            await cap.post(journey, 'stop-between-corpus-launches-' + index, '/stop', undefined);
            await cap.waitForRunning(false);
            // Out of the /stop stale-SIGKILL window, or the replacement child dies a second after
            // starting and /status settles on running:false.
            await delay(1500);
            await launch();
        };
        await cap.exchange(page, journey, 'start-from-ui-config-' + (index + 1), '/start', trigger);
        await cap.waitForRunning(true);
        await page.page.waitForTimeout(200);
        await cap.waitForArgvLines((index + 1) * 2);
    }
    cap.recordArgv(journey);
    const argv = fs.readFileSync(cap.session.argvLog, 'utf8').split('\n').filter((l) => l.trim() !== '');
    assert(argv.length === 6, 'expected 2 argv lines per corpus launch (relay + relayed fake) x 3 launches, got ' + argv.length);
    await cap.post(journey, 'stop-after-corpus-launches', '/stop', undefined);
    await cap.waitForRunning(false);
    await page.context.close();
    await cap.stopSession();
}

function configIndex(page, name) {
    return page.$$eval('#configList .config-item .config-item-name', (nodes, wanted) => {
        const at = nodes.map((node) => node.textContent).indexOf(wanted);
        if (at < 0) throw new Error('config ' + wanted + ' is not rendered');
        return at;
    }, name);
}

const configSelector = (index, inner) => '#configList .config-item:nth-child(' + (index + 1) + ') ' + inner;

// ---------------------------------------------------- comparison engine (§8 ledger) ---------

function globToRegExp(glob) {
    let out = '^';
    for (let index = 0; index < glob.length; index += 1) {
        const char = glob[index];
        if (char === '*') {
            if (glob[index + 1] === '*') {
                if (glob[index + 2] === '/') { out += '(?:.*/)?'; index += 2; } else { out += '.*'; index += 1; }
            } else out += '[^/]*';
        } else if (char === '?') out += '[^/]';
        else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(out + '$');
}

const NORMALIZE = {
    regexReplace: (text, op) => text.replace(new RegExp(op.pattern, op.flags || 'g'), op.replacement),
    replaceAll: (text, op) => text.split(op.find).join(op.with),
    jsonSubstitute: (text, op) => {
        const value = JSON.parse(text);
        for (const field of op.fields) if (field in value) value[field] = op.placeholder;
        return JSON.stringify(value);
    },
    jsonlSubstitute: (text, op) => text.split('\n').filter((line) => line.trim() !== '').map((line) => {
        const value = JSON.parse(line);
        if (op.field in value) value[op.field] = op.placeholder;
        return JSON.stringify(value);
    }).join('\n'),
    // Chunk coalescing in the pipe/socket layer is timing noise, not behaviour: collapse the
    // log-stream runs into one payload per stream type and compare the concatenated bytes.
    wsCollapseLogStreams: (text, op) => {
        const value = JSON.parse(text);
        const runs = new Map();
        const events = [];
        for (const entry of value.events) {
            if (entry.event !== op.event) { events.push(entry); continue; }
            const key = String(entry.payload[op.typeField]);
            if (!runs.has(key)) {
                runs.set(key, { runOf: key, bytes: Buffer.alloc(0) });
                events.push({ seq: -events.length, event: entry.event,
                    payload: { [op.typeField]: entry.payload[op.typeField], [op.payloadField]: runs.get(key) } });
            }
            const run = runs.get(key);
            run.bytes = Buffer.concat([run.bytes, Buffer.from(entry.payload[op.payloadField], 'base64')]);
        }
        for (const event of events) {
            if (event.payload && event.payload[op.payloadField] && event.payload[op.payloadField].runOf) {
                const run = event.payload[op.payloadField];
                event.payload[op.payloadField] = run.bytes.toString('base64');
                event.payload[op.payloadField + 'ByteLength'] = run.bytes.length;
            }
        }
        // The recorder's seq counts socket events as they arrive, so coalescing changes the number even
        // though nothing about the behaviour changed. Arrival order is still compared - as position.
        events.forEach((event, index) => { if (typeof event.seq === 'number') event.seq = index; });
        return JSON.stringify({ connection: value.connection, url: value.url, events });
    },
    cadenceSymbols: (text, op) => JSON.stringify([...new Set(JSON.parse(text).entries.map((entry) => entry[op.pathField]))].sort())
};

const ASSERT = {
    jsonNumberBounds: (text, rule) => {
        const errors = [];
        const value = JSON.parse(text);
        for (const spec of rule.bounds) {
            const observed = value[spec.field];
            if (typeof observed !== 'number' || !Number.isFinite(observed)) {
                errors.push(spec.field + ' is not a finite number: ' + JSON.stringify(observed));
                continue;
            }
            if (observed < spec.min || observed > spec.max) {
                errors.push(spec.field + '=' + observed + ' outside [' + spec.min + ', ' + spec.max + ']');
            }
            if (spec.minExclusive !== undefined && observed <= spec.minExclusive) errors.push(spec.field + '=' + observed + ' not above ' + spec.minExclusive);
            if (spec.maxExclusive !== undefined && observed >= spec.maxExclusive) errors.push(spec.field + '=' + observed + ' not below ' + spec.maxExclusive);
        }
        return errors;
    },
    fieldRegexMatch: (text, rule) => {
        const value = JSON.parse(text);
        const observed = String(value[rule.field]);
        return new RegExp(rule.pattern).test(observed) ? []
            : [rule.field + '=' + JSON.stringify(observed) + ' does not match /' + rule.pattern + '/'];
    },
    regexFullMatch: (text, rule) => new RegExp(rule.pattern, rule.flags || '' ).test(text) ? []
        : ['content does not match /' + rule.pattern + '/'],
    wsPartialLines: (text, rule) => {
        const value = JSON.parse(text);
        const partial = value.events.filter((entry) => entry.event === rule.event &&
            Buffer.from(entry.payload[rule.payloadField], 'base64').toString('utf8').indexOf('\n') < 0);
        return partial.length >= rule.min ? []
            : ['expected at least ' + rule.min + ' partial-line ' + rule.event + ' payloads, saw ' + partial.length];
    },
    cadenceTiming: (text, rule) => {
        const errors = [];
        const value = JSON.parse(text);
        for (const spec of rule.entries) {
            const seen = value.entries.filter((entry) => entry.path === spec.path);
            const gaps = seen.filter((entry) => typeof entry.gapFromSamePathMs === 'number').map((entry) => entry.gapFromSamePathMs);
            if (seen.length < spec.minCount) errors.push(spec.path + ': expected at least ' + spec.minCount + ' requests, saw ' + seen.length);
            if (spec.maxCount !== undefined && seen.length > spec.maxCount) errors.push(spec.path + ': more than ' + spec.maxCount + ' requests, saw ' + seen.length);
            const outside = gaps.filter((gap) => Math.abs(gap - spec.everyMs) > spec.everyMs * spec.tolerancePct / 100);
            if (outside.length > spec.maxOutside) {
                errors.push(spec.path + ': ' + outside.length + '/' + gaps.length + ' gaps outside '
                    + spec.everyMs + 'ms +/- ' + spec.tolerancePct + '% (e.g. ' + outside.slice(0, 4).join(', ') + ')');
            }
        }
        return errors;
    }
};

function walkFixtures(root) {
    const found = [];
    for (const kind of KINDS) {
        const base = path.join(root, kind);
        if (!fs.existsSync(base)) continue;
        const stack = [base];
        while (stack.length) {
            const dir = stack.pop();
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const abs = path.join(dir, entry.name);
                if (entry.isDirectory()) stack.push(abs);
                else found.push(path.posix.join(kind, path.relative(base, abs).split(path.sep).join('/')));
            }
        }
    }
    return found.sort();
}

function firstDifference(a, b) {
    const limit = Math.min(a.length, b.length);
    let index = 0;
    while (index < limit && a[index] === b[index]) index += 1;
    const from = Math.max(0, index - 40);
    return 'first difference at byte ' + index + ' of ' + a.length + '/' + b.length + '\n    a: '
        + JSON.stringify(a.subarray(from, index + 40).toString('utf8')) + '\n    b: '
        + JSON.stringify(b.subarray(from, index + 40).toString('utf8'));
}

function runCompare(options) {
    const rules = JSON.parse(fs.readFileSync(options.comparison, 'utf8'));
    const a = walkFixtures(options.a);
    const b = walkFixtures(options.b);
    const all = [...new Set(a.concat(b))].sort();
    const failures = [];
    const modes = { exact: 0, shape: 0, informational: 0 };
    for (const rel of all) {
        const fileA = path.join(options.a, rel);
        const fileB = path.join(options.b, rel);
        if (!fs.existsSync(fileA) || !fs.existsSync(fileB)) {
            failures.push(rel + ': present in ' + (fs.existsSync(fileA) ? 'A only' : fs.existsSync(fileB) ? 'B only' : 'neither'));
            continue;
        }
        const rule = rules.rules.find((candidate) => globToRegExp(candidate.pathGlob).test(rel));
        const bytesA = readFileBytes(fileA);
        const bytesB = readFileBytes(fileB);
        if (!rule || rule.mode === 'exact') {
            modes.exact += 1;
            if (!bytesA.equals(bytesB)) failures.push(rel + ': exact-mode byte diff (default rule ' + rules.defaultMode + ')\n    ' + firstDifference(bytesA, bytesB));
            continue;
        }
        if (rule.mode === 'informational') {
            // Declared in COMPARISON.json: the byte claim for this artifact lives in a paired file.
            modes.informational += 1;
            const claims = rule.claimedBy
                ? all.filter((file) => globToRegExp(rule.claimedBy).test(file)) : [];
            if (!rule.claimedBy || claims.length === 0) {
                failures.push(rel + ': informational rule ' + rule.id + ' names no compared artifact ('
                    + (rule.claimedBy || '<missing claimedBy>') + ') for its byte claim');
            }
            if (!rule.claim) {
                failures.push(rel + ': informational rule ' + rule.id + ' has no claim field');
            }
            continue;
        }
        if (rule.mode !== 'shape') { failures.push(rel + ': rule ' + rule.id + ' has unknown mode ' + rule.mode); continue; }
        modes.shape += 1;
        let textA; let textB;
        try {
            textA = bytesA.toString('utf8');
            textB = bytesB.toString('utf8');
        } catch (error) {
            failures.push(rel + ': shape rule cannot read the file as text: ' + error.message);
            continue;
        }
        if (bytesA.equals(bytesB)) continue;
        let normalisedA;
        let normalisedB;
        try {
            normalisedA = (rule.normalize || []).reduce((text, op) => NORMALIZE[op.op](text, op), textA);
            normalisedB = (rule.normalize || []).reduce((text, op) => NORMALIZE[op.op](text, op), textB);
        } catch (error) {
            failures.push(rel + ': rule ' + rule.id + ' could not be normalised: ' + error.message);
            continue;
        }
        if (normalisedA !== normalisedB) {
            failures.push(rel + ': shape rule ' + rule.id + ' still differs after normalisation\n    ' +
                firstDifference(Buffer.from(normalisedA, 'utf8'), Buffer.from(normalisedB, 'utf8')));
        }
        for (const spec of rule.assert || []) {
            for (const [label, text] of [['A', textA], ['B', textB]]) {
                let errors = [];
                try {
                    errors = ASSERT[spec.op](text, spec);
                } catch (error) {
                    errors = ['assert ' + spec.op + ' threw ' + error.message];
                }
                for (const error of errors) failures.push(rel + ': shape rule ' + rule.id + ' assert ' + spec.op + ' failed in ' + label + ': ' + error);
            }
        }
    }
    const counts = {};
    for (const rel of all) {
        const kind = rel.split('/')[0];
        counts[kind] = (counts[kind] || 0) + 1;
    }
    console.log('compare A=' + options.a);
    console.log('compare B=' + options.b);
    console.log('files: ' + all.length + ' (' + JSON.stringify(counts) + '), exact=' + modes.exact + ', shape=' + modes.shape);
    if (failures.length === 0) {
        console.log('DETERMINISM OK: ' + modes.exact + ' files byte-for-byte + ' + modes.shape
            + ' shape-checked (' + path.relative(process.cwd(), options.comparison)
            + '); ' + modes.informational + ' informational artifacts recorded, their claim is a'
            + ' compared paired file');
        return true;
    }
    console.log('DETERMINISM FAIL: ' + failures.length + ' unexplained difference(s)');
    for (const failure of failures.slice(0, 40)) console.log('  - ' + failure);
    if (failures.length > 40) console.log('  ... ' + (failures.length - 40) + ' more');
    return false;
}

// ----------------------------------------------------------- manifest / summary -------------

function legacyCommit(repo) {
    const result = spawnSync('git', ['-C', repo, 'rev-parse', 'parity-baseline^{commit}'], { encoding: 'utf8' });
    assert(result.status === 0, 'git rev-parse parity-baseline failed: ' + result.stderr);
    return result.stdout.trim();
}

function standInProvenance(cap, options) {
    const source = path.join(cap.o.repo, 'tools', 'parity', 'standin-llama-server.cs');
    return {
        source: path.relative(cap.o.repo, source).split(path.sep).join('/'),
        sourceSha256: sha256(readFileBytes(source)),
        exe: winPath(options.standin),
        exeSha256: fs.existsSync(options.standin) ? sha256(readFileBytes(options.standin)) : null,
        rebuildCommand: options.csc,
        note: 'rebuilt from source on every capture run; the exe lives in the scratch sandbox only.'
            + ' Killing the relay also kills the relayed node child (kill-on-close job object), so'
            + ' /stop and manager teardown cannot leave a grandchild on the llama-server port;'
            + ' measured in fixtures/argv/J5-ui-launch/probe-stand-in.json.'
    };
}

// A directory junction must be unlinked with rmdir; rm -rf would walk into the repo node_modules.
// The fixture tree stays behind for capture-legacy.sh, which knows how to lift the ACL deny on its
// unreadable directory before deleting it.
function cleanSandbox(scratch) {
    spawnSync('cmd.exe', ['/c', 'rmdir', winPath(path.join(scratch, 'app', 'node_modules'))], { stdio: 'ignore' });
    for (const part of ['app', 'bin', 'argv']) {
        fs.rmSync(path.join(scratch, part), { recursive: true, force: true });
    }
}

function writeManifest(cap, options, provenance) {
    const manifest = {
        capturedAt: new Date().toISOString(),
        legacyTag: 'parity-baseline',
        legacyCommit: legacyCommit(cap.o.repo),
        capturedBy: {
            script: 'tools/parity/capture-legacy.js',
            command: process.argv.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' '),
            node: process.version, platform: process.platform, arch: process.arch
        },
        sandbox: {
            scratch: winPath(cap.scratch),
            app: winPath(cap.app),
            fixtureTree: winPath(cap.treeRoot),
            modelsDirectory: winPath(cap.modelsDir),
            extraction: 'git -C ' + winPath(cap.o.repo) + ' archive parity-baseline | tar -x -C ' + winPath(cap.app),
            nodeModules: 'cmd //c mklink /J ' + winPath(path.join(cap.app, 'node_modules')) + ' ' + winPath(path.join(cap.o.repo, 'node_modules'))
        },
        standIn: provenance,
        nvidiaSmiStub: { dir: winPath(options.stubDir), modes: ['ok', 'garbage', 'fail'] },
        pathMap: {
            file: 'fixtures/PATH-MAP.json',
            llamaServerExe: 'FIXTURE_ROOT/bin/fake-llama-server.cmd',
            resolvedTo: winPath(options.standin),
            note: 'PATH-MAP.json still carries the .cmd token from the earlier probe harness. Node 24 '
                + 'cannot spawn a .cmd without a shell (CVE-2024-27980), which would change how argv reaches '
                + 'the child, so the capture resolves that token to a compiled .exe stand-in with the same '
                + 'name. The .cmd shim is still probed and its EINVAL recorded in '
                + 'fixtures/argv/J5-ui-launch/probe-stand-in.json.'
        },
        comparisonModes: path.relative(cap.o.repo, options.comparison).split(path.sep).join('/'),
        complete: !cap.o.only,
        journeys: cap.out.entries.reduce((acc, entry) => {
            acc[entry.journey] = (acc[entry.journey] || 0) + 1;
            return acc;
        }, {}),
        fileCount: cap.out.entries.length,
        files: cap.out.entries
    };
    fs.writeFileSync(path.join(cap.out.out, 'MANIFEST.json'), jsonText(manifest));
    return manifest;
}

function verifyManifestCoverage(cap) {
    const recorded = new Set(cap.out.entries.map((entry) => entry.path.replace(/^fixtures\//, '')));
    const onDisk = walkFixtures(cap.out.out);
    const missing = onDisk.filter((rel) => !recorded.has(rel));
    const stale = [...recorded].filter((rel) => !onDisk.includes(rel));
    assert(missing.length === 0, 'MANIFEST.json does not cover: ' + missing.slice(0, 20).join(', '));
    assert(stale.length === 0, 'MANIFEST.json lists files that are not on disk: ' + stale.slice(0, 20).join(', '));
    const counts = {};
    for (const rel of onDisk) counts[rel.split('/')[0]] = (counts[rel.split('/')[0]] || 0) + 1;
    const journeys = [...new Set(cap.out.entries.map((entry) => entry.journey))].sort();
    console.log('journeys (' + journeys.length + '): ' + journeys.join(' '));
    console.log('files per dir: ' + JSON.stringify(counts) + ' total=' + onDisk.length);
    return { onDisk, counts, journeys };
}

async function runCapture(cap) {
    const steps = [
        { names: ['J0-baseline', 'J1-settings'], run: async () => { await j0Baseline(cap); await j1Settings(cap); await cap.stopSession(); } },
        { names: ['J2-models'], run: () => j2Models(cap) },
        { names: ['J2b-metrics-garbage'], run: () => j2MetricsGarbage(cap) },
        { names: ['J2c-metrics-fail'], run: () => j2MetricsSimulated(cap, 'J2c-metrics-fail', 'fail') },
        { names: ['J3-start-stop'], run: () => j3StartStop(cap) },
        { names: ['J3b-exit-code'], run: () => j3ExitCode(cap) },
        { names: ['J3c-start-missing-path'], run: () => j3MissingPath(cap) },
        { names: ['J3d-restart'], run: () => j3Restart(cap) },
        { names: ['J4-launch-presets'], run: () => j4LaunchPresets(cap) },
        { names: ['J5-ui-states'], run: () => j5UiStates(cap) },
        { names: ['J5-ui-log-cap'], run: () => j5UiLogCap(cap) },
        { names: ['J5-ui-cadence'], run: () => j5UiCadence(cap) },
        { names: ['J5-ui-launch'], run: () => j5UiLaunchProbes(cap) },
        { names: ['J5-ui-dialogs'], run: () => j5UiDialogs(cap) },
        { names: ['J6-corpus-smoke'], run: () => j6CorpusSmoke(cap) }
    ];
    for (const step of steps) {
        if (cap.o.only && !step.names.some((name) => cap.o.only.has(name))) continue;
        console.log('--> ' + step.names.join(' + '));
        await step.run();
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.mode === 'compare') return runCompare(options) ? 0 : 1;
    for (const flag of ['scratch', 'standin', 'stubDir']) {
        assert(options[flag], '--' + flag + ' is required for --capture (run through tools/parity/capture-legacy.sh)');
    }
    const cap = new Capture(options);
    const provenance = standInProvenance(cap, options);
    assert(fs.existsSync(options.standin), 'stand-in exe missing at ' + options.standin +
        ' — the app-built-arg-vector journeys (J4/J5-ui-launch/J6) cannot be recorded; they are '
        + 'blocked, not skipped');
    try {
        await runCapture(cap);
    } finally {
        await WsRecorder.closeAll();
        await cap.closeBrowser().catch(() => {});
        await cap.stopSession().catch(() => {});
    }
    if (cap.o.only) {
        // A filtered run is a debugging pass: MANIFEST coverage and the determinism gate describe a
        // complete capture, so neither is claimed here.
        console.log('filtered run (' + [...cap.o.only].join(',') + '): MANIFEST.json not written');
        return 0;
    }
    // The sandbox is disposable; every byte that matters is already under the fixture tree.
    cleanSandbox(cap.scratch);
    writeManifest(cap, options, provenance);
    verifyManifestCoverage(cap);
    console.log('captured ' + cap.out.entries.length + ' fixture files into ' + cap.out.out);
    return 0;
}

// Fixture writes are synchronous, so an explicit exit is safe, and it keeps a reconnecting
// socket.io client or an inherited stdio pipe from holding a finished (or failed) run open.
main().then((code) => process.exit(code), (error) => {
    console.error('capture-legacy: ' + (error && error.stack ? error.stack : error));
    if (LAST_MANAGER_LOG) {
        console.error('last manager log: ' + LAST_MANAGER_LOG);
        // capture-legacy.sh removes the sandbox on exit, so keep the evidence outside it.
        try {
            const diag = path.join(path.dirname(LAST_MANAGER_LOG), '..', 'parity-diagnostics');
            fs.mkdirSync(diag, { recursive: true });
            const dest = path.join(diag, path.basename(LAST_MANAGER_LOG));
            fs.copyFileSync(LAST_MANAGER_LOG, dest);
            console.error('copied to ' + dest);
        } catch (copyError) {
            console.error('could not copy the manager log: ' + copyError.message);
        }
    }
    process.exit(1);
});
