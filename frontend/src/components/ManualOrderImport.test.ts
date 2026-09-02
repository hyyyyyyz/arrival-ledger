// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const draftState = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  failNextDelete: false,
  loadPromise: null as Promise<unknown> | null,
}))
const draftStore = draftState.store
vi.mock('@/services/db', () => ({
  getManualOrderDraft: vi.fn(async (key: string) => draftState.loadPromise ? await draftState.loadPromise : draftStore.get(key) ?? null),
  putManualOrderDraft: vi.fn(async (draft: { ownerUserId: string }) => { draftStore.set(draft.ownerUserId, structuredClone(draft)) }),
  deleteManualOrderDraft: vi.fn(async (key: string) => {
    if (draftState.failNextDelete) {
      draftState.failNextDelete = false
      throw new Error('quota')
    }
    draftStore.delete(key)
  }),
}))

import ManualOrderImport from './ManualOrderImport.vue'

function props() {
  return {
    ownerUserId: 'user-1',
    createManualOrder: vi.fn().mockResolvedValue({ created: true }),
    createManualOrderBatch: vi.fn().mockResolvedValue({
      client_batch_id: 'manual-batch-response-0001',
      idempotent_replay: false,
      total_count: 1,
      unique_count: 1,
      created_count: 1,
      idempotent_count: 0,
      duplicate_count: 0,
      failed_count: 0,
      items: [{ input_index: 1, status: 'CREATED', tracking_no: 'SF12345678' }],
    }),
  }
}

