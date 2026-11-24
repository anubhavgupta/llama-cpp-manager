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

const { Sandbox, assert, delay, waitFor, winPath } = require('../../L1-backend/lib/sandbox');
const { PathMap, winPath: backslash } = require('./pathmap');

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
    async waitForIniChange(previous, timeoutMs) {
        const waitFor = require('../../L1-backend/lib/sandbox').waitFor;
        return waitFor('models-preset.ini rewritten', timeoutMs || 20000, () => {
            const now = this.iniBytes();
            if (!now) return false;
            return previous === null || !now.equals(previous);
        });
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

    async stopAndWait() {
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
        // Q24: /stop arms a SIGKILL for one more second, so a relaunch inside that window is killed.
        await delay(1500);
    }
}

module.exports = { SeamSandbox, assert, delay, waitFor, winPath };
