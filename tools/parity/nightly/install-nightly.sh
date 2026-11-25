#!/usr/bin/env bash
# install-nightly.sh — register the nightly parity run in Windows Task Scheduler.
#
# WHAT IT REGISTERS
#   task name : ParityNightly
#   schedule  : daily at 03:00 local time  (/sc DAILY /st 03:00)
#   action    : "<this node.exe>" "<repo>/tools/parity/nightly/run-nightly.js"
#               which runs L1 -> L2 (--repeat 2) -> L3 (--repeat 2) -> L4 self-mode against the
#               legacy tag, writes a block per gate to tools/parity/reports/nightly/nightly-<utc>.log
#               (a .gitignore exception keeps those logs in git), and exits with the NUMBER OF RED
#               GATES (Task Scheduler shows that as LastTaskResult; 0 = all green, 3 = three red).
#
# HOW TO READ IT LATER
#   schtasks /query /tn ParityNightly /v /fo LIST      # next run time + LastTaskResult
#   ls -t tools/parity/reports/nightly/                # one durable log per fire
#   Get-Content (Get-ChildItem tools/parity/reports/nightly/*.log | Sort-Object LastWriteTime -Descending | Select-Object -First 1) -Tail 60
#   bash tools/parity/nightly/install-nightly.sh --status
#
# IDEMPOTENT
# The task is defined here and nowhere else: if ParityNightly already exists it is deleted and
# recreated, so re-running this script is how you change the schedule. Nothing else in the Task
# Scheduler store is touched (--delete-target-only is never used, no other task name appears).
# It does not elevate, does not change any power setting, and starts the job as the current user
# with stored-session-only rights (/rl LIMITED), so it is a no-op on a machine that is asleep.
#
# OPTIONS
#   --status    only print the registration (exit 1 when not registered)
#   --remove    delete the task and exit
#   --at HH:MM  register at a different time (default 03:00); the task name stays ParityNightly

set -euo pipefail

# git-bash rewrites arguments that look like paths; /query and /tn must reach schtasks.exe untouched.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

TASK='ParityNightly'
AT='03:00'
MODE='install'
for ((index = 1; index <= $#; index += 1)); do
    case "${!index}" in
        --status) MODE='status' ;;
        --remove) MODE='remove' ;;
        --at) index=$((index + 1)); AT="${!index}" ;;
        *) echo "install-nightly.sh: unknown argument ${!index}" >&2; exit 2 ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_EXE="$(command -v node)"
[ -n "$NODE_EXE" ] || { echo 'install-nightly.sh: node is not on PATH' >&2; exit 1; }
# run-nightly.js resolves the repo from its own location, but the task action needs a Windows path.
RUNNER_WIN="$(cygpath -w "$SCRIPT_DIR/run-nightly.js" 2>/dev/null || echo "$SCRIPT_DIR\\run-nightly.js")"
NODE_WIN="$(cygpath -w "$NODE_EXE" 2>/dev/null || echo "$NODE_EXE")"

query() {
    schtasks /query /tn "$TASK" /v /fo LIST 2>/dev/null || true
}

registered() {
    schtasks /query /tn "$TASK" >/dev/null 2>&1
}

show() {
    query | grep -Ei 'TaskName|Next Run Time|Status|Last Run Time|Last Result|Schedule Type|Start Time|Task To Run|Run As User' || true
}

if [ "$MODE" = 'status' ]; then
    if registered; then show; exit 0; fi
    echo "task $TASK is NOT registered" >&2
    exit 1
fi

if [ "$MODE" = 'remove' ]; then
    if registered; then
        schtasks /delete /tn "$TASK" /f
        echo "deleted $TASK"
    else
        echo "$TASK was not registered; nothing to delete"
    fi
    exit 0
fi

if registered; then
    echo "replacing the existing $TASK registration (idempotent: delete + create)"
    schtasks /delete /tn "$TASK" /f > /dev/null
fi

# /tr is one string: "<node>" "<runner>", each quoted, so a path with spaces survives.
schtasks /create /tn "$TASK" /sc DAILY /st "$AT" \
    /tr "\"$NODE_WIN\" \"$RUNNER_WIN\"" /f > /dev/null

echo "registered $TASK: daily at $AT"
echo "  action: \"$NODE_WIN\" \"$RUNNER_WIN\""
echo "  log   : tools/parity/reports/nightly/nightly-<utc>.log (one per fire, git-visible)"
echo "  exit  : number of red gates, recorded as LastTaskResult (0 = all green)"
echo
if registered; then
    show
    exit 0
fi
echo "schtasks reported success but $TASK is not queryable" >&2
exit 1
