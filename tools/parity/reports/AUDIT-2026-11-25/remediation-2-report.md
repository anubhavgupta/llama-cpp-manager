All five fires green and the tree is clean. Final report:

## Per-N results

| N | Fix | Exact command(s) | Evidence | Commit |
|---|---|---|---|---|
| **N5** | byte-0 ini diff prints real bytes + `L3.DIFF-EXCERPT` harness guard | `node tests/L3-seam/run.js --verify-against-selftest --only models` | guard proves a byte-0 diff on a multi-section ini prints both sizes + the real leading bytes (old slice printed `""`) | `935168c` (earlier) |
| **N1** | three measured mechanisms fixed: (A) Q24 stop→relaunch is conditions, not a sleep; (B) `fake-llama-server.js` retries the shared-log append instead of dying on `EBUSY`; (C) one conditional re-post of a launch Windows refused with `spawn EINVAL` | `node tests/L3-seam/run.js --verify-against-selftest --repeat 2` (×11 fires, ±CPU load) | same load + same command: **fire6/fire7 = 3 red checks → fire10 = 1 red → fire11 = 29/29 twice @100% CPU**. A: 52% CPU, 6 identical cycles — old 1.5 s wait killed **4/6** relaunches (windows 2433-2745 ms), new `stopAndWait` killed **0/6** (≥3983 ms) at the same 1499-1559 vs 1515-1551 ms gap. B: `n1-ebusy-proof.js` — HEAD fake exits `code=1` with EBUSY through a 1 s `FileShare.None` hold (2 records), retrying fake survives (45 records). C: rate ~1/55 spawns, present in **idle green** fires too | `5d1ba28` |
| **N2** | pins hash `git show :path`; real `--check` (MISMATCH/ADDED/DROPPED/WORKING-COPY-DRIFT + self-entry NOTE); `.gitattributes` eol=lf for the 4 drifted paths; `--check` wired into nightly as a pre-gate | `bash tools/parity/hash-pin.sh`, `bash tools/parity/hash-pin.sh --check`, `git worktree add --detach …` | `--check` exits 1 naming offenders, exits 0 GREEN (143 paths) after regen; **fresh detached worktree at `457cc25`: `HASH-PIN CHECK GREEN`, exit 0, zero drift**, and AGENTS/PARITY/plan/spec-static/.gitignore all check out LF; all 5 nightly logs open with `HASH-PIN CHECK GREEN` | `a695a59`, `87cf730` |
| **N3** | `stableLog()` masks durations / 40-hex throwaway sha / run-summary timestamp at write time; L1 run summary moved to gitignored `tests/L1-backend/out/` | `node tools/parity/negative-controls.js --all` ×2 | run1 **8/8 red-as-named**, run2 **8/8 red-as-named**, then `git status --porcelain` → **0 lines**. Logs show `in <elapsed> s`, `--ref <throwaway-commit>`, `l1-<run-utc>-selftest.json`; content shas stay literal | `d15877c`, `3b45514` |
| **N4** | durable block = every failure line + 2 context lines (cap 400) + last 25; `--selftest` proves it with a synthetic red | `node tools/parity/nightly/run-nightly.js --selftest` | `a durable red carries its failure lines… synthetic gate, 402 output lines, 29 of them retained`; the FAIL id and `first difference at byte 0` are printed back; exit-code contract (3 reds → 3) still green | `ffed794` |

## Green fire logs (durable, tracked)

`tools/parity/reports/nightly/` — interactive: `nightly-2026-11-25T16-26-03Z.log` (657 s), `…16-37-20Z.log` (655 s), `…16-48-36Z.log` (657 s), each `verdict GREEN — all gates green … exit=0`. Scheduled through Task Scheduler: `…16-59-54Z.log` (689 s) and `…17-11-59Z.log` (688 s), both **`Last Result: 0`** (`n1/CLOSING.log` in scratch records each poll).

## Traces inventory

