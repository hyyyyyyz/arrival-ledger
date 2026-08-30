import {
  configForPddAccount,
  type PddAccountConfig,
  type SyncConfig,
} from "./config.js";
import type { JsonLogger } from "./log.js";
import type { AccountStatusReport, SyncStatus } from "./models.js";
import { runSyncOnce, type RunOutcome } from "./run.js";
import { postAccountStatus, type TransportOptions } from "./transport.js";

export interface AccountStatusInput {
  status: SyncStatus;
  count?: number;
  message?: string;
}

export interface PddSyncAllResult {
  exitCode: number;
  results: Array<{
    account_key: string;
    exit_code: number;
    status: SyncStatus;
    count: number;
  }>;
}

type StatusPoster = (
  options: TransportOptions,
  report: AccountStatusReport,
) => Promise<void>;

type AccountRunner = (
  config: SyncConfig,
  account: PddAccountConfig,
) => Promise<RunOutcome>;

function cleanMessage(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 256);
}

export function buildPddAccountStatusReport(
  config: SyncConfig,
  account: PddAccountConfig,
  input: AccountStatusInput,
  checkedAt = new Date().toISOString(),
): AccountStatusReport {
  return {
    schema_version: 1,
    worker_id: config.worker_id,
    platform: "pdd",
    platform_account_key: account.account_key,
    ...(account.display_label === null ? {} : { platform_account_label: account.display_label }),
    status: input.status,
    checked_at: checkedAt,
    ...(input.status !== "OK" || input.count === undefined ? {} : { count: input.count }),
    ...(input.message === undefined || cleanMessage(input.message).length === 0
      ? {}
      : { message: cleanMessage(input.message) }),
  };
}

export async function postPddAccountStatusBestEffort(options: {
  config: SyncConfig;
  account: PddAccountConfig;
  input: AccountStatusInput;
  checkedAt: string;
  logger: JsonLogger;
  output?: (line: string) => void;
  poster?: StatusPoster;
}): Promise<"posted" | "skipped" | "failed"> {
  const write = options.output ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (options.config.worker_key.length === 0) {
    write(`[WARN] account status for ${options.account.account_key} was not reported: worker key is not configured.`);
    options.logger.warn({
      command: "account-status",
      platform: "pdd",
      message: `account status not reported for ${options.account.account_key}: worker key is not configured`,
      error_code: "CONFIG",
    });
    return "skipped";
  }
  const poster = options.poster ?? postAccountStatus;
  try {
    await poster(
      {
        api_base_url: options.config.api_base_url,
        worker_key: options.config.worker_key,
        max_retries: 0,
      },
      buildPddAccountStatusReport(options.config, options.account, options.input, options.checkedAt),
    );
    options.logger.info({
      command: "account-status",
      platform: "pdd",
      status: options.input.status,
      message: `account status reported for ${options.account.account_key}`,
    });
    return "posted";
  } catch (error) {
    write(`[WARN] account status for ${options.account.account_key} could not be reported; the local result is still available.`);
    options.logger.warn({
      command: "account-status",
      platform: "pdd",
      status: options.input.status,
      message: `account status report failed for ${options.account.account_key}: ${(error as Error).message}`,
      error_code: "NETWORK_ERROR",
    });
    return "failed";
  }
}

export async function runPddSyncAll(options: {
  config: SyncConfig;
  logger: JsonLogger;
  output?: (line: string) => void;
  runner?: AccountRunner;
  poster?: StatusPoster;
}): Promise<PddSyncAllResult> {
  const write = options.output ?? ((line: string) => process.stdout.write(`${line}\n`));
  const runner: AccountRunner = options.runner ?? (async (config) =>
    runSyncOnce({
      config,
      platform: "pdd",
      mode: "dry-run",
      confirm: false,
      logger: options.logger,
    }));
  const results: PddSyncAllResult["results"] = [];

  // Deliberately sequential: never use Promise.all here. Each account gets its
  // own persistent profile, lock, access cooldown and cursor through config.
  for (const account of options.config.pdd_accounts) {
    write(`[INFO] starting PDD dry-run for ${account.account_key}${account.display_label === null ? "" : ` (${account.display_label})`}...`);
    let outcome: RunOutcome;
    try {
      outcome = await runner(configForPddAccount(options.config, account), account);
    } catch (error) {
      const checkedAt = new Date().toISOString();
      options.logger.error({
        command: "sync-all",
        platform: "pdd",
        status: "NETWORK_ERROR",
        message: `unexpected failure for ${account.account_key}: ${(error as Error).message}`,
        error_code: "NETWORK_ERROR",
      });
      await postPddAccountStatusBestEffort({
        config: options.config,
        account,
        input: { status: "NETWORK_ERROR", message: "dry-run failed unexpectedly" },
        checkedAt,
        logger: options.logger,
        output: write,
        ...(options.poster === undefined ? {} : { poster: options.poster }),
      });
      results.push({ account_key: account.account_key, exit_code: 1, status: "NETWORK_ERROR", count: 0 });
      continue;
    }
    const count = outcome.report.counts.valid;
    // DISABLED represents a local preflight/lock/cooldown failure, not an
    // observed platform login state. Do not overwrite a previously reliable
    // backend status with that operational condition.
    if (outcome.report.status !== "DISABLED") {
      await postPddAccountStatusBestEffort({
        config: options.config,
        account,
        input: {
          status: outcome.report.status,
          ...(outcome.report.status === "OK" ? { count } : {}),
          message: outcome.report.error_code ?? "dry-run completed",
        },
        checkedAt: outcome.report.finished_at,
        logger: options.logger,
        output: write,
        ...(options.poster === undefined ? {} : { poster: options.poster }),
      });
    }
    results.push({
      account_key: account.account_key,
      exit_code: outcome.exitCode,
      status: outcome.report.status,
      count,
    });
    write(`[${outcome.exitCode === 0 ? "OK" : "FAIL"}] ${account.account_key}: ${outcome.report.status}, ${count} valid order(s).`);
  }
  return {
    exitCode: results.every((result) => result.exit_code === 0 && result.status === "OK") ? 0 : 1,
    results,
  };
}
