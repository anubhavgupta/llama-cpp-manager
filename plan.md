# Parity Port Plan — llama-cpp-manager

**Objective:** Re-implement `llama-cpp-manager` in a different technology stack with **bug-for-bug, byte-for-byte user-visible parity**. No scope changes. No bug fixes. No improvements.

**Baseline:** legacy app at the commit tagged at Phase 0. Legacy output is correct by definition.

---

## 0. Governing constraints

| # | Constraint | Consequence |
|---|---|---|
| C1 | No behavior changes, no bug fixes | Every quirk in §7 is a **requirement**, not a defect |
| C2 | "Same from the user's perspective" | Dead code (never reachable from UI) is **out of scope** — not ported, not tested, but recorded |
| C3 | User configs live in `localStorage`, keyed by origin | New app must serve on **`http://localhost:7837`** or all existing configs are orphaned |
| C4 | Legacy is the only oracle | Any diff ⇒ the **candidate** is wrong. Never edit a golden to go green |
| C5 | Fixtures are recorded, never authored | A hand-written fixture encodes the AI's *belief* about the system and will pass while wrong |
| C6 | Keep Socket.IO | Its reconnect choreography drives user-visible log lines (`Connected to server for real-time logging`) |

### Open decision (blocking Phase 3)
Target stack. Must support: local HTTP server, spawn native exe without a shell, recursive FS walk, WebSocket, static file serving. Candidates: Node/TS, Go, Rust/axum, Bun. **Not** Tauri/Electron with a native window — that changes the experience.

---

## 1. Parity contract — the six observable surfaces

| Surface | Source | Parity requirement |
|---|---|---|
| HTTP API — 9 endpoints, status codes, body bytes | `server.js` | Byte-identical, incl. error branches and the 200-`success:false` quirk |
| Socket.IO events `log-stream` / `server-ended` / `server-error` | `server.js`, `script.js:895` | Event names, payload shape `{type,data}`, order, raw chunk fidelity |
| The `argv` array handed to `llama-server` | `script.js:409-650` | Ordered array equality — **this is the product** |
| `models-preset.ini` text | `script.js:676-870` | Byte-level, incl. key order and CLI-vs-ini name divergences |
| `localStorage` schema `llamaCppConfigs`, `llamaCppSettings` | `script.js` | Must import existing user data unchanged, incl. legacy `disableReasoning` |
| UI: layout, sections, dialogs, log pane, charts, polling cadence | `index.html`, `styles.css`, `script.js` | DOM + a11y + screenshot ledgers |

---

## 2. Repository layout for the port

```
/tools/parity/
  freeze-baseline.sh        # tag + hash legacy files
  fake-llama-server.js      # stub binary; dumps argv; knobs for exit code / slow term
  capture-legacy.sh         # records all fixtures from the running legacy app
  extract-generators.patch  # behavior-preserving extraction of buildArgs/buildPresetIni
  gen-goldens.js            # vectors -> goldens, records legacy sha + provenance
  equivalence.js            # candidate vs goldens, positional diff + shrink
  coercion-shim/            # JS-faithful parseInt/parseFloat/Number.toString/String()/||
  fixture-tree.sh           # model dir fixtures (nested, mmproj, non-ASCII, unreadable)
  dual-run.sh               # legacy :7837 + candidate :7838, same actions, diff
  nvidia-smi-stub           # on PATH; removable to force simulated-metrics path
/fixtures/
  BASELINE.json  MANIFEST.json  http/  argv/  ini/  ws/  localstorage/  screenshots/
  vectors/{boundary,cover,format,random}/   goldens/
/tests/
  L0-generators/  L1-backend/  L2-ui/  L3-seam/  L4-dualrun/
PARITY.md      # behavior ledger
AGENTS.md      # DO-NOT-FIX list, oracle rules
```

---

## 3. Phases

### Phase 0 — Freeze the baseline
1. `git tag parity-baseline`; record `BASELINE.json` (sha + SHA256 of `server.js`, `public/script.js`, `public/index.html`, `public/styles.css`).
2. `PARITY.md` ledger seeded with all rows from §7.
3. `AGENTS.md` with the DO-NOT-FIX list and the oracle rules (C4, C5).

