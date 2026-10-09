import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DATA_ROOT } from '../src/shared/data-root';

const SESSIONS_FILE = path.join(DATA_ROOT, 'sessions.json');
const SESSIONS_DIR = path.join(DATA_ROOT, 'sessions');
const ACTIVE_WINDOW_FILE = path.join(DATA_ROOT, 'active-window.json');
// MCP 子进程 -> 所属 Cursor 窗口(windowToken) 的绑定。MCP 在 first-call 时 claim
// 一个 unclaimed 的活跃 windowToken,后续所有决策(adopt session、redirect、register)
// 都只认这个 token,避免多 Cursor 窗口同工作区时 MCP 互串。
const MCP_CLAIMS_FILE = path.join(DATA_ROOT, 'mcp-claims.json');
const LOG_FILE = path.join(DATA_ROOT, 'multisession.log');
function reconnectPendingFile(workspace: string): string {
	const hash = Buffer.from(workspace).toString('base64url').slice(0, 16);
	return path.join(DATA_ROOT, `reconnect-pending-${hash}.json`);
}

const POLL_INTERVAL_MS = 800;
// 更密集的 progress 通知,避免 Cursor 侧在长轮询期间触发 MCP 超时/重新计算。
// 经验值:<= 15s 足够稳,10s 提供更多安全边界。
const HEARTBEAT_INTERVAL_MS = 10_000;
const ORPHAN_THRESHOLD_MS = 30_000;
const SESSION_EXPIRE_DAYS = 7;
// check_messages 长轮询最大挂起时长。历史上设为 3min 是为了规避 Cursor 的重新计算,
// 但会导致 AI 高频"转场"(每 3min 就要重新决策是否再调 check_messages),是断链的主要根因。
// 把这个窗口拉长到 1 小时,依靠 HEARTBEAT_INTERVAL_MS 的 progress 通知保活。
const MAX_POLL_DURATION_MS = 60 * 60 * 1000;
// ask_question 独立超时:人类回答问题通常不会等超过 30 分钟,太长没必要。
// 与 MAX_POLL_DURATION_MS 解耦,避免 ask_question 挂 1 小时。
const ASK_QUESTION_TIMEOUT_MS = 30 * 60 * 1000;

// active-window 条目的存活判定阈值(与 extension 侧的 WINDOW_STALE_MS 保持一致)。
const WINDOW_STALE_MS = 15_000;
// MCP claim 的存活阈值:超过后 claim 视为失效,其它 MCP 可以重新 claim 同一 token。
const MCP_CLAIM_STALE_MS = 30_000;

const MCP_PID = process.pid;

// 追踪当前正在被 check_messages 长轮询占用的 session。
// 用于防止 tryAdoptOrphan 将"另一个 Compose 正在使用的 session"分配给新 Compose。
// Node.js 单线程 + 同进程内存 → 无需文件锁。
const activelyPolledSessions = new Set<string>();

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

// ── window & mcp-claim ──

interface ActiveWindowEntry {
	token: string;
	timestamp: number;
	pid: number;
}

interface McpClaim {
	mcpPid: number;
	windowToken: string;
	workspace: string;
	claimedAt: number;
	lastSeenAt: number;
}

function readActiveWindows(workspace: string): ActiveWindowEntry[] {
	const data = readJson<Record<string, ActiveWindowEntry[]>>(ACTIVE_WINDOW_FILE);
	if (!data) return [];
	const entries = data[workspace] || [];
	const now = Date.now();
	// 只保留新格式、未过期的条目。旧格式(无 pid)视为失效,防止误 claim。
	return entries.filter(e => e && e.token && e.pid && (now - e.timestamp) <= WINDOW_STALE_MS);
}

function readMcpClaims(): McpClaim[] {
	return readJson<McpClaim[]>(MCP_CLAIMS_FILE) || [];
}

function writeMcpClaims(claims: McpClaim[]) {
	writeJson(MCP_CLAIMS_FILE, claims);
}

function pruneMcpClaims(claims: McpClaim[]): McpClaim[] {
	const now = Date.now();
	return claims.filter(c => c && c.mcpPid && c.windowToken && (now - c.lastSeenAt) <= MCP_CLAIM_STALE_MS);
}

