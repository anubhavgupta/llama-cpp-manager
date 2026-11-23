#!/usr/bin/env node
// Evidence layer for (b) RUNTIME derivation (plan.md §2 Phase 3).
//
// Everything here reads fixtures/** recordings and nothing reads the app source: this is the
// only window (b) has onto the legacy app. Each accessor returns the value plus the fixture
// path it came from, so every claim in the pack can cite the recording that backs it.
//
// A recording that does not contain something yields C.gap(reason) — never a guess.

'use strict';

const fs = require('fs');
const path = require('path');
const C = require('./spec-common');
const { FIXTURES, gap } = C;

const readText = (rel) => fs.readFileSync(path.join(FIXTURES, rel), 'utf8');
const readJson = (rel) => JSON.parse(readText(rel));
const exists = (rel) => fs.existsSync(path.join(FIXTURES, rel));

const walkDir = (rel) => {
    const root = path.join(FIXTURES, rel);
    if (!fs.existsSync(root)) return [];
    const out = [];
    (function visit(dir, prefix) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const abs = path.join(dir, entry.name);
            const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) visit(abs, relPath);
            else out.push(`${rel}/${relPath}`.replace(/^fixtures\//, '').replace(/\\/g, '/'));
        }
    })(root, '');
    return out;
};

// --- HTTP recordings --------------------------------------------------------------------
// A sidecar recorded from the page carries browser headers (referer/origin); a driver-authored
// request does not. That distinction is what makes a body usable as evidence of the CLIENT's
// arg/ini builder rather than of the harness's own belief (C5).
function httpRequest(rel) {
    const sidecar = readJson(rel);
    const bodyRel = rel.replace(/\.request\.json$/, '.response');
    const response = exists(bodyRel) ? readText(bodyRel) : null;
    const statusSidecar = rel.replace(/\.request\.json$/, '.json');
    return {
        fixture: rel,
        journey: rel.split('/')[1],
        name: path.basename(rel).replace('.request.json', ''),
        method: sidecar.method,
        url: sidecar.url,
        path: (sidecar.url || '').replace(/^https?:\/\/[^/]+/, ''),
        headers: sidecar.headers || {},
        fromPage: !!(sidecar.headers && (sidecar.headers.referer || sidecar.headers.origin)),
        requestBody: sidecar.postData ? safeJson(sidecar.postData) : (sidecar.body === undefined ? null : sidecar.body),
        responseBody: response,
        statusRecorded: exists(statusSidecar) ? readJson(statusSidecar).status ?? null : null,
        statusEvidence: exists(statusSidecar) ? statusSidecar : null,
    };
}

const safeJson = (text) => { try { return JSON.parse(text); } catch { return text; } };

function httpRecordings() {
    return walkDir('http').filter((f) => f.endsWith('.request.json')).map((f) => httpRequest(f));
}

// --- localStorage dumps -----------------------------------------------------------------
function storageStates() {
    const out = [];
    for (const rel of walkDir('localstorage')) {
        if (!rel.endsWith('.json') || rel.includes('q8-delete-reset') || rel.includes('config-list') || rel.includes('survey')) continue;
        const dump = readJson(rel);
        if (!dump.storage) continue;
        const entryValue = (key) => {
            const hit = (dump.storage.entries || []).find((e) => e[0] === key);
            return hit ? hit[1] : null;
        };
        const configsRaw = entryValue('llamaCppConfigs');
        out.push({
            fixture: rel,
            order: dump.storage.order,
            configsRaw,
            configs: configsRaw ? JSON.parse(configsRaw) : {},
            settingsRaw: entryValue('llamaCppSettings'),
            settings: entryValue('llamaCppSettings') ? JSON.parse(entryValue('llamaCppSettings')) : null,
            fields: dump.fields || null,
        });
    }
    return out;
}

function fieldDumpStates() {
    return storageStates().filter((s) => s.fields && s.fields.length).map((s) => ({ fixture: s.fixture, fields: s.fields, configs: s.configs }));
}

