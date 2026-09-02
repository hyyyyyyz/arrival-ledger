import { existsSync, mkdirSync, mkdtempSync, accessSync, constants, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  configFailures,
  configForPddAccount,
  loadConfig,
  maskKey,
  selectPddAccount,
  type PddAccountConfig,
  type SyncConfig,
} from "./config.js";
import { runCapturePage } from "./capture_page.js";
import {
  browserRuntimeLabel,
  effectiveBrowserDisplay,
  headedRuntimeIssue,
  launchSyncBrowser,
  type SyncBrowser,
} from "./browser/context.js";
import { runLoginCheck as runLoginCheckFlow } from "./login_check.js";
import { JsonLogger } from "./log.js";
import { isPlatform, type Platform } from "./models.js";
import { runSyncOnce } from "./run.js";
import { postPddAccountStatusBestEffort, runPddSyncAll } from "./pdd_multi.js";
import { acquireLock, describeHolder } from "./state/lock.js";
import { loadCursor } from "./state/cursor.js";

interface DoctorCheck {
  label: string;
  state: "OK" | "WARN" | "FAIL";
  detail: string;
}

const HELP = `arrival-ledger sync-agent (browser sync MVP)

Usage:
  sync-agent doctor [--offline] [--platform pdd]
  sync-agent accounts --platform pdd
  sync-agent login-check --platform pdd [--account pdd-main] [--wait-seconds 900]
  sync-agent capture-page --platform pdd
  sync-agent sync-once --platform pdd --mode dry-run [--account pdd-main]
  sync-agent sync-once --platform pdd --mode commit --from-report <snapshot> --yes
  sync-agent sync-all --platform pdd --mode dry-run

Commands:
  doctor       Check local configuration, state, locks and (unless --offline)
               the local Chromium installation. Never contacts platform sites.
  accounts     List configured PDD accounts without opening a browser.
  login-check  Open the visible browser on the platform order list and report
               login/captcha state. It never fills passwords or solves
               captchas; log in manually in the visible window.
  capture-page Open the order list exactly once and save a private structural
               diagnostic. It stores no raw HTML, free-form page text, screenshots,
               URL query, cookies or form values; it never opens details.
  sync-once    dry-run reads visible orders once and saves a private local
               snapshot; commit uploads EXACTLY the snapshot bytes and never
               re-opens the browser. commit requires --yes.
  sync-all     Run PDD dry-run once per configured account, strictly in file
               order and never concurrently. It continues after account errors
               and exits non-zero if any account is not OK. Commit is disabled.

Flags:
  --offline       doctor: skip the Chromium check
  --platform      pdd (1688 browser sync is retired; use the backend Open API)
  --account       PDD account_key from PDD_ACCOUNTS_FILE
  --wait-seconds  login-check: watch the already-open visible page for 1-3600s
                  instead of waiting for terminal Enter (no refresh/captcha action)
  --mode          dry-run | commit
  --from-report   path to the dry-run snapshot (required for commit)
  --yes           confirm commit after reviewing the dry-run report
`;

function parsePlatformFlag(values: { platform?: string } | undefined): Platform | null {
  const platform = values?.platform;
  if (platform === undefined) return null;
  return isPlatform(platform) ? platform : null;
}

function fail(message: string, exitCode = 2): number {
  process.stderr.write(`error: ${message}\n`);
  return exitCode;
}

function requireValidConfig(issues: ReturnType<typeof loadConfig>["issues"]): number | null {
  const failures = configFailures(issues);
  if (failures.length === 0) return null;
  for (const issue of failures) {
    process.stderr.write(`error: config ${issue.field}: ${issue.message}\n`);
  }
  return fail("invalid configuration; fix .env.local and retry (fail-closed)", 1);
}

function ensureWritableDirectory(path: string): { state: DoctorCheck["state"]; detail: string } {
  try {
    mkdirSync(path, { recursive: true });
    accessSync(path, constants.W_OK);
    return { state: "OK", detail: path };
  } catch (error) {
    return {
      state: "FAIL",
      detail: `cannot create or write ${path}: ${(error as Error).message}`,
    };
  }
}

