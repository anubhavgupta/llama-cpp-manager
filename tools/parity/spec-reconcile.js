#!/usr/bin/env node
// Reconcile the three Phase 3 derivations into the SPEC pack (plan.md §2 Phase 3, §4 ladder).
//
//   (a) SPEC/from-static    (b) SPEC/from-runtime    (c) SPEC/from-model
//
// Every contract fact becomes one row (tools/parity/spec-facts.js). This file decides what the pack
// states for each row, applying the §4 ladder — recorded runtime evidence beats a static read, which
// beats the independent model pass — and writes SPEC/CONSISTENCY.md plus the pack itself
// (tools/parity/spec-pack.js).
//
// Exit status: 0 = every fact resolved (agreement, runtime resolution, ladder resolution, definitional
// split, or a logged single-source claim) and the gates pass. 1 = something is unreconciled or a gate
// failed; the reason is printed and appended to ESCALATION.md is NOT done automatically.
//
// Run: node tools/parity/spec-reconcile.js [--no-pack]

'use strict';

const fs = require('fs');
const path = require('path');
const C = require('./spec-common');
const F = require('./spec-facts');
const pack = require('./spec-pack');

const { readJson, writeJson } = C;

// Attributes where (b) states a value that can be compared with (a)/(c). Everywhere else (b) only
// describes what the recordings show ("recorded at 3 of 4 bodies"), which corroborates but cannot
// be diffed against a source expression.
const COMPARABLE = new Set(['tag', 'htmlType', 'persisted', 'cliFlags', 'iniKeys', 'fields', 'registered', 'statuses', 'requestBodyFields', 'written', 'keys', 'port', 'set', 'count', 'payloadKeys', 'responseKinds', 'emitted', 'signals', 'delayMs', 'intervalMs', 'writtenByControl']);

// List-valued facts are confirmed or extended by the recordings, never overridden: a recording that
// shows some of the members (the statuses it happened to capture, the settings keys it dumped) is a
// sample, not a completeness claim.
const SUBSET_ATTRS = new Set(['cliFlags', 'iniKeys', 'fields', 'statuses', 'keys', 'written', 'set', 'payloadKeys', 'responseKinds', 'signals', 'emitted']);

// Facts where (a) and (c) answer different questions rather than the same one differently. The pack
// keeps both statements, each labelled with the question it answers; CONSISTENCY.md logs the split.
// (b) cannot answer these: the recordings see a stored key, not the writer of that key.
const NOT_RUNTIME_DECIDABLE = new Set(['persisted']);

const DEFINITIONAL = (row) => {
    if (row.artifact === 'field-manifest' && (row.attribute === 'cliFlags' || row.attribute === 'iniKeys')) return 'static lists the emit whose VALUE is this field; model lists every emit the field gates';
    if (row.artifact === 'field-manifest' && row.attribute === 'persisted') return 'static and model ask "does saveCurrentValues write this key"; the recordings ask "does a stored llamaCppConfigs entry carry this key", and the corpus seeds carry keys the app never writes';
    if (row.artifact === 'ini-map' && row.attribute === 'order') return 'static numbers emit statements (the reasoning key is written by two branches); model numbers distinct ini keys';
    if (row.artifact === 'ini-map' && row.attribute === 'guard') return 'static quotes the source guard expression verbatim; the model paraphrases the same condition';
    if (row.artifact === 'ini-map' && row.attribute === 'cliCounterpart') return 'static names the argv push paired with this ini emit by guard chain; model names any flag with the same meaning';
    if (row.artifact === 'ini-map' && row.attribute === 'nameDivergence') return 'static calls it a divergence only when the ini key differs from the flag after stripping dashes; model also counts dash-only differences';
    if (row.artifact === 'ini-map' && row.attribute === 'emissionSites') return 'static counts distinct emit statements; model describes the branches as prose';
    if (row.id === 'ini:@name-divergences.pairs') return 'static lists dash-stripped name differences only; model also lists mmproj<->--mmproj and fa<->-fa';
    return null;
};

