# Parity Port Plan — llama-cpp-manager
### Two-part, fully autonomous (no human involvement in engineering work)

**Objective:** Re-implement `llama-cpp-manager` in a different technology stack with **bug-for-bug, byte-for-byte user-visible parity**. No scope changes. No bug fixes. No improvements.

**Method:** Part 1 reverse-engineers the legacy app into an executable, self-validating conformance oracle. Part 2 (deferred) builds a candidate until that oracle goes green. Humans do not review, approve, or adjudicate anything except the single irreversible cutover command (§10).

**Oracle:** the legacy app at tag `parity-baseline`. Legacy output is correct by definition.

---

## 0. Governing constraints

| # | Constraint | Consequence |
|---|---|---|
| C1 | No behavior changes, no bug fixes | Every quirk in §8 is a **requirement**, not a defect |
| C2 | "Same from the user's perspective" | Dead code (never reachable from UI) is **out of scope** — not ported, not tested, but recorded |
| C3 | User configs live in `localStorage`, keyed by origin | Candidate must serve on **`http://localhost:7837`** or all existing configs are orphaned |
| C4 | Legacy is the only oracle | Any diff ⇒ the **candidate** is wrong. Never edit a golden/assertion to go green |
| C5 | Fixtures are recorded, never authored | A hand-written fixture encodes a *belief* and passes while wrong |
| C6 | Keep Socket.IO | Its reconnect choreography drives user-visible log lines (`Connected to server for real-time logging`) |
| C7 | No human in the engineering loop | Every judgment is replaced by a machine gate (§3) and a pre-committed tie-break ladder (§4) |
| C8 | Gates are immutable | Thresholds, assertions, fixtures, `AGENTS.md` are hash-pinned; changing them fails the Auditor (§5) |

---

## 1. Why the split point is where it is

Part 1 touches **only the legacy app** and needs **no target-stack decision** — it is all analysis, recording, and harness construction. Part 2 is the only stack-dependent work. Every suite is therefore written black-box, parameterized by env (§6), so **no suite is rewritten when the stack changes** and no stack assumption can leak into a test.

Part 2's job reduces to: *point the existing harness at the candidate and make it green.*

---

## 2. PART 1 — Reverse-engineer + build the oracle
*Legacy-only. Read-only with respect to app behavior. Fully reversible. No stack decision required.*

### Phase 0 — Freeze baseline
1. `git tag parity-baseline <last legacy-only commit>`; `tools/parity/freeze-baseline.sh` writes `fixtures/BASELINE.json` (sha + SHA256 of `server.js`, `public/script.js`, `public/index.html`, `public/styles.css`).
2. Seed `PARITY.md` ledger with all 15 rows from §8, status `baseline-open`.
3. Write `AGENTS.md`: DO-NOT-FIX list, oracle rules C4/C5/C8, tie-break ladder §4, role boundaries §5. Hash-pin it.

**Gate:** hashes committed; every §8 row exists in the ledger.

### Phase 1 — Fakes and recording harness
1. `fake-llama-server.js` — writes exact argv array **and** raw command line to a file; prints startup logs in llama.cpp-like **chunk shapes**; binds `--host/--port`; exits on SIGTERM; knobs: `--exit-code`, slow termination, stderr-only.
2. `fixture-tree.sh` — nested dirs, `mmproj` name variants, spaces + non-ASCII + long paths, unreadable dir, empty dir, missing dir, sibling-dir mmproj (negative).
3. `nvidia-smi-stub` on `PATH`; removable to force the simulated-metrics path.
4. `capture-legacy.sh` → `fixtures/{http,argv,ini,ws,localstorage,screenshots}/`, every file recording the command that produced it; `fixtures/MANIFEST.json` hashes everything.
5. **Ingest the real-state corpus** (§9A) from `migration-resources/` → `fixtures/corpus/`: normalize the `.txt` dumps (first line is the localStorage key name; JSON begins at the first `{`), then derive corpus vectors, the corpus ini golden, and `fixtures/PATH-MAP.json`.

