#!/usr/bin/env node
'use strict';
// Phase 2.1 (plan.md §2 item 1): the behavior-preservation proof for the two extracted generators,
// plus the run-manifest comparator used by tools/parity/preservation-proof.sh.
//
//   --differential        prove that legacy/lib/buildArgs.js + legacy/lib/buildPresetIni.js are the
//                         inline blocks of public/script.js at parity-baseline: a STATIC identity
//                         check (the sliced original text vs the lib text, modulo the two
//                         documented substitutions) and a RUNTIME byte check (the sliced original
//                         evaluated in this process vs the lib) over recorded inputs only.
//   --write-manifest DIR  sha256 every file under DIR/fixtures -> DIR/PROOF-MANIFEST.json
//                         (capture-legacy.js writes MANIFEST.json only for unfiltered runs, and a
//                         filtered proof run is filtered on purpose: J0-baseline records index.html,
//                         which the refactor legitimately changes)
//   --compare-manifests A B
//                         compare the two file sets, then the sha256 of every file COMPARISON.json
//                         does not relax, printing a unified diff for any mismatch. Shape-mode and
//                         informational files are the comparator in capture-legacy.js --compare,
//                         which preservation-proof.sh runs next; nothing here relaxes a rule.
//
// Recorded inputs (C5 — no hand-authored vectors):
//   fixtures/screenshots/J5-ui-states/state-notes.json  the four recorded form states (every
//                                                       control's value/checked) = fields maps
//   fixtures/localstorage/**                           recorded llamaCppConfigs / llamaCppSettings
//                                                       blobs, incl. the Q8 partial-reset state
//   fixtures/corpus/configs.remapped.json              the 48 real saved configs
//   fixtures/http/**/models*.response                  recorded /models payloads (mmproj pass)
//   git show parity-baseline:public/script.js          the original inline blocks (sliced, never
//                                                       re-typed)

const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const BASELINE = 'parity-baseline';
const KINDS = ['http', 'ws', 'argv', 'ini', 'localstorage', 'screenshots'];

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const readText = (file) => fs.readFileSync(file, 'utf8');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

// ------------------------------------------------------------------ slicing -----------------

// Anchor-delimited slices so the "original" compared against the lib is the tagged source text
// itself. Uniqueness is asserted: an ambiguous anchor would silently shrink or grow a slice.
function slice(text, startAnchor, endAnchor, label, source) {
    const start = text.indexOf(startAnchor);
    assert(start >= 0, label + ': start anchor missing in ' + source);
    assert(text.indexOf(startAnchor, start + 1) < 0, label + ': start anchor is not unique in ' + source);
    const end = text.indexOf(endAnchor, start);
    assert(end > start, label + ': end anchor missing in ' + source);
    assert(text.indexOf(endAnchor, end + 1) < 0, label + ': end anchor is not unique in ' + source);
    return text.slice(start, end);
}

// Leading indentation, trailing whitespace and blank lines carry no bytes into argv or the ini, so
// they are collapsed; everything inside a line — including template-literal interiors — is compared
// exactly.
const normLines = (text) => text.split('\n').map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line !== '').join('\n');

function firstLineDiff(a, b) {
    const la = a.split('\n');
    const lb = b.split('\n');
    for (let i = 0; i < Math.max(la.length, lb.length); i += 1) {
        if (la[i] !== lb[i]) return 'first difference at normalised line ' + (i + 1) + '\n  baseline: '
            + la[i] + '\n  lib      : ' + lb[i];
    }
    return 'no line difference';
}

