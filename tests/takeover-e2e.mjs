#!/usr/bin/env node
/**
 * 接管协议端到端验证(不依赖 Cursor GUI,不触碰在用数据根)。
 *
 * 用临时 MULTISESSION_DATA_ROOT 启动真实 dist/mcp-server.mjs,按文件协议派发任务,验证:
 *   1. 派发 → 消费 → 在飞记账(inflight/status)
 *   2. 同 dispatch_id 断连重发 → 幂等去重,不重复执行
 *   3. 处理中进程退出(断连) → 新进程恢复后把未完成任务交还 Agent 续做
 *   4. 回复收尾 → inflight 标记完成,status.awaiting_reply 归位
 *
 * 用法: npm run test:e2e
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER_PATH = path.join(REPO_ROOT, 'dist', 'mcp-server.mjs');
const CLI_PATH = path.join(REPO_ROOT, 'scripts', 'ms-dispatch.mjs');

let failures = 0;
let checks = 0;

function check(condition, label) {
	checks++;
	if (condition) {
		console.log('  PASS ' + label);
	} else {
		failures++;
		console.log('  FAIL ' + label);
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJson(file) {
	try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

function writeJson(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function sessionDir(root, sid) {
	return path.join(root, 'sessions', sid);
}

/** 进程是否还活着(僵尸进程在被回收前仍算存在,故续做判定前需等它真正消失) */
function isPidAlive(pid) {
	if (!pid || pid <= 0) return false;
	try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/** 以临时数据根跑一遍派发 CLI,返回 { code, stdout, stderr } */
function runCli(root, args, timeoutMs = 30000) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [CLI_PATH, ...args], {
			cwd: REPO_ROOT,
			env: { ...process.env, MULTISESSION_DATA_ROOT: root },
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => { stdout += chunk; });
		child.stderr.on('data', (chunk) => { stderr += chunk; });
		const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
		child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
	});
}

async function waitFor(predicate, label, timeoutMs = 8000, intervalMs = 100) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		let value;
		try { value = await predicate(); } catch { value = undefined; }
		if (value) return value;
		await sleep(intervalMs);
	}
	throw new Error('等待超时: ' + label);
}

/** 启动一个 MCP 进程,返回 client + transport + pid */
async function startServer(root) {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [SERVER_PATH],
		env: { ...process.env, MULTISESSION_DATA_ROOT: root },
	});
	const client = new Client({ name: 'takeover-e2e', version: '1.0.0' }, { capabilities: {} });
	await client.connect(transport);
	const pid = transport.pid ?? transport._process?.pid;
	return { client, transport, pid };
}

async function stopServer(server) {
	try { await server.transport.close(); } catch { /* ignore */ }
}

/** 派发一条任务消息(模拟外部编排器按文件协议写入) */
function dispatch(root, sid, dispatchId, content, extra = {}) {
	const queuePath = path.join(sessionDir(root, sid), 'queue.json');
	const queue = readJson(queuePath) ?? [];
	queue.push({
		id: 'msg-' + dispatchId,
		type: 'text',
		dispatch_id: dispatchId,
		content,
		timestamp: new Date().toISOString(),
		...extra,
	});
	writeJson(queuePath, queue);
	return queuePath;
}

