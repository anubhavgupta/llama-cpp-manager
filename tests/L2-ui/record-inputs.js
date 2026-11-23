#!/usr/bin/env node
'use strict';
// Records the INPUTS behind the L2 browser expectations, by driving the real UI in a sandbox
// extracted from `parity-baseline` (the oracle). This is the only way fixtures/goldens/resave/** is
// produced — fixtures/ is Verifier-owned, nothing here is hand-authored, and the producing command
// is recorded in inputs.manifest.json (AGENTS.md C5).
//
//   node tests/L2-ui/record-inputs.js [--port 7849]
//
// Why the goldens composed from these inputs are still oracle truth:
//  - `resave` rows hold the DOM state the baseline's own loadConfiguration produced, plus the
//    localStorage bytes the baseline's own saveConfigurations wrote in the same session. The golden
//    generator composes RECORDED baseline input with the pinned baseline slices
//    (tools/parity/baseline-slices.js) and is cross-checked against the RECORDED baseline output.
//    That is the same construction fixtures/goldens/corpus already uses.
//  - `launch` rows hold the POST /start argv the baseline browser actually posted.
//  - `alert-blocked` rows hold the native dialog text the baseline raised.

const fs = require('fs');
const path = require('path');

const browserHelpers = require('./helpers/browser');
const fixtures = require('./helpers/fixtures');
const mocks = require('./helpers/mocks');
const app = require('./helpers/page');

const PORT = (() => {
    const index = process.argv.indexOf('--port');
    return index > -1 ? Number(process.argv[index + 1]) : 7849;
})();
const OUT_DIR = path.join(fixtures.FIXTURES, 'goldens', 'resave');

const freshBase = (form) => {
    const base = {};
    for (const row of form) {
        if (row.id) base[row.id] = { value: row.value, checked: row.checked, disabled: row.disabled };
    }
    return base;
};

