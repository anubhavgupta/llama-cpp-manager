#!/usr/bin/env node
// (b) RUNTIME derivation of the Phase 3 SPEC pack (plan.md §2 Phase 3).
//
// Reads fixtures/** recordings and nothing else — no app source, no (a) or (c) output. What the
// recordings cannot show is emitted as C.gap(reason) instead of a value, so the reconciliation step
// can tell "the recording proves X" apart from "the recording is silent about X".
//
// Outputs: SPEC/from-runtime/{field-manifest,arg-truth-table,ini-map,api-contract,
// socket-contract,process-lifecycle,storage-schema}.json
//
// Run: node tools/parity/spec-runtime.js

'use strict';

const fs = require('fs');
const path = require('path');
const C = require('./spec-common');
const E = require('./spec-runtime-evidence');
const P = require('./spec-runtime-pairing');

const OUT = path.join(C.SPEC, 'from-runtime');
const RULE = 'derived from fixtures/** recordings only; no app source was read (plan.md §2 Phase 3 (b))';
const asText = E.asText;

// Count the gap markers and the fixture citations in one artifact: the pack has to say honestly
// how much it derived and where each claim came from.
function tally(value, found = { gaps: 0, evidence: 0 }) {
    if (value === null || typeof value !== 'object') return found;
    if (Array.isArray(value)) { value.forEach((item) => tally(item, found)); return found; }
    if (value.__gap === true) found.gaps += 1;
    for (const [key, item] of Object.entries(value)) {
        if (key === 'evidence' || key === 'fixtures' || key === 'evidenceFiles') {
            found.evidence += Array.isArray(item) ? item.length : 1;
            continue;
        }
        tally(item, found);
    }
    return found;
}

// --- shared views -----------------------------------------------------------------------
function views() {
    const launches = P.launchObservations();
    const iniObs = P.iniObservations();
    return {
        launches,
        iniObs,
        flags: P.flagClaims(launches),
        iniKeys: P.iniKeyClaims(iniObs),
        states: E.storageStates(),
        notes: E.noteFiles(),
        recordings: E.httpRecordings(),
        ws: E.wsRecordings(),
        renders: E.renderStates(),
        spawns: E.argvSpawns(),
    };
}

const reverseIndex = (claims) => {
    const byField = {};
    for (const [key, claim] of Object.entries(claims)) {
        if (!claim.field) continue;
        (byField[claim.field] = byField[claim.field] || []).push({ key, pairedBy: claim.pairedBy, evidence: claim.evidence });
    }
    return byField;
};

// The delete flow is recorded twice: before the delete (both capture-* configs stored) and after
// it (one survivor), plus q8-delete-reset.json, which compares every control across the delete and
// lists only the ones that moved. A control that did not move while its stored value differs from
// the reset value the other derivations claim is a contradiction they have to answer.
function deleteResetEvidence(states) {
    const q8 = E.q8Reset();
    const afterDelete = states.find((s) => s.fixture.includes('after-delete.json'));
    const beforeDelete = states.find((s) => s.fixture.includes('after-save-config.json'));
    const survivors = afterDelete ? Object.keys(afterDelete.configs) : [];
    const deletedName = beforeDelete ? Object.keys(beforeDelete.configs).find((name) => !survivors.includes(name)) : null;
    const controlsCompared = q8.__gap ? null : q8.controlCount;
    const changedIds = q8.__gap ? null : q8.changed.map((row) => row.id);
    return {
        fixture: q8.__gap ? null : q8.fixture,
        q8,
        deletedConfig: deletedName || (q8.__gap ? null : E.gap('no recording identifies which config was deleted')),
        deletedValues: deletedName && beforeDelete ? beforeDelete.configs[deletedName] : null,
        survivors,
        controlsCompared,
        changedIds,
        note: 'q8-delete-reset.json records every control it compared in controlCount and lists only the rows that changed, so an absent row means "compared and unchanged"',
    };
}

