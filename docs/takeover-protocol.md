# 接管协议:外部编排器派发任务与断连恢复

MultiSession 的 MCP 是 stdio 通道,由 Cursor 独占,外部进程无法直接调用。
因此对 GUI 会话的"接管"走**文件协议**——插件本身就用它通信(微信桥桥接同一条链路)。

## 数据根

默认 `~/.multisession`,可用环境变量 `MULTISESSION_DATA_ROOT` 整体覆盖:

- 扩展宿主:进程环境变量(`src/shared/data-root.ts`)
- MCP 子进程:`.cursor/mcp.json` 里的 `env`(`npm run install-mcp` 时若已设置会一并写入)
- Hook 脚本:`MULTISESSION_DATA_ROOT` 环境变量

用途:起隔离的 Cursor 实例做验证时,不要和在用窗口共用同一份会话状态;
否则两个实例会互相 claim 窗口 token、互相收编 session。

## 派发(入站)

向 `sessions/<sid>/queue.json` 追加一条消息:

```json
{
  "id": "d-abc123",
  "dispatch_id": "d-abc123",
  "type": "text",
  "content": "任务正文",
  "images": [],
  "timestamp": "2026-10-09T05:00:00.000Z",
  "urgent": false
}
```

- `dispatch_id` 是**幂等键**:同一 `dispatch_id` 即使被重复投递(断连重发),插件也只执行一次。
- 写入前请取锁(`sessions/<sid>/.queue.lock`,见 `scripts/ms-dispatch.mjs`):
  扩展面板与微信桥同样是无锁读改写,并发写会丢消息。

## 观察(出站)

| 文件 | 含义 |
|------|------|
| `inflight.json` | 在飞任务:`dispatch_id`、`consumed_at`、`mcp_pid`、`replay_count`、`completed_at`、`completed_by` |
| `dispatch-history.json` | 派发账本:每个 `dispatch_id` 的消费时间与完成方式(最多 200 条) |
| `status.json` | `status`、`since`、`awaiting_reply`、`last_heartbeat_at`(长轮询每 10s 续期)、`message_id`、`dispatch_id` |
| `summary.json` | 每轮回复摘要 `{text, ts}` |
| `chat-log.json` | 完整对话,`role: user/assistant` |

判活优先级:`status.last_heartbeat_at` 新鲜(≤30s)说明有 Composer 正在长轮询,写入即被消费;
`active-window.json` 的窗口心跳(15s 失效)说明 Cursor 窗口还在;`mcp-claims.json` 说明 MCP 进程归属。

## 断连与恢复

1. **未送达**:消息还在 `queue.json` 里 —— 同 `dispatch_id` 重发即可(幂等)。
2. **处理中**:`inflight.json` 有记录且未 `completed_at`,`mcp_pid` 仍存活 —— 等待,不要重发。
3. **断连**:`inflight.json` 有记录且未收尾,但 `mcp_pid` 已退出 —— 说明任务中途被打断。
   在该会话重新建立长轮询(面板「恢复规则」或 `check_messages(session_id=...)`)后,插件会把
   未完成任务原文交还 Agent 续做(`replay_count` 最多 2 次)。
4. **已回复**:`inflight.completed_at` 或 `summary.ts` 刷新 —— 读取 `summary.json`/`chat-log.json` 拿结果。

## 工具

```bash
# 列出会话与可投递性(active / idle / none)
node scripts/ms-dispatch.mjs sessions

# 派发并等待送达 + 回复
node scripts/ms-dispatch.mjs dispatch --session <id|名称> --task "任务正文" --wait
node scripts/ms-dispatch.mjs dispatch --workspace /path/to/repo --task "任务正文" --dispatch-id d-1

# 查看某个会话的在飞状态(working / disconnected / idle)
node scripts/ms-dispatch.mjs status --session <id> --json
```

## 验证

```bash
npm run test:e2e
```

`tests/takeover-e2e.mjs` 覆盖派发→消费→在飞记账→幂等去重→断连续做→收尾;
`tests/dispatch-cli-e2e.mjs` 覆盖 CLI 派发、送达/回复判定与账本幂等。
两者都使用临时数据根,不动在用的 `~/.multisession`。

