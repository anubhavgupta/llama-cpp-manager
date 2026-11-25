'use strict';
// L4 dual-run driver (plan §2 Phase 4 row L4): run ONE action script against two git refs and diff
// the result field by field.
//
//   node tests/L4-dual/run.js --self-mode
//       PARITY_REF_A = PARITY_REF_B = parity-baseline. The report MUST show zero diffs: this is the
//       gate that says the differential machinery itself adds no noise (different scratch roots,
//       different PIDs, different node path, different port, two Chromium processes).
//   node tests/L4-dual/run.js --ref-a parity-baseline --ref-b <candidate-branch>
//   PARITY_REF_A / PARITY_REF_B are the environment form of the same two knobs.
//
// Each side gets its own scratch root (C:/parity-scratch/L4-a, /L4-b) holding a checkout of its ref
// — extracted with `git archive`, the same way L1 and the recording pass materialise a ref, so the
// repo working copy is never part of a run — plus its own fixture tree and compiled stand-in. The
// browser and every request go through that side's own port (7841 for A, 7842 for B); legacy pins
// itself to 7837 (Q11), so the two sides run sequentially behind a loopback forwarder and Part 2
// gets to use the same per-side URLs against a candidate that binds its own port.
//
// The action script is one set of probe modules (probes/backend.js, probes/ui.js, probes/seam.js)
// that reuse the L1 sandbox, the L2 page readers and the L3 seam helpers: identical code per side,
// no per-ref branching, nothing that knows which stack it is talking to (§6.1, §6.2).

const fs = require('fs');
const path = require('path');

const { DualSandbox } = require('./helpers/dual-sandbox');
const { Observation, diff, printable } = require('./helpers/observe');
const forwarder = require('./helpers/forwarder');
const parityLock = require('../../tools/parity/parity-lock.js');

const HERE = __dirname;
const REPO = path.resolve(__dirname, '..', '..');
const PROBES = [
    ...require('./probes/backend'),
    ...require('./probes/ui'),
    ...require('./probes/seam')
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
    const options = {
        refA: process.env.PARITY_REF_A || 'parity-baseline',
        refB: process.env.PARITY_REF_B || 'parity-baseline',
        portA: Number(process.env.PARITY_PORT_A || 7841),
        portB: Number(process.env.PARITY_PORT_B || 7842),
        scratch: process.env.PARITY_SCRATCH_BASE || 'C:/parity-scratch',
        out: path.join(HERE, 'out'),
        selfMode: false,
        keepScratch: false
    };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        const next = () => {
            index += 1;
            assert(index < argv.length, 'L4-ARG', 'missing value for ' + token);
            return argv[index];
        };
        if (token === '--self-mode') options.selfMode = true;
        else if (token === '--ref-a') options.refA = next();
        else if (token === '--ref-b') options.refB = next();
        else if (token === '--port-a') options.portA = Number(next());
        else if (token === '--port-b') options.portB = Number(next());
        else if (token === '--scratch') options.scratch = next();
        else if (token === '--out') options.out = path.resolve(next());
        else if (token === '--only') options.only = new Set(next().split(',').map((name) => name.trim()));
        else if (token === '--keep-scratch') options.keepScratch = true;
        else if (token === '--list') { for (const probe of PROBES) console.log(probe.id + '  —  ' + probe.title); options.list = true; }
        else fail('L4-ARG', 'unknown argument: ' + token);
    }
    if (options.selfMode) {
        options.refA = options.refB = 'parity-baseline';
        delete options.only;
    }
    return options;
}

