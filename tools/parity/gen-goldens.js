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
const fs = require('fs');
const { execFileSync } = require('child_process');

const slices = require('./baseline-slices.js');
const vectors = require('./gen-vectors.js');

const REPO = slices.REPO;
const GOLDEN_REGEN = 'node tools/parity/gen-goldens.js';
const PROMOTED_REGEN = 'node tools/parity/equiv-prove.js --apply (append-only promotion; the goldens '
    + 'are recorded from parity-baseline by gen-goldens.js record)';

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

// fixtures/goldens/resave: the browser-side (L2) golden family.
//
// The generator families answer "what do the inline blocks produce from a SAVED config". The browser
// answers a different question — what does the page post after `loadConfiguration` has run that
// config through the DOM — and for 28 of the 48 corpus configs the answers differ (Q17/Q18/Q19; the
// per-config table is tests/L2-ui/DISAGREEMENTS.md). This family records the browser-side answer.
//
// Its inputs are recorded from the parity-baseline page by tests/L2-ui/record-inputs.js: the DOM
// state loadConfiguration produced, the saved configs the page held, and the localStorage bytes /
// POST /start argv / native dialog text the page produced when it was clicked. Goldens are composed
// from those recorded inputs with the same pinned baseline slices every other family uses, and every
// composition is cross-checked against the recorded baseline output of the same session: a mismatch
// throws here instead of becoming a golden (C4/C5).
const RESAVE = 'resave';
const RESAVE_INPUTS = 'fixtures/goldens/resave/inputs.jsonl';
const RESAVE_RECORD = 'node tests/L2-ui/record-inputs.js';
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

function resaveInputs() {
    const file = path.join(REPO, RESAVE_INPUTS);
    if (!fs.existsSync(file)) return null;
    const lines = vectors.readJsonl(file);
    const header = lines[0];
    vectors.assert(header && header.kind === 'header' && header.role === 'inputs',
        RESAVE_INPUTS + ' has no inputs header row');
    if (!header.complete) {
        vectors.assert(false, RESAVE_INPUTS + ' is a partial recording (complete: false) — rerun '
            + RESAVE_RECORD);
    }
    const rows = lines.filter((row) => row.kind === 'input');
    vectors.assert(header.count === rows.length,
        RESAVE_INPUTS + ' header count ' + header.count + ' != ' + rows.length + ' input rows');
    return { header, rows };
}

