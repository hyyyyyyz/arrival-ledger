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
import { readSnapshot, snapshotToBatch, verifySnapshot } from "../src/snapshot.js";

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
    collectVisibleOrders: async (_page, options) => {
      const order = rawOrder();
      const skip = options?.skip_order_ids;
      if (skip !== undefined && order.platform_order_id !== null && skip.has(order.platform_order_id)) {
        return { orders: [], empty: false, rows_seen: 0, recognized: 0, unparsed: [] };
      }
      return { orders: [order], empty: false, rows_seen: 1, recognized: 1, unparsed: [] };
    },
    advancePage: async () => false,
    readOrderDetail: async () => null,
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

async function dryRunSnapshot(cwd: string, env: Record<string, string> = {}): Promise<string> {
  mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
  const outcome = await runSyncOnce(buildOptions(cwd, { mode: "dry-run" }, env));
  expect(outcome.exitCode).toBe(0);
  expect(outcome.report.snapshot_path).not.toBeNull();
  return outcome.report.snapshot_path as string;
}

describe("runSyncOnce dry-run", () => {
  it("dry-run collects orders, never uploads, and persists a verified snapshot", async () => {
    const cwd = tempCwd();
    const path = await dryRunSnapshot(cwd);
    const snapshot = readSnapshot(path);
    expect(snapshot).not.toBeNull();
    expect(verifySnapshot(snapshot!)).toEqual({ ok: true, reason: null });
    expect(snapshot!.orders).toHaveLength(1);
  });

  it("fails closed when the profile dir is missing", async () => {
    const cwd = tempCwd();
    const outcome = await runSyncOnce(buildOptions(cwd));
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
          collectVisibleOrders: async () => ({
            orders: [],
            empty: false,
            rows_seen: 5,
            recognized: 0,
            unparsed: Array.from({ length: 5 }, () => ({
              locator: {} as never,
              missing: ["order_id"] as const,
              hint: "no order id",
            })),
          }),
          readOrderDetail: async () => null,
        }),
      }),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.status).toBe("SCHEMA_CHANGED");
  });

  it("stops with SCHEMA_CHANGED when extraction fails", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const badOrder: RawOrder = {
      ...rawOrder(),
      items: [{ item_key: null, title: null, sku_text: null, quantity: null, unit_price: null }],
    };
    const outcome = await runSyncOnce(
      buildOptions(cwd, {
        adapter: fakeAdapter({
          collectVisibleOrders: async () => ({ orders: [badOrder], empty: false, rows_seen: 1, recognized: 1, unparsed: [] }),
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
          collectVisibleOrders: async () => ({ orders: [], empty: true, rows_seen: 0, recognized: 0, unparsed: [] }),
        }),
      }),
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report.counts.seen).toBe(0);
    expect(outcome.report.warnings.join(" ")).toContain("empty");
  });

  it("writes a report that is detailed enough for human review", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const logger = new JsonLogger({ logDir: null });
    const spy = vi.spyOn(logger, "info");
    await runSyncOnce(buildOptions(cwd, { logger }));
    spy.mockRestore();
    const reports = await import("node:fs/promises");
    const entries = await reports.readdir(join(cwd, "state"));
    const reportFile = entries.find((name) => name.startsWith("report-"));
    expect(reportFile).toBeDefined();
    const report = JSON.parse(
      readFileSync(join(cwd, "state", reportFile as string), "utf8"),
    ) as { orders: Array<Record<string, unknown>> };
    expect(report.orders[0]?.["shop_name"]).toBe("测试店铺");
    const item = (report.orders[0]?.["items"] as Array<Record<string, unknown>>)[0];
    expect(item?.["title"]).toBe("测试商品");
    expect(item?.["quantity"]).toBe(2);
    const pkg = (report.orders[0]?.["packages"] as Array<Record<string, unknown>>)[0];
    expect(pkg?.["courier"]).toBe("中通");
    expect(pkg?.["tracking_no"]).toBe("ZTO-20260813-0001");
  });
});

