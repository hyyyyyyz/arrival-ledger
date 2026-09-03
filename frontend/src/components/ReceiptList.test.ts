// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { renderToString } from '@vue/server-renderer'
import { createSSRApp } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/services/api'
import ReceiptList from './ReceiptList.vue'

const noOpSave = vi.fn()

describe('ReceiptList order matches', () => {
  it('offers an immediate upload action for a recovered local photo', async () => {
    const wrapper = mount(ReceiptList, {
      props: {
        localItems: [{
          clientEventId: 'local-1', ownerUserId: '1', ownerDisplayName: '收货员', deviceId: 'device-1',
          occurredAt: '2026-09-03T13:25:00.000Z', photo: new Blob(['photo'], { type: 'image/jpeg' }),
          fileName: 'photo.jpg', trackingNo: null, barcodeState: 'NOT_FOUND', uploadState: 'QUEUED',
          readyToUpload: true, attempts: 0, nextAttemptAt: 0, lastError: '照片处理曾意外中断',
          createdAt: 1, updatedAt: 1, inputMethod: 'PHOTO_LIBRARY',
        }],
        receipts: [],
        saveServerTracking: noOpSave,
      },
    })

    expect(wrapper.text()).toContain('立即上传')
    await wrapper.get('.record-actions button:last-child').trigger('click')
    expect(wrapper.emitted('retry')).toEqual([['local-1']])
  })

  it('opens a full-size photo preview for manual review', async () => {
    const wrapper = mount(ReceiptList, {
      props: {
        localItems: [],
        receipts: [{ id: 101, tracking_no: 'SF1234567890000', photo_url: '/uploads/receipt-101.jpg' }],
        saveServerTracking: noOpSave,
      },
    })

    await wrapper.get('.photo-button').trigger('click')
    expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe('照片预览')
    expect(wrapper.get('[role="dialog"] img').attributes('src')).toContain('/uploads/receipt-101.jpg')
    await wrapper.get('.photo-preview-close').trigger('click')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  })

  it('gives an actionable next step when there are no receipts', async () => {
    const app = createSSRApp(ReceiptList, {
      localItems: [],
      receipts: [],
      loading: false,
      saveServerTracking: noOpSave,
    })

    const html = await renderToString(app)

    expect(html).toContain('还没有收货记录')
    expect(html).toContain('请在“收货”页点击“拍照收货”')
    expect(html).toContain('去拍摄包裹')
  })

  it('shows account labels for otherwise ambiguous order numbers', async () => {
    const app = createSSRApp(ReceiptList, {
      localItems: [],
      receipts: [
        {
          id: 1,
          tracking_no: 'SF1234567890000',
          evidence_status: 'READY',
          order_matches: [
            {
              order_id: '41',
              platform: 'pdd',
              platform_order_id: '260813-0001',
              account_label: '主账号',
              shop_name: '同名店铺',
              confidence: 'CANDIDATE',
              items: [],
            },
            {
              order_id: '42',
              platform: 'pdd',
              platform_order_id: '260813-0001',
              account_label: '备用账号',
              shop_name: '同名店铺',
              confidence: 'CANDIDATE',
              items: [],
            },
          ],
        },
      ],
      saveServerTracking: noOpSave,
    })

    const html = await renderToString(app)

    expect(html).toContain('pdd · 主账号 · 同名店铺')
    expect(html).toContain('pdd · 备用账号 · 同名店铺')
  })

  it('distinguishes the photographer from the latest editor', async () => {
    const app = createSSRApp(ReceiptList, {
      localItems: [],
      receipts: [{
        id: 9,
        tracking_no: 'SF1234567890000',
        evidence_status: 'READY',
        operator: { display_name: '拍摄人甲' },
        last_modified_by: { display_name: '修改人乙' },
        last_modified_at: '2026-08-30T12:00:00Z',
      }],
      saveServerTracking: noOpSave,
    })

    const html = await renderToString(app)
    expect(html).toContain('拍摄人：拍摄人甲')
    expect(html).toContain('最近修改：修改人乙')
    expect(html).not.toContain('收货人：')
  })

  it('keeps the editor and reuses one event id when a network result is uncertain', async () => {
    const receipt = { id: 5, tracking_no: 'SF-OLD-0001', evidence_status: 'READY' as const }
    const saveServerTracking = vi.fn()
      .mockRejectedValueOnce(new ApiError(0, 'network unavailable'))
      .mockResolvedValueOnce({ ...receipt, tracking_no: 'YT-NEW-0002' })
    const wrapper = mount(ReceiptList, {
      props: {
        localItems: [],
        receipts: [receipt],
        saveServerTracking,
      },
    })

    await wrapper.get('.record-actions button').trigger('click')
    await wrapper.get('.inline-edit input').setValue('YT-NEW-0002')
    await wrapper.get('.inline-edit').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('网络结果不确定')
    expect(wrapper.get('.inline-edit input').element).toHaveProperty('value', 'YT-NEW-0002')
    const firstRequest = saveServerTracking.mock.calls[0]?.[0]
    expect(firstRequest).toMatchObject({
      receiptId: 5,
      trackingNo: 'YTNEW0002',
      expectedTrackingNo: 'SF-OLD-0001',
    })

    await wrapper.get('.inline-edit').trigger('submit')
    await flushPromises()
    expect(saveServerTracking.mock.calls[1]?.[0].clientEventId).toBe(firstRequest.clientEventId)
    expect(wrapper.find('.inline-edit').exists()).toBe(false)
  })

  it('keeps typed input on a conflict, adopts the refreshed value, and retries safely', async () => {
    const receipt = { id: 6, tracking_no: 'SF-OLD-0001', evidence_status: 'READY' as const }
    const saveServerTracking = vi.fn()
      .mockRejectedValueOnce(new ApiError(409, 'conflict', { current_tracking_no: 'ZTO-OTHER-0009' }))
      .mockResolvedValueOnce({ ...receipt, tracking_no: 'YT-NEW-0002' })
    const wrapper = mount(ReceiptList, {
      props: {
        localItems: [],
        receipts: [receipt],
        saveServerTracking,
      },
    })

    await wrapper.get('.record-actions button').trigger('click')
    await wrapper.get('.inline-edit input').setValue('YT-NEW-0002')
    await wrapper.get('.inline-edit').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('已被其他人修改')
    expect((wrapper.get('.inline-edit input').element as HTMLInputElement).value).toBe('YT-NEW-0002')
    const firstEventId = saveServerTracking.mock.calls[0]?.[0].clientEventId

    await wrapper.get('.inline-edit').trigger('submit')
    await flushPromises()
    expect(saveServerTracking.mock.calls[1]?.[0]).toMatchObject({
      expectedTrackingNo: 'ZTO-OTHER-0009',
      clientEventId: firstEventId,
    })
  })
})
