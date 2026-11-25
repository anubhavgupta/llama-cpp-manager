# PART 1 — cold-start comprehension audit (entry point: SPEC/BUILD-FROM.md)

Written from the repo's own docs only: `SPEC/BUILD-FROM.md` → `AGENTS.md`, `PARITY.md`, `plan.md`,
`SPEC/*`, `tools/parity/tasks/README.md`, `tests/*/CHECKS.md`, `README.md`. HEAD 9c52f75, branch
`migration`, tag `parity-baseline` = a8f1130.

## What the product does (as the docs describe it)

A local, browser-based manager for `llama-server.exe` (llama.cpp) on Windows. One Node/Express
process listens on a hard-coded `http://localhost:7837` (Q11 — `settings.serverPort` never moves it)
and serves a same-origin static SPA (`public/index.html`, `public/script.js`, a `/lib` static mount)
plus 11 JSON routes + one socket.io endpoint on the same server. The user can:

- point the app at a models directory (`GET /models` walks it recursively for `.gguf`, associates an
  `mmprojFile`);
- create/edit/delete named model configurations — a 41-field form whose state lives in
  origin-scoped `window.localStorage` (`llamaCppSettings`, `llamaCppConfigs`; config name = object key);
- launch the binary with an argv **built in the browser** and POSTed to `/start` (the manager spawns it
  verbatim, no shell, and streams stdout/stderr over socket.io into a 1000-line log pane);
- write `models-preset.ini` — again **built in the browser** — next to the binary via
  `POST /launch-presets` and spawn llama.cpp's own preset mechanism;
- watch CPU/RAM (os-utils) + GPU/VRAM (`nvidia-smi` execSync, 1 s cadence) charts.

## What "parity" means here, and which quirks are requirements

`AGENTS.md` / plan §0: the legacy app at tag `parity-baseline` is correct **by definition** (C4).
Parity = bug-for-bug, byte-for-byte user-visible output; no fixes, no improvements, no scope change.
Every quirk row in `PARITY.md` (Q1–Q25 — plan §9's Q1–Q22 plus Q23/Q24 races and Q25 the
Windows `spawn EINVAL` environment row) is a **requirement**. The ones a rebuild most often "fixes"
by accident: Q2 `/settings` TDZ (omitted `serverPort` persists 8080), Q3 `/start`-while-running
answers **200 with `success:false`**, Q4 `/restart` 400 after a manager restart (`lastLaunchConfig` is
memory-only), Q5 the `--port` split between `/start` and `/launch-presets`, Q6 simulated
`Math.random()` GPU/VRAM on nvidia-smi failure, Q7 `launchServer` re-reads the DOM not the saved
config, Q8 partial delete reset ≠ HTML defaults, Q9 `auto` → bare `-fa`, Q10 trailing orphan
`port = ` line + ini key name divergences, Q12 external Google Fonts and **no** service worker,
Q13 native `alert`/`confirm` + `location.reload()`, Q14 `-fit off` / `--host 0.0.0.0` always appended,
Q15 hard-coded `24/48/64`, Q16 orphan keys neither read nor cleaned but dropped on re-save,
Q17 ini emits `reasoning` where argv omits it, Q18 retired enum values blank silently,
Q19 four different zero forms under `!= "0"`, Q20/Q21/Q22 verbatim paths and nonsense-but-truthy
values, Q23 `/restart` settles `running:false`, Q24 the stale SIGTERM→1 s→SIGKILL timer.
Nondeterminism (plan §8 + `fixtures/COMPARISON.json`) is compared by `shape`, everything else `exact`.

## How the oracle is structured

- **Recorded fixtures** (`fixtures/`, C5: recorded from legacy, never authored): `BASELINE.json`
  (tag/commit + source hashes), `MANIFEST.json` (196 hash-pinned pairs = 193 fixtures + 3 corpus),
  `COMPARISON.json` (per-field `exact`/`shape`), `PATH-MAP.json` + `corpus/` (the 48 real user configs,
  remapped so byte equality is machine-portable), `HASH-PIN.json` (143 gate paths, checked against the
  git **index**), `NEGATIVES.md`, `EXTRACT-PROOF.json`. Layers: `http/` request+response bytes,
  `ws/` ordered socket events, `argv/` real spawn vectors (23), `ini/` recorded preset files,
  `localstorage/`, `screenshots/`.
