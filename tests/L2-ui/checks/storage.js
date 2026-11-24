'use strict';
// Config CRUD against localStorage: exact written bytes, alphabetical render, active class, empty
// state; the Q8 partial reset asserted on EVERY control (including the ones it does not reset); the
// Q16 orphan-key drop; and the Q7 "launchServer re-reads the DOM" claim.
//
// Where a byte-level expectation exists it comes from a recording: the edit-save journey reproduced
// here is the one that produced fixtures/localstorage/J5-ui-states/after-save-config.json and
// q8-delete-reset.json, seeded from those recorded localStorage bytes.

const browser = require('../helpers/browser');
const fixtures = require('../helpers/fixtures');

const ORPHAN_KEYS = ['mlock', 'noMmap', 'ndio', 'dio', 'draftMin', 'draftMax', 'draftPMin',
    'disableReasoning'];

// The model path the mocked /models payload really offers, so Launch is not alert-blocked.
const KNOWN_MODEL = () => fixtures.modelsPayload().models.find((model) => model.path
    .endsWith('models\\a\\model-a.gguf')).path;

async function emptyState(ctx) {
    const t = ctx.results;
    for (const [name, configsJson] of [['empty-object', '{}'], ['key-absent', null]]) {
        const { page } = await ctx.open({ seed: { configsKey: 'llamaCppConfigs', configsJson,
            settingsKey: 'llamaCppSettings', settingsJson: null } });
        const empty = await page.$$eval('#configList .empty-configs',
            (nodes) => nodes.map((node) => ({ text: (node.textContent || '').trim(),
                parentIsList: node.parentElement.id === 'configList' })));
        t.eq('L2-CRUD-empty-' + name, [{ text: 'No configurations saved', parentIsList: true }], empty,
            'empty state renders the recorded empty-configs element (seed ' + name + ')');
        t.eq('L2-CRUD-empty-' + name + '-rows', 0,
            await page.$$eval('#configList .config-item', (nodes) => nodes.length),
            'no config rows in the empty state');
        await ctx.close();
    }
}

