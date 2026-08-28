import { afterEach, describe, expect, it, vi } from 'vitest'

import { getCurrentSession, getDashboardStats, listOrders } from './api'

describe('authentication mode discovery', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps the backend trusted-LAN flag when bootstrapping', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            user: { id: 1, username: 'admin', display_name: '仓库', role: 'ADMIN' },
            auth_required: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    await expect(getCurrentSession()).resolves.toEqual({
      user: { id: 1, username: 'admin', display_name: '仓库', role: 'ADMIN' },
      authRequired: false,
    })
  })
})

describe('dashboard statistics', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('loads server-side order and arrival counts without local queue data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          total_orders: 184,
          arrival_photos: 7,
          matched_orders: 6,
          pending_orders: 178,
          candidate_photos: 2,
          unmatched_photos: 1,
          account_count: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(getDashboardStats()).resolves.toEqual({
      total_orders: 184,
      arrival_photos: 7,
      matched_orders: 6,
      pending_orders: 178,
      candidate_photos: 2,
      unmatched_photos: 1,
      account_count: 1,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/dashboard/stats',
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    )
  })
})

describe('purchase orders', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses the default page without sending empty filters', async () => {
    const payload = { items: [], total: 0, limit: 20, offset: 0 }
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(listOrders()).resolves.toEqual(payload)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/orders?limit=20&offset=0',
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    )
  })

  it('trims and encodes search, platform, and pagination parameters', async () => {
    const payload = { items: [], total: 0, limit: 20, offset: 20 }
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(listOrders({ limit: 20, offset: 20, query: '  手机 壳 #1  ', platform: '1688' })).resolves.toEqual(payload)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/orders?limit=20&offset=20&query=%E6%89%8B%E6%9C%BA+%E5%A3%B3+%231&platform=1688',
      expect.any(Object),
    )
  })
})
