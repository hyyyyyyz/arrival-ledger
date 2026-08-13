import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlatformAdapter } from "../src/adapters/base.js";
import type { BrowserLauncher } from "../src/run.js";
import { runSyncOnce, type RunOptions } from "../src/run.js";
import type { SyncBrowser } from "../src/browser/context.js";
import { loadConfig } from "../src/config.js";
import type { RawOrder } from "../src/extract/order.js";
import { JsonLogger } from "../src/log.js";

const createdDirs: string[] = [];

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "sync-agent-run-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function rawOrder(): RawOrder {
  return {
    platform_order_id: "1688-260813-0001",
    ordered_at: "2026-08-12 10:30:00",
    status: "已发货",
    shop_name: "测试店铺",
    items: [{ item_key: null, title: "测试商品", sku_text: null, quantity: "2", unit_price: null }],
    packages: [{ courier: "中通", tracking_no: "ZTO-20260813-0001", status: null }],
    observed_at: new Date().toISOString(),
    source_page: 0,
  };
}

function fakeAdapter(overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    platform: "1688",
    orderListUrl: "https://example.invalid/orders",
    statusMap: { 已发货: "SHIPPED", 交易关闭: "CANCELLED" },
    openOrders: async () => undefined,
    detectLogin: async () => ({ logged_in: true, detail: "fake" }),
    detectBlock: async () => ({ blocked: false, kind: "unknown", detail: "fake" }),
    collectVisibleOrders: async () => ({
      orders: [rawOrder()],
      empty: false,
      rows_seen: 1,
      recognized: 1,
    }),
    advancePage: async () => false,
    ...overrides,
  };
}

function fakeLauncher(): BrowserLauncher {
  const page = {} as Page;
  const browser: SyncBrowser = {
    context: {
      pages: () => [],
      newPage: async () => page,
    } as unknown as SyncBrowser["context"],
    close: async () => undefined,
  };
  return async () => browser;
}

function buildOptions(
  cwd: string,
  overrides: Partial<RunOptions> = {},
  env: Record<string, string> = {},
): RunOptions {
  const { config } = loadConfig({ cwd, env });
  return {
    config,
    platform: "1688",
    mode: "dry-run",
    confirm: false,
    logger: new JsonLogger({ logDir: null }),
    launcher: fakeLauncher(),
    adapter: fakeAdapter(),
    ...overrides,
  };
}

describe("runSyncOnce", () => {
  it("dry-run collects orders and never uploads", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const outcome = await runSyncOnce(buildOptions(cwd));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report.mode).toBe("dry-run");
    expect(outcome.report.counts.seen).toBe(1);
    expect(outcome.report.counts.valid).toBe(1);
    expect(outcome.report.status).toBe("OK");
  });

  it("fails closed when the profile dir is missing", async () => {
    const cwd = tempCwd();
    const outcome = await runSyncOnce(buildOptions(cwd));
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.error_code).toBe("CONFIG");
  });

  it("commit without confirmation aborts before upload", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const outcome = await runSyncOnce(
      buildOptions(cwd, { mode: "commit", confirm: false }, { ARRIVAL_SYNC_WORKER_KEY: "test-worker-key-0001" }),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.error_code).toBe("CONFIRM_REQUIRED");
    expect(outcome.report.counts.uploaded).toBe(0);
  });

  it("commit without a worker key is disabled", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const outcome = await runSyncOnce(
      buildOptions(cwd, { mode: "commit", confirm: true }),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.error_code).toBe("CONFIG");
  });

  it("stops with NEEDS_LOGIN and records it in the cursor", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const outcome = await runSyncOnce(
      buildOptions(cwd, {
        adapter: fakeAdapter({
          detectLogin: async () => ({ logged_in: false, detail: "fake login wall" }),
        }),
      }),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.status).toBe("NEEDS_LOGIN");
    const cursor = JSON.parse(
      readFileSync(join(cwd, "state", "cursor-1688-1688-main.json"), "utf8"),
    ) as { last_status: string };
    expect(cursor.last_status).toBe("NEEDS_LOGIN");
  });

  it("stops with CAPTCHA_OR_BLOCKED on risk pages", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const outcome = await runSyncOnce(
      buildOptions(cwd, {
        adapter: fakeAdapter({
          detectBlock: async () => ({ blocked: true, kind: "captcha", detail: "fake slider" }),
        }),
      }),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.status).toBe("CAPTCHA_OR_BLOCKED");
  });

  it("stops with SCHEMA_CHANGED when rows exist but none parse", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const outcome = await runSyncOnce(
      buildOptions(cwd, {
        adapter: fakeAdapter({
          collectVisibleOrders: async () => ({ orders: [], empty: false, rows_seen: 5, recognized: 0 }),
        }),
      }),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.status).toBe("SCHEMA_CHANGED");
  });

  it("stops with SCHEMA_CHANGED when extraction fails", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const badOrder: RawOrder = { ...rawOrder(), platform_order_id: "" };
    const outcome = await runSyncOnce(
      buildOptions(cwd, {
        adapter: fakeAdapter({
          collectVisibleOrders: async () => ({ orders: [badOrder], empty: false, rows_seen: 1, recognized: 1 }),
        }),
      }),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.status).toBe("SCHEMA_CHANGED");
  });

  it("an empty order list is a warning, not an overwrite", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const outcome = await runSyncOnce(
      buildOptions(cwd, {
        adapter: fakeAdapter({
          collectVisibleOrders: async () => ({ orders: [], empty: true, rows_seen: 0, recognized: 0 }),
        }),
      }),
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report.counts.seen).toBe(0);
    expect(outcome.report.warnings.join(" ")).toContain("empty");
  });

  it("refuses a second commit within the minimum interval", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    mkdirSync(join(cwd, "state"), { recursive: true });
    writeFileSync(
      join(cwd, "state", "cursor-1688-1688-main.json"),
      JSON.stringify({
        platform: "1688",
        account_key: "1688-main",
        last_success_at: null,
        last_sync_at: new Date(Date.now() - 60_000).toISOString(),
        last_cursor: null,
        last_batch_id: null,
        last_status: "OK",
        consecutive_failures: 0,
        updated_at: new Date().toISOString(),
      }),
      "utf8",
    );
    const outcome = await runSyncOnce(
      buildOptions(cwd, { mode: "commit", confirm: true }, { ARRIVAL_SYNC_WORKER_KEY: "test-worker-key-0001" }),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.error_code).toBe("RATE_LIMITED");
  });

  it("holds the platform+account lock while running", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const ref: { release?: () => void } = {};
    const adapter = fakeAdapter({
      openOrders: async () => {
        await new Promise<void>((resolve) => {
          ref.release = resolve;
        });
      },
    });
    const runPromise = runSyncOnce(buildOptions(cwd, { adapter }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { acquireLock } = await import("../src/state/lock.js");
    const second = acquireLock(join(cwd, "state"), "1688", "1688-main", "worker-2");
    expect(second.held).toBe(false);
    ref.release?.();
    const outcome = await runPromise;
    expect(outcome.exitCode).toBe(0);
  });
});

describe("run report files", () => {
  it("writes a sanitized local report for dry-run", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const logger = new JsonLogger({ logDir: null });
    const spy = vi.spyOn(logger, "info");
    await runSyncOnce(buildOptions(cwd, { logger }));
    const reportCall = spy.mock.calls.find((call) => String(call[0].message).includes("report written"));
    expect(reportCall).toBeDefined();
    spy.mockRestore();
  });
});
