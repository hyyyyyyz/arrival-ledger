import { renderToString } from '@vue/server-renderer'
import { createSSRApp } from 'vue'
import { describe, expect, it } from 'vitest'

import ReceiptList from './ReceiptList.vue'

describe('ReceiptList order matches', () => {
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
    })

    const html = await renderToString(app)

    expect(html).toContain('pdd · 主账号 · 同名店铺')
    expect(html).toContain('pdd · 备用账号 · 同名店铺')
  })
})