function baselineScript() {
    const bytes = execFileSync('git', ['show', BASELINE + ':public/script.js'],
        { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
    return bytes.toString('utf8').split('\r\n').join('\n');
}

// id -> element variable name, from the baseline file's own getElementById declarations.
function elementNameMap(source) {
    const map = new Map();
    const re = /^const (\w+) = document\.getElementById\('([^']+)'\);?$/gm;
    let match = re.exec(source);
    while (match) {
        map.set(match[2], match[1]);
        match = re.exec(source);
    }
    return map;
}

// Parse one `key: expression,` object literal out of a source slice (the two config literals and
// the candidate fields literal have no nested objects, so one line is one entry).
function literalEntries(text) {
    const entries = [];
    for (const raw of text.split('\n')) {
        const line = raw.replace(/\/\/.*$/, '').trim();
        const match = line.match(/^([A-Za-z0-9_]+): (.*?)(,|)$/);
        if (!match) continue;
        entries.push({ key: match[1], expr: match[2].trim() });
    }
    return entries;
}

// Describe an entry as the DOM read it performs plus the coercion wrapped around it. `@` marks the
// read, so `parseInt(nglInput.value) || 0` and `parseInt(fields.ngl) || 0` normalise identically.
function readShape(expr, elements) {
    const byVar = new Map();
    for (const [id, name] of elements) byVar.set(name, id);
    let shape = expr;
    let id = null;
    let prop = null;
    const direct = shape.match(/document\.getElementById\('([^']+)'\)\.(value|checked)/);
    if (direct) {
        id = direct[1];
        prop = direct[2];
        shape = shape.split(direct[0]).join('@');
        return { id, prop, coercion: shape };
    }
    const read = shape.match(/\b(\w+)\.(value|checked)\b/);
    assert(read, 'no DOM read in expression: ' + expr);
    id = byVar.get(read[1]);
    assert(id, 'element variable ' + read[1] + ' is not a getElementById declaration');
    prop = read[2];
    shape = shape.split(read[0]).join('@');
    assert(shape.indexOf(read[1]) < 0, 'expression reads more than one element: ' + expr);
    return { id, prop, coercion: shape };
}

// ------------------------------------------------------------------ lib side ----------------

function loadLib() {
    const args = require(path.join(REPO, 'legacy', 'lib', 'buildArgs.js'));
    const ini = require(path.join(REPO, 'legacy', 'lib', 'buildPresetIni.js'));
    assert(typeof args.buildArgs === 'function', 'legacy/lib/buildArgs.js does not export buildArgs');
    assert(typeof ini.buildPresetIni === 'function', 'legacy/lib/buildPresetIni.js does not export buildPresetIni');
    return { buildArgs: args.buildArgs, buildPresetIni: ini.buildPresetIni };
}

// ---------------------------------------------------------------- recorded inputs ---------

function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else out.push(full);
    }
    return out;
}

function readJson(file) {
    return JSON.parse(readText(file));
}

// Recorded /models payloads (the mmproj pass reads window.models).
function modelsVectors() {
    const seen = new Set();
    const vectors = [];
    for (const file of walk(path.join(REPO, 'fixtures', 'http'))) {
        if (!/models[^/]*\.response$/.test(path.basename(file))) continue;
        let body;
        try { body = readJson(file); } catch (error) { continue; }
        if (!body || !Array.isArray(body.models)) continue;
        const key = sha256(Buffer.from(JSON.stringify(body.models)));
        if (seen.has(key)) continue;
        seen.add(key);
        vectors.push({ label: path.relative(REPO, file).split(path.sep).join('/'), models: body.models });
    }
    assert(vectors.length > 0, 'no recorded /models payload found');
    assert(vectors.some((v) => v.models.some((m) => m.mmprojFile)),
        'no recorded /models payload carries an mmprojFile — the mmproj pass would go unproved');
    return vectors;
}

