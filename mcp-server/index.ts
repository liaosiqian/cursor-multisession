import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DATA_ROOT = path.join(os.homedir(), '.multisession');
const SESSIONS_FILE = path.join(DATA_ROOT, 'sessions.json');
const SESSIONS_DIR = path.join(DATA_ROOT, 'sessions');
const ACTIVE_WINDOW_FILE = path.join(DATA_ROOT, 'active-window.json');
const LOG_FILE = path.join(DATA_ROOT, 'multisession.log');

const POLL_INTERVAL_MS = 800;
const HEARTBEAT_INTERVAL_MS = 15_000;
const ORPHAN_THRESHOLD_MS = 30_000;
const SESSION_EXPIRE_DAYS = 7;
const MAX_POLL_DURATION_MS = 25 * 60 * 1000; // 25 min (under 30 min timeout)

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

function log(msg: string) {
	const ts = new Date().toISOString();
	const line = `[${ts}] ${msg}\n`;
	try {
		ensureDir(DATA_ROOT);
		fs.appendFileSync(LOG_FILE, line);
	} catch { /* ignore */ }
}

function genId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── session types ──

interface SessionMeta {
	id: string;
	name: string;
	workspace: string;
	windowToken?: string;
	composerToken?: string;
	alive: boolean;
	createdAt: number;
	lastActiveAt: number;
}

// ── session CRUD ──

function readSessions(): SessionMeta[] {
	return readJson<SessionMeta[]>(SESSIONS_FILE) || [];
}

function writeSessions(sessions: SessionMeta[]) {
	writeJson(SESSIONS_FILE, sessions);
}

function getSessionDir(sid: string): string {
	return path.join(SESSIONS_DIR, sid);
}

function touchSession(sid: string) {
	const sessions = readSessions();
	const s = sessions.find(x => x.id === sid);
	if (s) {
		s.lastActiveAt = Date.now();
		s.alive = true;
		writeSessions(sessions);
	}
}

function getActiveWindowToken(workspace: string): string | null {
	const data = readJson<Record<string, { token: string; timestamp: number }[]>>(ACTIVE_WINDOW_FILE);
	if (!data) return null;
	const entries = data[workspace];
	if (!entries || entries.length === 0) return null;
	entries.sort((a, b) => b.timestamp - a.timestamp);
	return entries[0].token;
}

// ── orphan / session recovery ──

function tryAdoptOrphan(workspace: string, windowToken: string | null, composerToken: string | null): string | null {
	const sessions = readSessions();
	const now = Date.now();

	// Phase 0: exact composerToken match — search ALL sessions (alive or dead) in this workspace
	if (composerToken) {
		const allWsSessions = sessions.filter(s => s.workspace === workspace);
		const composerMatch = allWsSessions.find(s => s.composerToken === composerToken);
		if (composerMatch) {
			if (!composerMatch.alive) {
				composerMatch.alive = true;
				writeSessions(sessions);
				log(`[adopt] revived dead session ${composerMatch.id} (composerToken match, age=${now - composerMatch.lastActiveAt}ms)`);
			} else {
				log(`[adopt] recovered session ${composerMatch.id} (composerToken match, age=${now - composerMatch.lastActiveAt}ms)`);
			}
			return composerMatch.id;
		}
		log(`[adopt] new composerToken ${composerToken}, skipping adoption`);
		return null;
	}

	const wsSessions = sessions.filter(s => s.alive && s.workspace === workspace);
	if (wsSessions.length === 0) return null;

	// Below: legacy path when composerToken is not provided (backward compat)

	// Phase 1: exact windowToken match (handles mode-switch / reconnect — no time threshold)
	if (windowToken) {
		const tokenMatches = wsSessions
			.filter(s => s.windowToken === windowToken)
			.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
		if (tokenMatches.length > 0) {
			log(`[adopt] recovered session ${tokenMatches[0].id} (windowToken match, age=${now - tokenMatches[0].lastActiveAt}ms)`);
			return tokenMatches[0].id;
		}
	}

	// Phase 2: if only one alive session in this workspace, recover it directly (mode-switch fast path)
	if (wsSessions.length === 1) {
		log(`[adopt] recovered session ${wsSessions[0].id} (single session in workspace, age=${now - wsSessions[0].lastActiveAt}ms)`);
		return wsSessions[0].id;
	}

	// Phase 3: classic orphan adoption (no heartbeat for > threshold)
	const orphans = wsSessions
		.filter(s => (now - s.lastActiveAt) > ORPHAN_THRESHOLD_MS)
		.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
	if (orphans.length > 0) {
		log(`[adopt] adopted orphan ${orphans[0].id} (most recent, age=${now - orphans[0].lastActiveAt}ms)`);
		return orphans[0].id;
	}

	return null;
}