// §6.1 again, for this suite's own files: the differential driver must not import app code.
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
            for (const match of fs.readFileSync(full, 'utf8').matchAll(/require\((['"])([^'"]+)\1\)/g)) {
                const target = match[2];
                if (/(^|[\\/])(public|legacy)([\\/]|$)/.test(target) || /server\.js$/.test(target)
                    || /public[\\/]script\.js$/.test(target)) {
                    offenders.push(path.relative(HERE, full) + ' requires ' + target);
                }
            }
        }
    };
    walk(HERE);
    assert(offenders.length === 0, 'L4.NO-APP-IMPORTS',
        'the L4 driver imports app code, which §6.1 forbids: ' + offenders.join(', '));
}

async function runSide(side, ref, publicPort, options, browser) {
    const scratch = path.join(options.scratch, 'L4-' + side);
    const manager = new DualSandbox({ repo: REPO, ref, scratch, port: 7837, publicPort });
    console.log('\n== side ' + side + '  ref=' + ref + '  url=http://localhost:' + publicPort
        + '  scratch=' + scratch);
    manager.prepare();
    const proxy = await forwarder.listen(publicPort, 7837);
    const observe = new Observation(side, { ref, url: manager.baseUrl, publicPort, scratch,
        app: manager.app, nodeExe: process.execPath });
    try {
        await manager.checkPorts();
        await manager.startSession('L4-' + side, { stubMode: 'ok' });
        const context = { manager, browser, observe };
        for (const probe of PROBES.filter((entry) => !options.only || options.only.has(entry.id))) {
            console.log('  --> probe ' + probe.id);
            try {
                await probe.run(context);
            } catch (error) {
                observe.problem('probe ' + probe.id + ' threw: ' + (error && error.stack || error));
            }
            await manager.stopAndWait();
        }
    } finally {
        await manager.stopSession().catch(() => {});
        await proxy.close();
        if (!options.keepScratch) manager.cleanTree();
    }
    console.log('  side ' + side + ': ' + observe.fields.size + ' fields, '
        + observe.problems.length + ' problem(s)');
    return observe;
}

function writeReport(options, a, b, result) {
    fs.mkdirSync(options.out, { recursive: true });
    const json = path.join(options.out, 'report.json');
    fs.writeFileSync(json, JSON.stringify({
        at: new Date().toISOString(),
        targetA: a.target, targetB: b.target,
        fieldCount: { A: a.fields.size, B: b.fields.size },
        diffs: result.rows, violations: result.violations,
        problems: { A: a.problems, B: b.problems },
        selfMode: options.selfMode
    }, null, 2));
    const lines = [
        '# L4 dual-run report',
        '',
        'Run ' + new Date().toISOString() + (options.selfMode ? ' — SELF-MODE (A = B = parity-baseline)' : ''),
        '',
        '| side | ref | URL | scratch |',
        '|---|---|---|---|',
        '| A | `' + a.target.ref + '` | ' + a.target.url + ' | `' + a.target.scratch + '` |',
        '| B | `' + b.target.ref + '` | ' + b.target.url + ' | `' + b.target.scratch + '` |',
        '',
        'Fields compared: ' + a.fields.size + ' / ' + b.fields.size + '. Comparison policy:',
        'fixtures/COMPARISON.json (default `' + require('../L1-backend/lib/harness').COMPARISON.defaultMode
            + '`); machine-bound roots and the node executable are PATH-MAP-tokenised per run.',
        '',
        '## Field diffs: ' + result.rows.length,
        ''
    ];
    if (!result.rows.length) {
        lines.push('No field differs.', '');
    } else {
        lines.push('| field | fixture family | mode | A | B |', '|---|---|---|---|---|');
        for (const row of result.rows) {
            lines.push('| `' + row.key + '` | `' + (row.family || '—') + '` | ' + row.mode + ' | '
                + oneLine(row.a) + ' | ' + oneLine(row.b) + ' |');
        }
        lines.push('');
    }
    lines.push('## Policy violations (a side that no longer satisfies the rule that relaxes it): '
        + result.violations.length, '');
    for (const violation of result.violations.slice(0, 40)) lines.push('- ' + violation);
    if (!result.violations.length) lines.push('- none');
    lines.push('');
    for (const [side, problems] of [['A', a.problems], ['B', b.problems]]) {
        if (!problems.length) continue;
        lines.push('## Problems recorded while observing side ' + side, '');
        for (const problem of problems) lines.push('- ' + oneLine(problem));
        lines.push('');
    }
    const markdown = path.join(options.out, 'report.md');
    fs.writeFileSync(markdown, lines.join('\n'));
    return { json, markdown };
}

function oneLine(text) {
    const single = String(text).split('\n').join('⏎');
    return single.length > 220 ? single.slice(0, 220) + '…' : single;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.list) return 0;
    enforceNoAppImports();
    fs.mkdirSync(options.out, { recursive: true });
    // Both sides build and tear down their checkout under the shared scratch root, and each side owns
    // manager port 7837 in turn (Q11), --self-mode included. A second executor in the same root is
    // what manufactured false reds for the 2026-11-25 audit run (finding 3), so L4 takes the same
    // one-executor lock the nightly holds; run-nightly.js hands it PARITY_LOCK_HELD instead.
    const lock = parityLock.acquire('L4 tests/L4-dual/run.js ' + process.argv.slice(2).join(' '));
    try {
        return await runDual(options);
    } finally {
        lock.release();
    }
}

async function runDual(options) {
    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    const started = Date.now();
    let a = null;
    let b = null;
    try {
        a = await runSide('a', options.refA, options.portA, options, browser);
        b = await runSide('b', options.refB, options.portB, options, browser);
    } finally {
        if (browser.isConnected()) await browser.close();
    }
    const result = diff(a, b);
    const files = writeReport(options, a, b, result);
    a.write(path.join(options.out, 'observations-a.json'));
    b.write(path.join(options.out, 'observations-b.json'));

    console.log('\nfields A=' + a.fields.size + ' B=' + b.fields.size + '  diffs=' + result.rows.length
        + '  policy violations=' + result.violations.length
        + '  problems=' + (a.problems.length + b.problems.length)
        + '  (' + ((Date.now() - started) / 1000).toFixed(1) + ' s)');
    for (const row of result.rows.slice(0, 30)) {
        console.log('  DIFF ' + row.key + ' [' + row.mode + ']\n    A: ' + printable(row.a).slice(0, 300)
            + '\n    B: ' + printable(row.b).slice(0, 300));
    }
    if (result.rows.length > 30) console.log('  ... ' + (result.rows.length - 30) + ' more diffs');
    for (const violation of result.violations.slice(0, 10)) console.log('  POLICY ' + violation);
    console.log('report: ' + files.markdown + '\n        ' + files.json);

    const clean = result.rows.length === 0 && result.violations.length === 0
        && a.problems.length === 0 && b.problems.length === 0;
    if (options.selfMode) {
        console.log(clean
            ? '\nL4 SELF-MODE GREEN: A = B = parity-baseline produced zero field diffs.'
            : '\nL4 SELF-MODE RED: the differential harness is not self-noise free ('
            + result.rows.length + ' diff(s), ' + result.violations.length + ' policy violation(s), '
            + (a.problems.length + b.problems.length) + ' probe problem(s)).');
    }
    return clean ? 0 : 1;
}

main().then((code) => process.exit(code), (error) => {
    console.error('L4 run.js: ' + (error && error.stack ? error.stack : error));
    process.exit(1);
});