**Gate:** one command regenerates the entire fixture set from legacy; `MANIFEST.json` written and hash-pinned; corpus parses and its derived goldens reproduce on legacy.

### Phase 2 — Pure generators: vectors + goldens + mutation
Two deterministic functions hold most of the risk:
- `buildArgs(fields, settings)` — inline at `script.js:409-650`
- `buildPresetIni(configs, settings, models)` — inline at `script.js:676-870`

1. **Extract** into `legacy/lib/`. **Prove behavior preservation:** re-run pre-refactor live journeys and require byte-identical argv + ini. *Skipping this makes every later green test validate a refactor bug.*
2. **AST predicate inventory** → `SPEC/SPEC-ROWS.csv`: every condition in `buildArgs`, `buildPresetIni`, `saveCurrentValues`, `launchServer`, `loadConfiguration`, `deleteConfiguration` + every route branch in `server.js`. This, not line coverage, is the completeness checklist.
3. **Vector families** (each = one fully-specified 41-field input):
   - *Boundary* — one per predicate flip, targeting each §8 quirk (`temp:0` emitted vs `topK:0` dropped; `minP` `"0"` vs `"0.0"` vs `"0.00"`; `fastAttention:auto`; `draft-mtp` suppressing `-md`; legacy `disableReasoning`; `cacheRam:""` → `NaN`; `ngld:0`).
   - *Combinatorial* — 2-wise over all 41 fields; 3-wise over `speculationType × ngramMod × draftModelPath × specDraftNMax × ngld × ctkd × ctvd`.
   - *Format probe* — `0.00, -0, 0.1, 1e21, 1e-7, 0.30000000000000004, 9007199254740993, 1.005`, `parseInt("0x10")`, `parseFloat("0.7xyz")`, `null`, `undefined`, `true`, `"  8  "`, `"1e3"`.
   - *Randomized* — 1–2k seeded vectors for continuous fuzzing.
   - *Corpus-derived* — the 48 real saved configs of §9A, taken verbatim. These supply input shapes no synthetic set would produce (numeric-vs-string type drift, orphan keys, enum values no longer in the dropdowns, mixed path separators, garbage-but-truthy paths).
4. **Goldens** captured by running legacy: `{vector, impl@sha, provenance, argv[], ini}`. **`argv` = ordered array; ini = bytes.** Order is part of the contract.
5. **`equivalence.js`** — positional diff, shrink to minimal repro, promote shrunk vectors into the permanent boundary set.
6. **Mutation testing** on the two legacy generators (relational ops, boolean ops, string literals, numeric literals, statement removal, conditional inversion).
   - Killed ⇒ behavior is asserted. Survived ⇒ **vector gap** → synthesize the killing vector.
   - **Equivalent-mutant classification is automated, not judged:** a survivor is equivalent iff its branch is provably unreachable in the field domain (e.g. `ngld = parseInt(x)||0` is never negative) **or** exhaustive domain probing shows output invariance. Unprovable ⇒ it is a gap, not an equivalence.

**Gate:** every `SPEC-ROWS.csv` row mapped to ≥1 vector; goldens green on legacy; mutation score at ceiling with every survivor carrying a machine-generated equivalence proof.

### Phase 3 — SPEC pack (triple-derived, machine-cross-checked)
Generate three independent derivations and reconcile automatically:
- **(a) static** — AST scan of `script.js` + `server.js`
- **(b) runtime** — recorded behavior from Phase 1 capture
- **(c) independent model pass** — fresh context, given the source only, not (a) or (b)

Outputs in `SPEC/`: `field-manifest` (41 fields: id, type, min/max/step, defaults, full option lists, section, persisted?, CLI flag, ini key), `arg-truth-table`, `ini-map` (incl. name divergences + emission order), `api-contract` (OpenAPI regenerated) + `socket-contract`, `process-lifecycle`, `storage-schema`, `BUILD-FROM.md` (Part 2 cold-start doc).

**Gate:** `SPEC/CONSISTENCY.md` shows zero unreconciled disagreements; any (a)/(b) conflict resolves to (b) per §4 and is logged as an auto-resolution, never as a question.

