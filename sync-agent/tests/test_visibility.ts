import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";

import type { SyncBrowser } from "../src/browser/context.js";
import { loadConfig } from "../src/config.js";
import { JsonLogger } from "../src/log.js";
import type { BrowserLauncher } from "../src/run.js";
import { runSyncOnce } from "../src/run.js";
import { readSnapshot, snapshotToBatch } from "../src/snapshot.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const createdDirs: string[] = [];

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "sync-agent-vis-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function routedLauncher(htmlPath: string, glob: string): BrowserLauncher {
  return async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.route(glob, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: readFileSync(join(fixtureDir, htmlPath), "utf8"),
      });
    });
    const syncBrowser: SyncBrowser = {
      context: context as unknown as SyncBrowser["context"],
      close: async () => {
        await browser.close();
      },
    };
    return syncBrowser;
  };
}

describe("hidden order templates never enter the snapshot", () => {
  it("1688: hidden rows before real rows are excluded end to end", async () => {
    const cwd = join(tempCwd());
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const { config } = loadConfig({ cwd, env: {} });
    const outcome = await runSyncOnce({
      config,
      platform: "1688",
      mode: "dry-run",
      confirm: false,
      logger: new JsonLogger({ logDir: null }),
      launcher: routedLauncher("1688/order-list-hidden-first.html", "**/buyer-order-list.html"),
    });
    expect(outcome.exitCode).toBe(0);
    const snapshot = readSnapshot(outcome.report.snapshot_path as string);
    expect(snapshot).not.toBeNull();
    const batch = snapshotToBatch(snapshot!);
    expect(batch?.orders).toHaveLength(1);
    expect(batch?.orders[0]?.platform_order_id).toBe("1688-260813-0001");
    expect(batch?.orders[0]?.items[0]?.title).toBe("可见商品甲");
  });

  it("pdd: hidden cards before real cards are excluded end to end", async () => {
    const cwd = join(tempCwd());
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(cwd, "profiles", "pdd"), { recursive: true });
    const { config } = loadConfig({ cwd, env: {} });
    const outcome = await runSyncOnce({
      config,
      platform: "pdd",
      mode: "dry-run",
      confirm: false,
      logger: new JsonLogger({ logDir: null }),
      launcher: routedLauncher("pdd/order-list-hidden-first.html", "**/orders.html"),
    });
    expect(outcome.exitCode).toBe(0);
    const snapshot = readSnapshot(outcome.report.snapshot_path as string);
    expect(snapshot).not.toBeNull();
    const batch = snapshotToBatch(snapshot!);
    expect(batch?.orders).toHaveLength(1);
    expect(batch?.orders[0]?.platform_order_id).toBe("260813-8800000001");
    expect(batch?.orders[0]?.items[0]?.title).toBe("可见商品甲");
  });
});
