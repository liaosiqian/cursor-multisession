import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DATA_ROOT = path.join(os.homedir(), '.multisession');
const SESSIONS_FILE = path.join(DATA_ROOT, 'sessions.json');
const SESSIONS_DIR = path.join(DATA_ROOT, 'sessions');
const ACTIVE_WINDOW_FILE = path.join(DATA_ROOT, 'active-window.json');

const POLL_INTERVAL_MS = 500;
const RECONNECT_COOLDOWN_MS = 5_000;

const currentWindowToken = `w-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
let panel: vscode.WebviewView | undefined;
let pollTimer: NodeJS.Timeout | undefined;
let lastReconnectAttempt = 0;
let output: vscode.OutputChannel;
let EXT_VERSION = '?';
let IS_DEV = false;

// ── 通信规则提示词（粘贴到 Composer 用） ──

const RULE_PROMPT = `你好，请遵循以下 MCP 工具调用规则。

# MCP 工具调用规则

1. 每轮对话回复**完整输出后**，最后一步必须调用 \`check_messages\`，适用于 Agent/Plan/Debug/Ask 所有模式，无一例外
2. \`check_messages\` 会持续等待直到用户发来新消息；收到后处理并回复，然后再次调用 \`check_messages\`，形成永续循环：回复 → check_messages → 收到消息 → 回复 → check_messages
3. 严禁在回合开始时或回复未完成时调用 \`check_messages\`；唯一豁免：用户明确要求结束对话
4. Plan 模式写完方案后、Debug 模式分析完问题后、Ask 模式回答完问题后，均不得直接结束对话，必须调用 \`check_messages\` 等待用户反馈
5. **模式切换/新对话恢复**：切换模式（如 Agent → Plan）或 Composer 重新打开时，如果丢失了 session_id，直接调用 \`check_messages\`（不传 session_id），服务端会自动恢复之前的会话。恢复后使用返回的 session_id 继续工作
6. 需要用户做选择或确认时（选方案、选框架、确认操作等），必须调用 \`ask_question\`；严禁使用 Cursor 内置的 ask_user_question
7. \`ask_question\` 参数格式: \`{ "session_id": "xxx", "questions": [{ "question": "问题文本", "options": [{ "id": "a", "label": "选项A" }, { "id": "b", "label": "选项B" }], "allow_multiple": false }] }\`
8. 单选: \`allow_multiple: false\`；多选: \`allow_multiple: true\`；同一 \`questions\` 数组可混合单选和多选
9. 用户在每道题中均可额外输入自定义补充文本，无需为此添加额外选项
10. \`ask_question\` 收到用户回答后，处理完毕仍需调用 \`check_messages\` 继续监听
11. 禁止在每轮结束时用 \`ask_question\` 问"还有别的需要吗"，回合结束只用 \`check_messages\`
12. \`check_messages\` 支持可选参数 \`reply\`（string，Markdown 格式）：传入本轮回复的摘要/结论，插件界面会弹窗展示给用户。无需总结时可省略
13. 首次调用 \`check_messages\` 后会返回一个 \`session_id\`，此后每次调用任何 MCP 工具都必须在 arguments 中带上此 \`session_id\`
14. 可以使用 subagent 执行搜索、分析等独立任务，但所有 MultiSession MCP 工具（check_messages、ask_question、export_chat）必须由主 Agent 调用，subagent 不得调用
15. 如果 \`check_messages\` 或 \`ask_question\` 因异常返回/报错，且用户未要求结束对话，严禁输出内部错误给用户，必须立刻再次调用对应工具继续等待
16. \`export_chat\` 用于导出当前会话的完整对话记录，仅当用户要求"导出对话"时才调用

---
**回合结束（强制）**: 回复完整输出完毕后，最后一步必须调用 MultiSession MCP 的 \`check_messages\` 工具。`;

// ── Cursor Rule 文件内容（自动注入，含 subagent 限制） ──

