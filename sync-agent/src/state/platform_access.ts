import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { Platform } from "../models.js";
import { accountKeyFilePart } from "./cursor.js";

export type PlatformAccessCommand = "login-check" | "capture-page" | "sync-once";

interface PlatformAccessState {
  schema_version: 1;
  platform: Platform;
  account_key: string;
  command: PlatformAccessCommand;
  last_access_at: string;
}

export interface PlatformAccessDecision {
  allowed: boolean;
  retry_after_seconds: number;
  last_access_at: string | null;
}

export function platformAccessFileName(
  stateDir: string,
  platform: Platform,
  accountKey: string,
): string {
  return join(stateDir, `platform-access-${platform}-${accountKeyFilePart(accountKey)}.json`);
}

/**
 * Reserve one real platform-page access while the account lock is held.
 * The reservation is written before launching Chrome, so crashes cannot cause
 * an immediate automatic retry against the platform.
 */
export function reservePlatformAccess(
  stateDir: string,
  platform: Platform,
  accountKey: string,
  command: PlatformAccessCommand,
  minimumIntervalMinutes: number,
  now = new Date(),
): PlatformAccessDecision {
  const target = platformAccessFileName(stateDir, platform, accountKey);
  let previous: PlatformAccessState | null = null;
  try {
    previous = JSON.parse(readFileSync(target, "utf8")) as PlatformAccessState;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw new Error("platform access state is unreadable or invalid");
  }

  if (previous !== null) {
    if (
      previous.schema_version !== 1 ||
      previous.platform !== platform ||
      previous.account_key !== accountKey ||
      typeof previous.last_access_at !== "string"
    ) {
      throw new Error("platform access state is invalid");
    }
    const previousMs = new Date(previous.last_access_at).getTime();
    const nowMs = now.getTime();
    if (!Number.isFinite(previousMs) || previousMs > nowMs + 30_000) {
      throw new Error("platform access timestamp is invalid or in the future");
    }
    const intervalMs = minimumIntervalMinutes * 60_000;
    const remainingMs = intervalMs - (nowMs - previousMs);
    if (remainingMs > 0) {
      return {
        allowed: false,
        retry_after_seconds: Math.ceil(remainingMs / 1000),
        last_access_at: previous.last_access_at,
      };
    }
  }

  mkdirSync(stateDir, { recursive: true });
  const state: PlatformAccessState = {
    schema_version: 1,
    platform,
    account_key: accountKey,
    command,
    last_access_at: now.toISOString(),
  };
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, target);
  return { allowed: true, retry_after_seconds: 0, last_access_at: state.last_access_at };
}
