'use strict';

// Sandbox lifecycle for the L1 backend conformance suite.
//
// This is the suite's own copy of what tools/parity/capture-legacy.sh does before it records:
// extract the app from a git ref into a scratch root outside the repo, junction node_modules into
// it, build the fixture model tree, compile the stand-in llama-server, put the nvidia-smi stub on
// PATH, then run server.js with the recorder environment (§10 blast radius: the repo's own
// settings.json / models-preset.ini / model dirs are never touched).
//
// It is deliberately the SAME scratch root layout as the recording pass, because the recorded
// bytes embed absolute scratch paths (fixtures/COMPARISON.json records that as an unrelaxed
// §8 row): running somewhere else is a different corpus, not a comparable one.

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const MANAGER_PORT_DEFAULT = 7837;
const JOURNEY_PORTS = [7837, 7838, 8080, 17839, 17840, 17841, 17842, 17843, 17844, 17899];

const winPath = (value) => String(value).replace(/[\\/]+/g, '\\');
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
        await delay(25);
    }
    return predicate();
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

// capture-legacy.sh refuses a scratch root inside the repo and keeps the 'parity-scratch' name,
// which is the root fixtures/PATH-MAP.json + the recorded bytes carry. Same guard here.
function resolveScratch(options) {
    const scratch = options.scratch || process.env.PARITY_SCRATCH || 'C:/parity-scratch';
    const absolute = path.resolve(scratch);
    assert(/^[A-Za-z]:[\\/]/.test(absolute), 'scratch must be a windows absolute path, got ' + scratch);
    assert(absolute !== options.repo && !absolute.startsWith(options.repo + path.sep),
        'refusing to use a scratch dir inside the repo: ' + absolute);
    return absolute;
}

function findCsc() {
    const candidates = [process.env.PARITY_CSC,
        'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
        'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'];
    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return null;
}

class Sandbox {
    constructor(options) {
        this.repo = options.repo;
        this.ref = options.ref || 'parity-baseline';
        this.scratch = resolveScratch(options);
        this.app = path.join(this.scratch, 'app');
        this.treeRoot = path.join(this.scratch, 'fixtures');
        this.modelsDir = path.join(this.treeRoot, 'models');
        this.binDir = path.join(this.scratch, 'bin');
        this.logDir = path.join(this.scratch, 'runs');
        this.fakeScript = path.join(this.binDir, 'fake-llama-server.js');
        this.standin = path.join(this.binDir, 'fake-llama-server.exe');
        this.stubDir = options.stubDir || path.join(options.repo, 'tools', 'parity', 'nvidia-smi-stub');
        this.port = options.port || MANAGER_PORT_DEFAULT;
        this.sessions = [];
        this.sessionIndex = 0;
    }

    // --------------------------------------------------------------- build ----------------

    prepare({ clean = true } = {}) {
        if (clean) this.cleanTree();
        for (const dir of [this.app, this.binDir, this.logDir, this.treeRoot]) {
            fs.mkdirSync(dir, { recursive: true });
        }
        if (this.ref === 'worktree') {
            this.copyWorktreeApp();
        } else {
            this.extractRef();
        }
        assert(fs.existsSync(path.join(this.app, 'server.js')),
            'the sandbox app has no server.js: ' + this.app);
        this.junctionNodeModules();
        this.buildFixtureTree();
        this.buildStandIn();
        return this;
    }

    run(command, args, options = {}) {
        const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
        if (result.error) fail(command + ' failed to start: ' + result.error.message);
        return result;
    }

