// 跨进程安全的 JSON 文件读改写(只用于小文件:窗口心跳、会话列表这类)。
//
// 背景:active-window.json 由**多个** Cursor 窗口的扩展宿主共同维护,每个进程都做
// 「读整份 → 改自己那条 → 整份写回」。没有锁时两个进程同时读、先后写,后写的一方会把
// 对方这次的心跳丢掉 —— 该窗口的条目会凭空消失最多一个心跳周期,期间别的窗口可能把它
// 的会话认领过去(表现为会话在窗口之间跳动)。
//
// 做法:
//   1) 用 O_EXCL 建锁文件(原子操作),拿到锁才读改写;超时等待,陈旧锁会被回收
//   2) 写回走「临时文件 + rename」,避免别的进程读到半截 JSON
//   3) 释放锁前校验锁文件里的 token,避免误删别人(或已被回收后重建)的锁

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface LockOptions {
	/** 拿锁最长等待时间 */
	timeoutMs?: number;
	/** 超过这个年龄的锁视为残留锁,直接回收 */
	staleMs?: number;
	/** 重试间隔 */
	retryMs?: number;
}

const DEFAULTS = { timeoutMs: 3000, staleMs: 3000, retryMs: 20 };

export function readJsonFile<T>(file: string): T | null {
	try { return JSON.parse(fs.readFileSync(file, 'utf-8')) as T; } catch { return null; }
}

/** 临时文件 + rename,避免读者读到半截内容 */
export function writeJsonAtomic(file: string, data: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
	fs.writeFileSync(tmp, JSON.stringify(data, null, '\t'), 'utf-8');
	fs.renameSync(tmp, file);
}

function sleepSync(ms: number) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(lockPath: string, options: Required<LockOptions>): string {
	const token = process.pid + '-' + crypto.randomBytes(6).toString('hex');
	const deadline = Date.now() + options.timeoutMs;
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	for (;;) {
		try {
			const fd = fs.openSync(lockPath, 'wx');
			try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, ts: Date.now() })); }
			finally { fs.closeSync(fd); }
			return token;
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
			try {
				const stat = fs.statSync(lockPath);
				if (Date.now() - stat.mtimeMs > options.staleMs) { fs.unlinkSync(lockPath); continue; }
			} catch { /* 锁刚被释放,下一轮抢 */ }
			if (Date.now() >= deadline) throw new Error('等待文件锁超时: ' + lockPath);
			sleepSync(options.retryMs);
		}
	}
}

function releaseLock(lockPath: string, token: string) {
	try {
		const current = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
		if (current?.token === token) fs.unlinkSync(lockPath);
	} catch { /* 锁已不在或已被回收 */ }
}

/**
 * 带锁的读改写。mutate 返回 undefined 表示本次不写回(比如没有任何改动)。
 * 返回 true 表示确实写回了一次。
 */
export function updateJsonLocked<T>(
	file: string,
	mutate: (current: T | null) => T | undefined,
	options: LockOptions = {},
): boolean {
	const opts = { ...DEFAULTS, ...options };
	const lockPath = file + '.lock';
	const token = acquireLock(lockPath, opts);
	try {
		const next = mutate(readJsonFile<T>(file));
		if (next === undefined) return false;
		writeJsonAtomic(file, next);
		return true;
	} finally {
		releaseLock(lockPath, token);
	}
}

