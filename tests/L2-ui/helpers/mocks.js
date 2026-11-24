'use strict';
// The L2 backend mock: fetch is intercepted and answered with the RAW BODY BYTES recorded in
// fixtures/http/** for the exact URL the page asked for, and io() is replaced by a scripted
// emitter whose dispatches replay recorded fixtures/ws payloads. An unmatched fetch is a violation
// (the suite goes red), because a silently-unmocked request would make a state unasserted.

const fixtures = require('./fixtures');

// Each entry names the fixture its bytes come from, so a red can be traced to a recording.
const DEFAULT_ROUTES = [
    ['GET /status', 'J1-settings', 'status'],
    ['GET /models', 'J2-models', 'models'],
    ['GET /metrics', 'J1-settings', 'metrics-1'],
    ['GET /settings', 'J1-settings', 'settings-read'],
    ['POST /settings', 'J1-settings', 'settings-post-with-port'],
    ['POST /start', 'J5-ui-launch', 'start-from-ui'],
    ['POST /stop', 'J3-start-stop', 'stop'],
    ['POST /launch-presets', 'J4b-ui-presets-launch', 'launch-presets-from-ui'],
    ['POST /restart', 'J3d-restart', 'restart']
];

// The stub io(): same call shape (io() with no arguments, on/off/disconnect) and a host object on
// window so a check can dispatch recorded socket.io payloads as the page received them.
const IO_STUB = `
const host = { calls: [], sockets: [] };
function makeSocket() {
    const handlers = {};
    let connectSent = false;
    const sendConnect = function () {
        if (connectSent) return;
        connectSent = true;
        setTimeout(function () {
            for (const fn of (handlers.connect || [])) fn();
        }, 0);
    };
    const socket = {
        connected: true,
        id: 'l2-stub',
        on(event, fn) {
            (handlers[event] = handlers[event] || []).push(fn);
            // socket.io emits 'connect' after the handler exists; the app's banner line is part of the
            // recorded pane output, so the stub reproduces that emission.
            if (event === 'connect') sendConnect();
            return socket;
        },
        off(event, fn) {
            handlers[event] = (handlers[event] || []).filter((entry) => entry !== fn);
            return socket;
        },
        emit() { return socket; },
        disconnect() { host.disconnects.push(1); socket.connected = false; return socket; },
        close() { return socket.disconnect(); },
        connect() { socket.connected = true; return socket; }
    };
    socket.__handlers = handlers;
    return socket;
}
host.disconnects = [];
host.dispatch = function dispatch(event, payload) {
    let delivered = 0;
    for (const socket of host.sockets) {
        for (const fn of (socket.__handlers[event] || [])) { fn(payload); delivered += 1; }
    }
    return delivered;
};
window.__l2io = host;
export function io() {
    const socket = makeSocket();
    host.calls.push(1);
    host.sockets.push(socket);
    return socket;
}
export default { io };
`;

// Counts every time the stub replaced the page's socket.io module, across all channels in a run.
let ioStubRequests = 0;

class MockChannel {
    constructor(options) {
        this.base = options.base;
        this.fileFor = options.fileFor;
        this.routes = new Map();
        this.sequences = new Map();
        this.sequenceCounts = new Map();
        this.requests = [];
        this.violations = [];
        this.blockedExternal = [];
        this.ioRequests = 0;
        this.stateRoutes = new Map();
        this.serverRunning = false;
        for (const [key, journey, name] of DEFAULT_ROUTES) {
            this.route(key, fixtures.httpBody(journey, name), 'fixtures/http/' + journey + '/' + name + '.response');
        }
        this.ioStubRequested = false;
    }

    // body: Buffer | string | plain object (serialised by JSON.stringify, which is what the
    // recorded bytes already are); source: where the bytes came from, for the report.
    route(key, body, source) {
        this.routes.set(key, {
            body: Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'),
            source: source || 'authored input'
        });
        return this;
    }

    unroute(key) {
        this.routes.delete(key);
        this.sequences = this.sequences || new Map();
        this.sequences.delete(key);
        return this;
    }

