'use strict';
// The page the L2 suite drives: static assets only, served from a sandbox copy of a git ref
// (default parity-baseline). No manager process exists for L2: every fetch is answered from
// fixtures/http bytes by helpers/mocks.js, so nothing here needs express, node_modules or a
// backend — and nothing here imports app code either (plan §6 rule 1).

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');

function git(args) {
    return spawnSync('git', args, { cwd: REPO, encoding: 'utf8' }).stdout.trim();
}

function isFile(candidate) {
    try {
        return fs.statSync(candidate).isFile();
    } catch (error) {
        return false;
    }
}

function isDir(candidate) {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch (error) {
        return false;
    }
}

// --ref may be a git ref (extracted with `git archive`, so the sandbox is the ref's own bytes and
// not the working tree), the literal `worktree` (the working tree's own public/ + legacy/lib), or a
// directory that already holds an app (Part 2 points it at a candidate build).
function resolveRef(ref) {
    if (ref === 'worktree') return { kind: 'worktree', dir: REPO, sha: git('rev-parse HEAD') };
    if (isDir(ref) && (isDir(path.join(ref, 'public')) || isDir(path.join(ref, 'legacy')))) {
        return { kind: 'dir', dir: path.resolve(ref), sha: 'dir' };
    }
    const sha = git(['rev-parse', ref + '^{commit}']);
    if (!sha) throw new Error('--ref: not a git ref, a directory or "worktree": ' + ref);
    return { kind: 'ref', ref, sha };
}

// Extracted with ls-tree + cat-file rather than `git archive | tar`: the MSYS GNU tar on this
// machine rejects Windows drive paths ("Cannot connect to C:"), and shelling out through a pipe
// would make the failure mode depend on which tar is on PATH. The ref's own bytes are what the
// suite must serve, not the working tree.
function extract(ref, target) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    const listing = spawnSync('git', ['ls-tree', '-r', '-z', ref.sha], { cwd: REPO });
    if (listing.status !== 0) {
        return Promise.reject(new Error('git ls-tree exited ' + listing.status + ': '
            + listing.stderr.toString('utf8')));
    }
    const entries = listing.stdout.toString('utf8').split('\0').filter((line) => line !== '').map((line) => {
        const [meta, file] = line.split('\t');
        const [mode, type, sha] = meta.split(' ');
        return { mode, type, sha, file };
    });
    for (const entry of entries) {
        if (entry.type !== 'blob') continue;
        const blob = spawnSync('git', ['cat-file', 'blob', entry.sha], { cwd: REPO, maxBuffer: 64 << 20 });
        if (blob.status !== 0) {
            return Promise.reject(new Error('git cat-file ' + entry.sha + ' exited ' + blob.status));
        }
        const dest = path.join(target, entry.file);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, blob.stdout);
    }
    fs.writeFileSync(path.join(target, '.l2-ref'), ref.sha + '\n');
    return Promise.resolve(target);
}

// Sandbox root stays outside the repo (plan §10 blast radius) and outside any user home, so no
// machine path can leak into an artifact the suite writes.
async function prepareSandbox(ref, options) {
    const resolved = resolveRef(ref);
    if (resolved.kind !== 'ref') return { ...resolved, app: resolved.dir, cached: true };
    const scratch = options.scratch || process.env.L2_SCRATCH || 'C:/parity-l2';
    const normalized = path.resolve(scratch);
    // Lowercase the CANDIDATE too: startsWith against a lowercased needle can never match a
    // drive-lettered 'C:\...' — the original order made this guard dead code.
    const norm = normalized.toLowerCase();
    if (norm.startsWith((REPO + path.sep).toLowerCase()) || norm === REPO.toLowerCase()) {
        throw new Error('refusing to use a sandbox inside the repo: ' + normalized);
    }
    const app = path.join(normalized, 'app');
    const marker = path.join(app, '.l2-ref');
    const cached = fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === resolved.sha
        && isDir(path.join(app, 'public'));
    if (!cached || options.refresh) {
        await extract(resolved, app);
    }
    return { ...resolved, app, cached, scratch: normalized };
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8'
};

// Mirrors what server.js serves for the page: express.static('public') plus /lib -> legacy/lib
// (the extraction commit added that route; at parity-baseline the directory does not exist and the
// page never asks for it).
function fileFor(app, urlPath) {
    const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
    const rel = clean === '/' || clean === '' ? 'index.html'
        : clean.replace(/^\/+/, '');
    const root = rel.startsWith('lib/') ? path.join(app, 'legacy') : path.join(app, 'public');
    const leaf = rel.startsWith('lib/') ? rel.slice('lib/'.length) : rel;
    const full = path.resolve(root, leaf);
    const within = full === root || full.startsWith(root + path.sep);
    // `exists` is what the fetch mock asks before standing aside: `full` is only a candidate path, and
    // treating it as "served" sent /models and /status to the static server (404) instead of to the
    // recorded fixture bytes.
    return { full: within ? full : null, rel, exists: within && isFile(full) };
}

function startStaticServer(app, port) {
    const served = [];
    const missing = [];
    const server = http.createServer((req, res) => {
        const mapped = fileFor(app, req.url);
        served.push({ method: req.method, url: req.url, file: mapped.rel });
        if (!mapped.exists) {
            missing.push(req.url);
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('not found: ' + mapped.rel);
            return;
        }
        const body = fs.readFileSync(mapped.full);
        // Playwright aborts in-flight requests when a context closes; a write to that socket throws
        // EPIPE out of the event loop unless the socket has a handler.
        res.socket.on('error', () => {});
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(mapped.full).toLowerCase()] || 'application/octet-stream',
            'Content-Length': body.length,
            'Cache-Control': 'no-store'
        });
        res.end(body);
    });
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.on('clientError', (_error, socket) => socket.destroy());
        server.on('connection', (socket) => socket.on('error', () => {}));
        server.listen(port, '127.0.0.1', () => resolve({
            server,
            port,
            base: 'http://localhost:' + port,
            served,
            missing,
            close: () => new Promise((done) => server.close(done))
        }));
    });
}

module.exports = { REPO, resolveRef, prepareSandbox, startStaticServer, fileFor, git };
