import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "playwright";

import type { PlatformAdapter } from "./adapters/base.js";
import { getAdapter } from "./adapters/index.js";
import { launchSyncBrowser, type SyncBrowser } from "./browser/context.js";
import { checkPageState } from "./browser/guards.js";
import type { SyncConfig } from "./config.js";
import {
  buildUnifiedOrder,
  dedupeOrders,
  mergeRawOrdersByOrderId,
  type ExtractResult,
  type RawOrder,
} from "./extract/order.js";
import type { JsonLogger } from "./log.js";
import {
  SCHEMA_VERSION,
  type BatchCounts,
  type Platform,
  type RunReport,
  type SyncBatch,
  type UnifiedOrder,
} from "./models.js";
import {
  buildSnapshot,
  evaluateSnapshotTime,
  readSnapshot,
  snapshotToBatch,
  verifySnapshot,
  writeSnapshot,
  type Snapshot,
} from "./snapshot.js";
import { acquireLock, describeHolder } from "./state/lock.js";
import { loadCursor, updateCursor } from "./state/cursor.js";
import { postBatch, TransportError } from "./transport.js";

export type BrowserLauncher = (profileDir: string) => Promise<SyncBrowser>;

export interface RunOptions {
  config: SyncConfig;
  platform: Platform;
  mode: "dry-run" | "commit";
  confirm: boolean;
  logger: JsonLogger;
  launcher?: BrowserLauncher;
  adapter?: PlatformAdapter;
  snapshotPath?: string;
}

export interface RunOutcome {
  exitCode: number;
  report: RunReport;
}

const nowIso = (): string => new Date().toISOString();

function buildReport(
  command: string,
  platform: Platform,
  mode: "dry-run" | "commit",
  batchId: string | null,
  status: RunReport["status"],
  errorCode: string | null,
  startedAt: string,
  counts: BatchCounts,
  warnings: string[],
  snapshotPath: string | null = null,
): RunReport {
  return {
    command,
    platform,
    mode,
    batch_id: batchId,
    status,
    error_code: errorCode,
    started_at: startedAt,
    finished_at: nowIso(),
    counts,
    warnings,
    snapshot_path: snapshotPath,
  };
}

