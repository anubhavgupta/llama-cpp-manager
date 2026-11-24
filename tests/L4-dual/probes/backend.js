'use strict';
// The action script, backend half: the endpoint behaviors the same journeys exercise at L1, observed
// as fields instead of asserted as pass/fail. Values are tokenised on the way in (scratch root, app
// dir, node executable, stand-in exe), so two runs of this script in two scratch roots — legacy A
// and legacy B in self-mode, or legacy and a candidate in Part 2 — produce comparable fields.
//
// `family` names the fixture family each field belongs to; the differ applies that family's
// fixtures/COMPARISON.json rule (§8) to both sides. A null family means the default: byte equality.

const { winPath } = require('../../L3-seam/helpers/pathmap');
const { tokenise } = require('./tokenise');

const body = (res) => res.raw.toString('utf8');
const statusBody = (res) => res.status + ' ' + res.raw.toString('utf8');

async function backend(ctx) {
    const manager = ctx.manager;
    const observe = ctx.observe;
    const add = (key, family, value) => observe.add(key, family, tokenise(manager, value));

    const home = await manager.request('GET', '/');
    add('backend.home.status', null, home.status);
    add('backend.home.bytes', null, require('crypto').createHash('sha256').update(home.raw).digest('hex'));
    add('backend.swagger.status', null, (await manager.request('GET', '/swagger')).status);
    add('backend.unknown-route', null, statusBody(await manager.request('GET', '/no-such-route')));
    add('backend.status.idle', null, body(await manager.request('GET', '/status')));
    add('backend.metrics', 'http/J1-settings/metrics-1.response',
        body(await manager.request('GET', '/metrics')));

    const settingsFile = require('path').join(manager.app, 'settings.json');
    require('fs').rmSync(settingsFile, { force: true });
    add('backend.settings.first-run', 'http/J0-baseline/settings-first-run.response',
        body(await manager.request('GET', '/settings')));
    await manager.writeSettings({ modelsDirectory: winPath(manager.modelsDir), serverPort: 7838 });
    add('backend.settings.file.after-with-port', 'ini/J1-settings/settings.after-with-port.json',
        manager.settingsBytes().toString('utf8'));
    await manager.writeSettings({ modelsDirectory: winPath(manager.modelsDir) });
    add('backend.settings.file.Q2', 'ini/J1-settings/settings.after-without-port.json',
        manager.settingsBytes().toString('utf8'));
    add('backend.settings.read', 'http/J1-settings/settings-read.response',
        body(await manager.request('GET', '/settings')));

    add('backend.models', 'http/J2-models/models.response', body(await manager.request('GET', '/models')));
    const models = JSON.parse(body(await manager.request('GET', '/models'))).models;
    add('backend.models.mmproj-association', null,
        models.filter((model) => model.mmprojFile).map((model) => model.relativePath + ' -> '
            + model.mmprojFile));

    add('backend.start.missing-serverPath', 'http/J3c-start-missing-path/start.response',
        statusBody(await manager.request('POST', '/start', { args: ['-m', 'x'] })));
    add('backend.stop.idle', null, statusBody(await manager.request('POST', '/stop')));
    add('backend.restart.no-config', 'http/J3d-restart/restart-after-manager-restart.response',
        statusBody(await manager.request('POST', '/restart')));
    add('backend.presets.no-presets', null,
        statusBody(await manager.request('POST', '/launch-presets', { serverPath: winPath(manager.standin) })));
    add('backend.presets.no-serverPath', null,
        statusBody(await manager.request('POST', '/launch-presets', { presets: 'version = 1\n\n' })));

    // One scripted /start, then the argv the stand-in recorded for it (rule argv-jsonl substitutes
    // the pid), then the Q3 branch: a second /start while the child is registered.
    const before = manager.argvRecords().length;
    const started = await manager.request('POST', '/start', { serverPath: winPath(manager.standin),
        args: ['-m', winPath(manager.modelsDir) + '\\model-a.gguf', '--port', '7838'] });
    add('backend.start.body', 'http/J3-start-stop/start.response', statusBody(started));
    const spawned = await manager.waitForLaunch(before, 30000);
    add('backend.start.spawned', null, spawned !== null);
    // The argv family is jsonl text, so the argv-jsonl rule can substitute the pid/ppid fields —
    // that is the one §8 row this layer has to relax, and it is relaxed by the policy, not here.
    add('backend.start.argv', 'argv/J3-start-stop/launch.jsonl',
        tokenise(manager, manager.argvLines().slice(before, before + 2).join('\n')));
    add('backend.start.while-running', 'http/J3-start-stop/start-while-running.request.json',
        statusBody(await manager.request('POST', '/start', { serverPath: winPath(manager.standin) })));
    await manager.stopAndWait();
    add('backend.status.after-stop', null, body(await manager.request('GET', '/status')));

    // /launch-presets writes the request body verbatim and builds its own argv (Q5 dual path).
    const presets = 'version = 1\n\n[dual-alpha]\nmodel = x.gguf\ntemp = 0.7\n\n';
    const presetsBefore = manager.argvRecords().length;
    await manager.request('POST', '/launch-presets', { presets, serverPath: winPath(manager.standin) });
    const presetsSpawn = await manager.waitForLaunch(presetsBefore, 30000);
    add('backend.presets.default-port.spawned', null, presetsSpawn !== null);
    add('backend.presets.default-port.argv', 'argv/J4-launch-presets/launch.jsonl',
        presetsSpawn ? tokenise(manager, manager.argvLines().slice(presetsBefore, presetsBefore + 2)
            .join('\n')) : null);
    await manager.stopAndWait();
    const withPortBefore = manager.argvRecords().length;
    await manager.request('POST', '/launch-presets', { presets, serverPath: winPath(manager.standin),
        serverPort: 7838 });
    const withPortSpawn = await manager.waitForLaunch(withPortBefore, 30000);
    add('backend.presets.explicit-port.argv', 'argv/J4-launch-presets/launch.jsonl',
        withPortSpawn ? tokenise(manager, manager.argvLines().slice(withPortBefore, withPortBefore + 2)
            .join('\n')) : null);
    await manager.stopAndWait();
    add('backend.presets.ini.bytes', 'ini/J4-launch-presets/presets-direct.ini',
        manager.iniBytes() ? manager.iniBytes().toString('utf8') : null);
    add('backend.presets.ini.after', null,
        manager.iniBytes() ? manager.iniBytes().toString('utf8') : null);
}

module.exports = [{ id: 'backend', title: 'endpoint contract + recorded argv/ini bytes', run: backend }];
