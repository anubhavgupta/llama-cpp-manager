'use strict';
// Nightly parity run (plan §7 'Cadence': L1-L4 against legacy, every night, for the whole
// Part-1→Part-2 gap). Four gates, sequential, because they share one scratch root and legacy pins
// itself to manager port 7837 (Q11):
//
//   L1  node tests/L1-backend/run.js --verify-against-selftest
//   L2  node tests/L2-ui/run.js --verify-selftest --repeat 2
//   L3  node tests/L3-seam/run.js --verify-against-selftest --repeat 2
//   L4  node tests/L4-dual/run.js --self-mode
//
// The --repeat 2 on L2 and L3 is the flake protocol those suites' own CHECKS.md declare as the
// gate ('--verify-selftest --repeat 2', '×2'); a nightly that runs each once does not run the gate.
//
// Every gate runs against the legacy tag, so a red is either the harness or the recorded corpus
// moving underneath a green suite — never a candidate (there is no candidate yet). Each fire writes
// its own durable block to tools/parity/reports/nightly/nightly-<utc>.log (a .gitignore exception
// keeps that directory's logs in git) with a timestamp per gate, and the process exits with the
// NUMBER OF RED GATES — that is what Task Scheduler records as LastTaskResult, so a 3-gate red
// records 3, not 1 (AUDIT-2026-11-25 finding 7). --selftest checks that contract.
//
// A red gate's block carries EVERY failure line of the gate's output with its context, not just the
// last 25 lines: a suite prints its FAIL lines before its summary footer, so a tail-only log recorded
// 'L3 red' without saying which check was red (AUDIT-2026-11-25 finding N4). --selftest proves this
// from a synthetic red gate that buries its FAIL lines under 400 footer lines.
//
// Before the gates, the fire verifies fixtures/HASH-PIN.json against the git INDEX
// (bash tools/parity/hash-pin.sh --check, finding N2): pinned rule docs and suites that only exist as
// local bytes would make every green below meaningless. A failed pin check refuses the fire and exits
// 1 with the words 'not a red gate' in the log.
//
// A fire also takes the one-executor lock (tools/parity/parity-lock.js) before it touches the scratch
// root, and hands its gates PARITY_LOCK_HELD so they do not fight it for it. A fire that finds the
// lock held — the 03:00 auto-fire landing on an interactive run, say — refuses, writes the refusal to
// its log, and exits 1; read the log before reading that number as one red gate.
//
//   node tools/parity/nightly/run-nightly.js [--only l1,l3] [--log <file>] [--no-l4] [--selftest]
//
// Registered as the Windows Task Scheduler job 'ParityNightly' by install-nightly.sh (03:00 daily).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const parityLock = require('../parity-lock.js');
const { runBash } = require('../bash-path.js');

const REPO = path.resolve(__dirname, '..', '..', '..');
const REPORT_DIR = path.join(REPO, 'tools', 'parity', 'reports', 'nightly');
const GATES = [
    { id: 'L1', title: 'backend conformance vs legacy', argv: ['tests/L1-backend/run.js',
        '--verify-against-selftest'], timeoutMs: 40 * 60000 },
    { id: 'L2', title: 'UI conformance vs legacy assets', argv: ['tests/L2-ui/run.js',
        '--verify-selftest', '--repeat', '2'], timeoutMs: 40 * 60000 },
    { id: 'L3', title: 'seam conformance: browser + legacy server + fake binary',
        argv: ['tests/L3-seam/run.js', '--verify-against-selftest', '--repeat', '2'],
        timeoutMs: 45 * 60000 },
    { id: 'L4', title: 'dual-run self-mode (A = B = parity-baseline ⇒ zero field diffs)',
        argv: ['tests/L4-dual/run.js', '--self-mode'], timeoutMs: 45 * 60000 }
];

function parseArgs(argv) {
    const options = { log: null, only: null, selftest: false };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        const next = () => {
            index += 1;
            if (index >= argv.length) throw new Error('missing value for ' + token);
            return argv[index];
        };
        if (token === '--log') options.log = path.resolve(next());
        else if (token === '--only') options.only = new Set(next().split(',').map((id) => id.trim().toUpperCase()));
        else if (token === '--selftest') options.selftest = true;
        else throw new Error('unknown argument: ' + token);
    }
    return options;
}

