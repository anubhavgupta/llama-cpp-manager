'use strict';
// Everything the L2 suite reads out of the recorded corpus (fixtures/**) and the SPEC pack.
// L2 never runs the manager and never imports app code: its expectations are recorded legacy bytes
// (C5) and its page is loaded from a sandbox, so this module only reads files.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const FIXTURES = path.join(REPO, 'fixtures');
const sha256 = (bytes) => crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');

function readBuffer(...parts) {
    return fs.readFileSync(path.join(FIXTURES, ...parts));
}

function readFixture(...parts) {
    return readBuffer(...parts).toString('utf8');
}

function readFixtureJson(...parts) {
    return JSON.parse(readFixture(...parts));
}

function readRepoJson(relative) {
    return JSON.parse(fs.readFileSync(path.join(REPO, relative), 'utf8'));
}

// fixtures/http/<journey>/<name>.response holds the raw body bytes the manager answered with, and
// <name>.request.json the request that produced them. L2 replays the body bytes verbatim.
function httpBody(journey, name) {
    return readBuffer('http', journey, name + '.response');
}

function httpRequest(journey, name) {
    return readFixtureJson('http', journey, name + '.request.json');
}

function jsonBuffer(value) {
    return Buffer.from(JSON.stringify(value), 'utf8');
}

// ------------------------------------------------------------- recorded seeds ----------------

// A recorded localStorage snapshot as {configsKey, configsJson, settingsKey, settingsJson}: the
// exact strings the legacy page had, taken from a fixtures/localstorage/** capture. Seeding with the
// recorded bytes means the L2 page starts from recorded legacy state instead of a hand-written one.
function recordedStorage(journey, name) {
    const capture = readFixtureJson('localstorage', journey, name + '.json');
    const entries = capture.storage ? capture.storage.entries : capture.entries;
    const find = (key) => {
        const row = (entries || []).find((entry) => entry[0] === key);
        return row ? row[1] : null;
    };
    return {
        configsKey: 'llamaCppConfigs',
        configsJson: find('llamaCppConfigs'),
        settingsKey: 'llamaCppSettings',
        settingsJson: find('llamaCppSettings')
    };
}

// The two-config recorded state (capture-alpha pristine + capture-beta re-saved through the DOM),
// used for the UI-state fingerprints, the Q8 delete-reset replay and the deterministic 2-config ini.
function smallSeed() {
    const seed = recordedStorage('J5-ui-states', 'after-save-config');
    if (!seed.configsJson || !seed.settingsJson) {
        throw new Error('J5-ui-states/after-save-config.json does not carry both localStorage keys');
    }
    return seed;
}

// The corpus in localStorage shape: fixtures/corpus/configs.remapped.json is the ordered list of
// {name, config}; the storage map is that list as an object, so insertion order is the file order
// (plan §9 trap 6: ini section order follows it, the rendered list is separately .sort()ed).
function corpusSeed() {
    const list = readFixtureJson('corpus', 'configs.remapped.json');
    const settings = readFixtureJson('corpus', 'settings.remapped.json');
    const configs = {};
    for (const row of list) configs[row.name] = row.config;
    return {
        configsKey: 'llamaCppConfigs',
        configsJson: JSON.stringify(configs),
        settingsKey: 'llamaCppSettings',
        settingsJson: JSON.stringify(settings),
        list,
        configs,
        settings,
        names: list.map((row) => row.name)
    };
}

// A subset of the corpus, in a caller-chosen insertion order (used for the ini section-order claim).
function corpusSubsetSeed(names) {
    const corpus = corpusSeed();
    const configs = {};
    for (const name of names) configs[name] = corpus.configs[name];
    return {
        configsKey: 'llamaCppConfigs',
        configsJson: JSON.stringify(configs),
        settingsKey: 'llamaCppSettings',
        settingsJson: corpus.settingsJson,
        configs,
        names
    };
}

// --------------------------------------------------------------- recorded truth --------------

function corpusConfigList() {
    return readFixtureJson('localstorage', 'J6-corpus-smoke', 'config-list.json');
}

function corpusSelectSurvey() {
    return readFixtureJson('localstorage', 'J6-corpus-smoke', 'model-path-select-survey.json');
}

function uiFieldState(name) {
    const notes = readFixtureJson('screenshots', 'J5-ui-states', 'state-notes.json');
    const state = notes.storageStates[name];
    if (!state) throw new Error('no recorded form state ' + name);
    return state;
}

function uiStateNotes() {
    return readFixtureJson('screenshots', 'J5-ui-states', 'state-notes.json');
}

function q8DeleteReset() {
    return readFixtureJson('localstorage', 'J5-ui-states', 'q8-delete-reset.json');
}

function renderArtifact(journey, name) {
    return readFixtureJson('screenshots', journey, name + '.render.json');
}

function wsEvents(journey, name) {
    return readFixtureJson('ws', journey, (name || 'events') + '.json');
}

function logPaneClaims() {
    return readFixtureJson('ws', 'J5-ui-log-cap', 'log-pane.json');
}

function chunkBoundaryClaims() {
    return readFixtureJson('ws', 'J5-ui-log-cap', 'chunk-boundary.json');
}

function recordedDialogs() {
    return readFixtureJson('ws', 'J5-ui-dialogs', 'dialogs.json');
}

function launchAttempts() {
    return readFixtureJson('ws', 'J5-ui-launch', 'launch-attempts.json');
}

function iniClaims() {
    return readFixtureJson('ini', 'J4b-ui-presets-launch', 'presets-claims.json');
}

function iniBytes() {
    return readBuffer('ini', 'J4b-ui-presets-launch', 'presets-from-ui.ini').toString('utf8');
}

