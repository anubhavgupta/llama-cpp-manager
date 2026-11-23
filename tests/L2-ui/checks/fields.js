'use strict';
// The 41 SPEC fields against what the browser actually renders, plus the state-independent claims
// of plan §2 Phase 4 L2: defaults, min/max/step, option lists, labels, section order; the Q1
// permanently disabled Restart button; and the Q12 asset facts (external font link kept, no
// service worker). Where SPEC and the rendered page disagree, the disagreement is reported in
// DISAGREEMENTS.md and the recorded DOM truth (fixtures) is what the suite asserts.

const browser = require('../helpers/browser');
const fixtures = require('../helpers/fixtures');

const DIALOG_ONLY = ['modelsDirectory', 'serverPort'];
const NO_CONTROL = ['disableReasoning'];

// SPEC's value for an attribute, or undefined when the pack does not state one.
const specValue = (field, attribute) => {
    const entry = field.attributes[attribute];
    return entry === undefined ? undefined : entry.value;
};

function compareField(t, field, rendered, problems) {
    const id = field.id;
    const at = (attribute) => specValue(field, attribute);
    const tag = at('tag');
    if (tag === null) {
        problems.push({ id, attribute: 'tag', spec: null, rendered: rendered ? rendered.tag : null,
            note: 'SPEC states no control for this field (id ' + id + ')' });
        return;
    }
    if (!rendered) {
        problems.push({ id, attribute: 'present', spec: tag, rendered: 'not rendered' });
        return;
    }
    const compare = (attribute, spec, actual) => {
        if (spec === undefined) return;
        if (JSON.stringify(spec) !== JSON.stringify(actual)) {
            problems.push({ id, attribute, spec, rendered: actual });
        }
    };
    compare('tag', tag, rendered.tag);
    compare('htmlType', at('htmlType'), rendered.type);
    compare('label', at('label'), rendered.label);
    compare('section', at('section'), rendered.section);
    compare('placeholder', at('placeholder'), rendered.placeholder);
    compare('min', at('min'), rendered.min === null ? null : rendered.min);
    compare('max', at('max'), rendered.max === null ? null : rendered.max);
    compare('step', at('step'), rendered.step === null ? null : rendered.step);
    compare('disabledAttr', at('disabledAttr'), rendered.disabledAttr);
    if (rendered.tag === 'input' && rendered.type !== 'checkbox') {
        compare('defaultValue', at('defaultValue'), rendered.defaultValue);
    }
    if (rendered.type === 'checkbox') {
        compare('defaultChecked', at('defaultChecked'), rendered.defaultChecked);
    }
    const options = at('options');
    if (options !== undefined && rendered.options) {
        compare('options', options, rendered.options.map((option) => option.value));
    }
    const defaultOption = at('defaultOption');
    if (defaultOption !== undefined && defaultOption !== null && rendered.options) {
        const selected = rendered.options.filter((option) => option.selected).map((option) => option.value);
        compare('defaultOption', [defaultOption], selected.length === 1 ? selected : selected[0] === undefined
            ? null : selected);
    }
}

