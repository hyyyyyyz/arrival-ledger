<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { Receipt, ReceiptTrackingUpdateInput, UploadQueueItem } from '@/types'
import { ApiError, receiptPhotoUrl } from '@/services/api'
import { formatDateTime } from '@/utils/format'
import { createId } from '@/utils/id'
import { orderMatchKey, orderMatchSourceLabel } from '@/utils/orderMatch'
import { isPlausibleTrackingNo, normalizeTrackingNo } from '@/utils/tracking'

const props = withDefaults(
  defineProps<{
    receipts: Receipt[]
    localItems: UploadQueueItem[]
    loading?: boolean
    title?: string
    emptyText?: string
    saveServerTracking: (input: ReceiptTrackingUpdateInput) => Promise<Receipt>
  }>(),
  {
    loading: false,
    title: '最近到货',
    emptyText: '还没有到货记录，拍下第一个包裹吧。',
  },
)

const emit = defineEmits<{
  refresh: []
  capture: []
  retry: [clientEventId: string]
  updateLocal: [clientEventId: string, trackingNo: string]
}>()

const localUrls = new Map<string, string>()
const editKey = ref('')
const editValue = ref('')
const editError = ref('')
const editClientEventId = ref('')
const editSubmittedTrackingNo = ref('')
const editExpectedTrackingNo = ref<string | null>(null)
const editSaving = ref(false)

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
  if (editSaving.value) return
  editKey.value = key
  editValue.value = trackingNo || ''
  editError.value = ''
  editClientEventId.value = key.startsWith('server-') ? createId() : ''
  editSubmittedTrackingNo.value = ''
  editExpectedTrackingNo.value = trackingNo ?? null
}

function resetEdit(): void {
  editKey.value = ''
  editValue.value = ''
  editError.value = ''
  editClientEventId.value = ''
  editSubmittedTrackingNo.value = ''
  editExpectedTrackingNo.value = null
}

function closeEdit(): void {
  if (editSaving.value) return
  resetEdit()
}

function submitLocal(item: UploadQueueItem): void {
  const trackingNo = normalizeTrackingNo(editValue.value)
  if (!isPlausibleTrackingNo(trackingNo)) {
    editError.value = '请检查单号格式'
    return
  }
  emit('updateLocal', item.clientEventId, trackingNo)
  closeEdit()
}

