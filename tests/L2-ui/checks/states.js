'use strict';
// DOM + a11y snapshots per state, compared against fixtures/screenshots/**.render.json (the
// compared artifact behind each recorded screenshot — fixtures/COMPARISON.json rule
// "screenshot-pixels" makes the PNG informational and the .render.json the byte claim).
// Screenshots are also captured fresh, under tests/L2-ui/out/, and are NOT pixel-compared: the
// threshold gate is the Auditor's phase (plan §10.3).

const fs = require('fs');
const path = require('path');

const browser = require('../helpers/browser');
const fixtures = require('../helpers/fixtures');
const render = require('../helpers/render');

const VIEWPORTS = [{ width: 1280, height: 800 }, { width: 1920, height: 1080 }];

// The recorded states this suite can rebuild from fixtures alone: the seed is a recorded
// localStorage snapshot and the settings dialog is filled from a recorded GET /settings body.
// fixtures/screenshots/J4b-ui-presets-launch/presets-selected-1280x800 is NOT reproducible here:
// its page was seeded with a four-config state that capture-legacy authored rather than recorded,
// so its config list cannot be rebuilt from fixtures (reported, not skipped silently).
const STATES = [
    { name: 'default', seed: false, viewports: [1280, 1920] },
    { name: 'config-selected', seed: true, steps: 'select', viewports: [1280, 1920] },
    { name: 'settings-dialog', seed: true, steps: 'settings', viewports: [1280, 1920] },
    { name: 'delete-confirm', seed: true, steps: 'delete-dismiss', viewports: [1280, 1920] },
    { name: 'log-pane-1280x800', journey: 'J5-ui-log-cap', seed: true, steps: 'flood', viewports: [1280] }
];

async function applySteps(ctx, state, steps) {
    const page = state.page;
    if (steps === 'select' || steps === 'settings' || steps === 'delete-dismiss') {
        await browser.clickConfig(page, 'capture-alpha');
        await page.waitForSelector('#configList .config-item.active');
        await page.waitForTimeout(300);
    }
    if (steps === 'settings' || steps === 'delete-dismiss') {
        await page.click('#settingsBtn');
        await page.waitForSelector('dialog.settings-dialog[open]');
        await page.waitForTimeout(300);
    }
    if (steps === 'delete-dismiss') {
        await page.click('#cancelSettingsBtn');
        await page.waitForTimeout(200);
        await browser.clickConfig(page, 'capture-alpha', '.delete-btn');
        await page.waitForTimeout(400);
    }
    if (steps === 'flood') {
        // The recorded J5-ui-log-cap state is a RUNNING page: a config was loaded, the server started,
        // and the flood filled the pane to its 1000-entry cap. The fingerprint compares the pane only by
        // its claims (lineCount, timestamped entries), so the launch state is what has to match too.
        await browser.clickConfig(page, 'capture-alpha');
        await page.waitForSelector('#configList .config-item.active');
        await page.waitForTimeout(300);
        await page.waitForSelector('#launchBtn:not([disabled])');
        await page.click('#launchBtn');
        await ctx.mocks.waitFor('POST /start', 1, 5000);
        await page.waitForTimeout(300);
        await browser.floodPane(page, fixtures.logPaneClaims().repeatLine, 1203);
        await page.waitForTimeout(200);
    }
}

