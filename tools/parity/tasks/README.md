# Resume manifest — Part 1 orchestration state

If the supervising session restarts, resume from here. Durable state = git commits +
`PARITY.md` (ledger) + `fixtures/HASH-PIN.json` + `fixtures/MANIFEST.json` + `tools/parity/reports/`.
Task specs in this directory are the exact prompts each worker phase ran on.

Harness affordance, not recorded behavior: L3 re-posts a launch request once when the manager logged
Windows' `spawn EINVAL` for that exact spawn (measured ~1 per 55 attempts here, capped per fire) — the
Part-2 candidate gets no exemption from re-deriving anything because of it, and a spawn failure under a
candidate run is the candidate's own red.

## Done (verify by re-running the gate commands, not by trusting this file)

| Phase | Commit | Gate command(s) |
|---|---|---|
| 0 freeze | 92c52a2 | `bash tools/parity/freeze-baseline.sh` (must reproduce BASELINE.json content), `bash tools/parity/hash-pin.sh` diff-clean |
| 1a fakes/tree/corpus | 022dd13 | `node tools/parity/selftest-fake.js` (19), `bash tools/parity/selftest-tree.sh` (44), `node tools/parity/selftest-corpus.js` (861) |
| 1b capture + re-records | 833afd1, 6a9994e | `bash tools/parity/capture-legacy.sh --verify-determinism` (~5 min, 193 fixtures), `node tools/parity/verify-manifest.js` (193/193), `node tools/parity/leak-check.js fixtures SPEC` CLEAN |
| 2 inventory | 3998c78 | `node tools/parity/ast-inventory.js --check && node tools/parity/ast-inventory.js --selftest` |
| 2.1 extraction proof | 4578af9..4e67e90 | `node tools/parity/preservation-proof.js --differential`; full `preservation-proof.sh` |
| 2.3–2.5 vectors/goldens | 9d6a767 (+promotions 657bce5) | `node tools/parity/gen-vectors.js --check`, `gen-goldens.js --check`, `equivalence.js`, `equivalence.js --verify`, `equivalence.js --selftest` (<60 s) |
| 2.6 mutation ceiling | 657bce5 | see `tools/parity/reports/mutation/REPORT.md` gates (mutate/mutation-run/equiv-prove --selftest + 7 report gates); 648/706 killed + 58 proven, 0 gaps |
| 3 SPEC pack | 9e34878 (+re-derive 6a9994e) | `node tools/parity/spec-reconcile.js` → unreconciled=0; `SPEC/CONSISTENCY.md` |
| 4 L1 backend suite | 34644b1 | `node tests/L1-backend/run.js --verify-against-selftest` (~100 s) green ×3; 64 checks |

## IN FLIGHT

(none) — both audits complete (NO-GO; archived in tools/parity/reports/AUDIT-2026-11-25/). Remediation batch next.

## Landed since launch

| Phase | Commit | Gate |
|---|---|---|
| 4b L2 UI suite | ca7fa8e | `node tests/L2-ui/run.js --verify-selftest` GREEN vs legacy; corpus 48/48; DISAGREEMENTS.md 28/48 classified; C8 resave re-pin row in PARITY.md |
| 5 L3 seam + L4 dual + nightly + negatives | 5563efb | L3 `--verify-against-selftest` GREEN; L4 `--self-mode` GREEN (62 fields, 0 diffs); `negative-controls.js --all` 8/8 red-as-named (fixtures/NEGATIVES.md); ParityNightly 03:00 registered |
| 5b Verifier harness fixes + pin sweep | 174201e + ff4eff0 | in-repo scratch guard REFUSED (was dead code); zombie closed; C8 row; L3/L4 pinned |

## REMAINING (exit sequence, no builders left)

0. DONE 2026-11-25: REMEDIATION rounds 1+2 (AUDIT-2026-11-25 findings 1-13 CLOSED per delta audit;
   N1-N5 closed by remediation-2, green interactive + SCHEDULED fires banked).
1. DONE 2026-11-25: PARITY sweep 24/24 baseline-verified (+Q25 environmental row, harness affordance).
2. Delta re-audit #2 (N1-N5 closure verification + no-regression battery) — RUNNING (a94cba27 successor).
3. Exit checklist plan SS2 re-run inside that audit: L1-L4 self-tests, gen-goldens --check, spec-reconcile,
   mutation ceiling, MANIFEST 196/196, HASH-PIN --check (incl. fresh-worktree clone-stability), ESCALATION empty.
4. Auditor cold-start go/no-go (fresh context, BUILD-FROM.md only).
5. Report Part-1 verdict to user. Part 2 needs separate authorization.