const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

// (b) may only contradict a value it actually states as data, never its own prose.
const runtimeValue = (row) => {
    if (row.b === undefined) return undefined;
    if (!COMPARABLE.has(row.attribute)) return undefined;
    if (typeof row.b === 'string' && /recorded|observed|request/.test(row.b) && !/^\[/.test(JSON.stringify(row.b))) return undefined;
    return row.b;
};

function resolveRow(row, siblings) {
    const a = row.a, c = row.c;
    const b = runtimeValue(row);
    const prose = row.b;
    const definitional = DEFINITIONAL(row);

    // Delete-reset facts get their own rule: the recording shows whether a control moved while its
    // stored value differed from the reset value the other derivations claim.
    if ((row.attribute === 'resetOnDelete' || row.attribute === 'resetValue') && row.bReset) {
        const resetRow = siblings.resetOnDelete || {};
        const valueRow = siblings.resetValue || {};
        const claimant = resetRow.a === true ? 'a' : resetRow.c === true ? 'c' : null;
        const claimedValue = claimant === 'a' ? valueRow.a : claimant === 'c' ? valueRow.c : null;
        if (claimant && row.bBefore !== null && String(claimedValue) !== row.bBefore && row.bChanged === false) {
            return {
                status: 'runtime-wins',
                value: row.attribute === 'resetOnDelete' ? false : null,
                from: ['b'],
                over: [claimant],
                reason: `the delete recording left this control untouched while it held "${row.bBefore}", which is not the claimed reset value ${JSON.stringify(claimedValue)}`,
                evidence: row.bReset.fixtures,
            };
        }
        if (claimant && String(claimedValue) === row.bBefore) {
            const winner = row.a !== undefined ? row.a : row.c;
            return {
                status: 'agree',
                value: winner,
                from: [row.a !== undefined ? 'a' : null, row.c !== undefined ? 'c' : null].filter(Boolean),
                note: `the recording cannot discriminate: the control already held the claimed reset value ${JSON.stringify(claimedValue)} before the delete`,
                evidence: row.bReset.fixtures,
            };
        }
    }

    if (NOT_RUNTIME_DECIDABLE.has(row.attribute) && row.a !== undefined && row.c !== undefined && row.b !== undefined && !same(row.b, row.a) && !same(row.b, row.c)) {
        return { evidence: [].concat(row.bEvidence || []), status: 'definitional-split', value: { static: row.a, model: row.c }, from: ['a', 'c'], rule: DEFINITIONAL(row), runtime: b, runtimeOnly: true };
    }

    const stated = ['a', 'c'].filter((k) => row[k] !== undefined);
    if (stated.length === 0) {
        if (b !== undefined) return { status: 'runtime-only', value: b, from: ['b'], evidence: row.bEvidence };
        if (prose !== undefined) return { status: 'runtime-note', value: null, from: [], note: prose, evidence: row.bEvidence };
        return { status: 'unstated', value: null, from: [] };
    }
    const values = stated.map((k) => row[k]);
    const agree = values.every((v) => same(v, values[0]));
    const base = { evidence: [].concat(row.bEvidence || []) };

    if (agree) {
        const value = values[0];
        const subset = SUBSET_ATTRS.has(row.attribute) && Array.isArray(value) && Array.isArray(b);
        if (subset) {
            const known = new Set(value);
            const extras = b.filter((item) => !known.has(item));
            const missing = value.filter((item) => !b.includes(item));
            if (extras.length) {
                return { ...base, status: 'agree+runtime-extended', value, from: stated.concat(['b']), runtimeValue: extras, note: `recordings also show ${extras.join(', ')}; the source readings stay authoritative for the rest` };
            }
            return { ...base, status: 'agree+runtime-confirmed', value, from: stated.concat(['b']), note: missing.length ? `not observable in the recordings: ${missing.join(', ')}` : undefined, evidence: row.bEvidence };
        }
        if (b !== undefined && !same(b, value)) {
            return { ...base, status: 'runtime-wins', value: b, from: ['b'], over: stated, reason: `recordings state ${JSON.stringify(b)} while ${stated.join('/')} state ${JSON.stringify(value)}`, evidence: row.bEvidence };
        }
        return { ...base, status: b !== undefined ? 'agree+runtime-confirmed' : 'agree', value, from: stated.concat(b !== undefined ? ['b'] : []), note: prose !== undefined && b === undefined ? prose : undefined, evidence: row.bEvidence };
    }

    if (definitional) {
        return { ...base, status: 'definitional-split', value: { static: a, model: c }, from: stated, rule: definitional, runtime: b, evidence: row.bEvidence };
    }

    // Both source readings cannot be right and the recordings fit exactly one of them: that reading wins.
    if (b !== undefined) {
        const fits = (candidate) => (Array.isArray(b) && Array.isArray(candidate)
            ? b.length > 0 && b.every((item) => candidate.includes(item))
            : same(b, candidate));
        const matching = ['a', 'c'].filter((key) => fits(row[key]));
        if (matching.length === 1) {
            const [winner] = matching;
            return { ...base, status: 'runtime-wins', value: row[winner], from: [winner, 'b'], over: ['a', 'c'].filter((k) => k !== winner), reason: `the recordings fit only the (${winner}) reading`, evidence: row.bEvidence };
        }
    }

    if (row.kind === 'wording' && stated.length === 2) {
        const filled = ['a', 'c'].filter((key) => typeof row[key] === 'string' && row[key].length);
        const empty = ['a', 'c'].filter((key) => row[key] === null || row[key] === undefined);
        if (filled.length === 1 && empty.length === 1) {
            const [winner] = filled;
            return { ...base, status: `complement-from-${winner}`, value: row[winner], from: [winner], note: `only derivation (${winner}) records an expression here; the other records none`, runtime: b };
        }
    }

    if (row.kind === 'wording' && stated.length === 2 && typeof a === 'string' && typeof c === 'string') {
        return { ...base, status: 'static-wording', value: a, from: ['a'], modelWording: c, reason: 'the static read quotes the source expression; the model pass paraphrases the same behaviour. The pack keeps the source text and the model phrasing as a note.' };
    }

    if (stated.length === 1) {
        const only = stated[0];
        return { ...base, status: `${only}-only`, value: row[only], from: [only], reason: `only derivation (${only}) states this fact`, runtime: b };
    }

    // Both source derivations state it and disagree, structurally: plan §4 step 2 (static read) beats
    // step 3 (model pass). Logged as an auto-resolution with the model value preserved.
    return { ...base, status: 'static-over-model', value: a, from: ['a'], over: ['c'], modelValue: c, reason: 'plan.md §4: a static read of parity-baseline outranks the independent model pass', runtime: b };
}

function resolveAll(rows) {
    const bySubject = {};
    for (const row of rows) {
        const key = `${row.artifact}|${row.subject}`;
        (bySubject[key] = bySubject[key] || {})[row.attribute] = row;
    }
    const out = new Map();
    for (const row of rows) {
        const siblings = bySubject[`${row.artifact}|${row.subject}`];
        const resolution = resolveRow(row, siblings);
        resolution.row = row;
        out.set(row.id, resolution);
    }
    return out;
}

// --- gates -----------------------------------------------------------------------------------
const IDENTITY_ATTRS = ['tag', 'persisted', 'persistKey', 'cliFlags', 'iniKeys', 'resetOnDelete'];

function fieldGate(resolutions) {
    const fields = {};
    for (const [id, resolution] of resolutions) {
        if (!id.startsWith('field:')) continue;
        const subject = id.slice('field:'.length).split('.')[0];
        const field = (fields[subject] = fields[subject] || { rows: 0, agreeing: 0, autoResolved: 0, pointers: {}, blockers: [] });
        field.rows += 1;
        if (resolution.from.length >= 2) field.agreeing += 1;
        if (['runtime-wins', 'static-over-model', 'static-wording', 'definitional-split', 'a-only', 'c-only', 'runtime-only'].includes(resolution.status)) field.autoResolved += 1;
        for (const source of resolution.from) field.pointers[source] = true;
        if (resolution.status === 'unreconciled') field.blockers.push(id);
    }
    for (const field of Object.values(fields)) {
        field.derivations = Object.keys(field.pointers).sort();
        field.pass = (field.agreeing > 0 && field.derivations.length >= 2) || field.autoResolved > 0;
    }
    return fields;
}

const CONTRACT_STRING = /(?:^|\s)(--?[a-z][\w-]*)/g;
const LINE_MARKER = /(model-only|not-recorded):/;

// BUILD-FROM.md may state a contract string only when the static read AND the recordings both see it,
// or when the same line carries `not-recorded: <reason>` / `model-only: <reason>`. That keeps the
// cold-start doc honest about the strings no recording ever exercised.
function tokenSupport(resolutions) {
    const support = {};
    for (const [id, resolution] of resolutions) {
        const isContract = id.startsWith('flag:') || id.startsWith('ini:') || id.startsWith('socket:');
        if (!isContract) continue;
        const token = id.split(':')[1].split('.')[0];
        if (token.startsWith('@')) continue;
        const entry = (support[token] = support[token] || { a: false, b: false, c: false });
        const row = resolution.row;
        if (row.a !== undefined) entry.a = true;
        if (row.b !== undefined) entry.b = true;
        if (row.c !== undefined) entry.c = true;
    }
    return support;
}

function buildFromGate(text, resolutions) {
    const support = tokenSupport(resolutions);
    const problems = [];
    const marked = [];
    text.split(/\r?\n/).forEach((line, index) => {
        for (const raw of line.match(CONTRACT_STRING) || []) {
            const token = raw.trim();
            const entry = support[token];
            if (!entry) continue;
            if (entry.a && entry.b) continue;
            if (LINE_MARKER.test(line)) { marked.push({ token, line: index + 1, missing: Object.entries(entry).filter(([, seen]) => !seen).map(([k]) => k).join('/') }); continue; }
            problems.push({ flag: token, line: index + 1, missing: Object.entries(entry).filter(([, seen]) => !seen).map(([k]) => k).join('/'), text: line.trim().slice(0, 120) });
        }
    });
    return { problems, modelOnly: marked, known: Object.keys(support).length };
}

function openApiGate(file) {
    const problems = [];
    let doc = null;
    try {
        doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        return { problems: [`does not parse: ${error.message}`], doc: null };
    }
    if (typeof doc.openapi !== 'string' || !/^3\./.test(doc.openapi)) problems.push('openapi must be a 3.x string');
    if (!doc.info || typeof doc.info.title !== 'string') problems.push('info.title is missing');
    if (!doc.servers || !Array.isArray(doc.servers) || !doc.servers.length) problems.push('servers must list the base URL');
    if (!doc.paths || typeof doc.paths !== 'object' || !Object.keys(doc.paths).length) problems.push('paths is empty');
    for (const [route, item] of Object.entries(doc.paths || {})) {
        for (const [method, op] of Object.entries(item)) {
            if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) { problems.push(`${method.toUpperCase()} ${route}: unsupported method`); continue; }
            if (!op.responses || !Object.keys(op.responses).length) problems.push(`${method.toUpperCase()} ${route}: no responses`);
            if (typeof op.operationId !== 'string') problems.push(`${method.toUpperCase()} ${route}: no operationId`);
            for (const [status, response] of Object.entries(op.responses || {})) {
                if (!/^(default|\d\d\d)$/.test(status)) problems.push(`${method.toUpperCase()} ${route}: response code "${status}" is not a number or default`);
                if (!response.description) problems.push(`${method.toUpperCase()} ${route} ${status}: response has no description`);
            }
        }
    }
    return { problems, doc };
}