async function stateSnapshots(ctx) {
    const t = ctx.results;
    t.group('state-snapshots');
    const outDir = path.join(ctx.out, 'screenshots');
    fs.mkdirSync(outDir, { recursive: true });
    let compared = 0;

    for (const spec of STATES) {
        for (const width of spec.viewports) {
            const viewport = { width, height: width === 1280 ? 800 : 1080 };
            const label = spec.journey ? spec.name : spec.name + '-' + width + 'x' + viewport.height;
            const journey = spec.journey || 'J5-ui-states';
            const file = path.join(fixtures.FIXTURES, 'screenshots', journey, label + '.render.json');
            if (!fs.existsSync(file)) {
                t.fail('L2-STATE-' + label, 'recorded render.json present', file,
                    'the suite expects a recorded fingerprint for every state it rebuilds');
                continue;
            }
            const recorded = fixtures.renderArtifact(journey, label);
            const { page } = await ctx.open({
                seed: spec.seed ? fixtures.smallSeed()
                    : { configsKey: 'llamaCppConfigs', configsJson: '{}', settingsKey: 'llamaCppSettings',
                        settingsJson: null },
                viewport,
                freezeClock: true,
                // A launched state must stay launched while the fingerprint is taken: the recorded page
                // had a real server running, so its status poll answered running:true.
                statusPair: spec.steps === 'flood',
                // The recorded fingerprints were captured against capture-legacy's canned /metrics
                // body; the metric readouts are part of the compared geometry and text.
                mocks: { 'GET /metrics': JSON.stringify(fixtures.screenshotMetrics()) }
            });
            if (spec.steps) await applySteps(ctx, stateHandle(ctx, page), spec.steps);
            const shot = await browser.fingerprint(page, { png: true });
            const problems = render.compareRender(recorded, shot.artifact);
            fs.writeFileSync(path.join(outDir, label + '.render.json'), JSON.stringify(shot.artifact, null, 2));
            if (shot.png) fs.writeFileSync(path.join(outDir, label + '.png'), shot.png);
            t.eq('L2-STATE-' + label, [], problems,
                'rendered fingerprint equals ' + 'fixtures/screenshots/' + journey + '/' + label
                + '.render.json (element geometry, visibility, control state, shown text with digits'
                + ' masked, log pane reduced to its entry claims)');
            compared += 1;

            const a11y = await browser.a11y(page);
            fs.writeFileSync(path.join(outDir, label + '.a11y.json'), JSON.stringify(a11y, null, 2));
            t.eq('L2-A11Y-' + label + '-duplicate-ids', [], a11y.duplicateIds,
                'no duplicate element ids in this state');
            t.eq('L2-A11Y-' + label + '-unlabeled', [], a11y.unlabeledControls,
                'every rendered control/label/button has an accessible name (label[for] or aria-label)');
            await ctx.close();
        }
    }
    t.ok('L2-STATE-compared-count', compared >= 9,
        compared + ' recorded fingerprints compared (J4b presets-selected is not rebuildable from fixtures)');
}

function stateHandle(ctx, page) {
    return { page };
}

// Heading order across the whole form, compared with SPEC's section sequence. This is the one
// state-independent a11y/document-order claim that does not depend on a recorded snapshot.
async function headingOrder(ctx) {
    const t = ctx.results;
    t.group('state-snapshots');
    const { page } = await ctx.open({ seed: { configsKey: 'llamaCppConfigs', configsJson: '{}',
        settingsKey: 'llamaCppSettings', settingsJson: null } });
    const facts = await browser.controlFacts(page);
    const pack = fixtures.fieldManifest();
    // SPEC's `order` column is a per-field document position; the section sequence is the order in
    // which the sections' first field appears in that order.
    const ordered = pack.fields.slice().sort((a, b) => pack.value(a, 'order') - pack.value(b, 'order'));
    const specSections = [];
    for (const field of ordered) {
        const section = pack.value(field, 'section');
        if (typeof section !== 'string' || section.indexOf('none -') === 0) continue;
        if (section.indexOf('Settings dialog') === 0) continue;
        if (!specSections.includes(section)) specSections.push(section);
    }
    const renderedSections = [];
    for (const row of facts.rows.filter((control) => control.id)) {
        if (!renderedSections.includes(row.section)) renderedSections.push(row.section);
    }
    const missing = specSections.filter((section) => !renderedSections.includes(section));
    t.eq('L2-HEADINGS-spec-sections-rendered', [], missing,
        'every SPEC section that owns a rendered field appears as a heading in the document');
    const specOrder = specSections.filter((section) => renderedSections.includes(section));
    t.eq('L2-HEADINGS-order', specOrder, renderedSections,
        'the sections appear in the order SPEC orders their first field, including the create-config'
        + ' dialog section, whose dialog is open in this state');
    await ctx.close();
}

module.exports = [
    { id: 'state-snapshots', title: 'DOM + a11y snapshots per state vs recorded render.json',
        quirk: '§8 Q12', run: stateSnapshots },
    { id: 'heading-order', title: 'section/heading order vs SPEC', quirk: '—', run: headingOrder }
];