- **Vectors → goldens**: `fixtures/vectors/{boundary,cover,format,random,corpus}/vectors.jsonl`
  (+ promoted `boundary/shrunk-mutation.jsonl`) are fully-specified 41-field inputs; the goldens
  (`fixtures/goldens/`, same families + `resave/`) are legacy's **ordered argv array + ini bytes**.
  The two pure generators were extracted to `legacy/lib/{buildArgs,buildPresetIni}.js` with a
  behavior-preservation proof, so goldens are replayable without a running app.
- **Suites** (env-driven, black-box, never import app code — enforced by a gate in each runner):
  **L1** backend E2E over HTTP + `socket.io-client` against a running manager (64 checks);
  **L2** Playwright UI with every backend call replayed from recordings, manager never runs (corpus
  round-trip 48/48, resave bytes, ini order); **L3** seam — real browser + real manager + stand-in
  `.exe` (29 checks; the only layer that sees the 5 seam-only behaviors); **L4** dual-run differential
  of two git refs, `--self-mode` (A=B=tag) must produce zero diffs — the "harness adds no noise" gate.
- **Mutation ceiling**: 765 mutants over the pure generators + save channel, 705 killed + 60
  machine-proven equivalent (17 static, 43 exhaustive-dynamic), **0 gaps**; per-survivor proofs in
  `tools/parity/reports/mutation/proofs/`. **Negative controls** (8 rows in `fixtures/NEGATIVES.md`)
  apply a real behaviour change to a scratch worktree and require the named assertion to go RED —
  that is where the oracle earns trust before any candidate exists.
- **Pins / one-executor rule**: `hash-pin.sh --check`, `verify-manifest.js`, `leak-check.js`,
  `parity-lock.js` (a single holder on `C:/parity-scratch` + the 7837–7847 ports; children get
  `PARITY_LOCK_HELD`).

## The commands a candidate must satisfy, in order

The nightly ladder (from `tools/parity/nightly/run-nightly.js:6-11`) is the real ordered contract:

```
bash tools/parity/hash-pin.sh --check                      # pre-gate; a red refuses the fire
node tools/parity/verify-manifest.js                       # 196/196 recorded bytes
node tools/parity/spec-reconcile.js                        # unreconciled=0, fieldGate 41/41
node tests/L1-backend/run.js --verify-against-selftest     # legacy self-test (candidate: --attach)
node tests/L2-ui/run.js --verify-selftest --repeat 2       # gate form is --repeat 2
node tests/L3-seam/run.js --verify-against-selftest --repeat 2
node tests/L4-dual/run.js --self-mode                      # A=B: zero diffs
node tests/L4-dual/run.js --ref-a parity-baseline --ref-b <candidate-ref>
node tools/parity/negative-controls.js --all               # 8/8 red-as-named
```

BUILD-FROM §10 orders it as: (1) rebuild SPEC + reconcile, (2) replay goldens against the candidate's
own pure builders, (3) run L1–L4 against the candidate on 7837 with the fixture tree, (4) anything
marked `not-recorded:` is test debt to be captured from legacy — never hand-edit a fixture/golden.

## Cutover rule

plan §10 + §3 step 6: retiring legacy and taking `:7837` is the one irreversible, shared-state action.
Everything up to a staged, atomic, pre-tested `cutover.sh` + `rollback.sh` (tested against fixture
copies) is automated; **execution needs exactly one explicit human go**. Blast-radius limits: work only
on `migration`, no pushes elsewhere, no history rewrites, never touch the real `settings.json` /
`models-preset.ini` / model dirs — fixture copies only. Gate for Part 2 = Auditor go with zero
`diff-open` and zero `blocked` rows.

## Where the docs were wrong / stale / ambiguous / silent (severity-tagged)

See `part1-doc-defects.md` (same directory) for the full list with file:line.
