#!/usr/bin/env node
// (a) STATIC derivation for the Phase 3 SPEC pack (plan.md §2 Phase 3).
//
// Reads ONLY the parity-baseline sources out of git (checked against fixtures/BASELINE.json),
// parses server.js + public/script.js with acorn and scans public/index.html as a tag stream,
// and writes SPEC/from-static/*.json. It never reads fixtures/** — that is (b)'s job — and it
// never reads SPEC/from-model or SPEC/from-runtime.
//
//   node tools/parity/spec-static.js
//
// Attribution rule used for both generators: a pushed argv entry or an emitted ini key belongs
// to the field whose stored value it prints; when the emitted text is a constant, it belongs to
// the key named by its innermost guard, because that key is what makes the line exist at all.
// Guards are reported alongside, so the guard set is never lost — only separated.

'use strict';

const path = require('path');
const C = require('./spec-common');
const { SPEC, baselineSource, parseJs, walk, collect, flat, snippet, lineOf, findFunction,
    withParents, guardChain, writeJson, sha256 } = C;

const HTML = baselineSource('public/index.html');
const CLIENT = baselineSource('public/script.js');
const SERVER = baselineSource('server.js');
const SPEC_ROWS = path.join(SPEC, 'SPEC-ROWS.csv');

const VOID_TAGS = new Set(['input', 'br', 'img', 'link', 'meta', 'hr', 'source', 'path', 'circle', 'use']);

const provenance = (src) => ({ file: src.provenance, sha256: src.sha });

// ----------------------------------------------------------------------------------------
// public/index.html: tag-stream scan (attrs, options, section headings, labels)
// ----------------------------------------------------------------------------------------
function parseAttrs(raw) {
    const attrs = {};
    const re = /([a-zA-Z_:][-:\w.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
        const value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : '';
        attrs[m[1].toLowerCase()] = value;
    }
    return attrs;
}

function scanHtml(src) {
    const lineStarts = [0];
    for (let i = 0; i < src.text.length; i++) if (src.text[i] === '\n') lineStarts.push(i + 1);
    const lineNumberAt = (text, offset) => {
        let low = 0;
        let high = lineStarts.length - 1;
        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if (lineStarts[mid] <= offset) low = mid; else high = mid - 1;
        }
        return low + 1;
    };
    const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
    const root = { tag: '#document', attrs: {}, text: '', children: [], parent: null };
    let top = root;
    let last = 0;
    let m;
    while ((m = tagRe.exec(src.text)) !== null) {
        const between = src.text.slice(last, m.index);
        if (between) top.text += between;
        last = m.index + m[0].length;
        const closing = m[1] === '/';
        const tag = m[2].toLowerCase();
        if (closing) {
            let node = top;
            while (node && node.tag !== tag) node = node.parent;
            if (node && node.parent) top = node.parent;
            continue;
        }
        const node = { tag, attrs: parseAttrs(m[3] || ''), text: '', children: [], parent: top, order: 0, loc: { start: { line: lineNumberAt(src.text, m.index) } } };
        top.children.push(node);
        if (!VOID_TAGS.has(tag) && m[4] !== '/') top = node;
    }
    const nodes = [];
    let heading = null;
    let docOrder = 0;
    (function visit(node) {
        for (const child of node.children) {
            child.section = heading;
            if (child.tag === 'h3') heading = flat(child.text);
            if (['input', 'select', 'textarea', 'label', 'button'].includes(child.tag)) {
                child.docOrder = ++docOrder;
                nodes.push(child);
            }
            visit(child);
        }
    })(root);
    const labels = {};
    for (const node of nodes) if (node.tag === 'label' && node.attrs.for) labels[node.attrs.for] = flat(node.text);
    const controls = nodes.filter((n) => ['input', 'select', 'textarea'].includes(n.tag)).map((n) => {
        const id = n.attrs.id || null;
        const options = n.tag === 'select'
            ? collectOptions(n)
            : null;
        return {
            id,
            tag: n.tag,
            htmlType: n.tag === 'select' ? 'select' : (n.attrs.type || 'text'),
            section: n.section,
            label: id && labels[id] ? labels[id] : null,
            min: n.attrs.min !== undefined ? n.attrs.min : null,
            max: n.attrs.max !== undefined ? n.attrs.max : null,
            step: n.attrs.step !== undefined ? n.attrs.step : null,
            placeholder: n.attrs.placeholder !== undefined ? n.attrs.placeholder : null,
            disabledAttr: Object.prototype.hasOwnProperty.call(n.attrs, 'disabled'),
            valueAttr: n.attrs.value !== undefined ? n.attrs.value : null,
            checkedAttr: Object.prototype.hasOwnProperty.call(n.attrs, 'checked'),
            options: options ? options.map((o) => o.value) : null,
            defaultOption: options ? defaultOption(options) : null,
            htmlLine: lineOf(n),
        };
    });
    return { controls };
}

function collectOptions(selectNode) {
    const out = [];
    (function visit(node) {
        for (const child of node.children) {
            if (child.tag === 'option') {
                const text = flat(child.text);
                out.push({ value: child.attrs.value !== undefined ? child.attrs.value : text, label: text, selected: Object.prototype.hasOwnProperty.call(child.attrs, 'selected') });
            }
            visit(child);
        }
    })(selectNode);
    return out;
}

function defaultOption(options) {
    const selected = options.find((o) => o.selected);
    return selected ? selected.value : options.length ? options[0].value : null;
}

// ----------------------------------------------------------------------------------------
// public/script.js
// ----------------------------------------------------------------------------------------
const clientAst = withParents(parseJs(CLIENT.text, 'public/script.js'));

function domIdMap(ast) {
    const byVar = {};
    walk(ast, (node) => {
        if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier' || !node.init) return;
        const init = node.init;
        if (init.type === 'CallExpression') {
            const name = calleeName(init.callee);
            const arg = init.arguments[0];
            if (name === 'document.getElementById' && arg && arg.type === 'Literal') byVar[node.id.name] = arg.value;
            if (name === 'document.querySelector' && arg && arg.type === 'Literal' && typeof arg.value === 'string' && arg.value.startsWith('#')) byVar[node.id.name] = arg.value.slice(1);
        }
    });
    return byVar;
}

function calleeName(callee) {
    const parts = [];
    let node = callee;
    while (node && node.type === 'MemberExpression') { parts.unshift(node.property.name || node.property.value); node = node.object; }
    if (node && node.type === 'Identifier') parts.unshift(node.name);
    return parts.join('.');
}

// Which config key(s) an expression reads, and which settings/localStorage key.
function referencedKeys(node) {
    const config = new Set();
    const settings = new Set();
    walk(node, (n) => {
        if (n.type === 'MemberExpression' && n.object.type === 'Identifier') {
            if (n.object.name === 'config' && n.property.name) config.add(n.property.name);
            if (n.object.name === 'settings' && n.property.name) settings.add(n.property.name);
        }
        if (n.type !== 'Identifier') return;
        if (Object.prototype.hasOwnProperty.call(domIds, n.name)) config.add(domIds[n.name]);
        if (activeAliases().has(n.name)) config.add(activeAliases().get(n.name));
    });
    return { config: [...config], settings: [...settings] };
}

