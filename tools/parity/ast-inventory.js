#!/usr/bin/env node
'use strict';
// Phase 2 item 2 (plan.md §2): AST predicate inventory -> SPEC/SPEC-ROWS.csv.
//
// One row per predicate / branch site inside the two pure generators and the
// state functions, plus every registered request handler in server.js.
// This CSV, not line coverage, is the Phase 2 completeness checklist: every row
// must be mapped by >=1 vector in fixtures/vectors/coverage-map.json.
//
// Region boundaries are located by function name (never by line number) so the
// inventory survives any edit to the legacy sources; the row's `line` column is
// acorn's own loc for the node the row was minted from.
//
// Modes:
//   node tools/parity/ast-inventory.js            write SPEC/SPEC-ROWS.csv + print summary
//   node tools/parity/ast-inventory.js --check    exit 1 if a rerun differs (nondeterminism guard)
//   node tools/parity/ast-inventory.js --selftest exit 1 if counts / locs / flag cross-check fail

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const REPO = path.resolve(__dirname, '..', '..');
const OUT_CSV = path.join(REPO, 'SPEC', 'SPEC-ROWS.csv');

const SOURCES = [
    { file: 'public/script.js', sourceTypes: ['script', 'module'] },
    { file: 'server.js', sourceTypes: ['script', 'module'] },
];

// Regions found by function name in public/script.js. Prefixes are stable ids.
const SCRIPT_REGIONS = [
    { prefix: 'BA', name: 'launchServer', label: 'launchServer' },
    { prefix: 'INI', name: 'launchModelPresets', label: 'launchModelPresets' },
    { prefix: 'SCV', name: 'saveCurrentValues', label: 'saveCurrentValues' },
    { prefix: 'LC', name: 'loadConfiguration', label: 'loadConfiguration' },
    { prefix: 'DC', name: 'deleteConfiguration', label: 'deleteConfiguration' },
];

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'all']);
const WS_OBJECT = 'io';
const APP_OBJECT = 'app';

const ALLOWED_KINDS = new Set([
    'if', 'else-if', 'ternary', 'loop-gate', 'switch-case', 'error-path',
    'eq-comparison', 'neq-comparison', 'range-comparison',
    'logical-or', 'logical-and', 'logical-nullish', 'truthiness',
]);
const KIND_RANK = {
    'if': 0, 'else-if': 1, 'ternary': 2, 'loop-gate': 3, 'switch-case': 4, 'error-path': 5,
    'logical-or': 6, 'logical-and': 7, 'logical-nullish': 8,
    'eq-comparison': 9, 'neq-comparison': 10, 'range-comparison': 11, 'truthiness': 12,
};
const EQ_OPS = { '==': 1, '===': 1 };
const NEQ_OPS = { '!=': 1, '!==': 1 };
const RANGE_OPS = { '<': 1, '>': 1, '<=': 1, '>=': 1 };
const LOGICAL_OPS = { '||': 'logical-or', '&&': 'logical-and', '??': 'logical-nullish' };
const BRANCH_TYPES = new Set([
    'IfStatement', 'ConditionalExpression', 'ForStatement', 'ForInStatement', 'ForOfStatement',
    'WhileStatement', 'DoWhileStatement', 'SwitchCase', 'CatchClause',
]);
const FLAG_RE = /^-{1,2}[A-Za-z][A-Za-z0-9-]*$/;
// Ceiling on how many first-level effects one branch may list. The selftest fails
// if any row needs more, so targets are never silently truncated.
const MAX_TARGETS = 40;
// Same ceiling rule for vars_read: the selftest fails if a row hits it.
const MAX_VARS = 24;

const COLUMNS = ['row_id', 'file', 'line', 'fn_or_route', 'kind', 'code_snippet', 'vars_read', 'targets'];

// ---------------------------------------------------------------- AST helpers

function walkNodes(node, visit, ancestors) {
    if (!ancestors) ancestors = [];
    visit(node, ancestors);
    ancestors.push(node);
    for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
        const value = node[key];
        if (Array.isArray(value)) {
            for (const child of value) if (child && typeof child.type === 'string') walkNodes(child, visit, ancestors);
        } else if (value && typeof value.type === 'string') {
            walkNodes(value, visit, ancestors);
        }
    }
    ancestors.pop();
}

