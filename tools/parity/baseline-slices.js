#!/usr/bin/env node
'use strict';
// The parity-baseline argv/ini generators, sliced out of `git show parity-baseline:public/script.js`
// and compiled as callable functions — the API Phase 2.3/2.4/2.5 needs and
// tools/parity/preservation-proof.js (the committed Phase 2.1 gate artifact, edited only by its own
// owner) does not export.
//
//   node tools/parity/baseline-slices.js            slice + report what was sliced
//   node tools/parity/baseline-slices.js --selftest prove the slices still equal legacy/lib
//
// The slicing functions below are the committed ones in preservation-proof.js, copied verbatim
// (anchors included), so a slice taken here is byte-for-byte the slice that proof takes; one shared
// copy of the anchors is the point of the exercise, and the copied text is kept identical so a
// future change to either has to be made in both places deliberately.
//
// Why goldens are recorded from this module and not from legacy/lib: C5. A golden has to be legacy
// output, so it is produced by the baseline text itself. legacy/lib is then required to reproduce it
// byte-for-byte (tools/parity/equivalence.js) — that is the candidate test, not the recording step.

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const BASELINE = 'parity-baseline';

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

// The anchors of the three inline regions legacy/lib was cut out of, in one place: gen-goldens
// records from these slices, so a golden is baseline output by construction (C5).
const ANCHORS = {
    CONFIG_START: '    // Collect all configuration values\n    const config = {\n',
    CONFIG_END: '    // Save current values to localStorage (if we have a config ID)',
    ARGS_START: '        // Build command arguments\n        const args = [];\n',
    ARGS_END: "        showOutput(`Command arguments: ${args.join(' ')}`);",
    INI_START: "        let presetContent = 'version = 1\\n\\n';\n",
    INI_END: "        showOutput('Generated models-preset.ini content:');",
    FIELDS_START: '    const fields = {\n'
};

// Slice the three baseline regions and compile them as callable functions. `config` takes a fake
// document plus the element variables in the order the literal itself reads them; `args` and `ini`
// take what the inline code had in scope.
function slicedGenerators() {
    const baseline = baselineScript();
    const slices = {
        config: slice(baseline, ANCHORS.CONFIG_START, ANCHORS.CONFIG_END, 'config literal',
            BASELINE + ':script.js'),
        args: slice(baseline, ANCHORS.ARGS_START, ANCHORS.ARGS_END, 'argv block', BASELINE + ':script.js'),
        ini: slice(baseline, ANCHORS.INI_START, ANCHORS.INI_END, 'ini block', BASELINE + ':script.js')
    };
    const elements = elementNameMap(baseline);
    const elementNames = [];
    for (const entry of literalEntries(slices.config)) {
        const name = elements.get(readShape(entry.expr, elements).id);
        if (name && elementNames.indexOf(name) < 0) elementNames.push(name);
    }
    /* eslint-disable no-new-func */
    const compiled = {
        config: new Function('document', ...elementNames, slices.config + '\n        return config;'),
        args: new Function('config', 'settings', 'modelPathSelect', 'window',
            slices.args + '\n        return args;'),
        ini: new Function('configs', 'window', slices.ini + '\n        return presetContent;')
    };
    /* eslint-enable no-new-func */
    return { baseline, elements, elementNames, slices, compiled };
}

// ------------------------------------------------------------------ lib side ----------------

function loadLib() {
    const args = require(path.join(REPO, 'legacy', 'lib', 'buildArgs.js'));
    const ini = require(path.join(REPO, 'legacy', 'lib', 'buildPresetIni.js'));
    assert(typeof args.buildArgs === 'function', 'legacy/lib/buildArgs.js does not export buildArgs');
    assert(typeof ini.buildPresetIni === 'function', 'legacy/lib/buildPresetIni.js does not export buildPresetIni');
    return { buildArgs: args.buildArgs, buildPresetIni: ini.buildPresetIni };
}

// ------------------------------------------------------- baseline / lib entry points ------

// Which recorded control kind each element id is: a checkbox reads `.checked`, everything else
// `.value`. Taken from the recorded form states, never from an assumption about the markup.
function fieldKinds() {
    if (!fieldKinds.cached) fieldKinds.cached = formStates().kinds;
    return fieldKinds.cached;
}

// Run the sliced baseline argv generator over a fields map in exactly the shape buildArgs takes.
// The fakes hand the baseline code EXACTLY the value the lib receives, so a difference between
// baseline and lib can only come from the code, never from this harness coercing one side.
function runBaselineArgv(gen, fields, settings, models) {
    const kinds = fieldKinds();
    const read = (id) => (kinds.get(id) === 'checked'
        ? { value: 'on', checked: fields[id] }
        : { value: fields[id], checked: false });
    const byName = {};
    for (const [id, name] of gen.elements) byName[name] = read(id);
    const config = gen.compiled.config({ getElementById: read },
        ...gen.elementNames.map((name) => byName[name]));
    return { config, args: gen.compiled.args(config, settings, byName.modelPathSelect, { models }) };
}

