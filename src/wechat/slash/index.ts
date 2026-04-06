import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ClawBotClient } from '../api/client';
import { loadContextToken, loadCredentials } from '../auth/store';
import { listSessions, getSessionName } from '../bridge/multisession';
import type { MessageRouter } from '../bridge/message-router';
import type { SessionWatcherManager } from '../bridge/session-watcher-manager';
import { logger } from '../util/logger';
import type { EngineState } from '../engine';

const SESSIONS_FILE = path.join(os.homedir(), ".multisession", "sessions.json");

export interface SlashContext {
  engineState: EngineState;
  connectedSince: number | null;
  lastMessageAt: number | null;
  lastReplyAt: number | null;
  pendingReply: boolean;
  router: MessageRouter | null;
  watcherManager: SessionWatcherManager | null;
  onBoundSessionChanged?: (sessionId: string | null) => void;
}

type SlashHandler = (
  args: string,
  ctx: SlashContext,
  client: ClawBotClient,
  userId: string,
) => Promise<string>;

const commands = new Map<string, { handler: SlashHandler; desc: string }>();

function register(name: string, desc: string, handler: SlashHandler) {
  commands.set(name, { handler, desc });
}

register("status", "查看引擎和会话状态", async (_args, ctx) => {
  const lines: string[] = ["--- 引擎状态 ---"];

  lines.push(`状态: ${ctx.engineState}`);

  if (ctx.connectedSince) {
    const uptime = Date.now() - ctx.connectedSince;
    lines.push(`运行时间: ${formatDuration(uptime)}`);
  }

  const creds = loadCredentials();
  lines.push(`Bot: ${creds?.botId ?? "无"}`);

  const sessions = listSessions();
  const boundId = ctx.watcherManager?.getBoundSessionId();
  lines.push(`会话: ${sessions.length} 个活跃`);

  for (const s of sessions) {
    const isBound = s.id === boundId;
    const age = formatDuration(Date.now() - s.lastActiveAt);
    lines.push(`  ${isBound ? "●" : "○"} ${s.name} — ${age} 前${isBound ? " [已绑定]" : ""}`);
  }

  if (ctx.lastMessageAt) {
    const ago = Date.now() - ctx.lastMessageAt;
    lines.push(`最近收到消息: ${formatDuration(ago)} 前`);
  } else {
    lines.push("最近收到消息: 无");
  }

  if (ctx.lastReplyAt) {
    const ago = Date.now() - ctx.lastReplyAt;
    lines.push(`最近发送回复: ${formatDuration(ago)} 前`);
  } else {
    lines.push("最近发送回复: 无");
  }

  lines.push(`等待回复: ${ctx.pendingReply ? "是 (AI 思考中...)" : "无"}`);
  lines.push(`主机: ${os.hostname()} | Node ${process.version}`);
  lines.push(`内存: ${(process.memoryUsage.rss() / 1024 / 1024).toFixed(0)}MB`);

  return lines.join("\n");
});

register("ping", "测量 API 往返延迟", async (_args, _ctx, client, userId) => {
  const t0 = Date.now();
  try {
    await client.getConfig(userId);
    const latency = Date.now() - t0;
    return `Pong! API 延迟: ${latency}ms`;
  } catch (err) {
    const latency = Date.now() - t0;
    return `Ping 失败 (${latency}ms): ${err instanceof Error ? err.message : String(err)}`;
  }
});

register("help", "显示所有可用命令", async () => {
  const lines = ["--- 可用命令 ---"];
  for (const [name, { desc }] of commands) {
    lines.push(`/${name} — ${desc}`);
  }
  return lines.join("\n");
});

register("use", "切换活跃会话（如 /use viplevel）", async (args, ctx, _client, userId) => {
  if (!ctx.router) {
    return "消息路由不可用。";
  }

  const query = args.trim();
  if (!query) {
    const sessions = listSessions();
    const currentId = ctx.router.getActiveSession(userId);
    const boundId = ctx.watcherManager?.getBoundSessionId();
    const lines = ["用法: /use <会话名称>\n\n可用会话:"];
    for (const s of sessions) {
      const markers: string[] = [];
      if (s.id === currentId) markers.push("当前");
      if (s.id === boundId) markers.push("已绑定");
      const suffix = markers.length > 0 ? ` ← ${markers.join(", ")}` : "";
      lines.push(`  • ${s.name}${suffix}`);
    }
    return lines.join("\n");
  }

  const match = ctx.router.findSessionByName(query);
  if (!match) {
    const sessions = listSessions();
    const names = sessions.map((s) => s.name).join(", ");
    return `未找到匹配「${query}」的会话。\n可用: ${names}`;
  }

  ctx.router.setActiveSession(userId, match.id);
  ctx.watcherManager?.setBoundSession(match.id);
  ctx.onBoundSessionChanged?.(match.id);
  return `✓ 已切换到 [${match.name}]\n后续消息和 AI 回复将只通过此会话收发。`;
});