const CURSOR_RULE_CONTENT = `---
description: MultiSession 多会话通信规则，自动注入到所有对话中。
globs:
alwaysApply: true
---

> **SUBAGENT 专属指令（通过 Task 工具启动的子代理必读）**
> 你是 subagent（子代理），**严禁调用任何 MultiSession MCP 工具**，包括 \`check_messages\`、\`ask_question\`、\`export_chat\`。这些工具只能由主 Agent 调用。你完成任务后直接返回结果即可。下方所有规则均仅适用于主 Agent，与你无关。

# MCP 工具调用规则（仅主 Agent 适用）

以下规则**仅适用于主 Agent**，subagent **必须忽略以下所有规则**，完成任务后直接返回结果。

1. 每轮对话回复**完整输出后**，最后一步必须调用 \`check_messages\`，适用于 Agent/Plan/Debug/Ask 所有模式，无一例外
2. \`check_messages\` 会持续等待直到用户发来新消息；收到后处理并回复，然后再次调用 \`check_messages\`，形成永续循环
3. **新对话 / 模式切换恢复**：若对话中尚无用户消息，或切换模式（Agent ↔ Plan ↔ Debug ↔ Ask）后丢失了 session_id，应直接调用 \`check_messages\`（不传 session_id），服务端会自动恢复之前的会话。恢复后使用返回的 session_id 继续。严禁在已有用户消息且回复未完成时调用；唯一豁免：用户明确要求结束对话
4. Plan 模式写完方案后、Debug 模式分析完问题后、Ask 模式回答完问题后，均不得直接结束对话，必须调用 \`check_messages\` 等待用户反馈
5. 需要用户做选择或确认时，必须调用 \`ask_question\`；严禁使用 Cursor 内置的 ask_user_question
6. \`ask_question\` 参数格式: \`{ "session_id": "xxx", "questions": [{ "question": "问题文本", "options": [{ "id": "a", "label": "选项A" }], "allow_multiple": false }] }\`
7. 单选: \`allow_multiple: false\`；多选: \`allow_multiple: true\`；可混合
8. \`ask_question\` 收到回答后，处理完毕仍需调用 \`check_messages\` 继续监听
9. 禁止在每轮结束时用 \`ask_question\` 问"还有别的需要吗"；\`ask_question\` 仅限任务中确实需要用户决策时使用
10. \`check_messages\` 的 \`reply\` 参数：传入本轮回复的**摘要/结论**（Markdown），不是完整正文。正常回答应直接写在主回复正文里
11. 首次调用 \`check_messages\` 后会返回 \`session_id\`，此后每次调用任何 MultiSession 工具都必须带上
12. **严禁 subagent 调用 MultiSession MCP 工具**。主 Agent 可使用 subagent 执行搜索、分析等独立任务，但 check_messages、ask_question、export_chat 必须且只能由主 Agent 调用
13. 如果工具因异常返回/报错，且用户未要求结束对话，严禁输出内部错误给用户，必须立刻再次调用对应工具继续等待
14. \`export_chat\` 仅当用户要求"导出对话"时才调用

---
**回合结束（强制，仅主 Agent）**: 回复完整输出完毕后，最后一步必须调用 MultiSession MCP 的 \`check_messages\` 工具。subagent 完成任务后直接返回结果，不调用任何 MultiSession MCP 工具。
`;

// ── helpers ──

function ensureDir(dir: string) {
	fs.mkdirSync(dir, { recursive: true });
}

function readJson<T = any>(p: string): T | null {
	try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
	catch { return null; }
}

function writeJson(p: string, data: any) {
	ensureDir(path.dirname(p));
	fs.writeFileSync(p, JSON.stringify(data, null, '\t'), 'utf-8');
}

function normalizePathForCompare(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function getWorkspacePaths(): string[] {
	return (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
}

// ── window token ──

function markThisWindowActive() {
	const wsPaths = getWorkspacePaths();
	if (wsPaths.length === 0) return;
	const data = readJson<Record<string, { token: string; timestamp: number }[]>>(ACTIVE_WINDOW_FILE) || {};
	const now = Date.now();
	for (const ws of wsPaths) {
		const entries = data[ws] || [];
		const existing = entries.find(e => e.token === currentWindowToken);
		if (existing) {
			existing.timestamp = now;
		} else {
			entries.unshift({ token: currentWindowToken, timestamp: now });
		}
		data[ws] = entries.slice(0, 8);
	}
	writeJson(ACTIVE_WINDOW_FILE, data);
}

// ── session filtering ──

interface SessionMeta {
	id: string;
	name: string;
	workspace: string;
	windowToken?: string;
	alive: boolean;
	createdAt: number;
	lastActiveAt: number;
}

function getSessionsForThisWorkspace(): SessionMeta[] {
	const sessions = readJson<SessionMeta[]>(SESSIONS_FILE) || [];
	const wsPaths = getWorkspacePaths().map(normalizePathForCompare);
	return sessions.filter(s => {
		if (!s.workspace) return true;
		return wsPaths.some(wp => normalizePathForCompare(s.workspace) === wp);
	});
}

// ── slash commands (panel-side) ──

interface SlashResult {
	text: string;
	isCommand: true;
}

function tryHandlePanelSlashCommand(text: string, sessionId: string): SlashResult | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith('/')) return null;

	const spaceIdx = trimmed.indexOf(' ');
	const cmdName = (spaceIdx > 0 ? trimmed.slice(1, spaceIdx) : trimmed.slice(1)).toLowerCase();
	const args = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : '';

	switch (cmdName) {
		case 'status':
			return { isCommand: true, text: buildStatusResponse(sessionId) };
		case 'ping':
			return { isCommand: true, text: `Pong! Panel → Extension latency: <1ms\nSession: ${sessionId}` };
		case 'help':
			return { isCommand: true, text: buildHelpResponse() };
		case 'session':
			return { isCommand: true, text: buildSessionResponse() };
		case 'rename':
			if (!args) return { isCommand: true, text: 'Usage: /rename <new name>\nExample: /rename my-project' };
			return { isCommand: true, text: renameSession(sessionId, args) };
		default:
			return null;
	}
}

