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
    items: order.items.length,
    packages: order.packages.map((item) => item.tracking_no),
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

export async function runSyncOnce(options: RunOptions): Promise<RunOutcome> {
  const { config, platform, mode, confirm, logger } = options;
  const accountKey = config.account_keys[platform];
  const startedAt = nowIso();
  const emptyCounts = (): BatchCounts => ({
    seen: 0,
    valid: 0,
    skipped: 0,
    uploaded: 0,
    created: 0,
    updated: 0,
    errors: 0,
  });

  const profileDir = config.profile_dirs[platform];
  if (!existsSync(profileDir)) {
    logger.error({
      command: "sync-once",
      platform,
      message: `profile dir does not exist: ${profileDir}; run the browser once to create it (login-check)`,
      error_code: "CONFIG",
    });
    return {
      exitCode: 1,
      report: buildReport("sync-once", platform, mode, null, "DISABLED", "CONFIG", startedAt, emptyCounts(), []),
    };
  }
  if (mode === "commit" && config.worker_key.length === 0) {
    logger.error({
      command: "sync-once",
      platform,
      message: "worker key is not configured; commit is disabled",
      error_code: "CONFIG",
    });
    return {
      exitCode: 1,
      report: buildReport("sync-once", platform, mode, null, "DISABLED", "CONFIG", startedAt, emptyCounts(), []),
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
      report: buildReport("sync-once", platform, mode, null, "DISABLED", "LOCKED", startedAt, emptyCounts(), []),
    };
  }

  const cursor = loadCursor(config.state_dir, platform, accountKey);
  if (mode === "commit" && config.min_interval_minutes > 0 && cursor?.last_sync_at !== null && cursor?.last_sync_at !== undefined) {
    const last = new Date(cursor.last_sync_at).getTime();
    const elapsedMinutes = (Date.now() - last) / 60_000;
    if (elapsedMinutes < config.min_interval_minutes) {
      lock.release();
      logger.warn({
        command: "sync-once",
        platform,
        message: `last sync was ${Math.floor(elapsedMinutes)} min ago; minimum interval is ${config.min_interval_minutes} min`,
        error_code: "RATE_LIMITED",
      });
      return {
        exitCode: 1,
        report: buildReport("sync-once", platform, mode, null, "OK", "RATE_LIMITED", startedAt, emptyCounts(), []),
      };
    }
  }

  const adapter = options.adapter ?? getAdapter(platform);
  const launcher = options.launcher ?? launchSyncBrowser;
  let browser: SyncBrowser | null = null;
  try {
    browser = await launcher(profileDir);
    const page = browser.context.pages()[0] ?? (await browser.context.newPage());
    await adapter.openOrders(page, { max_pages: config.max_pages, max_records: config.max_records });

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
      const report = buildReport("sync-once", platform, mode, null, state.status, state.status, startedAt, emptyCounts(), []);
      writeReportFile(config, platform, report, [], logger);
      return { exitCode: 1, report };
    }

    const rawOrders: RawOrder[] = [];
    const warnings: string[] = [];
    let pages = 0;
    let sawEmptyList = false;
    let rowsSeen = 0;
    let rowsRecognized = 0;
    while (pages < config.max_pages && rawOrders.length < config.max_records) {
      const list = await adapter.collectVisibleOrders(page);
      rowsSeen += list.rows_seen;
      rowsRecognized += list.recognized;
      if (list.rows_seen > 0 && list.recognized === 0) {
        updateCursor(config.state_dir, platform, accountKey, {
          last_status: "SCHEMA_CHANGED",
          last_sync_at: nowIso(),
          consecutive_failures: cursor !== null ? cursor.consecutive_failures + 1 : 1,
        });
        logger.error({
          command: "sync-once",
          platform,
          status: "SCHEMA_CHANGED",
          message: `page ${pages + 1}: ${list.rows_seen} order rows visible but none could be parsed`,
          error_code: "SCHEMA_CHANGED",
        });
        const report = buildReport("sync-once", platform, mode, null, "SCHEMA_CHANGED", "SCHEMA_CHANGED", startedAt, emptyCounts(), []);
        writeReportFile(config, platform, report, [], logger);
        return { exitCode: 1, report };
      }
      if (list.empty && list.orders.length === 0) {
        sawEmptyList = true;
        break;
      }
      rawOrders.push(...list.orders);
      pages += 1;
      if (rawOrders.length >= config.max_records || pages >= config.max_pages) break;
      const advanced = await adapter.advancePage(page);
      if (!advanced) break;
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
        consecutive_failures: cursor !== null ? cursor.consecutive_failures + 1 : 1,
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
        mode,
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
    if (mode === "dry-run") {
      logger.info({
        command: "sync-once",
        platform,
        batch_id: batchId,
        message: "dry-run complete; nothing was uploaded",
        counts: { seen: counts.seen, valid: counts.valid, rows_seen: rowsSeen, rows_recognized: rowsRecognized, pages },
      });
      const report = buildReport("sync-once", platform, mode, batchId, "OK", null, startedAt, counts, warnings);
      writeReportFile(config, platform, report, orders, logger);
      return { exitCode: 0, report };
    }

    if (orders.length === 0) {
      const report = buildReport("sync-once", platform, mode, batchId, "OK", null, startedAt, counts, warnings);
      writeReportFile(config, platform, report, [], logger);
      return { exitCode: 0, report };
    }
    if (!confirm) {
      logger.error({
        command: "sync-once",
        platform,
        batch_id: batchId,
        message: "commit requires an explicit --yes confirmation after reviewing the dry-run report",
        error_code: "CONFIRM_REQUIRED",
      });
      const report = buildReport("sync-once", platform, mode, batchId, "DISABLED", "CONFIRM_REQUIRED", startedAt, counts, warnings);
      writeReportFile(config, platform, report, orders, logger);
      return { exitCode: 1, report };
    }

    const finishedAt = nowIso();
    const batch: SyncBatch = {
      schema_version: SCHEMA_VERSION,
      batch_id: batchId,
      worker_id: config.worker_id,
      platform,
      platform_account_key: accountKey,
      started_at: startedAt,
      finished_at: finishedAt,
      cursor_before: cursor?.last_cursor ?? null,
      cursor_after: finishedAt,
      mode: "commit",
      orders,
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
        last_cursor: finishedAt,
        last_batch_id: batchId,
        consecutive_failures: 0,
      });
      logger.info({
        command: "sync-once",
        platform,
        batch_id: batchId,
        status: "OK",
        message: "batch accepted by server",
        counts: {
          seen: counts.seen,
          valid: counts.valid,
          uploaded: orders.length,
          created: response.created,
          updated: response.updated,
          skipped: response.skipped,
          pages,
        },
      });
      const report = buildReport(
        "sync-once",
        platform,
        mode,
        batchId,
        "OK",
        null,
        startedAt,
        { ...counts, uploaded: orders.length, created: response.created, updated: response.updated },
        warnings,
      );
      writeReportFile(config, platform, report, orders, logger);
      return { exitCode: 0, report };
    } catch (error) {
      const transport = error instanceof TransportError ? error : null;
      updateCursor(config.state_dir, platform, accountKey, {
        last_status: "NETWORK_ERROR",
        last_sync_at: nowIso(),
        consecutive_failures: cursor !== null ? cursor.consecutive_failures + 1 : 1,
      });
      logger.error({
        command: "sync-once",
        platform,
        batch_id: batchId,
        status: "NETWORK_ERROR",
        error_code: transport?.kind ?? "NETWORK_ERROR",
        message: transport?.message ?? (error as Error).message,
        counts: { uploaded: 0 },
      });
      const report = buildReport(
        "sync-once",
        platform,
        mode,
        batchId,
        "NETWORK_ERROR",
        transport?.kind ?? "NETWORK_ERROR",
        startedAt,
        counts,
        warnings,
      );
      writeReportFile(config, platform, report, orders, logger);
      return { exitCode: 1, report };
    }
  } finally {
    if (browser !== null) {
      await browser.close().catch(() => undefined);
    }
    lock.release();
  }
}
