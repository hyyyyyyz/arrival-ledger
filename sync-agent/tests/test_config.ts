import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  configFailures,
  configForPddAccount,
  loadConfig,
  maskKey,
  parseEnvFile,
  selectPddAccount,
} from "../src/config.js";

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

  it("loads a strict multi-account PDD file and resolves relative profile directories", () => {
    const dir = tempDir();
    const configDir = join(dir, "config");
    mkdirSync(configDir);
    const accountsFile = join(configDir, "pdd-accounts.json");
    writeFileSync(
      accountsFile,
      JSON.stringify({
        schema_version: 1,
        accounts: [
          { account_key: "PDD.Main", display_label: "采购主账号", profile_dir: "../profiles/main" },
          { account_key: "pdd-backup", display_label: "采购备用账号", profile_dir: "../profiles/backup" },
        ],
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const { config, issues } = loadConfig({
      cwd: dir,
      env: { PDD_ACCOUNTS_FILE: "config/pdd-accounts.json" },
    });
    expect(configFailures(issues)).toEqual([]);
    expect(config.pdd_accounts.map((item) => item.account_key)).toEqual(["pdd.main", "pdd-backup"]);
    const canonicalDir = realpathSync.native(dir);
    expect(config.pdd_accounts[0]?.profile_dir).toBe(join(canonicalDir, "profiles", "main"));
    expect(config.pdd_accounts_file).toBe(accountsFile);
    expect(selectPddAccount(config).message).toContain("multiple");
    const selected = selectPddAccount(config, "PDD.Main");
    expect(selected.account?.display_label).toBe("采购主账号");
    const selectedConfig = configForPddAccount(config, selected.account!);
    expect(selectedConfig.account_keys.pdd).toBe("pdd.main");
    expect(selectedConfig.profile_dirs.pdd).toBe(join(canonicalDir, "profiles", "main"));
  });

  it("ignores legacy single-account PDD fields when the accounts file is configured", () => {
    const dir = tempDir();
    const accountsFile = join(dir, "accounts.json");
    writeFileSync(
      accountsFile,
      JSON.stringify({ schema_version: 1, accounts: [{ account_key: "buyer.one", profile_dir: "profile" }] }),
      { encoding: "utf8", mode: 0o600 },
    );
    const { config, issues } = loadConfig({
      cwd: dir,
      env: {
        PDD_ACCOUNTS_FILE: accountsFile,
        PDD_ACCOUNT_KEY: "invalid legacy key!",
        PDD_PROFILE_DIR: "",
      },
    });
    expect(configFailures(issues)).toEqual([]);
    expect(config.account_keys.pdd).toBe("buyer.one");
  });

  it("rejects duplicate normalized keys, duplicate profiles and unknown fields", () => {
    const dir = tempDir();
    const accountsFile = join(dir, "accounts.json");
    writeFileSync(
      accountsFile,
      JSON.stringify({
        schema_version: 1,
        unexpected: true,
        accounts: [
          { account_key: "Buyer.One", profile_dir: "profiles/shared" },
          { account_key: "buyer.one", profile_dir: "profiles/shared", extra: "no" },
        ],
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const { issues } = loadConfig({ cwd: dir, env: { PDD_ACCOUNTS_FILE: accountsFile } });
    const messages = issues.map((issue) => `${issue.field}: ${issue.message}`).join("\n");
    expect(messages).toContain("duplicate account_key");
    expect(messages).toContain("profile_dir must be unique");
    expect(messages).toContain("unknown root field");
    expect(messages).toContain("unknown field");
  });

  it("rejects a symlink accounts file and an existing symlink profile", () => {
    const dir = tempDir();
    const realFile = join(dir, "real.json");
    writeFileSync(realFile, JSON.stringify({ schema_version: 1, accounts: [{ account_key: "pdd-main", profile_dir: "profile" }] }), { encoding: "utf8", mode: 0o600 });
    const linkFile = join(dir, "link.json");
    symlinkSync(realFile, linkFile);
    const linkedFileResult = loadConfig({ cwd: dir, env: { PDD_ACCOUNTS_FILE: linkFile } });
    expect(linkedFileResult.issues.some((issue) => issue.message.includes("symbolic link"))).toBe(true);

    const targetProfile = join(dir, "real-profile");
    mkdirSync(targetProfile);
    const profileLink = join(dir, "profile-link");
    symlinkSync(targetProfile, profileLink, "dir");
    writeFileSync(realFile, JSON.stringify({ schema_version: 1, accounts: [{ account_key: "pdd-main", profile_dir: profileLink }] }), { encoding: "utf8", mode: 0o600 });
    const linkedProfileResult = loadConfig({ cwd: dir, env: { PDD_ACCOUNTS_FILE: realFile } });
    expect(linkedProfileResult.issues.some((issue) => issue.field.endsWith("profile_dir") && issue.message.includes("symbolic link"))).toBe(true);
  });

  it("rejects a parent symlink/junction alias and deduplicates its canonical eventual profile", () => {
    const dir = tempDir();
    const realParent = join(dir, "profiles-real");
    const aliasParent = join(dir, "profiles-alias");
    mkdirSync(realParent);
    symlinkSync(realParent, aliasParent, process.platform === "win32" ? "junction" : "dir");
    const accountsFile = join(dir, "accounts.json");
    writeFileSync(
      accountsFile,
      JSON.stringify({
        schema_version: 1,
        accounts: [
          { account_key: "buyer-one", profile_dir: join(realParent, "buyer") },
          { account_key: "buyer-two", profile_dir: join(aliasParent, "buyer") },
        ],
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    const { issues } = loadConfig({ cwd: dir, env: { PDD_ACCOUNTS_FILE: accountsFile } });
    const messages = issues.map((issue) => issue.message).join("\n");
    expect(messages).toMatch(/symbolic link|junction/);
    expect(messages).toContain("profile_dir must be unique");
  });

  it("rejects group-writable account files where POSIX modes are available", () => {
    if (process.platform === "win32") return;
    const dir = tempDir();
    const accountsFile = join(dir, "accounts.json");
    writeFileSync(accountsFile, JSON.stringify({ schema_version: 1, accounts: [{ account_key: "pdd-main", profile_dir: "profile" }] }), { encoding: "utf8", mode: 0o600 });
    chmodSync(accountsFile, 0o620);
    const { issues } = loadConfig({ cwd: dir, env: { PDD_ACCOUNTS_FILE: accountsFile } });
    expect(issues.some((issue) => issue.severity === "FAIL" && issue.message.includes("group or other"))).toBe(true);
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
