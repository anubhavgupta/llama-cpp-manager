'use strict';

// Self-test for tools/parity/fake-llama-server.js.
// Spawns the fake directly (node exe + script path) and exercises every knob.
// Exit code is non-zero if any check fails.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const FAKE = path.join(__dirname, 'fake-llama-server.js');
const STANDIN_SOURCE = path.join(__dirname, 'standin-llama-server.cs');
const CSC_CANDIDATES = [
    process.env.PARITY_CSC,
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'
].filter(Boolean);
const IS_WINDOWS = process.platform === 'win32';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-fake-'));

let passed = 0;
let failed = 0;

function fail(message) {
    throw new Error(message);
}

function assert(condition, message) {
    if (!condition) fail(message);
}

function show(value) {
    return JSON.stringify(value);
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function expectedLog(options = {}) {
    const lines = [
        'ggml_backend_cpu_init: number of physical cores: 8',
        'ggml_backend_cpu_init: number of logical cores: 16',
        'load_backend: loaded CPU backend',
        'load_model: expecting a GGUF file in version 3',
        'load_model: model = ' + (options.model === undefined ? '' : options.model)
    ];
    if (options.ctxSize !== undefined) lines.push('print_info: n_ctx = ' + options.ctxSize);
    if (options.modelsPreset !== undefined) lines.push('srv  params_from_: models_preset = ' + options.modelsPreset);
    lines.push('srv    load_model: load_model: OK');
    lines.push('srv  update_slots: all slots idle');
    if (options.listenUrl !== undefined) lines.push('main: server is listening on ' + options.listenUrl);
    for (let index = 0; index < (options.repeatCount || 0); index += 1) lines.push(options.repeatLine);
    return lines.join('\n') + '\n';
}

function spawnFake(args, env, exe) {
    const childEnv = { ...process.env };
    delete childEnv.PARITY_ARGV_LOG;
    delete childEnv.PARITY_BIND_LOG;
    for (const [key, value] of Object.entries(env || {})) {
        if (value === undefined) delete childEnv[key];
        else childEnv[key] = String(value);
    }

    const run = {
        child: spawn(exe || process.execPath, exe ? args : [FAKE, ...args],
            { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv }),
        out: [],
        err: [],
        closed: false,
        result: null
    };
    run.child.stdout.on('data', (chunk) => run.out.push(chunk.toString('utf8')));
    run.child.stderr.on('data', (chunk) => run.err.push(chunk.toString('utf8')));
    run.done = new Promise((resolve) => {
        run.child.on('close', (code, signal) => {
            run.closed = true;
            run.result = { code, signal };
            resolve(run.result);
        });
    });
    return run;
}

async function waitFor(predicate, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return true;
        await delay(25);
    }
    return predicate();
}

function readLines(file) {
    try {
        return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
    } catch (error) {
        return [];
    }
}

async function waitForJsonLine(file, timeoutMs) {
    const ok = await waitFor(() => readLines(file).length > 0, timeoutMs, file);
    assert(ok, 'no JSON line appeared in ' + file + ' within ' + timeoutMs + 'ms');
    return readLines(file)[0];
}

async function finish(run, timeoutMs) {
    const raced = await Promise.race([run.done, delay(timeoutMs).then(() => null)]);
    if (!raced) fail('child did not exit within ' + timeoutMs + 'ms');
    return raced;
}

async function killRun(run) {
    if (!run.closed) run.child.kill('SIGKILL');
    await Promise.race([run.done, delay(3000)]);
}

// Models server.js:363-372: SIGTERM, then SIGKILL one second later if the child is still there.
async function stopSequence(run) {
    run.child.kill('SIGTERM');
    await delay(1000);
    if (!run.closed) run.child.kill('SIGKILL');
    return finish(run, 5000);
}

// Rebuild each logical line and count how many stdout data events contributed to it.
function lineSpans(events) {
    const joined = events.join('');
    const bounds = [];
    let offset = 0;
    for (const event of events) {
        bounds.push([offset, offset + event.length]);
        offset += event.length;
    }
    const spans = [];
    let lineStart = 0;
    for (let i = 0; i < joined.length; i += 1) {
        if (joined[i] !== '\n') continue;
        let count = 0;
        for (const [start, end] of bounds) {
            if (end > lineStart && start < i + 1) count += 1;
        }
        spans.push({ text: joined.slice(lineStart, i + 1), events: count });
        lineStart = i + 1;
    }
    return spans;
}

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const port = probe.address().port;
            probe.close(() => resolve(port));
        });
    });
}

