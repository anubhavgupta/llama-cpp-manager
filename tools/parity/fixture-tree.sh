#!/usr/bin/env bash
# Phase 1: deterministic fixture model tree for the /models scan rules of server.js
# (plan.md §2 Phase 1.2, §11). Fixtures are read-only inputs for the L1 scan-rule asserts.
#
# The layout encodes findGGUFFiles() in server.js exactly as written:
#   exclusion : item.isFile() && item.name.toLowerCase().startsWith('mmproj') -> continue
#   model     : item.isFile() && item.name.toLowerCase().endsWith('.gguf')   (case-insensitive ext)
#   associate : dirItem.name.startsWith('mmproj')  -> case-SENSITIVE, first match in readdir
#               order, scanning only the entries of the model's own directory
# server.js has no Bench rule (nor does public/script.js), so models/Bench/ is an ordinary
# directory and llama-bench-*.gguf an ordinary model; the dir is kept as a case probe.
#
# usage: bash fixture-tree.sh <target-dir> [build|clean]     (default: build)
#        bash fixture-tree.sh <target-dir> unlock
#   build   create/refresh the tree (idempotent), write fixture-tree-manifest.txt, apply the ACL deny
#   unlock  lift the ACL read-deny so find(1) can enumerate the ACL-hidden subtree
#   clean   lift the ACL read-deny, then remove the whole target subtree
#
# fixture-tree-manifest.txt: UTF-8, LF, LC_ALL=C sorted relative paths (slash separated) of every
# created file and directory, including the manifest itself; then a sorted block of
# 'MISSING:<relpath>' lines for paths that must not exist.
#
# Blast radius (AGENTS.md): refuses to operate on the repo itself, $HOME or filesystem roots.
set -euo pipefail

USAGE='usage: bash fixture-tree.sh <target-dir> [build|clean|unlock]'
if [ $# -lt 1 ]; then echo "$USAGE" >&2; exit 2; fi
TARGET_IN=$1
ACTION=${2:-build}
case "$ACTION" in build|clean|unlock) ;; *) echo "$USAGE" >&2; exit 2 ;; esac

TARGET=$(realpath -m -- "$TARGET_IN")
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
case "$TARGET" in
  ''|/|"$HOME"|"$REPO_ROOT")
    echo "refusing to operate on '$TARGET'" >&2
    exit 2
    ;;