async function checkLocalChromium(
  config: SyncConfig,
): Promise<{ state: DoctorCheck["state"]; detail: string }> {
  const runtimeIssue = headedRuntimeIssue(config.browser);
  if (runtimeIssue !== null) return { state: "FAIL", detail: runtimeIssue };
  let browser: SyncBrowser | null = null;
  let temporaryProfile: string | null = null;
  try {
    temporaryProfile = mkdtempSync(join(config.state_dir, ".doctor-browser-"));
    browser = await launchSyncBrowser(temporaryProfile, config.browser);
    const version = browser.context.browser()?.version() ?? "unknown version";
    const display = effectiveBrowserDisplay(config.browser);
    return {
      state: "OK",
      detail: `${browserRuntimeLabel(config.browser)} ${version}; visible launch succeeded${display === null ? "" : ` on DISPLAY=${display}`}`,
    };
  } catch (error) {
    return {
      state: "FAIL",
      detail: `cannot launch the configured visible Chromium: ${(error as Error).message}. Install it with "npx playwright install chromium" (or fix the configured channel/executable and X display).`,
    };
  } finally {
    await browser?.close().catch(() => undefined);
    if (temporaryProfile !== null) {
      // Browser shutdown can briefly leave files busy on Windows.  A doctor
      // cleanup failure must not turn a successful browser check into a crash.
      try {
        rmSync(temporaryProfile, { recursive: true, force: true });
      } catch {
        // The private temporary profile is best-effort cleanup only.
      }
    }
  }
}

async function runDoctor(options: {
  offline: boolean;
  platform: Platform | null;
  accountKey?: string;
}): Promise<number> {
  const { config, issues } = loadConfig();
  const logger = new JsonLogger({ logDir: config.log_dir });
  logger.info({ command: "doctor", message: "doctor started", counts: { offline: options.offline ? 1 : 0 } });

  const checks: DoctorCheck[] = [];
  const [major] = process.versions.node.split(".").map(Number);
  checks.push({
    label: "node version",
    state: (major ?? 0) >= 20 ? "OK" : "FAIL",
    detail: `node ${process.versions.node} (>= 20 required)`,
  });

  const platforms: Platform[] = options.platform === null ? ["pdd"] : [options.platform];

  for (const issue of issues) {
    checks.push({
      label: `config ${issue.field}`,
      state: issue.severity === "FAIL" ? "FAIL" : "WARN",
      detail: issue.message,
    });
  }
  if (issues.length === 0) {
    checks.push({ label: "config", state: "OK", detail: "all configured values are valid" });
  }

  const stateCheck = ensureWritableDirectory(config.state_dir);
  checks.push({ label: "state dir", ...stateCheck });
  const logCheck = ensureWritableDirectory(config.log_dir);
  checks.push({ label: "log dir", ...logCheck });

  checks.push({
    label: "api base url",
    state: "OK",
    detail: `${config.api_base_url} (doctor itself makes no network requests)`,
  });
  checks.push({
    label: "worker key",
    state: config.worker_key.length > 0 ? "OK" : "WARN",
    detail: config.worker_key.length > 0
      ? `configured as ${maskKey(config.worker_key)}`
      : "not set; required before the first commit",
  });

  for (const platform of platforms) {
    let accountConfigs: Array<{ accountKey: string; profileDir: string; label: string }>;
    if (platform === "pdd") {
      const selected = options.accountKey === undefined
        ? null
        : selectPddAccount(config, options.accountKey);
      if (selected !== null && selected.account === null) {
        checks.push({ label: "pdd account selection", state: "FAIL", detail: selected.message ?? "unknown account" });
        accountConfigs = [];
      } else {
        const accounts = selected?.account === undefined || selected?.account === null
          ? config.pdd_accounts
          : [selected.account];
        accountConfigs = accounts.map((account) => ({
          accountKey: account.account_key,
          profileDir: account.profile_dir,
          label: account.display_label ?? account.account_key,
        }));
      }
    } else {
      accountConfigs = [{
        accountKey: config.account_keys[platform],
        profileDir: config.profile_dirs[platform],
        label: config.account_keys[platform],
      }];
    }

    if (platform === "pdd") {
      const browserLock = acquireLock(config.state_dir, platform, "__browser-global__", config.worker_id);
      if (browserLock.held) {
        browserLock.release();
        checks.push({ label: "pdd browser-global lock", state: "OK", detail: "acquired and released" });
      } else {
        checks.push({
          label: "pdd browser-global lock",
          state: "FAIL",
          detail: browserLock.reason === "reclaim-guard-present"
            ? "reclamation guard exists; confirm no sync-agent process is running, then remove the matching *.lock.reclaim file manually"
            : `held by ${describeHolder(browserLock.holder)}`,
        });
      }
    }

    for (const account of accountConfigs) {
      checks.push({
        label: `${platform}:${account.accountKey} profile dir`,
        state: existsSync(account.profileDir) ? "OK" : "WARN",
        detail: existsSync(account.profileDir)
          ? account.profileDir
          : `${account.profileDir} does not exist yet; run login-check to create and log in`,
      });
      checks.push({
        label: `${platform}:${account.accountKey} account`,
        state: "OK",
        detail: `${account.label} (cursor and lock are isolated per account_key)`,
      });

      const lock = acquireLock(config.state_dir, platform, account.accountKey, config.worker_id);
      if (lock.held) {
        lock.release();
        checks.push({ label: `${platform}:${account.accountKey} lock`, state: "OK", detail: "acquired and released" });
      } else {
        checks.push({
          label: `${platform}:${account.accountKey} lock`,
          state: "FAIL",
          detail: lock.reason === "reclaim-guard-present"
            ? "reclamation guard exists; confirm no sync-agent process is running, then remove the matching *.lock.reclaim file manually"
            : `held by ${describeHolder(lock.holder)}`,
        });
      }

      const cursor = loadCursor(config.state_dir, platform, account.accountKey);
      checks.push({
        label: `${platform}:${account.accountKey} cursor`,
        state: "OK",
        detail:
          cursor === null
            ? "no cursor yet"
            : `last=${cursor.last_status} failures=${cursor.consecutive_failures} sync=${cursor.last_sync_at ?? "never"}`,
      });
    }
  }

  if (!options.offline) {
    checks.push({ label: "headed chromium", ...(await checkLocalChromium(config)) });
  } else {
    checks.push({
      label: "headed chromium",
      state: "WARN",
      detail: "skipped (--offline); run without --offline in the actual desktop/Xvfb session to verify a visible launch",
    });
  }

  const failures = checks.filter((check) => check.state === "FAIL");
  const warnings = checks.filter((check) => check.state === "WARN");
  for (const check of checks) {
    process.stdout.write(`[${check.state.padEnd(4)}] ${check.label}: ${check.detail}\n`);
  }
  logger.info({
    command: "doctor",
    message: failures.length === 0 ? "doctor finished" : "doctor found failures",
    counts: { ok: checks.length - failures.length - warnings.length, warn: warnings.length, fail: failures.length },
  });
  return failures.length === 0 ? 0 : 1;
}

