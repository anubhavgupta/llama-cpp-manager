# task-remediate.md — close AUDIT-2026-11-25 findings (blocker 1, majors 2–6, minors 7–13)

Input: tools/parity/reports/AUDIT-2026-11-25/{static-auditor.md, executor-auditor.md}.
Rules: AGENTS.md + SPEC/BUILD-FROM.md role notes. You own candidate/harness code; you do NOT touch
PARITY.md status column or AGENTS.md (supervisor lands those). Scratch: C:/parity-scratch ONLY.
One executor at a time: if any C:/parity-scratch process exists when you start, STOP and report.

Fixes (each = its own commit, message cites finding number):
1. sandbox.js bash paths (F1+F2): stop handing winPath backslash strings to PATH `bash`. Use
   forward-slash absolute paths (bash accepts `C:/...` for script args and inside git-bash; verify
   WSL-bash case too or normalize via cygpath when available). Fix BOTH buildFixtureTree (~166-170)
   and unlockTree (~369-374). Prove: PATH restricted to System32+mingw64 (no usr/bin) like the
   auditor's repro — `--only contract` self-test green, and scratch cleanup succeeds afterwards
   (models/unreadable ACL-deny removed via unlock path, not luck).
2. Nightly (F7+F9): run-nightly.js passes `--repeat 2` to L2 and L3 gates; exit code = count of red
   gates (assert it) OR amend install-nightly.sh header wording — prefer real exit-count contract.
   Make nightly durable: write logs to tools/parity/reports/nightly/nightly-<utc>.log via a .gitignore
   exception line `!tools/parity/reports/nightly/*.log` (F13); L1 must also persist a run summary json
   into that dir (F13).
3. Pins (F5+F6): hash-pin.sh pin_list := source + fixtures + vectors + SPEC + tools/parity/*.js +
   tools/parity/nightly/*.js + tools/parity/reports/mutation/mutants.json + fixtures/NEGATIVES.md.
   DROP tests/*/out/** and fixtures/corpus/.pathmap-local.json. Re-pin; supervisor adds the C8
   ledger row — list in your report exactly which pin entries were added/dropped.
4. Mutation regions + controls (F4): mutate.js regionSources() += `server` (server.js whole-file
   region) and `save` (saveCurrentValues span; ANCHORS.SAVE_START exists in negative-controls.js).
   Regenerate mutants, run mutation-run/equiv-prove (kill or prove every new mutant; no gap), then add
   negative controls: >=1 red-as-named through L1 (server.js region mutant), >=1 through L2 (mutated
   app dir via `--ref <dir>` — the disproven-claim path; also CORRECT the false comment at
   negative-controls.js:41-45), >=1 targeting L4 diff capability (mutate ini generator, assert L4
   A-vs-B report shows a field diff). fixtures/NEGATIVES.md grows; keep existing 6 rows.
5. server-error (F10): new L1 socket check: POST /start with unspawnable serverPath, assert emitted
   `server-error` payload shape/bytes as legacy emits (record legacy behavior first from
   parity-baseline sandbox — C5: this is runtime evidence, not invention; if legacy emits nothing,
   assert nothing and record that finding in CHECKS.md instead of inventing an assertion).
6. Docs (F8+F11+F12 + reviewer 9-12): load-corpus.js emits fixtures/corpus/MANIFEST.json with
   producedBy; COMPARISON.json §6.3 backing artifact written to tools/parity/reports/COMPARISON-BACKING.md
   (quote determinism-gate rerun output LIVE); BUILD-FROM §10.2 scope note re goldens/corpus 28/48;
   run.js:362 wording: partial-run RED must say "SELF-TEST GUARD: only N assertions (<200 required)".
   DO NOT edit AGENTS.md/plan.md (supervisor's ledger-backed edit).

Gates before you report: full nightly GREEN (interactive) + your F1 schtasks-PATH proof + one REAL
scheduled fire `schtasks /run /tn ParityNightly` ending Last Result 0 with log in the new durable
location + negative-controls --all all rows red-as-named + gen-goldens/spec-reconcile/verify-manifest
--check green + hash-pin regeneration diff-stable (only pinnedAt/self). Kill spawned procs; report
per-finding status table + pin delta + new mutant/kill stats.

## REMAINING (worker-1 context exhausted at HEAD 1e7d43f; everything above = fce8339..1e7d43f)

Done: F1+F2 (fce8339), F7+F9+F13 (eb5d27e), F4-save channel 59 mutants 57 killed + 2 machine-proven
(new strategy unreachable-element-guard-fallback, 05c815a), F10 server-error probed-then-asserted
(d133974), F4 L1+L2 controls + false-comment fix (93ceb1e), F5+F6 pin rewrite +78/-28 UNPINNED-
pending-regen (1e7d43f). Ledger rows worker-1 needs from supervisor: see list in
C:\Users/anubh\.pi\agent\sessions\--C--projects-Cline-demo--\subagent-artifacts\e8a8c382-f796-45c2-943b-ad7822448c78_worker_output.md.

Remaining (this spec still governs; same ownership/exclusivity rules):
R1. SERVER-REGION-ENUMERATION.json + tools/parity/tasks/task-server-mutation.md stub + server/save
    section into REPORT.md GENERATOR (equiv-prove writeReport), status enumerated-unrun; server
    mutants NOT in shipped inventory (supervisor ruling 2026-11-25).
R2. F3 concurrency lock: C:/parity-scratch/.parity-lock (O_EXCL + pid + stale>45min takeover w/ log);
    every suite/nightly/negative-controls entrypoint acquires/releases; refuse-and-report when held.
R3. F11 fixtures/corpus/MANIFEST.json via load-corpus.js --emit (producedBy command line inside).
R4. F12 wording: L2 run.js partial-run guard prints explicit "SELF-TEST GUARD: only N assertions
    (<200)" instead of bare SELF-TEST RED.
R5. F13 tail: .gitignore exception + confirm nightly durable logs land (verify, don't re-do if
    already present from eb5d27e).
R6. Final sequence IN ORDER, single-threaded: negative-controls --all (now 8 rows incl L1/L2;
    NEGATIVES.md regenerates) -> restricted-PATH proof -> interactive nightly GREEN -> gen-goldens
    --check -> gen-vectors --check -> spec-reconcile -> verify-manifest -> bash tools/parity
    hash-pin.sh LAST (captures all new artifacts incl NEGATIVES regen + corpus MANIFEST) -> report
    exact pin added/dropped vs 1e7d43f.
R7. schtasks /run /tn ParityNightly -> wait for Last Result 0 + durable log. NOTE: run this FIRST in
    the morning? No: run after everything lands; if 03:00 auto-fire happens mid-work it is expected
    RED/garbage — trust only your manual /run AFTER your commits, and record Last Run/Result.
Known flake watch: L1.SOCKET.RELAY-BYTES-IDENTICAL flaked ONCE under concurrency (worker-1); under
strict lock re-run should be stable; if it flakes again: quarantine protocol.