esac
if [ -n "$REPO_ROOT" ]; then
  case "$TARGET" in
    "$REPO_ROOT"/*)
      echo "refusing to build the fixture tree inside the repo: $TARGET" >&2
      exit 2
      ;;
  esac
fi

MANIFEST_NAME=fixture-tree-manifest.txt
UNREADABLE=models/unreadable
# BUILTIN\Users first (the task's suggested trustee); Everyone as fallback for accounts whose
# token does not carry BUILTIN\Users, e.g. a bare Administrators-elevated token.
DENY_TRUSTEES=('*S-1-5-32-545' '*S-1-1-0')
# RD = List folder / read data. Deliberately not generic (R): children keep Read Attributes so
# this script can still stat the hidden paths, while readdir/read both fail — which is the exact
# failure server.js searchDirectory() swallows in its catch.
DENY_ACE='(CI)(OI)(RD)'

LONG_DIR="longdir-$(printf 'x%.0s' $(seq 1 148))"

DIRS=(
  models
  models/a
  models/a/b
  models/Bench
  models/MMProj-case-only
  models/multi-mmproj
  models/mmproj-only-here
  'models/models with spaces'
  'models/ünïcødé-тест'
  "models/$LONG_DIR"
  "$UNREADABLE"
  "$UNREADABLE/sub"
  models/uppercase-ext
  models/empty
)

FILES=(
  # base dir: model + its lowercase mmproj (association resolves at the base level too)
  models/model-root.gguf
  models/mmproj-root.gguf
  # exactly one lowercase mmproj in the dir -> unambiguous positive association
  models/a/model-a.gguf
  models/a/mmproj-model-a-F16.gguf
  models/a/notes.txt
  # negative association: the only mmproj is in the parent directory
  models/a/b/deep-b-model.gguf
  # no Bench rule in server.js -> ordinary model
  models/Bench/llama-bench-benchmarks.gguf
  # exclusion is case-insensitive, association is case-sensitive -> mmprojFile stays null
  models/MMProj-case-only/MMProj-image.gguf
  models/MMProj-case-only/case-probe-model.gguf
  # first-match association: three lowercase mmproj candidates in one dir
  models/multi-mmproj/multi-model.gguf
  models/multi-mmproj/mmproj-a.gguf
  models/multi-mmproj/mmproj-b.gguf
  models/multi-mmproj/mmproj-c.gguf
  # mmproj with no model in its directory -> contributes nothing
  models/mmproj-only-here/mmproj-orphan.gguf
  # spaces in a directory name and in file names
  'models/models with spaces/spaced model Q4.gguf'
  'models/models with spaces/mmproj-spaced model Q4.gguf'
  # non-ASCII directory and file names
  'models/ünïcødé-тест/ünïcødé-model.gguf'
  # model behind a >150-character directory name
  "models/$LONG_DIR/long-path-model.gguf"
  # invisible to /models: fs.readdir throws, server.js logs and skips the directory
  "$UNREADABLE/unreadable-model.gguf"
  "$UNREADABLE/sub/deep-unreadable.gguf"
  # .gguf match is case-insensitive
  models/uppercase-ext/UPPERCASE-EXT.GGUF
)

MISSING=(
  models/missing-dir/absent-model.gguf
  models/missing-root-model.gguf
  models/a/b/missing-nested-model.gguf
)

# icacls must not see MSYS-mangled /deny style switches.
run_icacls() { MSYS2_ARG_CONV_EXCL='*' icacls "$@"; }

win() { cygpath -w "$1"; }

# node fs.readdirSync on a Windows path: 0 = readable, 1 = threw
readdir_throws() {
  node -e 'try{require("fs").readdirSync(process.argv[1]);process.exit(1)}catch(e){process.exit(0)}' "$1"
}

unlock_deny() {
  if [ -d "$TARGET/$UNREADABLE" ]; then
    local w t
    w=$(win "$TARGET/$UNREADABLE")
    for t in "${DENY_TRUSTEES[@]}"; do
      run_icacls "$w" /remove:d "$t" >/dev/null 2>&1 || true
    done
  fi
}

apply_deny() {
  local w mech='' verified=no t
  w=$(win "$TARGET/$UNREADABLE")
  if readdir_throws "$w"; then
    mech='already-denied'
    verified=yes
  else
    for t in "${DENY_TRUSTEES[@]}"; do
      mech="icacls /deny $t:$DENY_ACE"
      run_icacls "$w" /deny "$t:$DENY_ACE" >/dev/null 2>&1 || true
      if readdir_throws "$w"; then
        verified=yes
        break
      fi
    done
  fi
  echo "UNREADABLE dir=$TARGET/$UNREADABLE"
  echo "UNREADABLE mechanism=$mech"
  echo "UNREADABLE verified=$verified (node fs.readdirSync $( [ "$verified" = yes ] && echo 'throws' || echo 'does NOT throw'))"
  if [ "$verified" != yes ]; then
    echo "UNREADABLE WARNING: icacls could not make node readdir fail; scan-rule asserts are void" >&2
  fi
}

created_paths() {
  printf '%s\n' "$MANIFEST_NAME"
  printf '%s\n' "${DIRS[@]}"
  printf '%s\n' "${FILES[@]}"
}

write_manifest() {
  {
    created_paths | LC_ALL=C sort -u
    printf '%s\n' "${MISSING[@]}" | sed 's|^|MISSING:|' | LC_ALL=C sort
  } > "$TARGET/$MANIFEST_NAME"
}

verify_created() {
  local absent=0 p
  for p in "$MANIFEST_NAME" "${DIRS[@]}" "${FILES[@]}"; do
    if [ ! -e "$TARGET/$p" ]; then
      echo "ABSENT $TARGET/$p" >&2
      absent=$((absent + 1))
    fi
  done
  for p in "${MISSING[@]}"; do
    if [ -e "$TARGET/$p" ]; then
      echo "UNEXPECTED-EXISTS $TARGET/$p" >&2
      absent=$((absent + 1))
    fi
  done
  if [ "$absent" -ne 0 ]; then
    echo "build FAILED: $absent path(s) missing" >&2
    return 1
  fi
  local n
  n=$(created_paths | LC_ALL=C sort -u | wc -l)
  echo "verified created=$n missing=${#MISSING[@]}"
}

do_build() {
  mkdir -p "$TARGET"
  # A previous run may have left the deny in place, which blocks re-creating its contents.
  unlock_deny
  local d f
  for d in "${DIRS[@]}"; do mkdir -p "$TARGET/$d"; done
  for f in "${FILES[@]}"; do
    printf 'GGUF v3 dummy fixture\nname=%s\n' "$f" > "$TARGET/$f"
  done
  write_manifest
  apply_deny
  verify_created
  echo "built target=$TARGET manifest=$TARGET/$MANIFEST_NAME"
}

do_clean() {
  if [ ! -e "$TARGET" ]; then
    echo "clean target=$TARGET already absent"
    return 0
  fi
  unlock_deny
  rm -rf -- "$TARGET"
  if [ -e "$TARGET" ]; then
    echo "clean FAILED: $TARGET still present" >&2
    return 1
  fi
  echo "clean target=$TARGET removed"
}

case "$ACTION" in
  build) do_build ;;
  clean) do_clean ;;
  unlock)
    unlock_deny
    if readdir_throws "$(win "$TARGET/$UNREADABLE")"; then
      echo "unlock FAILED: $TARGET/$UNREADABLE still denied" >&2
      exit 1
    fi
    echo "unlocked $TARGET/$UNREADABLE"
    ;;
esac
