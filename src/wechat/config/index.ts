import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

export const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";

const PINO_LEVELS = new Set([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

export interface ClawBotConfig {
  /** ClawBot API base URL (default: https://ilinkai.weixin.qq.com) */
  baseUrl: string;
  /** Bearer token for authentication (obtained via QR login) */
  token: string;
  /** Channel version string */
  channelVersion: string;

  /** Long-poll timeout in ms (default: 35000) */
  longPollTimeoutMs: number;
  /** Regular API timeout in ms (default: 15000) */
  apiTimeoutMs: number;
  /** Retry delay on error in ms (default: 3000) */
  retryDelayMs: number;
  /** Max consecutive errors before backoff (default: 10) */
  maxConsecutiveErrors: number;

  /** Webhook URL to forward incoming messages */
  webhookUrl?: string;
  /** Webhook secret for HMAC signature verification */
  webhookSecret?: string;

  /** HTTP server port for receiving outbound messages (default: 3100) */
  serverPort: number;
  /** HTTP server host (default: 0.0.0.0) */
  serverHost: string;

  /** Pino log level (overridden by LOG_LEVEL env if set) */
  logLevel?: string;
}

const DEFAULTS: Omit<ClawBotConfig, "baseUrl" | "token"> = {
  channelVersion: "2.1.3",
  longPollTimeoutMs: 35_000,
  apiTimeoutMs: 15_000,
  retryDelayMs: 3_000,
  maxConsecutiveErrors: 10,
  serverPort: 3100,
  serverHost: "0.0.0.0",
};

function assertFinitePositive(name: string, n: number, min: number, max?: number): void {
  if (!Number.isFinite(n) || n < min) {
    throw new Error(`config ${name} must be a finite number >= ${min}`);
  }
  if (max !== undefined && n > max) {
    throw new Error(`config ${name} must be <= ${max}`);
  }
}

function validateClawBotConfig(c: ClawBotConfig): void {
  if (typeof c.baseUrl !== "string" || !c.baseUrl.trim()) {
    throw new Error("config baseUrl must be a non-empty string");
  }
  try {
    // eslint-disable-next-line no-new
    new URL(c.baseUrl);
  } catch {
    throw new Error("config baseUrl must be a valid URL");
  }

  if (typeof c.token !== "string") {
    throw new Error("config token must be a string");
  }

  if (typeof c.channelVersion !== "string" || !c.channelVersion.trim()) {
    throw new Error("config channelVersion must be a non-empty string");
  }

  assertFinitePositive("longPollTimeoutMs", c.longPollTimeoutMs, 1000, 600_000);
  assertFinitePositive("apiTimeoutMs", c.apiTimeoutMs, 1000, 300_000);
  assertFinitePositive("retryDelayMs", c.retryDelayMs, 100, 300_000);
  assertFinitePositive("maxConsecutiveErrors", c.maxConsecutiveErrors, 1, 1000);

  if (c.webhookUrl !== undefined && c.webhookUrl !== "") {
    try {
      // eslint-disable-next-line no-new
      new URL(c.webhookUrl);
    } catch {
      throw new Error("config webhookUrl must be a valid URL when set");
    }
  }

  if (
    c.webhookSecret !== undefined &&
    c.webhookSecret !== null &&
    typeof c.webhookSecret !== "string"
  ) {
    throw new Error("config webhookSecret must be a string when set");
  }

  if (!Number.isInteger(c.serverPort) || c.serverPort < 1 || c.serverPort > 65_535) {
    throw new Error("config serverPort must be an integer between 1 and 65535");
  }

  if (typeof c.serverHost !== "string" || !c.serverHost.trim()) {
    throw new Error("config serverHost must be a non-empty string");
  }

  if (c.logLevel !== undefined && c.logLevel !== "") {
    const lvl = c.logLevel.toLowerCase();
    if (!PINO_LEVELS.has(lvl)) {
      throw new Error(
        `config logLevel must be one of: ${[...PINO_LEVELS].join(", ")}`,
      );
    }
  }
}

export function loadConfig(configPath?: string): ClawBotConfig {
  const filePath = configPath ?? join(homedir(), ".clawbot", "config.json");

  let fileConfig: Partial<ClawBotConfig> = {};
  if (existsSync(filePath)) {
    fileConfig = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<ClawBotConfig>;
  }

  const env = process.env;

  const logLevelRaw =
    env.LOG_LEVEL ?? fileConfig.logLevel ?? (env.CLAWBOT_LOG_LEVEL as string | undefined);

  const config: ClawBotConfig = {
    ...DEFAULTS,
    ...fileConfig,
    baseUrl: env.CLAWBOT_BASE_URL ?? fileConfig.baseUrl ?? ILINK_BASE_URL,
    token: env.CLAWBOT_TOKEN ?? fileConfig.token ?? "",
    channelVersion:
      env.CLAWBOT_CHANNEL_VERSION ??
      fileConfig.channelVersion ??
      DEFAULTS.channelVersion,
    webhookUrl: env.CLAWBOT_WEBHOOK_URL ?? fileConfig.webhookUrl,
    webhookSecret: env.CLAWBOT_WEBHOOK_SECRET ?? fileConfig.webhookSecret,
    serverPort: env.CLAWBOT_SERVER_PORT
      ? parseInt(env.CLAWBOT_SERVER_PORT, 10)
      : fileConfig.serverPort ?? DEFAULTS.serverPort,
    serverHost: env.CLAWBOT_SERVER_HOST ?? fileConfig.serverHost ?? DEFAULTS.serverHost,
    logLevel: logLevelRaw,
  };

  validateClawBotConfig(config);
  if (config.logLevel) {
    config.logLevel = config.logLevel.toLowerCase();
  }
  return config;
}
