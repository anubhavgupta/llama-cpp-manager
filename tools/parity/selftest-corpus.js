#!/usr/bin/env node
'use strict';
// Self-test for tools/parity/load-corpus.js and the committed corpus artifacts.
// The recount here is deliberately independent of load-corpus.js: it re-parses the corpus,
// re-derives the field metadata from index.html, and re-counts the corpus statistics itself,
// so a wrong helper in the loader cannot certify itself (C4/C5).

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const loader = require('./load-corpus.js');

const REPO = path.resolve(__dirname, '..', '..');
const CORPUS_DIR = path.join(REPO, 'migration-resources');
const CONFIGS_TXT = path.join(CORPUS_DIR, 'llamaCppConfigs.txt');
const SETTINGS_TXT = path.join(CORPUS_DIR, 'llamaCppSettings.txt');
const HTML = path.join(REPO, 'public', 'index.html');
const PATH_MAP = path.join(REPO, 'fixtures', 'PATH-MAP.json');
const CONFIGS_JSON = path.join(REPO, 'fixtures', 'corpus', 'configs.remapped.json');
const SETTINGS_JSON = path.join(REPO, 'fixtures', 'corpus', 'settings.remapped.json');
const LOCAL_MAP = path.join(REPO, 'fixtures', 'corpus', '.pathmap-local.json');
const COMMITTED = [PATH_MAP, CONFIGS_JSON, SETTINGS_JSON];

const BS = String.fromCharCode(92);
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const isAbs = (v) => typeof v === 'string' && /^[A-Za-z]:[\\/]/.test(v);

const failures = [];
let checks = 0;
function ok(condition, label, detail) {
  checks += 1;
  if (!condition) failures.push(label + (detail === undefined ? '' : ' — ' + detail));
}
function equal(actual, expected, label) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(same, label, same ? undefined : 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}

// --- independent corpus parse ---------------------------------------------

function parseCorpus(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const key = raw.slice(0, raw.search(/[\r\n]/)).trim();
  const value = JSON.parse(raw.slice(raw.indexOf('{')));
  return { key, value };
}

const corpusConfigs = parseCorpus(CONFIGS_TXT);
const corpusSettings = parseCorpus(SETTINGS_TXT);
const names = Object.keys(corpusConfigs.value);
const configs = corpusConfigs.value;

// 1. corpus shape
equal(names.length, 48, 'corpus config count is 48');
equal(corpusConfigs.key, 'llamaCppConfigs', 'configs file line 1 is the localStorage key');
equal(corpusSettings.key, 'llamaCppSettings', 'settings file line 1 is the localStorage key');

// 2. committed outputs carry no personal paths
const forbidden = ['D:' + BS, 'C:' + BS + 'Users', 'C:' + BS + 'projects', 'D:/', 'C:/Users', 'C:/projects'];
try {
  const user = os.userInfo().username;
  if (user && user.length >= 3) forbidden.push(user);
} catch {
  failures.push('could not read the local username to check for leaks');
}
for (const file of COMMITTED) {
  ok(fs.existsSync(file), 'committed artifact exists: ' + path.relative(REPO, file));
  const text = fs.readFileSync(file, 'utf8');
  for (const needle of forbidden) {
    ok(!text.toLowerCase().includes(needle.toLowerCase()),
      path.relative(REPO, file) + ' contains no ' + JSON.stringify(needle));
  }
  ok(!/[A-Za-z]:[\\/]/.test(text), path.relative(REPO, file) + ' contains no absolute drive path');
}
let ignored = '';
try {
  ignored = execFileSync('git', ['check-ignore', '--verbose', path.relative(REPO, LOCAL_MAP)],
    { cwd: REPO, encoding: 'utf8' }).trim();
} catch {
  ignored = '';
}
ok(ignored.includes('.gitignore'), 'fixtures/corpus/.pathmap-local.json is gitignored',
  ignored || 'not ignored');

// 3. remapped strings map back to their originals, sha256-verified
const localMap = JSON.parse(fs.readFileSync(LOCAL_MAP, 'utf8'));
const emittedConfigs = JSON.parse(fs.readFileSync(CONFIGS_JSON, 'utf8'));
const emittedSettings = JSON.parse(fs.readFileSync(SETTINGS_JSON, 'utf8'));

