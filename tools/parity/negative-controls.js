'use strict';
// Negative controls (plan §7 "Mutation spot-checks", task-l3l4 §4): prove the green suites have
// teeth. Each entry takes ONE recorded mutant from tools/parity/reports/mutation/mutants.json,
// applies it to a scratch git worktree of `parity-baseline`, runs the narrowest L2/L3 check group
// that should see it, and records the assertion that goes RED with its output excerpt. Then the
// worktree is reverted; a mutant is never committed and never exists in the repo working copy.
//
//   node tools/parity/negative-controls.js --plan              resolve + verify all six patches
//   node tools/parity/negative-controls.js --run <mutant-id>   one mutant (patch, run, revert)
//   node tools/parity/negative-controls.js --all               all six, then write fixtures/NEGATIVES.md
//   node tools/parity/negative-controls.js --all --keep        leave the worktrees in place
//
//   node tools/parity/negative-controls.js --probe <mutant-id> --layer L2 --only crud-create \
//        --expect L2-CRUD-                # candidate selection: does this mutant redden this group?
//
// Evidence per mutant lands in tools/parity/reports/negatives/<id>.{patch,log}: the patch is a
// `git diff` of the scratch worktree, so a reviewer can re-run any row with the command printed in
// fixtures/NEGATIVES.md. Nothing under fixtures/ or tests/ is written except NEGATIVES.md itself.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const { ANCHORS, BASELINE, REPO } = require('./baseline-slices.js');
const { runBash } = require('./bash-path.js');

const SCRATCH = process.env.PARITY_SCRATCH_ROOT || 'C:/parity-scratch';
const NEG_ROOT = path.join(SCRATCH, 'negatives');
const REPORTS = path.join(REPO, 'tools', 'parity', 'reports', 'negatives');
const MUTANTS = path.join(REPO, 'tools', 'parity', 'reports', 'mutation', 'mutants.json');
const NEGATIVES_MD = path.join(REPO, 'fixtures', 'NEGATIVES.md');
const TARGET_TIMEOUT_MIN = 12;
// mutants.json records sites per generator region; the region boundaries are the anchors the Part-1
// slicing tool already pins.
const REGION_ANCHOR = {
    args: ANCHORS.ARGS_START,
    ini: ANCHORS.INI_START,
    config: ANCHORS.CONFIG_START,
    save: ANCHORS.SAVE_START
};

