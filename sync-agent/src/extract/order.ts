import { hasTrackingPayload, normalizeTrackingNo, sanitizeTrackingNo } from "./tracking.js";
import {
  normalizeCourier,
  orderIdMatchKey,
  parseDateToIso,
  parseQuantity,
  sanitizeOrderId,
  unwrapExcelString,
} from "../normalize.js";
import type { OrderItem, OrderPackage, OrderStatus, Platform, UnifiedOrder } from "../models.js";
import { LIMITS } from "../models.js";
export interface RawOrderItem {
  item_key: string | null;
  title: string | null;
  sku_text: string | null;
  quantity: string | null;
  unit_price: string | null;
}

export interface RawOrderPackage {
  courier: string | null;
  tracking_no: string | null;
  status: string | null;
}

export interface RawOrder {
  platform_order_id: string | null;
  ordered_at: string | null;
  status: string | null;
  shop_name: string | null;
  items: RawOrderItem[];
  packages: RawOrderPackage[];
  observed_at: string;
  source_page: number;
}

export interface ExtractResult {
  order: UnifiedOrder | null;
  issues: string[];
}

export type StatusMap = Readonly<Record<string, OrderStatus>>;

export function buildUnifiedOrder(
  raw: RawOrder,
  platform: Platform,
  accountKey: string,
  statusMap: StatusMap,
): ExtractResult {
  const issues: string[] = [];
  const prefix = raw.platform_order_id ?? `page-${raw.source_page}`;

  const orderId = sanitizeOrderId(raw.platform_order_id ?? "");
  if (orderId.length === 0) {
    issues.push(`${prefix}: platform_order_id is missing`);
  } else if (orderIdMatchKey(orderId).length === 0) {
    issues.push(`${prefix}: platform_order_id has no letters or digits`);
  }

  const rawStatus = raw.status === null ? null : raw.status.trim();
  let status: OrderStatus;
  if (rawStatus === null || rawStatus.length === 0) {
    status = "UNKNOWN";
  } else if (rawStatus in statusMap) {
    status = statusMap[rawStatus] ?? "UNKNOWN";
  } else {
    status = "UNKNOWN";
  }

  let orderedAt: string | null = null;
  if (raw.ordered_at !== null && raw.ordered_at.trim().length > 0) {
    const parsed = parseDateToIso(unwrapExcelString(raw.ordered_at));
    if (parsed === null) {
      issues.push(`${prefix}: could not parse ordered_at "${raw.ordered_at.slice(0, 40)}"`);
    } else {
      orderedAt = parsed;
    }
  }

  const shopName =
    raw.shop_name === null || raw.shop_name.trim().length === 0
      ? null
      : raw.shop_name.trim().slice(0, LIMITS.shop_name);

  if (raw.items.length === 0) {
    issues.push(`${prefix}: order has no items`);
  }
  const items: OrderItem[] = [];
  raw.items.forEach((rawItem, index) => {
    const itemPrefix = `${prefix}: items[${index}]`;
    const title = rawItem.title === null ? "" : rawItem.title.trim();
    if (title.length === 0) {
      issues.push(`${itemPrefix}: title is missing`);
    }
    const quantity = parseQuantity(rawItem.quantity);
    if (quantity === null) {
      issues.push(`${itemPrefix}: quantity is missing or invalid`);
    }
    items.push({
      item_key:
        rawItem.item_key === null || rawItem.item_key.trim().length === 0
          ? null
          : rawItem.item_key.trim().slice(0, LIMITS.item_key),
      title: title.slice(0, LIMITS.item_title),
      sku_text:
        rawItem.sku_text === null || rawItem.sku_text.trim().length === 0
          ? null
          : rawItem.sku_text.trim().slice(0, LIMITS.sku_text),
      quantity: quantity ?? 1,
      unit_price:
        rawItem.unit_price === null || rawItem.unit_price.trim().length === 0
          ? null
          : rawItem.unit_price.trim().slice(0, LIMITS.unit_price),
    });
  });

  const packages: OrderPackage[] = [];
  raw.packages.forEach((rawPackage, index) => {
    const packagePrefix = `${prefix}: packages[${index}]`;
    if (rawPackage.tracking_no === null || rawPackage.tracking_no.trim().length === 0) {
      issues.push(`${packagePrefix}: tracking_no is missing`);
      return;
    }
    const tracking = sanitizeTrackingNo(rawPackage.tracking_no);
    if (!hasTrackingPayload(tracking)) {
      issues.push(`${packagePrefix}: tracking_no has no letters or digits`);
      return;
    }
    if (normalizeTrackingNo(tracking).length > LIMITS.tracking_no) {
      issues.push(`${packagePrefix}: normalized tracking_no exceeds ${LIMITS.tracking_no} chars`);
      return;
    }
    packages.push({
      courier:
        rawPackage.courier === null || rawPackage.courier.trim().length === 0
          ? null
          : normalizeCourier(rawPackage.courier).slice(0, LIMITS.courier),
      tracking_no: tracking,
      status:
        rawPackage.status === null || rawPackage.status.trim().length === 0
          ? null
          : rawPackage.status.trim().slice(0, 64),
    });
  });

  if (issues.length > 0) {
    return { order: null, issues };
  }

  return {
    order: {
      platform_order_id: orderId,
      ordered_at: orderedAt,
      status,
      shop_name: shopName,
      items,
      packages,
      observed_at: raw.observed_at,
    },
    issues: [],
  };
}

