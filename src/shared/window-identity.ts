// 解析本进程所属的 Cursor 窗口身份(窗口主进程 pid)。
//
// 为什么需要:同一个窗口的扩展宿主与 MCP 子进程都是该窗口主进程的后代,逐个向上回溯
// 进程树就能得到同一个 pid。而 active-window.json 里的 token 是扩展宿主每次激活重新
// 生成的,窗口重载即失效,单靠 token 无法判断"这个会话属于哪个窗口"。
//
// 用途:
//   - 扩展侧写 active-window 条目时带上 windowPid,并据此判断会话归属;
//   - MCP 侧 claim 窗口 token 时优先选自己窗口的条目,而不是"最新未占用"的那条
//     (后者会把本窗口 MCP 绑到别的窗口,导致会话显示在错误的窗口里)。
//
// 解析失败时退化为父进程 pid:同窗口的扩展宿主与 MCP 可能得到不同值,调用方必须
// 容忍 null / 不一致,只把它当辅助信号。
import { execFileSync } from 'child_process';

// macOS 上 Cursor 主进程的可执行文件名就是 Cursor;Helper 进程带后缀(如 
// "Cursor Helper (Plugin)"),这里只匹配精确到 Cursor 的路径。
const CURSOR_MAIN_RE = /(^|\/)Cursor$/;
const MAX_HOPS = 8;

// undefined = 未解析;null = 解析失败
let cached: number | null | undefined;

function psColumn(pid: number, column: 'comm' | 'ppid'): string | null {
	try {
		const out = execFileSync('ps', ['-o', column + '=', '-p', String(pid)], {
			encoding: 'utf-8',
			timeout: 1000,
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		return out.trim() || null;
	} catch {
		return null;
	}
}

export function resolveWindowPid(): number | null {
	if (cached !== undefined) return cached;

	const override = process.env.MULTISESSION_WINDOW_PID?.trim();
	if (override) {
		const parsed = Number(override);
		if (Number.isInteger(parsed) && parsed > 0) {
			cached = parsed;
			return cached;
		}
	}

	let pid = process.ppid;
	let hops = 0;
	while (pid > 1 && hops < MAX_HOPS) {
		const comm = psColumn(pid, 'comm');
		if (comm && CURSOR_MAIN_RE.test(comm)) {
			cached = pid;
			return cached;
		}
		const parent = Number(psColumn(pid, 'ppid'));
		if (!Number.isInteger(parent) || parent <= 0 || parent === pid) break;
		pid = parent;
		hops++;
	}

	cached = process.ppid > 1 ? process.ppid : null;
	return cached;
}

/** 测试/隔离验证用:清空缓存,便于同一个进程内模拟不同窗口 */
export function resetWindowPidCache() {
	cached = undefined;
}