### Phase 4 — Conformance suites L1–L4 + negative controls

| Layer | Suite | Asserts |
|---|---|---|
| **L1** | Backend E2E, UI mocked (HTTP + `socket.io-client` against a running app; fakes = stub binary, fixture tree, `nvidia-smi` stub) | all 9 endpoints + every branch (no-path 400 vs already-running **200** `success:false`; `/restart` 400 after restart since `lastLaunchConfig` is in-memory); exact argv received by stub; `models-preset.ini` bytes; SIGTERM → 1 s → SIGKILL; exit-code path; `server-ended`; **raw stdout chunk forwarding — no line splitting, no server-side trim**; scan rules incl. `mmproj*` exclusion + first-match association; `settings.json` writes **including the TDZ bug**; socket fan-out + `connectedClients` cleanup; `/metrics` shape + `vramUsage` string format |
| **L2** | UI E2E, backend mocked (Playwright; `fetch` intercepted; `io()` stubbed with scripted emitter; mocks = replays of Phase 1 recordings) | all 41 fields (defaults, min/max/step, option lists, labels, section order); conditional UI (`ctkEnable` gating, draft section, `specDraftNMaxGroup`, KVarN warnings); config CRUD → exact `localStorage` JSON, alphabetical render, active class, empty state; `deleteConfiguration` partial reset asserting **all 41** values incl. those *not* reset; native `<dialog>`/`alert`/`confirm` text; `location.reload()` after settings save; log pane ISO shape + per-chunk `.trim()` + 1000-line cap + auto-scroll; `/status` 5 s and `/metrics` 1 s cadence; `restartBtn.disabled === true` always; charts + resize + 50-point client history; DOM + a11y snapshots per state; screenshot regression per state × breakpoint |
| **L3** | Seam: real UI + real server + fake binary | the 5 boundary-only behaviors of §9, plus the corpus round-trip against a real backend |
| **L4** | Dual-run differential | candidate vs legacy under one action script; empty output diff; plus covered-line set diff (dead code excluded) |

**Corpus round-trip (the single highest-value test in the project):** seed the app's `localStorage` from `migration-resources/` (Playwright `addInitScript`), then, with the fake binary standing in for every `serverPath`:
- assert the rendered config list = 48 names, legacy sort order;
- for **each** of the 48 configs: load it, then launch — compare the stub-recorded **argv** positionally against legacy's;
- generate `models-preset.ini` from all 48 and compare **bytes**;
- re-save each config and compare the **exact** `localStorage` JSON written, orphan keys included (§9A Q16).

It runs unchanged in L2 (mocked backend), L3 (real backend), and L4 (legacy vs candidate). It is the one test that exercises the whole field matrix against real data instead of synthetic guesses.

**Negative controls (mandatory):** apply a mutant patch to a *scratch copy* of legacy and prove L1–L4 each go red. A suite that stays green against a mutated app has no teeth and is rewritten. This is how the oracle is trusted before any candidate exists.

**Part 1 exit condition (all machine-checked):**
- [ ] L1–L4 **100% green against legacy** (self-test; suites are env-driven, never import legacy code)
- [ ] every negative control goes red for the expected assertion, recorded in `fixtures/NEGATIVES.md`
- [ ] mutation score at ceiling; all survivors machine-proven equivalent
- [ ] `SPEC-ROWS.csv` fully mapped
- [ ] all §8 rows = `baseline-verified`
- [ ] corpus round-trip green against legacy for all 48 configs (argv + ini bytes + localStorage bytes)
- [ ] nightly job running L1–L4 against legacy is installed and green

---

## 3. PART 2 — Rebuild and conform
*Deferred. Stack-dependent. Starts cold from `SPEC/BUILD-FROM.md` + the ledger; requires no memory of Part 1.*

