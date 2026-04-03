import crypto from "node:crypto";
import { logger } from '../util/logger';
import type { ClawBotConfig } from '../config/index';
import type {
  BaseInfo,
  GetUpdatesResp,
  GetUploadUrlReq,
  GetUploadUrlResp,
  GetConfigResp,
  SendTypingResp,
  WeixinMessage,
  MessageItem,
} from './types';
import { MessageType, MessageState } from './types';

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

class HttpStatusError extends Error {
  readonly status: number;
  readonly requestId: string;

  constructor(status: number, bodySnippet: string, requestId: string) {
    super(`HTTP ${status}: ${bodySnippet}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.requestId = requestId;
  }
}

const MAX_POST_RETRIES = 4;
const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 8_000;

function isRetryableHttpStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function isRetryablePostError(err: unknown): boolean {
  if (err instanceof HttpStatusError) {
    return isRetryableHttpStatus(err.status);
  }
  if (err instanceof Error && err.name === "AbortError") {
    return true;
  }
  if (err instanceof SyntaxError) {
    return false;
  }
  // Network / system errors from fetch
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class ClawBotClient {
  private baseUrl: string;
  private token: string;
  private baseInfo: BaseInfo;
  private apiTimeoutMs: number;
  private longPollTimeoutMs: number;

  constructor(config: ClawBotConfig) {
    this.baseUrl = ensureTrailingSlash(config.baseUrl);
    this.token = config.token;
    this.baseInfo = { channel_version: config.channelVersion };
    this.apiTimeoutMs = config.apiTimeoutMs;
    this.longPollTimeoutMs = config.longPollTimeoutMs;
  }

  private buildHeaders(body: string, requestId: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "Content-Length": String(Buffer.byteLength(body, "utf-8")),
      "X-WECHAT-UIN": randomWechatUin(),
      "X-Request-Id": requestId,
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    return headers;
  }

  private parseJsonBody<T>(trimmed: string, label: string, requestId: string): T {
    if (!trimmed || trimmed === "{}") {
      logger.debug({ label, requestId }, "api empty body, treating as success");
      return { ret: 0 } as T;
    }
    try {
      return JSON.parse(trimmed) as T;
    } catch (e) {
      logger.error(
        { label, requestId, snippet: trimmed.slice(0, 200) },
        "api JSON parse failed",
      );
      throw e;
    }
  }

  private async postOnce<T>(
    endpoint: string,
    payload: unknown,
    timeoutMs: number,
    label: string,
    requestId: string,
  ): Promise<T> {
    const url = new URL(endpoint, this.baseUrl);
    const body = JSON.stringify(payload);
    const headers = this.buildHeaders(body, requestId);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url.toString(), {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      logger.debug(
        { label, requestId, status: res.status, body: text.slice(0, 300) },
        "api response",
      );
      if (!res.ok) {
        throw new HttpStatusError(res.status, text.slice(0, 500), requestId);
      }
      const trimmed = text.trim();
      return this.parseJsonBody<T>(trimmed, label, requestId);
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  private async post<T>(
    endpoint: string,
    payload: unknown,
    timeoutMs: number,
    label: string,
    retryable: boolean,
  ): Promise<T> {
    const maxAttempts = retryable ? MAX_POST_RETRIES : 1;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const requestId = crypto.randomUUID();
      logger.debug({ label, requestId, attempt }, "api request");

      try {
        return await this.postOnce<T>(
          endpoint,
          payload,
          timeoutMs,
          label,
          requestId,
        );
      } catch (err) {
        lastErr = err;
        const canRetry =
          attempt < maxAttempts && isRetryablePostError(err) && retryable;

        if (err instanceof HttpStatusError) {
          logger.warn(
            {
              label,
              requestId: err.requestId,
              status: err.status,
              attempt,
              willRetry: canRetry,
            },
            "api HTTP error",
          );
        } else if (err instanceof Error && err.name === "AbortError") {
          logger.warn(
            { label, requestId, attempt, willRetry: canRetry },
            "api request timeout",
          );
        } else {
          logger.warn(
            {
              label,
              requestId,
              attempt,
              err: err instanceof Error ? err.message : String(err),
              willRetry: canRetry,
            },
            "api request failed",
          );
        }

        if (!canRetry) {
          throw err;
        }

        const backoff = Math.min(
          INITIAL_BACKOFF_MS * 2 ** (attempt - 1),
          MAX_BACKOFF_MS,
        );
        await sleep(backoff);
      }
    }

    throw lastErr;
  }

  /**
   * Long-poll for new messages. Pass empty string for first request,
   * then use the returned get_updates_buf cursor for subsequent calls.
   */
  async getUpdates(cursor: string): Promise<GetUpdatesResp> {
    try {
      return await this.post<GetUpdatesResp>(
        "ilink/bot/getupdates",
        { get_updates_buf: cursor, base_info: this.baseInfo },
        this.longPollTimeoutMs,
        "getUpdates",
        false,
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        logger.debug("getUpdates: long-poll timeout, returning empty");
        return { ret: 0, msgs: [], get_updates_buf: cursor };
      }
      throw err;
    }
  }

  /**
   * Build a complete outbound WeixinMessage with all required "ghost fields".
   * Without from_user_id, client_id, message_type, message_state the server
   * silently drops the message (returns 200 + empty body).
   */
  private buildOutboundMsg(
    toUserId: string,
    items: MessageItem[],
    contextToken?: string,
  ): WeixinMessage {
    return {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: `bot-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: items,
    };
  }

