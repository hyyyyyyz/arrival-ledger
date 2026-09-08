import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UploadQueueItem } from '@/types'

import {
  API_REQUEST_TIMEOUT_MS,
  RECEIPT_PHOTO_READ_TIMEOUT_MS,
  RECEIPT_UPLOAD_TIMEOUT_MS,
  createPlatformAccount,
  createReceipt,
  createManualOrderBatch,
  createUser,
  getCurrentSession,
  getDashboardStats,
  listOrders,
  listPlatformAccounts,
  listUsers,
  setUserActive,
  updateOrderArrivalStatus,
  updateReceiptTracking,
} from './api'

function uploadItem(): UploadQueueItem {
  return {
    clientEventId: 'upload-event-stable-1',
    ownerUserId: 'operator-a',
    ownerDisplayName: '收货员',
    deviceId: 'test-device',
    occurredAt: '2026-09-08T00:00:00Z',
    photo: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }),
    fileName: 'evidence.jpg',
    trackingNo: 'SF12345678',
    barcodeState: 'FOUND',
    uploadState: 'QUEUED',
    readyToUpload: true,
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('bounded transport and photo preparation', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it.each(['', '<html><head><title>400 Bad Request</title></head></html>'])('classifies proxy body interruption as retryable transport failure: %s', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 400, headers: { 'Content-Type': 'text/html' } })))
    await expect(createReceipt(uploadItem())).rejects.toMatchObject({ status: 400, details: { transportFailure: true } })
  })

  it('retains explicit application validation errors without transport retry classification', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: 'image is empty' }), { status: 400, headers: { 'Content-Type': 'application/json' } })))
    await expect(createReceipt(uploadItem())).rejects.toMatchObject({ status: 400, details: { detail: 'image is empty' } })
  })

  it('settles an ordinary request even if fetch ignores abort forever', async () => {
    const fetchMock = vi.fn().mockReturnValue(new Promise<never>(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    const outcome = expect(getDashboardStats()).rejects.toMatchObject({ status: 408, details: { timeout: true } })
    await vi.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS)
    await outcome
    expect(fetchMock.mock.calls[0]?.[1].signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['application/json', 'text/plain'])('bounds a stalled %s response body', async (contentType) => {
    const response = new Response('', { headers: { 'Content-Type': contentType } })
    vi.spyOn(response, contentType === 'application/json' ? 'json' : 'text').mockImplementation(() => new Promise<never>(() => {}))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    const outcome = expect(getDashboardStats()).rejects.toMatchObject({ status: 408 })
    await vi.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS)
    await outcome
  })

  it('uses the longer upload deadline and retains the uncertain-result warning', async () => {
    const fetchMock = vi.fn().mockReturnValue(new Promise<never>(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    let settled = false
    const pending = createReceipt(uploadItem())
    const outcome = expect(pending).rejects.toMatchObject({
      status: 408,
      message: expect.stringContaining('服务器结果尚未确认'),
    })
    void pending.then(() => { settled = true }, () => { settled = true })
    await vi.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(RECEIPT_UPLOAD_TIMEOUT_MS - API_REQUEST_TIMEOUT_MS)
    await outcome
    expect(fetchMock.mock.calls[0]?.[1].signal.aborted).toBe(true)
  })

  it('cancels an in-flight upload even when fetch ignores its signal', async () => {
    const fetchMock = vi.fn().mockReturnValue(new Promise<never>(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const outcome = expect(createReceipt(uploadItem(), controller.signal)).rejects.toMatchObject({
      status: 0, details: { cancelled: true },
    })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await outcome
    expect(fetchMock.mock.calls[0]?.[1].signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels while a response body remains pending', async () => {
    const response = new Response('', { headers: { 'Content-Type': 'application/json' } })
    const readBody = vi.spyOn(response, 'json').mockReturnValue(new Promise<never>(() => {}))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    const controller = new AbortController()
    const outcome = expect(createReceipt(uploadItem(), controller.signal)).rejects.toMatchObject({ details: { cancelled: true } })
    await vi.advanceTimersByTimeAsync(0)
    expect(readBody).toHaveBeenCalledOnce()
    controller.abort()
    await outcome
    expect(vi.getTimerCount()).toBe(0)
  })

  it('counts photo preparation against the overall upload deadline', async () => {
    const item = uploadItem()
    let finishRead!: (bytes: ArrayBuffer) => void
    vi.spyOn(item.photo, 'arrayBuffer').mockReturnValue(new Promise<ArrayBuffer>((resolve) => { finishRead = resolve }))
    const fetchMock = vi.fn().mockReturnValue(new Promise<never>(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    const outcome = expect(createReceipt(item)).rejects.toMatchObject({ status: 408 })
    await vi.advanceTimersByTimeAsync(10_000)
    finishRead(new ArrayBuffer(item.photo.size))
    await vi.advanceTimersByTimeAsync(RECEIPT_UPLOAD_TIMEOUT_MS - 10_000)
    await outcome
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not read or send an already-cancelled photo', async () => {
    const item = uploadItem()
    const read = vi.spyOn(item.photo, 'arrayBuffer')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()
    await expect(createReceipt(item, controller.signal)).rejects.toMatchObject({ details: { cancelled: true } })
    expect(read).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles and cleans up when photo-byte reading never returns', async () => {
    const item = uploadItem()
    vi.spyOn(item.photo, 'arrayBuffer').mockReturnValue(new Promise<never>(() => {}))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const outcome = expect(createReceipt(item)).rejects.toMatchObject({ status: 0, details: { localPhotoRead: true, timeout: true } })
    await vi.advanceTimersByTimeAsync(RECEIPT_PHOTO_READ_TIMEOUT_MS)
    await outcome
    expect(fetchMock).not.toHaveBeenCalled()
    expect(item.photo.size).toBe(4)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels during stalled photo-byte reading without starting fetch', async () => {
    const item = uploadItem()
    vi.spyOn(item.photo, 'arrayBuffer').mockReturnValue(new Promise<never>(() => {}))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const outcome = expect(createReceipt(item, controller.signal)).rejects.toMatchObject({ details: { cancelled: true } })
    controller.abort()
    await outcome
    expect(fetchMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rehydrates the exact bytes and keeps the original event ID, MIME type and filename', async () => {
    const item = uploadItem()
    const read = vi.spyOn(item.photo, 'arrayBuffer')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 1, client_event_id: item.clientEventId }), { headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(createReceipt(item)).resolves.toMatchObject({ id: 1 })
    const body = fetchMock.mock.calls[0]?.[1].body as FormData
    const sentPhoto = body.get('photo') as File
    expect(read).toHaveBeenCalledOnce()
    expect(body.get('client_event_id')).toBe(item.clientEventId)
    expect(body.get('tracking_no')).toBe(item.trackingNo)
    expect(sentPhoto).not.toBe(item.photo)
    expect(sentPhoto.name).toBe(item.fileName)
    expect(sentPhoto.type).toBe('image/jpeg')
    expect(new Uint8Array(await sentPhoto.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([0, 3])('does not send a photo when materialized bytes have invalid length %s', async (length) => {
    const item = uploadItem()
    vi.spyOn(item.photo, 'arrayBuffer').mockResolvedValue(new ArrayBuffer(length))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(createReceipt(item)).rejects.toMatchObject({ status: 0, details: { localPhotoRead: true } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    null,
    {},
    { id: 1 },
    { id: 1, client_event_id: 'different-event' },
    { id: '', client_event_id: 'upload-event-stable-1' },
    { id: 0, client_event_id: 'upload-event-stable-1' },
    { receipt: null },
  ])('rejects a 200 response that cannot confirm the same receipt: %j', async (payload) => {
    const item = uploadItem()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json' },
    })))
    await expect(createReceipt(item)).rejects.toMatchObject({
      status: 0, details: { invalidReceiptConfirmation: true, responseUncertain: true },
    })
    expect(item.clientEventId).toBe('upload-event-stable-1')
    expect(item.photo.size).toBe(4)
  })

  it('accepts a wrapped receipt only when its event ID confirms the current upload', async () => {
    const item = uploadItem()
    const receipt = { id: 1, client_event_id: item.clientEventId }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ receipt }), {
      headers: { 'Content-Type': 'application/json' },
    })))
    await expect(createReceipt(item)).resolves.toEqual(receipt)
  })

  it('handles a late fetch rejection after the request timed out', async () => {
    let rejectFetch!: (error: Error) => void
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((_, reject) => { rejectFetch = reject })))
    const outcome = expect(getDashboardStats()).rejects.toMatchObject({ status: 408 })
    await vi.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS)
    await outcome
    rejectFetch(new Error('late network rejection'))
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves a completed HTTP failure instead of treating it as a network timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: '请登录' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    })))
    await expect(getDashboardStats()).rejects.toMatchObject({ status: 401, message: '请登录' })
    expect(vi.getTimerCount()).toBe(0)
  })
})

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

