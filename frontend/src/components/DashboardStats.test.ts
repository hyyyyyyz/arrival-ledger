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
        received_orders: 6,
        review_orders: 2,
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

    expect(html).toContain('总订单')
    expect(html).toContain('未收货')
    expect(html).toContain('已收货')
    expect(html).toContain('待处理')
    expect(html).toContain('184')
    expect(html).toContain('178')
    expect(html).toContain('>6<')
    expect(html).toContain('>3<')
    expect(html).toContain('7 张到货凭证')
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

    expect(html).toContain('待处理')
    expect(html).toContain('>1<')
  })
})
