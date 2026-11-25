'use strict';
// L3 seam conformance runner (plan §2 Phase 4 row L3).
//
//   node tests/L3-seam/run.js --verify-against-selftest          # legacy sandbox, must be 100% green
//   node tests/L3-seam/run.js --verify-against-selftest --repeat 2
//   node tests/L3-seam/run.js --ref <git-ref|worktree|dir> --only models,argv
//
// This is the only layer where the browser, the real manager and the fake binary are all live: the
// page is served by server.js from the sandbox checkout, fetch and socket.io reach the real routes,
// and the child the manager spawns is the compiled stand-in that records the argv it was handed
// (tests/L1-backend/lib/sandbox.js builds that sandbox, unchanged).
//
// §6.1: base URL, ref, scratch root and binary are env/flag driven and no suite file imports app
// code — the gate below greps for it. The manager port is not configurable because server.js
// hardcodes 7837 (Q11); L4 sequences its two refs for that reason.

const fs = require('fs');
const path = require('path');

const { SeamSandbox } = require('./helpers/sandbox');
const { Registry, diffText } = require('../L1-backend/lib/harness');
const parityLock = require('../../tools/parity/parity-lock.js');

const HERE = __dirname;
const REPO = path.resolve(__dirname, '..', '..');
const GROUPS = [
    { name: 'seam', checks: require('./checks/seam') },
    { name: 'corpus', checks: require('./checks/corpus') }
];

function fail(id, detail) {
    const error = new Error(id + ': ' + detail);
    error.id = id;
    throw error;
}

function assert(condition, id, detail) {
    if (!condition) fail(id, detail);
}

function parseArgs(argv) {
    const options = { ref: 'parity-baseline', repeat: 1, verify: false, keepScratch: false };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        const next = () => {
            index += 1;
            assert(index < argv.length, 'L3-ARG', 'missing value for ' + token);
            return argv[index];
        };
        if (token === '--verify-against-selftest') options.verify = true;
        else if (token === '--ref') options.ref = next();
        else if (token === '--app') options.app = next();
        else if (token === '--scratch') options.scratch = next();
        else if (token === '--repeat') options.repeat = Number.parseInt(next(), 10);
        else if (token === '--only') options.only = new Set(next().split(',').map((name) => name.trim()));
        else if (token === '--keep-scratch') options.keepScratch = true;
        else fail('L3-ARG', 'unknown argument: ' + token);
    }
    assert(Number.isInteger(options.repeat) && options.repeat >= 1, 'L3-ARG',
        '--repeat needs a positive integer');
    assert(options.verify || options.app || options.attach, 'L3-ARG',
        'choose --verify-against-selftest, or --app <dir> to point the seam suite at an existing'
        + ' sandbox checkout (negative controls, Part 2 candidate)');
    return options;
}

