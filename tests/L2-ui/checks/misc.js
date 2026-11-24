'use strict';
// Remaining L2 rows that are neither field-table nor corpus: the client-side DEFAULT_PORT fallback
// (Q5's 8080 half), the two model dropdowns fetchModels fills, the presets dropdown population, and
// the Q1 Restart button in every state this suite can reach.

const browser = require('../helpers/browser');
const fixtures = require('../helpers/fixtures');

async function defaultPort(ctx) {
    const t = ctx.results;
    t.group('misc');
    const { page, mocks } = await ctx.open({ seed: { configsKey: 'llamaCppConfigs', configsJson: '{}',
        settingsKey: 'llamaCppSettings', settingsJson: null } });
    await page.fill('#serverPath', 'C:/parity-scratch/bin/fake-llama-server.exe');
    await page.selectOption('#modelPath', fixtures.modelsPayload().models[1].path);
    await page.click('#launchBtn');
    const posted = await ctx.mocks.waitFor('POST /start', 1, 5000) ? ctx.mocks.lastJson('POST /start') : null;
    t.ok('L2-PORT-default-posted', !!posted, 'launch posted /start with no stored settings');
    if (posted) {
        t.eq('L2-PORT-default-8080', '8080', posted.args[posted.args.indexOf('--port') + 1],
            'Q5: with no llamaCppSettings the client uses DEFAULT_PORT 8080');
        const model = fixtures.modelsPayload().models[1];
        t.eq('L2-PORT-argv-tail', ['--host', '0.0.0.0', '-fit', 'off', '--port', '8080',
            '--mmproj', model.mmprojFile], posted.args.slice(-8),
            'Q14/Q5/Q21: --host 0.0.0.0, then -fit off, then --port, then the selected model mmproj —'
            + ' the order the recorded goldens end with (cover2-006)');
    }
    await ctx.close();
}

async function modelDropdowns(ctx) {
    const t = ctx.results;
    t.group('misc');
    const recorded = fixtures.modelsPayload();
    const { page } = await ctx.open({ seed: { configsKey: 'llamaCppConfigs', configsJson: '{}',
        settingsKey: 'llamaCppSettings', settingsJson: null } });
    const main = await browser.optionValues(page, 'modelPath');
    const draft = await browser.optionValues(page, 'draftModelPath');
    t.eq('L2-MODELS-options', [''].concat(recorded.models.map((model) => model.path)), main,
        'the model dropdown holds the placeholder plus every recorded /models path');
    t.eq('L2-MODELS-draft-options', [''].concat(recorded.models.map((model) => model.path)), draft,
        'the draft dropdown gets the same options (fetchModels clones them)');
    const labels = await page.$$eval('#modelPath option', (nodes) => nodes.map((node) => node.textContent));
    t.eq('L2-MODELS-labels', ['-- Select a Model --'].concat(recorded.models.map((model) => model.relativePath || model.name)),
        labels, 'option text is relativePath || name, as the recorded payload provides');
    t.eq('L2-MODELS-failure-line', false, (await browser.pane(page)).text.includes('Error fetching models'),
        'a successful /models fetch leaves no error line in the pane');
    await ctx.close();

    const broken = await ctx.open({ seed: { configsKey: 'llamaCppConfigs', configsJson: '{}',
        settingsKey: 'llamaCppSettings', settingsJson: null },
    mocks: { 'GET /models': JSON.stringify({ success: false, error: 'models directory missing' }) } });
    const pane = await browser.pane(broken.page);
    t.ok('L2-MODELS-error-line', pane.text.includes('Error fetching models: models directory missing'),
        'a success:false /models body prints the recorded error path');
    t.eq('L2-MODELS-error-keeps-placeholder', [''], await browser.optionValues(broken.page, 'modelPath'),
        'the failed fetch leaves the markup placeholder in place (the select is only rebuilt on success)');
    await ctx.close();
}

async function presetsDropdown(ctx) {
    const t = ctx.results;
    t.group('misc');
    const corpus = fixtures.corpusSeed();
    // populateLaunchPresetsDropdown trims each path before adding it to its Set, so paths that differ
    // only by surrounding whitespace collapse into one option.
    const distinct = [...new Set(corpus.names.map((name) => String(corpus.configs[name].serverPath || '')
        .trim()).filter((value) => value !== ''))];
    const { page } = await ctx.open({ seed: corpus, models: 'corpus', settleMs: 800 });
    const options = await browser.optionValues(page, 'launchPresetsSelect');
    t.eq('L2-PRESETS-distinct-count', distinct.length, options.length - 1,
        'the presets dropdown holds one option per distinct TRIMMED stored serverPath (' + distinct.length
        + ' of ' + corpus.names.length + ' configs)');
    t.eq('L2-PRESETS-values', distinct, options.slice(1),
        'the option values are the trimmed stored paths, in Set (insertion) order');
    t.eq('L2-PRESETS-placeholder-first', '-- Select Server Path --',
        await page.$$eval('#launchPresetsSelect option', (nodes) => nodes[0].textContent),
        'the dropdown keeps its placeholder option');
    await ctx.close();
}

async function restartButtonEverywhere(ctx) {
    const t = ctx.results;
    t.group('misc');
    const disabled = (page) => page.evaluate(() => ({
        restart: document.getElementById('restartBtn').disabled,
        restartAttribute: document.getElementById('restartBtn').hasAttribute('disabled')
    }));
    const { page } = await ctx.open({ seed: fixtures.smallSeed() });
    const everyState = { restart: true, restartAttribute: true };
    t.eq('L2-Q1-fresh', everyState, await disabled(page),
        'Q1: disabled in the markup, and the line in updateButtonStates that would enable it is'
        + ' commented out, so the attribute never leaves');
    await browser.clickConfig(page, 'capture-alpha');
    t.eq('L2-Q1-config-selected', everyState, await disabled(page),
        'Q1 holds after selecting a config');
    await page.fill('#serverPath', 'C:/parity-scratch/bin/fake-llama-server.exe');
    await page.selectOption('#modelPath', fixtures.modelsPayload().models[1].path);
    await page.click('#launchBtn');
    await ctx.mocks.waitFor('POST /start', 1, 5000);
    t.eq('L2-Q1-running', everyState, await disabled(page),
        'Q1 holds while the page believes a server is running (updateButtonStates(true) skips restartBtn)');
    await page.click('#settingsBtn');
    await page.waitForSelector('dialog.settings-dialog[open]');
    t.eq('L2-Q1-settings-dialog', everyState, await disabled(page),
        'Q1 holds with a modal dialog open');
    await page.click('#cancelSettingsBtn');
    await page.click('#stopBtn');
    await ctx.mocks.waitFor('POST /stop', 1, 5000);
    t.eq('L2-Q1-stopped', everyState, await disabled(page),
        'Q1 holds after stopping');
    await browser.clickConfig(page, 'capture-alpha', '.delete-btn');
    t.eq('L2-Q1-after-delete-prompt', everyState, await disabled(page),
        'Q1 holds while the delete confirm is up (dismissed by the harness)');
    await ctx.close();
}

module.exports = [
    { id: 'default-port', title: 'DEFAULT_PORT fallback and the always-appended argv tail',
        quirk: 'Q5 Q14', run: defaultPort },
    { id: 'model-dropdowns', title: 'model + draft dropdowns from /models', quirk: '—', run: modelDropdowns },
    { id: 'presets-dropdown', title: 'presets dropdown population', quirk: '—', run: presetsDropdown },
    { id: 'q1-states', title: 'Restart disabled in every state', quirk: 'Q1', run: restartButtonEverywhere }
];
