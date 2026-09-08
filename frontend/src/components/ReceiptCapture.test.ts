// @vitest-environment happy-dom

import { renderToString } from '@vue/server-renderer'
import { createSSRApp } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Receipt, UploadQueueItem } from '@/types'
import ReceiptCapture from './ReceiptCapture.vue'

const mocks = vi.hoisted(() => ({
  copyPhoto: vi.fn(),
  enqueue: vi.fn(),
  retryNow: vi.fn(),
  updateTracking: vi.fn(),
  itemsForCurrentUser: vi.fn(),
  listeners: new Map<string, Set<EventListener>>(),
}))

vi.mock('@/services/photoCopy', () => ({ copyPhoto: mocks.copyPhoto }))
vi.mock('@/services/uploadQueue', () => ({
  uploadQueue: {
    enqueue: mocks.enqueue,
    retryNow: mocks.retryNow,
    updateTracking: mocks.updateTracking,
    itemsForCurrentUser: mocks.itemsForCurrentUser,
    addEventListener: (name: string, listener: EventListener) => {
      const listeners = mocks.listeners.get(name) ?? new Set<EventListener>()
      listeners.add(listener)
      mocks.listeners.set(name, listeners)
    },
    removeEventListener: (name: string, listener: EventListener) => mocks.listeners.get(name)?.delete(listener),
  },
}))

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function pick(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  Object.defineProperty(input, 'value', { configurable: true, writable: true, value: `C:\\fakepath\\${files[0]?.name}` })
}

function dispatchQueueEvent(name: string, detail?: unknown): void {
  const event = detail === undefined ? new Event(name) : new CustomEvent(name, { detail })
  for (const listener of mocks.listeners.get(name) ?? []) listener(event)
}

describe('ReceiptCapture input modes', () => {
  it('renders separate camera and multi-select gallery inputs', async () => {
    const html = await renderToString(createSSRApp(ReceiptCapture, {
      user: { id: 1, username: 'receiver', display_name: '收货员' },
      saveServerTracking: vi.fn(),
      createManualOrder: vi.fn(),
      createManualOrderBatch: vi.fn(),
    }))
    expect(html).toContain('拍摄包裹面单')
    expect(html).toContain('从相册选择')
    expect(html).toContain('multiple')
    expect(html).toContain('其他渠道快递')
    expect(html).toContain('单条录入')
    expect(html).toContain('批量导入')
    expect(html).toContain('粘贴运单号')
    expect(html).toContain('选择 Excel / CSV 文件')
  })
})

