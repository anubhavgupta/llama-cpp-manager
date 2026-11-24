'use strict';
// The behaviors that only exist at the seam between the browser, the manager and the binary
// (plan §9 'Seam-only behaviors'); the corpus round-trip against the same live stack is
// checks/corpus.js.
//
// Every expectation here is either a recorded legacy artifact (fixtures/**, compared under
// fixtures/COMPARISON.json) or a relation between values that this live legacy run produces itself
// (settings.json vs localStorage vs the spawned argv). Inputs are named where they come from; no
// assertion states a belief about what the app 'should' do.

const fs = require('fs');
const path = require('path');

const readers = require('../helpers/browser-readers');
const page = require('../helpers/page');
const compare = require('../helpers/compare');
const { uiSeed } = require('../helpers/seeds');
const { winPath } = require('../helpers/pathmap');

const harness = require('../../L1-backend/lib/harness');

const { assert, sha256 } = harness;

const argvValue = (argv, flag) => (argv.indexOf(flag) < 0 ? null : argv[argv.indexOf(flag) + 1]);

function firstRecordedArgv(rel) {
    return JSON.parse(harness.fixtureBytes(rel).toString('utf8').split('\n')[0]).argv;
}

function modelDirOf(value) {
    const cut = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'));
    return value.slice(0, cut + 1);
}

function firstDifference(a, b) {
    const limit = Math.min(a.length, b.length);
    let index = 0;
    while (index < limit && a[index] === b[index]) index += 1;
    return index;
}

async function waitForPost(session, pathname, before) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        if (session.postsTo(pathname) > before) return await session.lastPost(pathname);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
}

// Click, then wait for the spawn to be recorded (both lines of the pair, so a comparison can never
// read the relay line before the relay line has been answered by the fake).
async function nextLaunch(manager, before, action) {
    await action();
    return manager.waitForLaunch(before, 30000);
}

// --------------------------------------------------------------- 1. /models seam -------------

async function modelsSeam(ctx) {
    const manager = ctx.manager;

    await ctx.check('L3.SETTINGS-point-at-tree', 'Q11', async () => {
        const saved = await manager.writeSettings({ modelsDirectory: winPath(manager.modelsDir),
            serverPort: 7838 });
        assert(saved.success === true, 'L3.SETTINGS-POST', 'POST /settings failed: ' + JSON.stringify(saved));
        return 'settings.json now ' + manager.settingsBytes().toString('utf8').replace(/\s+/g, ' ');
    });

    await ctx.check('L3.MODELS-fixture-bytes', '§9 seam: window.models', async () => {
        const live = await manager.request('GET', '/models');
        assert(live.status === 200, 'L3.MODELS-STATUS', 'GET /models returned ' + live.status);
        const rule = compare.compareFixtureText('http/J2-models/models.response', live.raw.toString('utf8'));
        return 'real /models equals the recorded J2 bytes (' + rule + '); '
            + JSON.parse(live.raw.toString('utf8')).models.length + ' models';
    });

    await ctx.check('L3.MODELS-mmproj-field', '§9 seam: first-match mmproj association', async () => {
        const live = JSON.parse((await manager.request('GET', '/models')).raw.toString('utf8'));
        const recorded = JSON.parse(harness.fixtureBytes('http/J2-models/models.response').toString('utf8'));
        const byPath = new Map(recorded.models.map((model) => [model.path, model]));
        const mismatched = live.models.filter((model) => {
            const expected = byPath.get(model.path);
            return !expected || expected.mmprojFile !== model.mmprojFile;
        });
        assert(mismatched.length === 0, 'L3.MODELS-MMPROJ-MOVE',
            'the mmproj association moved: ' + JSON.stringify(mismatched.slice(0, 3)));
        const associated = live.models.filter((model) => model.mmprojFile);
        assert(associated.length > 0, 'L3.MODELS-MMPROJ-VACUOUS', 'no model in the fixture tree'
            + ' carries an mmprojFile, so the argv association claim below would be vacuous');
        return associated.length + ' of ' + live.models.length + ' models carry an mmprojFile,'
            + ' identical to the recorded J2 association';
    });
}

