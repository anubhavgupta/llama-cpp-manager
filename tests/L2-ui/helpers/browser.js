'use strict';
// Page harness: opens the sandbox-served page with localStorage seeded from recorded bytes, a
// Playwright dialog handler that records native alert/confirm text (Q13), a main-frame navigation
// counter (the location.reload() claim), and the same DOM/log-pane fingerprint recipe that
// fixtures/screenshots/**.render.json was recorded with, so a snapshot can be compared to the
// recorded one. The recipes are copies of the ones in tools/parity/capture-legacy.js (which is
// Verifier-owned and may not be modified); they are kept identical on purpose, and helpers/render.js
// is the single place that knows the fingerprint shape.

const fixtures = require('./fixtures');
const render = require('./render');

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
// Same frozen clock capture-legacy.js used for the recorded fingerprints: the log pane's ISO
// timestamps are the nondeterministic part of the pane (§8), and freezing them is what makes the
// recorded .render.json bytes reproducible. Timers still run on the real clock.
const FROZEN_CLOCK_MS = Date.parse('2026-01-01T00:00:00.000Z');

async function openPage(browser, options) {
    const context = await browser.newContext({
        viewport: options.viewport || DEFAULT_VIEWPORT,
        deviceScaleFactor: 1,
        reducedMotion: 'reduce'
    });
    if (options.seed) {
        const seed = options.seed;
        // Seeded once per context. A check that makes the page reload (Q13) must NOT re-run the seed:
        // re-seeding on reload would overwrite what the page itself wrote.
        await context.addInitScript((data) => {
            if (sessionStorage.getItem('l2-seeded')) return;
            sessionStorage.setItem('l2-seeded', '1');
            if (data.configsJson !== null && data.configsJson !== undefined) {
                localStorage.setItem(data.configsKey, data.configsJson);
            }
            if (data.settingsJson !== null && data.settingsJson !== undefined) {
                localStorage.setItem(data.settingsKey, data.settingsJson);
            }
        }, {
            configsKey: seed.configsKey || 'llamaCppConfigs',
            configsJson: seed.configsJson,
            settingsKey: seed.settingsKey || 'llamaCppSettings',
            settingsJson: seed.settingsJson
        });
    }
    if (options.freezeClock) {
        await context.addInitScript((fixed) => {
            const RealDate = Date;
            class FrozenDate extends RealDate {
                constructor(...args) {
                    if (args.length === 0) super(fixed); else super(...args);
                }
                static now() { return fixed; }
            }
            window.Date = FrozenDate;
        }, FROZEN_CLOCK_MS);
    }
    if (options.mocks) await options.mocks.install(context);

    const page = await context.newPage();
    // A hung selector must surface as a red assertion in seconds, not as a 30 s stall per check.
    page.setDefaultTimeout(options.timeoutMs || 15000);
    const state = { context, page, dialogs: [], navigations: 0, dialogAction: 'dismiss',
        consoleErrors: [], pageErrors: [] };
    page.on('dialog', (dialog) => {
        state.dialogs.push({ type: dialog.type(), message: dialog.message() });
        dialog[state.dialogAction]().catch(() => {});
    });
    page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) state.navigations += 1;
    });
    page.on('console', (message) => {
        if (message.type() === 'error') state.consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => state.pageErrors.push(String(error && error.message)));

    if (options.clock) {
        // Fake timers, so the /status 5 s and /metrics 1 s cadences are asserted in milliseconds
        // instead of wall-clock seconds (plan §2 Phase 4 L2 row).
        await page.clock.install();
    }
    await page.goto(options.base + '/', { waitUntil: options.clock ? 'commit' : 'load' });
    if (!options.clock) {
        await page.waitForFunction(() => document.fonts.status !== 'loading').catch(() => {});
    }
    await (options.settleMs === undefined && !options.clock
        ? page.waitForTimeout(400)
        : Promise.resolve());
    return state;
}

// -------------------------------------------------------------- page reads ------------------

const fields = (page) => page.evaluate(() => [...document.querySelectorAll('input, select, textarea')]
    .map((node) => ({
        id: node.id || null,
        tag: node.tagName.toLowerCase(),
        type: node.getAttribute('type') || null,
        value: node.type === 'checkbox' ? null : node.value,
        checked: node.type === 'checkbox' ? node.checked : null,
        disabled: !!node.disabled,
        text: node.tagName === 'SELECT' ? node.options.length : null
    })));

// id -> {value, checked, disabled, tag, type}, the shape the recorded form states use.
const fieldMap = async (page) => {
    const rows = await fields(page);
    const byId = {};
    for (const row of rows) if (row.id) byId[row.id] = row;
    return { rows, byId };
};

// Every <option> value of a select, in markup order (Q18: a saved value missing here blanks).
const optionValues = (page, id) => page.$$eval('#' + id,
    (nodes) => nodes.map((node) => [...node.options].map((option) => option.value)), null).then((all) => all[0] || []);