describe('ReceiptCapture durable staging and continuous camera use', () => {
  const wrappers: VueWrapper[] = []
  let saved: UploadQueueItem[]

  function mountCapture() {
    const wrapper = mount(ReceiptCapture, {
      props: {
        user: { id: 5, username: 'staff_5', display_name: '测试收货员' },
        saveServerTracking: vi.fn(),
        createManualOrder: vi.fn(),
        createManualOrderBatch: vi.fn(),
      },
      global: { stubs: { ManualOrderImport: true } },
    })
    wrappers.push(wrapper)
    return wrapper
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listeners.clear()
    saved = []
    mocks.copyPhoto.mockImplementation(async (file: File) => new File([file], file.name, { type: file.type }))
    mocks.enqueue.mockImplementation(async (item: UploadQueueItem) => { saved.push(item) })
    mocks.itemsForCurrentUser.mockImplementation(async () => saved)
    mocks.retryNow.mockResolvedValue(undefined)
    mocks.updateTracking.mockResolvedValue(undefined)
    vi.stubGlobal('localStorage', { getItem: vi.fn().mockReturnValue('capture-test-device'), setItem: vi.fn() })
    let preview = 0
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:capture-test-${++preview}`)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  })

  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('reenables the camera after durable enqueue while recognition and upload remain pending', async () => {
    const persistence = deferred<void>()
    mocks.enqueue.mockImplementation(async (item: UploadQueueItem) => { await persistence.promise; saved.push(item) })
    const wrapper = mountCapture()
    const camera = wrapper.get<HTMLInputElement>('input[capture="environment"]')
    const photo = new File(['first photo'], 'first.jpg', { type: 'image/jpeg' })
    pick(camera.element, [photo])
    await camera.trigger('change')
    await flushPromises()

    expect(camera.element.disabled).toBe(true)
    expect(wrapper.text()).toContain('正在保存照片')
    expect(wrapper.find('.capture-result').exists()).toBe(false)

    persistence.resolve()
    await flushPromises()
    expect(camera.element.disabled).toBe(false)
    expect(wrapper.text()).toContain('可以继续拍下一件')
    expect(wrapper.text()).toContain('已留本机')
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ ownerUserId: '5', barcodeState: 'PROCESSING', readyToUpload: false, needsPreparation: true, uploadState: 'QUEUED' })
    expect(saved[0]?.photo).not.toBe(photo)
    expect(wrapper.emitted('changed')).toHaveLength(1)
  })

  it('persists a second camera photo while the first still has no recognition or server result', async () => {
    const wrapper = mountCapture()
    const camera = wrapper.get<HTMLInputElement>('input[capture="environment"]')
    for (const name of ['one.jpg', 'two.jpg']) {
      pick(camera.element, [new File([name], name, { type: 'image/jpeg' })])
      await camera.trigger('change')
      await flushPromises()
      expect(camera.element.disabled).toBe(false)
    }

    expect(saved).toHaveLength(2)
    expect(new Set(saved.map((item) => item.clientEventId)).size).toBe(2)
    expect(saved.map((item) => item.fileName)).toEqual(['one.jpg', 'two.jpg'])
    expect(saved.every((item) => !item.readyToUpload && item.uploadState === 'QUEUED')).toBe(true)
    expect(wrapper.findAll('.capture-result')).toHaveLength(1)
    expect(wrapper.emitted('changed')).toHaveLength(2)
  })

  it('keeps the picker selection through both copying and persistence, clearing only after success', async () => {
    const copying = deferred<File>()
    const persistence = deferred<void>()
    mocks.copyPhoto.mockReturnValue(copying.promise)
    mocks.enqueue.mockReturnValue(persistence.promise)
    const wrapper = mountCapture()
    const camera = wrapper.get<HTMLInputElement>('input[capture="environment"]')
    const original = new File(['original'], 'original.jpg', { type: 'image/jpeg' })
    const copied = new File(['original'], 'original.jpg', { type: 'image/jpeg' })
    pick(camera.element, [original])
    const originalValue = camera.element.value
    await camera.trigger('change')
    expect(mocks.copyPhoto).toHaveBeenCalledWith(original)
    expect(mocks.enqueue).not.toHaveBeenCalled()
    expect(camera.element.value).toBe(originalValue)
    expect(camera.element.disabled).toBe(true)

    copying.resolve(copied)
    await flushPromises()
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ photo: copied }))
    expect(camera.element.value).toBe(originalValue)
    expect(camera.element.disabled).toBe(true)

    persistence.resolve()
    await flushPromises()
    expect(camera.element.value).toBe('')
    expect(camera.element.disabled).toBe(false)
  })

  it('shows persistence failure without claiming that the photo was safely saved', async () => {
    mocks.enqueue.mockRejectedValue(new Error('本机存储空间不足，请保留原图后重试'))
    const wrapper = mountCapture()
    const camera = wrapper.get<HTMLInputElement>('input[capture="environment"]')
    pick(camera.element, [new File(['photo'], 'retry.jpg', { type: 'image/jpeg' })])
    const selectedValue = camera.element.value
    await camera.trigger('change')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('本机存储空间不足')
    expect(wrapper.find('.capture-result').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('已留本机')
    expect(wrapper.text()).not.toContain('已保存到本机，可以继续拍下一件')
    expect(camera.element.disabled).toBe(false)
    expect(camera.element.value).toBe(selectedValue)
    expect(wrapper.emitted('changed')).toBeUndefined()
    expect(saved).toHaveLength(0)
  })

  it('clears the previous package manual tracking when a new original is durably saved', async () => {
    const wrapper = mountCapture()
    const camera = wrapper.get<HTMLInputElement>('input[capture="environment"]')
    pick(camera.element, [new File(['first'], 'first.jpg', { type: 'image/jpeg' })])
    await camera.trigger('change')
    await flushPromises()
    await wrapper.get('input[aria-label="快递单号"]').setValue('SF1234567890')

    pick(camera.element, [new File(['second'], 'second.jpg', { type: 'image/jpeg' })])
    await camera.trigger('change')
    await flushPromises()
    expect(wrapper.get<HTMLInputElement>('input[aria-label="快递单号"]').element.value).toBe('')
    expect(wrapper.find('.tracking-number').exists()).toBe(false)

    dispatchQueueEvent('synced', { id: 20, client_event_id: saved[1]?.clientEventId, tracking_no: null })
    await flushPromises()
    expect(wrapper.props('saveServerTracking')).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('SF1234567890')
  })

  it.each(['success', 'failure'] as const)('does not apply a delayed local manual save %s to a newer package', async (outcome) => {
    const pendingSave = deferred<void>()
    mocks.updateTracking.mockReturnValue(pendingSave.promise)
    const wrapper = mountCapture()
    const camera = wrapper.get<HTMLInputElement>('input[capture="environment"]')
    pick(camera.element, [new File(['first'], 'first.jpg', { type: 'image/jpeg' })])
    await camera.trigger('change')
    await flushPromises()
    await wrapper.get('input[aria-label="快递单号"]').setValue('SF1234567890')
    await wrapper.get('.tracking-form').trigger('submit')
    expect(mocks.updateTracking).toHaveBeenCalledWith(saved[0]?.clientEventId, 'SF1234567890')

    pick(camera.element, [new File(['second'], 'second.jpg', { type: 'image/jpeg' })])
    await camera.trigger('change')
    await flushPromises()
    await wrapper.get('input[aria-label="快递单号"]').setValue('YT9876543210')
    if (outcome === 'success') pendingSave.resolve()
    else pendingSave.reject(new Error('Old package local update failed'))
    await flushPromises()

    expect(wrapper.get<HTMLInputElement>('input[aria-label="快递单号"]').element.value).toBe('YT9876543210')
    expect(wrapper.find('.tracking-number').exists()).toBe(false)
    expect(wrapper.get('.capture-result').text()).toContain('可以继续拍下一件')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it.each(['success', 'failure'] as const)('ignores an older package asynchronous reconciliation %s after a new capture', async (outcome) => {
    const pendingPatch = deferred<Receipt>()
    const saveServerTracking = vi.fn().mockReturnValue(pendingPatch.promise)
    const wrapper = mountCapture()
    await wrapper.setProps({ saveServerTracking })
    const camera = wrapper.get<HTMLInputElement>('input[capture="environment"]')
    pick(camera.element, [new File(['first'], 'first.jpg', { type: 'image/jpeg' })])
    await camera.trigger('change')
    await flushPromises()
    await wrapper.get('input[aria-label="快递单号"]').setValue('SF1234567890')
    dispatchQueueEvent('synced', { id: 10, client_event_id: saved[0]?.clientEventId, tracking_no: null })
    await flushPromises()
    expect(saveServerTracking).toHaveBeenCalledWith(expect.objectContaining({ receiptId: 10, trackingNo: 'SF1234567890' }))

    pick(camera.element, [new File(['second'], 'second.jpg', { type: 'image/jpeg' })])
    await camera.trigger('change')
    await flushPromises()
    await wrapper.get('input[aria-label="快递单号"]').setValue('YT9876543210')
    const currentPreview = wrapper.get('.capture-result img').attributes('src')
    if (outcome === 'success') pendingPatch.resolve({ id: 10, tracking_no: 'SF1234567890' })
    else pendingPatch.reject(new Error('Old package network error'))
    await flushPromises()

    expect(wrapper.get('.capture-result img').attributes('src')).toBe(currentPreview)
    expect(wrapper.get<HTMLInputElement>('input[aria-label="快递单号"]').element.value).toBe('YT9876543210')
    expect(wrapper.find('.tracking-number').exists()).toBe(false)
    expect(wrapper.get('.capture-result').text()).toContain('可以继续拍下一件')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it.each(['success', 'failure'] as const)('does not apply a delayed server-side correction %s to a newer package', async (outcome) => {
    const pendingPatch = deferred<Receipt>()
    const saveServerTracking = vi.fn().mockReturnValue(pendingPatch.promise)
    const wrapper = mountCapture()
    await wrapper.setProps({ saveServerTracking })
    const camera = wrapper.get<HTMLInputElement>('input[capture="environment"]')
    pick(camera.element, [new File(['first'], 'first.jpg', { type: 'image/jpeg' })])
    await camera.trigger('change')
    await flushPromises()
    dispatchQueueEvent('synced', { id: 10, client_event_id: saved[0]?.clientEventId, tracking_no: 'SF0000000000' })
    await flushPromises()
    await wrapper.get('input[aria-label="快递单号"]').setValue('SF1234567890')
    await wrapper.get('.tracking-form').trigger('submit')
    expect(saveServerTracking).toHaveBeenCalledWith(expect.objectContaining({ receiptId: 10, trackingNo: 'SF1234567890', expectedTrackingNo: 'SF0000000000' }))

    pick(camera.element, [new File(['second'], 'second.jpg', { type: 'image/jpeg' })])
    await camera.trigger('change')
    await flushPromises()
    await wrapper.get('input[aria-label="快递单号"]').setValue('YT9876543210')
    if (outcome === 'success') pendingPatch.resolve({ id: 10, tracking_no: 'SF1234567890' })
    else pendingPatch.reject(new Error('Old package server update failed'))
    await flushPromises()

    expect(wrapper.get<HTMLInputElement>('input[aria-label="快递单号"]').element.value).toBe('YT9876543210')
    expect(wrapper.find('.tracking-number').exists()).toBe(false)
    expect(wrapper.get('.capture-result').text()).toContain('可以继续拍下一件')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('keeps the picker selection and never enqueues an unreadable original', async () => {
    mocks.copyPhoto.mockRejectedValue(new Error('照片未读取完整，请从相册重新选择'))
    const wrapper = mountCapture()
    const camera = wrapper.get<HTMLInputElement>('input[capture="environment"]')
    pick(camera.element, [new File(['photo'], 'unreadable.jpg', { type: 'image/jpeg' })])
    const selectedValue = camera.element.value
    await camera.trigger('change')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('照片未读取完整')
    expect(camera.element.value).toBe(selectedValue)
    expect(camera.element.disabled).toBe(false)
    expect(mocks.enqueue).not.toHaveBeenCalled()
    expect(wrapper.find('.capture-result').exists()).toBe(false)
  })

  it('removes a successfully synchronized gallery photo while retaining the unsynced selection', async () => {
    const wrapper = mountCapture()
    const gallery = wrapper.get<HTMLInputElement>('input[type="file"][multiple]')
    pick(gallery.element, ['one.jpg', 'two.jpg'].map((name) => new File([name], name, { type: 'image/jpeg' })))
    await gallery.trigger('change')
    await flushPromises()
    expect(wrapper.findAll('.gallery-item')).toHaveLength(2)
    const firstPreview = wrapper.get('.gallery-item img').attributes('src')
    await wrapper.get('.gallery-batch-header button').trigger('click')
    await flushPromises()
    expect(saved).toHaveLength(2)
    expect(wrapper.get<HTMLInputElement>('input[capture="environment"]').element.disabled).toBe(false)

    const synced = new CustomEvent('synced', { detail: { id: 10, client_event_id: saved[0]?.clientEventId, tracking_no: null } })
    for (const listener of mocks.listeners.get('synced') ?? []) listener(synced)
    await flushPromises()

    expect(wrapper.findAll('.gallery-item')).toHaveLength(1)
    expect(wrapper.get('.gallery-batch-header').text()).toContain('已选照片（1）')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(firstPreview)
    expect(wrapper.get('.gallery-item').text()).toContain('已排队')
  })

  it('retries an unpersisted gallery photo with the original event ID instead of retrying a nonexistent row', async () => {
    mocks.enqueue.mockRejectedValueOnce(new Error('storage unavailable'))
    const wrapper = mountCapture()
    const gallery = wrapper.get<HTMLInputElement>('input[type="file"][multiple]')
    pick(gallery.element, [new File(['photo'], 'gallery.jpg', { type: 'image/jpeg' })])
    await gallery.trigger('change')
    await flushPromises()
    await wrapper.get('.gallery-batch-header button').trigger('click')
    await flushPromises()
    const originalItem = mocks.enqueue.mock.calls[0]?.[0] as UploadQueueItem
    expect(wrapper.get('.gallery-item').text()).toContain('storage unavailable')
    expect(saved).toHaveLength(0)

    await wrapper.get('.gallery-batch-header button').trigger('click')
    await flushPromises()
    expect(mocks.enqueue).toHaveBeenCalledTimes(2)
    expect(mocks.enqueue.mock.calls[1]?.[0]).toMatchObject({ clientEventId: originalItem.clientEventId, fileName: originalItem.fileName })
    expect(mocks.retryNow).not.toHaveBeenCalled()
    expect(saved).toHaveLength(1)
    expect(wrapper.get('.gallery-item').text()).toContain('已排队')
  })

  it('retries an already persisted gallery failure without creating another local event', async () => {
    const wrapper = mountCapture()
    const gallery = wrapper.get<HTMLInputElement>('input[type="file"][multiple]')
    pick(gallery.element, [new File(['photo'], 'gallery.jpg', { type: 'image/jpeg' })])
    await gallery.trigger('change')
    await flushPromises()
    await wrapper.get('.gallery-batch-header button').trigger('click')
    await flushPromises()
    const persistedItem = saved[0]
    expect(persistedItem).toBeDefined()
    if (!persistedItem) throw new Error('Missing persisted test row')
    persistedItem.uploadState = 'FAILED'
    persistedItem.lastError = 'network unavailable'
    dispatchQueueEvent('change')
    await flushPromises()
    expect(wrapper.get('.gallery-item').text()).toContain('network unavailable')

    await wrapper.get('.gallery-batch-header button').trigger('click')
    await flushPromises()
    expect(mocks.retryNow).toHaveBeenCalledWith(persistedItem.clientEventId)
    expect(mocks.enqueue).toHaveBeenCalledOnce()
    expect(saved).toHaveLength(1)
    expect(wrapper.get('.gallery-item').text()).toContain('已排队')
  })
})
