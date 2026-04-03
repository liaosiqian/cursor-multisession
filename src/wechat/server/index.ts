import http from "node:http";
import fs from "node:fs";
import { ClawBotClient } from '../api/client';
import { MediaService } from '../media/index';
import { captureAndCleanup } from '../screenshot';
import type { MessageItem } from '../api/types';
import type { ClawBotConfig } from '../config/index';
import { logger } from '../util/logger';

const MAX_BODY_BYTES = 1024 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 120;

/**
 * Inbound request body for sending a message via the HTTP API.
 *
 * POST /send
 * {
 *   "to_user_id": "xxx",
 *   "context_token": "xxx",      // optional
 *   "text": "hello",             // text message
 *   "items": [...]               // or raw MessageItem[] for rich content
 * }
 *
 * POST /typing
 * {
 *   "user_id": "xxx",
 *   "context_token": "xxx",
 *   "action": "start" | "cancel"
 * }
 */
interface SendRequest {
  to_user_id: string;
  context_token?: string;
  text?: string;
  items?: MessageItem[];
}

interface TypingRequest {
  user_id: string;
  context_token?: string;
  action: "start" | "cancel";
}

const rateBuckets = new Map<string, number[]>();

function clientKey(req: http.IncomingMessage): string {
  const xf = req.headers["x-forwarded-for"];
  const fromHeader = typeof xf === "string" ? xf.split(",")[0]?.trim() : "";
  return fromHeader || req.socket.remoteAddress || "unknown";
}

function allowRate(key: string): boolean {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;
  let hits = rateBuckets.get(key) ?? [];
  hits = hits.filter((t) => t > windowStart);
  if (hits.length >= RATE_MAX_REQUESTS) {
    rateBuckets.set(key, hits);
    return false;
  }
  hits.push(now);
  rateBuckets.set(key, hits);
  return true;
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function createServer(
  client: ClawBotClient,
  _media: MediaService,
  _config: ClawBotConfig,
): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        jsonResponse(res, 200, { status: "ok" });
        return;
      }

      if (req.method !== "POST") {
        jsonResponse(res, 405, { error: "Method not allowed" });
        return;
      }

      const key = clientKey(req);
      if (!allowRate(key)) {
        logger.warn({ key }, "rate limit exceeded");
        jsonResponse(res, 429, { error: "Too many requests" });
        return;
      }

      let body: string;
      try {
        body = await readBody(req, MAX_BODY_BYTES);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === "request body too large") {
          jsonResponse(res, 413, { error: "request body too large" });
          return;
        }
        throw e;
      }

      const url = req.url ?? "";

      if (url === "/send") {
        const data: SendRequest = JSON.parse(body);
        if (!data.to_user_id) {
          jsonResponse(res, 400, { error: "to_user_id is required" });
          return;
        }

        if (data.text) {
          await client.sendText(data.to_user_id, data.text, data.context_token);
        } else if (data.items && data.items.length > 0) {
          await client.sendMessage(data.to_user_id, data.items, data.context_token);
        } else {
          jsonResponse(res, 400, { error: "text or items is required" });
          return;
        }

        jsonResponse(res, 200, { success: true });
        return;
      }

      if (url === "/typing") {
        const data: TypingRequest = JSON.parse(body);
        if (!data.user_id) {
          jsonResponse(res, 400, { error: "user_id is required" });
          return;
        }

        if (data.action === "start") {
          await client.startTyping(data.user_id, data.context_token);
        } else {
          await client.cancelTyping(data.user_id, data.context_token);
        }

        jsonResponse(res, 200, { success: true });
        return;
      }

      if (url === "/screenshot") {
        try {
          const filePath = await captureAndCleanup();
          const imgBuf = fs.readFileSync(filePath);
          res.writeHead(200, {
            "Content-Type": "image/png",
            "Content-Length": String(imgBuf.length),
            "X-Screenshot-Path": filePath,
          });
          res.end(imgBuf);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          jsonResponse(res, 500, { error: `screenshot failed: ${msg}` });
        }
        return;
      }

      jsonResponse(res, 404, { error: "Not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message, url: req.url }, "server error");
      jsonResponse(res, 500, { error: message });
    }
  });

  return server;
}

export function startServer(
  server: http.Server,
  config: ClawBotConfig,
): Promise<void> {
  return new Promise((resolve) => {
    server.listen(config.serverPort, config.serverHost, () => {
      logger.info(
        { port: config.serverPort, host: config.serverHost },
        "HTTP server listening",
      );
      resolve();
    });
  });
}
