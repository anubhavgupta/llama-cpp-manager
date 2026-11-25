#!/usr/bin/env node
'use strict';
// Phase 2.6 (plan.md §2): mutant enumeration over the two pure generators.
//
//   node tools/parity/mutate.js --dump        write reports/mutation/mutants.json (no vector runs)
//   node tools/parity/mutate.js --selftest    the enumeration gates (determinism + row coverage)
//
// What is mutated is the BASELINE text, never legacy/lib and never public/script.js: the slice texts
// from tools/parity/baseline-slices.js are mutated in memory and recompiled (the "extension" Phase 2.6
// asks for — this file is the extension, baseline-slices.js is untouched). A golden is baseline output,
// so "mutant output != golden" is exactly "some vector distinguishes the mutant from legacy", which is
// the kill definition. Mutating lib instead would measure the extraction, not the vectors.
//
// Site inventory is SPEC/SPEC-ROWS.csv, not a hand list: every BA-*/INI-* row whose file is one of the
// two generators contributes its own line + kind (operator class), and every SCV-* row (the
// saveCurrentValues writer) contributes a site in the `save` region. A row's snippet is located inside
// the baseline slice by shape-matching (a DOM read and its `fields.<id>` substitute collapse to one
// marker), so the mutation lands on the baseline spelling of the row's own expression and on nothing
// else that shares the line.
//
// Determinism: the mutant set is a pure function of the parity-baseline text + SPEC-ROWS.csv. No seed
// is needed (nothing is random here); mutants are sorted by (region, line, start, class, after) and
// each id is that position plus a sha256 of the mutation itself, so --dump is byte-identical rerun.

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const slices = require('./baseline-slices.js');
const vectors = require('./gen-vectors.js');

const REPO = slices.REPO;
const REPORTS = path.join(REPO, 'tools', 'parity', 'reports', 'mutation');
const SNAPSHOT = path.join(REPORTS, '.snapshot');
const MUTANT_FILE = 'tools/parity/reports/mutation/mutants.json';

// The committed state every byte of this run is pinned to: the vectors/goldens the kill check reads
// come from the private snapshot, the generator text comes from parity-baseline via git.
const BASE_COMMIT = '9d6a767d43a4276f3af506d2ee7a75930580e796';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const collapse = (text) => text.trim().replace(/\s+/g, ' ');

function assert(condition, message) {
    if (!condition) throw new Error('mutate: ' + message);
}

// ---------------------------------------------------------------- committed inputs --------

// One mutation run is only comparable with the ledger if its inputs are the committed ones. The
// vectors/goldens snapshot is verified by snapshot.js; everything else this file reads is checked
// against the base commit here, so a concurrent re-record can never be mistaken for this baseline.
const STATE_NOTES = 'fixtures/screenshots/J5-ui-states/state-notes.json';