// §6.1: the seam suite drives the app over HTTP and Playwright; it must never load app code into
// node, because that would let a green run validate the repo's own modules instead of the sandbox's.
function enforceNoAppImports() {
    const offenders = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== 'out') walk(full);
                continue;
            }
            if (!/\.js$/.test(entry.name)) continue;
            const text = fs.readFileSync(full, 'utf8');
            for (const match of text.matchAll(/require\((['"])([^'"]+)\1\)/g)) {
                const target = match[2];
                if (/(^|[\\/])(public|legacy)([\\/]|$)/.test(target) || /server\.js$/.test(target)
                    || /public[\\/]script\.js$/.test(target)) {
                    offenders.push(path.relative(HERE, full) + ' requires ' + target);
                }
            }
        }
    };
    walk(HERE);
    assert(offenders.length === 0, 'L3.NO-APP-IMPORTS',
        'the L3 suite imports app code, which §6.1 forbids: ' + offenders.join(', '));
}

// Every byte diff this suite reports goes through the L1 harness's diffText. A red at byte 0 used to
// print "" for both sides because the excerpt sliced 40 bytes to the LEFT of byte 0, i.e. off the end
// of the string (AUDIT-2026-11-25 finding N5) — so the guard proves on every run that a difference at
// byte 0 prints the leading bytes of both sides, and that the size line distinguishes a short file
// from a differing one.
function enforceDiffExcerpt() {
    const expected = 'version = 1\n'
        + '[Config 0]\nmodel = C:/parity-scratch/fixtures/models/m0.gguf\n'.repeat(6);
    const actual = 'x' + expected.slice(1);
    const diff = diffText(expected, actual, 'unit:byte-zero-diff');
    const excerpt = (tag) => {
        const match = new RegExp(tag + ':\\s+"([^"]*)').exec(diff);
        return match ? match[1] : null;
    };
    assert(excerpt('expected') !== null && excerpt('expected').startsWith('version = 1')
        && excerpt('actual') !== null && excerpt('actual').startsWith('xersion = 1')
        && diff.includes('first difference at byte 0')
        && diff.includes('expected ' + expected.length + ' bytes, got ' + actual.length),
        'L3.DIFF-EXCERPT', 'a difference at byte 0 must print the leading bytes of both sides and'
            + ' both sizes, got ' + JSON.stringify(diff));
}

// Every executed check id has to be listed in CHECKS.md with the quirk it pins, so a new check
// cannot land without being read (the same discipline L1 enforces on itself).
function enforceChecksIndex(results) {
    const file = path.join(HERE, 'CHECKS.md');
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const missing = results.filter((entry) => !text.includes(entry.id));
    assert(missing.length === 0, 'L3.CHECKS-MD',
        (text ? 'CHECKS.md does not list ' : 'tests/L3-seam/CHECKS.md is missing; ')
        + (missing.length ? missing.length + ' check id(s): '
            + missing.map((entry) => entry.id).join(', ') : ''));
}

class Context {
    constructor(manager, browser, registry) {
        this.manager = manager;
        this.browser = browser;
        this.registry = registry;
        this.notes = {};
    }

    check(id, quirk, fn) { return this.registry.check(id, quirk, fn); }

    note(area, text) { this.notes[area] = text; }
}

async function runOnce(options, attempt, browser) {
    const registry = new Registry();
    const manager = new SeamSandbox({ repo: REPO, ref: options.ref, scratch: scratchRoot(options),
        appDir: options.app, port: 7837 });
    const notes = {};
    console.log('== L3 sandbox ' + manager.scratch + '  ref=' + (options.app || options.ref));
    manager.prepare();
    await manager.checkPorts();
    await manager.startSession('L3-seam-' + attempt, { stubMode: 'ok' });
    const context = new Context(manager, browser, registry);
    context.note = (area, text) => { notes[area] = text; };
    try {
        for (const group of GROUPS) {
            const checks = group.checks.filter((check) => !options.only || options.only.has(check.id));
            if (!checks.length) continue;
            console.log('--> group ' + group.name + ': ' + checks.map((check) => check.id).join(', '));
            for (const check of checks) {
                try {
                    await check.run(context);
                } catch (error) {
                    await registry.check('L3-CHECK-THREW-' + check.id, 'harness', () => {
                        throw error;
                    });
                }
                // A check that leaves a child running would make the next check's launch answer
                // 200-with-success:false (Q3) instead of spawning.
                await manager.stopAndWait();
            }
        }
    } finally {
        await manager.stopSession().catch(() => {});
        if (!options.keepScratch) manager.cleanTree();
    }
    return { registry, notes };
}

// The recorded bytes embed the scratch root (fixtures/COMPARISON.json keeps that §8 row unrelaxed:
// PATH-MAP.json is the token contract, and re-recording elsewhere is a re-record, not a diff), so
// every run uses the recording root unless --scratch says otherwise. L4 puts each ref in its own
// root and compares the tokenised forms instead.
function scratchRoot(options) {
    return options.scratch || process.env.PARITY_SCRATCH || 'C:/parity-scratch';
}

function report(registry, notes, seconds) {
    const byQuirk = new Map();
    for (const entry of registry.results) {
        const key = entry.quirk;
        byQuirk.set(key, (byQuirk.get(key) || 0) + (entry.status === 'pass' ? 1 : 0));
    }
    console.log('');
    for (const entry of registry.results) {
        const mark = entry.status === 'pass' ? 'PASS' : 'FAIL';
        console.log(mark + '  [' + entry.quirk + ']  ' + entry.id
            + (entry.detail ? '  — ' + entry.detail.split('\n').join('\n            ') : ''));
    }
    if (Object.keys(notes).length) {
        console.log('\nnotes');
        for (const [area, text] of Object.entries(notes)) console.log('  ' + area + ': ' + text);
    }
    console.log('\nchecks by quirk: ' + [...byQuirk.entries()].map(([quirk, count]) => quirk + '=' + count).join('  '));
    console.log((registry.results.length - registry.failures.length) + ' passed, '
        + registry.failures.length + ' failed of ' + registry.results.length + ' checks in '
        + seconds.toFixed(1) + ' s');
    return registry.failures.length === 0;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    enforceNoAppImports();
    enforceDiffExcerpt();
    fs.mkdirSync(path.join(HERE, 'out'), { recursive: true });
    // The seam suite builds its sandbox in the shared scratch root and owns manager port 7837
    // (Q11), including in --app mode, where it still builds the fixture tree and the stand-in there.
    const lock = parityLock.acquire('L3 tests/L3-seam/run.js ' + process.argv.slice(2).join(' '));
    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    let green = true;
    let worst = 0;
    try {
        for (let attempt = 1; attempt <= options.repeat; attempt += 1) {
            if (options.repeat > 1) console.log('\n===== pass ' + attempt + ' of ' + options.repeat + ' =====');
            const started = Date.now();
            const { registry, notes } = await runOnce(options, attempt, browser);
            const seconds = (Date.now() - started) / 1000;
            const ok = report(registry, notes, seconds);
            let indexed = true;
            try {
                enforceChecksIndex(registry.results);
            } catch (error) {
                indexed = false;
                console.log('FAIL  [harness]  L3.CHECKS-MD\n      ' + String(error.detail || error));
            }
            fs.writeFileSync(path.join(HERE, 'out', 'run-' + attempt + '.json'),
                JSON.stringify({ at: new Date().toISOString(), ref: options.app || options.ref,
                    seconds, checks: registry.results, notes }, null, 2));
            worst = Math.max(worst, registry.failures.length);
            green = green && ok && indexed;
            if (!green && options.repeat > 1) break;
        }
    } finally {
        // A leaked Chromium tree contends for profiles and ports with the next run; the manager and
        // any stand-in child it spawned are stopped by the sandbox's own finally.
        if (browser.isConnected()) await browser.close();
        lock.release();
    }
    console.log(green
        ? '\nL3 SELF-TEST GREEN against ' + (options.app || options.ref) + ' (' + options.repeat + ' run(s))'
        : '\nL3 RED: ' + worst + ' failing check(s), see the FAIL lines above');
    return green ? 0 : 1;
}

main().then((code) => process.exit(code), (error) => {
    console.error('L3 run.js: ' + (error && error.stack ? error.stack : error));
    process.exit(1);
});
