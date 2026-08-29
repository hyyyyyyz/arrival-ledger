import { ref } from 'vue'
import type { OrderArrivalFilter, OrderListParams, OrderListResponse, OrderPlatformFilter, PurchaseOrder } from '@/types'
import { ApiError, listOrders } from '@/services/api'

interface OrderPageOptions {
  isOnline: () => boolean
  onAuthRequired: () => void
  request?: (params: OrderListParams) => Promise<OrderListResponse>
  pageSize?: number
}

interface OrderFilters {
  query: string
  platform: OrderPlatformFilter
  arrivalStatus: OrderArrivalFilter
}

export function useOrderPage(options: OrderPageOptions) {
  const request = options.request ?? listOrders
  const orders = ref<PurchaseOrder[]>([])
  const total = ref(0)
  const limit = ref(options.pageSize ?? 20)
  const offset = ref(0)
  const query = ref('')
  const platform = ref<OrderPlatformFilter>('')
  const arrivalStatus = ref<OrderArrivalFilter>('')
  const loading = ref(false)
  const error = ref('')
  const lastSyncedAt = ref<string | null>(null)
  const activated = ref(false)
  const loaded = ref(false)
  const invalidated = ref(false)
  let requestVersion = 0
  let invalidationVersion = 0

  function appliedFilters(): OrderFilters {
    return {
      query: query.value,
      platform: platform.value,
      arrivalStatus: arrivalStatus.value,
    }
  }

  async function load(
    nextOffset = offset.value,
    filters: OrderFilters = appliedFilters(),
    applyFilters = false,
  ): Promise<boolean> {
    if (!options.isOnline()) {
      error.value = '当前离线，联网后可查看采购订单。'
      return false
    }

    const activeVersion = ++requestVersion
    const activeInvalidationVersion = invalidationVersion
    loading.value = true
    error.value = ''
    try {
      const response = await request({
        limit: limit.value,
        offset: Math.max(0, nextOffset),
        query: filters.query,
        platform: filters.platform,
        arrival_status: filters.arrivalStatus,
      })
      if (activeVersion !== requestVersion) return false

      if (response.total > 0 && response.offset >= response.total) {
        const lastValidOffset = Math.floor((response.total - 1) / response.limit) * response.limit
        return await load(lastValidOffset, filters, applyFilters)
      }

      orders.value = response.items
      total.value = response.total
      limit.value = response.limit
      offset.value = response.offset
      if (applyFilters) {
        query.value = filters.query
        platform.value = filters.platform
        arrivalStatus.value = filters.arrivalStatus
      }
      lastSyncedAt.value = response.last_synced_at ?? null
      loaded.value = true
      if (activeInvalidationVersion === invalidationVersion) invalidated.value = false
      return true
    } catch (reason) {
      if (activeVersion !== requestVersion) return false
      if (reason instanceof ApiError && reason.status === 401) {
        options.onAuthRequired()
      } else if (reason instanceof ApiError && reason.status === 0) {
        error.value = '网络不可用，订单数据暂时无法刷新。'
      } else {
        error.value = reason instanceof Error ? reason.message : '采购订单加载失败，请稍后重试。'
      }
      return false
    } finally {
      if (activeVersion === requestVersion) loading.value = false
    }
  }

  async function activate(): Promise<void> {
    activated.value = true
    if (!loading.value) await load(loaded.value ? offset.value : 0)
  }

  async function search(
    nextQuery: string,
    nextPlatform: OrderPlatformFilter,
    nextArrivalStatus: OrderArrivalFilter,
  ): Promise<void> {
    await load(
      0,
      {
        query: nextQuery.trim(),
        platform: nextPlatform,
        arrivalStatus: nextArrivalStatus,
      },
      true,
    )
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
    arrivalStatus.value = ''
    loading.value = false
    error.value = ''
    lastSyncedAt.value = null
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
    arrivalStatus,
    loading,
    error,
    lastSyncedAt,
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
