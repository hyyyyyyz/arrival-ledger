import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION, validateBatch, type SyncBatch } from "../src/models.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function contractBatch(): SyncBatch {
  return {
    schema_version: 1,
    batch_id: "b0000000-0000-4000-8000-00000000dead",
    worker_id: "worker-contract-test",
    platform: "pdd",
    platform_account_key: "pdd-main",
    started_at: "2026-08-13T02:00:00.000Z",
    finished_at: "2026-08-13T02:01:00.000Z",
    cursor_before: null,
    cursor_after: "2026-08-13T02:01:00.000Z",
    mode: "commit",
    orders: [
      {
        platform_order_id: "260813-0001",
        ordered_at: "2026-08-12T10:30:00.000Z",
        status: "SHIPPED",
        shop_name: "契约测试店铺",
        items: [
          {
            item_key: "item-0001",
            title: "契约测试商品",
            sku_text: "标准",
            quantity: 2,
            unit_price: "12.50",
          },
        ],
        packages: [
          {
            courier: "顺丰速运",
            tracking_no: "SF1234567890000",
            status: null,
          },
        ],
        observed_at: "2026-08-13T02:00:10.000Z",
      },
      {
        platform_order_id: "260813-0002",
        ordered_at: null,
        status: "CANCELLED",
        shop_name: null,
        items: [
          {
            item_key: null,
            title: "契约测试商品乙",
            sku_text: null,
            quantity: 1,
            unit_price: null,
          },
        ],
        packages: [],
        observed_at: "2026-08-13T02:00:10.000Z",
      },
    ],
  };
}

describe("cross-language batch contract", () => {
  it("serializes exactly like the golden fixture consumed by the backend", () => {
    const golden = readFileSync(join(fixtureDir, "batch_contract.json"), "utf8");
    expect(JSON.stringify(contractBatch(), null, 2)).toBe(golden.trimEnd());
  });

  it("the golden fixture passes client-side validation", () => {
    const parsed = JSON.parse(
      readFileSync(join(fixtureDir, "batch_contract.json"), "utf8"),
    ) as unknown;
    expect(validateBatch(parsed)).toEqual([]);
    expect((parsed as SyncBatch).schema_version).toBe(SCHEMA_VERSION);
  });
});