// The canned /metrics body the recorded screenshots were taken with. Provenance: SCREENSHOT_METRICS in
// tools/parity/capture-legacy.js — "left live it would repaint the charts and the metric readouts
// differently in every recorded pixel". It is an INPUT the recording names, and the readout digit count
// (cpu 10 → two digits) is what the recorded element geometry encodes, so a fingerprint rebuild has to
// serve the same body to match.
function screenshotMetrics() {
    return { cpu: 10, ram: 20, gpu: 30, vram: 40, vramUsage: '12345/24576' };
}

// The recorded /models payload, used as-is for the normal mock and as the entry SHAPE for the
// corpus-mode payload (paths from the corpus, same five keys, no mmproj association).
function modelsPayload() {
    return JSON.parse(httpBody('J2-models', 'models').toString('utf8'));
}

const MODEL_KEYS = ['name', 'path', 'relativePath', 'mmprojFile'];

// Mechanical fill of the recorded entry shape with corpus paths. An INPUT, not an expectation:
// argv expectations come from recorded legacy output, so nothing here can make a wrong app pass.
function corpusModelsPayload(configs) {
    const paths = [];
    const seen = new Set();
    for (const config of Object.values(configs)) {
        for (const field of ['modelPath', 'draftModelPath']) {
            const value = typeof config[field] === 'string' ? config[field] : '';
            if (!value || seen.has(value)) continue;
            seen.add(value);
            paths.push(value);
        }
    }
    // `path` is copied verbatim: the page sets option.value = model.path and later assigns the saved
    // config's modelPath to the select, so any normalization here would blank the selector (Q18).
    const dirOf = (value) => value.slice(0, Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/')) + 1);
    // Longest common prefix of every path, cut back to its last separator: that is the models
    // directory the recorded payload's relativePath is relative to.
    let common = paths.length ? paths[0] : '';
    for (const value of paths) {
        while (common && value.indexOf(common) !== 0) common = common.slice(0, -1);
    }
    const root = dirOf(common);
    const shape = Object.fromEntries(MODEL_KEYS.map((key) => [key, null]));
    return {
        success: true,
        models: paths.map((value) => Object.assign({}, shape, {
            name: value.slice(dirOf(value).length),
            path: value,
            relativePath: root && value.indexOf(root) === 0 ? value.slice(root.length) : value,
            mmprojFile: null
        }))
    };
}

// --------------------------------------------------------------- goldens -------------------

function jsonl(file) {
    return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map(JSON.parse);
}

function corpusGoldens() {
    const lines = jsonl(path.join(FIXTURES, 'goldens', 'corpus', 'goldens.jsonl'));
    const vectors = jsonl(path.join(FIXTURES, 'vectors', 'corpus', 'vectors.jsonl'));
    const vectorById = new Map(vectors.filter((row) => row.kind === 'vector').map((row) => [row.id, row]));
    const byName = new Map();
    for (const golden of lines.filter((row) => row.kind === 'golden')) {
        const vector = vectorById.get(golden.vector_id);
        if (vector) byName.set(vector.name, { golden, vector });
    }
    return { byName, header: lines[0], impl: lines[0].impl };
}

function resaveGoldens() {
    const file = path.join(FIXTURES, 'goldens', 'resave', 'goldens.jsonl');
    if (!fs.existsSync(file)) return null;
    const lines = jsonl(file);
    const rows = lines.filter((row) => row.kind === 'golden');
    // Two rows share a name: the re-save/launch row and the alert-blocked row (the same config in the
    // recorded-J2 /models mode), so they are keyed separately.
    return { header: lines[0],
        byName: new Map(rows.filter((row) => row.op !== 'alert-blocked').map((row) => [row.name, row])),
        blocked: new Map(rows.filter((row) => row.op === 'alert-blocked').map((row) => [row.name, row])) };
}

function inputsRecorded() {
    const file = path.join(FIXTURES, 'goldens', 'resave', 'inputs.jsonl');
    if (!fs.existsSync(file)) return null;
    const lines = jsonl(file);
    return { header: lines[0], rows: lines.filter((row) => row.kind === 'input') };
}

// --------------------------------------------------------------- SPEC ----------------------

function fieldManifest() {
    const pack = readRepoJson('SPEC/field-manifest.json');
    const value = (field, attribute) => {
        const entry = field.attributes[attribute];
        return entry === undefined ? undefined : entry.value;
    };
    return { pack, fields: pack.fields, value,
        byId: new Map(pack.fields.map((field) => [field.id, field])) };
}

// The 36 fields saveCurrentValues writes, in the order its literal writes them (SPEC's
// persistedIntoConfigs list is sorted; the storage byte order is the literal order).
function savedFieldOrder() {
    return readRepoJson('SPEC/storage-schema.json');
}

function comparisonPolicy() {
    return readFixtureJson('COMPARISON.json');
}

function baseline() {
    return readRepoJson('fixtures/BASELINE.json');
}

module.exports = {
    REPO, FIXTURES, sha256, readBuffer, readFixture, readFixtureJson, readRepoJson, httpBody,
    httpRequest, jsonBuffer, recordedStorage, smallSeed, corpusSeed, corpusSubsetSeed,
    corpusConfigList, corpusSelectSurvey, uiFieldState, uiStateNotes, q8DeleteReset, renderArtifact,
    wsEvents, logPaneClaims, chunkBoundaryClaims, recordedDialogs, launchAttempts, iniClaims,
    iniBytes, modelsPayload, corpusModelsPayload, screenshotMetrics, jsonl, corpusGoldens, resaveGoldens,
    inputsRecorded, fieldManifest, savedFieldOrder, comparisonPolicy, baseline
};
