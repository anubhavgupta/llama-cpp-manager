# task-remediate3.md — disposition M5 (L3.CORPUS-INI-token-bytes truncation race) + M4

Input: tools/parity/reports/AUDIT-2026-11-25/re-audit-2-m1m2.md (= run 00cb5245 report, archive first)
Rules: parity-lock exclusivity, no PARITY/AGENTS/plan edits (supervisor lands ledger), per-N commits,
scratch only, kill spawned procs, checkpoint after each step.

M5 MAJOR: checks/corpus.js:322-334 resolves waitForIniChange (helpers/sandbox.js:216-224) on ANY byte
change then reads once; fs.writeFileSync truncates-then-writes => reader in the window sees 0 bytes.
Signature: 'expected 19386 bytes, got 0', byte 0, actual ""; L3.CORPUS-INI-TOKEN-WRITTEN passes in the
same check run. 2 independent occurrences (re-audit-2 fire 19:11:31Z durable log; delta-auditor.md N1
standalone observation at 6eb25f4). 7 green on-demand exposures — load/timing sensitive.
Fix (harness, Verifier-owned): waitForIniChange must require NON-EMPTY and STABLE-ACROSS-TWO-POLLS
(equal bytes read twice with a small margin) before resolving; on mismatch the check dumps the actual
byte count + leading bytes (N5 machinery). No golden/assertion changes — expectations stay oracle bytes.
Then: N-repeat the FULL L3 gate --repeat 2 x5 consecutive green incl at least one under a load burner
(the class is load-sensitive); plus 2 full nightlies green. Commit red-fire log
tools/parity/reports/nightly/nightly-2026-11-25T19-11-31Z.log as M5 evidence (F13 additive).
PARITY-EVIDENCE.csv: no new quirk row (harness race, not app behavior) — report wording for the
supervisor's ledger row instead.

M4 MINOR: stat-cache noise leaves ' M PARITY.md' with empty diff. Clear with git add PARITY.md
(same blob). Add to your closing checks: git status porcelain empty except untracked nightly logs.

Close: schtasks fires until 2 CONSECUTIVE Last Result 0. Report: fix diff, N-repeat table, fire logs,
ledger wording for M5 disposition (quarantine NOT needed if the fix + repeats hold).
