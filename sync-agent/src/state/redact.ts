export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY =
  /(password|passwd|secret|token|apikey|api_key|key|cookie|authorization|auth|phone|mobile|telephone|address|receiver|recipient|consignee|name)/i;

const BEARER_TOKEN = /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi;
const CN_PHONE = /\b1[3-9]\d{9}\b/g;
const LONG_DIGIT_GROUP = /\b\d{12,}\b/g;
const COOKIE_VALUE = /\b(cookie|session)\s*[=:]\s*[^\s;,]+/gi;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function redactText(value: string): string {
  return value
    .replace(BEARER_TOKEN, `bearer ${REDACTED}`)
    .replace(CN_PHONE, REDACTED)
    .replace(LONG_DIGIT_GROUP, REDACTED)
    .replace(COOKIE_VALUE, "$1=REDACTED");
}

export function redactValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (isSensitiveKey(key)) return REDACTED;
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === "object" && item !== null ? redactJson(item) : redactValue(key, item),
    );
  }
  if (typeof value === "object") return redactJson(value as Record<string, unknown>);
  return value;
}

export function redactJson(record: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    output[key] = redactValue(key, value);
  }
  return output;
}
