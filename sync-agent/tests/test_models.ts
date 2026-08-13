import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { LIMITS, validateBatch, validateOrder } from "../src/models.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function validOrder(): Record<string, unknown> {
  return {
    platform_order_id: "260813-0001",
    ordered_at: "2026-08-12T10:30:00.000Z",
    status: "SHIPPED",
    shop_name: "shop",
    items: [{ item_key: null, title: "item", sku_text: null, quantity: 1, unit_price: null }],
    packages: [{ courier: null, tracking_no: "SF123", status: null }],
    observed_at: "2026-08-13T02:00:00.000Z",
  };
}

function validBatch(): Record<string, unknown> {
  return {
    schema_version: 1,
    batch_id: "b0000000-0000-4000-8000-000000000001",
    worker_id: "worker-test",
    platform: "pdd",
    platform_account_key: "pdd-main",
    started_at: "2026-08-13T02:00:00.000Z",
    finished_at: "2026-08-13T02:01:00.000Z",
    cursor_before: null,
    cursor_after: null,
    mode: "commit",
    orders: [validOrder()],
  };
}

describe("validateBatch", () => {
  it("accepts the sanitized fixture batch", () => {
    const fixture = JSON.parse(
      readFileSync(join(fixtureDir, "sanitized_batch.json"), "utf8"),
    ) as Record<string, { orders: unknown[] }>;
    expect(validateBatch(fixture["batch"])).toEqual([]);
  });

  it("accepts a minimal valid batch", () => {
    expect(validateBatch(validBatch())).toEqual([]);
  });

  it("rejects a missing orders array", () => {
    const batch = validBatch();
    delete batch["orders"];
    const issues = validateBatch(batch);
    expect(issues.some((issue) => issue.path === "orders")).toBe(true);
  });

  it("rejects dry_run mode (server only accepts commit)", () => {
    const batch = { ...validBatch(), mode: "dry_run" };
    expect(validateBatch(batch).some((issue) => issue.path === "mode")).toBe(true);
  });

  it("rejects more than 100 orders", () => {
    const batch = {
      ...validBatch(),
      orders: Array.from({ length: LIMITS.max_orders_per_batch + 1 }, () => validOrder()),
    };
    const issues = validateBatch(batch);
    expect(issues.some((issue) => issue.path === "orders")).toBe(true);
  });

  it("rejects invalid platform and schema version", () => {
    const batch = { ...validBatch(), platform: "taobao", schema_version: 99 };
    const paths = validateBatch(batch).map((issue) => issue.path);
    expect(paths).toContain("platform");
    expect(paths).toContain("schema_version");
  });

  it("rejects non-object payloads", () => {
    expect(validateBatch(null)).toHaveLength(1);
    expect(validateBatch("text")).toHaveLength(1);
  });
});

describe("validateOrder", () => {
  it("rejects orders with no items", () => {
    const order = validOrder();
    order["items"] = [];
    const issues = validateOrder(order, 0);
    expect(issues.some((issue) => issue.path === "orders[0].items")).toBe(true);
  });

  it("rejects invalid quantity and unknown status", () => {
    const order = validOrder();
    order["items"] = [{ item_key: null, title: "t", sku_text: null, quantity: 0, unit_price: null }];
    order["status"] = "MYSTERY";
    const paths = validateOrder(order, 0).map((issue) => issue.path);
    expect(paths).toContain("orders[0].items[0].quantity");
    expect(paths).toContain("orders[0].status");
  });

  it("rejects oversized fields", () => {
    const order = validOrder();
    order["platform_order_id"] = "x".repeat(LIMITS.platform_order_id + 1);
    const issues = validateOrder(order, 0);
    expect(issues.some((issue) => issue.path === "orders[0].platform_order_id")).toBe(true);
  });

  it("allows empty packages (no forged tracking numbers)", () => {
    const order = validOrder();
    order["packages"] = [];
    expect(validateOrder(order, 0)).toEqual([]);
  });
});