function writeReportFile(
  config: SyncConfig,
  platform: Platform,
  report: RunReport,
  orders: UnifiedOrder[],
  logger: JsonLogger,
): void {
  const summary = orders.map((order) => ({
    platform_order_id: order.platform_order_id,
    status: order.status,
    shop_name: order.shop_name,
    ordered_at: order.ordered_at,
    items: order.items.map((item) => ({
      item_key: item.item_key,
      title: item.title,
      sku_text: item.sku_text,
      quantity: item.quantity,
      unit_price: item.unit_price,
    })),
    packages: order.packages.map((item) => ({
      courier: item.courier,
      tracking_no: item.tracking_no,
      status: item.status,
    })),
  }));
  const payload = { report, orders: summary };
  const target = join(
    config.state_dir,
    `report-${platform}-${report.started_at.replaceAll(":", "-")}.json`,
  );
  try {
    mkdirSync(config.state_dir, { recursive: true });
    writeFileSync(target, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    logger.info({ command: "sync-once", platform, message: "report written", counts: { path_length: target.length } });
  } catch (error) {
    logger.warn({ command: "sync-once", platform, message: `could not write report: ${(error as Error).message}` });
  }
}

const emptyCounts = (): BatchCounts => ({
  seen: 0,
  valid: 0,
  skipped: 0,
  uploaded: 0,
  created: 0,
  updated: 0,
  errors: 0,
});

export async function runSyncOnce(options: RunOptions): Promise<RunOutcome> {
  if (options.mode === "commit") {
    return runCommit(options);
  }
  return runDryRun(options);
}

async function runDryRun(options: RunOptions): Promise<RunOutcome> {
  const { config, platform, logger } = options;
  const accountKey = config.account_keys[platform];
  const startedAt = nowIso();

  const profileDir = config.profile_dirs[platform];
  if (!existsSync(profileDir)) {
    logger.error({
      command: "sync-once",
      platform,
      message: `profile dir does not exist: ${profileDir}; run login-check first`,
      error_code: "CONFIG",
    });
    return {
      exitCode: 1,
      report: buildReport("sync-once", platform, "dry-run", null, "DISABLED", "CONFIG", startedAt, emptyCounts(), []),
    };
  }

  const lock = acquireLock(config.state_dir, platform, accountKey, config.worker_id);
  if (!lock.held) {
    logger.error({
      command: "sync-once",
      platform,
      message: `another sync is running for ${platform}:${accountKey} (${describeHolder(lock.holder)})`,
      error_code: "LOCKED",
    });
    return {
      exitCode: 1,
      report: buildReport("sync-once", platform, "dry-run", null, "DISABLED", "LOCKED", startedAt, emptyCounts(), []),
    };
  }

  const adapter = options.adapter ?? getAdapter(platform);
  const launcher = options.launcher ?? launchSyncBrowser;
  let browser: SyncBrowser | null = null;
  try {
    browser = await launcher(profileDir);
    const page = browser.context.pages()[0] ?? (await browser.context.newPage());
    try {
      await adapter.openOrders(page, {
        max_pages: config.max_pages,
        max_records: config.max_records,
        order_list_url: config.order_list_urls[platform],
      });
    } catch (error) {
      logger.error({
        command: "sync-once",
        platform,
        message: `could not open the order list: ${(error as Error).message}`,
        error_code: "CONFIG",
      });
      const report = buildReport("sync-once", platform, "dry-run", null, "DISABLED", "CONFIG", startedAt, emptyCounts(), []);
      return { exitCode: 1, report };
    }

    const state = await checkPageState(page, adapter);
    if (state.status !== "OK") {
      updateCursor(config.state_dir, platform, accountKey, {
        last_status: state.status,
        last_sync_at: nowIso(),
      });
      logger.error({
        command: "sync-once",
        platform,
        status: state.status,
        message: state.detail,
        error_code: state.status,
      });
      const report = buildReport("sync-once", platform, "dry-run", null, state.status, state.status, startedAt, emptyCounts(), []);
      writeReportFile(config, platform, report, [], logger);
      return { exitCode: 1, report };
    }

    const rawOrders: RawOrder[] = [];
    const warnings: string[] = [];
    let pages = 0;
    let sawEmptyList = false;
    let rowsSeen = 0;
    let rowsRecognized = 0;
    const seenOrderIds = new Set<string>();
    while (pages < config.max_pages && rawOrders.length < config.max_records) {
      const list = await adapter.collectVisibleOrders(page, { skip_order_ids: seenOrderIds });
      const pageOrders: RawOrder[] = [...list.orders];
      for (const card of list.unparsed) {
        let detail: RawOrder | null = null;
        try {
          detail = await adapter.readOrderDetail(page, card);
        } catch (error) {
          logger.warn({
            command: "sync-once",
            platform,
            message: `detail read failed: ${(error as Error).message}`,
          });
        }
        const recheck = await checkPageState(page, adapter);
        if (recheck.status !== "OK") {
          updateCursor(config.state_dir, platform, accountKey, {
            last_status: recheck.status,
            last_sync_at: nowIso(),
          });
          logger.error({
            command: "sync-once",
            platform,
            status: recheck.status,
            message: `while reading order detail: ${recheck.detail}`,
            error_code: recheck.status,
          });
          const report = buildReport("sync-once", platform, "dry-run", null, recheck.status, recheck.status, startedAt, emptyCounts(), warnings);
          writeReportFile(config, platform, report, [], logger);
          return { exitCode: 1, report };
        }
        if (detail === null || detail.platform_order_id === null || detail.platform_order_id.length === 0) {
          updateCursor(config.state_dir, platform, accountKey, {
            last_status: "SCHEMA_CHANGED",
            last_sync_at: nowIso(),
            consecutive_failures: (loadCursor(config.state_dir, platform, accountKey)?.consecutive_failures ?? 0) + 1,
          });
          logger.error({
            command: "sync-once",
            platform,
            status: "SCHEMA_CHANGED",
            message: `order detail could not be parsed (${card.hint})`,
            error_code: "SCHEMA_CHANGED",
          });
          const report = buildReport("sync-once", platform, "dry-run", null, "SCHEMA_CHANGED", "SCHEMA_CHANGED", startedAt, emptyCounts(), warnings);
          writeReportFile(config, platform, report, [], logger);
          return { exitCode: 1, report };
        }
        if (card.missing.includes("logistics")) {
          const logistics = detail.detail_logistics;
          let logisticsFailure: string | null = null;
          if (logistics === undefined || !logistics.area_found) {
            logisticsFailure = "detail page has no visible logistics area";
          } else if (logistics.unparsed_rows > 0) {
            logisticsFailure = `${logistics.unparsed_rows} logistics row(s) on the detail page could not be parsed`;
          } else if (detail.packages.length === 0) {
            logisticsFailure = "detail page logistics are empty";
          }
          if (logisticsFailure !== null) {
            updateCursor(config.state_dir, platform, accountKey, {
              last_status: "SCHEMA_CHANGED",
              last_sync_at: nowIso(),
              consecutive_failures: (loadCursor(config.state_dir, platform, accountKey)?.consecutive_failures ?? 0) + 1,
            });
            logger.error({
              command: "sync-once",
              platform,
              status: "SCHEMA_CHANGED",
              message: `${logisticsFailure}; order ${detail.platform_order_id}`,
              error_code: "SCHEMA_CHANGED",
            });
            const report = buildReport("sync-once", platform, "dry-run", null, "SCHEMA_CHANGED", "SCHEMA_CHANGED", startedAt, emptyCounts(), warnings);
            writeReportFile(config, platform, report, [], logger);
            return { exitCode: 1, report };
          }
        }
        pageOrders.push(detail);
      }
      const mergedPage = mergeRawOrdersByOrderId(pageOrders, { laterWins: true });
      for (const raw of mergedPage) {
        if (raw.platform_order_id !== null && raw.platform_order_id.length > 0) {
          seenOrderIds.add(raw.platform_order_id.trim());
        }
        const statusText = raw.status === null ? "" : raw.status.trim();
        const mapped = statusText.length === 0 ? null : adapter.statusMap[statusText];
        if (
          (mapped === "SHIPPED" || mapped === "COMPLETED") &&
          raw.packages.length === 0
        ) {
          updateCursor(config.state_dir, platform, accountKey, {
            last_status: "SCHEMA_CHANGED",
            last_sync_at: nowIso(),
            consecutive_failures: (loadCursor(config.state_dir, platform, accountKey)?.consecutive_failures ?? 0) + 1,
          });
          logger.error({
            command: "sync-once",
            platform,
            status: "SCHEMA_CHANGED",
            message: `shipped order ${raw.platform_order_id} has no complete logistics block after detail read`,
            error_code: "SCHEMA_CHANGED",
          });
          const report = buildReport("sync-once", platform, "dry-run", null, "SCHEMA_CHANGED", "SCHEMA_CHANGED", startedAt, emptyCounts(), warnings);
          writeReportFile(config, platform, report, [], logger);
          return { exitCode: 1, report };
        }
      }
      rowsSeen += list.rows_seen;
      rowsRecognized += list.recognized;
      if (mergedPage.length === 0) {
        if (list.empty) {
          sawEmptyList = true;
        } else if (pages > 0) {
          warnings.push("pagination produced no new orders; stopping");
          logger.warn({
            command: "sync-once",
            platform,
            message: "no new orders after page change; stopping pagination",
          });
        }
        break;
      }
      const remaining = config.max_records - rawOrders.length;
      rawOrders.push(...mergedPage.slice(0, remaining));
      pages += 1;
      if (rawOrders.length >= config.max_records || pages >= config.max_pages) break;
      let advanced = false;
      try {
        advanced = await adapter.advancePage(page);
      } catch (error) {
        logger.warn({
          command: "sync-once",
          platform,
          message: `page advance failed: ${(error as Error).message}; stopping`,
        });
      }
      if (!advanced) {
        warnings.push("pagination ended");
        break;
      }
      const recheck = await checkPageState(page, adapter);
      if (recheck.status !== "OK") {
        updateCursor(config.state_dir, platform, accountKey, {
          last_status: recheck.status,
          last_sync_at: nowIso(),
        });
        logger.error({
          command: "sync-once",
          platform,
          status: recheck.status,
          message: `after page ${pages}: ${recheck.detail}`,
          error_code: recheck.status,
        });
        const report = buildReport("sync-once", platform, "dry-run", null, recheck.status, recheck.status, startedAt, emptyCounts(), warnings);
        writeReportFile(config, platform, report, [], logger);
        return { exitCode: 1, report };
      }
      if (config.page_delay_ms > 0) {
        await new Promise((resolve) => setTimeout(resolve, config.page_delay_ms));
      }
    }

    if (sawEmptyList && rawOrders.length === 0) {
      logger.warn({
        command: "sync-once",
        platform,
        message: "order list is empty; nothing to read and no server data will be overwritten",
      });
      warnings.push("order list was empty; nothing uploaded");
    }

    const extracted: ExtractResult[] = rawOrders.map((raw) =>
      buildUnifiedOrder(raw, platform, accountKey, adapter.statusMap),
    );
    const anyIssues = extracted.flatMap((result) => result.issues);
    if (anyIssues.length > 0) {
      updateCursor(config.state_dir, platform, accountKey, {
        last_status: "SCHEMA_CHANGED",
        last_sync_at: nowIso(),
        consecutive_failures: (loadCursor(config.state_dir, platform, accountKey)?.consecutive_failures ?? 0) + 1,
      });
      logger.error({
        command: "sync-once",
        platform,
        status: "SCHEMA_CHANGED",
        message: `parse issues: ${anyIssues.slice(0, 5).join("; ")}${anyIssues.length > 5 ? "…" : ""}`,
        error_code: "SCHEMA_CHANGED",
        counts: { issues: anyIssues.length },
      });
      const report = buildReport(
        "sync-once",
        platform,
        "dry-run",
        null,
        "SCHEMA_CHANGED",
        "SCHEMA_CHANGED",
        startedAt,
        { ...emptyCounts(), seen: rawOrders.length, errors: anyIssues.length },
        warnings,
      );
      writeReportFile(config, platform, report, [], logger);
      return { exitCode: 1, report };
    }

    const orders = dedupeOrders(
      extracted.flatMap((result) => (result.order !== null ? [result.order] : [])),
    );
    const counts: BatchCounts = {
      seen: rawOrders.length,
      valid: orders.length,
      skipped: rawOrders.length - orders.length,
      uploaded: 0,
      created: 0,
      updated: 0,
      errors: 0,
    };

    const batchId = randomUUID();
    const finishedAt = nowIso();
    const batch: SyncBatch = {
      schema_version: SCHEMA_VERSION,
      batch_id: batchId,
      worker_id: config.worker_id,
      platform,
      platform_account_key: accountKey,
      started_at: startedAt,
      finished_at: finishedAt,
      cursor_before: loadCursor(config.state_dir, platform, accountKey)?.last_cursor ?? null,
      cursor_after: finishedAt,
      mode: "commit",
      orders,
    };
    const snapshot: Snapshot = buildSnapshot(batch);
    const snapshotPath = writeSnapshot(config.state_dir, snapshot);

    logger.info({
      command: "sync-once",
      platform,
      batch_id: batchId,
      message: `dry-run complete; snapshot saved to ${snapshotPath}`,
      counts: { seen: counts.seen, valid: counts.valid, rows_seen: rowsSeen, rows_recognized: rowsRecognized, pages },
    });
    const report = buildReport("sync-once", platform, "dry-run", batchId, "OK", null, startedAt, counts, warnings, snapshotPath);
    writeReportFile(config, platform, report, orders, logger);
    return { exitCode: 0, report };
  } finally {
    if (browser !== null) {
      await browser.close().catch(() => undefined);
    }
    lock.release();
  }
}

async function runCommit(options: RunOptions): Promise<RunOutcome> {
  const { config, platform, confirm, logger } = options;
  const accountKey = config.account_keys[platform];
  const startedAt = nowIso();

  if (options.snapshotPath === undefined || options.snapshotPath.trim().length === 0) {
    logger.error({
      command: "sync-once",
      platform,
      message: "commit requires a dry-run snapshot (--from-report); commit never re-opens the browser",
      error_code: "CONFIG",
    });
    return {
      exitCode: 1,
      report: buildReport("sync-once", platform, "commit", null, "DISABLED", "CONFIG", startedAt, emptyCounts(), []),
    };
  }
  const snapshot = readSnapshot(options.snapshotPath);
  if (snapshot === null) {
    logger.error({
      command: "sync-once",
      platform,
      message: `snapshot not found or unreadable: ${options.snapshotPath}`,
      error_code: "SNAPSHOT_INVALID",
    });
    return {
      exitCode: 1,
      report: buildReport("sync-once", platform, "commit", null, "DISABLED", "SNAPSHOT_INVALID", startedAt, emptyCounts(), []),
    };
  }
  const verification = verifySnapshot(snapshot);
  if (!verification.ok) {
    logger.error({
      command: "sync-once",
      platform,
      message: `${verification.reason ?? "snapshot verification failed"}; re-run dry-run`,
      error_code: "SNAPSHOT_INVALID",
    });
    return {
      exitCode: 1,
      report: buildReport("sync-once", platform, "commit", snapshot.batch_id, "DISABLED", "SNAPSHOT_INVALID", startedAt, emptyCounts(), []),
    };
  }
  if (snapshot.platform !== platform || snapshot.platform_account_key !== accountKey) {
    logger.error({
      command: "sync-once",
      platform,
      message: `snapshot is for ${snapshot.platform}:${snapshot.platform_account_key}, not ${platform}:${accountKey}`,
      error_code: "SNAPSHOT_INVALID",
    });
    return {
      exitCode: 1,
      report: buildReport("sync-once", platform, "commit", snapshot.batch_id, "DISABLED", "SNAPSHOT_INVALID", startedAt, emptyCounts(), []),
    };
  }
  if (snapshot.orders.length === 0) {
    logger.error({
      command: "sync-once",
      platform,
      batch_id: snapshot.batch_id,
      message: "snapshot contains no orders; nothing to upload, re-run dry-run",
      error_code: "EMPTY_SNAPSHOT",
    });
    return {
      exitCode: 1,
      report: buildReport("sync-once", platform, "commit", snapshot.batch_id, "DISABLED", "EMPTY_SNAPSHOT", startedAt, emptyCounts(), [], options.snapshotPath),
    };
  }
  const timeResult = evaluateSnapshotTime(snapshot);
  if (timeResult.state !== "ok") {
    const errorCode = timeResult.state === "expired" ? "EXPIRED_SNAPSHOT" : "SNAPSHOT_INVALID";
    logger.error({
      command: "sync-once",
      platform,
      batch_id: snapshot.batch_id,
      message: `${timeResult.reason ?? "snapshot time check failed"}; re-run dry-run`,
      error_code: errorCode,
    });
    return {
      exitCode: 1,
      report: buildReport("sync-once", platform, "commit", snapshot.batch_id, "DISABLED", errorCode, startedAt, emptyCounts(), [], options.snapshotPath),
    };
  }
  const batch = snapshotToBatch(snapshot);
  if (batch === null) {
    logger.error({ command: "sync-once", platform, message: "snapshot payload is invalid", error_code: "SNAPSHOT_INVALID" });
    return {
      exitCode: 1,
      report: buildReport("sync-once", platform, "commit", snapshot.batch_id, "DISABLED", "SNAPSHOT_INVALID", startedAt, emptyCounts(), []),
    };
  }
  if (!confirm) {
    logger.error({
      command: "sync-once",
      platform,
      batch_id: snapshot.batch_id,
      message: "commit requires an explicit --yes confirmation after reviewing the dry-run report",
      error_code: "CONFIRM_REQUIRED",
    });
    const counts = { ...emptyCounts(), seen: batch.orders.length, valid: batch.orders.length };
    return {
      exitCode: 1,
      report: buildReport("sync-once", platform, "commit", snapshot.batch_id, "DISABLED", "CONFIRM_REQUIRED", startedAt, counts, [], options.snapshotPath),
    };
  }
  if (config.worker_key.length === 0) {
    logger.error({ command: "sync-once", platform, message: "worker key is not configured; commit is disabled", error_code: "CONFIG" });
    return {
      exitCode: 1,
      report: buildReport("sync-once", platform, "commit", snapshot.batch_id, "DISABLED", "CONFIG", startedAt, emptyCounts(), [], options.snapshotPath),
    };
  }

  const lock = acquireLock(config.state_dir, platform, accountKey, config.worker_id);
  if (!lock.held) {
    logger.error({
      command: "sync-once",
      platform,
      message: `another sync is running for ${platform}:${accountKey} (${describeHolder(lock.holder)})`,
      error_code: "LOCKED",
    });
    return {
      exitCode: 1,
      report: buildReport("sync-once", platform, "commit", snapshot.batch_id, "DISABLED", "LOCKED", startedAt, emptyCounts(), [], options.snapshotPath),
    };
  }
  try {
    const cursor = loadCursor(config.state_dir, platform, accountKey);
    if (config.min_interval_minutes > 0 && cursor?.last_sync_at) {
      const elapsedMinutes = (Date.now() - new Date(cursor.last_sync_at).getTime()) / 60_000;
      if (elapsedMinutes < config.min_interval_minutes) {
        logger.warn({
          command: "sync-once",
          platform,
          message: `last sync was ${Math.floor(elapsedMinutes)} min ago; minimum interval is ${config.min_interval_minutes} min`,
          error_code: "RATE_LIMITED",
        });
        const counts = { ...emptyCounts(), seen: batch.orders.length, valid: batch.orders.length };
        return {
          exitCode: 1,
          report: buildReport("sync-once", platform, "commit", snapshot.batch_id, "OK", "RATE_LIMITED", startedAt, counts, [], options.snapshotPath),
        };
      }
    }
    const currentCursor = cursor?.last_cursor ?? null;
    const snapshotCursor = batch.cursor_before ?? null;
    if (currentCursor !== snapshotCursor) {
      logger.error({
        command: "sync-once",
        platform,
        batch_id: snapshot.batch_id,
        message: `snapshot cursor_before (${snapshotCursor ?? "null"}) does not match the current cursor (${currentCursor ?? "null"}); re-run dry-run`,
        error_code: "CURSOR_MISMATCH",
      });
      const counts = { ...emptyCounts(), seen: batch.orders.length, valid: batch.orders.length };
      return {
        exitCode: 1,
        report: buildReport("sync-once", platform, "commit", snapshot.batch_id, "DISABLED", "CURSOR_MISMATCH", startedAt, counts, [], options.snapshotPath),
      };
    }

    const counts = {
      ...emptyCounts(),
      seen: batch.orders.length,
      valid: batch.orders.length,
    };
    try {
      const response = await postBatch(
        {
          api_base_url: config.api_base_url,
          worker_key: config.worker_key,
        },
        batch,
      );
      updateCursor(config.state_dir, platform, accountKey, {
        last_status: "OK",
        last_success_at: nowIso(),
        last_sync_at: nowIso(),
        last_cursor: batch.cursor_after,
        last_batch_id: snapshot.batch_id,
        consecutive_failures: 0,
      });
      logger.info({
        command: "sync-once",
        platform,
        batch_id: snapshot.batch_id,
        status: "OK",
        message: "snapshot batch accepted by server",
        counts: {
          seen: counts.seen,
          valid: counts.valid,
          uploaded: batch.orders.length,
          created: response.created,
          updated: response.updated,
          skipped: response.skipped,
        },
      });
      const report = buildReport(
        "sync-once",
        platform,
        "commit",
        snapshot.batch_id,
        "OK",
        null,
        startedAt,
        { ...counts, uploaded: batch.orders.length, created: response.created, updated: response.updated },
        [],
        options.snapshotPath,
      );
      writeReportFile(config, platform, report, batch.orders, logger);
      return { exitCode: 0, report };
    } catch (error) {
      const transport = error instanceof TransportError ? error : null;
      updateCursor(config.state_dir, platform, accountKey, {
        last_status: "NETWORK_ERROR",
        last_sync_at: nowIso(),
        consecutive_failures: (cursor?.consecutive_failures ?? 0) + 1,
      });
      logger.error({
        command: "sync-once",
        platform,
        batch_id: snapshot.batch_id,
        status: "NETWORK_ERROR",
        error_code: transport?.kind ?? "NETWORK_ERROR",
        message: transport?.message ?? (error as Error).message,
        counts: { uploaded: 0 },
      });
      const report = buildReport(
        "sync-once",
        platform,
        "commit",
        snapshot.batch_id,
        "NETWORK_ERROR",
        transport?.kind ?? "NETWORK_ERROR",
        startedAt,
        counts,
        [],
        options.snapshotPath,
      );
      writeReportFile(config, platform, report, batch.orders, logger);
      return { exitCode: 1, report };
    }
  } finally {
    lock.release();
  }
}
