# task-remediate2.md — close re-audit findings N1–N5 (verdict NO-GO at 6eb25f4/f1282a9)

Input: C:\Users\anubh\.pi\agent\sessions\--C--projects-Cline-demo--\subagent-artifacts\a94cba27-575f-44e1-9b59-e63921f1a0be_worker_output.md
Rules: same as task-remediate.md (exclusivity, ownership, one-executor lock, per-N commits).
The 13 original findings are CLOSED — do not re-do them.

N1 BLOCKER — L3 red 3/3 in FULL nightly sequence; green standalone (2/2), green --only l1,l3,
green --only l2,l3; one standalone red on L3.CORPUS-INI-token-bytes byte 0 (unreadable excerpts,
see N5). /status never running=true + click throw at page.js:75 via stop→launchAll.
Protocol (plan §6.4/§7): (a) reproduce N-repeat (>=4 full-sequence runs, background logs, capture
FULL scratch logs of at least 2 reds into tools/parity/reports/nightly/traces/ before any clean
wipes them); (b) root-cause by bisection — which predecessor gate (L1/L2/L4-parallelism? load?
tree rebuild timing? WSL powershell timing under load? startup timeout vs load?) — instrument,
don't guess; (c) FIX the underlying sensitivity (e.g. load-aware startup waits, tree rebuild
serialization) rather than raising a timeout blindly — timeouts are legitimate ONLY with a measured
load-vs-duration justification recorded in a comment; (d) if a residue is genuinely nondeterministic
after root-cause work: quarantine with traces + COMPARISON shape rule via supervisor landing (never
skip); (e) 3 consecutive GREEN full nightlies (interactive) + 2 green schtasks /run fires to close.
Also land the honest correction: the PARITY 'GREEN scheduled fire closes criterion' row must be
re-opened by supervisor once your commits land (report the needed wording; do not edit PARITY).

N2 MAJOR (C8) — pins not clone-stable: working-copy CRLF vs blob LF on 4 files pinned during
remediation (AGENTS.md/PARITY.md/plan.md/spec-static.js). Fix properly: make hash-pin.sh hash
TRACKED files from the git INDEX (git show :path) so entries are clone-stable; add a real
--check mode (exit 1 on drift, listing offenders; usable by nightly + Auditor) that compares index
hashes AND disk drift for untracked; renormalize EOL for the 4 files (.gitattributes eol=lf +
renormalize commit) so working copy matches; regenerate pins; prove: fresh `git worktree add
--detach` clone -> hash-pin.sh --check GREEN with zero drift; then README's "HASH-PIN verify
--check" reference becomes true. Wire --check into run-nightly as a cheap pre-gate.

N3 MINOR — negative-controls --all dirties tracked .logs (elapsed-time + throwaway-commit sha
volatile). Mask volatiles at WRITE time (normalized durations, fixed placeholder for throwaway
shas) so re-runs are byte-stable; prove with two --all runs leaving git status clean.

N4 MINOR — red nightly not diagnosable from durable log (slice(-25), FAIL lines lost). Persist the
FULL per-gate scratch logs next to the summary (nightly/ dir, tracked) or raise retained tail to
cover every FAIL + first-difference line; prove from a synthetic red (--selftest red path) that
the failure is diagnosable from the durable log alone.

N5 NIT — checks/corpus.js:334 negative slice prints empty excerpts; clamp to 0 and re-verify the
failing-excerpt path prints real bytes (unit-prove via the existing diff helper).

Final sequence (order fixed): N5 (unblocks readable N1 traces) -> N1 -> N2 -> N3 -> N4 -> full
nightly 3x + schtasks /run 2x (require Last Result 0, logs durable) -> hash-pin regen LAST with
--check proving clone-stability in a fresh worktree -> equiv-prove --selftest, verify-manifest,
gen-goldens --check, restricted-path-proof (all under lock). Report per-N table + traces inventory
+ needed PARITY wording for the reopened/re-closed criterion.