function gitBytes(rel) {
    return execFileSync('git', ['show', BASE_COMMIT + ':' + rel],
        { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
}

// The recorded form states are the only part of state-notes.json either generator path reads: the
// per-element `fields` arrays decide which ids are checkboxes (fieldKinds) and what the fresh-page
// reference input is. The stored localStorage blobs in the same file are re-recorded by the Phase 1
// refresh and are not read here, so the gate is on the arrays, not on the whole file's bytes.
function formStateShapes(text) {
    const notes = JSON.parse(text);
    const out = {};
    for (const name of Object.keys(notes.storageStates || {})) {
        out[name] = JSON.stringify(notes.storageStates[name].fields);
    }
    return out;
}

function committedInputs() {
    const watched = [
        'SPEC/SPEC-ROWS.csv',
        'legacy/lib/buildArgs.js',
        'legacy/lib/buildPresetIni.js',
        'fixtures/corpus/configs.remapped.json'
    ];
    const drift = [];
    for (const rel of watched) {
        let git;
        try {
            git = gitBytes(rel);
        } catch (error) {
            drift.push(rel + ': not in ' + BASE_COMMIT.slice(0, 7));
            continue;
        }
        const disk = fs.readFileSync(path.join(REPO, rel));
        if (sha256(git) !== sha256(disk)) drift.push(rel + ': disk differs from ' + BASE_COMMIT.slice(0, 7));
    }
    let states;
    try {
        const committed = formStateShapes(gitBytes(STATE_NOTES).toString('utf8'));
        const live = formStateShapes(fs.readFileSync(path.join(REPO, STATE_NOTES), 'utf8'));
        states = { file: STATE_NOTES, states: Object.keys(live).sort(),
            bytes_equal_to_base: sha256(Buffer.from(gitBytes(STATE_NOTES))) === sha256(fs.readFileSync(path.join(REPO, STATE_NOTES))) };
        if (JSON.stringify(committed) !== JSON.stringify(live)) {
            drift.push(STATE_NOTES + ': the recorded form-state fields differ from ' + BASE_COMMIT.slice(0, 7));
        }
    } catch (error) {
        drift.push(STATE_NOTES + ': ' + String(error && error.message));
    }
    return { base: BASE_COMMIT, drift: drift, watched: watched, form_states: states };
}

function requireCommittedInputs() {
    const gate = committedInputs();
    assert(gate.drift.length === 0, 'committed-input gate failed:\n  ' + gate.drift.join('\n  '));
    return gate;
}

// ------------------------------------------------------------------- text scanning --------

// A DOM read (`nglInput.value`, `document.getElementById('parallel').value`) and the extraction's
// `fields.<id>` substitute are the same thing at the same position, so both collapse to one marker
// character. `window.` is dropped for the same reason (the ini extraction takes models as a
// parameter). Everything else — identifiers, literals, operators — is kept, so a shape match is a
// real position match, and `map` converts a shape offset back to an offset in the raw line.
const READ_RE = /document\.getElementById\('[^']+'\)\.(?:value|checked)|\b[A-Za-z_$][\w$]*\.(?:value|checked)\b|\bfields\.[A-Za-z0-9_]+\b|window\.(?=[A-Za-z_$])/g;

function shapeOf(text) {
    let shape = '';
    const map = [];
    let last = 0;
    const push = (chunk, from) => {
        for (let i = 0; i < chunk.length; i += 1) {
            shape += chunk[i];
            map.push({ start: from + i, end: from + i + 1 });
        }
    };
    READ_RE.lastIndex = 0;
    let match;
    while ((match = READ_RE.exec(text)) !== null) {
        push(text.slice(last, match.index), last);
        if (match[0] !== 'window.') {
            shape += '@';
            map.push({ start: match.index, end: match.index + match[0].length });
        }
        last = match.index + match[0].length;
    }
    push(text.slice(last), last);
    return { shape: shape, map: map, raw: text };
}

// Find a needle's shape inside a line's shape and return the raw [start, end) it covers.
function spanInLine(line, needle) {
    const lineShape = shapeOf(line);
    const needleShape = shapeOf(needle).shape;
    const at = lineShape.shape.indexOf(needleShape);
    if (at < 0) return null;
    return { start: lineShape.map[at].start, end: lineShape.map[at + needleShape.length - 1].end };
}

// Token scan of one source line: what is code, what is a string/template literal, what is a numeric
// literal, and where a line comment starts. Quote-aware; regex literals are reported so callers can
// skip their innards instead of mistaking `[/\\]` for division or for a string.
function scanLine(line) {
    const out = { strings: [], numbers: [], regexes: [], commentAt: -1 };
    for (let i = 0; i < line.length; i += 1) {
        const c = line[i];
        if (c === '/' && line[i + 1] === '/') { out.commentAt = i; break; }
        if (c === "'" || c === '"') {
            const end = scanQuote(line, i, c);
            out.strings.push({ start: i, end: end });
            i = end - 1;
            continue;
        }
        if (c === '`') {
            const end = scanTemplate(line, i);
            out.strings.push({ start: i, end: end, template: true });
            i = end - 1;
            continue;
        }
        if (c === '/' && regexAllowed(line, i)) {
            const end = scanRegex(line, i);
            if (end > i) { out.regexes.push({ start: i, end: end }); i = end - 1; continue; }
        }
        if (/[0-9]/.test(c) && !/[\w$.]/.test(line[i - 1] || '')) {
            let j = i;
            while (j < line.length && /[\dxX.eE+-]/.test(line[j])) {
                if ((line[j] === '+' || line[j] === '-') && !/[eE]/.test(line[j - 1] || '')) break;
                j += 1;
            }
            const text = line.slice(i, j);
            if (/^(\d+\.?\d*|\.\d+|0[xX][0-9a-fA-F]+)$/.test(text)) {
                out.numbers.push({ start: i, end: j, text: text });
            }
            i = j - 1;
            continue;
        }
    }
    return out;
}

function scanQuote(line, at, quote) {
    for (let i = at + 1; i < line.length; i += 1) {
        if (line[i] === '\\') { i += 1; continue; }
        if (line[i] === quote) return i + 1;
    }
    return line.length;
}

// Template literals nest `${ ... }`; the closing backtick of the outer literal is what we return.
function scanTemplate(line, at) {
    let depth = 0;
    for (let i = at + 1; i < line.length; i += 1) {
        const c = line[i];
        if (c === '\\') { i += 1; continue; }
        if (depth === 0 && c === '`') return i + 1;
        if (c === '$' && line[i + 1] === '{') { depth += 1; i += 1; continue; }
        if (depth > 0 && c === '}') depth -= 1;
    }
    return line.length;
}

function scanRegex(line, at) {
    let inClass = false;
    for (let i = at + 1; i < line.length; i += 1) {
        const c = line[i];
        if (c === '\\') { i += 1; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
            let j = i + 1;
            while (j < line.length && /[a-z]/.test(line[j])) j += 1;
            return j;
        }
    }
    return at;
}

// A `/` starts a regex only where a value can begin (after an operator / `(` / `,` / `=` / `return`).
function regexAllowed(line, at) {
    for (let i = at - 1; i >= 0; i -= 1) {
        const c = line[i];
        if (/\s/.test(c)) continue;
        return /[=(,:[!&|?{};+*/%-]|^return$/.test(c) || line.slice(0, i + 1).endsWith('return');
    }
    return true;
}

// Top-level (depth 0, quote aware) occurrences of an operator inside a span of text. The search is
// deliberately depth-0: a row's own operator is the one its snippet tests, and an operator nested in a
// call or a sub-condition belongs to a different row.
function topOperators(text, operators) {
    const found = [];
    let depth = 0;
    for (let i = 0; i < text.length; i += 1) {
        const c = text[i];
        if (c === "'" || c === '"' || c === '`') { i = (c === '`' ? scanTemplate(text, i) : scanQuote(text, i, c)) - 1; continue; }
        if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') depth -= 1;
        else if (depth === 0) {
            const hit = operators.filter((op) => text.startsWith(op, i))
                .sort((a, b) => b.length - a.length)[0];
            if (hit) {
                found.push({ start: i, end: i + hit.length, text: hit });
                i += hit.length - 1;
            }
        }
    }
    return found;
}

// -------------------------------------------------------------------- regions -------------

// region name -> {text, lines, func: how baseline-slices compiles it}
function regionSources(gen) {
    return {
        config: { text: gen.slices.config, lines: gen.slices.config.split('\n') },
        args: { text: gen.slices.args, lines: gen.slices.args.split('\n') },
        ini: { text: gen.slices.ini, lines: gen.slices.ini.split('\n') },
        // The localStorage writer: the region whose re-saved bytes the Q16 claims rest on. Its sites
        // are the SCV-* rows, its kill corpus is the recorded re-save family.
        save: { text: gen.slices.save, lines: gen.slices.save.split('\n') }
    };
}

// SCV-* rows cite public/script.js line numbers and the save slice is cut from that same file, so the
// row's line maps onto the region by the anchor's own line — no shape walk needed (BA/INI rows cite lib
// line numbers, which is why those regions align through alignments()).
function saveRegionOffset(gen) {
    const at = gen.baseline.indexOf(slices.ANCHORS.SAVE_START);
    assert(at >= 0, 'ANCHORS.SAVE_START is not in the parity-baseline script.js');
    return gen.baseline.slice(0, at).split('\n').length - 1;
}

function libLines(rel) {
    return slices.readText(path.join(REPO, rel)).split(/\r?\n/);
}

// The line ranges of the extracted regions inside the lib files, so a SPEC-ROWS line number (which is
// a lib line number) can be attributed to a region.
function libRanges() {
    const args = libLines('legacy/lib/buildArgs.js');
    const ini = libLines('legacy/lib/buildPresetIni.js');
    const at = (lines, text) => {
        const i = lines.findIndex((line) => collapse(line) === text);
        assert(i >= 0, 'lib anchor not found: ' + text);
        return i + 1;
    };
    const configStart = at(args, 'const config = {');
    const configEnd = at(args.slice(configStart), '};') + configStart;
    return {
        'legacy/lib/buildArgs.js': {
            config: [configStart, configEnd],
            args: [at(args, '// Build command arguments'), args.length]
        },
        'legacy/lib/buildPresetIni.js': { ini: [at(ini, "let presetContent = 'version = 1\\n\\n';"), ini.length] }
    };
}

// Align lib lines to baseline slice lines: both sides are the same source, so a monotone walk over
// collapsed shapes matches them in order. Blank lines carry no site and are skipped on both sides.
function alignLines(baselineLines, libLinesList) {
    const pairs = new Map();
    let cursor = 0;
    for (let i = 0; i < libLinesList.length; i += 1) {
        const libLine = collapse(libLinesList[i]);
        if (libLine === '') continue;
        const libShape = shapeOf(libLine).shape;
        let found = -1;
        for (let j = cursor; j < baselineLines.length; j += 1) {
            const baseLine = collapse(baselineLines[j]);
            if (baseLine === '') continue;
            if (shapeOf(baseLine).shape === libShape) { found = j; break; }
        }
        if (found >= 0) {
            pairs.set(i + 1, found);
            cursor = found;
        }
    }
    return pairs;
}

function alignments(gen) {
    const regions = regionSources(gen);
    const out = {};
    const argsLib = libLines('legacy/lib/buildArgs.js');
    const iniLib = libLines('legacy/lib/buildPresetIni.js');
    const ranges = libRanges();
    const [configStart, configEnd] = ranges['legacy/lib/buildArgs.js'].config;
    const [argsStart] = ranges['legacy/lib/buildArgs.js'].args;
    const [iniStart] = ranges['legacy/lib/buildPresetIni.js'].ini;
    // alignLines keys its pairs by position inside the slice it was handed; SPEC-ROWS carries absolute
    // lib line numbers, so the keys are shifted back to absolute here.
    const shift = (pairs, offset) => new Map([...pairs].map(([k, v]) => [k + offset, v]));
    out.config = {
        pairs: shift(alignLines(regions.config.lines, argsLib.slice(configStart - 1, configEnd)),
            configStart - 1),
        region: 'config'
    };
    out.args = {
        pairs: shift(alignLines(regions.args.lines, argsLib.slice(argsStart - 1)), argsStart - 1),
        region: 'args'
    };
    out.ini = {
        pairs: shift(alignLines(regions.ini.lines, iniLib.slice(iniStart - 1)), iniStart - 1),
        region: 'ini'
    };
    return out;
}

// ------------------------------------------------------------------- block body -----------

// The statements a row guards. `{` blocks are brace-matched over the region; a brace-less body
// (`if (c) args.push(x);`) is the remainder of the same line.
function codeOnly(line) {
    const scan = scanLine(line);
    const code = line.slice(0, scan.commentAt < 0 ? line.length : scan.commentAt);
    let clean = '';
    for (let j = 0; j < code.length; j += 1) {
        const inString = scan.strings.some((s) => j >= s.start && j < s.end - 1)
            || scan.regexes.some((s) => j >= s.start && j < s.end - 1);
        clean += inString ? ' ' : code[j];
    }
    return clean;
}

function matchingBrace(lines, openLine) {
    let depth = 0;
    for (let i = openLine; i < lines.length; i += 1) {
        const clean = codeOnly(lines[i]);
        for (const c of clean) {
            if (c === '{') depth += 1;
            else if (c === '}') {
                depth -= 1;
                if (depth === 0) return i;
            }
        }
    }
    return -1;
}

const EMITS = /^(args\.push\(|presetContent\s*\+=|presetContent\s*=|specTypes\.push\(|sectionName\s*=)/;

function bodyStatements(lines, site) {
    const line = lines[site.line];
    const open = line.indexOf('{', site.end);
    if (open >= 0) {
        const close = matchingBrace(lines, site.line);
        if (close < 0) return { kind: 'block', first: site.line + 1, last: site.line, statements: [] };
        const statements = [];
        let i = site.line + 1;
        while (i < close) {
            const scan = scanLine(lines[i]);
            const trimmedStart = lines[i].trimStart();
            if (collapse(lines[i]) !== '' && scan.commentAt !== 0 && EMITS.test(trimmedStart)) {
                let last = i;
                let depth = 0;
                while (last < close) {
                    const text = lines[last];
                    for (const c of text) {
                        if (c === '(') depth += 1;
                        else if (c === ')') depth -= 1;
                    }
                    if (depth <= 0) break;
                    last += 1;
                }
                statements.push({ first: i, last: last });
                i = last + 1;
                continue;
            }
            i += 1;
        }
        return { kind: 'block', first: site.line + 1, last: close - 1, statements: statements };
    }
    const tail = line.slice(site.end);
    if (/;\s*$/.test(tail) && EMITS.test(tail.trimStart())) {
        const start = site.end + tail.length - tail.trimStart().length;
        return {
            kind: 'line', first: site.line, last: site.line,
            statements: [{ first: site.line, last: site.line, start: start, end: line.length - 1 }]
        };
    }
    return { kind: 'none', first: site.line, last: site.line, statements: [] };
}

// ------------------------------------------------------------------ operators -------------

// One mutation = {class, line, start, end, after} inside one region. `before` is read back out of the
// region text so it can never disagree with the text the mutant is built from.
const SENTINEL = 'X';

function boundaryFlip(op) {
    return { '>': '>=', '>=': '>', '<': '<=', '<=': '<' }[op] || null;
}
const REVERSE = { '>': '<', '>=': '<=', '<': '>', '<=': '>=' };
const COMPLEMENT = { '===': '!==', '!==': '===', '==': '!=', '!=': '==' };
const STRICTNESS = { '===': '==', '==': '===', '!==': '!=', '!=': '!==' };
const BOOLEAN_SWAP = { '||': '&&', '&&': '||', '??': '||' };

// A row's snippet is either a bare expression (`config.ngl > 0`, `parseInt(fields.ngl) || 0`) or a
// whole `if (...)` header. Operators are searched inside the tested condition only, so an `&&` inside
// `if (a && b)` is found at depth 0 of the condition rather than hiding one level inside the header.
function siteScope(site, regionLines) {
    const line = regionLines[site.line];
    const spanText = line.slice(site.start, site.end);
    if (/^(?:else if|if) \(/.test(spanText)) {
        const open = spanText.indexOf('(');
        const close = spanText.lastIndexOf(')');
        return { text: spanText.slice(open + 1, close), offset: site.start + open + 1,
            condition: true };
    }
    return { text: spanText, offset: site.start, condition: false };
}

function operatorMutants(site, regionLines) {
    const scope = siteScope(site, regionLines);
    const out = [];
    const push = (at, text, klass) => out.push({
        class: klass, line: site.line, start: scope.offset + at.start, end: scope.offset + at.end, after: text
    });

    const relational = topOperators(scope.text, ['>=', '<=', '>', '<']);
    if (relational.length) {
        const op = relational[0];
        const flip = boundaryFlip(op.text);
        const reverse = REVERSE[op.text];
        if (flip) push(op, flip, 'relational-boundary');
        if (reverse) push(op, reverse, 'relational-reverse');
    }
    const equality = topOperators(scope.text, ['===', '!==', '==', '!=']);
    if (equality.length) {
        const op = equality[0];
        if (COMPLEMENT[op.text]) push(op, COMPLEMENT[op.text], 'equality-complement');
        if (STRICTNESS[op.text]) push(op, STRICTNESS[op.text], 'equality-strictness');
    }
    const logical = topOperators(scope.text, ['||', '&&', '??']);
    if (logical.length) {
        const op = logical[logical.length - 1];
        if (BOOLEAN_SWAP[op.text]) push(op, BOOLEAN_SWAP[op.text], 'boolean-operator');
        // `a || b` -> `a`: the fallback disappears. Removing the operator alone would not parse, and
        // the plan counts `|| 0` removal as a mutant in its own right, so the operand goes with it.
        push({ start: op.start, end: scope.text.length }, '', 'operand-removal');
    }
    if (scope.condition) {
        push({ start: 0, end: scope.text.length }, '!(' + scope.text + ')', 'conditional-inversion');
    } else if (site.kind === 'truthiness' || site.kind === 'ternary') {
        if (scope.text.startsWith('!')) {
            push({ start: 0, end: 1 }, '', 'negation-removal');
        } else {
            push({ start: 0, end: scope.text.length }, '!(' + scope.text + ')', 'negation-insertion');
        }
    }
    if (site.kind === 'loop-gate') {
        const target = scope.text.indexOf('Object.entries(configs)');
        if (target >= 0) {
            push({ start: target, end: target + 'Object.entries(configs)'.length },
                'Object.entries(configs).slice(0, 1)', 'loop-first-iteration');
        }
    }
    if (site.kind === 'ternary') {
        const condition = vectors.ternaryCondition(scope.text);
        if (condition) {
            const rest = scope.text.slice(condition.length);
            const q = rest.indexOf('?');
            const colon = rest.indexOf(':', q);
            if (q >= 0 && colon > q) {
                const yes = rest.slice(q + 1, colon);
                const no = rest.slice(colon + 1);
                push({ start: condition.length + q + 1, end: condition.length + colon }, no, 'branch-swap');
                push({ start: condition.length + colon + 1, end: scope.text.length }, yes, 'branch-swap');
            }
        }
    }
    return out;
}

function literalMutants(regionLines, ranges) {
    const out = [];
    for (const range of ranges) {
        const i = range.line;
        const line = regionLines[i];
        if (line === undefined) continue;
        const scan = scanLine(line);
        const limit = Math.min(range.end, scan.commentAt < 0 ? line.length : scan.commentAt);
        const from = range.start;
        for (const s of scan.strings) {
            if (s.start < from || s.end > limit) continue;
            const text = line.slice(s.start, s.end);
            const quote = text[0];
            const inner = text.slice(1, -1);
            out.push({ class: 'string-literal', line: i, start: s.start, end: s.end,
                after: quote + inner + SENTINEL + quote });
            if (inner !== '') {
                out.push({ class: 'string-literal', line: i, start: s.start, end: s.end,
                    after: quote + quote });
            }
        }
        for (const n of scan.numbers) {
            if (n.start < from || n.end > limit) continue;
            const value = Number(n.text);
            const swaps = value === 0 ? ['1'] : value === 1 ? ['0'] : [String(value + 1)];
            for (const swap of swaps) {
                out.push({ class: 'numeric-literal', line: i, start: n.start, end: n.end, after: swap });
            }
        }
    }
    return out;
}

// Every line of a brace-delimited body, scanned whole.
function bodyRanges(body) {
    const ranges = [];
    for (let line = body.first; line <= body.last; line += 1) ranges.push({ line: line, start: 0, end: Infinity });
    return ranges;
}

function removalMutants(site, regionLines) {
    const out = [];
    const body = bodyStatements(regionLines, site);
    for (const statement of body.statements) {
        if (statement.start !== undefined) {
            out.push({ class: 'statement-removal', line: statement.first, start: statement.start,
                end: statement.end, after: '', single: true });
            continue;
        }
        out.push({ class: 'statement-removal', line: statement.first, endLine: statement.last,
            start: 0, end: regionLines[statement.last].length, after: '', wholeLine: true });
    }
    if (site.kind === 'loop-gate') {
        const close = matchingBrace(regionLines, site.line);
        if (close > site.line) {
            out.push({ class: 'loop-body-removal', line: site.line, endLine: close, start: 0,
                end: regionLines[close].length, after: '', wholeLine: true });
        }
    }
    return out;
}

// ----------------------------------------------------------------- enumeration ------------

function rowSites(gen, rows) {
    const regions = regionSources(gen);
    const map = alignments(gen);
    const ranges = libRanges();
    const saveOffset = saveRegionOffset(gen);
    const sites = [];
    const unmapped = [];
    for (const row of rows) {
        if (!/^(BA|INI|SCV)-/.test(row.row_id)) continue;
        let region = null;
        let aligned = null;
        if (row.row_id.indexOf('SCV-') === 0) {
            region = 'save';
            aligned = Number(row.line) - 1 - saveOffset;
        } else {
            if (!vectors.inDomain(row)) {
                unmapped.push({ row_id: row.row_id, reason: 'outside both generators (' + row.file + ':'
                    + row.line + '), no generator site exists', kind: row.kind });
                continue;
            }
            const libLine = Number(row.line);
            if (row.file === 'legacy/lib/buildArgs.js') {
                const [c0, c1] = ranges['legacy/lib/buildArgs.js'].config;
                const [a0] = ranges['legacy/lib/buildArgs.js'].args;
                region = libLine >= c0 && libLine <= c1 ? 'config' : libLine >= a0 ? 'args' : null;
            } else {
                region = 'ini';
            }
            if (!region) {
                unmapped.push({ row_id: row.row_id, reason: 'line ' + row.line + ' is inside ' + row.file
                    + ' but outside both extracted regions', kind: row.kind });
                continue;
            }
            aligned = map[region].pairs.get(libLine);
            if (aligned === undefined) {
                unmapped.push({ row_id: row.row_id, reason: 'lib line ' + row.line + ' does not align to the '
                    + region + ' slice', kind: row.kind });
                continue;
            }
        }
        const lines = regions[region].lines;
        const span = spanInLine(lines[aligned], row.code_snippet);
        if (!span) {
            unmapped.push({ row_id: row.row_id, reason: 'snippet not found on aligned ' + region
                + ' line ' + aligned + ': ' + collapse(row.code_snippet), kind: row.kind });
            continue;
        }
        sites.push({ row_id: row.row_id, kind: row.kind, region: region, line: aligned,
            start: span.start, end: span.end, before: lines[aligned].slice(span.start, span.end),
            vars_read: row.vars_read, targets: row.targets, file: row.file, lib_line: Number(row.line) });
    }
    return { sites: sites, unmapped: unmapped };
}

function applyEdit(text, edit) {
    const lines = text.split('\n');
    if (edit.wholeLine) {
        lines.splice(edit.line, (edit.endLine === undefined ? edit.line : edit.endLine) - edit.line + 1);
        return lines.join('\n');
    }
    const line = lines[edit.line];
    lines[edit.line] = line.slice(0, edit.start) + edit.after + line.slice(edit.end);
    return lines.join('\n');
}

function enumerate(options) {
    const opts = options || {};
    const gen = opts.gen || slices.slicedGenerators();
    const rows = opts.rows || vectors.specRows();
    const regions = regionSources(gen);
    const { sites, unmapped } = rowSites(gen, rows);
    const byMutation = new Map();
    const rejected = [];

    for (const site of sites) {
        const text = regions[site.region].text;
        const lines = regions[site.region].lines;
        const edits = [];
        for (const edit of operatorMutants(site, lines)) edits.push(edit);
        for (const edit of literalMutants(lines, [{ line: site.line, start: site.start,
            end: site.end }])) edits.push(edit);
        for (const edit of removalMutants(site, lines)) edits.push(edit);
        if (site.kind !== 'loop-gate') {
            const body = bodyStatements(lines, site);
            if (body.kind === 'block') {
                for (const edit of literalMutants(lines, bodyRanges(body))) edits.push(edit);
            }
        }
        for (const edit of edits) {
            const before = edit.wholeLine ? lines[edit.line] : lines[edit.line].slice(edit.start, edit.end);
            if (edit.wholeLine && before.trim() === '') continue;
            if (!edit.wholeLine && before === edit.after) continue;
            if (edit.after === undefined) continue;
            const mutated = applyEdit(text, edit);
            if (mutated === text) continue;
            const id = 'M-' + site.region + '-' + String(edit.line + 1).padStart(3, '0')
                + '-' + String(edit.start).padStart(4, '0') + '-' + edit.class + '-'
                + sha256(Buffer.from(site.region + '\n' + mutated)).slice(0, 10);
            let entry = byMutation.get(id);
            if (!entry) {
                entry = {
                    id: id,
                    class: edit.class,
                    region: site.region,
                    line: edit.line,
                    start: edit.start,
                    end: edit.end,
                    before: before,
                    after: edit.after,
                    row_ids: [],
                    kinds: [],
                    mutated: mutated
                };
                byMutation.set(id, entry);
                if (opts.validate !== false) {
                    const problem = compiles(gen, site.region, mutated);
                    if (problem) rejected.push({ id: id, row_id: site.row_id, problem: problem });
                }
            }
            if (entry.row_ids.indexOf(site.row_id) < 0) {
                entry.row_ids.push(site.row_id);
                entry.kinds.push(site.kind);
            }
            entry._edit = edit;
        }
    }

    const kept = [...byMutation.values()]
        .filter((entry) => !rejected.some((bad) => bad.id === entry.id))
        .map((entry) => {
            const edit = entry._edit;
            delete entry._edit;
            entry.row_ids.sort();
            entry.kinds = [...new Set(entry.kinds)].sort();
            entry.mutated_sha256 = sha256(Buffer.from(entry.mutated, 'utf8'));
            entry.channel = entry.region === 'ini' ? 'ini' : entry.region === 'save' ? 'save' : 'argv';
            void edit;
            return entry;
        })
        .sort((a, b) => (a.region + a.line + a.start + a.class + a.after)
            .localeCompare(b.region + b.line + b.start + b.class + b.after));

    const covered = new Set();
    for (const mutant of kept) for (const row of mutant.row_ids) covered.add(row);
    const rowsWithSite = new Set(sites.map((site) => site.row_id));
    const uncoveredRows = [...rowsWithSite].filter((id) => !covered.has(id)).sort();

    const perRow = {};
    for (const mutant of kept) {
        for (const row of mutant.row_ids) {
            perRow[row] = perRow[row] || [];
            perRow[row].push(mutant.id);
        }
    }

    return {
        impl: 'parity-baseline',
        regions: { config: regions.config.lines.length, args: regions.args.lines.length,
            ini: regions.ini.lines.length, save: regions.save.lines.length },
        mutants: kept.map((mutant) => ({ id: mutant.id, class: mutant.class, region: mutant.region,
            line: mutant.line, start: mutant.start, end: mutant.end, before: mutant.before,
            after: mutant.after, row_ids: mutant.row_ids, kinds: mutant.kinds,
            mutated_sha256: mutant.mutated_sha256, channel: mutant.channel })),
        full: kept,
        per_row: perRow,
        row_sites: sites,
        unmapped_rows: unmapped,
        uncovered_rows: uncoveredRows,
        rejected: rejected
    };
}

// A mutant that does not compile is not a mutant of a working program; it is a bug in this
// enumerator. Count and report it rather than silently dropping it.
function compiles(gen, region, text) {
    try {
        compileSource(gen, region, text);
        return null;
    } catch (error) {
        return String(error && error.message).split('\n')[0];
    }
}

// The baseline-slices compilation, but from mutated text. Signatures are copied from
// slicedGenerators() so a mutant runs under exactly the same scope the golden was recorded under.
function compileSource(gen, region, text) {
    /* eslint-disable no-new-func */
    if (region === 'config') {
        return new Function('document', ...gen.elementNames, text + '\n        return config;');
    }
    if (region === 'args') {
        return new Function('config', 'settings', 'modelPathSelect', 'window', text + '\n        return args;');
    }
    if (region === 'save') {
        return new Function('configurations', 'document', 'saveConfigurations', 'console', 'configId',
            ...gen.saveElementNames,
            text + '\n    saveCurrentValues(configId);\n    return configurations;');
    }
    return new Function('configs', 'window', text + '\n        return presetContent;');
    /* eslint-enable no-new-func */
}

// The save channel observes what the writer PUTS: the localStorage bytes and the key order of the
// entry it rewrote. These are slices.runBaselineSave's fakes, so a save mutant is judged on the same
// DOM-shaped inputs the recorded re-save golden was composed from.
function runSaveSlice(gen, saveFn, fields, configurations, configId) {
    const kinds = slices.fieldKinds();
    const read = (id) => (kinds.get(id) === 'checked'
        ? { value: 'on', checked: fields[id] }
        : { value: fields[id], checked: false });
    const byName = {};
    for (const [id, name] of gen.elements) byName[name] = read(id);
    const written = [];
    const saveConfigurations = () => written.push(JSON.stringify(configurations));
    const out = saveFn(configurations, { getElementById: read }, saveConfigurations, { log() {} },
        configId, ...gen.saveElementNames.map((name) => byName[name]));
    assert(out === configurations, 'the mutated save slice returned a different map than it wrote');
    return { configs: configurations, written: written };
}

// A mutant replaces exactly one region; the other generator stays baseline, so only the mutant's own
// channel can move and the kill check pays for one generator.
function mutantRunner(gen, mutant, mutatedFull) {
    const entry = mutatedFull.find((item) => item.id === mutant.id);
    const configFn = entry.region === 'config'
        ? compileSource(gen, 'config', entry.mutated) : gen.compiled.config;
    const argsFn = entry.region === 'args'
        ? compileSource(gen, 'args', entry.mutated) : gen.compiled.args;
    const iniFn = entry.region === 'ini'
        ? compileSource(gen, 'ini', entry.mutated) : gen.compiled.ini;
    const saveFn = entry.region === 'save'
        ? compileSource(gen, 'save', entry.mutated) : gen.compiled.save;
    const kinds = slices.fieldKinds();
    return {
        argv: (fields, settings, models) => {
            const read = (id) => (kinds.get(id) === 'checked'
                ? { value: 'on', checked: fields[id] }
                : { value: fields[id], checked: false });
            const byName = {};
            for (const [id, name] of gen.elements) byName[name] = read(id);
            const config = configFn({ getElementById: read },
                ...gen.elementNames.map((name) => byName[name]));
            return argsFn(config, settings, byName.modelPathSelect, { models });
        },
        ini: (configs, models) => iniFn(configs, { models }),
        save: (fields, configurations, configId) => runSaveSlice(gen, saveFn, fields,
            configurations, configId)
    };
}

// ---------------------------------------------------------------------- dump --------------

function dumpPath() {
    return path.join(REPO, MUTANT_FILE);
}

function dumpDocument(list) {
    const kept = list.mutants;
    return JSON.stringify({
        generated_by: 'tools/parity/mutate.js',
        command: 'node tools/parity/mutate.js --dump',
        mutated_source: 'the parity-baseline inline blocks sliced by tools/parity/baseline-slices.js '
            + '(config literal, argv block, ini block, saveCurrentValues), mutated in memory; '
            + 'public/script.js, legacy/lib, fixtures/** and tests/** are never touched',
        site_inventory: 'SPEC/SPEC-ROWS.csv BA-*/INI-* rows (line + kind per row) for the two '
            + 'generators and SCV-* rows for the saveCurrentValues region',
        base_commit: BASE_COMMIT,
        regions: list.regions,
        totals: {
            mutants: kept.length,
            classes: kept.reduce((all, m) => { all[m.class] = (all[m.class] || 0) + 1; return all; }, {}),
            regions: kept.reduce((all, m) => { all[m.region] = (all[m.region] || 0) + 1; return all; }, {}),
            rows_with_a_mutant: Object.keys(list.per_row).length,
            rows_without_a_mutant: list.uncovered_rows,
            rows_without_a_site: list.unmapped_rows,
            rejected_mutants: list.rejected
        },
        per_row: list.per_row,
        mutants: kept
    }, null, 2) + '\n';
}

function selftest() {
    const gate = committedInputs();
    assert(gate.drift.length === 0, 'committed-input gate failed:\n  ' + gate.drift.join('\n  '));
    const first = enumerate();
    const second = enumerate();
    const a = dumpDocument(first);
    const b = dumpDocument(second);
    assert(a === b, 'enumeration is not deterministic: two runs produced different mutants.json bytes');
    const ba = vectors.specRows().filter((row) => /^(BA|INI)-/.test(row.row_id));
    const scv = vectors.specRows().filter((row) => /^SCV-/.test(row.row_id));
    const inDomain = ba.filter((row) => vectors.inDomain(row));
    assert(inDomain.length === 189, 'expected the 189 in-generator BA/INI rows, found ' + inDomain.length);
    assert(scv.length === 28, 'expected the 28 saveCurrentValues (SCV-*) rows, found ' + scv.length);
    const scvWithoutMutant = scv.filter((row) => !(first.per_row[row.row_id] || []).length);
    assert(scvWithoutMutant.length === 0, 'save-region rows without a mutant: '
        + scvWithoutMutant.map((row) => row.row_id).join(', '));
    const inDomainIds = new Set(inDomain.map((row) => row.row_id));
    const missing = first.unmapped_rows.filter((row) => inDomainIds.has(row.row_id));
    assert(missing.length === 0, 'in-generator rows without a site:\n  '
        + missing.map((r) => r.row_id + ': ' + r.reason).join('\n  '));
    assert(first.unmapped_rows.length === ba.length - inDomain.length,
        'unexpected rows without a site: ' + first.unmapped_rows.map((r) => r.row_id).join(', '));
    assert(first.uncovered_rows.length === 0, 'rows with a site but no mutant: '
        + first.uncovered_rows.join(', '));
    const ids = new Set(first.mutants.map((m) => m.id));
    assert(ids.size === first.mutants.length, 'mutant ids are not unique');
    const bad = first.full.filter((m) => m.before === m.after);
    assert(bad.length === 0, bad.length + ' mutants are the identity');
    return { gate: gate, list: first, ba_ini_rows: ba.length, in_domain: inDomain.length,
        save_rows: scv.length, save_region_lines: first.regions.save, bytes: Buffer.byteLength(a) };
}

function main() {
    const args = process.argv.slice(2);
    if (args.indexOf('--selftest') >= 0) {
        const result = selftest();
        const classes = result.list.mutants.reduce((all, m) => {
            all[m.class] = (all[m.class] || 0) + 1;
            return all;
        }, {});
        console.log('MUTATE SELFTEST GREEN');
        console.log('  inputs pinned to ' + result.gate.base.slice(0, 7) + ' (' + result.gate.watched.length
            + ' files byte-verified against git, plus the ' + result.gate.form_states.states.length
            + ' recorded form-state arrays in ' + result.gate.form_states.file + ')');
        console.log('  ' + result.in_domain + ' in-generator BA/INI rows, every one carrying >=1 mutant');
        console.log('  ' + result.save_rows + ' SCV-* saveCurrentValues rows over a '
            + result.save_region_lines + '-line slice, every one carrying >=1 mutant');
        console.log('  ' + result.list.mutants.length + ' mutants (' + Object.keys(classes).length
            + ' classes): ' + JSON.stringify(classes));
        console.log('  by region: ' + JSON.stringify(result.list.mutants.reduce((all, m) => {
            all[m.region] = (all[m.region] || 0) + 1; return all; }, {})));
        console.log('  ' + result.list.rejected.length + ' mutants rejected (would not compile), '
            + result.list.unmapped_rows.length + ' rows without a generator site');
        console.log('  --dump is byte-identical across reruns (' + result.bytes + ' bytes)');
        return;
    }
    if (args.indexOf('--dump') >= 0) {
        requireCommittedInputs();
        const list = enumerate();
        fs.mkdirSync(path.dirname(dumpPath()), { recursive: true });
        fs.writeFileSync(dumpPath(), dumpDocument(list), 'utf8');
        console.log('wrote ' + MUTANT_FILE + ' (' + list.mutants.length + ' mutants)');
        return;
    }
    console.log('usage: node tools/parity/mutate.js --dump | --selftest');
}

module.exports = {
    REPO, REPORTS, SNAPSHOT, BASE_COMMIT, MUTANT_FILE, sha256, collapse, assert,
    committedInputs, requireCommittedInputs, shapeOf, spanInLine, scanLine, topOperators,
    regionSources, saveRegionOffset, libRanges, alignments, rowSites, enumerate, applyEdit, compiles,
    compileSource, runSaveSlice, mutantRunner, dumpDocument, dumpPath, selftest
};

if (require.main === module) main();
