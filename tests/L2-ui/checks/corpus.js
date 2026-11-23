'use strict';
// The corpus round-trip: plan §2 Phase 4's "single highest-value test in the project", run at L2
// (backend mocked, manager never runs).
//
//  - seed localStorage from fixtures/corpus/configs.remapped.json (token paths kept verbatim, so
//    every compared byte stays machine-independent);
//  - assert the rendered config list is the 48 names in legacy sort order (recorded order);
//  - for EACH of the 48: load it, then Launch — compare the mock-captured POST /start argv
//    positionally against the recorded-legacy expectation (fixtures/goldens/resave, cross-checked
//    against the bytes the legacy page posted); the positional diff against fixtures/goldens/corpus
//    is computed too and written to DISAGREEMENTS.md as the stored-type-vs-DOM-type table;
//  - generate models-preset.ini from ALL 48 and compare BYTES against the gen-goldens corpus ini
//    output, section by section and whole;
//  - generate it again from a deterministic 2-config subset, in both insertion orders, because no
//    recorded generator vector has more than one saved config (plan §9 trap 6);
//  - re-save each config and compare the exact localStorage bytes written, orphan keys included (Q16).

const browser = require('../helpers/browser');
const fixtures = require('../helpers/fixtures');

const ORPHAN_KEYS = ['mlock', 'noMmap', 'ndio', 'dio', 'draftMin', 'draftMax', 'draftPMin',
    'disableReasoning'];
const INI_HEADER = 'version = 1\n\n';

const decodeIni = (golden) => Buffer.from(golden.ini, 'base64').toString('utf8');
const iniSection = (golden) => decodeIni(golden).slice(INI_HEADER.length);

// Compose the ini the page should post for a set of saved configs, from the corpus goldens.
function expectedIni(goldens, names, port) {
    let out = INI_HEADER;
    for (const name of names) {
        const entry = goldens.byName.get(name);
        if (!entry) throw new Error('no corpus golden for config ' + name);
        out += iniSection(entry.golden);
    }
    return out + 'port = ' + port + '\n';
}

// Positional diff against fixtures/goldens/corpus, classified. Classes (supervisor-approved):
// (i) stored number vs DOM string on minP/repeatPenalty/presencePenalty — `"0" == "0.00"` is a
//     STRING compare in JS, so the DOM drops the flag where the number-typed golden emits it (Q19);
// (ii) loadConfiguration migrates the orphan mlock/noMmap/dio keys into loadMode (27 configs);
// (iii) reasoning derived from the legacy disableReasoning key (15 configs, Q17);
// (iv) speculationType inferred from specDraftNMax (1 config).
function classify(config, expected, recorded) {
    const classes = new Set();
    const missing = new Set();
    for (const flag of ['--min-p', '--repeat-penalty', '--presence-penalty']) {
        const inRecorded = recorded.includes(flag);
        const inExpected = expected.includes(flag);
        if (inRecorded !== inExpected) missing.add(flag);
    }
    for (const flag of missing) {
        const key = { '--min-p': 'minP', '--repeat-penalty': 'repeatPenalty',
            '--presence-penalty': 'presencePenalty' }[flag];
        if (typeof config[key] === 'number') classes.add('i:stored-number-vs-DOM-string(Q19)');
        else classes.add('i:stored-type(Q19)');
    }
    const recordedMode = recorded[recorded.indexOf('--load-mode') + 1];
    const expectedMode = expected[expected.indexOf('--load-mode') + 1];
    if (recordedMode !== expectedMode) {
        classes.add(config.loadMode === undefined
            ? 'ii:loadMode-migration-from-mlock/noMmap/dio(Q16)' : 'ii:loadMode-other');
    }
    if (expected.indexOf('--reasoning') < 0 && recorded.indexOf('--reasoning') >= 0) {
        classes.add(config.reasoning === undefined && config.disableReasoning !== undefined
            ? 'iii:reasoning-from-disableReasoning(Q17)' : 'iii:reasoning-other');
    } else if (expected.indexOf('--reasoning') >= 0 && expected.indexOf('--reasoning') !== recorded.indexOf('--reasoning')) {
        classes.add('iii:reasoning-other');
    }
    if (expected.indexOf('--spec-type') !== recorded.indexOf('--spec-type')
        || expected.indexOf('--spec-draft-n-max') !== recorded.indexOf('--spec-draft-n-max')) {
        classes.add(config.speculationType === undefined && config.specDraftNMax > 0
            ? 'iv:speculationType-inferred-from-specDraftNMax' : 'iv:speculationType-other');
    }
    if (expected.indexOf('-md') !== recorded.indexOf('-md')) classes.add('v:draftModelPath-blanking(Q18)');
    const positions = [];
    for (let index = 0; index < Math.max(expected.length, recorded.length); index += 1) {
        if (expected[index] !== recorded[index]) positions.push(index);
    }
    return { classes: [...classes], positions };
}

