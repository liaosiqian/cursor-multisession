// 面板可见性判定(纯函数,便于单测)。
//
// 问题:一个窗口同时打开多个文件夹(多根工作区)时,不同 Cursor 窗口的文件夹会重叠。
// 只按"会话的 workspace 是否属于本窗口文件夹"过滤,重叠文件夹上的会话会同时出现在多个
// 窗口的面板里,这就是"多个工作空间的对话互相能看到"。
//
// 判定用三级信号(强 → 弱):
//   1. windowOwnerPid —— 登记会话时记住 MCP 绑定的那个扩展宿主 pid。窗口级唯一身份,
//      窗口重载会变;"持有者还活着且不是我"即可断定会话属于别的窗口。
//   2. windowToken —— 扩展宿主每次激活生成的 token,同样只在本次激活内有效。
//   3. windowPid —— Cursor 窗口主进程 pid。同一 app 实例内多窗口会相同,只作兜底。
//
// 信号全部缺失(老数据)时退化为"只按工作区过滤",与旧行为一致。

export interface SessionOwnership {
	windowToken?: string;
	windowPid?: number;
	windowOwnerPid?: number;
}

export interface SessionLike extends SessionOwnership {
	id: string;
	workspace?: string;
	alive?: boolean;
	lastActiveAt?: number;
}

export interface WindowEntryLike extends SessionOwnership {
	token: string;
	pid: number;
}

export interface VisibilityContext {
	/** 本窗口的工作区文件夹(已归一化) */
	workspacePaths: string[];
	/** 本扩展宿主 pid */
	extensionPid: number;
	/** 本窗口主进程 pid,解析失败为 null */
	windowPid: number | null;
	/** 本窗口当前 token */
	windowToken: string;
	/** active-window.json 中的全部条目(调用方已完成形状校验) */
	windowEntries: WindowEntryLike[];
	/** 当前仍存活的 pid(扩展宿主 pid 与窗口主进程 pid) */
	alivePids: Set<number>;
	now: number;
	archiveThresholdMs: number;
}