**Exit:** baseline hashes committed; ledger rows exist.

### Phase 1 — Fakes and recording harness
1. `fake-llama-server.js`: writes exact argv array + raw command line to a file; prints startup logs in llama.cpp-like **chunk shapes**; binds `--host/--port`; exits on SIGTERM; knobs for `--exit-code`, slow termination, stderr-only output.
2. `fixture-tree.sh`: nested dirs, `mmproj` name variants, spaces + non-ASCII + long paths, unreadable dir, empty dir, missing dir, mmproj in sibling dir (negative case).
3. `nvidia-smi-stub` on `PATH`.
4. `capture-legacy.sh` → `fixtures/`: HTTP responses (all endpoints + all error branches), recorded argv, real `models-preset.ini`, socket event stream (names/order/relative timestamps), `localStorage` export, screenshots. Every file records the command that produced it.

**Exit:** one command reproduces the full fixture set from legacy.

### Phase 2 — Pure generators: vectors + goldens + mutation  ← *highest value, do first*

The two pure functions that hold most of the risk:
- `buildArgs(fields, settings)` — inline at `script.js:409-650`
- `buildPresetIni(configs, settings, models)` — inline at `script.js:676-870`

Both are fully deterministic — no clock, no DOM, no randomness.

1. **Extract** both into `legacy/lib/` and **prove the extraction is behavior-preserving**: re-run pre-refactor live journeys and require byte-identical argv + ini. *Never skip this — otherwise every later green test validates a refactor bug.*
2. **AST predicate inventory** → `SPEC-ROWS.csv`: every condition in `buildArgs`, `buildPresetIni`, `saveCurrentValues`, `launchServer`, `loadConfiguration`, `deleteConfiguration`, plus every route branch. This, not line coverage, is the completeness checklist.
3. **Vector sets** (one fully-specified 41-field input each):
   - *Boundary* — one vector per predicate flip point, targeting §7 quirks (`temp:0` emitted vs `topK:0` dropped; `minP` `"0"` vs `"0.0"` vs `"0.00"`; `fastAttention: auto`; `speculationType: draft-mtp` suppressing `-md`; legacy `disableReasoning`; `cacheRam: ""` → `NaN`; `ngld: 0`).
   - *Combinatorial* — 2-wise covering array over all 41 fields + 3-wise over the interacting cluster `speculationType × ngramMod × draftModelPath × specDraftNMax × ngld × ctkd × ctvd`.
   - *Format probe* — `0.1, 0.00, -0, 1e21, 1e-7, 0.30000000000000004, 9007199254740993, 1.005`, `parseInt("0x10")`, `parseFloat("0.7xyz")`, `null`, `undefined`, `true`, `"  8  "` — exists because the port is a different language.
   - *Randomized* — 1–2k seeded vectors for continuous fuzzing.
4. **Goldens**: captured by running legacy, not authored. `{vector, impl@sha, provenance, argv[], ini}`. **`argv` compared as an ordered array; ini compared as bytes** — order is part of the contract.
5. **Equivalence harness**: run candidate generators over all vectors; emit positional diffs (`idx 14: expected "--min-p" got "--presence-penalty"`); shrink to minimal repro; promote the shrunk vector into the permanent boundary set.
6. **Mutation score** on the legacy generators (Stryker or custom mutators: relational ops, boolean ops, string literals, numeric literals, statement removal, conditional inversion).
   - *Killed* mutant ⇒ behavior is asserted.
   - *Survived* mutant ⇒ **gap in the vectors** → add the killing vector. Survivors are the deliverable.
   - Pre-declare *equivalent* mutants with justifications so the score is interpretable (e.g. `config.ngld >= 0` where `ngld = parseInt(x)||0` can never be negative — a real finding, not a test gap).

**Exit:** every `SPEC-ROWS.csv` row mapped to ≥1 vector; goldens green on legacy; mutation score at ceiling with all survivors individually justified.

### Phase 3 — Backend E2E (UI mocked)
Drive HTTP + `socket.io-client` against real `server.js`; fakes = stub binary, fixture tree, `nvidia-smi` stub.

