#!/usr/bin/env node
/**
 * 跨进程 JSON 读改写的锁单测 —— 「会话在窗口之间跳动」这条修复的确定性断言。
 *
 * 背景:active-window.json 由多个 Cursor 窗口的扩展宿主共同维护,各进程都做
 * 「读整份 → 改自己那条 → 整份写回」。没有互斥时,两个进程同时读、先后写,
 * 后写的一方会把对方这次的心跳丢掉,对方窗口的条目凭空消失一个心跳周期,
 * 期间别的窗口可能把它的会话认领过去。
 *
 * 测的是 src/shared/locked-json.ts 的编译产物(扩展宿主写窗口心跳走的就是它):
 *   1. 首次写入:文件不存在时能创建,写完释放锁、不留临时文件
 *   2. mutate 返回 undefined 表示本次不写回(不创建文件、不改已有文件)
 *   3. 多进程并发各自维护自己的条目,结束后每一个条目都不丢;锁内区间严格互斥
 *   4. 陈旧锁(持有者已死)会被回收,不会永久阻塞
 *   5. 锁被活持有者拿着时是等待而不是硬抢,超时则报错且不写坏文件
 *   6. 对照组:同样的并发交错下,无锁实现确实会丢更新 —— 证明本测试场景有效
 *
 * 用法: node tests/locked-json-unit.mjs(需先 npm run compile:shared)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { updateJsonLocked, readJsonFile, writeJsonAtomic } from '../dist/locked-json.mjs';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOCKED_JSON_PATH = path.join(REPO_ROOT, 'dist', 'locked-json.mjs');

let failures = 0;
let checks = 0;
function check(condition, label) {
	checks++;
	console.log((condition ? '  PASS ' : '  FAIL ') + label);
	if (!condition) failures++;
}

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 子进程:每轮在锁内给自己的 key 自增,并把「锁内区间」写进共享顺序日志 */
const WORKER_SOURCE = `
import fs from 'node:fs';
import { updateJsonLocked } from __URL__;
const file = process.env.MS_LOCK_FILE;
const id = process.env.MS_WORKER_ID;
const rounds = Number(process.env.MS_ROUNDS);
const holdMs = Number(process.env.MS_HOLD_MS);
const orderFile = process.env.MS_ORDER_FILE;
const sleep = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
for (let i = 0; i < rounds; i++) {
	updateJsonLocked(file, (current) => {
		const next = { ...(current || {}) };
		next[id] = (next[id] || 0) + 1;
		fs.appendFileSync(orderFile, 'START ' + id + ' ' + Date.now() + '\\n');
		sleep(holdMs);
		fs.appendFileSync(orderFile, 'END ' + id + ' ' + Date.now() + '\\n');
		return next;
	});
	sleep(i % 3 === 0 ? 1 : 0);
}
`;

/** 活持有者:建锁、按住 holdMs 毫秒、然后自己释放 */
const HOLDER_SOURCE = [
	"const fs = require('fs');",
	"const lock = process.env.MS_LOCK_PATH;",
	"fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'alive', ts: Date.now() }));",
	"setTimeout(() => { try { fs.unlinkSync(lock); } catch {} }, Number(process.env.MS_HOLD_MS));",
].join('\n');

function runWorker(env) {
	return new Promise((resolve, reject) => {
		const source = WORKER_SOURCE.replace('__URL__', JSON.stringify(pathToFileURL(LOCKED_JSON_PATH).href));
		const child = spawn('node', ['--input-type=module', '-e', source], {
			env: { ...process.env, ...env },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stderr = '';
		child.stderr.on('data', (chunk) => { stderr += chunk; });
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) resolve();
			else reject(new Error('子进程退出码 ' + code + ': ' + stderr.trim()));
		});
	});
}

