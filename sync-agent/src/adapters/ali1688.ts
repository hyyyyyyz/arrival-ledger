import type { Locator, Page } from "playwright";

import { assertAllowedOrderListUrl } from "../browser/context.js";
import { countVisibleMarkers, extractLabelValue } from "../browser/dom.js";
import { cleanText } from "../extract/text.js";
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

export const ALI1688_SELECTORS = {
  orderRows: [
    "[data-order-id]",
    "[class*='order-card']",
    "table.trade-order-list tbody tr",
    "[class*='order'] tbody tr",
  ],
  nextPage: [
    "a[class*='next']:not([class*='disabled'])",
    "button:has-text('下一页')",
    "a:has-text('下一页')",
  ],
  loginMarkers: ["input[type='password']", "text=亲，请登录", "text=扫码登录"],
  blockMarkers: [
    "iframe[src*='captcha']",
    "iframe[src*='punish']",
    "text=安全验证",
    "text=滑动验证",
    "text=拖动滑块",
    "text=验证码",
    "text=风险",
  ],
  emptyMarkers: ["text=暂无订单", "text=没有订单", "text=暂无数据"],
} as const;

export const ALI1688_STATUS_MAP: StatusMap = {
  待付款: "PENDING",
  等待买家付款: "PENDING",
  待发货: "PAID",
  待卖家发货: "PAID",
  已发货: "SHIPPED",
  运输中: "SHIPPED",
  待收货: "SHIPPED",
  已收货: "COMPLETED",
  交易成功: "COMPLETED",
  退款成功: "REFUNDED",
  退款中: "REFUNDED",
  交易关闭: "CANCELLED",
  已取消: "CANCELLED",
  订单关闭: "CANCELLED",
};

const ORDER_ID_LABELS = ["订单号", "订单编号"];
const TIME_LABELS = ["下单时间", "成交时间", "创建时间"];
const STATUS_LABELS = ["订单状态", "状态"];
const SHOP_LABELS = ["供应商", "店铺", "卖家"];
const COURIER_LABELS = ["物流公司", "快递公司", "承运商"];
const TRACKING_LABELS = ["运单号", "物流单号", "快递单号"];
const TITLE_LABELS = ["货品", "商品名称", "产品", "宝贝"];
const SKU_LABELS = ["规格", "型号"];
const QUANTITY_LABELS = ["数量", "件数"];
const PRICE_LABELS = ["单价", "金额"];
const LOGISTICS_LABELS = ["物流", "物流信息"];

type ColumnName =
  | "order_id"
  | "title"
  | "sku"
  | "quantity"
  | "price"
  | "shop"
  | "time"
  | "status"
  | "courier"
  | "tracking"
  | "logistics";

type ColumnMap = Partial<Record<ColumnName, number>>;

function matchColumn(header: string): ColumnName | null {
  const cleaned = cleanText(header);
  if (ORDER_ID_LABELS.some((label) => cleaned.includes(label))) return "order_id";
  if (TITLE_LABELS.some((label) => cleaned.includes(label))) return "title";
  if (SKU_LABELS.some((label) => cleaned.includes(label))) return "sku";
  if (QUANTITY_LABELS.some((label) => cleaned.includes(label))) return "quantity";
  if (PRICE_LABELS.some((label) => cleaned.includes(label))) return "price";
  if (SHOP_LABELS.some((label) => cleaned.includes(label))) return "shop";
  if (TIME_LABELS.some((label) => cleaned.includes(label))) return "time";
  if (STATUS_LABELS.some((label) => cleaned.includes(label))) return "status";
  if (COURIER_LABELS.some((label) => cleaned.includes(label))) return "courier";
  if (TRACKING_LABELS.some((label) => cleaned.includes(label))) return "tracking";
  if (LOGISTICS_LABELS.some((label) => cleaned.includes(label))) return "logistics";
  return null;
}

async function detectColumns(page: Page): Promise<ColumnMap | null> {
  const headerRow = page.locator("thead tr").first();
  if ((await headerRow.count()) === 0) return null;
  const cells = headerRow.locator("th");
  const count = await cells.count();
  if (count === 0) return null;
  const map: ColumnMap = {};
  for (let index = 0; index < count; index += 1) {
    const header = await cells.nth(index).innerText().catch(() => "");
    const column = matchColumn(header);
    if (column !== null && map[column] === undefined) {
      map[column] = index;
    }
  }
  if (map["order_id"] === undefined) return null;
  return map;
}

async function cellText(row: Locator, index: number): Promise<string | null> {
  const cells = row.locator("td");
  const count = await cells.count();
  if (index >= count) return null;
  const text = await cells.nth(index).innerText().catch(() => "");
  return text.trim();
}

async function findRowLocators(page: Page): Promise<Locator[]> {
  for (const selector of ALI1688_SELECTORS.orderRows) {
    const rows = page.locator(selector);
    const count = await rows.count().catch(() => 0);
    if (count > 0) {
      const list: Locator[] = [];
      for (let index = 0; index < count; index += 1) list.push(rows.nth(index));
      return list;
    }
  }
  return [];
}

function emptyItemList(): RawOrderItem[] {
  return [{ item_key: null, title: null, sku_text: null, quantity: null, unit_price: null }];
}

