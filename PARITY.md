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

Out of scope (C2 dead code, recorded not ported): `createDefaultConfigName` (script.js:205),
client `restartServer` (script.js:968). `/restart` HTTP endpoint IS live and must be ported.
