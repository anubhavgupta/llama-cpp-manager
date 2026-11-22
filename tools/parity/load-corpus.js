#!/usr/bin/env node
'use strict';
// Real-state corpus loader + PATH-MAP builder (plan §2 Phase 1 item 5, plan §9A).
//
// Two artifacts on purpose:
//   fixtures/PATH-MAP.json                 committed — fixture tokens + originalsSha256 only
//   fixtures/corpus/.pathmap-local.json    gitignored — the real originals, base64-encoded
// The corpus holds personal absolute paths, so no committed output may contain them.
// originalsSha256 is the provenance link from a committed token back to the local original:
// §9A real-path mode needs the exact original string, separator style included.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_CORPUS_DIR = path.join(REPO_ROOT, 'migration-resources');
const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures');
const CORPUS_OUT_DIR = path.join(FIXTURES_DIR, 'corpus');
const PATH_MAP_OUT = path.join(FIXTURES_DIR, 'PATH-MAP.json');
const CONFIGS_OUT = path.join(CORPUS_OUT_DIR, 'configs.remapped.json');
const SETTINGS_OUT = path.join(CORPUS_OUT_DIR, 'settings.remapped.json');
const LOCAL_MAP_OUT = path.join(CORPUS_OUT_DIR, '.pathmap-local.json');
const INDEX_HTML = path.join(REPO_ROOT, 'public', 'index.html');

const CONFIGS_FILE = 'llamaCppConfigs.txt';
const SETTINGS_FILE = 'llamaCppSettings.txt';

const TOKEN_ROOT = 'FIXTURE_ROOT';
const EXE_TOKEN = TOKEN_ROOT + '/bin/fake-llama-server.cmd';
const MODELS_TOKEN_ROOT = TOKEN_ROOT + '/models';

// modelPath/draftModelPath are <select>s whose options come from /models at runtime,
// so a saved value cannot be judged against static <option> lists.
const DYNAMIC_SELECTS = ['modelPath', 'draftModelPath'];

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function fail(message) {
  throw new Error(message);
}

// --- corpus parsing -------------------------------------------------------