## Next after L3/L4 (specs ready)

1. `task-l3l4.md` — L3 seam suite (real server+browser+fake), L4 dual-run scaffold with self-mode (A=B=tag ⇒
   empty diff), nightly job (schtasks, 03:00), negative controls (mutant patches ⇒ named reds ⇒ fixtures/NEGATIVES.md).
2. Part-1 exit checklist (plan §2): L1–L4 100% green vs legacy; NEGATIVES.md complete; mutation at ceiling
   (done); SPEC-ROWS fully mapped (done); all PARITY rows → baseline-verified (needs L-suite evidence per row);
   corpus round-trip green (L2/L3); nightly installed + green.
3. Auditor pack: fresh-context go/no-go per plan §5.

## Supervisor notes (durable lessons)

- Provider hangs (UND_ERR_BODY_TIMEOUT / silent 300s+ freezes) hit several times/day: recovery =
  interrupt → (pause notice) → resume with "continue from disk state, do not redo green work". All workers
  carry checkpoint/resume + medium-turn instructions.
- Ownership discipline: fixtures/SPEC/PARITY/HASH-PIN/capture-legacy are Verifier-owned; workers get explicit
  additive exceptions in writing (see PARITY.md ledger notes for each C8-sanctioned change).
- Windows facts baked into tooling: no SIGTERM delivery to node children (TerminateProcess), .cmd unspawnable
  without shell (CVE-2024-27980), stand-in = csc-compiled relay exe with KILL_ON_JOB_CLOSE job object;
  scratch root default `C:/parity-scratch`.

## Watchdog procedure (standing instructions — executed by scheduled watchdog, and by the SUPERVISOR session)

Supervisor standing orders (apply on every subagent_control_notice):
1. First "idle 300s" notice for a worker: check log mtime + local compute (node/chrome via
   `Get-CimInstance Win32_Process`); if active → no action.
2. SECOND stall notice for the SAME worker within 15 min, or any silence >12 min with no compute:
   interrupt → on pause notice, resume with "continue from disk state, do not redo green work".
3. Keep `WATCHDOG.json` tracked list exact at every worker launch/pause/landing (add run ids;
   move finished ones out — the watchdog never edits this file itself).
4. Overnight rule: a worker silent >30 min is presumed dead regardless of notices (provider hangs
   have frozen runs for 9+ h).
5. REPEATED "bash open 240s" notices for the same worker while local compute is alive = normal
   long suite/mutant runs (worker redirects output to scratchpad logs). Do NOT inspect per notice;
   act only on (a) completion notice, (b) watchdog STALL (>stallAfterMin silence AND no compute),
   or (c) needs-attention with NO compute for two consecutive notices.

Watchdog worker procedure (runs every 20 min via schedule `parity-watchdog`):
NOTE: the watchdog worker may LACK subagent control tools. Therefore it DETECTS AND REPORTS;
the supervisor session (woken by the schedule's non-quiet completion) performs interrupt/resume.
1. Read `tools/parity/tasks/WATCHDOG.json`; for each tracked id read
   `C:/Users/anubh/AppData/Local/Temp/pi-subagents-user-anubh/async-subagent-runs/<id>/status.json`
   (state, lastActivityAt, turn/tool counts) and output-0.log mtime.
2. Freshness = newer of (status activity) and output-0.log mtime under
   `C:/Users/anubh/AppData/Local/Temp/pi-subagents-user-anubh/async-subagent-runs/<id>/output-0.log`.
   Local compute check: node/chrome whose CommandLine matches the layer keyword (L1/L2/tests/parity).
3. Stall = freshness older than the entry's stallAfterMin AND no local compute. Then:
   write `tools/parity/reports/watchdog-alert.json` = {at, id, layer, freshMin, state, evidence}
   and END THE RUN WITH THE FIRST LINE `STALL <id8> <layer> freshMin=<n>` (this wakes the supervisor,
   who interrupts/revives per the standing orders above). If control tools ARE available, the
   watchdog may itself: `interrupt`; poll ≤4 min for paused; `resume` with message: "Watchdog
   auto-revival: provider stall detected <UTC>. Continue your task spec from disk state (see this
   README + git status); do not redo green work; medium turns." and log the action instead.
4. Log one line per tracked id per fire to `tools/parity/reports/watchdog.log`:
   `<UTC> <id8> <layer> <state> <freshMin> <action>`.
5. Never touch ignoreIds, completed runs, or files outside watchdog.log. If a control action is
   denied, log it and move on. Finish within ~5 minutes.
