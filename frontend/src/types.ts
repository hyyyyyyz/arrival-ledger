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

export interface CompressedImage {
  blob: Blob
  width: number
  height: number
  originalBytes: number
  compressedBytes: number
}
