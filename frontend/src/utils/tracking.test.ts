import { describe, expect, it } from 'vitest'
import { isPlausibleTrackingNo, normalizeTrackingNo } from './tracking'

describe('tracking number helpers', () => {
  it('normalizes spaces, punctuation, and casing', () => {
    expect(normalizeTrackingNo(' sf-123 456 ')).toBe('SF123456')
  })

  it('rejects short or non-numeric barcode values', () => {
    expect(isPlausibleTrackingNo('1234567')).toBe(false)
    expect(isPlausibleTrackingNo('ABCDEFGH')).toBe(false)
  })

  it('accepts common alphanumeric tracking values', () => {
    expect(isPlausibleTrackingNo('YT1234567890123')).toBe(true)
  })
})