function buildResave(gen, impl) {
    const inputs = resaveInputs();
    if (!inputs) return null;
    const kinds = slices.fieldKinds();
    const settings = JSON.parse(slices.readText(path.join(REPO, 'fixtures', 'corpus',
        'settings.remapped.json')));
    const models = inputs.header.models_corpus && inputs.header.models_corpus.models;
    vectors.assert(Array.isArray(models) && models.length > 0,
        RESAVE_INPUTS + ' header carries no models_corpus list — rerun ' + RESAVE_RECORD);
    const by = (op, mode) => new Map(inputs.rows.filter((row) => row.op === op
        && (!mode || row.mode === mode)).map((row) => [row.name, row]));
    const launched = by('launch', 'corpus');
    const blocked = by('alert-blocked', 'recorded');
    const resaved = by('resave');
    const edge = by('resave-edge');
    const created = by('create');

    const out = [JSON.stringify({
        kind: 'header', family: RESAVE, role: 'browser-side goldens for tests/L2-ui',
        generator: 'tools/parity/gen-goldens.js', command: GOLDEN_REGEN, record_command: RESAVE_RECORD,
        impl: impl, inputs_file: RESAVE_INPUTS,
        inputs_sha256: vectors.sha256(slices.readText(path.join(REPO, RESAVE_INPUTS))),
        models_corpus_sha256: vectors.sha256(JSON.stringify(models)),
        count: resaved.size + edge.size + blocked.size + created.size,
        op_note: 'op=resave carries saved_config + saved_field_order + the exact localStorage bytes '
            + 'the composition wrote (storage_expected) and the baseline page wrote (storage_actual); '
            + 'op=launch-side values (argv, serverPath, serverPort) are composed from the recorded DOM '
            + 'state and cross-checked against the recorded POST /start bytes; op=create and '
            + 'op=alert-blocked are recorded-only (create is written by saveConfiguration, not '
            + 'saveCurrentValues; alert-blocked configs never posted anything, so argv is null and the '
            + 'recorded native dialog text is the expectation)',
        edge_note: 'op=resave-edge is the save-channel kill input for the mutation inventory: the same '
            + 'baseline re-save with form values the 48 real configs never produce (every numeric field '
            + 'emptied, chat-template kwargs filled). Composed and cross-checked exactly like op=resave, '
            + 'but it drives no launch, so it carries no argv. tools/parity/mutation-run.js scores the '
            + '`save` region over op=resave + op=resave-edge.',
        ini_note: 'ini is base64 of a single-config ini built from the saved config (ini_from_saved), '
            + 'and ini_after_resave the same bytes rebuilt from the entry the re-save wrote — the '
            + 'difference is Q16 (orphan keys dropped, loadMode/reasoning migrated in)'
    })];

    let argvItems = 0;
    let iniChanges = 0;
    for (const [name, row] of resaved) {
        const fields = slices.fieldsFromControls(row.form, kinds);
        const composed = slices.runBaselineSave(gen, fields,
            JSON.parse(JSON.stringify(row.configurations)), row.configId);
        vectors.assert(composed.written.length === 1, name + ': the save slice wrote '
            + composed.written.length + ' times, expected one saveConfigurations() call');
        vectors.assert(composed.written[0] === row.storage_after, name
            + ': the composed localStorage bytes are not the bytes the baseline page wrote\n'
            + slices.firstLineDiff(composed.written[0], row.storage_after));
        const savedEntry = composed.configs[name];
        vectors.assert(Object.keys(savedEntry).join('|') === row.saved_field_order.join('|'),
            name + ': the composed saved-field order is not the recorded one');
        const launch = launched.get(name);
        vectors.assert(!!launch, name + ': recorded re-save without a recorded browser launch');
        const argv = slices.runBaselineArgv(gen, slices.fieldsFromControls(launch.form, kinds),
            settings, models).args;
        vectors.assert(JSON.stringify(argv) === JSON.stringify(launch.argv),
            name + ': the argv composed from the recorded DOM state is not the argv the baseline '
            + 'browser posted\n' + slices.firstLineDiff(JSON.stringify(argv), JSON.stringify(launch.argv)));
        const ini = b64(slices.runBaselineIni(gen, { [name]: row.configurations[name] }, models));
        const iniAfter = b64(slices.runBaselineIni(gen, { [name]: savedEntry }, models));
        if (ini !== iniAfter) iniChanges += 1;
        argvItems += argv.length;
        out.push(JSON.stringify({
            kind: 'golden', family: RESAVE, op: 'resave', name: name, impl: impl,
            input_form_sha256: row.form_sha, input_configurations_sha256: row.configurations_sha,
            launch_form_sha256: launch.form_sha,
            saved_config: JSON.stringify(savedEntry), saved_field_order: Object.keys(savedEntry),
            storage_expected: composed.written[0], storage_actual: row.storage_after,
            argv: argv, argv_recorded_sha256: vectors.sha256(JSON.stringify(launch.argv)),
            serverPath: launch.serverPath, serverPort: launch.serverPort,
            ini_from_saved: ini, ini_after_resave: iniAfter,
            dialogs: launch.dialogs || []
        }));
    }
    for (const [name, row] of edge) {
        // The edge rows exist for the save channel only: composed from the recorded DOM state with the
        // same pinned slice, and cross-checked against the bytes the baseline page wrote in that same
        // session, so a save-region mutant is scored against legacy output rather than against a guess.
        const fields = slices.fieldsFromControls(row.form, kinds);
        const composed = slices.runBaselineSave(gen, fields,
            JSON.parse(JSON.stringify(row.configurations)), row.configId);
        vectors.assert(composed.written.length === 1, name + ': the edge save slice wrote '
            + composed.written.length + ' times, expected one saveConfigurations() call');
        vectors.assert(composed.written[0] === row.storage_after, name
            + ': the composed edge localStorage bytes are not the bytes the baseline page wrote\n'
            + slices.firstLineDiff(composed.written[0], row.storage_after));
        const savedEntry = composed.configs[row.configId];
        vectors.assert(Object.keys(savedEntry).join('|') === row.saved_field_order.join('|'),
            name + ': the composed edge saved-field order is not the recorded one');
        out.push(JSON.stringify({
            kind: 'golden', family: RESAVE, op: 'resave-edge', name: name, impl: impl,
            config_id: row.configId, label: row.label,
            input_form_sha256: row.form_sha, input_configurations_sha256: row.configurations_sha,
            saved_config: JSON.stringify(savedEntry), saved_field_order: Object.keys(savedEntry),
            storage_expected: composed.written[0], storage_actual: row.storage_after
        }));
    }
    for (const [name, row] of created) {
        // The create path is recorded, not composed: `saveCurrentValues(configId)` returns immediately
        // without a configId, so a new entry is written by saveConfiguration() — a different function,
        // outside the pinned slices. The recorded bytes are still legacy output (C5).
        const written = JSON.parse(row.storage_after);
        vectors.assert(written[name], name + ': the recorded create bytes hold no ' + name + ' entry');
        out.push(JSON.stringify({
            kind: 'golden', family: RESAVE, op: 'create', name: name, impl: impl,
            input_form_sha256: row.form_sha, input_configurations_sha256: row.configurations_sha,
            saved_config: JSON.stringify(written[name]),
            saved_field_order: Object.keys(written[name]),
            storage_expected: null, storage_actual: row.storage_after,
            note: 'recorded only: saveCurrentValues returns without a configId, so the new entry is '
                + 'written by saveConfiguration(); no slice composes this row'
        }));
    }
    for (const [name, row] of blocked) {
        out.push(JSON.stringify({
            kind: 'golden', family: RESAVE, op: 'alert-blocked', name: name, impl: impl,
            argv: null, dialogs: row.dialogs, modelPathValue: row.modelPathValue,
            modelSelectedIndex: row.modelSelectedIndex, input_form_sha256: row.form_sha,
            note: 'recorded from the page fed fixtures/http/J2-models verbatim: the saved modelPath '
                + 'has no <option>, so it blanks (Q18) and launchServer alerts before fetching'
        }));
    }
    const rows = out.length - 1;
    return { content: out.join('\n'), summary: { family: RESAVE, count: rows, argvItems: argvItems,
        throws: 0, iniChanges: iniChanges } };
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
    const resave = buildResave(gen, impl);
    if (resave) {
        files.set(RESAVE + '/goldens.jsonl', resave.content);
        summary.push(resave.summary);
    }
    return { files, impl, summary };
}