function parse(file, sourceTypes) {
    const src = fs.readFileSync(path.join(REPO, file), 'utf8');
    let lastError = null;
    for (const sourceType of sourceTypes) {
        try {
            const ast = acorn.parse(src, { ecmaVersion: 'latest', locations: true, sourceType });
            return { src, ast, sourceType };
        } catch (e) {
            lastError = e;
        }
    }
    throw new Error(`${file}: acorn could not parse (${lastError && lastError.message})`);
}

function flat(s) { return s.replace(/\s+/g, ' ').trim(); }
function textOf(src, node) { return clip(flat(src.slice(node.start, node.end))); }
function clip(s, n) {
    const limit = n || 220;
    return s.length > limit ? s.slice(0, limit - 3) + '...' : s;
}

// `document.getElementById('x')` / `document.querySelector('#x')` -> `#x`.
function domLiteral(node) {
    if (!node || node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return null;
    const p = node.callee.property;
    if (!p || (p.name !== 'getElementById' && p.name !== 'querySelector')) return null;
    const a = node.arguments[0];
    if (!a || a.type !== 'Literal' || typeof a.value !== 'string') return null;
    return '#' + a.value.replace(/^#/, '');
}

function staticPath(node, withDom) {
    if (!node || typeof node.type !== 'string') return null;
    if (node.type === 'Identifier') return node.name;
    if (node.type === 'ThisExpression') return 'this';
    if (node.type === 'Literal') return null;
    if (node.type === 'TemplateLiteral') {
        if (node.expressions.length !== 0) return null;
        return node.quasis.map((q) => q.value.cooked).join('');
    }
    if (node.type === 'MemberExpression' && node.property) {
        const obj = staticPath(node.object, withDom);
        if (obj === null) return null;
        if (!node.computed && node.property.type === 'Identifier') return obj + '.' + node.property.name;
        if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') {
            return obj + '.' + node.property.value;
        }
        return null;
    }
    if (node.type === 'CallExpression') {
        const dom = withDom ? domLiteral(node) : null;
        if (dom) return dom;
        const callee = staticPath(node.callee, withDom);
        return callee === null ? null : callee + '()';
    }
    return null;
}

// `const serverPathInput = document.getElementById('serverPath')` -> serverPathInput => serverPath
function buildDomIdMap(ast) {
    const map = new Map();
    walkNodes(ast, (n) => {
        if (n.type !== 'VariableDeclarator' || n.id.type !== 'Identifier') return;
        const dom = domLiteral(n.init);
        if (dom) map.set(n.id.name, dom);
    });
    return map;
}

function collectVars(node, domIds, out) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Identifier') {
        out.push(domIds.has(node.name) ? node.name + '(' + domIds.get(node.name) + ')' : node.name);
        return;
    }
    if (node.type === 'MemberExpression' && node.object && node.property) {
        const objName = node.object.type === 'Identifier' && domIds.has(node.object.name)
            ? node.object.name + '(' + domIds.get(node.object.name) + ')'
            : staticPath(node.object, true);
        if (objName !== null) {
            if (!node.computed && node.property.type === 'Identifier') out.push(objName + '.' + node.property.name);
            else if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') out.push(objName + '.' + node.property.value);
            else collectVars(node.object, domIds, out);
            return;
        }
    }
    if (node.type === 'CallExpression') {
        const dom = domLiteral(node);
        if (dom) { out.push(dom); return; }
        const callee = staticPath(node.callee, true);
        if (callee !== null) out.push(callee + '()');
        for (const arg of node.arguments) collectVars(arg, domIds, out);
        return;
    }
    for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
        const value = node[key];
        if (Array.isArray(value)) {
            for (const child of value) if (child && typeof child.type === 'string') collectVars(child, domIds, out);
        } else if (value && typeof value.type === 'string') {
            collectVars(value, domIds, out);
        }
    }
}

function varsOf(src, node, domIds) {
    const out = [];
    collectVars(node, domIds, out);
    const seen = [];
    for (const v of out) if (v && !seen.includes(v)) seen.push(v);
    return clip(seen.slice(0, MAX_VARS).join(';'), 400);
}

// ------------------------------------------------------------- target mining

function rootish(name) { return name.replace(/\.\w+\(\)$/, ''); }