const domIds = domIdMap(clientAst);

// The local `const config = { ... }` literal inside a function.
function configLiteral(fnNode) {
    if (!fnNode) return null;
    let out = null;
    walk(fnNode, (node) => {
        if (out) return;
        if (node.type !== 'VariableDeclaration') return;
        for (const decl of node.declarations) {
            if (decl.id.type === 'Identifier' && decl.id.name === 'config' && decl.init && decl.init.type === 'ObjectExpression') out = decl.init;
        }
    });
    return out;
}

function literalKeys(objectNode) {
    if (!objectNode) return [];
    return objectNode.properties.filter((p) => p.key).map((p) => p.key.name || p.key.value);
}

function literalValue(objectNode, key) {
    const prop = objectNode.properties.find((p) => (p.key.name || p.key.value) === key);
    return prop || null;
}

// How a control is read: .checked, .value, .value.trim(), plus the coercion expression.
function readShape(fnSrc, initializer) {
    const text = snippet(fnSrc, initializer, 200);
    const checked = /\.checked\b/.test(text);
    const viaGetElementById = text.match(/document\.getElementById\((['"])([^'"]+)\1\)/);
    const domId = viaGetElementById ? viaGetElementById[2] : null;
    return { text, checked, domId };
}

// ----------------------------------------------------------------------------------------
// argv push sites (launchServer) and ini append sites (launchModelPresets)
// ----------------------------------------------------------------------------------------
// Resolve `local.push(...)` accumulators in a region: name -> config keys pushed into it. The
// whole region is scanned because an accumulator can be declared in an outer block of the branch
// its push sits in (`const specTypes = []` guards the `if (specTypes.length > 0)` push).
function localAccumulators(region) {
    const out = new Map();
    if (!region) return out;
    walk(region, (node) => {
        if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier') return;
        if (!node.init || node.init.type !== 'ArrayExpression') return;
        out.set(node.id.name, []);
    });
    walk(region, (node) => {
        if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
        const target = node.callee.object;
        if (target.type !== 'Identifier' || node.callee.property.name !== 'push') return;
        if (!out.has(target.name)) return;
        const bucket = out.get(target.name);
        for (const arg of node.arguments) {
            const keys = referencedKeys(arg).config;
            if (keys.length) { bucket.push(...keys); continue; }
            // `specTypes.push('ngram-mod')` names no field: the branch it sits in does.
            for (const parent of (node.__parents || [])) {
                if (parent.type === 'IfStatement') bucket.push(...referencedKeys(parent.test).config);
            }
        }
    });
    return out;
}

// Local aliases: `const modelPath = modelPathSelect.value.trim()` reads control #modelPath, and
// `const modelDir = config.modelPath.replace(...)` prints config.modelPath — both make an
// identifier stand in for a field, which is how an emitted value keeps its owner.
function localAliases(region) {
    const out = new Map();
    walk(region, (node) => {
        if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier' || !node.init) return;
        if (node.id.name === 'config') return;
        if (node.init.type === 'ObjectExpression' || node.init.type === 'ArrayExpression') return;
        let dom = null;
        let configKey = null;
        walk(node.init, (n) => {
            if (n.type !== 'MemberExpression' || n.object.type !== 'Identifier') return;
            if (n.property.name === 'value' && domIds[n.object.name]) dom = dom || domIds[n.object.name];
            if (n.object.name === 'config' && n.property.name) configKey = configKey || n.property.name;
        });
        const alias = dom || configKey;
        if (alias) out.set(node.id.name, alias);
    });
    return out;
}

const activeScope = { accumulators: new Map(), aliases: new Map() };
// referencedKeys resolves aliases, and it is also called while the aliases are being built, so
// the accessor keeps the ordering of the two scans irrelevant.
const activeAliases = () => activeScope.aliases;

// What a pushed value comes from: config keys (value source), settings keys, or a local
// accumulator / DOM-alias identifier resolved to the field it reads.
function valueSources(callNode) {
    const accums = activeScope.accumulators;
    const configKeys = new Set();
    const settingsKeys = new Set();
    for (const arg of callNode.arguments.slice(1)) {
        const refs = referencedKeys(arg);
        refs.config.forEach((k) => configKeys.add(k));
        refs.settings.forEach((k) => settingsKeys.add(k));
        walk(arg, (n) => {
            if (n.type !== 'Identifier') return;
            if (accums.has(n.name)) for (const key of accums.get(n.name)) configKeys.add(key);
            else if (activeAliases().has(n.name)) configKeys.add(activeAliases().get(n.name));
        });
    }
    return { config: [...configKeys], settings: [...settingsKeys] };
}

function argPushSites(src, fnNode) {
    activeScope.aliases = localAliases(fnNode);
    activeScope.accumulators = localAccumulators(fnNode);
    const pushes = [];
    collect(fnNode, 'CallExpression', (n) => n.callee.type === 'MemberExpression'
        && n.callee.object.type === 'Identifier' && n.callee.object.name === 'args'
        && n.callee.property.name === 'push').forEach((call, index) => {
        const first = call.arguments[0];
        const flag = first && first.type === 'Literal' ? String(first.value) : null;
        const guards = guardChain(call, src);
        const innermost = guards.length ? guards[guards.length - 1] : null;
        const innermostNode = innermost ? findGuardNode(call, innermost.line) : null;
        const sources = valueSources(call);
        let fieldFromValue = sources.config.length ? sources.config : (sources.settings.length ? sources.settings : []);
        let attribution = 'value';
        let fields = fieldFromValue;
        if (!fields.length && innermostNode) {
            const guardKeys = referencedKeys(innermostNode.test).config;
            if (guardKeys.length) { fields = guardKeys; attribution = 'guard'; }
        }
        pushes.push({
            pushOrder: index + 1,
            flag,
            arity: call.arguments.length === 1 ? 0 : 1,
            value: flag ? snippet(src, call.arguments[1] || call.arguments[0], 200) : null,
            rawPush: snippet(src, call, 220),
            line: lineOf(call),
            fields,
            attribution,
            guardFields: [...new Set(guards.flatMap((g) => {
                const node = findGuardNode(call, g.line);
                return node ? referencedKeys(node.test).config : [];
            }))],
            guardKeys: innermost ? referencedKeys(innermostNode ? innermostNode.test : call).config : [],
            guards,
            always: guards.length === 0,
        });
        // One statement can push several flags: args.push('--host', '0.0.0.0') is one entry,
        // while args.push('-m', value) is one entry too. args.push(a, b, c, d) is flattened.
    });
    // Guard nodes are located by line so the predicate text can be re-read from the AST.
    function findGuardNode(call, line) {
        let found = null;
        for (const parent of (call.__parents || [])) {
            if (parent.type === 'IfStatement' && lineOf(parent) === line) found = parent;
        }
        return found;
    }
    return pushes;
}

function iniAppendSites(src, fnNode) {
    activeScope.aliases = localAliases(fnNode);
    activeScope.accumulators = localAccumulators(fnNode);
    const appends = [];
    collect(fnNode, 'AssignmentExpression', (n) => n.operator === '+=' && n.left.type === 'Identifier' && n.left.name === 'presetContent')
        .forEach((assign, index) => {
            const right = assign.right;
            const text = emittedTemplate(src, right);
            const guards = guardChain(assign, src);
            const innermost = guards.length ? guards[guards.length - 1] : null;
            const innermostNode = innermost ? findGuardNode(assign, innermost.line) : null;
            const sources = valueSources({ arguments: [null, right] });
            let fields = sources.config.length ? sources.config : (sources.settings.length ? sources.settings : []);
            let attribution = 'value';
            if (!fields.length && innermostNode) {
                const guardKeys = referencedKeys(innermostNode.test).config;
                if (guardKeys.length) { fields = guardKeys; attribution = 'guard'; }
            }
            const pair = /^([^\s=]+) = ([\s\S]*?)\\n$/.exec(text.replace(/\r/g, ''));
            appends.push({
                appendOrder: index + 1,
                emittedText: text,
                key: pair ? pair[1] : (text.includes('[') && text.includes(']') ? null : null),
                keyValue: pair ? pair[2] : null,
                line: lineOf(assign),
                fields,
                attribution,
                guardFields: [...new Set(guards.flatMap((g) => {
                    const node = findGuardNode(assign, g.line);
                    return node ? referencedKeys(node.test).config : [];
                }))],
                guards,
                always: guards.length === 0,
                raw: snippet(src, assign, 220),
            });
        });
    function findGuardNode(assign, line) {
        let found = null;
        for (const parent of (assign.__parents || [])) {
            if (parent.type === 'IfStatement' && lineOf(parent) === line) found = parent;
        }
        return found;
    }
    return appends;
}

function emittedTemplate(src, right) {
    if (right.type === 'TemplateLiteral') {
        let out = '';
        right.quasis.forEach((quasi, i) => {
            out += quasi.value.cooked;
            if (right.expressions[i]) out += '${' + snippet(src, right.expressions[i], 120) + '}';
        });
        return out;
    }
    if (right.type === 'Literal') return String(right.value).replace(/\n/g, '\\n');
    return snippet(src, right, 200);
}

// ----------------------------------------------------------------------------------------
// deleteConfiguration reset list (Q8)
// ----------------------------------------------------------------------------------------
function resetMap(ast) {
    const fn = findFunction(ast, 'deleteConfiguration');
    const out = {};
    if (!fn) return out;
    walk(fn, (node) => {
        if (node.type !== 'AssignmentExpression' || node.operator !== '=') return;
        if (node.left.type !== 'MemberExpression' || node.left.object.type !== 'Identifier') return;
        const id = domIds[node.left.object.name];
        if (!id) return;
        const prop = node.left.property.name;
        out[id] = out[id] || {};
        out[id][prop] = { raw: snippet(CLIENT, node.right, 80), line: lineOf(node) };
    });
    return out;
}

// ----------------------------------------------------------------------------------------
// localStorage read/write sites
// ----------------------------------------------------------------------------------------
function storageSites(ast) {
    const written = new Map();
    const read = new Map();
    const track = (map, node, keyNode) => {
        const key = keyNode && keyNode.type === 'Literal' ? keyNode.value : null;
        if (!key) return;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({ line: lineOf(node), variable: node.arguments && node.arguments[1] ? snippet(CLIENT, node.arguments[1], 60) : null });
    };
    walk(ast, (node) => {
        if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
        const obj = node.callee.object;
        if (!obj || obj.type !== 'Identifier' || obj.name !== 'localStorage') return;
        const method = node.callee.property.name;
        if (method === 'setItem') track(written, node, node.arguments[0]);
        if (method === 'getItem') track(read, node, node.arguments[0]);
        if (method === 'removeItem') { /* recorded absence: no removeItem call exists */ }
    });
    return {
        written: [...written.entries()].map(([key, sites]) => ({ key, sites })).sort((a, b) => a.key.localeCompare(b.key)),
        read: [...read.entries()].map(([key, sites]) => ({ key, sites })).sort((a, b) => a.key.localeCompare(b.key)),
    };
}

// ----------------------------------------------------------------------------------------
// server.js: routes, socket emits, process lifecycle
// ----------------------------------------------------------------------------------------
const serverAst = withParents(parseJs(SERVER.text, 'server.js'));

function routeRows(ast) {
    const routes = [];
    collect(ast, 'CallExpression', (n) => n.callee.type === 'MemberExpression'
        && n.callee.object.type === 'Identifier' && n.callee.object.name === 'app'
        && ['get', 'post', 'put', 'delete', 'patch'].includes(n.callee.property.name)).forEach((call, index) => {
        const method = call.callee.property.name.toUpperCase();
        const routePath = call.arguments[0].value;
        const handler = call.arguments[1];
        const responses = [];
        const sideEffects = [];
        walk(handler, (node) => {
            if (resJsonCall(node)) {
                const status = nearestStatus(node);
                responses.push({
                    status: status === null ? 200 : status,
                    statusExplicit: status !== null,
                    body: node.arguments[0] ? bodyShape(node.arguments[0]) : null,
                    bodyText: node.arguments[0] ? snippet(SERVER, node.arguments[0], 240) : null,
                    condition: guardChain(node, SERVER).map((g) => `${g.kind} (${g.test})`),
                    line: lineOf(node),
                });
            }
            if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
                && node.callee.object.type === 'Identifier' && node.callee.object.name === 'res'
                && node.callee.property.name === 'sendFile') {
                responses.push({
                    status: 200, statusExplicit: false, kind: 'file',
                    bodyText: snippet(SERVER, node.arguments[0], 160), condition: [], line: lineOf(node),
                });
            }
            if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
                && node.callee.object.type === 'Identifier' && node.callee.object.name === 'spawn') {
                sideEffects.push({ kind: 'spawn', line: lineOf(node), args: node.arguments.map((a) => snippet(SERVER, a, 120)) });
            }
            if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
                && node.callee.property.name === 'kill') {
                sideEffects.push({ kind: 'kill', line: lineOf(node), signal: node.arguments[0] ? node.arguments[0].value : null });
            }
            if (node.type === 'CallExpression' && calleeName(node.callee) === 'setTimeout') {
                sideEffects.push({ kind: 'timer', line: lineOf(node), delay: node.arguments[1] ? node.arguments[1].value : null });
            }
            if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
                && node.callee.property.name === 'writeFile') {
                sideEffects.push({ kind: 'writeFile', line: lineOf(node), target: snippet(SERVER, node.arguments[0], 120) });
            }
        });
        routes.push({
            registrationOrder: index + 1,
            method,
            path: routePath,
            line: lineOf(call),
            handlerAsync: !!handler.async,
            responses,
            sideEffects,
        });
    });
    return routes;

    function resJsonCall(node) {
        if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return false;
        if (node.callee.property.name !== 'json') return false;
        let obj = node.callee.object;
        while (obj && obj.type === 'CallExpression') obj = obj.callee.object;
        return !!obj && obj.type === 'Identifier' && obj.name === 'res';
    }
    function nearestStatus(jsonCall) {
        // `return res.status(400).json({...})` chains the status onto the same expression.
        const chained = jsonCall.callee.object;
        if (chained && chained.type === 'CallExpression' && chained.callee.type === 'MemberExpression'
            && chained.callee.property.name === 'status' && chained.arguments[0] && chained.arguments[0].type === 'Literal') {
            return chained.arguments[0].value;
        }
        const chain = jsonCall.__parents || [];
        const holder = chain.length ? chain[chain.length - 1] : null;
        const siblings = holder ? statementsOf(holder) : [];
        let best = null;
        for (const stmt of siblings) {
            if (stmt.start >= jsonCall.start) break;
            walk(stmt, (n) => {
                if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression'
                    && n.callee.object.type === 'Identifier' && n.callee.object.name === 'res'
                    && n.callee.property.name === 'status' && n.arguments[0] && n.arguments[0].type === 'Literal') {
                    best = n.arguments[0].value;
                }
            });
        }
        return best;
    }
    function statementsOf(holder) {
        const list = [];
        for (const key of Object.keys(holder)) {
            if (key === 'body' || key === 'consequent' || key === 'alternate' || key === 'block') {
                const value = holder[key];
                if (Array.isArray(value)) list.push(...value);
                else if (value && value.type === 'BlockStatement') list.push(...value.body);
            }
        }
        return list.filter((s) => s && typeof s.start === 'number').sort((a, b) => a.start - b.start);
    }
    function bodyShape(node) {
        if (node.type !== 'ObjectExpression') return null;
        const out = {};
        for (const prop of node.properties) {
            const key = prop.key ? prop.key.name || prop.key.value : null;
            if (key === null) continue;
            out[key] = prop.value.type === 'Literal' ? JSON.stringify(prop.value.value) : snippet(SERVER, prop.value, 120);
        }
        return out;
    }
}

