# PARITY.md — parity ledger (llama-cpp-manager port)

Machine-owned state. Statuses: `baseline-open` → `baseline-verified` → `diff-open` → `pass`
(`quarantine` for flakes with captured traces, `blocked` with an `ESCALATION.md` entry — never `pass`, never skipped).
No `wontfix` may exist anywhere. Builder may not edit `status`; Verifier flips it only on machine evidence.

Rows seeded from plan §8 (Q1–Q15) and §9A (Q16–Q22). `frozen-by` names the artifact in
`tests/`/`fixtures/` that must go red if the behavior changes.

| ID | Quirk | Location | Frozen by | Status | Evidence |
|----|-------|----------|-----------|--------|----------|
| Q1 | Restart button rendered but permanently disabled (listener commented out) | index.html:390, script.js:1186,1190 | L2 UI assert `disabled === true` in all states | baseline-verified suite checks: L2:fields L2:socket-events L2:q1-states | |
| Q2 | POST /settings TDZ bug — existing settings never read; serverPort falls back to 8080 | server.js /settings | L1 POST-without-serverPort → file says 8080 even if it said 7838 | baseline-verified suite checks: L1:L1.SETTINGS.TDZ-PORT-8080 L3:L3.PORT-q2-resets-file-to-8080 | |
| Q3 | /start while running → 200 `success:false`; missing path → 400 | server.js /start | L1 contract tests, both branches | baseline-verified suite checks: L1:L1.START.MISSING-PATH-400 L1:L1.STOP.WHILE-IDLE-200 L1:L1.START.ALREADY-RUNNING-200 L1:L1.RESTART.OK-200-TRUE (+1 more) | |
| Q4 | /restart → 400 after manager restart (`lastLaunchConfig` in-memory only) | server.js /restart | L1 process integration test | baseline-verified suite checks: L1:L1.RESTART.NO-CONFIG-400 L1:L1.RESTART.AFTER-MANAGER-RESTART-400 L1:L1.PRESETS.RESTART-STILL-400 | |
| Q5 | `--port` from settings.serverPort on /start; DEFAULT_PORT 8080 on /launch-presets | server.js, script.js | L1/L3 dual-path argv test | baseline-verified suite checks: L1:L1.PRESETS.SEED-PORT-7838 L1:L1.PRESETS.DEFAULT-PORT-BYTES L1:L1.PRESETS.ARGV-PORT-8080 L1:L1.PRESETS.EXPLICIT-PORT-7838 (+4 more) | |
| Q6 | GPU/VRAM are Math.random() off-Windows / on nvidia-smi failure | server.js:getSystemMetrics | L1 shape test (range+type, never real values or zeros) | baseline-verified suite checks: L1:L1.METRICS.SIMULATED-SHAPE L1:L1.METRICS.SIMULATED-NOT-REAL L1:L1.METRICS.GARBAGE-ZEROS L1:L1.METRICS.GARBAGE-RECORDED-NOTE (+1 more) | |
| Q7 | saveCurrentValues ≠ launchServer field sets; launchServer re-reads DOM, not saved config | script.js:213,409 | L2 config-then-launch argv test | baseline-verified suite checks: L3:L3.CORPUS-argv-goldens L2:q7-launch L2:corpus-launch | |
| Q8 | deleteConfiguration partial reset to hard-coded list diverging from HTML defaults | script.js:1111 | L2 snapshot of all 41 values incl. those NOT reset | baseline-verified suite checks: L2:crud-edit-delete | |
| Q9 | fastAttention `<select>` read via `.value`; `auto` → bare `-fa` | index.html:266 | L1 boundary argv vectors auto/on/off | baseline-verified vectors+goldens (gen-goldens --check 20 entries) + mutation proofs (tools/parity/reports/mutation/) | |
| Q10 | ini keys `spec-ngram-size-n`/`draft-min`/`draft-max` ≠ CLI `--spec-ngram-mod-*`; trailing `port = ` | script.js | ini byte diff goldens | baseline-verified suite checks: L1:L1.PRESETS.INI-BYTES L3:L3.CORPUS-INI-bytes L3:L3.CORPUS-INI-token-bytes L3:L3.INI-presets-from-ui-bytes (+1 more) | |
| Q11 | settings.serverPort never changes manager port (hard-coded 7837) | server.js:11 | L1 port assertion | baseline-verified suite checks: L1:L1.PORT.HARD-CODED-7837 L3:L3.SETTINGS-point-at-tree L3:L3.ARGV-port-from-localStorage-settings L3:L3.PORT-Q11-manager-still-7837 | |
| Q12 | External Google Fonts `<link>`; no service worker | index.html:7-8 | L2 asset/DOM test (no offline support added) | baseline-verified suite checks: L2:fields L2:state-snapshots | |
| Q13 | Native alert/confirm; location.reload() after settings save | script.js | L2 Playwright dialog handlers | baseline-verified suite checks: L3:L3.CORPUS-Q18-alert L3:L3.PORT-cancel-keeps-localStorage L2:dialogs L2:corpus-alerts | |
| Q14 | `-fit off` and `--host 0.0.0.0` always appended | script.js | argv goldens (every vector ends with both) | baseline-verified suite checks: L2:default-port | |
| Q15 | ngram-mod emits hard-coded 24/48/64 | script.js | argv + ini vectors | baseline-verified vectors+goldens (gen-goldens --check 20 entries) + mutation proofs (tools/parity/reports/mutation/) | |
| Q16 | Orphan keys persist in localStorage, never read, dropped on re-save | corpus (8 keys, 28/48 configs) | corpus re-save byte test, both states | baseline-verified suite checks: L3:L3.CORPUS-resave-bytes L3:L3.CORPUS-resave-orphans L2:crud-create L2:crud-orphans (+2 more) | |
| Q17 | ini reads legacy `disableReasoning` when `reasoning` absent → ini has `reasoning`, argv omits `--reasoning` | corpus (15 configs) | corpus ini+argv pair | baseline-verified suite checks: L3:L3.CORPUS-INI-bytes L2:corpus-ini | |
| Q18 | Saved enum value missing from `<option>` list silently blanks on load → flag dropped from argv | corpus (`loadMode`: dio/mlock/none) | per-config corpus argv test | baseline-verified suite checks: L3:L3.CORPUS-launched-count L3:L3.CORPUS-argv-goldens L3:L3.CORPUS-Q18-alert L2:corpus-launch (+1 more) | |
| Q19 | repeatPenalty/presencePenalty stored as numbers AND strings; `!= "0"` treats 0/"0"/"0.0"/"0.00" differently | corpus (22 num + 26 str) | corpus vectors + format probes | baseline-verified suite checks: L3:L3.CORPUS-argv-goldens L2:corpus-launch | |
| Q20 | serverPath/modelPath mix `\` and `/` verbatim; client chat-template regex output varies by input style | corpus (11 mixed-separator paths) | argv vectors both styles | baseline-verified suite checks: L3:L3.CORPUS-argv-goldens L3:L3.CORPUS-spawn-target L3:L3.CORPUS-INI-token-bytes L3:L3.ARGV-chat-template-file-separators (+1 more) | |
| Q21 | Truthy-but-broken paths emitted as-is (e.g. trailing `\undefined`), no validation | corpus (1 draft path) | corpus argv test | baseline-verified suite checks: L3:L3.CORPUS-argv-goldens L3:L3.CORPUS-spawn-target L2:corpus-launch | |
| Q22 | topK:-1, ngl:0, ngl:100, topP:0 occur in real data; emission follows predicates, not sanity | corpus | corpus argv tests | baseline-verified suite checks: L3:L3.CORPUS-argv-goldens L2:corpus-launch | |

| Q23 | POST /restart returns 200 success:true, but the killed child's close handler nulls module-level `runningProcess` after the replacement is assigned ⇒ /status settles `running:false`, next /stop returns 200 success:false, and the deferred SIGTERM→1s→SIGKILL timer (server.js:437-445) reads the same variable — replacement survival is a win32 race. GET /restart is Express 404, not app JSON. Recorded on win32 | server.js /restart | fixtures/ws/J3d-restart/* + argv/J3d-restart/* (shape: race ordering; bytes: all else) | baseline-verified suite checks: L1:L1.RESTART.GET-IS-EXPRESS-404 L1:L1.RESTART.STATUS-SETTLES-FALSE L1:L1.RESTART.STOP-AFTER-RESTART-200-FALSE L1:L1.RESTART.ARGV-GAINED-ONE-SPAWN (+2 more) | captured 2026-11-23 |

| Q24 | /stop arms SIGTERM→1s→SIGKILL on the module-level `runningProcess`, so a relaunch within ~1 s can be killed by the stale timer (harness waits 1.5 s where relaunch follows stop — legacy behavior recorded, not worked around) | server.js /stop | fixtures/http/J3* relaunch pair + ws order trace | baseline-verified suite checks: L1:L1.STOP.STALE-TIMER-WINDOW L1:L1.PRESETS.STOP-AFTER-DEFAULT-PORT | captured 2026-11-23 |

Non-determinism addenda discovered during capture (beyond §8): dotenv v17 prints a rotating marketing tip into manager stdout; manager stdout interleaves its own console.log with forwarded child chunks in OS write order ⇒ manager console logs recorded complete, byte claims live in paired ws payload traces. Corpus recordings are comparable only with the same `PARITY_SCRATCH` root (documented in MANIFEST).

## Ledger notes (machine-auditable history)

- 2026-11-23 LANDED (supersedes the authorized-scope entry below): mutation-gap promotions applied.
  6 gap killers promoted as permanent boundary vectors (`boundary/shrunk-mutation.jsonl` + baseline-recorded
  goldens + 104 row claims in `coverage-promotions.json`). Battery: 706 mutants → **648 killed (91.78%) + 58
  machine-proven equivalent, 0 gaps, 0 unresolved** — ceiling with zero synthesized-only survivors.
  Scope refinement by the worker (better than my authorization, accepted): `coverage-exceptions.json` was NOT
  edited (it is regenerated by gen-vectors; hand-edits would break `--check`) — instead the two structural
  killers were promoted with a recorded row-flipping field earning real credit (0 rowless vectors).
  gen-goldens.js +14 lines (promotedFiles manifest coverage), MANIFEST regen proven byte-identical pre-change.
  Verifier re-gate: gen-goldens/gen-vectors --check, equivalence, --verify all GREEN; leak scan CLEAN.

- 2026-11-23 DONE (clears the PENDING entry below): NEUTRAL-ROOT RE-RECORD executed from `parity-baseline`
  (C5-compliant): scratch root now `C:/parity-scratch`; 193 files re-recorded, determinism OK (148 exact +
  24 shape), MANIFEST regenerated (193/193 hashes re-verified independently by Verifier), SPEC re-derived
  (unreconciled=0), leak-check CLEAN across fixtures+SPEC (237 files). Remaining username occurrences = the
  exempt oracle-truth constant `C:\Users\anubh\.lmstudio\models` emitted by legacy code itself (server.js
  default; recorded bytes may not be sanitized, C5) plus derived quotes of it.
- 2026-11-23 RESOLVED (clears the QUARANTINE entry below): `logPane.startsWithTimestamp` — measured 8×
  legacy-vs-legacy: cap-head prefix is decided by pipe coalescing counters (§8 chunk boundaries), invariant
  under quiescence (pane reads identical 8/8 while ISO/bare entry counts vary every run) ⇒ masked in exactly
  the capped state with the existing digit-masking idiom (`<chunk-boundary>`), plus a new deterministic
  pane-level claim `anyEntryTimestamped`; 9 uncapped fingerprints keep the real boolean. COMPARISON.json
  NOT touched — no new shape rule, no relaxation of a pinned assertion. Backed by capture-legacy producer
  change + this entry.

- 2026-11-23 PENDING (planned, Verifier-owned): (1) re-record fixtures/{http,ws,argv,ini,localstorage,screenshots}
  from a NEUTRAL default `PARITY_SCRATCH` root (e.g. `C:/parity-fix/`) — recorded bytes embed
  `C:\Users\<user>\AppData\Local\Temp\parity-scratch` paths (username exposure + same-root comparability
  limitation noted in MANIFEST); recorded bytes may not be edited (C5) so a from-tag re-record is the only
  lawful fix, bundled with (2). (2) flake-protocol fix for quarantined `logPane.startsWithTimestamp` (mask the
  derived boolean in render fingerprints + `shape` rule with this entry as backing). (3) `fixtures/vectors/**`
  inputs tokenized to `SCRATCH_ROOT/` (vectors are authored inputs — tokenization lawful; goldens regenerated
  from baseline for tokenized inputs; literal-path coverage kept via username-free absolute paths).
  Leak scanner: tools/parity/leak-check.js (from scratchpad); exception list documents the legacy `.lmstudio`
  constant as oracle truth. After the re-record, REGENERATE SPEC from-runtime/pack (its quoted evidence paths
  currently carry the old scratch root — 13 leak-check hits, all derived artifacts, tokenizable by
  regeneration; legal to regenerate because only fixtures/goldens are uneditable recorded bytes).

- 2026-11-23 `bdd883e` — AUTHORIZED FIXTURE RE-RECORD (C8 backing entry): added journey `J4b-ui-presets-launch`
  because no recorded journey had ever produced app-generated `models-preset.ini` bytes (the ini generator had
  zero live coverage). Full re-record FROM `parity-baseline` (C5: recorded, not authored): 180→193 fixtures,
  `MANIFEST.json` regenerated, `HASH-PIN.json` refreshed (0 pins dropped, +1 `EXTRACT-PROOF.json`). Of 31 moved
  files, 0 were exact-mode. Authorization: supervisor decision recorded in worker report; proof:
  `fixtures/EXTRACT-PROOF.json` (sliced differential re-run independently green by Verifier; live A/B
  byte-identity 96/96 exact + 27 declared-shape).
- 2026-11-23 QUARANTINE (flake protocol §6.4): `screenshots/J5-ui-log-cap/log-pane-*.render.json →
  logPane.startsWithTimestamp` — exact-mode boolean derived from which 7-byte stream fragment survives the
  1000-line cap; flips 1-in-5 between legacy-vs-legacy recordings (traces in `EXTRACT-PROOF.json → knownFlake`
  and proof logs). Class: §8 websocket log chunk boundaries. Status `quarantine`, NOT skipped: captured traces
  exist; fix = mask the derived boolean in the render fingerprint (like digits masking) with a `shape` rule +
  this entry as backing, applied at the next harness re-record. All sibling exact assertions unchanged.
- 2026-11-23 AUDITOR FLAG: `tools/parity/ast-inventory.js` re-pointed BA/INI region roots from `public/script.js`
  inline blocks to `legacy/lib/*.js` after extraction (else 189 checklist rows silently vanish). Row count 333
  and row-id set preserved; file/line columns drifted by design. Also `server.js` +1 line serving `/lib` —
  part of candidate surface, must be ported.

- 2026-11-24 C8 L2 LANDING (Verifier): new golden family `fixtures/goldens/resave/` (inputs.jsonl +
  inputs.manifest.json + goldens.jsonl) recorded from the `parity-baseline` settings page by
  `tests/L2-ui/record-inputs.js` (command recorded in inputs.manifest.json; C5). `fixtures/vectors/MANIFEST.json`
  refreshed (gen-goldens --check: VERIFIED 20 entries, prior goldens byte-identical). `fixtures/HASH-PIN.json`
  re-pinned accordingly (partially swept early into 34644b1, completed at landing; additions + expected hash
  refreshes only, zero gate-artifact drops). L2 suite self-test GREEN against legacy (corpus round-trip
  48/48 argv+serverPath+form-sha, resave bytes/Q16, ini order all-48 + 2-config both seeds, Q18 alert-block
  mode 48/48). `tests/L2-ui/out/DISAGREEMENTS.md`: 28/48 browser-vs-goldens divergences classified
  (Q16/Q17/Q18/Q19 + speculationType); no golden moved (C4).

- 2026-11-24 C8 VERIFIER HARNESS FIX + SUITE PINNING (Verifier): (a) `tests/L2-ui/helpers/page.js`
  in-repo-sandbox guard was dead code — `normalized.startsWith(REPO.toLowerCase()+sep)` never
  matches a drive-lettered candidate; fixed to lowercase the candidate (measured: REFUSED, no dir
  leak). (b) `tests/L2-ui/run.js` static server leaked on browser-launch failure (runner zombie,
  held port); now closed before rethrow. (c) Worker claim "`--ref <dir>` does not serve that dir"
  DISPROVED by decisive probe (mutated `#addConfigBtn` in served dir ⇒ `crud-create` RED); retained
  as measurement, no code change. HASH-PIN re-pin: hashes for (a)/(b) + new pinned gate artifacts
  tests/L3-seam, tests/L4-dual, tools/parity/{negative-controls.js,nightly/*}. Evidence:
  `fixtures/NEGATIVES.md` 6/6 red-as-named; nightly GREEN 400 s (L1+L2+L3+L4); ParityNightly 03:00
  registered (schtasks /query Ready).

- 2026-11-24 VERIFIER SWEEP (Verifier): all 24 quirk rows flipped `baseline-open` ⇒
  `baseline-verified` citing machine evidence — per-row check ids from
  `tools/parity/reports/PARITY-EVIDENCE.csv` (extracted from the three suites' check tables; each
  suite green in self-test against `parity-baseline`: L1 63/63, L2 full corpus+resave+ini,
  L3 29/29, L4 self-mode 0 diffs). Q9/Q15 cite the argv/ini vector gate instead of a Q-tagged UI
  check (goldens baseline-recorded, `gen-goldens --check` 20 entries, mutation-proven rows in
  `tools/parity/reports/mutation/`). No row flipped without at least one named machine artifact.

Out of scope (C2 dead code, recorded not ported): `createDefaultConfigName` (script.js:205),
client `restartServer` (script.js:968). `/restart` HTTP endpoint IS live and must be ported.
