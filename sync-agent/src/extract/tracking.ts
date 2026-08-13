import { normalizeTrackingNo, sanitizeTrackingNo } from "../normalize.js";

export { normalizeTrackingNo, sanitizeTrackingNo };

export function hasTrackingPayload(value: string): boolean {
  return normalizeTrackingNo(value).length > 0;
}
