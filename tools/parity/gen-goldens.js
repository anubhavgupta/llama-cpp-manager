#!/usr/bin/env node
'use strict';
// Phase 2.4 (plan.md §2): record the goldens. Every vector is run through the BASELINE inline
// blocks sliced out of `git show parity-baseline:public/script.js` by tools/parity/baseline-slices.js
// — never through legacy/lib. A golden therefore IS legacy output (C5), and legacy/lib is what gets
// put on trial against it (tools/parity/equivalence.js).
//
//   node tools/parity/gen-goldens.js           record fixtures/goldens/** + fixtures/vectors/MANIFEST.json
//   node tools/parity/gen-goldens.js --check   fail if the committed goldens are not what this run
//                                              produces (determinism gate)
//
// One golden per vector: {vector_id, impl, argv, ini}. `argv` is the ordered array (order is part of
// the contract); `ini` is base64 of the exact bytes buildPresetIni returns for the vector's saved
// configs. The inline `port = ${settings.serverPort}` line is NOT in those bytes: in
// launchModelPresets it is appended after showOutput, so it is outside the ini block at baseline and
// outside legacy/lib/buildPresetIni.js today. Recording it here would make the golden test something
// other than the generator.
//
// Determinism: no timestamps, no Date, no Math.random. The baseline commit sha is read from git and
// recorded in every header, so a golden names the exact text that produced it.

const path = require('path');
const { execFileSync } = require('child_process');

const slices = require('./baseline-slices.js');
const vectors = require('./gen-vectors.js');

const REPO = slices.REPO;
const GOLDEN_REGEN = 'node tools/parity/gen-goldens.js';

function baselineSha() {
    // A tag object sha would name the tag, not the text: the golden must name the commit whose
    // script.js was sliced.
    return execFileSync('git', ['rev-parse', 'parity-baseline^{commit}'], { cwd: REPO })
        .toString('utf8').trim();
}

// vector -> {argv, ini}. Both generators run on the SAME vector: buildArgs on the fields map (the
// DOM-shaped view the launch path hands it), buildPresetIni on the saved config keyed by the config
// name, which is why the ini section order is the saved-config insertion order (plan §9 trap 6).
//
// A generator may THROW, and that is recorded rather than avoided. buildPresetIni has no guard on
// `config.modelPath.replace` behind `if (config.loadCustomChatTemplate)`, so a saved config with the
// checkbox on and no modelPath crashes it — launchModelPresets catches and prints
// `'Error launching model presets: ' + error.message`, which makes the message user-visible output
// (plan §9 trap 2 logic: what the pane prints is the contract). C4: the throw is the behavior.
const REPRESENTABLE = (value) => value === null
    || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

function record(gen, vector, models, settings) {
    let argv = null;
    let argvThrew = null;
    try {
        argv = slices.runBaselineArgv(gen, vectors.argvFields(vector, gen), settings, models).args;
    } catch (error) {
        argvThrew = String(error && error.message);
    }
    if (argvThrew === null && !Array.isArray(argv)) {
        throw new Error(vector.id + ': the baseline argv generator returned ' + JSON.stringify(argv));
    }
    if (argv && !argv.every(REPRESENTABLE)) {
        throw new Error(vector.id + ': argv carries a value JSON cannot hold: '
            + JSON.stringify(argv.find((item) => !REPRESENTABLE(item))));
    }
    let ini = null;
    let iniThrew = null;
    try {
        ini = slices.runBaselineIni(gen, vectors.iniConfigs(vector), models);
    } catch (error) {
        iniThrew = String(error && error.message);
    }
    return { argv: argv, argv_threw: argvThrew,
        ini: ini === null ? null : Buffer.from(ini, 'utf8').toString('base64'),
        ini_threw: iniThrew };
}

