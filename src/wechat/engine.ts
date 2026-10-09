import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from '../shared/data-root';
import { loadConfig, ILINK_BASE_URL } from './config/index';
import { ClawBotClient } from './api/client';
import { MessagePoller } from './poller/index';
import { MediaService } from './media/index';
import { createServer, startServer } from './server/index';
import { fetchQRCode, pollQRStatus, type LoginResult } from './auth/login';
import {
  loadCredentials,
  saveCredentials,
  saveContextToken,
  loadContextToken,
  clearCredentials,
  type StoredCredentials,
} from './auth/store';
import { pushMessage, getSessionName, listSessions } from './bridge/multisession';
import { SessionWatcherManager } from './bridge/session-watcher-manager';
import { MessageRouter } from './bridge/message-router';
import { matchAnswer, answerInquiry } from './bridge/inquiry-watcher';
import { extractMessage } from './bridge/message-extract';
import { MessageType, UploadMediaType } from './api/types';
import { captureAndCleanup } from './screenshot';
import { tryHandleSlashCommand, type SlashContext } from './slash/index';
import { logger, applyLogLevelFromConfig } from './util/logger';
import type http from "node:http";

export type EngineState = "idle" | "logging_in" | "connecting" | "connected" | "error";

export interface QRCodeInfo {
  qrcodeKey: string;
  qrcodeUrl: string;
}

export interface EngineEvents {
  stateChange: [state: EngineState, detail?: string];
  qrCode: [info: QRCodeInfo];
  qrScanned: [];
  loginSuccess: [result: LoginResult];
  loginError: [err: Error];
  message: [from: string, text: string];
  replyPending: [];
  replySent: [text: string];
  error: [err: Error];
  boundSessionChanged: [sessionId: string | null];
}

const WECHAT_ACTION_DIR = path.join(DATA_ROOT, 'wechat-actions');

const ENGINE_LOCK_DIR = DATA_ROOT;
const ENGINE_LOCK_FILE = path.join(ENGINE_LOCK_DIR, 'wechat-engine.lock');
const LOCK_STALE_MS = 60_000;

function tryAcquireEngineLock(instanceId: string): boolean {
  try {
    if (!fs.existsSync(ENGINE_LOCK_DIR)) fs.mkdirSync(ENGINE_LOCK_DIR, { recursive: true });
    if (fs.existsSync(ENGINE_LOCK_FILE)) {
      const raw = JSON.parse(fs.readFileSync(ENGINE_LOCK_FILE, 'utf-8'));
      if (raw.id === instanceId) return true;
      if (Date.now() - raw.ts < LOCK_STALE_MS) return false;
    }
    fs.writeFileSync(ENGINE_LOCK_FILE, JSON.stringify({ id: instanceId, ts: Date.now() }), 'utf-8');
    return true;
  } catch { return false; }
}

function renewEngineLock(instanceId: string): void {
  try {
    fs.writeFileSync(ENGINE_LOCK_FILE, JSON.stringify({ id: instanceId, ts: Date.now() }), 'utf-8');
  } catch { /* best effort */ }
}