describe('ManualOrderImport', () => {
  beforeEach(() => {
    draftStore.clear()
    draftState.failNextDelete = false
    draftState.loadPromise = null
  })
  it('keeps single-order entry available', async () => {
    const componentProps = props()
    const wrapper = mount(ManualOrderImport, { props: componentProps })
    await flushPromises()
    const singleInputs = wrapper.findAll('.manual-order-form input')
    await singleInputs[0]!.setValue('sf-12345678')
    await singleInputs[1]!.setValue('测试商品')
    await wrapper.get('.manual-order-form').trigger('submit')
    expect(componentProps.createManualOrder).toHaveBeenCalledWith(expect.objectContaining({
      tracking_no: 'SF12345678',
      product_name: '测试商品',
      client_event_id: expect.any(String),
    }))
    expect(wrapper.text()).toContain('第三方订单已加入订单列表')
  })

  it.each([
    ['9.818907591847 E+12', '科学计数法'],
    ['08/24/2026', '日期格式'],
    ['9818907591847,0', 'Excel 数值改写'],
    ['SF12345678/YT87654321', '一个输入只能有一个运单号'],
  ])('rejects suspicious single-order tracking input %s', async (trackingNo, expectedMessage) => {
    const componentProps = props()
    const wrapper = mount(ManualOrderImport, { props: componentProps })
    await flushPromises()
    const singleInputs = wrapper.findAll('.manual-order-form input')
    await singleInputs[0]!.setValue(trackingNo)
    await singleInputs[1]!.setValue('测试商品')
    await wrapper.get('.manual-order-form').trigger('submit')
    expect(componentProps.createManualOrder).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain(expectedMessage)
  })

  it('previews, de-duplicates and submits one confirmed batch', async () => {
    const componentProps = props()
    const wrapper = mount(ManualOrderImport, { props: componentProps })
    await flushPromises()
    await wrapper.get('.bulk-import-section textarea').setValue('SF12345678，YT12345678\nSF12345678')
    await wrapper.get('.secondary-import-button').trigger('click')
    expect(wrapper.text()).toContain('2 条可导入')
    expect(wrapper.text()).toContain('已去重 1 条')
    expect(wrapper.text()).toContain('2 条将使用默认商品名')

    await wrapper.get('.confirm-import-button').trigger('click')
    await flushPromises()
    expect(componentProps.createManualOrderBatch).toHaveBeenCalledWith({
      client_batch_id: expect.any(String),
      rows: [
        { row_number: 1, tracking_no: 'SF12345678', product_name: undefined, courier: undefined, remark: undefined },
        { row_number: 2, tracking_no: 'YT12345678', product_name: undefined, courier: undefined, remark: undefined },
      ],
    })
    expect(wrapper.text()).toContain('导入完成')
    expect(wrapper.text()).toContain('新建 1 条')
    expect(wrapper.emitted('imported')).toHaveLength(1)
  })

  it('renders backend row failures in the result summary', async () => {
    const componentProps = props()
    componentProps.createManualOrderBatch.mockResolvedValueOnce({
      client_batch_id: 'manual-batch-response-0002',
      idempotent_replay: false,
      total_count: 1,
      unique_count: 1,
      created_count: 0,
      idempotent_count: 0,
      duplicate_count: 0,
      failed_count: 1,
      items: [{ input_index: 1, status: 'FAILED', tracking_no: 'SF12345678', error_code: 'CONFLICT', message: '已属于平台订单' }],
    })
    const wrapper = mount(ManualOrderImport, { props: componentProps })
    await flushPromises()
    await wrapper.get('.bulk-import-section textarea').setValue('SF12345678')
    await wrapper.get('.secondary-import-button').trigger('click')
    await wrapper.get('.confirm-import-button').trigger('click')
    expect(wrapper.text()).toContain('失败 1 条')
    expect(wrapper.text()).toContain('SF12345678：已属于平台订单')
  })

  it('restores a parsed draft per user with the same batch id', async () => {
    const componentProps = props()
    const first = mount(ManualOrderImport, { props: componentProps })
    await flushPromises()
    await first.get('.bulk-import-section textarea').setValue('SF12345678')
    await first.get('.secondary-import-button').trigger('click')
    await flushPromises()
    const saved = draftStore.get('user-1') as { batchId: string }
    expect(saved.batchId).toBeTruthy()
    first.unmount()

    const restored = mount(ManualOrderImport, { props: componentProps })
    await flushPromises()
    expect(restored.text()).toContain('1 条可导入')
    await restored.get('.confirm-import-button').trigger('click')
    expect(componentProps.createManualOrderBatch).toHaveBeenLastCalledWith(expect.objectContaining({ client_batch_id: saved.batchId }))
    await flushPromises()
    expect(draftStore.has('user-1')).toBe(false)
    expect(restored.find('.confirm-import-button').exists()).toBe(false)
  })

  it('keeps drafts isolated between users', async () => {
    draftStore.set('another-user', {
      ownerUserId: 'another-user', bulkText: 'SF87654321', defaults: { productName: '', courier: '', remark: '' },
      rows: [], sourceLabel: '', batchId: '', payloadKey: '', updatedAt: Date.now(),
    })
    const wrapper = mount(ManualOrderImport, { props: props() })
    await flushPromises()
    expect((wrapper.get('.bulk-import-section textarea').element as HTMLTextAreaElement).value).toBe('')
  })

  it('locks every editable control until the asynchronous draft load finishes', async () => {
    let finishLoad!: (draft: unknown) => void
    draftState.loadPromise = new Promise((resolve) => { finishLoad = resolve })
    const wrapper = mount(ManualOrderImport, { props: props() })

    expect(wrapper.findAll('input, textarea, button').filter((control) => control.attributes('disabled') === undefined).length).toBe(0)
    expect(wrapper.text()).toContain('正在读取本机草稿')

    finishLoad({
      ownerUserId: 'user-1', bulkText: 'SF87654321', defaults: { productName: '旧草稿商品', courier: '', remark: '' },
      rows: [], sourceLabel: '', batchId: '', payloadKey: '', submitted: false, updatedAt: Date.now(),
    })
    await flushPromises()
    expect((wrapper.get('.bulk-import-section textarea').element as HTMLTextAreaElement).value).toBe('SF87654321')
    expect(wrapper.get('.bulk-import-section textarea').attributes('disabled')).toBeUndefined()
  })

  it('reports an expired login and emits the shared auth event without losing the draft', async () => {
    const componentProps = props()
    componentProps.createManualOrderBatch.mockRejectedValueOnce(new (await import('@/services/api')).ApiError(401, 'expired'))
    const wrapper = mount(ManualOrderImport, { props: componentProps })
    await flushPromises()
    await wrapper.get('.bulk-import-section textarea').setValue('SF12345678')
    await wrapper.get('.secondary-import-button').trigger('click')
    await wrapper.get('.confirm-import-button').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('登录已过期，请重新登录；批量草稿已保存在本机')
    expect(wrapper.emitted('authRequired')).toHaveLength(1)
    expect(draftStore.has('user-1')).toBe(true)
  })

  it('describes an offline batch failure without implying the order was uploaded', async () => {
    const componentProps = props()
    componentProps.createManualOrderBatch.mockRejectedValueOnce(new (await import('@/services/api')).ApiError(0, 'offline'))
    const wrapper = mount(ManualOrderImport, { props: componentProps })
    await flushPromises()
    await wrapper.get('.bulk-import-section textarea').setValue('SF12345678')
    await wrapper.get('.secondary-import-button').trigger('click')
    await wrapper.get('.confirm-import-button').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('网络不可用，批量草稿已保存在本机')
    expect(wrapper.text()).not.toContain('导入完成')
  })

  it('continues saving later edits after a completed batch draft deletion fails', async () => {
    const wrapper = mount(ManualOrderImport, { props: props() })
    await flushPromises()
    await wrapper.get('.bulk-import-section textarea').setValue('SF12345678')
    await wrapper.get('.secondary-import-button').trigger('click')
    await flushPromises()
    draftState.failNextDelete = true
    await wrapper.get('.confirm-import-button').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('草稿清理失败')

    wrapper.unmount()
    const restored = mount(ManualOrderImport, { props: props() })
    await flushPromises()
    expect(restored.text()).toContain('该批已提交')
    expect(restored.get('.confirm-import-button').attributes('disabled')).toBeDefined()

    await restored.get('.bulk-import-section textarea').setValue('YT12345678')
    await flushPromises()
    expect((draftStore.get('user-1') as { bulkText: string }).bulkText).toBe('YT12345678')
  })
})
