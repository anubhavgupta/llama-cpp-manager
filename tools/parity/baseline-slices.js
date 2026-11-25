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

function baselineMarkup() {
    const bytes = execFileSync('git', ['show', BASELINE + ':public/index.html'],
        { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
    return bytes.toString('utf8').split('\r\n').join('\n');
}

// The elements between <html> and one element of a markup string, outermost first, as
// {tag, id, classes}. Tag scan only: it walks the markup outside <script>/<style> bodies and returns
// null when the id is not a rendered tag, so a caller that needs the chain declines rather than guessing.
function ancestorChain(markup, id) {
    const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
        'source', 'track', 'wbr']);
    const tag = /<!--[\s\S]*?-->|<\/(\w+)[^>]*>|<(\w+)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
    const bodyless = markup.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
    const classesFor = (found) => found
        ? (found[1] === undefined ? found[2] : found[1]).split(/\s+/).filter(Boolean) : [];
    const stack = [];
    let match = tag.exec(bodyless);
    while (match) {
        if (!match[1] && !match[2]) { match = tag.exec(bodyless); continue; }
        if (match[1]) {
            const name = match[1].toLowerCase();
            while (stack.length && stack[stack.length - 1].name !== name) stack.pop();
            if (stack.length) stack.pop();
            match = tag.exec(bodyless);
            continue;
        }
        const name = match[2].toLowerCase();
        const attrs = match[3] || '';
        const found = /(?:^|\s)id\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
        const elementId = found ? (found[1] === undefined ? found[2] : found[1]) : null;
        const classes = /(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
        if (elementId === id) {
            return stack.map((entry) => ({ tag: entry.name, id: entry.id, classes: entry.classes }));
        }
        if (!VOID.has(name)) stack.push({ name: name, id: elementId, classes: classesFor(classes) });
        match = tag.exec(bodyless);
    }
    return null;
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
    // A guard on the same element (`chatTemplateKwargsInput ? chatTemplateKwargsInput.value.trim() : ''`)
    // mentions the variable twice; only a SECOND element's variable would change what is read.
    for (const [otherId, otherName] of elements) {
        if (otherId === id) continue;
        assert(!new RegExp('\\b' + otherName + '\\b').test(shape),
            'expression reads more than one element: ' + expr);
    }
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
    FIELDS_START: '    const fields = {\n',
    // The whole baseline saveCurrentValues function: the writer whose localStorage bytes the L2
    // re-save test compares against (Q16 orphan-key drop happens here, because it builds a fresh
    // object rather than mutating the stored one).
    SAVE_START: 'function saveCurrentValues(configId) {',
    SAVE_END: '\n\n// Load configuration values into form'
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
        ini: slice(baseline, ANCHORS.INI_START, ANCHORS.INI_END, 'ini block', BASELINE + ':script.js'),
        save: slice(baseline, ANCHORS.SAVE_START, ANCHORS.SAVE_END, 'saveCurrentValues', BASELINE + ':script.js')
    };
    const elements = elementNameMap(baseline);
    const elementNames = [];
    for (const entry of literalEntries(slices.config)) {
        const name = elements.get(readShape(entry.expr, elements).id);
        if (name && elementNames.indexOf(name) < 0) elementNames.push(name);
    }
    // The saved field set is not the launch field set (Q7): serverPath and chatTemplateKwargs are
    // read here and nowhere in the argv block, so the save slice needs its own element list.
    const saveElementNames = [];
    for (const entry of literalEntries(slices.save)) {
        const name = elements.get(readShape(entry.expr, elements).id);
        if (name && saveElementNames.indexOf(name) < 0) saveElementNames.push(name);
    }
    /* eslint-disable no-new-func */
    const compiled = {
        config: new Function('document', ...elementNames, slices.config + '\n        return config;'),
        args: new Function('config', 'settings', 'modelPathSelect', 'window',
            slices.args + '\n        return args;'),
        ini: new Function('configs', 'window', slices.ini + '\n        return presetContent;'),
        // `configurations`, `saveConfigurations` and `console` are the free variables the baseline
        // function body uses; the caller passes fakes, so the slice's own writes are what get read.
        // The slice is the whole function declaration, so the wrapper calls it with the config id.
        save: new Function('configurations', 'document', 'saveConfigurations', 'console', 'configId',
            ...saveElementNames,
            slices.save + '\n    saveCurrentValues(configId);\n    return configurations;')
    };
    /* eslint-enable no-new-func */
    return { baseline, elements, elementNames, saveElementNames, slices, compiled };
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

// Run the baseline saveCurrentValues over a fields map (the recorded form state) and return both
// the mutated configurations map and every localStorage string the baseline itself wrote through
// saveConfigurations. The stored map is passed in by reference because that is how the baseline
// mutates it: an existing key keeps its position in the insertion order, and orphan keys that the
// 35-entry literal does not read are gone from the re-saved entry (Q16).
function runBaselineSave(gen, fields, configurations, configId) {
    const kinds = fieldKinds();
    const read = (id) => (kinds.get(id) === 'checked'
        ? { value: 'on', checked: fields[id] }
        : { value: fields[id], checked: false });
    const byName = {};
    for (const [id, name] of gen.elements) byName[name] = read(id);
    const written = [];
    const saveConfigurations = () => written.push(JSON.stringify(configurations));
    const out = gen.compiled.save(configurations, { getElementById: read }, saveConfigurations,
        { log() {} }, configId, ...gen.saveElementNames.map((name) => byName[name]));
    assert(out === configurations, 'the sliced saveCurrentValues returned a different map than it wrote');
    return { configs: configurations, written };
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
    // The save slice is what the re-save goldens are recorded from, so its own output shape is
    // pinned here: 36 keys (Q7: not the launch set, and equal to SPEC's persistedIntoConfigs count),
    // the stored key order kept, orphan keys dropped.
    const saved = runBaselineSave(gen, fresh.fields, {
        keep: { ngl: 1 },
        target: { ngl: 7, mlock: true, noMmap: false, ndio: false, dio: false, draftMin: 5, draftPMin: 0.1,
            disableReasoning: false, draftMax: 10 }
    }, 'target');
    assert(saved.written.length === 1, 'the sliced saveCurrentValues did not call saveConfigurations once');
    const savedEntry = saved.configs.target;
    const savedKeys = Object.keys(savedEntry);
    assert(savedKeys.length === 36, 'the sliced saveCurrentValues wrote ' + savedKeys.length
        + ' keys, expected the 36-key saved field set');
    for (const orphan of ['mlock', 'noMmap', 'ndio', 'dio', 'draftMin', 'draftMax', 'draftPMin',
        'disableReasoning']) {
        assert(!(orphan in savedEntry), 'the sliced saveCurrentValues kept orphan key ' + orphan
            + ' (Q16 says it is dropped on re-save)');
    }
    assert(savedKeys[0] === 'serverPath' && savedKeys[1] === 'modelPath',
        'the sliced saveCurrentValues key order moved: ' + savedKeys.slice(0, 3).join(','));
    assert(Object.keys(saved.configs).join(',') === 'keep,target',
        're-saving an existing key moved it in the insertion order: ' + Object.keys(saved.configs).join(','));
    assert(saved.written[0] === JSON.stringify(saved.configs),
        'the sliced saveConfigurations did not capture the string the baseline wrote');
    return {
        argvLines: normLines(argsSubstituted).split('\n').length,
        iniLines: normLines(iniSubstituted).split('\n').length,
        configEntries: entries.length,
        elementNames: gen.elementNames.length,
        saveKeys: savedKeys.length,
        saveElementNames: gen.saveElementNames.length
    };
}

module.exports = {
    REPO, BASELINE, ANCHORS, sha256, readText, readJson, assert,
    slice, normLines, firstLineDiff, baselineScript, baselineMarkup, ancestorChain, elementNameMap,
    literalEntries, readShape,
    slicedGenerators, loadLib, fieldKinds, runBaselineArgv, runBaselineIni, runBaselineSave,
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
    console.log('  saveCurrentValues ' + result.saveKeys + ' saved keys, ' + result.saveElementNames
        + ' element variables (Q7/Q16 shape pinned)');
}