// Six mutants, one per named L3 assertion, spread over the three client generator regions. Why L3
// and not L2: `tests/L2-ui/run.js --ref <dir>` was measured NOT to serve the directory it is given
// (a renamed <h3> in the worktree still produced 15/15 passes, including the title claim), so an L2
// control cannot observe a mutated oracle. L3's `--app <dir>` does start the manager and serve the
// page from that directory, which is what these controls need.
// Every corpus row also runs `corpus-seed` first: that check is what materialises the corpus model
// tree the other corpus checks assume. `expect` is the assertion id that must go red; a run that
// reddens nothing (or nothing named) is reported as a coverage failure, not as a pass.
const NEGATIVES = [
    {
        mutant: 'M-args-005-0022-string-literal-97ddd1c464',
        layer: 'L3', command: (app) => l3(app, 'models,argv'),
        expect: 'L3.ARGV-recorded-bytes',
        claim: 'the argv builder emits a mangled `-m` flag: the argv jsonl bytes written through the '
            + 'real spawn path for the recorded launch stop matching the recorded bytes'
    },
    {
        mutant: 'M-args-171-0026-string-literal-6e65569a1d',
        layer: 'L3', command: (app) => l3(app, 'models,argv'),
        expect: 'L3.ARGV-mmproj-from-window-models',
        claim: 'the `--mmproj` flag is emitted as `--mmprojX`: the association between the selected model '
            + 'and its mmproj file, taken from the live /models scan, leaves argv'
    },
    {
        mutant: 'M-args-004-0012-conditional-inversion-3d525bcf46',
        layer: 'L3', command: (app) => l3(app, 'corpus-seed,corpus-launch'),
        expect: 'L3.CORPUS-argv-goldens',
        claim: 'the model-path guard is inverted, so no config pushes its `-m` model: the 48-config argv '
            + 'goldens lose the model argument on every launch'
    },
    {
        mutant: 'M-ini-004-0043-loop-first-iteration-591318a098',
        layer: 'L3', command: (app) => l3(app, 'corpus-seed,corpus-launch'),
        expect: 'L3.CORPUS-INI-bytes',
        claim: 'the ini builder writes only the first saved config: the composed 48-section '
            + 'models-preset.ini bytes stop matching the recorded corpus ini'
    },
    {
        mutant: 'M-ini-020-0033-string-literal-9df5bbb505',
        layer: 'L3', command: (app) => l3(app, 'corpus-seed,corpus-tokens'),
        expect: 'L3.CORPUS-INI-token-bytes',
        claim: 'every `model = ` line in the generated ini gains a trailing X: the token-form corpus ini '
            + 'bytes — the ones that carry the Q20 mixed-separator chat-template-file lines — stop '
            + 'matching the recorded bytes'
    },
    {
        mutant: 'M-config-004-0013-negation-insertion-619719c0b5',
        layer: 'L3', command: (app) => l3(app, 'models,argv'),
        expect: 'L3.ARGV-recorded-bytes',
        claim: '`ngl: parseInt(nglInput.value) || 0` becomes `!(parseInt(...)) || 0`, so the collected '
            + 'ngl collapses to 0 and `--n-gpu-layers` leaves the command line: the recorded argv jsonl '
            + 'bytes from the real spawn path differ. The `config` region is the LAUNCH value '
            + 'collector, not the localStorage writer — see the coverage note below.'
    }
];

// One seam-layer run against the mutated checkout. Two constraints shape this command:
// · The recorded seam bytes are byte-exact against the recording's scratch root (§8 keeps that row
//   unrelaxed), so the control runs at that root — at another root the recorded argv/ini bytes can
//   never match, which is a property of the recorded corpus, not of the mutant.
// · `--keep-scratch` because the suite removes its scratch root on success, and C:/parity-scratch is
//   the parent of these worktrees; without it a passing control would delete its own checkout.
// The argv rows include `models`: that check is what points settings.json at the fixture tree.
function l3(app, only) {
    return ['tests/L3-seam/run.js', '--app', app, '--only', only, '--keep-scratch'];
}

function parseArgs(argv) {
    const options = { mode: 'plan', keep: false, id: null, layer: 'L2', only: null, expect: '' };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--plan') options.mode = 'plan';
        else if (token === '--all') options.mode = 'all';
        else if (token === '--run') { options.mode = 'run'; options.id = argv[index + 1]; index += 1; }
        else if (token === '--probe') {
            options.mode = 'probe'; options.id = argv[index + 1]; index += 1;
        } else if (token === '--layer') { options.layer = argv[index + 1].toUpperCase(); index += 1; }
        else if (token === '--only') { options.only = argv[index + 1]; index += 1; }
        else if (token === '--expect') { options.expect = argv[index + 1]; index += 1; }
        else if (token === '--keep') options.keep = true;
        else throw new Error('unknown argument: ' + token);
    }
    if ((options.mode === 'run' || options.mode === 'probe') && !options.id) {
        throw new Error(options.mode + ' needs a mutant id');
    }
    return options;
}

