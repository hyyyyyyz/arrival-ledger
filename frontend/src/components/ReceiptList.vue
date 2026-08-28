<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { Receipt, UploadQueueItem } from '@/types'
import { receiptPhotoUrl } from '@/services/api'
import { formatDateTime } from '@/utils/format'
import { orderMatchKey, orderMatchSourceLabel } from '@/utils/orderMatch'
import { isPlausibleTrackingNo, normalizeTrackingNo } from '@/utils/tracking'

const props = withDefaults(
  defineProps<{
    receipts: Receipt[]
    localItems: UploadQueueItem[]
    loading?: boolean
    title?: string
    emptyText?: string
  }>(),
  {
    loading: false,
    title: '最近到货',
    emptyText: '还没有到货记录，拍下第一个包裹吧。',
  },
)

const emit = defineEmits<{
  refresh: []
  retry: [clientEventId: string]
  updateLocal: [clientEventId: string, trackingNo: string]
  updateServer: [receiptId: string | number, trackingNo: string]
}>()

const localUrls = new Map<string, string>()
const editKey = ref('')
const editValue = ref('')
const editError = ref('')

function localUrl(item: UploadQueueItem): string {
  const existing = localUrls.get(item.clientEventId)
  if (existing) return existing
  const url = URL.createObjectURL(item.photo)
  localUrls.set(item.clientEventId, url)
  return url
}

watch(
  () => props.localItems.map((item) => item.clientEventId),
  (ids) => {
    const active = new Set(ids)
    for (const [id, url] of localUrls) {
      if (!active.has(id)) {
        URL.revokeObjectURL(url)
        localUrls.delete(id)
      }
    }
  },
)

onBeforeUnmount(() => {
  for (const url of localUrls.values()) URL.revokeObjectURL(url)
  localUrls.clear()
})

function receiptTime(receipt: Receipt): string | undefined {
  return receipt.captured_at || receipt.first_received_at || receipt.occurred_at || receipt.server_received_at || receipt.created_at
}

function beginEdit(key: string, trackingNo?: string | null): void {
  editKey.value = key
  editValue.value = trackingNo || ''
  editError.value = ''
}

function submitLocal(item: UploadQueueItem): void {
  const trackingNo = normalizeTrackingNo(editValue.value)
  if (!isPlausibleTrackingNo(trackingNo)) {
    editError.value = '请检查单号格式'
    return
  }
  emit('updateLocal', item.clientEventId, trackingNo)
  editKey.value = ''
}

function submitServer(receipt: Receipt): void {
  const trackingNo = normalizeTrackingNo(editValue.value)
  if (!isPlausibleTrackingNo(trackingNo)) {
    editError.value = '请检查单号格式'
    return
  }
  emit('updateServer', receipt.id, trackingNo)
  editKey.value = ''
}
</script>