async function main() {
	if (!fs.existsSync(SERVER_PATH)) {
		throw new Error('未找到 ' + SERVER_PATH + ',请先运行 npm run build');
	}

	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-takeover-e2e-'));
	const realRoot = path.join(os.homedir(), '.multisession');
	const realSessionsPath = path.join(realRoot, 'sessions.json');

	console.log('隔离数据根: ' + root);

	console.log('[1] 派发 → 消费 → 在飞记账');
	const p1 = await startServer(root);
	const poll1 = p1.client.callTool(
		{ name: 'check_messages', arguments: {} },
		undefined,
		{ timeout: 60000 },
	);
	const sid = await waitFor(() => {
		const sessions = readJson(path.join(root, 'sessions.json'));
		return sessions?.find((s) => s.alive)?.id;
	}, 'session 注册');
	check(typeof sid === 'string' && sid.length > 0, '会话已注册: ' + sid);

	dispatch(root, sid, 'd-1', 'E2E 任务 A:输出当前目录名');
	const first = await poll1;
	const firstText = first.content?.[0]?.text ?? '';
	check(firstText.includes('E2E 任务 A'), 'Agent 收到派发任务原文');

	const inflight = readJson(path.join(sessionDir(root, sid), 'inflight.json'));
	check(inflight?.dispatch_id === 'd-1', 'inflight 记录 dispatch_id=d-1');
	check(!inflight?.completed_at, 'inflight 处于未完成状态');
	const status1 = readJson(path.join(sessionDir(root, sid), 'status.json'));
	check(status1?.awaiting_reply === true, 'status.awaiting_reply=true');
	check(status1?.message_id === 'msg-d-1', 'status.message_id 对齐派发消息');
	check(typeof status1?.last_heartbeat_at === 'number', 'status.last_heartbeat_at 已写入');

	console.log('[2] 同 dispatch_id 断连重发 → 幂等去重');
	dispatch(root, sid, 'd-1', 'E2E 任务 A:输出当前目录名');
	const poll2Promise = p1.client.callTool(
		{ name: 'check_messages', arguments: { session_id: sid, reply: '任务 A 完成' } },
		undefined,
		{ timeout: 60000 },
	);
	await waitFor(() => {
		const queue = readJson(path.join(sessionDir(root, sid), 'queue.json'));
		return Array.isArray(queue) && queue.length === 0;
	}, '重复派发被清理');
	check(true, '重复 dispatch_id 已从队列清除(未再次投递)');
	const history = readJson(path.join(sessionDir(root, sid), 'dispatch-history.json'));
	check(history?.['d-1']?.completed_by === 'reply', 'dispatch-history 记录完成方式=reply');
	const inflight2 = readJson(path.join(sessionDir(root, sid), 'inflight.json'));
	check(!!inflight2?.completed_at, 'inflight 已收尾');

	console.log('[3] 处理中进程退出 → 新进程续做未完成任务');
	// [2] 的长轮询仍挂在同一会话上,用它消费任务 B(单一长轮询,避免两个 poll 抢消息)
	dispatch(root, sid, 'd-2', 'E2E 任务 B:统计 tests 目录文件数');
	const second = await poll2Promise.catch(() => null);
	const taskBText = second?.content?.[0]?.text ?? '';
	check(taskBText.includes('E2E 任务 B'), '任务 B 已投递给 Agent');
	const inflightB = readJson(path.join(sessionDir(root, sid), 'inflight.json'));
	check(inflightB?.dispatch_id === 'd-2' && !inflightB?.completed_at, '任务 B 在飞未完成');

	await stopServer(p1);
	await waitFor(() => !isPidAlive(p1.pid), '处理中进程真正退出', 8000, 100);
	check(true, '已杀掉处理中进程(模拟断连,未回复) pid=' + p1.pid);

	console.log('[3.5] 派发方通过 CLI 判定断连');
	const cliStatus = await runCli(root, ['status', '--session', sid, '--json']);
	let cliReport = null;
	try { cliReport = JSON.parse(cliStatus.stdout); } catch { /* ignore */ }
	check(cliReport?.[0]?.verdict === 'disconnected(进程已退出,待续做)', 'CLI 判定断连待续做(而非 working)');
	check(cliReport?.[0]?.inflight?.dispatchId === 'd-2', '断连报告对齐未完成任务 d-2');
	check(cliReport?.[0]?.inflight?.ownerAlive === false, '断连判定依据 inflight.mcp_pid 已退出');
	check(cliReport?.[0]?.inflight?.replayCount === 0, '判定时尚未发生续做');
	const cliHuman = await runCli(root, ['status', '--session', sid]);
	check(cliHuman.stdout.includes('disconnected'), '人类可读输出同样标识断连');
	const cliSessions = await runCli(root, ['sessions']);
	check(cliSessions.code === 0, 'sessions 列表命令可正常执行');

	console.log('[4] 新进程恢复会话 → 未完成任务交还 Agent');
	const p2 = await startServer(root);
	const resumed = await p2.client.callTool(
		{ name: 'check_messages', arguments: { session_id: sid } },
		undefined,
		{ timeout: 20000 },
	);
	const resumedText = resumed.content?.[0]?.text ?? '';
	check(resumedText.includes('E2E 任务 B'), '续做消息包含未完成任务原文');
	check(resumedText.includes('续做请求'), '续做消息带明确语义');
	const inflightAfter = readJson(path.join(sessionDir(root, sid), 'inflight.json'));
	check(inflightAfter?.replay_count === 1, 'replay_count 记账为 1');
	check(inflightAfter?.mcp_pid === p2.pid, 'inflight 归属已转交给新进程 pid=' + p2.pid);
	check(!inflightAfter?.completed_at, '续做期间仍标记未完成');

	console.log('[5] 回复收尾 → 在飞状态归位');
	const finishing = p2.client.callTool(
		{ name: 'check_messages', arguments: { session_id: sid, reply: '任务 B 完成' } },
		undefined,
		{ timeout: 60000 },
	);
	await waitFor(() => readJson(path.join(sessionDir(root, sid), 'inflight.json'))?.completed_at, 'inflight 收尾');
	const inflightDone = readJson(path.join(sessionDir(root, sid), 'inflight.json'));
	check(inflightDone?.completed_by === 'reply', '完成方式=reply');
	const statusDone = readJson(path.join(sessionDir(root, sid), 'status.json'));
	check(statusDone?.awaiting_reply === false, 'status.awaiting_reply 归位 false');
	const summary = readJson(path.join(sessionDir(root, sid), 'summary.json'));
	check(summary?.text === '任务 B 完成', 'summary 记录本轮回复');
	const chatLog = readJson(path.join(sessionDir(root, sid), 'chat-log.json'));
	check(Array.isArray(chatLog) && chatLog.some((e) => e.role === 'assistant' && e.text === '任务 B 完成'), 'chat-log 记录 assistant 回复');

	await stopServer(p2);
	finishing.catch(() => null);

	console.log('[6] 数据根隔离');
	// 在用数据根由正在运行的 Cursor 实例持续写入,mtime 不足以判定;比对内容里是否出现测试会话
	const realText = fs.existsSync(realSessionsPath) ? fs.readFileSync(realSessionsPath, 'utf-8') : '';
	check(!realText.includes(sid), '在用数据根未出现测试会话');
	check(fs.existsSync(path.join(root, 'sessions.json')), '所有状态写入临时数据根');

	fs.rmSync(root, { recursive: true, force: true });
	console.log('结果: ' + (checks - failures) + '/' + checks + ' 通过');
	if (failures > 0) {
		console.log('存在失败项');
		process.exit(1);
	}
	console.log('接管 + 断连恢复协议验证通过');
}

main().catch((error) => {
	console.error('验证失败: ' + (error?.message ?? error));
	process.exit(1);
});
