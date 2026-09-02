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