1. **Select target stack** from the constraint set (local HTTP server, spawn native exe without a shell, recursive FS walk, WebSocket, static serving). Native-window shells (Tauri/Electron windows) are excluded — they change the experience.
2. **Implement candidate from the SPEC pack** — the pack is the reference, not the legacy source.
3. `coercion-shim`: JS-faithful `parseInt`/`parseFloat`/`Number.toString`/`String()`/`||`, unit-tested against recorded V8 outputs (the format-probe vectors).
4. Point L1–L4 at the candidate via env; run the §7 loop until the diff is empty.
5. **Real-binary smoke (automated, no eyeballs):** run real `llama-server` + tiny GGUF; assert `/health`, `/props`, `/v1/models`; switch presets via llama-server's own API and assert the swap from its model list + log.
6. **Staged cutover** — `cutover.sh` / `rollback.sh`, pre-tested against fixture copies, then executed on explicit human go (§10).

**Gate:** Auditor go decision (§5) with zero `diff-open` and zero `blocked` rows.

---

## 4. Tie-break ladder (replaces "ask a human")

Whenever a disagreement or ambiguity arises:
1. **Recorded runtime evidence** from legacy at `parity-baseline` — always wins.
2. **Static code read** of legacy.
3. **Independent model derivation.**
4. If still unresolved: re-run capture with a targeted probe generated to isolate the case. Probing legacy *is* the resolution mechanism.

No step requires a human. If a case cannot be probed, the ledger row becomes `blocked` with a machine-written `ESCALATION.md` entry — it does not become a question, and it does not become `pass`.

---

## 5. Roles — no self-certification

| Role | Owns | May not |
|---|---|---|
| **Builder** | candidate source | edit `/fixtures`, `/tests`, thresholds, `PARITY.md` status, `AGENTS.md` |
| **Verifier** | harness, fixtures, ledger | write candidate feature code; hand-edit goldens (may only *re-record* from legacy) |
| **Auditor** | final go/no-go; runs last in a fresh context | — |

Auditor checks, all mechanical: all 15 quirks still reproduce · `/tests` + `MANIFEST.json` + threshold-config hashes unchanged (or each change backed by a ledger entry) · mutation suite re-run · every equivalence proof independently re-proven (unprovable ⇒ downgraded to a gap) · no `wontfix` status exists anywhere · quarantine rows resolved, not skipped.

**Anti-goal-post-moving (C8):** the dominant failure mode of unattended loops is silently loosening an assertion. Immutable hashes plus the Auditor are the control, not good intentions.

---

## 6. Suite design rules (make suites stack-agnostic)

1. Base URL, socket URL, binary path, model dir, `nvidia-smi` mode all from env. Suites never import app code.
2. Identical suites run against legacy (Part 1 self-test, nightly) and candidate (Part 2).
3. Comparison mode per field is declared in `fixtures/COMPARISON.json`: `exact` (default) or `shape` (§7 table). Adding a `shape` field requires a ledger entry; Builder cannot do it.
4. Flake protocol: N-repeat; a flaky check goes to ledger status `quarantine` with captured traces and is fixed like any red. Never skipped, never deleted.

---

## 7. Part 2 loop: verify → fix (cheapest tier first, stop at first red)

```
1. run L0 -> L1 -> L2 -> L3 -> L4; stop at first red tier
2. shrink the failure to a minimal repro
3. re-run the repro against legacy, capture its exact output   (C4)
4. classify:
   a. candidate wrong        -> Builder fixes candidate
   b. harness/timeout/misclassified nondeterminism -> Verifier fixes harness, never the fixture
   c. BASELINE.json hash mismatch -> legacy changed = SCOPE VIOLATION, halt, report
5. fix; re-run the single failing check, then the whole tier
6. promote the repro into the permanent vector/journey set
7. ledger: diff-open -> pass, with commit sha; checkpoint to disk
8. next red check
```

**Escalation protocol (replaces asking):** >N consecutive failed iterations on one check, or a fix/revert oscillation ⇒ mark `blocked`, write `ESCALATION.md` with minimal repro + attempted fixes + diffs, proceed to other checks. **Never** degrade or delete an assertion. Stop when only `blocked` rows remain and emit a final report.