// ── session cleanup ──

function cleanupExpiredSessions() {
	const sessions = readSessions();
	const now = Date.now();
	const threshold = SESSION_EXPIRE_DAYS * 24 * 60 * 60 * 1000;
	const kept: SessionMeta[] = [];
	for (const s of sessions) {
		if (!s.alive && (now - s.lastActiveAt) > threshold) {
			const dir = getSessionDir(s.id);
			try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
			log(`[cleanup] removed expired session ${s.id}`);
		} else {
			kept.push(s);
		}
	}
	if (kept.length !== sessions.length) {
		writeSessions(kept);
	}
}

// ── default queue migration ──

function migrateDefaultQueue(sid: string) {
	const defaultQueuePath = path.join(SESSIONS_DIR, 'default', 'queue.json');
	const defaultQueue = readJson<any[]>(defaultQueuePath);
	if (!defaultQueue || defaultQueue.length === 0) return;

	const sessionQueuePath = path.join(getSessionDir(sid), 'queue.json');
	const sessionQueue = readJson<any[]>(sessionQueuePath) || [];
	sessionQueue.push(...defaultQueue);
	writeJson(sessionQueuePath, sessionQueue);
	writeJson(defaultQueuePath, []);
	log(`[migrate] moved ${defaultQueue.length} messages from default to ${sid}`);
}

// ── MCP server ──

const ENFORCE_SUFFIX = (sid: string) =>
	`\n\n---\n⚠️ **强制指令**：你完成本轮回复后，最后一步 **必须** 调用 check_messages(session_id="${sid}") 继续监听。不调用 = 会话断开，用户无法继续与你交互。`;

const server = new McpServer({
	name: 'MultiSession',
	version: '0.1.0',
});

