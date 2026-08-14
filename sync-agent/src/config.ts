import { hostname } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { LIMITS, PLATFORMS, type Platform } from "./models.js";

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
}

export type IssueSeverity = "FAIL" | "WARN";

export interface ConfigIssue {
  field: string;
  message: string;
  severity: IssueSeverity;
}

const DEFAULT_STATE_DIR = "state";
const DEFAULT_LOG_DIR = "logs";
const ACCOUNT_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

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
    const field = platform === "pdd" ? "PDD_ACCOUNT_KEY" : "ALI1688_ACCOUNT_KEY";
    if (!ACCOUNT_KEY_PATTERN.test(account_keys[platform])) {
      issues.push({
        field,
        message: "must match /^[A-Za-z0-9_-]{1,64}$/ (normalized to lowercase)",
        severity: "FAIL",
      });
    }
  }
  if (account_keys["pdd"] === account_keys["1688"]) {
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
  };

  for (const platform of PLATFORMS) {
    const field = platform === "pdd" ? "PDD_PROFILE_DIR" : "ALI1688_PROFILE_DIR";
    if (config.profile_dirs[platform].length === 0) {
      issues.push({ field, message: "must not be empty", severity: "FAIL" });
    }
  }
  const normalizePath = (value: string): string =>
    process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  if (normalizePath(config.profile_dirs["pdd"]) === normalizePath(config.profile_dirs["1688"])) {
    issues.push({
      field: "PDD_PROFILE_DIR/ALI1688_PROFILE_DIR",
      message: "the two platforms must use different profile directories",
      severity: "FAIL",
    });
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