// 选出 MCP 所属的 Cursor 窗口 token,first-call 时 claim,后续一直沿用。
// 关键原则:
// 1. 同一 MCP 进程 (mcpPid) 只会 claim 一次,写入 mcp-claims.json。
// 2. 跨多个 Cursor 窗口并存时,优先 claim 当前 workspace 里"未被其它活着的 MCP claim"的 token。
// 3. 每次调用都续期 lastSeenAt,extension 可用此判断 MCP 存活性。
function claimWindowToken(workspace: string): string | null {
	let claims = pruneMcpClaims(readMcpClaims());

	// 已经 claim 过,直接续期并返回
	const mine = claims.find(c => c.mcpPid === MCP_PID);
	if (mine) {
		mine.lastSeenAt = Date.now();
		mine.workspace = workspace;
		writeMcpClaims(claims);
		return mine.windowToken;
	}

	const windows = readActiveWindows(workspace);
	if (windows.length === 0) {
		log(`[claim] no active windows for workspace ${workspace}, skipping claim`);
		return null;
	}

	const usedTokens = new Set(claims.map(c => c.windowToken));
	// 按时间戳从新到旧排序,倾向 claim 最新激活的窗口
	windows.sort((a, b) => b.timestamp - a.timestamp);
	const free = windows.find(w => !usedTokens.has(w.token));
	const picked = free || windows[0]; // 最坏情况下所有 token 都被 claim,兜底取最新
	if (!free) {
		log(`[claim] WARN: all windows already claimed (pids=${[...usedTokens].join(',')}), falling back to newest token=${picked.token}`);
	}

	claims.push({
		mcpPid: MCP_PID,
		windowToken: picked.token,
		workspace,
		claimedAt: Date.now(),
		lastSeenAt: Date.now(),
	});
	writeMcpClaims(claims);
	log(`[claim] mcp_pid=${MCP_PID} workspace=${workspace} → windowToken=${picked.token} (ext_pid=${picked.pid})`);
	return picked.token;
}

function touchMcpClaim() {
	const claims = pruneMcpClaims(readMcpClaims());
	const mine = claims.find(c => c.mcpPid === MCP_PID);
	if (mine) {
		mine.lastSeenAt = Date.now();
		writeMcpClaims(claims);
	}
}

function releaseMcpClaim() {
	try {
		const claims = readMcpClaims().filter(c => c.mcpPid !== MCP_PID);
		writeMcpClaims(claims);
	} catch { /* ignore */ }
}

// ── orphan / session recovery ──

