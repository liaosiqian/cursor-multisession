#!/usr/bin/env node
// 计算 Cursor 工作区级 MCP 的审批键,格式为 project-序号-文件夹-服务名:配置哈希。
// Cursor 3.x 只有在审批列表里存在与当前配置哈希一致的条目时才启动工作区 MCP,
// 而哈希只覆盖 command/args/env/envFile/url/headers,所以换发布目录会让旧审批失效,
// 表现为 Cursor 静默不启动 MultiSession MCP(日志里连 createClient 都没有)。
// 用法: node scripts/mcp-approval-key.mjs --config <工作区/.cursor/mcp.json> [--server MultiSession] [--folder-index 0]
// 自检: node scripts/mcp-approval-key.mjs --selftest
import fs from 'node:fs';
import path from 'node:path';

function numberHash(value, seed) {
	return ((seed << 5) - seed + value) | 0;
}
function stringHash(str, seed) {
	let h = numberHash(149417, seed);
	for (let i = 0; i < str.length; i++) h = numberHash(str.charCodeAt(i), h);
	return h;
}
// 等价于 VS Code base/common/hash.ts 的 doHash(seed=0)
function valueHash(value, seed) {
	if (value === null) return numberHash(349, seed);
	if (Array.isArray(value)) {
		let h = numberHash(104579, seed);
		for (const item of value) h = valueHash(item, h);
		return h;
	}
	if (typeof value === 'object') {
		let h = numberHash(181387, seed);
		for (const key of Object.keys(value).sort()) {
			h = valueHash(value[key], stringHash(key, h));
		}
		return h;
	}
	if (typeof value === 'string') return stringHash(value, seed);
	if (typeof value === 'number') return numberHash(value, seed);
	if (typeof value === 'boolean') return numberHash(value ? 433 : 863, seed);
	if (typeof value === 'undefined') return numberHash(937, seed);
	return numberHash(617, seed);
}

/** 与 Cursor 的 computeServerConfigHash 一致 */
export function serverConfigHash(server) {
	const picked = {};
	for (const key of ['command', 'args', 'env', 'envFile', 'url', 'headers']) {
		if (key in server) picked[key] = server[key];
	}
	const hashed = valueHash(JSON.stringify(picked), 0);
	return hashed >= 0 ? hashed.toString(16).substring(0, 16) : '-' + (-hashed).toString(16).substring(0, 16);
}

export function approvalKey(serverName, server, folderName, folderIndex = 0) {
	return 'project-' + folderIndex + '-' + folderName + '-' + serverName + ':' + serverConfigHash(server);
}

function main() {
	const argv = process.argv.slice(2);
	const get = (flag) => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	if (argv.includes('--selftest')) {
		// 真实数据核对:viplevel 的配置在 Cursor 库里存的审批哈希是 -1f6487de
		const known = { command: 'node', args: ['/Users/lsq/.cursor/extensions/local.cursor-multisession-0.8.0/dist/mcp-server.mjs'] };
		const got = serverConfigHash(known);
		console.log('selftest 期望 -1f6487de, 实际 ' + got + ' -> ' + (got === '-1f6487de' ? 'PASS' : 'FAIL'));
		process.exit(got === '-1f6487de' ? 0 : 1);
	}
	const configPath = get('--config');
	if (!configPath) {
		console.error('用法: node scripts/mcp-approval-key.mjs --config <工作区/.cursor/mcp.json> [--server MultiSession] [--folder-index 0]');
		process.exit(2);
	}
	const serverName = get('--server') || 'MultiSession';
	const folderIndex = Number(get('--folder-index') || 0);
	const folderName = path.basename(path.dirname(path.dirname(path.resolve(configPath))));
	const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
	const server = config && config.mcpServers && config.mcpServers[serverName];
	if (!server) {
		console.error('未找到 mcpServers.' + serverName);
		process.exit(3);
	}
	console.log(approvalKey(serverName, server, folderName, folderIndex));
}

main();