async function fieldsCheck(ctx) {
    const t = ctx.results;
    t.group('fields');
    const pack = fixtures.fieldManifest();
    const { page } = await ctx.open({ seed: { configsKey: 'llamaCppConfigs', configsJson: '{}',
        settingsKey: 'llamaCppSettings', settingsJson: null } });
    const facts = await browser.controlFacts(page);
    const byId = new Map(facts.rows.filter((row) => row.id).map((row) => [row.id, row]));
    const recorded = fixtures.uiFieldState('fresh');

    const expectedIds = pack.fields.map((field) => field.id)
        .filter((id) => !NO_CONTROL.includes(id) && !DIALOG_ONLY.includes(id));
    t.eq('L2-FIELDS-count', 41, pack.fields.length, 'SPEC/field-manifest states 41 fields');
    t.eq('L2-FIELDS-rendered-ids', expectedIds.slice().sort(), [...byId.keys()].sort(),
        'the controls rendered on a fresh page are the SPEC fields that have a control');
    t.eq('L2-FIELDS-control-count', 38, facts.count,
        'the recorded fresh page has 38 controls (fixtures/screenshots/J5-ui-states/state-notes.json)');

    // Per field: tag / type / label / section / min / max / step / options / default / disabled.
    const disagreements = [];
    for (const field of pack.fields) {
        const rendered = byId.get(field.id) || null;
        const problems = [];
        compareField(t, field, rendered, problems);
        for (const problem of problems) {
            if (problem.attribute === 'tag' && problem.spec === null) continue;
            disagreements.push(problem);
        }
        if (problems.length) {
            t.fail('L2-FIELD-' + field.id, problems.map((problem) => problem.attribute + '='
                + JSON.stringify(problem.spec)).join(' '),
            problems.map((problem) => problem.attribute + '=' + JSON.stringify(problem.rendered)).join(' '),
            'SPEC/field-manifest disagrees with the rendered control');
        } else {
            t.ok('L2-FIELD-' + field.id, true, 'renders as SPEC states ('
                + (rendered ? rendered.tag + '/' + rendered.type : 'no control') + ')');
        }
    }

    // Section order: SPEC's `order` column against document order, and against the recorded
    // fingerprint's element order (the two must agree with each other as well as with SPEC).
    const specOrder = pack.fields.filter((field) => byId.has(field.id))
        .sort((a, b) => specValue(a, 'order') - specValue(b, 'order')).map((field) => field.id);
    const domOrder = facts.rows.filter((row) => row.id && byId.has(row.id)).map((row) => row.id);
    t.eq('L2-FIELDS-section-order', specOrder, domOrder,
        'sorting SPEC fields by `order` reproduces document order');
    const recordedOrder = recorded.fields.filter((row) => row.id).map((row) => row.id);
    t.eq('L2-FIELDS-recorded-order', recordedOrder, domOrder,
        'document order equals the recorded fresh-page control order');

    // Every rendered control's value/checked equals the recorded fresh-page state.
    const recordedValues = recorded.fields.filter((row) => row.id)
        .map((row) => ({ id: row.id, value: row.value, checked: row.checked, disabled: row.disabled }));
    const renderedValues = recordedValues.map((row) => {
        const control = byId.get(row.id);
        return control ? { id: row.id, value: control.value, checked: control.checked,
            disabled: control.disabled } : { id: row.id, missing: true };
    });
    t.eq('L2-FIELDS-defaults', recordedValues, renderedValues,
        'every control holds the value the recorded fresh page held (HTML defaults)');

    // The settings dialog fields exist only after the dialog is built (SPEC section
    // "Settings dialog (built by openSettingsDialog)").
    await page.click('#settingsBtn');
    await page.waitForSelector('dialog.settings-dialog[open]');
    const dialogFacts = await browser.controlFacts(page);
    const dialogById = new Map(dialogFacts.rows.filter((row) => row.id).map((row) => [row.id, row]));
    for (const id of DIALOG_ONLY) {
        const field = pack.byId.get(id);
        const rendered = dialogById.get(id) || null;
        const problems = [];
        compareField(t, field, rendered, problems);
        t.check('L2-FIELD-' + id, !problems.length && !!rendered,
            { tag: specValue(field, 'tag'), label: specValue(field, 'label') },
            rendered ? { tag: rendered.tag, label: rendered.label } : 'not rendered',
            problems.length ? 'SPEC disagrees with the rendered dialog control' : undefined);
    }
    t.ok('L2-FIELDS-no-control', !dialogById.has('disableReasoning'),
        'disableReasoning has no control (SPEC: read from the parsed config only, Q17)');

    // Q1: the Restart button is rendered and permanently disabled (its listener is commented out),
    // so it stays disabled in every state this check can reach. runtime.js adds the running/stopped
    // and post-delete states.
    const restart = (await browser.controlFacts(page)).rows.find((row) => row.id === 'restartBtn');
    t.eq('L2-Q1-restartBtn-disabled', true, restart.disabled,
        'Q1: restartBtn.disabled === true with the listener commented out');
    t.eq('L2-Q1-restartBtn-label', 'Restart', restart.label, 'the Restart button is rendered');
    t.eq('L2-Q1-restartBtn-disabled-in-dialog', true,
        await page.evaluate(() => document.getElementById('restartBtn').disabled),
        'Q1 holds with the settings dialog open');

    // Q12: external Google Fonts link stays external, and nothing registers a service worker.
    const notes = fixtures.uiStateNotes();
    const recordedFonts = notes.screenshotPages['default-1280x800'].fonts;
    const fontLinks = await page.evaluate(() => [...document.querySelectorAll('link[rel=stylesheet]')]
        .map((link) => link.href));
    t.eq('L2-Q12-font-links', recordedFonts.fontLinks, fontLinks,
        'the stylesheets the recorded page loaded (external Google Fonts link kept)');
    const registrations = await page.evaluate(async () => {
        if (!('serviceWorker' in navigator)) return 'no serviceWorker API';
        const list = await navigator.serviceWorker.getRegistrations();
        return list.length;
    });
    t.eq('L2-Q12-no-service-worker', 0, registrations,
        'Q12: no service worker is registered (do not add offline support)');
    await ctx.close();

    ctx.disagreements('field-manifest', disagreements);
}

module.exports = [{ id: 'fields', title: '41 SPEC fields, defaults, options, labels, section order, Q1, Q12',
    quirk: 'Q1 Q12', run: fieldsCheck }];
