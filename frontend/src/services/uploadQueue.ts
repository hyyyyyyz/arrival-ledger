import type { QueueStats, Receipt, UploadQueueItem } from '@/types'
import { createReceipt, ApiError, RECEIPT_UPLOAD_TIMEOUT_MS } from './api'
import { deleteUpload, getAllUploads, getUpload, putUpload } from './db'
import { preparePhoto } from './preparePhoto'

const BASE_RETRY_MS = 2_000
const MAX_RETRY_MS = 60_000
function retryDelay(attempts: number): number {
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(attempts - 1, 5))
}
export function isRetryableUploadError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true
  if (error.status === 400 && error.details && typeof error.details === 'object'
    && 'transportFailure' in error.details && error.details.transportFailure === true) return true
  return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500
}

export class UploadQueue extends EventTarget {
  private currentUserId: string | null = null
  private epoch = 0
  private running: Promise<void> | null = null
  private runAgain = false
  private forceNextRun = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private initialization: Promise<void> | null = null
  private active: { id: string; controller: AbortController; startedAt: number } | null = null

  private readonly resumeUpload = (): void => {
    if (document.visibilityState === 'hidden') return
    // Timers may not fire while Safari is suspended. Check wall-clock age too.
    if (this.active && Date.now() - this.active.startedAt > RECEIPT_UPLOAD_TIMEOUT_MS) this.active.controller.abort()
    void this.process()
  }

  initialize(): Promise<void> {
    if (this.initialization) return this.initialization
    this.initialization = this.restore().catch((error) => { this.initialization = null; throw error })
    return this.initialization
  }

  private async restore(): Promise<void> {
    const items = await getAllUploads()
    for (const item of items) {
      if (item.uploadState !== 'UPLOADING' && (item.readyToUpload || item.needsPreparation)) continue
      await putUpload({ ...item, uploadState: 'QUEUED', nextAttemptAt: 0,
        needsPreparation: item.needsPreparation || !item.readyToUpload,
        lastError: null, updatedAt: Date.now() })
    }
    window.addEventListener('online', this.resumeUpload)
    window.addEventListener('focus', this.resumeUpload)
    window.addEventListener('pageshow', this.resumeUpload)
    document.addEventListener('visibilitychange', this.resumeUpload)
    this.emitChange()
  }

  dispose(): void {
    this.currentUserId = null
    this.epoch += 1
    this.active?.controller.abort()
    this.clearTimer()
    window.removeEventListener('online', this.resumeUpload)
    window.removeEventListener('focus', this.resumeUpload)
    window.removeEventListener('pageshow', this.resumeUpload)
    document.removeEventListener('visibilitychange', this.resumeUpload)
  }

  setAuthenticatedUser(userId: string | number | null): void {
    this.epoch += 1
    this.active?.controller.abort()
    this.currentUserId = userId === null ? null : String(userId)
    if (this.currentUserId) void this.process()
    else this.clearTimer()
    this.emitChange()
  }

  async enqueue(item: UploadQueueItem): Promise<void> {
    await putUpload(item)
    this.emitChange()
    if (item.readyToUpload || item.needsPreparation) void this.process()
  }

  async markReady(clientEventId: string, trackingNo: string | null): Promise<void> {
    const item = await getUpload(clientEventId)
    if (!item) return
    await putUpload({ ...item, trackingNo, barcodeState: trackingNo ? 'FOUND' : 'NOT_FOUND',
      needsPreparation: false, readyToUpload: true, uploadState: 'QUEUED', nextAttemptAt: 0, updatedAt: Date.now() })
    this.emitChange()
    void this.process()
  }

  async replacePreparedPhoto(clientEventId: string, photo: Blob, fileName: string): Promise<void> {
    const item = await getUpload(clientEventId)
    if (!item) throw new Error('本机待上传照片不存在')
    await putUpload({ ...item, photo, fileName, updatedAt: Date.now() })
    this.emitChange()
  }

  async updateTracking(clientEventId: string, trackingNo: string): Promise<void> {
    const owner = this.currentUserId
    const item = await getUpload(clientEventId)
    if (!item || !owner || item.ownerUserId !== owner || owner !== this.currentUserId) throw new Error('本机待上传记录不存在')
    if (this.active?.id === clientEventId) throw new Error('这张照片正在处理或上传，请同步完成后在记录中修正单号')
    await putUpload({ ...item, trackingNo, barcodeState: 'MANUAL', readyToUpload: true,
      uploadState: 'QUEUED', nextAttemptAt: 0, lastError: null, updatedAt: Date.now() })
    this.emitChange()
    void this.process()
  }

  async retryNow(clientEventId?: string): Promise<void> {
    const owner = this.currentUserId
    const epoch = this.epoch
    if (!owner) return
    if (this.active && (!clientEventId || this.active.id === clientEventId)) {
      this.active.controller.abort()
      await this.running
    }
    const items = await getAllUploads()
    for (const item of items) {
      if (epoch !== this.epoch) return
      if (item.ownerUserId !== owner || (clientEventId && item.clientEventId !== clientEventId)) continue
      if (this.active?.id === item.clientEventId) continue
      await putUpload({ ...item, uploadState: 'QUEUED', nextAttemptAt: 0, requiresAuth: false,
        lastError: null, updatedAt: Date.now() })
    }
    this.emitChange()
    void this.process(true)
  }

