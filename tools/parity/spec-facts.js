#!/usr/bin/env node
// Contract-fact extractors for the Phase 3 reconciler.
//
// The three derivations describe the same contracts in different shapes, so the reconciler does not
// diff files: it extracts one row per contract fact, with the value each derivation states. A row is
// { artifact, subject, attribute, a, c, b }, and a missing key means that derivation is silent.
//
// Row ids are stable strings so CONSISTENCY.md, the pack and the gates can cite the same fact.

'use strict';

const C = require('./spec-common');
const { readJson, isGap } = C;

const load = (dir) => {
    const names = ['field-manifest', 'arg-truth-table', 'ini-map', 'api-contract', 'socket-contract', 'process-lifecycle', 'storage-schema'];
    return Object.fromEntries(names.map((name) => [name, readJson(`${C.SPEC}/${dir}/${name}.json`)]));
};

// (b) stores gap markers instead of values; a gap counts as silent, not as a disagreement.
const value = (input) => (input === undefined ? undefined : isGap(input) ? undefined : input);

const sortedList = (list) => (Array.isArray(list) && list.length ? [...new Set(list)].sort() : null);

// --- field rows ---------------------------------------------------------------------------
const FIELD_ATTRS = [
    ['tag', 'structure'], ['htmlType', 'structure'], ['section', 'wording'], ['order', 'structure'], ['label', 'wording'],
    ['min', 'structure'], ['max', 'structure'], ['step', 'structure'], ['placeholder', 'structure'],
    ['defaultValue', 'structure'], ['defaultChecked', 'structure'], ['disabledAttr', 'structure'],
    ['options', 'structure'], ['defaultOption', 'structure'], ['optionsDynamic', 'structure'],
    ['persisted', 'structure'], ['persistedIn', 'structure'], ['persistKey', 'structure'],
    ['domRead', 'wording'], ['coercion', 'wording'],
    ['cliFlags', 'structure'], ['iniKeys', 'structure'], ['resetOnDelete', 'structure'], ['resetValue', 'structure'],
];

const normalizeField = (source, attr, raw) => {
    if (raw === undefined) return undefined;
    let out = raw === undefined ? null : raw;
    if (attr === 'defaultChecked' || attr === 'optionsDynamic') out = raw === true;
    if (attr === 'cliFlags' || attr === 'iniKeys') out = sortedList(raw);
    if (attr === 'min' || attr === 'max' || attr === 'step') out = raw === null || raw === '' ? null : String(raw);
    if (attr === 'options') out = Array.isArray(raw) && raw.length ? raw.slice() : null;
    if (attr === 'htmlType' && (out === '' || out === undefined)) out = null;
    if (attr === 'persistedIn' && source === 'b' && out === undefined) out = undefined;
    return out;
};

function fieldRows(a, c, b) {
    const A = Object.fromEntries(a.fields.map((f) => [f.id, f]));
    const Cc = Object.fromEntries(c.fields.map((f) => [f.id, f]));
    const B = b.fields || {};
    const ids = [...new Set([...Object.keys(A), ...Object.keys(Cc)])];
    const rows = [];
    for (const id of ids.sort()) {
        for (const [attr, kind] of FIELD_ATTRS) {
            const row = { artifact: 'field-manifest', subject: id, attribute: attr, kind, id: `field:${id}.${attr}` };
            if (Object.prototype.hasOwnProperty.call(A[id] || {}, attr)) row.a = normalizeField('a', attr, A[id][attr]);
            if (Object.prototype.hasOwnProperty.call(Cc[id] || {}, attr)) row.c = normalizeField('c', attr, Cc[id][attr]);
            const runtime = B[id];
            if (runtime) {
                if (attr === 'cliFlags') { const paired = value(runtime.cliFlags); row.b = paired ? paired.map((p) => p.key).sort() : undefined; row.bNote = paired ? paired.map((p) => p.pairedBy).join('; ') : undefined; row.bEvidence = paired ? paired.flatMap((p) => p.evidence) : undefined; }
                if (attr === 'iniKeys') { const paired = value(runtime.iniKeys); row.b = paired ? paired.map((p) => p.key).sort() : undefined; row.bNote = paired ? paired.map((p) => p.pairedBy).join('; ') : undefined; row.bEvidence = paired ? paired.flatMap((p) => p.evidence) : undefined; }
                if (attr === 'tag') { const control = value(runtime.control); row.b = control ? control.tag : undefined; row.bEvidence = control ? control.fixtures : undefined; }
                if (attr === 'htmlType') { const control = value(runtime.control); row.b = control && control.type ? control.type : undefined; row.bEvidence = control ? control.fixtures : undefined; }
                if (attr === 'persisted') { row.b = value(runtime.stored) !== undefined; row.bEvidence = value(runtime.stored) ? value(runtime.stored).fixtures.slice(0, 2) : undefined; }
                if (attr === 'resetOnDelete' || attr === 'resetValue') {
                    const evidence = value(runtime.resetEvidence);
                    if (evidence) {
                        row.bReset = { observed: evidence.observed, valueBeforeDelete: evidence.valueBeforeDelete, fixtures: evidence.fixtures, deletedConfig: evidence.deletedConfig };
                        row.bChanged = /did not change/.test(evidence.observed) === false;
                        row.bBefore = evidence.valueBeforeDelete === null || evidence.valueBeforeDelete === undefined ? null : String(evidence.valueBeforeDelete);
                    }
                }
            }
            rows.push(row);
        }
    }
    return rows;
}

