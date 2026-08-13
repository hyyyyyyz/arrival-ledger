import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { redactJson } from "./state/redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  command?: string;
  platform?: string;
  worker?: string;
  batch_id?: string;
  status?: string;
  error_code?: string;
  message?: string;
  counts?: Record<string, number>;
}

export class JsonLogger {
  private readonly logDir: string | null;
  private readonly context: Record<string, unknown>;

  constructor(options: { logDir?: string | null; context?: Record<string, unknown> } = {}) {
    this.logDir = options.logDir ?? null;
    this.context = options.context ?? {};
  }

  log(level: LogLevel, fields: LogFields): void {
    const record = redactJson({
      ts: new Date().toISOString(),
      level,
      ...this.context,
      ...fields,
    });
    const line = JSON.stringify(record);
    process.stdout.write(`${line}\n`);
    if (this.logDir !== null) {
      try {
        mkdirSync(this.logDir, { recursive: true });
        appendFileSync(join(this.logDir, "sync-agent.jsonl"), `${line}\n`, { encoding: "utf8" });
      } catch {
        process.stdout.write(
          `${JSON.stringify({ ts: new Date().toISOString(), level: "warn", message: "failed to write log file", path: this.logDir })}\n`,
        );
      }
    }
  }

  debug(fields: LogFields): void {
    this.log("debug", fields);
  }

  info(fields: LogFields): void {
    this.log("info", fields);
  }

  warn(fields: LogFields): void {
    this.log("warn", fields);
  }

  error(fields: LogFields): void {
    this.log("error", fields);
  }
}
