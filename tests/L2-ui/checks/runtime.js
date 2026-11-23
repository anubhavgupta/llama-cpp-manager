'use strict';
// The runtime surface of the UI: the log pane (ISO entry shape, per-chunk .trim(), the 1000-line
// cap, auto-scroll) driven by byte replays of the payloads recorded in fixtures/ws/**; the socket
// control events; the /status 5 s and /metrics 1 s cadence under fake timers; the charts, the
// resize handler and the 50-point client history; native dialog text and the reload after a
// settings save (Q13); the Q1 Restart button in the states storage.js cannot reach; and the
// 200-with-success:false /start response path.

const browser = require('../helpers/browser');
const fixtures = require('../helpers/fixtures');

const ISO_ENTRY = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\]([\s\S]*)$/;
const decode = (entry) => Buffer.from(entry.payload.dataBase64, 'base64').toString('utf8');

// Same normalisation fixtures/COMPARISON.json rule "log-pane-chunks7" declares: drop the entry
// timestamps, drop whitespace, compare the character stream the pane received, in order.
const normalizeStream = (text) => text
    .replace(/\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]?/g, '')
    .replace(/\s+/g, '');

async function logPane(ctx) {
    const t = ctx.results;
    t.group('log-pane');
    const events = fixtures.wsEvents('J5-ui-log-cap', 'events');
    const claims = fixtures.chunkBoundaryClaims();
    const recorded = fixtures.logPaneClaims();
    const payloads = events.events.filter((entry) => entry.event === 'log-stream').map(decode);
    const stdout = payloads.join('');
    const sourceLines = stdout === '' ? 0 : stdout.replace(/\n$/, '').split('\n').length;
    const blankPayloads = payloads.filter((payload) => payload.trim() === '').length;

    const { page } = await ctx.open({ seed: { configsKey: 'llamaCppConfigs', configsJson: '{}',
        settingsKey: 'llamaCppSettings', settingsJson: null } });
    t.eq('L2-LOG-initial', 1, (await browser.pane(page)).lineCount,
        'a fresh page has an empty pane (one empty split element)');

    const dispatched = await browser.replayEvents(page, events.events);
    t.eq('L2-LOG-payload-count', 61, dispatched,
        'the recorded J5-ui-log-cap trace carries 61 log-stream payloads');
    const pane = await browser.pane(page);
    const entries = pane.text.split('\n');

    t.eq('L2-LOG-entry-count', payloads.length + 1, entries.length - 1,
        'one pane entry per log-stream event (the +1 is the trailing split element)');
    t.eq('L2-LOG-source-lines', claims.sourceLines, sourceLines,
        'the replayed payload bytes are the 9 source lines the recording states');
    t.eq('L2-LOG-more-entries-than-source-lines', claims.morePaneLinesThanSourceLines,
        entries.length - 1 > sourceLines,
        'chunk boundaries turn 9 source lines into many entries (plan §9 trap 2, §8 chunk boundaries)');
    t.eq('L2-LOG-blank-payloads', claims.blankPayloads, blankPayloads,
        'the trace really does carry a whitespace-only payload');
    t.eq('L2-LOG-some-payloads-whitespace-only', claims.somePayloadsAreWhitespaceOnly, blankPayloads > 0,
        'and the recorded byte-exact claim holds for the replayed bytes');

    // Per-chunk .trim(): entry i is exactly `[ISO] ` + payload i trimmed, byte for byte.
    const mismatches = [];
    for (let index = 0; index < payloads.length; index += 1) {
        const entry = entries[index];
        const match = entry.match(ISO_ENTRY);
        if (!match) {
            mismatches.push('entry ' + index + ' has no ISO prefix: ' + JSON.stringify(entry.slice(0, 40)));
            continue;
        }
        if (match[2] !== ' ' + payloads[index].trim()) {
            mismatches.push('entry ' + index + ': expected ' + JSON.stringify(payloads[index].trim())
                + ' got ' + JSON.stringify(match[2].slice(1)));
        }
    }
    t.eq('L2-LOG-per-chunk-trim', [], mismatches.slice(0, 5),
        'every entry is one trimmed payload, no re-assembly and no line splitting (Q/§9 trap 2)');
    t.eq('L2-LOG-iso-shape', true, entries.slice(0, payloads.length).every((entry) => ISO_ENTRY.test(entry)),
        'every entry starts with [ISO-8601 UTC] (plan §8: regex shape, not bytes)');
    t.eq('L2-LOG-normalized-stream', normalizeStream(payloads.map((payload) => ' ' + payload.trim()).join('\n')),
        normalizeStream(entries.slice(0, payloads.length).map((entry) => entry.replace(ISO_ENTRY, '$2')).join('\n')),
        'the concatenated character stream of the pane equals the stream of the recorded payload bytes');
    t.eq('L2-LOG-timestamps-real', true, entries[0].slice(1, 5) !== '<chun',
        'below the cap the entry prefix is a real timestamp (the masked §8 field only applies at the cap)');

    // Auto-scroll on an entry.
    const scrolled = await page.evaluate(() => {
        const element = document.getElementById('modelOutput');
        element.scrollTop = 0;
        window.__l2io.dispatch('log-stream', { type: 'stdout', data: 'auto-scroll probe' });
        return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight };
    });
    t.ok('L2-LOG-auto-scroll', scrolled.scrollTop + scrolled.clientHeight >= scrolled.scrollHeight - 2,
        'showOutput pins scrollTop to scrollHeight', JSON.stringify(scrolled));

    // The 1000-line cap, fed the recorded flood line from fixtures/ws/J5-ui-log-cap/log-pane.json.
    await browser.floodPane(page, recorded.repeatLine, 1203);
    const capped = await browser.pane(page);
    const cappedEntries = capped.text.split('\n');
    const evidence = {
        heldExactlyOneThousandEntries: capped.lineCount === 1000,
        oldestEntriesDropped: cappedEntries[0].indexOf(recorded.repeatLine) >= 0,
        trailingSplitElementEmpty: cappedEntries[cappedEntries.length - 1] === '',
        pinnedToBottom: capped.scrollTop + capped.clientHeight >= capped.scrollHeight - 2
    };
    t.eq('L2-LOG-cap', recorded.capEvidence, evidence,
        'the 1000-entry cap behaves exactly as the recording states (all four claims)');
    t.eq('L2-LOG-cap-lineCount', recorded.lineCount, capped.lineCount,
        'the pane holds exactly 1000 entries after 1203 events');
    await ctx.close();
}

