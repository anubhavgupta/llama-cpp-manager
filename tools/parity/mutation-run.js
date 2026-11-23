#!/usr/bin/env node
'use strict'
// Phase 2.6 (plan.md §2): run every enumerated mutant against the recorded goldens.
//
//   node tools/parity/mutation-run.js                tiers + workers, resumable, writes run.json
//   node tools/parity/mutation-run.js --selftest     control: baseline reproduces every golden, and
//                                                    named mutants must die
//   node tools/parity/mutation-run.js --tier1 300 --workers 8 --rerun
//
// Resumable by design. Every verdict is appended to tools/parity/reports/mutation/results/<class>.jsonl
// the moment it is produced, one JSON object per line, before the next mutant starts; a restart re-reads
// those files — in the parent AND in each worker — and skips any mutant id whose recorded verdict carries
// the same mutated-source sha256. So the unit of work between disk writes is one mutant (0.3-3 s), never
// a batch, and an interrupted run loses at most the mutant in flight. `--rerun` ignores the recorded
// verdicts and recomputes them, which is how the run's own determinism is checked. At the end of a run
// each journal file is compacted to one line per mutant id, sorted.
//
// Vectors and goldens come from the private snapshot at tools/parity/reports/mutation/.snapshot/,
// byte-verified against the committed 9d6a767 state. fixtures/** is being re-recorded concurrently, so
// live fixtures/goldens are never read: a mutation baseline has to be frozen or its score is meaningless.
//
// Tiers (the plan's budget clause): tier 1 is the first `--tier1` vectors in canonical load order, so
// every boundary vector is in it. A mutant killed there is killed — a kill found early is still a kill —
// and only tier-1 survivors pay for the remaining vectors. A seeded 10% sample of the tier-1 kills is
// re-run over the full set as a control on that claim; a disagreement is an error, not a rounding note.
//
// Kill definition: the mutant's own channel (argv for the config/args regions, ini for the ini region —
// one region is mutated at a time, so the other generator stays bit-for-bit baseline) differs from the
// recorded golden. tools/parity/equivalence.js:compare is the comparator, the same one the candidate is
// judged with: argv positionally, ini as bytes, and a thrown message as output.
//
// Parallelism is by worker process; the parent is the only writer, and every artifact is assembled in
// mutant-id order, so sharding cannot reorder or duplicate a verdict.

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const os = require('os');

const slices = require('./baseline-slices.js');
const vectors = require('./gen-vectors.js');
const mutate = require('./mutate.js');
const equivalence = require('./equivalence.js');

const REPO = mutate.REPO;
const REPORTS = mutate.REPORTS;
const SNAPSHOT = mutate.SNAPSHOT;
const RESULTS = path.join(REPORTS, 'results');
const RUN_FILE = 'tools/parity/reports/mutation/run.json';
const DEFAULT_TIER1 = 300;
const SAMPLE_FRACTION = 0.1;
const SAMPLE_SEED = 20261126;
const PROGRESS_EVERY = 25;

// --------------------------------------------------------------------- inputs -------------