function stamp() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// One file per fire, named by its UTC start time. ':' is not legal in a Windows filename.
function defaultLog() {
    return path.join(REPORT_DIR, 'nightly-' + stamp().replace(/:/g, '-') + '.log');
}

// The exit code IS the count of red gates (Task Scheduler's LastTaskResult), capped at 255 because
// that is the widest value an exit code can carry — with four gates the cap is unreachable.
function verdictExitCode(results) {
    const red = results.filter((result) => result.verdict === 'FAIL').length;
    return Math.min(red, 255);
}

// The contract finding 7 recorded as broken, checked without running a gate: the exit code counts
// red gates instead of collapsing to 1.
async function selftest() {
    const cases = [[[], 0], [['PASS', 'PASS'], 0], [['FAIL'], 1], [['PASS', 'FAIL', 'FAIL'], 2],
        [['FAIL', 'FAIL', 'FAIL', 'FAIL'], 4]];
    for (const [verdicts, expected] of cases) {
        const results = verdicts.map((verdict) => ({ verdict }));
        const code = verdictExitCode(results);
        if (code !== expected) {
            throw new Error('exit-code contract broken: ' + (verdicts.join(',') || 'no gates')
                + ' exited ' + code + ', expected ' + expected);
        }
    }
    // The recorded breakage, asserted by name: the 2026-11-25 03:00 fire had L1+L3+L4 red and
    // Task Scheduler recorded LastTaskResult 1.
    if (verdictExitCode([{ verdict: 'FAIL' }, { verdict: 'FAIL' }, { verdict: 'FAIL' }]) !== 3) {
        throw new Error('exit-code contract broken: three red gates must record 3, the value the '
            + '2026-11-25 fire recorded as 1');
    }
    const repeats = GATES.filter((entry) => entry.id === 'L2' || entry.id === 'L3')
        .map((entry) => entry.id + ' ' + entry.argv.slice(-2).join(' '));
    for (const entry of GATES) {
        if (entry.id !== 'L2' && entry.id !== 'L3') continue;
        const at = entry.argv.indexOf('--repeat');
        if (at < 0 || entry.argv[at + 1] !== '2') {
            throw new Error('the ' + entry.id + ' gate must run --repeat 2, the flake protocol its '
                + 'CHECKS.md declares as the gate');
        }
    }
    // The N4 contract, checked without a real gate: a red that buries its failure lines under a long
    // footer still puts them, and the first-difference line, in the durable log.
    const synthetic = await runGate({ id: 'SYNTH', title: 'synthetic red', timeoutMs: 60000,
        argv: ['-e', 'console.log("FAIL  [group x]  SYNTH.CHECK — expected 12 bytes, got 13");'
            + 'console.log("      first difference at byte 0");'
            + 'for (let i = 0; i < 400; i += 1) console.log("footer " + i);'
            + 'process.exit(1);'] });
    const probeBlock = gateBlock({ ...synthetic, line: 'SYNTH-CHECK-PROBE' });
    for (const must of ['SYNTH.CHECK', 'first difference at byte 0']) {
        if (!probeBlock.includes(must)) {
            throw new Error('a durable red must be diagnosable from the log alone, but the block of a '
                + 'gate that failed before 400 footer lines does not contain ' + JSON.stringify(must));
        }
    }
    if (synthetic.code !== 1) {
        throw new Error('the synthetic red gate exited ' + synthetic.code + ', expected 1');
    }
    console.log('RUN-NIGHTLY SELFTEST GREEN');
    console.log('  exit code = red gate count: ' + cases.map(([, expected]) => '→' + expected)
        .join(' ') + ' (3 red gates → 3, the value the 2026-11-25 fire lost)');
    console.log('  flake protocol on the gates that declare one: ' + repeats.join(', '));
    console.log('  pin pre-gate before the first gate: bash tools/parity/hash-pin.sh --check, and a '
        + 'failed pin check refuses the fire rather than counting as a red gate');
    console.log('  a durable red carries its failure lines, not just a tail: synthetic gate, '
        + synthetic.lines.length + ' output lines, '
        + probeBlock.split('\n').filter((entry) => entry.startsWith('    |')).length
        + ' of them retained in the block');
    for (const retained of probeBlock.split('\n').filter((entry) => entry.includes('SYNTH.CHECK')
        || entry.includes('first difference at byte 0'))) {
        console.log('    retained: ' + retained.trim());
    }
    return 0;
}

