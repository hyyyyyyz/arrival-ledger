import { cleanText, normalizeTrackingNo, sanitizeTrackingNo, unwrapExcelString } from "../normalize.js";

export { normalizeTrackingNo, sanitizeTrackingNo };

export function hasTrackingPayload(value: string): boolean {
  return normalizeTrackingNo(value).length > 0;
}

const CANDIDATE = /[A-Za-z0-9-]{6,}/g;

export function splitLogisticsCell(text: string): { courier: string | null; tracking: string | null } {
  const cleaned = cleanText(text);
  if (cleaned.length === 0) return { courier: null, tracking: null };
  const candidates = cleaned.match(CANDIDATE) ?? [];
  let tracking: string | null = null;
  for (const candidate of candidates) {
    if (/[A-Za-z]/.test(candidate)) {
      tracking = candidate;
      break;
    }
  }
  if (tracking === null) {
    for (const candidate of candidates) {
      if (/^\d{8,24}$/.test(candidate)) {
        tracking = candidate;
        break;
      }
    }
  }
  if (tracking === null) return { courier: cleaned, tracking: null };
  const courier = cleaned.replace(tracking, " ").trim();
  return { courier: courier.length > 0 ? courier : null, tracking };
}

const EMPTY_TRACKING_TEXTS = new Set(["无", "-", "--", "暂无", "待发货", "未发货"]);

export function trackingFromLabeledText(text: string): string | null {
  const cleaned = cleanText(unwrapExcelString(text));
  if (cleaned.length === 0 || EMPTY_TRACKING_TEXTS.has(cleaned)) return null;
  const normalized = normalizeTrackingNo(cleaned);
  if (normalized.length < 6 || normalized.length > 24) return null;
  return sanitizeTrackingNo(cleaned).slice(0, 64);
}
