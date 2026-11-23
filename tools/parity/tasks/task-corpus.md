# TASK: real-state corpus loader + PATH-MAP (parity harness)

Repo: C:/projects/Cline-demo (Windows 10, git-bash, node v24).
FIRST read C:/projects/Cline-demo/plan.md (§2 Phase 1 item 5 and ALL of §9A) and AGENTS.md.
Corpus = migration-resources/llamaCppConfigs.txt and llamaCppSettings.txt (gitignored, read-only; NEVER edit; it contains personal absolute paths that must NEVER appear in committed outputs).
Parse convention: line 1 of each file is the literal localStorage key name; the JSON begins at the FIRST '{'.

WRITE these files (do NOT git commit):
1. tools/parity/load-corpus.js — CommonJS module + CLI:
- loadCorpus(dir) -> {configsKey, configs, settingsKey, settings} (configs = the parsed object keyed by config name; preserve key insertion order). Fail LOUDLY (clear message, exit non-zero) if corpus absent/malformed — silent fallbacks are forbidden.
- buildPathMap(configs, settings): enumerate every distinct absolute path prefix across ALL string values (serverPath, modelPath, draftModelPath, chatTemplateFile, modelsDirectory — inspect the real data; don't hardcode key names blindly). Produce fixtures/PATH-MAP.json:
  * map each distinct exe (serverPath value; ~20 expected) to ONE token "FIXTURE_ROOT/bin/fake-llama-server.cmd"
  * map each model root (e.g. D:\models\ and any others found) to "FIXTURE_ROOT/models/..." preserving relative substructure under the root
  * every entry stores originalsSha256 = sha256 of the ORIGINAL string (provenance for real-path mode)
  * also write fixtures/corpus/.pathmap-local.json (gitignored path) holding the reverse map with originals stored BASE64-encoded (local tooling only; needed for un-remap and real-path mode)
  * deterministic: sorted keys; prefix match longest-first; backslash-AND-forward-slash input forms both remapped; output tokens use forward slashes.
- remapString(s, map), remapConfig(obj, map) (deep, strings only).
- CLI: --stats prints: total configs (expect 48), distinct key-set histogram (expect 9 distinct), per-orphan-key counts (mlock,noMmap,ndio,dio,draftMin,draftMax,draftPMin,disableReasoning), repeatPenalty/presencePenalty number-vs-string counts, configs with mixed-separator paths (\ and / in same value), retired/unexpected enum values per select-ish field (loadMode, speculationType, fastAttention, cacheRam, ctkv...inspect real values vs what index.html <option>s offer — read index.html to know current options), distinct exe paths count, distinct model roots.
  --emit writes fixtures/corpus/configs.remapped.json (array of {name, config} in original key order; values remapped), fixtures/corpus/settings.remapped.json, fixtures/PATH-MAP.json, and updates .pathmap-local.json. Key insertion order must survive (JSON.parse + plain stringify does this naturally; assert it).
2. tools/parity/selftest-corpus.js — asserts: 48 configs; committed outputs contain NO 'D:\\' , 'C:\\Users' , 'C:\\projects' , nor the Windows username substring; every remapped string maps back to its original via .pathmap-local.json (sha256-verified); stringify(parse(stringify(cfg))) === stringify(cfg) for all 48 (byte-stable key order); --stats numbers match independent recount inside the selftest. Run until green.
3. Append to .gitignore (one line): fixtures/corpus/.pathmap-local.json

Final report: the stats found and ANY deviation from plan §9A claims (48 configs / 9 key sets / 36 models / 20 exes / orphan-key and type-drift counts / mixed-separator 11 / Q17's 15 disableReasoning-no-reasoning configs / Q21's trailing-\undefined path). Report truth, not plan claims.