// Parse convention (plan §9A): line 1 is the literal localStorage key name, JSON starts at
// the first '{'. Silent fallbacks are forbidden — every failure here is fatal.
function readCorpusFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    fail(`corpus file missing or unreadable: ${filePath} (${err.code || err.message}). ` +
      'Capture must mark corpus-dependent ledger rows blocked, never pass.');
  }
  if (!raw.trim()) fail(`corpus file is empty: ${filePath}`);
  const lineEnd = raw.search(/[\r\n]/);
  if (lineEnd <= 0) fail(`corpus file ${filePath}: line 1 must be the literal localStorage key name`);
  const key = raw.slice(0, lineEnd).trim();
  if (!key) fail(`corpus file ${filePath}: line 1 (localStorage key name) is blank`);
  const jsonStart = raw.indexOf('{');
  if (jsonStart < 0) fail(`corpus file ${filePath}: no JSON object found (no '{' present)`);
  let value;
  try {
    value = JSON.parse(raw.slice(jsonStart));
  } catch (err) {
    fail(`corpus file ${filePath}: malformed JSON — ${err.message}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`corpus file ${filePath}: top-level JSON must be an object`);
  }
  return { key, value, sha256: sha256(raw) };
}

function loadCorpus(dir = DEFAULT_CORPUS_DIR) {
  const configs = readCorpusFile(path.join(dir, CONFIGS_FILE));
  const settings = readCorpusFile(path.join(dir, SETTINGS_FILE));
  if (Object.keys(configs.value).length === 0) fail(`corpus ${CONFIGS_FILE} contains zero configs`);
  if (Object.keys(settings.value).length === 0) fail(`corpus ${SETTINGS_FILE} contains zero keys`);
  return {
    dir,
    configsKey: configs.key,
    configs: configs.value,
    settingsKey: settings.key,
    settings: settings.value,
    corpusSha256: { configs: configs.sha256, settings: settings.sha256 }
  };
}

// --- absolute path helpers -------------------------------------------------

const normPath = (s) => s.split('\\').join('/');
const stripTrailing = (s) => s.replace(/\/+$/, '');
const isAbsPath = (v) => typeof v === 'string' && /^[A-Za-z]:[\\/]/.test(v);
const isExePath = (s) => /\.exe$/i.test(stripTrailing(normPath(s)));
const parentDir = (s) => {
  const t = stripTrailing(normPath(s));
  return t.lastIndexOf('/') > 0 ? t.slice(0, t.lastIndexOf('/')) : t;
};

function forEachString(value, visit, trail) {
  const at = trail === undefined ? '' : trail;
  if (typeof value === 'string') {
    visit(at, value);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => forEachString(item, visit, at + '/' + i));
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) forEachString(value[key], visit, at + '/' + key);
  }
}

// --- leak gate -------------------------------------------------------------

// Anything that must never reach a committed file. The username is taken from the machine,
// plus every segment that appears directly after a `\Users\` prefix in the corpus originals.
function bannedSubstrings(originals) {
  const banned = ['D:\\', 'D:/', 'C:\\Users', 'C:/Users', 'C:\\projects', 'C:/projects'];
  const localUser = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return '';
    }
  })();
  if (localUser && localUser.length >= 3) banned.push(localUser);
  for (const original of originals || []) {
    const m = normPath(original).match(/^([A-Za-z]:\/Users\/[^/]+)/i);
    if (m) banned.push(m[1].split('/').pop());
  }
  return [...new Set(banned.filter((b) => b.length >= 3))];
}

function findLeaks(text, banned) {
  const list = banned || bannedSubstrings();
  const leaks = [];
  const lower = text.toLowerCase();
  for (const needle of list) if (lower.includes(needle.toLowerCase())) leaks.push(needle);
  for (const leftover of text.match(/\b[A-Za-z]:[\\/]/g) || []) leaks.push(leftover);
  return [...new Set(leaks)];
}

// --- PATH-MAP --------------------------------------------------------------

function sanitizeSegment(segment) {
  const cleaned = segment.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.\-]+/, '').replace(/[.\-]+$/, '');
  return cleaned || 'root';
}

function remapUnder(value, normKey, token) {
  const norm = normPath(value);
  if (norm === normKey) return token;
  if (norm.startsWith(normKey + '/')) return token + norm.slice(normKey.length);
  return null;
}

function remapString(s, map) {
  for (const matcher of map.matchers) {
    const remapped = remapUnder(s, matcher.normKey, matcher.token);
    if (remapped !== null) return remapped;
  }
  return s;
}

function remapConfig(value, map) {
  if (typeof value === 'string') return remapString(value, map);
  if (Array.isArray(value)) return value.map((item) => remapConfig(item, map));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = remapConfig(value[key], map);
    return out;
  }
  return value;
}

function buildPathMap(configs, settings) {
  const observed = new Map();
  const collect = (source) => forEachString(source, (trail, s) => {
    if (isAbsPath(s) && !observed.has(s)) observed.set(s, trail || '(root)');
  });
  collect(configs);
  collect(settings);
  if (observed.size === 0) fail('no absolute paths in the corpus — refusing to build an empty PATH-MAP');

  const originals = [...observed.keys()];
  const banned = bannedSubstrings(originals);
  const exes = originals.filter(isExePath).sort();
  const modelValues = originals.filter((v) => !isExePath(v)).sort();

  const entries = [];
  const tokenOwner = new Map();

  function claimModelToken(token, normKey) {
    const owner = tokenOwner.get(token);
    if (owner === undefined) return token;
    if (owner === normKey) return token;
    const alt = token + '-' + sha256(normKey).slice(0, 8);
    if (tokenOwner.has(alt)) fail(`PATH-MAP token collision for ${normKey}`);
    return alt;
  }

  function addRoot(original, normKey, token) {
    tokenOwner.set(token, normKey);
    entries.push({ original, normKey, token, kind: 'model-root' });
  }

  // The models directory is the one root the app itself declares, so it owns the plain token and
  // every model path under it keeps its substructure: FIXTURE_ROOT/models/<rel path>.
  const declaredRoot = isAbsPath(settings.modelsDirectory)
    ? stripTrailing(normPath(settings.modelsDirectory))
    : null;
  if (declaredRoot) {
    addRoot(settings.modelsDirectory, declaredRoot, claimModelToken(MODELS_TOKEN_ROOT, declaredRoot));
  }

  const covered = (value) => entries.some((e) => remapUnder(value, e.normKey, e.token) !== null);

  for (const value of modelValues) {
    if (covered(value)) continue;
    const segments = parentDir(value).split('/');
    let placed = false;
    for (let depth = 2; depth <= segments.length; depth++) {
      const normKey = segments.slice(0, depth).join('/');
      const token = claimModelToken(MODELS_TOKEN_ROOT + '/' + sanitizeSegment(segments[depth - 1]), normKey);
      const remapped = remapUnder(value, normKey, token);
      if (findLeaks(remapped, banned).length > 0) continue;
      // normPath preserves length, so the raw prefix keeps this root's original separator style.
      addRoot(value.slice(0, normKey.length), normKey, token);
      placed = true;
      break;
    }
    if (!placed) {
      fail(`cannot derive a leak-free fixture root for the path at ${observed.get(value)}; ` +
        'add a root rule to buildPathMap instead of committing a real path');
    }
  }

  // Every exe collapses onto the one fake binary: that collapse is what makes argv comparison
  // meaningful in remapped mode, so these entries deliberately share a token.
  for (const exe of exes) {
    entries.push({ original: exe, normKey: stripTrailing(normPath(exe)), token: EXE_TOKEN, kind: 'exe' });
  }

  const matchers = entries
    .map((e) => ({ normKey: e.normKey, token: e.token }))
    .sort((a, b) => b.normKey.length - a.normKey.length || (a.normKey < b.normKey ? -1 : 1));

  // A leftover drive prefix means some real path survived remapping: never emit it.
  const values = originals.sort().map((original) => {
    const remapped = remapString(original, { matchers });
    const leaks = findLeaks(remapped, banned);
    if (leaks.length > 0) {
      fail(`PATH-MAP leaves ${leaks.join(', ')} in the remapped value for ${observed.get(original)}; ` +
        'the corpus would leak personal paths into committed fixtures');
    }
    return { original, originalSha256: sha256(original), remapped, kind: isExePath(original) ? 'exe' : 'model' };
  });

  return {
    version: 1,
    tokenRoot: TOKEN_ROOT,
    exeToken: EXE_TOKEN,
    declaredRoot,
    matchers,
    entries: entries.slice().sort((a, b) => (a.normKey < b.normKey ? -1 : 1)),
    values,
    banned
  };
}

function sortedObject(entries) {
  const out = {};
  for (const [key, value] of entries) out[key] = value;
  return out;
}

function serializePathMap(map, corpusSha256) {
  return {
    version: map.version,
    tokenRoot: map.tokenRoot,
    exeToken: map.exeToken,
    generatedBy: 'node tools/parity/load-corpus.js --emit',
    note: 'Fixture tokens only. The real originals live in fixtures/corpus/.pathmap-local.json ' +
      '(gitignored, base64) on the fixture machine; originalsSha256 links each committed token back ' +
      'to its original for §9A real-path mode.',
    corpusSha256,
    counts: {
      entries: map.entries.length,
      distinctExePaths: map.entries.filter((e) => e.kind === 'exe').length,
      modelRoots: map.entries.filter((e) => e.kind === 'model-root').length
    },
    tokens: [...new Set(map.entries.map((e) => e.token))].sort(),
    entries: map.entries
      .map((e) => ({ originalsSha256: sha256(e.original), token: e.token, kind: e.kind }))
      .sort((a, b) => (a.originalsSha256 < b.originalsSha256 ? -1 : 1))
  };
}

function serializeLocalMap(map) {
  const group = (keyFn, items) => {
    const acc = new Map();
    for (const item of items) {
      const key = keyFn(item);
      if (!acc.has(key)) acc.set(key, []);
      acc.get(key).push({ originalB64: Buffer.from(item.original, 'utf8').toString('base64'), originalsSha256: item.originalSha256 });
    }
    for (const list of acc.values()) list.sort((a, b) => (a.originalsSha256 < b.originalsSha256 ? -1 : 1));
    return sortedObject([...acc.keys()].sort().map((k) => [k, acc.get(k)]));
  };
  return {
    version: map.version,
    tokenRoot: map.tokenRoot,
    note: 'LOCAL ONLY (gitignored). Reverse PATH-MAP with originals base64-encoded so git and CI ' +
      'greps never see a personal path; needed for un-remap and real-path mode.',
    byToken: group((e) => e.token, map.entries.map((e) => ({
      token: e.token,
      original: e.original,
      originalSha256: sha256(e.original)
    }))),
    byValue: group((v) => v.remapped, map.values)
  };
}

function pickOriginal(candidates, expectSha256, label) {
  const hits = expectSha256 ? candidates.filter((c) => c.originalsSha256 === expectSha256) : candidates;
  if (hits.length === 0) fail(`no original in .pathmap-local.json hashes to ${expectSha256} (for ${label})`);
  if (hits.length > 1) fail(`ambiguous un-remap for ${label}: ${hits.length} candidates, sha256 required`);
  return Buffer.from(hits[0].originalB64, 'base64').toString('utf8');
}

// Exact un-remap of a corpus string. Multiple originals share a token (every exe collapses onto
// the fake binary), so callers that know the source string pass its sha256 to disambiguate.
// Strings the corpus never contained fall back to token-prefix substitution, which is
// separator-normalized and therefore cannot be sha256-matched against a stored original.
function unmapString(remapped, localMap, expectSha256) {
  if (typeof remapped !== 'string') fail('unmapString needs the remapped string, got ' + typeof remapped);
  if (localMap.byValue[remapped]) return pickOriginal(localMap.byValue[remapped], expectSha256, remapped);
  const tokens = Object.keys(localMap.byToken)
    .filter((token) => remapped === token || remapped.startsWith(token + '/'))
    .sort((a, b) => b.length - a.length);
  if (tokens.length === 0) fail(`no PATH-MAP token matches ${remapped}`);
  const original = pickOriginal(localMap.byToken[tokens[0]], expectSha256, remapped);
  return original.replace(/[\\/]+$/, '') + remapped.slice(tokens[0].length);
}

// --- index.html field metadata ---------------------------------------------

function readHtmlFields(htmlPath = INDEX_HTML) {
  let html;
  try {
    html = fs.readFileSync(htmlPath, 'utf8');
  } catch (err) {
    fail(`cannot read ${htmlPath} (${err.code || err.message}) — the current field set and <option> ` +
      'lists are needed to classify corpus drift');
  }
  const selects = new Map();
  const selectRe = /<select\b[^>]*\bid=["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/gi;
  for (const match of html.matchAll(selectRe)) {
    const options = [...match[2].matchAll(/<option\b[^>]*\bvalue=["']([^"']*)["']/gi)].map((o) => o[1]);
    selects.set(match[1], options);
  }
  const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/gi)].map((m) => m[1]));
  return { selects, ids };
}

// --- stats -----------------------------------------------------------------

function computeStats(corpus, map, html = readHtmlFields()) {
  const configs = corpus.configs;
  const names = Object.keys(configs);

  const sets = new Map();
  for (const name of names) {
    const signature = Object.keys(configs[name]).sort().join(',');
    sets.set(signature, (sets.get(signature) || 0) + 1);
  }
  const keySets = [...sets.entries()]
    .map(([signature, count]) => ({ keyCount: signature.split(',').length, configs: count, keys: signature.split(',') }))
    .sort((a, b) => b.configs - a.configs || b.keyCount - a.keyCount);

  const corpusKeys = new Set();
  for (const name of names) for (const key of Object.keys(configs[name])) corpusKeys.add(key);
  const orphanKeys = sortedObject([...corpusKeys]
    .filter((key) => !html.ids.has(key))
    .sort()
    .map((key) => [key, names.filter((n) => Object.prototype.hasOwnProperty.call(configs[n], key)).length]));
  const orphanUnion = names.filter((n) => Object.keys(configs[n]).some((k) => orphanKeys[k] !== undefined)).length;
  const orphanInstances = Object.values(orphanKeys).reduce((a, b) => a + b, 0);

  const penaltyTypes = {};
  for (const field of ['repeatPenalty', 'presencePenalty']) {
    const census = { number: 0, string: 0, other: 0, absent: 0, zeroForms: {} };
    for (const name of names) {
      if (!Object.prototype.hasOwnProperty.call(configs[name], field)) {
        census.absent += 1;
        continue;
      }
      const value = configs[name][field];
      census[typeof value === 'number' || typeof value === 'string' ? typeof value : 'other'] += 1;
      if (String(value) === '0' || Number(value) === 0) {
        const form = typeof value + ':' + JSON.stringify(value);
        census.zeroForms[form] = (census.zeroForms[form] || 0) + 1;
      }
    }
    penaltyTypes[field] = census;
  }

  const mixedSeparator = { values: 0, configs: 0, instances: 0, distinct: [] };
  const mixedConfigs = new Set();
  for (const name of names) {
    forEachString(configs[name], (trail, s) => {
      if (s.includes('\\') && s.includes('/')) {
        mixedSeparator.instances += 1;
        mixedConfigs.add(name);
        if (!mixedSeparator.distinct.includes(s)) mixedSeparator.distinct.push(s);
      }
    });
  }
  mixedSeparator.values = mixedSeparator.distinct.length;
  mixedSeparator.configs = mixedConfigs.size;

  const retiredEnumValues = {};
  const dynamicSelects = {};
  for (const field of [...corpusKeys].sort()) {
    if (!html.selects.has(field)) continue;
    const options = html.selects.get(field);
    if (DYNAMIC_SELECTS.includes(field)) {
      const distinct = new Set();
      for (const name of names) if (configs[name][field] !== undefined) distinct.add(String(configs[name][field]));
      dynamicSelects[field] = { distinctValues: distinct.size, note: 'options come from /models at runtime' };
      continue;
    }
    const unexpected = {};
    for (const name of names) {
      if (!Object.prototype.hasOwnProperty.call(configs[name], field)) continue;
      const value = configs[name][field];
      if (typeof value === 'string' && !options.includes(value)) {
        const form = value === '' ? '(blank)' : typeof value + ':' + JSON.stringify(value);
        unexpected[form] = (unexpected[form] || 0) + 1;
      } else if (typeof value !== 'string') {
        const form = 'non-string ' + typeof value + ':' + JSON.stringify(value);
        unexpected[form] = (unexpected[form] || 0) + 1;
      }
    }
    if (Object.keys(unexpected).length > 0) {
      retiredEnumValues[field] = { options, values: sortedObject(Object.keys(unexpected).sort().map((k) => [k, unexpected[k]])) };
    }
  }

  const legacyReasoning = { disableReasoningConfigs: 0, disableReasoningWithoutReasoning: 0 };
  for (const name of names) {
    const config = configs[name];
    if (Object.prototype.hasOwnProperty.call(config, 'disableReasoning')) {
      legacyReasoning.disableReasoningConfigs += 1;
      if (!Object.prototype.hasOwnProperty.call(config, 'reasoning')) legacyReasoning.disableReasoningWithoutReasoning += 1;
    }
  }

  const brokenPaths = [];
  for (const name of names) {
    forEachString(configs[name], (trail, s) => {
      if (isAbsPath(s) && /undefined$/i.test(stripTrailing(s))) brokenPaths.push(name + trail);
    });
  }

  const modelRoots = map.entries.filter((e) => e.kind === 'model-root');
  return {
    totalConfigs: names.length,
    distinctKeySets: keySets.length,
    keySets,
    orphanKeys,
    orphanUnion,
    orphanInstances,
    penaltyTypes,
    mixedSeparator: { values: mixedSeparator.values, configs: mixedSeparator.configs, instances: mixedSeparator.instances },
    retiredEnumValues,
    dynamicSelects,
    legacyReasoning,
    brokenPaths,
    distinctExePaths: map.entries.filter((e) => e.kind === 'exe').length,
    modelRootCount: modelRoots.length,
    modelRootTokens: modelRoots.map((e) => e.token).sort(),
    corpusSha256: corpus.corpusSha256,
    configsKey: corpus.configsKey,
    settingsKey: corpus.settingsKey
  };
}

function formatStats(stats) {
  const lines = [];
  const field = (label, value) => lines.push(String(label).padEnd(42) + value);
  lines.push('corpus key names                    localStorage: ' + stats.configsKey + ' / ' + stats.settingsKey);
  lines.push('corpus sha256                       configs ' + stats.corpusSha256.configs.slice(0, 16) +
    ' / settings ' + stats.corpusSha256.settings.slice(0, 16));
  field('total configs', stats.totalConfigs);
  field('distinct key sets', stats.distinctKeySets);
  lines.push('key set histogram                   (configs x keys)');
  for (const set of stats.keySets) lines.push('  ' + String(set.configs).padStart(3) + ' x ' + set.keyCount + ' keys');
  lines.push('orphan keys (no element in index.html)');
  for (const [key, count] of Object.entries(stats.orphanKeys)) lines.push('  ' + key.padEnd(20) + count);
  field('orphan keys: union of configs', stats.orphanUnion);
  field('orphan keys: total instances', stats.orphanInstances);
  for (const [fieldName, census] of Object.entries(stats.penaltyTypes)) {
    field(fieldName + ' number/string/other/absent',
      census.number + '/' + census.string + '/' + census.other + '/' + census.absent);
    field('  ' + fieldName + ' zero forms', JSON.stringify(census.zeroForms));
  }
  field('mixed-separator strings', stats.mixedSeparator.instances + ' instances / ' +
    stats.mixedSeparator.configs + ' configs / ' + stats.mixedSeparator.values + ' distinct values');
  lines.push('retired / unexpected enum values (vs index.html <option>s)');
  const retiredFields = Object.keys(stats.retiredEnumValues);
  if (retiredFields.length === 0) lines.push('  none');
  for (const name of retiredFields) {
    lines.push('  ' + name + '  options=' + stats.retiredEnumValues[name].options.join('|'));
    for (const [value, count] of Object.entries(stats.retiredEnumValues[name].values)) {
      lines.push('    ' + value.padEnd(24) + count);
    }
  }
  for (const [name, info] of Object.entries(stats.dynamicSelects)) {
    field('distinct saved values: ' + name, info.distinctValues + '  (' + info.note + ')');
  }
  field('legacy disableReasoning', stats.legacyReasoning.disableReasoningConfigs + ' configs / ' +
    stats.legacyReasoning.disableReasoningWithoutReasoning + ' without a reasoning key');
  field('broken-but-truthy paths (…undefined)', stats.brokenPaths.length + ' configs: ' + stats.brokenPaths.join(', '));
  field('distinct exe paths', stats.distinctExePaths + ' -> ' + EXE_TOKEN);
  field('distinct model roots', stats.modelRootCount + ' -> ' + stats.modelRootTokens.join(', '));
  return lines.join('\n');
}

// --- emit ------------------------------------------------------------------

function writeFileChecked(filePath, text, banned) {
  const leaks = findLeaks(text, banned);
  if (leaks.length > 0) fail(`refusing to write ${filePath}: output would contain ${leaks.join(', ')}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function jsonText(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function emit(corpus, map) {
  const remappedConfigs = Object.keys(corpus.configs).map((name) => ({
    name,
    config: remapConfig(corpus.configs[name], map)
  }));
  const remappedSettings = remapConfig(corpus.settings, map);

  const files = [
    [PATH_MAP_OUT, jsonText(serializePathMap(map, corpus.corpusSha256))],
    [CONFIGS_OUT, jsonText(remappedConfigs)],
    [SETTINGS_OUT, jsonText(remappedSettings)]
  ];
  for (const [filePath, text] of files) writeFileChecked(filePath, text, map.banned);
  // The reverse map is the gitignored file whose job is to hold the originals; base64 keeps it
  // out of casual greps, but the committed-output leak gate deliberately does not apply to it.
  fs.mkdirSync(path.dirname(LOCAL_MAP_OUT), { recursive: true });
  fs.writeFileSync(LOCAL_MAP_OUT, jsonText(serializeLocalMap(map)), 'utf8');

  // Key insertion order is part of the contract (§9 cross-stack trap 6): JSON.parse of the
  // written file must reproduce the same byte-for-byte key order as the corpus.
  const roundTrip = JSON.parse(fs.readFileSync(CONFIGS_OUT, 'utf8'));
  const sourceNames = Object.keys(corpus.configs);
  if (JSON.stringify(roundTrip.map((c) => c.name)) !== JSON.stringify(sourceNames)) {
    fail(CONFIGS_OUT + ': config name order did not survive the round trip');
  }
  for (let i = 0; i < roundTrip.length; i += 1) {
    const sourceKeys = Object.keys(corpus.configs[sourceNames[i]]);
    const emittedKeys = Object.keys(roundTrip[i].config);
    if (JSON.stringify(emittedKeys) !== JSON.stringify(sourceKeys)) {
      fail(`${CONFIGS_OUT}: key order for "${sourceNames[i]}" is ${emittedKeys.join(',')} not ${sourceKeys.join(',')}`);
    }
  }
  return { remappedConfigs, remappedSettings, files: files.map(([f]) => f).concat(LOCAL_MAP_OUT) };
}

// --- CLI -------------------------------------------------------------------

function main(argv) {
  const flags = argv.filter((a) => a.startsWith('--'));
  const positional = argv.filter((a) => !a.startsWith('--'));
  const mode = flags.includes('--emit') ? 'emit' : flags.includes('--stats') ? 'stats' : null;
  if (!mode) {
    process.stderr.write('usage: node tools/parity/load-corpus.js --stats|--emit [corpus-dir]\n');
    return 2;
  }
  const corpus = loadCorpus(positional[0] ? path.resolve(positional[0]) : DEFAULT_CORPUS_DIR);
  const map = buildPathMap(corpus.configs, corpus.settings);
  if (mode === 'emit') {
    const result = emit(corpus, map);
    process.stdout.write('wrote ' + result.files.map((f) => path.relative(REPO_ROOT, f).split('\\').join('/')).join('\nwrote ') + '\n');
    process.stdout.write('PATH-MAP entries: ' + map.entries.length + ' (' + statsSummary(map) + ')\n');
    return 0;
  }
  process.stdout.write(formatStats(computeStats(corpus, map)) + '\n');
  return 0;
}

function statsSummary(map) {
  return map.entries.filter((e) => e.kind === 'exe').length + ' exes, ' +
    map.entries.filter((e) => e.kind === 'model-root').length + ' model roots';
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write('load-corpus: ' + err.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_CORPUS_DIR,
  EXE_TOKEN,
  TOKEN_ROOT,
  DYNAMIC_SELECTS,
  PATH_MAP_OUT,
  CONFIGS_OUT,
  SETTINGS_OUT,
  LOCAL_MAP_OUT,
  loadCorpus,
  buildPathMap,
  remapString,
  remapConfig,
  unmapString,
  computeStats,
  formatStats,
  emit,
  readHtmlFields,
  findLeaks,
  sha256
};
