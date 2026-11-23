#!/usr/bin/env node
// Pack writers for the reconciled Phase 3 SPEC pack (plan.md §2 Phase 3 "Final pack files").
//
// Every value in the pack carries the derivations that state it and the pointers they cite, so a
// reader of SPEC/*.json never has to guess whether a fact came from the source, the recordings, or
// the model pass. The .md files are human views of the same JSON, generated from it.

'use strict';

const fs = require('fs');
const path = require('path');
const C = require('./spec-common');
const views = require('./spec-views');

const short = (resolution) => {
    const entry = { value: resolution.value, sources: resolution.from.slice(), resolution: resolution.status };
    if (resolution.note) entry.note = resolution.note;
    if (resolution.reason) entry.resolutionReason = resolution.reason;
    if (resolution.modelValue !== undefined) entry.modelValue = resolution.modelValue;
    if (resolution.modelWording !== undefined) entry.modelWording = resolution.modelWording;
    if (resolution.rule) entry.rule = resolution.rule;
    if (resolution.over) entry.overrides = resolution.over;
    if (resolution.runtime !== undefined) entry.runtimeValue = resolution.runtime;
    if (resolution.evidence && resolution.evidence.length) entry.evidence = [...new Set(resolution.evidence)].slice(0, 6);
    return entry;
};

const rowsOf = (rows, artifact) => rows.filter((row) => row.artifact === artifact);
const subjectsOf = (rows, artifact) => [...new Set(rowsOf(rows, artifact).map((row) => row.subject))].sort();

// --- field-manifest ------------------------------------------------------------------------
function fieldPack({ rows, resolutions, fields, loaded, loadedRuntime, loadedModel }) {
    const staticFields = Object.fromEntries(loaded['field-manifest'].fields.map((f) => [f.id, f]));
    const modelFields = Object.fromEntries(loadedModel['field-manifest'].fields.map((f) => [f.id, f]));
    const runtimeFields = loadedRuntime['field-manifest'].fields;
    const entries = subjectsOf(rows, 'field-manifest').map((id) => {
        const entry = {
            id,
            attributes: {},
            pointers: { static: `SPEC/from-static/field-manifest.json#${id}`, model: `SPEC/from-model/field-manifest.json#${id}` },
            gate: fields[id] ? { derivations: fields[id].derivations, pass: fields[id].pass } : null,
        };
        if (runtimeFields[id]) {
            const control = runtimeFields[id].control;
            const stored = runtimeFields[id].stored;
            entry.pointers.runtime = [control && !control.__gap ? `SPEC/from-runtime/field-manifest.json#${id}.control` : null, stored && !stored.__gap ? `SPEC/from-runtime/field-manifest.json#${id}.stored` : null].filter(Boolean);
            if (!entry.pointers.runtime.length) delete entry.pointers.runtime;
        }
        for (const row of rowsOf(rows, 'field-manifest').filter((r) => r.subject === id)) {
            entry.attributes[row.attribute] = short(resolutions.get(row.id));
        }
        const quirks = (modelFields[id] || {}).quirks;
        const staticEvidence = (staticFields[id] || {}).evidence;
        entry.annotations = {
            sourceEvidence: staticEvidence || null,
            modelNotes: quirks && quirks.length ? quirks : null,
            runtimeObservation: runtimeFields[id] ? { control: runtimeFields[id].control, stored: runtimeFields[id].stored, resetEvidence: runtimeFields[id].resetEvidence } : null,
        };
        return entry;
    });
    const persisted = entries.filter((e) => e.attributes.persisted && e.attributes.persisted.value === true).map((e) => e.id).sort();
    const inConfigs = entries.filter((e) => e.attributes.persistedIn && e.attributes.persistedIn.value === 'llamaCppConfigs').map((e) => e.id).sort();
    const inSettings = entries.filter((e) => e.attributes.persistedIn && String(e.attributes.persistedIn.value || '').includes('Settings')).map((e) => e.id).sort();
    return {
        artifact: 'field-manifest',
        schemaVersion: 1,
        generatedBy: 'tools/parity/spec-reconcile.js',
        rule: 'plan.md §4 ladder: recorded runtime output > static read of parity-baseline > independent model pass',
        fieldCount: entries.length,
        persistedFieldCount: persisted.length,
        persistedFields: persisted,
        persistedIntoConfigs: { count: inConfigs.length, fields: inConfigs },
        persistedIntoSettings: { count: inSettings.length, fields: inSettings },
        fieldUniverseRule: loaded['field-manifest'].fieldUniverseRule,
        deleteResetRecording: loadedRuntime['field-manifest'].deleteReset,
        fields: entries,
    };
}