// --- field-manifest.json ------------------------------------------------------------------
function fieldManifest(v) {
    const controls = new Map();
    for (const state of v.states) {
        for (const f of state.fields || []) {
            controls.set(f.id, { tag: f.tag, type: f.tag === 'select' ? 'select' : f.type, valuesObserved: [], seenIn: [] });
            const entry = controls.get(f.id);
            entry.valuesObserved.push(asText(f.checked === null ? f.value : f.checked));
            entry.seenIn.push(state.fixture);
        }
    }
    for (const render of v.renders) {
        for (const el of render.elements) {
            if (!controls.has(el.id) && (el.id === 'modelsDirectory' || el.id === 'serverPort')) {
                controls.set(el.id, { tag: el.tag || 'input', type: el.type === undefined ? null : el.type, valuesObserved: [asText(el.value)], seenIn: [render.fixture] });
            }
        }
    }
    const storedKeys = new Map();
    const settingsKeys = new Set(v.states.flatMap((s) => Object.keys(s.settings || {})));
    for (const state of v.states) {
        for (const config of Object.values(state.configs)) {
            for (const [key, value] of Object.entries(config)) {
                const entry = (storedKeys.get(key) || { values: new Set(), seenIn: [] });
                entry.values.add(asText(value));
                if (!entry.seenIn.includes(state.fixture)) entry.seenIn.push(state.fixture);
                storedKeys.set(key, entry);
            }
        }
    }

    const flagsByField = reverseIndex(v.flags);
    const iniByField = reverseIndex(v.iniKeys);
    const reset = deleteResetEvidence(v.states);
    const names = [...new Set([...controls.keys(), ...storedKeys.keys()])].sort();
    const fields = {};
    for (const name of names) {
        const control = controls.get(name);
        const stored = storedKeys.get(name);
        fields[name] = {
            control: control
                ? { tag: control.tag, type: control.type, observedValues: [...new Set(control.valuesObserved)], fixtures: [...new Set(control.seenIn)].slice(0, 3) }
                : E.gap(`no recording captured a control with id "${name}"; it is only visible as a stored config key`),
            stored: stored
                ? { values: [...stored.values].sort(), fixtures: stored.seenIn }
                : settingsKeys.has(name)
                    ? { values: [...new Set(v.states.filter((s) => s.settings && s.settings[name] !== undefined).map((s) => asText(s.settings[name])))].sort(), fixtures: [...new Set(v.states.filter((s) => s.settings && s.settings[name] !== undefined).map((s) => s.fixture))], container: 'llamaCppSettings' }
                    : E.gap('no recorded llamaCppConfigs or llamaCppSettings value carries this key'),
            cliFlags: flagsByField[name] || E.gap('no recorded /start body lets a flag be paired with this field by value identity'),
            iniKeys: iniByField[name] || E.gap('no recorded models-preset.ini section lets a key be paired with this field by value identity'),
            resetEvidence: control && reset.deletedValues
                ? {
                    observed: (reset.changedIds || []).includes(name) ? 'control changed when the config was deleted' : 'control did not change when the config was deleted',
                    deletedConfig: reset.deletedConfig,
                    valueBeforeDelete: reset.deletedValues.hasOwnProperty(name) ? reset.deletedValues[name] : null,
                    fixtures: [reset.fixture, 'localstorage/J5-ui-states/after-save-config.json', 'localstorage/J5-ui-states/after-delete.json'].filter(Boolean),
                }
                : E.gap(control ? 'no recording pairs a delete with this control\'s stored value' : 'no control recorded for this key, so a delete cannot be observed on it'),
        };
    }
    return {
        generatedBy: 'tools/parity/spec-runtime.js',
        rule: RULE,
        fieldUniverse: {
            domControlIds: { count: controls.size, ids: [...controls.keys()], source: [...new Set(v.states.filter((s) => s.fields).map((s) => s.fixture))] },
            storedConfigKeys: { count: storedKeys.size, keys: [...storedKeys.keys()].sort(), source: [...new Set(v.states.filter((s) => Object.keys(s.configs).length).map((s) => s.fixture))] },
            storedKeysWithoutControl: [...storedKeys.keys()].filter((k) => !controls.has(k)).sort(),
            note: 'the settings dialog inputs modelsDirectory and serverPort appear in the screenshot DOM dumps, not in the localStorage field dumps',
        },
        fields,
        deleteReset: reset,
        gaps: [
            C.gap('field ordering inside the emitted arg vector and ini section is a property of the builder, not of the field list; see arg-truth-table.json and ini-map.json'),
            C.gap('which control feeds which stored key is only visible through value identity; every field whose value never differs from another field\'s value is unpaired here'),
        ],
    };
}