// Every recorded llamaCppConfigs / llamaCppSettings blob, keyed the way localStorage holds it.
function storageBlobs() {
    const blobs = [];
    const pushStorage = (rel, key, raw) => {
        if (key !== 'llamaCppConfigs' && key !== 'llamaCppSettings') return;
        let parsed;
        try { parsed = JSON.parse(raw); } catch (error) { return; }
        blobs.push({ label: rel + ' [' + key + ']', key, value: parsed,
            configs: key === 'llamaCppConfigs' ? parsed : null });
    };
    const files = [path.join(REPO, 'fixtures', 'corpus', 'configs.remapped.json'),
        ...walk(path.join(REPO, 'fixtures', 'localstorage'))];
    for (const file of files) {
        if (!fs.existsSync(file) || path.extname(file) !== '.json') continue;
        const text = readText(file);
        const rel = path.relative(REPO, file).split(path.sep).join('/');
        if (rel.endsWith('configs.remapped.json')) {
            const list = JSON.parse(text);
            for (const row of list) {
                const name = row.name;
                blobs.push({ label: rel + ' [' + name + ']', configs: { [name]: row.config } });
            }
            const all = {};
            for (const row of list) all[row.name] = row.config;
            blobs.push({ label: rel + ' [all ' + list.length + ' configs]', configs: all });
            continue;
        }
        let value;
        try { value = JSON.parse(text); } catch (error) { continue; }
        const entries = value && value.storage ? value.storage.entries : null;
        if (!entries) continue;
        for (const [key, raw] of entries) pushStorage(rel, key, raw);
    }
    // The four recorded J5-ui-states storage states (after-save-config is the Q7 re-write,
    // after-delete the Q8 partial reset).
    const notesFile = path.join(REPO, 'fixtures', 'screenshots', 'J5-ui-states', 'state-notes.json');
    if (fs.existsSync(notesFile)) {
        const notes = readJson(notesFile);
        for (const [state, value] of Object.entries(notes.storageStates || {})) {
            if (!value.storage) continue;
            for (const [key, raw] of value.storage.entries) {
                pushStorage(path.relative(REPO, notesFile).split(path.sep).join('/') + ' (' + state + ')', key, raw);
            }
        }
    }
    assert(blobs.some((b) => b.configs), 'no recorded llamaCppConfigs blob found');
    return blobs;
}

function settingsVectors(blobs) {
    const values = new Map();
    const add = (label, value) => {
        const port = value && value.serverPort;
        if (port === undefined || values.has(String(port))) return;
        values.set(String(port), { label, settings: value });
    };
    for (const blob of blobs) if (blob.key === 'llamaCppSettings' && blob.value) add(blob.label, blob.value);
    // Recorded /settings bodies add the second port the app can hold: J1 writes 8080 back after a
    // POST without serverPort (the Q2 TDZ bug), so 8080 and 7838 are both recorded.
    for (const file of walk(path.join(REPO, 'fixtures', 'http'))) {
        if (!/settings[^/]*\.response$/.test(path.basename(file))) continue;
        let body;
        try { body = readJson(file); } catch (error) { continue; }
        if (!body || !body.settings) continue;
        add(path.relative(REPO, file).split(path.sep).join('/'), body.settings);
    }
    const vectors = [...values.values()];
    assert(vectors.length > 0, 'no recorded settings blob with a serverPort was found');
    assert(vectors.length > 1, 'only one recorded serverPort value (' + [...values.keys()].join(',')
        + '): the --port split would go unproved');
    return vectors;
}

// The recorded form states are the fields maps (one read per element id, exactly the shape
// buildArgs takes); they also define which ids are checkboxes (recorded `checked`, not assumption).
function formStates() {
    const file = path.join(REPO, 'fixtures', 'screenshots', 'J5-ui-states', 'state-notes.json');
    assert(fs.existsSync(file), 'missing recorded form states: ' + file);
    const notes = readJson(file);
    const states = notes.storageStates || {};
    const names = Object.keys(states);
    assert(names.length >= 4, 'expected the four recorded form states, found ' + names.join(','));
    const kinds = new Map();
    for (const row of states[names[0]].fields) {
        if (!row.id) continue;
        kinds.set(row.id, row.checked === null ? 'value' : 'checked');
    }
    const statesOut = names.map((name) => ({
        label: 'form state ' + name,
        fields: fieldsFromControls(states[name].fields, kinds)
    }));
    for (const state of statesOut) {
        assert(Object.keys(state.fields).length >= 35,
            state.label + ' yielded only ' + Object.keys(state.fields).length + ' fields');
    }
    return { states: statesOut, kinds };
}