// Vectors paired with their goldens, read from the snapshot only. The pairing is positional and
// asserted: a golden that belongs to a different vector_id would silently turn every mutant green.
function loadSnapshot() {
    const bag = { vectors: [], goldens: new Map(), families: {}, impls: new Set() };
    for (const family of vectors.FAMILIES) {
        const vectorFile = path.join(SNAPSHOT, 'vectors', family, 'vectors.jsonl');
        const goldenFile = path.join(SNAPSHOT, 'goldens', family, 'goldens.jsonl');
        for (const file of [vectorFile, goldenFile]) {
            if (!fs.existsSync(file)) throw new Error('snapshot is missing ' + file);
        }
        const vectorLines = vectors.readJsonl(vectorFile);
        const header = vectorLines[0];
        const list = vectorLines.slice(1);
        vectors.assert(header.count === list.length, family + ': snapshot header count '
            + header.count + ' != ' + list.length + ' vectors');
        const goldenLines = vectors.readJsonl(goldenFile);
        vectors.assert(goldenLines[0].kind === 'header', family + ': snapshot goldens have no header');
        vectors.assert(goldenLines[0].count === list.length,
            family + ': snapshot golden count != vector count');
        bag.impls.add(goldenLines[0].impl);
        for (let index = 0; index < list.length; index += 1) {
            const vector = list[index];
            const golden = goldenLines[index + 1];
            vectors.assert(golden && golden.vector_id === vector.id,
                family + ': golden ' + index + ' is for ' + (golden && golden.vector_id)
                    + ' but the vector is ' + vector.id);
            bag.vectors.push(vector);
            bag.goldens.set(vector.id, golden);
        }
        bag.families[family] = list.length;
    }
    vectors.assert(bag.impls.size === 1, 'snapshot goldens name ' + bag.impls.size
        + ' different impls; the mutation baseline is one text');
    bag.impl = [...bag.impls][0];
    const inputs = vectors.readJson(path.join(SNAPSHOT, 'vectors', 'INPUTS.json'));
    bag.modelsById = new Map(inputs.model_sets.map((set) => [set.id, set.models]));
    bag.settingsById = new Map(inputs.settings_sets.map((set) => [set.id, set.settings]));
    return bag;
}

// Everything a vector needs, resolved once per process: the DOM-shaped fields map the launch path hands
// buildArgs, the settings blob, the /models payload, the saved configs the ini generator receives. None
// of it depends on the mutant; mutantRunner still rebuilds the config literal per mutant because a
// config-region mutant changes exactly that step.
function prepare(bag, gen) {
    return bag.vectors.map((vector) => ({
        vector: vector,
        golden: bag.goldens.get(vector.id),
        fields: vectors.argvFields(vector, gen),
        settings: bag.settingsById.get(vector.settings),
        models: bag.modelsById.get(vector.models),
        configs: vectors.iniConfigs(vector)
    }));
}

// One channel of one vector under one mutant, shaped like a golden so equivalence.compare accepts it.
// The untouched channel is copied from the golden, which is precisely the claim "this region cannot move
// that output".
function observe(runner, item, channel) {
    if (channel === 'argv') {
        try {
            const argv = runner.argv(item.fields, item.settings, item.models);
            if (!Array.isArray(argv)) {
                return { argv: null, argv_threw: 'returned ' + JSON.stringify(argv),
                    ini: item.golden.ini, ini_threw: item.golden.ini_threw };
            }
            return { argv: argv, argv_threw: null, ini: item.golden.ini,
                ini_threw: item.golden.ini_threw };
        } catch (error) {
            return { argv: null, argv_threw: String(error && error.message), ini: item.golden.ini,
                ini_threw: item.golden.ini_threw };
        }
    }
    try {
        const ini = runner.ini(item.configs, item.models);
        return { argv: item.golden.argv, argv_threw: item.golden.argv_threw,
            ini: ini === null ? null : Buffer.from(ini, 'utf8').toString('base64'), ini_threw: null };
    } catch (error) {
        return { argv: item.golden.argv, argv_threw: item.golden.argv_threw, ini: null,
            ini_threw: String(error && error.message) };
    }
}

// The first difference, or none. A mutant that throws is not skipped: the golden records the baseline's
// own throws, so a new throw — or a different message — is a behavior difference and therefore a kill.
function differs(mutant, item) {
    return equivalence.compare(item.golden, observe(mutant._runner, item, mutant.channel));
}

function checkMutant(gen, mutant, items, offset) {
    if (!mutant._runner) mutant._runner = mutate.mutantRunner(gen, mutant, [mutant]);
    for (let i = 0; i < items.length; i += 1) {
        const problems = differs(mutant, items[i]);
        if (problems.length) {
            return { status: 'killed', vector_id: items[i].vector.id, index: i + (offset || 0),
                problems: problems, checked: i + 1 };
        }
    }
    return { status: 'survived', vector_id: null, index: -1, problems: [], checked: items.length };
}