// ------------------------------------------------- 2. argv built against live /models ---------

async function argvSeam(ctx) {
    const manager = ctx.manager;
    let session = null;
    try {
        session = await page.open(manager, { seed: uiSeed(manager), browser: ctx.browser });
        await session.page.waitForSelector('#configList .config-item');
        await session.selectConfig('capture-alpha');

        const before = manager.argvRecords().length;
        const record = await nextLaunch(manager, before, () => session.click('launchBtn'));
        assert(record, 'L3.ARGV-LAUNCH', 'clicking Launch produced no argv line — the page'
            + ' alert-blocked instead: ' + JSON.stringify(session.dialogs));
        await session.waitStatus(true);
        const argv = record.argv;

        await ctx.check('L3.ARGV-recorded-bytes', '§9 seam: client argv through the real spawn path', async () => {
            const mine = manager.argvLines().slice(before).join('\n');
            const rule = compare.compareFixtureText('argv/J5-ui-launch/launch.jsonl', mine,
                { recordedSliceLines: 2 });
            const gained = manager.argvRecords().length - before;
            assert(gained === 2, 'L3.ARGV-LINES', 'one UI launch wrote ' + gained + ' argv lines; the'
                + ' recorded J5 journey writes 2 per launch (the compiled stand-in, then the relayed'
                + ' fake it spawns)');
            return 'relay + relayed argv lines byte-identical to the recorded J5 UI launch (' + rule + ')';
        });

        await ctx.check('L3.ARGV-mmproj-from-window-models', '§9 seam: mmproj association', async () => {
            const windowModels = await session.page.evaluate(() => (window.models || []).map((model) => ({
                path: model.path, mmprojFile: model.mmprojFile
            })));
            assert(windowModels.length > 0, 'L3.WINDOW-MODELS-EMPTY', 'window.models is empty: the'
                + ' --mmproj in the argv cannot have come from a real /models fetch');
            const modelPath = argvValue(argv, '-m');
            const entry = windowModels.find((model) => model.path === modelPath);
            assert(entry, 'L3.WINDOW-MODELS-MATCH', 'the launched -m path is not in window.models (the'
                + ' browser launched a path the server never returned): ' + modelPath);
            assert(argvValue(argv, '--mmproj') === entry.mmprojFile, 'L3.ARGV-MMPROJ',
                '--mmproj is ' + JSON.stringify(argvValue(argv, '--mmproj')) + ' but the /models entry'
                + ' for ' + JSON.stringify(modelPath) + ' says ' + JSON.stringify(entry.mmprojFile));
            const recorded = JSON.parse(harness.fixtureBytes('http/J2-models/models.response').toString('utf8'));
            const recordedEntry = recorded.models.find((model) => model.path === modelPath);
            assert(recordedEntry && recordedEntry.mmprojFile === entry.mmprojFile, 'L3.ARGV-MMPROJ-RECORDED',
                'the association this server reported is not the recorded J2 one: '
                + JSON.stringify(recordedEntry && recordedEntry.mmprojFile));
            const occurrences = argv.filter((token) => token === '--mmproj').length;
            assert(occurrences === 1, 'L3.ARGV-MMPROJ-COUNT', '--mmproj appears ' + occurrences + ' times');
            return '--mmproj ' + entry.mmprojFile + ' came from the live /models entry, equal to the recorded one';
        });

        await ctx.check('L3.ARGV-chat-template-file-separators', 'Q20', async () => {
            const derived = argvValue(argv, '--chat-template-file');
            assert(derived, 'L3.ARGV-CHAT-TEMPLATE', 'no --chat-template-file in the argv of a config'
                + ' that asks for a custom chat template: ' + JSON.stringify(argv));
            const dir = modelDirOf(argvValue(argv, '-m'));
            assert(derived === dir + 'chat-template.jinja', 'L3.ARGV-CHAT-TEMPLATE-VALUE',
                '--chat-template-file ' + JSON.stringify(derived) + ' is not the backslash'
                + '-concatenation of chat-template.jinja onto the server-returned path '
                + JSON.stringify(dir));
            assert(derived.indexOf('/') < 0, 'L3.ARGV-CHAT-TEMPLATE-SEPARATOR',
                'a server-returned (path.join) model path produced a forward-slash derivation: '
                + JSON.stringify(derived));
            const recordedArgv = firstRecordedArgv('argv/J5-ui-launch/launch.jsonl');
            assert(compare.deNode(argvValue(recordedArgv, '--chat-template-file')) === derived,
                'L3.ARGV-CHAT-TEMPLATE-RECORDED',
                'the derivation differs from the recorded J5 value '
                + JSON.stringify(argvValue(recordedArgv, '--chat-template-file')));
            return 'derived ' + derived + ' from a server-returned backslash path, equal to the recorded J5 value';
        });

        await ctx.check('L3.ARGV-port-from-localStorage-settings', 'Q5 Q11', async () => {
            const stored = JSON.parse(await readers.storageValue(session.page, 'llamaCppSettings'));
            assert(String(stored.serverPort) === argvValue(argv, '--port'), 'L3.ARGV-PORT-VALUE',
                '--port is ' + JSON.stringify(argvValue(argv, '--port')) + ' while localStorage'
                + ' llamaCppSettings says ' + JSON.stringify(stored.serverPort));
            const recordedArgv = firstRecordedArgv('argv/J5-ui-launch/launch.jsonl');
            assert(argv.indexOf('--port') === recordedArgv.indexOf('--port'), 'L3.ARGV-PORT-POSITION',
                '--port sits at index ' + argv.indexOf('--port') + ' here and at '
                + recordedArgv.indexOf('--port') + ' in the recorded J5 argv');
            const tail = argv.slice(argv.indexOf('--host'), argv.indexOf('--port'));
            const recordedTail = recordedArgv.slice(recordedArgv.indexOf('--host'), recordedArgv.indexOf('--port'));
            assert(tail.join(' ') === recordedTail.join(' '), 'L3.ARGV-TAIL',
                'the fixed tail moved: ' + JSON.stringify(tail) + ' vs recorded ' + JSON.stringify(recordedTail));
            return '--port ' + argvValue(argv, '--port') + ' at index ' + argv.indexOf('--port')
                + ', same --host/-fit/--port tail as recorded (' + tail.join(' ') + ')';
        });

        await page.stop(session);
    } finally {
        if (session) await session.close();
        await manager.stopAndWait();
    }
}

