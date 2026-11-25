## Verdict: **NO-GO** for releasing Part 2

Everything I could execute, I executed. The oracle *content* is clean under independent re-execution; the *cadence/plumbing* is not, and teeth-coverage is incomplete.

### Gates: executed vs sampled
**Executed end-to-end by me (1–10, none substituted from committed reports):** 1 nightly L1–L4, 2 gen-goldens --check, 3 spec-reconcile, 4 MANIFEST 193-file re-hash, 5 hash-pin regeneration+diff, 6 negative-controls --all, 7 schtasks query, 8 git state, 9 PARITY evidence audit (all 24 rows parsed programmatically; the 8 required mechanisms + 2 re-derivations), 10 C5 provenance (3 families + byte spot-checks). **Bonus:** `gen-vectors.js --check` and `equiv-prove.js` (plan §5 "independently re-proven" item the static reviewer could not run).

```
node tools/parity/nightly/run-nightly.js --log <scratch>/audit-nightly.log
  PASS L3 164.9s exit=0 | PASS L4 64.3s exit=0 | verdict GREEN — all gates green (404 s)
  (L1/L2 blocks were deleted from my scratch log mid-run by a peer's cleanTree, so I re-ran them:)
  node tests/L1-backend/run.js --verify-against-selftest -> 63 passed, 0 failed in 91.6 s  EXIT=0
  node tests/L2-ui/run.js --verify-selftest            -> 433/433 assertions  L2 SELF-TEST GREEN EXIT=0
node tools/parity/gen-goldens.js --check   -> "MANIFEST: VERIFIED 20 entries / GOLDENS REPRODUCIBLE" exit=0
node tools/parity/spec-reconcile.js        -> gates: unreconciled=0 fieldGate=41/41 buildFrom=0 openApi=0  PASS
                                             (CONSISTENCY.md + RECONCILE-STATS.json byte-identical to committed)
node tools/parity/verify-manifest.js       -> pairs 193 ok 193 missing 0 mismatch 0  exit=0
bash tools/parity/hash-pin.sh (then git checkout) -> moved: pinnedAt, self-hash, and exactly 6
   volatile tests/*/out files. ZERO drift in fixtures/**, goldens, vectors, corpus, tests source, SPEC,
   AGENTS.md, plan.md, PARITY.md, MANIFEST/COMPARISON/BASELINE/PATH-MAP.
node tools/parity/negative-controls.js --all -> 6/6 red-as-named; regenerated fixtures/NEGATIVES.md was
   BYTE-IDENTICAL to the committed file (0 diff lines); restored.
node tools/parity/gen-vectors.js --check   -> GEN-VECTORS REPRODUCIBLE exit=0 (6.9 s)
node tools/parity/equiv-prove.js           -> EQUIV-PROVE GREEN; 58 survivors == 58 proofs, 0 unresolved
   gaps, kill-check 2752 vectors x 2 channels 0 disagreements; all proof files byte-unchanged (deterministic)
schtasks /query /tn ParityNightly /v /fo LIST -> Ready, Daily 03:00, Next 26-11 03:00,
   Last Run 25-11 03:00:01, Last Result: 1
git: HEAD a500322 (migration); git diff (tracked, excl .pi) empty
```
**Re-derivations (item 9):** re-hashed `fixtures/goldens/boundary/goldens.jsonl` (`a1c129d8…`), `boundary/vectors.jsonl` (`5f94f038…` — equals the golden header's own `vectors_sha256`), `fixtures/http/J3d-restart/restart-before-any-launch.response`, `fixtures/ws/J3d-restart/event-identity.json`, `fixtures/corpus/configs.remapped.json` (equals its HASH-PIN entry). Re-ran `L1 --only contract` → `PASS [Q2] L1.SETTINGS.TDZ-PORT-8080` (7838→8080) + `PASS [Q11] L1.PORT.HARD-CODED-7837`, 16/16; `L2 --only corpus-launch` → 150/150 (Q18/Q19/Q21/Q22). Re-derived Q9/Q15 from raw bytes: `fastAttention=auto` → bare `-fa`, `on/off` → `-fa on|off`; ngram-only vector → `24/48/64` and ini keys `spec-ngram-size-n`/`draft-min`/`draft-max`. Ledger status column: 24/24 `baseline-verified`, zero blocked/quarantine/diff-open/wontfix; `ESCALATION.md` header-only.

### Findings

1. **BLOCKER — the scheduled nightly is red; Part-1 exit criterion "nightly … installed and green" is not met.** `Last Result: 1` at `Last Run 25-11-2026 03:00:01`; the matching log block is `verdict RED — L1,L3,L4 red (95 s)` at `2026-11-24T21:30:01Z` (= 03:00 IST), failing on `/bin/bash: C:projectsCline-demotoolsparityfixture-tree.sh: No such file or directory`. **Reproduced end-to-end through the real code path**, not just read: with a schtasks-like PATH (System32 + `Git\mingw64\bin`, no `Git\usr\bin`), `node tests/L1-backend/run.js --verify-against-selftest --only contract` emits that exact string at `tests/L1-backend/lib/sandbox.js:170`; `bash` under that PATH resolves to WSL `GNU bash 5.2.21 x86_64-pc-linux-gnu`, and `winPath` (sandbox.js:26) hands it backslashes. No ledger entry, no fix, no quarantine. Next fire 26-11 03:00 will be red again. (The two GREEN blocks in the log are interactive-shell runs.)
2. **MAJOR — the same `bash`+`winPath` pattern also breaks cleanup, and its failure is sticky.** `unlockTree()` (sandbox.js:369-374) shells to `fixture-tree.sh … unlock` with `stdio:'ignore'`; when that silently no-ops, the deliberate ACL-deny fixture `models/unreadable` makes `fs.rmSync(scratch,{recursive:true})` fail. Measured live: three consecutive runs died with `EPERM, Permission denied: \\?\C:\parity-scratch`, and `rm -rf` from bash also failed (`cannot remove '…/models/unreadable': Permission denied`); only `bash tools/parity/fixture-tree.sh C:\parity-scratch\fixtures clean` recovered it. Fixing finding 1's build path without fixing the unlock path leaves a permanently-poisoned scratch root.
3. **MAJOR — no concurrency control on the shared scratch root/ports; my audit ran alongside a second executor.** A peer worker (`7964b51e`, commit `a500322` "Auditor relaunch as executor" landed 08:33 **mid-audit**) was executing gates in the same `C:/parity-scratch`; it deleted my `--log` file mid-run (it sits in the scratch root, which every gate `cleanTree`s) and produced the EPERM races. Two executors can each manufacture false reds. HEAD movement was orchestration-only (`tools/parity/tasks/WATCHDOG.json`, +5/-3; zero gate files), so my results still apply to `a500322`.
4. **MAJOR — teeth coverage incomplete (plan §2 Phase 4 "prove L1–L4 each go red").** All 6 controls ran L3 (`layer: 'L3'` ×6; my run invoked `tests/L3-seam/run.js` six times). L1/L2/L4 have zero controls, and the recorded reason for skipping L2 is contradicted by PARITY.md's own 2026-11-24 "DISPROVED by decisive probe" entry. Reviewer findings 2 and 3 confirmed against a live tree.
5. **MAJOR (C8) — the pin file pins nothing that decides red.** `grep -cE '"(tools/parity|fixtures/NEGATIVES)' fixtures/HASH-PIN.json` → `0`, while PARITY.md 2026-11-24 claims "new pinned gate artifacts … `tools/parity/{negative-controls.js,nightly/*}`". `negative-controls.js`, `run-nightly.js`, `mutate.js`, `mutants.json`, `hash-pin.sh` and `fixtures/NEGATIVES.md` are freely editable with no trip.
6. **MAJOR (C8 auditability) — the pin set contains volatile/gitignored paths.** Pinned `tests/*/out/{run-1.json,report.json,report.md,observations-*.json}` (6 entries) change content on every legitimate run and cannot be restored from git; `fixtures/corpus/.pathmap-local.json` is gitignored and machine-local (on a fresh clone that pin *drops* rather than mismatches). Real tampering hides inside expected churn. Mitigating measurement: my own gate runs moved **only** those 6 + `pinnedAt` + self-hash — nothing else.
7. **MINOR — exit-code contract doesn't match reality.** `install-nightly.sh` says "exits with the number of red gates" and `run-nightly.js` returns `failing.length`, yet a 3-gate-red night recorded `Last Result: 1`. Nonzero detection still works.
8. **MINOR — immutable requirement docs are behind the ledger:** `AGENTS.md:19` "quirks Q1–Q22" and `plan.md:149` "all 15 quirks" vs PARITY.md's Q23/Q24 rows; `AGENTS.md` is hash-pinned so the fix is Auditor-visible.
9. **MINOR — flake protocol:** L2/L3 `CHECKS.md` declare the gate as `--repeat 2`/×2; `run-nightly.js` passes no `--repeat` (log: "1 consecutive run(s)").
10. **MINOR — `server-error` is unasserted server-side** (`grep -rln server-error tests/` → only `L2-ui/checks/runtime.js`); my L1 run passed `L1.SOCKET.EVENT-FAMILIES` over events `["connect","log-stream"]`. A candidate that never emits it goes green. BUILD-FROM §6 flagged this as Phase-4 debt that was never paid.
11. **MINOR (C5) — `fixtures/corpus/*.remapped.json` appear in neither manifest** (0 matches in `fixtures/MANIFEST.json` and `fixtures/vectors/MANIFEST.json`); provenance is only `PATH-MAP.json#generatedBy`.
12. **MINOR — partial-run wording:** `L2 --only corpus-launch --verify-selftest` printed `SELF-TEST RED` with `150/150 assertions passed` (run.js:362 requires total > 200). Correct guard, misleading wording in logs.
13. **MINOR (evidence hygiene) —** L1 persists no run artifact (scratch is deleted on success), and `tools/parity/reports/nightly.log` is gitignored (`*.log`; only `fixtures/**` unignored) — the cadence evidence trail is neither version-controlled nor durable.

### Correct (independently verified)
Fixture/golden/SPEC integrity: 193/193, 20/20 goldens reproducible, vectors reproducible, spec 0 unreconciled + 41/41 fields, NEGATIVES.md byte-reproducible, 58/58 equivalence proofs re-derived with 0 unresolved gaps, ledger statuses honest, ESCALATION.md empty, C5 `producedBy` command+env present on all 193 entries. The static reviewer's findings 1–12 hold; only its "could not execute" half is now closed.

### Cleanup
No processes left behind (`node.exe` list contains only pi/MCP processes); ports 7837/7838/8080/7841/7842/7847/1783x free; `git worktree list` = main only; `C:/parity-scratch` removed by the final successful run; `fixtures/HASH-PIN.json` and `fixtures/NEGATIVES.md` restored to committed bytes; only `.pi/subagents/schedules/parity-watchdog/*` is dirty (orchestrator-owned churn, present before I started).

Recommended next step: one ledger-backed verifier commit that (a) resolves `bash` via `cygpath -u`/forward slashes in both `buildFixtureTree` and `unlockTree` (sandbox.js:169,172), (b) extends `pin_list` with `tools/parity` + `fixtures/NEGATIVES.md` and drops `tests/*/out` and gitignored paths, (c) adds `--repeat 2` to the nightly L2/L3 gates, then **require one green *scheduled* fire** (`schtasks /run /tn ParityNightly`, Last Result 0) plus one L1 and one L2 negative control before re-auditing.