  async itemsForCurrentUser(): Promise<UploadQueueItem[]> {
    const owner = this.currentUserId
    if (!owner) return []
    const items = await getAllUploads()
    if (owner !== this.currentUserId) return []
    return items.filter((item) => item.ownerUserId === owner).sort((a, b) => b.createdAt - a.createdAt)
  }

  async stats(): Promise<QueueStats> {
    const items = await this.itemsForCurrentUser()
    return { pending: items.filter((i) => i.uploadState === 'QUEUED').length,
      failed: items.filter((i) => i.uploadState === 'FAILED').length,
      uploading: items.filter((i) => i.uploadState === 'UPLOADING').length }
  }

  process(forceOnline = false): Promise<void> {
    if (this.running) { this.runAgain = true; this.forceNextRun ||= forceOnline; return this.running }
    forceOnline ||= this.forceNextRun
    this.forceNextRun = false
    if (!this.currentUserId || (!navigator.onLine && !forceOnline)) return Promise.resolve()
    this.clearTimer()
    this.runAgain = false
    this.running = this.drain(forceOnline).catch((error) => {
      this.dispatchEvent(new CustomEvent('queue-error', { detail: error instanceof Error ? error.message : '读取本机照片失败，正在重试' }))
      this.schedule(BASE_RETRY_MS)
    }).finally(() => {
      this.running = null
      this.active = null
      this.emitChange()
      if (this.runAgain && this.currentUserId) this.schedule(0)
    })
    return this.running
  }

  private async drain(forceOnline: boolean): Promise<void> {
    const owner = this.currentUserId
    const epoch = this.epoch
    const stillCurrent = () => this.currentUserId === owner && this.epoch === epoch
    while (stillCurrent() && (navigator.onLine || forceOnline)) {
      const items = await this.itemsForCurrentUser()
      if (!stillCurrent()) return
      const eligible = items.filter((i) => (i.readyToUpload || i.needsPreparation) &&
        (i.nextAttemptAt <= Date.now() || i.requiresAuth))
        // Untouched photos (nextAttemptAt=0) take their first turn before an
        // old slow failure. Otherwise two minute-long failures can alternate
        // forever and starve every later photo once their backoff has elapsed.
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt)
      let item = eligible[0]
      if (!item) {
        const next = items.filter((i) => (i.readyToUpload || i.needsPreparation) && i.nextAttemptAt < Number.MAX_SAFE_INTEGER)
          .reduce((min, i) => Math.min(min, i.nextAttemptAt), Infinity)
        if (Number.isFinite(next)) this.schedule(Math.max(250, next - Date.now()))
        return
      }
      const controller = new AbortController()
      this.active = { id: item.clientEventId, controller, startedAt: Date.now() }
      try {
        if (item.needsPreparation) {
          item = await preparePhoto(item)
          if (!stillCurrent() || controller.signal.aborted) return
          await putUpload(item)
        }
        if (!stillCurrent() || controller.signal.aborted) return
        item = { ...item, uploadState: 'UPLOADING', requiresAuth: false, lastError: null, updatedAt: Date.now() }
        await putUpload(item)
        if (!stillCurrent() || controller.signal.aborted) return
        this.active.startedAt = Date.now()
        this.emitChange()
        const receipt = await createReceipt(item, controller.signal)
        // Only a definite acknowledgement removes the durable local copy.
        await deleteUpload(item.clientEventId)
        if (stillCurrent()) this.dispatchEvent(new CustomEvent<Receipt>('synced', { detail: receipt }))
      } catch (error) {
        const cancelled = controller.signal.aborted
        const requiresAuth = error instanceof ApiError && error.status === 401
        const retryable = cancelled || isRetryableUploadError(error)
        const attempts = item.attempts + (cancelled ? 0 : 1)
        await putUpload({ ...item, attempts, requiresAuth, uploadState: cancelled ? 'QUEUED' : 'FAILED',
          nextAttemptAt: cancelled ? 0 : retryable ? Date.now() + retryDelay(attempts) : Number.MAX_SAFE_INTEGER,
          lastError: cancelled ? '上传尚未确认，照片保留在本机，将继续同步' : error instanceof Error ? error.message : '上传失败，将自动重试',
          updatedAt: Date.now() })
        if (requiresAuth && stillCurrent()) {
          this.setAuthenticatedUser(null)
          this.dispatchEvent(new Event('auth-required'))
        }
        if (cancelled || requiresAuth) return
      } finally { this.active = null; this.emitChange() }
    }
  }

  private schedule(delay: number): void {
    this.clearTimer()
    if (this.currentUserId) this.retryTimer = setTimeout(() => void this.process(), Math.min(MAX_RETRY_MS, delay))
  }
  private clearTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }
  private emitChange(): void { this.dispatchEvent(new Event('change')) }
}
export const uploadQueue = new UploadQueue()