// --- arg-truth-table -----------------------------------------------------------------------
function argPack({ rows, resolutions, loaded, loadedRuntime }) {
    const subjects = subjectsOf(rows, 'arg-truth-table').filter((s) => !s.startsWith('@'));
    const flags = subjects.map((flag) => {
        const entry = { flag };
        for (const row of rowsOf(rows, 'arg-truth-table').filter((r) => r.subject === flag)) entry[row.attribute] = short(resolutions.get(row.id));
        return entry;
    });
    return {
        artifact: 'arg-truth-table',
        schemaVersion: 1,
        generatedBy: 'tools/parity/spec-reconcile.js',
        rule: 'one row per args.push site in launchServer, in source order; recorded bodies corroborate order, values and conditionality',
        emission: {
            orderSemantics: short(resolutions.get('flag:@order.semantics')),
            alwaysAppended: short(resolutions.get('flag:@always-appended.flags')),
        },
        recordedBodies: {
            note: loadedRuntime['arg-truth-table'].emissionOrder.note,
            evidence: loadedRuntime['arg-truth-table'].emissionOrder.evidence,
            launches: Object.keys(loadedRuntime['arg-truth-table'].emissionOrder.launches),
        },
        alwaysEmittedObserved: loadedRuntime['arg-truth-table'].alwaysEmitted,
        flags,
        driverAuthoredBodies: loadedRuntime['arg-truth-table'].driverAuthoredBodies,
        gaps: loadedRuntime['arg-truth-table'].gaps,
    };
}

// --- ini-map -------------------------------------------------------------------------------
function iniPack({ rows, resolutions, loaded, loadedRuntime, loadedModel }) {
    const subjects = subjectsOf(rows, 'ini-map').filter((s) => !s.startsWith('@'));
    const keys = subjects.map((key) => {
        const entry = { key };
        for (const row of rowsOf(rows, 'ini-map').filter((r) => r.subject === key)) entry[row.attribute] = short(resolutions.get(row.id));
        return entry;
    });
    return {
        artifact: 'ini-map',
        schemaVersion: 1,
        generatedBy: 'tools/parity/spec-reconcile.js',
        rule: 'one row per `key = value` line emitted by launchModelPresets, in emission order; the trailing port line is Q10',
        structure: {
            versionHeader: short(resolutions.get('ini:@version-header.header')),
            lineFormat: short(resolutions.get('ini:@line-format.rule')),
            sectionOrder: short(resolutions.get('ini:@section-order.rule')),
            trailingLine: short(resolutions.get('ini:@trailing-line.keys')),
            nameDivergences: short(resolutions.get('ini:@name-divergences.pairs')),
        },
        insertionOrderRule: {
            fact: 'section order is JSON.parse(localStorage.llamaCppConfigs) insertion order, not alphabetical; the rendered config list is sorted separately (§9 trap 6)',
            sources: ['a', 'c'],
            evidence: ['SPEC/from-static/ini-map.json#structure.sectionOrder', 'SPEC/from-runtime/ini-map.json#documents'],
        },
        trailingQuirk: {
            fact: 'Q10: the last line is "port = <settings.serverPort>" and it is appended after the loop with no section header after it, so the file ends with an orphan key',
            sources: ['a', 'c', 'b'],
            evidence: ['SPEC/from-runtime/ini-map.json#keysAfterLastSection', 'fixtures/ini/J4-launch-presets/presets-direct.ini'],
        },
        keys,
        recordedDocuments: loadedRuntime['ini-map'].documents,
        claimsFromTheApp: loadedRuntime['ini-map'].claimsFromTheApp,
        cliOnlyFlags: loadedModel['ini-map'].cliOnlyFlags,
        notEmittedToIni: loadedModel['ini-map'].notEmittedToIni,
        gaps: loadedRuntime['ini-map'].gaps,
    };
}