function append(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, text);
}

// Run one gate, keeping the tail of its output so a red is diagnosable from the log alone. The
// child's whole tree is killed on timeout: a hung Chromium or manager would otherwise sit there
// holding 7837 and block every later gate (Windows does not deliver SIGTERM to node children).
// The lines that say WHAT failed. A gate is the authority on its own report vocabulary, so this
// matches that vocabulary instead of a per-suite list of check ids.
const FAILURE_LINE = /FAIL|\bRED\b|THREW|Error|error:|expected .*got|first difference at byte|exited with code|EBUSY|EADDRINUSE|ETIMEDOUT|\(.*\.(js|cs):\d+/;
const CONTEXT_LINES = 2;
const DETAIL_CAP = 400;
const TAIL_LINES = 25;

// Failure lines with CONTEXT_LINES around each, in source order, windows merged so a line is never
// repeated. Capped: a gate with thousands of red checks does not need all of them in the durable log.
function failureDetail(lines) {
    const keep = new Set();
    lines.forEach((line, index) => {
        if (!FAILURE_LINE.test(line)) return;
        const from = Math.max(0, index - CONTEXT_LINES);
        const to = Math.min(lines.length - 1, index + CONTEXT_LINES);
        for (let at = from; at <= to; at += 1) keep.add(at);
    });
    const picked = Array.from(keep).sort((left, right) => left - right).map((index) => lines[index]);
    if (picked.length <= DETAIL_CAP) return picked;
    return picked.slice(0, DETAIL_CAP)
        .concat(['... ' + (picked.length - DETAIL_CAP) + ' more failure-detail lines cut ...']);
}

// The durable block of one gate: the verdict line, whatever explains a red, and the tail so the gate's
// own closing summary stays visible.
function gateBlock(result) {
    const detail = failureDetail(result.lines);
    const lines = [result.line];
    if (detail.length) {
        lines.push('    --- failure detail: ' + detail.length + ' of ' + result.lines.length
            + ' output line(s) ---');
        lines.push(...detail.map((entry) => '    | ' + entry));
    }
    const tail = result.lines.slice(-TAIL_LINES);
    lines.push('    --- last ' + tail.length + ' of ' + result.lines.length + ' output lines ---');
    lines.push(...tail.map((entry) => '    | ' + entry));
    return lines.join('\n') + '\n';
}

function runGate(gate) {
    return new Promise((resolve) => {
        const started = Date.now();
        const child = spawn(process.execPath, gate.argv, { cwd: REPO, windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
        const lines = [];
        const capture = (chunk) => {
            for (const line of chunk.toString('utf8').split('\n')) {
                if (line.trim() === '') continue;
                lines.push(line);
            }
        };
        child.stdout.on('data', capture);
        child.stderr.on('data', capture);
        const timer = setTimeout(() => {
            capture(Buffer.from('\n[nightly] ' + gate.id + ' exceeded '
                + Math.round(gate.timeoutMs / 60000) + ' min; killing the process tree\n'));
            spawn('cmd.exe', ['/c', 'taskkill', '/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
        }, gate.timeoutMs);
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ gate, code, signal, seconds: (Date.now() - started) / 1000, lines });
        });
    });
}

// The nightly holds the one-executor lock for the whole run and tells its gate processes they are
// running inside a holder, so a gate neither collides with the nightly's own lock nor releases it.
function childEnv() {
    return { ...process.env, [parityLock.HELD_ENV]: '1' };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.selftest) return selftest();
    let lock;
    try {
        lock = parityLock.acquire('nightly tools/parity/nightly/run-nightly.js '
            + process.argv.slice(2).join(' '));
    } catch (error) {
        // A fire that could not start is not a fire with one red gate, but the exit code can only
        // speak in red gates; the log line is what makes the number readable. This is what keeps the
        // 03:00 auto-fire from running against a scratch root an interactive executor is using.
        const message = String(error && error.message || error);
        if (!message.startsWith('PARITY-LOCK-HELD')) throw error;
        const log = options.log || defaultLog();
        append(log, header(options) + message + '\n');
        console.log(message);
        return 1;
    }
    try {
        return await runNightly(options);
    } finally {
        lock.release();
    }
}

