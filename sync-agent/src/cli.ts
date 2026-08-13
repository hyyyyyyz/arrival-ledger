import { existsSync, mkdirSync, accessSync, constants } from "node:fs";
import { parseArgs } from "node:util";

import { loadConfig, maskKey } from "./config.js";
import { JsonLogger } from "./log.js";
import { isPlatform, PLATFORMS, type Platform } from "./models.js";
import { acquireLock, describeHolder } from "./state/lock.js";
import { loadCursor } from "./state/cursor.js";

interface DoctorCheck {
  label: string;
  state: "OK" | "WARN" | "FAIL";
  detail: string;
}

const HELP = `arrival-ledger sync-agent (D1 skeleton)

Usage:
  sync-agent doctor [--offline] [--platform <pdd|1688>]
  sync-agent login-check --platform <pdd|1688>
  sync-agent sync-once --platform <pdd|1688> --mode <dry-run|commit>

Commands:
  doctor       Check local configuration, state, locks and (unless --offline)
               the local Chromium installation. Never contacts platform sites.
  login-check  Planned for D3/D4 (not implemented in this milestone).
  sync-once    Planned for D3/D4 (not implemented in this milestone).
`;

function parsePlatformFlag(values: { platform?: string } | undefined): Platform | null {
  const platform = values?.platform;
  if (platform === undefined) return null;
  if (!isPlatform(platform)) return null;
  return platform;
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
  const [major, minor] = process.versions.node.split(".").map(Number);
  checks.push({
    label: "node version",
    state: (major ?? 0) >= 20 ? "OK" : "FAIL",
    detail: `node ${process.versions.node} (>= 20 required)`,
  });

  const platforms = options.platform === null ? [...PLATFORMS] : [options.platform];

  for (const issue of issues) {
    checks.push({ label: `config ${issue.field}`, state: "WARN", detail: issue.message });
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
    detail: `${config.api_base_url} (sync-once is not implemented in D1; no request was made)`,
  });
  checks.push({
    label: "worker key",
    state: config.worker_key.length > 0 ? "OK" : "WARN",
    detail: config.worker_key.length > 0
      ? `configured as ${maskKey(config.worker_key)}`
      : "not set; required before the first commit (D2+)",
  });

  for (const platform of platforms) {
    const profileDir = config.profile_dirs[platform];
    checks.push({
      label: `${platform} profile dir`,
      state: existsSync(profileDir) ? "OK" : "WARN",
      detail: existsSync(profileDir)
        ? profileDir
        : `${profileDir} does not exist yet; create it before D3/D4 login checks`,
    });

    const lock = acquireLock(config.state_dir, platform, config.worker_id);
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

    const cursor = loadCursor(config.state_dir, platform);
    checks.push({
      label: `${platform} cursor`,
      state: "OK",
      detail:
        cursor === null
          ? "no cursor yet"
          : `last=${cursor.last_status} failures=${cursor.consecutive_failures}`,
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

function notImplemented(command: string, values: { platform?: string } | undefined): number {
  const platform = parsePlatformFlag(values);
  if (platform === null) {
    process.stderr.write(`error: --platform <pdd|1688> is required for ${command}\n`);
    return 2;
  }
  process.stderr.write(
    `${command} for ${platform} is not implemented in this milestone (D1); it will land with the D3/D4 visible-page adapters.\n`,
  );
  return 2;
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
      help: { type: "boolean", default: false },
    },
  });
  const extraPositionals = positionals.filter((positional) => positional !== command);

  if (values.help || command === "" || command === "help" || command === "--help") {
    process.stdout.write(HELP);
    return 0;
  }

  switch (command) {
    case "doctor": {
      if (extraPositionals.length > 0) {
        process.stderr.write(`error: unexpected arguments: ${extraPositionals.join(" ")}\n`);
        return 2;
      }
      const platform = parsePlatformFlag(values);
      if (values.platform !== undefined && platform === null) {
        process.stderr.write(`error: --platform must be one of: ${PLATFORMS.join(", ")}\n`);
        return 2;
      }
      return runDoctor({ offline: values.offline, platform });
    }
    case "login-check":
    case "sync-once": {
      if (command === "sync-once" && values.mode !== undefined && !["dry-run", "commit"].includes(values.mode)) {
        process.stderr.write("error: --mode must be dry-run or commit\n");
        return 2;
      }
      return notImplemented(command, values);
    }
    default: {
      process.stderr.write(`error: unknown command: ${command}\n\n${HELP}`);
      return 2;
    }
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
