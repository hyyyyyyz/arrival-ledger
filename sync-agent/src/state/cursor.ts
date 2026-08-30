import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  isPlatform,
  SYNC_STATUSES,
  type CursorState,
  type Platform,
  type SyncStatus,
} from "../models.js";

export function accountKeyFilePart(accountKey: string): string {
  return accountKey.replace(/[^A-Za-z0-9._-]/g, "-").toLowerCase();
}

export function cursorFileName(
  stateDir: string,
  platform: Platform,
  accountKey: string,
): string {
  return join(stateDir, `cursor-${platform}-${accountKeyFilePart(accountKey)}.json`);
}

export function emptyCursor(platform: Platform, accountKey: string): CursorState {
  return {
    platform,
    account_key: accountKey,
    last_success_at: null,
    last_sync_at: null,
    last_cursor: null,
    last_batch_id: null,
    last_status: "OK",
    consecutive_failures: 0,
    updated_at: new Date().toISOString(),
  };
}

export function loadCursor(
  stateDir: string,
  platform: Platform,
  accountKey: string,
): CursorState | null {
  try {
    const parsed = JSON.parse(
      readFileSync(cursorFileName(stateDir, platform, accountKey), "utf8"),
    ) as Record<string, unknown>;
    if (
      !isPlatform(String(parsed["platform"])) ||
      parsed["platform"] !== platform ||
      parsed["account_key"] !== accountKey ||
      typeof parsed["consecutive_failures"] !== "number" ||
      !SYNC_STATUSES.includes(parsed["last_status"] as SyncStatus) ||
      typeof parsed["updated_at"] !== "string"
    ) {
      return null;
    }
    return parsed as unknown as CursorState;
  } catch {
    return null;
  }
}

export function saveCursor(stateDir: string, cursor: CursorState): void {
  mkdirSync(stateDir, { recursive: true });
  const target = cursorFileName(stateDir, cursor.platform, cursor.account_key);
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(cursor, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, target);
}

export function updateCursor(
  stateDir: string,
  platform: Platform,
  accountKey: string,
  patch: Partial<Omit<CursorState, "platform" | "account_key">>,
): CursorState {
  const current = loadCursor(stateDir, platform, accountKey) ?? emptyCursor(platform, accountKey);
  const next: CursorState = { ...current, ...patch, updated_at: new Date().toISOString() };
  saveCursor(stateDir, next);
  return next;
}

export function removeCursor(
  stateDir: string,
  platform: Platform,
  accountKey: string,
): void {
  rmSync(cursorFileName(stateDir, platform, accountKey), { force: true });
}
