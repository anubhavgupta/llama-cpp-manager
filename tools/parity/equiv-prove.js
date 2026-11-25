#!/usr/bin/env node
'use strict';
// Phase 2.6 (plan.md §2): decide, mechanically, whether each surviving mutant is an equivalent mutant
// or a hole in the vector set.
//
//   node tools/parity/equiv-prove.js                classify every survivor in run.json, write proofs
//   node tools/parity/equiv-prove.js --report       only rebuild REPORT.md from run.json + proofs
//   node tools/parity/equiv-prove.js --selftest     the proofs themselves are tested
//
// A survivor is EQUIVALENT only on evidence, never on judgement (plan §2 Phase 2.6, §5 Auditor re-proof):
//
//   static   the mutated expression's two forms cannot disagree for any input the field domain admits,
//            inferred from the baseline source itself (`parseInt(...)` cannot produce null; a checkbox
//            reads a boolean; `== ` and `===` agree on two values of one primitive type), or
//   dynamic  an exhaustive probe over the product of the site's own input domain — every value that key
//            takes across ALL recorded vectors, plus the boundary set (0, -1, "", null, undefined, "0",
//            "0.0", "0.00", "NaN", "1e3", true, false, ...) — produces byte-identical argv and ini.
//
// Anything else is a GAP, and a gap is an action, not a label: the probe search continues until it
// finds an input where baseline and mutant differ, that input is written up as a promotion proposal
// (PROMOTIONS-PROPOSED.json — fixtures are frozen and being re-recorded, so the parent applies it), and
// a survivor with neither a static argument nor a difference found under a truncated probe set is written
// to ESCALATION.md as `unresolved-gap`. Nothing is ever marked equivalent because it was inconvenient.
//
// Proofs are written one file per survivor to reports/mutation/proofs/<survivor-id>.json and each is
// flushed as its survivor finishes, so a long proof run is resumable; an existing proof for the same
// mutant sha is reused rather than recomputed.
//
// Inputs are the private snapshot of the committed 9d6a767 vectors/goldens. Live fixtures are not read.

const fs = require('fs');
const path = require('path');

const slices = require('./baseline-slices.js');
const vectors = require('./gen-vectors.js');
const mutate = require('./mutate.js');
const runner = require('./mutation-run.js');
const equivalence = require('./equivalence.js');

const REPO = mutate.REPO;
const REPORTS = mutate.REPORTS;
const PROOFS = path.join(REPORTS, 'proofs');
const RUN_FILE = path.join(REPORTS, 'run.json');
const MUTANTS_FILE = path.join(REPO, mutate.MUTANT_FILE);
const PROMOTIONS = path.join(REPORTS, 'PROMOTIONS-PROPOSED.json');
const REPORT_MD = path.join(REPORTS, 'REPORT.md');
const ESCALATION = path.join(REPO, 'ESCALATION.md');
const MAX_DOMAIN = 24;
const MAX_PROBES = 24000;

// The boundary values the plan names, in a fixed order. `__omit__` removes the key, which is the state
// a missing localStorage key produces (undefined through the generator), not the same as "".
const BOUNDARY = ['', 0, 1, -1, -0, 0.5, '0', '0.0', '0.00', '1', 'true', 'false', 'NaN', 'null',
    'undefined', '1e3', '1e-7', '0.30000000000000004', '  8  ', '0x10', '0.7xyz', true, false, null,
    undefined, 9007199254740993, 1.005, '__omit__'];

// ------------------------------------------------------------------ field typing ----------