const storage = (page) => page.evaluate(() => {
    const entries = [];
    for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        entries.push([key, localStorage.getItem(key)]);
    }
    return { order: entries.map((entry) => entry[0]), entries };
});

const storageValue = (page, key) => page.evaluate((wanted) => localStorage.getItem(wanted), key);

const pane = (page) => page.evaluate(() => {
    const element = document.getElementById('modelOutput');
    const lines = element.textContent.split('\n');
    return { elementId: element.id, lineCount: lines.length, firstLine: lines[0],
        lastLine: lines[lines.length - 1], text: element.textContent,
        scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
});

const configRows = (page) => page.$$eval('#configList .config-item', (nodes) => nodes.map((node) => ({
    name: (node.querySelector('.config-item-name') || {}).textContent || null,
    active: node.classList.contains('active'),
    hasEdit: !!node.querySelector('.config-item-btn.edit-btn'),
    hasDelete: !!node.querySelector('.config-item-btn.delete-btn')
})));

// A DOM-snapshot a11y view: every element that carries a semantic role, its accessible name, its
// label and its state, in document order. Playwright dropped page.accessibility, so the snapshot is
// built from the page itself (roles, names, labels, aria attributes, focusability).
const a11y = (page) => page.evaluate(() => {
    const name = (element) => {
        if (element.getAttribute('aria-label')) return element.getAttribute('aria-label');
        const id = element.id;
        if (id) {
            const label = document.querySelector('label[for="' + id + '"]');
            if (label) return (label.textContent || '').replace(/\s+/g, ' ').trim();
        }
        return (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    };
    const rows = [];
    for (const element of document.querySelectorAll('h1,h2,h3,h4,button,a,select,input,label,[role]')) {
        const tag = element.tagName.toLowerCase();
        const role = element.getAttribute('role') || ({ button: 'button', select: 'combobox',
            dialog: 'dialog', h3: 'heading' }[tag] || null);
        rows.push({
            tag,
            role,
            id: element.id || null,
            name: name(element),
            type: element.getAttribute('type') || null,
            disabled: !!element.disabled,
            checked: element.type === 'checkbox' ? element.checked : null,
            labelled: !!(element.getAttribute('aria-label')
                || (element.id && document.querySelector('label[for="' + element.id + '"]'))),
            labelledby: element.hasAttribute('aria-labelledby'),
            describedby: element.hasAttribute('aria-describedby'),
            visible: !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length)
        });
    }
    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
    return { count: rows.length, duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index),
        unlabeledControls: rows.filter((row) => ['input', 'select', 'button'].includes(row.tag)
            && !row.name && !row.labelled).map((row) => row.id || row.tag),
        headingTexts: [...document.querySelectorAll('h1,h2,h3')].map((h) => (h.textContent || '').replace(/\s+/g, ' ').trim()),
        rows };
});

