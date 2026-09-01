// @vitest-environment happy-dom

import { renderToString } from '@vue/server-renderer'
import { createSSRApp } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import ReceiptCapture from './ReceiptCapture.vue'

describe('ReceiptCapture input modes', () => {
  it('renders separate camera and multi-select gallery inputs', async () => {
    const html = await renderToString(createSSRApp(ReceiptCapture, {
      user: { id: 1, username: 'receiver', display_name: '收货员' },
      saveServerTracking: vi.fn(),
      createManualOrder: vi.fn(),
    }))
    expect(html).toContain('拍摄包裹面单')
    expect(html).toContain('从相册选择')
    expect(html).toContain('multiple')
    expect(html).toContain('其他渠道快递')
    expect(html).toContain('运单号（必填）')
    expect(html).toContain('商品名称（必填）')
  })
})
