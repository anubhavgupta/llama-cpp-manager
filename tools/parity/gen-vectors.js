#!/usr/bin/env node
'use strict';
// Phase 2.3 (plan.md §2): the vector families. One vector = one fully-specified input to the two
// pure generators (fields map + settings + models + config name), plus the row_ids it is there to
// flip. Goldens (tools/parity/gen-goldens.js) are recorded from the parity-baseline inline blocks;
// this file only produces INPUTS, so nothing here decides what the output should be.
//
//   node tools/parity/gen-vectors.js            regenerate every family + coverage-map.json
//   node tools/parity/gen-vectors.js --check    regenerate into a temp root, fail on any byte diff
//
// Determinism: one seed, recorded in each family's header line; every collection is sorted or built
// in a fixed source order; no timestamps, no Date, no Math.random.
//
// The field matrix is DERIVED, never hand-listed: the keys buildArgs reads out of
// legacy/lib/buildArgs.js, plus every key present in the real-state corpus (fixtures/corpus/), so
// the Q16 orphan keys are carried and the goldens can prove the generators ignore them.
//
// Records goldens and measures predicates from the SAME baseline text the Phase 2.1 proof checks,
// via tools/parity/baseline-slices.js: a predicate value here is the value the BASELINE code
// computes, not the value this file believes.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const proof = require('./baseline-slices.js');

const REPO = proof.REPO;
const VECTORS = path.join(REPO, 'fixtures', 'vectors');
const GOLDENS = path.join(REPO, 'fixtures', 'goldens');
const FAMILIES = ['boundary', 'cover', 'format', 'random', 'corpus'];
const SEED = 20261123;
const RANDOM_VECTORS = 1500;
const OMIT = Symbol('omit');
const REGEN = 'node tools/parity/gen-vectors.js';

// --------------------------------------------------------------------- io -----------------

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const readText = (file) => fs.readFileSync(file, 'utf8');
const readJson = (file) => JSON.parse(readText(file));
const rel = (file) => path.relative(REPO, file).split(path.sep).join('/');

function assert(condition, message) {
    if (!condition) throw new Error('gen-vectors: ' + message);
}

// Byte-exact JSONL: one JSON value per line, LF only, key order is construction order.
function writeJsonl(file, lines) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

function readJsonl(file) {
    return readText(file).split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
}

// RFC4180 reader: SPEC-ROWS.csv quotes predicates that contain commas and doubled quotes.
function csvParse(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    let pending = false;
    for (let i = 0; i < text.length; i += 1) {
        const c = text[i];
        if (quoted) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
            } else field += c;
            continue;
        }
        if (c === '"') { quoted = true; pending = true; continue; }
        if (c === ',') { row.push(field); field = ''; pending = false; continue; }
        if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; pending = false; continue; }
        if (c !== '\r') { field += c; pending = true; }
    }
    if (pending || row.length) { row.push(field); rows.push(row); }
    return rows;
}

// ----------------------------------------------------------------- seeded rng -------------

function rng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ------------------------------------------------------------------- inventory ------------

function specRows() {
    const rows = csvParse(readText(path.join(REPO, 'SPEC', 'SPEC-ROWS.csv')));
    const head = rows[0];
    return rows.slice(1)
        .filter((r) => r.length === head.length && r[0] !== '')
        .map((r) => {
            const row = {};
            head.forEach((name, i) => { row[name] = r[i]; });
            return row;
        });
}

const GEN_SOURCES = ['legacy/lib/buildArgs.js', 'legacy/lib/buildPresetIni.js'];
const isIniRow = (row) => row.file.indexOf('buildPresetIni') >= 0;
// Rows outside the two generators (the launchServer / launchModelPresets preludes: alert-and-return
// guards, response handling, catch clauses) cannot be flipped by a generator input at all.
const inDomain = (row) => GEN_SOURCES.indexOf(row.file) >= 0;
const isBaRow = (row) => /^BA-/.test(row.row_id);

// The predicate text of a row. `if (…)` / `else if (…)` rows carry the whole test; every other kind
// already IS the expression. loop-gate rows carry a loop header, which has no boolean test, so the
// iteration gate is expressed directly.
// A ternary row's branch is the FORK, not the truthiness of the whole expression: 'off' : 'on' is
// always a truthy string, so evaluating it would report a constant predicate and hide the branch.
// Returns the text before the top-level `?` (quote- and depth-aware, skipping `?.` and `??`).
function ternaryCondition(expr) {
    let depth = 0;
    let quote = null;
    for (let i = 0; i < expr.length; i += 1) {
        const c = expr[i];
        if (quote) {
            if (c === '\\') i += 1;
            else if (c === quote) quote = null;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
        if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') depth -= 1;
        else if (c === '?' && depth === 0 && expr[i + 1] !== '?' && expr[i + 1] !== '.') {
            return expr.slice(0, i).trim();
        }
    }
    return null;
}

function rowExpr(row) {
    if (row.kind === 'loop-gate') return 'Object.entries(configs).length > 0';
    if (row.kind === 'ternary') {
        const condition = ternaryCondition(row.code_snippet);
        assert(condition, row.row_id + ': no top-level ? in a ternary row: ' + row.code_snippet);
        return condition;
    }
    const guard = row.code_snippet.match(/^(?:else if|if) \(([\s\S]*)\)$/);
    return guard ? guard[1] : row.code_snippet;
}

const readsModel = (row) => /(^|;)(model\.[A-Za-z0-9_]+|modelPath)(;|$)/.test(row.vars_read);

// A row's expression, wrapped so one boolean answers "does this row's target fire for this input".
function rowTester(row) {
    const expr = readsModel(row)
        ? 'models.some(function (model) { return (' + rowExpr(row) + '); })'
        : rowExpr(row);
    const body = 'var config = S.config, fields = S.fields, configs = S.configs,'
        + ' modelPath = S.modelPath, models = S.models, specTypes = S.specTypes;'
        + 'return (' + expr + ');';
    /* eslint-disable no-new-func */
    const fn = new Function('S', body);
    /* eslint-enable no-new-func */
    return (scope) => {
        try {
            const value = fn(scope);
            return { value: !!value, threw: null };
        } catch (error) {
            return { value: null, threw: String(error && error.message) };
        }
    };
}

// specTypes is derived inside both generators; rows on specTypes.length are only evaluable with it
// in scope, so mirror the two push lines of the baseline source.
const specTypesOf = (config) => {
    const specTypes = [];
    if (config.ngramMod) specTypes.push('ngram-mod');
    if (config.speculationType !== 'none') specTypes.push(config.speculationType);
    return specTypes;
};

// ------------------------------------------------------------- field matrix ---------------

const readKeys = (source, prefix) => {
    const seen = [];
    const re = new RegExp('\\b' + prefix + '\\.([A-Za-z0-9_]+)', 'g');
    let match = re.exec(source);
    while (match) {
        if (seen.indexOf(match[1]) < 0) seen.push(match[1]);
        match = re.exec(source);
    }
    return seen;
};

function corpusConfigs() {
    return readJson(path.join(REPO, 'fixtures', 'corpus', 'configs.remapped.json'));
}

// The matrix: what buildArgs reads (source order), then what the ini generator and the real-state
// corpus add. Cross-checked two ways: every key either generator reads is present, and every key is
// present in real saved data or read by a generator — no invented fields, no dropped ones.
function fieldMatrix() {
    const argsKeys = readKeys(readText(path.join(REPO, 'legacy', 'lib', 'buildArgs.js')), 'fields');
    const iniKeys = readKeys(readText(path.join(REPO, 'legacy', 'lib', 'buildPresetIni.js')), 'config');
    const keys = argsKeys.slice();
    for (const key of corpusConfigs().reduce((all, row) => {
        for (const key of Object.keys(row.config)) if (all.indexOf(key) < 0) all.push(key);
        return all;
    }, [])) if (keys.indexOf(key) < 0) keys.push(key);
    for (const key of iniKeys) {
        assert(keys.indexOf(key) >= 0, 'buildPresetIni reads config.' + key + ' but the matrix has no such key');
    }
    return keys;
}

// Per-field metadata derived from the baseline markup, the recorded form states and the corpus:
// control kind, option lists, HTML defaults, and the value classes a vector may take.
function htmlFields() {
    const html = readText(path.join(REPO, 'public', 'index.html'));
    const out = new Map();
    for (const match of html.matchAll(/<(input|select)([^>]*)>/gs)) {
        const attrs = match[2];
        const id = (attrs.match(/id="([^"]+)"/) || [])[1];
        if (!id) continue;
        const tag = match[1];
        const type = (attrs.match(/type="([^"]+)"/) || [])[1] || null;
        const options = tag === 'select'
            ? [...html.match(
                new RegExp('<select[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)</select>'),
            )[1].matchAll(/value="([^"]*)"/g)].map((m) => m[1])
            : null;
        out.set(id, {
            id,
            tag,
            type,
            options,
            htmlDefault: (attrs.match(/value="([^"]*)"/) || [])[1] ?? null,
            min: (attrs.match(/min="([^"]*)"/) || [])[1] ?? null,
            max: (attrs.match(/max="([^"]*)"/) || [])[1] ?? null
        });
    }
    return out;
}

// Comparison literals mined out of the inventory: `config.minP == "0.00"`,
// `config.speculationType !== 'draft-mtp'`. A pool that cannot express the literal can never flip
// the row, so the literal is part of the field's value classes by construction.
function minedLiterals() {
    const byField = new Map();
    for (const row of specRows()) {
        const re = /(?:config|fields)\.([A-Za-z0-9_]+)\s*[!=]==?\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(-?[\d.]+))/g;
        let match = re.exec(row.code_snippet);
        while (match) {
            const raw = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4];
            const value = match[2] !== undefined || match[3] !== undefined
                ? raw.replace(/\\"/g, '"')
                : Number(raw);
            if (!byField.has(match[1])) byField.set(match[1], []);
            const pool = byField.get(match[1]);
            const literal = typeof value === 'number' ? String(value) : value;
            if (pool.indexOf(literal) < 0) pool.push(literal);
            match = re.exec(row.code_snippet);
        }
    }
    return byField;
}