function q8Reset() {
    const rel = 'localstorage/J5-ui-states/q8-delete-reset.json';
    if (!exists(rel)) return gap('no q8-delete-reset.json recording exists');
    const j = readJson(rel);
    return { fixture: rel, controlCount: j.controlCount, changed: j.rows.map((r) => ({ id: r.id, after: r.after, equalsHtmlDefault: r.equalsHtmlDefault })) };
}

// --- DOM fingerprints -------------------------------------------------------------------
function renderStates() {
    const out = [];
    for (const rel of walkDir('screenshots')) {
        if (!rel.endsWith('.render.json')) continue;
        const r = readJson(rel);
        out.push({
            fixture: rel,
            state: path.basename(rel).replace('.render.json', ''),
            elements: r.elements.map((e) => ({ id: e.id, tag: e.tag, type: e.type === undefined ? null : e.type, value: e.value === undefined ? null : e.value, disabled: !!e.disabled, visible: e.visible, text: e.text === undefined ? null : e.text, y: Array.isArray(e.rect) ? e.rect[1] : null })),
            logPane: r.logPane || null,
        });
    }
    return out;
}

// --- argv / ini / ws / notes -------------------------------------------------------------
function argvSpawns() {
    const out = [];
    for (const rel of walkDir('argv')) {
        if (!rel.endsWith('.jsonl')) continue;
        readText(rel).trim().split(/\r?\n/).forEach((line, index) => {
            const j = JSON.parse(line);
            out.push({ fixture: rel, line: index + 1, pid: j.pid, argv: j.argv, raw: j.raw });
        });
    }
    return out;
}

function iniDocs() {
    const out = [];
    for (const rel of walkDir('ini')) {
        if (!rel.endsWith('.ini')) continue;
        const text = readText(rel);
        const sections = [];
        let current = null;
        let trailing = [];
        let versionHeader = null;
        text.split('\n').forEach((line) => {
            const stripped = line.replace(/\r$/, '');
            if (/^\[.*\]$/.test(stripped)) {
                current = { name: stripped.slice(1, -1), keys: [] };
                sections.push(current);
                return;
            }
            const pair = /^([^\s=]+) = (.*)$/.exec(stripped);
            if (pair) {
                if (pair[1] === 'version' && !current) { versionHeader = stripped; return; }
                if (current) current.keys.push({ key: pair[1], value: pair[2] });
                else trailing.push({ key: pair[1], value: pair[2] });
                return;
            }
            if (stripped.trim() === '') return;
            if (current) current.keys.push({ key: null, unparsed: stripped });
        });
        out.push({ fixture: rel, text, versionHeader, sections, trailing });
    }
    return out;
}

function wsRecordings() {
    const out = { events: [], notes: {}, managerLogs: [] };
    for (const rel of walkDir('ws')) {
        if (rel.endsWith('events.json')) {
            const j = readJson(rel);
            out.events.push({ fixture: rel, journey: rel.split('/')[1], connection: j.connection, events: j.events });
        } else if (/(chunk-boundary|log-pane|stream-lines|event-identity|request-cadence)\.json$/.test(rel)) {
            out.notes[rel] = readJson(rel);
        } else if (/manager.*\.std(out|err)\.log$/.test(rel)) {
            out.managerLogs.push({ fixture: rel, text: readText(rel) });
        }
    }
    out.dialogs = exists('ws/J5-ui-dialogs/dialogs.json') ? readJson('ws/J5-ui-dialogs/dialogs.json') : gap('no dialogs.json recording exists');
    out.launchAttempts = exists('ws/J5-ui-launch/launch-attempts.json') ? readJson('ws/J5-ui-launch/launch-attempts.json') : gap('no launch-attempts.json recording exists');
    return out;
}