function selectedPddConfig(
  config: SyncConfig,
  accountKey: string | undefined,
): { config: SyncConfig; account: PddAccountConfig } | { error: string } {
  const selected = selectPddAccount(config, accountKey);
  if (selected.account === null) return { error: selected.message ?? "PDD account selection failed" };
  return { config: configForPddAccount(config, selected.account), account: selected.account };
}

async function runLoginCheckCommand(
  platform: Platform,
  accountKey?: string,
  waitSeconds?: number,
): Promise<number> {
  const { config, issues } = loadConfig();
  const configExit = requireValidConfig(issues);
  if (configExit !== null) return configExit;

  const logger = new JsonLogger({ logDir: config.log_dir });
  if (platform !== "pdd") return fail("only PDD login-check is supported", 1);
  const selected = selectedPddConfig(config, accountKey);
  if ("error" in selected) return fail(selected.error, 1);
  const outcome = await runLoginCheckFlow({
    config: selected.config,
    platform,
    logger,
    ...(waitSeconds === undefined
      ? {}
      : { nonInteractiveWait: { timeout_ms: waitSeconds * 1000 } }),
  });
  if (outcome.state !== null && outcome.checkedAt !== null) {
    await postPddAccountStatusBestEffort({
      config,
      account: selected.account,
      input: {
        status: outcome.state.status,
        message: outcome.state.detail,
      },
      checkedAt: outcome.checkedAt,
      logger,
    });
  }
  return outcome.exitCode;
}

async function runCapturePageCommand(platform: Platform, accountKey?: string): Promise<number> {
  const { config, issues } = loadConfig();
  const configExit = requireValidConfig(issues);
  if (configExit !== null) return configExit;

  const logger = new JsonLogger({ logDir: config.log_dir });
  if (platform !== "pdd") return fail("only PDD capture-page is supported", 1);
  const selected = selectedPddConfig(config, accountKey);
  if ("error" in selected) return fail(selected.error, 1);
  const outcome = await runCapturePage({ config: selected.config, platform, logger });
  return outcome.exitCode;
}

async function runSyncOnceCommand(
  platform: Platform,
  mode: "dry-run" | "commit",
  confirm: boolean,
  snapshotPath: string | undefined,
  accountKey: string | undefined,
): Promise<number> {
  const { config, issues } = loadConfig();
  const configExit = requireValidConfig(issues);
  if (configExit !== null) return configExit;

  const logger = new JsonLogger({ logDir: config.log_dir });
  if (platform !== "pdd") return fail("only PDD sync-once is supported", 1);
  const selected = selectedPddConfig(config, accountKey);
  if ("error" in selected) return fail(selected.error, 1);
  const outcome = await runSyncOnce({ config: selected.config, platform, mode, confirm, logger, snapshotPath });
  if (mode === "dry-run" && outcome.report.status !== "DISABLED") {
    await postPddAccountStatusBestEffort({
      config,
      account: selected.account,
      input: {
        status: outcome.report.status,
        ...(outcome.report.status === "OK" ? { count: outcome.report.counts.valid } : {}),
        message: outcome.report.error_code ?? "dry-run completed",
      },
      checkedAt: outcome.report.finished_at,
      logger,
    });
  }
  return outcome.exitCode;
}

