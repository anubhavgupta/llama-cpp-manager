'use strict';
// The corpus round-trip against a REAL backend (plan §2 Phase 4 row L3, §9A remapped mode):
// 48 real saved configs, the real /models scan over the materialised corpus tree, the real spawn
// path, and the recorded argv / ini / localStorage bytes as the expectations.
//
// Two seed forms, because the corpus goldens are recorded in two spaces:
//   - resolved  (§9A: the PATH-MAP mapping is applied to the inputs AND to the expected bytes) —
//     used for everything that has to match a live <option> or a real spawn;
//   - token verbatim — used for the ini bytes, which are built from localStorage untouched, so the
//     comparison stays exact and keeps the mixed-separator shape Q20 is about.
//
// The corpus model files are materialised into the fixture tree first (capture-legacy.js does the
// same for the recorded J6 run), so every seam check in checks/seam.js — whose /models bytes are
// the pure fixture-tree layout — has to run before this file.

const fs = require('fs');
const path = require('path');

const readers = require('../helpers/browser-readers');
const page = require('../helpers/page');
const compare = require('../helpers/compare');
const { corpusSeeds } = require('../helpers/seeds');
const { spawnEinval } = require('../helpers/sandbox');

const harness = require('../../L1-backend/lib/harness');
const l2fixtures = require('../../L2-ui/helpers/fixtures');

const { assert, diffText, sha256 } = harness;

const ORPHAN_KEYS = ['mlock', 'noMmap', 'ndio', 'dio', 'draftMin', 'draftMax', 'draftPMin',
    'disableReasoning'];
const INI_HEADER = 'version = 1\n\n';

function corpusGoldens() {
    const resave = l2fixtures.resaveGoldens();
    if (!resave) {
        throw new Error('fixtures/goldens/resave/goldens.jsonl is missing; run node tools/parity/gen-goldens.js');
    }
    return resave;
}

// Corpus localStorage in both forms, for this sandbox's scratch paths.
const seeds = (manager) => corpusSeeds(manager);

// ------------------------------------------------------- 1. materialise + rendered list --------

async function materialiseAndList(ctx) {
    const manager = ctx.manager;
    const { corpus, resolved, settingsPort } = seeds(manager);

    await ctx.check('L3.CORPUS-materialised', '§9A remapped mode', async () => {
        const saved = await manager.writeSettings({ modelsDirectory: manager.modelsDir,
            serverPort: settingsPort });
        assert(saved.success === true, 'L3.CORPUS-SETTINGS', 'POST /settings failed: ' + JSON.stringify(saved));
        const ensured = manager.materialiseCorpusModels(JSON.parse(resolved.configsJson));
        const models = JSON.parse((await manager.request('GET', '/models')).raw.toString('utf8')).models;
        const options = new Set(models.map((model) => model.path));
        const missing = Object.entries(JSON.parse(resolved.configsJson))
            .filter(([, config]) => !options.has(config.modelPath))
            .map(([name]) => name);
        assert(missing.length === 0, 'L3.CORPUS-OPTIONS',
            missing.length + ' of 48 corpus modelPaths have no /models option, so they would blank on'
            + ' load (Q18) instead of launching: ' + JSON.stringify(missing.slice(0, 5)));
        return ensured + ' corpus model files created under ' + manager.modelsDir + '; all 48'
            + ' modelPaths are now /models options';
    });

    await ctx.check('L3.CORPUS-list', '§9 trap 6', async () => {
        const recorded = l2fixtures.corpusConfigList();
        let session = null;
        try {
            session = await page.open(manager, { seed: seeds(manager).resolved, browser: ctx.browser,
                settleMs: 900 });
            await session.page.waitForSelector('#configList .config-item');
            const rows = await readers.configRows(session.page);
            assert(rows.length === 48, 'L3.CORPUS-LIST-COUNT', 'the list rendered ' + rows.length
                + ' rows; the corpus has 48 configs');
            assert(JSON.stringify(rows.map((row) => row.name)) === JSON.stringify(recorded.renderedOrder),
                'L3.CORPUS-LIST-ORDER',
                'the rendered order is not the recorded legacy .sort() order; first difference at index '
                + rows.map((row) => row.name).findIndex((name, index) => name !== recorded.renderedOrder[index]));
            return '48 rows in the recorded J6 order';
        } finally {
            if (session) await session.close();
        }
    });

    ctx.note('corpus-seed', 'resolved seed: 48 configs, settings ' + resolved.settingsJson);
}

