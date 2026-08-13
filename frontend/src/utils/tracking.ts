export function normalizeTrackingNo(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function isPlausibleTrackingNo(value: string): boolean {
  const normalized = normalizeTrackingNo(value)
  return normalized.length >= 8 && normalized.length <= 32 && /\d/.test(normalized)
}
