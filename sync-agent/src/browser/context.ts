import { chromium, type BrowserContext } from "playwright";

export interface SyncBrowser {
  context: BrowserContext;
  close: () => Promise<void>;
}

export async function launchSyncBrowser(profileDir: string): Promise<SyncBrowser> {
  const context = await chromium.launchPersistentContext(profileDir, {
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