function emitCalls(ast, names) {
    const out = [];
    walk(ast, (node) => {
        if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
        if (node.callee.property.name !== 'emit') return;
        const target = node.callee.object.type === 'Identifier' ? node.callee.object.name : calleeName(node.callee.object);
        if (!names.includes(target)) return;
        const event = node.arguments[0] && node.arguments[0].type === 'Literal' ? node.arguments[0].value : null;
        out.push({
            event,
            target,
            line: lineOf(node),
            payloadKeys: node.arguments[1] && node.arguments[1].type === 'ObjectExpression'
                ? node.arguments[1].properties.map((p) => p.key.name || p.key.value) : null,
            payloadText: node.arguments[1] ? snippet(SERVER, node.arguments[1], 160) : null,
        });
    });
    return out;
}

function clientSocketListeners(ast) {
    const out = [];
    walk(ast, (node) => {
        if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
        if (node.callee.property.name !== 'on') return;
        if (node.callee.object.type !== 'Identifier' || node.callee.object.name !== 'socket') return;
        const event = node.arguments[0] && node.arguments[0].type === 'Literal' ? node.arguments[0].value : null;
        out.push({ event, line: lineOf(node), handler: snippet(CLIENT, node.arguments[1] || node, 220) });
    });
    return out;
}

// ----------------------------------------------------------------------------------------
// assemble
// ----------------------------------------------------------------------------------------
function main() {
    const html = scanHtml(HTML);
    const byId = new Map(html.controls.map((c) => [c.id, c]));
    const controlsInOrder = html.controls.filter((c) => c.id);

    const saveFn = findFunction(clientAst, 'saveCurrentValues');
    const launchFn = findFunction(clientAst, 'launchServer');
    const presetsFn = findFunction(clientAst, 'launchModelPresets');
    const saveLiteral = configLiteral(saveFn);
    const launchLiteral = configLiteral(launchFn);
    if (!saveLiteral || !launchFn || !presetsFn) throw new Error('script.js region roots not found (saveCurrentValues / launchServer / launchModelPresets)');

    const persistedKeys = literalKeys(saveLiteral);
    const pushes = argPushSites(CLIENT, launchFn);
    const appends = iniAppendSites(CLIENT, presetsFn);
    const resets = resetMap(clientAst);

    // ini key rows: keep only the "<key> = <value>" appends; section headers, the version
    // header and the blank-line separator are reported as structure instead.
    const iniRows = appends.filter((a) => /^\S+ = /.test(a.emittedText));
    const structure = appends.filter((a) => !/^\S+ = /.test(a.emittedText))
        .map((a) => ({ emittedText: a.emittedText, line: a.line, guards: a.guards.map((g) => `${g.kind} (${g.test})`) }));
    const versionHeader = emittedInitial(presetsFn);

    const argvRows = pushes.map((p) => ({
        order: p.pushOrder,
        flag: p.flag,
        arity: p.arity,
        value: p.value,
        fields: p.fields,
        attribution: p.attribution,
        guardFields: p.guardFields,
        guard: p.guards.length ? p.guards.map((g) => `${g.kind === 'else' ? 'else' : g.kind === 'else-if' ? 'else if' : 'if'} (${g.test})`).join(' { ') : null,
        guardKeys: p.guardKeys,
        always: p.always,
        line: p.line,
        evidence: [`public/script.js:${p.line}`],
    }));

    const iniMapRows = iniRows.map((a, index) => ({
        order: index + 1,
        key: /^\S+ = /.test(a.emittedText) ? a.emittedText.split(' = ')[0] : null,
        value: a.emittedText.replace(/^[^\s=]+ = /, '').replace(/\\n$/, ''),
        fields: a.fields,
        attribution: a.attribution,
        guardFields: a.guardFields,
        guard: a.guards.length ? a.guards.map((g) => `${g.kind === 'else' ? 'else' : g.kind === 'else-if' ? 'else if' : 'if'} (${g.test})`).join(' { ') : null,
        always: a.always,
        line: a.line,
        evidence: [`public/script.js:${a.line}`],
    }));
    const trailing = iniMapRows.filter((r) => r.guard === null);
    const sectioned = iniMapRows.filter((r) => r.guard !== null);

    const argvByField = {};
    const iniByField = {};
    for (const row of argvRows) for (const key of row.fields) (argvByField[key] = argvByField[key] || []).push(row);
    for (const row of iniMapRows) for (const key of row.fields) (iniByField[key] = iniByField[key] || []).push(row);

    // ---- field-manifest -----------------------------------------------------------------
    const fields = [];
    let order = 0;
    for (const control of controlsInOrder) {
        order += 1;
        const evidence = [`public/index.html:${control.htmlLine}`];
        const saveProp = literalValue(saveLiteral, control.id);
        const launchProp = literalValue(launchLiteral, control.id);
        const readerSource = launchProp || saveProp;
        const read = readerSource ? readShape(CLIENT, readerSource.value) : null;
        if (saveProp) evidence.push(`public/script.js:${lineOf(saveProp)}`);
        else evidence.push('public/script.js: not in the saveCurrentValues key set');
        const cli = (argvByField[control.id] || []).filter((r) => r.flag);
        const ini = (iniByField[control.id] || []).filter((r) => r.key);
        const reset = resets[control.id];
        const defaultValue = control.tag === 'select'
            ? control.defaultOption
            : (control.htmlType === 'checkbox' ? null : control.valueAttr === null ? '' : control.valueAttr);
        fields.push({
            id: control.id,
            order,
            tag: control.tag,
            htmlType: control.htmlType,
            section: control.section,
            label: control.label,
            min: control.min,
            max: control.max,
            step: control.step,
            placeholder: control.placeholder,
            defaultValue,
            defaultChecked: control.tag === 'input' && control.htmlType === 'checkbox' ? control.checkedAttr : null,
            disabledAttr: control.disabledAttr,
            options: control.options,
            defaultOption: control.tag === 'select' ? control.defaultOption : null,
            optionsDynamic: /modelPath|draftModelPath|launchPresetsSelect/.test(control.id) ? true : (control.tag === 'select' ? false : null),
            persisted: persistedKeys.includes(control.id),
            persistedIn: persistedKeys.includes(control.id) ? 'llamaCppConfigs' : null,
            persistKey: persistedKeys.includes(control.id) ? control.id : null,
            domRead: read ? `#${control.id}.${read.checked ? 'checked' : 'value'}` : null,
            coercion: read ? read.text : null,
            cliFlags: unique(cli.map((r) => r.flag)),
            iniKeys: unique(ini.map((r) => r.key)),
            resetOnDelete: !!reset,
            resetValue: resetValueOf(reset),
            evidence,
        });
    }
    // The settings dialog controls are built by openSettingsDialog at runtime.
    for (const dialogControl of dialogControls()) {
        order += 1;
        const id = dialogControl.id;
        const saveProp = literalValue(saveLiteral, id);
        const cli = (argvByField[id] || []).filter((r) => r.flag);
        const ini = (iniByField[id] || []).filter((r) => r.key);
        const settingsWrites = storageSites(clientAst).written.find((w) => w.key === 'llamaCppSettings');
        fields.push({
            id,
            order,
            tag: 'input',
            htmlType: dialogControl.type,
            section: 'Settings dialog (built by openSettingsDialog)',
            label: dialogControl.label,
            min: dialogControl.min,
            max: dialogControl.max,
            step: dialogControl.step,
            placeholder: dialogControl.placeholder,
            defaultValue: null,
            defaultValueNote: dialogControl.defaultValue,
            defaultChecked: null,
            disabledAttr: false,
            options: null,
            defaultOption: null,
            optionsDynamic: null,
            persisted: true,
            persistedIn: 'llamaCppSettings',
            persistKey: id,
            domRead: `#${id}.${dialogControl.readExpr}`,
            coercion: dialogControl.coercion,
            cliFlags: unique(cli.map((r) => r.flag)),
            iniKeys: unique(ini.map((r) => r.key)),
            resetOnDelete: false,
            resetValue: null,
            evidence: [dialogControl.evidence, ...(settingsWrites ? [`public/script.js:${settingsWrites.sites[0].line}`] : [])],
            ...(saveProp ? {} : {}),
        });
    }
    // The retired key the ini generator still reads (Q17): a field with no control.
    const reasoningAppend = iniMapRows.find((r) => r.key === 'reasoning' && r.fields.includes('disableReasoning'));
    order += 1;
    fields.push({
        id: 'disableReasoning',
        order,
        tag: null,
        htmlType: null,
        section: 'none - no control (legacy localStorage key)',
        label: null,
        min: null, max: null, step: null, placeholder: null,
        defaultValue: null, defaultChecked: null, disabledAttr: null,
        options: null, defaultOption: null, optionsDynamic: null,
        persisted: false, persistedIn: null, persistKey: null,
        domRead: null,
        coercion: 'read from the parsed config object only',
        cliFlags: [],
        iniKeys: reasoningAppend ? ['reasoning'] : [],
        resetOnDelete: false,
        resetValue: null,
        evidence: [reasoningAppend ? `public/script.js:${reasoningAppend.line}` : 'public/script.js: launchModelPresets reasoning else-if', 'public/script.js: not in the saveCurrentValues key set'],
    });

    const fieldManifest = {
        artifact: 'field-manifest',
        schemaVersion: 1,
        derivation: 'static',
        generatedBy: 'tools/parity/spec-static.js',
        sources: [provenance(HTML), provenance(CLIENT)],
        fieldUniverseRule: 'every <input>/<select>/<textarea> carrying an id in public/index.html (document order), plus the 2 controls openSettingsDialog writes into the generated settings dialog, plus disableReasoning — the legacy key the preset-ini generator still reads although no control owns it (Q17)',
        fieldCount: fields.length,
        persistedKeySet: { source: 'saveCurrentValues config literal', keys: persistedKeys, count: persistedKeys.length },
        launchServerKeySet: { source: 'launchServer config literal', keys: literalKeys(launchLiteral), count: literalKeys(launchLiteral).length },
        fields,
    };

    // ---- arg-truth-table --------------------------------------------------------------
    const specRowsByFlag = specRowsArgMap();
    const argTable = {
        artifact: 'arg-truth-table',
        schemaVersion: 1,
        derivation: 'static',
        generatedBy: 'tools/parity/spec-static.js',
        sources: [provenance(CLIENT), { file: 'SPEC/SPEC-ROWS.csv', sha256: sha256(require('fs').readFileSync(SPEC_ROWS, 'utf8')) }],
        region: 'launchServer (the inline buildArgs region); the vector is built client-side and POSTed to /start as body.args',
        orderSemantics: 'args.push runs in source order in one flat array; argv order is part of the contract',
        specRowsJoin: specRowsByFlag.note,
        rows: argvRows.map((r) => ({
            ...r,
            specRowIds: (specRowsByFlag.byFlag[r.flag] || []).map((x) => x.row_id),
            specRowPredicates: (specRowsByFlag.byFlag[r.flag] || []).map((x) => x.code_snippet),
        })),
        alwaysAppended: argvRows.filter((r) => r.always).map((r) => r.flag),
    };

    // ---- ini-map ----------------------------------------------------------------------
    // Which CLI flag an ini key corresponds to: an ini emit site pairs with the argv push that
    // sits behind an identical guard chain and prints a field in common; where a chain holds
    // several emits (the ngram trio), the k-th ini key pairs with the k-th push.
    const normaliseFlag = (flag) => String(flag || '').replace(/^-+/, '');
    const iniGroupSeen = new Map();
    const cliByIniRow = new Map();
    for (const row of iniMapRows) {
        const chain = row.guard || '<unguarded>';
        const candidates = argvRows.filter((a) => (a.guard || '<unguarded>') === chain
            && (a.fields || []).some((f) => (row.fields || []).includes(f)));
        const index = iniGroupSeen.get(chain) || 0;
        iniGroupSeen.set(chain, index + 1);
        const match = candidates[index] || (candidates.length === 1 ? candidates[0] : null);
        if (match) cliByIniRow.set(row, match);
    }
    const iniRowsOut = iniMapRows.map((r) => {
        const counterpart = cliByIniRow.get(r) || null;
        return {
            ...r,
            cliCounterpart: counterpart ? counterpart.flag : null,
            pairedBy: counterpart ? 'identical-guard-chain' : null,
            nameDivergence: counterpart ? normaliseFlag(counterpart.flag) !== r.key : null,
        };
    });
    const iniMap = {
        artifact: 'ini-map',
        schemaVersion: 1,
        derivation: 'static',
        generatedBy: 'tools/parity/spec-static.js',
        sources: [provenance(CLIENT), provenance(SERVER)],
        builtBy: 'launchModelPresets in the browser; the finished string is POSTed to /launch-presets, and server.js writes the body verbatim to models-preset.ini',
        structure: {
            versionHeader: versionHeader,
            sectionHeader: iniStructure(presetsFn).sectionHeader,
            sectionOrder: iniStructure(presetsFn).sectionOrder,
            sectionSeparator: iniStructure(presetsFn).sectionSeparator,
            trailingKey: trailing.map((r) => ({ key: r.key, value: r.value, line: r.line, evidence: [`public/script.js:${r.line}`] })),
            lineFormat: '<key> = <value>, single spaces around =, each line terminated by \\n; nothing quoted or escaped',
        },
        rows: iniRowsOut,
        pairingRule: 'an ini key pairs with the argv push behind an identical guard chain that prints a field in common; members of a shared chain pair by relative emission order',
        nameDivergences: iniRowsOut.filter((r) => r.nameDivergence === true).map((r) => ({ ini: r.key, cli: r.cliCounterpart, evidence: r.evidence })),
    };

    // ---- api / socket / process / storage ----------------------------------------------
    const routes = routeRows(serverAst);
    const statics = collect(serverAst, 'CallExpression', (n) => calleeName(n.callee) === 'app.use')
        .map((n) => ({ middleware: snippet(SERVER, n.arguments[0], 120), line: lineOf(n) }));
    const listen = collect(serverAst, 'CallExpression', (n) => n.callee.type === 'MemberExpression' && n.callee.property.name === 'listen')
        .map((n) => ({ line: lineOf(n), port: snippet(SERVER, n.arguments[0], 60) }));
    const api = {
        artifact: 'api-contract',
        schemaVersion: 1,
        derivation: 'static',
        generatedBy: 'tools/parity/spec-static.js',
        sources: [provenance(SERVER)],
        server: {
            middleware: statics.map((s) => s.middleware),
            listen: listen,
            portConstant: moduleConstant(serverAst, 'PORT'),
            defaultPortConstant: moduleConstant(serverAst, 'DEFAULT_PORT'),
        },
        routes,
        nonRoutes: [
            { path: '/swagger.json', why: 'no app.get registration exists; express.static(public) serves the checked-in file', evidence: statics.map((s) => `public/script.js:${s.line}`) },
            { path: 'GET /restart', why: 'only app.post(\'/restart\') is registered, so express answers the default 404 page', evidence: routes.filter((r) => r.path === '/restart').map((r) => `server.js:${r.line}`) },
        ],
    };

    const serverEmits = emitCalls(serverAst, ['client', 'socket', 'io']);
    const socket = {
        artifact: 'socket-contract',
        schemaVersion: 1,
        derivation: 'static',
        generatedBy: 'tools/parity/spec-static.js',
        sources: [provenance(SERVER), provenance(CLIENT)],
        transport: {
            ioCreation: snippet(SERVER, ioSetupCall(serverAst), 200),
            ioOptions: ioOptionsNode(serverAst) ? snippet(SERVER, ioOptionsNode(serverAst), 120) : null,
            clientConnect: snippet(CLIENT, findIoCallClient(clientAst) || { start: 0, end: 0 }, 80),
            origin: ioOrigin(serverAst),
        },
        serverToClient: groupEmits(serverEmits),
        absentEvents: [{ event: 'server-started', fact: `no emit site named server-started exists in server.js (emitted events found: ${unique(serverEmits.map((e) => e.event)).join(', ')})` }],
        clientToServer: { customEmits: emitCalls(clientAst, ['socket']).map((e) => e.event) },
        clientListeners: clientSocketListeners(clientAst),
        connectionHandlers: connectionHandlers(serverAst),
    };

    const processLifecycle = {
        artifact: 'process-lifecycle',
        schemaVersion: 1,
        derivation: 'static',
        generatedBy: 'tools/parity/spec-static.js',
        sources: [provenance(SERVER)],
        spawn: spawnSites(serverAst),
        kill: killSites(serverAst),
        handlers: processHandlers(serverAst),
        stateVariables: ['runningProcess', 'lastLaunchConfig', 'connectedClients', 'systemMetrics'].map((name) => ({
            name,
            line: lineOf(findDeclaration(serverAst, name)),
            writtenAt: collect(serverAst, 'AssignmentExpression', (n) => n.left.type === 'Identifier' && n.left.name === name).map((n) => lineOf(n)),
        })),
        statusExpression: statusExpression(serverAst),
        metricsInterval: intervalSites(serverAst),
    };

    const storage = {
        artifact: 'storage-schema',
        schemaVersion: 1,
        derivation: 'static',
        generatedBy: 'tools/parity/spec-static.js',
        sources: [provenance(CLIENT)],
        sites: storageSites(clientAst),
        persistedFieldCount: persistedKeys.length,
        persistedFields: persistedKeys,
        writeIsFreshLiteral: {
            fact: 'saveCurrentValues assigns a brand-new object literal, so keys outside the persisted set are dropped when that configuration is saved again (Q16)',
            evidence: [`public/script.js:${lineOf(saveLiteral)}`],
        },
        insertionOrder: insertionOrderEvidence(presetsFn),
        settingsObjectKeys: settingsKeysEvidence(clientAst),
    };

    const outDir = path.join(SPEC, 'from-static');
    writeJson(path.join(outDir, 'field-manifest.json'), fieldManifest);
    writeJson(path.join(outDir, 'arg-truth-table.json'), argTable);
    writeJson(path.join(outDir, 'ini-map.json'), iniMap);
    writeJson(path.join(outDir, 'api-contract.json'), api);
    writeJson(path.join(outDir, 'socket-contract.json'), socket);
    writeJson(path.join(outDir, 'process-lifecycle.json'), processLifecycle);
    writeJson(path.join(outDir, 'storage-schema.json'), storage);

    console.log(`spec-static: ${fields.length} fields (${persistedKeys.length} persisted), ${argvTableRowCount(argvRows)} argv pushes, ${iniMapRows.length} ini keys, ${routes.length} routes, ${unique(serverEmits.map((e) => e.event)).length} socket events -> ${outDir}`);
    console.log(`  argv always-appended: ${argTable.alwaysAppended.join(' ')}`);
    console.log(`  ini trailing keys: ${trailing.map((r) => r.key).join(', ')}`);
    console.log(`  name divergences: ${iniMap.nameDivergences.map((d) => `${d.ini}<->${d.cli}`).join(', ') || 'none'}`);
}

