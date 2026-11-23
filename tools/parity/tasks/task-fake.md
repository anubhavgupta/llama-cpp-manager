# TASK: fake llama-server binary (parity harness)

Repo: C:/projects/Cline-demo (Windows 10, git-bash, node v24).
FIRST read C:/projects/Cline-demo/plan.md (esp. §2 Phase 1, §9 cross-stack traps, §11) and C:/projects/Cline-demo/AGENTS.md.
Then read server.js lines 1–260 and 276–430: how the app spawns the llama-server child (spawn args, cwd, env), stop/kill logic (SIGTERM then SIGKILL), and stdout/stderr forwarding via socket.io — your tool must fit that reality.

WRITE EXACTLY THESE FILES (touch nothing else; do NOT git commit; never modify server.js or public/*):

1. tools/parity/fake-llama-server.js — standalone Node script standing in for llama-server.exe:
- Accepts ANY arguments. On startup, if env PARITY_ARGV_LOG is set, append ONE JSON line to that file:
  {"pid": <pid>, "argv": [<exact process.argv slice(2) array>], "raw": <raw windows command line>}
  On Windows get the true raw command line via e.g.
  execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \u0027ProcessId=<pid>\u0027).CommandLine"')
  (escape as needed). Must preserve quoting for args containing spaces and quotes.
  Write the line atomically enough that concurrent spawns don't interleave partial lines (open with 'a', single write call, appendSync is fine).
- Parse loosely: --host, --port, --model, --models-preset, --ctx-size, etc. Unknown args ignored.
- If --port present: bind HTTP on host:port; GET /health -> {"status":"ok"}; GET /props -> {"default_generation_settings":{"n_ctx":4096},"total_slots":1}; GET /v1/models -> {"models":[<basename of --model>],"data":[{"id":"<basename>","object":"model"}]}; POST /completion -> {"content":"ok"}; GET anything else -> 404. After listen succeeds, if env PARITY_BIND_LOG set append {"pid":...,"host":...,"port":...} JSON line.
- Startup logs: a fixed deterministic llama.cpp-style text (lines like "ggml_backend_cpu_init: ...", "load_model: expecting a GGUF file...", "srv  update_slots: all slots idle", "main: server is listening on http://<host>:<port>", plus a line containing "model = <the --model value>"). Emit via a chunk script: with default knob, each logical line is split across MULTIPLE process.stdout.write calls mid-line (~10ms between partial writes; a full line = concat of its chunks). Knob --parity-chunks <n>: n=0 one write per line; n>0 split each line into n-byte chunks. Default n=7. NO timestamps, NO randomness.
- SIGTERM: exit 0. Knob --parity-exit-code <n>: exit with code n right after startup logs. Knob --parity-stderr-only: all startup log text goes to stderr instead of stdout. Knob --parity-slow-exit <ms>: ignore/delay SIGTERM for ms (keep running), then exit 0 — the app's own SIGKILL may win the race; that is fine.
- Works with PARITY_ARGV_LOG/PARITY_BIND_LOG unset (no file writes). The harness will spawn it as node.exe with script path as "serverPath" — but ALSO make it work if the OS gives it the shebang-less direct run (no special handling needed beyond standard node script).

2. tools/parity/selftest-fake.js — node script that spawns the fake directly via child_process.spawn (node exe + script path) and exercises EVERY knob above:
- argv recording incl. one arg with spaces and one with embedded double-quote (verify argv array elements AND that raw preserves quoting like libuv would: "arg with space" quoted, inner quote escaped);
- chunk shape: collect stdout 'data' events; assert a line arrived split across >=2 data events with default chunks and arrives whole with --parity-chunks 0;
- exit-code path; stderr-only path; SIGTERM exit 0; slow-exit then kill; port bind + /health + /props + /v1/models fetch; PARITY_BIND_LOG content.
Print PASS/FAIL per check; exit non-zero if any FAIL. RUN IT until fully green.

Constraints: deterministic, localhost-only, no legacy-file changes. Final report: files written + full selftest output.
