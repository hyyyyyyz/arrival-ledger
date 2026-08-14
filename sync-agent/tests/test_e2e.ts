import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import type { Page } from "playwright";
import { afterEach, describe, expect, it } from "vitest";

import type { PlatformAdapter } from "../src/adapters/base.js";
import type { SyncBrowser } from "../src/browser/context.js";
import { loadConfig } from "../src/config.js";
import type { RawOrder } from "../src/extract/order.js";
import { JsonLogger } from "../src/log.js";
import type { BrowserLauncher } from "../src/run.js";
import { runSyncOnce } from "../src/run.js";
import { postBatch } from "../src/transport.js";
import { readSnapshot } from "../src/snapshot.js";
import type { SyncBatch } from "../src/models.js";

const createdDirs: string[] = [];
const servers: Server[] = [];

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "sync-agent-e2e-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const server of servers.splice(0)) {
    server.close();
  }
});

interface StoredBatch {
  payload: string;
  counts: { created: number; updated: number; skipped: number };
  received_at: number;
}

interface MockServer {
  url: string;
  batches: Map<string, StoredBatch>;
  seenHeaders: Array<{ authorization: string; idempotency: string }>;
  requests: number;
  failNextWith: number | null;
  stickyFailWith: number | null;
}

async function startMockServer(): Promise<{ server: Server; state: MockServer }> {
  const state: MockServer = {
    url: "",
    batches: new Map(),
    seenHeaders: [],
    requests: 0,
    failNextWith: null,
    stickyFailWith: null,
  };
  const server = createServer((request, response) => {
    state.requests += 1;
    const authorization = String(request.headers["authorization"] ?? "");
    const idempotency = String(request.headers["idempotency-key"] ?? "");
    state.seenHeaders.push({ authorization, idempotency });
    if (state.stickyFailWith !== null) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (state.stickyFailWith === 429) headers["Retry-After"] = "3600";
      response.writeHead(state.stickyFailWith, headers);
      response.end("{}");
      return;
    }
    if (state.failNextWith !== null) {
      const status = state.failNextWith;
      state.failNextWith = null;
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end("{}");
      return;
    }
    if (request.url !== "/api/sync/v1/batches" || request.method !== "POST") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end("{}");
      return;
    }
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      const batch = JSON.parse(body) as SyncBatch;
      const digest = createHash("sha256").update(body).digest("hex");
      const existing = state.batches.get(batch.batch_id);
      if (existing !== undefined) {
        if (existing.payload !== digest) {
          response.writeHead(409, { "Content-Type": "application/json" });
          response.end('{"detail": "conflict"}');
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            batch_id: batch.batch_id,
            ...existing.counts,
            errors: [],
            cursor_accepted: true,
          }),
        );
        return;
      }
      const counts = { created: batch.orders.length, updated: 0, skipped: 0 };
      state.batches.set(batch.batch_id, {
        payload: digest,
        counts,
        received_at: Date.now(),
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ batch_id: batch.batch_id, ...counts, errors: [], cursor_accepted: true }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  state.url = `http://127.0.0.1:${address.port}`;
  servers.push(server);
  return { server, state };
}

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

