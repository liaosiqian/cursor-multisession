import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from '../../shared/data-root';
import { ClawBotClient } from '../api/client';
import { loadContextToken } from '../auth/store';
import { logger } from '../util/logger';

const MULTISESSION_DIR = DATA_ROOT;
const DEBOUNCE_MS = 200;

interface InquiryOption {
  id: string;
  label: string;
}

interface InquiryQuestion {
  question: string;
  options: InquiryOption[];
  allow_multiple?: boolean;
}

interface Inquiry {
  id: string;
  questions: InquiryQuestion[];
  ts: number;
  answered: boolean;
  answers?: Array<{
    questionIdx: number;
    selectedIds: string[];
  }>;
}

export interface PendingInquiry {
  inquiry: Inquiry;
  sessionId: string;
}

function readInquirySafe(filePath: string): Inquiry | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Inquiry;
  } catch {
    return null;
  }
}

/**
 * Format an inquiry into a readable WeChat text message.
 */
function formatInquiryMessage(inquiry: Inquiry): string {
  const lines: string[] = ["🤖 AI 提问："];

  for (let qi = 0; qi < inquiry.questions.length; qi++) {
    const q = inquiry.questions[qi];
    if (inquiry.questions.length > 1) {
      lines.push(`\n问题 ${qi + 1}: ${q.question}`);
    } else {
      lines.push(`${q.question}`);
    }
    lines.push("");
    for (const opt of q.options) {
      lines.push(`  ${opt.id}. ${opt.label}`);
    }
    if (q.allow_multiple) {
      lines.push("\n（可多选，用逗号分隔，如: a,b）");
    }
  }

  lines.push("\n直接回复选项编号即可。");
  return lines.join("\n");
}

/**
 * Try to match a user reply to an inquiry's options.
 * Supports matching by: option id, option index (1-based), or label substring.
 */
export function matchAnswer(
  text: string,
  question: InquiryQuestion,
): string[] | null {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return null;

  const parts = trimmed.split(/[,，\s]+/).filter(Boolean);
  const matched: string[] = [];

  for (const part of parts) {
    const byId = question.options.find((o) => o.id.toLowerCase() === part);
    if (byId) {
      matched.push(byId.id);
      continue;
    }

    const idx = parseInt(part, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= question.options.length) {
      matched.push(question.options[idx - 1].id);
      continue;
    }

    const byLabel = question.options.find((o) =>
      o.label.toLowerCase().includes(part),
    );
    if (byLabel) {
      matched.push(byLabel.id);
      continue;
    }
  }

  if (matched.length === 0) return null;
  if (!question.allow_multiple && matched.length > 1) {
    return [matched[0]];
  }
  return matched;
}

/**
 * Write the user's answer back to inquiry.json.
 */
export function answerInquiry(
  sessionId: string,
  inquiry: Inquiry,
  answers: Array<{ questionIdx: number; selectedIds: string[] }>,
): void {
  const inquiryPath = path.join(
    MULTISESSION_DIR,
    "sessions",
    sessionId,
    "inquiry.json",
  );

  const updated: Inquiry = {
    ...inquiry,
    answered: true,
    answers,
  };

  fs.writeFileSync(inquiryPath, JSON.stringify(updated, null, "\t"), "utf-8");
  logger.info(
    { inquiryId: inquiry.id, sessionId, answers },
    "inquiry answered",
  );
}

export interface InquiryWatcherOptions {
  isUserActive?: () => boolean;
}

/**
 * Watch inquiry.json for new AI questions and forward them to WeChat.
 * Returns a cleanup function and a reference to the current pending inquiry.
 *
 * If `options.isUserActive` is provided, inquiries are only forwarded when
 * the function returns true (e.g. user sent a WeChat message within the last 30 min).
 */
export function startInquiryWatcher(
  sessionId: string,
  client: ClawBotClient,
  targetUserId: string,
  onInquiryForwarded?: (inquiry: Inquiry) => void,
  options?: InquiryWatcherOptions,
): {
  stop: () => void;
  getPending: () => PendingInquiry | null;
} {
  const inquiryPath = path.join(
    MULTISESSION_DIR,
    "sessions",
    sessionId,
    "inquiry.json",
  );
  const watchDir = path.dirname(inquiryPath);
  const inquiryBasename = path.basename(inquiryPath);

  let lastInquiryId = "";
  let pendingInquiry: PendingInquiry | null = null;
  const sentInquiryIds = new Set<string>();
  let processing = false;

  const initial = readInquirySafe(inquiryPath);
  if (initial) {
    lastInquiryId = initial.id;
    sentInquiryIds.add(initial.id);
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const processInquiry = async (): Promise<void> => {
    if (processing) return;
    processing = true;
    try {
      const data = readInquirySafe(inquiryPath);
      if (!data || data.answered || data.id === lastInquiryId || sentInquiryIds.has(data.id)) {
        processing = false;
        return;
      }

      lastInquiryId = data.id;
      sentInquiryIds.add(data.id);
      pendingInquiry = { inquiry: data, sessionId };

      if (options?.isUserActive && !options.isUserActive()) {
        logger.info(
          { sessionId, inquiryId: data.id },
          "inquiry watcher: skipping send — user not active in WeChat recently",
        );
        return;
      }

      const message = formatInquiryMessage(data);
      const ctx = loadContextToken(targetUserId);
      await client.sendText(targetUserId, message, ctx);

      onInquiryForwarded?.(data);

      logger.info(
        { inquiryId: data.id, questionCount: data.questions.length },
        "inquiry forwarded to WeChat",
      );
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "inquiry watcher error",
      );
    } finally {
      processing = false;
    }
  };

  const scheduleProcess = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void processInquiry();
    }, DEBOUNCE_MS);
  };

  let watcher: fs.FSWatcher | null = null;
  try {
    if (!fs.existsSync(watchDir)) {
      fs.mkdirSync(watchDir, { recursive: true });
    }
    watcher = fs.watch(watchDir, (_eventType, filename) => {
      if (filename !== inquiryBasename && filename !== null) return;
      scheduleProcess();
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), watchDir },
      "inquiry watcher: fs.watch failed",
    );
  }

  scheduleProcess();
  logger.info({ sessionId, targetUserId }, "inquiry watcher started");

  return {
    stop: () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      watcher?.close();
      logger.info("inquiry watcher stopped");
    },
    getPending: () => pendingInquiry,
  };
}
