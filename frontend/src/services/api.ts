import type {
  AuthSession,
  CreateUserInput,
  DashboardStats,
  ManagedUser,
  ManualArrivalUpdate,
  ManualArrivalStatus,
  OrderListParams,
  OrderListResponse,
  CreatePlatformAccountInput,
  CreateManualOrderInput,
  ManualOrderBatchCreateInput,
  ManualOrderBatchCreateResponse,
  ManualOrderCreateResponse,
  PlatformAccount,
  PlatformAccountListResponse,
  Receipt,
  UploadQueueItem,
  User,
} from '@/types'

const API_BASE = (import.meta.env.VITE_API_BASE || '/api').replace(/\/$/, '')
export const API_REQUEST_TIMEOUT_MS = 30_000
export const RECEIPT_UPLOAD_TIMEOUT_MS = 60_000
export const RECEIPT_PHOTO_READ_TIMEOUT_MS = 15_000

export class ApiError extends Error {
  readonly status: number
  readonly details: unknown

  constructor(status: number, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.details = details
  }
}

function errorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === 'string' && payload.trim()) return payload
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    for (const key of ['detail', 'message', 'error']) {
      if (typeof record[key] === 'string' && record[key]) return record[key]
    }
  }
  return fallback
}

async function parseResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return null
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) return response.json()
  return response.text()
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = API_REQUEST_TIMEOUT_MS,
  prepareBody?: (signal: AbortSignal) => Promise<BodyInit>,
): Promise<T> {
  const controller = new AbortController()
  const externalSignal = init.signal
  let interrupt!: (error: ApiError) => void
  const interrupted = new Promise<never>((_, reject) => { interrupt = reject })
  const cancel = (): void => {
    interrupt(new ApiError(0, '请求已取消，服务器结果尚未确认', { cancelled: true, responseUncertain: true }))
    controller.abort()
  }
  const timeout = setTimeout(() => {
    interrupt(new ApiError(408, '请求超时，服务器结果尚未确认，请重试', { timeout: true, responseUncertain: true }))
    controller.abort()
  }, timeoutMs)

  try {
    externalSignal?.addEventListener('abort', cancel, { once: true })
    if (externalSignal?.aborted) {
      cancel()
      return await interrupted
    }

    const operation = (async (): Promise<T> => {
      try {
        const body = prepareBody ? await prepareBody(controller.signal) : init.body
        if (controller.signal.aborted) return await interrupted
        const response = await fetch(`${API_BASE}${path}`, {
          ...init,
          body,
          signal: controller.signal,
          credentials: 'include',
          cache: 'no-store',
          headers: {
            Accept: 'application/json',
            'X-Arrival-Client': 'wechat-h5',
            ...init.headers,
          },
        })
        const payload = await parseResponse(response)
        if (!response.ok) {
          // Nginx may reject an interrupted multipart body before the app is
          // reached. Do not confuse its empty/HTML 400 with a JSON validation
          // failure; only the former is safe for automatic transport retries.
          if (path === '/receipts' && response.status === 400 && typeof payload === 'string'
            && (!payload.trim() || /^\s*(?:<!doctype html|<html)/i.test(payload))) {
            throw new ApiError(400, '照片传输中断，将自动重试；本机照片仍保留', { transportFailure: true, responseUncertain: true })
          }
          throw new ApiError(response.status, errorMessage(payload, `请求失败（${response.status}）`), payload)
        }
        return payload as T
      } catch (error) {
        if (error instanceof ApiError) throw error
        throw new ApiError(0, '网络连接或服务器响应中断，结果尚未确认，请重试', { responseUncertain: true })
      }
    })()
    // Abort is best-effort in embedded browsers. The race also bounds body parsing
    // and settles the caller if fetch/body consumption ignores the abort signal.
    return await Promise.race([operation, interrupted])
  } finally {
    clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', cancel)
  }
}