function build() {
    const gen = slices.slicedGenerators();
    const impl = 'parity-baseline@' + baselineSha();
    const inputs = vectors.readJson(path.join(vectors.VECTORS, 'INPUTS.json'));
    const modelsById = new Map(inputs.model_sets.map((set) => [set.id, set.models]));
    const settingsById = new Map(inputs.settings_sets.map((set) => [set.id, set.settings]));
    const files = new Map();
    const summary = [];

    for (const family of vectors.FAMILIES) {
        const relFile = family + '/vectors.jsonl';
        const lines = vectors.readJsonl(path.join(vectors.VECTORS, relFile));
        const header = lines[0];
        const list = lines.slice(1);
        if (header.count !== list.length) {
            vectors.assert(false, relFile + ' header count ' + header.count + ' != ' + list.length + ' vectors');
        }
        const out = [JSON.stringify({
            kind: 'header', family: family, generator: 'tools/parity/gen-goldens.js',
            command: GOLDEN_REGEN, impl: impl, vectors_file: 'fixtures/vectors/' + relFile,
            vectors_sha256: slices.sha256(
                slices.readText(path.join(vectors.VECTORS, relFile))),
            count: list.length,
            ini_note: 'ini is base64 of the bytes the generator returns; the inline '
                + '`port = ${settings.serverPort}` append lives outside both the baseline slice and '
                + 'legacy/lib/buildPresetIni.js',
            throw_note: 'argv/ini are null with argv_threw/ini_threw set when the baseline generator '
                + 'throws; launchModelPresets/launchServer print error.message into the log pane, so '
                + 'the message is user-visible output the candidate must reproduce'
        })];
        let argvItems = 0;
        let throws = 0;
        for (const vector of list) {
            const models = modelsById.get(vector.models);
            const settings = settingsById.get(vector.settings);
            if (!models) vectors.assert(false, vector.id + ': unknown models set ' + vector.models);
            if (!settings) vectors.assert(false, vector.id + ': unknown settings set ' + vector.settings);
            const gold = record(gen, vector, models, settings);
            argvItems += gold.argv ? gold.argv.length : 0;
            throws += (gold.argv_threw ? 1 : 0) + (gold.ini_threw ? 1 : 0);
            out.push(JSON.stringify({ kind: 'golden', vector_id: vector.id, impl: impl,
                argv: gold.argv, ini: gold.ini,
                ...(gold.argv_threw ? { argv_threw: gold.argv_threw } : {}),
                ...(gold.ini_threw ? { ini_threw: gold.ini_threw } : {}) }));
        }
        files.set(family + '/goldens.jsonl', out.join('\n'));
        summary.push({ family: family, count: list.length, argvItems: argvItems, throws: throws });
    }
    return { files, impl, summary };
}

// fixtures/vectors/MANIFEST.json: every vectors + goldens file, its sha256, and the exact command
// that regenerates it. This is the artifact an Auditor re-checks without rerunning anything.
function manifest() {
    const list = [];
    for (const family of vectors.FAMILIES) {
        list.push({ file: 'fixtures/vectors/' + family + '/vectors.jsonl',
            command: vectors.REGEN, sha256: vectors.sha256(
                slices.readText(path.join(vectors.VECTORS, family, 'vectors.jsonl'))) });
    }
    for (const file of ['INPUTS.json', 'coverage-map.json', 'coverage-exceptions.json', 'README.md']) {
        list.push({ file: 'fixtures/vectors/' + file, command: vectors.REGEN, sha256: vectors.sha256(
            slices.readText(path.join(vectors.VECTORS, file))) });
    }
    for (const family of vectors.FAMILIES) {
        list.push({ file: 'fixtures/goldens/' + family + '/goldens.jsonl', command: GOLDEN_REGEN,
            sha256: vectors.sha256(slices.readText(path.join(vectors.GOLDENS, family,
                'goldens.jsonl'))) });
    }
    list.push({ file: 'fixtures/vectors/MANIFEST.json', command: GOLDEN_REGEN + ' (writes this file)',
        sha256: null, note: 'a manifest cannot carry its own hash; every other entry is checkable' });
    return JSON.stringify({
        generated_by: 'tools/parity/gen-goldens.js', command: GOLDEN_REGEN,
        impl: 'parity-baseline@' + baselineSha(),
        note: 'sha256 of every committed vector and golden file, with the command that regenerates '
            + 'it. Goldens are recorded from the baseline inline blocks (C5); rerunning the command '
            + 'must reproduce these bytes (gen-vectors.js --check, gen-goldens.js --check).',
        files: list
    }, null, 2);
}