// --- arg-truth-table.json -----------------------------------------------------------------
function argTruthTable(v) {
    const client = v.launches;
    const observed = {};
    for (const [flag, claim] of Object.entries(v.flags)) observed[flag] = claim;
    const allFlags = Object.keys(observed).sort();
    const alwaysPresent = allFlags.filter((flag) => client.filter((l) => l.values).length > 0 && client.filter((l) => l.values).every((l) => l.args.includes(flag)));
    const perLaunchOrder = {};
    for (const launch of client) {
        perLaunchOrder[launch.launch] = P.parseArgv(launch.args).map((entry, index) => ({ position: index, flag: entry.flag, value: entry.value === null ? C.gap('flag emitted with no value token') : entry.value }));
    }
    const driverBodies = v.recordings.filter((r) => r.path === '/start' && !r.fromPage && r.requestBody && r.requestBody.args).map((r) => ({ fixture: r.fixture, flags: P.parseArgv(r.requestBody.args).map((p) => p.flag) }));
    return {
        generatedBy: 'tools/parity/spec-runtime.js',
        rule: RULE,
        emissionOrder: {
            note: 'the order below is the order the page itself POSTed, recorded on the wire; it is the only order the recordings can show',
            launches: perLaunchOrder,
            evidence: [...new Set(client.flatMap((l) => l.evidence))],
        },
        alwaysEmitted: { flags: alwaysPresent, launches: client.filter((l) => l.values).length },
        flags: Object.fromEntries(allFlags.map((flag) => [flag, {
            observedIn: client.filter((l) => l.values && l.args.includes(flag)).map((l) => l.launch),
            absentIn: client.filter((l) => l.values && !l.args.includes(flag)).map((l) => l.launch),
            valuesObserved: observed[flag].values,
            field: observed[flag].field || E.gap(`recorded values cannot identify the field: ${observed[flag].candidates.length ? `candidates ${observed[flag].candidates.join(', ')}` : 'no field value matches the emitted text'}${observed[flag].contradictedBy.length ? `; pairing with ${observed[flag].contradictedBy.join(', ')} is contradicted by another recording` : ''}`),
            pairedBy: observed[flag].pairedBy,
            evidence: observed[flag].evidence,
        }])),
        driverAuthoredBodies: {
            note: 'these /start bodies were written by the capture harness, not by the page, so they are listed but never paired (C5)',
            bodies: driverBodies,
        },
        gaps: [
            C.gap('a flag that every recorded launch emits has no negative observation, so the condition that gates it is invisible (see alwaysEmitted and flags[].absentIn)'),
            C.gap('the order of flags that no recorded launch emitted cannot be derived; only flags present in the recordings are listed'),
        ],
    };
}

// --- ini-map.json -------------------------------------------------------------------------
function iniMap(v) {
    const docs = E.iniDocs().map((doc) => ({
        fixture: doc.fixture,
        versionHeader: doc.versionHeader,
        sections: doc.sections.map((s) => ({ name: s.name, keys: s.keys.map((k) => (k.key ? `${k.key} = ${k.value}` : k.unparsed)) })),
        afterLastSection: doc.trailing.map((t) => `${t.key} = ${t.value}`),
        unparsedLines: doc.sections.flatMap((s) => s.keys.filter((k) => !k.key).map((k) => k.unparsed)),
    }));
    const trailingKeys = [...new Set(E.iniDocs().flatMap((d) => d.trailing.map((t) => t.key)))];
    const claims = Object.fromEntries(Object.entries(v.iniKeys).map(([key, claim]) => [key, {
        observedIn: claim.evidence,
        valuesObserved: claim.values,
        field: claim.field || E.gap(`recorded values cannot identify the field: ${claim.candidates.length ? `candidates ${claim.candidates.join(', ')}` : 'no field value matches the emitted text'}${claim.contradictedBy.length ? `; pairing with ${claim.contradictedBy.join(', ')} is contradicted by another recording` : ''}`),
        pairedBy: claim.pairedBy,
    }]));
    return {
        generatedBy: 'tools/parity/spec-runtime.js',
        rule: RULE,
        lineFormat: { observed: 'every recorded line is "key = value" with one space around the equals sign', evidence: E.iniDocs().map((d) => d.fixture) },
        versionHeader: [...new Set(E.iniDocs().map((d) => d.versionHeader).filter(Boolean))],
        documents: docs,
        keysAfterLastSection: {
            keys: trailingKeys,
            evidence: E.iniDocs().filter((d) => d.trailing.length).map((d) => d.fixture),
            note: 'the recorded files end with this line and no section follows it',
        },
        keyClaims: claims,
        claimsFromTheApp: v.notes.iniClaims || E.gap('no presets-claims.json recording exists'),
        gaps: [
            C.gap('a section with no stored config behind it is invisible: every recorded section name matches a stored config in the same recording, so nothing shows what happens to an unsaved form'),
            C.gap('whether an ini key is emitted when its field holds a retired enum value is not recorded; no recording writes an ini while a control holds a retired value'),
            C.gap('the key order inside a section is only observable per recorded document; the three recordings agree but a key that never appears in them has no position'),
        ],
    };
}