describe("runSyncOnce pagination safety", () => {
  it("stops when a captcha appears after a page change", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    let pageIndex = 0;
    const adapter = fakeAdapter({
      collectVisibleOrders: async () => {
        pageIndex += 1;
        return {
          orders: [rawOrder()],
          empty: false,
          rows_seen: 1,
          recognized: 1,
          unparsed: [],
        };
      },
      advancePage: async () => true,
      detectBlock: async () =>
        pageIndex >= 2
          ? { blocked: true, kind: "captcha", detail: "fake slider after pagination" }
          : { blocked: false, kind: "unknown", detail: "none" },
    });
    const outcome = await runSyncOnce(
      buildOptions(cwd, { adapter }, { SYNC_PAGE_DELAY_MS: "1500" }),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.status).toBe("CAPTCHA_OR_BLOCKED");
    expect(outcome.report.counts.seen).toBe(0);
    expect(outcome.report.error_code).toBe("CAPTCHA_OR_BLOCKED");
  });

  it("stops when pagination produces no new orders", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const adapter = fakeAdapter({
      advancePage: async () => true,
      collectVisibleOrders: async (_page, options) => {
        const order = rawOrder();
        const skip = options?.skip_order_ids;
        if (skip !== undefined && skip.has(order.platform_order_id ?? "")) {
          return { orders: [], empty: false, rows_seen: 0, recognized: 0, unparsed: [] };
        }
        return { orders: [order], empty: false, rows_seen: 1, recognized: 1, unparsed: [] };
      },
    });
    const outcome = await runSyncOnce(
      buildOptions(cwd, { adapter }, { SYNC_PAGE_DELAY_MS: "1500" }),
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report.counts.seen).toBe(1);
    expect(outcome.report.warnings.join(" ")).toContain("no new orders");
  });

  it("stops when the next page contains unparsed rows (SCHEMA_CHANGED)", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    let pageIndex = 0;
    const adapter = fakeAdapter({
      advancePage: async () => true,
      collectVisibleOrders: async () => {
        pageIndex += 1;
        if (pageIndex === 1) {
          return { orders: [rawOrder()], empty: false, rows_seen: 1, recognized: 1, unparsed: [] };
        }
        return {
          orders: [],
          empty: false,
          rows_seen: 1,
          recognized: 0,
          unparsed: [{ locator: {} as never, missing: ["order_id"] as const, hint: "no order id" }],
        };
      },
      readOrderDetail: async () => null,
    });
    const outcome = await runSyncOnce(
      buildOptions(cwd, { adapter }, { SYNC_PAGE_DELAY_MS: "1500" }),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.status).toBe("SCHEMA_CHANGED");
  });

  it("stops with SCHEMA_CHANGED when an unparsed card cannot be resolved", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const adapter = fakeAdapter({
      collectVisibleOrders: async () => ({
        orders: [rawOrder()],
        empty: false,
        rows_seen: 2,
        recognized: 1,
        unparsed: [{ locator: {} as never, missing: ["order_id"], hint: "no order id" }],
      }),
      readOrderDetail: async () => null,
    });
    const outcome = await runSyncOnce(
      buildOptions(cwd, { adapter }),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.status).toBe("SCHEMA_CHANGED");
  });

  it("resolves unparsed cards via the detail page and merges them", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const detailOrder: RawOrder = { ...rawOrder(), platform_order_id: "1688-260813-0002" };
    const adapter = fakeAdapter({
      collectVisibleOrders: async () => ({
        orders: [rawOrder()],
        empty: false,
        rows_seen: 2,
        recognized: 1,
        unparsed: [{ locator: {} as never, missing: ["order_id"], hint: "no order id" }],
      }),
      readOrderDetail: async () => detailOrder,
    });
    const outcome = await runSyncOnce(
      buildOptions(cwd, { adapter }),
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report.counts.seen).toBe(2);
    expect(outcome.report.counts.valid).toBe(2);
  });

  it("truncates to max_records instead of pushing a whole page", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const manyOrders = Array.from({ length: 10 }, (_, index) => ({
      ...rawOrder(),
      platform_order_id: `1688-260813-${String(index).padStart(4, "0")}`,
    }));
    const adapter = fakeAdapter({
      collectVisibleOrders: async () => ({
        orders: manyOrders,
        empty: false,
        rows_seen: 10,
        recognized: 10,
        unparsed: [],
      }),
    });
    const outcome = await runSyncOnce(
      buildOptions(cwd, { adapter }, { SYNC_MAX_RECORDS: "3" }),
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report.counts.seen).toBe(3);
    expect(outcome.report.counts.valid).toBe(3);
  });

  it("stops gracefully when page advance throws", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const adapter = fakeAdapter({
      advancePage: async () => {
        throw new Error("click intercepted");
      },
    });
    const outcome = await runSyncOnce(
      buildOptions(cwd, { adapter }, { SYNC_PAGE_DELAY_MS: "1500" }),
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report.counts.seen).toBe(1);
    expect(outcome.report.warnings.join(" ")).toContain("pagination ended");
  });

  it("rejects an unofficial order list url via openOrders", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const opened: string[] = [];
    const adapter = fakeAdapter({
      openOrders: async (_page, window) => {
        opened.push(window.order_list_url ?? "");
        if (window.order_list_url === "https://evil.example.com/orders") {
          throw new Error("order list host is not official");
        }
      },
    });
    const outcome = await runSyncOnce(
      buildOptions(cwd, { adapter }, { ALI1688_ORDER_URL: "https://evil.example.com/orders" }),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.error_code).toBe("CONFIG");
    expect(opened).toEqual(["https://evil.example.com/orders"]);
  });

  it("passes the configured order list url to the adapter", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const opened: string[] = [];
    const adapter = fakeAdapter({
      openOrders: async (_page, window) => {
        opened.push(window.order_list_url ?? "");
      },
    });
    await runSyncOnce(
      buildOptions(cwd, { adapter }, { ALI1688_ORDER_URL: "https://air.1688.com/app/orders" }),
    );
    expect(opened).toEqual(["https://air.1688.com/app/orders"]);
  });
});