async function openCorpus(ctx, options) {
    const corpus = fixtures.corpusSeed();
    const opened = await ctx.open(Object.assign({ seed: corpus, models: 'corpus', settleMs: 800 },
        options || {}));
    await opened.page.waitForSelector('#configList .config-item');
    return Object.assign({ corpus }, opened);
}

const selectConfig = async (page, name) => {
    await browser.clickConfig(page, name);
    await page.waitForSelector('#configList .config-item.active');
    await page.waitForTimeout(60);
};

async function listAndOrder(ctx) {
    const t = ctx.results;
    t.group('corpus');
    const recorded = fixtures.corpusConfigList();
    const { page, corpus } = await openCorpus(ctx);
    const rows = await browser.configRows(page);
    t.eq('L2-CORPUS-list-count', 48, rows.length, 'all 48 corpus configs render');
    t.eq('L2-CORPUS-list-order', recorded.renderedOrder, rows.map((row) => row.name),
        'the rendered order equals the order the legacy page rendered (recorded J6 bytes)');
    t.eq('L2-CORPUS-seed-map-order', corpus.names, recorded.corpusInsertionOrder,
        'the seeded storage map keeps the corpus file order (ini section order follows it, §9 trap 6)');
    const survey = fixtures.corpusSelectSurvey();
    t.eq('L2-CORPUS-model-options', 48, survey.optionsFromModelsEndpoint,
        'the recorded J6 run matched all 48 corpus modelPaths against /models options, which is the'
        + ' option set this suite mocks for corpus mode');
    await ctx.close();
}

