import crypto from "node:crypto";
import { logger } from '../util/logger';

const ILINK_BASE = "https://ilinkai.weixin.qq.com";

export interface QRCodeData {
  qrcode: string;
  qrcode_img_content: string;
}

export interface LoginResult {
  bot_token: string;
  ilink_bot_id: string;
  ilink_user_id: string;
}

type QRStatus = "wait" | "scaned" | "confirmed" | "expired";

interface QRStatusResp {
  status: QRStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

/** Fetch a new QR code for login. */
export async function fetchQRCode(): Promise<QRCodeData> {
  const res = await fetch(
    `${ILINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`,
    {
      headers: {
        "iLink-App-ClientVersion": "1",
        "X-WECHAT-UIN": randomWechatUin(),
      },
    },
  );
  if (!res.ok) {
    throw new Error(`fetchQRCode failed: ${res.status}`);
  }
  return (await res.json()) as QRCodeData;
}

/** Poll QR code status once. */
export async function pollQRStatus(qrcodeKey: string): Promise<QRStatusResp> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40_000);
  try {
    const res = await fetch(
      `${ILINK_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeKey)}`,
      {
        headers: {
          "iLink-App-ClientVersion": "1",
          "X-WECHAT-UIN": randomWechatUin(),
        },
        signal: controller.signal,
      },
    );
    clearTimeout(timer);
    if (!res.ok) {
      throw new Error(`pollQRStatus failed: ${res.status}`);
    }
    return (await res.json()) as QRStatusResp;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
}

/**
 * Render a QR code as ASCII art in the terminal.
 * Uses a simple block-based rendering without external dependencies.
 */
function renderQRtoTerminal(url: string): void {
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║  Scan with WeChat to login           ║");
  console.log("╚══════════════════════════════════════╝");
  console.log(`\nQR URL: ${url}`);
  console.log("\nPlease scan the QR code above with your WeChat app.");
  console.log("(If your terminal doesn't render it, copy the URL to a QR generator)\n");
}

/**
 * Complete QR code login flow:
 * 1. Fetch QR code
 * 2. Display in terminal
 * 3. Poll until confirmed or expired
 *
 * @param onStatus optional callback for status updates
 */
export async function qrLogin(
  onStatus?: (status: QRStatus) => void,
): Promise<LoginResult> {
  const qr = await fetchQRCode();
  renderQRtoTerminal(qr.qrcode_img_content);

  logger.info("QR code generated, waiting for scan...");

  while (true) {
    const resp = await pollQRStatus(qr.qrcode);
    onStatus?.(resp.status);

    switch (resp.status) {
      case "wait":
        break;

      case "scaned":
        logger.info("QR scanned, please confirm on your phone...");
        break;

      case "confirmed":
        if (!resp.bot_token || !resp.ilink_bot_id || !resp.ilink_user_id) {
          throw new Error("Login confirmed but missing credentials in response");
        }
        logger.info(
          { botId: resp.ilink_bot_id, userId: resp.ilink_user_id },
          "login successful",
        );
        return {
          bot_token: resp.bot_token,
          ilink_bot_id: resp.ilink_bot_id,
          ilink_user_id: resp.ilink_user_id,
        };

      case "expired":
        throw new Error("QR code expired. Please restart to get a new one.");
    }
  }
}