const OBSERVED_CAP = 4;

function fieldMeta() {
    const html = htmlFields();
    const kinds = proof.fieldKinds();
    const mined = minedLiterals();
    const configs = corpusConfigs().map((row) => row.config);
    const meta = new Map();
    for (const id of fieldMatrix()) {
        const control = html.get(id) || null;
        const dom = kinds.has(id) ? kinds.get(id) : null;
        const observed = [];
        let absent = false;
        for (const config of configs) {
            if (!(id in config)) { absent = true; continue; }
            const value = JSON.stringify(config[id]);
            if (observed.indexOf(value) < 0) observed.push(value);
        }
        meta.set(id, {
            id,
            control,
            dom,
            kind: dom === 'checked' ? 'checkbox'
                : control && control.tag === 'select' ? 'select'
                    : control && control.type === 'number' ? 'number'
                        : control ? 'text' : 'stored',
            observed: observed.slice(0, OBSERVED_CAP).map((json) => JSON.parse(json)),
            observedAll: observed,
            absentInCorpus: absent,
            mined: mined.get(id) || []
        });
    }
    return meta;
}

// Recorded model paths, tokenized the same way the path pool is, so an mmproj-bearing vector matches
// a model set entry for real without carrying a machine path.
function modelPaths() {
    const out = [];
    for (const vector of proof.modelsVectors()) {
        for (const model of vector.models) {
            const path = tokenizePath(model.path);
            if (out.indexOf(path) < 0) out.push(path);
        }
    }
    return out;
}

function modelSets() {
    const recorded = proof.modelsVectors();
    const first = recorded[0].models.map(tokenizeModel);
    const sets = [
        { id: 'recorded', source: recorded[0].label + ' (scratch root tokenized as ' + SCRATCH_TOKEN + ')',
            models: first },
        { id: 'no-mmproj', source: recorded[0].label + ' (mmprojFile stripped)',
            models: first.map((m) => Object.assign({}, m, { mmprojFile: null })) },
        { id: 'empty', source: 'no /models payload (BA-100/INI-7 false side)', models: [] }
    ];
    for (const vector of recorded.slice(1)) {
        sets.push({ id: 'recorded-' + (sets.length), source: vector.label,
            models: vector.models.map(tokenizeModel) });
    }
    assert(sets[0].models.some((m) => m.mmprojFile), 'the recorded payload carries no mmprojFile');
    assert(!JSON.stringify(sets).includes(SCRATCH_MARK), 'a model set still carries the scratch root');
    return sets;
}

// The recorded settings blobs carry a modelsDirectory that points into the capture machine's scratch
// root. Neither generator reads it (buildArgs reads settings.serverPort and nothing else), so the
// scratch prefix is tokenized exactly like a model path: the port split that IS the assertion (Q5)
// stays byte-identical, and no machine path lands in fixtures/vectors.
function tokenizeSettings(settings) {
    const out = {};
    for (const [key, value] of Object.entries(settings)) {
        out[key] = typeof value === 'string' ? tokenizePath(value) : value;
    }
    return out;
}

function settingsSets() {
    const blobs = proof.settingsVectors(proof.storageBlobs());
    const sets = blobs.slice().sort((a, b) => (a.label < b.label ? -1 : 1))
        .map((vector, index) => ({
            id: 'settings-' + index,
            port: String(vector.settings.serverPort),
            settings: tokenizeSettings(vector.settings),
            source: vector.label
        }));
    assert(sets.length > 1, 'expected the recorded 8080/7838 split (Q5), found ' + sets.length);
    assert(!JSON.stringify(sets).includes(SCRATCH_MARK), 'a settings set still carries the scratch root');
    return sets;
}

// The reference vector: the recorded fresh-page form state. Every flip in the coverage map is
// relative to this input, and it is itself the opposite-side witness for each flippable row.
function referenceFields() {
    const { states, kinds } = proof.formStates();
    const fresh = states.find((state) => state.label.endsWith('fresh'));
    assert(fresh, 'the recorded form states have no fresh state');
    const fields = {};
    for (const id of fieldMatrix()) {
        if (!(id in fresh.fields)) continue;
        fields[id] = kinds.get(id) === 'checked' ? Boolean(fresh.fields[id]) : fresh.fields[id];
    }
    return fields;
}

// A vector's `fields` is the SAVED-CONFIG shape (verbatim types, nulls, omissions — Q16/Q19). The
// launch path never hands those to buildArgs directly: loadConfiguration fills the form first, so
// the argv input is that saved config overlaid on the recorded fresh state (the same recorded
// helper the behavior-preservation proof uses, raw=true keeps the stored type).
function argvFields(vector, gen) {
    const { kinds } = proof.formStates();
    const base = referenceFields();
    return proof.fieldsFromConfig(base, kinds, vector.fields, true);
}

