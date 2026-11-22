'use strict';

// Stand-in for llama-server.exe used by the parity harness.
// Spawned by server.js through spawn(serverPath, args, { stdio: 'pipe' }) with no cwd/env
// override, so PARITY_ARGV_LOG / PARITY_BIND_LOG reach it through the inherited environment.

const fs = require('fs');
const http = require('http');
const { execSync } = require('child_process');

const CHUNK_DELAY_MS = 10;
const DEFAULT_CHUNK_BYTES = 7;
const DEFAULT_HOST = '127.0.0.1';

// script.js:475 and :524 push "-m" / "-c"; script.js:633-636 and server.js:616-619 push the
// long forms, so both spellings have to resolve to the same slot.
const VALUE_FLAGS = {
    '--host': 'host',
    '--port': 'port',
    '--model': 'model',
    '-m': 'model',
    '--models-preset': 'modelsPreset',
    '--ctx-size': 'ctxSize',
    '-c': 'ctxSize',
    '--parity-chunks': 'parityChunks',
    '--parity-exit-code': 'parityExitCode',
    '--parity-slow-exit': 'paritySlowExitMs'
};
const BOOL_FLAGS = new Set(['--parity-stderr-only']);

function parseArgs(argv) {
    const parsed = {
        host: null,
        port: null,
        model: null,
        modelsPreset: null,
        ctxSize: null,
        parityChunks: DEFAULT_CHUNK_BYTES,
        parityExitCode: null,
        parityStderrOnly: false,
        paritySlowExitMs: 0
    };

    for (let i = 0; i < argv.length; i += 1) {
        const token = String(argv[i]);
        const eq = token.indexOf('=');
        const name = eq > 0 ? token.slice(0, eq) : token;

        if (BOOL_FLAGS.has(name)) {
            parsed.parityStderrOnly = true;
            continue;
        }

        const key = Object.prototype.hasOwnProperty.call(VALUE_FLAGS, name) ? VALUE_FLAGS[name] : null;
        if (!key) continue;

        let value;
        if (eq > 0) {
            value = token.slice(eq + 1);
        } else {
            value = argv[i + 1];
            i += 1;
        }
        if (value === undefined) {
            i -= 1;
            continue;
        }
        parsed[key] = String(value);
    }

    parsed.port = toInteger(parsed.port);
    parsed.parityChunks = toInteger(parsed.parityChunks);
    if (parsed.parityChunks === null || parsed.parityChunks < 0) parsed.parityChunks = DEFAULT_CHUNK_BYTES;
    parsed.parityExitCode = toInteger(parsed.parityExitCode);
    parsed.paritySlowExitMs = toInteger(parsed.paritySlowExitMs) || 0;
    return parsed;
}

function toInteger(value) {
    if (value === null || value === undefined) return null;
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : null;
}

// Real llama-server paths in this app mix "/" and "\" (plan.md §9 Q20), so the basename has to
// split on both regardless of the host platform.
function baseName(filePath) {
    const parts = String(filePath).split(/[\\/]+/);
    return parts[parts.length - 1] || '';
}

function rawCommandLine() {
    if (process.platform === 'win32') {
        const command = 'powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter ' +
            "'ProcessId=" + process.pid + "').CommandLine\"";
        try {
            return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        } catch (error) {
            // Never synthesize a command line: a recorded fixture has to come from the process.
            return null;
        }
    }
    try {
        return fs.readFileSync('/proc/self/cmdline', 'utf8').split('\0').filter(Boolean).join(' ');
    } catch (error) {
        return null;
    }
}

function appendJsonLine(file, value) {
    fs.appendFileSync(file, JSON.stringify(value) + '\n');
}