function callName(call) {
    const c = call.callee;
    if (!c) return null;
    if (c.type === 'Identifier') return c.name;
    if (c.type === 'MemberExpression' && !c.computed && c.property && c.property.type === 'Identifier') {
        const obj = staticPath(c.object, true);
        if (obj === null) return null;
        return rootish(obj) + '.' + c.property.name;
    }
    return null;
}

function statusOf(call) {
    const c = call.callee;
    if (!c || c.type !== 'MemberExpression' || !c.object || c.object.type !== 'CallExpression') return null;
    const inner = c.object;
    if (!inner.callee || inner.callee.type !== 'MemberExpression') return null;
    if (!inner.callee.property || inner.callee.property.name !== 'status') return null;
    const arg = inner.arguments[0];
    if (!arg || arg.type !== 'Literal') return null;
    const base = staticPath(inner.callee.object, true);
    if (base === null) return null;
    return rootish(base) + '.status(' + arg.value + ')';
}

// Leading literal text of a string / template right-hand side: `temp = ` from
// `temp = ${config.temp}\n`. This is how ini keys become visible in `targets`.
function leadingText(node) {
    if (!node) return '';
    if (node.type === 'Literal' && typeof node.value === 'string') return flat(node.value.replace(/\\n/g, ' '));
    if (node.type === 'TemplateLiteral' && node.quasis.length) return flat(node.quasis[0].value.cooked);
    return '';
}

function patternNames(id, out) {
    if (!id) return out;
    if (id.type === 'Identifier') out.push(id.name);
    else if (id.type === 'ObjectPattern') for (const p of id.properties) patternNames(p.value || p.argument, out);
    else if (id.type === 'ArrayPattern') for (const e of id.elements) patternNames(e, out);
    else if (id.type === 'AssignmentPattern') patternNames(id.left, out);
    return out;
}

function scanExpr(node, out) {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
        case 'AssignmentExpression': {
            const lhs = staticPath(node.left, true);
            const lead = leadingText(node.right);
            if (lhs) out.push(clip(lead ? lhs + ':' + lead : lhs, 60));
            scanExpr(node.right, out);
            return;
        }
        case 'CallExpression': {
            const name = callName(node);
            if (name && !name.startsWith('console.')) {
                out.push(clip(name, 60));
                const status = statusOf(node);
                if (status) out.push(clip(status, 60));
                const lead = leadingText(node.arguments[0]);
                if (lead) out.push(clip(name + ':' + lead, 60));
            }
            for (const a of node.arguments) scanExpr(a, out);
            return;
        }
        case 'UnaryExpression':
        case 'AwaitExpression':
        case 'SpreadElement':
        case 'ExpressionStatement':
            if (node.operator === 'delete' && node.argument) {
                const victim = staticPath(node.argument, true);
                if (victim) out.push(clip('delete ' + victim, 60));
            }
            scanExpr(node.argument || node.expression, out);
            return;
        case 'UpdateExpression':
            scanExpr(node.argument, out);
            return;
        case 'BinaryExpression':
        case 'LogicalExpression':
            scanExpr(node.left, out); scanExpr(node.right, out);
            return;
        case 'ConditionalExpression':
            scanExpr(node.test, out); scanExpr(node.consequent, out); scanExpr(node.alternate, out);
            return;
        case 'MemberExpression':
            scanExpr(node.object, out);
            if (node.computed) scanExpr(node.property, out);
            return;
        case 'ArrayExpression':
        case 'SequenceExpression':
            for (const e of node.elements || node.expressions) scanExpr(e, out);
            return;
        case 'ObjectExpression':
            for (const p of node.properties) scanExpr(p.value, out);
            return;
        case 'TemplateLiteral':
            for (const e of node.expressions) scanExpr(e, out);
            return;
        case 'NewExpression': {
            const name = node.callee && node.callee.type === 'Identifier' ? 'new ' + node.callee.name : null;
            if (name) out.push(name);
            return;
        }
        default:
            // Function bodies are not first-level targets.
            return;
    }
}

function stmtsOf(node) {
    if (!node) return [];
    if (node.type === 'BlockStatement') return node.body;
    return [node];
}

