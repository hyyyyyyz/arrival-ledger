import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ali1688Adapter } from "../src/adapters/ali1688.js";
import { assertAllowedOrderListUrl } from "../src/browser/context.js";
import { checkPageState } from "../src/browser/guards.js";
import { buildUnifiedOrder } from "../src/extract/order.js";

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

  it("does not confuse a login verification code with a captcha block", async () => {
    await page.setContent(`
      <main>
        <h1>扫码登录</h1>
        <input type="password" />
        <input type="text" aria-label="验证码" />
        <button>获取验证码</button>
      </main>
    `);
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

  it("uses an explicit data-order-id without treating a broad wrapper as an order", async () => {
    await page.setContent(`
      <main class="order-list-wrapper">
        <div data-order-id="888888888888888804">
          <time>2026-08-14 15:10:00</time><span>待卖家发货</span>
          <div><a href="https://detail.1688.com/offer/data-id-fixture.html">合成属性订单商品</a>
          <span>规格：合成规格</span><span>x1</span><span>￥6.60</span></div>
          <button>订单详情</button>
        </div>
      </main>
    `);
    const list = await ali1688Adapter.collectVisibleOrders(page);
    expect(list.orders).toHaveLength(1);
    expect(list.orders[0]?.platform_order_id).toBe("888888888888888804");
    expect(list.orders[0]?.items[0]?.quantity).toBe("x1");
  });

  it("keeps the order id bound to its labeled DOM leaf beside a timestamp", async () => {
    await page.setContent(`
      <article role="listitem" style="display:flex">
        <span>订单号 888888888888888806</span><span>2026-08-14 15:21:00</span>
        <a href="https://detail.1688.com/offer/id-boundary-fixture.html">合成边界商品</a>
        <span>规格：合成规格</span><span>x1</span><span>￥1.00</span><span>待卖家发货</span>
        <button>订单详情</button>
      </article>
    `);
    const list = await ali1688Adapter.collectVisibleOrders(page);
    expect(list.orders).toHaveLength(1);
    expect(list.orders[0]?.platform_order_id).toBe("888888888888888806");
    expect(list.orders[0]?.ordered_at).toBe("2026-08-14 15:21:00");
  });

  it("reports an empty list without treating it as schema change", async () => {
    await openFixture("empty-list.html");
    const list = await ali1688Adapter.collectVisibleOrders(page);
    expect(list.empty).toBe(true);
    expect(list.orders).toHaveLength(0);
    expect(list.rows_seen).toBe(0);
  });

  it("treats an empty order page as logged in, not as a login wall", async () => {
    await openFixture("empty-list.html");
    const state = await checkPageState(page, ali1688Adapter);
    expect(state.status).toBe("OK");
  });

  it("ignores hidden captcha and login templates", async () => {
    await openFixture("order-list-hidden-templates.html");
    const state = await checkPageState(page, ali1688Adapter);
    expect(state.status).toBe("OK");
    const list = await ali1688Adapter.collectVisibleOrders(page);
    expect(list.recognized).toBe(1);
    expect(list.orders[0]?.platform_order_id).toBe("1688-260813-0001");
  });

  it("skips already-seen order ids across pagination", async () => {
    await openFixture("order-list.html");
    const first = await ali1688Adapter.collectVisibleOrders(page);
    const second = await ali1688Adapter.collectVisibleOrders(page, {
      skip_order_ids: new Set(first.orders.map((order) => order.platform_order_id!)),
    });
    expect(second.rows_seen).toBe(0);
    expect(second.orders).toHaveLength(0);
    expect(second.empty).toBe(false);
  });

  it("returns false when no pagination control exists", async () => {
    await openFixture("order-list-hidden-templates.html");
    expect(await ali1688Adapter.advancePage(page)).toBe(false);
  });

  it("recognizes an unparseable page as zero recognized rows", async () => {
    await page.setContent("<div class='weird-layout'><p>完全不同的结构</p></div>");
    const list = await ali1688Adapter.collectVisibleOrders(page);
    expect(list.orders).toHaveLength(0);
    expect(list.recognized).toBe(0);
  });

  it("ignores hidden order rows placed before real rows", async () => {
    await openFixture("order-list-hidden-first.html");
    const state = await checkPageState(page, ali1688Adapter);
    expect(state.status).toBe("OK");
    const list = await ali1688Adapter.collectVisibleOrders(page);
    expect(list.rows_seen).toBe(1);
    expect(list.orders).toHaveLength(1);
    expect(list.orders[0]?.platform_order_id).toBe("1688-260813-0001");
    for (const order of list.orders) {
      expect(order.platform_order_id).not.toContain("9999999999");
      expect(order.items[0]?.title).not.toContain("隐藏");
    }
  });

  it("keeps 1688 shipped orders on the list page without detail enrichment", async () => {
    await openFixture("order-list.html");
    const list = await ali1688Adapter.collectVisibleOrders(page);
    expect(ali1688Adapter.allowDetailNavigation).toBe(false);
    expect(list.unparsed.some((card) => card.missing.includes("logistics"))).toBe(true);
    expect(list.orders[0]?.platform_order_id).toBe("1688-260813-0001");
  });

  it("parses multiple items per row without cross-item shifting", async () => {
    await openFixture("order-list-single-row-multi-item.html");
    const list = await ali1688Adapter.collectVisibleOrders(page);
    expect(list.orders).toHaveLength(1);
    const items = list.orders[0]?.items ?? [];
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.title)).toEqual(["同名测试商品", "同名测试商品"]);
    expect(items.map((item) => item.sku_text)).toEqual(["M8", null]);
    expect(items.map((item) => item.quantity)).toEqual(["2", "4"]);
  });

  it("leaves unknown status text for fail-closed normalization without opening detail", async () => {
    await page.setContent(
      `<table class="trade-order-list"><thead><tr><th>订单号</th><th>商品名称</th><th>数量</th><th>订单状态</th><th>物流</th></tr></thead>
       <tbody><tr>
         <td><span class="order-id">1688-260813-0007</span></td>
         <td><span class="item-title">未知状态商品</span></td>
         <td><span class="item-quantity">1</span></td>
         <td><span class="order-status">奇异状态</span></td>
         <td></td>
       </tr></tbody></table>`,
    );
    const list = await ali1688Adapter.collectVisibleOrders(page);
    expect(list.orders[0]?.status).toBe("奇异状态");
    expect(list.unparsed.some((card) => card.order_id === "1688-260813-0007")).toBe(true);
    const normalized = buildUnifiedOrder(list.orders[0]!, "1688", "1688-main", ali1688Adapter.statusMap);
    expect(normalized.order).toBeNull();
    expect(normalized.issues.join(" ")).toContain("unrecognized status");
  });

  it("parses the current card-based buyer-order surface without random class coupling", async () => {
    await openFixture("order-list-modern-cards.html");
    const state = await checkPageState(page, ali1688Adapter);
    expect(state.status).toBe("OK");
    const list = await ali1688Adapter.collectVisibleOrders(page);
    expect(list.rows_seen).toBe(2);
    expect(list.recognized).toBe(2);
    expect(list.orders).toHaveLength(2);
    expect(list.orders.map((order) => order.platform_order_id)).toEqual([
      "888888888888888801",
      "888888888888888802",
    ]);
    expect(list.orders[0]?.ordered_at).toBe("2026-08-14 17:20:56");
    expect(list.orders[0]?.shop_name).toBe("合成测试供应商甲");
    expect(list.orders[0]?.items[0]).toMatchObject({
      title: "合成测试商品甲",
      sku_text: "颜色：黑色；尺码：37",
      quantity: "1",
      unit_price: "￥19.00",
    });
    expect(list.orders[0]?.status).toBe("待卖家发货");
    expect(list.orders[1]?.status).toBe("待收货");
    expect(list.orders[1]?.packages).toEqual([]);
    expect(list.orders.some((order) => order.platform_order_id?.includes("999999"))).toBe(false);
  });

  it("treats system-busy pages as a hard risk stop", async () => {
    await page.setContent("<main><h1>系统繁忙</h1><button>刷新试试</button></main>");
    const state = await checkPageState(page, ali1688Adapter);
    expect(state.status).toBe("CAPTCHA_OR_BLOCKED");
    expect(state.detail).toContain("risk");
  });

  it("ignores a hidden security iframe left in the logged-in order DOM", async () => {
    await openFixture("order-list-modern-cards.html");
    await page.evaluate(() => {
      const iframe = document.createElement("iframe");
      iframe.src = "data:text/html,captcha-punish";
      iframe.style.display = "none";
      document.body.append(iframe);
    });
    await page.waitForTimeout(50);
    expect((await checkPageState(page, ali1688Adapter)).status).toBe("OK");
  });

  it("does not invent quantity 1 when a modern card has no readable quantity", async () => {
    await page.setContent(`
      <article role="listitem">
        <span>订单号 888888888888888803</span><time>2026-08-14 15:00:00</time>
        <div><a href="https://detail.1688.com/offer/missing-quantity.html">合成缺数量商品</a>
        <span>规格：合成规格</span><span>￥8.80</span></div>
        <span>待卖家发货</span><button>订单详情</button>
      </article>
    `);
    const list = await ali1688Adapter.collectVisibleOrders(page);
    expect(list.orders).toHaveLength(1);
    expect(list.orders[0]?.items[0]?.quantity).toBeNull();
    const normalized = buildUnifiedOrder(list.orders[0]!, "1688", "1688-main", ali1688Adapter.statusMap);
    expect(normalized.order).toBeNull();
    expect(normalized.issues.join(" ")).toContain("quantity is missing or invalid");
  });

  it("deduplicates image/title offer links before using the card quantity", async () => {
    await page.setContent(`
      <article role="listitem">
        <span>订单号 888888888888888805</span>
        <time>2026-08-14 15:20:00</time>
        <section>
          <a href="https://detail.1688.com/offer/duplicate-link-fixture.html"><img alt="" /></a>
          <a href="https://detail.1688.com/offer/duplicate-link-fixture.html">合成双链接商品</a>
          <span>规格：合成规格</span>
        </section>
        <span>￥12.30</span><span>3</span><span>待卖家发货</span>
        <button>订单详情</button>
      </article>
    `);
    const list = await ali1688Adapter.collectVisibleOrders(page);
    expect(list.orders).toHaveLength(1);
    expect(list.orders[0]?.items).toHaveLength(1);
    expect(list.orders[0]?.items[0]).toMatchObject({
      title: "合成双链接商品",
      quantity: "3",
    });
  });

  it("merges multiple rows of the same order into one raw order", async () => {
    await openFixture("order-list-multirow.html");
    const list = await ali1688Adapter.collectVisibleOrders(page);
    expect(list.rows_seen).toBe(2);
    expect(list.recognized).toBe(2);
    expect(list.orders).toHaveLength(1);
    const order = list.orders[0];
    expect(order?.platform_order_id).toBe("1688-260813-0001");
    expect(order?.items).toHaveLength(2);
    expect(order?.items[0]?.title).toBe("测试商品甲");
    expect(order?.items[1]?.title).toBe("测试商品乙");
    expect(order?.packages).toHaveLength(2);
    expect(order?.packages[0]?.tracking_no).toBe("8800123456789");
    expect(order?.packages[1]?.tracking_no).toBe("8800123456790");
  });

  it("accepts pure numeric tracking numbers from the logistics column", async () => {
    await openFixture("order-list-multirow.html");
    const list = await ali1688Adapter.collectVisibleOrders(page);
    for (const pkg of list.orders[0]?.packages ?? []) {
      expect(/^\d{8,24}$/.test(pkg.tracking_no ?? "")).toBe(true);
    }
    const result = buildUnifiedOrder(
      list.orders[0]!,
      "1688",
      "1688-main",
      ali1688Adapter.statusMap,
    );
    expect(result.issues).toEqual([]);
    expect(result.order?.packages).toHaveLength(2);
  });

  it("exposes only https order list urls", () => {
    expect(ali1688Adapter.orderListUrl.startsWith("https://")).toBe(true);
  });
});

describe("assertAllowedOrderListUrl", () => {
  it("allows official domains only", () => {
    expect(() =>
      assertAllowedOrderListUrl("1688", "https://air.1688.com/app/ctf-page/orders"),
    ).not.toThrow();
    expect(() => assertAllowedOrderListUrl("pdd", "https://mobile.yangkeduo.com/orders.html")).not.toThrow();
    expect(() => assertAllowedOrderListUrl("pdd", "https://evil.example.com/orders")).toThrow();
    expect(() => assertAllowedOrderListUrl("1688", "https://1688.evil.com/orders")).toThrow();
    expect(() => assertAllowedOrderListUrl("1688", "not-a-url")).toThrow();
  });
});
