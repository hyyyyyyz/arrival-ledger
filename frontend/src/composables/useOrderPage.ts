import { ref } from 'vue'
import type { OrderAccountOption, OrderArrivalFilter, OrderListParams, OrderListResponse, OrderPlatformFilter, PurchaseOrder } from '@/types'
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
  accountId: string
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
  const accountId = ref('')
  const accountOptions = ref<OrderAccountOption[]>([])
  const loading = ref(false)
  const error = ref('')
  const lastSyncedAt = ref<string | null>(null)
  const activated = ref(false)
  const loaded = ref(false)
  const hasMore = ref(false)
  const invalidated = ref(false)
  let requestVersion = 0
  let invalidationVersion = 0

  function appliedFilters(): OrderFilters {
    return {
      query: query.value,
      platform: platform.value,
      arrivalStatus: arrivalStatus.value,
      accountId: accountId.value,
    }
  }

  async function load(
    nextOffset = 0,
    filters: OrderFilters = appliedFilters(),
    append = false,
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
        account_id: filters.accountId || undefined,
      })
      if (activeVersion !== requestVersion) return false

      // OFFSET pages are separate database snapshots. If synchronization or
      // another operator changed the matching set while the user was
      // scrolling, restarting from the first batch avoids silently skipping
      // an order at the shifted page boundary.
      if (append && response.total !== total.value) {
        return await load(0, filters)
      }

      if (append) {
        const known = new Set(orders.value.map((order) => order.id))
        for (const order of response.items) {
          if (known.has(order.id)) continue
          known.add(order.id)
          orders.value.push(order)
        }
      } else {
        orders.value = response.items
      }
      total.value = response.total
      limit.value = response.limit
      offset.value = response.offset + response.items.length
      hasMore.value = response.items.length > 0 && offset.value < response.total
      if (applyFilters) {
        query.value = filters.query
        platform.value = filters.platform
        arrivalStatus.value = filters.arrivalStatus
        accountId.value = filters.accountId
      }
      lastSyncedAt.value = response.last_synced_at ?? null
      if (response.account_options) accountOptions.value = response.account_options
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
    if (!loading.value) await load(0)
  }

  async function search(
    nextQuery: string,
    nextPlatform: OrderPlatformFilter,
    nextArrivalStatus: OrderArrivalFilter,
    nextAccountId = '',
  ): Promise<void> {
    const filters = {
      query: nextQuery.trim(),
      platform: nextPlatform,
      arrivalStatus: nextArrivalStatus,
      accountId: nextAccountId,
    }
    // Keep the currently applied query and results until the new request
    // succeeds. The generation token invalidates any in-flight append, so a
    // response from the old filter can never be mixed into the new set.
    await load(0, filters, false, true)
  }

  async function loadMore(): Promise<boolean> {
    if (loading.value || !hasMore.value) return false
    return load(offset.value, appliedFilters(), true)
  }

  async function refresh(): Promise<void> {
    await load(0, appliedFilters())
  }

  function invalidate(): void {
    invalidationVersion += 1
    invalidated.value = true
  }

  function replaceOrder(updated: PurchaseOrder): void {
    const index = orders.value.findIndex((order) => order.id === updated.id)
    if (index >= 0) orders.value.splice(index, 1, updated)
    invalidate()
  }

  function reset(): void {
    requestVersion += 1
    invalidationVersion += 1
    orders.value = []
    total.value = 0
    limit.value = options.pageSize ?? 20
    offset.value = 0
    hasMore.value = false
    query.value = ''
    platform.value = ''
    arrivalStatus.value = ''
    accountId.value = ''
    accountOptions.value = []
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
    accountId,
    accountOptions,
    hasMore,
    loading,
    error,
    lastSyncedAt,
    activated,
    loaded,
    invalidated,
    activate,
    search,
    loadMore,
    refresh,
    invalidate,
    replaceOrder,
    reset,
  }
}
