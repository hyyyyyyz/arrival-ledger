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
    expect(loadCursor(dir, "pdd", "pdd-main")).toBeNull();
  });

  it("saves and loads a cursor round-trip", () => {
    const dir = tempStateDir();
    const cursor = emptyCursor("pdd", "pdd-main");
    saveCursor(dir, cursor);
    const loaded = loadCursor(dir, "pdd", "pdd-main");
    expect(loaded).not.toBeNull();
    expect(loaded?.platform).toBe("pdd");
    expect(loaded?.account_key).toBe("pdd-main");
    expect(loaded?.last_status).toBe("OK");
  });

  it("updateCursor preserves unknown state and patches fields", () => {
    const dir = tempStateDir();
    updateCursor(dir, "pdd", "pdd-main", {
      last_status: "SCHEMA_CHANGED",
      consecutive_failures: 2,
    });
    const loaded = loadCursor(dir, "pdd", "pdd-main");
    expect(loaded?.last_status).toBe("SCHEMA_CHANGED");
    expect(loaded?.consecutive_failures).toBe(2);
    expect(loaded?.account_key).toBe("pdd-main");

    updateCursor(dir, "pdd", "pdd-main", { consecutive_failures: 3 });
    expect(loadCursor(dir, "pdd", "pdd-main")?.consecutive_failures).toBe(3);
    expect(loadCursor(dir, "pdd", "pdd-main")?.last_status).toBe("SCHEMA_CHANGED");
  });

  it("isolates cursors per account_key on the same platform", () => {
    const dir = tempStateDir();
    updateCursor(dir, "pdd", "pdd-main", { consecutive_failures: 1 });
    updateCursor(dir, "pdd", "pdd-test", { consecutive_failures: 7 });
    expect(loadCursor(dir, "pdd", "pdd-main")?.consecutive_failures).toBe(1);
    expect(loadCursor(dir, "pdd", "pdd-test")?.consecutive_failures).toBe(7);
    expect(loadCursor(dir, "1688", "1688-main")).toBeNull();
  });

  it("rejects malformed cursor files", () => {
    const dir = tempStateDir();
    writeFileSync(join(dir, "cursor-pdd-pdd-main.json"), '{"platform":"not-a-platform"}', "utf8");
    expect(loadCursor(dir, "pdd", "pdd-main")).toBeNull();
  });
});

describe("platform lock", () => {
  it("acquires and releases cleanly", () => {
    const dir = tempStateDir();
    const first = acquireLock(dir, "pdd", "pdd-main", "worker-1");
    expect(first.held).toBe(true);
    expect(existsSync(join(dir, "pdd-pdd-main.lock"))).toBe(true);
    if (first.held) first.release();
    expect(existsSync(join(dir, "pdd-pdd-main.lock"))).toBe(false);
  });

  it("denies a second holder for the same platform and account", () => {
    const dir = tempStateDir();
    const first = acquireLock(dir, "pdd", "pdd-main", "worker-1");
    expect(first.held).toBe(true);
    const second = acquireLock(dir, "pdd", "pdd-main", "worker-2");
    expect(second.held).toBe(false);
    if (!second.held) {
      expect(second.reason).toBe("already-held");
      expect(second.holder?.worker_id).toBe("worker-1");
    }
    if (first.held) first.release();
  });

  it("allows different accounts and platforms in parallel", () => {
    const dir = tempStateDir();
    const pddMain = acquireLock(dir, "pdd", "pdd-main", "worker-1");
    const pddTest = acquireLock(dir, "pdd", "pdd-test", "worker-1");
    const ali = acquireLock(dir, "1688", "1688-main", "worker-1");
    expect(pddMain.held).toBe(true);
    expect(pddTest.held).toBe(true);
    expect(ali.held).toBe(true);
    if (pddMain.held) pddMain.release();
    if (pddTest.held) pddTest.release();
    if (ali.held) ali.release();
  });

  it("removes a stale lock from a dead pid", () => {
    const dir = tempStateDir();
    const deadPid = 999999999;
    writeFileSync(
      join(dir, "pdd-pdd-main.lock"),
      JSON.stringify({
        pid: deadPid,
        worker_id: "ghost",
        token: "lock-ghost",
        started_at: new Date().toISOString(),
      }),
      "utf8",
    );
    const acquired = acquireLock(dir, "pdd", "pdd-main", "worker-live");
    expect(acquired.held).toBe(true);
    if (acquired.held) acquired.release();
  });

  it("release does not remove a lock owned by someone else", () => {
    const dir = tempStateDir();
    const first = acquireLock(dir, "pdd", "pdd-main", "worker-1");
    expect(first.held).toBe(true);
    if (!first.held) return;
    first.release();
    const second = acquireLock(dir, "pdd", "pdd-main", "worker-2");
    expect(second.held).toBe(true);
    if (!second.held) return;
    first.release();
    expect(readLockFile(join(dir, "pdd-pdd-main.lock"))?.worker_id).toBe("worker-2");
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