function iniConfigs(vector) {
    if (vector.ini_configs) return vector.ini_configs;
    return { [vector.name]: vector.fields };
}

// ----------------------------------------------------------- predicate table ------------

// Build the two scopes a row can be evaluated against: buildArgs works on the config literal it
// derives from the DOM, buildPresetIni on the saved config itself.
function scopesFor(vector, gen, models, settings) {
    const fields = argvFields(vector, gen);
    const run = proof.runBaselineArgv(gen, fields, settings, models);
    const configs = iniConfigs(vector);
    const entries = Object.entries(configs);
    const saved = entries.length ? entries[0][1] : {};
    return {
        ba: {
            config: run.config,
            fields,
            configs,
            modelPath: String(fields.modelPath == null ? '' : fields.modelPath).trim(),
            models,
            specTypes: specTypesOf(run.config)
        },
        ini: {
            config: saved,
            fields,
            configs,
            modelPath: saved.modelPath,
            models,
            specTypes: specTypesOf(saved)
        }
    };
}

function predicateTable(rows, vectors, gen, modelsById, settingsSetsById) {
    const testers = new Map(rows.map((row) => [row.row_id, rowTester(row)]));
    const table = new Map();
    const problems = [];
    for (const vector of vectors) {
        const models = modelsById.get(vector.models);
        const settings = settingsSetsById.get(vector.settings).settings;
        const scopes = scopesFor(vector, gen, models, settings);
        const values = {};
        for (const row of rows) {
            const scope = isIniRow(row) ? scopes.ini : scopes.ba;
            const out = testers.get(row.row_id)(scope);
            values[row.row_id] = out.threw ? null : out.value;
            if (out.threw && vector.id === 'boundary-default') {
                problems.push(row.row_id + ': ' + out.threw + ' :: ' + rowExpr(row));
            }
        }
        table.set(vector.id, values);
    }
    return { table, problems };
}

// ------------------------------------------------------ value classes -------------------

const MAX_CLASSES = 5;
const THREE_WISE = ['speculationType', 'ngramMod', 'draftModelPath', 'specDraftNMax', 'ngld',
    'ctkd', 'ctvd'];

// Model paths come from recorded /models payloads, so an mmproj flag in a golden is a recorded
// association, not a guess. Two transforms are applied to those recorded strings, and both are
// input-side only (a golden is still whatever the baseline makes of the tokenized input):
//  * the per-machine scratch root is replaced by the opaque token SCRATCH_ROOT, so no vector, no
//    INPUTS entry and no golden carries a personal path (fixtures/corpus already arrives tokenized as
//    FIXTURE_ROOT, from PATH-MAP.json);
//  * a username-free literal absolute path pair (C:/parity-fixture, C:\parity-fixture) is added, so
//    raw absolute paths and Q20's separator sensitivity stay covered next to the tokenized ones.
// The generators treat a path as an opaque string except for the --chat-template-file regex, which
// keys on separators, not on any prefix — so tokenizing cannot change which branch runs.
const SCRATCH_TOKEN = 'SCRATCH_ROOT';
const SCRATCH_MARK = 'parity-scratch';
const LITERAL_PATHS = ['C:/parity-fixture/models/a/model-a.gguf',
    'C:\\parity-fixture\\models\\a\\model-a.gguf'];

function tokenizePath(uploaded) {
    const at = uploaded.lastIndexOf(SCRATCH_MARK);
    if (at < 0) return uploaded;
    return SCRATCH_TOKEN + uploaded.slice(at + SCRATCH_MARK.length);
}

// path + mmprojFile are the only two fields either generator reads from a /models entry.
function tokenizeModel(model) {
    return Object.assign({}, model, { path: tokenizePath(model.path),
        mmprojFile: model.mmprojFile ? tokenizePath(model.mmprojFile) : null });
}

function pathPool() {
    const recorded = proof.modelsVectors().flatMap((vector) => vector.models)
        .map(tokenizeModel);
    const withMmproj = recorded.filter((model) => model.mmprojFile).map((model) => model.path);
    const without = recorded.filter((model) => !model.mmprojFile).map((model) => model.path);
    const pool = [];
    for (const p of [...withMmproj, ...without]) if (pool.indexOf(p) < 0) pool.push(p);
    const out = [pool[0], pool[0].split('\\').join('/'), LITERAL_PATHS[0], LITERAL_PATHS[1]];
    for (const p of out) vectors_assert(p.indexOf(SCRATCH_MARK) < 0, 'pathPool leaked a scratch root: ' + p);
    return out.filter((p, i, all) => all.indexOf(p) === i);
}

function vectors_assert(condition, message) {
    if (!condition) throw new Error('gen-vectors: ' + message);
}

function classesFor(meta) {
    const pool = [];
    const push = (value) => {
        const key = JSON.stringify(value) === undefined ? 'undefined' : JSON.stringify(value);
        if (!pool.some((c) => (JSON.stringify(c) === undefined ? 'undefined' : JSON.stringify(c)) === key)) {
            pool.push(value);
        }
    };
    if (meta.kind === 'checkbox') {
        push(false); push(true);
    } else if (meta.kind === 'select') {
        // '' is a live class for every select: assigning a retired saved value to a <select> blanks it
        // (Q18), and saveCurrentValues persists the blank, so the generators really do see it.
        push('');
        if (meta.id === 'modelPath' || meta.id === 'draftModelPath') {
            for (const p of pathPool()) push(p);
        } else {
            for (const option of meta.control.options || []) push(option);
        }
        for (const literal of meta.mined) push(literal);
    } else if (meta.kind === 'number') {
        push(''); push('0');
        if (meta.control && meta.control.htmlDefault !== null) push(meta.control.htmlDefault);
        push('-1');
        for (const literal of meta.mined) push(literal);
        for (const value of meta.observed) push(typeof value === 'number' ? String(value) : value);
    } else if (meta.kind === 'text') {
        push('');
        if (meta.control && meta.control.htmlDefault !== null) push(meta.control.htmlDefault);
        for (const value of meta.observed) push(value);
        if (meta.id === 'modelPath' || meta.id === 'serverPath') for (const p of pathPool()) push(p);
    } else {
        for (const value of meta.observed) push(value);
        push(false); push(true);
    }
    const classes = pool.slice(0, MAX_CLASSES);
    // Key absence is an observed class (28/48 real configs have no cacheRam, 22 have no minP), and
    // it is the only way to flip the `config.X !== undefined` guards in the ini generator.
    if (meta.absentInCorpus || meta.kind !== 'stored') classes.push(OMIT);
    return classes;
}

function buildClasses(metaMap) {
    const classes = new Map();
    for (const [id, meta] of metaMap) classes.set(id, classesFor(meta));
    return classes;
}

// ------------------------------------------------------- covering arrays ----------------

const combinations = (items, size) => {
    const out = [];
    const walk = (start, chosen) => {
        if (chosen.length === size) { out.push(chosen.slice()); return; }
        for (let i = start; i < items.length; i += 1) { chosen.push(items[i]); walk(i + 1, chosen); chosen.pop(); }
    };
    walk(0, []);
    return out;
};

const cartesian = (lists) => lists.reduce((rows, list) => {
    const out = [];
    for (const row of rows) for (const value of list) out.push(row.concat([value]));
    return out;
}, [[]]);

