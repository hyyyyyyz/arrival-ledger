import { describe, expect, it, vi } from 'vitest'

import type { OrderListParams, OrderListResponse, PurchaseOrder } from '@/types'
import { ApiError } from '@/services/api'
import { useOrderPage } from './useOrderPage'

function order(id: string): PurchaseOrder {
  return {
    id,
    platform: '1688',
    account_label: '主账号',
    platform_order_id: `ORDER-${id}`,
    ordered_at: '2026-08-28T10:00:00+08:00',
    order_status: 'SHIPPED',
    shop_name: '测试店铺',
    source: 'ALI1688_API',
    items: [],
    packages: [],
    package_count: 0,
    arrived_package_count: 0,
    arrival_photo_count: 0,
    candidate_package_count: 0,
    candidate_photo_count: 0,
  }
}

function response(id: string, offset = 0, total = 41): OrderListResponse {
  return { items: [order(id)], total, limit: 20, offset, last_synced_at: '2026-08-30T01:30:00.000Z' }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve: (value: T) => void = () => {}
  let reject: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('order tab data behavior', () => {
  it('does not request orders until activated and refreshes on each entry', async () => {
    const request = vi.fn().mockResolvedValue(response('1'))
    const page = useOrderPage({ isOnline: () => true, onAuthRequired: vi.fn(), request })

    expect(request).not.toHaveBeenCalled()
    await page.activate()
    await page.activate()

    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenCalledWith({ limit: 20, offset: 0, query: '', platform: '', arrival_status: '' })
    expect(page.lastSyncedAt.value).toBe('2026-08-30T01:30:00.000Z')
    await page.refresh()
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('resets pagination for search and clamps page navigation', async () => {
    const request = vi.fn((params: OrderListParams) => Promise.resolve(response(String(params.offset), params.offset, 41)))
    const page = useOrderPage({ isOnline: () => true, onAuthRequired: vi.fn(), request })

    await page.activate()
    await page.search('  螺丝套装  ', '1688', 'pending')
    expect(request).toHaveBeenLastCalledWith({ limit: 20, offset: 0, query: '螺丝套装', platform: '1688', arrival_status: 'pending' })

    await page.goToPage(20)
    await page.goToPage(999)
    expect(request).toHaveBeenLastCalledWith({ limit: 20, offset: 40, query: '螺丝套装', platform: '1688', arrival_status: 'pending' })

    const callsAtLastPage = request.mock.calls.length
    await page.goToPage(999)
    expect(request).toHaveBeenCalledTimes(callsAtLastPage)
  })

  it('moves back to the last valid page when refreshed data shrinks', async () => {
    let shrunk = false
    const request = vi.fn((params: OrderListParams) => {
      if (shrunk && params.offset === 40) {
        return Promise.resolve({ ...response('gone', 40, 15), items: [] })
      }
      if (shrunk) return Promise.resolve(response('recovered', 0, 15))
      return Promise.resolve(response(String(params.offset), params.offset, 41))
    })
    const page = useOrderPage({ isOnline: () => true, onAuthRequired: vi.fn(), request })

    await page.activate()
    await page.goToPage(40)
    shrunk = true
    await page.refresh()

    expect(request).toHaveBeenLastCalledWith({ limit: 20, offset: 0, query: '', platform: '', arrival_status: '' })
    expect(page.offset.value).toBe(0)
    expect(page.total.value).toBe(15)
    expect(page.orders.value[0]?.id).toBe('recovered')
  })

  it('keeps applied filters and results when a new filter request fails', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response('existing'))
      .mockRejectedValueOnce(new Error('筛选服务失败'))
    const page = useOrderPage({ isOnline: () => true, onAuthRequired: vi.fn(), request })

    await page.activate()
    await page.search('新条件', 'pdd', 'review')

    expect(request).toHaveBeenLastCalledWith({ limit: 20, offset: 0, query: '新条件', platform: 'pdd', arrival_status: 'review' })
    expect(page.query.value).toBe('')
    expect(page.platform.value).toBe('')
    expect(page.arrivalStatus.value).toBe('')
    expect(page.orders.value[0]?.id).toBe('existing')
    expect(page.error.value).toBe('筛选服务失败')
  })

  it('keeps only the latest result when searches resolve out of order', async () => {
    const older = deferred<OrderListResponse>()
    const newer = deferred<OrderListResponse>()
    const request = vi.fn().mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise)
    const page = useOrderPage({ isOnline: () => true, onAuthRequired: vi.fn(), request })

    const activation = page.activate()
    const search = page.search('新条件', 'pdd', 'review')
    newer.resolve(response('new'))
    await search
    expect(page.orders.value[0]?.id).toBe('new')

    older.resolve(response('old'))
    await activation
    expect(page.orders.value[0]?.id).toBe('new')
  })

  it('keeps data invalidated when it changes during an in-flight request', async () => {
    const pending = deferred<OrderListResponse>()
    const request = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(response('fresh'))
    const page = useOrderPage({ isOnline: () => true, onAuthRequired: vi.fn(), request })

    const activation = page.activate()
    page.invalidate()
    pending.resolve(response('stale'))
    await activation
    expect(page.invalidated.value).toBe(true)

    await page.activate()
    expect(page.orders.value[0]?.id).toBe('fresh')
    expect(page.invalidated.value).toBe(false)
  })

  it('retries after offline activation and forwards only current 401 responses', async () => {
    let online = false
    const onAuthRequired = vi.fn()
    const request = vi.fn().mockResolvedValueOnce(response('online')).mockRejectedValueOnce(new ApiError(401, '登录过期'))
    const page = useOrderPage({ isOnline: () => online, onAuthRequired, request })

    await page.activate()
    expect(request).not.toHaveBeenCalled()
    expect(page.error.value).toContain('当前离线')

    online = true
    await page.activate()
    expect(page.orders.value[0]?.id).toBe('online')
    await page.refresh()
    expect(onAuthRequired).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale unauthorized response after reset', async () => {
    const pending = deferred<OrderListResponse>()
    const onAuthRequired = vi.fn()
    const page = useOrderPage({ isOnline: () => true, onAuthRequired, request: () => pending.promise })

    const activation = page.activate()
    page.reset()
    pending.reject(new ApiError(401, '旧会话已过期'))
    await activation

    expect(onAuthRequired).not.toHaveBeenCalled()
    expect(page.orders.value).toEqual([])
    expect(page.loading.value).toBe(false)
  })
})
