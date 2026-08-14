import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";

import { ali1688Adapter } from "../src/adapters/ali1688.js";
import type { PlatformAdapter } from "../src/adapters/base.js";
import type { SyncBrowser } from "../src/browser/context.js";
import { loadConfig } from "../src/config.js";
import { JsonLogger } from "../src/log.js";
import type { BrowserLauncher } from "../src/run.js";
import { runSyncOnce } from "../src/run.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const createdDirs: string[] = [];
const aliDetailTestAdapter: PlatformAdapter = {
  ...ali1688Adapter,
  // Production keeps this false. These fixture-only tests retain coverage of
  // the dormant detail parser without exposing an automatic CLI path.
  allowDetailNavigation: true,
};

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
    adapter: platform === "1688" ? aliDetailTestAdapter : undefined,
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

describe("detail logistics completeness is not masked by list logistics", () => {
  function shippedOneTrackingLauncher(detailFixture: string): BrowserLauncher {
    return routedLauncher([
      { glob: "**/buyer-order-list.html", fixture: "1688/order-list-shipped-one-tracking.html" },
      { glob: "**/detail.html*", fixture: detailFixture },
    ]);
  }

  it("a. fails when the list has a tracking but the detail has no logistics", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    await assertFailedClosed(cwd, "1688", shippedOneTrackingLauncher("1688/detail-no-logistics.html"));
  });

  it("b. succeeds with both detail packages when the detail parses fully", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const { config } = loadConfig({ cwd, env: {} });
    const outcome = await runSyncOnce({
      config,
      platform: "1688",
      mode: "dry-run",
      confirm: false,
      logger: new JsonLogger({ logDir: null }),
      launcher: shippedOneTrackingLauncher("1688/detail.html"),
      adapter: aliDetailTestAdapter,
    });
    expect(outcome.exitCode).toBe(0);
    const snapshot = JSON.parse(
      readFileSync(outcome.report.snapshot_path as string, "utf8"),
    ) as { orders: Array<{ packages: unknown[] }> };
    expect(snapshot.orders[0]?.packages).toHaveLength(2);
  });

  it("c. fails when one of two detail logistics rows cannot be parsed", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    await assertFailedClosed(cwd, "1688", shippedOneTrackingLauncher("1688/detail-partial-logistics.html"));
  });

  it("d. failures write no snapshot and never advance the cursor", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const { config } = loadConfig({ cwd, env: {} });
    const outcome = await runSyncOnce({
      config,
      platform: "1688",
      mode: "dry-run",
      confirm: false,
      logger: new JsonLogger({ logDir: null }),
      launcher: shippedOneTrackingLauncher("1688/detail-partial-logistics.html"),
      adapter: aliDetailTestAdapter,
    });
    expect(outcome.exitCode).toBe(1);
    const stateDir = join(cwd, "state");
    expect(readdirSync(stateDir).filter((name) => name.startsWith("snapshot-"))).toHaveLength(0);
    const cursor = JSON.parse(
      readFileSync(join(stateDir, "cursor-1688-1688-main.json"), "utf8"),
    ) as { last_status: string; last_success_at: string | null };
    expect(cursor.last_status).toBe("SCHEMA_CHANGED");
    expect(cursor.last_success_at).toBeNull();
  });
});

describe("wrapper-less detail logistics parsing", () => {
  function pddShippedLauncher(detailFixture: string): BrowserLauncher {
    return routedLauncher([
      { glob: "**/orders.html", fixture: "pdd/order-list-shipped-one-tracking.html" },
      { glob: "**/detail.html*", fixture: detailFixture },
    ]);
  }

  function aliShippedLauncher(detailFixture: string): BrowserLauncher {
    return routedLauncher([
      { glob: "**/buyer-order-list.html", fixture: "1688/order-list-shipped-one-tracking.html" },
      { glob: "**/detail.html*", fixture: detailFixture },
    ]);
  }

  async function assertTwoPackages(cwd: string, platform: "pdd" | "1688", launcher: BrowserLauncher): Promise<void> {
    const { config } = loadConfig({ cwd, env: {} });
    const outcome = await runSyncOnce({
      config,
      platform,
      mode: "dry-run",
      confirm: false,
      logger: new JsonLogger({ logDir: null }),
      launcher,
      adapter: platform === "1688" ? aliDetailTestAdapter : undefined,
    });
    expect(outcome.exitCode).toBe(0);
    const snapshot = JSON.parse(
      readFileSync(outcome.report.snapshot_path as string, "utf8"),
    ) as { orders: Array<{ packages: unknown[] }> };
    expect(snapshot.orders[0]?.packages).toHaveLength(2);
  }

  it("pdd: one valid + one broken wrapper-less logistics row fails closed", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "pdd"), { recursive: true });
    await assertFailedClosed(cwd, "pdd", pddShippedLauncher("pdd/detail-plain-one-broken.html"));
  });

  it("pdd: two valid wrapper-less logistics rows succeed with both packages", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "pdd"), { recursive: true });
    await assertTwoPackages(cwd, "pdd", pddShippedLauncher("pdd/detail-plain-two-valid.html"));
  });

  it("1688: one valid + one broken wrapper-less logistics row fails closed", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    await assertFailedClosed(cwd, "1688", aliShippedLauncher("1688/detail-plain-one-broken.html"));
  });

  it("1688: two valid wrapper-less logistics rows succeed with both packages", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    await assertTwoPackages(cwd, "1688", aliShippedLauncher("1688/detail-plain-two-valid.html"));
  });
});
