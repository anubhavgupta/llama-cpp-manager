'use strict';

// Fixture access, the fixtures/COMPARISON.json comparison policy, the socket.io recorder and the
// named-assertion registry for the L1 backend conformance suite.
//
// §6.1: the suite is env-driven and never imports app code — it talks HTTP and socket.io only. The
// fixture tree is read as data, and the per-family comparison mode comes from the Verifier-owned
// policy file, so no check can quietly relax a byte claim of its own.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const FIXTURES = path.join(REPO, 'fixtures');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const winPath = (value) => String(value).replace(/[\\/]+/g, '\\');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class AssertionError extends Error {
    constructor(id, detail) {
        super(id + ': ' + detail);
        this.id = id;
        this.detail = detail;
    }
}

function fail(id, detail) {
    throw new AssertionError(id, detail);
}

function ok(condition, id, detail) {
    if (!condition) fail(id, detail);
}

// Printable expected/actual diff with the fixture path that produced the expectation.
function diffText(expected, actual, fixturePath) {
    const a = Buffer.isBuffer(expected) ? expected : Buffer.from(String(expected), 'utf8');
    const b = Buffer.isBuffer(actual) ? actual : Buffer.from(String(actual), 'utf8');
    let index = 0;
    const limit = Math.min(a.length, b.length);
    while (index < limit && a[index] === b[index]) index += 1;
    const from = Math.max(0, index - 60);
    const window = (buffer) => JSON.stringify(buffer.subarray(from, index + 60).toString('utf8'));
    return 'expected ' + a.length + ' bytes, got ' + b.length + '\n      fixture: ' + fixturePath +
        '\n      first difference at byte ' + index +
        '\n      expected: ' + window(a) +
        '\n      actual:   ' + window(b);
}

// ------------------------------------------------------------------ fixtures ----------------

const COMPARISON = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'COMPARISON.json'), 'utf8'));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'MANIFEST.json'), 'utf8'));

function fixturePath(rel) {
    return path.join(FIXTURES, ...rel.split('/'));
}

function fixtureBytes(rel) {
    const file = fixturePath(rel);
    if (!fs.existsSync(file)) fail('FIXTURE-MISSING', 'no fixture at ' + file);
    return fs.readFileSync(file);
}

function fixtureJson(rel) {
    return JSON.parse(fixtureBytes(rel).toString('utf8'));
}

function fixtureRequest(rel) {
    const record = fixtureJson(rel);
    return record.body;
}

