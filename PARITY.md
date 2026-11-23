# PARITY.md — parity ledger (llama-cpp-manager port)

Machine-owned state. Statuses: `baseline-open` → `baseline-verified` → `diff-open` → `pass`
(`quarantine` for flakes with captured traces, `blocked` with an `ESCALATION.md` entry — never `pass`, never skipped).
No `wontfix` may exist anywhere. Builder may not edit `status`; Verifier flips it only on machine evidence.

Rows seeded from plan §8 (Q1–Q15) and §9A (Q16–Q22). `frozen-by` names the artifact in
`tests/`/`fixtures/` that must go red if the behavior changes.

| ID | Quirk | Location | Frozen by | Status | Evidence |
|----|-------|----------|-----------|--------|----------|
| Q1 | Restart button rendered but permanently disabled (listener commented out) | index.html:390, script.js:1186,1190 | L2 UI assert `disabled === true` in all states | baseline-open | |
| Q2 | POST /settings TDZ bug — existing settings never read; serverPort falls back to 8080 | server.js /settings | L1 POST-without-serverPort → file says 8080 even if it said 7838 | baseline-open | |
| Q3 | /start while running → 200 `success:false`; missing path → 400 | server.js /start | L1 contract tests, both branches | baseline-open | |
| Q4 | /restart → 400 after manager restart (`lastLaunchConfig` in-memory only) | server.js /restart | L1 process integration test | baseline-open | |
| Q5 | `--port` from settings.serverPort on /start; DEFAULT_PORT 8080 on /launch-presets | server.js, script.js | L1/L3 dual-path argv test | baseline-open | |
| Q6 | GPU/VRAM are Math.random() off-Windows / on nvidia-smi failure | server.js:getSystemMetrics | L1 shape test (range+type, never real values or zeros) | baseline-open | |
| Q7 | saveCurrentValues ≠ launchServer field sets; launchServer re-reads DOM, not saved config | script.js:213,409 | L2 config-then-launch argv test | baseline-open | |
| Q8 | deleteConfiguration partial reset to hard-coded list diverging from HTML defaults | script.js:1111 | L2 snapshot of all 41 values incl. those NOT reset | baseline-open | |
| Q9 | fastAttention `<select>` read via `.value`; `auto` → bare `-fa` | index.html:266 | L1 boundary argv vectors auto/on/off | baseline-open | |
| Q10 | ini keys `spec-ngram-size-n`/`draft-min`/`draft-max` ≠ CLI `--spec-ngram-mod-*`; trailing `port = ` | script.js | ini byte diff goldens | baseline-open | |
| Q11 | settings.serverPort never changes manager port (hard-coded 7837) | server.js:11 | L1 port assertion | baseline-open | |
| Q12 | External Google Fonts `<link>`; no service worker | index.html:7-8 | L2 asset/DOM test (no offline support added) | baseline-open | |
| Q13 | Native alert/confirm; location.reload() after settings save | script.js | L2 Playwright dialog handlers | baseline-open | |
| Q14 | `-fit off` and `--host 0.0.0.0` always appended | script.js | argv goldens (every vector ends with both) | baseline-open | |
| Q15 | ngram-mod emits hard-coded 24/48/64 | script.js | argv + ini vectors | baseline-open | |
| Q16 | Orphan keys persist in localStorage, never read, dropped on re-save | corpus (8 keys, 28/48 configs) | corpus re-save byte test, both states | baseline-open | |
| Q17 | ini reads legacy `disableReasoning` when `reasoning` absent → ini has `reasoning`, argv omits `--reasoning` | corpus (15 configs) | corpus ini+argv pair | baseline-open | |
| Q18 | Saved enum value missing from `<option>` list silently blanks on load → flag dropped from argv | corpus (`loadMode`: dio/mlock/none) | per-config corpus argv test | baseline-open | |
| Q19 | repeatPenalty/presencePenalty stored as numbers AND strings; `!= "0"` treats 0/"0"/"0.0"/"0.00" differently | corpus (22 num + 26 str) | corpus vectors + format probes | baseline-open | |
| Q20 | serverPath/modelPath mix `\` and `/` verbatim; client chat-template regex output varies by input style | corpus (11 mixed-separator paths) | argv vectors both styles | baseline-open | |
| Q21 | Truthy-but-broken paths emitted as-is (e.g. trailing `\undefined`), no validation | corpus (1 draft path) | corpus argv test | baseline-open | |
| Q22 | topK:-1, ngl:0, ngl:100, topP:0 occur in real data; emission follows predicates, not sanity | corpus | corpus argv tests | baseline-open | |

| Q23 | POST /restart returns 200 success:true, but the killed child's close handler nulls module-level `runningProcess` after the replacement is assigned ⇒ /status settles `running:false`, next /stop returns 200 success:false, and the deferred SIGTERM→1s→SIGKILL timer (server.js:437-445) reads the same variable — replacement survival is a win32 race. GET /restart is Express 404, not app JSON. Recorded on win32 | server.js /restart | fixtures/ws/J3d-restart/* + argv/J3d-restart/* (shape: race ordering; bytes: all else) | baseline-open | captured 2026-11-23 |

| Q24 | /stop arms SIGTERM→1s→SIGKILL on the module-level `runningProcess`, so a relaunch within ~1 s can be killed by the stale timer (harness waits 1.5 s where relaunch follows stop — legacy behavior recorded, not worked around) | server.js /stop | fixtures/http/J3* relaunch pair + ws order trace | baseline-open | captured 2026-11-23 |

Non-determinism addenda discovered during capture (beyond §8): dotenv v17 prints a rotating marketing tip into manager stdout; manager stdout interleaves its own console.log with forwarded child chunks in OS write order ⇒ manager console logs recorded complete, byte claims live in paired ws payload traces. Corpus recordings are comparable only with the same `PARITY_SCRATCH` root (documented in MANIFEST).

## Ledger notes (machine-auditable history)

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

Out of scope (C2 dead code, recorded not ported): `createDefaultConfigName` (script.js:205),
client `restartServer` (script.js:968). `/restart` HTTP endpoint IS live and must be ported.
