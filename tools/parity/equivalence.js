#!/usr/bin/env node
'use strict';
// Phase 2.5 (plan.md §2): the equivalence gate. The candidate implementation — legacy/lib, the code
// Part 2 ports — is run over every vector and compared to the goldens, which came out of the
// parity-baseline inline blocks. Any diff is a candidate bug (C4): the fix is the lib, never a
// golden, never a vector.
//
//   node tools/parity/equivalence.js              every family; exit 1 on the first diff beyond --first N
//   node tools/parity/equivalence.js --shrink     + greedy-minimize each failure and write a repro
//   node tools/parity/equivalence.js --verify     coverage reality check over the goldens + map
//   node tools/parity/equivalence.js --selftest   mutate the lib in memory and prove this gate notices
//
// argv is compared positionally (order is part of the contract); ini is compared as bytes.

const fs = require('fs');
const path = require('path');

const slices = require('./baseline-slices.js');
const vectors = require('./gen-vectors.js');

const REPO = slices.REPO;
const LIB_ARGS = path.join(REPO, 'legacy', 'lib', 'buildArgs.js');
const LIB_INI = path.join(REPO, 'legacy', 'lib', 'buildPresetIni.js');
const SHRINK_REGEN = 'node tools/parity/equivalence.js --shrink';

// ------------------------------------------------------------------ inputs ----------------

// The vector every coverage claim is measured against, named by coverage-map.json rather than
// hardcoded here, so the map stays the single place that decides what "default" means.
function referenceVector(bag) {
    const map = vectors.readJson(path.join(vectors.VECTORS, 'coverage-map.json'));
    const vector = bag.vectors.find((candidate) => candidate.id === map.reference);
    vectors.assert(vector, map.reference + ': coverage-map.json names a reference that is not in the set');
    return vector;
}

function loadInputs() {
    const inputs = vectors.readJson(path.join(vectors.VECTORS, 'INPUTS.json'));
    return {
        inputs: inputs,
        modelsById: new Map(inputs.model_sets.map((set) => [set.id, set.models])),
        settingsById: new Map(inputs.settings_sets.map((set) => [set.id, set])),
        reference: vectors.readJson(path.join(vectors.VECTORS, 'INPUTS.json')).reference_fields
    };
}

// Promoted repros (boundary/shrunk-*.jsonl, written by --selftest-style failure promotion) are part of
// the asserted set too: a repro that no gate compares would be a silent gap.
function promotionFiles() {
    const dir = path.join(vectors.VECTORS, 'boundary');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((name) => /^shrunk-.*\.jsonl$/.test(name)).sort();
}

function loadSet() {
    const bag = { vectors: [], goldens: new Map() };
    for (const family of vectors.FAMILIES) {
        const vectorLines = vectors.readJsonl(path.join(vectors.VECTORS, family, 'vectors.jsonl'));
        const goldenLines = vectors.readJsonl(path.join(vectors.GOLDENS, family, 'goldens.jsonl'));
        const goldenHeader = goldenLines[0];
        const vectorHeader = vectorLines[0];
        vectors.assert(goldenHeader.kind === 'header', family + ': goldens have no header line');
        vectors.assert(goldenHeader.vectors_file === 'fixtures/vectors/' + family + '/vectors.jsonl',
            family + ': goldens name a different vectors file');
        vectors.assert(goldenHeader.count === vectorLines.length - 1,
            family + ': golden count ' + goldenHeader.count + ' != ' + (vectorLines.length - 1) + ' vectors');
        const goldens = goldenLines.slice(1).map((line) => [line.vector_id, line]);
        for (const [id] of goldens) vectors.assert(id, family + ': a golden has no vector_id');
        vectors.assert(goldens.length === vectorLines.length - 1,
            family + ': duplicate vector_id in the goldens?');
        for (const line of vectorLines.slice(1)) {
            bag.vectors.push(line);
            bag.goldens.set(line.id, new Map(goldens).get(line.id));
        }
        vectors.assert(bag.vectors.filter((v) => v.family === family).length === vectorHeader.count,
            family + ': vector header count disagrees');
    }
    for (const name of promotionFiles()) {
        const source = name.replace(/^shrunk-/, '').replace(/\.jsonl$/, '');
        const lines = vectors.readJsonl(path.join(vectors.VECTORS, 'boundary', name));
        const goldenLines = vectors.readJsonl(path.join(vectors.GOLDENS, 'boundary',
            name.replace(/\.jsonl$/, '.goldens.jsonl')));
        vectors.assert(lines[0].kind === 'header' && goldenLines[0].kind === 'header',
            name + ': a promoted file has no header');
        vectors.assert(goldenLines.length - 1 === lines.length - 1,
            name + ': promoted golden count disagrees with the repro count');
        const goldens = new Map(goldenLines.slice(1).map((line) => [line.vector_id, line]));
        for (const line of lines.slice(1)) {
            vectors.assert(goldens.has(line.id), name + ': no golden for ' + line.id);
            bag.vectors.push(line);
            bag.goldens.set(line.id, goldens.get(line.id));
        }
        void source;
    }
    return bag;
}

// ---------------------------------------------------------------- comparison ---------------