export function normalizePathForCompare(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function indexWindowEntries(ctx: VisibilityContext) {
	const myTokens = new Set<string>([ctx.windowToken]);
	const otherLivePids = new Set<number>();
	const liveWindowPids = new Set<number>();
	for (const entry of ctx.windowEntries) {
		if (entry.pid === ctx.extensionPid) {
			myTokens.add(entry.token);
		} else if (ctx.alivePids.has(entry.pid)) {
			// 同一 app 实例的其它窗口也会写同一个窗口主进程 pid,不能据此认定"是我"
			otherLivePids.add(entry.pid);
		}
		if (entry.windowPid && ctx.alivePids.has(entry.windowPid)) liveWindowPids.add(entry.windowPid);
	}
	return { myTokens, otherLivePids, liveWindowPids };
}

/** 该会话是否明确属于本窗口 */
function isMine(session: SessionLike, ctx: VisibilityContext, myTokens: Set<string>): boolean {
	if (session.windowOwnerPid && session.windowOwnerPid === ctx.extensionPid) return true;
	if (session.windowToken && myTokens.has(session.windowToken)) return true;
	// 老数据两者都没有时,只能按 app 实例粗匹配
	if (!session.windowOwnerPid && !session.windowToken
		&& ctx.windowPid && session.windowPid === ctx.windowPid) return true;
	return false;
}

/** 该会话是否正被另一个活着的窗口持有 */
function ownedByOtherLiveWindow(
	session: SessionLike,
	ctx: VisibilityContext,
	otherLivePids: Set<number>,
	liveWindowPids: Set<number>,
): boolean {
	if (session.windowOwnerPid && session.windowOwnerPid !== ctx.extensionPid
		&& otherLivePids.has(session.windowOwnerPid)) return true;
	if (ctx.windowPid && session.windowPid && session.windowPid !== ctx.windowPid
		&& liveWindowPids.has(session.windowPid)) return true;
	return false;
}

export function selectVisibleSessions<T extends SessionLike>(sessions: T[], ctx: VisibilityContext): T[] {
	const { myTokens, otherLivePids, liveWindowPids } = indexWindowEntries(ctx);
	return sessions.filter((session) => {
		if (session.alive === false
			&& (ctx.now - (session.lastActiveAt ?? 0)) > ctx.archiveThresholdMs) return false;

		const mine = isMine(session, ctx, myTokens);
		if (!mine && ownedByOtherLiveWindow(session, ctx, otherLivePids, liveWindowPids)) {
			// 归属另一个还活着的窗口:本窗口不显示,避免两个窗口看到同一批对话
			return false;
		}

		if (!session.workspace) return true;
		if (ctx.workspacePaths.includes(normalizePathForCompare(session.workspace))) return true;
		// 工作区已不在本窗口文件夹内,但会话确实是本窗口的(文件夹被移出等)仍显示
		return mine;
	});
}

/**
 * 该会话是否需要「认领归属」:可见、没有活着的持有者,但归属信息缺失或属于已失效的窗口。
 * 认领后本窗口成为它的所属窗口,其它窗口不会再重复显示同一批对话。
 */
export function needsOwnershipAdoption(session: SessionLike, ctx: VisibilityContext): boolean {
	const { myTokens, otherLivePids, liveWindowPids } = indexWindowEntries(ctx);
	if (isMine(session, ctx, myTokens)) return false;
	if (ownedByOtherLiveWindow(session, ctx, otherLivePids, liveWindowPids)) return false;
	return true;
}

/**
 * 按「仍存在的会话」裁剪以 sessionId 为键的表(面板的日志/草稿/摘要等本地状态)。
 * 会话关闭后不清理,这些表会一直持有已关闭会话的数据,面板内存只增不减。
 * 无变化时返回原对象,方便 React setState 短路。
 */
export function pruneRecordToAliveIds<T>(
	prev: Record<string, T>,
	aliveIds: Set<string>,
): Record<string, T> {
	const next: Record<string, T> = {};
	let changed = false;
	for (const [sid, value] of Object.entries(prev)) {
		if (aliveIds.has(sid)) next[sid] = value;
		else changed = true;
	}
	return changed ? next : prev;
}

/** 同上的 Set 版本(未投递标记等) */
export function pruneSetToAliveIds(prev: Set<string>, aliveIds: Set<string>): Set<string> {
	let changed = false;
	const next = new Set<string>();
	for (const sid of prev) {
		if (aliveIds.has(sid)) next.add(sid);
		else changed = true;
	}
	return changed ? next : prev;
}

/**
 * AI 提问表单里「某个会话的第 N 个问题」的键。
 *
 * 必须带会话 id:早期只用问题序号(0/1/2),既会让多个会话共用同一份选择与补充说明,
 * 又会被 pruneRecordToAliveIds 当成「已关闭会话的残留」在每次会话列表刷新时清空。
 * 会话 id 形如 mpm9keyf-rlgefg,不含冒号,所以 ':' 可以安全地当分隔符。
 */
export function inquiryKey(sessionId: string, questionIndex: number | string): string {
	return sessionId + ':' + questionIndex;
}

/**
 * 按「键前缀是会话 id」裁剪的表(inquiryKey 产生的那些)。
 * 与 pruneRecordToAliveIds 的区别:后者要求整键等于会话 id,用于日志/草稿这类以会话 id
 * 直接作键的表;本函数保留「存活会话 id + 后缀」的条目。无变化时返回原对象。
 */
export function pruneRecordBySessionPrefix<T>(
	prev: Record<string, T>,
	aliveIds: Set<string>,
): Record<string, T> {
	const next: Record<string, T> = {};
	let changed = false;
	for (const [key, value] of Object.entries(prev)) {
		const sep = key.indexOf(':');
		const sid = sep >= 0 ? key.slice(0, sep) : key;
		if (aliveIds.has(sid)) next[key] = value;
		else changed = true;
	}
	return changed ? next : prev;
}

/** 删掉某个会话的全部键(提交回答后清本会话的选择与补充说明,不影响别的会话) */
export function dropSessionKeys<T>(prev: Record<string, T>, sessionId: string): Record<string, T> {
	const prefix = sessionId + ':';
	let changed = false;
	const next: Record<string, T> = {};
	for (const [key, value] of Object.entries(prev)) {
		if (key.startsWith(prefix)) changed = true;
		else next[key] = value;
	}
	return changed ? next : prev;
}