async function launchEveryConfig(ctx) {
    const t = ctx.results;
    t.group('corpus');
    const goldens = fixtures.corpusGoldens();
    const resave = fixtures.resaveGoldens();
    if (!resave) {
        t.fail('L2-CORPUS-launch', 'fixtures/goldens/resave/goldens.jsonl present', 'missing',
            'run node tests/L2-ui/record-inputs.js && node tools/parity/gen-goldens.js');
        return;
    }
    const inputs = fixtures.inputsRecorded();
    const byName = new Map((inputs ? inputs.rows : []).filter((row) => row.op === 'resave')
        .map((row) => [row.name, row]));
    const { page, corpus } = await openCorpus(ctx);
    const disagreements = [];
    const alertBlocked = [];
    const launched = [];
    const formStateProblems = [];

    for (const name of corpus.names) {
        const golden = resave.byName.get(name);
        const input = byName.get(name);
        if (!golden) {
            t.fail('L2-CORPUS-' + name, 'golden present', 'missing', 'resave golden family is incomplete');
            continue;
        }
        await selectConfig(page, name);

        if (input) {
            const rendered = (await browser.fields(page)).filter((row) => row.id);
            const recordedRows = input.form.filter((row) => row.id);
            const differences = recordedRows.filter((row) => {
                const control = rendered.find((entry) => entry.id === row.id);
                return !control || control.value !== row.value || control.checked !== row.checked
                    || control.disabled !== row.disabled;
            }).map((row) => row.id + ' recorded ' + JSON.stringify([row.value, row.checked, row.disabled])
                + ' rendered ' + JSON.stringify(rendered.find((entry) => entry.id === row.id) || null));
            if (differences.length) {
                formStateProblems.push({ name, differences });
            }
        }

        const postsBefore = ctx.mocks.of('POST /start').length;
        const stopsBefore = ctx.mocks.of('POST /stop').length;
        const dialogsBefore = (await ctx.dialogs()).length;
        await page.click('#launchBtn');
        const posted = await ctx.mocks.waitFor('POST /start', postsBefore + 1, 3000);
        await page.waitForTimeout(60);
        const newDialogs = (await ctx.dialogs()).slice(dialogsBefore);
        if (!posted) {
            alertBlocked.push({ name, dialogs: newDialogs });
            t.eq('L2-CORPUS-blocked-' + name, golden.dialogs || newDialogs, newDialogs,
                'this config is alert-blocked client-side; the dialog text is the assertion');
            continue;
        }
        const body = ctx.mocks.lastJson('POST /start');
        const expectedArgv = golden.argv;
        t.eq('L2-CORPUS-argv-' + name, expectedArgv, body.args,
            'the mock-captured POST /start argv equals the recorded legacy argv for ' + JSON.stringify(name));
        t.eq('L2-CORPUS-serverPath-' + name, golden.serverPath, body.serverPath,
            'the POST body serverPath is the stored serverPath, verbatim (Q20 separators kept)');
        launched.push(name);

        const corpusGolden = goldens.byName.get(name);
        if (corpusGolden) {
            const classified = classify(corpus.configs[name], corpusGolden.golden.argv, body.args);
            if (classified.positions.length) {
                disagreements.push({
                    name,
                    classes: classified.classes,
                    firstPositions: classified.positions.slice(0, 6),
                    length: { genGoldens: corpusGolden.golden.argv.length, browser: body.args.length },
                    genGoldens: corpusGolden.golden.argv,
                    browser: body.args
                });
            }
        }
        // Stop through the UI so the next Launch click is enabled again (launchBtn is disabled while
        // the page believes a server is running).
        await page.click('#stopBtn');
        const stopped = await ctx.mocks.waitFor('POST /stop', stopsBefore + 1, 3000);
        if (!stopped) throw new Error('clicking Stop did not post /stop after ' + name);
        await page.waitForTimeout(60);
    }

    t.eq('L2-CORPUS-launched-count', 48, launched.length,
        'every corpus config issued a POST /start (the corpus-mode /models mock offers every corpus path)');
    t.eq('L2-CORPUS-alert-blocked', [], alertBlocked.map((row) => row.name),
        'in corpus mode nothing is alert-blocked; the recorded-J2-payload mode below asserts the blocking');
    t.eq('L2-CORPUS-form-states', [], formStateProblems,
        'loading each config produces the recorded form state (values, checked, disabled)');
    ctx.disagreements('corpus-argv-vs-gen-goldens', disagreements.map((row) => Object.assign({}, row, {
        note: 'gen-goldens corpus goldens are recorded from the SAVED config with its stored JSON'
            + ' types and no loadConfiguration migration; the browser reads the DOM. Truth = browser.'
    })));
    ctx.note('corpus-launch', launched.length + ' of 48 launched; ' + alertBlocked.length
        + ' alert-blocked' + (alertBlocked.length ? ': ' + alertBlocked.map((row) => row.name
            + ' [' + row.dialogs.map((dialog) => dialog.message).join('|') + ']').join('; ') : ''));
    await ctx.close();
}