// --- api-contract.json --------------------------------------------------------------------
const bodyShape = (text) => {
    if (text === null) return C.gap('no response bytes were recorded for this request');
    const trimmed = text.trim();
    if (!trimmed) return { empty: true };
    try {
        const parsed = JSON.parse(trimmed);
        const describe = (value) => (Array.isArray(value) ? `array[${value.length}]` : value === null ? 'null' : typeof value === 'object' ? `object{${Object.keys(value).join(',')}}` : JSON.stringify(value));
        return { json: true, shape: parsed && typeof parsed === 'object' ? Object.fromEntries(Object.keys(parsed).map((k) => [k, describe(parsed[k])])) : describe(parsed), sample: trimmed.slice(0, 220) };
    } catch {
        return { json: false, firstBytes: trimmed.slice(0, 120), length: trimmed.length };
    }
};

function apiContract(v) {
    const routes = {};
    for (const rec of v.recordings) {
        const id = `${rec.method} ${rec.path}`;
        const route = (routes[id] = routes[id] || {
            requests: 0,
            requestFixtures: [],
            builtByPage: false,
            requestBodyFields: new Set(),
            responses: [],
            statuses: [],
        });
        route.requests += 1;
        route.requestFixtures.push(rec.fixture);
        if (rec.fromPage) route.builtByPage = true;
        if (rec.requestBody && typeof rec.requestBody === 'object') Object.keys(rec.requestBody).forEach((k) => route.requestBodyFields.add(k));
        const shape = bodyShape(rec.responseBody);
        route.responses.push({ fixture: rec.fixture, shape: shape.shape || shape.firstBytes || shape, status: rec.statusRecorded === null ? C.gap('the recording stores the response bytes only; the status line was not captured') : rec.statusRecorded, statusEvidence: rec.statusEvidence });
        if (rec.statusRecorded !== null) route.statuses.push(rec.statusRecorded);
    }
    const attempts = v.ws.launchAttempts;
    if (attempts && !attempts.__gap) {
        const route = routes['POST /start'] || (routes['POST /start'] = { requests: 0, requestFixtures: [], builtByPage: true, requestBodyFields: new Set(), responses: [], statuses: [] });
        for (const attempt of attempts.attempts || []) {
            if (typeof attempt.requestStatus === 'number') {
                route.statuses.push(attempt.requestStatus);
                route.responses.push({ fixture: 'ws/J5-ui-launch/launch-attempts.json', shape: { statusRecordedByCdp: attempt.requestStatus, blockedWith: attempt.requestBlockedWith }, status: attempt.requestStatus, statusEvidence: 'ws/J5-ui-launch/launch-attempts.json' });
            }
        }
    }
    const perRoute = Object.fromEntries(Object.entries(routes).map(([id, route]) => [id, {
        requestsRecorded: route.requests,
        builtByThePage: route.builtByPage,
        requestBodyFields: [...route.requestBodyFields].sort(),
        statusesRecorded: [...new Set(route.statuses)],
        responses: route.responses,
        requestFixtures: route.requestFixtures,
    }]));
    return {
        generatedBy: 'tools/parity/spec-runtime.js',
        rule: RULE,
        baseUrl: {
            origin: [...new Set(v.recordings.map((r) => (r.url || '').replace(/(\/[^/]*)$/, '')))].sort(),
            evidence: ['http/J0-baseline/root.request.json'],
            note: 'the origin every recorded request was issued against',
        },
        routes: perRoute,
        neverRecorded: {
            note: 'no recording exercises these, so (b) has no position on them',
            candidates: ['PUT/DELETE/PATCH on any path', 'any non-JSON request body', 'query strings on /status, /metrics, /models'],
        },
        clientGuards: {
            note: 'the page blocks some requests before they leave: these dialog messages and form states were recorded instead of a request',
            dialogs: v.ws.dialogs,
            launchAttempts: v.ws.launchAttempts,
        },
        clientPolling: v.ws.notes['ws/J5-ui-cadence/request-cadence.json'] || v.ws.notes['J5-ui-cadence/request-cadence.json'] || E.gap('no request-cadence.json recording exists'),
        settingsFileEffect: v.notes.settingsAfter,
        launchPresetsPortSource: v.notes.portEvidence || E.gap('no port-source-evidence.json recording exists'),
        restartEffect: {
            settleNote: (v.notes.restartSettle || {}).observation || E.gap('no restart-settle.json recording exists'),
            afterManagerRestart: E.exists('http/J3d-restart/restart-after-manager-restart.json') ? E.readJson('http/J3d-restart/restart-after-manager-restart.json') : E.gap('no restart-after-manager-restart.json recording exists'),
            getRestart: bodyShape((v.recordings.find((r) => r.name === 'restart-get-not-a-route') || {}).responseBody ?? null),
        },
        metricsDegradation: {
            note: E.exists('http/J2b-metrics-garbage/shape-note.json') ? E.readJson('http/J2b-metrics-garbage/shape-note.json').observation : E.gap('no shape-note.json recording exists'),
            evidence: ['http/J2b-metrics-garbage/shape-note.json', 'http/J2c-metrics-fail/metrics-1.response'],
        },
        firstRun: v.notes.firstRun || E.gap('no first-run-note.json recording exists'),
        gaps: [
            C.gap('HTTP status codes are missing from every recording except the ones listed in routes[].statusesRecorded; the response bodies are recorded in full'),
            C.gap('response headers were not captured, so content types are not derivable from the recordings'),
            C.gap('server-side branch coverage: a body recorded for one input says nothing about the branch another input would take'),
        ],
    };
}

