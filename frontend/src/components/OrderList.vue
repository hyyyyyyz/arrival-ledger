<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { OrderPlatformFilter, PurchaseOrder } from '@/types'
import { formatDateTime } from '@/utils/format'

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
const expandedItems = ref<Set<string>>(new Set())
const expandedPackages = ref<Set<string>>(new Set())

watch(() => props.query, (value) => { draftQuery.value = value })
watch(() => props.platform, (value) => { draftPlatform.value = value })

const firstResult = computed(() => props.total > 0 ? props.offset + 1 : 0)
const lastResult = computed(() => Math.min(props.offset + props.orders.length, props.total))
const hasPrevious = computed(() => props.offset > 0)
const hasNext = computed(() => props.offset + props.limit < props.total)

const orderStatusLabels: Record<string, string> = {
  PENDING: '待付款',
  PAID: '待发货',
  SHIPPED: '已发货',
  COMPLETED: '已完成',
  REFUNDED: '退款或售后',
  CANCELLED: '已取消',
  UNKNOWN: '状态待确认',
}

const packageStatusLabels: Record<string, string> = {
  PENDING: '待揽收',
  PAID: '待发货',
  SHIPPED: '运输中',
  IN_TRANSIT: '运输中',
  DELIVERED: '已签收',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
}

function platformLabel(platform: PurchaseOrder['platform']): string {
  return platform === '1688' ? '1688' : '拼多多'
}

function orderStatusLabel(status: string): string {
  const normalized = status.trim().toUpperCase()
  return orderStatusLabels[normalized] || status || '状态待确认'
}

function orderStatusClass(status: string): string {
  const normalized = status.trim().toUpperCase()
  if (normalized === 'COMPLETED') return 'complete'
  if (normalized === 'CANCELLED' || normalized === 'REFUNDED') return 'closed'
  if (normalized === 'SHIPPED') return 'shipped'
  return 'pending'
}

function packageStatusLabel(orderPackage: PurchaseOrder['packages'][number]): string {
  if (orderPackage.arrival_status === 'ARRIVED') return '已到货'
  if (orderPackage.arrival_status === 'CANDIDATE') return '照片待确认'
  const status = orderPackage.package_status
  if (!status) return '物流状态待同步'
  return packageStatusLabels[status.trim().toUpperCase()] || status
}

function packageArrivalClass(orderPackage: PurchaseOrder['packages'][number]): string {
  if (orderPackage.arrival_status === 'ARRIVED') return 'arrived'
  if (orderPackage.arrival_status === 'CANDIDATE') return 'candidate'
  return ''
}

function sourceLabel(source: string): string {
  if (source === 'ALI1688_API') return '1688 开放平台同步'
  if (source === 'WINDOWS_BROWSER') return '浏览器同步'
  return source
}

function unitPriceLabel(price: string | null): string {
  if (!price) return ''
  return /^[¥￥]/.test(price) ? price : `¥${price}`
}

function visibleItems(order: PurchaseOrder) {
  return expandedItems.value.has(order.id) ? order.items : order.items.slice(0, 3)
}

function visiblePackages(order: PurchaseOrder) {
  return expandedPackages.value.has(order.id) ? order.packages : order.packages.slice(0, 3)
}

function toggleExpanded(target: 'items' | 'packages', orderId: string): void {
  const current = target === 'items' ? expandedItems : expandedPackages
  const next = new Set(current.value)
  if (next.has(orderId)) next.delete(orderId)
  else next.add(orderId)
  current.value = next
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
      <article v-for="order in orders" :key="order.id" class="purchase-order-card">
        <div class="purchase-order-topline">
          <div class="order-badges">
            <span class="platform-badge" :class="`platform-${order.platform}`">{{ platformLabel(order.platform) }}</span>
            <span class="order-status" :class="`status-${orderStatusClass(order.order_status)}`" :title="order.order_status">
              {{ orderStatusLabel(order.order_status) }}
            </span>
          </div>
          <time>{{ formatDateTime(order.ordered_at) }}</time>
        </div>

        <strong class="purchase-order-number">订单 {{ order.platform_order_id }}</strong>
        <div class="purchase-order-meta">
          <span v-if="order.account_label">账号：{{ order.account_label }}</span>
          <span v-if="order.shop_name">店铺：{{ order.shop_name }}</span>
          <span>来源：{{ sourceLabel(order.source) }}</span>
        </div>

        <section class="order-arrival-progress" aria-label="订单到货进度">
          <div>
            <span>到货进度</span>
            <strong>{{ order.package_count ? `${order.arrived_package_count}/${order.package_count} 个包裹` : '暂无包裹' }}</strong>
          </div>
          <progress
            :value="order.arrived_package_count"
            :max="Math.max(order.package_count, 1)"
            :aria-label="`${order.arrived_package_count}/${order.package_count} 个包裹已到货`"
          ></progress>
          <small>
            有效到货凭证 {{ order.arrival_photo_count }} 张
            <template v-if="order.candidate_photo_count"> · 待确认照片 {{ order.candidate_photo_count }} 张</template>
          </small>
          <p v-if="order.candidate_package_count" class="candidate-arrival-note">
            {{ order.candidate_package_count }} 个包裹有候选照片，确认前不计入已到货
          </p>
        </section>

        <section class="order-card-section">
          <h3>商品 <small>共 {{ order.items.length }} 项</small></h3>
          <ul v-if="order.items.length" class="order-items-list">
            <li v-for="(item, index) in visibleItems(order)" :key="`${item.title}-${item.sku_text || ''}-${index}`">
              <div>
                <strong>{{ item.title }}</strong>
                <small v-if="item.sku_text">{{ item.sku_text }}</small>
              </div>
              <span>×{{ item.quantity }}<template v-if="item.unit_price"> · {{ unitPriceLabel(item.unit_price) }}</template></span>
            </li>
          </ul>
          <p v-else class="order-section-empty">商品明细待同步</p>
          <button
            v-if="order.items.length > 3"
            class="order-expand-button"
            type="button"
            :aria-expanded="expandedItems.has(order.id)"
            @click="toggleExpanded('items', order.id)"
          >
            {{ expandedItems.has(order.id) ? '收起商品' : `查看全部 ${order.items.length} 项商品` }}
          </button>
        </section>

        <section class="order-card-section order-logistics">
          <h3>物流 <small>共 {{ order.package_count }} 个包裹</small></h3>
          <div v-if="order.packages.length" class="order-packages-list">
            <div v-for="(orderPackage, index) in visiblePackages(order)" :key="`${orderPackage.tracking_no}-${index}`" class="order-package">
              <div>
                <strong>{{ orderPackage.courier || '物流公司待同步' }}</strong>
                <small>{{ orderPackage.tracking_no }}</small>
              </div>
              <span :class="packageArrivalClass(orderPackage)">{{ packageStatusLabel(orderPackage) }}</span>
            </div>
          </div>
          <p v-else class="order-section-empty">暂无物流信息</p>
          <button
            v-if="order.packages.length > 3"
            class="order-expand-button"
            type="button"
            :aria-expanded="expandedPackages.has(order.id)"
            @click="toggleExpanded('packages', order.id)"
          >
            {{ expandedPackages.has(order.id) ? '收起物流' : `查看全部 ${order.packages.length} 个包裹` }}
          </button>
        </section>
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
