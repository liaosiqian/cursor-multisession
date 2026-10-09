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

## 会话归属与隔离

首次调用(不带 `session_id`)时,MCP 只在**确认该会话没有活持有者**后才会收编它。
活持有者判定(`hasLiveOwner`)任一成立即视为有人:

1. `status.last_heartbeat_at` ≤30s(有 Composer 正在长轮询);
2. 同窗口 token 的其它 MCP claim 仍在续期;
3. `inflight.json` 未收尾且其 `mcp_pid` 仍存活(**含本进程自己**持有的在飞任务)。

收编顺序:本进程服务过且无活持有者的会话 → 同窗口 token 且无活持有者的会话 →
失活超 30s 且窗口 token 已失效的 orphan。都不满足就**新建会话**。

| 现象 | 成因 | 对应规则 |
|------|------|----------|
| 同窗口两个对话抢同一队列 | 只按 windowToken 收编;干活中的对话不在长轮询里,看起来没人 | 必须有活持有者判定 |
| 跨工作区收到别人的消息 | 多根工作区里 `process.cwd()` 只是第一个文件夹;单会话兜底收编 | 只收编本 workspace,不做单会话兜底 |
| 关闭的对话仍占内存 | tick 每轮全量读盘、日志无限增长 | 读盘按 mtime/size 变化,日志只留尾部 50 条 |

**同一对话请始终带 `session_id`** —— 它是归属的唯一确证。全新对话新建会话是预期行为,
不要依赖收编来「继承」上一个对话的上下文。

已知边界:会话心跳在 30s 内仍新鲜、但对话实际已停止(例如 MCP 进程刚被杀)时,
新对话会先新建会话,旧会话最多 30s 后才进入 orphan 回收窗口。

派发侧不受影响:`dispatch --session <id>` 显式指定目标会话,不走收编逻辑。

### 窗口身份与归属

`active-window.json` 的每个条目除了 `token`(扩展宿主每次激活生成)还带 `windowPid`
—— 本窗口 Cursor 主进程 pid。扩展宿主与 MCP 子进程各自向上回溯进程树都能算出同一个值,
因此两边对「谁属于这个窗口」的判断一致(`src/shared/window-identity.ts`)。

会话元数据记录三级归属信号:

| 字段 | 写入方 | 含义 |
|------|--------|------|
| `windowOwnerPid` | MCP 认领窗口时 | 该窗口扩展宿主 pid(窗口级唯一身份) |
| `windowToken` | MCP / 扩展认领时 | 该窗口当前 token |
| `windowPid` | MCP | 创建会话时的窗口主进程 pid |

由此产生三条规则:

1. **MCP 认自己窗口的 token**。以前取「最新未被占用」的 token,多窗口文件夹重叠时会绑到
   别的窗口,本窗口创建的会话被记到别的窗口名下。现在优先匹配自己的 `windowPid`。
2. **面板只显示归属本窗口的会话**。另一个还活着的窗口持有的会话,即使工作区文件夹重叠也
   不显示;持有者已退出/归属缺失的会话仍可见,并在展示时由本窗口认领归属
   (`src/shared/session-visibility.ts`,单测 `tests/visibility-unit.mjs`)。
3. **无归属消息不再自动投递**。`sessions/default/queue.json` 里的消息以前会被「迁移」给下一个
   注册的会话,这是消息串到无关对话的通道;现在只登记到 `sessions/default/unrouted.json`,
   由用户或编排器显式重发。面板没绑定会话时直接拒绝发送并提示。

面板本地状态(日志/队列/摘要/草稿)会随会话列表裁剪,关闭的会话不再滞留内存。

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
`tests/isolation-e2e.mjs` 覆盖会话归属(干活中的会话不被抢 / 心跳新鲜不可抢 / 真失活仍可回收 / 跨工作区不认领)。
`tests/visibility-unit.mjs` 覆盖面板可见性判定(跨窗口归属 / 工作区范围 / 归档 / 归属认领 / 状态裁剪)。
以上都使用临时数据根,不动在用的 `~/.multisession`。

内存测量:

```bash
npm run bench:tick               # tick 读盘解析量(真实数据根,只读)
npm run bench:memory             # 「已关闭会话占内存」对照:旧/新实现在独立进程各跑一遍
```