// --- arg-truth-table rows -----------------------------------------------------------------
function argRows(a, c, b) {
    const A = Object.fromEntries(a.rows.map((r) => [r.flag, r]));
    const Cc = Object.fromEntries(c.rows.map((r) => [r.flag, r]));
    const rows = [];
    const attrs = [['order', 'structure'], ['arity', 'structure'], ['value', 'wording'], ['fields', 'structure'], ['guard', 'wording'], ['always', 'structure']];
    for (const flag of [...new Set([...Object.keys(A), ...Object.keys(Cc)])].sort()) {
        const observed = b.flags[flag];
        for (const [attr, kind] of attrs) {
            const row = { artifact: 'arg-truth-table', subject: flag, attribute: attr, kind, id: `flag:${flag}.${attr}` };
            if (A[flag] && A[flag][attr] !== undefined) row.a = Array.isArray(A[flag][attr]) ? sortedList(A[flag][attr]) : A[flag][attr];
            if (Cc[flag] && Cc[flag][attr] !== undefined) row.c = Array.isArray(Cc[flag][attr]) ? sortedList(Cc[flag][attr]) : Cc[flag][attr];
            if (observed) {
                if (attr === 'order') {
                    const positions = Object.entries(b.emissionOrder.launches).map(([launch, list]) => ({ launch, position: list.findIndex((entry) => entry.flag === flag) })).filter((p) => p.position >= 0);
                    row.b = positions.length ? `recorded at ${[...new Set(positions.map((p) => p.position))].join('/')} of ${positions.length} recorded bodies` : 'never emitted in a recorded body';
                    row.bEvidence = [...new Set(Object.values(b.emissionOrder.launches).flat().filter((entry) => entry.flag === flag).length ? ['ws/J5-ui-launch/launch-attempts.json'] : [])];
                }
                if (attr === 'always') row.b = observed.observedIn.length > 0 && observed.absentIn.length === 0 ? 'present in every recorded body' : observed.absentIn.length > 0 ? `absent in ${observed.absentIn.length} recorded body(ies)` : undefined;
                if (attr === 'value' && observed.valuesObserved && observed.valuesObserved.length) { row.b = `emitted values recorded: ${observed.valuesObserved.slice(0, 6).join(', ')}`; row.bEvidence = observed.evidence; }
                if (attr === 'fields' && value(observed.field)) { row.b = [value(observed.field)]; row.bNote = value(observed.pairedBy); row.bEvidence = observed.evidence; }
            }
            rows.push(row);
        }
    }
    rows.push({ artifact: 'arg-truth-table', subject: '@always-appended', attribute: 'flags', kind: 'structure', id: 'flag:@always-appended.flags', a: sortedList(a.alwaysAppended), c: sortedList(c.alwaysAppended), b: b.alwaysEmitted.flags.slice().sort() });
    rows.push({ artifact: 'arg-truth-table', subject: '@order', attribute: 'semantics', kind: 'wording', id: 'flag:@order.semantics', a: a.orderSemantics, c: c.orderSemantics });
    return rows;
}