function argvTableRowCount(rows) { return rows.length; }

function resetValueOf(reset) {
    if (!reset) return null;
    if (reset.checked) return reset.checked.raw === 'true';
    const raw = reset.value ? reset.value.raw : null;
    if (raw === null) return null;
    const quoted = /^'([\s\S]*)'$/.exec(raw) || /^"([\s\S]*)"$/.exec(raw);
    return quoted ? quoted[1] : raw;
}

function emittedInitial(fnNode) {
    let out = null;
    walk(fnNode, (node) => {
        if (out) return;
        if (node.type !== 'VariableDeclaration') return;
        for (const decl of node.declarations) {
            if (decl.id.type === 'Identifier' && decl.id.name === 'presetContent' && decl.init) out = snippet(CLIENT, decl.init, 80);
        }
    });
    return out;
}

function iniStructure(fnNode) {
    const sectionHeader = [];
    const separators = [];
    walk(fnNode, (node) => {
        if (node.type !== 'AssignmentExpression' || node.operator !== '+=') return;
        if (!(node.left.type === 'Identifier' && node.left.name === 'presetContent')) return;
        const text = emittedTemplate(CLIENT, node.right);
        if (text.includes('[') && text.includes(']')) sectionHeader.push({ text, line: lineOf(node) });
        if (text === '\\n' || text === '\n') separators.push({ text, line: lineOf(node) });
    });
    const loop = collect(fnNode, 'ForOfStatement', (n) => true)[0] || null;
    const forInfo = loop ? snippet(CLIENT, loop.left || loop, 120) : null;
    return {
        sectionHeader: sectionHeader.map((s) => ({ text: s.text, line: s.line })),
        sectionSeparator: separators.length ? { lines: separators.map((s) => s.line) } : null,
        sectionOrder: { loop: forInfo, note: 'sections iterate Object.entries(parsed llamaCppConfigs), so localStorage insertion order is the section order (§9 trap 6)', line: loop ? lineOf(loop) : null },
    };
}

