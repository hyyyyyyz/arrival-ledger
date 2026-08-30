import { hostname } from "node:os";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, parse as parsePath, resolve } from "node:path";

import { LIMITS, PLATFORMS, type Platform } from "./models.js";
import { inspectProfilePath } from "./profile_path.js";

export interface SyncConfig {
  api_base_url: string;
  worker_key: string;
  worker_id: string;
  state_dir: string;
  log_dir: string;
  max_pages: number;
  max_records: number;
  page_delay_ms: number;
  min_interval_minutes: number;
  profile_dirs: Record<Platform, string>;
  account_keys: Record<Platform, string>;
  order_list_urls: Record<Platform, string>;
  pdd_accounts_file: string | null;
  pdd_accounts: PddAccountConfig[];
}

export interface PddAccountConfig {
  account_key: string;
  display_label: string | null;
  profile_dir: string;
}

export type IssueSeverity = "FAIL" | "WARN";

export interface ConfigIssue {
  field: string;
  message: string;
  severity: IssueSeverity;
}

const DEFAULT_STATE_DIR = "state";
const DEFAULT_LOG_DIR = "logs";
const ACCOUNT_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_ACCOUNTS_FILE_BYTES = 256 * 1024;
const MAX_PDD_ACCOUNTS = 50;
const DISPLAY_LABEL_MAX_LENGTH = 128;

export const DEFAULT_ORDER_LIST_URLS: Record<Platform, string> = {
  pdd: "https://mobile.yangkeduo.com/orders.html",
  "1688": "https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html",
};

export function defaultProfileDir(cwd: string, platform: Platform): string {
  return join(cwd, "profiles", platform);
}

export function defaultAccountKey(platform: Platform): string {
  return platform === "pdd" ? "pdd-main" : "1688-main";
}

export function defaultWorkerId(): string {
  return `worker-${hostname()}`;
}

