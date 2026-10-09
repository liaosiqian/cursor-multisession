// 会话文件的读取缓存(扩展宿主 tick 每轮都要读盘,这里是内存热点)。
//
// 动机:chat-log.json 单文件可达数 MB,每轮整份解析会把扩展宿主的堆和 GC 压力顶高;
// 会话关闭后这些文件已无人查看,但缓存条目与派生结果会一直留着,内存只增不减。
// 两个手段:
//   1) 用 mtime + size 判断文件是否变化,未变化直接复用上次派生结果(跳过解析);
//   2) 按「仍可见的会话集合」淘汰缓存条目,已关闭会话不再占用内存。
//
// 抽到 shared 是为了让内存对照脚本直接测这段真实现,而不是复刻一份等价算法。

import fs from 'node:fs';
import path from 'node:path';

export interface FileCacheStats {
	/** 当前缓存条目数 */
	entries: number;
	/** 真正解析文件的次数(缓存命中不计) */
	parses: number;
	/** 累计解析的字节数 */
	bytes: number;
}

export interface FileCache {
	read<T>(file: string, derive: (raw: unknown) => T | null): T | null;
	evictForRemovedSessions(activeIds: Set<string>): number;
	stats(): FileCacheStats;
	keys(): string[];
}

interface Entry { mtimeMs: number; size: number; value: unknown; }

/** 条目上限。超过就整体清空:这些文件每轮都会重读,清空只让下一轮多解析一遍。 */
export const FILE_CACHE_LIMIT = 512;

function readJson(file: string): unknown {
	try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

export function createFileCache(limit = FILE_CACHE_LIMIT): FileCache {
	const entries = new Map<string, Entry>();
	let parses = 0;
	let bytes = 0;

	function read<T>(file: string, derive: (raw: unknown) => T | null): T | null {
		let stat: fs.Stats;
		try { stat = fs.statSync(file); } catch { entries.delete(file); return null; }
		const hit = entries.get(file);
		if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value as T;
		const value = derive(readJson(file));
		parses++;
		bytes += stat.size;
		if (value === null) { entries.delete(file); return null; }
		if (entries.size >= limit) entries.clear();
		entries.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
		return value;
	}

	/**
	 * 丢弃已不在 activeIds 里的会话缓存,释放已关闭会话占用的内存。
	 * 路径形如 <root>/sessions/<sid>/<file>,取上一级目录名当会话 id;
	 * 非会话文件(如 sessions.json)也会被丢掉,代价只是下一轮多解析一个小文件。
	 */
	function evictForRemovedSessions(activeIds: Set<string>): number {
		let removed = 0;
		for (const key of [...entries.keys()]) {
			if (!activeIds.has(path.basename(path.dirname(key)))) { entries.delete(key); removed++; }
		}
		return removed;
	}

	return {
		read,
		evictForRemovedSessions,
		stats: () => ({ entries: entries.size, parses, bytes }),
		keys: () => [...entries.keys()],
	};
}