    // git archive | tar, the same extraction capture-legacy.sh does. Written to a file instead of a
    // pipe: a tar stream is binary, and shelling out through a POSIX tar mangles Windows paths.
    extractRef() {
        const tarFile = path.join(this.scratch, 'app.tar');
        fs.rmSync(tarFile, { force: true });
        const archive = this.run('git', ['-C', this.repo, 'archive', '--format=tar', '-o',
            winPath(tarFile), this.ref]);
        assert(archive.status === 0 && fs.existsSync(tarFile), 'git archive ' + this.ref + ' failed: ' +
            (archive.stderr || archive.stdout));
        const tar = fs.existsSync('C:/Windows/System32/tar.exe') ? 'C:/Windows/System32/tar.exe' : 'tar';
        const write = this.run(tar, ['-xf', winPath(tarFile), '-C', winPath(this.app)]);
        assert(write.status === 0, 'tar could not extract ' + this.ref + ': ' + (write.stderr || write.stdout));
        fs.rmSync(tarFile, { force: true });
    }

    // Part 2 candidate mode: the working tree's own app files, node_modules junctioned exactly as
    // in a recorded run. Used by nothing in Part 1 except the negative-control loop.
    copyWorktreeApp() {
        for (const part of ['server.js', 'package.json']) {
            const source = path.join(this.repo, part);
            assert(fs.existsSync(source), 'worktree sandbox: ' + part + ' is missing');
            fs.copyFileSync(source, path.join(this.app, part));
        }
        for (const part of ['public', 'legacy']) {
            const source = path.join(this.repo, part);
            if (!fs.existsSync(source)) continue;
            this.run('cmd.exe', ['/c', 'xcopy', '/E', '/I', '/Q', '/Y', winPath(source),
                winPath(path.join(this.app, part)) + '\\']);
        }
    }

    // A junction is unlinked with rmdir, never with rm -rf, so no recursive delete can walk into
    // the repo's node_modules.
    junctionNodeModules() {
        const target = path.join(this.app, 'node_modules');
        if (fs.existsSync(target)) {
            spawnSync('cmd.exe', ['/c', 'rmdir', winPath(target)], { stdio: 'ignore' });
        }
        const link = spawnSync('cmd.exe', ['/c', 'mklink', '/J', winPath(target), winPath(path.join(this.repo, 'node_modules'))],
            { stdio: 'ignore' });
        assert(link.status === 0 || fs.existsSync(path.join(target, 'express')),
            'mklink /J failed for the node_modules junction');
        assert(fs.existsSync(path.join(target, 'express', 'package.json')),
            'the node_modules junction is not readable');
    }

    buildFixtureTree() {
        const script = path.join(this.repo, 'tools', 'parity', 'fixture-tree.sh');
        assert(fs.existsSync(script), 'fixture-tree.sh is missing at ' + script);
        const built = this.run('bash', [winPath(script), winPath(this.treeRoot), 'build']);
        assert(built.status === 0, 'fixture-tree.sh build failed: ' + (built.stderr || built.stdout));
        assert(fs.existsSync(this.modelsDir), 'the fixture tree has no models/ directory');
    }

    // tools/parity/standin-llama-server.cs is the only stand-in server.js can spawn without a
    // shell; the exe is a scratch build artifact, never committed.
    buildStandIn() {
        fs.copyFileSync(path.join(this.repo, 'tools', 'parity', 'fake-llama-server.js'), this.fakeScript);
        const csc = findCsc();
        assert(csc, 'no csc.exe found — the app-built-arg-vector checks (/launch-presets) cannot run');
        fs.rmSync(this.standin, { force: true });
        const built = this.run(csc, ['-nologo', '-target:exe', '-out:' + winPath(this.standin),
            winPath(path.join(this.repo, 'tools', 'parity', 'standin-llama-server.cs'))]);
        assert(built.status === 0 && fs.existsSync(this.standin),
            'csc failed to build the stand-in: ' + (built.stdout || '') + (built.stderr || ''));
    }

    async checkPorts() {
        const busy = [];
        for (const port of JOURNEY_PORTS) {
            if (await portOpen(port)) busy.push(port);
        }
        assert(busy.length === 0, 'port(s) ' + busy.join(', ') + ' already in use — refusing to kill an'
            + ' unknown process; free them and re-run');
    }