// The candidate side. buildArgs takes the DOM-shaped fields map (the launch path fills the form
// first, Q7); buildPresetIni takes the saved config keyed by name.
function candidate(lib, vector, models, settings) {
    let argv = null;
    let argvThrew = null;
    try {
        argv = lib.buildArgs(vectors.argvFields(vector, null), settings, models);
    } catch (error) {
        argvThrew = String(error && error.message);
    }
    let ini = null;
    let iniThrew = null;
    try {
        ini = lib.buildPresetIni(vectors.iniConfigs(vector), models);
    } catch (error) {
        iniThrew = String(error && error.message);
    }
    return { argv: argv, argv_threw: argvThrew,
        ini: ini === null ? null : Buffer.from(ini, 'utf8').toString('base64'),
        ini_threw: iniThrew };
}

const window = (text, index) => JSON.stringify(text.slice(Math.max(0, index - 40), index + 40));

// One diff record per failing vector, describing the first difference in each of the two outputs.
function compare(golden, mine) {
    const problems = [];
    if (!!golden.argv_threw !== !!mine.argv_threw) {
        problems.push('argv throw ' + (mine.argv_threw ? 'CANDIDATE THREW (' + mine.argv_threw
            + '), baseline emitted ' + JSON.stringify(golden.argv) : 'baseline THREW ('
            + golden.argv_threw + '), candidate emitted ' + JSON.stringify(mine.argv)));
    } else if (golden.argv_threw) {
        if (golden.argv_threw !== mine.argv_threw) {
            problems.push('argv throw message differs: baseline ' + JSON.stringify(golden.argv_threw)
                + ' vs candidate ' + JSON.stringify(mine.argv_threw));
        }
    } else if (golden.argv.length !== mine.argv.length) {
        let i = 0;
        while (i < Math.min(golden.argv.length, mine.argv.length) && golden.argv[i] === mine.argv[i]) i += 1;
        problems.push('argv length ' + golden.argv.length + ' -> ' + mine.argv.length
            + ', first divergence at index ' + i + ': baseline ' + JSON.stringify(golden.argv[i])
            + ' vs candidate ' + JSON.stringify(mine.argv[i]));
    } else {
        for (let i = 0; i < golden.argv.length; i += 1) {
            if (golden.argv[i] !== mine.argv[i]) {
                problems.push('argv index ' + i + ': baseline ' + JSON.stringify(golden.argv[i])
                    + ' (' + typeof golden.argv[i] + ') vs candidate ' + JSON.stringify(mine.argv[i])
                    + ' (' + typeof mine.argv[i] + ')');
                break;
            }
        }
    }
    const wantIni = golden.ini === null ? null : Buffer.from(golden.ini, 'base64');
    const haveIni = mine.ini === null ? null : Buffer.from(mine.ini, 'base64');
    if (!!golden.ini_threw !== !!mine.ini_threw) {
        problems.push('ini throw ' + (mine.ini_threw ? 'CANDIDATE THREW (' + mine.ini_threw
            + '), baseline wrote ' + (wantIni ? wantIni.length : 0) + ' bytes'
            : 'baseline THREW (' + golden.ini_threw + '), candidate wrote '
                + (haveIni ? haveIni.length : 0) + ' bytes'));
    } else if (golden.ini_threw) {
        if (golden.ini_threw !== mine.ini_threw) {
            problems.push('ini throw message differs: baseline ' + JSON.stringify(golden.ini_threw)
                + ' vs candidate ' + JSON.stringify(mine.ini_threw));
        }
    } else if (!wantIni.equals(haveIni)) {
        let i = 0;
        while (i < Math.min(wantIni.length, haveIni.length) && wantIni[i] === haveIni[i]) i += 1;
        problems.push('ini bytes ' + wantIni.length + ' -> ' + haveIni.length + ', first difference at byte '
            + i + '\n      baseline: ' + window(wantIni.toString('utf8'), i)
            + '\n      candidate: ' + window(haveIni.toString('utf8'), i));
    }
    return problems;
}

// One evaluation cache per lib copy. A mutation sweep re-evaluates the same vectors over and over, so
// the cache is keyed by the full identity of an evaluation ([fields, settings, models]) and lives on
// the copy that produced it: the ceiling is then one evaluation per vector for the baseline plus one
// per vector per mutant, and shrink's repeated probes are free when they land on a seen identity.
function evaluator(produce) {
    const cache = new Map();
    const output = (vector) => {
        // The key is everything either generator reads. `name` is not cosmetic: buildPresetIni writes
        // one section per config key, so two vectors with identical fields must not share an answer
        // (boundary vector pairs like b6-true/b6-false differ only in name and one field).
        const key = JSON.stringify([vector.name, vector.fields, vector.settings, vector.models,
            vector.ini_configs || null]);
        let mine = cache.get(key);
        if (!mine) {
            mine = produce(vector);
            if (!mine) throw new Error(vector.id + ': the evaluator produced nothing');
            cache.set(key, mine);
        }
        return mine;
    };
    return {
        output: output,
        evaluations: () => cache.size,
        failures: (list, goldens) => {
            const out = [];
            for (const vector of list) {
                const golden = goldens.get(vector.id);
                vectors.assert(golden, vector.id + ': no golden for this vector');
                const problems = compare(golden, output(vector));
                if (problems.length) out.push({ vector: vector, golden: golden, problems: problems });
            }
            return out;
        }
    };
}

