import path from "node:path";
import { listSessions } from './multisession';
import { logger } from '../util/logger';

/**
 * Routes WeChat messages to the correct MultiSession session.
 *
 * Each WeChatEngine instance has its own MessageRouter, so binding is
 * per-account (in-memory). This avoids the old bug where multiple accounts
 * sharing a single wechat-binding.json would overwrite each other's bindings.
 */
export class MessageRouter {

  private boundSessionId: string | null = null;

  constructor() {}

  /**
   * Set the bound session for this router instance (in-memory).
   * Each account's engine has its own router, so this is per-account.
   */
  setDefaultSession(sessionId: string): void {
    this.boundSessionId = sessionId;
    logger.info({ sessionId }, "binding set (in-memory, per-account)");
  }

  /**
   * Clear the binding.
   */
  clearBinding(): void {
    this.boundSessionId = null;
    logger.info("binding cleared (in-memory)");
  }

  /**
   * Get the bound session ID for this router instance.
   * Returns the bound session if alive. If the bound session is dead,
   * returns null so the user is prompted to rebind.
   * Only auto-selects when there is NO binding and exactly one
   * alive session exists.
   */
  getActiveSession(_userId: string): string | null {
    if (this.boundSessionId) {
      const alive = listSessions();
      return alive.some(s => s.id === this.boundSessionId)
        ? this.boundSessionId
        : null;
    }

    const alive = listSessions();
    return alive.length === 1 ? alive[0].id : null;
  }

  /**
   * Set the active session for a user (e.g. via /use command).
   */
  setActiveSession(_userId: string, sessionId: string): void {
    this.boundSessionId = sessionId;
    logger.info({ sessionId }, "active session set (in-memory)");
  }

  /**
   * Read the bound session ID.
   */
  getBoundSessionId(): string | null {
    return this.boundSessionId;
  }

  /**
   * Find a session by name (fuzzy match). Used by /use command.
   */
  findSessionByName(query: string): { id: string; name: string } | null {
    const alive = listSessions();
    if (alive.length === 0) return null;

    // Strip trailing "(shortId)" if user copied from older prompts
    const q = query.trim().replace(/\s*\([a-z0-9]+\)\s*$/i, '').toLowerCase();

    const exact = alive.find((s) => s.name.toLowerCase() === q);
    if (exact) return { id: exact.id, name: exact.name };

    const prefix = alive.filter((s) => s.name.toLowerCase().startsWith(q));
    if (prefix.length === 1) return { id: prefix[0].id, name: prefix[0].name };

    const substr = alive.filter((s) => s.name.toLowerCase().includes(q));
    if (substr.length === 1) return { id: substr[0].id, name: substr[0].name };

    const byWorkspace = alive.filter((s) => {
      const base = path.basename(s.workspace || "").toLowerCase();
      return base === q || base.startsWith(q);
    });
    if (byWorkspace.length === 1)
      return { id: byWorkspace[0].id, name: byWorkspace[0].name };

    const byId = alive.find((s) => s.id.startsWith(q));
    if (byId) return { id: byId.id, name: byId.name };

    return null;
  }

  /**
   * Route a message: returns the bound sessionId, or null if unbound.
   */
  route(userId: string): string | null {
    return this.getActiveSession(userId);
  }
}