// Greedy covering array over pool INDICES: repeatedly take the first still-uncovered strength-tuple,
// pin it, and fill the remaining positions with the values that cover the most other tuples. Each
// iteration removes at least the pinned tuple, so this terminates; the full-cover assertion in the
// caller is what proves it covered everything rather than stopping early.
function coveringArray(pools, strength) {
    const size = pools.length;
    const subs = combinations(pools.map((_, index) => index), strength);
    const required = new Set();
    const tupleKey = (positions, values) => {
        const order = positions.map((position, index) => [position, values[index]])
            .sort((a, b) => a[0] - b[0]);
        return order.map((entry) => entry[0]).join(',') + '|' + order.map((entry) => entry[1]).join(',');
    };
    for (const sub of subs) {
        for (const combo of cartesian(sub.map((index) => pools[index].map((_, value) => value)))) {
            required.add(tupleKey(sub, combo));
        }
    }
    const rows = [];
    while (required.size > 0 && rows.length < 5000) {
        const pinned = required.values().next().value;
        const parts = pinned.split('|');
        const positions = parts[0].split(',').map(Number);
        const values = parts[1].split(',').map(Number);
        const row = new Array(size).fill(null);
        positions.forEach((position, index) => { row[position] = values[index]; });
        for (let p = 0; p < size; p += 1) {
            if (row[p] !== null) continue;
            const filled = [];
            for (let q = 0; q < size; q += 1) if (row[q] !== null) filled.push(q);
            const anchors = combinations(filled, strength - 1);
            let bestValue = 0;
            let bestCount = -1;
            for (let v = 0; v < pools[p].length; v += 1) {
                let count = 0;
                for (const anchor of anchors) {
                    if (required.has(tupleKey([p].concat(anchor), [v].concat(anchor.map((q) => row[q]))))) {
                        count += 1;
                    }
                }
                if (count > bestCount) { bestCount = count; bestValue = v; }
            }
            row[p] = bestValue;
        }
        for (const sub of subs) required.delete(tupleKey(sub, sub.map((index) => row[index])));
        rows.push(row);
    }
    return { rows, uncovered: required.size };
}

// ------------------------------------------------------------------ vectors --------------

const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');

// fieldsFor: pool index -> saved-config shape; OMIT drops the key entirely.
function fieldsFor(keys, classes, assignment) {
    const fields = {};
    keys.forEach((key, index) => {
        const value = classes.get(key)[assignment[index]];
        if (value !== OMIT) fields[key] = value;
    });
    return fields;
}

function makeVector(id, family, name, fields, extra) {
    return { kind: 'vector', id, family, name, targets: [], fields,
        settings: (extra && extra.settings) || 'settings-default',
        models: (extra && extra.models) || 'recorded',
        ...(extra && extra.ini_configs ? { ini_configs: extra.ini_configs } : {}),
        ...(extra && extra.note ? { note: extra.note } : {}),
        ...(extra && extra.probe ? { probe: extra.probe } : {}) };
}

// Single-vector predicate pass: the row values an input produces, for synthesis and for the random
// family's "does this assert anything?" check.
function rowValues(context, vector) {
    const models = context.modelsById.get(vector.models);
    const settings = context.settingsById.get(vector.settings).settings;
    const scopes = scopesFor(vector, context.gen, models, settings);
    const values = {};
    for (const row of context.rows) {
        const out = context.testers.get(row.row_id)(isIniRow(row) ? scopes.ini : scopes.ba);
        values[row.row_id] = out.threw ? null : out.value;
    }
    return values;
}

function candidateFieldsOf(row, keys) {
    const direct = [];
    for (const entry of row.vars_read.split(';')) {
        const match = entry.match(/^(?:config|fields)\.([A-Za-z0-9_]+)$/);
        if (match && keys.indexOf(match[1]) >= 0 && direct.indexOf(match[1]) < 0) direct.push(match[1]);
    }
    if (direct.length) return direct;
    if (/modelPath/.test(row.vars_read)) return ['modelPath'];
    return keys;
}

// Find the smallest change to the reference input that flips one row's predicate to `want`. Only the
// row's own expression is evaluated, so an `&&` operand row can be flipped on its own even though
// the enclosing guard short-circuits. Returns null when the predicate takes that value for no input
// of the generator, which is a machine-found equivalent branch, not a gap in the search.
// The one row a synthesizer is chasing, without the full pass rowValues does.
function oneRowValue(context, vector, row) {
    const models = context.modelsById.get(vector.models);
    const settings = context.settingsById.get(vector.settings).settings;
    const scopes = scopesFor(vector, context.gen, models, settings);
    const out = context.testers.get(row.row_id)(isIniRow(row) ? scopes.ini : scopes.ba);
    return out.threw ? null : out.value;
}

const directFieldsOf = (row) => {
    const out = [];
    for (const entry of row.vars_read.split(';')) {
        const match = entry.match(/^(?:config|fields)\.([A-Za-z0-9_]+)$/);
        if (match && out.indexOf(match[1]) < 0) out.push(match[1]);
    }
    return out;
};

// The second, weaker attribution a vector can earn: it does not flip any predicate, but it evaluates
// a row's test with a value of that row's own field that no other outcome-change provides. Format
// probes live here — their assertion is the emitted bytes (the coercion-shim's targets, plan Part 2
// item 3), not a branch outcome. Only used when a vector has no flip at all, so the strict relation
// stays the primary content of coverage-map.json.
function exerciseTargets(context, vector, referenceVector) {
    const changed = context.keys.filter((key) => {
        const mine = JSON.stringify(vector.fields[key]);
        const theirs = JSON.stringify(referenceVector.fields[key]);
        return mine !== theirs || (key in vector.fields) !== (key in referenceVector.fields);
    });
    const modelsChanged = vector.models !== referenceVector.models;
    return context.rows.filter((row) => (modelsChanged && readsModel(row))
        || directFieldsOf(row).some((key) => changed.indexOf(key) >= 0)).map((row) => row.row_id);
}

function synthesize(context, row, referenceValues) {
    const want = !referenceValues[row.row_id];
    if (referenceValues[row.row_id] === null) return null;
    const ref = referenceFields();
    const probe = (fields, extra) => {
        const vector = makeVector('probe', 'probe', 'probe', fields,
            { settings: context.defaultSettings, ...(extra || {}) });
        return oneRowValue(context, vector, row) === want ? vector : null;
    };
    if (row.kind === 'loop-gate') {
        if (want) return null;
        const empty = probe(Object.assign({}, ref), { ini_configs: {} });
        return empty ? { vector: empty, mutations: 0 } : null;
    }
    const candidates = candidateFieldsOf(row, context.keys).filter((key) => context.classes.has(key));
    const pools = candidates.map((key) => context.classes.get(key).concat([OMIT]));
    const apply = (picks) => {
        const fields = Object.assign({}, ref);
        candidates.forEach((key, index) => {
            if (picks[index] === OMIT) delete fields[key]; else fields[key] = picks[index];
        });
        return fields;
    };
    // 1. one field, in matrix order; 2. the full product over the fields the predicate reads;
    // 3. a different recorded /models payload (the mmproj rows have no field to turn).
    for (let i = 0; i < candidates.length; i += 1) {
        for (const value of pools[i]) {
            const picks = candidates.map((key, index) => (index === i ? (value === OMIT ? OMIT : value) : ref[key] === undefined ? OMIT : ref[key]));
            const found = probe(apply(picks));
            if (found) return { vector: found, mutations: 1 };
        }
    }
    // A full product only over the few fields a predicate actually reads; the fallback candidate set
    // is the whole matrix, whose product is not enumerable.
    const productSize = pools.reduce((total, pool) => total * pool.length, 1);
    if (candidates.length <= 4 && productSize <= 20000) {
        for (const picks of cartesian(pools)) {
            const found = probe(apply(picks));
            if (found) return { vector: found, mutations: candidates.length };
        }
    }
    for (const models of context.modelsById.keys()) {
        const found = probe(Object.assign({}, ref), { models });
        if (found) return { vector: found, mutations: 0 };
    }
    return null;
}

