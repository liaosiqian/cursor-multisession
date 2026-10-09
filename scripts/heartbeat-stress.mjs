#!/usr/bin/env node
/**
 * 窗口心跳竞态压力测试 —— 在旁边有真实窗口运行时,持续读改写 active-window.json,
 * 观察在跑窗口的心跳会不会被外部写者盖掉(表现:时间戳停止刷新,甚至条目被当成陈旧项清掉)。
 *
 * 背景:active-window.json 由多个扩展宿主进程共同维护,每个写者都做「读整份 → 改自己那条 →
 * 整份写回」。不加锁时后者会覆盖掉前者刚续的心跳,那个窗口的条目看起来就停更了,超过
 * WINDOW_STALE_MS(15s)就会被别的窗口当成陈旧条目清掉,期间它的会话可能被认领过去。
 *
 * 三种写者模式:
 *   locked  走 dist/locked-json.mjs 的 updateJsonLocked —— 当前实现,预期零打断
 *   naive   无锁「读 → 改 → 写」 —— 0.8.0 老实现的行为,预期心跳被反复打断
 *   stale   无锁且拿着启动时的旧快照反复写回 —— 最坏情况,心跳会被冻结整个测试时长
 *
 * 用法(必须有真实窗口在跑,否则没有观测对象):
 *   node scripts/heartbeat-stress.mjs --mode locked --seconds 20
 *   MULTISESSION_DATA_ROOT=/tmp/xxx node scripts/heartbeat-stress.mjs --mode naive --seconds 90
 * 只有 locked 模式会因「心跳被打断」以非 0 退出;另外两种模式本来就是用来复现问题的。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { updateJsonLocked, readJsonFile, writeJsonAtomic } = await import(
	pathToFileURL(path.join(REPO_ROOT, 'dist', 'locked-json.mjs')).href,
);

const arg = (name, dflt) => {
	const i = process.argv.indexOf('--' + name);
	return i > 0 ? process.argv[i + 1] : dflt;
};
const mode = arg('mode', 'locked');
const seconds = Number(arg('seconds', '20'));
const dataRoot = process.env.MULTISESSION_DATA_ROOT?.trim() || path.join(os.homedir(), '.multisession');
const file = arg('file', path.join(dataRoot, 'active-window.json'));
const STRESS_TOKEN = 'w-stress-' + process.pid;
const readAll = () => readJsonFile(file) || {};

const initial = readAll();
const expected = [];
for (const [ws, entries] of Object.entries(initial)) {
	for (const e of entries || []) {
		if (e && e.token && !String(e.token).startsWith('w-stress-')) expected.push({ ws, token: e.token, pid: e.pid, windowPid: e.windowPid });
	}
}
console.log('模式=' + mode + ' 时长=' + seconds + 's 文件=' + file);
if (expected.length === 0) {
	console.log('没有观察到任何窗口心跳,无法测试(要先有真实窗口在跑)');
	process.exit(1);
}
console.log('观测对象:');
for (const e of expected) console.log('  ' + e.token + '(宿主 pid=' + e.pid + ', 窗口 pid=' + e.windowPid + ')');

const mutate = (current, entry) => {
	const data = current || {};
	for (const ws of Object.keys(data)) {
		const list = (data[ws] || []).filter((e) => e && e.token !== STRESS_TOKEN);
		list.unshift({ ...entry });
		data[ws] = list;
	}
	return data;
};

const entry = { token: STRESS_TOKEN, timestamp: 0, pid: process.pid, windowPid: process.pid };
let staleSnapshot = null;
let writes = 0;
let stopped = false;
const writer = setInterval(() => {
	if (stopped) return;
	entry.timestamp = Date.now();
	if (mode === 'locked') {
		updateJsonLocked(file, (current) => mutate(current, entry));
	} else if (mode === 'stale') {
		if (!staleSnapshot) staleSnapshot = readJsonFile(file);
		writeJsonAtomic(file, mutate(staleSnapshot, entry));
	} else {
		writeJsonAtomic(file, mutate(readJsonFile(file), entry));
	}
	writes++;
}, 1);

const missing = new Map();
const maxAge = new Map();
const ages = [];
let samples = 0;
let badSamples = 0;
const sampler = setInterval(() => {
	const now = Date.now();
	const data = readAll();
	samples++;
	let bad = false;
	for (const e of expected) {
		const found = (data[e.ws] || []).find((x) => x && x.token === e.token);
		if (!found) {
			bad = true;
			missing.set(e.token, (missing.get(e.token) || 0) + 1);
			continue;
		}
		const age = now - found.timestamp;
		if (age > (maxAge.get(e.token) || 0)) maxAge.set(e.token, age);
		ages.push(age);
	}
	if (bad) badSamples++;
}, 100);

setTimeout(() => {
	stopped = true;
	clearInterval(writer);
	clearInterval(sampler);
	ages.sort((a, b) => a - b);
	const p50 = ages[Math.floor(ages.length * 0.5)] ?? -1;
	const p99 = ages[Math.floor(ages.length * 0.99)] ?? -1;
	const worst = ages.length ? ages[ages.length - 1] : -1;
	// 扩展宿主每 3s 续一次心跳,超过 6s 就说明续期被外部写者盖掉了
	const interrupted = worst >= 6000 || badSamples > 0;
	console.log('写回次数=' + writes + ' 采样次数=' + samples + ' 条目缺失的采样=' + badSamples);
	console.log('心跳时间戳年龄: 中位 ' + p50 + 'ms / p99 ' + p99 + 'ms / 最大 ' + worst + 'ms');
	for (const [token, age] of maxAge) console.log('  ' + token + ' 最大年龄 ' + age + 'ms');
	for (const [token, count] of missing) console.log('  ' + token + ' 缺失 ' + count + ' 次采样');
	console.log(interrupted ? '结果: 心跳被打断' : '结果: 心跳未被打断');
	process.exit(mode === 'locked' && interrupted ? 1 : 0);
}, seconds * 1000);