// fixtures/vectors/MANIFEST.json: every vectors + goldens file, its sha256, and the exact command
// that regenerates it. This is the artifact an Auditor re-checks without rerunning anything.
// Promoted repros (equivalence.js promote, equiv-prove.js --apply) are permanent boundary vectors
// with their own goldens twin, and coverage-promotions.json records the rows they claim.
// checkManifest requires every fixture .jsonl/.json to be listed, so the writer has to name them too
// — otherwise a promotion can never pass `--check`.
function promotedFiles() {
    const fs = require('fs');
    const dir = path.join(vectors.VECTORS, 'boundary');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((name) => /^shrunk-.*\.jsonl$/.test(name)).sort();
}

function manifest() {
    const fs = require('fs');
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
    for (const name of promotedFiles()) {
        const vectorsFile = 'fixtures/vectors/boundary/' + name;
        const goldenFile = 'fixtures/goldens/boundary/' + name.replace(/\.jsonl$/, '.goldens.jsonl');
        list.push({ file: vectorsFile, command: PROMOTED_REGEN,
            sha256: vectors.sha256(slices.readText(path.join(REPO, vectorsFile))) });
        list.push({ file: goldenFile, command: PROMOTED_REGEN,
            sha256: vectors.sha256(slices.readText(path.join(REPO, goldenFile))) });
    }
    const promotionMap = 'fixtures/vectors/coverage-promotions.json';
    if (fs.existsSync(path.join(REPO, promotionMap))) {
        list.push({ file: promotionMap, command: PROMOTED_REGEN,
            sha256: vectors.sha256(slices.readText(path.join(REPO, promotionMap))) });
    }
    // The browser-side family: its inputs are recorded by the L2 recorder (a browser driven by the
    // parity-baseline page), its goldens by this tool from those inputs. checkManifest requires every
    // file under fixtures/goldens to be listed, so all three are named here.
    if (fs.existsSync(path.join(REPO, RESAVE_INPUTS))) {
        list.push({ file: RESAVE_INPUTS, command: RESAVE_RECORD,
            sha256: vectors.sha256(slices.readText(path.join(REPO, RESAVE_INPUTS))) });
        list.push({ file: 'fixtures/goldens/resave/inputs.manifest.json', command: RESAVE_RECORD,
            sha256: vectors.sha256(slices.readText(path.join(REPO, 'fixtures/goldens/resave',
                'inputs.manifest.json'))) });
        list.push({ file: 'fixtures/goldens/' + RESAVE + '/goldens.jsonl', command: GOLDEN_REGEN,
            sha256: vectors.sha256(slices.readText(path.join(vectors.GOLDENS, RESAVE,
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
            + ' argv items, ' + row.throws + ' recorded generator throws'
            + (row.family === RESAVE ? ', ' + row.iniChanges
                + ' entries whose ini changes when re-saved (Q16)' : ''));
    }
    console.log('impl ' + built.impl);
    console.log('MANIFEST.json written (fixtures/vectors/MANIFEST.json)');
}

module.exports = { build, manifest, record, baselineSha, checkManifest, dataFiles, buildResave,
    resaveInputs, GOLDEN_REGEN, RESAVE_RECORD };

if (require.main === module) main();
