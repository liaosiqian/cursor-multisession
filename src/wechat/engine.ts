import { EventEmitter } from "node:events";
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
import { pushMessage, getSessionName } from './bridge/multisession';
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
    const creds = loadCredentials();
    return !!(creds?.token);
  }

  getCredentials(): StoredCredentials | null {
    return loadCredentials();
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
            });
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
    this.setState("connecting");

    try {
      const rawConfig = loadConfig();
      applyLogLevelFromConfig(rawConfig.logLevel);

      const stored = loadCredentials();
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
        this.watcherManager.start();
      }

      this.poller.on("message", async (msg) => {
        try {
          if (msg.message_type === MessageType.BOT) return;
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
          };
          const handled = await tryHandleSlashCommand(
            extracted.text,
            this.client,
            msg.from_user_id,
            slashCtx,
          );
          if (handled) return;

          // 2. cross-session inquiry matching
          const allPending = this.watcherManager?.getAllPendingInquiries() ?? [];
          if (allPending.length > 0 && this.client) {
            // prefer inquiry from the user's active session, then by time
            const sorted = [...allPending].sort((a, b) => {
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
            await this.client.sendText(
              msg.from_user_id,
              "No active session. Use /sessions to see available sessions, then /use <name> to select one.",
              ctx,
            );
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

      this.server = createServer(this.client, this.media, rawConfig);
      await startServer(this.server, rawConfig);
      await this.poller.start();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.setState("error", error.message);
      throw error;
    }
  }

  disconnect(): void {
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
    this.setState("idle");
  }

  logout(): void {
    this.disconnect();
    clearCredentials();
  }

  async sendScreenshot(toUserId?: string): Promise<string> {
    if (!this.client || !this.media) {
      throw new Error("Not connected");
    }
    const creds = loadCredentials();
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
    const creds = loadCredentials();
    const uid = userId ?? creds?.userId;
    if (!uid) return;
    const ctx = loadContextToken(uid);
    try {
      await this.client.startTyping(uid, ctx);
    } catch {
      // best effort
    }
  }

  async cancelTypingToUser(userId?: string): Promise<void> {
    if (!this.client) return;
    const creds = loadCredentials();
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