type AuthPayload = User | { user: User; auth_required?: boolean }

function unwrapSession(payload: AuthPayload): AuthSession {
  if ('user' in payload) {
    return {
      user: payload.user,
      authRequired: payload.auth_required !== false,
    }
  }
  return { user: payload, authRequired: true }
}

function unwrapReceipt(payload: Receipt | { receipt: Receipt }): Receipt {
  return 'receipt' in payload ? payload.receipt : payload
}

function unwrapUser(payload: ManagedUser | { user: ManagedUser }): ManagedUser {
  return 'user' in payload ? payload.user : payload
}

function unwrapPlatformAccount(payload: PlatformAccount | { account: PlatformAccount }): PlatformAccount {
  return 'account' in payload ? payload.account : payload
}

export async function login(username: string, password: string): Promise<AuthSession> {
  const payload = await request<AuthPayload>('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  return unwrapSession(payload)
}

export async function getCurrentSession(): Promise<AuthSession> {
  const payload = await request<AuthPayload>('/auth/me')
  return unwrapSession(payload)
}

export async function logout(): Promise<void> {
  await request('/auth/logout', { method: 'POST' })
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await request('/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  })
}

export async function listReceipts(limit = 50): Promise<Receipt[]> {
  const payload = await request<Receipt[] | { items: Receipt[] }>(`/receipts?limit=${limit}`)
  return Array.isArray(payload) ? payload : payload.items
}

export async function getDashboardStats(): Promise<DashboardStats> {
  return request<DashboardStats>('/dashboard/stats')
}

export async function listOrders(params: OrderListParams = {}): Promise<OrderListResponse> {
  const search = new URLSearchParams({
    limit: String(params.limit ?? 20),
    offset: String(params.offset ?? 0),
  })
  const query = params.query?.trim()
  if (query) search.set('query', query)
  if (params.platform) search.set('platform', params.platform)
  if (params.arrival_status) search.set('arrival_status', params.arrival_status)
  if (params.account_id !== undefined && String(params.account_id)) search.set('account_id', String(params.account_id))
  return request<OrderListResponse>(`/orders?${search.toString()}`)
}

export async function updateOrderArrivalStatus(
  orderId: string,
  status: ManualArrivalStatus,
  expectedRevision: number,
  clientEventId: string,
): Promise<ManualArrivalUpdate> {
  return request<ManualArrivalUpdate>(
    `/orders/${encodeURIComponent(orderId)}/arrival-status`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status,
        expected_revision: expectedRevision,
        client_event_id: clientEventId,
      }),
    },
  )
}

export async function listUsers(): Promise<ManagedUser[]> {
  const payload = await request<ManagedUser[] | { items: ManagedUser[] }>('/users')
  return Array.isArray(payload) ? payload : payload.items
}