// --- api-contract (OpenAPI + human view) ----------------------------------------------------
const schemaFromObserved = (shape) => {
    if (!shape) return { type: 'object', additionalProperties: true };
    if (typeof shape === 'string') return { type: 'string', description: 'recorded response bytes; the body is not JSON', example: shape };
    if (shape.empty) return { description: 'empty body recorded' };
    if (!shape.shape) return { type: 'object', additionalProperties: true };
    if (typeof shape.shape === 'string') return { type: 'string' };
    const typeOf = (describe) => {
        const text = String(describe);
        if (text.startsWith('array')) return { type: 'array', items: { type: 'object', additionalProperties: true } };
        if (text.startsWith('object')) return { type: 'object', additionalProperties: true };
        if (text === 'null') return { nullable: true };
        if (text === 'true' || text === 'false') return { type: 'boolean' };
        if (/^-?\d/.test(text)) return { type: 'number' };
        return { type: 'string' };
    };
    return { type: 'object', properties: Object.fromEntries(Object.entries(shape.shape).map(([key, describe]) => [key, typeOf(describe)])) };
};

function apiPack({ rows, resolutions, loaded, loadedRuntime }) {
    const routeSubjects = subjectsOf(rows, 'api-contract').filter((s) => !s.startsWith('@'));
    const staticRoutes = Object.fromEntries(loaded['api-contract'].routes.map((r) => [`${r.method} ${r.path}`, r]));
    const recorded = loadedRuntime['api-contract'].routes;
    const paths = {};
    const notes = [];
    for (const key of routeSubjects) {
        const [method, route] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)];
        const registered = resolutions.get(`route:${key}.registered`);
        const statuses = resolutions.get(`route:${key}.statuses`) || {};
        const kinds = resolutions.get(`route:${key}.responseKinds`) || {};
        const requestBodyFields = resolutions.get(`route:${key}.requestBodyFields`);
        const sourceStatuses = (Array.isArray(statuses.value) ? statuses.value : []).filter((s) => typeof s === 'number');
        const recordedStatuses = (recorded[key] && recorded[key].statusesRecorded) || [];
        const allStatuses = [...new Set([...sourceStatuses, ...recordedStatuses])].sort((x, y) => x - y);
        const responses = {};
        const observed = (recorded[key] && recorded[key].responses) || [];
        for (const status of allStatuses.length ? allStatuses : [200]) {
            const match = observed.find((r) => r.status === status) || observed[0];
            const isFile = (kinds.value || []).includes('file') && status === 200;
            responses[String(status)] = {
                description: `${method} ${route} → ${status}` + (recordedStatuses.includes(status) ? ' (status recorded from legacy)' : ' (status read from parity-baseline source; the recording captured the body only)'),
                content: isFile
                    ? { 'text/html': { schema: { type: 'string' }, example: '<!DOCTYPE html> …' } }
                    : { 'application/json': { schema: schemaFromObserved(match ? match.shape : null) } },
                'x-status-source': recordedStatuses.includes(status) ? 'runtime recording' : 'static source read',
            };
        }
        const operation = {
            operationId: `${method.toLowerCase()}${route.replace(/[^a-zA-Z0-9]+/g, '_') || '_root'}`,
            summary: `${key} — registered: ${JSON.stringify(registered.value)}`,
            description: [
                `derivations stating registration: ${(registered.from || []).join('+') || 'runtime recording only'}`,
                (registered.value === null || registered.value === undefined) && recorded[key] ? 'NOT registered in parity-baseline: the recorded request answered from the framework default handler, not from an app route.' : '',
            ].filter(Boolean).join(' '),
            responses,
            'x-derivations': registered.from || [],
            'x-evidence': (recorded[key] && recorded[key].requestFixtures) || [],
        };
        if (requestBodyFields && requestBodyFields.value) {
            const fields = Array.isArray(requestBodyFields.value) ? requestBodyFields.value : [];
            operation.requestBody = {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            properties: Object.fromEntries(fields.map((field) => [field, field === 'args' ? { type: 'array', items: { type: 'string' } } : { type: ['serverPort'].includes(field) ? 'number' : 'string' }])),
                            required: fields,
                        },
                    },
                },
                'x-derivations': requestBodyFields.from,
            };
        } else if (method === 'POST') {
            operation.requestBody = { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } };
            notes.push(`${key}: POST with no request body in parity-baseline`);
        }
        paths[route] = paths[route] || {};
        paths[route][method.toLowerCase()] = operation;
    }
    const doc = {
        openapi: '3.0.3',
        info: {
            title: 'llama-cpp-manager HTTP contract (parity port)',
            version: 'parity-baseline',
            description: [
                'Regenerated for the Phase 3 SPEC pack from runtime evidence (fixtures/http/**, fixtures/ws/**)',
                'cross-checked against the parity-baseline source read. Status codes carry an x-status-source',
                'field because the recordings captured response bytes, not status lines, except where noted.',
            ].join(' '),
        },
        servers: [{ url: (loadedRuntime['api-contract'].baseUrl || {}).origin || 'http://localhost:7837', description: 'the origin every recorded request was issued against (Q11: settings.serverPort never changes it)' }],
        paths,
        'x-non-routes': loaded['api-contract'].nonRoutes,
        'x-server': {
            listenPort: short(resolutions.get('api:@listen-port.port')),
            defaultPortConstant: short(resolutions.get('api:@default-port-constant.value')),
            middleware: short(resolutions.get('api:@server.stack')),
        },
        'x-runtime-only-observations': {
            settingsFileEffect: loadedRuntime['api-contract'].settingsFileEffect,
            launchPresetsPortSource: loadedRuntime['api-contract'].launchPresetsPortSource,
            restartEffect: loadedRuntime['api-contract'].restartEffect,
            metricsDegradation: loadedRuntime['api-contract'].metricsDegradation,
            clientPolling: loadedRuntime['api-contract'].clientPolling,
            clientGuards: loadedRuntime['api-contract'].clientGuards,
            firstRun: loadedRuntime['api-contract'].firstRun,
        },
        'x-notes': notes,
        'x-status-gaps': loadedRuntime['api-contract'].gaps,
    };
    return doc;
}