// --- consistency report ----------------------------------------------------------------------
const show = (value) => (value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value));

function consistencyReport(rows, resolutions, fields, gates) {
    const counts = {};
    for (const resolution of resolutions.values()) counts[resolution.status] = (counts[resolution.status] || 0) + 1;
    const perArtifact = {};
    for (const row of rows) {
        const resolution = resolutions.get(row.id);
        const bucket = (perArtifact[row.artifact] = perArtifact[row.artifact] || { facts: 0, agree: 0, runtime: 0, ladder: 0, definitional: 0, single: 0, unreconciled: 0 });
        bucket.facts += 1;
        if (/^agree/.test(resolution.status)) bucket.agree += 1;
        else if (resolution.status === 'runtime-wins' || resolution.status === 'runtime-only' || resolution.status === 'runtime-note') bucket.runtime += 1;
        else if (resolution.status === 'static-over-model' || resolution.status === 'static-wording') bucket.ladder += 1;
        else if (resolution.status === 'definitional-split') bucket.definitional += 1;
        else if (resolution.status === 'unstated') bucket.single += 1;
        else if (resolution.status === 'unreconciled') bucket.unreconciled += 1;
        else bucket.single += 1;
    }
    const lines = [];
    lines.push('# CONSISTENCY — three-way derivation matrix (plan.md §2 Phase 3, §4 ladder)');
    lines.push('');
    lines.push('Generated by `node tools/parity/spec-reconcile.js`. Inputs: `SPEC/from-static` (a, AST of');
    lines.push('`git show parity-baseline:…`), `SPEC/from-runtime` (b, `fixtures/**` recordings only),');
    lines.push('`SPEC/from-model` (c, fresh-context model pass over the same source text).');
    lines.push('');
    lines.push(`Facts compared: **${rows.length}**. Resolutions: ${Object.entries(counts).sort().map(([k, v]) => `\`${k}\` ${v}`).join(', ')}.`);
    lines.push('');
    lines.push(`**Unreconciled: ${counts.unreconciled || 0}.**`);
    lines.push('');
    lines.push('| artifact | facts | agree | runtime | ladder | definitional | single-source | unreconciled |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const [artifact, bucket] of Object.entries(perArtifact)) {
        lines.push(`| ${artifact} | ${bucket.facts} | ${bucket.agree} | ${bucket.runtime} | ${bucket.ladder} | ${bucket.definitional} | ${bucket.single} | ${bucket.unreconciled} |`);
    }
    lines.push('');
    lines.push('## Resolution ladder used');
    lines.push('');
    lines.push('1. `runtime-wins` — (b) states a comparable value that differs from (a)/(c). Recorded legacy');
    lines.push('   output is correct by definition (AGENTS.md C4, plan §4 step 1).');
    lines.push('2. `agree` / `agree+runtime-confirmed` — every derivation that states the fact states it alike.');
    lines.push('3. `static-over-model` — (a) and (c) disagree structurally, (b) is silent. plan §4 step 2 beats step 3.');
    lines.push('4. `static-wording` — same behaviour, different prose: the pack keeps the source snippet (a) and');
    lines.push('   carries the model phrasing (c) as a note.');
    lines.push('5. `definitional-split` — (a) and (c) answered different questions; the pack keeps both, labelled.');
    lines.push('6. `a-only` / `c-only` / `runtime-only` / `runtime-note` — one derivation states it; the pack labels');
    lines.push('   the single source instead of implying a second witness.');
    lines.push('');

    const runtimeRows = [...resolutions.values()].filter((r) => r.status === 'runtime-wins');
    lines.push('## Auto-resolutions — recorded evidence beats a source read');
    lines.push('');
    if (!runtimeRows.length) lines.push('_none_');
    for (const r of runtimeRows) {
        lines.push(`- \`${r.row.id}\` → **${show(r.value)}** (overrides ${(r.over || []).join('/')}) — ${r.reason}`);
        if (r.evidence && r.evidence.length) lines.push(`  - evidence: ${r.evidence.slice(0, 4).join(', ')}`);
    }
    lines.push('');

    const ladderRows = [...resolutions.values()].filter((r) => r.status === 'static-over-model');
    lines.push('## Ladder resolutions — static read beats model pass');
    lines.push('');
    if (!ladderRows.length) lines.push('_none_');
    for (const r of ladderRows) lines.push(`- \`${r.row.id}\` → **${show(r.value)}**; model stated ${show(r.modelValue)}`);
    lines.push('');

    const definitionalRows = [...resolutions.values()].filter((r) => r.status === 'definitional-split');
    lines.push('## Definitional splits — both statements kept');
    lines.push('');
    for (const r of definitionalRows) {
        lines.push(`- \`${r.row.id}\` — static ${show(r.value.static)} / model ${show(r.value.model)}`);
        lines.push(`  - rule: ${r.rule}`);
        if (r.runtime !== undefined && r.runtime !== null) lines.push(`  - runtime: ${show(r.runtime)}`);
    }
    lines.push('');

    const wordingRows = [...resolutions.values()].filter((r) => r.status === 'static-wording');
    lines.push(`## Prose-only differences (${wordingRows.length}) — source text kept, model phrasing noted`);
    lines.push('');
    lines.push('| fact | static (kept) | model (note) |');
    lines.push('|---|---|---|');
    for (const r of wordingRows) lines.push(`| \`${r.row.id}\` | ${show(r.value).replace(/\|/g, '\\|').slice(0, 110)} | ${show(r.modelWording).replace(/\|/g, '\\|').slice(0, 110)} |`);
    lines.push('');

    const singleRows = [...resolutions.values()].filter((r) => /-only$/.test(r.status) || r.status === 'runtime-note' || r.status === 'unstated');
    lines.push(`## Single-source facts (${singleRows.length}) — labelled, not treated as cross-checked`);
    lines.push('');
    lines.push('| fact | status | value |');
    lines.push('|---|---|---|');
    for (const r of singleRows) lines.push(`| \`${r.row.id}\` | ${r.status} | ${show(r.row[r.status[0]] !== undefined ? r.row[r.status[0]] : r.value).replace(/\|/g, '\\|').slice(0, 100)} |`);
    lines.push('');

    lines.push('## Field evidence gate — 2+ derivations per field, or a logged auto-resolution');
    lines.push('');
    lines.push('| field | rows | rows agreed | rows auto-resolved | derivations stating it | pass |');
    lines.push('|---|---:|---:|---:|---|---|');
    for (const [id, field] of Object.entries(Object.fromEntries(Object.entries(fields).sort()))) {
        lines.push(`| ${id} | ${field.rows} | ${field.agreeing} | ${field.autoResolved} | ${field.derivations.join('+')} | ${field.pass ? 'yes' : '**NO**'} |`);
    }
    lines.push('');
    lines.push('## Gates');
    lines.push('');
    lines.push(`- unreconciled facts: **${counts.unreconciled || 0}** (must be 0)`);
    lines.push(`- fields passing the evidence gate: **${Object.values(fields).filter((f) => f.pass).length}/${Object.keys(fields).length}**`);
    lines.push(`- BUILD-FROM.md contract strings: **${gates.buildFrom.problems.length}** unmarked single-derivation strings, ${gates.buildFrom.modelOnly.length} marked model-only`);
    lines.push(`- SPEC/api-contract.openapi.json structure check: **${gates.openApi.problems.length ? 'FAILED' : 'passed'}**${gates.openApi.problems.length ? ` — ${gates.openApi.problems.join('; ')}` : ''}`);
    lines.push('');
    lines.push('## Where the recordings are blind (Phase 4 test debt)');
    lines.push('');
    const gaps = [];
    const walk = (value, trail) => {
        if (value === null || typeof value !== 'object') return;
        if (Array.isArray(value)) return value.forEach((item) => walk(item, trail));
        if (value.__gap === true) { gaps.push(`${trail}: ${value.reason}`); return; }
        for (const [key, item] of Object.entries(value)) walk(item, `${trail}.${key}`);
    };
    for (const [name, artifact] of Object.entries(F.load('from-runtime'))) walk(artifact, name);
    for (const line of gaps) lines.push(`- ${line}`);
    lines.push('');
    return { text: lines.join('\n'), gapCount: gaps.length };
}

