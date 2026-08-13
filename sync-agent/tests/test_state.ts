import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireLock, digestToken, readLockFile } from "../src/state/lock.js";
import { emptyCursor, loadCursor, saveCursor, updateCursor } from "../src/state/cursor.js";

const createdDirs: string[] = [];

function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sync-agent-state-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("cursor state", () => {
  it("loads null when no cursor exists", () => {
    const dir = tempStateDir();
    expect(loadCursor(dir, "pdd")).toBeNull();
  });

  it("saves and loads a cursor round-trip", () => {
    const dir = tempStateDir();
    const cursor = emptyCursor("pdd", "pdd-main");
    saveCursor(dir, cursor);
    const loaded = loadCursor(dir, "pdd");
    expect(loaded).not.toBeNull();
    expect(loaded?.platform).toBe("pdd");
    expect(loaded?.last_status).toBe("OK");
  });

  it("updateCursor preserves unknown state and patches fields", () => {
    const dir = tempStateDir();
    updateCursor(dir, "pdd", "pdd-main", {
      last_status: "SCHEMA_CHANGED",
      consecutive_failures: 2,
    });
    const loaded = loadCursor(dir, "pdd");
    expect(loaded?.last_status).toBe("SCHEMA_CHANGED");
    expect(loaded?.consecutive_failures).toBe(2);
    expect(loaded?.account_key).toBe("pdd-main");

    updateCursor(dir, "pdd", "pdd-main", { consecutive_failures: 3 });
    expect(loadCursor(dir, "pdd")?.consecutive_failures).toBe(3);
    expect(loadCursor(dir, "pdd")?.last_status).toBe("SCHEMA_CHANGED");
  });

  it("rejects malformed cursor files", () => {
    const dir = tempStateDir();
    writeFileSync(join(dir, "cursor-pdd.json"), '{"platform":"not-a-platform"}', "utf8");
    expect(loadCursor(dir, "pdd")).toBeNull();
  });

  it("keeps platforms isolated", () => {
    const dir = tempStateDir();
    updateCursor(dir, "pdd", "pdd-main", { consecutive_failures: 1 });
    expect(loadCursor(dir, "1688")).toBeNull();
  });
});

describe("platform lock", () => {
  it("acquires and releases cleanly", () => {
    const dir = tempStateDir();
    const first = acquireLock(dir, "pdd", "worker-1");
    expect(first.held).toBe(true);
    expect(existsSync(join(dir, "pdd.lock"))).toBe(true);
    if (first.held) first.release();
    expect(existsSync(join(dir, "pdd.lock"))).toBe(false);
  });

  it("denies a second holder for the same platform", () => {
    const dir = tempStateDir();
    const first = acquireLock(dir, "pdd", "worker-1");
    expect(first.held).toBe(true);
    const second = acquireLock(dir, "pdd", "worker-2");
    expect(second.held).toBe(false);
    if (!second.held) {
      expect(second.reason).toBe("already-held");
      expect(second.holder?.worker_id).toBe("worker-1");
    }
    if (first.held) first.release();
  });

  it("allows different platforms to run in parallel", () => {
    const dir = tempStateDir();
    const pdd = acquireLock(dir, "pdd", "worker-1");
    const ali = acquireLock(dir, "1688", "worker-1");
    expect(pdd.held).toBe(true);
    expect(ali.held).toBe(true);
    if (pdd.held) pdd.release();
    if (ali.held) ali.release();
  });

  it("removes a stale lock from a dead pid", () => {
    const dir = tempStateDir();
    const deadPid = 999999999;
    writeFileSync(
      join(dir, "pdd.lock"),
      JSON.stringify({
        pid: deadPid,
        worker_id: "ghost",
        token: "lock-ghost",
        started_at: new Date().toISOString(),
      }),
      "utf8",
    );
    const acquired = acquireLock(dir, "pdd", "worker-live");
    expect(acquired.held).toBe(true);
    if (acquired.held) acquired.release();
  });

  it("release does not remove a lock owned by someone else", () => {
    const dir = tempStateDir();
    const first = acquireLock(dir, "pdd", "worker-1");
    expect(first.held).toBe(true);
    if (!first.held) return;
    first.release();
    const second = acquireLock(dir, "pdd", "worker-2");
    expect(second.held).toBe(true);
    if (!second.held) return;
    first.release();
    expect(readLockFile(join(dir, "pdd.lock"))?.worker_id).toBe("worker-2");
    second.release();
  });
});

describe("digestToken", () => {
  it("produces a stable sha-256 hex digest", () => {
    expect(digestToken("abc")).toBe(digestToken("abc"));
    expect(digestToken("abc")).toHaveLength(64);
    expect(digestToken("abc")).not.toBe(digestToken("abd"));
  });
});