// --- socket-contract.json -----------------------------------------------------------------
function socketContract(v) {
    const connections = v.ws.events.map((rec) => ({
        fixture: rec.fixture,
        connection: rec.connection,
        url: rec.events.url || null,
        eventNames: [...new Set(rec.events.map((e) => e.event))],
        firstEvent: rec.events.length ? rec.events[0].event : null,
        lastEvent: rec.events.length ? rec.events[rec.events.length - 1].event : null,
        counts: rec.events.reduce((acc, e) => { acc[e.event] = (acc[e.event] || 0) + 1; return acc; }, {}),
    }));
    const logStream = v.ws.events.flatMap((rec) => rec.events.filter((e) => e.event === 'log-stream').map((e) => e.payload));
    const payloadKeys = [...new Set(logStream.flatMap((p) => Object.keys(p || {})))].sort();
    const chunkSizes = [...new Set(logStream.map((p) => (p && typeof p.dataLength === 'number' ? p.dataLength : null)).filter((n) => n !== null))].sort((a, b) => a - b);
    const observedEvents = [...new Set(v.ws.events.flatMap((rec) => rec.events.map((e) => e.event)))].sort();
    return {
        generatedBy: 'tools/parity/spec-runtime.js',
        rule: RULE,
        connections,
        observedEventNames: observedEvents,
        logStreamPayload: {
            keys: payloadKeys,
            chunkByteSizes: chunkSizes,
            note: 'payload bytes are recorded base64-encoded; the recordings do not decode them on the client side, so re-assembly behaviour is not observable here',
            evidence: v.ws.events.map((rec) => rec.fixture),
        },
        serverError: observedEvents.includes('server-error')
            ? { observed: true, payloads: v.ws.events.flatMap((rec) => rec.events.filter((e) => e.event === 'server-error').map((e) => e.payload)) }
            : C.gap('no recorded connection carries a server-error event; the crash journey records server-ended instead'),
        endedPayloads: v.ws.events.flatMap((rec) => rec.events.filter((e) => e.event === 'server-ended').map((e) => ({ fixture: rec.fixture, payload: e.payload }))),
        paneBehaviour: {
            logPane: v.ws.notes['ws/J5-ui-log-cap/log-pane.json'] || v.ws.notes['J5-ui-log-cap/log-pane.json'] || E.gap('no log-pane.json recording exists'),
            chunkBoundary: v.ws.notes['ws/J5-ui-log-cap/chunk-boundary.json'] || v.ws.notes['J5-ui-log-cap/chunk-boundary.json'] || E.gap('no chunk-boundary.json recording exists'),
            sourceLines: v.ws.notes['ws/J3-start-stop/stream-lines.json'] || v.ws.notes['J3-start-stop/stream-lines.json'] || E.gap('no stream-lines.json recording exists'),
            eventIdentity: v.ws.notes['ws/J3d-restart/event-identity.json'] || v.ws.notes['J3d-restart/event-identity.json'] || E.gap('no event-identity.json recording exists'),
            paneTexts: { note: 'raw pane text dumps, golden-compared by the suite', fixtures: ['ws/J5-ui-log-cap/log-pane.text', 'ws/J5-ui-log-cap/log-pane-chunks7.text'] },
        },
        managerLogs: v.ws.managerLogs.map((log) => ({ fixture: log.fixture, bytes: log.text.length })),
        gaps: [
            C.gap('socket.io reconnection behaviour: no recording disconnects and reconnects the page'),
            C.gap('whether the client re-joins split log payloads is invisible: the recordings show pane line counts and payload sizes, not the app-side handler'),
            C.gap('event emission order inside the server is only observable as it arrived on one recorded socket'),
            C.gap('the socket path/namespace string is recorded as the page URL, not as the server-side namespace'),
        ],
    };
}

