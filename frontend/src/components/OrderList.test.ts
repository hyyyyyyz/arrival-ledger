import { renderToString } from '@vue/server-renderer'
import { createSSRApp } from 'vue'
import { describe, expect, it } from 'vitest'

import type { PurchaseOrder } from '@/types'
import OrderList from './OrderList.vue'

function purchaseOrder(): PurchaseOrder {
  return {
    id: '91',
    platform: '1688',
    account_label: '1688 主账号',
    platform_order_id: 'ORDER-20260828-001',
    ordered_at: '2026-08-28T10:30:00+08:00',
    order_status: 'SHIPPED',
    shop_name: '五金供应商',
    source: 'ALI1688_API',
    items: [
      { title: '商品甲', sku_text: '红色', quantity: '2', unit_price: '9.90' },
      { title: '商品乙', sku_text: null, quantity: '1', unit_price: null },
      { title: '商品丙', sku_text: '大号', quantity: '3', unit_price: '12.00' },
      { title: '商品丁', sku_text: null, quantity: '4', unit_price: null },
    ],
    packages: [
      { courier: '顺丰速运', tracking_no: 'SF0001', package_status: 'DELIVERED', arrival_status: 'ARRIVED', arrived: true },
      { courier: '中通快递', tracking_no: 'ZT0002', package_status: 'SHIPPED', arrival_status: 'CANDIDATE', arrived: false },
      { courier: '圆通快递', tracking_no: 'YT0003', package_status: 'SHIPPED', arrival_status: 'PENDING', arrived: false },
      { courier: null, tracking_no: 'OTHER0004', package_status: null, arrival_status: 'PENDING', arrived: false },
    ],
    package_count: 4,
    arrived_package_count: 1,
    arrival_photo_count: 1,
    candidate_package_count: 1,
    candidate_photo_count: 1,
  }
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    orders: [purchaseOrder()],
    total: 41,
    limit: 20,
    offset: 0,
    query: '',
    platform: '',
    loading: false,
    error: '',
    online: true,
    ...overrides,
  }
}

describe('OrderList', () => {
  it('renders account, friendly status, items, logistics, and confirmed/candidate progress', async () => {
    const html = await renderToString(createSSRApp(OrderList, props()))

    expect(html).toContain('ORDER-20260828-001')
    expect(html).toContain('账号：1688 主账号')
    expect(html).toContain('已发货')
    expect(html).toContain('1688 开放平台同步')
    expect(html).toContain('商品甲')
    expect(html).toContain('红色')
    expect(html).toContain('SF0001')
    expect(html).toContain('照片待确认')
    expect(html).toContain('1/4 个包裹')
    expect(html).toContain('确认前不计入已到货')
    expect(html).toContain('查看全部 4 项商品')
    expect(html).toContain('查看全部 4 个包裹')
    expect(html).not.toContain('商品丁')
    expect(html).toMatch(/<button[^>]*disabled[^>]*>上一页<\/button>/)
    expect(html).toMatch(/<button[^>]*>下一页<\/button>/)
  })

  it('renders loading, failure, and filtered empty states', async () => {
    const loading = await renderToString(createSSRApp(OrderList, props({ orders: [], total: 0, loading: true })))
    const failure = await renderToString(createSSRApp(OrderList, props({ orders: [], total: 0, error: '订单服务暂时不可用' })))
    const empty = await renderToString(createSSRApp(OrderList, props({ orders: [], total: 0, query: '螺丝' })))

    expect(loading).toContain('正在加载采购订单')
    expect(failure).toContain('订单服务暂时不可用')
    expect(failure).toContain('重试')
    expect(empty).toContain('没有符合当前搜索条件的采购订单')
  })
})
