import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlatformAdapter } from "../src/adapters/base.js";
import type { SyncBrowser } from "../src/browser/context.js";
import { loadConfig } from "../src/config.js";
import type { BrowserLauncher } from "../src/run.js";
import { runLoginCheck, type LoginCheckOptions } from "../src/login_check.js";
import { JsonLogger } from "../src/log.js";

const createdDirs: string[] = [];

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "sync-agent-login-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeAdapter(overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    platform: "1688",
    orderListUrl: "https://example.invalid/orders",
    statusMap: {},
    openOrders: async () => undefined,
    detectLogin: async () => ({ logged_in: true, detail: "fake" }),
    detectBlock: async () => ({ blocked: false, kind: "unknown", detail: "fake" }),
    collectVisibleOrders: async () => ({ orders: [], empty: false, rows_seen: 0, recognized: 0, unparsed: [] }),
    advancePage: async () => false,
    readOrderDetail: async () => null,
    ...overrides,
  };
}

function fakeLauncher(): BrowserLauncher {
  const page = {} as Page;
  const browser: SyncBrowser = {
    context: {
      pages: () => [],
      newPage: async () => page,
    } as unknown as SyncBrowser["context"],
    close: async () => undefined,
  };
  return async () => browser;
}

function buildOptions(
  cwd: string,
  overrides: Partial<LoginCheckOptions> = {},
): LoginCheckOptions {
  const { config } = loadConfig({ cwd, env: {} });
  return {
    config,
    platform: "1688",
    logger: new JsonLogger({ logDir: null }),
    launcher: fakeLauncher(),
    adapter: fakeAdapter(),
    waitForInput: async () => undefined,
    output: () => undefined,
    ...overrides,
  };
}

describe("runLoginCheck", () => {
  it("creates the profile dir when it is missing", async () => {
    const cwd = tempCwd();
    const outcome = await runLoginCheck(buildOptions(cwd));
    expect(outcome.exitCode).toBe(0);
    expect(existsSync(join(cwd, "profiles", "1688"))).toBe(true);
  });

  it("reports success immediately when already logged in", async () => {
    const cwd = tempCwd();
    const output: string[] = [];
    const outcome = await runLoginCheck(
      buildOptions(cwd, { output: (line) => output.push(line) }),
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.state?.status).toBe("OK");
    expect(output.join(" ")).not.toContain("Press Enter");
  });

  it("waits for the user to log in and re-checks the state", async () => {
    const cwd = tempCwd();
    let loginState = false;
    let waitCalls = 0;
    const adapter = fakeAdapter({
      detectLogin: async () => ({
        logged_in: loginState,
        detail: loginState ? "logged in after manual login" : "still on the login wall",
      }),
    });
    const outcomePromise = runLoginCheck(
      buildOptions(cwd, {
        adapter,
        waitForInput: async () => {
          waitCalls += 1;
          loginState = true;
        },
      }),
    );
    const outcome = await outcomePromise;
    expect(outcome.exitCode).toBe(0);
    expect(outcome.state?.status).toBe("OK");
    expect(waitCalls).toBeGreaterThanOrEqual(1);
  });

  it("keeps the visible window open for manual captcha resolution", async () => {
    const cwd = tempCwd();
    let captcha = false;
    let loggedIn = false;
    let waitCalls = 0;
    const adapter = fakeAdapter({
      detectLogin: async () => ({ logged_in: loggedIn, detail: loggedIn ? "orders" : "login wall" }),
      detectBlock: async () =>
        captcha
          ? { blocked: true, kind: "captcha", detail: "slider appeared" }
          : { blocked: false, kind: "unknown", detail: "none" },
    });
    const outcome = await runLoginCheck(
      buildOptions(cwd, {
        adapter,
        waitForInput: async () => {
          waitCalls += 1;
          if (waitCalls === 1) captcha = true;
          else {
            captcha = false;
            loggedIn = true;
          }
        },
      }),
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.state?.status).toBe("OK");
    expect(waitCalls).toBe(2);
  });

  it("waits for manual resolution when already blocked", async () => {
    const cwd = tempCwd();
    let blocked = true;
    const adapter = fakeAdapter({
      detectBlock: async () =>
        blocked
          ? { blocked: true, kind: "captcha", detail: "blocked" }
          : { blocked: false, kind: "unknown", detail: "clear" },
    });
    let waitCalls = 0;
    const outcome = await runLoginCheck(
      buildOptions(cwd, {
        adapter,
        waitForInput: async () => {
          waitCalls += 1;
          blocked = false;
        },
      }),
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.state?.status).toBe("OK");
    expect(waitCalls).toBe(1);
  });

  it("fails when the profile dir cannot be created", async () => {
    const cwd = tempCwd();
    writeFileSync(join(cwd, "profiles"), "not-a-directory", "utf8");
    const outcome = await runLoginCheck(buildOptions(cwd));
    expect(outcome.exitCode).toBe(1);
  });

  it("uses the configured order list url via openOrders", async () => {
    const cwd = tempCwd();
    const opened: string[] = [];
    const adapter = fakeAdapter({
      openOrders: async (_page, window) => {
        opened.push(window.order_list_url ?? "");
      },
    });
    const { config } = loadConfig({
      cwd,
      env: { ALI1688_ORDER_URL: "https://air.1688.com/app/custom-orders" },
    });
    await runLoginCheck(
      buildOptions(cwd, {
        adapter,
        config,
      }),
    );
    expect(opened).toEqual(["https://air.1688.com/app/custom-orders"]);
  });
});