// --- process-lifecycle.json ---------------------------------------------------------------
function processLifecycle(v) {
    const spawns = v.spawns.map((spawn) => ({
        fixture: spawn.fixture,
        line: spawn.line,
        pid: spawn.pid,
        program: spawn.argv[0],
        argCount: spawn.argv.length - 1,
        args: spawn.argv.slice(1),
    }));
    const byJourney = {};
    for (const spawn of spawns) (byJourney[spawn.fixture] = byJourney[spawn.fixture] || []).push(spawn.pid);
    const statusBodies = v.recordings.filter((r) => r.path === '/status').map((r) => ({ fixture: r.fixture, body: r.responseBody && r.responseBody.trim().slice(0, 200) }));
    return {
        generatedBy: 'tools/parity/spec-runtime.js',
        rule: RULE,
        spawns: { note: 'every recorded child process launch, in file order; the recorder is the stand-in program named in argv/J5-ui-launch/probe-stand-in.json', count: spawns.length, records: spawns, journeys: Object.fromEntries(Object.entries(byJourney).map(([f, pids]) => [f, pids.length])) },
        stopEffect: {
            bodies: v.recordings.filter((r) => r.path === '/stop').map((r) => ({ fixture: r.fixture, body: r.responseBody && r.responseBody.trim().slice(0, 200) })),
            statusAfter: statusBodies,
            endedEvents: v.ws.events.flatMap((rec) => rec.events.filter((e) => e.event === 'server-ended').map((e) => ({ fixture: rec.fixture, payload: e.payload }))),
        },
        restartEffect: {
            settleNote: (v.notes.restartSettle || {}).observation || E.gap('no restart-settle.json recording exists'),
            bodies: v.recordings.filter((r) => r.path === '/restart').map((r) => ({ fixture: r.fixture, method: r.method, body: r.responseBody && r.responseBody.trim().slice(0, 200), status: r.statusRecorded })),
        },
        exitCodeEvidence: {
            note: 'the exit-code journey records the child argv, the socket events and the manager log; nothing records the signal the manager sent',
            fixtures: ['argv/J3b-exit-code/launch.jsonl', 'ws/J3b-exit-code/events.json', 'ws/J3b-exit-code/manager.stdout.log'],
        },
        pollCadence: v.ws.notes['ws/J5-ui-cadence/request-cadence.json'] || v.ws.notes['J5-ui-cadence/request-cadence.json'] || E.gap('no request-cadence.json recording exists'),
        gaps: [
            C.gap('which signal is sent, and whether a second signal is scheduled: nothing in the recordings observes the manager-to-child signal'),
            C.gap('spawn options (cwd, env, detached, stdio pipes) are not recorded; only the program path and its argument vector are'),
            C.gap('the manager process own port binding and restart handling are only visible through the recorded HTTP responses'),
        ],
    };
}