function dialogControls() {
    // openSettingsDialog builds its markup as a template literal; the two input tags and the
    // Save handler are the evidence for these two controls.
    const fn = findFunction(clientAst, 'openSettingsDialog');
    if (!fn) throw new Error('openSettingsDialog not found');
    const template = collect(fn, 'TemplateLiteral')[0];
    // Template holes are kept in source form (${expression}): the interpolated value is a runtime
    // input, and (b) records the rendered result rather than the template.
    const text = template
        ? template.quasis.map((q, i) => q.value.cooked + (template.expressions[i] ? '${' + snippet(CLIENT, template.expressions[i], 60) + '}' : '')).join('')
        : '';
    const line = lineOf(template || fn);
    const grab = (id) => {
        const tagRe = new RegExp(`<input[^>]*id="${id}"[^>]*>`, 'i');
        const hit = tagRe.exec(text);
        const attrs = hit ? parseAttrs(hit[0].replace(/^<input/i, '').replace(/>$/, '')) : {};
        return attrs;
    };
    // The Save handler reads each input once; the assignment that consumes the read is the coercion.
    const readExpression = (id) => {
        const aliases = new Set();
        for (const declarator of collect(fn, 'VariableDeclarator')) {
            const init = declarator.init ? snippet(CLIENT, declarator.init, 200) : '';
            if (declarator.id.type === 'Identifier' && init.includes(`#${id}'`)) aliases.add(declarator.id.name);
        }
        let found = null;
        for (const declarator of collect(fn, 'VariableDeclarator')) {
            if (!declarator.init) continue;
            const init = snippet(CLIENT, declarator.init, 240);
            if (!init.includes('.value')) continue;
            if (!init.includes(`#${id}'`) && ![...aliases].some((name) => init.includes(`${name}.value`))) continue;
            found = { text: init, line: lineOf(declarator) };
            break;
        }
        return found;
    };
    const directory = grab('modelsDirectory');
    const port = grab('serverPort');
    const directoryRead = readExpression('modelsDirectory');
    const portRead = readExpression('serverPort');
    return [
        {
            id: 'modelsDirectory', type: directory.type || 'text', label: 'Models Directory:',
            min: directory.min || null, max: directory.max || null, step: directory.step || null,
            placeholder: directory.placeholder !== undefined ? directory.placeholder : null,
            defaultValue: null,
            defaultValueNote: 'the value attribute is the interpolated settings.modelsDirectory',
            readExpr: 'value.trim()', coercion: directoryRead ? directoryRead.text : null,
            evidence: `public/script.js:${directoryRead ? directoryRead.line : line}`,
        },
        {
            id: 'serverPort', type: port.type || 'number', label: 'Server Port (--port):',
            min: port.min || null, max: port.max || null, step: port.step || null,
            placeholder: port.placeholder !== undefined ? port.placeholder : null,
            defaultValue: null,
            defaultValueNote: 'the value attribute is the interpolated settings.serverPort ?? DEFAULT_PORT',
            readExpr: 'value',
            coercion: portRead ? portRead.text : null,
            evidence: `public/script.js:${portRead ? portRead.line : line}`,
        },
    ];
}

