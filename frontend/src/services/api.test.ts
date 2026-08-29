import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createUser,
  getCurrentSession,
  getDashboardStats,
  listOrders,
  listUsers,
  setUserActive,
  updateOrderArrivalStatus,
  updateReceiptTracking,
} from './api'

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

    await expect(listOrders({ limit: 20, offset: 20, query: '  手机 壳 #1  ', platform: '1688', arrival_status: 'pending' })).resolves.toEqual(payload)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/orders?limit=20&offset=20&query=%E6%89%8B%E6%9C%BA+%E5%A3%B3+%231&platform=1688&arrival_status=pending',
      expect.any(Object),
    )
  })

  it('submits an idempotent revision-checked manual arrival correction', async () => {
    const payload = {
      order_id: '42',
      effective_arrival_status: 'RECEIVED',
      evidence_arrival_status: 'PENDING',
      arrival_source: 'MANUAL',
      responsible_user: { id: 7, username: 'receiver', display_name: '张三', role: 'RECEIVER', is_active: true },
      manual_revision: 3,
      changed_at: '2026-08-30T12:00:00Z',
      audit_event_id: 9,
      idempotent_replay: false,
    }
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(updateOrderArrivalStatus('42', 'RECEIVED', 2, 'event-12345678')).resolves.toEqual(payload)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/orders/42/arrival-status',
      expect.objectContaining({
        method: 'PATCH',
        credentials: 'include',
        body: JSON.stringify({
          status: 'RECEIVED',
          expected_revision: 2,
          client_event_id: 'event-12345678',
        }),
      }),
    )
  })
})

describe('people management', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lists, creates, and enables or disables users without requesting passwords back', async () => {
    const person = {
      id: 8,
      username: 'lisi',
      display_name: '李四',
      role: 'RECEIVER',
      is_active: true,
      created_at: '2026-08-30T12:00:00Z',
      last_login_at: null,
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [person], total: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: person }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { ...person, is_active: false } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(listUsers()).resolves.toEqual([person])
    await expect(createUser({ username: 'lisi', display_name: '李四', password: 'temporary-pass', role: 'RECEIVER' })).resolves.toEqual(person)
    await expect(setUserActive(8, false)).resolves.toMatchObject({ id: 8, is_active: false })

    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ username: 'lisi', display_name: '李四', password: 'temporary-pass', role: 'RECEIVER' }),
    }))
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ is_active: false }),
    }))
  })
})

describe('receipt responsibility', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends an idempotency key when a logged-in user corrects a tracking number', async () => {
    const receipt = { id: 5, tracking_no: 'SF0000000001' }
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(receipt), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await updateReceiptTracking(5, 'SF0000000001', 'SF-OLD-0000001', 'edit-event-12345')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/receipts/5/tracking',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          tracking_no: 'SF0000000001',
          expected_tracking_no: 'SF-OLD-0000001',
          client_event_id: 'edit-event-12345',
        }),
      }),
    )
  })
})