// ------------------------------------------------------ 3. settings split-brain ---------------

// Q2 resets settings.json to serverPort 8080 on a POST without serverPort (recorded: J1-settings
// settings-post-without-port + settings.after-without-port.json), while localStorage keeps 7838.
// openSettingsDialog() merges GET /settings OVER the in-memory settings object, so the split shows
// in three places at once: the dialog field, the argv of a later launch, and the localStorage bytes,
// which stay untouched.
async function portSplitBrain(ctx) {
    const manager = ctx.manager;

    await ctx.check('L3.PORT-q2-resets-file-to-8080', 'Q2', async () => {
        const saved = await manager.writeSettings({ modelsDirectory: winPath(manager.modelsDir) });
        assert(saved.success === true, 'L3.PORT-Q2-POST',
            'POST /settings without serverPort failed: ' + JSON.stringify(saved));
        const onDisk = JSON.parse(manager.settingsBytes().toString('utf8'));
        assert(onDisk.serverPort === 8080, 'L3.PORT-Q2-FILE', 'the post-Q2 settings file says serverPort '
            + onDisk.serverPort + '; the recorded Q2 consequence is 8080');
        const read = JSON.parse((await manager.request('GET', '/settings')).raw.toString('utf8'));
        assert(read.settings.serverPort === 8080, 'L3.PORT-Q2-READ',
            'GET /settings says ' + read.settings.serverPort);
        return 'settings.json = ' + manager.settingsBytes().toString('utf8').replace(/\s+/g, ' ');
    });

    await ctx.check('L3.PORT-Q11-manager-still-7837', 'Q11', async () => {
        const status = await manager.request('GET', '/status');
        assert(status.status === 200, 'L3.PORT-Q11-LISTEN',
            'the manager did not answer on ' + manager.port + ': ' + status.status);
        assert(manager.port === 7837, 'L3.PORT-Q11-PORT', 'this run reached the manager on port '
            + manager.port + '; server.js hardcodes 7837 and settings.serverPort never moves it');
        return 'the file says 8080, localStorage will say 7838, the manager listens on 7837';
    });

    let session = null;
    try {
        session = await page.open(manager, { seed: uiSeed(manager), browser: ctx.browser });
        await session.page.waitForSelector('#configList .config-item');

        await ctx.check('L3.PORT-dialog-prefill-from-file', '§9 seam: settings split-brain', async () => {
            const before = await readers.storageValue(session.page, 'llamaCppSettings');
            await session.page.click('#settingsBtn');
            await session.page.waitForSelector('#settingsDialog[open] #serverPort');
            const field = await session.page.inputValue('#serverPort');
            // script.js loads as type="module", so its `settings` binding is not readable from
            // outside; the merge is observable in the field it prefills and in the next launch argv.
            assert(field === '8080', 'L3.PORT-DIALOG-FIELD', 'the dialog prefilled ' + field
                + '; GET /settings says 8080 and openSettingsDialog merges that response over the'
                + ' localStorage settings, so the field must read 8080');
            assert(await readers.storageValue(session.page, 'llamaCppSettings') === before,
                'L3.PORT-DIALOG-NO-WRITE', 'opening the dialog rewrote localStorage');
            const directory = await session.page.inputValue('#modelsDirectory');
            assert(directory === winPath(manager.modelsDir), 'L3.PORT-DIALOG-DIRECTORY',
                'the directory field reads ' + JSON.stringify(directory) + ' while settings.json says '
                + JSON.stringify(winPath(manager.modelsDir)));
            return 'dialog fields prefilled from settings.json (8080 + the fixture tree), localStorage'
                + ' still 7838';
        });

        await ctx.check('L3.PORT-cancel-keeps-localStorage', 'Q13', async () => {
            await session.page.click('#cancelSettingsBtn');
            await session.page.waitForSelector('#settingsDialog:not([open])', { state: 'attached' });
            const stored = JSON.parse(await readers.storageValue(session.page, 'llamaCppSettings'));
            assert(stored.serverPort === 7838, 'L3.PORT-LOCALSTORAGE-AFTER-CANCEL',
                'localStorage serverPort became ' + stored.serverPort + ' after cancelling the dialog');
            return 'localStorage llamaCppSettings.serverPort still 7838';
        });

        await ctx.check('L3.PORT-launch-takes-merged-port', '§9 seam: settings split-brain', async () => {
            await session.selectConfig('capture-alpha');
            const before = manager.argvRecords().length;
            const record = await nextLaunch(manager, before, () => session.click('launchBtn'));
            assert(record, 'L3.PORT-LAUNCH', 'the launch produced no argv line: '
                + JSON.stringify(session.dialogs));
            await session.waitStatus(true);
            assert(argvValue(record.argv, '--port') === '8080', 'L3.PORT-ARGV-FILE-WINS',
                'after the dialog merge the launched argv carries --port '
                + JSON.stringify(argvValue(record.argv, '--port')) + '; the file says 8080 and'
                + ' localStorage still says 7838, so 8080 is what proves the merge feeds buildArgs');
            const stored = JSON.parse(await readers.storageValue(session.page, 'llamaCppSettings'));
            assert(stored.serverPort === 7838, 'L3.PORT-ARGV-LOCALSTORAGE',
                'localStorage drifted to ' + stored.serverPort + ' during the launch');
            await page.stop(session);
            return '--port 8080 (the settings.json value) while localStorage holds 7838';
        });
    } finally {
        if (session) await session.close();
        await manager.stopAndWait();
    }
}

