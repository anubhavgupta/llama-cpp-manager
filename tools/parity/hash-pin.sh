#!/usr/bin/env bash
# Phase 0 (C8): hash-pin gate artifacts into fixtures/HASH-PIN.json.
# Re-run ONLY when a ledger-backed change to a pinned artifact is intentional;
# the Auditor diffs this file to detect goal-post moving.
#
#   bash tools/parity/hash-pin.sh            regenerate the pin file
#   bash tools/parity/hash-pin.sh --check    verify it and exit 1 on drift, naming every offender
#
# --check is what makes C8 machine-checked instead of eyeballed, and it is a pre-gate of the nightly
# (tools/parity/nightly/run-nightly.js). It reports four separate classes, because they mean
# different things:
#   MISMATCH              a pinned path whose pinned hash is not the hash of the git INDEX blob —
#                         the artifact moved, or was pinned from a working copy a clone cannot make.
#   ADDED / DROPPED       a path on the pin list with no entry, or an entry whose path left the list.
#   WORKING-COPY-DRIFT    a tracked pinned path whose bytes on disk differ from its own index blob:
#                         uncommitted work, or a checkout whose line endings crept to CRLF while
#                         `git status` stayed clean (AUDIT-2026-11-25 finding N2 — the exact way four
#                         rule-doc entries stopped matching a fresh clone).
#   NOTE                  fixtures/HASH-PIN.json cannot hash-check itself; its own movement against
#                         HEAD is printed for the Auditor, who owns that diff.
#
# Clone stability is the whole point of hashing TRACKED files from the INDEX (`git show :path`): the
# index holds the blob bytes every clone rebuilds, so a pin entry regenerated here verifies in a fresh
# `git worktree add --detach` of the same commit. A path that is pinned but not tracked (none today)
# is hashed from disk, which is the only thing available — and --check then says whether it moved.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
mkdir -p fixtures
out=fixtures/HASH-PIN.json
mode=${1:-write}
[ "$mode" = "--check" ] && mode=check

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
           echo fixtures/NEGATIVES.md; } | sort -u )

is_tracked() { git ls-files --error-unmatch "$1" >/dev/null 2>&1; }
index_hash() { git show ":$1" | sha256sum | cut -d' ' -f1; }
disk_hash() { sha256sum "$1" | cut -d' ' -f1; }

if [ "$mode" = write ]; then
  {
    echo "{"
    echo "  \"pinnedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
    echo "  \"files\": {"
    first=1
    for f in $files; do
      [ -f "$f" ] || continue
      if [ $first -eq 0 ]; then printf ',\n'; fi
      first=0
      if is_tracked "$f"; then hash=$(index_hash "$f"); else hash=$(disk_hash "$f"); fi
      printf '    "%s": "%s"' "$f" "$hash"
    done
    printf '\n  }\n}\n'
  } > "$out"
  cat "$out"
  exit 0
fi

recomputed=$(mktemp)
trap 'rm -f "$recomputed" "$committed"' EXIT
for f in $files; do
  [ -f "$f" ] || continue
  if is_tracked "$f"; then
    printf '%s index %s %s\n' "$f" "$(index_hash "$f")" "$(disk_hash "$f")" >> "$recomputed"
  else
    printf '%s disk %s %s\n' "$f" "$(disk_hash "$f")" "$(disk_hash "$f")" >> "$recomputed"
  fi
done
committed=$(mktemp)
cp "$out" "$committed"

node - "$committed" "$recomputed" "$out" <<'NODE'
const fs = require('fs');
const { execFileSync } = require('child_process');

const [pinFile, recomputedFile, outPath] = process.argv.slice(2);
let pinned;
try {
    pinned = JSON.parse(fs.readFileSync(pinFile, 'utf8')).files;
} catch (error) {
    console.log('HASH-PIN CHECK BROKEN: ' + outPath + ' is not readable JSON (' + error.message + ')');
    process.exit(1);
}
const actual = new Map(fs.readFileSync(recomputedFile, 'utf8').split('\n').filter((line) => line !== '')
    .map((line) => {
        const [path, source, indexHash, diskHash] = line.split(' ');
        return [path, { source, indexHash, diskHash }];
    }));

const mismatched = [];
const drifted = [];
const added = [];
for (const [path, entry] of actual) {
    if (path === outPath) continue;                       // cannot verify its own hash
    if (pinned[path] === undefined) { added.push(path); continue; }
    if (pinned[path] !== entry.indexHash) mismatched.push(path);
    if (entry.indexHash !== entry.diskHash) drifted.push(path);
}
const dropped = Object.keys(pinned).filter((path) => path !== outPath && !actual.has(path));

// The self-entry and the pin file's own movement are the Auditor's diff, not a machine check.
let moved = 'unknown';
try {
    execFileSync('git', ['diff', '--quiet', 'HEAD', '--', outPath], { stdio: 'ignore' });
    moved = 'committed';
} catch (error) {
    moved = 'MODIFIED against HEAD — the Auditor owns that diff (C8: it must carry a ledger entry)';
}

console.log('HASH-PIN CHECK ' + (mismatched.length || added.length || dropped.length || drifted.length
    ? 'RED' : 'GREEN') + ' — ' + actual.size + ' paths recomputed from the git INDEX against '
    + Object.keys(pinned).length + ' pinned entries, pinnedAt '
    + JSON.parse(fs.readFileSync(pinFile, 'utf8')).pinnedAt);
const list = (label, paths) => paths.forEach((path) => console.log('  ' + label + '  ' + path));
list('MISMATCH', mismatched);
list('ADDED', added);
list('DROPPED', dropped);
list('WORKING-COPY-DRIFT', drifted);
console.log('  NOTE  ' + outPath + ' is ' + moved + ' and its own self-entry cannot verify itself.');
process.exit(mismatched.length + added.length + dropped.length + drifted.length === 0 ? 0 : 1);
NODE
