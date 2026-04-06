# MultiSession + WeChat 使用指南

## 简介

MultiSession 是一个 Cursor IDE 插件，提供：
- **多会话管理面板**：在 Cursor 侧边栏管理多个 AI 对话会话
- **微信桥接**：将 AI 对话扩展到微信，随时随地与 AI 交互
- **Cursor Hooks 集成**：AI 调用工具时自动检测未读消息，提醒优先处理

---

## 快速开始

### 1. 安装插件

```bash
# 方式一：命令面板
Cmd+Shift+P → "Install from VSIX" → 选择 cursor-multisession-x.x.x.vsix

# 方式二：终端
cursor --install-extension cursor-multisession-x.x.x.vsix
```

安装后执行 `Cmd+Shift+P → Reload Window`。

### 2. 初始化 MCP + 通信规则 + Hooks

点击侧边栏 **MultiSession 面板** → **「安装 MCP + 通信规则」** 按钮。

这会自动完成：
- `.cursor/mcp.json` — 注册 MCP Server
- `.cursor/rules/multisession.mdc` — AI 通信规则（自动注入到 Cursor）
- `.cursor/hooks.json` + `.cursor/hooks/multisession-check-queue.sh` — Cursor Hooks（队列优先级检测）

> 该操作是幂等的，重复执行不会产生副作用。

### 3. 启动 AI 对话

1. 点击面板顶部 **「规则」** 按钮 → 复制通信规则到剪贴板
2. 在 Cursor Composer 中粘贴并发送
3. AI 会自动调用 `check_messages` 连接到 MultiSession
4. 侧边栏出现会话 Tab，开始交互

---

## 面板功能

### 会话管理

| 操作 | 方式 |
|------|------|
| 切换会话 | 点击 Tab |
| 重命名 | 双击 Tab |
| 关闭会话 | 点击 Tab 上的 × |
| 恢复会话 | Hover Tab → 点击 ↻ → 复制恢复规则 → 粘贴到新 Composer |

### 消息交互

| 功能 | 说明 |
|------|------|
| 发送消息 | 输入框输入 → Enter 发送 |
| 粘贴图片 | Ctrl/Cmd+V 粘贴剪贴板图片 |
| 附加文件 | 点击 📎 或 Explorer 右键 "发送文件到输入框" |
| AI 回复 | 顶部 toast 展示 AI 摘要 |
| AI 提问 | 面板底部展示选项卡，直接选择回答 |
| 待处理消息 | 查看/编辑/删除/重发队列中的消息 |

### Skill 和历史引用

| 触发 | 说明 |
|------|------|
| 输入 `/` | 弹出 Skill 列表，选中后作为上下文附加 |
| 输入 `@` | 弹出历史对话 + 打开文件列表，选中后附加引用 |

---

## 微信桥接

### 连接微信

1. 点击侧边栏 **WeChat 面板** → **「扫码登录」**
2. 用微信扫描二维码
3. 确认后点击 **「连接」**

### 微信端命令

在微信中直接发送以下命令（不经过 AI 模型，即时响应）：

| 命令 | 说明 | 示例 |
|------|------|------|
| `/help` | 显示所有可用命令 | `/help` |
| `/status` | 查看引擎和会话状态 | `/status` |
| `/ping` | 测量 API 往返延迟 | `/ping` |
| `/sessions` | 列出所有会话及状态 | `/sessions` |
| `/session` | 查看当前会话详情 | `/session` |
| `/use <名称>` | 切换活跃会话 | `/use viplevel` |
| `/rename <名称>` | 重命名当前会话 | `/rename 我的项目` |

### 消息流向

```
微信消息 → WeChat Engine → Router → 指定 session 的 queue.json → AI 消费

AI 回复 → summary.json → Reply Watcher → 微信（需活跃 + 绑定）

AI 提问 → inquiry.json → Inquiry Watcher → 微信（需活跃 + 绑定）
                                          ↓
                                    微信回复选项 → 自动应答
```

### 活跃检测

微信端只有在 **30 分钟内发过消息** 的情况下才会收到 AI 回复和提问推送。超时后消息仅在 Cursor 面板中可见。

### Session 绑定

使用 `/use <名称>` 绑定会话后，**只有绑定的 session** 的回复和提问会推送到微信。其他 session 的消息不会干扰。

---

## MCP 工具

AI 可用的 MCP 工具：

| 工具 | 说明 |
|------|------|
| `check_messages` | 长轮询等待用户消息（核心工具，每轮结束必须调用） |
| `ask_question` | 向用户提问（选择题/多选题），支持自定义文本补充 |
| `wechat_send` | 通过微信发送截图/图片/文件/文本（需微信已连接） |
| `export_chat` | 导出当前会话的完整对话记录 |

---

## Cursor Hooks

安装后自动在 AI 每次调用 MCP 工具前检测 session 队列：
- 如果有待处理的用户消息且 AI 正在执行其他操作，会通过 `agentMessage` 提醒 AI 优先处理队列
- 不会阻断 AI 操作，仅注入提醒

---

## 卸载

```
Cmd+Shift+P → "MultiSession: 卸载 MCP 配置"
```

会自动清理所有工作区的：
- `.cursor/mcp.json` 中的 MultiSession 配置
- `.cursor/rules/multisession.mdc`
- `.cursor/hooks.json` 中的 MultiSession hook 条目
- `.cursor/hooks/multisession-check-queue.sh`

---

## 技术架构

```
cursor-multisession/
├── src/
│   ├── extension.ts              # 插件入口
│   ├── hooks/check-queue.sh      # Cursor Hook 脚本
│   ├── webview/                  # MultiSession React 面板
│   └── wechat/                   # 微信引擎
│       ├── engine.ts             # 状态机 + 事件
│       ├── bridge/               # MultiSession 桥接
│       │   ├── reply-watcher.ts  # AI 回复 → 微信
│       │   ├── inquiry-watcher.ts # AI 提问 → 微信
│       │   ├── session-watcher-manager.ts # 会话管理
│       │   └── message-router.ts # 消息路由
│       └── slash/index.ts        # 微信端命令
├── mcp-server/index.ts           # MCP Server
└── dist/                         # 编译产物
```

### 数据目录

```
~/.multisession/
├── sessions.json                 # 所有会话元数据
├── sessions/<id>/
│   ├── queue.json                # 待处理消息队列
│   ├── chat-log.json             # 对话历史
│   ├── summary.json              # AI 最新回复摘要
│   ├── inquiry.json              # AI 提问状态
│   └── images/                   # 图片附件
├── active-window.json            # 活跃窗口标记
└── wechat-actions/               # AI → 微信操作队列
```