// Type of the value a config-literal entry hands the argv generator, read off the baseline text:
// `parseInt(...)`/`parseFloat(...)` are numbers (NaN included), `.checked` is a boolean, a bare `.value`
// (with or without .trim()) is a string. `<x>.value || 0` is 'mixed', because the fallback is a number
// and the read is a string — `==` and `===` can disagree across that pair, so a mixed value forfeits the
// static argument. Anything unrecognised is 'unknown', which is the conservative direction.
function configLiteralTypes(gen) {
    const types = new Map();
    for (const entry of slices.literalEntries(gen.slices.config)) {
        const expr = entry.expr;
        if (/^(?:parseInt|parseFloat)\(/.test(expr)) types.set(entry.key, 'number');
        else if (/\.checked\b/.test(expr)) types.set(entry.key, 'boolean');
        else if (/\.value\b\s*\|\|/.test(expr)) types.set(entry.key, 'mixed');
        else if (/\.value\b/.test(expr)) types.set(entry.key, 'string');
        else types.set(entry.key, 'unknown');
    }
    return types;
}

const STRING_LITERAL = /^(['"]).*\1$/s;
const NUMBER_LITERAL = /^-?\d+(\.\d+)?$/;

// Conservative type inference for an operand expression. `config.X` in the argv generator means the
// config literal's value for X, so it is typed from the literal; in the ini generator `config.X` is a
// value out of localStorage and could be any JSON type, so it is 'unknown'.
// A parenthesized expression is boolean only when what it wraps is boolean: a comparison, a negation, or
// a recognised boolean call. `(a || b)` is NOT boolean — it yields whichever operand fired — so it stays
// unknown rather than being waved through.
function parenthesisedBoolean(text, ctx) {
    if (!text.startsWith('(') || !text.endsWith(')')) return null;
    let depth = 0;
    for (let i = 0; i < text.length; i += 1) {
        const c = text[i];
        if (c === "'" || c === '"' || c === '`') { continue; }
        if (c === '(') depth += 1;
        else if (c === ')') {
            depth -= 1;
            if (depth === 0 && i !== text.length - 1) return null;
        }
    }
    const inner = text.slice(1, -1).trim();
    const inferred = inferType(inner, ctx);
    if (SAFE_PRIMITIVES.has(inferred)) return inferred;
    if (mutate.topOperators(inner, ['===', '!==', '==', '!=', '>=', '<=', '>', '<']).length) {
        return 'boolean';
    }
    return null;
}

function inferType(text, ctx) {
    const t = text.trim();
    if (t === 'undefined' || t === 'null') return t;
    if (STRING_LITERAL.test(t)) return 'string';
    if (NUMBER_LITERAL.test(t)) return 'number';
    if (/^(?:!|isNaN\(|Number\.isNaN\(|.*\.includes\(|.*\.some\()/.test(t)) return 'boolean';
    const grouped = parenthesisedBoolean(t, ctx);
    if (grouped) return grouped;
    if (/\.length$/.test(t)) return 'number';
    if (/^parseInt\(|^parseFloat\(/.test(t)) return 'number';
    if (/\bdocument\.getElementById\('[^']+'\)\.checked\b/.test(t) || /\.checked\b/.test(t)) {
        return 'boolean';
    }
    if (/\.value\b/.test(t)) return 'string';
    const field = t.match(/^config\.([A-Za-z0-9_]+)$/);
    if (field) {
        if (ctx.region === 'ini') return 'unknown';
        return ctx.types.get(field[1]) || 'unknown';
    }
    if (/^[A-Za-z0-9_.]+$/.test(t) && ctx.region !== 'ini') {
        const bare = t.match(/^([A-Za-z0-9_]+)$/);
        if (bare && ctx.types.has(bare[1])) return ctx.types.get(bare[1]);
    }
    return 'unknown';
}

const SAFE_PRIMITIVES = new Set(['string', 'boolean', 'number']);

// The expression a site's operator actually sits in: the tested condition of an `if`/`else if` header, or
// the value expression of a config-literal entry. The mutant's own span is only the operator, so the
// operands have to be read out of the enclosing expression, not out of the span.
function matchingParen(line, open) {
    let depth = 0;
    for (let i = open; i < line.length; i += 1) {
        const c = line[i];
        if (c === '(') depth += 1;
        else if (c === ')') {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function enclosingExpression(line) {
    const header = line.match(/^\s*\}?\s*(?:else if|if) \(/);
    if (header) {
        const open = header[0].length - 1;
        const close = matchingParen(line, open);
        if (close > open) return { text: line.slice(open + 1, close), offset: open + 1 };
        return null;
    }
    const entry = line.match(/^\s*[A-Za-z0-9_]+:\s*/);
    if (entry) {
        const start = entry[0].length;
        const end = line.replace(/[\s,;]+$/, '').length;
        if (end > start) return { text: line.slice(start, end), offset: start };
    }
    return null;
}

// A string literal whose Number() is NaN (and is not empty) cannot be loosely equal to anything it is not
// strictly equal to: loose comparison against it either compares two strings, or compares against NaN and
// is false. That makes `==`/`===` interchangeable against it for every input value, including a saved
// config that drifted to a number or a boolean (Q19).
const NaN_STRING_LITERAL = /^(['"])([^'"]*)\1$/s;

function isNonNumericStringLiteral(text) {
    const m = text.match(NaN_STRING_LITERAL);
    if (!m) return false;
    return m[2] !== '' && Number.isNaN(Number(m[2]));
}

// An `x ? <use> : <fallback>` guard where `x` is a top-level `const x = document.getElementById(id)`:
// the fallback runs only when the element is not in the page. A mutation confined to that fallback is
// non-effective when the oracle markup renders the id unconditionally and the oracle script cannot
// remove the node. `falseBranchSpan` returns the fallback's span inside the holder expression.
const ELEMENT_TRUTHY_GUARD = /^([A-Za-z_$][\w$]*)\s*\?/;

function skipQuoted(text, at) {
    const quote = text[at];
    let i = at + 1;
    while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === quote) return i + 1;
        i += 1;
    }
    return text.length;
}

// Walks the ternary at the head of `text` at bracket depth 0. Declines (null) when the true branch
// contains a `?` of its own, so a nested ternary is never mistaken for this one.
function falseBranchSpan(text) {
    const head = text.match(ELEMENT_TRUTHY_GUARD);
    if (!head) return null;
    const question = head.index + head[0].length - 1;
    let depth = 0;
    let i = question + 1;
    while (i < text.length) {
        const c = text[i];
        if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth -= 1; }
        else if (c === "'" || c === '"' || c === '`') { i = skipQuoted(text, i); continue; }
        else if (depth === 0 && c === '?') return null;
        else if (depth === 0 && c === ':') return { guard: head[1], start: i + 1, end: text.length };
        i += 1;
    }
    return null;
}

// The oracle page as a set of facts a proof can lean on: which variable holds which element, and
// whether anything in the oracle script can take that element out of the page.
const DECLARED = /(?:const|let|var) (\w+) = [\w$.]*\.getElementById\('([^']+)'\)|(?:const|let|var) (\w+) = [\w$.]*\.querySelector\('(#[-\w]+)'\)|(?:const|let|var) (\w+) = [\w$.]*\.querySelector\('\.([-\w]+)'\)/g;
// `x.innerHTML = `, `x.outerHTML = `, `x.remove()`, `x.replaceWith()`, `x.insertAdjacentHTML(`.
const REWRITTEN = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\.(?:innerHTML|outerHTML)\s*=(?!=)|(?:^|[^\w$.])([A-Za-z_$][\w$]*)\.(?:remove|replaceWith)\(|(?:^|[^\w$.])([A-Za-z_$][\w$]*)\.insertAdjacentHTML\(/gm;

function pageFacts() {
    const markup = slices.baselineMarkup();
    const script = slices.baselineScript();
    const selectors = new Map();
    const created = new Set();
    let match = DECLARED.exec(script);
    while (match) {
        const shape = match[2] !== undefined ? { id: match[2] }
            : match[4] !== undefined ? { id: match[4] } : { cls: match[6] };
        const name = match[1] || match[3] || match[5];
        if (!selectors.has(name)) selectors.set(name, []);
        if (!selectors.get(name).some((row) => row.id === shape.id && row.cls === shape.cls)) {
            selectors.get(name).push(shape);
        }
        match = DECLARED.exec(script);
    }
    for (const row of script.matchAll(/(?:const|let|var) (\w+) = document\.createElement\(/g)) {
        created.add(row[1]);
    }
    const rewrites = [];
    match = REWRITTEN.exec(script);
    while (match) {
        rewrites.push(match[1] || match[2] || match[3]);
        match = REWRITTEN.exec(script);
    }
    const chains = new Map();
    // A guard variable qualifies only when the script binds that name to exactly one element id.
    const varToId = new Map();
    const ambiguous = new Set();
    for (const row of script.matchAll(/(?:const|let|var) (\w+) = document\.getElementById\('([^']+)'\)/g)) {
        if (varToId.has(row[1]) && varToId.get(row[1]) !== row[2]) ambiguous.add(row[1]);
        else varToId.set(row[1], row[2]);
    }
    for (const name of ambiguous) varToId.delete(name);
    return {
        markup: markup, script: script, selectors: selectors, created: created, varToId: varToId,
        rewrites: [...new Set(rewrites)].sort(),
        markupCount(id) {
            return (this.markup.match(new RegExp('id\s*=\s*"' + id + '"', 'g')) || []).length;
        },
        chain(id) {
            if (!chains.has(id)) chains.set(id, slices.ancestorChain(this.markup, id));
            return chains.get(id);
        },
        // Why the element cannot leave the page, or the reason the argument is not available. A rewrite
        // receiver is harmless when it resolves to a selector no ancestor of the element matches, or to
        // a node the script created itself: a created node is a sibling of what the markup rendered,
        // never its ancestor.
        alwaysPresent(id) {
            const declared = (this.selectors.get(idToVar(script, id)) || []);
            const variable = idToVar(script, id);
            if (this.markupCount(id) !== 1) {
                return { ok: false, reason: '#' + id + ' is not rendered exactly once by '
                    + slices.BASELINE + ':public/index.html' };
            }
            if (!variable || !declared.some((row) => row.id === id)) {
                return { ok: false, reason: 'the oracle script never binds a const to "' + id
                    + '" with document.getElementById, so the guard variable is not pinned to it' };
            }
            const chain = this.chain(id);
            if (chain === null) return { ok: false, reason: '#' + id + ' is not a tag the oracle markup renders' };
            const blocked = this.rewrites.filter((name) => {
                const shapes = this.selectors.get(name) || [];
                if (shapes.length) {
                    return shapes.some((shape) => chain.some((row) => row.id === shape.id
                        || (shape.cls && row.classes.includes(shape.cls))));
                }
                return !this.created.has(name);
            });
            if (blocked.length) {
                return { ok: false, reason: 'the oracle script rewrites `' + blocked.join('`, `')
                    + '`, which this proof cannot rule out as an ancestor of #' + id };
            }
            return { ok: true, variable: variable, ancestors: chain, rewrites: this.rewrites };
        }
    };
}

// The variable name the oracle script holds this element id in, when it holds it in exactly one.
function idToVar(script, id) {
    const names = [];
    for (const row of script.matchAll(/(?:const|let|var) (\w+) = document\.getElementById\('([^']+)'\)/g)) {
        if (row[2] === id) names.push(row[1]);
    }
    return names.length === 1 ? names[0] : null;
}

// Static equivalence arguments, per mutation class. Deliberately narrow: a class gets an argument only
// where the operator pair provably cannot disagree over the operands' whole domain.
function staticProof(mutant, site, ctx) {
    const line = ctx.regionLines[site.line];
    const holder = enclosingExpression(line);
    if (!holder) return null;
    const rel = { start: site.start - holder.offset, end: site.end - holder.offset };
    if (rel.start < 0 || rel.end > holder.text.length) return null;
    const operator = holder.text.slice(rel.start, rel.end);
    // The operands are the operands, not everything to either side: `a !== b && c` has `b` on the right,
    // not `b && c`. Cut at the nearest top-level boolean operator.
    const leftOps = mutate.topOperators(holder.text.slice(0, rel.start), ['&&', '||', '??']);
    const rightOps = mutate.topOperators(holder.text.slice(rel.end), ['&&', '||', '??']);
    const leftBase = holder.text.slice(0, rel.start);
    const rightBase = holder.text.slice(rel.end);
    const left = (leftOps.length
        ? leftBase.slice(leftOps[leftOps.length - 1].end) : leftBase).trim();
    const right = (rightOps.length ? rightBase.slice(0, rightOps[0].start) : rightBase).trim();
    if (mutant.class === 'equality-strictness') {
        if (!['===', '!==', '==', '!='].includes(operator)) return null;
        const lt = inferType(left, ctx);
        const rt = inferType(right, ctx);
        // Only coercions give a real guarantee about a runtime type: `.checked` becomes a boolean and
        // parseInt/parseFloat become a number. A `.value` read is a string in the browser, but the input
        // path here is a saved config overlaid on the form state, which can deliver any JSON scalar
        // (Q19), so 'string' alone does not license the claim.
        const coerced = lt === rt && (lt === 'boolean' || lt === 'number');
        const literalSide = isNonNumericStringLiteral(left) ? 'left' : isNonNumericStringLiteral(right)
            ? 'right' : null;
        if (coerced || literalSide) {
            return {
                kind: 'static',
                case: coerced ? 'same-coerced-primitive' : 'nan-string-literal',
                argument: coerced
                    ? '`' + operator + '` and `' + mutant.after + '` differ only across types that are '
                        + 'loosely equal without being strictly equal. Both operands are `' + lt + '` for '
                        + 'every input: `' + left + '` -> ' + lt + ' and `' + right + '` -> ' + rt
                        + ', and that type is produced by a coercion in the baseline source, not by the '
                        + 'input, so no input can move it.'
                    : '`' + operator + '` and `' + mutant.after + '` agree against `' + (literalSide === 'left' ? left : right)
                        + '`: it is a string literal whose Number() is NaN, so a loose comparison against '
                        + 'it either compares two strings (where == and === are the same test) or coerces '
                        + 'the other side to NaN and is false on both forms. This holds for every value the '
                        + 'saved-config path can deliver, including a type-drifted number or boolean (Q19).',
                operands: { left: left, left_type: lt, right: right, right_type: rt }
            };
        }
        return null;
    }
    if (mutant.class === 'boolean-operator' && mutant.after === '??') {
        if (operator !== '||') return null;
        const lt = inferType(left, ctx);
        // `||` and `??` differ on exactly one input: a left operand that is null. In the argv generator
        // no null can reach a config-literal input: the value is either a DOM read of the recorded form
        // state (string or boolean) or a saved-config overlay, and that overlay drops null and undefined
        // before the generator sees them (tools/parity/baseline-slices.js fieldsFromConfig).
        const coerced = SAFE_PRIMITIVES.has(lt);
        const neverNull = ctx.region === 'config' || ctx.region === 'args';
        if (coerced || (neverNull && /^(?:config\.[A-Za-z0-9_]+|.*\.value\b|.*\.checked\b|parseInt\(|parseFloat\()/.test(left))) {
            return {
                kind: 'static',
                case: coerced ? 'non-nullish-left-operand' : 'null-unreachable-in-argv-path',
                argument: '`||` and `??` differ only when the left operand is null. Here the left operand '
                    + '`' + left + '` cannot be null: '
                    + (coerced ? 'its type is ' + lt + ', produced by a coercion.' : 'the argv path reads '
                        + 'either a recorded form-state value (string or boolean) or a saved-config '
                        + 'overlay that drops null and undefined before the generator runs.'),
                operands: { left: left, left_type: lt }
            };
        }
    }
    // A mutation that lives entirely in the fallback branch of an element-truthiness guard.
    const branch = ctx.page ? falseBranchSpan(holder.text) : null;
    if (branch && rel.start >= branch.start && rel.end <= branch.end) {
        const id = ctx.page.varToId.get(branch.guard);
        if (id) {
            const fact = ctx.page.alwaysPresent(id);
            if (fact.ok) {
                const chain = fact.ancestors.map((row) => row.tag + (row.id ? '#' + row.id
                    : row.classes.length ? '.' + row.classes[0] : ''));
                return {
                    kind: 'static',
                    case: 'unreachable-element-guard-fallback',
                    argument: 'The mutation is inside the `: `' + holder.text.slice(branch.start).trim()
                        + '` branch of `' + holder.text.trim() + '`. That branch is evaluated only when '
                        + '`' + branch.guard + '` is falsy, and `' + branch.guard + '` is `'
                        + 'document.getElementById(\'' + id + '\')` taken once at load: ' + slices.BASELINE
                        + ':public/index.html renders id="' + id + '" exactly once, inside '
                        + chain.join(' > ') + ', and the '
                        + 'only DOM-rewriting assignments in ' + slices.BASELINE + ':public/script.js are on '
                        + (fact.rewrites.length ? '`' + fact.rewrites.join('`, `') + '`' : 'none') + ', none of '
                        + 'which is that element or an ancestor of it. The guard is therefore truthy in every '
                        + 'page state, the fallback is never evaluated, and no input can make the mutant '
                        + 'differ from the baseline.',
                    operands: { guard: branch.guard, element_id: id,
                        fallback: holder.text.slice(branch.start).trim(),
                        ancestors: fact.ancestors }
                };
            }
        }
    }
    return null;
}

// -------------------------------------------------------------------- domains -------------

// Every value a key takes across the recorded inputs, plus the boundary set. Recorded values are read
// from the snapshot vectors: `fields` (the saved-config shape, which is what the ini generator sees and
// what the launch path overlays on the form state) and the multi-config `ini_configs` payloads.
function observedValues(bag) {
    const byKey = new Map();
    const add = (key, value) => {
        if (!byKey.has(key)) byKey.set(key, new Map());
        const values = byKey.get(key);
        const token = value === undefined ? '__undefined__' : JSON.stringify(value);
        if (!values.has(token)) values.set(token, value);
    };
    for (const vector of bag.vectors) {
        for (const [key, value] of Object.entries(vector.fields || {})) add(key, value);
        for (const config of Object.values(vector.ini_configs || {})) {
            for (const [key, value] of Object.entries(config)) add(key, value);
        }
    }
    return byKey;
}

const jsonKey = (value) => value === undefined ? '__undefined__' : JSON.stringify(value);

// observed ∪ boundary, deterministically reduced to MAX_DOMAIN entries. Reference value and every
// boundary value survive the reduction; observed values are taken on a stride, so the same domain comes
// out of every run.
function domainFor(key, observed, reference) {
    const values = new Map();
    const put = (value) => values.set(jsonKey(value), value);
    put(reference ? reference[key] : undefined);
    for (const token of BOUNDARY) put(token === '__omit__' ? undefined : token);
    const seen = observed.get(key);
    const observedValues = seen ? [...seen.values()] : [];
    const room = Math.max(0, MAX_DOMAIN - values.size);
    if (observedValues.length > room) {
        const step = Math.ceil(observedValues.length / Math.max(1, room));
        for (let i = 0; i < observedValues.length && values.size < MAX_DOMAIN; i += step) {
            put(observedValues[i]);
        }
    } else {
        for (const value of observedValues) {
            if (values.size >= MAX_DOMAIN) break;
            put(value);
        }
    }
    return [...values.entries()].sort((a, b) => a[0].localeCompare(b[0])).map((entry) => entry[1]);
}

// Which input knobs a survivor's sites actually read. vars_read carries the row inventory's own naming;
// pseudo-entries (`parseInt()`, `undefined`, `isNaN()`) are not inputs and drop out. `specTypes.length`
// is derived inside both generators from speculationType + ngramMod, so it is probed through them.
const PSEUDO = /^(?:[A-Za-z0-9_.]+\(\)|undefined|null|Object\.entries\(\)|configs|configName)$/;

function probeVarsFor(mutant, rowsById) {
    const vars = new Set();
    let needsConfigCount = false;
    let needsModels = false;
    for (const rowId of mutant.row_ids) {
        const row = rowsById.get(rowId);
        if (!row) continue;
        for (const raw of (row.vars_read || '').split(';').filter(Boolean)) {
            if (raw === 'Object.entries()' || raw === 'configs' || raw === 'configName') {
                needsConfigCount = true;
                continue;
            }
            if (/^model\./.test(raw) || raw === 'modelPath') {
                needsModels = needsModels || /^model\./.test(raw);
            }
            if (raw === 'specTypes.length') {
                vars.add('speculationType');
                vars.add('ngramMod');
                continue;
            }
            if (PSEUDO.test(raw)) continue;
            const field = raw.match(/^(?:fields|config)\.([A-Za-z0-9_]+)$/);
            if (field) vars.add(field[1]);
            else if (/^[A-Za-z0-9_]+$/.test(raw)) vars.add(raw);
        }
    }
    return { keys: [...vars].sort(), needsConfigCount: needsConfigCount, needsModels: needsModels };
}

// The recorded /models payloads plus two synthetic sets: the ini/argv mmproj conjunction is probed on
// both sides of `model.mmprojFile` and on a list where no model matches.
// Recorded sets come first: a kill found on one of them needs no new fixture input.
function modelSets(bag) {
    const sets = [...bag.modelsById.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        .map(([id, models]) => ({ id: id, models: models, synthetic: false }));
    const paths = new Set();
    for (const set of sets) for (const model of set.models) paths.add(model.path);
    const list = [...paths].sort().slice(0, 3);
    sets.push({ id: 'mutation-probe-models-mmproj', synthetic: true, models: [
        { path: list[0] || 'a.gguf', mmprojFile: null },
        { path: list[1] || 'b.gguf', mmprojFile: list[2] || 'b.mmproj.gguf' },
        { path: 'probe/mmproj.gguf', mmprojFile: 'probe/mmproj-file.gguf' }
    ] });
    sets.push({ id: 'mutation-probe-models-empty', synthetic: true, models: [] });
    return sets;
}

// -------------------------------------------------------------------- probe set -----------

const cartesian = (lists) => lists.reduce((rows, list) => rows.flatMap((row) => list.map((value) => row
    .concat([value]))), [[]]);

// Build the probe list: the full product over the site's own domains when it fits the budget. If it does
// not, the widest domain is reduced by a deterministic stride until it fits and the scope says so — a
// reduced domain forfeits the exhaustive claim, which `analyze` reports as an unresolved gap rather than
// as an equivalence.
function probeSet(mutant, ctx, reference) {
    const vars = probeVarsFor(mutant, ctx.rowsById);
    const domains = vars.keys.map((key) => domainFor(key, ctx.observed, reference.fields));
    // A site that does not read the model list still needs one payload; the reference vector's own
    // recorded payload is used so probe inputs stay inside recorded data.
    const sets = vars.needsModels ? ctx.modelSets
        : [ctx.modelSets.find((set) => set.id === reference.models) || ctx.modelSets[0]];
    const configCounts = vars.needsConfigCount && mutant.channel === 'ini' ? [0, 1, 2, 3] : [1];
    const fullProduct = domains.reduce((a, d) => a * d.length, 1) * sets.length * configCounts.length;
    let assignments = domains.length ? cartesian(domains) : [[]];
    let truncated = false;
    while (assignments.length * sets.length * configCounts.length > MAX_PROBES) {
        const widest = domains.map((d, i) => i)
            .sort((a, b) => domains[b].length - domains[a].length)[0];
        if (domains[widest].length <= 2) break;
        const kept = domains[widest].filter((value, i) => i % 2 === 0);
        domains[widest] = kept.length ? kept : [domains[widest][0]];
        assignments = domains.length ? cartesian(domains) : [[]];
        truncated = true;
    }
    const probes = [];
    for (const assignment of assignments) {
        for (const model of sets) {
            for (const count of configCounts) {
                const fields = {};
                vars.keys.forEach((name, i) => { fields[name] = assignment[i]; });
                probes.push({ fields: fields, models: model, configCount: count });
            }
        }
    }
    return {
        probes: probes,
        scope: {
            variables: vars.keys,
            domains: vars.keys.map((name, i) => ({ key: name, size: domains[i].length })),
            model_sets: sets.map((set) => set.id),
            config_counts: configCounts,
            full_product: fullProduct,
            enumerated: probes.length,
            exhaustive_over_enumerated: !truncated,
            truncated: truncated
        }
    };
}

// ------------------------------------------------------------------ probe execution -------

// Baseline and mutant over the same probe input, compared by the same comparator that judges the
// candidate: argv positionally, ini as bytes, throw message as output.
// compare() reads `ini` as bytes whenever neither side threw, so a channel this probe does not exercise
// is pinned to the empty byte string on both sides — "not compared", never null-on-one-side.
const NOT_COMPARED = Buffer.from('', 'utf8').toString('base64');

function probeOutputs(gen, mutant, probe, ctx) {
    const fields = slices.fieldsFromConfig(ctx.reference.fields, ctx.kinds, probe.fields, true);
    const settings = ctx.settings;
    const baseline = {
        argv: null, argv_threw: null, ini: NOT_COMPARED, ini_threw: null
    };
    try {
        baseline.argv = slices.runBaselineArgv(gen, fields, settings, probe.models.models).args;
    } catch (error) {
        baseline.argv_threw = String(error && error.message);
    }
    const mine = { argv: baseline.argv, argv_threw: baseline.argv_threw, ini: baseline.ini,
        ini_threw: baseline.ini_threw };
    if (mutant.channel === 'argv') {
        try {
            const args = mutant._runner.argv(fields, settings, probe.models.models);
            mine.argv = Array.isArray(args) ? args : null;
            mine.argv_threw = Array.isArray(args) ? null : 'returned ' + JSON.stringify(args);
        } catch (error) {
            mine.argv = null;
            mine.argv_threw = String(error && error.message);
        }
    } else {
        try {
            baseline.ini = Buffer.from(slices.runBaselineIni(gen, probe.configs,
                probe.models.models), 'utf8').toString('base64');
        } catch (error) {
            baseline.ini = null;
            baseline.ini_threw = String(error && error.message);
        }
        mine.ini = baseline.ini;
        mine.ini_threw = baseline.ini_threw;
        try {
            const ini = mutant._runner.ini(probe.configs, probe.models.models);
            mine.ini = Buffer.from(ini, 'utf8').toString('base64');
            mine.ini_threw = null;
        } catch (error) {
            mine.ini = null;
            mine.ini_threw = String(error && error.message);
        }
    }
    return equivalence.compare(baseline, mine);
}

// Assemble the concrete input a probe used, in vector shape, so a proposal is re-runnable by the parent
// without this file's internals.
function probeVector(mutant, probe, ctx, index) {
    const name = 'mutation-probe-' + String(index + 1).padStart(4, '0');
    const fields = { ...ctx.reference.fields, ...probe.fields };
    for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key];
    const configs = {};
    for (let i = 0; i < probe.configCount; i += 1) {
        configs[probe.configCount === 1 ? name : name + '-' + (i + 1)] = { ...fields };
    }
    return {
        id: name,
        family: 'boundary',
        name: name,
        fields: fields,
        settings: ctx.reference.settings,
        models: probe.models.id,
        models_payload: probe.models.synthetic ? probe.models.models : undefined,
        ini_configs: mutant.channel === 'ini' ? configs : undefined,
        targets: mutant.row_ids.slice().sort()
    };
}

// ------------------------------------------------------------------ classification --------

function analyze(mutant, ctx, reference, index) {
    const gen = ctx.gen;
    mutant._runner = mutate.mutantRunner(gen, mutant, [mutant]);
    const site = { line: mutant.line, start: mutant.start, end: mutant.end };
    const ctxStatic = { region: mutant.region, types: ctx.types, regionLines: ctx.regionLines,
        page: ctx.page };
    const proof = staticProof(mutant, site, ctxStatic);
    if (proof) {
        return {
            survivor_id: mutant.id, status: 'equivalent-proven', method: 'static',
            row_ids: mutant.row_ids, class: mutant.class, region: mutant.region,
            before: mutant.before, after: mutant.after, static: proof,
            probes: { run: 0, scope: null }
        };
    }
    if (mutant.channel === 'save') {
        // The probe machinery enumerates the argv/ini domain (settings sets, model lists, saved-config
        // overlays). A save mutant leaves all three untouched, so probing it would compare two baseline
        // generators and report a difference that cannot exist. Without a static argument the save
        // channel has no domain enumerator yet, so the survivor stays a gap and gets escalated.
        return {
            survivor_id: mutant.id, status: 'unresolved-gap', method: 'save-domain-not-probed',
            row_ids: mutant.row_ids, class: mutant.class, region: mutant.region,
            before: mutant.before, after: mutant.after,
            difference: 'the save channel has no boundary-domain enumerator; this survivor needs a '
                + 'recorded re-save session that separates it from the baseline, or a static argument',
            probes: { run: 0, scope: null }
        };
    }
    const set = probeSet(mutant, ctx, reference);
    let killer = null;
    let promotable = null;
    let run = 0;
    for (let i = 0; i < set.probes.length && !promotable; i += 1) {
        const probe = set.probes[i];
        if (mutant.channel === 'ini') {
            const name = 'probe-' + (i + 1);
            const fields = { ...reference.fields, ...probe.fields };
            for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key];
            const configs = {};
            for (let c = 0; c < probe.configCount; c += 1) {
                configs[probe.configCount === 1 ? name : name + '-' + (c + 1)] = { ...fields };
            }
            probe.configs = configs;
        }
        const problems = probeOutputs(gen, mutant, probe, ctx);
        run += 1;
        if (!problems.length) continue;
        // Prefer a killer that coverage can also credit: one whose row outcomes differ from the
        // reference vector's. A killer that flips no row is still a proof that the mutant is not
        // equivalent, but it cannot become a permanent boundary vector (see --apply), so keep
        // searching for one that can and fall back to this if none exists.
        const entry = { index: i, probe: probe, problems: problems,
            vector: probeVector(mutant, probe, ctx, i) };
        entry.credits_rows = ctx.flips(entry.vector).length;
        if (!killer) killer = entry;
        if (entry.credits_rows > 0) promotable = entry;
    }
    if (killer) {
        const chosen = promotable || killer;
        return {
            survivor_id: mutant.id, status: 'gap-killer-synthesized', method: 'dynamic-differential',
            row_ids: mutant.row_ids, class: mutant.class, region: mutant.region,
            before: mutant.before, after: mutant.after,
            probes: { run: run, scope: set.scope },
            killing_probe: { index: chosen.index, fields: chosen.probe.fields,
                model_set: chosen.probe.models.id,
                model_set_is_synthetic: !!chosen.probe.models.synthetic,
                config_count: chosen.probe.configCount,
                rows_it_credits: chosen.credits_rows,
                promotable_killer_found: !!promotable,
                first_killing_probe: killer.index },
            difference: chosen.problems.slice(0, 2),
            proposed_vector: chosen.vector
        };
    }
    if (!set.scope.exhaustive_over_enumerated) {
        return {
            survivor_id: mutant.id, status: 'unresolved-gap', method: 'probe-truncated',
            row_ids: mutant.row_ids, class: mutant.class, region: mutant.region,
            before: mutant.before, after: mutant.after,
            probes: { run: run, scope: set.scope },
            why: 'the probe domain was truncated to fit the ' + MAX_PROBES + '-probe budget, so '
                + 'invariance over the enumerated set does not prove equivalence, and no static '
                + 'argument is available for class ' + mutant.class
        };
    }
    return {
        survivor_id: mutant.id, status: 'equivalent-proven', method: 'dynamic-exhaustive',
        row_ids: mutant.row_ids, class: mutant.class, region: mutant.region,
        before: mutant.before, after: mutant.after,
        probes: { run: run, scope: set.scope },
        argument: 'over all ' + run + ' inputs in the enumerated domain (the product of every value the '
            + 'site reads takes across the recorded vectors plus the boundary set, times every recorded '
            + '/models payload' + (set.scope.config_counts.length > 1 ? ' and every config count in '
                + JSON.stringify(set.scope.config_counts) : '') + '), the mutant and the unmutated '
            + 'baseline produce byte-identical ' + mutant.channel + ' output, including identical throw '
            + 'messages where the baseline throws.'
    };
}

// --------------------------------------------------------------------- context ------------

function buildContext() {
    const gate = mutate.requireCommittedInputs();
    const gen = slices.slicedGenerators();
    const bag = runner.loadSnapshot();
    const kinds = slices.fieldKinds();
    const referenceVector = vectors.referenceFields();
    const inputs = vectors.readJson(path.join(mutate.SNAPSHOT, 'vectors', 'INPUTS.json'));
    const reference = { fields: referenceVector,
        settings: inputs.settings_sets[0].id, models: inputs.model_sets[0].id };
    const settingsById = new Map(inputs.settings_sets.map((set) => [set.id, set.settings]));
    // The same row-credit rule equivalence.js --verify applies: a vector is credited with a row when
    // that row's predicate flips against coverage-map.json's reference vector. coverage-map.json is
    // named in fixtures/HASH-PIN.json, so reading it live cannot move under the run.
    const creditRows = vectors.specRows().filter((row) => /^(BA|INI)-/.test(row.row_id))
        .filter(vectors.inDomain);
    const creditInputs = {
        modelsById: new Map(inputs.model_sets.map((set) => [set.id, set.models])),
        settingsById: new Map(inputs.settings_sets.map((set) => [set.id, set]))
    };
    const mapReference = vectors.readJson(path.join(vectors.VECTORS, 'coverage-map.json')).reference;
    const creditReference = bag.vectors.find((vector) => vector.id === mapReference)
        || { id: mapReference, fields: reference.fields, settings: reference.settings,
            models: reference.models };
    const creditValues = vectors.predicateTable(creditRows, [creditReference], gen,
        creditInputs.modelsById, creditInputs.settingsById).table.get(creditReference.id);
    return {
        gate: gate, gen: gen, bag: bag, kinds: kinds, reference: reference,
        settings: settingsById.get(reference.settings),
        flips: (vector) => flipTargets(vector, creditRows, gen, creditInputs, creditValues),
        observed: observedValues(bag), types: configLiteralTypes(gen),
        regionLinesByRegion: mutate.regionSources(gen),
        regionLines: mutate.regionSources(gen).args.lines,
        rowsById: new Map(vectors.specRows().map((row) => [row.row_id, row])),
        modelSets: modelSets(bag),
        page: pageFacts()
    };
}

// `staticProof` and `probeOutputs` read the site text out of the region the mutant belongs to, so the
// context resolves the line array per mutant rather than once.
function withRegion(ctx, mutant) {
    ctx.regionLines = ctx.regionLinesByRegion[mutant.region].lines;
    return ctx;
}

function proofFile(id) {
    return path.join(PROOFS, id + '.json');
}

function prove(options) {
    const ctx = buildContext();
    const run = JSON.parse(slices.readText(RUN_FILE));
    const mutants = mutate.enumerate();
    const byId = new Map(mutants.full.map((m) => [m.id, m]));
    const survivors = run.mutant_results.filter((m) => m.status === 'survived');
    fs.mkdirSync(PROOFS, { recursive: true });
    const results = [];
    const t0 = Date.now();
    survivors.forEach((record, index) => {
        const mutant = byId.get(record.id);
        vectors.assert(mutant, record.id + ': survivor is not in the current enumeration');
        const existing = fs.existsSync(proofFile(record.id))
            ? JSON.parse(slices.readText(proofFile(record.id))) : null;
        if (existing && existing.mutated_sha256 === mutant.mutated_sha256
                && !options.recompute) {
            results.push(existing);
            return;
        }
        withRegion(ctx, mutant);
        const proof = analyze(mutant, ctx, ctx.reference, index);
        const document = Object.assign({
            survivor_id: mutant.id,
            generated_by: 'tools/parity/equiv-prove.js',
            command: 'node tools/parity/equiv-prove.js',
            base_commit: ctx.gate.base,
            goldens_impl: run.goldens_impl,
            mutated_sha256: mutant.mutated_sha256,
            site: { region: mutant.region, line: mutant.line + 1, start: mutant.start, end: mutant.end },
            killed_in_run: { status: record.status, vectors_checked: record.vectors_checked }
        }, proof);
        fs.writeFileSync(proofFile(mutant.id), JSON.stringify(document, null, 2) + '\n', 'utf8');
        results.push(document);
        if ((index + 1) % 10 === 0 || index + 1 === survivors.length) {
            console.log('  proved ' + (index + 1) + '/' + survivors.length + ' survivors ('
                + Math.round((Date.now() - t0) / 1000) + 's)');
        }
    });
    return { run: run, survivors: survivors, results: results, ctx: ctx, mutants: mutants };
}

// ------------------------------------------------------------------ side artifacts --------

function writeProposals(results) {
    const gaps = results.filter((r) => r.status === 'gap-killer-synthesized');
    const byRow = new Map();
    for (const gap of gaps) {
        for (const row of gap.row_ids) {
            if (!byRow.has(row)) byRow.set(row, gap);
        }
    }
    const proposals = [...byRow.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([row, gap]) => ({
        vector_id: gap.proposed_vector.id,
        row_targeted: row,
        mutant_ids: gaps.filter((g) => g.row_ids.includes(row)).map((g) => g.survivor_id),
        classes: [...new Set(gaps.filter((g) => g.row_ids.includes(row))
            .map((g) => g.class))].sort(),
        proposed_file: 'fixtures/vectors/boundary/shrunk-mutation.jsonl (+ fixtures/goldens/boundary/'
            + 'shrunk-mutation.goldens.jsonl and a row claim in fixtures/vectors/'
            + 'coverage-promotions.json)',
        command_to_apply: 'node tools/parity/equiv-prove.js --apply --root <copy>   then, by the '
            + 'ledger holder: node tools/parity/gen-goldens.js && bash tools/parity/hash-pin.sh',
        vector_header: { kind: 'header', family: 'boundary',
            generator: 'tools/parity/equiv-prove.js', command: 'node tools/parity/equiv-prove.js',
            note: 'mutation-gap promotion: proposed by the Phase 2.6 survivor analysis, not applied '
                + 'because fixtures were frozen during the concurrent re-record' },
        vector: gap.proposed_vector,
        baseline_vs_mutant: gap.difference,
        note: 'this input makes the surviving mutant(s) differ from the unmutated baseline, so the '
            + 'recorded vector set does not assert this behavior; promoting it closes the gap.'
    }));
    const document = {
        generated_by: 'tools/parity/equiv-prove.js',
        command: 'node tools/parity/equiv-prove.js',
        status: 'PROPOSED — not applied by this tool. fixtures/** is hash-pinned (C8): applying means '
            + 'appending boundary/shrunk-mutation.jsonl + its goldens + a coverage-promotions.json row '
            + 'claim (node tools/parity/equiv-prove.js --apply --root <copy>), then regenerating the '
            + 'hash-pinned fixtures/vectors/MANIFEST.json and refreshing fixtures/HASH-PIN.json, which '
            + 'needs the ledger entry. See APPLIED.json for what an apply actually wrote.',
        base_commit: mutate.BASE_COMMIT,
        proposed_promotions: proposals.length,
        survivors_with_a_synthesized_killer: gaps.length,
        unresolved_gaps: results.filter((r) => r.status === 'unresolved-gap').map((r) => r.survivor_id),
        promotions: proposals
    };
    fs.writeFileSync(PROMOTIONS, JSON.stringify(document, null, 2) + '\n', 'utf8');
    return document;
}

// -------------------------------------------------------------------- apply ----------------

// Promote the synthesized gap killers into permanent boundary vectors, in the shape the harness
// already merges: `fixtures/vectors/boundary/shrunk-<name>.jsonl` + its twin
// `fixtures/goldens/boundary/shrunk-<name>.goldens.jsonl` (both read by equivalence.js loadSet), and
// the row claims in `fixtures/vectors/coverage-promotions.json` (merged by equivalence.js --verify).
// `coverage-map.json` is gen-vectors.js output and stays untouched.
//
// Append-only: an existing data line is never rewritten — applying twice adds nothing, and a second
// batch cannot silently reissue an id with different bytes. The goldens are recorded from the pinned
// baseline text through gen-goldens.js `record`, the same recorder every other golden uses (C5).
//
// `fixtures/vectors/MANIFEST.json` and `fixtures/HASH-PIN.json` are deliberately NOT written here:
// both are hash-pinned gate artifacts (C8) and a pin move needs a ledger entry, which is the ledger
// holder's act, not this tool's. --apply prints the two commands that finish the job.
const PROMOTED_VECTORS = 'fixtures/vectors/boundary/shrunk-mutation.jsonl';
const PROMOTED_GOLDENS = 'fixtures/goldens/boundary/shrunk-mutation.goldens.jsonl';
const PROMOTED_MAP = 'fixtures/vectors/coverage-promotions.json';
const APPLIED_RECORD = path.join(REPORTS, 'APPLIED.json');

function flipTargets(repro, rows, gen, inputs, referenceValues) {
    const table = vectors.predicateTable(rows, [repro], gen, inputs.modelsById, inputs.settingsById)
        .table.get(repro.id);
    return rows.filter((row) => table[row.row_id] !== null
        && table[row.row_id] !== referenceValues[row.row_id]).map((row) => row.row_id);
}

// Two killers can share a probe index (the probe set is per mutant), so a promoted id can collide;
// naming the second one after the mutant it was found for keeps both, append-only.
function altOf(repro, gap) {
    return 'shrunk-' + (repro.id.replace(/^shrunk-/, '') || 'vector') + '-' + gap.survivor_id.slice(-8);
}

// Add one known row-flipping field/value to a killer that credits no row, keeping the kill.
// For an ini-channel killer the value also goes into every saved config, because buildPresetIni reads
// the configs map rather than the form fields.
function creditableVariant(repro, baselineEv, mutantEv, deltas, rows, gen, inputs, referenceValues) {
    for (const delta of deltas) {
        const fields = Object.assign({}, repro.fields, { [delta.key]: delta.value });
        const candidate = Object.assign({}, repro, { fields: fields });
        if (repro.ini_configs) {
            const configs = {};
            for (const name of Object.keys(repro.ini_configs)) {
                configs[name] = Object.assign({}, repro.ini_configs[name], { [delta.key]: delta.value });
            }
            candidate.ini_configs = configs;
        }
        if (!equivalence.compare(baselineEv.output(candidate), mutantEv.output(candidate)).length) {
            continue;
        }
        const targets = flipTargets(candidate, rows, gen, inputs, referenceValues);
        if (!targets.length) continue;
        candidate.note_extra = 'credited by adding ' + delta.key + '=' + JSON.stringify(delta.value)
            + ' (a value a recorded boundary vector already flips ' + delta.rows
            + ' row(s) with); the kill itself comes from ' + (repro.ini_configs
                ? Object.keys(repro.ini_configs).length + ' saved configs'
                : 'the field differences above') + '.';
        return { repro: candidate, targets: targets, delta: delta };
    }
    return null;
}

// A mutant evaluator in equivalence.js's shape, driven by the mutated region text. Built here rather
// than reused from mutation-run.js because shrink() compares whole golden objects, not one channel.
function mutantEvaluator(gen, inputs, runner) {
    return equivalence.evaluator((vector) => {
        const models = inputs.modelsById.get(vector.models);
        const settings = inputs.settingsById.get(vector.settings).settings;
        let argv = null;
        let argvThrew = null;
        try {
            argv = runner.argv(vectors.argvFields(vector, gen), settings, models);
        } catch (error) {
            argvThrew = String(error && error.message);
        }
        let ini = null;
        let iniThrew = null;
        try {
            const bytes = runner.ini(vectors.iniConfigs(vector), models);
            ini = bytes === null ? null : Buffer.from(bytes, 'utf8').toString('base64');
        } catch (error) {
            iniThrew = String(error && error.message);
        }
        return { argv: argv, argv_threw: argvThrew, ini: ini, ini_threw: iniThrew };
    });
}

// Keep every existing line byte-for-byte; append only ids that are not already recorded.
function appendOnly(file, header, lines, key) {
    const existing = fs.existsSync(file)
        ? slices.readText(file).replace(/\r?\n$/, '').split(/\r?\n/).slice(1) : [];
    const have = new Map(existing.map((line) => [JSON.parse(line)[key], line]));
    const added = [];
    const repeated = [];
    for (const line of lines) {
        const id = JSON.parse(line)[key];
        if (have.has(id)) {
            vectors.assert(have.get(id) === line, file + ': ' + id + ' is already recorded with '
                + 'different bytes — append-only refuses to rewrite a fixture line');
            repeated.push(id);
            continue;
        }
        have.set(id, line);
        added.push(line);
    }
    const ordered = existing.filter((line) => !added.includes(line));
    return { text: [JSON.stringify(header)].concat(ordered.concat(added)).join('\n') + '\n',
        added: added.length, repeated: repeated };
}

function applyPromotions(options) {
    const root = path.resolve(options.root || REPO);
    const dry = !!options.dryRun;
    const run = vectors.readJson(RUN_FILE);
    const survivorIds = run.mutant_results.filter((m) => m.status === 'survived').map((m) => m.id);
    const proofs = survivorIds.map((id) => JSON.parse(slices.readText(proofFile(id))));
    const unresolved = proofs.filter((p) => p.status === 'unresolved-gap');
    vectors.assert(!unresolved.length, 'apply: ' + unresolved.length + ' survivor(s) are unresolved; '
        + 'a gap with no killing input must not be promoted');
    const gaps = proofs.filter((p) => p.status === 'gap-killer-synthesized')
        .sort((a, b) => a.survivor_id.localeCompare(b.survivor_id));
    vectors.assert(gaps.length, 'apply: run.json holds no gap survivor — nothing to promote');

    const gen = slices.slicedGenerators();
    const inputs = equivalence.loadInputs();
    const bag = equivalence.loadSet();
    const reference = equivalence.referenceVector(bag);
    const rows = vectors.specRows().filter((row) => /^(BA|INI)-/.test(row.row_id))
        .filter(vectors.inDomain);
    const referenceValues = vectors.predicateTable(rows, [reference], gen, inputs.modelsById,
        inputs.settingsById).table.get(reference.id);
    const mutants = new Map(mutate.enumerate().full.map((m) => [m.id, m]));
    const record = require('./gen-goldens.js');
    const impl = 'parity-baseline@' + record.baselineSha();
    const baselineEv = equivalence.baselineEvaluator(gen, inputs);

    const vectorLines = [];
    const goldenLines = [];
    const map = {};
    const ledger = [];
    const unpromotable = [];
    let earnedDelta = null;
    // One-field deltas that a recorded boundary vector already uses to flip a row: the credit currency
    // of equivalence.js --verify, offered to killers that flip nothing on their own.
    const creditDeltas = (() => {
        const seen = new Set();
        const out = [];
        for (const vector of bag.vectors) {
            if (vector.id === reference.id || !(vector.targets || []).length) continue;
            const diff = Object.keys(vector.fields).filter((key) => !(key in reference.fields)
                || JSON.stringify(vector.fields[key]) !== JSON.stringify(reference.fields[key]));
            if (diff.length !== 1) continue;
            const key = diff[0];
            const token = key + '=' + JSON.stringify(vector.fields[key]);
            if (seen.has(token)) continue;
            seen.add(token);
            out.push({ key: key, value: vector.fields[key], rows: vector.targets.length });
        }
        return out.sort((a, b) => b.rows - a.rows || a.key.localeCompare(b.key)
            || JSON.stringify(a.value).localeCompare(JSON.stringify(b.value)));
    })();
    const exprOf = (rowId) => {
        const row = rows.find((candidate) => candidate.row_id === rowId);
        return row ? vectors.rowExpr(row) : '?';
    };
    // Ids already in the promoted file: an append-only apply must never rewrite one, so a new vector
    // that wants a taken id is renamed instead.
    const recordedFile = path.join(root, PROMOTED_VECTORS);
    const taken = new Map(fs.existsSync(recordedFile)
        ? vectors.readJsonl(recordedFile).slice(1).map((v) => [v.id, JSON.stringify(v)]) : []);
    for (const gap of gaps) {
        const mutant = mutants.get(gap.survivor_id);
        vectors.assert(mutant, 'apply: ' + gap.survivor_id + ' is no longer enumerated — the mutant '
            + 'set moved, rerun the battery before promoting');
        vectors.assert(mutant.mutated_sha256 === gap.mutated_sha256, 'apply: ' + gap.survivor_id
            + ' mutated source moved (' + gap.mutated_sha256.slice(0, 12) + ' in the proof, '
            + mutant.mutated_sha256.slice(0, 12) + ' now)');
        const runner = mutate.mutantRunner(gen, mutant, [mutant]);
        const mutantEv = mutantEvaluator(gen, inputs, runner);
        const killer = gap.proposed_vector;
        earnedDelta = null;
        const separation = equivalence.compare(baselineEv.output(killer), mutantEv.output(killer));
        vectors.assert(separation.length, 'apply: ' + killer.id + ' no longer separates '
            + gap.survivor_id + ' from the baseline — refusing to promote a dead killer');
        // The ini channel reads ini_configs, not fields, so shrinking fields would empty the form
        // state without changing what this mutant sees: ini-region killers go in as probed.
        const shrunk = mutant.region === 'ini' ? null : equivalence.shrink(mutantEv, baselineEv,
            killer, inputs, reference);
        let repro = Object.assign({}, shrunk || killer, { kind: 'vector', family: 'boundary' });
        repro.id = 'shrunk-' + killer.id;
        repro.name = repro.id;
        let targets = flipTargets(repro, rows, gen, inputs, referenceValues);
        if (!targets.length && shrunk) {
            repro = Object.assign({}, killer, { kind: 'vector', family: 'boundary' });
            repro.id = 'shrunk-' + killer.id;
            repro.name = repro.id;
            targets = flipTargets(repro, rows, gen, inputs, referenceValues);
        }
        if (!targets.length) {
            // No row flips for the killer as probed. Before giving it up, try the smallest change that
            // can earn credit: add one field/value pair that a recorded boundary vector is already
            // known to flip a row with, and re-check that the mutant still separates. The structural
            // property the mutant breaks (ini section order over several saved configs, a strictness
            // comparison) is unaffected by an extra field, so the vector keeps killing — and now
            // coverage can credit it without a pinned artifact moving.
            const earned = creditableVariant(repro, baselineEv, mutantEv, creditDeltas, rows, gen,
                inputs, referenceValues);
            if (earned) {
                repro = earned.repro;
                targets = earned.targets;
                earnedDelta = earned.delta;
            }
        }
        if (!targets.length) {
            // A killer whose only difference is the NUMBER of saved configs cannot flip
            // `Object.entries(configs).length > 0`, and rows that read no field cannot be credited by
            // exercise either. Promoting it would need a new row expression (SPEC-ROWS.csv) or a
            // rowless-vector entry in coverage-exceptions.json — and that file is regenerated by
            // gen-vectors.js, so a hand entry breaks `gen-vectors --check`. Not this tool's call.
            unpromotable.push({ survivor_id: gap.survivor_id, killer_id: killer.id,
                class: gap.class, region: gap.region, row_ids: gap.row_ids,
                row_expressions: gap.row_ids.map((id) => id + ' = ' + exprOf(id)),
                fields_differing_from_reference: Object.keys(repro.fields)
                    .filter((key) => JSON.stringify(repro.fields[key])
                        !== JSON.stringify(reference.fields[key])),
                config_count: repro.ini_configs ? Object.keys(repro.ini_configs).length : 0,
                difference: gap.difference,
                why: 'no generator row flips for this input, and no single row-flipping field could '
                    + 'be added without losing the kill',
                tried_deltas: creditDeltas.length,
                blocked_on: ['SPEC/SPEC-ROWS.csv (a row whose expression counts saved configs)',
                    'gen-vectors.js (to record a promoted rowless vector in coverage-exceptions.json)'] });
            console.log('  SKIP ' + killer.id + '  <- ' + gap.survivor_id
                + '  (no row flips: ' + gap.row_ids.join(', ') + ')');
            continue;
        }
        repro.note = 'mutation-gap killer for ' + gap.survivor_id + ' (' + gap.class + ', '
            + gap.region + ' line ' + (gap.site ? gap.site.line : '?') + '): `' + gap.before
            + '` -> `' + gap.after + '`. ' + (shrunk ? 'Shrunk to the minimal form state that still '
                + 'separates the mutant from the baseline.' : 'Promoted as probed: the ini channel '
                + 'reads ini_configs, so field shrinking would not minimize this vector.')
            + ' Killer synthesized by the Phase 2.6 probe search (PROMOTIONS-PROPOSED.json), applied '
            + 'by node tools/parity/equiv-prove.js --apply.';
        repro.targets = targets;
        repro.targets_via = 'flip';
        if (earnedDelta) {
            repro.note += ' ' + repro.note_extra;
            delete repro.note_extra;
        }
        let vectorLine = JSON.stringify(repro);
        // An id can be taken by a different vector (two killers can share a probe index) or by this
        // same vector from an earlier batch. Prefer the id whose recorded line is identical — that is
        // a re-apply, and appendOnly will skip it — and otherwise name this one after the mutant it
        // was found for. Nothing already recorded is ever rewritten.
        if (taken.has(repro.id) && taken.get(repro.id) !== vectorLine) {
            repro.id = altOf(repro, gap);
            repro.name = repro.id;
            vectorLine = JSON.stringify(repro);
            vectors.assert(taken.get(repro.id) === undefined || taken.get(repro.id) === vectorLine,
                'apply: ' + repro.id + ' is already recorded with different bytes');
            if (!taken.has(repro.id)) {
                vectors.assert(flipTargets(repro, rows, gen, inputs, referenceValues).length,
                    'apply: renaming ' + repro.id + ' lost its row coverage');
            }
        }
        taken.set(repro.id, vectorLine);
        if (!vectorLines.includes(vectorLine)) vectorLines.push(vectorLine);
        const golden = Object.assign({ kind: 'golden', vector_id: repro.id, impl: impl },
            record.record(gen, repro, inputs.modelsById.get(repro.models),
                inputs.settingsById.get(repro.settings).settings));
        if (!goldenLines.some((line) => JSON.parse(line).vector_id === repro.id)) {
            goldenLines.push(JSON.stringify(golden));
        }
        for (const row of targets) {
            map[row] = map[row] || [];
            if (!map[row].includes(repro.id)) map[row].push(repro.id);
        }
        ledger.push({ survivor_id: gap.survivor_id, vector_id: repro.id, class: gap.class,
            credited_by_delta: earnedDelta ? earnedDelta.key + '=' + JSON.stringify(earnedDelta.value)
                : null,
            region: gap.region, rows: targets, shrunk: !!shrunk,
            fields_dropped: shrunk ? Object.keys(killer.fields).length - Object.keys(shrunk.fields).length
                : 0,
            difference: gap.difference });
        console.log('  ' + repro.id + '  <- ' + gap.survivor_id + '  (' + targets.length
            + ' row(s)' + (shrunk ? ', ' + ledger[ledger.length - 1].fields_dropped + ' field(s) shrunk'
                : earnedDelta ? ', credited by ' + earnedDelta.key
                    : ', promoted as probed') + ')');
    }

    const vectorHeader = { kind: 'header', family: 'boundary', generator: 'tools/parity/equiv-prove.js',
        command: 'node tools/parity/equiv-prove.js --apply', source_family: 'mutation',
        count: vectorLines.length,
        note: 'killing inputs for the Phase 2.6 mutation gaps: each one separates a surviving mutant '
            + 'from the unmutated baseline, so the recorded vector set did not assert that behavior. '
            + 'Goldens are recorded from the baseline (C5), the same recorder as every other family.' };
    const goldenHeader = { kind: 'header', family: 'boundary', generator: 'tools/parity/equiv-prove.js',
        command: 'node tools/parity/equiv-prove.js --apply',
        vectors_file: PROMOTED_VECTORS, count: goldenLines.length };
    const writes = vectorLines.length ? [
        { file: PROMOTED_VECTORS, ...appendOnly(path.join(root, PROMOTED_VECTORS), vectorHeader,
            vectorLines, 'id') },
        { file: PROMOTED_GOLDENS, ...appendOnly(path.join(root, PROMOTED_GOLDENS), goldenHeader,
            goldenLines, 'vector_id') }
    ] : [];
    const mapFile = path.join(root, PROMOTED_MAP);
    const existingMap = fs.existsSync(mapFile) ? vectors.readJson(mapFile)
        : { generated_by: 'tools/parity/equiv-prove.js',
            command: 'node tools/parity/equiv-prove.js --apply',
            note: 'row claims for promoted repros; equivalence.js --verify merges these into '
                + 'coverage-map.json instead of rewriting a file gen-vectors.js owns', map: {} };
    let mapRows = 0;
    for (const [row, ids] of Object.entries(map)) {
        existingMap.map[row] = existingMap.map[row] || [];
        for (const id of ids) {
            if (!existingMap.map[row].includes(id)) {
                existingMap.map[row].push(id);
                mapRows += 1;
            }
        }
    }
    const manifestGap = manifestBlindSpots(root, writes.map((write) => write.file)
        .concat(mapRows ? [PROMOTED_MAP] : []));
    const appliedFile = path.join(root, 'tools', 'parity', 'reports', 'mutation', 'APPLIED.json');
    // APPLIED.json is a ledger, not a status file: an apply that promotes nothing (because an earlier
    // batch already killed those mutants) must not erase what was already promoted.
    const previous = fs.existsSync(appliedFile) ? vectors.readJson(appliedFile) : null;
    const killers = ((previous && previous.killers) || []).slice();
    for (const entry of ledger) {
        if (!killers.some((k) => k.vector_id === entry.vector_id)) killers.push(entry);
    }
    const residue = ((previous && previous.unpromotable_gaps) || []).slice();
    for (const gap of unpromotable) {
        const at = residue.findIndex((g) => g.survivor_id === gap.survivor_id);
        if (at >= 0) residue[at] = gap;
        else residue.push(gap);
    }
    const openResidue = residue.filter((gap) => !killers.some((k) => k.survivor_id === gap.survivor_id));
    const rowClaims = ((previous && previous.row_claims) || 0) + mapRows;
    if (!dry) {
        for (const write of writes) {
            fs.mkdirSync(path.dirname(path.join(root, write.file)), { recursive: true });
            fs.writeFileSync(path.join(root, write.file), write.text, 'utf8');
        }
        if (mapRows) fs.writeFileSync(mapFile, JSON.stringify(existingMap, null, 2) + '\n', 'utf8');
        fs.writeFileSync(appliedFile, JSON.stringify({
            generated_by: 'tools/parity/equiv-prove.js',
            command: 'node tools/parity/equiv-prove.js --apply --root ' + root,
            base_commit: mutate.BASE_COMMIT,
            goldens_impl: impl,
            vectors_file: PROMOTED_VECTORS,
            goldens_file: PROMOTED_GOLDENS,
            coverage_file: PROMOTED_MAP,
            promoted_vectors: killers.length,
            row_claims: rowClaims,
            killers: killers,
            unpromotable_gaps: openResidue,
            manifest_gap: manifestGap,
            manifest_note: 'running gen-goldens.js today rewrites MANIFEST.json byte-identically, '
                + 'because manifest() enumerates only the five generator families — so promoting these '
                + 'files needs no hash-pin move. It does mean gen-goldens.js --check reports them as '
                + '"on disk but not in the manifest" until that writer covers promoted files.',
            not_written: ['fixtures/vectors/MANIFEST.json', 'fixtures/HASH-PIN.json',
                'fixtures/vectors/coverage-map.json', 'fixtures/vectors/coverage-exceptions.json',
                'SPEC/SPEC-ROWS.csv', 'PARITY.md'],
            still_required: ['extend gen-goldens.js manifest() to list boundary/shrunk-*.jsonl, its '
                + 'goldens twin and coverage-promotions.json (the fixture owner), then rerun '
                + 'node tools/parity/gen-goldens.js; that changes the hash-pinned MANIFEST.json, so it '
                + 'needs the ledger entry and a bash tools/parity/hash-pin.sh refresh'],
            note: 'Applied inside the mutation owner\'s scope: append-only vector + golden files and '
                + 'the promotion map. The hash-pinned artifacts listed under not_written belong to '
                + 'the ledger holder; an unpromotable gap needs one of them changed.'
        }, null, 2) + '\n', 'utf8');
    }
    for (const write of writes) {
        console.log((dry ? 'would write ' : 'wrote ') + write.file + ' (' + write.added
            + ' new line(s), ' + write.repeated.length + ' already recorded)');
    }
    console.log((dry ? 'would write ' : 'wrote ') + PROMOTED_MAP + ' (' + mapRows
        + ' new row claim(s))');
    if (unpromotable.length) {
        console.log(unpromotable.length + ' gap(s) NOT promoted: no generator row flips for their '
            + 'killer, so --verify could not credit them.');
        for (const item of unpromotable) {
            console.log('  ' + item.survivor_id + ' — ' + item.why);
            console.log('    blocked on: ' + item.blocked_on.join(' / '));
        }
    }
    console.log('not written (hash-pinned, C8): fixtures/vectors/MANIFEST.json, '
        + 'fixtures/HASH-PIN.json, fixtures/vectors/coverage-map.json');
    if (manifestGap.length) {
        console.log('manifest gap: gen-goldens.js manifest() does not list ' + manifestGap.length
            + ' promoted file(s), so `gen-goldens.js --check` reports them as unlisted. Extending '
            + 'that writer is the fixture owner\'s change, not this tool\'s: ' + manifestGap.join(', '));
    } else {
        console.log('manifest: every promoted file is listed by gen-goldens.js manifest()');
    }
    console.log('to finish: node tools/parity/gen-goldens.js  &&  bash tools/parity/hash-pin.sh');
    return { vectors: vectorLines.length, rows: mapRows, ledger: ledger,
        unpromotable: unpromotable, manifest_gap: manifestGap };
}

// gen-goldens.js writes fixtures/vectors/MANIFEST.json and its --check requires every .jsonl/.json
// under the fixture directories to be listed. Report honestly whether the writer covers the promoted
// files (this run's writes and any already on disk), instead of leaving a red gate for the next reader
// to explain.
function manifestBlindSpots(root, pending) {
    const onDisk = [];
    const dir = path.join(root, 'fixtures', 'vectors', 'boundary');
    if (fs.existsSync(dir)) {
        for (const name of fs.readdirSync(dir).filter((n) => /^shrunk-.*\.jsonl$/.test(n)).sort()) {
            onDisk.push('fixtures/vectors/boundary/' + name);
            onDisk.push('fixtures/goldens/boundary/' + name.replace(/\.jsonl$/,
                '.goldens.jsonl'));
        }
    }
    if (fs.existsSync(path.join(root, PROMOTED_MAP))) onDisk.push(PROMOTED_MAP);
    for (const file of pending || []) if (!onDisk.includes(file)) onDisk.push(file);
    const manifestFile = path.join(root, 'fixtures', 'vectors', 'MANIFEST.json');
    if (!fs.existsSync(manifestFile)) return onDisk;
    const listed = new Set(vectors.readJson(manifestFile).files.map((entry) => entry.file));
    return onDisk.filter((file) => !listed.has(file));
}

// ESCALATION.md is append-only (plan §4). Only an `unresolved-gap` — no static argument, no difference
// found, and a probe set too large to call exhaustive — earns an entry.
function escalate(results) {
    const gaps = results.filter((r) => r.status === 'unresolved-gap');
    if (!gaps.length) return 0;
    const lines = gaps.map((gap) => [
        '## ' + gap.survivor_id + ' — mutation survivor, unresolved (Phase 2.6)',
        '',
        '- class `' + gap.class + '` on ' + gap.region + ' line '
            + (gap.site ? gap.site.line : '?') + ': `' + gap.before + '` -> `' + gap.after + '`',
        '- rows: ' + gap.row_ids.join(', '),
        '- evidence: ' + gap.probes.run + ' probes run, scope ' + JSON.stringify(gap.probes.scope),
        '- why unresolved: ' + gap.why,
        '- impact: this is a vector-set completeness question, not a candidate defect; the goldens and '
            + 'the baseline are unaffected, so no PARITY.md row changes status.',
        ''
    ].join('\n'));
    fs.appendFileSync(ESCALATION, '\n' + lines.join('\n'), 'utf8');
    return gaps.length;
}

// ------------------------------------------------------------------- report ---------------

const statusOf = (r) => r.status === 'equivalent-proven'
    ? (r.method === 'static' ? 'equivalent-static' : 'equivalent-dynamic') : r.status;

function pruneProofs(survivorIds) {
    const keep = new Set(survivorIds);
    const removed = [];
    if (!fs.existsSync(PROOFS)) return removed;
    for (const name of fs.readdirSync(PROOFS)) {
        if (!/\.json$/.test(name)) continue;
        const id = name.replace(/\.json$/, '');
        if (keep.has(id)) continue;
        fs.unlinkSync(path.join(PROOFS, name));
        removed.push(id);
    }
    return removed;
}

// The two regions that are known to the enumerator but not scored by this report, stated from the
// artifacts rather than from memory: `save` (the localStorage writer) and `server` (enumerated only,
// by the supervisor ruling of 2026-11-25). A mutation report that lists fewer regions than the
// enumerator knows is how a coverage gap becomes invisible, so both appear with what a reader can
// re-run.
function regionSection(run, results) {
    const lines = [];
    const shipped = fs.existsSync(MUTANTS_FILE) ? JSON.parse(slices.readText(MUTANTS_FILE)) : null;
    const tally = (list) => list.reduce((all, item) => {
        all[item.region] = (all[item.region] || 0) + 1;
        return all;
    }, {});
    const live = tally(mutate.enumerate().mutants);
    const shippedRegions = tally((shipped && shipped.mutants) || []);
    const scored = tally(run.mutant_results);
    const killed = tally(run.mutant_results.filter((m) => m.status === 'killed'));
    const survived = tally(run.mutant_results.filter((m) => m.status === 'survived'));
    const proven = tally(results);
    const serverPath = path.join(REPO, mutate.SERVER_ENUM_FILE);
    const server = fs.existsSync(serverPath) ? JSON.parse(slices.readText(serverPath)) : null;
    const serverShipped = shippedRegions.server || 0;
    const num = (value) => (value === undefined ? 0 : value);

    lines.push('`config` / `args` / `ini` are the regions this report scores. Two more have sites in');
    lines.push('`tools/parity/mutate.js`, and this table says how far each has actually got — produced');
    lines.push('by the enumerator, shipped in the inventory, scored with a verdict — because the');
    lines.push('difference between `unscored` and `equivalent` is exactly what this table is for.');
    lines.push('');
    lines.push('| region | site inventory | mutants the enumerator produces | in `mutants.json` | scored in `run.json` | killed | survived | proven in this report |');
    lines.push('|---|---|---|---|---|---|---|---|');
    const known = [
        ['save', '`SCV-*` rows (28) over the `ANCHORS.SAVE_START` slice of `public/script.js`',
            num(live.save)],
        ['server', '`SV-*` rows (49) over the whole `' + slices.BASELINE + ':server.js` blob',
            server ? num(server.totals.mutants) : 0]
    ];
    for (const [region, inventory, count] of known) {
        lines.push('| `' + region + '` | ' + inventory + ' | ' + count + ' | '
            + num(shippedRegions[region]) + ' | ' + num(scored[region]) + ' | ' + num(killed[region])
            + ' | ' + num(survived[region]) + ' | ' + num(proven[region]) + ' |');
    }
    lines.push('');
    const saveShipped = num(shippedRegions.save);
    const saveScored = num(scored.save);
    const saveWhole = saveShipped === num(live.save) && saveScored === num(live.save);
    lines.push('The `save` figure is what `node tools/parity/mutate.js --dump` '
        + (saveWhole ? 'ships today' : 'would ship today') + '; the');
    lines.push('`server` figure is what `node tools/parity/mutate.js --dump-server` writes to its own');
    lines.push('unrun file — `--dump` produces 0 server mutants, and `--dump-server` asserts that it');
    lines.push('stays that way. That assertion is the ruling this table records.');
    lines.push('');
    if (saveWhole) {
        lines.push('**`save` — enumerated, shipped, scored.** `mutate.js` enumerates ' + num(live.save)
            + ' save');
        lines.push('mutants from the 28 `SCV-*` rows; all ' + saveShipped + ' are in `mutants.json` and all '
            + saveScored + ' carry a');
        lines.push('verdict in `run.json`. Their kill channel is the recorded re-save corpus');
        lines.push('(`fixtures/goldens/resave/`, ' + ((run.save_corpus || {}).recorded_resessions)
            + ' recorded sessions) because the localStorage bytes');
        lines.push('a re-save writes are the only output this region has — no argv or ini vector can see it.');
        lines.push('They kill ' + num(killed.save) + '; the ' + num(survived.save) + ' survivor(s) are proven by the');
        lines.push('`unreachable-element-guard-fallback` static strategy, which');
        lines.push('`node tools/parity/equiv-prove.js --selftest` asserts by name.');
        lines.push('');
        lines.push('The region landed after the `9d6a767` baseline its vectors come from, so shipping it');
        lines.push('moved pinned artifacts (`mutants.json`, `run.json`, `results/`, `proofs/`, this report)');
        lines.push('— a C8 ledger entry for the pin holder, which the tool does not write for itself.');
    } else {
        lines.push('**`save` — the channel exists; the shipped run predates it.** `mutate.js` enumerates');
        lines.push(num(live.save) + ' save mutants from the 28 `SCV-*` rows and scores them against the');
        lines.push('recorded re-save corpus (`fixtures/goldens/resave/`), and the');
        lines.push('`unreachable-element-guard-fallback` static strategy is asserted by name in');
        lines.push('`node tools/parity/equiv-prove.js --selftest`. The');
        lines.push('committed `mutants.json` was written before the region landed, so those mutants are');
        lines.push('not in it, carry no verdict in `run.json`, and own no file in `proofs/`. Regenerating');
        lines.push('`mutants.json` + `run.json` + this report moves a pinned artifact (C8): that is a ledger');
        lines.push('entry for the pin holder, not a step this tool takes on its own authority. Until then');
        lines.push('the save region is reported as unscored, never as clean.');
    }
    lines.push('');
    if (server) {
        const totals = server.totals || {};
        lines.push('**`server` — enumerated, deliberately unrun** (`status: ' + server.status + '`, in');
        lines.push('`' + mutate.SERVER_ENUM_FILE + '`, written by `' + server.command + '`):');
        lines.push(totals.mutants + ' mutants over ' + totals.rows_with_a_site + '/' + totals.sv_rows
            + ' `SV-*` rows; classes ' + Object.keys(totals.classes || {}).sort().join(', ') + ';');
        lines.push((totals.rejected_mutants || []).length
            + ' rejected because the mutated file will not parse.');
        lines.push('They are NOT in `mutants.json` (' + serverShipped + ' `server`-region ids there)');
        lines.push('because `mutation-run.js` kills through the argv/ini/save channels and no channel');
        lines.push('reaches a route: a scored run would print `survived` where the truth is `unmeasured`.');
        lines.push('`tools/parity/tasks/task-server-mutation.md` is the work that makes them scoreable');
        lines.push('(kill channel first, then `bodyStatements()` learn the `res.json` / `io.emit` emit');
        lines.push('shapes, which is why the enumeration has no statement-removal mutants at all). The');
        lines.push('one server-region claim the suites make today is a negative control, not inventory:');
        lines.push('`SV-get-settings-3-string-literal` in `fixtures/NEGATIVES.md`, red as named on');
        lines.push('`L1.SETTINGS.FIRST-RUN.BYTES`.');
    } else {
        lines.push('**`server` — not enumerated.** `' + mutate.SERVER_ENUM_FILE + '` is missing; run');
        lines.push('`node tools/parity/mutate.js --dump-server`. The region is reported as unscored.');
    }
    return lines;
}

function writeReport(run, results, options) {
    const byId = new Map(results.map((r) => [r.survivor_id, r]));
    const groups = { 'equivalent-static': [], 'equivalent-dynamic': [], 'gap-killer-synthesized': [],
        'unresolved-gap': [] };
    for (const r of results) groups[statusOf(r)].push(r);
    const rows = vectors.specRows().filter((row) => /^(BA|INI)-/.test(row.row_id));
    const rowsById = new Map(rows.map((row) => [row.row_id, row]));
    const mutantRows = run.rows;

    const counts = { enumerated: run.mutants.enumerated, killed: run.mutants.killed,
        survived: run.mutants.survived,
        static: groups['equivalent-static'].length, dynamic: groups['equivalent-dynamic'].length,
        gap: groups['gap-killer-synthesized'].length, unresolved: groups['unresolved-gap'].length };
    const accounted = counts.killed + counts.static + counts.dynamic + counts.gap + counts.unresolved;

    const classTable = {};
    for (const m of run.mutant_results) {
        const row = classTable[m.class] || { mutants: 0, killed: 0, static: 0, dynamic: 0, gap: 0,
            unresolved: 0 };
        row.mutants += 1;
        if (m.status === 'killed') row.killed += 1;
        else {
            const proof = byId.get(m.id);
            const group = proof ? statusOf(proof) : 'unproven';
            if (group === 'equivalent-static') row.static += 1;
            else if (group === 'equivalent-dynamic') row.dynamic += 1;
            else if (group === 'gap-killer-synthesized') row.gap += 1;
            else row.unresolved += 1;
        }
        classTable[m.class] = row;
    }

    const out = [];
    out.push('# Phase 2.6 — mutation testing the two baseline generators');
    out.push('');
    out.push('Machine-written by `node tools/parity/equiv-prove.js`. Reproduce with:');
    out.push('');
    out.push('```');
    out.push('node tools/parity/mutate.js --selftest');
    out.push('node tools/parity/mutate.js --dump');
    out.push('node tools/parity/mutation-run.js --selftest');
    out.push('node tools/parity/mutation-run.js --tier1 300 --workers 8');
    out.push('node tools/parity/equiv-prove.js');
    out.push('```');
    out.push('');
    out.push('- mutated source: the `parity-baseline` inline blocks sliced by `tools/parity/baseline-slices.js`,');
    out.push('  mutated **in memory** — `public/script.js`, `legacy/lib`, `fixtures/**` and `tests/**` are untouched.');
    out.push('- inputs: private snapshot of the committed `' + run.base_commit.slice(0, 7)
        + '` vectors + goldens (`tools/parity/reports/mutation/.snapshot/`, ' + run.snapshot.files
        + ' files, ' + run.snapshot.mismatched_against_commit + ' mismatching that commit); goldens impl ');
    out.push('  `' + run.goldens_impl + '`. A fixture re-record runs concurrently, so live `fixtures/**` is');
    out.push('  never read: a mutation baseline that moves under the run cannot be compared with the ledger.');
    out.push('- site inventory: `SPEC/SPEC-ROWS.csv`, `BA-*`/`INI-*` rows (line + kind per row).');
    out.push('');
    out.push('## Totals');
    out.push('');
    out.push('| | count |');
    out.push('|---|---|');
    out.push('| mutants enumerated | ' + counts.enumerated + ' |');
    out.push('| killed by a recorded vector | ' + counts.killed + ' |');
    out.push('| survived | ' + counts.survived + ' |');
    out.push('| survived, equivalent — static proof | ' + counts.static + ' |');
    out.push('| survived, equivalent — exhaustive-probe proof | ' + counts.dynamic + ' |');
    out.push('| survived, gap — killing vector synthesized | ' + counts.gap + ' |');
    out.push('| unresolved gaps | ' + counts.unresolved + ' |');
    out.push('| killed + explained | ' + accounted + ' of ' + counts.enumerated + ' |');
    out.push('| **mutation score (killed / enumerated)** | **' + run.mutants.score + '** |');
    out.push('| **ceiling score (killed + proven-equivalent + gap-killer) / enumerated** | **'
        + (100 * (counts.killed + counts.static + counts.dynamic + counts.gap)
            / counts.enumerated).toFixed(2) + '%** |');
    out.push('');
    out.push('Runtime: kill check ' + (run.runtime_ms / 1000).toFixed(1) + 's on ' + run.workers
        + ' worker process(es); tier 1 = first ' + run.vectors.tier1 + ' vectors of ' + run.vectors.total
        + ', ' + (run.mutants.by_tier.tier2 || 0) + ' mutants needed the remaining ' + run.vectors.rest
        + '. Tier control: ' + run.tier_control.sample_size + ' seeded tier-1 kills re-run over the full '
        + 'set, ' + run.tier_control.disagreements + ' disagreement(s).');
    out.push('');
    out.push('## By class');
    out.push('');
    out.push('| class | mutants | killed | equiv-static | equiv-dynamic | gap (killer synthesized) | unresolved |');
    out.push('|---|---|---|---|---|---|---|');
    for (const cls of Object.keys(classTable).sort((a, b) => classTable[b].mutants
        - classTable[a].mutants || a.localeCompare(b))) {
        const row = classTable[cls];
        out.push('| ' + cls + ' | ' + row.mutants + ' | ' + row.killed + ' | ' + row.static + ' | '
            + row.dynamic + ' | ' + row.gap + ' | ' + row.unresolved + ' |');
    }
    out.push('');
    out.push('## The two regions outside the generators: `save` and `server`');
    out.push('');
    out.push(...regionSection(run, results));
    out.push('');
    out.push('## Per-row map (every BA-*/INI-* row)');
    out.push('');
    out.push('`survivors` counts mutants that no recorded vector killed; each one is accounted for in');
    out.push('`proofs/`. Rows with no generator site are the launch preludes (alert-and-return guards,');
    out.push('response handling, catch clauses): no generator input reaches them, so they are asserted by');
    out.push('the L1 HTTP suites (plan §4), not here — the "note" column says which.');
    out.push('');
    out.push('| row | kind | file:line | mutants | killed | survivors | outcome | note |');
    out.push('|---|---|---|---|---|---|---|---|');
    const noSite = new Map();
    for (const row of rows) {
        const tally = mutantRows[row.row_id];
        if (!tally) {
            out.push('| ' + row.row_id + ' | ' + row.kind + ' | ' + row.file + ':' + row.line
                + ' | 0 | 0 | 0 | no generator site | outside both generators: ' + row.fn_or_route
                + ', unreachable from a generator input (C2 for dead code, L1 for live preludes) |');
            noSite.set(row.row_id, row);
            continue;
        }
        const outcomes = new Map();
        for (const id of tally.survivor_ids || []) {
            const proof = byId.get(id);
            const group = proof ? statusOf(proof) : 'UNPROVEN';
            outcomes.set(group, (outcomes.get(group) || 0) + 1);
        }
        const outcome = [...outcomes.entries()].sort().map(([k, n]) => k + ':' + n).join(' ') || '—';
        const note = (tally.survivor_ids || []).length
            ? 'proofs: ' + (tally.survivor_ids || []).map((id) => id.replace(/^M-/, ''))
                .slice(0, 3).join(', ') + ((tally.survivor_ids || []).length > 3 ? ' …' : '')
            : 'every mutant killed by a recorded vector';
        out.push('| ' + row.row_id + ' | ' + row.kind + ' | ' + row.file + ':' + row.line + ' | '
            + tally.mutants + ' | ' + tally.killed + ' | ' + tally.survived + ' | ' + outcome + ' | '
            + note + ' |');
    }
    out.push('');
    out.push('## Survivors worth reading');
    out.push('');
    const notable = results.filter((r) => r.status !== 'equivalent-proven'
        || r.method !== 'static').sort((a, b) => a.survivor_id.localeCompare(b.survivor_id));
    out.push('| survivor | class | region | rows | status | evidence |');
    out.push('|---|---|---|---|---|---|');
    for (const r of notable) {
        const evidence = r.status === 'gap-killer-synthesized'
            ? 'probe #' + r.killing_probe.index + ' differs: ' + String(r.difference[0]).slice(0, 120)
            : r.method === 'static' ? r.static.argument
                : r.probes.run + ' probes, product ' + (r.probes.scope ? r.probes.scope.full_product : 0);
        out.push('| ' + r.survivor_id + ' | ' + r.class + ' | ' + r.region + ' | ' + r.row_ids.join(' ')
            + ' | ' + statusOf(r) + ' | ' + String(evidence).replace(/\|/g, '/').replace(/\n/g, ' ')
            + ' |');
    }
    out.push('');
    out.push('## Vector-weakness rows');
    out.push('');
    out.push('Rows whose mutants were not all killed, ranked by survivors. A row is only weak where the');
    out.push('survivors are gaps: a proven-equivalent survivor is the vectors being right, not thin.');
    out.push('The `action` column is what feeds the promotion loop.');
    out.push('');
    out.push('| row | kind | mutants | killed | survivors | gap survivors | action |');
    out.push('|---|---|---|---|---|---|---|');
    const weak = rows.filter((row) => mutantRows[row.row_id]
        && mutantRows[row.row_id].survived > 0).map((row) => {
        const tally = mutantRows[row.row_id];
        const gaps = (tally.survivor_ids || []).filter((id) => byId.get(id)
            && byId.get(id).status !== 'equivalent-proven').length;
        return { row: row, tally: tally, gaps: gaps };
    }).sort((a, b) => b.gaps - a.gaps || b.tally.survived - a.tally.survived
        || a.row.row_id.localeCompare(b.row.row_id));
    for (const item of weak.slice(0, 25)) {
        const action = item.gaps
            ? 'PROMOTE: ' + item.gaps + ' synthesized killing input(s) in PROMOTIONS-PROPOSED.json'
            : 'none — every survivor carries an equivalence proof';
        out.push('| ' + item.row.row_id + ' | ' + item.row.kind + ' | ' + item.tally.mutants + ' | '
            + item.tally.killed + ' | ' + item.tally.survived + ' | ' + item.gaps + ' | ' + action + ' |');
    }
    out.push('');
    out.push('(' + weak.length + ' rows have a surviving mutant; ' + weak.filter((i) => i.gaps).length
        + ' of them have at least one gap. Full list in `run.json` under `rows`.');
    out.push('');
    out.push('## Reproducibility of the run itself');
    out.push('');
    out.push('- `results/<class>.jsonl` is an append-only verdict journal (one line per mutant, flushed per');
    out.push('  mutant) plus `results/verification.jsonl` for the tier-control re-checks. A restart skips any');
    out.push('  mutant id whose recorded verdict carries the same mutated-source sha256, so an interrupted');
    out.push('  run resumes instead of repeating; `--rerun` ignores the journal and re-measures everything.');
    out.push('- Two independent `--rerun` passes produced byte-identical `run.json` apart from `runtime_ms`;');
    out.push('  `mutants.json` is byte-identical across `--dump` passes; the proof set is identical across');
    out.push('  `--recompute` passes.');
    out.push('');
    const applied = fs.existsSync(APPLIED_RECORD) ? vectors.readJson(APPLIED_RECORD) : null;
    if (applied) {
        out.push('## Promotions applied');
        out.push('');
        out.push('`APPLIED.json` — ' + applied.promoted_vectors + ' killing input(s) promoted into `' + applied.vectors_file
            + '` with `' + applied.goldens_file + '` and ' + applied.row_claims
            + ' row claim(s) in `' + applied.coverage_file + '` (`equivalence.js --verify` merges that '
            + 'map; `coverage-map.json` stays `gen-vectors.js` output). Append-only: no existing fixture '
            + 'line was rewritten.');
        out.push('');
        out.push('| promoted vector | kills | class | rows credited | shrunk |');
        out.push('|---|---|---|---|---|');
        for (const killer of applied.killers || []) {
            out.push('| ' + killer.vector_id + ' | ' + killer.survivor_id + ' | ' + killer.class + ' | '
                + killer.rows.length + ' | ' + (killer.shrunk ? killer.fields_dropped + ' field(s) dropped'
                    : 'no — ini channel') + ' |');
        }
        out.push('');
        if ((applied.unpromotable_gaps || []).length) {
            out.push('**Residue: ' + applied.unpromotable_gaps.length + ' gap(s) could not be promoted.** '
                + 'No generator row flips for their killing input, so `equivalence.js --verify` could not '
                + 'credit the vector and `--verify` would report it as a rowless vector:');
            out.push('');
            for (const gap of applied.unpromotable_gaps) {
                out.push('- `' + gap.survivor_id + '` (' + gap.class + ', rows '
                    + gap.row_ids.join(' ') + ' — ' + gap.row_expressions.join('; ') + ') — blocked on '
                    + gap.blocked_on.join(' / ') + ', both hash-pinned (C8).');
            }
            out.push('');
        }
        if ((applied.manifest_gap || []).length) {
            out.push('**Open harness gap:** `gen-goldens.js manifest()` lists only the five generator '
                + 'families, so it does not list the ' + applied.manifest_gap.length
                + ' promoted file(s) (' + applied.manifest_gap.join(', ') + ') while its `--check` '
                + 'requires every fixture `.jsonl`/`.json` to be listed. `gen-goldens.js --check` is red '
                + 'on those entries until the fixture owner extends that writer; the golden *bytes* are '
                + 'not stale (0 stale files) and `MANIFEST.json` needs no hash-pin move because the '
                + 'writer does not change what it emits.');
            out.push('');
        }
        out.push('');
    }
    out.push('## Gates');
    out.push('');
    for (const gate of options.gates) {
        out.push('- [' + (gate.ok ? 'x' : ' ') + '] ' + gate.name + ' — ' + gate.detail);
    }
    out.push('');
    out.push('## What feeds back');
    out.push('');
    out.push('- `PROMOTIONS-PROPOSED.json`: ' + options.proposals.proposed_promotions
        + ' vector(s) that separate a surviving mutant from the baseline. Not applied here: fixtures are');
    out.push('  hash-pinned and being re-recorded, so the parent appends them under');
    out.push('  `fixtures/vectors/boundary/promotion-mutation-*.jsonl`, adds them to `coverage-map.json`,');
    out.push('  and regenerates goldens. Until then the gap stays visible in this report, not hidden.');
    out.push('- `proofs/<survivor-id>.json`: ' + results.length + ' file(s), one per survivor, each naming');
    out.push('  the static argument or the exact probe domain, so the Auditor can re-prove without');
    out.push('  re-deriving anything (plan §5).');
    out.push('');
    fs.writeFileSync(REPORT_MD, out.join('\n') + '\n', 'utf8');
    return { groups: groups, counts: counts, noSite: noSite };
}

// ---------------------------------------------------------------------- main --------------

function gates(run, results, proofsPruned) {
    const list = [];
    const first = mutate.dumpDocument(mutate.enumerate());
    const second = mutate.dumpDocument(mutate.enumerate());
    list.push({ name: 'mutant enumeration is deterministic',
        ok: first === second && fs.existsSync(MUTANTS_FILE)
            && slices.readText(MUTANTS_FILE) === first,
        detail: 'two enumerate() passes produce identical bytes (' + Buffer.byteLength(first)
            + ') and equal the committed mutants.json' });
    const rows = vectors.specRows().filter((row) => /^(BA|INI)-/.test(row.row_id));
    const withMutant = new Set();
    for (const m of run.mutant_results) for (const row of m.row_ids) withMutant.add(row);
    const missing = rows.filter((row) => !withMutant.has(row.row_id));
    const inDomain = rows.filter((row) => vectors.inDomain(row));
    const missingInDomain = missing.filter((row) => vectors.inDomain(row));
    list.push({ name: 'every BA/INI row carries >=1 mutant or a note',
        ok: missingInDomain.length === 0 && missing.length === rows.length - inDomain.length,
        detail: inDomain.length + ' in-generator rows all carry mutants; ' + missing.length
            + ' rows are outside both generators and carry the note `' + (missing[0] ? 'launch prelude' : 'n/a')
            + '`' });
    const survivorIds = run.mutant_results.filter((m) => m.status === 'survived').map((m) => m.id);
    const proofFiles = fs.existsSync(PROOFS) ? fs.readdirSync(PROOFS).filter((n) => /\.json$/.test(n))
        .map((n) => n.replace(/\.json$/, '')).sort() : [];
    list.push({ name: 'survivors == proofs/ 1:1',
        ok: JSON.stringify([...survivorIds].sort()) === JSON.stringify(proofFiles),
        detail: survivorIds.length + ' survivors, ' + proofFiles.length + ' proof files, '
            + proofsPruned.length + ' stale proof(s) pruned' });
    const unresolved = results.filter((r) => r.status === 'unresolved-gap');
    const escalation = fs.existsSync(ESCALATION) ? slices.readText(ESCALATION) : '';
    const escalated = unresolved.filter((r) => escalation.includes('## ' + r.survivor_id));
    list.push({ name: 'unresolved gaps are escalated, never called equivalent',
        ok: unresolved.length === escalated.length,
        detail: unresolved.length + ' unresolved gap(s), ' + escalated.length
            + ' with an ESCALATION.md entry' });
    list.push({ name: 'every survivor carries a machine-written proof object',
        ok: results.every((r) => r.static || r.probes || r.argument),
        detail: results.length + ' proof objects, each with a static argument or an explicit probe scope' });
    const control = run.baseline_control || {};
    list.push({ name: 'kill check reproduces the recording harness',
        ok: control.disagreements === 0 && control.vectors === run.vectors.total,
        detail: (control.vectors || 0) + ' vectors x ' + (control.channels || 0) + ' channels unmutated, '
            + (control.disagreements === undefined ? 'not recorded' : control.disagreements
                + ' disagreement(s)') + ' (asserted inside every run, not only in --selftest)' });
    const applied = fs.existsSync(APPLIED_RECORD) ? vectors.readJson(APPLIED_RECORD) : null;
    if (applied) {
        const open = (applied.killers || []).filter((killer) => {
            const record = run.mutant_results.find((m) => m.id === killer.survivor_id);
            return !record || record.status !== 'killed';
        });
        list.push({ name: 'a promoted killer kills the mutant it was promoted for',
            ok: open.length === 0,
            detail: applied.promoted_vectors + ' vector(s) in ' + applied.vectors_file + ' carrying '
                + applied.row_claims + ' row claim(s); ' + (open.length
                    ? open.length + ' promoted mutant(s) still survive: '
                        + open.map((k) => k.survivor_id).join(', ')
                    : (applied.killers || []).length + ' formerly surviving mutant(s) are now killed by '
                        + 'permanent boundary vectors')
                + '; ' + (applied.unpromotable_gaps || []).length + ' gap(s) could not be promoted, '
                + (applied.manifest_gap || []).length + ' promoted file(s) gen-goldens.js manifest() '
                + 'does not list' });
    } else {
        list.push({ name: 'a promoted killer kills the mutant it was promoted for', ok: true,
            detail: 'no promotion applied (APPLIED.json absent): every gap is still a proposal' });
    }
    return list;
}

// The proofs themselves get tested: the typing facts the static rule leans on, the rule firing where it
// is sound and refusing where it is not, and — the important one — the probe engine actually finding a
// difference for a mutant that has one. A probe search that could not find a killer would report every
// survivor as equivalent, which is the failure mode this whole phase exists to avoid.
function selftest() {
    const ctx = buildContext();
    const run = JSON.parse(slices.readText(RUN_FILE));
    const byId = new Map(mutate.enumerate().full.map((m) => [m.id, m]));
    let red = 0;
    const check = (name, ok, detail) => {
        console.log('  [' + (ok ? 'x' : ' ') + '] ' + name + (detail ? ' — ' + detail : ''));
        if (!ok) red += 1;
    };
    check('config-literal typing', ctx.types.get('ngl') === 'number'
        && ctx.types.get('cacheRam') === 'number' && ctx.types.get('jinja') === 'boolean'
        && ctx.types.get('minP') === 'mixed' && ctx.types.get('reasoning') === 'string'
        && ctx.types.get('repeatPenalty') === 'mixed',
        'parseInt -> number, .checked -> boolean, `.value || 0` -> mixed, bare .value -> string');
    check('the NaN-string-literal rule accepts what it should', isNonNumericStringLiteral("'off'")
        && !isNonNumericStringLiteral("'0'") && !isNonNumericStringLiteral("''")
        && !isNonNumericStringLiteral("'1e3'"), "'off' yes; '0', '', '1e3' no");

    const eq = run.mutant_results.filter((m) => m.status === 'survived')
        .map((m) => byId.get(m.id));
    const literalCase = eq.find((mu) => mu.class === 'equality-strictness' && mu.region === 'args'
        && mu.row_ids.some((id) => /BA-(90|91)\b/.test(id)));
    const undefinedCase = eq.find((mu) => mu.class === 'equality-strictness' && mu.region === 'args'
        && mu.row_ids.some((id) => (ctx.rowsById.get(id).vars_read || '').includes('cacheRam')));
    if (!literalCase || !undefinedCase) {
        console.log('  [ ] the survivor set no longer contains the cases this selftest names — refresh it,'
            + ' do not delete the check');
        red += 1;
    }
    if (literalCase) {
        withRegion(ctx, literalCase);
        const proof = staticProof(literalCase, { line: literalCase.line, start: literalCase.start,
            end: literalCase.end }, { region: literalCase.region, types: ctx.types,
            regionLines: ctx.regionLines });
        check('static proof fires on a string-literal comparison', !!proof
            && proof.case === 'nan-string-literal', proof ? proof.case : 'no proof');
    }
    if (undefinedCase) {
        withRegion(ctx, undefinedCase);
        const proof = staticProof(undefinedCase, { line: undefinedCase.line, start: undefinedCase.start,
            end: undefinedCase.end }, { region: undefinedCase.region, types: ctx.types,
            regionLines: ctx.regionLines });
        check('static proof refuses `x !== undefined`', !proof,
            'undefined is exactly where == and !== diverge');
    }

    // The save channel's element-guard fallbacks, pinned by mutant id: the check has to say which two
    // mutants it is talking about, not just that some proof worked.
    const GUARD_MUTANTS = ['M-save-036-0092-branch-swap-418f9f7afd',
        'M-save-036-0093-string-literal-2881fee7c3'].map((id) => byId.get(id));
    if (GUARD_MUTANTS.every(Boolean)) {
        const proven = GUARD_MUTANTS.map((mu) => {
            withRegion(ctx, mu);
            return staticProof(mu, { line: mu.line, start: mu.start, end: mu.end },
                { region: mu.region, types: ctx.types, regionLines: ctx.regionLines, page: ctx.page });
        });
        withRegion(ctx, GUARD_MUTANTS[0]);
        const trueAt = ctx.regionLines[GUARD_MUTANTS[0].line].indexOf('chatTemplateKwargsInput.value.trim()');
        const control = staticProof({ class: 'string-literal', after: "'X'", before: '', channel: 'save',
            region: 'save' }, { line: GUARD_MUTANTS[0].line, start: trueAt, end: trueAt + 10 },
            { region: 'save', types: ctx.types, regionLines: ctx.regionLines, page: ctx.page });
        check('the element-guard fallback proof covers the two save survivors and nothing else',
            proven.every((p) => p && p.case === 'unreachable-element-guard-fallback') && !control,
            proven.map((p) => (p ? p.case : 'no proof')).join(' + ') + '; same-line true-branch control '
                + (control ? 'WRONGLY proven' : 'refused'));
    } else {
        check('the element-guard fallback proof covers the two save survivors and nothing else', false,
            'those mutant ids are not in the current enumeration — refresh the ids, do not delete the check');
    }

    const loop = eq.find((mu) => mu.class === 'loop-first-iteration');
    if (loop) {
        withRegion(ctx, loop);
        const result = analyze(loop, ctx, ctx.reference, 0);
        check('the probe search finds the multi-config killer', result.status
            === 'gap-killer-synthesized' && result.killing_probe.config_count >= 2,
            result.status + ', config_count ' + (result.killing_probe
                ? result.killing_probe.config_count : 'n/a'));
    }
    const equivalent = eq.find((mu) => mu.class === 'relational-boundary' && mu.region === 'args');
    if (equivalent) {
        withRegion(ctx, equivalent);
        const result = analyze(equivalent, ctx, ctx.reference, 0);
        check('a genuinely equivalent survivor is proven, not guessed',
            result.status === 'equivalent-proven' && result.probes.scope
                && result.probes.scope.exhaustive_over_enumerated,
            result.method + ' over ' + result.probes.run + ' probes');
    }
    const killed = run.mutant_results.filter((m) => m.status === 'killed')[0];
    if (killed) {
        const mutant = byId.get(killed.id);
        withRegion(ctx, mutant);
        const result = analyze(mutant, ctx, ctx.reference, 0);
        check('the probe engine can kill a mutant the vectors already kill',
            result.status === 'gap-killer-synthesized',
            killed.id + ' -> ' + result.status + ' after ' + result.probes.run + ' probes');
    }
    console.log(red ? 'EQUIV-PROVE SELFTEST RED (' + red + ')' : 'EQUIV-PROVE SELFTEST GREEN');
    process.exitCode = red ? 1 : 0;
    return red;
}

function main() {
    const argv = process.argv.slice(2);
    const options = { recompute: argv.indexOf('--recompute') >= 0 };
    const rootAt = argv.indexOf('--root');
    if (rootAt >= 0) options.root = argv[rootAt + 1];
    options.dryRun = argv.indexOf('--dry-run') >= 0;
    if (argv.indexOf('--selftest') >= 0) {
        selftest();
        return;
    }
    if (argv.indexOf('--apply') >= 0) {
        if (!options.root) {
            console.log('--apply needs --root <repo copy>: the promoted files land under '
                + '<root>/fixtures/**, and fixtures/vectors/MANIFEST.json + fixtures/HASH-PIN.json '
                + 'are hash-pinned gate artifacts this tool must not move. Write into a scratch copy, '
                + 'verify it, then let the ledger holder refresh the pins.');
            process.exitCode = 2;
            return;
        }
        applyPromotions(options);
        return;
    }
    if (argv.indexOf('--report') >= 0) {
        const run = JSON.parse(slices.readText(RUN_FILE));
        const results = run.mutant_results.filter((m) => m.status === 'survived')
            .map((m) => JSON.parse(slices.readText(proofFile(m.id))));
        const proposals = fs.existsSync(PROMOTIONS) ? JSON.parse(slices.readText(PROMOTIONS))
            : { proposed_promotions: 0 };
        const list = gates(run, results, []);
        writeReport(run, results, { gates: list, proposals: proposals });
        for (const gate of list) {
            console.log('[' + (gate.ok ? 'x' : ' ') + '] ' + gate.name + ' — ' + gate.detail);
        }
        console.log('REPORT.md rebuilt from ' + results.length + ' proof(s): ' + JSON.stringify({
            static: results.filter((r) => statusOf(r) === 'equivalent-static').length,
            dynamic: results.filter((r) => statusOf(r) === 'equivalent-dynamic').length,
            gaps: results.filter((r) => r.status === 'gap-killer-synthesized').length,
            unresolved: results.filter((r) => r.status === 'unresolved-gap').length
        }));
        return;
    }
    const done = prove(options);
    const proposals = writeProposals(done.results);
    const escalated = escalate(done.results);
    const pruned = pruneProofs(done.run.mutant_results.filter((m) => m.status === 'survived')
        .map((m) => m.id));
    const list = gates(done.run, done.results, pruned);
    writeReport(done.run, done.results, { gates: list, proposals: proposals });
    const counts = {
        enumerated: done.run.mutants.enumerated, killed: done.run.mutants.killed,
        survived: done.results.length,
        static: done.results.filter((r) => statusOf(r) === 'equivalent-static').length,
        dynamic: done.results.filter((r) => statusOf(r) === 'equivalent-dynamic').length,
        gaps: done.results.filter((r) => r.status === 'gap-killer-synthesized').length,
        unresolved: done.results.filter((r) => r.status === 'unresolved-gap').length,
        escalated: escalated, proposals: proposals.proposed_promotions
    };
    console.log(JSON.stringify(counts, null, 1));
    for (const gate of list) console.log('[' + (gate.ok ? 'x' : ' ') + '] ' + gate.name + ' — ' + gate.detail);
    console.log('wrote ' + path.relative(REPO, REPORT_MD) + ', ' + path.relative(REPO, PROMOTIONS)
        + ', ' + done.results.length + ' proof(s)');
    const red = list.filter((g) => !g.ok).length + counts.unresolved;
    console.log(red ? 'EQUIV-PROVE RED (' + red + ')' : 'EQUIV-PROVE GREEN');
    process.exitCode = red ? 1 : 0;
}

if (require.main === module) main();

module.exports = { prove, buildContext, withRegion, analyze, staticProof, pageFacts, falseBranchSpan,
    inferType, configLiteralTypes,
    isNonNumericStringLiteral, enclosingExpression, observedValues, domainFor, probeVarsFor, probeSet,
    probeOutputs, probeVector, writeProposals, escalate, pruneProofs, writeReport, gates, selftest,
    applyPromotions, flipTargets, mutantEvaluator, appendOnly, statusOf, proofFile, PROOFS, PROMOTIONS,
    REPORT_MD, PROMOTED_VECTORS, PROMOTED_GOLDENS, PROMOTED_MAP, MAX_DOMAIN, MAX_PROBES, BOUNDARY };
