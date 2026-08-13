import type { Locator, Page } from "playwright";

import { cleanText, stripLabelPrefix } from "../extract/text.js";
import type { RawOrder, RawOrderItem, RawOrderPackage, StatusMap } from "../extract/order.js";
import type {
  BlockState,
  LoginState,
  OrderListState,
  PlatformAdapter,
  SyncWindow,
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

const TRACKING_CANDIDATE = /[A-Za-z0-9-]{6,}/;

export function splitLogisticsCell(text: string): { courier: string | null; tracking: string | null } {
  const cleaned = cleanText(text);
  if (cleaned.length === 0) return { courier: null, tracking: null };
  const trackingMatch = TRACKING_CANDIDATE.exec(cleaned);
  if (trackingMatch === null) return { courier: cleaned, tracking: null };
  const tracking = trackingMatch[0] ?? "";
  const hasLettersAndDigits = /[A-Za-z]/.test(tracking) && /\d/.test(tracking);
  if (!hasLettersAndDigits) return { courier: cleaned, tracking: null };
  const courier = cleaned.replace(tracking, " ").trim();
  return { courier: courier.length > 0 ? courier : null, tracking };
}

async function extractLabelValue(
  container: Locator,
  labels: readonly string[],
): Promise<string | null> {
  for (const label of labels) {
    const marker = container.locator(`:has-text("${label}")`).first();
    if ((await marker.count()) === 0) continue;
    const ownText = await marker.innerText().catch(() => "");
    const stripped = stripLabelPrefix(ownText, [label]);
    if (stripped.length > 0) return stripped;
    const siblingText = await marker
      .locator("xpath=following-sibling::*[1]")
      .first()
      .innerText()
      .catch(() => "");
    if (siblingText.trim().length > 0) return siblingText.trim();
  }
  return null;
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

  async openOrders(page: Page, _window: SyncWindow): Promise<void> {
    await page.goto(this.orderListUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
  },

  async detectLogin(page: Page): Promise<LoginState> {
    let loginMarkers = 0;
    for (const marker of ALI1688_SELECTORS.loginMarkers) {
      loginMarkers += await page.locator(marker).count().catch(() => 0);
    }
    const rows = (await findRowLocators(page)).length;
    if (loginMarkers > 0 && rows === 0) {
      return { logged_in: false, detail: "login form detected on the order page" };
    }
    if (rows > 0) {
      return { logged_in: true, detail: `order rows visible (${rows})` };
    }
    return { logged_in: false, detail: "no order rows and no clear login state; verify in the visible window" };
  },

  async detectBlock(page: Page): Promise<BlockState> {
    for (const marker of ALI1688_SELECTORS.blockMarkers) {
      const count = await page.locator(marker).count().catch(() => 0);
      if (count > 0) {
        return { blocked: true, kind: "captcha", detail: `marker "${marker}" visible` };
      }
    }
    return { blocked: false, kind: "unknown", detail: "no block markers visible" };
  },

  async collectVisibleOrders(page: Page): Promise<OrderListState> {
    let emptyCount = 0;
    for (const marker of ALI1688_SELECTORS.emptyMarkers) {
      emptyCount += await page.locator(marker).count().catch(() => 0);
    }
    const rows = await findRowLocators(page);
    if (rows.length === 0) {
      return { orders: [], empty: emptyCount > 0, rows_seen: 0, recognized: 0 };
    }
    const columns = await detectColumns(page);
    const orders: RawOrder[] = [];
    let recognized = 0;
    for (const row of rows) {
      const platformOrderId =
        columns === null || columns["order_id"] === undefined
          ? await extractLabelValue(row, ORDER_ID_LABELS)
          : await cellText(row, columns["order_id"]);
      if (platformOrderId === null || platformOrderId.length === 0) continue;
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
      let tracking: string | null = await field("tracking", TRACKING_LABELS);
      if ((courier === null || tracking === null) && columns !== null && columns["logistics"] !== undefined) {
        const logisticsText = await cellText(row, columns["logistics"]);
        if (logisticsText !== null && logisticsText.length > 0) {
          const split = splitLogisticsCell(logisticsText);
          courier = courier ?? split.courier;
          tracking = tracking ?? split.tracking;
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
      orders.push({
        platform_order_id: platformOrderId,
        ordered_at: await field("time", TIME_LABELS),
        status: await field("status", STATUS_LABELS),
        shop_name: await field("shop", SHOP_LABELS),
        items: title === null ? emptyItemList() : items,
        packages,
        observed_at: new Date().toISOString(),
        source_page: 0,
      });
    }
    return { orders, empty: false, rows_seen: rows.length, recognized };
  },

  async advancePage(page: Page): Promise<boolean> {
    for (const selector of ALI1688_SELECTORS.nextPage) {
      const button = page.locator(selector).first();
      if ((await button.count()) === 0) continue;
      if (!(await button.isEnabled().catch(() => false))) continue;
      await button.click({ timeout: 5000 }).catch(() => undefined);
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await page.waitForTimeout(2000);
      return true;
    }
    return false;
  },
};