// --- storage-schema.json ------------------------------------------------------------------
function storageSchema(v) {
    const keysWritten = [...new Set(v.states.flatMap((s) => s.order || []))].sort();
    const configKeys = new Map();
    for (const state of v.states) {
        for (const config of Object.values(state.configs)) {
            for (const [key, value] of Object.entries(config)) {
                const entry = (configKeys.get(key) || { values: new Set(), types: new Set(), configs: 0 });
                entry.values.add(asText(value));
                entry.types.add(value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
                entry.configs += 1;
                configKeys.set(key, entry);
            }
        }
    }
    return {
        generatedBy: 'tools/parity/spec-runtime.js',
        rule: RULE,
        keysWritten: { keys: keysWritten, evidence: v.states.filter((s) => (s.order || []).length).map((s) => s.fixture) },
        writeOrder: v.states.map((s) => ({ fixture: s.fixture, order: s.order })),
        settingsShape: { keys: [...new Set(v.states.flatMap((s) => Object.keys(s.settings || {})))].sort(), values: v.states.filter((s) => s.settings).map((s) => ({ fixture: s.fixture, settings: s.settings })) },
        configsShape: Object.fromEntries([...configKeys.entries()].sort().map(([key, entry]) => [key, {
            types: [...entry.types],
            distinctValues: entry.values.size,
            observedInConfigs: entry.configs,
            writtenByControl: v.states.some((s) => (s.fields || []).some((f) => f.id === key)) ? 'a control with this id is recorded' : E.gap('no recorded control carries this id; the key only ever appears in stored JSON'),
        }])),
        serverPortInConfigs: {
            observed: [...configKeys.keys()].filter((k) => /port/i.test(k)),
            note: 'serverPort is recorded in llamaCppSettings only; the corpus configs carry a port key of their own, see configsShape.port',
        },
        deleteReset: E.q8Reset(),
        configListOrder: v.notes.configList,
        gaps: [
            C.gap('what deleteConfiguration clears per config: the q8 recording compares control state after a delete, not stored JSON, and only one control is recorded as changed'),
            C.gap('whether a value is written back on load is invisible: every dump shows the post-load state, never the write sequence'),
        ],
    };
}

// --- main --------------------------------------------------------------------------------
function main() {
    const v = views();
    const artifacts = {
        'field-manifest.json': fieldManifest(v),
        'arg-truth-table.json': argTruthTable(v),
        'ini-map.json': iniMap(v),
        'api-contract.json': apiContract(v),
        'socket-contract.json': socketContract(v),
        'process-lifecycle.json': processLifecycle(v),
        'storage-schema.json': storageSchema(v),
    };
    fs.mkdirSync(OUT, { recursive: true });
    const gaps = [];
    for (const [name, artifact] of Object.entries(artifacts)) {
        C.writeJson(path.join(OUT, name), artifact);
        const found = tally(artifact);
        gaps.push(`${name}: ${found.gaps} gap markers, ${found.evidence} fixture citations`);
    }
    const pairedFlags = Object.values(v.flags).filter((c) => c.field).length;
    const pairedIni = Object.values(v.iniKeys).filter((c) => c.field).length;
    console.log(`(b) RUNTIME derivation from ${v.recordings.length} HTTP recordings, ${v.states.length} localStorage dumps, ${v.spawns.length} argv records, ${E.iniDocs().length} ini documents, ${v.ws.events.length} socket traces`);
    for (const line of gaps) console.log('  ' + line);
    console.log(`  flag/field pairs derived by value identity: ${pairedFlags}/${Object.keys(v.flags).length}; ini key pairs: ${pairedIni}/${Object.keys(v.iniKeys).length}`);
    console.log(`  routes seen: ${Object.keys(apiContract(v).routes).length}`);
}

if (require.main === module) main();

module.exports = { views, fieldManifest, argTruthTable, iniMap, apiContract, socketContract, processLifecycle, storageSchema, OUT, RULE };
