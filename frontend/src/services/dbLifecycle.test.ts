// @vitest-environment happy-dom

import { forceCloseDatabase, IDBFactory, IDBVersionChangeEvent } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function controlledDatabase() {
  const request = { result: [], error: null, onsuccess: null, onerror: null } as unknown as IDBRequest<unknown[]>
  const abort = vi.fn()
  const transaction = {
    error: null,
    oncomplete: null,
    onerror: null,
    onabort: null,
    abort,
    objectStore: vi.fn(() => ({ getAll: () => request, get: () => request, put: () => request, delete: () => request })),
  } as unknown as IDBTransaction
  const close = vi.fn()
  const database = Object.assign(new EventTarget(), {
    close,
    transaction: vi.fn(() => transaction),
  }) as unknown as IDBDatabase
  const opening = { result: database, transaction: null, error: null } as unknown as IDBOpenDBRequest
  const open = vi.fn(() => opening)
  vi.stubGlobal('indexedDB', { open })
  const opened = async (): Promise<void> => {
    opening.onsuccess?.call(opening, new Event('success'))
    await Promise.resolve()
  }
  const succeed = (): void => {
    request.onsuccess?.call(request, new Event('success'))
    transaction.oncomplete?.call(transaction, new Event('complete'))
  }
  return { request, transaction, database, opening, open, close, abort, opened, succeed }
}

describe('IndexedDB operation deadlines', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('settles a silent open and allows a new attempt without deleting storage', async () => {
    const control = controlledDatabase()
    const db = await import('./db')
    const outcome = expect(db.getAllUploads()).rejects.toThrow('打开本地存储超时')
    await vi.advanceTimersByTimeAsync(db.LOCAL_DATABASE_TIMEOUT_MS)
    await outcome
    const retry = db.getAllUploads()
    await control.opened()
    control.succeed()
    await expect(retry).resolves.toEqual([])
    expect(control.open).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closes a connection delivered after an open timeout', async () => {
    const control = controlledDatabase()
    const db = await import('./db')
    const outcome = expect(db.getAllUploads()).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(db.LOCAL_DATABASE_TIMEOUT_MS)
    await outcome
    await control.opened()
    expect(control.close).toHaveBeenCalledOnce()
    expect(control.database.transaction).not.toHaveBeenCalled()
  })

  it('observes transaction completion in the same turn as request success', async () => {
    const control = controlledDatabase()
    const db = await import('./db')
    const pending = db.getAllUploads()
    await control.opened()
    expect(control.transaction.oncomplete).toBeTypeOf('function')
    control.succeed()
    await expect(pending).resolves.toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts a silent transaction and reopens on the next attempt', async () => {
    const control = controlledDatabase()
    const db = await import('./db')
    const outcome = expect(db.getAllUploads()).rejects.toThrow('本地存储操作超时')
    await control.opened()
    await vi.advanceTimersByTimeAsync(db.LOCAL_DATABASE_TIMEOUT_MS)
    await outcome
    expect(control.abort).toHaveBeenCalledOnce()
    expect(control.close).toHaveBeenCalledOnce()
    const retry = db.getAllUploads()
    await control.opened()
    control.succeed()
    await expect(retry).resolves.toEqual([])
    expect(control.open).toHaveBeenCalledTimes(2)
  })

  it('does not mistake request success for a committed transaction', async () => {
    const control = controlledDatabase()
    const db = await import('./db')
    const outcome = expect(db.deleteUpload('existing-event')).rejects.toThrow('保存结果尚未确认')
    await control.opened()
    control.request.onsuccess?.call(control.request, new Event('success'))
    await vi.advanceTimersByTimeAsync(db.LOCAL_DATABASE_TIMEOUT_MS)
    await outcome
    expect(control.abort).toHaveBeenCalledOnce()
  })

  it('settles an aborted read even if the request never fires a callback', async () => {
    const control = controlledDatabase()
    const db = await import('./db')
    const outcome = expect(db.getUpload('existing-event')).rejects.toThrow('本地存储已取消')
    await control.opened()
    control.transaction.onabort?.call(control.transaction, new Event('abort'))
    await outcome
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['close', 'versionchange'])('settles a silent transaction after database %s', async (event) => {
    const control = controlledDatabase()
    const db = await import('./db')
    const outcome = expect(db.getManualOrderDraft('operator-a')).rejects.toThrow('连接已关闭')
    await control.opened()
    control.database.dispatchEvent(new Event(event))
    await outcome
    expect(control.abort).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles synchronous request creation errors without an unhandled transaction promise', async () => {
    const control = controlledDatabase()
    vi.mocked(control.transaction.objectStore).mockImplementation(() => { throw new Error('store unavailable') })
    const db = await import('./db')
    const outcome = expect(db.getAllUploads()).rejects.toThrow('store unavailable')
    await control.opened()
    await outcome
    expect(control.abort).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('IndexedDB connection recovery preserves drafts', () => {
  const connections: IDBDatabase[] = []
  beforeEach(() => {
    vi.resetModules()
    const factory = new IDBFactory()
    const originalOpen = factory.open.bind(factory)
    vi.spyOn(factory, 'open').mockImplementation((name, version) => {
      const request = originalOpen(name, version)
      request.addEventListener('success', () => connections.push(request.result))
      return request
    })
    vi.stubGlobal('indexedDB', factory)
  })
  afterEach(() => {
    for (const database of connections.splice(0)) database.close()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each(['versionchange', 'close', 'explicit-close'])('reopens after %s without losing a saved draft', async (event) => {
    const db = await import('./db')
    const draft = {
      ownerUserId: 'operator-a',
      bulkText: 'SF12345678',
      defaults: { productName: '商品', courier: '', remark: '' },
      rows: [],
      sourceLabel: '粘贴内容',
      batchId: 'stable-batch',
      payloadKey: 'stable-payload',
      updatedAt: 1,
    }
    await db.putManualOrderDraft(draft)
    const database = connections[0]!
    if (event === 'versionchange') {
      database.onversionchange?.call(database, new IDBVersionChangeEvent('versionchange', { oldVersion: 2, newVersion: 3 }))
    } else if (event === 'close') {
      // fake-indexeddb 6 types this instance parameter as the constructor.
      forceCloseDatabase(database as unknown as Parameters<typeof forceCloseDatabase>[0])
    } else {
      database.close()
      await expect(db.getManualOrderDraft('operator-a')).rejects.toMatchObject({ name: 'InvalidStateError' })
    }
    await expect(db.getManualOrderDraft('operator-a')).resolves.toEqual(draft)
    expect(connections).toHaveLength(2)
  })
})