// -------------------------------------------------- 4. /start vs /launch-presets argv ---------

async function presetsPort(ctx) {
    const manager = ctx.manager;
    let session = null;
    try {
        session = await page.open(manager, { seed: uiSeed(manager), browser: ctx.browser });
        await session.page.waitForSelector('#configList .config-item');

        let presetsArgv = null;

        await ctx.check('L3.INI-presets-from-ui-bytes', 'Q10 §9 seam: ini written verbatim', async () => {
            const iniFile = path.join(manager.app, 'models-preset.ini');
            const before = fs.existsSync(iniFile) ? manager.iniBytes() : null;
            const options = await readers.optionValues(session.page, 'launchPresetsSelect');
            assert(options.length > 1, 'L3.INI-PRESET-OPTIONS',
                'the presets dropdown is empty: ' + JSON.stringify(options));
            await session.page.selectOption('#launchPresetsSelect', options[1]);
            const postsBefore = session.postsTo('/launch-presets');
            const launchesBefore = manager.argvRecords().length;
            await session.click('launchPresetsBtn');
            const posted = await waitForPost(session, '/launch-presets', postsBefore);
            assert(posted, 'L3.INI-POSTED', 'the page posted no /launch-presets body');
            const rewritten = await manager.waitForIniChange(before, 20000);
            assert(rewritten, 'L3.INI-WRITTEN', 'POST /launch-presets never rewrote models-preset.ini');
            const onDisk = manager.iniBytes().toString('utf8');
            const trailing = 'port = 7838\n';
            assert(posted.presets.endsWith(trailing), 'L3.INI-TRAILING-PORT',
                'the posted ini ends with ' + JSON.stringify(posted.presets.slice(-24))
                + '; the client appends `port = <localStorage port>` (Q10)');
            assert(sha256(onDisk) === sha256(posted.presets), 'L3.INI-VERBATIM',
                'the bytes the browser built are not the bytes the server wrote:'
                + '\n      browser sha ' + sha256(posted.presets) + '\n      disk    sha '
                + sha256(onDisk) + '\n      first difference at byte '
                + firstDifference(posted.presets, onDisk));
            const pane = await readers.pane(session.page);
            assert(pane.text.includes('Generated models-preset.ini content:'), 'L3.INI-PANE-SECTIONS',
                'the pane never printed the ini sections it was about to post (recorded J4b claim)');
            assert(!pane.text.slice(pane.text.indexOf('version = 1')).includes(trailing),
                'L3.INI-PANE-BEFORE-PORT',
                'the recorded J4b claim is that the sections are printed before the trailing port'
                + ' line is appended, but the pane already carries it');
            assert(posted.serverPath === options[1] && posted.serverPort === 7838, 'L3.INI-POST-BODY',
                'the /launch-presets body carries serverPath ' + JSON.stringify(posted.serverPath)
                + ' and serverPort ' + JSON.stringify(posted.serverPort));
            const spawned = await manager.waitForLaunch(launchesBefore, 20000);
            assert(spawned, 'L3.INI-SPAWNED', 'the presets launch spawned nothing');
            presetsArgv = spawned.argv;
            await manager.stopAndWait();
            return 'browser sha ' + sha256(posted.presets).slice(0, 16) + ' === disk sha; the pane'
                + ' printed the sections without the trailing port line; ini existed before: '
                + (before !== null);
        });
        await ctx.check('L3.PORT-presets-ui-argv', 'Q5', async () => {
            assert(presetsArgv && presetsArgv[0] === '--models-preset', 'L3.PORT-PRESETS-SHAPE',
                'the presets launch did not start with --models-preset: ' + JSON.stringify(presetsArgv));
            assert(argvValue(presetsArgv, '--port') === '7838', 'L3.PORT-PRESETS-CLIENT',
                '/launch-presets spawned --port ' + JSON.stringify(argvValue(presetsArgv, '--port'))
                + '; the browser posts settings.serverPort, which is 7838 from localStorage here');
            return JSON.stringify(compare.portableArgv(manager, presetsArgv));
        });

        await ctx.check('L3.PORT-start-vs-presets', 'Q5', async () => {
            const startArgv = firstRecordedArgv('argv/J5-ui-launch/launch.jsonl');
            assert(argvValue(startArgv, '--port') === '7838', 'L3.PORT-START-RECORDED',
                'the recorded /start argv carries --port ' + JSON.stringify(argvValue(startArgv, '--port')));
            assert(argvValue(presetsArgv, '--port') === argvValue(startArgv, '--port'), 'L3.PORT-DUAL',
                'the two launch paths disagree: /start --port '
                + JSON.stringify(argvValue(startArgv, '--port')) + ' (client-built, recorded) vs'
                + ' /launch-presets --port ' + JSON.stringify(argvValue(presetsArgv, '--port')));
            assert(presetsArgv.indexOf('--models-preset') === 0 && argvValue(presetsArgv, '--models-preset')
                === winPath(path.join(manager.app, 'models-preset.ini')), 'L3.PORT-PRESETS-INI-PATH',
                '--models-preset is ' + JSON.stringify(argvValue(presetsArgv, '--models-preset')));
            return 'both paths carry --port 7838 with the client-supplied value; the 8080 fallback'
                + ' is the next check';
        });

        for (const [id, key, body] of [
            ['L3.PORT-presets-default-8080', 'launchPresetsWithoutServerPort',
                { presets: 'version = 1\n\n[capture-alpha]\nmodel = x.gguf\n\n',
                    serverPath: winPath(manager.standin) }],
            ['L3.PORT-presets-explicit-port', 'launchPresetsWithServerPort',
                { presets: 'version = 1\n\n[capture-alpha]\nmodel = x.gguf\n\n',
                    serverPath: winPath(manager.standin), serverPort: 7838 }]
        ]) {
            await ctx.check(id, 'Q5', async () => {
                const before = manager.argvRecords().length;
                const res = await manager.request('POST', '/launch-presets', body);
                assert(res.status === 200, id + '-STATUS', 'POST /launch-presets: ' + res.status + ' '
                    + res.raw.toString('utf8'));
                const spawned = await manager.waitForLaunch(before, 30000);
                assert(spawned, id + '-SPAWN', 'the presets launch spawned nothing');
                const observed = compare.portableArgv(manager, spawned.argv);
                const recorded = compare.recordedPresetsArgv(key);
                assert(JSON.stringify(observed) === JSON.stringify(recorded), id + '-ARGV',
                    'a /launch-presets body ' + (body.serverPort ? 'with' : 'WITHOUT') + ' serverPort'
                    + ' spawned ' + JSON.stringify(observed) + '; the recorded J4 port-source evidence'
                    + ' says ' + JSON.stringify(recorded) + ' (settings.json says 8080 after Q2 and the'
                    + ' route ignores it either way)');
                await manager.stopAndWait();
                return JSON.stringify(observed);
            });
        }
    } finally {
        if (session) await session.close();
        await manager.stopAndWait();
    }
}

module.exports = [
    { id: 'models', title: 'real /models bytes + first-match mmproj association', quirk: '§9 seam',
        run: modelsSeam },
    { id: 'argv', title: 'argv built against live /models: --mmproj, --chat-template-file, --port',
        quirk: 'Q5 Q20 §9 seam', run: argvSeam },
    { id: 'split-brain', title: 'settings.json vs localStorage (Q2 state, dialog merge, launch argv)',
        quirk: 'Q2 Q5 Q11', run: portSplitBrain },
    { id: 'presets-port', title: '/start vs /launch-presets argv + ini written verbatim',
        quirk: 'Q5 Q10', run: presetsPort }
];
