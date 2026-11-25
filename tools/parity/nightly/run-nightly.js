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
function selftest() {
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
    console.log('RUN-NIGHTLY SELFTEST GREEN');
    console.log('  exit code = red gate count: ' + cases.map(([, expected]) => '→' + expected)
        .join(' ') + ' (3 red gates → 3, the value the 2026-11-25 fire lost)');
    console.log('  flake protocol on the gates that declare one: ' + repeats.join(', '));
    return 0;
}

function append(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, text);
}

// Run one gate, keeping the tail of its output so a red is diagnosable from the log alone. The
// child's whole tree is killed on timeout: a hung Chromium or manager would otherwise sit there
// holding 7837 and block every later gate (Windows does not deliver SIGTERM to node children).
function runGate(gate) {
    return new Promise((resolve) => {
        const started = Date.now();
        const child = spawn(process.execPath, gate.argv, { cwd: REPO, windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
        const tail = [];
        const capture = (chunk) => {
            for (const line of chunk.toString('utf8').split('\n')) {
                if (line.trim() === '') continue;
                tail.push(line);
                if (tail.length > 400) tail.shift();
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
            resolve({ gate, code, signal, seconds: (Date.now() - started) / 1000,
                tail: tail.slice(-25) });
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

async function runNightly(options) {
    const log = options.log || defaultLog();
    const gates = GATES.filter((gate) => !options.only || options.only.has(gate.id));
    const head = header(options, gates);
    append(log, head);
    console.log(head.trim());
    console.log('    log ' + path.relative(REPO, log));
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
        const block = [line, ...result.tail.map((entry) => '    | ' + entry)].join('\n') + '\n';
        append(log, block);
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