function normalizedPath(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function readAccountsFile(
  path: string,
  issues: ConfigIssue[],
): string | null {
  const field = "PDD_ACCOUNTS_FILE";
  let fd: number | null = null;
  try {
    const before = lstatSync(path);
    if (before.isSymbolicLink()) {
      issues.push({ field, message: "must not be a symbolic link", severity: "FAIL" });
      return null;
    }
    if (!before.isFile()) {
      issues.push({ field, message: "must point to a regular JSON file", severity: "FAIL" });
      return null;
    }
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const stat = fstatSync(fd);
    if (before.dev !== stat.dev || before.ino !== stat.ino) {
      issues.push({ field, message: "changed while being opened; retry with a stable file", severity: "FAIL" });
      return null;
    }
    if (!stat.isFile()) {
      issues.push({ field, message: "must point to a regular JSON file", severity: "FAIL" });
      return null;
    }
    if (stat.size > MAX_ACCOUNTS_FILE_BYTES) {
      issues.push({
        field,
        message: `must be no larger than ${MAX_ACCOUNTS_FILE_BYTES} bytes`,
        severity: "FAIL",
      });
      return null;
    }
    if (process.platform !== "win32") {
      if ((stat.mode & 0o022) !== 0) {
        issues.push({
          field,
          message: "must not be writable by group or other users (use chmod 600)",
          severity: "FAIL",
        });
      } else if ((stat.mode & 0o044) !== 0) {
        issues.push({
          field,
          message: "is readable by group or other users; chmod 600 is recommended",
          severity: "WARN",
        });
      }
    }
    return readFileSync(fd, "utf8");
  } catch (error) {
    issues.push({
      field,
      message: `cannot safely read file: ${(error as Error).message}`,
      severity: "FAIL",
    });
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function exactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
): string[] {
  const allowedSet = new Set(allowed);
  return Object.keys(record).filter((key) => !allowedSet.has(key));
}

export function parsePddAccountsFile(
  path: string,
  content: string,
  issues: ConfigIssue[],
): PddAccountConfig[] {
  const field = "PDD_ACCOUNTS_FILE";
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    issues.push({
      field,
      message: `must contain valid JSON: ${(error as Error).message}`,
      severity: "FAIL",
    });
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    issues.push({ field, message: "root must be an object", severity: "FAIL" });
    return [];
  }
  const root = parsed as Record<string, unknown>;
  const unknownRootKeys = exactKeys(root, ["schema_version", "accounts"]);
  if (unknownRootKeys.length > 0) {
    issues.push({
      field,
      message: `unknown root field(s): ${unknownRootKeys.join(", ")}`,
      severity: "FAIL",
    });
  }
  if (root["schema_version"] !== 1) {
    issues.push({ field, message: "schema_version must equal 1", severity: "FAIL" });
  }
  if (!Array.isArray(root["accounts"])) {
    issues.push({ field, message: "accounts must be an array", severity: "FAIL" });
    return [];
  }
  const rawAccounts = root["accounts"];
  if (rawAccounts.length === 0 || rawAccounts.length > MAX_PDD_ACCOUNTS) {
    issues.push({
      field,
      message: `accounts must contain between 1 and ${MAX_PDD_ACCOUNTS} entries`,
      severity: "FAIL",
    });
  }

  const accounts: PddAccountConfig[] = [];
  const seenKeys = new Set<string>();
  const seenProfileDirs = new Set<string>();
  let accountsBaseDir: string;
  try {
    accountsBaseDir = dirname(realpathSync.native(path));
  } catch {
    accountsBaseDir = dirname(path);
  }
  rawAccounts.forEach((value, index) => {
    const itemField = `${field}.accounts[${index}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      issues.push({ field: itemField, message: "must be an object", severity: "FAIL" });
      return;
    }
    const record = value as Record<string, unknown>;
    const unknownKeys = exactKeys(record, ["account_key", "display_label", "profile_dir"]);
    if (unknownKeys.length > 0) {
      issues.push({
        field: itemField,
        message: `unknown field(s): ${unknownKeys.join(", ")}`,
        severity: "FAIL",
      });
    }

    const rawKey = record["account_key"];
    const accountKey = typeof rawKey === "string" ? rawKey.trim().toLowerCase() : "";
    if (!ACCOUNT_KEY_PATTERN.test(accountKey)) {
      issues.push({
        field: `${itemField}.account_key`,
        message: "must start with a letter or digit and contain only letters, digits, ., _ and - (normalized to lowercase)",
        severity: "FAIL",
      });
    } else if (seenKeys.has(accountKey)) {
      issues.push({
        field: `${itemField}.account_key`,
        message: `duplicate account_key after normalization: ${accountKey}`,
        severity: "FAIL",
      });
    }
    seenKeys.add(accountKey);

    const rawLabel = record["display_label"];
    let displayLabel: string | null = null;
    if (rawLabel !== undefined) {
      if (
        typeof rawLabel !== "string" ||
        rawLabel.trim().length === 0 ||
        rawLabel.trim().length > DISPLAY_LABEL_MAX_LENGTH ||
        /[\u0000-\u001f\u007f]/.test(rawLabel)
      ) {
        issues.push({
          field: `${itemField}.display_label`,
          message: `must be a non-empty string of at most ${DISPLAY_LABEL_MAX_LENGTH} characters without control characters`,
          severity: "FAIL",
        });
      } else {
        displayLabel = rawLabel.trim();
      }
    }

    const rawProfile = record["profile_dir"];
    let profileDir = "";
    if (typeof rawProfile !== "string" || rawProfile.trim().length === 0 || rawProfile.includes("\u0000")) {
      issues.push({
        field: `${itemField}.profile_dir`,
        message: "must be a non-empty filesystem path",
        severity: "FAIL",
      });
    } else {
      const requestedProfileDir = resolve(accountsBaseDir, rawProfile.trim());
      let inspection: ReturnType<typeof inspectProfilePath> | null = null;
      try {
        inspection = inspectProfilePath(requestedProfileDir);
        profileDir = inspection.canonical_path;
      } catch (error) {
        issues.push({
          field: `${itemField}.profile_dir`,
          message: `cannot safely inspect profile_dir: ${(error as Error).message}`,
          severity: "FAIL",
        });
        profileDir = requestedProfileDir;
      }
      if (normalizedPath(profileDir) === normalizedPath(parsePath(profileDir).root)) {
        issues.push({
          field: `${itemField}.profile_dir`,
          message: "must not be a filesystem root",
          severity: "FAIL",
        });
      }
      const normalized = normalizedPath(profileDir);
      if (seenProfileDirs.has(normalized)) {
        issues.push({
          field: `${itemField}.profile_dir`,
          message: "profile_dir must be unique for every account",
          severity: "FAIL",
        });
      }
      seenProfileDirs.add(normalized);
      if (inspection !== null && inspection.unsafe_components.length > 0) {
        issues.push({
          field: `${itemField}.profile_dir`,
          message: `profile_dir must not contain a symbolic link or junction component: ${inspection.unsafe_components[0]}`,
          severity: "FAIL",
        });
      }
      if (inspection?.target_exists === true) {
        try {
          const stat = lstatSync(profileDir);
          if (!stat.isDirectory()) {
            issues.push({
              field: `${itemField}.profile_dir`,
              message: "existing profile_dir must be a directory",
              severity: "FAIL",
            });
          } else if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) {
            issues.push({
              field: `${itemField}.profile_dir`,
              message: "existing profile_dir must not be writable by group or other users (use chmod 700)",
              severity: "FAIL",
            });
          } else if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
            issues.push({
              field: `${itemField}.profile_dir`,
              message: "existing profile_dir is accessible by group or other users; chmod 700 is recommended",
              severity: "WARN",
            });
          }
        } catch (error) {
          issues.push({
            field: `${itemField}.profile_dir`,
            message: `cannot inspect profile_dir: ${(error as Error).message}`,
            severity: "FAIL",
          });
        }
      }
    }

    if (ACCOUNT_KEY_PATTERN.test(accountKey) && profileDir.length > 0) {
      accounts.push({ account_key: accountKey, display_label: displayLabel, profile_dir: profileDir });
    }
  });
  return accounts;
}

export function configForPddAccount(
  config: SyncConfig,
  account: PddAccountConfig,
): SyncConfig {
  return {
    ...config,
    account_keys: { ...config.account_keys, pdd: account.account_key },
    profile_dirs: { ...config.profile_dirs, pdd: account.profile_dir },
  };
}

export function selectPddAccount(
  config: SyncConfig,
  accountKey?: string,
): { account: PddAccountConfig | null; message: string | null } {
  if (accountKey !== undefined) {
    const normalized = accountKey.trim().toLowerCase();
    if (!ACCOUNT_KEY_PATTERN.test(normalized)) {
      return { account: null, message: "--account must start with a letter or digit and contain only letters, digits, ., _ and -" };
    }
    const account = config.pdd_accounts.find((item) => item.account_key === normalized) ?? null;
    return account === null
      ? { account: null, message: `unknown PDD account: ${normalized}` }
      : { account, message: null };
  }
  if (config.pdd_accounts.length === 1) {
    return { account: config.pdd_accounts[0] ?? null, message: null };
  }
  return {
    account: null,
    message: "multiple PDD accounts are configured; pass --account <account_key>",
  };
}

export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (key.length === 0 || /\s/.test(key)) continue;
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function asInt(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
  issues: ConfigIssue[],
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    issues.push({
      field: name,
      message: `must be an integer between ${minimum} and ${maximum}`,
      severity: "FAIL",
    });
    return fallback;
  }
  return parsed;
}

export function loadConfig(
  options: { cwd?: string; env?: NodeJS.ProcessEnv; envFile?: string } = {},
): { config: SyncConfig; issues: ConfigIssue[] } {
  const cwd = resolve(options.cwd ?? process.cwd());
  const envFile = options.envFile ?? join(cwd, ".env.local");
  const issues: ConfigIssue[] = [];

  const fileValues = existsSync(envFile)
    ? parseEnvFile(readFileSync(envFile, "utf8"))
    : {};
  const env = { ...fileValues, ...(options.env ?? process.env) };
  const accountsFileRaw = env["PDD_ACCOUNTS_FILE"]?.trim() ?? "";

  const apiBaseUrlRaw = env["ARRIVAL_API_BASE_URL"] ?? "http://192.168.1.5:8766";
  const api_base_url = apiBaseUrlRaw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/.test(api_base_url)) {
    issues.push({
      field: "ARRIVAL_API_BASE_URL",
      message: "must be an http(s) URL",
      severity: "FAIL",
    });
  }

  const account_keys: Record<Platform, string> = {
    pdd: (env["PDD_ACCOUNT_KEY"] ?? defaultAccountKey("pdd")).trim().toLowerCase(),
    "1688": (env["ALI1688_ACCOUNT_KEY"] ?? defaultAccountKey("1688")).trim().toLowerCase(),
  };
  for (const platform of PLATFORMS) {
    if (platform === "pdd" && accountsFileRaw.length > 0) continue;
    const field = platform === "pdd" ? "PDD_ACCOUNT_KEY" : "ALI1688_ACCOUNT_KEY";
    if (!ACCOUNT_KEY_PATTERN.test(account_keys[platform])) {
      issues.push({
        field,
        message: "must start with a letter or digit and contain only letters, digits, ., _ and - (normalized to lowercase)",
        severity: "FAIL",
      });
    }
  }
  if (accountsFileRaw.length === 0 && account_keys["pdd"] === account_keys["1688"]) {
    issues.push({
      field: "PDD_ACCOUNT_KEY/ALI1688_ACCOUNT_KEY",
      message: "account keys must be different for the two platforms",
      severity: "FAIL",
    });
  }

  const order_list_urls: Record<Platform, string> = {
    pdd: (env["PDD_ORDER_URL"] ?? DEFAULT_ORDER_LIST_URLS["pdd"]).trim(),
    "1688": (env["ALI1688_ORDER_URL"] ?? DEFAULT_ORDER_LIST_URLS["1688"]).trim(),
  };
  for (const platform of PLATFORMS) {
    const field = platform === "pdd" ? "PDD_ORDER_URL" : "ALI1688_ORDER_URL";
    if (!/^https:\/\/[^\s]+$/.test(order_list_urls[platform])) {
      issues.push({
        field,
        message: "must be an https URL",
        severity: "FAIL",
      });
    }
  }

  const config: SyncConfig = {
    api_base_url,
    worker_key: (env["ARRIVAL_SYNC_WORKER_KEY"] ?? "").trim(),
    worker_id: (env["ARRIVAL_WORKER_ID"] ?? defaultWorkerId()).trim(),
    state_dir: resolve(cwd, env["ARRIVAL_STATE_DIR"] ?? DEFAULT_STATE_DIR),
    log_dir: resolve(cwd, env["ARRIVAL_LOG_DIR"] ?? DEFAULT_LOG_DIR),
    max_pages: asInt(env["SYNC_MAX_PAGES"], 5, 1, 5, "SYNC_MAX_PAGES", issues),
    max_records: asInt(
      env["SYNC_MAX_RECORDS"],
      30,
      LIMITS.min_records,
      LIMITS.max_records,
      "SYNC_MAX_RECORDS",
      issues,
    ),
    page_delay_ms: asInt(
      env["SYNC_PAGE_DELAY_MS"],
      2500,
      1500,
      60_000,
      "SYNC_PAGE_DELAY_MS",
      issues,
    ),
    min_interval_minutes: asInt(
      env["SYNC_MIN_INTERVAL_MINUTES"],
      15,
      1,
      1440,
      "SYNC_MIN_INTERVAL_MINUTES",
      issues,
    ),
    profile_dirs: {
      pdd: (env["PDD_PROFILE_DIR"] ?? defaultProfileDir(cwd, "pdd")).trim(),
      "1688": (env["ALI1688_PROFILE_DIR"] ?? defaultProfileDir(cwd, "1688")).trim(),
    },
    account_keys,
    order_list_urls,
    pdd_accounts_file: null,
    pdd_accounts: [],
  };

  if (accountsFileRaw.length > 0) {
    const accountsFile = resolve(cwd, accountsFileRaw);
    config.pdd_accounts_file = accountsFile;
    const content = readAccountsFile(accountsFile, issues);
    config.pdd_accounts = content === null
      ? []
      : parsePddAccountsFile(accountsFile, content, issues);
    const first = config.pdd_accounts[0];
    if (first !== undefined) {
      config.account_keys.pdd = first.account_key;
      config.profile_dirs.pdd = first.profile_dir;
    }
  } else {
    config.pdd_accounts = [{
      account_key: config.account_keys.pdd,
      display_label: null,
      profile_dir: config.profile_dirs.pdd,
    }];
  }

  for (const platform of PLATFORMS) {
    if (platform === "pdd" && accountsFileRaw.length > 0) continue;
    const field = platform === "pdd" ? "PDD_PROFILE_DIR" : "ALI1688_PROFILE_DIR";
    if (config.profile_dirs[platform].length === 0) {
      issues.push({ field, message: "must not be empty", severity: "FAIL" });
    }
  }
  for (const account of config.pdd_accounts) {
    if (account.account_key === config.account_keys["1688"]) {
      issues.push({
        field: "PDD_ACCOUNTS_FILE/ALI1688_ACCOUNT_KEY",
        message: `PDD account key ${account.account_key} collides with the 1688 account key`,
        severity: "FAIL",
      });
    }
    if (normalizedPath(account.profile_dir) === normalizedPath(config.profile_dirs["1688"])) {
      issues.push({
        field: "PDD_PROFILE_DIR/ALI1688_PROFILE_DIR",
        message: "the two platforms must use different profile directories",
        severity: "FAIL",
      });
    }
  }
  if (config.worker_id.length === 0 || config.worker_id.length > LIMITS.worker_id) {
    issues.push({
      field: "ARRIVAL_WORKER_ID",
      message: `must be 1-${LIMITS.worker_id} characters`,
      severity: "FAIL",
    });
  }
  return { config, issues };
}

export function configFailures(issues: ConfigIssue[]): ConfigIssue[] {
  return issues.filter((issue) => issue.severity === "FAIL");
}

export function maskKey(key: string): string {
  if (key.length === 0) return "(not set)";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
