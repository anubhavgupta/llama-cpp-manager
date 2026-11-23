# L1 backend conformance — check index

Every machine-checked assertion id in `tests/L1-backend`, with the plan.md §9 quirk it pins, or
`contract` when it pins behaviour the SPEC/ contracts and fixtures describe rather than a quirk.
Generated from the `ctx.check(id, tag)` calls in `checks/*.js` — regenerate after adding a check.

```node tests/L1-backend/run.js --verify-against-selftest` runs the whole suite against a fresh
legacy sandbox built from the `parity-baseline` tag (the Part-1 self-test). Groups run in their
own sandbox session, so `--only` re-creates that group's recorded conditions alone:

```
node tests/L1-backend/run.js --verify-against-selftest                 # 8 sessions
node tests/L1-backend/run.js --verify-against-selftest --only process,presets
node tests/L1-backend/run.js --verify-against-selftest --repeat 3    # flake detection
node tests/L1-backend/run.js --attach                                # a manager you started
```

| group | session | checks |
|---|---|---|
| contract | one session, NVIDIA_SMI_STUB_MODE=ok | 16 |
| process | one session, NVIDIA_SMI_STUB_MODE=ok | 17 |
| restart | one session plus a manager relaunch for Q4, NVIDIA_SMI_STUB_MODE=ok | 10 |
| presets | one session, NVIDIA_SMI_STUB_MODE=ok | 9 |
| metrics-simulated, metrics-unparsable, metrics-stub | three sessions, NVIDIA_SMI_STUB_MODE=fail / garbage / ok | 6 |
| socket | one session, NVIDIA_SMI_STUB_MODE=ok | 5 |

**63 checks** across 6 files.

## contract

HTTP surface, settings writes, /models tree. Session: one session, NVIDIA_SMI_STUB_MODE=ok.

| check id | pins | detail |
|---|---|---|
| `L1.ROOT.BYTES` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.SWAGGER.BYTES` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.SWAGGER-JSON.BYTES` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.SETTINGS.FIRST-RUN.BYTES` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.SETTINGS.POST-WITH-PORT.BYTES` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.SETTINGS.READ-BACK.BYTES` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.SETTINGS.TDZ-PORT-8080` | Q2 — POST /settings without serverPort persists 8080 — the TDZ read of the later-declared const | POST /settings without serverPort persists 8080 — the TDZ read of the later-declared const |
| `L1.PORT.HARD-CODED-7837` | Q11 — the manager URL is hardcoded to port 7837 | the manager URL is hardcoded to port 7837 |
| `L1.STATUS.IDLE.BYTES` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.METRICS.STUB-SHAPE` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.MODELS.BYTES` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.MODELS.MMPROJ-EXCLUDED` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.MODELS.MMPROJ-FIRST-MATCH` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.MODELS.UNREADABLE-ABSENT` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.STATIC.INDEX-MATCHES-GOLDEN` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.SETTINGS.REPLAY-MODELSDIR-REQUIRED` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |

## process

/start argv + log stream, /status, /stop. Session: one session, NVIDIA_SMI_STUB_MODE=ok.

| check id | pins | detail |
|---|---|---|
| `L1.STATUS.BEFORE-START.BYTES` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.START.MISSING-PATH-400` | Q3 — guard paths answer 200 + success:false instead of a 4xx | guard paths answer 200 + success:false instead of a 4xx |
| `L1.STOP.WHILE-IDLE-200` | Q3 — guard paths answer 200 + success:false instead of a 4xx | guard paths answer 200 + success:false instead of a 4xx |
| `L1.START.OK-BYTES` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.START.ARGV-MATCHES-GOLDEN` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.LOG.STREAM-MATCHES-RECORDED-BYTES` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.STATUS.RUNNING-BYTES` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.STATUS.CADENCE-FREE-POLLING` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.START.ALREADY-RUNNING-200` | Q3 — guard paths answer 200 + success:false instead of a 4xx | guard paths answer 200 + success:false instead of a 4xx |
| `L1.STOP.OK-BYTES` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.SOCKET.SERVER-ENDED-ORDER` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.LOG.RAW-CHUNK-BYTES-FORWARDED` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.STOP.SIGTERM-THEN-SIGKILL` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.STOP.STALE-TIMER-WINDOW` | Q24 — /stop arms SIGTERM, then SIGKILL one second later, on the module-level runningProcess | /stop arms SIGTERM, then SIGKILL one second later, on the module-level runningProcess |
| `L1.START.EXIT-CODE-PATH` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.START.EXIT-CODE-ARGV-GOLDEN` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.GROUP.SETTLED` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |

## restart

Q3/Q4/Q23 /restart semantics. Session: one session plus a manager relaunch for Q4, NVIDIA_SMI_STUB_MODE=ok.

| check id | pins | detail |
|---|---|---|
| `L1.RESTART.NO-CONFIG-400` | Q4 — POST /restart with no in-memory lastLaunchConfig answers 400 | POST /restart with no in-memory lastLaunchConfig answers 400 |
| `L1.RESTART.START-FIRST` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.RESTART.GET-IS-EXPRESS-404` | Q23 — /restart race: the killed child close handler clears the replacement runningProcess | /restart race: the killed child close handler clears the replacement runningProcess |
| `L1.RESTART.OK-200-TRUE` | Q3 — guard paths answer 200 + success:false instead of a 4xx | guard paths answer 200 + success:false instead of a 4xx |
| `L1.RESTART.STATUS-SETTLES-FALSE` | Q23 — /restart race: the killed child close handler clears the replacement runningProcess | /restart race: the killed child close handler clears the replacement runningProcess |
| `L1.RESTART.STOP-AFTER-RESTART-200-FALSE` | Q23 — /restart race: the killed child close handler clears the replacement runningProcess | /restart race: the killed child close handler clears the replacement runningProcess |
| `L1.RESTART.ARGV-GAINED-ONE-SPAWN` | Q23 — /restart race: the killed child close handler clears the replacement runningProcess | /restart race: the killed child close handler clears the replacement runningProcess |
| `L1.RESTART.EVENT-IDENTITY` | Q23 — /restart race: the killed child close handler clears the replacement runningProcess | /restart race: the killed child close handler clears the replacement runningProcess |
| `L1.RESTART.SETTLE-RULE-BOUNDS` | Q23 — /restart race: the killed child close handler clears the replacement runningProcess | /restart race: the killed child close handler clears the replacement runningProcess |
| `L1.RESTART.AFTER-MANAGER-RESTART-400` | Q4 — POST /restart with no in-memory lastLaunchConfig answers 400 | POST /restart with no in-memory lastLaunchConfig answers 400 |