// --- ini-map rows -------------------------------------------------------------------------
function iniRows(a, c, b) {
    // One ini key can be written by more than one statement (the Q17 reasoning/disableReasoning
    // pair), so the static rows are grouped by key and the site count becomes its own fact.
    const group = (rowsArr, keyField) => {
        const out = {};
        for (const r of rowsArr) {
            const key = r[keyField];
            if (!out[key]) out[key] = { ...r, emissionSites: 1, extraGuards: [] };
            else { out[key].emissionSites += 1; out[key].extraGuards.push(r.guard); }
        }
        return out;
    };
    const A = group(a.rows, 'key');
    const Cc = Object.fromEntries(c.rows.map((r) => [r.key, r]));
    const rows = [];
    const attrs = [['order', 'structure'], ['value', 'wording'], ['fields', 'structure'], ['guard', 'wording'], ['cliCounterpart', 'definitional'], ['nameDivergence', 'definitional'], ['always', 'structure'], ['emissionSites', 'definitional']];
    for (const key of [...new Set([...Object.keys(A), ...Object.keys(Cc)])].sort()) {
        const observed = b.keyClaims[key];
        for (const [attr, kind] of attrs) {
            const row = { artifact: 'ini-map', subject: key, attribute: attr, kind, id: `ini:${key}.${attr}` };
            if (A[key] && A[key][attr] !== undefined) row.a = Array.isArray(A[key][attr]) ? sortedList(A[key][attr]) : A[key][attr];
            if (Cc[key] && Cc[key][attr] !== undefined) row.c = Array.isArray(Cc[key][attr]) ? sortedList(Cc[key][attr]) : Cc[key][attr];
            if (observed) {
                if (attr === 'fields' && value(observed.field)) { row.b = [value(observed.field)]; row.bNote = value(observed.pairedBy); row.bEvidence = observed.observedIn; }
                if (attr === 'value') { row.b = `recorded values: ${(observed.valuesObserved || []).slice(0, 6).join(', ')}`; row.bEvidence = observed.observedIn; }
                if (attr === 'always') row.b = 'every recorded section carries it' === null ? undefined : `present in ${observed.observedIn.length} recorded section(s)`;
            }
            rows.push(row);
        }
    }
    const trailingB = b.keysAfterLastSection;
    const trailingKey = (text) => (/^\s*([\w-]+)\s*=/.exec(String(text)) || [])[1] || null;
    const divergencePairs = (list) => (list || []).map((d) => (typeof d === 'string' ? d : `${d.ini}<->${d.cli}`)).sort();
    rows.push({ artifact: 'ini-map', subject: '@trailing-line', attribute: 'keys', kind: 'structure', id: 'ini:@trailing-line.keys', a: (a.structure.trailingKey || []).map((t) => t.key).sort(), c: c.structure.trailing ? [trailingKey(c.structure.trailing)].filter(Boolean) : undefined, b: trailingB.keys });
    rows.push({ artifact: 'ini-map', subject: '@line-format', attribute: 'rule', kind: 'wording', id: 'ini:@line-format.rule', a: a.structure.lineFormat, c: c.structure.lineFormat, b: b.lineFormat.observed });
    rows.push({ artifact: 'ini-map', subject: '@section-order', attribute: 'rule', kind: 'wording', id: 'ini:@section-order.rule', a: a.structure.sectionOrder && a.structure.sectionOrder.note, c: c.structure.sectionOrder });
    rows.push({ artifact: 'ini-map', subject: '@version-header', attribute: 'header', kind: 'wording', id: 'ini:@version-header.header', a: a.structure.versionHeader, c: c.structure.header, b: b.versionHeader });
    rows.push({ artifact: 'ini-map', subject: '@name-divergences', attribute: 'pairs', kind: 'structure', id: 'ini:@name-divergences.pairs', a: divergencePairs(a.nameDivergences), c: divergencePairs(c.nameDivergences) });
    return rows;
}

// --- api / socket / process / storage rows -------------------------------------------------
const routeKey = (r) => `${r.method} ${r.path}`;

