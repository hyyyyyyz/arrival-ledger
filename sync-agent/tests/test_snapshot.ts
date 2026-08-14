import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SyncBatch } from "../src/models.js";
import {
  buildSnapshot,
  readSnapshot,
  snapshotFileName,
  snapshotToBatch,
  verifySnapshot,
  writeSnapshot,
} from "../src/snapshot.js";

const createdDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sync-agent-snapshot-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sampleBatch(): SyncBatch {
  return {
    schema_version: 1,
    batch_id: "b0000000-0000-4000-8000-00000000cafe",
    worker_id: "worker-test",
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
        shop_name: "快照测试店铺",
        items: [
          { item_key: "i1", title: "快照商品", sku_text: "标准", quantity: 2, unit_price: "9.99" },
        ],
        packages: [{ courier: "中通", tracking_no: "8800123456789", status: "SHIPPED" }],
        observed_at: "2026-08-13T02:00:10.000Z",
      },
    ],
  };
}

describe("snapshot lifecycle", () => {
  it("writes and reads a snapshot whose payload round-trips byte-identically", () => {
    const dir = tempDir();
    const batch = sampleBatch();
    const snapshot = buildSnapshot(batch);
    const path = writeSnapshot(dir, snapshot);
    expect(path).toBe(snapshotFileName(dir, "pdd", "pdd-main", batch.batch_id));

    const loaded = readSnapshot(path);
    expect(loaded).not.toBeNull();
    expect(verifySnapshot(loaded!)).toEqual({ ok: true, reason: null });
    const rebuilt = snapshotToBatch(loaded!);
    expect(rebuilt).not.toBeNull();
    expect(JSON.stringify(rebuilt)).toBe(snapshot.payload_json);
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(batch));
  });

  it("the payload hash covers the exact upload bytes", () => {
    const snapshot = buildSnapshot(sampleBatch());
    expect(snapshot.payload_sha256).toBe(
      createHash("sha256").update(snapshot.payload_json, "utf8").digest("hex"),
    );
  });

  it("rejects a tampered payload", () => {
    const dir = tempDir();
    const snapshot = buildSnapshot(sampleBatch());
    const path = writeSnapshot(dir, snapshot);
    const tampered = { ...snapshot, payload_json: snapshot.payload_json.replace("快照商品", "被篡改商品") };
    writeFileSync(path, JSON.stringify(tampered, null, 2), "utf8");
    const loaded = readSnapshot(path);
    expect(loaded).not.toBeNull();
    const result = verifySnapshot(loaded!);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("hash");
  });

  it("rejects a tampered envelope", () => {
    const dir = tempDir();
    const snapshot = buildSnapshot(sampleBatch());
    const path = writeSnapshot(dir, snapshot);
    const tampered = { ...snapshot, platform: "1688" };
    writeFileSync(path, JSON.stringify(tampered, null, 2), "utf8");
    const loaded = readSnapshot(path);
    expect(loaded).not.toBeNull();
    const result = verifySnapshot(loaded!);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("envelope");
  });

  it("rejects a payload that is not a valid batch", () => {
    const dir = tempDir();
    const snapshot = buildSnapshot(sampleBatch());
    const path = writeSnapshot(dir, snapshot);
    const brokenPayload = JSON.stringify({ hello: "world" });
    const tampered = {
      ...snapshot,
      payload_json: brokenPayload,
      payload_sha256: createHash("sha256").update(brokenPayload, "utf8").digest("hex"),
    };
    writeFileSync(path, JSON.stringify(tampered, null, 2), "utf8");
    const loaded = readSnapshot(path);
    expect(loaded).not.toBeNull();
    const result = verifySnapshot(loaded!);
    expect(result.ok).toBe(false);
  });

  it("returns null for a missing snapshot file", () => {
    const dir = tempDir();
    expect(readSnapshot(join(dir, "missing.json"))).toBeNull();
  });

  it("returns null for a corrupt snapshot file", () => {
    const dir = tempDir();
    const path = join(dir, "corrupt.json");
    writeFileSync(path, "{not json", "utf8");
    expect(readSnapshot(path)).toBeNull();
  });

  it("keeps the snapshot private and platform-scoped", () => {
    const dir = tempDir();
    const snapshot = buildSnapshot(sampleBatch());
    const path = writeSnapshot(dir, snapshot);
    expect(path).toContain("snapshot-pdd-pdd-main-");
    const mode = readFileSync(path, "utf8");
    expect(mode).not.toContain("password");
  });
});