  /** Send a text message to a user. */
  async sendText(
    toUserId: string,
    text: string,
    contextToken?: string,
  ): Promise<void> {
    const msg = this.buildOutboundMsg(
      toUserId,
      [{ type: 1, text_item: { text } }],
      contextToken,
    );
    await this.post(
      "ilink/bot/sendmessage",
      { msg, base_info: this.baseInfo },
      this.apiTimeoutMs,
      "sendMessage",
      true,
    );
    logger.info({ toUserId, textLen: text.length }, "sent text message");
  }

  /** Send a message with arbitrary item_list. */
  async sendMessage(
    toUserId: string,
    items: MessageItem[],
    contextToken?: string,
  ): Promise<void> {
    const msg = this.buildOutboundMsg(toUserId, items, contextToken);
    await this.post(
      "ilink/bot/sendmessage",
      { msg, base_info: this.baseInfo },
      this.apiTimeoutMs,
      "sendMessage",
      true,
    );
    logger.info({ toUserId, itemCount: items.length }, "sent message");
  }

  /**
   * Send a single media item (image/file/video) as its own request.
   * The reference SDK always sends exactly one item per item_list for media.
   */
  async sendMediaItem(
    toUserId: string,
    item: MessageItem,
    contextToken?: string,
  ): Promise<void> {
    const msg = this.buildOutboundMsg(toUserId, [item], contextToken);
    await this.post(
      "ilink/bot/sendmessage",
      { msg, base_info: this.baseInfo },
      this.apiTimeoutMs,
      "sendMediaItem",
      true,
    );
    logger.info({ toUserId, itemType: item.type }, "sent media item");
  }

  /** Get a pre-signed CDN upload URL for a file. */
  async getUploadUrl(
    params: Omit<GetUploadUrlReq, "base_info">,
  ): Promise<GetUploadUrlResp> {
    return this.post<GetUploadUrlResp>(
      "ilink/bot/getuploadurl",
      { ...params, base_info: this.baseInfo },
      this.apiTimeoutMs,
      "getUploadUrl",
      true,
    );
  }

  /** Fetch bot config (includes typing_ticket). */
  async getConfig(
    ilinkUserId: string,
    contextToken?: string,
  ): Promise<GetConfigResp> {
    return this.post<GetConfigResp>(
      "ilink/bot/getconfig",
      {
        ilink_user_id: ilinkUserId,
        context_token: contextToken,
        base_info: this.baseInfo,
      },
      this.apiTimeoutMs,
      "getConfig",
      true,
    );
  }

  /** Send typing indicator. */
  async sendTyping(
    ilinkUserId: string,
    typingTicket: string,
    status: 1 | 2 = 1,
  ): Promise<SendTypingResp> {
    return this.post<SendTypingResp>(
      "ilink/bot/sendtyping",
      {
        ilink_user_id: ilinkUserId,
        typing_ticket: typingTicket,
        status,
        base_info: this.baseInfo,
      },
      this.apiTimeoutMs,
      "sendTyping",
      true,
    );
  }

  /** Convenience: start typing indicator for a user (fetches ticket automatically). */
  async startTyping(userId: string, contextToken?: string): Promise<void> {
    const config = await this.getConfig(userId, contextToken);
    if (config.typing_ticket) {
      await this.sendTyping(userId, config.typing_ticket, 1);
    }
  }

  /** Convenience: cancel typing indicator for a user. */
  async cancelTyping(userId: string, contextToken?: string): Promise<void> {
    const config = await this.getConfig(userId, contextToken);
    if (config.typing_ticket) {
      await this.sendTyping(userId, config.typing_ticket, 2);
    }
  }
}