function buildStatusResponse(sessionId: string): string {
	const sessions = readJson<SessionMeta[]>(SESSIONS_FILE) || [];
	const current = sessions.find(s => s.id === sessionId);
	const alive = sessions.filter(s => s.alive);
	const queuePath = path.join(SESSIONS_DIR, sessionId, 'queue.json');
	const queue = readJson<any[]>(queuePath) || [];
	const inquiryPath = path.join(SESSIONS_DIR, sessionId, 'inquiry.json');
	const inquiry = readJson<any>(inquiryPath);
	const summaryPath = path.join(SESSIONS_DIR, sessionId, 'summary.json');
	const summary = readJson<any>(summaryPath);

	const lines: string[] = ['--- MultiSession Status ---'];
	lines.push(`Session: ${current?.name ?? sessionId}`);
	lines.push(`Active: ${current?.alive ? 'yes' : 'no'}`);
	if (current?.lastActiveAt) {
		const ago = Date.now() - current.lastActiveAt;
		lines.push(`Last active: ${formatDuration(ago)} ago`);
	}
	lines.push(`Pending messages: ${queue.length}`);
	lines.push(`Inquiry pending: ${inquiry && !inquiry.answered ? 'YES' : 'no'}`);
	if (summary?.ts) {
		const ago = Date.now() - summary.ts;
		lines.push(`Last AI reply: ${formatDuration(ago)} ago`);
	}
	lines.push(`Total sessions: ${sessions.length} (${alive.length} alive)`);
	lines.push(`Window: ${currentWindowToken.slice(0, 16)}...`);
	return lines.join('\n');
}

function buildHelpResponse(): string {
	return [
		'--- Available Commands ---',
		'/status — Show session status',
		'/ping — Quick connectivity check',
		'/help — Show this help',
		'/session — List all sessions',
		'/rename <name> — Rename current session',
	].join('\n');
}

function buildSessionResponse(): string {
	const sessions = readJson<SessionMeta[]>(SESSIONS_FILE) || [];
	const alive = sessions.filter(s => s.alive);
	if (alive.length === 0) return 'No active sessions.';
	const lines = ['--- Sessions ---'];
	for (const s of alive) {
		const ago = formatDuration(Date.now() - s.lastActiveAt);
		lines.push(`• ${s.name} (${s.id.slice(0, 8)}) — last active ${ago} ago`);
	}
	return lines.join('\n');
}

function renameSession(sessionId: string, newName: string): string {
	const sessions = readJson<SessionMeta[]>(SESSIONS_FILE) || [];
	const target = sessions.find(s => s.id === sessionId);
	if (!target) return `Session ${sessionId} not found.`;
	const oldName = target.name;
	target.name = newName;
	writeJson(SESSIONS_FILE, sessions);
	return `Session renamed: "${oldName}" → "${newName}"`;
}