// A manifest nobody checks is a list of claims. --check recomputes every entry and requires the
// governed directories to hold nothing that the manifest does not name, so neither a hand-edit nor a
// new unlisted file can slip through.
function checkManifest() {
    const fs = require('fs');
    const file = path.join(vectors.VECTORS, 'MANIFEST.json');
    if (!fs.existsSync(file)) return { problems: ['MANIFEST.json is missing'], checked: 0 };
    const problems = [];
    const listed = vectors.readJson(file);
    const byFile = new Map(listed.files.map((entry) => [entry.file, entry]));
    let checked = 0;
    for (const entry of listed.files) {
        if (entry.sha256 === null) continue;
        const target = path.join(process.cwd(), entry.file);
        if (!fs.existsSync(target)) {
            problems.push(entry.file + ': listed but missing on disk');
            continue;
        }
        const have = vectors.sha256(slices.readText(target));
        checked += 1;
        if (have !== entry.sha256) {
            problems.push(entry.file + ': sha256 ' + have.slice(0, 12) + ' != manifest '
                + entry.sha256.slice(0, 12));
        }
    }
    for (const rel of dataFiles()) {
        if (!byFile.has(rel)) problems.push(rel + ': on disk but not in the manifest');
    }
    return { problems: problems, checked: checked };
}

// Every fixture data file the manifest is responsible for (README.md is prose, but it is hashed too,
// because it states the invariants the data is supposed to satisfy).
function dataFiles() {
    const fs = require('fs');
    const out = [];
    for (const dir of [vectors.VECTORS, vectors.GOLDENS]) {
        const walk = (current) => {
            if (!fs.existsSync(current)) return;
            for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (/\.(jsonl|json|md)$/.test(entry.name) && entry.name !== 'MANIFEST.json') {
                    out.push(path.relative(process.cwd(), full).split('\\').join('/'));
                }
            }
        };
        walk(dir);
    }
    return out;
}

function main() {
    const check = process.argv.indexOf('--check') >= 0;
    const built = build();
    if (check) {
        const fs = require('fs');
        const stale = [];
        for (const [relFile, content] of built.files) {
            const file = path.join(vectors.GOLDENS, relFile);
            if (!fs.existsSync(file) || slices.readText(file) !== content + '\n') stale.push(relFile);
        }
        for (const relFile of stale) console.log('STALE ' + relFile);
        const manifest = checkManifest();
        for (const problem of manifest.problems) console.log('MANIFEST ' + problem);
        console.log('MANIFEST: ' + (manifest.problems.length ? 'PROBLEMS'
            : 'VERIFIED ' + manifest.checked + ' entries'));
        const red = stale.length + manifest.problems.length;
        console.log(red ? 'GOLDENS STALE (' + stale.length + ' stale file(s), ' + manifest.problems.length
            + ' manifest problem(s))' : 'GOLDENS REPRODUCIBLE');
        process.exitCode = red ? 1 : 0;
        return;
    }
    const fs = require('fs');
    for (const [relFile, content] of built.files) {
        const file = path.join(vectors.GOLDENS, relFile);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content + '\n', 'utf8');
    }
    fs.writeFileSync(path.join(vectors.VECTORS, 'MANIFEST.json'), manifest() + '\n', 'utf8');
    for (const row of built.summary) {
        console.log('goldens ' + row.family + ': ' + row.count + ' vectors, ' + row.argvItems
            + ' argv items, ' + row.throws + ' recorded generator throws');
    }
    console.log('impl ' + built.impl);
    console.log('MANIFEST.json written (fixtures/vectors/MANIFEST.json)');
}

module.exports = { build, manifest, record, baselineSha, checkManifest, dataFiles, GOLDEN_REGEN };

if (require.main === module) main();
