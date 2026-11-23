'use strict';
// Conditional UI (plan §2 Phase 4 L2 row): ctkEnable gating of the two cache-type dropdowns, the
// draft-model section and specDraftNMaxGroup visibility driven by speculationType, and the KVarN
// beellama.cpp warning under each cache-type dropdown.

const browser = require('../helpers/browser');

// The warning markup legacy writes when a dropdown value starts with 'kvarn'. Provenance: the
// KVARN_WARNING_HTML constant in parity-baseline public/script.js (tie-break step 2, static read of
// the oracle); no fixture recorded this state, and the text is asserted as one exact string.
const KVARN_WARNING = 'KVarN cache types are only supported by <a href="https://github.com/Anbeeld/beellama.cpp"'
    + ' target="_blank" rel="noopener">beellama.cpp</a>, not standard llama.cpp.';

const CACHE_TYPES = ['contextTokenKey', 'contextTokenValue', 'ctkd', 'ctvd'];

const visibility = (page, id) => page.evaluate((elementId) => {
    const element = document.getElementById(elementId);
    if (!element) return { id: elementId, missing: true };
    const style = getComputedStyle(element);
    return { id: elementId, display: style.display,
        inline: element.style.display || null,
        visible: !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length) };
}, id);

async function conditionalCheck(ctx) {
    const t = ctx.results;
    t.group('conditional-ui');
    const { page } = await ctx.open({ seed: { configsKey: 'llamaCppConfigs', configsJson: '{}',
        settingsKey: 'llamaCppSettings', settingsJson: null } });

    // --- ctkEnable gating --------------------------------------------------------------------
    const gating = async (state) => {
        const facts = await browser.controlFacts(page);
        const enabled = facts.rows.find((row) => row.id === 'ctkEnable').checked;
        for (const id of CACHE_TYPES.slice(0, 2)) {
            const row = facts.rows.find((control) => control.id === id);
            t.eq('L2-CTK-' + id + '-disabled-' + state, !enabled, row.disabled,
                'contextToken dropdown disabled follows ctkEnable (state ' + state + ')');
            t.eq('L2-CTK-' + id + '-attr-' + state, !enabled, row.disabledAttr,
                'the disabled ATTRIBUTE tracks it too (setAttribute/removeAttribute, not .disabled)');
        }
        return facts;
    };
    await gating('fresh');
    await page.click('#ctkEnable');
    await gating('checked');
    await page.click('#ctkEnable');
    await gating('unchecked');

    // A loaded config also re-syncs the gating (loadConfiguration calls
    // updateContextTokenEnableState), so seed a config with ctkEnable true and select it.
    await ctx.close();
    const seeded = JSON.stringify({ 'l2-ctk': { ctkEnable: true, contextTokenKey: 'q8_0',
        contextTokenValue: 'q8_0' } });
    const second = await ctx.open({ seed: { configsKey: 'llamaCppConfigs', configsJson: seeded,
        settingsKey: 'llamaCppSettings', settingsJson: null } });
    await browser.clickConfig(second.page, 'l2-ctk');
    await second.page.waitForSelector('#configList .config-item.active');
    const loadedFacts = await browser.controlFacts(second.page);
    t.eq('L2-CTK-load-enabled', [false, false],
        CACHE_TYPES.slice(0, 2).map((id) => loadedFacts.rows.find((row) => row.id === id).disabled),
        'loading a config with ctkEnable:true enables both cache-type dropdowns');

    // --- speculationType: draft section + specDraftNMaxGroup ---------------------------------
    const expected = {
        none: { draft: 'none', nmax: 'none' },
        'draft-mtp': { draft: 'none', nmax: 'block' },
        'draft-dflash': { draft: 'block', nmax: 'block' },
        'draft-dspark': { draft: 'block', nmax: 'block' }
    };
    for (const [value, want] of Object.entries(expected)) {
        await second.page.selectOption('#speculationType', value);
        const draft = await visibility(second.page, 'draftModelSection');
        const nmax = await visibility(second.page, 'specDraftNMaxGroup');
        t.eq('L2-SPEC-' + value + '-draftModelSection', want.draft, draft.inline,
            'draftModelSection inline display for speculationType=' + value);
        t.eq('L2-SPEC-' + value + '-specDraftNMaxGroup', want.nmax, nmax.inline,
            'specDraftNMaxGroup inline display for speculationType=' + value);
        t.eq('L2-SPEC-' + value + '-draft-visible', want.draft === 'block', draft.visible,
            'draftModelSection is actually shown only for draft-dflash/draft-dspark');
    }
    // ngramMod also feeds updateDraftModelVisibility (it is a listener), but only speculationType
    // decides the two visibilities: toggling ngramMod alone must not change either one.
    await second.page.selectOption('#speculationType', 'none');
    await second.page.click('#ngramMod');
    t.eq('L2-SPEC-ngramMod-does-not-show-draft', 'none',
        (await visibility(second.page, 'draftModelSection')).inline,
        'ngramMod alone does not reveal the draft section');
    t.eq('L2-SPEC-ngramMod-does-not-show-nmax', 'none',
        (await visibility(second.page, 'specDraftNMaxGroup')).inline,
        'ngramMod alone does not reveal specDraftNMaxGroup');

    // --- KVarN warnings ----------------------------------------------------------------------
    const warnings = async () => second.page.evaluate((ids) => ids.map((id) => {
        const select = document.getElementById(id);
        const warning = select.parentElement.querySelector('.kvarn-warning');
        return { id, value: select.value, exists: !!warning,
            display: warning ? warning.style.display || null : null,
            html: warning ? warning.innerHTML : null };
    }), CACHE_TYPES);

    const initial = await warnings();
    t.eq('L2-KVARN-initial-hidden', initial.map((row) => [row.id, 'none']),
        initial.map((row) => [row.id, row.display]),
        'no cache-type dropdown starts on a kvarn value, so every warning is display:none');
    t.eq('L2-KVARN-all-present', 4, initial.filter((row) => row.exists).length,
        'each of the four dropdowns has its own .kvarn-warning element');

    for (const id of CACHE_TYPES) {
        await second.page.selectOption('#' + id, 'kvarn5');
        const row = (await warnings()).find((entry) => entry.id === id);
        t.eq('L2-KVARN-' + id + '-shown', 'block', row.display,
            'selecting a kvarn value reveals the warning under ' + id);
        t.eq('L2-KVARN-' + id + '-text', KVARN_WARNING, row.html,
            'warning text is the beellama.cpp notice, unchanged (parity-baseline script.js)');
        await second.page.selectOption('#' + id, 'f16');
        const cleared = (await warnings()).find((entry) => entry.id === id);
        t.eq('L2-KVARN-' + id + '-hidden-again', 'none', cleared.display,
            'leaving the kvarn value hides the warning again');
    }
    // A change on ANY of the four re-syncs all four (refreshKvarnWarnings is bound per select).
    await second.page.selectOption('#ctkd', 'kvarn8');
    await second.page.selectOption('#ctkd', 'bf16');
    const afterSwitch = await warnings();
    t.eq('L2-KVARN-resync-all', afterSwitch.map((row) => [row.id, 'none']),
        afterSwitch.map((row) => [row.id, row.display]),
        'switching a dropdown back clears every warning');

    // Loading a config with a kvarn value shows the warnings without a change event (loadConfiguration
    // calls refreshKvarnWarnings).
    await ctx.close();
    const kvarnSeed = JSON.stringify({ 'l2-kvarn': { ctkd: 'kvarn2', ctvd: 'kvarn3' } });
    const third = await ctx.open({ seed: { configsKey: 'llamaCppConfigs', configsJson: kvarnSeed,
        settingsKey: 'llamaCppSettings', settingsJson: null } });
    await browser.clickConfig(third.page, 'l2-kvarn');
    await third.page.waitForSelector('#configList .config-item.active');
    const loadedWarnings = await third.page.evaluate((ids) => ids.map((id) => {
        const select = document.getElementById(id);
        const warning = select.parentElement.querySelector('.kvarn-warning');
        return { id, value: select.value, display: warning ? warning.style.display || null : null };
    }), CACHE_TYPES);
    t.eq('L2-KVARN-on-load', [['contextTokenKey', 'none'], ['contextTokenValue', 'none'],
        ['ctkd', 'block'], ['ctvd', 'block']],
    loadedWarnings.map((row) => [row.id, row.display]),
    'loadConfiguration re-syncs the KVarN warnings to the loaded values');
    await ctx.close();
}

module.exports = [{ id: 'conditional-ui', title: 'ctkEnable gating, draft section, specDraftNMaxGroup, KVarN warnings',
    quirk: '—', run: conditionalCheck }];
