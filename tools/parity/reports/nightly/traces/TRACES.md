# N1 flake traces — the sequence-only L3 red, closed

Evidence behind the N1 fix (AUDIT-2026-11-25 delta re-audit). Every fire below is a real run on this
machine against `parity-baseline`; the driver (`C:/Users/anubh/AppData/Local/Temp/pi-scratchpad/
n1-driver.js`) imports the nightly's own gate list from `tools/parity/nightly/run-nightly.js`, so the
commands are the nightly's commands, and it keeps the FULL output of each gate (the nightly's durable
log kept only a 25-line tail — that is finding N4, fixed separately).

Each fire directory holds `driver/` (console + per-gate logs + `summary.json` + CPU-busy samples),
`scratch/` (argv/chunk jsonl, `runs/*.manager.log`, `models-preset.ini`, `settings.json`) and
`suite-out/` (the suites' own `out/` artifacts). `load=N` is `n1-load.js N` CPU burners running
alongside; this box has 32 logical CPUs, so 16 ≈ 52% busy and 32 ≈ 100% busy (the samples are in
`driver/driver.log`).

| fire | command | load | verdict | what it establishes |
|---|---|---|---|---|
| `fire1-2026-11-25T12-40-16Z` | full nightly sequence (L1,L2,L3,L4) | idle | GREEN 659 s | N-repeat fire 1. Carries one manager `spawn EINVAL` at the last `/launch-presets` spawn and is still 29/29 — the refusal is environmental, not a red |
| `fire2-2026-11-25T12-56-02Z` | full nightly sequence | idle | GREEN 655 s | N-repeat fire 2 (L1 97 s, L2 165 s, L3 327 s, L4 65 s) |
| `fire3-2026-11-25T13-06-58Z` | full nightly sequence | idle | GREEN | N-repeat fire 3 (L3 29/29 twice, 161.6 s + 161.2 s) |
| `fire4-2026-11-25T13-17-49Z` | full nightly sequence | idle | GREEN | N-repeat fire 4. Second green fire that also contains a manager `spawn EINVAL` |
| `fire5-2026-11-25T14-03-02Z` | `--only l3` ×2 | 16 | GREEN 168.8 s | L3 alone holds at 52% CPU on the old code |
| `fire6-2026-11-25T14-10-37Z` | `--only l3` ×2 | 32 | **RED** 212.5 s | reproduces the nightly red on the shipped code: `L3-CHECK-THREW-argv`, `L3.PORT-launch-takes-merged-port`, `L3-CHECK-THREW-corpus-launch`, all `/status never reported running=true` (page.js:84). Manager log: 6 of 9 child exits are `code null`, zero `failed to listen` |
| `fire7-2026-11-25T14-19-27Z` | `--only l3` ×2 | 32 | **RED** 290.3 s | second old-code red trace, same signature (2 of 25 checks) |
| `fire8-2026-11-25T14-31-40Z` | `--only l3` ×2 | 32 | **RED** | the stop→relaunch fix alone: `/status` reds gone, but the stand-in's server child dies on `EBUSY` appending the shared chunk log (`scratch/runs/*.manager.log` shows `appendFileSync` → `code: 'EBUSY'` → `Server process exited with code 1`) |
| `fire9-2026-11-25T14-49-55Z` | `--only l3` ×2 | 32 | aborted | harness bug in my own staged edit (`ReferenceError: port is not defined`), kept because it is the fire's real history |
| `fire10-2026-11-25T14-54-31Z` | `--only l3` ×2 | 32 | **RED** 253.1 s | both fixes above: 28/29, and the one red is `L3.PORT-presets-default-8080 — the presets launch spawned nothing`, with `Error launching server with presets: Error: spawn EINVAL` at server.js:625 in the manager log — the third mechanism |
| `fire11-2026-11-25T15-19-27Z` | `--only l3` ×2 | 32 | **GREEN** 731 s | all three fixes: 29/29 both passes at 100% CPU load |

Mechanisms and their proofs, in the order they were separated:

1. **Q24 stale-timer kill.** `/stop` arms SIGTERM → 1 s → SIGKILL against the module-level
   `runningProcess` (server.js), and the manager's 1 s metrics sample runs `execSync('nvidia-smi …')`,
   which blocks its event loop, so the armed timer fires when the loop next turns over. Before/after
   at 52% CPU, 6 identical stop→relaunch cycles
   (`…/n1/probe-rhythm-fixed.log` vs `…/n1/probe-rhythm-shipped.log`): the fixed 1.5 s wait killed 4 of
   6 relaunches (windows 2433-2745 ms, 4 `code null` exits); the condition-based `stopAndWait` killed
   0 of 6 (windows ≥3983 ms) at the same 1515-1551 ms gap.
2. **Shared-log append kills the server child.** `fake-llama-server.js appendJsonLine` throws `EBUSY`
   while the stand-in's `File.AppendAllText` (FileShare.Read) holds the same log, and the throw is on
   the chunk timer. Unit proof `…/n1-ebusy-proof.js`: HEAD fake exits code=1 with EBUSY through a 1 s
   `FileShare.None` hold (2 records written); the retrying fake survives it (45 records, no EBUSY).
3. **Windows refuses the manager's own spawn.** `spawn EINVAL` at server.js:625, ~1 per 55 spawn
   attempts, present in the IDLE GREEN fires too (fire1, fire4). Harness response per the supervisor's
   ruling: re-post the identical request exactly once, only when the manager logged that EINVAL for
   the launch being awaited, name it in the check's detail line, tally it per fire, and go RED past 2.