function specJson(name) {
    const file = path.join(REPO, 'SPEC', name);
    if (!fs.existsSync(file)) fail('SPEC-MISSING', 'no SPEC file at ' + file);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const globCache = new Map();
function globToRegExp(glob) {
    if (globCache.has(glob)) return globCache.get(glob);
    let out = '^';
    for (let index = 0; index < glob.length; index += 1) {
        const char = glob[index];
        if (char === '*') {
            if (glob[index + 1] === '*') {
                if (glob[index + 2] === '/') { out += '(?:.*/)?'; index += 2; } else { out += '.*'; index += 1; }
            } else out += '[^/]*';
        } else if (char === '?') out += '[^/]';
        else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    const regexp = new RegExp(out + '$');
    globCache.set(glob, regexp);
    return regexp;
}

function ruleFor(rel) {
    return COMPARISON.rules.find((rule) => globToRegExp(rule.pathGlob).test(rel)) || null;
}

// The normalize/assert registries of tools/parity/capture-legacy.js, reimplemented here against
// the same policy file so the suite relaxes exactly what the Verifier declared relaxable, no more.
const NORMALIZE = {
    regexReplace: (text, op) => text.replace(new RegExp(op.pattern, op.flags || 'g'), op.replacement),
    replaceAll: (text, op) => text.split(op.find).join(op.with),
    jsonSubstitute: (text, op) => {
        const value = JSON.parse(text);
        for (const field of op.fields) if (field in value) value[field] = op.placeholder;
        return JSON.stringify(value);
    },
    jsonlSubstitute: (text, op) => text.split('\n').filter((line) => line.trim() !== '').map((line) => {
        const value = JSON.parse(line);
        if (op.field in value) value[op.field] = op.placeholder;
        return JSON.stringify(value);
    }).join('\n'),
    wsCollapseLogStreams: (text, op) => {
        const value = JSON.parse(text);
        const runs = new Map();
        const events = [];
        for (const entry of value.events) {
            if (entry.event !== op.event) { events.push(entry); continue; }
            const key = String(entry.payload[op.typeField]);
            if (!runs.has(key)) {
                runs.set(key, { runOf: key, bytes: Buffer.alloc(0) });
                events.push({ seq: -events.length, event: entry.event,
                    payload: { [op.typeField]: entry.payload[op.typeField], [op.payloadField]: runs.get(key) } });
            }
            const run = runs.get(key);
            run.bytes = Buffer.concat([run.bytes, Buffer.from(entry.payload[op.payloadField], 'base64')]);
        }
        for (const event of events) {
            if (event.payload && event.payload[op.payloadField] && event.payload[op.payloadField].runOf) {
                const run = event.payload[op.payloadField];
                event.payload[op.payloadField] = run.bytes.toString('base64');
                event.payload[op.payloadField + 'ByteLength'] = run.bytes.length;
            }
        }
        events.forEach((event, index) => { if (typeof event.seq === 'number') event.seq = index; });
        return JSON.stringify({ connection: value.connection, url: value.url, events });
    }
};

const ASSERT = {
    jsonNumberBounds: (text, rule) => {
        const errors = [];
        const value = JSON.parse(text);
        for (const spec of rule.bounds) {
            const observed = value[spec.field];
            if (typeof observed !== 'number' || !Number.isFinite(observed)) {
                errors.push(spec.field + ' is not a finite number: ' + JSON.stringify(observed));
            } else if (observed < spec.min || observed > spec.max) {
                errors.push(spec.field + '=' + observed + ' outside [' + spec.min + ', ' + spec.max + ']');
            }
        }
        return errors;
    },
    fieldRegexMatch: (text, rule) => {
        const observed = String(JSON.parse(text)[rule.field]);
        return new RegExp(rule.pattern).test(observed) ? []
            : [rule.field + '=' + JSON.stringify(observed) + ' does not match /' + rule.pattern + '/'];
    },
    regexFullMatch: (text, rule) => new RegExp(rule.pattern, rule.flags || '').test(text) ? []
        : ['content does not match /' + rule.pattern + '/\n      actual: ' + JSON.stringify(text.slice(0, 240))],
    wsPartialLines: (text, rule) => {
        const value = JSON.parse(text);
        const partial = value.events.filter((entry) => entry.event === rule.event &&
            Buffer.from(entry.payload[rule.payloadField], 'base64').toString('utf8').indexOf('\n') < 0);
        return partial.length >= rule.min ? []
            : ['expected at least ' + rule.min + ' partial-line ' + rule.event + ' payloads, saw ' + partial.length];
    }
};

// Compare one live response/body against its recorded fixture under the declared mode.
// Returns the rule id that justified any relaxation, so the report can name it.
function compareFixture(rel, actual) {
    const expected = fixtureBytes(rel);
    const rule = ruleFor(rel);
    const label = 'fixtures/' + rel;
    if (!rule || rule.mode === 'exact') {
        ok(expected.equals(actual), 'BYTES-' + rel.replace(/[^A-Za-z0-9]+/g, '-').toUpperCase(),
            diffText(expected, actual, label));
        return rule ? rule.id : 'defaultMode:' + COMPARISON.defaultMode;
    }
    if (rule.mode === 'informational') {
        fail('POLICY', rel + ' is informational (' + rule.id + '); its byte claim lives in ' +
            rule.claimedBy + ' — compare that file instead of this one');
    }
    const textExpected = expected.toString('utf8');
    const textActual = actual.toString('utf8');
    if (textExpected !== textActual) {
        let normalizedExpected = textExpected;
        let normalizedActual = textActual;
        for (const op of rule.normalize || []) {
            const implement = NORMALIZE[op.op];
            if (!implement) fail('POLICY', 'rule ' + rule.id + ' uses an unimplemented op ' + op.op);
            normalizedExpected = implement(normalizedExpected, op);
            normalizedActual = implement(normalizedActual, op);
        }
        ok(normalizedExpected === normalizedActual, 'SHAPE-' + rule.id,
            'shape rule ' + rule.id + ' still differs\n      fixture: ' + label +
            '\n      expected: ' + JSON.stringify(normalizedExpected.slice(0, 300)) +
            '\n      actual:   ' + JSON.stringify(normalizedActual.slice(0, 300)));
    }
    for (const spec of rule.assert || []) {
        const implement = ASSERT[spec.op];
        if (!implement) fail('POLICY', 'rule ' + rule.id + ' asserts an unimplemented op ' + spec.op);
        const errors = implement(textActual, spec);
        ok(errors.length === 0, 'ASSERT-' + rule.id + '-' + spec.op,
            'shape rule ' + rule.id + ' assert ' + spec.op + ' failed:\n      ' + errors.join('\n      '));
    }
    return rule.id;
}

// Recorded request bodies carry the recording machine's scratch root and node executable. The
// suite posts the SAME body the recording posted (§ the argv-golden claim needs identical input);
// the two machine-bound tokens are re-pointed at this run's sandbox, and everything else stays
// byte-identical.
function replayBody(body) {
    const recordedScratch = MANIFEST.sandbox.scratch;
    const root = process.env.PARITY_REPLAY_ROOT || recordedScratch;
    const recordedNode = /^"?(C:[^ ]*?node\.exe)"?/.exec(
        fixtureBytes('http/J3-start-stop/start.request.json').toString('utf8'));
    const replacement = recordedNode ? recordedNode[1].replace(/\\\\/g, '\\') : null;
    const walk = (node) => {
        if (typeof node === 'string') {
            let text = node.split(winPath(recordedScratch)).join(winPath(root))
                .split(recordedScratch).join(root);
            if (replacement) text = text.split(winPath(replacement)).join(winPath(process.execPath));
            return text;
        }
        if (Array.isArray(node)) return node.map(walk);
        if (node && typeof node === 'object') {
            const out = {};
            for (const key of Object.keys(node)) out[key] = walk(node[key]);
            return out;
        }
        return node;
    };
    return walk(body);
}

// ------------------------------------------------------------------ ws recorder ----------------

// socket.io-client with the same defaults public/script.js uses (polling first, then upgrade).
// Every event name + payload is kept in arrival order; log-stream payloads are kept as raw
// Buffers so chunk forwarding is provable with no reassembly, trim or re-encoding.
class WsRecorder {
    constructor(url, connectionId) {
        this.connectionId = connectionId;
        this.url = url;
        this.events = [];
        this.socket = require('socket.io-client').io(url, { forceNew: true });
        this.socket.onAny((event, ...args) => this.push(event, args));
        this.socket.on('connect', () => this.push('connect', [null]));
    }

    static async connect(url, connectionId) {
        const recorder = new WsRecorder(url, connectionId);
        const open = await waitFor('socket ' + connectionId + ' connect', 20000, () => recorder.socket.connected);
        ok(open, 'SOCKET-CONNECT', 'socket.io client ' + connectionId + ' never reached connected=true at ' + url);
        return recorder;
    }

    push(event, args) {
        const payload = args.length === 0 ? null : args[0];
        const entry = { seq: this.events.length + 1, event };
        if (payload && typeof payload === 'object') entry.wireKeys = Object.keys(payload).sort();
        if (event === 'log-stream' && payload && typeof payload.data === 'string') {
            entry.bytes = Buffer.from(payload.data, 'utf8');
            entry.payload = { type: payload.type, dataBase64: entry.bytes.toString('base64'),
                dataLength: entry.bytes.length };
        } else {
            entry.payload = payload === undefined ? null : payload;
        }
        this.events.push(entry);
    }

    count(name) { return this.events.filter((entry) => entry.event === name).length; }

    stream(type) {
        return Buffer.concat(this.events
            .filter((entry) => entry.event === 'log-stream' && entry.payload && entry.payload.type === type)
            .map((entry) => entry.bytes));
    }

    indexOf(name) { return this.events.findIndex((entry) => entry.event === name); }

    async close() {
        this.socket.close();
        await waitFor('socket ' + this.connectionId + ' disconnect', 5000,
            () => this.events.some((entry) => entry.event === 'disconnect'));
    }

    static async closeAll(recorders) {
        for (const recorder of recorders) { try { recorder.socket.close(); } catch (error) { /* gone */ } }
    }

    // The compared form fixtures/ws/**/events.json carries: same shape rule, same normalization.
    toFixtureEvents() {
        return { connection: this.connectionId, url: this.url,
            events: this.events.map((entry) => ({ seq: entry.seq, event: entry.event, payload: entry.payload })) };
    }
}

async function waitFor(label, timeoutMs, predicate) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return true;
        await delay(25);
    }
    return predicate();
}

// --------------------------------------------------------------- check registry -------------

class Registry {
    constructor() {
        this.results = [];
    }

    async check(id, quirk, fn) {
        const entry = { id, quirk: quirk || 'contract', status: 'pass', detail: '' };
        this.results.push(entry);
        try {
            const detail = await fn();
            if (detail) entry.detail = String(detail);
        } catch (error) {
            entry.status = 'fail';
            entry.detail = (error && error.detail) ? (error.id + ' — ' + error.detail)
                : ((error && error.stack) ? error.stack : String(error));
        }
        return entry;
    }

    get failures() { return this.results.filter((entry) => entry.status === 'fail'); }
}

module.exports = {
    FIXTURES, REPO, COMPARISON, MANIFEST, Registry, AssertionError, WsRecorder,
    ASSERT, NORMALIZE, assert: ok, compareFixture, delay, diffText, fail, fixtureBytes, fixtureJson,
    fixturePath, fixtureRequest, globToRegExp, ruleFor, replayBody, sha256, specJson, waitFor, winPath
};
