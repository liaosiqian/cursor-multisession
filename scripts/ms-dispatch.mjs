#!/usr/bin/env node
/**
 * ms-dispatch — MultiSession 接管工具(派发 / 观察 / 断连判定)。
 *
 * 用途:让外部编排器(Codex 等)把任务派发进 Cursor GUI 里正在运行的会话,
 * 并依据文件协议判断送达、处理、回复与断连,而不是靠读取自然语言聊天记录猜。
 *
 * 协议(与 mcp-server 的 dispatch_id / inflight.json 约定配套):
 *   sessions/<sid>/queue.json            派发消息 {id, dispatch_id, content, timestamp, urgent?}
 *   sessions/<sid>/inflight.json         在飞任务:谁在处理、是否续做、是否收尾
 *   sessions/<sid>/dispatch-history.json 派发幂等账本
 *   sessions/<sid>/status.json           可判活信号:last_heartbeat_at / awaiting_reply
 *
 * 命令:
 *   sessions [--json]                     列出会话及可投递性
 *   dispatch --task <文本> [--session <id|名称>] [--workspace <路径>]
 *            [--dispatch-id <id>] [--urgent] [--wait] [--timeout 300]
 *   status [--dispatch-id <id>] [--session <id>] [--json]
 *
 * 数据根:默认 ~/.multisession,可用 MULTISESSION_DATA_ROOT 覆盖。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const WINDOW_STALE_MS = 15_000;
const CLAIM_STALE_MS = 30_000;
const REDELIVER_AFTER_MS = 15_000;
const WORKER_LOST_AFTER_MS = 90_000;

function dataRoot() {
	const override = process.env.MULTISESSION_DATA_ROOT?.trim();
	return override ? path.resolve(override) : path.join(os.homedir(), '.multisession');
}

function readJson(file) {
	try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

function writeJsonAtomic(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = file + '.' + process.pid + '.tmp';
	fs.writeFileSync(tmp, JSON.stringify(data, null, '\t'));
	fs.renameSync(tmp, file);
}

function sessionDir(root, sid) { return path.join(root, 'sessions', sid); }

function isPidAlive(pid) {
	if (!pid || pid <= 0) return false;
	try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/** 会话快照 + 可投递性判定(与 mcp-server 的 claim/heartbeat 语义保持一致) */
function snapshot(root) {
	const now = Date.now();
	const sessions = readJson(path.join(root, 'sessions.json')) ?? [];
	const windows = readJson(path.join(root, 'active-window.json')) ?? {};
	const claims = readJson(path.join(root, 'mcp-claims.json')) ?? [];

	const liveTokens = new Set();
	const workspacesWithWindows = new Set();
	for (const entries of Object.values(windows)) {
		const entriesArray = Array.isArray(entries) ? entries : [];
		if (entriesArray.length > 0) workspacesWithWindows.add('__any__');
	}
	for (const [workspace, entries] of Object.entries(windows)) {
		for (const entry of entries ?? []) {
			if (!entry?.token || !entry?.pid) continue;
			if ((now - entry.timestamp) > WINDOW_STALE_MS) continue;
			if (!isPidAlive(entry.pid)) continue;
			liveTokens.add(entry.token);
			workspacesWithWindows.add(workspace);
		}
	}
	const liveClaims = claims.filter((claim) => claim?.windowToken && (now - (claim.lastSeenAt ?? 0)) <= CLAIM_STALE_MS);

	return sessions.map((session) => {
		const dir = sessionDir(root, session.id);
		const queue = readJson(path.join(dir, 'queue.json')) ?? [];
		const inflight = readJson(path.join(dir, 'inflight.json'));
		const status = readJson(path.join(dir, 'status.json'));
		const summary = readJson(path.join(dir, 'summary.json'));
		const windowAlive = !!session.windowToken && liveTokens.has(session.windowToken);
		// MCP 长轮询每 10s 续期 status.last_heartbeat_at,是比窗口心跳更直接的"能收消息"信号,
		// 也不依赖扩展是否在跑(便于无 GUI 的验证环境)。
		const heartbeatFresh = typeof status?.last_heartbeat_at === 'number'
			&& (now - status.last_heartbeat_at) <= CLAIM_STALE_MS;
		const polling = heartbeatFresh || liveClaims.some((claim) => claim.windowToken === session.windowToken);
		// windowState: alive=窗口心跳在;dead=该工作区有窗口条目但都失效(窗口真退出);unknown=没有窗口数据
		const windowState = windowAlive
			? 'alive'
			: (workspacesWithWindows.has(session.workspace ?? '') ? 'dead' : 'unknown');
		return {
			id: session.id,
			name: session.name,
			workspace: session.workspace,
			alive: !!session.alive,
			lastActiveAt: session.lastActiveAt ?? 0,
			windowAlive,
			windowState,
			polling,
			// active: 有 Composer 正在长轮询,写入即被消费
			// idle:   窗口在,但当前没有轮询(Agent 正在干活或没起对话)
			// none:   窗口/进程都已不在,写入无人消费
			deliverability: polling ? 'active' : (windowState === 'dead' ? 'none' : 'idle'),
			queueLength: Array.isArray(queue) ? queue.length : 0,
			inflight: inflight ? {
				dispatchId: inflight.dispatch_id,
				messageId: inflight.id,
				consumedAt: inflight.consumed_at,
				ownerPid: inflight.mcp_pid,
				ownerAlive: inflight.mcp_pid === undefined ? undefined : isPidAlive(inflight.mcp_pid),
				replayCount: inflight.replay_count ?? 0,
				completedAt: inflight.completed_at,
				completedBy: inflight.completed_by,
			} : null,
			awaitingReply: status?.awaiting_reply === true,
			lastHeartbeatAt: status?.last_heartbeat_at,
			status: status?.status,
			lastSummaryAt: summary?.ts,
		};
	});
}