const safeJson = (text) => { try { return JSON.parse(text); } catch { return text; } };

// --- socket / process / storage -------------------------------------------------------------
function socketPack({ rows, resolutions, loaded, loadedRuntime, loadedModel }) {
    const events = subjectsOf(rows, 'socket-contract').filter((s) => !s.startsWith('@'));
    return {
        artifact: 'socket-contract',
        schemaVersion: 1,
        generatedBy: 'tools/parity/spec-reconcile.js',
        rule: 'server→client emits, their payloads, and what the recorded sockets actually carried',
        transport: {
            clientConnect: short(resolutions.get('socket:@transport.connect')),
            clientHandlers: short(resolutions.get('socket:@client-handlers.events')),
        },
        events: events.map((event) => {
            const entry = { event };
            for (const row of rowsOf(rows, 'socket-contract').filter((r) => r.subject === event)) entry[row.attribute] = short(resolutions.get(row.id));
            return entry;
        }),
        absentEvents: short(resolutions.get('socket:@absent.events')),
        logStreamChunks: short(resolutions.get('socket:@log-stream.chunkShape')),
        recordedConnections: loadedRuntime['socket-contract'].connections,
        paneBehaviour: loadedRuntime['socket-contract'].paneBehaviour,
        endedPayloads: loadedRuntime['socket-contract'].endedPayloads,
        gaps: loadedRuntime['socket-contract'].gaps,
        modelPaneRules: loadedModel['socket-contract'].paneRules,
    };
}

