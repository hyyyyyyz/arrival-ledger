<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ApiError, updateOrderArrivalStatus } from '@/services/api'
import type { ManualArrivalStatus, OrderArrivalFilter, OrderPlatformFilter, PurchaseOrder } from '@/types'
import { formatDateTime } from '@/utils/format'
import { createId } from '@/utils/id'

const props = defineProps<{
  orders: PurchaseOrder[]
  total: number
  limit: number
  offset: number
  query: string
  platform: OrderPlatformFilter
  arrivalStatus: OrderArrivalFilter
  loading: boolean
  error: string
  lastSyncedAt: string | null
  online: boolean
}>()

const emit = defineEmits<{
  search: [query: string, platform: OrderPlatformFilter, arrivalStatus: OrderArrivalFilter]
  refresh: []
  page: [offset: number]
  manualChanged: [order: PurchaseOrder]
  authRequired: []
}>()

const draftQuery = ref(props.query)
const draftPlatform = ref<OrderPlatformFilter>(props.platform)
const draftArrivalStatus = ref<OrderArrivalFilter>(props.arrivalStatus)
const expandedOrders = ref<Set<string>>(new Set())
const freshnessNow = ref(Date.now())
const pendingCorrection = ref<{ order: PurchaseOrder; status: ManualArrivalStatus; clientEventId: string } | null>(null)
const savingOrderId = ref<string | null>(null)
const actionErrors = ref<Record<string, string>>({})
const confirmationDialog = ref<HTMLElement | null>(null)
let freshnessTimer: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  freshnessTimer = setInterval(() => {
    freshnessNow.value = Date.now()
  }, 60_000)
})

onBeforeUnmount(() => {
  if (freshnessTimer !== undefined) clearInterval(freshnessTimer)
})

watch(() => props.query, (value) => { draftQuery.value = value })
watch(() => props.platform, (value) => { draftPlatform.value = value })
watch(() => props.arrivalStatus, (value) => { draftArrivalStatus.value = value })
watch(() => props.error, (value) => {
  if (!value) return
  draftQuery.value = props.query
  draftPlatform.value = props.platform
  draftArrivalStatus.value = props.arrivalStatus
})

const firstResult = computed(() => props.total > 0 ? props.offset + 1 : 0)
const lastResult = computed(() => Math.min(props.offset + props.orders.length, props.total))
const hasPrevious = computed(() => props.offset > 0)
const hasNext = computed(() => props.offset + props.limit < props.total)
const freshness = computed(() => {
  if (!props.lastSyncedAt) {
    return { label: '有采购账号尚无成功同步记录', stale: true }
  }
  const syncedAt = new Date(props.lastSyncedAt)
  if (Number.isNaN(syncedAt.getTime())) {
    return { label: '采购数据同步时间异常', stale: true }
  }
  const time = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(syncedAt)
  const stale = freshnessNow.value - syncedAt.getTime() > 45 * 60 * 1000
  return {
    label: `全部账号至少同步至 ${time}${stale ? ' · 可能不是最新' : ''}`,
    stale,
  }
})

type ArrivalTone = 'pending' | 'candidate' | 'partial' | 'received' | 'closed'

interface ArrivalSummary {
  tone: ArrivalTone
  label: string
  detail: string
}

function platformLabel(platform: PurchaseOrder['platform']): string {
  return platform === '1688' ? '1688' : '拼多多'
}

function visibleItems(order: PurchaseOrder) {
  return expandedOrders.value.has(order.id) ? order.items : order.items.slice(0, 1)
}

function visiblePackages(order: PurchaseOrder) {
  return expandedOrders.value.has(order.id) ? order.packages : order.packages.slice(0, 1)
}

function toggleExpanded(orderId: string): void {
  const next = new Set(expandedOrders.value)
  if (next.has(orderId)) next.delete(orderId)
  else next.add(orderId)
  expandedOrders.value = next
}

function hasHiddenDetails(order: PurchaseOrder): boolean {
  return order.items.length > 1
    || order.packages.length > 1
    || order.items.some((item) => Boolean(item.sku_text))
}

