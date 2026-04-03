import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { listSessions, type SessionEntry } from './multisession';
import { logger } from '../util/logger';

interface ActiveSessionStore {
  [userId: string]: string;
}

function resolveDataDir(): string {
  const dir =
    process.env.CLAWBOT_DATA_DIR ?? path.join(os.homedir(), ".clawbot");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function storePath(): string {
  return path.join(resolveDataDir(), "active-sessions.json");
}

function loadStore(): ActiveSessionStore {
  try {
    const p = storePath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf-8")) as ActiveSessionStore;
  } catch {
    return {};
  }
}

function saveStore(store: ActiveSessionStore): void {
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), "utf-8");
}

/**
 * Routes WeChat messages to the correct MultiSession session.
 * Maintains a per-user activeSessionId, persisted to disk.
 */
export class MessageRouter {
  private activeMap: ActiveSessionStore;
  private defaultSessionId: string | null = null;

  constructor() {
    this.activeMap = loadStore();
  }

  setDefaultSession(sessionId: string): void {
    this.defaultSessionId = sessionId;
    logger.info({ sessionId }, "default session set for this router");
  }

  /**
   * Get the active session ID for a user.
   * Priority: defaultSessionId (from binding) > activeMap (from /use) > fallback.
   */
  getActiveSession(userId: string): string | null {
    if (this.defaultSessionId) {
      const alive = listSessions();
      if (alive.some(s => s.id === this.defaultSessionId)) {
        return this.defaultSessionId;
      }
    }
    const stored = this.activeMap[userId];
    if (stored) {
      const alive = listSessions();
      if (alive.some((s) => s.id === stored)) {
        return stored;
      }
    }
    return this.fallbackSession(userId);
  }

  /**
   * Set the active session for a user (e.g. via /use command).
   */
  setActiveSession(userId: string, sessionId: string): void {
    this.activeMap[userId] = sessionId;
    saveStore(this.activeMap);
    logger.info({ userId, sessionId }, "active session set");
  }

  /**
   * Find a session by name (fuzzy match). Used by /use command.
   * Returns { id, name } or null.
   */
  findSessionByName(query: string): { id: string; name: string } | null {
    const alive = listSessions();
    if (alive.length === 0) return null;

    const q = query.trim().toLowerCase();

    // exact match on name
    const exact = alive.find((s) => s.name.toLowerCase() === q);
    if (exact) return { id: exact.id, name: exact.name };

    // prefix match on name
    const prefix = alive.filter((s) => s.name.toLowerCase().startsWith(q));
    if (prefix.length === 1) return { id: prefix[0].id, name: prefix[0].name };

    // substring match
    const substr = alive.filter((s) => s.name.toLowerCase().includes(q));
    if (substr.length === 1) return { id: substr[0].id, name: substr[0].name };

    // match workspace basename
    const byWorkspace = alive.filter((s) => {
      const base = path.basename(s.workspace || "").toLowerCase();
      return base === q || base.startsWith(q);
    });
    if (byWorkspace.length === 1)
      return { id: byWorkspace[0].id, name: byWorkspace[0].name };

    // session ID prefix match
    const byId = alive.find((s) => s.id.startsWith(q));
    if (byId) return { id: byId.id, name: byId.name };

    return null;
  }

  /**
   * Route a message: returns the sessionId to push to.
   */
  route(userId: string): string | null {
    return this.getActiveSession(userId);
  }

  private fallbackSession(userId: string): string | null {
    if (this.defaultSessionId) {
      const alive = listSessions();
      if (alive.some(s => s.id === this.defaultSessionId)) {
        this.activeMap[userId] = this.defaultSessionId!;
        saveStore(this.activeMap);
        logger.info(
          { userId, sessionId: this.defaultSessionId },
          "using configured default session",
        );
        return this.defaultSessionId;
      }
    }
    const alive = listSessions();
    if (alive.length === 0) return null;
    alive.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    const best = alive[0];
    this.activeMap[userId] = best.id;
    saveStore(this.activeMap);
    logger.info(
      { userId, sessionId: best.id, sessionName: best.name },
      "auto-selected fallback session",
    );
    return best.id;
  }
}