function boundaryVectors(context) {
    const ref = referenceFields();
    const paths = pathPool();
    const add = (id, note, mutate, extra) => {
        const fields = Object.assign({}, ref);
        for (const [key, value] of Object.entries(mutate || {})) {
            if (value === OMIT) delete fields[key]; else fields[key] = value;
        }
        context.vectors.push(makeVector('boundary-' + id, 'boundary', 'boundary-' + id, fields,
            Object.assign({ settings: context.defaultSettings, note }, extra || {})));
    };

    // §9 / §9A quirks, named by the quirk they freeze. Each one is a minimal delta on the reference.
    add('temp-0-emitted', 'temp 0 is emitted (--temp 0), unlike topK 0', { temp: '0' });
    add('temp-blank-emits-zero', 'temp "" coerces through parseFloat||0 to 0 and is still emitted', { temp: '' });
    add('temp-negative-dropped', 'temp -1 fails `>= 0` and drops the flag', { temp: '-1' });
    add('topk-0-dropped', 'topK 0 fails `> 0` and drops the flag', { topK: '0' });
    add('topk-negative', 'Q22 topK -1 occurs in real data', { topK: '-1' });
    add('ngl-zero', 'Q22 ngl 0 in real data: -ngl absent, ini ngl = absent', { ngl: '0' });
    add('ngl-hundred', 'Q22 ngl 100 in real data', { ngl: '100' });
    add('topp-zero', 'Q22 topP 0 is emitted (--top-p 0) because the guard is >= 0', { topP: '0' });
    for (const form of ['0', '0.0', '0.00']) {
        add('minp-' + slug(form), 'Q19 minP zero form "' + form + '": only "0.00" re-enters via the == "0.00" arm', { minP: form });
    }
    add('minp-number-0', 'Q19 the stored type is the number 0, not the string "0"', { minP: 0 });
    for (const form of ['0', '0.0', '0.00']) {
        add('repeat-penalty-' + slug(form), 'Q19 repeatPenalty zero form "' + form + '"', { repeatPenalty: form });
    }
    add('repeat-penalty-number-0', 'Q19 number 0 among 22 number instances', { repeatPenalty: 0 });
    add('repeat-penalty-string-0', 'Q19 string "0" among 26 string instances', { repeatPenalty: '0' });
    for (const form of ['0', '0.0', '0.00']) {
        add('presence-penalty-' + slug(form), 'Q19 presencePenalty zero form "' + form + '"', { presencePenalty: form });
    }
    add('presence-penalty-number-0', 'Q19 number 0', { presencePenalty: 0 });
    add('fast-attention-on', 'Q9 select read through .value: -fa on', { fastAttention: 'on' });
    add('fast-attention-off', 'Q9 -fa off', { fastAttention: 'off' });
    add('fast-attention-blank', 'Q9 a blank select value drops -fa entirely', { fastAttention: '' });
    add('draft-mtp-with-draft-path', 'draft-mtp suppresses -md even with a draft path',
        { speculationType: 'draft-mtp', draftModelPath: paths[1] });
    add('draft-mtp-no-draft-path', 'draft-mtp with no draft path',
        { speculationType: 'draft-mtp', draftModelPath: '' });
    add('draft-dflash-with-draft-path', 'a non-mtp speculation type emits -md -ngld -ctkd -ctvd',
        { speculationType: 'draft-dflash', draftModelPath: paths[1], ngld: '2' });
    add('draft-dspark-with-draft-path', 'draft-dspark takes the same -md branch',
        { speculationType: 'draft-dspark', draftModelPath: paths[1] });
    add('ngram-mod-only', 'Q15 ngram-mod alone emits --spec-type ngram-mod + hard-coded 24/48/64',
        { ngramMod: true });
    add('ngram-mod-with-speculation', 'Q15 ngram-mod prepends itself to the spec-type list',
        { ngramMod: true, speculationType: 'draft-dflash', draftModelPath: paths[1] });
    add('spec-draft-n-max', '--spec-draft-n-max needs speculationType != none',
        { specDraftNMax: '4', speculationType: 'draft-dflash', draftModelPath: paths[1] });
    add('spec-draft-n-max-none-type', 'the same n-max with type none emits nothing',
        { specDraftNMax: '4', speculationType: 'none' });
    add('legacy-disable-reasoning-true', 'Q17 ini emits `reasoning = off` while argv omits --reasoning',
        { reasoning: OMIT, disableReasoning: true });
    add('legacy-disable-reasoning-false', 'Q17 the false side writes `reasoning = on`, argv still silent',
        { reasoning: OMIT, disableReasoning: false });
    add('reasoning-off', '--reasoning off', { reasoning: 'off' });
    add('reasoning-on', '--reasoning on', { reasoning: 'on' });
    add('cache-ram-blank', 'cacheRam "" is parseInt NaN: no --cache-ram, no ini cache-ram', { cacheRam: '' });
    add('cache-ram-minus-one', 'cacheRam -1 = no limit, still emitted', { cacheRam: '-1' });
    add('cache-ram-zero', 'cacheRam 0 = disable, emitted', { cacheRam: '0' });
    add('cache-ram-absent', 'the ini guard is `!== undefined`; 28/48 real configs omit the key', { cacheRam: OMIT });
    add('ngld-zero-with-draft', 'ngld 0 satisfies `>= 0`, so -ngld 0 and ini ngld = 0 are emitted',
        { draftModelPath: paths[1], speculationType: 'draft-dflash', ngld: '0' });
    add('ngld-absent-with-draft', 'ngld omitted: argv re-coerces to 0, the ini key disappears',
        { draftModelPath: paths[1], speculationType: 'draft-dflash', ngld: OMIT });
    add('ctk-enabled', '-ctk/-ctv require ctkEnable AND both values', { ctkEnable: true });
    add('ctk-enabled-blank-value', 'an empty contextTokenValue drops both flags',
        { ctkEnable: true, contextTokenValue: '' });
    add('ctk-enabled-blank-key', 'an empty contextTokenKey drops both flags',
        { ctkEnable: true, contextTokenKey: '' });
    add('chat-template-file-slashes', 'Q20 a /-separated model path still yields a \\-joined template file',
        { loadCustomChatTemplate: true, modelPath: paths[0].split('\\').join('/') });
    add('chat-template-file-backslashes', 'Q20 the same path in \\ style',
        { loadCustomChatTemplate: true, modelPath: paths[0] });
    add('chat-template-kwargs', '--chat-template-kwargs is forwarded verbatim after .trim()',
        { chatTemplateKwargs: '{"preserve_thinking": true, "reasoning_effort": "xhigh"}' });
    add('literal-path-chat-template-forward', 'Q20 a raw absolute /-separated path, no token: the derived '
        + 'template path still uses \\',
        { loadCustomChatTemplate: true, modelPath: LITERAL_PATHS[0] });
    add('literal-path-chat-template-backslash', 'Q20 the same raw path in \\ style',
        { loadCustomChatTemplate: true, modelPath: LITERAL_PATHS[1] });
    add('all-checkbox-flags', 'every checkbox flag set at once', { swaFull: true, cpuMoe: true, jinja: true,
        verbose: true, backendSampling: true, noKvOffload: true, noMmprojOffload: true });
    add('nothing-set', 'Q14 -fit off / --host 0.0.0.0 / --port are appended whatever the form says',
        { ngl: '', threads: '', temp: '', topK: '', topP: '', minP: '', repeatPenalty: '',
            presencePenalty: '', parallel: '', loadMode: '', contextSize: '', nCpuMoe: '',
            cacheRam: '', fastAttention: '', specDraftNMax: '', ngld: '', ctkd: '', ctvd: '',
            swaFull: false, cpuMoe: false, jinja: false, verbose: false, backendSampling: false,
            noKvOffload: false, noMmprojOffload: false, ctkEnable: false, reasoning: '',
            speculationType: '', ngramMod: false, loadCustomChatTemplate: false });
    add('ini-empty-configs', 'INI-5 false side: no sections at all, only the version header',
        {}, { ini_configs: {} });
    add('orphan-keys-only', 'Q16 the eight orphan keys are carried by the input and ignored by both generators',
        { mlock: true, noMmap: true, ndio: true, dio: true, draftMin: 5, draftMax: 10, draftPMin: 0.1,
            disableReasoning: true, modelPath: paths[0] });
    add('retired-enum-values', 'Q18 option values outside the current dropdowns are emitted as-is by the generators',
        { loadMode: 'dio', ctkd: 'kvarn5', ctvd: 'kvarn8', speculationType: 'draft-dspark',
            draftModelPath: paths[1] });
    add('broken-draft-path', 'Q21 a truthy draft path ending in \\undefined is emitted verbatim',
        { draftModelPath: LITERAL_PATHS[1] + '\\undefined', speculationType: 'draft-dflash' });
    add('ini-type-drift', 'Q19/Q22 stored types mixed in one config: numbers where strings are usual and back',
        { repeatPenalty: 1.05, presencePenalty: '0.00', topK: 0, ngl: 100, temp: '0.70', parallel: '0' });
    add('ini-numeric-keys-absent', 'every ini guard whose shape is `!== undefined`',
        { temp: OMIT, topK: OMIT, topP: OMIT, ngl: OMIT, threads: OMIT, nCpuMoe: OMIT,
            noKvOffload: OMIT, noMmprojOffload: OMIT, cacheRam: OMIT, jinja: OMIT,
            loadCustomChatTemplate: OMIT, verbose: OMIT, backendSampling: OMIT, ngld: OMIT,
            draftModelPath: paths[1], speculationType: 'draft-dflash' });
    add('mmproj-recorded-match', 'the --mmproj / ini mmproj association against a recorded /models payload',
        { modelPath: paths[0] });
    add('mmproj-payload-without-mmproj', 'the same payload with every mmprojFile nulled',
        { modelPath: paths[0] }, { models: 'no-mmproj' });
    add('mmproj-no-payload', 'no /models payload: no --mmproj, no ini mmproj line',
        { modelPath: paths[0] }, { models: 'empty' });
    const alt = context.settingsSets.find((set) => set.port !== '7838');
    if (alt) add('port-8080', 'Q5 --port follows settings.serverPort, not the manager port',
        {}, { settings: alt.id });

    // One vector per predicate flip the inventory can express: for every row, the opposite outcome
    // from the reference, found by searching the fields the row actually reads.
    const referenceValues = rowValues(context, context.vectors[0]);
    context.referenceValues = referenceValues;
    let synthesized = 0;
    const unfound = [];
    for (const row of context.rows) {
        if (referenceValues[row.row_id] === null) {
            unfound.push(row.row_id + ': predicate does not evaluate from vector inputs');
            continue;
        }
        const found = synthesize(context, row, referenceValues);
        if (!found) { unfound.push(row.row_id + ': predicate is ' + referenceValues[row.row_id]
            + ' for every input in the field domain'); continue; }
        const vector = found.vector;
        vector.id = 'boundary-' + row.row_id.toLowerCase() + '-' + (referenceValues[row.row_id] ? 'false' : 'true');
        vector.family = 'boundary';
        vector.name = vector.id;
        vector.note = 'flip ' + row.row_id + ' (' + row.kind + ') to ' + !referenceValues[row.row_id]
            + ': ' + row.code_snippet;
        vector.flip = { row_id: row.row_id, outcome: !referenceValues[row.row_id], mutations: found.mutations };
        context.vectors.push(vector);
        synthesized += 1;
    }
    context.rowSynthesis = { synthesized, unfound };
}

