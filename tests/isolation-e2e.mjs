#!/usr/bin/env node
/**
 * 会话隔离回归验证(不依赖 Cursor GUI,不触碰在用数据根)。
 *
 * 覆盖 tryAdoptOrphan 的四个关键边界:
 *   A. 同窗口同 MCP 进程里,另一个对话正在干活时,不带 session_id 的首次调用不得抢走它的会话
 *   B. 旧会话心跳仍新鲜但持有进程已死 → 仍不得被新对话抢走;原对话带 session_id 回来必须能续做
 *   C. 会话确实失活(在飞任务已收尾 + 心跳过期 + 窗口 token 不再活跃)→ 仍要能被回收,不丢恢复能力
 *   D. 跨工作空间不得互相认领
 *
 * 用法: node tests/isolation-e2e.mjs(已挂在 npm run test:e2e)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER_PATH = path.join(REPO_ROOT, 'dist', 'mcp-server.mjs');

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

function readSessions(root) {
	return readJson(path.join(root, 'sessions.json')) ?? [];
}

async function waitFor(predicate, label, timeoutMs = 8000, intervalMs = 80) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		let value;
		try { value = await predicate(); } catch { value = undefined; }
		if (value) return value;
		await sleep(intervalMs);
	}
	throw new Error('等待超时: ' + label);
}

/** 启动一个 MCP 进程。cwd 即该进程认作的工作区(与 Cursor 行为一致) */
async function startServer(root, cwd, name, extraEnv = {}) {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [SERVER_PATH],
		cwd,
		env: { ...process.env, MULTISESSION_DATA_ROOT: root, ...extraEnv },
	});
	const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
	await client.connect(transport);
	return { client, transport, pid: transport.pid ?? transport._process?.pid };
}

async function stopServer(server) {
	try { await server.transport.close(); } catch { /* ignore */ }
}

/** 发起一次长轮询;调用方不 await 时不会因超时抛未捕获异常 */
function startPoll(server, args) {
	const promise = server.client.callTool({ name: 'check_messages', arguments: args }, undefined, { timeout: 60000 });
	promise.catch(() => null);
	return promise;
}

/** active-window 条目 15s 过期,每次 claim 前用最新时间戳写入 */
function seedWindows(root, map) {
	const now = Date.now();
	const data = {};
	for (const [workspace, tokens] of Object.entries(map)) {
		data[workspace] = tokens.map((token) => ({ token, timestamp: now, pid: process.pid }));
	}
	writeJson(path.join(root, 'active-window.json'), data);
}

function dispatch(root, sid, dispatchId, content) {
	const queuePath = path.join(sessionDir(root, sid), 'queue.json');
	const queue = readJson(queuePath) ?? [];
	queue.push({
		id: 'msg-' + dispatchId,
		type: 'text',
		dispatch_id: dispatchId,
		content,
		timestamp: new Date().toISOString(),
	});
	writeJson(queuePath, queue);
}

/** 直接改写 status,模拟「心跳仍在续期」或「心跳已过期」的持有状态 */
function setHeartbeat(root, sid, ageMs) {
	writeJson(path.join(sessionDir(root, sid), 'status.json'), {
		status: 'processing',
		last_heartbeat_at: Date.now() - ageMs,
		awaiting_reply: false,
	});
}

function textOf(result) {
	return result?.content?.[0]?.text ?? '';
}

