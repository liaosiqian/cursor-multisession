#!/usr/bin/env node
/**
 * tick 内存/CPU 归因测量(只读,不改动任何会话数据)。
 *
 * 复现扩展 tick() 的读盘模式:每 500ms 对每个会话 readFileSync + JSON.parse(chat-log.json)。
 * 对比两种实现,分别在**独立进程**里跑,避免相互污染:
 *   A 现状:每次整份解析(解析结果随后丢弃,但分配过程持续制造垃圾)
 *   B 修复:mtime+size 未变化时跳过解析(等价于扩展侧 readFileIfChanged)
 *
 * 用法: node --expose-gc tests/memory-tick-bench.mjs [每阶段秒数]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const MAX_VISIBLE_LOGS = 50;
const TICK_MS = 500;
const DATA_ROOT = process.env.MULTISESSION_DATA_ROOT?.trim()
	? path.resolve(process.env.MULTISESSION_DATA_ROOT.trim())
	: path.join(os.homedir(), '.multisession');

function targetsFor(root) {
	const sessions = JSON.parse(fs.readFileSync(path.join(root, 'sessions.json'), 'utf-8'));
	return sessions
		.map((session) => path.join(root, 'sessions', session.id, 'chat-log.json'))
		.filter((file) => fs.existsSync(file))
		.map((file) => ({ file, size: fs.statSync(file).size }))
		.filter((target) => target.size > 100 * 1024)
		.sort((a, b) => b.size - a.size);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runPhase(mode, seconds) {
	const targets = targetsFor(DATA_ROOT);
	const cache = new Map();
	let bytesParsed = 0;
	let parseCount = 0;
	let readCount = 0;

	function readOnce(file, size) {
		readCount++;
		if (mode === 'B') {
			const stat = fs.statSync(file);
			const hit = cache.get(file);
			if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return;
			cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size });
		}
		const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
		bytesParsed += size;
		parseCount++;
		return raw.length > MAX_VISIBLE_LOGS ? raw.slice(-MAX_VISIBLE_LOGS) : raw;
	}

	if (global.gc) { global.gc(); await sleep(50); global.gc(); }
	const start = process.memoryUsage();
	let heapPeak = start.heapUsed;
	const t0 = process.hrtime.bigint();
	const ticks = Math.round((seconds * 1000) / TICK_MS);
	for (let tick = 0; tick < ticks; tick++) {
		for (const target of targets) readOnce(target.file, target.size);
		if (process.memoryUsage().heapUsed > heapPeak) heapPeak = process.memoryUsage().heapUsed;
		await sleep(TICK_MS);
	}
	const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
	if (global.gc) global.gc();
	await sleep(50);
	if (global.gc) global.gc();
	const end = process.memoryUsage();

	const label = mode === 'A' ? 'A 现状:每次整份解析' : 'B 修复:mtime+size 未变则跳过解析';
	console.log('[' + label + ']');
	console.log('  会话数 ' + targets.length + ' | tick ' + ticks + ' 次 | 读取 ' + readCount + ' 次 | 实际解析 ' + parseCount + ' 次');
	console.log('  实际解析 ' + (bytesParsed / 1048576).toFixed(1) + ' MB ( ' + (bytesParsed / 1048576 / (elapsedMs / 1000)).toFixed(1) + ' MB/s )');
	console.log('  heapUsed 起/峰/末(GC 后): ' + (start.heapUsed / 1048576).toFixed(1) + ' / ' + (heapPeak / 1048576).toFixed(1) + ' / ' + (end.heapUsed / 1048576).toFixed(1) + ' MB');
	console.log('  rss 起/末: ' + (start.rss / 1048576).toFixed(1) + ' / ' + (end.rss / 1048576).toFixed(1) + ' MB');
}

async function main() {
	const seconds = Number(process.argv[2] ?? 15);
	const mode = process.argv[3];
	if (mode === 'A' || mode === 'B') { await runPhase(mode, seconds); return; }

	const targets = targetsFor(DATA_ROOT);
	if (targets.length === 0) { console.log('没有超过 100KB 的 chat-log,无法测量'); return; }
	console.log('数据根: ' + DATA_ROOT);
	console.log('被测 chat-log(>100KB):共 ' + targets.length + ' 个 / '
		+ (targets.reduce((sum, t) => sum + t.size, 0) / 1048576).toFixed(1) + ' MB');
	for (const target of targets.slice(0, 6)) console.log('  ' + (target.size / 1048576).toFixed(2) + ' MB  ' + target.file);
	console.log('每阶段 ' + seconds + 's,tick 间隔 ' + TICK_MS + 'ms(两阶段分别在独立进程运行)');
	console.log('');
	for (const phaseMode of ['A', 'B']) {
		const result = spawnSync(process.execPath, ['--expose-gc', SELF, String(seconds), phaseMode], {
			env: process.env,
			stdio: 'inherit',
		});
		if (result.status !== 0) {
			console.error('阶段 ' + phaseMode + ' 运行失败,退出码 ' + result.status);
			process.exit(1);
		}
		console.log('');
	}
}

main().catch((error) => { console.error('测量失败: ' + (error?.message ?? error)); process.exit(1); });