function moduleConstant(ast, name) {
    let out = null;
    walk(ast, (node) => {
        if (out) return;
        if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier' || node.id.name !== name) return;
        if (node.init && node.init.type === 'Literal') out = { name, value: node.init.value, line: lineOf(node) };
    });
    return out;
}

function ioSetupCall(ast) {
    return collect(ast, 'CallExpression', (n) => n.callee.type === 'CallExpression'
        && n.callee.callee.type === 'Identifier' && n.callee.callee.name === 'require'
        && /socket\.io/.test(snippet(SERVER, n.callee.arguments[0], 40)))[0] || { start: 0, end: 0 };
}
function ioOrigin(ast) {
    const call = ioSetupCall(ast);
    const options = call.arguments ? call.arguments[1] : null;
    if (!options) return null;
    let origin = null;
    walk(options, (n) => { if (n.type === 'Property' && (n.key.name || n.key.value) === 'origin') origin = snippet(SERVER, n.value, 40); });
    return origin;
}
function findIoCallClient(ast) {
    return collect(ast, 'CallExpression', (n) => n.callee.type === 'Identifier' && n.callee.name === 'io')[0] || null;
}
function ioOptionsNode(ast) {
    const call = collect(ast, 'CallExpression', (n) => n.callee.type === 'CallExpression' && n.arguments.length >= 2)[0];
    return call ? call.arguments[1] : null;
}

