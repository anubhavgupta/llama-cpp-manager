'use strict';

// Process group: /start and /stop on both branches, the argv the stand-in actually receives, the
// raw stdout chunk forwarding claim (§9 cross-stack trap 2), the exit-code path, the
// SIGTERM -> 1 s -> SIGKILL stop semantics against the stand-in, and the Q24 stale-timer window.
//
// Session: nvidia-smi stub mode 'ok'. The recorded bytes this group compares against come from
// fixtures/http/J3*, fixtures/argv/J3* and fixtures/ws/J3-start-stop/events.json.
//
// The first /start replays the body the recording posted (fixtures/http/J3-start-stop/
// start.request.json), which is what makes 'the argv the stand-in received' and 'the log bytes the
// client received' comparable against the goldens instead of against a re-derivation.

const path = require('path');

const { assert, compareFixture, delay, diffText, fixtureBytes, fixtureJson, NORMALIZE, replayBody,
    ruleFor, waitFor, winPath } = require('../lib/harness');

const plainModel = (ctx) => winPath(path.join(ctx.sandbox.modelsDir, 'a', 'model-a.gguf'));

function processAlive(pid) {
    if (!Number.isInteger(pid)) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return false;
    }
}

// Collapse a log-stream trace the way fixtures/COMPARISON.json rule ws-events declares, so the
// byte claim is compared and only the coalescing is relaxed.
function collapsedStream(trace) {
    const rule = ruleFor('ws/J3-start-stop/events.json');
    const op = rule.normalize.find((candidate) => candidate.op === 'wsCollapseLogStreams');
    const events = JSON.parse(NORMALIZE.wsCollapseLogStreams(JSON.stringify(trace), op)).events;
    return Buffer.concat(events.filter((entry) => entry.event === 'log-stream')
        .map((entry) => Buffer.from(entry.payload.dataBase64, 'base64')));
}