function formatDuration(ms: number): string {
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m${sec % 60}s`;
	const hr = Math.floor(min / 60);
	return `${hr}h${min % 60}m`;
}

// ── poll tick ──

function tick() {
	if (!panel) return;

	try {
		const sessions = getSessionsForThisWorkspace();
		panel.webview.postMessage({ type: 'sessions', data: sessions });

		for (const s of sessions) {
			const dir = path.join(SESSIONS_DIR, s.id);

			const logs = readJson(path.join(dir, 'chat-log.json'));
			if (logs) {
				panel.webview.postMessage({ type: 'syncLogs', sessionId: s.id, data: logs });
			}

			const queue = readJson<any[]>(path.join(dir, 'queue.json'));
			panel.webview.postMessage({
				type: 'pendingCount',
				sessionId: s.id,
				count: queue ? queue.length : 0,
				items: queue || [],
			});

			const inquiry = readJson(path.join(dir, 'inquiry.json'));
			if (inquiry) {
				panel.webview.postMessage({ type: 'inquiry', sessionId: s.id, data: inquiry });
			}

			const summary = readJson(path.join(dir, 'summary.json'));
			if (summary) {
				panel.webview.postMessage({ type: 'summary', sessionId: s.id, data: summary });
			}

			const progress = readJson(path.join(dir, 'progress.json'));
			if (progress) {
				panel.webview.postMessage({ type: 'progress', sessionId: s.id, data: progress });
			}
		}
	} catch (err) {
		output.appendLine(`[tick] error: ${err}`);
	}
}

function syncState() {
	if (!panel) return;
	const sessions = getSessionsForThisWorkspace();
	panel.webview.postMessage({ type: 'sessions', data: sessions });
	panel.webview.postMessage({ type: 'mcpConfigured', data: isMcpConfigured() });
	panel.webview.postMessage({ type: 'workspacePaths', data: getWorkspacePaths() });
	panel.webview.postMessage({ type: 'rulePrompt', data: RULE_PROMPT });
	panel.webview.postMessage({ type: 'extensionInfo', version: EXT_VERSION, isDev: IS_DEV });
}

// ── MCP config ──

function getMcpConfigPath(wsPath: string): string {
	return path.join(wsPath, '.cursor', 'mcp.json');
}

function isMcpConfigured(): boolean {
	for (const ws of getWorkspacePaths()) {
		const mcpPath = getMcpConfigPath(ws);
		const config = readJson<any>(mcpPath);
		if (config?.mcpServers?.MultiSession) return true;
	}
	return false;
}

function getExtensionMcpServerPath(ctx: vscode.ExtensionContext): string {
	return path.join(ctx.extensionPath, 'dist', 'mcp-server.mjs');
}

function getCursorRuleContent(): string {
	return CURSOR_RULE_CONTENT;
}

function installMcpConfig(ctx: vscode.ExtensionContext): 'installed' | 'already' | 'none' {
	const mcpServerPath = getExtensionMcpServerPath(ctx);
	const wsPaths = getWorkspacePaths();
	if (wsPaths.length === 0) return 'none';

	const targetWs = wsPaths[0];
	const desiredMcpEntry = {
		command: 'node',
		args: [mcpServerPath],
		timeoutMs: 1800000,
	};
	const desiredRuleContent = getCursorRuleContent();

	const mcpPath = getMcpConfigPath(targetWs);
	const config = readJson<any>(mcpPath) || {};
	const existing = config?.mcpServers?.MultiSession;

	const mcpMatch = existing
		&& existing.command === desiredMcpEntry.command
		&& JSON.stringify(existing.args) === JSON.stringify(desiredMcpEntry.args)
		&& existing.timeoutMs === desiredMcpEntry.timeoutMs;

	const rulePath = path.join(targetWs, '.cursor', 'rules', 'multisession.mdc');
	let ruleMatch = false;
	try {
		ruleMatch = fs.readFileSync(rulePath, 'utf-8') === desiredRuleContent;
	} catch { /* file doesn't exist */ }

	let duplicatesCleaned = false;
	for (const ws of wsPaths.slice(1)) {
		const otherMcpPath = getMcpConfigPath(ws);
		const otherConfig = readJson<any>(otherMcpPath);
		if (otherConfig?.mcpServers?.MultiSession) {
			delete otherConfig.mcpServers.MultiSession;
			writeJson(otherMcpPath, otherConfig);
			duplicatesCleaned = true;
		}
		const otherRulePath = path.join(ws, '.cursor', 'rules', 'multisession.mdc');
		try { fs.unlinkSync(otherRulePath); duplicatesCleaned = true; } catch { /* ignore */ }
	}

	if (mcpMatch && ruleMatch && !duplicatesCleaned) {
		return 'already';
	}

	config.mcpServers = config.mcpServers || {};
	config.mcpServers.MultiSession = desiredMcpEntry;
	writeJson(mcpPath, config);

	ensureDir(path.dirname(rulePath));
	fs.writeFileSync(rulePath, desiredRuleContent, 'utf-8');

	return 'installed';
}

function uninstallMcpConfig(): number {
	let count = 0;
	for (const ws of getWorkspacePaths()) {
		const mcpPath = getMcpConfigPath(ws);
		const config = readJson<any>(mcpPath);
		if (config?.mcpServers?.MultiSession) {
			delete config.mcpServers.MultiSession;
			writeJson(mcpPath, config);

			// 清理 cursor rule
			const rulePath = path.join(ws, '.cursor', 'rules', 'multisession.mdc');
			try { fs.unlinkSync(rulePath); } catch { /* ignore */ }

			count++;
		}
	}
	return count;
}

// ── reconnect ──

async function tryReconnectViaCursor() {
	const now = Date.now();
	if (now - lastReconnectAttempt < RECONNECT_COOLDOWN_MS) {
		output.appendLine('[reconnect] cooldown, skipping');
		return;
	}
	lastReconnectAttempt = now;

	try {
		await vscode.commands.executeCommand('composer.resumeCurrentChat');
		output.appendLine('[reconnect] composer.resumeCurrentChat succeeded');
	} catch {
		try {
			await vscode.commands.executeCommand('composer.startComposerPrompt');
			output.appendLine('[reconnect] fallback to composer.startComposerPrompt');
		} catch (e) {
			output.appendLine(`[reconnect] all attempts failed: ${e}`);
		}
	}
}

// ── webview provider ──

class MultiSessionViewProvider implements vscode.WebviewViewProvider {
	constructor(private ctx: vscode.ExtensionContext) {}

	resolveWebviewView(view: vscode.WebviewView) {
		panel = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'dist')],
		};
		view.webview.html = this.getHtml(view.webview);

		markThisWindowActive();
		this.setupDevHotReload(view);

		view.onDidChangeVisibility(() => {
			if (view.visible) syncState();
		});

		view.webview.onDidReceiveMessage(msg => {
			markThisWindowActive();

			switch (msg.type) {
				case 'init':
					syncState();
					break;

			case 'text': {
				const sid = msg.sessionId || 'default';
				const textContent = (msg.text || '').trim();

				// intercept slash commands — handle locally, don't push to queue
				if (textContent && !msg.images?.length) {
					const slashResult = tryHandlePanelSlashCommand(textContent, sid);
					if (slashResult) {
						output.appendLine(`[slash] ${sid}: ${textContent}`);
						panel?.webview.postMessage({
							type: 'slashResult',
							sessionId: sid,
							text: slashResult.text,
						});
						break;
					}
				}

				const sessionDir = path.join(SESSIONS_DIR, sid);
				const queuePath = path.join(sessionDir, 'queue.json');
				const queue = readJson<any[]>(queuePath) || [];

				const imagePaths: string[] = [];
				if (msg.images && Array.isArray(msg.images)) {
					const imgDir = path.join(sessionDir, 'images');
					ensureDir(imgDir);
					for (const img of msg.images) {
						try {
							const match = (img.dataUrl as string).match(/^data:image\/(\w+);base64,(.+)$/);
							if (match) {
								const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
								const fname = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
								const fpath = path.join(imgDir, fname);
								fs.writeFileSync(fpath, Buffer.from(match[2], 'base64'));
								imagePaths.push(fpath);
							}
						} catch (e) {
							output.appendLine(`[img] save error: ${e}`);
						}
					}
				}

				let content = msg.text || '';
				if (imagePaths.length > 0) {
					const imgRefs = imagePaths.map(p => `[image: ${p}]`).join('\n');
					content = content ? `${content}\n${imgRefs}` : imgRefs;
				}

				if (content) {
					queue.push({
						id: `${Date.now().toString(16)}-${Math.random().toString(36).slice(2, 8)}`,
						type: imagePaths.length > 0 ? 'text+image' : 'text',
						content,
						images: imagePaths,
						timestamp: new Date().toISOString(),
					});
					ensureDir(path.dirname(queuePath));
					writeJson(queuePath, queue);
					output.appendLine(`[msg] queued to ${sid}: ${content.slice(0, 50)}${imagePaths.length > 0 ? ` (+${imagePaths.length} images)` : ''}`);
				}
				break;
			}

			case 'renameSession': {
				const sessions = readJson<SessionMeta[]>(SESSIONS_FILE) || [];
				const target = sessions.find(s => s.id === msg.sessionId);
				if (target && msg.newName) {
					target.name = msg.newName.trim();
					writeJson(SESSIONS_FILE, sessions);
					output.appendLine(`[rename] ${msg.sessionId} → ${target.name}`);
					syncState();
				}
				break;
			}

				case 'reconnect':
					tryReconnectViaCursor();
					break;

				case 'copyRule':
					vscode.env.clipboard.writeText(RULE_PROMPT);
					vscode.window.showInformationMessage('通信规则已复制到剪贴板');
					break;

				case 'installMcp': {
					const result = installMcpConfig(this.ctx);
					syncState();
					if (result === 'already') {
						vscode.window.showInformationMessage('MCP + 通信规则已是最新，无需重复安装');
					} else if (result === 'installed') {
						vscode.window.showInformationMessage(
							'MCP + 通信规则已安装，请重启 Cursor 生效',
							'重启 Cursor'
						).then(choice => {
							if (choice === '重启 Cursor') {
								vscode.commands.executeCommand('workbench.action.reloadWindow');
							}
						});
					}
					break;
				}

				case '__reload__':
					vscode.commands.executeCommand('workbench.action.reloadWindow');
					break;

				case 'answerInquiry': {
					const inquiryPath = path.join(SESSIONS_DIR, msg.sessionId, 'inquiry.json');
					const inquiry = readJson<any>(inquiryPath);
					if (inquiry && !inquiry.answered) {
						inquiry.answered = true;
						inquiry.answers = msg.answers;
						writeJson(inquiryPath, inquiry);
						output.appendLine(`[inquiry] answered for ${msg.sessionId}`);
					}
					break;
				}

				case 'deletePending': {
					const dqPath = path.join(SESSIONS_DIR, msg.sessionId, 'queue.json');
					const dq = readJson<any[]>(dqPath) || [];
					const filtered = dq.filter((item: any) => item.id !== msg.itemId);
					writeJson(dqPath, filtered);
					output.appendLine(`[pending] deleted ${msg.itemId} from ${msg.sessionId}`);
					break;
				}

				case 'resendPending': {
					const rqPath = path.join(SESSIONS_DIR, msg.sessionId, 'queue.json');
					const rq = readJson<any[]>(rqPath) || [];
					const target = rq.find((item: any) => item.id === msg.itemId);
					if (target) {
						target.urgent = true;
						writeJson(rqPath, rq);
						output.appendLine(`[pending] marked ${msg.itemId} as urgent in ${msg.sessionId}`);
					}
					break;
				}

				case 'editPending': {
					const eqPath = path.join(SESSIONS_DIR, msg.sessionId, 'queue.json');
					const eq = readJson<any[]>(eqPath) || [];
					const item = eq.find((i: any) => i.id === msg.itemId);
					if (item) {
						item.content = msg.newContent;
						writeJson(eqPath, eq);
						output.appendLine(`[pending] edited ${msg.itemId} in ${msg.sessionId}`);
					}
					break;
				}

				case 'closeSession': {
					const sessions = readJson<SessionMeta[]>(SESSIONS_FILE) || [];
					const s = sessions.find(x => x.id === msg.sessionId);
					if (s) {
						s.alive = false;
						writeJson(SESSIONS_FILE, sessions);
					}
					break;
				}
			}
		});

		output.appendLine('[webview] panel resolved');
	}

	private setupDevHotReload(view: vscode.WebviewView) {
		if (this.ctx.extensionMode !== vscode.ExtensionMode.Development) return;

		const pattern = new vscode.RelativePattern(this.ctx.extensionUri, 'dist/webview.{js,css}');
		const watcher = vscode.workspace.createFileSystemWatcher(pattern);
		let timer: NodeJS.Timeout;

		const reload = () => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				if (view.visible) {
					output.appendLine('[hot-reload] webview files changed, refreshing');
					view.webview.html = this.getHtml(view.webview);
				}
			}, 300);
		};

		watcher.onDidChange(reload);
		this.ctx.subscriptions.push(watcher);
		output.appendLine('[dev] webview hot-reload watcher enabled');
	}

	private getHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js')
		);
		const cssUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.css')
		);
		output.appendLine(`[webview] scriptUri: ${scriptUri}`);
		output.appendLine(`[webview] cssUri: ${cssUri}`);
		output.appendLine(`[webview] extensionUri: ${this.ctx.extensionUri}`);
		const cacheBust = IS_DEV ? `?t=${Date.now()}` : '';
		return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${cssUri}${cacheBust}">
</head>
<body>
	<div id="root"><p style="padding:12px;color:var(--vscode-descriptionForeground);font-size:12px;">Loading v${EXT_VERSION}...</p></div>
	<div id="diag" style="position:fixed;bottom:0;right:0;padding:4px 8px;font-size:10px;color:var(--vscode-descriptionForeground);opacity:0.5;"></div>
	<script>
		const vscode = acquireVsCodeApi();
		window.__EXT_VERSION__ = "${EXT_VERSION}";
		document.getElementById('diag').textContent = 'v${EXT_VERSION} init ok';
	</script>
	<script src="${scriptUri}${cacheBust}" onerror="document.getElementById('root').innerHTML='<p style=\\'padding:12px;color:#f44;\\'>Failed to load webview.js</p>';"></script>
</body>
</html>`;
	}
}