// The mode the spec's Q18 evidence describes: replay the RECORDED fixtures/http/J2-models payload,
// where none of the corpus paths is an <option>, so every modelPath blanks on load and Launch alerts.
async function alertBlockedMode(ctx) {
    const t = ctx.results;
    t.group('corpus');
    const inputs = fixtures.inputsRecorded();
    const rows = new Map((inputs ? inputs.rows : []).filter((row) => row.op === 'alert-blocked')
        .map((row) => [row.name, row]));
    const { page, corpus } = await openCorpus(ctx, { models: 'recorded' });
    const options = await browser.optionValues(page, 'modelPath');
    const recordedModels = fixtures.modelsPayload().models.map((model) => model.path);
    t.eq('L2-CORPUS-Q18-options', recordedModels, options.slice(1),
        'the /models mock replayed the recorded J2 payload (placeholder option aside)');
    const blanked = [];
    const alerts = [];
    const postsBefore = () => ctx.mocks.of('POST /start').length;
    for (const name of corpus.names) {
        await selectConfig(page, name);
        const value = await page.inputValue('#modelPath');
        const selectedIndex = await page.evaluate(() => document.getElementById('modelPath').selectedIndex);
        if (value === '' && selectedIndex === -1) blanked.push(name);
        const before = postsBefore();
        const dialogsBefore = (await ctx.dialogs()).length;
        await page.click('#launchBtn');
        await page.waitForTimeout(60);
        const freshDialogs = (await ctx.dialogs()).slice(dialogsBefore);
        if (postsBefore() === before) alerts.push({ name, dialogs: freshDialogs });
    }
    t.eq('L2-CORPUS-Q18-blanked-count', 48, blanked.length,
        'Q18: with the recorded J2 option set every corpus modelPath is missing from the <option> list'
        + ' and blanks on load');
    t.eq('L2-CORPUS-Q18-alert-count', 48, alerts.length,
        'and every Launch click alerts instead of posting /start');
    const texts = [...new Set(alerts.map((row) => row.dialogs.map((dialog) => dialog.message).join('|')))];
    const recordedAlerts = rows.size ? [...new Set([...rows.values()].map((row) => row.dialogs
        .map((dialog) => dialog.message).join('|')))] : texts;
    t.eq('L2-CORPUS-Q18-alert-text', recordedAlerts, texts,
        'the alert text matches what the legacy page alerted with (recorded by tests/L2-ui/record-inputs.js)');
    t.eq('L2-CORPUS-Q18-no-posts', 0, ctx.mocks.of('POST /start').length,
        'nothing was posted in this mode (launchServer returns before fetch)');
    ctx.note('corpus-alert-blocked', 'all 48 configs alert-blocked with: ' + texts.join(' | '));
    await ctx.close();
}

// Re-save every config (edit → Save) and compare the written entry bytes, the storage key order and
// the orphan-key drop against the golden recorded from the baseline saveCurrentValues slice.
async function resaveEveryConfig(ctx) {
    const t = ctx.results;
    t.group('corpus');
    const resave = fixtures.resaveGoldens();
    if (!resave) {
        t.fail('L2-CORPUS-resave', 'fixtures/goldens/resave/goldens.jsonl present', 'missing',
            'run node tests/L2-ui/record-inputs.js && node tools/parity/gen-goldens.js');
        return;
    }
    const { page, corpus } = await openCorpus(ctx);
    const seedJson = await browser.storageValue(page, 'llamaCppConfigs');
    const byteMismatches = [];
    const orphanMismatches = [];
    for (const name of corpus.names) {
        const golden = resave.byName.get(name);
        await browser.clickConfig(page, name, '.edit-btn');
        await page.waitForSelector('#configFormContainer[open]');
        await page.click('#saveConfigBtn');
        await page.waitForTimeout(60);
        const storage = JSON.parse(await browser.storageValue(page, 'llamaCppConfigs'));
        const written = JSON.stringify(storage[name]);
        if (written !== golden.saved_config) {
            byteMismatches.push({ name, expected: golden.saved_config, actual: written });
        }
        const dropped = ORPHAN_KEYS.filter((key) => key in corpus.configs[name] && !(key in storage[name]));
        const expectedDropped = ORPHAN_KEYS.filter((key) => corpus.configs[name][key] !== undefined
            && !golden.saved_field_order.includes(key));
        if (JSON.stringify(dropped) !== JSON.stringify(expectedDropped)) {
            orphanMismatches.push({ name, dropped, expectedDropped });
        }
        if (Object.keys(storage).some((key) => !(key in corpus.configs))) {
            orphanMismatches.push({ name, unexpected: 'storage gained a key' });
        }
    }
    t.eq('L2-CORPUS-resave-bytes', [], byteMismatches,
        'every re-saved entry is byte-identical to the baseline saveCurrentValues output for that'
        + ' config (fixtures/goldens/resave, recorded from parity-baseline)');
    t.eq('L2-CORPUS-resave-orphans', [], orphanMismatches,
        'Q16: the orphan keys are dropped for exactly the configs that carried them');
    t.eq('L2-CORPUS-resave-key-order', corpus.names,
        Object.keys(JSON.parse(await browser.storageValue(page, 'llamaCppConfigs'))),
        're-saving does not reorder the storage keys: the order is still the seeded insertion order '
        + '(that order is what drives ini sections, §9 trap 6)');
    t.ok('L2-CORPUS-resave-changed-something', seedJson !== await browser.storageValue(page, 'llamaCppConfigs'),
        'the re-saves really rewrote storage');
    await ctx.close();
}

