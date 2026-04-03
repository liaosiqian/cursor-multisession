# cursor-multisession 功能清单

## 项目概述

将 MultiSession（Cursor AI 多会话管理面板）与微信 ClawBot 桥接合并为一个 VS Code/Cursor 插件。

---

## 一、MultiSession 面板（已完成 & 已部署）

| # | 功能 | 状态 | 说明 |
|---|------|------|------|
| 1 | 多 session 管理 | ✅ 已部署 | 按 workspace 过滤 session，显示 session 列表、切换 tab |
| 2 | 消息输入与发送 | ✅ 已部署 | 文本输入框 + 图片粘贴，消息写入 `queue.json` 供 MCP 消费 |
| 3 | AI 回复展示 | ✅ 已部署 | 实时轮询 `summary.json`，toast 展示 AI 回复摘要 |
| 4 | Inquiry 应答 | ✅ 已部署 | AI 通过 `ask_question` 发起的多选/单选题，面板内直接回答 |
| 5 | 待发消息管理 | ✅ 已部署 | 查看/编辑/删除/重发 `queue.json` 中的待处理消息 |
| 6 | MCP 配置一键安装 | ✅ 已部署 | 自动写入 `.cursor/mcp.json` + `.cursor/rules/multisession.mdc` |
| 7 | 通信规则复制 | ✅ 已部署 | 一键复制 MCP 通信规则到剪贴板 |
| 8 | 右键发送文件 | ✅ 已部署 | Explorer 右键菜单 -> 发送文件路径到输入框 |
| 9 | 多窗口 token 追踪 | ✅ 已部署 | `active-window.json` 记录活跃窗口，避免跨窗口冲突 |
| 10 | fs.watch 即时刷新 | ✅ 已部署 | 监听 `sessions.json` 变更，即时同步面板状态 |
| 11 | Reconnect | ✅ 已部署 | 调用 `composer.resumeCurrentChat` 尝试重连 |

## 二、面板端 Slash Commands（源码已实现，需编译部署验证）

| # | 命令 | 状态 | 说明 |
|---|------|------|------|
| 1 | `/status` | ⚠️ 待验证 | 显示当前 session 状态、待处理消息数、AI 最后回复时间 |
| 2 | `/ping` | ⚠️ 待验证 | 快速连通性检查 |
| 3 | `/help` | ⚠️ 待验证 | 列出所有可用命令 |
| 4 | `/session` | ⚠️ 待验证 | 列出所有活跃 session |
| 5 | `/rename <name>` | ⚠️ 待验证 | 重命名当前 session |

## 三、Session 重命名（源码已实现，需编译部署验证）

| # | 功能 | 状态 | 说明 |
|---|------|------|------|
| 1 | 面板内双击重命名 | ⚠️ 待验证 | 双击 session tab 弹出编辑框 |
| 2 | `/rename` 命令 | ⚠️ 待验证 | 通过 slash command 重命名 |
| 3 | `renameSession` 消息 | ⚠️ 待验证 | webview -> extension 消息处理 |

## 四、WeChat ClawBot 集成（源码已实现，尚未成功编译部署）

### 4.1 登录与连接

| # | 功能 | 状态 | 说明 |
|---|------|------|------|
| 1 | 扫码登录 | ❌ 未部署 | 调用 iLink API 获取 QR code，面板内展示 |
| 2 | 凭证持久化 | ❌ 未部署 | 保存到 `~/.clawbot/credentials.json` |
| 3 | 自动重连 | ❌ 未部署 | 启动时检测凭证，自动连接 |
| 4 | 状态栏指示器 | ❌ 未部署 | 底部状态栏显示 WeChat 连接状态 |

### 4.2 消息桥接

| # | 功能 | 状态 | 说明 |
|---|------|------|------|
| 1 | 微信消息 → MultiSession | ❌ 未部署 | 消息轮询 + 路由到指定 session 的 `queue.json` |
| 2 | AI 回复 → 微信 | ❌ 未部署 | SessionWatcherManager 监听 `summary.json`，自动发送到微信 |
| 3 | Inquiry 转发 | ❌ 未部署 | AI 的 `ask_question` 自动推送到微信，微信回复自动应答 |
| 4 | 多 session 路由 | ❌ 未部署 | `/use <name>` 切换微信消息目标 session |
| 5 | 消息前缀 | ❌ 未部署 | 不同 session 的回复自动带 `[session_name]` 前缀 |

### 4.3 微信端 Slash Commands

| # | 命令 | 状态 | 说明 |
|---|------|------|------|
| 1 | `/status` | ❌ 未部署 | 查看连接状态、AI 回复状态 |
| 2 | `/sessions` | ❌ 未部署 | 列出所有 MultiSession session |
| 3 | `/use <name>` | ❌ 未部署 | 切换当前活跃 session |
| 4 | `/rename <name>` | ❌ 未部署 | 重命名 session |
| 5 | `/ping` | ❌ 未部署 | 快速连通性检查 |