function fieldsFromControls(rows, kinds) {
    const fields = {};
    for (const row of rows) {
        if (!row.id) continue;
        fields[row.id] = kinds.get(row.id) === 'checked' ? row.checked : row.value;
    }
    return fields;
}

// Overlay a recorded saved config on the recorded fresh-page state, the way loadConfiguration
// fills the form before launchServer reads it. `raw` keeps the stored JSON type (Q19 type drift);
// the default vector coerces to the DOM string form.
function fieldsFromConfig(base, kinds, config, raw) {
    const fields = { ...base };
    for (const [id, value] of Object.entries(config)) {
        if (!kinds.has(id)) continue;
        if (value === undefined || value === null) continue;
        fields[id] = kinds.get(id) === 'checked' ? Boolean(value) : (raw ? value : String(value));
    }
    return fields;
}

// ----------------------------------------------------------- differential (mode 1) --------

function runDifferential(options) {
    const report = { baseline: BASELINE, checks: [], vectors: {}, claims: [] };
    const baseline = baselineScript();
    const candidate = readText(path.join(REPO, 'public', 'script.js')).split('\r\n').join('\n');
    const libArgsSource = readText(path.join(REPO, 'legacy', 'lib', 'buildArgs.js'));
    const libIniSource = readText(path.join(REPO, 'legacy', 'lib', 'buildPresetIni.js'));
    const elements = elementNameMap(baseline);

    const CONFIG_START = '    // Collect all configuration values\n    const config = {\n';
    const CONFIG_END = '    // Save current values to localStorage (if we have a config ID)';
    const ARGS_START = '        // Build command arguments\n        const args = [];\n';
    const ARGS_END = "        showOutput(`Command arguments: ${args.join(' ')}`);";
    const INI_START = "        let presetContent = 'version = 1\\n\\n';\n";
    const INI_END = "        showOutput('Generated models-preset.ini content:');";
    const FIELDS_START = '    const fields = {\n';

    const baselineConfig = slice(baseline, CONFIG_START, CONFIG_END, 'config literal', BASELINE + ':script.js');
    const baselineArgs = slice(baseline, ARGS_START, ARGS_END, 'argv block', BASELINE + ':script.js');
    const baselineIni = slice(baseline, INI_START, INI_END, 'ini block', BASELINE + ':script.js');
    const candidateFields = slice(candidate, FIELDS_START, CONFIG_END, 'fields map', 'working script.js');
    const libArgsBody = slice(libArgsSource, '        // Build command arguments\n        const args = [];\n',
        '        return args;\n', 'buildArgs body', 'legacy/lib/buildArgs.js');
    const libIniBody = slice(libIniSource, INI_START, '        return presetContent;\n',
        'buildPresetIni body', 'legacy/lib/buildPresetIni.js');
    const libConfigLiteral = slice(libArgsSource, '        const config = {\n',
        '\n        // Build command arguments', 'buildArgs config literal', 'legacy/lib/buildArgs.js');

    // --- static check 1: the argv block is the lib body, modulo the two documented reads
    const argsSubstituted = baselineArgs
        .split("const modelPath = modelPathSelect.value.trim();").join('const modelPath = fields.modelPath.trim();')
        .split('window.models.forEach(model => {').join('models.forEach(model => {');
    assert(normLines(argsSubstituted) === normLines(libArgsBody),
        'argv block is not verbatim:\n' + firstLineDiff(normLines(argsSubstituted), normLines(libArgsBody)));
    report.checks.push('argv block: ' + normLines(argsSubstituted).split('\n').length
        + ' normalised lines identical to legacy/lib/buildArgs.js');

    // --- static check 2: the ini block is the lib body, modulo window.models
    const iniSubstituted = baselineIni.split('window.models.forEach(model => {')
        .join('models.forEach(model => {');
    assert(normLines(iniSubstituted) === normLines(libIniBody),
        'ini block is not verbatim:\n' + firstLineDiff(normLines(iniSubstituted), normLines(libIniBody)));
    report.checks.push('ini block: ' + normLines(iniSubstituted).split('\n').length
        + ' normalised lines identical to legacy/lib/buildPresetIni.js');
    // The ini block reads settings only for the trailing `port = ` line, which stays inline because
    // the log pane prints the sections before it is appended — that is why buildPresetIni takes
    // (configs, models) and not the (configs, settings, models) the plan sketches.
    assert(!/\bsettings\s*\./.test(baselineIni),
        'the baseline ini block reads settings; the inline `port = ` line is no longer the whole story');
    report.checks.push('ini block reads no settings — the only settings read in launchModelPresets'
        + ' is the inline `port = ${settings.serverPort}` append, which runs after showOutput');

    // --- static check 3: the fields map + the lib config literal together reproduce the baseline
    //     config literal entry-for-entry, in order, same element, same .value/.checked, same coercion
    const baseEntries = literalEntries(baselineConfig);
    const candidateEntries = literalEntries(candidateFields);
    const libEntries = literalEntries(libConfigLiteral);
    assert(baseEntries.length === 35, 'expected 35 baseline config entries, got ' + baseEntries.length);
    assert(candidateEntries.length === baseEntries.length && libEntries.length === baseEntries.length,
        'entry count mismatch: baseline=' + baseEntries.length + ' fields=' + candidateEntries.length
        + ' lib=' + libEntries.length);
    for (let i = 0; i < baseEntries.length; i += 1) {
        const want = baseEntries[i];
        const at = candidateEntries[i];
        const lib = libEntries[i];
        assert(at.key === want.key && lib.key === want.key,
            'entry ' + i + ' key order: baseline=' + want.key + ' fields=' + at.key + ' lib=' + lib.key);
        const fromBaseline = readShape(want.expr, elements);
        const fromCaller = readShape(at.expr, elements);
        const libId = 'fields.' + lib.key;
        assert(lib.expr.indexOf(libId) >= 0, 'lib entry ' + lib.key + ' does not read fields.' + lib.key
            + ': ' + lib.expr);
        const libCoercion = lib.expr.split(libId).join('@');
        assert(fromCaller.id === fromBaseline.id && fromCaller.prop === fromBaseline.prop,
            want.key + ': the caller reads ' + fromCaller.id + '.' + fromCaller.prop
            + ' but the baseline read ' + fromBaseline.id + '.' + fromBaseline.prop);
        assert(fromCaller.coercion === '@', want.key + ': the caller keeps a coercion ('
            + at.expr + '); coercions belong in the lib');
        assert(libCoercion === fromBaseline.coercion, want.key + ': coercion changed: baseline `'
            + fromBaseline.coercion + '` vs lib `' + libCoercion + '`');
    }
    report.checks.push('fields map: 35/35 entries read the same element and property as the baseline'
        + ' literal, in the same order, with every coercion moved verbatim into buildArgs.js');

    // --- runtime check: sliced originals, evaluated here, vs the lib, over recorded inputs
    const elementNames = [];
    for (const entry of baseEntries) {
        const shape = readShape(entry.expr, elements);
        const name = elements.get(shape.id);
        if (name && elementNames.indexOf(name) < 0) elementNames.push(name);
    }
    /* eslint-disable no-new-func */
    const legacyConfig = new Function('document', ...elementNames, baselineConfig + '\n        return config;');
    const legacyArgs = new Function('config', 'settings', 'modelPathSelect', 'window',
        baselineArgs + '\n        return args;');
    const legacyIni = new Function('configs', 'window', baselineIni + '\n        return presetContent;');
    /* eslint-enable no-new-func */

    const lib = loadLib();
    const { states, kinds } = formStates();
    const base = states.find((state) => state.label.endsWith('fresh')).fields;
    const blobs = storageBlobs();
    const modelsVectors_ = modelsVectors();
    const settingsValues = settingsVectors(blobs);

    const fieldsVectors = [...states];
    for (const blob of blobs) {
        if (!blob.configs) continue;
        for (const [name, config] of Object.entries(blob.configs)) {
            fieldsVectors.push({ label: blob.label + ' / ' + name,
                fields: fieldsFromConfig(base, kinds, config, false) });
            fieldsVectors.push({ label: blob.label + ' / ' + name + ' (stored types)',
                fields: fieldsFromConfig(base, kinds, config, true) });
        }
    }

    let argvCompared = 0;
    const argvDigests = new Set();
    const iniDigests = new Set();
    const claims = { mmproj: 0, bareFa: 0, ngramIni: 0, legacyReasoning: 0, cacheRamNaN: 0, minPZeroForms: 0 };
    const failures = [];

    for (const vector of fieldsVectors) {
        for (const models of modelsVectors_) {
            for (const settings of settingsValues) {
                const label = vector.label + ' | ' + models.label + ' | ' + settings.label;
                const fakeElements = {};
                // The fakes hand the sliced original EXACTLY the value the lib receives, so a
                // difference can only come from the code, never from the harness coercing one side.
                const fakeRead = (id) => (kinds.get(id) === 'checked'
                    ? { value: 'on', checked: vector.fields[id] }
                    : { value: vector.fields[id], checked: false });
                for (const [id, name] of elements) fakeElements[name] = fakeRead(id);
                const fakeDocument = { getElementById: fakeRead };
                const config = legacyConfig(fakeDocument, ...elementNames.map((name) => fakeElements[name]));
                let want;
                let got;
                try {
                    want = legacyArgs(config, settings.settings, fakeElements.modelPathSelect,
                        { models: models.models });
                } catch (error) { want = { threw: String(error && error.message) }; }
                try {
                    got = lib.buildArgs(vector.fields, settings.settings, models.models);
                } catch (error) { got = { threw: String(error && error.message) }; }
                const wanted = JSON.stringify(want);
                const have = JSON.stringify(got);
                argvCompared += 1;
                if (wanted !== have) {
                    failures.push('argv differs for ' + label + '\n  baseline: ' + wanted + '\n  lib      : ' + have);
                    continue;
                }
                if (Array.isArray(want)) {
                    argvDigests.add(sha256(Buffer.from(wanted)));
                    if (want.includes('--mmproj')) claims.mmproj += 1;
                    const fa = want.indexOf('-fa');
                    if (fa >= 0 && want[fa + 1] !== 'on' && want[fa + 1] !== 'off') claims.bareFa += 1;
                    if (Number.isNaN(parseInt(vector.fields.cacheRam, 10)) && want.includes('--cache-ram')) {
                        failures.push('--cache-ram emitted for a NaN cacheRam: ' + label);
                    }
                    if (Number.isNaN(parseInt(vector.fields.cacheRam, 10))) claims.cacheRamNaN += 1;
                    if (String(vector.fields.minP) === '0.00' || String(vector.fields.minP) === '0.0') {
                        claims.minPZeroForms += 1;
                    }
                }
            }
        }
    }

    const iniVectors = blobs.filter((blob) => blob.configs);
    let iniCompared = 0;
    for (const blob of iniVectors) {
        for (const models of modelsVectors_) {
            for (const settings of settingsValues) {
                const label = blob.label + ' | ' + models.label;
                const wanted = legacyIni(blob.configs, { models: models.models })
                    + `port = ${settings.settings.serverPort}\n`;
                const have = lib.buildPresetIni(blob.configs, models.models)
                    + `port = ${settings.settings.serverPort}\n`;
                iniCompared += 1;
                if (wanted !== have) {
                    failures.push('ini differs for ' + label + '\n  first difference at byte '
                        + firstDifference(Buffer.from(wanted), Buffer.from(have)));
                    continue;
                }
                iniDigests.add(sha256(Buffer.from(wanted)));
                if (wanted.includes('spec-ngram-size-n = 24')) claims.ngramIni += 1;
                if (wanted.includes('reasoning = ')) claims.legacyReasoning += 1;
            }
        }
    }

    // Any difference is a refactor bug: the fix is the lib, never an input or a fixture.
    assert(failures.length === 0, 'DIFFERENTIAL FAIL (' + failures.length + ' difference(s)):\n  '
        + failures.slice(0, 10).join('\n  '));

    // A differential over vacuous inputs proves nothing: name what the vectors really exercised.
    const uncovered = Object.keys(claims).filter((name) => claims[name] === 0);
    for (const claim of ['mmproj', 'bareFa', 'ngramIni', 'legacyReasoning']) {
        assert(claims[claim] > 0, 'the recorded inputs never produced the claim ' + claim
            + ' — the differential would be vacuous for it');
    }
    assert(iniDigests.size > 10, 'the ini vectors produced only ' + iniDigests.size + ' distinct outputs');
    assert(argvDigests.size > 10, 'the argv vectors produced only ' + argvDigests.size + ' distinct outputs');

    report.vectors = {
        fieldsVectors: fieldsVectors.length,
        iniConfigVectors: iniVectors.length,
        modelsVectors: modelsVectors_.length,
        settingsVectors: settingsValues.length,
        argvCompared,
        iniCompared,
        distinctArgv: argvDigests.size,
        distinctIni: iniDigests.size
    };
    report.claims = claims;
    report.claimsNotCoveredByRecordedInputs = uncovered;
    report.result = 'byte-identical';
    console.log('DIFFERENTIAL OK (baseline ' + BASELINE + ' sliced inline blocks vs legacy/lib)');
    for (const line of report.checks) console.log('  static: ' + line);
    console.log('  runtime: ' + argvCompared + ' argv vectors + ' + iniCompared + ' ini byte vectors'
        + ' identical (' + report.vectors.distinctArgv + ' distinct argv, '
        + report.vectors.distinctIni + ' distinct ini)');
    console.log('  coverage claims: ' + JSON.stringify(claims));
    if (uncovered.length) {
        console.log('  not exercised by recorded inputs (Phase 2 boundary vectors own these): '
            + uncovered.join(', '));
    }
    if (options.json) {
        fs.writeFileSync(options.json, JSON.stringify(report, null, 2) + '\n');
        console.log('  report written to ' + options.json);
    }
    return 0;
}

