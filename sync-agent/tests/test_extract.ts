import { describe, expect, it } from "vitest";

import {
  buildUnifiedOrder,
  dedupeOrders,
  mergeRawOrdersByOrderId,
  type RawOrder,
  type StatusMap,
} from "../src/extract/order.js";
import { validateBatch } from "../src/models.js";

const STATUS_MAP: StatusMap = {
  已发货: "SHIPPED",
  交易关闭: "CANCELLED",
  待付款: "PENDING",
};

function rawOrder(overrides: Partial<RawOrder> = {}): RawOrder {
  return {
    platform_order_id: "260813-0001",
    ordered_at: "2026-08-12 10:30:00",
    status: "已发货",
    shop_name: "测试店铺",
    items: [{ item_key: "i1", title: "测试商品", sku_text: "标准", quantity: "2", unit_price: "3.50" }],
    packages: [{ courier: "中通", tracking_no: "ZTO-20260813-0001", status: null }],
    observed_at: "2026-08-13T02:00:10.000Z",
    source_page: 0,
    ...overrides,
  };
}

describe("buildUnifiedOrder", () => {
  it("maps raw fields to the unified model", () => {
    const result = buildUnifiedOrder(rawOrder(), "1688", "1688-main", STATUS_MAP);
    expect(result.issues).toEqual([]);
    expect(result.order).not.toBeNull();
    const order = result.order!;
    expect(order.platform_order_id).toBe("260813-0001");
    expect(order.status).toBe("SHIPPED");
    expect(order.ordered_at).toBe(new Date(2026, 7, 12, 10, 30, 0).toISOString());
    expect(order.items[0]?.quantity).toBe(2);
    expect(order.packages[0]?.tracking_no).toBe("ZTO-20260813-0001");
    expect(validateBatch({
      schema_version: 1,
      batch_id: "b0000000-0000-4000-8000-000000000001",
      worker_id: "w",
      platform: "1688",
      platform_account_key: "1688-main",
      started_at: "2026-08-13T02:00:00.000Z",
      finished_at: "2026-08-13T02:01:00.000Z",
      cursor_before: null,
      cursor_after: null,
      mode: "commit",
      orders: [order],
    })).toEqual([]);
  });

  it("treats unknown status text as UNKNOWN with no issue", () => {
    const result = buildUnifiedOrder(rawOrder({ status: "已付款待发货" }), "1688", "1688-main", STATUS_MAP);
    expect(result.order?.status).toBe("UNKNOWN");
    expect(result.issues).toEqual([]);
  });

  it("flags a missing platform_order_id", () => {
    const result = buildUnifiedOrder(rawOrder({ platform_order_id: "" }), "1688", "1688-main", STATUS_MAP);
    expect(result.order).toBeNull();
    expect(result.issues.join(" ")).toContain("platform_order_id");
  });

  it("flags unparseable dates instead of guessing", () => {
    const result = buildUnifiedOrder(rawOrder({ ordered_at: "08/01/2026" }), "1688", "1688-main", STATUS_MAP);
    expect(result.order).toBeNull();
    expect(result.issues.join(" ")).toContain("ordered_at");
  });

  it("flags missing item titles and bad quantities", () => {
    const result = buildUnifiedOrder(
      rawOrder({ items: [{ item_key: null, title: "", sku_text: null, quantity: "x", unit_price: null }] }),
      "1688",
      "1688-main",
      STATUS_MAP,
    );
    expect(result.order).toBeNull();
    expect(result.issues.join(" ")).toContain("title");
    expect(result.issues.join(" ")).toContain("quantity");
  });

  it("flags tracking numbers without payload", () => {
    const result = buildUnifiedOrder(
      rawOrder({ packages: [{ courier: null, tracking_no: "---", status: null }] }),
      "1688",
      "1688-main",
      STATUS_MAP,
    );
    expect(result.order).toBeNull();
    expect(result.issues.join(" ")).toContain("tracking_no");
  });

  it("keeps multi-package orders intact", () => {
    const result = buildUnifiedOrder(
      rawOrder({
        packages: [
          { courier: null, tracking_no: "ZTO-1", status: null },
          { courier: null, tracking_no: "ZTO-2", status: null },
        ],
      }),
      "1688",
      "1688-main",
      STATUS_MAP,
    );
    expect(result.order?.packages).toHaveLength(2);
  });

  it("drops nothing: no order id is ever converted to a number", () => {
    const result = buildUnifiedOrder(rawOrder({ platform_order_id: "00112233445566778899" }), "1688", "1688-main", STATUS_MAP);
    expect(result.order?.platform_order_id).toBe("00112233445566778899");
  });
});

describe("mergeRawOrdersByOrderId", () => {
  it("merges rows of the same order into multiple items and packages", () => {
    const first = rawOrder();
    const second = rawOrder({
      items: [{ item_key: null, title: "测试商品乙", sku_text: null, quantity: "3", unit_price: null }],
      packages: [{ courier: "中通", tracking_no: "8800123456790", status: null }],
    });
    const merged = mergeRawOrdersByOrderId([first, second]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.items).toHaveLength(2);
    expect(merged[0]?.packages).toHaveLength(2);
  });

  it("dedupes identical items and packages across rows", () => {
    const first = rawOrder();
    const second = rawOrder();
    const merged = mergeRawOrdersByOrderId([first, second]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.items).toHaveLength(1);
    expect(merged[0]?.packages).toHaveLength(1);
  });

  it("drops rows without an order id instead of guessing", () => {
    const noId: RawOrder = { ...rawOrder(), platform_order_id: "" };
    const merged = mergeRawOrdersByOrderId([noId]);
    expect(merged).toHaveLength(0);
  });

  it("keeps different orders separate", () => {
    const first = rawOrder();
    const second = rawOrder({ platform_order_id: "260813-0002" });
    const merged = mergeRawOrdersByOrderId([first, second]);
    expect(merged).toHaveLength(2);
  });

  it("drops placeholder items during merge", () => {
    const placeholder: RawOrder = {
      ...rawOrder(),
      items: [{ item_key: null, title: null, sku_text: null, quantity: null, unit_price: null }],
    };
    const real = rawOrder();
    const merged = mergeRawOrdersByOrderId([real, placeholder]);
    expect(merged[0]?.items).toHaveLength(1);
  });
});

describe("dedupeOrders", () => {
  it("removes repeated order ids within a run", () => {
    const first = buildUnifiedOrder(rawOrder(), "1688", "1688-main", STATUS_MAP).order!;
    const second = buildUnifiedOrder(rawOrder(), "1688", "1688-main", STATUS_MAP).order!;
    expect(dedupeOrders([first, second])).toHaveLength(1);
  });

  it("keeps different order ids", () => {
    const first = buildUnifiedOrder(rawOrder(), "1688", "1688-main", STATUS_MAP).order!;
    const second = buildUnifiedOrder(rawOrder({ platform_order_id: "260813-0002" }), "1688", "1688-main", STATUS_MAP).order!;
    expect(dedupeOrders([first, second])).toHaveLength(2);
  });
});
