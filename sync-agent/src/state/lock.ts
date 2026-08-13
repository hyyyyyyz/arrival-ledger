import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { accountKeyFilePart } from "./cursor.js";

export interface LockInfo {
  pid: number;
  worker_id: string;
  token: string;
  started_at: string;
}

export interface AcquiredLock {
  held: true;
  token: string;
  release: () => void;
}

export interface LockDenied {
  held: false;
  reason: "already-held" | "unavailable";
  removed_stale: boolean;
  holder: LockInfo | null;
}

export type LockResult = AcquiredLock | LockDenied;

export function lockFileName(
  stateDir: string,
  platform: string,
  accountKey: string,
): string {
  return join(stateDir, `${platform}-${accountKeyFilePart(accountKey)}.lock`);
}

export function readLockFile(path: string): LockInfo | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockInfo>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.worker_id !== "string" ||
      typeof parsed.token !== "string" ||
      typeof parsed.started_at !== "string"
    ) {
      return null;
    }
    return parsed as LockInfo;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export function acquireLock(
  stateDir: string,
  platform: string,
  accountKey: string,
  workerId: string,
): LockResult {
  const path = lockFileName(stateDir, platform, accountKey);
  const token = `lock-${randomUUID()}`;
  const info: LockInfo = {
    pid: process.pid,
    worker_id: workerId,
    token,
    started_at: new Date().toISOString(),
  };

  mkdirSync(stateDir, { recursive: true });
  let removedStale = false;
  let holder = readLockFile(path);
  if (holder !== null && !isProcessAlive(holder.pid)) {
    rmSync(path, { force: true });
    holder = null;
    removedStale = true;
  }
  if (holder !== null) {
    return { held: false, reason: "already-held", removed_stale: removedStale, holder };
  }

  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return {
        held: false,
        reason: "already-held",
        removed_stale: removedStale,
        holder: readLockFile(path),
      };
    }
    return { held: false, reason: "unavailable", removed_stale: removedStale, holder: null };
  }
  try {
    writeSync(fd, JSON.stringify(info), null, "utf8");
  } finally {
    closeSync(fd);
  }

  const release = (): void => {
    const current = readLockFile(path);
    if (current !== null && current.token === token) {
      rmSync(path, { force: true });
    }
  };
  return { held: true, token, release };
}

export function describeHolder(holder: LockInfo | null): string {
  if (holder === null) return "unknown";
  return `pid=${holder.pid} worker=${holder.worker_id} since=${holder.started_at}`;
}

export function digestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