async function socketEvents(ctx) {
    const t = ctx.results;
    t.group('socket-events');
    const control = fixtures.wsEvents('J3-start-stop', 'events').events
        .filter((entry) => !['log-stream'].includes(entry.event) && entry.event !== 'connect');
    const { page } = await ctx.open({ seed: { configsKey: 'llamaCppConfigs', configsJson: '{}',
        settingsKey: 'llamaCppSettings', settingsJson: null } });
    const ioBefore = await browser.ioState(page);
    t.eq('L2-SOCKET-no-early-io', 0, ioBefore.calls,
        'io() is only called after a launch succeeds, not on page load');

    // A successful /start opens the socket with the handlers the app registers (C6).
    await page.fill('#serverPath', 'C:/parity-scratch/bin/fake-llama-server.exe');
    await page.selectOption('#modelPath', fixtures.modelsPayload().models[1].path);
    await page.click('#launchBtn');
    await page.waitForTimeout(300);
    const io = await browser.ioState(page);
    t.eq('L2-SOCKET-io-called', 1, io.calls, 'launch success calls io()');
    t.eq('L2-SOCKET-handlers', [['connect', 'disconnect', 'log-stream', 'server-ended', 'server-error']],
        [io.handlerEvents.sort()], 'the app registers the five socket.io handlers it records');
    let pane = await browser.pane(page);
    t.ok('L2-SOCKET-connect-banner', pane.text.includes('Connected to server for real-time logging'),
        'the connect handler prints the recorded banner line (C6: user-visible reconnect choreography)');
    t.ok('L2-SOCKET-launch-lines', pane.text.includes('Starting server:')
        && pane.text.includes('Command arguments:'), 'launch writes its own pane entries before the socket');

    await page.evaluate(() => window.__l2io.dispatch('server-error', { message: 'boom' }));
    pane = await browser.pane(page);
    t.ok('L2-SOCKET-server-error-line', pane.text.includes('Server error: boom'),
        'the server-error handler prints its payload message');

    const ended = control.find((entry) => entry.event === 'server-ended');
    await page.evaluate((payload) => {
        for (const socket of window.__l2io.sockets) {
            for (const fn of socket.__handlers['server-ended']) fn(payload);
        }
    }, ended.payload);
    pane = await browser.pane(page);
    t.ok('L2-SOCKET-server-ended-line', pane.text.includes('Server process has ended'),
        'the recorded server-ended payload produces the recorded line');
    t.eq('L2-SOCKET-server-ended-status', 'Not running',
        await page.textContent('#modelStatusMessage'), 'server-ended drives the status readout');
    t.eq('L2-SOCKET-server-ended-buttons', { launch: false, stop: true, restart: true },
        await page.evaluate(() => ({ launch: document.getElementById('launchBtn').disabled,
            stop: document.getElementById('stopBtn').disabled,
            restart: document.getElementById('restartBtn').disabled })),
        'Q1 plus button state after the child ended (updateButtonStates(false))');

    // Stop: the app POSTs /stop, then disconnects its socket.
    await page.evaluate(() => {
        for (const socket of window.__l2io.sockets) {
            for (const fn of socket.__handlers['server-ended']) fn({ message: 'reset' });
        }
    });
    await page.fill('#serverPath', 'C:/parity-scratch/bin/fake-llama-server.exe');
    await page.click('#launchBtn');
    await page.waitForTimeout(200);
    const statusBefore = ctx.mocks.last('GET /status');
    await page.click('#stopBtn');
    await ctx.mocks.waitFor('POST /stop', 1, 3000);
    await page.waitForTimeout(200);
    const afterStop = await browser.ioState(page);
    t.eq('L2-STOP-disconnects', 1, afterStop.disconnects,
        'stopServer disconnects the log socket on success (script.js stopServer)');
    t.ok('L2-STOP-pane-line', (await browser.pane(page)).text.includes('Server stopped successfully'),
        'the stop success path prints its line');
    void statusBefore;
    await ctx.close();
}

