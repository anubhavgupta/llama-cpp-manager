#!/usr/bin/env bash
# Phase 2.1 behavior-preservation proof (plan.md §2 Phase 2.1 item 1): the two extracted generators
# in legacy/lib/ must be byte-faithful to the inline blocks they were cut out of. Skipping this
# makes every later green test validate a refactor bug.
#
#   bash tools/parity/preservation-proof.sh                 # differential + live A/B re-capture
#   bash tools/parity/preservation-proof.sh --out <dir>     # where the A/B recordings land
#   bash tools/parity/preservation-proof.sh --journeys a,b  # override the journey set
#   bash tools/parity/preservation-proof.sh --no-record     # differential only (fast inner loop)
#
# Three independent checks, all required, none of them relaxable from here:
#   1. differential  — the ORIGINAL inline blocks, sliced out of `git show parity-baseline:public/script.js`
#                      by unique anchors and evaluated in one process, vs legacy/lib, over recorded
#                      inputs only (tools/parity/preservation-proof.js --differential).
#   2. live A/B      — Run A records the journeys from --ref parity-baseline, Run B from
#                      --ref worktree; the two recorded trees must have the same file set and the
#                      same bytes for every file fixtures/COMPARISON.json does not relax.
#   3. policy compare— capture-legacy.js --compare over the two trees, i.e. the shape-mode and
#                      informational rules of fixtures/COMPARISON.json are applied, not re-declared.
# The proof never edits a fixture: any diff is a refactor bug and the fix is the lib.
set -euo pipefail

REPO_UNIX=$(git rev-parse --show-toplevel)
cd "$REPO_UNIX"
TOOLS="$REPO_UNIX/tools/parity"
REPO=$(cygpath -m "$REPO_UNIX")
COMPARISON="$REPO/fixtures/COMPARISON.json"
BRANCH_REQUIRED=migration
REF_A=parity-baseline
REF_B=worktree
RECORD=yes
# Every journey whose recorded bytes embed an app-built argv vector or the app-built ini:
# J3* (the manager-side argv the UI-launched paths share), J4 + J4b (models-preset.ini),
# J5-ui-launch + J5-ui-log-cap (#launchBtn -> buildArgs), J6-corpus-smoke (corpus configs -> buildArgs).
# J0-baseline is deliberately out: it records index.html, which the refactor legitimately changes.
JOURNEYS=J3-start-stop,J3b-exit-code,J3c-start-missing-path,J3d-restart,J4-launch-presets,\
J4b-ui-presets-launch,J5-ui-launch,J5-ui-log-cap,J6-corpus-smoke
OUTROOT=""

die() { echo "preservation-proof: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case $1 in
    --out) shift; [ $# -gt 0 ] || die "--out needs a directory"; OUTROOT=$(cygpath -m "$1") ;;
    --journeys) shift; [ $# -gt 0 ] || die "--journeys needs a comma-separated journey list"; JOURNEYS=$1 ;;
    --journeys=*) JOURNEYS=${1#*=} ;;
    --no-record) RECORD=no ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

if [ -z "$OUTROOT" ]; then
  OUTROOT=$(node -p "require('path').join(require('os').tmpdir(), 'parity-extract-proof').split(String.fromCharCode(92)).join('/')")
fi
case "$OUTROOT" in
  [A-Za-z]:/*) ;;
  *) die "the proof output root must be a windows absolute path (got '$OUTROOT')" ;;
esac
case "$OUTROOT" in
  "$REPO"|"$REPO"/*) die "refusing to write the proof recordings inside the repo: $OUTROOT" ;;
esac
A="$OUTROOT/A"
B="$OUTROOT/B"

# --- gate 0: the worktree run must be reproducible from a commit -------------------------------

BRANCH=$(git -C "$REPO_UNIX" rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "$BRANCH_REQUIRED" ] || die "run the proof on branch $BRANCH_REQUIRED (currently $BRANCH)"
DIRTY=$(git -C "$REPO_UNIX" status --porcelain)
[ -z "$DIRTY" ] || die "the working tree is not clean; Run B copies the working tree, so commit the\
refactor first (git status --porcelain):\n$DIRTY"
HEAD_SHA=$(git -C "$REPO_UNIX" rev-parse HEAD)

rm -rf "$A" "$B"
mkdir -p "$A/fixtures" "$B/fixtures"

echo "== gate 1: differential — parity-baseline inline blocks (sliced) vs legacy/lib"
node "$TOOLS/preservation-proof.js" --differential --json "$OUTROOT/differential.json"

if [ "$RECORD" = no ]; then
  echo "== recording skipped (--no-record)"
  exit 0
fi

# Both runs must use the same sandbox root: the recorded absolute paths are part of the fixtures, so
# only the destination moves between A and B (same rule capture-legacy.sh uses for --verify-determinism).
echo "== gate 2a: record Run A from --ref $REF_A"
bash "$TOOLS/capture-legacy.sh" --ref "$REF_A" --out "$(cygpath -m "$A/fixtures")" --journeys "$JOURNEYS"
node "$TOOLS/preservation-proof.js" --write-manifest "$(cygpath -m "$A")"

echo "== gate 2b: record Run B from --ref $REF_B (HEAD $HEAD_SHA)"
bash "$TOOLS/capture-legacy.sh" --ref "$REF_B" --out "$(cygpath -m "$B/fixtures")" --journeys "$JOURNEYS"
node "$TOOLS/preservation-proof.js" --write-manifest "$(cygpath -m "$B")"

echo "== gate 2c: file set + byte-for-byte comparison of the two recordings"
node "$TOOLS/preservation-proof.js" --compare-manifests "$(cygpath -m "$A")" "$(cygpath -m "$B")"

echo "== gate 3: fixtures/COMPARISON.json policy over the same two trees"
node "$TOOLS/capture-legacy.js" --compare "$(cygpath -m "$A/fixtures")" "$(cygpath -m "$B/fixtures")" \
  --comparison "$COMPARISON"

# A green comparison of an empty tree would prove nothing: name the artifacts that had to be there.
node "$TOOLS/preservation-proof.js" --required "$(cygpath -m "$A")" "$(cygpath -m "$B")"

echo
echo "PRESERVATION PROOF GREEN"
echo "  A (--ref $REF_A): $A"
echo "  B (--ref $REF_B, HEAD $HEAD_SHA): $B"
echo "  differential report: $OUTROOT/differential.json"
