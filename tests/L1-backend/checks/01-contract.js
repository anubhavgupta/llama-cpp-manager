'use strict';

// Endpoint contract group: every endpoint's happy path against the recorded legacy bytes, the
// settings.json writes including the Q2 TDZ bug, the Q11 hard-coded manager port, and the /models
// scan rules (mmproj exclusion + first-match association).
//
// Session: nvidia-smi stub mode 'ok' on a sandbox that has never seen POST /settings, because
// fixtures/http/J0-baseline/settings-first-run.response is the app's own default branch and only a
// pristine settings.json-less app reaches it.

const fs = require('fs');

const { assert, compareFixture, diffText, fixtureBytes, fixtureJson, replayBody, winPath } = require('../lib/harness');

module.exports = {
    name: 'contract',
    stubMode: 'ok',
    async run(ctx) {
        const modelsDir = ctx.sandbox.modelsDir;
        const settingsFile = ctx.sandbox.settingsFile();

        await ctx.check('L1.ROOT.BYTES', 'contract', async () => {
            const res = await ctx.get('/');
            assert(res.status === 200, 'L1.ROOT.STATUS', 'GET / returned ' + res.status);
            compareFixture('http/J0-baseline/root.response', res.raw);
            return '200, ' + res.raw.length + ' bytes == fixtures/http/J0-baseline/root.response';
        });

        await ctx.check('L1.SWAGGER.BYTES', 'contract', async () => {
            const res = await ctx.get('/swagger');
            assert(res.status === 200, 'L1.SWAGGER.STATUS', 'GET /swagger returned ' + res.status);
            compareFixture('http/J0-baseline/swagger.response', res.raw);
            return '200, ' + res.raw.length + ' bytes == fixtures/http/J0-baseline/swagger.response';
        });

        await ctx.check('L1.SWAGGER-JSON.BYTES', 'contract', async () => {
            const res = await ctx.get('/swagger.json');
            assert(res.status === 200, 'L1.SWAGGER-JSON.STATUS', 'GET /swagger.json returned ' + res.status);
            compareFixture('http/J0-baseline/swagger-json.response', res.raw);
            return '200, ' + res.raw.length + ' bytes == fixtures/http/J0-baseline/swagger-json.response';
        });

        await ctx.check('L1.SETTINGS.FIRST-RUN.BYTES', 'contract', async () => {
            assert(!fs.existsSync(settingsFile), 'L1.SETTINGS.PRISTINE',
                'the sandbox app already has a settings.json at ' + settingsFile +
                ', so the first-run default branch of GET /settings is not reachable');
            const res = await ctx.get('/settings');
            assert(res.status === 200, 'L1.SETTINGS.FIRST-RUN.STATUS', 'GET /settings returned ' + res.status);
            compareFixture('http/J0-baseline/settings-first-run.response', res.raw);
            const body = JSON.parse(res.raw.toString('utf8'));
            assert(body.success === true, 'L1.SETTINGS.FIRST-RUN.SUCCESS', 'body is ' + res.raw.toString('utf8'));
            assert(body.settings.serverPort === 8080, 'L1.SETTINGS.FIRST-RUN.DEFAULT-PORT',
                'first-run serverPort is ' + body.settings.serverPort + ', expected DEFAULT_PORT 8080');
            return 'first-run default branch byte-identical, serverPort 8080, modelsDirectory ' +
                body.settings.modelsDirectory;
        });

        await ctx.check('L1.SETTINGS.POST-WITH-PORT.BYTES', 'contract', async () => {
            const res = await ctx.post('/settings', { modelsDirectory: winPath(modelsDir), serverPort: 7838 });
            assert(res.status === 200, 'L1.SETTINGS.POST-WITH-PORT.STATUS', 'POST /settings returned ' + res.status);
            compareFixture('http/J1-settings/settings-post-with-port.response', res.raw);
            compareFixture('ini/J1-settings/settings.after-with-port.json', fs.readFileSync(settingsFile));
            return '200 bytes == golden AND settings.json bytes == fixtures/ini/J1-settings/settings.after-with-port.json';
        });

        await ctx.check('L1.SETTINGS.READ-BACK.BYTES', 'contract', async () => {
            const res = await ctx.get('/settings');
            compareFixture('http/J1-settings/settings-read.response', res.raw);
            const body = JSON.parse(res.raw.toString('utf8'));
            assert(body.settings.serverPort === 7838, 'L1.SETTINGS.READ-BACK.PORT',
                'GET /settings after the POST shows ' + body.settings.serverPort);
            return '200 bytes == fixtures/http/J1-settings/settings-read.response, serverPort 7838';
        });

        await ctx.check('L1.SETTINGS.TDZ-PORT-8080', 'Q2', async () => {
            const before = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
            assert(before.serverPort === 7838, 'L1.SETTINGS.TDZ.PRECONDITION',
                'the Q2 probe needs settings.json to say 7838 first, it says ' + before.serverPort);
            const res = await ctx.post('/settings', { modelsDirectory: winPath(modelsDir) });
            assert(res.status === 200, 'L1.SETTINGS.TDZ.STATUS', 'POST /settings without serverPort returned ' + res.status);
            compareFixture('http/J1-settings/settings-post-without-port.response', res.raw);
            const written = fs.readFileSync(settingsFile);
            compareFixture('ini/J1-settings/settings.after-without-port.json', written);
            const after = JSON.parse(written.toString('utf8'));
            assert(after.serverPort === 8080, 'L1.SETTINGS.TDZ.WRITTEN',
                'Q2 not reproduced: POST /settings without serverPort wrote ' + after.serverPort +
                ' over a file that said 7838; the recorded legacy file says 8080');
            return 'POST without serverPort rewrote 7838 -> 8080 (TDZ: existing settings never read);' +
                ' response and file bytes both == goldens';
        });

        await ctx.check('L1.PORT.HARD-CODED-7837', 'Q11', async () => {
            const stored = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
            const res = await ctx.get('/status');
            assert(res.status === 200, 'L1.PORT.REACHABLE',
                'the manager is not answering on port ' + ctx.port + ' while settings.json says ' +
                stored.serverPort);
            assert(ctx.port === 7837, 'L1.PORT.SUITE-PORT',
                'the suite is talking to port ' + ctx.port + '; Q11 pins the manager on 7837');
            assert(stored.serverPort !== 7837, 'L1.PORT.DIVERGENCE',
                'settings.json says ' + stored.serverPort + '; the Q11 claim needs a value other than 7837');
            return 'settings.json serverPort=' + stored.serverPort + ' and the manager still answers on 7837';
        });

        await ctx.check('L1.STATUS.IDLE.BYTES', 'contract', async () => {
            const res = await ctx.get('/status');
            assert(res.status === 200, 'L1.STATUS.IDLE.STATUS', 'GET /status returned ' + res.status);
            compareFixture('http/J1-settings/status.response', res.raw);
            return '{"running":false} == fixtures/http/J1-settings/status.response';
        });

        await ctx.check('L1.METRICS.STUB-SHAPE', 'contract', async () => {
            for (const name of ['metrics-1', 'metrics-2', 'metrics-3']) {
                const res = await ctx.get('/metrics');
                assert(res.status === 200, 'L1.METRICS.STUB.STATUS', 'GET /metrics returned ' + res.status);
                const rule = compareFixture('http/J1-settings/' + name + '.response', res.raw);
                const body = JSON.parse(res.raw.toString('utf8'));
                assert(Object.keys(body).join(',') === 'cpu,ram,gpu,vram,vramUsage',
                    'L1.METRICS.KEY-SET', 'key set changed: ' + Object.keys(body).join(','));
                assert(body.vramUsage === '12345/24576', 'L1.METRICS.STUB.VRAM-USAGE',
                    'with the nvidia-smi stub on PATH vramUsage must be the stub-derived' +
                    ' ${total-free}/${total}, got ' + body.vramUsage + ' (rule ' + rule + ')');
            }
            return '3 samples: five-field key set, gpu/vram/vramUsage == the stub canned numbers,' +
                ' cpu/ram relaxed by rule metrics-body-stub';
        });

        // The manager now points at the fixture tree (POST /settings above), which is what J2
        // recorded, so /models has to be byte-identical to the recorded scan of that tree.
        await ctx.check('L1.MODELS.BYTES', 'contract', async () => {
            const res = await ctx.get('/models');
            assert(res.status === 200, 'L1.MODELS.STATUS', 'GET /models returned ' + res.status);
            compareFixture('http/J2-models/models.response', res.raw);
            const body = JSON.parse(res.raw.toString('utf8'));
            assert(body.success === true, 'L1.MODELS.SUCCESS', 'body is not a success');
            return body.models.length + ' models, bytes == fixtures/http/J2-models/models.response';
        });

        await ctx.check('L1.MODELS.MMPROJ-EXCLUDED', 'contract', async () => {
            const body = JSON.parse((await ctx.get('/models')).raw.toString('utf8'));
            const rel = (p) => String(p).split('\\').join('/');
            const leaked = body.models.filter((model) => rel(model.path).split('/').pop().toLowerCase().startsWith('mmproj'));
            assert(leaked.length === 0, 'L1.MODELS.MMPROJ-EXCLUDED',
                'a mmproj file leaked into the /models result: ' + JSON.stringify(leaked.slice(0, 3)));
            return leaked.length + ' mmproj entries; ' + body.models.length + ' models, none mmproj*';
        });

        await ctx.check('L1.MODELS.MMPROJ-FIRST-MATCH', 'contract', async () => {
            const rel = (p) => String(p).split('\\').join('/');
            const live = JSON.parse((await ctx.get('/models')).raw.toString('utf8'));
            const golden = fixtureJson('http/J2-models/models.response');
            const byRelative = new Map(live.models.map((model) => [rel(model.relativePath), model]));
            const expected = new Map(golden.models.map((model) => [rel(model.relativePath), model]));
            for (const [relative, want] of expected) {
                const got = byRelative.get(relative);
                assert(got, 'L1.MODELS.MMPROJ-FIRST-MATCH', 'the live scan is missing ' + relative);
                const wantMmproj = want.mmprojFile === null ? null : rel(want.mmprojFile);
                const gotMmproj = got.mmprojFile === null ? null : rel(got.mmprojFile);
                assert(wantMmproj === gotMmproj, 'L1.MODELS.MMPROJ-FIRST-MATCH',
                    relative + ': mmprojFile is ' + JSON.stringify(gotMmproj) + ', the recorded legacy' +
                    ' first-match association says ' + JSON.stringify(wantMmproj) +
                    '\n      fixture: fixtures/http/J2-models/models.response');
            }
            const multi = byRelative.get('multi-mmproj/multi-model.gguf');
            assert(/mmproj-a\.gguf$/.test(String(multi && multi.mmprojFile)), 'L1.MODELS.MMPROJ-FIRST-MATCH',
                'multi-mmproj directory did not resolve to the first readdir match: ' +
                JSON.stringify(multi && multi.mmprojFile));
            const nested = byRelative.get('a/b/deep-b-model.gguf');
            assert(nested && nested.mmprojFile === null, 'L1.MODELS.MMPROJ-SCOPE',
                'a parent-directory mmproj must not be associated with a nested model, got ' +
                JSON.stringify(nested && nested.mmprojFile));
            return expected.size + ' models carry the recorded mmprojFile association, incl. the' +
                ' case-sensitive probe and the multi-mmproj first match';
        });

        await ctx.check('L1.MODELS.UNREADABLE-ABSENT', 'contract', async () => {
            const body = JSON.parse((await ctx.get('/models')).raw.toString('utf8'));
            const rel = (p) => String(p).split('\\').join('/');
            const found = body.models.filter((model) => /unreadable/.test(rel(model.path)));
            assert(found.length === 0, 'L1.MODELS.UNREADABLE-ABSENT',
                'the ACL-denied directory was readable: ' + JSON.stringify(found.slice(0, 2)) +
                ' — the fixture tree was not denied, so this run is not comparable with the recording');
            return 'no entries under models/unreadable, matching the recorded ACL-denied subtree';
        });

        await ctx.check('L1.STATIC.INDEX-MATCHES-GOLDEN', 'contract', async () => {
            const served = (await ctx.get('/')).raw;
            const onDisk = fixtureBytes('http/J0-baseline/root.response');
            assert(served.equals(onDisk), 'L1.STATIC.INDEX-MATCHES-GOLDEN',
                diffText(onDisk, served, 'fixtures/http/J0-baseline/root.response'));
            return 'the served index.html is the recorded byte stream (' + served.length + ' bytes)';
        });

        await ctx.check('L1.SETTINGS.REPLAY-MODELSDIR-REQUIRED', 'contract', async () => {
            const res = await ctx.post('/settings', { serverPort: 7838 });
            assert(res.status === 400, 'L1.SETTINGS.NO-MODELS-DIR-400',
                'POST /settings without modelsDirectory returned ' + res.status + ', expected 400');
            assert(res.raw.toString('utf8') === JSON.stringify({ success: false, error: 'Models directory path is required' }),
                'L1.SETTINGS.NO-MODELS-DIR-BODY', 'body is ' + res.raw.toString('utf8'));
            const replayed = replayBody(fixtureJson('http/J1-settings/settings-post-with-port.request.json').body);
            assert(replayed.serverPort === 7838, 'L1.SETTINGS.REPLAY-MODELSDIR-REQUIRED',
                'the recorded request body did not survive replay: ' + JSON.stringify(replayed));
            return '400 + {"success":false,"error":"Models directory path is required"}';
        });
    }
};
