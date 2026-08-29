<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { OrderPlatformFilter, PurchaseOrder } from '@/types'

const props = defineProps<{
  orders: PurchaseOrder[]
  total: number
  limit: number
  offset: number
  query: string
  platform: OrderPlatformFilter
  loading: boolean
  error: string
  online: boolean
}>()

const emit = defineEmits<{
  search: [query: string, platform: OrderPlatformFilter]
  refresh: []
  page: [offset: number]
}>()

const draftQuery = ref(props.query)
const draftPlatform = ref<OrderPlatformFilter>(props.platform)
const expandedOrders = ref<Set<string>>(new Set())

watch(() => props.query, (value) => { draftQuery.value = value })
watch(() => props.platform, (value) => { draftPlatform.value = value })

const firstResult = computed(() => props.total > 0 ? props.offset + 1 : 0)
const lastResult = computed(() => Math.min(props.offset + props.orders.length, props.total))
const hasPrevious = computed(() => props.offset > 0)
const hasNext = computed(() => props.offset + props.limit < props.total)

type ArrivalTone = 'pending' | 'candidate' | 'partial' | 'received' | 'closed'

interface ArrivalSummary {
  tone: ArrivalTone
  icon: string
  label: string
  detail: string
}

function platformLabel(platform: PurchaseOrder['platform']): string {
  return platform === '1688' ? '1688' : '拼多多'
}

function visibleItems(order: PurchaseOrder) {
  return expandedOrders.value.has(order.id) ? order.items : order.items.slice(0, 2)
}

function visiblePackages(order: PurchaseOrder) {
  return expandedOrders.value.has(order.id) ? order.packages : order.packages.slice(0, 2)
}

function toggleExpanded(orderId: string): void {
  const next = new Set(expandedOrders.value)
  if (next.has(orderId)) next.delete(orderId)
  else next.add(orderId)
  expandedOrders.value = next
}

function hasHiddenDetails(order: PurchaseOrder): boolean {
  return order.items.length > 2 || order.packages.length > 2
}

function hiddenDetailsLabel(order: PurchaseOrder): string {
  if (expandedOrders.value.has(order.id)) return '收起其余内容'
  const parts: string[] = []
  if (order.items.length > 2) parts.push(`${order.items.length - 2} 项商品`)
  if (order.packages.length > 2) parts.push(`${order.packages.length - 2} 个包裹`)
  return `展开其余 ${parts.join('、')}`
}

function arrivalSummary(order: PurchaseOrder): ArrivalSummary {
  const total = order.package_count
  const arrived = order.arrived_package_count
  if (total > 0 && arrived >= total) {
    return { tone: 'received', icon: '✓', label: '已收货', detail: `${arrived}/${total} 个包裹` }
  }
  if (arrived > 0) {
    const candidateDetail = order.candidate_package_count > 0
      ? ` · ${order.candidate_package_count} 待确认`
      : ''
    return {
      tone: 'partial',
      icon: '◐',
      label: '部分收货',
      detail: total > 0
        ? `${arrived}/${total} 个包裹${candidateDetail}`
        : `${arrived} 个包裹${candidateDetail}`,
    }
  }
  if (order.candidate_package_count > 0) {
    return {
      tone: 'candidate',
      icon: '?',
      label: '待确认',
      detail: `${order.candidate_package_count} 个包裹照片待确认`,
    }
  }
  const normalizedOrderStatus = order.order_status.trim().toUpperCase()
  if (normalizedOrderStatus === 'CANCELLED' || normalizedOrderStatus === 'REFUNDED') {
    return {
      tone: 'closed',
      icon: '—',
      label: '无需收货',
      detail: normalizedOrderStatus === 'CANCELLED' ? '订单已取消' : '退款或售后',
    }
  }
  return {
    tone: 'pending',
    icon: '!',
    label: '未收货',
    detail: total > 0 ? `0/${total} 个包裹` : '物流待同步',
  }
}

function packageArrivalLabel(orderPackage: PurchaseOrder['packages'][number]): string {
  if (orderPackage.arrival_status === 'ARRIVED') return '已收货'
  if (orderPackage.arrival_status === 'CANDIDATE') return '待确认'
  return '未收货'
}

function packageArrivalTone(orderPackage: PurchaseOrder['packages'][number]): string {
  return orderPackage.arrival_status.toLowerCase()
}

function submitSearch(): void {
  emit('search', draftQuery.value.trim(), draftPlatform.value)
}

function applyPlatform(platform: OrderPlatformFilter): void {
  draftPlatform.value = platform
  emit('search', draftQuery.value.trim(), platform)
}
</script>