async function main() {
	if (!fs.existsSync(SERVER_PATH)) {
		throw new Error('未找到 ' + SERVER_PATH + ',请先运行 npm run build');
	}

	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-isolation-e2e-'));
	// realpath:macOS 下 mkdtemp 位于 /var → /private/var,进程 cwd 会是解析后的路径
	const ws1 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ms-iso-ws1-')));
	const ws2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ms-iso-ws2-')));
	const realSessionsPath = path.join(os.homedir(), '.multisession', 'sessions.json');
	const realBefore = fs.existsSync(realSessionsPath) ? fs.statSync(realSessionsPath).mtimeMs : 0;
	const servers = [];
	const start = async (cwd, name) => {
		const server = await startServer(root, cwd, name);
		servers.push(server);
		return server;
	};
	const startAsWindow = async (cwd, name, windowPid) => {
		const server = await startServer(root, cwd, name, { MULTISESSION_WINDOW_PID: String(windowPid) });
		servers.push(server);
		return server;
	};

	console.log('隔离数据根: ' + root);
	console.log('工作区: ' + ws1 + ' / ' + ws2);

	try {
		console.log('[A] 同窗口同进程:干活中的会话不可被新对话抢走');
		seedWindows(root, { [ws1]: ['w-a', 'w-b'] });
		const p1 = await start(ws1, 'iso-p1');
		const firstPoll = startPoll(p1, {});
		const sid1 = await waitFor(() => readSessions(root).find((s) => s.alive)?.id, '会话注册');
		const meta1 = readSessions(root).find((s) => s.id === sid1);
		check(meta1?.windowToken === 'w-a', '会话已注册并绑定窗口 token w-a');

		dispatch(root, sid1, 'iso-d1', '隔离任务 A:对话 A 正在干活');
		const delivered = await firstPoll;
		check(textOf(delivered).includes('隔离任务 A'), '对话 A 收到任务');
		const inflightA = readJson(path.join(sessionDir(root, sid1), 'inflight.json'));
		check(!!inflightA && inflightA.dispatch_id === 'iso-d1' && !inflightA.completed_at, '对话 A 进入在飞状态(正在干活)');

		startPoll(p1, {}); // 同窗口新对话:同进程、不带 session_id
		const sessionsAfterB = await waitFor(
			() => { const all = readSessions(root); return all.length > 1 ? all : null; },
			'新对话应新建会话',
		);
		const sid2 = sessionsAfterB.find((s) => s.id !== sid1)?.id;
		check(!!sid2, '新对话新建了独立会话 ' + sid2);
		check(sessionsAfterB.find((s) => s.id === sid2)?.windowToken === 'w-a', '新会话同属该窗口(同 token)');
		const inflightA2 = readJson(path.join(sessionDir(root, sid1), 'inflight.json'));
		check(!!inflightA2 && !inflightA2.completed_at && inflightA2.dispatch_id === 'iso-d1', '对话 A 的在飞任务未被抢走');
		check(readSessions(root).length === 2, '未产生多余会话(' + readSessions(root).length + ')');

		console.log('[B] 心跳仍新鲜但持有进程已死:不可抢,原对话仍可续做');
		await stopServer(p1);
		await sleep(200);
		writeJson(path.join(root, 'mcp-claims.json'), []); // 旧进程 claim 失效
		seedWindows(root, { [ws1]: ['w-a'] });
		setHeartbeat(root, sid1, 0); // 旧会话心跳仍在续期窗口内
		const p2 = await start(ws1, 'iso-p2');
		startPoll(p2, {});
		const sessionsAfterC = await waitFor(
			() => { const all = readSessions(root); return all.length > 2 ? all : null; },
			'不得收编心跳新鲜的会话',
		);
		const sid3 = sessionsAfterC.find((s) => s.id !== sid1 && s.id !== sid2)?.id;
		check(!!sid3, '未收编心跳新鲜的旧会话,而是新建 ' + sid3);
		const inflightB = readJson(path.join(sessionDir(root, sid1), 'inflight.json'));
		check(!!inflightB && !inflightB.completed_at, '旧会话仍在飞(未被新对话接管)');

		const resumed = await p2.client.callTool(
			{ name: 'check_messages', arguments: { session_id: sid1 } },
			undefined,
			{ timeout: 20000 },
		);
		check(textOf(resumed).includes('隔离任务 A'), '原对话带 session_id 回来仍能续做未完成任务');
		check(textOf(resumed).includes(sid1), '续做响应带正确的 session_id');

		console.log('[C] 确实失活:仍可被回收');
		const inflightC = readJson(path.join(sessionDir(root, sid1), 'inflight.json')) ?? {};
		writeJson(path.join(sessionDir(root, sid1), 'inflight.json'), { ...inflightC, completed_at: Date.now(), completed_by: 'e2e-cleanup' });
		setHeartbeat(root, sid1, 60000);
		const meta = readSessions(root);
		meta.find((s) => s.id === sid1).lastActiveAt = Date.now() - 60000;
		writeJson(path.join(root, 'sessions.json'), meta);
		await stopServer(p2);
		await sleep(200);
		writeJson(path.join(root, 'mcp-claims.json'), []);
		seedWindows(root, { [ws1]: ['w-c'] }); // 旧窗口 token 不再活跃
		dispatch(root, sid1, 'iso-d2', '隔离任务 C:回收后派发');
		const p3 = await start(ws1, 'iso-p3');
		// 队列非空:回收后应直接消费本会话队列里的任务(不再走空队列的恢复提示分支)
		const reclaimed = await Promise.race([startPoll(p3, {}), sleep(10000).then(() => null)]);
		check(!!reclaimed, '失活会话在 10s 内被回收并消费任务');
		const reclaimedText = textOf(reclaimed);
		check(reclaimedText.includes(sid1), '失活会话已被回收(轮询落在原会话)');
		if (!reclaimedText.includes('隔离任务 C')) {
			console.log('    实际返回: ' + JSON.stringify(reclaimedText.slice(0, 200)));
		}
		check(reclaimedText.includes('隔离任务 C'), '回收后的会话能收到新任务');
		check(readSessions(root).length === 3, '回收未产生多余会话(' + readSessions(root).length + ')');

		console.log('[D] 跨工作空间不得互相认领');
		const p4 = await start(ws2, 'iso-p4');
		startPoll(p4, {});
		const metaWs2 = await waitFor(
			() => readSessions(root).find((s) => s.workspace === ws2),
			'ws2 应新建自己的会话',
		);
		check(metaWs2.workspace === ws2, '新工作空间新建独立会话,未认领 ws1 的会话');
		const metaWs1 = readSessions(root).find((s) => s.id === sid1);
		check(metaWs1?.workspace === ws1, 'ws1 会话保持原工作区归属');

		console.log('[F] MCP 认自己窗口的 token(文件夹重叠也不串)');
		// 两个窗口都打开了 ws1,另一个窗口的 token 更新;旧逻辑取"最新未被占用"的 token,
		// 会把本窗口 MCP 绑到别的窗口,本窗口创建的会话就被记到别的窗口名下。
		const mineToken = 'w-mine-window';
		const otherToken = 'w-other-window';
		const mineExtPid = 90001;
		const otherExtPid = 90002;
		for (const server of servers) await stopServer(server);
		servers.length = 0;
		await sleep(200);
		writeJson(path.join(root, 'mcp-claims.json'), []);
		const nowTs = Date.now();
		writeJson(path.join(root, 'active-window.json'), {
			[ws1]: [
				{ token: mineToken, timestamp: nowTs - 5000, pid: mineExtPid, windowPid: 700001 },
				{ token: otherToken, timestamp: nowTs, pid: otherExtPid, windowPid: 700002 },
			],
		});
		const p5 = await startAsWindow(ws1, 'iso-p5', 700001);
		startPoll(p5, {});
		const mineSession = await waitFor(
			() => readSessions(root).find(s => s.windowToken === mineToken || s.windowToken === otherToken),
			'新窗口应注册会话',
		);
		check(mineSession.windowToken === mineToken, 'MCP 绑定了自己窗口的 token(' + mineSession.windowToken + ')');
		check(mineSession.windowOwnerPid === mineExtPid, '会话记录了所属窗口扩展宿主 pid(' + mineSession.windowOwnerPid + ')');
		check(mineSession.windowPid === 700001, '会话记录了所属窗口主进程 pid(' + mineSession.windowPid + ')');
		const claims = readJson(path.join(root, 'mcp-claims.json')) ?? [];
		check(claims.some(c => c.windowToken === mineToken), 'claim 落在自己窗口的 token 上');

		console.log('[G] 无归属消息不再自动投递给任意会话');
		writeJson(path.join(root, 'sessions', 'default', 'queue.json'), [
			{ id: 'msg-unrouted', type: 'text', content: '无归属消息:不该被投递给任何会话', timestamp: new Date().toISOString() },
		]);
		for (const server of servers) await stopServer(server);
		servers.length = 0;
		await sleep(200);
		writeJson(path.join(root, 'mcp-claims.json'), []);
		seedWindows(root, { [ws1]: ['w-fresh'] });
		const p6 = await start(ws1, 'iso-p6');
		startPoll(p6, {});
		const sessionsG = await waitFor(
			() => { const all = readSessions(root); return all.some(s => s.windowToken === 'w-fresh') ? all : null; },
			'新会话注册',
		);
		const fresh = sessionsG.find(s => s.windowToken === 'w-fresh');
		const freshQueue = readJson(path.join(sessionDir(root, fresh.id), 'queue.json')) ?? [];
		check(!freshQueue.some(m => m.id === 'msg-unrouted'), '无归属消息没有被投递给新会话');
		const defaultQueue = readJson(path.join(root, 'sessions', 'default', 'queue.json')) ?? [];
		check(defaultQueue.some(m => m.id === 'msg-unrouted'), '无归属消息仍在 default 队列(未丢失)');
		const unrouted = readJson(path.join(root, 'sessions', 'default', 'unrouted.json'));
		check(unrouted?.count >= 1, '写了未投递登记(unrouted.json)');

		console.log('[E] 数据根隔离');
		// 在用数据根由正在运行的 Cursor 实例持续写入,mtime 不足以判定;比对内容里是否出现测试会话
		const realText = fs.existsSync(realSessionsPath) ? fs.readFileSync(realSessionsPath, 'utf-8') : '';
		const leaked = [sid1, sid2, sid3, metaWs2.id].filter((sid) => sid && realText.includes(sid));
		check(leaked.length === 0, '在用数据根未出现测试会话' + (leaked.length ? '(' + leaked.join(',') + ')' : ''));
		check(fs.existsSync(path.join(root, 'sessions.json')), '所有状态写入临时数据根');
	} finally {
		for (const server of servers) await stopServer(server);
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(ws1, { recursive: true, force: true });
		fs.rmSync(ws2, { recursive: true, force: true });
	}

	console.log('结果: ' + (checks - failures) + '/' + checks + ' 通过');
	if (failures > 0) {
		console.log('存在失败项');
		process.exit(1);
	}
	console.log('会话隔离验证通过');
}

main().catch((error) => {
	console.error('验证失败: ' + (error?.message ?? error));
	process.exit(1);
});
