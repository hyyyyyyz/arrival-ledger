// @vitest-environment happy-dom

import { IDBFactory } from 'fake-indexeddb'
import { beforeAll, describe, expect, it } from 'vitest'

async function createVersionOneDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('arrival-manager', 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('upload-queue', { keyPath: 'clientEventId' })
    }
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('upload-queue', 'readwrite')
      transaction.objectStore('upload-queue').put({ clientEventId: 'existing-upload', ownerUserId: 'operator-a' })
      transaction.oncomplete = () => {
        database.close()
        resolve()
      }
      transaction.onerror = () => reject(transaction.error)
    }
    request.onerror = () => reject(request.error)
  })
}

describe('manual order draft IndexedDB migration', () => {
  beforeAll(async () => {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() })
    await createVersionOneDatabase()
  })

  it('upgrades v1 without dropping uploads and supports isolated draft CRUD', async () => {
    const { deleteManualOrderDraft, getAllUploads, getManualOrderDraft, putManualOrderDraft } = await import('./db')
    const draft = {
      ownerUserId: 'operator-a',
      bulkText: 'SF12345678',
      defaults: { productName: '商品', courier: '', remark: '' },
      rows: [],
      sourceLabel: '粘贴内容',
      batchId: 'batch-stable-1',
      payloadKey: 'payload-1',
      updatedAt: 1,
    }

    await putManualOrderDraft(draft)
    await expect(getAllUploads()).resolves.toEqual([expect.objectContaining({ clientEventId: 'existing-upload' })])
    await expect(getManualOrderDraft('operator-a')).resolves.toEqual(draft)
    await expect(getManualOrderDraft('operator-b')).resolves.toBeNull()

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('arrival-manager')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    expect(database.version).toBe(2)
    expect(Array.from(database.objectStoreNames)).toEqual(expect.arrayContaining(['upload-queue', 'manual-order-drafts']))
    database.close()

    await deleteManualOrderDraft('operator-a')
    await expect(getManualOrderDraft('operator-a')).resolves.toBeNull()
  })
})