function header(options, gates) {
    const list = gates ? gates.map((gate) => gate.id).join(',') : 'refused (executor lock held)';
    return '\n===== ParityNightly ' + stamp() + '  node ' + process.version + '  repo ' + REPO
        + '  gates ' + list + '\n';
}

// C8 as a machine check (AUDIT-2026-11-25 finding N2): a fire that spends 20 minutes going green
// against rule docs and suites no clone can rebuild is worthless, so the pin is verified before the
// first gate. Like the lock refusal this is a REFUSAL, not a red gate — the exit code can only speak
// in red gates, so the log line is what keeps a 1 from being read as 'L1 red'.
function pinPrecheck(log) {
    const checked = runBash(path.join(REPO, 'tools', 'parity', 'hash-pin.sh'), ['--check'],
        { cwd: REPO, encoding: 'utf8' });
    const text = ((checked.stdout || '') + (checked.stderr || '')).trimEnd();
    if (checked.status === 0) {
        append(log, text + '\n');
        console.log('    ' + text.split('\n')[0]);
        return null;
    }
    const message = 'HASH-PIN PRE-GATE REFUSED this fire (not a red gate): ' + text.split('\n')[0]
        + '\n' + text.split('\n').slice(1).map((line) => '    ' + line).join('\n')
        + '\n    fix the pin (or land the ledger-backed re-pin) before reading any gate result\n';
    append(log, message);
    console.log(message.trimEnd());
    return 1;
}

async function runNightly(options) {
    const log = options.log || defaultLog();
    const gates = GATES.filter((gate) => !options.only || options.only.has(gate.id));
    const head = header(options, gates);
    append(log, head);
    console.log(head.trim());
    console.log('    log ' + path.relative(REPO, log));
    const refused = pinPrecheck(log);
    if (refused !== null) return refused;
    const results = [];
    for (const gate of gates) {
        const command = 'node ' + gate.argv.join(' ');
        console.log('--> ' + gate.id + '  ' + command);
        const result = await runGate(gate);
        const verdict = result.code === 0 ? 'PASS' : 'FAIL';
        results.push({ ...result, verdict });
        const line = verdict + '  ' + gate.id + '  ' + result.seconds.toFixed(1) + ' s  exit='
            + result.code + (result.signal ? ' signal=' + result.signal : '') + '  ' + command;
        console.log('    ' + line);
        append(log, gateBlock({ ...result, line }));
    }
    const failing = results.filter((result) => result.verdict === 'FAIL');
    const exitCode = verdictExitCode(results);
    const verdictLine = 'verdict ' + (failing.length ? 'RED' : 'GREEN') + ' — '
        + (failing.length ? failing.map((result) => result.gate.id).join(',') + ' red' : 'all gates green')
        + '  (' + results.reduce((sum, result) => sum + result.seconds, 0).toFixed(0) + ' s)'
        + '  exit=' + exitCode + ' (red gate count)\n';
    append(log, verdictLine);
    console.log(verdictLine.trim());
    append(log, '----- end ' + stamp() + '\n');
    return exitCode;
}

if (require.main === module) {
    main().then((code) => process.exit(code), (error) => {
        console.error('run-nightly.js: ' + (error && error.stack ? error.stack : error));
        process.exit(1);
    });
}

module.exports = { GATES, verdictExitCode, defaultLog, REPORT_DIR };
