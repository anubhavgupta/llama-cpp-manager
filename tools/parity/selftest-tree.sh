#!/usr/bin/env bash
# Self-test for fixture-tree.sh + nvidia-smi-stub (plan.md §2 Phase 1.2/1.3).
# Drives both tools the way the L1 suite will: the fixture tree through find(1) and node's fs,
# the stub through child_process with its directory prepended to PATH, using the exact
# execSync command string from the win32 branch of server.js getSystemMetrics().
#
# usage: bash tools/parity/selftest-tree.sh
# One PASS/FAIL line per check; exits non-zero if any check failed.
set -uo pipefail

TOOLS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
FIXTURE_TREE="$TOOLS/fixture-tree.sh"
STUB_DIR_WIN=$(cygpath -w "$TOOLS/nvidia-smi-stub")
# The invocation server.js makes (server.js:108), verbatim.
QUERY='--query-gpu=utilization.gpu,memory.total,memory.used --format=csv,noheader,nounits'

PASS=0
FAIL=0
ok()  { echo "PASS $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL $1: $2"; FAIL=$((FAIL + 1)); }
check() { # check <name> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3] got [$2]"; fi
}
check_multiline() { # check_multiline <name> <actual> <expected>
  if [ "$2" = "$3" ]; then
    ok "$1"
  else
    bad "$1" "diff:"
    diff <(printf '%s\n' "$3") <(printf '%s\n' "$2") | sed 's/^/    /'
  fi
}

RUN=$(mktemp -d /tmp/ptree.XXXXXX)
TARGET="$RUN/tree"
MANIFEST="$TARGET/fixture-tree-manifest.txt"
UNREAD_WIN=$(cygpath -w "$TARGET/models/unreadable")
cleanup() {
  if [ -n "${KEEP_RUN:-}" ]; then
    echo "run dir kept: $RUN"
    return
  fi
  bash "$FIXTURE_TREE" "$TARGET" clean >/dev/null 2>&1
  rm -rf -- "$RUN"
}
trap cleanup EXIT

echo "== fixture-tree.sh =="

build1=$(bash "$FIXTURE_TREE" "$TARGET" build 2>&1)
rc=$?
printf '%s\n' "$build1" | sed 's/^/    /'
check "build exit code" "$rc" "0"
if [ -f "$MANIFEST" ]; then
  ok "manifest written at $MANIFEST"
else
  bad "manifest written" "absent"
fi

manifest_created=$(grep -v '^MISSING:' "$MANIFEST")
created_count=$(printf '%s\n' "$manifest_created" | wc -l)
if [ "$created_count" -gt 20 ]; then ok "manifest lists $created_count created paths"; else bad "manifest size" "only $created_count paths"; fi
check "manifest lists itself" "$(printf '%s\n' "$manifest_created" | grep -cx 'fixture-tree-manifest.txt')" "1"

# The created-path block and the MISSING block are each LC_ALL=C sorted (blocks are separate:
# 'MISSING:' starts with an upper-case M, which would interleave ahead of 'models/').
created_block=$(printf '%s\n' "$manifest_created")
missing_block=$(grep '^MISSING:' "$MANIFEST")
if printf '%s\n' "$created_block" | LC_ALL=C sort -c 2>/dev/null; then ok "created-path block is sorted"; else bad "created-path block sorted" "not sorted"; fi
if printf '%s\n' "$missing_block" | LC_ALL=C sort -c 2>/dev/null; then ok "MISSING block is sorted"; else bad "MISSING block sorted" "not sorted"; fi
# MSYS grep cannot be used to look for a bare CR (it degrades to matching every line).
check "manifest is LF-only" "$(tr -dc '\r' < "$MANIFEST" | wc -c)" "0"

# Locked state: the ACL-hidden subtree must be absent from find(1) but present in the manifest.
find_locked=$(cd "$TARGET" && find . -mindepth 1 2>/dev/null | sed 's|^\./||' | LC_ALL=C sort)
manifest_visible=$(printf '%s\n' "$created_block" | grep -v '^models/unreadable/')
check_multiline "find(1) matches the manifest outside the ACL-hidden subtree" "$find_locked" "$manifest_visible"
hidden_listed=$(printf '%s\n' "$created_block" | grep -c '^models/unreadable/')
check "manifest records the ACL-hidden subtree (3 paths)" "$hidden_listed" "3"
check "find(1) is denied on models/unreadable" "$(cd "$TARGET" && find . -mindepth 1 2>&1 >/dev/null | grep -c 'Permission denied')" "1"