function candidateEvaluator(lib, inputs) {
    return evaluator((vector) => candidate(lib, vector, inputs.modelsById.get(vector.models),
        inputs.settingsById.get(vector.settings).settings));
}

// The oracle for inputs that are not in the golden set — shrink's probes. Recording through
// gen-goldens.record means a probe is answered by the same baseline slices that produced the goldens,
// not by a second implementation of the comparison.
function baselineEvaluator(gen, inputs) {
    const record = require('./gen-goldens.js').record;
    return evaluator((vector) => record(gen, vector, inputs.modelsById.get(vector.models),
        inputs.settingsById.get(vector.settings).settings));
}

function run(lib, bag, inputs, limit, cache) {
    const ev = cache || candidateEvaluator(lib, inputs);
    const failures = ev.failures(bag.vectors, bag.goldens);
    return { failures: failures, checked: bag.vectors.length, limit: limit,
        evaluations: ev.evaluations() };
}

// ------------------------------------------------------------------- shrink ----------------

// Greedy field-diff minimization against the reference (default-config) input: replace one field
// with the reference's value, or drop it, and keep the change only if the vector still fails the
// same way. Ends at a local minimum that is usually one or two fields deep, which is the repro an
// engineer needs.
// Delta debugging with a differential oracle. A probe is a candidate smaller input; it is accepted
// only while (a) the mutant still disagrees with the BASELINE on that exact probe, and (b) the probe
// is strictly smaller than the state it replaces.
//
// (a) is why the baseline is evaluated per probe instead of reusing the parent vector's golden: as
// soon as a probe differs from its parent, the parent's golden is just the wrong answer for it, so
// every probe would "still fail" for a trivial reason and the repro would shrink to nothing.
//
// (b) is why this terminates. An earlier version re-tried every settings and model set each pass and
// kept whatever still failed, which oscillates between two equally-sized sets forever (and burned 40
// minutes of CPU doing it). Here every accepted move strictly decreases (field count, payload size,
// distance from the reference input), so no move can be undone and the sweep is bounded.
function shrink(mutantEv, baselineEv, vector, inputs, reference) {
    const state = (fields, settings, models) => ({
        vector: Object.assign({}, vector, { fields: fields, settings: settings, models: models }),
        fields: fields, settings: settings, models: models
    });
    const fails = (s) => compare(baselineEv.output(s.vector), mutantEv.output(s.vector)).length > 0;
    const measure = (s) => [Object.keys(s.fields).length, JSON.stringify(s.fields).length,
        s.settings === reference.settings ? 0 : 1, s.models === reference.models ? 0 : 1];
    const smaller = (a, b) => {
        const x = measure(a);
        const y = measure(b);
        for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] < y[i];
        return false;
    };
    let current = state(Object.assign({}, vector.fields), vector.settings, vector.models);
    vectors.assert(fails(current), vector.id + ': shrink asked about a vector that agrees with the baseline');
    let moved = true;
    while (moved) {
        moved = false;
        for (const key of Object.keys(current.fields)) {
            const without = Object.assign({}, current.fields);
            delete without[key];
            const dropped = state(without, current.settings, current.models);
            if (smaller(dropped, current) && fails(dropped)) {
                current = dropped;
                moved = true;
                continue;
            }
            const value = current.fields[key];
            if (!(key in reference.fields)
                || JSON.stringify(reference.fields[key]) === JSON.stringify(value)) continue;
            const aligned = Object.assign({}, current.fields);
            aligned[key] = reference.fields[key];
            const nearer = state(aligned, current.settings, current.models);
            if (smaller(nearer, current) && fails(nearer)) {
                current = nearer;
                moved = true;
            }
        }
        // Only the reference input counts as smaller, so this cannot cycle between two sets.
        if (current.settings !== reference.settings) {
            const nearer = state(current.fields, reference.settings, current.models);
            if (fails(nearer)) {
                current = nearer;
                moved = true;
            }
        }
        if (current.models !== reference.models) {
            const nearer = state(current.fields, current.settings, reference.models);
            if (fails(nearer)) {
                current = nearer;
                moved = true;
            }
        }
    }
    return current.vector;
}

// The golden map is threaded through shrink instead of parked in a module global, so a shrink run
// cannot silently read the goldens of some other set.
// The row mapping for a shrunk repro: the same vars_read heuristic gen-vectors uses — recompute the
// predicate outcomes and keep the rows whose outcome differs from the reference's. A repro that maps
// to nothing is tagged UNMAPPED rather than dropped, and the count is reported.
function promotedTargets(repro, rows, gen, inputs, referenceValues) {
    const table = vectors.predicateTable(rows, [repro], gen, inputs.modelsById,
        inputs.settingsById).table.get(repro.id);
    const flips = rows.filter((row) => table[row.row_id] !== null
        && table[row.row_id] !== referenceValues[row.row_id]).map((row) => row.row_id);
    return flips.length ? flips : ['UNMAPPED'];
}

// ------------------------------------------------------------------- verify -----------------

