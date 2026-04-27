#!/usr/bin/env bash
# Usage: watch-agent-events.sh [path/to/.agent-events.jsonl]
# Tails the shared agent event log and pretty-prints each event.
# Defaults to ./.agent-events.jsonl in the current directory.

set -euo pipefail

LOG="${1:-.agent-events.jsonl}"

if [[ ! -f "$LOG" ]]; then
  echo "Waiting for $LOG to appear..." >&2
  until [[ -f "$LOG" ]]; do sleep 1; done
fi

echo "Watching $LOG …" >&2

tail -n 0 -f "$LOG" | while IFS= read -r line; do
  event=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('event','?'))" 2>/dev/null || echo "?")
  agent=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('agent',''))" 2>/dev/null || echo "")
  ts=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ts','')[:19])" 2>/dev/null || echo "")

  case "$event" in
    AGENT:COMPRESSION_EVENT)   color="\033[36m" ;;   # cyan
    AGENT:STUCK_WARNING)       color="\033[33m" ;;   # yellow
    AGENT:BUDGET_EXCEEDED)     color="\033[31m" ;;   # red
    AGENT:JOURNAL_DONE_REVERTED) color="\033[31m" ;; # red
    AGENT:VERIFIER_RUN)        color="\033[32m" ;;   # green
    AGENT:SUBAGENT_SPAWNED)    color="\033[35m" ;;   # magenta
    AGENT:STAGE_SEALED)        color="\033[32m" ;;   # green
    *)                         color="\033[0m"  ;;   # default
  esac

  printf "${color}%s  %-40s  %s\033[0m\n" "$ts" "$event" "$agent"
done
