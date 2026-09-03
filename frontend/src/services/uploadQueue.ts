import type { QueueStats, Receipt, UploadQueueItem } from '@/types'
import { createReceipt, ApiError } from './api'
import { deleteUpload, getAllUploads, getUpload, putUpload } from './db'

const BASE_RETRY_MS = 2_000
const MAX_RETRY_MS = 60_000

function retryDelay(attempts: number): number {
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(attempts - 1, 5))
}

export function isRetryableUploadError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true
  return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500
}

export class UploadQueue extends EventTarget {
  private currentUserId: string | null = null
  private processing = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private initialized = false

  // Mobile browsers pause timers and JavaScript while the tab is backgrounded.
  // Re-run the queue when the user returns so a recovered local item does not
  // remain in QUEUED state until another unrelated event happens.
  private readonly resumeUpload = (): void => {
    if (document.visibilityState === 'hidden') return
    void this.process()
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true

    const items = await getAllUploads()
    await Promise.all(items.flatMap((item) => {
      const uploadWasInterrupted = item.uploadState === 'UPLOADING'
      const recognitionWasInterrupted = item.barcodeState === 'PROCESSING' && !item.readyToUpload
      if (!uploadWasInterrupted && !recognitionWasInterrupted) return []
      return [putUpload({
        ...item,
        barcodeState: recognitionWasInterrupted ? 'NOT_FOUND' : item.barcodeState,
        readyToUpload: recognitionWasInterrupted ? true : item.readyToUpload,
        uploadState: 'QUEUED',
        nextAttemptAt: 0,
        lastError: recognitionWasInterrupted
          ? '照片处理曾意外中断，已保留原图并继续上传；单号可稍后补录'
          : item.lastError,
        updatedAt: Date.now(),
      })]
    }))
    window.addEventListener('online', () => void this.process())
    window.addEventListener('focus', this.resumeUpload)
    document.addEventListener('visibilitychange', this.resumeUpload)
    window.addEventListener('pageshow', this.resumeUpload)
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

  async replacePreparedPhoto(clientEventId: string, photo: Blob, fileName: string): Promise<void> {
    const item = await getUpload(clientEventId)
    if (!item) throw new Error('本机待上传照片不存在')
    await putUpload({
      ...item,
      photo,
      fileName,
      updatedAt: Date.now(),
    })
    this.emitChange()
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
          const retryable = isRetryableUploadError(error)
          await putUpload({
            ...uploading,
            attempts,
            uploadState: 'FAILED',
            nextAttemptAt: retryable ? Date.now() + retryDelay(attempts) : Number.MAX_SAFE_INTEGER,
            lastError: retryable ? message : `需要人工处理：${message}`,
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
      .filter((item) => item.readyToUpload
        && item.nextAttemptAt > Date.now()
        && item.nextAttemptAt < Number.MAX_SAFE_INTEGER)
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