function processPack({ rows, resolutions, loaded, loadedRuntime, loadedModel }) {
    const entry = {
        artifact: 'process-lifecycle',
        schemaVersion: 1,
        generatedBy: 'tools/parity/spec-reconcile.js',
        rule: 'how the child llama-server is spawned, killed and observed; plan §9 Q23/Q24 race semantics included',
        facts: {},
        recordedSpawns: loadedRuntime['process-lifecycle'].spawns,
        stopEffect: loadedRuntime['process-lifecycle'].stopEffect,
        restartEffect: loadedRuntime['process-lifecycle'].restartEffect,
        exitCodeEvidence: loadedRuntime['process-lifecycle'].exitCodeEvidence,
        pollCadence: loadedRuntime['process-lifecycle'].pollCadence,
        raceSemantics: loadedModel['process-lifecycle'].kill.orderDefect,
        launchPresetsArgs: loadedModel['process-lifecycle'].launchPresetsPath,
        gaps: loadedRuntime['process-lifecycle'].gaps,
    };
    for (const row of rowsOf(rows, 'process-lifecycle')) {
        const key = `${row.subject} ${row.attribute}`;
        entry.facts[key] = short(resolutions.get(row.id));
    }
    return entry;
}

function storagePack({ rows, resolutions, loaded, loadedRuntime, loadedModel }) {
    const entry = {
        artifact: 'storage-schema',
        schemaVersion: 1,
        generatedBy: 'tools/parity/spec-reconcile.js',
        rule: 'localStorage keys and shapes as written by public/script.js, plus what the dumps recorded',
        facts: {},
        writeOrder: loadedRuntime['storage-schema'].writeOrder,
        configsShape: loadedRuntime['storage-schema'].configsShape,
        settingsShape: loadedRuntime['storage-schema'].settingsShape,
        serverPortInConfigs: loadedRuntime['storage-schema'].serverPortInConfigs,
        deleteReset: loadedRuntime['storage-schema'].deleteReset,
        configListOrder: loadedRuntime['storage-schema'].configListOrder,
        valueTypes: loadedModel['storage-schema'].valueTypes,
        rawStringTrap: loadedModel['storage-schema'].rawStringTrap,
        configNameRules: loadedModel['storage-schema'].configNameRules,
        gaps: loadedRuntime['storage-schema'].gaps,
    };
    for (const row of rowsOf(rows, 'storage-schema')) entry.facts[`${row.subject} ${row.attribute}`] = short(resolutions.get(row.id));
    return entry;
}

// --- entry ---------------------------------------------------------------------------------
function write(bundle) {
    const outputs = {
        'field-manifest.json': fieldPack(bundle),
        'arg-truth-table.json': argPack(bundle),
        'ini-map.json': iniPack(bundle),
        'api-contract.openapi.json': apiPack(bundle),
        'socket-contract.json': socketPack(bundle),
        'process-lifecycle.json': processPack(bundle),
        'storage-schema.json': storagePack(bundle),
    };
    for (const [name, artifact] of Object.entries(outputs)) C.writeJson(path.join(C.SPEC, name), artifact);
    const written = Object.keys(outputs).concat(views.writeViews(outputs));
    return written;
}

module.exports = { write, fieldPack, argPack, iniPack, apiPack, socketPack, processPack, storagePack };