describe('platform account management', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lists PDD accounts and registers only the stable account identity', async () => {
    const account = {
      id: 3,
      platform: 'pdd',
      account_key: 'pdd-main',
      display_label: '主采购账号',
      source: 'BROWSER_PROFILE',
      status: 'NEEDS_LOGIN',
      last_attempt_at: null,
      last_success_at: null,
      last_count: 0,
      message: null,
      order_count: 0,
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [account], total: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ account }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(listPlatformAccounts('pdd')).resolves.toEqual({ items: [account], total: 1 })
    await expect(createPlatformAccount({ platform: 'pdd', account_key: 'pdd-main', display_label: '主采购账号' })).resolves.toEqual(account)

    expect(fetchMock.mock.calls[0]).toEqual([
      '/api/platform-accounts?platform=pdd',
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    ])
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ platform: 'pdd', account_key: 'pdd-main', display_label: '主采购账号' }),
    }))
    expect(String(fetchMock.mock.calls[1]?.[1]?.body)).not.toMatch(/password|cookie|token/i)
  })
})

describe('manual order batch import', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('posts one idempotent batch request to the backend contract', async () => {
    const response = {
      client_batch_id: 'manual-batch-12345678',
      idempotent_replay: false,
      total_count: 1,
      unique_count: 1,
      created_count: 1,
      idempotent_count: 0,
      duplicate_count: 0,
      failed_count: 0,
      items: [{ input_index: 1, status: 'CREATED', tracking_no: 'SF12345678' }],
    }
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const request = {
      client_batch_id: 'manual-batch-12345678',
      rows: [{ row_number: 2, tracking_no: 'SF12345678', product_name: '办公用品' }],
    }
    await expect(createManualOrderBatch(request)).resolves.toEqual(response)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/manual-orders/batch',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(request) }),
    )
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
