<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { OrderMatch, Receipt, ReceiptTrackingUpdateInput, UploadQueueItem, User } from '@/types'
import { ApiError } from '@/services/api'
import { recognizeTrackingNo } from '@/services/barcode'
import { compressImage } from '@/services/image'
import { uploadQueue } from '@/services/uploadQueue'
import { formatBytes } from '@/utils/format'
import { createId, getDeviceId } from '@/utils/id'
import { orderMatchKey, orderMatchSourceLabel } from '@/utils/orderMatch'
import { isPlausibleTrackingNo, normalizeTrackingNo } from '@/utils/tracking'

const props = defineProps<{
  user: User
  saveServerTracking: (input: ReceiptTrackingUpdateInput) => Promise<Receipt>
}>()

const emit = defineEmits<{
  changed: []
  serverChanged: []
}>()

interface CaptureResult {
  clientEventId: string
  previewUrl: string
  trackingNo: string
  serverTrackingNo: string | null
  trackingEditEventId: string | null
  trackingEditDesired: string | null
  serverReceiptId: string | number | null
  duplicate: boolean
  stage: 'ANALYZING' | 'QUEUED' | 'SYNCED' | 'ERROR'
  message: string
  sizeText: string
  matches: OrderMatch[]
}

const input = ref<HTMLInputElement | null>(null)
const processing = ref(false)
const latest = ref<CaptureResult | null>(null)
const manualTracking = ref('')
const manualSaving = ref(false)
const captureError = ref('')

function notifySuccess(): void {
  if (navigator.vibrate) navigator.vibrate([60, 40, 90])
}

function releaseLatestPreview(): void {
  if (latest.value?.previewUrl) URL.revokeObjectURL(latest.value.previewUrl)
}

async function handleFile(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  target.value = ''
  if (!file || processing.value) return

  processing.value = true
  captureError.value = ''
  releaseLatestPreview()
  latest.value = null

  try {
    const compressed = await compressImage(file)
    const clientEventId = createId()
    const occurredAt = new Date().toISOString()
    const previewUrl = URL.createObjectURL(compressed.blob)
    const queueItem: UploadQueueItem = {
      clientEventId,
      ownerUserId: String(props.user.id),
      ownerDisplayName: props.user.display_name,
      deviceId: getDeviceId(),
      occurredAt,
      photo: compressed.blob,
      fileName: `arrival-${clientEventId}.jpg`,
      trackingNo: null,
      barcodeState: 'PROCESSING',
      uploadState: 'QUEUED',
      readyToUpload: false,
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    await uploadQueue.enqueue(queueItem)
    latest.value = {
      clientEventId,
      previewUrl,
      trackingNo: '',
      serverTrackingNo: null,
      trackingEditEventId: null,
      trackingEditDesired: null,
      serverReceiptId: null,
      duplicate: false,
      stage: 'ANALYZING',
      message: '照片已存本机，正在识别面单条码…',
      sizeText: `${compressed.width} × ${compressed.height} · ${formatBytes(compressed.compressedBytes)}`,
      matches: [],
    }
    emit('changed')

    let trackingNo: string | null = null
    try {
      trackingNo = await recognizeTrackingNo(compressed.blob)
    } catch {
      captureError.value = '条码识别组件暂时不可用，照片仍会正常上传，可手工补录单号'
    }
    await uploadQueue.markReady(clientEventId, trackingNo)
    if (latest.value?.clientEventId === clientEventId) {
      latest.value.trackingNo = trackingNo ?? ''
      manualTracking.value = trackingNo ?? ''
      latest.value.stage = 'QUEUED'
      latest.value.message = trackingNo
        ? '已识别单号，请核对；照片正在自动同步'
        : '未识别出单号，照片仍会保存，可现在或稍后补录'
    }
    emit('changed')
  } catch (error) {
    captureError.value = error instanceof Error ? error.message : '处理照片失败，请重新拍摄'
    if (latest.value) {
      latest.value.stage = 'ERROR'
      latest.value.message = captureError.value
    }
  } finally {
    processing.value = false
  }
}

async function saveManualTracking(): Promise<void> {
  if (!latest.value || manualSaving.value) return
  const trackingNo = normalizeTrackingNo(manualTracking.value)
  if (!isPlausibleTrackingNo(trackingNo)) {
    captureError.value = '请检查单号，通常应为 8–32 位且至少包含一个数字'
    return
  }

  manualSaving.value = true
  captureError.value = ''
  try {
    if (latest.value.serverReceiptId !== null) {
      if (!latest.value.trackingEditEventId || latest.value.trackingEditDesired !== trackingNo) {
        latest.value.trackingEditEventId = createId()
        latest.value.trackingEditDesired = trackingNo
      }
      const patched = await props.saveServerTracking({
        receiptId: latest.value.serverReceiptId,
        trackingNo,
        expectedTrackingNo: latest.value.serverTrackingNo,
        clientEventId: latest.value.trackingEditEventId,
      })
      latest.value.matches = patched.order_matches || []
      latest.value.serverTrackingNo = patched.tracking_no ?? null
      latest.value.trackingEditEventId = null
      latest.value.trackingEditDesired = null
      emit('serverChanged')
    } else {
      await uploadQueue.updateTracking(latest.value.clientEventId, trackingNo)
    }
    latest.value.trackingNo = trackingNo
    latest.value.message = latest.value.serverReceiptId === null ? '单号已更新，将随照片一起上传' : '单号已补录并同步'
    notifySuccess()
    emit('changed')
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      const details = error.details && typeof error.details === 'object'
        ? error.details as Record<string, unknown>
        : null
      if (latest.value && details && (typeof details.current_tracking_no === 'string' || details.current_tracking_no === null)) {
        latest.value.serverTrackingNo = details.current_tracking_no as string | null
      }
      captureError.value = '这条记录已被其他人修改，记录列表已刷新。请核对后再次保存。'
    } else if (error instanceof ApiError && error.status === 0) {
      captureError.value = '网络结果不确定，修改尚未确认；请重试，系统不会重复记录。'
    } else {
      captureError.value = error instanceof Error ? error.message : '补录失败，请稍后重试'
    }
  } finally {
    manualSaving.value = false
  }
}

