import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
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
  reason: "already-held" | "reclaim-guard-present" | "unavailable";
  removed_stale: boolean;
  holder: LockInfo | null;
}

export type LockResult = AcquiredLock | LockDenied;

export const MALFORMED_LOCK_GRACE_MS = 30_000;

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

interface LockInspection {
  exists: boolean;
  holder: LockInfo | null;
  age_ms: number;
}

function inspectLockFile(path: string): LockInspection {
  try {
    const stat = lstatSync(path);
    return {
      exists: true,
      holder: readLockFile(path),
      age_ms: Math.max(0, Date.now() - stat.mtimeMs),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, holder: null, age_ms: 0 };
    }
    throw error;
  }
}

function createOwnedLock(path: string, info: LockInfo): boolean {
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify(info), null, "utf8");
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function acquireReclaimGuard(path: string, info: LockInfo): (() => void) | null {
  const guardPath = `${path}.reclaim`;
  try {
    // Strict fail-closed rule: an existing reclamation guard is never removed
    // automatically, even if it looks stale or malformed. inspect -> rm ->
    // create is not a CAS operation and could delete another process's newly
    // acquired guard. Only the process holding this token removes the guard in
    // the returned release callback.
    if (!createOwnedLock(guardPath, info)) return null;
  } catch {
    return null;
  }
  return () => {
    const current = readLockFile(guardPath);
    if (current?.token === info.token) rmSync(guardPath, { force: true });
  };
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
  try {
    if (createOwnedLock(path, info)) {
      const release = (): void => {
        const current = readLockFile(path);
        if (current !== null && current.token === token) rmSync(path, { force: true });
      };
      return { held: true, token, release };
    }
  } catch (error) {
    return { held: false, reason: "unavailable", removed_stale: removedStale, holder: null };
  }

  let inspection: LockInspection;
  try {
    inspection = inspectLockFile(path);
  } catch {
    return { held: false, reason: "unavailable", removed_stale: false, holder: null };
  }
  if (inspection.exists && inspection.holder !== null && isProcessAlive(inspection.holder.pid)) {
    return { held: false, reason: "already-held", removed_stale: false, holder: inspection.holder };
  }
  if (inspection.exists && inspection.holder === null && inspection.age_ms < MALFORMED_LOCK_GRACE_MS) {
    // Another process may be between O_EXCL creation and its synchronous JSON
    // write. A fresh malformed file is therefore treated as held, never
    // deleted. A crash-left empty/corrupt file becomes reclaimable after grace.
    return { held: false, reason: "already-held", removed_stale: false, holder: null };
  }

  const releaseGuard = acquireReclaimGuard(path, info);
  if (releaseGuard === null) {
    return { held: false, reason: "reclaim-guard-present", removed_stale: false, holder: inspection.holder };
  }
  try {
    // Re-read under the reclamation guard. This prevents two stale-lock
    // collectors from deleting a lock freshly acquired by the other.
    inspection = inspectLockFile(path);
    if (inspection.exists && inspection.holder !== null && isProcessAlive(inspection.holder.pid)) {
      return { held: false, reason: "already-held", removed_stale: false, holder: inspection.holder };
    }
    if (inspection.exists && inspection.holder === null && inspection.age_ms < MALFORMED_LOCK_GRACE_MS) {
      return { held: false, reason: "already-held", removed_stale: false, holder: null };
    }
    if (inspection.exists) {
      const quarantine = `${path}.stale-${randomUUID()}`;
      try {
        renameSync(path, quarantine);
        removedStale = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          return { held: false, reason: "unavailable", removed_stale: false, holder: null };
        }
      } finally {
        rmSync(quarantine, { force: true });
      }
    }

    try {
      if (!createOwnedLock(path, info)) {
        return {
          held: false,
          reason: "already-held",
          removed_stale: removedStale,
          holder: readLockFile(path),
        };
      }
    } catch {
      return { held: false, reason: "unavailable", removed_stale: removedStale, holder: null };
    }
  } finally {
    releaseGuard();
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
