// 真实扩展宿主内存/CPU 对照:对同一个夹具分别测老构建与当前构建。
// 依赖 scripts/cdp-eval.mjs 的 raw 子命令给扩展宿主发 HeapProfiler.collectGarbage,再读 process.memoryUsage()。
// 前置:先用 --inspect-extensions=<port> 启动隔离 Cursor 窗口,并让夹具落到同一数据根。
// 用法:
//   node scripts/ms-mem-ab.mjs --port 9406 --root <数据根> --ws <工作区> \
//     --label "新构建-HEAD" --seconds 45 [--start-phase both|close]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(REPO, 'scripts', 'ms-mem-fixture.mjs');
const CDP_EVAL = path.join(REPO, 'scripts', 'cdp-eval.mjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const port = arg('port');
const root = arg('root');
const ws = arg('ws');
const label = arg('label');
const seconds = Number(arg('seconds', '45'));

function cdp(args) {
	const out = spawnSync('node', [CDP_EVAL, ...args], { encoding: 'utf-8' });
	return out.stdout || '';
}
function evalJson(expr) {
	// inspector 偶发连接被重置会返回空串,重试几次
	for (let attempt = 0; attempt < 4; attempt++) {
		const text = cdp(['eval', expr, '--target', 'node', '--port', port]);
		const start = text.indexOf('{');
		if (start >= 0) {
			try { return JSON.parse(JSON.parse(text.slice(start)).result.value); } catch { /* 重试 */ }
		}
		spawnSync('sleep', ['1']);
	}
	throw new Error('inspector 连续 4 次没返回可解析结果');
}
function gc() { cdp(['raw', 'HeapProfiler.collectGarbage', '--target', 'node', '--port', port]); }

const hostPid = evalJson('JSON.stringify({pid:process.pid})').pid;
const heartbeat = JSON.parse(fs.readFileSync(path.join(root, 'active-window.json'), 'utf-8'))[ws] || [];
const mine = heartbeat.find((e) => e.pid === hostPid) || heartbeat[0];
console.log('标签=' + label + ' 宿主pid=' + hostPid + ' token=' + mine.token);

function fixture(phase) {
	const args = ['--root', root, '--ws', ws, '--host-pid', String(hostPid), '--window-pid', String(mine.windowPid || 0), '--token', mine.token, '--phase', phase];
	const out = spawnSync('node', [FIXTURE, ...args], { encoding: 'utf-8' });
	console.log('  ' + (out.stdout || '').trim());
}

async function measure(tag, secs) {
	gc();
	const first = evalJson('JSON.stringify({mem:process.memoryUsage(),cpu:process.cpuUsage()})');
	const t0 = Date.now();
	let peakUsed = 0, peakRss = 0, last = first;
	while (Date.now() - t0 < secs * 1000) {
		await new Promise((r) => setTimeout(r, 5000));
		gc();
		last = evalJson('JSON.stringify({mem:process.memoryUsage(),cpu:process.cpuUsage()})');
		peakUsed = Math.max(peakUsed, last.mem.heapUsed);
		peakRss = Math.max(peakRss, last.mem.rss);
	}
	const dtMs = Date.now() - t0;
	const cpuUs = (last.cpu.user + last.cpu.system) - (first.cpu.user + first.cpu.system);
	const mb = (v) => (v / 1048576).toFixed(1);
	console.log('  [' + tag + '] ' + (dtMs / 1000).toFixed(0) + 's: heapUsed(GC后) 起=' + mb(first.mem.heapUsed) + ' 末=' + mb(last.mem.heapUsed) + ' 峰=' + mb(peakUsed) + 'MB, rss 起=' + mb(first.mem.rss) + ' 末=' + mb(last.mem.rss) + ' 峰=' + mb(peakRss) + 'MB, CPU=' + (cpuUs / 1000).toFixed(0) + 'ms(' + ((cpuUs / 1000 / dtMs) * 100).toFixed(1) + '%)');
	return { first, last, peakUsed, peakRss, cpuUs, dtMs };
}

const startPhase = arg('start-phase', 'both');
if (startPhase === 'both') {
	fixture('sessions');
	await new Promise((r) => setTimeout(r, 12000));
	await measure('24 个会话全部可见', seconds);
	fixture('close');
} else {
	fixture('close');
}
await new Promise((r) => setTimeout(r, 12000));
await measure('全部会话已关闭', seconds);