module.exports = {
    name: 'process',
    stubMode: 'ok',
    async run(ctx) {
        const startBody = replayBody(fixtureJson('http/J3-start-stop/start.request.json').body);
        const goldenArgv = fixtureBytes('argv/J3-start-stop/launch.jsonl').toString('utf8')
            .split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));

        await ctx.check('L1.STATUS.BEFORE-START.BYTES', 'contract', async () => {
            const res = await ctx.get('/status');
            compareFixture('http/J3-start-stop/status-before.response', res.raw);
            return '{"running":false} == fixtures/http/J3-start-stop/status-before.response';
        });

        await ctx.check('L1.START.MISSING-PATH-400', 'Q3', async () => {
            const res = await ctx.post('/start', { args: ['-m', 'x.gguf'] });
            assert(res.status === 400, 'L1.START.MISSING-PATH-STATUS',
                'Q3 not reproduced: /start without serverPath returned ' + res.status + ', legacy returns 400');
            compareFixture('http/J3c-start-missing-path/start-without-serverpath.response', res.raw);
            assert(ctx.sandbox.argvLines().length === 0, 'L1.START.MISSING-PATH-NO-SPAWN',
                'a 400 /start must not spawn: the argv log gained ' + ctx.sandbox.argvLines().length + ' line(s)');
            return '400 + {"success":false,"error":"Server path is required"}, nothing spawned';
        });

        await ctx.check('L1.STOP.WHILE-IDLE-200', 'Q3', async () => {
            const res = await ctx.post('/stop');
            assert(res.status === 200, 'L1.STOP.IDLE-STATUS', 'POST /stop while idle returned ' + res.status);
            compareFixture('http/J3c-start-missing-path/stop-while-idle.response', res.raw);
            return '200 + success:false == fixtures/http/J3c-start-missing-path/stop-while-idle.response';
        });

        await ctx.check('L1.START.OK-BYTES', 'contract', async () => {
            const ws = await ctx.connectSocket('L1-process');
            ctx.ws = ws;
            const res = await ctx.post('/start', startBody);
            assert(res.status === 200, 'L1.START.OK-STATUS', 'POST /start returned ' + res.status);
            compareFixture('http/J3-start-stop/start.response', res.raw);
            await ctx.waitForRunning(true);
            const streaming = await waitFor('the child boots and streams', 30000, () => ws.count('log-stream') > 0);
            assert(streaming, 'L1.START.STREAMING', 'the child streamed nothing to the socket.io client');
            return '200 + {"success":true,"message":"Server started successfully"}';
        });

        await ctx.check('L1.START.ARGV-MATCHES-GOLDEN', 'contract', async () => {
            await ctx.sandbox.waitForArgvLines(goldenArgv.length, 30000);
            const live = ctx.sandbox.argvLines().map((line) => JSON.parse(line));
            assert(live.length === goldenArgv.length, 'L1.START.ARGV-LINE-COUNT',
                'the stand-in recorded ' + live.length + ' spawn(s), the recording has ' + goldenArgv.length +
                '\n      fixture: fixtures/argv/J3-start-stop/launch.jsonl');
            goldenArgv.forEach((want, index) => {
                const got = live[index];
                assert(Array.isArray(got.argv), 'L1.START.ARGV-SHAPE', 'line ' + index + ' has no argv array');
                const mismatches = [];
                const length = Math.max(want.argv.length, got.argv.length);
                for (let position = 0; position < length; position += 1) {
                    if (want.argv[position] !== got.argv[position]) {
                        mismatches.push('      [' + position + '] expected ' + JSON.stringify(want.argv[position]) +
                            ', got ' + JSON.stringify(got.argv[position]));
                    }
                }
                assert(mismatches.length === 0, 'L1.START.ARGV-POSITIONAL-' + index,
                    'argv received by the stand-in differs from the golden argv array produced by the' +
                    ' SAME request body (fixtures/http/J3-start-stop/start.request.json):' +
                    mismatches.join('\n') + '\n      fixture: fixtures/argv/J3-start-stop/launch.jsonl');
            });
            const port = live[0].argv[live[0].argv.indexOf('--port') + 1];
            assert(port === '7838', 'L1.START.PORT-FROM-BODY',
                '--port came through as ' + port + '; the request body carries 7838 (settings.serverPort, Q5)');
            return live[0].argv.length + ' args positionally identical to the golden, --port 7838';
        });

        await ctx.check('L1.LOG.STREAM-MATCHES-RECORDED-BYTES', 'contract', async () => {
            const listening = 'main: server is listening on http://0.0.0.0:7838\n';
            const complete = await waitFor('the whole startup stream is delivered', 30000,
                () => ctx.ws.stream('stdout').toString('utf8').endsWith(listening));
            assert(complete, 'L1.LOG.STREAM-INCOMPLETE',
                'the startup stream never completed: ' +
                JSON.stringify(ctx.ws.stream('stdout').toString('utf8').slice(-160)));
            const want = collapsedStream(fixtureJson('ws/J3-start-stop/events.json'));
            const got = collapsedStream(ctx.ws.toFixtureEvents());
            assert(want.equals(got), 'L1.LOG.STREAM-MATCHES-RECORDED-BYTES',
                'the concatenated log-stream bytes differ from the recorded legacy stream' +
                '\n      fixture: fixtures/ws/J3-start-stop/events.json (shape rule ws-events)' +
                '\n      expected: ' + JSON.stringify(want.toString('utf8').slice(0, 220)) +
                '\n      actual:   ' + JSON.stringify(got.toString('utf8').slice(0, 220)));
            const goldenRule = ruleFor('ws/J3-start-stop/events.json');
            const partialOp = goldenRule.assert.find((spec) => spec.op === 'wsPartialLines');
            const partial = ctx.ws.events.filter((entry) => entry.event === 'log-stream' &&
                entry.bytes.indexOf(0x0a) < 0);
            assert(partial.length >= partialOp.min, 'L1.LOG.NO-LINE-SPLITTING',
                'expected at least ' + partialOp.min + ' log-stream payloads with no newline (the' +
                ' ws-partial-line assertion); saw ' + partial.length + ' — a forward path that' +
                ' reassembles lines would satisfy a byte-compare of the concatenation and must not' +
                ' pass here');
            return got.length + ' bytes == the recorded stream; ' + partial.length +
                ' partial-line payloads prove raw chunk forwarding';
        });

        await ctx.check('L1.STATUS.RUNNING-BYTES', 'contract', async () => {
            const res = await ctx.get('/status');
            compareFixture('http/J3-start-stop/status-running.response', res.raw);
            return '{"running":true} == fixtures/http/J3-start-stop/status-running.response';
        });

        await ctx.check('L1.STATUS.CADENCE-FREE-POLLING', 'contract', async () => {
            const polls = [];
            for (let index = 0; index < 10; index += 1) polls.push((await ctx.get('/status')).raw.toString('utf8'));
            const distinct = [...new Set(polls)];
            assert(distinct.length === 1 && distinct[0] === '{"running":true}', 'L1.STATUS.CADENCE-FREE',
                'ten direct /status polls while running returned ' + JSON.stringify(distinct) +
                '; the endpoint answers from runningProcess with no sampling window');
            return '10 back-to-back polls, all ' + distinct[0];
        });

        await ctx.check('L1.START.ALREADY-RUNNING-200', 'Q3', async () => {
            const res = await ctx.post('/start', startBody);
            assert(res.status === 200, 'L1.START.DUPLICATE-STATUS',
                'Q3 not reproduced: /start while running returned ' + res.status + ', legacy returns 200');
            compareFixture('http/J3-start-stop/start-while-running.response', res.raw);
            const body = JSON.parse(res.raw.toString('utf8'));
            assert(body.success === false && body.error === 'Server is already running',
                'L1.START.DUPLICATE-BODY', 'body is ' + res.raw.toString('utf8'));
            assert(ctx.sandbox.argvLines().length === goldenArgv.length, 'L1.START.DUPLICATE-NO-SPAWN',
                'the 200 success:false /start must not spawn a second child');
            return '200 + success:false + "Server is already running", still ' + goldenArgv.length + ' spawn line(s)';
        });

        await ctx.check('L1.STOP.OK-BYTES', 'contract', async () => {
            const res = await ctx.post('/stop');
            assert(res.status === 200, 'L1.STOP.STATUS', 'POST /stop returned ' + res.status);
            compareFixture('http/J3-start-stop/stop.response', res.raw);
            await ctx.waitForRunning(false);
            const ended = await waitFor('server-ended', 15000, () => ctx.ws.count('server-ended') > 0);
            assert(ended, 'L1.SOCKET.SERVER-ENDED-MISSING',
                'no server-ended event reached the socket.io client after POST /stop; events were ' +
                JSON.stringify(ctx.ws.events.map((entry) => entry.event)));
            return '{"success":true,"message":"Server stopped successfully"} + server-ended';
        });

        await ctx.check('L1.SOCKET.SERVER-ENDED-ORDER', 'contract', async () => {
            const endedEvents = ctx.ws.events.filter((entry) => entry.event === 'server-ended');
            assert(endedEvents.length === 1, 'L1.SOCKET.SERVER-ENDED-COUNT',
                'expected exactly one server-ended event, got ' + endedEvents.length);
            const golden = fixtureJson('ws/J3-start-stop/events.json').events
                .filter((entry) => entry.event === 'server-ended');
            assert(JSON.stringify(endedEvents[0].payload) === JSON.stringify(golden[0].payload),
                'L1.SOCKET.SERVER-ENDED-PAYLOAD',
                'server-ended payload is ' + JSON.stringify(endedEvents[0].payload) + ', recorded ' +
                JSON.stringify(golden[0].payload) + '\n      fixture: fixtures/ws/J3-start-stop/events.json');
            const names = ctx.ws.events.map((entry) => entry.event);
            assert(names.lastIndexOf('log-stream') < names.indexOf('server-ended'),
                'L1.SOCKET.SERVER-ENDED-LAST',
                'a log-stream event arrived after server-ended, so the recorded ordering is not held');
            // The recording's trailing 'disconnect' is the recorder closing its own socket, which
            // happens at the end of the group; while connected, the control sequence must match.
            const stripClose = (list) => (list[list.length - 1] === 'disconnect'
                ? list.slice(0, -1) : list);
            const control = stripClose(ctx.ws.toFixtureEvents().events
                .filter((entry) => entry.event !== 'log-stream').map((entry) => entry.event));
            const wantControl = stripClose(fixtureJson('ws/J3-start-stop/events.json').events
                .filter((entry) => entry.event !== 'log-stream').map((entry) => entry.event));
            assert(JSON.stringify(control) === JSON.stringify(wantControl), 'L1.SOCKET.EVENT-ORDER',
                'the non-log event sequence is ' + JSON.stringify(control) + ', recorded ' +
                JSON.stringify(wantControl) + '\n      fixture: fixtures/ws/J3-start-stop/events.json');
            return 'control events in recorded order: ' + JSON.stringify(control);
        });

        await ctx.check('L1.LOG.RAW-CHUNK-BYTES-FORWARDED', 'contract', async () => {
            // A fresh launch with --parity-chunks 3 plus an indent-padded repeated line: the fake
            // records every write it performs (tools/parity/fake-llama-server.js, PARITY_CHUNK_LOG),
            // and the socket.io client reassembles what it was handed. Equal bytes is the §9
            // cross-stack trap 2 claim — no line splitting, no server-side trim.
            await ctx.quietAfterStop();
            const pad = '   parity chunk-boundary probe: leading and trailing spaces kept   ';
            ctx.ws.events.length = 0;
            const launched = await ctx.launchRaw({ parityChunks: '3',
                extraArgs: ['--parity-repeat-line', pad, '--parity-repeat-count', '4'] });
            const streamed = await waitFor('the fake finishes streaming', 30000, () =>
                ctx.ws.stream('stdout').toString('utf8').split(pad).length - 1 >= 4);
            assert(streamed, 'L1.LOG.STREAM-INCOMPLETE',
                'the padded probe line arrived ' +
                (ctx.ws.stream('stdout').toString('utf8').split(pad).length - 1) + ' of 4 times');
            await delay(400);
            const emitted = ctx.sandbox.chunkRecords('fake').filter((record) => record.pid === launched.pid);
            assert(emitted.length > 0, 'L1.LOG.CHUNK-LOG-EMPTY',
                'the stand-in recorded no emitted-chunk list for pid ' + launched.pid + ' in ' +
                ctx.sandbox.session.chunkLog);
            const want = Buffer.concat(emitted.filter((record) => record.stream === 'stdout')
                .map((record) => Buffer.from(record.bytesBase64, 'base64')));
            const got = ctx.ws.stream('stdout');
            assert(want.equals(got), 'L1.LOG.CHUNK-BYTES-EQUAL',
                'the socket.io client did not receive the byte stream the stand-in emitted:' +
                diffText(want, got, ctx.sandbox.session.chunkLog));
            const payloads = ctx.ws.events.filter((entry) => entry.event === 'log-stream');
            assert(payloads.some((entry) => entry.bytes.indexOf(0x0a) < 0), 'L1.LOG.NO-LINE-SPLITTING',
                'every log-stream payload was a whole line — server.js forwards raw pipe chunks, so a' +
                ' chunk with no newline has to reach the client');
            assert(payloads.some((entry) => {
                const text = entry.bytes.toString('utf8');
                return text !== text.trim() && /\s{3,}/.test(text);
            }), 'L1.LOG.NO-TRIM',
                'no payload carried whitespace at an edge, so a .trim() somewhere in the forward path' +
                ' would have been invisible in this run');
            assert(got.toString('utf8').includes(pad), 'L1.LOG.PADDED-LINE-INTACT',
                'the padded probe line did not arrive verbatim (3 leading + 3 trailing spaces)');
            return payloads.length + ' payloads vs ' + emitted.length + ' recorded writes;' +
                ' ' + got.length + ' bytes byte-identical';
        });

        await ctx.check('L1.STOP.SIGTERM-THEN-SIGKILL', 'contract', async () => {
            // server.js arms SIGTERM, then SIGKILL one second later on the module-level
            // runningProcess. --parity-slow-exit keeps a POSIX child alive through the graceful
            // path so the deferred SIGKILL is what ends it. On win32 node's kill() is
            // TerminateProcess and no handler runs, so the recorded truth there is an immediate
            // exit reported as code null (fixtures/ws/J3-start-stop/manager.stdout.log).
            await ctx.stopChild();
            const child = await ctx.launch({ parityChunks: '0', slowExitMs: 5000 });
            assert(processAlive(child.pid), 'L1.STOP.CHILD-ALIVE', 'the child ' + child.pid + ' was never alive');
            const stopped = await ctx.post('/stop');
            assert(stopped.status === 200, 'L1.STOP.SLOW-STATUS', 'POST /stop returned ' + stopped.status);
            const gone = await waitFor('the child dies inside the stop window', 6000, () => !processAlive(child.pid));
            assert(gone, 'L1.STOP.CHILD-SURVIVED',
                'pid ' + child.pid + ' was still alive 6 s after POST /stop; server.js guarantees SIGTERM' +
                ' followed by SIGKILL one second later');
            const settled = await ctx.waitForRunning(false, 10000);
            assert(settled, 'L1.STOP.STATUS-AFTER-SLOW', '/status never returned to running:false');
            if (process.platform !== 'win32') {
                return 'child ' + child.pid + ' terminated inside the stop window (POSIX: SIGKILL after 1 s)';
            }
            const text = ctx.sandbox.sessionText();
            assert(/Server process exited with code null/.test(text), 'L1.STOP.EXIT-CODE-NULL',
                'the manager never logged "Server process exited with code null" for the killed child;' +
                ' on win32 SIGTERM is TerminateProcess and the recorded manager stdout says code null' +
                '\n      fixture: fixtures/ws/J3-start-stop/manager.stdout.log');
            return 'child ' + child.pid + ' terminated inside the stop window; manager logged code null (win32)';
        });

        await ctx.check('L1.STOP.STALE-TIMER-WINDOW', 'Q24', async () => {
            // Q24: /stop arms SIGTERM, then SIGKILL one second later, on the MODULE-LEVEL
            // runningProcess — and the dying child's close handler writes null to that same
            // variable, exactly as in fixtures/http/J3d-restart/restart-settle.json. The recorded
            // win32 outcome of relaunching inside the window (probe at parity-baseline, 3/3) is that
            // the new child is NOT the one the timer kills: /status settles running:false and POST
            // /stop can no longer reach it. Every group here avoids the window with 1.5 s of quiet
            // after a stop; the window itself is pinned here.
            await ctx.stopChild();
            const before = await ctx.launch({ parityChunks: '0' });
            const stop = await ctx.post('/stop');
            const relaunched = await ctx.launchRaw({ parityChunks: '0' });
            const gapMs = relaunched.startedAt - stop.at;
            assert(gapMs < 1000, 'L1.STOP.STALE-TIMER-GAP',
                'the relaunch landed ' + gapMs + ' ms after /stop, outside the 1 s window the recorded' +
                ' behaviour depends on, so this run says nothing about Q24');
            assert(before.pid !== relaunched.pid, 'L1.STOP.STALE-TIMER-NEW-CHILD',
                'the relaunch did not produce a new child pid: ' + before.pid + ' -> ' + relaunched.pid);
            const settled = await ctx.waitForRunning(false, 6000);
            assert(settled, 'L1.STOP.STALE-TIMER-SETTLE',
                "/status stayed running:true after a relaunch inside the window; the recorded legacy " +
                'behaviour is that the dying child close handler clears the shared variable');
            const unreachable = await ctx.post('/stop');
            assert(unreachable.status === 200 &&
                JSON.parse(unreachable.raw.toString('utf8')).success === false,
                'L1.STOP.STALE-TIMER-UNREACHABLE',
                'POST /stop after the windowed relaunch returned ' + unreachable.raw.toString('utf8') +
                '; the recorded answer is 200 success:false because runningProcess is null');
            const orphaned = processAlive(relaunched.pid);
            if (orphaned) {
                // Unreachable over HTTP, so reap it here instead of letting it hold the port into
                // the next check — the same sweep capture-legacy.js performs per session.
                require('child_process').spawnSync('cmd.exe',
                    ['/c', 'taskkill', '/F', '/PID', String(relaunched.pid)], { stdio: 'ignore' });
            }
            await ctx.quietAfterStop();
            return 'relaunch ' + relaunched.pid + ' ' + gapMs + ' ms into the window: /status settled'
                + ' false, /stop 200 success:false, child ' +
                (orphaned ? 'survived with its handle lost' : 'was killed by the stale timer') +
                ' — recorded on ' + process.platform;
        });

        await ctx.check('L1.START.EXIT-CODE-PATH', 'contract', async () => {
            await ctx.stopChild();
            ctx.ws.events.length = 0;
            const child = await ctx.launch({ parityChunks: '0', exitCode: 3, port: 17839,
                model: plainModel(ctx) });
            const ended = await waitFor('server-ended after the child exited', 25000,
                () => ctx.ws.count('server-ended') > 0);
            assert(ended, 'L1.EXIT-CODE.NO-ENDED', 'the child exit produced no server-ended event');
            await ctx.waitForRunning(false, 15000);
            const golden = fixtureBytes('http/J3b-exit-code/start.response');
            assert(golden.length > 0, 'L1.EXIT-CODE.GOLDEN',
                'fixtures/http/J3b-exit-code/start.response is empty');
            const text = ctx.sandbox.sessionText();
            assert(/Server process exited with code 3/.test(text), 'L1.EXIT-CODE.LOGGED',
                'the manager did not log the child exit code 3 (the recording does); tail: ' +
                JSON.stringify(text.slice(-240)));
            return 'child ' + child.pid + ' exited 3, server-ended delivered, exit code logged';
        });

        await ctx.check('L1.START.EXIT-CODE-ARGV-GOLDEN', 'contract', async () => {
            const golden = fixtureBytes('argv/J3b-exit-code/launch.jsonl').toString('utf8')
                .split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
            const live = ctx.sandbox.argvLines().map((line) => JSON.parse(line));
            const ours = live.slice(-golden.length);
            golden.forEach((want, index) => {
                const got = ours[index];
                assert(got && JSON.stringify(want.argv) === JSON.stringify(got.argv),
                    'L1.EXIT-CODE.ARGV-GOLDEN',
                    'the exit-code journey argv differs from the recorded one:\n      expected ' +
                    JSON.stringify(want.argv) + '\n      got      ' + JSON.stringify(got && got.argv) +
                    '\n      fixture: fixtures/argv/J3b-exit-code/launch.jsonl');
            });
            return golden[0].argv.length + ' args identical to fixtures/argv/J3b-exit-code/launch.jsonl';
        });

        await ctx.check('L1.GROUP.SETTLED', 'contract', async () => {
            await ctx.stopChild();
            const status = await ctx.get('/status');
            assert(status.raw.toString('utf8') === '{"running":false}', 'L1.GROUP.SETTLED',
                'the group ended with a child still registered: ' + status.raw.toString('utf8'));
            return 'no child registered at the end of the group';
        });
    }
};
