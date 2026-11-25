## M1 and M2: **CLOSED**. Revised verdict below.

Scope respected: M1/M2 only, battery not re-run. Start HEAD `3deb3da` (fix = `a3cf48b`, evidence = `3deb3da`); lock free, no other executor, `git worktree list` = main only.

### M1 (stale PARITY.md pin → every fire refused) — CLOSED
| Check I ran | Result |
|---|---|
| `bash tools/parity/hash-pin.sh --check` (my tree) | **exit 0** — `HASH-PIN CHECK GREEN — 143 paths recomputed from the git INDEX against 143 pinned entries, pinnedAt 2026-11-25T18:53:08Z`, no MISMATCH, no WORKING-COPY-DRIFT |
| hash identity | pinned `PARITY.md` = `d1312682…` = `git show HEAD:PARITY.md` = index = disk |
| fresh `git worktree add --detach … HEAD` → `--check` | **exit 0 GREEN, zero drift**; PARITY.md checks out LF (0 CR bytes, 21605 B); that worktree's `git status` is empty |
| `schtasks //query //tn ParityNightly` | `Last Run 26-11-2026 00:24:38  Last Result 0` (was 1 when I left) |
| that durable log `nightly-2026-11-25T18-54-38Z.log` | opens `HASH-PIN CHECK GREEN` at the **current** pinnedAt; L1 100.5 / L2 171.0 / L3 350.1 / L4 68.5 all `PASS exit=0`; `verdict GREEN — all gates green (690 s) exit=0` — the claimed 690 s is real |
| ledger row existence (`PARITY.md:163`) | exists, names `8af43b8`, states the mechanism ("pin regenerated BEFORE its PARITY edit was staged; hash-pin reads the git index"), records the 3+2 refusals as correctly-red, states the LF renormalize + re-pin-from-staged-tree fix, and **"this row superseding '457cc25 final'"** — the older row now reads `457cc25 (143 entries…)` with "final" removed |
| `git show --stat 3deb3da` | both refusal logs committed as evidence (7 lines each); `a3cf48b` moved only `PARITY.md` (+ledger) and `fixtures/HASH-PIN.json` (pinnedAt + the one entry + self-entry) — exactly the predicted blast radius |
| **my own scheduled re-fire** `schtasks //run` 19:11:31Z | the fire **RAN** instead of refusing (pre-gate `HASH-PIN CHECK GREEN`) → the M1 refusal class is dead |

### M2 (CRLF working copy → WORKING-COPY-DRIFT) — CLOSED
`git ls-files --eol PARITY.md` → `i/lf w/lf attr/text eol=lf`; 0 CR bytes on disk; `--check` prints no WORKING-COPY-DRIFT in my tree *or* a fresh worktree.

### Revised verdict
**The blocker I raised is lifted: GO on the M1/M2 axis.** But my own first-hand fire at this same HEAD, 15 minutes after the supervisor's green one, did not go green — so I revise the overall call to **CONDITIONAL GO**: certify Part 2 only after the new finding below is dispositioned (quarantine-with-traces or fix), since it lands directly on the "nightly installed and green" criterion.

### NEW finding M5 — MAJOR: `L3.CORPUS-INI-token-bytes` intermittently reads a truncated ini (`got 0`); no ledger disposition
My scheduled fire 19:11:31Z → `FAIL L3 348.6 s exit=1`, `verdict RED — L3 red (689 s) exit=1`, **Task Scheduler `Last Result 1`** (L1/L2/L4 green):
`FAIL [Q10 Q20] L3.CORPUS-INI-token-bytes — the ini bytes are not the recorded corpus ini in token form; expected 19386 bytes, got 0 … first difference at byte 0 … actual: ""`, while `manager spawn-EINVAL re-posts this fire: 0 (cap 2)` — so it is **not** the Q25 tolerance and **not** the `/status never reported running=true` signature remediation-2 fixed.
Mechanism (code read): `checks/corpus.js:322-334` resolves `waitForIniChange` (`helpers/sandbox.js:216-224`) on *any* byte change and then reads once; `fs.writeFileSync` truncates before writing, so a reader in that window sees 0 bytes and the check compares `""` against 19386 bytes. The wait asserting true (`L3.CORPUS-INI-TOKEN-WRITTEN` passed) while the payload is empty is the signature.
Occurrences: mine (this fire, durable log on disk) + the delta audit's own independent observation of the same check id with the same byte-0/empty-actual signature (`delta-auditor.md` N1 discrimination, at `6eb25f4`). **Not reproducible on demand**: after my red I ran `--only corpus-seed,corpus-tokens` ×5 (all 4/4 green, 11.3 s each) and `--verify-against-selftest --repeat 2` once (29/29 + 29/29) — 7 green exposures, 0 reds. No `PARITY.md` row, no `quarantine`, no trace dir names this check (`grep` across PARITY.md / CHECKS.md / TRACES.md / NEGATIVES.md), unlike the `logPane.startsWithTimestamp` flake which *was* quarantined — so the protocol exists and simply wasn't applied here.
Side note that paid off: N4's durable-log fix and N5's excerpt clamp are why this is diagnosable from the log alone (the expected window printed real bytes instead of `""`).

### NEW finding M4 — MINOR (cosmetic, real): `git status` reports ` M PARITY.md` with zero content difference
`git status --porcelain` → ` M PARITY.md`, yet `git diff` / `git diff --name-only` are empty, `git ls-files -s` blob `e2fda492` (21605 B, 0 CR) == `git hash-object PARITY.md` == HEAD blob, and `git ls-files --debug` still caches `size: 21769` + the pre-renormalize mtime; `git update-index --refresh` answers `PARITY.md: needs update` instead of rewriting the stat entry. Absent at `2d6fbb4` (my original run's status was clean) → introduced by `a3cf48b`'s in-place renormalize; a fresh worktree of the same commit is clean. Clears with `git add PARITY.md` (same blob, no content change) or `git checkout -- PARITY.md`. Cost: the tree never reads clean, which is the exact signal the Auditor uses for tamper triage. (I ran `git update-index --refresh` as a diagnostic; it changed nothing — 0 staged, 0 tracked modified after.)

### State I left
0 tracked modified, 0 staged. Untracked: the supervisor's green-fire log + **my red-fire log `nightly-2026-11-25T19-11-31Z.log` (keep it — commit as M5 evidence per F13; I modify nothing)**. My probe worktree removed and pruned (`git worktree list` = main only), `C:/parity-scratch` empty, lock released, no suite ports listening, no suite processes of mine. Task Scheduler `Last Result` is 1 (my fire), `Status: Ready`, next run 03:00. Logs: `C:/Users/anubh/AppData/Local/Temp/pi-scratchpad/reaudit2/` (`CHECKPOINT-M1M2.md`, `l3full-1.log`, `tok-1..5.log`).

Recommended next step: a short Verifier pass — disposition `L3.CORPUS-INI-token-bytes` per §6.4/§7 (make `waitForIniChange` require non-empty, stable-across-two-polls bytes and dump the ini bytes on failure, then N-repeat the full L3 gate; or `quarantine` with captured traces + a ledger row), refresh the `PARITY.md` stat entry, bank my red-fire log, and re-fire the scheduled job until 2 consecutive `Last Result 0`.