import { describe, expect, it } from "vitest";

import {
  buildPersistentContextOptions,
  effectiveBrowserDisplay,
  headedRuntimeIssue,
} from "../src/browser/context.js";
import type { BrowserRuntimeConfig } from "../src/config.js";

const bundled: BrowserRuntimeConfig = {
  display: null,
  channel: null,
  executable_path: null,
};

describe("visible browser runtime", () => {
  it("requires an X display on Linux but not on desktop operating systems", () => {
    expect(headedRuntimeIssue(bundled, { platform: "linux", env: {} })).toContain("DISPLAY");
    expect(headedRuntimeIssue(bundled, { platform: "darwin", env: {} })).toBeNull();
    expect(headedRuntimeIssue(bundled, { platform: "win32", env: {} })).toBeNull();
  });

  it("uses an explicit display before the inherited environment", () => {
    const runtime = { ...bundled, display: ":99" };
    expect(effectiveBrowserDisplay(runtime, { DISPLAY: ":1" })).toBe(":99");
    expect(headedRuntimeIssue(runtime, { platform: "linux", env: {} })).toBeNull();
    const options = buildPersistentContextOptions(runtime, {
      DISPLAY: ":1",
      LANG: "C.UTF-8",
      PATH: "/usr/bin",
      HOME: "/srv/arrival-sync",
      ARRIVAL_SYNC_WORKER_KEY: "do-not-inherit",
      ACCESS_TOKEN: "do-not-inherit",
      CLIENT_SECRET: "do-not-inherit",
      DB_PASSWORD: "do-not-inherit",
      GOOGLE_APPLICATION_CREDENTIALS: "/private/credential.json",
    });
    expect(options.headless).toBe(false);
    expect(options.viewport).toEqual({ width: 1280, height: 900 });
    expect(options.env?.["DISPLAY"]).toBe(":99");
    expect(options.env?.["LANG"]).toBe("C.UTF-8");
    expect(options.env?.["PATH"]).toBe("/usr/bin");
    expect(options.env?.["HOME"]).toBe("/srv/arrival-sync");
    expect(options.env).not.toHaveProperty("ARRIVAL_SYNC_WORKER_KEY");
    expect(options.env).not.toHaveProperty("ACCESS_TOKEN");
    expect(options.env).not.toHaveProperty("CLIENT_SECRET");
    expect(options.env).not.toHaveProperty("DB_PASSWORD");
    expect(options.env).not.toHaveProperty("GOOGLE_APPLICATION_CREDENTIALS");
  });

  it("selects either a Playwright channel or an explicit executable", () => {
    const channelOptions = buildPersistentContextOptions(
      { ...bundled, channel: "chrome" },
      {},
    );
    expect(channelOptions.channel).toBe("chrome");
    expect(channelOptions.executablePath).toBeUndefined();

    const executableOptions = buildPersistentContextOptions(
      { ...bundled, executable_path: "/opt/chromium/chrome" },
      {},
    );
    expect(executableOptions.executablePath).toBe("/opt/chromium/chrome");
    expect(executableOptions.channel).toBeUndefined();
  });

  it("enables the Chromium sandbox on Linux without changing desktop launches", () => {
    const linuxOptions = buildPersistentContextOptions(
      { ...bundled, display: ":99" },
      {},
      "linux",
    );
    expect(linuxOptions.chromiumSandbox).toBe(true);

    const macOptions = buildPersistentContextOptions(bundled, {}, "darwin");
    const windowsOptions = buildPersistentContextOptions(bundled, {}, "win32");
    expect(macOptions.chromiumSandbox).toBeUndefined();
    expect(windowsOptions.chromiumSandbox).toBeUndefined();
  });
});
