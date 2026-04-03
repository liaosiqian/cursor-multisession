import { EventEmitter } from "node:events";
import { ClawBotClient } from '../api/client';
import type { WeixinMessage, GetUpdatesResp } from '../api/types';
import type { ClawBotConfig } from '../config/index';
import { logger } from '../util/logger';

export interface PollerEvents {
  message: [msg: WeixinMessage];
  error: [err: Error];
  connected: [];
}

/**
 * Long-poll loop that continuously fetches new messages from WeChat.
 * Emits "message" for each incoming WeixinMessage.
 */
export class MessagePoller extends EventEmitter<PollerEvents> {
  private client: ClawBotClient;
  private cursor = "";
  private running = false;
  private consecutiveErrors = 0;
  private retryDelayMs: number;
  private maxConsecutiveErrors: number;
  private connectedEmitted = false;

  constructor(client: ClawBotClient, config: ClawBotConfig) {
    super();
    this.client = client;
    this.retryDelayMs = config.retryDelayMs;
    this.maxConsecutiveErrors = config.maxConsecutiveErrors;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.connectedEmitted = false;
    logger.info("poller started");
    this.loop();
  }

  stop(): void {
    this.running = false;
    logger.info("poller stopped");
  }

  private async loop(): Promise<void> {
    while (this.running) {
      if (!this.running) break;

      try {
        const resp: GetUpdatesResp = await this.client.getUpdates(this.cursor);

        if (!this.running) break;

        if (resp.ret !== undefined && resp.ret !== 0) {
          const err = new Error(
            `getUpdates ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg}`,
          );
          logger.error({ ret: resp.ret, errcode: resp.errcode }, "getUpdates failed");
          this.emit("error", err);
          this.consecutiveErrors++;
          await this.backoff();
          continue;
        }

        this.consecutiveErrors = 0;

        if (!this.connectedEmitted) {
          this.connectedEmitted = true;
          this.emit("connected");
        }

        if (resp.get_updates_buf) {
          this.cursor = resp.get_updates_buf;
        }

        if (resp.msgs && resp.msgs.length > 0) {
          logger.info({ count: resp.msgs.length }, "received messages");
          for (const msg of resp.msgs) {
            if (!this.running) break;
            this.emit("message", msg);
          }
        }
      } catch (err) {
        if (!this.running) break;

        this.consecutiveErrors++;
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error({ err: error.message, consecutive: this.consecutiveErrors }, "poll error");
        this.emit("error", error);
        await this.backoff();
      }
    }
  }

  private async backoff(): Promise<void> {
    if (!this.running) return;
    const factor = Math.min(this.consecutiveErrors, this.maxConsecutiveErrors);
    const delay = this.retryDelayMs * factor;
    logger.debug({ delay, consecutive: this.consecutiveErrors }, "backing off");
    await new Promise((r) => setTimeout(r, delay));
  }
}