function collectTargets(nodes, out) {
    for (const st of nodes) {
        if (!st || typeof st.type !== 'string') continue;
        if (st.type === 'ReturnStatement') { out.push('return'); if (st.argument) scanExpr(st.argument, out); continue; }
        if (st.type === 'ThrowStatement') { out.push('throw'); continue; }
        if (st.type === 'VariableDeclaration') {
            for (const d of st.declarations) patternNames(d.id, out);
            scanExpr(st.init, out);
            continue;
        }
        scanExpr(st, out);
    }
}

function dedupeList(list) {
    const seen = [];
    for (const t of list) if (t && !seen.includes(t)) seen.push(t);
    return seen;
}

function guardTargets(src, node) {
    const main = [];
    const alt = [];    if (node.type === 'IfStatement') {
        collectTargets(stmtsOf(node.consequent), main);
        if (node.alternate && node.alternate.type !== 'IfStatement') collectTargets(stmtsOf(node.alternate), alt);
    } else if (node.type === 'ConditionalExpression') {
        collectTargets([node.consequent], main);
        collectTargets([node.alternate], alt);
    } else if (node.type === 'SwitchCase') {
        collectTargets(node.consequent, main);
    } else if (node.type === 'CatchClause') {
        collectTargets(node.body.body, main);
    } else {
        collectTargets(stmtsOf(node.body), main);
    }
    const parts = dedupeList(main);
    for (const t of dedupeList(alt)) parts.push('else:' + t);
    const uniq = [];
    for (const p of parts) if (!uniq.includes(p)) uniq.push(p);
    return { text: uniq.slice(0, MAX_TARGETS).join(';'), truncated: uniq.length > MAX_TARGETS };
}

// -------------------------------------------------------------- row minting

const NO_VARS = Symbol('no-vars');

function shapeKind(test) {
    if (!test) return null;
    if (test.type === 'LogicalExpression') return LOGICAL_OPS[test.operator] || null;
    if (test.type === 'BinaryExpression') {
        if (EQ_OPS[test.operator]) return 'eq-comparison';
        if (NEQ_OPS[test.operator]) return 'neq-comparison';
        if (RANGE_OPS[test.operator]) return 'range-comparison';
        return null;
    }
    if (test.type === 'ConditionalExpression') return 'ternary';
    return null;
}

function isBarePredicate(node) {
    return node.type !== 'LogicalExpression'
        && node.type !== 'ConditionalExpression'
        && !(node.type === 'BinaryExpression' && (EQ_OPS[node.operator] || NEQ_OPS[node.operator] || RANGE_OPS[node.operator]));
}

function booleanSlot(node, parent) {
    if (!parent) return null;
    if (parent.type === 'LogicalExpression') return 'operand';
    if (parent.type === 'ConditionalExpression' && parent.test === node) return 'test';
    if (parent.type === 'IfStatement' && parent.test === node) return 'test';
    if ((parent.type === 'ForStatement' || parent.type === 'WhileStatement' || parent.type === 'DoWhileStatement') && parent.test === node) return 'test';
    return null;
}

