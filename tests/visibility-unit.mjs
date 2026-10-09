#!/usr/bin/env node
/**
 * 面板可见性判定单测(纯函数,不需要 Cursor)。
 *
 * 覆盖「多个工作空间的对话互相能看到」的各个边界:
 *   - 另一个活窗口持有的会话,即使工作区重叠也不显示
 *   - 持有者已死的会话仍可见(可恢复)
 *   - 本窗口自己的会话即使工作区被移出仍显示
 *   - 老数据(无归属信息)保持原有行为
 *   - 归档会话不显示
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENTRY = path.join(REPO_ROOT, 'src', 'shared', 'session-visibility.ts');

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

const MY_PID = 1000;
const OTHER_PID = 2000;
const MY_WINDOW_PID = 111;
const OTHER_WINDOW_PID = 222;
const REPO = '/Users/dev/repo';
const OTHER_REPO = '/Users/dev/other';
// 上下文里的 workspacePaths 约定为已归一化
const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function baseCtx(overrides = {}) {
	return {
		workspacePaths: [norm(REPO)],
		extensionPid: MY_PID,
		windowPid: MY_WINDOW_PID,
		windowToken: 'w-mine',
		windowEntries: [
			{ token: 'w-mine', pid: MY_PID, windowPid: MY_WINDOW_PID },
			{ token: 'w-other', pid: OTHER_PID, windowPid: OTHER_WINDOW_PID },
		],
		alivePids: new Set([MY_PID, OTHER_PID, MY_WINDOW_PID, OTHER_WINDOW_PID]),
		now: 1_000_000,
		archiveThresholdMs: 3 * 24 * 60 * 60 * 1000,
		...overrides,
	};
}

function session(overrides = {}) {
	return {
		id: 's1',
		workspace: REPO,
		windowToken: 'w-other',
		windowOwnerPid: OTHER_PID,
		windowPid: OTHER_WINDOW_PID,
		alive: true,
		lastActiveAt: 1_000_000,
		...overrides,
	};
}

const outfile = path.join(os.tmpdir(), `ms-visibility-unit-${process.pid}-${Date.now()}.mjs`);
await build({
	entryPoints: [ENTRY],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile,
	logLevel: 'silent',
});
	const { selectVisibleSessions, needsOwnershipAdoption, normalizePathForCompare, pruneRecordToAliveIds, pruneSetToAliveIds } =
		await import(pathToFileURL(outfile).href);
fs.rmSync(outfile, { force: true });

const visible = (s, ctx) => selectVisibleSessions([s], ctx).length === 1;

console.log('[1] 跨窗口归属');
check(!visible(session(), baseCtx()), '另一个活窗口持有的会话不显示(文件夹重叠也不显示)');
check(visible(session({ windowOwnerPid: MY_PID, windowToken: 'w-mine', windowPid: MY_WINDOW_PID }), baseCtx()),
	'本窗口持有的会话显示');
check(visible(session(), baseCtx({ alivePids: new Set([MY_PID, MY_WINDOW_PID]) })),
	'持有者已退出的会话仍显示(可恢复,不丢会话)');
check(!visible(session({ windowOwnerPid: undefined, windowToken: undefined }), baseCtx()),
	'只带另一个窗口 windowPid 的会话仍算它的(不显示)');
check(visible(session({ windowOwnerPid: undefined, windowToken: undefined, windowPid: undefined }), baseCtx()),
	'老数据完全没有归属信息时按工作区显示(保持旧行为)');
check(!visible(session({ windowOwnerPid: undefined, windowToken: 'w-other' }), baseCtx()),
	'只有旧 token 的其它窗口会话不显示');

console.log('[2] 工作区范围');
check(visible(session({ workspace: OTHER_REPO, windowOwnerPid: MY_PID, windowToken: 'w-mine' }), baseCtx()),
	'本窗口会话即使工作区已不在文件夹列表也显示');
check(!visible(session({ workspace: OTHER_REPO, windowOwnerPid: undefined, windowToken: undefined }), baseCtx()),
	'无归属且工作区不匹配的会话不显示');
	check(visible(session({ workspace: undefined, windowOwnerPid: undefined, windowToken: undefined, windowPid: undefined }), baseCtx()),
	'无工作区信息的老会话保持可见');
check(!visible(session({ workspace: undefined }), baseCtx()),
	'无工作区但归属另一个活窗口的会话不显示');
check(visible(session({ workspace: REPO + '/', windowOwnerPid: MY_PID, windowToken: 'w-mine' }), baseCtx()),
	'路径尾斜杠不影响匹配');

console.log('[3] 归档');
check(!visible(session({ alive: false, lastActiveAt: 0, windowOwnerPid: MY_PID, windowToken: 'w-mine', windowPid: MY_WINDOW_PID }), baseCtx({ now: 500_000_000 })),
	'已归档会话不显示');
check(visible(session({ alive: false, lastActiveAt: 499_000_000, windowOwnerPid: MY_PID, windowToken: 'w-mine', windowPid: MY_WINDOW_PID }), baseCtx({ now: 500_000_000 })),
	'刚失活未超归档阈值的会话仍显示');

console.log('[4] 归属认领');
	check(needsOwnershipAdoption(session({ windowOwnerPid: undefined, windowToken: undefined, windowPid: undefined }), baseCtx()),
	'无归属会话需要认领');
check(!needsOwnershipAdoption(session(), baseCtx()),
	'持有者已死的会话需要认领');
check(!needsOwnershipAdoption(session({ windowOwnerPid: MY_PID, windowToken: 'w-mine' }), baseCtx()),
	'已是本窗口的不再认领');

console.log('[5] 归一化');
check(normalizePathForCompare('/Users/Dev/Repo/') === '/users/dev/repo', '路径归一化(大小写与尾斜杠)');

console.log('[6] 已关闭会话的本地状态裁剪');
const aliveIds = new Set(['a']);
check(JSON.stringify(pruneRecordToAliveIds({ a: 1, b: 2 }, aliveIds)) === '{"a":1}', '消失会话的条目被裁掉');
const unchanged = { a: 1 };
check(pruneRecordToAliveIds(unchanged, new Set(['a'])) === unchanged, '无需裁剪时返回原对象(避免多余渲染)');
check(pruneSetToAliveIds(new Set(['a', 'b']), aliveIds).size === 1, 'Set 也按存活会话裁剪');
const sameSet = new Set(['a']);
check(pruneSetToAliveIds(sameSet, aliveIds) === sameSet, 'Set 无需裁剪时返回原对象');

console.log('结果: ' + (checks - failures) + '/' + checks + ' 通过');
if (failures > 0) {
	console.log('存在失败项');
	process.exit(1);
}
console.log('面板可见性判定验证通过');