let stringsChecked = 0;
let pathStringsChecked = 0;
function recover(remapped, original, trail) {
  try {
    return loader.unmapString(remapped, localMap, sha(original));
  } catch (err) {
    ok(false, 'un-remap fails at ' + trail, err.message);
    return null;
  }
}
function verifyStrings(original, remapped, trail) {
  if (typeof original === 'string') {
    stringsChecked += 1;
    if (remapped === undefined) {
      ok(false, 'no remapped value at ' + trail);
      return;
    }
    if (isAbs(original)) {
      pathStringsChecked += 1;
      ok(recover(remapped, original, trail) === original, 'un-remap is byte-exact at ' + trail);
    } else {
      ok(remapped === original, 'non-path string untouched at ' + trail);
    }
    return;
  }
  if (Array.isArray(original)) {
    original.forEach((item, i) => verifyStrings(item, Array.isArray(remapped) ? remapped[i] : undefined, trail + '/' + i));
    return;
  }
  if (original && typeof original === 'object') {
    equal(Object.keys(remapped || {}), Object.keys(original), 'same keys at ' + trail);
    for (const key of Object.keys(original)) {
      verifyStrings(original[key], remapped ? remapped[key] : undefined, trail + '/' + key);
    }
  }
}
equal(emittedSettings, loader.remapConfig(corpusSettings.value, loader.buildPathMap(configs, corpusSettings.value)),
  'settings.remapped.json matches a fresh remap');
verifyStrings(corpusSettings.value, emittedSettings, 'settings');
for (let i = 0; i < names.length; i += 1) {
  verifyStrings(configs[names[i]], emittedConfigs[i] ? emittedConfigs[i].config : undefined, names[i]);
}
ok(stringsChecked > 400, 'walked every corpus string', 'checked ' + stringsChecked);
ok(pathStringsChecked >= 90, 'walked every corpus path string', 'checked ' + pathStringsChecked);

// PATH-MAP provenance: every committed entry hash is the sha256 of an original behind its token
const pathMap = JSON.parse(fs.readFileSync(PATH_MAP, 'utf8'));
equal(pathMap.entries.map((e) => e.originalsSha256), [...pathMap.entries].map((e) => e.originalsSha256).sort(),
  'PATH-MAP entries are sorted by originalsSha256');
equal(pathMap.entries.length, pathMap.counts.entries, 'PATH-MAP counts match its entries');
for (const entry of pathMap.entries) {
  const candidates = localMap.byToken[entry.token] || [];
  const hit = candidates.filter((c) => c.originalsSha256 === entry.originalsSha256);
  ok(hit.length === 1, 'PATH-MAP entry ' + entry.originalsSha256.slice(0, 12) + ' resolves to exactly one original',
    hit.length + ' candidates for ' + entry.token);
}

// exes collapse onto one token, model paths stay injective
const emittedPaths = [];
names.forEach((name, i) => {
  for (const key of Object.keys(configs[name])) {
    if (isAbs(configs[name][key])) emittedPaths.push([key, configs[name][key], emittedConfigs[i].config[key]]);
  }
});
const exeOriginals = new Set(emittedPaths.filter(([, o]) => /\.exe$/i.test(o)).map(([, o]) => o));
const exeRemapped = new Set(emittedPaths.filter(([, o]) => /\.exe$/i.test(o)).map(([, , r]) => r));
equal(exeRemapped.size, 1, 'every distinct exe original remaps to one token');
equal([...exeRemapped][0], 'FIXTURE_ROOT/bin/fake-llama-server.cmd', 'exe token is the fake binary');
const modelOriginals = new Set(emittedPaths.filter(([, o]) => !/\.exe$/i.test(o)).map(([, o]) => o));
const modelRemapped = new Set(emittedPaths.filter(([, o]) => !/\.exe$/i.test(o)).map(([, , r]) => r));
equal(modelRemapped.size, modelOriginals.size, 'model path remapping is injective');
const rootTokens = pathMap.entries.filter((e) => e.kind === 'model-root').map((e) => e.token);
equal([...new Set(rootTokens)].sort(), ['FIXTURE_ROOT/models', 'FIXTURE_ROOT/models/lmstudio'],
  'model root tokens');
equal(pathMap.tokens, [...pathMap.tokens].sort(), 'PATH-MAP tokens are sorted');
equal(pathMap.tokens, [...new Set(pathMap.entries.map((e) => e.token))].sort(), 'PATH-MAP tokens are its entries\' tokens');
equal(rootTokens.includes('FIXTURE_ROOT/models'), true, 'the declared modelsDirectory owns FIXTURE_ROOT/models');
for (const r of modelRemapped) ok(r.startsWith('FIXTURE_ROOT/models/'), 'model path is under the fixture models root: ' + r);