// The trailing `port = ${settings.serverPort}` line is NOT part of this return value: in
// launchModelPresets it is appended after showOutput, so it is outside both the baseline slice and
// the lib. Goldens compare what the generators return.
function runBaselineIni(gen, configs, models) {
    return gen.compiled.ini(configs, { models });
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

// ------------------------------------------------------------------- selftest -------------

// The copied slices must still be the text legacy/lib was extracted from. This is the same static
// identity check the Phase 2.1 proof makes, run here so a drift in this module or in the lib fails
// at import time for every tool that records goldens.
function selftest() {
    const gen = slicedGenerators();
    const libArgsSource = readText(path.join(REPO, 'legacy', 'lib', 'buildArgs.js'));
    const libIniSource = readText(path.join(REPO, 'legacy', 'lib', 'buildPresetIni.js'));
    const libArgsBody = slice(libArgsSource, ANCHORS.ARGS_START, '        return args;\n',
        'buildArgs body', 'legacy/lib/buildArgs.js');
    const libIniBody = slice(libIniSource, ANCHORS.INI_START, '        return presetContent;\n',
        'buildPresetIni body', 'legacy/lib/buildPresetIni.js');
    const argsSubstituted = gen.slices.args
        .split('const modelPath = modelPathSelect.value.trim();')
        .join('const modelPath = fields.modelPath.trim();')
        .split('window.models.forEach(model => {').join('models.forEach(model => {');
    assert(normLines(argsSubstituted) === normLines(libArgsBody),
        'the sliced argv block is not legacy/lib/buildArgs.js:\n'
            + firstLineDiff(normLines(argsSubstituted), normLines(libArgsBody)));
    const iniSubstituted = gen.slices.ini
        .split('window.models.forEach(model => {').join('models.forEach(model => {');
    assert(normLines(iniSubstituted) === normLines(libIniBody),
        'the sliced ini block is not legacy/lib/buildPresetIni.js:\n'
            + firstLineDiff(normLines(iniSubstituted), normLines(libIniBody)));
    const entries = literalEntries(gen.slices.config);
    assert(entries.length === 35, 'expected the 35-entry baseline config literal, got ' + entries.length);
    const libConfigLiteral = slice(libArgsSource, '        const config = {\n',
        '\n        // Build command arguments', 'buildArgs config literal', 'legacy/lib/buildArgs.js');
    const libEntries = literalEntries(libConfigLiteral);
    assert(libEntries.length === entries.length, 'the lib config literal has ' + libEntries.length
        + ' entries, the baseline has ' + entries.length);
    for (let i = 0; i < entries.length; i += 1) {
        const baselineShape = readShape(entries[i].expr, gen.elements);
        const libCoercion = libEntries[i].expr.split('fields.' + libEntries[i].key).join('@');
        assert(libEntries[i].key === entries[i].key, 'entry ' + i + ' key order drifted');
        assert(libCoercion === baselineShape.coercion, entries[i].key + ': coercion drifted: baseline `'
            + baselineShape.coercion + '` vs lib `' + libCoercion + '`');
    }
    // A compiled slice that runs is what goldens are recorded from.
    const { states } = formStates();
    const fresh = states.find((state) => state.label.endsWith('fresh'));
    const run = runBaselineArgv(gen, fresh.fields, { serverPort: 7838 }, modelsVectors()[0].models);
    assert(Array.isArray(run.args) && run.args.slice(-6).join(' ') === '--host 0.0.0.0 -fit off --port 7838',
        'the sliced argv generator did not append the always-appended args: ' + run.args.slice(-6).join(' '));
    // The bare `spec-type = ` line below is legacy, not a bug in this check: a config with no
    // speculationType at all satisfies `config.speculationType !== 'none'`, so specTypes stays empty
    // and `specTypes.length > 0` still emits the key with an empty value (INI-87). Pinned as-is (C4).
    const ini = runBaselineIni(gen, { one: { modelPath: 'x/a.gguf' } }, []);
    assert(ini === 'version = 1\n\n[one]\nmodel = x/a.gguf\nspec-type = \n\n',
        'the sliced ini generator output moved: ' + JSON.stringify(ini));
    return {
        argvLines: normLines(argsSubstituted).split('\n').length,
        iniLines: normLines(iniSubstituted).split('\n').length,
        configEntries: entries.length,
        elementNames: gen.elementNames.length
    };
}

module.exports = {
    REPO, BASELINE, ANCHORS, sha256, readText, readJson, assert,
    slice, normLines, firstLineDiff, baselineScript, elementNameMap, literalEntries, readShape,
    slicedGenerators, loadLib, fieldKinds, runBaselineArgv, runBaselineIni,
    walk, modelsVectors, storageBlobs, settingsVectors, formStates, fieldsFromControls,
    fieldsFromConfig, selftest
};

if (require.main === module) {
    const result = selftest();
    console.log('BASELINE SLICES OK (parity-baseline:public/script.js)');
    console.log('  argv block ' + result.argvLines + ' normalised lines == legacy/lib/buildArgs.js body');
    console.log('  ini block    ' + result.iniLines + ' normalised lines == legacy/lib/buildPresetIni.js body');
    console.log('  config literal ' + result.configEntries + ' entries, ' + result.elementNames
        + ' element variables');
}