// ------------------------------------------------------------- 2. launch all 48 ---------------

// Each corpus golden row carries its own ini bytes under ini_from_saved (the ini built from the
// SAVED config, which is the state the browser is in when Launch Presets reads localStorage).
const iniOf = (golden) => Buffer.from(golden.ini_from_saved, 'base64').toString('utf8');

async function launchAll(ctx) {
    const manager = ctx.manager;
    const goldens = corpusGoldens();
    const { corpus, resolved, settingsPort } = seeds(manager);
    const map = manager.pathMap();
    let session = null;
    const argvByConfig = new Map();
    const blocked = [];
    try {
        session = await page.open(manager, { seed: resolved, browser: ctx.browser, settleMs: 900 });
        await session.page.waitForSelector('#configList .config-item');
        const beforeAll = manager.argvRecords().length;
        const spawnRetried = [];

        for (const name of corpus.names) {
            await session.selectConfig(name);
            const launched = await page.launch(session);
            if (!launched.spawned) {
                blocked.push({ name, dialogs: launched.dialogs, spawnEinval: launched.spawnEinval });
                continue;
            }
            if (launched.retryNote) spawnRetried.push(name);
            argvByConfig.set(name, launched.argv.argv);
            await page.stop(session);
        }

        await ctx.check('L3.CORPUS-launched-count', 'Q18', async () => {
            assert(blocked.length === 0, 'L3.CORPUS-BLOCKED',
                blocked.length + ' configs were alert-blocked instead of launching: '
                + JSON.stringify(blocked.slice(0, 3)));
            assert(argvByConfig.size === 48, 'L3.CORPUS-LAUNCH-COUNT',
                argvByConfig.size + ' of 48 configs produced a recorded argv');
            return '48/48 corpus configs launched through the real manager + stand-in'
                + (spawnRetried.length ? '; ' + spawnRetried.length + ' of them after the '
                    + spawnEinval.note + ' (' + spawnRetried.join(', ') + ')'
                    : ', no spawn-EINVAL re-post needed');
        });

        await ctx.check('L3.CORPUS-argv-recorded-j6', '§9A §8 argv-jsonl', async () => {
            // The recorded J6 journey launched the first three launchable configs, in insertion
            // order, with a /stop between them — the same three this loop launches first.
            const mine = manager.argvLines().slice(beforeAll, beforeAll + 6).join('\n');
            const rule = compare.compareFixtureText('argv/J6-corpus-smoke/launch.jsonl', mine,
                { recordedSliceLines: 6 });
            return 'the first three corpus launches (2 argv-jsonl lines each) are byte-identical to the'
                + ' recorded J6 corpus journey (' + rule + ')';
        });

        await ctx.check('L3.CORPUS-argv-goldens', 'Q7 Q18 Q19 Q20 Q21 Q22', async () => {
            const mismatches = [];
            for (const name of corpus.names) {
                const golden = goldens.byName.get(name);
                if (!golden) {
                    mismatches.push({ name, problem: 'no resave golden row' });
                    continue;
                }
                const observed = argvByConfig.get(name);
                const expected = map.walk(golden.argv);
                if (!observed) {
                    mismatches.push({ name, problem: 'never launched' });
                    continue;
                }
                if (JSON.stringify(expected) !== JSON.stringify(observed)) {
                    const index = expected.findIndex((token, at) => token !== observed[at]);
                    mismatches.push({ name, index, expected: expected[index], observed: (observed || [])[index],
                        length: { expected: expected.length, observed: observed.length } });
                }
            }
            assert(mismatches.length === 0, 'L3.CORPUS-ARGV',
                mismatches.length + ' of 48 argvs differ from the recorded legacy argv '
                + '(fixtures/goldens/resave, PATH-MAP-resolved):\n      '
                + JSON.stringify(mismatches.slice(0, 5), null, 2).split('\n').join('\n      '));
            return '48/48 argvs positionally equal to the recorded legacy argv';
        });

        await ctx.check('L3.CORPUS-spawn-target', 'Q20 Q21', async () => {
            const standin = path.basename(manager.standin).toLowerCase();
            const records = manager.argvRecords().slice(beforeAll, beforeAll + 96);
            const wrong = [];
            // Even lines are the compiled stand-in recording the vector it was handed; odd lines are
            // the fake it relayed to. The token FIXTURE_ROOT/bin/fake-llama-server.cmd must resolve
            // to the stand-in, because node refuses to spawn a .cmd without a shell (recorded in
            // argv/J5-ui-launch/probe-stand-in.json).
            for (let index = 0; index < records.length; index += 2) {
                const relay = records[index];
                if (String(relay.raw).toLowerCase().includes(standin)) continue;
                wrong.push(String(relay.raw).slice(0, 120));
            }
            assert(wrong.length === 0, 'L3.CORPUS-SERVERPATH',
                wrong.length + ' corpus spawns did not go to ' + path.basename(manager.standin)
                + ': ' + JSON.stringify(wrong.slice(0, 2)));
            return records.length + ' corpus argv lines, every spawn aimed at ' + path.basename(manager.standin);
        });
    } finally {
        if (session) await session.close();
        await manager.stopAndWait();
    }

    // ---------------------------------------------------------- 3. ini from all 48 ------------
    let session2 = null;
    try {
        session2 = await page.open(manager, { seed: resolved, browser: ctx.browser, settleMs: 900 });
        await session2.page.waitForSelector('#configList .config-item');

        await ctx.check('L3.CORPUS-INI-bytes', 'Q10 Q17 §9 trap 6', async () => {
            const iniFile = path.join(manager.app, 'models-preset.ini');
            const before = fs.existsSync(iniFile) ? manager.iniBytes() : null;
            const options = await readers.optionValues(session2.page, 'launchPresetsSelect');
            await session2.page.selectOption('#launchPresetsSelect', options[1]);
            const launchesBefore = manager.argvRecords().length;
            await session2.click('launchPresetsBtn');
            const rewritten = await manager.waitForIniChange(before, 20000);
            assert(rewritten, 'L3.CORPUS-INI-WRITTEN', 'POST /launch-presets never rewrote the ini');
            const onDisk = manager.iniBytes().toString('utf8');
            const expected = corpus.names.map((name) => {
                const golden = goldens.byName.get(name);
                return map.resolveText(iniOf(golden)).slice(INI_HEADER.length);
            });
            const expectedBytes = INI_HEADER + expected.join('') + 'port = ' + settingsPort + '\n';
            assert(sha256(onDisk) === sha256(expectedBytes), 'L3.CORPUS-INI-BYTES',
                'the ini the browser built and the server wrote differs from the recorded corpus ini'
                + ' bytes:\n      disk sha ' + sha256(onDisk) + '\n      expect sha '
                + sha256(expectedBytes) + '\n      ' + diffText(expectedBytes, onDisk,
                    'the corpus ini composed from fixtures/goldens/resave in localStorage order'));
            const sections = onDisk.slice(INI_HEADER.length).split(/(?=^\[)/m)
                .filter((block) => block !== '')
                .map((block) => block.replace(/port = [^\n]*\n$/, ''));
            assert(JSON.stringify(sections) === JSON.stringify(expected), 'L3.CORPUS-INI-SECTIONS',
                'per-section comparison failed even though the whole file matched');
            assert(JSON.stringify(sections.map((block) => block.split('\n')[0]))
                === JSON.stringify(corpus.names.map((name) => '[' + name + ']')),
            'L3.CORPUS-INI-ORDER',
                '§9 trap 6: ini section order is not the localStorage insertion order');
            await manager.waitForLaunch(launchesBefore, 20000).catch(() => null);
            await manager.stopAndWait();
            return 'sha ' + sha256(onDisk).slice(0, 16) + ' equals the recorded corpus ini composed'
                + ' in insertion order, 48 sections, trailing `port = ' + settingsPort + '` (Q10)';
        });
    } finally {
        if (session2) await session2.close();
        await manager.stopAndWait();
    }
}

function firstDifference(a, b) {
    const limit = Math.min(a.length, b.length);
    let index = 0;
    while (index < limit && a[index] === b[index]) index += 1;
    return index;
}

// ------------------------------------------------------ 4. re-save all 48, bytes --------------

async function resaveAll(ctx) {
    const manager = ctx.manager;
    const goldens = corpusGoldens();
    const { corpus, resolved } = seeds(manager);
    const map = manager.pathMap();
    let session = null;
    try {
        session = await page.open(manager, { seed: resolved, browser: ctx.browser, settleMs: 900 });
        await session.page.waitForSelector('#configList .config-item');
        const byteMismatches = [];
        const orphanMismatches = [];
        for (const name of corpus.names) {
            const golden = goldens.byName.get(name);
            await readers.clickConfig(session.page, name, '.edit-btn');
            await session.page.waitForSelector('#configFormContainer[open]');
            await session.page.click('#saveConfigBtn');
            await session.page.waitForTimeout(60);
            const storage = JSON.parse(await readers.storageValue(session.page, 'llamaCppConfigs'));
            const written = JSON.stringify(storage[name]);
            const expected = JSON.stringify(map.walk(JSON.parse(golden.saved_config)));
            if (written !== expected) {
                byteMismatches.push({ name, firstDifference: firstDifference(written, expected),
                    expected: expected.slice(0, 160), written: written.slice(0, 160) });
            }
            const storedOriginal = JSON.parse(resolved.configsJson)[name];
            const dropped = ORPHAN_KEYS.filter((key) => key in storedOriginal && !(key in storage[name]));
            const expectedDropped = ORPHAN_KEYS.filter((key) => storedOriginal[key] !== undefined
                && !golden.saved_field_order.includes(key));
            if (JSON.stringify(dropped) !== JSON.stringify(expectedDropped)) {
                orphanMismatches.push({ name, dropped, expectedDropped });
            }
        }
        await ctx.check('L3.CORPUS-resave-bytes', 'Q16', async () => {
            assert(byteMismatches.length === 0, 'L3.CORPUS-RESAVE-BYTES',
                byteMismatches.length + ' re-saved entries differ from the recorded saveCurrentValues'
                + ' bytes:\n      ' + JSON.stringify(byteMismatches.slice(0, 3), null, 2)
                    .split('\n').join('\n      '));
            return '48/48 re-saved entries byte-identical to the recorded goldens';
        });
        await ctx.check('L3.CORPUS-resave-orphans', 'Q16', async () => {
            assert(orphanMismatches.length === 0, 'L3.CORPUS-RESAVE-ORPHANS',
                'orphan-key handling moved: ' + JSON.stringify(orphanMismatches.slice(0, 3)));
            return 'Q16: the orphan keys are dropped for exactly the configs that carried them';
        });
        await ctx.check('L3.CORPUS-resave-key-order', '§9 trap 6', async () => {
            const keys = Object.keys(JSON.parse(await readers.storageValue(session.page, 'llamaCppConfigs')));
            assert(JSON.stringify(keys) === JSON.stringify(corpus.names), 'L3.CORPUS-RESAVE-ORDER',
                're-saving reordered the storage keys, which would move the ini sections');
            return 'storage key order survives all 48 re-saves';
        });
    } finally {
        if (session) await session.close();
        await manager.stopAndWait();
    }
}

// ------------------------------- 5. token-form ini + Q18 alert, against the real option set ----

// The ini is built from the localStorage bytes verbatim (no DOM round trip), so seeding the corpus
// in its committed token form compares token-for-token: the stored forward-slash model paths stay
// forward-slash and the derived chat-template-file keeps the stored separator, which is exactly what
// Q20 records. Nothing here needs a real spawn, and the launch of the same configs cannot happen:
// the real /models option set carries scratch paths, so every token path blanks (Q18) and the page
// alerts with the recorded text.
async function tokenFormIni(ctx) {
    const manager = ctx.manager;
    const goldens = corpusGoldens();
    const { corpus, tokens, settingsPort } = seeds(manager);
    let session = null;
    try {
        session = await page.open(manager, { seed: tokens, browser: ctx.browser, settleMs: 900 });
        await session.page.waitForSelector('#configList .config-item');

        await ctx.check('L3.CORPUS-INI-token-bytes', 'Q10 Q20', async () => {
            const iniFile = path.join(manager.app, 'models-preset.ini');
            const before = fs.existsSync(iniFile) ? manager.iniBytes() : null;
            const options = await readers.optionValues(session.page, 'launchPresetsSelect');
            await session.page.selectOption('#launchPresetsSelect', options[1]);
            await session.click('launchPresetsBtn');
            const rewritten = await manager.waitForIniChange(before, 20000);
            assert(rewritten, 'L3.CORPUS-INI-TOKEN-WRITTEN', 'POST /launch-presets rewrote nothing');
            const onDisk = manager.iniBytes().toString('utf8');
            const expected = INI_HEADER
                + corpus.names.map((name) => iniOf(goldens.byName.get(name))
                    .slice(INI_HEADER.length)).join('')
                + 'port = ' + settingsPort + '\n';
            assert(onDisk === expected, 'L3.CORPUS-INI-TOKEN-BYTES',
                'the ini bytes are not the recorded corpus ini in token form; '
                + diffText(expected, onDisk,
                    'the corpus ini composed from fixtures/goldens/resave in token form'));
            const mixed = expected.split('\n').filter((line) => /^chat-template-file = /.test(line)
                && line.includes('\\') && line.includes('/'));
            assert(mixed.length > 0, 'L3.CORPUS-INI-Q20-VACUOUS',
                'no ini line mixes separators, so this run does not actually exercise Q20');
            return 'sha ' + sha256(onDisk).slice(0, 16) + ' equals the recorded token-form corpus ini'
                + ' exactly, ' + mixed.length + ' mixed-separator chat-template-file lines included';
        });

        await ctx.check('L3.CORPUS-Q18-alert', 'Q18 Q13', async () => {
            const blocked = goldens.blocked;
            const name = corpus.names[0];
            const expectedDialogs = blocked.get(name) ? blocked.get(name).dialogs : null;
            assert(expectedDialogs, 'L3.CORPUS-Q18-GOLDEN',
                'no recorded alert-blocked golden row for ' + JSON.stringify(name));
            const value = await session.page.inputValue('#modelPath').catch(() => null);
            void value;
            await readers.clickConfig(session.page, name);
            const selectedIndex = await session.page.evaluate(() => document.getElementById('modelPath').selectedIndex);
            const dialogsBefore = session.dialogs.length;
            await session.page.click('#launchBtn');
            await session.page.waitForTimeout(200);
            const dialogs = session.dialogs.slice(dialogsBefore);
            assert(selectedIndex === -1, 'L3.CORPUS-Q18-BLANK',
                'the token modelPath selected option index is ' + selectedIndex
                + '; the real /models option set carries scratch paths, so it must blank (Q18)');
            assert(JSON.stringify(dialogs) === JSON.stringify(expectedDialogs), 'L3.CORPUS-Q18-ALERT',
                'the alert text is ' + JSON.stringify(dialogs) + '; recorded legacy alerted with '
                + JSON.stringify(expectedDialogs));
            return 'Q18: ' + JSON.stringify(name) + ' blanks against the real option set and alerts'
                + ' with the recorded text';
        });
    } finally {
        if (session) await session.close();
        await manager.stopAndWait();
    }
}

module.exports = [
    { id: 'corpus-seed', title: 'materialise the corpus tree, rendered list vs recorded J6',
        quirk: '§9A §9 trap 6', run: materialiseAndList },
    { id: 'corpus-launch', title: 'launch all 48 through the real manager; argv vs recorded J6 + goldens',
        quirk: 'Q7 Q18 Q19 Q20 Q21 Q22', run: launchAll },
    { id: 'corpus-resave', title: 're-save all 48, localStorage bytes vs recorded goldens',
        quirk: 'Q16', run: resaveAll },
    { id: 'corpus-tokens', title: 'token-form ini (Q20 separators) + Q18 alert against real /models',
        quirk: 'Q10 Q13 Q18 Q20', run: tokenFormIni }
];