Cover: all 9 endpoints and every branch (`/start` no-path 400 vs already-running **200** `success:false`; `/restart` 400 after manager restart because `lastLaunchConfig` is in-memory only); exact argv received by the stub; `models-preset.ini` written bytes; SIGTERM → 1 s → SIGKILL timing; exit-code path; `server-ended`; **raw stdout chunk forwarding — no line splitting, no server-side trim**; scan rules (`mmproj*` excluded as models, first-match association, nested/non-ASCII/unreadable/missing); `settings.json` writes **including the TDZ bug**; socket fan-out to N clients and `connectedClients` cleanup; `/metrics` shape + `vramUsage` string format; `nvidia-smi` failure → simulated values.

**Exit:** contract replay green; every recorded HTTP/socket fixture matched byte-for-byte.

### Phase 4 — UI E2E (backend mocked)
Playwright on static `public/`; `fetch` intercepted for the 9 endpoints; Socket.IO stubbed at the `io()` boundary with a scripted emitter. Mocks are **replays of Phase 1 recordings** pinned to `MANIFEST.json`.

Cover: all 41 fields (defaults, `min/max/step`, full `<option>` lists, label text, section grouping and order); conditional UI (`ctkEnable` gating `-ctk/-ctv`, `speculationType`/`ngramMod` → draft section, `specDraftNMaxGroup` visibility, KVarN warning under ctk/ctv/ctkd/ctvd); config CRUD → exact `localStorage` JSON written, alphabetical `.sort()` render, active class, empty-state text; `deleteConfiguration` partial reset — assert all 41 values including those **not** reset; native `<dialog>`/`alert`/`confirm` message text; `location.reload()` after settings save; log pane ISO-timestamp shape, per-chunk `.trim()`, 1000-line cap, auto-scroll; polling cadence `/status` 5 s and `/metrics` 1 s; `restartBtn.disabled === true` in every state; charts per metric + resize + 50-point client history; DOM + a11y snapshots per state; screenshot regression per state × breakpoint.

Determinism: freeze `Date`, seed `Math.random()`, fake timers for polling.

**Exit:** DOM/visual ledgers green; no unexplained branch gaps in `script.js` (dead code excluded).

### Phase 5 — Seam suite (real UI + real `server.js` + fake binary)
Thin, 8–12 journeys. The only suite that sees boundary-only behavior:

| Seam behavior | Why neither half sees it |
|---|---|
| `mmproj` resolved by matching against `window.models` from the last `/models` fetch | client cache + server data |
| `settings.serverPort` split across `localStorage` (client) and `settings.json` (server, broken by the TDZ bug) | end-to-end only |
| `--port` from `settings.serverPort` on `/start`, `DEFAULT_PORT` 8080 on `/launch-presets` | two clients, one setting |
| `--chat-template-file` derived client-side by `\`-concatenating a server-returned path | derivation happens in browser |
| ini built in browser, written verbatim by server | mocked backend only echoes success |

Note: for most journeys this real-real setup is **better than mocking** (keeps Socket.IO reconnect honesty). The Phase 4 mocked suite is for fast parallel state-matrix coverage and for states hard to produce live (500s, `server-error`, slow/partial log streams, malformed payloads).

**Exit:** all seam journeys green; stub-recorded argv matches legacy.

### Phase 6 — Dual-run differential
`dual-run.sh`: legacy on `:7837`, candidate on `:7838`, identical seeded state, same scripted action list, diff everything except §6-classified nondeterministic fields. Also run coverage on both sides and diff **legacy-covered lines vs candidate-covered lines** under the identical journeys — a completeness check, with dead code excluded.

**Exit:** diff output empty; no unexplained coverage-set differences.

### Phase 7 — Real-binary smoke + cutover
One real `llama-server` + tiny GGUF: verify presets actually load from llama.cpp's own preset UI (out-of-app behavior the harness cannot test), then candidate takes `:7837`.

---

## 4. The verify–fix loop (runs from Phase 3 onward)

```
1. Run tiers in order; stop at the first red tier (cheap gates first)
2. Reduce the failure to a minimal repro (shrink vector / action script)
3. Re-run the repro against legacy and capture its exact output  (legacy = oracle)
4. Classify:
   a. candidate wrong            -> fix candidate
   b. harness/formatting/timeout/nondeterminism misclassified -> fix HARNESS, never the fixture
   c. fixture vs BASELINE hash mismatch -> legacy changed => SCOPE VIOLATION, escalate