function apiRows(a, c, b) {
    const rows = [];
    const A = Object.fromEntries(a.routes.map((r) => [routeKey(r), r]));
    const Cc = Object.fromEntries((Array.isArray(c.routes) ? c.routes : []).map((r) => [routeKey(r), r]));
    const B = b.routes || {};
    const statesRequest = (route) => (route && route.requestBody && route.requestBody.fields ? route.requestBody.fields.slice().sort() : undefined);
    for (const key of [...new Set([...Object.keys(A), ...Object.keys(Cc), ...Object.keys(B)])].sort()) {
        rows.push({ artifact: 'api-contract', subject: key, attribute: 'registered', kind: 'structure', id: `route:${key}.registered`, a: A[key] ? A[key].registrationOrder : null, c: Cc[key] ? Cc[key].registrationOrder : null, b: B[key] ? `${B[key].requestsRecorded} recorded request(s)` : null });
        const statuses = (route) => (route && route.responses ? [...new Set(route.responses.map((r) => r.status).filter((s) => typeof s === 'number'))].sort((x, y) => x - y) : null);
        rows.push({ artifact: 'api-contract', subject: key, attribute: 'statuses', kind: 'structure', id: `route:${key}.statuses`, a: statuses(A[key]), c: statuses(Cc[key]), b: B[key] && B[key].statusesRecorded.length ? B[key].statusesRecorded.slice().sort((x, y) => x - y) : undefined });
        rows.push({ artifact: 'api-contract', subject: key, attribute: 'responseKinds', kind: 'structure', id: `route:${key}.responseKinds`, a: A[key] ? [...new Set(A[key].responses.map((r) => r.kind || (r.body || r.bodyText ? 'json' : 'unknown')))].sort() : null, c: Cc[key] ? [...new Set(Cc[key].responses.map((r) => r.kind || (/^public\//.test(String(r.body)) ? 'file' : 'json')))].sort() : null });
        const aFields = statesRequest(A[key]);
        const cFields = statesRequest(Cc[key]);
        const bFields = B[key] && B[key].requestBodyFields.length ? B[key].requestBodyFields.slice().sort() : undefined;
        if (aFields || cFields || bFields) rows.push({ artifact: 'api-contract', subject: key, attribute: 'requestBodyFields', kind: 'structure', id: `route:${key}.requestBodyFields`, a: aFields, c: cFields, b: bFields });
    }
    rows.push({ artifact: 'api-contract', subject: '@listen-port', attribute: 'port', kind: 'structure', id: 'api:@listen-port.port', a: a.server.portConstant ? a.server.portConstant.value : null, c: c.server.listenPort, b: Number((String((b.baseUrl || {}).origin || '').match(/:(\d+)/) || [])[1] || 0) || null, bEvidence: (b.baseUrl || {}).evidence });
    rows.push({ artifact: 'api-contract', subject: '@default-port-constant', attribute: 'value', kind: 'structure', id: 'api:@default-port-constant.value', a: a.server.defaultPortConstant ? a.server.defaultPortConstant.value : null, c: /8080/.test(JSON.stringify(c.server)) ? 8080 : null });
    rows.push({ artifact: 'api-contract', subject: '@server', attribute: 'stack', kind: 'wording', id: 'api:@server.stack', a: (a.server.middleware || []).join(' + '), c: c.server.framework });
    return rows;
}

function socketRows(a, c, b) {
    const rows = [];
    const A = Object.fromEntries(a.serverToClient.map((e) => [e.event, e]));
    const Cc = Object.fromEntries(c.serverToClient.map((e) => [e.event, e]));
    for (const event of [...new Set([...Object.keys(A), ...Object.keys(Cc), ...b.observedEventNames])].sort()) {
        rows.push({ artifact: 'socket-contract', subject: event, attribute: 'emitted', kind: 'structure', id: `socket:${event}.emitted`, a: A[event] ? true : null, c: Cc[event] ? true : null, b: b.observedEventNames.includes(event) ? `observed on ${b.connections.length} recorded connection(s)` : 'not observed on any recorded connection' });
        rows.push({ artifact: 'socket-contract', subject: event, attribute: 'payloadKeys', kind: 'structure', id: `socket:${event}.payloadKeys`, a: A[event] ? ((A[event].payloadKeys || []).slice().sort()) : undefined, c: Cc[event] ? Object.keys(Cc[event].payload || {}).sort() : undefined });
    }
    rows.push({ artifact: 'socket-contract', subject: '@absent', attribute: 'events', kind: 'structure', id: 'socket:@absent.events', a: (a.absentEvents || []).map((e) => e.event).filter((n) => /^[\w-]+$/.test(n)).sort(), c: (c.absentEvents || []).map((e) => e.event).filter((n) => /^[\w-]+$/.test(n)).sort(), cNotes: (c.absentEvents || []).map((e) => e.event).filter((n) => !/^[\w-]+$/.test(n)) });
    rows.push({ artifact: 'socket-contract', subject: '@log-stream', attribute: 'chunkShape', kind: 'structure', id: 'socket:@log-stream.chunkShape', b: { keys: b.logStreamPayload.keys, chunkByteSizes: b.logStreamPayload.chunkByteSizes }, bEvidence: b.logStreamPayload.evidence });
    rows.push({ artifact: 'socket-contract', subject: '@transport', attribute: 'connect', kind: 'wording', id: 'socket:@transport.connect', a: a.transport.clientConnect, c: (c.connectionLifecycle && c.connectionLifecycle.client) ? c.connectionLifecycle.client.join('; ') : null });
    rows.push({ artifact: 'socket-contract', subject: '@client-handlers', attribute: 'events', kind: 'structure', id: 'socket:@client-handlers.events', a: (a.clientListeners || []).map((l) => l.event).sort(), c: (c.clientHandlers || []).map((h) => h.event || h).sort() });
    return rows;
}

function processRows(a, c, b) {
    const signals = (kills) => [...new Set(kills.map((k) => `${k.signal}${k.insideTimer ? '(timer)' : ''}`))].sort();
    const rows = [
        { artifact: 'process-lifecycle', subject: '@spawn', attribute: 'sites', kind: 'structure', id: 'process:@spawn.sites', a: a.spawn.length, c: Array.isArray(c.spawn.sites) ? c.spawn.sites.length : undefined, b: `${b.spawns.count} recorded child launches`, bEvidence: ['argv/J3-start-stop/launch.jsonl', 'argv/J4-launch-presets/launch.jsonl'] },
        { artifact: 'process-lifecycle', subject: '@spawn', attribute: 'options', kind: 'wording', id: 'process:@spawn.options', a: a.spawn.map((s) => `${s.executable} ${s.args} ${s.options} shell=${s.shell}`).join(' ; '), c: `${c.spawn.function} shell=${c.spawn.shell}` },
        { artifact: 'process-lifecycle', subject: '@kill', attribute: 'signals', kind: 'structure', id: 'process:@kill.signals', a: signals(a.kill), c: signals([{ signal: 'SIGTERM', insideTimer: false }, { signal: 'SIGKILL', insideTimer: /SIGKILL/.test(c.kill.sequence) }]) },
        { artifact: 'process-lifecycle', subject: '@kill', attribute: 'delayMs', kind: 'structure', id: 'process:@kill.delayMs', a: a.kill.some((k) => k.insideTimer) ? 1000 : null, c: c.kill.delayMs },
        { artifact: 'process-lifecycle', subject: '@kill', attribute: 'orderDefect', kind: 'wording', id: 'process:@kill.orderDefect', c: c.kill.orderDefect && c.kill.orderDefect.fact },
        { artifact: 'process-lifecycle', subject: '@metrics', attribute: 'intervalMs', kind: 'structure', id: 'process:@metrics.intervalMs', a: a.metricsInterval.map((m) => m.delay).sort(), c: undefined },
        { artifact: 'process-lifecycle', subject: '@status', attribute: 'runningExpression', kind: 'wording', id: 'process:@status.runningExpression', a: a.statusExpression && a.statusExpression.expression, c: c.state && c.state.runningProcess },
        { artifact: 'process-lifecycle', subject: '@exit-code', attribute: 'handling', kind: 'wording', id: 'process:@exit-code.handling', a: (a.handlers[0] || {}).body, c: c.exitCodes && c.exitCodes.observedSource },
        { artifact: 'process-lifecycle', subject: '@launch-presets', attribute: 'iniPath', kind: 'wording', id: 'process:@launch-presets.iniPath', c: c.launchPresetsPath && c.launchPresetsPath.iniFile },
    ];
    const cadence = b.pollCadence && !b.pollCadence.__gap ? b.pollCadence : null;
    if (cadence) rows.push({ artifact: 'process-lifecycle', subject: '@metrics', attribute: 'recordedCadence', kind: 'structure', id: 'process:@metrics.recordedCadence', b: `${cadence.counts['/metrics'] || 0} /metrics requests in ${cadence.windowMs} ms`, bEvidence: ['ws/J5-ui-cadence/request-cadence.json'] });
    rows.push({ artifact: 'process-lifecycle', subject: '@restart', attribute: 'recordedEffect', kind: 'structure', id: 'process:@restart.recordedEffect', b: (b.restartEffect && b.restartEffect.settleNote) ? 'recorded: POST /restart returns success but /status settles on running:false' : undefined, bEvidence: ['http/J3d-restart/restart-settle.json'] });
    return rows;
}

function storageRows(a, c, b) {
    const writtenByA = (a.sites.written || []).map((w) => w.key).sort();
    const keysByC = (c.keys || []).map((k) => k.key).sort();
    return [
        { artifact: 'storage-schema', subject: '@keys', attribute: 'written', kind: 'structure', id: 'storage:@keys.written', a: writtenByA, c: keysByC, b: b.keysWritten.keys, bEvidence: b.keysWritten.evidence },
        { artifact: 'storage-schema', subject: '@persistedFields', attribute: 'count', kind: 'structure', id: 'storage:@persistedFields.count', a: a.persistedFieldCount, c: c.persistedFieldCount },
        { artifact: 'storage-schema', subject: '@persistedFields', attribute: 'set', kind: 'structure', id: 'storage:@persistedFields.set', a: (a.persistedFields || []).slice().sort(), c: (c.persistedFields || []).slice().sort() },
        { artifact: 'storage-schema', subject: '@recordedConfigKeys', attribute: 'set', kind: 'structure', id: 'storage:@recordedConfigKeys.set', b: Object.keys(b.configsShape || {}).sort(), bEvidence: ['localstorage/J5-ui-states/after-corpus-seed.json'], bNote: 'keys observed in recorded llamaCppConfigs entries; the corpus seeds carry keys the app never writes' },
        { artifact: 'storage-schema', subject: '@settings', attribute: 'keys', kind: 'structure', id: 'storage:@settings.keys', a: [...new Set((a.settingsObjectKeys || []).flatMap((s) => s.keys || []))].sort(), c: undefined, b: b.settingsShape.keys, bEvidence: b.settingsShape.values.slice(0, 2).map((v) => v.fixture) },
        { artifact: 'storage-schema', subject: '@orphanKeys', attribute: 'rule', kind: 'wording', id: 'storage:@orphanKeys.rule', a: typeof a.writeIsFreshLiteral === 'string' ? a.writeIsFreshLiteral : JSON.stringify(a.writeIsFreshLiteral), c: typeof c.orphanKeys === 'string' ? c.orphanKeys : c.orphanKeys && c.orphanKeys.fact },
        { artifact: 'storage-schema', subject: '@insertionOrder', attribute: 'significance', kind: 'wording', id: 'storage:@insertionOrder.significance', a: a.insertionOrder && a.insertionOrder.note, c: c.insertionOrder && c.insertionOrder.because },
    ];
}

// --- entry --------------------------------------------------------------------------------
function factRows() {
    const a = load('from-static');
    const c = load('from-model');
    const b = load('from-runtime');
    return {
        a, c, b,
        rows: [
            ...fieldRows(a['field-manifest'], c['field-manifest'], b['field-manifest']),
            ...argRows(a['arg-truth-table'], c['arg-truth-table'], b['arg-truth-table']),
            ...iniRows(a['ini-map'], c['ini-map'], b['ini-map']),
            ...apiRows(a['api-contract'], c['api-contract'], b['api-contract']),
            ...socketRows(a['socket-contract'], c['socket-contract'], b['socket-contract']),
            ...processRows(a['process-lifecycle'], c['process-lifecycle'], b['process-lifecycle']),
            ...storageRows(a['storage-schema'], c['storage-schema'], b['storage-schema']),
        ],
    };
}

module.exports = { load, factRows, fieldRows, argRows, iniRows, apiRows, socketRows, processRows, storageRows, isGap, value };
