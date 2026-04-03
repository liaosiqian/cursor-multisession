import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { ClawBotClient } from '../api/client';
import { loadContextToken } from '../auth/store';
import { logger } from '../util/logger';

const MULTISESSION_DIR = path.join(os.homedir(), ".multisession");
const DEBOUNCE_MS = 150;

interface Summary {
  text: string;
  ts: number;
}

function fingerprint(summary: Summary): string {
  const h = crypto.createHash("sha256").update(summary.text, "utf-8").digest("hex");
  return `${summary.ts}:${h}`;
}

function readSummarySafe(summaryPath: string): Summary | null {
  try {
    if (!fs.existsSync(summaryPath)) return null;
    const raw = fs.readFileSync(summaryPath, "utf-8");
    const data = JSON.parse(raw) as Summary;
    if (typeof data.text !== "string" || typeof data.ts !== "number") {
      return null;
    }
    return data;
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        summaryPath,
      },
      "reply watcher: failed to read summary (will retry on next event)",
    );
    return null;
  }
}

/**
 * Watch summary.json for changes and auto-send AI replies to WeChat.
 * When the AI writes a reply via check_messages(reply=...), it updates
 * summary.json. This watcher detects the change and sends it to WeChat.
 */
export function startReplyWatcher(
  sessionId: string,
  client: ClawBotClient,
  targetUserId: string,
  onReplySent?: (text: string) => void,
  sessionName?: string,
): () => void {
  const summaryPath = path.join(
    MULTISESSION_DIR,
    "sessions",
    sessionId,
    "summary.json",
  );
  const watchDir = path.dirname(summaryPath);
  const summaryBasename = path.basename(summaryPath);

  const sentFingerprints = new Set<string>();
  let lastTs = 0;
  const initial = readSummarySafe(summaryPath);
  if (initial) {
    lastTs = initial.ts ?? 0;
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const processSummary = async (): Promise<void> => {
    try {
      const data = readSummarySafe(summaryPath);
      if (!data || !data.text || !data.ts || data.ts <= lastTs) return;

      const fp = fingerprint(data);
      if (sentFingerprints.has(fp)) {
        lastTs = Math.max(lastTs, data.ts);
        return;
      }

      lastTs = data.ts;
      const ctx = loadContextToken(targetUserId);
      if (!ctx) {
        logger.warn("no context_token for reply watcher, skipping");
        return;
      }

      const prefix = sessionName ? `[${sessionName}] ` : "";
      await client.sendText(targetUserId, `${prefix}${data.text}`, ctx);
      sentFingerprints.add(fp);
      if (sentFingerprints.size > 500) {
        const iter = sentFingerprints.values();
        const first = iter.next().value;
        if (first !== undefined) sentFingerprints.delete(first);
      }

      onReplySent?.(data.text);

      logger.info(
        { textLen: data.text.length, targetUserId },
        "auto-sent AI reply to WeChat",
      );
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "reply watcher error",
      );
    }
  };

  const scheduleProcess = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void processSummary();
    }, DEBOUNCE_MS);
  };

  let watcher: fs.FSWatcher | null = null;
  try {
    if (!fs.existsSync(watchDir)) {
      fs.mkdirSync(watchDir, { recursive: true });
    }
    watcher = fs.watch(watchDir, (eventType, filename) => {
      if (filename !== summaryBasename && filename !== null) return;
      scheduleProcess();
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), watchDir },
      "reply watcher: fs.watch failed",
    );
  }

  scheduleProcess();

  logger.info({ sessionId, targetUserId }, "reply watcher started");

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    watcher?.close();
    logger.info("reply watcher stopped");
  };
}
