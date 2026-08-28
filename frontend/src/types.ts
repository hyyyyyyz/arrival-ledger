export interface User {
  id: string | number
  username: string
  display_name: string
  role?: 'ADMIN' | 'RECEIVER' | string
}

export interface AuthSession {
  user: User
  authRequired: boolean
}

export type EvidenceStatus = 'PENDING' | 'READY' | 'FAILED'
export type MatchStatus = 'MATCHED' | 'UNMATCHED'

export interface OrderMatchItem {
  title: string
  sku_text?: string | null
  quantity?: string | null
}

export interface OrderMatch {
  order_id?: string
  platform: 'pdd' | '1688' | string
  platform_order_id: string
  account_label?: string | null
  shop_name?: string | null
  courier?: string | null
  tracking_no?: string | null
  items?: OrderMatchItem[]
  confidence?: 'EXACT' | 'CANDIDATE' | string
}

export interface Receipt {
  id: string | number
  client_event_id?: string
  tracking_no?: string | null
  tracking_no_normalized?: string | null
  captured_at?: string
  occurred_at?: string
  first_received_at?: string
  server_received_at?: string
  created_at?: string
  evidence_status?: EvidenceStatus
  match_status?: MatchStatus
  photo_url?: string | null
  photo?: {
    url?: string | null
    size?: number | null
    sha256?: string | null
  } | null
  title_summary?: string | null
  platform?: string | null
  operator_display_name?: string | null
  operator?: { display_name?: string | null } | null
  is_duplicate?: boolean
  duplicate_of?: Receipt | null
  order_matches?: OrderMatch[]
}

export type BarcodeState = 'PROCESSING' | 'FOUND' | 'NOT_FOUND' | 'MANUAL'
export type UploadState = 'QUEUED' | 'UPLOADING' | 'FAILED'

export interface UploadQueueItem {
  clientEventId: string
  ownerUserId: string
  ownerDisplayName: string
  deviceId: string
  occurredAt: string
  photo: Blob
  fileName: string
  trackingNo: string | null
  barcodeState: BarcodeState
  uploadState: UploadState
  readyToUpload: boolean
  attempts: number
  nextAttemptAt: number
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export interface QueueStats {
  pending: number
  failed: number
  uploading: number
}

export interface DashboardStats {
  total_orders: number
  arrival_photos: number
  matched_orders: number
  pending_orders: number
  candidate_photos?: number
  unmatched_photos: number
  account_count: number
}

export type OrderPlatform = 'pdd' | '1688'
export type OrderPlatformFilter = '' | OrderPlatform

export interface PurchaseOrderItem {
  title: string
  sku_text: string | null
  quantity: string
  unit_price: string | null
}

export interface PurchaseOrderPackage {
  courier: string | null
  tracking_no: string
  package_status: string | null
  arrival_status: 'PENDING' | 'ARRIVED' | 'CANDIDATE'
  arrived: boolean
}

export interface PurchaseOrder {
  id: string
  platform: OrderPlatform
  account_label: string
  platform_order_id: string
  ordered_at: string | null
  order_status: string
  shop_name: string | null
  source: string
  items: PurchaseOrderItem[]
  packages: PurchaseOrderPackage[]
  package_count: number
  arrived_package_count: number
  arrival_photo_count: number
  candidate_package_count: number
  candidate_photo_count: number
}

export interface OrderListResponse {
  items: PurchaseOrder[]
  total: number
  limit: number
  offset: number
}

export interface OrderListParams {
  limit?: number
  offset?: number
  query?: string
  platform?: OrderPlatformFilter
}

export interface CompressedImage {
  blob: Blob
  width: number
  height: number
  originalBytes: number
  compressedBytes: number
}
