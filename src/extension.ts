import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ChildProcess, spawn, execSync, execFile } from 'child_process';

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

const MAX_RECENT_FILES = 30;
const recentClosedFiles: { path: string; name: string; closedAt: number }[] = [];

// ── Voice recording state ──

let recordingProcess: ChildProcess | null = null;
let recordingTmpFile: string | null = null;
let recordBinaryPath: string | null = null;
let transcribeBinaryPath: string | null = null;

function getScriptsDir(ctx: vscode.ExtensionContext): string {
	return path.join(ctx.extensionPath, 'scripts');
}

function ensureVoiceBinaries(ctx: vscode.ExtensionContext): { record: string; transcribe: string } | null {
	const scriptsDir = getScriptsDir(ctx);
	const recordSrc = path.join(scriptsDir, 'record.swift');
	const transcribeSrc = path.join(scriptsDir, 'transcribe.swift');
	const recordBin = path.join(scriptsDir, 'record');
	const transcribeBin = path.join(scriptsDir, 'transcribe');

	if (!fs.existsSync(recordSrc) || !fs.existsSync(transcribeSrc)) {
		output.appendLine('[voice] swift source files not found');
		return null;
	}

	try {
		if (!fs.existsSync(recordBin) || fs.statSync(recordBin).mtimeMs < fs.statSync(recordSrc).mtimeMs) {
			output.appendLine('[voice] compiling record.swift...');
			execSync(`swiftc "${recordSrc}" -o "${recordBin}" -framework AVFoundation`, { timeout: 30000 });
		}
		if (!fs.existsSync(transcribeBin) || fs.statSync(transcribeBin).mtimeMs < fs.statSync(transcribeSrc).mtimeMs) {
			output.appendLine('[voice] compiling transcribe.swift...');
			execSync(`swiftc "${transcribeSrc}" -o "${transcribeBin}" -framework Speech -framework AVFoundation`, { timeout: 30000 });
		}
		return { record: recordBin, transcribe: transcribeBin };
	} catch (err: any) {
		output.appendLine(`[voice] compile error: ${err.message}`);
		return null;
	}
}

function startRecording(ctx: vscode.ExtensionContext): boolean {
	if (recordingProcess) {
		output.appendLine('[voice] already recording');
		return false;
	}

	const bins = ensureVoiceBinaries(ctx);
	if (!bins) {
		output.appendLine('[voice] binaries not available');
		return false;
	}
	recordBinaryPath = bins.record;
	transcribeBinaryPath = bins.transcribe;

	const tmpDir = path.join(os.tmpdir(), 'multisession-voice');
	fs.mkdirSync(tmpDir, { recursive: true });
	recordingTmpFile = path.join(tmpDir, `rec-${Date.now()}.wav`);

	output.appendLine(`[voice] spawning: ${bins.record} ${recordingTmpFile}`);
	recordingProcess = spawn(bins.record, [recordingTmpFile!], { stdio: ['pipe', 'pipe', 'pipe'] });
	output.appendLine(`[voice] record process pid=${recordingProcess.pid}`);

	recordingProcess.stdout?.on('data', (data: Buffer) => {
		const text = data.toString().trim();
		output.appendLine(`[voice:stdout] ${text}`);
	});

	let stderrBuf = '';
	recordingProcess.stderr?.on('data', (data: Buffer) => {
		const text = data.toString();
		stderrBuf += text;
		output.appendLine(`[voice:stderr] ${text.trim()}`);

		if (text.includes('microphone access denied') || text.includes('not authorized')) {
			output.appendLine('[voice] microphone permission denied, notifying user');
			recordingProcess?.kill();
			recordingProcess = null;
			recordingTmpFile = null;
			panel?.webview.postMessage({
				type: 'recordingState',
				recording: false,
				error: '麦克风权限未授权。请打开 系统设置 → 隐私与安全性 → 麦克风，为 Cursor 开启权限后重试。',
			});
			panel?.webview.postMessage({
				type: 'transcription',
				text: '',
				error: '麦克风权限未授权。请打开 系统设置 → 隐私与安全性 → 麦克风，为 Cursor 开启权限。',
			});
			vscode.window.showErrorMessage(
				'语音输入需要麦克风权限。请在系统设置中为 Cursor 开启麦克风权限。',
				'打开系统设置'
			).then(choice => {
				if (choice === '打开系统设置') {
					vscode.env.openExternal(vscode.Uri.parse('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'));
				}
			});
		}
	});

	recordingProcess.on('error', (err) => {
		output.appendLine(`[voice] process error: ${err.message}`);
		recordingProcess = null;
		recordingTmpFile = null;
	});

	recordingProcess.on('exit', (code, signal) => {
		output.appendLine(`[voice] record process exited: code=${code}, signal=${signal}`);
		if (code !== null && code !== 0 && recordingProcess) {
			panel?.webview.postMessage({ type: 'recordingState', recording: false, error: stderrBuf.trim() || `Recording failed (exit ${code})` });
		}
		recordingProcess = null;
	});

	output.appendLine(`[voice] recording started → ${recordingTmpFile}`);
	return true;
}

function stopRecordingAndTranscribe(locale: string = 'zh-CN'): Promise<string> {
	return new Promise((resolve, reject) => {
		if (!recordingProcess || !recordingTmpFile || !transcribeBinaryPath) {
			reject(new Error('not recording'));
			return;
		}

		const wavPath = recordingTmpFile;
		const transcribeBin = transcribeBinaryPath;
		const pid = recordingProcess.pid;

		output.appendLine(`[voice] stopping recording: pid=${pid}, file=${wavPath}`);
		recordingProcess.kill('SIGINT');
		recordingProcess = null;
		recordingTmpFile = null;

		setTimeout(() => {
			if (!fs.existsSync(wavPath)) {
				output.appendLine(`[voice] ERROR: recording file not found at ${wavPath}`);
				reject(new Error('recording file not found'));
				return;
			}
			const stat = fs.statSync(wavPath);
			output.appendLine(`[voice] recording file: ${wavPath} (${(stat.size / 1024).toFixed(1)}KB)`);
			if (stat.size < 1000) {
				output.appendLine(`[voice] recording too short (${stat.size} bytes), skipping transcription`);
				reject(new Error('录音太短，请说话后再停止'));
				return;
			}

			output.appendLine(`[voice] starting transcription: ${transcribeBin} ${wavPath} ${locale}`);

			execFile(transcribeBin, [wavPath, locale], { timeout: 60000 }, (err, stdout, stderr) => {
				const stderrText = (stderr || '').trim();
				output.appendLine(`[voice] transcribe exit: code=${err?.code ?? 0}, stdout="${stdout.trim()}", stderr="${stderrText}"`);

				if (err) {
					const userMsg = stderrText.includes('No speech detected') ? '未检测到语音，请对着麦克风说话后再试'
						: stderrText.includes('not authorized') ? '语音识别权限未授权，请在系统设置中允许'
						: stderrText || err.message;
					reject(new Error(userMsg));
					return;
				}
				const text = stdout.trim();
				if (!text) {
					output.appendLine(`[voice] transcribe returned empty text`);
					reject(new Error('未检测到语音，请对着麦克风说话后再试'));
					return;
				}
				output.appendLine(`[voice] transcription result: "${text}"`);
				resolve(text);
			});
		}, 500);
	});
}

