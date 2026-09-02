import type { UploadQueueItem } from '@/types'
import type { ManualImportDefaults, ManualImportPreviewRow } from '@/utils/manualOrderImport'

const DATABASE_NAME = 'arrival-manager'
const DATABASE_VERSION = 2
const UPLOAD_STORE = 'upload-queue'
const MANUAL_ORDER_DRAFT_STORE = 'manual-order-drafts'

export interface ManualOrderDraft {
  ownerUserId: string
  bulkText: string
  defaults: Required<ManualImportDefaults>
  rows: ManualImportPreviewRow[]
  sourceLabel: string
  batchId: string
  payloadKey: string
  submitted?: boolean
  updatedAt: number
}

let databasePromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise

  let settled = false
  const openingPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      if (databasePromise === openingPromise) databasePromise = null
      try { request.transaction?.abort() } catch { /* The open request may not have an upgrade transaction yet. */ }
      reject(error)
    }
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(UPLOAD_STORE)) {
        const store = database.createObjectStore(UPLOAD_STORE, { keyPath: 'clientEventId' })
        store.createIndex('ownerUserId', 'ownerUserId', { unique: false })
        store.createIndex('createdAt', 'createdAt', { unique: false })
      }
      if (!database.objectStoreNames.contains(MANUAL_ORDER_DRAFT_STORE)) {
        database.createObjectStore(MANUAL_ORDER_DRAFT_STORE, { keyPath: 'ownerUserId' })
      }
    }
    request.onsuccess = () => {
      if (settled) {
        request.result.close()
        return
      }
      settled = true
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
    request.onerror = () => fail(request.error ?? new Error('无法打开本地存储'))
    request.onblocked = () => fail(new Error('本地存储正被旧页面占用，请关闭其他页面后重试'))
  })
  databasePromise = openingPromise
  // Also recover if indexedDB.open itself throws synchronously inside the Promise executor.
  void openingPromise.catch(() => {
    if (databasePromise === openingPromise) databasePromise = null
  })

  return databasePromise
}

function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('本地存储失败'))
    transaction.onabort = () => reject(transaction.error ?? new Error('本地存储已取消'))
  })
}

export async function putUpload(item: UploadQueueItem): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(UPLOAD_STORE, 'readwrite')
  transaction.objectStore(UPLOAD_STORE).put(item)
  await complete(transaction)
}

export async function deleteUpload(clientEventId: string): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(UPLOAD_STORE, 'readwrite')
  transaction.objectStore(UPLOAD_STORE).delete(clientEventId)
  await complete(transaction)
}

export async function getUpload(clientEventId: string): Promise<UploadQueueItem | null> {
  const database = await openDatabase()
  const transaction = database.transaction(UPLOAD_STORE, 'readonly')
  const request = transaction.objectStore(UPLOAD_STORE).get(clientEventId)
  const result = await new Promise<UploadQueueItem | undefined>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as UploadQueueItem | undefined)
    request.onerror = () => reject(request.error ?? new Error('读取本地记录失败'))
  })
  await complete(transaction)
  return result ?? null
}

export async function getAllUploads(): Promise<UploadQueueItem[]> {
  const database = await openDatabase()
  const transaction = database.transaction(UPLOAD_STORE, 'readonly')
  const request = transaction.objectStore(UPLOAD_STORE).getAll()
  const result = await new Promise<UploadQueueItem[]>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as UploadQueueItem[])
    request.onerror = () => reject(request.error ?? new Error('读取本地队列失败'))
  })
  await complete(transaction)
  return result
}

export async function putManualOrderDraft(draft: ManualOrderDraft): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(MANUAL_ORDER_DRAFT_STORE, 'readwrite')
  transaction.objectStore(MANUAL_ORDER_DRAFT_STORE).put(draft)
  await complete(transaction)
}

export async function getManualOrderDraft(ownerUserId: string): Promise<ManualOrderDraft | null> {
  const database = await openDatabase()
  const transaction = database.transaction(MANUAL_ORDER_DRAFT_STORE, 'readonly')
  const request = transaction.objectStore(MANUAL_ORDER_DRAFT_STORE).get(ownerUserId)
  const result = await new Promise<ManualOrderDraft | undefined>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as ManualOrderDraft | undefined)
    request.onerror = () => reject(request.error ?? new Error('读取批量导入草稿失败'))
  })
  await complete(transaction)
  return result ?? null
}

export async function deleteManualOrderDraft(ownerUserId: string): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(MANUAL_ORDER_DRAFT_STORE, 'readwrite')
  transaction.objectStore(MANUAL_ORDER_DRAFT_STORE).delete(ownerUserId)
  await complete(transaction)
}
