import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pddAdapter, PDD_STATUS_MAP } from "../src/adapters/pdd.js";
import { splitLogisticsCell, trackingFromLabeledText } from "../src/extract/tracking.js";
import { checkPageState } from "../src/browser/guards.js";
import { buildUnifiedOrder } from "../src/extract/order.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pdd");

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

describe("pdd adapter with sanitized fixtures", () => {
  it("detects a logged-in order list", async () => {
    await openFixture("order-list.html");
    const state = await checkPageState(page, pddAdapter);
    expect(state.status).toBe("OK");
  });

  it("detects a login wall", async () => {
    await openFixture("login-wall.html");
    const state = await checkPageState(page, pddAdapter);
    expect(state.status).toBe("NEEDS_LOGIN");
  });

  it("detects captcha/risk blocks", async () => {
    await openFixture("blocked.html");
    const state = await checkPageState(page, pddAdapter);
    expect(state.status).toBe("CAPTCHA_OR_BLOCKED");
  });

  it("reads visible order cards from the fixture list", async () => {
    await openFixture("order-list.html");
    const list = await pddAdapter.collectVisibleOrders(page);
    expect(list.empty).toBe(false);
    expect(list.rows_seen).toBe(2);
    expect(list.recognized).toBe(2);

    const first = list.orders[0];
    expect(first?.platform_order_id).toBe("260813-7700000001");
    expect(first?.items[0]?.title).toContain("毛巾");
    expect(first?.items[0]?.quantity).toBe("x2");
    expect(first?.shop_name).toBe("测试百货店");
    expect(first?.status).toBe("已发货");
    expect(first?.packages[0]?.courier).toContain("顺丰");
    expect(first?.packages[0]?.tracking_no).toBe("SF-20260813-0001");

    const second = list.orders[1];
    expect(second?.platform_order_id).toBe("260813-7700000002");
    expect(second?.status).toBe("退款成功");
    expect(second?.packages).toHaveLength(0);
  });

  it("builds valid unified orders from the fixture cards", async () => {
    await openFixture("order-list.html");
    const list = await pddAdapter.collectVisibleOrders(page);
    for (const raw of list.orders) {
      const result = buildUnifiedOrder(raw, "pdd", "pdd-main", PDD_STATUS_MAP);
      expect(result.issues).toEqual([]);
      expect(result.order).not.toBeNull();
    }
  });

  it("reads multiple items and packages from one card", async () => {
    await openFixture("order-list-multi.html");
    const list = await pddAdapter.collectVisibleOrders(page);
    expect(list.orders).toHaveLength(1);
    const order = list.orders[0];
    expect(order?.platform_order_id).toBe("260813-8800000001");
    expect(order?.items).toHaveLength(2);
    expect(order?.items[0]?.title).toBe("测试商品甲");
    expect(order?.items[1]?.title).toBe("测试商品乙");
    expect(order?.packages).toHaveLength(2);
    expect(order?.packages[0]?.tracking_no).toBe("SF-20260813-0001");
    expect(order?.packages[1]?.tracking_no).toBe("8800123456789");
  });

  it("builds valid unified orders from the multi fixture", async () => {
    await openFixture("order-list-multi.html");
    const list = await pddAdapter.collectVisibleOrders(page);
    const result = buildUnifiedOrder(list.orders[0]!, "pdd", "pdd-main", PDD_STATUS_MAP);
    expect(result.issues).toEqual([]);
    expect(result.order?.items).toHaveLength(2);
    expect(result.order?.packages).toHaveLength(2);
  });

  it("ignores hidden order cards placed before real cards", async () => {
    await openFixture("order-list-hidden-first.html");
    const state = await checkPageState(page, pddAdapter);
    expect(state.status).toBe("OK");
    const list = await pddAdapter.collectVisibleOrders(page);
    expect(list.rows_seen).toBe(1);
    expect(list.orders).toHaveLength(1);
    expect(list.orders[0]?.platform_order_id).toBe("260813-8800000001");
    for (const order of list.orders) {
      expect(order.platform_order_id).not.toContain("9999999999");
      expect(order.items[0]?.title).not.toContain("隐藏");
    }
  });

  it("reports an empty list without treating it as schema change", async () => {
    await openFixture("empty-list.html");
    const list = await pddAdapter.collectVisibleOrders(page);
    expect(list.empty).toBe(true);
    expect(list.orders).toHaveLength(0);
    expect(list.rows_seen).toBe(0);
  });

  it("recognizes an unparseable page as zero recognized cards", async () => {
    await page.setContent("<div class='weird'><p>完全不同的结构</p></div>");
    const list = await pddAdapter.collectVisibleOrders(page);
    expect(list.orders).toHaveLength(0);
    expect(list.recognized).toBe(0);
  });
});

describe("splitLogisticsCell", () => {
  it("splits courier and tracking from a combined logistics cell", () => {
    expect(splitLogisticsCell("顺丰速运 SF-20260813-0001")).toEqual({
      courier: "顺丰速运",
      tracking: "SF-20260813-0001",
    });
  });
  it("accepts pure numeric tracking numbers of 8-24 digits", () => {
    expect(splitLogisticsCell("中通快递 8800123456789")).toEqual({
      courier: "中通快递",
      tracking: "8800123456789",
    });
  });
  it("does not treat short digit runs as tracking", () => {
    expect(splitLogisticsCell("快递 1234567")).toEqual({ courier: "快递 1234567", tracking: null });
  });
  it("returns courier only when no tracking candidate exists", () => {
    expect(splitLogisticsCell("顺丰速运")).toEqual({ courier: "顺丰速运", tracking: null });
  });
  it("handles empty cells", () => {
    expect(splitLogisticsCell("")).toEqual({ courier: null, tracking: null });
  });
});

describe("trackingFromLabeledText", () => {
  it("accepts pure numeric tracking in labeled fields", () => {
    expect(trackingFromLabeledText("8800123456789")).toBe("8800123456789");
  });
  it("rejects values that are too short", () => {
    expect(trackingFromLabeledText("12345")).toBeNull();
  });
  it("rejects placeholder texts", () => {
    expect(trackingFromLabeledText("无")).toBeNull();
    expect(trackingFromLabeledText("-")).toBeNull();
    expect(trackingFromLabeledText("待发货")).toBeNull();
  });
  it("unwraps excel wrappers", () => {
    expect(trackingFromLabeledText('="SF123456789"')).toBe("SF123456789");
  });
});