// The coverage reality check. Trusting coverage-map.json would be trusting a claim, so this
// recomputes the predicate outcome of every mapped vector from the baseline slices and requires:
//   * every BA/INI row has >= 1 mapped vector, or is listed unreachable-domain with a reason
//   * every row claimed by a vector really does take a different outcome in that vector (flip) or
//     really does read a field whose value differs (exercise)
//   * every vector has >= 1 row, or is listed with a reason
//   * every flippable row shows BOTH outcomes among its mapped vectors
function verify(options) {
    const gen = slices.slicedGenerators();
    const inputs = loadInputs();
    const bag = loadSet();
    const all = vectors.specRows().filter((row) => /^(BA|INI)-/.test(row.row_id));
    const rows = all.filter(vectors.inDomain);
    const outside = all.filter((row) => !vectors.inDomain(row));
    const map = vectors.readJson(path.join(vectors.VECTORS, 'coverage-map.json'));
    const promotionsFile = path.join(vectors.VECTORS, 'coverage-promotions.json');
    if (fs.existsSync(promotionsFile)) {
        for (const [row, ids] of Object.entries(vectors.readJson(promotionsFile).map)) {
            map.map[row] = (map.map[row] || []).concat(ids.filter((id) => (map.map[row] || []).indexOf(id) < 0));
        }
    }
    const exceptions = vectors.readJson(path.join(vectors.VECTORS, 'coverage-exceptions.json'));
    const { table } = vectors.predicateTable(rows, bag.vectors, gen, inputs.modelsById,
        inputs.settingsById);
    const referenceValues = table.get(map.reference);
    vectors.assert(referenceValues, map.reference + ': the reference vector is not in the set');
    const byId = new Map(bag.vectors.map((vector) => [vector.id, vector]));

    const problems = [];
    const reference = byId.get(map.reference);
    vectors.assert(reference, map.reference + ': the reference vector is not in the set');
    const via = new Map(bag.vectors.map((vector) => [vector.id, vector.targets_via]));
    // The exercise relation, recomputed rather than trusted: the vector has to change the value of a
    // field this row's own predicate reads (or the /models payload, for the mmproj rows).
    const exercises = (row, vector) => {
        if (vector.models !== reference.models
            && /(^|;)(model\.[A-Za-z0-9_]+|modelPath)(;|$)/.test(row.vars_read)) return true;
        return vectors.directFieldsOf(row).some((key) => JSON.stringify(vector.fields[key])
            !== JSON.stringify(reference.fields[key])
            || (key in vector.fields) !== (key in reference.fields));
    };
    let flippable = 0;
    let singleOutcome = 0;
    let unmapped = 0;
    const rowsOfVector = new Map();
    for (const row of rows) {
        const mapped = (map.map[row.row_id] || []).filter((id) => byId.has(id));
        const others = mapped.filter((id) => id !== map.reference);
        for (const id of others) {
            if (!rowsOfVector.has(id)) rowsOfVector.set(id, []);
            rowsOfVector.get(id).push(row.row_id);
        }
        const listed = exceptions.exceptions[row.row_id];
        for (const id of others) {
            const outcome = table.get(id)[row.row_id];
            if (outcome === null) {
                problems.push(row.row_id + ': maps ' + id + ', which cannot evaluate this predicate');
                continue;
            }
            if (via.get(id) === 'exercise') {
                if (!exercises(row, byId.get(id))) {
                    problems.push(row.row_id + ': maps ' + id + ' by exercise, but no field this row '
                        + 'reads has a different value than the reference');
                }
                continue;
            }
            if (outcome === referenceValues[row.row_id]) {
                problems.push(row.row_id + ': maps ' + id + ' whose outcome matches the reference — '
                    + 'the claimed flip does not happen');
            }
        }
        if (others.length === 0) {
            unmapped += 1;
            if (!listed || listed.class !== 'unreachable-domain') {
                problems.push(row.row_id + ': no mapped vector and no unreachable-domain entry');
            }
            continue;
        }
        // The reference is one side of every flip, so it belongs in the outcome set.
        const outcomes = new Set(mapped.map((id) => table.get(id)[row.row_id])
            .filter((value) => value !== null));
        if (outcomes.size < 2) {
            singleOutcome += 1;
            if (!listed || listed.class !== 'single-outcome') {
                problems.push(row.row_id + ': only one outcome (' + [...outcomes].join(',')
                    + ') is reachable and it is not recorded as single-outcome');
            }
            continue;
        }
        flippable += 1;
    }
    for (const [key, entry] of Object.entries(exceptions.exceptions)) {
        if (key.indexOf('vector:') === 0) continue;
        if (!map.map[key]) problems.push(key + ': an exception entry for a row that is not in the map');
        else if ((map.map[key] || []).filter((id) => id !== map.reference).length > 0
            && entry.class === 'unreachable-domain') {
            problems.push(key + ': listed unreachable-domain but the map has vectors for it');
        }
    }

    // The rows outside both generators (the launchServer / launchModelPresets preludes) are not
    // flippable by any generator input, so the gate for them is: recorded with a reason, and mapped
    // to nothing. Dropping them silently is what this check exists to catch.
    for (const row of outside) {
        const listed = exceptions.exceptions[row.row_id];
        const mapped = (map.map[row.row_id] || []).filter((id) => id !== map.reference);
        if (!listed || listed.class !== 'unreachable-domain') {
            problems.push(row.row_id + ': outside the generators but not recorded unreachable-domain');
        }
        if (mapped.length > 0) {
            problems.push(row.row_id + ': outside the generators yet mapped to ' + mapped.length
                + ' vector(s)');
        }
        if (!(row.row_id in map.map)) {
            problems.push(row.row_id + ': not a key in coverage-map.json at all');
        }
    }

    let withRow = 0;
    let rowless = 0;
    for (const vector of bag.vectors) {
        if (vector.id === map.reference || (rowsOfVector.get(vector.id) || []).length > 0) {
            withRow += 1;
            continue;
        }
        const listed = exceptions.exceptions['vector:' + vector.id];
        if (!listed) problems.push(vector.id + ': no row in the map and no exception entry');
        rowless += 1;
    }
    console.log('verify: ' + bag.vectors.length + ' vectors, ' + rows.length + ' generator rows '
        + '(' + (rows.length - unmapped) + ' mapped, ' + unmapped
        + ' listed unreachable-domain), ' + flippable + ' rows proven with both outcomes, '
        + singleOutcome + ' single-outcome rows recorded');
    console.log('verify: ' + outside.length + ' rows outside the generators, all recorded '
        + 'unreachable-domain with a reason');
    console.log('verify: ' + withRow + ' vectors carry >=1 row, ' + rowless
        + ' listed rowless/duplicate-of-reference');
    if (options.all) {
        for (const row of rows) {
            const entry = exceptions.exceptions[row.row_id];
            if (entry) console.log('  ' + entry.class + ' ' + row.row_id + ': ' + entry.reason);
        }
    }
    for (const problem of problems.slice(0, 40)) console.log('  PROBLEM ' + problem);
    console.log(problems.length ? 'COVERAGE VERIFY RED (' + problems.length + ')'
        : 'COVERAGE VERIFY GREEN');
    process.exitCode = problems.length ? 1 : 0;
}