// A single re-save against the FULL expected localStorage bytes (not just the one entry), for
// configs that carry every orphan key shape.
async function resaveWholeStorage(ctx) {
    const t = ctx.results;
    t.group('corpus');
    const resave = fixtures.resaveGoldens();
    if (!resave) return;
    const corpus = fixtures.corpusSeed();
    const withOrphans = corpus.names.filter((name) => ORPHAN_KEYS.some((key) => key in corpus.configs[name]));
    const targets = [corpus.names[0], withOrphans[0], withOrphans[withOrphans.length - 1]];
    for (const name of targets) {
        const golden = resave.byName.get(name);
        const other = corpus.names.find((entry) => entry !== name);
        const seedJson = JSON.stringify({ [name]: corpus.configs[name], [other]: corpus.configs[other] });
        const { page } = await ctx.open({ seed: { configsKey: 'llamaCppConfigs', configsJson: seedJson,
            settingsKey: 'llamaCppSettings', settingsJson: corpus.settingsJson }, models: 'corpus' });
        await page.waitForSelector('#configList .config-item');
        await browser.clickConfig(page, name, '.edit-btn');
        await page.waitForSelector('#configFormContainer[open]');
        await page.click('#saveConfigBtn');
        await page.waitForTimeout(150);
        const written = await browser.storageValue(page, 'llamaCppConfigs');
        const expected = JSON.stringify({ [name]: JSON.parse(golden.saved_config),
            [other]: corpus.configs[other] });
        t.eq('L2-CORPUS-resave-whole-bytes-' + name, expected, written,
            'the exact localStorage bytes written for ' + JSON.stringify(name)
            + ', other config untouched and in place');
        t.eq('L2-CORPUS-resave-sha-' + name, fixtures.sha256(expected), fixtures.sha256(written),
            'full-storage digest for ' + JSON.stringify(name));
        await ctx.close();
    }
}

async function iniBytesFromAll(ctx) {
    const t = ctx.results;
    t.group('corpus');
    const goldens = fixtures.corpusGoldens();
    const corpus = fixtures.corpusSeed();
    const { page } = await openCorpus(ctx);
    const options = await browser.optionValues(page, 'launchPresetsSelect');
    t.ok('L2-INI-presets-dropdown', options.includes(corpus.configs[corpus.names[0]].serverPath),
        'the presets dropdown is populated from the stored serverPaths');
    await page.selectOption('#launchPresetsSelect', corpus.configs[corpus.names[0]].serverPath);
    await page.click('#launchPresetsBtn');
    const posted = await ctx.mocks.waitFor('POST /launch-presets', 1, 8000)
        ? ctx.mocks.lastJson('POST /launch-presets') : null;
    if (!posted) {
        t.fail('L2-INI-all48', 'POST /launch-presets issued', 'nothing posted',
            'the page did not generate the ini (a throw inside launchModelPresets would show in the pane)');
        return;
    }
    const expected = expectedIni(goldens, corpus.names, corpus.settings.serverPort);
    t.eq('L2-INI-all48-bytes', expected, posted.presets,
        'the models-preset.ini bytes generated from ALL 48 configs equal the gen-goldens corpus ini'
        + ' output composed in storage insertion order, with the trailing port line (Q10)');
    t.eq('L2-INI-all48-section-order', corpus.names.map((name) => '[' + name + ']'),
        posted.presets.split('\n').filter((line) => /^\[.+\]$/.test(line)),
        '§9 trap 6: ini section order is Object.entries(localStorage) order, not the alphabetical render order');
    const sections = posted.presets.slice(INI_HEADER.length).split('\n\n').filter((block) => block !== '');
    const perConfig = [];
    corpus.names.forEach((name, index) => {
        const want = iniSection(goldens.byName.get(name).golden).replace(/\n$/, '');
        if (sections[index] !== want) perConfig.push(name + ': section ' + index + ' differs');
    });
    t.eq('L2-INI-all48-per-section', [], perConfig,
        'each of the 48 ini sections equals its own corpus golden (the composition is per-config)');
    t.eq('L2-INI-trailing-port', 'port = ' + corpus.settings.serverPort + '\n',
        posted.presets.slice(posted.presets.length - 'port = 7838\n'.length),
        'Q10: the ini ends with the trailing `port = ` line');
    t.eq('L2-INI-body-keys', ['presets', 'serverPath', 'serverPort'].sort(), Object.keys(posted).sort(),
        'the /launch-presets body is {presets, serverPath, serverPort}');
    const pane = await browser.pane(page);
    t.ok('L2-INI-pane-before-port-line', pane.text.includes('Generated models-preset.ini content:'),
        'the pane prints the sections before the port line is appended (recorded J4b claim)');
    await ctx.close();
}