function hiddenDetailsLabel(order: PurchaseOrder): string {
  if (expandedOrders.value.has(order.id)) return '收起订单详情'
  const parts: string[] = []
  if (order.items.length > 1) parts.push(`${order.items.length - 1} 项商品`)
  if (order.packages.length > 1) parts.push(`${order.packages.length - 1} 个包裹`)
  return parts.length ? `展开其余 ${parts.join('、')}` : '查看商品规格'
}

function arrivalSummary(order: PurchaseOrder): ArrivalSummary {
  const normalizedOrderStatus = order.order_status.trim().toUpperCase()
  if (order.effective_arrival_status === 'CLOSED' || normalizedOrderStatus === 'CANCELLED' || normalizedOrderStatus === 'REFUNDED') {
    return {
      tone: 'closed',
      label: '无需收货',
      detail: normalizedOrderStatus === 'CANCELLED' ? '订单已取消' : '退款或售后',
    }
  }
  if (order.arrival_source === 'MANUAL') {
    if (order.effective_arrival_status === 'RECEIVED') {
      return { tone: 'received', label: '已收货', detail: '人工确认' }
    }
    if (order.effective_arrival_status === 'PENDING') {
      return { tone: 'pending', label: '未收货', detail: '人工撤销' }
    }
  }
  const total = order.package_count
  const arrived = order.arrived_package_count
  if (total > 0 && arrived >= total) {
    return { tone: 'received', label: '已收货', detail: `${arrived}/${total} 个包裹` }
  }
  if (arrived > 0) {
    const candidateDetail = order.candidate_package_count > 0
      ? ` · ${order.candidate_package_count} 待确认`
      : ''
    return {
      tone: 'partial',
      label: '部分收货',
      detail: total > 0
        ? `${arrived}/${total} 个包裹${candidateDetail}`
        : `${arrived} 个包裹${candidateDetail}`,
    }
  }
  if (order.candidate_package_count > 0) {
    return {
      tone: 'candidate',
      label: '待确认',
      detail: `${order.candidate_package_count} 个包裹照片待确认`,
    }
  }
  return {
    tone: 'pending',
    label: '未收货',
    detail: total > 0 ? `0/${total} 个包裹` : '物流待同步',
  }
}

function isClosed(order: PurchaseOrder): boolean {
  const status = order.order_status.trim().toUpperCase()
  return status === 'CANCELLED' || status === 'REFUNDED' || order.effective_arrival_status === 'CLOSED'
}

function nextCorrectionStatus(order: PurchaseOrder): ManualArrivalStatus {
  return arrivalSummary(order).tone === 'received' ? 'PENDING' : 'RECEIVED'
}

function correctionButtonLabel(order: PurchaseOrder): string {
  return nextCorrectionStatus(order) === 'RECEIVED' ? '人工标记已收货' : '人工撤销收货'
}

function correctionAuditLabel(order: PurchaseOrder): string {
  return order.effective_arrival_status === 'RECEIVED' ? '人工确认收货' : '人工撤销收货'
}

function responsibleName(order: PurchaseOrder): string {
  return order.responsible_user?.display_name || '操作人待同步'
}

async function askCorrection(order: PurchaseOrder): Promise<void> {
  if (isClosed(order) || savingOrderId.value !== null) return
  pendingCorrection.value = { order, status: nextCorrectionStatus(order), clientEventId: createId() }
  delete actionErrors.value[order.id]
  await nextTick()
  confirmationDialog.value?.focus()
}

function closeCorrection(): void {
  if (savingOrderId.value !== null) return
  pendingCorrection.value = null
}

async function confirmCorrection(): Promise<void> {
  const correction = pendingCorrection.value
  if (!correction || savingOrderId.value !== null) return
  const orderId = correction.order.id
  savingOrderId.value = orderId
  delete actionErrors.value[orderId]
  try {
    const update = await updateOrderArrivalStatus(
      orderId,
      correction.status,
      correction.order.manual_revision ?? 0,
      correction.clientEventId,
    )
    const updated: PurchaseOrder = {
      ...correction.order,
      effective_arrival_status: update.effective_arrival_status,
      evidence_arrival_status: update.evidence_arrival_status,
      arrival_source: update.arrival_source,
      responsible_user: update.responsible_user,
      manual_revision: update.manual_revision,
      changed_at: update.changed_at,
    }
    pendingCorrection.value = null
    emit('manualChanged', updated)
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 401) {
      pendingCorrection.value = null
      emit('authRequired')
    } else if (reason instanceof ApiError && reason.status === 409) {
      actionErrors.value[orderId] = '订单状态已被其他人修改，请刷新后重试。'
      pendingCorrection.value = null
      emit('refresh')
    } else {
      actionErrors.value[orderId] = reason instanceof Error ? reason.message : '人工纠正保存失败，请重试。'
    }
  } finally {
    savingOrderId.value = null
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
  emit('search', draftQuery.value.trim(), draftPlatform.value, draftArrivalStatus.value)
}

