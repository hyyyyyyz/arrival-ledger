import { computed, ref } from 'vue'

export type AppTab = 'capture' | 'records' | 'orders' | 'people'

export function useAppTabs(onOrdersActivated: () => void) {
  const activeTab = ref<AppTab>('capture')
  const pageTitle = computed(() => {
    if (activeTab.value === 'orders') return '采购订单'
    if (activeTab.value === 'people') return '人员管理'
    return activeTab.value === 'capture' ? '今天收到什么？' : '到货记录'
  })

  function selectTab(tab: AppTab): void {
    activeTab.value = tab
    if (tab === 'orders') onOrdersActivated()
  }

  function reset(): void {
    activeTab.value = 'capture'
  }

  return { activeTab, pageTitle, selectTab, reset }
}