// The fingerprint + PNG recipe of fixtures/screenshots/**.render.json, applied to this page.
async function fingerprint(page, options) {
    await page.addStyleTag({ content: 'canvas{display:none !important}'
        + '*{animation:none !important;transition:none !important;caret-color:transparent !important}' });
    await page.evaluate(async () => {
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
    });
    await page.waitForTimeout(200);
    const png = options.png ? await page.screenshot({ fullPage: true }) : null;
    const viewport = page.viewportSize();
    const dom = await page.evaluate(() => {
        const round = (value) => Math.round(value * 100) / 100;
        const elements = [...document.querySelectorAll('[id]')].map((element) => {
            const box = element.getBoundingClientRect();
            const row = { id: element.id, tag: element.tagName.toLowerCase(),
                visible: !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
                rect: [round(box.x), round(box.y), round(box.width), round(box.height)] };
            if ('value' in element) row.value = element.value;
            if ('checked' in element) row.checked = element.checked;
            if ('disabled' in element) row.disabled = element.disabled;
            const shown = (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
            row.text = element.id === 'modelOutput'
                ? '<log-pane:' + element.textContent.split('\n').length + '-entries>'
                : shown.replace(/\d/g, '<n>');
            return row;
        });
        const paneElement = document.getElementById('modelOutput');
        const entries = paneElement.textContent.split('\n');
        const atCap = entries.length === 1000;
        return { title: document.title, scrollHeight: Math.round(document.documentElement.scrollHeight),
            logPane: { lineCount: entries.length,
                startsWithTimestamp: atCap ? '<chunk-boundary>' : /^\[\d{4}-/.test(paneElement.textContent),
                anyEntryTimestamped: entries.some((entry) => /^\[\d{4}-\d{2}-\d{2}T/.test(entry)) },
            elements };
    });
    return { artifact: { viewport, focus: null, elements: dom.elements, logPane: dom.logPane,
        title: dom.title, scrollHeight: dom.scrollHeight }, png };
}

// Every form control's rendered facts, in document order: what SPEC/field-manifest.md states about
// the 41 fields is compared against this (attributes, option lists, labels, section, order) and
// against the recorded fresh-page control state in fixtures/screenshots/J5-ui-states/state-notes.json.
const controlFacts = (page) => page.evaluate(() => {
    // SPEC's `section` is the nearest preceding heading in document order ("Sampling Parameters",
    // "Draft Model Settings", the config dialog's "Create New Configuration", ...).
    const headings = [...document.querySelectorAll('h1,h2,h3,h4')];
    const sectionOf = (element) => {
        let current = null;
        for (const heading of headings) {
            if (heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) {
                current = (heading.textContent || '').replace(/\s+/g, ' ').trim();
            }
        }
        return current;
    };
    const rows = [...document.querySelectorAll('input, select, textarea')].map((element, order) => {
        const label = element.id ? document.querySelector('label[for="' + element.id + '"]') : null;
        const attribute = (name) => element.getAttribute(name);
        return {
            order,
            id: element.id || null,
            tag: element.tagName.toLowerCase(),
            type: attribute('type') || (element.tagName === 'SELECT' ? 'select' : null),
            min: attribute('min'), max: attribute('max'), step: attribute('step'),
            placeholder: attribute('placeholder'),
            disabledAttr: element.hasAttribute('disabled'),
            disabled: !!element.disabled,
            value: element.type === 'checkbox' ? null : element.value,
            // SPEC states markup DEFAULTS as DOM properties (a text input with no value attribute has
            // defaultValue ""), so the rendered side reads the property, not the attribute.
            defaultValue: element.type === 'checkbox' ? null : element.defaultValue,
            checked: element.type === 'checkbox' ? element.checked : null,
            defaultChecked: element.type === 'checkbox' ? element.defaultChecked : null,
            label: label ? (label.textContent || '').replace(/\s+/g, ' ').trim() : null,
            section: sectionOf(element),
            options: element.tagName === 'SELECT'
                ? [...element.options].map((option) => ({ value: option.value,
                    text: (option.textContent || '').trim(), selected: option.selected }))
                : null
        };
    });
    return { count: rows.length, headings: [...document.querySelectorAll('h1,h2,h3,h4')]
        .map((heading) => (heading.textContent || '').replace(/\s+/g, ' ').trim()), rows };
});

// Click the config row whose rendered name is `name` (the row index is looked up, never assumed).
async function clickConfig(page, name, inner) {
    const index = await page.$$eval('#configList .config-item .config-item-name',
        (nodes, wanted) => nodes.map((node) => node.textContent).indexOf(wanted), name);
    if (index < 0) throw new Error('config ' + JSON.stringify(name) + ' is not rendered');
    await page.click('#configList .config-item:nth-child(' + (index + 1) + ') ' + (inner || '.config-item-name'));
    return index;
}

// Replay a recorded fixtures/ws event list through the stub io(): every log-stream payload is
// re-dispatched as the exact string the page received (base64 of the recorded bytes, decoded back),
// so the log-pane claims run on recorded payload bytes rather than invented ones.
async function replayEvents(page, events, options) {
    const rows = (options && options.filter) ? events.filter(options.filter) : events;
    const payloads = rows.filter((entry) => entry.event === 'log-stream').map((entry) => ({
        type: entry.payload.type,
        data: Buffer.from(entry.payload.dataBase64, 'base64').toString('utf8')
    }));
    for (let index = 0; index < payloads.length; index += 25) {
        await page.evaluate((batch) => {
            for (const payload of batch) window.__l2io.dispatch('log-stream', payload);
        }, payloads.slice(index, index + 25));
    }
    for (const entry of rows.filter((row) => row.event !== 'log-stream')) {
        await page.evaluate((dispatch) => {
            for (const socket of window.__l2io.sockets) {
                for (const fn of (socket.__handlers[dispatch.event] || [])) fn(dispatch.payload);
            }
        }, { event: entry.event, payload: entry.payload });
    }
    return payloads.length;
}

// Flood the pane with the recorded flood line (fixtures/ws/J5-ui-log-cap/log-pane.json repeatLine)
// so the 1000-line cap is reached from recorded bytes rather than invented text.
async function floodPane(page, line, count) {
    await page.evaluate((data) => {
        for (let index = 0; index < data.count; index += 1) {
            window.__l2io.dispatch('log-stream', { type: 'stdout', data: data.line });
        }
    }, { line, count });
}

const ioState = (page) => page.evaluate(() => ({
    calls: window.__l2io.calls.length,
    sockets: window.__l2io.sockets.length,
    disconnects: window.__l2io.disconnects.length,
    handlerEvents: window.__l2io.sockets.map((socket) => Object.keys(socket.__handlers).sort())
}));

module.exports = {
    DEFAULT_VIEWPORT, FROZEN_CLOCK_MS, openPage, fields, fieldMap, optionValues, storage,
    storageValue, pane, configRows, a11y, fingerprint, clickConfig, replayEvents, floodPane,
    ioState, controlFacts, renderHelper: render, fixturesHelper: fixtures
};
