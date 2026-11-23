'use strict';

// /launch-presets group: the ini bytes the endpoint writes, and the Q5 dual path where /start
// takes --port from the request body while /launch-presets falls back to DEFAULT_PORT 8080.
//
// Session: nvidia-smi stub mode 'ok'. Request-body driven only — the ini this group compares is
// fixtures/ini/J4-launch-presets/presets-direct.ini, the harness-side presets string the recording
// POSTed; the app-generated ini (the browser building it in launchModelPresets) is fixtures/ini/
// J4b-ui-presets-launch/presets-from-ui.ini and belongs to L2/L3, which own the page.

const path = require('path');

const { assert, compareFixture, fixtureJson, winPath } = require('../lib/harness');

const spacedModel = (ctx) => winPath(path.join(ctx.sandbox.modelsDir, 'models with spaces', 'spaced model Q4.gguf'));
const spacedMmproj = (ctx) => winPath(path.join(ctx.sandbox.modelsDir, 'models with spaces', 'mmproj-spaced model Q4.gguf'));
const plainModel = (ctx) => winPath(path.join(ctx.sandbox.modelsDir, 'a', 'model-a.gguf'));

// The exact presets string j4LaunchPresets posts, rebuilt from this sandbox's fixture tree. The
// recorded scratch root is identical (fixtures/MANIFEST.json sandbox.scratch), so the bytes match.
const presetsText = (ctx) => 'version = 1\n\n[capture-alpha]\nmodel = ' + spacedModel(ctx) +
    '\nmmproj = ' + spacedMmproj(ctx) +
    '\ntemp = 0.7\nc = 16384\nspec-type = ngram-mod\nspec-ngram-size-n = 24\ndraft-min = 48\n' +
    'draft-max = 64\n\n[capture-beta]\nmodel = ' + plainModel(ctx) +
    '\ntop-k = 20\nreasoning = off\n\nport = 7838\n';

