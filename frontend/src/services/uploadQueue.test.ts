// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { UploadQueueItem } from '@/types'
import { ApiError } from './api'
import { isRetryableUploadError, UploadQueue } from './uploadQueue'

const mocks = vi.hoisted(() => ({
  createReceipt: vi.fn(),
  deleteUpload: vi.fn(),
  getAllUploads: vi.fn(),
  getUpload: vi.fn(),
  putUpload: vi.fn(),
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
    barcodeState: 'PROCESSING',
    uploadState: 'QUEUED',
    readyToUpload: false,
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    inputMethod: 'PHOTO_LIBRARY',
    ...overrides,
  }
}

describe('UploadQueue recovery and retry policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.putUpload.mockResolvedValue(undefined)
  })

  it('recovers a gallery photo interrupted between persistence and recognition', async () => {
    mocks.getAllUploads.mockResolvedValue([queueItem()])

    const queue = new UploadQueue()
    await queue.initialize()

    expect(mocks.putUpload).toHaveBeenCalledOnce()
    expect(mocks.putUpload).toHaveBeenCalledWith(expect.objectContaining({
      clientEventId: 'gallery-client-event-0001',
      barcodeState: 'NOT_FOUND',
      uploadState: 'QUEUED',
      readyToUpload: true,
      nextAttemptAt: 0,
      inputMethod: 'PHOTO_LIBRARY',
    }))
  })

  it('replaces a safely staged original without changing its idempotency key', async () => {
    const original = queueItem()
    const compressed = new Blob(['compressed'], { type: 'image/jpeg' })
    mocks.getUpload.mockResolvedValue(original)

    const queue = new UploadQueue()
    await queue.replacePreparedPhoto(original.clientEventId, compressed, 'compressed.jpg')

    expect(mocks.putUpload).toHaveBeenCalledWith(expect.objectContaining({
      clientEventId: original.clientEventId,
      photo: compressed,
      fileName: 'compressed.jpg',
      readyToUpload: false,
      inputMethod: 'PHOTO_LIBRARY',
    }))
  })

  it('automatically retries only transient transport and server failures', () => {
    expect(isRetryableUploadError(new Error('offline'))).toBe(true)
    for (const status of [0, 408, 429, 500, 503]) {
      expect(isRetryableUploadError(new ApiError(status, 'transient'))).toBe(true)
    }
    for (const status of [400, 401, 403, 409, 413, 415, 422]) {
      expect(isRetryableUploadError(new ApiError(status, 'permanent'))).toBe(false)
    }
  })
})
