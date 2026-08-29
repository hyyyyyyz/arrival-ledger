import { renderToString } from '@vue/server-renderer'
import { createSSRApp } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PurchaseOrder } from '@/types'
import OrderList from './OrderList.vue'

function purchaseOrder(overrides: Partial<PurchaseOrder> = {}): PurchaseOrder {
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
    ...overrides,
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
    arrivalStatus: '',
    loading: false,
    error: '',
    lastSyncedAt: '2026-08-30T01:30:00.000Z',
    online: true,
    ...overrides,
  }
}

describe('OrderList', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders a compact order, product, logistics, and warehouse arrival summary', async () => {
    const html = await renderToString(createSSRApp(OrderList, props()))

    expect(html).toContain('ORDER-20260828-001')
    expect(html).toContain('商品甲')
    expect(html).not.toContain('红色')
    expect(html).toContain('×2')
    expect(html).not.toContain('商品乙')
    expect(html).toContain('SF0001')
    expect(html).toContain('顺丰速运')
    expect(html).not.toContain('ZT0002')
    expect(html).toContain('部分收货')
    expect(html).toContain('1/4 个包裹')
    expect(html).toContain('已收货')
    expect(html).toContain('待确认')
    expect(html).toContain('展开其余 3 项商品、3 个包裹')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('账号：1688 主账号')
    expect(html).not.toContain('五金供应商')
    expect(html).not.toContain('1688 开放平台同步')
    expect(html).not.toContain('已发货')
    expect(html).not.toContain('9.90')
    expect(html).not.toContain('商品丙')
    expect(html).not.toContain('商品丁')
    expect(html).not.toContain('YT0003')
    expect(html).not.toContain('OTHER0004')
    expect(html).toMatch(/<button[^>]*disabled[^>]*>上一页<\/button>/)
    expect(html).toMatch(/<button[^>]*>下一页<\/button>/)
  })

  it('derives red, orange, and green receipt states only from confirmed warehouse arrivals', async () => {
    const pending = await renderToString(createSSRApp(OrderList, props({
      orders: [purchaseOrder({
        order_status: 'COMPLETED',
        packages: [
          { courier: '顺丰速运', tracking_no: 'SF-PENDING-1', package_status: 'DELIVERED', arrival_status: 'PENDING', arrived: false },
          { courier: '顺丰速运', tracking_no: 'SF-PENDING-2', package_status: 'DELIVERED', arrival_status: 'PENDING', arrived: false },
        ],
        package_count: 2,
        arrived_package_count: 0,
        candidate_package_count: 0,
      })],
    })))
    expect(pending).toContain('arrival-pending')
    expect(pending).toContain('收货状态：未收货，0/2 个包裹')
    expect(pending).not.toContain('arrival-received')

    const partial = await renderToString(createSSRApp(OrderList, props({
      orders: [purchaseOrder({ package_count: 2, arrived_package_count: 1, candidate_package_count: 0 })],
    })))
    expect(partial).toContain('arrival-partial')
    expect(partial).toContain('收货状态：部分收货，1/2 个包裹')

    const partialWithCandidate = await renderToString(createSSRApp(OrderList, props({
      orders: [purchaseOrder({ package_count: 4, arrived_package_count: 1, candidate_package_count: 2 })],
    })))
    expect(partialWithCandidate).toContain('收货状态：部分收货，1/4 个包裹 · 2 待确认')

    const received = await renderToString(createSSRApp(OrderList, props({
      orders: [purchaseOrder({ package_count: 2, arrived_package_count: 2, candidate_package_count: 0 })],
    })))
    expect(received).toContain('arrival-received')
    expect(received).toContain('收货状态：已收货，2/2 个包裹')

    const candidate = await renderToString(createSSRApp(OrderList, props({
      orders: [purchaseOrder({ package_count: 1, arrived_package_count: 0, candidate_package_count: 1 })],
    })))
    expect(candidate).toContain('arrival-candidate')
    expect(candidate).toContain('收货状态：待确认，1 个包裹照片待确认')
    expect(candidate).not.toContain('arrival-received')

    const cancelled = await renderToString(createSSRApp(OrderList, props({
      orders: [purchaseOrder({
        order_status: 'CANCELLED',
        package_count: 0,
        arrived_package_count: 0,
        candidate_package_count: 0,
        packages: [],
      })],
    })))
    expect(cancelled).toContain('arrival-closed')
    expect(cancelled).toContain('收货状态：无需收货，订单已取消')
    expect(cancelled).not.toContain('arrival-pending')
  })

  it('keeps missing product and logistics data compact and explicit', async () => {
    const emptyDetails = await renderToString(createSSRApp(OrderList, props({
      orders: [purchaseOrder({
        items: [],
        packages: [],
        package_count: 0,
        arrived_package_count: 0,
        candidate_package_count: 0,
      })],
    })))
    expect(emptyDetails).toContain('商品明细待同步')
    expect(emptyDetails).toContain('暂无物流信息')
    expect(emptyDetails).toContain('收货状态：未收货，物流待同步')

    const missingCourier = await renderToString(createSSRApp(OrderList, props({
      orders: [purchaseOrder({
        packages: [{ courier: null, tracking_no: 'TRACKING-001', package_status: null, arrival_status: 'PENDING', arrived: false }],
        package_count: 1,
        arrived_package_count: 0,
        candidate_package_count: 0,
      })],
    })))
    expect(missingCourier).toContain('物流公司待同步')
    expect(missingCourier).toContain('TRACKING-001')
  })

  it('renders loading, failure, and filtered empty states', async () => {
    const loading = await renderToString(createSSRApp(OrderList, props({ orders: [], total: 0, loading: true })))
    const failure = await renderToString(createSSRApp(OrderList, props({ orders: [], total: 0, error: '订单服务暂时不可用' })))
    const empty = await renderToString(createSSRApp(OrderList, props({ orders: [], total: 0, query: '螺丝' })))

    expect(loading).toContain('正在加载采购订单')
    expect(failure).toContain('订单服务暂时不可用')
    expect(failure).toContain('重试')
    expect(empty).toContain('没有符合当前筛选条件的采购订单')
  })

  it('labels the oldest account sync and warns when it is stale or missing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T02:00:00.000Z'))
    const fresh = await renderToString(createSSRApp(OrderList, props()))
    expect(fresh).toContain('全部账号至少同步至')
    expect(fresh).not.toContain('可能不是最新')

    vi.setSystemTime(new Date('2026-08-30T03:00:00.000Z'))
    const stale = await renderToString(createSSRApp(OrderList, props()))
    expect(stale).toContain('可能不是最新')

    const missing = await renderToString(createSSRApp(OrderList, props({ lastSyncedAt: null })))
    expect(missing).toContain('有采购账号尚无成功同步记录')
  })

  it('renders first, middle, and last page boundaries', async () => {
    const orders = Array.from({ length: 20 }, (_, index) => purchaseOrder({ id: String(index + 1) }))
    const first = await renderToString(createSSRApp(OrderList, props({ orders, total: 41, offset: 0 })))
    const middle = await renderToString(createSSRApp(OrderList, props({ orders, total: 41, offset: 20 })))
    const last = await renderToString(createSSRApp(OrderList, props({ orders: [purchaseOrder({ id: '41' })], total: 41, offset: 40 })))
    const none = await renderToString(createSSRApp(OrderList, props({ orders: [], total: 0 })))

    expect(first).toContain('第 1–20 条，共 41 条')
    expect(first).toMatch(/<button[^>]*disabled[^>]*>上一页<\/button>/)
    expect(middle).toContain('第 21–40 条，共 41 条')
    expect(middle).not.toMatch(/<button[^>]*disabled[^>]*>上一页<\/button>/)
    expect(last).toContain('第 41–41 条，共 41 条')
    expect(last).toMatch(/<button[^>]*disabled[^>]*>下一页<\/button>/)
    expect(none).not.toContain('aria-label="订单分页"')
  })
})
