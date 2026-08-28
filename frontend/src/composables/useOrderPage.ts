import { ref } from 'vue'
import type { OrderListParams, OrderListResponse, OrderPlatformFilter, PurchaseOrder } from '@/types'
import { ApiError, listOrders } from '@/services/api'

interface OrderPageOptions {
  isOnline: () => boolean
  onAuthRequired: () => void
  request?: (params: OrderListParams) => Promise<OrderListResponse>
  pageSize?: number
}

export function useOrderPage(options: OrderPageOptions) {
  const request = options.request ?? listOrders
  const orders = ref<PurchaseOrder[]>([])
  const total = ref(0)
  const limit = ref(options.pageSize ?? 20)
  const offset = ref(0)
  const query = ref('')
  const platform = ref<OrderPlatformFilter>('')
  const loading = ref(false)
  const error = ref('')
  const activated = ref(false)
  const loaded = ref(false)
  const invalidated = ref(false)
  let requestVersion = 0
  let invalidationVersion = 0

  async function load(nextOffset = offset.value): Promise<void> {
    if (!options.isOnline()) {
      error.value = '当前离线，联网后可查看采购订单。'
      return
    }

    const activeVersion = ++requestVersion
    const activeInvalidationVersion = invalidationVersion
    loading.value = true
    error.value = ''
    try {
      const response = await request({
        limit: limit.value,
        offset: Math.max(0, nextOffset),
        query: query.value,
        platform: platform.value,
      })
      if (activeVersion !== requestVersion) return

      orders.value = response.items
      total.value = response.total
      limit.value = response.limit
      offset.value = response.offset
      loaded.value = true
      if (activeInvalidationVersion === invalidationVersion) invalidated.value = false
    } catch (reason) {
      if (activeVersion !== requestVersion) return
      if (reason instanceof ApiError && reason.status === 401) {
        options.onAuthRequired()
      } else if (reason instanceof ApiError && reason.status === 0) {
        error.value = '网络不可用，订单数据暂时无法刷新。'
      } else {
        error.value = reason instanceof Error ? reason.message : '采购订单加载失败，请稍后重试。'
      }
    } finally {
      if (activeVersion === requestVersion) loading.value = false
    }
  }

  async function activate(): Promise<void> {
    activated.value = true
    if (!loading.value) await load(loaded.value ? offset.value : 0)
  }

  async function search(nextQuery: string, nextPlatform: OrderPlatformFilter): Promise<void> {
    query.value = nextQuery.trim()
    platform.value = nextPlatform
    await load(0)
  }

  async function goToPage(nextOffset: number): Promise<void> {
    const lastOffset = total.value > 0 ? Math.floor((total.value - 1) / limit.value) * limit.value : 0
    const targetOffset = Math.min(Math.max(0, nextOffset), lastOffset)
    if (targetOffset === offset.value) return
    await load(targetOffset)
  }

  async function refresh(): Promise<void> {
    await load(offset.value)
  }

  function invalidate(): void {
    invalidationVersion += 1
    invalidated.value = true
  }

  function reset(): void {
    requestVersion += 1
    invalidationVersion += 1
    orders.value = []
    total.value = 0
    limit.value = options.pageSize ?? 20
    offset.value = 0
    query.value = ''
    platform.value = ''
    loading.value = false
    error.value = ''
    activated.value = false
    loaded.value = false
    invalidated.value = false
  }

  return {
    orders,
    total,
    limit,
    offset,
    query,
    platform,
    loading,
    error,
    activated,
    loaded,
    invalidated,
    activate,
    search,
    goToPage,
    refresh,
    invalidate,
    reset,
  }
}