// ── WeChat engine (lazy-loaded via separate bundle to avoid side-effects) ──

let wechatEngine: any;
let wechatPanel: vscode.WebviewView | undefined;
let wechatState: 'idle' | 'logging_in' | 'connecting' | 'connected' | 'error' = 'idle';
let wechatStatusBar: vscode.StatusBarItem | undefined;

async function getOrCreateEngine(): Promise<any> {
	if (wechatEngine) return wechatEngine;
	output.appendLine('[wechat] lazy-loading engine...');
	const enginePath = path.join(__dirname, 'wechat-engine.js');
	const { ClawBotEngine } = require(enginePath);
	wechatEngine = new ClawBotEngine();

	wechatEngine.on('stateChange', (state, detail) => {
		wechatState = state;
		output.appendLine(`[wechat] state: ${state}${detail ? ' — ' + detail : ''}`);
		updateWechatPanel();
		updateWechatStatusBar();
	});
	wechatEngine.on('qrCode', (info) => {
		output.appendLine(`[wechat] QR code ready`);
		updateWechatPanel(info.qrcodeUrl);
	});
	wechatEngine.on('qrScanned', () => {
		output.appendLine('[wechat] QR scanned, waiting confirm...');
	});
	wechatEngine.on('loginSuccess', () => {
		output.appendLine('[wechat] login success');
		vscode.window.showInformationMessage('WeChat 登录成功');
	});
	wechatEngine.on('loginError', (err) => {
		output.appendLine(`[wechat] login error: ${err.message}`);
		vscode.window.showErrorMessage(`WeChat 登录失败: ${err.message}`);
	});
	wechatEngine.on('message', (from, text) => {
		output.appendLine(`[wechat] msg from ${from}: ${text.substring(0, 80)}`);
	});
	wechatEngine.on('error', (err) => {
		output.appendLine(`[wechat] error: ${err.message}`);
	});

	output.appendLine('[wechat] engine initialized');
	return wechatEngine;
}

