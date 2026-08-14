import type { Locator, Page } from "playwright";

import { assertAllowedOrderListUrl } from "../browser/context.js";
import {
  findDetailLink,
  isOfficialHttpsUrl,
  openDetailTarget,
  sameListUrl,
  type DetailLinkRules,
} from "../browser/detail.js";
import {
  countVisible,
  countVisibleMarkers,
  extractFieldValue,
  extractFieldValueStructuralFirst,
  extractLabelValue,
  innermostContainers,
  nearestPrecedingByClass,
} from "../browser/dom.js";
import { parseDetailLogistics, type LogisticsSelectors } from "../browser/logistics.js";
import { cleanText } from "../extract/text.js";
import {
  mergeRawOrdersByOrderId,
  type RawOrder,
  type RawOrderItem,
  type RawOrderPackage,
  type StatusMap,
} from "../extract/order.js";
import { splitLogisticsCell, trackingFromLabeledText, normalizeTrackingNo } from "../extract/tracking.js";
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
    "text=风险",
  ],
  busyMarkers: [
    "text=系统繁忙",
    "text=刷新试试",
    "text=访问受限",
    "text=操作过于频繁",
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

const ORDER_ID_PATTERN = /(?:订单号|订单编号)\s*[:：]?\s*([A-Za-z0-9-]{8,64})/g;
const DATETIME_PATTERN = /\b(20\d{2}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\b/;
const CARD_ACTION_PATTERN = /订单详情|再次购买|申请退款|确认收货|提醒发货|找同款|售后详情/;
const STATUS_PRIORITY = [
  "等待买家付款",
  "待付款",
  "待卖家发货",
  "待发货",
  "待收货",
  "退款中",
  "退款成功",
  "交易关闭",
  "订单关闭",
  "已取消",
  "交易成功",
  "已收货",
  "运输中",
  "已发货",
] as const;

const ALI1688_CARD_FIELD_SELECTORS = {
  title: [
    "[class*='item-title']",
    "[class*='goods-name']",
    "[class*='product-name']",
    "[class*='offer-title']",
    "a[href*='offer']",
  ],
  sku: ["[class*='item-sku']", "[class*='goods-sku']", "[class*='spec']"],
  quantity: ["[class*='item-quantity']", "[class*='goods-count']", "[class*='quantity']"],
  price: ["[class*='item-price']", "[class*='goods-price']", "[class*='unit-price']"],
  shop: [
    "[class*='seller-name']",
    "[class*='shop-name']",
    "[class*='company-name']",
    "a[href*='winport.1688.com']",
  ],
} as const;

function orderIdsFromText(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(ORDER_ID_PATTERN)) {
    const value = match[1]?.trim();
    if (value !== undefined && /\d/.test(value) && !ids.includes(value)) ids.push(value);
  }
  return ids;
}

async function orderIdsFromContainer(container: Locator): Promise<string[]> {
  const ids: string[] = [];
  const directTexts = await container
    .evaluate((element) => {
      const own = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join(" ");
      const leaves = Array.from(element.querySelectorAll("*"))
        .filter((child) => child.children.length === 0)
        .map((child) => child.textContent ?? "");
      return [own, ...leaves];
    })
    .catch(() => [] as string[]);
  for (const text of directTexts) {
    for (const id of orderIdsFromText(text)) {
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

async function visibleText(locator: Locator): Promise<string> {
  return (await locator.innerText().catch(() => "")).trim();
}

async function exactVisibleText(container: Locator, values: readonly string[]): Promise<string | null> {
  for (const value of values) {
    const found = container.getByText(value, { exact: true });
    const count = await found.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      if (await found.nth(index).isVisible({ timeout: 250 }).catch(() => false)) return value;
    }
  }
  return null;
}

async function firstVisibleField(
  container: Locator,
  selectors: readonly string[],
): Promise<string | null> {
  for (const selector of selectors) {
    const found = container.locator(selector);
    const count = await found.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = found.nth(index);
      if (!(await candidate.isVisible({ timeout: 250 }).catch(() => false))) continue;
      const text = await visibleText(candidate);
      if (text.length > 0 && !CARD_ACTION_PATTERN.test(text)) return text;
    }
  }
  return null;
}

async function firstPrefixedLeaf(
  container: Locator,
  labels: readonly string[],
): Promise<string | null> {
  const leaves = container.locator("xpath=.//*[not(*)]");
  const count = await leaves.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const leaf = leaves.nth(index);
    if (!(await leaf.isVisible({ timeout: 250 }).catch(() => false))) continue;
    const text = await visibleText(leaf);
    if (labels.some((label) => new RegExp(`^${label}\\s*[:：]`).test(text))) return text;
  }
  return null;
}

async function firstLeafMatching(container: Locator, pattern: RegExp): Promise<string | null> {
  const leaves = container.locator("xpath=.//*[not(*)]");
  const count = await leaves.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const leaf = leaves.nth(index);
    if (!(await leaf.isVisible({ timeout: 250 }).catch(() => false))) continue;
    const text = await visibleText(leaf);
    if (pattern.test(text)) return text;
  }
  return null;
}