function groupEmits(emits) {
    const byEvent = {};
    for (const e of emits) {
        byEvent[e.event] = byEvent[e.event] || { event: e.event, payloadKeys: e.payloadKeys, payloadText: e.payloadText, emittedFrom: [], lines: [] };
        byEvent[e.event].emittedFrom.push(`connectedClients.forEach(client => client.emit(...))`);
        byEvent[e.event].lines.push(e.line);
    }
    return Object.values(byEvent).map((e) => ({
        event: e.event,
        payloadKeys: e.payloadKeys,
        payloadText: e.payloadText,
        emitSites: e.lines.map((l) => `server.js:${l}`),
        emitTarget: 'connectedClients.forEach(client => client.emit(...))',
    }));
}

function connectionHandlers(ast) {
    const conn = collect(ast, 'CallExpression', (n) => n.callee.type === 'MemberExpression' && n.callee.object.type === 'Identifier' && n.callee.object.name === 'io' && n.callee.property.name === 'on' && n.arguments[0] && n.arguments[0].value === 'connection')[0];
    if (!conn) return null;
    const out = { line: lineOf(conn), handlers: [] };
    walk(conn, (node) => {
        if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.property.name === 'on'
            && node.arguments[0] && node.arguments[0].type === 'Literal') {
            out.handlers.push({ event: node.arguments[0].value, line: lineOf(node), body: snippet(SERVER, node.arguments[1], 220) });
        }
        if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
            && ['push', 'splice', 'indexOf'].includes(node.callee.property.name)
            && node.callee.object.type === 'Identifier' && node.callee.object.name === 'connectedClients') {
            out.connectedClientsOps = (out.connectedClientsOps || []).concat([{ op: node.callee.property.name, line: lineOf(node) }]);
        }
    });
    return out;
}

