// @vitest-environment happy-dom

import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'

describe('IndexedDB open retry', () => {
  it('retries after a v2 upgrade was blocked by an old connection', async () => {
    vi.resetModules()
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() })
    const oldDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('arrival-manager', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('upload-queue', { keyPath: 'clientEventId' })
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const databaseModule = await import('./db')

    await expect(databaseModule.getManualOrderDraft('operator-a')).rejects.toThrow('旧页面占用')
    oldDatabase.close()
    await expect(databaseModule.getManualOrderDraft('operator-a')).resolves.toBeNull()
  })
})
