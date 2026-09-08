// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Receipt, UploadQueueItem } from '@/types'
import { ApiError, RECEIPT_UPLOAD_TIMEOUT_MS } from './api'
import { PHOTO_PREPARATION_TIMEOUT_MS } from './preparePhoto'
import { isRetryableUploadError, UploadQueue } from './uploadQueue'

const mocks = vi.hoisted(() => ({
  createReceipt: vi.fn(),
  deleteUpload: vi.fn(),
  getAllUploads: vi.fn(),
  getUpload: vi.fn(),
  putUpload: vi.fn(),
  compressImage: vi.fn(),
  recognizeTrackingNo: vi.fn(),
}))

vi.mock('./api', async (importOriginal) => {
  const original = await importOriginal<typeof import('./api')>()
  return { ...original, createReceipt: mocks.createReceipt }
})

vi.mock('./db', () => ({
  deleteUpload: mocks.deleteUpload,
  getAllUploads: mocks.getAllUploads,
  getUpload: mocks.getUpload,
  putUpload: mocks.putUpload,
}))
vi.mock('./image', () => ({ compressImage: mocks.compressImage }))
vi.mock('./barcode', () => ({ recognizeTrackingNo: mocks.recognizeTrackingNo }))

function queueItem(overrides: Partial<UploadQueueItem> = {}): UploadQueueItem {
  return {
    clientEventId: 'gallery-client-event-0001',
    ownerUserId: '1',
    ownerDisplayName: '收货员',
    deviceId: 'device-1',
    occurredAt: '2026-09-01T08:00:00.000Z',
    photo: new Blob(['photo'], { type: 'image/jpeg' }),
    fileName: 'photo.jpg',
    trackingNo: null,
    barcodeState: 'NOT_FOUND',
    uploadState: 'QUEUED',
    readyToUpload: true,
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    inputMethod: 'PHOTO_LIBRARY',
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((fulfill) => { resolve = fulfill })
  return { promise, resolve }
}

function acknowledgement(item: UploadQueueItem): Receipt {
  return { id: `receipt-${item.clientEventId}`, client_event_id: item.clientEventId }
}

function delayedFailure(signal: AbortSignal, delay: number): Promise<never> {
  return new Promise<never>((_, reject) => {
    const cancel = (): void => {
      clearTimeout(timer)
      reject(new ApiError(0, 'cancelled', { cancelled: true }))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel)
      reject(new ApiError(408, 'slow upload timed out'))
    }, delay)
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
}

describe('UploadQueue durable recovery, cancellation and retry', () => {
  const records = new Map<string, UploadQueueItem>()
  const queues: UploadQueue[] = []
  const newQueue = (): UploadQueue => {
    const queue = new UploadQueue()
    queues.push(queue)
    return queue
  }
  const seed = (...items: UploadQueueItem[]): void => {
    for (const item of items) records.set(item.clientEventId, { ...item })
  }
  const settle = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0) }

  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T00:00:00Z'))
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    records.clear()
    mocks.getAllUploads.mockImplementation(async () => [...records.values()].map((item) => ({ ...item })))
    mocks.getUpload.mockImplementation(async (id: string) => {
      const item = records.get(id)
      return item ? { ...item } : null
    })
    mocks.putUpload.mockImplementation(async (item: UploadQueueItem) => {
      await Promise.resolve()
      records.set(item.clientEventId, { ...item })
    })
    mocks.deleteUpload.mockImplementation(async (id: string) => {
      await Promise.resolve()
      records.delete(id)
    })
    mocks.createReceipt.mockImplementation(async (item: UploadQueueItem) => acknowledgement(item))
    mocks.compressImage.mockImplementation(async (photo: Blob) => ({ blob: photo }))
    mocks.recognizeTrackingNo.mockResolvedValue(null)
  })

  afterEach(async () => {
    for (const queue of queues.splice(0)) queue.dispose()
    await settle()
    vi.clearAllTimers()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('restores PROCESSING photos for preparation without claiming they are ready', async () => {
    const original = queueItem({ readyToUpload: false, barcodeState: 'PROCESSING' })
    const uploading = queueItem({ clientEventId: 'interrupted-upload', uploadState: 'UPLOADING' })
    seed(original, uploading)
    await newQueue().initialize()
    expect(records.get(original.clientEventId)).toMatchObject({
      barcodeState: 'PROCESSING', uploadState: 'QUEUED', readyToUpload: false,
      needsPreparation: true, nextAttemptAt: 0, inputMethod: 'PHOTO_LIBRARY',
    })
    expect(records.get(original.clientEventId)?.photo).toBe(original.photo)
    expect(records.get(uploading.clientEventId)).toMatchObject({ uploadState: 'QUEUED', readyToUpload: true })
    expect(mocks.createReceipt).not.toHaveBeenCalled()
  })

  it('retries initialization after storage failure and installs resume listeners once', async () => {
    mocks.getAllUploads.mockRejectedValueOnce(new Error('database unavailable'))
    const queue = newQueue()
    await expect(queue.initialize()).rejects.toThrow('database unavailable')
    await queue.initialize()
    await queue.initialize()
    const process = vi.spyOn(queue, 'process').mockResolvedValue(undefined)
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('pageshow'))
    expect(process).toHaveBeenCalledTimes(3)
  })

  it('replaces a staged photo without changing its event ID or readiness', async () => {
    const original = queueItem({ readyToUpload: false, barcodeState: 'PROCESSING' })
    const compressed = new Blob(['compressed'], { type: 'image/jpeg' })
    seed(original)
    await newQueue().replacePreparedPhoto(original.clientEventId, compressed, 'compressed.jpg')
    expect(records.get(original.clientEventId)).toMatchObject({
      clientEventId: original.clientEventId, photo: compressed, fileName: 'compressed.jpg', readyToUpload: false,
    })
  })

  it('automatically retries only transient transport and server failures', () => {
    expect(isRetryableUploadError(new Error('offline'))).toBe(true)
    for (const status of [0, 408, 429, 500, 503]) expect(isRetryableUploadError(new ApiError(status, 'transient'))).toBe(true)
    for (const status of [400, 401, 403, 409, 413, 415, 422]) expect(isRetryableUploadError(new ApiError(status, 'permanent'))).toBe(false)
    expect(isRetryableUploadError(new ApiError(400, 'multipart interrupted', { transportFailure: true }))).toBe(true)
    expect(isRetryableUploadError(new ApiError(400, 'invalid field', { detail: 'invalid field' }))).toBe(false)
  })

  it('cancels a hanging send, retries the same event, then uploads the next photo without overlap', async () => {
    const first = queueItem()
    const second = queueItem({ clientEventId: 'gallery-client-event-0002', createdAt: 2 })
    seed(first, second)
    let concurrent = 0
    let maxConcurrent = 0
    const sentIds: string[] = []
    mocks.createReceipt.mockImplementation(async (item: UploadQueueItem, signal: AbortSignal) => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      sentIds.push(item.clientEventId)
      try {
        if (sentIds.length === 1) return await new Promise<Receipt>((_, reject) => {
          signal.addEventListener('abort', () => reject(new ApiError(0, 'cancelled', { cancelled: true })), { once: true })
        })
        return acknowledgement(item)
      } finally { concurrent -= 1 }
    })
    const queue = newQueue()
    queue.setAuthenticatedUser('1')
    await settle()
    void queue.process()
    void queue.process()
    expect(sentIds).toEqual([first.clientEventId])
    expect(mocks.deleteUpload).not.toHaveBeenCalled()
    await queue.retryNow()
    await settle()
    expect(sentIds).toEqual([first.clientEventId, first.clientEventId, second.clientEventId])
    expect(maxConcurrent).toBe(1)
    expect(concurrent).toBe(0)
    expect(records.size).toBe(0)
    expect(mocks.createReceipt.mock.calls[1]?.[0]).toMatchObject({ attempts: 0, clientEventId: first.clientEventId })
    expect(mocks.createReceipt.mock.calls[1]?.[0].photo).toBe(first.photo)
    expect(mocks.deleteUpload.mock.calls.map(([id]) => id)).toEqual([first.clientEventId, second.clientEventId])
  })

  it('uses wall-clock age on focus to release a suspended upload past its deadline', async () => {
    seed(queueItem())
    mocks.createReceipt.mockImplementationOnce((_item: UploadQueueItem, signal: AbortSignal) => new Promise<Receipt>((_, reject) => {
      signal.addEventListener('abort', () => reject(new ApiError(0, 'cancelled')), { once: true })
    }))
    const queue = newQueue()
    await queue.initialize()
    queue.setAuthenticatedUser('1')
    await settle()
    expect(mocks.createReceipt).toHaveBeenCalledOnce()
    vi.setSystemTime(Date.now() + RECEIPT_UPLOAD_TIMEOUT_MS + 1)
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(mocks.createReceipt).toHaveBeenCalledTimes(2)
    expect(records.size).toBe(0)
  })

  it('retains exact evidence when the API rejects an invalid receipt confirmation', async () => {
    const item = queueItem()
    seed(item)
    mocks.createReceipt.mockRejectedValueOnce(new ApiError(0, '服务器收货确认无效', {
      invalidReceiptConfirmation: true, responseUncertain: true,
    }))
    const queue = newQueue()
    queue.setAuthenticatedUser('1')
    await settle()
    expect(mocks.deleteUpload).not.toHaveBeenCalled()
    expect(records.get(item.clientEventId)).toMatchObject({ uploadState: 'FAILED', attempts: 1, lastError: '服务器收货确认无效' })
    expect(records.get(item.clientEventId)?.photo).toBe(item.photo)
    expect(records.get(item.clientEventId)?.nextAttemptAt).toBe(Date.now() + 2_000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.createReceipt).toHaveBeenCalledTimes(2)
    expect(mocks.createReceipt.mock.calls[1]?.[0].clientEventId).toBe(item.clientEventId)
    expect(records.size).toBe(0)
  })

  it('retains evidence if deletion fails after a definite server acknowledgement', async () => {
    const item = queueItem()
    seed(item)
    mocks.deleteUpload.mockRejectedValueOnce(new Error('commit unavailable'))
    const queue = newQueue()
    queue.setAuthenticatedUser('1')
    await settle()
    expect(records.get(item.clientEventId)?.photo).toBe(item.photo)
    expect(records.get(item.clientEventId)?.uploadState).toBe('FAILED')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.createReceipt.mock.calls.map(([sent]) => sent.clientEventId)).toEqual([item.clientEventId, item.clientEventId])
    expect(records.size).toBe(0)
  })

  it('reports a storage read failure and recovers on the retry timer', async () => {
    seed(queueItem())
    mocks.getAllUploads.mockRejectedValueOnce(new Error('database read timeout'))
    const queue = newQueue()
    const errors: string[] = []
    queue.addEventListener('queue-error', (event) => errors.push((event as CustomEvent<string>).detail))
    queue.setAuthenticatedUser('1')
    await settle()
    expect(errors).toEqual(['database read timeout'])
    expect(mocks.createReceipt).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(mocks.createReceipt).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(records.size).toBe(0)
    expect(mocks.createReceipt).toHaveBeenCalledOnce()
  })

  it('recovers when both the UPLOADING write and its failure-status write reject', async () => {
    const item = queueItem()
    seed(item)
    mocks.putUpload.mockRejectedValueOnce(new Error('write unavailable')).mockRejectedValueOnce(new Error('failure write unavailable'))
    const queue = newQueue()
    const errors = vi.fn()
    queue.addEventListener('queue-error', errors)
    queue.setAuthenticatedUser('1')
    await settle()
    expect(errors).toHaveBeenCalledOnce()
    expect(mocks.createReceipt).not.toHaveBeenCalled()
    expect(records.get(item.clientEventId)?.photo).toBe(item.photo)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(records.size).toBe(0)
    expect(mocks.createReceipt).toHaveBeenCalledOnce()
  })

  it('retries an authentication-paused record immediately after its owner logs in again', async () => {
    const item = queueItem()
    seed(item)
    mocks.createReceipt.mockRejectedValueOnce(new ApiError(401, '请登录'))
    const queue = newQueue()
    const authRequired = vi.fn()
    queue.addEventListener('auth-required', authRequired)
    queue.setAuthenticatedUser('1')
    await settle()
    expect(authRequired).toHaveBeenCalledOnce()
    expect(records.get(item.clientEventId)).toMatchObject({ requiresAuth: true, uploadState: 'FAILED', nextAttemptAt: Number.MAX_SAFE_INTEGER })
    await expect(queue.itemsForCurrentUser()).resolves.toEqual([])
    expect(mocks.deleteUpload).not.toHaveBeenCalled()
    queue.setAuthenticatedUser('1')
    await settle()
    expect(mocks.createReceipt).toHaveBeenCalledTimes(2)
    expect(records.size).toBe(0)
  })

  it('does not POST the old owner photo when the account changes during its UPLOADING write', async () => {
    const oldItem = queueItem()
    const newItem = queueItem({ clientEventId: 'other-owner-event', ownerUserId: '2' })
    seed(oldItem, newItem)
    const gate = deferred<void>()
    mocks.putUpload.mockImplementationOnce(async (item: UploadQueueItem) => {
      await gate.promise
      records.set(item.clientEventId, { ...item })
    })
    const queue = newQueue()
    queue.setAuthenticatedUser('1')
    await settle()
    expect(mocks.putUpload).toHaveBeenCalledOnce()
    queue.setAuthenticatedUser('2')
    gate.resolve(undefined)
    await settle()
    expect(mocks.createReceipt.mock.calls.map(([item]) => item.ownerUserId)).toEqual(['2'])
    expect(records.get(oldItem.clientEventId)?.photo).toBe(oldItem.photo)
    expect(records.has(newItem.clientEventId)).toBe(false)
  })

  it('retry-all only changes the current owner and overrides a false offline signal', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const own = queueItem({ uploadState: 'FAILED', nextAttemptAt: Number.MAX_SAFE_INTEGER, lastError: 'old failure' })
    const other = queueItem({ clientEventId: 'other-owner-event', ownerUserId: '2', uploadState: 'FAILED', nextAttemptAt: Number.MAX_SAFE_INTEGER, lastError: 'other failure' })
    seed(own, other)
    const queue = newQueue()
    queue.setAuthenticatedUser('1')
    await queue.retryNow()
    await settle()
    expect(mocks.createReceipt.mock.calls.map(([item]) => item.ownerUserId)).toEqual(['1'])
    expect(records.get(other.clientEventId)).toEqual(other)
    expect(records.has(own.clientEventId)).toBe(false)
    expect(mocks.putUpload.mock.calls.every(([item]) => item.ownerUserId === '1')).toBe(true)
  })

  it('preserves forced-online retry intent while a previous queue read is unwinding', async () => {
    const item = queueItem({ uploadState: 'FAILED', nextAttemptAt: Number.MAX_SAFE_INTEGER })
    seed(item)
    const readGate = deferred<UploadQueueItem[]>()
    mocks.getAllUploads.mockReturnValueOnce(readGate.promise)
    const queue = newQueue()
    queue.setAuthenticatedUser('1')
    await settle()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    await queue.retryNow()
    expect(mocks.createReceipt).not.toHaveBeenCalled()
    readGate.resolve([{ ...item }])
    await settle()
    expect(mocks.createReceipt).toHaveBeenCalledOnce()
    expect(records.size).toBe(0)
  })

  it('moves past a timed-out photo before retrying it after backoff', async () => {
    const first = queueItem()
    const second = queueItem({ clientEventId: 'second-photo', createdAt: 2 })
    seed(first, second)
    mocks.createReceipt.mockRejectedValueOnce(new ApiError(408, '服务器结果尚未确认'))
    const queue = newQueue()
    queue.setAuthenticatedUser('1')
    await settle()
    expect(mocks.createReceipt.mock.calls.map(([item]) => item.clientEventId)).toEqual([first.clientEventId, second.clientEventId])
    expect(records.get(first.clientEventId)?.photo).toBe(first.photo)
    expect(records.has(second.clientEventId)).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.createReceipt.mock.calls.map(([item]) => item.clientEventId)).toEqual([
      first.clientEventId, second.clientEventId, first.clientEventId,
    ])
    expect(records.size).toBe(0)
  })

  it('gives every untouched photo its first turn before repeatedly slow failures retry', async () => {
    const items = ['slow-a', 'slow-b', 'new-c', 'new-d'].map((clientEventId, index) => queueItem({ clientEventId, createdAt: index + 1 }))
    seed(...items)
    const attempts = new Map<string, number>()
    let concurrent = 0
    let maxConcurrent = 0
    mocks.createReceipt.mockImplementation(async (item: UploadQueueItem, signal: AbortSignal) => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      const attempt = (attempts.get(item.clientEventId) ?? 0) + 1
      attempts.set(item.clientEventId, attempt)
      try {
        if (item.clientEventId.startsWith('slow-') && attempt <= 2) {
          await delayedFailure(signal, 10_000)
        }
        return acknowledgement(item)
      } finally { concurrent -= 1 }
    })
    const queue = newQueue()
    queue.setAuthenticatedUser('1')
    await settle()
    await vi.advanceTimersByTimeAsync(20_000)
    const sentIds = () => mocks.createReceipt.mock.calls.map(([item]) => item.clientEventId)
    expect(sentIds()).toEqual(['slow-a', 'slow-b', 'new-c', 'new-d', 'slow-a'])
    expect(records.has('new-c')).toBe(false)
    expect(records.has('new-d')).toBe(false)
    expect(records.get('slow-a')?.photo).toBe(items[0]?.photo)
    expect(records.get('slow-b')?.photo).toBe(items[1]?.photo)
    await vi.advanceTimersByTimeAsync(24_000)
    expect(sentIds()).toEqual(['slow-a', 'slow-b', 'new-c', 'new-d', 'slow-a', 'slow-b', 'slow-a', 'slow-b'])
    expect(maxConcurrent).toBe(1)
    expect(concurrent).toBe(0)
    expect(records.size).toBe(0)
  })

  it.each(['automatic', 'retry-all'])('fairly schedules all previously failed photos during %s retries', async (mode) => {
    const now = Date.now()
    const items = [
      queueItem({ clientEventId: 'retry-a', createdAt: 1, attempts: 1, uploadState: 'FAILED', nextAttemptAt: now - 1_000 }),
      queueItem({ clientEventId: 'retry-b', createdAt: 2, attempts: 1, uploadState: 'FAILED', nextAttemptAt: now - 3_000 }),
      queueItem({ clientEventId: 'retry-c', createdAt: 3, attempts: 1, uploadState: 'FAILED', nextAttemptAt: now - 2_000 }),
    ]
    seed(...items)
    const attempts = new Set<string>()
    mocks.createReceipt.mockImplementation(async (item: UploadQueueItem, signal: AbortSignal) => {
      if (!attempts.has(item.clientEventId)) {
        attempts.add(item.clientEventId)
        await delayedFailure(signal, 10_000)
      }
      return acknowledgement(item)
    })
    const queue = newQueue()
    if (mode === 'retry-all') vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    queue.setAuthenticatedUser('1')
    if (mode === 'retry-all') await queue.retryNow()
    await settle()
    await vi.advanceTimersByTimeAsync(30_000)
    const firstRound = mode === 'automatic' ? ['retry-b', 'retry-c', 'retry-a'] : ['retry-a', 'retry-b', 'retry-c']
    const sentIds = () => mocks.createReceipt.mock.calls.map(([item]) => item.clientEventId)
    expect(sentIds().slice(0, 3)).toEqual(firstRound)
    if (mode === 'retry-all') vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(sentIds()).toEqual([...firstRound, ...firstRound])
    expect(records.size).toBe(0)
  })

  it('automatically backs off and retries an API-classified proxy multipart 400', async () => {
    const item = queueItem()
    seed(item)
    mocks.createReceipt.mockRejectedValueOnce(new ApiError(400, '照片传输中断', {
      transportFailure: true, responseUncertain: true,
    }))
    const queue = newQueue()
    queue.setAuthenticatedUser('1')
    await settle()
    expect(records.get(item.clientEventId)).toMatchObject({ uploadState: 'FAILED', attempts: 1, nextAttemptAt: Date.now() + 2_000 })
    expect(records.get(item.clientEventId)?.photo).toBe(item.photo)
    expect(mocks.deleteUpload).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(mocks.createReceipt).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.createReceipt.mock.calls.map(([sent]) => sent.clientEventId)).toEqual([item.clientEventId, item.clientEventId])
    expect(records.size).toBe(0)
  })

  it('keeps JSON validation 400 paused instead of automatically retrying it', async () => {
    const item = queueItem()
    seed(item)
    mocks.createReceipt.mockRejectedValueOnce(new ApiError(400, 'invalid tracking number', { detail: 'invalid tracking number' }))
    const queue = newQueue()
    queue.setAuthenticatedUser('1')
    await settle()
    expect(records.get(item.clientEventId)).toMatchObject({
      uploadState: 'FAILED', attempts: 1, nextAttemptAt: Number.MAX_SAFE_INTEGER, lastError: 'invalid tracking number',
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.createReceipt).toHaveBeenCalledOnce()
    expect(mocks.deleteUpload).not.toHaveBeenCalled()
    expect(records.get(item.clientEventId)?.photo).toBe(item.photo)
  })

  it('does not automatically loop on permanent failure but allows explicit retry', async () => {
    const item = queueItem()
    seed(item)
    mocks.createReceipt.mockRejectedValueOnce(new ApiError(413, 'photo too large'))
    const queue = newQueue()
    queue.setAuthenticatedUser('1')
    await settle()
    expect(records.get(item.clientEventId)?.nextAttemptAt).toBe(Number.MAX_SAFE_INTEGER)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.createReceipt).toHaveBeenCalledOnce()
    await queue.retryNow(item.clientEventId)
    await settle()
    expect(mocks.createReceipt).toHaveBeenCalledTimes(2)
    expect(records.size).toBe(0)
  })

  it('uploads preserved evidence even when the barcode decoder unexpectedly rejects', async () => {
    const item = queueItem({ needsPreparation: true, readyToUpload: false, barcodeState: 'PROCESSING' })
    const compressed = new Blob(['compressed'], { type: 'image/jpeg' })
    seed(item)
    mocks.compressImage.mockResolvedValue({ blob: compressed })
    mocks.recognizeTrackingNo.mockRejectedValue(new Error('decoder crashed'))
    const queue = newQueue()
    queue.setAuthenticatedUser('1')
    await settle()
    expect(mocks.createReceipt).toHaveBeenCalledOnce()
    expect(mocks.createReceipt.mock.calls[0]?.[0]).toMatchObject({
      clientEventId: item.clientEventId, photo: compressed, readyToUpload: true, needsPreparation: false, barcodeState: 'NOT_FOUND',
    })
    expect(records.size).toBe(0)
  })

  it('falls back after stalled preparation and ignores late results after both photos sync', async () => {
    const item = queueItem({ needsPreparation: true, readyToUpload: false, barcodeState: 'PROCESSING' })
    const next = queueItem({ clientEventId: 'next-photo', createdAt: 2 })
    seed(item, next)
    const compression = deferred<{ blob: Blob }>()
    mocks.compressImage.mockReturnValueOnce(compression.promise)
    const queue = newQueue()
    queue.setAuthenticatedUser('1')
    await settle()
    expect(mocks.createReceipt).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(PHOTO_PREPARATION_TIMEOUT_MS)
    expect(mocks.createReceipt.mock.calls.map(([sent]) => sent.clientEventId)).toEqual([item.clientEventId, next.clientEventId])
    expect(mocks.createReceipt.mock.calls[0]?.[0].photo).toBe(item.photo)
    expect(records.size).toBe(0)
    const committedWrites = mocks.putUpload.mock.calls.length
    compression.resolve({ blob: new Blob(['late compressed']) })
    await settle()
    expect(records.size).toBe(0)
    expect(mocks.putUpload).toHaveBeenCalledTimes(committedWrites)
  })
})