export const ali1688Adapter: PlatformAdapter = {
  platform: "1688",
  orderListUrl: "https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html",
  statusMap: ALI1688_STATUS_MAP,

  async openOrders(page: Page, window: SyncWindow): Promise<void> {
    const url = window.order_list_url ?? this.orderListUrl;
    assertAllowedOrderListUrl(this.platform, url);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
  },

  async detectLogin(page: Page): Promise<LoginState> {
    const emptyCount = await countVisibleMarkers(page, ALI1688_SELECTORS.emptyMarkers);
    const loginMarkers = await countVisibleMarkers(page, ALI1688_SELECTORS.loginMarkers);
    const rows = (await findRowLocators(page)).length;
    if (emptyCount > 0 && rows === 0) {
      return { logged_in: true, detail: "order list is empty but the account appears logged in" };
    }
    if (loginMarkers > 0 && rows === 0) {
      return { logged_in: false, detail: "visible login form detected on the order page" };
    }
    if (rows > 0) {
      return { logged_in: true, detail: `order rows visible (${rows})` };
    }
    return { logged_in: false, detail: "no order rows and no clear login state; verify in the visible window" };
  },

  async detectBlock(page: Page): Promise<BlockState> {
    for (const marker of ALI1688_SELECTORS.blockMarkers) {
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
    const emptyCount = await countVisibleMarkers(page, ALI1688_SELECTORS.emptyMarkers);
    const rows = await findRowLocators(page);
    if (rows.length === 0) {
      return { orders: [], empty: emptyCount > 0, rows_seen: 0, recognized: 0, unparsed: [] };
    }
    const skip = options.skip_order_ids ?? new Set<string>();
    const columns = await detectColumns(page);
    const orders: RawOrder[] = [];
    const unparsed: UnparsedCard[] = [];
    let rowsSeen = 0;
    let recognized = 0;
    for (const row of rows) {
      const platformOrderId =
        columns === null || columns["order_id"] === undefined
          ? await extractLabelValue(row, ORDER_ID_LABELS)
          : await cellText(row, columns["order_id"]);
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
          locator: row,
          missing: ["order_id"],
          hint: "row has no readable order id",
        });
        continue;
      }
      recognized += 1;

      const cell = (name: ColumnName): Promise<string | null> =>
        columns !== null && columns[name] !== undefined
          ? cellText(row, columns[name]!)
          : Promise.resolve(null);
      const field = (name: ColumnName, labels: readonly string[]): Promise<string | null> =>
        columns === null || columns[name] === undefined
          ? extractLabelValue(row, labels)
          : cell(name);

      let courier: string | null = await field("courier", COURIER_LABELS);
      const trackingRaw: string | null = await field("tracking", TRACKING_LABELS);
      let tracking = trackingRaw === null ? null : trackingFromLabeledText(trackingRaw);
      let logisticsUnreadable =
        trackingRaw !== null && trackingRaw.trim().length > 0 && tracking === null;
      if ((courier === null || tracking === null) && columns !== null && columns["logistics"] !== undefined) {
        const logisticsText = await cellText(row, columns["logistics"]);
        if (logisticsText !== null && logisticsText.length > 0) {
          const split = splitLogisticsCell(logisticsText);
          courier = courier ?? split.courier;
          tracking = tracking ?? split.tracking;
          if (
            split.tracking === null &&
            /运单号|物流单号|快递单号/.test(logisticsText) &&
            !/无|暂无|-{1,2}\s*$/.test(logisticsText)
          ) {
            logisticsUnreadable = true;
          }
        }
      }

      const title = await field("title", TITLE_LABELS);
      const items: RawOrderItem[] = [
        {
          item_key: null,
          title,
          sku_text: await field("sku", SKU_LABELS),
          quantity: (await field("quantity", QUANTITY_LABELS)) ?? "1",
          unit_price: await field("price", PRICE_LABELS),
        },
      ];
      const packages: RawOrderPackage[] =
        tracking === null ? [] : [{ courier, tracking_no: tracking, status: null }];
      const raw: RawOrder = {
        platform_order_id: platformOrderId,
        ordered_at: await field("time", TIME_LABELS),
        status: await field("status", STATUS_LABELS),
        shop_name: await field("shop", SHOP_LABELS),
        items: title === null ? emptyItemList() : items,
        packages,
        observed_at: new Date().toISOString(),
        source_page: 0,
      };
      orders.push(raw);
      if (logisticsUnreadable) {
        unparsed.push({
          locator: row,
          missing: ["logistics"],
          hint: "tracking cell has unreadable content",
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
    const title = await extractLabelValue(body, TITLE_LABELS);
    const courier = await extractLabelValue(body, COURIER_LABELS);
    const trackingRaw = await extractLabelValue(body, TRACKING_LABELS);
    const tracking = trackingRaw === null ? null : trackingFromLabeledText(trackingRaw);
    const detail: RawOrder = {
      platform_order_id: platformOrderId,
      ordered_at: await extractLabelValue(body, TIME_LABELS),
      status: await extractLabelValue(body, STATUS_LABELS),
      shop_name: await extractLabelValue(body, SHOP_LABELS),
      items: [
        {
          item_key: null,
          title,
          sku_text: await extractLabelValue(body, SKU_LABELS),
          quantity: (await extractLabelValue(body, QUANTITY_LABELS)) ?? "1",
          unit_price: await extractLabelValue(body, PRICE_LABELS),
        },
      ],
      packages: tracking === null ? [] : [{ courier, tracking_no: tracking, status: null }],
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
    if ((await findRowLocators(page)).length === 0) {
      return null;
    }
    return detail;
  },

  async advancePage(page: Page): Promise<boolean> {
    for (const selector of ALI1688_SELECTORS.nextPage) {
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
