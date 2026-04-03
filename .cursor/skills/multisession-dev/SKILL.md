---
name: multisession-dev
description: >-
  MultiSession 插件的构建、部署、调试、验证完整流程。当需要构建插件、部署到 Cursor、
  排查空白/渲染/激活问题、或配置开发环境时使用此 skill。
---

# MultiSession Extension - 开发流程指南

## Quick Reference

| Command | Purpose |
|---------|---------|
| `npm run build` | 编译 extension + webview + mcp-server |
| `npm run deploy` | build + 部署到 `~/.cursor/extensions/` |
| `npm run dev` | 监听 src/ 变更，自动 build + deploy |
| `F5` | 启动 Extension Development Host（支持热更新） |

## 开发工作流

### 方式 A：F5 Extension Development Host（推荐）

使用 VS Code/Cursor 内置的插件调试能力，一个独立窗口从源码加载插件。

```bash
# 1. 在 Cursor 中打开 cursor-multisession 项目
# 2. 按 F5（或 Run > Start Debugging）
#    - preLaunchTask 会先执行 npm run build
#    - 打开一个新窗口加载插件
# 3. 另开终端运行 npm run watch 自动编译
#    - Webview 变更自动刷新（不需要 Reload Window）
#    - Extension host 变更需在调试窗口按 Ctrl+R
```

### 方式 B：直接 Deploy

```bash
npm run deploy
# Cmd+Shift+P -> "Reload Window"
```

### 方式 C：Watch + Auto Deploy

```bash
npm run dev
# 每次自动部署后 Cmd+Shift+P -> "Reload Window"
```

## 验证部署

### 1. UI 版本号
面板底部右下角显示版本号（如 `v0.5.1`）。

### 2. Output Channel 日志
`View > Output` -> 选择 "MultiSession"：
```
[activate] MultiSession v0.5.1 (PROD)
[activate] extensionPath: ~/.cursor/extensions/local.cursor-multisession-0.5.1
[activate] done — v0.5.1 ready
[webview] panel resolved
```

### 3. 浏览器独立验证（关键！）
用 `test-webview.html` 在浏览器中独立验证 webview 渲染：
```bash
npx serve . -l 3456
# 打开 http://localhost:3456/test-webview.html
# 检查 Console 有无 JS 错误
```

### 4. 文件大小检查
```bash
ls -la ~/.cursor/extensions/local.cursor-multisession-*/dist/
# extension.js     ~29kb  (主入口，不含 WeChat)
# wechat-engine.js ~39kb  (WeChat 独立 bundle，懒加载)
# webview.js       ~152kb (React UI)
```

## 构建产物

```
src/extension.ts       ──esbuild──> dist/extension.js       (Node.js, CJS, ~29kb)
src/wechat/engine.ts   ──esbuild──> dist/wechat-engine.js   (Node.js, CJS, ~39kb, 独立 bundle)
src/webview/index.tsx   ──esbuild──> dist/webview.js         (Browser, IIFE, ~152kb)
src/webview/webview.css ──copy────> dist/webview.css
mcp-server/index.ts     ──esbuild──> dist/mcp-server.mjs    (Node.js, ESM, ~570kb)
```

**关键架构决策**：WeChat engine 编译为独立 bundle (`wechat-engine.js`)，extension.ts 通过运行时 `require()` 懒加载。
这避免了 `node:crypto`/`node:http` 等模块在插件激活阶段的副作用导致面板白屏。

## 已知坑点

### 1. React 组件变量声明顺序（TDZ 错误）
`useCallback` 在 `useState` 声明之前引用变量会导致 TDZ (Temporal Dead Zone) 错误。
esbuild minify 后错误表现为 `Cannot access 'xx' before initialization`，非常难定位。

**规则**：所有 `useState` / `useRef` 声明必须在引用它们的 `useCallback` 之前。

**排查方法**（实战经验 2026-04-03）：
1. 面板空白时，不要反复 Reload Window
2. 用 `test-webview.html` + `npx serve . -l 3456` 在浏览器中独立加载 webview
3. 浏览器 Console 会直接显示具体错误（如 `Cannot access 'renamingSessionId' before initialization`）
4. 如果 minify 后错误名被混淆（如 `cr`），用不加 `--minify` 的方式重新编译 webview 获取原始变量名
5. 修复变量声明顺序后重新编译验证

### 2. 浏览器独立验证（最重要的排查手段）
项目根目录 `test-webview.html` mock 了 `acquireVsCodeApi`，可以在普通浏览器中验证 webview 渲染。
```bash
npx serve . -l 3456
# 浏览器打开 http://localhost:3456/test-webview.html
# F12 查看 Console 错误
```
这比在 Cursor 中反复 Reload Window 高效 10 倍以上。

### 3. deploy.js 清理逻辑
deploy.js 会先删除 `~/.cursor/extensions/` 中所有旧版本再拷贝新文件，包含文件大小校验。

### 4. CSP (Content Security Policy)
当前版本不设置显式 CSP（Cursor webview 默认允许 inline script）。如果后续添加 CSP，需配合 nonce 且每次刷新都重新生成。

### 5. WeChat 集成隔离
WeChat engine 引入 `node:crypto`/`node:http` 等模块。在 extension host 中若模块加载阶段产生副作用会导致整个插件激活失败。
**规则**：WeChat 代码必须懒加载（dynamic import 或延迟 require），不能在顶层 import。

## 故障排查

| 症状 | 检查方法 |
|------|----------|
| 面板空白 | 浏览器打开 test-webview.html + Console 检查 JS 错误 |
| 版本不更新 | `ls ~/.cursor/extensions/ \| grep multisession` |
| 激活失败 | `View > Output` 选 "MultiSession"；或查看 `~/Library/Application Support/Cursor/logs/*/window*/exthost/exthost.log` |
| Webview 资源加载失败 | Output 日志中查看 `[webview] scriptUri:` 路径是否正确 |
| minify 后神秘 JS 报错 | 不加 `--minify` 重新编译 webview，用浏览器查看原始错误 |
