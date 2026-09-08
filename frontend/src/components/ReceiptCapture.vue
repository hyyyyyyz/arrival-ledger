<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import ManualOrderImport from '@/components/ManualOrderImport.vue'
import type { CreateManualOrderInput, ManualOrderBatchCreateInput, ManualOrderBatchCreateResponse, ManualOrderCreateResponse, OrderMatch, Receipt, ReceiptTrackingUpdateInput, UploadQueueItem, User } from '@/types'
import { ApiError } from '@/services/api'
import { copyPhoto } from '@/services/photoCopy'
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
let disposed = false

interface GalleryPhoto {
  id: string
  file: File
  previewUrl: string
  status: 'STAGED' | 'PROCESSING' | 'QUEUED' | 'SYNCED' | 'FAILED'
  message: string
  clientEventId?: string
  persisted?: boolean
}

function notifySuccess(): void {
  if (navigator.vibrate) navigator.vibrate([60, 40, 90])
}

function releaseLatestPreview(): void {
  if (latest.value?.previewUrl) URL.revokeObjectURL(latest.value.previewUrl)
}

function clearLatestCapture(clientEventId: string): void {
  if (latest.value?.clientEventId !== clientEventId) return
  releaseLatestPreview()
  latest.value = null
  manualTracking.value = ''
}

function removeSyncedGalleryPhoto(clientEventId: string): void {
  const item = galleryFiles.value.find((photo) => photo.clientEventId === clientEventId)
  if (!item || item.status !== 'SYNCED') return
  URL.revokeObjectURL(item.previewUrl)
  galleryFiles.value = galleryFiles.value.filter((photo) => photo.clientEventId !== clientEventId)
}

async function processPhoto(
  file: File,
  inputMethod: 'PHOTO_CAPTURE' | 'PHOTO_LIBRARY' = 'PHOTO_CAPTURE',
  preparedClientEventId?: string,
  capturedOwner: User = props.user,
): Promise<string | null> {
  processing.value = true
  captureError.value = ''
  const clientEventId = preparedClientEventId || createId()
  const owner = { ...capturedOwner }
  try {
    const queueItem: UploadQueueItem = {
      clientEventId, ownerUserId: String(owner.id), ownerDisplayName: owner.display_name,
      deviceId: getDeviceId(), occurredAt: new Date().toISOString(), photo: file,
      fileName: file.name || `arrival-${clientEventId}.jpg`, trackingNo: null, barcodeState: 'PROCESSING',
      uploadState: 'QUEUED', readyToUpload: false, needsPreparation: true,
      attempts: 0, nextAttemptAt: 0, lastError: null, createdAt: Date.now(), updatedAt: Date.now(), inputMethod,
    }
    await uploadQueue.enqueue(queueItem)
    if (disposed || String(props.user.id) !== String(owner.id)) return clientEventId
    releaseLatestPreview()
    manualTracking.value = ''
    latest.value = {
      clientEventId, previewUrl: URL.createObjectURL(file), trackingNo: '', serverTrackingNo: null,
      trackingEditEventId: null, trackingEditDesired: null, serverReceiptId: null,
      duplicate: false, stage: 'QUEUED', message: '已保存到本机，可以继续拍下一件；正在排队识别和上传',
      sizeText: formatBytes(file.size), matches: [],
    }
    emit('changed')
    return clientEventId
  } catch (error) {
    captureError.value = error instanceof Error ? error.message : '保存照片失败，请保留原图后重试'
    return null
  } finally { processing.value = false }
}

async function handleFile(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file || processing.value) return
  const owner = { ...props.user }
  processing.value = true
  try {
    // Do not release the picker file until its bytes have been copied.
    const copied = await copyPhoto(file)
    const savedId = await processPhoto(copied, 'PHOTO_CAPTURE', undefined, owner)
    if (savedId) target.value = ''
  } catch (error) {
    captureError.value = error instanceof Error ? error.message : '无法读取照片，请重新选择'
  } finally { processing.value = false }
}

async function handleGallery(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const selected = Array.from(target.files || [])
  const remaining = Math.max(0, 30 - galleryFiles.value.length)
  const files = selected.slice(0, remaining)
  if (selected.length > remaining) captureError.value = '一次最多保留 30 张相册照片，请分批上传'
  galleryProcessing.value = true
  try {
    for (const file of files) {
      const copied = await copyPhoto(file)
      galleryFiles.value.push({ id: createId(), file: copied, previewUrl: URL.createObjectURL(copied), status: 'STAGED', message: '待上传' })
    }
    target.value = ''
  } catch (error) {
    captureError.value = error instanceof Error ? error.message : '部分照片未读取成功，请重新选择'
  } finally { galleryProcessing.value = false }
}

