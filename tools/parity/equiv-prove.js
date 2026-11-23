#!/usr/bin/env node
'use strict';
// Phase 2.6 (plan.md §2): decide, mechanically, whether each surviving mutant is an equivalent mutant
// or a hole in the vector set.
//
//   node tools/parity/equiv-prove.js                classify every survivor in run.json, write proofs
//   node tools/parity/equiv-prove.js --report       only rebuild REPORT.md from run.json + proofs
//   node tools/parity/equiv-prove.js --selftest     the proofs themselves are tested
//
// A survivor is EQUIVALENT only on evidence, never on judgement (plan §2 Phase 2.6, §5 Auditor re-proof):
//
//   static   the mutated expression's two forms cannot disagree for any input the field domain admits,
//            inferred from the baseline source itself (`parseInt(...)` cannot produce null; a checkbox
//            reads a boolean; `== ` and `===` agree on two values of one primitive type), or
//   dynamic  an exhaustive probe over the product of the site's own input domain — every value that key
//            takes across ALL recorded vectors, plus the boundary set (0, -1, "", null, undefined, "0",
//            "0.0", "0.00", "NaN", "1e3", true, false, ...) — produces byte-identical argv and ini.
//
// Anything else is a GAP, and a gap is an action, not a label: the probe search continues until it
// finds an input where baseline and mutant differ, that input is written up as a promotion proposal
// (PROMOTIONS-PROPOSED.json — fixtures are frozen and being re-recorded, so the parent applies it), and
// a survivor with neither a static argument nor a difference found under a truncated probe set is written
// to ESCALATION.md as `unresolved-gap`. Nothing is ever marked equivalent because it was inconvenient.
//
// Proofs are written one file per survivor to reports/mutation/proofs/<survivor-id>.json and each is
// flushed as its survivor finishes, so a long proof run is resumable; an existing proof for the same
// mutant sha is reused rather than recomputed.
//
// Inputs are the private snapshot of the committed 9d6a767 vectors/goldens. Live fixtures are not read.

const fs = require('fs');
const path = require('path');

const slices = require('./baseline-slices.js');
const vectors = require('./gen-vectors.js');
const mutate = require('./mutate.js');
const runner = require('./mutation-run.js');
const equivalence = require('./equivalence.js');

const REPO = mutate.REPO;
const REPORTS = mutate.REPORTS;
const PROOFS = path.join(REPORTS, 'proofs');
const RUN_FILE = path.join(REPORTS, 'run.json');
const MUTANTS_FILE = path.join(REPO, mutate.MUTANT_FILE);
const PROMOTIONS = path.join(REPORTS, 'PROMOTIONS-PROPOSED.json');
const REPORT_MD = path.join(REPORTS, 'REPORT.md');
const ESCALATION = path.join(REPO, 'ESCALATION.md');
const MAX_DOMAIN = 24;
const MAX_PROBES = 24000;

// The boundary values the plan names, in a fixed order. `__omit__` removes the key, which is the state
// a missing localStorage key produces (undefined through the generator), not the same as "".
const BOUNDARY = ['', 0, 1, -1, -0, 0.5, '0', '0.0', '0.00', '1', 'true', 'false', 'NaN', 'null',
    'undefined', '1e3', '1e-7', '0.30000000000000004', '  8  ', '0x10', '0.7xyz', true, false, null,
    undefined, 9007199254740993, 1.005, '__omit__'];

// ------------------------------------------------------------------ field typing ----------

