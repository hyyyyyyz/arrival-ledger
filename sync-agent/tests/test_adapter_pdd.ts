import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pddAdapter, PDD_STATUS_MAP, splitLogisticsCell } from "../src/adapters/pdd.js";
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
  it("returns courier only when no tracking candidate exists", () => {
    expect(splitLogisticsCell("顺丰速运")).toEqual({ courier: "顺丰速运", tracking: null });
  });
  it("does not treat plain chinese digits as tracking", () => {
    expect(splitLogisticsCell("快递 1234567")).toEqual({ courier: "快递 1234567", tracking: null });
  });
  it("handles empty cells", () => {
    expect(splitLogisticsCell("")).toEqual({ courier: null, tracking: null });
  });
});