// ------------------------------------------------------------------- teeth ------------------

// Exact-string patches to the two baseline slices, applied in memory only (nothing is written to
// disk). Each site pins a quirk this suite exists to keep, so a site that no vector kills is a
// finding — the corpus stopped proving what it claims to — not a flake to tolerate.
const SITES = [
    { id: 'BA-ngl-off-by-one', file: LIB_ARGS, from: 'if (config.ngl > 0) {',
        to: 'if (config.ngl >= 0) {', why: 'the -ngl guard' },
    { id: 'BA-mmproj-match', file: LIB_ARGS, from: 'if (model.path === modelPath && model.mmprojFile) {',
        to: 'if (model.path !== modelPath && model.mmprojFile) {', why: 'the recorded mmproj association' },
    { id: 'BA-chat-template-separator', file: LIB_ARGS,
        from: "args.push('--chat-template-file', modelDir + '\\\\chat-template.jinja');",
        to: "args.push('--chat-template-file', modelDir + '/chat-template.jinja');",
        why: 'Q20 the derived template path keeps \\' },
    { id: 'BA-port-is-settings', file: LIB_ARGS, from: 'args.push("--port", settings.serverPort.toString());',
        to: 'args.push("--port", "8080");', why: 'Q5 the two recorded ports must both survive' },
    { id: 'BA-ngram-constant', file: LIB_ARGS, from: "args.push('--spec-ngram-mod-n-match', '24');",
        to: "args.push('--spec-ngram-mod-n-match', '25');", why: 'Q15 the ngram-mod constants' },
    { id: 'BA-reasoning-branch', file: LIB_ARGS, from: "if (config.reasoning === 'off') {",
        to: "if (config.reasoning === 'on') {", why: 'Q17 reasoning off/on' },
    { id: 'BA-ngld-zero', file: LIB_ARGS, from: 'if (config.ngld >= 0) {', to: 'if (config.ngld > 0) {',
        why: 'the -ngld 0 key' },
    { id: 'BA-draft-path-guard', file: LIB_ARGS,
        from: "if (config.draftModelPath && config.speculationType !== 'none'",
        to: "if (!config.draftModelPath && config.speculationType !== 'none'", why: 'Q21 -md and the draft guard' },
    { id: 'INI-temp-zero', file: LIB_INI, from: 'if (config.temp !== undefined && config.temp >= 0) {',
        to: 'if (config.temp !== undefined && config.temp > 0) {', why: 'the temperature 0 key' },
    { id: 'INI-minP-000', file: LIB_INI, from: '|| config.minP == "0.00"', to: '|| false',
        why: 'the "0.00" special case (Q12-style string compare)' },
    { id: 'INI-ngl-off-by-one', file: LIB_INI, from: 'if (config.ngl !== undefined && config.ngl > 0) {',
        to: 'if (config.ngl !== undefined && config.ngl >= 0) {', why: 'the ngl key guard' },
    { id: 'INI-ngram-key-name', file: LIB_INI, from: 'presetContent += `spec-ngram-size-n = 24\\n`;',
        to: 'presetContent += `spec-ngram-mod-n-match = 24\\n`;', why: 'Q15 the ini key is not the argv flag name' },
    { id: 'INI-jinja-truthy', file: LIB_INI, from: 'if (config.jinja !== undefined && config.jinja) {',
        to: 'if (config.jinja !== undefined) {', why: 'an unchecked checkbox must not write the key' }
];