function handleSynced(event: Event): void {
  const receipt = (event as CustomEvent<Receipt>).detail
  if (!latest.value || receipt.client_event_id !== latest.value.clientEventId) return
  void reconcileSyncedReceipt(receipt)
}

async function reconcileSyncedReceipt(receipt: Receipt): Promise<void> {
  if (!latest.value || receipt.client_event_id !== latest.value.clientEventId) return
  const desiredTracking = normalizeTrackingNo(manualTracking.value || latest.value.trackingNo)
  const uploadedTracking = normalizeTrackingNo(receipt.tracking_no || '')

  latest.value.serverReceiptId = receipt.id
  latest.value.serverTrackingNo = receipt.tracking_no ?? null
  latest.value.stage = 'SYNCED'
  latest.value.duplicate = Boolean(receipt.is_duplicate)
  latest.value.matches = receipt.order_matches || []
  let reconciliationMessage = ''

  if (desiredTracking && desiredTracking !== uploadedTracking) {
    try {
      if (!latest.value.trackingEditEventId || latest.value.trackingEditDesired !== desiredTracking) {
        latest.value.trackingEditEventId = createId()
        latest.value.trackingEditDesired = desiredTracking
      }
      const patched = await props.saveServerTracking({
        receiptId: receipt.id,
        trackingNo: desiredTracking,
        expectedTrackingNo: receipt.tracking_no ?? null,
        clientEventId: latest.value.trackingEditEventId,
      })
      latest.value.trackingNo = patched.tracking_no || desiredTracking
      latest.value.serverTrackingNo = patched.tracking_no ?? null
      latest.value.trackingEditEventId = null
      latest.value.trackingEditDesired = null
      latest.value.matches = patched.order_matches || []
      manualTracking.value = latest.value.trackingNo
      reconciliationMessage = '照片与刚补录的单号均已同步'
      emit('serverChanged')
    } catch (error) {
      latest.value.trackingNo = desiredTracking
      if (error instanceof ApiError && error.status === 0) {
        captureError.value = '照片已同步，但单号修改结果尚未确认；请重试，系统不会重复记录。'
      } else if (error instanceof ApiError && error.status === 409) {
        const details = error.details && typeof error.details === 'object'
          ? error.details as Record<string, unknown>
          : null
        if (details && (typeof details.current_tracking_no === 'string' || details.current_tracking_no === null)) {
          latest.value.serverTrackingNo = details.current_tracking_no as string | null
        }
        captureError.value = '照片已同步，但单号已被其他人修改；请核对记录列表后再次保存。'
      } else {
        captureError.value = error instanceof Error ? `照片已同步，但单号补录失败：${error.message}` : '照片已同步，但单号补录失败'
      }
      reconciliationMessage = '照片已保存；请再次点击补录，确保单号同步'
    }
  } else if (receipt.tracking_no) {
    latest.value.trackingNo = receipt.tracking_no
    manualTracking.value = receipt.tracking_no
  }

  latest.value.message = reconciliationMessage || (receipt.is_duplicate
      ? '这个单号以前已确认过，请核对首次记录'
      : latest.value.trackingNo
        ? '已同步到服务器，收货凭证保存成功'
        : '照片已同步，单号仍待补录')
  notifySuccess()
  emit('changed')
}

