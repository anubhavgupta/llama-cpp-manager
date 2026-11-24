'use strict';
// Browser side of the seam suite. The page is loaded from the REAL manager (express serves the
// app's own public/ from the sandbox checkout), fetch goes to the real routes, socket.io is real,
// and the binary is the compiled stand-in — this is the only layer where all three are live.
//
// The mechanics that L2 already proved (localStorage seeded through addInitScript, native dialog
// recording for Q13, the navigation counter, the 15 s default timeout) are the L2 page harness
// recipe, restated here because L2's openPage installs fetch mocks and this layer must not: the
// seam's whole point is that the requests reach the real server. What is added is the part only a
// live backend needs: waiting on /status-driven button state, and tying a UI click to the argv line
// the stand-in records for it.

const browser = require('../../L2-ui/helpers/browser');

const DEFAULT_TIMEOUT = 15000;

async function open(manager, options) {
    if (!options.browser) throw new Error('page.open needs options.browser (a Playwright Browser)');
    const context = await options.browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        reducedMotion: 'reduce'
    });
    const seed = options.seed || null;
    if (seed) {
        // Seeded once per context: the settings save ends in location.reload() (Q13) and re-seeding
        // on reload would overwrite what the page itself wrote.
        await context.addInitScript((data) => {
            if (sessionStorage.getItem('l3-seeded')) return;
            sessionStorage.setItem('l3-seeded', '1');
            if (data.configsJson) localStorage.setItem(data.configsKey, data.configsJson);
            if (data.settingsJson) localStorage.setItem(data.settingsKey, data.settingsJson);
        }, {
            configsKey: seed.configsKey || 'llamaCppConfigs',
            configsJson: seed.configsJson || null,
            settingsKey: seed.settingsKey || 'llamaCppSettings',
            settingsJson: seed.settingsJson || null
        });
    }
    const page = await context.newPage();
    // A hung selector has to surface as a red assertion in seconds, not as a 30 s stall per check.
    page.setDefaultTimeout(options.timeoutMs || DEFAULT_TIMEOUT);
    const state = { context, page, manager, dialogs: [], navigations: 0, dialogAction: 'dismiss',
        responses: [], requests: [], consoleErrors: [], pageErrors: [] };
    page.on('dialog', (dialog) => {
        state.dialogs.push({ type: dialog.type(), message: dialog.message() });
        dialog[state.dialogAction]().catch(() => {});
    });
    page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) state.navigations += 1;
    });
    page.on('response', (response) => {
        state.responses.push({ url: new URL(response.url()).pathname, status: response.status() });
    });
    // What the browser actually put on the wire. The seam claims are about bytes the page built and
    // the server then wrote, so the posted body is read here rather than reconstructed from the log
    // pane (showOutput prefixes a timestamp on the entry and keeps whatever follows it).
    page.on('request', (request) => {
        if (request.method() !== 'POST') return;
        state.requests.push({ url: new URL(request.url()).pathname, postData: request.postData() });
    });
    page.on('console', (message) => {
        if (message.type() === 'error') state.consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => state.pageErrors.push(String(error && error.message)));
    await page.goto(manager.baseUrl + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => document.fonts.status !== 'loading').catch(() => {});
    await page.waitForTimeout(options.settleMs === undefined ? 600 : options.settleMs);

    return Object.assign(state, {
        // The page's button state follows its own 5 s /status poll (plan §2 L2 cadence row), so an
        // action waits for the control it is about to use instead of clicking blind.
        async click(id) {
            await page.waitForSelector('#' + id + ':not([disabled])', { timeout: 30000 });
            await page.click('#' + id);
        },
        async waitStatus(running, timeoutMs) {
            const deadline = Date.now() + (timeoutMs || 30000);
            while (Date.now() < deadline) {
                const res = await manager.request('GET', '/status');
                if (JSON.parse(res.raw.toString('utf8')).running === running) return true;
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            throw new Error('/status never reported running=' + running);
        },
        async selectConfig(name) {
            await browser.clickConfig(page, name);
            await page.waitForSelector('#configList .config-item.active');
            await page.waitForTimeout(50);
        },
        // The most recent POST to `pathname`, parsed (null when nothing was posted yet).
        async lastPost(pathname) {
            const found = state.requests.filter((entry) => entry.url === pathname).pop();
            return found ? JSON.parse(found.postData) : null;
        },
        postsTo(pathname) {
            return state.requests.filter((entry) => entry.url === pathname).length;
        },
        async close() {
            await context.close();
        },
        // Native alert/confirm are recorded and answered (Q13); a check that has to accept a confirm
        // (deleting a config) sets this first.
        setDialogAction(action) {
            state.dialogAction = action;
        }
    });
}

// Click Launch, then prove the manager really spawned: the stand-in's argv log is the seam's ground
// truth. A config the client blocks itself (Q18 blanked modelPath, missing serverPath) alerts and
// posts nothing, which the caller asserts as the dialog text instead.
async function launch(session) {
    const manager = session.manager;
    const dialogsBefore = session.dialogs.length;
    const before = manager.argvRecords().length;
    await session.click('launchBtn');
    const record = await manager.waitForLaunch(before, 30000);
    if (!record) {
        return { spawned: false, dialogs: session.dialogs.slice(dialogsBefore), argv: null };
    }
    await session.waitStatus(true);
    return { spawned: true, dialogs: [], argv: record, linesBefore: before };
}

async function stop(session) {
    await session.click('stopBtn');
    await session.waitStatus(false);
    await session.manager.stopAndWait();
}

module.exports = { open, launch, stop, DEFAULT_TIMEOUT };
