import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from '../../shared/data-root';
import { logger } from '../util/logger';

const MULTISESSION_DIR = DATA_ROOT;
const SESSIONS_FILE = path.join(MULTISESSION_DIR, "sessions.json");

export interface SessionEntry {
  id: string;
  name: string;
  workspace: string;
  alive: boolean;
  createdAt: number;
  lastActiveAt: number;
}

interface QueueMessage {
  content: string;
  timestamp: number;
  urgent?: boolean;
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, "\t"), "utf-8");
}

/** Find the active MultiSession session for a given workspace. */
export function findActiveSession(workspace?: string): string | null {
  const sessions = readJson<SessionEntry[]>(SESSIONS_FILE);
  if (!sessions) return null;

  const alive = sessions.filter((s) => s.alive);
  if (alive.length === 0) return null;

  if (workspace) {
    const match = alive.filter((s) => s.workspace === workspace);
    if (match.length > 0) {
      match.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
      return match[0].id;
    }
  }

  alive.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return alive[0].id;
}

/** List all alive sessions. */
export function listSessions(): SessionEntry[] {
  return (readJson<SessionEntry[]>(SESSIONS_FILE) ?? []).filter((s) => s.alive);
}

/** Get the display name of a session by ID. */
export function getSessionName(sessionId: string): string | null {
  const sessions = readJson<SessionEntry[]>(SESSIONS_FILE);
  return sessions?.find((s) => s.id === sessionId)?.name ?? null;
}

/**
 * Push a message into a MultiSession queue.
 * The AI's check_messages will pick it up on next poll.
 */
export function pushMessage(
  sessionId: string,
  text: string,
  urgent = false,
): void {
  const queuePath = path.join(MULTISESSION_DIR, "sessions", sessionId, "queue.json");
  const queue = readJson<QueueMessage[]>(queuePath) ?? [];
  queue.push({
    content: text,
    timestamp: Date.now(),
    urgent,
  });
  writeJson(queuePath, queue);
  logger.info({ sessionId, textLen: text.length, urgent }, "pushed to MultiSession queue");
}

/** Read the latest summary (AI reply) from a session. */
export function readSummary(sessionId: string): string | null {
  const summaryPath = path.join(
    MULTISESSION_DIR,
    "sessions",
    sessionId,
    "summary.json",
  );
  const data = readJson<{ text: string; ts: number }>(summaryPath);
  return data?.text ?? null;
}

/**
 * Wait for a new AI reply by polling summary.json.
 * Returns the reply text, or null on timeout.
 */
export async function waitForReply(
  sessionId: string,
  timeoutMs = 120_000,
  pollIntervalMs = 2_000,
): Promise<string | null> {
  const summaryPath = path.join(
    MULTISESSION_DIR,
    "sessions",
    sessionId,
    "summary.json",
  );

  const startTs = readJson<{ text: string; ts: number }>(summaryPath)?.ts ?? 0;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const current = readJson<{ text: string; ts: number }>(summaryPath);
    if (current && current.ts > startTs) {
      return current.text;
    }
  }

  return null;
}
