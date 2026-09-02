import { existsSync } from "node:fs";

import type { PlatformAdapter } from "./adapters/base.js";
import { getAdapter } from "./adapters/index.js";
import { launchSyncBrowser } from "./browser/context.js";
import { checkPageState } from "./browser/guards.js";
import type { SyncConfig } from "./config.js";
import {
  captureSanitizedStructure,
  writeSanitizedCapture,
} from "./diagnostics/dom_capture.js";
import type { JsonLogger } from "./log.js";
import type { Platform } from "./models.js";
import type { BrowserLauncher } from "./run.js";
import { acquireLock, describeHolder } from "./state/lock.js";
import { reservePlatformAccess } from "./state/platform_access.js";

export interface CapturePageOptions {
  config: SyncConfig;
  platform: Platform;
  logger: JsonLogger;
  launcher?: BrowserLauncher;
  adapter?: PlatformAdapter;
}

export interface CapturePageOutcome {
  exitCode: number;
  path: string | null;
  status: "OK" | "NEEDS_LOGIN" | "CAPTCHA_OR_BLOCKED" | "DISABLED";
}

export async function runCapturePage(options: CapturePageOptions): Promise<CapturePageOutcome> {
  const { config, platform, logger } = options;
  const accountKey = config.account_keys[platform];
  const profileDir = config.profile_dirs[platform];
  if (!existsSync(profileDir)) {
    logger.error({
      command: "capture-page",
      platform,
      message: `profile dir does not exist: ${profileDir}; run login-check first`,
      error_code: "CONFIG",
    });
    return { exitCode: 1, path: null, status: "DISABLED" };
  }
  const platformLock = platform === "pdd"
    ? acquireLock(config.state_dir, platform, "__browser-global__", config.worker_id)
    : null;
  if (platformLock !== null && !platformLock.held) {
    logger.error({
      command: "capture-page",
      platform,
      message: `another PDD browser operation is running (${describeHolder(platformLock.holder)})`,
      error_code: "LOCKED",
    });
    return { exitCode: 1, path: null, status: "DISABLED" };
  }
  const releasePlatformLock = platformLock?.held === true ? platformLock.release : () => undefined;
  const lock = acquireLock(config.state_dir, platform, accountKey, config.worker_id);
  if (!lock.held) {
    releasePlatformLock();
    logger.error({
      command: "capture-page",
      platform,
      message: `another sync is running (${describeHolder(lock.holder)})`,
      error_code: "LOCKED",
    });
    return { exitCode: 1, path: null, status: "DISABLED" };
  }

  const adapter = options.adapter ?? getAdapter(platform);
  const launcher = options.launcher ?? launchSyncBrowser;
  let browser: Awaited<ReturnType<BrowserLauncher>> | null = null;
  try {
    let access;
    try {
      access = reservePlatformAccess(
        config.state_dir,
        platform,
        accountKey,
        "capture-page",
        config.min_interval_minutes,
      );
    } catch {
      logger.error({
        command: "capture-page",
        platform,
        message: "platform access state is invalid; no browser was opened",
        error_code: "STATE_INVALID",
      });
      return { exitCode: 1, path: null, status: "DISABLED" };
    }
    if (!access.allowed) {
      logger.warn({
        command: "capture-page",
        platform,
        message: `platform page cooldown is active; retry after ${access.retry_after_seconds}s`,
        error_code: "RATE_LIMITED",
      });
      return { exitCode: 1, path: null, status: "DISABLED" };
    }
    browser = await launcher(profileDir, config.browser);
    const page = browser.context.pages()[0] ?? (await browser.context.newPage());
    await adapter.openOrders(page, {
      max_pages: 1,
      max_records: 1,
      order_list_url: config.order_list_urls[platform],
    });
    const state = await checkPageState(page, adapter);
    if (state.status !== "OK") {
      logger.error({
        command: "capture-page",
        platform,
        status: state.status,
        message: `${state.detail}; no diagnostic was saved`,
        error_code: state.status,
      });
      return { exitCode: 1, path: null, status: state.status };
    }
    const capture = await captureSanitizedStructure(page, platform);
    const path = writeSanitizedCapture(config.state_dir, capture);
    logger.info({
      command: "capture-page",
      platform,
      status: "OK",
      message: `sanitized structural diagnostic written to ${path}`,
      counts: {
        nodes: capture.nodes.length,
        truncated: capture.truncated ? 1 : 0,
      },
    });
    return { exitCode: 0, path, status: "OK" };
  } catch (error) {
    logger.error({
      command: "capture-page",
      platform,
      message: "capture failed before a safe diagnostic could be written",
      error_code: "CAPTURE_FAILED",
    });
    return { exitCode: 1, path: null, status: "DISABLED" };
  } finally {
    if (browser !== null) await browser.close().catch(() => undefined);
    lock.release();
    releasePlatformLock();
  }
}
