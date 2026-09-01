// @vitest-environment happy-dom

import { renderToString } from '@vue/server-renderer'
import { createSSRApp, nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OrderArrivalFilter, OrderPlatformFilter, PurchaseOrder } from '@/types'
import { ApiError, updateOrderArrivalStatus } from '@/services/api'
import OrderList from './OrderList.vue'

const componentMocks = vi.hoisted(() => ({
  createId: vi.fn(() => 'manual-client-event-stable-0001'),
  updateOrderArrivalStatus: vi.fn(),
}))

vi.mock('@/utils/id', () => ({ createId: componentMocks.createId }))
vi.mock('@/services/api', () => ({
  ApiError: class ApiError extends Error {
    readonly status: number
    readonly details: unknown

    constructor(status: number, message: string, details?: unknown) {
      super(message)
      this.name = 'ApiError'
      this.status = status
      this.details = details
    }
  },
  updateOrderArrivalStatus: componentMocks.updateOrderArrivalStatus,
}))

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

interface OrderListProps extends Record<string, unknown> {
  orders: PurchaseOrder[]
  total: number
  query: string
  platform: OrderPlatformFilter
  arrivalStatus: OrderArrivalFilter
  loading: boolean
  error: string
  lastSyncedAt: string | null
  online: boolean
  hasMore: boolean
}

function props(overrides: Partial<OrderListProps> = {}): OrderListProps {
  return {
    orders: [purchaseOrder()],
    total: 41,
    query: '',
    platform: '',
    arrivalStatus: '',
    loading: false,
    error: '',
    lastSyncedAt: '2026-08-30T01:30:00.000Z',
    online: true,
    hasMore: false,
    ...overrides,
  }
}

