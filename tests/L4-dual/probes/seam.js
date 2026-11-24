'use strict';
// The action script, seam half: the behaviors that need the browser, the manager and the binary at
// once. These are the L3 checks reduced to values, so a Part-2 candidate that diverges at the seam
// shows up as a named field diff instead of as a stack of red assertions.

const fs = require('fs');
const path = require('path');

const readers = require('../../L3-seam/helpers/browser-readers');
const page = require('../../L3-seam/helpers/page');
const { uiSeed } = require('../../L3-seam/helpers/seeds');
const { tokenise } = require('./tokenise');
const { winPath } = require('../../L3-seam/helpers/pathmap');

const l2fixtures = require('../../L2-ui/helpers/fixtures');

const argvValue = (argv, flag) => (argv.indexOf(flag) < 0 ? null : argv[argv.indexOf(flag) + 1]);

async function seam(ctx) {
    const manager = ctx.manager;
    const add = (key, family, value) => ctx.observe.add(key, family, tokenise(manager, value));

    // A UI launch of the recorded capture-alpha config: the argv is the client's own vector as the
    // stand-in received it, with --mmproj and --chat-template-file derived from live /models bytes.
    let session = null;
    try {
        session = await page.open(manager, { seed: uiSeed(manager), browser: ctx.browser });
        await session.page.waitForSelector('#configList .config-item');
        await session.selectConfig('capture-alpha');
        const before = manager.argvRecords().length;
        const launched = await page.launch(session);
        add('seam.launch.spawned', null, launched.spawned);
        add('seam.launch.argv', 'argv/J5-ui-launch/launch.jsonl',
            tokenise(manager, manager.argvLines().slice(before, before + 2).join('\n')));
        const argv = launched.argv ? launched.argv.argv : [];
        add('seam.mmproj', null, argvValue(argv, '--mmproj'));
        add('seam.chat-template-file', null, argvValue(argv, '--chat-template-file'));
        add('seam.port.start', null, argvValue(argv, '--port'));
        add('seam.argv.tail', null, argv.slice(-6));
        const pane = await readers.pane(session.page);
        add('seam.socket.banner', null, pane.text.includes('Connected to server for real-time logging'));
        add('seam.pane.has-entries', null, pane.lineCount > 0);
        await page.stop(session);

        // The ini is built in the browser and written verbatim by the server (Q10 trailing port).
        const iniFile = path.join(manager.app, 'models-preset.ini');
        const previous = fs.existsSync(iniFile) ? manager.iniBytes() : null;
        const options = await readers.optionValues(session.page, 'launchPresetsSelect');
        await session.page.selectOption('#launchPresetsSelect', options[1]);
        const presetsBefore = manager.argvRecords().length;
        await session.click('launchPresetsBtn');
        await manager.waitForIniChange(previous, 20000);
        const presetsSpawn = await manager.waitForLaunch(presetsBefore, 30000);
        add('seam.ini.posted', 'ini/J4b-ui-presets-launch/presets-from-ui.ini',
            (await session.lastPost('/launch-presets')).presets);
        add('seam.ini.disk', 'ini/J4b-ui-presets-launch/presets-from-ui.ini',
            manager.iniBytes().toString('utf8'));
        add('seam.ini.verbatim', null,
            (await session.lastPost('/launch-presets')).presets === manager.iniBytes().toString('utf8'));
        add('seam.presets.argv', 'argv/J4-launch-presets/launch.jsonl',
            tokenise(manager, manager.argvLines().slice(presetsBefore, presetsBefore + 2).join('\n')));
        add('seam.presets.port', null, presetsSpawn ? argvValue(presetsSpawn.argv, '--port') : null);
        await page.stop(session);
    } finally {
        if (session) await session.close();
        await manager.stopAndWait();
    }

    // The settings split-brain: Q2 leaves 8080 in settings.json, localStorage keeps 7838, and the
    // dialog merge decides which one the next launch carries.
    await manager.writeSettings({ modelsDirectory: winPath(manager.modelsDir) });
    session = null;
    try {
        session = await page.open(manager, { seed: uiSeed(manager), browser: ctx.browser });
        await session.page.waitForSelector('#configList .config-item');
        await session.page.click('#settingsBtn');
        await session.page.waitForSelector('#settingsDialog[open] #serverPort');
        add('seam.split.settings-file', 'ini/J1-settings/settings.after-without-port.json',
            manager.settingsBytes().toString('utf8'));
        add('seam.split.dialog-port', null, await session.page.inputValue('#serverPort'));
        await session.page.click('#cancelSettingsBtn');
        await session.page.waitForSelector('#settingsDialog:not([open])', { state: 'attached' });
        add('seam.split.storage-port', null,
            JSON.parse(await readers.storageValue(session.page, 'llamaCppSettings')).serverPort);
        await session.selectConfig('capture-alpha');
        const launched = await page.launch(session);
        add('seam.split.launch-port', null,
            launched.argv ? argvValue(launched.argv.argv, '--port') : null);
        await page.stop(session);
    } finally {
        if (session) await session.close();
        await manager.stopAndWait();
    }

    // A corpus subset in token form: the ini keeps the stored separators, so Q20's mixed
    // `\`-derivation is part of the compared bytes.
    const goldens = l2fixtures.resaveGoldens();
    // The resave family also holds 'create' rows, which have no ini of their own.
    const subset = [...goldens.byName.entries()]
        .filter(([, row]) => typeof row.ini_from_saved === 'string'
            && Buffer.from(row.ini_from_saved, 'base64').toString('utf8').includes('chat-template-file'))
        .slice(0, 4).map(([name]) => name);
    if (!subset.length) {
        ctx.observe.problem('no corpus golden carries chat-template-file; the Q20 field was not recorded');
    } else {
        const corpus = l2fixtures.corpusSeed();
        const configs = {};
        for (const name of subset) configs[name] = corpus.configs[name];
        session = null;
        try {
            session = await page.open(manager, { seed: {
                configsKey: 'llamaCppConfigs', configsJson: JSON.stringify(configs),
                settingsKey: 'llamaCppSettings', settingsJson: corpus.settingsJson
            }, browser: ctx.browser });
            await session.page.waitForSelector('#configList .config-item');
            add('seam.corpus.subset', null, subset);
            const iniFile = path.join(manager.app, 'models-preset.ini');
            const previous = fs.existsSync(iniFile) ? manager.iniBytes() : null;
            const options = await readers.optionValues(session.page, 'launchPresetsSelect');
            await session.page.selectOption('#launchPresetsSelect', options[1]);
            await session.click('launchPresetsBtn');
            await manager.waitForIniChange(previous, 20000);
            add('seam.corpus.ini', 'goldens/corpus/goldens.jsonl', manager.iniBytes().toString('utf8'));
            add('seam.corpus.port-line', null,
                manager.iniBytes().toString('utf8').split('\n').filter((line) => /^port = /.test(line)));
        } finally {
            if (session) await session.close();
            await manager.stopAndWait();
        }
    }
}

module.exports = [{ id: 'seam', title: 'mmproj / chat-template-file / port split / ini verbatim',
    run: seam }];