## presets

/launch-presets, the ini golden, Q5 ports. Session: one session, NVIDIA_SMI_STUB_MODE=ok.

| check id | pins | detail |
|---|---|---|
| `L1.PRESETS.SEED-PORT-7838` | Q5 — /launch-presets defaults --port 8080 while /start takes the port from the request body | /launch-presets defaults --port 8080 while /start takes the port from the request body |
| `L1.PRESETS.DEFAULT-PORT-BYTES` | Q5 — /launch-presets defaults --port 8080 while /start takes the port from the request body | /launch-presets defaults --port 8080 while /start takes the port from the request body |
| `L1.PRESETS.INI-BYTES` | Q10 — the preset ini keeps the retired trailing "port = " line | the preset ini keeps the retired trailing "port = " line |
| `L1.PRESETS.ARGV-PORT-8080` | Q5 — /launch-presets defaults --port 8080 while /start takes the port from the request body | /launch-presets defaults --port 8080 while /start takes the port from the request body |
| `L1.PRESETS.STOP-AFTER-DEFAULT-PORT` | Q24 — /stop arms SIGTERM, then SIGKILL one second later, on the module-level runningProcess | /stop arms SIGTERM, then SIGKILL one second later, on the module-level runningProcess |
| `L1.PRESETS.EXPLICIT-PORT-7838` | Q5 — /launch-presets defaults --port 8080 while /start takes the port from the request body | /launch-presets defaults --port 8080 while /start takes the port from the request body |
| `L1.PRESETS.RESTART-STILL-400` | Q4 — POST /restart with no in-memory lastLaunchConfig answers 400 | POST /restart with no in-memory lastLaunchConfig answers 400 |
| `L1.PRESETS.STOP-AFTER-EXPLICIT-PORT` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.PRESETS.STANDIN-RELAY-ARGV-IDENTICAL` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |

## metrics-simulated, metrics-unparsable, metrics-stub

Q6 metric paths. Session: three sessions, NVIDIA_SMI_STUB_MODE=fail / garbage / ok.

| check id | pins | detail |
|---|---|---|
| `L1.METRICS.SIMULATED-SHAPE` | Q6 — GPU metrics are simulated (Math.random, hardcoded 8 GB total) or silently zero, never real | GPU metrics are simulated (Math.random, hardcoded 8 GB total) or silently zero, never real |
| `L1.METRICS.SIMULATED-NOT-REAL` | Q6 — GPU metrics are simulated (Math.random, hardcoded 8 GB total) or silently zero, never real | GPU metrics are simulated (Math.random, hardcoded 8 GB total) or silently zero, never real |
| `L1.METRICS.GARBAGE-ZEROS` | Q6 — GPU metrics are simulated (Math.random, hardcoded 8 GB total) or silently zero, never real | GPU metrics are simulated (Math.random, hardcoded 8 GB total) or silently zero, never real |
| `L1.METRICS.GARBAGE-RECORDED-NOTE` | Q6 — GPU metrics are simulated (Math.random, hardcoded 8 GB total) or silently zero, never real | GPU metrics are simulated (Math.random, hardcoded 8 GB total) or silently zero, never real |
| `L1.METRICS.STUB-CANNED` | Q6 — GPU metrics are simulated (Math.random, hardcoded 8 GB total) or silently zero, never real | GPU metrics are simulated (Math.random, hardcoded 8 GB total) or silently zero, never real |
| `L1.METRICS.STUB-FORMAT` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |

## socket

socket.io families, relay byte forwarding, connectedClients. Session: one session, NVIDIA_SMI_STUB_MODE=ok.

| check id | pins | detail |
|---|---|---|
| `L1.SOCKET.EVENT-FAMILIES` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.SOCKET.RELAY-BYTES-IDENTICAL` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.SOCKET.SERVER-ENDED-ON-EVERY-CLIENT` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.SOCKET.CONNECTED-CLIENTS-CLEANUP` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |
| `L1.SOCKET.DISCONNECT-REMOVES-CLIENT` | contract | SPEC contract (behaviour the SPEC/ fixtures describe, no quirk) |

