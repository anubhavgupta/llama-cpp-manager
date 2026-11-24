'use strict';
// The action script, UI half: what the same page renders and writes when the journeys run against
// this side's manager. The observations are the ones L2 asserts (field attributes, option lists,
// rendered order, re-saved bytes, Q8 partial reset, native dialog text), recorded as fields here.

const readers = require('../../L3-seam/helpers/browser-readers');
const page = require('../../L3-seam/helpers/page');
const { uiSeed } = require('../../L3-seam/helpers/seeds');
const { tokenise } = require('./tokenise');

async function ui(ctx) {
    const manager = ctx.manager;
    const add = (key, family, value) => ctx.observe.add(key, family, tokenise(manager, value));
    let session = null;
    try {
        session = await page.open(manager, { seed: uiSeed(manager), browser: ctx.browser });
        await session.page.waitForSelector('#configList .config-item');

        const rows = await readers.configRows(session.page);
        add('ui.config-list.names', null, rows.map((row) => row.name));
        add('ui.config-list.active', null, rows.map((row) => (row.active ? 'active' : '')));
        add('ui.restart-btn.disabled', null,
            await session.page.$eval('#restartBtn', (node) => node.disabled));
        add('ui.stop-btn.disabled.idle', null,
            await session.page.$eval('#stopBtn', (node) => node.disabled));

        const facts = await readers.controlFacts(session.page);
        add('ui.control-facts', 'screenshots/J5-ui-states/state-notes.json', facts.rows.map((row) => ({
            id: row.id, tag: row.tag, type: row.type, min: row.min, max: row.max, step: row.step,
            value: row.value, defaultValue: row.defaultValue, checked: row.checked,
            disabled: row.disabled, options: row.options ? row.options.map((option) => option.value) : null
        })).filter((row) => row.id));
        add('ui.options.modelPath', null, await readers.optionValues(session.page, 'modelPath'));
        add('ui.options.launchPresets', null,
            await readers.optionValues(session.page, 'launchPresetsSelect'));

        // Q16/Q7: re-saving through the edit form rewrites exactly the 36 fields saveCurrentValues
        // names, in its order, dropping the orphan keys.
        const seedJson = await readers.storageValue(session.page, 'llamaCppConfigs');
        await readers.clickConfig(session.page, 'capture-alpha', '.edit-btn');
        await session.page.waitForSelector('#configFormContainer[open]');
        await session.page.click('#saveConfigBtn');
        await session.page.waitForTimeout(150);
        const written = await readers.storageValue(session.page, 'llamaCppConfigs');
        add('ui.resave.bytes', 'goldens/resave/goldens.jsonl', written);
        add('ui.resave.changed', null, written !== seedJson);
        add('ui.resave.entry-keys', null, Object.keys(JSON.parse(written)['capture-alpha']));

        // Q8: deleting resets only the hard-coded subset, so the untouched fields keep their values.
        await session.selectConfig('capture-beta');
        session.setDialogAction('accept');
        await readers.clickConfig(session.page, 'capture-beta', '.delete-btn');
        await session.page.waitForTimeout(200);
        const afterDelete = await readers.fieldMap(session.page);
        add('ui.delete-reset.values', 'localstorage/J5-ui-states/q8-delete-reset.json',
            Object.fromEntries(Object.entries(afterDelete.byId).map(([id, row]) => [id,
                [row.value, row.checked, row.disabled]])));
        add('ui.config-list.after-delete', null,
            (await readers.configRows(session.page)).map((row) => row.name));

        // Q18/Q13: a stored path with no <option> blanks, and Launch alerts instead of posting.
        const tokens = { configsKey: 'llamaCppConfigs',
            configsJson: JSON.stringify({ 'token-path': { serverPath: 'FIXTURE_ROOT/bin/fake-llama-server.cmd',
                modelPath: 'FIXTURE_ROOT/models/not-in-the-tree/model.gguf', ngl: 1 } }),
            settingsKey: 'llamaCppSettings', settingsJson: null };
        await session.close();
        session = await page.open(manager, { seed: tokens, browser: ctx.browser });
        await session.page.waitForSelector('#configList .config-item');
        await session.selectConfig('token-path');
        add('ui.q18.selected-index', null,
            await session.page.evaluate(() => document.getElementById('modelPath').selectedIndex));
        await session.page.click('#launchBtn');
        await session.page.waitForTimeout(250);
        add('ui.q18.dialogs', 'goldens/resave/goldens.jsonl',
            session.dialogs.map((dialog) => dialog.type + ': ' + dialog.message));
        add('ui.q18.no-post', null, session.postsTo('/start'));
    } finally {
        if (session) await session.close();
    }
}

module.exports = [{ id: 'ui', title: 'rendered fields, storage bytes, Q8 reset, Q18 alert', run: ui }];
