import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configFailures, loadConfig, maskKey, parseEnvFile } from "../src/config.js";

const createdDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sync-agent-config-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseEnvFile", () => {
  it("parses KEY=VALUE lines, quotes and comments", () => {
    const values = parseEnvFile(
      [
        "# comment",
        "",
        "ARRIVAL_API_BASE_URL=http://192.168.1.5:8766",
        'ARRIVAL_SYNC_WORKER_KEY="quoted value"',
        "SYNC_MAX_RECORDS=42",
        "MALFORMED_LINE_WITHOUT_EQUALS",
        "=missing-key",
      ].join("\n"),
    );
    expect(values["ARRIVAL_API_BASE_URL"]).toBe("http://192.168.1.5:8766");
    expect(values["ARRIVAL_SYNC_WORKER_KEY"]).toBe("quoted value");
    expect(values["SYNC_MAX_RECORDS"]).toBe("42");
    expect(Object.keys(values)).not.toContain("MALFORMED_LINE_WITHOUT_EQUALS");
  });
});

describe("loadConfig", () => {
  it("applies defaults when no env file exists", () => {
    const dir = tempDir();
    const { config, issues } = loadConfig({ cwd: dir, env: {} });
    expect(config.api_base_url).toBe("http://192.168.1.5:8766");
    expect(config.max_pages).toBe(5);
    expect(config.max_records).toBe(30);
    expect(config.page_delay_ms).toBe(2500);
    expect(config.min_interval_minutes).toBe(15);
    expect(config.worker_id.length).toBeGreaterThan(0);
    expect(config.account_keys["pdd"]).toBe("pdd-main");
    expect(config.account_keys["1688"]).toBe("1688-main");
    expect(config.profile_dirs["pdd"]).toBe(join(dir, "profiles", "pdd"));
    expect(config.profile_dirs["1688"]).toBe(join(dir, "profiles", "1688"));
    expect(config.order_list_urls["1688"]).toContain("1688.com");
    expect(issues).toEqual([]);
  });

  it("reads an env file from the package root", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, ".env.local"),
      [
        "SYNC_MAX_RECORDS=60",
        "SYNC_PAGE_DELAY_MS=2000",
        "SYNC_MIN_INTERVAL_MINUTES=30",
        "PDD_PROFILE_DIR=C:/ArrivalLedger/profiles/pdd",
        "PDD_ACCOUNT_KEY=pdd-buyer-1",
      ].join("\n"),
      "utf8",
    );
    const { config } = loadConfig({ cwd: dir, env: {} });
    expect(config.max_records).toBe(60);
    expect(config.page_delay_ms).toBe(2000);
    expect(config.min_interval_minutes).toBe(30);
    expect(config.profile_dirs["pdd"]).toBe("C:/ArrivalLedger/profiles/pdd");
    expect(config.account_keys["pdd"]).toBe("pdd-buyer-1");
  });

  it("process env overrides the env file", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".env.local"), "SYNC_MAX_RECORDS=60\n", "utf8");
    const { config } = loadConfig({ cwd: dir, env: { SYNC_MAX_RECORDS: "80" } });
    expect(config.max_records).toBe(80);
  });

  it("marks set-but-invalid values as FAIL and falls back to defaults", () => {
    const { config, issues } = loadConfig({
      cwd: tempDir(),
      env: {
        SYNC_MAX_RECORDS: "9999",
        SYNC_MAX_PAGES: "0",
        PDD_ACCOUNT_KEY: "bad account key!",
      },
    });
    expect(config.max_records).toBe(30);
    expect(config.max_pages).toBe(5);
    const fields = issues.map((issue) => issue.field);
    expect(fields).toContain("SYNC_MAX_RECORDS");
    expect(fields).toContain("SYNC_MAX_PAGES");
    expect(fields).toContain("PDD_ACCOUNT_KEY");
    expect(issues.every((issue) => issue.severity === "FAIL")).toBe(true);
  });

  it("validates the API base URL scheme as FAIL", () => {
    const { issues } = loadConfig({ cwd: tempDir(), env: { ARRIVAL_API_BASE_URL: "ftp://x" } });
    expect(issues.map((issue) => issue.field)).toContain("ARRIVAL_API_BASE_URL");
    expect(issues[0]?.severity).toBe("FAIL");
  });

  it("requires https order list URLs", () => {
    const { issues } = loadConfig({ cwd: tempDir(), env: { ALI1688_ORDER_URL: "http://insecure" } });
    expect(issues.some((issue) => issue.field === "ALI1688_ORDER_URL" && issue.severity === "FAIL")).toBe(true);
  });

  it("enforces the safety floors and caps", () => {
    const { config, issues } = loadConfig({
      cwd: tempDir(),
      env: {
        SYNC_PAGE_DELAY_MS: "0",
        SYNC_MAX_PAGES: "9",
        SYNC_MAX_RECORDS: "101",
        SYNC_MIN_INTERVAL_MINUTES: "0",
      },
    });
    expect(config.page_delay_ms).toBe(2500);
    expect(config.max_pages).toBe(5);
    expect(config.max_records).toBe(30);
    expect(config.min_interval_minutes).toBe(15);
    const fields = issues.map((issue) => issue.field);
    expect(fields).toContain("SYNC_PAGE_DELAY_MS");
    expect(fields).toContain("SYNC_MAX_PAGES");
    expect(fields).toContain("SYNC_MAX_RECORDS");
    expect(fields).toContain("SYNC_MIN_INTERVAL_MINUTES");
  });

  it("normalizes account keys to lowercase and rejects collisions", () => {
    const { config } = loadConfig({
      cwd: tempDir(),
      env: { PDD_ACCOUNT_KEY: "PDD-Buyer", ALI1688_ACCOUNT_KEY: "ali-buyer" },
    });
    expect(config.account_keys["pdd"]).toBe("pdd-buyer");
    expect(config.account_keys["1688"]).toBe("ali-buyer");

    const collision = loadConfig({
      cwd: tempDir(),
      env: { PDD_ACCOUNT_KEY: "same-account", ALI1688_ACCOUNT_KEY: "SAME-ACCOUNT" },
    });
    expect(
      collision.issues.some((issue) => issue.field.includes("PDD_ACCOUNT_KEY/ALI1688_ACCOUNT_KEY")),
    ).toBe(true);
  });

  it("rejects identical profile directories", () => {
    const { issues } = loadConfig({
      cwd: tempDir(),
      env: {
        PDD_PROFILE_DIR: "/same/profile/dir",
        ALI1688_PROFILE_DIR: "/same/profile/dir",
      },
    });
    expect(issues.some((issue) => issue.field.includes("PDD_PROFILE_DIR/ALI1688_PROFILE_DIR"))).toBe(true);
  });

  it("configFailures filters FAIL severity only", () => {
    const { issues } = loadConfig({
      cwd: tempDir(),
      env: { SYNC_MAX_PAGES: "abc" },
    });
    expect(configFailures(issues).length).toBeGreaterThan(0);
    expect(configFailures([])).toEqual([]);
  });
});

describe("maskKey", () => {
  it("never returns more than the first and last 4 characters", () => {
    expect(maskKey("")).toBe("(not set)");
    expect(maskKey("short")).toBe("****");
    expect(maskKey("super-secret-worker-key")).toBe("supe…-key");
    expect(maskKey("super-secret-worker-key")).not.toContain("secret");
  });
});
