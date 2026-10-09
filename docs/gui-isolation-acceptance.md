# GUI 隔离验收（真实扩展宿主 + 真面板）

unit/e2e 只覆盖判定函数。归属泄漏最终要在「真实的扩展宿主 + 真的 Webview 面板 + 两个活窗口
共享同一数据根」下复现一次，才算验收。本文件记录可复现的步骤与已通过的结果。

## 前提

- **绝不** 运行 `npm run deploy` / `npm run dev`：它们会清空 `~/.cursor/extensions/local.cursor-multisession*`，
  在用的窗口会立刻失去插件。验收只用 `npm run build` 产出的 `dist/`，拷进临时目录。
- 全部走 `MULTISESSION_DATA_ROOT` 临时数据根 + `--user-data-dir` / `--extensions-dir` 临时目录，
  不碰 `~/.multisession` 与在用的 workspace。
- 锁屏状态下 Chromium 会强节流后台 Webview，面板持久化状态（`memento/webviewView.multiSession.panel`）
  会延迟几十秒才落盘，读数前要等，别当成不更新。

## 步骤

1. 建隔离环境：`$ISO/{ext-new,ud-a2,ud-b2,data-new,ws-shared,ws-other}`；
   `ext-new/local.cursor-multisession/` 直接拷 `dist/`，并写入 `ext-new/extensions.json`。
2. 装一个只负责开面板的驱动扩展（不属于被测代码）：`ext-new/local.ms-test-driver/`，
   `activationEvents: onStartupFinished`，`activate()` 里在 `MS_DRIVER_OPEN` 存在时执行
   `workbench.view.extension.multiSession` 与 `multiSession.panel.focus`。
   只有 A 窗口带这个环境变量，B 窗口就是「另一个活窗口但没开面板」的对照。
3. 用 `start_new_session=True` 独立会话启动两个窗口（普通 `nohup &` 会被调用方清理掉）：

   ```bash
   MULTISESSION_DATA_ROOT=$ISO/data-new Cursor --user-data-dir $ISO/ud-a2 --extensions-dir $ISO/ext-new $ISO/ws-shared $ISO/ws-other   # A，带 MS_DRIVER_OPEN=1
   MULTISESSION_DATA_ROOT=$ISO/data-new Cursor --user-data-dir $ISO/ud-b2 --extensions-dir $ISO/ext-new $ISO/ws-shared $ISO/ws-other   # B
   ```

   `--user-data-dir` 必须是新的空目录：复用一个被杀过的实例目录会让 Cursor 恢复出多个窗口，
   同一批文件夹下多个面板同时抢认领，观测就没意义了。
4. 等两个窗口的扩展宿主写进 `data-new/active-window.json`（拿 A/B 的 `pid`、`windowPid`、`token`），
   再写 `data-new/sessions.json` 夹具（每个会话建好 `sessions/<id>/{queue.json,chat-log.json}`）。
5. 夹具写入后**不要**用无锁的读改写去动 `active-window.json`：那种写法会盖掉扩展宿主刚续的心跳，
   制造出「另一个活窗口的条目停更、甚至被当成陈旧项清掉」的假象，导致对方会话被误认领。
   现在扩展侧走的是同一把跨进程锁，外部写者用 `dist/locked-json.mjs` 的 `updateJsonLocked()`
   就安全；用 `scripts/heartbeat-stress.mjs` 可以直接压测这一点。

## 夹具与预期

| 会话 | 归属 | 预期 |
|------|------|------|
| `s-owned-by-B` | B 的扩展宿主 pid + B 的 windowPid + B 的 token | 保持不动（另一个活窗口的会话） |
| `s-other-live` | 未注册在本数据根的活 pid（39606） | 本窗口认领（该数据根看不到这个持有者） |
| `s-unowned` | 无 | 本窗口认领 |
| `s-dead-window` | 999999（已死） | 本窗口认领 |
| `s-mine-other-folder` | 无，workdir 指向本窗口第二个文件夹 | 本窗口认领 |
| `s-outside` | 别的活窗口，且目录不在本窗口 | 保持不动，不显示 |

## 已通过的结果（2026-10-09）

窗口 A（主进程 36768，扩展宿主 37785，开了面板）与窗口 B（36769 / 37784，未开面板）共享 `data-new`：

- 写入夹具后连续 20s、每 250ms 采样 80 次：`s-owned-by-B` 始终 `windowOwnerPid=37784`，
  `s-unowned/s-dead-window/s-mine-other-folder` 被认领为 37785，`s-outside` 保持 888888，零违例。
- 面板持久化状态（`ud-a2/.../state.vscdb` 里 `memento/webviewView.multiSession.panel`，
  读 WAL 需先拷出库文件再 `wal_checkpoint`）显示：
  `[s-dead-window, s-mine-other-folder, s-other-live, s-unowned]` —— 另一个活窗口的
  `s-owned-by-B` 与本窗口之外的 `s-outside` 都不在列表里。