function applyPlatform(platform: OrderPlatformFilter): void {
  draftPlatform.value = platform
  emit('search', draftQuery.value.trim(), platform, draftArrivalStatus.value)
}

function applyArrivalStatus(arrivalStatus: OrderArrivalFilter): void {
  draftArrivalStatus.value = arrivalStatus
  emit('search', draftQuery.value.trim(), draftPlatform.value, arrivalStatus)
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
      <div class="arrival-filters" role="group" aria-label="收货状态筛选">
        <span>状态</span>
        <button type="button" :class="{ active: draftArrivalStatus === '' }" :aria-pressed="draftArrivalStatus === ''" :disabled="loading || !online" @click="applyArrivalStatus('')">全部</button>
        <button type="button" :class="{ active: draftArrivalStatus === 'pending' }" :aria-pressed="draftArrivalStatus === 'pending'" :disabled="loading || !online" @click="applyArrivalStatus('pending')">未收货</button>
        <button type="button" :class="{ active: draftArrivalStatus === 'review' }" :aria-pressed="draftArrivalStatus === 'review'" :disabled="loading || !online" @click="applyArrivalStatus('review')">待确认</button>
        <button type="button" :class="{ active: draftArrivalStatus === 'received' }" :aria-pressed="draftArrivalStatus === 'received'" :disabled="loading || !online" @click="applyArrivalStatus('received')">已收货</button>
      </div>
    </div>

    <div class="orders-title-row">
      <div>
        <p class="eyebrow">采购明细</p>
        <h2 id="orders-list-title">订单列表</h2>
        <p class="orders-freshness" :class="{ stale: freshness.stale }">{{ freshness.label }}</p>
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
        :class="[`arrival-${arrivalSummary(order).tone}`, { 'order-expanded': expandedOrders.has(order.id) }]"
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
          <div class="compact-order-actions">
            <div
              class="order-arrival-state"
              :class="`state-${arrivalSummary(order).tone}`"
              :aria-label="`收货状态：${arrivalSummary(order).label}，${arrivalSummary(order).detail}`"
            >
              <span aria-hidden="true">
                <svg v-if="arrivalSummary(order).tone === 'received'" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16 9" /></svg>
                <svg v-else-if="arrivalSummary(order).tone === 'candidate' || arrivalSummary(order).tone === 'partial'" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                <svg v-else-if="arrivalSummary(order).tone === 'closed'" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></svg>
                <svg v-else viewBox="0 0 24 24"><path d="M4 7h16v12H4zM8 7V5h8v2M9 13h6" /></svg>
              </span>
              <div>
                <strong>{{ arrivalSummary(order).label }}</strong>
                <small>{{ arrivalSummary(order).detail }}</small>
              </div>
            </div>
            <button
              v-if="hasHiddenDetails(order)"
              class="compact-order-toggle"
              type="button"
              :aria-expanded="expandedOrders.has(order.id)"
              :aria-label="hiddenDetailsLabel(order)"
              @click="toggleExpanded(order.id)"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path :d="expandedOrders.has(order.id) ? 'm7 14 5-5 5 5' : 'm7 10 5 5 5-5'" />
              </svg>
            </button>
          </div>
        </header>

        <section class="compact-order-section" aria-label="商品">
          <h3>商品</h3>
          <div v-if="order.items.length" class="compact-order-rows">
            <div v-for="(item, index) in visibleItems(order)" :key="`${item.title}-${item.sku_text || ''}-${index}`" class="compact-product-row">
              <p>
                <strong>{{ item.title }}</strong>
                <small v-if="item.sku_text && expandedOrders.has(order.id)">{{ item.sku_text }}</small>
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

        <footer class="manual-correction-row">
          <p v-if="order.arrival_source === 'MANUAL'" class="order-audit-line">
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 4h14v16H5zM8 8h8M8 12h5M8 16h4" /></svg>
            <span>
              {{ correctionAuditLabel(order) }} · {{ responsibleName(order) }}<template v-if="order.changed_at"> · {{ formatDateTime(order.changed_at) }}</template>
            </span>
          </p>
          <p v-else-if="order.responsible_user" class="order-audit-line">
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7.5h3l1.5-2h7l1.5 2h3v11H4Z" /><circle cx="12" cy="13" r="3" /></svg>
            <span>照片凭证 · 拍摄人 {{ responsibleName(order) }}<template v-if="order.changed_at"> · {{ formatDateTime(order.changed_at) }}</template></span>
          </p>
          <button
            v-if="!isClosed(order)"
            class="manual-correction-button"
            :class="{ undo: nextCorrectionStatus(order) === 'PENDING' }"
            type="button"
            :disabled="savingOrderId !== null || !online"
            @click="askCorrection(order)"
          >
            <span v-if="savingOrderId === order.id" class="spinner" aria-hidden="true"></span>
            {{ savingOrderId === order.id ? '保存中…' : correctionButtonLabel(order) }}
          </button>
          <p v-if="actionErrors[order.id]" class="order-action-error" role="alert">{{ actionErrors[order.id] }}</p>
        </footer>

      </article>
    </div>

    <div v-else-if="!error" class="empty-state orders-empty">
      <span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" /></svg></span>
      <p>{{ query || platform || arrivalStatus ? '没有符合当前筛选条件的采购订单。' : '还没有导入采购订单。' }}</p>
    </div>

    <footer v-if="total > 0" class="orders-pagination" aria-label="订单分页">
      <p>第 {{ firstResult }}–{{ lastResult }} 条，共 {{ total }} 条</p>
      <div>
        <button type="button" :disabled="loading || !hasPrevious" @click="emit('page', offset - limit)">上一页</button>
        <button type="button" :disabled="loading || !hasNext" @click="emit('page', offset + limit)">下一页</button>
      </div>
    </footer>

    <div v-if="pendingCorrection" class="modal-backdrop" @click.self="closeCorrection">
      <section
        ref="confirmationDialog"
        class="confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-correction-title"
        tabindex="-1"
        @keydown.esc="closeCorrection"
      >
        <span class="dialog-icon" :class="{ danger: pendingCorrection.status === 'PENDING' }" aria-hidden="true">
          <svg v-if="pendingCorrection.status === 'RECEIVED'" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16 9" /></svg>
          <svg v-else viewBox="0 0 24 24"><path d="M12 9v4m0 4h.01M4.9 19h14.2a2 2 0 0 0 1.73-3L13.73 3.7a2 2 0 0 0-3.46 0L3.17 16A2 2 0 0 0 4.9 19Z" /></svg>
        </span>
        <p class="eyebrow">人工纠正</p>
        <h3 id="order-correction-title">{{ pendingCorrection.status === 'RECEIVED' ? '确认标记为已收货？' : '确认撤销收货状态？' }}</h3>
        <p class="dialog-order-number">订单 {{ pendingCorrection.order.platform_order_id }}</p>
        <p v-if="pendingCorrection.status === 'RECEIVED'">这会覆盖当前系统判断并标记整单已收货，不会新增或删除到货照片。</p>
        <p v-else>这会覆盖当前系统判断并把整单改为未收货，已有到货照片仍会保留。</p>
        <p class="dialog-accountability">系统将记录当前登录账号、操作时间和修改前后状态，可供之后追责和还原。</p>
        <p v-if="actionErrors[pendingCorrection.order.id]" class="dialog-error" role="alert">{{ actionErrors[pendingCorrection.order.id] }}</p>
        <div class="dialog-actions">
          <button type="button" :disabled="savingOrderId !== null" @click="closeCorrection">取消</button>
          <button
            class="confirm"
            :class="{ danger: pendingCorrection.status === 'PENDING' }"
            type="button"
            :disabled="savingOrderId !== null"
            @click="confirmCorrection"
          >
            {{ savingOrderId !== null ? '保存中…' : pendingCorrection.status === 'RECEIVED' ? '确认已收货' : '确认撤销' }}
          </button>
        </div>
      </section>
    </div>
  </section>
</template>
