#!/usr/bin/env node
// Pairing layer for the (b) RUNTIME derivation.
//
// The recordings contain the CLIENT-built /start bodies (bodies the page itself POSTed — see
// fromPage in spec-runtime-evidence.js) and the app-generated models-preset.ini bytes, plus
// recorded localStorage states that hold the field values those outputs were built from. This
// module joins them by value identity and reports only unambiguous joins:
//
//   value identity      an emitted token equals exactly one recorded field value of that launch
//   settings identity   an emitted token equals exactly one recorded llamaCppSettings value
//   presence vector     a valueless key is present exactly where a boolean field is true
//
// Anything ambiguous stays a gap: (b) must not borrow an answer from the source (plan §2 Phase 3).

'use strict';

const C = require('./spec-common');
const E = require('./spec-runtime-evidence');
const { gap, asText } = E;

const FLAG_RE = /^-{1,2}[A-Za-z]/;

// Parse an argv slice into [{flag, value}] using the recorded rule that a flag literal starts
// with one or two dashes followed by a letter (so the value "-1" of --cache-ram stays a value).
function parseArgv(args) {
    const out = [];
    for (let i = 0; i < args.length; i++) {
        const token = args[i];
        if (!FLAG_RE.test(token)) continue;
        const next = args[i + 1];
        if (next !== undefined && !FLAG_RE.test(next)) { out.push({ flag: token, value: next, index: i }); i++; } else out.push({ flag: token, value: null, index: i });
    }
    return out;
}

// Corpus paths are recorded with the PATH-MAP token root (fixtures/PATH-MAP.json: 'FIXTURE_ROOT/
// models'); the live journeys recorded the staged copy of the same tree. Suffix-after-'models/' is
// the identity the recordings themselves share (see localstorage/J6-corpus-smoke/
// model-path-select-survey.json, whose recorded DOM values match the same suffix).
const modelSuffix = (p) => {
    const norm = String(p).replace(/\\/g, '/').toLowerCase();
    const at = norm.lastIndexOf('/models/');
    return at === -1 ? norm.split('/').pop() : norm.slice(at + '/models/'.length);
};

// Launches whose arg vector was built by the app's own client and recorded on the wire.
function launchObservations() {
    const out = [];
    const states = E.storageStates();
    const attempts = E.wsRecordings().launchAttempts;
    const uiStorage = states.find((s) => s.fixture.endsWith('J5-ui-launch/after-ui-launch.json'));
    if (uiStorage && attempts && !attempts.__gap) {
        for (const attempt of attempts.attempts || []) {
            if (!attempt.requestObserved || !attempt.requestBody || !attempt.requestBody.args) continue;
            const values = uiStorage.configs[attempt.config];
            if (!values) continue;
            out.push({
                launch: `${attempt.config}@J5-ui-launch`,
                args: attempt.requestBody.args,
                values,
                settings: uiStorage.settings || {},
                evidence: ['ws/J5-ui-launch/launch-attempts.json', uiStorage.fixture],
            });
        }
    }
    const corpus = E.noteFiles().corpus;
    const bySuffix = new Map();
    for (const entry of Array.isArray(corpus) ? corpus : []) {
        if (!entry.config || !entry.config.modelPath) continue;
        const key = modelSuffix(entry.config.modelPath);
        const hits = bySuffix.get(key) || [];
        hits.push(entry);
        bySuffix.set(key, hits);
    }
    for (const rec of E.httpRecordings()) {
        if (rec.path !== '/start' || !rec.fromPage || !rec.requestBody || !rec.requestBody.args) continue;
        if (!rec.journey.includes('corpus')) continue;
        const parsed = parseArgv(rec.requestBody.args);
        const modelArg = parsed.find((p) => p.flag === '-m');
        const matches = modelArg ? (bySuffix.get(modelSuffix(modelArg.value)) || []) : [];
        if (!matches.length) {
            out.push({ launch: `${rec.journey}/${rec.name}`, args: rec.requestBody.args, values: null, settings: null, unresolvedConfig: 0, evidence: [rec.fixture] });
            continue;
        }
        // Several corpus configs can share one model file; only the values every candidate agrees
        // on are evidence, so a shared path never imports another config's numbers.
        const values = {};
        for (const key of Object.keys(matches[0].config)) {
            if (matches.every((m) => asText(m.config[key]) === asText(matches[0].config[key]))) values[key] = matches[0].config[key];
        }
        out.push({
            launch: `${matches.map((m) => m.name).join('|')}@${rec.journey}`,
            args: rec.requestBody.args,
            values,
            settings: E.noteFiles().corpusSettings || {},
            valueSetSource: `fixtures/corpus/configs.remapped.json entries identified by the recorded -m model path suffix${matches.length > 1 ? ` (${matches.length} configs share that file; only agreeing values used)` : ''}`,
            evidence: [rec.fixture, 'corpus/configs.remapped.json'],
        });
    }
    return out;
}

