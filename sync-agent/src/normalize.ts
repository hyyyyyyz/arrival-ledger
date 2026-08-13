const EXCEL_WRAPPER = /^="(.*)"$/;
const WHITESPACE = /\s+/g;

export function unwrapExcelString(value: string): string {
  const trimmed = value.trim();
  const match = EXCEL_WRAPPER.exec(trimmed);
  return match !== null ? match[1] ?? "" : trimmed;
}

export function cleanText(value: string): string {
  return value.replace(WHITESPACE, " ").trim();
}

export function normalizeTrackingNo(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

export function orderIdMatchKey(value: string): string {
  return unwrapExcelString(value).replace(/[^A-Za-z0-9]/g, "");
}

export function normalizeCourier(value: string): string {
  return cleanText(value).toUpperCase();
}

export function parseQuantity(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1 && value <= 999999 ? value : null;
  }
  if (typeof value !== "string") return null;
  const cleaned = value.replace(WHITESPACE, "");
  const match = /^[xX×]?(\d{1,6})$/.exec(cleaned);
  if (match === null) return null;
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return parsed >= 1 ? parsed : null;
}

const DATE_PATTERNS: ReadonlyArray<{ pattern: RegExp; parse: (match: RegExpExecArray) => string | null }> = [
  {
    pattern: /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/,
    parse: (match) =>
      buildDate(
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        match[6] !== undefined ? Number(match[6]) : 0,
      ),
  },
  {
    pattern: /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/,
    parse: (match) =>
      buildDate(Number(match[1]), Number(match[2]), Number(match[3]), 0, 0, 0),
  },
  {
    pattern: /^(\d{4})(\d{2})(\d{2})$/,
    parse: (match) =>
      buildDate(Number(match[1]), Number(match[2]), Number(match[3]), 0, 0, 0),
  },
];

function buildDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): string | null {
  if (year < 2000 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  if (second < 0 || second > 59) return null;
  const value = new Date(year, month - 1, day, hour, minute, second);
  if (
    value.getFullYear() !== year ||
    value.getMonth() !== month - 1 ||
    value.getDate() !== day
  ) {
    return null;
  }
  return value.toISOString();
}

const YEAR_FIRST = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}([T ]|$)/;

export function parseDateToIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if (cleaned.length === 0 || cleaned.length > 40) return null;
  if (YEAR_FIRST.test(cleaned)) {
    const direct = new Date(cleaned.replaceAll("/", "-"));
    if (!Number.isNaN(direct.getTime())) {
      const iso = direct.toISOString();
      const year = iso.slice(0, 4);
      if (year >= "2000" && year <= "2100") return iso;
    }
  }
  for (const { pattern, parse } of DATE_PATTERNS) {
    const match = pattern.exec(cleaned);
    if (match !== null) {
      const parsed = parse(match);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

export function sanitizeOrderId(value: string): string {
  return cleanText(unwrapExcelString(value)).slice(0, 128);
}

export function sanitizeTrackingNo(value: string): string {
  return cleanText(unwrapExcelString(value)).slice(0, 64);
}
