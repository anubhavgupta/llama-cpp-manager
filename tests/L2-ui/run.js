#!/usr/bin/env node
'use strict';
// L2 UI conformance runner (plan §2 Phase 4, ledger row L2).
//
//   node tests/L2-ui/run.js                          # suite against the parity-baseline sandbox
//   node tests/L2-ui/run.js --verify-selftest         # must be 100% green against legacy assets
//   node tests/L2-ui/run.js --repeat 2                # N consecutive green runs (flake protocol §6.4)
//   node tests/L2-ui/run.js --only corpus-launch,corpus-ini
//   node tests/L2-ui/run.js --ref <git-ref|worktree|dir> --port 7847 --out tests/L2-ui/out
//
// The page is served live from a sandbox copy of the ref (static assets only). No manager process
// exists here: fetch is replayed from fixtures/http raw bytes and io() is a scripted emitter, so
// the suite is pure L2 and needs no backend (plan §6 rule 1: base URL, port and target are env/flag
// driven, and the suites never import app code).

const fs = require('fs');
const path = require('path');

const { Results, inspect } = require('./helpers/assert');
const browserHelpers = require('./helpers/browser');
const fixtures = require('./helpers/fixtures');
const mocks = require('./helpers/mocks');
const app = require('./helpers/page');

const HERE = __dirname;
const CHECK_FILES = ['fields', 'conditional', 'storage', 'runtime', 'states', 'corpus', 'misc'];

function parseArgs(argv) {
    const out = { ref: 'parity-baseline', port: Number(process.env.L2_PORT || 7847),
        out: path.join(HERE, 'out'), repeat: 1, verifySelftest: false };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        const next = () => {
            index += 1;
            if (index >= argv.length) throw new Error('missing value for ' + token);
            return argv[index];
        };
        if (token === '--ref') out.ref = next();
        else if (token === '--port') out.port = Number(next());
        else if (token === '--out') out.out = path.resolve(next());
        else if (token === '--scratch') out.scratch = next();
        else if (token === '--refresh') out.refresh = true;
        else if (token === '--repeat') out.repeat = Number(next());
        else if (token === '--only') out.only = new Set(next().split(',').map((name) => name.trim()));
        else if (token === '--verify-selftest') out.verifySelftest = true;
        else if (token === '--list') out.list = true;
        else throw new Error('unknown argument: ' + token);
    }
    return out;
}

function loadChecks() {
    const checks = [];
    for (const file of CHECK_FILES) {
        for (const check of require(path.join(HERE, 'checks', file + '.js'))) {
            checks.push(Object.assign({ file }, check));
        }
    }
    return checks;
}

// Gate: the suite must not import app code at node level (plan §6 rule 1). The browser loads the
// app itself, which is the point; node must not.
function checkNoAppImports() {
    const offenders = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== 'out') walk(full);
                continue;
            }
            if (!/\.js$/.test(entry.name)) continue;
            const source = fs.readFileSync(full, 'utf8');
            const requires = [...source.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2]);
            for (const target of requires) {
                const resolved = target.startsWith('.') ? path.resolve(path.dirname(full), target) : target;
                const text = String(resolved);
                if (/public[\\/]script\.js$/.test(text) || /legacy[\\/]lib/.test(text)
                    || /(^|[\\/])server\.js$/.test(text)) {
                    offenders.push(path.relative(HERE, full) + ' requires ' + target);
                }
            }
        }
    };
    walk(HERE);
    return offenders;
}

