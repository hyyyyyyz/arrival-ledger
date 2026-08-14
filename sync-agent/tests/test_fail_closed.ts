import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const createdDirs: string[] = [];

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "sync-agent-fc-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function routedLauncher(routes: Array<{ glob: string; fixture: string }>): BrowserLauncher {
  return async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    for (const route of routes) {
      await context.route(route.glob, async (playRoute) => {
        await playRoute.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: readFileSync(join(fixtureDir, route.fixture), "utf8"),
        });
      });
    }
    const syncBrowser: SyncBrowser = {
      context: context as unknown as SyncBrowser["context"],
      close: async () => {
        await browser.close();
      },
    };
    return syncBrowser;
  };
}

async function assertFailedClosed(
  cwd: string,
  platform: "pdd" | "1688",
  launcher: BrowserLauncher,
): Promise<void> {
  const { config } = loadConfig({ cwd, env: {} });
  const outcome = await runSyncOnce({
    config,
    platform,
    mode: "dry-run",
    confirm: false,
    logger: new JsonLogger({ logDir: null }),
    launcher,
  });
  expect(outcome.exitCode).toBe(1);
  expect(outcome.report.status).toBe("SCHEMA_CHANGED");
  const stateDir = join(cwd, "state");
  const snapshots = readdirSync(stateDir).filter((name) => name.startsWith("snapshot-"));
  expect(snapshots).toHaveLength(0);
  const cursor = JSON.parse(
    readFileSync(join(stateDir, `cursor-${platform}-${platform === "pdd" ? "pdd-main" : "1688-main"}.json`), "utf8"),
  ) as { last_status: string; last_success_at: string | null };
  expect(cursor.last_status).toBe("SCHEMA_CHANGED");
  expect(cursor.last_success_at).toBeNull();
}

describe("unknown order status fails closed end to end", () => {
  it("pdd: unknown status stops with SCHEMA_CHANGED and no snapshot", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "pdd"), { recursive: true });
    await assertFailedClosed(
      cwd,
      "pdd",
      routedLauncher([
        { glob: "**/orders.html", fixture: "pdd/order-list-unknown-status.html" },
        { glob: "**/detail.html*", fixture: "pdd/detail-unknown-status.html" },
      ]),
    );
  });

  it("1688: unknown status stops with SCHEMA_CHANGED and no snapshot", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    await assertFailedClosed(
      cwd,
      "1688",
      routedLauncher([
        { glob: "**/buyer-order-list.html", fixture: "1688/order-list-unknown-status.html" },
        { glob: "**/detail.html*", fixture: "1688/detail-unknown-status.html" },
      ]),
    );
  });
});
