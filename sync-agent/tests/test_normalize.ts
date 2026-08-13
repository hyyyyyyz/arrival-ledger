import { describe, expect, it } from "vitest";

import {
  cleanText,
  normalizeCourier,
  normalizeTrackingNo,
  orderIdMatchKey,
  parseDateToIso,
  parseQuantity,
  sanitizeOrderId,
  sanitizeTrackingNo,
  unwrapExcelString,
} from "../src/normalize.js";

describe("unwrapExcelString", () => {
  it("unwraps Excel string wrappers", () => {
    expect(unwrapExcelString('="464689789940513"')).toBe("464689789940513");
  });
  it("keeps plain values unchanged", () => {
    expect(unwrapExcelString("  464689789940513  ")).toBe("464689789940513");
  });
});

describe("normalizeTrackingNo", () => {
  it("must match the backend normalization: strip non-alphanumerics and uppercase", () => {
    expect(normalizeTrackingNo("SF 5154-0764 3541")).toBe("SF515407643541");
    expect(normalizeTrackingNo("yt123456")).toBe("YT123456");
    expect(normalizeTrackingNo("zto-9988")).toBe("ZTO9988");
    expect(normalizeTrackingNo("顺丰 sf 123")).toBe("SF123");
  });
  it("returns empty string for values without letters or digits", () => {
    expect(normalizeTrackingNo("---")).toBe("");
    expect(normalizeTrackingNo("")).toBe("");
  });
});

describe("orderIdMatchKey", () => {
  it("keeps IDs as strings and builds a stable match key", () => {
    expect(orderIdMatchKey('="240813-0011-2233"')).toBe("24081300112233");
    expect(orderIdMatchKey(" 240813-0011-2233 ")).toBe("24081300112233");
  });
});

describe("normalizeCourier", () => {
  it("collapses whitespace and uppercases", () => {
    expect(normalizeCourier("  顺丰 速运 ")).toBe("顺丰 速运");
    expect(normalizeCourier("sf express")).toBe("SF EXPRESS");
  });
});

describe("cleanText", () => {
  it("collapses whitespace", () => {
    expect(cleanText("  a   b\tc  ")).toBe("a b c");
  });
});

describe("parseQuantity", () => {
  it("parses integer quantities", () => {
    expect(parseQuantity("3")).toBe(3);
    expect(parseQuantity("x3")).toBe(3);
    expect(parseQuantity(5)).toBe(5);
  });
  it("rejects zero, negative, huge or non-numeric values", () => {
    expect(parseQuantity("0")).toBeNull();
    expect(parseQuantity("-2")).toBeNull();
    expect(parseQuantity("1234567")).toBeNull();
    expect(parseQuantity("abc")).toBeNull();
    expect(parseQuantity("1.5")).toBeNull();
    expect(parseQuantity(null)).toBeNull();
  });
});

describe("parseDateToIso", () => {
  it("parses common year-first formats", () => {
    const localMorning = new Date(2026, 7, 1, 10, 20, 30).toISOString();
    expect(parseDateToIso("2026-08-01")).toBe("2026-08-01T00:00:00.000Z");
    expect(parseDateToIso("2026-08-01 10:20:30")).toBe(localMorning);
    expect(parseDateToIso("2026/8/1 10:20")).toBe(new Date(2026, 7, 1, 10, 20, 0).toISOString());
    expect(parseDateToIso("20260801")).toBe(new Date(2026, 7, 1).toISOString());
    expect(parseDateToIso("2026-08-01T10:20:30+08:00")).toBe("2026-08-01T02:20:30.000Z");
  });
  it("rejects ambiguous or invalid values instead of guessing", () => {
    expect(parseDateToIso("08/01/2026")).toBeNull();
    expect(parseDateToIso("2026-13-01")).toBeNull();
    expect(parseDateToIso("not a date")).toBeNull();
    expect(parseDateToIso("")).toBeNull();
    expect(parseDateToIso(null)).toBeNull();
  });
});

describe("sanitizers", () => {
  it("cleans and bounds order ids and tracking numbers", () => {
    expect(sanitizeOrderId('  ="123456789" ')).toBe("123456789");
    expect(sanitizeTrackingNo(" SF 123 ")).toBe("SF 123");
    expect(sanitizeOrderId("x".repeat(200)).length).toBe(128);
  });
});
