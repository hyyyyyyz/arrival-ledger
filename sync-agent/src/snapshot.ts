import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { accountKeyFilePart } from "./state/cursor.js";
import { isPlatform, validateBatch, type Platform, type SyncBatch, type UnifiedOrder } from "./models.js";

export interface Snapshot {
  schema_version: number;
  batch_id: string;
  platform: Platform;
  platform_account_key: string;
  mode: "commit";
  orders: UnifiedOrder[];
  payload_json: string;
  payload_sha256: string;
  created_at: string;
}

export interface SnapshotVerifyResult {
  ok: boolean;
  reason: string | null;
}

export const SNAPSHOT_TTL_MINUTES = 30;

const FUTURE_SKEW_MS = 5 * 60_000;

export interface SnapshotTimeResult {
  state: "ok" | "expired" | "invalid";
  reason: string | null;
}

export function snapshotFinishedAt(snapshot: Snapshot): Date | null {
  try {
    const parsed = JSON.parse(snapshot.payload_json) as { finished_at?: unknown };
    if (typeof parsed.finished_at !== "string") return null;
    const date = new Date(parsed.finished_at);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

export function evaluateSnapshotTime(
  snapshot: Snapshot,
  now: Date = new Date(),
): SnapshotTimeResult {
  const finishedAt = snapshotFinishedAt(snapshot);
  if (finishedAt === null) {
    return { state: "invalid", reason: "payload lacks a valid finished_at" };
  }
  if (finishedAt.getTime() > now.getTime() + FUTURE_SKEW_MS) {
    return { state: "invalid", reason: "payload finished_at is in the future" };
  }
  const createdAt = new Date(snapshot.created_at);
  if (!Number.isNaN(createdAt.getTime()) && createdAt.getTime() > now.getTime() + FUTURE_SKEW_MS) {
    return { state: "invalid", reason: "snapshot created_at is in the future" };
  }
  if (now.getTime() - finishedAt.getTime() > SNAPSHOT_TTL_MINUTES * 60_000) {
    return {
      state: "expired",
      reason: `snapshot is older than ${SNAPSHOT_TTL_MINUTES} minutes`,
    };
  }
  return { state: "ok", reason: null };
}

export function snapshotFileName(
  stateDir: string,
  platform: Platform,
  accountKey: string,
  batchId: string,
): string {
  return join(
    stateDir,
    `snapshot-${platform}-${accountKeyFilePart(accountKey)}-${batchId}.json`,
  );
}

export function payloadDigest(payloadJson: string): string {
  return createHash("sha256").update(payloadJson, "utf8").digest("hex");
}

export function buildSnapshot(batch: SyncBatch): Snapshot {
  const payload_json = JSON.stringify(batch);
  return {
    schema_version: batch.schema_version,
    batch_id: batch.batch_id,
    platform: batch.platform,
    platform_account_key: batch.platform_account_key,
    mode: "commit",
    orders: batch.orders,
    payload_json,
    payload_sha256: payloadDigest(payload_json),
    created_at: new Date().toISOString(),
  };
}

export function writeSnapshot(stateDir: string, snapshot: Snapshot): string {
  mkdirSync(stateDir, { recursive: true });
  const target = snapshotFileName(
    stateDir,
    snapshot.platform,
    snapshot.platform_account_key,
    snapshot.batch_id,
  );
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(snapshot, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, target);
  return target;
}

export function readSnapshot(path: string): Snapshot | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (
      typeof parsed["schema_version"] !== "number" ||
      typeof parsed["batch_id"] !== "string" ||
      !isPlatform(String(parsed["platform"])) ||
      typeof parsed["platform_account_key"] !== "string" ||
      parsed["mode"] !== "commit" ||
      !Array.isArray(parsed["orders"]) ||
      typeof parsed["payload_json"] !== "string" ||
      typeof parsed["payload_sha256"] !== "string" ||
      typeof parsed["created_at"] !== "string"
    ) {
      return null;
    }
    return parsed as unknown as Snapshot;
  } catch {
    return null;
  }
}

export function snapshotToBatch(snapshot: Snapshot): SyncBatch | null {
  try {
    const parsed = JSON.parse(snapshot.payload_json) as unknown;
    const issues = validateBatch(parsed);
    if (issues.length > 0) return null;
    return parsed as SyncBatch;
  } catch {
    return null;
  }
}

export function verifySnapshot(snapshot: Snapshot): SnapshotVerifyResult {
  const digest = payloadDigest(snapshot.payload_json);
  if (digest !== snapshot.payload_sha256) {
    return { ok: false, reason: "payload hash mismatch; the snapshot was modified" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.payload_json) as unknown;
  } catch {
    return { ok: false, reason: "payload is not valid JSON; re-run dry-run" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "payload is not a batch object; re-run dry-run" };
  }
  const record = parsed as Record<string, unknown>;
  if (
    record["schema_version"] !== snapshot.schema_version ||
    record["batch_id"] !== snapshot.batch_id ||
    record["platform"] !== snapshot.platform ||
    record["platform_account_key"] !== snapshot.platform_account_key ||
    record["mode"] !== "commit" ||
    !Array.isArray(record["orders"])
  ) {
    return { ok: false, reason: "snapshot envelope does not match its payload; re-run dry-run" };
  }
  if (JSON.stringify(parsed) !== snapshot.payload_json) {
    return { ok: false, reason: "payload round-trip mismatch; the snapshot was modified" };
  }
  return { ok: true, reason: null };
}

export function removeSnapshot(path: string): void {
  rmSync(path, { force: true });
}
