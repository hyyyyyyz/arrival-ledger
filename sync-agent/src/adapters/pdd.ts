import type { Locator, Page } from "playwright";

import { assertAllowedOrderListUrl } from "../browser/context.js";
import {
  countVisibleMarkers,
  extractAllFieldValues,
  extractFieldValue,
  extractLabelValue,
} from "../browser/dom.js";
import {
  mergeRawOrdersByOrderId,
  type RawOrder,
  type RawOrderItem,
  type RawOrderPackage,
  type StatusMap,
} from "../extract/order.js";
import { splitLogisticsCell, trackingFromLabeledText } from "../extract/tracking.js";
import type {
  BlockState,
  CollectOptions,
  LoginState,
  OrderListState,
  PlatformAdapter,
  SyncWindow,
  UnparsedCard,
} from "./base.js";

export const PDD_SELECTORS = {
  orderCards: [
    "[data-order-id]",
    "[class*='order-card']",
    "[class*='order-item']",
    "[class*='goods-card']",
    "table tbody tr",
  ],
  nextPage: [
    "button:has-text('加载更多')",
    "[class*='load-more']:not([class*='disabled'])",
    "a:has-text('下一页')",
  ],
  loginMarkers: ["input[type='password']", "text=微信登录", "text=手机号登录", "text=立即登录"],
  blockMarkers: [
    "iframe[src*='captcha']",
    "iframe[src*='punish']",
    "text=安全验证",
    "text=滑动验证",
    "text=拖动滑块",
    "text=验证码",
    "text=风险",
    "text=异常",
  ],
  emptyMarkers: ["text=暂无订单", "text=没有订单", "text=暂无相关订单"],
  fieldSelectors: {
    orderId: ["[class*='order-id']", "[class*='order-sn']", "[data-order-id]"],
    title: ["[class*='item-title']", "[class*='goods-title']", "[class*='goods-name']"],
    sku: ["[class*='item-sku']", "[class*='goods-sku']"],
    quantity: ["[class*='item-quantity']", "[class*='goods-count']"],
    price: ["[class*='item-price']", "[class*='goods-price']"],
    shop: ["[class*='shop-name']", "[class*='mall-name']"],
    time: ["[class*='order-time']", "[class*='create-time']"],
    status: ["[class*='order-status']"],
    logistics: ["[class*='logistics']", "[class*='tracking']"],
  },
} as const;

export const PDD_STATUS_MAP: StatusMap = {
  待支付: "PENDING",
  待付款: "PENDING",
  已支付: "PAID",
  待发货: "PAID",
  已成团: "PAID",
  待成团: "PAID",
  已发货: "SHIPPED",
  运输中: "SHIPPED",
  待收货: "SHIPPED",
  已签收: "COMPLETED",
  已收货: "COMPLETED",
  交易成功: "COMPLETED",
  退款成功: "REFUNDED",
  退款中: "REFUNDED",
  已取消: "CANCELLED",
  已关闭: "CANCELLED",
};

const ORDER_ID_LABELS = ["订单号", "订单编号", "多多支付订单号"];
const TIME_LABELS = ["下单时间", "成交时间", "创建时间", "付款时间"];
const STATUS_LABELS = ["订单状态", "状态"];
const SHOP_LABELS = ["店铺", "商家"];
const COURIER_LABELS = ["物流公司", "快递公司", "快递"];
const TRACKING_LABELS = ["运单号", "物流单号", "快递单号"];
const TITLE_LABELS = ["商品名称", "商品", "宝贝"];
const SKU_LABELS = ["规格", "颜色", "型号"];
const QUANTITY_LABELS = ["数量", "件数", "购买数量"];
const PRICE_LABELS = ["单价", "金额", "实付"];
const LOGISTICS_LABELS = ["物流", "物流信息", "包裹"];

async function findCardLocators(page: Page): Promise<Locator[]> {
  for (const selector of PDD_SELECTORS.orderCards) {
    const cards = page.locator(selector);
    const count = await cards.count().catch(() => 0);
    if (count > 0) {
      const list: Locator[] = [];
      for (let index = 0; index < count; index += 1) list.push(cards.nth(index));
      return list;
    }
  }
  return [];
}