onMounted(() => uploadQueue.addEventListener('synced', handleSynced))
onBeforeUnmount(() => {
  uploadQueue.removeEventListener('synced', handleSynced)
  releaseLatestPreview()
})
</script>

<template>
  <section class="capture-card">
    <div class="capture-heading">
      <div>
        <p class="eyebrow">连续收货</p>
        <h2>让面单条码保持清晰</h2>
      </div>
      <span class="required-chip">每件必拍</span>
    </div>

    <p class="capture-tip">一张照片同时作为到货凭证并尝试识别快递单号。尽量正对面单、避开反光。</p>

    <label class="camera-button" :class="{ disabled: processing }">
      <input
        ref="input"
        class="visually-hidden"
        type="file"
        accept="image/*"
        capture="environment"
        :disabled="processing"
        @change="handleFile"
      />
      <span class="camera-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M4 7.5h3l1.5-2h7l1.5 2h3v11H4Z" /><circle cx="12" cy="13" r="3" /></svg>
      </span>
      <span>
        <strong>{{ processing ? '正在处理照片…' : '拍摄包裹面单' }}</strong>
        <small>{{ processing ? '请不要关闭页面' : '点击拉起后置相机' }}</small>
      </span>
      <span v-if="processing" class="spinner spinner-light" aria-hidden="true"></span>
    </label>

    <p v-if="captureError" class="form-error capture-error" role="alert">{{ captureError }}</p>

    <article v-if="latest" class="capture-result" :class="[`result-${latest.stage.toLowerCase()}`, { duplicate: latest.duplicate }]">
      <img :src="latest.previewUrl" alt="刚拍摄的包裹面单" />
      <div class="capture-result-body">
        <div class="result-line">
          <span class="result-state">
            {{ latest.duplicate ? '重复单号' : latest.stage === 'SYNCED' ? '已同步' : latest.stage === 'ANALYZING' ? '识别中' : '已留本机' }}
          </span>
          <span class="photo-meta">{{ latest.sizeText }}</span>
        </div>
        <strong v-if="latest.trackingNo" class="tracking-number">{{ latest.trackingNo }}</strong>
        <strong v-else class="tracking-missing">暂未识别单号</strong>
        <p>{{ latest.message }}</p>

        <div v-if="latest.matches && latest.matches.length" class="capture-matches">
          <p v-for="(match, index) in latest.matches" :key="orderMatchKey(match, index)" class="match-line">
            {{ match.confidence === 'CANDIDATE' ? '候选匹配（请人工确认）：' : '已匹配：' }}{{ orderMatchSourceLabel(match) }}
            <template v-if="match.items && match.items.length">
              — {{ match.items.map((item) => item.title).join('、') }}
            </template>
            <template v-if="match.items && match.items.length > 1">（整单商品候选）</template>
          </p>
        </div>
        <p v-else-if="latest.trackingNo" class="match-pending">待匹配：订单同步后会自动显示对应商品</p>

        <form class="tracking-form" @submit.prevent="saveManualTracking">
          <input
            v-model="manualTracking"
            inputmode="text"
            autocapitalize="characters"
            autocomplete="off"
            placeholder="手工输入或修正快递单号"
            aria-label="快递单号"
          />
          <button type="submit" :disabled="manualSaving || !manualTracking.trim()">
            {{ manualSaving ? '保存中' : latest.trackingNo ? '修正' : '补录' }}
          </button>
        </form>
      </div>
    </article>
  </section>
</template>
