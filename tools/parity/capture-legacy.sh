#!/usr/bin/env bash
# Phase 1 close-out (plan.md §2 Phase 1 item 4): one command that regenerates the whole fixture
# set from the legacy app at tag parity-baseline.
#
#   bash tools/parity/capture-legacy.sh                      # record into fixtures/
#   bash tools/parity/capture-legacy.sh --verify-determinism # record twice, byte-compare via fixtures/COMPARISON.json
#   bash tools/parity/capture-legacy.sh --out <dir>          # record somewhere else
#   bash tools/parity/capture-legacy.sh --journeys J5-ui-launch,J6-corpus-smoke --keep-scratch
#   (--only / --only=... is the same filter; a filtered run writes no MANIFEST.json and claims no
#    determinism, and should be pointed at a scratch --out so a debug loop never churns fixtures/
#    — a filtered run is a debugging pass that records only those journeys)
#   bash tools/parity/capture-legacy.sh --ref <git-ref|worktree>  # sandbox source (default parity-baseline)
#
# Sandbox (§10 blast radius): the app is extracted from `git archive <ref>` (default parity-baseline) into a
# scratch dir outside the repo and node_modules is junctioned in; the repo's settings.json,
# models-preset.ini and model dirs are never touched. A junction is always unlinked with
# `rmdir`, never with `rm -rf`, so no recursive delete can walk into the repo's node_modules.
set -euo pipefail

REPO_UNIX=$(git rev-parse --show-toplevel)
cd "$REPO_UNIX"
TOOLS="$REPO_UNIX/tools/parity"
REPO=$(cygpath -m "$REPO_UNIX")
OUT=$(cygpath -m "$REPO_UNIX/fixtures")
COMPARISON="$REPO/fixtures/COMPARISON.json"
VERIFY=no
KEEP=no
ONLY=""
REF=parity-baseline
SCRATCH=${PARITY_SCRATCH:-}

