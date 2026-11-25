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
