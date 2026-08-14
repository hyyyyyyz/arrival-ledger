import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ali1688Adapter } from "../src/adapters/ali1688.js";
import { pddAdapter } from "../src/adapters/pdd.js";
import type { UnparsedCard } from "../src/adapters/base.js";
import { checkPageState } from "../src/browser/guards.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const ALI1688_LIST_URL =
  "https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html";
const PDD_LIST_URL = "https://mobile.yangkeduo.com/orders.html";

let browser: import("playwright").Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
});

async function fixtureBody(path: string): Promise<string> {
  return readFileSync(join(fixtureDir, path), "utf8");
}

async function open1688List(fixture: string): Promise<void> {
  await page.context().unrouteAll();
  await page.context().route("**/buyer-order-list.html", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: await fixtureBody(`1688/${fixture}`) });
  });
  await page.context().route("**/detail.html", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: await fixtureBody("1688/detail.html") });
  });
  await page.context().route("**/detail-broken.html", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: await fixtureBody("1688/detail-broken.html") });
  });
  await page.context().route("**/product.html", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: await fixtureBody("1688/product.html") });
  });
  await page.goto(ALI1688_LIST_URL);
}

async function openPddList(fixture: string): Promise<void> {
  await page.context().unrouteAll();
  await page.context().route("**/orders.html", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: await fixtureBody(`pdd/${fixture}`) });
  });
  await page.context().route("**/detail.html", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: await fixtureBody("pdd/detail.html") });
  });
  await page.goto(PDD_LIST_URL);
}

describe("order detail navigation over visible DOM", () => {
  it("collects unparsed cards and resolves them through the detail page", async () => {
    await open1688List("order-list-partial.html");
    const state = await checkPageState(page, ali1688Adapter);
    expect(state.status).toBe("OK");

    const list = await ali1688Adapter.collectVisibleOrders(page);
    expect(list.rows_seen).toBe(1);
    expect(list.recognized).toBe(0);
    expect(list.unparsed).toHaveLength(1);
    expect(list.unparsed[0]?.missing).toContain("order_id");

    const card = list.unparsed[0]!;
    const detail = await ali1688Adapter.readOrderDetail(page, card);
    expect(detail).not.toBeNull();
    expect(detail?.platform_order_id).toBe("1688-260813-0002");
    expect(detail?.items).toHaveLength(2);
    expect(detail?.items[0]?.title).toBe("测试商品丙");
    expect(detail?.items[1]?.title).toBe("测试商品丁");
    expect(detail?.shop_name).toBe("测试供应商乙");
    expect(detail?.packages).toHaveLength(2);
    expect(detail?.packages[0]?.courier).toBe("顺丰速运");
    expect(detail?.packages[0]?.tracking_no).toBe("SF-20260813-0002");
    expect(detail?.packages[1]?.courier).toBe("中通快递");
    expect(detail?.packages[1]?.tracking_no).toBe("8800123456791");

    const back = await checkPageState(page, ali1688Adapter);
    expect(back.status).toBe("OK");
    const again = await ali1688Adapter.collectVisibleOrders(page);
    expect(again.rows_seen).toBe(1);
  });

  it("ignores product links placed before the order detail link", async () => {
    await open1688List("order-list-item-link-first.html");
    const list = await ali1688Adapter.collectVisibleOrders(page);
    expect(list.unparsed).toHaveLength(1);
    const detail = await ali1688Adapter.readOrderDetail(page, list.unparsed[0]!);
    expect(detail).not.toBeNull();
    expect(detail?.platform_order_id).toBe("1688-260813-0002");
    expect(detail?.items).toHaveLength(2);
    expect(detail?.items[0]?.title).toBe("测试商品丙");
    expect(detail?.packages).toHaveLength(2);
  });

  it("returns null when the detail page structure has no order id", async () => {
    await open1688List("order-list-broken-link.html");
    const list = await ali1688Adapter.collectVisibleOrders(page);
    expect(list.unparsed.length).toBeGreaterThan(0);
    const detail = await ali1688Adapter.readOrderDetail(page, list.unparsed[0]!);
    expect(detail).toBeNull();
  });

  it("returns null when the detail order id does not match the card", async () => {
    await open1688List("order-list-mismatch.html");
    const list = await ali1688Adapter.collectVisibleOrders(page);
    const card = list.unparsed.find((entry) => entry.order_id !== undefined && entry.order_id !== null);
    expect(card).toBeDefined();
    const detail = await ali1688Adapter.readOrderDetail(page, card!);
    expect(detail).toBeNull();
  });

  it("handles pdd detail links that open a new tab", async () => {
    await openPddList("order-list-detail-newtab.html");
    const state = await checkPageState(page, pddAdapter);
    expect(state.status).toBe("OK");
    const beforeCount = page.context().pages().length;
    const list = await pddAdapter.collectVisibleOrders(page);
    expect(list.unparsed).toHaveLength(1);
    const detail = await pddAdapter.readOrderDetail(page, list.unparsed[0]!);
    expect(detail).not.toBeNull();
    expect(detail?.platform_order_id).toBe("260813-8800000002");
    expect(detail?.items).toHaveLength(2);
    expect(detail?.packages).toHaveLength(2);
    await page.waitForTimeout(300);
    expect(page.context().pages().length).toBe(beforeCount);
  });

  it("returns null when there is no detail link at all", async () => {
    const fresh = await browser.newPage();
    try {
      await fresh.context().unrouteAll();
      await fresh.context().route("**/detail.html", async (route) => {
        await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: await fixtureBody("1688/detail.html") });
      });
      await fresh.goto(`${ALI1688_LIST_URL.replace("buyer-order-list.html", "detail.html")}`);
      const card: UnparsedCard = {
        locator: fresh.locator("body"),
        missing: ["order_id"],
        hint: "x",
      };
      const detail = await ali1688Adapter.readOrderDetail(fresh, card);
      expect(detail).toBeNull();
    } finally {
      await fresh.close();
    }
  });
});