// ------------------------------------------------------------------- manifests ------------

function globToRegExp(glob) {
    let out = '^';
    for (let index = 0; index < glob.length; index += 1) {
        const char = glob[index];
        if (char === '*') {
            if (glob[index + 1] === '*') {
                if (glob[index + 2] === '/') { out += '(?:.*/)?'; index += 2; } else out += '.*'; index += 1;
            } else out += '[^/]*';
        } else if (char === '?') out += '[^/]';
        else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(out + '$');
}

function fixtureFiles(root) {
    const out = [];
    for (const kind of KINDS) {
        const dir = path.join(root, kind);
        if (!fs.existsSync(dir)) continue;
        for (const file of walk(dir)) out.push(path.relative(root, file).split(path.sep).join('/'));
    }
    return out.sort();
}

function writeManifest(root) {
    const files = fixtureFiles(root).map((rel) => ({
        path: rel, sha256: sha256(fs.readFileSync(path.join(root, rel)))
    }));
    const manifest = {
        writtenBy: 'tools/parity/preservation-proof.js --write-manifest',
        command: process.argv.slice(2).join(' '),
        root: path.basename(root),
        fileCount: files.length,
        files
    };
    const out = path.join(root, 'PROOF-MANIFEST.json');
    fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
    console.log('PROOF-MANIFEST.json: ' + files.length + ' files, sha256 '
        + sha256(fs.readFileSync(out)) + ' (' + out + ')');
    return 0;
}

// Unified diff, so a red proof is diagnosable without re-running anything.
function unifiedDiff(a, b, label) {
    const result = spawnSync('diff', ['-u', '--label', 'A/' + label, '--label', 'B/' + label,
        a, b], { encoding: 'utf8' });
    if (result.stdout && result.stdout.trim() !== '') return result.stdout;
    const ba = fs.readFileSync(a);
    const bb = fs.readFileSync(b);
    return '(no textual diff; binary/same-text: A=' + ba.length + ' bytes, B=' + bb.length + ' bytes, '
        + firstDifference(ba, bb) + ')';
}

function firstDifference(a, b) {
    const shared = Math.min(a.length, b.length);
    let i = 0;
    while (i < shared && a[i] === b[i]) i += 1;
    if (i === shared) return a.length === b.length ? 'identical' : 'identical prefix, length '
        + a.length + ' vs ' + b.length;
    const window = (buf) => JSON.stringify(buf.slice(Math.max(0, i - 40), i + 40).toString('utf8'));
    return 'offset ' + i + '\n      A: ' + window(a) + '\n      B: ' + window(b);
}

function compareManifests(aRoot, bRoot, comparisonFile) {
    const rules = readJson(comparisonFile);
    const fileA = path.join(aRoot, 'PROOF-MANIFEST.json');
    const fileB = path.join(bRoot, 'PROOF-MANIFEST.json');
    assert(fs.existsSync(fileA) && fs.existsSync(fileB),
        'both runs need a PROOF-MANIFEST.json (run --write-manifest for each)');
    const manifestA = readJson(fileA);
    const manifestB = readJson(fileB);
    const shaA = new Map(manifestA.files.map((entry) => [entry.path, entry.sha256]));
    const shaB = new Map(manifestB.files.map((entry) => [entry.path, entry.sha256]));
    const all = [...new Set([...shaA.keys(), ...shaB.keys()])].sort();
    const missing = all.filter((rel) => !shaA.has(rel) || !shaB.has(rel));
    for (const rel of missing) {
        console.error('FILE SET DIFF: ' + rel + ' is in ' + (shaA.has(rel) ? 'A only' : 'B only'));
    }
    const relaxed = [];
    const exact = [];
    const failures = [];
    for (const rel of all) {
        if (missing.includes(rel)) continue;
        const rule = rules.rules.find((candidate) => globToRegExp(candidate.pathGlob).test(rel));
        if (rule && rule.mode !== 'exact') { relaxed.push(rel + ' [' + rule.mode + ' ' + rule.id + ']'); continue; }
        exact.push(rel);
        if (shaA.get(rel) === shaB.get(rel)) continue;
        failures.push(rel);
        console.error('BYTE DIFF: ' + rel);
        console.error(unifiedDiff(path.join(aRoot, rel), path.join(bRoot, rel), rel));
    }
    console.log('manifest compare: ' + all.length + ' recorded files, ' + exact.length
        + ' compared byte-for-byte (identical=' + (exact.length - failures.length) + '), '
        + relaxed.length + ' files are relaxed by fixtures/COMPARISON.json and are re-checked by'
        + ' capture-legacy.js --compare');
    if (missing.length + failures.length > 0) {
        console.error('PROOF MANIFEST COMPARE FAIL: ' + missing.length + ' file-set diff(s), '
            + failures.length + ' byte diff(s)');
        return 1;
    }
    console.log('PROOF MANIFEST COMPARE OK: identical file set, ' + exact.length
        + ' files byte-for-byte identical');
    return 0;
}

// --------------------------------------------------------------------- main ---------------

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === '--differential') out.mode = 'differential';
        else if (token === '--write-manifest') { out.mode = 'manifest'; out.dir = argv[i += 1]; }
        else if (token === '--compare-manifests') {
            out.mode = 'compare'; out.a = argv[i += 1]; out.b = argv[i += 1];
        } else if (token === '--comparison') out.comparison = argv[i += 1];
        else if (token === '--json') out.json = path.resolve(argv[i += 1]);
        else throw new Error('unknown argument: ' + token);
    }
    out.comparison = out.comparison || path.join(REPO, 'fixtures', 'COMPARISON.json');
    return out;
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.mode === 'differential') return runDifferential(options);
    if (options.mode === 'manifest') return writeManifest(path.resolve(options.dir));
    if (options.mode === 'compare') {
        return compareManifests(path.resolve(options.a), path.resolve(options.b), path.resolve(options.comparison));
    }
    throw new Error('choose --differential, --write-manifest DIR or --compare-manifests A B');
}

main();
