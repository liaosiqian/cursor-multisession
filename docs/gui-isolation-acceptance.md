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
5. 夹具写入后**不要**再从外部改 `active-window.json`：外部读改写会覆盖扩展宿主的心跳更新，
   制造出「另一个活窗口的条目瞬间消失」的假象，导致对方会话被误认领。

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

- `active-window.json` 是多个扩展宿主进程的读改写，没有跨进程锁。一次丢失更新会让某个窗口的
  条目消失最多一个心跳周期（3s），期间别的窗口可能把它的会话认领过去（表现为会话换窗口显示，
  不会长期重复显示）。若要彻底消除，可让认领前额外直接校验 `windowOwnerPid` 是否仍存活。

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

### 尚未验证的一环

会话注册、派发消费与回复都必须由 agent 调用 `check_messages` 才会发生。这一步只能在真实
Cursor 窗口里让 agent 跑一轮（需要解锁屏幕、用 UI 驱动），脚本无法替代；屏幕锁定期间到此为止。
