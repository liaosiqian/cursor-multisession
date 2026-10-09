// 内存对照夹具:造 24 个会话(每个 ~0.4MB chat-log.json),close 阶段把后 18 个标记为已关闭。
// 用法:
//   node scripts/ms-mem-fixture.mjs --root <数据根> --ws <工作区> --host-pid <P> \
//     --window-pid <P> --token <窗口 token> --phase sessions|close [--count 24] [--visible 6] [--entries 1200]
import fs from 'node:fs';
import path from 'node:path';
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const root = arg('root');
const ws = arg('ws');
const hostPid = Number(arg('host-pid'));
const windowPid = Number(arg('window-pid'));
const token = arg('token');
const phase = arg('phase', 'sessions');
const total = Number(arg('count', '24'));
const visible = Number(arg('visible', '6'));
const entries = Number(arg('entries', '1200'));
const text = 'x'.repeat(360);
const now = Date.now();
const sessions = [];
for (let i = 0; i < total; i++) {
	const id = 'sess-' + i;
	const dir = path.join(root, 'sessions', id);
	fs.mkdirSync(dir, { recursive: true });
	const logFile = path.join(dir, 'chat-log.json');
	if (!fs.existsSync(logFile)) {
		const log = [];
		for (let n = 0; n < entries; n++) log.push({ role: n % 2 === 0 ? 'user' : 'assistant', text, ts: 1_700_000_000_000 + n });
		fs.writeFileSync(logFile, JSON.stringify(log));
	}
	fs.writeFileSync(path.join(dir, 'queue.json'), '[]');
	const closing = phase === 'close' && i >= visible;
	sessions.push({
		id, name: id, workspace: ws, alive: !closing,
		createdAt: now, lastActiveAt: closing ? now - 4 * 24 * 3600 * 1000 : now,
		windowToken: token, windowOwnerPid: hostPid, windowPid,
	});
}
fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify(sessions, null, '\t'));
console.log('phase=' + phase + ' 会话=' + total + ' 可见=' + (phase === 'close' ? visible : total) + ' 日志大小=' + fs.statSync(path.join(root, 'sessions', 'sess-0', 'chat-log.json')).size + 'B');
