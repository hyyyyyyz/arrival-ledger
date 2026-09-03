export interface User {
  id: string | number
  username: string
  display_name: string
  role?: 'ADMIN' | 'RECEIVER' | string
  is_active?: boolean
  created_at?: string | null
  last_login_at?: string | null
}

export interface ManagedUser extends User {
  role: 'ADMIN' | 'RECEIVER'
  is_active: boolean
}

export interface CreateUserInput {
  username: string
  display_name: string
  password: string
  role: 'ADMIN' | 'RECEIVER'
}

export type PlatformAccountSyncStatus =
  | 'OK'
  | 'NEEDS_LOGIN'
  | 'CAPTCHA_OR_BLOCKED'
  | 'SCHEMA_CHANGED'
  | 'NETWORK_ERROR'
  | 'DISABLED'
  | 'NEVER_SYNCED'
  | string

export interface PlatformAccount {
  id: string | number
  platform: OrderPlatform
  account_key: string
  display_label: string | null
  source: string
  status: PlatformAccountSyncStatus | null
  last_attempt_at: string | null
  last_success_at: string | null
  last_count: number
  message: string | null
  order_count: number
}

export interface PlatformAccountListResponse {
  items: PlatformAccount[]
  total: number
}

export interface CreatePlatformAccountInput {
  platform: 'pdd'
  account_key: string
  display_label: string
}

export interface CreateManualOrderInput {
  client_event_id: string
  tracking_no: string
  product_name: string
  courier?: string
  remark?: string
}

export interface ManualOrderCreateResponse {
  created: boolean
  idempotent_replay: boolean
  order_id: string
  platform_order_id: string
  tracking_no: string
  product_name: string
  courier: string | null
  source: 'THIRD_PARTY_MANUAL'
}

export interface ManualOrderBatchRowInput {
  row_number: number
  tracking_no: string
  product_name?: string
  courier?: string
  remark?: string
}

export interface ManualOrderBatchCreateInput {
  client_batch_id: string
  tracking_text?: string
  product_name?: string
  courier?: string
  remark?: string
  rows?: ManualOrderBatchRowInput[]
}

export type ManualOrderBatchItemStatus = 'CREATED' | 'IDEMPOTENT' | 'DUPLICATE_INPUT' | 'FAILED'

export interface ManualOrderBatchResultItem {
  input_index: number
  status: ManualOrderBatchItemStatus
  tracking_no?: string | null
  tracking_no_normalized?: string | null
  row_number?: number | null
  created?: boolean
  idempotent_replay?: boolean
  order_id?: string | null
  platform_order_id?: string | null
  product_name?: string | null
  courier?: string | null
  error_code?: string | null
  message?: string | null
}

export interface ManualOrderBatchCreateResponse {
  client_batch_id: string
  idempotent_replay: boolean
  total_count: number
  unique_count: number
  created_count: number
  idempotent_count: number
  duplicate_count: number
  failed_count: number
  items: ManualOrderBatchResultItem[]
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
  platform: 'pdd' | '1688' | 'other' | string
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
  last_modified_at?: string | null
  last_modified_by?: { display_name?: string | null } | null
  is_duplicate?: boolean
  duplicate_of?: Receipt | null
  order_matches?: OrderMatch[]
}

export interface ReceiptTrackingUpdateInput {
  receiptId: string | number
  trackingNo: string
  expectedTrackingNo: string | null
  clientEventId: string
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
  inputMethod?: 'PHOTO_CAPTURE' | 'PHOTO_LIBRARY'
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
  received_orders?: number
  review_orders?: number
  pending_orders: number
  candidate_photos?: number
  unmatched_photos: number
  account_count: number
}

export type OrderPlatform = 'pdd' | '1688' | 'other'
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
  effective_arrival_status?: 'PENDING' | 'REVIEW' | 'RECEIVED' | 'CLOSED'
  evidence_arrival_status?: 'PENDING' | 'REVIEW' | 'RECEIVED'
  arrival_source?: 'AUTO' | 'MANUAL'
  responsible_user?: User | null
  manual_revision?: number
  changed_at?: string | null
  manual_created_by?: User | null
  manual_created_at?: string | null
  manual_remark?: string | null
}

export type ManualArrivalStatus = 'RECEIVED' | 'PENDING'

export interface ManualArrivalUpdate {
  order_id: string
  effective_arrival_status: 'PENDING' | 'REVIEW' | 'RECEIVED' | 'CLOSED'
  evidence_arrival_status: 'PENDING' | 'REVIEW' | 'RECEIVED'
  arrival_source: 'AUTO' | 'MANUAL'
  responsible_user: User | null
  manual_revision: number
  changed_at: string | null
  audit_event_id: string | number | null
  idempotent_replay: boolean
}

export interface OrderListResponse {
  items: PurchaseOrder[]
  account_options?: OrderAccountOption[]
  total: number
  limit: number
  offset: number
  last_synced_at?: string | null
}

export interface OrderAccountOption {
  id: string | number
  platform: OrderPlatform
  account_label: string
}

export interface OrderListParams {
  limit?: number
  offset?: number
  query?: string
  platform?: OrderPlatformFilter
  arrival_status?: OrderArrivalFilter
  account_id?: string | number
}

export type OrderArrivalFilter = '' | 'pending' | 'review' | 'received'

export interface CompressedImage {
  blob: Blob
  width: number
  height: number
  originalBytes: number
  compressedBytes: number
}