function removeGalleryPhoto(id: string): void {
  const item = galleryFiles.value.find((photo) => photo.id === id)
  if (!item || item.status === 'PROCESSING' || item.status === 'QUEUED') return
  URL.revokeObjectURL(item.previewUrl)
  galleryFiles.value = galleryFiles.value.filter((photo) => photo.id !== id)
}

async function uploadGallery(): Promise<void> {
  if (galleryProcessing.value) return
  const owner = { ...props.user }
  galleryProcessing.value = true
  try {
    const candidates = galleryFiles.value.filter((item) => item.status === 'STAGED' || item.status === 'FAILED')
    for (const item of candidates) {
      if (item.clientEventId && item.persisted && item.status === 'FAILED') {
        try {
          await uploadQueue.retryNow(item.clientEventId)
          item.status = 'QUEUED'; item.message = '已重新加入同步队列'
        } catch (error) { item.message = error instanceof Error ? error.message : '重试失败，请稍后再试' }
        continue
      }
      item.clientEventId ||= createId()
      item.status = 'PROCESSING'
      const id = await processPhoto(item.file, 'PHOTO_LIBRARY', item.clientEventId, owner)
      if (!id) {
        // Keep the event ID if persistence timed out after a possible commit.
        item.status = 'FAILED'; item.message = captureError.value || '保存失败，可重试'
      } else if (item.status !== 'SYNCED' as GalleryPhoto['status']) {
        item.persisted = true
        item.status = 'QUEUED'; item.message = '已保存本机，可以继续拍摄'
      }
    }
  } finally { galleryProcessing.value = false }
}

