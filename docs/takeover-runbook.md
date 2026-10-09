# 接管 runbook（把新版装到在用的 Cursor 上）

这份文档只讲「怎么把已经在隔离环境验收过的新版装进正在用的 Cursor」，以及出问题时怎么退回去。
隔离验收本身见 `gui-isolation-acceptance.md`。

## 先说结论：不要用 `npm run deploy`

`scripts/deploy.js` 干的第一件事是把 `~/.cursor/extensions/local.cursor-multisession-*` **整个删掉**，
而生产环境里 `extensions.json` 注册的恰恰是那个带版本号的目录：

```json
{"identifier":{"id":"local.cursor-multisession"},"version":"0.8.0",
 "location":{"path":"/Users/lsq/.cursor/extensions/local.cursor-multisession-0.8.0"},
 "relativeLocation":"local.cursor-multisession-0.8.0",
 "metadata":{"pinned":true,"source":"vsix"}}
```

部署脚本写的是不带版本号的那个目录（`local.cursor-multisession`），注册表里没有它。
真按 deploy 走一遍，重启后 Cursor 会去找一个已经被删掉的路径。

## 正确路径：打包 VSIX 再用 Cursor 自带 CLI 安装

```bash
cd /Users/lsq/AIProjects/cursor-multisession

# 1) 改版本号（0.8.0 -> 0.9.0），否则装上去和旧版重名
#    package.json 的 version

# 2) 打包（会先 npm run build）
npm run package            # 产物：cursor-multisession-<version>.vsix

# 3) 安装（--install-extension 会自己更新 extensions.json）
/Applications/Cursor.app/Contents/Resources/app/bin/cursor \
  --install-extension ./cursor-multisession-0.9.0.vsix
```

打包这一步依赖 `package.json` 里的 `repository` 字段：缺它时 vsce 会因为 README 里的相对链接
（`./FEATURES.md`）直接报错，`npm run package` 根本出不了包。该字段已在本次改动里补上。

2026-10-09 在隔离目录里验证过这条路：

```bash
npx @vscode/vsce package --no-dependencies --out /tmp/ms-vsix/cursor-multisession-0.8.0.vsix
cursor --extensions-dir $ISO/ext-vsix --user-data-dir $ISO/ud-vsix \
  --install-extension /tmp/ms-vsix/cursor-multisession-0.8.0.vsix
```

产出的布局与生产一模一样（`local.cursor-multisession-0.8.0` + `extensions.json` 里
`pinned: true, source: vsix`），随后用这个扩展目录起了一个窗口，25s 内正常写心跳。

## 安装后必须做的三件事

1. **重新授权工作区 MCP**：发布目录变了，审批键（`<identifier>:<configHash>`）跟着变，
   Cursor 会静默不启动 MultiSession MCP（见 `gui-isolation-acceptance.md` 的审批闸门一节）。
2. **所有窗口一起重启**：0.8.0 的窗口仍在用无锁写回，会和已升级窗口互相盖心跳；
   实测无锁写者能让对方的心跳停更数十秒（见压测一节）。不要长期混跑两代。
3. **确认 MCP 进程指向新路径**：`ps -eo pid,command | grep mcp-server.mjs`，
   路径应指向新的扩展目录。

## 打包产物本身也验过（2026-10-09）

三个协议套件都支持用 `MULTISESSION_MCP_SERVER` 指向别的产物，所以能直接拿 VSIX 里的服务端跑同一套用例：

```bash
unzip -o -q cursor-multisession-0.9.0.vsix -d /tmp/ms-vsix
export MULTISESSION_MCP_SERVER=/tmp/ms-vsix/extension/dist/mcp-server.mjs
node tests/takeover-e2e.mjs && node tests/dispatch-cli-e2e.mjs && node tests/isolation-e2e.mjs
```

实测：VSIX 里的 `dist/mcp-server.mjs` 与仓库构建产物 sha256 一致（`ba5e1048…`），
三套用例 30/11/26 全绿 —— 打包出来的服务端与测试过的构建产物是同一份东西。

审批闸门这条也在隔离环境验了：扩展目录换到 `ext-vsix/local.cursor-multisession-0.8.0`、工作区换成
`ws-vsix` 后，用 `scripts/mcp-approval-key.mjs --config <ws>/.cursor/mcp.json --folder-index 0`
算出 `project-0-ws-vsix-MultiSession:41c89bc3`，写进用户数据里的 `cursor/approvedProjectMcpServers`
再重启，Cursor 立刻拉起了 `<ext-vsix>/dist/mcp-server.mjs` 并打出 `[start] MCP server connected`；
同一份配置在写入审批键之前是完全静默的。

## 回滚

```bash
# 卸载（或直接装回旧 VSIX，安装会覆盖同 id 的扩展）
/Applications/Cursor.app/Contents/Resources/app/bin/cursor \
  --uninstall-extension local.cursor-multisession
/Applications/Cursor.app/Contents/Resources/app/bin/cursor \
  --install-extension ./cursor-multisession-0.8.0.vsix   # 仓库根目录保留的旧产物
```

回滚后同样要重启窗口并确认 MCP 审批键（旧版本的哈希）。

## 接管后应该验一遍什么

```bash
# 会话列表能列出来
node scripts/ms-dispatch.mjs sessions

# 派发一条任务并看状态（--wait 会等到回复或超时）
node scripts/ms-dispatch.mjs dispatch --session <id> --task 'ping' --dispatch-id smoke-1 --wait
node scripts/ms-dispatch.mjs status --json
```

面板侧：目标窗口的面板应出现该会话的消息，回消息后发送方的 `status` 能看到回复；
把 MCP 进程杀掉再重启，`status` 里那条 in-flight 应被重新投递（`INFLIGHT_REPLAY_LIMIT` 上限 2 次）。