- 探针：往 `s-unowned/chat-log.json` 追加 3 条后，面板状态里的日志条数由 2 变 5，
  证明面板在真实接收推送（上一行读数延迟是锁屏节流，不是面板卡死）。

## 残留风险

- ~~`active-window.json` 是多进程读改写、没有跨进程锁~~ —— **已修**（`src/shared/locked-json.ts`）：
  窗口心跳与认领改走 `updateJsonLocked()`，用 `O_EXCL` 建锁 + 超时等待 + 陈旧锁回收，写回走
  「临时文件 + rename」所以读者不会读到半截 JSON，释放前校验锁内 token 不会误删别人的锁。
  `tests/locked-json-unit.mjs`（30 项断言，已纳入 `test:e2e`）覆盖：四个进程各维护自己的条目
  各 20 轮后一条不丢、锁内区间零重叠、陈旧锁被回收、活锁是等待而非硬抢、超时不写坏文件；
  对照组用无锁实现复现出丢更新，证明这个场景确实测得住。
- 仍存在的边界：锁只约束同一数据根上的本机进程；`staleMs` 默认 3s，若某进程在锁内被 `SIGSTOP`
  或系统休眠超过该阈值，别的进程会回收它的锁并继续写（它恢复后那一次写入可能被覆盖）。锁内
  只做小文件读改写，实际耗时为毫秒级。

## 让真实 Cursor 拉起新构建的 MCP 服务（2026-10-09 实测）

工作区里写好 `.cursor/mcp.json` 之后 Cursor 并不会直接用它。Cursor 3.7 对工作区级 MCP 有
「配置哈希审批」闸门：`isServerEnabled()` 要求审批列表里存在
`<identifier>:<configHash>`，否则静默禁用 —— 日志里连 `createClient` 都不会出现。

- 存储位置：`<user-data-dir>/User/globalStorage/state.vscdb` 的 `ItemTable`，键
  `cursor/approvedProjectMcpServers`（JSON 数组）。
- identifier：`project-<文件夹序号>-<文件夹名>-<服务名>`，多根工作区按文件夹序号区分。
- 哈希：只取 `command,args,env,envFile,url,headers`（`timeoutMs` 不参与），按这个顺序
  `JSON.stringify`，再走 VS Code `base/common/hash.ts` 的 doHash（seed 0），
  最后 `toString(16)` 取前 16 字符（负数保留 `-`）。用 `scripts/mcp-approval-key.mjs` 计算，
  `--selftest` 会拿 viplevel 的真实配置对照库里存的 `-1f6487de`。
- 隔离实例实测：写入 `project-0-ws-shared-MultiSession:4afc9680` 后重启两个窗口，
  `workbench.mcp.files.log` 出现 `createClient: identifier="project-0-ws-shared-MultiSession"`
  加 `success=true`；两个窗口各自拉起一个 `node <ext-new>/dist/mcp-server.mjs`
  （pid 91940 / 91962，父进程是各自窗口的 mcp-process）；数据根出现 `multisession.log`：
  `[start] MCP server starting` 与 `[start] MCP server connected`。

### 上线含义

- 换发布目录（`local.cursor-multisession-0.8.0` 到 `0.9.0`）会改变 `args`，哈希随之变化、
  旧审批失效，Cursor 会静默不启动 MultiSession MCP —— 「装了新版本但接管不工作」先查这一步。
- 建议：发布前用 `scripts/mcp-approval-key.mjs` 算出新审批键，装好后再到 Cursor 的 MCP 设置里
  确认该服务已启用。

### 尚未验证的一环：真实 Agent 消费

会话注册、派发消费与回复都必须由 agent 调用 `check_messages` 才会发生，因此隔离窗口里必须能跑起
一个 Cursor Agent。当前隔离 profile **没有登录态**：主 profile 的
`<ud>/User/globalStorage/state.vscdb` 里有 `cursorAuth/accessToken` 与
`cursorAuth/refreshToken`，隔离目录里只有 `cursorAuth/stripeMembershipType`，
窗口打开就是 “Cursor Settings” 并要求登录（页面提示 `Cursor's AI features require you to be logged in`）。

可选路径（都需要用户决定）：把主 profile 的两行 `cursorAuth/*` 拷进隔离目录后重启窗口；在隔离
窗口手动登录；或使用已登录的 `cursor-agent` CLI（需要 `agent login` 或 `CURSOR_API_KEY`）。
登录态就位后即可用下面的 CDP 工具把这一环跑完，不受锁屏影响。

## 心跳竞态：真实窗口下的压测（2026-10-09）

`scripts/heartbeat-stress.mjs` 在真实运行的窗口旁边持续读改写 `active-window.json`，每 100ms 采样一次，
看两个活窗口的心跳条目会不会丢失、时间戳会不会停更（扩展宿主每 3s 续一次，超过 6s 就算被打断）：

