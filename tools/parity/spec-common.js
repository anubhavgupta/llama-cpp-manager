#!/usr/bin/env node
// Shared helpers for the Phase 3 SPEC pack (plan.md §2 Phase 3).
//
// The pack is derived three independent ways and reconciled by machine:
//   (a) tools/parity/spec-static.js    — AST scan of the parity-baseline sources
//   (b) tools/parity/spec-runtime.js   — fixtures/** recordings only
//   (c) SPEC/from-model/*.json         — independent model pass over the source text
// tools/parity/spec-reconcile.js joins them into the SPEC/ pack per plan §4.
//
// This file owns only mechanics: reading the frozen baseline out of git, parsing it,
// walking an AST, the gap marker every derivation uses for "my evidence cannot see this",
// and canonical JSON output.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const acorn = require('acorn');

const REPO = path.resolve(__dirname, '..', '..');
const SPEC = path.join(REPO, 'SPEC');
const FIXTURES = path.join(REPO, 'fixtures');

const BASELINE = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'BASELINE.json'), 'utf8'));

// --- frozen baseline sources -------------------------------------------------------------
// (a) and (c) may only look at the parity-baseline bytes, so they come out of git and are
// checked against fixtures/BASELINE.json before anything parses them.
const sourceCache = new Map();
function baselineSource(file) {
    if (sourceCache.has(file)) return sourceCache.get(file);
    let bytes;
    try {
        bytes = execFileSync('git', ['show', `${BASELINE.tag}:${file}`], { cwd: REPO, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
        throw new Error(`cannot read ${BASELINE.tag}:${file} from git: ${error.message}`);
    }
    const text = bytes.toString('utf8').replace(/\r\n/g, '\n');
    const variants = { blob: sha256(bytes), crlf: sha256(Buffer.from(text.replace(/\n/g, '\r\n'), 'utf8')) };
    const pinned = BASELINE.files[file];
    // fixtures/BASELINE.json was written by sha256sum over the Phase 0 checkout, whose files
    // carried CRLF endings (git's eol=lf policy came in with the migration branch). Either
    // form satisfying the pin proves these are the frozen bytes.
    if (pinned && pinned !== variants.blob && pinned !== variants.crlf) {
        throw new Error(`${BASELINE.tag}:${file} sha256 ${JSON.stringify(variants)} matches neither fixtures/BASELINE.json pin ${pinned}`);
    }
    const matched = pinned === variants.crlf ? 'crlf-normalised checkout' : 'git blob';
    const src = { file, text, sha: pinned || variants.blob, shaForm: matched, provenance: `git:${BASELINE.tag}:${file}` };
    sourceCache.set(file, src);
    return src;
}

// --- parsing ----------------------------------------------------------------------------
function parseJs(text, file) {
    try {
        return acorn.parse(text, { ecmaVersion: 'latest', locations: true, sourceType: 'script' });
    } catch (scriptError) {
        try {
            return acorn.parse(text, { ecmaVersion: 'latest', locations: true, sourceType: 'module' });
        } catch (moduleError) {
            throw new Error(`acorn cannot parse ${file}: ${scriptError.message} / ${moduleError.message}`);
        }
    }
}

function walk(node, visit, parents = []) {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    visit(node, parents);
    const next = parents.concat([node]);
    for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
        const value = node[key];
        if (Array.isArray(value)) {
            for (const item of value) walk(item, visit, next);
        } else if (value && typeof value === 'object' && typeof value.type === 'string') {
            walk(value, visit, next);
        }
    }
}

// Collect every node of a kind inside a subtree, in source order.
function collect(root, kind, predicate = () => true) {
    const out = [];
    walk(root, (node) => { if (node.type === kind && predicate(node)) out.push(node); });
    return out.sort((a, b) => a.start - b.start);
}

const flat = (s) => String(s).replace(/\s+/g, ' ').trim();
function srcOf(src, node) { return node ? src.text.slice(node.start, node.end) : ''; }
function snippet(src, node, max = 300) {
    if (!node || typeof node.start !== 'number') return null;
    const text = flat(srcOf(src, node));
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
const lineOf = (node) => (node.loc ? node.loc.start.line : null);

function findFunction(ast, name) {
    let found = null;
    walk(ast, (node) => {
        if (found) return;
        if (node.type === 'FunctionDeclaration' && node.id && node.id.name === name) found = node;
        else if (node.type === 'VariableDeclarator' && node.id && node.id.name === name
            && node.init && /Function/.test(node.init.type)) found = node.init;
    });
    return found;
}

// --- the gap marker ---------------------------------------------------------------------
// Every derivation emits `null` for a value it cannot see, wrapped by a gap record in the
// artifact's `gaps` list, so "no evidence" is never mistaken for "evidence of absence".
function gap(reason) { return { __gap: true, reason }; }
const isGap = (value) => !!value && typeof value === 'object' && value.__gap === true;

// A value plus the evidence pointer that backs it. Static and model derivations point at
// source file:line; the runtime derivation points at fixture file + field.
function ev(...pointers) { return pointers.filter(Boolean); }

// --- canonical JSON ---------------------------------------------------------------------
// Keys sorted so a re-run is byte-reproducible and diffs stay meaningful; array order is
// the contract and is never reordered.
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
        return out;
    }
    return value;
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(canonical(value), null, 2) + '\n');
    return file;
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

// Walk up the enclosing branch guards of a node: the conditions that have to hold for it to
// run, outermost first. A guard reached through the `alternate` side is recorded as else /
// else-if because there its predicate is the negative side of the test.
function guardChain(node, src) {
    const chain = node.__parents || [];
    const within = (a, b) => !!a && !!b && b.start >= a.start && b.end <= a.end;
    const guards = [];
    for (let i = 0; i < chain.length; i++) {
        const cur = chain[i];
        if (cur.type !== 'IfStatement') continue;
        const deeper = i + 1 < chain.length ? chain[i + 1] : null;
        let kind = 'if';
        if (deeper && within(cur.alternate, deeper)) {
            kind = cur.alternate.type === 'IfStatement' ? 'else-if' : 'else';
        } else if (!(within(cur.consequent, deeper) || within(cur.test, deeper))) {
            continue;
        }
        guards.push({ kind, test: snippet(src, cur.test), line: lineOf(cur) });
    }
    return guards;
}

// Attach __parents so guard chains can be read off a node after the walk.
function withParents(root) {
    walk(root, (node, parents) => { Object.defineProperty(node, '__parents', { value: parents, enumerable: false, configurable: true }); });
    return root;
}

module.exports = {
    REPO, SPEC, FIXTURES, BASELINE,
    baselineSource, parseJs, walk, collect, flat, srcOf, snippet, lineOf, findFunction,
    gap, isGap, ev, canonical, writeJson, readJson, sha256, guardChain, withParents,
};
