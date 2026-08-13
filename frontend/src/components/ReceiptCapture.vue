<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Receipt, UploadQueueItem, User } from '@/types'
import { updateReceiptTracking } from '@/services/api'
import { recognizeTrackingNo } from '@/services/barcode'
import { compressImage } from '@/services/image'
import { uploadQueue } from '@/services/uploadQueue'
import { formatBytes } from '@/utils/format'
import { createId, getDeviceId } from '@/utils/id'
import { isPlausibleTrackingNo, normalizeTrackingNo } from '@/utils/tracking'

const props = defineProps<{
  user: User
}>()

const emit = defineEmits<{
  changed: []
}>()

interface CaptureResult {
  clientEventId: string
  previewUrl: string
  trackingNo: string
  serverReceiptId: string | number | null
  duplicate: boolean
  stage: 'ANALYZING' | 'QUEUED' | 'SYNCED' | 'ERROR'
  message: string
  sizeText: string
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
      serverReceiptId: null,
      duplicate: false,
      stage: 'ANALYZING',
      message: '照片已存本机，正在识别面单条码…',
      sizeText: `${compressed.width} × ${compressed.height} · ${formatBytes(compressed.compressedBytes)}`,
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
      await updateReceiptTracking(latest.value.serverReceiptId, trackingNo)
    } else {
      await uploadQueue.updateTracking(latest.value.clientEventId, trackingNo)
    }
    latest.value.trackingNo = trackingNo
    latest.value.message = latest.value.serverReceiptId === null ? '单号已更新，将随照片一起上传' : '单号已补录并同步'
    notifySuccess()
    emit('changed')
  } catch (error) {
    captureError.value = error instanceof Error ? error.message : '补录失败，请稍后重试'
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
  latest.value.stage = 'SYNCED'
  latest.value.duplicate = Boolean(receipt.is_duplicate)
  let reconciliationMessage = ''

  if (desiredTracking && desiredTracking !== uploadedTracking) {
    try {
      const patched = await updateReceiptTracking(receipt.id, desiredTracking)
      latest.value.trackingNo = patched.tracking_no || desiredTracking
      manualTracking.value = latest.value.trackingNo
      reconciliationMessage = '照片与刚补录的单号均已同步'
    } catch (error) {
      latest.value.trackingNo = desiredTracking
      captureError.value = error instanceof Error ? `照片已同步，但单号补录失败：${error.message}` : '照片已同步，但单号补录失败'
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
      <span class="camera-icon" aria-hidden="true">▣</span>
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
