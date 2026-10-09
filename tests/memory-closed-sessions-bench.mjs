#!/usr/bin/env node
/**
 * 「已关闭会话是否持续占内存」对照测量。
 *
 * 在临时数据根里造 24 个会话(6 个仍可见 + 18 个已关闭),每个会话一份 ~0.4MB 的
 * chat-log.json,然后复现扩展 tick() 的两种读盘方式,分别在独立进程里跑并测量内存:
 *   A 旧实现:每 tick 对**所有**会话整份解析,派生结果缓存后从不淘汰
 *   B 新实现:只对可见会话读盘,且 mtime+size 未变则跳过解析;已关闭会话的缓存被淘汰
 *     B 阶段直接调用 src/shared/file-cache.ts 的真实现(编译产物 dist/file-cache.mjs),
 *     不是复刻一份等价算法 —— 否则测到的是模型,不是扩展里真正跑的代码。
 *
 * 用法: node tests/memory-closed-sessions-bench.mjs [每阶段秒数]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileCache } from '../dist/file-cache.mjs';

const SELF = fileURLToPath(import.meta.url);
const TICK_MS = 500;
const MAX_VISIBLE_LOGS = 50;
const VISIBLE_SESSIONS = 6;
const CLOSED_SESSIONS = 18;
const LOG_ENTRIES = 1200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-mem-closed-'));
	const sessions = [];
	const visible = [];
	const text = 'x'.repeat(360);
	for (let i = 0; i < VISIBLE_SESSIONS + CLOSED_SESSIONS; i++) {
		const id = 'sess-' + i;
		const dir = path.join(root, 'sessions', id);
		fs.mkdirSync(dir, { recursive: true });
		const log = [];
		for (let n = 0; n < LOG_ENTRIES; n++) {
			log.push({ role: n % 2 === 0 ? 'user' : 'assistant', text, ts: 1_700_000_000_000 + n });
		}
		fs.writeFileSync(path.join(dir, 'chat-log.json'), JSON.stringify(log));
		sessions.push({ id, name: id, workspace: '/tmp/bench', alive: i < VISIBLE_SESSIONS, createdAt: 0, lastActiveAt: 0 });
		if (i < VISIBLE_SESSIONS) visible.push(id);
	}
	fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify(sessions, null, 2));
	fs.writeFileSync(path.join(root, 'visible.json'), JSON.stringify(visible));
	return root;
}

async function runPhase(mode, seconds, root) {
	const sessions = JSON.parse(fs.readFileSync(path.join(root, 'sessions.json'), 'utf-8'));
	const visible = new Set(JSON.parse(fs.readFileSync(path.join(root, 'visible.json'), 'utf-8')));
	// B 阶段用扩展里的真实现;A 阶段(旧实现对照组)保留一份最小复刻
	const realCache = mode === 'B' ? createFileCache() : null;
	const cache = new Map();
	const lastPushed = new Map();
	let parseCount = 0;
	let bytesParsed = 0;

	function readSession(session) {
		const file = path.join(root, 'sessions', session.id, 'chat-log.json');
		const isVisible = visible.has(session.id);
		if (!isVisible && mode === 'B') {
			// 已关闭会话:面板不再显示,不读盘;它的缓存条目由每轮的淘汰清掉
			lastPushed.delete(session.id);
			return;
		}
		if (mode === 'B') {
			// 真实现:未变化直接复用上次派生结果,派生结果只留日志尾部窗口
			const window = realCache.read(file, (raw) => (Array.isArray(raw)
				? { logs: raw.slice(-MAX_VISIBLE_LOGS), totalCount: raw.length }
				: null));
			lastPushed.set(session.id, window ? window.logs.length : 0);
			return;
		}
		// A:旧实现,每次整份解析并保留派生结果,从不淘汰
		const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
		parseCount++;
		bytesParsed += fs.statSync(file).size;
		cache.set(file, { window: raw.slice(-MAX_VISIBLE_LOGS) });
		lastPushed.set(session.id, Math.min(raw.length, MAX_VISIBLE_LOGS));
	}

	if (global.gc) { global.gc(); await sleep(50); global.gc(); }
	const start = process.memoryUsage();
	let heapPeak = start.heapUsed;
	const t0 = process.hrtime.bigint();
	const ticks = Math.round((seconds * 1000) / TICK_MS);
	for (let tick = 0; tick < ticks; tick++) {
		// 扩展 tick 每轮按「仍可见会话」淘汰缓存(evictFileCacheForRemovedSessions)
		if (realCache) realCache.evictForRemovedSessions(visible);
		for (const session of sessions) readSession(session);
		const used = process.memoryUsage().heapUsed;
		if (used > heapPeak) heapPeak = used;
		await sleep(TICK_MS);
	}
	const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
	if (global.gc) global.gc();
	await sleep(50);
	if (global.gc) global.gc();
	const end = process.memoryUsage();

	const label = mode === 'A' ? 'A 旧实现:全部会话每 tick 整份解析,不淘汰' : 'B 新实现:只读可见会话 + mtime 跳过 + 淘汰已关闭会话';
	console.log('[' + label + ']');
	console.log('  会话 ' + sessions.length + ' 个(可见 ' + visible.size + ' / 已关闭 ' + (sessions.length - visible.size) + ') | tick ' + ticks + ' 次');
	const stats = realCache ? realCache.stats() : { parses: parseCount, bytes: bytesParsed, entries: cache.size };
	console.log('  实际解析 ' + stats.parses + ' 次 / ' + (stats.bytes / 1048576).toFixed(1) + ' MB ( ' + (stats.bytes / 1048576 / (elapsedMs / 1000)).toFixed(1) + ' MB/s )');
	console.log('  heapUsed 起/峰/末(GC 后): ' + (start.heapUsed / 1048576).toFixed(1) + ' / ' + (heapPeak / 1048576).toFixed(1) + ' / ' + (end.heapUsed / 1048576).toFixed(1) + ' MB');
	console.log('  rss 起/末: ' + (start.rss / 1048576).toFixed(1) + ' / ' + (end.rss / 1048576).toFixed(1) + ' MB');
	console.log('  留存缓存条目: ' + stats.entries + ' / 会话数 ' + sessions.length);
}

async function main() {
	const seconds = Number(process.argv[2] ?? 15);
	const mode = process.argv[3];
	const rootArg = process.env.MS_MEM_BENCH_ROOT;
	if (mode === 'A' || mode === 'B') {
		await runPhase(mode, seconds, rootArg);
		return;
	}

	const root = buildRoot();
	console.log('临时数据根: ' + root);
	console.log('每阶段 ' + seconds + 's,tick 间隔 ' + TICK_MS + 'ms,两阶段分别在独立进程运行');
	console.log('');
	for (const phaseMode of ['A', 'B']) {
		const result = spawnSync(process.execPath, ['--expose-gc', SELF, String(seconds), phaseMode], {
			env: { ...process.env, MS_MEM_BENCH_ROOT: root },
			stdio: 'inherit',
		});
		if (result.status !== 0) {
			console.error('阶段 ' + phaseMode + ' 失败,退出码 ' + result.status);
			process.exit(1);
		}
		console.log('');
	}
	fs.rmSync(root, { recursive: true, force: true });
}

main().catch((error) => { console.error('测量失败: ' + (error?.message ?? error)); process.exit(1); });
