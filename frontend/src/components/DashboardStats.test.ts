import { renderToString } from '@vue/server-renderer'
import { createSSRApp } from 'vue'
import { describe, expect, it } from 'vitest'

import DashboardStats from './DashboardStats.vue'

describe('DashboardStats', () => {
  it('renders the four server-side business totals', async () => {
    const app = createSSRApp(DashboardStats, {
      stats: {
        total_orders: 184,
        arrival_photos: 7,
        matched_orders: 6,
        pending_orders: 178,
        candidate_photos: 2,
        unmatched_photos: 1,
        account_count: 1,
      },
      loading: false,
      error: '',
      online: true,
    })

    const html = await renderToString(app)

    expect(html).toContain('采购订单')
    expect(html).toContain('到货照片')
    expect(html).toContain('已确认关联')
    expect(html).toContain('待确认照片')
    expect(html).toContain('184')
    expect(html).toContain('>3<')
    expect(html).toContain('去重后的有效首次凭证')
  })

  it('keeps a non-blocking fallback when statistics fail', async () => {
    const app = createSSRApp(DashboardStats, {
      stats: null,
      loading: false,
      error: '订单统计暂时不可用，不影响拍照收货。',
      online: true,
    })

    const html = await renderToString(app)

    expect(html).toContain('订单统计暂时不可用，不影响拍照收货。')
    expect(html).toContain('重新加载')
    expect(html).toContain('—')
  })

  it('uses unmatched photos when an older response omits candidate photos', async () => {
    const app = createSSRApp(DashboardStats, {
      stats: {
        total_orders: 10,
        arrival_photos: 2,
        matched_orders: 1,
        pending_orders: 9,
        unmatched_photos: 1,
        account_count: 1,
      },
      loading: false,
      error: '',
      online: true,
    })

    const html = await renderToString(app)

    expect(html).toContain('待确认照片')
    expect(html).toContain('>1<')
  })
})