    // Answer successive requests to `key` from a list of bodies (the last one repeats). Used for the
    // chart-history claim, where the assertion is about what the page draws from a value sequence.
    routeSequence(key, bodies, source) {
        this.sequences = this.sequences || new Map();
        this.sequences.set(key, bodies.map((body) => (Buffer.isBuffer(body)
            ? body
            : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'))));
        this.route(key, bodies[0], source || 'scripted input sequence');
        return this;
    }

    // Answer `key` from one of two recorded bodies, switched by the page's own POST /start and
    // POST /stop calls. The legacy page saw exactly this pair: `{"running":false}` while idle
    // (fixtures/http/J1-settings/status.response) and `{"running":true}` after it started a server
    // (fixtures/http/J5-ui-launch/start-from-ui-status.response). A static body would let the page's
    // 5 s status poll flip Launch/Stop under a check mid-iteration, which is a harness race, not a
    // claim about the app.
    routeOnStartStop(key, idle, running, sources) {
        const body = (value) => (Buffer.isBuffer(value) ? value
            : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'));
        this.stateRoutes.set(key, { idle: body(idle), running: body(running), source: sources });
        return this;
    }

    keyFor(url) {
        const parsed = new URL(url);
        return parsed.search ? parsed.pathname + parsed.search : parsed.pathname;
    }

    async install(context) {
        await context.route('**/*', async (route) => {
            const request = route.request();
            const url = request.url();
            const method = request.method();
            let parsed;
            try {
                parsed = new URL(url);
            } catch (error) {
                this.violations.push({ url, reason: 'unparseable request url' });
                return route.abort();
            }
            const sameOrigin = parsed.origin === this.base;
            if (!sameOrigin) {
                // Q12: the page keeps an external Google Fonts <link> and no offline support, so the
                // request is expected and blocked; nothing else may leave the page.
                this.blockedExternal.push({ url, resourceType: request.resourceType() });
                return route.abort();
            }
            if (parsed.pathname === '/socket.io.esm.min.js') {
                this.ioRequests += 1;
                ioStubRequests += 1;
                this.ioStubRequested = true;
                return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: IO_STUB });
            }
            const mapped = this.fileFor(parsed.pathname);
            // Only a real asset on disk stands aside; anything else is answered from the mock table,
            // and an untabled path is a violation rather than a silent static 404.
            if (mapped.exists) return route.continue();
            const path = this.keyFor(url);
            const stateful = this.stateRoutes.get(method + ' ' + parsed.pathname);
            if (stateful) {
                const stateBody = this.serverRunning ? stateful.running : stateful.idle;
                this.requests.push({ method, url, path: parsed.pathname, search: parsed.search,
                    key: method + ' ' + path, body: request.postData(), at: Date.now(),
                    resourceType: request.resourceType(), mocked: true,
                    source: stateful.source + (this.serverRunning ? ' (running)' : ' (idle)') });
                return route.fulfill({ status: 200, contentType: 'application/json', body: stateBody });
            }
            const lookupKey = (this.routes.has(method + ' ' + path) || this.routes.has(method + ' ' + parsed.pathname))
                ? (this.routes.has(method + ' ' + path) ? method + ' ' + path : method + ' ' + parsed.pathname)
                : null;
            const entry = lookupKey === null ? null : this.routeFor(lookupKey);
            this.requests.push({
                method, url, path: parsed.pathname, search: parsed.search, key: method + ' ' + path,
                body: request.postData(), at: Date.now(), resourceType: request.resourceType(),
                mocked: !!entry, source: entry ? entry.source : null
            });
            if (!entry) {
                this.violations.push({ url, reason: 'no fixture bytes mocked for ' + method + ' ' + path });
                return route.fulfill({ status: 500, contentType: 'application/json',
                    body: JSON.stringify({ success: false, error: 'L2 mock has no recording for ' + method + ' ' + path }) });
            }
            // The start/stop pair switches the stateful /status answer; both recorded bodies answer
            // `{"success":true}`, so the switch follows the page's own clicks.
            if (method === 'POST' && parsed.pathname === '/start') this.serverRunning = true;
            if (method === 'POST' && parsed.pathname === '/stop') this.serverRunning = false;
            return route.fulfill({ status: 200, contentType: 'application/json', body: entry.body });
        });
    }

    // A sequence rotates per request, so a check can drive the page with a recorded or scripted value
    // series instead of one canned body.
    routeFor(lookupKey) {
        const sequences = this.sequences || new Map();
        const sequence = sequences.get(lookupKey);
        if (!sequence) return this.routes.get(lookupKey);
        const counters = this.sequenceCounts = this.sequenceCounts || new Map();
        const index = counters.get(lookupKey) || 0;
        counters.set(lookupKey, index + 1);
        return { body: sequence[Math.min(index, sequence.length - 1)],
            source: this.routes.get(lookupKey) ? this.routes.get(lookupKey).source : 'sequence' };
    }

    // Wait until `count` requests with this key have been seen (the mock log is the observation).
    async waitFor(key, count, timeoutMs) {
        const limit = timeoutMs || 5000;
        const started = Date.now();
        while (Date.now() - started < limit) {
            if (this.of(key).length >= (count || 1)) return true;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return false;
    }

    of(key) {
        return this.requests.filter((request) => request.key === key || request.key === key.split('?')[0]);
    }

    last(key) {
        const rows = this.of(key);
        return rows.length ? rows[rows.length - 1] : null;
    }

    lastJson(key) {
        const request = this.last(key);
        return request && request.body ? JSON.parse(request.body) : null;
    }

    counts() {
        const out = {};
        for (const request of this.requests) out[request.key] = (out[request.key] || 0) + 1;
        return out;
    }
}

const ioRequestsTotal = () => ioStubRequests;
const resetIoRequestsTotal = () => { ioStubRequests = 0; };

module.exports = { MockChannel, DEFAULT_ROUTES, IO_STUB, ioRequestsTotal, resetIoRequestsTotal };