/** 起一个真的活持有者进程:建锁、按住 holdMs 毫秒、然后自己释放 */
async function startLockHolder(lockPath, holdMs) {
	const child = spawn('node', ['-e', HOLDER_SOURCE], {
		env: { ...process.env, MS_LOCK_PATH: lockPath, MS_HOLD_MS: String(holdMs) },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const deadline = Date.now() + 3000;
	while (!fs.existsSync(lockPath)) {
		if (Date.now() > deadline) throw new Error('活持有者未能在 3s 内建锁');
		sleepSync(5);
	}
	return child;
}

/** 只保留 START/END 行,校验互斥:任意时刻锁内至多一个写者 */
function checkLockIntervals(orderFile) {
	const rows = fs.readFileSync(orderFile, 'utf-8').split('\n')
		.filter((line) => line.startsWith('START') || line.startsWith('END'))
		.map((line) => { const [kind, id] = line.split(' '); return { kind, id }; });
	let open = 0;
	let overlap = 0;
	let handoffs = 0;
	let lastWriter = null;
	for (const row of rows) {
		if (row.kind === 'START') {
			if (open > 0) overlap++;
			open++;
			if (lastWriter && lastWriter !== row.id) handoffs++;
			lastWriter = row.id;
		} else {
			open--;
		}
	}
	return { rows: rows.length, overlap, handoffs };
}

async function main() {
	if (!fs.existsSync(LOCKED_JSON_PATH)) throw new Error('未找到 ' + LOCKED_JSON_PATH + ',请先运行 npm run compile:shared');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-locked-json-'));

	console.log('[1] 首次写入:能创建,写完释放锁且不留临时文件');
	const fileA = path.join(root, 'active-window.json');
	const wrote = updateJsonLocked(fileA, (current) => {
		check(current === null, '文件不存在时 mutate 收到 null(current=' + JSON.stringify(current) + ')');
		return { 'w-first': { at: 1 } };
	});
	check(wrote === true, '返回 true 表示确实写回');
	check(readJsonFile(fileA)?.['w-first']?.at === 1, '内容落盘正确');
	check(!fs.existsSync(fileA + '.lock'), '写完后锁文件已删除');
	check(fs.readdirSync(root).filter((name) => name.endsWith('.tmp')).length === 0, '目录里没有残留临时文件');
	check(fs.readFileSync(fileA, 'utf-8').includes('\t'), '写回是 tab 缩进的 JSON(与既有文件风格一致)');

	console.log('[2] mutate 返回 undefined 表示本次不写回');
	const missing = path.join(root, 'not-created.json');
	check(updateJsonLocked(missing, () => undefined) === false, '文件不存在且不写回时返回 false');
	check(!fs.existsSync(missing), '文件不存在且不写回时不创建文件');
	const before = fs.readFileSync(fileA, 'utf-8');
	const mtimeBefore = fs.statSync(fileA).mtimeMs;
	sleepSync(15);
	check(updateJsonLocked(fileA, () => undefined) === false, '已有文件且不写回时返回 false');
	check(fs.readFileSync(fileA, 'utf-8') === before && fs.statSync(fileA).mtimeMs === mtimeBefore, '已有文件的内容与 mtime 都没动');

	console.log('[3] 多进程并发维护各自条目:不丢更新且锁内严格互斥');
	const fileB = path.join(root, 'concurrent.json');
	const orderFile = path.join(root, 'order.log');
	const workers = ['w-a', 'w-b', 'w-c', 'w-d'];
	const rounds = 20;
	await Promise.all(workers.map((id) => runWorker({
		MS_LOCK_FILE: fileB,
		MS_WORKER_ID: id,
		MS_ROUNDS: String(rounds),
		MS_HOLD_MS: '20',
		MS_ORDER_FILE: orderFile,
	})));
	const merged = readJsonFile(fileB) ?? {};
	check(workers.every((id) => merged[id] === rounds), '每个窗口的条目都完整(实际=' + JSON.stringify(workers.map((id) => merged[id])) + ')');
	check(Object.keys(merged).length === workers.length, '没有凭空多出或被顶掉的条目');
	const intervals = checkLockIntervals(orderFile);
	check(intervals.overlap === 0, '锁内区间零重叠(overlap=' + intervals.overlap + ')');
	check(intervals.handoffs > 0, '确实发生过锁的交接,不是串行跑完的(handoffs=' + intervals.handoffs + ')');
	check(intervals.rows === workers.length * rounds * 2, '每条写回都记录了 START/END(' + intervals.rows + ' 行)');
	check(!fs.existsSync(fileB + '.lock'), '并发结束后没有残留锁');

	console.log('[4] 陈旧锁会被回收,不永久阻塞');
	const fileC = path.join(root, 'stale.json');
	fs.writeFileSync(fileC + '.lock', JSON.stringify({ pid: 999999, token: 'dead', ts: 0 }));
	const ancient = new Date(Date.now() - 60_000);
	fs.utimesSync(fileC + '.lock', ancient, ancient);
	check(updateJsonLocked(fileC, () => ({ recovered: true }), { timeoutMs: 1000 }) === true, '持有者已死的锁被回收并完成写入');
	check(readJsonFile(fileC)?.recovered === true, '内容正确');
	check(!fs.existsSync(fileC + '.lock'), '回收后锁文件被清理');

	console.log('[5] 活锁是等待而不是硬抢,超时报错且不写坏文件');
	const fileD = path.join(root, 'busy.json');
	writeJsonAtomic(fileD, { keep: 'unchanged' });
	fs.writeFileSync(fileD + '.lock', JSON.stringify({ pid: process.pid, token: 'alive', ts: Date.now() }));
	let timedOut = null;
	try {
		updateJsonLocked(fileD, () => ({ keep: 'clobbered' }), { timeoutMs: 150, staleMs: 60_000, retryMs: 10 });
	} catch (error) {
		timedOut = error;
	}
	check(!!timedOut && /等待文件锁超时/.test(timedOut.message), '活锁持有期间拿不到锁会抛超时');
	check(readJsonFile(fileD)?.keep === 'unchanged', '没有在没拿到锁的情况下写文件');
	check(fs.existsSync(fileD + '.lock'), '没有误删别人的活锁');
	check(readJsonFile(fileD)?.waited !== true, '超时路径同样没有写文件');
	fs.unlinkSync(fileD + '.lock');
	const holder = await startLockHolder(fileD + '.lock', 400);
	const startedAt = Date.now();
	const waited = updateJsonLocked(fileD, (current) => ({ ...current, waited: true }), { timeoutMs: 5000, staleMs: 60_000, retryMs: 10 });
	const waitedMs = Date.now() - startedAt;
	check(waited === true, '活持有者稍后释放时是等待成功,而不是超时或硬抢');
	check(waitedMs >= 150, '确实等了持有者(' + waitedMs + 'ms)');
	check(readJsonFile(fileD)?.waited === true, '拿到锁之后内容正确');
	await new Promise((resolve) => holder.on('close', resolve));
	check(!fs.existsSync(fileD + '.lock'), '持有者退出后锁已释放');

	console.log('[6] 对照组:无锁实现在同样的交错下会丢更新');
	const fileE = path.join(root, 'naive.json');
	writeJsonAtomic(fileE, {});
	// 无锁的读改写:读 → 改 → 写,中间不加锁
	const naive = (file, mutate) => {
		const current = readJsonFile(file);
		const next = mutate(current);
		if (next !== undefined) writeJsonAtomic(file, next);
	};
	const readA = readJsonFile(fileE);
	const readB = readJsonFile(fileE);
	naive(fileE, () => ({ ...readA, 'w-a': 1 }));
	naive(fileE, () => ({ ...readB, 'w-b': 1 }));
	check(readJsonFile(fileE)?.['w-a'] === undefined, '无锁交错:先写一方的心跳被后写一方覆盖(丢更新复现)');
	const fileF = path.join(root, 'locked.json');
	writeJsonAtomic(fileF, {});
	const seen = [];
	updateJsonLocked(fileF, (current) => { seen.push({ ...current }); return { ...current, 'w-a': 1 }; });
	updateJsonLocked(fileF, (current) => { seen.push({ ...current }); return { ...current, 'w-b': 1 }; });
	const finalF = readJsonFile(fileF) ?? {};
	check(finalF['w-a'] === 1 && finalF['w-b'] === 1, '加锁后同样两步都对(实际=' + JSON.stringify(finalF) + ')');
	check(seen.length === 2 && seen[1]['w-a'] === 1, '第二个写者读到了第一个写者的结果');

	fs.rmSync(root, { recursive: true, force: true });
	console.log('结果: ' + (checks - failures) + '/' + checks + ' 通过');
	if (failures > 0) {
		console.log('存在失败项');
		process.exit(1);
	}
	console.log('跨进程 JSON 锁语义验证通过');
}

try {
	await main();
} catch (error) {
	console.error('验证失败: ' + (error?.message ?? error));
	process.exit(1);
}

