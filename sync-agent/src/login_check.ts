import { existsSync, mkdirSync } from "node:fs";

import type { Page } from "playwright";

import type { PlatformAdapter } from "./adapters/base.js";
import { getAdapter } from "./adapters/index.js";
import { launchSyncBrowser, type SyncBrowser } from "./browser/context.js";
import { checkPageState, type PageStateCheck } from "./browser/guards.js";
import type { SyncConfig } from "./config.js";
import type { JsonLogger } from "./log.js";
import type { Platform } from "./models.js";
import type { BrowserLauncher } from "./run.js";
import { acquireLock, describeHolder } from "./state/lock.js";
import { reservePlatformAccess } from "./state/platform_access.js";

export interface LoginCheckOptions {
  config: SyncConfig;
  platform: Platform;
  logger: JsonLogger;
  launcher?: BrowserLauncher;
  adapter?: PlatformAdapter;
  waitForInput?: () => Promise<void>;
  output?: (line: string) => void;
}

export interface LoginCheckOutcome {
  exitCode: number;
  state: PageStateCheck | null;
}

export function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const listeners = {
      onData: (chunk: Buffer) => {
        if (chunk.toString().includes("\n")) {
          process.stdin.off("data", listeners.onData);
          process.stdin.pause();
          resolve();
        }
      },
    };
    process.stdin.resume();
    process.stdin.on("data", listeners.onData);
  });
}

export async function runLoginCheck(options: LoginCheckOptions): Promise<LoginCheckOutcome> {
  const { config, platform, logger } = options;
  const accountKey = config.account_keys[platform];
  const profileDir = config.profile_dirs[platform];
  const write = options.output ?? ((line: string) => process.stdout.write(`${line}\n`));

  try {
    mkdirSync(profileDir, { recursive: true });
  } catch (error) {
    logger.error({
      command: "login-check",
      platform,
      message: `could not create profile dir ${profileDir}: ${(error as Error).message}`,
      error_code: "CONFIG",
    });
    return { exitCode: 1, state: null };
  }
  if (!existsSync(profileDir)) {
    logger.error({
      command: "login-check",
      platform,
      message: `profile dir is unavailable: ${profileDir}`,
      error_code: "CONFIG",
    });
    return { exitCode: 1, state: null };
  }

  const lock = acquireLock(config.state_dir, platform, accountKey, config.worker_id);
  if (!lock.held) {
    logger.error({
      command: "login-check",
      platform,
      message: `another sync is running (${describeHolder(lock.holder)})`,
      error_code: "LOCKED",
    });
    return { exitCode: 1, state: null };
  }

  const adapter = options.adapter ?? getAdapter(platform);
  const launcher = options.launcher ?? launchSyncBrowser;
  const waitForInput = options.waitForInput ?? waitForEnter;
  let browser: SyncBrowser | null = null;
  try {
    let access;
    try {
      access = reservePlatformAccess(
        config.state_dir,
        platform,
        accountKey,
        "login-check",
        config.min_interval_minutes,
      );
    } catch {
      logger.error({
        command: "login-check",
        platform,
        message: "platform access state is invalid; no browser was opened",
        error_code: "STATE_INVALID",
      });
      return { exitCode: 1, state: null };
    }
    if (!access.allowed) {
      write(`[WARN] ${platform} page cooldown is active; retry after ${access.retry_after_seconds}s.`);
      logger.warn({
        command: "login-check",
        platform,
        message: `platform page cooldown is active; retry after ${access.retry_after_seconds}s`,
        error_code: "RATE_LIMITED",
      });
      return { exitCode: 1, state: null };
    }
    browser = await launcher(profileDir);
    const page: Page = browser.context.pages()[0] ?? (await browser.context.newPage());
    await adapter.openOrders(page, {
      max_pages: 1,
      max_records: 1,
      order_list_url: config.order_list_urls[platform],
    });

    let state = await checkPageState(page, adapter);
    let attempts = 0;
    while (state.status === "NEEDS_LOGIN" || state.status === "CAPTCHA_OR_BLOCKED") {
      attempts += 1;
      if (state.status === "CAPTCHA_OR_BLOCKED") {
        write(`[WARN] ${platform} security verification: ${state.detail}`);
        write(
          "Please complete the visible verification manually. This tool never solves or bypasses captchas.",
        );
      } else {
        write(`[WARN] ${platform} login state: ${state.detail}`);
        write(
          "Please finish the login manually in the visible browser window. This tool never fills passwords, solves captchas or scans QR codes.",
        );
      }
      write("Press Enter here after the login is complete (Ctrl+C to abort)...");
      await waitForInput();
      state = await checkPageState(page, adapter);
    }

    if (state.status === "OK") {
      write(`[OK] ${platform} login state: ${state.detail}`);
      logger.info({ command: "login-check", platform, status: "OK", message: state.detail });
      return { exitCode: 0, state };
    }
    write(`[FAIL] ${platform} login state: ${state.detail}`);
    write("Fix the visible page manually and run login-check again.");
    logger.warn({ command: "login-check", platform, status: state.status, message: state.detail });
    return { exitCode: 1, state };
  } finally {
    if (browser !== null) await browser.close().catch(() => undefined);
    lock.release();
  }
}
