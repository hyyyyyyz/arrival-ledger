export const PLATFORMS = ["pdd", "1688"] as const;

export type Platform = (typeof PLATFORMS)[number];

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

export const ORDER_STATUSES = [
  "PENDING",
  "PAID",
  "SHIPPED",
  "COMPLETED",
  "REFUNDED",
  "CANCELLED",
  "UNKNOWN",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const SYNC_STATUSES = [
  "OK",
  "NEEDS_LOGIN",
  "CAPTCHA_OR_BLOCKED",
  "SCHEMA_CHANGED",
  "NETWORK_ERROR",
  "DISABLED",
] as const;

export type SyncStatus = (typeof SYNC_STATUSES)[number];

export const SCHEMA_VERSION = 1;

export const LIMITS = {
  max_orders_per_batch: 100,
  max_items_per_order: 50,
  max_packages_per_order: 20,
  max_records: 500,
  min_records: 1,
  platform_order_id: 64,
  shop_name: 128,
  item_key: 64,
  item_title: 300,
  sku_text: 200,
  unit_price: 32,
  courier: 64,
  tracking_no: 64,
  batch_id: 64,
  worker_id: 64,
  account_key: 64,
} as const;

export interface OrderItem {
  item_key: string | null;
  title: string;
  sku_text: string | null;
  quantity: number;
  unit_price: string | null;
}

export interface OrderPackage {
  courier: string | null;
  tracking_no: string;
  status: string | null;
}

export interface UnifiedOrder {
  platform_order_id: string;
  ordered_at: string | null;
  status: OrderStatus;
  shop_name: string | null;
  items: OrderItem[];
  packages: OrderPackage[];
  observed_at: string;
}

export interface SyncBatch {
  schema_version: number;
  batch_id: string;
  worker_id: string;
  platform: Platform;
  platform_account_key: string;
  started_at: string;
  finished_at: string;
  cursor_before: string | null;
  cursor_after: string | null;
  mode: "commit";
  orders: UnifiedOrder[];
}

export interface CursorState {
  platform: Platform;
  account_key: string;
  last_success_at: string | null;
  last_cursor: string | null;
  last_batch_id: string | null;
  last_status: SyncStatus;
  consecutive_failures: number;
  updated_at: string;
}

export interface BatchCounts {
  seen: number;
  valid: number;
  skipped: number;
  uploaded: number;
  created: number;
  updated: number;
  errors: number;
}

export interface RunReport {
  command: string;
  platform: Platform;
  mode: "dry-run" | "commit";
  batch_id: string | null;
  status: SyncStatus;
  error_code: string | null;
  started_at: string;
  finished_at: string;
  counts: BatchCounts;
  warnings: string[];
}

export interface ValidationIssue {
  path: string;
  message: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const roundTrip = parsed.toISOString();
  const cleaned = value.trim().replace("Z", "+00:00");
  return new Date(cleaned).toISOString() === roundTrip;
}

function lengthBounded(value: string, maximum: number): boolean {
  return value.length <= maximum;
}

export function validateBatch(batch: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (typeof batch !== "object" || batch === null) {
    return [{ path: "$", message: "batch must be an object" }];
  }
  const record = batch as Record<string, unknown>;

  if (record["schema_version"] !== SCHEMA_VERSION) {
    issues.push({
      path: "schema_version",
      message: `must equal ${SCHEMA_VERSION}`,
    });
  }
  if (!isNonEmptyString(record["batch_id"]) || !lengthBounded(record["batch_id"] as string, LIMITS.batch_id)) {
    issues.push({ path: "batch_id", message: "must be a non-empty string <= 64 chars" });
  }
  if (!isNonEmptyString(record["worker_id"]) || !lengthBounded(record["worker_id"] as string, LIMITS.worker_id)) {
    issues.push({ path: "worker_id", message: "must be a non-empty string <= 64 chars" });
  }
  if (!isPlatform(String(record["platform"]))) {
    issues.push({ path: "platform", message: 'must be "pdd" or "1688"' });
  }
  if (
    !isNonEmptyString(record["platform_account_key"]) ||
    !lengthBounded(record["platform_account_key"] as string, LIMITS.account_key)
  ) {
    issues.push({ path: "platform_account_key", message: "must be a non-empty string <= 64 chars" });
  }
  for (const field of ["started_at", "finished_at"]) {
    if (!isIsoTimestamp(record[field])) {
      issues.push({ path: field, message: "must be an ISO-8601 timestamp" });
    }
  }
  if (record["mode"] !== "commit") {
    issues.push({ path: "mode", message: 'must be "commit"' });
  }
  for (const field of ["cursor_before", "cursor_after"]) {
    const value = record[field];
    if (value !== null && (typeof value !== "string" || !lengthBounded(value, 512))) {
      issues.push({ path: field, message: "must be null or a string <= 512 chars" });
    }
  }

  const orders = record["orders"];
  if (!Array.isArray(orders)) {
    issues.push({ path: "orders", message: "must be an array" });
    return issues;
  }
  if (orders.length === 0) {
    issues.push({ path: "orders", message: "must contain at least one order" });
  }
  if (orders.length > LIMITS.max_orders_per_batch) {
    issues.push({
      path: "orders",
      message: `must contain at most ${LIMITS.max_orders_per_batch} orders`,
    });
  }
  orders.forEach((order, index) => issues.push(...validateOrder(order, index)));
  return issues;
}

export function validateOrder(order: unknown, index: number): ValidationIssue[] {
  const prefix = `orders[${index}]`;
  const issues: ValidationIssue[] = [];
  if (typeof order !== "object" || order === null) {
    return [{ path: prefix, message: "must be an object" }];
  }
  const record = order as Record<string, unknown>;

  if (
    !isNonEmptyString(record["platform_order_id"]) ||
    !lengthBounded(record["platform_order_id"] as string, LIMITS.platform_order_id)
  ) {
    issues.push({ path: `${prefix}.platform_order_id`, message: `must be a non-empty string <= ${LIMITS.platform_order_id} chars` });
  }
  if (record["ordered_at"] !== null && !isIsoTimestamp(record["ordered_at"])) {
    issues.push({ path: `${prefix}.ordered_at`, message: "must be null or an ISO-8601 timestamp" });
  }
  if (!ORDER_STATUSES.includes(record["status"] as OrderStatus)) {
    issues.push({ path: `${prefix}.status`, message: `must be one of ${ORDER_STATUSES.join(", ")}` });
  }
  const shopName = record["shop_name"];
  if (shopName !== null && (typeof shopName !== "string" || !lengthBounded(shopName, LIMITS.shop_name))) {
    issues.push({ path: `${prefix}.shop_name`, message: `must be null or a string <= ${LIMITS.shop_name} chars` });
  }
  if (!isIsoTimestamp(record["observed_at"])) {
    issues.push({ path: `${prefix}.observed_at`, message: "must be an ISO-8601 timestamp" });
  }

  const items = record["items"];
  if (!Array.isArray(items) || items.length === 0) {
    issues.push({ path: `${prefix}.items`, message: "must contain at least one item" });
  } else if (items.length > LIMITS.max_items_per_order) {
    issues.push({ path: `${prefix}.items`, message: `must contain at most ${LIMITS.max_items_per_order} items` });
  } else {
    items.forEach((item, itemIndex) => issues.push(...validateItem(item, prefix, itemIndex)));
  }

  const packages = record["packages"];
  if (!Array.isArray(packages)) {
    issues.push({ path: `${prefix}.packages`, message: "must be an array" });
  } else if (packages.length > LIMITS.max_packages_per_order) {
    issues.push({ path: `${prefix}.packages`, message: `must contain at most ${LIMITS.max_packages_per_order} packages` });
  } else {
    packages.forEach((item, packageIndex) => issues.push(...validatePackage(item, prefix, packageIndex)));
  }
  return issues;
}

function validateItem(item: unknown, orderPrefix: string, index: number): ValidationIssue[] {
  const prefix = `${orderPrefix}.items[${index}]`;
  const issues: ValidationIssue[] = [];
  if (typeof item !== "object" || item === null) {
    return [{ path: prefix, message: "must be an object" }];
  }
  const record = item as Record<string, unknown>;
  const itemKey = record["item_key"];
  if (itemKey !== null && (typeof itemKey !== "string" || !lengthBounded(itemKey, LIMITS.item_key))) {
    issues.push({ path: `${prefix}.item_key`, message: `must be null or a string <= ${LIMITS.item_key} chars` });
  }
  if (!isNonEmptyString(record["title"]) || !lengthBounded(record["title"] as string, LIMITS.item_title)) {
    issues.push({ path: `${prefix}.title`, message: `must be a non-empty string <= ${LIMITS.item_title} chars` });
  }
  const skuText = record["sku_text"];
  if (skuText !== null && (typeof skuText !== "string" || !lengthBounded(skuText, LIMITS.sku_text))) {
    issues.push({ path: `${prefix}.sku_text`, message: `must be null or a string <= ${LIMITS.sku_text} chars` });
  }
  const quantity = record["quantity"];
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 999999) {
    issues.push({ path: `${prefix}.quantity`, message: "must be an integer between 1 and 999999" });
  }
  const unitPrice = record["unit_price"];
  if (unitPrice !== null && (typeof unitPrice !== "string" || !lengthBounded(unitPrice, LIMITS.unit_price))) {
    issues.push({ path: `${prefix}.unit_price`, message: `must be null or a string <= ${LIMITS.unit_price} chars` });
  }
  return issues;
}

function validatePackage(item: unknown, orderPrefix: string, index: number): ValidationIssue[] {
  const prefix = `${orderPrefix}.packages[${index}]`;
  const issues: ValidationIssue[] = [];
  if (typeof item !== "object" || item === null) {
    return [{ path: prefix, message: "must be an object" }];
  }
  const record = item as Record<string, unknown>;
  const courier = record["courier"];
  if (courier !== null && (typeof courier !== "string" || !lengthBounded(courier, LIMITS.courier))) {
    issues.push({ path: `${prefix}.courier`, message: `must be null or a string <= ${LIMITS.courier} chars` });
  }
  if (
    !isNonEmptyString(record["tracking_no"]) ||
    !lengthBounded(record["tracking_no"] as string, LIMITS.tracking_no)
  ) {
    issues.push({ path: `${prefix}.tracking_no`, message: `must be a non-empty string <= ${LIMITS.tracking_no} chars` });
  }
  const status = record["status"];
  if (status !== null && typeof status !== "string") {
    issues.push({ path: `${prefix}.status`, message: "must be null or a string" });
  }
  return issues;
}