function mutant(site) {
    const args = slices.readText(LIB_ARGS);
    const ini = slices.readText(LIB_INI);
    const text = site.file === LIB_ARGS ? args : ini;
    const hits = text.split(site.from).length - 1;
    vectors.assert(hits === 1, 'site ' + site.id + ': its anchor occurs ' + hits + ' time(s) in '
        + site.file + ' — the site has moved, refresh it rather than dropping it');
    const patched = text.split(site.from).join(site.to);
    return mutantLib(site.file === LIB_ARGS ? patched : args,
        site.file === LIB_INI ? patched : ini);
}

// The small sample: every boundary vector (the hand-targeted quirk probes), every corpus vector
// (recorded legacy state), and a deterministic stride out of each generated family. Fixed input, so
// the gate is reproducible and finishes in seconds; --full is the explicit, wider sweep.
function sampleSet(bag, size) {
    const picked = bag.vectors.filter((vector) => vector.family === 'boundary'
        || vector.family === 'corpus');
    const seen = new Set(picked.map((vector) => vector.id));
    const perFamily = Math.max(1, Math.ceil(size / 3));
    for (const family of ['cover', 'format', 'random']) {
        const pool = bag.vectors.filter((vector) => vector.family === family && !seen.has(vector.id));
        const step = Math.max(1, Math.floor(pool.length / perFamily));
        let taken = 0;
        for (let i = 0; i < pool.length && taken < perFamily; i += step) {
            picked.push(pool[i]);
            seen.add(pool[i].id);
            taken += 1;
        }
    }
    return picked;
}

// Run every site against one vector list. Kills are idempotent — no later vector can unkill a site —
// so a caller that already killed a site on a prefix never has to pay for the full set.
function teeth(list, label, inputs, goldens, log) {
    const clean = candidateEvaluator(slices.loadLib(), inputs).failures(list, goldens);
    const killed = [];
    const survivors = [];
    let evaluations = 0;
    for (const site of SITES) {
        const ev = candidateEvaluator(mutant(site), inputs);
        const failures = ev.failures(list, goldens);
        evaluations += ev.evaluations();
        if (failures.length) killed.push({ site: site, failures: failures, ev: ev });
        else survivors.push(site);
        log((failures.length ? 'killed   ' : 'SURVIVED ') + site.id + ' (' + site.why + ') — '
            + failures.length + '/' + list.length + ' vectors on ' + label);
    }
    return { clean: clean, killed: killed, survivors: survivors, evaluations: evaluations };
}

function timing(t0) {
    const seconds = (Date.now() - t0) / 1000;
    return seconds.toFixed(1) + 's';
}

// --selftest: the sub-minute teeth gate on the fixed sample. Semantics are the full sweep's, only on
// a smaller set: every site must die, the unmutated lib must be clean, and shrinking must localize a
// kill to a vector that still fails on its own.
function selftest(options) {
    const t0 = Date.now();
    const inputs = loadInputs();
    const bag = loadSet();
    const sample = sampleSet(bag, options.sample);
    console.log('selftest: ' + sample.length + ' vectors (' + bag.vectors.filter((v) => v.family === 'boundary').length
        + ' boundary + ' + bag.vectors.filter((v) => v.family === 'corpus').length + ' corpus + '
        + options.sample + ' stratified) x ' + SITES.length + ' mutation sites');
    const run1 = teeth(sample, 'the sample', inputs, bag.goldens, (line) => console.log('  ' + line));
    for (const site of run1.survivors) {
        console.log('  ' + site.id + ' needs the full set: node tools/parity/equivalence.js --full');
    }
    const first = run1.killed[0];
    const oracle = baselineEvaluator(slices.slicedGenerators(), inputs);
    const repro = shrink(first.ev, oracle, first.failures[0].vector, inputs, referenceVector(bag));
    vectors.assert(compare(oracle.output(repro), first.ev.output(repro)).length > 0,
        'selftest: the shrunk repro no longer reproduces the failure');
    console.log('selftest: ' + first.site.id + ' caught on ' + first.failures.length + ' of '
        + sample.length + ' vectors; shrunk '
        + Object.keys(first.failures[0].vector.fields).length + ' -> '
        + Object.keys(repro.fields).length + ' fields and still fails');
    console.log('selftest: ' + (run1.evaluations + oracle.evaluations()) + ' evaluations in '
        + timing(t0));
    console.log('selftest: unmutated lib compares with ' + run1.clean.length + ' failure(s) ['
        + (run1.clean.length ? 'RED' : 'GREEN') + ']');
    if (run1.clean.length) {
        for (const failure of run1.clean.slice(0, 5)) {
            console.log('  ' + failure.vector.id + ': ' + failure.problems.join('; '));
        }
    }
    const red = run1.survivors.length + run1.clean.length;
    console.log(red ? 'TEETH RED (' + red + ' site(s) survived or vector(s) disagree with the baseline)'
        : 'SELFTEST GREEN');
    process.exitCode = red ? 1 : 0;
    return run1;
}

