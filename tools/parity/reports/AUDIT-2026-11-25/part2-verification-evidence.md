# PART 2 — mechanical verification evidence (cold-start auditor, executor)

Repo `C:/projects/Cline-demo`. Started at HEAD `9c52f75` (branch `migration`); HEAD advanced to
`8f88df3` mid-run by the supervisor ("Cold-start audit launched", "Bank the 00:24Z green
scheduled-fire log"). Delta `9c52f75..8f88df3` = 1 banked nightly log + `tools/parity/tasks/WATCHDOG.json`
— **no** `fixtures/`, `tests/`, `SPEC/`, `PARITY.md`, `AGENTS.md`, `plan.md` byte.

## Exclusivity (taken before anything ran)

| check | result |
|---|---|
| `node tools/parity/parity-lock.js --status` before | `not held: C:\parity-scratch\.parity-lock does not exist` |
| local compute scan (Win32_Process node.exe) | 4 node procs, all agent/MCP tooling; no `tests/` or `tools/parity` run |
| listening ports 7837-7847 | none |
| `node tools/parity/parity-lock.js --selftest` | `PARITY-LOCK SELFTEST GREEN` — second holder refused, >45 min takeover printed, `PARITY_LOCK_HELD` children neither acquire nor release, acquired by all 7 scratch-owning entrypoints, a live L4 `--self-mode` in a separate process refused by name |
| acquire as `cold-start-auditor(Part1+2 verification)` | `held: pid 33464 (cold-start-auditor…) since 2026-11-25T22:18:13Z` |
| attempted second holder while held | `PARITY-LOCK-HELD: … One executor runs on C:/parity-scratch at a time …` |
| release at end | `not held: C:\parity-scratch\.parity-lock does not exist` |

All children ran with `PARITY_LOCK_HELD=1` (the documented holder-child contract), sequentially —
one executor owns `C:/parity-scratch` and ports 7837-7847.

## Gate results (all commands run by me; full stdout in this directory)

| # | command | exit | verdict / key numbers |
|---|---|---|---|
| 1 | `git ls-files PARITY.md plan.md AGENTS.md --eol` | 0 | `i/lf w/lf attr/text eol=lf` for **all three** (AGENTS.md, PARITY.md, plan.md) |
| 2 | `bash tools/parity/hash-pin.sh --check` | 0 | `HASH-PIN CHECK GREEN — 143 paths recomputed from the git INDEX against 143 pinned entries, pinnedAt 2026-11-25T22:12:00Z` (run twice: at `9c52f75` and at final `8f88df3` — green both) |
| 3 | `node tools/parity/verify-manifest.js` | 0 | fixtures 193/193 + corpus 3/3 = `TOTAL pairs 196 ok 196 missing 0 mismatch 0` |
| 4 | `node tests/L1-backend/run.js --verify-against-selftest` | 0 | `64 passed, 0 failed of 64 checks in 96.5 s` → `L1 SELF-TEST GREEN against parity-baseline` |
| 5 | `node tests/L2-ui/run.js --verify-selftest` | 0 | `run 1/1: 433/433 assertions passed` → `L2 SELF-TEST GREEN … (1 consecutive run(s), 433 assertions)` |
| 6 | `node tests/L3-seam/run.js --verify-against-selftest` | 0 | `29 passed, 0 failed of 29 checks in 166.7 s` → `L3 SELF-TEST GREEN (1 run(s))` |
| 7 | `node tests/L4-dual/run.js --self-mode` | 0 | sides a/b `ref=parity-baseline` 62 fields each, 0 problems; `fields A=62 B=62 diffs=0 policy violations=0 problems=0 (65.2 s)` → `L4 SELF-MODE GREEN` |
| 8 | `node tools/parity/nightly/run-nightly.js --log <scratch>/nightly-durable.log` | 0 | pre-gate `HASH-PIN CHECK GREEN`; `PASS L1 97.0 s`, `PASS L2 167.0 s (--repeat 2)`, `PASS L3 328.9 s (--repeat 2)`, `PASS L4 65.5 s` → `verdict GREEN — all gates green (658 s) exit=0 (red gate count)` |
| 9 | `node tools/parity/equiv-prove.js` | 0 | `{enumerated:765, killed:705, survived:60, static:17, dynamic:43, gaps:0, unresolved:0, escalated:0, proposals:0}` + all 7 report gates `[x]` (deterministic enumeration == committed `mutants.json`; 60 survivors ↔ 60 proof files, 0 stale; 2752 vectors × 3 channels unmutated, 0 disagreement) → `EQUIV-PROVE GREEN`; wrote `REPORT.md`/proofs **byte-identical to HEAD** (`git status` clean right after) |
| 10 | `node tools/parity/negative-controls.js --all` | 0 | `8/8 negative controls red as named`; `wrote C:\projects\Cline-demo\fixtures\NEGATIVES.md (8 rows, 0 not red-as-named)` — regenerated `NEGATIVES.md` **byte-identical** (not in `git status`) |
| 11 | `node tools/parity/restricted-path-proof.js` | 0 | `RESTRICTED-PATH PROOF GREEN — 5 passed, 0 failed` (incl. L1 + a 7-check L3 corpus group inside the Task-Scheduler PATH) |

Red gates: **none.** No fixture, golden, SPEC file, `PARITY.md`, `COMPARISON.json` or threshold was
touched by me; nothing was re-recorded; no network was used.

## Corpus round-trip seen inside the green (highest-value test, plan §2)

`L3.CORPUS-argv-goldens — 48/48 argvs positionally equal to the recorded legacy argv`;
`L3.CORPUS-INI-bytes — sha d5fc433e359162b4 equals the recorded corpus ini …, 48 sections, trailing
`port = 7838` (Q10)`; `L3.CORPUS-resave-bytes — 48/48 re-saved entries byte-identical`;
`L3.CORPUS-resave-orphans` (Q16 drops orphans only where they existed); `L3.CORPUS-Q18-alert`;
L2 `corpus: 181/181` in both nightly runs; `L3.CORPUS-launched-count — 48/48 … no spawn-EINVAL
re-post needed` (Q25 cap 0/2 this fire).

## Tree / process hygiene at exit

- `git status --porcelain` → empty. Only drift I caused: `tools/parity/reports/negatives/
  M-ini-020-0033-string-literal-9df5bbb505-l3.log`, one line, the M5-improved red wording
  (`the file on disk held 19434 byte(s) leading "version = 1\n\n[Qwen 3 Q4 64K - 28TPS]…" expected
  19386 bytes, got 19434`) on an otherwise identical FAIL (same assertion, same byte counts, same
  first difference at byte 146). Copy kept here as `regenerated-trace.log`; file restored with
  `git checkout --` so the tree matches `8f88df3`.
- Nightly durable log redirected with `--log` into this scratchpad, so no untracked file landed in
  `tools/parity/reports/nightly/`.
- `git worktree list` → repo only (no leftover registrations); `C:/parity-scratch/negatives/*`
  retains only a `l2out` remnant (the worktree checkouts were reverted and removed by the tool).
- Processes: my node runs all exited; no `fake-llama-server.exe`/stand-in/chromium of mine left
  (chrome count identical before/after at 20 = the user's own browser). Parity lock released.
- `C:/parity-scratch/{app,bin,runs}` scratch trees remain — harness-owned, outside the repo,
  regenerated by every run; deliberately not deleted (the root also owns the lock contract).
