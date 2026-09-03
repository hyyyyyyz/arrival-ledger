import { describe, expect, it, vi } from 'vitest'

import { useAppTabs } from '@/composables/useAppTabs'

describe('App order-tab behavior', () => {
  it('activates order loading only when the order tab is selected', () => {
    const activateOrders = vi.fn()
    const tabs = useAppTabs(activateOrders)

    expect(tabs.activeTab.value).toBe('capture')
    expect(tabs.pageTitle.value).toBe('今天收到什么？')
    expect(activateOrders).not.toHaveBeenCalled()

    tabs.selectTab('records')
    expect(activateOrders).not.toHaveBeenCalled()

    tabs.selectTab('orders')
    expect(tabs.pageTitle.value).toBe('采购订单')
    expect(activateOrders).toHaveBeenCalledTimes(1)

    tabs.selectTab('people')
    expect(tabs.pageTitle.value).toBe('后台管理')
    expect(activateOrders).toHaveBeenCalledTimes(1)

    tabs.reset()
    expect(tabs.activeTab.value).toBe('capture')
  })
})