function tryAdoptOrphan(workspace: string, windowToken: string | null): string | null {
	const sessions = readSessions();
	const now = Date.now();

	const wsSessions = sessions.filter(s => s.alive && s.workspace === workspace);
	if (wsSessions.length === 0) return null;

	// Phase 1: 严格 windowToken 匹配——同窗口内 mode-switch / 重启 MCP 走这里恢复。
	// 排除 activelyPolledSessions: 如果 session 正被另一个 check_messages 调用轮询,
	// 说明它已有对应 Compose,当前调用来自一个新 Compose,应创建新 session。
	if (windowToken) {
		const tokenMatches = wsSessions
			.filter(s => s.windowToken === windowToken && !activelyPolledSessions.has(s.id))
			.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
		if (tokenMatches.length > 0) {
			log(`[adopt] recovered session ${tokenMatches[0].id} (windowToken match, age=${now - tokenMatches[0].lastActiveAt}ms)`);
			return tokenMatches[0].id;
		}
	}

	// 旧 Phase 2 "单 session 直接认领" 是跨窗口互串的根源 —— 已移除。
	// 即便工作区里只有一个 session,它也可能属于"另一个 Cursor 窗口",
	// 不做 windowToken 校验就无脑认领,会让新窗口的 MCP 抢走老窗口面板的消息。

	// Phase 3: 经典 orphan 回收——仅接管"明显失活 (lastActiveAt 超阈值)且
	// windowToken 对应的 Cursor 窗口已死" 的 session。
	const activeTokens = new Set(readActiveWindows(workspace).map(w => w.token));
	const orphans = wsSessions
		.filter(s => {
			if (activelyPolledSessions.has(s.id)) return false;
			if ((now - s.lastActiveAt) <= ORPHAN_THRESHOLD_MS) return false;
			if (s.windowToken && activeTokens.has(s.windowToken)) return false;
			return true;
		})
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

// ── reconnect-pending ──

const RECONNECT_PENDING_MAX_AGE_MS = 60_000;

function tryConsumeReconnectPending(workspace: string): string | null {
	const pendingFile = reconnectPendingFile(workspace);
	const data = readJson<{ targetSessionId: string; ts: number }>(pendingFile);
	if (!data || !data.targetSessionId) return null;
	if (Date.now() - data.ts > RECONNECT_PENDING_MAX_AGE_MS) {
		try { fs.unlinkSync(pendingFile); } catch { /* ignore */ }
		return null;
	}

	const sessions = readSessions();
	const target = sessions.find(s => s.id === data.targetSessionId);
	if (!target) {
		try { fs.unlinkSync(pendingFile); } catch { /* ignore */ }
		return null;
	}

	target.alive = true;
	target.lastActiveAt = Date.now();
	writeSessions(sessions);
	try { fs.unlinkSync(pendingFile); } catch { /* ignore */ }
	log(`[reconnect] consumed pending reconnect → session ${data.targetSessionId}`);
	return data.targetSessionId;
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

// ── 接管派发协议:dispatch_id 幂等 + inflight 在飞记录 ──
//
// 外部编排器(Codex 等)无法直接调用本 MCP——stdio 通道由 Cursor 独占——只能按文件协议派发:
//   1. 向 sessions/<sid>/queue.json 追加 {id, dispatch_id, content, timestamp, urgent?}
//   2. 本进程在 check_messages 长轮询里消费该条,并写 inflight.json 标记"正在处理"
//   3. 本轮结束(reply / 下一次 check_messages)时收尾,结果落在 summary.json、chat-log.json
// dispatch_id 是派发方的幂等键:断连重发不会重复执行。
// 会话被新 MCP 进程恢复、且 inflight 仍属于已退出的旧进程时,把未完成任务交还 Agent 续做。
const DISPATCH_HISTORY_LIMIT = 200;
const INFLIGHT_REPLAY_LIMIT = 2;

interface QueueMessage {
	id?: string;
	content?: string;
	text?: string;
	timestamp?: number | string;
	urgent?: boolean;
	dispatch_id?: string;
}

interface InflightRecord {
	id?: string;
	dispatch_id?: string;
	content: string;
	consumed_at: number;
	mcp_pid: number;
	replay_count: number;
	replayed_at?: number;
	completed_at?: number;
	completed_by?: string;
}

interface DispatchRecord {
	message_id?: string;
	consumed_at: number;
	completed_at?: number;
	completed_by?: string;
}

function messageText(message: QueueMessage | null | undefined): string {
	if (!message) return '';
	return message.content ?? message.text ?? '';
}

function isPidAlive(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		// EPERM 表示进程存在但无权限发信号,视为存活
		return error?.code === 'EPERM';
	}
}

function dispatchHistoryPath(sid: string): string {
	return path.join(getSessionDir(sid), 'dispatch-history.json');
}

function inflightPath(sid: string): string {
	return path.join(getSessionDir(sid), 'inflight.json');
}

function readDispatchHistory(sid: string): Record<string, DispatchRecord> {
	return readJson<Record<string, DispatchRecord>>(dispatchHistoryPath(sid)) || {};
}

function readInflight(sid: string): InflightRecord | null {
	return readJson<InflightRecord>(inflightPath(sid));
}

function markDispatchCompleted(sid: string, dispatchId: string | undefined, completedBy: string) {
	if (!dispatchId) return;
	const history = readDispatchHistory(sid);
	const record = history[dispatchId];
	if (!record || record.completed_at) return;
	history[dispatchId] = { ...record, completed_at: Date.now(), completed_by: completedBy };
	writeJson(dispatchHistoryPath(sid), history);
}

/** 消费一条消息时记账:dispatch_id 只允许执行一次,同键重发会被 dedupeQueue 丢弃。 */
function beginInflight(sid: string, message: QueueMessage) {
	const previous = readInflight(sid);
	if (previous && !previous.completed_at) {
		// 旧任务还没收尾就被新消息顶掉:如实记录,避免派发方误判成"仍在处理"
		markDispatchCompleted(sid, previous.dispatch_id, 'superseded');
	}
	writeJson(inflightPath(sid), {
		id: message.id,
		dispatch_id: message.dispatch_id,
		content: messageText(message),
		consumed_at: Date.now(),
		mcp_pid: MCP_PID,
		replay_count: previous && previous.dispatch_id === message.dispatch_id ? (previous.replay_count ?? 0) : 0,
	});
	if (message.dispatch_id) {
		const history = readDispatchHistory(sid);
		history[message.dispatch_id] = { message_id: message.id, consumed_at: Date.now() };
		const trimmed = Object.entries(history)
			.sort((a, b) => (b[1].consumed_at ?? 0) - (a[1].consumed_at ?? 0))
			.slice(0, DISPATCH_HISTORY_LIMIT);
		writeJson(dispatchHistoryPath(sid), Object.fromEntries(trimmed));
	}
}

/** 本轮结束:标记在飞任务已完成(文件保留,供派发方核对完成方式与时间)。 */
function finishInflight(sid: string, completedBy: string) {
	const current = readInflight(sid);
	if (!current || current.completed_at) return;
	writeJson(inflightPath(sid), { ...current, completed_at: Date.now(), completed_by: completedBy });
	markDispatchCompleted(sid, current.dispatch_id, completedBy);
	log(`[inflight] ${sid} dispatch ${current.dispatch_id ?? current.id} completed by ${completedBy}`);
}

/**
 * 在飞任务的归属判定,与"是否带 session_id 恢复"无关,只看原持有进程是否还活着:
 * - 原进程仍存活(或就是本进程):本次调用说明那一轮已经结束,收尾,不重复执行
 * - 原进程已退出:任务被中断,把任务原文交还给 Agent 续做(最多 INFLIGHT_REPLAY_LIMIT 次)
 * 返回值非空表示"需要把未完成任务投递给 Agent"。
 */
function takeOverInflight(sid: string, hadReply: boolean): string | null {
	const inflight = readInflight(sid);
	if (!inflight || inflight.completed_at) return null;
	const ownerAlive = inflight.mcp_pid === MCP_PID || isPidAlive(inflight.mcp_pid);
	if (ownerAlive) {
		finishInflight(sid, hadReply ? 'reply' : 'next-call');
		return null;
	}
	if ((inflight.replay_count ?? 0) >= INFLIGHT_REPLAY_LIMIT) {
		finishInflight(sid, 'replay-exhausted');
		return null;
	}
	const replayCount = (inflight.replay_count ?? 0) + 1;
	writeJson(inflightPath(sid), { ...inflight, mcp_pid: MCP_PID, replay_count: replayCount, replayed_at: Date.now() });
	log(`[inflight] ${sid} took over unfinished dispatch ${inflight.dispatch_id ?? inflight.id} (attempt ${replayCount})`);
	return `⚠️ 上一轮任务在处理中被中断（原 MCP 进程已退出），这是第 ${replayCount} 次续做请求。请基于当前工作区继续完成，并如实汇报进度、未完成项与结论：\n\n--- 未完成任务 ---\n${inflight.content}\n--- 任务原文结束 ---`;
}

/** 消费前清理重复投递:同 dispatch_id 的历史条目直接丢弃,保证幂等。 */
function dedupeQueue(sid: string, queue: QueueMessage[]): { queue: QueueMessage[]; dropped: number } {
	const history = readDispatchHistory(sid);
	const seen = new Set<string>();
	const kept: QueueMessage[] = [];
	let dropped = 0;
	for (const item of queue) {
		const dispatchId = item?.dispatch_id;
		if (!dispatchId) { kept.push(item); continue; }
		if (history[dispatchId] || seen.has(dispatchId)) { dropped++; continue; }
		seen.add(dispatchId);
		kept.push(item);
	}
	return { queue: dropped > 0 ? kept : queue, dropped };
}

/**
 * 写 status.json:对外暴露可判活的进度信号。
 * last_heartbeat_at 由长轮询每 10s 续期,派发方据此区分"在干活"与"进程已断";
 * awaiting_reply + message_id/dispatch_id 用于把状态对回自己派发的任务。
 */
function writeAgentStatus(sid: string, fallbackStatus: 'idle' | 'processing', preview?: string) {
	const statusPath = path.join(getSessionDir(sid), 'status.json');
	const existing = readJson<any>(statusPath) || {};
	const inflight = readInflight(sid);
	const awaiting = !!inflight && !inflight.completed_at;
	const status = awaiting ? 'processing' : fallbackStatus;
	const now = Date.now();
	const payload: any = {
		...existing,
		status,
		since: existing.status === status ? (existing.since ?? now) : now,
		last_heartbeat_at: now,
		awaiting_reply: awaiting,
	};
	if (preview !== undefined) payload.preview = preview;
	if (awaiting && inflight) {
		payload.message_id = inflight.id;
		payload.dispatch_id = inflight.dispatch_id;
		payload.consumed_at = inflight.consumed_at;
	} else {
		delete payload.message_id;
		delete payload.dispatch_id;
		delete payload.consumed_at;
	}
	writeJson(statusPath, payload);
}

// ── MCP server ──

const ENFORCE_SUFFIX = (sid: string) =>
	`\n\n---\n⚠️ **强制指令**：你完成本轮回复后，最后一步 **必须** 调用 check_messages(session_id="${sid}") 继续监听。不调用 = 会话断开，用户无法继续与你交互。`;

// 失车 inquiry 回放:检查 session 目录下的 inquiry.json,如果处于"answered=true 且
// 未 consumed"状态,说明上一次 ask_question 的返回值可能在传输途中丢失(常见原因:
// 客户端已对该 MCP 调用判超时;或 MCP 进程被 Cursor 回收重启)。此时下一个 check_messages
// 把 answers 以用户消息的形式投递给 Agent,让对话能继续下去。
function tryReplayLostInquiry(sid: string): string | null {
	const inquiryPath = path.join(getSessionDir(sid), 'inquiry.json');
	const inquiry = readJson<any>(inquiryPath);
	if (!inquiry || !inquiry.answered || inquiry.consumedAt) return null;

	const answers = inquiry.answers;
	const updated = {
		...inquiry,
		consumedAt: Date.now(),
		consumedBy: MCP_PID,
		replayed: true,
	};
	writeJson(inquiryPath, updated);

	const logPath = path.join(getSessionDir(sid), 'chat-log.json');
	const logs = readJson<any[]>(logPath) || [];
	logs.push({ role: 'inquiry', text: JSON.stringify(inquiry.questions || []), ts: inquiry.ts });
	logs.push({ role: 'user', text: JSON.stringify(answers), ts: Date.now() });
	writeJson(logPath, logs);

	log(`[replay] ${sid} replayed lost inquiry ${inquiry.id} answers=${JSON.stringify(answers)}`);
	return JSON.stringify(answers, null, 2);
}

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
		// 绑定 MCP 进程到一个稳定的 Cursor 窗口。first-call 时 claim,后续一直沿用同一 token,
		// 杜绝多 Cursor 窗口同工作区时读到"最新窗口" token 导致的互串。
		const windowToken = claimWindowToken(cwd);
		let sid = args.session_id as string | undefined;
		const reply = args.reply as string | undefined;

		// first call: try reconnect-pending, then adopt or register
		let isRecovered = false;
		if (!sid) {
			sid = tryConsumeReconnectPending(cwd) ?? undefined;
			if (sid) {
				isRecovered = true;
				log(`[check_messages] reconnect-pending matched session ${sid}`);
			}
		}
		if (!sid) {
			sid = tryAdoptOrphan(cwd, windowToken) ?? undefined;
			if (sid) {
				isRecovered = true;
			} else {
				sid = genId();
				const sessions = readSessions();
				const wsName = path.basename(cwd);
				// 只统计属于当前窗口的 session 数,避免多窗口编号冲突。
				const num = sessions.filter(s => s.workspace === cwd && s.windowToken === windowToken).length + 1;
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
				log(`[register] new session ${sid} for ${cwd} windowToken=${windowToken}`);
			}
			migrateDefaultQueue(sid);
			cleanupExpiredSessions();
		}

		// 标记此 session 为"正在被轮询"，防止其他 check_messages 调用通过
		// tryAdoptOrphan 将同一 session 分配给不同的 Compose 面板。
		activelyPolledSessions.add(sid);
		log(`[poll-lock] ${sid} locked (active=${activelyPolledSessions.size})`);

		try {

		// write reply summary if provided
		if (reply && sid) {
			const summaryPath = path.join(getSessionDir(sid), 'summary.json');
			writeJson(summaryPath, { text: reply, ts: Date.now() });
			const logPath = path.join(getSessionDir(sid), 'chat-log.json');
			const logs = readJson<any[]>(logPath) || [];
			logs.push({ role: 'assistant', text: reply, ts: Date.now() });
			writeJson(logPath, logs);
			log(`[reply] ${sid} summary written`);
		}

		// 未完成任务收尾/续做判定(见 takeOverInflight 注释)
		const replayText = takeOverInflight(sid, !!reply);

		const queuePath = path.join(getSessionDir(sid), 'queue.json');
		const pendingNow = readJson<QueueMessage[]>(queuePath) || [];

		// 对外可见的存活/进度信号(awaiting_reply + last_heartbeat_at)
		writeAgentStatus(sid, 'idle');

		// 断连恢复:队列为空时立刻把未完成任务交还给 Agent,而不是让它干等新消息。
		// 队列里已有新消息时不抢跑,新指令优先;未完成任务留到队列空时再续做。
		if (replayText && pendingNow.length === 0) {
			touchSession(sid);
			log(`[inflight] ${sid} unfinished task handed back to agent`);
			return {
				content: [{
					type: 'text' as const,
					text: `[session_id: ${sid}]\n\n${replayText}${ENFORCE_SUFFIX(sid)}`,
				}],
			};
		}

		// 优先回放上次 ask_question 失车的 answers(如果存在)。处理顺序放在
		// "recovered 短路返回" 之前,避免刚恢复的会话错过失车答案。
		const replayedAnswers = tryReplayLostInquiry(sid);
		if (replayedAnswers) {
			touchSession(sid);
			touchMcpClaim();
			return {
				content: [{
					type: 'text' as const,
					text: `[session_id: ${sid}]\n\n用户上次的回答（补发）：\n${replayedAnswers}${ENFORCE_SUFFIX(sid)}`,
				}],
			};
		}

		// if recovered and queue is empty, immediately tell AI this is a resumed session
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
			// check queue:先按 dispatch_id 去重,断连重发不会重复执行
			const rawQueue = readJson<QueueMessage[]>(queuePath);
			const deduped = rawQueue && rawQueue.length > 0 ? dedupeQueue(sid, rawQueue) : null;
			if (deduped && deduped.dropped > 0) {
				writeJson(queuePath, deduped.queue);
				log(`[dispatch] ${sid} dropped ${deduped.dropped} duplicated dispatch message(s)`);
			}
			const queue = deduped ? deduped.queue : [];
			if (queue.length > 0) {
				const urgentIdx = queue.findIndex((m: QueueMessage) => m.urgent);
				let picked: QueueMessage;
				let remaining: QueueMessage[];

				if (urgentIdx >= 0) {
					picked = queue[urgentIdx];
					remaining = [...queue.slice(0, urgentIdx), ...queue.slice(urgentIdx + 1)];
				} else {
					picked = queue[0];
					remaining = queue.slice(1);
				}

				writeJson(queuePath, remaining);
				// 在飞记账:派发方据此判断"已送达/处理中",并保证同 dispatch_id 只执行一次
				beginInflight(sid, picked);

				const text = messageText(picked);

				// mark agent as processing
				writeAgentStatus(sid, 'processing', text.slice(0, 60));

				const logPath = path.join(getSessionDir(sid), 'chat-log.json');
				const logs = readJson<any[]>(logPath) || [];
				logs.push({ role: 'user', text, ts: picked.timestamp || Date.now() });
				writeJson(logPath, logs);

				touchSession(sid);
				log(`[poll] ${sid} consumed 1 message (${remaining.length} remaining, dispatch=${picked.dispatch_id ?? '-'})`);
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

			// 轮询期间也检查失车 inquiry:AI 先调 check_messages 后用户才点问题选项时,
			// 用户的答案会落盘成 inquiry.answered=true,这里及时捕获并返回给 AI。
			const loopReplay = tryReplayLostInquiry(sid);
			if (loopReplay) {
				touchSession(sid);
				touchMcpClaim();
				return {
					content: [{
						type: 'text' as const,
						text: `[session_id: ${sid}]\n\n用户回答（来自问题面板）：\n${loopReplay}${ENFORCE_SUFFIX(sid)}`,
					}],
				};
			}

			// check reconnect-pending: if user requested reconnect to a different session, redirect Agent
			const pendingFile = reconnectPendingFile(cwd);
			const reconnectTarget = readJson<{ targetSessionId: string; ts: number }>(pendingFile);
			if (reconnectTarget
				&& reconnectTarget.targetSessionId
				&& reconnectTarget.targetSessionId !== sid
				&& (Date.now() - reconnectTarget.ts) < RECONNECT_PENDING_MAX_AGE_MS
			) {
				const targetExists = readSessions().some(s => s.id === reconnectTarget.targetSessionId);
				if (targetExists) {
					try { fs.unlinkSync(pendingFile); } catch { /* ignore */ }
					touchSession(sid);
					log(`[reconnect] redirecting Agent from ${sid} to ${reconnectTarget.targetSessionId}`);
					return {
						content: [{
							type: 'text' as const,
							text: `[session_id: ${reconnectTarget.targetSessionId}]\n\n会话已切换。请立即调用 check_messages(session_id="${reconnectTarget.targetSessionId}") 继续。${ENFORCE_SUFFIX(reconnectTarget.targetSessionId)}`,
						}],
					};
				}
			}

			// heartbeat: 通过 MCP progress 通知告诉 Cursor 客户端"这次调用还活着",
			// 阻止其在长轮询期间判超时。必须使用 extra.sendNotification(),该回调由 SDK
			// 在请求处理上下文中注入,自动关联当前请求;原先用 server.server.sendNotification
			// 是错误 API(Server 没有 sendNotification 方法,调用会在运行时抛错并被 catch 吞掉,
			// 导致心跳从未真正发出)。
			if (Date.now() >= nextHeartbeat) {
				touchSession(sid);
				touchMcpClaim();
				writeAgentStatus(sid, 'idle');
				const progressToken = extra._meta?.progressToken;
				if (progressToken !== undefined) {
					try {
						await extra.sendNotification({
							method: 'notifications/progress',
							params: {
								progressToken,
								progress: 0,
								total: 1,
							},
						});
					} catch (e) {
						log(`[heartbeat] sendNotification failed: ${e}`);
					}
				}
				nextHeartbeat = Date.now() + HEARTBEAT_INTERVAL_MS;
			}

			await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
		}

		// still_waiting — keep the loop alive without breaking the session
		touchSession(sid);
		touchMcpClaim();
		return {
			content: [{
				type: 'text' as const,
				text: `[session_id: ${sid}]\n\n{"status":"still_waiting"}\n暂无新消息。请立刻再次调用 check_messages(session_id="${sid}") 保持连接，不要输出任何文字。`,
			}],
		};

		} finally {
			activelyPolledSessions.delete(sid);
			log(`[poll-lock] ${sid} unlocked (active=${activelyPolledSessions.size})`);
		}
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
	async (args, extra) => {
		const sid = args.session_id;
		const questions = args.questions;
		if (!sid) {
			return { content: [{ type: 'text' as const, text: '错误：缺少 session_id' }] };
		}

		// 清理同 session 下任何已 consumed 或已过期的历史 inquiry(由上次失车留下的),
		// 避免新的 inquiry 误读到老数据。保留"answered 但未 consumed"的 inquiry —— 那是
		// 上次失车待兜底的答案,check_messages 会在下一次调用时回放它。
		const inquiryPath = path.join(getSessionDir(sid), 'inquiry.json');
		const oldInquiry = readJson<any>(inquiryPath);
		if (oldInquiry && (oldInquiry.consumedAt || (!oldInquiry.answered && (Date.now() - (oldInquiry.ts || 0)) > ASK_QUESTION_TIMEOUT_MS))) {
			writeJson(inquiryPath, null);
		}

		// 写入新 inquiry
		const inquiryId = genId();
		writeJson(inquiryPath, { id: inquiryId, questions, ts: Date.now(), answered: false });
		log(`[inquiry] ${sid} question posted: ${inquiryId}`);

		const deadline = Date.now() + ASK_QUESTION_TIMEOUT_MS;
		const queuePath = path.join(getSessionDir(sid), 'queue.json');
		let nextHeartbeat = Date.now() + HEARTBEAT_INTERVAL_MS;

		while (Date.now() < deadline) {
			const inquiry = readJson<any>(inquiryPath);
			if (inquiry?.answered && inquiry.id === inquiryId && !inquiry.consumedAt) {
				// compare-and-swap: 标记为"本次调用已消费",但保留 answers 供兜底回放。
				// 不再粗暴 writeJson(..., null);否则答案一旦在返回途中丢失,用户重答都无救。
				const answers = inquiry.answers;
				const updated = {
					...inquiry,
					consumedAt: Date.now(),
					consumedBy: MCP_PID,
				};
				writeJson(inquiryPath, updated);
				touchSession(sid);
				touchMcpClaim();

				const logPath = path.join(getSessionDir(sid), 'chat-log.json');
				const logs = readJson<any[]>(logPath) || [];
				logs.push({ role: 'inquiry', text: JSON.stringify(questions), ts: inquiry.ts });
				logs.push({ role: 'user', text: JSON.stringify(answers), ts: Date.now() });
				writeJson(logPath, logs);

				return {
					content: [{
						type: 'text' as const,
						text: `[session_id: ${sid}]\n\n用户回答：\n${JSON.stringify(answers, null, 2)}${ENFORCE_SUFFIX(sid)}`,
					}],
				};
			}

			// 用户没答问题而是发了新消息 → 视为主动跳过。此时可以安全擦除 inquiry。
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

			// heartbeat:必须发 progress 通知,否则用户思考超过 60s 客户端就会判超时,
			// 届时即便用户回答,MCP 的 return value 也会扔进一个已断开的 channel。
			if (Date.now() >= nextHeartbeat) {
				touchSession(sid);
				touchMcpClaim();
				const progressToken = extra._meta?.progressToken;
				if (progressToken !== undefined) {
					try {
						await extra.sendNotification({
							method: 'notifications/progress',
							params: {
								progressToken,
								progress: 0,
								total: 1,
							},
						});
					} catch (e) {
						log(`[ask_question:heartbeat] sendNotification failed: ${e}`);
					}
				}
				nextHeartbeat = Date.now() + HEARTBEAT_INTERVAL_MS;
			}

			await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
		}

		// 超时:擦除 inquiry,避免下次启动误读。
		writeJson(inquiryPath, null);
		return {
			content: [{ type: 'text' as const, text: `[session_id: ${sid}]\n\n等待用户回答超时（${Math.round(ASK_QUESTION_TIMEOUT_MS / 60000)} 分钟）。${ENFORCE_SUFFIX(sid)}` }],
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

	// 进程退出时释放 claim,给后来者让位。stdio 断开信号也可能以 SIGTERM/SIGPIPE 到达。
	const cleanup = () => { try { releaseMcpClaim(); } catch { /* ignore */ } };
	process.on('exit', cleanup);
	process.on('SIGINT', () => { cleanup(); process.exit(0); });
	process.on('SIGTERM', () => { cleanup(); process.exit(0); });
	process.on('SIGHUP', () => { cleanup(); process.exit(0); });

	log(`[start] MCP server starting pid=${MCP_PID} ppid=${process.ppid}`);
	const transport = new StdioServerTransport();
	await server.connect(transport);
	log('[start] MCP server connected');
}

main().catch(err => {
	log(`[fatal] ${err}`);
	try { releaseMcpClaim(); } catch { /* ignore */ }
	process.exit(1);
});
