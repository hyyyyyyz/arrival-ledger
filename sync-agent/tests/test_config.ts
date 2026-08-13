import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, maskKey, parseEnvFile } from "../src/config.js";

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
    const { config, issues } = loadConfig({ cwd: tempDir(), env: {} });
    expect(config.api_base_url).toBe("http://192.168.1.5:8766");
    expect(config.max_pages).toBe(5);
    expect(config.max_records).toBe(30);
    expect(config.page_delay_ms).toBe(2500);
    expect(config.worker_id.length).toBeGreaterThan(0);
    expect(config.profile_dirs["pdd"]).toBeTruthy();
    expect(config.profile_dirs["1688"]).toBeTruthy();
    expect(issues).toEqual([]);
  });

  it("reads an env file from the package root", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, ".env.local"),
      "SYNC_MAX_RECORDS=60\nSYNC_PAGE_DELAY_MS=1000\nPDD_PROFILE_DIR=C:/ArrivalLedger/profiles/pdd\n",
      "utf8",
    );
    const { config } = loadConfig({ cwd: dir, env: {} });
    expect(config.max_records).toBe(60);
    expect(config.page_delay_ms).toBe(1000);
    expect(config.profile_dirs["pdd"]).toBe("C:/ArrivalLedger/profiles/pdd");
  });

  it("process env overrides the env file", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".env.local"), "SYNC_MAX_RECORDS=60\n", "utf8");
    const { config } = loadConfig({ cwd: dir, env: { SYNC_MAX_RECORDS: "80" } });
    expect(config.max_records).toBe(80);
  });

  it("reports out-of-range values as issues and falls back to defaults", () => {
    const { config, issues } = loadConfig({
      cwd: tempDir(),
      env: { SYNC_MAX_RECORDS: "9999", SYNC_MAX_PAGES: "0" },
    });
    expect(config.max_records).toBe(30);
    expect(config.max_pages).toBe(5);
    expect(issues.map((issue) => issue.field)).toContain("SYNC_MAX_RECORDS");
    expect(issues.map((issue) => issue.field)).toContain("SYNC_MAX_PAGES");
  });

  it("validates the API base URL scheme", () => {
    const { issues } = loadConfig({ cwd: tempDir(), env: { ARRIVAL_API_BASE_URL: "ftp://x" } });
    expect(issues.map((issue) => issue.field)).toContain("ARRIVAL_API_BASE_URL");
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