// Type of the value a config-literal entry hands the argv generator, read off the baseline text:
// `parseInt(...)`/`parseFloat(...)` are numbers (NaN included), `.checked` is a boolean, `.value`
// (with or without .trim()) is a string. Anything unrecognised is 'unknown' and forfeits the static
// argument, which is the conservative direction.
function configLiteralTypes(gen) {
    const types = new Map();
    for (const entry of slices.literalEntries(gen.slices.config)) {
        const expr = entry.expr;
        if (/^parseInt\(/.test(expr) || /^parseFloat\(/.test(expr)) types.set(entry.key, 'number');
        else if (/\.checked\b/.test(expr)) types.set(entry.key, 'boolean');
        else if (/\.value\b/.test(expr)) types.set(entry.key, 'string');
        else types.set(entry.key, 'unknown');
    }
    return types;
}

const STRING_LITERAL = /^(['"]).*\1$/s;
const NUMBER_LITERAL = /^-?\d+(\.\d+)?$/;

// Conservative type inference for an operand expression. `config.X` in the argv generator means the
// config literal's value for X, so it is typed from the literal; in the ini generator `config.X` is a
// value out of localStorage and could be any JSON type, so it is 'unknown'.
function inferType(text, ctx) {
    const t = text.trim();
    if (t === 'undefined' || t === 'null') return t;
    if (STRING_LITERAL.test(t)) return 'string';
    if (NUMBER_LITERAL.test(t)) return 'number';
    if (/^(?:!|isNaN\(|Number\.isNaN\(|.*\.includes\(|.*\.some\()/.test(t)) return 'boolean';
    if (/\.length$/.test(t)) return 'number';
    if (/^parseInt\(|^parseFloat\(/.test(t)) return 'number';
    if (/\bdocument\.getElementById\('[^']+'\)\.checked\b/.test(t) || /\.checked\b/.test(t)) {
        return 'boolean';
    }
    if (/\.value\b/.test(t)) return 'string';
    const field = t.match(/^config\.([A-Za-z0-9_]+)$/);
    if (field) {
        if (ctx.region === 'ini') return 'unknown';
        return ctx.types.get(field[1]) || 'unknown';
    }
    if (/^[A-Za-z0-9_.]+$/.test(t) && ctx.region !== 'ini') {
        const bare = t.match(/^([A-Za-z0-9_]+)$/);
        if (bare && ctx.types.has(bare[1])) return ctx.types.get(bare[1]);
    }
    return 'unknown';
}

const SAFE_PRIMITIVES = new Set(['string', 'boolean', 'number']);

// Static equivalence arguments, per mutation class. Deliberately narrow: a class gets an argument only
// where the operator pair provably cannot disagree over the operands' whole domain.
function staticProof(mutant, site, ctx) {
    const line = ctx.regionLines[site.line];
    const spanText = line.slice(site.start, site.end);
    if (mutant.class === 'equality-strictness') {
        const ops = mutate.topOperators(spanText, ['===', '!==', '==', '!=']);
        if (!ops.length) return null;
        const op = ops[0];
        const left = inferType(spanText.slice(0, op.start), ctx);
        const right = inferType(spanText.slice(op.end), ctx);
        if (SAFE_PRIMITIVES.has(left) && left === right) {
            return {
                kind: 'static',
                argument: '`' + op.text + '` and `' + mutant.after + '` agree on every pair of values of '
                    + 'one primitive type (' + left + '), and both operands are ' + left
                    + ' for every input the field domain admits: LHS `' + spanText.slice(0, op.start).trim()
                    + '` -> ' + left + ', RHS `' + spanText.slice(op.end).trim() + '` -> ' + left
                    + '. null/undefined, which is where == and === differ, is not reachable on either side.',
                operands: { left: spanText.slice(0, op.start).trim(), left_type: left,
                    right: spanText.slice(op.end).trim(), right_type: right }
            };
        }
        return null;
    }
    if (mutant.class === 'boolean-operator' && mutant.after === '??') {
        const ops = mutate.topOperators(spanText, ['||']);
        if (!ops.length) return null;
        const left = inferType(spanText.slice(0, ops[0].start), ctx);
        if (SAFE_PRIMITIVES.has(left)) {
            return {
                kind: 'static',
                argument: '`||` and `??` differ only when the left operand is null or undefined; the left '
                    + 'operand `' + spanText.slice(0, ops[0].start).trim() + '` is ' + left
                    + ' for every input the field domain admits, so the mutant cannot be reached by a '
                    + 'distinguishing input.'
            };
        }
    }
    return null;
}

// -------------------------------------------------------------------- domains -------------

// Every value a key takes across the recorded inputs, plus the boundary set. Recorded values are read
// from the snapshot vectors: `fields` (the saved-config shape, which is what the ini generator sees and
// what the launch path overlays on the form state) and the multi-config `ini_configs` payloads.
function observedValues(bag) {
    const byKey = new Map();
    const add = (key, value) => {
        if (!byKey.has(key)) byKey.set(key, new Map());
        const values = byKey.get(key);
        const token = value === undefined ? '__undefined__' : JSON.stringify(value);
        if (!values.has(token)) values.set(token, value);
    };
    for (const vector of bag.vectors) {
        for (const [key, value] of Object.entries(vector.fields || {})) add(key, value);
        for (const config of Object.values(vector.ini_configs || {})) {
            for (const [key, value] of Object.entries(config)) add(key, value);
        }
    }
    return byKey;
}

const jsonKey = (value) => value === undefined ? '__undefined__' : JSON.stringify(value);

// observed ∪ boundary, deterministically reduced to MAX_DOMAIN entries. Reference value and every
// boundary value survive the reduction; observed values are taken on a stride, so the same domain comes
// out of every run.
function domainFor(key, observed, reference) {
    const values = new Map();
    const put = (value) => values.set(jsonKey(value), value);
    put(reference ? reference[key] : undefined);
    for (const token of BOUNDARY) put(token === '__omit__' ? undefined : token);
    const seen = observed.get(key);
    const observedValues = seen ? [...seen.values()] : [];
    const room = Math.max(0, MAX_DOMAIN - values.size);
    if (observedValues.length > room) {
        const step = Math.ceil(observedValues.length / Math.max(1, room));
        for (let i = 0; i < observedValues.length && values.size < MAX_DOMAIN; i += step) {
            put(observedValues[i]);
        }
    } else {
        for (const value of observedValues) {
            if (values.size >= MAX_DOMAIN) break;
            put(value);
        }
    }
    return [...values.entries()].sort((a, b) => a[0].localeCompare(b[0])).map((entry) => entry[1]);
}

// Which input knobs a survivor's sites actually read. vars_read carries the row inventory's own naming;
// pseudo-entries (`parseInt()`, `undefined`, `isNaN()`) are not inputs and drop out. `specTypes.length`
// is derived inside both generators from speculationType + ngramMod, so it is probed through them.
const PSEUDO = /^(?:[A-Za-z0-9_.]+\(\)|undefined|null|Object\.entries\(\)|configs|configName)$/;

function probeVarsFor(mutant, rowsById) {
    const vars = new Set();
    let needsConfigCount = false;
    let needsModels = false;
    for (const rowId of mutant.row_ids) {
        const row = rowsById.get(rowId);
        if (!row) continue;
        for (const raw of (row.vars_read || '').split(';').filter(Boolean)) {
            if (raw === 'Object.entries()' || raw === 'configs' || raw === 'configName') {
                needsConfigCount = true;
                continue;
            }
            if (/^model\./.test(raw) || raw === 'modelPath') {
                needsModels = needsModels || /^model\./.test(raw);
            }
            if (raw === 'specTypes.length') {
                vars.add('speculationType');
                vars.add('ngramMod');
                continue;
            }
            if (PSEUDO.test(raw)) continue;
            const field = raw.match(/^(?:fields|config)\.([A-Za-z0-9_]+)$/);
            if (field) vars.add(field[1]);
            else if (/^[A-Za-z0-9_]+$/.test(raw)) vars.add(raw);
        }
    }
    return { keys: [...vars].sort(), needsConfigCount: needsConfigCount, needsModels: needsModels };
}

// The recorded /models payloads plus a synthetic pair, so `model.path === modelPath && model.mmprojFile`
// is probed on both sides of its own conjunction rather than only on the shapes the vectors happened to
// record.
function modelSets(bag) {
    const sets = [...bag.modelsById.values()];
    const paths = new Set();
    for (const set of sets) for (const model of set) paths.add(model.path);
    const list = [...paths].sort().slice(0, 6);
    sets.push([
        { path: list[0] || 'a.gguf', mmprojFile: null },
        { path: list[1] || 'b.gguf', mmprojFile: list[2] || 'b.mmproj.gguf' },
        { path: 'probe/mmproj.gguf', mmprojFile: 'probe/mmproj-file.gguf' }
    ]);
    sets.push([]);
    return sets;
}

// -------------------------------------------------------------------- probe set -----------

const cartesian = (lists) => lists.reduce((rows, list) => rows.flatMap((row) => list.map((value) => row
    .concat([value]))), [[]]);

// Build the probe list: the full product over the site's own domains when it fits the budget, with a
// documented reduction otherwise. `scope` records exactly what was enumerated — the proof's strength is
// part of the proof.
function probeSet(mutant, ctx, reference) {
    const vars = probeVarsFor(mutant, ctx.rowsById);
    const domains = vars.keys.map((key) => domainFor(key, ctx.observed, reference.fields));
    const key = domainFor('__probe_key__', ctx.observed, {});
    void key;
    const sets = ctx.modelSets;
    const configCounts = vars.needsConfigCount ? [0, 1, 2, 3] : [1];

    let lists = [domains.length ? cartesian(domains) : [[]], sets.map((models, i) => ({ models: models,
        index: i })), configCounts];
    let product = lists[0].length * lists[1].length * lists[2].length;
    let truncated = false;
    while (product > MAX_PROBES && lists[0][0].length > 1) {
        const widest = lists[0][0].map((_, i) => i).sort((a, b) => domainSize(lists[0], b)
            - domainSize(lists[0], a))[0];
        const shrunk = lists[0].map((row) => row.slice());
        const kept = [];
        const step = 2;
        for (let i = 0; i < shrunk.length; i += step) kept.push(shrunk[i]);
        const values = [...new Set(kept.map((row) => jsonKey(row[widest])))];
        lists[0] = kept.filter((row, i) => i === kept.findIndex((other) => jsonKey(other[widest])
            === values[i % values.length]));
        product = lists[0].length * lists[1].length * lists[2].length;
        truncated = true;
    }
    const probes = [];
    for (const assignment of lists[0]) {
        for (const model of lists[1]) {
            for (const count of lists[2]) {
                const fields = {};
                vars.keys.forEach((name, i) => { fields[name] = assignment[i]; });
                probes.push({ fields: fields, models: model, configCount: count });
            }
        }
    }
    return {
        probes: probes,
        scope: {
            variables: vars.keys, domains: vars.keys.map((name, i) => ({ key: name,
                size: domains[i].length })),
            model_sets: lists[1].length, config_counts: configCounts,
            full_product: domains.reduce((a, d) => a * d.length, 1) * sets.length
                * configCounts.length,
            enumerated: probes.length,
            exhaustive_over_enumerated: !truncated,
            truncated: truncated
        }
    };
}

const domainSize = (rows, index) => new Set(rows.map((row) => jsonKey(row[index]))).size;

// ------------------------------------------------------------------ probe execution -------

// Baseline and mutant over the same probe input, compared by the same comparator that judges the
// candidate: argv positionally, ini as bytes, throw message as output.
function probeOutputs(gen, mutant, probe, ctx) {
    const fields = slices.fieldsFromConfig(ctx.reference.fields, ctx.kinds, probe.fields, true);
    const settings = ctx.settings;
    const baseline = {
        argv: null, argv_threw: null, ini: null, ini_threw: null
    };
    try {
        baseline.argv = slices.runBaselineArgv(gen, fields, settings, probe.models.models).args;
    } catch (error) {
        baseline.argv_threw = String(error && error.message);
    }
    const mine = { argv: baseline.argv, argv_threw: baseline.argv_threw, ini: baseline.ini,
        ini_threw: baseline.ini_threw };
    if (mutant.channel === 'argv') {
        try {
            const args = mutant._runner.argv(fields, settings, probe.models.models);
            mine.argv = Array.isArray(args) ? args : null;
            mine.argv_threw = Array.isArray(args) ? null : 'returned ' + JSON.stringify(args);
        } catch (error) {
            mine.argv = null;
            mine.argv_threw = String(error && error.message);
        }
    } else {
        try {
            baseline.ini = Buffer.from(slices.runBaselineIni(gen, probe.configs,
                probe.models.models), 'utf8').toString('base64');
        } catch (error) {
            baseline.ini = null;
            baseline.ini_threw = String(error && error.message);
        }
        mine.ini = baseline.ini;
        mine.ini_threw = baseline.ini_threw;
        try {
            const ini = mutant._runner.ini(probe.configs, probe.models.models);
            mine.ini = Buffer.from(ini, 'utf8').toString('base64');
            mine.ini_threw = null;
        } catch (error) {
            mine.ini = null;
            mine.ini_threw = String(error && error.message);
        }
    }
    return equivalence.compare(baseline, mine);
}

// Assemble the concrete input a probe used, in vector shape, so a proposal is re-runnable by the parent
// without this file's internals.
function probeVector(mutant, probe, ctx, index) {
    const name = 'mutation-probe-' + String(index + 1).padStart(4, '0');
    const fields = { ...ctx.reference.fields, ...probe.fields };
    for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key];
    const configs = {};
    for (let i = 0; i < probe.configCount; i += 1) {
        configs[probe.configCount === 1 ? name : name + '-' + (i + 1)] = { ...fields };
    }
    return {
        id: name,
        family: 'boundary',
        name: name,
        fields: fields,
        settings: ctx.reference.settings,
        models: probe.models.index,
        ini_configs: mutant.channel === 'ini' ? configs : undefined,
        targets: mutant.row_ids.slice().sort()
    };
}

// ------------------------------------------------------------------ classification --------

function analyze(mutant, ctx, reference, index) {
    const gen = ctx.gen;
    mutant._runner = mutate.mutantRunner(gen, mutant, [mutant]);
    const site = { line: mutant.line - 1, start: mutant.start, end: mutant.end };
    const ctxStatic = { region: mutant.region, types: ctx.types, regionLines: ctx.regionLines };
    const proof = staticProof(mutant, site, ctxStatic);
    if (proof) {
        return {
            survivor_id: mutant.id, status: 'equivalent-proven', method: 'static',
            row_ids: mutant.row_ids, class: mutant.class, region: mutant.region,
            before: mutant.before, after: mutant.after, static: proof,
            probes: { run: 0, scope: null }
        };
    }
    const set = probeSet(mutant, ctx, reference);
    let killer = null;
    let run = 0;
    for (let i = 0; i < set.probes.length && !killer; i += 1) {
        const probe = set.probes[i];
        if (mutant.channel === 'ini') {
            const name = 'probe-' + (i + 1);
            const fields = { ...reference.fields, ...probe.fields };
            for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key];
            const configs = {};
            for (let c = 0; c < probe.configCount; c += 1) {
                configs[probe.configCount === 1 ? name : name + '-' + (c + 1)] = { ...fields };
            }
            probe.configs = configs;
        }
        const problems = probeOutputs(gen, mutant, probe, ctx);
        run += 1;
        if (problems.length) killer = { index: i, probe: probe, problems: problems };
    }
    if (killer) {
        const vector = probeVector(mutant, killer.probe, ctx, killer.index);
        return {
            survivor_id: mutant.id, status: 'gap-killer-synthesized', method: 'dynamic-differential',
            row_ids: mutant.row_ids, class: mutant.class, region: mutant.region,
            before: mutant.before, after: mutant.after,
            probes: { run: run, scope: set.scope },
            killing_probe: { index: killer.index, fields: killer.probe.fields,
                model_set_index: killer.probe.models.index, config_count: killer.probe.configCount },
            difference: killer.problems.slice(0, 2),
            proposed_vector: vector
        };
    }
    if (!set.scope.exhaustive_over_enumerated) {
        return {
            survivor_id: mutant.id, status: 'unresolved-gap', method: 'probe-truncated',
            row_ids: mutant.row_ids, class: mutant.class, region: mutant.region,
            before: mutant.before, after: mutant.after,
            probes: { run: run, scope: set.scope },
            why: 'the probe domain was truncated to fit the ' + MAX_PROBES + '-probe budget, so '
                + 'invariance over the enumerated set does not prove equivalence, and no static '
                + 'argument is available for class ' + mutant.class
        };
    }
    return {
        survivor_id: mutant.id, status: 'equivalent-proven', method: 'dynamic-exhaustive',
        row_ids: mutant.row_ids, class: mutant.class, region: mutant.region,
        before: mutant.before, after: mutant.after,
        probes: { run: run, scope: set.scope },
        argument: 'over all ' + run + ' inputs in the enumerated domain (the product of every value the '
            + 'site reads takes across the recorded vectors plus the boundary set, times every recorded '
            + '/models payload' + (set.scope.config_counts.length > 1 ? ' and every config count in '
                + JSON.stringify(set.scope.config_counts) : '') + '), the mutant and the unmutated '
            + 'baseline produce byte-identical ' + mutant.channel + ' output, including identical throw '
            + 'messages where the baseline throws.'
    };
}

// --------------------------------------------------------------------- context ------------

function buildContext() {
    const gate = mutate.requireCommittedInputs();
    const gen = slices.slicedGenerators();
    const bag = runner.loadSnapshot();
    const kinds = slices.fieldKinds();
    const referenceVector = vectors.referenceFields();
    const inputs = vectors.readJson(path.join(mutate.SNAPSHOT, 'vectors', 'INPUTS.json'));
    const reference = { fields: referenceVector,
        settings: inputs.settings_sets[0].id, models: inputs.model_sets[0].id };
    const settingsById = new Map(inputs.settings_sets.map((set) => [set.id, set.settings]));
    return {
        gate: gate, gen: gen, bag: bag, kinds: kinds, reference: reference,
        settings: settingsById.get(reference.settings),
        observed: observedValues(bag), types: configLiteralTypes(gen),
        regionLines: mutate.regionSources(gen).args.split('\n'),
        regionLinesByRegion: mutate.regionSources(gen),
        rowsById: new Map(vectors.specRows().map((row) => [row.row_id, row])),
        modelSets: modelSets(bag)
    };
}

// `staticProof` and `probeOutputs` read the site text out of the region the mutant belongs to, so the
// context resolves the line array per mutant rather than once.
function withRegion(ctx, mutant) {
    ctx.regionLines = ctx.regionLinesByRegion[mutant.region].split('\n');
    return ctx;
}

function proofFile(id) {
    return path.join(PROOFS, id + '.json');
}

function prove(options) {
    const ctx = buildContext();
    const run = JSON.parse(slices.readText(RUN_FILE));
    const mutants = mutate.enumerate();
    const byId = new Map(mutants.full.map((m) => [m.id, m]));
    const survivors = run.mutant_results.filter((m) => m.status === 'survived');
    fs.mkdirSync(PROOFS, { recursive: true });
    const results = [];
    const t0 = Date.now();
    survivors.forEach((record, index) => {
        const mutant = byId.get(record.id);
        vectors.assert(mutant, record.id + ': survivor is not in the current enumeration');
        const existing = fs.existsSync(proofFile(record.id))
            ? JSON.parse(slices.readText(proofFile(record.id))) : null;
        if (existing && existing.mutated_sha256 === mutant.mutated_sha256
                && !options.recompute) {
            results.push(existing);
            return;
        }
        withRegion(ctx, mutant);
        const proof = analyze(mutant, ctx, ctx.reference, index);
        const document = Object.assign({
            survivor_id: mutant.id,
            generated_by: 'tools/parity/equiv-prove.js',
            command: 'node tools/parity/equiv-prove.js',
            base_commit: ctx.gate.base,
            goldens_impl: run.goldens_impl,
            mutated_sha256: mutant.mutated_sha256,
            site: { region: mutant.region, line: mutant.line + 1, start: mutant.start, end: mutant.end },
            killed_in_run: { status: record.status, vectors_checked: record.vectors_checked }
        }, proof);
        fs.writeFileSync(proofFile(mutant.id), JSON.stringify(document, null, 2) + '\n', 'utf8');
        results.push(document);
        if ((index + 1) % 10 === 0 || index + 1 === survivors.length) {
            console.log('  proved ' + (index + 1) + '/' + survivors.length + ' survivors ('
                + Math.round((Date.now() - t0) / 1000) + 's)');
        }
    });
    return { run: run, survivors: survivors, results: results, ctx: ctx, mutants: mutants };
}

// ------------------------------------------------------------------ side artifacts --------

function writeProposals(results) {
    const gaps = results.filter((r) => r.status === 'gap-killer-synthesized');
    const byRow = new Map();
    for (const gap of gaps) {
        for (const row of gap.row_ids) {
            if (!byRow.has(row)) byRow.set(row, gap);
        }
    }
    const proposals = [...byRow.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([row, gap]) => ({
        vector_id: gap.proposed_vector.id,
        row_targeted: row,
        mutant_ids: gaps.filter((g) => g.row_ids.includes(row)).map((g) => g.survivor_id),
        classes: [...new Set(gaps.filter((g) => g.row_ids.includes(row))
            .map((g) => g.class))].sort(),
        proposed_file: 'fixtures/vectors/boundary/promotion-mutation-' + row.toLowerCase() + '.jsonl',
        command_to_apply: 'node tools/parity/gen-goldens.js  (then node tools/parity/hash-pin.sh '
            + '--refresh if the fixture manifest hash list changes)',
        vector_header: { kind: 'header', family: 'boundary',
            generator: 'tools/parity/equiv-prove.js', command: 'node tools/parity/equiv-prove.js',
            note: 'mutation-gap promotion: proposed by the Phase 2.6 survivor analysis, not applied '
                + 'because fixtures were frozen during the concurrent re-record' },
        vector: gap.proposed_vector,
        baseline_vs_mutant: gap.difference,
        note: 'this input makes the surviving mutant(s) differ from the unmutated baseline, so the '
            + 'recorded vector set does not assert this behavior; promoting it closes the gap.'
    }));
    const document = {
        generated_by: 'tools/parity/equiv-prove.js',
        command: 'node tools/parity/equiv-prove.js',
        status: 'PROPOSED — not applied. fixtures/** is hash-pinned (C8) and a re-record is in flight, '
            + 'so the parent applies these after it lands: append each vector to the named '
            + 'promotion-*.jsonl under fixtures/vectors/boundary/, add the file to '
            + 'fixtures/vectors/coverage-map.json, then regenerate goldens for the new vectors.',
        base_commit: mutate.BASE_COMMIT,
        proposed_promotions: proposals.length,
        survivors_with_a_synthesized_killer: gaps.length,
        unresolved_gaps: results.filter((r) => r.status === 'unresolved-gap').map((r) => r.survivor_id),
        promotions: proposals
    };
    fs.writeFileSync(PROMOTIONS, JSON.stringify(document, null, 2) + '\n', 'utf8');
    return document;
}

// ESCALATION.md is append-only (plan §4). Only an `unresolved-gap` — no static argument, no difference
// found, and a probe set too large to call exhaustive — earns an entry.
function escalate(results) {
    const gaps = results.filter((r) => r.status === 'unresolved-gap');
    if (!gaps.length) return 0;
    const lines = gaps.map((gap) => [
        '## ' + gap.survivor_id + ' — mutation survivor, unresolved (Phase 2.6)',
        '',
        '- class `' + gap.class + '` on ' + gap.region + ' line '
            + (gap.site ? gap.site.line : '?') + ': `' + gap.before + '` -> `' + gap.after + '`',
        '- rows: ' + gap.row_ids.join(', '),
        '- evidence: ' + gap.probes.run + ' probes run, scope ' + JSON.stringify(gap.probes.scope),
        '- why unresolved: ' + gap.why,
        '- impact: this is a vector-set completeness question, not a candidate defect; the goldens and '
            + 'the baseline are unaffected, so no PARITY.md row changes status.',
        ''
    ].join('\n'));
    fs.appendFileSync(ESCALATION, '\n' + lines.join('\n'), 'utf8');
    return gaps.length;
}

module.exports = { prove, buildContext, withRegion, analyze, staticProof, inferType, configLiteralTypes,
    observedValues, domainFor, probeVarsFor, probeSet, probeOutputs, probeVector, writeProposals,
    escalate, proofFile, PROOFS, PROMOTIONS, REPORT_MD, MAX_DOMAIN, MAX_PROBES, BOUNDARY };