// Selection-time probe: does THIS mutant redden THIS check group? Used to pick the six rows below —
// a mutant that survives the flow a check drives (a default fallback on a field the flow never
// leaves empty) is not a negative control, so candidates are measured, not assumed.
function probeEntry(options) {
    const port = 7865;
    return {
        mutant: options.id,
        layer: options.layer,
        command: options.layer === 'L3'
            ? (app) => l3(app, options.only)
            : (app) => ['tests/L2-ui/run.js', '--ref', app, '--port', String(port), '--out',
                NEG_ROOT + '/SEAM_SLUG/l2out', '--only', options.only],
        expect: options.expect,
        claim: 'probe'
    };
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function loadMutants() {
    const rows = JSON.parse(fs.readFileSync(MUTANTS, 'utf8')).mutants;
    return new Map(rows.map((row) => [row.id, row]));
}

const win = (value) => String(value).replace(/\//g, '\\');

function git(args, options = {}) {
    return execFileSync('git', args, Object.assign({ cwd: REPO, encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024 }, options));
}

function seamSlug(entry) {
    return entry.mutant.replace(/[^A-Za-z0-9._-]/g, '-');
}

function worktreeDir(entry) {
    return path.join(NEG_ROOT, seamSlug(entry), 'checkout');
}

// A fresh detached worktree of the oracle tag. `git worktree` is the only way to run a mutated
// oracle without touching this checkout (rule C8: fixtures, tests and the working copy are pinned).
function makeWorktree(entry) {
    const dir = worktreeDir(entry);
    // A previous suite run can remove the directory underneath the registration (its scratch root is
    // the parent), which leaves git refusing to re-add the same path. Prune first, then remove what
    // is still on disk.
    git(['worktree', 'prune']);
    if (fs.existsSync(dir)) {
        unlinkModulesJunction(dir);
        git(['worktree', 'remove', '--force', dir]);
    }
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(['worktree', 'add', '--detach', dir, BASELINE]);
    return dir;
}

// The seam sandbox junctions the repo's node_modules into the app directory it starts (L1 sandbox
// rule: unlink a junction with rmdir, never with a recursive delete). Before this tool removes a
// worktree it must therefore unlink that junction — a recursive delete through it empties the repo's
// own node_modules, which is the one way a negative control can damage the checkout.
function removeJunction(link) {
    execFileSync('cmd.exe', ['/c', 'rmdir', win(link)], { stdio: 'ignore' });
}

function unlinkModulesJunction(dir) {
    const link = path.join(dir, 'node_modules');
    if (!fs.existsSync(link)) return;
    // The seam sandbox junctions the repo's node_modules into the app directory (L1 sandbox rule:
    // unlink with rmdir, never with a recursive delete). Remove it before any worktree removal and
    // refuse to continue if it is somehow still there — a recursive delete through that junction
    // empties the repo's own node_modules.
    removeJunction(link);
    assert(!fs.existsSync(link), 'NEG-JUNCTION: ' + link + ' is still present after rmdir; refusing '
        + 'to remove the worktree, because a recursive delete would follow it into the repo');
}

// Mutant sites are recorded as region-relative line + column offsets (mutants.json), where region
// line 0 is the anchor's first line of the baseline blob. The `before` text is re-checked here, so
// an offset that does not resolve fails loudly instead of writing a mutant nobody intended.
function applyMutation(dir, mutant) {
    const file = path.join(dir, 'public', 'script.js');
    const anchor = REGION_ANCHOR[mutant.region];
    assert(typeof anchor === 'string', 'NEG-REGION: no anchor for region ' + mutant.region);
    // A Windows checkout can carry CRLF while mutants.json records offsets against the LF blob:
    // process LF, write back the file's own line endings, so the recorded patch stays minimal.
    const raw = fs.readFileSync(file, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const text = eol === '\r\n' ? raw.replace(/\r\n/g, '\n') : raw;
    const lines = text.split('\n');
    const anchorAt = text.indexOf(anchor);
    assert(anchorAt >= 0, 'NEG-ANCHOR: ' + mutant.id + ': region anchor for ' + mutant.region
        + ' is not in ' + file);
    const at = lineIndexOf(text, anchorAt) + mutant.line;
    const row = lines[at];
    assert(typeof row === 'string', 'NEG-LINE: ' + mutant.id + ': region line ' + mutant.line
        + ' falls outside ' + file);
    assert(row.slice(mutant.start, mutant.end) === mutant.before, 'NEG-BEFORE: ' + mutant.id
        + ': expected ' + JSON.stringify(mutant.before) + ' at line ' + at + ' column ' + mutant.start
        + ' of ' + file + ', found ' + JSON.stringify(row.slice(mutant.start, mutant.end))
        + '\n      line: ' + JSON.stringify(row));
    lines[at] = row.slice(0, mutant.start) + mutant.after + row.slice(mutant.end);
    fs.writeFileSync(file, lines.join(eol));
    return { file, line: at, before: row, after: lines[at] };
}

function lineIndexOf(text, index) {
    return text.slice(0, index).split('\n').length - 1;
}

function revert(dir) {
    git(['-C', dir, 'checkout', '--', '.']);
    const dirty = git(['-C', dir, 'status', '--porcelain']).split('\n')
        .filter((row) => row.trim() !== '' && !row.includes('node_modules'));
    assert(dirty.length === 0, 'NEG-REVERT: scratch worktree still dirty after revert: '
        + dirty.join(' | '));
}

function writePatch(dir, entry) {
    fs.mkdirSync(REPORTS, { recursive: true });
    const patch = git(['-C', dir, 'diff', '--', 'public/script.js']);
    const file = path.join(REPORTS, entry.mutant + '.patch');
    fs.writeFileSync(file, patch);
    assert(patch.includes('+++'), 'NEG-PATCH: empty patch for ' + entry.mutant);
    return file;
}

function runTarget(entry, dir) {
    const argv = entry.command(dir.replace(/\\/g, '/')).map((token) => token
        .replace(/SEAM_SLUG/g, seamSlug(entry)));
    return new Promise((resolve) => {
        const started = Date.now();
        const child = spawn(process.execPath, argv, { cwd: REPO, windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'] });
        const output = [];
        const grab = (chunk) => output.push(chunk.toString('utf8'));
        child.stdout.on('data', grab);
        child.stderr.on('data', grab);
        // A suite that fails while a server is still listening can outlive its own report (the open
        // handle keeps the event loop alive), so a stuck control is killed instead of blocking the
        // remaining five. Its captured output still decides the verdict.
        const timer = setTimeout(() => {
            grab(Buffer.from('\n[negatives] ' + entry.mutant + ' exceeded ' + TARGET_TIMEOUT_MIN
                + ' min; killing the process tree\n'));
            spawn('cmd.exe', ['/c', 'taskkill', '/T', '/F', '/PID', String(child.pid)],
                { stdio: 'ignore' });
        }, TARGET_TIMEOUT_MIN * 60000);
        child.on('close', (code) => {
            clearTimeout(timer);
            const text = output.join('');
            fs.mkdirSync(REPORTS, { recursive: true });
            fs.writeFileSync(path.join(REPORTS, entry.mutant + '.log'),
                '$ node ' + argv.join(' ') + '\n\n' + text);
            resolve({ command: 'node ' + argv.join(' '), code, seconds: (Date.now() - started) / 1000,
                reds: redIds(text), excerpt: excerpt(text) });
        });
    });
}

// L2 prints `  RED <id> [group]`; L3 prints `FAIL  [quirk]  L3.ID — claim`.
function redIds(text) {
    const ids = new Set();
    for (const match of text.matchAll(/^\s*RED (\S+)/gm)) ids.add(match[1]);
    for (const match of text.matchAll(/^FAIL\s+\[[^\]]*\]\s+(L3\.[A-Za-z0-9._-]+)/gm)) ids.add(match[1]);
    return [...ids];
}

function excerpt(text) {
    const lines = text.split('\n');
    const at = lines.findIndex((line) => /^\s*RED \S+/.test(line) || /^FAIL\s+\[/.test(line));
    const tail = () => lines.filter((line) => line.trim() !== '').slice(-6);
    if (at < 0) return tail().join('\n');
    return lines.slice(at, at + 5).concat(tail().slice(-2)).join('\n')
        .split('\n').map((line) => line.trimEnd()).join('\n');
}

function describe(entry, mutants) {
    const mutant = mutants.get(entry.mutant);
    assert(mutant, 'NEG-UNKNOWN: mutant ' + entry.mutant + ' is not in ' + MUTANTS);
    return mutant;
}

function removeWorktree(dir) {
    unlinkModulesJunction(dir);
    git(['worktree', 'remove', '--force', dir]);
    git(['worktree', 'prune']);
}

// The controls share the suite's recording-root scratch (the recorded seam bytes are byte-exact
// there), and a corpus check materialises 48 model files into that fixture tree and leaves them
// there under --keep-scratch. A later control would then see a /models scan over the polluted tree
// and go red on claims that have nothing to do with its mutant, so each control starts from a
// rebuilt tree. `clean` is the tree tool's own mode: it lifts the ACL read-deny first, which a bare
// recursive delete cannot do.
function resetFixtureTree() {
    const tree = path.join(SCRATCH, 'fixtures');
    const cleaned = runBash(path.join(REPO, 'tools', 'parity', 'fixture-tree.sh'), [tree, 'clean']);
    assert(cleaned.status === 0, 'NEG-TREE: fixture-tree.sh clean exited ' + cleaned.status + ': '
        + String(cleaned.stderr || cleaned.stdout || '').trim());
}

async function runOne(entry, mutants, options) {
    const mutant = describe(entry, mutants);
    const dir = makeWorktree(entry);
    console.log('\n== ' + entry.mutant + '  [' + mutant.region + ' ' + mutant.class + ']');
    console.log('   ' + JSON.stringify(mutant.before) + '  =>  ' + JSON.stringify(mutant.after));
    const where = applyMutation(dir, mutant);
    console.log('   patched ' + path.relative(REPO, where.file) + ':' + (where.line + 1));
    console.log('     - ' + where.before.trim());
    console.log('     + ' + where.after.trim());
    const patch = writePatch(dir, entry);
    resetFixtureTree();
    const run = await runTarget(entry, dir);
    const named = run.reds.filter((id) => id.startsWith(entry.expect));
    // A control that never got to assert anything (module missing, port busy, killed on timeout) is a
    // harness problem; calling it MUTANT-SURVIVED would blame the suite for a run that never happened.
    const harnessBroken = /RUNNER FAILED|Cannot find module|EADDRINUSE|killing the process tree/
        .test(run.excerpt);
    const verdict = named.length > 0 && run.code !== 0 ? 'RED-AS-NAMED'
        : harnessBroken ? 'CONTROL-ERROR'
            : run.reds.length ? 'RED-SOMETHING-ELSE' : 'MUTANT-SURVIVED';
    console.log('   ' + run.command);
    console.log('   exit=' + run.code + '  seconds=' + run.seconds.toFixed(0) + '  red='
        + run.reds.length + '  named(' + entry.expect + ')='
        + named.length + '  -> ' + verdict);
    console.log(run.excerpt.split('\n').map((line) => '   ' + line).join('\n'));
    revert(dir);
    if (!options.keep) removeWorktree(dir);
    return { entry, mutant, verdict, patch: path.relative(REPO, patch), named, run };
}

function writeNegativesMd(records) {
    const unresolved = records.filter((record) => record.verdict !== 'RED-AS-NAMED');
    const lines = [];
    lines.push('# NEGATIVES — recorded negative controls for the Part-1 suites');
    lines.push('');
    lines.push('Written by `node tools/parity/negative-controls.js --all`. The rows below are that run\'s');
    lines.push('recorded output, not hand-authored assertions (rule C5). Each row applies ONE mutant from');
    lines.push('`tools/parity/reports/mutation/mutants.json` to a scratch git worktree of `' + BASELINE + '`,');
    lines.push('runs the narrowest check group that should see it, then reverts the worktree. A mutant is');
    lines.push('never committed and never touches this checkout\'s `public/script.js`.');
    lines.push('');
    lines.push('Reproduce one row (each patch is a `git diff` of the scratch worktree):');
    lines.push('');
    lines.push('```sh');
    lines.push('git worktree add --detach C:/parity-scratch/repro/checkout ' + BASELINE);
    lines.push('git -C C:/parity-scratch/repro/checkout apply tools/parity/reports/negatives/<id>.patch');
    lines.push('# from this repo, run the command in the Command column of that row');
    lines.push('git -C C:/parity-scratch/repro/checkout checkout -- .   # revert');
    lines.push('git worktree remove --force C:/parity-scratch/repro/checkout');
    lines.push('```');
    lines.push('');
    lines.push('| mutant | region / class | edit | Command | red assertion | verdict |');
    lines.push('|---|---|---|---|---|---|');
    for (const record of records) {
        const edit = (JSON.stringify(record.mutant.before) + ' -> '
            + JSON.stringify(record.mutant.after)).replace(/\|/g, '\\|');
        lines.push('| `' + record.entry.mutant + '` | ' + record.mutant.region + ' / '
            + record.mutant.class + ' | ' + edit + ' | `'
            + record.run.command.replace(/\|/g, '\\|') + '` | `' + (record.named[0]
                || record.run.reds[0] || 'none') + '` | ' + record.verdict + ' |');
    }
    lines.push('');
    lines.push('## What each row proves');
    lines.push('');
    for (const record of records) {
        lines.push('- **' + record.entry.mutant + '** (' + record.entry.layer + ') — '
            + record.entry.claim);
        lines.push('  Red: `' + (record.named[0] || record.run.reds[0] || 'NONE') + '`; exit '
            + record.run.code + '. Full log: `tools/parity/reports/negatives/' + record.entry.mutant
            + '.log`. Patch: `tools/parity/reports/negatives/' + record.entry.mutant + '.patch`.');
    }
    lines.push('');
    lines.push('## Layer coverage, and the gaps this inventory cannot close');
    lines.push('');
    const layers = [...new Set(records.map((record) => record.entry.layer))].sort();
    lines.push('Rows above cover ' + layers.join(' and ') + '. They cannot cover **L1**: every region in');
    lines.push('`mutants.json` is a `public/script.js` generator region (`args`, `ini`, `config`), and L1');
    lines.push('drives the manager over HTTP with no browser, so no mutant in that inventory can reach an');
    lines.push('L1 assertion. Proving L1 has teeth needs a `server.js` region in the mutation inventory,');
    lines.push('which is verifier-owned tooling — recorded here as an open gap rather than papered over');
    lines.push('with an L1 row that would not be a real mutant.');
    lines.push('');
    lines.push('A second gap, measured rather than assumed: the inventory has **no region for the');
    lines.push('localStorage writer**. `config` is the launch value collector, so no inventory mutant can');
    lines.push('change re-saved bytes. Measured with');
    lines.push('`node tools/parity/negative-controls.js --probe M-config-004-0013-negation-insertion-619719c0b5 '
        + '--layer L3 --only corpus-seed,corpus-resave --expect L3.CORPUS-resave-bytes`,');
    lines.push('which re-saved all 48 configs byte-identical to the goldens with `ngl` collapsed to 0, and');
    lines.push('the same mutant on `--only models,argv`, which reddened `L3.ARGV-recorded-bytes`. That is');
    lines.push('why the `config` row above targets argv. Closing the gap needs a `saveCurrentValues`');
    lines.push('region (`ANCHORS.SAVE_START`) added to the mutation inventory.');
    lines.push('');
    lines.push('A third gap, also measured: dropping the ini\'s `mmproj = ` line');
    lines.push('(`M-ini-026-0037-string-literal-ec533f9648`) reddened `L3.CORPUS-INI-token-bytes` when the');
    lines.push('scratch tree still held the mmproj files the recording left behind, and went undetected');
    lines.push('(exit 0, check passing) after `C:/parity-scratch/fixtures` was rebuilt from');
    lines.push('`tools/parity/fixture-tree.sh`. The token-form ini only carries an mmproj line when the');
    lines.push('live /models scan reports an mmproj association, so that part of the claim is vacuous on a');
    lines.push('rebuilt tree — the row above uses a `model = ` line mutant, which is present on every');
    lines.push('config. L3 has a vacuity guard for the Q20 separator lines');
    lines.push('(`L3.CORPUS-INI-Q20-VACUOUS`) but none for mmproj association; adding one is L3 work.');
    lines.push('');
    lines.push('Two rows share `L3.ARGV-recorded-bytes` on purpose: it is the byte-exact claim that gives');
    lines.push('the argv builder its teeth, and a mangled flag, an inverted guard and a changed collected');
    lines.push('value all have to land there.');
    lines.push('');
    lines.push('Each control rebuilds the fixture tree first (`fixture-tree.sh <tree> clean`), because every');
    lines.push('control shares the suite\'s recording-root scratch and a corpus check materialises 48 model');
    lines.push('files into it — without the reset, a later row would also go red on claims whose inputs');
    lines.push('its mutant never touched. The full child output of each row is in its .log file.');
    lines.push('');
    lines.push('A row reading `MUTANT-SURVIVED` means the suites did not notice a behaviour change they');
    lines.push('claim to pin; per plan §7 that check group is then rewritten, not the mutant.');
    lines.push('');
    fs.mkdirSync(path.dirname(NEGATIVES_MD), { recursive: true });
    fs.writeFileSync(NEGATIVES_MD, lines.join('\n'));
    return { path: NEGATIVES_MD, unresolved: unresolved.length };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const mutants = loadMutants();
    if (options.mode === 'probe') {
        const record = await runOne(probeEntry(options), mutants, options);
        return record.verdict === 'RED-AS-NAMED' ? 0 : 1;
    }
    const selected = options.mode === 'run' && options.id !== 'all'
        ? NEGATIVES.filter((entry) => entry.mutant === options.id)
        : NEGATIVES;
    assert(selected.length > 0, 'NEG-SELECT: no negative control matches ' + (options.id || options.mode));
    if (options.mode === 'plan') {
        for (const entry of selected) {
            const mutant = describe(entry, mutants);
            console.log(entry.layer + '  ' + entry.mutant + '  [' + mutant.region + ' line ' + mutant.line
                + ' cols ' + mutant.start + '-' + mutant.end + ']  expect red ' + entry.expect);
            console.log('     ' + JSON.stringify(mutant.before) + ' => ' + JSON.stringify(mutant.after));
            console.log('     ' + entry.command('<worktree>').join(' '));
        }
        // Verify every patch resolves against a real oracle checkout before spending minutes on runs.
        const dir = makeWorktree(selected[0]);
        const file = path.join(dir, 'public', 'script.js');
        const original = fs.readFileSync(file, 'utf8');
        for (const entry of selected) {
            applyMutation(dir, describe(entry, mutants));
            revert(dir);
            assert(fs.readFileSync(file, 'utf8') === original,
                'NEG-REVERT: ' + entry.mutant + ': revert did not restore script.js');
            console.log('patch resolves: ' + entry.mutant);
        }
        if (!options.keep) removeWorktree(dir);
        console.log('\nall ' + selected.length + ' patches resolve against ' + BASELINE);
        return 0;
    }
    const records = [];
    for (const entry of selected) records.push(await runOne(entry, mutants, options));
    if (options.mode === 'all') {
        const written = writeNegativesMd(records);
        console.log('\nwrote ' + written.path + ' (' + records.length + ' rows, '
            + written.unresolved + ' not red-as-named)');
    }
    const failed = records.filter((record) => record.verdict !== 'RED-AS-NAMED');
    console.log('\n' + (records.length - failed.length) + '/' + records.length
        + ' negative controls red as named');
    for (const record of failed) {
        console.log('  ' + record.verdict + ': ' + record.entry.mutant + ' expected '
            + record.entry.expect + ', saw ' + (record.run.reds.join(', ') || 'no reds'));
    }
    return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code), (error) => {
    console.error('negative-controls.js: ' + (error && error.stack ? error.stack : error));
    process.exit(1);
});
