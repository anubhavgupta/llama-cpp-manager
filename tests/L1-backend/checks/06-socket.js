'use strict';

// socket.io group: the event names and payload families the server emits (SPEC/socket-contract.json),
// the raw byte forwarding through the COMPILED stand-in relay (plan.md §9 cross-stack trap 2), the
// connectedClients fan-out and cleanup, and the server-ended payload on every live client.
//
// Session: nvidia-smi stub mode 'ok'.
//
// The log-stream byte claim against fixtures/ws/J3-start-stop/events.json lives in the process
// group, which replays the recorded request body; this group drives the compiled relay instead, so
// it compares against the relay's own recorded byte blocks instead of re-deriving them.

const path = require('path');

const { assert, delay, diffText, fixtureJson, specJson, waitFor, winPath } = require('../lib/harness');

const plainModel = (ctx) => winPath(path.join(ctx.sandbox.modelsDir, 'a', 'model-a.gguf'));
const PROBE = '   fan-out probe: leading and trailing spaces kept   ';

module.exports = {
    name: 'socket',
    stubMode: 'ok',
    async run(ctx) {
        // The compiled relay, not node + the fake script: this group's claim is about the bytes the
        // relay hands the manager's child.stdout reader.
        const launch = async (count) => {
            const before = ctx.sandbox.argvLines().length;
            const res = await ctx.post('/start', {
                serverPath: winPath(ctx.sandbox.standin),
                args: [winPath(ctx.sandbox.fakeScript), '-m', plainModel(ctx), '--parity-chunks', '3',
                    '--parity-repeat-line', PROBE, '--parity-repeat-count', String(count)]
            });
            assert(res.status === 200, 'L1.SOCKET.START-STATUS',
                'POST /start returned ' + res.status + ' ' + res.raw.toString('utf8'));
            await ctx.sandbox.waitForArgvLines(before + 2, 30000);
            const lines = ctx.sandbox.argvLines().map((line) => JSON.parse(line)).slice(before);
            // The relay logs its argv first, then the relayed node child logs the same vector, so
            // the first of the pair is the relay pid whose PARITY_CHUNK_LOG blocks are source:"relay".
            return { res, relayPid: lines[0].pid, fakePid: lines[1].pid };
        };

        await ctx.check('L1.SOCKET.EVENT-FAMILIES', 'contract', async () => {
            const observer = await ctx.connectSocket('L1-fanout-1');
            const survivor = await ctx.connectSocket('L1-fanout-2');
            ctx.fanout = { observer, survivor };
            ctx.launched = await launch(3);
            const streamed = await waitFor('both clients see logs', 30000,
                () => observer.stream('stdout').length > 0 && survivor.stream('stdout').length > 0);
            assert(streamed, 'L1.SOCKET.FANOUT-BOTH',
                'the log stream did not reach both socket.io clients: ' + JSON.stringify({
                    observer: observer.stream('stdout').length, survivor: survivor.stream('stdout').length }));

            const contract = specJson('socket-contract.json');
            const declared = contract.events.map((entry) => entry.event).sort();
            const seen = [...new Set(observer.events.map((entry) => entry.event))].sort();
            for (const name of seen) {
                assert(declared.includes(name), 'L1.SOCKET.EVENT-UNKNOWN',
                    'the server emitted an event name SPEC/socket-contract.json does not declare: ' +
                    name + ' (declared set ' + JSON.stringify(declared) + ')');
            }
            for (const entry of observer.events) {
                const row = contract.events.find((candidate) => candidate.event === entry.event);
                const declaredKeys = row && row.payloadKeys && row.payloadKeys.value;
                if (!Array.isArray(declaredKeys) || !entry.wireKeys) continue;
                assert(JSON.stringify(entry.wireKeys) === JSON.stringify([...declaredKeys].sort()),
                    'L1.SOCKET.PAYLOAD-FAMILY-' + entry.event,
                    entry.event + ' payload keys are ' + JSON.stringify(entry.wireKeys) + ', the socket' +
                    ' contract declares ' + JSON.stringify([...declaredKeys].sort()) +
                    '\n      spec: SPEC/socket-contract.json');
            }
            assert(seen.includes('log-stream'), 'L1.SOCKET.EVENT-LOG-STREAM',
                'no log-stream event on a running child; events were ' + JSON.stringify(seen));
            return 'events ' + JSON.stringify(seen) + ', every payload key set == SPEC/socket-contract.json';
        });

        await ctx.check('L1.SOCKET.RELAY-BYTES-IDENTICAL', 'contract', async () => {
            // §9 cross-stack trap 2: one event per stdout chunk, forwarded verbatim. The relay
            // records the byte blocks it writes to its own stdout (PARITY_CHUNK_LOG,
            // source:"relay"); that IS the stream server.js reads. The client's reassembled bytes
            // must equal them exactly — a line split, a re-join or a .trim() shows up as a diff.
            const { observer } = ctx.fanout;
            const done = await waitFor('the relay delivers the probe line', 30000,
                () => observer.stream('stdout').toString('utf8').split(PROBE).length - 1 >= 3);
            assert(done, 'L1.SOCKET.RELAY-STREAM',
                'the relay never delivered the probe line three times: ' +
                JSON.stringify(observer.stream('stdout').toString('utf8').slice(-160)));
            await delay(400);
            const relay = ctx.sandbox.chunkRecords('relay').filter((r) => r.pid === ctx.launched.relayPid);
            assert(relay.length > 0, 'L1.SOCKET.RELAY-LOG-EMPTY',
                'the compiled stand-in recorded no relayed byte blocks for pid ' + ctx.launched.relayPid +
                ' in ' + ctx.sandbox.session.chunkLog);
            const want = Buffer.concat(relay.filter((record) => record.stream === 'stdout')
                .map((record) => Buffer.from(record.bytesBase64, 'base64')));
            const got = observer.stream('stdout');
            assert(want.equals(got), 'L1.SOCKET.RELAY-BYTES-IDENTICAL',
                'the socket.io client did not receive the exact byte stream the relay forwarded:' +
                diffText(want, got, ctx.sandbox.session.chunkLog));
            const payloads = observer.events.filter((entry) => entry.event === 'log-stream');
            assert(payloads.some((entry) => entry.bytes.indexOf(0x0a) < 0), 'L1.SOCKET.RELAY-NO-SPLIT',
                'every payload was a whole line, so a line-splitting forward path would be invisible');
            assert(payloads.some((entry) => {
                const text = entry.bytes.toString('utf8');
                return text !== text.trim() && /\s{3,}/.test(text);
            }), 'L1.SOCKET.RELAY-NO-TRIM',
                'no payload carried whitespace at an edge, so a .trim() in the forward path would have' +
                ' been invisible in this run');
            assert(got.toString('utf8').includes(PROBE), 'L1.SOCKET.RELAY-PAD-INTACT',
                'the padded probe line did not arrive verbatim through the relay');
            return payloads.length + ' payloads vs ' + relay.length + ' relayed blocks;' +
                ' ' + got.length + ' bytes byte-identical';
        });

        await ctx.check('L1.SOCKET.SERVER-ENDED-ON-EVERY-CLIENT', 'contract', async () => {
            const { observer, survivor } = ctx.fanout;
            const res = await ctx.post('/stop');
            assert(res.status === 200, 'L1.SOCKET.STOP-STATUS', 'POST /stop returned ' + res.status);
            const ended = await waitFor('both clients see server-ended', 15000,
                () => observer.count('server-ended') > 0 && survivor.count('server-ended') > 0);
            assert(ended, 'L1.SOCKET.SERVER-ENDED-BOTH',
                'server-ended did not reach every connected client: ' + JSON.stringify({
                    observer: observer.events.map((entry) => entry.event),
                    survivor: survivor.events.map((entry) => entry.event) }));
            const golden = fixtureJson('ws/J3-start-stop/events.json').events
                .find((entry) => entry.event === 'server-ended');
            const ours = observer.events.find((entry) => entry.event === 'server-ended');
            assert(JSON.stringify(ours.payload) === JSON.stringify(golden.payload),
                'L1.SOCKET.SERVER-ENDED-PAYLOAD',
                'server-ended payload ' + JSON.stringify(ours.payload) + ' != recorded ' +
                JSON.stringify(golden.payload) + '\n      fixture: fixtures/ws/J3-start-stop/events.json');
            await ctx.waitForRunning(false);
            return 'both clients got server-ended ' + JSON.stringify(ours.payload);
        });

        await ctx.check('L1.SOCKET.CONNECTED-CLIENTS-CLEANUP', 'contract', async () => {
            // Two clients connected, one disconnects, and the next /start log line must reach the
            // survivor only. The 1.5 s quiet is the Q24 window, not a wait to make logs arrive.
            await ctx.quietAfterStop();
            const { observer, survivor } = ctx.fanout;
            const survivorMark = survivor.stream('stdout').length;
            const observerMark = observer.events.length;
            await observer.close();
            await delay(500);
            const relaunched = await launch(3);
            ctx.launched = relaunched;
            // A payload is one forwarded chunk, so the probe text can straddle two of them; the
            // claim is about the reassembled stream from the mark onwards.
            const reached = await waitFor('the survivor sees the new logs', 30000, () =>
                survivor.stream('stdout').slice(survivorMark).toString('utf8').includes('fan-out probe'));
            const since = survivor.stream('stdout').slice(survivorMark).toString('utf8');
            assert(reached, 'L1.SOCKET.CLEANUP-SURVIVOR',
                'the surviving client stopped receiving the fan-out after the other one disconnected;'
                + ' it received ' + since.length + ' new bytes starting '
                + JSON.stringify(since.slice(0, 120)));
            assert(observer.socket.disconnected, 'L1.SOCKET.CLEANUP-CLOSED',
                'the disconnected client is somehow connected again');
            await delay(500);
            const deadGotLogs = observer.events.slice(observerMark)
                .some((entry) => entry.event === 'log-stream');
            assert(!deadGotLogs, 'L1.SOCKET.CLEANUP-DEAD-SILENT',
                'the disconnected client received a log-stream event, so the fan-out set is not keyed' +
                ' off live sockets');
            return 'fan-out reached the survivor only (' +
                survivor.events.slice(survivorMark).filter((e) => e.event === 'log-stream').length +
                ' payloads), the disconnected client received 0';
        });

        await ctx.check('L1.SOCKET.DISCONNECT-REMOVES-CLIENT', 'contract', async () => {
            // And the array really shrank rather than the manager emitting into a dead socket: after
            // every earlier client is gone, a freshly connected client is still served.
            await ctx.post('/stop');
            await ctx.waitForRunning(false);
            await ctx.quietAfterStop();
            for (const socket of ctx.sockets) { try { socket.socket.close(); } catch (error) { /* gone */ } }
            ctx.sockets.length = 0;
            const fresh = await ctx.connectSocket('L1-after-cleanup');
            const relaunched = await launch(2);
            ctx.launched = relaunched;
            const got = await waitFor('the new client receives logs', 30000,
                () => fresh.stream('stdout').toString('utf8').includes('fan-out probe'));
            assert(got, 'L1.SOCKET.CLEANUP-PROBE',
                'a client connected after every earlier disconnect received no log stream, so' +
                ' connectedClients is not being cleaned up');
            const control = fixtureJson('ws/J3-start-stop/events.json').events
                .find((entry) => entry.event === 'server-ended');
            await ctx.post('/stop');
            await ctx.waitForRunning(false);
            const ended = await waitFor('server-ended on the fresh client', 15000,
                () => fresh.count('server-ended') > 0);
            assert(ended, 'L1.SOCKET.CLEANUP-ENDED',
                'the fresh client never received server-ended; events ' +
                JSON.stringify(fresh.events.map((entry) => entry.event)));
            assert(JSON.stringify(fresh.events.find((e) => e.event === 'server-ended').payload) ===
                JSON.stringify(control.payload), 'L1.SOCKET.CLEANUP-ENDED-PAYLOAD',
                'server-ended payload after cleanup differs from the recorded one');
            await fresh.close();
            return 'a client connected after the cleanup is served and gets ' +
                JSON.stringify(control.payload);
        });

        // `server-error` has exactly one emit site per launch route in the oracle — server.js:317 on
        // POST /start, :477 on POST /restart, :642 on POST /launch-presets — inside the spawned child's
        // 'error' handler. No frame under fixtures/ws carries it, because every recorded legacy launch
        // spawns successfully; SPEC/socket-contract.json lists the event but nothing pinned it. This
        // check drives the one state that reaches that handler — a serverPath the OS cannot spawn — so a
        // candidate that drops the emit, or answers the failure with an HTTP error the oracle does not
        // send, goes red.
        await ctx.check('L1.SOCKET.SERVER-ERROR-UNSPAWNABLE-PATH', 'contract', async () => {
            const client = await ctx.connectSocket('L1-server-error');
            const missing = winPath(path.join(ctx.sandbox.app, 'no-such-llama-server.exe'));
            const res = await ctx.post('/start', { serverPath: missing, args: ['-m', 'x.gguf'] });
            // The oracle answers /start before the spawn reports anything, so a failed spawn still
            // answers 200 with success:true; the failure is only ever visible on the socket.
            assert(res.status === 200, 'L1.SOCKET.SERVER-ERROR-STATUS',
                'POST /start with an unspawnable serverPath returned ' + res.status + ', the oracle sends'
                + ' 200 because spawn() reports failure asynchronously: ' + res.raw.toString('utf8'));
            assert(JSON.parse(res.raw.toString('utf8')).success === true,
                'L1.SOCKET.SERVER-ERROR-RESPONSE',
                'the /start body reports ' + res.raw.toString('utf8') + ', the oracle body says'
                + ' success:true');
            const got = await waitFor('the spawn failure reaches the socket', 15000,
                () => client.count('server-error') > 0);
            assert(got, 'L1.SOCKET.SERVER-ERROR-EMITTED',
                'no server-error frame after spawning ' + missing + '; events were '
                + JSON.stringify(client.events.map((entry) => entry.event)));
            const payload = client.events.find((entry) => entry.event === 'server-error').payload;
            assert(typeof payload.message === 'string'
                && payload.message.indexOf('Failed to start server: ') === 0,
                'L1.SOCKET.SERVER-ERROR-PAYLOAD',
                'server-error payload is ' + JSON.stringify(payload) + ', the oracle emits '
                + '{"message":"Failed to start server: " + error.message}');
            const cleared = await ctx.waitForRunning(false);
            assert(cleared, 'L1.SOCKET.SERVER-ERROR-STATE-CLEARED',
                'GET /status still reports running:true after the spawn failed, so the handler did not'
                + ' clear runningProcess');
            await client.close();
            return 'unspawnable serverPath: ' + res.status + ' success:true on HTTP, socket got '
                + JSON.stringify(payload) + ', /status back to running:false';
        });
    }
};