export async function createUser(input: CreateUserInput): Promise<ManagedUser> {
  const payload = await request<ManagedUser | { user: ManagedUser }>('/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return unwrapUser(payload)
}

export async function setUserActive(userId: string | number, isActive: boolean): Promise<ManagedUser> {
  const payload = await request<ManagedUser | { user: ManagedUser }>(
    `/users/${encodeURIComponent(String(userId))}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: isActive }),
    },
  )
  return unwrapUser(payload)
}

export async function listPlatformAccounts(platform: 'pdd' | '1688' = 'pdd'): Promise<PlatformAccountListResponse> {
  const search = new URLSearchParams({ platform })
  return request<PlatformAccountListResponse>(`/platform-accounts?${search.toString()}`)
}

export async function createPlatformAccount(input: CreatePlatformAccountInput): Promise<PlatformAccount> {
  const payload = await request<PlatformAccount | { account: PlatformAccount }>('/platform-accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return unwrapPlatformAccount(payload)
}

export async function createManualOrder(input: CreateManualOrderInput): Promise<ManualOrderCreateResponse> {
  return request<ManualOrderCreateResponse>('/manual-orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export async function createManualOrderBatch(input: ManualOrderBatchCreateInput): Promise<ManualOrderBatchCreateResponse> {
  return request<ManualOrderBatchCreateResponse>('/manual-orders/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

async function receiptBody(item: UploadQueueItem, signal: AbortSignal): Promise<FormData> {
  let interrupt!: (error: ApiError) => void
  const interrupted = new Promise<never>((_, reject) => { interrupt = reject })
  const cancel = (): void => interrupt(new ApiError(0, '照片读取已取消', { cancelled: true, localPhotoRead: true }))
  const timeout = setTimeout(() => {
    interrupt(new ApiError(0, '本机照片读取超时，请保留照片并重试', { localPhotoRead: true, timeout: true }))
  }, RECEIPT_PHOTO_READ_TIMEOUT_MS)
  try {
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) {
      cancel()
      return await interrupted
    }
    // Materialize IndexedDB-backed Blob bytes before multipart encoding. Wrapping
    // the stored Blob itself can retain its disk backing in embedded WebKit.
    const bytes = await Promise.race([item.photo.arrayBuffer(), interrupted])
    if (bytes.byteLength === 0 || bytes.byteLength !== item.photo.size) {
      throw new ApiError(0, '本机照片内容不完整，请保留照片并重试', { localPhotoRead: true })
    }
    const body = new FormData()
    body.append('client_event_id', item.clientEventId)
    body.append('captured_at', item.occurredAt)
    body.append('input_method', item.inputMethod || 'PHOTO_CAPTURE')
    body.append('device_id', item.deviceId)
    if (item.trackingNo) body.append('tracking_no', item.trackingNo)
    body.append('photo', new Blob([bytes], { type: item.photo.type }), item.fileName)
    return body
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(0, '无法读取本机照片，请保留照片并重试', { localPhotoRead: true })
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', cancel)
  }
}

export async function createReceipt(item: UploadQueueItem, signal?: AbortSignal): Promise<Receipt> {
  const payload = await request<unknown>('/receipts', {
    method: 'POST',
    signal,
  }, RECEIPT_UPLOAD_TIMEOUT_MS, (requestSignal) => receiptBody(item, requestSignal))
  const receipt = payload && typeof payload === 'object' && 'receipt' in payload ? payload.receipt : payload
  if (receipt && typeof receipt === 'object' && 'id' in receipt && 'client_event_id' in receipt) {
    const validId = (typeof receipt.id === 'string' && receipt.id.trim().length > 0) ||
      (typeof receipt.id === 'number' && Number.isSafeInteger(receipt.id) && receipt.id > 0)
    if (validId && receipt.client_event_id === item.clientEventId) return receipt as Receipt
  }
  // A 2xx status alone must not authorize deleting durable photo evidence.
  throw new ApiError(0, '服务器收货确认无效，结果尚未确认，请重试', {
    invalidReceiptConfirmation: true, responseUncertain: true,
  })
}

export async function updateReceiptTracking(
  receiptId: string | number,
  trackingNo: string,
  expectedTrackingNo: string | null,
  clientEventId: string,
): Promise<Receipt> {
  const payload = await request<Receipt | { receipt: Receipt }>(`/receipts/${receiptId}/tracking`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tracking_no: trackingNo,
      expected_tracking_no: expectedTrackingNo,
      client_event_id: clientEventId,
    }),
  })
  return unwrapReceipt(payload)
}

export function receiptPhotoUrl(receipt: Receipt): string {
  const declaredUrl = receipt.photo?.url || receipt.photo_url
  if (declaredUrl) {
    if (/^https?:\/\//.test(declaredUrl)) return declaredUrl
    if (declaredUrl.startsWith('/api/')) return declaredUrl
    if (declaredUrl.startsWith('/')) return `${API_BASE}${declaredUrl}`
  }
  return `${API_BASE}/receipts/${receipt.id}/photo`
}
