'use strict';
// Nightly parity run (plan §7 'Cadence': L1-L4 against legacy, every night, for the whole
// Part-1→Part-2 gap). Four gates, sequential, because they share one scratch root and legacy pins
// itself to manager port 7837 (Q11):
//
//   L1  node tests/L1-backend/run.js --verify-against-selftest
//   L2  node tests/L2-ui/run.js --verify-selftest
//   L3  node tests/L3-seam/run.js --verify-against-selftest
//   L4  node tests/L4-dual/run.js --self-mode
//
// Every gate runs against the legacy tag, so a red is either the harness or the recorded corpus
// moving underneath a green suite — never a candidate (there is no candidate yet). Results are
// appended to tools/parity/reports/nightly.log with a timestamp per gate, and the process exits
// non-zero if any gate is red (that exit code is what Task Scheduler records as LastTaskResult).
//
//   node tools/parity/nightly/run-nightly.js [--only l1,l3] [--log <file>] [--no-l4]
//
// Registered as the Windows Task Scheduler job 'ParityNightly' by install-nightly.sh (03:00 daily).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const LOG = path.join(REPO, 'tools', 'parity', 'reports', 'nightly.log');
const GATES = [
    { id: 'L1', title: 'backend conformance vs legacy', argv: ['tests/L1-backend/run.js',
        '--verify-against-selftest'], timeoutMs: 40 * 60000 },
    { id: 'L2', title: 'UI conformance vs legacy assets', argv: ['tests/L2-ui/run.js',
        '--verify-selftest'], timeoutMs: 40 * 60000 },
    { id: 'L3', title: 'seam conformance: browser + legacy server + fake binary',
        argv: ['tests/L3-seam/run.js', '--verify-against-selftest'], timeoutMs: 45 * 60000 },
    { id: 'L4', title: 'dual-run self-mode (A = B = parity-baseline ⇒ zero field diffs)',
        argv: ['tests/L4-dual/run.js', '--self-mode'], timeoutMs: 45 * 60000 }
];

function parseArgs(argv) {
    const options = { log: LOG, only: null };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        const next = () => {
            index += 1;
            if (index >= argv.length) throw new Error('missing value for ' + token);
            return argv[index];
        };
        if (token === '--log') options.log = path.resolve(next());
        else if (token === '--only') options.only = new Set(next().split(',').map((id) => id.trim().toUpperCase()));
        else throw new Error('unknown argument: ' + token);
    }
    return options;
}

function stamp() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
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
            stdio: ['ignore', 'pipe', 'pipe'] });
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

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const gates = GATES.filter((gate) => !options.only || options.only.has(gate.id));
    const header = '\n===== ParityNightly ' + stamp() + '  node ' + process.version
        + '  repo ' + REPO + '  gates ' + gates.map((gate) => gate.id).join(',') + '\n';
    append(options.log, header);
    console.log(header.trim());
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
        append(options.log, block);
    }
    const failing = results.filter((result) => result.verdict === 'FAIL');
    const verdictLine = 'verdict ' + (failing.length ? 'RED' : 'GREEN') + ' — '
        + (failing.length ? failing.map((result) => result.gate.id).join(',') + ' red' : 'all gates green')
        + '  (' + results.reduce((sum, result) => sum + result.seconds, 0).toFixed(0) + ' s)\n';
    append(options.log, verdictLine);
    console.log(verdictLine.trim());
    append(options.log, '----- end ' + stamp() + '\n');
    return failing.length ? 1 : 0;
}

main().then((code) => process.exit(code), (error) => {
    console.error('run-nightly.js: ' + (error && error.stack ? error.stack : error));
    process.exit(1);
});
