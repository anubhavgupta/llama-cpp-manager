'use strict';
// The 41 SPEC fields against what the browser actually renders, plus the state-independent claims of
// plan §2 Phase 4 L2: defaults, min/max/step, option lists, labels, document order; the Q1 permanently
// disabled Restart button; and the Q12 asset facts (external font link kept, no service worker).
//
// Two page states, because SPEC's claims are MARKUP claims:
//  - the markup state, where /models fails so the two model dropdowns still hold the option markup
//    the page shipped with (SPEC `options` lists the markup options and marks them `optionsDynamic`);
//  - the dialog state, where the settings dialog has been built by openSettingsDialog, which is the
//    only place its two controls exist (SPEC section "Settings dialog (built by openSettingsDialog)").
// Where SPEC and the rendered page genuinely disagree, the row also goes to DISAGREEMENTS.md; the
// rendered bytes (fixtures) are the truth either way (AGENTS.md C4).

const browser = require('../helpers/browser');
const fixtures = require('../helpers/fixtures');

// A body that makes fetchModels take its failure branch: the selects keep their markup options, so
// SPEC's static option claims are comparable to what is on screen.
const MODELS_UNAVAILABLE = JSON.stringify({ success: false, error: 'L2 markup-state probe' });

const specValue = (field, attribute) => {
    const entry = field.attributes[attribute];
    return entry === undefined ? undefined : entry.value;
};

const sectionOf = (field) => String(specValue(field, 'section') || '');
const inDialog = (field) => sectionOf(field).indexOf('Settings dialog') === 0;
const hasControl = (field) => specValue(field, 'tag') !== null;

// One assertion per field, naming every attribute that disagreed. `skip` lists the attributes that are
// not comparable in this page state, with the reason carried into the assertion text.
function compareField(field, rendered, skip) {
    const problems = [];
    const at = (attribute) => specValue(field, attribute);
    if (skip === undefined) skip = [];
    if (!hasControl(field)) {
        if (rendered) {
            problems.push({ id: field.id, attribute: 'tag', spec: null, rendered: rendered.tag,
                note: 'SPEC states no control for this field, and none should be rendered' });
        }
        return problems;
    }
    if (!rendered) {
        problems.push({ id: field.id, attribute: 'present', spec: at('tag'), rendered: 'not rendered' });
        return problems;
    }
    const compare = (attribute, spec, actual) => {
        if (spec === undefined || skip.includes(attribute)) return;
        if (JSON.stringify(spec) !== JSON.stringify(actual)) {
            problems.push({ id: field.id, attribute, spec, rendered: actual });
        }
    };
    compare('tag', at('tag'), rendered.tag);
    compare('htmlType', at('htmlType'), rendered.type);
    compare('label', at('label'), rendered.label);
    compare('section', at('section'), rendered.section);
    compare('placeholder', at('placeholder'), rendered.placeholder);
    compare('min', at('min'), rendered.min);
    compare('max', at('max'), rendered.max);
    compare('step', at('step'), rendered.step);
    compare('disabledAttr', at('disabledAttr'), rendered.disabledAttr);
    if (rendered.tag === 'input' && rendered.type !== 'checkbox') {
        compare('defaultValue', at('defaultValue'), rendered.defaultValue);
    }
    if (rendered.type === 'checkbox') {
        compare('defaultChecked', at('defaultChecked'), rendered.defaultChecked);
    }
    const options = at('options');
    if (Array.isArray(options) && rendered.options) {
        compare('options', options, rendered.options.map((option) => option.value));
    }
    const defaultOption = at('defaultOption');
    if (defaultOption !== undefined && defaultOption !== null && rendered.options) {
        const selected = rendered.options.filter((option) => option.selected).map((option) => option.value);
        compare('defaultOption', [defaultOption], selected);
    }
    return problems;
}

const report = (t, id, problems, note) => {
    if (problems.length) {
        t.fail(id, problems.map((problem) => problem.attribute + '=' + JSON.stringify(problem.spec)).join(' '),
            problems.map((problem) => problem.attribute + '=' + JSON.stringify(problem.rendered)).join(' '),
            note);
    } else {
        t.ok(id, true, note + ' — agrees');
    }
};

