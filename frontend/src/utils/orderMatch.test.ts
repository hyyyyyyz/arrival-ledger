import { describe, expect, it } from 'vitest'

import type { OrderMatch } from '@/types'
import { orderMatchKey, orderMatchSourceLabel } from './orderMatch'

function match(overrides: Partial<OrderMatch> = {}): OrderMatch {
  return {
    platform: 'pdd',
    platform_order_id: '260813-0001',
    shop_name: '同名店铺',
    ...overrides,
  }
}

describe('order match presentation', () => {
  it('uses the internal order id as the stable key when available', () => {
    expect(orderMatchKey(match({ order_id: '41', account_label: '主账号' }), 0)).toBe('order-41')
    expect(orderMatchKey(match({ order_id: '42', account_label: '备用账号' }), 0)).toBe('order-42')
    expect(orderMatchKey(match({ order_id: '41' }), 9)).toBe('order-41')
  })

  it('keeps legacy responses renderable and includes the account label in copy', () => {
    const primary = match({ account_label: '主账号' })
    const secondary = match({ account_label: '备用账号' })

    expect(orderMatchKey(primary, 0)).not.toBe(orderMatchKey(secondary, 0))
    expect(orderMatchSourceLabel(primary)).toBe('pdd · 主账号 · 同名店铺')
    expect(orderMatchSourceLabel(match())).toBe('pdd · 同名店铺')
  })
})