    // ---------------------------------------------------------------- session ----------------

    // Mirrors capture-legacy.js startSession: the nvidia-smi stub first on PATH, the recorder env
    // the stand-in reads, MODEL_PATH removed so the settings file is what drives /models.
    // Re-starting under the same name keeps the same argv / chunk log, which is what lets a group
    // observe 'the argv log gained nothing' across a manager restart (Q4).
    async startSession(name, options = {}) {
        assert(!this.session, this.session ? 'session ' + this.session.name + ' is still running'
            : 'no session should be running');
        const argvLog = path.join(this.scratch, 'argv-' + name + '.jsonl');
        const chunkLog = path.join(this.scratch, 'chunks-' + name + '.jsonl');
        if (!options.keepLogs) {
            for (const file of [argvLog, chunkLog]) fs.rmSync(file, { force: true });
        }
        const env = { ...process.env };
        delete env.MODEL_PATH;
        env.PATH = winPath(this.stubDir) + ';' + (env.PATH || '');
        env.NVIDIA_SMI_STUB_MODE = options.stubMode || 'ok';
        env.PARITY_ARGV_LOG = winPath(argvLog);
        env.PARITY_CHUNK_LOG = winPath(chunkLog);
        env.PARITY_NODE = process.execPath;
        env.PARITY_FAKE_SCRIPT = winPath(this.fakeScript);

        assert(!(await portOpen(this.port)),
            'port ' + this.port + ' is busy; refusing to kill an unknown process');
        this.sessionIndex += 1;
        const logPath = path.join(this.logDir, this.sessionIndex + '-' + name + '.manager.log');
        const child = spawn(process.execPath, [winPath(path.join(this.app, 'server.js'))], {
            cwd: winPath(this.app), env, stdio: ['ignore', 'pipe', 'pipe']
        });
        const session = { name, stubMode: options.stubMode || 'ok', argvLog, chunkLog, child,
            stdout: [], stderr: [], closed: false, logPath };
        const tee = fs.createWriteStream(logPath);
        child.stdout.on('data', (chunk) => { session.stdout.push(chunk); tee.write(chunk); });
        child.stderr.on('data', (chunk) => { session.stderr.push(chunk); tee.write(chunk); });
        child.on('close', (code, signal) => {
            session.closed = true;
            session.result = { code, signal };
            tee.end();
        });
        this.session = session;
        this.sessions.push(session);

        const up = await waitFor('manager listening on :' + this.port, 30000, () => portOpen(this.port));
        assert(up, 'the manager never started listening on ' + this.port + ' — ' + logPath);
        // server.js answers /metrics from its zeroed initial state until the first 1 s sample
        // lands; ram is the readiness signal because gpu/vram legitimately stay 0 in some stub modes.
        const sampled = await waitFor('first metrics sample', 30000, async () => {
            try {
                const res = await this.request('GET', '/metrics');
                return res.status === 200 && JSON.parse(res.raw.toString('utf8')).ram > 0;
            } catch (error) {
                return false;
            }
        });
        assert(sampled, 'the manager never produced a metrics sample — ' + logPath);
        return session;
    }

    async restartSession(name) {
        const previous = this.session;
        const stubMode = previous ? previous.stubMode : 'ok';
        await this.stopSession();
        await this.startSession(name, { stubMode, keepLogs: true });
        return this.session;
    }

    // Text the manager itself printed since the session started.
    sessionText(session = this.session) {
        return Buffer.concat(session.stdout).toString('utf8') + Buffer.concat(session.stderr).toString('utf8');
    }

    argvLines(session = this.session) {
        if (!fs.existsSync(session.argvLog)) return [];
        return fs.readFileSync(session.argvLog, 'utf8').split('\n').filter((line) => line.trim() !== '');
    }