// --full: the explicitly invoked sweep. Tier 1 is the same prefix the selftest uses; only sites that
// survive it pay for every vector in the corpus. --family narrows the sweep to one family, which is
// how the work is done incrementally (family by family, each pass a few seconds) if a run is ever
// interrupted — with every site dying on the prefix the whole sweep costs 5 s, so no sharder is needed.
function sweep(options) {
    const t0 = Date.now();
    const inputs = loadInputs();
    const full = loadSet();
    const bag = options.family
        ? { vectors: full.vectors.filter((vector) => vector.family === options.family),
            goldens: full.goldens }
        : full;
    vectors.assert(bag.vectors.length > 0, 'full: no vectors in family ' + options.family);
    const prefix = sampleSet(bag, options.sample);
    console.log('full sweep: ' + SITES.length + ' sites x ' + bag.vectors.length + ' vectors'
        + (options.family ? ' (family ' + options.family + ')' : '') + ', tier 1 on a '
        + prefix.length + '-vector prefix');
    const tier1 = teeth(prefix, 'the prefix', inputs, bag.goldens, (line) => console.log('  ' + line));
    let evaluations = tier1.evaluations;
    const survivors = [];
    const scoped = options.family ? ' (family ' + options.family + ' only)' : '';
    for (const site of tier1.survivors) {
        const ev = candidateEvaluator(mutant(site), inputs);
        const failures = ev.failures(bag.vectors, bag.goldens);
        evaluations += ev.evaluations();
        if (failures.length) {
            console.log('  killed   ' + site.id + ' only on the full set' + scoped + ' — '
                + failures.length + '/' + bag.vectors.length + ' vectors (first: '
                + failures[0].vector.id + ')');
        } else {
            survivors.push(site);
            console.log('  survived ' + site.id + ' — nothing in '
                + (options.family ? 'family ' + options.family : 'the corpus') + ' kills it' + scoped);
        }
    }
    console.log('full sweep: ' + (SITES.length - survivors.length) + '/' + SITES.length
        + ' sites killed' + scoped + ', ' + evaluations + ' evaluations in ' + timing(t0));
    if (tier1.clean.length) {
        console.log('full sweep: the unmutated lib disagrees with the goldens on '
            + tier1.clean.length + ' vector(s)');
    }
    // A site a single family cannot kill is not a defect — the whole-corpus sweep is the verdict. Only
    // the unsliced sweep is allowed to call a site unkillable, or every shard would look red.
    for (const site of survivors) {
        console.log((options.family ? '  not-by-this-family ' : '  UNKILLABLE ') + site.id + ': '
            + site.why);
    }
    const red = (options.family ? 0 : survivors.length) + tier1.clean.length;
    console.log(red ? 'FULL SWEEP RED (' + red + ')' : 'FULL SWEEP GREEN');
    process.exitCode = red ? 1 : 0;
    return { survivors: survivors, clean: tier1.clean };
}

// Evaluate a patched copy of the UMD lib in isolation; nothing is written to disk.
function mutantLib(argsSource, iniSource) {
    /* eslint-disable no-new-func */
    const load = (text, file) => {
        const module = { exports: {} };
        new Function('module', 'exports', 'require', '__dirname', text)
            (module, module.exports, require, path.dirname(file));
        return module.exports;
    };
    /* eslint-enable no-new-func */
    const args = load(argsSource, LIB_ARGS);
    const ini = load(iniSource, LIB_INI);
    return { buildArgs: args.buildArgs, buildPresetIni: ini.buildPresetIni };
}

// --------------------------------------------------------------------- main ---------------

function main() {
    const argv = process.argv.slice(2);
    const options = { first: 10, sample: 50 };
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === '--verify') options.verify = true;
        else if (token === '--shrink') options.shrink = true;
        else if (token === '--selftest') options.selftest = true;
        else if (token === '--full') options.full = true;
        else if (token === '--all') options.all = true;
        else if (token === '--family') options.family = argv[i += 1];
        else if (token === '--first') options.first = Number(argv[i += 1]);
        else if (token === '--sample') options.sample = Number(argv[i += 1]);
        else throw new Error('unknown argument: ' + token);
    }
    if (options.verify) {
        verify(options);
        return;
    }
    if (options.selftest) {
        selftest(options);
        return;
    }
    if (options.full) {
        sweep(options);
        return;
    }
    const lib = slices.loadLib();
    const inputs = loadInputs();
    const bag = loadSet();
    const selected = options.family
        ? { vectors: bag.vectors.filter((v) => v.family === options.family), goldens: bag.goldens }
        : bag;
    const cache = candidateEvaluator(lib, inputs);
    const result = run(lib, selected, inputs, options.first, cache);
    for (const failure of result.failures.slice(0, options.first)) {
        console.log('DIFF ' + failure.vector.id + ' (' + failure.vector.family + ')');
        for (const problem of failure.problems) console.log('    ' + problem);
    }
    if (result.failures.length > options.first) {
        console.log('... ' + (result.failures.length - options.first) + ' more failing vectors');
    }
    console.log('equivalence: ' + (selected.vectors.length - result.failures.length) + '/'
        + selected.vectors.length + ' vectors byte-identical to parity-baseline');
    if (options.shrink && result.failures.length > 0) {
        promote(cache, baselineEvaluator(slices.slicedGenerators(), inputs), result.failures, inputs,
            referenceVector(bag));
    }
    if (result.failures.length) {
        console.log('EQUIVALENCE RED — the candidate is wrong; a golden is never edited to go green (C4)');
    } else {
        console.log('EQUIVALENCE GREEN');
    }
    process.exitCode = result.failures.length ? 1 : 0;
}

