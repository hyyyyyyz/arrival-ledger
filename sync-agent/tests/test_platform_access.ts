import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  platformAccessFileName,
  reservePlatformAccess,
} from "../src/state/platform_access.js";

const createdDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "arrival-platform-access-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("platform page access cooldown", () => {
  it("reserves before access and blocks a rapid second command for the same account", () => {
    const stateDir = tempDir();
    const first = reservePlatformAccess(
      stateDir,
      "1688",
      "1688-main",
      "login-check",
      15,
      new Date("2026-08-14T10:00:00.000Z"),
    );
    const second = reservePlatformAccess(
      stateDir,
      "1688",
      "1688-main",
      "capture-page",
      15,
      new Date("2026-08-14T10:01:00.000Z"),
    );
    expect(first.allowed).toBe(true);
    expect(second).toMatchObject({ allowed: false, retry_after_seconds: 840 });
  });

  it("isolates accounts and permits access after the interval", () => {
    const stateDir = tempDir();
    reservePlatformAccess(stateDir, "1688", "account-a", "sync-once", 15, new Date("2026-08-14T10:00:00.000Z"));
    expect(
      reservePlatformAccess(stateDir, "1688", "account-b", "sync-once", 15, new Date("2026-08-14T10:01:00.000Z")).allowed,
    ).toBe(true);
    expect(
      reservePlatformAccess(stateDir, "1688", "account-a", "sync-once", 15, new Date("2026-08-14T10:15:00.000Z")).allowed,
    ).toBe(true);
  });

  it("fails closed when the state is malformed", () => {
    const stateDir = tempDir();
    const target = platformAccessFileName(stateDir, "1688", "1688-main");
    writeFileSync(target, "not-json", "utf8");
    expect(() =>
      reservePlatformAccess(stateDir, "1688", "1688-main", "sync-once", 15),
    ).toThrow(/unreadable or invalid/);
  });
});