describe('OrderList', () => {
  beforeEach(() => {
    componentMocks.createId.mockClear()
    componentMocks.updateOrderArrivalStatus.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
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
    expect(html).toContain('采购账号')
    expect(html).toContain('1688 主账号')
    expect(html).not.toContain('五金供应商')
    expect(html).not.toContain('1688 开放平台同步')
    expect(html).not.toContain('已发货')
    expect(html).not.toContain('9.90')
    expect(html).not.toContain('商品丙')
    expect(html).not.toContain('商品丁')
    expect(html).not.toContain('YT0003')
    expect(html).not.toContain('OTHER0004')
    expect(html).not.toContain('上一页')
    expect(html).not.toContain('下一页')
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
    expect(cancelled).not.toContain('人工标记已收货')

    const cancelledWithEvidence = await renderToString(createSSRApp(OrderList, props({
      orders: [purchaseOrder({
        order_status: 'CANCELLED',
        effective_arrival_status: 'CLOSED',
        packages: [{ courier: '顺丰速运', tracking_no: 'SF-CLOSED', package_status: 'DELIVERED', arrival_status: 'ARRIVED', arrived: true }],
        package_count: 1,
        arrived_package_count: 1,
        arrival_photo_count: 1,
        candidate_package_count: 0,
      })],
    })))
    expect(cancelledWithEvidence).toContain('arrival-closed')
    expect(cancelledWithEvidence).toContain('收货状态：无需收货，订单已取消')
    expect(cancelledWithEvidence).not.toContain('收货状态：已收货')
    expect(cancelledWithEvidence).not.toContain('人工撤销收货')
  })

  it('renders reversible manual corrections with an accountable audit label', async () => {
    const manuallyReceived = await renderToString(createSSRApp(OrderList, props({
      orders: [purchaseOrder({
        effective_arrival_status: 'RECEIVED',
        evidence_arrival_status: 'PENDING',
        arrival_source: 'MANUAL',
        responsible_user: { id: 7, username: 'receiver', display_name: '张三', role: 'RECEIVER' },
        manual_revision: 2,
        changed_at: '2026-08-30T12:00:00Z',
        packages: [{ courier: '顺丰速运', tracking_no: 'SF-PENDING', package_status: 'SHIPPED', arrival_status: 'PENDING', arrived: false }],
        package_count: 1,
        arrived_package_count: 0,
        candidate_package_count: 0,
      })],
    })))

    expect(manuallyReceived).toContain('收货状态：已收货，人工确认')
    expect(manuallyReceived).toContain('人工确认收货 · 张三')
    expect(manuallyReceived).toContain('人工撤销收货')
    expect(manuallyReceived).not.toContain('确认标记为已收货？')

    const manuallyUndone = await renderToString(createSSRApp(OrderList, props({
      orders: [purchaseOrder({
        effective_arrival_status: 'PENDING',
        evidence_arrival_status: 'RECEIVED',
        arrival_source: 'MANUAL',
        responsible_user: { id: 8, username: 'auditor', display_name: '李四', role: 'ADMIN' },
        manual_revision: 4,
        changed_at: '2026-08-30T12:30:00Z',
      })],
    })))

    expect(manuallyUndone).toContain('收货状态：未收货，人工撤销')
    expect(manuallyUndone).toContain('人工撤销收货 · 李四')
    expect(manuallyUndone).toContain('人工标记已收货')
  })

  it('reuses one event id after an uncertain network failure', async () => {
    vi.mocked(updateOrderArrivalStatus)
      .mockRejectedValueOnce(new ApiError(0, '网络不可用'))
      .mockResolvedValueOnce({
        order_id: '91',
        effective_arrival_status: 'RECEIVED',
        evidence_arrival_status: 'PENDING',
        arrival_source: 'MANUAL',
        responsible_user: { id: 1, username: 'admin', display_name: '管理员' },
        manual_revision: 1,
        changed_at: '2026-08-30T12:00:00Z',
        audit_event_id: 1,
        idempotent_replay: false,
      })
    const wrapper = mount(OrderList, { props: props({
      orders: [purchaseOrder({
        effective_arrival_status: 'PENDING',
        evidence_arrival_status: 'PENDING',
        arrival_source: 'AUTO',
        manual_revision: 0,
      })],
    }) })

    await wrapper.get('.manual-correction-button').trigger('click')
    await nextTick()
    await wrapper.get('.confirmation-dialog .confirm').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('网络不可用')
    expect(wrapper.find('.confirmation-dialog').exists()).toBe(true)

    await wrapper.get('.confirmation-dialog .confirm').trigger('click')
    await flushPromises()
    expect(vi.mocked(updateOrderArrivalStatus).mock.calls).toEqual([
      ['91', 'RECEIVED', 0, 'manual-client-event-stable-0001'],
      ['91', 'RECEIVED', 0, 'manual-client-event-stable-0001'],
    ])
    expect(wrapper.emitted('manualChanged')).toHaveLength(1)
  })

  it('closes the correction and requests re-authentication on 401', async () => {
    vi.mocked(updateOrderArrivalStatus).mockRejectedValueOnce(
      new ApiError(401, '登录已过期'),
    )
    const wrapper = mount(OrderList, { props: props() })

    await wrapper.get('.manual-correction-button').trigger('click')
    await nextTick()
    await wrapper.get('.confirmation-dialog .confirm').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('authRequired')).toHaveLength(1)
    expect(wrapper.find('.confirmation-dialog').exists()).toBe(false)
  })

  it('refreshes instead of overwriting a concurrent correction on 409', async () => {
    vi.mocked(updateOrderArrivalStatus).mockRejectedValueOnce(
      new ApiError(409, 'arrival status changed concurrently'),
    )
    const wrapper = mount(OrderList, { props: props() })

    await wrapper.get('.manual-correction-button').trigger('click')
    await nextTick()
    await wrapper.get('.confirmation-dialog .confirm').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('refresh')).toHaveLength(1)
    expect(wrapper.find('.confirmation-dialog').exists()).toBe(false)
    expect(wrapper.text()).toContain('订单状态已被其他人修改')
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

    const thirdParty = await renderToString(createSSRApp(OrderList, props({
      platform: 'other',
      lastSyncedAt: null,
      orders: [purchaseOrder({ platform: 'other', source: 'THIRD_PARTY_MANUAL' })],
    })))
    expect(thirdParty).toContain('第三方订单由人工录入')
    expect(thirdParty).not.toContain('有采购账号尚无成功同步记录')
    expect(thirdParty).not.toContain('可能不是最新')
  })

  it('renders a manual third-party parcel by tracking number without exposing its synthetic id', async () => {
    const html = await renderToString(createSSRApp(OrderList, props({
      platform: 'other',
      lastSyncedAt: null,
      orders: [purchaseOrder({
        platform: 'other',
        account_label: '第三方/其他渠道',
        platform_order_id: 'manual-secret-internal-hash',
        source: 'THIRD_PARTY_MANUAL',
        items: [{ title: '甲方线下采购样品', sku_text: null, quantity: '1', unit_price: null }],
        packages: [{ courier: '邮政 EMS', tracking_no: '9818907591847', package_status: 'MANUAL', arrival_status: 'PENDING', arrived: false }],
        package_count: 1,
        arrived_package_count: 0,
        candidate_package_count: 0,
        manual_created_by: { id: 1, username: 'admin', display_name: '仓库管理员', role: 'ADMIN', is_active: true },
        manual_created_at: '2026-09-01T08:00:00+08:00',
        manual_remark: '甲方临时交办',
      })],
    })))

    expect(html).toContain('第三方')
    expect(html).toContain('运单号')
    expect(html).toContain('9818907591847')
    expect(html).not.toContain('manual-secret-internal-hash')
    expect(html).toContain('来源')
    expect(html).toContain('第三方/其他渠道')
    expect(html).toContain('录入人')
    expect(html).toContain('仓库管理员')
    expect(html).toContain('甲方临时交办')
  })

  it('renders infinite-scroll loading, fallback, and completed states', async () => {
    const loading = await renderToString(createSSRApp(OrderList, props({ hasMore: true, loading: true })))
    expect(loading).toContain('正在加载订单')
    expect(loading).toContain('正在加载…')

    const more = await renderToString(createSSRApp(OrderList, props({ hasMore: true })))
    expect(more).toContain('已显示 1 / 41 条')
    expect(more).toContain('加载更多订单')
    expect(more).not.toContain('上一页')
    expect(more).not.toContain('下一页')

    const complete = await renderToString(createSSRApp(OrderList, props({ total: 1, hasMore: false })))
    expect(complete).toContain('已显示 1 条订单')

    const failed = await renderToString(createSSRApp(OrderList, props({ hasMore: true, error: '网络失败' })))
    expect(failed).toContain('重试加载更多')
  })

  it('keeps an accessible fallback button for loading the next batch', async () => {
    const wrapper = mount(OrderList, { props: props({ hasMore: true }) })
    await wrapper.get('.orders-load-more').trigger('click')
    expect(wrapper.emitted('loadMore')).toHaveLength(1)
  })

  it('loads automatically near the sentinel and disconnects when complete', async () => {
    let callback: IntersectionObserverCallback | undefined
    const observe = vi.fn()
    const disconnect = vi.fn()
    class MockIntersectionObserver {
      readonly root = null
      readonly rootMargin = '240px 0px'
      readonly thresholds = [0]
      constructor(nextCallback: IntersectionObserverCallback) { callback = nextCallback }
      observe = observe
      disconnect = disconnect
      unobserve = vi.fn()
      takeRecords = vi.fn(() => [])
    }
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)

    const wrapper = mount(OrderList, { props: props({ hasMore: true }) })
    await nextTick()
    expect(observe).toHaveBeenCalledTimes(1)

    callback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    await nextTick()
    expect(wrapper.emitted('loadMore')).toHaveLength(1)

    await wrapper.setProps({ loading: true })
    callback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    expect(wrapper.emitted('loadMore')).toHaveLength(1)

    await wrapper.setProps({ loading: false, hasMore: false })
    await nextTick()
    expect(disconnect).toHaveBeenCalled()
    wrapper.unmount()
  })
})
