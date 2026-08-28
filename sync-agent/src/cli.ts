import { existsSync, mkdirSync, accessSync, constants } from "node:fs";
import { parseArgs } from "node:util";

import { configFailures, loadConfig, maskKey } from "./config.js";
import { runCapturePage } from "./capture_page.js";
import { runLoginCheck as runLoginCheckFlow } from "./login_check.js";
import { JsonLogger } from "./log.js";
import { isPlatform, type Platform } from "./models.js";
import { runSyncOnce } from "./run.js";
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
  sync-agent login-check --platform pdd
  sync-agent capture-page --platform pdd
  sync-agent sync-once --platform pdd --mode dry-run
  sync-agent sync-once --platform pdd --mode commit --from-report <snapshot> --yes

Commands:
  doctor       Check local configuration, state, locks and (unless --offline)
               the local Chromium installation. Never contacts platform sites.
  login-check  Open the visible browser on the platform order list and report
               login/captcha state. It never fills passwords or solves
               captchas; log in manually in the visible window.
  capture-page Open the order list exactly once and save a private structural
               diagnostic. It stores no raw HTML, free-form page text, screenshots,
               URL query, cookies or form values; it never opens details.
  sync-once    dry-run reads visible orders once and saves a private local
               snapshot; commit uploads EXACTLY the snapshot bytes and never
               re-opens the browser. commit requires --yes.

Flags:
  --offline       doctor: skip the Chromium check
  --platform      pdd (1688 browser sync is retired; use the backend Open API)
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

async function checkLocalChromium(): Promise<{ state: DoctorCheck["state"]; detail: string }> {
  let chromium: typeof import("playwright").chromium | null = null;
  try {
    chromium = (await import("playwright")).chromium;
  } catch (error) {
    return {
      state: "FAIL",
      detail: `playwright module unavailable: ${(error as Error).message}`,
    };
  }
  let browser: import("playwright").Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    return { state: "OK", detail: `chromium ${browser.version()}` };
  } catch (error) {
    return {
      state: "FAIL",
      detail: `cannot launch chromium: ${(error as Error).message}. Run "npx playwright install chromium" on this machine.`,
    };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function runDoctor(options: {
  offline: boolean;
  platform: Platform | null;
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
    const accountKey = config.account_keys[platform];
    const profileDir = config.profile_dirs[platform];
    checks.push({
      label: `${platform} profile dir`,
      state: existsSync(profileDir) ? "OK" : "WARN",
      detail: existsSync(profileDir)
        ? profileDir
        : `${profileDir} does not exist yet; run login-check to create and log in`,
    });
    checks.push({
      label: `${platform} account key`,
      state: "OK",
      detail: `${accountKey} (cursor and lock are isolated per account_key)`,
    });

    const lock = acquireLock(config.state_dir, platform, accountKey, config.worker_id);
    if (lock.held) {
      lock.release();
      checks.push({ label: `${platform} lock`, state: "OK", detail: "acquired and released" });
    } else {
      checks.push({
        label: `${platform} lock`,
        state: "FAIL",
        detail: `held by ${describeHolder(lock.holder)}`,
      });
    }

    const cursor = loadCursor(config.state_dir, platform, accountKey);
    checks.push({
      label: `${platform} cursor`,
      state: "OK",
      detail:
        cursor === null
          ? "no cursor yet"
          : `last=${cursor.last_status} failures=${cursor.consecutive_failures} sync=${cursor.last_sync_at ?? "never"}`,
    });
  }

  if (!options.offline) {
    checks.push({ label: "chromium", ...(await checkLocalChromium()) });
  } else {
    checks.push({
      label: "chromium",
      state: "WARN",
      detail: "skipped (--offline); run without --offline on the Windows machine to verify Chromium",
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

async function runLoginCheckCommand(platform: Platform): Promise<number> {
  const { config, issues } = loadConfig();
  const configExit = requireValidConfig(issues);
  if (configExit !== null) return configExit;

  const logger = new JsonLogger({ logDir: config.log_dir });
  const outcome = await runLoginCheckFlow({ config, platform, logger });
  return outcome.exitCode;
}

async function runCapturePageCommand(platform: Platform): Promise<number> {
  const { config, issues } = loadConfig();
  const configExit = requireValidConfig(issues);
  if (configExit !== null) return configExit;

  const logger = new JsonLogger({ logDir: config.log_dir });
  const outcome = await runCapturePage({ config, platform, logger });
  return outcome.exitCode;
}

async function runSyncOnceCommand(
  platform: Platform,
  mode: "dry-run" | "commit",
  confirm: boolean,
  snapshotPath: string | undefined,
): Promise<number> {
  const { config, issues } = loadConfig();
  const configExit = requireValidConfig(issues);
  if (configExit !== null) return configExit;

  const logger = new JsonLogger({ logDir: config.log_dir });
  const outcome = await runSyncOnce({ config, platform, mode, confirm, logger, snapshotPath });
  return outcome.exitCode;
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

  switch (command) {
    case "doctor":
      return runDoctor({ offline: values.offline, platform });
    case "login-check":
      if (platform === null) return fail(`--platform is required for login-check`);
      return runLoginCheckCommand(platform);
    case "capture-page":
      if (platform === null) return fail(`--platform is required for capture-page`);
      return runCapturePageCommand(platform);
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
      return runSyncOnceCommand(platform, values.mode, values.yes, values["from-report"]);
    }
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
