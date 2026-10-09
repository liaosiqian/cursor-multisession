// 统一解析 MultiSession 数据根目录。
//
// 默认仍是 ~/.multisession;设置 MULTISESSION_DATA_ROOT 可整体切换数据根,
// 用于开发/验证实例与正在使用的 Cursor 窗口隔离——否则两个实例会共用同一份
// sessions.json / queue.json / active-window.json,互相 claim 窗口、互相收编 session。
//
// 覆盖规则与 src/wechat/auth/store.ts 的 CLAWBOT_DATA_DIR 保持一致。
import * as os from 'os';
import * as path from 'path';

export function resolveDataRoot(): string {
	const override = process.env.MULTISESSION_DATA_ROOT?.trim();
	return override ? path.resolve(override) : path.join(os.homedir(), '.multisession');
}

export const DATA_ROOT = resolveDataRoot();