async function createFlow(ctx) {
    const t = ctx.results;
    const recorded = fixtures.recordedDialogs();
    const emptyNameAlert = recorded.configNameAlert[0];
    const goldens = fixtures.resaveGoldens();
    const { page, mocks } = await ctx.open({ seed: { configsKey: 'llamaCppConfigs', configsJson: '{}',
        settingsKey: 'llamaCppSettings', settingsJson: null } });

    await page.click('#addConfigBtn');
    await page.waitForSelector('#configFormContainer[open]');
    t.eq('L2-CRUD-create-title', 'Create New Configuration',
        await page.textContent('#configFormTitle'), 'addConfigBtn opens the create form');
    t.eq('L2-CRUD-create-name-empty', '', await page.inputValue('#configName'),
        'the create form starts with an empty name');

    const dialogsBefore = (await ctx.dialogs()).length;
    await page.click('#saveConfigBtn');
    await page.waitForTimeout(200);
    const newDialogs = (await ctx.dialogs()).slice(dialogsBefore);
    t.eq('L2-CRUD-create-empty-name-alert', [emptyNameAlert], newDialogs,
        'saving with no name alerts with the recorded text and keeps the dialog open (Q13)');
    t.ok('L2-CRUD-create-empty-name-dialog-open',
        await page.evaluate(() => document.getElementById('configFormContainer').open),
        'the form stays open after the alert, so it covers the page (recorded Q13 evidence)');
    t.eq('L2-CRUD-create-empty-name-no-write', '{}', await browser.storageValue(page, 'llamaCppConfigs'),
        'the rejected save wrote nothing to localStorage');

    await page.fill('#configName', 'L2 New Config');
    await page.click('#saveConfigBtn');
    await page.waitForTimeout(200);
    const written = await browser.storageValue(page, 'llamaCppConfigs');
    const rows = await browser.configRows(page);
    t.eq('L2-CRUD-create-listed', [{ name: 'L2 New Config', active: false, hasEdit: true,
        hasDelete: true }], rows, 'the created config is rendered, and not marked active');
    const saved = JSON.parse(written)['L2 New Config'];
    if (goldens && goldens.byName.has('parity-ui-check')) {
        // The recorder created a config named parity-ui-check from the same blank form; the entry it
        // wrote is the byte claim (the surrounding storage map differs by this run's config name).
        const golden = goldens.byName.get('parity-ui-check');
        t.eq('L2-CRUD-create-storage-bytes', golden.saved_config, JSON.stringify(saved),
            'the exact localStorage entry the baseline writes for a fresh form save '
            + '(fixtures/goldens/resave, op=create)');
        t.eq('L2-CRUD-create-field-order', golden.saved_field_order, Object.keys(saved),
            'the saved object carries the 36-field set in the order saveCurrentValues writes it'
            + ' (Q7: not the launch set)');
    } else {
        t.fail('L2-CRUD-create-storage-bytes', 'op=create golden parity-ui-check present', 'missing',
            'run node tests/L2-ui/record-inputs.js && node tools/parity/gen-goldens.js');
    }
    t.eq('L2-CRUD-create-no-orphans', [], ORPHAN_KEYS.filter((key) => key in saved),
        'a fresh save writes no orphan keys (Q16: saveCurrentValues builds a fresh object)');
    t.eq('L2-CRUD-create-form-cleared', ['', 'Create New Configuration'],
        [await page.inputValue('#configName'), await page.textContent('#configFormTitle')],
        'saveConfiguration clears the name input and the title');
    t.ok('L2-CRUD-create-dialog-closed',
        await page.evaluate(() => !document.getElementById('configFormContainer').open),
        'the form closes after a successful save');
    t.eq('L2-CRUD-create-no-launch-post', 0, mocks.of('POST /start').length,
        'saving a config does not launch anything');
    await ctx.close();
}

async function alphabeticalAndActive(ctx) {
    const t = ctx.results;
    const corpus = fixtures.corpusSeed();
    const recordedList = fixtures.corpusConfigList();
    const { page } = await ctx.open({ seed: corpus, modelsMode: 'corpus', settleMs: 800 });
    const rows = await browser.configRows(page);
    t.eq('L2-CRUD-alphabetical', recordedList.renderedOrder, rows.map((row) => row.name),
        'the rendered list equals the order the legacy page rendered (recorded), which is .sort() order');
    t.eq('L2-CRUD-sort-vs-insertion', recordedList.legacySortReference, rows.map((row) => row.name),
        'and that is the legacy .sort() of the storage keys, not the insertion order (plan §9 trap 6)');
    t.ok('L2-CRUD-insertion-order-differs',
        JSON.stringify(recordedList.corpusInsertionOrder) !== JSON.stringify(rows.map((row) => row.name)),
        'the render order really is a sort: it differs from the localStorage insertion order');
    const names = rows.map((row) => row.name);
    await browser.clickConfig(page, names[3]);
    t.eq('L2-CRUD-active-single', [names[3]],
        (await browser.configRows(page)).filter((row) => row.active).map((row) => row.name),
        'selecting a config marks exactly that row active');
    await browser.clickConfig(page, names[40]);
    t.eq('L2-CRUD-active-moves', [names[40]],
        (await browser.configRows(page)).filter((row) => row.active).map((row) => row.name),
        'the active class moves to the newly selected row');
    const facts = await browser.fieldMap(page);
    t.ok('L2-CRUD-select-fills-form', facts.byId.serverPath.value !== '',
        'selecting a config fills the form from the stored values');
    await ctx.close();
}