server.tool(
	'check_messages',
	'从 MultiSession 面板接收用户消息。【强制】每轮回复的最后一步必须调用此工具，否则会话断开、用户无法继续交互。回复 → check_messages → 收到消息 → 回复 → check_messages，永续循环。',
	{
		session_id: z.string().optional().describe('会话 ID。首次调用不传，后续必须携带。'),
		reply: z.string().optional().describe('本轮回复的摘要/结论（Markdown），会在插件界面弹窗展示给用户。无需总结时可省略。'),
		composer_token: z.string().optional().describe('Composer 标识。从通信规则中获取，用于区分不同的 Composer 对话。首次调用时携带，后续可省略。'),
	},
	async (args, extra) => {
		const cwd = process.cwd();
		const windowToken = getActiveWindowToken(cwd);
		let sid = args.session_id as string | undefined;
		const reply = args.reply as string | undefined;
		const composerToken = args.composer_token as string | undefined;

		// first call: try adopt or register
		let isRecovered = false;
		if (!sid) {
			sid = tryAdoptOrphan(cwd, windowToken, composerToken || null) ?? undefined;
			if (sid) {
				isRecovered = true;
				// update composerToken on the recovered session if provided
				if (composerToken) {
					const sessions = readSessions();
					const s = sessions.find(x => x.id === sid);
					if (s && s.composerToken !== composerToken) {
						s.composerToken = composerToken;
						writeSessions(sessions);
					}
				}
			} else {
				sid = genId();
				const sessions = readSessions();
				const wsName = path.basename(cwd);
				const num = sessions.filter(s => s.workspace === cwd).length + 1;
				const meta: SessionMeta = {
					id: sid,
					name: `${wsName} #${num}`,
					workspace: cwd,
					windowToken: windowToken || undefined,
					composerToken: composerToken || undefined,
					alive: true,
					createdAt: Date.now(),
					lastActiveAt: Date.now(),
				};
				sessions.push(meta);
				writeSessions(sessions);
				ensureDir(getSessionDir(sid));
				log(`[register] new session ${sid} for ${cwd}${composerToken ? ` (composer=${composerToken})` : ''}`);
			}
			migrateDefaultQueue(sid);
			cleanupExpiredSessions();
		}

		// write reply summary if provided
		if (reply && sid) {
			const summaryPath = path.join(getSessionDir(sid), 'summary.json');
			writeJson(summaryPath, { text: reply, ts: Date.now() });
			// also append to chat-log as AI message
			const logPath = path.join(getSessionDir(sid), 'chat-log.json');
			const logs = readJson<any[]>(logPath) || [];
			logs.push({ role: 'assistant', text: reply, ts: Date.now() });
			writeJson(logPath, logs);
			log(`[reply] ${sid} summary written`);
		}

		// if recovered and queue is empty, immediately tell AI this is a resumed session
		const queuePath = path.join(getSessionDir(sid), 'queue.json');
		if (isRecovered) {
			const existingQueue = readJson<any[]>(queuePath);
			if (!existingQueue || existingQueue.length === 0) {
				touchSession(sid);
				log(`[recover] ${sid} resumed with empty queue, notifying AI`);
				return {
					content: [{
						type: 'text' as const,
						text: `[session_id: ${sid}]\n\n会话已恢复（模式切换/重新连接）。当前无新消息。${ENFORCE_SUFFIX(sid)}`,
					}],
				};
			}
		}

		// long-poll loop
		const deadline = Date.now() + MAX_POLL_DURATION_MS;
		let nextHeartbeat = Date.now() + HEARTBEAT_INTERVAL_MS;

		while (Date.now() < deadline) {
			// check queue
			const queue = readJson<any[]>(queuePath);
			if (queue && queue.length > 0) {
				const urgentIdx = queue.findIndex((m: any) => m.urgent);
				let picked: any;
				let remaining: any[];

				if (urgentIdx >= 0) {
					picked = queue[urgentIdx];
					remaining = [...queue.slice(0, urgentIdx), ...queue.slice(urgentIdx + 1)];
				} else {
					picked = queue[0];
					remaining = queue.slice(1);
				}

				writeJson(queuePath, remaining);

				const logPath = path.join(getSessionDir(sid), 'chat-log.json');
				const logs = readJson<any[]>(logPath) || [];
				logs.push({ role: 'user', text: picked.content || picked.text, ts: picked.timestamp || Date.now() });
				writeJson(logPath, logs);

				touchSession(sid);
				log(`[poll] ${sid} consumed 1 message (${remaining.length} remaining)`);

				const text = picked.content || picked.text;
				const pendingNote = remaining.length > 0
					? `\n（队列中还有 ${remaining.length} 条待处理消息，处理完本条后会继续投递）`
					: '';
				return {
					content: [{
						type: 'text' as const,
						text: `[session_id: ${sid}]\n\n${text}${pendingNote}${ENFORCE_SUFFIX(sid)}`,
					}],
				};
			}

			// heartbeat
			if (Date.now() >= nextHeartbeat) {
				touchSession(sid);
				try {
					// @ts-ignore - progress notification to prevent timeout
					if (extra._meta?.progressToken) {
						await server.server.sendNotification({
							method: 'notifications/progress',
							params: {
								progressToken: (extra._meta as any).progressToken,
								progress: 0,
								total: 1,
							},
						});
					}
				} catch { /* ignore */ }
				nextHeartbeat = Date.now() + HEARTBEAT_INTERVAL_MS;
			}

			await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
		}

		// timeout
		touchSession(sid);
		return {
			content: [{
				type: 'text' as const,
				text: `[session_id: ${sid}]\n\n轮询超时（25 分钟）。${ENFORCE_SUFFIX(sid)}`,
			}],
		};
	}
);

