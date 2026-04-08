#!/usr/bin/env bash
# MultiSession Hook: check queue for pending/urgent messages before tool/shell execution.
# - urgent messages: inject agent_message to prioritize queue consumption immediately
# - normal pending: gentle reminder after current operation

set -euo pipefail

SESSIONS_DIR="$HOME/.multisession/sessions"

input=$(cat)

hook_event=$(echo "$input" | grep -o '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
tool_name=$(echo "$input" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
server_name=$(echo "$input" | grep -o '"server"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"server"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)

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

result=$(python3 -c "
import json, os, sys, glob

sessions_dir = sys.argv[1]
pending_count = 0
urgent_items = []
pending_sessions = []

for queue_file in glob.glob(os.path.join(sessions_dir, '*', 'queue.json')):
    try:
        with open(queue_file) as f:
            queue = json.load(f)
        if not isinstance(queue, list) or len(queue) == 0:
            continue
    except:
        continue

    session_id = os.path.basename(os.path.dirname(queue_file))
    pending_count += len(queue)
    pending_sessions.append(session_id)

    for msg in queue:
        if msg.get('urgent'):
            content = msg.get('content') or msg.get('text', '')
            urgent_items.append({'session_id': session_id, 'content': content[:200]})

if urgent_items:
    parts = [f'[{u[\"session_id\"]}] {u[\"content\"]}' for u in urgent_items]
    hint = ' | '.join(parts)
    json.dump({
        'continue': True,
        'permission': 'allow',
        'agent_message': f'[MultiSession] 用户有优先任务，请立即调用 check_messages 处理：{hint}'
    }, sys.stdout, ensure_ascii=False)
elif pending_count > 0:
    sids = ', '.join(pending_sessions)
    json.dump({
        'continue': True,
        'permission': 'allow',
        'agent_message': f'[MultiSession] 队列中有 {pending_count} 条待处理消息 (sessions: {sids})，请在当前操作完成后调用 check_messages 处理。'
    }, sys.stdout, ensure_ascii=False)
else:
    json.dump({'continue': True, 'permission': 'allow'}, sys.stdout)
" "$SESSIONS_DIR" 2>/dev/null)

if [ -z "$result" ]; then
  echo '{"continue":true,"permission":"allow"}'
else
  echo "$result"
fi
