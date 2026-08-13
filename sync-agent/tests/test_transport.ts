import { describe, expect, it, vi } from "vitest";

import { postBatch, TransportError } from "../src/transport.js";
import type { SyncBatch } from "../src/models.js";

function validBatch(): SyncBatch {
  return {
    schema_version: 1,
    batch_id: "b0000000-0000-4000-8000-000000000001",
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
        shop_name: "shop",
        items: [{ item_key: null, title: "t", sku_text: null, quantity: 1, unit_price: null }],
        packages: [{ courier: null, tracking_no: "SF123", status: null }],
        observed_at: "2026-08-13T02:00:10.000Z",
      },
    ],
  };
}

function okResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      batch_id: "b0000000-0000-4000-8000-000000000001",
      created: 1,
      updated: 0,
      skipped: 0,
      errors: [],
      cursor_accepted: true,
      ...overrides,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const options = { api_base_url: "http://127.0.0.1:8766", worker_key: "test-worker-key-0001" };

describe("postBatch", () => {
  it("sends Authorization and Idempotency-Key headers and parses the response", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer test-worker-key-0001");
      expect(headers["Idempotency-Key"]).toBe("b0000000-0000-4000-8000-000000000001");
      return okResponse();
    }) as unknown as typeof fetch;
    const response = await postBatch(options, validBatch(), fetchImpl);
    expect(response.created).toBe(1);
    expect(response.cursor_accepted).toBe(true);
  });

  it("does not retry auth failures", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    await expect(postBatch(options, validBatch(), fetchImpl)).rejects.toMatchObject({ kind: "auth" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry conflicts", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 409 })) as unknown as typeof fetch;
    await expect(postBatch(options, validBatch(), fetchImpl)).rejects.toMatchObject({ kind: "conflict" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries 5xx up to the limit", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(new Response("{}", { status: 502 }))
      .mockResolvedValueOnce(okResponse()) as unknown as typeof fetch;
    const response = await postBatch({ ...options, backoff_ms: 1 }, validBatch(), fetchImpl);
    expect(response.created).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("stops after max retries with a server error", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    await expect(postBatch({ ...options, backoff_ms: 1 }, validBatch(), fetchImpl)).rejects.toMatchObject({ kind: "server" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("surfaces 429 with Retry-After", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 429, headers: { "Retry-After": "120" } }),
    ) as unknown as typeof fetch;
    await expect(postBatch({ ...options, backoff_ms: 1 }, validBatch(), fetchImpl)).rejects.toMatchObject({
      kind: "rate_limited",
      retry_after_seconds: 120,
    });
  });

  it("rejects malformed server responses", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"unexpected": true}', { status: 200 })) as unknown as typeof fetch;
    await expect(postBatch({ ...options, backoff_ms: 1 }, validBatch(), fetchImpl)).rejects.toMatchObject({ kind: "bad_response" });
  });

  it("never sends a dry_run batch", async () => {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    const batch = { ...validBatch(), mode: "dry_run" } as unknown as SyncBatch;
    await expect(postBatch(options, batch, fetchImpl)).rejects.toMatchObject({ kind: "validation" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never sends a batch with an empty worker key", async () => {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    await expect(postBatch({ ...options, worker_key: "" }, validBatch(), fetchImpl)).rejects.toMatchObject({ kind: "auth" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retries network failures with backoff", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(okResponse()) as unknown as typeof fetch;
    const response = await postBatch(
      { ...options, backoff_ms: 1 },
      validBatch(),
      fetchImpl,
    );
    expect(response.created).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects oversized batch client-side", async () => {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    const batch = validBatch();
    batch.orders = Array.from({ length: 101 }, () => validBatch().orders[0]!);
    await expect(postBatch(options, batch, fetchImpl)).rejects.toMatchObject({ kind: "validation" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is a TransportError for unknown statuses", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 418 })) as unknown as typeof fetch;
    const error = await postBatch({ ...options, backoff_ms: 1 }, validBatch(), fetchImpl).catch((cause) => cause);
    expect(error).toBeInstanceOf(TransportError);
  });
});
