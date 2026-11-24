'use strict';
// Applying the fixtures/COMPARISON.json policy to live bytes. The rule lookup, the NORMALIZE/ASSERT
// registries and the diff printer are the L1 harness's (tests/L1-backend/lib/harness.js, required
// unchanged), so the seam layer relaxes exactly what the Verifier declared relaxable and nothing more.

const { COMPARISON, NORMALIZE, ASSERT, diffText, ruleFor, fixtureBytes, fail, MANIFEST } =
    require('../../L1-backend/lib/harness');

// The recorded node executable inside a fixture, for the one machine-bound token that is not the
// scratch root: the stand-in relays to `node.exe fake-llama-server.js ...`, and the recording
// machine's node path is not this run's node path. Same re-pointing tools/parity/capture-legacy's
// consumers do (tests/L1-backend/lib/harness.js replayBody).
function recordedNodeExe() {
    const text = fixtureBytes('http/J3-start-stop/start.request.json').toString('utf8');
    const match = /^"?(C:[^ ]*?node\.exe)"?/.exec(text);
    return match ? match[1].replace(/\\\\/g, '\\') : null;
}

const RECORDED_NODE = recordedNodeExe();

function deNode(text) {
    if (!RECORDED_NODE) return text;
    const win = RECORDED_NODE.replace(/[\\/]+/g, '\\');
    const now = process.execPath.replace(/[\\/]+/g, '\\');
    return text.split(win).join(now).split(RECORDED_NODE).join(process.execPath);
}

// normalise(rel, text) -> the text with the declared shape ops applied. `exact`-mode files come back
// untouched, which is what makes a byte claim a byte claim.
function normalise(rel, text) {
    const rule = ruleFor(rel);
    if (!rule || rule.mode === 'exact') return text;
    let out = text;
    for (const op of rule.normalize || []) {
        const implement = NORMALIZE[op.op];
        if (!implement) fail('POLICY', 'rule ' + (rule.id || rel) + ' uses an unimplemented op ' + op.op);
        out = implement(out, op);
    }
    return out;
}

// Compare live text/bytes against a recorded fixture under the policy. `actual` may already be sliced
// to the recorded exchange this observation reproduces (e.g. the first two argv-jsonl lines of a
// journey that recorded several launches); the fixture path still names where the expectation lives.
function compareFixtureText(rel, actual, options) {
    const opts = options || {};
    const label = 'fixtures/' + rel;
    const recorded = (opts.recordedSliceLines
        ? fixtureBytes(rel).toString('utf8').split('\n').filter((line) => line.trim() !== '')
            .slice(0, opts.recordedSliceLines).join('\n')
        : fixtureBytes(rel).toString('utf8'));
    const expected = normalise(rel, deNode(recorded));
    const observed = normalise(rel, String(actual));
    if (opts.assertRecorded) {
        for (const spec of (ruleFor(rel) || {}).assert || []) {
            const implement = ASSERT[spec.op];
            if (!implement) continue;
            const errors = implement(deNode(recorded), spec);
            if (errors.length) {
                fail('ASSERT-' + rel, 'the recorded side no longer satisfies its own shape rule:\n      '
                    + errors.join('\n      '));
            }
        }
    }
    if (expected !== observed) {
        fail('SEAM-' + rel.replace(/[^A-Za-z0-9]+/g, '-').toUpperCase(),
            diffText(Buffer.from(expected, 'utf8'), Buffer.from(observed, 'utf8'), label)
            + (ruleFor(rel) && ruleFor(rel).mode !== 'exact' ? '\n      shape rule: ' + ruleFor(rel).id : ''));
    }
    return (ruleFor(rel) || { id: 'defaultMode:' + COMPARISON.defaultMode }).id;
}

// ------------------------------------------------------------- recorded side helpers --------

// fixtures/argv/J4-launch-presets/port-source-evidence.json: the recorded argv of the two
// /launch-presets shapes. The ini path in it is the recording's app directory, so both sides are
// tokenised before comparison (the scratch root is machine-bound; fixtures/COMPARISON.json
// discloses that as an unrelaxed §8 row, and PATH-MAP.json is the token contract).
function recordedPresetsArgv(key) {
    const evidence = harnessFixtureJson('argv/J4-launch-presets/port-source-evidence.json');
    if (!evidence[key]) throw new Error('no port-source-evidence entry ' + key);
    return evidence[key].argv;
}

function harnessFixtureJson(rel) {
    return JSON.parse(fixtureBytes(rel).toString('utf8'));
}

// Observed argv -> token form, so a run under any --scratch can be compared with a recording.
function tokenizeArgv(manager, argv) {
    const map = manager.pathMap();
    return argv.map((token) => map.tokenize(token));
}

// Observed argv -> the recording's space. §9A remapped mode applies the machine-bound root to the
// expected bytes as well as to the inputs, so a recorded absolute path is re-pointed at this run's
// scratch root (tests/L1-backend/lib/harness.js replayBody does the same for request bodies). This
// keeps the comparison byte-exact instead of separator-insensitive.
const RECORDED_ROOTS = [
    ['fixtureTree', 'treeRoot'],
    ['app', 'app'],
    ['scratch', 'scratch']
];

const backslash = (value) => String(value).replace(/[\\/]+/g, '\\');

function portableArgv(manager, argv) {
    const pairs = RECORDED_ROOTS
        .map(([recordedKey, localKey]) => [MANIFEST.sandbox[recordedKey], manager[localKey]])
        .filter(([recorded, mine]) => typeof recorded === 'string' && typeof mine === 'string')
        .map(([recorded, mine]) => [backslash(recorded), backslash(mine)])
        .filter(([recorded, mine]) => recorded.toLowerCase() !== mine.toLowerCase())
        // Longest recorded root first, so 'C:\parity-scratch\app' is rewritten before its own prefix.
        .sort((a, b) => b[0].length - a[0].length);
    return argv.map((token) => pairs.reduce(
        (text, [recorded, mine]) => text.split(recorded).join(mine), token));
}

module.exports = { compareFixtureText, normalise, deNode, recordedNodeExe, recordedPresetsArgv,
    tokenizeArgv, portableArgv, harnessFixtureJson };