// --- main ------------------------------------------------------------------------------------
function main() {
    const argv = process.argv.slice(2);
    const skipPack = argv.includes('--no-pack');
    const { rows } = F.factRows();
    const resolutions = resolveAll(rows);
    const fields = fieldGate(resolutions);
    const buildFromPath = path.join(C.SPEC, 'BUILD-FROM.md');
    const buildFromText = fs.existsSync(buildFromPath) ? fs.readFileSync(buildFromPath, 'utf8') : '';
    const openApiPath = path.join(C.SPEC, 'api-contract.openapi.json');

    if (!skipPack) pack.write({ rows, resolutions, fields, loaded: F.load('from-static'), loadedRuntime: F.load('from-runtime'), loadedModel: F.load('from-model') });

    const gates = {
        buildFrom: buildFromText ? buildFromGate(buildFromText, resolutions) : { problems: [{ flag: '(file missing)', line: 0, text: 'SPEC/BUILD-FROM.md does not exist yet' }], modelOnly: [] },
        openApi: openApiGate(openApiPath),
    };
    const report = consistencyReport(rows, resolutions, fields, gates);
    writeJson(path.join(C.SPEC, 'RECONCILE-STATS.json'), {
        generatedBy: 'tools/parity/spec-reconcile.js',
        facts: rows.length,
        resolutions: [...resolutions.values()].reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {}),
        unreconciled: [...resolutions.values()].filter((r) => r.status === 'unreconciled').map((r) => r.row.id),
        fieldGate: { passing: Object.values(fields).filter((f) => f.pass).length, total: Object.keys(fields).length },
        gates,
        recordingGaps: report.gapCount,
    });
    fs.writeFileSync(path.join(C.SPEC, 'CONSISTENCY.md'), report.text);

    const failures = [];
    const unreconciled = [...resolutions.values()].filter((r) => r.status === 'unreconciled');
    if (unreconciled.length) failures.push(`${unreconciled.length} unreconciled facts: ${unreconciled.slice(0, 8).map((r) => r.row.id).join(', ')}`);
    const failingFields = Object.entries(fields).filter(([, f]) => !f.pass).map(([id]) => id);
    if (failingFields.length) failures.push(`fields failing the evidence gate: ${failingFields.join(', ')}`);
    if (gates.buildFrom.problems.length) failures.push(`BUILD-FROM.md contract strings without two-derivation support or a model-only marker: ${gates.buildFrom.problems.map((p) => `${p.flag}@line ${p.line}`).join(', ')}`);
    if (gates.openApi.problems.length) failures.push(`openapi structure check: ${gates.openApi.problems.join('; ')}`);

    console.log(`reconcile: ${rows.length} facts, ${Object.keys(fields).length} fields, ${report.gapCount} recording gaps`);
    console.log(`resolutions: ${JSON.stringify([...resolutions.values()].reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {}))}`);
    console.log(`gates: unreconciled=${unreconciled.length} fieldGate=${Object.values(fields).filter((f) => f.pass).length}/${Object.keys(fields).length} buildFrom=${gates.buildFrom.problems.length} openApi=${gates.openApi.problems.length}`);
    if (failures.length) {
        console.log('FAIL');
        for (const failure of failures) console.log('  - ' + failure);
        process.exitCode = 1;
        return;
    }
    console.log('PASS — CONSISTENCY.md shows 0 unreconciled and every gate is green');
}

if (require.main === module) main();

module.exports = { resolveAll, resolveRow, fieldGate, buildFromGate, openApiGate, consistencyReport, main };