function spawnSites(ast) {
    return collect(ast, 'CallExpression', (n) => n.callee.type === 'Identifier' && n.callee.name === 'spawn').map((n) => ({
        line: lineOf(n),
        executable: snippet(SERVER, n.arguments[0], 60),
        args: snippet(SERVER, n.arguments[1], 60),
        options: n.arguments[2] ? snippet(SERVER, n.arguments[2], 80) : null,
        shell: n.arguments[2] ? /shell/.test(snippet(SERVER, n.arguments[2], 120)) : false,
    }));
}

function killSites(ast) {
    return collect(ast, 'CallExpression', (n) => n.callee.type === 'MemberExpression' && n.callee.property.name === 'kill').map((n) => ({
        line: lineOf(n),
        signal: n.arguments[0] && n.arguments[0].type === 'Literal' ? n.arguments[0].value : null,
        target: snippet(SERVER, n.callee.object, 60),
        insideTimer: (n.__parents || []).some((p) => p.type === 'CallExpression' && calleeName(p.callee) === 'setTimeout'),
    }));
}

function processHandlers(ast) {
    const out = [];
    walk(ast, (node) => {
        if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
        if (node.callee.property.name !== 'on') return;
        const event = node.arguments[0] && node.arguments[0].type === 'Literal' ? node.arguments[0].value : null;
        if (!['close', 'error', 'exit'].includes(event)) return;
        const target = node.callee.object.type === 'MemberExpression' ? snippet(SERVER, node.callee.object.object, 40) : snippet(SERVER, node.callee.object, 40);
        out.push({ event, target: `${target}.${snippet(SERVER, node.callee.object.property, 30)}`, line: lineOf(node), body: snippet(SERVER, node.arguments[1], 300) });
    });
    return out;
}

function findDeclaration(ast, name) {
    let found = null;
    walk(ast, (node) => {
        if (found) return;
        if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === name) found = node;
    });
    return found || { start: 0, end: 0, loc: { start: { line: null } } };
}

function statusExpression(ast) {
    const route = collect(ast, 'CallExpression', (n) => n.callee.type === 'MemberExpression' && n.callee.object.name === 'app'
        && n.callee.property.name === 'get' && n.arguments[0] && n.arguments[0].value === '/status')[0];
    if (!route) return null;
    const json = collect(route.arguments[1], 'CallExpression', (n) => n.callee.type === 'MemberExpression' && n.callee.property.name === 'json')[0];
    return json ? { expression: snippet(SERVER, json.arguments[0], 200), line: lineOf(json) } : null;
}

function intervalSites(ast) {
    return collect(ast, 'CallExpression', (n) => calleeName(n.callee) === 'setInterval').map((n) => ({
        line: lineOf(n), callback: snippet(SERVER, n.arguments[0], 60), delay: n.arguments[1] ? n.arguments[1].value : null,
    }));
}

function insertionOrderEvidence(fnNode) {
    const entries = collect(fnNode, 'CallExpression', (n) => calleeName(n.callee) === 'Object.entries').map((n) => ({ call: 'Object.entries', arg: snippet(CLIENT, n.arguments[0], 40), line: lineOf(n) }));
    const renderSort = collect(clientAst, 'CallExpression', (n) => n.callee.type === 'MemberExpression' && n.callee.property.name === 'sort').map((n) => ({ call: '.sort()', target: snippet(CLIENT, n.callee.object, 40), line: lineOf(n) }));
    return { iniIteration: entries, renderListSort: renderSort, note: 'ini section order follows the parsed object; the rendered config list is sorted separately' };
}

function settingsKeysEvidence(ast) {
    const out = [];
    walk(ast, (node) => {
        if (node.type === 'VariableDeclarator' && node.id.name === 'settings' && node.init && node.init.type === 'ObjectExpression') {
            out.push({ where: 'module-level settings object', keys: literalKeys(node.init), line: lineOf(node) });
        }
        if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier' && node.left.name === 'settings'
            && node.right.type === 'ObjectExpression') {
            out.push({ where: 'openSettingsDialog merge', keys: node.right.properties.map((p) => (p.key ? p.key.name || p.key.value : null)).filter(Boolean), spread: node.right.properties.some((p) => p.type === 'SpreadElement'), line: lineOf(node) });
        }
    });
    return out;
}

// SPEC-ROWS.csv join: which predicate rows name each pushed flag.
function specRowsArgMap() {
    const fs = require('fs');
    const lines = fs.readFileSync(SPEC_ROWS, 'utf8').trim().split(/\r?\n/);
    const header = lines[0].split(',');
    const idx = (name) => header.indexOf(name);
    const byFlag = {};
    let guardNamed = 0;
    for (const line of lines.slice(1)) {
        const cells = splitCsv(line);
        const targets = cells[idx('targets')] || '';
        const row = { row_id: cells[0], file: cells[1], line: Number(cells[2]), kind: cells[4], code_snippet: cells[5] };
        let hit = false;
        for (const target of targets.split(';')) {
            const m = /^args\.push:(--?[\w-]+)$/.exec(target);
            if (!m) continue;
            (byFlag[m[1]] = byFlag[m[1]] || []).push(row);
            hit = true;
        }
        if (hit) guardNamed += 1;
    }
    return {
        byFlag,
        note: `SPEC-ROWS.csv rows whose targets name args.push:<flag> supply the predicate per flag (${guardNamed} guarded push sites); flags with no such row are the always-appended ones`,
    };
}

function splitCsv(line) {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted; continue; }
        if (ch === ',' && !quoted) { out.push(cur); cur = ''; continue; }
        cur += ch;
    }
    out.push(cur);
    return out;
}

function unique(list) { return [...new Set(list)]; }

main();