async function fieldsCheck(ctx) {
    const t = ctx.results;
    t.group('fields');
    const pack = fixtures.fieldManifest();
    const { page } = await ctx.open({ seed: { configsKey: 'llamaCppConfigs', configsJson: '{}',
        settingsKey: 'llamaCppSettings', settingsJson: null },
    mocks: { 'GET /models': MODELS_UNAVAILABLE } });
    const facts = await browser.controlFacts(page);
    const byId = new Map(facts.rows.filter((row) => row.id).map((row) => [row.id, row]));
    const recorded = fixtures.uiFieldState('fresh');

    t.eq('L2-FIELDS-count', 41, pack.fields.length, 'SPEC/field-manifest states 41 fields');
    const mainFields = pack.fields.filter((field) => hasControl(field) && !inDialog(field));
    t.eq('L2-FIELDS-rendered-ids', mainFields.map((field) => field.id).sort(),
        [...byId.keys()].sort(),
        'the controls rendered outside the settings dialog are exactly the SPEC fields that own a control');
    t.eq('L2-FIELDS-control-count', 38, facts.count,
        'the recorded fresh page has 38 controls (fixtures/screenshots/J5-ui-states/state-notes.json)');

    for (const field of mainFields) {
        const problems = compareField(field, byId.get(field.id) || null);
        report(t, 'L2-FIELD-' + field.id, problems,
            'SPEC/field-manifest vs the rendered control (' + field.id + ')');
        ctx.disagreements('field-manifest', problems);
    }
    for (const field of pack.fields.filter((entry) => !hasControl(entry))) {
        const problems = compareField(field, byId.get(field.id) || null);
        report(t, 'L2-FIELD-' + field.id, problems,
            'SPEC states no control for ' + field.id + ' (legacy key only) and none is rendered');
        ctx.disagreements('field-manifest', problems);
    }

    // Document order: SPEC's `order` column, the live DOM, and the recorded fresh-page control order.
    const specOrder = mainFields.slice()
        .sort((a, b) => specValue(a, 'order') - specValue(b, 'order')).map((field) => field.id);
    const domOrder = facts.rows.filter((row) => row.id && byId.has(row.id)).map((row) => row.id);
    t.eq('L2-FIELDS-section-order', specOrder, domOrder,
        'sorting the SPEC fields by `order` reproduces document order');
    const recordedOrder = recorded.fields.filter((row) => row.id).map((row) => row.id);
    t.eq('L2-FIELDS-recorded-order', recordedOrder, domOrder,
        'document order equals the recorded fresh-page control order');

    const recordedValues = recorded.fields.filter((row) => row.id)
        .map((row) => ({ id: row.id, value: row.value, checked: row.checked, disabled: row.disabled }));
    // Same spelling as the recording: `value` for the non-checkboxes, `checked` for the checkboxes,
    // null for whichever the control does not have.
    const renderedValues = recordedValues.map((row) => {
        const control = byId.get(row.id);
        if (!control) return { id: row.id, missing: true };
        const checkbox = control.type === 'checkbox';
        return { id: row.id, value: checkbox ? null : control.value,
            checked: checkbox ? control.checked : null, disabled: control.disabled };
    });
    t.eq('L2-FIELDS-defaults', recordedValues, renderedValues,
        'every control holds the value the recorded fresh page held (HTML defaults)');

    // --- the settings dialog, whose two controls only exist once openSettingsDialog runs ----------
    for (const field of pack.fields.filter(inDialog)) {
        const problems = compareField(field, byId.get(field.id) || null);
        t.eq('L2-FIELD-' + field.id + '-not-in-main-form', ['present'],
            problems.map((problem) => problem.attribute), SPEC_NOT_IN_MAIN_FORM(field.id));
    }
    await page.click('#settingsBtn');
    await page.waitForSelector('dialog.settings-dialog[open]');
    const dialogFacts = await browser.controlFacts(page);
    const dialogById = new Map(dialogFacts.rows.filter((row) => row.id).map((row) => [row.id, row]));
    for (const field of pack.fields.filter(inDialog)) {
        const rendered = dialogById.get(field.id) || null;
        // Three SPEC attributes are not comparable against a rendered dialog, and the reason is
        // recorded rather than hidden:
        //  - defaultValue/defaultChecked: there is no markup to hold a default; the input is generated
        //    from the loaded settings, so the prefill is asserted against the recorded /settings body
        //    (L2-FIELD-dialog-prefill);
        //  - section: SPEC names the GROUP ("Settings dialog (built by openSettingsDialog)"), the
        //    dialog's own heading is "Settings" (asserted below);
        //  - placeholder: SPEC carries the source text "${DEFAULT_PORT}"; the rendered attribute holds
        //    the evaluated template (8080).
        // Each of those pairs is listed in DISAGREEMENTS.md instead.
        const problems = compareField(field, rendered,
            ['defaultValue', 'defaultChecked', 'section', 'placeholder']);
        report(t, 'L2-FIELD-' + field.id, problems,
            'SPEC/field-manifest vs the rendered dialog control (' + field.id + ')');
        ctx.disagreements('field-manifest', problems);
        ctx.disagreements('spec-source-text-vs-rendered-template', [
            { id: field.id, attribute: 'section', spec: specValue(field, 'section'),
                rendered: rendered ? rendered.section : null,
                note: 'SPEC names the group; the dialog heading is what the DOM holds' },
            { id: field.id, attribute: 'placeholder', spec: specValue(field, 'placeholder'),
                rendered: rendered ? rendered.placeholder : null,
                note: 'SPEC carries the source template text; the attribute holds the evaluated value' },
            { id: field.id, attribute: 'defaultValue', spec: specValue(field, 'defaultValue'),
                rendered: rendered ? rendered.defaultValue : null,
                note: 'no markup default exists: openSettingsDialog writes the loaded settings value' }
        ]);
    }
    const dialogHeading = await page.evaluate(() => {
        const heading = document.querySelector('#settingsDialog h3');
        return heading ? heading.textContent.trim() : null;
    });
    t.eq('L2-FIELDS-dialog-heading', 'Settings', dialogHeading,
        'the settings dialog heading is "Settings"; SPEC files its two fields under the group name'
        + ' "Settings dialog (built by openSettingsDialog)"');
    const settingsBody = fixtures.readFixtureJson('http', 'J1-settings', 'settings-read.response');
    const settings = settingsBody.settings;
    const prefilled = await page.evaluate(() => ({
        modelsDirectory: document.getElementById('modelsDirectory').value,
        serverPort: document.getElementById('serverPort').value
    }));
    t.eq('L2-FIELD-dialog-prefill', { modelsDirectory: settings.modelsDirectory,
        serverPort: String(settings.serverPort) }, prefilled,
        'openSettingsDialog prefills both controls from the recorded GET /settings body');
    for (const [id, value] of Object.entries(prefilled)) {
        const field = pack.byId.get(id);
        t.ok('L2-FIELD-' + id + '-prefill-documented',
            specValue(field, 'defaultValue') === null,
            'SPEC states no fixed markup default for ' + id + ' (the value attribute is a template'
            + ' literal of the loaded settings); rendered ' + JSON.stringify(value) + ' from the fixture');
    }

    // Q1: the Restart button is rendered, disabled in the markup, and the only line that would enable
    // it is commented out — so it stays disabled in every state (misc.js q1-states covers the rest).
    const restart = await page.evaluate(() => {
        const element = document.getElementById('restartBtn');
        return { exists: !!element, disabled: element.disabled,
            attribute: element.hasAttribute('disabled'), label: element.textContent.trim() };
    });
    t.eq('L2-Q1-restartBtn', { exists: true, disabled: true, attribute: true, label: 'Restart' }, restart,
        'Q1: restartBtn is rendered and disabled, and stays disabled with the settings dialog open'
        + ' (the enabling line in updateButtonStates is commented out)');

    // Q12: the external Google Fonts link stays external, and nothing registers a service worker.
    const notes = fixtures.uiStateNotes();
    const recordedFonts = notes.screenshotPages['default-1280x800'].fonts;
    const fontLinks = await page.evaluate(() => [...document.querySelectorAll('link[rel=stylesheet]')]
        .map((link) => link.href));
    // The recorded hrefs carry the legacy manager's own origin (localhost:7837); the suite serves the
    // same assets from its sandbox port, so the origin is normalised and the paths compared.
    const stripOrigin = (href) => href.replace(/^https?:\/\/[^/]+/, '');
    t.eq('L2-Q12-font-links', recordedFonts.fontLinks.map(stripOrigin), fontLinks.map(stripOrigin),
        'the stylesheets the recorded page loaded (external Google Fonts link kept, same-origin path)');
    const registrations = await page.evaluate(async () => {
        if (!('serviceWorker' in navigator)) return 'no serviceWorker API';
        const list = await navigator.serviceWorker.getRegistrations();
        return list.length;
    });
    t.eq('L2-Q12-no-service-worker', 0, registrations,
        'Q12: no service worker is registered (do not add offline support)');
    await ctx.close();
}

const SPEC_NOT_IN_MAIN_FORM = (id) => 'SPEC puts ' + id + ' in the settings dialog, so it is not a'
    + ' control of the main form until openSettingsDialog runs';

module.exports = [{ id: 'fields', title: '41 SPEC fields, defaults, options, labels, section order, Q1, Q12',
    quirk: 'Q1 Q12', run: fieldsCheck }];
