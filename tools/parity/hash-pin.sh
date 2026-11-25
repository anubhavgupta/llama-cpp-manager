#!/usr/bin/env bash
# Phase 0 (C8): hash-pin gate artifacts into fixtures/HASH-PIN.json.
# Re-run ONLY when a ledger-backed change to a pinned artifact is intentional;
# the Auditor diffs this file to detect goal-post moving.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
mkdir -p fixtures
out=fixtures/HASH-PIN.json
{
  echo "{"
  echo "  \"pinnedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"files\": {"
  first=1
  # Pin: the rule docs, everything under fixtures/ and tests/ that is SOURCE (the suites are the
  # gate), the SPEC pack, and the tools that decide red. Volatile and machine-local paths are
  # excluded on purpose (AUDIT-2026-11-25 finding 6): tests/*/out/** is rewritten by every
  # legitimate run, and fixtures/corpus/.pathmap-local.json is gitignored, so pinning either hides
  # real tampering inside expected churn — and a gitignored path silently DROPS out of the pin on a
  # fresh clone instead of mismatching.
  pin_list() {
    if [ -d "$1" ]; then
      find "$1" -type f \( -name '*.js' -o -name '*.json' -o -name '*.md' -o -name '*.csv' \) \
        -not -path '*/out/*' -not -name '.pathmap-local.json' -print | sort
    fi
  }
  files=$( { echo AGENTS.md; echo PARITY.md; echo plan.md; \
             ls fixtures/*.json 2>/dev/null; \
             pin_list tests; pin_list fixtures/goldens; pin_list fixtures/vectors; \
             pin_list fixtures/corpus; pin_list SPEC; \
             ls tools/parity/*.js tools/parity/*.sh tools/parity/nightly/*.js \ \
                tools/parity/nightly/*.sh 2>/dev/null; \
             echo tools/parity/reports/mutation/mutants.json; \
             echo fixtures/NEGATIVES.md; } )
  for f in $files; do
    [ -f "$f" ] || continue
    if [ $first -eq 0 ]; then printf ',\n'; fi
    first=0
    printf '    "%s": "%s"' "$f" "$(sha256sum "$f" | cut -d' ' -f1)"
  done
  printf '\n  }\n}\n'
} > "$out"
cat "$out"