5. Fix, re-run the single failing check, then the whole tier
6. Add the repro as a permanent regression case
7. Update PARITY.md: diff-open -> pass, with commit sha
8. Next red check
```

**Rules given to the agent each iteration:** legacy output is correct by definition · one fix per iteration · never edit a golden to go green · never "improve" anything on the DO-NOT-FIX list · if a fix breaks a previously passing tier, revert and re-plan.

---

## 5. Coverage policy (gap detector, not a goal)

- Line coverage is **not** a gate. It measures reach, not assertion strength — a covered line can still emit `0` where legacy emits `0.00`.
- Gate instead on: **spec-row coverage** (every AST predicate mapped to a vector) and **mutation score** on the generators.
- Use raw coverage in two ways only: (a) audit legacy to find untested conditions and add vectors; (b) differential covered-line set, legacy vs candidate, to detect features the candidate never enters.
- E2E is not the vehicle for coverage — the browser tier is for DOM/visual/interaction only. Generators and HTTP contract must be checked without a browser.

| Surface | Metric | Target |
|---|---|---|
| `buildArgs`, `buildPresetIni` | spec rows mapped + mutation score | 100% rows, ceiling mutation, all survivors justified |
| `server.js` routes reachable on win32 | branch coverage + contract replay | high; every error branch replayed |
| `script.js` | branch coverage via journeys, dead code excluded | high; each gap listed with reason |
| Platform/simulated metric paths | shape-only assertions | excluded from % |
| CSS / DOM / charts | snapshot + visual ledger | 100% of enumerated states, coverage N/A |

---

## 6. Nondeterminism ledger (prevents chasing ghosts)

| Field | Comparison mode |
|---|---|
| ISO timestamps in log pane | regex shape only |
| GPU/VRAM % on macOS/Linux or when `nvidia-smi` absent | range + type; must **not** be replaced by real values or zeros |
| CPU % (`os-utils` sampling window) | range + change cadence over N samples |
| Log wall-clock ordering | relative-order alignment, not equality |
| PID / port-in-use messages | pattern presence |
| everything else | byte equality |

---

## 7. DO-NOT-FIX list — quirks that are requirements

| # | Quirk | Location | Frozen by |
|---|---|---|---|
| Q1 | `Restart` button rendered but permanently disabled (listener commented out) | `index.html:390`, `script.js:1186`, `script.js:1190` | UI assertion: `disabled === true` in all states |
| Q2 | `POST /settings` TDZ bug — existing settings never read, `serverPort` falls back to `DEFAULT_PORT` 8080 | `server.js` `/settings` | POST with no `serverPort` → file says 8080 even if it said 7838 |
| Q3 | `/start` while running → **200** `success:false`; missing path → 400 | `server.js` `/start` | contract tests both branches |
| Q4 | `/restart` → 400 after manager restart (`lastLaunchConfig` in memory only) | `server.js` `/restart` | process integration test |
| Q5 | `--port` from `settings.serverPort` on `/start`, `DEFAULT_PORT` 8080 on `/launch-presets` | `server.js`, `script.js` | dual-path argv test |
| Q6 | GPU/VRAM are `Math.random()` off-Windows / on `nvidia-smi` failure | `server.js:getSystemMetrics` | shape test |
| Q7 | `saveCurrentValues` and `launchServer` collect different field sets; `launchServer` re-reads the DOM instead of the saved config | `script.js:213`, `script.js:409` | config-then-launch argv test |
| Q8 | `deleteConfiguration` partial reset to a hard-coded list that diverges from HTML defaults | `script.js:1111` | snapshot all 41 values after delete |
| Q9 | `fastAttention` is a `<select>` read via `.value`; `auto` → bare `-fa` | `index.html:266`, `script.js` | argv test auto/on/off |
| Q10 | ini keys `spec-ngram-size-n`/`draft-min`/`draft-max` differ from CLI `--spec-ngram-mod-*`; trailing `port = ` after last section | `script.js` | byte diff of ini |
| Q11 | `settings.serverPort` never changes the manager's own port (hard-coded 7837) | `server.js:12` | assert port stays 7837 for any `serverPort` |
| Q12 | External Google Fonts `<link>`; **no** service worker | `index.html:7-8` | asset/DOM test — do not add offline support |
| Q13 | Native `alert`/`confirm`; `location.reload()` after settings save | `script.js` | Playwright dialog handlers |
| Q14 | `-fit off` and `--host 0.0.0.0` always appended | `script.js` | argv test |
| Q15 | ngram-mod emits hard-coded `24/48/64` | `script.js` | argv + ini vectors |

### Explicitly out of scope (dead code — C2)
`createDefaultConfigName` (`script.js:205`, never called) · client `restartServer` (`script.js:968`, only referenced by the commented listener) — but the **`/restart` endpoint is live over HTTP and must be ported**.

### Cross-stack semantics that must be matched (invisible in a code read)
1. JS `parseInt`/`parseFloat`/`||` coercion + `Number.toString()` shortest round-trip → `coercion-shim`, unit-tested against V8.
2. **Log chunk boundaries** — legacy emits one event per stdout chunk, UI does `data.toString().trim()`. Forward raw pipe chunks; no line splitting, no server-side trim.
3. `spawn(exe, args)` **without a shell** — match Node/libuv Windows argv quoting for paths with spaces and quotes.
4. `execSync('nvidia-smi …')` — synchronous, 1 s cadence, failure trigger = missing binary / non-zero exit / unexpected CSV shape.
5. `os-utils` CPU sampling window, not an instantaneous read.
6. `Object.keys`/`Object.entries` insertion order from `JSON.parse(localStorage)` drives ini section order (render list is separately `.sort()`ed).
7. Two independent 50-point histories exist (server-side `systemMetrics.*.history` and client-side `chartData`) — keep both.
8. `/metrics` `vramUsage` string format `${total-free}/${total}`.
9. 1000-line log cap computed on `textContent.split('\n')`, plus `scrollTop = scrollHeight`.

---

## 8. Suite weighting and ordering

| Layer | Suite | Effort | Gate |
|---|---|---|---|
| L0 | generators: vectors + goldens + mutation | small | spec rows mapped, mutation ceiling |
| L1 | backend E2E, UI mocked | 35% | contract + argv + lifecycle + ini |
| L2 | UI E2E, backend mocked | 35% | DOM + a11y + visual + journeys |
| L3 | seam: real UI + real server + fake binary | 15% | seam behaviors §Phase 5 |
| L4 | dual-run legacy vs candidate | 15% | empty diff |

Build order: **Phase 0 → 1 → 2 → 3 (backend defines the contract the mocks replay) → 4 (mocks now come from recordings) → 5 → 6 → 7.**

---

## 9. Exit criteria

- [ ] `parity all` green in one clean run across L0–L4
- [ ] `PARITY.md` has zero `diff-open` rows; every `pass` backed by a test that produced output in the last run
- [ ] `PARITY-DIFF.md` **empty** — there is no intentional-diff column under C1
- [ ] Anti-regression sweep: all 15 §7 quirks still reproduced
- [ ] Dead-code exclusions recorded so no later pass "restores" the Restart button
- [ ] Real `llama-server` smoke test passed, then candidate takes `:7837`

---

## 10. Immediate next actions

1. Answer the open decision: **target stack**.
2. Phase 0: `git tag parity-baseline` + `BASELINE.json` + seed `PARITY.md` / `AGENTS.md`.
3. Phase 1: `fake-llama-server.js` + `capture-legacy.sh` (dependency for every later suite).
4. Phase 2: extract generators (with behavior-preservation proof), emit `SPEC-ROWS.csv`, generate vectors + goldens, wire mutation testing.