function startupLines(parsed, listenUrl) {
    const lines = [
        'ggml_backend_cpu_init: number of physical cores: 8',
        'ggml_backend_cpu_init: number of logical cores: 16',
        'load_backend: loaded CPU backend',
        'load_model: expecting a GGUF file in version 3',
        'load_model: model = ' + (parsed.model === null ? '' : parsed.model)
    ];
    if (parsed.ctxSize !== null) lines.push('print_info: n_ctx = ' + parsed.ctxSize);
    if (parsed.modelsPreset !== null) lines.push('srv  params_from_: models_preset = ' + parsed.modelsPreset);
    lines.push('srv    load_model: load_model: OK');
    lines.push('srv  update_slots: all slots idle');
    if (listenUrl) lines.push('main: server is listening on ' + listenUrl);
    return lines;
}

function toChunks(lines, chunkBytes) {
    const chunks = [];
    for (const line of lines) {
        const buffer = Buffer.from(line + '\n', 'utf8');
        if (chunkBytes === 0) {
            chunks.push(buffer);
            continue;
        }
        for (let offset = 0; offset < buffer.length; offset += chunkBytes) {
            chunks.push(buffer.subarray(offset, offset + chunkBytes));
        }
    }
    return chunks;
}

function emit(chunks, sink) {
    return new Promise((resolve) => {
        let index = 0;
        const next = () => {
            if (index >= chunks.length) {
                resolve();
                return;
            }
            sink.write(chunks[index], () => {
                index += 1;
                setTimeout(next, CHUNK_DELAY_MS);
            });
        };
        next();
    });
}

function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

function startServer(host, port, modelName) {
    const server = http.createServer((req, res) => {
        const route = (req.url || '').split('?')[0];
        if (req.method === 'GET' && route === '/health') return sendJson(res, 200, { status: 'ok' });
        if (req.method === 'GET' && route === '/props') {
            return sendJson(res, 200, { default_generation_settings: { n_ctx: 4096 }, total_slots: 1 });
        }
        if (req.method === 'GET' && route === '/v1/models') {
            return sendJson(res, 200, { models: [modelName], data: [{ id: modelName, object: 'model' }] });
        }
        if (req.method === 'POST' && route === '/completion') return sendJson(res, 200, { content: 'ok' });
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end();
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server));
    });
}

async function main() {
    const argv = process.argv.slice(2);
    const parsed = parseArgs(argv);

    if (process.env.PARITY_ARGV_LOG) {
        appendJsonLine(process.env.PARITY_ARGV_LOG, {
            pid: process.pid,
            argv,
            raw: rawCommandLine()
        });
    }

    let listenUrl = null;
    if (parsed.port !== null) {
        const host = parsed.host === null ? DEFAULT_HOST : parsed.host;
        try {
            await startServer(host, parsed.port, parsed.model === null ? '' : baseName(parsed.model));
            listenUrl = 'http://' + host + ':' + parsed.port;
            if (process.env.PARITY_BIND_LOG) {
                appendJsonLine(process.env.PARITY_BIND_LOG, {
                    pid: process.pid,
                    host,
                    port: parsed.port
                });
            }
        } catch (error) {
            process.stderr.write('srv  update_slots: failed to listen on ' + host + ':' + parsed.port + '\n');
            process.exit(1);
        }
    }

    // Windows delivers no SIGTERM to a spawned process (libuv calls TerminateProcess), so this
    // graceful path only runs on POSIX; on Windows the manager's kill ends the child directly.
    let terminating = false;
    process.on('SIGTERM', () => {
        if (terminating) return;
        terminating = true;
        if (parsed.paritySlowExitMs <= 0) process.exit(0);
        setTimeout(() => process.exit(0), parsed.paritySlowExitMs);
    });

    const sink = parsed.parityStderrOnly ? process.stderr : process.stdout;
    await emit(toChunks(startupLines(parsed, listenUrl), parsed.parityChunks), sink);

    if (parsed.parityExitCode !== null) {
        process.exit(parsed.parityExitCode);
    }
    setInterval(() => {}, 1 << 30);
}

main().catch((error) => {
    process.stderr.write('fake-llama-server: ' + (error && error.message) + '\n');
    process.exit(1);
});
