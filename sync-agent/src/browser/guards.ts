import type { Page } from "playwright";

import type { PlatformAdapter } from "../adapters/base.js";
import type { SyncStatus } from "../models.js";

export interface PageStateCheck {
  status: Extract<SyncStatus, "OK" | "NEEDS_LOGIN" | "CAPTCHA_OR_BLOCKED">;
  detail: string;
}

export async function checkPageState(
  page: Page,
  adapter: PlatformAdapter,
): Promise<PageStateCheck> {
  const block = await adapter.detectBlock(page);
  if (block.blocked) {
    return { status: "CAPTCHA_OR_BLOCKED", detail: `${block.kind}: ${block.detail}` };
  }
  const login = await adapter.detectLogin(page);
  if (!login.logged_in) {
    return { status: "NEEDS_LOGIN", detail: login.detail };
  }
  return { status: "OK", detail: login.detail };
}