<template>
  <section class="records-section">
    <div class="section-title-row">
      <div>
        <p class="eyebrow">收货凭证</p>
        <h2>{{ title }}</h2>
      </div>
      <button class="text-button" type="button" :disabled="loading" @click="emit('refresh')">
        {{ loading ? '刷新中…' : '刷新' }}
      </button>
    </div>

    <div v-if="localItems.length" class="local-group">
      <p class="group-label">本机尚未完全同步</p>
      <article v-for="item in localItems" :key="item.clientEventId" class="receipt-card local-receipt">
        <img :src="localUrl(item)" alt="待上传包裹照片" />
        <div class="receipt-body">
          <div class="receipt-topline">
            <span class="record-badge" :class="item.uploadState.toLowerCase()">
              {{ item.uploadState === 'UPLOADING' ? '上传中' : item.uploadState === 'FAILED' ? '同步失败' : item.readyToUpload ? '待上传' : '识别中' }}
            </span>
            <time>{{ formatDateTime(item.occurredAt) }}</time>
          </div>
          <strong :class="{ muted: !item.trackingNo }">{{ item.trackingNo || '待补快递单号' }}</strong>
          <p v-if="item.lastError" class="record-error">{{ item.lastError }}</p>
          <p v-else>照片已安全保存在当前手机</p>

          <form v-if="editKey === `local-${item.clientEventId}`" class="inline-edit" @submit.prevent="submitLocal(item)">
            <input v-model="editValue" autocomplete="off" placeholder="输入快递单号" />
            <button type="submit">保存</button>
            <small v-if="editError">{{ editError }}</small>
          </form>
          <div v-else class="record-actions">
            <button type="button" @click="beginEdit(`local-${item.clientEventId}`, item.trackingNo)">
              {{ item.trackingNo ? '修正单号' : '补录单号' }}
            </button>
            <button v-if="item.uploadState === 'FAILED'" type="button" @click="emit('retry', item.clientEventId)">立即重试</button>
          </div>
        </div>
      </article>
    </div>

    <div v-if="receipts.length" class="server-group">
      <article v-for="receipt in receipts" :key="receipt.id" class="receipt-card">
        <img :src="receiptPhotoUrl(receipt)" alt="包裹到货照片" loading="lazy" />
        <div class="receipt-body">
          <div class="receipt-topline">
            <span class="record-badge ready">{{ receipt.evidence_status === 'READY' ? '凭证完整' : receipt.evidence_status || '已同步' }}</span>
            <time>{{ formatDateTime(receiptTime(receipt)) }}</time>
          </div>
          <strong :class="{ muted: !receipt.tracking_no }">{{ receipt.tracking_no || '待补快递单号' }}</strong>
          <div v-if="receipt.order_matches && receipt.order_matches.length" class="order-matches">
            <div v-for="(match, index) in receipt.order_matches" :key="orderMatchKey(match, index)" class="order-match">
              <p>
                <span class="record-badge matched">{{ match.confidence === 'CANDIDATE' ? '候选匹配' : '已匹配订单' }}</span>
                {{ orderMatchSourceLabel(match) }}
              </p>
              <ul>
                <li v-for="(item, itemIndex) in match.items || []" :key="`${orderMatchKey(match, index)}-item-${itemIndex}`">
                  {{ item.title }}<template v-if="item.sku_text">（{{ item.sku_text }}）</template>
                  <template v-if="item.quantity"> ×{{ item.quantity }}</template>
                </li>
              </ul>
              <p v-if="match.confidence === 'CANDIDATE'" class="match-candidate-hint">多个订单共用该运单号，请人工确认</p>
              <p v-else-if="match.items && match.items.length > 1" class="match-candidate-hint">整单商品候选：以拆包确认为准</p>
            </div>
          </div>
          <p v-else-if="receipt.tracking_no && !receipt.order_matches?.length" class="match-hint">
            待匹配：订单同步后会自动显示对应商品
          </p>
          <p v-else-if="receipt.title_summary">{{ receipt.platform ? `${receipt.platform} · ` : '' }}{{ receipt.title_summary }}</p>
          <p v-else>{{ receipt.match_status === 'MATCHED' ? '已匹配采购订单' : '尚未匹配采购订单' }}</p>
          <p v-if="receipt.operator_display_name || receipt.operator?.display_name" class="operator-name">
            收货人：{{ receipt.operator_display_name || receipt.operator?.display_name }}
          </p>

          <form v-if="editKey === `server-${receipt.id}`" class="inline-edit" @submit.prevent="submitServer(receipt)">
            <input v-model="editValue" autocomplete="off" placeholder="输入快递单号" />
            <button type="submit">保存</button>
            <small v-if="editError">{{ editError }}</small>
          </form>
          <div v-else class="record-actions">
            <button type="button" @click="beginEdit(`server-${receipt.id}`, receipt.tracking_no)">
              {{ receipt.tracking_no ? '修正单号' : '补录单号' }}
            </button>
          </div>
        </div>
      </article>
    </div>

    <div v-if="!loading && !receipts.length && !localItems.length" class="empty-state">
      <span aria-hidden="true">□</span>
      <p>{{ emptyText }}</p>
    </div>
  </section>
</template>
