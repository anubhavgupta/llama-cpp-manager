#!/usr/bin/env bash
# Phase 0: write fixtures/BASELINE.json — git sha + SHA256 of frozen legacy app files.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
sha=$(git rev-parse 'parity-baseline^{commit}')
mkdir -p fixtures
out=fixtures/BASELINE.json
{
  echo "{"
  echo "  \"tag\": \"parity-baseline\","
  echo "  \"commit\": \"$sha\","
  echo "  \"recordedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"files\": {"
  first=1
  for f in server.js public/script.js public/index.html public/styles.css; do
    if [ $first -eq 0 ]; then printf ',\n'; fi
    first=0
    printf '    "%s": "%s"' "$f" "$(sha256sum "$f" | cut -d' ' -f1)"
  done
  printf '\n  }\n}\n'
} > "$out"
cat "$out"