async function startErrorPath(ctx) {
    const t = ctx.results;
    t.group('http-mock');
    const recorded = fixtures.httpBody('J3-start-stop', 'start-while-running').toString('utf8');
    const { page, mocks } = await ctx.open({ seed: { configsKey: 'llamaCppConfigs', configsJson: '{}',
        settingsKey: 'llamaCppSettings', settingsJson: null },
    mocks: { 'POST /start': recorded } });
    await page.fill('#serverPath', 'C:/parity-scratch/bin/fake-llama-server.exe');
    await page.selectOption('#modelPath', fixtures.modelsPayload().models[1].path);
    await page.click('#launchBtn');
    await page.waitForTimeout(300);
    const body = JSON.parse(recorded);
    const pane = await browser.pane(page);
    t.ok('L2-START-error-line', pane.text.includes('Error starting server: ' + body.error),
        'a 200 body with success:false prints the error instead of updating status (Q3 shape)');
    t.eq('L2-START-error-status', 'Not running', await page.textContent('#modelStatusMessage'),
        'the failed launch leaves the status readout alone');
    t.eq('L2-START-error-no-socket', 0, (await browser.ioState(page)).calls,
        'the failed launch does not open a log socket');
    t.eq('L2-MOCK-unmatched', [], mocks.violations, 'every fetch the page issued had recorded bytes to replay');
    await ctx.close();
}

