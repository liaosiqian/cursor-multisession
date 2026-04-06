#!/usr/bin/env bash
# MultiSession Hook: check queue for pending messages before tool execution.
# If pending messages exist and the current tool is NOT check_messages,
# inject an agentMessage to prioritize queue consumption.

set -euo pipefail

SESSIONS_DIR="$HOME/.multisession/sessions"

input=$(cat)

hook_event=$(echo "$input" | grep -o '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
tool_name=$(echo "$input" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
server_name=$(echo "$input" | grep -o '"server"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"server"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

if [ "$hook_event" = "beforeMCPExecution" ]; then
  if [ "$tool_name" = "check_messages" ] || [ "$server_name" != "MultiSession" ]; then
    echo '{"continue":true,"permission":"allow"}'
    exit 0
  fi
fi

if [ ! -d "$SESSIONS_DIR" ]; then
  echo '{"continue":true,"permission":"allow"}'
  exit 0
fi

pending_count=0
pending_sessions=""

for queue_file in "$SESSIONS_DIR"/*/queue.json; do
  [ -f "$queue_file" ] || continue
  count=$(python3 -c "
import json, sys
try:
    q = json.load(open('$queue_file'))
    print(len(q) if isinstance(q, list) else 0)
except:
    print(0)
" 2>/dev/null || echo 0)
  if [ "$count" -gt 0 ]; then
    session_id=$(basename "$(dirname "$queue_file")")
    pending_count=$((pending_count + count))
    if [ -n "$pending_sessions" ]; then
      pending_sessions="$pending_sessions, $session_id"
    else
      pending_sessions="$session_id"
    fi
  fi
done

if [ "$pending_count" -gt 0 ]; then
  cat <<HOOKEOF
{"continue":true,"permission":"allow","agentMessage":"[MultiSession 提醒] 队列中有 ${pending_count} 条待处理用户消息 (sessions: ${pending_sessions})，请在当前操作完成后立即调用 check_messages 处理。"}
HOOKEOF
else
  echo '{"continue":true,"permission":"allow"}'
fi