// ── ask_question tool ──

server.tool(
	'ask_question',
	'向用户提问并等待回答。当需要用户做选择或确认时使用（选方案、选框架等）。禁止用于"还有别的需要吗"这类结束语。',
	{
		session_id: z.string().describe('会话 ID，必须携带。'),
		questions: z.array(z.object({
			question: z.string().describe('问题文本'),
			options: z.array(z.object({
				id: z.string(),
				label: z.string(),
			})).describe('选项列表'),
			allow_multiple: z.boolean().optional().describe('是否允许多选，默认 false'),
		})).describe('问题数组，可包含多道题'),
	},
	async (args) => {
		const sid = args.session_id;
		const questions = args.questions;
		if (!sid) {
			return { content: [{ type: 'text' as const, text: '错误：缺少 session_id' }] };
		}

		// write inquiry to file, extension will pick it up and show in webview
		const inquiryPath = path.join(getSessionDir(sid), 'inquiry.json');
		const inquiryId = genId();
		writeJson(inquiryPath, { id: inquiryId, questions, ts: Date.now(), answered: false });
		log(`[inquiry] ${sid} question posted: ${inquiryId}`);

		// poll for answer (also watch queue for new messages that override inquiry)
		const deadline = Date.now() + MAX_POLL_DURATION_MS;
		const queuePath = path.join(getSessionDir(sid), 'queue.json');
		while (Date.now() < deadline) {
			const inquiry = readJson<any>(inquiryPath);
			if (inquiry?.answered && inquiry.id === inquiryId) {
				writeJson(inquiryPath, null);
				touchSession(sid);

				const logPath = path.join(getSessionDir(sid), 'chat-log.json');
				const logs = readJson<any[]>(logPath) || [];
				logs.push({ role: 'inquiry', text: JSON.stringify(questions), ts: inquiry.ts });
				logs.push({ role: 'user', text: JSON.stringify(inquiry.answers), ts: Date.now() });
				writeJson(logPath, logs);

				return {
					content: [{
						type: 'text' as const,
						text: `[session_id: ${sid}]\n\n用户回答：\n${JSON.stringify(inquiry.answers, null, 2)}${ENFORCE_SUFFIX(sid)}`,
					}],
				};
			}

			// if user sent a new message while inquiry is pending, auto-skip the inquiry
			const queue = readJson<any[]>(queuePath);
			if (queue && queue.length > 0) {
				writeJson(inquiryPath, null);
				touchSession(sid);
				log(`[inquiry] ${sid} auto-skipped: user sent new message while inquiry pending`);

				const logPath = path.join(getSessionDir(sid), 'chat-log.json');
				const logs = readJson<any[]>(logPath) || [];
				logs.push({ role: 'inquiry', text: JSON.stringify(questions), ts: Date.now() });
				logs.push({ role: 'system', text: '（用户跳过了问题，发送了新消息）', ts: Date.now() });
				writeJson(logPath, logs);

				return {
					content: [{
						type: 'text' as const,
						text: `[session_id: ${sid}]\n\n用户没有回答问题，而是发送了新消息。请调用 check_messages 获取用户的新消息。${ENFORCE_SUFFIX(sid)}`,
					}],
				};
			}

			touchSession(sid);
			await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
		}

		return {
			content: [{ type: 'text' as const, text: `[session_id: ${sid}]\n\n等待用户回答超时。${ENFORCE_SUFFIX(sid)}` }],
		};
	}
);

// ── export_chat tool ──