function updateWechatStatusBar() {
	if (!wechatStatusBar) return;
	const icons: Record<string, string> = {
		idle: '$(circle-outline)',
		logging_in: '$(loading~spin)',
		connecting: '$(loading~spin)',
		connected: '$(check)',
		error: '$(error)',
	};
	wechatStatusBar.text = `${icons[wechatState] || ''} WeChat`;
	wechatStatusBar.tooltip = `WeChat: ${wechatState}`;
}

function updateWechatPanel(qrUrl?: string) {
	if (!wechatPanel) return;
	wechatPanel.webview.postMessage({ type: 'stateChange', state: wechatState, qrUrl });
}

class WeChatViewProvider implements vscode.WebviewViewProvider {
	resolveWebviewView(view: vscode.WebviewView) {
		wechatPanel = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = this.getHtml();

		view.webview.onDidReceiveMessage(async (msg) => {
			try {
				const engine = await getOrCreateEngine();
				switch (msg.type) {
					case 'login':
						await engine.login();
						break;
					case 'connect':
						await engine.connect();
						break;
					case 'disconnect':
						engine.disconnect();
						break;
				}
			} catch (err: any) {
				output.appendLine(`[wechat] command error: ${err.message}`);
				vscode.window.showErrorMessage(`WeChat: ${err.message}`);
			}
		});

		output.appendLine('[wechat] panel resolved');
	}

