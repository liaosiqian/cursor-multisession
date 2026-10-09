#!/usr/bin/env node
/**
 * 文件缓存语义单测 —— 「已关闭会话仍占内存」这条修复的确定性断言。
 *
 * 测的是 src/shared/file-cache.ts 的编译产物(扩展宿主 tick 每轮读盘走的就是它):
 *   1. 文件未变化时只解析一次(mtime + size 命中)
 *   2. 内容变化后重新解析
 *   3. 文件消失返回 null,且不留悬空条目
 *   4. derive 返回 null 不缓存
 *   5. 已关闭会话的缓存条目被淘汰,可见会话保留
 *   6. 条目数到上限时整体清空,不会无限增长
 *   7. stats 的解析次数/字节数与实际读盘一致
 *
 * 用法: node tests/file-cache-unit.mjs(需先 npm run compile:shared)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileCache } from '../dist/file-cache.mjs';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CACHE_PATH = path.join(REPO_ROOT, 'dist', 'file-cache.mjs');

let failures = 0;
let checks = 0;
function check(condition, label) {
	checks++;
	console.log((condition ? '  PASS ' : '  FAIL ') + label);
	if (!condition) failures++;
}

function writeSessionLog(root, id, entries) {
	const dir = path.join(root, 'sessions', id);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, 'chat-log.json');
	fs.writeFileSync(file, JSON.stringify(entries));
	return file;
}

const windowOf = (raw) => (Array.isArray(raw) ? { logs: raw.slice(-50), totalCount: raw.length } : null);

function main() {
	if (!fs.existsSync(CACHE_PATH)) throw new Error('未找到 ' + CACHE_PATH + ',请先运行 npm run compile:shared');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-file-cache-'));
	const cache = createFileCache();

	console.log('[1] mtime + size 命中,未变化不重复解析');
	const fileA = writeSessionLog(root, 'sess-a', [{ role: 'user', text: 'a1' }, { role: 'assistant', text: 'a2' }]);
	cache.read(fileA, windowOf);
	cache.read(fileA, windowOf);
	cache.read(fileA, windowOf);
	check(cache.stats().parses === 1, '三次读取只解析一次(parses=' + cache.stats().parses + ')');
	check(cache.stats().entries === 1, '缓存只有一条条目');
	const bytesAfterFirst = cache.stats().bytes;
	check(cache.read(fileA, windowOf)?.totalCount === 2, '命中缓存仍返回正确派生结果');
	check(cache.stats().bytes === bytesAfterFirst, '命中缓存不重复累计字节数');

	console.log('[2] 内容变化后重新解析');
	writeSessionLog(root, 'sess-a', [{ role: 'user', text: 'a1' }, { role: 'assistant', text: 'a2' }, { role: 'user', text: 'a3' }]);
	check(cache.read(fileA, windowOf)?.totalCount === 3, '读到新内容');
	check(cache.stats().parses === 2, '解析次数增加(parses=' + cache.stats().parses + ')');

	console.log('[3] 文件消失不留悬空条目');
	fs.unlinkSync(fileA);
	check(cache.read(fileA, windowOf) === null, '文件不存在返回 null');
	check(!cache.keys().includes(fileA), '缓存条目已移除');

	console.log('[4] derive 返回 null 时不缓存');
	const badFile = path.join(root, 'sessions', 'sess-bad', 'chat-log.json');
	fs.mkdirSync(path.dirname(badFile), { recursive: true });
	fs.writeFileSync(badFile, 'not-json');
	check(cache.read(badFile, windowOf) === null, '派生失败返回 null');
	check(!cache.keys().includes(badFile), '派生失败不写缓存');

	console.log('[5] 已关闭会话的缓存被淘汰');
	const evictCache = createFileCache();
	const fileLive = writeSessionLog(root, 'sess-live', [{ role: 'user', text: 'live' }]);
	const fileClosed1 = writeSessionLog(root, 'sess-closed-1', [{ role: 'user', text: 'c1' }]);
	const fileClosed2 = writeSessionLog(root, 'sess-closed-2', [{ role: 'user', text: 'c2' }]);
	for (const f of [fileLive, fileClosed1, fileClosed2]) evictCache.read(f, windowOf);
	check(evictCache.stats().entries === 3, '三个会话都在缓存里');
	const removed = evictCache.evictForRemovedSessions(new Set(['sess-live']));
	check(removed === 2, '淘汰了两个已关闭会话的条目(removed=' + removed + ')');
	check(evictCache.keys().length === 1 && evictCache.keys()[0] === fileLive, '只剩可见会话的条目');
	check(evictCache.read(fileLive, windowOf)?.totalCount === 1, '可见会话命中缓存(未重新解析)');

	console.log('[6] 条目数到上限整体清空,不无限增长');
	const tiny = createFileCache(2);
	const t1 = writeSessionLog(root, 'sess-t1', [{ role: 'user', text: 't1' }]);
	const t2 = writeSessionLog(root, 'sess-t2', [{ role: 'user', text: 't2' }]);
	const t3 = writeSessionLog(root, 'sess-t3', [{ role: 'user', text: 't3' }]);
	for (const f of [t1, t2, t3]) tiny.read(f, windowOf);
	check(tiny.stats().entries === 1, '超限后清空,只剩最后一条(entries=' + tiny.stats().entries + ')');

	console.log('[7] stats 与实际读盘一致');
	const solo = createFileCache();
	const s1 = writeSessionLog(root, 'sess-s1', [{ role: 'user', text: 's1' }]);
	const s2 = writeSessionLog(root, 'sess-s2', [{ role: 'user', text: 's2' }]);
	solo.read(s1, windowOf);
	solo.read(s1, windowOf);
	solo.read(s2, windowOf);
	const expectedBytes = fs.statSync(s1).size + fs.statSync(s2).size;
	check(solo.stats().parses === 2, '解析两次');
	check(solo.stats().entries === 2, '两个条目');
	check(solo.stats().bytes === expectedBytes, '字节数等于两次解析的文件大小之和');

	fs.rmSync(root, { recursive: true, force: true });
	console.log('结果: ' + (checks - failures) + '/' + checks + ' 通过');
	if (failures > 0) {
		console.log('存在失败项');
		process.exit(1);
	}
	console.log('文件缓存语义验证通过');
}

try {
	main();
} catch (error) {
	console.error('验证失败: ' + (error?.message ?? error));
	process.exit(1);
}