// Two configs, both insertion orders: no recorded generator vector has more than one saved config,
// so ini SECTION ORDER is only assertable here (supervisor requirement, plan §9 trap 6).
async function iniTwoConfigSubset(ctx) {
    const t = ctx.results;
    t.group('corpus');
    const goldens = fixtures.corpusGoldens();
    const corpus = fixtures.corpusSeed();
    const pair = [corpus.names[3], corpus.names[9]];
    const results = {};
    for (const order of [pair, pair.slice().reverse()]) {
        const { page } = await ctx.open({ seed: fixtures.corpusSubsetSeed(order), models: 'corpus',
            settleMs: 600 });
        await page.waitForSelector('#configList .config-item');
        const options = await browser.optionValues(page, 'launchPresetsSelect');
        await page.selectOption('#launchPresetsSelect', options[1]);
        await page.click('#launchPresetsBtn');
        const ok = await ctx.mocks.waitFor('POST /launch-presets', 1, 8000);
        const posted = ok ? ctx.mocks.lastJson('POST /launch-presets') : null;
        results[order.join('>')] = posted;
        const expected = expectedIni(goldens, order, corpus.settings.serverPort);
        t.eq('L2-INI-2config-' + order.join('-'), expected, posted && posted.presets,
            'ini bytes from a deterministic 2-config subset (' + order.join(', ') + ')');
        t.eq('L2-INI-2config-order-' + order.join('-'), order.map((name) => '[' + name + ']'),
            posted ? posted.presets.split('\n').filter((line) => /^\[.+\]$/.test(line)) : [],
            'section order follows the storage insertion order for this seed');
        const rendered = (await browser.configRows(page)).map((row) => row.name);
        t.eq('L2-INI-2config-render-always-sorted-' + order.join('-'), order.slice().sort(), rendered,
            'while the rendered list stays alphabetical, whatever the insertion order');
        await ctx.close();
    }
    const forward = results[pair.join('>')];
    const reverse = results[pair.slice().reverse().join('>')];
    t.ok('L2-INI-2config-order-matters', forward && reverse && forward.presets !== reverse.presets,
        'the two seeds produce different bytes: the order claim is real, not vacuous');
    const swapped = forward.presets.replace(new RegExp('\\[' + pair[0] + '\\]\\n'), '[SWAPPED]\n');
    t.ok('L2-INI-2config-only-order-differs', swapped.includes('[SWAPPED]'),
        'sanity: both section names are present in the forward seed');
}

const checks = [
    { id: 'corpus-list', title: '48 configs, legacy sort order', quirk: '§9 trap 6', run: listAndOrder },
    { id: 'corpus-launch', title: 'load + launch all 48, argv positionally', quirk: 'Q18 Q19 Q20 Q21 Q22 Q7',
        run: launchEveryConfig },
    { id: 'corpus-alerts', title: 'recorded /models payload: Q18 blanking + alert text', quirk: 'Q18 Q13',
        run: alertBlockedMode },
    { id: 'corpus-resave', title: 're-save all 48, exact bytes + orphan drop', quirk: 'Q16',
        run: resaveEveryConfig },
    { id: 'corpus-resave-whole', title: 'single re-save, full storage bytes', quirk: 'Q16',
        run: resaveWholeStorage },
    { id: 'corpus-ini', title: 'ini bytes from all 48 + 2-config subset', quirk: 'Q10 Q17 §9 trap 6',
        run: iniBytesFromAll },
    { id: 'corpus-ini-subset', title: 'ini section order, 2-config subset both ways', quirk: '§9 trap 6',
        run: iniTwoConfigSubset }
];

module.exports = checks;