function noteFiles() {
    return {
        configList: exists('localstorage/J6-corpus-smoke/config-list.json') ? readJson('localstorage/J6-corpus-smoke/config-list.json') : null,
        survey: exists('localstorage/J6-corpus-smoke/model-path-select-survey.json') ? readJson('localstorage/J6-corpus-smoke/model-path-select-survey.json') : null,
        stateNotes: exists('screenshots/J5-ui-states/state-notes.json') ? readJson('screenshots/J5-ui-states/state-notes.json') : null,
        iniClaims: exists('ini/J4b-ui-presets-launch/presets-claims.json') ? readJson('ini/J4b-ui-presets-launch/presets-claims.json') : null,
        portEvidence: exists('argv/J4-launch-presets/port-source-evidence.json') ? readJson('argv/J4-launch-presets/port-source-evidence.json') : null,
        probe: exists('argv/J5-ui-launch/probe-stand-in.json') ? readJson('argv/J5-ui-launch/probe-stand-in.json') : null,
        firstRun: exists('http/J0-baseline/first-run-note.json') ? readJson('http/J0-baseline/first-run-note.json') : null,
        restartSettle: exists('http/J3d-restart/restart-settle.json') ? readJson('http/J3d-restart/restart-settle.json') : null,
        settingsAfter: ['with-port', 'without-port'].map((kind) => ({
            kind,
            fixture: `ini/J1-settings/settings.after-${kind}.json`,
            exists: exists(`ini/J1-settings/settings.after-${kind}.json`),
            value: exists(`ini/J1-settings/settings.after-${kind}.json`) ? readJson(`ini/J1-settings/settings.after-${kind}.json`) : null,
        })),
        corpus: exists('corpus/configs.remapped.json') ? readJson('corpus/configs.remapped.json') : gap('no corpus/configs.remapped.json recording exists'),
        corpusSettings: exists('corpus/settings.remapped.json') ? readJson('corpus/settings.remapped.json') : null,
        comparison: readJson('COMPARISON.json'),
    };
}

// --- pairing: recorded value -> the field that produced it -------------------------------
// A flag/ini-key belongs to a field only when the recorded value identifies it uniquely:
// exactly one field of that launch holds a value whose string form equals the emitted text.
// A tie is a gap, not a guess. Cross-journey intersection can break a tie when the candidate
// sets differ; that is reported as `pairedBy: 'cross-journey intersection'`.
const asText = (value) => (value === null || value === undefined ? '' : String(value));

function candidatesForValue(value, emitted) {
    return Object.keys(value)
        .filter((key) => asText(value[key]) === emitted)
        .sort();
}

// Presence correlation for valueless emissions (bare flags, `= true` lines): a key is claimed
// by a boolean field whose truthiness matches the key's presence in EVERY launch where the field
// value is known, with at least one launch where the key is present and one where it is absent.
// observations: { launch: { emittedKeys: Set, bools: { field: boolean|undefined } } }
function correlatePresence(observations) {
    const launches = Object.keys(observations).sort();
    const fields = [...new Set(launches.flatMap((l) => Object.keys(observations[l].bools)))];
    const keys = [...new Set(launches.flatMap((l) => [...observations[l].emittedKeys]))];
    const out = {};
    for (const key of keys) {
        const present = launches.map((l) => observations[l].emittedKeys.has(key));
        if (present.every(Boolean) || present.every((v) => !v)) continue;
        const matching = fields.filter((field) => {
            const truth = launches.map((l) => observations[l].bools[field]);
            if (truth.some((v) => v === undefined)) return false;
            return truth.every((t, i) => !!t === present[i]);
        });
        if (matching.length === 1) out[key] = { field: matching[0], launches: launches.length, present };
    }
    return out;
}

module.exports = {
    readText, readJson, exists, walkDir,
    httpRequest, httpRecordings, storageStates, fieldDumpStates, q8Reset,
    renderStates, argvSpawns, iniDocs, wsRecordings, noteFiles,
    asText, candidatesForValue, correlatePresence, gap,
};
