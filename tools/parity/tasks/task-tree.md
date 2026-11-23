# TASK: fixture model tree + nvidia-smi stub (parity harness)

Repo: C:/projects/Cline-demo (Windows 10, git-bash, node v24).
FIRST read C:/projects/Cline-demo/plan.md (§2 Phase 1, §11) and AGENTS.md.
Then read server.js: the /models route — its recursive directory scan, which files count as models (.gguf), and the exact mmproj exclusion/association rules (search readdir/stat/mmproj); and getSystemMetrics Windows branch (~line 108): execSync('nvidia-smi --query-gpu=utilization.gpu,memory.total,memory.used --format=csv,noheader,nounits', {encoding:'utf8'}) and its CSV parsing (trim, split('\n'), first line, split(','), parseFloat||0).

WRITE EXACTLY THESE FILES (touch nothing else; do NOT git commit):

1. tools/parity/fixture-tree.sh — usage: `bash fixture-tree.sh <target-dir> [clean]`. Deterministically builds under <target-dir>:
- nested dirs: models/a/, models/a/b/, models/Bench/, "models with spaces/"
- several small dummy .gguf files (deterministic content, e.g. "GGUF" magic + name) so the app's /models returns a deterministic set; include a llama-bench style name to test Bench association if server.js has such rules (check the code!)
- mmproj variants per the ACTUAL rules you found: at least one mmproj*.gguf that must be EXCLUDED from the model list, one correctly associated with a model in the same dir, one in a SIBLING dir (negative case)
- dirs with: non-ASCII name (models/ünïcødé-тест/), spaces, and a >150-char long dir name
- an UNREADABLE dir: on Windows use icacls deny with inheritance (e.g. icacls "<dir>" /deny "*S-1-5-32-545:(OI)(CI)(R)" or the current user); cleanup() must /remove:deny before wiping; if icacls can't make node's readdir fail in practice, still implement best-effort and PRINT which mechanism was used and whether it verified
- an empty dir; and record in fixture-tree-manifest.txt (UTF-8, LF, sorted, relative paths) every created file/dir PLUS lines for 3 deliberately-missing paths prefixed 'MISSING:' (missing-dir cases)
- idempotent: second 'build' run yields the same manifest; 'clean' fully removes the target subtree (unlock first). Exit non-zero if any created path is absent at the end.

2. tools/parity/nvidia-smi-stub/nvidia-smi.cmd + tools/parity/nvidia-smi-stub/nvidia-smi-stub.js
- Matches the exact server.js invocation (any --query-gpu args, --format csv,noheader,nounits).
- Mode via env NVIDIA_SMI_STUB_MODE: ok (default) prints exactly one line: 42, 24576, 12345 ; multi prints 3 such lines (server.js must take first); garbage prints 'not a csv' exit 0; fail prints nothing exit 1; hang sleeps 30s.
- .cmd forwards all args to the node script (path relative to %~dp0) and propagates exit code.
- MUST be resolvable as `nvidia-smi` when its dir is prepended to PATH: verify with node -e "require('child_process').execSync('nvidia-smi --query-gpu=utilization.gpu,memory.total,memory.used --format=csv,noheader,nounits',{encoding:'utf8'})" under PATH override, for EVERY mode (skip hang's full 30s: just verify it is still running after 3s then kill it).

3. tools/parity/selftest-tree.sh — orchestrates both:
- fixture-tree.sh into a temp dir under /tmp; assert manifest matches actual find output; assert mmproj exclusions visible; assert unreadable dir: node fs.readdirSync(dir) THROWS (run node to check, capture); run clean; assert dir gone; rerun build for idempotence check.
- all nvidia-smi-stub modes through PATH via node execSync/spawnSync; assert exact outputs and exit codes.
Print PASS/FAIL lines; exit non-zero on any FAIL. RUN IT until green.

Final report: files written, the exact mmproj/scan rules you found in server.js (quote code lines), selftest summary.
