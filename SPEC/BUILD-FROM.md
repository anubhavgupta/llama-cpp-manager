# BUILD-FROM — cold-start build doc (plan.md §3 Part 2, entry point)

Everything needed to rebuild the app **without reading the legacy source**. Each contract below is
the reconciled Phase 3 SPEC pack: `SPEC/field-manifest.json`, `SPEC/arg-truth-table.json`,
`SPEC/ini-map.json`, `SPEC/api-contract.openapi.json`, `SPEC/socket-contract.json`,
`SPEC/process-lifecycle.json`, `SPEC/storage-schema.json`. `SPEC/CONSISTENCY.md` records how the three
derivations (static source read, fixtures/** recordings, independent model pass) agreed on each line,
and `SPEC/RECONCILE-STATS.json` holds the machine counts.

Lines carrying `not-recorded:` name a string the source states but no fixture ever exercised; the
Phase 4 suites owe those a test. `model-only:` marks a claim only the model pass states.

## 1. Hard constraints (choose the stack from these, nothing else)

- Local HTTP server on **port 7837, hard-coded**. `settings.serverPort` is sent to the child as
  `--port` and is *never* the manager's own listen port (Q11). The suites are bound to
  `http://localhost:7837`; anything else orphans the user's `localStorage`.
- Same-origin static frontend served from `public/` (`index.html`, `script.js`, and a `/lib` static
  mount for the vendored chart library). The page must be served from the manager origin, not a
  separate port — the state lives in origin-scoped `window.localStorage`.
- One HTTP server + one WebSocket endpoint on the **same** port and server (socket.io attached to the
  same `http.Server`, `cors: { origin: "*" }`). The client connects with a bare `io()`.
- Must spawn a native `.exe` **without a shell** and pipe its stdout/stderr. A `.cmd`/`.bat` path
  therefore cannot be spawned at all — that is recorded behaviour, do not "fix" it.
- Must walk a models directory recursively and return `.gguf` files (see `GET /models`).
- Synchronous `nvidia-smi` execution for GPU metrics with a 1 s sampling cadence; on failure the
  metrics fall back to `Math.random()` values (Q6 — simulated numbers are a requirement).
- No service worker, no offline support. The page loads Google Fonts with two external `<link>` tags
  (Q12). Native `alert()` / `confirm()` dialogs and a `location.reload()` after settings save (Q13).
- Node-only libraries that a non-JS stack must reproduce exactly: `parseInt` / `parseFloat` /
  `Number.prototype.toString()` shortest round-trip, `||` truthiness, `JSON.stringify` key order.
  Build a `coercion-shim` and unit-test it against `fixtures/vectors/format/vectors.jsonl`.

## 2. HTTP contract

All request and response bodies are JSON (`application/json`), except the two file routes. The
manager has 11 routes; registration order is part of the contract because the static-file route is
registered first.

| route | statuses | body |
|---|---|---|
| `GET /` | 200 | `public/index.html` (`text/html`) |
| `GET /swagger` | 200 | `public/swagger.json` (`application/json`, served as a file) |
| `GET /swagger.json` | not a route — the framework default 404 body is what the recording holds (not-recorded: status line was never captured) | |
| `GET /models` | 200 | `{ models: [ { name, relativePath, path, size, mmprojFile? } ] }` from the models directory in `settings.json` |
| `GET /metrics` | 200 | `{ cpu, ram, gpu, vram, vramUsage }` where `vramUsage` is the string `${total-free}/${total}` |
| `GET /status` | 200 | `{ running: <boolean>, hasLastLaunch: <boolean> }` |
| `POST /start` | 400, 200, 200, 500 | request `{ serverPath, args }`; 400 `{ success:false, error:"Server path is required" }`; **200 with `success:false`** while a server is already running (Q3); 200 `{ success:true, message:"Server started successfully" }`; 500 `{ success:false, error:<message> }` |
| `POST /stop` | 200, 200, 500 | `{ success:true, message:"Server stopped" }` or 200 `{ success:false, error:"No server is currently running" }` |
| `POST /restart` | 400, 500, 200, 500 | 400 `{ success:false, error:"No previous configuration found to restart from" }` when the in-memory `lastLaunchConfig` is empty (Q4: it is memory-only, so a manager restart clears it) |
| `POST /settings` | 400, 200, 500 | request `{ modelsDirectory, serverPort }`; 400 when `modelsDirectory` is missing. **TDZ defect reproduced as-is (Q2):** an omitted `serverPort` persists `8080` even when `settings.json` said otherwise |
| `POST /launch-presets` | 400, 400, 200, 500 | no request body; writes `models-preset.ini` next to the binary, then spawns it |

`GET /restart` is **not** a route; a recorded `GET /restart` answered from the framework default
handler (not-recorded: the recording captured the body only, so the 404 status itself is inferred
from the framework, not from legacy bytes).

Runtime-observed extras the source alone does not show (`x-runtime-only-observations` in
`SPEC/api-contract.openapi.json`):

- `POST /settings` with and without `serverPort` produced **byte-identical** `settings.json`
  (`fixtures/ini/J1-settings/settings.after-with-port.json`, `…-without-port.json`) — the visible face
  of Q2.
- `/metrics` with a garbage `nvidia-smi` reply answers `gpu=0, vram=0, vramUsage="0/0"` next to real
  `cpu`/`ram`; the `Math.random()` branch only runs when nvidia-smi is missing or exits non-zero.
- `GET /settings` on a first run answers from the built-in default branch, including a hard-coded
  models directory string recorded verbatim in `fixtures/http/J0-baseline/first-run-note.json`.
- While a server runs, the page polls `GET /metrics` once per second and `GET /status` every 5 s
  (`fixtures/ws/J5-ui-cadence/request-cadence.json`, 12 `/metrics` in 12 018 ms).
- The page blocks some requests before they leave: `Please enter the path to llama-server.exe`,
  `Please enter a models directory path`, `Please enter a configuration name`, and the delete
  confirm `Are you sure you want to delete the configuration "<name>"?`
  (`fixtures/ws/J5-ui-dialogs/dialogs.json`). A model path that is not one of the `<select>` options
  alerts instead of posting `/start`.

## 3. Browser storage contract

- Two keys, written in this order: `llamaCppSettings` then `llamaCppConfigs`.
- `llamaCppSettings` = `{ serverPort: <number>, modelsDirectory: <string> }`. `serverPort` is a
  number in storage and is stringified only when it becomes `--port`.
- `llamaCppConfigs` = `{ "<config name>": { …36 fields… } }`. The config **name is the object key**;
  it is not a field of the config, and the name is the ini section header verbatim.
- 36 keys are written by the save path; the manifest marks which of the 41 fields those are. Keys the
  save path does not write (`mlock`, `noMmap`, `ndio`, `dio`, `draftMin`, `draftMax`, `draftPMin`,
  `disableReasoning`) may already be present from real user data: **read nothing from them, do not
  migrate them, do not clean them** — the next save drops them (Q16). The recordings see them inside
  `llamaCppConfigs` (`SPEC/from-runtime/storage-schema.json#configsShape`), which is why the manifest's
  `persisted` flag and the recorded key set are different questions.
- Object key **insertion order is contractual** for ini generation (`Object.entries` order), while the
  rendered config list is sorted separately. Never rebuild a config object by sorting its keys.
- Values keep their stored JSON type: `ngl`, `threads`, `temp`, `topK`, `topP`, `contextSize`,
  `nCpuMoe`, `specDraftNMax`, `ngld` are numbers; `repeatPenalty` / `presencePenalty` occur as both
  numbers and strings; `cacheRam` can be `null` because `parseInt('')` is `NaN` and
  `JSON.stringify(NaN)` is `null`.
- Deleting a configuration resets only a hard-coded list of controls, and that list is *not* the HTML
  default set (Q8). The recorded delete leaves `loadMode` at `mmap` while every other control keeps its
  value (`fixtures/localstorage/J5-ui-states/q8-delete-reset.json`); `topP` is *not* reset
  (`SPEC/CONSISTENCY.md#auto-resolutions`).

## 4. argv contract — how the launch vector is built

The vector is built **in the browser** and POSTed to `/start` as `{ serverPath, args }`; the manager
spawns `serverPath` with exactly those args and never edits them. Order is part of the contract:
`args.push` runs in source order into one flat array. `arity 0` means the flag is pushed alone.

| # | flag | arity | value comes from | emitted when |
|---:|---|---:|---|---|
| 1 | `-m` | 1 | `modelPath` | truthy |
| 2 | `-ngl` | 1 | `ngl` | `> 0` |
| 3 | `-t` | 1 | `threads` | `> 0` |
| 4 | `--temp` | 1 | `temp` | `>= 0` — so `0` **is** emitted |
| 5 | `--top-k` | 1 | `topK` | `> 0` — so `0` is dropped, unlike `--temp` |
| 6 | `--top-p` | 1 | `topP` | `>= 0` |
| 7 | `--min-p` | 1 | `minP` | `!isNaN(parseFloat(v)) && v != "0"` (loose compare, Q19) |
| 8 | `--repeat-penalty` | 1 | `repeatPenalty` | same loose zero test (Q19) |
| 9 | `--presence-penalty` | 1 | `presencePenalty` | same loose zero test (Q19) |
| 10 | `--parallel` | 1 | `parallel` | `> 0` |
| 11 | `--load-mode` | 1 | `loadMode` | truthy string |
| 12 | `--swa-full` | 0 | `swaFull` | truthy |
| 13 | `-c` | 1 | `contextSize` | `> 0` |
| 14 | `--n-cpu-moe` | 1 | `nCpuMoe` | `> 0` |
| 15 | `--cpu-moe` | 0 | `cpuMoe` | truthy |
| 16 | `-ctk` | 1 | `contextTokenKey` | `ctkEnable && contextTokenKey && contextTokenValue` |
| 17 | `-ctv` | 1 | `contextTokenValue` | same guard as `-ctk` |
| 18/19 | `-fa` | 0 or 1 | `fastAttention` | `auto` → bare `-fa`; `on`/`off` → `-fa <value>` (Q9) |
| 20 | `--jinja` | 0 | `jinja` | truthy (confirmed against 4 recorded launches) |
| 21 | `--chat-template-kwargs` | 1 | `chatTemplateKwargs` | truthy |
| 22 | `--chat-template-file` | 1 | derived from `modelPath` | `loadCustomChatTemplate && modelPath`; value is the model's directory joined with `chat-template.jinja` using `\` |
| 23 | `--verbose` | 0 | `verbose` | truthy (not-recorded: no recorded launch body set `verbose`) |
| 24 | `--backend-sampling` | 0 | `backendSampling` | truthy |
| 25 | `--no-kv-offload` | 0 | `noKvOffload` | truthy |
| 26 | `--no-mmproj-offload` | 0 | `noMmprojOffload` | truthy |
| 27 | `--cache-ram` | 1 | `cacheRam` | `!== undefined && !Number.isNaN(...)` — the only numeric guard with no `|| 0` fallback |
| 28 | `--spec-type` | 1 | `speculationType`, or the literal `ngram` when only `ngramMod` is set | inside `speculationType !== 'none' \|\| ngramMod` |
| 29 | `--spec-ngram-mod-n-match` | 1 | literal `24` | ngram branch (hard-coded, Q15) |
| 30 | `--spec-ngram-mod-n-min` | 1 | literal `48` | ngram branch (Q15) |
| 31 | `--spec-ngram-mod-n-max` | 1 | literal `64` | ngram branch (Q15) |
| 32 | `--spec-draft-n-max` | 1 | `specDraftNMax` | `> 0` inside the speculation guard |
| 34 | `--reasoning` | 1 | `reasoning` | `'off'` → `--reasoning off`, `'on'` → `--reasoning on`; `auto` emits nothing |
| 35 | `-md` | 1 | `draftModelPath` | draft block runs and `speculationType` is neither `none` nor `draft-mtp` (not-recorded: the recorded launches never produced a draft block with a path) |
| 36 | `-ngld` | 1 | `ngld` | inside the draft block, `>= 0` (not-recorded: no recorded draft block) |
| 37 | `-ctkd` | 1 | `ctkd` | inside the draft block, truthy (not-recorded: no recorded draft block) |
| 38 | `-ctvd` | 1 | `ctvd` | inside the draft block, truthy (not-recorded: no recorded draft block) |
| 39 | `--host` | 1 | literal `0.0.0.0` | always |
| 40 | `-fit` | 1 | literal `off` | always (Q14) |
| 41 | `--port` | 1 | `settings.serverPort` as a string | always |
| 42 | `--mmproj` | 1 | the `mmprojFile` of the `GET /models` entry whose `path` equals `modelPath` | matched only if that fetch already returned it |

Rules that are easy to get wrong:

- Every pushed value is a **string**: numbers go through `String()` / `.toString()`. The `--top-p 0`
  vs `--top-p 0.00` difference in the recordings comes from `String(0)` after numeric coercion versus a
  stored raw string; `--min-p` / `--repeat-penalty` / `--presence-penalty` keep the stored text.
- `launchServer` rebuilds its own field set from the **live DOM**, not from the saved config, and then
  re-saves the active config before POSTing (Q7). A test that saves a config and launches a different
  one must expect DOM values.
- `serverPath` is not an argument at all: it is the POST body field and the spawn executable.
- `--port` on this path comes from `settings.serverPort`; on `/launch-presets` it comes from
  `settings.serverPort` too, but that endpoint reads `settings.json` server-side, where Q2 leaves
  `8080` unless the dialog saved a port — the two paths legitimately differ (Q5). Both are recorded:
  `--port 7838` from `/start`, `--port 8080`/`--port 7838` from `/launch-presets`
  (`fixtures/argv/J4-launch-presets/port-source-evidence.json`).
- `--models-preset <ini path>` is prepended only on the `/launch-presets` path, followed by
  `--host 0.0.0.0 --port <port>`.

## 5. ini contract — `models-preset.ini`

The browser builds the whole file as a string and POSTs it; `/launch-presets` writes the bytes
verbatim next to the binary and spawns it. Recorded files: `fixtures/ini/J4-launch-presets/*.ini`,
`fixtures/ini/J4b-ui-presets-launch/presets-from-ui.ini`.

- Line format is exactly `key = value` (one space each side), each line ended by `\n`; nothing quoted,
  nothing escaped, no `key=` without a value except the trailing line below.
- First line `version = 1` then a blank line, before the first section.
- One `[<config name>]` section per entry of `JSON.parse(localStorage.llamaCppConfigs)`, in
  **insertion order**, each followed by a blank line — including after the last section.
- Keys in emission order, with the field each value comes from: `model`←`modelPath`,
  `mmproj`←matched model, `temp`, `c`←`contextSize`, `top-k`, `top-p`, `min-p`, `repeat-penalty`,
  `presence-penalty`, `ngl`, `threads`, `n-cpu-moe`, `cpu-moe` (literal `true`), `parallel`,
  `load-mode`, `no-kv-offload` (literal `true`), `no-mmproj-offload` (literal `true`), `cache-ram`,
  `jinja` (literal `true`), `chat-template-kwargs`, `chat-template-file`←derived from `modelPath`,
  `verbose` (literal `true`), `backend-sampling` (literal `true`), `fa`←`fastAttention` (any truthy
  value including `auto`, unlike argv — Q9), `model-draft`←`draftModelPath` (not-recorded: no recorded
  section had a draft path), `ngld` (not-recorded: no recorded draft block), `ctkd` (not-recorded: no
  recorded draft block), `ctvd` (not-recorded: no recorded draft block), `spec-type`,
  `spec-ngram-size-n` (literal `24`), `draft-min` (literal `48`), `draft-max` (literal `64`),
  `spec-draft-n-max`, `reasoning`←`reasoning`, or legacy `disableReasoning` when `reasoning` is absent
  (Q17 — the argv path ignores that key, so `--reasoning` is missing while the ini has it).
- Boolean fields are written as the literal text `true`, never `1` or `on`.
- **Trailing orphan line (Q10):** after the loop a final `port = <settings.serverPort>` line is
  appended with no section header, so the file ends with a key that belongs to no section. It is also
  what the log pane prints before the append, so the printed preset text and the posted bytes differ by
  exactly that line (`fixtures/ini/J4b-ui-presets-launch/presets-claims.json`).
- ini key names diverge from the CLI flag names for `model`↔`-m`, `model-draft`↔`-md`,
  `spec-ngram-size-n`↔`--spec-ngram-mod-n-match`, `draft-min`↔`--spec-ngram-mod-n-min`,
  `draft-max`↔`--spec-ngram-mod-n-max`. `mmproj`↔`--mmproj` and `fa`↔`-fa` differ only by dashes
  (kept in the pack as `nameDivergences.model`, not as real divergences).
- Flags with no ini key at all: `--swa-full`, `-ctk`, `-ctv`.
- A saved enum value that is missing from the current `<option>` list blanks the control on load, so
  the key is dropped from both outputs (Q18) — do not add a fallback value.

## 6. Socket choreography

- Transport: socket.io on the manager's own HTTP server, `cors: { origin: "*" }`. The page connects
  with a bare `io()` call, so it inherits the page origin.
- The client connects **only after** a successful `POST /start`, `POST /restart` or
  `POST /launch-presets`, and the connect function returns immediately if a socket already exists. On
  a successful `POST /stop` the client calls `socket.disconnect()` and clears its handle, so the next
  launch creates a fresh connection.
- Server→client events, and only these three:
  - `log-stream` with payload `{ type: "stdout" | "stderr", data: <string> }`. `data` is
    `chunk.toString()` of **one raw pipe chunk** — no line splitting, no re-joining. Recorded payload
    sizes on the recorded connection are the fake server's 7-byte chunks
    (`fixtures/ws/J5-ui-log-cap/events.json`), so N source lines arrive as many events.
  - `server-ended` with payload `{ message: "Server process has ended" }`, emitted from the child's
    `close` handler. Recorded payloads: `fixtures/ws/J3-start-stop/events.json`,
    `fixtures/ws/J3b-exit-code/events.json`.
  - `server-error` with payload `{ message: <String(err.message) or 'Server process error'> }`,
    emitted from the child's `error` handler (not-recorded: no recorded connection carried it — the
    crash journey ends in `server-ended`; Phase 4 must force an `error` event).
- There is **no** `server-started` event: the page learns a launch succeeded from the HTTP response,
  never from the socket.
- Client→server: no custom events at all. `connect` and `disconnect` are socket.io-level; on the
  server each `connect` pushes the socket onto a module-level array and `disconnect` splices it out,
  and every emit iterates that array (`client.emit`, no `io.emit`, no rooms).
- Pane behaviour the suites assert: each `log-stream` payload becomes **one** pane line after
  `.trim()`, so a boundary inside a word yields two lines and a whitespace-only payload yields a blank
  line. The pane is capped at 1000 lines by splitting `textContent` on `\n` and keeping the tail, then
  pinning `scrollTop = scrollHeight` (`fixtures/ws/J5-ui-log-cap/log-pane.json`).

## 7. Process lifecycle and the races that are requirements

- Spawn: `child_process.spawn(executable, args, { stdio: 'pipe' })` with no `shell` option, at three
  sites (start, restart, launch-presets). Recorded child launches:
  `fixtures/argv/*.jsonl` (23 records, each with the exact argv the manager built).
- Kill: `runningProcess.kill('SIGTERM')`, then a 1000 ms timer that re-reads the module variable and
  sends `SIGKILL` if `!killed`. `runningProcess = null` runs synchronously right after arming the
  timer, so the timer usually sees `null` and never fires — reproduce it, do not "fix" it (Q23).
- `/status` reports `running: !!runningProcess && !runningProcess.killed`.
- Q24 (`/restart`): the replacement process is assigned, then the killed child's `close` handler runs
  and clears `runningProcess`, so `POST /restart` answers `200 success:true` while `/status` settles
  on `running:false` and the following `POST /stop` answers `success:false` — recorded verbatim in
  `fixtures/http/J3d-restart/restart-settle.json` and
  `fixtures/http/J3d-restart/status-immediately-after-restart.response`.
- Child stdout/stderr: forwarded verbatim, each `data` event one `log-stream` event; nothing is
  buffered to line boundaries.
- Exit code: printed, never interpreted — the exact text is
  `Server process exited with code <code>` (including `null` for a signal-killed child).
- `lastLaunchConfig` (`{ serverPath, args }`) lives in memory only and is written by `/start`; that is
  why `/restart` answers 400 after a manager restart (Q4).
- Metrics: a 1000 ms interval collects `{ cpu, ram, gpu, vram }` samples into **two** independent
  50-point histories (server-side `systemMetrics.*.history` and the page's `chartData`); keep both.
  `os-utils` sampling is a window, not an instantaneous read.

## 8. Cross-stack semantics traps (plan.md §9)

1. JS coercion and `Number.prototype.toString()` shortest round-trip → `coercion-shim`, tested against
   `fixtures/vectors/format/vectors.jsonl`. `parseInt('')` → `NaN` → stored as `null`.
2. Log chunk boundaries: forward raw pipe chunks, `.trim()` per event in the page.
3. `spawn(exe, args)` without a shell: reproduce Node/libuv Windows argv quoting for spaces and quotes
   (`fixtures/vectors/format` and `fixtures/argv/J5-ui-launch/probe-stand-in.json` explain the
   stand-in binary the recordings used).
4. Synchronous `nvidia-smi` with a 1 s cadence; failure triggers are a missing binary, a non-zero exit,
   or an unexpected CSV shape — the last one parses to `0` values **without** throwing (Q6,
   `fixtures/http/J2b-metrics-garbage/shape-note.json`).
5. `os-utils` sampling window.
6. `Object.keys` / `Object.entries` insertion order from `JSON.parse(localStorage…)` drives ini section
   order; the rendered list is separately `.sort()`ed (§9 trap 6,
   `fixtures/localstorage/J6-corpus-smoke/config-list.json`).
7. Two independent 50-point metric histories.
8. `/metrics` `vramUsage` string format `${total-free}/${total}`.
9. 1000-line log cap plus `scrollTop = scrollHeight`.
10. Q19 loose zero predicates on `minP` / `repeatPenalty` / `presencePenalty`: `0`, `"0"`, `"0.0"`,
    `"0.00"` are four different cases, and the corpus contains all four.
11. Q20 path separators are stored verbatim with mixed `\` and `/`; the client-side
    `--chat-template-file` derivation regex accepts both, so output depends on input style.
12. Q21 truthy-but-broken paths are emitted as-is (one corpus draft path ends in `\undefined`).
13. Q22 nonsense-but-truthy values (`topK: -1`, `ngl: 100`, `topP: 0`) follow the predicates above, not
    sanity.
14. Q13 native dialogs and a full `location.reload()` after the settings save; Q1 the `Restart` button
    exists but is permanently disabled because its listener is commented out.

Seam-only behaviours that only the L3 suite catches: `mmproj` matched against the `window.models` list
from the last `/models` fetch · `settings.serverPort` split between `localStorage` (client) and
`settings.json` (server, broken by Q2) · the `--port` split between `/start` and `/launch-presets` ·
`--chat-template-file` built client-side by `\`-concatenation onto a server-returned path · the ini is
built in the browser and written verbatim by the server.

## 9. Fixture and suite entry points

- `fixtures/BASELINE.json` — pinned tag/commit and source hashes; the static derivation reads the
  sources out of git with `git show parity-baseline:<path>` and checks them against this file.
- `fixtures/MANIFEST.json` — what each recording is and which journey wrote it.
- `fixtures/COMPARISON.json` — per-field comparison mode (`exact` default, `shape` for the
  nondeterminism rows in plan.md §8). Suites read this, never hard-code a mode.
- `fixtures/PATH-MAP.json` (+ gitignored `fixtures/corpus/.pathmap-local.json`) — `FIXTURE_ROOT`
  tokens for corpus paths; `fixtures/corpus/configs.remapped.json` / `settings.remapped.json` are the
  48 real-state configs (plan.md §9A).
- `fixtures/vectors/{boundary,cover,format,random,corpus}/vectors.jsonl` and
  `fixtures/goldens/**` — generator inputs and legacy goldens for the pure arg/ini builders.
- `fixtures/http/**` raw request+response bytes, `fixtures/ws/**` ordered socket events,
  `fixtures/localstorage/**` storage dumps, `fixtures/screenshots/**` DOM state,
  `fixtures/argv/**.jsonl` real spawn vectors, `fixtures/ini/**` recorded preset files.
- Recording/capture and generators live in `tools/parity/` (`capture-legacy.js`,
  `fake-llama-server.js`, `nvidia-smi-stub/`, `gen-vectors.js`, `gen-goldens.js`, `equivalence.js`,
  `load-corpus.js`); the SPEC derivations are `tools/parity/spec-static.js`,
  `tools/parity/spec-runtime.js`, `tools/parity/spec-reconcile.js` (+ `spec-common.js`,
  `spec-facts.js`, `spec-pack.js`, `spec-runtime-evidence.js`, `spec-runtime-pairing.js`).
- Suite-facing environment variables the fakes already honour: `PARITY_ARGV_LOG` (append each spawn's
  argv as JSONL), `PARITY_BIND_LOG`, `NVIDIA_SMI_STUB_MODE` (`ok` / `garbage` / `fail`), and
  `PARITY_CSC` for the stand-in compiler. Suites must take base URL, socket URL, binary path, model
  directory and nvidia-smi mode from env only, and must never import app code (plan.md §6).
- `/tests/` is created by Phase 4 (`L0-generators` … `L4-dualrun`); the identical suites run against
  legacy and candidate, which is what makes this pack stack-agnostic.

## 10. How to check a rebuild

1. `node tools/parity/spec-static.js`, then `spec-runtime.js`, then `spec-reconcile.js`: the pack must
   rebuild and reconcile must exit 0 with `unreconciled=0`, `fieldGate=41/41`, `buildFrom=0`,
   `openApi=0`.
2. Replay `fixtures/goldens/**` against the candidate's pure arg/ini builders: byte equality where
   `fixtures/COMPARISON.json` says `exact`, shape equality where it says `shape`.
3. Run the L1–L4 suites against the candidate on port 7837 with the fixture tree. Every field of
   `SPEC/field-manifest.json` carries `pointers` naming the derivation files and the recording that
   proves it.
4. Anything this doc marks `not-recorded:` is Phase 4 test debt: capture it from legacy, re-record the
   golden, and let the pack re-derive. Never hand-edit a fixture, a golden, or `SPEC/SPEC-ROWS.*`.