register("sessions", "列出所有会话及状态", async (_args, ctx, _client, userId) => {
  const sessions = listSessions();
  if (sessions.length === 0) {
    return "当前没有活跃会话。请先在 Cursor 中启动一个 Composer 对话。";
  }

  const boundId = ctx.watcherManager?.getBoundSessionId();
  const hasBound = boundId && sessions.some(s => s.id === boundId);
  const lines = ["--- 会话列表 ---"];

  for (const s of sessions) {
    const isBound = s.id === boundId;
    const shortId = s.id.slice(0, 8);
    const age = formatDuration(Date.now() - s.lastActiveAt);
    const marker = isBound ? " ← 已绑定" : "";
    lines.push(`• ${s.name} (${shortId}) — ${age} 前${marker}`);
  }

  if (!hasBound) {
    lines.push("\n⚠ 当前未绑定活跃会话，请复制发送:");
  } else {
    lines.push("\n切换会话:");
  }
  for (const s of sessions) {
    lines.push(`/use ${s.name}`);
  }
  return lines.join("\n");
});

register("session", "查看当前会话详情", async (_args, ctx, _client, userId) => {
  const sessions = listSessions();
  if (sessions.length === 0) {
    return "当前没有活跃的会话。请先在 Cursor 中启动一个 Composer 对话。";
  }
  const boundId = ctx.watcherManager?.getBoundSessionId();
  const hasBound = boundId && sessions.some(s => s.id === boundId);
  const lines = ["--- 会话详情 ---"];
  for (const s of sessions) {
    const isBound = s.id === boundId;
    const age = formatDuration(Date.now() - s.lastActiveAt);
    const marker = isBound ? " ← 已绑定" : "";
    lines.push(`• ${s.name} (${s.id.slice(0, 8)}) — ${age} 前${marker}`);
  }
  if (!hasBound) {
    lines.push("\n⚠ 当前未绑定活跃会话，请复制发送:");
    for (const s of sessions) {
      lines.push(`/use ${s.name}`);
    }
  } else {
    lines.push("\n/use <名称> 切换会话");
    lines.push("/rename <新名称> 重命名当前会话");
  }
  return lines.join("\n");
});

register("rename", "重命名当前会话", async (args, ctx, _client, userId) => {
  const newName = args.trim();
  if (!newName) {
    return "用法: /rename <新名称>\n示例: /rename 我的项目";
  }

  const activeId = ctx.router?.getActiveSession(userId);
  if (!activeId) {
    const sessions = listSessions();
    if (sessions.length === 0) {
      return "当前没有活跃会话。请先在 Cursor 中启动一个 Composer 对话。";
    }
    const cmds = sessions.map(s => `/use ${s.name}`).join("\n");
    return `当前未绑定活跃会话，请先切换:\n${cmds}`;
  }

  try {
    const raw = fs.readFileSync(SESSIONS_FILE, "utf-8");
    const sessions = JSON.parse(raw) as Array<{
      id: string;
      name: string;
      [key: string]: unknown;
    }>;

    const target = sessions.find((s) => s.id === activeId);
    if (!target) {
      return `会话 ${activeId} 未找到。`;
    }

    const oldName = target.name;
    target.name = newName;
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, "\t"), "utf-8");

    return `会话已重命名: 「${oldName}」→「${newName}」`;
  } catch (err) {
    return `重命名失败: ${err instanceof Error ? err.message : String(err)}`;
  }
});

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60}m`;
}

/**
 * Try to handle a slash command. Returns true if the text was a command
 * (and the reply was sent), false if it's a normal message.
 */
export async function tryHandleSlashCommand(
  text: string,
  client: ClawBotClient,
  userId: string,
  ctx: SlashContext,
): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return false;

  const spaceIdx = trimmed.indexOf(" ");
  const cmdName = (spaceIdx > 0 ? trimmed.slice(1, spaceIdx) : trimmed.slice(1)).toLowerCase();
  const args = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : "";

  const cmd = commands.get(cmdName);
  if (!cmd) return false;

  logger.info({ command: cmdName, args, userId }, "slash command received");

  try {
    const reply = await cmd.handler(args, ctx, client, userId);
    const contextToken = loadContextToken(userId);
    await client.sendText(userId, reply, contextToken);
    logger.info({ command: cmdName, replyLen: reply.length }, "slash command replied");
  } catch (err) {
    logger.error({ command: cmdName, err: String(err) }, "slash command error");
    try {
      const contextToken = loadContextToken(userId);
      await client.sendText(userId, `命令 /${cmdName} 执行失败: ${err instanceof Error ? err.message : String(err)}`, contextToken);
    } catch {
      // best effort
    }
  }

  return true;
}

export function getRegisteredCommands(): Map<string, string> {
  const result = new Map<string, string>();
  for (const [name, { desc }] of commands) {
    result.set(name, desc);
  }
  return result;
}