module.exports = {
    name: 'presets',
    stubMode: 'ok',
    async run(ctx) {
        const iniFile = ctx.sandbox.iniFile();

        await ctx.check('L1.PRESETS.SEED-PORT-7838', 'Q5', async () => {
            const res = await ctx.post('/settings', { modelsDirectory: winPath(ctx.sandbox.modelsDir), serverPort: 7838 });
            assert(res.status === 200, 'L1.PRESETS.SEED-STATUS', 'POST /settings returned ' + res.status);
            compareFixture('http/J4-launch-presets/settings-server-port-7838.response', res.raw);
            const stored = JSON.parse(require('fs').readFileSync(ctx.sandbox.settingsFile(), 'utf8'));
            assert(stored.serverPort === 7838, 'L1.PRESETS.SEED-WRITTEN',
                'the Q5 dual path needs settings.json to say 7838, it says ' + stored.serverPort);
            return 'settings.json serverPort 7838 (so a DEFAULT_PORT fallback is unambiguous)';
        });

        await ctx.check('L1.PRESETS.DEFAULT-PORT-BYTES', 'Q5', async () => {
            const res = await ctx.post('/launch-presets',
                { presets: presetsText(ctx), serverPath: winPath(ctx.sandbox.standin) });
            assert(res.status === 200, 'L1.PRESETS.DEFAULT-STATUS', 'POST /launch-presets returned ' + res.status);
            compareFixture('http/J4-launch-presets/launch-presets-default-port.response', res.raw);
            return '200 bytes == golden, incl. presetsFile ' +
                JSON.parse(res.raw.toString('utf8')).presetsFile;
        });

        await ctx.check('L1.PRESETS.INI-BYTES', 'Q10', async () => {
            await ctx.waitForRunning(true);
            compareFixture('ini/J4-launch-presets/presets-direct.ini', require('fs').readFileSync(iniFile));
            const text = require('fs').readFileSync(iniFile, 'utf8');
            assert(text.endsWith('port = 7838\n'), 'L1.PRESETS.INI-TRAILING-PORT',
                'Q10 not reproduced: the written ini does not end with the trailing port line; tail is ' +
                JSON.stringify(text.slice(-40)) + '\n      fixture: fixtures/ini/J4-launch-presets/presets-direct.ini');
            assert(text.includes('spec-ngram-size-n = 24\ndraft-min = 48\ndraft-max = 64\n'),
                'L1.PRESETS.INI-NGRAM-KEYS',
                'Q10 not reproduced: the ini does not carry the divergent ngram-mod key spellings');
            return require('fs').readFileSync(iniFile).length + ' bytes == fixtures/ini/J4-launch-presets/presets-direct.ini';
        });

        let noPortArgv;
        await ctx.check('L1.PRESETS.ARGV-PORT-8080', 'Q5', async () => {
            await ctx.sandbox.waitForArgvLines(2, 30000);
            const lines = ctx.sandbox.argvLines().map((line) => JSON.parse(line));
            noPortArgv = lines[lines.length - 1];
            const port = noPortArgv.argv[noPortArgv.argv.indexOf('--port') + 1];
            assert(port === '8080', 'L1.PRESETS.ARGV-PORT',
                'Q5 not reproduced: /launch-presets without serverPort spawned --port ' + port +
                ' while settings.json says 7838; DEFAULT_PORT 8080 is the recorded behaviour');
            assert(noPortArgv.argv.includes('--models-preset'), 'L1.PRESETS.ARGV-PRESET-FLAG',
                'the presets launch did not carry --models-preset: ' + JSON.stringify(noPortArgv.argv));
            const golden = fixtureJson('argv/J4-launch-presets/port-source-evidence.json');
            assert(JSON.stringify(noPortArgv.argv) === JSON.stringify(golden.launchPresetsWithoutServerPort.argv),
                'L1.PRESETS.ARGV-GOLDEN',
                'the presets argv differs from the recorded one:\n      expected ' +
                JSON.stringify(golden.launchPresetsWithoutServerPort.argv) + '\n      actual   ' +
                JSON.stringify(noPortArgv.argv) + '\n      fixture: fixtures/argv/J4-launch-presets/port-source-evidence.json');
            return '--port ' + port + ' with settings.json at 7838, argv == the recorded dual-path evidence';
        });

        await ctx.check('L1.PRESETS.STOP-AFTER-DEFAULT-PORT', 'Q24', async () => {
            const res = await ctx.post('/stop');
            compareFixture('http/J4-launch-presets/stop-after-default-port.response', res.raw);
            await ctx.waitForRunning(false);
            // Q24: /stop arms SIGTERM -> 1 s -> SIGKILL on the module-level runningProcess, so a
            // relaunch inside that window can be killed by the stale timer. The recording waits.
            await require('../lib/harness').delay(1500);
            return '200 success:true, then the recorded 1.5 s quiescence before relaunching (Q24)';
        });

        await ctx.check('L1.PRESETS.EXPLICIT-PORT-7838', 'Q5', async () => {
            const res = await ctx.post('/launch-presets',
                { presets: presetsText(ctx), serverPath: winPath(ctx.sandbox.standin), serverPort: 7838 });
            assert(res.status === 200, 'L1.PRESETS.EXPLICIT-STATUS', 'POST /launch-presets returned ' + res.status);
            compareFixture('http/J4-launch-presets/launch-presets-explicit-port.response', res.raw);
            await ctx.waitForRunning(true);
            await ctx.sandbox.waitForArgvLines(4, 30000);
            const lines = ctx.sandbox.argvLines().map((line) => JSON.parse(line));
            const withPort = lines[lines.length - 1];
            const port = withPort.argv[withPort.argv.indexOf('--port') + 1];
            assert(port === '7838', 'L1.PRESETS.EXPLICIT-PORT',
                'Q5: /launch-presets with serverPort 7838 spawned --port ' + port);
            compareFixture('ini/J4-launch-presets/presets-direct-with-port.ini',
                require('fs').readFileSync(ctx.sandbox.iniFile()));
            const golden = fixtureJson('argv/J4-launch-presets/port-source-evidence.json');
            assert(JSON.stringify(withPort.argv) === JSON.stringify(golden.launchPresetsWithServerPort.argv),
                'L1.PRESETS.EXPLICIT-ARGV-GOLDEN',
                'the second presets argv differs from the recorded one:\n      expected ' +
                JSON.stringify(golden.launchPresetsWithServerPort.argv) + '\n      actual   ' +
                JSON.stringify(withPort.argv));
            return 'same ini bytes, --port 7838 taken from the request body';
        });

        await ctx.check('L1.PRESETS.RESTART-STILL-400', 'Q4', async () => {
            const res = await ctx.post('/restart');
            assert(res.status === 400, 'L1.PRESETS.RESTART-STATUS',
                'POST /restart after a presets launch returned ' + res.status + '; /launch-presets never' +
                ' sets lastLaunchConfig, so legacy answers 400');
            compareFixture('http/J4-launch-presets/restart-after-presets.response', res.raw);
            return '400 + "No previous configuration found to restart from"';
        });

        await ctx.check('L1.PRESETS.STOP-AFTER-EXPLICIT-PORT', 'contract', async () => {
            const res = await ctx.post('/stop');
            compareFixture('http/J4-launch-presets/stop-after-explicit-port.response', res.raw);
            await ctx.waitForRunning(false);
            return '200 success:true';
        });

        await ctx.check('L1.PRESETS.STANDIN-RELAY-ARGV-IDENTICAL', 'contract', async () => {
            const lines = ctx.sandbox.argvLines().map((line) => JSON.parse(line));
            const pairs = [];
            for (let index = 1; index < lines.length; index += 1) {
                if (JSON.stringify(lines[index - 1].argv) === JSON.stringify(lines[index].argv) &&
                    lines[index - 1].pid !== lines[index].pid) pairs.push(index / 2);
            }
            assert(pairs.length === 2, 'L1.PRESETS.RELAY-ARGV-PAIRS',
                'expected the compiled stand-in and the relayed fake to record ' +
                'identical argv twice (4 log lines), found ' + pairs.length + ' pair(s) in ' +
                lines.length + ' line(s); the stand-in relay must not reshape the app-built vector');
            return pairs.length + ' relay pairs, argv identical across the relay';
        });
    }
};