// ── 通信规则提示词（粘贴到 Composer 用） ──

function generateRulePrompt(): string {
	return `你好，请遵循以下 MCP 工具调用规则。

# MCP 工具调用规则

1. 每轮对话回复**完整输出后**，最后一步必须调用 \`check_messages\`，适用于 Agent/Plan/Debug/Ask 所有模式，无一例外
2. \`check_messages\` 会持续等待直到用户发来新消息；收到后处理并回复，然后再次调用 \`check_messages\`，形成永续循环：回复 → check_messages → 收到消息 → 回复 → check_messages
3. **still_waiting 处理**：当 \`check_messages\` 返回包含 \`"status":"still_waiting"\` 时，**不要输出任何文字**，直接立刻再次调用 \`check_messages(session_id=上次的id)\` 保持连接
4. 首次调用 \`check_messages\` 后会返回一个 \`session_id\`，此后每次调用任何 MCP 工具都必须带上此 \`session_id\`
5. 需要用户做选择或确认时，必须调用 \`ask_question\`；严禁使用 Cursor 内置的 ask_user_question
6. \`ask_question\` 收到用户回答后，处理完毕仍需调用 \`check_messages\` 继续监听
7. \`check_messages\` 的 \`reply\` 参数：传入本轮回复的摘要/结论（Markdown），插件界面会展示给用户。无需总结时可省略
8. 可以使用 subagent 执行搜索、分析等独立任务，但 check_messages、ask_question、export_chat 必须由主 Agent 调用，subagent 不得调用
9. 如果工具因异常返回/报错，且用户未要求结束对话，必须立刻再次调用对应工具继续等待

---
**回合结束（强制）**: 回复完整输出完毕后，最后一步必须调用 MultiSession MCP 的 \`check_messages\` 工具。`;
}

function generateResumeRulePrompt(sessionId: string, sessionName: string): string {
	return `你好，请恢复之前的会话并遵循以下 MCP 工具调用规则。

# 会话恢复

**请立即调用 \`check_messages(session_id="${sessionId}")\`，恢复名为「${sessionName}」的会话。**

# MCP 工具调用规则

1. 每轮对话回复**完整输出后**，最后一步必须调用 \`check_messages\`，适用于 Agent/Plan/Debug/Ask 所有模式，无一例外
2. \`check_messages\` 会持续等待直到用户发来新消息；收到后处理并回复，然后再次调用 \`check_messages\`，形成永续循环
3. **still_waiting 处理**：当 \`check_messages\` 返回包含 \`"status":"still_waiting"\` 时，**不要输出任何文字**，直接立刻再次调用 \`check_messages(session_id="${sessionId}")\` 保持连接
4. **本对话的 session_id: \`${sessionId}\`**，此后每次调用任何 MCP 工具都必须带上此 \`session_id\`
5. 需要用户做选择或确认时，必须调用 \`ask_question\`；严禁使用 Cursor 内置的 ask_user_question
6. \`ask_question\` 收到用户回答后，处理完毕仍需调用 \`check_messages\` 继续监听
7. \`check_messages\` 的 \`reply\` 参数：传入本轮回复的摘要/结论（Markdown），插件界面会展示给用户
8. check_messages、ask_question、export_chat 必须由主 Agent 调用，subagent 不得调用
9. 如果工具因异常返回/报错，必须立刻再次调用对应工具继续等待

---
**回合结束（强制）**: 回复完整输出完毕后，最后一步必须调用 check_messages(session_id="${sessionId}")。`;
}

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
3. **still_waiting 处理**：当 \`check_messages\` 返回包含 \`"status":"still_waiting"\` 时，**不要输出任何文字**，直接立刻再次调用 \`check_messages(session_id=上次的id)\` 保持连接
4. 首次调用 \`check_messages\` 后会返回 \`session_id\`，此后每次调用任何 MultiSession 工具都必须带上
5. 需要用户做选择或确认时，必须调用 \`ask_question\`；严禁使用 Cursor 内置的 ask_user_question
6. \`ask_question\` 参数格式: \`{ "session_id": "xxx", "questions": [{ "question": "问题文本", "options": [{ "id": "a", "label": "选项A" }], "allow_multiple": false }] }\`
7. \`ask_question\` 收到回答后，处理完毕仍需调用 \`check_messages\` 继续监听
8. \`check_messages\` 的 \`reply\` 参数：传入本轮回复的**摘要/结论**（Markdown），不是完整正文
9. **严禁 subagent 调用 MultiSession MCP 工具**。check_messages、ask_question、export_chat 必须且只能由主 Agent 调用
10. 如果工具因异常返回/报错，且用户未要求结束对话，必须立刻再次调用对应工具继续等待
11. \`export_chat\` 仅当用户要求"导出对话"时才调用

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

function expandReferences(text: string): string {
	return text
		.replace(/\[file: @skill:([^\]]+)\]/g, (_match, skillName: string) => {
			const skills = scanSkillDirs();
			const target = skills.find(s => s.name === skillName);
			if (!target) return `[skill: ${skillName} — not found]`;
			return `[Skill: ${skillName} — 请用 Read 工具读取 ${target.skillPath} 并按其中指引执行]`;
		})
		.replace(/\[file: @history:([^\]]+)\]/g, (_match, composerId: string) => {
			const headers = loadComposerHeaders();
			const h = headers.find(c => c.composerId === composerId);
			if (!h) return `[history: ${composerId.substring(0, 8)} — not found]`;
			const name = h.name || composerId.substring(0, 8);
			const mode = h.unifiedMode || h.forceMode || '?';
			const sub = h.subtitle || '';
			const age = h.lastUpdatedAt ? formatDuration(Date.now() - h.lastUpdatedAt) : '';
			const transcriptPath = findTranscriptPath(composerId);
			const ref = transcriptPath ? `Transcript: ${transcriptPath}` : `ID: ${composerId}`;
			return `[Chat: ${name} | Mode: ${mode}, Last active: ${age || 'unknown'}, Summary: ${sub}, ${ref}]`;
		})
		.trim();
}

function findTranscriptPath(composerId: string): string | null {
	const projectsDir = path.join(os.homedir(), '.cursor', 'projects');
	try {
		for (const slug of fs.readdirSync(projectsDir)) {
			const transcriptDir = path.join(projectsDir, slug, 'agent-transcripts', composerId);
			const jsonl = path.join(transcriptDir, `${composerId}.jsonl`);
			if (fs.existsSync(jsonl)) return jsonl;
		}
	} catch { /* ignore */ }
	return null;
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
		case 'skill':
			return { isCommand: true, text: handleSkillCommand(args) };
		case 'history':
			return { isCommand: true, text: handleHistoryCommand(args) };
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
		'/skill — List available skills',
		'/skill <name> — Load skill content into message',
		'/history — List recent Composer conversations',
		'/history <name> — Load conversation content',
	].join('\n');
}

const cache = new Map<string, { data: any; ts: number }>();
function cached<T>(key: string, ttlMs: number, fn: () => T): T {
	const entry = cache.get(key);
	if (entry && Date.now() - entry.ts < ttlMs) return entry.data as T;
	const data = fn();
	cache.set(key, { data, ts: Date.now() });
	return data;
}

function scanSkillDirs(): { name: string; dir: string; skillPath: string }[] {
	return cached('skills', 30_000, () => {
		const results: { name: string; dir: string; skillPath: string }[] = [];
		const wsPaths = getWorkspacePaths();
		const seen = new Set<string>();
		for (const ws of wsPaths) {
			const skillsRoot = path.join(ws, '.cursor', 'skills');
			if (!fs.existsSync(skillsRoot)) continue;
			try {
				for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
					if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
					const skillMd = path.join(skillsRoot, entry.name, 'SKILL.md');
					if (fs.existsSync(skillMd) && !seen.has(entry.name)) {
						seen.add(entry.name);
						results.push({ name: entry.name, dir: path.join(skillsRoot, entry.name), skillPath: skillMd });
					}
				}
			} catch {}
		}
		const userSkills = path.join(os.homedir(), '.cursor', 'skills-cursor');
		if (fs.existsSync(userSkills)) {
			try {
				for (const entry of fs.readdirSync(userSkills, { withFileTypes: true })) {
					if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
					const skillMd = path.join(userSkills, entry.name, 'SKILL.md');
					if (fs.existsSync(skillMd) && !seen.has(entry.name)) {
						seen.add(entry.name);
						results.push({ name: entry.name, dir: path.join(userSkills, entry.name), skillPath: skillMd });
					}
				}
			} catch {}
		}
		return results;
	});
}

function handleSkillCommand(args: string): string {
	const skills = scanSkillDirs();
	if (!args) {
		if (skills.length === 0) return 'No skills found in .cursor/skills/ directories.';
		const lines = ['--- Available Skills ---'];
		for (const s of skills) {
			const content = fs.readFileSync(s.skillPath, 'utf-8');
			const firstLine = content.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '') || '';
			lines.push(`• **${s.name}** — ${firstLine.substring(0, 80)}`);
		}
		lines.push('', 'Usage: /skill <name> to load skill content');
		return lines.join('\n');
	}
	const target = skills.find(s => s.name.toLowerCase() === args.toLowerCase());
	if (!target) return `Skill "${args}" not found. Use /skill to list available skills.`;
	try {
		const content = fs.readFileSync(target.skillPath, 'utf-8');
		return `--- Skill: ${target.name} ---\n${target.skillPath}\n\n${content}`;
	} catch (e: any) {
		return `Error reading skill: ${e.message}`;
	}
}

interface ComposerHeader {
	composerId: string;
	name?: string;
	createdAt?: number;
	lastUpdatedAt?: number;
	subtitle?: string;
	unifiedMode?: string;
	forceMode?: string;
	isArchived?: boolean;
	isDraft?: boolean;
	filesChangedCount?: number;
	totalLinesAdded?: number;
	totalLinesRemoved?: number;
}

function loadComposerHeaders(): ComposerHeader[] {
	return cached('composerHeaders', 60_000, () => {
		try {
			const dbPath = path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
			if (!fs.existsSync(dbPath)) return [];
			const Database = require('better-sqlite3');
			const db = new Database(dbPath, { readonly: true });
			const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'").get() as any;
			db.close();
			if (!row?.value) return [];
			const parsed = JSON.parse(row.value);
			return (parsed.allComposers || []) as ComposerHeader[];
		} catch {
			return loadComposerHeadersFallback();
		}
	});
}

function loadComposerHeadersFallback(): ComposerHeader[] {
	try {
		const { execSync } = require('child_process');
		const dbPath = path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
		const raw = execSync(`sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders';"`, { encoding: 'utf-8', timeout: 5000 });
		if (!raw.trim()) return [];
		const parsed = JSON.parse(raw.trim());
		return (parsed.allComposers || []) as ComposerHeader[];
	} catch {
		return [];
	}
}