async function main() {
    const sandbox = await app.prepareSandbox('parity-baseline', { refresh: true });
    const server = await app.startStaticServer(sandbox.app, PORT);
    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    const rows = [];
    // Checkpoint after every session: a recorded session is expensive (a real browser driving the
    // baseline page), and a partial file is recoverable while an unflushed run is not.
    const flush = (done) => {
        fs.mkdirSync(OUT_DIR, { recursive: true });
        const corpusModels = fixtures.corpusModelsPayload(seed.configs);
        const header = {
            kind: 'header', family: 'resave', role: 'inputs',
            recorded_by: 'node tests/L2-ui/record-inputs.js',
            command: 'node tests/L2-ui/record-inputs.js --port ' + PORT,
            source: 'parity-baseline@' + sandbox.sha,
            count: rows.length, complete: !!done,
            // The corpus-mode /models list the page was actually fed. gen-goldens composes argv from
            // it, so the list has to be recorded rather than recomputed; tests/L2-ui asserts the
            // payload it serves the candidate against this same digest.
            models_corpus: { sha256: fixtures.sha256(JSON.stringify(corpusModels)),
                models: corpusModels.models },
            note: 'Recorded inputs and recorded outputs of the parity-baseline browser session. '
                + 'tools/parity/gen-goldens.js composes fixtures/goldens/resave/goldens.jsonl from the '
                + '`form`/`configurations` fields with the pinned baseline slices and cross-checks the '
                + 'result against the `storage_after`/`argv`/`dialogs` bytes this same run recorded.'
        };
        fs.writeFileSync(path.join(OUT_DIR, 'inputs.jsonl'),
            [JSON.stringify(header)].concat(rows.map((row) => JSON.stringify(Object.assign({ kind: 'input' }, row))))
                .join('\n') + '\n');
        console.log('checkpoint: ' + rows.length + ' rows (' + done + ')');
    };
    const seed = fixtures.corpusSeed();

    const open = async (options) => {
        const channel = new mocks.MockChannel({ base: server.base, fileFor: (urlPath) => {
            const mapped = app.fileFor(sandbox.app, urlPath);
            return { serve: !!mapped.full, file: mapped.rel };
        } });
        if (options.models === 'corpus') {
            channel.route('GET /models', JSON.stringify(fixtures.corpusModelsPayload(options.configs)),
                'INPUT: recorded fixtures/http/J2-models entry shape, filled with the corpus paths');
        }
        const state = await browserHelpers.openPage(browser, Object.assign({ base: server.base,
            mocks: channel, viewport: { width: 1280, height: 800 }, settleMs: 700 }, options));
        if (options.waitFor !== false) await state.page.waitForSelector('#configList .config-item');
        return Object.assign({ mocks: channel }, state);
    };

    // 1. Re-save every config: Edit → Save. The form snapshot is the DOM state the baseline's
    //    saveCurrentValues read; storage_after is the bytes its saveConfigurations wrote.
    {
        const session = await open({ seed, models: 'corpus', configs: seed.configs });
        const fresh = freshBase(await browserHelpers.fields(session.page));
        for (const name of seed.names) {
            await browserHelpers.clickConfig(session.page, name, '.edit-btn');
            await session.page.waitForSelector('#configFormContainer[open]');
            await session.page.waitForTimeout(60);
            const form = await browserHelpers.fields(session.page);
            const configurations = JSON.parse(await browserHelpers.storageValue(session.page, 'llamaCppConfigs'));
            await session.page.click('#saveConfigBtn');
            await session.page.waitForTimeout(60);
            const storageAfter = await browserHelpers.storageValue(session.page, 'llamaCppConfigs');
            const written = JSON.parse(storageAfter);
            if (JSON.stringify(configurations[name]) === JSON.stringify(written[name])) {
                throw new Error('re-saving ' + name + ' did not rewrite storage — snapshot is not the input');
            }
            rows.push({ op: 'resave', name, base: fresh, form,
                configurations, configId: name,
                form_sha: fixtures.sha256(JSON.stringify(form)),
                configurations_sha: fixtures.sha256(JSON.stringify(configurations)),
                storage_after: storageAfter,
                saved_field_order: Object.keys(written[name]) });
        }
        await session.context.close();
        flush('resave');
    }

    // 2. Launch every config in both /models modes: the argv the browser posted, or the dialog it raised.
    for (const mode of ['corpus', 'recorded']) {
        const session = await open({ seed, models: mode === 'corpus' ? 'corpus' : 'recorded',
            configs: seed.configs });
        for (const name of seed.names) {
            await browserHelpers.clickConfig(session.page, name);
            await session.page.waitForSelector('#configList .config-item.active');
            await session.page.waitForTimeout(60);
            const form = await browserHelpers.fields(session.page);
            const postsBefore = session.mocks.of('POST /start').length;
            const dialogsBefore = session.dialogs.length;
            await session.page.click('#launchBtn');
            await session.page.waitForTimeout(120);
            const posted = session.mocks.of('POST /start').length > postsBefore;
            const dialogs = session.dialogs.slice(dialogsBefore);
            const formSha = fixtures.sha256(JSON.stringify(form));
            if (posted) {
                const body = session.mocks.lastJson('POST /start');
                rows.push({ op: 'launch', mode, name, argv: body.args, serverPath: body.serverPath,
                    serverPort: body.serverPort, form_sha: formSha,
                    storage_after: await browserHelpers.storageValue(session.page, 'llamaCppConfigs') });
                const stopsBefore = session.mocks.of('POST /stop').length;
                await session.page.click('#stopBtn');
                const stopped = await session.mocks.waitFor('POST /stop', stopsBefore + 1, 5000);
                if (!stopped) throw new Error('clicking Stop did not post /stop for ' + name);
                await session.page.waitForTimeout(120);
            } else {
                rows.push({ op: 'alert-blocked', mode, name,
                    dialogs: dialogs.map((dialog) => ({ type: dialog.type, message: dialog.message })),
                    modelPathValue: await session.page.inputValue('#modelPath'),
                    modelSelectedIndex: await session.page.evaluate(() => document.getElementById('modelPath').selectedIndex),
                    form_sha: formSha });
            }
        }
        await session.context.close();
        flush('launch-' + mode);
    }

    // 3. The create path: blank form + typed name + Save (fresh page, empty config store).
    {
        const session = await open({ waitFor: false, seed: { configsKey: 'llamaCppConfigs', configsJson: '{}',
            settingsKey: 'llamaCppSettings', settingsJson: seed.settingsJson } });
        await session.page.click('#addConfigBtn');
        await session.page.waitForSelector('#configFormContainer[open]');
        const fresh = freshBase(await browserHelpers.fields(session.page));
        await session.page.fill('#configName', 'parity-ui-check');
        await session.page.waitForTimeout(60);
        const form = await browserHelpers.fields(session.page);
        const configurations = JSON.parse(await browserHelpers.storageValue(session.page, 'llamaCppConfigs'));
        await session.page.click('#saveConfigBtn');
        await session.page.waitForTimeout(120);
        const storageAfter = await browserHelpers.storageValue(session.page, 'llamaCppConfigs');
        rows.push({ op: 'create', name: 'parity-ui-check', base: fresh, form, configurations,
            configId: null, form_sha: fixtures.sha256(JSON.stringify(form)),
            configurations_sha: fixtures.sha256(JSON.stringify(configurations)),
            storage_after: storageAfter,
            saved_field_order: Object.keys(JSON.parse(storageAfter)['parity-ui-check'] || {}) });
        await session.context.close();
        flush('create');
    }

    const byOp = {};
    for (const row of rows) byOp[row.op + (row.mode ? '-' + row.mode : '')] = (byOp[row.op + (row.mode ? '-' + row.mode : '')] || 0) + 1;
    flush('final');
    fs.writeFileSync(path.join(OUT_DIR, 'inputs.manifest.json'), JSON.stringify({
        generatedBy: 'node tests/L2-ui/record-inputs.js',
        command: 'node tests/L2-ui/record-inputs.js --port ' + PORT,
        source: 'parity-baseline',
        sourceSha: sandbox.sha,
        sandbox: 'static copy of the parity-baseline public/ assets; no manager process was started',
        backend: 'fetch replayed from fixtures/http raw bytes; io() stubbed (tests/L2-ui/helpers/mocks.js)',
        rows: rows.length,
        byOp,
        note: 'Every value is either read out of a browser running the parity-baseline UI or is the raw'
            + ' recorded fixture bytes that page was fed. Nothing is derived from the SPEC pack or from'
            + ' the candidate. tools/parity/gen-goldens.js composes the resave golden family from these'
            + ' inputs using the baseline slices pinned by tools/parity/baseline-slices.js, and'
            + ' cross-checks its output against the storage_after / argv / dialog bytes the baseline'
            + ' produced in the same sessions.'
    }, null, 2) + '\n');
    console.log('recorded ' + rows.length + ' rows to fixtures/goldens/resave/inputs.jsonl');
    console.log(JSON.stringify(byOp, null, 2));
    await browser.close();
    await server.close();
}

main().catch((error) => {
    console.error('RECORD FAILED: ' + (error && error.stack || error));
    process.exitCode = 1;
});