// Baseline control: the UNMUTATED slices through this runner's own observe/compare path, over every
// vector. If this is not empty the runner is not reproducing the recording harness, and every mutant
// verdict below it would be an artifact of the harness instead of a fact about the vectors.
function baselineControl(gen, items) {
    const runner = {
        argv: (fields, settings, models) => slices.runBaselineArgv(gen, fields, settings, models).args,
        ini: (configs, models) => slices.runBaselineIni(gen, configs, models)
    };
    const failures = [];
    for (const item of items) {
        for (const channel of ['argv', 'ini']) {
            const problems = equivalence.compare(item.golden, observe(runner, item, channel));
            if (problems.length) {
                failures.push({ vector_id: item.vector.id, channel: channel, problems: problems });
            }
        }
    }
    return failures;
}

// ------------------------------------------------------------------ verdict journal -------

// results/<class>.jsonl, one verdict per line, appended and flushed per mutant. Read back on restart so
// finished work is never repeated; a record whose mutated-source sha256 no longer matches the current
// enumeration is stale (the mutation moved) and is recomputed.
function resultFile(mutant) {
    return path.join(RESULTS, mutant.class + '.jsonl');
}

function readJournal(mutants) {
    const have = new Map();
    const classes = new Set(mutants.map((m) => m.class));
    for (const cls of [...classes].sort()) {
        const file = path.join(RESULTS, cls + '.jsonl');
        if (!fs.existsSync(file)) continue;
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            if (line.trim() === '') continue;
            let record;
            try { record = JSON.parse(line); } catch (error) { continue; }
            have.set(record.id, record);
        }
    }
    return have;
}

function appendVerdict(mutant, verdict) {
    const record = Object.assign({ id: mutant.id, class: mutant.class, region: mutant.region,
        channel: mutant.channel, row_ids: mutant.row_ids, mutated_sha256: mutant.mutated_sha256,
        before: mutant.before, after: mutant.after, line: mutant.line + 1 }, verdict);
    fs.mkdirSync(RESULTS, { recursive: true });
    fs.appendFileSync(resultFile(mutant), JSON.stringify(record) + '\n', 'utf8');
    return record;
}

// --------------------------------------------------------------------- worker -------------

function workerMain(job) {
    const gen = slices.slicedGenerators();
    const bag = loadSnapshot();
    const items = prepare(bag, gen);
    const tier1 = items.slice(0, job.tier1);
    const rest = items.slice(job.tier1);
    const all = mutate.enumerate().full;
    const journal = readJournal(all);
    const todo = all.filter((mutant, i) => {
        if (i % job.of !== job.shard) return false;
        const seen = journal.get(mutant.id);
        return !(seen && seen.mutated_sha256 === mutant.mutated_sha256);
    });
    // A worker that returns while IPC messages are still queued can exit before the parent has read
    // them, so every verdict is sent with a callback and the process only disconnects once the last
    // callback has fired. Without this the parent sees a clean exit 0 and a shortfall of verdicts.
    let inflight = 0;
    let finished = false;
    const send = (message) => {
        inflight += 1;
        process.send(message, () => {
            inflight -= 1;
            if (finished && inflight === 0) process.disconnect();
        });
    };
    for (const mutant of todo) {
        let result = checkMutant(gen, mutant, tier1, 0);
        let tier = 'tier1';
        if (result.status === 'survived') {
            const second = checkMutant(gen, mutant, rest, tier1.length);
            if (second.status === 'killed') {
                result = { status: 'killed', vector_id: second.vector_id, index: second.index,
                    problems: second.problems, checked: tier1.length + second.checked };
                tier = 'tier2';
            } else {
                result = { status: 'survived', vector_id: null, index: -1, problems: [],
                    checked: tier1.length + second.checked };
                tier = 'full';
            }
        }
        send({ id: mutant.id, status: result.status, tier: tier, vector_id: result.vector_id,
            first_killing_index: result.index, problems: result.problems.slice(0, 2),
            vectors_checked: result.checked });
    }
    finished = true;
    if (inflight === 0) process.disconnect();
}

// ---------------------------------------------------------------------- parent ------------