**Everything on disk, nothing in context:** `plan.md`, `PARITY.md`, `SPEC/`, `ESCALATION.md` are the sole state. Any session resumes from the ledger's next `diff-open` row. Checkpoint after every green row.

**Cadence:** nightly L1–L4 against legacy for the whole Part 1→Part 2 gap — regression guard for the old app and the thing that keeps the oracle trustworthy while nothing is happening.

---

## 8. Nondeterminism ledger

| Field | Mode |
|---|---|
| ISO timestamps in log pane | regex shape |
| GPU/VRAM % off-Windows / on `nvidia-smi` failure | range + type; must **not** become real values or zeros |
| CPU % (`os-utils` sampling window) | range + change cadence over N samples |
| Log wall-clock ordering | relative-order alignment |
| PID / port-in-use messages | pattern presence |
| everything else | byte equality |

---

## 9. DO-NOT-FIX list — quirks that are requirements

| # | Quirk | Location | Frozen by |
|---|---|---|---|
| Q1 | `Restart` button rendered but permanently disabled (listener commented out) | `index.html:390`, `script.js:1186`, `:1190` | UI assert `disabled === true` in all states |
| Q2 | `POST /settings` TDZ bug — existing settings never read; `serverPort` falls back to 8080 | `server.js /settings` | POST without `serverPort` → file says 8080 even if it said 7838 |
| Q3 | `/start` while running → **200** `success:false`; missing path → 400 | `server.js /start` | contract tests both branches |
| Q4 | `/restart` 400 after manager restart (`lastLaunchConfig` in memory only) | `server.js /restart` | process integration test |
| Q5 | `--port` from `settings.serverPort` on `/start`, `DEFAULT_PORT` 8080 on `/launch-presets` | `server.js`, `script.js` | dual-path argv test |
| Q6 | GPU/VRAM are `Math.random()` off-Windows / on `nvidia-smi` failure | `server.js:getSystemMetrics` | shape test |
| Q7 | `saveCurrentValues` ≠ `launchServer` field sets; `launchServer` re-reads the DOM, not the saved config | `script.js:213`, `:409` | config-then-launch argv test |
| Q8 | `deleteConfiguration` partial reset to a hard-coded list diverging from HTML defaults | `script.js:1111` | snapshot all 41 values |
| Q9 | `fastAttention` is a `<select>` read via `.value`; `auto` → bare `-fa` | `index.html:266` | argv auto/on/off vectors |
| Q10 | ini keys `spec-ngram-size-n`/`draft-min`/`draft-max` ≠ CLI `--spec-ngram-mod-*`; trailing `port = ` | `script.js` | ini byte diff |
| Q11 | `settings.serverPort` never changes the manager's own port (hard-coded 7837) | `server.js:12` | port assertion |
| Q12 | External Google Fonts `<link>`; **no** service worker | `index.html:7-8` | asset/DOM test — do not add offline support |
| Q13 | Native `alert`/`confirm`; `location.reload()` after settings save | `script.js` | Playwright dialog handlers |
| Q14 | `-fit off` and `--host 0.0.0.0` always appended | `script.js` | argv test |
| Q15 | ngram-mod emits hard-coded `24/48/64` | `script.js` | argv + ini vectors |

### Additional rows discovered from the real-state corpus (§9A)

