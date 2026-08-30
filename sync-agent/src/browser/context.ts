import { chromium, type BrowserContext } from "playwright";

import type { Platform } from "../models.js";
import { prepareProfileDirForBrowser } from "../profile_path.js";

export interface SyncBrowser {
  context: BrowserContext;
  close: () => Promise<void>;
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

export async function launchSyncBrowser(profileDir: string): Promise<SyncBrowser> {
  const safeProfileDir = prepareProfileDirForBrowser(profileDir);
  const context = await chromium.launchPersistentContext(safeProfileDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  return {
    context,
    close: async () => {
      await context.close();
    },
  };
}
