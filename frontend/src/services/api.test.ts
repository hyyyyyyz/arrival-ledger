import { afterEach, describe, expect, it, vi } from 'vitest'

import { getCurrentSession, getDashboardStats } from './api'

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