// One entry per recorded ini document section, paired with the recorded config of that name.
function iniObservations() {
    const states = E.storageStates();
    const valueSources = [];
    for (const state of states) {
        for (const [name, values] of Object.entries(state.configs)) {
            if (valueSources.some((v) => v.name === name)) continue;
            valueSources.push({ name, values, fixture: state.fixture });
        }
    }
    const out = [];
    for (const doc of E.iniDocs()) {
        for (const section of doc.sections) {
            const match = valueSources.find((v) => v.name === section.name);
            out.push({
                doc: doc.fixture,
                section: section.name,
                keys: section.keys.filter((k) => k.key).map((k) => ({ key: k.key, value: k.value })),
                values: match ? match.values : null,
                valuesFixture: match ? match.fixture : null,
                trailing: doc.trailing.map((t) => ({ key: t.key, value: t.value })),
                settings: (states.find((s) => s.settings) || {}).settings || {},
            });
        }
    }
    return out;
}

// Emitted paths are recorded live (C:\...\parity-scratch\fixtures\models\...) while the corpus
// recording stores the PATH-MAP token form (fixtures/PATH-MAP.json), so path-valued comparisons
// use the same suffix-after-'models/' identity used to identify corpus launches.
const isPathLike = (text) => /(^\w:[\\/])|(^\/)|(\\\\)/.test(text) || text.startsWith('FIXTURE_ROOT') || text.includes('/models/');
const valueMatches = (recorded, emitted) => {
    const a = asText(recorded);
    if (a === emitted) return true;
    return (isPathLike(a) || isPathLike(emitted)) && modelSuffix(a) === modelSuffix(emitted);
};

// Flag -> field claims across every launch that has a recorded value set.
//
// A value only identifies a field when NO recorded field value anywhere equals that text. The pool
// is every config in the corpus recording plus every config and settings object in the localStorage
// dumps — not just the launches' own subsets. Without that breadth '-fit off' pairs with `reasoning`
// merely because some launch stores reasoning: 'off', and '--n-cpu-moe 4' pairs with `draftMin`
// because 4 is also a draft length: coincidences the recordings cannot rule out.
function globalValueIndex() {
    const index = new Map();
    const add = (value, field) => {
        if (value === undefined || value === null) return;
        const text = asText(value);
        const keys = isPathLike(text) ? [text, modelSuffix(text)] : [text];
        for (const key of keys) {
            const set = index.get(key) || new Set();
            set.add(field);
            index.set(key, set);
        }
    };
    for (const entry of [].concat(E.noteFiles().corpus || [])) {
        for (const [field, value] of Object.entries(entry.config || {})) add(value, field);
    }
    for (const state of E.storageStates()) {
        for (const values of Object.values(state.configs)) {
            for (const [field, value] of Object.entries(values)) add(value, field);
        }
        for (const [field, value] of Object.entries(state.settings || {})) add(value, `${field}(settings)`);
    }
    return index;
}