`tools/parity/reports/nightly/traces/` (183 files, index = `TRACES.md`): fire1–4 = 4 idle full nightly sequences (all GREEN, N-repeat), fire5 L3@52%, **fire6/fire7 = old-code RED traces** (the auditor's exact `/status never reported running=true` signature, manager log 6/9 exits `code null`, zero `failed to listen`), **fire8 = RED** exposing the EBUSY death, fire9 = aborted (my own staged-edit bug, kept), **fire10 = RED** exposing `spawn EINVAL` at server.js:625, fire11 = GREEN at 100% CPU. Each dir carries `driver/` (full per-gate output + CPU samples), `scratch/` (argv/chunk jsonl, `runs/*.manager.log`, ini, settings), `suite-out/`.

## PARITY wording you asked for (I did not touch PARITY.md)

Re-open the criterion (delta audit already did), then re-close with:

> `- 2026-11-25 REMEDIATION-2 SWEEP (worker commits 5d1ba28 a695a59 d15877c ffed794 87cf730 3b45514 457cc25): delta findings N1-N5 dispositioned. N1 L3 sequence-only flake closed as three load-induced mechanisms (Q24 armed-timer kill under a blocked manager loop / EBUSY on the shared argv+chunk log killing the stand-in's child / Windows refusing the manager's own spawn, ~1 per 55 attempts), each with its before/after measurement and 11 durable fire traces under tools/parity/reports/nightly/traces/. 3 interactive nightlies (16-26-03Z, 16-37-20Z, 16-48-36Z, exit 0) + 2 scheduled fires (16-59-54Z, 17-11-59Z, Last Result 0) close exit criterion "nightly installed and green" — re-closed. N2 pins are clone-stable (hash from `git show :path`, real `--check`, eol=lf renormalised): fresh `git worktree add --detach` at 457cc25 gives `HASH-PIN CHECK GREEN`, zero drift. N3 two `--all` runs leave the tree clean. N4 durable nightly reds carry every failure line. N5 byte-0 diff excerpts readable behind guard L3.DIFF-EXCERPT.`

And the environmental-flake row you offered to land:

> `| Q25 | Windows sporadically refuses the manager's spawn of the stand-in ('Error launching server with presets: Error: spawn EINVAL' at server.js:625, ~1 per 55 spawn attempts, present in green fires); the app answers 200 having started nothing | server.js:625 (legacy shape, untouched) | harness tolerance only: L3 re-posts the identical request exactly once, and only when the manager logged that EINVAL for the awaited launch; named in the check detail, tallied per fire, >2/fire = RED (L3.SPAWN-EINVAL-CAP) | baseline-verified (harness affordance — the Part-2 candidate gets no exemption; a spawn failure under a candidate run is the candidate's own red) |`

## Residual risks

1. **Scope I extended, flag for your reviewer:** condition (b) "identical request" — I re-post the captured `/start` body for *click-driven* launches too (the 48 corpus configs), because the same refusal can land there and dropping those assertions would have been the quarantine you rejected. Bytes are the page's own; the detail line names it.
2. `stopAndWait` waits as long as the manager's loop stays blocked: at 100% CPU an L3 pass went 253 s → 731 s. At idle nothing changed (161-165 s in all five nightlies).
3. The `spawn EINVAL` cap (2/fire) will go RED on a machine that refuses often — intended, but it is a new way for a fire to be red.
4. `fixtures/HASH-PIN.json` moved twice today (pinnedAt + self-entry only at 17:31:46Z) — needs your C8 ledger entry; `--check` cannot verify that file's own entry by construction.
5. Battery at `457cc25`: equiv-prove `--selftest` GREEN, verify-manifest 196/196, gen-goldens `--check` REPRODUCIBLE, restricted-path-proof 5/5, leak-check CLEAN (245 files), ast-inventory `--check` 333 rows, spec-reconcile unreconciled=0, selftest-fake 25/25, equivalence `--verify` GREEN. No parity lock held, no stray suite compute, `git status` empty.