<template>
  <section class="orders-page" aria-labelledby="orders-list-title">
    <div class="order-filters">
      <form class="order-search" role="search" @submit.prevent="submitSearch">
        <label class="visually-hidden" for="order-search-input">搜索采购订单</label>
        <input
          id="order-search-input"
          v-model="draftQuery"
          type="search"
          maxlength="128"
          autocomplete="off"
          enterkeyhint="search"
          placeholder="搜索订单号、商品、店铺或物流"
        />
        <button type="submit" :disabled="loading || !online">搜索</button>
      </form>

      <div class="platform-filters" role="group" aria-label="采购平台筛选">
        <button type="button" :class="{ active: draftPlatform === '' }" :aria-pressed="draftPlatform === ''" :disabled="loading || !online" @click="applyPlatform('')">
          全部
        </button>
        <button type="button" :class="{ active: draftPlatform === '1688' }" :aria-pressed="draftPlatform === '1688'" :disabled="loading || !online" @click="applyPlatform('1688')">
          1688
        </button>
        <button type="button" :class="{ active: draftPlatform === 'pdd' }" :aria-pressed="draftPlatform === 'pdd'" :disabled="loading || !online" @click="applyPlatform('pdd')">
          拼多多
        </button>
      </div>
      <p class="orders-source-note">仅查询到货管家后端中的已同步订单，不会打开采购平台。</p>
    </div>

    <div class="orders-title-row">
      <div>
        <p class="eyebrow">采购明细</p>
        <h2 id="orders-list-title">订单列表</h2>
      </div>
      <button class="text-button" type="button" :disabled="loading || !online" @click="emit('refresh')">
        {{ loading && orders.length ? '刷新中…' : '刷新' }}
      </button>
    </div>

    <div v-if="error" class="orders-message orders-error" role="status">
      <span>{{ error }}</span>
      <button v-if="online" type="button" @click="emit('refresh')">重试</button>
    </div>
    <p v-else-if="!online" class="orders-message" role="status">当前离线，已显示的数据可能不是最新。</p>

    <div v-if="loading && !orders.length" class="orders-loading" role="status">
      <span class="spinner" aria-hidden="true"></span>
      <p>正在加载采购订单…</p>
    </div>

    <div v-else-if="orders.length" class="orders-list">
      <article
        v-for="order in orders"
        :key="order.id"
        class="purchase-order-card"
        :class="`arrival-${arrivalSummary(order).tone}`"
        :aria-labelledby="`order-${order.id}-number`"
      >
        <header class="compact-order-header">
          <div class="compact-order-identity">
            <div>
              <span class="compact-order-label">订单号</span>
              <span class="platform-badge" :class="`platform-${order.platform}`">{{ platformLabel(order.platform) }}</span>
            </div>
            <strong :id="`order-${order.id}-number`" class="purchase-order-number">{{ order.platform_order_id }}</strong>
          </div>
          <div
            class="order-arrival-state"
            :class="`state-${arrivalSummary(order).tone}`"
            :aria-label="`收货状态：${arrivalSummary(order).label}，${arrivalSummary(order).detail}`"
          >
            <span aria-hidden="true">{{ arrivalSummary(order).icon }}</span>
            <div>
              <strong>{{ arrivalSummary(order).label }}</strong>
              <small>{{ arrivalSummary(order).detail }}</small>
            </div>
          </div>
        </header>

        <section class="compact-order-section" aria-label="商品">
          <h3>商品</h3>
          <div v-if="order.items.length" class="compact-order-rows">
            <div v-for="(item, index) in visibleItems(order)" :key="`${item.title}-${item.sku_text || ''}-${index}`" class="compact-product-row">
              <p>
                <strong>{{ item.title }}</strong>
                <small v-if="item.sku_text">{{ item.sku_text }}</small>
              </p>
              <span>×{{ item.quantity }}</span>
            </div>
          </div>
          <p v-else class="order-section-empty">商品明细待同步</p>
        </section>

        <section class="compact-order-section" aria-label="物流">
          <h3>物流</h3>
          <div v-if="order.packages.length" class="compact-order-rows">
            <div v-for="(orderPackage, index) in visiblePackages(order)" :key="`${orderPackage.tracking_no}-${index}`" class="compact-logistics-row">
              <p>
                <strong>{{ orderPackage.courier || '物流公司待同步' }}</strong>
                <small>{{ orderPackage.tracking_no || '运单号待同步' }}</small>
              </p>
              <span class="package-arrival-state" :class="`package-${packageArrivalTone(orderPackage)}`">
                {{ packageArrivalLabel(orderPackage) }}
              </span>
            </div>
          </div>
          <p v-else class="order-section-empty">暂无物流信息</p>
        </section>

        <button
          v-if="hasHiddenDetails(order)"
          class="compact-order-toggle"
          type="button"
          :aria-expanded="expandedOrders.has(order.id)"
          @click="toggleExpanded(order.id)"
        >
          {{ hiddenDetailsLabel(order) }}
        </button>
      </article>
    </div>

    <div v-else-if="!error" class="empty-state orders-empty">
      <span aria-hidden="true">▤</span>
      <p>{{ query || platform ? '没有符合当前搜索条件的采购订单。' : '还没有导入采购订单。' }}</p>
    </div>

    <footer v-if="total > 0" class="orders-pagination" aria-label="订单分页">
      <p>第 {{ firstResult }}–{{ lastResult }} 条，共 {{ total }} 条</p>
      <div>
        <button type="button" :disabled="loading || !hasPrevious" @click="emit('page', offset - limit)">上一页</button>
        <button type="button" :disabled="loading || !hasNext" @click="emit('page', offset + limit)">下一页</button>
      </div>
    </footer>
  </section>
</template>