### 4.4 媒体能力

| # | 功能 | 状态 | 说明 |
|---|------|------|------|
| 1 | 图片发送 | ❌ 未部署 | AES-128-ECB 加密上传到 CDN，通过 iLink API 发送 |
| 2 | 图片接收 | ❌ 未部署 | 从微信消息中提取图片，保存到 session images 目录 |
| 3 | 截图发送 | ❌ 未部署 | 一键截屏并发送到微信 |
| 4 | 语音接收 | ❌ 未部署 | 从微信消息中提取语音内容 |

### 4.5 WeChat 面板 UI

| # | 功能 | 状态 | 说明 |
|---|------|------|------|
| 1 | 状态展示 | ❌ 未部署 | 离线/连接中/已连接/错误 状态 badge |
| 2 | QR 码展示 | ❌ 未部署 | 扫码登录二维码 |
| 3 | 消息日志 | ❌ 未部署 | 最近 50 条消息记录 |
| 4 | AI 回复状态 | ❌ 未部署 | "AI is thinking..." / "已回复: ..." |
| 5 | 连接/断开按钮 | ❌ 未部署 | 操作按钮 |

---

## 五、已知问题

| # | 问题 | 原因 | 状态 |
|---|------|------|------|
| 1 | 包含 WeChat engine 的编译产物导致面板白屏 | WeChat engine 引入 `node:crypto`/`node:http` 等模块，可能在模块加载阶段触发副作用崩溃 | 🔴 未解决 |
| 2 | deploy 脚本未正确覆盖安装目录文件 | `npm run build` 与手动编译冲突，文件可能被 Cursor 进程锁定 | 🔴 未解决 |
| 3 | `cursor --install-extension` CLI 报 helper app 错误 | macOS 上 Cursor CLI helper app 路径问题 | ⚠️ 需用 "Install from VSIX" 代替 |
| 4 | QR 码图片无法在 webview 中显示 | webview 默认阻止外部 HTTPS 图片（需 CSP 配置） | 🔴 未解决 |

---

## 六、技术栈

- **Runtime**: Node.js 20+, VS Code/Cursor Extension Host
- **Language**: TypeScript 5.x
- **Bundler**: esbuild
- **Frontend**: React 18 (MultiSession 面板) + 原生 HTML (WeChat 面板)
- **通信**: 文件系统 (`~/.multisession/sessions/<id>/`)
- **MCP**: Model Context Protocol SDK (`@modelcontextprotocol/sdk`)
- **微信 API**: iLink ClawBot API (HTTPS long-polling)

## 七、文件结构

```
cursor-multisession/
├── src/
│   ├── extension.ts          # 插件入口 (activate/deactivate)
│   ├── webview/
│   │   ├── index.tsx          # MultiSession React 面板
│   │   └── webview.css
│   └── wechat/
│       ├── engine.ts          # ClawBot 引擎 (状态机 + 事件)
│       ├── api/
│       │   ├── client.ts      # iLink HTTP 客户端
│       │   └── types.ts
│       ├── auth/
│       │   ├── login.ts       # QR 码登录流程
│       │   └── store.ts       # 凭证持久化
│       ├── bridge/
│       │   ├── multisession.ts        # 读写 MultiSession 文件
│       │   ├── message-router.ts      # 微信用户 -> session 路由
│       │   ├── session-watcher-manager.ts # 监听所有 session
│       │   ├── reply-watcher.ts       # 监听 AI 回复
│       │   ├── inquiry-watcher.ts     # 监听 AI 提问
│       │   └── message-extract.ts     # 消息内容提取
│       ├── config/index.ts    # 配置加载
│       ├── media/index.ts     # 图片/文件上传下载
│       ├── poller/index.ts    # 消息长轮询
│       ├── server/index.ts    # HTTP API 服务
│       ├── slash/index.ts     # 微信端 slash 命令
│       ├── util/logger.ts     # 日志工具
│       └── webhook/index.ts   # Webhook 转发
├── mcp-server/index.ts        # MCP Server (check_messages 等)
├── scripts/
│   ├── deploy.js              # 一键编译部署
│   └── watch.js               # 开发模式监听
├── dist/                      # 编译产物
├── media/icon.svg
├── package.json
└── tsconfig.json
```

## 八、下一步计划

1. **修复 deploy 脚本** -- 确保编译产物正确覆盖安装目录
2. **验证纯 MultiSession 版本** -- 确认 slash commands + rename 正常工作
3. **隔离引入 WeChat** -- 使用 dynamic import 避免模块加载副作用
4. **解决 QR 码图片** -- 参考 VS Code 官方示例正确配置 CSP + nonce