## Notes on the recorded evidence

- `fixtures/MANIFEST.json` records no journey for a successful `/restart`: the only recorded
  restart evidence is the Q4 400 and the Q23 settle snapshots, so the restart group asserts those
  and uses the `restart-settle` rule bounds for the platform-bound race.
- The canned `/metrics` path has no journey of its own: its recorded samples are
  `fixtures/http/J1-settings/metrics-{1,2,3}.response`, so `L1.METRICS.STUB-CANNED` compares against
  that family. The constant it pins (gpu 42, vram 50.23193359375, `"12345/24576"`) is read out of
  `metrics-1.response` at run time instead of being restated here, and the same holds for the
  garbage path's zeros (`fixtures/http/J2b-metrics-garbage/metrics-1.response`). cpu and ram are real
  OS readings and move on every path, which is why the constancy claim covers the GPU triple only.
- The Q24 window: relaunching inside the 1 s after a `/stop` was probed 3/3 at `parity-baseline`
  and the relaunched child survives while the manager loses its handle (/status settles false,
  /stop 200 success:false), because the dying child close handler writes null to the same
  module-level variable the deferred SIGKILL reads. `L1.STOP.STALE-TIMER-WINDOW` pins that
  recorded outcome; every other group keeps the same 1.5 s quiescence the recording harness used.
  A relaunch inside the window also leaves that child unreachable over HTTP, so the check reaps it
  by pid, the way `capture-legacy.js` sweeps the session.
- `L1.LOG.RAW-CHUNK-BYTES-FORWARDED` and `L1.SOCKET.RELAY-BYTES-IDENTICAL` compare against the
  emitting side rather than re-deriving lines: `PARITY_CHUNK_LOG` records every write the fake
  makes and every block the compiled stand-in relays, and the client-side reassembly has to be
  byte-identical to it. A payload is one forwarded chunk, so the byte claim is made on the
  reassembled stream and the split/trim claims are made per payload.

## Tool knobs this suite depends on

Append-only additions to the parity tools, all inert unless the env var or flag is set;
`tools/parity/selftest-fake.js` covers them:

- `PARITY_ARGV_LOG` — every launch appends `{pid, argv, raw}` as JSON lines (used for the argv
  goldens, positional compare with `pid`/`raw` dropped per `fixtures/COMPARISON.json`).
- `PARITY_CHUNK_LOG` — the fake appends one JSON line per write it makes (`source:"fake"`) and the
  compiled stand-in appends one per block it relays (`source:"relay"`), each with
  `stream`/`seq`/`byteLength`/`bytesBase64`. This is the emitting-side record the client-side byte
  comparison is made against.
- `--parity-chunks N`, `--parity-repeat-line/-count`, `--parity-stderr-only`, `--parity-slow-exit`,
  `--parity-exit-code` — the fake's emission shapes: split chunks, a padded repeated line, a silent
  stdout, a child that ignores the graceful path, and a non-zero exit.