// The recorded Q8 journey: seed the recorded two-config state, save capture-beta through the edit
// form, select it, delete it with the confirm accepted, and compare every control value against the
// recording (fixtures/localstorage/J5-ui-states/{after-save-config,after-delete}.json).
async function editSaveAndDelete(ctx) {
    const t = ctx.results;
    const seed = fixtures.smallSeed();
    const recordedAfterSave = fixtures.uiFieldState('after-save-config');
    const recordedAfterDelete = fixtures.uiFieldState('after-delete');
    const recordedQ8 = fixtures.q8DeleteReset();
    const recordedStorage = JSON.parse(seed.configsJson);
    const { page, dialogs } = await ctx.open({ seed });

    const storageBeforeEdit = await browser.storageValue(page, 'llamaCppConfigs');
    const editIndex = await browser.clickConfig(page, 'capture-beta', '.edit-btn');
    await page.waitForSelector('#configFormContainer[open]');
    t.eq('L2-CRUD-edit-title', 'Edit Configuration', await page.textContent('#configFormTitle'),
        'the edit button opens the form titled Edit Configuration');
    t.eq('L2-CRUD-edit-name', 'capture-beta', await page.inputValue('#configName'),
        'the edit form is prefilled with the config name');
    t.eq('L2-CRUD-edit-opens-without-writing', storageBeforeEdit,
        await browser.storageValue(page, 'llamaCppConfigs'),
        'opening the editor writes nothing (editConfiguration only fills the name input)');
    void editIndex;
    await page.click('#saveConfigBtn');
    await page.waitForTimeout(250);

    const savedJson = await browser.storageValue(page, 'llamaCppConfigs');
    t.eq('L2-CRUD-edit-save-storage-bytes', recordedStorageAfterSave(), savedJson,
        'the exact localStorage bytes the recorded edit-save journey wrote (recorded: form values of a '
        + 'page that never loaded the config, so they are the HTML defaults re-read from the DOM)');
    const afterSaveFields = await browser.fields(page);
    t.eq('L2-CRUD-edit-save-fields', recordedAfterSave.fields, afterSaveFields,
        'every control still holds the recorded value after the save');

    await browser.clickConfig(page, 'capture-beta');
    await page.waitForSelector('#configList .config-item.active');
    const beforeDelete = await browser.fieldMap(page);
    t.ok('L2-CRUD-delete-loaded-before-reset',
        beforeDelete.byId.ngl.value === String(recordedStorage['capture-beta'].ngl),
        'the loaded capture-beta values are in the form before the delete resets some of them');

    ctx.setDialogAction('accept');
    const beforeCount = (await browser.configRows(page)).length;
    await browser.clickConfig(page, 'capture-beta', '.delete-btn');
    await page.waitForTimeout(300);
    ctx.setDialogAction('dismiss');
    const rowsAfter = await browser.configRows(page);
    t.eq('L2-CRUD-delete-confirm-text',
        [{ type: 'confirm', message: 'Are you sure you want to delete the configuration "capture-beta"?' }],
        dialogs.filter((dialog) => /delete the configuration/.test(dialog.message)),
        'the delete confirm text is legacy wording with the config name interpolated (Q13)');
    t.eq('L2-CRUD-delete-removes-one', beforeCount - 1, rowsAfter.length,
        'accepting the confirm removes exactly that config');
    // The surviving entry is NOT the seed entry: the edit-save earlier in this check rewrote
    // capture-alpha through saveCurrentValues, and the recorded after-save-config.json holds exactly
    // that state, so the expectation comes from the fixture minus the deleted config.
    const afterSaveMap = JSON.parse(recordedStorageAfterSave());
    const storedAfterDelete = await browser.storageValue(page, 'llamaCppConfigs');
    t.eq('L2-CRUD-delete-storage', JSON.stringify({ 'capture-alpha': afterSaveMap['capture-alpha'] }),
        savedRebuild(storedAfterDelete),
        'the remaining stored bytes are the other config, exactly as the recorded edit-save wrote it');
    t.eq('L2-CRUD-delete-only-that-key', ['capture-alpha'],
        Object.keys(JSON.parse(storedAfterDelete)), 'and only the deleted key left the store');

    const afterFields = await browser.fieldMap(page);
    const recordedRows = recordedAfterDelete.fields.filter((row) => row.id);
    const mismatches = recordedRows.filter((row) => {
        const control = afterFields.byId[row.id];
        return !control || control.value !== row.value || control.checked !== row.checked
            || control.disabled !== row.disabled;
    }).map((row) => row.id + ': recorded ' + JSON.stringify([row.value, row.checked, row.disabled])
        + ' rendered ' + JSON.stringify([(afterFields.byId[row.id] || {}).value,
            (afterFields.byId[row.id] || {}).checked, (afterFields.byId[row.id] || {}).disabled]));
    t.eq('L2-Q8-every-control', [], mismatches,
        'Q8: after deleting the active config EVERY control reads the value the recording has, '
        + 'including the controls deleteConfiguration does NOT reset');

    // The reset list itself. deleteConfiguration (parity-baseline public/script.js) resets a
    // hard-coded list to hard-coded values, so the expectation is that list — not the recorded diff,
    // which only shows the controls that were not already at their reset value in that run's state.
    const RESET = {
        serverPath: { value: '' }, modelPath: { value: '' }, ngl: { value: '99' },
        threads: { value: '12' }, temp: { value: '0.7' }, topK: { value: '20' },
        topP: { value: '0.00' }, repeatPenalty: { value: '1.05' }, loadMode: { value: 'mmap' },
        swaFull: { checked: false }, noMmprojOffload: { checked: false },
        contextSize: { value: '16384' }, nCpuMoe: { value: '8' }, cpuMoe: { checked: false },
        cacheRam: { value: '8192' }, ctkEnable: { checked: false },
        speculationType: { value: 'none' }, ngramMod: { checked: false },
        specDraftNMax: { value: '0' }, loadCustomChatTemplate: { checked: false },
        draftModelPath: { value: '' }, ngld: { value: '0' }, ctkd: { value: 'f16' },
        ctvd: { value: 'f16' }
    };
    const rows = recordedRows.map((row) => {
        const before = beforeDelete.byId[row.id] || {};
        const after = afterFields.byId[row.id] || {};
        const defaults = fixtures.uiFieldState('fresh').fields.find((control) => control.id === row.id) || {};
        const reset = RESET[row.id];
        const isReset = (control) => (reset.value !== undefined ? control.value === reset.value
            : control.checked === reset.checked);
        return { id: row.id, before: { value: before.value, checked: before.checked },
            after: { value: after.value, checked: after.checked },
            changed: before.value !== after.value || before.checked !== after.checked,
            onResetValue: reset ? isReset(after) : false,
            isResetTarget: !!reset,
            offListValue: reset ? null : after.value,
            equalsHtmlDefault: defaults.value === after.value && defaults.checked === after.checked };
    });
    const touched = rows.filter((row) => row.changed);
    t.eq('L2-Q8-reset-only-list', [], touched.filter((row) => !row.isResetTarget)
        .map((row) => row.id + ' → ' + JSON.stringify(row.offListValue)),
        'every control the delete changed is one of the 24 controls deleteConfiguration resets'
        + ' (parity-baseline script.js, hard-coded list)');
    t.eq('L2-Q8-reset-values', [], touched.filter((row) => !row.onResetValue)
        .map((row) => row.id + ' → ' + JSON.stringify(row.after)),
        'and each of them holds exactly the value the list assigns');
    t.eq('L2-Q8-reset-misses', [], rows.filter((row) => row.isResetTarget && !row.changed
        && !row.onResetValue).map((row) => row.id),
        'no reset-list control was left off its reset value (a control can be unchanged because it'
        + ' already held the reset value, which is why "changed" is not the claim)');
    const recordedLoadMode = recordedQ8.rows.find((row) => row.id === 'loadMode');
    const loadMode = rows.find((row) => row.id === 'loadMode');
    t.eq('L2-Q8-loadMode-recorded-row', [recordedLoadMode.after.value, recordedLoadMode.changed,
        recordedLoadMode.equalsHtmlDefault],
        [loadMode.after.value, loadMode.changed, loadMode.equalsHtmlDefault],
        'the recorded q8-delete-reset row for loadMode is reproduced: reset to "mmap", and that is not'
        + ' the HTML default option (Q8: the reset list diverges from the markup defaults)');
    t.ok('L2-Q8-loadMode-divergence',
        touched.some((row) => row.id === 'loadMode' && !row.equalsHtmlDefault),
        'Q8: loadMode is reset to mmap while the HTML default option is none (the divergence this row is about)');
    t.eq('L2-Q8-control-count', recordedQ8.controlCount, afterFields.rows.length,
        'the comparison covers the same number of controls as the recording');
    await ctx.close();
}