die() { echo "capture-legacy: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case $1 in
    --verify-determinism) VERIFY=yes ;;
    --out) shift; [ $# -gt 0 ] || die "--out needs a directory"; OUT=$(cygpath -m "$1") ;;
    --scratch) shift; [ $# -gt 0 ] || die "--scratch needs a directory"; SCRATCH=$(cygpath -m "$1") ;;
    --keep-scratch) KEEP=yes ;;
    --only|--journeys) shift; [ $# -gt 0 ] || die "$1 needs a comma-separated journey list"; ONLY=$1 ;;
    --ref) shift; [ $# -gt 0 ] || die "--ref needs a git ref or 'worktree'"; REF=$1 ;;
    --ref=*) REF=${1#*=} ;;
    --only=*|--journeys=*) ONLY=${1#*=} ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

# Default scratch is a neutral, username-free root OUTSIDE the repo (and outside any user home):
# the recorded bytes embed the scratch root, and a %TEMP%-based root put the Windows username into
# every committed fixture. fixture-tree.sh refuses to build a tree inside a repository, and the app
# must never run from the repo working tree. PARITY_SCRATCH or --scratch override it; the root must
# keep the 'parity-scratch' name, which is what tools/parity/gen-vectors.js tokenizes to SCRATCH_ROOT.
if [ -z "$SCRATCH" ]; then
  SCRATCH=C:/parity-scratch
fi
case "$SCRATCH" in
  [A-Za-z]:/*) ;;
  *) die "scratch must be a windows absolute path (got '$SCRATCH')" ;;
esac
case "$SCRATCH" in
  "$REPO"|"$REPO"/*) die "refusing to use a scratch dir inside the repo: $SCRATCH" ;;
esac
case "$REF" in
  worktree) ;;
  *) git -C "$REPO_UNIX" rev-parse --verify --quiet "${REF}^{commit}" >/dev/null \
       || die "--ref: unknown git ref '$REF' (use a ref that resolves to a commit, or 'worktree')" ;;
esac
COMPARE="$SCRATCH-compare"
SCRATCH_UNIX=$(cygpath -u "$SCRATCH")
COMPARE_UNIX=$(cygpath -u "$COMPARE")

remove_junction() { MSYS_NO_PATHCONV=1 cmd /c rmdir "$(cygpath -w "$1")" >/dev/null 2>&1 || true; }
clean_dir() {
  local unix=$1
  remove_junction "$unix/app/node_modules"
  # The fixture tree's ACL-denied directory must be unlocked before it can be deleted.
  if [ -d "$unix/fixtures" ]; then
    bash "$TOOLS/fixture-tree.sh" "$unix/fixtures" unlock >/dev/null 2>&1 || true
  fi
  [ -d "$unix" ] && rm -rf "$unix"
  return 0
}
cleanup() {
  if [ "$KEEP" = yes ]; then
    echo "keeping sandbox: $SCRATCH and $COMPARE"
    return 0
  fi
  clean_dir "$SCRATCH_UNIX"
  clean_dir "$COMPARE_UNIX"
}
trap cleanup EXIT

# --- sandbox -----------------------------------------------------------------------------------

prepare_sandbox() {
  clean_dir "$SCRATCH_UNIX"
  mkdir -p "$SCRATCH_UNIX/app" "$SCRATCH_UNIX/bin" "$SCRATCH_UNIX/argv" "$SCRATCH_UNIX/fixtures"
  if [ "$REF" = worktree ]; then
    # Working-tree mode (tools/parity/preservation-proof.sh run B): the candidate's own app files,
    # copied. node_modules is never copied — it is junctioned below, exactly as in a recorded run.
    for part in server.js package.json; do
      [ -f "$REPO_UNIX/$part" ] || die "worktree sandbox: $part is missing from the working tree"
      cp "$REPO_UNIX/$part" "$SCRATCH_UNIX/app/$part"
    done
    for part in public legacy; do
      [ -d "$REPO_UNIX/$part" ] || die "worktree sandbox: $part/ is missing from the working tree"
      cp -r "$REPO_UNIX/$part" "$SCRATCH_UNIX/app/$part"
    done
  else
    git -C "$REPO_UNIX" archive "$REF" | tar -x -C "$SCRATCH_UNIX/app"
  fi
  [ -f "$SCRATCH_UNIX/app/server.js" ] || die "git archive produced no server.js"
  MSYS_NO_PATHCONV=1 cmd /c mklink /J "$(cygpath -w "$SCRATCH_UNIX/app/node_modules")" "$(cygpath -w "$REPO_UNIX/node_modules")" >/dev/null \
    || die "mklink /J failed for the node_modules junction"
  [ -f "$SCRATCH_UNIX/app/node_modules/express/package.json" ] || die "node_modules junction is not readable"

  # Model tree fixture (scan rules, mmproj variants, spaces/non-ASCII/long/unreadable dirs).
  bash "$TOOLS/fixture-tree.sh" "$SCRATCH_UNIX/fixtures" build >/dev/null

  # Stand-in for llama-server.exe: a real PE node can spawn without a shell. See the header of
  # tools/parity/standin-llama-server.cs for why a node.exe copy and a .cmd shim both fail.
  cp "$TOOLS/fake-llama-server.js" "$SCRATCH_UNIX/bin/fake-llama-server.js"
  local candidates=("${PARITY_CSC:-}" "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe" \
                    "C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe")
  CSC=""
  for candidate in "${candidates[@]}"; do
    if [ -n "$candidate" ] && [ -f "$(cygpath -u "$candidate" 2>/dev/null || echo "$candidate")" ]; then CSC=$candidate; break; fi
  done
  [ -n "$CSC" ] || die "no csc.exe found — journeys J4-launch-presets, J5-ui-launch and J6-corpus-smoke
  need the compiled stand-in because their arg vector is built by the app itself. Those ledger rows
  are BLOCKED (plan §4): record them in ESCALATION.md, do not mark them pass and do not skip them."
  rm -f "$SCRATCH_UNIX/bin/fake-llama-server.exe"
  # csc.exe reads a forward slash as its option marker (it accepts /nologo style switches), so every
  # path handed to it has to be in true backslash form.
  CSC_CMD="MSYS_NO_PATHCONV=1 $(cygpath -w "$CSC") -nologo -target:exe -out:$(cygpath -w "$SCRATCH_UNIX/bin/fake-llama-server.exe") $(cygpath -w "$TOOLS/standin-llama-server.cs")"
  MSYS_NO_PATHCONV=1 "$CSC" -nologo -target:exe \
    -out:"$(cygpath -w "$SCRATCH_UNIX/bin/fake-llama-server.exe")" "$(cygpath -w "$TOOLS/standin-llama-server.cs")" \
    || die "csc failed to build the stand-in"
  [ -f "$SCRATCH_UNIX/bin/fake-llama-server.exe" ] || die "stand-in exe was not produced"

  # The journeys bind these llama-server ports; a busy port would change recorded behaviour.
  node -e '
    const net = require("net");
    (async () => {
      const busy = [];
      for (const port of process.argv.slice(1).map(Number)) {
        await new Promise((resolve) => {
          const probe = net.createServer();
          probe.once("error", () => { busy.push(port); resolve(); });
          probe.listen(port, "127.0.0.1", () => probe.close(resolve));
        });
      }
      if (busy.length) { console.log(busy.join(" ")); process.exit(1); }
    })();
  ' 7837 7838 8080 17839 17840 17841 17842 17843 17844 17899 >"$SCRATCH_UNIX/ports-busy.txt" 2>/dev/null || \
    die "port(s) $(cat "$SCRATCH_UNIX/ports-busy.txt") already in use — refusing to kill an unknown process; free them and re-run"
}

# --- recording ---------------------------------------------------------------------------------

[ -f "$COMPARISON" ] || die "missing $COMPARISON — comparison modes must be declared before recording"
[ -d "$REPO_UNIX/migration-resources" ] || die "migration-resources/ corpus is absent; corpus-dependent rows must be marked blocked, never pass"

run_capture() {
  local out=$1
  shift
  echo "== capture -> $out"
  node "$TOOLS/capture-legacy.js" --capture \
    --repo "$REPO" --scratch "$SCRATCH" --out "$out" \
    --standin "$(cygpath -m "$SCRATCH_UNIX/bin/fake-llama-server.exe")" \
    --stub "$(cygpath -m "$TOOLS/nvidia-smi-stub")" \
    --csc "$CSC_CMD" ${ONLY:+--only "$ONLY"} "$@"
}

prepare_sandbox
run_capture "$OUT" "$@"

if [ "$VERIFY" = yes ]; then
  # Second recording into a different output dir. The sandbox path is intentionally identical: the
  # recorded absolute paths are part of the fixtures, so only the destination moves.
  clean_dir "$COMPARE_UNIX"
  mkdir -p "$COMPARE_UNIX"
  prepare_sandbox
  run_capture "$(cygpath -m "$COMPARE_UNIX/fixtures")" "$@"
  node "$TOOLS/capture-legacy.js" --compare "$OUT" "$(cygpath -m "$COMPARE_UNIX/fixtures")" \
    --comparison "$COMPARISON"
fi

echo "fixtures written to $OUT"