function fakeAdapter(): PlatformAdapter {
  return {
    platform: "1688",
    orderListUrl: "https://example.invalid/orders",
    statusMap: { 已发货: "SHIPPED" },
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

function e2eConfig(cwd: string, url: string) {
  return loadConfig({
    cwd,
    env: {
      ARRIVAL_API_BASE_URL: url,
      ARRIVAL_SYNC_WORKER_KEY: "e2e-worker-key-0001",
      SYNC_MIN_INTERVAL_MINUTES: "0",
    },
  }).config;
}

async function e2eDryRun(cwd: string, url: string): Promise<string> {
  const config = e2eConfig(cwd, url);
  const outcome = await runSyncOnce({
    config,
    platform: "1688",
    mode: "dry-run",
    confirm: false,
    logger: new JsonLogger({ logDir: null }),
    adapter: fakeAdapter(),
    launcher: fakeLauncher(),
  });
  expect(outcome.exitCode).toBe(0);
  expect(outcome.report.snapshot_path).not.toBeNull();
  return outcome.report.snapshot_path as string;
}

describe("sync-agent against a contract-compliant mock server", () => {
  it("commit uploads exactly the snapshot bytes and advances the cursor", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const { state } = await startMockServer();
    const snapshotPath = await e2eDryRun(cwd, state.url);
    const snapshot = readSnapshot(snapshotPath);
    expect(snapshot).not.toBeNull();

    const config = e2eConfig(cwd, state.url);
    const outcome = await runSyncOnce({
      config,
      platform: "1688",
      mode: "commit",
      confirm: true,
      logger: new JsonLogger({ logDir: null }),
      snapshotPath,
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report.counts.uploaded).toBe(1);
    expect(state.requests).toBe(1);
    expect(state.seenHeaders[0]?.authorization).toBe("Bearer e2e-worker-key-0001");
    expect(state.seenHeaders[0]?.idempotency).toBe(snapshot!.batch_id);
    const stored = state.batches.get(snapshot!.batch_id);
    expect(stored).toBeDefined();
    expect(stored!.payload).toBe(snapshot!.payload_sha256);

    const cursor = JSON.parse(
      readFileSync(join(cwd, "state", "cursor-1688-1688-main.json"), "utf8"),
    ) as { last_status: string; last_batch_id: string | null };
    expect(cursor.last_status).toBe("OK");
    expect(cursor.last_batch_id).toBe(snapshot!.batch_id);
  });

  it("replays an identical batch id with the original counts", async () => {
    const cwd = tempCwd();
    const { state } = await startMockServer();
    const config = e2eConfig(cwd, state.url);
    const batch: SyncBatch = {
      schema_version: 1,
      batch_id: "e2e-replay-0001",
      worker_id: config.worker_id,
      platform: "1688",
      platform_account_key: "1688-main",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      cursor_before: null,
      cursor_after: null,
      mode: "commit",
      orders: [
        {
          platform_order_id: "x",
          ordered_at: null,
          status: "UNKNOWN",
          shop_name: null,
          items: [{ item_key: null, title: "x", sku_text: null, quantity: 1, unit_price: null }],
          packages: [],
          observed_at: new Date().toISOString(),
        },
      ],
    };
    const first = await postBatch(
      { api_base_url: config.api_base_url, worker_key: config.worker_key },
      batch,
    );
    const second = await postBatch(
      { api_base_url: config.api_base_url, worker_key: config.worker_key },
      batch,
    );
    expect(first.created).toBe(1);
    expect(second).toEqual(first);
    expect(state.batches.size).toBe(1);
  });

  it("a conflicting batch id returns 409 without retry", async () => {
    const cwd = tempCwd();
    const { state } = await startMockServer();
    const config = e2eConfig(cwd, state.url);
    const base = (id: string, orderId: string): SyncBatch => ({
      schema_version: 1,
      batch_id: id,
      worker_id: config.worker_id,
      platform: "1688",
      platform_account_key: "1688-main",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      cursor_before: null,
      cursor_after: null,
      mode: "commit",
      orders: [
        {
          platform_order_id: orderId,
          ordered_at: null,
          status: "UNKNOWN",
          shop_name: null,
          items: [{ item_key: null, title: "x", sku_text: null, quantity: 1, unit_price: null }],
          packages: [],
          observed_at: new Date().toISOString(),
        },
      ],
    });
    const options = { api_base_url: config.api_base_url, worker_key: config.worker_key };
    await postBatch(options, base("e2e-conflict-0001", "order-a"));
    await expect(postBatch(options, base("e2e-conflict-0001", "order-b"))).rejects.toMatchObject({
      kind: "conflict",
    });
    expect(state.requests).toBe(2);
  });

  it("stops without retry on 401 and does not advance the cursor", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const { state } = await startMockServer();
    const snapshotPath = await e2eDryRun(cwd, state.url);
    state.failNextWith = 401;
    const config = e2eConfig(cwd, state.url);
    const outcome = await runSyncOnce({
      config,
      platform: "1688",
      mode: "commit",
      confirm: true,
      logger: new JsonLogger({ logDir: null }),
      snapshotPath,
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.error_code).toBe("auth");
    expect(state.requests).toBe(1);
    const cursor = JSON.parse(
      readFileSync(join(cwd, "state", "cursor-1688-1688-main.json"), "utf8"),
    ) as { last_status: string; last_batch_id: string | null };
    expect(cursor.last_status).toBe("NETWORK_ERROR");
    expect(cursor.last_batch_id).toBeNull();
  });

  it("gives up on 429 with a long Retry-After", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const { state } = await startMockServer();
    const snapshotPath = await e2eDryRun(cwd, state.url);
    state.stickyFailWith = 429;
    const config = e2eConfig(cwd, state.url);
    const outcome = await runSyncOnce({
      config,
      platform: "1688",
      mode: "commit",
      confirm: true,
      logger: new JsonLogger({ logDir: null }),
      snapshotPath,
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.error_code).toBe("rate_limited");
    expect(state.requests).toBe(1);
  });

  it("refuses a tampered snapshot before any network call", async () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
    const { state } = await startMockServer();
    const snapshotPath = await e2eDryRun(cwd, state.url);
    const parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as { payload_json: string };
    parsed.payload_json = parsed.payload_json.replace("测试商品", "被篡改商品");
    writeFileSync(snapshotPath, JSON.stringify(parsed, null, 2), "utf8");
    const config = e2eConfig(cwd, state.url);
    const outcome = await runSyncOnce({
      config,
      platform: "1688",
      mode: "commit",
      confirm: true,
      logger: new JsonLogger({ logDir: null }),
      snapshotPath,
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.error_code).toBe("SNAPSHOT_INVALID");
    expect(state.requests).toBe(0);
  });
});
