# MultiSession + WeChat

Cursor IDE 插件 — **多会话管理面板** + **微信桥接**，让你在 Cursor 侧边栏管理多个 AI 对话，并把对话扩展到微信端，实现随时随地与 AI 协同。

## 特性

- **多会话面板**：侧边栏 Tab 管理多个 Composer 会话，支持切换、重命名、关闭、恢复
- **MCP 集成**：通过 `check_messages` / `ask_question` 长轮询贯通用户与 AI 的双向通道
- **微信桥接**：扫码登录微信，AI 回复/提问直推微信；微信消息回流到指定 session
- **Cursor Hooks**：AI 调用工具前自动检测 session 队列，注入未读消息提醒
- **富文本输入**：`contentEditable` 编辑器，支持粘贴图片、引用文件、`/` Skill、`@` 历史/文件
- **语音 I/O**（macOS）：原生录音 + `SFSpeechRecognizer` 离线中文识别 + TTS 播报
- **微信端 slash 命令**：`/use` `/sessions` `/status` `/ping` 等，无需经过 AI 模型即时响应

## 安装

### 用户安装

1. 到 [Releases](https://github.com/liaosiqian/cursor-multisession/releases) 下载最新 `cursor-multisession-x.x.x.vsix`
2. Cursor 中 `Cmd+Shift+P` → `Extensions: Install from VSIX...` 选择该文件
3. `Cmd+Shift+P` → `Reload Window`
4. 点击侧边栏 **MultiSession** 面板 → **「安装 MCP + 通信规则」**

详见 [FEATURES.md](./FEATURES.md) 的快速开始。

### 从源码构建

```bash
git clone https://github.com/liaosiqian/cursor-multisession.git
cd cursor-multisession
npm install
npm run package         # 生成 .vsix
# 或者：
npm run deploy          # 编译 + 部署到 ~/.cursor/extensions/
```

## 技术栈

| 模块 | 技术 |
|------|------|
| Extension Host | TypeScript + esbuild (CJS bundle) |
| Webview UI | React 18 + esbuild (IIFE bundle) |
| MCP Server | `@modelcontextprotocol/sdk`（独立 Node ESM 子进程） |
| 微信引擎 | 独立 Node CJS bundle，运行时 `require()` 懒加载 |
| 截图/录音 | Swift + ScreenCaptureKit / AVFoundation / SFSpeechRecognizer |

## 目录结构

```
src/
├── extension.ts              # 插件入口
├── hooks/check-queue.sh      # Cursor Hook 脚本
├── webview/                  # MultiSession React 面板
├── wechat-webview/           # WeChat React 面板
└── wechat/                   # 微信引擎（engine、bridge、slash、auth、api）
mcp-server/index.ts           # MCP Server (stdio)
scripts/                      # Swift 工具源 + Node 部署脚本
```

数据目录：`~/.multisession/`（会话）、`~/.clawbot/`（微信凭证）。

## 开发

```bash
npm run dev          # watch 模式：源码变更 → 自动 build + deploy
npm run build        # 编译全部产物
npm run package      # 打包成 .vsix
npm run release      # bump patch + build + deploy
```

详细开发流程见 `.cursor/skills/multisession-dev/SKILL.md`。

## License

MIT
