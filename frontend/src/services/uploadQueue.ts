import type { QueueStats, Receipt, UploadQueueItem } from '@/types'
import { createReceipt, ApiError } from './api'
import { deleteUpload, getAllUploads, getUpload, putUpload } from './db'

const BASE_RETRY_MS = 2_000
const MAX_RETRY_MS = 60_000

function retryDelay(attempts: number): number {
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(attempts - 1, 5))
}

export class UploadQueue extends EventTarget {
  private currentUserId: string | null = null
  private processing = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private initialized = false

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true

    const items = await getAllUploads()
    await Promise.all(
      items
        .filter((item) => item.uploadState === 'UPLOADING')
        .map((item) => putUpload({ ...item, uploadState: 'QUEUED', updatedAt: Date.now() })),
    )
    window.addEventListener('online', () => void this.process())
    this.emitChange()
  }

  setAuthenticatedUser(userId: string | number | null): void {
    this.currentUserId = userId === null ? null : String(userId)
    if (this.currentUserId) void this.process()
    else this.clearTimer()
    this.emitChange()
  }

  async enqueue(item: UploadQueueItem): Promise<void> {
    await putUpload(item)
    this.emitChange()
  }

  async markReady(clientEventId: string, trackingNo: string | null): Promise<void> {
    const item = await getUpload(clientEventId)
    if (!item) return
    await putUpload({
      ...item,
      trackingNo,
      barcodeState: trackingNo ? 'FOUND' : 'NOT_FOUND',
      readyToUpload: true,
      uploadState: 'QUEUED',
      nextAttemptAt: 0,
      updatedAt: Date.now(),
    })
    this.emitChange()
    void this.process()
  }

  async updateTracking(clientEventId: string, trackingNo: string): Promise<void> {
    const item = await getUpload(clientEventId)
    if (!item) throw new Error('本机待上传记录不存在')
    await putUpload({
      ...item,
      trackingNo,
      barcodeState: 'MANUAL',
      readyToUpload: true,
      uploadState: 'QUEUED',
      nextAttemptAt: 0,
      lastError: null,
      updatedAt: Date.now(),
    })
    this.emitChange()
    void this.process()
  }

  async retryNow(clientEventId?: string): Promise<void> {
    const items = await getAllUploads()
    await Promise.all(
      items
        .filter((item) => !clientEventId || item.clientEventId === clientEventId)
        .map((item) =>
          putUpload({
            ...item,
            uploadState: 'QUEUED',
            nextAttemptAt: 0,
            lastError: null,
            updatedAt: Date.now(),
          }),
        ),
    )
    this.emitChange()
    void this.process()
  }

  async itemsForCurrentUser(): Promise<UploadQueueItem[]> {
    if (!this.currentUserId) return []
    const items = await getAllUploads()
    return items
      .filter((item) => item.ownerUserId === this.currentUserId)
      .sort((left, right) => right.createdAt - left.createdAt)
  }

  async stats(): Promise<QueueStats> {
    const items = await this.itemsForCurrentUser()
    return {
      pending: items.filter((item) => item.uploadState === 'QUEUED').length,
      failed: items.filter((item) => item.uploadState === 'FAILED').length,
      uploading: items.filter((item) => item.uploadState === 'UPLOADING').length,
    }
  }

  async process(): Promise<void> {
    if (this.processing || !this.currentUserId || !navigator.onLine) return
    this.processing = true
    this.clearTimer()

    try {
      while (this.currentUserId && navigator.onLine) {
        const now = Date.now()
        const allItems = await this.itemsForCurrentUser()
        const eligible = allItems
          .filter((item) => item.readyToUpload && item.nextAttemptAt <= now)
          .sort((left, right) => left.createdAt - right.createdAt)
        const item = eligible[0]
        if (!item) {
          this.scheduleNext(allItems)
          break
        }

        const uploading: UploadQueueItem = {
          ...item,
          uploadState: 'UPLOADING',
          updatedAt: Date.now(),
        }
        await putUpload(uploading)
        this.emitChange()

        try {
          const receipt = await createReceipt(uploading)
          await deleteUpload(uploading.clientEventId)
          this.dispatchEvent(new CustomEvent<Receipt>('synced', { detail: receipt }))
        } catch (error) {
          const attempts = uploading.attempts + 1
          const message = error instanceof Error ? error.message : '上传失败，稍后自动重试'
          await putUpload({
            ...uploading,
            attempts,
            uploadState: 'FAILED',
            nextAttemptAt: Date.now() + retryDelay(attempts),
            lastError: message,
            updatedAt: Date.now(),
          })
          if (error instanceof ApiError && error.status === 401) {
            this.dispatchEvent(new Event('auth-required'))
            break
          }
        }
        this.emitChange()
      }
    } finally {
      this.processing = false
      this.emitChange()
    }
  }

  private scheduleNext(items: UploadQueueItem[]): void {
    const nextAt = items
      .filter((item) => item.readyToUpload && item.nextAttemptAt > Date.now())
      .reduce((minimum, item) => Math.min(minimum, item.nextAttemptAt), Number.POSITIVE_INFINITY)
    if (!Number.isFinite(nextAt)) return
    const delay = Math.max(250, Math.min(MAX_RETRY_MS, nextAt - Date.now()))
    this.retryTimer = setTimeout(() => void this.process(), delay)
  }

  private clearTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private emitChange(): void {
    this.dispatchEvent(new Event('change'))
  }
}

export const uploadQueue = new UploadQueue()