// 4. key order is byte-stable, and it survived into the emitted file
let orderChecked = 0;
for (const name of names) {
  const text = JSON.stringify(configs[name]);
  equal(JSON.stringify(JSON.parse(text)), text, 'corpus key order is byte-stable: ' + name);
  const emitted = JSON.stringify(emittedConfigs[names.indexOf(name)].config);
  equal(JSON.stringify(JSON.parse(emitted)), emitted, 'emitted key order is byte-stable: ' + name);
  orderChecked += 1;
}ok(orderChecked === 48, 'all 48 configs checked for byte-stable key order', 'checked ' + orderChecked);
equal(emittedConfigs.map((c) => c.name), names, 'emitted config name order matches corpus insertion order');
for (let i = 0; i < names.length; i += 1) {
  equal(Object.keys(emittedConfigs[i].config), Object.keys(configs[names[i]]),
    'key order preserved for "' + names[i] + '"');
}

// 5. --stats numbers vs an independent recount
const stats = loader.computeStats(loader.loadCorpus(CORPUS_DIR),
  loader.buildPathMap(configs, corpusSettings.value));

equal(stats.totalConfigs, names.length, 'stats total configs');
equal([stats.configsKey, stats.settingsKey], [corpusConfigs.key, corpusSettings.key], 'stats localStorage key names');
const keySets = new Map();
for (const name of names) {
  const sig = Object.keys(configs[name]).sort().join(',');
  keySets.set(sig, (keySets.get(sig) || 0) + 1);
}
equal(stats.distinctKeySets, keySets.size, 'distinct key-set count');
equal(stats.keySets.map((s) => s.configs).sort((a, b) => a - b), [...keySets.values()].sort((a, b) => a - b),
  'key-set histogram');
equal(stats.keySets.map((s) => s.keys.join(',')).sort(), [...keySets.keys()].sort(), 'key-set signatures');
equal(stats.keySets.reduce((a, s) => a + s.configs, 0), names.length, 'key-set histogram sums to the config count');

const html = fs.readFileSync(HTML, 'utf8');
const htmlIds = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]));
const selectOptions = new Map();
for (const m of html.matchAll(/<select[^>]*?\bid=["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/gi)) {
  selectOptions.set(m[1], [...m[2].matchAll(/<option[^>]*?\bvalue=["']([^"']*)["']/gi)].map((o) => o[1]));
}

const corpusKeys = new Set();
for (const name of names) for (const key of Object.keys(configs[name])) corpusKeys.add(key);
const orphanRecount = {};
for (const key of [...corpusKeys].sort()) {
  if (htmlIds.has(key)) continue;
  const count = names.filter((n) => Object.prototype.hasOwnProperty.call(configs[n], key)).length;
  if (count > 0) orphanRecount[key] = count;
}
equal(stats.orphanKeys, orphanRecount, 'orphan-key counts per key');
equal(Object.keys(orphanRecount).sort(),
  ['dio', 'disableReasoning', 'draftMax', 'draftMin', 'draftPMin', 'mlock', 'ndio', 'noMmap'],
  'orphan keys are exactly the 8 plan §9A names');
equal(stats.orphanUnion,
  names.filter((n) => Object.keys(configs[n]).some((k) => orphanRecount[k] !== undefined)).length,
  'orphan-key union (configs with at least one orphan key)');
equal(stats.orphanInstances, Object.values(orphanRecount).reduce((a, b) => a + b, 0), 'orphan-key total instances');
equal(stats.modelRootCount, pathMap.counts.modelRoots, 'model root count matches the PATH-MAP');
for (const field of loader.DYNAMIC_SELECTS) {
  const distinct = new Set(names.filter((n) => Object.prototype.hasOwnProperty.call(configs[n], field))
    .map((n) => String(configs[n][field])));
  equal(stats.dynamicSelects[field] && stats.dynamicSelects[field].distinctValues, distinct.size,
    'distinct saved values for ' + field);
}
ok(Object.values(orphanRecount).every((c) => c <= names.length), 'orphan counts never exceed the config count');

for (const field of ['repeatPenalty', 'presencePenalty']) {
  let number = 0;
  let string = 0;
  for (const name of names) {
    const value = configs[name][field];
    if (typeof value === 'number') number += 1;
    else if (typeof value === 'string') string += 1;
  }
  equal([stats.penaltyTypes[field].number, stats.penaltyTypes[field].string], [number, string],
    field + ' number-vs-string counts');
}

let mixedInstances = 0;
let mixedConfigs = 0;
let mixedValues = 0;
{
  const seenConfigs = new Set();
  const seenValues = new Set();
  const walk = (value) => {
    if (typeof value === 'string') {
      if (value.includes(BS) && value.includes('/')) {
        mixedInstances += 1;
        seenValues.add(value);
      }
      return;
    }
    if (value && typeof value === 'object') for (const key of Object.keys(value)) walk(value[key]);
  };
  for (const name of names) {
    const before = mixedInstances;
    walk(configs[name]);
    if (mixedInstances > before) seenConfigs.add(name);
  }
  mixedConfigs = seenConfigs.size;
  mixedValues = seenValues.size;
}
equal(stats.mixedSeparator.instances, mixedInstances, 'mixed-separator string instances');
equal(stats.mixedSeparator.configs, mixedConfigs, 'mixed-separator configs');
equal(stats.mixedSeparator.values, mixedValues, 'mixed-separator distinct values');

const retiredRecount = {};
for (const field of [...corpusKeys].sort()) {
  if (!selectOptions.has(field) || loader.DYNAMIC_SELECTS.includes(field)) continue;
  const options = selectOptions.get(field);
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(configs[name], field)) continue;
    const value = configs[name][field];
    if (typeof value !== 'string' || !options.includes(value)) {
      retiredRecount[field] = (retiredRecount[field] || 0) + 1;
    }
  }
}
equal(Object.keys(stats.retiredEnumValues).sort(), Object.keys(retiredRecount).sort(),
  'fields with retired/unexpected enum values');