function resolveSession(states, options) {
	if (options.session) {
		const needle = options.session.toLowerCase();
		const match = states.find((s) => s.id.toLowerCase() === needle)
			|| states.find((s) => (s.name ?? '').toLowerCase() === needle)
			|| states.find((s) => s.id.toLowerCase().startsWith(needle))
			|| states.find((s) => (s.name ?? '').toLowerCase().includes(needle));
		if (!match) throw new Error('找不到会话: ' + options.session);
		return match;
	}
	const candidates = states.filter((s) =>
		(!options.workspace || path.resolve(s.workspace ?? '') === path.resolve(options.workspace))
		&& s.deliverability !== 'none');
	const pool = candidates.length > 0 ? candidates : states.filter((s) => s.deliverability !== 'none');
	if (options.workspace && candidates.length === 0) throw new Error('该工作区下没有可投递会话: ' + options.workspace);
	if (pool.length === 0) throw new Error('当前没有可投递会话(窗口或 MCP 均已退出)');
	if (!options.workspace && pool.length > 1) {
		const active = pool.filter((s) => s.deliverability === 'active');
		if (active.length === 1) return active[0];
		throw new Error('存在多个可投递会话,请用 --session 或 --workspace 指定:\n' + pool.map((s) =>
			'  ' + s.id + '  ' + s.name + '  [' + s.deliverability + ']').join('\n'));
	}
	pool.sort((a, b) => (b.deliverability === 'active' ? 1 : 0) - (a.deliverability === 'active' ? 1 : 0));
	return pool[0];
}

/** 带锁的队列写入:与扩展面板、微信桥共用同一份 queue.json,避免并发读改写丢消息 */
function withQueueLock(dir, mutate) {
	const lockPath = path.join(dir, '.queue.lock');
	const deadline = Date.now() + 5000;
	let handle = null;
	while (!handle) {
		try {
			fs.mkdirSync(dir, { recursive: true });
			handle = fs.openSync(lockPath, 'wx');
		} catch (error) {
			if (error?.code !== 'EEXIST') throw error;
			try {
				const info = fs.statSync(lockPath);
				if (Date.now() - info.mtimeMs > 10_000) fs.rmSync(lockPath, { force: true });
			} catch { /* ignore */ }
			if (Date.now() >= deadline) throw new Error('获取队列锁超时: ' + lockPath);
			continue;
		}
	}
	try {
		const queuePath = path.join(dir, 'queue.json');
		const queue = readJson(queuePath) ?? [];
		const result = mutate(Array.isArray(queue) ? queue : []);
		writeJsonAtomic(queuePath, result);
		return result;
	} finally {
		try { fs.closeSync(handle); } catch { /* ignore */ }
		fs.rmSync(lockPath, { force: true });
	}
}

