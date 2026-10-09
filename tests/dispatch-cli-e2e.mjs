#!/usr/bin/env node
/**
 * 接管工具(scripts/ms-dispatch.mjs)集成验证:
 *   Codex/脚本派发 → GUI 侧 MCP 消费 → 回复 → 派发方确认送达与回复。
 * 同样使用临时 MULTISESSION_DATA_ROOT,不触碰在用会话。
 *
 * 用法: node tests/dispatch-cli-e2e.mjs
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
	console.log((condition ? '  PASS ' : '  FAIL ') + label);
	if (!condition) failures++;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; } }
async function waitFor(predicate, label, timeoutMs = 10000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		let value;
		try { value = await predicate(); } catch { value = undefined; }
		if (value) return value;
		await sleep(100);
	}
	throw new Error('等待超时: ' + label);
}

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

async function main() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-cli-e2e-'));
	console.log('隔离数据根: ' + root);

	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [SERVER_PATH],
		env: { ...process.env, MULTISESSION_DATA_ROOT: root },
		cwd: REPO_ROOT,
	});
	const client = new Client({ name: 'cli-e2e', version: '1.0.0' }, { capabilities: {} });
	await client.connect(transport);

	const poll = client.callTool({ name: 'check_messages', arguments: {} }, undefined, { timeout: 60000 });
	const sid = await waitFor(() => (readJson(path.join(root, 'sessions.json')) ?? []).find((s) => s.alive)?.id, '会话注册');
	console.log('会话: ' + sid);

	console.log('[1] 通过 CLI 派发(--wait)');
	const cli = runCli(root, ['dispatch', '--session', sid, '--task', 'CLI 任务 C: 打印仓库根目录', '--dispatch-id', 'd-cli-1', '--wait', '--timeout', '25']);
	const received = await poll;
	const receivedText = received.content?.[0]?.text ?? '';
	check(receivedText.includes('CLI 任务 C'), 'GUI 侧 Agent 收到 CLI 派发的任务');

	console.log('[2] Agent 回复后派发方确认');
	const replyPoll = client.callTool(
		{ name: 'check_messages', arguments: { session_id: sid, reply: 'CLI 任务 C 完成' } },
		undefined,
		{ timeout: 60000 },
	);
	const cliResult = await cli;
	check(cliResult.stdout.includes('已派发 dispatch_id=d-cli-1'), 'CLI 输出派发标识');
	check(cliResult.stdout.includes('已送达'), 'CLI 判定已送达');
	check(cliResult.stdout.includes('收到回复') || cliResult.stdout.includes('本轮结束'), 'CLI 判定已收到回复');
	check(cliResult.stdout.includes('CLI 任务 C 完成'), 'CLI 打印回复摘要');
	check(cliResult.code === 0, 'CLI 正常退出');

	console.log('[3] 派发账本与幂等');
	const history = readJson(path.join(root, 'sessions', sid, 'dispatch-history.json'));
	check(history?.['d-cli-1']?.completed_by === 'reply', 'dispatch-history 记录 d-cli-1 完成');
	const cliDup = await runCli(root, ['dispatch', '--session', sid, '--task', 'CLI 任务 C: 打印仓库根目录', '--dispatch-id', 'd-cli-1']);
	const queueAfterDup = readJson(path.join(root, 'sessions', sid, 'queue.json')) ?? [];
	check(cliDup.stdout.includes('跳过重复投递'), 'CLI 依据账本拒绝重复派发');
	check(cliDup.code === 0 && queueAfterDup.length === 0, '同 dispatch_id 重复派发不会重新入队');

	console.log('[4] status 命令可判活');
	const status = await runCli(root, ['status', '--session', sid, '--json']);
	let parsed = null;
	try { parsed = JSON.parse(status.stdout); } catch { /* ignore */ }
	check(Array.isArray(parsed) && parsed[0]?.session === sid, 'status --json 返回会话状态');
	check(parsed?.[0]?.verdict === 'idle', '收尾后 verdict=idle');

	await transport.close();
	replyPoll.catch(() => null);
	fs.rmSync(root, { recursive: true, force: true });
	console.log('结果: ' + (checks - failures) + '/' + checks + ' 通过');
	if (failures > 0) process.exit(1);
	console.log('接管工具验证通过');
}

main().catch((error) => {
	console.error('验证失败: ' + (error?.message ?? error));
	process.exit(1);
});
