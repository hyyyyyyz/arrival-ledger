import type { UploadQueueItem } from '@/types'
import type { ManualImportDefaults, ManualImportPreviewRow } from '@/utils/manualOrderImport'

const DATABASE_NAME = 'arrival-manager'
const DATABASE_VERSION = 2
const UPLOAD_STORE = 'upload-queue'
const MANUAL_ORDER_DRAFT_STORE = 'manual-order-drafts'
export const LOCAL_DATABASE_TIMEOUT_MS = 15_000

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
let databaseConnection: IDBDatabase | null = null

function invalidateDatabase(database: IDBDatabase, close = true): void {
  if (databaseConnection === database) {
    databaseConnection = null
    databasePromise = null
  }
  if (close) {
    try { database.close() } catch { /* A browser may have already closed it. */ }
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise

  let settled = false
  const openingPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    const timeout = setTimeout(() => fail(new Error('打开本地存储超时，请重试；已有记录不会被删除')), LOCAL_DATABASE_TIMEOUT_MS)
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (databasePromise === openingPromise) databasePromise = null
      try { request.transaction?.abort() } catch { /* The open request may not have an upgrade transaction yet. */ }
      reject(error)
    }
    request.onupgradeneeded = () => {
      if (settled) {
        try { request.transaction?.abort() } catch { /* The timed-out request cannot be reused. */ }
        return
      }
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
      clearTimeout(timeout)
      const database = request.result
      databaseConnection = database
      database.onversionchange = () => invalidateDatabase(database)
      database.onclose = () => invalidateDatabase(database, false)
      resolve(database)
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

async function runTransaction<T>(
  storeName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase()
  return new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction
    try {
      transaction = database.transaction(storeName, mode)
    } catch (error) {
      // Explicit close() has no close event. A stale cached connection must still
      // be discarded so the next attempt can reopen it without deleting data.
      invalidateDatabase(database)
      reject(error)
      return
    }

    let settled = false
    let request: IDBRequest<T> | undefined
    let result: T
    let requestSucceeded = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      database.removeEventListener('close', closed)
      database.removeEventListener('versionchange', closed)
      transaction.oncomplete = null
      transaction.onerror = null
      transaction.onabort = null
      if (request) {
        request.onsuccess = null
        request.onerror = null
      }
    }
    const fail = (error: Error, invalidate = false): void => {
      if (settled) return
      settled = true
      cleanup()
      try { transaction.abort() } catch { /* An aborted/completed transaction cannot be aborted again. */ }
      if (invalidate) invalidateDatabase(database)
      reject(error)
    }
    const closed = (): void => fail(new Error('本地存储连接已关闭，请重试'), true)
    const timeout = setTimeout(() => {
      fail(new Error('本地存储操作超时，保存结果尚未确认，请重试'), true)
    }, LOCAL_DATABASE_TIMEOUT_MS)

    // Subscribe before issuing any request, and settle from one promise. Waiting
    // for a request first can miss completion or hang forever on an aborted read.
    database.addEventListener('close', closed)
    database.addEventListener('versionchange', closed)
    transaction.oncomplete = () => {
      if (settled) return
      if (!requestSucceeded) {
        fail(new Error('本地存储未返回操作结果，请重试'), true)
        return
      }
      settled = true
      cleanup()
      resolve(result)
    }
    transaction.onerror = () => fail(transaction.error ?? request?.error ?? new Error('本地存储失败'))
    transaction.onabort = () => fail(transaction.error ?? new Error('本地存储已取消'))
    try {
      request = operation(transaction.objectStore(storeName))
      request.onsuccess = () => {
        if (settled) return
        result = request!.result
        requestSucceeded = true
      }
      request.onerror = () => fail(request?.error ?? new Error('本地存储请求失败'))
    } catch (error) {
      fail(error instanceof Error ? error : new Error('本地存储请求失败'))
    }
  })
}

export async function putUpload(item: UploadQueueItem): Promise<void> {
  await runTransaction(UPLOAD_STORE, 'readwrite', (store) => store.put(item))
}

export async function deleteUpload(clientEventId: string): Promise<void> {
  await runTransaction(UPLOAD_STORE, 'readwrite', (store) => store.delete(clientEventId))
}

export async function getUpload(clientEventId: string): Promise<UploadQueueItem | null> {
  const result = await runTransaction<UploadQueueItem | undefined>(UPLOAD_STORE, 'readonly', (store) => store.get(clientEventId))
  return result ?? null
}

export async function getAllUploads(): Promise<UploadQueueItem[]> {
  return runTransaction<UploadQueueItem[]>(UPLOAD_STORE, 'readonly', (store) => store.getAll())
}

export async function putManualOrderDraft(draft: ManualOrderDraft): Promise<void> {
  await runTransaction(MANUAL_ORDER_DRAFT_STORE, 'readwrite', (store) => store.put(draft))
}

export async function getManualOrderDraft(ownerUserId: string): Promise<ManualOrderDraft | null> {
  const result = await runTransaction<ManualOrderDraft | undefined>(MANUAL_ORDER_DRAFT_STORE, 'readonly', (store) => store.get(ownerUserId))
  return result ?? null
}

export async function deleteManualOrderDraft(ownerUserId: string): Promise<void> {
  await runTransaction(MANUAL_ORDER_DRAFT_STORE, 'readwrite', (store) => store.delete(ownerUserId))
}