// Write the minimal repros and promote them into the coverage map, appending the rows they hit. A
// repro that maps to no row is kept (it is still a repro) with targets ['UNMAPPED'] and counted.
// Append-only promotion. coverage-map.json is gen-vectors.js's output and `--check` proves it is
// reproducible from that generator, so a promotion must not rewrite it: repros land in
// boundary/shrunk-<family>.jsonl, their row ids in coverage-promotions.json (merged by --verify), and
// their expected bytes in fixtures/goldens/boundary/shrunk-<family>.goldens.jsonl — recorded from the
// baseline like every other golden, so the repro carries legacy's answer, not the candidate's.
//
// `roots` defaults to the fixture directories, which is what the gate needs; passing another pair is
// how the promotion path itself is exercised without putting a repro of an in-memory mutant into
// recorded fixtures (fixtures are recorded from legacy, never authored — C5).
function promote(mutantEv, baselineEv, failures, inputs, reference, roots) {
    const gen = slices.slicedGenerators();
    const rows = vectors.specRows().filter(vectors.inDomain);
    const referenceValues = vectors.predicateTable(rows, [reference], gen, inputs.modelsById,
        inputs.settingsById).table.get(reference.id);
    const root = (roots && roots.vectors) || vectors.VECTORS;
    const goldenRoot = (roots && roots.goldens) || vectors.GOLDENS;
    const promotionsFile = path.join(root, 'coverage-promotions.json');
    const promotions = fs.existsSync(promotionsFile)
        ? vectors.readJson(promotionsFile) : { generated_by: 'tools/parity/equivalence.js',
            command: SHRINK_REGEN, map: {} };
    const bySource = new Map();
    let unmapped = 0;
    for (const failure of failures) {
        const repro = shrink(mutantEv, baselineEv, failure.vector, inputs, reference);
        repro.id = 'shrunk-' + failure.vector.id;
        repro.family = 'boundary';
        repro.name = repro.id;
        repro.note = 'shrunk repro of ' + failure.vector.id + ': ' + failure.problems[0];
        repro.targets = promotedTargets(repro, rows, gen, inputs, referenceValues);
        if (repro.targets.length === 1 && repro.targets[0] === 'UNMAPPED') unmapped += 1;
        repro.targets_via = 'flip';
        if (!bySource.has(failure.vector.family)) bySource.set(failure.vector.family, []);
        bySource.get(failure.vector.family).push(repro);
        for (const row of repro.targets) {
            promotions.map[row] = promotions.map[row] || [];
            if (promotions.map[row].indexOf(repro.id) < 0) promotions.map[row].push(repro.id);
        }
    }
    for (const [family, list] of bySource) {
        const file = path.join(root, 'boundary', 'shrunk-' + family + '.jsonl');
        vectors.writeJsonl(file, [JSON.stringify({ kind: 'header', family: 'boundary',
            generator: 'tools/parity/equivalence.js', command: SHRINK_REGEN, source_family: family,
            count: list.length, note: 'minimal repros of an equivalence failure; the candidate output '
                + 'that failed is recorded in each note' })]
            .concat(list.map((vector) => JSON.stringify(vector))));
        const goldens = list.map((vector) => JSON.stringify({ kind: 'golden', vector_id: vector.id,
            impl: 'parity-baseline@' + goldens_impl(),
            ...goldFor(gen, vector, inputs) }));
        const goldenFile = path.join(goldenRoot, 'boundary', 'shrunk-' + family + '.goldens.jsonl');
        vectors.writeJsonl(goldenFile, [JSON.stringify({ kind: 'header', family: 'boundary',
            generator: 'tools/parity/equivalence.js', command: SHRINK_REGEN,
            vectors_file: 'fixtures/vectors/boundary/shrunk-' + family + '.jsonl',
            count: list.length })].concat(goldens));
        console.log('wrote ' + list.length + ' shrunk repro(s) to '
            + path.relative(process.cwd(), file).split('\\').join('/') + ' (+ goldens)');
    }
    fs.writeFileSync(promotionsFile, JSON.stringify(promotions, null, 2) + '\n', 'utf8');
    console.log('promoted ' + failures.length + ' repro(s) into '
        + path.relative(process.cwd(), promotionsFile).split('\\').join('/') + '; '
        + unmapped + ' UNMAPPED');
    return { promotions: promotions, unmapped: unmapped };
}

function goldens_impl() {
    return require('./gen-goldens.js').baselineSha();
}

// The baseline answer for a repro, in the same shape as every other golden.
function goldFor(gen, vector, inputs) {
    return require('./gen-goldens.js').record(gen, vector,
        inputs.modelsById.get(vector.models),
        inputs.settingsById.get(vector.settings).settings);
}

module.exports = { run, compare, candidate, shrink, verify, selftest, sweep, sampleSet, evaluator,
    candidateEvaluator, baselineEvaluator, teeth, mutant, mutantLib, promote, loadSet, loadInputs,
    referenceVector, SITES };

if (require.main === module) main();