    chunkRecords(source) {
        if (!fs.existsSync(this.session.chunkLog)) return [];
        return fs.readFileSync(this.session.chunkLog, 'utf8').split('\n')
            .filter((line) => line.trim() !== '')
            .map((line) => JSON.parse(line))
            .filter((record) => record.source === source);
    }

    async waitForArgvLines(count, timeoutMs) {
        const ok = await waitFor('argv lines >= ' + count, timeoutMs || 30000,
            () => this.argvLines().length >= count);
        assert(ok, 'the argv log never reached ' + count + ' line(s): ' + this.session.argvLog);
    }

    async stopSession() {
        const session = this.session;
        this.session = null;
        if (!session) return { code: null, signal: null };
        try {
            await this.request('POST', '/stop');
            await waitFor('child stopped', 10000, async () =>
                JSON.parse((await this.request('GET', '/status')).raw.toString('utf8')).running === false);
        } catch (error) { /* the manager may already be gone */ }
        if (!session.closed) {
            session.child.kill('SIGTERM');
            if (!(await waitFor('manager exit', 10000, () => session.closed))) {
                spawnSync('cmd.exe', ['/c', 'taskkill', '/T', '/F', '/PID', String(session.child.pid)], { stdio: 'ignore' });
            }
            await waitFor('manager close', 10000, () => session.closed);
            await delay(150);
        }
        this.sweepChildren(session);
        return session.result || { code: null, signal: null };
    }

    // A manager that lost its child handle (the /restart quirk) cannot stop that child, and on
    // Windows TerminateProcess leaves a relayed grandchild behind holding the llama-server port.
    sweepChildren(session) {
        const pids = this.argvLines(session)
            .map((line) => { try { return JSON.parse(line).pid; } catch (error) { return null; } })
            .filter((pid) => Number.isInteger(pid) && pid !== process.pid);
        if (pids.length === 0) return [];
        const filter = pids.map((pid) => 'ProcessId=' + pid).join(' or ');
        const listing = spawnSync('powershell.exe', ['-NoProfile', '-Command',
            'Get-CimInstance Win32_Process -Filter "' + filter + '" | ForEach-Object { $_.ProcessId.ToString() + "|" + $_.CommandLine }'],
            { encoding: 'utf8' });
        const killed = [];
        for (const line of String(listing.stdout || '').split('\n')) {
            const split = line.indexOf('|');
            if (split < 0) continue;
            const pid = Number.parseInt(line.slice(0, split), 10);
            const commandLine = line.slice(split + 1).toLowerCase();
            if (!Number.isInteger(pid) || commandLine.indexOf('fake-llama-server') < 0) continue;
            spawnSync('cmd.exe', ['/c', 'taskkill', '/F', '/PID', String(pid)], { stdio: 'ignore' });
            killed.push(pid);
        }
        return killed;
    }

    // Only HTTP: the suite talks to the app the same way a browser would.
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
            const req = http.request({
                host: '127.0.0.1', port: this.port, method, path: route,
                agent: new http.Agent({ keepAlive: false }), headers: sendHeaders
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

    settingsFile() {
        return path.join(this.app, 'settings.json');
    }

    iniFile() {
        return path.join(this.app, 'models-preset.ini');
    }


    // -------------------------------------------------------------- teardown ----------------

    unlockTree() {
        const script = path.join(this.repo, 'tools', 'parity', 'fixture-tree.sh');
        if (fs.existsSync(script) && fs.existsSync(this.treeRoot)) {
            spawnSync('bash', [winPath(script), winPath(this.treeRoot), 'unlock'], { stdio: 'ignore' });
        }
    }

    cleanTree() {
        this.unlockTree();
        spawnSync('cmd.exe', ['/c', 'rmdir', winPath(path.join(this.app, 'node_modules'))], { stdio: 'ignore' });
        fs.rmSync(this.scratch, { recursive: true, force: true });
    }
}

module.exports = { Sandbox, assert, delay, waitFor, portOpen, winPath, fail };