async function cadence(ctx) {
    const t = ctx.results;
    t.group('cadence');
    const { page, mocks } = await ctx.open({ clock: true,
        seed: { configsKey: 'llamaCppConfigs', configsJson: '{}', settingsKey: 'llamaCppSettings',
            settingsJson: null } });
    // Let the initial fetches land with the clock held, then advance it 12 s.
    await page.clock.runFor(50);
    const seeded = await ctx.mocks.waitFor('GET /metrics', 1, 5000);
    t.ok('L2-CADENCE-initial', seeded, 'the page fetches /metrics once at startup (startMetricUpdates)');
    const before = mocks.counts();
    await page.clock.runFor(12000);
    await page.waitForTimeout(400);
    const after = mocks.counts();
    const metrics = (after['GET /metrics'] || 0) - (before['GET /metrics'] || 0);
    const status = (after['GET /status'] || 0) - (before['GET /status'] || 0);
    t.ok('L2-CADENCE-metrics-1s', metrics >= 11 && metrics <= 13,
        '/metrics polled about every 1000 ms: ' + metrics + ' polls in a 12 s fake clock window');
    t.ok('L2-CADENCE-status-5s', status >= 2 && status <= 3,
        '/status polled about every 5000 ms: ' + status + ' polls in the same window');
    t.ok('L2-CADENCE-independent', metrics > status * 2,
        'the two cadences are independent intervals, not one timer (5 s vs 1 s)');
    const gaps = [];
    let previous = null;
    for (const request of mocks.of('GET /metrics')) {
        if (previous !== null) gaps.push(request.at - previous);
        previous = request.at;
    }
    t.ok('L2-CADENCE-metrics-gaps', gaps.length >= 10,
        'the mock observed ' + gaps.length + '/metrics gaps under the fake clock');
    await ctx.close();
}

async function charts(ctx) {
    const t = ctx.results;
    t.group('charts');
    const metric = (cpu) => JSON.stringify({ cpu, ram: 20, gpu: 30, vram: 40, vramUsage: '12345/24576' });
    // 51 responses whose cpu rises 1..51, then a fresh page with 50 responses cpu 2..51. If the
    // client keeps only the last 50 points (plan §9 trap 7), the two canvases are identical.
    const draw = async (values) => {
        const opened = await ctx.open({ clock: true, seed: { configsKey: 'llamaCppConfigs',
            configsJson: '{}', settingsKey: 'llamaCppSettings', settingsJson: null } });
        ctx.mocks.routeSequence('GET /metrics', values.map(metric),
            'scripted cpu series (input; the claim is the 50-point cap, not these values)');
        const page = opened.page;
        await page.clock.runFor(50);
        await ctx.mocks.waitFor('GET /metrics', 1, 5000);
        for (let index = 1; index < values.length; index += 1) {
            await page.clock.runFor(1000);
            await ctx.mocks.waitFor('GET /metrics', index + 1, 5000);
        }
        await page.clock.runFor(200);
        const data = await page.evaluate(() => ({
            cpu: document.getElementById('cpuGraph').toDataURL(),
            readout: document.getElementById('cpuValue').textContent,
            size: [document.getElementById('cpuGraph').width, document.getElementById('cpuGraph').height]
        }));
        await ctx.close();
        return data;
    };
    const fiftyOne = await draw(Array.from({ length: 51 }, (unused, index) => index + 1));
    const lastFifty = await draw(Array.from({ length: 50 }, (unused, index) => index + 2));
    t.eq('L2-CHART-50-point-history', lastFifty.cpu, fiftyOne.cpu,
        'the canvas after 51 points equals the canvas of the last 50 points (chartData shift(), plan §9 trap 7)');
    t.eq('L2-CHART-readout-rounds', Math.round(51) + '%', fiftyOne.readout,
        'the readout is Math.round(last cpu) + "%"');
    t.ok('L2-CHART-canvas-sized', fiftyOne.size[0] > 0 && fiftyOne.size[1] > 0,
        'initCharts sizes the canvas backing store to its CSS box: ' + fiftyOne.size.join('x'));

    // Resize: handleResize re-runs initCharts after 100 ms, so the backing store follows the new box.
    const opened = await ctx.open({ seed: { configsKey: 'llamaCppConfigs', configsJson: '{}',
        settingsKey: 'llamaCppSettings', settingsJson: null } });
    const before = await opened.page.evaluate(() => [document.getElementById('cpuGraph').width,
        document.getElementById('cpuGraph').height]);
    await opened.page.setViewportSize({ width: 900, height: 700 });
    await opened.page.waitForTimeout(400);
    const after = await opened.page.evaluate(() => [document.getElementById('cpuGraph').width,
        document.getElementById('cpuGraph').height]);
    t.ok('L2-CHART-resize', after[0] !== before[0] || after[1] !== before[1],
        'resizing the window resizes the chart canvases (handleResize → initCharts): '
        + before.join('x') + ' → ' + after.join('x'));
    await ctx.close();
}