function runAccountsCommand(): number {
  const { config, issues } = loadConfig();
  const configExit = requireValidConfig(issues);
  if (configExit !== null) return configExit;
  process.stdout.write(`Configured PDD accounts: ${config.pdd_accounts.length}\n`);
  for (const account of config.pdd_accounts) {
    const cursor = loadCursor(config.state_dir, "pdd", account.account_key);
    process.stdout.write(
      `- ${account.account_key}${account.display_label === null ? "" : ` (${account.display_label})`}\n` +
      `  profile: ${account.profile_dir}\n` +
      `  status: ${cursor?.last_status ?? "NOT_CHECKED"}; last_sync: ${cursor?.last_sync_at ?? "never"}\n`,
    );
  }
  return 0;
}

async function runSyncAllCommand(): Promise<number> {
  const { config, issues } = loadConfig();
  const configExit = requireValidConfig(issues);
  if (configExit !== null) return configExit;
  const logger = new JsonLogger({ logDir: config.log_dir });
  return (await runPddSyncAll({ config, logger })).exitCode;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "";
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      offline: { type: "boolean", default: false },
      platform: { type: "string" },
      account: { type: "string" },
      "wait-seconds": { type: "string" },
      mode: { type: "string" },
      "from-report": { type: "string" },
      yes: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const extraPositionals = positionals.filter((positional) => positional !== command);

  if (values.help || command === "" || command === "help" || command === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (extraPositionals.length > 0) {
    return fail(`unexpected arguments: ${extraPositionals.join(" ")}`);
  }

  const platform = parsePlatformFlag(values);
  if (command !== "doctor" && values.platform === undefined) {
    return fail(`--platform pdd is required for ${command}`);
  }
  if (values.platform !== undefined && platform === null) {
    return fail("--platform must be pdd");
  }
  if (platform === "1688") {
    return fail("1688 browser sync is retired; configure the backend official Open API (see docs/ALI1688_OPEN_API.md)", 1);
  }
  let waitSeconds: number | undefined;
  if (values["wait-seconds"] !== undefined) {
    if (!/^\d+$/.test(values["wait-seconds"])) {
      return fail("--wait-seconds must be an integer between 1 and 3600");
    }
    waitSeconds = Number.parseInt(values["wait-seconds"], 10);
    if (waitSeconds < 1 || waitSeconds > 3600) {
      return fail("--wait-seconds must be an integer between 1 and 3600");
    }
    if (command !== "login-check") {
      return fail("--wait-seconds is only valid with login-check");
    }
  }

  switch (command) {
    case "doctor":
      return runDoctor({ offline: values.offline, platform, accountKey: values.account });
    case "accounts":
      if (platform !== "pdd") return fail("accounts requires --platform pdd");
      if (values.account !== undefined) return fail("accounts lists all configured accounts; do not pass --account");
      return runAccountsCommand();
    case "login-check":
      if (platform === null) return fail(`--platform is required for login-check`);
      return runLoginCheckCommand(platform, values.account, waitSeconds);
    case "capture-page":
      if (platform === null) return fail(`--platform is required for capture-page`);
      return runCapturePageCommand(platform, values.account);
    case "sync-once": {
      if (platform === null) return fail(`--platform is required for sync-once`);
      if (values.mode === undefined) return fail(`--mode dry-run|commit is required for sync-once`);
      if (values.mode !== "dry-run" && values.mode !== "commit") {
        return fail("--mode must be dry-run or commit");
      }
      if (values.mode === "commit" && !values.yes) {
        return fail("commit requires --yes after reviewing the dry-run report; nothing was uploaded");
      }
      if (values.mode === "commit" && values["from-report"] === undefined) {
        return fail("commit requires --from-report <snapshot>; commit never re-opens the browser");
      }
      return runSyncOnceCommand(platform, values.mode, values.yes, values["from-report"], values.account);
    }
    case "sync-all":
      if (platform !== "pdd") return fail("sync-all requires --platform pdd");
      if (values.mode !== "dry-run") return fail("sync-all currently requires --mode dry-run; commit is disabled");
      if (values.account !== undefined) return fail("sync-all runs every configured account; do not pass --account");
      if (values.yes || values["from-report"] !== undefined) return fail("sync-all is dry-run only and does not accept commit flags");
      return runSyncAllCommand();
    default:
      return fail(`unknown command: ${command}\n\n${HELP}`);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`fatal: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