function options(argv) {
    const out = { tier1: DEFAULT_TIER1, workers: Math.max(1, Math.min(8, os.cpus().length - 2)),
        sample: SAMPLE_FRACTION, limit: 0 };
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === '--tier1') out.tier1 = Number(argv[i += 1]);
        else if (token === '--workers') out.workers = Number(argv[i += 1]);
        else if (token === '--sample') out.sample = Number(argv[i += 1]);
    }
    return out;
}

function runMain(options, rerun) {
    const t0 = Date.now();
    const gate = mutate.requireCommittedInputs();
    const gen = slices.slicedGenerators();
    const bag = loadSnapshot();
    const items = prepare(bag, gen);
    const list = mutate.enumerate();
    const all = list.full.slice(0, options.limit > 0 ? options.limit : list.full.length);
    vectors.assert(options.tier1 > 0 && options.tier1 < items.length,
        '--tier1 must be between 1 and ' + (items.length - 1));

    const control = baselineControl(gen, items);
    vectors.assert(control.length === 0, 'the runner does not reproduce the recording harness: '
        + control.length + ' vector(s) disagree with their own golden unmutated. First: '
        + (control[0] ? control[0].vector_id + ' ' + control[0].channel + ': ' + control[0].problems[0]
            : 'n/a'));
    console.log('baseline control: ' + items.length + ' vectors x 2 channels, 0 disagreements ['
        + ((Date.now() - t0) / 1000).toFixed(1) + 's]');

    const journal = rerun ? new Map() : readJournal(all);
    const pending = all.filter((mutant) => {
        const seen = journal.get(mutant.id);
        return !(seen && seen.mutated_sha256 === mutant.mutated_sha256);
    });
    console.log('mutants ' + all.length + ', ' + (all.length - pending.length) + ' already on disk ('
        + path.relative(REPO, RESULTS).split('\\').join('/') + '), ' + pending.length + ' to run');

    const verdicts = new Map();
    for (const mutant of all) {
        const seen = journal.get(mutant.id);
        if (seen && seen.mutated_sha256 === mutant.mutated_sha256) verdicts.set(mutant.id, seen);
    }

    const shardCount = Math.max(1, Math.min(options.workers, pending.length));
    let started = 0;
    return new Promise((resolve, reject) => {
        if (pending.length === 0) {
            resolve(finish(options, gen, bag, items, list, all, verdicts, t0, gate, 0, ''));
            return;
        }
        let open = shardCount;
        let stderr = '';
        for (let shard = 0; shard < shardCount; shard += 1) {
            const child = fork(__filename, ['--shard', String(shard), '--of', String(shardCount),
                '--tier1', String(options.tier1)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
            child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
            child.on('message', (message) => {
                const mutant = list.full.find((m) => m.id === message.id);
                vectors.assert(mutant, 'worker reported an unknown mutant ' + message.id);
                verdicts.set(message.id, appendVerdict(mutant, message));
                started += 1;
                if (started % PROGRESS_EVERY === 0 || started === pending.length) {
                    console.log('  ' + started + '/' + pending.length + ' mutants this run, '
                        + [...verdicts.values()].filter((v) => v.status === 'survived').length
                        + ' survivors so far (' + Math.round((Date.now() - t0) / 1000) + 's)');
                }
            });
            child.on('exit', (code) => {
                if (code !== 0) {
                    reject(new Error('worker ' + shard + ' exited ' + code + ': '
                        + stderr.slice(0, 1500)));
                    return;
                }
                open -= 1;
                if (open === 0) {
                    // Completion pass: verdicts the workers did not deliver are computed here, serially,
                    // one append each. Cheaper to redo a shortfall than to trust a score with holes in it.
                    const missing = all.filter((mutant) => !verdicts.has(mutant.id));
                    if (missing.length) {
                        console.log('  ' + missing.length + ' verdict(s) missing from the workers; '
                            + 'recomputing serially');
                    }
                    missing.forEach((mutant, n) => {
                        const tier1 = items.slice(0, options.tier1);
                        let result = checkMutant(gen, mutant, tier1, 0);
                        let tier = 'tier1';
                        if (result.status === 'survived') {
                            const second = checkMutant(gen, mutant, items.slice(options.tier1),
                                tier1.length);
                            tier = second.status === 'killed' ? 'tier2' : 'full';
                            result = {
                                status: second.status, vector_id: second.vector_id,
                                index: second.index, problems: second.problems,
                                checked: tier1.length + second.checked
                            };
                        }
                        verdicts.set(mutant.id, appendVerdict(mutant, {
                            id: mutant.id, status: result.status, tier: tier,
                            vector_id: result.vector_id, first_killing_index: result.index,
                            problems: result.problems.slice(0, 2), vectors_checked: result.checked
                        }));
                        if ((n + 1) % PROGRESS_EVERY === 0 || n + 1 === missing.length) {
                            console.log('  recomputed ' + (n + 1) + '/' + missing.length);
                        }
                    });
                    resolve(finish(options, gen, bag, items, list, all, verdicts, t0, gate, shardCount,
                        stderr));
                }
            });
        }
    });
}

// The tier control the plan asks for: re-run a seeded 10% sample of the tier-1 kills over the FULL set
// and require the same verdict. Each probe is appended to results/verification.jsonl as it completes, so
// even this control is resumable.
function verifyTierSample(options, gen, items, all, verdicts) {
    const file = path.join(RESULTS, 'verification.jsonl');
    const done = new Map();
    if (fs.existsSync(file)) {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            if (line.trim() === '') continue;
            try { const row = JSON.parse(line); done.set(row.id, row); } catch (error) { /* skip */ }
        }
    }
    const killedTier1 = all.filter((m) => (verdicts.get(m.id) || {}).status === 'killed'
        && (verdicts.get(m.id) || {}).tier === 'tier1');
    const size = Math.min(killedTier1.length, Math.ceil(killedTier1.length * options.sample));
    const random = vectors.rng(SAMPLE_SEED);
    const pool = killedTier1.slice();
    for (let i = pool.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        const swap = pool[i];
        pool[i] = pool[j];
        pool[j] = swap;
    }
    const sample = pool.slice(0, size);
    const rows = [];
    fs.mkdirSync(RESULTS, { recursive: true });
    sample.forEach((mutant, n) => {
        let row = done.get(mutant.id);
        if (!row || row.mutated_sha256 !== mutant.mutated_sha256) {
            const full = checkMutant(gen, mutant, items, 0);
            row = { id: mutant.id, mutated_sha256: mutant.mutated_sha256, full_status: full.status,
                vector_id: full.vector_id };
            fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
        }
        rows.push(row);
        vectors.assert(row.full_status === 'killed', 'tier/verification disagreement for ' + mutant.id
            + ': killed on tier1 but ' + row.full_status + ' over all ' + items.length + ' vectors');
        if ((n + 1) % PROGRESS_EVERY === 0) console.log('  verified ' + (n + 1) + '/' + rows.length);
    });
    return { sample_fraction: options.sample, pool: killedTier1.length, sample_size: rows.length,
        seed: SAMPLE_SEED, disagreements: rows.filter((r) => r.full_status !== 'killed').length };
}

// One line per mutant id, sorted, rewritten after a run: the journal is a work log whose appends may
// predate a re-run, and run.json is the artifact that carries the verdicts. A 1:1 journal keeps
// `which mutants were measured, and how` answerable from the directory alone.
function compactJournal(mutants) {
    const byClass = new Map();
    for (const cls of new Set(mutants.map((m) => m.class))) byClass.set(cls, []);
    for (const file of fs.existsSync(RESULTS) ? fs.readdirSync(RESULTS) : []) {
        if (!/\.jsonl$/.test(file) || file === 'verification.jsonl') continue;
        const lines = fs.readFileSync(path.join(RESULTS, file), 'utf8').split('\n')
            .filter((line) => line.trim() !== '');
        const latest = new Map();
        for (const line of lines) {
            try { latest.set(JSON.parse(line).id, line); } catch (error) { /* skip */ }
        }
        const cls = file.replace(/\.jsonl$/, '');
        if (!byClass.has(cls)) continue;
        byClass.set(cls, [...latest.entries()].sort((a, b) => a[0].localeCompare(b[0]))
            .map((entry) => entry[1]));
    }
    for (const [cls, lines] of byClass) {
        fs.writeFileSync(path.join(RESULTS, cls + '.jsonl'), lines.join('\n') + '\n', 'utf8');
    }
}

function finish(options, gen, bag, items, list, all, verdicts, t0, gate, shardCount, stderr) {
    const tier1Count = Math.min(options.tier1, items.length);
    const control = verifyTierSample(options, gen, items, all, verdicts);

    const mutants = all.map((mutant) => {
        const v = verdicts.get(mutant.id);
        vectors.assert(v, 'no verdict for mutant ' + mutant.id);
        return { id: mutant.id, class: mutant.class, region: mutant.region, channel: mutant.channel,
            row_ids: mutant.row_ids, kinds: mutant.kinds, before: mutant.before, after: mutant.after,
            line: mutant.line + 1, status: v.status, killed_on_tier: v.tier,
            killing_vector_ids: v.status === 'killed' ? [v.vector_id] : [],
            first_killing_index: v.first_killing_index, vectors_checked: v.vectors_checked,
            first_problem: v.problems && v.problems.length ? v.problems[0] : null };
    }).sort((a, b) => a.id.localeCompare(b.id));

    const survivors = mutants.filter((m) => m.status === 'survived');
    const byClass = {};
    for (const mutant of mutants) {
        byClass[mutant.class] = byClass[mutant.class] || { mutants: 0, killed: 0, survived: 0 };
        byClass[mutant.class].mutants += 1;
        byClass[mutant.class][mutant.status] += 1;
    }
    const byRow = {};
    for (const mutant of mutants) {
        for (const row of mutant.row_ids) {
            byRow[row] = byRow[row] || { mutants: 0, killed: 0, survived: 0, survivor_ids: [] };
            byRow[row].mutants += 1;
            byRow[row][mutant.status] += 1;
            if (mutant.status === 'survived') byRow[row].survivor_ids.push(mutant.id);
        }
    }
    const snapshotManifest = JSON.parse(slices.readText(path.join(SNAPSHOT, 'SNAPSHOT.json')));
    const document = {
        generated_by: 'tools/parity/mutation-run.js',
        command: 'node tools/parity/mutation-run.js --tier1 ' + options.tier1 + ' --workers '
            + options.workers,
        base_commit: gate.base,
        goldens_impl: bag.impl,
        snapshot: { dir: 'tools/parity/reports/mutation/.snapshot',
            files: snapshotManifest.files.length, taken_from_commit: snapshotManifest.taken_from_commit,
            mismatched_against_commit: snapshotManifest.files.filter((f) => !f.matches_9d6a767).length },
        vectors: { total: items.length, tier1: tier1Count, rest: items.length - tier1Count },
        mutants: { enumerated: list.mutants.length, run: mutants.length,
            killed: mutants.filter((m) => m.status === 'killed').length, survived: survivors.length,
            score: (100 * mutants.filter((m) => m.status === 'killed').length / mutants.length)
                .toFixed(2) + '%',
            by_class: byClass,
            by_tier: mutants.reduce((acc, m) => {
                acc[m.killed_on_tier] = (acc[m.killed_on_tier] || 0) + 1;
                return acc;
            }, {}) },
        tier_control: control,
        runtime_ms: Date.now() - t0,
        workers: shardCount,
        rows: byRow,
        survivor_ids: survivors.map((m) => m.id),
        mutant_results: mutants
    };
    fs.mkdirSync(REPORTS, { recursive: true });
    compactJournal(all);
    fs.writeFileSync(path.join(REPO, RUN_FILE), JSON.stringify(document, null, 2) + '\n', 'utf8');
    if (stderr.trim()) process.stderr.write(stderr);
    console.log('mutants ' + mutants.length + '  killed ' + document.mutants.killed + '  survived '
        + survivors.length + '  score ' + document.mutants.score);
    console.log('tiers: ' + (document.mutants.by_tier.tier1 || 0) + ' killed on tier1 (' + tier1Count
        + ' vectors), ' + (document.mutants.by_tier.tier2 || 0) + ' killed only on the rest, '
        + (document.mutants.by_tier.full || 0) + ' survived everything');
    console.log('tier control: ' + control.sample_size + '/' + control.pool + ' seeded tier-1 kills'
        + ' re-run over all ' + items.length + ' vectors, ' + control.disagreements + ' disagreement(s)');
    console.log('runtime ' + ((Date.now() - t0) / 1000).toFixed(1) + 's, ' + shardCount
        + ' worker process(es)');
    console.log('wrote ' + RUN_FILE);
    return document;
}

// ------------------------------------------------------------------- selftest -------------

// Two controls before any mutant verdict is trusted:
//  1. the unmutated slices, through this runner's own observe/compare path, reproduce every golden;
//  2. named mutants — one per region and one per class family — are killed by the vector set.
const NAMED_KILLS = [
    { region: 'args', needle: 'if (config.ngl >= 0) {', why: 'the -ngl guard, relational boundary' },
    { region: 'args', needle: "args.push('--backend-samplingX');", why: 'a flag string literal' },
    { region: 'ini', needle: 'if (config.temp !== undefined && config.temp > 0) {',
        why: 'the ini temp guard, relational boundary' },
    { region: 'config', needle: 'ngl: !(parseInt(nglInput.value)) || 0,',
        why: 'the ngl config literal, negation' }
];

function selftest(options) {
    const t0 = Date.now();
    mutate.requireCommittedInputs();
    const gen = slices.slicedGenerators();
    const b = loadSnapshot();
    const items = prepare(b, gen);
    const failures = baselineControl(gen, items);
    console.log('baseline control: ' + items.length + ' vectors x 2 channels, ' + failures.length
        + ' disagreement(s) with the recorded goldens [' + (failures.length ? 'RED' : 'GREEN') + ']');
    for (const failure of failures.slice(0, 3)) {
        console.log('  ' + failure.vector_id + ' ' + failure.channel + ': ' + failure.problems[0]);
    }
    const list = mutate.enumerate();
    let red = failures.length;
    for (const named of NAMED_KILLS) {
        const mutant = list.full.find((m) => m.region === named.region
            && m.mutated.includes(named.needle));
        if (!mutant) {
            console.log('  MISSING expected mutant: ' + named.region + ' -> ' + named.needle);
            red += 1;
            continue;
        }
        const result = checkMutant(gen, mutant, items.slice(0, options.tier1), 0);
        console.log('  ' + (result.status === 'killed' ? 'killed  ' : 'SURVIVED') + ' ' + mutant.id
            + ' (' + named.why + ') — ' + (result.vector_id || 'no vector') + ' at index '
            + result.index);
        if (result.status !== 'killed') red += 1;
    }
    console.log('selftest: ' + list.mutants.length + ' mutants enumerated, ' + ((Date.now() - t0) / 1000)
        .toFixed(1) + 's');
    console.log(red ? 'MUTATION-RUN RED (' + red + ')' : 'MUTATION-RUN SELFTEST GREEN');
    process.exitCode = red ? 1 : 0;
    return red;
}

function main() {
    const argv = process.argv.slice(2);
    if (argv.indexOf('--shard') >= 0) {
        const parsed = options(argv);
        workerMain({ shard: Number(argv[argv.indexOf('--shard') + 1]),
            of: Number(argv[argv.indexOf('--of') + 1]), tier1: parsed.tier1 });
        return;
    }
    if (argv.indexOf('--selftest') >= 0) {
        selftest(options(argv));
        return;
    }
    runMain(options(argv), argv.indexOf('--rerun') >= 0).catch((error) => {
        console.error(String((error && error.stack) || error));
        process.exitCode = 1;
    });
}

module.exports = { loadSnapshot, prepare, observe, checkMutant, baselineControl, runMain, selftest,
    options, readJournal, appendVerdict, compactJournal, verifyTierSample, NAMED_KILLS, SNAPSHOT,
    RESULTS, RUN_FILE };

if (require.main === module) main();