async function uniqueStandaloneQuantity(container: Locator): Promise<string | null> {
  const leaves = container.locator("xpath=.//*[not(*)]");
  const count = await leaves.count().catch(() => 0);
  const explicit: string[] = [];
  const plain: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const leaf = leaves.nth(index);
    if (!(await leaf.isVisible({ timeout: 250 }).catch(() => false))) continue;
    const text = await visibleText(leaf);
    if (/^[xX×]\s*\d{1,6}$/.test(text)) explicit.push(text);
    else if (/^\d{1,6}$/.test(text)) plain.push(text);
  }
  const candidates = explicit.length > 0 ? explicit : plain;
  return candidates.length === 1 ? candidates[0]! : null;
}

async function extractSemanticCardItems(row: Locator): Promise<RawOrderItem[]> {
  const titleLinks = row.locator("a[href*='offer']");
  const count = await titleLinks.count().catch(() => 0);
  const candidates: Array<{ locator: Locator; title: string }> = [];
  const seen = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const titleLink = titleLinks.nth(index);
    if (!(await titleLink.isVisible({ timeout: 250 }).catch(() => false))) continue;
    const title = await visibleText(titleLink);
    if (title.length === 0 || CARD_ACTION_PATTERN.test(title)) continue;
    const href = (await titleLink.getAttribute("href")) ?? "";
    const key = `${href}\u0000${cleanText(title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ locator: titleLink, title });
  }

  const items: RawOrderItem[] = [];
  for (const candidate of candidates) {
    const { locator: titleLink, title } = candidate;

    let itemRoot = titleLink;
    for (let depth = 0; depth < 6; depth += 1) {
      const offers = itemRoot.locator("a[href*='offer']");
      const offerCount = await offers.count().catch(() => 0);
      if (offerCount === 1) {
        const text = await visibleText(itemRoot);
        if (/规格\s*[:：]|型号\s*[:：]|颜色\s*[:：]|尺码\s*[:：]|[xX×]\s*\d|[¥￥]\s*\d/.test(text)) {
          break;
        }
      }
      const parent = itemRoot.locator("xpath=..");
      if ((await parent.count().catch(() => 0)) === 0) break;
      itemRoot = parent;
    }
    const quantity =
      (await uniqueStandaloneQuantity(itemRoot)) ??
      (candidates.length === 1 ? await uniqueStandaloneQuantity(row) : null);
    items.push({
      item_key: null,
      title,
      sku_text: await firstPrefixedLeaf(itemRoot, ["规格", "型号", "颜色", "尺码"]),
      quantity,
      unit_price:
        (await firstVisibleField(itemRoot, ALI1688_CARD_FIELD_SELECTORS.price)) ??
        (await firstLeafMatching(itemRoot, /^[¥￥]\s*\d+(?:\.\d{1,2})?$/)),
    });
  }
  return items;
}

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
  if (!(await cells.nth(index).isVisible({ timeout: 500 }).catch(() => false))) {
    return null;
  }
  const text = await cells.nth(index).innerText().catch(() => "");
  return text.trim();
}

async function findRowLocators(page: Page): Promise<Locator[]> {
  for (const selector of ALI1688_SELECTORS.orderRows) {
    const rows = page.locator(selector);
    const count = await rows.count().catch(() => 0);
    const visible: Locator[] = [];
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      if (!(await row.isVisible({ timeout: 500 }).catch(() => false))) continue;
      const ids = await orderIdsFromContainer(row);
      // A broad wrapper around the whole list is not an order card.
      if (ids.length > 1) continue;
      // Class names containing "order" are not a stable card contract.  A
      // zero-ID class candidate may be a list root or an action panel, and
      // returning it here would prevent the semantic order-label fallback.
      // Legacy table rows and explicit data-order-id cards remain supported.
      const tagName = await row.evaluate((element) => element.tagName.toLowerCase());
      const explicitOrderId = await row.getAttribute("data-order-id");
      if (ids.length === 0 && tagName !== "tr" && explicitOrderId === null) continue;
      visible.push(row);
    }
    if (visible.length > 0) return visible;
  }

  // The current buyer-order UI is card based and does not expose a stable
  // table/class contract. Locate a visible order-id label and walk only as far
  // as the smallest ancestor that contains one order plus status/action
  // evidence. This deliberately refuses a list root containing many orders.
  const anchors = page.getByText(
    /(?:订单号|订单编号)\s*[:：]?\s*[A-Za-z0-9-]{8,64}/,
  );
  const anchorCount = await anchors.count().catch(() => 0);
  const semantic: Locator[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < anchorCount; index += 1) {
    const anchor = anchors.nth(index);
    if (!(await anchor.isVisible({ timeout: 250 }).catch(() => false))) continue;
    let candidate = anchor;
    for (let depth = 0; depth < 9; depth += 1) {
      const text = await visibleText(candidate);
      const ids = await orderIdsFromContainer(candidate);
      const hasStatus = STATUS_PRIORITY.some((status) => text.includes(status));
      const hasCardEvidence = CARD_ACTION_PATTERN.test(text) || /规格\s*[:：]|[¥￥]\s*\d|数量/.test(text);
      if (ids.length === 1 && hasStatus && hasCardEvidence) {
        const id = ids[0]!;
        if (!seen.has(id)) {
          seen.add(id);
          semantic.push(candidate);
        }
        break;
      }
      if (ids.length > 1) break;
      candidate = candidate.locator("xpath=..");
      if ((await candidate.count().catch(() => 0)) === 0) break;
    }
  }
  if (semantic.length > 0) return semantic;
  return [];
}

function emptyItemList(): RawOrderItem[] {
  return [{ item_key: null, title: null, sku_text: null, quantity: null, unit_price: null }];
}

export const ALI1688_DETAIL_RULES: DetailLinkRules = {
  textPatterns: [/订单详情/, /查看订单详情/, /查看订单/],
  hrefPatterns: [/order[-_]?detail/i],
  excludeTextPatterns: [/退款|售后|物流|^商品|宝贝|货品|链接$/],
  excludeHrefPatterns: [/refund|after[-_ ]?sale|logistic|track|item|product|goods|sku|offer|login/i],
  allowedHostSuffix: "1688.com",
};

export const ALI1688_DETAIL_SELECTORS = {
  itemTitle: ["[class*='item-title']", "[class*='goods-name']"],
  itemSku: ["[class*='item-sku']", "[class*='goods-sku']"],
  itemQuantity: ["[class*='item-quantity']", "[class*='goods-count']"],
  itemPrice: ["[class*='item-price']", "[class*='goods-price']"],
  trackingNo: ["[class*='tracking-no']", "[class*='tracking-number']"],
} as const;

export const ALI1688_ITEM_CONTAINER_SELECTORS = [
  "[class*='item-line']",
  "[class*='goods-item']",
  "[class*='item-row']",
  "[class*='product-item']",
  "[class*='offer-item']",
] as const;

export const ALI1688_DETAIL_ITEM_GROUP_SELECTORS = [
  "[class*='item-group']",
  "[class*='goods-item']",
  "[class*='item-line']",
] as const;

export const ALI1688_PACKAGE_CONTAINER_SELECTORS = [
  "[class*='logistics']",
  "[class*='tracking']",
  "[class*='package']",
] as const;

export const ALI1688_DETAIL_PACKAGE_GROUP_SELECTORS = [
  "[class*='package-group']",
  "[class*='logistics-group']",
] as const;

async function extractDetailItems(body: Locator): Promise<RawOrderItem[]> {
  const containers = await innermostContainers(body, ALI1688_DETAIL_ITEM_GROUP_SELECTORS);
  const items: RawOrderItem[] = [];
  for (const container of containers) {
    const title = await extractFieldValue(container, TITLE_LABELS, ALI1688_DETAIL_SELECTORS.itemTitle);
    if (title === null) continue;
    items.push({
      item_key: null,
      title,
      sku_text: await extractFieldValueStructuralFirst(container, SKU_LABELS, ALI1688_DETAIL_SELECTORS.itemSku),
      quantity:
        await extractFieldValueStructuralFirst(
          container,
          QUANTITY_LABELS,
          ALI1688_DETAIL_SELECTORS.itemQuantity,
        ),
      unit_price: await extractFieldValueStructuralFirst(
        container,
        PRICE_LABELS,
        ALI1688_DETAIL_SELECTORS.itemPrice,
      ),
    });
  }
  if (items.length > 0) return items;
  const single = await extractLabelValue(body, TITLE_LABELS);
  if (single === null) {
    return [{ item_key: null, title: null, sku_text: null, quantity: null, unit_price: null }];
  }
  return [
    {
      item_key: null,
      title: single,
      sku_text: await extractLabelValue(body, SKU_LABELS),
      quantity: await extractLabelValue(body, QUANTITY_LABELS),
      unit_price: await extractLabelValue(body, PRICE_LABELS),
    },
  ];
}

export const ALI1688_LOGISTICS_SELECTORS: LogisticsSelectors = {
  containerSelectors: ALI1688_DETAIL_PACKAGE_GROUP_SELECTORS,
  courierLabels: COURIER_LABELS,
  trackingLabels: TRACKING_LABELS,
};

export const ali1688Adapter: PlatformAdapter = {
  platform: "1688",
  orderListUrl: "https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html",
  statusMap: ALI1688_STATUS_MAP,
  // Opening a 1688 detail/action surface has triggered an additional human
  // verification in real testing. Keep automatic runs on the list page.
  allowDetailNavigation: false,

  async openOrders(page: Page, window: SyncWindow): Promise<void> {
    const url = window.order_list_url ?? this.orderListUrl;
    assertAllowedOrderListUrl(this.platform, url);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    // Wait on this single navigation for the SPA to paint an order surface.
    // Never reload or retry here: one invocation means one list-page request.
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if ((await findRowLocators(page)).length > 0) break;
      const markers = await countVisibleMarkers(page, [
        ...ALI1688_SELECTORS.emptyMarkers,
        ...ALI1688_SELECTORS.loginMarkers,
        ...ALI1688_SELECTORS.blockMarkers,
        ...ALI1688_SELECTORS.busyMarkers,
      ]);
      if (markers > 0) break;
      await page.waitForTimeout(400);
    }
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
    for (const frame of page.frames()) {
      const frameUrl = frame.url().toLowerCase();
      if (frameUrl.includes("captcha") || frameUrl.includes("punish")) {
        const frameElement = await frame.frameElement().catch(() => null);
        if (
          frameElement !== null &&
          !(await frameElement.isVisible().catch(() => false))
        ) {
          continue;
        }
        return {
          blocked: true,
          kind: "captcha",
          detail: "visible security-verification frame detected",
        };
      }
    }
    for (const marker of ALI1688_SELECTORS.busyMarkers) {
      const visible = await countVisibleMarkers(page, [marker]);
      if (visible > 0) {
        return { blocked: true, kind: "risk", detail: `visible busy/risk marker "${marker}"` };
      }
    }
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
      const rowText = await visibleText(row);
      const platformOrderId =
        columns === null || columns["order_id"] === undefined
          ? (await orderIdsFromContainer(row))[0] ??
            (await row.getAttribute("data-order-id")) ??
            (await extractLabelValue(row, ORDER_ID_LABELS))
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

      const statusText =
        columns === null || columns["status"] === undefined
          ? (await exactVisibleText(row, STATUS_PRIORITY)) ?? (await extractLabelValue(row, STATUS_LABELS))
          : await cell("status");
      const orderedAt =
        columns === null || columns["time"] === undefined
          ? rowText.match(DATETIME_PATTERN)?.[1] ?? (await extractLabelValue(row, TIME_LABELS))
          : await cell("time");
      const shopName =
        columns === null || columns["shop"] === undefined
          ? (await firstVisibleField(row, ALI1688_CARD_FIELD_SELECTORS.shop)) ??
            (await extractLabelValue(row, SHOP_LABELS))
          : await cell("shop");

      const trackingColumnRaw: string | null = await field("tracking", TRACKING_LABELS);
      let logisticsUnreadable =
        trackingColumnRaw !== null &&
        trackingColumnRaw.trim().length > 0 &&
        trackingFromLabeledText(trackingColumnRaw) === null;

      const packages: RawOrderPackage[] = [];
      const packageSeen = new Set<string>();
      const packageContainers = await innermostContainers(row, ALI1688_PACKAGE_CONTAINER_SELECTORS);
      for (const container of packageContainers) {
        let containerCourier = await extractLabelValue(container, COURIER_LABELS);
        const labeled = await extractLabelValue(container, TRACKING_LABELS);
        if (labeled !== null) {
          const parsed = trackingFromLabeledText(labeled);
          if (parsed !== null) {
            const key = normalizeTrackingNo(parsed);
            if (!packageSeen.has(key)) {
              if (containerCourier === null) {
                const preceding = await nearestPrecedingByClass(container, ["courier", "logistics", "express"]);
                if (preceding !== null) {
                  containerCourier = (await preceding.innerText().catch(() => "")).trim() || null;
                }
              }
              packageSeen.add(key);
              packages.push({ courier: containerCourier, tracking_no: parsed, status: null });
            }
          } else {
            logisticsUnreadable = true;
          }
          continue;
        }
        const containerText = await container.innerText().catch(() => "");
        const split = splitLogisticsCell(containerText);
        if (split.tracking !== null) {
          const key = normalizeTrackingNo(split.tracking);
          if (!packageSeen.has(key)) {
            if (containerCourier === null && split.courier === null) {
              const preceding = await nearestPrecedingByClass(container, ["courier", "logistics", "express"]);
              if (preceding !== null) {
                containerCourier = (await preceding.innerText().catch(() => "")).trim() || null;
              }
            }
            packageSeen.add(key);
            packages.push({ courier: containerCourier ?? split.courier, tracking_no: split.tracking, status: null });
          }
        }
      }
      if (packages.length === 0) {
        const columnCourier: string | null = await field("courier", COURIER_LABELS);
        const trackingRaw: string | null = await field("tracking", TRACKING_LABELS);
        let tracking = trackingRaw === null ? null : trackingFromLabeledText(trackingRaw);
        logisticsUnreadable =
          logisticsUnreadable ||
          (trackingRaw !== null && trackingRaw.trim().length > 0 && tracking === null);
        if ((columnCourier === null || tracking === null) && columns !== null && columns["logistics"] !== undefined) {
          const logisticsText = await cellText(row, columns["logistics"]);
          if (logisticsText !== null && logisticsText.length > 0) {
            const split = splitLogisticsCell(logisticsText);
            const mergedCourier = columnCourier ?? split.courier;
            tracking = tracking ?? split.tracking;
            if (
              split.tracking !== null &&
              tracking !== null &&
              !packageSeen.has(normalizeTrackingNo(tracking))
            ) {
              packageSeen.add(normalizeTrackingNo(tracking));
              packages.push({ courier: mergedCourier, tracking_no: tracking, status: null });
            }
            if (
              split.tracking === null &&
              /运单号|物流单号|快递单号/.test(logisticsText) &&
              !/无|暂无|-{1,2}\s*$/.test(logisticsText)
            ) {
              logisticsUnreadable = true;
            }
          }
        } else if (tracking !== null && !packageSeen.has(normalizeTrackingNo(tracking))) {
          packageSeen.add(normalizeTrackingNo(tracking));
          packages.push({ courier: columnCourier, tracking_no: tracking, status: null });
        }
      }

      const itemContainers = await innermostContainers(row, ALI1688_ITEM_CONTAINER_SELECTORS);
      let items: RawOrderItem[] = [];
      for (const container of itemContainers) {
        const title = await extractFieldValue(container, TITLE_LABELS, ALI1688_DETAIL_SELECTORS.itemTitle);
        if (title === null) continue;
        items.push({
          item_key: null,
          title,
          sku_text: await extractFieldValueStructuralFirst(container, SKU_LABELS, ALI1688_DETAIL_SELECTORS.itemSku),
          quantity: await extractFieldValueStructuralFirst(
            container,
            QUANTITY_LABELS,
            ALI1688_DETAIL_SELECTORS.itemQuantity,
          ),
          unit_price: await extractFieldValueStructuralFirst(
            container,
            PRICE_LABELS,
            ALI1688_DETAIL_SELECTORS.itemPrice,
          ),
        });
      }
      if (items.length === 0) items = await extractSemanticCardItems(row);
      if (items.length === 0) {
        const title =
          columns === null || columns["title"] === undefined
            ? (await firstVisibleField(row, ALI1688_CARD_FIELD_SELECTORS.title)) ??
              (await extractLabelValue(row, TITLE_LABELS))
            : await cell("title");
        items = [
          {
            item_key: null,
            title,
            sku_text:
              columns === null || columns["sku"] === undefined
                ? (await firstVisibleField(row, ALI1688_CARD_FIELD_SELECTORS.sku)) ??
                  (await extractLabelValue(row, SKU_LABELS))
                : await cell("sku"),
            quantity:
              (columns === null || columns["quantity"] === undefined
                ? (await firstVisibleField(row, ALI1688_CARD_FIELD_SELECTORS.quantity)) ??
                  (await extractLabelValue(row, QUANTITY_LABELS)) ??
                  (await uniqueStandaloneQuantity(row))
                : await cell("quantity")),
            unit_price:
              columns === null || columns["price"] === undefined
                ? (await firstVisibleField(row, ALI1688_CARD_FIELD_SELECTORS.price)) ??
                  (await extractLabelValue(row, PRICE_LABELS))
                : await cell("price"),
          },
        ];
      }
      const raw: RawOrder = {
        platform_order_id: platformOrderId,
        ordered_at: orderedAt,
        status: statusText,
        shop_name: shopName,
        items: items.every((item) => item.title === null) ? emptyItemList() : items,
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
          order_id: platformOrderId,
        });
      }
      const mappedStatus =
        raw.status === null || raw.status.trim().length === 0
          ? null
          : ALI1688_STATUS_MAP[raw.status.trim()];
      if (
        mappedStatus === "SHIPPED" ||
          mappedStatus === "COMPLETED" ||
          mappedStatus === undefined ||
          mappedStatus === null
      ) {
        unparsed.push({
          locator: row,
          missing: ["logistics"],
          hint: "shipped or unknown status requires a full detail read for all packages",
          order_id: platformOrderId,
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
    const target = await findDetailLink(card.locator, page.url(), ALI1688_DETAIL_RULES);
    if (target === null) return null;
    const expectedOrderId =
      card.order_id !== undefined && card.order_id !== null && card.order_id.length > 0
        ? card.order_id.trim()
        : target.order_id;
    if (expectedOrderId === null || expectedOrderId.length === 0) {
      return null;
    }
    const beforeUrl = page.url();
    const opened = await openDetailTarget(page, target);
    if (opened === null) return null;
    const detailPage = opened.page;
    const openedNewTab = opened.newTab;
    if (!isOfficialHttpsUrl(detailPage.url(), ALI1688_DETAIL_RULES.allowedHostSuffix)) {
      if (openedNewTab) await detailPage.close().catch(() => undefined);
      else {
        await detailPage.goBack({ timeout: 5000 }).catch(() => undefined);
        await detailPage.waitForLoadState("domcontentloaded").catch(() => undefined);
      }
      return null;
    }

    const body = detailPage.locator("body");
    const platformOrderId = await extractLabelValue(body, ORDER_ID_LABELS);
    if (
      platformOrderId === null ||
      platformOrderId.length === 0 ||
      !/\d/.test(platformOrderId)
    ) {
      if (openedNewTab) await detailPage.close().catch(() => undefined);
      else {
        await detailPage.goBack({ timeout: 5000 }).catch(() => undefined);
        await detailPage.waitForLoadState("domcontentloaded").catch(() => undefined);
      }
      return null;
    }
    if (platformOrderId.trim() !== expectedOrderId) {
      if (openedNewTab) await detailPage.close().catch(() => undefined);
      else {
        await detailPage.goBack({ timeout: 5000 }).catch(() => undefined);
        await detailPage.waitForLoadState("domcontentloaded").catch(() => undefined);
      }
      return null;
    }

    const detailItems = await extractDetailItems(body);
    const cardHasNoId =
      card.order_id === undefined || card.order_id === null || card.order_id.length === 0;
    if (cardHasNoId && detailItems.every((item) => item.title === null)) {
      if (openedNewTab) await detailPage.close().catch(() => undefined);
      else {
        await detailPage.goBack({ timeout: 5000 }).catch(() => undefined);
        await detailPage.waitForLoadState("domcontentloaded").catch(() => undefined);
      }
      return null;
    }

    const logistics = await parseDetailLogistics(body, ALI1688_LOGISTICS_SELECTORS);
    const detail: RawOrder = {
      platform_order_id: platformOrderId,
      ordered_at: await extractLabelValue(body, TIME_LABELS),
      status: await extractLabelValue(body, STATUS_LABELS),
      shop_name: await extractLabelValue(body, SHOP_LABELS),
      items: detailItems,
      packages: logistics.packages,
      observed_at: new Date().toISOString(),
      source_page: 0,
      detail_source: true,
      detail_logistics: {
        area_found: logistics.area_found,
        rows_seen: logistics.rows_seen,
        rows_parsed: logistics.rows_parsed,
        unparsed_rows: logistics.unparsed_rows,
      },
    };

    if (openedNewTab) {
      await detailPage.close().catch(() => undefined);
    } else {
      try {
        await page.goBack({ timeout: 5000 });
      } catch {
        return null;
      }
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await page.waitForTimeout(500);
    }
    if (!sameListUrl(beforeUrl, page.url())) {
      return null;
    }
    if ((await findRowLocators(page)).length === 0) {
      return null;
    }
    if (
      card.order_id !== undefined &&
      card.order_id !== null &&
      card.order_id.length > 0 &&
      (await countVisible(page, `text=${card.order_id}`)) === 0
    ) {
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