// The recorded journey's expected bytes: after-save-config.json holds the localStorage the legacy
// page wrote, so the expectation is read from that fixture rather than restated here.
function recordedStorageAfterSave() {
    const capture = fixtures.recordedStorage('J5-ui-states', 'after-save-config');
    return capture.configsJson;
}

function savedRebuild(json) {
    const parsed = JSON.parse(json);
    return JSON.stringify(parsed);
}

// Q16: orphan keys survive in storage, are never read by the field set, and disappear on re-save.
async function orphanKeys(ctx) {
    const t = ctx.results;
    const corpus = fixtures.corpusSeed();
    const withOrphans = corpus.list.filter((row) => ORPHAN_KEYS.some((key) => key in row.config));
    t.ok('L2-Q16-corpus-has-orphans', withOrphans.length >= 28,
        'the corpus carries orphan keys in ' + withOrphans.length + '/48 configs (Q16 evidence: 28)');
    const target = withOrphans[0];
    // Order follows the stored entry, so the assertion also proves the load did not rekey it.
    const storedOrphans = (entry) => Object.keys(entry).filter((key) => ORPHAN_KEYS.includes(key));
    const seedJson = JSON.stringify({ [target.name]: target.config });
    const { page } = await ctx.open({ seed: { configsKey: 'llamaCppConfigs', configsJson: seedJson,
        settingsKey: 'llamaCppSettings', settingsJson: corpus.settingsJson } });
    t.eq('L2-Q16-before-seed', storedOrphans(target.config),
        storedOrphans(JSON.parse(await browser.storageValue(page, 'llamaCppConfigs'))[target.name]),
        'the orphan keys are present in the seeded storage exactly as the corpus stores them'
        + ' (' + storedOrphans(target.config).join(', ') + ')');
    await browser.clickConfig(page, target.name);
    await page.waitForSelector('#configList .config-item.active');
    t.eq('L2-Q16-load-does-not-clean', seedJson, await browser.storageValue(page, 'llamaCppConfigs'),
        'loading a config does NOT migrate or clean the orphan keys (Q16: candidate must not clean on load)');
    t.eq('L2-Q16-load-keeps-keys', storedOrphans(target.config),
        storedOrphans(JSON.parse(await browser.storageValue(page, 'llamaCppConfigs'))[target.name]),
        'the stored entry still holds the same orphan keys, in the same order, after the load');

    await browser.clickConfig(page, target.name, '.edit-btn');
    await page.waitForSelector('#configFormContainer[open]');
    await page.click('#saveConfigBtn');
    await page.waitForTimeout(250);
    const after = JSON.parse(await browser.storageValue(page, 'llamaCppConfigs'))[target.name];
    t.eq('L2-Q16-resave-drops-orphans', [], ORPHAN_KEYS.filter((key) => key in after),
        're-saving writes a fresh object without the orphan keys (Q16)');
    t.eq('L2-Q16-resave-field-count', 36, Object.keys(after).length,
        'and the re-saved entry has exactly the 36 persisted fields');
    await ctx.close();
}