function buildMessage(dispatchId, content, urgent) {
	return {
		id: dispatchId,
		dispatch_id: dispatchId,
		type: 'text',
		content,
		images: [],
		timestamp: new Date().toISOString(),
		...(urgent ? { urgent: true } : {}),
	};
}

function enqueue(root, sid, message) {
	const dir = sessionDir(root, sid);
	return withQueueLock(dir, (queue) => {
		// 幂等:同 dispatch_id 已在队列里就不重复追加
		if (queue.some((item) => item?.dispatch_id === message.dispatch_id)) return queue;
		return [...queue, message];
	});
}

function hasBeenDelivered(root, sid, dispatchId) {
	const dir = sessionDir(root, sid);
	const inflight = readJson(path.join(dir, 'inflight.json'));
	if (inflight?.dispatch_id === dispatchId) return true;
	const history = readJson(path.join(dir, 'dispatch-history.json'));
	return !!history?.[dispatchId];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cmdDispatch(args) {
	const root = dataRoot();
	const task = args.task ?? (args._[0] ?? '');
	if (!task) throw new Error('缺少 --task <文本>');
	const dispatchId = args['dispatch-id'] ?? ('d-' + randomUUID().slice(0, 8));
	const states = snapshot(root);
	const session = resolveSession(states, { session: args.session, workspace: args.workspace });
	const message = buildMessage(dispatchId, task, !!args.urgent);
	// 幂等:同一个 dispatch_id 已经消费过(账本命中)就不再投递,避免重复执行
	if (hasBeenDelivered(root, session.id, dispatchId)) {
		console.log('dispatch_id=' + dispatchId + ' 已被该会话消费过,跳过重复投递');
		console.log('如需重跑,请使用新的 --dispatch-id');
		printSummary(root, session.id);
		return;
	}
	enqueue(root, session.id, message);

	const startTs = Date.now();
	console.log('已派发 dispatch_id=' + dispatchId);
	console.log('会话 ' + session.id + ' (' + session.name + ')  [' + session.deliverability + ']');
	console.log('workspace ' + session.workspace);
	if (session.deliverability === 'idle') console.log('提示: 该会话当前没有长轮询在跑,消息会在 Agent 下一轮 check_messages 时被消费');
	if (session.deliverability === 'none') console.log('警告: 该会话所属窗口已退出,消息无人消费(需要先恢复窗口/新对话并粘贴恢复规则)');

	if (!args.wait) {
		console.log('查看进度: node scripts/ms-dispatch.mjs status --session ' + session.id);
		return;
	}

	const timeoutMs = Number(args.timeout ?? 300) * 1000;
	const deadline = startTs + timeoutMs;
	let delivered = false;
	let redeliveries = 0;
	let lastNote = '';
	while (Date.now() < deadline) {
		const statesNow = snapshot(root);
		const current = statesNow.find((s) => s.id === session.id);
		if (!current) throw new Error('会话已消失: ' + session.id);
		delivered = hasBeenDelivered(root, session.id, dispatchId) || delivered;
		if (delivered && !lastNote.startsWith('已送达')) {
			lastNote = '已送达';
			console.log('[' + new Date().toLocaleTimeString() + '] 已送达(Agent 已领取任务)');
		}
		if (current.inflight?.dispatchId === dispatchId && current.inflight.completedAt) {
			console.log('[' + new Date().toLocaleTimeString() + '] 本轮结束 (completed_by=' + current.inflight.completedBy + ')');
			printSummary(root, session.id);
			return;
		}
		if (delivered && current.lastSummaryAt && current.lastSummaryAt > startTs) {
			console.log('[' + new Date().toLocaleTimeString() + '] 收到回复');
			printSummary(root, session.id);
			return;
		}
		if (delivered && current.inflight?.dispatchId === dispatchId && !current.inflight.ownerAlive
			&& Date.now() - (current.inflight.consumedAt ?? 0) > WORKER_LOST_AFTER_MS) {
			console.log('[' + new Date().toLocaleTimeString() + '] 断连: 处理进程已退出且任务未收尾');
			console.log('处理建议: 在该会话粘贴「恢复规则」重新建立长轮询,插件会把未完成任务交还 Agent 续做(replay_count=' + current.inflight.replayCount + ')');
			return;
		}
		if (!delivered && redeliveries < 3 && Date.now() - startTs > (redeliveries + 1) * REDELIVER_AFTER_MS
			&& current.deliverability === 'active') {
			redeliveries++;
			enqueue(root, session.id, buildMessage(dispatchId, task, !!args.urgent));
			console.log('[' + new Date().toLocaleTimeString() + '] 未送达,已按同 dispatch_id 重发第 ' + redeliveries + ' 次(幂等)');
		}
		if (!delivered && current.deliverability === 'none') {
			console.log('[' + new Date().toLocaleTimeString() + '] 无可消费窗口(会话窗口已退出),停止等待');
			return;
		}
		await sleep(500);
	}
	console.log('等待超时(' + (timeoutMs / 1000) + 's): ' + (delivered ? '已送达但未收到回复' : '仍未送达'));
}

function printSummary(root, sid) {
	const summary = readJson(path.join(sessionDir(root, sid), 'summary.json'));
	if (summary?.text) {
		console.log('--- 最近一次回复摘要 ---');
		console.log(summary.text);
	}
}

function cmdSessions(args) {
	const root = dataRoot();
	const states = snapshot(root);
	if (args.json) { console.log(JSON.stringify(states, null, 2)); return; }
	if (states.length === 0) { console.log('没有会话'); return; }
	console.log('数据根: ' + root);
	for (const s of states) {
		const age = Math.round((Date.now() - s.lastActiveAt) / 60000);
		console.log([
			s.deliverability.padEnd(6),
			s.id.padEnd(22),
			(s.name ?? '').padEnd(18),
			'queue=' + s.queueLength,
			s.awaitingReply ? 'awaiting_reply' : 'idle',
			s.inflight?.dispatchId ? ('inflight=' + s.inflight.dispatchId + (s.inflight.completedAt ? '(done)' : '')) : '',
			age + 'm ago',
		].filter(Boolean).join('  '));
	}
}

function cmdStatus(args) {
	const root = dataRoot();
	const states = snapshot(root);
	const targets = args.session
		? states.filter((s) => s.id === args.session || (s.name ?? '') === args.session)
		: states;
	if (targets.length === 0) throw new Error('没有匹配的会话');
	const report = targets.map((s) => {
		const working = s.inflight && !s.inflight.completedAt;
		return {
			session: s.id,
			name: s.name,
			deliverability: s.deliverability,
			queueLength: s.queueLength,
			awaitingReply: s.awaitingReply,
			inflight: s.inflight,
			verdict: !working ? 'idle'
				: (s.inflight.ownerAlive === false ? 'disconnected(进程已退出,待续做)' : 'working'),
		};
	});
	if (args.json) { console.log(JSON.stringify(report, null, 2)); return; }
	for (const r of report) {
		console.log(r.session + '  ' + r.name + '  [' + r.deliverability + ']  ' + r.verdict
			+ '  queue=' + r.queueLength
			+ (r.inflight?.dispatchId ? '  dispatch=' + r.inflight.dispatchId + ' replay=' + r.inflight.replayCount : ''));
	}
}

function parseArgs(argv) {
	const args = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token.startsWith('--')) { args._.push(token); continue; }
		const key = token.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) { args[key] = true; continue; }
		args[key] = next;
		i++;
	}
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const command = args._.shift() ?? 'sessions';
	if (command === 'sessions') return cmdSessions(args);
	if (command === 'dispatch') return cmdDispatch(args);
	if (command === 'status') return cmdStatus(args);
	if (command === 'help' || args.help) {
		console.log('用法: ms-dispatch <sessions|dispatch|status> [选项]');
		console.log('  dispatch --task <文本> [--session <id|名称>] [--workspace <路径>] [--dispatch-id <id>] [--urgent] [--wait] [--timeout 秒]');
		return;
	}
	throw new Error('未知命令: ' + command);
}

main().catch((error) => {
	console.error('错误: ' + (error?.message ?? error));
	process.exit(1);
});
