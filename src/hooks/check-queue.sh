#!/usr/bin/env bash
# MultiSession Hook: check queue for pending/urgent messages before tool/shell execution.
# Only checks sessions belonging to the current workspace (via $PWD).
# Output: { permission: "allow"|"deny", agentMessage?: string }

set -uo pipefail

ALLOW='{"permission":"allow"}'
DATA_ROOT="$HOME/.multisession"
SESSIONS_DIR="$DATA_ROOT/sessions"
SESSIONS_META="$DATA_ROOT/sessions.json"
CONV_MAP="$DATA_ROOT/conv-session-map.json"

input=$(cat)

hook_event=$(echo "$input" | grep -o '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
tool_name=$(echo "$input" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
server_name=$(echo "$input" | grep -o '"server"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"server"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
conv_id=$(echo "$input" | grep -o '"conversation_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"conversation_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)

if [ "$hook_event" = "beforeMCPExecution" ]; then
  if [ "$tool_name" = "check_messages" ]; then
    # Build conversation_id -> session_id mapping from tool_input
    if [ -n "$conv_id" ]; then
      python3 -c "
import json, sys, os
raw_input = sys.argv[1]
conv_map_path = sys.argv[2]
conv_id = sys.argv[3]
try:
    full = json.loads(raw_input)
    tool_input_str = full.get('tool_input', '{}')
    # tool_input may be a JSON string or already an object
    if isinstance(tool_input_str, str):
        ti = json.loads(tool_input_str)
    else:
        ti = tool_input_str
    sid = ti.get('session_id', '')
except:
    sid = ''
if sid and conv_id:
    try:
        with open(conv_map_path) as f:
            m = json.load(f)
    except:
        m = {}
    m[conv_id] = sid
    os.makedirs(os.path.dirname(conv_map_path), exist_ok=True)
    with open(conv_map_path, 'w') as f:
        json.dump(m, f)
" "$input" "$CONV_MAP" "$conv_id" 2>/dev/null
    fi
    echo "$ALLOW"
    exit 0
  fi
  case "$server_name" in
    *MultiSession*) ;;
    *)
      echo "$ALLOW"
      exit 0
      ;;
  esac
fi

if [ ! -d "$SESSIONS_DIR" ] || [ ! -f "$SESSIONS_META" ]; then
  echo "$ALLOW"
  exit 0
fi

result=$(python3 -c "
import json, os, sys

sessions_dir = sys.argv[1]
sessions_meta = sys.argv[2]
current_ws = sys.argv[3]
conv_map_path = sys.argv[4]
conv_id = sys.argv[5]

try:
    with open(sessions_meta) as f:
        all_sessions = json.load(f)
except:
    json.dump({'permission': 'allow'}, sys.stdout)
    sys.exit(0)

# Resolve which session this Composer belongs to via conversation_id mapping
my_session_id = None
if conv_id:
    try:
        with open(conv_map_path) as f:
            conv_map = json.load(f)
        my_session_id = conv_map.get(conv_id)
    except:
        pass

ws_session_ids = set()
for s in all_sessions:
    if s.get('alive') and s.get('workspace') == current_ws:
        ws_session_ids.add(s['id'])

if not ws_session_ids:
    json.dump({'permission': 'allow'}, sys.stdout)
    sys.exit(0)

# Only check OTHER sessions' queues (exclude self)
check_ids = ws_session_ids - {my_session_id} if my_session_id else ws_session_ids

pending_count = 0
urgent_items = []
pending_sessions = []

for sid in check_ids:
    queue_file = os.path.join(sessions_dir, sid, 'queue.json')
    try:
        with open(queue_file) as f:
            queue = json.load(f)
        if not isinstance(queue, list) or len(queue) == 0:
            continue
    except:
        continue

    pending_count += len(queue)
    pending_sessions.append(sid)

    for msg in queue:
        if msg.get('urgent'):
            content = msg.get('content') or msg.get('text', '')
            urgent_items.append({'session_id': sid, 'content': content[:200]})

if urgent_items:
    parts = [f'[{u[\"session_id\"]}] {u[\"content\"]}' for u in urgent_items]
    hint = ' | '.join(parts)
    # Only hard-deny when we know this Composer is NOT the target session;
    # if mapping is unknown, use allow + agentMessage to avoid blocking all Composers
    perm = 'deny' if my_session_id else 'allow'
    json.dump({
        'permission': perm,
        'agentMessage': f'[MultiSession] 用户有优先任务，请立即调用 check_messages 处理：{hint}'
    }, sys.stdout, ensure_ascii=False)
elif pending_count > 0:
    sids = ', '.join(pending_sessions)
    json.dump({
        'permission': 'allow',
        'agentMessage': f'[MultiSession] 队列中有 {pending_count} 条待处理消息 (sessions: {sids})，请在当前操作完成后调用 check_messages 处理。'
    }, sys.stdout, ensure_ascii=False)
else:
    json.dump({'permission': 'allow'}, sys.stdout)
" "$SESSIONS_DIR" "$SESSIONS_META" "$PWD" "$CONV_MAP" "$conv_id" 2>/dev/null)

if [ -z "$result" ]; then
  echo "$ALLOW"
else
  echo "$result"
fi
