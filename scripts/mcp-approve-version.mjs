#!/usr/bin/env node
// 给某个发布目录的 MCP 服务端补审批项。
//
// 为什么需要:Cursor 只拉起点"审批哈希与当前 .cursor/mcp.json 一致"的工作区 MCP,
// 而哈希覆盖 command/args;扩展每次激活又会用自己所在目录(带版本号)的 dist/mcp-server.mjs
// 重写 mcp.json。于是换版本目录后旧审批立刻失效,表现是 Cursor 静默不启动 MultiSession MCP
// —— 日志里连 createClient 都没有,很容易误判成升级把插件弄坏了。
//
// 所以升级顺序是:窗口全退 → 本脚本预置新哈希 → 装 VSIX → 全启。
// 旧哈希条目保留,回退到旧版本时同样不需要重新审批。
//
// 用法:
//   node scripts/mcp-approve-version.mjs --mcp-server <绝对路径> [--user-data-dir <目录>]... [--dry-run]
//   不带 --user-data-dir 时处理 ~/.antigravity_cockpit/instances/cursor 下的全部实例。
//   --force 允许在实例仍在运行时写入(默认跳过并提示,因为运行中的 Cursor 可能覆盖这次写入)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { serverConfigHash } from './mcp-approval-key.mjs';

const INSTANCES_ROOT = path.join(os.homedir(), '.antigravity_cockpit', 'instances', 'cursor');
const DB_REL = path.join('User', 'globalStorage', 'state.vscdb');
const STATE_KEY = 'cursor/approvedProjectMcpServers';
const ENTRY_RE = /^(project-\d+-(.+)-MultiSession):(-?[0-9a-f]+)$/;

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const get = (flag) => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
};
const getAll = (flag) => argv.reduce((acc, v, i) => (v === flag && argv[i + 1] ? acc.concat(argv[i + 1]) : acc), []);

const mcpServer = get('--mcp-server');
if (!mcpServer) {
	console.error('用法: node scripts/mcp-approve-version.mjs --mcp-server <绝对路径> [--user-data-dir <目录>]... [--dry-run] [--force]');
	process.exit(2);
}
if (!path.isAbsolute(mcpServer)) {
	console.error('--mcp-server 必须是绝对路径(哈希对路径敏感): ' + mcpServer);
	process.exit(2);
}
const dryRun = has('--dry-run');
const force = has('--force');
const targetHash = serverConfigHash({ command: 'node', args: [mcpServer] });
console.log('MCP 服务端: ' + mcpServer);
console.log('目标哈希  : ' + targetHash);

function listInstances() {
	const explicit = getAll('--user-data-dir');
	if (explicit.length > 0) return explicit;
	if (!fs.existsSync(INSTANCES_ROOT)) return [];
	return fs.readdirSync(INSTANCES_ROOT)
		.map((name) => path.join(INSTANCES_ROOT, name))
		.filter((dir) => fs.existsSync(path.join(dir, DB_REL)));
}

/** 该实例的 Cursor 是否还在跑(按 --user-data-dir 精确匹配,避免误伤别的实例) */
function isRunning(userDataDir) {
	const out = spawnSync('ps', ['-eo', 'command'], { encoding: 'utf-8' }).stdout || '';
	return out.split('\n').some((line) => line.includes('--user-data-dir' + userDataDir + ' ') || line.endsWith('--user-data-dir ' + userDataDir) || line.includes('--user-data-dir ' + userDataDir + ' '));
}

function readValue(db) {
	const out = spawnSync('sqlite3', [db, 'select value from ItemTable where key=' + JSON.stringify(STATE_KEY) + ';'], { encoding: 'utf-8' });
	if (out.status !== 0) throw new Error('sqlite3 读取失败: ' + (out.stderr || '').trim());
	const text = (out.stdout || '').trim();
	return text || null;
}

function writeValue(db, value) {
	const escaped = value.replace(/'/g, "''");
	const sql = 'begin immediate; update ItemTable set value = \'' + escaped + '\' where key = \'' + STATE_KEY + '\'; commit;\n';
	const out = spawnSync('sqlite3', [db], { input: sql, encoding: 'utf-8' });
	if (out.status !== 0) throw new Error('sqlite3 写入失败: ' + (out.stderr || '').trim());
}

let touched = 0;
for (const dir of listInstances()) {
	const db = path.join(dir, DB_REL);
	const name = path.basename(dir);
	if (!fs.existsSync(db)) {
		console.log('[skip] ' + name + ' 没有 state.vscdb');
		continue;
	}
	if (isRunning(dir) && !force && !dryRun) {
		console.log('[skip] ' + name + ' 仍在运行(先退出该实例,或加 --force)');
		continue;
	}
	const raw = readValue(db);
	if (!raw) {
		console.log('[skip] ' + name + ' 没有 ' + STATE_KEY + ' 记录(该实例还没审批过任何工作区 MCP)');
		continue;
	}
	let list;
	try {
		list = JSON.parse(raw);
	} catch (e) {
		console.log('[skip] ' + name + ' 审批列表不是 JSON,未改动');
		continue;
	}
	if (!Array.isArray(list)) {
		console.log('[skip] ' + name + ' 审批列表不是数组,未改动');
		continue;
	}
	const next = list.slice();
	const seen = new Set(next);
	let added = 0;
	for (const entry of list) {
		const m = ENTRY_RE.exec(entry);
		if (!m) continue;
		if (m[3] === targetHash) continue;
		const candidate = m[1] + ':' + targetHash;
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		next.push(candidate);
		added++;
	}
	if (added === 0) {
		console.log('[ok]   ' + name + ' 已有目标哈希,无需改动');
		continue;
	}
	if (dryRun) {
		console.log('[dry]  ' + name + ' 将新增 ' + added + ' 条(总 ' + list.length + ' -> ' + next.length + ')');
		continue;
	}
	fs.copyFileSync(db, db + '.bak-' + Date.now());
	writeValue(db, JSON.stringify(next));
	const check = JSON.parse(readValue(db) || '[]');
	const ok = Array.isArray(check) && check.length === next.length && check.includes(next[next.length - 1]);
	console.log((ok ? '[ok]   ' : '[FAIL] ') + name + ' 已新增 ' + added + ' 条(总 ' + list.length + ' -> ' + check.length + ')');
	touched++;
}
console.log(dryRun ? 'dry-run 结束,未写入任何文件' : '完成,改写了 ' + touched + ' 个实例(各自已留 .bak 备份)');