function writeDisagreements(outDir, rows) {
    const lines = [
        '# tests/L2-ui DISAGREEMENTS — where the SPEC pack / gen-goldens output is not what the browser renders',
        '',
        'Truth is what the legacy browser rendered (plan §4 tie-break step 1). Nothing here changes a',
        'golden or an assertion; the rows below are for the SPEC/CONSISTENCY follow-up.',
        '',
        'Class key (supervisor-approved classification):',
        '',
        '- `i:stored-number-vs-DOM-string(Q19)` — `fixtures/goldens/corpus` is recorded from the SAVED',
        '  config with its stored JSON types. `minP`/`repeatPenalty`/`presencePenalty` are then compared',
        '  with `x != "0"` and `x == "0.00"`, and when both sides are strings JS compares them as',
        '  STRINGS: the DOM value `"0"` drops the flag while the stored number `0` emits it. Four',
        '  zero forms, four outcomes (Q19).',
        '- `ii:loadMode-migration-from-mlock/noMmap/dio(Q16)` — 27 configs have no `loadMode` key and',
        '  `loadConfiguration` migrates the orphan `mlock`/`noMmap`/`dio` keys, while the golden keeps',
        '  the fresh-form default `none`.',
        '- `iii:reasoning-from-disableReasoning(Q17)` — 15 configs have no `reasoning` key and',
        '  `loadConfiguration` derives `on`/`off` from the legacy `disableReasoning`; the golden leaves',
        '  `auto`, so it emits no `--reasoning`.',
        '- `iv:speculationType-inferred-from-specDraftNMax` — 1 config: the same migration in',
        '  `loadConfiguration` that the generator input model does not apply.',
        '- `v:draftModelPath-blanking(Q18)` — a saved draft path with no `<option>` blanks in the',
        '  browser and drops `-md/-ngld/-ctkd/-ctvd`.',
        ''
    ];
    for (const [area, entries] of Object.entries(rows)) {
        lines.push('## ' + area, '');
        if (!entries.length) {
            lines.push('No disagreements.', '');
            continue;
        }
        if (area === 'corpus-argv-vs-gen-goldens') {
            const classCounts = new Map();
            for (const entry of entries) {
                for (const kind of entry.classes) classCounts.set(kind, (classCounts.get(kind) || 0) + 1);
            }
            lines.push('Configs whose browser-captured argv differs from `fixtures/goldens/corpus`:',
                String(entries.length) + ' of 48.', '');
            lines.push('| class | configs |', '|---|---|');
            for (const [kind, count] of [...classCounts.entries()].sort()) {
                lines.push('| `' + kind + '` | ' + count + ' |');
            }
            lines.push('', '| config | classes | first differing positions | argv length gen-goldens → browser |',
                '|---|---|---|---|');
            for (const entry of entries) {
                lines.push('| ' + entry.name + ' | ' + entry.classes.join('<br>') + ' | '
                    + entry.firstPositions.join(', ') + ' | ' + entry.length.genGoldens + ' → '
                    + entry.length.browser + ' |');
            }
            lines.push('', 'Full argv pairs: `out/disagreements.json`.', '');
            continue;
        }
        lines.push('| field | id | attribute | SPEC | rendered |', '|---|---|---|---|---|');
        for (const entry of entries) {
            lines.push('| ' + (entry.id || '') + ' | ' + (entry.id || '') + ' | ' + entry.attribute
                + ' | ' + inspect(entry.spec) + ' | ' + inspect(entry.rendered) + ' |');
        }
        lines.push('');
    }
    fs.writeFileSync(path.join(outDir, 'DISAGREEMENTS.md'), lines.join('\n'));
    fs.writeFileSync(path.join(outDir, 'disagreements.json'), JSON.stringify(rows, null, 2));
    return path.join(outDir, 'DISAGREEMENTS.md');
}