server.tool(
	'export_chat',
	'导出当前会话的完整对话记录为 Markdown 格式。包含用户消息和 AI 回复摘要，按时间顺序排列，一问一答清晰展示。',
	{
		session_id: z.string().describe('从 check_messages 获取的会话 ID'),
		save_to_file: z.boolean().optional().describe('是否保存到文件。true 则保存为 .md 文件并返回路径，false 则直接返回内容'),
	},
	async (args) => {
		const sid = args.session_id;
		if (!sid) {
			return { content: [{ type: 'text' as const, text: '错误：缺少 session_id' }] };
		}
		const logPath = path.join(getSessionDir(sid), 'chat-log.json');
		const logs = readJson<any[]>(logPath) || [];
		if (logs.length === 0) {
			return { content: [{ type: 'text' as const, text: `[session_id: ${sid}]\n\n当前会话暂无对话记录。` }] };
		}

		const lines = logs.map((m: any) => {
			const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'AI' : m.role;
			const time = new Date(m.ts).toLocaleString();
			return `### ${role} (${time})\n\n${m.text}`;
		});

		const content = `# 对话记录导出\n\n${lines.join('\n\n---\n\n')}`;

		if (args.save_to_file) {
			const exportPath = path.join(getSessionDir(sid), `export-${Date.now()}.md`);
			fs.writeFileSync(exportPath, content, 'utf-8');
			log(`[export] saved to ${exportPath}`);
			return {
				content: [{
					type: 'text' as const,
					text: `[session_id: ${sid}]\n\n对话记录已导出到: ${exportPath}`,
				}],
			};
		}

		return {
			content: [{
				type: 'text' as const,
				text: `[session_id: ${sid}]\n\n${content}`,
			}],
		};
	}
);

// ── rename_session tool ──

server.tool(
	'rename_session',
	'为当前会话设置一个有意义的名称，该名称会显示在侧边栏的 Tab 标签上。应在了解用户任务后主动调用。',
	{
		session_id: z.string().describe('从 check_messages 获取的会话 ID'),
		name: z.string().describe('会话名称，如"React 重构"、"API 开发"、"Bug 修复"等'),
	},
	async (args) => {
		const sid = args.session_id;
		const name = args.name?.trim();
		if (!sid || !name) {
			return { content: [{ type: 'text' as const, text: '错误：缺少 session_id 或 name' }] };
		}
		const sessions = readSessions();
		const s = sessions.find(x => x.id === sid);
		if (s) {
			s.name = name;
			writeSessions(sessions);
			log(`[rename] ${sid} -> "${name}"`);
		}
		return {
			content: [{
				type: 'text' as const,
				text: `[session_id: ${sid}]\n\n会话已重命名为「${name}」`,
			}],
		};
	}
);

// ── show_progress tool ──

server.tool(
	'show_progress',
	'在侧边栏显示任务进度。用于长时间运行的多步骤任务，让用户了解当前进展。',
	{
		session_id: z.string().describe('从 check_messages 获取的会话 ID'),
		percent: z.number().min(0).max(100).describe('进度百分比 0-100'),
		message: z.string().describe('进度描述，如"正在处理第 3/10 个文件"'),
		done: z.boolean().optional().describe('是否已完成，完成后进度条自动消失'),
	},
	async (args) => {
		const sid = args.session_id;
		if (!sid) {
			return { content: [{ type: 'text' as const, text: '错误：缺少 session_id' }] };
		}
		const progressPath = path.join(getSessionDir(sid), 'progress.json');
		writeJson(progressPath, {
			percent: args.percent,
			message: args.message,
			done: args.done || false,
			ts: Date.now(),
		});
		log(`[progress] ${sid}: ${args.percent}% - ${args.message}`);
		return {
			content: [{
				type: 'text' as const,
				text: `[session_id: ${sid}]\n\n进度已更新: ${args.percent}% - ${args.message}`,
			}],
		};
	}
);

// ── send_file tool ──