```bash
# 两个隔离窗口共享 MULTISESSION_DATA_ROOT=<临时数据根>
MULTISESSION_DATA_ROOT=$ISO/data-heart node scripts/heartbeat-stress.mjs --mode locked --seconds 20
MULTISESSION_DATA_ROOT=$ISO/data-heart node scripts/heartbeat-stress.mjs --mode naive  --seconds 90
MULTISESSION_DATA_ROOT=$ISO/data-heart node scripts/heartbeat-stress.mjs --mode stale  --seconds 60
```

| 写者 | 写回次数 | 条目缺失的采样 | 心跳时间戳年龄（中位 / p99 / 最大） |
|------|---------|---------------|--------------------------------|
| `locked`（当前实现） | 9,698 次 / 12s | 0 / 119 | 1.5s / 3.0s / 3.05s |
| `locked`（长跑） | 16,314 次 / 20s | 0 / 198 | 1.5s / 3.0s / 3.01s |
| `naive`（0.8.0 老写法，读→改→写） | 143,415 次 / 180s | 0 / 1795 | 1.8s / 8.8s / 11.97s |
| `stale`（无锁 + 旧快照反复写回） | 50,909 次 / 60s | 0 / 598 | 32.2s / 61.6s / 62.09s |

结论：加锁后即使旁边有每秒近千次的写回，两个窗口的心跳也始终跟着 3s 周期走（最大 3.05s）；
换成老的无锁写法，同样压力下心跳会被反复盖掉，最坏情况（旧快照写回）整个测试期间都停在原地 ——
两个窗口互相看对方都是「15s 没心跳的陈旧条目」，正是会话在窗口之间跳动的来源。

两个写者都保留条目本身（各自都做了 read-modify-write），所以这一轮没有观测到「条目整条消失」；
条目消失发生在陈旧条目被另一个窗口按 15s 阈值清掉、而对方的写回又一直没落地的时刻，
`tests/locked-json-unit.mjs` 的对照组用确定性交错复现了这条丢失路径。

**上线含义**：0.8.0 的窗口仍在用无锁写回，会和已升级窗口互相盖心跳。接管时要让所有窗口一起
升级并重启到同一版本，不要长期混跑新旧两代。

## 无需解锁屏幕的驱动方式：CDP（2026-10-09 实测）

锁屏时 CUA 不可用，但给隔离窗口加上调试端口后可以用 CDP 直接读界面状态、注入输入、截图，
完全不依赖物理屏幕与键鼠：

```bash
Cursor --user-data-dir $ISO/ud-c --extensions-dir $ISO/ext-new \
  --remote-debugging-port=9333 --remote-allow-origins=* $ISO/ws-agent
```

`scripts/cdp-eval.mjs` 是配套工具（自带最小 WebSocket 客户端，不新增依赖）：

| 命令 | 用途 |
|------|------|
| `list` | 列出 page / iframe / service_worker 目标 |
| `eval '<js>' [--frame]` | 执行 JS；`--frame` 把 `document/window` 换成面板内部文档 |
| `ax [关键词]` | 读无障碍树（没有图像输入时用它「看」界面） |
| `insert '<text>'` / `enter` | 往当前聚焦元素注入文本 / 回车 |
| `shot <png>` | 截图留证 |

要点与坑：

- 面板是 VS Code Webview：CDP 里看到的是 host 页，真实 DOM 在 `#active-frame` 内联 iframe 里，
  `--frame` 负责切换。`iframe:0` 是 MultiSession 面板，`iframe:1` 是微信面板。
- CDP 帧必须等 WebSocket 握手完成后再发，否则会排到 HTTP 握手请求前面，被对端重置连接。
- 重启隔离窗口前确认旧实例已退出：它占着调试端口时新实例的 devtools server 会启动失败
  （日志 `bind() failed: Address already in use`），此时 `list` 只会显示旧窗口的目标。

## 面板派发路径验收（2026-10-09，隔离窗口 C）

窗口 C（`ud-c` + `ext-new` + 数据根 `data-agent`）里用 CDP 驱动真实面板，两种状态各跑一次，
只看队列文件落点：

| 面板状态 | 操作 | 旧构建 | 新构建 |
|----------|------|--------|--------|
| 没有选中会话 | 输入「无会话发送验证-N」并点发送 | 写进 `sessions/default/queue.json` | 不写任何队列，草稿留在输入框 |
| 已绑定会话夹具 `s-panel-a` | 输入「会话派发验证-N」并点发送 | 落到该会话 `queue.json` | 同左 |

- 根因：`src/webview/index.tsx` 用 `activeSessionId || 'default'` 兜底，绕过了扩展侧
  「没有 sessionId 就拒绝」的守卫 —— 归到 `default` 的消息正是历史上会被迁移给无关对话的那批。
  现在发送路径不再兜底，扩展侧同时把 `sid === 'default'` 也一并拒绝（纵深防御）。
- 未被消费的消息会由扩展的送达检查标成面板上的「待处理」，符合预期。
- 本轮验证不需要解锁屏幕，也不需要 Cursor 登录态。