equal(Object.values(stats.retiredEnumValues).reduce((a, f) => a + Object.values(f.values).reduce((x, y) => x + y, 0), 0),
  Object.values(retiredRecount).reduce((a, b) => a + b, 0), 'retired enum value instances');

equal(stats.legacyReasoning.disableReasoningConfigs,
  names.filter((n) => 'disableReasoning' in configs[n]).length, 'legacy disableReasoning config count');
equal(stats.legacyReasoning.disableReasoningWithoutReasoning,
  names.filter((n) => 'disableReasoning' in configs[n] && !('reasoning' in configs[n])).length,
  'legacy disableReasoning configs with no reasoning key (Q17)');

const brokenRecount = [];
for (const name of names) {
  for (const key of Object.keys(configs[name])) {
    const value = configs[name][key];
    if (isAbs(value) && /undefined$/i.test(value)) brokenRecount.push(name);
  }
}
equal(stats.brokenPaths.length, brokenRecount.length, 'broken-path (trailing undefined) config count (Q21)');

const exeRecount = new Set();
for (const name of names) {
  for (const key of Object.keys(configs[name])) {
    const value = configs[name][key];
    if (isAbs(value) && /\.exe$/i.test(value)) exeRecount.add(value);
  }
}
equal(stats.distinctExePaths, exeRecount.size, 'distinct exe path count');
equal(pathMap.counts.distinctExePaths, exeRecount.size, 'PATH-MAP exe entry count');

// 6. the CLI runs clean and fails loudly on a missing corpus
const cli = path.join(__dirname, 'load-corpus.js');
const cliStats = execFileSync(process.execPath, [cli, '--stats', CORPUS_DIR], { encoding: 'utf8' });
ok(cliStats.includes('total configs') && cliStats.includes(String(names.length)),
  'CLI --stats reports the config count');
ok(cliStats.includes('distinct key sets'), 'CLI --stats reports the key-set count');
let loudFailure = null;
try {
  execFileSync(process.execPath, [cli, '--stats', path.join(REPO, 'no-such-corpus-dir')],
    { encoding: 'utf8', stdio: 'pipe' });
} catch (err) {
  loudFailure = err;
}
ok(loudFailure !== null, 'CLI exits non-zero when the corpus is absent (no silent fallback)');
if (loudFailure) {
  ok(/corpus file missing or unreadable/.test(String(loudFailure.stderr)),
    'CLI explains why the corpus load failed');
}

console.log(checks + ' checks, ' + failures.length + ' failures');
for (const failure of failures) console.log('FAIL ' + failure);
if (failures.length > 0) {
  console.log('selftest-corpus: RED');
  process.exitCode = 1;
} else {
  console.log('selftest-corpus: GREEN');
}