describe("runSyncOnce detail authority and completeness", () => {
  it("merges detail as the authoritative source", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const listOrder: RawOrder = {
      ...rawOrder(),
      status: "已发货",
      items: [{ item_key: null, title: "测试商品", sku_text: null, quantity: "1", unit_price: null }],
      packages: [{ courier: null, tracking_no: "ZTO-20260813-0001", status: null }],
    };
    const detailOrder: RawOrder = {
      ...rawOrder(),
      status: "已发货",
      items: [{ item_key: null, title: "测试商品", sku_text: null, quantity: "2", unit_price: null }],
      packages: [{ courier: "中通快递", tracking_no: "ZTO-20260813-0001", status: null }],
      detail_source: true,
      detail_logistics: { area_found: true, unparsed_rows: 0 },
    };
    const adapter = fakeAdapter({
      collectVisibleOrders: async () => ({
        orders: [listOrder],
        empty: false,
        rows_seen: 1,
        recognized: 1,
        unparsed: [
          {
            locator: {} as never,
            missing: ["logistics"] as const,
            hint: "shipped order requires a full detail read",
            order_id: "1688-260813-0001",
          },
        ],
      }),
      readOrderDetail: async () => detailOrder,
    });
    const outcome = await runSyncOnce(buildOptions(cwd, { adapter }));
    expect(outcome.exitCode).toBe(0);
    const snapshot = readSnapshot(outcome.report.snapshot_path as string);
    const batch = snapshotToBatch(snapshot!);
    expect(batch?.orders[0]?.items[0]?.quantity).toBe(2);
    expect(batch?.orders[0]?.packages[0]?.courier).toBe("中通快递");
  });

  it("stops with SCHEMA_CHANGED when a shipped order has no packages after detail", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const shippedNoPackages: RawOrder = { ...rawOrder(), status: "已发货", packages: [] };
    const adapter = fakeAdapter({
      collectVisibleOrders: async () => ({
        orders: [shippedNoPackages],
        empty: false,
        rows_seen: 1,
        recognized: 1,
        unparsed: [],
      }),
    });
    const outcome = await runSyncOnce(buildOptions(cwd, { adapter }));
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.status).toBe("SCHEMA_CHANGED");
  });
});