// --------------------------------------------------------- format probes ----------------

// The plan's §2.3 probe list. `parseInt("0x10")` / `parseFloat("0.7xyz")` are recorded as the
// expressions and pinned by the value V8 produces, which is exactly what Part 2's coercion-shim has
// to reproduce; each probe is fed in both shapes the app can produce — the native stored type
// (localStorage, Q19) and the DOM string form.
const PROBES = [
    { label: '0.00', native: '0.00', string: '0.00' },
    { label: '-0', native: -0, string: '-0' },
    { label: '0.1', native: 0.1, string: '0.1' },
    { label: '1e21', native: 1e21, string: '1e21' },
    { label: '1e-7', native: 1e-7, string: '1e-7' },
    { label: '0.30000000000000004', native: 0.30000000000000004, string: '0.30000000000000004' },
    { label: '9007199254740993', native: 9007199254740993, string: '9007199254740993' },
    { label: '1.005', native: 1.005, string: '1.005' },
    { label: 'parseInt("0x10")', native: 16, string: '16' },
    { label: 'parseFloat("0.7xyz")', native: 0.7, string: '0.7' },
    { label: 'null', native: null, string: null },
    { label: 'undefined', native: OMIT, string: OMIT },
    { label: 'true', native: true, string: 'true' },
    { label: '"  8  "', native: '  8  ', string: '  8  ' },
    { label: '"1e3"', native: '1e3', string: '1e3' }
];

