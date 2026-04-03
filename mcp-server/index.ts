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

function tryAdoptOrphan(workspace: string, windowToken: string | null): string | null {
	const sessions = readSessions();
	const now = Date.now();
	const wsSessions = sessions.filter(s => s.alive && s.workspace === workspace);
	if (wsSessions.length === 0) return null;

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
	},
	async (args, extra) => {
		const cwd = process.cwd();
		const windowToken = getActiveWindowToken(cwd);
		let sid = args.session_id as string | undefined;
		const reply = args.reply as string | undefined;

		// first call: try adopt or register
		let isRecovered = false;
		if (!sid) {
			sid = tryAdoptOrphan(cwd, windowToken) ?? undefined;
			if (sid) {
				isRecovered = true;
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
					alive: true,
					createdAt: Date.now(),
					lastActiveAt: Date.now(),
				};
				sessions.push(meta);
				writeSessions(sessions);
				ensureDir(getSessionDir(sid));
				log(`[register] new session ${sid} for ${cwd}`);
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
				let toDeliver: any[];
				let remaining: any[];

				if (urgentIdx >= 0) {
					toDeliver = [queue[urgentIdx]];
					remaining = [...queue.slice(0, urgentIdx), ...queue.slice(urgentIdx + 1)];
				} else {
					toDeliver = queue;
					remaining = [];
				}

				writeJson(queuePath, remaining);

				const logPath = path.join(getSessionDir(sid), 'chat-log.json');
				const logs = readJson<any[]>(logPath) || [];
				for (const msg of toDeliver) {
					logs.push({ role: 'user', text: msg.content || msg.text, ts: msg.timestamp || Date.now() });
				}
				writeJson(logPath, logs);

				touchSession(sid);
				log(`[poll] ${sid} consumed ${toDeliver.length} messages (${remaining.length} remaining)`);

				const texts = toDeliver.map((m: any) => m.content || m.text).join('\n---\n');
				const pendingNote = remaining.length > 0
					? `\n（队列中还有 ${remaining.length} 条待处理消息，处理完本条后会继续投递）`
					: '';
				return {
					content: [{
						type: 'text' as const,
						text: `[session_id: ${sid}]\n\n${texts}${pendingNote}${ENFORCE_SUFFIX(sid)}`,
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

		// poll for answer
		const deadline = Date.now() + MAX_POLL_DURATION_MS;
		while (Date.now() < deadline) {
			const inquiry = readJson<any>(inquiryPath);
			if (inquiry?.answered && inquiry.id === inquiryId) {
				// clear inquiry file
				writeJson(inquiryPath, null);
				touchSession(sid);

				// append to chat-log
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
	'导出当前会话的完整对话记录。仅当用户要求"导出对话"时才调用。',
	{
		session_id: z.string().describe('会话 ID，必须携带。'),
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

		return {
			content: [{
				type: 'text' as const,
				text: `[session_id: ${sid}]\n\n# 对话记录导出\n\n${lines.join('\n\n---\n\n')}`,
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