async function extractItems(card: Locator): Promise<RawOrderItem[]> {
  const titles = await extractAllFieldValues(card, PDD_SELECTORS.fieldSelectors.title);
  const skus = await extractAllFieldValues(card, PDD_SELECTORS.fieldSelectors.sku);
  const quantities = await extractAllFieldValues(card, PDD_SELECTORS.fieldSelectors.quantity);
  const prices = await extractAllFieldValues(card, PDD_SELECTORS.fieldSelectors.price);
  if (titles.length === 0) {
    const title = await extractLabelValue(card, TITLE_LABELS);
    if (title === null) {
      return [
        {
          item_key: null,
          title: null,
          sku_text: await extractLabelValue(card, SKU_LABELS),
          quantity: await extractLabelValue(card, QUANTITY_LABELS),
          unit_price: await extractLabelValue(card, PRICE_LABELS),
        },
      ];
    }
    return [
      {
        item_key: null,
        title,
        sku_text: await extractLabelValue(card, SKU_LABELS),
        quantity: (await extractLabelValue(card, QUANTITY_LABELS)) ?? "1",
        unit_price: await extractLabelValue(card, PRICE_LABELS),
      },
    ];
  }
  return titles.map((title, index) => ({
    item_key: null,
    title,
    sku_text: skus[index] ?? null,
    quantity: quantities[index] ?? "1",
    unit_price: prices[index] ?? null,
  }));
}

async function extractPackages(card: Locator): Promise<{
  packages: RawOrderPackage[];
  unreadable: boolean;
}> {
  const packages: RawOrderPackage[] = [];
  const seen = new Set<string>();
  let unreadable = false;
  const add = (courier: string | null, tracking: string): void => {
    const key = tracking.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    packages.push({ courier, tracking_no: tracking, status: null });
  };

  const trackingTexts = await extractAllFieldValues(card, [
    "[class*='tracking-no']",
    "[class*='tracking-number']",
    "[class*='logistics-no']",
  ]);
  for (const text of trackingTexts) {
    const tracking = trackingFromLabeledText(text);
    if (tracking !== null) add(null, tracking);
    else unreadable = true;
  }
  const labeledTracking = await extractLabelValue(card, TRACKING_LABELS);
  if (labeledTracking !== null) {
    const tracking = trackingFromLabeledText(labeledTracking);
    if (tracking !== null) add(await extractLabelValue(card, COURIER_LABELS), tracking);
    else unreadable = true;
  }
  const logisticsTexts = await extractAllFieldValues(card, PDD_SELECTORS.fieldSelectors.logistics);
  for (const text of logisticsTexts) {
    const split = splitLogisticsCell(text);
    if (split.tracking !== null) add(split.courier, split.tracking);
  }
  return { packages, unreadable };
}

