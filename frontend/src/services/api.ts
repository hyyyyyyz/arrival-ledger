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
  PlatformAccount,
  PlatformAccountListResponse,
  Receipt,
  UploadQueueItem,
  User,
} from '@/types'

const API_BASE = (import.meta.env.VITE_API_BASE || '/api').replace(/\/$/, '')

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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'X-Arrival-Client': 'wechat-h5',
        ...init.headers,
      },
    })
  } catch {
    throw new ApiError(0, '网络不可用，已保留在本机等待重试')
  }

  const payload = await parseResponse(response)
  if (!response.ok) {
    throw new ApiError(response.status, errorMessage(payload, `请求失败（${response.status}）`), payload)
  }
  return payload as T
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

export async function listPlatformAccounts(platform: 'pdd' = 'pdd'): Promise<PlatformAccountListResponse> {
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

export async function createReceipt(item: UploadQueueItem): Promise<Receipt> {
  const body = new FormData()
  body.append('client_event_id', item.clientEventId)
  body.append('captured_at', item.occurredAt)
  body.append('input_method', 'PHOTO_CAPTURE')
  body.append('device_id', item.deviceId)
  if (item.trackingNo) body.append('tracking_no', item.trackingNo)
  body.append('photo', item.photo, item.fileName)

  const payload = await request<Receipt | { receipt: Receipt }>('/receipts', {
    method: 'POST',
    body,
  })
  return unwrapReceipt(payload)
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