function flagClaims(launches) {
    const usable = launches.filter((l) => l.values);
    const globalIndex = globalValueIndex();
    const byFlag = {};
    for (const launch of usable) {
        for (const entry of parseArgv(launch.args)) {
            const record = (byFlag[entry.flag] = byFlag[entry.flag] || { launches: 0, claims: new Map(), ties: 0, evidence: new Set(), values: new Set(), agreements: new Map() });
            record.launches += 1;
            launch.evidence.forEach((e) => record.evidence.add(e));
            if (entry.value !== null) record.values.add(entry.value);
            if (entry.value === null) continue;
            const holders = globalIndex.get(entry.value) || (isPathLike(entry.value) ? globalIndex.get(modelSuffix(entry.value)) : undefined) || new Set();
            if (holders.size !== 1) continue;
            const field = [...holders][0].replace(/\(settings\)$/, '');
            record.claims.set(field, (record.claims.get(field) || 0) + 1);
            const tally = record.agreements.get(field) || { yes: 0, no: 0 };
            record.agreements.set(field, tally);
            const known = launch.values.hasOwnProperty(field) || (launch.settings || {}).hasOwnProperty(field);
            if (!known) continue;   // no recorded value for that field in this launch: no evidence
            const source = launch.values.hasOwnProperty(field) ? launch.values[field] : (launch.settings || {})[field];
            if (valueMatches(source, entry.value)) tally.yes += 1; else tally.no += 1;
        }
    }
    const out = {};
    for (const flag of Object.keys(byFlag)) {
        const record = byFlag[flag];
        const agreed = [...record.agreements.entries()].filter(([, t]) => t.no === 0 && t.yes > 0).map(([field]) => field);
        const contradicted = [...record.agreements.entries()].filter(([, t]) => t.no > 0).map(([field]) => field);
        const claimed = agreed.length === 1 ? agreed : null;
        out[flag] = {
            observed: true,
            launches: record.launches,
            values: [...record.values],
            evidence: [...record.evidence],
            field: claimed ? claimed[0] : null,
            pairedBy: claimed ? (claimed[0] === 'serverPort' ? 'settings value identity' : 'recorded value identity, every recorded launch agrees') : null,
            contradictedBy: contradicted,
            tieLaunches: record.ties,
            candidates: [...record.claims.keys()],
        };
    }
    // Bare flags and `= true`-style lines: correlate presence against the boolean fields.
    const observations = {};
    for (const launch of usable) {
        observations[launch.launch] = {
            emittedKeys: new Set(parseArgv(launch.args).filter((p) => p.value === null).map((p) => p.flag)),
            bools: Object.fromEntries(Object.entries(launch.values).map(([k, v]) => [k, typeof v === 'boolean' ? v : undefined])),
        };
    }
    for (const [flag, claim] of Object.entries(E.correlatePresence(observations))) {
        if (!out[flag]) continue;
        out[flag].field = claim.field;
        out[flag].pairedBy = `presence vector over ${claim.launches} recorded launches`;
    }
    return out;
}

function iniKeyClaims(iniObs) {
    const globalIndex = globalValueIndex();
    const byKey = {};
    const boolObservations = {};
    for (const obs of iniObs) {
        for (const line of obs.keys) {
            const record = (byKey[line.key] = byKey[line.key] || { sections: 0, claims: new Map(), ties: 0, evidence: new Set(), values: new Set(), agreements: new Map() });
            record.sections += 1;
            record.evidence.add(obs.doc);
            record.values.add(line.value);
            if (!obs.values) continue;
            if (line.value === 'true') {
                const bools = Object.fromEntries(Object.entries(obs.values).map(([k, v]) => [k, typeof v === 'boolean' ? v : undefined]));
                const launchId = `${obs.doc}#${obs.section}`;
                const emitted = new Set(obs.keys.filter((k) => k.value === 'true').map((k) => k.key));
                boolObservations[launchId] = { emittedKeys: emitted, bools, perKey: line.key };
                continue;
            }
            const holders = globalIndex.get(line.value) || (isPathLike(line.value) ? globalIndex.get(modelSuffix(line.value)) : undefined) || new Set();
            if (holders.size > 1) { record.ties += 1; continue; }
            if (holders.size === 0) continue;
            const field = [...holders][0].replace(/\(settings\)$/, '');
            record.claims.set(field, (record.claims.get(field) || 0) + 1);
            const tally = record.agreements.get(field) || { yes: 0, no: 0 };
            record.agreements.set(field, tally);
            const known = obs.values.hasOwnProperty(field) || (obs.settings || {}).hasOwnProperty(field);
            if (!known) continue;
            const source = obs.values.hasOwnProperty(field) ? obs.values[field] : (obs.settings || {})[field];
            if (valueMatches(source, line.value)) tally.yes += 1; else tally.no += 1;
        }
    }
    const out = {};
    for (const key of Object.keys(byKey)) {
        const record = byKey[key];
        const agreed = [...record.agreements.entries()].filter(([, t]) => t.no === 0 && t.yes > 0).map(([field]) => field);
        const contradicted = [...record.agreements.entries()].filter(([, t]) => t.no > 0).map(([field]) => field);
        const claimed = agreed.length === 1 ? agreed : null;
        out[key] = {
            observed: true,
            sections: record.sections,
            values: [...record.values],
            evidence: [...record.evidence],
            field: claimed ? claimed[0] : null,
            pairedBy: claimed ? 'recorded value identity, every recorded section agrees' : null,
            contradictedBy: contradicted,
            tieSections: record.ties,
            candidates: [...record.claims.keys()],
        };
    }
    for (const [key, claim] of Object.entries(E.correlatePresence(boolObservations))) {
        if (!out[key]) continue;
        out[key].field = claim.field;
        out[key].pairedBy = `presence vector over ${claim.launches} recorded sections`;
    }
    return out;
}

module.exports = { parseArgv, launchObservations, iniObservations, flagClaims, iniKeyClaims, globalValueIndex, modelSuffix, valueMatches, FLAG_RE };