export const pddAdapter: PlatformAdapter = {
  platform: "pdd",
  orderListUrl: "https://mobile.yangkeduo.com/orders.html",
  statusMap: PDD_STATUS_MAP,

  async openOrders(page: Page, window: SyncWindow): Promise<void> {
    const url = window.order_list_url ?? this.orderListUrl;
    assertAllowedOrderListUrl(this.platform, url);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
  },

  async detectLogin(page: Page): Promise<LoginState> {
    const emptyCount = await countVisibleMarkers(page, PDD_SELECTORS.emptyMarkers);
    const loginMarkers = await countVisibleMarkers(page, PDD_SELECTORS.loginMarkers);
    const cards = (await findCardLocators(page)).length;
    if (emptyCount > 0 && cards === 0) {
      return { logged_in: true, detail: "order list is empty but the account appears logged in" };
    }
    if (loginMarkers > 0 && cards === 0) {
      return { logged_in: false, detail: "visible login prompt detected on the order page" };
    }
    if (cards > 0) {
      return { logged_in: true, detail: `order cards visible (${cards})` };
    }
    return { logged_in: false, detail: "no order cards and no clear login state; verify in the visible window" };
  },

  async detectBlock(page: Page): Promise<BlockState> {
    for (const marker of PDD_SELECTORS.blockMarkers) {
      const visible = await countVisibleMarkers(page, [marker]);
      if (visible > 0) {
        return { blocked: true, kind: "captcha", detail: `visible marker "${marker}"` };
      }
    }
    return { blocked: false, kind: "unknown", detail: "no visible block markers" };
  },

  async collectVisibleOrders(
    page: Page,
    options: CollectOptions = {},
  ): Promise<OrderListState> {
    const emptyCount = await countVisibleMarkers(page, PDD_SELECTORS.emptyMarkers);
    const cards = await findCardLocators(page);
    if (cards.length === 0) {
      return { orders: [], empty: emptyCount > 0, rows_seen: 0, recognized: 0, unparsed: [] };
    }
    const skip = options.skip_order_ids ?? new Set<string>();
    const orders: RawOrder[] = [];
    const unparsed: UnparsedCard[] = [];
    let rowsSeen = 0;
    let recognized = 0;
    for (const card of cards) {
      const platformOrderId = await extractFieldValue(card, ORDER_ID_LABELS, PDD_SELECTORS.fieldSelectors.orderId);
      if (platformOrderId !== null && platformOrderId.length > 0 && skip.has(platformOrderId.trim())) {
        continue;
      }
      rowsSeen += 1;
      if (
        platformOrderId === null ||
        platformOrderId.length === 0 ||
        !/\d/.test(platformOrderId)
      ) {
        unparsed.push({
          locator: card,
          missing: ["order_id"],
          hint: "card has no readable order id",
        });
        continue;
      }
      recognized += 1;

      const { packages, unreadable } = await extractPackages(card);
      orders.push({
        platform_order_id: platformOrderId,
        ordered_at: await extractFieldValue(card, TIME_LABELS, PDD_SELECTORS.fieldSelectors.time),
        status: await extractFieldValue(card, STATUS_LABELS, PDD_SELECTORS.fieldSelectors.status),
        shop_name: await extractFieldValue(card, SHOP_LABELS, PDD_SELECTORS.fieldSelectors.shop),
        items: await extractItems(card),
        packages,
        observed_at: new Date().toISOString(),
        source_page: 0,
      });
      if (unreadable) {
        unparsed.push({
          locator: card,
          missing: ["logistics"],
          hint: "tracking text exists but cannot be parsed",
        });
      }
    }
    return {
      orders: mergeRawOrdersByOrderId(orders),
      empty: false,
      rows_seen: rowsSeen,
      recognized,
      unparsed,
    };
  },

  async readOrderDetail(page: Page, card: UnparsedCard): Promise<RawOrder | null> {
    try {
      const link = card.locator.locator("a").first();
      if ((await link.count()) > 0) {
        await link.click({ timeout: 5000 });
      } else {
        await card.locator.click({ timeout: 5000 });
      }
    } catch {
      return null;
    }
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(1000);

    const body = page.locator("body");
    const platformOrderId = await extractLabelValue(body, ORDER_ID_LABELS);
    const { packages } = await extractPackages(body);
    const detail: RawOrder = {
      platform_order_id: platformOrderId,
      ordered_at: await extractLabelValue(body, TIME_LABELS),
      status: await extractLabelValue(body, STATUS_LABELS),
      shop_name: await extractLabelValue(body, SHOP_LABELS),
      items: await extractItems(body),
      packages,
      observed_at: new Date().toISOString(),
      source_page: 0,
    };

    try {
      await page.goBack({ timeout: 5000 });
    } catch {
      return null;
    }
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(1000);
    if ((await findCardLocators(page)).length === 0) {
      return null;
    }
    return detail;
  },

  async advancePage(page: Page): Promise<boolean> {
    for (const selector of PDD_SELECTORS.nextPage) {
      const button = page.locator(selector).first();
      if ((await button.count()) === 0) continue;
      if (!(await button.isVisible({ timeout: 500 }).catch(() => false))) continue;
      if (!(await button.isEnabled({ timeout: 500 }).catch(() => false))) continue;
      try {
        await button.click({ timeout: 5000 });
      } catch {
        return false;
      }
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await page.waitForTimeout(2000);
      return true;
    }
    return false;
  },
};
