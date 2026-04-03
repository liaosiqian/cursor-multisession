import crypto from "node:crypto";
import type { WeixinMessage, MessageItem } from '../api/types';
import { MessageItemType } from '../api/types';
import { logger } from '../util/logger';

/**
 * Normalized message payload sent to the webhook endpoint.
 * Flattens the WeChat protocol into a simpler structure.
 */
export interface WebhookPayload {
  message_id: number;
  from_user_id: string;
  to_user_id: string;
  context_token: string;
  create_time_ms: number;
  session_id: string;
  /** Extracted text content (concatenated from all text items) */
  text: string;
  /** Original item_list for rich content */
  items: MessageItem[];
  /** Raw WeixinMessage for full access */
  raw: WeixinMessage;
}

export interface WebhookConfig {
  url: string;
  secret?: string;
  timeoutMs?: number;
}

function signPayload(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function extractText(msg: WeixinMessage): string {
  if (!msg.item_list) return "";
  return msg.item_list
    .filter((item) => item.type === MessageItemType.TEXT && item.text_item?.text)
    .map((item) => item.text_item!.text!)
    .join("\n");
}

export function buildPayload(msg: WeixinMessage): WebhookPayload {
  return {
    message_id: msg.message_id ?? 0,
    from_user_id: msg.from_user_id ?? "",
    to_user_id: msg.to_user_id ?? "",
    context_token: msg.context_token ?? "",
    create_time_ms: msg.create_time_ms ?? 0,
    session_id: msg.session_id ?? "",
    text: extractText(msg),
    items: msg.item_list ?? [],
    raw: msg,
  };
}

/**
 * Forward a WeChat message to the configured webhook URL.
 * Returns the webhook response body (expected to be JSON).
 */
export async function forwardToWebhook(
  msg: WeixinMessage,
  config: WebhookConfig,
): Promise<unknown> {
  const payload = buildPayload(msg);
  const body = JSON.stringify(payload);
  const timeoutMs = config.timeoutMs ?? 30_000;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (config.secret) {
    headers["X-ClawBot-Signature"] = signPayload(body, config.secret);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(config.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const text = await res.text();
    if (!res.ok) {
      logger.error(
        { status: res.status, body: text.slice(0, 500) },
        "webhook returned error",
      );
      throw new Error(`Webhook HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    logger.info(
      { fromUser: payload.from_user_id, messageId: payload.message_id },
      "forwarded to webhook",
    );

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
