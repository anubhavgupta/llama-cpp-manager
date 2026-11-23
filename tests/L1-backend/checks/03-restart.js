'use strict';

// /restart group: the exact recorded Q3/Q4/Q23 semantics.
//
// Session: nvidia-smi stub mode 'ok', a argv log of its own, and a second manager session at the
// end for Q4 (lastLaunchConfig is in-memory state, so a restarted manager answers 400).
//
// The race the recorded fixtures declare (COMPARISON.json rule restart-settle) is asserted with
// that rule's bounds, never with a tightened expectation.

const path = require('path');

const { assert, compareFixture, delay, fixtureBytes, fixtureJson, replayBody, ruleFor, waitFor, winPath } = require('../lib/harness');

const plainModel = (ctx) => winPath(path.join(ctx.sandbox.modelsDir, 'a', 'model-a.gguf'));

module.exports = {
    name: 'restart',
    stubMode: 'ok',
    async run(ctx) {
        const startBody = replayBody(fixtureJson('http/J3d-restart/start.request.json').body);

        await ctx.check('L1.RESTART.NO-CONFIG-400', 'Q4', async () => {
            const res = await ctx.post('/restart');
            assert(res.status === 400, 'L1.RESTART.NO-CONFIG-STATUS',
                'POST /restart with no lastLaunchConfig returned ' + res.status + ', legacy returns 400');
            compareFixture('http/J3d-restart/restart-before-any-launch.response', res.raw);
            return '400 + {"success":false,"error":"No previous configuration found to restart from"}';
        });

        await ctx.check('L1.RESTART.START-FIRST', 'contract', async () => {
            // Connected before /start so this client is in connectedClients for the whole
            // /start -> /restart -> settle journey that fixtures/ws/J3d-restart/event-identity.json
            // records.
            await ctx.connectSocket('L1-restart-observer');
            const res = await ctx.post('/start', startBody);
            assert(res.status === 200, 'L1.RESTART.START-STATUS', 'POST /start returned ' + res.status);
            compareFixture('http/J3d-restart/start.response', res.raw);
            await ctx.sandbox.waitForArgvLines(1, 30000);
            await ctx.waitForRunning(true);
            const golden = fixtureBytes('argv/J3d-restart/after-start.jsonl').toString('utf8')
                .split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
            const live = ctx.sandbox.argvLines().map((line) => JSON.parse(line));
            assert(JSON.stringify(live.map((line) => line.argv)) === JSON.stringify(golden.map((line) => line.argv)),
                'L1.RESTART.START-ARGV',
                'the argv before /restart differs from the recorded one:\n      expected ' +
                JSON.stringify(golden[0].argv) + '\n      got      ' + JSON.stringify(live[0] && live[0].argv) +
                '\n      fixture: fixtures/argv/J3d-restart/after-start.jsonl');
            return 'spawned with the recorded argv (' + golden[0].argv.length + ' args)';
        });

        await ctx.check('L1.RESTART.GET-IS-EXPRESS-404', 'Q23', async () => {
            const res = await ctx.get('/restart');
            assert(res.status === 404, 'L1.RESTART.GET-STATUS',
                'GET /restart returned ' + res.status + '; Express owns unmatched routes, so the recorded' +
                ' answer is the framework 404 page, not the app JSON');
            compareFixture('http/J3d-restart/restart-get-not-a-route.response', res.raw);
            return '404 + the Express "Cannot GET /restart" page, byte-identical to the golden';
        });

        let restartBody;
        let statusImmediately;
        let statusSettled;
        let stopAfterRestart;
        await ctx.check('L1.RESTART.OK-200-TRUE', 'Q3', async () => {
            const res = await ctx.post('/restart');
            assert(res.status === 200, 'L1.RESTART.OK-STATUS', 'POST /restart returned ' + res.status);
            compareFixture('http/J3d-restart/restart.response', res.raw);
            restartBody = JSON.parse(res.raw.toString('utf8'));
            assert(restartBody.success === true, 'L1.RESTART.OK-SUCCESS', 'body is ' + res.raw.toString('utf8'));
            return '200 + ' + res.raw.toString('utf8');
        });

        await ctx.check('L1.RESTART.STATUS-SETTLES-FALSE', 'Q23', async () => {
            statusImmediately = await ctx.get('/status');
            compareFixture('http/J3d-restart/status-immediately-after-restart.response', statusImmediately.raw);
            await delay(2000);
            statusSettled = await ctx.get('/status');
            compareFixture('http/J3d-restart/status-after-restart-settle.response', statusSettled.raw);
            const settled = JSON.parse(statusSettled.raw.toString('utf8'));
            assert(settled.running === false, 'L1.RESTART.SETTLE-RUNNING',
                'Q23 not reproduced: GET /status settles on ' + statusSettled.raw.toString('utf8') +
                ' after POST /restart; the killed child\'s close handler clears the module-level' +
                ' runningProcess after /restart assigned the replacement' +
                '\n      fixture: fixtures/http/J3d-restart/status-after-restart-settle.response');
            return 'immediately ' + statusImmediately.raw.toString('utf8') + ', after 2 s ' +
                statusSettled.raw.toString('utf8');
        });

        await ctx.check('L1.RESTART.STOP-AFTER-RESTART-200-FALSE', 'Q23', async () => {
            stopAfterRestart = await ctx.post('/stop');
            assert(stopAfterRestart.status === 200, 'L1.RESTART.STOP-STATUS',
                'POST /stop after /restart returned ' + stopAfterRestart.status + ', legacy returns 200');
            compareFixture('http/J3d-restart/stop-after-restart.response', stopAfterRestart.raw);
            const body = JSON.parse(stopAfterRestart.raw.toString('utf8'));
            assert(body.success === false, 'L1.RESTART.STOP-SUCCESS',
                'Q23 not reproduced: POST /stop after /restart reported ' + stopAfterRestart.raw.toString('utf8'));
            return '200 + success:false — the replacement child is unreachable to /stop';
        });

        await ctx.check('L1.RESTART.ARGV-GAINED-ONE-SPAWN', 'Q23', async () => {
            await delay(1500);
            const lines = ctx.sandbox.argvLines();
            const rule = ruleFor('http/J3d-restart/restart-settle.json');
            const bounds = rule.assert.find((spec) => spec.op === 'jsonNumberBounds')
                .bounds.find((spec) => spec.field === 'argvLines');
            assert(lines.length >= bounds.min && lines.length <= bounds.max, 'L1.RESTART.ARGV-LINES',
                'the argv log holds ' + lines.length + ' line(s); the recorded settle snapshot asserts' +
                ' exactly one spawn for /start and one for /restart (' + bounds.min + '-' + bounds.max + ')' +
                '\n      fixture: fixtures/http/J3d-restart/restart-settle.json');
            return lines.length + ' argv lines, inside the restart-settle rule bounds [' +
                bounds.min + ', ' + bounds.max + ']';
        });

        await ctx.check('L1.RESTART.EVENT-IDENTITY', 'Q23', async () => {
            const golden = fixtureJson('ws/J3d-restart/event-identity.json');
            const names = ctx.ws ? [...new Set(ctx.ws.events.map((entry) => entry.event))].sort() : [];
            const missing = golden.eventNames.filter((name) => name !== 'disconnect' && !names.includes(name));
            assert(missing.length === 0, 'L1.RESTART.EVENT-IDENTITY',
                'the socket.io client saw ' + JSON.stringify(names) + ' across /start -> /restart ->' +
                ' settle; the recorded identity is ' + JSON.stringify(golden.eventNames) +
                '\n      fixture: fixtures/ws/J3d-restart/event-identity.json');
            if (names.includes('log-stream')) {
                assert(names.includes('server-ended'), 'L1.RESTART.EVENT-ENDED-PRESENT',
                    'a child streamed logs but no server-ended event followed the /restart kill');
            }
            return 'event identity ' + JSON.stringify(names) + ' covers the recorded set ' +
                JSON.stringify(golden.eventNames);
        });

        await ctx.check('L1.RESTART.SETTLE-RULE-BOUNDS', 'Q23', async () => {
            const settle = fixtureJson('http/J3d-restart/restart-settle.json');
            assert(JSON.stringify(settle.restartBody) === JSON.stringify(restartBody), 'L1.RESTART.RESTART-BODY',
                'the /restart body differs from the recorded one (the rule keeps this byte-exact):' +
                '\n      expected ' + JSON.stringify(settle.restartBody) + '\n      actual   ' +
                JSON.stringify(restartBody));
            assert(settle.recordedOnPlatform === process.platform, 'L1.RESTART.RECORDED-PLATFORM',
                'the recorded settle snapshot is from ' + settle.recordedOnPlatform + ', this run is on ' +
                process.platform + '; the /restart race ordering is platform-bound');
            return 'restartBody byte-identical and the recorded platform matches this run (' +
                settle.recordedOnPlatform + ')';
        });

        await ctx.check('L1.RESTART.AFTER-MANAGER-RESTART-400', 'Q4', async () => {
            const argvBefore = ctx.sandbox.argvLines().length;
            await ctx.restartManager();
            const res = await ctx.post('/restart');
            assert(res.status === 400, 'L1.RESTART.Q4-STATUS',
                'Q4 not reproduced: POST /restart on a freshly started manager returned ' + res.status);
            compareFixture('http/J3d-restart/restart-after-manager-restart.response', res.raw);
            const argvAfter = ctx.sandbox.argvLines().length;
            assert(argvAfter === argvBefore, 'L1.RESTART.Q4-NO-SPAWN',
                'a 400 /restart must not spawn: the argv log went ' + argvBefore + ' -> ' + argvAfter);
            const recorded = fixtureJson('http/J3d-restart/restart-after-manager-restart.json');
            assert(recorded.status === 400, 'L1.RESTART.Q4-GOLDEN',
                'the recorded Q4 snapshot does not say 400: ' + JSON.stringify(recorded));
            return '400 + ' + res.raw.toString('utf8') + ', argv log gained nothing';
        });
    }
};