server.tool(
	'send_file',
	'将一个文件推送到侧边栏供用户查看或下载。适用于 AI 生成的文件需要用户确认的场景。',
	{
		session_id: z.string().describe('从 check_messages 获取的会话 ID'),
		path: z.string().describe('要发送的文件绝对路径'),
		description: z.string().optional().describe('文件说明'),
	},
	async (args) => {
		const sid = args.session_id;
		const filePath = args.path;
		if (!sid || !filePath) {
			return { content: [{ type: 'text' as const, text: '错误：缺少 session_id 或 path' }] };
		}
		if (!fs.existsSync(filePath)) {
			return { content: [{ type: 'text' as const, text: `[session_id: ${sid}]\n\n文件不存在: ${filePath}` }] };
		}
		const filesDir = path.join(getSessionDir(sid), 'shared-files');
		ensureDir(filesDir);
		const manifestPath = path.join(filesDir, 'manifest.json');
		const manifest = readJson<any[]>(manifestPath) || [];
		manifest.push({
			id: genId(),
			path: filePath,
			name: path.basename(filePath),
			description: args.description || '',
			ts: Date.now(),
		});
		writeJson(manifestPath, manifest);
		log(`[send_file] ${sid}: ${filePath}`);
		return {
			content: [{
				type: 'text' as const,
				text: `[session_id: ${sid}]\n\n文件已发送到侧边栏: ${path.basename(filePath)}${args.description ? ` - ${args.description}` : ''}`,
			}],
		};
	}
);

// ── take_screenshot tool ──

import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);

const SCREENSHOT_DIR = path.join(os.tmpdir(), 'clawbot-screenshots');

server.tool(
	'take_screenshot',
	'截取屏幕截图并返回文件路径。支持截取指定应用窗口、Cursor 窗口（默认）、或全屏。返回的图片路径可用 Read 工具查看。也可列出当前可见的应用窗口。',
	{
		session_id: z.string().describe('从 check_messages 获取的会话 ID'),
		target: z.enum(['cursor', 'screen', 'app', 'list']).default('cursor').describe(
			'截图目标：cursor=Cursor 窗口（默认），screen=全屏，app=指定应用窗口，list=列出可见应用窗口'
		),
		app_name: z.string().optional().describe(
			'当 target=app 时，指定应用名称（如 Safari、Chrome、WeChat）。支持模糊匹配。'
		),
	},
	async (args) => {
		const sid = args.session_id;
		if (!sid) {
			return { content: [{ type: 'text' as const, text: '错误：缺少 session_id' }] };
		}

		const captureTool = path.resolve(__dirname, '..', 'scripts', 'capture-cursor');
		if (!fs.existsSync(captureTool)) {
			return { content: [{ type: 'text' as const, text: `[session_id: ${sid}]\n\n错误：截图工具不存在: ${captureTool}` }] };
		}

		try {
			if (args.target === 'list') {
				const { stdout } = await execFileAsync(captureTool, ['/dev/null', '--list']);
				return {
					content: [{
						type: 'text' as const,
						text: `[session_id: ${sid}]\n\n当前可见应用窗口：\n${stdout.trim()}`,
					}],
				};
			}

			ensureDir(SCREENSHOT_DIR);
			const filePath = path.join(SCREENSHOT_DIR, `screenshot_${Date.now()}.png`);
			const cmdArgs = [filePath];

			if (args.target === 'screen') {
				cmdArgs.push('--screen');
			} else if (args.target === 'app') {
				if (!args.app_name) {
					return { content: [{ type: 'text' as const, text: `[session_id: ${sid}]\n\n错误：target=app 时需要提供 app_name` }] };
				}
				cmdArgs.push('--app', args.app_name);
			}

			const { stdout } = await execFileAsync(captureTool, cmdArgs);
			if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 1000) {
				return { content: [{ type: 'text' as const, text: `[session_id: ${sid}]\n\n截图失败：文件未生成或过小` }] };
			}

			log(`[take_screenshot] ${sid}: target=${args.target} app=${args.app_name || '-'} output=${stdout.trim()}`);

			return {
				content: [{
					type: 'text' as const,
					text: `[session_id: ${sid}]\n\n截图成功：${filePath}\n分辨率：${stdout.trim()}\n\n可使用 Read 工具查看此图片文件。`,
				}],
			};
		} catch (err: any) {
			return {
				content: [{
					type: 'text' as const,
					text: `[session_id: ${sid}]\n\n截图失败: ${err.stderr || err.message || String(err)}`,
				}],
			};
		}
	}
);