function portOpen(port) {
    return new Promise((resolve) => {
        const probe = net.createConnection({ host: '127.0.0.1', port }, () => {
            probe.destroy();
            resolve(true);
        });
        probe.once('error', () => resolve(false));
        probe.setTimeout(2000, () => { probe.destroy(); resolve(false); });
    });
}

function findCsc() {
    for (const candidate of CSC_CANDIDATES) {
        if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return null;
}

// tools/parity/standin-llama-server.cs is source-controlled; the exe is a scratch build artifact.
function buildStandIn(targetExe) {
    const csc = findCsc();
    if (!csc) {
        fail('no csc.exe found (looked at ' + CSC_CANDIDATES.join(', ') + ') — the stand-in exe '
            + 'cannot be built, so the app-built-arg-vector journeys cannot be recorded');
    }
    const built = spawnSync(csc, ['-nologo', '-target:exe', '-out:' + targetExe, STANDIN_SOURCE],
        { encoding: 'utf8' });
    if (built.status !== 0 || !fs.existsSync(targetExe)) {
        fail('csc failed for ' + STANDIN_SOURCE + ': ' + (built.stdout || '') + (built.stderr || ''));
    }
    return { exe: targetExe, csc };
}

async function request(port, route, method) {
    const response = await fetch('http://127.0.0.1:' + port + route, {
        method: method || 'GET',
        signal: AbortSignal.timeout(5000)
    });
    const text = await response.text();
    return { status: response.status, text, json: text === '' ? null : JSON.parse(text) };
}

async function withServer(fn) {
    const bindLog = path.join(tmpDir, 'bind-' + process.hrtime.bigint().toString(36) + '.jsonl');
    const port = await freePort();
    const run = spawnFake(['--host', '127.0.0.1', '--port', String(port), '--model',
        'C:\\models\\test\\model.gguf', '--parity-chunks', '0'], { PARITY_BIND_LOG: bindLog });
    try {
        const ok = await waitFor(() => run.closed || readLines(bindLog).length > 0, 15000, bindLog);
        assert(ok, 'fake server did not bind port ' + port + ' (child exit ' + show(run.result) + ')');
        assert(!run.closed, 'fake server exited before binding: ' + show(run.err.join('')));
        return await fn({ run, port, bindLine: readLines(bindLog)[0] });
    } finally {
        await killRun(run);
    }
}

async function check(name, fn) {
    try {
        const detail = await fn();
        passed += 1;
        console.log('PASS  ' + name + (detail ? '  — ' + detail : ''));
    } catch (error) {
        failed += 1;
        console.log('FAIL  ' + name + '  — ' + (error && error.message));
    }
}

async function main() {
    await check('argv-log: argv array, pid and raw command line recorded', async () => {
        const argvLog = path.join(tmpDir, 'argv.jsonl');
        const spaced = 'C:\\models\\dir with space\\model name.gguf';
        const quoted = 'say-"hello"';
        const args = ['--host', '127.0.0.1', '--model', spaced, quoted, '--ctx-size', '2048',
            '--models-preset', 'C:\\projects\\Cline-demo\\models preset.ini', '--parity-chunks', '0'];
        const run = spawnFake(args, { PARITY_ARGV_LOG: argvLog });
        try {
            const record = JSON.parse(await waitForJsonLine(argvLog, 30000));
            assert(record.pid === run.child.pid, 'recorded pid ' + record.pid + ' != child pid ' + run.child.pid);
            assert(show(record.argv) === show(args), 'argv mismatch\n    got      ' + show(record.argv) +
                '\n    expected ' + show(args));

            const raw = record.raw;
            assert(typeof raw === 'string' && raw.length > 0,
                'raw command line missing — platform cannot report it (' + show(raw) + ')');
            const exeToken = raw.trim().split(/\s+/)[0].replace(/^"|"$/g, '');
            assert(path.basename(exeToken).toLowerCase().startsWith('node'),
                'raw does not start with the node executable: ' + raw);
            assert(raw.includes(path.basename(FAKE)), 'raw does not contain the script path: ' + raw);

            const spacedForm = IS_WINDOWS ? '"' + spaced + '"' : spaced;
            const quotedForm = IS_WINDOWS ? '"say-\\"hello\\""' : quoted;
            assert(raw.includes(spacedForm), 'raw does not quote the spaced arg as libuv does (' +
                spacedForm + '): ' + raw);
            assert(raw.includes(quotedForm), 'raw does not escape the embedded quote as libuv does (' +
                quotedForm + '): ' + raw);
            return 'raw = ' + raw;
        } finally {
            await killRun(run);
        }
    });

    await check('run: PARITY_ARGV_LOG / PARITY_BIND_LOG unset writes nothing and does not block', async () => {
        const argvLog = path.join(tmpDir, 'argv.jsonl');
        const linesBefore = readLines(argvLog).length;
        const run = spawnFake(['--parity-exit-code', '0'], { PARITY_ARGV_LOG: undefined, PARITY_BIND_LOG: undefined });
        const result = await finish(run, 20000);
        assert(result.code === 0, 'expected exit 0, got ' + show(result));
        assert(run.out.join('') === expectedLog(), 'stdout mismatch with env unset: ' + show(run.out.join('')));
        assert(readLines(argvLog).length === linesBefore, 'the argv log grew during a run with the env unset');
        return 'exited 0, argv log untouched (' + linesBefore + ' lines)';
    });

    await check('chunks: default knob splits each line across multiple stdout writes', async () => {
        const model = 'C:\\models\\test\\model.gguf';
        const run = spawnFake(['--model', model, '--parity-exit-code', '0'], {});
        const result = await finish(run, 20000);
        assert(result.code === 0, 'expected exit 0, got ' + show(result));
        const stdout = run.out.join('');
        assert(stdout === expectedLog({ model }), 'assembled stdout is not the fixed startup text:\n' + show(stdout));
        const spans = lineSpans(run.out);
        const expectedLines = expectedLog({ model }).trimEnd().split('\n').length;
        assert(spans.length === expectedLines, 'expected ' + expectedLines + ' logical lines, got ' + spans.length);
        const split = spans.filter((span) => span.events >= 2);
        assert(split.length === spans.length, 'only ' + split.length + '/' + spans.length +
            ' lines arrived split across writes: ' + show(run.out.map((chunk) => chunk.length)));
        return split.length + '/' + spans.length + ' lines split across writes, e.g. "' +
            split[0].text.trimEnd() + '" in ' + split[0].events + ' events';
    });

    await check('chunks: --parity-chunks 0 delivers one whole line per write', async () => {
        const model = 'C:\\models\\test\\model.gguf';
        const run = spawnFake(['--model', model, '--parity-chunks', '0', '--parity-exit-code', '0'], {});
        const result = await finish(run, 20000);
        assert(result.code === 0, 'expected exit 0, got ' + show(result));
        const stdout = run.out.join('');
        assert(stdout === expectedLog({ model }), 'assembled stdout is not the fixed startup text:\n' + show(stdout));
        const spans = lineSpans(run.out);
        assert(spans.every((span) => span.events === 1),
            'a line arrived split across events: ' + show(spans.filter((s) => s.events > 1)));
        assert(run.out.length === spans.length, 'expected ' + spans.length + ' data events, got ' + run.out.length);
        return spans.length + ' lines, each in exactly 1 data event';
    });

    await check('knob: --parity-exit-code exits with the requested code after the logs', async () => {
        const run = spawnFake(['--ctx-size', '4096', '--parity-exit-code', '3'], {});
        const result = await finish(run, 20000);
        assert(result.code === 3, 'expected exit code 3, got ' + show(result));
        assert(run.out.join('') === expectedLog({ ctxSize: '4096' }),
            'startup logs were not fully flushed before exit: ' + show(run.out.join('')));
        return 'exit code 3, all startup lines flushed';
    });

    await check('knob: --parity-stderr-only sends the startup text to stderr', async () => {
        const run = spawnFake(['--parity-stderr-only', '--parity-exit-code', '0'], {});
        const result = await finish(run, 20000);
        assert(result.code === 0, 'expected exit 0, got ' + show(result));
        assert(run.out.join('') === '', 'stdout should be empty, got ' + show(run.out.join('')));
        assert(run.err.join('') === expectedLog(), 'stderr is not the fixed startup text: ' + show(run.err.join('')));
        return 'stdout empty, stderr carries all ' + run.err.length + ' events';
    });

    await check('signal: SIGTERM ends the child the way the manager stops it', async () => {
        const run = spawnFake(['--parity-chunks', '0'], {});
        await delay(500);
        const result = await stopSequence(run);
        assert(result !== null, 'child did not terminate after SIGTERM/SIGKILL');
        if (!IS_WINDOWS) {
            assert(result.code === 0, 'expected exit code 0 on SIGTERM, got ' + show(result));
            return 'exit code 0 on SIGTERM';
        }
        // Windows cannot deliver SIGTERM to a spawned process: libuv calls TerminateProcess, so the
        // child handler never runs. The graceful exit(0) path itself is covered by the
        // --parity-exit-code 0 runs above.
        assert(result.signal === 'SIGTERM' || result.code !== null,
            'expected the child to die on SIGTERM, got ' + show(result));
        return 'win32 SIGTERM == TerminateProcess (' + show(result) + '); handler path is POSIX-only';
    });

    await check('signal: --parity-slow-exit keeps running through the stop sequence', async () => {
        const run = spawnFake(['--parity-slow-exit', '3000', '--parity-chunks', '0'], {});
        await delay(500);
        run.child.kill('SIGTERM');
        await delay(900);
        if (!IS_WINDOWS) {
            assert(!run.closed, 'child exited during the slow-exit window: ' + show(run.result));
            run.child.kill('SIGKILL');
            const result = await finish(run, 5000);
            return 'survived SIGTERM for 900ms, then exit ' + show(result);
        }
        const result = await finish(run, 5000);
        assert(result !== null, 'child did not terminate after the stop sequence');
        return 'win32: SIGTERM terminates immediately (' + show(result) + '), slow exit is POSIX-only';
    });

    await check('http: PARITY_BIND_LOG records pid, host and port', async () => {
        await withServer(async ({ run, port, bindLine }) => {
            const record = JSON.parse(bindLine);
            assert(show(record) === show({ pid: run.child.pid, host: '127.0.0.1', port }),
                'bind log mismatch: ' + show(record));
        });
        return 'one JSON line with numeric port';
    });

    await check('http: GET /health', async () => {
        await withServer(async ({ port }) => {
            const response = await request(port, '/health');
            assert(response.status === 200, 'status ' + response.status);
            assert(show(response.json) === show({ status: 'ok' }), 'body ' + response.text);
        });
        return '{"status":"ok"}';
    });

    await check('http: GET /props', async () => {
        const expected = { default_generation_settings: { n_ctx: 4096 }, total_slots: 1 };
        await withServer(async ({ port }) => {
            const response = await request(port, '/props');
            assert(response.status === 200, 'status ' + response.status);
            assert(show(response.json) === show(expected), 'body ' + response.text);
        });
        return JSON.stringify(expected);
    });

    await check('http: GET /v1/models reports the --model basename', async () => {
        const expected = { models: ['model.gguf'], data: [{ id: 'model.gguf', object: 'model' }] };
        await withServer(async ({ port }) => {
            const response = await request(port, '/v1/models');
            assert(response.status === 200, 'status ' + response.status);
            assert(show(response.json) === show(expected), 'body ' + response.text);
        });
        return 'basename of C:\\models\\test\\model.gguf';
    });

    await check('http: POST /completion', async () => {
        await withServer(async ({ port }) => {
            const response = await request(port, '/completion', 'POST');
            assert(response.status === 200, 'status ' + response.status);
            assert(show(response.json) === show({ content: 'ok' }), 'body ' + response.text);
        });
        return '{"content":"ok"}';
    });

    await check('http: GET on an unknown route is 404', async () => {
        await withServer(async ({ port }) => {
            const response = await request(port, '/not-a-route');
            assert(response.status === 404, 'expected 404, got ' + response.status);
        });
        return '404';
    });

    await check('http: listening line carries host and port in the startup logs', async () => {
        await withServer(async ({ run, port }) => {
            await delay(400);
            const stdout = run.out.join('');
            assert(stdout.includes('main: server is listening on http://127.0.0.1:' + port),
                'listening line missing: ' + show(stdout));
            assert(stdout.includes('load_model: model = C:\\models\\test\\model.gguf'),
                'model line missing: ' + show(stdout));
        });
        return 'http://127.0.0.1:<port> and model = <value>';
    });

    await check('knob: --parity-repeat-line/--parity-repeat-count emit N extra verbatim lines', async () => {
        const repeatLine = 'repeat: line for the 1000-line log cap';
        const run = spawnFake(['--parity-repeat-line', repeatLine, '--parity-repeat-count', '1203',
            '--parity-chunks', '0', '--parity-exit-code', '0'], {});
        const result = await finish(run, 40000);
        assert(result.code === 0, 'expected exit 0, got ' + show(result));
        const stdout = run.out.join('');
        const expected = expectedLog({ repeatLine, repeatCount: 1203 });
        assert(stdout === expected, 'repeated lines mismatch: got ' + run.out.length + ' events / '
            + stdout.split('\n').length + ' lines, expected ' + expected.split('\n').length + ' lines');
        assert(stdout.split('\n').filter((line) => line === repeatLine).length === 1203,
            'repeat line count mismatch');
        return '1203 verbatim repeat lines appended, assembled stdout byte-identical to the expected log';
    });

    await check('knob: --parity-repeat-line without a count adds nothing', async () => {
        const run = spawnFake(['--parity-repeat-line', 'unused', '--parity-exit-code', '0'], {});
        const result = await finish(run, 20000);
        assert(result.code === 0, 'expected exit 0, got ' + show(result));
        assert(run.out.join('') === expectedLog(), 'unexpected lines: ' + show(run.out.join('')));
        return 'default count 0, startup log unchanged';
    });

    await check('standin: relayed argv equals received argv and the fake knobs still work', async () => {
        const built = buildStandIn(path.join(tmpDir, 'fake-llama-server.exe'));
        const argvLog = path.join(tmpDir, 'standin-argv.jsonl');
        const spaced = 'C:\\models\\dir with space\\model name.gguf';
        const quoted = 'say-"hello"';
        const args = ['--models-preset', 'C:\\scratch\\app\\models preset.ini', '--model', spaced, quoted,
            '--parity-repeat-line', 'relay line', '--parity-repeat-count', '2',
            '--parity-chunks', '0', '--parity-exit-code', '7'];
        const run = spawnFake(args, { PARITY_ARGV_LOG: argvLog, PARITY_NODE: process.execPath,
            PARITY_FAKE_SCRIPT: FAKE }, built.exe);
        try {
            const result = await finish(run, 40000);
            assert(result.code === 7, 'exit code was not propagated through the relay: ' + show(result));
            const lines = readLines(argvLog).map((line) => JSON.parse(line));
            assert(lines.length === 2, 'expected one argv line from the stand-in and one from the fake, got '
                + lines.length);
            assert(show(lines[0].argv) === show(args), 'stand-in argv mismatch: ' + show(lines[0].argv));
            assert(show(lines[1].argv) === show(args), 'relayed argv differs from received argv: '
                + show(lines[1].argv));
            assert(lines[0].pid !== lines[1].pid, 'relay did not start a separate process');
            assert(typeof lines[0].raw === 'string' && lines[0].raw.includes('models-preset'),
                'raw command line missing from the stand-in record: ' + show(lines[0].raw));
            assert(run.out.join('') === expectedLog({ model: spaced, modelsPreset: 'C:\\scratch\\app\\models preset.ini',
                repeatLine: 'relay line', repeatCount: 2 }),
            'knob output did not survive the relay: ' + show(run.out.join('')));
            return 'argv identical across the relay (' + args.length + ' args, spaces + quotes), exit 7 propagated';
        } finally {
            await killRun(run);
        }
    });

    await check('standin: killing the relay takes the node child with it (no orphan holds the port)', async () => {
        const built = buildStandIn(path.join(tmpDir, 'fake-llama-server.exe'));
        const port = await freePort();
        const run = spawnFake(['--host', '127.0.0.1', '--port', String(port), '--parity-chunks', '0'],
            { PARITY_NODE: process.execPath, PARITY_FAKE_SCRIPT: FAKE }, built.exe);
        try {
            const open = await waitFor(async () => await portOpen(port), 15000, 'port ' + port);
            assert(open, 'the relayed fake never bound port ' + port);
            run.child.kill('SIGTERM');
            const gone = await waitFor(async () => !(await portOpen(port)), 10000, 'port ' + port + ' closed');
            assert(gone, 'port ' + port + ' stayed open after the stand-in was killed: the node child was orphaned');
            return 'SIGTERM to the stand-in released port ' + port;
        } finally {
            await killRun(run);
        }
    });

    console.log('\n' + passed + ' passed, ' + failed + ' failed  (platform ' + process.platform + ')');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
    console.error('selftest harness error:', error);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exitCode = 1;
});
