import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ali1688Adapter } from "../src/adapters/ali1688.js";
import { checkPageState } from "../src/browser/guards.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "1688");

let browser: import("playwright").Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
});

async function openFixture(name: string): Promise<void> {
  const html = readFileSync(join(fixtureDir, name), "utf8");
  await page.setContent(html);
}

describe("ali1688 adapter with sanitized fixtures", () => {
  it("detects a logged-in order list", async () => {
    await openFixture("order-list.html");
    const state = await checkPageState(page, ali1688Adapter);
    expect(state.status).toBe("OK");
  });

  it("detects a login wall", async () => {
    await openFixture("login-wall.html");
    const state = await checkPageState(page, ali1688Adapter);
    expect(state.status).toBe("NEEDS_LOGIN");
  });

  it("detects captcha/risk blocks", async () => {
    await openFixture("blocked.html");
    const state = await checkPageState(page, ali1688Adapter);
    expect(state.status).toBe("CAPTCHA_OR_BLOCKED");
  });

  it("reads visible orders from the fixture list", async () => {
    await openFixture("order-list.html");
    const list = await ali1688Adapter.collectVisibleOrders(page);
    expect(list.empty).toBe(false);
    expect(list.rows_seen).toBe(2);
    expect(list.recognized).toBe(2);
    expect(list.orders).toHaveLength(2);

    const first = list.orders[0];
    expect(first?.platform_order_id).toBe("1688-260813-0001");
    expect(first?.items[0]?.title).toContain("螺栓");
    expect(first?.items[0]?.quantity).toBe("2");
    expect(first?.shop_name).toContain("供应商");
    expect(first?.status).toBe("已发货");
    expect(first?.ordered_at).toBe("2026-08-12 10:30:00");
    expect(first?.packages[0]?.courier).toContain("中通");
    expect(first?.packages[0]?.tracking_no).toBe("ZTO-20260813-0001");

    const second = list.orders[1];
    expect(second?.platform_order_id).toBe("1688-260813-0002");
    expect(second?.status).toBe("交易关闭");
    expect(second?.packages).toHaveLength(0);
  });

  it("reports an empty list without treating it as schema change", async () => {
    await openFixture("empty-list.html");
    const list = await ali1688Adapter.collectVisibleOrders(page);
    expect(list.empty).toBe(true);
    expect(list.orders).toHaveLength(0);
    expect(list.rows_seen).toBe(0);
  });

  it("recognizes an unparseable page as zero recognized rows", async () => {
    await page.setContent("<div class='weird-layout'><p>完全不同的结构</p></div>");
    const list = await ali1688Adapter.collectVisibleOrders(page);
    expect(list.orders).toHaveLength(0);
    expect(list.recognized).toBe(0);
  });

  it("exposes only https order list urls", () => {
    expect(ali1688Adapter.orderListUrl.startsWith("https://")).toBe(true);
  });
});