function releaseEngineLock(instanceId: string): void {
  try {
    if (!fs.existsSync(ENGINE_LOCK_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(ENGINE_LOCK_FILE, 'utf-8'));
    if (raw.id === instanceId) fs.unlinkSync(ENGINE_LOCK_FILE);
  } catch { /* best effort */ }
}

export class ClawBotEngine extends EventEmitter<EngineEvents> {
  private state: EngineState = "idle";
  private client: ClawBotClient | null = null;
  private poller: MessagePoller | null = null;
  private media: MediaService | null = null;
  private server: http.Server | null = null;
  private watcherManager: SessionWatcherManager | null = null;
  private router: MessageRouter | null = null;
  private loginAbort: AbortController | null = null;
  private connectedSince: number | null = null;
  private lastMessageAt: number | null = null;
  private lastReplyAt: number | null = null;
  private pendingReply = false;
  private accountId?: string;
  private skipServer: boolean;
  private actionWatcher: fs.FSWatcher | null = null;
  private actionProcessing = false;
  private instanceId = `eng-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  private lockRenewTimer: ReturnType<typeof setInterval> | null = null;
  private seenMessageIds = new Set<number>();
  private readonly MAX_SEEN_IDS = 2000;

  constructor(accountId?: string, options?: { skipServer?: boolean }) {
    super();
    this.accountId = accountId;
    this.skipServer = options?.skipServer ?? false;
  }

  getState(): EngineState {
    return this.state;
  }

  getRouter(): MessageRouter | null {
    return this.router;
  }

  getWatcherManager(): SessionWatcherManager | null {
    return this.watcherManager;
  }

  hasCredentials(): boolean {
    const creds = loadCredentials(this.accountId);
    return !!(creds?.token);
  }

  getCredentials(): StoredCredentials | null {
    return loadCredentials(this.accountId);
  }

  private setState(s: EngineState, detail?: string) {
    this.state = s;
    this.emit("stateChange", s, detail);
  }

  async login(): Promise<void> {
    if (this.state === "logging_in") return;
    this.setState("logging_in");
    this.loginAbort = new AbortController();

    try {
      const qr = await fetchQRCode();
      this.emit("qrCode", {
        qrcodeKey: qr.qrcode,
        qrcodeUrl: qr.qrcode_img_content,
      });

      while (!this.loginAbort.signal.aborted) {
        const resp = await pollQRStatus(qr.qrcode);

        if (this.loginAbort.signal.aborted) break;

        switch (resp.status) {
          case "wait":
            break;
          case "scaned":
            this.emit("qrScanned");
            break;
          case "confirmed": {
            if (!resp.bot_token || !resp.ilink_bot_id || !resp.ilink_user_id) {
              throw new Error("Login confirmed but missing credentials");
            }
            const result: LoginResult = {
              bot_token: resp.bot_token,
              ilink_bot_id: resp.ilink_bot_id,
              ilink_user_id: resp.ilink_user_id,
            };
            saveCredentials({
              token: result.bot_token,
              baseUrl: ILINK_BASE_URL,
              botId: result.ilink_bot_id,
              userId: result.ilink_user_id,
              savedAt: new Date().toISOString(),
            }, this.accountId);
            this.emit("loginSuccess", result);
            this.setState("idle");
            return;
          }
          case "expired":
            throw new Error("QR code expired");
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("loginError", error);
      this.setState("error", error.message);
    } finally {
      this.loginAbort = null;
    }
  }

  cancelLogin(): void {
    this.loginAbort?.abort();
    this.setState("idle");
  }

  async connect(): Promise<void> {
    if (this.state === "connected" || this.state === "connecting") return;

    if (!tryAcquireEngineLock(this.instanceId)) {
      logger.warn("another Cursor window already owns the WeChat engine lock, skipping connect");
      this.setState("idle");
      return;
    }

    this.setState("connecting");

    this.lockRenewTimer = setInterval(() => renewEngineLock(this.instanceId), LOCK_STALE_MS / 3);

    try {
      const rawConfig = loadConfig();
      applyLogLevelFromConfig(rawConfig.logLevel);

      const stored = loadCredentials(this.accountId);
      if (!stored?.token) {
        this.setState("idle");
        throw new Error("No credentials. Please login first.");
      }

      rawConfig.token = stored.token;
      rawConfig.baseUrl = stored.baseUrl || rawConfig.baseUrl;

      this.client = new ClawBotClient(rawConfig);
      this.media = new MediaService(this.client);
      this.poller = new MessagePoller(this.client, rawConfig);

      // multi-session: router + watcher manager
      this.router = new MessageRouter();

      if (stored.userId) {
        this.watcherManager = new SessionWatcherManager(
          this.client,
          stored.userId,
        );
        this.watcherManager.setOnReplySent((ev) => {
          this.pendingReply = false;
          this.lastReplyAt = Date.now();
          this.cancelTypingToUser();
          this.emit("replySent", ev.text);
        });
        const ACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
        this.watcherManager.setIsUserActive(() => {
          return this.lastMessageAt !== null && (Date.now() - this.lastMessageAt) < ACTIVITY_TIMEOUT_MS;
        });
        this.watcherManager.start();
      }

      this.startActionWatcher(stored.userId);

      this.poller.on("message", async (msg) => {
        try {
          if (msg.message_type === MessageType.BOT) return;

          if (msg.message_id) {
            if (this.seenMessageIds.has(msg.message_id)) return;
            this.seenMessageIds.add(msg.message_id);
            if (this.seenMessageIds.size > this.MAX_SEEN_IDS) {
              const first = this.seenMessageIds.values().next().value;
              if (first !== undefined) this.seenMessageIds.delete(first);
            }
          }

          if (msg.context_token && msg.from_user_id) {
            saveContextToken(msg.from_user_id, msg.context_token);
          }

          this.lastMessageAt = Date.now();
          const userId = msg.from_user_id ?? "unknown";

          // determine active session for media extraction
          const activeSessionId = this.router?.route(userId) ?? null;

          const extracted = activeSessionId && this.media
            ? await extractMessage(msg, activeSessionId, this.media)
            : {
                text: msg.item_list
                  ?.filter((i) => i.type === 1 && i.text_item?.text)
                  .map((i) => i.text_item!.text!)
                  .join("\n") ?? "",
                imagePaths: [],
              };

          if (!extracted.text) return;

          this.emit("message", userId, extracted.text);

          if (!this.client || !msg.from_user_id) return;

          // 1. slash commands
          const slashCtx: SlashContext = {
            engineState: this.state,
            connectedSince: this.connectedSince,
            lastMessageAt: this.lastMessageAt,
            lastReplyAt: this.lastReplyAt,
            pendingReply: this.pendingReply,
            router: this.router,
            watcherManager: this.watcherManager,
            onBoundSessionChanged: (sessionId) => {
              this.emit("boundSessionChanged", sessionId);
            },
            sendScreenshot: (toUserId: string) => this.sendScreenshot(toUserId),
          };
          const handled = await tryHandleSlashCommand(
            extracted.text,
            this.client,
            msg.from_user_id,
            slashCtx,
          );
          if (handled) return;

          // 2. inquiry matching (scoped to bound session if set)
          const boundId = this.watcherManager?.getBoundSessionId() ?? null;
          let pendingInquiries = this.watcherManager?.getAllPendingInquiries() ?? [];
          if (boundId) {
            pendingInquiries = pendingInquiries.filter(p => p.sessionId === boundId);
          }
          if (pendingInquiries.length > 0 && this.client) {
            const sorted = [...pendingInquiries].sort((a, b) => {
              const aIsActive = a.sessionId === activeSessionId ? 0 : 1;
              const bIsActive = b.sessionId === activeSessionId ? 0 : 1;
              if (aIsActive !== bIsActive) return aIsActive - bIsActive;
              return b.inquiry.ts - a.inquiry.ts;
            });

            for (const pending of sorted) {
              const answers: Array<{ questionIdx: number; selectedIds: string[] }> = [];
              for (let qi = 0; qi < pending.inquiry.questions.length; qi++) {
                const matched = matchAnswer(extracted.text, pending.inquiry.questions[qi]);
                if (matched) {
                  answers.push({ questionIdx: qi, selectedIds: matched });
                }
              }
              if (answers.length > 0) {
                answerInquiry(pending.sessionId, pending.inquiry, answers);
                const sName = getSessionName(pending.sessionId) ?? pending.sessionId;
                const selectedLabels = answers.flatMap((a) =>
                  a.selectedIds.map((id) => {
                    const q = pending.inquiry.questions[a.questionIdx];
                    return q.options.find((o) => o.id === id)?.label ?? id;
                  }),
                );
                const ctx = loadContextToken(msg.from_user_id);
                await this.client.sendText(
                  msg.from_user_id,
                  `[${sName}] ✓ 已选择: ${selectedLabels.join(", ")}`,
                  ctx,
                );
                return;
              }
            }
          }

          // 3. route message to active session
          const targetSession = this.router?.route(msg.from_user_id) ?? null;
          if (targetSession) {
            try {
              pushMessage(targetSession, extracted.text);
            } catch { /* */ }
            this.pendingReply = true;
            this.sendTypingToUser(msg.from_user_id);
            this.emit("replyPending");
          } else {
            const ctx = loadContextToken(msg.from_user_id);
            const alive = listSessions();
            if (alive.length === 0) {
              await this.client.sendText(msg.from_user_id,
                "当前没有活跃的会话。请先在 Cursor 中启动一个 Composer 对话。", ctx);
            } else {
              await this.client.sendText(msg.from_user_id,
                "当前未绑定活跃会话，请复制发送以下任一指令切换：", ctx);
              for (const s of alive) {
                await this.client.sendText(msg.from_user_id, `/use ${s.name}`, ctx);
              }
            }
          }
        } catch (err) {
          logger.error({ err: String(err) }, "message handler error");
        }
      });

      this.poller.on("connected", () => {
        this.connectedSince = Date.now();
        this.setState("connected");
      });

      this.poller.on("error", (err) => {
        this.emit("error", err);
      });

      if (this.skipServer) {
        logger.info("HTTP server skipped (extension mode)");
        this.server = null;
      } else {
        try {
          this.server = createServer(this.client, this.media, rawConfig);
          await startServer(this.server, rawConfig);
        } catch (serverErr: any) {
          logger.warn(`HTTP server start failed (port ${rawConfig.serverPort}): ${serverErr.message} — continuing without server`);
          this.server = null;
        }
      }
      await this.poller.start();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.setState("error", error.message);
      throw error;
    }
  }

  disconnect(): void {
    if (this.lockRenewTimer) { clearInterval(this.lockRenewTimer); this.lockRenewTimer = null; }
    releaseEngineLock(this.instanceId);
    this.actionWatcher?.close();
    this.actionWatcher = null;
    this.watcherManager?.stop();
    this.watcherManager = null;
    this.router = null;
    this.poller?.stop();
    this.poller = null;
    this.server?.close();
    this.server = null;
    this.client = null;
    this.media = null;
    this.connectedSince = null;
    this.pendingReply = false;
    this.seenMessageIds.clear();
    this.setState("idle");
  }

  logout(): void {
    this.disconnect();
    clearCredentials(this.accountId);
  }

  async sendScreenshot(toUserId?: string): Promise<string> {
    if (!this.client || !this.media) {
      throw new Error("Not connected");
    }
    const creds = loadCredentials(this.accountId);
    const userId = toUserId ?? creds?.userId;
    if (!userId) throw new Error("No target user");

    const filePath = await captureAndCleanup();
    const ctx = loadContextToken(userId);

    const upload = await this.media.upload(filePath, userId, UploadMediaType.IMAGE);
    const imageItem = this.media.buildImageItem(upload);

    await this.client.sendMediaItem(userId, imageItem, ctx);

    logger.info(
      { filePath, userId, filekey: upload.filekey, downloadParam: upload.downloadParam },
      "screenshot image sent via WeChat",
    );
    return filePath;
  }

  async sendTypingToUser(userId?: string): Promise<void> {
    if (!this.client) return;
    const creds = loadCredentials(this.accountId);
    const uid = userId ?? creds?.userId;
    if (!uid) return;
    const ctx = loadContextToken(uid);
    try {
      await this.client.startTyping(uid, ctx);
    } catch {
      // best effort
    }
  }

  private startActionWatcher(targetUserId: string): void {
    if (!fs.existsSync(WECHAT_ACTION_DIR)) {
      fs.mkdirSync(WECHAT_ACTION_DIR, { recursive: true });
    }

    const processAll = async () => {
      if (this.actionProcessing) return;
      this.actionProcessing = true;
      try {
        const files = fs.readdirSync(WECHAT_ACTION_DIR).filter(f => f.endsWith('.json'));
        for (const file of files) {
          const fp = path.join(WECHAT_ACTION_DIR, file);
          try {
            const raw = fs.readFileSync(fp, 'utf-8');
            const action = JSON.parse(raw);
            if (action.status !== 'pending') continue;
            await this.processAction(action, targetUserId, fp);
          } catch (err) {
            logger.warn({ file, err: String(err) }, "action processing error");
          }
        }
      } catch { /* dir read error */ }
      this.actionProcessing = false;
    };

    try {
      this.actionWatcher = fs.watch(WECHAT_ACTION_DIR, () => {
        void processAll();
      });
    } catch (err) {
      logger.warn({ err: String(err) }, "action watcher: fs.watch failed");
    }

    void processAll();
    logger.info("wechat action watcher started");
  }

  private async processAction(action: any, targetUserId: string, filePath: string): Promise<void> {
    if (!this.client || !this.media) {
      this.writeActionResult(filePath, 'error', '微信 Bot 未连接');
      return;
    }

    const ctx = loadContextToken(targetUserId);

    try {
      switch (action.action) {
        case 'screenshot': {
          const screenshotPath = await captureAndCleanup();
          const upload = await this.media.upload(screenshotPath, targetUserId, UploadMediaType.IMAGE);
          const imageItem = this.media.buildImageItem(upload);
          await this.client.sendMediaItem(targetUserId, imageItem, ctx);
          if (action.content) {
            await this.client.sendText(targetUserId, action.content, ctx);
          }
          this.writeActionResult(filePath, 'done', '截图已发送到微信');
          logger.info({ actionId: action.id }, "wechat action: screenshot sent");
          break;
        }
        case 'image': {
          const upload = await this.media.upload(action.content, targetUserId, UploadMediaType.IMAGE);
          const imageItem = this.media.buildImageItem(upload);
          await this.client.sendMediaItem(targetUserId, imageItem, ctx);
          this.writeActionResult(filePath, 'done', `图片已发送: ${path.basename(action.content)}`);
          logger.info({ actionId: action.id, file: action.content }, "wechat action: image sent");
          break;
        }
        case 'file': {
          const upload = await this.media.upload(action.content, targetUserId, UploadMediaType.FILE);
          const fileItem = this.media.buildFileItem(upload, path.basename(action.content));
          await this.client.sendMediaItem(targetUserId, fileItem, ctx);
          this.writeActionResult(filePath, 'done', `文件已发送: ${path.basename(action.content)}`);
          logger.info({ actionId: action.id, file: action.content }, "wechat action: file sent");
          break;
        }
        case 'text': {
          await this.client.sendText(targetUserId, action.content, ctx);
          this.writeActionResult(filePath, 'done', '文本消息已发送');
          logger.info({ actionId: action.id }, "wechat action: text sent");
          break;
        }
        case 'video': {
          const upload = await this.media.upload(action.content, targetUserId, UploadMediaType.VIDEO);
          const videoItem = this.media.buildVideoItem(upload);
          await this.client.sendMediaItem(targetUserId, videoItem, ctx);
          this.writeActionResult(filePath, 'done', `视频已发送: ${path.basename(action.content)}`);
          logger.info({ actionId: action.id, file: action.content }, "wechat action: video sent");
          break;
        }
        default:
          this.writeActionResult(filePath, 'error', `未知 action 类型: ${action.action}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeActionResult(filePath, 'error', msg);
      logger.error({ actionId: action.id, err: msg }, "wechat action failed");
    }
  }

  private writeActionResult(filePath: string, status: string, message: string): void {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      data.status = status;
      data.message = message;
      data.completedAt = Date.now();
      fs.writeFileSync(filePath, JSON.stringify(data, null, '\t'), 'utf-8');
    } catch { /* best effort */ }
  }

  async cancelTypingToUser(userId?: string): Promise<void> {
    if (!this.client) return;
    const creds = loadCredentials(this.accountId);
    const uid = userId ?? creds?.userId;
    if (!uid) return;
    const ctx = loadContextToken(uid);
    try {
      await this.client.cancelTyping(uid, ctx);
    } catch {
      // best effort
    }
  }
}

export { fetchQRCode, pollQRStatus } from './auth/login';