rd=$(node -e 'try{require("fs").readdirSync(process.argv[1]);console.log("NO_THROW")}catch(e){console.log("THROWS:"+e.code)}' "$UNREAD_WIN")
case "$rd" in
  THROWS:*) ok "node fs.readdirSync(models/unreadable) throws ($rd)" ;;
  *) bad "node fs.readdirSync(models/unreadable) throws" "it returned normally" ;;
esac
# The deny covers List-directory/read-data only, so the hidden model is still there to be found
# by stat: it is ACL-hidden from the scan, not missing from disk.
hidden_stat=$(node -e 'const s=require("fs").statSync(process.argv[1]);console.log(s.size>0?"ok":"empty")' "$(cygpath -w "$TARGET/models/unreadable/unreadable-model.gguf")" 2>&1)
check "hidden model still on disk (statSync succeeds)" "$hidden_stat" "ok"

# mmproj scan rules, per server.js findGGUFFiles(): exclusion is name.toLowerCase().startsWith(
# 'mmproj'), association is dirItem.name.startsWith('mmproj') (case-sensitive), first readdir
# match, same directory only.
mm_case_sensitive=$(find "$TARGET/models/MMProj-case-only" -type f -name 'mmproj*' | wc -l)
mm_case_insensitive=$(find "$TARGET/models/MMProj-case-only" -type f -iname 'mmproj*' | wc -l)
check "case probe: lowercase mmproj candidates in models/MMProj-case-only (association)" "$mm_case_sensitive" "0"
check "case probe: case-insensitive mmproj matches in models/MMProj-case-only (exclusion)" "$mm_case_insensitive" "1"
check "sibling negative: no mmproj in models/a/b (parent's mmproj must not associate)" "$(find "$TARGET/models/a/b" -type f -iname '*mmproj*' | wc -l)" "0"
check "positive association: models/a has exactly one mmproj" "$(find "$TARGET/models/a" -maxdepth 1 -type f -iname 'mmproj*' | wc -l)" "1"
check "first-match probe: models/multi-mmproj has three mmproj candidates" "$(find "$TARGET/models/multi-mmproj" -type f -iname 'mmproj*' | wc -l)" "3"
check "mmproj-only dir contributes no model" "$(find "$TARGET/models/mmproj-only-here" -type f -iname '*.gguf' ! -iname 'mmproj*' | wc -l)" "0"
check "base dir mmproj present for base-level association" "$([ -f "$TARGET/models/mmproj-root.gguf" ] && echo yes)" "yes"
check "every mmproj file is a .gguf (exclusion runs before the extension test)" "$(find "$TARGET/models" -name unreadable -prune -o -type f -iname 'mmproj*' ! -iname '*.gguf' -print 2>/dev/null | wc -l)" "0"
check "case-insensitive extension: UPPERCASE-EXT.GGUF present" "$([ -f "$TARGET/models/uppercase-ext/UPPERCASE-EXT.GGUF" ] && echo yes)" "yes"
check "spaces + non-ASCII paths present" "$([ -f "$TARGET/models/models with spaces/spaced model Q4.gguf" ] && [ -f "$TARGET/models/ünïcødé-тест/ünïcødé-model.gguf" ] && echo yes)" "yes"
long_entry=$(printf '%s\n' "$created_block" | grep -m1 '^models/longdir-')
long_name=${long_entry#models/}
check "long dir name is >150 chars" "$([ ${#long_name} -gt 150 ] && echo yes) yes" "yes yes"
check "model behind the long dir name present" "$([ -f "$TARGET/$long_entry/long-path-model.gguf" ] && echo yes)" "yes"
check "empty dir present" "$([ -d "$TARGET/models/empty" ] && echo yes)" "yes"
check "node reads models/empty as []" "$(node -e 'console.log(JSON.stringify(require("fs").readdirSync(process.argv[1])))' "$(cygpath -w "$TARGET/models/empty")")" "[]"

check "manifest records 3 MISSING paths" "$(printf '%s\n' "$missing_block" | wc -l)" "3"
still_there=''
while IFS= read -r line; do
  p=${line#MISSING:}
  if [ -e "$TARGET/$p" ]; then still_there="$still_there $p"; fi
done <<< "$missing_block"
check "MISSING paths absent from disk" "${still_there:-none}" "none"

check "build reports the unreadable-dir deny as verified" "$(printf '%s\n' "$build1" | grep -cx 'UNREADABLE verified=yes (node fs.readdirSync throws)')" "1"

# Unlocked state: full find(1) output must equal the full created-path block.
bash "$FIXTURE_TREE" "$TARGET" unlock >/dev/null 2>&1
find_full=$(cd "$TARGET" && find . -mindepth 1 | sed 's|^\./||' | LC_ALL=C sort)
check_multiline "find(1) matches the full manifest after unlock" "$find_full" "$created_block"

cp "$MANIFEST" "$RUN/manifest-run1.txt"
check "clean exit code" "$(bash "$FIXTURE_TREE" "$TARGET" clean >/dev/null 2>&1; echo $?)" "0"
check "clean removed the target subtree" "$([ -e "$TARGET" ] && echo present || echo gone)" "gone"

build2=$(bash "$FIXTURE_TREE" "$TARGET" build 2>&1)
rc=$?
check "second build exit code" "$rc" "0"
check "second build re-verifies the deny" "$(printf '%s\n' "$build2" | grep -cx 'UNREADABLE verified=yes (node fs.readdirSync throws)')" "1"
if cmp -s "$MANIFEST" "$RUN/manifest-run1.txt"; then
  ok "manifest byte-identical after rebuild (idempotent)"
else
  bad "manifest byte-identical after rebuild" "differs"
fi
check "tree is still hidden after rebuild" "$(node -e 'try{require("fs").readdirSync(process.argv[1]);console.log("NO_THROW")}catch(e){console.log("THROWS")}' "$UNREAD_WIN")" "THROWS"

echo "== nvidia-smi-stub =="

STUB_CHECK_JS='
const { execSync } = require("child_process");
const stub = process.argv[1], mode = process.argv[2], tail = process.argv[3];
const env = Object.assign({}, process.env, { PATH: stub + ";" + process.env.PATH });
if (mode === "unset") { delete env.NVIDIA_SMI_STUB_MODE; } else { env.NVIDIA_SMI_STUB_MODE = mode; }
let status, out = "", err = "";
try {
  out = execSync("nvidia-smi " + tail, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  status = 0;
} catch (e) {
  status = (e.status === null || e.status === undefined) ? ("signal:" + e.signal) : e.status;
  out = e.stdout == null ? "" : String(e.stdout);
  err = e.stderr == null ? "" : String(e.stderr);
}
console.log("exit=" + status + " stdout=" + JSON.stringify(out) + " stderr=" + JSON.stringify(err));
'
stub_check() { MSYS2_ARG_CONV_EXCL='*' node -e "$STUB_CHECK_JS" "$STUB_DIR_WIN" "$1" "${2-$QUERY}"; }

check "stub resolves as nvidia-smi on PATH, mode ok" "$(stub_check ok)" 'exit=0 stdout="42, 24576, 12345\n" stderr=""'
check "stub mode unset defaults to ok" "$(stub_check unset)" 'exit=0 stdout="42, 24576, 12345\n" stderr=""'
check "stub mode multi prints 3 lines, first identical to ok" "$(stub_check multi)" 'exit=0 stdout="42, 24576, 12345\n11, 1111, 111\n22, 2222, 222\n" stderr=""'
check "stub mode garbage exits 0 with non-CSV stdout" "$(stub_check garbage)" 'exit=0 stdout="not a csv\n" stderr=""'
check "stub mode fail exits 1 with empty stdout" "$(stub_check fail)" 'exit=1 stdout="" stderr=""'
check "stub rejects an invocation other than the server.js one" "$(stub_check ok '')" 'exit=1 stdout="" stderr="nvidia-smi-stub: unexpected invocation: []\n"'
check "stub rejects an unknown mode" "$(stub_check bogus)" 'exit=1 stdout="" stderr="nvidia-smi-stub: unknown NVIDIA_SMI_STUB_MODE: bogus\n"'

HANG_JS='
const { spawn, execFileSync } = require("child_process");
const stub = process.argv[1];
const env = Object.assign({}, process.env, { PATH: stub + ";" + process.env.PATH, NVIDIA_SMI_STUB_MODE: "hang" });
const child = spawn("nvidia-smi --query-gpu=utilization.gpu,memory.total,memory.used --format=csv,noheader,nounits",
  { shell: true, env, stdio: "ignore" });
let running = true;
child.on("exit", () => { running = false; });
child.on("error", () => { running = false; });
setTimeout(() => {
  const alive = running;
  try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch (e) {}
  console.log("aliveAfter3s=" + alive);
  process.exit(0);
}, 3000);
'
hang=$(MSYS2_ARG_CONV_EXCL='*' node -e "$HANG_JS" "$STUB_DIR_WIN")
case "$hang" in
  aliveAfter3s=true) ok "stub mode hang still running after 3 s, process tree killed ($hang)" ;;
  *) bad "stub mode hang still running after 3 s" "got [$hang]" ;;
esac

echo "== summary: PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ] || exit 1
exit 0