export function mergeExtractResults(
  results: ExtractResult[],
): { orders: UnifiedOrder[]; issues: string[] } {
  const orders: UnifiedOrder[] = [];
  const issues: string[] = [];
  for (const result of results) {
    issues.push(...result.issues);
    if (result.order !== null) orders.push(result.order);
  }
  return { orders, issues };
}

export function dedupeOrders(orders: UnifiedOrder[]): UnifiedOrder[] {
  const seen = new Set<string>();
  const unique: UnifiedOrder[] = [];
  for (const order of orders) {
    const key = orderIdMatchKey(order.platform_order_id);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(order);
  }
  return unique;
}

function isPlaceholderItem(item: RawOrderItem): boolean {
  return item.title === null && item.quantity === null && item.sku_text === null;
}

export function mergeRawOrdersByOrderId(orders: RawOrder[]): RawOrder[] {
  const merged = new Map<string, RawOrder>();
  for (const raw of orders) {
    if (raw.platform_order_id === null || raw.platform_order_id.length === 0) {
      continue;
    }
    const key = orderIdMatchKey(raw.platform_order_id);
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, {
        ...raw,
        items: raw.items.filter((item) => !isPlaceholderItem(item)),
      });
      continue;
    }
    const items = [...existing.items];
    for (const item of raw.items) {
      if (isPlaceholderItem(item)) continue;
      const duplicate = items.some(
        (other) =>
          orderIdMatchKey(other.title ?? "") === orderIdMatchKey(item.title ?? "") &&
          (other.sku_text ?? "") === (item.sku_text ?? ""),
      );
      if (!duplicate) items.push(item);
    }
    const packages = [...existing.packages];
    for (const item of raw.packages) {
      const duplicate = packages.some(
        (other) =>
          normalizeTrackingNo(other.tracking_no ?? "") === normalizeTrackingNo(item.tracking_no ?? ""),
      );
      if (!duplicate) packages.push(item);
    }
    merged.set(key, {
      platform_order_id: existing.platform_order_id,
      ordered_at: existing.ordered_at ?? raw.ordered_at,
      status: existing.status ?? raw.status,
      shop_name: existing.shop_name ?? raw.shop_name,
      items,
      packages,
      observed_at: existing.observed_at,
      source_page: Math.min(existing.source_page, raw.source_page),
    });
  }
  return [...merged.values()];
}

export function accountLabelForPlatform(platform: Platform, accountKey: string): string {
  return `${platform}:${accountKey}`;
}
