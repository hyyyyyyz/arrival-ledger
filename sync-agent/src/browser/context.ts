import { chromium, type BrowserContext } from "playwright";

import type { BrowserRuntimeConfig } from "../config.js";
import type { Platform } from "../models.js";
import { prepareProfileDirForBrowser } from "../profile_path.js";

export interface SyncBrowser {
  context: BrowserContext;
  close: () => Promise<void>;
}

export const DEFAULT_BROWSER_RUNTIME: BrowserRuntimeConfig = {
  display: null,
  channel: null,
  executable_path: null,
};

type PersistentContextOptions = NonNullable<
  Parameters<typeof chromium.launchPersistentContext>[1]
>;

const SENSITIVE_BROWSER_ENV_KEY = /(TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

function browserProcessEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        entry[0] !== "ARRIVAL_SYNC_WORKER_KEY" &&
        !SENSITIVE_BROWSER_ENV_KEY.test(entry[0]),
    ),
  );
}

export function effectiveBrowserDisplay(
  runtime: BrowserRuntimeConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return runtime.display ?? env["DISPLAY"] ?? null;
}

export function headedRuntimeIssue(
  runtime: BrowserRuntimeConfig,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): string | null {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return null;
  const display = effectiveBrowserDisplay(runtime, options.env ?? process.env);
  return display === null || display.trim().length === 0
    ? "Linux visible-browser mode requires DISPLAY; start Xvfb/noVNC and set PDD_BROWSER_DISPLAY=:99"
    : null;
}

export function buildPersistentContextOptions(
  runtime: BrowserRuntimeConfig = DEFAULT_BROWSER_RUNTIME,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): PersistentContextOptions {
  const display = effectiveBrowserDisplay(runtime, env);
  const browserEnv = browserProcessEnv(env);
  if (display !== null) browserEnv["DISPLAY"] = display;
  return {
    headless: false,
    viewport: { width: 1280, height: 900 },
    ...(runtime.channel === null ? {} : { channel: runtime.channel }),
    ...(runtime.executable_path === null ? {} : { executablePath: runtime.executable_path }),
    // Playwright disables Chromium's sandbox by default.  The server Agent is
    // Linux-only and runs a browser against an untrusted public site, so keep
    // Chromium's user-namespace sandbox enabled there.  Do not alter the
    // established macOS/Windows desktop launch behaviour.
    ...(platform === "linux" ? { chromiumSandbox: true } : {}),
    env: browserEnv,
  };
}

export function browserRuntimeLabel(runtime: BrowserRuntimeConfig): string {
  if (runtime.executable_path !== null) return `executable ${runtime.executable_path}`;
  if (runtime.channel !== null) return `channel ${runtime.channel}`;
  return "Playwright bundled Chromium";
}

const ALLOWED_ORDER_LIST_HOSTS: Record<Platform, readonly string[]> = {
  pdd: ["yangkeduo.com"],
  "1688": ["1688.com"],
};

export function assertAllowedOrderListUrl(platform: Platform, url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`order list URL is not a valid URL: ${url.slice(0, 64)}`);
  }
  const allowed = ALLOWED_ORDER_LIST_HOSTS[platform].some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
  if (!allowed) {
    throw new Error(
      `order list host "${host}" is not an official ${platform} domain; refusing to open it`,
    );
  }
}

export async function launchSyncBrowser(
  profileDir: string,
  runtime: BrowserRuntimeConfig = DEFAULT_BROWSER_RUNTIME,
): Promise<SyncBrowser> {
  const runtimeIssue = headedRuntimeIssue(runtime);
  if (runtimeIssue !== null) throw new Error(runtimeIssue);
  const safeProfileDir = prepareProfileDirForBrowser(profileDir);
  const context = await chromium.launchPersistentContext(
    safeProfileDir,
    buildPersistentContextOptions(runtime),
  );
  return {
    context,
    close: async () => {
      await context.close();
    },
  };
}