async function submitServer(receipt: Receipt): Promise<void> {
  if (editSaving.value) return
  const trackingNo = normalizeTrackingNo(editValue.value)
  if (!isPlausibleTrackingNo(trackingNo)) {
    editError.value = '请检查单号格式'
    return
  }
  const clientEventId = editClientEventId.value && (!editSubmittedTrackingNo.value || editSubmittedTrackingNo.value === trackingNo)
    ? editClientEventId.value
    : createId()
  editClientEventId.value = clientEventId
  editSubmittedTrackingNo.value = trackingNo
  editSaving.value = true
  editError.value = ''
  try {
    await props.saveServerTracking({
      receiptId: receipt.id,
      trackingNo,
      expectedTrackingNo: editExpectedTrackingNo.value,
      clientEventId,
    })
    editSaving.value = false
    resetEdit()
    return
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 409) {
      await nextTick()
      const details = reason.details && typeof reason.details === 'object'
        ? reason.details as Record<string, unknown>
        : null
      const currentTrackingNo = details && (typeof details.current_tracking_no === 'string' || details.current_tracking_no === null)
        ? details.current_tracking_no as string | null
        : props.receipts.find((item) => String(item.id) === String(receipt.id))?.tracking_no ?? null
      editExpectedTrackingNo.value = currentTrackingNo
      editError.value = '这条记录已被其他人修改，列表已刷新。请核对最新单号后再次保存。'
    } else if (reason instanceof ApiError && reason.status === 0) {
      editError.value = '网络结果不确定，修改尚未确认；请重试，系统不会重复记录。'
    } else {
      editError.value = reason instanceof Error ? reason.message : '单号更新失败，请重试'
    }
  } finally {
    editSaving.value = false
  }
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
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path v-if="item.uploadState === 'FAILED'" d="M12 4 21 20H3Zm0 5v5m0 3h.01" />
                <template v-else><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></template>
              </svg>
              {{ item.uploadState === 'UPLOADING' ? '上传中' : item.uploadState === 'FAILED' ? '同步失败' : item.readyToUpload ? '待上传' : '识别中' }}
            </span>
            <time>{{ formatDateTime(item.occurredAt) }}</time>
          </div>
          <strong :class="{ muted: !item.trackingNo }">{{ item.trackingNo || '待补快递单号' }}</strong>
          <p v-if="item.lastError" class="record-error">{{ item.lastError }}</p>
          <p v-else>照片已安全保存在当前手机</p>
          <p class="operator-name">拍摄人：{{ item.ownerDisplayName }}</p>

          <form v-if="editKey === `local-${item.clientEventId}`" class="inline-edit" @submit.prevent="submitLocal(item)">
            <input v-model="editValue" autocomplete="off" placeholder="输入快递单号" />
            <div class="inline-edit-actions">
              <button type="submit">保存</button>
              <button class="secondary" type="button" @click="closeEdit">取消</button>
            </div>
            <small v-if="editError">{{ editError }}</small>
          </form>
          <div v-else class="record-actions">
            <button type="button" :disabled="Boolean(editKey)" @click="beginEdit(`local-${item.clientEventId}`, item.trackingNo)">
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
            <span class="record-badge ready">
              <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16 9" /></svg>
              {{ receipt.evidence_status === 'READY' ? '凭证完整' : receipt.evidence_status || '已同步' }}
            </span>
            <time>{{ formatDateTime(receiptTime(receipt)) }}</time>
          </div>
          <strong :class="{ muted: !receipt.tracking_no }">{{ receipt.tracking_no || '待补快递单号' }}</strong>
          <div v-if="receipt.order_matches && receipt.order_matches.length" class="order-matches">
            <div v-for="(match, index) in receipt.order_matches" :key="orderMatchKey(match, index)" class="order-match">
              <p>
                <span class="record-badge matched">
                  <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 12.5 11.5 15 16 9" /></svg>
                  {{ match.confidence === 'CANDIDATE' ? '候选匹配' : '已匹配订单' }}
                </span>
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
            拍摄人：{{ receipt.operator_display_name || receipt.operator?.display_name }}
          </p>
          <p v-if="receipt.last_modified_by?.display_name" class="operator-name">
            最近修改：{{ receipt.last_modified_by.display_name }}<template v-if="receipt.last_modified_at"> · {{ formatDateTime(receipt.last_modified_at) }}</template>
          </p>

          <form v-if="editKey === `server-${receipt.id}`" class="inline-edit" @submit.prevent="submitServer(receipt)">
            <input v-model="editValue" autocomplete="off" placeholder="输入快递单号" :disabled="editSaving" />
            <div class="inline-edit-actions">
              <button type="submit" :disabled="editSaving">{{ editSaving ? '保存中…' : '保存' }}</button>
              <button class="secondary" type="button" :disabled="editSaving" @click="closeEdit">取消</button>
            </div>
            <small v-if="editError" role="alert">{{ editError }}</small>
          </form>
          <div v-else class="record-actions">
            <button type="button" :disabled="Boolean(editKey)" @click="beginEdit(`server-${receipt.id}`, receipt.tracking_no)">
              {{ receipt.tracking_no ? '修正单号' : '补录单号' }}
            </button>
          </div>
        </div>
      </article>
    </div>

    <div v-if="!loading && !receipts.length && !localItems.length" class="empty-state">
      <span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 3h12v18H6zM9 8h6M9 12h6M9 16h4" /></svg></span>
      <strong>还没有收货记录</strong>
      <p>{{ emptyText }}</p>
      <small>请在“收货”页点击“拍照收货”，完成后会自动显示在这里。</small>
      <button class="empty-state-action" type="button" @click="emit('capture')">去拍摄包裹</button>
    </div>
  </section>
</template>
