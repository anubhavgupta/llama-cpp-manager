'use strict';
// PATH-MAP tokenisation (fixtures/PATH-MAP.json) for the seam suite.
//
// §9A remapped mode is a two-way contract: the corpus is rewritten into fixture tokens AND the
// recorded legacy expected output is rewritten by the same mapping, so byte equality stays
// meaningful on any machine. tools/parity/capture-legacy.js (Verifier-owned) records with exactly
// this rule set; the suite needs the inverse direction for observed bytes, so both live here:
//
//   resolve(value)  FIXTURE_ROOT/... -> <this run's scratch tree>, backslash form, exe token -> the
//                   compiled stand-in. Used on recorded goldens before comparing them to live bytes.
//   tokenize(text)  the same mapping backwards, used when two runs of the SAME suite in two
//                   different scratch roots have to be compared (L4 dual-run).
//
// The separator flip is not cosmetic: path.join builds the /models paths in backslash form, so a
// seeded modelPath must be backslash form or the <select> blanks it (Q18), and the committed corpus
// is all-forward-slash. The exe token ends in .cmd, which node refuses to spawn without a shell.

const fs = require('fs');
const path = require('path');

const MAP = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'fixtures',
    'PATH-MAP.json'), 'utf8'));
// The recording machine's roots, so a run anywhere else can re-point recorded input bytes (§9A).
const MANIFEST = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'fixtures',
    'MANIFEST.json'), 'utf8'));

const winPath = (value) => String(value).replace(/[\\/]+/g, '\\');
const fwdPath = (value) => String(value).replace(/[\\/]+/g, '/');
// The spelling a path takes inside JSON text, where every separator is escaped: "C:\\models\\a".
const doubleBackslash = (value) => String(value).split('\\').join('\\\\');
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class PathMap {
    constructor(options) {
        this.tokenRoot = MAP.tokenRoot;
        this.exeToken = MAP.exeToken;
        this.treeRoot = options.treeRoot;
        this.appDir = options.appDir;
        this.standin = options.standin;
        // The rest of the scratch root (bin/, argv logs) is just as machine-bound as the app and
        // fixture roots; L4's dual comparison needs one token for it, too.
        this.scratchRoot = options.scratchRoot;
    }

    // One token-bearing value -> machine path (capture-legacy buildTokenResolver's rule).
    resolve(value) {
        if (typeof value !== 'string') return value;
        if (value.indexOf(this.exeToken) === 0) return winPath(this.standin) + value.slice(this.exeToken.length);
        if (value.indexOf(this.tokenRoot) !== 0) return value;
        const text = value.split(this.tokenRoot).join(winPath(this.treeRoot));
        return text.split('/').join('\\');
    }

    // Recorded text whose values carry tokens -> the same text in this run's scratch space.
    // JSON arrays/objects are resolved element-wise; ini bytes are resolved per `key = value` line.
    resolveText(text) {
        const trimmed = text.trim();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            return JSON.stringify(this.walk(JSON.parse(text)));
        }
        return text.split('\n').map((line) => {
            const split = line.indexOf(' = ');
            if (split < 0) return line;
            const key = line.slice(0, split + 3);
            const value = line.slice(split + 3);
            return key + (value.indexOf(this.tokenRoot) === 0 ? this.resolve(value) : value);
        }).join('\n');
    }

    walk(node) {
        if (typeof node === 'string') return this.resolve(node);
        if (Array.isArray(node)) return node.map((entry) => this.walk(entry));
        if (node && typeof node === 'object') {
            const out = {};
            for (const key of Object.keys(node)) out[key] = this.walk(node[key]);
            return out;
        }
        return node;
    }

    // Machine bytes -> tokens, longest path first so the app root is not eaten by the tree root.
    // Both separator spellings map to the same forward-slash token form, which is how the committed
    // corpus is written; a value that differs ONLY in separators is therefore token-equal, and the
    // separator claim stays asserted by resolve()/resolveText() in the byte comparisons above.
    // Values that are JSON text (a response body, an argv jsonl line) carry the separators doubled.
    tokenize(text) {
        return this.replace(this.tokenPairs(), text);
    }

    // Bytes recorded on the recording machine -> this run's paths, for values the browser has to use
    // verbatim (a seeded localStorage entry, an argv token). §9A remapped mode applies the machine-
    // bound root to the expected/observed side too; this is that rule for recorded INPUT bytes.
    portable(text) {
        const pairs = [
            [MANIFEST.sandbox.fixtureTree, this.treeRoot],
            [MANIFEST.sandbox.app, this.appDir],
            [MANIFEST.sandbox.scratch, this.scratchRoot]
        ].filter(([recorded, mine]) => typeof recorded === 'string' && typeof mine === 'string'
            && winPath(recorded).toLowerCase() !== winPath(mine).toLowerCase())
            .sort((a, b) => winPath(String(b[0])).length - winPath(String(a[0])).length);
        return this.replace(pairs, text);
    }

    tokenPairs() {
        return [
            [this.standin, this.exeToken],
            [this.appDir, 'APP_ROOT'],
            [this.treeRoot, this.tokenRoot],
            [this.scratchRoot, 'SCRATCH_ROOT']
        ].filter(([value]) => value)
            // Longest path first, so a deeper root is never half-rewritten by a shorter prefix.
            .sort((a, b) => winPath(String(b[0])).length - winPath(String(a[0])).length);
    }

    // One pass over the text, longest spelling first, each spelling replaced by the replacement in
    // the SAME escaping. A path inside JSON text carries doubled separators, and a replacement that
    // ignored that would produce invalid JSON (`"C:\parity-scratch\..."`).
    replace(pairs, text) {
        const spellings = [];
        for (const [value, replacement] of pairs) {
            if (!value || replacement === undefined) continue;
            spellings.push([winPath(value), winPath(replacement)]);
            spellings.push([fwdPath(value), fwdPath(replacement)]);
            spellings.push([doubleBackslash(winPath(value)), doubleBackslash(winPath(replacement))]);
        }
        if (!spellings.length) return String(text);
        spellings.sort((a, b) => b[0].length - a[0].length);
        // A replacement that itself starts with the search prefix (`C:\parity-scratch` ->
        // `C:\parity-scratch\L4-a`) must not be rewritten again, which is why this is one pass and
        // not a sequence of split/join rounds.
        const pattern = new RegExp(spellings.map(([spelling]) => escapeRegExp(spelling)).join('|'), 'g');
        const bySpelling = new Map(spellings);
        return String(text).replace(pattern, (match) => {
            const replacement = bySpelling.get(match);
            return replacement === undefined ? match : replacement;
        });
    }
}

module.exports = { PathMap, winPath, fwdPath, MAP };
