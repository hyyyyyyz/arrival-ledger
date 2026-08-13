import type { UploadQueueItem } from '@/types'

const DATABASE_NAME = 'arrival-manager'
const DATABASE_VERSION = 1
const UPLOAD_STORE = 'upload-queue'

let databasePromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(UPLOAD_STORE)) {
        const store = database.createObjectStore(UPLOAD_STORE, { keyPath: 'clientEventId' })
        store.createIndex('ownerUserId', 'ownerUserId', { unique: false })
        store.createIndex('createdAt', 'createdAt', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开本地存储'))
    request.onblocked = () => reject(new Error('本地存储正被旧页面占用，请关闭其他页面后重试'))
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