	private getHtml(): string {
		return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
:root { --fg: var(--vscode-sideBar-foreground); --bg: var(--vscode-sideBar-background); --muted: var(--vscode-descriptionForeground); --accent: var(--vscode-button-background); --accent-fg: var(--vscode-button-foreground); }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: var(--vscode-font-family); color: var(--fg); background: var(--bg); padding: 12px; font-size: 13px; }
.status { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.dot { width: 8px; height: 8px; border-radius: 50%; }
.dot.idle { background: #888; }
.dot.logging_in, .dot.connecting { background: #f0a030; animation: pulse 1s infinite; }
.dot.connected { background: #4caf50; }
.dot.error { background: #f44336; }
@keyframes pulse { 50% { opacity: 0.4; } }
.label { font-size: 12px; color: var(--muted); }
.btn { display: block; width: 100%; padding: 6px 12px; margin-top: 8px; border: none; border-radius: 4px; background: var(--accent); color: var(--accent-fg); cursor: pointer; font-size: 12px; }
.btn:hover { opacity: 0.9; }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn.secondary { background: transparent; border: 1px solid var(--muted); color: var(--fg); }
.qr-container { text-align: center; margin: 12px 0; }
.qr-container img { max-width: 200px; border-radius: 4px; }
.info { font-size: 11px; color: var(--muted); margin-top: 12px; }
</style></head>
<body>
<div class="status">
	<div id="dot" class="dot idle"></div>
	<span id="state-text">未连接</span>
</div>
<div id="qr-container" class="qr-container" style="display:none;">
	<img id="qr-img" alt="QR Code" />
	<p class="label">请用微信扫码登录</p>
</div>
<button id="btn-login" class="btn" onclick="postMsg('login')">扫码登录</button>
<button id="btn-connect" class="btn" style="display:none;" onclick="postMsg('connect')">连接</button>
<button id="btn-disconnect" class="btn secondary" style="display:none;" onclick="postMsg('disconnect')">断开连接</button>
<p class="info">连接后微信消息将自动路由到 MultiSession。</p>
<script>
const vscode = acquireVsCodeApi();
function postMsg(type) { vscode.postMessage({ type }); }
const stateLabels = { idle: '未连接', logging_in: '扫码登录中...', connecting: '连接中...', connected: '已连接', error: '连接错误' };
window.addEventListener('message', e => {
	const msg = e.data;
	if (msg.type === 'stateChange') {
		const s = msg.state;
		document.getElementById('dot').className = 'dot ' + s;
		document.getElementById('state-text').textContent = stateLabels[s] || s;
		document.getElementById('btn-login').style.display = (s === 'idle' || s === 'error') ? 'block' : 'none';
		document.getElementById('btn-connect').style.display = (s === 'idle' && !msg.qrUrl) ? 'none' : (s === 'logging_in' ? 'none' : (s === 'connected' ? 'none' : 'block'));
		document.getElementById('btn-disconnect').style.display = s === 'connected' ? 'block' : 'none';
		if (msg.qrUrl) {
			document.getElementById('qr-container').style.display = 'block';
			document.getElementById('qr-img').src = msg.qrUrl;
		} else if (s !== 'logging_in') {
			document.getElementById('qr-container').style.display = 'none';
		}
	}
});
</script>
</body></html>`;
	}
}

// ── activate ──

export function activate(ctx: vscode.ExtensionContext) {
	output = vscode.window.createOutputChannel('MultiSession');
	ctx.subscriptions.push(output);

	// read version from package.json at extension root
	try {
		const pkgPath = path.join(ctx.extensionPath, 'package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
		EXT_VERSION = pkg.version || '?';
	} catch { /* fallback */ }

	IS_DEV = ctx.extensionMode === vscode.ExtensionMode.Development;
	const modeLabel = IS_DEV ? 'DEV' : 'PROD';

	output.appendLine(`[activate] MultiSession v${EXT_VERSION} (${modeLabel})`);
	output.appendLine(`[activate] extensionPath: ${ctx.extensionPath}`);
	output.appendLine(`[activate] dataRoot: ${DATA_ROOT}`);

	ensureDir(DATA_ROOT);
	ensureDir(SESSIONS_DIR);
	ensureDir(path.join(SESSIONS_DIR, 'default'));

	markThisWindowActive();

	// register MultiSession webview
	const msProvider = new MultiSessionViewProvider(ctx);
	ctx.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			'multiSession.panel',
			msProvider,
			{ webviewOptions: { retainContextWhenHidden: true } }
		)
	);
	output.appendLine('[activate] MultiSession panel provider registered');

	// ── WeChat panel ──
	ctx.subscriptions.push(
		vscode.window.registerWebviewViewProvider('multiSession.wechat', new WeChatViewProvider())
	);
	output.appendLine('[activate] WeChat panel provider registered');

	// ── WeChat status bar ──
	wechatStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
	wechatStatusBar.command = 'multiSession.wechatStatus';
	wechatStatusBar.text = '$(circle-outline) WeChat';
	wechatStatusBar.tooltip = 'WeChat: idle';
	wechatStatusBar.show();
	ctx.subscriptions.push(wechatStatusBar);

	// ── commands ──
	ctx.subscriptions.push(
		vscode.commands.registerCommand('multiSession.install', () => {
			const result = installMcpConfig(ctx);
			if (result === 'already') {
				vscode.window.showInformationMessage('MCP + 通信规则已是最新，无需重复安装');
			} else if (result === 'installed') {
				vscode.window.showInformationMessage(
					'MCP + 通信规则已安装，请重启 Cursor 生效',
					'重启 Cursor'
				).then(choice => {
					if (choice === '重启 Cursor') {
						vscode.commands.executeCommand('workbench.action.reloadWindow');
					}
				});
			}
		}),
		vscode.commands.registerCommand('multiSession.uninstall', () => {
			const count = uninstallMcpConfig();
			vscode.window.showInformationMessage(`已从 ${count} 个工作区卸载 MCP 配置`);
		}),
		vscode.commands.registerCommand('multiSession.shareFile', (uri: vscode.Uri) => {
			if (panel && uri) {
				panel.webview.postMessage({
					type: 'sharedFile',
					data: { path: uri.fsPath, name: path.basename(uri.fsPath) },
				});
			}
		}),
		vscode.commands.registerCommand('multiSession.copyRule', () => {
			vscode.env.clipboard.writeText(RULE_PROMPT);
			vscode.window.showInformationMessage('通信规则已复制到剪贴板');
		}),
		vscode.commands.registerCommand('multiSession.wechatLogin', async () => {
			try {
				const engine = await getOrCreateEngine();
				await engine.login();
			} catch (err: any) {
				vscode.window.showErrorMessage(`WeChat 登录失败: ${err.message}`);
			}
		}),
		vscode.commands.registerCommand('multiSession.wechatConnect', async () => {
			try {
				const engine = await getOrCreateEngine();
				await engine.connect();
			} catch (err: any) {
				vscode.window.showErrorMessage(`WeChat 连接失败: ${err.message}`);
			}
		}),
		vscode.commands.registerCommand('multiSession.wechatDisconnect', () => {
			wechatEngine?.disconnect();
		}),
		vscode.commands.registerCommand('multiSession.wechatStatus', () => {
			const state = wechatEngine?.getState() || 'idle';
			vscode.window.showInformationMessage(`WeChat 状态: ${state}`);
		}),
		vscode.commands.registerCommand('multiSession.wechatScreenshot', async () => {
			if (!wechatEngine || wechatEngine.getState() !== 'connected') {
				vscode.window.showWarningMessage('WeChat 未连接');
				return;
			}
			try {
				const filePath = await wechatEngine.sendScreenshot();
				vscode.window.showInformationMessage(`截图已发送: ${filePath}`);
			} catch (err: any) {
				vscode.window.showErrorMessage(`截图失败: ${err.message}`);
			}
		}),
	);

	// window focus tracking
	ctx.subscriptions.push(
		vscode.window.onDidChangeWindowState(e => {
			if (e.focused) markThisWindowActive();
		})
	);

	// fs.watch for instant session refresh
	try {
		fs.watch(DATA_ROOT, (_, filename) => {
			if (filename === 'sessions.json' && panel) {
				syncState();
			}
		});
	} catch { /* ignore */ }

	// start polling
	pollTimer = setInterval(tick, POLL_INTERVAL_MS);
	output.appendLine('[activate] polling started');
	output.appendLine(`[activate] done — v${EXT_VERSION} ready`);
}

export function deactivate() {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = undefined;
	}
	if (wechatEngine) {
		try { wechatEngine.disconnect(); } catch { /* best effort */ }
		wechatEngine = undefined;
	}
	output?.appendLine('[deactivate] cleanup done');
}