async function runOnce(options, context) {
    const results = new Results();
    const checks = loadChecks().filter((check) => !options.only || options.only.has(check.id));
    const current = { state: null, mocks: null };
    const disagreementRows = {};

    const ctx = {
        results,
        out: options.out,
        base: context.base,
        get mocks() {
            return current.mocks;
        },
        async open(openOptions) {
            if (current.state) await ctx.close();
            const channel = new mocks.MockChannel({ base: context.base, fileFor: context.fileFor });
            for (const [key, body] of Object.entries((openOptions && openOptions.mocks) || {})) {
                channel.route(key, body, 'per-check override');
            }
            if (openOptions && openOptions.models === 'corpus') {
                const configs = openOptions.seed && openOptions.seed.configs
                    ? openOptions.seed.configs
                    : JSON.parse(openOptions.seed.configsJson);
                channel.route('GET /models', JSON.stringify(fixtures.corpusModelsPayload(configs)),
                    'INPUT: recorded fixtures/http/J2-models entry shape, filled with the corpus paths'
                    + ' (the corpus-mode option set; expectations still come from recorded legacy output)');
            }
            const state = await browserHelpers.openPage(context.browser, Object.assign({}, openOptions, {
                base: context.base,
                mocks: channel,
                seed: openOptions && openOptions.seed
            }));
            current.state = state;
            current.mocks = channel;
            return Object.assign({}, state, {
                mocks: channel,
                dialogs: () => state.dialogs,
                navigations: () => state.navigations
            });
        },
        async close() {
            if (!current.state) return;
            const state = current.state;
            const channel = current.mocks;
            current.state = null;
            current.mocks = null;
            if (channel.violations.length) {
                results.fail('L2-MOCK-unmatched-fetch', 'every fetch answered from recorded bytes',
                    channel.violations, 'an unmocked request means the state was not asserted (L2 rule)');
            }
            await state.context.close();
        },
        async dialogs() {
            return current.state ? current.state.dialogs : [];
        },
        setDialogAction(action) {
            if (current.state) current.state.dialogAction = action;
        },
        async navigations() {
            return current.state ? current.state.navigations : 0;
        },
        async waitForNavigation(before, timeoutMs) {
            const deadline = Date.now() + (timeoutMs || 5000);
            while (Date.now() < deadline) {
                if (current.state && current.state.navigations > before) return true;
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            return false;
        },
        disagreements(area, rows) {
            disagreementRows[area] = (disagreementRows[area] || []).concat(rows);
        },
        notes: {},
        note(area, text) {
            this.notes[area] = text;
        }
    };

    for (const check of checks) {
        try {
            await check.run(ctx);
        } catch (error) {
            results.error('L2-CHECK-THREW-' + check.id, error, check.title);
        }
        await ctx.close();
    }

    const ioSeen = context.ioRequests();
    results.ok('L2-SOCKET-module-requested', ioSeen > 0,
        'C6: the page really imports ./socket.io.esm.min.js (' + ioSeen + ' request(s) stubbed)');
    results.eq('L2-NO-APP-IMPORTS', [], checkNoAppImports(),
        'no L2 file requires public/script.js, legacy/lib or server.js (plan §6 rule 1)');
    results.eq('L2-STATIC-404', [], context.server.missing,
        'the page requested no asset the sandbox failed to serve');
    await context.stopCounters();
    return { results, disagreementRows, notes: ctx.notes, checks: checks.map((check) => check.id) };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const checks = loadChecks();
    if (options.list) {
        for (const check of checks) console.log(check.id + '  —  ' + check.title + '  [' + check.quirk + ']');
        return 0;
    }
    fs.mkdirSync(options.out, { recursive: true });

    const sandbox = await app.prepareSandbox(options.ref, options);
    const server = await app.startStaticServer(sandbox.app, options.port);
    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    mocks.resetIoRequestsTotal();
    const context = {
        base: server.base,
        fileFor: (urlPath) => {
            const mapped = app.fileFor(sandbox.app, urlPath);
            return { serve: !!mapped.full, file: mapped.rel };
        },
        browser,
        server,
        ioRequests: () => mocks.ioRequestsTotal(),
        stopCounters: async () => {
            await browser.close();
            await server.close();
        }
    };
    console.log('L2 target ' + server.base + '  ref=' + (sandbox.ref || sandbox.kind)
        + ' sha=' + String(sandbox.sha).slice(0, 12) + ' app=' + sandbox.app
        + (sandbox.cached ? ' (cached sandbox)' : ''));

    let worst = 0;
    const runs = [];
    for (let attempt = 1; attempt <= options.repeat; attempt += 1) {
        const run = await runOnce(options, context);
        runs.push(run);
        const summary = run.results.summary();
        console.log('\nrun ' + attempt + '/' + options.repeat + ': ' + summary.passed + '/'
            + summary.total + ' assertions passed');
        for (const group of summary.groups) {
            console.log('  ' + (group.failed ? 'FAIL' : ' ok ') + ' ' + group.group + ': '
                + (group.total - group.failed) + '/' + group.total);
        }
        for (const failure of run.results.failures.slice(0, 40)) {
            console.log('\n  RED ' + failure.id + ' [' + failure.group + ']');
            if (failure.note) console.log('       claim   : ' + failure.note);
            console.log('       expected: ' + inspect(failure.expected).slice(0, 600));
            console.log('       actual  : ' + inspect(failure.actual).slice(0, 600));
            if (failure.difference) console.log('       at      : ' + failure.difference);
        }
        if (run.results.failures.length > 40) {
            console.log('\n  ... ' + (run.results.failures.length - 40) + ' more failures');
        }
        const reportPath = path.join(options.out, 'run-' + attempt + '.json');
        fs.writeFileSync(reportPath, JSON.stringify({
            target: { base: server.base, ref: sandbox.ref || sandbox.kind, sha: sandbox.sha, app: sandbox.app },
            summary, failures: run.results.failures, notes: run.notes, checks: run.checks,
            assertions: run.results.rows.map((row) => ({ id: row.id, group: row.group, pass: row.pass,
                note: row.note }))
        }, null, 2));
        const disagreements = writeDisagreements(options.out, run.disagreementRows);
        console.log('  report: ' + reportPath + '\n  disagreements: ' + disagreements);
        worst = Math.max(worst, run.results.failures.length);
        if (run.results.failures.length && options.repeat > 1) break;
    }

    if (options.verifySelftest) {
        const green = worst === 0 && runs.every((run) => run.results.summary().total > 200);
        console.log('\nL2 SELF-TEST ' + (green ? 'GREEN' : 'RED') + ' against '
            + (sandbox.ref || sandbox.kind) + ' (' + runs.length + ' consecutive run(s))');
        await context.stopCounters();
        return green ? 0 : 1;
    }
    await context.stopCounters();
    return worst ? 1 : 0;
}

main().then((code) => {
    process.exitCode = code;
}).catch((error) => {
    console.error('L2 RUNNER FAILED: ' + (error && error.stack || error));
    process.exitCode = 2;
});