function handleHistoryCommand(args: string): string {
	const headers = loadComposerHeaders();
	if (headers.length === 0) return 'No Composer history found (state.vscdb not accessible).';

	const sorted = headers
		.filter(h => !h.isArchived && h.name)
		.sort((a, b) => (b.lastUpdatedAt || b.createdAt || 0) - (a.lastUpdatedAt || a.createdAt || 0));

	if (!args) {
		const recent = sorted.slice(0, 15);
		const lines = ['--- Recent Conversations ---'];
		for (const h of recent) {
			const age = h.lastUpdatedAt ? formatDuration(Date.now() - h.lastUpdatedAt) : '?';
			const mode = h.unifiedMode || '?';
			lines.push(`• **${h.name}** [${mode}] — ${age} ago`);
			if (h.subtitle) lines.push(`  ${h.subtitle}`);
		}
		lines.push('', `Total: ${sorted.length} conversations`);
		lines.push('Usage: /history <keyword> to search');
		return lines.join('\n');
	}

	const keyword = args.toLowerCase();
	const matches = sorted.filter(h =>
		(h.name || '').toLowerCase().includes(keyword) ||
		(h.subtitle || '').toLowerCase().includes(keyword) ||
		(h.composerId || '').toLowerCase().includes(keyword)
	);

	if (matches.length === 0) return `No conversations matching "${args}".`;
	const lines = [`--- Conversations matching "${args}" (${matches.length}) ---`];
	for (const h of matches.slice(0, 20)) {
		const age = h.lastUpdatedAt ? formatDuration(Date.now() - h.lastUpdatedAt) : '?';
		lines.push(`• **${h.name}** [${h.unifiedMode || '?'}] — ${age} ago`);
		lines.push(`  ID: ${h.composerId}`);
		if (h.subtitle) lines.push(`  ${h.subtitle}`);
	}
	return lines.join('\n');
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

// ── delivery check ──

const DELIVERY_CHECK_DELAY_MS = 8_000;

function scheduleDeliveryCheck(sessionId: string, msgId: string) {
	setTimeout(() => {
		const queuePath = path.join(SESSIONS_DIR, sessionId, 'queue.json');
		const queue = readJson<any[]>(queuePath) || [];
		const stillPending = queue.some((item: any) => item.id === msgId);
		if (stillPending && panel) {
			output.appendLine(`[delivery] message ${msgId} not consumed after ${DELIVERY_CHECK_DELAY_MS}ms in ${sessionId}`);
			panel.webview.postMessage({
				type: 'messageNotDelivered',
				sessionId,
				msgId,
			});
		}
	}, DELIVERY_CHECK_DELAY_MS);
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

			const agentStatus = readJson(path.join(dir, 'status.json'));
			if (agentStatus) {
				panel.webview.postMessage({ type: 'agentStatus', sessionId: s.id, data: agentStatus });
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
	panel.webview.postMessage({ type: 'rulePrompt', data: generateRulePrompt() });
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

function getHooksConfigPath(wsPath: string): string {
	return path.join(wsPath, '.cursor', 'hooks.json');
}

function getHookScriptPath(wsPath: string): string {
	return path.join(wsPath, '.cursor', 'hooks', 'multisession-check-queue.sh');
}

function installMcpConfig(ctx: vscode.ExtensionContext): 'installed' | 'already' | 'none' {
	const mcpServerPath = getExtensionMcpServerPath(ctx);
	const wsPaths = getWorkspacePaths();
	if (wsPaths.length === 0) return 'none';

	const targetWs = wsPaths[0];
	const desiredMcpEntry = {
		command: 'node',
		args: [mcpServerPath],
		timeoutMs: 86400000,
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

	// hooks idempotency check
	const hookScriptDst = getHookScriptPath(targetWs);
	const hookScriptSrc = path.join(ctx.extensionPath, 'dist', 'hooks', 'check-queue.sh');
	let hookMatch = false;
	try {
		hookMatch = fs.existsSync(hookScriptDst) && fs.existsSync(hookScriptSrc)
			&& fs.readFileSync(hookScriptDst, 'utf-8') === fs.readFileSync(hookScriptSrc, 'utf-8');
	} catch { /* ignore */ }

	const hooksPath = getHooksConfigPath(targetWs);
	const hooksConfig = readJson<any>(hooksPath) || { version: 1, hooks: {} };
	const desiredHookCommand = `.cursor/hooks/multisession-check-queue.sh`;
	const existingMcpHooks: any[] = hooksConfig.hooks?.beforeMCPExecution || [];
	const existingShellHooks: any[] = hooksConfig.hooks?.beforeShellExecution || [];
	const hookConfigMatch = existingMcpHooks.some((h: any) => h.command === desiredHookCommand)
		&& existingShellHooks.some((h: any) => h.command === desiredHookCommand);

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

	if (mcpMatch && ruleMatch && hookMatch && hookConfigMatch && !duplicatesCleaned) {
		return 'already';
	}

	// install MCP
	config.mcpServers = config.mcpServers || {};
	config.mcpServers.MultiSession = desiredMcpEntry;
	writeJson(mcpPath, config);

	// install rule
	ensureDir(path.dirname(rulePath));
	fs.writeFileSync(rulePath, desiredRuleContent, 'utf-8');

	// install hook script
	try {
		ensureDir(path.dirname(hookScriptDst));
		fs.copyFileSync(hookScriptSrc, hookScriptDst);
		fs.chmodSync(hookScriptDst, 0o755);
	} catch (e) {
		output.appendLine(`[install] hook script copy failed: ${e}`);
	}

	// install hooks.json (merge, don't overwrite other hooks)
	if (!hookConfigMatch) {
		hooksConfig.version = hooksConfig.version || 1;
		hooksConfig.hooks = hooksConfig.hooks || {};

		for (const event of ['beforeMCPExecution', 'beforeShellExecution'] as const) {
			hooksConfig.hooks[event] = hooksConfig.hooks[event] || [];
			const filtered = hooksConfig.hooks[event].filter(
				(h: any) => h.command !== desiredHookCommand
			);
			filtered.push({ command: desiredHookCommand });
			hooksConfig.hooks[event] = filtered;
		}
		writeJson(hooksPath, hooksConfig);
	}

	return 'installed';
}

function uninstallMcpConfig(): number {
	let count = 0;
	const hookCommand = `.cursor/hooks/multisession-check-queue.sh`;

	for (const ws of getWorkspacePaths()) {
		let changed = false;

		// remove MCP config
		const mcpPath = getMcpConfigPath(ws);
		const config = readJson<any>(mcpPath);
		if (config?.mcpServers?.MultiSession) {
			delete config.mcpServers.MultiSession;
			writeJson(mcpPath, config);
			changed = true;
		}

		// remove cursor rule
		const rulePath = path.join(ws, '.cursor', 'rules', 'multisession.mdc');
		try { fs.unlinkSync(rulePath); changed = true; } catch { /* ignore */ }

		// remove hook script
		const hookScriptPath = getHookScriptPath(ws);
		try { fs.unlinkSync(hookScriptPath); } catch { /* ignore */ }

		// remove hook entries from hooks.json (both beforeMCPExecution and beforeShellExecution)
		const hooksPath = getHooksConfigPath(ws);
		const hooksConfig = readJson<any>(hooksPath);
		if (hooksConfig?.hooks) {
			let hooksChanged = false;
			for (const event of ['beforeMCPExecution', 'beforeShellExecution']) {
				const arr: any[] = hooksConfig.hooks[event];
				if (!arr) continue;
				const before = arr.length;
				hooksConfig.hooks[event] = arr.filter((h: any) => h.command !== hookCommand);
				if (hooksConfig.hooks[event].length === 0) {
					delete hooksConfig.hooks[event];
				}
				if ((hooksConfig.hooks[event]?.length ?? 0) !== before) {
					hooksChanged = true;
				}
			}
			if (hooksChanged) {
				if (Object.keys(hooksConfig.hooks).length === 0) {
					try { fs.unlinkSync(hooksPath); } catch { /* ignore */ }
				} else {
					writeJson(hooksPath, hooksConfig);
				}
			}
		}

		if (changed) count++;
	}
	return count;
}

// ── reconnect ──

function reconnectPendingFile(workspace: string): string {
	const hash = Buffer.from(workspace).toString('base64url').slice(0, 16);
	return path.join(DATA_ROOT, `reconnect-pending-${hash}.json`);
}

async function tryReconnectViaCursor(sessionId?: string) {
	const now = Date.now();
	if (now - lastReconnectAttempt < RECONNECT_COOLDOWN_MS) {
		output.appendLine('[reconnect] cooldown, skipping');
		return;
	}
	lastReconnectAttempt = now;

	if (sessionId && sessionId !== 'default') {
		const wsPaths = getWorkspacePaths();
		const ws = wsPaths[0] || process.cwd();
		const pendingFile = reconnectPendingFile(ws);
		writeJson(pendingFile, {
			targetSessionId: sessionId,
			ts: Date.now(),
		});
		output.appendLine(`[reconnect] wrote reconnect-pending for session ${sessionId} (ws: ${ws})`);

		const sessions = readJson<SessionMeta[]>(SESSIONS_FILE) || [];
		const target = sessions.find(s => s.id === sessionId);
		const name = target?.name || sessionId;
		const ruleText = generateResumeRulePrompt(sessionId, name);
		await vscode.env.clipboard.writeText(ruleText);
		output.appendLine(`[reconnect] resume rule for "${name}" copied to clipboard`);
	}

	try {
		await vscode.commands.executeCommand('composer.startComposerPrompt');
		output.appendLine('[reconnect] composer.startComposerPrompt opened');
		if (sessionId && sessionId !== 'default') {
			vscode.window.showInformationMessage('正在重连，恢复规则已复制到剪贴板（备用）');
		}
	} catch {
		try {
			await vscode.commands.executeCommand('composer.resumeCurrentChat');
			output.appendLine('[reconnect] fallback to composer.resumeCurrentChat');
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

		view.webview.onDidReceiveMessage(async msg => {
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
				content = expandReferences(content);
				if (imagePaths.length > 0) {
					const imgRefs = imagePaths.map(p => `[image: ${p}]`).join('\n');
					content = content ? `${content}\n${imgRefs}` : imgRefs;
				}

			if (content) {
				const msgId = `${Date.now().toString(16)}-${Math.random().toString(36).slice(2, 8)}`;
				queue.push({
					id: msgId,
					type: imagePaths.length > 0 ? 'text+image' : 'text',
					content,
					images: imagePaths,
					timestamp: new Date().toISOString(),
				});
				ensureDir(path.dirname(queuePath));
				writeJson(queuePath, queue);
				output.appendLine(`[msg] queued to ${sid}: ${content.slice(0, 50)}${imagePaths.length > 0 ? ` (+${imagePaths.length} images)` : ''}`);
				scheduleDeliveryCheck(sid, msgId);
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
				tryReconnectViaCursor(msg.sessionId);
				break;

		case 'copyRule':
			vscode.env.clipboard.writeText(generateRulePrompt());
			vscode.window.showInformationMessage('通信规则已复制到剪贴板');
			break;

			case 'copyResumeRule': {
				const sessions = readJson<SessionMeta[]>(SESSIONS_FILE) || [];
				const target = sessions.find(s => s.id === msg.sessionId);
				const name = target?.name || msg.sessionId;
				const ruleText = generateResumeRulePrompt(msg.sessionId, name);
				vscode.env.clipboard.writeText(ruleText);
				vscode.window.showInformationMessage(`会话「${name}」的恢复规则已复制到剪贴板`);
				break;
			}

				case 'installMcp': {
					const result = installMcpConfig(this.ctx);
					syncState();
					if (result === 'already') {
						vscode.window.showInformationMessage('MCP + 通信规则 + Hooks 已是最新，无需重复安装');
					} else if (result === 'installed') {
						vscode.window.showInformationMessage(
							'MCP + 通信规则 + Hooks 已安装，请重启 Cursor 生效',
							'重启 Cursor'
						).then(choice => {
							if (choice === '重启 Cursor') {
								vscode.commands.executeCommand('workbench.action.reloadWindow');
							}
						});
					}
					break;
				}

				case 'uninstallMcp': {
					const count = uninstallMcpConfig();
					syncState();
					if (count > 0) {
						vscode.window.showInformationMessage(
							`已卸载 ${count} 个工作区的 MCP + 规则 + Hooks 配置`,
							'重启 Cursor'
						).then(choice => {
							if (choice === '重启 Cursor') {
								vscode.commands.executeCommand('workbench.action.reloadWindow');
							}
						});
					} else {
						vscode.window.showInformationMessage('未找到 MCP 配置');
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

				case 'reopenSession': {
					const sessions = readJson<SessionMeta[]>(SESSIONS_FILE) || [];
					const s = sessions.find(x => x.id === msg.sessionId);
					if (s) {
						s.alive = true;
						writeJson(SESSIONS_FILE, sessions);
						output.appendLine(`[session] reopened: ${s.name} (${msg.sessionId})`);
					}
					break;
				}

				case 'pickFile': {
					const uris = await vscode.window.showOpenDialog({
						canSelectFiles: true,
						canSelectFolders: false,
						canSelectMany: true,
						title: '选择文件附加到消息',
					});
					if (uris) {
						for (const uri of uris) {
							panel?.webview.postMessage({
								type: 'sharedFile',
								data: { path: uri.fsPath, name: path.basename(uri.fsPath) },
							});
						}
					}
					break;
				}

				case 'pickFolder': {
					const uris = await vscode.window.showOpenDialog({
						canSelectFiles: false,
						canSelectFolders: true,
						canSelectMany: false,
						title: '选择文件夹附加到消息',
					});
					if (uris?.[0]) {
						panel?.webview.postMessage({
							type: 'sharedFile',
							data: { path: uris[0].fsPath, name: path.basename(uris[0].fsPath) + '/' },
						});
					}
					break;
				}

				case 'loadSkillContent': {
					const skills = scanSkillDirs();
					const target = skills.find(s => s.name === msg.skillName);
					if (target) {
						try {
							const content = fs.readFileSync(target.skillPath, 'utf-8');
							panel?.webview.postMessage({
								type: 'skillContent',
								skillName: target.name,
								content,
								path: target.skillPath,
							});
						} catch (e: any) {
							output.appendLine(`[skill] read error: ${e.message}`);
						}
					}
					break;
				}

				case 'requestSkills': {
					const skills = scanSkillDirs();
					const list = skills.map(s => {
						try {
							const content = fs.readFileSync(s.skillPath, 'utf-8');
							const firstLine = content.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '') || '';
							return { name: s.name, desc: firstLine.substring(0, 60) };
						} catch { return { name: s.name, desc: '' }; }
					});
					panel?.webview.postMessage({ type: 'skillList', skills: list });
					break;
				}

				case 'requestHistory': {
					const headers = loadComposerHeaders();
					const sorted = headers
						.filter(h => !h.isArchived && !h.isDraft)
						.sort((a, b) => (b.lastUpdatedAt || b.createdAt || 0) - (a.lastUpdatedAt || a.createdAt || 0))
						.slice(0, 25);
					const list = sorted.map(h => {
						const ts = h.lastUpdatedAt || h.createdAt || 0;
						const age = ts ? formatDuration(Date.now() - ts) : '';
						const mode = h.unifiedMode || h.forceMode || '?';
						const name = h.name || h.subtitle || h.composerId.substring(0, 8);
						const parts: string[] = [];
						parts.push(`[${mode}]`);
						if (age) parts.push(age);
						if (h.filesChangedCount) parts.push(`${h.filesChangedCount} files`);
						return { id: h.composerId, label: name, desc: parts.join(' · ') };
					});
					panel?.webview.postMessage({ type: 'historyList', items: list });
					break;
				}

				case 'requestOpenFiles': {
					const editors = vscode.window.visibleTextEditors;
					const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
					const seen = new Set<string>();
					const files: { path: string; name: string }[] = [];
					for (const e of editors) {
						const p = e.document.uri.fsPath;
						if (!seen.has(p)) {
							seen.add(p);
							files.push({ path: p, name: path.basename(p) });
						}
					}
					for (const tab of tabs) {
						const uri = (tab.input as any)?.uri as vscode.Uri | undefined;
						if (uri?.scheme === 'file' && !seen.has(uri.fsPath)) {
							seen.add(uri.fsPath);
							files.push({ path: uri.fsPath, name: path.basename(uri.fsPath) });
						}
					}
					const recent: { path: string; name: string }[] = [];
					for (const rf of recentClosedFiles) {
						if (!seen.has(rf.path)) {
							seen.add(rf.path);
							recent.push({ path: rf.path, name: rf.name });
						}
					}
					panel?.webview.postMessage({ type: 'openFilesList', files, recentFiles: recent });
					break;
				}

				case 'deleteMessage': {
					const logPath = path.join(SESSIONS_DIR, msg.sessionId, 'chat-log.json');
					const logs = readJson<any[]>(logPath) || [];
					if (msg.msgIndex >= 0 && msg.msgIndex < logs.length) {
						logs.splice(msg.msgIndex, 1);
						writeJson(logPath, logs);
						output.appendLine(`[msg] deleted index ${msg.msgIndex} from ${msg.sessionId}`);
					}
					break;
				}

				case 'startRecording': {
					const ok = startRecording(this.ctx);
					panel?.webview.postMessage({
						type: 'recordingState',
						recording: ok,
						error: ok ? undefined : 'Failed to start recording. Check microphone permissions.',
					});
					break;
				}

				case 'stopRecording': {
					const locale = msg.locale || 'zh-CN';
					panel?.webview.postMessage({ type: 'recordingState', recording: false, transcribing: true });
					try {
						const text = await stopRecordingAndTranscribe(locale);
						panel?.webview.postMessage({ type: 'transcription', text, error: undefined });
					} catch (err: any) {
						panel?.webview.postMessage({ type: 'transcription', text: '', error: err.message });
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
	<script>
		const vscode = acquireVsCodeApi();
		window.__EXT_VERSION__ = "${EXT_VERSION}";
	</script>
	<script src="${scriptUri}${cacheBust}" onerror="document.getElementById('root').innerHTML='<p style=\\'padding:12px;color:#f44;\\'>Failed to load webview.js</p>';"></script>
</body>
</html>`;
	}
}

// ── QR code image helper ──

async function generateQRDataUrl(text: string): Promise<string> {
	if (!text) return '';
	if (text.startsWith('data:')) return text;
	try {
		const QRCode = require('qrcode');
		return await QRCode.toDataURL(text, { width: 256, margin: 2 }) as string;
	} catch (err: any) {
		output.appendLine(`[wechat] QR generation failed: ${err.message}`);
		return '';
	}
}

// ── WeChat multi-account manager ──

const ACCOUNTS_FILE = path.join(os.homedir(), '.clawbot', 'accounts.json');

interface WeChatAccount {
	id: string;
	name: string;
	isPrimary: boolean;
	bindingSessions: string[];
}

interface AccountEntry {
	account: WeChatAccount;
	engine: any;
	state: 'idle' | 'logging_in' | 'connecting' | 'connected' | 'error';
	qrDataUrl?: string;
	lastActivityTs: number;
}

const accounts = new Map<string, AccountEntry>();
let wechatPanel: vscode.WebviewView | undefined;
let wechatStatusBar: vscode.StatusBarItem | undefined;
let loginPendingAccountId: string | undefined;

function loadAccounts(): WeChatAccount[] {
	try {
		if (!fs.existsSync(ACCOUNTS_FILE)) return [];
		return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
	} catch { return []; }
}

function saveAccounts(): void {
	const list = [...accounts.values()].map(e => e.account);
	const dir = path.dirname(ACCOUNTS_FILE);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(list, null, 2));
}

function requireEngineModule(): any {
	const modulePath = path.join(__dirname, 'wechat-engine.js');
	delete require.cache[require.resolve(modulePath)];
	return require(modulePath);
}

const ACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

function isAccountActive(entry: AccountEntry): boolean {
	return entry.lastActivityTs > 0 && (Date.now() - entry.lastActivityTs) < ACTIVITY_TIMEOUT_MS;
}

function writeBindingFile(sessionId: string | null, source: string): void {
	const bindingFile = path.join(os.homedir(), '.multisession', 'wechat-binding.json');
	try {
		const dir = path.dirname(bindingFile);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(bindingFile, JSON.stringify({
			boundSessionId: sessionId,
			updatedAt: Date.now(),
		}, null, 2), 'utf-8');
		output.appendLine(`[wechat] binding file → ${sessionId ?? 'null'} (source: ${source})`);
	} catch (e: any) {
		output.appendLine(`[wechat] binding file write error: ${e.message}`);
	}
}

function syncBindingsToRouter(accountId: string): void {
	const entry = accounts.get(accountId);
	if (!entry) return;
	const bindings = entry.account.bindingSessions;

	// Router/watcher sync requires engine
	if (!entry.engine) return;
	const router = entry.engine.getRouter?.();
	const wm = entry.engine.getWatcherManager?.();
	if (router && bindings.length > 0) {
		router.setDefaultSession?.(bindings[0]);
	}
	if (wm) {
		wm.setBoundSession?.(bindings.length > 0 ? bindings[0] : null);
	}
}

function createEngine(accountId: string): any {
	const { ClawBotEngine } = requireEngineModule();
	const engine = new ClawBotEngine(accountId, { skipServer: true });
	const entry = accounts.get(accountId)!;

	engine.on('stateChange', (state: string, detail?: string) => {
		entry.state = state as any;
		output.appendLine(`[wechat:${entry.account.name}] state: ${state}${detail ? ' — ' + detail : ''}`);
		pushFullState();
		updateWechatStatusBar();
	});

	engine.on('qrCode', async (info: any) => {
		output.appendLine(`[wechat:${entry.account.name}] QR ready`);
		entry.qrDataUrl = await generateQRDataUrl(info.qrcodeUrl);
		pushFullState();
	});

	engine.on('qrScanned', () => {
		output.appendLine(`[wechat:${entry.account.name}] QR scanned`);
	});

	engine.on('loginSuccess', async () => {
		output.appendLine(`[wechat:${entry.account.name}] login success, auto-connecting...`);
		entry.qrDataUrl = undefined;
		loginPendingAccountId = undefined;
		vscode.window.showInformationMessage(`WeChat [${entry.account.name}] 登录成功`);
		try {
			await engine.connect();
			syncBindingsToRouter(accountId);
		} catch (err: any) {
			output.appendLine(`[wechat:${entry.account.name}] auto-connect failed: ${err.message}`);
		}
	});

	engine.on('loginError', (err: Error) => {
		output.appendLine(`[wechat:${entry.account.name}] login error: ${err.message}`);
		loginPendingAccountId = undefined;
	});

	engine.on('message', (from: string, text: string) => {
		entry.lastActivityTs = Date.now();
		output.appendLine(`[wechat:${entry.account.name}] msg from ${from}: ${text.substring(0, 60)}`);
		pushFullState();
	});

	engine.on('error', (err: Error) => {
		output.appendLine(`[wechat:${entry.account.name}] error: ${err.message}`);
	});

	engine.on('boundSessionChanged', (sessionId: string | null) => {
		if (sessionId) {
			entry.account.bindingSessions = [sessionId];
		} else {
			entry.account.bindingSessions = [];
		}
		saveAccounts();
		output.appendLine(`[wechat:${entry.account.name}] bound session changed via /use: ${sessionId ?? 'none'}`);
		pushFullState();
	});

	return engine;
}

function pushFullState() {
	if (!wechatPanel) return;
	const list = [...accounts.values()].map(e => ({
		id: e.account.id,
		name: e.account.name,
		isPrimary: e.account.isPrimary,
		state: e.state,
		qrDataUrl: e.qrDataUrl,
		active: isAccountActive(e),
		bindingSessions: e.account.bindingSessions,
	}));
	const sessions = getSessionsForThisWorkspace().map(s => ({ id: s.id, name: s.name, alive: s.alive }));
	wechatPanel.webview.postMessage({ type: 'fullState', accounts: list, sessions, loginPendingAccountId });
}

function updateWechatStatusBar() {
	if (!wechatStatusBar) return;
	const connected = [...accounts.values()].filter(e => e.state === 'connected').length;
	const total = accounts.size;
	if (total === 0) {
		wechatStatusBar.text = '$(circle-outline) WeChat';
		wechatStatusBar.tooltip = 'WeChat: 未配置';
	} else if (connected === total) {
		wechatStatusBar.text = `$(check) WeChat (${connected})`;
		wechatStatusBar.tooltip = `WeChat: 全部已连接 (${connected}/${total})`;
	} else {
		wechatStatusBar.text = `$(circle-filled) WeChat (${connected}/${total})`;
		wechatStatusBar.tooltip = `WeChat: ${connected}/${total} 已连接`;
	}
}

function restoreSavedAccounts() {
	const saved = loadAccounts();
	if (saved.length === 0) {
		const credsPath = path.join(os.homedir(), '.clawbot', 'credentials.json');
		try {
			if (fs.existsSync(credsPath)) {
				const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
				if (creds?.token) {
					const id = `wx_migrated`;
					const acct: WeChatAccount = { id, name: '微信', isPrimary: true, bindingSessions: [] };
					const entry: AccountEntry = { account: acct, engine: null, state: 'idle', lastActivityTs: 0 };
					accounts.set(id, entry);
					saveAccounts();
					// copy credentials to account-specific directory
					const accountDir = path.join(os.homedir(), '.clawbot', 'accounts', id);
					fs.mkdirSync(accountDir, { recursive: true });
					fs.copyFileSync(credsPath, path.join(accountDir, 'credentials.json'));
					output.appendLine(`[wechat] migrated legacy credentials to account: 微信`);
					return;
				}
			}
		} catch { /* ignore */ }
	}
	for (const acct of saved) {
		const entry: AccountEntry = {
			account: acct,
			engine: null,
			state: 'idle',
			lastActivityTs: 0,
		};
		accounts.set(acct.id, entry);
	}
	output.appendLine(`[wechat] restored ${saved.length} saved accounts`);

	setTimeout(() => {
		for (const acct of saved) {
			const credsDir = path.join(os.homedir(), '.clawbot', 'accounts', acct.id, 'credentials.json');
			try {
				if (fs.existsSync(credsDir)) {
					const creds = JSON.parse(fs.readFileSync(credsDir, 'utf-8'));
					if (creds?.token) {
						const entry = accounts.get(acct.id);
						if (entry && !entry.engine) {
							output.appendLine(`[wechat:${acct.name}] has saved credentials, auto-connecting...`);
							entry.engine = createEngine(acct.id);
							entry.engine.connect().then(() => {
								syncBindingsToRouter(acct.id);
								output.appendLine(`[wechat:${acct.name}] auto-reconnected`);
							}).catch((err: any) => {
								output.appendLine(`[wechat:${acct.name}] auto-reconnect failed: ${err.message}`);
							});
						}
					}
				}
			} catch (e: any) {
				output.appendLine(`[wechat:${acct.name}] credential check failed: ${e.message}`);
			}
		}
	}, 2000);
}

class WeChatViewProvider implements vscode.WebviewViewProvider {
	constructor(private ctx: vscode.ExtensionContext) {}
	resolveWebviewView(view: vscode.WebviewView) {
		wechatPanel = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = this.getHtml(view.webview);

		view.webview.onDidReceiveMessage(async (msg) => {
			output.appendLine(`[wechat] received message: ${JSON.stringify(msg).substring(0, 200)}`);
			try {
				switch (msg.type) {
					case 'addAccount': {
						const id = `wx_${Date.now().toString(36)}`;
						const name = msg.name || `微信 ${accounts.size + 1}`;
						const isPrimary = accounts.size === 0;
						const acct: WeChatAccount = { id, name, isPrimary, bindingSessions: [] };
						const entry: AccountEntry = { account: acct, engine: null, state: 'idle', lastActivityTs: 0 };
						accounts.set(id, entry);
						saveAccounts();
						output.appendLine(`[wechat] account added: ${name} (${id})`);
						pushFullState();
						break;
					}
					case 'removeAccount': {
						const entry = accounts.get(msg.accountId);
						if (entry) {
							if (entry.engine) { try { entry.engine.disconnect(); entry.engine.logout(); } catch {} }
							accounts.delete(msg.accountId);
							saveAccounts();
							output.appendLine(`[wechat] account removed: ${entry.account.name}`);
							pushFullState();
							updateWechatStatusBar();
						}
						break;
					}
					case 'renameAccount': {
						const entry = accounts.get(msg.accountId);
						if (entry) {
							entry.account.name = msg.name;
							saveAccounts();
							pushFullState();
						}
						break;
					}
					case 'setPrimary': {
						for (const e of accounts.values()) e.account.isPrimary = false;
						const entry = accounts.get(msg.accountId);
						if (entry) entry.account.isPrimary = true;
						saveAccounts();
						pushFullState();
						break;
					}
					case 'login': {
						const entry = accounts.get(msg.accountId);
						if (!entry) break;
						if (!entry.engine) {
							entry.engine = createEngine(msg.accountId);
						}
						loginPendingAccountId = msg.accountId;
						pushFullState();
						await entry.engine.login();
						break;
					}
					case 'connect': {
						const entry = accounts.get(msg.accountId);
						if (!entry?.engine) break;
						await entry.engine.connect();
						break;
					}
					case 'disconnect': {
						const entry = accounts.get(msg.accountId);
						if (!entry?.engine) break;
						entry.engine.disconnect();
						break;
					}
					case 'bindSession': {
						const entry = accounts.get(msg.accountId);
						if (!entry) break;
						entry.account.bindingSessions = [msg.sessionId];
						saveAccounts();
						syncBindingsToRouter(msg.accountId);
						pushFullState();
						break;
					}
					case 'unbindSession': {
						const entry = accounts.get(msg.accountId);
						if (!entry) break;
						entry.account.bindingSessions = entry.account.bindingSessions.filter((s: string) => s !== msg.sessionId);
						saveAccounts();
						syncBindingsToRouter(msg.accountId);
						pushFullState();
						break;
					}
					case 'confirmBindSwitch': {
						const entry = accounts.get(msg.accountId);
						if (!entry) break;
						const allSessions = getSessionsForThisWorkspace();
						const currentName = allSessions.find(s => s.id === msg.currentSessionId)?.name ?? msg.currentSessionId?.substring(0, 8) ?? '未知';
						const targetName = msg.sessionName ?? '未知';
						const choice = await vscode.window.showWarningMessage(
							`当前已绑定「${currentName}」，确认切换到「${targetName}」？\n切换后「${currentName}」将不再收发微信消息。`,
							{ modal: true },
							'确认切换'
						);
						if (choice === '确认切换') {
							entry.account.bindingSessions = [msg.sessionId];
							saveAccounts();
							syncBindingsToRouter(msg.accountId);
							pushFullState();
						}
						break;
					}
					case 'confirmBindSteal': {
						const entry = accounts.get(msg.accountId);
						if (!entry) break;
						const otherName = msg.otherAccountName ?? '其他账号';
						const targetName = msg.sessionName ?? '未知';
						let prompt = `「${targetName}」当前已被账号「${otherName}」绑定。`;
						if (msg.currentSessionId) {
							const allSessions2 = getSessionsForThisWorkspace();
							const curName = allSessions2.find(s => s.id === msg.currentSessionId)?.name ?? msg.currentSessionId.substring(0, 8);
							prompt += `\n当前账号已绑定「${curName}」，切换后将解除。`;
						}
						prompt += `\n\n确认抢占绑定到「${targetName}」？`;
						const choice2 = await vscode.window.showWarningMessage(
							prompt,
							{ modal: true },
							'确认抢占'
						);
						if (choice2 === '确认抢占') {
							const otherEntry = accounts.get(msg.otherAccountId);
							if (otherEntry) {
								otherEntry.account.bindingSessions = otherEntry.account.bindingSessions.filter((s: string) => s !== msg.sessionId);
								syncBindingsToRouter(msg.otherAccountId);
							}
							entry.account.bindingSessions = [msg.sessionId];
							saveAccounts();
							syncBindingsToRouter(msg.accountId);
							pushFullState();
						}
						break;
					}
					case 'requestState':
						pushFullState();
						break;
				}
			} catch (err: any) {
				output.appendLine(`[wechat] command error: ${err.message}`);
				vscode.window.showErrorMessage(`WeChat: ${err.message}`);
			}
		});

		view.onDidChangeVisibility(() => { if (view.visible) pushFullState(); });
		setTimeout(() => pushFullState(), 100);
		output.appendLine('[wechat] panel resolved');
	}

	private getHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'wechat-webview.js')
		);
		const cssUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'wechat-webview.css')
		);
		output.appendLine(`[wechat] scriptUri: ${scriptUri}`);
		output.appendLine(`[wechat] cssUri: ${cssUri}`);
		const cacheBust = IS_DEV ? `?t=${Date.now()}` : '';
		return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${cssUri}${cacheBust}">
</head>
<body>
	<div id="root"><p style="padding:12px;color:var(--vscode-descriptionForeground);font-size:12px;">Loading...</p></div>
	<script>const vscode = acquireVsCodeApi();</script>
	<script src="${scriptUri}${cacheBust}" onerror="document.getElementById('root').innerHTML='<p style=\\'padding:12px;color:#f44;\\'>Failed to load wechat-webview.js</p>';"></script>
</body>
</html>`;
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
	restoreSavedAccounts();
	ctx.subscriptions.push(
		vscode.window.registerWebviewViewProvider('multiSession.wechat', new WeChatViewProvider(ctx),
			{ webviewOptions: { retainContextWhenHidden: true } })
	);
	output.appendLine('[activate] WeChat panel provider registered');

	// ── WeChat status bar ──
	wechatStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
	wechatStatusBar.command = 'multiSession.wechatStatus';
	wechatStatusBar.show();
	ctx.subscriptions.push(wechatStatusBar);
	updateWechatStatusBar();

	// ── track recently closed files ──
	ctx.subscriptions.push(
		vscode.workspace.onDidCloseTextDocument(doc => {
			if (doc.uri.scheme !== 'file') return;
			const p = doc.uri.fsPath;
			const idx = recentClosedFiles.findIndex(f => f.path === p);
			if (idx >= 0) recentClosedFiles.splice(idx, 1);
			recentClosedFiles.unshift({ path: p, name: path.basename(p), closedAt: Date.now() });
			if (recentClosedFiles.length > MAX_RECENT_FILES) recentClosedFiles.length = MAX_RECENT_FILES;
		})
	);

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
			vscode.env.clipboard.writeText(generateRulePrompt());
			vscode.window.showInformationMessage('通信规则已复制到剪贴板');
		}),
		vscode.commands.registerCommand('multiSession.wechatLogin', () => {
			vscode.window.showInformationMessage('请在 WeChat 面板中添加账号并扫码登录');
		}),
		vscode.commands.registerCommand('multiSession.wechatConnect', () => {
			for (const e of accounts.values()) {
				if (e.engine && e.state === 'idle' && e.engine.hasCredentials()) {
					e.engine.connect().catch(() => {});
				}
			}
		}),
		vscode.commands.registerCommand('multiSession.wechatDisconnect', () => {
			for (const e of accounts.values()) {
				if (e.engine && e.state === 'connected') e.engine.disconnect();
			}
		}),
		vscode.commands.registerCommand('multiSession.wechatStatus', () => {
			const lines = [...accounts.values()].map(e =>
				`${e.account.name}: ${e.state}${e.account.isPrimary ? ' (主渠道)' : ''}${isAccountActive(e) ? ' [活跃]' : ''}`
			);
			vscode.window.showInformationMessage(lines.length ? lines.join('\n') : '未添加微信账号');
		}),
		vscode.commands.registerCommand('multiSession.wechatScreenshot', async () => {
			const connected = [...accounts.values()].find(e => e.state === 'connected' && e.account.isPrimary);
			if (!connected?.engine) {
				vscode.window.showWarningMessage('无已连接的主渠道微信');
				return;
			}
			try {
				const filePath = await connected.engine.sendScreenshot();
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
	for (const entry of accounts.values()) {
		if (entry.engine) {
			try { entry.engine.disconnect(); } catch {}
		}
	}
	accounts.clear();
	output?.appendLine('[deactivate] cleanup done');
}