// A constant operand of `||`/`&&`/`??` cannot flip, so it is not a predicate.
function isConstant(node) {
    if (node.type === 'Literal') return true;
    if (node.type === 'TemplateLiteral') return node.expressions.length === 0;
    return ['ObjectExpression', 'ArrayExpression', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassExpression'].includes(node.type);
}

// `!!x` guards nothing extra: the flip happens on `x`.
function stripNegations(node) {
    while (node && node.type === 'UnaryExpression' && node.operator === '!') node = node.argument;
    return node;
}

function loopSnippet(src, node) {
    if (node.type === 'DoWhileStatement') return clip('do {...} while (' + textOf(src, node.test) + ')');
    const headEnd = node.body ? node.body.start : node.end;
    return clip(flat(src.slice(node.start, headEnd)));
}

function buildRegionRows(src, regionNode, domIds) {
    const found = [];
    const emitted = new Set();
    const targetCache = new Map();
    const targetsFor = (branchNode) => {
        if (!targetCache.has(branchNode)) targetCache.set(branchNode, guardTargets(src, branchNode));
        return targetCache.get(branchNode);
    };
    walkNodes(regionNode, (node, ancestors) => {
        const parent = ancestors[ancestors.length - 1];
        const push = (kind, snippet, varsNode, snippetFrom) => {
            emitted.add(node);
            const t = BRANCH_TYPES.has(node.type) ? targetsFor(node) : enclosingTargets();
            found.push({
                kind,
                node,
                snippet,
                snippetFrom: snippetFrom || 'node',
                vars_read: varsNode === NO_VARS ? '' : varsOf(src, varsNode || node, domIds),
                targets: t.text,
                targetsTruncated: t.truncated,
            });
        };
        const enclosingTargets = () => {
            for (let i = ancestors.length - 1; i >= 0; i--) {
                if (BRANCH_TYPES.has(ancestors[i].type)) return targetsFor(ancestors[i]);
            }
            return { text: '', truncated: false };
        };
        // Row minted from a node other than the visited one (the negation-stripped
        // operand); its loc, snippet and vars all come from that node.
        const pushAt = (target, kind) => {
            if (emitted.has(target)) return;
            emitted.add(target);
            const t = enclosingTargets();
            found.push({
                kind,
                node: target,
                snippet: textOf(src, target),
                snippetFrom: 'node',
                vars_read: varsOf(src, target, domIds),
                targets: t.text,
                targetsTruncated: t.truncated,
            });
        };

        if (node.type === 'IfStatement') {
            const isElse = !!(parent && parent.type === 'IfStatement' && parent.alternate === node);
            const kind = shapeKind(node.test) || (isElse ? 'else-if' : 'if');
            push(kind, clip((isElse ? 'else if' : 'if') + ' (' + textOf(src, node.test) + ')'), node.test, 'if-test');
            return;
        }
        if (node.type === 'ConditionalExpression') { push('ternary', textOf(src, node)); return; }
        if (node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement'
            || node.type === 'WhileStatement' || node.type === 'DoWhileStatement') {
            push('loop-gate', loopSnippet(src, node), loopVarsNode(node), 'loop-head');
            return;
        }
        if (node.type === 'SwitchCase') {
            if (!node.test) return;
            push('switch-case', clip('case ' + textOf(src, node.test)), node.test, 'case-test');
            return;
        }
        // `promise.catch(err => {...})` is the error branch of a route body that
        // uses no try/catch (GET /settings); the callback body is what it guards.
        if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
            && !node.callee.computed && node.callee.property.name === 'catch') {
            const cb = node.arguments[node.arguments.length - 1];
            if (!cb || (cb.type !== 'ArrowFunctionExpression' && cb.type !== 'FunctionExpression')) return;
            const param = cb.params && cb.params[0];
            const t = guardTargets(src, cb);
            emitted.add(node);
            found.push({
                kind: 'error-path',
                node: cb,
                snippet: clip('.catch (' + (param ? textOf(src, param) : '') + ')'),
                snippetFrom: 'promise-catch',
                vars_read: param ? varsOf(src, param, domIds) : '',
                targets: t.text,
                targetsTruncated: t.truncated,
            });
        }
        if (node.type === 'CatchClause') {
            const param = node.param ? textOf(src, node.param) : '';
            push('error-path', clip('catch (' + param + ')'), node.param ? node.param : NO_VARS, 'catch-param');
            return;
        }
        if (node.type === 'LogicalExpression') {
            if (parent && parent.type === 'IfStatement' && parent.test === node) return; // carried by the if row
            const kind = LOGICAL_OPS[node.operator];
            if (kind) push(kind, textOf(src, node));
            return;
        }
        if (node.type === 'BinaryExpression') {
            if (parent && parent.type === 'IfStatement' && parent.test === node) return;
            let kind = null;
            if (EQ_OPS[node.operator]) kind = 'eq-comparison';
            else if (NEQ_OPS[node.operator]) kind = 'neq-comparison';
            else if (RANGE_OPS[node.operator]) kind = 'range-comparison';
            if (kind) push(kind, textOf(src, node));
            return;
        }
        const slot = booleanSlot(node, parent);
        if (slot === 'operand' && !isConstant(node)) {
            const flip = stripNegations(node);
            if (flip && isBarePredicate(flip)) pushAt(flip, 'truthiness');
        }
    });

    found.sort((a, b) => (a.node.start - b.node.start) || (a.node.end - b.node.end) || (KIND_RANK[a.kind] - KIND_RANK[b.kind]));
    return found;
}