// ── wechat_send tool ──

const WECHAT_ACTION_DIR = path.join(DATA_ROOT, 'wechat-actions');

server.tool(
	'wechat_send',
	'通过微信 Bot 向用户发送内容。支持截图、图片、文件、文本消息。截图会自动捕获当前屏幕。仅在微信 Bot 已连接时有效。',
	{
		session_id: z.string().describe('从 check_messages 获取的会话 ID'),
		action: z.enum(['screenshot', 'image', 'file', 'text', 'video']).describe(
			'发送类型：screenshot=截取当前屏幕并发送，image=发送指定图片文件，file=发送指定文件，text=发送文本消息，video=发送视频文件'
		),
		content: z.string().optional().describe(
			'内容：screenshot 时为可选说明文字，image/file/video 时为文件绝对路径，text 时为消息文本'
		),
	},
	async (args) => {
		const sid = args.session_id;
		if (!sid) {
			return { content: [{ type: 'text' as const, text: '错误：缺少 session_id' }] };
		}

		if ((args.action === 'image' || args.action === 'file') && !args.content) {
			return { content: [{ type: 'text' as const, text: `[session_id: ${sid}]\n\n错误：${args.action} 类型需要提供文件路径（content 参数）` }] };
		}

		if (args.action === 'text' && !args.content) {
			return { content: [{ type: 'text' as const, text: `[session_id: ${sid}]\n\n错误：text 类型需要提供消息文本（content 参数）` }] };
		}

		if ((args.action === 'image' || args.action === 'file') && args.content && !fs.existsSync(args.content)) {
			return { content: [{ type: 'text' as const, text: `[session_id: ${sid}]\n\n错误：文件不存在: ${args.content}` }] };
		}

		ensureDir(WECHAT_ACTION_DIR);
		const actionId = genId();
		const actionFile = path.join(WECHAT_ACTION_DIR, `${actionId}.json`);
		writeJson(actionFile, {
			id: actionId,
			sessionId: sid,
			action: args.action,
			content: args.content || '',
			status: 'pending',
			ts: Date.now(),
		});

		log(`[wechat_send] ${sid}: action=${args.action} id=${actionId}`);

		// poll for completion (max 30s)
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const result = readJson<any>(actionFile);
			if (result?.status === 'done') {
				try { fs.unlinkSync(actionFile); } catch { /* */ }
				return {
					content: [{
						type: 'text' as const,
						text: `[session_id: ${sid}]\n\n${result.message || '已发送到微信'}`,
					}],
				};
			}
			if (result?.status === 'error') {
				try { fs.unlinkSync(actionFile); } catch { /* */ }
				return {
					content: [{
						type: 'text' as const,
						text: `[session_id: ${sid}]\n\n发送失败: ${result.message || '未知错误'}`,
					}],
				};
			}
			await new Promise(r => setTimeout(r, 500));
		}

		return {
			content: [{
				type: 'text' as const,
				text: `[session_id: ${sid}]\n\n微信发送请求已提交（id: ${actionId}），但等待执行超时。可能微信 Bot 未连接。`,
			}],
		};
	}
);

// ── start ──

async function main() {
	ensureDir(DATA_ROOT);
	ensureDir(SESSIONS_DIR);
	ensureDir(path.join(SESSIONS_DIR, 'default'));
	writeJson(path.join(SESSIONS_DIR, 'default', 'queue.json'), readJson(path.join(SESSIONS_DIR, 'default', 'queue.json')) || []);

	log('[start] MCP server starting');
	const transport = new StdioServerTransport();
	await server.connect(transport);
	log('[start] MCP server connected');
}

main().catch(err => {
	log(`[fatal] ${err}`);
	process.exit(1);
});
