import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig, type PddAccountConfig } from "../src/config.js";
import { JsonLogger } from "../src/log.js";
import type { RunOutcome } from "../src/run.js";
import {
  buildPddAccountStatusReport,
  postPddAccountStatusBestEffort,
  runPddSyncAll,
} from "../src/pdd_multi.js";

const createdDirs: string[] = [];

function tempConfig() {
  const cwd = mkdtempSync(join(tmpdir(), "sync-agent-pdd-multi-"));
  createdDirs.push(cwd);
  const { config } = loadConfig({
    cwd,
    env: { ARRIVAL_SYNC_WORKER_KEY: "worker-key-for-tests" },
  });
  config.pdd_accounts = [
    { account_key: "buyer.one", display_label: "采购一组", profile_dir: join(cwd, "profiles", "one") },
    { account_key: "buyer-two", display_label: "采购二组", profile_dir: join(cwd, "profiles", "two") },
    { account_key: "buyer-three", display_label: null, profile_dir: join(cwd, "profiles", "three") },
  ];
  return config;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function outcome(status: RunOutcome["report"]["status"], exitCode: number, count: number): RunOutcome {
  return {
    exitCode,
    report: {
      command: "sync-once",
      platform: "pdd",
      mode: "dry-run",
      batch_id: null,
      status,
      error_code: status === "OK" ? null : status,
      started_at: "2026-08-30T00:00:00.000Z",
      finished_at: "2026-08-30T00:00:01.000Z",
      counts: { seen: count, valid: count, skipped: 0, uploaded: 0, created: 0, updated: 0, errors: 0 },
      warnings: [],
      snapshot_path: null,
    },
  };
}

describe("PDD multi-account orchestration", () => {
  it("runs accounts strictly sequentially with isolated account/profile config", async () => {
    const config = tempConfig();
    const starts: string[] = [];
    const profiles: string[] = [];
    let active = 0;
    let maxActive = 0;
    const runner = vi.fn(async (selectedConfig, account: PddAccountConfig) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      starts.push(account.account_key);
      profiles.push(selectedConfig.profile_dirs.pdd);
      expect(selectedConfig.account_keys.pdd).toBe(account.account_key);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return outcome("OK", 0, 2);
    });
    const posted: string[] = [];
    const result = await runPddSyncAll({
      config,
      logger: new JsonLogger({ logDir: null }),
      output: () => undefined,
      runner,
      poster: async (_transport, report) => { posted.push(report.platform_account_key); },
    });
    expect(result.exitCode).toBe(0);
    expect(maxActive).toBe(1);
    expect(starts).toEqual(["buyer.one", "buyer-two", "buyer-three"]);
    expect(profiles).toEqual(config.pdd_accounts.map((account) => account.profile_dir));
    expect(posted).toEqual(starts);
  });

  it("continues after login/captcha/unexpected failures and exits non-zero", async () => {
    const config = tempConfig();
    const called: string[] = [];
    const posted: Array<{ key: string; status: string }> = [];
    const result = await runPddSyncAll({
      config,
      logger: new JsonLogger({ logDir: null }),
      output: () => undefined,
      runner: async (_selectedConfig, account) => {
        called.push(account.account_key);
        if (account.account_key === "buyer.one") return outcome("NEEDS_LOGIN", 1, 0);
        if (account.account_key === "buyer-two") throw new Error("browser failed");
        return outcome("CAPTCHA_OR_BLOCKED", 1, 0);
      },
      poster: async (_transport, report) => { posted.push({ key: report.platform_account_key, status: report.status }); },
    });
    expect(result.exitCode).toBe(1);
    expect(called).toEqual(["buyer.one", "buyer-two", "buyer-three"]);
    expect(posted).toEqual([
      { key: "buyer.one", status: "NEEDS_LOGIN" },
      { key: "buyer-two", status: "NETWORK_ERROR" },
      { key: "buyer-three", status: "CAPTCHA_OR_BLOCKED" },
    ]);
  });

  it("warns and skips status POST when the worker key is absent", async () => {
    const config = tempConfig();
    config.worker_key = "";
    const output: string[] = [];
    const poster = vi.fn();
    const result = await postPddAccountStatusBestEffort({
      config,
      account: config.pdd_accounts[0]!,
      input: { status: "OK", count: 1 },
      checkedAt: "2026-08-30T00:00:00.000Z",
      logger: new JsonLogger({ logDir: null }),
      output: (line) => output.push(line),
      poster,
    });
    expect(result).toBe("skipped");
    expect(poster).not.toHaveBeenCalled();
    expect(output.join(" ")).toContain("worker key is not configured");
    expect(output.join(" ")).not.toContain("worker-key-for-tests");
  });

  it("includes the account label and cleans status messages to the backend limit", () => {
    const config = tempConfig();
    const report = buildPddAccountStatusReport(
      config,
      config.pdd_accounts[0]!,
      { status: "OK", message: ` hello\n${"x".repeat(400)} ` },
      "2026-08-30T00:00:00.000Z",
    );
    expect(report.platform_account_label).toBe("采购一组");
    expect(report.message).not.toContain("\n");
    expect(report.message?.length).toBe(256);
  });

  it("drops a count defensively when building any non-OK status", () => {
    const config = tempConfig();
    const report = buildPddAccountStatusReport(
      config,
      config.pdd_accounts[0]!,
      { status: "SCHEMA_CHANGED", count: 0 },
      "2026-08-30T00:00:00.000Z",
    );
    expect(report).not.toHaveProperty("count");
  });

  it("posts counts only for reliable OK observations and preserves the run observation time", async () => {
    const config = tempConfig();
    const reports: import("../src/models.js").AccountStatusReport[] = [];
    await runPddSyncAll({
      config,
      logger: new JsonLogger({ logDir: null }),
      output: () => undefined,
      runner: async (_selectedConfig, account) =>
        account.account_key === "buyer.one"
          ? outcome("OK", 0, 7)
          : outcome("NEEDS_LOGIN", 1, 0),
      poster: async (_transport, report) => { reports.push(report); },
    });

    expect(reports).toHaveLength(3);
    expect(reports[0]?.count).toBe(7);
    expect(reports[0]?.checked_at).toBe("2026-08-30T00:00:01.000Z");
    expect(reports[1]).not.toHaveProperty("count");
    expect(reports[2]).not.toHaveProperty("count");
  });

  it("does not publish local DISABLED preflight failures as a login state", async () => {
    const config = tempConfig();
    const poster = vi.fn();
    const result = await runPddSyncAll({
      config,
      logger: new JsonLogger({ logDir: null }),
      output: () => undefined,
      runner: async () => outcome("DISABLED", 1, 0),
      poster,
    });

    expect(result.exitCode).toBe(1);
    expect(poster).not.toHaveBeenCalled();
  });
});
