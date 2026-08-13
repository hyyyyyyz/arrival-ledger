import { describe, expect, it, vi } from "vitest";

import { JsonLogger } from "../src/log.js";
import { REDACTED } from "../src/state/redact.js";

describe("JsonLogger", () => {
  it("emits a single JSON line with redacted message content", () => {
    const lines: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: string) => {
        lines.push(chunk);
        return true;
      }) as never);
    try {
      const logger = new JsonLogger({ logDir: null });
      logger.info({
        command: "doctor",
        message: "auth Bearer tok.secret.xyz phone 13800138000 done",
        counts: { ok: 1 },
      });
    } finally {
      write.mockRestore();
    }
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(record["level"]).toBe("info");
    expect(record["command"]).toBe("doctor");
    expect(String(record["message"])).not.toContain("tok.secret.xyz");
    expect(String(record["message"])).not.toContain("13800138000");
    expect(String(record["message"])).toContain(REDACTED);
  });

  it("redacts sensitive keys in context", () => {
    const lines: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: string) => {
        lines.push(chunk);
        return true;
      }) as never);
    try {
      const logger = new JsonLogger({
        logDir: null,
        context: { worker_key: "do-not-leak", platform: "pdd" },
      });
      logger.info({ message: "hello" });
    } finally {
      write.mockRestore();
    }
    const record = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(record["worker_key"]).toBe(REDACTED);
    expect(record["platform"]).toBe("pdd");
  });
});
