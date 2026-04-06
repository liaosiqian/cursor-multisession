import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { listSessions, type SessionEntry } from './multisession';
import { logger } from '../util/logger';

const MULTISESSION_DIR = path.join(os.homedir(), ".multisession");
const BINDING_FILE = path.join(MULTISESSION_DIR, "wechat-binding.json");

interface BindingData {
  boundSessionId: string | null;
  updatedAt: number;
}

function loadBinding(): BindingData {
  try {
    if (!fs.existsSync(BINDING_FILE)) return { boundSessionId: null, updatedAt: 0 };
    return JSON.parse(fs.readFileSync(BINDING_FILE, "utf-8")) as BindingData;
  } catch {
    return { boundSessionId: null, updatedAt: 0 };
  }
}

function saveBinding(data: BindingData): void {
  fs.mkdirSync(MULTISESSION_DIR, { recursive: true });
  fs.writeFileSync(BINDING_FILE, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Routes WeChat messages to the correct MultiSession session.
 *
 * Binding is persisted to ~/.multisession/wechat-binding.json so all
 * Cursor windows share the same binding state. Only the bound session
 * receives messages; if no session is bound and multiple sessions exist,
 * route() returns null and the caller should prompt the user to /use.
 */
export class MessageRouter {

  constructor() {}

  /**
   * Set the bound session (persisted to shared file).
   */
  setDefaultSession(sessionId: string): void {
    saveBinding({ boundSessionId: sessionId, updatedAt: Date.now() });
    logger.info({ sessionId }, "binding saved to shared file");
  }

  /**
   * Clear the binding.
   */
  clearBinding(): void {
    saveBinding({ boundSessionId: null, updatedAt: Date.now() });
    logger.info("binding cleared");
  }

  /**
   * Get the currently bound session ID from the shared file.
   * Returns the bound session if alive. If the bound session is dead,
   * returns null (does NOT fallback) so the user is prompted to rebind.
   * Only auto-selects when there is NO binding at all and exactly one
   * alive session exists.
   */
  getActiveSession(_userId: string): string | null {
    const binding = loadBinding();

    if (binding.boundSessionId) {
      const alive = listSessions();
      return alive.some(s => s.id === binding.boundSessionId)
        ? binding.boundSessionId
        : null;
    }

    const alive = listSessions();
    return alive.length === 1 ? alive[0].id : null;
  }

  /**
   * Set the active session for a user (e.g. via /use command).
   * Under single-binding semantics this is the same as setDefaultSession.
   */
  setActiveSession(_userId: string, sessionId: string): void {
    saveBinding({ boundSessionId: sessionId, updatedAt: Date.now() });
    logger.info({ sessionId }, "active session set (binding updated)");
  }

  /**
   * Read the bound session ID from the shared file (without fallback).
   */
  getBoundSessionId(): string | null {
    return loadBinding().boundSessionId;
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
