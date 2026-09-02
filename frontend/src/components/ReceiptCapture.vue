<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import ManualOrderImport from '@/components/ManualOrderImport.vue'
import type { CreateManualOrderInput, ManualOrderBatchCreateInput, ManualOrderBatchCreateResponse, ManualOrderCreateResponse, OrderMatch, Receipt, ReceiptTrackingUpdateInput, UploadQueueItem, User } from '@/types'
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
  createManualOrder: (input: CreateManualOrderInput) => Promise<ManualOrderCreateResponse>
  createManualOrderBatch: (input: ManualOrderBatchCreateInput) => Promise<ManualOrderBatchCreateResponse>
}>()

const emit = defineEmits<{
  changed: []
  serverChanged: []
  authRequired: []
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
const galleryProcessing = ref(false)
const galleryFiles = ref<GalleryPhoto[]>([])
const latest = ref<CaptureResult | null>(null)
const manualTracking = ref('')
const manualSaving = ref(false)
const captureError = ref('')

interface GalleryPhoto {
  id: string
  file: File
  previewUrl: string
  status: 'STAGED' | 'PROCESSING' | 'QUEUED' | 'SYNCED' | 'FAILED'
  message: string
  clientEventId?: string
}

function notifySuccess(): void {
  if (navigator.vibrate) navigator.vibrate([60, 40, 90])
}

function releaseLatestPreview(): void {
  if (latest.value?.previewUrl) URL.revokeObjectURL(latest.value.previewUrl)
}

async function processPhoto(
  file: File,
  inputMethod: 'PHOTO_CAPTURE' | 'PHOTO_LIBRARY' = 'PHOTO_CAPTURE',
  preparedClientEventId?: string,
): Promise<string | null> {
  processing.value = true
  captureError.value = ''
  let createdClientEventId: string | null = preparedClientEventId || null
  try {
    const compressed = await compressImage(file)
    const clientEventId = preparedClientEventId || createId()
    createdClientEventId = clientEventId
    const occurredAt = new Date().toISOString()
    const queueItem: UploadQueueItem = {
      clientEventId, ownerUserId: String(props.user.id), ownerDisplayName: props.user.display_name,
      deviceId: getDeviceId(), occurredAt, photo: compressed.blob,
      fileName: `arrival-${clientEventId}.jpg`, trackingNo: null, barcodeState: 'PROCESSING',
      uploadState: 'QUEUED', readyToUpload: false, attempts: 0, nextAttemptAt: 0,
      lastError: null, createdAt: Date.now(), updatedAt: Date.now(), inputMethod,
    }
    if (preparedClientEventId) {
      await uploadQueue.replacePreparedPhoto(clientEventId, compressed.blob, queueItem.fileName)
    } else {
      await uploadQueue.enqueue(queueItem)
    }
    const previewUrl = URL.createObjectURL(compressed.blob)
    releaseLatestPreview()
    latest.value = {
      clientEventId, previewUrl, trackingNo: '', serverTrackingNo: null,
      trackingEditEventId: null, trackingEditDesired: null, serverReceiptId: null,
      duplicate: false, stage: 'ANALYZING', message: '照片已存本机，正在识别面单条码…',
      sizeText: `${compressed.width} × ${compressed.height} · ${formatBytes(compressed.compressedBytes)}`, matches: [],
    }
    emit('changed')
    let trackingNo: string | null = null
    // Decode from the original file; the upload copy is intentionally
    // compressed for mobile storage and network transfer.
    try { trackingNo = await recognizeTrackingNo(file) } catch {
      captureError.value = '条码识别组件暂时不可用，照片仍会正常上传，可手工补录单号'
    }
    await uploadQueue.markReady(clientEventId, trackingNo)
    if (latest.value?.clientEventId === clientEventId) {
      latest.value.trackingNo = trackingNo ?? ''
      manualTracking.value = trackingNo ?? ''
      latest.value.stage = 'QUEUED'
      latest.value.message = trackingNo ? '已识别单号，请核对；照片正在自动同步' : '未识别出单号，照片仍会保存，可现在或稍后补录'
    }
    emit('changed')
    return clientEventId
  } catch (error) {
    captureError.value = error instanceof Error ? error.message : '处理照片失败，请重新拍摄'
    if (createdClientEventId) {
      try {
        await uploadQueue.markReady(createdClientEventId, null)
      } catch {
        // initialize() also recovers an interrupted PROCESSING record after reload.
      }
    }
    if (createdClientEventId && latest.value?.clientEventId === createdClientEventId) {
      latest.value.stage = 'ERROR'; latest.value.message = captureError.value
    }
    return null
  } finally { processing.value = false }
}

async function handleFile(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  target.value = ''
  if (!file || processing.value) return
  releaseLatestPreview()
  latest.value = null
  await processPhoto(file)
}

function handleGallery(event: Event): void {
  const target = event.target as HTMLInputElement
  const selected = Array.from(target.files || [])
  const remaining = Math.max(0, 30 - galleryFiles.value.length)
  const files = selected.slice(0, remaining)
  target.value = ''
  if (selected.length > remaining) captureError.value = '一次最多保留 30 张相册照片，请分批上传'
  galleryFiles.value.push(...files.map((file): GalleryPhoto => ({ id: createId(), file, previewUrl: URL.createObjectURL(file), status: 'STAGED', message: '待上传' })))
}

function removeGalleryPhoto(id: string): void {
  const item = galleryFiles.value.find((photo) => photo.id === id)
  if (!item || item.status === 'PROCESSING' || item.status === 'QUEUED') return
  URL.revokeObjectURL(item.previewUrl)
  galleryFiles.value = galleryFiles.value.filter((photo) => photo.id !== id)
}

async function uploadGallery(): Promise<void> {
  if (galleryProcessing.value) return
  galleryProcessing.value = true
  try {
    const candidates = galleryFiles.value.filter((item) => item.status === 'STAGED' || item.status === 'FAILED')

    // Persist the whole confirmed batch before compression/recognition starts.
    // If the page is interrupted, initialize() can recover every original.
    for (const item of candidates) {
      if (item.clientEventId) continue
      const clientEventId = createId()
      const now = Date.now()
      try {
        await uploadQueue.enqueue({
          clientEventId,
          ownerUserId: String(props.user.id),
          ownerDisplayName: props.user.display_name,
          deviceId: getDeviceId(),
          occurredAt: new Date().toISOString(),
          photo: item.file,
          fileName: item.file.name || `arrival-${clientEventId}`,
          trackingNo: null,
          barcodeState: 'PROCESSING',
          uploadState: 'QUEUED',
          readyToUpload: false,
          attempts: 0,
          nextAttemptAt: 0,
          lastError: null,
          createdAt: now,
          updatedAt: now,
          inputMethod: 'PHOTO_LIBRARY',
        })
        item.clientEventId = clientEventId
        item.message = '原图已保存在本机，等待处理'
      } catch (error) {
        item.status = 'FAILED'
        item.message = error instanceof Error ? error.message : '无法保存到本机，请重试'
      }
    }

    for (const item of candidates) {
      if (!item.clientEventId) continue
      if (item.status === 'FAILED') {
        try {
          await uploadQueue.retryNow(item.clientEventId)
          item.status = 'QUEUED'; item.message = '已重新加入同步队列'
        } catch (error) {
          item.message = error instanceof Error ? error.message : '重试失败，请稍后再试'
        }
        continue
      }
      item.status = 'PROCESSING'; item.message = '压缩与识别中…'
      const clientEventId = await processPhoto(item.file, 'PHOTO_LIBRARY', item.clientEventId)
      if (clientEventId) { item.status = 'QUEUED'; item.message = '已加入同步队列' }
      else { item.status = 'FAILED'; item.message = captureError.value || '处理失败，可重试' }
    }
  } finally {
    galleryProcessing.value = false
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
  const galleryItem = galleryFiles.value.find((item) => item.clientEventId === receipt.client_event_id)
  if (galleryItem) { galleryItem.status = 'SYNCED'; galleryItem.message = '已完成' }
  if (!latest.value || receipt.client_event_id !== latest.value.clientEventId) return
  void reconcileSyncedReceipt(receipt)
}

async function handleQueueChange(): Promise<void> {
  const items = await uploadQueue.itemsForCurrentUser()
  for (const galleryItem of galleryFiles.value) {
    if (galleryItem.status !== 'QUEUED') continue
    const queued = items.find((item) => item.clientEventId === galleryItem.clientEventId)
    if (queued?.uploadState === 'FAILED') { galleryItem.status = 'FAILED'; galleryItem.message = queued.lastError || '同步失败，可重试' }
  }
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

onMounted(() => {
  uploadQueue.addEventListener('synced', handleSynced)
  uploadQueue.addEventListener('change', handleQueueChange)
})
onBeforeUnmount(() => {
  uploadQueue.removeEventListener('synced', handleSynced)
  uploadQueue.removeEventListener('change', handleQueueChange)
  for (const photo of galleryFiles.value) URL.revokeObjectURL(photo.previewUrl)
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

    <label class="camera-button" :class="{ disabled: processing || galleryProcessing }">
      <input
        ref="input"
        class="visually-hidden"
        type="file"
        accept="image/*"
        capture="environment"
        :disabled="processing || galleryProcessing"
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

    <label class="gallery-button" :class="{ disabled: processing || galleryProcessing }">
      <input class="visually-hidden" type="file" accept="image/*" multiple :disabled="processing || galleryProcessing" @change="handleGallery" />
      <span class="camera-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 5h16v14H4Z" /><circle cx="9" cy="10" r="1.5" /><path d="m5 17 4-4 3 3 2-2 5 5" /></svg></span>
      <span><strong>从相册选择</strong><small>可一次选择多张，确认后逐张上传</small></span>
    </label>

    <div v-if="galleryFiles.length" class="gallery-batch">
      <div class="gallery-batch-header"><strong>已选照片（{{ galleryFiles.length }}）</strong><button type="button" :disabled="processing || galleryProcessing" @click="uploadGallery">{{ galleryProcessing ? '处理中…' : '上传全部' }}</button></div>
      <p class="gallery-batch-note">点击后会先把整批原图保存在本机，再逐张压缩上传；处理完成前请勿关闭页面。</p>
      <div class="gallery-grid">
        <div v-for="photo in galleryFiles" :key="photo.id" class="gallery-item">
          <img :src="photo.previewUrl" alt="待上传照片" />
          <span :title="photo.message">{{ photo.status === 'PROCESSING' ? '处理中' : photo.status === 'QUEUED' ? '已排队' : photo.status === 'FAILED' ? photo.message : photo.status === 'SYNCED' ? '已完成' : '待上传' }}</span>
          <button v-if="photo.status !== 'PROCESSING' && photo.status !== 'QUEUED'" type="button" aria-label="移除照片" @click="removeGalleryPhoto(photo.id)">×</button>
        </div>
      </div>
    </div>

    <p v-if="captureError" class="form-error capture-error" role="alert">{{ captureError }}</p>

    <ManualOrderImport
      :owner-user-id="String(props.user.id)"
      :create-manual-order="props.createManualOrder"
      :create-manual-order-batch="props.createManualOrderBatch"
      @imported="emit('serverChanged')"
      @auth-required="emit('authRequired')"
    />

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