| # | Quirk | Evidence in corpus | Frozen by |
|---|---|---|---|
| Q16 | Orphan keys (`mlock`, `noMmap`, `ndio`, `dio`, `draftMin`, `draftMax`, `draftPMin`, `disableReasoning`) persist in `localStorage`, are **never read** by the current field set, and are **dropped on re-save** (`saveCurrentValues` builds a fresh object). Candidate must neither migrate them nor clean them on load | 8 keys across 28/48 configs | corpus re-save byte test, both states |
| Q17 | ini generation reads legacy `disableReasoning` when `reasoning` is absent → emits `reasoning = off/on`; the launch path ignores it entirely, so **`--reasoning` is omitted for these configs while the ini contains it** | 15 configs have `disableReasoning`, no `reasoning` | corpus ini + argv pair |
| Q18 | A saved enum value missing from the current `<option>` list silently blanks on load (`select.value=` non-existent → `""`), so the flag is dropped from argv on launch — e.g. `loadMode` saved as `dio`/`mlock`/`none` never yields `--load-mode` | `loadMode` values `dio`, `mlock`, `none`; no `mmap` in the corpus | per-config argv corpus test |
| Q19 | `repeatPenalty`/`presencePenalty` are stored as **both numbers and strings**, and the loose `!= "0"` predicate treats `0`, `"0"`, `"0.0"`, `"0.00"` as four different cases | 22 number + 26 string instances; all four zero forms present | corpus vectors + format probes |
| Q20 | `serverPath`/`modelPath` mix `\` and `/` and are stored verbatim; the client-side `--chat-template-file` derivation regex handles both, so output differs by input style | 11 paths with mixed separators | argv vectors both styles |
| Q21 | Truthy-but-broken paths are emitted as-is (e.g. `draftModelPath` ending in `\undefined`) — no validation anywhere | 1 such draft path | corpus argv test |
| Q22 | `topK: -1`, `ngl: 0`, `ngl: 100`, `topP: 0` occur in real data; emission follows the §9 predicates, not sanity | present in corpus | corpus argv tests |

### Out of scope (dead code, C2)
`createDefaultConfigName` (`script.js:205`, never called) · client `restartServer` (`script.js:968`, only referenced by the commented listener). The **`/restart` endpoint is live over HTTP and must be ported.**

### Cross-stack semantics traps (invisible in a code read)
1. JS coercion + `Number.toString()` shortest round-trip → `coercion-shim`.
2. **Log chunk boundaries** — one event per stdout chunk, UI does `data.toString().trim()`. Forward raw pipe chunks verbatim.
3. `spawn(exe, args)` **without a shell** — match Node/libuv Windows argv quoting for spaces/quotes.
4. `execSync('nvidia-smi …')` — synchronous, 1 s cadence; failure trigger = missing binary / non-zero exit / unexpected CSV shape.
5. `os-utils` sampling window, not an instantaneous read.
6. `Object.keys`/`Object.entries` insertion order from `JSON.parse(localStorage)` drives ini section order (render list is separately `.sort()`ed).
7. Two independent 50-point histories (server `systemMetrics.*.history`, client `chartData`) — keep both.
8. `/metrics` `vramUsage` format `${total-free}/${total}`.
9. 1000-line log cap on `textContent.split('\n')`, plus `scrollTop = scrollHeight`.

### Seam-only behaviors (only L3 sees them)
`mmproj` matched against `window.models` from the last `/models` fetch · `settings.serverPort` split across `localStorage` (client) and `settings.json` (server, broken by Q2) · `--port` divergence between `/start` and `/launch-presets` · `--chat-template-file` derived client-side by `\`-concatenation onto a server-returned path · ini built in browser, written verbatim by server.

---

## 9A. Real-state corpus — `migration-resources/`

User-supplied dumps of a real install. Treated as **golden fixtures**, never edited, never cleaned.

| File | Contents |
|---|---|
| `llamaCppConfigs.txt` | 48 saved configs; **9 distinct key sets** = 9 schema generations; 36 distinct models; 20 distinct `llama-server.exe` paths |
| `llamaCppSettings.txt` | `{"serverPort":7838,"modelsDirectory":"D:\\models\\"}` |

**Parse convention:** line 1 is the literal localStorage key name; JSON starts at the first `{`. Codify in `tools/parity/load-corpus.js`.

**Two execution modes** (the corpus references `D:\models\` and `C:\projects\...exe`, which may not exist on a test machine):
1. **Remapped mode** (default, everywhere in Part 1 and Part 2) — `PATH-MAP.json` rewrites model/binary roots to a fixture tree, applied to the corpus **and** to the recorded legacy expected output, so byte equality remains meaningful. Both apps receive the identical rewritten corpus.
2. **Real-path mode** — unmodified corpus on the original machine, as the final pre-cutover acceptance run.

**Why it matters more than the synthetic sets:** it is the only source of genuine schema drift, type drift, orphan keys, retired enum values, and malformed-but-truthy paths. Synthetic vectors will never invent `"0.00"` next to number `0`, or a `loadMode` of `dio`.

**Handling rules:** read-only; hashed into `MANIFEST.json`; never auto-formatted (key order and whitespace are compared byte-for-byte in the re-save test); if the user refreshes it, that is a fixture refresh requiring re-recording of corpus goldens, logged as such.

**Location:** `/migration-resources/` is **gitignored** (personal absolute paths + Windows username, public remote). It lives only on the fixture machine, so it can never be reconstructed from the repo. Consequences:
- derived artifacts **are** committed — but only in **remapped form** (`fixtures/corpus/` with `PATH-MAP.json` roots), so the repo never carries personal paths while Part 2 stays reproducible anywhere;
- real-path mode (§9A) is machine-bound and must record the machine + corpus SHA256 in its run manifest;
- `capture-legacy.sh` fails loudly, not silently, if the corpus is absent, and any run without it marks corpus-dependent ledger rows `blocked`, never `pass`.

---

## 10. What remains for a human (deliberately)

1. **The cutover.** Retiring legacy and taking `:7837` is the one irreversible, shared-state action. Everything up to a staged, atomic, pre-tested `cutover.sh` + `rollback.sh` is automated; execution needs one explicit human go.
2. **Blast-radius boundaries.** No pushes to shared branches beyond the authorized `migration` branch; no history rewrites; no touching the real `settings.json` / `models-preset.ini` / `D:\models` — only fixture copies.
3. **Residual risk accepted unread** (stated so it is unambiguous): pixel parity is only "as good as the frozen threshold"; simulated GPU/CPU curves are compared by shape because legacy generates them with `Math.random()`; machine-classified equivalent mutants could in principle hide an untested behavior (mitigated by Auditor re-proof).

---

## 11. Repository layout

```
/tools/parity/   freeze-baseline.sh fake-llama-server.js capture-legacy.sh fixture-tree.sh
                 nvidia-smi-stub gen-goldens.js equivalence.js dual-run.sh
                 coercion-shim/ mutants/            # mutant patches for negative controls
/migration-resources/  real-state corpus — gitignored, local to the fixture machine (read-only, hashed)
/fixtures/       BASELINE.json MANIFEST.json COMPARISON.json NEGATIVES.md PATH-MAP.json
                 http/ argv/ ini/ ws/ localstorage/ screenshots/ corpus/
                 vectors/{boundary,cover,format,random,corpus}/ goldens/
/SPEC/           field-manifest arg-truth-table ini-map api-contract socket-contract
                 process-lifecycle storage-schema SPEC-ROWS.csv CONSISTENCY.md BUILD-FROM.md
/tests/          L0-generators L1-backend L2-ui L3-seam L4-dualrun      # env-driven, stack-agnostic
/legacy/lib/     buildArgs.js buildPresetIni.js  (goldens green)
PARITY.md  AGENTS.md  ESCALATION.md  plan.md
```

---

## 12. Immediate next actions

1. Tag `parity-baseline` on the last legacy-only commit (`c57f438`).
2. Phase 0: `BASELINE.json`, `PARITY.md`, `AGENTS.md`, hash pinning.
3. Phase 1: `fake-llama-server.js` + `capture-legacy.sh` (dependency for every later suite).
4. Corpus (gitignored, local): `load-corpus.js` + `PATH-MAP.json` + corpus vectors + corpus ini/localStorage goldens, committed in remapped form only.
5. Phase 2: extract the two generators with the behavior-preservation proof → `SPEC-ROWS.csv` → vector families (incl. corpus) → goldens → mutation + machine equivalence proofs.
6. Phases 3–4: SPEC pack cross-check → L1–L4 env-driven → corpus round-trip → run green against legacy → negative controls → install nightly.
7. Part 1 ends with a machine verdict, not a review.