// Q7: launchServer re-reads the DOM rather than the saved config, and saveCurrentValues writes a
// different field set than the one the launch path builds.
async function configThenLaunch(ctx) {
    const t = ctx.results;
    const model = KNOWN_MODEL();
    const config = { serverPath: 'C:/parity-scratch/bin/fake-llama-server.exe', modelPath: model,
        ngl: 99, threads: 12, temp: 0.7, topK: 20, topP: '0.00', minP: '0', repeatPenalty: '1.05',
        presencePenalty: '0.00', parallel: 1, loadMode: 'mmap', speculationType: 'none' };
    const { page, mocks } = await ctx.open({ seed: { configsKey: 'llamaCppConfigs',
        configsJson: JSON.stringify({ 'l2-q7': config }), settingsKey: 'llamaCppSettings',
        settingsJson: JSON.stringify({ serverPort: 7838 }) } });
    await browser.clickConfig(page, 'l2-q7');
    await page.waitForSelector('#configList .config-item.active');
    await page.fill('#ngl', '5');
    await page.click('#launchBtn');
    const request = await mocks.waitFor('POST /start', 1) ? mocks.lastJson('POST /start') : null;
    t.ok('L2-Q7-launch-posts', !!request, 'the Launch click posted /start');
    if (request) {
        const at = request.args.indexOf('-ngl');
        t.eq('L2-Q7-argv-reads-dom', ['5', false],
            [at < 0 ? null : request.args[at + 1], request.args.includes('99')],
            'Q7: the argv carries the DOM value 5, not the stored 99 (launchServer re-reads the form)');
        t.eq('L2-Q7-argv-serverPath-not-a-flag', true, !request.args.some((arg) => /fake-llama-server/.test(arg)),
            'serverPath is the /start body field, never an argv entry');
        t.eq('L2-Q7-body-keys', ['args', 'serverPath'].sort(), Object.keys(request).sort(),
            'the /start body is {serverPath, args} (the launch field set, not the 36 saved fields)');
    }
    const saved = JSON.parse(await browser.storageValue(page, 'llamaCppConfigs'))['l2-q7'];
    t.eq('L2-Q7-resave-on-launch', 5, saved.ngl,
        'launching re-saves the config from the DOM (Q7: launchServer calls saveCurrentValues)');
    t.eq('L2-Q7-saved-field-set', 36, Object.keys(saved).length,
        'the saved set is the 36-field saveCurrentValues set, not the 35-entry launch literal');
    t.ok('L2-Q7-saved-has-serverPath-and-kwargs', 'serverPath' in saved && 'chatTemplateKwargs' in saved,
        'the saved set includes fields the launch literal does not read');
    t.eq('L2-Q7-launch-port-from-settings', '7838',
        request && request.args[request.args.indexOf('--port') + 1],
        'Q5/Q7: --port comes from localStorage settings at launch time');
    await ctx.close();
}

const checks = [
    { id: 'crud-empty', title: 'empty state', quirk: '—', run: emptyState },
    { id: 'crud-create', title: 'create config → exact localStorage JSON', quirk: 'Q16', run: createFlow },
    { id: 'crud-list', title: 'alphabetical render + active class', quirk: '§9 trap 6', run: alphabeticalAndActive },
    { id: 'crud-edit-delete', title: 'edit save bytes + Q8 partial reset on every control', quirk: 'Q8',
        run: editSaveAndDelete },
    { id: 'crud-orphans', title: 'orphan keys survive load, drop on re-save', quirk: 'Q16', run: orphanKeys },
    { id: 'q7-launch', title: 'launch re-reads the DOM', quirk: 'Q7', run: configThenLaunch }
];

module.exports = checks;
