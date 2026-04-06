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

register("status", "Show engine & pipeline status", async (_args, ctx) => {
  const lines: string[] = ["--- ClawBot Status ---"];

  lines.push(`State: ${ctx.engineState}`);

  if (ctx.connectedSince) {
    const uptime = Date.now() - ctx.connectedSince;
    lines.push(`Uptime: ${formatDuration(uptime)}`);
  }

  const creds = loadCredentials();
  lines.push(`Bot: ${creds?.botId ?? "N/A"}`);

  const sessions = listSessions();
  const watchedIds = ctx.watcherManager?.getWatchedSessionIds() ?? [];
  lines.push(`Sessions: ${sessions.length} alive, ${watchedIds.length} watched`);

  for (const s of sessions) {
    const isWatched = watchedIds.includes(s.id);
    const age = formatDuration(Date.now() - s.lastActiveAt);
    lines.push(`  ${isWatched ? "●" : "○"} ${s.name} — ${age} ago`);
  }

  if (ctx.lastMessageAt) {
    const ago = Date.now() - ctx.lastMessageAt;
    lines.push(`Last msg received: ${formatDuration(ago)} ago`);
  } else {
    lines.push("Last msg received: none");
  }

  if (ctx.lastReplyAt) {
    const ago = Date.now() - ctx.lastReplyAt;
    lines.push(`Last reply sent: ${formatDuration(ago)} ago`);
  } else {
    lines.push("Last reply sent: none");
  }

  lines.push(`Pending reply: ${ctx.pendingReply ? "YES (AI thinking...)" : "no"}`);
  lines.push(`Host: ${os.hostname()} | Node ${process.version}`);
  lines.push(`Memory: ${(process.memoryUsage.rss() / 1024 / 1024).toFixed(0)}MB`);

  return lines.join("\n");
});

register("ping", "Measure API round-trip latency", async (_args, _ctx, client, userId) => {
  const t0 = Date.now();
  try {
    await client.getConfig(userId);
    const latency = Date.now() - t0;
    return `Pong! API latency: ${latency}ms`;
  } catch (err) {
    const latency = Date.now() - t0;
    return `Ping failed (${latency}ms): ${err instanceof Error ? err.message : String(err)}`;
  }
});

register("help", "List available commands", async () => {
  const lines = ["--- Available Commands ---"];
  for (const [name, { desc }] of commands) {
    lines.push(`/${name} — ${desc}`);
  }
  return lines.join("\n");
});

register("use", "Switch active session (e.g. /use viplevel)", async (args, ctx, _client, userId) => {
  if (!ctx.router) {
    return "Message router not available.";
  }

  const query = args.trim();
  if (!query) {
    const sessions = listSessions();
    const currentId = ctx.router.getActiveSession(userId);
    const lines = ["Usage: /use <session name>\n\nAvailable sessions:"];
    for (const s of sessions) {
      const marker = s.id === currentId ? " ← current" : "";
      lines.push(`  • ${s.name}${marker}`);
    }
    return lines.join("\n");
  }

  const match = ctx.router.findSessionByName(query);
  if (!match) {
    const sessions = listSessions();
    const names = sessions.map((s) => s.name).join(", ");
    return `No session matching "${query}".\nAvailable: ${names}`;
  }

  ctx.router.setActiveSession(userId, match.id);
  ctx.watcherManager?.setBoundSession(match.id);
  return `✓ 已切换到 [${match.name}]\n后续消息和 AI 回复将只通过此会话收发。`;
});

register("sessions", "List all sessions with status", async (_args, ctx, _client, userId) => {
  const sessions = listSessions();
  if (sessions.length === 0) {
    return "No active sessions.";
  }

  const currentId = ctx.router?.getActiveSession(userId);
  const boundId = ctx.watcherManager?.getBoundSessionId();
  const watchedIds = ctx.watcherManager?.getWatchedSessionIds() ?? [];
  const lines = ["--- Sessions ---"];

  for (const s of sessions) {
    const isCurrent = s.id === currentId;
    const isBound = s.id === boundId;
    const isWatched = watchedIds.includes(s.id);
    const age = formatDuration(Date.now() - s.lastActiveAt);
    const markers: string[] = [];
    if (isCurrent) markers.push("current");
    if (isBound) markers.push("bound");
    if (isWatched) markers.push("watched");
    const suffix = markers.length > 0 ? ` [${markers.join(", ")}]` : "";
    lines.push(`• ${s.name} — ${age} ago${suffix}`);
  }

  lines.push("\nUse /use <name> to switch session.");
  return lines.join("\n");
});

register("session", "Show MultiSession details", async (_args, ctx, _client, userId) => {
  const sessions = listSessions();
  if (sessions.length === 0) {
    return "No active MultiSession sessions.";
  }
  const currentId = ctx.router?.getActiveSession(userId);
  const lines = ["--- MultiSession ---"];
  for (const s of sessions) {
    const age = formatDuration(Date.now() - s.lastActiveAt);
    const marker = s.id === currentId ? " ← current" : "";
    lines.push(`• ${s.name} (${s.id.slice(0, 8)}) — last active ${age} ago${marker}`);
  }
  lines.push("\nUse /use <name> to switch session.");
  lines.push("Use /rename <new name> to rename the current session.");
  return lines.join("\n");
});

register("rename", "Rename the current session", async (args, ctx, _client, userId) => {
  const newName = args.trim();
  if (!newName) {
    return "Usage: /rename <new name>\nExample: /rename my-project";
  }

  const activeId = ctx.router?.getActiveSession(userId);
  if (!activeId) {
    return "No active session to rename. Use /use <name> first.";
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
      return `Session ${activeId} not found in sessions.json.`;
    }

    const oldName = target.name;
    target.name = newName;
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, "\t"), "utf-8");

    return `Session renamed: "${oldName}" → "${newName}"`;
  } catch (err) {
    return `Failed to rename: ${err instanceof Error ? err.message : String(err)}`;
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
      await client.sendText(userId, `Command /${cmdName} failed: ${err instanceof Error ? err.message : String(err)}`, contextToken);
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