describe("runSyncOnce commit", () => {
  it("requires a snapshot; commit never re-opens the browser", async () => {
    const cwd = tempCwd();
    const outcome = await runSyncOnce(
      buildOptions(cwd, { mode: "commit", confirm: true }, { ARRIVAL_SYNC_WORKER_KEY: "test-worker-key-0001" }),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.error_code).toBe("CONFIG");
  });

  it("refuses a missing snapshot file", async () => {
    const cwd = tempCwd();
    const outcome = await runSyncOnce(
      buildOptions(
        cwd,
        { mode: "commit", confirm: true, snapshotPath: join(cwd, "nope.json") },
        { ARRIVAL_SYNC_WORKER_KEY: "test-worker-key-0001" },
      ),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.error_code).toBe("SNAPSHOT_INVALID");
  });

  it("refuses a tampered snapshot and uploads nothing", async () => {
    const cwd = tempCwd();
    const path = await dryRunSnapshot(cwd, { ARRIVAL_SYNC_WORKER_KEY: "test-worker-key-0001" });
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { payload_json: string };
    parsed.payload_json = parsed.payload_json.replace("测试商品", "被篡改商品");
    writeFileSync(path, JSON.stringify(parsed, null, 2), "utf8");
    const outcome = await runSyncOnce(
      buildOptions(
        cwd,
        { mode: "commit", confirm: true, snapshotPath: path },
        { ARRIVAL_SYNC_WORKER_KEY: "test-worker-key-0001" },
      ),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.error_code).toBe("SNAPSHOT_INVALID");
  });

  it("requires --yes confirmation", async () => {
    const cwd = tempCwd();
    const path = await dryRunSnapshot(cwd, { ARRIVAL_SYNC_WORKER_KEY: "test-worker-key-0001" });
    const outcome = await runSyncOnce(
      buildOptions(
        cwd,
        { mode: "commit", confirm: false, snapshotPath: path },
        { ARRIVAL_SYNC_WORKER_KEY: "test-worker-key-0001" },
      ),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.error_code).toBe("CONFIRM_REQUIRED");
  });

  it("refuses a second commit within the minimum interval", async () => {
    const cwd = tempCwd();
    const path = await dryRunSnapshot(cwd);
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
      buildOptions(
        cwd,
        { mode: "commit", confirm: true, snapshotPath: path },
        { ARRIVAL_SYNC_WORKER_KEY: "test-worker-key-0001" },
      ),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.error_code).toBe("RATE_LIMITED");
  });

  it("refuses a snapshot from a different platform or account", async () => {
    const cwd = tempCwd();
    const path = await dryRunSnapshot(cwd, { ARRIVAL_SYNC_WORKER_KEY: "test-worker-key-0001" });
    const outcome = await runSyncOnce(
      buildOptions(
        cwd,
        { platform: "pdd", mode: "commit", confirm: true, snapshotPath: path },
        { ARRIVAL_SYNC_WORKER_KEY: "test-worker-key-0001" },
      ),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.error_code).toBe("SNAPSHOT_INVALID");
  });

  it("refuses to commit an empty snapshot", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const outcome = await runSyncOnce(
      buildOptions(cwd, {
        adapter: fakeAdapter({
          collectVisibleOrders: async () => ({ orders: [], empty: true, rows_seen: 0, recognized: 0, unparsed: [] }),
        }),
      }),
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report.snapshot_path).not.toBeNull();
    const commitOutcome = await runSyncOnce(
      buildOptions(
        cwd,
        { mode: "commit", confirm: true, snapshotPath: outcome.report.snapshot_path as string },
        { ARRIVAL_SYNC_WORKER_KEY: "test-worker-key-0001" },
      ),
    );
    expect(commitOutcome.exitCode).toBe(1);
    expect(commitOutcome.report.error_code).toBe("EMPTY_SNAPSHOT");
  });

  it("stops with the block state when captcha appears during detail reading", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    let block = false;
    const adapter = fakeAdapter({
      collectVisibleOrders: async () => ({
        orders: [],
        empty: false,
        rows_seen: 1,
        recognized: 0,
        unparsed: [{ locator: {} as never, missing: ["order_id"] as const, hint: "no order id" }],
      }),
      readOrderDetail: async () => {
        block = true;
        return null;
      },
      detectBlock: async () =>
        block
          ? { blocked: true, kind: "captcha", detail: "captcha on detail page" }
          : { blocked: false, kind: "unknown", detail: "none" },
    });
    const outcome = await runSyncOnce(buildOptions(cwd, { adapter }));
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.status).toBe("CAPTCHA_OR_BLOCKED");
  });

  it("never touches the cursor when a tampered snapshot is rejected", async () => {
    const cwd = tempCwd();
    const path = await dryRunSnapshot(cwd, { ARRIVAL_SYNC_WORKER_KEY: "test-worker-key-0001" });
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { payload_json: string };
    parsed.payload_json = parsed.payload_json.replace("测试商品", "被篡改商品");
    writeFileSync(path, JSON.stringify(parsed, null, 2), "utf8");
    const outcome = await runSyncOnce(
      buildOptions(
        cwd,
        { mode: "commit", confirm: true, snapshotPath: path },
        { ARRIVAL_SYNC_WORKER_KEY: "test-worker-key-0001" },
      ),
    );
    expect(outcome.exitCode).toBe(1);
    const { loadCursor } = await import("../src/state/cursor.js");
    expect(loadCursor(join(cwd, "state"), "1688", "1688-main")).toBeNull();
  });

  it("refuses an expired snapshot based on the signed payload finished_at", async () => {
    const cwd = tempCwd();
    const path = await dryRunSnapshot(cwd, { ARRIVAL_SYNC_WORKER_KEY: "test-worker-key-0001" });
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { payload_json: string; payload_sha256: string };
    const stale = new Date(Date.now() - 31 * 60_000).toISOString();
    parsed.payload_json = parsed.payload_json.replace(
      /"finished_at":"[^"]+"/,
      `"finished_at":"${stale}"`,
    );
    const { createHash } = await import("node:crypto");
    parsed.payload_sha256 = createHash("sha256").update(parsed.payload_json, "utf8").digest("hex");
    writeFileSync(path, JSON.stringify(parsed, null, 2), "utf8");
    const outcome = await runSyncOnce(
      buildOptions(
        cwd,
        { mode: "commit", confirm: true, snapshotPath: path },
        { ARRIVAL_SYNC_WORKER_KEY: "test-worker-key-0001" },
      ),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.error_code).toBe("EXPIRED_SNAPSHOT");
  });

  it("rejects snapshots with obviously future timestamps", async () => {
    const cwd = tempCwd();
    const path = await dryRunSnapshot(cwd, { ARRIVAL_SYNC_WORKER_KEY: "test-worker-key-0001" });
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { payload_json: string; payload_sha256: string };
    const future = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    parsed.payload_json = parsed.payload_json.replace(
      /"finished_at":"[^"]+"/,
      `"finished_at":"${future}"`,
    );
    const { createHash } = await import("node:crypto");
    parsed.payload_sha256 = createHash("sha256").update(parsed.payload_json, "utf8").digest("hex");
    writeFileSync(path, JSON.stringify(parsed, null, 2), "utf8");
    const outcome = await runSyncOnce(
      buildOptions(
        cwd,
        { mode: "commit", confirm: true, snapshotPath: path },
        { ARRIVAL_SYNC_WORKER_KEY: "test-worker-key-0001" },
      ),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.error_code).toBe("SNAPSHOT_INVALID");
  });

  it("refuses a snapshot whose cursor_before no longer matches the current cursor", async () => {
    const cwd = tempCwd();
    const path = await dryRunSnapshot(cwd, { ARRIVAL_SYNC_WORKER_KEY: "test-worker-key-0001" });
    mkdirSync(join(cwd, "state"), { recursive: true });
    writeFileSync(
      join(cwd, "state", "cursor-1688-1688-main.json"),
      JSON.stringify({
        platform: "1688",
        account_key: "1688-main",
        last_success_at: null,
        last_sync_at: null,
        last_cursor: "2026-08-13T00:00:00.000Z",
        last_batch_id: null,
        last_status: "OK",
        consecutive_failures: 0,
        updated_at: new Date().toISOString(),
      }),
      "utf8",
    );
    const outcome = await runSyncOnce(
      buildOptions(
        cwd,
        { mode: "commit", confirm: true, snapshotPath: path },
        { ARRIVAL_SYNC_WORKER_KEY: "test-worker-key-0001" },
      ),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.error_code).toBe("CURSOR_MISMATCH");
  });

  it("accepts a snapshot whose cursor_before matches the current cursor", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "state"), { recursive: true });
    writeFileSync(
      join(cwd, "state", "cursor-1688-1688-main.json"),
      JSON.stringify({
        platform: "1688",
        account_key: "1688-main",
        last_success_at: null,
        last_sync_at: null,
        last_cursor: null,
        last_batch_id: null,
        last_status: "OK",
        consecutive_failures: 0,
        updated_at: new Date().toISOString(),
      }),
      "utf8",
    );
    const path = await dryRunSnapshot(cwd, { ARRIVAL_SYNC_WORKER_KEY: "test-worker-key-0001" });
    const outcome = await runSyncOnce(
      buildOptions(
        cwd,
        { mode: "commit", confirm: false, snapshotPath: path },
        { ARRIVAL_SYNC_WORKER_KEY: "test-worker-key-0001" },
      ),
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.error_code).toBe("CONFIRM_REQUIRED");
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