function loopVarsNode(node) {
    if (node.type === 'ForInStatement' || node.type === 'ForOfStatement') return node.right;
    return node.test || node.init || node.body;
}

// --------------------------------------------------------- region discovery

function pathSlug(value) {
    const slug = String(value).replace(/^\/+/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return slug || 'root';
}

function findScriptRegions(ast) {
    const regions = [];
    for (const spec of SCRIPT_REGIONS) {
        let node = null;
        walkNodes(ast, (n) => {
            if (node) return;
            const name = n.id && n.id.name;
            if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression') && name === spec.name) node = n;
        });
        if (!node) throw new Error(`region root not found by name: ${spec.name}`);
        regions.push({ prefix: spec.prefix, label: spec.label, node });
    }
    return regions;
}

function findServerRegions(ast) {
    const found = [];
    walkNodes(ast, (n) => {
        if (n.type !== 'CallExpression' || n.callee.type !== 'MemberExpression' || n.callee.computed) return;
        const obj = n.callee.object;
        if (!obj || obj.type !== 'Identifier') return;
        const method = n.callee.property.name;
        const first = n.arguments[0];
        if (!first || first.type !== 'Literal' || typeof first.value !== 'string') return;
        let slug = null;
        let label = method.toUpperCase() + ' ' + first.value;
        if (obj.name === APP_OBJECT && ROUTE_METHODS.has(method)) slug = method.toLowerCase() + '-' + pathSlug(first.value);
        else if (obj.name === WS_OBJECT && method === 'on') {
            slug = 'ws-' + pathSlug(first.value);
            label = 'WS ' + first.value;
        }
        if (!slug) return;
        const fn = n.arguments.find((a) => a.type === 'ArrowFunctionExpression' || a.type === 'FunctionExpression');
        if (!fn) return;
        found.push({ prefix: 'SV-' + slug, label, node: fn, start: n.start });
    });
    found.sort((a, b) => a.start - b.start);
    return found;
}

// ------------------------------------------------------------------ build

function csvCell(value) {
    const s = String(value === undefined || value === null ? '' : value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function build() {
    const rows = [];
    const regions = [];
    const parsed = {};

    for (const source of SOURCES) {
        const p = parse(source.file, source.sourceTypes);
        parsed[source.file] = p;
        const domIds = buildDomIdMap(p.ast);
        const fileRegions = source.file === 'server.js' ? findServerRegions(p.ast) : findScriptRegions(p.ast);
        for (const region of fileRegions) {
            const regionRows = buildRegionRows(p.src, region.node, domIds);
            regionRows.forEach((row, i) => {
                row.row_id = region.prefix + '-' + (i + 1);
                row.file = source.file;
                row.line = row.node.loc.start.line;
                row.fn_or_route = region.label;
                rows.push(row);
            });
            regions.push({
                prefix: region.prefix,
                label: region.label,
                file: source.file,
                count: regionRows.length,
                node: region.node,
                src: p.src,
                rows: regionRows,
            });
        }
    }

    const csv = [COLUMNS.join(',')].concat(rows.map((r) => [
        r.row_id, r.file, r.line, r.fn_or_route, r.kind, r.snippet, r.vars_read, r.targets,
    ].map(csvCell).join(','))).join('\n') + '\n';

    return { rows, csv, regions, parsed };
}

// ----------------------------------------------------------------- checks

// The snippet must be reconstructible from the acorn node at the reported line,
// and the reported line must really be the node's line in the file.
function verifyRow(row, src) {
    const node = row.node;
    if (row.line !== node.loc.start.line) return `line ${row.line} != acorn loc ${node.loc.start.line}`;
    if (row.snippetFrom === 'if-test') {
        if (!row.snippet.includes(textOf(src, node.test))) return 'if snippet does not carry the acorn test source';
    } else if (row.snippetFrom === 'catch-param') {
        const expected = clip('catch (' + (node.param ? textOf(src, node.param) : '') + ')');
        if (row.snippet !== expected) return `catch snippet is not the acorn param (${row.snippet} != ${expected})`;
    } else if (row.snippetFrom === 'promise-catch') {
        if (!row.snippet.startsWith('.catch (')) return 'promise error branch is not a .catch callback';
    } else if (row.snippetFrom === 'loop-head') {
        const expected = node.type === 'DoWhileStatement'
            ? clip('do {...} while (' + textOf(src, node.test) + ')')
            : clip(flat(src.slice(node.start, node.body.start)));
        if (row.snippet !== expected) return `loop snippet is not the acorn loop head (${row.snippet} != ${expected})`;
    } else if (row.snippetFrom === 'case-test') {
        if (row.snippet !== clip('case ' + textOf(src, node.test))) return 'case snippet is not the acorn test source';
    } else if (row.snippet !== textOf(src, node)) {
        return `snippet is not the node source (${row.snippet} != ${textOf(src, node)})`;
    }
    const offsetLine = src.slice(0, node.start).split('\n').length;
    if (row.line !== offsetLine) {
        return `line ${row.line} != line derived from the node offset (${offsetLine}); snippet "${clip(row.snippet, 60)}"`;
    }
    return null;
}

function flagPushes(region) {
    // Every string literal pushed as a CLI flag inside the region, with the
    // branch that guards it (nearest enclosing branch node, null when the push
    // is unconditional and therefore has no predicate that could guard it).
    const out = [];
    walkNodes(region.node, (node, ancestors) => {
        if (node.type !== 'CallExpression') return;
        const callee = node.callee;
        if (!callee || callee.type !== 'MemberExpression' || callee.property.name !== 'push') return;
        for (const arg of node.arguments) {
            if (arg.type !== 'Literal' || typeof arg.value !== 'string') continue;
            if (!FLAG_RE.test(arg.value)) continue;
            let branch = null;
            for (let i = ancestors.length - 1; i >= 0; i--) {
                if (BRANCH_TYPES.has(ancestors[i].type) && ancestors[i] !== region.node) { branch = ancestors[i]; break; }
            }
            out.push({ flag: arg.value, branch, line: node.loc.start.line });
        }
    });
    return out;
}

function selftest() {
    const failures = [];
    const fail = (msg) => failures.push(msg);
    const runs = [build(), build()];

    if (runs[0].csv !== runs[1].csv) fail('nondeterminism: two consecutive runs produced different CSV bytes');

    const { rows, regions } = runs[0];

    if (rows.length < 80) fail(`total rows ${rows.length} < threshold 80`);

    const byPrefix = {};
    for (const r of rows) byPrefix[r.row_id.replace(/-\d+$/, '')] = (byPrefix[r.row_id.replace(/-\d+$/, '')] || 0) + 1;
    const baCount = byPrefix.BA || 0;
    if (baCount < 25) fail(`BA (buildArgs) rows ${baCount} < threshold 25`);

    const ids = new Set();
    for (const r of rows) {
        if (ids.has(r.row_id)) fail(`duplicate row_id ${r.row_id}`);
        ids.add(r.row_id);
        if (!ALLOWED_KINDS.has(r.kind)) fail(`${r.row_id}: unknown kind ${r.kind}`);
        if (r.line !== r.node.loc.start.line) fail(`${r.row_id}: line ${r.line} != acorn loc ${r.node.loc.start.line}`);
        if (!r.file || !r.fn_or_route) fail(`${r.row_id}: empty file/fn_or_route`);
        if (!r.snippet) fail(`${r.row_id}: empty snippet`);
    }

    for (const region of regions) {
        region.rows.forEach((r, i) => {
            if (Number(r.row_id.split('-').pop()) !== i + 1) fail(`region ${region.prefix}: row ${r.row_id} is not numbered ${i + 1} in source order`);
        });
    }
    const expectedPrefixes = SCRIPT_REGIONS.map((r) => r.prefix);
    for (const prefix of expectedPrefixes) {
        if (!regions.some((r) => r.prefix === prefix)) fail(`region ${prefix} was not located by function name`);
    }

    for (const r of rows) {
        const problem = verifyRow(r, run_src(r, runs[0]));
        if (problem) fail(`${r.row_id}: ${problem}`);
        if (r.targetsTruncated) fail(`${r.row_id}: targets truncated at ${MAX_TARGETS}, raise the ceiling`);
        if (r.vars_read.split(";").filter(Boolean).length >= MAX_VARS || r.vars_read.length >= 400) fail(`${r.row_id}: vars_read truncated at ${MAX_VARS}/400 chars, raise the ceiling`);
    }

    // Flag cross-check: every CLI flag literal pushed inside the buildArgs region
    // must be named by the targets of the branch that guards it. Pushes with no
    // enclosing branch (always-appended args) cannot be guarded by any predicate,
    // so they are reported separately instead of silently skipped.
    const ba = regions.find((r) => r.prefix === 'BA');
    if (!ba) fail('BA region missing');
    else {
        const guarded = [];
        const unguarded = [];
        const seenFlags = new Set();
        for (const p of flagPushes(ba)) {
            seenFlags.add(p.flag);
            if (!p.branch) { if (!unguarded.includes(p.flag)) unguarded.push(p.flag); continue; }
            const row = ba.rows.find((r) => r.node === p.branch);
            if (!row) { fail(`BA flag ${p.flag} at line ${p.line} has no inventoried branch row`); continue; }
            if (!row.targets.includes(p.flag)) fail(`BA flag ${p.flag} (line ${p.line}) is not in targets of its guarding row ${row.row_id} [${row.targets}]`);
            guarded.push({ flag: p.flag, row: row.row_id });
        }
        console.log(`selftest: BA flag cross-check — ${seenFlags.size} flag literals, ${guarded.length} guarded push sites named by their branch row, ${unguarded.length} unguarded (${unguarded.join(', ') || 'none'})`);
    }

    return { failures, rows, regions };
}

function run_src(row, run) {
    return run.parsed[row.file].src;
}

function topComplex(rows, n) {
    const scored = rows.map((r) => ({ r, n: r.vars_read ? r.vars_read.split(';').length : 0 }));
    scored.sort((a, b) => (b.n - a.n) || a.r.row_id.localeCompare(b.r.row_id));
    return scored.slice(0, n);
}

function main() {
    const mode = process.argv[2];
    if (mode === '--selftest') {
        const { failures, rows, regions } = selftest();
        console.log('selftest: ' + rows.length + ' rows');
        for (const f of failures) console.error('FAIL ' + f);
        if (failures.length) { console.error(`selftest FAILED (${failures.length})`); process.exit(1); }
        console.log('selftest GREEN');
        return;
    }

    const { rows, csv, regions } = build();

    if (mode === '--check') {
        if (!fs.existsSync(OUT_CSV)) { console.error('CHECK FAILED: SPEC/SPEC-ROWS.csv is missing'); process.exit(1); }
        const committed = fs.readFileSync(OUT_CSV, 'utf8');
        if (committed !== csv) {
            console.error('CHECK FAILED: rerun differs from SPEC/SPEC-ROWS.csv (nondeterminism or stale inventory)');
            const a = committed.split('\n'), b = csv.split('\n');
            for (let i = 0; i < Math.max(a.length, b.length); i++) {
                if (a[i] !== b[i]) { console.error(`  line ${i + 1}\n   committed: ${a[i]}\n   rerun:     ${b[i]}`); break; }
            }
            process.exit(1);
        }
        console.log(`CHECK GREEN: SPEC/SPEC-ROWS.csv reproduces byte-identically (${rows.length} rows)`);
        return;
    }

    fs.mkdirSync(path.dirname(OUT_CSV), { recursive: true });
    fs.writeFileSync(OUT_CSV, csv, 'utf8');

    const perPrefix = {};
    for (const r of rows) {
        const p = r.row_id.replace(/-\d+$/, '');
        perPrefix[p] = (perPrefix[p] || 0) + 1;
    }
    console.log(`wrote ${path.relative(REPO, OUT_CSV).replace(/\\/g, '/')} — ${rows.length} rows\n`);
    console.log('rows per prefix:');
    for (const region of regions) {
        console.log(`  ${region.prefix.padEnd(20)} ${String(region.count).padStart(4)}  ${region.file}  ${region.label}`);
    }
    console.log('\ntop-10 rows by vars_read count:');
    for (const { r, n } of topComplex(rows, 10)) {
        console.log(`  ${String(n).padStart(2)}  ${r.row_id.padEnd(18)} ${r.kind.padEnd(17)} L${r.line}  ${clip(r.snippet, 90)}`);
    }
    const kinds = {};
    for (const r of rows) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
    console.log('\nrows per kind:');
    for (const k of Object.keys(kinds).sort()) console.log(`  ${k.padEnd(18)} ${kinds[k]}`);
}

main();