async function dialogsAndReload(ctx) {
    const t = ctx.results;
    t.group('dialogs');
    const recorded = fixtures.recordedDialogs();
    const { page, mocks, navigations } = await ctx.open({ seed: fixtures.smallSeed(),
        freezeClock: true });
    const observed = await ctx.dialogs();

    // Launch with no serverPath: the recorded alert, and no request.
    await page.click('#launchBtn');
    await page.waitForTimeout(200);
    t.eq('L2-DIALOG-serverpath-alert', [recorded.dialogs[0]], observed.slice(0, 1),
        'Q13: launching without a serverPath alerts with the recorded text');
    t.eq('L2-DIALOG-serverpath-no-request', 0, mocks.of('POST /start').length,
        'the alert path returns before fetch, so nothing is posted');

    // Settings dialog: empty directory alerts (recorded), and a save reloads the page (Q13).
    await page.click('#settingsBtn');
    await page.waitForSelector('dialog.settings-dialog[open]');
    const settingsRequest = mocks.last('GET /settings');
    t.ok('L2-DIALOG-settings-fetched', !!settingsRequest, 'the settings dialog opens from GET /settings');
    await page.fill('#modelsDirectory', '');
    const at = observed.length;
    await page.click('#saveSettingsBtn');
    await page.waitForTimeout(200);
    t.eq('L2-DIALOG-modelsdir-alert', [recorded.dialogs[1]], observed.slice(at, at + 1),
        'Q13: saving an empty models directory alerts with the recorded text');
    const navigationsBefore = navigations.count();
    await page.fill('#modelsDirectory', 'C:/parity-scratch/fixtures/models');
    await page.fill('#serverPort', '7838');
    await page.click('#saveSettingsBtn');
    await ctx.mocks.waitFor('POST /settings', 1, 5000);
    const reloaded = await ctx.waitForNavigation(navigationsBefore, 10000);
    t.ok('L2-Q13-reload-after-settings-save', reloaded,
        'Q13: location.reload() after a successful settings save (main-frame navigations '
        + navigationsBefore + ' → ' + navigations.count() + ')');
    const posted = mocks.lastJson('POST /settings');
    t.eq('L2-DIALOG-settings-post', { modelsDirectory: 'C:/parity-scratch/fixtures/models', serverPort: 7838 },
        posted, 'the settings POST body is the two dialog fields');
    t.eq('L2-DIALOG-settings-local-first', 7838,
        JSON.parse(await browser.storageValue(page, 'llamaCppSettings')).serverPort,
        'settings.serverPort is written to localStorage before the server round-trip');
    await ctx.close();
}

const checks = [
    { id: 'log-pane', title: 'log pane ISO shape, per-chunk trim, 1000-line cap, auto-scroll',
        quirk: '§8 §9 trap 2/9', run: logPane },
    { id: 'socket-events', title: 'io() handlers, server-ended/error, stop disconnect', quirk: 'C6 Q1',
        run: socketEvents },
    { id: 'start-error', title: '200 success:false /start path, unmatched fetch', quirk: 'Q3',
        run: startErrorPath },
    { id: 'cadence', title: '/status 5 s and /metrics 1 s with fake timers', quirk: '§8 cadence',
        run: cadence },
    { id: 'charts', title: 'charts, resize, 50-point client history', quirk: '§9 trap 7', run: charts },
    { id: 'dialogs', title: 'native dialog text and reload after settings save', quirk: 'Q13',
        run: dialogsAndReload }
];

module.exports = checks;
