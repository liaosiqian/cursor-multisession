import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { logger } from '../util/logger';

export interface StoredCredentials {
  token: string;
  baseUrl: string;
  botId: string;
  userId: string;
  savedAt: string;
}

export interface ContextTokenStore {
  [userId: string]: string;
}

function resolveDataDir(accountId?: string): string {
  const base = process.env.CLAWBOT_DATA_DIR ?? path.join(os.homedir(), ".clawbot");
  const dir = accountId ? path.join(base, "accounts", accountId) : base;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function credentialsPath(accountId?: string): string {
  return path.join(resolveDataDir(accountId), "credentials.json");
}

function contextTokensPath(): string {
  return path.join(resolveDataDir(), "context-tokens.json");
}

// ── Credentials ──

export function saveCredentials(creds: StoredCredentials, accountId?: string): void {
  const filePath = credentialsPath(accountId);
  fs.writeFileSync(filePath, JSON.stringify(creds, null, 2), "utf-8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
  logger.info(`credentials saved${accountId ? ` (account: ${accountId})` : ''}`);
}

export function loadCredentials(accountId?: string): StoredCredentials | null {
  const filePath = credentialsPath(accountId);
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as StoredCredentials;
  } catch {
    return null;
  }
}

export function clearCredentials(accountId?: string): void {
  try {
    fs.unlinkSync(credentialsPath(accountId));
  } catch {
    // ignore
  }
}

// ── Context Tokens ──

export function saveContextToken(userId: string, token: string): void {
  const filePath = contextTokensPath();
  let store: ContextTokenStore = {};
  try {
    if (fs.existsSync(filePath)) {
      store = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch {
    // start fresh
  }
  store[userId] = token;
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
}

export function loadContextToken(userId: string): string | undefined {
  const filePath = contextTokensPath();
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const store = JSON.parse(fs.readFileSync(filePath, "utf-8")) as ContextTokenStore;
    return store[userId];
  } catch {
    return undefined;
  }
}

export function loadAllContextTokens(): ContextTokenStore {
  const filePath = contextTokensPath();
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as ContextTokenStore;
  } catch {
    return {};
  }
}
