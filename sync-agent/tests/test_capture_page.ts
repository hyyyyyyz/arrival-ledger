import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { PlatformAdapter } from "../src/adapters/base.js";
import { runCapturePage } from "../src/capture_page.js";
import { loadConfig } from "../src/config.js";
import {
  captureSanitizedStructure,
  writeSanitizedCapture,
} from "../src/diagnostics/dom_capture.js";
import { JsonLogger } from "../src/log.js";
import type { SyncBrowser } from "../src/browser/context.js";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
});

describe("sanitized structural diagnostics", () => {
  it("preserves layout evidence without raw order, product, shop, URL or credential data", async () => {
    const page = await browser.newPage();
    const target = "https://air.1688.com/orders/ORDER-ABCDEF12345?token=private-token";
    await page.route(target, async (route) => route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `
      <main class="buyer-order-list phone-138-1234-5678 cookie-abcDEFghiJ">
        <article class="panel card session-privateSecret token-AbCdEf12345 order-ABCD-1234-XYZ customer-JacksonHuang"
          data-order-id="888888888888888801" data-credential-abcd1234="private-cookie">
          <span>订单号 888888888888888801</span>
          <a href="https://example.invalid/order?token=private-token">真实商品私密标题</a>
          <span>真实供应商私密名称</span>
          <span>13812345678</span><span>上海市私密地址</span>
          <time>2026-08-14 17:20:56</time><span>￥19.00</span><span>待发货</span>
          <input name="password" value="private-password" />
          <token-SUPERSECRET>never persist this custom tag name</token-SUPERSECRET>
          <script>window.privateToken = "private-script-token";</script>
        </article>
      </main>`,
    }));
    await page.goto(target);
    const capture = await captureSanitizedStructure(page, "1688");
    const serialized = JSON.stringify(capture);
    expect(serialized).toContain("class_0001");
    expect(serialized).toContain("[ORDER_ID]");
    expect(serialized).toContain("[DATETIME]");
    expect(serialized).toContain("待发货");
    expect(capture.origin).toBe("https://air.1688.com");
    expect(capture.pathname).toBe("/[REDACTED]");
    expect(capture.nodes.some((node) => node.tag === "custom")).toBe(true);
    expect(capture.nodes.flatMap((node) => node.attribute_names)).toContain("data-*");
    for (const secret of [
      "888888888888888801",
      "真实商品私密标题",
      "真实供应商私密名称",
      "13812345678",
      "上海市私密地址",
      "private-token",
      "private-cookie",
      "private-password",
      "private-script-token",
      "example.invalid",
      "ORDER-ABCDEF12345",
      "phone-138-1234-5678",
      "cookie-abcDEFghiJ",
      "session-privateSecret",
      "token-AbCdEf12345",
      "order-ABCD-1234-XYZ",
      "customer-JacksonHuang",
      "data-credential-abcd1234",
      "token-supersecret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(capture.nodes.some((node) => node.tag === "script")).toBe(false);
    await page.close();
  });

  it("writes a private gitignored JSON file", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "arrival-capture-"));
    try {
      const page = await browser.newPage();
      await page.setContent("<main><span>订单号 888888888888888801</span><span>待发货</span></main>");
      const capture = await captureSanitizedStructure(page, "1688");
      const path = writeSanitizedCapture(stateDir, capture);
      expect(path).toContain(join("diagnostics", "structure-1688-"));
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ schema_version: 1, platform: "1688" });
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
      await page.close();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("opens one list page, captures once, and never advances or reads details", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "arrival-capture-flow-"));
    try {
      mkdirSync(join(cwd, "profiles", "1688"), { recursive: true });
      const { config } = loadConfig({ cwd, env: { ALI1688_ACCOUNT_KEY: "capture-test" } });
      const context = await browser.newContext();
      const page = await context.newPage();
      const openOrders = vi.fn(async (target: Page) => {
        await target.setContent(`
          <article class="order-card"><span>订单号 888888888888888801</span>
          <span class="item-title">合成商品</span><span class="item-quantity">1</span>
          <span class="order-status">待发货</span><button>订单详情</button></article>
        `);
      });
      const readOrderDetail = vi.fn(async () => null);
      const advancePage = vi.fn(async () => false);
      const adapter: PlatformAdapter = {
        platform: "1688",
        orderListUrl: "https://air.1688.com/orders",
        statusMap: { 待发货: "PAID" },
        allowDetailNavigation: false,
        openOrders,
        detectLogin: async () => ({ logged_in: true, detail: "fixture" }),
        detectBlock: async () => ({ blocked: false, kind: "unknown", detail: "fixture" }),
        collectVisibleOrders: async () => ({ orders: [], empty: false, rows_seen: 1, recognized: 1, unparsed: [] }),
        readOrderDetail,
        advancePage,
      };
      const launcher = async (): Promise<SyncBrowser> => ({
        context,
        close: async () => context.close(),
      });
      const outcome = await runCapturePage({
        config,
        platform: "1688",
        logger: new JsonLogger({ logDir: null }),
        adapter,
        launcher,
      });
      expect(outcome.exitCode).toBe(0);
      expect(outcome.path).not.toBeNull();
      expect(openOrders).toHaveBeenCalledTimes(1);
      expect(readOrderDetail).not.toHaveBeenCalled();
      expect(advancePage).not.toHaveBeenCalled();

      const second = await runCapturePage({
        config,
        platform: "1688",
        logger: new JsonLogger({ logDir: null }),
        adapter,
        launcher,
      });
      expect(second.exitCode).toBe(1);
      expect(openOrders).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
