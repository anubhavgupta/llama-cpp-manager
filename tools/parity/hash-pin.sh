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
  # Pin: AGENTS.md, PARITY.md, plan.md, fixtures/*.json, and (once they exist)
  # everything under tests/ and fixtures/goldens|vectors|corpus.
  pin_list() {
    if [ -d "$1" ]; then find "$1" -type f \( -name '*.js' -o -name '*.json' -o -name '*.md' -o -name '*.csv' \) -print | sort; fi
  }
  files=$( { echo AGENTS.md; echo PARITY.md; echo plan.md; \
             ls fixtures/*.json 2>/dev/null; \
             pin_list tests; pin_list fixtures/goldens; pin_list fixtures/vectors; pin_list fixtures/corpus; } )
  for f in $files; do
    [ -f "$f" ] || continue
    if [ $first -eq 0 ]; then printf ',\n'; fi
    first=0
    printf '    "%s": "%s"' "$f" "$(sha256sum "$f" | cut -d' ' -f1)"
  done
  printf '\n  }\n}\n'
} > "$out"
cat "$out"
