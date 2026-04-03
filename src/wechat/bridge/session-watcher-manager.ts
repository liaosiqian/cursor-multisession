import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ClawBotClient } from '../api/client';
import { startReplyWatcher } from './reply-watcher';
import {
  startInquiryWatcher,
  type PendingInquiry,
} from './inquiry-watcher';
import { listSessions, getSessionName } from './multisession';
import { logger } from '../util/logger';

const MULTISESSION_DIR = path.join(os.homedir(), ".multisession");
const SESSIONS_FILE = path.join(MULTISESSION_DIR, "sessions.json");
const RESCAN_DEBOUNCE_MS = 500;

interface SessionWatcher {
  sessionId: string;
  sessionName: string;
  stopReply: () => void;
  inquiryHandle: { stop: () => void; getPending: () => PendingInquiry | null };
}

export interface ReplySentEvent {
  sessionId: string;
  sessionName: string;
  text: string;
}

/**
 * Watches all alive MultiSession sessions, managing reply-watchers and
 * inquiry-watchers for each. Automatically discovers new sessions and
 * cleans up closed ones via fs.watch on sessions.json.
 */
export class SessionWatcherManager {
  private watchers = new Map<string, SessionWatcher>();
  private sessionsWatcher: fs.FSWatcher | null = null;
  private rescanTimer: ReturnType<typeof setTimeout> | null = null;
  private onReplySent: ((ev: ReplySentEvent) => void) | null = null;

  constructor(
    private client: ClawBotClient,
    private targetUserId: string,
  ) {}

  setOnReplySent(cb: (ev: ReplySentEvent) => void): void {
    this.onReplySent = cb;
  }

  start(): void {
    this.rescan();

    try {
      if (!fs.existsSync(MULTISESSION_DIR)) {
        fs.mkdirSync(MULTISESSION_DIR, { recursive: true });
      }
      this.sessionsWatcher = fs.watch(MULTISESSION_DIR, (_event, filename) => {
        if (filename !== "sessions.json" && filename !== null) return;
        this.scheduleRescan();
      });
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "SessionWatcherManager: failed to watch sessions.json",
      );
    }

    logger.info(
      { watchedCount: this.watchers.size },
      "SessionWatcherManager started",
    );
  }

  stop(): void {
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
      this.rescanTimer = null;
    }
    this.sessionsWatcher?.close();
    this.sessionsWatcher = null;
    for (const w of this.watchers.values()) {
      w.stopReply();
      w.inquiryHandle.stop();
    }
    this.watchers.clear();
    logger.info("SessionWatcherManager stopped");
  }

  getWatchedSessionIds(): string[] {
    return [...this.watchers.keys()];
  }

  getAllPendingInquiries(): PendingInquiry[] {
    const result: PendingInquiry[] = [];
    for (const w of this.watchers.values()) {
      const p = w.inquiryHandle.getPending();
      if (p && !p.inquiry.answered) {
        result.push(p);
      }
    }
    return result;
  }

  getSessionNameById(sessionId: string): string | null {
    return this.watchers.get(sessionId)?.sessionName ?? null;
  }

  private scheduleRescan(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      this.rescan();
    }, RESCAN_DEBOUNCE_MS);
  }

  private rescan(): void {
    const alive = listSessions();
    const aliveIds = new Set(alive.map((s) => s.id));

    // stop watchers for sessions no longer alive
    for (const [id, w] of this.watchers) {
      if (!aliveIds.has(id)) {
        w.stopReply();
        w.inquiryHandle.stop();
        this.watchers.delete(id);
        logger.info({ sessionId: id, name: w.sessionName }, "watcher removed (session closed)");
      }
    }

    // start watchers for new alive sessions
    for (const s of alive) {
      if (this.watchers.has(s.id)) {
        const existing = this.watchers.get(s.id)!;
        if (existing.sessionName !== s.name) {
          existing.sessionName = s.name;
        }
        continue;
      }
      this.startWatcherForSession(s.id, s.name);
    }
  }

  private startWatcherForSession(sessionId: string, sessionName: string): void {
    try {
      const stopReply = startReplyWatcher(
        sessionId,
        this.client,
        this.targetUserId,
        (text: string) => {
          const currentName = getSessionName(sessionId) ?? sessionName;
          this.onReplySent?.({ sessionId, sessionName: currentName, text });
        },
        sessionName,
      );

      const inquiryHandle = startInquiryWatcher(
        sessionId,
        this.client,
        this.targetUserId,
      );

      this.watchers.set(sessionId, {
        sessionId,
        sessionName,
        stopReply,
        inquiryHandle,
      });

      logger.info({ sessionId, sessionName }, "watcher started for session");
    } catch (err) {
      logger.error(
        {
          sessionId,
          sessionName,
          err: err instanceof Error ? err.message : String(err),
        },
        "failed to start watcher for session",
      );
    }
  }
}