async function saveManualTracking(): Promise<void> {
  if (!latest.value || manualSaving.value) return
  const capture = latest.value
  const trackingNo = normalizeTrackingNo(manualTracking.value)
  if (!isPlausibleTrackingNo(trackingNo)) {
    captureError.value = '请检查单号，通常应为 8–32 位且至少包含一个数字'
    return
  }

  manualSaving.value = true
  captureError.value = ''
  try {
    if (capture.serverReceiptId !== null) {
      if (!capture.trackingEditEventId || capture.trackingEditDesired !== trackingNo) {
        capture.trackingEditEventId = createId()
        capture.trackingEditDesired = trackingNo
      }
      const patched = await props.saveServerTracking({
        receiptId: capture.serverReceiptId,
        trackingNo,
        expectedTrackingNo: capture.serverTrackingNo,
        clientEventId: capture.trackingEditEventId,
      })
      capture.matches = patched.order_matches || []
      capture.serverTrackingNo = patched.tracking_no ?? null
      capture.trackingEditEventId = null
      capture.trackingEditDesired = null
      emit('serverChanged')
    } else {
      await uploadQueue.updateTracking(capture.clientEventId, trackingNo)
    }
    capture.trackingNo = trackingNo
    capture.message = capture.serverReceiptId === null ? '单号已更新，将随照片一起上传' : '单号已补录并同步'
    notifySuccess()
    emit('changed')
  } catch (error) {
    if (latest.value?.clientEventId !== capture.clientEventId) return
    if (error instanceof ApiError && error.status === 409) {
      const details = error.details && typeof error.details === 'object'
        ? error.details as Record<string, unknown>
        : null
      if (details && (typeof details.current_tracking_no === 'string' || details.current_tracking_no === null)) {
        capture.serverTrackingNo = details.current_tracking_no as string | null
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
  if (galleryItem) {
    galleryItem.status = 'SYNCED'
    galleryItem.message = '已完成'
    // A successfully uploaded gallery item no longer belongs in the selected
    // batch. Revoke its object URL so repeated batches do not retain images.
    removeSyncedGalleryPhoto(receipt.client_event_id || '')
  }
  if (!latest.value || receipt.client_event_id !== latest.value.clientEventId) return
  void reconcileSyncedReceipt(receipt)
}

async function handleQueueChange(): Promise<void> {
  if (!galleryFiles.value.some((item) => item.status === 'QUEUED')) return
  try {
    const items = await uploadQueue.itemsForCurrentUser()
    for (const galleryItem of galleryFiles.value) {
      if (galleryItem.status !== 'QUEUED') continue
      const queued = items.find((item) => item.clientEventId === galleryItem.clientEventId)
      if (queued?.uploadState === 'FAILED') { galleryItem.status = 'FAILED'; galleryItem.message = queued.lastError || '同步失败，可重试' }
    }
  } catch { /* App reports storage errors; keep all selected/local photos intact. */ }
}

async function reconcileSyncedReceipt(receipt: Receipt): Promise<void> {
  if (!latest.value || receipt.client_event_id !== latest.value.clientEventId) return
  const capture = latest.value
  const desiredTracking = normalizeTrackingNo(manualTracking.value || capture.trackingNo)
  const uploadedTracking = normalizeTrackingNo(receipt.tracking_no || '')

  capture.serverReceiptId = receipt.id
  capture.serverTrackingNo = receipt.tracking_no ?? null
  capture.stage = 'SYNCED'
  capture.duplicate = Boolean(receipt.is_duplicate)
  capture.matches = receipt.order_matches || []
  let reconciliationMessage = ''

  if (desiredTracking && desiredTracking !== uploadedTracking) {
    try {
      if (!capture.trackingEditEventId || capture.trackingEditDesired !== desiredTracking) {
        capture.trackingEditEventId = createId()
        capture.trackingEditDesired = desiredTracking
      }
      const patched = await props.saveServerTracking({
        receiptId: receipt.id,
        trackingNo: desiredTracking,
        expectedTrackingNo: receipt.tracking_no ?? null,
        clientEventId: capture.trackingEditEventId,
      })
      capture.trackingNo = patched.tracking_no || desiredTracking
      capture.serverTrackingNo = patched.tracking_no ?? null
      capture.trackingEditEventId = null
      capture.trackingEditDesired = null
      capture.matches = patched.order_matches || []
      if (latest.value?.clientEventId === capture.clientEventId && normalizeTrackingNo(manualTracking.value) === desiredTracking) manualTracking.value = capture.trackingNo
      reconciliationMessage = '照片与刚补录的单号均已同步'
      emit('serverChanged')
    } catch (error) {
      if (latest.value?.clientEventId !== capture.clientEventId) return
      capture.trackingNo = desiredTracking
      if (error instanceof ApiError && error.status === 0) {
        captureError.value = '照片已同步，但单号修改结果尚未确认；请重试，系统不会重复记录。'
      } else if (error instanceof ApiError && error.status === 409) {
        const details = error.details && typeof error.details === 'object'
          ? error.details as Record<string, unknown>
          : null
        if (details && (typeof details.current_tracking_no === 'string' || details.current_tracking_no === null)) {
          capture.serverTrackingNo = details.current_tracking_no as string | null
        }
        captureError.value = '照片已同步，但单号已被其他人修改；请核对记录列表后再次保存。'
      } else {
        captureError.value = error instanceof Error ? `照片已同步，但单号补录失败：${error.message}` : '照片已同步，但单号补录失败'
      }
      reconciliationMessage = '照片已保存；请再次点击补录，确保单号同步'
    }
  } else if (receipt.tracking_no) {
    capture.trackingNo = receipt.tracking_no
    manualTracking.value = receipt.tracking_no
  }

  capture.message = reconciliationMessage || (receipt.is_duplicate
      ? '这个单号以前已确认过，请核对首次记录'
      : capture.trackingNo
        ? '已同步到服务器，收货凭证保存成功'
        : '照片已同步，单号仍待补录')
  notifySuccess()
  emit('changed')

  // Once the server has both accepted the photo and matched its tracking
  // number, clear the capture panel. The server receipt list and dashboard
  // have already been refreshed by App.vue's synced handler.
  if (receipt.tracking_no && (receipt.order_matches?.length || 0) > 0) {
    clearLatestCapture(receipt.client_event_id || '')
  }
}

onMounted(() => {
  uploadQueue.addEventListener('synced', handleSynced)
  uploadQueue.addEventListener('change', handleQueueChange)
})
onBeforeUnmount(() => {
  disposed = true
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
        <strong>{{ processing ? '正在保存照片…' : '拍摄包裹面单' }}</strong>
        <small>{{ processing ? '保存到本机后即可继续拍' : '拍完可继续拍，照片自动排队上传' }}</small>
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
      <p class="gallery-batch-note">照片保存到本机后即可继续拍摄。上传期间保持本页面打开；锁屏或切到后台可能暂停，返回后会继续。</p>
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
