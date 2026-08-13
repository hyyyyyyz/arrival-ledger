import { describe, expect, it } from "vitest";

import { REDACTED, isSensitiveKey, redactJson, redactText } from "../src/state/redact.js";

describe("isSensitiveKey", () => {
  it("flags credential and PII-ish keys", () => {
    for (const key of ["password", "api_key", "cookie", "Authorization", "phone", "mobile", "address", "receiver_name"]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
    for (const key of ["platform", "batch_id", "tracking_no", "title", "counts"]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });
});

describe("redactText", () => {
  it("masks bearer tokens", () => {
    expect(redactText("Authorization: Bearer abc.def.ghi")).not.toContain("abc.def.ghi");
    expect(redactText("Authorization: Bearer abc.def.ghi")).toContain(REDACTED);
  });
  it("masks 11-digit Chinese mobile numbers", () => {
    expect(redactText("收件人 13800138000 已签收")).not.toContain("13800138000");
  });
  it("masks long digit runs", () => {
    expect(redactText("card 6222021234567890123 end")).not.toContain("6222021234567890123");
  });
  it("leaves tracking numbers readable", () => {
    const text = "tracking SF5154076435411 ok";
    expect(redactText(text)).toBe(text);
  });
});

describe("redactJson", () => {
  it("redacts values by sensitive key names", () => {
    const output = redactJson({
      platform: "pdd",
      token: "top-secret-token",
      worker_key: "arrival-worker-secret",
      address: "北京市朝阳区测试路 1 号",
      tracking_no: "SF5154076435411",
    });
    expect(output["token"]).toBe(REDACTED);
    expect(output["worker_key"]).toBe(REDACTED);
    expect(output["address"]).toBe(REDACTED);
    expect(output["platform"]).toBe("pdd");
    expect(output["tracking_no"]).toBe("SF5154076435411");
  });

  it("redacts nested objects and arrays", () => {
    const output = redactJson({
      auth: { authorization: "Bearer nested-secret", scope: "sync" },
      config: { mobile: "13900000000" },
      items: [{ title: "good" }],
    });
    expect(output["auth"]).toBe(REDACTED);
    const config = output["config"] as Record<string, unknown>;
    expect(config["mobile"]).toBe(REDACTED);
    const items = output["items"] as Array<Record<string, unknown>>;
    expect(items[0]?.["title"]).toBe("good");
  });

  it("redacts credential text inside string values", () => {
    const output = redactJson({ message: "cookie session=abc123; phone 13800138000" });
    expect(output["message"]).not.toContain("13800138000");
    expect(output["message"]).not.toContain("session=abc123");
  });
});