// Which fields a probe may enter, derived from the generator source rather than guessed: the keys
// whose config entry coerces (parseInt/parseFloat), the loose `!= "0"` comparison keys, and the
// `.trim()` keys (string-shaped probes only — the DOM never hands those anything else).
function formatTargets() {
    const source = readText(path.join(REPO, 'legacy', 'lib', 'buildArgs.js'));
    const coerced = [];
    const trimmed = [];
    for (const match of source.matchAll(/^ {12}([A-Za-z0-9_]+): (.*)$/gm)) {
        if (/parseInt\(|parseFloat\(/.test(match[2])) coerced.push(match[1]);
        if (/\.trim\(\)/.test(match[2])) trimmed.push(match[1]);
    }
    const loose = [];
    for (const row of specRows()) {
        const match = row.code_snippet.match(/(?:config|fields)\.([A-Za-z0-9_]+)\s*[!=]=\s*"/);
        if (match && loose.indexOf(match[1]) < 0) loose.push(match[1]);
    }
    return { coerced, trimmed, loose };
}

function formatVectors(context) {
    const ref = referenceFields();
    const targets = formatTargets();
    const numeric = targets.coerced.concat(targets.loose.filter((key) => targets.coerced.indexOf(key) < 0));
    for (const probe of PROBES) {
        for (const form of ['native', 'string']) {
            const value = probe[form];
            if (form === 'string' && (value === OMIT || typeof value !== 'object')
                && typeof value !== 'string' && value !== null) continue;
            const label = probe.label + (form === 'native' ? ':stored' : ':dom');
            for (const key of numeric) {
                const fields = Object.assign({}, ref);
                if (value === OMIT) delete fields[key]; else fields[key] = value;
                context.vectors.push(makeVector('format-' + slug(key) + '-' + slug(label), 'format',
                    'format-' + slug(key) + '-' + slug(label), fields, {
                        settings: context.defaultSettings,
                        note: 'format probe ' + probe.label + ' through ' + key + ' (' + label + ')',
                        probe: { probe: probe.label, form, field: key,
                            value: value === OMIT ? '<omit key>' : value }
                    }));
            }
            for (const key of targets.trimmed) {
                if (typeof value !== 'string') continue;
                const fields = Object.assign({}, ref);
                fields[key] = value;
                context.vectors.push(makeVector('format-' + slug(key) + '-' + slug(label), 'format',
                    'format-' + slug(key) + '-' + slug(label), fields, {
                        settings: context.defaultSettings,
                        note: 'format probe ' + probe.label + ' through ' + key + ' (.trim() surface)',
                        probe: { probe: probe.label, form, field: key, value }
                    }));
            }
        }
    }
}

// ----------------------------------------------------------- combinatorial ---------------

function coverVectors(context) {
    const keys = context.keys;
    const pools = keys.map((key) => context.classes.get(key));
    const two = coveringArray(pools, 2);
    assert(two.uncovered === 0, 'the 2-wise array left ' + two.uncovered + ' pairs uncovered');
    two.rows.forEach((row, index) => {
        const fields = fieldsFor(keys, context.classes, row);
        context.vectors.push(makeVector('cover2-' + String(index).padStart(3, '0'), 'cover',
            'cover2-' + String(index).padStart(3, '0'), fields, {
                settings: context.defaultSettings,
                note: '2-wise row ' + index + ' over ' + keys.length + ' fields'
            }));
    });
    const threeKeys = THREE_WISE.filter((key) => context.classes.has(key));
    assert(threeKeys.length === THREE_WISE.length, 'a 3-wise field is missing from the matrix');
    const three = coveringArray(threeKeys.map((key) => context.classes.get(key)), 3);
    assert(three.uncovered === 0, 'the 3-wise array left ' + three.uncovered + ' triples uncovered');
    three.rows.forEach((row, index) => {
        const fields = {};
        threeKeys.forEach((key, position) => {
            const value = context.classes.get(key)[row[position]];
            if (value !== OMIT) fields[key] = value;
        });
        context.vectors.push(makeVector('cover3-' + String(index).padStart(3, '0'), 'cover',
            'cover3-' + String(index).padStart(3, '0'), fields, {
                settings: context.defaultSettings,
                note: '3-wise row ' + index + ' over ' + threeKeys.join(',')
            }));
    });
    context.cover = { two: two.rows.length, three: three.rows.length };
}

// A 3-wise row is a legal saved config on its own (a real config rarely names all 44 keys), so the
// 3-wise family carries only the seven fields it is about.

function randomVectors(context) {
    const random = rng(SEED);
    const keys = context.keys;
    const pools = keys.map((key) => context.classes.get(key));
    const reference = referenceFields();
    let drawn = 0;
    for (let emitted = 0; emitted < RANDOM_VECTORS; emitted += 1) {
        let vector = null;
        while (!vector) {
            drawn += 1;
            if (drawn > RANDOM_VECTORS * 20) throw new Error('gen-vectors: ' + drawn + ' random draws produced no new predicate flip');
            const fields = {};
            keys.forEach((key, index) => {
                const pool = pools[index];
                const value = random() < 0.25 && key in reference ? reference[key]
                    : pool[Math.floor(random() * pool.length)];
                if (value !== OMIT) fields[key] = value;
            });
            const candidate = makeVector('random-' + String(emitted).padStart(4, '0'), 'random',
                'random-' + String(emitted).padStart(4, '0'), fields,
                { settings: context.defaultSettings, note: 'seeded random draw ' + drawn + ' (seed ' + SEED + ')' });
            // A vector whose every predicate matches the reference asserts nothing new; redraw rather
            // than ship 1500 lines of near-copies of the reference.
            const values = rowValues(context, candidate);
            if (context.rows.some((row) => values[row.row_id] !== null
                && values[row.row_id] !== context.referenceValues[row.row_id])) vector = candidate;
        }
        context.vectors.push(vector);
    }
    context.randomDraws = drawn;
}

function corpusVectors(context) {
    for (const entry of corpusConfigs()) {
        const id = 'corpus-' + slug(entry.name);
        context.vectors.push(makeVector(id, 'corpus', entry.name, entry.config, {
            settings: context.defaultSettings,
            note: 'real saved config, verbatim: ' + entry.name
        }));
    }
}

// ----------------------------------------------------- coverage and output --------------


function build() {
    const gen = proof.slicedGenerators();
    const all = specRows();
    const rows = all.filter(inDomain);
    const outRows = all.filter((row) => !inDomain(row) && /^(BA|INI)-/.test(row.row_id));
    const metaMap = fieldMeta();
    const keys = fieldMatrix();
    const classes = buildClasses(metaMap);
    const sets = settingsSets();
    const defaultSettings = (sets.find((set) => set.port === '7838') || sets[0]).id;
    const vectors = [];
    const reference = makeVector('boundary-default', 'boundary', 'boundary-default', referenceFields(),
        { settings: defaultSettings,
            note: 'recorded fresh-page form state; the reference every flip is measured against' });
    vectors.push(reference);

    const context = {
        gen, rows, keys, classes, metaMap, settingsSets: sets, defaultSettings, vectors,
        testers: new Map(rows.map((row) => [row.row_id, rowTester(row)])),
        modelsById: new Map(modelSets().map((set) => [set.id, set.models])),
        settingsById: new Map(sets.map((set) => [set.id, set]))
    };
    boundaryVectors(context);
    formatVectors(context);
    coverVectors(context);
    randomVectors(context);
    corpusVectors(context);

    // One predicate pass over the whole set; targets and the coverage map fall out of it.
    const { table, problems } = predicateTable(rows, vectors, gen, context.modelsById,
        context.settingsById);
    const referenceValues = table.get(reference.id);
    for (const vector of vectors) {
        const values = table.get(vector.id);
        vector.targets = vector.id === reference.id
            ? rows.filter((row) => values[row.row_id] !== null && vectors.some((other) =>
                other.id !== reference.id && table.get(other.id)[row.row_id] !== null
                && table.get(other.id)[row.row_id] !== values[row.row_id])).map((row) => row.row_id)
            : rows.filter((row) => values[row.row_id] !== null
                && values[row.row_id] !== referenceValues[row.row_id]).map((row) => row.row_id);
        vector.targets_via = 'flip';
        if (vector.targets.length === 0 && vector.id !== reference.id) {
            vector.targets = exerciseTargets(context, vector, reference);
            vector.targets_via = 'exercise';
        }
    }

    // Row coverage: both outcomes must be present among the mapped vectors, otherwise the row is
    // recorded as an exception with a reason instead of silently counted as covered.
    const map = {};
    const exceptions = {};
    for (const row of rows) {
        const mapped = vectors.filter((vector) => vector.targets.indexOf(row.row_id) >= 0);
        const flipping = mapped.filter((vector) => vector.targets_via === 'flip');
        const outcomes = new Set(flipping.map((vector) => table.get(vector.id)[row.row_id]));
        map[row.row_id] = mapped.map((vector) => vector.id).sort();
        if (mapped.length === 0) {
            exceptions[row.row_id] = { class: 'unreachable-domain', kind: row.kind,
                snippet: row.code_snippet, reason: 'no vector flips or exercises this predicate' };
        } else if (outcomes.size < 2) {
            exceptions[row.row_id] = { class: 'single-outcome', kind: row.kind,
                snippet: row.code_snippet, outcome: [...outcomes][0], vectors: mapped.length,
                flip_vectors: flipping.length,
                reason: 'the predicate takes this value for every input the two generators accept '
                    + '(mutation-equivalent branch, plan §2 item 6)'};
        }
    }
    for (const row of outRows) {
        map[row.row_id] = [];
        exceptions[row.row_id] = {
            class: 'unreachable-domain', kind: row.kind, snippet: row.code_snippet,
            reason: 'outside both generators (' + row.fn_or_route + '): reads ' + row.vars_read
                + ', which buildArgs/buildPresetIni never receive'
        };
    }
    // A vector can still have no row for two honest reasons, and both are recorded rather than
    // silently dropped: its input is byte-identical to the reference's (the plan's probe list names
    // values the fresh page already holds, e.g. minP "0"), or it changes only the always-appended
    // args, which SPEC-ROWS.md records as UNGUARDED pushes no predicate row can name.
    const sameInput = (a, b) => a.settings === b.settings && a.models === b.models
        && !a.ini_configs && !b.ini_configs
        && Object.keys(a.fields).length === Object.keys(b.fields).length
        && JSON.stringify(a.fields) === JSON.stringify(b.fields);
    const noTarget = [];
    for (const vector of vectors) {
        if (vector.targets.length > 0 || vector.id === reference.id) continue;
        noTarget.push(vector.id);
        exceptions['vector:' + vector.id] = sameInput(vector, reference)
            ? { class: 'duplicate-of-reference', family: vector.family,
                reason: 'the input is identical to the reference, so the reference golden already '
                    + 'pins these bytes; kept because the plan §2.3 probe list names this value '
                    + '(it is what the fresh page holds)'
              }
            : { class: 'rowless-vector', family: vector.family,
                reason: 'it changes only the always-appended args (--host 0.0.0.0, -fit off, '
                    + '--port), which SPEC-ROWS.md records as unguarded pushes no predicate row can '
                    + 'name; the golden bytes are the assertion' };
    }

    const files = new Map();
    for (const family of FAMILIES) {
        const list = vectors.filter((vector) => vector.family === family);
        files.set(family + '/vectors.jsonl', [JSON.stringify({
            kind: 'header', family, generator: 'tools/parity/gen-vectors.js', command: REGEN,
            seed: SEED, count: list.length, field_count: keys.length,
            ...(family === 'corpus' ? { note: 'the 48 remapped corpus configs, verbatim' } : {})
        })].concat(list.map((vector) => JSON.stringify(vector))).join('\n'));
    }

    files.set('INPUTS.json', JSON.stringify({
        generated_by: 'tools/parity/gen-vectors.js', command: REGEN, seed: SEED,
        baseline: 'parity-baseline', field_keys: keys, field_count: keys.length,
        field_kinds: Object.fromEntries(keys.map((key) => [key, metaMap.get(key).kind])),
        reference_fields: referenceFields(),
        value_classes: Object.fromEntries(keys.map((key) => [key, classes.get(key)
            .map((value) => (value === OMIT ? '<omit key>' : value))])),
        settings_sets: sets.map((set) => ({ id: set.id, port: set.port, source: set.source,
            settings: set.settings })),
        model_sets: modelSets().map((set) => ({ id: set.id, source: set.source, models: set.models }))
    }, null, 2));

    files.set('coverage-map.json', JSON.stringify({
        generated_by: 'tools/parity/gen-vectors.js', command: REGEN, reference: reference.id,
        relation: 'a vector is mapped to a row it FLIPS (its predicate outcome differs from the '
            + 'reference) or, only when it flips nothing, one it EXERCISES (it evaluates the row test '
            + 'with a different value of a field the row reads); the vector line records which, in '
            + 'targets_via',
        rows: Object.keys(map).length, vectors: vectors.length, map: map
    }, null, 2));
    files.set('coverage-exceptions.json', JSON.stringify({
        generated_by: 'tools/parity/gen-vectors.js', command: REGEN,
        note: 'single-outcome = the predicate cannot take both values for any input of the two '
            + 'generators (mutation-equivalent branch, plan §2 item 6). unreachable-domain = the row '
            + 'is outside both generators. Both classes are recorded, never dropped (C2).',
        row_synthesis: context.rowSynthesis, cover: context.cover, random_draws: context.randomDraws,
        vectors_without_a_row: noTarget, not_evaluable: problems, exceptions: exceptions
    }, null, 2));

    return { files, vectors, reference, rows, exceptions, noTarget, table, context,
        counts: Object.fromEntries(FAMILIES.map((family) => [family,
            vectors.filter((vector) => vector.family === family).length])) };
}

function main() {
    const check = process.argv.indexOf('--check') >= 0;
    const built = build();
    if (check) {
        const stale = [];
        for (const [relPath, content] of built.files) {
            const file = path.join(VECTORS, relPath);
            if (!fs.existsSync(file) || readText(file) !== content + '\n') stale.push(relPath);
        }
        for (const relPath of stale) console.log('STALE ' + relPath);
        console.log(stale.length ? 'GEN-VECTORS STALE (' + stale.length + ')' : 'GEN-VECTORS REPRODUCIBLE');
        process.exitCode = stale.length ? 1 : 0;
        return;
    }
    for (const [relPath, content] of built.files) {
        const file = path.join(VECTORS, relPath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content + '\n', 'utf8');
    }
    const map = JSON.parse(built.files.get('coverage-map.json')).map;
    const mapped = Object.values(map).filter((list) => list.length > 0).length;
    console.log('vectors: ' + FAMILIES.map((family) => family + '=' + built.counts[family]).join(' ')
        + ' total=' + built.vectors.length);
    console.log('rows mapped ' + mapped + '/' + Object.keys(map).length
        + '  exceptions=' + Object.keys(built.exceptions).length
        + '  row-synthesis=' + built.context.rowSynthesis.synthesized
        + ' unfound=' + built.context.rowSynthesis.unfound.length
        + '  cover=' + JSON.stringify(built.context.cover)
        + ' random-draws=' + built.context.randomDraws);
    if (built.noTarget.length) console.log('VECTORS WITH NO ROW: ' + built.noTarget.join(', '));
    if (built.context.rowSynthesis.unfound.length) {
        console.log('unfound rows:\n  ' + built.context.rowSynthesis.unfound.join('\n  '));
    }
}

module.exports = {
    REPO, VECTORS, GOLDENS, FAMILIES, SEED, REGEN, sha256, readText, readJson, rel, assert,
    writeJsonl, readJsonl, csvParse, rng, specRows, rowExpr, rowTester, inDomain, isIniRow, isBaRow,
    fieldMatrix, fieldMeta, corpusConfigs, modelPaths, modelSets, settingsSets, referenceFields,
    argvFields, iniConfigs, scopesFor, predicateTable, specTypesOf, classesFor, coveringArray,
    combinations, cartesian, pathPool, buildClasses, makeVector, fieldsFor, slug, THREE_WISE, OMIT,
    ternaryCondition, directFieldsOf, exerciseTargets, candidateFieldsOf, tokenizePath,
    tokenizeModel, SCRATCH_TOKEN, LITERAL_PATHS, tokenizeSettings,
    modelsById: () => new Map(modelSets().map((set) => [set.id, set.models])),
    settingsById: () => new Map(settingsSets().map((set) => [set.id, set.settings]))
};

if (require.main === module) main();
